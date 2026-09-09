'use strict';

// api/h3-director/image-upload-url.js does not use the createHandler(deps)
// dependency-injection pattern (unlike start-session.js), so it is exercised
// here the same way tests/team-plan-purchase-enabled.test.js mocks
// require('stripe')/require('@supabase/supabase-js'): by planting fake
// module entries directly into require.cache for its dependencies
// (../_lib/confirmed-auth.js, ../_lib/h3-director-store.js,
// ../_lib/h3-director-config.js, ../_lib/h3-live-image-store.js,
// ../_lib/h3-live-config.js) before requiring the handler fresh. No real
// Supabase, fal, or credit deduction is ever touched — start-session.js
// (the only file that charges credits or calls fal) is untouched by this
// test file and by the production change it verifies.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.join(__dirname, '..');
const handlerPath = path.join(repoRoot, 'api', 'h3-director', 'image-upload-url.js');
const confirmedAuthPath = path.join(repoRoot, 'api', '_lib', 'confirmed-auth.js');
const directorStorePath = path.join(repoRoot, 'api', '_lib', 'h3-director-store.js');
const directorConfigPath = path.join(repoRoot, 'api', '_lib', 'h3-director-config.js');
const liveImageStorePath = path.join(repoRoot, 'api', '_lib', 'h3-live-image-store.js');
const liveConfigPath = path.join(repoRoot, 'api', '_lib', 'h3-live-config.js');

const DEFAULT_USER = { id: 'user-1' };

function loadHandlerWithMocks(overrides = {}) {
  const auth = overrides.auth || { ok: true, user: DEFAULT_USER, supabase: {} };
  const control = overrides.control || { ok: true };
  const entitlement = overrides.entitlement || {
    ok: true, allowed: true, accountStatus: 'active', plan: 'premium', balance: 1000
  };
  const slot = overrides.slot || {
    ok: true, uploadId: 'upload-1', bucket: 'h3-live-image-quarantine', path: 'p', token: 't', signedUrl: 'https://example.test/signed'
  };
  const calls = { checkDirectorEnabled: 0, createImageUploadSlot: 0 };

  const fakeConfirmedAuth = {
    id: confirmedAuthPath,
    filename: confirmedAuthPath,
    loaded: true,
    exports: { requireConfirmedAuth: async () => auth }
  };
  const fakeDirectorStore = {
    id: directorStorePath,
    filename: directorStorePath,
    loaded: true,
    exports: {
      jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
      serviceClient: () => ({}),
      isUuid: () => true,
      checkDirectorEnabled: async () => { calls.checkDirectorEnabled++; return control; },
      getDirectorEntitlement: async () => entitlement
    }
  };
  const fakeDirectorConfig = {
    id: directorConfigPath,
    filename: directorConfigPath,
    loaded: true,
    exports: { ALLOWED_PLANS: ['premium', 'scale', 'team', 'ultimate'] }
  };
  const fakeLiveImageStore = {
    id: liveImageStorePath,
    filename: liveImageStorePath,
    loaded: true,
    exports: {
      isAllowedMime: (mime) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime),
      sweepStaleUploads: async () => {},
      createImageUploadSlot: async () => { calls.createImageUploadSlot++; return slot; }
    }
  };
  const fakeLiveConfig = {
    id: liveConfigPath,
    filename: liveConfigPath,
    loaded: true,
    exports: { IMAGE_MAX_BYTES: 20 * 1024 * 1024 }
  };

  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    directorStore: require.cache[directorStorePath],
    directorConfig: require.cache[directorConfigPath],
    liveImageStore: require.cache[liveImageStorePath],
    liveConfig: require.cache[liveConfigPath]
  };

  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[directorStorePath] = fakeDirectorStore;
  require.cache[directorConfigPath] = fakeDirectorConfig;
  require.cache[liveImageStorePath] = fakeLiveImageStore;
  require.cache[liveConfigPath] = fakeLiveConfig;
  delete require.cache[handlerPath];

  const handler = require(handlerPath);

  return {
    handler,
    calls,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[directorStorePath] = prev.directorStore;
      require.cache[directorConfigPath] = prev.directorConfig;
      require.cache[liveImageStorePath] = prev.liveImageStore;
      require.cache[liveConfigPath] = prev.liveConfig;
      delete require.cache[handlerPath];
    }
  };
}

