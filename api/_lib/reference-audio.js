'use strict';

const REFERENCE_AUDIO_BUCKET = 'seedance-reference-audio';
const REFERENCE_AUDIO_PREFIX = 'users';
const MAX_REFERENCE_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_FILES = 1;
const REFERENCE_AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60;
const REFERENCE_AUDIO_RETENTION_MS = 24 * 60 * 60 * 1000;
const REFERENCE_AUDIO_REGISTRY_TABLE = 'seedance_reference_audio_uploads';

function normalizeReferenceAudioPaths(value, userId) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  if (values.length > MAX_REFERENCE_AUDIO_FILES) {
    return { ok: false, error: 'reference_audio_limit', message: '参照音源は1曲まで添付できます。' };
  }

  const prefix = `${REFERENCE_AUDIO_PREFIX}/${userId}/`;
  const paths = [];
  for (const raw of values) {
    const path = String(raw || '').trim();
    if (!path || !path.startsWith(prefix) || path.includes('..') || !/\.mp3$/i.test(path)) {
      return { ok: false, error: 'invalid_reference_audio', message: '参照音源を確認できませんでした。もう一度添付してください。' };
    }
    paths.push(path);
  }
  return { ok: true, paths: [...new Set(paths)] };
}

function isMp3Header(bytes) {
  if (!bytes || bytes.length < 3) return false;
  const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const hasMpegFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return hasId3 || hasMpegFrameSync;
}

async function createReferenceAudioSignedUrls(db, paths) {
  const urls = [];
  for (const path of paths) {
    const bucket = db.storage.from(REFERENCE_AUDIO_BUCKET);
    const { data: blob, error: downloadError } = await bucket.download(path);
    if (downloadError || !blob || blob.size <= 0 || blob.size > MAX_REFERENCE_AUDIO_BYTES) {
      return { ok: false, error: 'reference_audio_unavailable', message: '参照音源を確認できませんでした。もう一度添付してください。' };
    }
    const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    if (!isMp3Header(header)) {
      return { ok: false, error: 'invalid_reference_audio_content', message: 'MP3形式の音源を選択してください。' };
    }
    const { data, error } = await bucket.createSignedUrl(path, REFERENCE_AUDIO_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return {
        ok: false,
        error: 'reference_audio_unavailable',
        message: '参照音源を読み込めませんでした。もう一度添付してください。'
      };
    }
    urls.push(data.signedUrl);
  }
  return { ok: true, urls };
}

module.exports = {
  REFERENCE_AUDIO_BUCKET,
  MAX_REFERENCE_AUDIO_BYTES,
  REFERENCE_AUDIO_RETENTION_MS,
  REFERENCE_AUDIO_REGISTRY_TABLE,
  normalizeReferenceAudioPaths,
  isMp3Header,
  createReferenceAudioSignedUrls
};
