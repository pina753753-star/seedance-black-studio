'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hasSeedance25PlanAccess,
  getSeedance25Entitlement
} = require('../api/_lib/video-plan-entitlements.js');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing.js');

test('Seedance 2.5は有効期限内のPremium以上だけを許可する', () => {
  const now = Date.parse('2026-08-21T00:00:00Z');
  const future = '2026-09-21T00:00:00Z';
  const past = '2026-07-21T00:00:00Z';
  for (const plan of ['premium', 'ultimate', 'team', 'scale']) {
    assert.equal(hasSeedance25PlanAccess(plan, future, now), true, plan);
  }
  for (const plan of ['free', 'standard', '', null]) {
    assert.equal(hasSeedance25PlanAccess(plan, future, now), false, String(plan));
  }
  assert.equal(hasSeedance25PlanAccess('premium', past, now), false);
  assert.equal(hasSeedance25PlanAccess('team', null, now), false);
});

test('DBエラー時はプランを推測せず安全側で停止する', async () => {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    async maybeSingle() { return { data: null, error: new Error('unavailable') }; }
  };
  const result = await getSeedance25Entitlement({ from() { return chain; } }, 'user-1');
  assert.deepEqual(result, { ok: false, allowed: false, plan: 'free', error: 'plan_lookup_failed' });
});

test('DB照会が例外になっても安全側で停止する', async () => {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    async maybeSingle() { throw new Error('connection failed'); }
  };
  const result = await getSeedance25Entitlement({ from() { return chain; } }, 'user-1');
  assert.deepEqual(result, { ok: false, allowed: false, plan: 'free', error: 'plan_lookup_failed' });
});

test('TeamもSeedance 2.5の表示料金は他の対象プランと同じにする', () => {
  assert.equal(calculateVideoCreditCost({ model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 5, plan: 'team' }), 100);
  assert.equal(calculateVideoCreditCost({ model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 15, plan: 'team' }), 300);
  assert.equal(calculateVideoCreditCost({ model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 30, plan: 'team' }), 600);
  assert.equal(calculateVideoCreditCost({ model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 15, plan: 'premium' }), 300);
  assert.equal(
    calculateVideoCreditCost({ model: 'bytedance/seedance-2.0', resolution: '720p', duration: 5, plan: 'team' }),
    calculateVideoCreditCost({ model: 'bytedance/seedance-2.0', resolution: '720p', duration: 5, plan: 'premium' })
  );
});

test('開始APIと音源アップロードAPIの両方がサーバー側でプラン確認する', () => {
  const root = path.join(__dirname, '..');
  const start = fs.readFileSync(path.join(root, 'api/_lib/seedance-start.js'), 'utf8');
  const upload = fs.readFileSync(path.join(root, 'api/reference-audio-upload-url.js'), 'utf8');
  assert.match(start, /getSeedance25Entitlement\(db, user\.id\)/);
  assert.match(start, /seedance_25_plan_required/);
  assert.match(upload, /getSeedance25Entitlement\(auth\.supabase, auth\.user\.id\)/);
  assert.match(upload, /seedance_25_plan_required/);
});

test('開始APIは外部送信・タスク作成・クレジット消費より先にプラン確認する', () => {
  const start = fs.readFileSync(path.join(__dirname, '..', 'api/_lib/seedance-start.js'), 'utf8');
  const entitlementIndex = start.indexOf('getSeedance25Entitlement(db, user.id)');
  assert.ok(entitlementIndex >= 0);
  for (const laterOperation of [
    'moderateContent(',
    'createTask(db,',
    'checkAndDeduct(db,',
    'fetch(providerEndpoint'
  ]) {
    const operationIndex = start.indexOf(laterOperation, entitlementIndex);
    assert.ok(operationIndex > entitlementIndex, `${laterOperation} must run after the plan gate`);
  }
});

test('料金ページはPremium以上の特典と年額合計・毎月付与を表示する', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');
  assert.match(source, /Seedance 2\.5・1080p・曲アップロード/);
  assert.doesNotMatch(source, /Seedance 2\.5の消費クレジット5%オフ/);
  assert.match(source, /annualCredits:'9,600'/);
  assert.match(source, /annualCredits:'25,200'/);
  assert.match(source, /annualCredits:'61,200'/);
  assert.match(source, /年間合計クレジット/);
  assert.match(source, /毎月 \$\{p\.credits\} credits付与/);
});
