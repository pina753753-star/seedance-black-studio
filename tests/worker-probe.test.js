'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { probeVideoFile } = require('../watermark-server/worker-probe.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '../watermark-server/worker-probe.js'), 'utf8');
const FILE = '/tmp/worker-probe-test/input.mp4';
const MAX_BUFFER = 1024 * 1024;

function code(expected) {
  return (error) => {
    assert.equal(error.publicCode, expected);
    assert.equal(error.message, expected, 'Only a fixed safe code is exposed');
    assert.equal(error.cause, undefined);
    assert.equal(error.stdout, undefined);
    assert.equal(error.stderr, undefined);
    return true;
  };
}

// A deterministic clock also verifies cleanup of watchdogs, without sleeping
// or replacing global timers used by the test runner or other suites.
function fixture() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const module = { exports: {} };
  vm.runInNewContext(SOURCE, {
    module,
    Buffer,
    require(name) {
      if (name === 'node:perf_hooks') return { performance: { now: () => now } };
      return require(name);
    },
    setTimeout(callback, ms) {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  }, { filename: 'worker-probe.js' });
  const calls = [];
  const kills = [];
  const child = { kill(signal) { kills.push(signal); return true; } };
  let callback;
  return {
    calls, kills, child, timers,
    probe(options = {}) {
      return module.exports.probeVideoFile({
        filePath: FILE,
        timeoutMs: 15,
        execFileImpl(...args) {
          calls.push(args);
          callback = args[3];
          return child;
        },
        ...options
      });
    },
    callback(...args) { callback(...args); },
    elapse(ms) { now += ms; },
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
}

for (const format of ['mov,mp4,m4a,3gp,3g2,mj2', 'mov', 'matroska,webm']) {
  test(`preserves complete parsed metadata for ${format}`, async () => {
    const f = fixture();
    const expected = {
      streams: [
        { index: 0, codec_type: 'video', width: 1920, height: 1080,
          r_frame_rate: '30000/1001', disposition: { attached_pic: 0 },
          tags: { language: 'und', rotate: '90', title: '動画' } },
        { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' }
      ],
      format: { format_name: format, duration: '12.345000', size: '125000',
        tags: { title: 'Original title' } },
      chapters: [{ id: 1 }]
    };
    const pending = f.probe();
    f.callback(null, JSON.stringify(expected));
    assert.equal(JSON.stringify(await pending), JSON.stringify(expected));
    assert.equal(f.timers.size, 0);
    f.tick(10000);
    assert.deepEqual(f.kills, []);
  });
}

test('uses a shell-free ffprobe invocation with only file and pipe protocols', async () => {
  const f = fixture();
  const filePath = '/tmp/動画 with spaces; $(literal)/input.mov';
  const pending = f.probe({ filePath, timeoutMs: undefined });
  const [command, args, options] = f.calls[0];
  assert.equal(command, 'ffprobe');
  assert.deepEqual(Array.from(args), [
    '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_format', '-show_streams', '-of', 'json', filePath
  ]);
  assert.equal(options.timeout, 15000);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.maxBuffer, MAX_BUFFER);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.shell, false);
  f.callback(null, '{}');
  await pending;
});

test('does not impose any route-specific duration, dimension or format policy', async () => {
  for (const data of [{}, { streams: [] }, { format: { duration: '99999' } },
    { streams: [{ codec_type: 'video', width: 99999, height: 99999 }],
      format: { format_name: 'unrecognized' } }]) {
    const f = fixture();
    const pending = f.probe();
    f.callback(null, JSON.stringify(data));
    assert.equal(JSON.stringify(await pending), JSON.stringify(data));
  }
});

