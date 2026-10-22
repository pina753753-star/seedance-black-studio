'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { isAllowedWatermarkUrl, downloadWatermarkVideo } = require('../watermark-server/watermark-download.js');

const SUPABASE_URL = 'https://unit-test.supabase.co';
const VIDEO_URL = `${SUPABASE_URL}/storage/v1/object/public/reference-images/video.mp4`;

function response(body = Readable.from([Buffer.from('video')]), headers = {}, status = 200) {
  const values = { 'content-type': 'video/mp4', ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
    headers: { get(name) { return values[name.toLowerCase()] ?? null; } }
  };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-download-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'input.mp4');
  return {
    filePath,
    async download(options = {}) {
      return downloadWatermarkVideo({
        url: VIDEO_URL,
        supabaseUrl: SUPABASE_URL,
        filePath,
        fetchImpl: async () => response(),
        maxBytes: 8,
        timeoutMs: 1000,
        ...options
      });
    },
    async absent() { await assert.rejects(fs.stat(filePath), { code: 'ENOENT' }); }
  };
}

function code(expected) {
  return (error) => {
    assert.equal(error.publicCode, expected);
    assert.equal(error.message, expected, 'Only a fixed safe error code is exposed');
    return true;
  };
}

test('allows the configured Supabase public host and any existing public bucket', () => {
  for (const url of [
    VIDEO_URL,
    `${SUPABASE_URL}/storage/v1/object/public/configured-video-bucket/nested/video.mp4`,
    `${SUPABASE_URL}/storage/v1/object/public/legacy-bucket/%E5%8B%95%E7%94%BB%20one.mp4?download=1`,
    `${SUPABASE_URL}/storage/v1/object/public/legacy-bucket/100%25complete.mp4`,
    `${SUPABASE_URL}/storage/v1/object/public/legacy-bucket/percent%25AB.mp4`,
    `${SUPABASE_URL}/storage/v1/object/public/legacy-bucket/percent%2520encoded.mp4`,
    'https://UNIT-TEST.supabase.co:443/storage/v1/object/public/old-bucket/video.webm'
  ]) assert.equal(isAllowedWatermarkUrl(url, `${SUPABASE_URL}:443/`), true, url);
});

const invalidSources = [
  undefined, null, {}, '',
  'http://unit-test.supabase.co/storage/v1/object/public/reference-images/video.mp4',
  'file:///etc/passwd',
  'https://127.0.0.1/storage/v1/object/public/reference-images/video.mp4',
  'https://169.254.169.254/latest/meta-data/',
  'https://[::1]/storage/v1/object/public/reference-images/video.mp4',
  'https://provider.example/video.mp4',
  VIDEO_URL.replace('unit-test', 'other-project'),
  VIDEO_URL.replace('.supabase.co', '.supabase.co.attacker.example'),
  VIDEO_URL.replace('unit-test.supabase.co', 'unit-test-supabase.co'),
  VIDEO_URL.replace('.co/', '.co./'),
  VIDEO_URL.replace('.co/', '.co:8443/'),
  VIDEO_URL.replace('.co/', '.co:0443/'),
  VIDEO_URL.replace('https://', 'https://user:password@'),
  VIDEO_URL.replace('https://', 'https://@'),
  VIDEO_URL.replace('https://', 'https://%75'),
  VIDEO_URL.replace('unit-test', '%75nit-test'),
  `${VIDEO_URL}#fragment`, `${VIDEO_URL}#`,
  ` ${VIDEO_URL}`, `${VIDEO_URL}\n`, VIDEO_URL.replace('unit-test', 'unit-\ttest'),
  VIDEO_URL.replace('/storage', '\\storage'),
  VIDEO_URL.replace('/public/', '/sign/'),
  VIDEO_URL.replace('/public/', '/authenticated/'),
  `${SUPABASE_URL}/storage/v1/object/public/`,
  `${SUPABASE_URL}/storage/v1/object/public/reference-images`,
  `${SUPABASE_URL}/storage/v1/object/public/reference-images/`,
  `${SUPABASE_URL}/storage/v1/object/public//video.mp4`,
  VIDEO_URL.replace('/reference-images/', '/reference-images//'),
  VIDEO_URL.replace('/reference-images/', '/reference-images/../'),
  VIDEO_URL.replace('/reference-images/', '/reference-images/%2e%2e/'),
  VIDEO_URL.replace('/reference-images/', '/reference-images/%252e%252e/'),
  VIDEO_URL.replace('video.mp4', `%${'25'.repeat(100)}2e%${'25'.repeat(100)}2e`),
  VIDEO_URL.replace('/reference-images/', '/reference-images%2fprivate/'),
  VIDEO_URL.replace('video.mp4', 'nested%5cvideo.mp4'),
  VIDEO_URL.replace('video.mp4', 'video%00.mp4'),
  VIDEO_URL.replace('video.mp4', 'bad%escape.mp4'),
  VIDEO_URL.replace('/public/', '/%70ublic/')
];

