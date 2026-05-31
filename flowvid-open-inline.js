(function(){
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
  function ensureOverlay(){
    let overlay=document.getElementById('fv-inline-video-overlay');
    if(overlay)return overlay;
    const style=document.createElement('style');
    style.textContent='body.fv-video-open{overflow:hidden}.fv-inline-video-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}.fv-inline-video-overlay.show{display:block}.fv-inline-video-overlay video{width:100vw;height:100dvh;object-fit:contain;background:#000;display:block}.fv-inline-close{position:fixed;left:calc(12px + env(safe-area-inset-left));top:calc(56px + env(safe-area-inset-top));z-index:100000;width:44px;height:44px;border:0;border-radius:999px;background:rgba(90,90,90,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:rgba(255,255,255,.92);font-size:22px;font-weight:500;line-height:1;display:grid;place-items:center;opacity:0;transition:opacity .22s;pointer-events:none}';
    document.head.appendChild(style);
    overlay=document.createElement('div');
    overlay.id='fv-inline-video-overlay';
    overlay.className='fv-inline-video-overlay';
    overlay.innerHTML='<button class="fv-inline-close" type="button" aria-label="閉じる">×</button><video controls playsinline></video>';
    document.body.appendChild(overlay);
    overlay.querySelector('.fv-inline-close').addEventListener('click',closeOverlay);
    overlay.addEventListener('click',function(e){
      if(e.target.closest('.fv-inline-close'))return;
      showCloseBtn(overlay);
    });
    return overlay;
  }
  let _hideTimer=null;
  function showCloseBtn(overlay){
    const btn=overlay.querySelector('.fv-inline-close');
    if(!btn)return;
    btn.style.opacity='1';
    btn.style.pointerEvents='auto';
    clearTimeout(_hideTimer);
    _hideTimer=setTimeout(()=>{btn.style.opacity='0';btn.style.pointerEvents='none'},3000);
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
    showCloseBtn(overlay);
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
    document.body.classList.remove('fv-video-open');
  }
  async function saveCurrentVideo(overlay){
    const url=overlay?.dataset?.url||'';
    if(!url)return;
    const btn=overlay.querySelector('.fv-inline-save');
    const old=btn.textContent;
    btn.textContent='保存中';
    btn.disabled=true;
    try{
      const res=await fetch(url,{cache:'no-store'});
      if(!res.ok)throw new Error(String(res.status));
      const blob=await res.blob();
      const blobUrl=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=blobUrl;
      a.download='flowvid-video.mp4';
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{URL.revokeObjectURL(blobUrl);a.remove()},1500);
      btn.textContent='保存済';
      setTimeout(()=>{btn.textContent=old;btn.disabled=false},1600);
    }catch(_){
      btn.textContent=old;
      btn.disabled=false;
      alert('保存できませんでした。画面右上の共有から保存してください。');
    }
  }
  function findUrlFromTarget(target){
    const openLink=target.closest&&target.closest('a.fv-action');
    if(openLink&&(openLink.textContent||'').trim()==='開く')return openLink.href;
    const oldOpen=target.closest&&target.closest('a.icon');
    if(oldOpen&&oldOpen.href&&(oldOpen.textContent||'').includes('↗'))return oldOpen.href;
    const frame=target.closest&&target.closest('.fv-video-frame');
    if(frame?.dataset?.openUrl)return frame.dataset.openUrl;
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
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensureGenerateHistory);else ensureGenerateHistory();
})();
