'use strict';

// H3 Max Stage 1: 「画像を添付しているのに別人になる／画像・プロンプトが
// 生成へ渡らない」問題のうち、モード切替で人物参照画像が意図せず消える
// UIバグと、text送信時の画像前提文言のすれ違いを対象にする。
//
// このファイル向けの既存テスト(tests/h3-max-beta-ui.test.js)と同じ方式で、
// 実DOM/jsdomを使わず、対象コード片をソース文字列として静的に検証する。
// 唯一DOM非依存の判定用正規表現(IMAGE_RELIANT_PHRASE)だけは実際に抽出して
// 実行し、振る舞いも確認する。
//
// 実API・実生成・credits消費・本番DB/Storage書き込みは一切行わない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'h3-max-beta.html'), 'utf8');

function sliceFn(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found`);
  const rest = html.slice(start + 1);
  const nextFn = rest.search(/\n    function /);
  return nextFn === -1 ? html.slice(start) : html.slice(start, start + 1 + nextFn);
}

const setModeSrc = sliceFn('setMode');
const sendSrc = sliceFn('send');

// ---------------------------------------------------------------
// モード切替で単一画像／参照画像を消さない
// ---------------------------------------------------------------

test('setMode(): clearImage()もclearReferenceImages()も呼ばない(モード切替で画像を失わない)', () => {
  assert.doesNotMatch(setModeSrc, /clearImage\(\)/);
  assert.doesNotMatch(setModeSrc, /clearReferenceImages\(\)/);
});

test('setMode(): 画像モードに戻ったとき、既存のuploadIdがあればthumbを表示する', () => {
  assert.match(
    setModeSrc,
    /\$\('thumb'\)\.classList\.toggle\('show',img&&!!state\.uploadId\)/
  );
});

test('setMode(): dropは画像モードかつuploadId未設定の時だけ表示する(既存挙動を維持)', () => {
  assert.match(
    setModeSrc,
    /\$\('drop'\)\.classList\.toggle\('show',img&&!state\.uploadId\)/
  );
});

test('setMode(): 複数画像モードでは常にrenderRefGrid()を呼び、参照画像を再表示する', () => {
  assert.match(setModeSrc, /if\(multi\)renderRefGrid\(\);/);
});

test('clearImage()/clearReferenceImages()自体は維持されている(明示的な削除ボタン用)', () => {
  assert.match(html, /function clearImage\(\)\{/);
  assert.match(html, /function clearReferenceImages\(\)\{/);
  // 明示的な削除ボタン(サムネのバツ・参照画像の×)からは引き続き呼ばれる。
  assert.match(html, /\$\('thumbRemove'\)\.addEventListener\('click',clearImage\)/);
  assert.match(html, /data-ref-remove/);
});

test('送信成功後のresetInputs()は維持されている(次のジョブ用に入力を空にする、意図的な挙動)', () => {
  assert.match(html, /function resetInputs\(\)\{\$\('prompt'\)\.value='';clearImage\(\);clearReferenceImages\(\)\}/);
});

// ---------------------------------------------------------------
// text送信時の画像前提文言のすれ違い検知(ハード停止。confirmでの続行はできない)
// ---------------------------------------------------------------

test('IMAGE_RELIANT_PHRASE / textImpliesImageWithoutAttachment が定義されている', () => {
  assert.match(html, /var IMAGE_RELIANT_PHRASE=\/[^/]+\/i;/);
  assert.match(html, /function textImpliesImageWithoutAttachment\(text\)\{/);
});

test('textImpliesImageWithoutAttachment: textモードのときだけ判定し、image/referenceモードでは判定しない', () => {
  assert.match(
    html,
    /function textImpliesImageWithoutAttachment\(text\)\{\s*return state\.mode==='text'&&IMAGE_RELIANT_PHRASE\.test\(text\);\s*\}/
  );
});

test('IMAGE_RELIANT_PHRASE(実行テスト): 添付画像系の言い回しにマッチする', () => {
  const start = html.indexOf('var IMAGE_RELIANT_PHRASE=');
  const end = html.indexOf(';', start);
  const src = html.slice(start, end + 1);
  const regex = new Function(`${src}\nreturn IMAGE_RELIANT_PHRASE;`)();

  // 過去の実際の事故で使用された文章そのもの(一般化した短文へ置き換えない)。
  assert.ok(regex.test('添付画像の女性を主人公にしてください'));
  assert.ok(regex.test('参照画像の振り返りに近い顔のアップ'));

  assert.ok(regex.test('添付画像のキャラクター'));
  assert.ok(regex.test('参照画像の服装を維持'));
  assert.ok(regex.test('この画像の男性'));
  assert.ok(regex.test('画像1の髪型'));
  assert.ok(regex.test('画像１の髪型')); // 全角数字
  assert.ok(regex.test('Image 1の人物'));
  assert.ok(regex.test('参照画像を使って'));
  assert.ok(regex.test('参照画像を基準に'));
  assert.ok(regex.test('参照画像から始める'));
  assert.ok(regex.test('添付した画像を使って'));
  assert.ok(regex.test('この画像を使って'));
});

test('IMAGE_RELIANT_PHRASE(実行テスト): 単なる言及・否定表現にはマッチしない(過剰検知しない)', () => {
  const start = html.indexOf('var IMAGE_RELIANT_PHRASE=');
  const end = html.indexOf(';', start);
  const src = html.slice(start, end + 1);
  const regex = new Function(`${src}\nreturn IMAGE_RELIANT_PHRASE;`)();

  // 「〜について説明する」のような単なる言及や、「を使わない」等の否定は、
  // 画像との所有・参照関係を示す後続表現(の/を/から/と同じ/に写る・に映る)
  // が続かないため一致しない。
  assert.ok(!regex.test('この画像生成AIについて説明する'));
  assert.ok(!regex.test('参照画像について説明する'));
  assert.ok(!regex.test('参照画像を使わない'));
  assert.ok(!regex.test('この画像は不要'));
  assert.ok(!regex.test('画像なしで生成する'));
  assert.ok(!regex.test('画像という文字を表示する'));
  assert.ok(!regex.test('夕暮れの海辺を走る白い馬。カメラは低い位置から横移動で追いかける。'));
  assert.ok(!regex.test('通常のテキストプロンプトです。'));
});

// クライアント側とサーバー側の正規表現が将来ずれないよう、source/flagsが
// 完全一致することを機械的に確認する(手作業でのコメント同期に頼らない)。
test('IMAGE_RELIANT_PHRASE: h3-max-beta.htmlとapi/h3-live/start.jsで完全に同一の正規表現である', () => {
  const start = html.indexOf('var IMAGE_RELIANT_PHRASE=');
  const end = html.indexOf(';', start);
  const clientSrc = html.slice(start, end + 1);
  const clientRegex = new Function(`${clientSrc}\nreturn IMAGE_RELIANT_PHRASE;`)();

  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-live', 'start.js'), 'utf8');
  const serverStart = serverJs.indexOf('const IMAGE_RELIANT_PHRASE =');
  assert.ok(serverStart > -1, 'IMAGE_RELIANT_PHRASE not found in api/h3-live/start.js');
  const serverEnd = serverJs.indexOf(';', serverStart);
  const serverSrc = serverJs.slice(serverStart, serverEnd + 1).replace('const IMAGE_RELIANT_PHRASE =', 'var IMAGE_RELIANT_PHRASE=');
  const serverRegex = new Function(`${serverSrc}\nreturn IMAGE_RELIANT_PHRASE;`)();

  assert.equal(clientRegex.source, serverRegex.source, 'regex source (pattern) must match exactly');
  assert.equal(clientRegex.flags, serverRegex.flags, 'regex flags must match exactly');
});

test('send(): textImpliesImageWithoutAttachment時はconfirmで続行させず、notice()で停止する(生成事故防止)', () => {
  assert.match(sendSrc, /if\(textImpliesImageWithoutAttachment\(text\)\)\{/);
  assert.doesNotMatch(sendSrc, /window\.confirm\(/);
  assert.match(sendSrc, /notice\('「添付画像」など画像を前提にした文章です。画像モードで画像を追加してから生成してください。',true\);/);
});

test('send(): 既存の画像未添付ブロック(mode===\'image\'/isMultiMode)は維持されている', () => {
  assert.match(sendSrc, /if\(state\.mode==='image'&&!state\.uploadId\)\{notice\('先に画像を追加してください。',true\);return\}/);
  assert.match(sendSrc, /if\(isMultiMode\(\)&&\(!state\.refImages\.length\|\|state\.refImages\.some/);
});

test('send(): 画像確認の警告は既存の画像モードブロックより後にあり、それを置き換えていない', () => {
  const imageBlockIdx = sendSrc.indexOf("if(state.mode==='image'&&!state.uploadId)");
  const warnIdx = sendSrc.indexOf('textImpliesImageWithoutAttachment(text)');
  assert.ok(imageBlockIdx > -1 && warnIdx > imageBlockIdx, 'warning must come after the existing image-mode guard');
});
