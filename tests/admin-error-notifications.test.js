'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const script = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] || '';
const logic = script.slice(script.indexOf('function taskFacts'), script.indexOf('function matchesTaskFilter'));
const context = {
  Date,
  esc(value) {
    return String(value ?? '').replace(/[&<>"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[character]);
  },
  fmt: (value) => String(value),
  statusLabel: (value) => String(value),
  profilesCache: [],
  creditsCache: []
};
vm.createContext(context);
vm.runInContext(`${logic}\nthis.taskFacts=taskFacts;this.taskLedgerFacts=taskLedgerFacts;this.currentTaskClass=currentTaskClass;this.classifyTaskIssue=classifyTaskIssue;this.issueKey=issueKey;this.handlingState=handlingState;this.automaticHandlingLabel=automaticHandlingLabel;this.buildSupportRequest=buildSupportRequest;this.issueCard=issueCard;`, context);

test('終了済みの失敗を現在異常ではなく過去失敗として扱う', () => {
  assert.equal(context.currentTaskClass({ status: 'failed', credit_cost: 0 }), 'Historical');
  assert.equal(context.currentTaskClass({ status: 'queued', error_message: 'provider failed' }), 'Error');
});

test('完了済みで動画URLがないタスクを状態不整合として扱う', () => {
  const task = { status: 'completed', output_url: '' };
  assert.equal(context.currentTaskClass(task), 'Error');
  assert.equal(context.classifyTaskIssue(task).label, '状態不整合');
});

test('生のエラーを運用向けの8分類へ変換する', () => {
  const cases = [
    ['InputImageSensitiveContentDetected.PrivacyInformation real person', '実在人物・プライバシー判定'],
    ['moderation policy flagged', '安全確認エラー'],
    ['OpenRouter generation failed', '生成元エラー'],
    ['request timeout 503', '通信エラー'],
    ['credit refund failed', 'クレジット・返金エラー'],
    ['watermark storage save failed', '動画保存エラー'],
    ['status mismatch', '状態不整合'],
    ['', '原因未記録']
  ];
  for (const [error_message, expected] of cases) {
    assert.equal(context.classifyTaskIssue({ status: 'failed', error_message }).label, expected);
  }
});

test('同じタスクでも状態更新後は新しい通知として識別できる', () => {
  const before = context.issueKey({ id: 'task-1', status: 'queued', updated_at: '2026-08-04T01:00:00Z' });
  const after = context.issueKey({ id: 'task-1', status: 'failed', updated_at: '2026-08-04T01:01:00Z' });
  assert.notEqual(before, after);
});

test('通知の確認済みキーへ生のエラー文を保存しない', () => {
  const key = context.issueKey({
    id: 'task-1',
    status: 'failed',
    updated_at: '2026-08-04T01:01:00Z',
    error_message: '保存してはいけない詳細'
  });
  assert.doesNotMatch(key, /保存してはいけない詳細/);
});

test('ユーザー識別子と生のエラーをHTMLとして実行できない形にする', () => {
  const html = context.issueCard({
    id: 'task-1',
    user_id: '<img src=x onerror=alert(1)>',
    status: 'failed',
    error_message: '<script>alert(1)</script>'
  }, '現在異常');
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('通知UIと閲覧専用の確認済み保存を備える', () => {
  assert.match(source, /id="notificationBtn"/);
  assert.match(source, /id="notificationCount"/);
  // 生成エラーとmoderation_blocksの確認済みキーは、保存先(localStorageの
  // キー名)そのものを完全に分離している。moderation_blocks専用の初回
  // 基準化(旧initializeModAlertBaseline/MOD_ALERT_INITIALIZED_KEY)は廃止
  // した。保存先が最初から別なので、導入時点の既存ブロックは基準化なしに
  // 素直に「未確認」として扱われる。
  assert.match(source, /pinaAdminAcknowledgedIssuesV1/);
  assert.match(source, /pinaAdminAcknowledgedModerationBlocksV1/);
  assert.match(script, /function initializeAlertBaseline\(\)/);
  assert.doesNotMatch(script, /function initializeModAlertBaseline/);
  assert.doesNotMatch(source, /MOD_ALERT_INITIALIZED_KEY/);
  assert.match(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /localStorage[\s\S]{0,200}client\.from\([^)]*\)\.(insert|update|delete)/);
});

test('確認済みキーの読み書きは保存先(storageKey)を切り替えられ、生成エラー側の初回基準化は維持する', () => {
  assert.match(script, /function readAcknowledgedIssueKeys\(storageKey\)/);
  assert.match(script, /function writeAcknowledgedIssueKeys\(keys,storageKey\)/);
  assert.match(script, /writeAcknowledgedIssueKeys\(\[\.\.\.readAcknowledgedIssueKeys\(\),\.\.\.opsActionCache\.map\(issueKey\)\]\)/);
  // moderation_blocks側はもう一括初回基準化を行わない。
  assert.doesNotMatch(script, /modBlocksCache\.map\(issueKey\).*ALERT_INITIALIZED/);
});

test('moderation_blocksの初回基準化は行わない(loadOpsからinitializeModAlertBaselineの呼び出しを削除)', () => {
  assert.doesNotMatch(script, /initializeModAlertBaseline/);
  assert.match(script, /await loadModerationBlocks\(\);/);
  // 生成エラー側の初回基準化はmoderation_blocksの取得成否と無関係に確定する。
  assert.match(script, /initializeAlertBaseline\(\);[\s\S]{0,300}await loadModerationBlocks\(\);/);
});

test('デフォルト引数の評価がtry\\/catchの外側になり、例外が握りつぶされなくなる回帰を防ぐ', () => {
  // storageKey=ALERT_STORAGE_KEYのようにデフォルト引数の式で外部定数を
  // 直接参照すると、その式はtry/catchの外側(パラメータ束縛の段階)で評価
  // されるため、ALERT_STORAGE_KEY未定義環境で未処理の例外になってしまう。
  // storageKeyのデフォルト値解決は必ずtry/catchの内側で行う。
  assert.doesNotMatch(script, /function readAcknowledgedIssueKeys\(storageKey=ALERT_STORAGE_KEY\)/);
  assert.doesNotMatch(script, /function writeAcknowledgedIssueKeys\(keys,storageKey=ALERT_STORAGE_KEY\)/);
  assert.match(script, /function readAcknowledgedIssueKeys\(storageKey\)\{try\{const key=storageKey\|\|ALERT_STORAGE_KEY/);
  assert.match(script, /function writeAcknowledgedIssueKeys\(keys,storageKey\)\{try\{const key=storageKey\|\|ALERT_STORAGE_KEY/);
});

test('返金記録と自動再生成なしを過去失敗へ表示する', () => {
  context.creditsCache.push({ related_task_id: 'task-1', amount: -80, credit_type: 'free', reason: 'video_generation' });
  context.creditsCache.push({ related_task_id: 'task-1', amount: 80, credit_type: 'free', reason: 'generation_refund' });
  const task = { id: 'task-1', status: 'failed' };
  assert.match(context.automaticHandlingLabel(task), /自動対応済み/);
  assert.match(context.issueCard(task, '過去の失敗'), /自動再生成：なし/);
});

test('失敗を自動対応済み・対応必要へ安全に分ける', () => {
  context.creditsCache.length = 0;
  assert.equal(context.handlingState({ id: 'free', status: 'failed', credit_cost: 0 }).kind, 'resolved');
  assert.equal(context.handlingState({ id: 'not-charged', status: 'failed', credit_cost: 245 }).kind, 'resolved');
  context.creditsCache.push({ related_task_id: 'paid', amount: -80, credit_type: 'free', reason: 'video_generation' });
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'action');
  context.creditsCache.push({ related_task_id: 'paid', amount: 80, credit_type: 'free', reason: 'generation_refund' });
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'resolved');
});

test('返金は合計だけでなくクレジット種類ごとの一致を確認する', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push(
    { related_task_id: 'task-pools', amount: -50, credit_type: 'subscription', reason: 'video_generation' },
    { related_task_id: 'task-pools', amount: -30, credit_type: 'free', reason: 'video_generation' },
    { related_task_id: 'task-pools', amount: 80, credit_type: 'free', reason: 'generation_refund' }
  );
  const ledger = context.taskLedgerFacts({ id: 'task-pools' });
  assert.equal(ledger.charged, 80);
  assert.equal(ledger.refunded, 80);
  assert.equal(ledger.code, 'partial_refund');
  assert.equal(context.handlingState({ id: 'task-pools', status: 'failed' }).kind, 'action');
});

test('料金差額返金と失敗返金の合計が消費額と一致すれば返金済みにする', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push(
    { related_task_id: 'task-cost-refund', amount: -100, credit_type: 'free', reason: 'video_generation' },
    { related_task_id: 'task-cost-refund', amount: 20, credit_type: 'free', reason: 'cost_based_refund' },
    { related_task_id: 'task-cost-refund', amount: 80, credit_type: 'free', reason: 'generation_refund' }
  );
  const ledger = context.taskLedgerFacts({ id: 'task-cost-refund' });
  assert.equal(ledger.charged, 100);
  assert.equal(ledger.refunded, 100);
  assert.equal(ledger.code, 'refunded');
  assert.equal(context.handlingState({ id: 'task-cost-refund', status: 'failed' }).kind, 'resolved');
});

test('不明なクレジット種類を消費なしと誤判定しない', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-unknown-pool', amount: -80, credit_type: 'unknown', reason: 'video_generation' });
  const ledger = context.taskLedgerFacts({ id: 'task-unknown-pool' });
  assert.equal(ledger.charged, 80);
  assert.equal(ledger.code, 'inconsistent');
  assert.equal(context.handlingState({ id: 'task-unknown-pool', status: 'failed' }).kind, 'action');
});

test('放置タスクは2時間15分までは自動復旧中、それを超えたら対応必要', () => {
  const now = Date.now();
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 60 * 60 * 1000).toISOString() }).kind, 'monitoring');
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 136 * 60 * 1000).toISOString() }).kind, 'action');
});

