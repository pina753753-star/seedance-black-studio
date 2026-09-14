'use strict';

// H3 Max Live additional-prompt command ledger. All API calls use in-memory
// dependency injection; no Supabase, fal.ai, credits, or paid generation are
// touched by this test file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const migrationPath = path.join(
  repoRoot,
  'supabase/migrations/20260914143000_h3_director_prompt_commands.sql'
);
const pagePath = path.join(repoRoot, 'h3-director.html');
const migration = fs.readFileSync(migrationPath, 'utf8');
const page = fs.readFileSync(pagePath, 'utf8');

const confirmedAuthPath = path.join(repoRoot, 'api/_lib/confirmed-auth.js');
const storePath = path.join(repoRoot, 'api/_lib/h3-director-store.js');
const recordPath = path.join(repoRoot, 'api/h3-director/record-prompt-event.js');
const historyPath = path.join(repoRoot, 'api/h3-director/prompt-history.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';

function responseRecorder() {
  return {
    statusCode: 0,
    payload: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function fakeModule(modulePath, exports) {
  return { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadWithMocks(targetPath, db) {
  const previous = {
    auth: require.cache[confirmedAuthPath],
    store: require.cache[storePath],
    target: require.cache[targetPath]
  };
  require.cache[confirmedAuthPath] = fakeModule(confirmedAuthPath, {
    requireConfirmedAuth: async () => ({ ok: true, user: { id: USER_ID }, supabase: db })
  });
  require.cache[storePath] = fakeModule(storePath, {
    jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
    isUuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))
  });
  delete require.cache[targetPath];
  const handler = require(targetPath);
  return {
    handler,
    restore() {
      if (previous.auth) require.cache[confirmedAuthPath] = previous.auth; else delete require.cache[confirmedAuthPath];
      if (previous.store) require.cache[storePath] = previous.store; else delete require.cache[storePath];
      if (previous.target) require.cache[targetPath] = previous.target; else delete require.cache[targetPath];
    }
  };
}

test('migration adds isolated command and append-only event tables', () => {
  assert.match(migration, /create table public\.h3_director_prompt_commands/);
  assert.match(migration, /create table public\.h3_director_prompt_command_events/);
  assert.match(migration, /unique \(session_id, prompt_version\)/);
  assert.match(migration, /unique \(command_id, event_type\)/);
  assert.doesNotMatch(migration, /h3_director_prompt_commands_session_version_idx/);
  assert.doesNotMatch(migration, /alter table public\.h3_director_sessions\s+(add|drop|alter)/i);
});

test('migration keeps both tables service-role-only with RLS enabled', () => {
  for (const table of ['h3_director_prompt_commands', 'h3_director_prompt_command_events']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.doesNotMatch(migration, /grant .* on table public\.h3_director_prompt_command(?:s|_events) to (anon|authenticated)/i);
  assert.match(migration, /grant usage, select on sequence public\.h3_director_prompt_command_events_id_seq[\s\S]*?to service_role/);
  assert.doesNotMatch(migration, /grant [^;]*delete[^;]*h3_director_prompt_commands/i);
});

test('approval RPC locks the session and atomically writes version plus checked event', () => {
  const fn = migration.slice(
    migration.indexOf('create or replace function public.approve_h3_director_prompt_atomic'),
    migration.indexOf('revoke all on function public.approve_h3_director_prompt_atomic')
  );
  assert.match(fn, /from public\.h3_director_sessions[\s\S]*?for update/);
  assert.match(fn, /update public\.h3_director_sessions[\s\S]*?set prompt_version = v_next_version/);
  assert.match(fn, /insert into public\.h3_director_prompt_commands/);
  assert.match(fn, /insert into public\.h3_director_prompt_command_events/);
  assert.match(fn, /where h3_director_prompt_commands\.command_id = p_command_id[\s\S]*?'approved'::text, true/);
});

test('approval RPC rechecks command_id after the session lock for concurrent retries', () => {
  const fn = migration.slice(
    migration.indexOf('create or replace function public.approve_h3_director_prompt_atomic'),
    migration.indexOf('revoke all on function public.approve_h3_director_prompt_atomic')
  );
  const sessionLock = fn.indexOf('from public.h3_director_sessions');
  const commandLookups = [...fn.matchAll(/from public\.h3_director_prompt_commands/g)]
    .map((match) => match.index);
  const commandInsert = fn.indexOf('insert into public.h3_director_prompt_commands');

  assert.equal(commandLookups.length, 2);
  assert.ok(commandLookups[0] < sessionLock);
  assert.ok(sessionLock < commandLookups[1]);
  assert.ok(commandLookups[1] < commandInsert);
  assert.match(fn.slice(commandLookups[1], commandInsert), /'approved'::text, true/);
  assert.match(fn.slice(commandLookups[1], commandInsert), /'command_id_conflict'::text, false/);
});

test('event RPC has bounded transitions and never changes billing tables', () => {
  const fn = migration.slice(
    migration.indexOf('create or replace function public.record_h3_director_prompt_event_atomic'),
    migration.indexOf('revoke all on function public.record_h3_director_prompt_event_atomic')
  );
  assert.match(fn, /when 'visible' then v_command\.current_status in \('checked', 'sent', 'accepted', 'used_for_generation', 'unknown'\)/);
  assert.match(fn, /return query select 'invalid_transition'::text/);
  assert.match(fn, /return query select 'already_recorded'::text/);
  assert.doesNotMatch(fn, /credit_balances|credit_transactions|deduct|refund/i);
});

test('browser creates commandId and records only provider-supported facts', () => {
  assert.match(page, /var commandId=uuid\(\);/);
  assert.match(page, /commandId:commandId,[\s\S]*?prompt:prompt/);
  assert.match(page, /recordPromptEvent\(approved\.promptVersion,'sent','data_channel_send'\)/);
  assert.match(page, /recordPromptEvent\(msg\.prompt_version,'accepted','prompt_pending'\)/);
  assert.match(page, /recordPromptEvent\(msg\.prompt_version,'accepted','prompt_applied'\)/);
  assert.match(page, /recordPromptEvent\(msg\.prompt_version,'used_for_generation','chunk'\)/);
  assert.match(page, /msg\.reason==='stale_prompt_version'\?'superseded':'rejected'/);
  assert.doesNotMatch(page, /recordPromptEvent\([^\n]*,'visible'/);
  assert.match(page, /command\.eventQueue=\(command\.eventQueue\|\|Promise\.resolve\(\)\)\.then/);
  assert.match(page, /eventQueue:Promise\.resolve\(\)/);
});

test('record-prompt-event passes authenticated ownership fields to one atomic RPC', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [{ code: 'recorded', current_status: 'sent' }], error: null };
    }
  };
  const loaded = loadWithMocks(recordPath, db);
  try {
    const req = {
      method: 'POST',
      body: JSON.stringify({
        sessionId: SESSION_ID,
        commandId: COMMAND_ID,
        promptVersion: 2,
        eventType: 'sent',
        reason: 'data_channel_send'
      })
    };
    const res = responseRecorder();
    await loaded.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.currentStatus, 'sent');
    assert.deepEqual(calls, [{
      name: 'record_h3_director_prompt_event_atomic',
      args: {
        p_session_id: SESSION_ID,
        p_user_id: USER_ID,
        p_command_id: COMMAND_ID,
        p_prompt_version: 2,
        p_event_type: 'sent',
        p_reason: 'data_channel_send'
      }
    }]);
  } finally {
    loaded.restore();
  }
});

