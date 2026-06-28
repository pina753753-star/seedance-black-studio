(function(){
  function addStyle(){
    if(document.getElementById('flowvidVideoDebugStyle'))return;
    const style=document.createElement('style');
    style.id='flowvidVideoDebugStyle';
    style.textContent=`
      .flowvidVideoDebugBar{position:fixed;left:14px;right:14px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:46;display:none;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;pointer-events:auto}
      .videoOverlay.open .flowvidVideoDebugBar{display:flex}
      .flowvidVideoDebugBar a,.flowvidVideoDebugBar button{border:1px solid rgba(255,255,255,.22);background:rgba(20,22,30,.88);color:#fff;border-radius:999px;padding:11px 14px;font-weight:850;text-decoration:none;font-size:13px;backdrop-filter:blur(12px)}
      .flowvidVideoError{position:fixed;left:18px;right:18px;top:42%;z-index:46;display:none;text-align:center;color:#fecdd3;background:rgba(40,10,16,.78);border:1px solid rgba(251,113,133,.35);border-radius:18px;padding:14px;font-weight:800;line-height:1.6;backdrop-filter:blur(10px)}
      .videoOverlay.open .flowvidVideoError.show{display:block}
    `;
    document.head.appendChild(style);
  }
  function ensure(){
    addStyle();
    const overlay=document.getElementById('videoOverlay');
    if(!overlay)return null;
    let bar=document.getElementById('flowvidVideoDebugBar');
    if(!bar){
      bar=document.createElement('div');
      bar.id='flowvidVideoDebugBar';
      bar.className='flowvidVideoDebugBar';
      bar.innerHTML='<a id="flowvidOpenVideo" target="_blank" rel="noreferrer">別タブで開く</a><button id="flowvidCopyVideo" type="button">URLコピー</button><button id="flowvidRetryVideo" type="button">再読み込み</button>';
      overlay.appendChild(bar);
    }
    let err=document.getElementById('flowvidVideoError');
    if(!err){
      err=document.createElement('div');
      err.id='flowvidVideoError';
      err.className='flowvidVideoError';
      err.textContent='動画を再生できません。別タブで開くか、URLコピーで確認してください。';
      overlay.appendChild(err);
    }
    return {bar,err};
  }
  function currentSrc(){return document.getElementById('overlayVideo')?.src||'';}
  function wire(){
    const parts=ensure();
    if(!parts)return;
    const video=document.getElementById('overlayVideo');
    const open=document.getElementById('flowvidOpenVideo');
    const copy=document.getElementById('flowvidCopyVideo');
    const retry=document.getElementById('flowvidRetryVideo');
    const err=parts.err;
    if(video&&!video.dataset.flowvidDebug){
      video.dataset.flowvidDebug='1';
      video.addEventListener('error',()=>err.classList.add('show'));
      video.addEventListener('playing',()=>err.classList.remove('show'));
      video.addEventListener('loadeddata',()=>err.classList.remove('show'));
    }
    if(open&&!open.dataset.flowvidDebug){
      open.dataset.flowvidDebug='1';
      open.addEventListener('click',()=>{open.href=currentSrc()||'#';});
    }
    if(copy&&!copy.dataset.flowvidDebug){
      copy.dataset.flowvidDebug='1';
      copy.addEventListener('click',async()=>{
        const src=currentSrc();
        try{await navigator.clipboard.writeText(src);copy.textContent='コピー済み';setTimeout(()=>copy.textContent='URLコピー',1200)}catch(_){copy.textContent='コピー不可';setTimeout(()=>copy.textContent='URLコピー',1200)}
      });
    }
    if(retry&&!retry.dataset.flowvidDebug){
      retry.dataset.flowvidDebug='1';
      retry.addEventListener('click',()=>{
        const src=currentSrc();
        if(!src||!video)return;
        err.classList.remove('show');
        video.pause();video.src=src+(src.includes('?')?'&':'?')+'r='+Date.now();video.load();video.play().catch(()=>err.classList.add('show'));
      });
    }
    const observer=new MutationObserver(()=>{
      const src=currentSrc();
      if(open)open.href=src||'#';
      if(err)err.classList.remove('show');
    });
    observer.observe(video,{attributes:true,attributeFilter:['src']});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();