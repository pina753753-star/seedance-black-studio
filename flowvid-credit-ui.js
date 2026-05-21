(function flowvidCreditUi() {
  function isGeneratePage() {
    return /\/generate\.html$/.test(window.location.pathname);
  }

  function injectStyle() {
    if (document.getElementById('flowvidCreditUiStyle')) return;
    const style = document.createElement('style');
    style.id = 'flowvidCreditUiStyle';
    style.textContent = `
      body.flowvid-credit-ui .settings .estimate{display:none!important;}
      body.flowvid-credit-ui #modeLabel{
        border:1px solid rgba(215,184,106,.26)!important;
        background:rgba(215,184,106,.08)!important;
        color:#f8e7b5!important;
        border-radius:999px!important;
        padding:7px 9px!important;
        font-size:12px!important;
        font-weight:900!important;
        white-space:nowrap!important;
      }
    `;
    document.head.appendChild(style);
  }

  function applyCreditUi() {
    if (!isGeneratePage()) return;
    document.body.classList.add('flowvid-credit-ui');
    injectStyle();

    const modeLabel = document.getElementById('modeLabel');
    if (modeLabel) modeLabel.textContent = '消費 128クレジット';

    const estimate = document.querySelector('.settings .estimate');
    if (estimate) estimate.setAttribute('aria-hidden', 'true');
  }

  function start() {
    if (!isGeneratePage()) return;
    applyCreditUi();
    setInterval(applyCreditUi, 700);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