test('対応依頼には調査情報と安全な停止条件をまとめる', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-9', amount: -80, credit_type: 'free', reason: 'video_generation' });
  const request = context.buildSupportRequest({ id: 'task-9', status: 'failed', credit_cost: 80, error_message: 'refund failed' });
  assert.match(request, /タスクID: task-9/);
  assert.match(request, /予定クレジット: 80/);
  assert.match(request, /消費記録: 80クレジット（1件）/);
  assert.match(request, /返金記録: 0クレジット（0件）/);
  assert.match(request, /クレジット判定: 返金記録なし/);
  assert.match(request, /私の承認前に実行しないでください/);
});

test('赤いカードはコピー・確認済みだけを出し、意味が曖昧な個別再確認を出さない', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-10', amount: -80, credit_type: 'free', reason: 'video_generation' });
  const html = context.issueCard({ id: 'task-10', status: 'failed', credit_cost: 80 });
  assert.match(html, /あなたの対応/);
  assert.doesNotMatch(html, /今すぐ再確認/);
  assert.match(html, /対応依頼をコピー/);
  assert.match(html, /通知を確認済みにする/);
});

test('画面表示中だけ60秒ごとに運用データを自動更新する', () => {
  assert.match(script, /OPS_REFRESH_MS=60000/);
  assert.match(script, /document\.visibilityState==='hidden'/);
  assert.match(script, /setInterval\(autoRefreshOps,OPS_REFRESH_MS\)/);
  assert.match(script, /opsRefreshInFlight/);
});

