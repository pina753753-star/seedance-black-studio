'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const maxConfig = require('../api/_lib/h3-live-config.js');
const liveConfig = require('../api/_lib/h3-director-config.js');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260911000000_h3_beta_pricing.sql'),
  'utf8'
);

const BEFORE = '2026-09-14T14:59:59.999Z';
const CUTOFF = '2026-09-14T15:00:00.000Z';

test('H3 Max pricing: 9/14 JSTまでは60、9/15 JSTから130', () => {
  assert.equal(maxConfig.CREDIT_PRICE_SWITCH_AT, CUTOFF);
  assert.equal(maxConfig.currentCreditCost(BEFORE), 60);
  assert.equal(maxConfig.currentCreditCost(CUTOFF), 130);
  assert.equal(maxConfig.currentCreditCost('invalid-date'), 130);
});

test('H3 Max Live pricing: 9/14 JSTまでは110、9/15 JSTから440', () => {
  assert.equal(liveConfig.CREDIT_PRICE_SWITCH_AT, CUTOFF);
  assert.equal(liveConfig.currentCreditCost(BEFORE), 110);
  assert.equal(liveConfig.currentCreditCost(CUTOFF), 440);
  assert.equal(liveConfig.currentCreditCost('invalid-date'), 440);
});

test('DB migration: JSと同じUTC切替時刻を使う', () => {
  assert.match(migration, /2026-09-14 15:00:00\+00/);
  assert.match(migration, /when now\(\) < timestamptz '2026-09-14 15:00:00\+00' then 60/);
  assert.match(migration, /when now\(\) < timestamptz '2026-09-14 15:00:00\+00' then 110/);
});

test('DB migration: H3 Maxの保存価格60/130だけを許可する', () => {
  assert.match(migration, /h3_live_jobs_credit_cost_check[\s\S]*credit_cost in \(60, 130\)/);
  assert.match(migration, /v_credit_cost := public\.h3_max_credit_cost\(\)/);
  assert.match(migration, /'fal', 15, '768p', v_credit_cost/);
  assert.match(migration, /v_remaining := v_job\.credit_cost/);
  assert.match(migration, /'required', v_job\.credit_cost/);
  assert.match(migration, /'refunded_amount', v_job\.credit_cost/);
});

test('DB migration: H3 Max Liveの保存価格110/440だけを許可する', () => {
  assert.match(migration, /h3_director_sessions_credit_cost_check[\s\S]*credit_cost in \(110, 440\)/);
  assert.match(migration, /v_credit_cost := public\.h3_max_live_credit_cost\(\)/);
  assert.match(migration, /aspect_ratio, credit_cost[\s\S]*p_aspect_ratio, v_credit_cost/);
  assert.match(migration, /v_remaining := v_session\.credit_cost/);
  assert.match(migration, /'required', v_session\.credit_cost/);
  assert.match(migration, /'refunded_amount',v_session\.credit_cost/);
});

test('DB migration: 課金・返金RPCの実額は現在時刻ではなく予約時credit_costを使う', () => {
  assert.doesNotMatch(migration, /v_job\.credit_cost <> 110/);
  assert.doesNotMatch(migration, /v_session\.credit_cost <> 440/);
  assert.match(migration, /v_charge_subscription \+ v_charge_free \+ v_charge_purchased <> v_job\.credit_cost/);
  assert.match(migration, /v_charge_subscription\+v_charge_free\+v_charge_purchased<>v_session\.credit_cost/);
});

test('DB migration: pricing helpersと課金RPCはservice_roleだけに維持する', () => {
  assert.match(migration, /revoke all on function public\.h3_max_credit_cost\(\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.h3_max_credit_cost\(\) to service_role/);
  assert.match(migration, /revoke all on function public\.deduct_h3_live_credits_atomic\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.deduct_h3_director_credits_atomic\(uuid, uuid, boolean\) from public, anon, authenticated/);
});