test('rejects SSRF, ambiguous authorities and non-public or ambiguous paths before fetch', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const url of invalidSources) {
    assert.equal(isAllowedWatermarkUrl(url, SUPABASE_URL), false, String(url));
    await assert.rejects(f.download({ url, fetchImpl() { calls++; } }), code('URL_INVALID'));
  }
  assert.equal(calls, 0);
  await f.absent();
});

test('rejects missing or unsafe Supabase configuration before fetch', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const supabaseUrl of [undefined, '', 'not a URL', 'http://unit-test.supabase.co',
    'https://127.0.0.1', 'https://supabase.co', 'https://unit-test.supabase.co.attacker.example',
    `${SUPABASE_URL}:8443`, `https://user@unit-test.supabase.co`, `${SUPABASE_URL}#`]) {
    assert.equal(isAllowedWatermarkUrl(VIDEO_URL, supabaseUrl), false);
    await assert.rejects(f.download({ supabaseUrl, fetchImpl() { calls++; } }), code('URL_INVALID'));
  }
  assert.equal(calls, 0);
  await f.absent();
});

test('streams a valid video to an exclusive file and requests identity without redirects', async (t) => {
  const f = await fixture(t);
  const body = Readable.from([Buffer.from('vi'), Buffer.from('deo')]);
  let signal;
  assert.equal(await f.download({ fetchImpl: async (url, options) => {
    assert.equal(url, VIDEO_URL);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.compress, false);
    assert.equal(options.headers['accept-encoding'], 'identity');
    signal = options.signal;
    assert.equal(signal.aborted, false);
    return response(body, { 'content-length': '5' });
  } }), 5);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'video');
  assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
  assert.equal(signal.aborted, false);
  assert.equal(body.destroyed, true);
});

test('allows exactly the byte cap including application/octet-stream content', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.download({ fetchImpl: async () => response(
    Readable.from([Buffer.from('1234'), Buffer.from('5678')]),
    { 'content-type': 'Application/Octet-Stream; charset=binary', 'content-length': '8', 'content-encoding': 'identity' }
  ) }), 8);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), '12345678');
});

test('accepts video MIME parameters and case without imposing a bucket name', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.download({
    url: VIDEO_URL.replace('reference-images', 'legacy-videos'),
    fetchImpl: async () => response(undefined, { 'content-type': 'Video/WebM; codecs=vp9' })
  }), 5);
});

test('rejects declared oversize including lengths larger than Number precision before reading', async (t) => {
  const f = await fixture(t);
  for (const contentLength of ['9', '9999999999999999999999999999999999999999999999999']) {
    let reads = 0;
    const body = new Readable({ read() { reads++; this.push(null); } });
    await assert.rejects(f.download({ fetchImpl: async () => response(body, { 'content-length': contentLength }) }), code('DOWNLOAD_TOO_LARGE'));
    assert.equal(reads, 0);
    assert.equal(body.destroyed, true);
    await f.absent();
  }
});

test('defaults to a 200 MiB cap without allocating a large body', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const body = new Readable({ read() { reads++; this.push(null); } });
  await assert.rejects(f.download({
    maxBytes: undefined,
    fetchImpl: async () => response(body, { 'content-length': String(200 * 1024 * 1024 + 1) })
  }), code('DOWNLOAD_TOO_LARGE'));
  assert.equal(reads, 0);
  assert.equal(body.destroyed, true);
  await f.absent();
});

