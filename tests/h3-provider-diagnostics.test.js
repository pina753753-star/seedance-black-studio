'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diagnosticsCompat = require('../api/_lib/h3-provider-diagnostics.js');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260914223252_add_h3_provider_diagnostics.sql'),
  'utf8'
);
const startSource = fs.readFileSync(path.join(root, 'api/h3-live/start.js'), 'utf8');
const statusSource = fs.readFileSync(path.join(root, 'api/h3-live/status.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'api/_lib/h3-live-store.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('diagnostic migration is additive, nullable, and does not change billing', () => {
  assert.match(migration, /^--[\s\S]*?begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /alter table public\.h3_live_jobs/);
  assert.match(migration, /add column if not exists provider_prompt text/);
  assert.match(migration, /add column if not exists provider_expanded_prompt text/);
  assert.match(migration, /add column if not exists provider_seed bigint/);
  assert.match(migration, /add column if not exists provider_timings jsonb/);
  assert.doesNotMatch(migration, /not null|default\s+|credit_balances|credit_transactions|deduct|refund/i);
  assert.doesNotMatch(migration, /grant\s+.*\s+to\s+(anon|authenticated)/i);
});

test('exact provider prompt is persisted only in the internal H3 job row', () => {
  assert.equal(
    (startSource.match(/provider_prompt:\s*submission\.submittedPrompt \|\| null/g) || []).length,
    2,
    'normal and ambiguous submissions must both retain the exact provider prompt'
  );
  assert.doesNotMatch(storeSource, /providerPrompt|providerExpandedPrompt|providerSeed|providerTimings/);
});

test('fal completion diagnostics are stored with the completed job', () => {
  assert.match(statusSource, /const diagnostics = upstream\.providerDiagnostics \|\| \{\}/);
  assert.match(statusSource, /provider_expanded_prompt:\s*diagnostics\.expandedPrompt \|\| null/);
  assert.match(statusSource, /provider_seed:\s*diagnostics\.seed \?\? null/);
  assert.match(statusSource, /provider_timings:\s*diagnostics\.timings \|\| null/);
});

test('old database schemas drop only optional diagnostics fields', () => {
  const update = {
    status: 'completed',
    output_url: 'https://v3.fal.media/files/example.mp4',
    provider_prompt: 'prompt',
    provider_expanded_prompt: 'expanded',
    provider_seed: 42,
    provider_timings: { inference: 1.2 }
  };

  assert.deepEqual(diagnosticsCompat.withoutProviderDiagnostics(update), {
    status: 'completed',
    output_url: 'https://v3.fal.media/files/example.mp4'
  });
});

test('only missing optional diagnostics columns trigger the rollout fallback', () => {
  assert.equal(diagnosticsCompat.isMissingProviderDiagnosticsSchema({
    code: 'PGRST204',
    message: "Could not find the 'provider_prompt' column of 'h3_live_jobs' in the schema cache"
  }), true);
  assert.equal(diagnosticsCompat.isMissingProviderDiagnosticsSchema({
    code: 'PGRST204',
    message: "Could not find the 'status' column of 'h3_live_jobs' in the schema cache"
  }), false);
  assert.equal(diagnosticsCompat.isMissingProviderDiagnosticsSchema({
    code: '42501',
    message: 'permission denied for table h3_live_jobs'
  }), false);
});

test('existing H3 Max BETA badge remains present in the home menu', () => {
  assert.match(indexHtml, /H3 Max <span class="menuBeta">BETA<\/span>/);
});
