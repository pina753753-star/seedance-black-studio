'use strict';
(() => {
  const config = window.FLOWVID_AUTH || {};
  const client = config.supabaseUrl && config.supabaseAnonKey && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  const grid = document.getElementById('balances'), message = document.getElementById('message'), button = document.getElementById('refresh');
  const info = {
    wavespeed: ['WaveSpeed', 'https://wavespeed.ai/top-up', 'Seedance 2.5・2.5 Turbo、Klingモーションなど。実際の経路はモデル設定によります。'],
    fal: ['fal', 'https://fal.ai/dashboard/billing', 'H3 Max Liveなど。既存キーに残高の読取権限がない場合は取得できません。'],
    openrouter: ['OpenRouter', 'https://openrouter.ai/settings/credits', 'Seedance 2.0・2.0 Fast、絵コンテなど。公式画面で確認してください。'],
    openai: ['OpenAI', 'https://platform.openai.com/settings/organization/billing/overview', 'モデレーション・画像判定など。公式画面で確認してください。']
  };
  const errors = { not_configured: '未設定', access_unavailable: '認証・読取権限を確認', rate_limited: '取得制限中', timeout: '取得時間切れ', provider_unavailable: '取得失敗', invalid_response: '応答を確認できません' };
  let epoch = 0, controller = null, activeUser = null, busy = false, visibleRows = [];
  function clear() { epoch++; controller?.abort(); controller = null; grid.replaceChildren(); grid.hidden = true; visibleRows = []; busy = false; button.disabled = !activeUser; }
  function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
  function statusText(row) {
    if (!row) return '公式画面で確認';
    if (row.state === 'stale') return '古い残高・' + (errors[row.error] || '再確認が必要');
    if (row.state === 'current') {
      if (Date.now() - Date.parse(row.fetchedAt) >= 30000) return '古い残高・更新してください';
      return row.balance <= 0 ? '残高なし・要確認' : '取得済み';
    }
    return '未取得・' + (errors[row.error] || '不明');
  }
  function updateStatuses() {
    for (const node of grid.querySelectorAll('[data-provider-state]')) {
      const row = visibleRows.find(r => r.id === node.dataset.providerState);
      node.textContent = statusText(row);
      node.classList.toggle('warning', Boolean(row && (row.state !== 'current' || row.balance <= 0 || Date.now() - Date.parse(row.fetchedAt) >= 30000)));
    }
  }
  setInterval(updateStatuses, 5000); // Local age display only; never polls provider APIs.
  function render(rows) {
    visibleRows = rows;
    grid.replaceChildren();
    for (const id of Object.keys(info)) {
      const [name, url, models] = info[id], row = rows.find(r => r.id === id), card = document.createElement('article'); card.className = 'card';
      card.append(text('h2', name));
      const known = row && typeof row.balance === 'number' && Number.isFinite(row.balance);
      const amount = text('div', known ? new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 }).format(row.balance) : '—', 'amount');
      if (known) amount.append(text('span', ' ' + row.currency, 'currency'));
      card.append(amount);
      const stateNode = text('div', statusText(row), 'state'); stateNode.dataset.providerState = id; card.append(stateNode);
      const details = document.createElement('details'); details.append(text('summary', '詳細'));
      details.append(text('p', '最終成功取得：' + (row?.fetchedAt ? new Date(row.fetchedAt).toLocaleString('ja-JP') : '未取得')));
      if (row?.checkedAt) details.append(text('p', '最終確認：' + new Date(row.checkedAt).toLocaleString('ja-JP')));
      details.append(text('p', models));
      if (known && row.balance > 0) details.append(text('p', '必要残高はモデル・秒数で異なります。固定の不足閾値は設定していません。'));
      const link = text('a', '公式の残高・チャージ画面'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); card.append(details); grid.append(card);
    }
    grid.hidden = false; updateStatuses();
  }
  async function load() {
    if (!client || !activeUser || busy) return;
    clear(); const ticket = epoch; busy = true; button.disabled = true; controller = new AbortController(); const signal = controller.signal;
    const requestController = controller;
    const timer = setTimeout(() => requestController.abort(), 12000);
    message.textContent = '確認中…';
    try {
      const { data, error } = await client.auth.getSession();
      if (ticket !== epoch) return;
      const session = data?.session;
      if (error || !session?.access_token || session.user.id !== activeUser) throw new Error('session');
      const response = await fetch('/api/admin-provider-balances', { headers: { Authorization: 'Bearer ' + session.access_token }, cache: 'no-store', signal });
      const result = await response.json();
      if (ticket !== epoch) return;
      if (!response.ok || !result.ok) throw new Error('denied');
      render(result.providers);
      message.textContent = '手動更新でも30秒以内は保存済み結果を表示します。古い残高は最新値ではありません。';
    } catch { if (ticket === epoch) { grid.replaceChildren(); grid.hidden = true; message.textContent = '管理者権限または取得結果を確認できません。ログイン状態を確認して再試行してください。'; } }
    finally { clearTimeout(timer); if (ticket === epoch) { busy = false; button.disabled = !activeUser; } }
  }
  button.onclick = load;
  window.addEventListener('pagehide', () => { clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { clear(); message.textContent = '再確認しています。'; load(); } });
  if (!client) { message.textContent = '認証設定を確認できません。'; return; }
  client.auth.onAuthStateChange((_event, session) => {
    activeUser = session?.user?.id || null; clear();
    message.textContent = activeUser ? '管理者権限を確認しています。' : 'ログインが必要です。管理画面からログインしてください。';
    if (activeUser) setTimeout(load, 0); // Never call asynchronous Supabase methods inside the auth callback.
  });
})();
