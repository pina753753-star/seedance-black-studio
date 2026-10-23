'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../api/_lib/reference-dance.js');
const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
const root = path.join(__dirname, '..');
function fixture({ status = 'ready', beforeClaim, afterClaim, activeCount = 0, storageError = false, taskId = null, createdAt = '2026-10-23T00:00:00.000Z', historicalRows = 0 } = {}) {
  const state = { row: { id: ASSET, user_id: USER, status, created_at: createdAt, staging_path: lib.stagingPath(USER, ASSET), approved_path: lib.approvedPath(USER, ASSET), review_paths: [], last_task_id: taskId, updated_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z' }, removed: [], claims: 0 };
  const db = {
    storage: { from() { return { async remove(paths) { state.removed.push(...paths); return { error: storageError ? { message: 'mock storage failure' } : null }; } }; } },
    from(table) {
      let operation = 'select', values, countOnly = false, single = false, maxRows = Infinity, orderKey;
      const predicates = [];
      const q = {
        select(_cols, options) { countOnly = options?.count === 'exact'; return q; },
        update(v) { operation = 'update'; values = v; return q; },
        delete() { operation = 'delete'; return q; },
        eq(k,v) { predicates.push(r => r[k] === v); return q; },
        is(k,v) { predicates.push(r => r[k] === v); return q; },
        gte(k,v) { predicates.push(r => r[k] >= v); return q; },
        lte(k,v) { predicates.push(r => r[k] <= v); return q; },
        in() { return q; }, contains() { return q; }, order(k) { orderKey = k; return q; }, limit(n) { maxRows = n; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          try {
            if (table === 'profiles') return Promise.resolve({ data: { id: USER, email: 'hinaran53@gmail.com', role: 'admin' } }).then(resolve, reject);
            if (table === 'generation_tasks') return Promise.resolve({ count: activeCount }).then(resolve, reject);
            if (operation === 'update') { state.claims++; if (beforeClaim) beforeClaim(state); }
            const matches = state.row && predicates.every(fn => fn(state.row));
            let result;
            if (operation === 'update') {
              if (matches) { Object.assign(state.row, values); if (afterClaim) afterClaim(state); }
              result = { data: matches ? [{ id: ASSET }] : [] };
            } else if (operation === 'delete') {
              if (matches) state.row = null;
              result = { error: null };
            } else {
              const candidates = state.row ? [state.row, ...Array.from({ length: historicalRows }, (_, i) => ({ ...state.row, id: 'historical-' + i, created_at: '2026-10-22T23:59:59.999Z', expires_at: '2025-01-01T00:00:00.000Z' }))] : [];
              const selected = candidates.filter(r => predicates.every(fn => fn(r)));
              if (orderKey) selected.sort((a,b) => a[orderKey].localeCompare(b[orderKey]));
              result = { data: single ? (matches ? { ...state.row } : null) : selected.slice(0, maxRows).map(r => ({ ...r })) };
            }
            return Promise.resolve(result).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
      };
      return q;
    }
  };
  return { state, db };
}
async function run(kind, fixture) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'api/reference-dance-' + kind + '.js'), 'utf8'), {
    module, console: { error() {} }, Date,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'mock-service-key', CRON_SECRET: 'mock-cron' } },
    require(name) {
      if (name === '@supabase/supabase-js') return { createClient: () => fixture.db };
      if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER, email: 'hinaran53@gmail.com' }, supabase: fixture.db }) };
      if (name.includes('reference-dance')) return lib;
      throw new Error('Unexpected import');
    }
  });
  const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
  await module.exports({ method: kind === 'delete' ? 'POST' : 'GET', body: { assetId: ASSET }, headers: { authorization: 'Bearer mock-cron' } }, res);
  return res;
}
test('delete loses to inspection claim and does not remove storage', async () => {
  const f = fixture({ status: 'uploading', beforeClaim: s => { s.row.status = 'checking'; } });
  const res = await run('delete', f);
  assert.equal(res.body.retained, true); assert.equal(f.state.row.status, 'checking'); assert.equal(f.state.removed.length, 0);
});
test('delete loses to generation binding even when status remains ready', async () => {
  const f = fixture({ beforeClaim: s => { s.row.last_task_id = 'new-task'; } });
  const res = await run('delete', f);
  assert.equal(res.body.retained, true); assert.equal(f.state.removed.length, 0);
});
test('delete tombstone wins: concurrent status-guarded claim and bind cannot proceed', async () => {
  let eligible;
  const f = fixture({ afterClaim: s => { eligible = s.row.status === 'ready' || s.row.status === 'uploading'; } });
  const res = await run('delete', f);
  assert.equal(eligible, false); assert.equal(res.body.deleted, true); assert.equal(f.state.row, null); assert.equal(f.state.removed.length, 7);
});
test('failed storage deletion leaves a noneligible tombstone for cleanup retry', async () => {
  const f = fixture({ storageError: true });
  const res = await run('delete', f);
  assert.equal(res.code, 503); assert.equal(f.state.row.status, 'failed'); assert.equal(f.state.row.last_task_id, null);
});
test('cleanup loses to lease renewal after expired-row selection', async () => {
  const f = fixture({ beforeClaim: s => { s.row.expires_at = '2099-01-01T00:00:00.000Z'; s.row.updated_at = new Date().toISOString(); } });
  const res = await run('cleanup', f);
  assert.equal(res.body.deleted, 0); assert.equal(f.state.removed.length, 0); assert.equal(f.state.row.status, 'ready');
});
test('cleanup loses to binding after active task count was read', async () => {
  const f = fixture({ beforeClaim: s => { s.row.last_task_id = 'new-task'; s.row.updated_at = new Date().toISOString(); } });
  const res = await run('cleanup', f);
  assert.equal(res.body.deleted, 0); assert.equal(f.state.removed.length, 0);
});
test('cleanup retains assets referenced by any nonterminal task', async () => {
  const f = fixture({ activeCount: 1, taskId: 'newest-terminal-task' });
  const res = await run('cleanup', f);
  assert.equal(res.body.deleted, 0); assert.equal(f.state.claims, 0); assert.equal(f.state.removed.length, 0);
});
test('cleanup tombstone wins before bind and removes expired object only', async () => {
  let bindingEligible;
  const f = fixture({ afterClaim: s => { bindingEligible = s.row.status === 'ready'; } });
  const res = await run('cleanup', f);
  assert.equal(bindingEligible, false); assert.equal(res.body.deleted, 1); assert.equal(f.state.row, null); assert.equal(f.state.removed.length, 7);
});


