'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.CRON_SECRET = 'test-cron-secret';
process.env.WAVESPEED_API_KEY = 'test-wavespeed-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
let startHandler;
let statusHandler;
let reconcileHandler;
try {
  startHandler = require('../api/_lib/seedance-start.js');
  statusHandler = require('../api/seedance-status.js');
  reconcileHandler = require('../api/wavespeed-reconcile.js');
} finally {
  Module._load = originalLoad;
}

const { buildWaveSpeedPayload, resolveWaveSpeedModel } = startHandler._test;
const {
  normalizeStatus, isCompletedStatus, isFailedStatus, findVideoUrl,
  fetchJsonWithTimeout, fetchActualProviderCost, ACTUAL_COST_FETCH_TIMEOUT_MS
} = statusHandler._reconcileHelpers;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

function failureDb(taskId = 'task-1') {
  let rpcCalls = 0;
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    in() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    async maybeSingle() { return { data: { id: taskId }, error: null }; }
  };
  return {
    from(table) {
      assert.equal(table, 'generation_tasks');
      return chain;
    },
    async rpc(name, args) {
      rpcCalls++;
      assert.equal(name, 'refund_generation_task_atomic');
      assert.equal(args.p_task_id, taskId);
      return { data: { ok: true, code: 'refunded' }, error: null };
    },
    get rpcCalls() { return rpcCalls; }
  };
}

test('WaveSpeed text/reference payload uses reference_images without OpenRouter fields', () => {
  const payload = buildWaveSpeedPayload({
    providerPrompt: 'prompt', duration: 15, resolution: '1080p', aspectRatio: '16:9', mode: 'reference_to_video',
    frameImages: [], inputReferences: [], firstFrameUrl: '', referenceUrl: 'https://example.com/a.png',
    referenceUrls: [{ image_url: { url: 'https://example.com/a.png' } }, { image_url: { url: 'https://example.com/b.png' } }],
    referenceAudioUrls: ['https://storage.example.com/audio.mp3?token=secret']
  });
  assert.deepEqual(payload, {
    prompt: 'prompt', duration: 15, resolution: '1080p', aspect_ratio: '16:9', generate_audio: true,
    reference_images: ['https://example.com/a.png', 'https://example.com/b.png'],
    reference_audios: ['https://storage.example.com/audio.mp3?token=secret']
  });
  assert.equal('model' in payload, false);
  assert.equal('input_references' in payload, false);
});

test('WaveSpeed image-to-video payload uses only the first image', () => {
  const payload = buildWaveSpeedPayload({
    providerPrompt: 'prompt', duration: 30, resolution: '1080p', aspectRatio: '9:16', mode: 'image_to_video',
    frameImages: [], inputReferences: [], firstFrameUrl: 'https://example.com/first.png', referenceUrl: '', referenceUrls: []
  });
  assert.equal(payload.image, 'https://example.com/first.png');
  assert.equal('reference_images' in payload, false);
});

test('standard and Turbo resolve to different WaveSpeed endpoints for every generation mode', () => {
  const expected = {
    text_to_video: ['bytedance/seedance-2.5/text-to-video', 'bytedance/seedance-2.5/text-to-video-turbo'],
    reference_to_video: ['bytedance/seedance-2.5/text-to-video', 'bytedance/seedance-2.5/text-to-video-turbo'],
    storyboard: ['bytedance/seedance-2.5/text-to-video', 'bytedance/seedance-2.5/text-to-video-turbo'],
    image_to_video: ['bytedance/seedance-2.5/image-to-video', 'bytedance/seedance-2.5/image-to-video-turbo']
  };
  for (const [mode, [standardEndpoint, turboEndpoint]] of Object.entries(expected)) {
    assert.equal(resolveWaveSpeedModel('bytedance/seedance-2.5-standard', mode), standardEndpoint);
    assert.equal(resolveWaveSpeedModel('bytedance/seedance-2.5', mode), turboEndpoint);
    assert.notEqual(standardEndpoint, turboEndpoint);
  }
  assert.equal(resolveWaveSpeedModel('bytedance/seedance-2.0', 'text_to_video'), '');
});

test('WaveSpeed status helpers preserve only the approved terminal states', () => {
  assert.equal(normalizeStatus({ data: { status: 'created' } }), 'created');
  assert.equal(normalizeStatus({ data: { status: 'processing' } }), 'processing');
  assert.equal(isCompletedStatus('completed', 'wavespeed'), true);
  assert.equal(isCompletedStatus('success', 'wavespeed'), false);
  for (const status of ['failed', 'cancelled', 'timeout']) assert.equal(isFailedStatus(status, 'wavespeed'), true);
  for (const status of ['created', 'processing', 'error', 'canceled']) assert.equal(isFailedStatus(status, 'wavespeed'), false);
  assert.equal(findVideoUrl({ data: { outputs: ['https://cdn.example.com/video.mp4'] } }), 'https://cdn.example.com/video.mp4');
});

