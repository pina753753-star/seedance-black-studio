'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_REFERENCE_DANCE_BYTES,
  isPermanentReferenceDanceInspectionError,
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
const {
  validateReferenceDanceProbe,
  validateReferenceDanceDurationMatch
} = require('../watermark-server/reference-dance-inspection.js');

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

test('official 720p Motion Control provider pricing remains exact', () => {
  assert.equal(providerCostCents(4), 176);
  assert.equal(providerCostCents(5), 220);
  assert.equal(providerCostCents(15), 660);
  assert.throws(() => providerCostCents(3));
});

test('Motion Control credits preserve existing provider-cost ratio', () => {
  assert.equal(referenceDanceCredits(4), 165);
  assert.equal(referenceDanceCredits(5), 205);
  assert.equal(referenceDanceCredits(15), 605);
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
  assert.equal(calculateVideoCreditCost(trusted), 605);
  assert.throws(() => calculateVideoCreditCost({ ...trusted, resolution: '1080p' }));
});

test('WaveSpeed Motion Control receives only a server-signed video and identity images', () => {
  const start = read('api/_lib/seedance-start.js');
  const providerPrompt = buildReferenceDanceProviderPrompt('踊る');
  assert.match(start, /createSignedUrl\(referenceDance\.approvedPath/);
  assert.match(start, /video: String\(referenceVideoUrl \|\| ''\)\.trim\(\)/);
  assert.match(start, /reference_images: collectWaveSpeedReferenceImageUrls/);
  assert.match(start, /generate_audio: false/);
  assert.match(start, /bytedance\/seedance-2\.5\/motion-control/);
  assert.match(providerPrompt, /@Image 1/);
  assert.match(providerPrompt, /@Video 1/);
  assert.match(providerPrompt, /do not convert it to slow motion/i);
});

test('closed beta accepts only Turbo reference mode and 720p', () => {
  assert.equal(validateReferenceDanceVariant({ model: 'bytedance/seedance-2.5', mode: 'reference_to_video', resolution: '720p' }), true);
  for (const input of [
    { model: 'bytedance/seedance-2.5-standard', mode: 'reference_to_video', resolution: '720p', outputSeconds: 5 },
    { model: 'bytedance/seedance-2.5', mode: 'image_to_video', resolution: '720p', outputSeconds: 5 },
    { model: 'bytedance/seedance-2.5', mode: 'reference_to_video', resolution: '1080p', outputSeconds: 5 }
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
  assert.match(sql, /set search_path = public, pg_temp/i);
  assert.match(sql, /expires_at = greatest\(expires_at, now\(\) \+ interval '1 hour'\)/i);
  assert.match(sql, /billable_seconds = greatest\(2, ceil\(duration_ms \/ 1000\.0\)::integer\)/i);
  assert.match(sql, /seedance_reference_video_ready_complete_check/i);
  assert.match(sql, /grant execute on function public\.claim_seedance_reference_video_inspection\(uuid, uuid\)[\s\S]*?to service_role/i);
});

test('approved probe is the billing authority and rejects remaining audio', () => {
  const baseProbe = {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.001' },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, r_frame_rate: '30000/1001' }]
  };
  assert.deepEqual(validateReferenceDanceProbe(baseProbe, { requireNoAudio: true }), {
    durationSeconds: 5.001,
    durationMs: 5001,
    width: 720,
    height: 1280,
    fps: 30000 / 1001,
    videoCodec: 'h264'
  });
  assert.throws(
    () => validateReferenceDanceProbe({ ...baseProbe, streams: [...baseProbe.streams, { codec_type: 'audio', codec_name: 'aac' }] }, { requireNoAudio: true }),
    { publicCode: 'VIDEO_AUDIO_STRIP_FAILED' }
  );
  assert.throws(
    () => validateReferenceDanceProbe({ ...baseProbe, format: { ...baseProbe.format, duration: '15.001' } }, { requireNoAudio: true }),
    { publicCode: 'VIDEO_DURATION_INVALID' }
  );
  assert.equal(validateReferenceDanceDurationMatch({ durationMs: 5000 }, { durationMs: 5200 }), true);
  assert.throws(
    () => validateReferenceDanceDurationMatch({ durationMs: 5000 }, { durationMs: 5500 }),
    { publicCode: 'VIDEO_DURATION_MISMATCH' }
  );
});

test('Railway inspection fails closed, re-probes the sealed file and samples it', () => {
  const source = read('watermark-server/server.js');
  const validator = read('watermark-server/reference-dance-inspection.js');
  const dockerfile = read('watermark-server/Dockerfile');
  assert.match(source, /app\.post\('\/reference-dance-inspect'/);
  assert.match(source, /if \(!WATERMARK_SECRET\) return res\.status\(503\)/);
  assert.match(source, /'-an'/);
  assert.match(source, /'-t', String\(REFERENCE_DANCE_MAX_SECONDS\)/);
  assert.match(source, /approvedProbe = await referenceDanceProbe\(approvedFile/);
  assert.match(source, /validateReferenceDanceProbe\(approvedProbe, \{ requireNoAudio: true \}\)/);
  assert.match(source, /ffmpeg\(approvedFile\)[\s\S]*?\.seekInput\(positions\[i\]\)/);
  assert.match(source, /Array\.from\(\{ length: 5 \}/);
  assert.match(validator, /codec_name[\s\S]*?'h264'/);
  assert.match(source, /REFERENCE_DANCE_MAX_SECONDS = 15/);
  assert.match(source, /crypto\.createHash\('sha256'\)/);
  assert.match(source, /processingDeadline = Date\.now\(\) \+ REFERENCE_DANCE_PROCESS_TIMEOUT_MS/);
  assert.match(source, /referenceDanceRemainingMs\(processingDeadline\)/);
  assert.match(source, /storageBlobBuffer\(storage, stagingPath, processingDeadline\)/);
  const localRequires = [...source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].map((match) => match[1]);
  for (const requiredFile of localRequires) {
    assert.equal(
      dockerfile.includes('COPY *.js ./') || dockerfile.split(/\r?\n/).some((line) => line.startsWith('COPY ') && line.split(/\s+/).includes(requiredFile)),
      true,
      `Dockerfile must copy ${requiredFile}`
    );
  }
});

test('permanent inspection failures are separated from retryable failures', () => {
  for (const code of ['VIDEO_CODEC_UNSUPPORTED', 'VIDEO_DURATION_INVALID', 'VIDEO_DURATION_MISMATCH', 'VIDEO_AUDIO_STRIP_FAILED']) {
    assert.equal(isPermanentReferenceDanceInspectionError(code), true);
  }
  for (const code of ['VIDEO_CHECK_TIMEOUT', 'APPROVED_UPLOAD_FAILED', 'HTTP_503']) {
    assert.equal(isPermanentReferenceDanceInspectionError(code), false);
  }
  const confirm = read('api/reference-dance-confirm-upload.js');
  assert.match(confirm, /await removeObjects\(auth\.supabase, paths\)/);
  assert.match(confirm, /status: 'failed'/);
  assert.match(confirm, /return res\.status\(422\)/);
});

test('cleanup cron is registered and reference assets are isolated from audio cleanup', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.functions['api/reference-dance-confirm-upload.js'].maxDuration, 300);
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

test('any generation binding keeps its asset until bounded expiry cleanup', () => {
  const deletion = read('api/reference-dance-delete.js');
  assert.match(deletion, /review_paths,last_task_id/);
  assert.match(deletion, /row\.last_task_id \|\| row\.status === 'checking'/);
  assert.match(deletion, /deleted: false, retained: true/);
});

test('failed attempts cannot extend reference-video retention forever', () => {
  const start = read('api/_lib/seedance-start.js');
  assert.match(start, /REFERENCE_DANCE_MAX_RETENTION_FROM_CREATION_MS = 72 \* 60 \* 60 \* 1000/);
  assert.match(start, /REFERENCE_DANCE_START_MARGIN_MS = \(REFERENCE_DANCE_SIGNED_URL_TTL_SECONDS \+ 10 \* 60\) \* 1000/);
  assert.match(start, /maxRetentionMs - Date\.now\(\) < REFERENCE_DANCE_START_MARGIN_MS/);
  assert.match(start, /Math\.min\([\s\S]*?Date\.now\(\) \+ REFERENCE_DANCE_RETENTION_MS,[\s\S]*?maxRetentionMs/);
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
