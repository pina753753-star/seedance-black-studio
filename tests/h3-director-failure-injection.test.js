'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const startModule = require('../api/h3-director/start-session.js');
const { listStuck, releaseSession } = require('../api/_lib/h3-director-reconcile.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDEM_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function makeDb() {
  const state = {
    session: null,
    balance: 1000,
    chargeWrites: 0,
    refundWrites: 0,
    failRefundOnce: false
  };

  function matches(filters) {
    const row = state.session;
    if (!row) return false;
    return filters.every((f) => {
      if (f.op === 'eq') return row[f.column] === f.value;
      if (f.op === 'in') return f.value.includes(row[f.column]);
      if (f.op === 'is') return row[f.column] == null;
      if (f.op === 'not-is') return row[f.column] != null;
      if (f.op === 'lt') return Date.parse(String(row[f.column] || '')) < Date.parse(f.value);
      return true;
    });
  }

  function query() {
    const filters = [];
    let update = null;
    let wantsRows = false;
    const q = {
      select() { wantsRows = true; return q; },
      update(value) { update = value; return q; },
      eq(column, value) { filters.push({ op: 'eq', column, value }); return q; },
      in(column, value) { filters.push({ op: 'in', column, value }); return q; },
      is(column) { filters.push({ op: 'is', column }); return q; },
      not(column, operator) { if (operator === 'is') filters.push({ op: 'not-is', column }); return q; },
      lt(column, value) { filters.push({ op: 'lt', column, value }); return q; },
      order() { return q; },
      limit() { return q; },
      async maybeSingle() {
        if (!matches(filters)) return { data: null, error: null };
        if (update) Object.assign(state.session, update);
        return { data: { ...state.session }, error: null };
      },
      then(resolve, reject) {
        try {
          const matched = matches(filters);
          if (matched && update) Object.assign(state.session, update);
          return Promise.resolve({ data: matched && wantsRows ? [{ ...state.session }] : null, error: null }).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      }
    };
    return q;
  }

  const db = {
    state,
    from(table) {
      assert.equal(table, 'h3_director_sessions');
      return query();
    },
    async rpc(name, args) {
      if (name === 'reserve_h3_director_session_atomic') {
        if (!state.session) {
          const now = new Date().toISOString();
          state.session = {
            id: SESSION_ID,
            user_id: args.p_user_id,
            idempotency_key: args.p_idempotency_key,
            initial_prompt: args.p_initial_prompt,
            offer_fingerprint: args.p_offer_fingerprint,
            aspect_ratio: args.p_aspect_ratio,
            status: 'reserved',
            duration_limit_seconds: 60,
            resolution: '768p',
            credit_cost: 440,
            provider_session_id: null,
            provider_answer_sdp: null,
            charged_at: null,
            refunded_at: null,
            created_at: now,
            updated_at: now
          };
          return { data: { session_id: SESSION_ID, code: 'reserved', existing: false }, error: null };
        }
        return { data: { session_id: SESSION_ID, code: 'existing', existing: true }, error: null };
      }
      if (name === 'deduct_h3_director_credits_atomic') {
        if (state.session.charged_at) {
          return { data: { ok: true, code: 'already_deducted', new_balance: state.balance }, error: null };
        }
        state.session.charged_at = new Date().toISOString();
        state.balance -= 440;
        state.chargeWrites += 1;
        return { data: { ok: true, code: 'deducted', new_balance: state.balance }, error: null };
      }
      if (name === 'refund_h3_director_session_atomic') {
        if (state.failRefundOnce) {
          state.failRefundOnce = false;
          return { data: null, error: { message: 'injected_settlement_transport_failure' } };
        }
        if (state.session.refunded_at) {
          return { data: { ok: true, code: 'already_refunded', refunded: true }, error: null };
        }
        if (!state.session.charged_at) {
          return { data: { ok: true, code: 'no_charge_found', refunded: false }, error: null };
        }
        state.session.refunded_at = new Date().toISOString();
        state.balance += 440;
        state.refundWrites += 1;
        return { data: { ok: true, code: 'refunded', refunded: true }, error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    }
  };
  return db;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request() {
  return {
    method: 'POST',
    headers: { 'idempotency-key': IDEM_ID },
    body: { prompt: 'A live city street', sdp: 'v=0\r\ntest-offer', type: 'offer', aspectRatio: '16:9' }
  };
}

for (const point of ['after_credit_deduction', 'after_fal_request', 'before_provider_state_persist']) {
  test(`failure injection at ${point} leaves one auditable charge and force-reconciles once`, async () => {
    const db = makeDb();
    let providerCalls = 0;
    const handler = startModule._test.createHandler({
      requireConfirmedAuth: async () => ({ ok: true, user: { id: USER_ID }, supabase: db }),
      checkDirectorEnabled: async () => ({ ok: true }),
      getDirectorEntitlement: async () => ({ ok: true, allowed: true, accountStatus: 'active', balance: db.state.balance }),
      moderateDirectorPrompt: async () => ({ ok: true, allow: true }),
      createDirectorSession: async () => {
        providerCalls += 1;
        return { ok: true, sessionId: 'fal-session-1', sdp: 'v=0\r\ntest-answer', type: 'answer' };
      },
      interruptionHook: async (name) => {
        if (name === point) {
          const error = new Error(`injected interruption: ${point}`);
          error.injectedInterruption = true;
          throw error;
        }
      }
    });

    await assert.rejects(handler(request(), responseRecorder()), /injected interruption/);
    assert.equal(db.state.chargeWrites, 1);
    assert.equal(db.state.balance, 560);
    assert.equal(db.state.session.status, 'connecting');
    assert.equal(db.state.session.provider_session_id, null);
    assert.equal(providerCalls, point === 'after_credit_deduction' ? 0 : 1);

    const later = Date.now() + 10 * 60 * 1000;
    const alerts = await listStuck(db, later);
    assert.equal(alerts.ok, true);
    assert.equal(alerts.alerts.length, 1);
    assert.equal(alerts.alerts[0].id, SESSION_ID);
    assert.equal(alerts.alerts[0].forceRequired, true);

    const withoutForce = await releaseSession(db, SESSION_ID, { force: false, nowMs: later });
    assert.equal(withoutForce.status, 409);
    assert.equal(withoutForce.body.error, 'force_required');
    assert.equal(db.state.balance, 560);

    db.state.failRefundOnce = true;
    const uncertain = await releaseSession(db, SESSION_ID, { force: true, nowMs: later });
    assert.equal(uncertain.status, 503);
    assert.equal(uncertain.body.error, 'settle_state_uncertain');
    assert.equal(db.state.session.status, 'failed');
    assert.equal(db.state.balance, 560);

    const retried = await releaseSession(db, SESSION_ID, { force: true, nowMs: later });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.retriedSettlement, true);
    assert.equal(retried.body.creditRefundedNow, 440);
    assert.equal(db.state.balance, 1000);
    assert.equal(db.state.refundWrites, 1);

    const replay = await releaseSession(db, SESSION_ID, { force: true, nowMs: later });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.alreadyRefunded, true);
    assert.equal(db.state.balance, 1000);
    assert.equal(db.state.refundWrites, 1);
  });
}

test('same idempotency key replays the stored answer without a second charge or fal session', async () => {
  const db = makeDb();
  let providerCalls = 0;
  const handler = startModule._test.createHandler({
    requireConfirmedAuth: async () => ({ ok: true, user: { id: USER_ID }, supabase: db }),
    checkDirectorEnabled: async () => ({ ok: true }),
    getDirectorEntitlement: async () => ({ ok: true, allowed: true, accountStatus: 'active', balance: db.state.balance }),
    moderateDirectorPrompt: async () => ({ ok: true, allow: true }),
    createDirectorSession: async () => {
      providerCalls += 1;
      return { ok: true, sessionId: 'fal-session-1', sdp: 'v=0\r\ntest-answer', type: 'answer' };
    }
  });

  const firstResponse = responseRecorder();
  await handler(request(), firstResponse);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.body.replay, undefined);
  assert.equal(db.state.chargeWrites, 1);
  assert.equal(providerCalls, 1);

  const secondResponse = responseRecorder();
  await handler(request(), secondResponse);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondResponse.body.replay, true);
  assert.equal(db.state.chargeWrites, 1);
  assert.equal(providerCalls, 1);
  assert.equal(db.state.balance, 560);
});

test('stale uncharged and unsubmitted session releases without force or refund', async () => {
  const db = makeDb();
  await db.rpc('reserve_h3_director_session_atomic', {
    p_user_id: USER_ID,
    p_idempotency_key: IDEM_ID,
    p_initial_prompt: 'test',
    p_offer_fingerprint: 'a'.repeat(64),
    p_aspect_ratio: '16:9'
  });
  db.state.session.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const released = await releaseSession(db, SESSION_ID, { force: false });
  assert.equal(released.status, 200);
  assert.equal(released.body.settleCode, 'no_charge_found');
  assert.equal(db.state.balance, 1000);
  assert.equal(db.state.refundWrites, 0);
});
