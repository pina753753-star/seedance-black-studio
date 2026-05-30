(function(){
  function ensureGenerateHistory(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    if(document.getElementById('history'))return;
    const main=document.querySelector('main.wrap');
    if(!main)return;
    const section=document.createElement('section');
    section.className='section';
    section.innerHTML='<h2>過去動画</h2><button id="clear" type="button">再読込</button>';
    const history=document.createElement('div');
    history.className='history';
    history.id='history';
    history.innerHTML='<div class="empty">履歴を読み込み中...</div>';
    main.appendChild(section);
    main.appendChild(history);
    const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const valid=u=>/^https?:\/\//i.test(u||'')&&!/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(u||'');
    async function load(){
      try{
        history.innerHTML='<div class="empty">履歴を読み込み中...</div>';
        const res=await fetch('/api/generated-videos?limit=50&t='+Date.now(),{cache:'no-store'});
        const data=await res.json();
        const rows=(data?.rows||[]).map(r=>({url:r.video_url||r.video_uri||r.src||r.url||'',prompt:r.prompt||r.title||'生成動画',jobId:r.job_id||r.jobId||r.id||''})).filter(r=>valid(r.url));
        if(!rows.length){history.innerHTML='<div class="empty">まだ動画がありません</div>';return}
        history.innerHTML=rows.map(r=>'<article class="old"><div class="oldTop">'+esc(String(r.prompt).slice(0,42))+'</div><video controls playsinline preload="metadata" src="'+esc(r.url)+'#t=0.2"></video><div class="icons"><a class="icon" href="'+esc(r.url)+'" target="_blank" rel="noreferrer">↗</a><a class="icon" href="'+esc(r.url)+'" download>↓</a></div></article>').join('');
      }catch(_){history.innerHTML='<div class="empty">履歴を読み込めませんでした</div>'}
    }
    section.querySelector('#clear').onclick=load;
    load();
  }
  function ensureOverlay(){
    let overlay=document.getElementById('fv-inline-video-overlay');
    if(overlay)return overlay;
    const style=document.createElement('style');
    style.textContent='body.fv-video-open{overflow:hidden}.fv-inline-video-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}.fv-inline-video-overlay.show{display:block}.fv-inline-video-overlay video{width:100vw;height:100dvh;object-fit:contain;background:#000;display:block}.fv-inline-close{position:fixed;left:calc(12px + env(safe-area-inset-left));top:calc(56px + env(safe-area-inset-top));z-index:100000;width:46px;height:46px;border:0;border-radius:999px;background:rgba(0,0,0,.58);color:#fff;font-size:32px;font-weight:900;line-height:1;display:grid;place-items:center}';
    document.head.appendChild(style);
    overlay=document.createElement('div');
    overlay.id='fv-inline-video-overlay';
    overlay.className='fv-inline-video-overlay';
    overlay.innerHTML='<button class="fv-inline-close" type="button" aria-label="閉じる">×</button><video controls playsinline></video>';
    document.body.appendChild(overlay);
    overlay.querySelector('.fv-inline-close').addEventListener('click',closeOverlay);
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
  }
  function closeOverlay(){
    const overlay=document.getElementById('fv-inline-video-overlay');
    if(!overlay)return;
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
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensureGenerateHistory);else ensureGenerateHistory();
})();