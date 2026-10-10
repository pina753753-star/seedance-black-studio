'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_REFERENCE_DANCE_BYTES,
  stagingPath,
  approvedPath,
  reviewFramePath,
  validateOwnedPath,
  providerCostCents,
  referenceDanceCredits,
  validateReadyReferenceDance,
  validateReferenceDanceVariant,
  buildReferenceDanceProviderPrompt
} = require('../api/_lib/reference-dance.js');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing.js');

const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('server-owned storage paths are exact and user scoped', () => {
  assert.equal(stagingPath(USER, ASSET), `staging/${USER}/${ASSET}.mp4`);
  assert.equal(approvedPath(USER, ASSET), `approved/${USER}/${ASSET}.mp4`);
  assert.equal(reviewFramePath(USER, ASSET, 3), `review/${USER}/${ASSET}/frame-3.jpg`);
  assert.equal(validateOwnedPath('staging', USER, ASSET, stagingPath(USER, ASSET)), true);
  assert.equal(validateOwnedPath('approved', USER, ASSET, approvedPath(USER, ASSET)), true);
  assert.equal(validateOwnedPath('review', USER, ASSET, reviewFramePath(USER, ASSET, 5)), true);
});

for (const invalid of [
  `staging/${USER}/../${ASSET}.mp4`,
  `staging/11111111-1111-4111-8111-111111111111/${ASSET}.mp4`,
  `approved/${USER}/${ASSET}.mov`,
  `review/${USER}/${ASSET}/frame-6.jpg`
]) {
  test(`rejects unowned or malformed path: ${invalid}`, () => {
    assert.equal(
      ['staging', 'approved', 'review'].some((kind) => validateOwnedPath(kind, USER, ASSET, invalid)),
      false
    );
  });
}

test('official 720p Turbo reference-video provider examples remain exact', () => {
  assert.equal(providerCostCents(2, 5), 87);
  assert.equal(providerCostCents(5, 5), 120);
  assert.equal(providerCostCents(15, 5), 230);
  assert.equal(providerCostCents(15, 15), 360);
});

test('credits preserve existing Turbo 720p provider-cost ratio', () => {
  assert.equal(referenceDanceCredits(2, 4), 70);
  assert.equal(referenceDanceCredits(5, 5), 110);
  assert.equal(referenceDanceCredits(15, 5), 215);
  assert.equal(referenceDanceCredits(15, 15), 330);
});

test('server pricing ignores browser estimates and uses inspected duration', () => {
  const trusted = {
    model: 'bytedance/seedance-2.5',
    mode: 'reference_to_video',
    resolution: '720p',
    duration: 5,
    referenceDanceBillableSeconds: 15,
    estimated_credits: 1
  };
  assert.equal(calculateVideoCreditCost(trusted), 215);
  assert.throws(() => calculateVideoCreditCost({ ...trusted, resolution: '1080p' }));
});

