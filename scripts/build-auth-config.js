// Rewrites the window.FLOWVID_AUTH config block in public/auth-config.js at
// build time so Vercel Preview deployments point at a preview Supabase
// project instead of the hard-coded production values.
//
// Behavior:
//   - public/auth-config.js missing            -> hard failure (build breaks)
//   - SUPABASE_URL or publishable key unset    -> leave file untouched (prod default)
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

if (!supabaseUrl || !publishableKey) {
  console.log('build-auth-config: SUPABASE_URL or publishable key not set; keeping bundled auth-config.js as-is.');
  process.exit(0);
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
  fail('SUPABASE_URL is not a https://<ref>.supabase.co URL.');
}
if (publishableKey.includes('sb_secret_') || publishableKey.includes('sk_live_') || publishableKey.includes('sk_test_')) {
  fail('publishable key variable contains secret-shaped material; refusing to write it to a public file.');
}
if (!publishableKey.startsWith('sb_publishable_')) {
  fail('publishable key does not start with sb_publishable_.');
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

const replacement = [
  'window.FLOWVID_AUTH = {',
  `  supabaseUrl: ${JSON.stringify(supabaseUrl)},`,
  `  supabaseAnonKey: ${JSON.stringify(publishableKey)},`,
  `  redirectTo: ${JSON.stringify(redirectTo)},`,
  `  adminRedirectTo: ${JSON.stringify(adminRedirectTo)},`,
  '  adminEmails: ["hinaran53@gmail.com"]',
  '};'
].join('\n');

fs.writeFileSync(TARGET, source.replace(pattern, replacement));
console.log(`build-auth-config: wrote ${new URL(supabaseUrl).hostname} with sb_publishable key; redirects -> ${new URL(redirectTo).hostname}.`);
