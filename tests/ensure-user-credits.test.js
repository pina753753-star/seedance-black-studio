'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const authSource = fs.readFileSync('api/_lib/confirmed-auth.js', 'utf8');
const apiSource = fs.readFileSync('api/ensure-user-credits.js', 'utf8');
const clientSource = fs.readFileSync('auth-config.js', 'utf8');
const user = { id: 'synthetic-owner', email: 'Owner@example.test', email_confirmed_at: '2026-01-01' };

// Execute the actual auth helper and handler. Every network boundary is replaced;
// these tests cannot reach Supabase or any other remote service.
function harness({ authResult = { data: { user } }, authThrows = false, configured = true, profile = null, balance = null, raceBalance = null, dbFailure = '', failAt = 1, realSdk = false } = {}) {
  const env = configured ? { SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service' } : {};
  const calls = [], tokens = [];
  const authModule = { exports: {} };
  vm.runInNewContext(authSource, {
    module: authModule, process: { env },
    require(name) {
      assert.equal(name, '@supabase/supabase-js');
      if (realSdk) {
        return { createClient: (url, key, options) => require('@supabase/supabase-js').createClient(url, key, {
          ...options, global: { fetch: async (url, options) => {
            assert.equal(new URL(url).pathname, '/auth/v1/user');
            assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-user-token');
            tokens.push('synthetic-user-token');
            return new Response(JSON.stringify(authResult.error || authResult.data.user), {
              status: authResult.error ? 401 : 200, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' }
            });
          } }
        }) };
      }
      return { createClient: () => ({ auth: { getUser: async token => {
        tokens.push(token);
        if (authThrows) throw new Error('synthetic secret error');
        return authResult;
      } } }) };
    }
  });
  const apiModule = { exports: {} };
  vm.runInNewContext(apiSource, {
    module: apiModule, process: { env },
    require(name) { assert.equal(name, './_lib/confirmed-auth.js'); return authModule.exports; },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(tokens.length, 1, 'auth must complete before privileged access');
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://offline.invalid');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-service');
      if (dbFailure && calls.length === failAt) return new Response(JSON.stringify({ message: dbFailure }), { status: 500 });
      let rows = [];
      if (!options.method) {
        assert.equal(parsed.searchParams.get('user_id'), 'eq.' + user.id);
        rows = balance ? [balance] : [];
      } else {
        assert.equal(options.method, 'POST');
        assert.match(options.headers.Prefer, /resolution=ignore-duplicates/);
        const payload = JSON.parse(options.body);
        if (parsed.pathname.endsWith('/profiles')) {
          assert.equal(parsed.searchParams.get('on_conflict'), 'id');
          assert.equal(payload.id, user.id);
          assert.equal(payload.email, 'owner@example.test');
          profile ||= payload;
        } else {
          assert.equal(parsed.searchParams.get('on_conflict'), 'user_id');
          assert.equal(payload.user_id, user.id);
          assert.equal(payload.free_credits + payload.subscription_credits + payload.purchased_credits, 0);
          balance ||= raceBalance;
          if (!balance) { balance = payload; rows = [balance]; }
        }
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }
  });
  return {
    calls, tokens, state: () => ({ profile, balance }),
    async request(body = {}, headers = { authorization: 'Bearer synthetic-user-token' }, method = 'POST') {
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await apiModule.exports({ method, headers, body }, res);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      return res;
    }
  };
}

test('missing, empty and non-bearer credentials reject before auth or privileged DB access', async () => {
  for (const headers of [{}, { authorization: '' }, { authorization: 'Bearer ' }, { authorization: 'Basic synthetic' }]) {
    const h = harness();
    assert.equal((await h.request({ userId: 'victim' }, headers)).code, 401);
    assert.equal(h.calls.length, 0); assert.equal(h.tokens.length, 0);
  }
});
test('invalid, expired, absent, unconfirmed, unavailable auth and missing configuration fail closed', async () => {
  for (const [options, status] of [
    [{ authResult: { error: { name: 'AuthApiError', code: 'bad_jwt' } } }, 401],
    [{ authResult: { error: { name: 'AuthApiError', code: 'session_not_found' } } }, 401],
    [{ authResult: { data: { user: null } } }, 503],
    [{ authResult: { data: { user: { ...user, email_confirmed_at: null } } } }, 403],
    [{ authResult: { error: { name: 'AuthRetryableFetchError' } } }, 503],
    [{ authThrows: true }, 503], [{ configured: false }, 500]
  ]) {
    const h = harness(options);
    assert.equal((await h.request()).code, status);
    assert.equal(h.calls.length, 0);
  }
});
test('every supplied identity alias and email must match, before any DB access', async () => {
  for (const body of [{ userId: 'victim' }, { user_id: 'victim' }, { userId: user.id, user_id: 'victim' }, { userId: 'victim', user_id: user.id }, { email: 'victim@example.test' }, { email: null }, { userId: null }]) {
    const h = harness(); assert.equal((await h.request(body)).code, 403); assert.equal(h.calls.length, 0);
  }
});
test('malformed bodies reject before DB access, and unauthenticated malformed JSON is still unauthorized', async () => {
  for (const body of ['{', 'null', '[]', '42']) {
    const h = harness(); assert.equal((await h.request(body)).code, 400); assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.request('{', {})).code, 401); assert.equal(h.calls.length, 0);
});
test('verified identity alone selects existing balance without modifying it', async () => {
  for (const body of [{}, { userId: user.id, user_id: user.id, email: ' OWNER@example.test ' }]) {
    const balance = { user_id: user.id, purchased_credits: 123 };
    const h = harness({ balance }); const res = await h.request(body);
    assert.equal(res.code, 200); assert.equal(res.body.created, false);
    assert.deepEqual(JSON.parse(JSON.stringify(res.body.balance)), balance);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.tokens, ['synthetic-user-token']);
  }
});
test('initialization derives verified email and zero credits; existing paid profile is preserved', async () => {
  for (const profile of [null, { id: user.id, email: 'existing@example.test', plan: 'premium', role: 'admin' }]) {
    const h = harness({ profile }); const res = await h.request();
    assert.equal(res.code, 200); assert.equal(res.body.created, true);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.state().profile, profile || { id: user.id, email: 'owner@example.test', plan: 'free' });
  }
});
test('concurrent initialization preserves winner credits and returns them without claiming creation', async () => {
  const raceBalance = { user_id: user.id, free_credits: 100, subscription_credits: 800, purchased_credits: 20 };
  const h = harness({ raceBalance }); const res = await h.request();
  assert.equal(res.code, 200); assert.equal(res.body.created, false);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.balance)), raceBalance);
  assert.equal(h.calls.length, 4);
});
test('provider errors are generic and never leak raw messages', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const h = harness({ dbFailure: 'private provider details and synthetic credential', failAt, raceBalance: { user_id: user.id, purchased_credits: 20 } });
    const res = await h.request(); assert.equal(res.code, 500);
    assert.equal(res.body.error, 'CREDIT_INITIALIZATION_FAILED'); assert.equal(h.calls.length, failAt);
  }
});
test('public metadata has no auth or database side effects', async () => {
  const h = harness(); assert.equal((await h.request({}, {}, 'GET')).code, 200);
  assert.equal(h.calls.length, 0); assert.equal(h.tokens.length, 0);
});

