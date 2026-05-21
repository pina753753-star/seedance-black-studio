window.FLOWVID_AUTH = {
  supabaseUrl: "https://jflpjsdjmlkmkqfahxwy.supabase.co",
  supabaseAnonKey: "sb_publishable_YbRKnQh1fCVO5VDJyVWfyQ_sNzHqvCE",
  redirectTo: "https://pina753753-star.github.io/seedance-black-studio/profile.html",
  adminRedirectTo: "https://pina753753-star.github.io/seedance-black-studio/admin.html",
  adminEmails: [
    "hinaran53@gmail.com"
  ]
};

(function addGeneratedVideoHistoryToAdminMenu() {
  function addButton() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    const nav = document.querySelector('.drawer .nav');
    if (!nav || document.getElementById('generatedVideoHistoryMenuBtn')) return;

    const button = document.createElement('button');
    button.id = 'generatedVideoHistoryMenuBtn';
    button.type = 'button';
    button.textContent = '生成動画履歴';
    button.addEventListener('click', () => {
      window.location.href = './admin-video-history.html';
    });

    const settingsButton = Array.from(nav.querySelectorAll('button'))
      .find((item) => item.textContent.includes('API'));

    if (settingsButton) {
      nav.insertBefore(button, settingsButton);
    } else {
      nav.appendChild(button);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(addButton, 0));
  } else {
    setTimeout(addButton, 0);
  }
})();

(function persistAdminViewAcrossReloads() {
  const allowed = new Set(['dashboard', 'veo', 'result', 'settings']);

  function currentHashView() {
    const raw = String(window.location.hash || '').replace(/^#/, '').trim();
    return allowed.has(raw) ? raw : '';
  }

  function savedView() {
    const raw = localStorage.getItem('flowvidAdminView') || '';
    return allowed.has(raw) ? raw : '';
  }

  function remember(view) {
    if (!allowed.has(view)) return;
    localStorage.setItem('flowvidAdminView', view);
    if (window.location.hash !== `#${view}`) {
      history.replaceState(null, '', `#${view}`);
    }
  }

  function openRememberedView() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    if (typeof window.showView !== 'function') return false;
    const view = currentHashView() || savedView();
    if (view) {
      window.showView(view);
      remember(view);
    }
    return true;
  }

  function hookShowView() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    if (typeof window.showView !== 'function') return false;
    if (window.showView.__flowvidPersistHooked) return true;

    const originalShowView = window.showView;
    window.showView = function patchedShowView(name) {
      const result = originalShowView.apply(this, arguments);
      if (allowed.has(name)) remember(name);
      return result;
    };
    window.showView.__flowvidPersistHooked = true;
    return true;
  }

  function attachButtonMemory() {
    document.querySelectorAll('.drawer .nav button[data-view]').forEach((button) => {
      if (button.dataset.flowvidRememberView === '1') return;
      button.dataset.flowvidRememberView = '1';
      button.addEventListener('click', () => remember(button.dataset.view || ''));
    });
  }

  function start() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const hooked = hookShowView();
      attachButtonMemory();
      const opened = openRememberedView();
      if ((hooked && opened) || attempts > 40) clearInterval(timer);
    }, 150);
  }

  window.addEventListener('hashchange', () => {
    const view = currentHashView();
    if (view && typeof window.showView === 'function') {
      window.showView(view);
      remember(view);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

(function autoSaveCompletedVeoResults() {
  function findVideoUri(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.video && obj.video.uri) return obj.video.uri;
    if (obj.uri && String(obj.uri).includes('/files/')) return obj.uri;
    for (const key of Object.keys(obj)) {
      const found = findVideoUri(obj[key]);
      if (found) return found;
    }
    return '';
  }

  function findOperationName(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.operationName) return obj.operationName;
    if (obj.name && String(obj.name).includes('/operations/')) return obj.name;
    for (const key of Object.keys(obj)) {
      const found = findOperationName(obj[key]);
      if (found) return found;
    }
    return '';
  }

  function readJsonFromStatus(el) {
    if (!el) return null;
    const text = (el.textContent || '').trim();
    if (!text.startsWith('{')) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async function saveFromStatus(el) {
    const data = readJsonFromStatus(el);
    if (!data || data.done !== true) return;

    const videoUri = findVideoUri(data);
    const operationName = findOperationName(data);
    if (!videoUri || !operationName) return;

    const storageKey = `flowvidSavedVideo:${operationName}`;
    if (localStorage.getItem(storageKey) === 'saved') return;
    localStorage.setItem(storageKey, 'saving');

    const payload = {
      operationName,
      videoUri,
      response: data,
      userEmail: (document.getElementById('adminEmail')?.textContent || '').trim() || 'hinaran53@gmail.com',
      provider: 'veo',
      model: document.getElementById('model')?.value || data.model || 'models/veo-3.0-fast-generate-001',
      prompt: document.getElementById('prompt')?.value || null,
      aspectRatio: document.getElementById('aspectRatio')?.value || null,
      durationSeconds: 5,
      creditCost: 128,
      status: 'completed'
    };

    try {
      const response = await fetch('/api/generated-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '保存に失敗しました');
      localStorage.setItem(storageKey, 'saved');
      el.textContent = `${JSON.stringify(data, null, 2)}\n\n✅ generated_videos に保存しました`;
    } catch (error) {
      localStorage.removeItem(storageKey);
      el.textContent = `${JSON.stringify(data, null, 2)}\n\n⚠️ DB保存エラー：${error.message || String(error)}`;
    }
  }

  function observeStatus(id) {
    const el = document.getElementById(id);
    if (!el || el.dataset.flowvidAutoSaveObserver === '1') return;
    el.dataset.flowvidAutoSaveObserver = '1';
    const observer = new MutationObserver(() => saveFromStatus(el));
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    saveFromStatus(el);
  }

  function start() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    observeStatus('veoStatus');
    observeStatus('resultStatus');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 300));
  } else {
    setTimeout(start, 300);
  }
})();

