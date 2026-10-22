'use strict';

const fs = require('node:fs/promises');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { performance } = require('node:perf_hooks');

class WatermarkDownloadError extends Error {
  constructor(code) {
    // Never expose request URLs, upstream response bodies, or native errors.
    super(code);
    this.publicCode = code;
  }
}

function parseSupabaseUrl(raw) {
  if (typeof raw !== 'string' || /[\\\u0000-\u0020\u007f#]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname;
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return null;
    if (!host.endsWith('.supabase.co') || host === '.supabase.co') return null;
    if (!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    // Reject noncanonical authorities (userinfo, escaped hosts, trailing dots,
    // odd port spelling), rather than trusting URL parser normalization.
    const authority = parts[1].toLowerCase();
    if (authority !== host && authority !== `${host}:443`) return null;
    return { parsed, rawPath: parts[2] };
  } catch (_) {
    return null;
  }
}

function isAllowedWatermarkUrl(raw, supabaseUrl) {
  const source = parseSupabaseUrl(raw);
  const config = parseSupabaseUrl(supabaseUrl);
  if (!source || !config || source.parsed.hostname !== config.parsed.hostname) return false;

  const prefix = '/storage/v1/object/public/';
  if (!source.rawPath.startsWith(prefix)) return false;
  const segments = source.rawPath.slice(prefix.length).split('/');
  if (segments.length < 2) return false;
  // Keep all configured/legacy public buckets, but do not allow route changes
  // through empty segments, traversal or encoded separators. Ordinary encoded
  // spaces, Unicode and literal percent signs remain valid object names.
  return segments.every((segment) => {
    try {
      let decoded = decodeURIComponent(segment);
      // Bound normalization work even for adversarially deep escapes.
      for (let depth = 0; depth < 8; depth++) {
        if (!decoded || decoded === '.' || decoded === '..' || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) return false;
        // Check nested escapes only for dangerous path meanings, not merely
        // for the presence of a legitimate, percent-containing object name.
        const next = decoded.replace(/%([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        if (next === decoded) return true;
        decoded = next;
      }
      return false;
    } catch (_) {
      return false;
    }
  });
}

function destroyQuietly(stream) {
  if (!stream || typeof stream.destroy !== 'function') return;
  // A rejected response may not have reached pipeline yet. Its destruction
  // must not emit an unhandled error, including when fetch resolves late.
  if (typeof stream.on === 'function') stream.on('error', () => {});
  try { stream.destroy(); } catch (_) {}
}

async function downloadWatermarkVideo({
  url,
  supabaseUrl,
  filePath,
  fetchImpl,
  maxBytes = 200 * 1024 * 1024,
  timeoutMs = 60000
}) {
  if (!isAllowedWatermarkUrl(url, supabaseUrl)) throw new WatermarkDownloadError('URL_INVALID');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new WatermarkDownloadError('DOWNLOAD_FAILED');
  }

  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const timeoutError = new WatermarkDownloadError('DOWNLOAD_TIMEOUT');
  let timedOut = false;
  let finished = false;
  let succeeded = false;
  let created = false;
  let handle;
  let body;
  let counter;
  let destination;
  let bytes = 0;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const stopStreams = () => {
    destroyQuietly(body);
    destroyQuietly(counter);
    destroyQuietly(destination);
  };
  const expire = () => {
    if (timedOut) return;
    timedOut = true;
    controller.abort();
    stopStreams();
    rejectDeadline(timeoutError);
  };
  const checkDeadline = () => {
    if (timedOut || performance.now() >= deadlineAt) {
      expire();
      throw timeoutError;
    }
  };
  const timer = setTimeout(expire, timeoutMs);

  try {
    const pendingResponse = Promise.resolve().then(() => fetchImpl(url, {
      redirect: 'manual',
      compress: false,
      headers: { 'accept-encoding': 'identity' },
      signal: controller.signal
    })).then((response) => {
      // A network body can fail while the exclusive file is being opened,
      // before pipeline has attached its own error handler.
      if (response && response.body && typeof response.body.on === 'function') {
        response.body.on('error', () => {});
      }
      if (timedOut || finished) destroyQuietly(response && response.body);
      return response;
    });
    const response = await Promise.race([pendingResponse, deadline]);
    body = response && response.body;
    checkDeadline();
    // Explicitly reject every 3xx, regardless of an upstream/mock `ok` flag.
    if (!response || !Number.isInteger(response.status) || response.status < 200
      || response.status >= 300 || response.ok === false) {
      throw new WatermarkDownloadError('DOWNLOAD_FAILED');
    }

    const encoding = (response.headers.get('content-encoding') || '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') throw new WatermarkDownloadError('VIDEO_CONTENT_ENCODING_INVALID');
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/octet-stream' && !/^video\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) {
      throw new WatermarkDownloadError('VIDEO_CONTENT_TYPE_INVALID');
    }
    const length = (response.headers.get('content-length') || '').trim();
    if (/^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) {
      throw new WatermarkDownloadError('DOWNLOAD_TOO_LARGE');
    }
    if (!body) throw new WatermarkDownloadError('VIDEO_EMPTY');
    if (typeof body.pipe !== 'function' || typeof body.destroy !== 'function') {
      throw new WatermarkDownloadError('DOWNLOAD_FAILED');
    }

    // Create atomically. Never overwrite or remove a preexisting destination.
    handle = await fs.open(filePath, 'wx', 0o600);
    created = true;
    checkDeadline();
    destination = handle.createWriteStream();
    counter = new Transform({
      transform(chunk, _, callback) {
        try {
          checkDeadline();
          if (chunk.length > maxBytes - bytes) {
            callback(new WatermarkDownloadError('DOWNLOAD_TOO_LARGE'));
            return;
          }
          bytes += chunk.length;
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      }
    });
    await Promise.race([pipeline(body, counter, destination), deadline]);
    checkDeadline();
    if (bytes === 0) throw new WatermarkDownloadError('VIDEO_EMPTY');
    succeeded = true;
    return bytes;
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (error instanceof WatermarkDownloadError) throw error;
    throw new WatermarkDownloadError('DOWNLOAD_FAILED');
  } finally {
    finished = true;
    clearTimeout(timer);
    if (!succeeded) {
      controller.abort();
      stopStreams();
    }
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
    if (created && !succeeded) {
      try { await fs.unlink(filePath); } catch (error) {
        if (error.code !== 'ENOENT') throw new WatermarkDownloadError('DOWNLOAD_FAILED');
      }
    }
  }
}

module.exports = { isAllowedWatermarkUrl, downloadWatermarkVideo };
