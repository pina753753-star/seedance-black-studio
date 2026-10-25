(function () {
  const NOT_CONFIRMED_MESSAGE = 'メール確認が完了していません。確認メール内のリンクを開いてからログインしてください。';
  const checks = new WeakMap();
  const terminalCodes = new Set(['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found']);
  function isConfirmed(user) { return Boolean(user && (user.email_confirmed_at || user.confirmed_at)); }
  function failure(error) {
    // HTTP status or message alone cannot distinguish expired access tokens,
    // project/configuration errors and a revoked refresh session.
    if (error?.name === 'AuthApiError' && terminalCodes.has(error.code)) return { state: 'invalid' };
    return { state: 'unavailable' };
  }
  function entry(client) {
    let value = checks.get(client);
    if (!value) {
      value = { version: 0, pending: null, signIn: null };
      checks.set(client, value);
      client.auth.onAuthStateChange?.((event, session) => {
        // Normal getSession refresh may emit TOKEN_REFRESHED. The returned
        // token is verified below; refresh alone does not switch identity.
        // Startup/focus can announce the existing session. Only accept an
        // event whose token and user match the session actually verified.
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.access_token && session.user?.id) {
            value.signIn = { token: session.access_token, userId: session.user.id };
          } else if (event === 'SIGNED_IN') value.version++;
        }
        if (['SIGNED_OUT', 'USER_UPDATED'].includes(event)) value.version++;
      });
    }
    return value;
  }
  async function verify(client) {
    if (!client) return { state: 'unavailable' };
    const record = entry(client);
    if (record.pending) return record.pending;
    const version = record.version;
    record.signIn = null;
    let timer;
    const inspect = async () => {
      try {
        const sessionResult = await client.auth.getSession();
        if (sessionResult.error) return failure(sessionResult.error);
        const session = sessionResult.data?.session;
        if (!session) return { state: 'missing' };
        const result = await client.auth.getUser(session.access_token);
        if (result.error) return failure(result.error);
        const user = result.data?.user;
        if (!user || !session.access_token || user.id !== session.user?.id) return { state: 'unavailable' };
        if (!isConfirmed(user)) return { state: 'unconfirmed' };
        return { state: 'confirmed', user, token: session.access_token };
      } catch (error) { return failure(error); }
    };
    const pending = Promise.race([
      inspect(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'unavailable' }), 8000); })
    ]).then(result => {
      if (record.version !== version) return { state: 'unavailable' };
      if (result.state === 'confirmed' && record.signIn
          && (record.signIn.token !== result.token || record.signIn.userId !== result.user.id)) {
        return { state: 'unavailable' };
      }
      return result;
    })
      .finally(() => { clearTimeout(timer); if (record.pending === pending) record.pending = null; });
    record.pending = pending;
    return pending;
  }
  function showUnavailable(client) {
    if (typeof document === 'undefined' || !document.body || document.getElementById('authConnectionBlocked')) return;
    const panel = document.createElement('section');
    panel.id = 'authConnectionBlocked';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#101319;color:#fff;display:grid;place-content:center;gap:16px;padding:24px';
    const text = document.createElement('p');
    text.textContent = 'ログインを確認できません。保存済みのログインは削除していません。確認が取れるまで操作を停止しています。';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = '接続を再確認';
    let running = false;
    retry.onclick = async () => {
      if (running) return;
      running = true; retry.disabled = true;
      const result = await verify(client);
      if (result.state === 'confirmed') location.reload();
      else if (result.state !== 'unavailable') redirect(result);
      else text.textContent = 'まだログインを確認できません。時間をおいて再確認してください。';
      running = false; retry.disabled = false;
    };
    for (const element of Array.from(document.body.children)) element.inert = true;
    panel.append(text, retry); document.body.append(panel); retry.focus();
  }
  function redirect(result) {
    const query = result.state === 'unconfirmed' ? '?authMessage=' + encodeURIComponent(NOT_CONFIRMED_MESSAGE) : '';
    location.replace('./login.html' + query);
  }
  async function requireConfirmedUser(client, options) {
    const result = await verify(client);
    if (result.state === 'confirmed') return result.user;
    if (result.state === 'unavailable') showUnavailable(client);
    else if (options?.redirect !== false) redirect(result);
    return null;
  }
  async function getVerifiedToken(client) {
    const result = await verify(client);
    if (result.state === 'confirmed') return result.token;
    if (result.state === 'unavailable') showUnavailable(client);
    else redirect(result);
    // Throw rather than returning an empty token that callers interpret as logout.
    throw Object.assign(new Error('ログインを確認できません。'), { name: 'AuthVerificationUnavailable' });
  }
  window.FlowVidAuthGuard = { NOT_CONFIRMED_MESSAGE, isConfirmed, requireConfirmedUser, getVerifiedToken, verify, showUnavailable };
})();