function fakeReqRes(body) {
  const req = { method: 'POST', headers: {}, body: JSON.stringify(body || {}) };
  const res = {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader() {}
  };
  return { req, res };
}

test('VERCEL_ENV=preview + Director disabled → kill switch理由では拒否されない', async () => {
  const prevEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  const { handler, calls, restore } = loadHandlerWithMocks({ control: { ok: false } });
  try {
    const { req, res } = fakeReqRes({ contentType: 'image/png', byteSize: 1000, filename: 'a.png' });
    await handler(req, res);
    assert.notEqual(res.payload && res.payload.error, 'h3_director_disabled');
    assert.equal(res.statusCode, 200);
    assert.equal(calls.createImageUploadSlot, 1);
  } finally {
    restore();
    process.env.VERCEL_ENV = prevEnv;
  }
});

test('VERCEL_ENV=production + Director disabled → 従来通り503 h3_director_disabled', async () => {
  const prevEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  const { handler, calls, restore } = loadHandlerWithMocks({ control: { ok: false } });
  try {
    const { req, res } = fakeReqRes({ contentType: 'image/png', byteSize: 1000, filename: 'a.png' });
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error, 'h3_director_disabled');
    assert.equal(calls.createImageUploadSlot, 0);
  } finally {
    restore();
    process.env.VERCEL_ENV = prevEnv;
  }
});

test('Previewでも未ログインは拒否される', async () => {
  const prevEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  const { handler, calls, restore } = loadHandlerWithMocks({
    control: { ok: false },
    auth: { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
  });
  try {
    const { req, res } = fakeReqRes({ contentType: 'image/png', byteSize: 1000, filename: 'a.png' });
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.error, 'unauthorized');
    assert.equal(calls.createImageUploadSlot, 0);
  } finally {
    restore();
    process.env.VERCEL_ENV = prevEnv;
  }
});

test('Previewでも対象外プランは拒否される', async () => {
  const prevEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  const { handler, calls, restore } = loadHandlerWithMocks({
    control: { ok: false },
    entitlement: { ok: true, allowed: false, accountStatus: 'active', plan: 'free', balance: 0 }
  });
  try {
    const { req, res } = fakeReqRes({ contentType: 'image/png', byteSize: 1000, filename: 'a.png' });
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.error, 'eligible_plan_required');
    assert.equal(calls.createImageUploadSlot, 0);
  } finally {
    restore();
    process.env.VERCEL_ENV = prevEnv;
  }
});

test('PreviewでもaccountStatus != active は拒否される', async () => {
  const prevEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  const { handler, calls, restore } = loadHandlerWithMocks({
    control: { ok: false },
    entitlement: { ok: true, allowed: true, accountStatus: 'suspended', plan: 'premium', balance: 1000 }
  });
  try {
    const { req, res } = fakeReqRes({ contentType: 'image/png', byteSize: 1000, filename: 'a.png' });
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.error, 'account_restricted');
    assert.equal(calls.createImageUploadSlot, 0);
  } finally {
    restore();
    process.env.VERCEL_ENV = prevEnv;
  }
});

// start-session.js later gained its own, separately-reviewed Preview-only
// relaxation (tests/h3-director-preview-generation.test.js) — this file's
// scope stays limited to image-upload-url.js, so no assertion about
// start-session.js's contents is made here.

test('h3-director.htmlはgate表示後blocked=trueとなりprompt入力でactionが有効化されない', () => {
  const page = fs.readFileSync(path.join(repoRoot, 'h3-director.html'), 'utf8');
  assert.match(
    page,
    /if\(renderAccessGate\(info\)\)\{\s*blocked=true;\s*\$\('action'\)\.disabled=true;\s*return;\s*\}/
  );
  // prompt入力時のハンドラは既存のblockedチェックを維持している(緩めていない)。
  assert.match(
    page,
    /\$\('prompt'\)\.addEventListener\('input',function\(\)\{\$\('action'\)\.disabled=blocked\|\|starting\|\|live\|\|imageUploading\|\|!this\.value\.trim\(\)\}\)/
  );
});
