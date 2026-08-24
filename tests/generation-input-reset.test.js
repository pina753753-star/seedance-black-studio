'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'generate-prod.html'), 'utf8');
const helperStart = source.indexOf('function clearAcceptedGenerationInputs(');
const helperEnd = source.indexOf('function roundUpToFive(', helperStart);
const helperSource = source.slice(helperStart, helperEnd);

function createHarness({ mode, prompt, draft, imgAsset = null, assets = [], sbLocked = false, storyboardImageUrl = '' }) {
  const storage = new Map([['flowvidGenerateDraft', JSON.stringify(draft)]]);
  const context = {
    JSON,
    URL: { revokeObjectURL() {} },
    elements: { prompt: { value: prompt }, file: { value: 'selected' } },
    storage,
    initialMode: mode,
    initialImgAsset: imgAsset,
    initialAssets: assets,
    initialSbLocked: sbLocked,
    initialStoryboardImageUrl: storyboardImageUrl
  };
  vm.createContext(context);
  vm.runInContext(`
    const DRAFT_KEY='flowvidGenerateDraft';
    let mode=initialMode;
    let imgAsset=initialImgAsset;
    let assets=initialAssets;
    let sbLocked=initialSbLocked;
    let sbGenerationImageUrl=initialStoryboardImageUrl;
    let urls=assets.filter(a=>a.status==='completed'&&a.url).map(a=>a.url);
    let renderCount=0;
    let storyboardResetCount=0;
    function $(id){return elements[id]||null}
    function readDraft(){return JSON.parse(storage.get(DRAFT_KEY)||'{}')}
    const localStorage={setItem(key,value){storage.set(key,value)}};
    function currentModeAssetList(){return mode==='image_to_video'?(imgAsset?[imgAsset]:[]):assets}
    function syncUrlsFromAssets(){urls=assets.filter(a=>a.status==='completed'&&a.url).map(a=>a.url)}
    function renderAssets(){renderCount++}
    function resetStoryboardInputs(){storyboardResetCount++;elements.prompt.value='';sbGenerationImageUrl=''}
    ${helperSource}
    this.runReset=clearAcceptedGenerationInputs;
    this.getState=()=>({
      prompt:elements.prompt.value,
      file:elements.file.value,
      draft:readDraft(),
      imgAsset,
      assets,
      urls,
      renderCount,
      storyboardResetCount,
      sbGenerationImageUrl
    });
  `, context);
  return context;
}

test('受付成功後は前後に空白があるプロンプトと画像を初期化する', () => {
  const rawPrompt = '  夏空を飛ぶクジラ\n';
  const context = createHarness({
    mode: 'image_to_video',
    prompt: rawPrompt,
    draft: { prompt_image_to_video: rawPrompt },
    imgAsset: { id: 'image-1', status: 'completed', url: 'https://example.com/image.png', objectUrl: 'blob:image-1' }
  });

  context.runReset({
    mode: 'image_to_video',
    rawPrompt,
    storyboardLocked: false,
    assetIds: ['image-1']
  });

  const state = context.getState();
  assert.equal(state.prompt, '');
  assert.equal(state.file, '');
  assert.equal(state.imgAsset, null);
  assert.equal(state.draft.prompt_image_to_video, undefined);
  assert.equal(state.renderCount, 1);
});

test('テキスト生成も受付成功後はプロンプトと保存済み下書きを初期化する', () => {
  const rawPrompt = '夕焼けの海を進む船';
  const context = createHarness({
    mode: 'text_to_video',
    prompt: rawPrompt,
    draft: { prompt_text_to_video: rawPrompt }
  });

  context.runReset({
    mode: 'text_to_video',
    rawPrompt,
    storyboardLocked: false,
    assetIds: []
  });

  const state = context.getState();
  assert.equal(state.prompt, '');
  assert.equal(state.draft.prompt_text_to_video, undefined);
  assert.equal(state.renderCount, 1);
});

test('送信中に変更した新しいプロンプトと画像は消さない', () => {
  const context = createHarness({
    mode: 'image_to_video',
    prompt: '次に作る動画',
    draft: { prompt_image_to_video: '次に作る動画' },
    imgAsset: { id: 'image-2', status: 'completed', url: 'https://example.com/new.png', objectUrl: 'blob:image-2' }
  });

  context.runReset({
    mode: 'image_to_video',
    rawPrompt: '送信済みの動画',
    storyboardLocked: false,
    assetIds: ['image-1']
  });

  const state = context.getState();
  assert.equal(state.prompt, '次に作る動画');
  assert.equal(state.file, 'selected');
  assert.equal(state.imgAsset.id, 'image-2');
  assert.equal(state.draft.prompt_image_to_video, '次に作る動画');
  assert.equal(state.renderCount, 0);
});

