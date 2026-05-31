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

  const HIDE_MS=3200;
  let _hideTimer=null;

  function ensureOverlay(){
    let overlay=document.getElementById('fv-inline-video-overlay');
    if(overlay)return overlay;
    const style=document.createElement('style');
    style.textContent='body.fv-video-open{overflow:hidden}.fv-inline-video-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}.fv-inline-video-overlay.show{display:flex;align-items:center;justify-content:center}.fv-inline-video-overlay>video{width:100vw;height:100dvh;object-fit:contain;background:#000;display:block}.fv-ctrl-wrap{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none;opacity:0;transition:opacity .22s}.fv-ctrl-wrap.on{opacity:1;pointer-events:auto}.fv-ctrl-top{padding:calc(14px + env(safe-area-inset-top,0px)) 14px 0;display:flex;align-items:flex-start}.fv-ctrl-mid{display:flex;align-items:center;justify-content:center;gap:28px;flex:1}.fv-ctrl-bot{display:flex;align-items:center;gap:8px;padding:0 14px calc(22px + env(safe-area-inset-bottom,0px));background:linear-gradient(transparent,rgba(0,0,0,.6))}.fv-ctrl-btn{border:0;border-radius:999px;background:rgba(80,80,80,.58);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:rgba(255,255,255,.92);font-weight:600;cursor:pointer;display:grid;place-items:center;-webkit-tap-highlight-color:transparent}.fv-inline-close{width:44px;height:44px;font-size:22px;font-weight:500}.fv-ctrl-play{width:62px;height:62px;font-size:28px}.fv-ctrl-skip{width:52px;height:52px;font-size:13px;font-weight:800}.fv-ctrl-time,.fv-ctrl-dur{color:#fff;font-size:12px;font-weight:700;white-space:nowrap;min-width:34px;text-align:center}.fv-ctrl-seek{flex:1;height:4px;accent-color:#fff;cursor:pointer;-webkit-appearance:none;appearance:none}';
    document.head.appendChild(style);
    overlay=document.createElement('div');
    overlay.id='fv-inline-video-overlay';
    overlay.className='fv-inline-video-overlay';
    overlay.innerHTML='<video playsinline></video><div class="fv-ctrl-wrap"><div class="fv-ctrl-top"><button class="fv-ctrl-btn fv-inline-close" type="button" aria-label="閉じる">×</button></div><div class="fv-ctrl-mid"><button class="fv-ctrl-btn fv-ctrl-skip" data-skip="-10" type="button">−10</button><button class="fv-ctrl-btn fv-ctrl-play" type="button">▶</button><button class="fv-ctrl-btn fv-ctrl-skip" data-skip="10" type="button">+10</button></div><div class="fv-ctrl-bot"><span class="fv-ctrl-time">0:00</span><input type="range" class="fv-ctrl-seek" min="0" max="100" value="0" step="0.1"><span class="fv-ctrl-dur">0:00</span></div></div>';
    document.body.appendChild(overlay);

    const video=overlay.querySelector('video');
    const ctrlWrap=overlay.querySelector('.fv-ctrl-wrap');
    const playBtn=overlay.querySelector('.fv-ctrl-play');
    const seek=overlay.querySelector('.fv-ctrl-seek');
    const timeEl=overlay.querySelector('.fv-ctrl-time');
    const durEl=overlay.querySelector('.fv-ctrl-dur');

    function fmt(s){s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
    function wake(){ctrlWrap.classList.add('on');clearTimeout(_hideTimer);_hideTimer=setTimeout(()=>ctrlWrap.classList.remove('on'),HIDE_MS)}
    overlay._wake=wake;

    video.addEventListener('timeupdate',()=>{if(!seek._drag){seek.value=video.duration?video.currentTime/video.duration*100:0;timeEl.textContent=fmt(video.currentTime)}});
    video.addEventListener('loadedmetadata',()=>{durEl.textContent=fmt(video.duration)});
    video.addEventListener('play',()=>{playBtn.textContent='⏸'});
    video.addEventListener('pause',()=>{playBtn.textContent='▶'});
    video.addEventListener('ended',()=>{playBtn.textContent='▶'});

    playBtn.addEventListener('click',e=>{e.stopPropagation();video.paused?video.play().catch(()=>{}):video.pause();wake()});

    overlay.querySelectorAll('.fv-ctrl-skip').forEach(btn=>{
      btn.addEventListener('click',e=>{e.stopPropagation();video.currentTime=Math.max(0,Math.min(video.duration||0,video.currentTime+Number(btn.dataset.skip)));wake()});
    });

    seek.addEventListener('pointerdown',e=>{e.stopPropagation();seek._drag=true;wake()});
    seek.addEventListener('input',e=>{e.stopPropagation();if(video.duration){video.currentTime=seek.value/100*video.duration;timeEl.textContent=fmt(video.currentTime)}wake()});
    seek.addEventListener('pointerup',()=>{seek._drag=false});
    seek.addEventListener('click',e=>e.stopPropagation());

    overlay.querySelector('.fv-inline-close').addEventListener('click',e=>{e.stopPropagation();closeOverlay()});

    // tap on video area (not controls) toggles controls
    overlay.addEventListener('click',e=>{
      if(e.target.closest('.fv-ctrl-wrap'))return;
      ctrlWrap.classList.contains('on')?ctrlWrap.classList.remove('on'):wake();
      clearTimeout(_hideTimer);
      if(ctrlWrap.classList.contains('on'))_hideTimer=setTimeout(()=>ctrlWrap.classList.remove('on'),HIDE_MS);
    });

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
    overlay._wake();
  }
  function closeOverlay(){
    const overlay=document.getElementById('fv-inline-video-overlay');
    if(!overlay)return;
    clearTimeout(_hideTimer);
    overlay.querySelector('.fv-ctrl-wrap').classList.remove('on');
    const video=overlay.querySelector('video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    overlay.classList.remove('show');
    document.body.classList.remove('fv-video-open');
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
