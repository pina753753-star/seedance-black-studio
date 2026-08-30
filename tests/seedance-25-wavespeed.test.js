'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('standard and Turbo use separate approved WaveSpeed endpoint IDs and key', () => {
  const source = read('api/_lib/seedance-start.js');
  assert.match(source, /SEEDANCE_25_MODELS\.has\(model\) \? 'wavespeed' : 'openrouter'/);
  assert.match(source, /process\.env\.WAVESPEED_API_KEY/);
  assert.match(source, /bytedance\/seedance-2\.5\/text-to-video'/);
  assert.match(source, /bytedance\/seedance-2\.5\/image-to-video'/);
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

test('generation UI exposes standard and Turbo separately without migrating saved Turbo drafts', () => {
  const source = read('generate-prod.html');
  assert.match(source, /value="bytedance\/seedance-2\.5-standard">Seedance 2\.5（Premium以上）/);
  assert.match(source, /value="bytedance\/seedance-2\.5">Seedance 2\.5 Turbo（Premium以上）/);
  assert.match(source, /const SEEDANCE_25_TURBO_MODEL='bytedance\/seedance-2\.5'/);
  assert.match(source, /const SEEDANCE_25_STANDARD_MODEL='bytedance\/seedance-2\.5-standard'/);
  assert.match(source, /const isTurbo=modelId===SEEDANCE_25_TURBO_MODEL/);
  assert.match(source, /const isStandard=modelId===SEEDANCE_25_STANDARD_MODEL/);
  assert.match(source, /opt480\.disabled=isTurbo;opt480\.hidden=isTurbo/);
  assert.match(source, /opt1080\.disabled=isStandard;opt1080\.hidden=isStandard/);
  assert.match(source, /\[SEEDANCE_25_STANDARD_MODEL\]:\{maxCredits:990,creditsPerSecond:\{'480p':495\/30,'720p':990\/30\}\}/);
  assert.match(source, /\[SEEDANCE_25_TURBO_MODEL\]:\{maxCredits:600,creditsPerSecond:\{'720p':550\/30,'1080p':20\}\}/);
  assert.match(source, /const relevant=\$\('model'\)\?\.value===SEEDANCE_25_TURBO_MODEL/);
  assert.match(source, /Seedance 2\.5 Turbo・1080p：15秒 300クレジット／30秒 600クレジット/);
  assert.doesNotMatch(source, /value="bytedance\/seedance-2\.5">Seedance 2\.5（Premium以上）/);
});

test('reference audio storage remains private and MP3-only', () => {
  const migration = read('supabase/migrations/20260821010000_create_seedance_reference_audio_bucket.sql');
  assert.match(migration, /'seedance-reference-audio'/);
  assert.match(migration, /false,/);
  assert.match(migration, /array\['audio\/mpeg'\]/);
  assert.doesNotMatch(migration, /create policy/i);
});