function caller() {
  const calls = [], context = { fetch: async (...args) => calls.push(args) };
  const start = clientSource.indexOf('  async function ensureCredits(');
  const end = clientSource.indexOf('  async function totalCredits(', start);
  vm.createContext(context); vm.runInContext(clientSource.slice(start, end), context);
  return { calls, ensure: context.ensureCredits };
}
test('generation propagates the current session token and matching identity for password, signup, OAuth and restored sessions', async () => {
  for (const provider of ['password', 'signup-with-session', 'oauth', 'restored', 'refreshed']) {
    const h = caller(); const token = 'synthetic-' + provider;
    await h.ensure({ user, access_token: token });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], '/api/ensure-user-credits');
    assert.equal(h.calls[0][1].headers.Authorization, 'Bearer ' + token);
    assert.deepEqual(JSON.parse(h.calls[0][1].body), { userId: user.id });
  }
  assert.match(clientSource, /await ensureCredits\(sessionData\.session\)/);
});
test('signup without session and incomplete session never send an unauthenticated repair request', async () => {
  const h = caller();
  for (const session of [null, undefined, {}, { user }, { access_token: 'synthetic' }]) await h.ensure(session);
  assert.equal(h.calls.length, 0);
});
test('no new login, email-confirmation, OAuth or session-restore initialization is introduced', () => {
  const login = fs.readFileSync('login.html', 'utf8');
  const profile = fs.readFileSync('profile.html', 'utf8');
  assert.doesNotMatch(login + profile, /ensure-user-credits|ensureCredits/);
  const signup = login.slice(login.indexOf("if(mode==='signup'){", login.indexOf('if(result.error)')));
  assert.match(signup, /if\(result\.data\?\.session\)\{[\s\S]*?await client\.auth\.signOut\(\)/);
  assert.match(signup, /確認メール[\s\S]*?return;/);
});

test('installed Supabase SDK verifies bearer remotely before self-only access and rejects invalid JWT without DB calls', async () => {
  const valid = harness({ realSdk: true, balance: { user_id: user.id, free_credits: 0 } });
  assert.equal((await valid.request()).code, 200); assert.equal(valid.calls.length, 1);
  const invalid = harness({ realSdk: true, authResult: { error: { code: 'bad_jwt', message: 'Invalid JWT' } } });
  assert.equal((await invalid.request()).code, 401); assert.equal(invalid.calls.length, 0);
});
