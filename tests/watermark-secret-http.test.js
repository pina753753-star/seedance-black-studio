'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let express;
try { express = require('express'); } catch (_) {}
const source = fs.readFileSync(path.join(__dirname, '../watermark-server/server.js'), 'utf8');
const OLD = 'synthetic-http-old';
const NEW = 'synthetic-http-new-longer';
const URL = 'https://unit-test.supabase.co/storage/v1/object/public/reference-images/clip.mp4';
const ID = '11111111-1111-4111-8111-111111111111';
const bodies = {
  '/watermark': { videoUrl: URL },
  '/edit': { clips: [{ videoUrl: URL }], userId: ID, taskId: ID },
  '/reference-dance-inspect': { userId: ID, assetId: ID, stagingPath: 'fixture' }
};
const stages = [
  { name: 'original', current: OLD, accepted: [OLD] },
  { name: 'overlap', current: NEW, previous: OLD, accepted: [OLD, NEW] },
  { name: 'retired', current: NEW, accepted: [NEW] },
  { name: 'rollback with overlap', current: OLD, previous: NEW, accepted: [OLD, NEW] },
  { name: 'previous alone', previous: OLD, accepted: [] },
  { name: 'empty current', current: '', previous: OLD, accepted: [] },
  { name: 'whitespace current', current: '   ', previous: OLD, accepted: [] }
];
for (const stage of stages) {
  test(`HTTP secret rotation: ${stage.name}`, { skip: !express }, async () => {
    const app = express();
    app.listen = () => {}; // The source must not start an unrestricted server.
    const factory = () => app;
    factory.json = express.json;
    const jobs = [], logs = [], effects = [];
    const forbidden = name => () => { effects.push(name); throw new Error('Forbidden fixture operation'); };
    const context = vm.createContext({
      Buffer, URL: global.URL, setTimeout, clearTimeout,
      process: { env: { SUPABASE_URL: 'https://unit-test.supabase.co',
        WATERMARK_SECRET: stage.current, WATERMARK_SECRET_PREVIOUS: stage.previous } },
      console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
      require(name) {
        if (name === 'express') return factory;
        if (name === 'fluent-ffmpeg') return forbidden('ffmpeg');
        if (name === 'ffmpeg-static') return '/unused/fixture';
        if (name === '@supabase/supabase-js') return { createClient: forbidden('storage') };
        if (name === 'node-fetch') return forbidden('fetch');
        if (name === 'fs') return new Proxy({}, { get: () => forbidden('filesystem') });
        if (name === 'path' || name === 'crypto') return require(name);
        if (name === 'child_process') return { execFile: forbidden('exec') };
        if (name === 'uuid') return { v4: forbidden('uuid') };
        if (name.startsWith('./')) return require(path.join(__dirname, '../watermark-server', name));
        throw new Error('Unexpected import');
      },
      fixtureJob: async kind => { jobs.push(kind); return { ok: true }; }
    });
    vm.runInContext(source, context);
    vm.runInContext("runWatermarkJob = () => fixtureJob('watermark'); runEditJob = () => fixtureJob('edit'); runReferenceDanceInspection = () => fixtureJob('inspect');", context);
    const server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const [route, body] of Object.entries(bodies)) {
        for (const header of [undefined, `Bearer ${OLD}`, `Bearer ${NEW}`, 'Bearer wrong', OLD, `Basic ${OLD}`, `bearer ${NEW}`]) {
          const before = jobs.length;
          const headers = { 'Content-Type': 'application/json' };
          if (header !== undefined) headers.Authorization = header;
          const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method: 'POST', headers, body: JSON.stringify(body)
          });
          const configured = Boolean(stage.current?.trim());
          const token = /^Bearer (.+)$/i.exec(header || '')?.[1];
          const authorized = configured && stage.accepted.includes(token);
          assert.equal(response.status, !configured ? 503 : authorized ? 200 : 401, route);
          const text = await response.text();
          assert.equal(text.includes(OLD) || text.includes(NEW), false);
          assert.equal(jobs.length, before + (authorized ? 1 : 0));
        }
      }
      assert.deepEqual(effects, []);
      assert.equal(logs.some(line => line.includes(OLD) || line.includes(NEW)), false);
      assert.equal(vm.runInContext('activeJobs + activeEditJobs + activeWatermarkRequests + jobQueue.length + inFlightWatermarks.size', context), 0);
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  });
}