test('WaveSpeed reconcile keeps created and processing tasks active', async () => {
  const previousFetch = global.fetch;
  try {
    for (const providerStatus of ['created', 'processing']) {
      const db = failureDb();
      global.fetch = async () => response(200, { data: { status: providerStatus } });
      const outcome = await reconcileHandler._test.reconcileTask(db, {
        id: 'task-1', user_id: 'user-1', api_task_id: 'prediction-1', created_at: new Date().toISOString()
      });
      assert.equal(outcome.state, 'processing');
      assert.equal(outcome.providerStatus, providerStatus);
      assert.equal(db.rpcCalls, 0);
    }
  } finally {
    global.fetch = previousFetch;
  }
});

test('WaveSpeed terminal failures use the atomic refund once per poll', async () => {
  const previousFetch = global.fetch;
  try {
    for (const providerStatus of ['failed', 'cancelled', 'timeout']) {
      const db = failureDb();
      global.fetch = async () => response(200, { data: { status: providerStatus }, message: 'provider failure' });
      const outcome = await reconcileHandler._test.reconcileTask(db, {
        id: 'task-1', user_id: 'user-1', api_task_id: 'prediction-1', created_at: new Date().toISOString()
      });
      assert.deepEqual(outcome, { state: 'failed', refunded: true, refundConfirmed: true });
      assert.equal(db.rpcCalls, 1);
    }
  } finally {
    global.fetch = previousFetch;
  }
});

test('WaveSpeed cron rejects missing or incorrect CRON_SECRET', () => {
  assert.equal(reconcileHandler._test.authenticate({ headers: {} }), false);
  assert.equal(reconcileHandler._test.authenticate({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(reconcileHandler._test.authenticate({ headers: { authorization: 'Bearer test-cron-secret' } }), true);
});

// ---- fetchJsonWithTimeout / fetchActualProviderCost (actual-cost recording on refund) ----

test('fetchJsonWithTimeout resolves with parsed JSON when the response completes quickly', async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ hello: 'world' }) });
    const result = await fetchJsonWithTimeout('https://example.invalid', {}, 1000);
    assert.deepEqual(result, { hello: 'world' });
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchJsonWithTimeout returns null for a non-2xx response', async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ should: 'not be read' }) });
    const result = await fetchJsonWithTimeout('https://example.invalid', {}, 1000);
    assert.equal(result, null);
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchJsonWithTimeout is bounded by timeoutMs even when fetch() itself never resolves (connection stage hangs)', async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = () => new Promise(() => {}); // never settles — simulates a hung connection
    const start = Date.now();
    const result = await fetchJsonWithTimeout('https://example.invalid', {}, 150);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed < 500, `expected timeout-bounded resolution well under 500ms, took ${elapsed}ms`);
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchJsonWithTimeout is bounded by timeoutMs even when res.json() never resolves (body-read stage hangs) — this is the case fetch()-only timeouts miss', async () => {
  const previousFetch = global.fetch;
  try {
    // Headers arrive immediately (fetch() resolves), but the body never
    // finishes reading — reproduces the exact bug reported by Codex review:
    // an AbortController scoped to fetch() alone does not bound this.
    global.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
    const start = Date.now();
    const result = await fetchJsonWithTimeout('https://example.invalid', {}, 150);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed < 500, `expected timeout-bounded resolution well under 500ms, took ${elapsed}ms`);
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchActualProviderCost extracts OpenRouter total_cost from the confirmed response shape', async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { id: 'gen-vid-1', total_cost: 6.94323 } }) });
    const cost = await fetchActualProviderCost({ provider: 'openrouter', providerJobId: 'gen-vid-1' });
    assert.equal(cost, 6.94323);
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchActualProviderCost extracts WaveSpeed price from the confirmed response shape (data.items[0].price)', async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: { items: [{ billing_type: 'deduct', price: 2.835, prediction: { uuid: 'pred-1', status: 'completed' } }] }
      })
    });
    const price = await fetchActualProviderCost({ provider: 'wavespeed', providerJobId: 'pred-1' });
    assert.equal(price, 2.835);
  } finally {
    global.fetch = previousFetch;
  }
});

test('fetchActualProviderCost returns null (not a hang) when provider/job id/API key is missing', async () => {
  assert.equal(await fetchActualProviderCost({ provider: 'openrouter', providerJobId: '' }), null);
  assert.equal(await fetchActualProviderCost({ provider: 'unknown-provider', providerJobId: 'x' }), null);
});

test('fetchActualProviderCost end-to-end: resolves null within ACTUAL_COST_FETCH_TIMEOUT_MS (5s) even when the provider response body never finishes, proving the refund path is never blocked indefinitely', async () => {
  const previousFetch = global.fetch;
  try {
    assert.equal(ACTUAL_COST_FETCH_TIMEOUT_MS, 5000);
    global.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
    const start = Date.now();
    const price = await fetchActualProviderCost({ provider: 'wavespeed', providerJobId: 'pred-1' });
    const elapsed = Date.now() - start;
    assert.equal(price, null);
    // Must actually reach (not short-circuit before) the timeout, and must
    // never exceed it by more than a small scheduling margin.
    assert.ok(elapsed >= ACTUAL_COST_FETCH_TIMEOUT_MS - 50, `expected to wait close to the full timeout, took ${elapsed}ms`);
    assert.ok(elapsed < ACTUAL_COST_FETCH_TIMEOUT_MS + 500, `expected total time to stay bounded near the timeout, took ${elapsed}ms`);
  } finally {
    global.fetch = previousFetch;
  }
});