test('一覧に分類・要約・対処・ユーザー・生のエラーを表示する', () => {
  assert.match(script, /type\.label/);
  assert.match(script, /type\.summary/);
  assert.match(script, /確認すること/);
  assert.match(script, /対象ユーザー/);
  assert.match(script, /生のエラー/);
});

test('通知は対応が必要な項目とブロック記録だけを数え、開くだけでは確認済みにしない', () => {
  // 通知バッジはopsActionCache/modBlocksCacheをそれぞれ別の確認済み
  // キーセットと直接照合して未確認件数を合算する(合算キャッシュの
  // alertRowsCacheは廃止済み)。
  assert.match(script, /function updateNotificationBadge\(\)\{const ackGeneration=new Set\(readAcknowledgedIssueKeys\(\)\),ackModeration=new Set\(readAcknowledgedIssueKeys\(MOD_ALERT_STORAGE_KEY\)\)/);
  assert.doesNotMatch(script, /if\(name==='ops'\)acknowledgeCurrentErrors/);
  assert.match(script, /function acknowledgeIssue/);
});

test('再確認は既存の読み取り処理だけを呼び、書き込み処理を追加しない', () => {
  assert.match(script, /async function recheckOpsNow[\s\S]*await loadOps\(\)/);
  assert.doesNotMatch(script, /recheckOpsNow[\s\S]{0,500}client\.from\([^)]*\)\.(insert|update|delete)/);
  assert.match(source, /最新状態に更新/);
});

