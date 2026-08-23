// Rewrites the window.FLOWVID_AUTH config block in public/auth-config.js at
// build time so Vercel Preview deployments point at a preview Supabase
// project instead of the hard-coded production values.
//
// Behavior:
//   - public/auth-config.js missing            -> hard failure (build breaks)
//   - SUPABASE_URL or publishable key unset    -> keep bundled Supabase values
//   - TURNSTILE_SITE_KEY unset                 -> write an empty site key
//   - TURNSTILE_SITE_KEY malformed             -> hard failure
//   - key not sb_publishable_* / secret-shaped -> hard failure (never ship secrets)
//
// Never log key material: only URL hostnames and key *classification*.

'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.join(process.cwd(), 'public', 'auth-config.js');

function fail(message) {
  console.error(`build-auth-config: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(TARGET)) {
  fail('public/auth-config.js not found — run the copy step first.');
}

const supabaseUrl = process.env.SUPABASE_URL || '';
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';
const turnstileSiteKey = String(process.env.TURNSTILE_SITE_KEY || '').trim();

if (turnstileSiteKey && !/^[0-9]x[A-Za-z0-9_-]{20,100}$/.test(turnstileSiteKey)) {
  fail('TURNSTILE_SITE_KEY has an invalid format.');
}

const hasSupabaseOverride = Boolean(supabaseUrl && publishableKey);
if (hasSupabaseOverride) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
    fail('SUPABASE_URL is not a https://<ref>.supabase.co URL.');
  }
  if (publishableKey.includes('sb_secret_') || publishableKey.includes('sk_live_') || publishableKey.includes('sk_test_')) {
    fail('publishable key variable contains secret-shaped material; refusing to write it to a public file.');
  }
  if (!publishableKey.startsWith('sb_publishable_')) {
    fail('publishable key does not start with sb_publishable_.');
  }
}

const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const redirectTo =
  process.env.FLOWVID_AUTH_REDIRECT_TO ||
  (vercelUrl ? `${vercelUrl}/profile.html` : 'https://flowvid-studio.vercel.app/profile.html');
const adminRedirectTo =
  process.env.FLOWVID_AUTH_ADMIN_REDIRECT_TO ||
  (vercelUrl ? `${vercelUrl}/admin.html` : 'https://flowvid-studio.vercel.app/admin.html');

const source = fs.readFileSync(TARGET, 'utf8');
const pattern = /^window\.FLOWVID_AUTH\s*=\s*\{[\s\S]*?\};/;
if (!pattern.test(source)) {
  fail('window.FLOWVID_AUTH block not found at top of public/auth-config.js.');
}

let replacement;
if (hasSupabaseOverride) {
  replacement = [
    'window.FLOWVID_AUTH = {',
    `  supabaseUrl: ${JSON.stringify(supabaseUrl)},`,
    `  supabaseAnonKey: ${JSON.stringify(publishableKey)},`,
    `  redirectTo: ${JSON.stringify(redirectTo)},`,
    `  adminRedirectTo: ${JSON.stringify(adminRedirectTo)},`,
    '  adminEmails: ["hinaran53@gmail.com"],',
    `  turnstileSiteKey: ${JSON.stringify(turnstileSiteKey)}`,
    '};'
  ].join('\n');
} else {
  const configBlock = source.match(pattern)[0];
  if (!/turnstileSiteKey\s*:/.test(configBlock)) {
    fail('turnstileSiteKey field not found in public/auth-config.js.');
  }
  replacement = configBlock.replace(
    /(turnstileSiteKey\s*:\s*)["'][^"']*["']/,
    `$1${JSON.stringify(turnstileSiteKey)}`
  );
}

fs.writeFileSync(TARGET, source.replace(pattern, replacement));
if (hasSupabaseOverride) {
  console.log(`build-auth-config: wrote ${new URL(supabaseUrl).hostname} with sb_publishable key; redirects -> ${new URL(redirectTo).hostname}; Turnstile ${turnstileSiteKey ? 'enabled' : 'disabled'}.`);
} else {
  console.log(`build-auth-config: SUPABASE_URL or publishable key not set; kept bundled Supabase config and set Turnstile ${turnstileSiteKey ? 'enabled' : 'disabled'}.`);
}
