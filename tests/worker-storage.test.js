'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const { uploadStorageFile, withStorageDeadline } = require('../watermark-server/worker-storage.js');

const SUPABASE_URL = 'https://unit-test.supabase.co';
const KEY = 'unit-test-key-never-a-real-secret';
const PUBLIC_URL = `${SUPABASE_URL}/storage/v1/object/public/test-bucket/nested/output.mp4`;

function safeCode(expected) {
  return (error) => {
    assert.equal(error.publicCode, expected);
    assert.equal(error.message, expected);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(KEY));
    return true;
  };
}

function jsonResponse(data = { Id: 'synthetic', Key: 'test-bucket/nested/output.mp4' }, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function drain(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function mockClient(state, overrides = {}) {
  return (url, key, options) => {
    Object.assign(state, { url, key, clientOptions: options });
    const storage = {
      async upload(objectPath, source, uploadOptions) {
        Object.assign(state, { objectPath, source, uploadOptions });
        state.uploadCalls = (state.uploadCalls || 0) + 1;
        if (overrides.upload) return overrides.upload(source, options.global.fetch, state);
        try {
          const response = await options.global.fetch(`${url}/storage/v1/object/${state.bucket}/${objectPath}`, {
            method: 'POST', body: source, headers: uploadOptions.headers, duplex: uploadOptions.duplex
          });
          const data = await response.json();
          return response.ok ? { data, error: null } : { data: null, error: data };
        } catch (error) {
          return { data: null, error };
        }
      },
      getPublicUrl(objectPath) {
        state.publicUrlCalls = (state.publicUrlCalls || 0) + 1;
        state.publicUrlPath = objectPath;
        if (overrides.getPublicUrl) return overrides.getPublicUrl();
        return { data: { publicUrl: PUBLIC_URL } };
      },
      remove() { state.removeCalls = (state.removeCalls || 0) + 1; throw Error('Must never remove'); }
    };
    if (overrides.create) overrides.create();
    return {
      storage: {
        from(bucket) {
          state.bucket = bucket;
          if (overrides.from) overrides.from();
          return storage;
        }
      }
    };
  };
}

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-storage-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'output.mp4');
  await fs.writeFile(filePath, 'synthetic-video');
  const state = {};
  return {
    dir, filePath, state,
    async upload(options = {}) {
      return uploadStorageFile({
        createClient: mockClient(state, overrides),
        fetchImpl: async (_url, init) => {
          state.signal = init.signal;
          state.bytes = await drain(init.body);
          return jsonResponse();
        },
        supabaseUrl: SUPABASE_URL,
        key: KEY,
        bucket: 'test-bucket',
        objectPath: 'nested/output.mp4',
        filePath,
        timeoutMs: 1000,
        ...options
      });
    }
  };
}

async function closed(source) {
  if (!source) return;
  for (let i = 0; i < 50 && !source.closed; i++) await delay(2);
  assert.equal(source.destroyed, true, 'source destroyed');
  assert.equal(source.closed, true, 'source descriptor closed');
}

test('streams the final media with unchanged bucket/path/upsert and closes the source', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.upload(), { publicUrl: PUBLIC_URL });
  assert.equal(f.state.bytes.toString(), 'synthetic-video');
  assert.equal(f.state.bucket, 'test-bucket');
  assert.equal(f.state.objectPath, 'nested/output.mp4');
  assert.equal(f.state.publicUrlPath, 'nested/output.mp4');
  assert.equal(f.state.uploadOptions.contentType, 'video/mp4');
  assert.equal(f.state.uploadOptions.upsert, false);
  assert.equal(f.state.uploadOptions.duplex, 'half');
  assert.equal(f.state.uploadOptions.headers['content-length'], '15');
  assert.equal(Buffer.isBuffer(f.state.source), false);
  assert.deepEqual(f.state.clientOptions.auth, {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false
  });
  assert.equal(f.state.uploadCalls, 1);
  assert.equal(f.state.removeCalls, undefined);
  await closed(f.state.source);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'synthetic-video', 'does not remove local output');
});

