'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { performance } = require('node:perf_hooks');

// This is an acknowledgement limit, not a media-output limit. Private download
// callers can select their existing media limit explicitly.
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;

class WorkerStorageError extends Error {
  constructor(code) {
    super(code);
    this.publicCode = code;
  }
}

function swallow(promise) {
  Promise.resolve(promise).catch(() => {});
}

function stopBody(body) {
  if (!body) return;
  try {
    if (typeof body.destroy === 'function') {
      if (typeof body.on === 'function') body.on('error', () => {});
      body.destroy();
    } else if (typeof body.cancel === 'function') {
      swallow(body.cancel());
    }
  } catch (_) {}
}

async function withStorageDeadline({
  createClient,
  fetchImpl,
  supabaseUrl,
  key,
  timeoutMs = 60000,
  operation,
  maxResponseBytes = DEFAULT_RESPONSE_BYTES
}) {
  const failed = () => new WorkerStorageError('STORAGE_FAILED');
  let origin;
  try {
    const config = new URL(supabaseUrl);
    if (config.protocol !== 'https:' || config.username || config.password || config.search || config.hash) throw failed();
    origin = config.origin;
  } catch (_) {
    throw failed();
  }
  if (typeof createClient !== 'function' || typeof fetchImpl !== 'function' || typeof operation !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw failed();

  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const timeoutError = new WorkerStorageError('STORAGE_TIMEOUT');
  const bodies = new Set();
  const readers = new Set();
  const cleanupCallbacks = new Set();
  let finished = false;
  let stoppedError;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });

  function cleanup() {
    if (!controller.signal.aborted) controller.abort();
    // Own the web reader so even a locked response body can be cancelled.
    for (const reader of readers) {
      try { swallow(reader.cancel()); } catch (_) {}
    }
    for (const body of bodies) stopBody(body);
    for (const callback of cleanupCallbacks) {
      try { swallow(callback()); } catch (_) {}
    }
  }

  function fail(error) {
    if (finished || stoppedError) return;
    stoppedError = error instanceof WorkerStorageError ? error : failed();
    cleanup();
    rejectStopped(stoppedError);
  }

  function checkActive() {
    if (stoppedError) throw stoppedError;
    if (finished) throw failed();
    if (performance.now() >= deadlineAt) {
      fail(timeoutError);
      throw timeoutError;
    }
  }

  function trackBody(body) {
    if (!body || bodies.has(body)) return;
    bodies.add(body);
    if (typeof body.on === 'function') body.on('error', () => {});
    if (finished || stoppedError) stopBody(body);
  }

  const timer = setTimeout(() => fail(timeoutError), timeoutMs);

  async function readBytes(body) {
    checkActive();
    if (!body) return Buffer.alloc(0);
    const chunks = [];
    let bytes = 0;
    const append = (chunk) => {
      checkActive();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > maxResponseBytes - bytes) throw failed();
      bytes += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    };
    // node-fetch Response fixtures may contain a Buffer rather than a stream.
    if (body instanceof Uint8Array) {
      append(body);
    } else if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      readers.add(reader);
      let complete = false;
      try {
        while (true) {
          const result = await reader.read();
          checkActive();
          if (result.done) break;
          append(result.value);
        }
        complete = true;
      } finally {
        if (!complete) {
          try { swallow(reader.cancel()); } catch (_) {}
        }
        readers.delete(reader);
        try { reader.releaseLock(); } catch (_) {}
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) append(chunk);
    } else {
      throw failed();
    }
    checkActive();
    return Buffer.concat(chunks, bytes);
  }

  async function boundedFetch(input, init = {}) {
    checkActive();
    // Never transmit the service credential outside the configured HTTPS origin.
    // redirect:'error' stops node-fetch/native fetch before a redirect is followed.
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.origin !== origin || target.protocol !== 'https:' || target.username || target.password) throw failed();
    trackBody(init.body);
    const signal = init.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    const response = await fetchImpl(input, { ...init, signal, redirect: 'error' });
    const body = response && response.body;
    trackBody(body);
    // Late fetch settlements still release their bodies after the caller returns.
    if (finished || stoppedError || performance.now() >= deadlineAt) {
      stopBody(body);
      checkActive();
    }
    if (!response || typeof response !== 'object' || response.redirected
      || (response.status >= 300 && response.status < 400)) throw failed();
    let consumed = false;
    const consume = async (kind) => {
      checkActive();
      if (consumed) throw failed();
      consumed = true;
      const bytes = await readBytes(body);
      checkActive();
      if (kind === 'arrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (kind === 'blob') return new Blob([bytes], { type: response.headers?.get('content-type') || '' });
      const text = new TextDecoder().decode(bytes);
      return kind === 'json' ? JSON.parse(text) : text;
    };
    // Preserve Response branding/getters for the installed SDK and node-fetch,
    // but keep every SDK body-consumption method under cancellation ownership.
    return new Proxy(response, {
      get(target, property) {
        if (['json', 'blob', 'arrayBuffer', 'text'].includes(property)) return () => consume(property);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  const pending = Promise.resolve().then(async () => {
    checkActive();
    const client = createClient(supabaseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch }
    });
    checkActive();
    // The optional second argument is used internally by uploadStorageFile for
    // descriptor ownership. Existing SDK callers need only operation(client).
    const result = await operation(client, {
      checkActive, fail, trackBody,
      onCleanup(callback) {
        cleanupCallbacks.add(callback);
        if (finished || stoppedError) {
          try { swallow(callback()); } catch (_) {}
        }
      }
    });
    checkActive();
    return result;
  });

  try {
    // A watchdog bounds even a broken SDK/transport; fail() also aborts the
    // actual custom fetch, body readers, source streams and descriptor owners.
    return await Promise.race([pending, stopped]);
  } catch (error) {
    if (!stoppedError && performance.now() >= deadlineAt) fail(timeoutError);
    if (stoppedError) throw stoppedError;
    if (error instanceof WorkerStorageError) throw error;
    throw failed();
  } finally {
    finished = true;
    clearTimeout(timer);
    cleanup();
  }
}

async function uploadStorageFile({
  createClient,
  fetchImpl,
  supabaseUrl,
  key,
  bucket,
  objectPath,
  filePath,
  contentType = 'video/mp4',
  upsert = false,
  timeoutMs = 60000
}) {
  try {
    return await withStorageDeadline({ createClient, fetchImpl, supabaseUrl, key, timeoutMs,
      operation: async (client, lifecycle) => {
        const { checkActive, fail, trackBody } = lifecycle;
        let handle;
        let closePromise;
        const closeHandle = () => {
          if (!handle) return Promise.resolve();
          if (!closePromise) {
            try { closePromise = Promise.resolve(handle.close()); }
            catch (_) { closePromise = Promise.reject(new WorkerStorageError('UPLOAD_FAILED')); }
            swallow(closePromise);
          }
          return closePromise;
        };
        lifecycle.onCleanup(closeHandle);
        // O_NONBLOCK prevents FIFO/device opens from hanging before fstat.
        // The descriptor, not a separate path stat, owns the size snapshot.
        handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
        try { checkActive(); } catch (error) { swallow(closeHandle()); throw error; }
        const stat = await handle.stat();
        checkActive();
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) {
          throw new WorkerStorageError('UPLOAD_SOURCE_INVALID');
        }
        const source = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
        trackBody(source);
        let sourceEnded = false;
        const sourceComplete = new Promise((resolve, reject) => {
          source.on('error', () => {
            const error = new WorkerStorageError('UPLOAD_FAILED');
            fail(error);
            reject(error);
          });
          source.once('end', () => {
            sourceEnded = true;
            if (source.bytesRead !== stat.size) {
              const error = new WorkerStorageError('UPLOAD_SOURCE_INVALID');
              fail(error);
              reject(error);
            } else resolve();
          });
          source.once('close', () => {
            if (!sourceEnded) {
              const error = new WorkerStorageError('UPLOAD_FAILED');
              fail(error);
              reject(error);
            }
          });
        });
        // An SDK error may arrive before the request body is consumed.
        swallow(sourceComplete);
        const storage = client.storage.from(bucket);
        const result = await storage.upload(objectPath, source, {
          contentType, upsert, duplex: 'half', headers: { 'content-length': String(stat.size) }
        });
        checkActive();
        if (!result || result.error) throw new WorkerStorageError('UPLOAD_FAILED');
        await sourceComplete;
        checkActive();
        // A response before the complete initial byte range is not success.
        await closeHandle();
        checkActive();
        const urlResult = storage.getPublicUrl(objectPath);
        checkActive();
        if (!urlResult || urlResult.error || !urlResult.data
          || typeof urlResult.data.publicUrl !== 'string' || !urlResult.data.publicUrl) {
          throw new WorkerStorageError('UPLOAD_FAILED');
        }
        return { publicUrl: urlResult.data.publicUrl };
      }
    });
  } catch (error) {
    if (error instanceof WorkerStorageError && error.publicCode === 'STORAGE_TIMEOUT') {
      throw new WorkerStorageError('UPLOAD_TIMEOUT');
    }
    if (error instanceof WorkerStorageError && error.publicCode === 'UPLOAD_SOURCE_INVALID') throw error;
    throw new WorkerStorageError('UPLOAD_FAILED');
  }
  // No retry, local deletion or remote deletion: a timeout can follow a write
  // that already succeeded remotely. The caller retains its existing policy.
}

module.exports = { uploadStorageFile, withStorageDeadline };
