// Reuse the protected page handler with the same public Supabase key used by the browser.
// The key is publishable (not a service-role secret) and is used only to verify the caller's access token.
if (!process.env.SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_YbRKnQh1fCVO5VDJyVWfyQ_sNzHqvCE';
}

module.exports = require('./admin-ops-page');