test('返金照合は全体最新50件ではなく最新100タスクのIDへ絞って読み取る', () => {
  assert.match(script, /fetchTaskCreditRows\(opsRowsCache\.map\(t=>t\.id\)\.filter\(Boolean\)\)/);
  assert.match(script, /\.in\('related_task_id',ids\)/);
  assert.match(script, /\.in\('reason',reasons\)/);
  assert.match(script, /cost_based_refund/);
  assert.doesNotMatch(script, /credit_transactions'[\s\S]{0,220}\.limit\(50\)/);
  assert.doesNotMatch(script, /fetchTaskCreditRows[\s\S]{0,900}\.(insert|update|delete)\(/);
});

test('スマホ幅では通知追加後もヘッダーを縮める指定がある', () => {
  const mobileCss = source.match(/@media\(max-width:430px\)\{([^}]|\}(?!\s*<\/style>))*\}/)?.[0] || '';
  assert.match(mobileCss, /\.brand small\{display:none\}/);
  assert.match(mobileCss, /\.logo\{width:36px;height:36px;min-width:36px/);
  assert.match(mobileCss, /\.notificationBtn\{min-width:39px;height:39px\}/);
  assert.match(mobileCss, /\.logoutBtn\{padding:9px;font-size:11px\}/);
});

// ---- ここから: moderation_blocksの通知統合・classification詳細・
// 過剰ブロック検出・フィルター・件数案内の追加分 ----

test('classification(11項目)がfictional-action-classifier.jsのREQUIRED_BOOLEAN_FIELDSと一致する', () => {
  const classifierSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'fictional-action-classifier.js'),
    'utf8'
  );
  const fieldsMatch = classifierSource.match(/const REQUIRED_BOOLEAN_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(fieldsMatch, 'REQUIRED_BOOLEAN_FIELDSが見つかりません');
  const expectedFields = fieldsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.equal(expectedFields.length, 11);
  const adminFieldsMatch = script.match(/CLASSIFICATION_FIELDS=\[([\s\S]*?)\];/);
  assert.ok(adminFieldsMatch, 'admin.htmlにCLASSIFICATION_FIELDSが見つかりません');
  const adminFields = adminFieldsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.deepEqual(adminFields, expectedFields);
});

test('classification詳細をブロックカードのdetailsに表示する', () => {
  assert.match(script, /function classificationDetail\(c\)/);
  assert.match(script, /classification詳細を表示（11項目）/);
  assert.match(script, /classification,prompt,created_at/);
});

