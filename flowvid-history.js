(function(){
  const DEVICE_KEY='flowvidDeviceId';
  const LAST_JOB_KEY='flowvidLastSeedanceJobId';
  const HISTORY_KEY='flowvidHistory';
  const FAVORITES_KEY='flowvidFavoriteJobs';
  const DRAFT_KEY='flowvidGenerateDraft';

  function deviceId(){
    let id=localStorage.getItem(DEVICE_KEY);
    if(!id){
      id='dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
      localStorage.setItem(DEVICE_KEY,id);
    }
    return id;
  }

  function safeJson(text, fallback){try{return JSON.parse(text||'')}catch(_){return fallback ?? {}}}
  function bodyJson(init){
    const body=init&&init.body;
    if(!body||typeof body!=='string')return {};
    return safeJson(body,{});
  }
  function extractJobId(data){
    return data?.jobId||data?.id||data?.data?.id||data?.response?.id||data?.response?.data?.id||data?.request_id||'';
  }
  function findVideoUrl(value){
    if(!value)return '';
    if(typeof value==='string'){
      if(/^https?:\/\//i.test(value)&&/\.(mp4|mov|webm)(\?|$)/i.test(value))return value;
      if(/^https?:\/\//i.test(value)&&/(output|download|storage|cdn|signed)/i.test(value)&&!/openrouter\.ai\/api\//i.test(value))return value;
      return '';
    }
    if(Array.isArray(value)){
      for(const item of value){const found=findVideoUrl(item);if(found)return found;}
      return '';
    }
    if(typeof value==='object'){
      for(const key of ['videoUrl','video_url','output_url','download_url','signed_url','url','uri','file_url','asset_url','play_url']){
        const found=findVideoUrl(value[key]);if(found)return found;
      }
      for(const key of Object.keys(value)){const found=findVideoUrl(value[key]);if(found)return found;}
    }
    return '';
  }
  function currentMode(){
    return localStorage.getItem('flowvidGenerateMode')||document.querySelector('[data-mode].on')?.dataset?.mode||'reference_to_video';
  }
  function modeLabel(value){
    const v=String(value||'');
    if(v==='image_to_video')return '画像から動画';
    if(v==='text_to_video')return 'テキストから動画';
    if(v==='reference_to_video')return 'リファレンス';
    return 'Seedance';
  }
  function esc(s){
    return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function localSave(item){
    if(!item?.url)return;
    const arr=safeJson(localStorage.getItem(HISTORY_KEY),[]);
    const list=Array.isArray(arr)?arr:[];
    if(!list.some(v=>v.url===item.url))list.unshift(item);
    localStorage.setItem(HISTORY_KEY,JSON.stringify(list.slice(0,20)));
  }
  async function saveRemote(payload){
    try{
      await originalFetch('/api/video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:deviceId(),...payload})});
    }catch(e){console.warn('[FlowVid history] remote save failed',e);}
  }

  function favorites(){
    const list=safeJson(localStorage.getItem(FAVORITES_KEY),[]);
    return Array.isArray(list)?list:[];
  }
  function isFavorite(jobId){return favorites().includes(String(jobId||''));}
  function toggleFavorite(jobId){
    if(!jobId)return;
    const id=String(jobId);
    const next=isFavorite(id)?favorites().filter(v=>v!==id):[id,...favorites()];
    localStorage.setItem(FAVORITES_KEY,JSON.stringify(next.slice(0,100)));
    loadApiHistory();
  }
  function shortDate(value){
    const d=value?new Date(value):null;
    if(!d||Number.isNaN(d.getTime()))return '';
    const diff=Math.max(0,Date.now()-d.getTime());
    const mins=Math.floor(diff/60000);
    if(mins<1)return '今';
    if(mins<60)return mins+'分前';
    const hours=Math.floor(mins/60);
    if(hours<24)return hours+'時間前';
    const days=Math.floor(hours/24);
    if(days<7)return days+'日前';
    return `${d.getMonth()+1}/${d.getDate()}`;
  }

  function installFixedHistoryStyle(){
    if(document.getElementById('fv-fixed-history-style'))return;
    const style=document.createElement('style');
    style.id='fv-fixed-history-style';
    style.textContent='\
      #history{display:grid;gap:14px}\
      #history .old{min-height:0;padding:12px;border-radius:22px;display:grid;grid-template-rows:auto auto auto;gap:10px;background:#1b1e25;border:1px solid rgba(255,255,255,.08)}\
      #history .oldTop{min-height:48px;margin:0;color:#c8c8d2;font-weight:800;line-height:1.35}\
      #history .fv-title-row{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}\
      #history .fv-prompt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\
      #history .fv-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;color:#8d94a3;font-size:12px;font-weight:800}\
      #history .fv-chip{border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:4px 7px;background:rgba(255,255,255,.04)}\
      #history .fv-video-frame{width:100%;aspect-ratio:16/9;background:#050506;border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center}\
      #history .fv-video-frame video{width:auto!important;height:100%!important;max-width:100%!important;max-height:100%!important;object-fit:contain!important;background:#000;border-radius:0;display:block}\
      #history .fv-card-actions{display:flex;gap:8px;align-items:center;justify-content:space-between}\
      #history .fv-left-actions,#history .fv-right-actions{display:flex;gap:8px;align-items:center}\
      #history .fv-action{min-width:52px;height:36px;border:0;border-radius:11px;background:#2b303a;color:#fff;text-decoration:none;display:grid;place-items:center;font-size:14px;font-weight:900;padding:0 11px}\
      #history .fv-action.fav{min-width:44px;width:44px;height:44px;padding:0;font-size:20px}\
      #history .fv-action.fav.on{background:rgba(251,191,36,.18);color:#fde68a}\
      #history .fv-delete-one{background:transparent;color:#fecdd3;border:1px solid rgba(251,113,133,.35);min-width:58px}\
      @media(max-width:520px){#history .old{padding:10px}#history .fv-video-frame{aspect-ratio:16/9}}\
    ';
    document.head.appendChild(style);
  }

  function normalizeRemoteItem(row){
    const url=row?.video_url||row?.video_uri||row?.src||row?.url||'';
    if(!/^https?:\/\//i.test(url))return null;
    if(/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(url))return null;
    return {
      url,
      jobId: row?.job_id||row?.jobId||row?.id||'',
      prompt: row?.prompt||row?.title||'生成動画',
      mode: row?.mode||row?.type||'',
      duration: row?.duration_seconds||row?.duration||5,
      aspect: row?.aspect_ratio||row?.aspectRatio||'9:16',
      model: row?.model||'Seedance',
      createdAt: row?.created_at||row?.createdAt||''
    };
  }
  function playHistoryVideos(){
    document.querySelectorAll('#history .fv-video-frame video').forEach((video)=>{
      video.muted=true; video.loop=true; video.playsInline=true;
      video.setAttribute('muted',''); video.setAttribute('loop',''); video.setAttribute('playsinline',''); video.setAttribute('webkit-playsinline','');
      const start=()=>video.play().catch(()=>{});
      video.addEventListener('canplay',start,{once:true});
      setTimeout(start,300);
    });
  }
  function renderApiHistoryList(items){
    const history=document.getElementById('history');
    if(!history)return;
    installFixedHistoryStyle();
    if(!items.length){history.innerHTML='<div class="empty">まだ動画がありません</div>';return;}
    const favs=favorites();
    const sorted=[...items].sort((a,b)=>{
      const af=favs.includes(String(a.jobId||''))?1:0;
      const bf=favs.includes(String(b.jobId||''))?1:0;
      if(af!==bf)return bf-af;
      return new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime();
    });
    history.innerHTML=sorted.map((it)=>{
      const title=esc((it.prompt||'生成動画').slice(0,72));
      const url=esc(it.url);
      const job=esc(it.jobId||'');
      const fav=isFavorite(it.jobId);
      const meta=[modeLabel(it.mode),it.aspect,`${it.duration||5}秒`,shortDate(it.createdAt)].filter(Boolean).map(v=>'<span class="fv-chip">'+esc(v)+'</span>').join('');
      return '<article class="old" data-job-id="'+job+'" data-url="'+url+'">'
        +'<div class="oldTop"><div class="fv-title-row"><div><div class="fv-prompt">'+title+'</div><div class="fv-meta">'+meta+'</div></div>'
        +'<button type="button" class="fv-action fav '+(fav?'on':'')+'" data-job-id="'+job+'" aria-label="お気に入り">'+(fav?'★':'☆')+'</button></div></div>'
        +'<div class="fv-video-frame"><video autoplay muted loop playsinline webkit-playsinline preload="auto" src="'+url+'"></video></div>'
        +'<div class="fv-card-actions"><div class="fv-left-actions"><a class="fv-action" href="'+url+'" target="_blank" rel="noreferrer">開く</a><a class="fv-action" href="'+url+'" download>保存</a></div>'
        +'<div class="fv-right-actions"><button type="button" class="fv-action fv-delete-one" data-job-id="'+job+'" data-url="'+url+'">削除</button></div></div></article>';
    }).join('');
    playHistoryVideos();
  }
  async function loadApiHistory(){
    const history=document.getElementById('history');
    if(!history)return;
    installFixedHistoryStyle();
    history.innerHTML='<div class="empty">履歴を読み込み中...</div>';
    try{
      const res=await originalFetch('/api/generated-videos?limit=50&t='+Date.now(),{cache:'no-store'});
      const data=await res.json();
      renderApiHistoryList((data?.rows||[]).map(normalizeRemoteItem).filter(Boolean));
    }catch(e){history.innerHTML='<div class="empty">履歴を読み込めませんでした</div>';}
  }
  async function deleteOneHistory(jobId){
    if(!jobId){alert('削除対象のjobIdがありません');return;}
    if(!confirm('この動画を履歴から削除しますか？\n\n動画ファイル本体は削除せず、履歴だけ削除します。'))return;
    try{
      const res=await originalFetch('/api/video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',jobId})});
      const data=await res.json();
      if(!res.ok||!data.ok)throw new Error(data?.error||'削除に失敗しました');
      localStorage.removeItem(HISTORY_KEY);
      await loadApiHistory();
    }catch(e){alert('削除できませんでした: '+(e?.message||e));}
  }

  function readDraft(){
    const d=safeJson(localStorage.getItem(DRAFT_KEY),{});
    return d&&typeof d==='object'?d:{};
  }
  function writeDraft(patch){
    const d={...readDraft(),...patch,updatedAt:new Date().toISOString()};
    localStorage.setItem(DRAFT_KEY,JSON.stringify(d));
    return d;
  }
  function selectedValue(id){return document.getElementById(id)?.value||'';}
  function collectDraftFromDom(){
    const existing=readDraft();
    return writeDraft({
      mode: currentMode(),
      prompt: document.getElementById('prompt')?.value||existing.prompt||'',
      model: selectedValue('model')||existing.model||'bytedance/seedance-2.0',
      aspect: selectedValue('aspect')||existing.aspect||'9:16',
      duration: selectedValue('duration')||existing.duration||'5',
      resolution: selectedValue('resolution')||existing.resolution||'720p',
      audio: selectedValue('audio')||existing.audio||'false',
      referenceUrls: Array.isArray(existing.referenceUrls)?existing.referenceUrls:[]
    });
  }
  function addDraftReferenceUrl(url){
    if(!url||!/^https?:\/\//i.test(url))return;
    const d=readDraft();
    const limit=currentMode()==='reference_to_video'?9:1;
    const list=(Array.isArray(d.referenceUrls)?d.referenceUrls:[]).filter(Boolean);
    if(!list.includes(url))list.push(url);
    writeDraft({mode:currentMode(),referenceUrls:list.slice(0,limit)});
    setTimeout(()=>{renderDraftAssets();updateDraftCreditButton();},0);
  }
  function renderDraftAssets(){
    const box=document.getElementById('assets');
    if(!box)return;
    const d=readDraft();
    const urls=Array.isArray(d.referenceUrls)?d.referenceUrls.filter(Boolean):[];
    if(!urls.length)return;
    const add=box.querySelector('.add');
    box.querySelectorAll('.thumb,.fv-restored-thumb').forEach(el=>el.remove());
    urls.forEach((url,i)=>{
      const div=document.createElement('div');
      div.className='thumb fv-restored-thumb';
      div.innerHTML='<img src="'+esc(url)+'"><small>図'+(i+1)+'</small>';
      if(add)box.insertBefore(div,add); else box.appendChild(div);
    });
  }
  function estimateDraftCredits(){
    const d={...readDraft(),duration:selectedValue('duration')||readDraft().duration,resolution:selectedValue('resolution')||readDraft().resolution,audio:selectedValue('audio')||readDraft().audio};
    const mode=currentMode();
    const refs=mode==='text_to_video'?0:Math.max(1,(Array.isArray(d.referenceUrls)?d.referenceUrls.length:0));
    let credits=80;
    credits+=Math.max(0,Number(d.duration||5)-5)*15;
    if((d.resolution||'720p')==='1080p')credits+=100;
    if((d.resolution||'720p')==='480p')credits-=20;
    if(mode==='reference_to_video')credits+=Math.max(0,refs-1)*10;
    if(mode==='text_to_video')credits-=10;
    if(String(d.audio)==='true')credits+=15;
    return Math.max(50,credits);
  }
  function updateDraftCreditButton(){
    const btn=document.getElementById('create');
    if(btn)btn.textContent='作成する ✦ '+estimateDraftCredits();
  }
  function restoreDraft(){
    const d=readDraft();
    const prompt=document.getElementById('prompt');
    if(prompt&&d.prompt&&!prompt.value)prompt.value=d.prompt;
    [['model',d.model],['aspect',d.aspect],['duration',d.duration],['resolution',d.resolution],['audio',d.audio]].forEach(([id,val])=>{
      const el=document.getElementById(id);
      if(el&&val)el.value=val;
    });
    if(d.mode){
      const btn=document.querySelector('[data-mode="'+d.mode+'"]');
      if(btn&&!btn.classList.contains('on'))btn.click();
    }
    renderDraftAssets();
    updateDraftCreditButton();
  }
  function doneStatus(data){return data?.done===true||String(data?.jobStatus||data?.status||data?.response?.status||'').toLowerCase()==='completed';}
  function failedStatus(data){return ['failed','error','cancelled','canceled'].includes(String(data?.jobStatus||data?.status||data?.response?.status||'').toLowerCase())||Number(data?.status)>=400;}
  function extractPollingUrl(d){
    if(!d||typeof d!=='object')return'';
    for(const k of ['pollingUrl','polling_url','statusUrl','status_url']){const v=d[k];if(typeof v==='string'&&/^https?:\/\//.test(v))return v;}
    for(const k of Object.keys(d)){const r=extractPollingUrl(d[k]);if(r)return r;}
    return'';
  }
  async function startFromDraft(e){
    if(e)e.preventDefault();
    const d=collectDraftFromDom();
    const mode=currentMode();
    const prompt=(document.getElementById('prompt')?.value||d.prompt||'').trim();
    const refs=Array.isArray(d.referenceUrls)?d.referenceUrls.filter(Boolean):[];
    if(!prompt)return;
    if(mode!=='text_to_video'&&!refs.length)return;
    const create=document.getElementById('create'), now=document.getElementById('now'), done=document.getElementById('done'), job=document.getElementById('job');
    const credit=estimateDraftCredits();
    if(create)create.disabled=true;
    if(done)done.classList.remove('show');
    if(now)now.classList.add('show');
    if(job)job.textContent='送信中…';
    const body={
      model:selectedValue('model')||d.model||'bytedance/seedance-2.0',
      prompt,
      duration:selectedValue('duration')||d.duration||'5',
      resolution:selectedValue('resolution')||d.resolution||'720p',
      aspect_ratio:selectedValue('aspect')||d.aspect||'9:16',
      generate_audio:(selectedValue('audio')||d.audio)==='true',
      estimated_credits:credit
    };
    if(mode==='image_to_video')body.first_frame_url=refs[0];
    if(mode==='reference_to_video'){body.reference_url=refs[0];body.reference_urls=refs;}
    try{
      const res=await originalFetch('/api/seedance-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await res.json();
      let jobId=extractJobId(data)||extractJobId(data?.response);
      let pollingUrl=data?.pollingUrl||extractPollingUrl(data?.response)||extractPollingUrl(data);
      if(jobId)localStorage.setItem(LAST_JOB_KEY,jobId);
      localStorage.setItem('flowvidLastSeedancePrompt',prompt);
      localStorage.setItem('flowvidLastSeedanceMode',mode);
      if(job)job.textContent=pollingUrl||jobId||'確認中…';
      const poll=async()=>{
        const params=new URLSearchParams();
        if(pollingUrl)params.set('pollingUrl',pollingUrl); else if(jobId)params.set('id',jobId);
        const r=await originalFetch('/api/seedance-status?'+params.toString());
        const s=await r.json();
        const videoUrl=s?.videoUrl||findVideoUrl(s);
        if(videoUrl&&doneStatus(s)){
          clearInterval(timer);
          if(create)create.disabled=false;
          if(now)now.classList.remove('show');
          const v=document.getElementById('video'), open=document.getElementById('open'), download=document.getElementById('download');
          if(v)v.src=videoUrl;
          if(open)open.href=videoUrl;
          if(download)download.href=videoUrl;
          if(done)done.classList.add('show');
          localSave({url:videoUrl,prompt,mode,jobId,createdAt:new Date().toISOString()});
          saveRemote({jobId,status:'completed',mode,prompt,videoUrl,referenceUrls:refs,settings:body});
          loadApiHistory();
          return;
        }
        if(failedStatus(s)){
          clearInterval(timer);
          if(create)create.disabled=false;
          if(now)now.classList.remove('show');
        }
      };
      let timer=setInterval(poll,12000);
      poll();
    }catch(err){
      if(create)create.disabled=false;
      if(now)now.classList.remove('show');
    }
  }
  function installDraftPersistence(){
    restoreDraft();
    const prompt=document.getElementById('prompt');
    if(prompt){prompt.addEventListener('input',()=>{writeDraft({prompt:prompt.value});});}
    ['model','aspect','duration','resolution','audio'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.addEventListener('change',()=>{collectDraftFromDom();updateDraftCreditButton();});
    });
    document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>setTimeout(()=>{collectDraftFromDom();renderDraftAssets();updateDraftCreditButton();},0)));
    const create=document.getElementById('create');
    if(create){create.onclick=startFromDraft;}
  }

  function installApiHistoryUi(){
    installFixedHistoryStyle();
    const clear=document.getElementById('clear');
    if(clear){
      clear.textContent='再読込';
      clear.onclick=function(){localStorage.removeItem(HISTORY_KEY);loadApiHistory();};
    }
    document.addEventListener('click',function(e){
      const del=e.target&&e.target.closest&&e.target.closest('.fv-delete-one');
      if(del){e.preventDefault();deleteOneHistory(del.dataset.jobId||'');return;}
      const fav=e.target&&e.target.closest&&e.target.closest('.fv-action.fav');
      if(fav){e.preventDefault();toggleFavorite(fav.dataset.jobId||'');}
    });
    setTimeout(loadApiHistory,0);
    setTimeout(loadApiHistory,700);
    setTimeout(installDraftPersistence,0);
    setTimeout(installDraftPersistence,700);
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) playHistoryVideos(); });
  }

  const originalFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input&&input.url)||'';
    const requestBody=bodyJson(init||{});
    const response=await originalFetch(input,init);

    if(url.includes('/api/upload-reference-image')){
      response.clone().json().then(data=>{
        const publicUrl=data?.publicUrl||data?.url||data?.public_url||'';
        addDraftReferenceUrl(publicUrl);
      }).catch(()=>{});
    }

    if(url.includes('/api/seedance-start')){
      response.clone().json().then(data=>{
        const jobId=extractJobId(data);
        if(!jobId)return;
        localStorage.setItem(LAST_JOB_KEY,jobId);
        const refs=[].concat(requestBody.reference_urls||requestBody.referenceUrls||requestBody.first_frame_url||[]).filter(Boolean);
        localStorage.setItem('flowvidLastSeedancePrompt',requestBody.prompt||'');
        localStorage.setItem('flowvidLastSeedanceMode',currentMode());
        writeDraft({prompt:requestBody.prompt||'',mode:currentMode(),referenceUrls:refs.length?refs:readDraft().referenceUrls});
        saveRemote({jobId,status:'processing',mode:currentMode(),prompt:requestBody.prompt||'',referenceUrls:refs,settings:{duration:requestBody.duration,resolution:requestBody.resolution,aspect_ratio:requestBody.aspect_ratio,model:requestBody.model}});
      }).catch(()=>{});
    }

    if(url.includes('/api/seedance-status')){
      response.clone().json().then(data=>{
        const jobId=data?.jobId||new URL(url,location.href).searchParams.get('id')||localStorage.getItem(LAST_JOB_KEY)||'';
        const videoUrl=data?.videoUrl||findVideoUrl(data);
        if(!jobId)return;
        if(videoUrl&&doneStatus(data)){
          const prompt=localStorage.getItem('flowvidLastSeedancePrompt')||document.getElementById('prompt')?.value||'';
          const mode=localStorage.getItem('flowvidLastSeedanceMode')||currentMode();
          localSave({url:videoUrl,prompt,mode,jobId,createdAt:new Date().toISOString()});
          saveRemote({jobId,status:'completed',mode,prompt,videoUrl});
          setTimeout(loadApiHistory,1000);
        }else{
          saveRemote({jobId,status:data?.jobStatus||data?.status||'processing',mode:currentMode(),prompt:localStorage.getItem('flowvidLastSeedancePrompt')||''});
        }
      }).catch(()=>{});
    }
    return response;
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installApiHistoryUi);
  else installApiHistoryUi();
})();
