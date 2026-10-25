# Isolated PostgreSQL accounting tests

`fixture.sql` is a disposable local test fixture, **not a production migration**. It loads the repository's actual reservation, debit, refund, Stripe credit-grant, ledger transition and risk functions, and stops at the baseline. The runtime runner records baseline results, then explicitly applies `docs/sql/basic-credit-access-atomic.sql` and compares the candidate. It does not reproduce these functions in a fake implementation.

The parent test harness owns starting/stopping the explicitly authorized official `docker.io/library/postgres:17.11-bookworm` container. Use an isolated disposable database, no published host ports, no external database connection, no production environment files or credentials, and only dummy identities. The runner copies only the fixture and repository SQL files into the container; it never mounts the workspace or environment files. This fixture does not pull an image or start a container by itself.

Run `python tests/postgres/run.py` from this checkout. The runner uses `psql -v ON_ERROR_STOP=1 -f /tmp/pina-fixture/tests/postgres/fixture.sql` inside its isolated container. Use `-f`, not a bare stdin copy: `\ir` resolves relative to the script's directory. Each run needs a fresh empty database/cluster because roles and base constraints are deliberately created once. Do not run the fixture against an existing environment.

## Dependencies and loading order

1. Local NOLOGIN roles `anon`, `authenticated`, and `service_role` (BYPASSRLS, matching the server role's expected behavior); minimal `auth.users(id)` and `auth.uid()` shim for foreign keys/RLS DDL.
2. Exact `supabase/setup-01-tables.sql` definitions: profiles, balance, transactions and generation tasks. Its assets/gallery tables are created but unused.
3. The existing nullable subscription/purchase expiry columns and task settings column required by the runtime functions.
4. Repository active-task unique constraint and cooldown trigger/RPC.
5. Repository refund unique index and original permissions, followed by the latest WaveSpeed-capable refund definition.
6. Repository Stripe reason partial unique index and current `grant_stripe_credits_atomic` definition (including legacy scale support).
7. Repository `reserve_generation_task` and `deduct_generation_credits_atomic`.
8. Repository Stripe ledger/risk schema, atomic transitions and corrected ledger-first risk lock order.
9. Stop at the original baseline. The runtime runner applies the candidate purchase-access SQL draft after recording the baseline snapshot.

No extension is required: PostgreSQL 17 provides `gen_random_uuid()`. Accounting tables use the repository's UUID IDs, foreign keys, nonnegative balance constraints, credit-pool/status constraints and partial unique indexes. Base table RLS is enabled with no end-user policies in this accounting-only fixture. This is not a full Supabase Auth, Storage or browser-RLS integration environment.

## Dummy data contract for the runner

Create a user in this order:

```sql
INSERT INTO auth.users(id) VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id,email,plan)
VALUES ('00000000-0000-4000-8000-000000000001','dummy-one@example.test','free');
INSERT INTO public.credit_balances(user_id)
VALUES ('00000000-0000-4000-8000-000000000001');
```

- `profiles.account_status` defaults to `active` and permits `active`, `risk_hold`, `frozen`.
- Balance pools default to zero. Purchase eligibility needs positive `purchased_credits`, future `purchased_expires_at`, a `credit_pack` ledger with `grant_status='granted'`, and no blocking risk. An expired/null purchase expiry must not pass the new path.
- Use dummy Stripe IDs (`pi_test_*`, `ch_test_*`, `evt_test_*`) unique per scenario. Create a pending `stripe_payment_ledger` row before invoking `grant_stripe_credits_with_ledger_atomic`; never replace its nested real grant RPC with a stub. Ledger IDs default to generated UUIDs.
- `credit_transactions.reason` values beginning `stripe:` are globally unique. Refunds are unique by `(related_task_id, reason, credit_type)` for `generation_refund`.
- Reserve tasks using the real `reserve_generation_task`. Its default provider is `openrouter`. Before first debit, write server-owned `settings = '{"purchase_access_required":true}'` for the new purchase path. Omit it for baseline free/subscription regression cases.
- One queued/processing task per user is enforced. Use a fresh dummy user per independent scenario to avoid unwanted 60-second cooldown interference. Do not weaken the index or trigger to make concurrent cases pass.
- The debit RPC can replay a debit while the task remains queued without a provider task ID. For refund tests, retain the actual charge ledger and let `refund_generation_task_atomic` mark the task failed.
- Execute calls as `service_role` where testing server access. Separately assert that anon/authenticated cannot execute privileged grant/debit/refund/risk/purchase-check RPCs.

## Concurrency assertions

The runtime harness should coordinate separate PostgreSQL sessions with explicit transactions. Demonstrate blocking using `pg_blocking_pids`/`pg_stat_activity`, then release the blocker and assert both results. A delay alone is not proof that a race happened.

Verify debit/replay, refund/replay, grant/replay, and risk-first versus debit-first ordering. Assert exact pool balances, per-reason transaction row counts, ledger `grant_status`, risk deduplication and terminal task status. A successful function return alone is insufficient. Check statement/lock timeouts so a deadlock or unexpected wait is surfaced.

The fixture preserves ledger → balance ordering for grant/risk/purchase checks. Task row locks precede purchase checks in the existing debit function; refund uses task → balance. The runtime tests should exercise actual serialization rather than infer correctness solely from SQL text.

## Coverage limits

This database fixture proves only the accounting SQL that the harness actually executes and asserts. It does not establish that the draft is deployed, that remote Stripe/provider services work, or that Supabase Auth/Storage policies and API waterfall behavior are integrated. Test logs must record image/version, executed cases and failures separately from source-only checks.
