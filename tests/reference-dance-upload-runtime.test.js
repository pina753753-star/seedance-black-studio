'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const lib = require('../api/_lib/reference-dance.js');
const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const row = (overrides = {}) => ({ id: ASSET, user_id: USER, status: 'uploading', staging_path: lib.stagingPath(USER, ASSET), last_task_id: null, original_filename: 'dance.mp4', expires_at: new Date(Date.now() + 3600000).toISOString(), created_at: new Date().toISOString(), duration_ms: 5000, billable_seconds: 5, ...overrides });
function dbFor(rows, rpc) {
  const calls = [];
  return {
    calls,
    storage: { from(bucket) { calls.push(['storage', bucket]); return {
      async createSignedUrl(p) { return { data: { signedUrl: 'https://mock.invalid/' + p } }; },
      async createSignedUploadUrl(p) { return { data: { token: 'mock-path-scoped-token', path: p } }; }
    }; } },
    async rpc(...args) { calls.push(['rpc', ...args]); return rpc(); },
    from(table) {
      let found = table === 'profiles' ? [{ id: USER, email: 'hinaran53@gmail.com', role: 'admin' }] : rows.slice();
      const q = {
        select() { return q; },
        eq(k,v) { found = found.filter(r => r[k] === v); return q; },
        in(k,v) { found = found.filter(r => v.includes(r[k])); return q; },
        is(k,v) { found = found.filter(r => r[k] === v); return q; },
        gt(k,v) { found = found.filter(r => r[k] > v); return q; },
        order(k) { found.sort((a,b) => String(b[k]).localeCompare(String(a[k]))); return q; },
        limit(n) { found = found.slice(0,n); return q; },
        async maybeSingle() { return { data: found[0] ? { ...found[0] } : null }; }
      };
      return q;
    }
  };
}
function load(file, db, env = {}, user = {}) {
  const module = { exports: {} };
  vm.runInNewContext(read(file), {
    module, process: { env }, Buffer, console, Date, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER, email: 'hinaran53@gmail.com', ...user }, supabase: db }) };
      if (name.includes('openai-moderation')) return { moderateContent() { throw new Error('Unexpected moderation call'); } };
      if (name.includes('reference-dance')) return lib;
      throw new Error('Unexpected import ' + name);
    },
    fetch() { throw new Error('Network forbidden in runtime tests'); }
  }, { filename: file });
  return module.exports;
}
async function invoke(handler, method = 'POST') {
  const res = { setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, body: { assetId: ASSET } }, res);
  return res;
}
const confirmFile = 'api/reference-dance-confirm-upload.js';
test('capabilities use bundled public configuration with no override, matching browser config', async () => {
  const db = dbFor([]);
  const data = await load(confirmFile, db)._test.createStorageCapabilities(db, USER, ASSET, lib.stagingPath(USER, ASSET));
  assert.equal(data.publishableKey, read('auth-config.js').match(/supabaseAnonKey:\s*"([^"]+)"/)[1]);
  assert.equal(data.supabaseUrl, read('auth-config.js').match(/supabaseUrl:\s*"([^"]+)"/)[1]);
  assert.equal(data.reviewUploads.length, 5);
});
test('public-key override precedence is preserved', async () => {
  const names = ['SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'];
  for (let i = 0; i < names.length; i++) {
    const env = Object.fromEntries(names.slice(i).map((k,j) => [k, 'sb_publishable_test' + j]));
    const db = dbFor([]);
    const data = await load(confirmFile, db, env)._test.createStorageCapabilities(db, USER, ASSET, 'path');
    assert.equal(data.publishableKey, env[names[i]]);
  }
});
test('different project without public key fails before storage; explicit public key works', async () => {
  const db = dbFor([]), env = { SUPABASE_URL: 'https://other.supabase.co' };
  await assert.rejects(load(confirmFile, db, env)._test.createStorageCapabilities(db, USER, ASSET, 'path'), /STORAGE_CAPABILITY_NOT_CONFIGURED/);
  assert.equal(db.calls.length, 0);
  const data = await load(confirmFile, db, { ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_other' })._test.createStorageCapabilities(db, USER, ASSET, 'path');
  assert.equal(data.supabaseUrl, env.SUPABASE_URL);
});
test('secret-shaped and service-role keys cannot be forwarded; legacy anon JWT is accepted', async () => {
  const jwt = role => 'header.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature';
  for (const key of ['sb_secret_test', jwt('service_role')]) {
    const db = dbFor([]);
    await assert.rejects(load(confirmFile, db, { SUPABASE_ANON_KEY: key })._test.createStorageCapabilities(db, USER, ASSET, 'path'), /STORAGE_CAPABILITY_NOT_CONFIGURED/);
    assert.equal(db.calls.length, 0);
  }
  const db = dbFor([]);
  const data = await load(confirmFile, db, { SUPABASE_ANON_KEY: jwt('anon') })._test.createStorageCapabilities(db, USER, ASSET, 'path');
  assert.equal(data.publishableKey, jwt('anon'));
});
test('busy confirmation retains retry affordance without starting inspector', async () => {
  const db = dbFor([row()], () => ({ data: { ok: false, code: 'busy' } }));
  const res = await invoke(load(confirmFile, db));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.retryable, true);
  assert.equal(db.calls.some(c => c[0] === 'storage'), false);
});
test('ready RPC race returns the same complete metadata as already-ready response', async () => {
  const rows = [row()];
  const db = dbFor(rows, () => { rows[0].status = 'ready'; return { data: { ok: true, code: 'ready' } }; });
  const raced = await invoke(load(confirmFile, db));
  const direct = await invoke(load(confirmFile, db));
  assert.equal(raced.statusCode, 200);
  assert.equal(JSON.stringify(raced.body), JSON.stringify(direct.body));
  assert.equal(raced.body.billableSeconds, 5);
  assert.equal(raced.body.sampleCredits, 205);
});
test('latest restores unused ready metadata but never used, expired, or foreign rows', async () => {
  const file = 'api/reference-dance-latest.js';
  for (const excluded of [row({ last_task_id: 'existing-task' }), row({ expires_at: '2000-01-01T00:00:00Z' }), row({ user_id: 'someone-else' })]) {
    const res = await invoke(load(file, dbFor([excluded])), 'GET');
    assert.equal(res.body.asset, null);
  }
  const res = await invoke(load(file, dbFor([row({ status: 'ready' })])), 'GET');
  assert.equal(res.body.asset.status, 'ready');
  assert.equal(res.body.asset.billableSeconds, 5);
  assert.equal(res.body.asset.durationMs, 5000);
});
test('ordinary accounts remain forbidden at both endpoints', async () => {
  for (const file of [confirmFile, 'api/reference-dance-latest.js']) {
    const res = await invoke(load(file, dbFor([row()]), {}, { email: 'ordinary@example.com' }), file.includes('latest') ? 'GET' : 'POST');
    assert.equal(res.statusCode, 403);
  }
});
function browserContext(asset, response) {
  const html = read('generate-prod.html');
  const confirm = html.slice(html.indexOf('async function confirmReferenceDanceAsset(){'), html.indexOf('async function uploadReferenceDance(file){'));
  const restore = html.slice(html.indexOf('async function restoreLatestReferenceDance(){'), html.indexOf('async function loadReferenceDanceAccess(){'));
  const requests = [], rights = {};
  const ctx = { referenceDanceAsset: asset, referenceDanceAccess: true, generationRequestInFlight: false, syncReferenceDanceUi() {}, updateCreditUi() {}, getToken: async () => 'mock', $: () => rights, fetch: async (url) => { requests.push(url); return response; } };
  vm.createContext(ctx); vm.runInContext(confirm + restore, ctx);
  return { ctx, requests, rights };
}
test('frontend treats legacy busy response as retryable and manual retry can finish', async () => {
  const { ctx, requests } = browserContext({ id: ASSET }, { ok: false, json: async () => ({ error: 'reference_video_checking' }) });
  assert.equal(await ctx.confirmReferenceDanceAsset(), false);
  assert.equal(ctx.referenceDanceAsset.retryable, true);
  assert.equal(requests.length, 1);
  ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, status: 'ready', durationMs: 5000, billableSeconds: 5 }) });
  assert.equal(await ctx.confirmReferenceDanceAsset(), true);
  assert.equal(ctx.referenceDanceAsset.billableSeconds, 5);
});
test('reload restores ready or pending assets without automatic reinspection or generation', async () => {
  for (const status of ['ready', 'checking', 'uploading']) {
    const { ctx, requests, rights } = browserContext(null, { ok: true, json: async () => ({ asset: { id: ASSET, status, durationMs: 5000, billableSeconds: 5 } }) });
    await ctx.restoreLatestReferenceDance();
    assert.deepEqual(requests, ['/api/reference-dance-latest']);
    assert.equal(ctx.referenceDanceAsset.status, status === 'ready' ? 'ready' : 'failed');
    assert.equal(ctx.referenceDanceAsset.retryable, status !== 'ready');
    assert.equal(rights.checked, true);
  }
});
test('late restore response does not overwrite a new local upload', async () => {
  const { ctx } = browserContext(null, { ok: true, json: async () => {
    ctx.referenceDanceAsset = { id: 'new-local-upload', status: 'uploading' };
    return { asset: { id: ASSET, status: 'ready', billableSeconds: 5 } };
  } });
  await ctx.restoreLatestReferenceDance();
  assert.equal(ctx.referenceDanceAsset.id, 'new-local-upload');
});