test('cleanup preserves expired assets created before the release cutoff', async () => {
  const f = fixture({ createdAt: '2026-10-22T23:59:59.999Z' });
  const res = await run('cleanup', f);
  assert.equal(res.body.checked, 0);
  assert.equal(res.body.deleted, 0);
  assert.equal(f.state.claims, 0);
  assert.equal(f.state.removed.length, 0);
  assert.equal(f.state.row.status, 'ready');
});

test('cleanup includes assets created exactly at cutoff despite a full historical backlog', async () => {
  const f = fixture({ historicalRows: 100 });
  const res = await run('cleanup', f);
  assert.equal(res.body.checked, 1);
  assert.equal(res.body.deleted, 1);
  assert.equal(f.state.row, null);
  assert.equal(f.state.removed.length, 7);
});

test('cleanup deletes eligible post-cutoff expired assets normally', async () => {
  const f = fixture({ createdAt: '2026-10-23T01:00:00.000Z' });
  const res = await run('cleanup', f);
  assert.equal(res.body.deleted, 1);
  assert.equal(f.state.row, null);
});

test('preserving historical expired storage does not restore generation access', () => {
  const f = fixture({ createdAt: '2026-10-22T23:59:59.999Z' });
  assert.throws(() => lib.validateReadyReferenceDance(f.state.row, USER), error => error.code === 'reference_video_expired');
});
