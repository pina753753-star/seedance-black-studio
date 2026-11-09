'use strict';
// H3ヘルプの消費クレジットが現行の実装と一致していること(テキスト120、画像・リファレンス・絵コンテ130)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../api/_lib/h3-live-config.js');
const director = require('../api/_lib/h3-director-config.js');

const root = path.join(__dirname, '..');
const help = fs.readFileSync(path.join(root, 'help.html'), 'utf8');
const info = fs.readFileSync(path.join(root, 'credits-info.html'), 'utf8');
const faq = (html) => {
  // help.html は「H3 Liveとは何ですか？」、credits-info.html は「…消費クレジットは？」付き
  const start = html.indexOf('H3 Liveとは何ですか？');
  assert.ok(start >= 0, 'H3 Liveの質問が見つかりません');
  return html.slice(start, html.indexOf('</details>', start));
};
const NOW = Date.parse('2026-11-05T00:00:00Z'); // 9/15の価格切替後

test('実装の料金: テキスト生成は120、画像・リファレンス・絵コンテは130(15秒・768p)', () => {
  assert.equal(cfg.creditCostForMode('text'), 120);
  for (const mode of ['image', 'reference', 'storyboard']) assert.equal(cfg.currentCreditCost(NOW), 130, mode);
  assert.equal(cfg.DURATION_SECONDS, 15);
  assert.equal(cfg.RESOLUTION_DB, '768p');
});

test('help.html: H3 Liveの質問は120/130クレジットを案内し、古い110と「1フレーム目」の断定を含まない', () => {
  const text = faq(help);
  assert.match(text, /テキストからの生成は120クレジット/);
  assert.match(text, /画像を使う生成（画像・リファレンス・絵コンテ）は130クレジット/);
  assert.doesNotMatch(text, /110/);
  assert.doesNotMatch(text, /1フレーム目/);
  assert.match(text, /画像を被写体の参照として使う生成/);
  assert.match(text, /15秒・768p固定/);
  assert.match(text, /プレミアム以上のプラン/);
  assert.match(text, /\.\/credits-info\.html/);
});

test('help.htmlとcredits-info.htmlのH3料金は同じ数字で、実装の数字とも一致する', () => {
  const nums = (t) => [...t.matchAll(/(\d+)クレジット/g)].map((m) => Number(m[1])).sort();
  assert.deepEqual(nums(faq(help)), [120, 130]);
  assert.deepEqual(nums(faq(info)), [120, 130]);
});

test('15秒のH3 Max(Live)と60秒のDirectorは別機能: ヘルプの15秒の説明にDirectorの60秒・440は混ざらない', () => {
  const text = faq(help);
  assert.doesNotMatch(text, /60秒|440|Director/);
  assert.equal(director.DURATION_SECONDS, 60);
  assert.notEqual(director.currentCreditCost(NOW), cfg.currentCreditCost(NOW));
});
