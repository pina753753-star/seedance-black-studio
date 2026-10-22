'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

function probeError(code) {
  // Never propagate paths, media metadata, stderr, or native error messages.
  return Object.assign(new Error(code), { publicCode: code });
}

// Only process lifecycle and JSON decoding belong here. Each route retains its
// own stream, container, dimension and duration validation after probing.
async function probeVideoFile(options = {}) {
  const { filePath, timeoutMs = 15000, execFileImpl = execFile } = options || {};
  if (typeof timeoutMs === 'number' && timeoutMs <= 0) throw probeError('PROBE_TIMEOUT');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2147483647
      || typeof execFileImpl !== 'function'
      || typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || filePath.startsWith('//') || /[\u0000\r\n]/.test(filePath)) {
    throw probeError('PROBE_FAILED');
  }

  return new Promise((resolve, reject) => {
    const deadlineAt = performance.now() + timeoutMs;
    let child;
    let settled = false;
    let timedOut = false;
    let killRequested = false;
    let timer;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const killChild = () => {
      if (!child || killRequested) return;
      killRequested = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    };
    const expire = () => {
      if (settled) return;
      // Settle before killing: a test adapter (or error listener) may invoke
      // the callback synchronously from kill(). It must not win this race.
      timedOut = true;
      finish(probeError('PROBE_TIMEOUT'));
      killChild();
    };
    timer = setTimeout(expire, timeoutMs);

    try {
      child = execFileImpl('ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_format', '-show_streams', '-of', 'json', filePath
      ], {
        // Native timeout is a second process-lifetime bound. The owned timer
        // also settles a missing callback; maxBuffer kills on excess output.
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        shell: false,
        windowsHide: true
      }, (error, stdout) => {
        if (settled) return;
        if (performance.now() >= deadlineAt) return expire();
        // `killed` also covers maxBuffer and other failures, not just timeout.
        if (error) return finish(probeError('PROBE_FAILED'));
        try {
          if ((typeof stdout !== 'string' && !Buffer.isBuffer(stdout))
              || Buffer.byteLength(stdout) > PROBE_MAX_BUFFER_BYTES) {
            return finish(probeError('PROBE_FAILED'));
          }
          const data = JSON.parse(stdout);
          if (performance.now() >= deadlineAt) return expire();
          finish(null, data);
        } catch (_) {
          finish(probeError('PROBE_FAILED'));
        }
      });
      // An injected implementation can complete synchronously before it
      // returns the handle. Do not lose a timeout's termination in that case.
      if (timedOut) killChild();
    } catch (_) {
      finish(probeError('PROBE_FAILED'));
    }
  });
}

module.exports = { probeVideoFile };