test('WaveSpeed receives only a server-signed reference video with audio disabled', () => {
  const start = read('api/_lib/seedance-start.js');
  const providerPrompt = buildReferenceDanceProviderPrompt('踊る');
  assert.match(start, /createSignedUrl\(referenceDance\.approvedPath/);
  assert.match(start, /payload\.reference_videos = \[\.\.\.new Set\(referenceVideoUrls\)\]/);
  assert.match(start, /generate_audio: referenceVideoUrls\.length === 0/);
  assert.match(providerPrompt, /@Image 1/);
  assert.match(providerPrompt, /@Video 1/);
  assert.match(providerPrompt, /do not convert it to slow motion/i);
});

test('closed beta accepts only Turbo reference mode, 720p and 4-15 seconds', () => {
  assert.equal(validateReferenceDanceVariant({ model: 'bytedance/seedance-2.5', mode: 'reference_to_video', resolution: '720p', outputSeconds: 15 }), true);
  for (const input of [
    { model: 'bytedance/seedance-2.5-standard', mode: 'reference_to_video', resolution: '720p', outputSeconds: 5 },
    { model: 'bytedance/seedance-2.5', mode: 'image_to_video', resolution: '720p', outputSeconds: 5 },
    { model: 'bytedance/seedance-2.5', mode: 'reference_to_video', resolution: '1080p', outputSeconds: 5 },
    { model: 'bytedance/seedance-2.5', mode: 'reference_to_video', resolution: '720p', outputSeconds: 16 }
  ]) assert.throws(() => validateReferenceDanceVariant(input));
});

test('ready registry row is the server-authoritative trust boundary', () => {
  const row = {
    id: ASSET,
    user_id: USER,
    status: 'ready',
    approved_path: approvedPath(USER, ASSET),
    size_bytes: 20 * 1024 * 1024,
    duration_ms: 5001,
    billable_seconds: 6,
    video_codec: 'h264',
    sha256: 'a'.repeat(64),
    rights_confirmed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  assert.deepEqual(validateReadyReferenceDance(row, USER), {
    assetId: ASSET,
    approvedPath: row.approved_path,
    durationMs: 5001,
    billableSeconds: 6,
    sizeBytes: row.size_bytes,
    sha256: row.sha256
  });
  assert.throws(() => validateReadyReferenceDance({ ...row, user_id: '11111111-1111-4111-8111-111111111111' }, USER));
  assert.throws(() => validateReadyReferenceDance({ ...row, status: 'checking' }, USER));
  assert.throws(() => validateReadyReferenceDance({ ...row, billable_seconds: 5 }, USER));
  assert.throws(() => validateReadyReferenceDance({ ...row, size_bytes: MAX_REFERENCE_DANCE_BYTES + 1 }, USER));
  assert.throws(() => validateReadyReferenceDance({ ...row, expires_at: new Date(Date.now() - 1).toISOString() }, USER));
});

test('migration is private, service-role only, and claims inspection atomically', () => {
  const sql = read('supabase/migrations/20261010000000_create_seedance_reference_video_beta.sql');
  assert.match(sql, /'seedance-reference-video'[\s\S]*?false/);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.seedance_reference_video_uploads from public, anon, authenticated/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /inspection_attempts >= 3/i);
  assert.match(sql, /interval '5 minutes'/i);
  assert.match(sql, /billable_seconds = greatest\(2, ceil\(duration_ms \/ 1000\.0\)::integer\)/i);
  assert.match(sql, /seedance_reference_video_ready_complete_check/i);
  assert.match(sql, /grant execute on function public\.claim_seedance_reference_video_inspection\(uuid, uuid\)[\s\S]*?to service_role/i);
});

test('Railway inspection fails closed, strips audio and samples five frames', () => {
  const source = read('watermark-server/server.js');
  assert.match(source, /app\.post\('\/reference-dance-inspect'/);
  assert.match(source, /if \(!WATERMARK_SECRET\) return res\.status\(503\)/);
  assert.match(source, /'-an'/);
  assert.match(source, /Array\.from\(\{ length: 5 \}/);
  assert.match(source, /codec_name[\s\S]*?'h264'/);
  assert.match(source, /REFERENCE_DANCE_MAX_SECONDS = 15/);
  assert.match(source, /crypto\.createHash\('sha256'\)/);
  assert.match(source, /processingDeadline = Date\.now\(\) \+ REFERENCE_DANCE_PROCESS_TIMEOUT_MS/);
  assert.match(source, /referenceDanceRemainingMs\(processingDeadline\)/);
});

test('cleanup cron is registered and reference assets are isolated from audio cleanup', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.crons.some((item) => item.path === '/api/reference-dance-cleanup'), true);
  assert.notEqual(
    vercel.crons.find((item) => item.path === '/api/reference-dance-cleanup').schedule,
    vercel.crons.find((item) => item.path === '/api/reference-audio-cleanup').schedule
  );
});

test('admin BETA UI keeps the browser on asset IDs and requires rights confirmation', () => {
  const ui = read('generate-prod.html');
  assert.match(ui, /id="danceRights" type="checkbox"/);
  assert.match(ui, /rightsConfirmed:true/);
  assert.match(ui, /body\.reference_video_asset_id=referenceDanceAsset\.id/);
  assert.doesNotMatch(ui, /body\.reference_videos=/);
  assert.match(ui, /blockedByDance/);
  assert.match(ui, /referenceDanceAsset\?\.status==='ready'/);
});

test('a reference video already bound to generation cannot be manually deleted', () => {
  const deletion = read('api/reference-dance-delete.js');
  assert.match(deletion, /review_paths,last_task_id/);
  assert.match(deletion, /row\.last_task_id \|\| row\.status === 'checking'/);
  assert.match(deletion, /deleted: false, retained: true/);
});

test('cleanup derives every deterministic output path after a partial inspection', () => {
  const cleanup = read('api/reference-dance-cleanup.js');
  const deletion = read('api/reference-dance-delete.js');
  for (const source of [cleanup, deletion]) {
    assert.match(source, /approvedPath\(/);
    assert.match(source, /index <= 5/);
    assert.match(source, /reviewFramePath\(/);
  }
});