(function addRunDraftTaskButtons() {
  function extractTaskId(item) {
    const deleteButton = item.querySelector('button[onclick^="deleteTask"]');
    const code = deleteButton?.getAttribute('onclick') || '';
    const match = code.match(/deleteTask\('([^']+)'\)/);
    return match ? match[1] : '';
  }

  function setTaskStatus(message, bad = false) {
    const el = document.getElementById('taskStatus');
    if (!el) return;
    el.textContent = message;
    el.className = 'status show' + (bad ? ' bad' : '');
  }

  async function runTask(taskId, button) {
    const ok = confirm('このdraftをVeoで実行します。Google側で課金が発生する可能性があります。実行しますか？');
    if (!ok) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Veo実行中…';
    setTaskStatus('Veo生成を開始しています…');

    try {
      const response = await fetch('/api/run-generation-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Veo実行に失敗しました');

      if (result.operationName) {
        localStorage.setItem('flowvidVeoOperation', result.operationName);
      }

      setTaskStatus(`${JSON.stringify(result, null, 2)}\n\n✅ Veo実行を開始しました。operationName が出ています。`);

      const refreshButton = document.getElementById('refreshTasksBtn');
      if (refreshButton) setTimeout(() => refreshButton.click(), 900);
    } catch (error) {
      setTaskStatus('Veo実行エラー：' + (error.message || String(error)), true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function enhanceTaskList() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    document.querySelectorAll('#taskList .taskItem').forEach((item) => {
      if (item.dataset.flowvidRunButtonAdded === '1') return;
      const statusText = item.querySelector('.taskTop span')?.textContent?.trim() || '';
      if (!['draft', 'queued', 'pending', 'failed', 'error'].includes(statusText)) return;

      const taskId = extractTaskId(item);
      if (!taskId) return;

      const actions = item.querySelector('.taskActions');
      if (!actions) return;

      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.className = 'taskBtn';
      runButton.textContent = 'Veo実行';
      runButton.addEventListener('click', () => runTask(taskId, runButton));
      actions.insertBefore(runButton, actions.firstChild);
      item.dataset.flowvidRunButtonAdded = '1';
    });
  }

  function start() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    const list = document.getElementById('taskList');
    if (!list) return;
    enhanceTaskList();
    const observer = new MutationObserver(enhanceTaskList);
    observer.observe(list, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 500));
  } else {
    setTimeout(start, 500);
  }
})();