test('preserves explicit contentType/upsert and caller-selected paths', async (t) => {
  const f = await fixture(t);
  await f.upload({ bucket: 'other-bucket', objectPath: 'edited/user/id.mp4', contentType: 'video/webm', upsert: true });
  assert.equal(f.state.bucket, 'other-bucket');
  assert.equal(f.state.objectPath, 'edited/user/id.mp4');
  assert.equal(f.state.uploadOptions.contentType, 'video/webm');
  assert.equal(f.state.uploadOptions.upsert, true);
});

test('does not impose the watermark output-size cap on edit uploads', async (t) => {
  const f = await fixture(t);
  const initialSize = 200 * 1024 * 1024 + 1;
  await fs.truncate(f.filePath, initialSize);
  let bytes = 0;
  await f.upload({ timeoutMs: 10000, fetchImpl: async (_url, init) => {
    for await (const chunk of init.body) {
      bytes += chunk.length;
      assert.ok(chunk.length <= 64 * 1024, 'bounded streaming memory');
    }
    return jsonResponse();
  } });
  assert.equal(bytes, initialSize);
  assert.equal(f.state.uploadOptions.headers['content-length'], String(initialSize));
  await closed(f.state.source);
});

test('never reads bytes appended after the descriptor size snapshot', async (t) => {
  let filePath;
  const f = await fixture(t, { from() { fsSync.appendFileSync(filePath, '-unexpected-growth'); } });
  filePath = f.filePath;
  await f.upload();
  assert.equal(f.state.bytes.toString(), 'synthetic-video');
  assert.equal(f.state.source.bytesRead, 15);
  assert.equal((await fs.stat(filePath)).size, 33);
});

test('rejects a truncated source even if the transport claims upload success', async (t) => {
  let filePath;
  const f = await fixture(t, { from() { fsSync.truncateSync(filePath, 3); } });
  filePath = f.filePath;
  await assert.rejects(f.upload(), safeCode('UPLOAD_SOURCE_INVALID'));
  assert.equal(f.state.signal.aborted, true);
  assert.equal(f.state.publicUrlCalls, undefined);
  await closed(f.state.source);
});

for (const kind of ['empty', 'directory', 'device', 'missing']) {
  test(`rejects ${kind} source without a transport request`, async (t) => {
    const f = await fixture(t);
    let filePath = f.filePath;
    if (kind === 'empty') await fs.truncate(filePath, 0);
    if (kind === 'directory') filePath = f.dir;
    if (kind === 'device') {
      if (process.platform === 'win32') return t.skip('Unix device test');
      filePath = '/dev/null';
    }
    if (kind === 'missing') await fs.unlink(filePath);
    await assert.rejects(f.upload({ filePath }), safeCode(kind === 'missing' ? 'UPLOAD_FAILED' : 'UPLOAD_SOURCE_INVALID'));
    assert.equal(f.state.uploadCalls, undefined);
  });
}

test('rejects a FIFO without blocking its open or contacting Storage', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix FIFO test');
  const f = await fixture(t);
  const fifo = path.join(f.dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(f.upload({ filePath: fifo, timeoutMs: 100 }), safeCode('UPLOAD_SOURCE_INVALID'));
  assert.equal(f.state.uploadCalls, undefined);
});

