(function () {
  const NOT_CONFIRMED_MESSAGE = 'メール確認が完了していません。確認メール内のリンクを開いてからログインしてください。';

  function loginUrl(message) {
    const params = new URLSearchParams();
    if (message) params.set('authMessage', message);
    const query = params.toString();
    return './login.html' + (query ? '?' + query : '');
  }

  function isConfirmed(user) {
    return Boolean(user && (user.email_confirmed_at || user.confirmed_at));
  }

  async function safelySignOut(client) {
    if (!client) return;
    try {
      await client.auth.signOut();
    } catch (_) {
      // Redirect is still required even if local sign-out cleanup fails.
    }
  }

  async function requireConfirmedUser(client, options) {
    const settings = options || {};
    const redirect = settings.redirect !== false;
    const redirectTo = settings.redirectTo || loginUrl(NOT_CONFIRMED_MESSAGE);

    if (!client) {
      if (redirect) location.replace(redirectTo);
      return null;
    }

    let session;
    try {
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error || !sessionResult.data?.session) {
        if (redirect) location.replace('./login.html');
        return null;
      }
      session = sessionResult.data.session;
    } catch (_) {
      if (redirect) location.replace('./login.html');
      return null;
    }

    try {
      const userResult = await client.auth.getUser();
      const user = userResult.data?.user || null;

      if (userResult.error || !user) {
        await safelySignOut(client);
        if (redirect) location.replace('./login.html');
        return null;
      }

      if (!isConfirmed(user)) {
        await safelySignOut(client);
        if (redirect) location.replace(redirectTo);
        return null;
      }

      return user;
    } catch (_) {
      await safelySignOut(client);
      if (redirect) location.replace('./login.html');
      return null;
    }
  }

  window.FlowVidAuthGuard = {
    NOT_CONFIRMED_MESSAGE,
    isConfirmed,
    requireConfirmedUser
  };
})();
