(function(){
  const STANDARD_MODEL='bytedance/seedance-2.0';
  const FAST_MODEL='bytedance/seedance-2.0-fast';
  const DEFAULTS_APPLIED_KEY='flowvidPricingDefaultsV2';

  function currentMode(){
    return document.querySelector('[data-mode].on')?.dataset?.mode||localStorage.getItem('flowvidGenerateMode')||'reference_to_video';
  }

  function roundUpToTen(value){
    return Math.max(50,Math.min(500,Math.ceil(Math.max(50,value)/10)*10));
  }

  function calculateCredits(){
    const mode=currentMode();
    const duration=Number(document.getElementById('duration')?.value||5);
    const resolution=document.getElementById('resolution')?.value||'720p';
    const model=document.getElementById('model')?.value||FAST_MODEL;
    let credits=80;
    credits+=Math.max(0,duration-5)*15;
    if(resolution==='1080p')credits+=100;
    if(resolution==='480p')credits-=20;
    if(mode==='text_to_video')credits-=10;
    credits+=15;
    return roundUpToTen(credits*(model===FAST_MODEL?0.8:1));
  }

  function syncCreditButton(){
    const button=document.getElementById('create');
    if(!button)return;
    const expected='作成する ✦ '+calculateCredits();
    if(button.textContent!==expected)button.textContent=expected;
  }

  function applyPricingDefaults(select){
    if(localStorage.getItem(DEFAULTS_APPLIED_KEY))return;
    select.value=FAST_MODEL;
    const duration=document.getElementById('duration');
    const resolution=document.getElementById('resolution');
    if(duration)duration.value='5';
    if(resolution)resolution.value='720p';
    localStorage.setItem(DEFAULTS_APPLIED_KEY,'1');
  }

  function installCreditSync(){
    if(window.__flowvidCreditSyncInstalled)return;
    window.__flowvidCreditSyncInstalled=true;
    ['model','duration','resolution'].forEach(id=>{
      document.getElementById(id)?.addEventListener('change',()=>setTimeout(syncCreditButton,0));
    });
    document.querySelectorAll('[data-mode]').forEach(button=>{
      button.addEventListener('click',()=>setTimeout(syncCreditButton,0));
    });
    const create=document.getElementById('create');
    if(create){
      const observer=new MutationObserver(()=>syncCreditButton());
      observer.observe(create,{childList:true,subtree:true,characterData:true});
      window.__flowvidCreditButtonObserver=observer;
    }
  }

  function applyFastModelPricing(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    const select=document.getElementById('model');
    if(!select)return;

    const legacyOption=Array.from(select.options).find(item=>item.value==='bytedance/seedance-2.0-lite');
    if(legacyOption){
      legacyOption.value=FAST_MODEL;
      legacyOption.textContent='Seedance 2.0 Fast';
    }
    const fastOption=Array.from(select.options).find(item=>item.value===FAST_MODEL);
    if(fastOption)fastOption.textContent='Seedance 2.0 Fast';

    const resolution=document.getElementById('resolution');
    const option720=Array.from(resolution?.options||[]).find(item=>item.value==='720p');
    const option1080=Array.from(resolution?.options||[]).find(item=>item.value==='1080p');
    if(option720)option720.textContent='720p（おすすめ）';
    if(option1080)option1080.textContent='1080p（高画質・最終出力向け）';

    applyPricingDefaults(select);
    window.creditEstimate=calculateCredits;
    window.__flowvidFastCreditEstimate=true;
    installCreditSync();
    if(typeof window.updateCreditUi==='function')window.updateCreditUi();
    syncCreditButton();
  }

  function ensureGenerateHistory(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    if(document.getElementById('history'))return;
    const main=document.querySelector('main.wrap');
    if(!main)return;
    const section=document.createElement('section');
    section.className='section';
    section.innerHTML='<h2>過去動画</h2><button id="clear" type="button">再読込</button>';
    const historyDiv=document.createElement('div');
    historyDiv.className='history';
    historyDiv.id='history';
    historyDiv.innerHTML='<div class="empty">履歴を読み込み中...</div>';
    main.appendChild(section);
    main.appendChild(historyDiv);
    const getMode=()=>document.querySelector('[data-mode].on')?.dataset?.mode||localStorage.getItem('flowvidGenerateMode')||'';
    if(typeof window.flowvidLoadHistory==='function')window.flowvidLoadHistory(getMode());
    section.querySelector('#clear').onclick=()=>{if(typeof window.flowvidLoadHistory==='function')window.flowvidLoadHistory(getMode())};
  }

  const HIDE_MS = 3200;
  let _hideTimer = null;

  function ensureOverlay(){
    let overlay=document.getElementById('fv-inline-video-overlay');
    if(overlay)return overlay;

    const style=document.createElement('style');
    style.textContent=[
      'body.fv-video-open{overflow:hidden}',
      '.fv-inline-video-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}',
      '.fv-inline-video-overlay.show{display:block}',
      '.fv-inline-video-overlay>video{width:100vw;height:100dvh;object-fit:contain;background:#000;display:block}',
      '.fv-inline-close{',
      '  position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:14px;z-index:100000;',
      '  width:34px;height:34px;border:0;border-radius:50%;',
      '  background:rgba(60,60,60,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
      '  color:rgba(255,255,255,.9);font-size:18px;font-weight:400;line-height:1;',
      '  display:grid;place-items:center;cursor:pointer;',
      '  opacity:0;transition:opacity .2s;pointer-events:none;',
      '  -webkit-tap-highlight-color:transparent;',
      '}',
      '.fv-inline-close.on{opacity:1;pointer-events:auto}',
    ].join('');
    document.head.appendChild(style);

    overlay=document.createElement('div');
    overlay.id='fv-inline-video-overlay';
    overlay.className='fv-inline-video-overlay';
    overlay.innerHTML='<video playsinline controls></video><button class="fv-inline-close" type="button" aria-label="閉じる">×</button>';
    document.body.appendChild(overlay);

    const video=overlay.querySelector('video');
    const closeBtn=overlay.querySelector('.fv-inline-close');

    function showClose(){closeBtn.classList.add('on')}
    function hideClose(){closeBtn.classList.remove('on')}
    function scheduleHide(){
      clearTimeout(_hideTimer);
      _hideTimer=setTimeout(hideClose, HIDE_MS);
    }
    function onInteraction(){
      showClose();
      if(!video.paused)scheduleHide();
      else clearTimeout(_hideTimer);
    }

    overlay.addEventListener('touchstart', onInteraction, {passive:true});
    overlay.addEventListener('click', onInteraction);
    video.addEventListener('play', ()=>{showClose();scheduleHide()});
    video.addEventListener('pause', ()=>{showClose();clearTimeout(_hideTimer)});
    video.addEventListener('ended', ()=>{showClose();clearTimeout(_hideTimer)});
    closeBtn.addEventListener('click', e=>{e.stopPropagation();closeOverlay()});

    overlay._showClose=showClose;
    return overlay;
  }

  function openOverlay(url){
    if(!url)return;
    const overlay=ensureOverlay();
    const video=overlay.querySelector('video');
    overlay.dataset.url=url;
    video.src=url;
    document.body.classList.add('fv-video-open');
    overlay.classList.add('show');
    video.play().catch(()=>{});
    overlay._showClose();
  }
  function closeOverlay(){
    const overlay=document.getElementById('fv-inline-video-overlay');
    if(!overlay)return;
    clearTimeout(_hideTimer);
    const video=overlay.querySelector('video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    overlay.classList.remove('show');
    overlay.querySelector('.fv-inline-close').classList.remove('on');
    document.body.classList.remove('fv-video-open');
  }
  function findUrlFromTarget(target){
    const openLink=target.closest&&target.closest('a.fv-action');
    if(openLink&&(openLink.textContent||'').trim()==='開く')return openLink.href;
    const oldOpen=target.closest&&target.closest('a.icon');
    if(oldOpen&&oldOpen.href&&(oldOpen.textContent||'').includes('↗'))return oldOpen.href;
    const expand=target.closest&&target.closest('.fv-expand-btn');
    if(expand?.dataset?.url)return expand.dataset.url;
    return '';
  }
  document.addEventListener('click',function(e){
    const url=findUrlFromTarget(e.target);
    if(!url)return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openOverlay(url);
  },true);
  window.fvOpenOverlay=openOverlay;
  function boot(){applyFastModelPricing();ensureGenerateHistory()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  window.addEventListener('pageshow',applyFastModelPricing);
})();
