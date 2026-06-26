(function(){
  const STANDARD_MODEL='bytedance/seedance-2.0';
  const FAST_MODEL='bytedance/seedance-2.0-fast';

  function applyFastModelPricing(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    const select=document.getElementById('model');
    if(!select)return;
    const option=Array.from(select.options).find(item=>item.value==='bytedance/seedance-2.0-lite');
    if(option){
      option.value=FAST_MODEL;
      option.textContent='Seedance 2.0 Fast';
    }
    if(typeof window.creditEstimate==='function'&&!window.__flowvidFastCreditEstimate){
      const standardEstimate=window.creditEstimate;
      window.creditEstimate=function(){
        const base=Math.max(50,Number(standardEstimate())||50);
        const model=document.getElementById('model')?.value||STANDARD_MODEL;
        return Math.max(50,Math.round(base*(model===FAST_MODEL?0.8:1)));
      };
      window.__flowvidFastCreditEstimate=true;
    }
    if(typeof window.updateCreditUi==='function')window.updateCreditUi();
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
