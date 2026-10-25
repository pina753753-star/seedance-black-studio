'use strict';
// SQL structure/regression checks, NOT live PostgreSQL concurrency tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'docs/sql/basic-credit-access-atomic.sql'), 'utf8');
function body(source, name) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, name);
  const after = source.slice(start);
  const match = after.match(/as (\$function\$|\$\$)/);
  const end = after.indexOf(match[1] + ';', match.index + match[0].length);
  return after.slice(0, end + match[1].length + 1);
}
const targets = [
  ['deduct_generation_credits_atomic', '20260803081000_add_atomic_generation_credit_deduction.sql', 'already_deducted', "settings->>'purchase_access_required'"]

];
for (const [name, file, replay, marker] of targets) {
  test(`${name}: only internal access gate added; original accounting logic byte-for-byte preserved`, () => {
    const original = body(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'), name);
    const current = body(sql, name);
    const stripped = current.replace('  v_purchase_access_error text; -- standalone access gate declaration\n', '')
      .replace(/  -- BEGIN standalone access gate\n[\s\S]*?  -- END standalone access gate\n\n/, '');
    assert.equal(stripped, original);
    assert.ok(current.indexOf(replay) < current.indexOf('-- BEGIN standalone access gate'));
    assert.ok(current.includes(marker));
    assert.ok(current.indexOf('-- BEGIN standalone access gate') < current.lastIndexOf('for update;'));
  });
}
test('helper takes ledger locks before risk read and balance lock; uses existing risk lock order', () => {
  const helper = body(sql, 'check_purchase_credit_access_locked');
  const ledger = helper.indexOf('perform 1 from public.stripe_payment_ledger');
  const ordered = helper.indexOf('order by l.id');
  const lock = helper.indexOf('for update;');
  const risk = helper.indexOf('select 1 from public.payment_risk_events');
  const balance = helper.indexOf('select * into v_balance');
  assert.ok(ledger < ordered && ordered < lock && lock < risk && risk < balance);
  const existing = fs.readFileSync(path.join(root, 'supabase/migrations/20260908070000_fix_payment_risk_ledger_lock_order.sql'), 'utf8');
  assert.ok(existing.indexOf('order by l.id\n  for update;') < existing.indexOf('insert into public.payment_risk_events'));
});
test('held/reversed, open/reviewing, expired/missing purchase, non-owner risk and account checks are explicit', () => {
  const helper = body(sql, 'check_purchase_credit_access_locked');
  for (const clause of ["l.grant_status in ('held', 'reversed')", "r.status in ('open', 'reviewing')", "l.purchase_type = 'credit_pack'", "l.grant_status = 'granted'", 'v_balance.purchased_expires_at is null', 'v_balance.purchased_expires_at <= now()', 'coalesce(v_balance.purchased_credits, 0) <= 0', "coalesce(p.account_status, 'active') = 'active'", 'l.user_id = p_user_id', 'l.charge_id = r.charge_id', 'l.payment_intent_id = r.payment_intent_id']) assert.ok(helper.includes(clause), clause);
});
test('draft neither rewrites refund/webhook/plan nor changes pool order; execute restricted', () => {
  assert.doesNotMatch(sql, /create or replace function public\.(refund_|record_payment_risk|grant_stripe)/);
  assert.doesNotMatch(sql, /update public\.profiles/);
  assert.match(sql, /revoke all on function public\.check_purchase_credit_access_locked\(uuid\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.check_purchase_credit_access_locked\(uuid\) to service_role/);
});

test('basic scope does not redefine any add-on RPC or schema', () => { assert.doesNotMatch(sql, /deduct_h3_live|reserve_video_edit|h3_director|alter table|storage\.buckets/); });