for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2147483648, '100']) {
  test(`rejects invalid timeout ${String(timeoutMs)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.upload({ timeoutMs }), safeCode('UPLOAD_FAILED'));
    assert.equal(f.state.uploadCalls, undefined);
  });
}

test('header stall aborts the actual SDK custom-fetch signal and destroys the source', async (t) => {
  const f = await fixture(t);
  let signal;
  let aborted = false;
  await assert.rejects(f.upload({ timeoutMs: 30, fetchImpl: async (_url, init) => {
    signal = init.signal;
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } }), safeCode('UPLOAD_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(aborted, true);
  assert.equal(f.state.uploadCalls, 1);
  assert.equal(f.state.removeCalls, undefined);
  await closed(f.state.source);
});

test('cancels a web response reader while the successful JSON body stalls', async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  let signal;
  await assert.rejects(f.upload({ timeoutMs: 40, fetchImpl: async (_url, init) => {
    signal = init.signal;
    await drain(init.body);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"Id":')); },
      cancel() { cancelled = true; }
    }));
  } }), safeCode('UPLOAD_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true, 'reader cancelled despite locked web body and abort-ignoring transport');
  await closed(f.state.source);
});

test('destroys a Node response stream while the error JSON body stalls', async (t) => {
  const f = await fixture(t);
  const body = new Readable({ read() {} });
  let signal;
  await assert.rejects(f.upload({ timeoutMs: 40, fetchImpl: async (_url, init) => {
    signal = init.signal;
    await drain(init.body);
    return { status: 500, ok: false, body };
  } }), safeCode('UPLOAD_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(body.destroyed, true);
  await closed(f.state.source);
});

test('destroys a late Node response after the caller has already timed out', async (t) => {
  const f = await fixture(t);
  const body = new Readable({ read() {} });
  let finishFetch;
  await assert.rejects(f.upload({ timeoutMs: 20, fetchImpl: () => new Promise((resolve) => { finishFetch = resolve; }) }),
    safeCode('UPLOAD_TIMEOUT'));
  finishFetch({ status: 200, ok: true, body });
  await delay(10);
  assert.equal(body.destroyed, true);
  assert.equal(f.state.publicUrlCalls, undefined);
  await closed(f.state.source);
});

test('cancels a late web response and observes a late transport rejection', async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  let finishFetch;
  await assert.rejects(f.upload({ timeoutMs: 20, fetchImpl: () => new Promise((resolve) => { finishFetch = resolve; }) }),
    safeCode('UPLOAD_TIMEOUT'));
  finishFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(10);
  assert.equal(cancelled, true);
  const g = await fixture(t);
  let rejectFetch;
  await assert.rejects(g.upload({ timeoutMs: 20, fetchImpl: () => new Promise((_, reject) => { rejectFetch = reject; }) }),
    safeCode('UPLOAD_TIMEOUT'));
  rejectFetch(new Error(KEY));
  await delay(10);
});

for (const stage of ['create', 'from', 'upload', 'fetch', 'publicUrl', 'SDK-result']) {
  test(`maps ${stage} failure to a fixed code and cleans resources`, async (t) => {
    const throwSecret = () => { throw new Error(KEY); };
    const overrides = {};
    if (stage === 'create' || stage === 'from') overrides[stage] = throwSecret;
    if (stage === 'upload') overrides.upload = throwSecret;
    if (stage === 'publicUrl') overrides.getPublicUrl = throwSecret;
    if (stage === 'SDK-result') overrides.upload = () => ({ error: { message: KEY, publicCode: KEY } });
    const f = await fixture(t, overrides);
    const options = stage === 'fetch' ? { fetchImpl: throwSecret } : {};
    await assert.rejects(f.upload(options), safeCode('UPLOAD_FAILED'));
    await closed(f.state.source);
    assert.equal(f.state.removeCalls, undefined);
  });
}

for (const payload of ['not JSON', 'x'.repeat(1024 * 1024 + 1)]) {
  test(`rejects ${payload.length > 100 ? 'oversized' : 'malformed'} acknowledgement safely`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.upload({ fetchImpl: async (_url, init) => {
      await drain(init.body);
      return new Response(payload);
    } }), safeCode('UPLOAD_FAILED'));
    assert.equal(f.state.publicUrlCalls, undefined);
    await closed(f.state.source);
  });
}

test('a source error cancels a transport that ignores its request stream', async (t) => {
  const f = await fixture(t);
  let signal;
  await assert.rejects(f.upload({ fetchImpl: async (_url, init) => {
    signal = init.signal;
    init.body.destroy(new Error(KEY));
    return new Promise(() => {});
  } }), safeCode('UPLOAD_FAILED'));
  assert.equal(signal.aborted, true);
  await closed(f.state.source);
});

test('does not accept an acknowledgement when the SDK never consumes the source', async (t) => {
  const f = await fixture(t, { upload: () => ({ data: {}, error: null }) });
  await assert.rejects(f.upload({ timeoutMs: 25 }), safeCode('UPLOAD_TIMEOUT'));
  assert.equal(f.state.publicUrlCalls, undefined);
  await closed(f.state.source);
});

test('blocks an SDK transport invocation deferred until after timeout', async (t) => {
  let networkCalls = 0;
  const f = await fixture(t, { async upload(source, transport) {
    await delay(50);
    return transport('https://unit-test.supabase.co', { body: source });
  } });
  await assert.rejects(f.upload({ timeoutMs: 20, fetchImpl: () => { networkCalls++; return jsonResponse(); } }),
    safeCode('UPLOAD_TIMEOUT'));
  await delay(60);
  assert.equal(networkCalls, 0);
  await closed(f.state.source);
});

test('deadline checks beat synchronous completion when the event loop delays the timer', async (t) => {
  const f = await fixture(t, { getPublicUrl() {
    const until = performance.now() + 50;
    while (performance.now() < until) {}
    return { data: { publicUrl: PUBLIC_URL } };
  } });
  await assert.rejects(f.upload({ timeoutMs: 30 }), safeCode('UPLOAD_TIMEOUT'));
  await closed(f.state.source);
});

test('closes a descriptor that finishes opening after timeout', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let opened;
  fs.open = async (...args) => {
    opened = await originalOpen(...args);
    await delay(60);
    return opened;
  };
  try {
    await assert.rejects(f.upload({ timeoutMs: 20 }), safeCode('UPLOAD_TIMEOUT'));
    await delay(70);
    assert.equal(opened.fd, -1);
    assert.equal(f.state.uploadCalls, undefined);
  } finally {
    fs.open = originalOpen;
  }
});

let sdkCreateClient;
let NodeFetchResponse;
try {
  sdkCreateClient = require('@supabase/supabase-js').createClient;
  NodeFetchResponse = require('node-fetch').Response;
} catch (_) {}

for (const responseKind of ['native-web', 'node-fetch']) {
  test(`installed official SDK streams the upload with ${responseKind} response and abortable custom fetch`,
    { skip: !sdkCreateClient || !NodeFetchResponse }, async (t) => {
      const f = await fixture(t);
      let calls = 0;
      let request;
      let source;
      const result = await f.upload({ createClient: sdkCreateClient, fetchImpl: async (url, init) => {
        calls++;
        request = { url, ...init };
        source = init.body;
        assert.equal((await drain(source)).toString(), 'synthetic-video');
        const text = JSON.stringify({ Id: 'synthetic', Key: 'test-bucket/nested/output.mp4' });
        return responseKind === 'native-web' ? new Response(text) : new NodeFetchResponse(text);
      } });
      assert.equal(result.publicUrl, PUBLIC_URL);
      assert.equal(calls, 1);
      assert.equal(request.url, `${SUPABASE_URL}/storage/v1/object/test-bucket/nested/output.mp4`);
      assert.equal(request.headers.get('x-upsert'), 'false');
      assert.equal(request.headers.get('content-length'), '15');
      assert.equal(request.headers.get('content-type'), 'video/mp4');
      assert.equal(request.duplex, 'half');
      assert.ok(request.signal instanceof AbortSignal);
      await closed(source);
    });
}

for (const status of [200, 500]) {
  test(`installed official SDK ${status} response body stall is actively cancelled`,
    { skip: !sdkCreateClient }, async (t) => {
      const f = await fixture(t);
      let cancelled = false;
      let signal;
      let source;
      await assert.rejects(f.upload({ createClient: sdkCreateClient, timeoutMs: 40, fetchImpl: async (_url, init) => {
        signal = init.signal;
        source = init.body;
        await drain(source);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
      } }), safeCode('UPLOAD_TIMEOUT'));
      assert.equal(cancelled, true);
      assert.equal(signal.aborted, true);
      await closed(source);
    });
}

function withDeadline(options = {}) {
  return withStorageDeadline({
    createClient: (_url, _key, settings) => ({ fetch: settings.global.fetch }),
    fetchImpl: async () => jsonResponse(),
    supabaseUrl: SUPABASE_URL,
    key: KEY,
    operation: async (client) => (await client.fetch(`${SUPABASE_URL}/storage/v1/object/private/video.mp4`)).json(),
    timeoutMs: 1000,
    ...options
  });
}

test('shared deadline returns callback results and preserves SDK-returned errors for caller mapping', async () => {
  const sdkError = { data: null, error: { message: 'synthetic error', status: 403 } };
  assert.equal(await withDeadline({ operation: () => sdkError }), sdkError);
  await assert.rejects(withDeadline({ operation() { throw new Error(KEY); } }), safeCode('STORAGE_FAILED'));
});

for (const target of [
  'https://other.supabase.co/storage/v1/object/private/video.mp4',
  'http://unit-test.supabase.co/storage/v1/object/private/video.mp4',
  'https://unit-test.supabase.co:444/storage/v1/object/private/video.mp4',
  'https://user:password@unit-test.supabase.co/storage/v1/object/private/video.mp4',
  'https://unit-test.supabase.co.evil.example/storage/v1/object/private/video.mp4'
]) {
  test(`shared custom fetch blocks non-origin or credential-bearing URL ${target}`, async () => {
    let calls = 0;
    await assert.rejects(withDeadline({
      operation: (client) => client.fetch(target),
      fetchImpl: () => { calls++; return jsonResponse(); }
    }), safeCode('STORAGE_FAILED'));
    assert.equal(calls, 0);
  });
}

for (const config of ['http://unit-test.supabase.co', 'https://user:pass@unit-test.supabase.co', 'https://unit-test.supabase.co?key=x']) {
  test(`rejects unsafe Storage configuration ${config}`, async () => {
    await assert.rejects(withDeadline({ supabaseUrl: config }), safeCode('STORAGE_FAILED'));
  });
}

test('forbids redirects in the real fetch options and rejects even a mock 302', async () => {
  let redirect;
  await assert.rejects(withDeadline({ fetchImpl: async (_url, init) => {
    redirect = init.redirect;
    return new Response(null, { status: 302, headers: { location: 'https://other.supabase.co' } });
  } }), safeCode('STORAGE_FAILED'));
  assert.equal(redirect, 'error');
});

test('shared callback deadline covers work after headers and body consumption', async () => {
  let signal;
  await assert.rejects(withDeadline({ timeoutMs: 25, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return jsonResponse();
  }, operation: async (client) => {
    await (await client.fetch(`${SUPABASE_URL}/storage/v1/object/private/video.mp4`)).json();
    await delay(50);
    return 'late';
  } }), safeCode('STORAGE_TIMEOUT'));
  assert.equal(signal.aborted, true);
  await delay(30);
});

for (const method of ['blob', 'arrayBuffer', 'text', 'json']) {
  test(`shared ${method} body consumption is bounded and cancelled on timeout`, async () => {
    let cancelled = false;
    await assert.rejects(withDeadline({ timeoutMs: 25,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
      operation: async (client) => (await client.fetch(`${SUPABASE_URL}/storage/v1/object/private/video.mp4`))[method]()
    }), safeCode('STORAGE_TIMEOUT'));
    assert.equal(cancelled, true);
  });
}

for (const method of ['blob', 'arrayBuffer', 'text', 'json']) {
  test(`shared ${method} response limit does not depend on Content-Length`, async () => {
    let cancelled = false;
    await assert.rejects(withDeadline({ maxResponseBytes: 3,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('1234')); },
        cancel() { cancelled = true; }
      })),
      operation: async (client) => (await client.fetch(`${SUPABASE_URL}/storage/v1/object/private/video.mp4`))[method]()
    }), safeCode('STORAGE_FAILED'));
    assert.equal(cancelled, true);
  });
}

for (const responseKind of ['native-web', 'node-fetch']) {
  test(`installed official SDK private download remains private with bounded ${responseKind} Blob`,
    { skip: !sdkCreateClient || !NodeFetchResponse }, async () => {
      let request;
      const result = await withDeadline({
        createClient: sdkCreateClient,
        maxResponseBytes: 50 * 1024 * 1024,
        fetchImpl: async (url, init) => {
          request = { url, ...init };
          const bytes = Buffer.from('private synthetic video');
          return responseKind === 'native-web'
            ? new Response(bytes, { headers: { 'content-type': 'video/mp4' } })
            : new NodeFetchResponse(bytes, { headers: { 'content-type': 'video/mp4' } });
        },
        operation: async (client) => {
          const download = await client.storage.from('private-reference').download('owner/approved/video.mp4');
          assert.equal(download.error, null);
          return Buffer.from(await download.data.arrayBuffer());
        }
      });
      assert.equal(result.toString(), 'private synthetic video');
      assert.equal(request.url, `${SUPABASE_URL}/storage/v1/object/private-reference/owner/approved/video.mp4`);
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'error');
    });
}

test('installed official SDK remove preserves the caller paths without automatic retry or rollback',
  { skip: !sdkCreateClient }, async () => {
    let calls = 0;
    let request;
    const result = await withDeadline({
      createClient: sdkCreateClient,
      fetchImpl: async (url, init) => {
        calls++;
        request = { url, ...init };
        return jsonResponse([]);
      },
      operation: (client) => client.storage.from('private-reference').remove(['owner/original/video.mp4'])
    });
    assert.equal(result.error, null);
    assert.equal(calls, 1);
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, `${SUPABASE_URL}/storage/v1/object/private-reference`);
    assert.deepEqual(JSON.parse(request.body), { prefixes: ['owner/original/video.mp4'] });
  });

for (const status of [200, 500]) {
  test(`installed official SDK private download ${status} stall aborts the actual fetch`,
    { skip: !sdkCreateClient }, async () => {
      let cancelled = false;
      let signal;
      await assert.rejects(withDeadline({
        createClient: sdkCreateClient,
        timeoutMs: 30,
        maxResponseBytes: 50 * 1024 * 1024,
        fetchImpl: async (_url, init) => {
          signal = init.signal;
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
        },
        operation: (client) => client.storage.from('private-reference').download('owner/original/video.mp4')
      }), safeCode('STORAGE_TIMEOUT'));
      assert.equal(signal.aborted, true);
      assert.equal(cancelled, true);
    });
}

for (const status of [200, 500]) {
  test(`installed official SDK upload ${status} node-fetch response stall destroys the real Node body`,
    { skip: !sdkCreateClient || !NodeFetchResponse }, async (t) => {
      const f = await fixture(t);
      const body = new Readable({ read() {} });
      let signal;
      await assert.rejects(f.upload({ createClient: sdkCreateClient, timeoutMs: 30, fetchImpl: async (_url, init) => {
        signal = init.signal;
        await drain(init.body);
        return new NodeFetchResponse(body, { status });
      } }), safeCode('UPLOAD_TIMEOUT'));
      assert.equal(signal.aborted, true);
      assert.equal(body.destroyed, true);
    });
}

test('installed official SDK remove body stall is cancelled without a repeated delete',
  { skip: !sdkCreateClient }, async () => {
    let cancelled = false;
    let calls = 0;
    await assert.rejects(withDeadline({
      createClient: sdkCreateClient,
      timeoutMs: 30,
      fetchImpl: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
      operation: (client) => client.storage.from('private-reference').remove(['owner/original/video.mp4'])
    }), safeCode('STORAGE_TIMEOUT'));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });

test('closes the owned file handle when fstat fails', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let opened;
  fs.open = async (...args) => {
    opened = await originalOpen(...args);
    opened.stat = async () => { throw new Error(KEY); };
    return opened;
  };
  try {
    await assert.rejects(f.upload(), safeCode('UPLOAD_FAILED'));
    for (let i = 0; i < 50 && opened.fd !== -1; i++) await delay(2);
    assert.equal(opened.fd, -1);
    assert.equal(f.state.uploadCalls, undefined);
  } finally {
    fs.open = originalOpen;
  }
});

test('timeout closes a descriptor while an fstat result is delayed and never starts the upload later', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let opened;
  fs.open = async (...args) => {
    opened = await originalOpen(...args);
    const actualStat = opened.stat.bind(opened);
    opened.stat = async () => {
      const result = await actualStat();
      await delay(60);
      return result;
    };
    return opened;
  };
  try {
    await assert.rejects(f.upload({ timeoutMs: 20 }), safeCode('UPLOAD_TIMEOUT'));
    await delay(70);
    assert.equal(opened.fd, -1);
    assert.equal(f.state.uploadCalls, undefined);
  } finally {
    fs.open = originalOpen;
  }
});