(function addCurrentUsageEstimate() {
  const monthlyLimit = 2000;

  function yen(value) {
    const num = Math.round(Number(value || 0));
    return `¥${num.toLocaleString('ja-JP')}`;
  }

  function currentMonthRows(rows) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    return (rows || []).filter((row) => {
      const date = row.created_at ? new Date(row.created_at) : null;
      if (!date || Number.isNaN(date.getTime())) return false;
      return date.getFullYear() === year && date.getMonth() === month;
    });
  }

  function ensureCard() {
    const settings = document.getElementById('settings');
    if (!settings || document.getElementById('currentUsageEstimateCard')) return;

    const card = document.createElement('article');
    card.className = 'card';
    card.id = 'currentUsageEstimateCard';
    card.innerHTML = `
      <h2>今月の利用状況</h2>
      <div class="row"><span>FlowVid記録の利用額</span><strong id="flowvidUsageAmount">読み込み中</strong></div>
      <div class="row"><span>生成回数</span><strong id="flowvidUsageCount">-</strong></div>
      <div class="row"><span>月上限まで残り</span><strong id="flowvidUsageRemaining">-</strong></div>
      <div class="row"><span>上限使用率</span><strong id="flowvidUsagePercent">-</strong></div>
      <div class="mini" id="flowvidUsageNote">generated_videos の credit_cost を集計した目安です。Google AI Studioの実請求額は下のボタンから確認してください。</div>
      <button class="btn secondary" id="refreshUsageEstimateBtn" type="button">利用状況を再読み込み</button>
    `;

    const firstCard = settings.querySelector('.card');
    if (firstCard?.nextSibling) {
      firstCard.parentNode.insertBefore(card, firstCard.nextSibling);
    } else {
      settings.appendChild(card);
    }

    const button = document.getElementById('refreshUsageEstimateBtn');
    if (button) button.addEventListener('click', loadUsage);
  }

  async function loadUsage() {
    ensureCard();
    const amountEl = document.getElementById('flowvidUsageAmount');
    const countEl = document.getElementById('flowvidUsageCount');
    const remainingEl = document.getElementById('flowvidUsageRemaining');
    const percentEl = document.getElementById('flowvidUsagePercent');
    const noteEl = document.getElementById('flowvidUsageNote');
    if (!amountEl) return;

    amountEl.textContent = '読み込み中';
    try {
      const response = await fetch('/api/generated-videos?limit=50');
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '利用状況を取得できませんでした');

      const monthRows = currentMonthRows(data.rows || []);
      const completedRows = monthRows.filter((row) => ['completed', 'processing'].includes(String(row.status || '')));
      const total = completedRows.reduce((sum, row) => sum + Number(row.credit_cost || 0), 0);
      const remaining = Math.max(monthlyLimit - total, 0);
      const percent = monthlyLimit > 0 ? Math.min((total / monthlyLimit) * 100, 999) : 0;

      amountEl.textContent = yen(total);
      countEl.textContent = `${completedRows.length}回`;
      remainingEl.textContent = yen(remaining);
      percentEl.textContent = `${percent.toFixed(1)}%`;
      noteEl.textContent = `更新：${new Date().toLocaleString('ja-JP')}。この表示はFlowVid内の記録ベースです。Google AI Studio側の実測額とは数円ずれる可能性があります。`;
    } catch (error) {
      amountEl.textContent = '取得エラー';
      countEl.textContent = '-';
      remainingEl.textContent = '-';
      percentEl.textContent = '-';
      if (noteEl) noteEl.textContent = error.message || String(error);
    }
  }

  function start() {
    if (!/\/admin\.html$/.test(window.location.pathname)) return;
    ensureCard();
    loadUsage();
    const nav = document.querySelector('.drawer .nav');
    if (nav && !nav.dataset.flowvidUsageHooked) {
      nav.dataset.flowvidUsageHooked = '1';
      nav.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-view="settings"]');
        if (button) setTimeout(loadUsage, 400);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 600));
  } else {
    setTimeout(start, 600);
  }
})();

