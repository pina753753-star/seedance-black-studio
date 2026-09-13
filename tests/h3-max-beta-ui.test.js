'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'h3-max-beta.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

test('H3 Max: ユーザー向け表示にBETA表記を出さず、チャットUI/PREVIEW表記も使わない', () => {
  assert.match(html, /<title>H3 Max \| Pina Studio<\/title>/);
  assert.match(html, /<span class="brand">H3 MAX<\/span>/);
  assert.match(html, />H3 Max<\/a>/);
  assert.match(html, />H3 Max Live<\/a>/);
  assert.match(html, /<div class="empty" id="stageEmpty"><b>H3 MAX<\/b>/);
  assert.match(html, /<div class="section-title">H3 MAX<\/div>/);
  assert.doesNotMatch(html, /BETAセール価格/);
  assert.match(html, /9\/14まではセール価格、9\/15から通常価格です。/);
  // ファイル名(h3-max-beta.html)自体の "beta" 表記は対象外。ユーザー向け表示に大文字の
  // BETA が残っていないことだけを確認する。
  const bodyMatch = html.match(/<body>[\s\S]*<\/body>/);
  assert.ok(bodyMatch, 'body content not found');
  assert.doesNotMatch(bodyMatch[0], /BETA/);
  assert.doesNotMatch(html, /生成チャット/);
  assert.doesNotMatch(html, />PREVIEW</);
});

test('H3 Max: プロンプト入力欄を大きくする', () => {
  assert.match(html, /\.prompt\{[^}]*min-height:150px/);
  assert.match(html, /<textarea class="prompt" id="prompt" maxlength="2000"/);
});

test('H3 Max: 履歴を折りたたみカード表示する', () => {
  assert.match(html, /id="historyToggle"[^>]*aria-expanded="false">履歴を見る<\/button>/);
  assert.match(html, /<div class="history" id="history" hidden>/);
  assert.match(html, /class="history-card"/);
  assert.match(html, /-webkit-line-clamp:2/);
});

test('H3 Max: 履歴カード内でvideo controls再生する', () => {
  assert.match(html, /<div class="history-video"><video controls playsinline preload="metadata"/);
  assert.doesNotMatch(html, /position:fixed[^}]*history/i);
});

test('H3 Max: 保存はBlobを取得してobject URLからファイル保存する', () => {
  assert.match(html, /var res=await fetch\(url,\{cache:'no-store'\}\)/);
  assert.match(html, /var blob=await res\.blob\(\)/);
  assert.match(html, /URL\.createObjectURL\(blob\)/);
  assert.match(html, /a\.download='h3-max-'/);
  assert.match(html, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(html, />ファイルに保存<\/button>/);
});

test('H3 Max: 料金と残高はfeedのserver値で表示・ゲートする', () => {
  assert.match(html, /api\('\/api\/h3-live\/feed'\)/);
  assert.match(html, /state\.creditCost=typeof e\.creditCost==='number'/);
  assert.match(html, /state\.hasEnough=e\.hasEnoughCredits!==false/);
  assert.match(html, /1本 '\+state\.creditCost\+' クレジット/);
});

test('Vercel: 既存h3-live.html導線を新BETA UIへ先にルーティングする', () => {
  const routes = vercel.routes || [];
  const betaIndex = routes.findIndex((r) => r.src === '/h3-live.html' && r.dest === '/h3-max-beta.html');
  const filesystemIndex = routes.findIndex((r) => r.handle === 'filesystem');
  assert.ok(betaIndex >= 0);
  assert.ok(filesystemIndex >= 0);
  assert.ok(betaIndex < filesystemIndex);
});