for (const [name, length] of [['missing', null], ['lying', '1'], ['zero', '0'], ['malformed', 'not-a-number']]) {
  test(`enforces actual stream cap with ${name} Content-Length and cleans partial files`, async (t) => {
    const f = await fixture(t);
    const body = Readable.from([Buffer.from('12345678'), Buffer.from('9')]);
    await assert.rejects(f.download({ fetchImpl: async () => response(body, { 'content-length': length }) }), code('DOWNLOAD_TOO_LARGE'));
    assert.equal(body.destroyed, true);
    await f.absent();
  });
}

test('rejects a single oversized chunk without writing it', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.download({ fetchImpl: async () => response(Readable.from([Buffer.alloc(100)])) }), code('DOWNLOAD_TOO_LARGE'));
  await f.absent();
});

test('rejects all redirects and never follows the Location header', async (t) => {
  const f = await fixture(t);
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    let calls = 0;
    const body = Readable.from([Buffer.from('unsafe redirect body')]);
    await assert.rejects(f.download({ fetchImpl: async (_, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return { ...response(body, { location: 'http://169.254.169.254/' }, status), ok: true };
    } }), code('DOWNLOAD_FAILED'));
    assert.equal(calls, 1);
    assert.equal(body.destroyed, true);
    await f.absent();
  }
});

test('rejects unsuccessful responses without exposing or reading their bodies', async (t) => {
  const f = await fixture(t);
  for (const status of [199, 400, 401, 403, 404, 500]) {
    let reads = 0;
    const body = new Readable({ read() { reads++; this.push('private error body'); this.push(null); } });
    await assert.rejects(f.download({ fetchImpl: async () => response(body, {}, status) }), code('DOWNLOAD_FAILED'));
    assert.equal(reads, 0);
    assert.equal(body.destroyed, true);
    await f.absent();
  }
});

test('rejects images, HTML and missing or malformed MIME before reading or creating a file', async (t) => {
  const f = await fixture(t);
  for (const type of ['image/png', 'image/jpeg', 'text/html', 'application/json', null, '', 'video/', 'video/mp4, text/html']) {
    let reads = 0;
    const body = new Readable({ read() { reads++; this.push(null); } });
    await assert.rejects(f.download({ fetchImpl: async () => response(body, { 'content-type': type }) }), code('VIDEO_CONTENT_TYPE_INVALID'));
    assert.equal(reads, 0);
    assert.equal(body.destroyed, true);
    await f.absent();
  }
});

test('rejects compression before reading any encoded bytes', async (t) => {
  const f = await fixture(t);
  for (const encoding of ['gzip', 'br', 'deflate', 'identity, gzip', 'x-unknown']) {
    let reads = 0;
    const body = new Readable({ read() { reads++; this.push(null); } });
    await assert.rejects(f.download({ fetchImpl: async () => response(body, { 'content-encoding': encoding }) }), code('VIDEO_CONTENT_ENCODING_INVALID'));
    assert.equal(reads, 0);
    assert.equal(body.destroyed, true);
    await f.absent();
  }
});

test('rejects an empty stream and removes its empty file', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.download({ fetchImpl: async () => response(Readable.from([]), { 'content-length': '0' }) }), code('VIDEO_EMPTY'));
  await f.absent();
});

test('rejects a missing body before creating a file', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.download({ fetchImpl: async () => response(null) }), code('VIDEO_EMPTY'));
  await f.absent();
});

test('times out before headers even if fetch ignores abort and destroys a late response', async (t) => {
  const f = await fixture(t);
  let signal;
  let resolveResponse;
  await assert.rejects(f.download({ timeoutMs: 30, fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveResponse = resolve; });
  } }), code('DOWNLOAD_TIMEOUT'));
  assert.equal(signal.aborted, true);
  await f.absent();
  const lateBody = Readable.from([Buffer.from('late')]);
  resolveResponse(response(lateBody));
  await delay(0);
  assert.equal(lateBody.destroyed, true);
  await f.absent();
});

test('times out a stalled body, aborts it and removes a partially written file', async (t) => {
  const f = await fixture(t);
  let signal;
  let pushed = false;
  const body = new Readable({ read() {
    if (!pushed) { pushed = true; this.push(Buffer.from('part')); }
  } });
  await assert.rejects(f.download({ timeoutMs: 40, fetchImpl: async (_, options) => {
    signal = options.signal;
    return response(body);
  } }), code('DOWNLOAD_TIMEOUT'));
  assert.equal(pushed, true);
  assert.equal(signal.aborted, true);
  assert.equal(body.destroyed, true);
  await f.absent();
});