test('送信中にプロンプトだけ変更した場合も元画像を消さない', () => {
  const context = createHarness({
    mode: 'image_to_video',
    prompt: '次に作る動画',
    draft: { prompt_image_to_video: '次に作る動画' },
    imgAsset: { id: 'image-1', status: 'completed', url: 'https://example.com/image.png', objectUrl: 'blob:image-1' }
  });

  context.runReset({
    mode: 'image_to_video',
    rawPrompt: '送信済みの動画',
    storyboardLocked: false,
    assetIds: ['image-1']
  });

  const state = context.getState();
  assert.equal(state.prompt, '次に作る動画');
  assert.equal(state.file, 'selected');
  assert.equal(state.imgAsset.id, 'image-1');
  assert.equal(state.draft.prompt_image_to_video, '次に作る動画');
  assert.equal(state.renderCount, 0);
});

test('送信中に画像だけ変更した場合も次のプロンプトを消さない', () => {
  const rawPrompt = '同じプロンプトで次の画像を作る';
  const context = createHarness({
    mode: 'image_to_video',
    prompt: rawPrompt,
    draft: { prompt_image_to_video: rawPrompt },
    imgAsset: { id: 'image-2', status: 'completed', url: 'https://example.com/new.png', objectUrl: 'blob:image-2' }
  });

  context.runReset({
    mode: 'image_to_video',
    rawPrompt,
    storyboardLocked: false,
    assetIds: ['image-1']
  });

  const state = context.getState();
  assert.equal(state.prompt, rawPrompt);
  assert.equal(state.file, 'selected');
  assert.equal(state.imgAsset.id, 'image-2');
  assert.equal(state.draft.prompt_image_to_video, rawPrompt);
  assert.equal(state.renderCount, 0);
});

test('リファレンス画像は画面・内部URL・保存済み下書きを同時に空にする', () => {
  const rawPrompt = '2人が並んで歩く';
  const context = createHarness({
    mode: 'reference_to_video',
    prompt: rawPrompt,
    draft: {
      prompt_reference_to_video: rawPrompt,
      referenceUrls: ['https://example.com/one.png', 'https://example.com/two.png']
    },
    assets: [
      { id: 'ref-1', status: 'completed', url: 'https://example.com/one.png', objectUrl: '' },
      { id: 'ref-2', status: 'completed', url: 'https://example.com/two.png', objectUrl: '' }
    ]
  });

  context.runReset({
    mode: 'reference_to_video',
    rawPrompt,
    storyboardLocked: false,
    assetIds: ['ref-1', 'ref-2']
  });

  const state = context.getState();
  assert.equal(state.prompt, '');
  assert.deepEqual(Array.from(state.assets), []);
  assert.deepEqual(Array.from(state.urls), []);
  assert.deepEqual(Array.from(state.draft.referenceUrls), []);
  assert.equal(state.draft.prompt_reference_to_video, undefined);
});

test('絵コンテ生成も受付成功後は専用の画像とプロンプトを初期化する', () => {
  const rawPrompt = '絵コンテから作ったプロンプト';
  const imageUrl = 'https://example.com/storyboard.png';
  const context = createHarness({
    mode: 'reference_to_video',
    prompt: rawPrompt,
    draft: {},
    sbLocked: true,
    storyboardImageUrl: imageUrl
  });

  context.runReset({
    mode: 'reference_to_video',
    rawPrompt,
    storyboardLocked: true,
    storyboardImageUrl: imageUrl,
    assetIds: []
  });

  const state = context.getState();
  assert.equal(state.prompt, '');
  assert.equal(state.sbGenerationImageUrl, '');
  assert.equal(state.storyboardResetCount, 1);
});

test('入力初期化はAPI成功と生成ID確認の後だけ実行する', () => {
  const startIndex = source.indexOf('async function start()');
  const startSource = source.slice(startIndex, source.indexOf('function restoreDraft()', startIndex));
  const unsuccessfulReturn = startSource.indexOf("if(!res.ok)");
  const missingIdReturn = startSource.indexOf('if(!jobId&&!pollingUrl)');
  const clearIndex = startSource.indexOf('clearAcceptedGenerationInputs(submission)');

  assert.notEqual(helperStart, -1);
  assert.notEqual(clearIndex, -1);
  assert.ok(unsuccessfulReturn < clearIndex, 'APIエラー判定より前に入力を消してはいけない');
  assert.ok(missingIdReturn < clearIndex, '生成ID確認より前に入力を消してはいけない');
  assert.match(startSource.slice(unsuccessfulReturn, clearIndex), /if\(!res\.ok\)[\s\S]*?return/);
  assert.match(startSource.slice(missingIdReturn, clearIndex), /if\(!jobId&&!pollingUrl\)[\s\S]*?return/);
});

