const { createClient } = require('@supabase/supabase-js');

const EMAIL_NOT_CONFIRMED_MESSAGE =
  'メールアドレスの確認が完了していません。確認メール内のリンクを開いてから、もう一度お試しください。';

function bearerToken(req) {
  const auth = String(
    req?.headers?.authorization ||
    req?.headers?.Authorization ||
    ''
  );

  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function isConfirmed(user) {
  return Boolean(user && (user.email_confirmed_at || user.confirmed_at));
}

async function requireConfirmedAuth(req) {
  const token = bearerToken(req);

  if (!token) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'ログインが必要です。'
      }
    };
  }

  const supabase = serviceClient();
  if (!supabase) {
    return {
      ok: false,
      status: 500,
      body: {
        ok: false,
        error: 'AUTH_CONFIGURATION_ERROR',
        message: '認証設定を確認できませんでした。'
      }
    };
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    const user = data?.user || null;

    if (error || !user) {
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'ログインが必要です。'
        }
      };
    }

    if (!isConfirmed(user)) {
      return {
        ok: false,
        status: 403,
        body: {
          ok: false,
          error: 'EMAIL_NOT_CONFIRMED',
          message: EMAIL_NOT_CONFIRMED_MESSAGE
        }
      };
    }

    return { ok: true, user, token, supabase };
  } catch (_) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'ログインが必要です。'
      }
    };
  }
}

module.exports = {
  EMAIL_NOT_CONFIRMED_MESSAGE,
  bearerToken,
  isConfirmed,
  requireConfirmedAuth
};