test('同一カテゴリが30分以内に2件以上発生した場合を過剰ブロックの疑いとして検出し、対象時間帯外の同カテゴリカードは対象にしない', () => {
  assert.match(script, /EXCESSIVE_BLOCK_WINDOW_MS=30\*60\*1000/);
  assert.match(script, /function detectExcessiveRowIds\(rows\)/);
  assert.match(script, /過剰ブロックの疑い/);
  assert.match(script, /modExcessiveRowIds=detectExcessiveRowIds\(modBlocksCache\)/);
  // カテゴリ単位のSetをそのまま各カードの判定に使っていた実装(修正前)を
  // 復活させていないことを確認する。行id単位のSetへ切り替えたことで、
  // 同じカテゴリでも30分の対象時間帯から外れたカードは強調されない。
  assert.doesNotMatch(script, /categories\.some\(c=>modExcessiveRowIds\.has\(c\)\)/);
  assert.match(script, /excessive=modExcessiveRowIds\.has\(r\.id\)/);

  const detectSource = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const detectMatch = detectSource.match(/function detectExcessiveRowIds\(rows\)\{([\s\S]*?)\n\}/);
  assert.ok(detectMatch, 'detectExcessiveRowIdsの本体が見つかりません');
  const detectFn = new Function('EXCESSIVE_BLOCK_WINDOW_MS', `${detectMatch[0]}\nreturn detectExcessiveRowIds;`)(30 * 60 * 1000);
  const base = new Date('2026-08-20T00:00:00Z').getTime();
  const rows = [
    { id: 'old-1', categories: ['sexual'], created_at: new Date(base).toISOString() },
    { id: 'old-2', categories: ['sexual'], created_at: new Date(base + 5 * 60 * 1000).toISOString() },
    // old-1/old-2から3時間後: 同じカテゴリだが対象時間帯の外
    { id: 'recent-1', categories: ['sexual'], created_at: new Date(base + 3 * 60 * 60 * 1000).toISOString() }
  ];
  const flagged = detectFn(rows);
  assert.equal(flagged.has('old-1'), true);
  assert.equal(flagged.has('old-2'), true);
  assert.equal(flagged.has('recent-1'), false, '対象時間帯外の同カテゴリカードまでflaggedにしてはいけない');
});

