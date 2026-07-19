(function(){
  function ready(fn){document.readyState==='loading'?document.addEventListener('DOMContentLoaded',fn,{once:true}):fn()}
  function install(){
    if(window.__flowvidVlloEditorInstalled)return;
    if(!document.getElementById('videoEditSection')||typeof veRenderList!=='function'||typeof veAddClip!=='function'){setTimeout(install,50);return}
    window.__flowvidVlloEditorInstalled=true;

    let activeClipId=null;
    let restoreAttempts=0;

    const style=document.createElement('style');
    style.textContent=`
      #videoEditSection{padding-bottom:150px}#videoEditSection>.section,#videoEditSection>p{display:none!important}
      .ve-vllo-shell{display:grid;gap:10px}.ve-vllo-topbar{display:flex;justify-content:space-between;align-items:center;padding:2px}.ve-vllo-title{font-size:17px;font-weight:900}.ve-vllo-count{font-size:12px;color:#8b93a4;font-weight:700}
      .ve-vllo-preview{position:relative;aspect-ratio:16/9;border-radius:16px;overflow:hidden;background:#080b10;border:1px solid rgba(255,255,255,.08);display:grid;place-items:center}.ve-vllo-preview video{width:100%;height:100%;object-fit:contain;background:#050506}.ve-vllo-preview-empty{color:#6b7280;font-size:13px;font-weight:700}.ve-vllo-preview-controls{position:absolute;left:10px;right:10px;bottom:10px;display:flex;justify-content:space-between;align-items:center;pointer-events:none}.ve-vllo-preview-controls button{pointer-events:auto;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.65);color:#fff;font-size:18px}.ve-vllo-time{background:rgba(0,0,0,.62);border-radius:999px;padding:6px 10px;font-size:11px;font-weight:800}
      .ve-vllo-stage{background:#101319;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:10px;overflow:hidden}.ve-vllo-ruler{display:flex;justify-content:space-between;color:#687080;font-size:10px;font-weight:700;margin-bottom:6px;padding:0 4px}.ve-vllo-timeline-wrap{position:relative;overflow-x:auto;overflow-y:hidden;padding:16px calc(50% - 36px) 12px;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}.ve-vllo-timeline{display:flex;gap:4px;min-width:max-content}.ve-vllo-clip{position:relative;flex:0 0 auto;height:72px;min-width:72px;max-width:190px;border:2px solid transparent;border-radius:9px;overflow:hidden;background:#242a34;scroll-snap-align:center;padding:0}.ve-vllo-clip.active{border-color:#19a7ff;box-shadow:0 0 0 1px rgba(25,167,255,.35)}.ve-vllo-clip video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.45}.ve-vllo-clip [data-ve-filmstrip],.ve-vllo-trim-track [data-ve-filmstrip]{position:absolute;inset:0;display:flex}.ve-vllo-clip [data-ve-filmstrip] canvas,.ve-vllo-trim-track [data-ve-filmstrip] canvas{flex:1 1 0;min-width:0;width:100%;height:100%;display:block}.ve-vllo-clip [data-ve-filmstrip-fallback],.ve-vllo-trim-track [data-ve-filmstrip-fallback]{position:absolute;inset:0;background:linear-gradient(90deg,#2a3340,#53617a,#2a3340)}.ve-vllo-clip-num{position:absolute;z-index:4;top:4px;left:4px;min-width:20px;height:20px;border-radius:7px;background:rgba(0,0,0,.72);display:grid;place-items:center;font-size:10px;font-weight:900}.ve-vllo-clip-time{position:absolute;z-index:4;right:4px;bottom:4px;background:rgba(0,0,0,.72);border-radius:6px;padding:2px 5px;font-size:9px;font-weight:800}.ve-vllo-clip-playhead{position:absolute;z-index:6;top:0;bottom:0;left:0;width:3px;background:#19a7ff;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;transform:translateX(-1px)}.ve-vllo-clip-playhead:before{content:'';position:absolute;left:50%;top:0;transform:translate(-50%,-25%);width:10px;height:10px;border-radius:50%;background:#19a7ff}.ve-vllo-add{flex:0 0 58px;height:72px;border-radius:9px;border:1px dashed rgba(255,255,255,.28);background:#171b23;color:#fff;font-size:27px}
      .ve-vllo-trim{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px}.ve-vllo-trim-head,.ve-vllo-time-row{display:flex;justify-content:space-between;align-items:center}.ve-vllo-trim-title{font-size:12px;color:#cbd2dd;font-weight:800}.ve-vllo-trim-track{position:relative;height:58px;margin-top:8px;border-radius:10px;overflow:visible;background:#242a34;touch-action:none;user-select:none;-webkit-user-select:none}.ve-vllo-trim-window{position:absolute;top:0;bottom:0;background:rgba(25,167,255,.12);border-top:2px solid #8ed8ff;border-bottom:2px solid #8b5cf6;pointer-events:none}.ve-vllo-trim-shade{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.58);pointer-events:none}.ve-vllo-handle{position:absolute;z-index:8;top:50%;width:44px;height:58px;transform:translate(-50%,-50%);border:0;background:transparent;padding:0;touch-action:none}.ve-vllo-handle:before{content:'';position:absolute;left:50%;top:7px;bottom:7px;width:10px;transform:translateX(-50%);border-radius:5px;background:var(--handle-color);box-shadow:0 0 0 1px rgba(255,255,255,.55)}.ve-vllo-handle:after{content:var(--handle-arrow);position:absolute;left:50%;top:50%;transform:translate(-50%,-52%);font-size:10px;font-weight:900;color:#071018}.ve-vllo-handle.start{--handle-color:#8ed8ff;--handle-arrow:'▶'}.ve-vllo-handle.end{--handle-color:#9b6cff;--handle-arrow:'◀'}.ve-vllo-time-row{margin-top:7px;color:#9ca3af;font-size:11px;font-weight:800}.ve-vllo-time-row .used{color:#d5d9e1}
      .ve-vllo-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}.ve-vllo-tool{min-height:50px;border:1px solid rgba(255,255,255,.1);background:#1a1f29;color:#d5d9e1;border-radius:12px;font-size:10px;font-weight:800;display:grid;place-items:center;padding:5px}.ve-vllo-tool strong{font-size:19px}.ve-vllo-tool:disabled{opacity:.32}.ve-vllo-tool.danger{color:#fca5a5;border-color:rgba(251,113,133,.25)}
      .ve-vllo-material-shade{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.68);display:none}.ve-vllo-material-shade.open{display:block}.ve-vllo-material-sheet{position:absolute;left:0;right:0;bottom:0;max-height:78dvh;background:#090c11;border-radius:24px 24px 0 0;border-top:1px solid rgba(255,255,255,.12);padding:14px 12px calc(20px + env(safe-area-inset-bottom,0px));overflow:auto}.ve-vllo-material-head{display:flex;justify-content:space-between;align-items:center;position:sticky;top:-14px;background:#090c11;padding:14px 2px 8px;z-index:2}.ve-vllo-close{width:36px;height:36px;border:0;border-radius:50%;background:#242a34;color:#fff;font-size:22px}
      #veList{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;background:transparent}#veList .old{padding:7px!important;border-radius:14px!important;gap:6px!important}#veList .old>div:first-child{height:108px!important;border-radius:10px!important}#veList .ve-select-btn{width:30px;height:30px;right:7px;top:7px}#veClipEmpty,#veClipList{display:none!important}#veBar{position:fixed!important;z-index:45;left:max(12px,calc((100vw - 736px)/2));right:max(12px,calc((100vw - 736px)/2));bottom:calc(8px + env(safe-area-inset-bottom,0px));margin:0!important;box-shadow:0 14px 40px rgba(0,0,0,.55)}#veSelectedBar{max-height:50px}#veSubmit{padding:14px!important;font-size:18px!important}
      @media(max-width:520px){.wrap{padding-left:8px;padding-right:8px}.ve-vllo-stage{padding:9px}.ve-vllo-actions{gap:5px}}
    `;
    document.head.appendChild(style);

    const section=document.getElementById('videoEditSection');
    const loading=document.getElementById('veLoading');
    const empty=document.getElementById('veEmpty');
    const list=document.getElementById('veList');
    if(!section||!list)return;

    const shell=document.createElement('div');
    shell.className='ve-vllo-shell';
    shell.innerHTML=`<div class="ve-vllo-topbar"><div class="ve-vllo-title">動画編集</div><div class="ve-vllo-count" id="veVlloCount">0 / 6クリップ</div></div><div class="ve-vllo-preview" id="veVlloPreview"><div class="ve-vllo-preview-empty">下の＋から素材を追加してください</div></div><div class="ve-vllo-stage"><div class="ve-vllo-ruler"><span id="veVlloCurrent">00:00</span><span>タイムライン</span><span id="veVlloTotal">00:00</span></div><div class="ve-vllo-timeline-wrap" id="veVlloTimelineWrap"><div class="ve-vllo-timeline" id="veVlloTimeline"></div></div><div id="veVlloTrim"></div><div class="ve-vllo-actions"><button type="button" class="ve-vllo-tool" id="veVlloAdd"><strong>＋</strong><span>素材</span></button><button type="button" class="ve-vllo-tool" id="veVlloUp"><strong>←</strong><span>前へ</span></button><button type="button" class="ve-vllo-tool" id="veVlloDown"><strong>→</strong><span>後ろへ</span></button><button type="button" class="ve-vllo-tool danger" id="veVlloRemove"><strong>⌫</strong><span>削除</span></button></div></div>`;

    const shade=document.createElement('div');
    shade.className='ve-vllo-material-shade';
    shade.innerHTML='<div class="ve-vllo-material-sheet"><div class="ve-vllo-material-head"><b>素材を追加</b><button type="button" class="ve-vllo-close">×</button></div></div>';
    shade.querySelector('.ve-vllo-material-sheet').appendChild(list);
    document.body.appendChild(shade);
    section.insertBefore(shell,loading||section.firstChild);

    const originalRenderList=veRenderList;
    const originalAddClip=veAddClip;

    function getClip(clipId){return veSelected.find(c=>c.clipId===clipId)||null}
    function selected(){if(!veSelected.length)return null;let c=getClip(activeClipId);if(!c){c=veSelected[0];activeClipId=c.clipId}return c}
    function clock(v){v=Math.max(0,Number(v)||0);return String(Math.floor(v/60)).padStart(2,'0')+':'+String(Math.floor(v%60)).padStart(2,'0')}
    function selectedOffset(c){let total=0;for(const item of veSelected){if(item.clipId===c.clipId)break;total+=Math.max(0,item.end-item.start)}return total}
    function setLegacyVisibility(){const editing=document.querySelector('.tabs button[data-mode="video_edit"]')?.classList.contains('on');const history=document.getElementById('history');const heading=history?.previousElementSibling;if(history)history.style.display=editing?'none':'';if(heading?.classList.contains('section'))heading.style.display=editing?'none':''}
    function seekVideo(video,target){return new Promise(resolve=>{if(!video||!Number.isFinite(target)){resolve();return}const max=Math.max(0,(Number(video.duration)||target+.1)-.05);const safe=Math.min(Math.max(0,target),max);if(Math.abs((Number(video.currentTime)||0)-safe)<.04){resolve();return}let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener('seeked',finish);resolve()};const timer=setTimeout(finish,1200);video.addEventListener('seeked',finish,{once:true});try{video.currentTime=safe}catch(_){finish()}})}
    function updatePlayhead(c,time){if(!c)return;const duration=Math.max(.1,c.end-c.start);const progress=Math.max(0,Math.min(1,((Number(time)||c.start)-c.start)/duration));const clipEl=document.querySelector('[data-select="'+CSS.escape(c.clipId)+'"]');const head=clipEl?.querySelector('.ve-vllo-clip-playhead');if(head)head.style.left=(progress*100)+'%';const current=document.getElementById('veVlloCurrent');if(current)current.textContent=clock(selectedOffset(c)+progress*duration)}

    function renderPreview(c){
      const host=document.getElementById('veVlloPreview');
      if(!c){host.innerHTML='<div class="ve-vllo-preview-empty">下の＋から素材を追加してください</div>';return}
      const source=veVideos.find(v=>v.id===c.videoId);
      host.innerHTML='<video muted playsinline preload="metadata" src="'+esc(source?.video_url||'')+'"></video><div class="ve-vllo-preview-controls"><button type="button">▶</button><span class="ve-vllo-time">'+veFmtTime(c.start)+' – '+veFmtTime(c.end)+'</span></div>';
      const video=host.querySelector('video');
      const button=host.querySelector('button');
      video.addEventListener('loadedmetadata',async()=>{await seekVideo(video,c.start);updatePlayhead(c,c.start)});
      video.addEventListener('timeupdate',()=>{const live=getClip(c.clipId);if(!live)return;updatePlayhead(live,video.currentTime);if(video.currentTime>=live.end-.02){video.pause();seekVideo(video,live.start).then(()=>updatePlayhead(live,live.start));button.textContent='▶'}});
      button.onclick=async()=>{const live=getClip(c.clipId);if(!live)return;if(!video.paused){video.pause();button.textContent='▶';return}video.pause();button.disabled=true;await seekVideo(video,live.start);updatePlayhead(live,live.start);button.disabled=false;try{await video.play();button.textContent='❚❚'}catch(_){button.textContent='▶'}};
    }

    function seekPreview(c,time){const host=document.getElementById('veVlloPreview');const video=host?.querySelector('video');const label=host?.querySelector('.ve-vllo-time');if(label)label.textContent=veFmtTime(c.start)+' – '+veFmtTime(c.end);if(!video)return;video.pause();const button=host.querySelector('button');if(button)button.textContent='▶';seekVideo(video,Number(time)||0).then(()=>updatePlayhead(c,Number(time)||0))}

    function renderTimeline(){
      const host=document.getElementById('veVlloTimeline');
      const sum=veSelected.reduce((n,c)=>n+Math.max(0,c.end-c.start),0);
      document.getElementById('veVlloCount').textContent=veSelected.length+' / 6クリップ';
      document.getElementById('veVlloTotal').textContent=clock(sum);
      host.innerHTML=veSelected.map((c,i)=>{const source=veVideos.find(v=>v.id===c.videoId);const sec=Math.max(.1,c.end-c.start);const width=Math.max(72,Math.min(190,sec*12));const playhead=c.clipId===activeClipId?'<span class="ve-vllo-clip-playhead"></span>':'';return '<button type="button" class="ve-vllo-clip'+(c.clipId===activeClipId?' active':'')+'" data-select="'+esc(c.clipId)+'" data-ve-clip-id="'+esc(c.clipId)+'" data-ve-video-id="'+esc(c.videoId)+'" style="width:'+width+'px"><div data-ve-filmstrip-fallback></div><video muted playsinline preload="metadata" src="'+esc(source?.video_url||'')+'#t='+Math.max(.01,c.start)+'"></video><div data-ve-filmstrip></div>'+playhead+'<span class="ve-vllo-clip-num">'+(i+1)+'</span><span class="ve-vllo-clip-time">'+veFmtTime(sec)+'</span></button>'}).join('')+'<button type="button" class="ve-vllo-add" id="veVlloTimelineAdd">＋</button>';
      const active=selected();if(active)updatePlayhead(active,active.start);
    }

    function trimMarkup(c){const d=Math.max(.2,c.duration||5),sp=c.start/d*100,ep=c.end/d*100,i=veSelected.findIndex(x=>x.clipId===c.clipId);return '<div class="ve-vllo-trim" data-ve-clip-id="'+esc(c.clipId)+'" data-ve-video-id="'+esc(c.videoId)+'"><div class="ve-vllo-trim-head"><span class="ve-vllo-trim-title">クリップ '+(i+1)+' をトリミング</span><span class="ve-vllo-trim-title" data-used>使用 '+veFmtTime(c.end-c.start)+'</span></div><div class="ve-vllo-trim-track"><div data-ve-filmstrip-fallback></div><div data-ve-filmstrip></div><div class="ve-vllo-trim-shade" data-left-shade style="left:0;width:'+sp+'%"></div><div class="ve-vllo-trim-window" data-window style="left:'+sp+'%;right:'+(100-ep)+'%"></div><div class="ve-vllo-trim-shade" data-right-shade style="left:'+ep+'%;right:0"></div><button type="button" class="ve-vllo-handle start" data-handle="start" style="left:'+sp+'%" aria-label="開始位置"></button><button type="button" class="ve-vllo-handle end" data-handle="end" style="left:'+ep+'%" aria-label="終了位置"></button></div><div class="ve-vllo-time-row"><span data-start>'+veFmtTime(c.start)+'</span><span class="used" data-used-row>使用: '+veFmtTime(c.end-c.start)+'</span><span data-end>'+veFmtTime(c.end)+'</span></div></div>'}
    function syncTrimDom(c){const root=document.querySelector('#veVlloTrim [data-ve-clip-id="'+CSS.escape(c.clipId)+'"]');if(!root)return;const d=Math.max(.2,c.duration||5),sp=c.start/d*100,ep=c.end/d*100;root.querySelector('[data-handle="start"]').style.left=sp+'%';root.querySelector('[data-handle="end"]').style.left=ep+'%';root.querySelector('[data-window]').style.left=sp+'%';root.querySelector('[data-window]').style.right=(100-ep)+'%';root.querySelector('[data-left-shade]').style.width=sp+'%';root.querySelector('[data-right-shade]').style.left=ep+'%';root.querySelector('[data-start]').textContent=veFmtTime(c.start);root.querySelector('[data-end]').textContent=veFmtTime(c.end);root.querySelector('[data-used]').textContent='使用 '+veFmtTime(c.end-c.start);root.querySelector('[data-used-row]').textContent='使用: '+veFmtTime(c.end-c.start);const cost=document.getElementById('veCost');if(cost)cost.textContent=String(veCreditEstimate())}
    function syncFilmstrips(){setTimeout(()=>{if(typeof veFilmstripSyncSelected==='function')veFilmstripSyncSelected();const ids=[...new Set(veSelected.map(c=>c.videoId))];ids.forEach(id=>{if(typeof veFilmstripApplyToVisibleCard==='function')veFilmstripApplyToVisibleCard(id)})},0)}
    function renderTrim(c){const host=document.getElementById('veVlloTrim');host.innerHTML=c?trimMarkup(c):'';if(c)installTrimDrag(c.clipId)}
    function installTrimDrag(clipId){const root=document.querySelector('#veVlloTrim [data-ve-clip-id="'+CSS.escape(clipId)+'"]');const track=root?.querySelector('.ve-vllo-trim-track');if(!track)return;let kind=null,pointerId=null;const apply=(clientX,commit)=>{const clip=getClip(clipId);if(!clip)return;const r=track.getBoundingClientRect();if(!r.width)return;const raw=Math.max(0,Math.min(1,(clientX-r.left)/r.width))*clip.duration;if(kind==='start')clip.start=Math.min(raw,clip.end-.1);else clip.end=Math.max(raw,clip.start+.1);veClampClip(clip,clip.duration);syncTrimDom(clip);seekPreview(clip,kind==='start'?clip.start:Math.max(clip.start,clip.end-.05));if(commit){renderTimeline();syncFilmstrips();if(typeof veRenderBar==='function')veRenderBar()}};track.addEventListener('pointerdown',e=>{e.preventDefault();const clip=getClip(clipId);if(!clip)return;const handle=e.target.closest('[data-handle]');if(handle)kind=handle.dataset.handle;else{const r=track.getBoundingClientRect(),t=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*clip.duration;kind=Math.abs(t-clip.start)<=Math.abs(t-clip.end)?'start':'end'}pointerId=e.pointerId;track.setPointerCapture?.(pointerId);apply(e.clientX,false)});track.addEventListener('pointermove',e=>{if(pointerId!==e.pointerId)return;e.preventDefault();apply(e.clientX,false)});const finish=e=>{if(pointerId!==e.pointerId)return;e.preventDefault();apply(e.clientX,true);try{track.releasePointerCapture(pointerId)}catch(_){}pointerId=null;kind=null};track.addEventListener('pointerup',finish);track.addEventListener('pointercancel',e=>{if(pointerId===e.pointerId){pointerId=null;kind=null}})}
    function syncButtons(c){const i=c?veSelected.findIndex(x=>x.clipId===c.clipId):-1;document.getElementById('veVlloUp').disabled=i<=0;document.getElementById('veVlloDown').disabled=i<0||i>=veSelected.length-1;document.getElementById('veVlloRemove').disabled=i<0}
    function renderAll(){const c=selected();renderPreview(c);renderTimeline();renderTrim(c);syncButtons(c);syncFilmstrips();if(empty)empty.style.display=veVideos.length?'none':'block';setLegacyVisibility()}

    veRenderList=function(){if(!veVideos.length){if(empty)empty.style.display='block';list.innerHTML=''}else{if(empty)empty.style.display='none';list.innerHTML=veVideos.map(v=>veMaterialCard(v)).join('')}renderAll()};
    veAddClip=function(id){const before=veSelected.length;originalAddClip(id);if(veSelected.length>before){const added=veSelected[veSelected.length-1];veSelected[veSelected.length-1]={clipId:added.clipId||crypto.randomUUID(),videoId:added.videoId,start:Number(added.start)||0,end:Number(added.end)||Number(added.duration)||5,duration:Number(added.duration)||5};activeClipId=veSelected[veSelected.length-1].clipId;shade.classList.remove('open');renderAll();if(typeof veRenderBar==='function')veRenderBar();setTimeout(()=>document.getElementById('veVlloTimelineWrap')?.scrollTo({left:99999,behavior:'smooth'}),0)}};

    shell.onclick=e=>{const sel=e.target.closest('[data-select]');if(sel){activeClipId=sel.dataset.select;renderAll();return}if(e.target.closest('#veVlloAdd')||e.target.closest('#veVlloTimelineAdd')){shade.classList.add('open');return}const c=selected();if(!c)return;if(e.target.closest('#veVlloUp')){veMoveClip(c.clipId,'up');renderAll()}else if(e.target.closest('#veVlloDown')){veMoveClip(c.clipId,'down');renderAll()}else if(e.target.closest('#veVlloRemove')){const i=veSelected.findIndex(x=>x.clipId===c.clipId);veRemoveClip(c.clipId);activeClipId=veSelected[Math.min(i,veSelected.length-1)]?.clipId||null;renderAll()}};
    shade.querySelector('.ve-vllo-close').onclick=()=>shade.classList.remove('open');
    shade.onclick=e=>{if(e.target===shade)shade.classList.remove('open')};

    function preserveModeInUrl(modeName){const url=new URL(location.href);if(url.searchParams.get('mode')!==modeName){url.searchParams.set('mode',modeName);history.replaceState(null,'',url)}}
    document.querySelectorAll('.tabs button').forEach(button=>button.addEventListener('click',()=>{const m=button.dataset.mode;if(m)preserveModeInUrl(m);setTimeout(setLegacyVisibility,0)},true));

    function restoreVideoEditMode(){
      if(new URLSearchParams(location.search).get('mode')!=='video_edit')return;
      const tab=document.querySelector('.tabs button[data-mode="video_edit"]');
      if(tab?.classList.contains('on')){setLegacyVisibility();return}
      if(typeof onVideoEditTab==='function')onVideoEditTab();else tab?.click();
      restoreAttempts++;
      if(restoreAttempts<5)setTimeout(restoreVideoEditMode,restoreAttempts*350);
    }

    originalRenderList();
    renderAll();
    setTimeout(restoreVideoEditMode,0);
    setTimeout(restoreVideoEditMode,500);
    setTimeout(restoreVideoEditMode,1400);
  }
  ready(()=>setTimeout(install,0));
  window.addEventListener('pageshow',()=>setTimeout(install,0));
})();
