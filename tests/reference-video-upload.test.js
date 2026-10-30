'use strict';
// The type that supabase-js puts on the wire for a reference video. Uses the REAL storage-js client with a capturing
// fetch (no network): the old mock of uploadToSignedUrl could not see that the multipart part keeps the File's own type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { StorageClient } = require('@supabase/storage-js');
const helper = require('../reference-video-upload.js');

const BYTES = Buffer.from('synthetic-bytes-not-a-real-video');
const file = (name, type) => new File([BYTES], name, { type });

async function wire(body, options) {
  let captured = null;
  const client = new StorageClient('https://synthetic.invalid/storage/v1', { apikey: 'synthetic-only' }, async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ Key: 'seedance-reference-video/x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const { error } = await client.from('seedance-reference-video').uploadToSignedUrl('staging/u/a.mp4', 'synthetic-token', body, options);
  assert.equal(error, null);
  const part = captured.init.body.get('');
  return { partType: part.type, partSize: part.size, isMultipart: captured.init.body instanceof FormData };
}

test('premise: the SDK sends a File as multipart and keeps the File\'s own type; the contentType option cannot change it', async () => {
  const sent = await wire(file('screen.mov', 'video/quicktime'), { contentType: 'video/mp4' });
  assert.equal(sent.isMultipart, true);
  assert.equal(sent.partType, 'video/quicktime', 'this is why the old contentType:"video/mp4" never helped');
});

test('a MOV goes out as video/quicktime (never relabelled as MP4); an MP4 as video/mp4', async () => {
  for (const [name, type, expected] of [
    ['screen.mov', 'video/quicktime', 'video/quicktime'],
    ['SCREEN.MOV', 'video/quicktime', 'video/quicktime'],
    ['screen.mov', '', 'video/quicktime'],
    ['screen.MOV', 'application/octet-stream', 'video/quicktime'],
    ['dance.mp4', 'video/mp4', 'video/mp4'],
    ['dance.mp4', '', 'video/mp4'],
    ['dance.mp4', 'video/x-m4v', 'video/mp4']
  ]) {
    const prepared = helper.prepare(file(name, type));
    assert.ok(prepared, `${name}/${type}`);
    assert.equal(prepared.contentType, expected, `${name}/${type}`);
    const sent = await wire(prepared.body, { contentType: prepared.contentType });
    assert.equal(sent.partType, expected, `${name}/${type}`);
    assert.equal(sent.partSize, BYTES.length, 'same bytes, nothing converted or dropped');
  }
});

test('a File whose type is already right is passed through untouched', () => {
  const f = file('screen.mov', 'video/quicktime');
  assert.equal(helper.prepare(f).body, f);
});

test('anything that is not an MP4/MOV by type or extension is refused (no disguise as MP4)', () => {
  for (const [name, type] of [['dance.webm', 'video/webm'], ['dance.avi', 'video/x-msvideo'], ['dance.mov.exe', ''], ['dance.exe', 'application/octet-stream'], ['', ''], ['photo.jpg', 'image/jpeg'], ['noext', '']]) {
    assert.equal(helper.prepare(file(name, type)), null, `${name}/${type}`);
  }
  assert.equal(helper.prepare(null), null);
});

test('both call sites go through the helper and no longer force video/mp4 on the wire', () => {
  const root = path.join(__dirname, '..');
  for (const name of ['dance-kling.js', 'generate-prod.html']) {
    const src = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(src, /flowvidReferenceVideoUpload/, name);
    assert.doesNotMatch(src, /uploadToSignedUrl\([^)]*,file,\{contentType:'video\/mp4'\}\)/, name);
  }
  const html = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
  const helperTag = html.indexOf('<script src="./reference-video-upload.js');
  const tabTag = html.indexOf('<script src="./dance-kling.js');
  assert.ok(helperTag > -1 && tabTag > -1 && helperTag < tabTag, 'helper loads before the tab script');
});