test('ブロックカードにも確認済みボタンと通知キーがある(moderation専用の保存先・data-issue-type)', () => {
  assert.match(script, /function modBlockCard\(r\)\{[\s\S]{0,600}data-issue-action="ack" data-issue-type="moderation"/);
  assert.match(script, /key=issueKey\(r\)/);
  // ブロックカードの「確認済み」判定はmoderation専用の保存先を見る。
  assert.match(script, /acknowledged=new Set\(readAcknowledgedIssueKeys\(MOD_ALERT_STORAGE_KEY\)\)\.has\(key\)/);
  assert.match(script, /通知を確認済みにする/);
  // 生成エラーカード側もdata-issue-type="generation"を明示している。
  assert.match(script, /data-issue-action="ack" data-issue-type="generation"/);
  // acknowledgeIssue()はopsActionList(renderOpsGroups)とmodBlockList
  // (renderModBlocks)の両方を再描画し、確認済みボタンの表示を即時反映する。
  assert.match(script, /function acknowledgeIssue\(key,type='generation'\)\{[\s\S]{0,300}renderOpsGroups\(\);renderModBlocks\(\);/);
});

test('ブロック理由・モード・ユーザーで絞り込める', () => {
  assert.match(script, /function matchesModFilter\(r\)/);
  assert.match(script, /modReasonFilter/);
  assert.match(script, /modModeFilter/);
  assert.match(source, /id="modUserFilterInput"/);
  assert.match(script, /data-mod-reason-filter/);
  assert.match(script, /data-mod-mode-filter/);
});

test('生成エラー一覧・ブロック一覧の両方に、取得件数に関わらず100件上限の案内を出す', () => {
  assert.match(source, /id="opsActionCountNote"/);
  assert.match(source, /id="modBlockCountNote"/);
  assert.match(script, /最新100件までを取得します。現在\$\{opsRowsCache\.length\}件を取得/);
  assert.match(script, /最新100件までを取得します。現在\$\{modBlocksCache\.length\}件を取得/);
});

test('新規追加分もDBへのinsert/update/deleteを一切行わない(読み取り専用を維持)', () => {
  const newLogicStart = script.indexOf('function tallyModBlockCategories');
  const newLogicEnd = script.indexOf('async function loadOps');
  const newLogic = script.slice(newLogicStart, newLogicEnd);
  assert.ok(newLogic.length > 0);
  assert.doesNotMatch(newLogic, /\.(insert|update|delete)\(/);
});

// --- ここから、バッジ集計・確認済み保存・🔔タップ挙動の結合テスト ---
// 上のテスト群は正規表現によるソース検証が中心だが、ここではadmin.htmlの
// <script>全体を実際にvm上で実行し、updateNotificationBadge/acknowledgeIssue/
// openNotificationTargetを本物の関数として呼び出して確認する。

function makeSharedLocalStorage(store) {
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; }
  };
}

function makeFullAdminContext(store) {
  const elements = new Map();
  const scrollLog = [];
  function makeEl(id) {
    const el = {
      id,
      textContent: '',
      hidden: false,
      style: {},
      dataset: {},
      classList: {
        _set: new Set(),
        toggle(name, force) {
          const on = force === undefined ? !this._set.has(name) : !!force;
          if (on) this._set.add(name); else this._set.delete(name);
          return on;
        },
        add(name) { this._set.add(name); },
        remove(name) { this._set.delete(name); },
        contains(name) { return this._set.has(name); }
      },
      addEventListener() {},
      setAttribute() {},
      querySelectorAll: () => [],
      closest: () => null,
      scrollIntoView(options) { scrollLog.push({ id, options }); },
      appendChild() {},
      isConnected: true
    };
    return el;
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  }
  const documentStub = {
    getElementById,
    querySelectorAll: () => [],
    addEventListener() {},
    visibilityState: 'visible'
  };
  const localStorageStub = makeSharedLocalStorage(store);
  const ctx = {
    window: { FLOWVID_AUTH: undefined },
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: '' },
    console,
    Date,
    setInterval: () => {},
    JSON
  };
  vm.createContext(ctx);
  // admin.htmlのopsActionCache/modBlocksCacheはトップレベルlet宣言のため、
  // vmコンテキストオブジェクトへの外部からのプロパティ代入では書き換えられない
  // (グローバルオブジェクトのプロパティではなく、レキシカル束縛のため)。
  // そのため、同一コンテキスト内で束縛を直接書き換えるsetterを公開する。
  vm.runInContext(`${script}\nthis.setCaches=function(action,mod){opsActionCache=action;modBlocksCache=mod};`, ctx);
  return { ctx, elements, scrollLog };
}

function makeModBlockRow(id, minutesAgo) {
  return {
    id,
    categories: ['weapon_instruction'],
    reason: 'weapon_instruction',
    mode: 'image',
    created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    prompt: 'test',
    classification: {}
  };
}

test('初回表示時に既存ブロック4件があれば通知バッジは4件になる', () => {
  const store = {};
  const { ctx, elements } = makeFullAdminContext(store);
  const rows = [
    makeModBlockRow('b1', 10),
    makeModBlockRow('b2', 20),
    makeModBlockRow('b3', 30),
    makeModBlockRow('b4', 40)
  ];
  ctx.setCaches([], rows);
  ctx.updateNotificationBadge();
  assert.equal(elements.get('notificationCount').textContent, '4');
  assert.equal(elements.get('notificationCount').hidden, false);
});

test('1件を確認済みにすると通知バッジは3件になる', () => {
  const store = {};
  const { ctx, elements } = makeFullAdminContext(store);
  const rows = [
    makeModBlockRow('b1', 10),
    makeModBlockRow('b2', 20),
    makeModBlockRow('b3', 30),
    makeModBlockRow('b4', 40)
  ];
  ctx.setCaches([], rows);
  ctx.updateNotificationBadge();
  assert.equal(elements.get('notificationCount').textContent, '4');
  const key = ctx.issueKey(rows[0]);
  ctx.acknowledgeIssue(key, 'moderation');
  assert.equal(elements.get('notificationCount').textContent, '3');
});