test('uses one deadline for headers and body rather than resetting after headers', async (t) => {
  const f = await fixture(t);
  const body = new Readable({ read() {} });
  let signal;
  let startedAt;
  let abortedAfter;
  await assert.rejects(f.download({ timeoutMs: 120, fetchImpl: async (_, options) => {
    signal = options.signal;
    startedAt = performance.now();
    signal.addEventListener('abort', () => { abortedAfter = performance.now() - startedAt; }, { once: true });
    await delay(70);
    return response(body);
  } }), code('DOWNLOAD_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.ok(abortedAfter < 180, `Expected shared 120 ms deadline, observed ${abortedAfter} ms`);
  assert.equal(body.destroyed, true);
  await f.absent();
});

test('normalizes a source read error and removes a partial file', async (t) => {
  const f = await fixture(t);
  let pushed = false;
  const body = new Readable({ read() {
    if (pushed) return;
    pushed = true;
    this.push(Buffer.from('part'));
    setImmediate(() => this.destroy(new Error(`secret body from ${VIDEO_URL}?token=do-not-expose`)));
  } });
  await assert.rejects(f.download({ fetchImpl: async () => response(body) }), code('DOWNLOAD_FAILED'));
  assert.equal(body.destroyed, true);
  await f.absent();
});

test('handles a body error before pipeline starts without an unhandled error', async (t) => {
  const f = await fixture(t);
  const body = new Readable({ read() {} });
  await assert.rejects(f.download({ fetchImpl: async () => {
    setImmediate(() => body.destroy(new Error('private early source error')));
    return response(body);
  } }), code('DOWNLOAD_FAILED'));
  assert.equal(body.destroyed, true);
  await f.absent();
});

test('keeps timeout classification if source destruction itself emits an error', async (t) => {
  const f = await fixture(t);
  const body = new Readable({
    read() {},
    destroy(_, callback) { callback(new Error('private error during timeout cleanup')); }
  });
  await assert.rejects(f.download({ timeoutMs: 30, fetchImpl: async () => response(body) }), code('DOWNLOAD_TIMEOUT'));
  assert.equal(body.destroyed, true);
  await f.absent();
});

test('counts binary bytes rather than characters for a string-producing source', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.download({ maxBytes: 2, fetchImpl: async () => response(Readable.from(['あ'])) }), code('DOWNLOAD_TOO_LARGE'));
  await f.absent();
  assert.equal(await f.download({ maxBytes: 3, fetchImpl: async () => response(Readable.from(['あ'])) }), 3);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'あ');
});

test('normalizes fetch errors without trusting their publicCode or exposing URLs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.download({ fetchImpl: async () => {
    throw Object.assign(new Error(`${VIDEO_URL}?token=private`), { publicCode: 'UPSTREAM_SECRET' });
  } }), code('DOWNLOAD_FAILED'));
  await f.absent();
});

test('preserves a preexisting target and destroys the unread source', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.filePath, 'existing file');
  const body = Readable.from([Buffer.from('replacement')]);
  await assert.rejects(f.download({ fetchImpl: async () => response(body) }), code('DOWNLOAD_FAILED'));
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'existing file');
  assert.equal(body.destroyed, true);
});

test('never follows or removes a preexisting destination symlink', async (t) => {
  const f = await fixture(t);
  const target = `${f.filePath}.existing`;
  await fs.writeFile(target, 'existing target');
  await fs.symlink(target, f.filePath);
  await assert.rejects(f.download(), code('DOWNLOAD_FAILED'));
  assert.equal((await fs.lstat(f.filePath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing target');
});

test('rejects invalid resource bounds before calling fetch', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const options of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: Infinity },
    { maxBytes: 1.1 }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity },
    { timeoutMs: 2147483648 }, { fetchImpl: null }]) {
    await assert.rejects(f.download({ fetchImpl() { calls++; }, ...options }), code('DOWNLOAD_FAILED'));
  }
  assert.equal(calls, 0);
  await f.absent();
});

test('clears the deadline after success rather than aborting a completed request', async (t) => {
  const f = await fixture(t);
  let signal;
  assert.equal(await f.download({ timeoutMs: 40, fetchImpl: async (_, options) => {
    signal = options.signal;
    return response();
  } }), 5);
  await delay(70);
  assert.equal(signal.aborted, false);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'video');
});
