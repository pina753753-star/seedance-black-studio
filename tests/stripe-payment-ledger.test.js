'use strict';

// Skeleton only (Codex修正案 5). None of these are implemented yet — each is
// a todo() so `node --test` reports them without failing the suite. Filling
// them in requires a way to inject a mock Supabase client + mock Stripe SDK
// into api/stripe-webhook.js (it currently has no `_test` export like
// api/admin-credit-grant.js does), which is out of scope for this pass.
//
// See supabase/migrations/20260907000000_stripe_payment_ledger_atomic_transitions.sql
// for record_payment_risk_event_atomic() / grant_stripe_credits_with_ledger_atomic(),
// and api/stripe-webhook.js for ensurePaymentLedgerPending() / grantCreditsWithLedger() /
// recordPaymentRiskEvent() / resolveInvoicePaymentIds() / enrichPaymentLedgerIds().

const test = require('node:test');

test.todo('pending台帳へrisk eventが来た場合heldへ遷移する');
test.todo('risk eventが台帳より先に記録されても後続付与を拒否する');
test.todo('pending→grantedの更新が0件なら成功扱いにしない');
test.todo('既にgrantedの場合は冪等成功として扱う');
test.todo('heldまたはreversedではgrant RPCを実行しない');
test.todo('付与直後に中断しても再送で二重付与されない');
test.todo('同一Stripeイベントの並列実行でもrisk eventは1件だけ');
test.todo('23505後の再取得でもuser不一致を拒否する');
test.todo('年次更新Invoiceもcredits_granted=0で台帳へ残す');
test.todo('Invoice ID補完失敗をneeds_reviewとして永続化する');
test.todo('旧Invoice形式のpayment_intent/chargeを取得できる');
test.todo('新Invoice Payments形式からpayment_intent/chargeを取得できる');