test('record-prompt-event rejects malformed input before any RPC', async () => {
  let rpcCalls = 0;
  const loaded = loadWithMocks(recordPath, { async rpc() { rpcCalls++; } });
  try {
    const req = {
      method: 'POST',
      body: JSON.stringify({
        sessionId: SESSION_ID,
        commandId: COMMAND_ID,
        promptVersion: 1,
        eventType: 'invented_visible_state'
      })
    };
    const res = responseRecorder();
    await loaded.handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(rpcCalls, 0);
  } finally {
    loaded.restore();
  }
});

test('prompt-history filters commands by both session and authenticated user', async () => {
  const filters = [];
  const commandRows = [{
    command_id: COMMAND_ID,
    session_id: SESSION_ID,
    prompt_version: 2,
    original_prompt: 'run faster',
    current_status: 'used_for_generation',
    checked_at: '2026-09-14T00:00:00Z',
    created_at: '2026-09-14T00:00:00Z',
    updated_at: '2026-09-14T00:00:01Z'
  }];
  function query(table) {
    const q = {
      select() { return q; },
      eq(column, value) { filters.push([table, column, value]); return q; },
      in(column, value) { filters.push([table, column, value]); return q; },
      order() { return q; },
      limit() { return q; },
      then(resolve, reject) {
        const data = table === 'h3_director_prompt_commands'
          ? commandRows
          : [{ command_id: COMMAND_ID, event_type: 'checked', reason: null, created_at: '2026-09-14T00:00:00Z' }];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    };
    return q;
  }
  const loaded = loadWithMocks(historyPath, { from: query });
  try {
    const res = responseRecorder();
    await loaded.handler({ method: 'GET', query: { sessionId: SESSION_ID, limit: '20' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(filters.slice(0, 2), [
      ['h3_director_prompt_commands', 'session_id', SESSION_ID],
      ['h3_director_prompt_commands', 'user_id', USER_ID]
    ]);
    assert.equal(res.payload.commands[0].status, 'used_for_generation');
    assert.equal(res.payload.commands[0].events[0].type, 'checked');
  } finally {
    loaded.restore();
  }
});