test('rejects URLs, protocols, options and non-absolute paths before spawning', async () => {
  const f = fixture();
  for (const filePath of [undefined, null, {}, '', 'relative.mp4', '-show_help',
    'https://example.test/video.mp4', 'http://169.254.169.254/latest/meta-data',
    'file:///tmp/input.mp4', 'pipe:0', 'concat:/tmp/a|/tmp/b', 'tcp://127.0.0.1:1234',
    '//example.test/input.mp4', '/tmp/bad\0file.mp4', '/tmp/bad\nfile.mp4']) {
    await assert.rejects(f.probe({ filePath }), code('PROBE_FAILED'));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('an exhausted budget rejects before any process or timer starts', async () => {
  const f = fixture();
  for (const timeoutMs of [0, -1, -1000]) {
    await assert.rejects(f.probe({ timeoutMs }), code('PROBE_TIMEOUT'));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('rejects invalid timeout and executor options without spawning', async () => {
  const f = fixture();
  for (const timeoutMs of [NaN, Infinity, '15', null, 0.5, 2147483648]) {
    await assert.rejects(f.probe({ timeoutMs }), code('PROBE_FAILED'));
  }
  await assert.rejects(f.probe({ execFileImpl: null }), code('PROBE_FAILED'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('success ignores late errors and clears the watchdog', async () => {
  const f = fixture();
  const pending = f.probe();
  f.callback(null, '{"streams":[]}');
  f.callback(new Error('private stderr'));
  assert.equal(JSON.stringify(await pending), '{"streams":[]}');
  assert.equal(f.timers.size, 0);
  f.tick(10000);
  assert.deepEqual(f.kills, []);
});

test('a synchronous success callback cannot leave a watchdog behind', async () => {
  const f = fixture();
  const data = await f.probe({ execFileImpl(command, args, options, callback) {
    callback(null, '{}');
    return f.child;
  } });
  assert.equal(JSON.stringify(data), '{}');
  assert.equal(f.timers.size, 0);
  f.tick(10000);
  assert.deepEqual(f.kills, []);
});

test('a synchronous spawn throw is sanitized and clears the watchdog', async () => {
  const f = fixture();
  await assert.rejects(f.probe({ execFileImpl() {
    throw Object.assign(new Error('private path and credentials'), { publicCode: 'RAW_SECRET' });
  } }), code('PROBE_FAILED'));
  assert.equal(f.timers.size, 0);
  f.tick(10000);
  assert.deepEqual(f.kills, []);
});

test('process errors and killed maxBuffer errors are failures, not assumed timeouts', async () => {
  for (const error of [new Error('private path'),
    Object.assign(new Error('stderr includes token'), { code: 'ENOENT' }),
    Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true
    }),
    Object.assign(new Error('signal failure'), { signal: 'SIGKILL', killed: true }),
    Object.assign(new Error('untrusted code'), { publicCode: 'PROBE_TIMEOUT' })]) {
    const f = fixture();
    const pending = f.probe();
    f.callback(error, 'private stdout', 'private stderr');
    await assert.rejects(pending, code('PROBE_FAILED'));
    assert.equal(f.timers.size, 0);
    f.callback(null, '{}');
    f.tick(10000);
    assert.deepEqual(f.kills, []);
  }
});

test('invalid JSON or callback output is safely rejected with no timer leak', async () => {
  for (const stdout of ['', '{', 'private stderr instead of JSON', undefined, {},
    '{"streams":[]}trailing']) {
    const f = fixture();
    const pending = f.probe();
    f.callback(null, stdout);
    await assert.rejects(pending, code('PROBE_FAILED'));
    assert.equal(f.timers.size, 0);
  }
});

test('caps decoded output bytes defensively and accepts valid Buffer output', async () => {
  for (const stdout of [Buffer.alloc(MAX_BUFFER + 1), 'あ'.repeat(Math.ceil(MAX_BUFFER / 3))]) {
    const f = fixture();
    const pending = f.probe();
    f.callback(null, stdout);
    await assert.rejects(pending, code('PROBE_FAILED'));
    assert.equal(f.timers.size, 0);
  }
  const f = fixture();
  const pending = f.probe();
  f.callback(null, Buffer.from('{"streams":[]}'));
  assert.equal(JSON.stringify(await pending), '{"streams":[]}');
});

test('accepts valid metadata at exactly the output byte limit without truncating it', async () => {
  const f = fixture();
  const data = { tag: 'x'.repeat(MAX_BUFFER - Buffer.byteLength('{"tag":""}')) };
  const stdout = JSON.stringify(data);
  assert.equal(Buffer.byteLength(stdout), MAX_BUFFER);
  const pending = f.probe();
  f.callback(null, stdout);
  assert.equal((await pending).tag, data.tag);
  assert.equal(f.timers.size, 0);
});

test('deadline kills a callback-silent child exactly once and ignores late callbacks', async () => {
  const f = fixture();
  const pending = f.probe();
  f.tick(14);
  assert.deepEqual(f.kills, []);
  f.tick(1);
  await assert.rejects(pending, code('PROBE_TIMEOUT'));
  assert.deepEqual(f.kills, ['SIGKILL']);
  assert.equal(f.timers.size, 0);
  f.callback(null, '{"late":true}');
  f.callback(new Error('late private failure'));
  f.tick(10000);
  assert.deepEqual(f.kills, ['SIGKILL']);
});

test('small remaining budgets are not inflated to an extra second', async () => {
  const f = fixture();
  const pending = f.probe({ timeoutMs: 1 });
  assert.equal(f.calls[0][2].timeout, 1);
  f.tick(1);
  await assert.rejects(pending, code('PROBE_TIMEOUT'));
  assert.deepEqual(f.kills, ['SIGKILL']);
});

test('a kill that throws or returns false cannot escape or settle twice', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.child.kill = (signal) => {
      f.kills.push(signal);
      if (throws) throw new Error('native kill failure with private path');
      return false;
    };
    const pending = f.probe();
    f.tick(15);
    await assert.rejects(pending, code('PROBE_TIMEOUT'));
    f.callback(new Error('late error'));
    assert.deepEqual(f.kills, ['SIGKILL']);
    assert.equal(f.timers.size, 0);
  }
});

test('timeout wins over a callback synchronously triggered by kill', async () => {
  const f = fixture();
  f.child.kill = (signal) => {
    f.kills.push(signal);
    f.callback(null, '{}');
    return true;
  };
  const pending = f.probe();
  f.tick(15);
  await assert.rejects(pending, code('PROBE_TIMEOUT'));
  assert.deepEqual(f.kills, ['SIGKILL']);
});

test('a callback after the deadline cannot win before the timer is dispatched', async () => {
  const f = fixture();
  const pending = f.probe();
  f.elapse(16);
  f.callback(null, '{}');
  await assert.rejects(pending, code('PROBE_TIMEOUT'));
  assert.deepEqual(f.kills, ['SIGKILL']);
  assert.equal(f.timers.size, 0);
});

test('an expired synchronous callback still kills a handle returned afterward', async () => {
  const f = fixture();
  await assert.rejects(f.probe({ execFileImpl(command, args, options, callback) {
    f.elapse(16);
    callback(null, '{}');
    return f.child;
  } }), code('PROBE_TIMEOUT'));
  assert.deepEqual(f.kills, ['SIGKILL']);
  assert.equal(f.timers.size, 0);
});

test('real local process success returns parsed output and exits normally', { timeout: 5000 }, async (t) => {
  let child;
  let closed;
  const data = { streams: [{ codec_type: 'video', width: 1280, height: 720 }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.000000' } };
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const actual = await probeVideoFile({
    filePath: FILE,
    timeoutMs: 2000,
    execFileImpl(command, args, options, callback) {
      child = execFile(process.execPath, ['-e',
        `process.stdout.write(${JSON.stringify(JSON.stringify(data))})`
      ], options, callback);
      closed = once(child, 'close');
      return child;
    }
  });
  assert.deepEqual(actual, data);
  assert.deepEqual(await closed, [0, null]);
});

test('real local process is terminated by SIGKILL on timeout', { timeout: 5000 }, async (t) => {
  let child;
  let closed;
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await assert.rejects(probeVideoFile({
    filePath: FILE,
    timeoutMs: 75,
    execFileImpl(command, args, options, callback) {
      child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, callback);
      closed = once(child, 'close');
      return child;
    }
  }), code('PROBE_TIMEOUT'));
  const [exitCode, signal] = await closed;
  assert.equal(exitCode, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(child.signalCode, 'SIGKILL');
});

for (const stream of ['stdout', 'stderr']) {
  test(`real local ${stream} overflow is bounded and kills the child`, { timeout: 5000 }, async (t) => {
    let child;
    let closed;
    t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await assert.rejects(probeVideoFile({
      filePath: FILE,
      timeoutMs: 2000,
      execFileImpl(command, args, options, callback) {
        child = execFile(process.execPath, ['-e',
          `process.${stream}.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)`
        ], options, callback);
        closed = once(child, 'close');
        return child;
      }
    }), code('PROBE_FAILED'));
    const [exitCode, signal] = await closed;
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
  });
}
