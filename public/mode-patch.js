(function(){
  const KEY='flowvidGenerateMode';
  const MODES=['reference_to_video','image_to_video','text_to_video'];
  function valid(v){return MODES.includes(v)?v:'reference_to_video'}
  function readMode(){
    const p=new URLSearchParams(location.search).get('mode');
    const h=(location.hash||'').replace('#','');
    const s=localStorage.getItem(KEY);
    return valid(p||h||s||'reference_to_video');
  }
  function saveMode(mode){
    mode=valid(mode);
    localStorage.setItem(KEY,mode);
    const url=new URL(location.href);
    url.searchParams.set('mode',mode);
    url.hash=mode;
    history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
  function label(mode){
    if(mode==='text_to_video') return 'テキストから動画';
    if(mode==='image_to_video') return '画像から動画';
    return 'リファレンス';
  }
  function apply(mode){
    mode=valid(mode);
    window.currentMode=mode;
    document.querySelectorAll('.modeTabs button').forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.mode===mode);
    });
    const modeLabel=document.getElementById('modeLabel');
    if(modeLabel) modeLabel.textContent=label(mode);
    const assetRow=document.getElementById('assetRow');
    if(assetRow) assetRow.style.display=mode==='text_to_video'?'none':'flex';
    const prompt=document.getElementById('prompt');
    if(prompt){
      prompt.placeholder=mode==='text_to_video'
        ? '生成したい動画の内容を説明してください。'
        : mode==='image_to_video'
          ? 'アップロードした画像をもとに、生成したい内容を説明してください。'
          : 'キャラ・商品・雰囲気など、残したい特徴と動きを説明してください。';
    }
  }
  function patchFetch(){
    if(window.__flowvidSafeVideoPatch) return;
    window.__flowvidSafeVideoPatch=true;
    const originalFetch=window.fetch.bind(window);
    window.fetch=async function(input, init){
      const response=await originalFetch(input, init);
      try{
        const url=typeof input==='string'?input:(input&&input.url)||'';
        if(String(url).includes('/api/seedance-status')){
          const clone=response.clone();
          const data=await clone.json().catch(()=>null);
          if(data && data.storage && data.storage.ok===false){
            if(data.storage.videoUrl) data.storage.rejectedVideoUrl=data.storage.videoUrl;
            delete data.storage.videoUrl;
          }
          if(data && data.done!==true){
            data.videoUrl=null;
            data.rawVideoUrl=null;
          }
          return new Response(JSON.stringify(data),{
            status:response.status,
            statusText:response.statusText,
            headers:{'Content-Type':'application/json'}
          });
        }
      }catch(_){ }
      return response;
    };
  }
  function boot(){
    if(!/\/generate(?:-prod)?\.html$/.test(location.pathname)) return;
    patchFetch();
    const initial=readMode();
    saveMode(initial);
    apply(initial);
    document.querySelectorAll('.modeTabs button').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const mode=valid(btn.dataset.mode);
        saveMode(mode);
        setTimeout(()=>apply(mode),0);
        setTimeout(()=>apply(mode),80);
      },true);
    });
    window.addEventListener('pageshow',()=>apply(readMode()));
    window.addEventListener('hashchange',()=>{const mode=readMode();saveMode(mode);apply(mode)});
    setTimeout(()=>apply(readMode()),300);
    setTimeout(()=>apply(readMode()),1000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
