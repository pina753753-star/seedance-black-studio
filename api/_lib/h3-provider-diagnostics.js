'use strict';

const OPTIONAL_DIAGNOSTIC_COLUMNS = new Set([
  'provider_prompt',
  'provider_expanded_prompt',
  'provider_seed',
  'provider_timings'
]);

function withoutProviderDiagnostics(values) {
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => !OPTIONAL_DIAGNOSTIC_COLUMNS.has(key))
  );
}

function isMissingProviderDiagnosticsSchema(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || error.details || '');
  return (code === 'PGRST204' || code === '42703' || /schema cache|column/i.test(message)) &&
    /provider_(?:prompt|expanded_prompt|seed|timings)/i.test(message);
}

module.exports = {
  withoutProviderDiagnostics,
  isMissingProviderDiagnosticsSchema
};
