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
