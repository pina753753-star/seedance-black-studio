'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('1080p start routing uses the approved WaveSpeed models and key', () => {
  const source = read('api/_lib/seedance-start.js');
  assert.match(source, /model === 'bytedance\/seedance-2\.5' && resolution === '1080p'/);
  assert.match(source, /process\.env\.WAVESPEED_API_KEY/);
  assert.match(source, /bytedance\/seedance-2\.5\/text-to-video-turbo/);
  assert.match(source, /bytedance\/seedance-2\.5\/image-to-video-turbo/);
  assert.match(source, /if \(mode === 'image_to_video'\) payload\.image/);
  assert.match(source, /payload\.reference_images/);
});

test('provider is persisted before WaveSpeed submission and OpenRouter reconciliation stays scoped', () => {
  const start = read('api/_lib/seedance-start.js');
  const providerUpdate = start.indexOf("api_provider: 'wavespeed'");
  const providerSend = start.indexOf('fetch(providerEndpoint');
  assert.ok(providerUpdate >= 0 && providerUpdate < providerSend);
  assert.match(read('api/openrouter-reconcile.js'), /\.eq\('api_provider', 'openrouter'\)/);
});

test('WaveSpeed status URL, terminal states, and OpenRouter-only fallback are isolated', () => {
  const source = read('api/seedance-status.js');
  assert.match(source, /api\\\.wavespeed\\\.ai\\\/api\\\/v3\\\/predictions/);
  assert.match(source, /\['failed', 'cancelled', 'timeout'\]/);
  assert.match(source, /provider === 'wavespeed'.*=== 'completed'/);
  assert.match(source, /provider === 'openrouter' && !foundVideoUrl/);
  assert.match(source, /provider === 'openrouter' \? extractCostUsd\(data\) : null/);
});

test('WaveSpeed refunds reuse the atomic idempotent RPC', () => {
  const migration = read('supabase/migrations/20260821000000_allow_wavespeed_atomic_refund.sql');
  assert.match(migration, /v_api_provider NOT IN \('fal', 'openrouter', 'wavespeed'\)/);
  assert.match(migration, /reason\s*=\s*'generation_refund'/);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(read('api/seedance-status.js'), /db\.rpc\('refund_generation_task_atomic'/);
});

test('client enables Seedance 2.5 1080p and prefers the saved polling URL', () => {
  const source = read('generate-prod.html');
  assert.doesNotMatch(source, /Seedance 2\.5は1080pに対応していません/);
  assert.match(source, /'1080p':20/);
  assert.match(source, /const pu=task\.polling_url\|\|\(task\.api_task_id\?/);
});
