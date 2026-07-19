(function(){
  function ready(fn){
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});
    else fn();
  }

  function install(){
    if(window.__flowvidVlloEditorInstalled)return;
    if(!document.getElementById('videoEditSection'))return;
    if(typeof veRenderList!=='function'||typeof veAddClip!=='function'){
      setTimeout(install,50);
      return;
    }
    window.__flowvidVlloEditorInstalled=true;

    let activeClipId=null;
    let materialOpen=false;

    const style=document.createElement('style');
    style.textContent=`
      #videoEditSection{padding-bottom:150px}
      #videoEditSection>.section:first-child,#videoEditSection>p{display:none}
      .ve-vllo-shell{display:grid;gap:12px}
      .ve-vllo-topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 2px 0}
      .ve-vllo-title{font-size:17px;font-weight:900}
      .ve-vllo-count{color:#8b93a4;font-size:12px;font-weight:700}
      .ve-vllo-preview{position:relative;background:#090c11;border:1px solid rgba(255,255,255,.08);border-radius:18px;overflow:hidden;aspect-ratio:16/9;display:grid;place-items:center}
      .ve-vllo-preview video{width:100%;height:100%;object-fit:contain;background:#050506;display:block}
      .ve-vllo-preview-empty{color:#6b7280;font-size:13px;font-weight:700;text-align:center;padding:24px}
      .ve-vllo-preview-controls{position:absolute;left:10px;right:10px;bottom:10px;display:flex;justify-content:space-between;align-items:center;pointer-events:none}
      .ve-vllo-preview-controls button{pointer-events:auto;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.62);color:#fff;font-size:18px;display:grid;place-items:center}
      .ve-vllo-time{background:rgba(0,0,0,.58);border-radius:999px;padding:6px 10px;color:#d7dbe4;font-size:11px;font-weight:800}
      .ve-vllo-stage{background:#101319;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:12px;overflow:hidden}
      .ve-vllo-ruler{display:flex;justify-content:space-between;color:#687080;font-size:10px;font-weight:700;margin-bottom:6px;padding:0 4px}
      .ve-vllo-timeline-wrap{position:relative;overflow-x:auto;overflow-y:hidden;padding:16px calc(50% - 36px) 12px;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
      .ve-vllo-timeline{display:flex;align-items:stretch;gap:4px;min-width:max-content}
      .ve-vllo-playhead{position:absolute;z-index:6;left:50%;top:4px;bottom:4px;width:2px;background:#19a7ff;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none}
      .ve-vllo-playhead:before{content:'';position:absolute;left:50%;top:-2px;transform:translateX(-50%);width:10px;height:10px;border-radius:50%;background:#19a7ff}
      .ve-vllo-clip{position:relative;flex:0 0 auto;height:72px;min-width:72px;max-width:190px;border:2px solid transparent;border-radius:9px;overflow:hidden;background:#242a34;scroll-snap-align:center;cursor:pointer}
      .ve-vllo-clip.active{border-color:#19a7ff;box-shadow:0 0 0 1px rgba(25,167,255,.35)}
      .ve-vllo-clip [data-ve-filmstrip]{position:absolute;inset:0;display:flex}
      .ve-vllo-clip [data-ve-filmstrip] canvas{min-width:0;flex:1 1 0;width:100%;height:100%;object-fit:cover}
      .ve-vllo-clip [data-ve-filmstrip-fallback]{position:absolute;inset:0;background:linear-gradient(90deg,#2a3340,#3f4c60,#2a3340)}
      .ve-vllo-clip video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.5}
      .ve-vllo-clip-num{position:absolute;z-index:3;top:4px;left:4px;min-width:20px;height:20px;padding:0 5px;border-radius:7px;background:rgba(0,0,0,.72);display:grid;place-items:center;font-size:10px;font-weight:900}
      .ve-vllo-clip-time{position:absolute;z-index:3;right:4px;bottom:4px;background:rgba(0,0,0,.72);border-radius:6px;padding:2px 5px;font-size:9px;font-weight:800}
      .ve-vllo-add{flex:0 0 58px;height:72px;border-radius:9px;border:1px dashed rgba(255,255,255,.28);background:#171b23;color:#fff;font-size:27px;display:grid;place-items:center}
      .ve-vllo-trim{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px}
      .ve-vllo-trim-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
      .ve-vllo-trim-title{font-size:12px;color:#cbd2dd;font-weight:800}
      .ve-vllo-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px}
      .ve-vllo-tool{min-height:48px;border:1px solid rgba(255,255,255,.1);background:#1a1f29;color:#d5d9e1;border-radius:12px;font-size:11px;font-weight:800;display:grid;place-items:center;gap:2px;padding:5px}
      .ve-vllo-tool strong{font-size:19px;line-height:1}
      .ve-vllo-tool:disabled{opacity:.32}
      .ve-vllo-tool.danger{color:#fca5a5;border-color:rgba(251,113,133,.25)}
      .ve-vllo-material-shade{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.68);display:none}
      .ve-vllo-material-shade.open{display:block}
      .ve-vllo-material-sheet{position:absolute;left:0;right:0;bottom:0;max-height:78dvh;background:#090c11;border-radius:24px 24px 0 0;border-top:1px solid rgba(255,255,255,.12);padding:14px 12px calc(20px + env(safe-area-inset-bottom,0px));overflow:auto}
      .ve-vllo-material-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;position:sticky;top:-14px;background:#090c11;padding:14px 2px 8px;z-index:2}
      .ve-vllo-material-head b{font-size:16px}
      .ve-vllo-close{width:36px;height:36px;border:0;border-radius:50%;background:#242a34;color:#fff;font-size:22px}
      #veList{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;background:transparent}
      #veList .old{padding:7px!important;border-radius:14px!important;gap:6px!important}
      #veList .old>div:first-child{height:108px!important;border-radius:10px!important}
      #veList .ve-select-btn{width:30px;height:30px;right:7px;top:7px}
      #veList>article>div:last-child{font-size:10px!important}
      #veClipEmpty{display:none!important}
      #veClipList{display:block;background:transparent}
      #veBar{position:fixed!important;z-index:45;left:max(12px,calc((100vw - 736px)/2));right:max(12px,calc((100vw - 736px)/2));bottom:calc(8px + env(safe-area-inset-bottom,0px));margin:0!important;box-shadow:0 14px 40px rgba(0,0,0,.55)}
      #veSelectedBar{max-height:50px}
      #veSubmit{padding:14px!important;font-size:18px!important}
      @media(max-width:520px){
        .wrap{padding-left:8px;padding-right:8px}
        .ve-vllo-shell{gap:9px}
        .ve-vllo-stage{padding:9px}
        .ve-vllo-preview{border-radius:14px}
        .ve-vllo-timeline-wrap{padding-left:calc(50% - 32px);padding-right:calc(50% - 32px)}
        .ve-vllo-actions{gap:5px}
        .ve-vllo-tool{font-size:10px;border-radius:10px}
      }
    `;
    document.head.appendChild(style);

    const section=document.getElementById('videoEditSection');
    const loading=document.getElementById('veLoading');
    const empty=document.getElementById('veEmpty');
    const list=document.getElementById('veList');
    const clipList=document.getElementById('veClipList');
    const clipEmpty=document.getElementById('veClipEmpty');
    if(!section||!list||!clipList)return;

    const shell=document.createElement('div');
    shell.className='ve-vllo-shell';
    shell.innerHTML=`
      <div class="ve-vllo-topbar"><div class="ve-vllo-title">動画編集</div><div class="ve-vllo-count" id="veVlloCount">0 / 6クリップ</div></div>
      <div class="ve-vllo-preview" id="veVlloPreview"><div class="ve-vllo-preview-empty">下の＋から素材を追加してください</div></div>
      <div class="ve-vllo-stage">
        <div class="ve-vllo-ruler"><span>00:00</span><span>タイムライン</span><span id="veVlloTotal">00:00</span></div>
        <div class="ve-vllo-timeline-wrap" id="veVlloTimelineWrap"><div class="ve-vllo-playhead"></div><div class="ve-vllo-timeline" id="veVlloTimeline"></div></div>
        <div id="veVlloTrim"></div>
        <div class="ve-vllo-actions">
          <button type="button" class="ve-vllo-tool" id="veVlloAdd"><strong>＋</strong><span>素材</span></button>
          <button type="button" class="ve-vllo-tool" id="veVlloUp"><strong>←</strong><span>前へ</span></button>
          <button type="button" class="ve-vllo-tool" id="veVlloDown"><strong>→</strong><span>後ろへ</span></button>
          <button type="button" class="ve-vllo-tool danger" id="veVlloRemove"><strong>⌫</strong><span>削除</span></button>
        </div>
      </div>
    `;

    const shade=document.createElement('div');
    shade.className='ve-vllo-material-shade';
    shade.id='veVlloMaterials';
    shade.innerHTML='<div class="ve-vllo-material-sheet"><div class="ve-vllo-material-head"><b>素材を追加</b><button type="button" class="ve-vllo-close" aria-label="閉じる">×</button></div></div>';
    shade.querySelector('.ve-vllo-material-sheet').appendChild(list);
    document.body.appendChild(shade);

    section.insertBefore(shell,loading||section.firstChild);
    shell.querySelector('.ve-vllo-stage').insertBefore(clipList,shell.querySelector('.ve-vllo-actions'));
    if(clipEmpty)clipEmpty.remove();

    const originalRenderList=veRenderList;
    const originalAddClip=veAddClip;

    function selectedClip(){
      if(!veSelected.length)return null;
      let clip=veSelected.find(c=>c.clipId===activeClipId);
      if(!clip){clip=veSelected[0];activeClipId=clip.clipId}
      return clip;
    }

    function fmtClock(seconds){
      const value=Math.max(0,Number(seconds)||0);
      const m=Math.floor(value/60);
      const s=Math.floor(value%60);
      return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    }

    function renderPreview(clip){
      const host=document.getElementById('veVlloPreview');
      if(!host)return;
      if(!clip){host.innerHTML='<div class="ve-vllo-preview-empty">下の＋から素材を追加してください</div>';return}
      const source=veVideos.find(v=>v.id===clip.videoId);
      host.innerHTML='<video id="veVlloPreviewVideo" muted playsinline preload="metadata" src="'+esc(source?.video_url||'')+'#t='+Math.max(.01,clip.start)+'"></video><div class="ve-vllo-preview-controls"><button type="button" id="veVlloPlay" aria-label="再生">▶</button><span class="ve-vllo-time">'+veFmtTime(clip.start)+' – '+veFmtTime(clip.end)+'</span></div>';
      const video=host.querySelector('video');
      const play=host.querySelector('#veVlloPlay');
      const stopAtEnd=()=>{if(video.currentTime>=clip.end){video.pause();video.currentTime=clip.start;play.textContent='▶'}};
      video.addEventListener('timeupdate',stopAtEnd);
      video.addEventListener('ended',()=>{play.textContent='▶'});
      play.addEventListener('click',()=>{
        if(video.paused){if(video.currentTime<clip.start||video.currentTime>=clip.end)video.currentTime=clip.start;video.play().then(()=>{play.textContent='❚❚'}).catch(()=>{})}
        else{video.pause();play.textContent='▶'}
      });
    }

    function renderTimeline(){
      const timeline=document.getElementById('veVlloTimeline');
      const count=document.getElementById('veVlloCount');
      const total=document.getElementById('veVlloTotal');
      if(!timeline)return;
      const sum=veSelected.reduce((n,c)=>n+Math.max(0,c.end-c.start),0);
      if(count)count.textContent=veSelected.length+' / 6クリップ';
      if(total)total.textContent=fmtClock(sum);
      timeline.innerHTML=veSelected.map((clip,index)=>{
        const source=veVideos.find(v=>v.id===clip.videoId);
        const seconds=Math.max(.1,clip.end-clip.start);
        const width=Math.max(72,Math.min(190,seconds*12));
        return '<button type="button" class="ve-vllo-clip'+(clip.clipId===activeClipId?' active':'')+'" data-ve-vllo-select="'+esc(clip.clipId)+'" data-ve-clip-id="'+esc(clip.clipId)+'" data-ve-video-id="'+esc(clip.videoId)+'" style="width:'+width+'px"><div data-ve-filmstrip-fallback></div><video muted playsinline preload="metadata" src="'+esc(source?.video_url||'')+'#t='+Math.max(.01,clip.start)+'"></video><div data-ve-filmstrip></div><span class="ve-vllo-clip-num">'+(index+1)+'</span><span class="ve-vllo-clip-time">'+veFmtTime(seconds)+'</span></button>';
      }).join('')+'<button type="button" class="ve-vllo-add" id="veVlloTimelineAdd" aria-label="素材追加">＋</button>';
    }

    function renderTrim(clip){
      const host=document.getElementById('veVlloTrim');
      if(!host)return;
      if(!clip){host.innerHTML='';return}
      const index=veSelected.findIndex(c=>c.clipId===clip.clipId);
      host.innerHTML='<div class="ve-vllo-trim" data-ve-clip-id="'+esc(clip.clipId)+'" data-ve-video-id="'+esc(clip.videoId)+'"><div class="ve-vllo-trim-head"><span class="ve-vllo-trim-title">クリップ '+(index+1)+' をトリミング</span><span class="ve-vllo-trim-title">使用 '+veFmtTime(clip.end-clip.start)+'</span></div>'+veTrimEditorHtml(clip)+'</div>';
    }

    function syncButtons(clip){
      const up=document.getElementById('veVlloUp');
      const down=document.getElementById('veVlloDown');
      const remove=document.getElementById('veVlloRemove');
      const index=clip?veSelected.findIndex(c=>c.clipId===clip.clipId):-1;
      if(up)up.disabled=index<=0;
      if(down)down.disabled=index<0||index>=veSelected.length-1;
      if(remove)remove.disabled=index<0;
    }

    function renderVllo(){
      const clip=selectedClip();
      renderPreview(clip);
      renderTimeline();
      renderTrim(clip);
      syncButtons(clip);
      if(typeof veFilmstripSyncSelected==='function')setTimeout(veFilmstripSyncSelected,0);
      if(empty)empty.style.display=veVideos.length?'none':'block';
    }

    veRenderList=function(){
      if(list){
        if(!veVideos.length){if(empty)empty.style.display='block';list.innerHTML=''}
        else{if(empty)empty.style.display='none';list.innerHTML=veVideos.map(v=>veMaterialCard(v)).join('')}
      }
      renderVllo();
    };

    veAddClip=function(videoId){
      const before=veSelected.length;
      originalAddClip(videoId);
      if(veSelected.length>before){activeClipId=veSelected[veSelected.length-1].clipId;materialOpen=false;shade.classList.remove('open');renderVllo();setTimeout(()=>document.getElementById('veVlloTimelineWrap')?.scrollTo({left:99999,behavior:'smooth'}),0)}
    };

    function openMaterials(){materialOpen=true;shade.classList.add('open')}
    function closeMaterials(){materialOpen=false;shade.classList.remove('open')}

    shell.addEventListener('click',e=>{
      const select=e.target.closest('[data-ve-vllo-select]');
      if(select){activeClipId=select.getAttribute('data-ve-vllo-select');renderVllo();return}
      if(e.target.closest('#veVlloAdd')||e.target.closest('#veVlloTimelineAdd')){openMaterials();return}
      const clip=selectedClip();
      if(!clip)return;
      if(e.target.closest('#veVlloUp')){veMoveClip(clip.clipId,'up');renderVllo();return}
      if(e.target.closest('#veVlloDown')){veMoveClip(clip.clipId,'down');renderVllo();return}
      if(e.target.closest('#veVlloRemove')){const idx=veSelected.findIndex(c=>c.clipId===clip.clipId);veRemoveClip(clip.clipId);activeClipId=veSelected[Math.min(idx,veSelected.length-1)]?.clipId||null;renderVllo();return}
    });

    clipList.addEventListener('input',()=>{const clip=selectedClip();if(clip){renderPreview(clip);renderTimeline();syncButtons(clip)}},true);
    clipList.addEventListener('change',()=>{const clip=selectedClip();if(clip){renderPreview(clip);renderTimeline();syncButtons(clip)}},true);
    shade.querySelector('.ve-vllo-close').addEventListener('click',closeMaterials);
    shade.addEventListener('click',e=>{if(e.target===shade)closeMaterials()});

    originalRenderList();
    renderVllo();
  }

  ready(()=>setTimeout(install,0));
  window.addEventListener('pageshow',()=>setTimeout(install,0));
})();
