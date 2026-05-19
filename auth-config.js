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