test('絵コンテ受付成功後も生成中カードと受付通知を維持する', () => {
  const resetStart = source.indexOf('function resetStoryboardInputs()');
  const resetSource = source.slice(resetStart, source.indexOf("$('sbRedoBtn').onclick", resetStart));
  const pendingStart = source.indexOf('async function loadPendingTasks()');
  const pendingSource = source.slice(pendingStart, source.indexOf('setTimeout(loadPendingTasks', pendingStart));
  const insertStart = source.indexOf('function _ptInsertCard(');
  const insertSource = source.slice(insertStart, source.indexOf('function _ptUpdateCardId', insertStart));

  assert.match(source, /id="pendingNotice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /_ptShowAccepted\(realId\)/);
  assert.doesNotMatch(resetSource, /pendingSection[^\n]*display='none'/);
  assert.doesNotMatch(pendingSource, /mode==='storyboard'/);
  assert.doesNotMatch(insertSource, /mode==='storyboard'/);
  assert.match(insertSource, /pendingSection'\)\.style\.display='block'/);
  assert.match(pendingSource, /if\(!tasks\.length\)\{if\(!list\.querySelector\('\[data-ptask-id\]'\)\)\$\('pendingSection'\)\.style\.display='none';return\}/);
});

test('生成中カードは進捗・タスクID・完了動画・失敗時の返金状態を表示する', () => {
  assert.match(source, /data-pt-fill/);
  assert.match(source, /data-pt-id-label/);
  assert.match(source, /タスクID: /);
  assert.match(source, /function _ptComplete[\s\S]*?<video controls playsinline/);
  assert.match(source, /function _ptFail[\s\S]*?クレジットは自動返金されました/);
  assert.match(source, /function _ptFail[\s\S]*?返金状況を確認できませんでした/);
});

test('完了カード維持は絵コンテだけに限定し、余分な完了通知を表示しない', () => {
  const completeStart = source.indexOf('function _ptComplete(');
  const completeSource = source.slice(completeStart, source.indexOf('function _ptStartPoll', completeStart));

  assert.match(completeSource, /const isStoryboard=uiMode==='storyboard'/);
  assert.match(completeSource, /if\(isStoryboard\)[\s\S]*?data-pt-complete/);
  assert.match(completeSource, /else\{setTimeout\(\(\)=>\{_ptRemove\(taskId\)/);
  assert.doesNotMatch(completeSource, /動画が完成しました/);
});

test('受付メッセージは絵コンテだけに表示し、通常生成には追加しない', () => {
  const acceptedStart = source.indexOf('function _ptShowAccepted(');
  const acceptedSource = source.slice(acceptedStart, source.indexOf('function _ptSafeErrMsg', acceptedStart));
  const guardStart = source.indexOf('async function guardedStart(');
  const guardSource = source.slice(guardStart, source.indexOf("$('create').onclick", guardStart));

  assert.match(acceptedSource, /data-ptask-ui-mode/);
  assert.match(acceptedSource, /!==['"]storyboard['"]\)return/);
  assert.match(guardSource, /const showStoryboardStatus=sbLocked/);
  assert.match(guardSource, /if\(showStoryboardStatus\)/);
});

test('絵コンテ確定画面は画像1枚だけを表示し、追加枠を隠す', () => {
  const lockStart = source.indexOf('function sbApplyLock(');
  const lockSource = source.slice(lockStart, source.indexOf("$('sbFile').onchange", lockStart));
  const addTileStart = source.indexOf('function updateAddTileUi(');
  const addTileSource = source.slice(addTileStart, source.indexOf('function updateUploadProgressUi', addTileStart));
  const proceedStart = source.indexOf('function sbProceedToCreate(');
  const proceedSource = source.slice(proceedStart, source.indexOf('function resetStoryboardInputs', proceedStart));

  assert.match(lockSource, /addTile\.style\.display=locked\?'none':''/);
  assert.match(addTileSource, /add\.style\.display=sbLocked\?'none'/);
  assert.match(proceedSource, /\$\('file'\)\.multiple=false/);
  assert.match(proceedSource, /modeHint\.style\.display='none'/);
  assert.match(source, /const refUrls=sbLocked\?\[sbGenerationImageUrl\]:urls/);
});

test('絵コンテ案内と受付通知の文字色は白で統一する', () => {
  const confirmMarkup = source.match(/<div id="sbConfirmNotice"[^>]+>/)?.[0] || '';
  const lockMarkup = source.match(/<div id="sbLockNotice"[^>]+>/)?.[0] || '';
  const pendingMarkup = source.match(/<div id="pendingNotice"[^>]+>/)?.[0] || '';

  for (const markup of [confirmMarkup, lockMarkup, pendingMarkup]) {
    assert.match(markup, /color:#fff/);
    assert.doesNotMatch(markup, /color:#(?:86efac|8ed8ff)/);
  }
});

test('絵コンテ由来を送信し、通常生成では送信しない', () => {
  const startIndex = source.indexOf('async function start()');
  const startSource = source.slice(startIndex, source.indexOf('function restoreDraft()', startIndex));
  assert.match(startSource, /const uiMode=sbLocked\?'storyboard':mode/);
  assert.match(startSource, /if\(sbLocked\)body\.ui_origin='storyboard'/);
  assert.doesNotMatch(startSource, /body\.ui_origin='storyboard';[^}]*else/);
});

test('リロード後の絵コンテ生成中タスクと完了履歴をDB情報から復元する', () => {
  const pendingApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'pending-tasks.js'), 'utf8');
  const generatedApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'generated-videos.js'), 'utf8');
  const history = fs.readFileSync(path.join(__dirname, '..', 'flowvid-history.js'), 'utf8');

  assert.match(pendingApi, /created_at,settings/);
  assert.match(pendingApi, /settings\?\.ui_origin === 'storyboard' \? 'storyboard' : task\.mode/);
  assert.match(generatedApi, /settings\?\.ui_origin === 'storyboard'\) return 'storyboard'/);
  assert.match(history, /v==='storyboard'\?'絵コンテ'/);
  assert.match(source, /flowvidLoadHistory\(mode==='storyboard'\?'storyboard':mode\)/);
});

test('絵コンテ由来のDBマーカーは課金前に保存し、失敗時は生成を開始しない', () => {
  const startApi = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'seedance-start.js'), 'utf8');
  const marker = startApi.indexOf("settings: { ui_origin: uiOrigin }");
  const deduction = startApi.indexOf('deduction = await checkAndDeduct', marker);
  const provider = startApi.indexOf('fetch(providerEndpoint', marker);

  assert.notEqual(marker, -1);
  assert.ok(marker < deduction);
  assert.ok(marker < provider);
  assert.match(startApi.slice(marker, deduction), /\.eq\('user_id', user\.id\)[\s\S]*?\.eq\('status', 'queued'\)[\s\S]*?\.is\('api_task_id', null\)[\s\S]*?\.select\('id'\)/);
  assert.match(startApi.slice(marker, deduction), /originRows\.length === 1[\s\S]*?if \(!originSaved\)[\s\S]*?releaseTask[\s\S]*?return res\.status\(500\)/);
});

test('生成IDがない場合は入力を消さず、二重押下をガードする', () => {
  const startIndex = source.indexOf('async function start()');
  const startSource = source.slice(startIndex, source.indexOf('function restoreDraft()', startIndex));
  const missingId = startSource.indexOf('if(!jobId&&!pollingUrl)');
  const clearIndex = startSource.indexOf('clearAcceptedGenerationInputs(submission)');

  assert.ok(missingId < clearIndex);
  assert.match(source, /let generationStartGuard=false/);
  assert.match(source, /if\(generationStartGuard\)return;[\s\S]*?generationStartGuard=true;[\s\S]*?finally\{[\s\S]*?generationStartGuard=false/);
  assert.match(source, /pendingNotice\.textContent='リクエスト送信中'/);
  assert.match(source, /window\.flowvidCreateHandler=guardedStart/);
});

test('モバイルでも生成状態は非表示にされず読み上げ可能', () => {
  const pendingMarkup = source.slice(source.indexOf('<div id="pendingSection"'), source.indexOf('</main>'));
  assert.match(pendingMarkup, /id="pendingNotice"[^>]*aria-live="polite"/);
  assert.match(pendingMarkup, /id="pendingList"/);
  assert.doesNotMatch(source, /@media\(max-width:[^)]+\)[^{]*\{[^}]*#pendingSection[^}]*display\s*:\s*none/);
});