(function labelGenerateActionButtons() {
  function injectStyle() {
    if (document.getElementById('flowvidGenerateActionLabelStyle')) return;
    const style = document.createElement('style');
    style.id = 'flowvidGenerateActionLabelStyle';
    style.textContent = `
      .flowvidActionLabel{
        width:auto!important;
        min-width:58px!important;
        height:42px!important;
        padding:4px 9px!important;
        display:grid!important;
        grid-template-rows:auto auto!important;
        place-items:center!important;
        gap:2px!important;
        line-height:1.05!important;
        font-size:11px!important;
        font-weight:900!important;
      }
      .flowvidActionLabel .flowvidIcon{font-size:15px;line-height:1;display:block;}
      .flowvidActionLabel .flowvidLabel{font-size:10px;line-height:1;display:block;opacity:.9;letter-spacing:.02em;}
    `;
    document.head.appendChild(style);
  }

  function setLabel(el, icon, label) {
    if (!el || el.dataset.flowvidLabel === label) return;
    el.classList.add('flowvidActionLabel');
    el.dataset.flowvidLabel = label;
    el.innerHTML = `<span class="flowvidIcon">${icon}</span><span class="flowvidLabel">${label}</span>`;
  }

  function labelActions() {
    if (!/\/generate\.html$/.test(window.location.pathname)) return;
    injectStyle();
    document.querySelectorAll('.taskActions .actionGroup').forEach((group) => {
      const items = Array.from(group.children);
      setLabel(items[0], '✦', '編集');
      setLabel(items[1], '↗', '開く');
      setLabel(items[2], '↓', '保存');
    });
  }

  function start() {
    if (!/\/generate\.html$/.test(window.location.pathname)) return;
    labelActions();
    const list = document.getElementById('taskList');
    if (list && !list.dataset.flowvidActionLabelObserver) {
      list.dataset.flowvidActionLabelObserver = '1';
      const observer = new MutationObserver(labelActions);
      observer.observe(list, { childList: true, subtree: true });
    }
    setTimeout(labelActions, 800);
    setTimeout(labelActions, 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

(function runUserCreateButtonWithVeo() {
  function isGeneratePage() {
    return /\/generate\.html$/.test(window.location.pathname);
  }

  function status(message, bad = false) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = message;
    el.className = 'status show' + (bad ? ' bad' : '');
  }

  function notice(message, bad = false) {
    const el = document.getElementById('notice');
    if (!el) return;
    el.textContent = message;
    el.className = bad ? 'pill bad' : 'pill';
  }

  function activeMode() {
    return document.querySelector('.modeTabs button.active')?.dataset.mode || 'reference_to_video';
  }

  function currentClient() {
    const cfg = window.FLOWVID_AUTH || {};
    if (!window.supabase || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
    if (!window.__flowvidUserClient) {
      window.__flowvidUserClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    }
    return window.__flowvidUserClient;
  }

  async function refreshTasksSoon() {
    const button = document.getElementById('loadTasksBtn');
    if (button) {
      setTimeout(() => button.click(), 500);
      setTimeout(() => button.click(), 2500);
      setTimeout(() => button.click(), 7000);
    }
  }

  function rememberOperation(operationName, email) {
    if (!operationName) return;
    const raw = localStorage.getItem('flowvidUserOperations') || '[]';
    let rows = [];
    try { rows = JSON.parse(raw); } catch (_) { rows = []; }
    rows = rows.filter((row) => row && row.operationName !== operationName);
    rows.unshift({ operationName, email, startedAt: Date.now() });
    localStorage.setItem('flowvidUserOperations', JSON.stringify(rows.slice(0, 10)));
  }

  async function checkOperation(row) {
    const params = new URLSearchParams({ operationName: row.operationName || '' });
    if (row.email) params.set('userEmail', row.email);
    const response = await fetch('/api/check-veo-operation?' + params.toString());
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '生成状況を確認できませんでした');
    return data;
  }

  async function pollRememberedOperations() {
    if (!isGeneratePage()) return;
    const raw = localStorage.getItem('flowvidUserOperations') || '[]';
    let rows = [];
    try { rows = JSON.parse(raw); } catch (_) { rows = []; }
    if (!rows.length) return;

    const kept = [];
    for (const row of rows) {
      if (!row?.operationName) continue;
      if (Date.now() - Number(row.startedAt || 0) > 1000 * 60 * 60 * 6) continue;
      try {
        const result = await checkOperation(row);
        if (result.completed) {
          notice('動画が完成しました');
          refreshTasksSoon();
        } else {
          kept.push(row);
        }
      } catch (_) {
        kept.push(row);
      }
    }
    localStorage.setItem('flowvidUserOperations', JSON.stringify(kept.slice(0, 10)));
  }

  async function createAndRun() {
    const client = currentClient();
    if (!client) {
      status('Supabase接続情報が未設定です。', true);
      return;
    }

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const user = sessionData?.session?.user || null;
    if (sessionError || !user) {
      location.href = './login.html';
      return;
    }

    const prompt = (document.getElementById('prompt')?.value || '').trim();
    if (!prompt) {
      status('プロンプトを入力してください。', true);
      return;
    }

    const createBtn = document.getElementById('createBtn');
    const originalText = createBtn?.textContent || '作成する';
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.textContent = '生成開始中…';
    }
    notice('Veo生成を開始しています…');
    status('タスクを作成しています…');

    try {
      const payload = {
        user_id: user.id,
        mode: activeMode(),
        prompt,
        resolution: 'veo',
        duration_seconds: Number(document.getElementById('duration')?.value || 5),
        aspect_ratio: document.getElementById('aspectRatio')?.value || '9:16',
        credit_cost: 128,
        status: 'draft',
        api_provider: 'veo'
      };

      const { data: task, error: insertError } = await client
        .from('generation_tasks')
        .insert(payload)
        .select('id')
        .single();

      if (insertError || !task?.id) {
        throw new Error(insertError?.message || 'タスク作成に失敗しました');
      }

      status('タスクを作成しました。Veo生成を開始しています…');
      refreshTasksSoon();

      const response = await fetch('/api/run-generation-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Veo生成開始に失敗しました');

      if (result.operationName) {
        rememberOperation(result.operationName, user.email || '');
      }

      document.getElementById('prompt').value = '';
      notice('生成中です');
      status('Veo生成を開始しました。完成したらタスク欄に動画が表示されます。');
      refreshTasksSoon();
      setTimeout(pollRememberedOperations, 12000);
      setTimeout(pollRememberedOperations, 30000);
      setTimeout(pollRememberedOperations, 60000);
    } catch (error) {
      notice('生成開始に失敗しました', true);
      status('生成開始エラー：' + (error.message || String(error)), true);
    } finally {
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.textContent = originalText;
      }
    }
  }

  function hookCreateButton() {
    if (!isGeneratePage()) return;
    const button = document.getElementById('createBtn');
    if (!button) return;
    if (button.dataset.flowvidUserRunHooked === '1') return;
    button.dataset.flowvidUserRunHooked = '1';
    button.onclick = createAndRun;
  }

  function start() {
    if (!isGeneratePage()) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const button = document.getElementById('createBtn');
      if (button) {
        button.dataset.flowvidUserRunHooked = '';
        hookCreateButton();
      }
      if (attempts > 20) clearInterval(timer);
    }, 400);
    setTimeout(pollRememberedOperations, 2500);
    setInterval(pollRememberedOperations, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