test('再読み込み(localStorage永続化)後も確認済み件数は保たれ、バッジは3件のままになる', () => {
  const store = {};
  const rows = [
    makeModBlockRow('b1', 10),
    makeModBlockRow('b2', 20),
    makeModBlockRow('b3', 30),
    makeModBlockRow('b4', 40)
  ];

  // 1回目のロード相当: 1件確認済みにする。
  {
    const { ctx } = makeFullAdminContext(store);
    ctx.setCaches([], rows);
    ctx.updateNotificationBadge();
    ctx.acknowledgeIssue(ctx.issueKey(rows[0]), 'moderation');
  }

  // 2回目=再読み込み相当: 同じstore(localStorage)を共有した新しいvmコンテキストを作る。
  {
    const { ctx, elements } = makeFullAdminContext(store);
    ctx.setCaches([], rows);
    ctx.updateNotificationBadge();
    assert.equal(elements.get('notificationCount').textContent, '3');
  }
});

test('新しいブロックが追加されるとバッジは再び4件になる', () => {
  const store = {};
  const rows = [
    makeModBlockRow('b1', 10),
    makeModBlockRow('b2', 20),
    makeModBlockRow('b3', 30)
  ];
  const { ctx, elements } = makeFullAdminContext(store);
  ctx.setCaches([], rows);
  ctx.updateNotificationBadge();
  assert.equal(elements.get('notificationCount').textContent, '3');
  ctx.acknowledgeIssue(ctx.issueKey(rows[0]), 'moderation');
  assert.equal(elements.get('notificationCount').textContent, '2');
  const rowsWithNew = [...rows, makeModBlockRow('b4', 1)];
  ctx.setCaches([], rowsWithNew);
  ctx.updateNotificationBadge();
  assert.equal(elements.get('notificationCount').textContent, '3');
});

test('🔔タップ(openNotificationTarget)は未確認項目が残っているセクションへスクロールする', () => {
  const store = {};

  // ケース1: 未確認の生成エラーがあれば生成エラーセクションへ。
  {
    const { ctx, scrollLog } = makeFullAdminContext(store);
    const task = { id: 't1', status: 'failed', error_message: 'x', updated_at: new Date().toISOString() };
    ctx.setCaches([task], [makeModBlockRow('b1', 10)]);
    ctx.openNotificationTarget();
    assert.equal(scrollLog[scrollLog.length - 1].id, 'opsActionSection');
  }

  // ケース2: 生成エラーはすべて確認済みで、未確認ブロックが残っていればブロックセクションへ。
  {
    const store2 = {};
    const { ctx, scrollLog } = makeFullAdminContext(store2);
    const task = { id: 't1', status: 'failed', error_message: 'x', updated_at: new Date().toISOString() };
    ctx.setCaches([task], [makeModBlockRow('b1', 10)]);
    ctx.acknowledgeIssue(ctx.issueKey(task), 'generation');
    ctx.openNotificationTarget();
    assert.equal(scrollLog[scrollLog.length - 1].id, 'modBlockSection');
  }

  // ケース3: どちらも未確認がなければ運用監視概要へ。
  {
    const store3 = {};
    const { ctx, scrollLog } = makeFullAdminContext(store3);
    const task = { id: 't1', status: 'failed', error_message: 'x', updated_at: new Date().toISOString() };
    const block = makeModBlockRow('b1', 10);
    ctx.setCaches([task], [block]);
    ctx.acknowledgeIssue(ctx.issueKey(task), 'generation');
    ctx.acknowledgeIssue(ctx.issueKey(block), 'moderation');
    ctx.openNotificationTarget();
    assert.equal(scrollLog[scrollLog.length - 1].id, 'opsSummarySection');
  }
});
