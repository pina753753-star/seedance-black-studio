(function(){
  const DEVICE_KEY='flowvidDeviceId';
  const LAST_JOB_KEY='flowvidLastSeedanceJobId';
  const HISTORY_KEY='flowvidHistory';

  function deviceId(){
    let id=localStorage.getItem(DEVICE_KEY);
    if(!id){
      id='dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
      localStorage.setItem(DEVICE_KEY,id);
    }
    return id;
  }

  function safeJson(text){try{return JSON.parse(text||'{}')}catch(_){return {}}}
  function bodyJson(init){
    const body=init&&init.body;
    if(!body||typeof body!=='string')return {};
    return safeJson(body);
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
  function localSave(item){
    if(!item?.url)return;
    const list=safeJson(localStorage.getItem(HISTORY_KEY));
    const arr=Array.isArray(list)?list:[];
    if(!arr.some(v=>v.url===item.url))arr.unshift(item);
    localStorage.setItem(HISTORY_KEY,JSON.stringify(arr.slice(0,20)));
  }
  async function saveRemote(payload){
    try{
      await originalFetch('/api/video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:deviceId(),...payload})});
    }catch(e){console.warn('[FlowVid history] remote save failed',e);}
  }

  function esc(s){
    return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function normalizeRemoteItem(row){
    const url=row?.video_url||row?.video_uri||row?.src||row?.url||'';
    if(!/^https?:\/\//i.test(url))return null;
    if(/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(url))return null;
    return {
      url,
      jobId: row?.job_id||row?.jobId||row?.id||'',
      prompt: row?.prompt||row?.title||'生成動画',
      createdAt: row?.created_at||row?.createdAt||''
    };
  }
  function renderApiHistoryList(items){
    const history=document.getElementById('history');
    if(!history)return;
    if(!items.length){
      history.innerHTML='<div class="empty">まだ動画がありません</div>';
      return;
    }
    history.innerHTML=items.map((it,idx)=>{
      const title=esc((it.prompt||'生成動画').slice(0,54));
      const url=esc(it.url);
      const job=esc(it.jobId||'');
      return '<article class="old" data-job-id="'+job+'" data-url="'+url+'">'
        +'<div class="oldTop" style="display:flex;gap:8px;align-items:flex-start;justify-content:space-between">'
        +'<span>'+title+'</span>'
        +'<button type="button" class="fv-delete-one" data-job-id="'+job+'" data-url="'+url+'" style="border:1px solid rgba(255,255,255,.12);background:#2b303a;color:#fff;border-radius:10px;padding:7px 10px;font-weight:800;white-space:nowrap">削除</button>'
        +'</div>'
        +'<video controls playsinline preload="metadata" src="'+url+'"></video>'
        +'<div class="icons"><a class="icon" href="'+url+'" target="_blank" rel="noreferrer">↗</a><a class="icon" href="'+url+'" download>↓</a></div>'
        +'</article>';
    }).join('');
  }
  async function loadApiHistory(){
    const history=document.getElementById('history');
    if(!history)return;
    history.innerHTML='<div class="empty">履歴を読み込み中...</div>';
    try{
      const res=await originalFetch('/api/generated-videos?limit=50&t='+Date.now(),{cache:'no-store'});
      const data=await res.json();
      const rows=(data?.rows||[]).map(normalizeRemoteItem).filter(Boolean);
      renderApiHistoryList(rows);
    }catch(e){
      history.innerHTML='<div class="empty">履歴を読み込めませんでした</div>';
    }
  }
  async function deleteOneHistory(jobId,url){
    if(!jobId){
      alert('削除対象のjobIdがありません');
      return;
    }
    const ok=confirm('この動画を履歴から削除しますか？\n\n動画ファイル本体は削除せず、履歴だけ削除します。');
    if(!ok)return;
    try{
      const res=await originalFetch('/api/delete-video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId})});
      const data=await res.json();
      if(!res.ok||!data.ok)throw new Error(data?.error||'削除に失敗しました');
      localStorage.removeItem(HISTORY_KEY);
      await loadApiHistory();
    }catch(e){
      alert('削除できませんでした: '+(e?.message||e));
    }
  }
  function installApiHistoryUi(){
    const clear=document.getElementById('clear');
    if(clear){
      clear.textContent='再読込';
      clear.onclick=function(){
        localStorage.removeItem(HISTORY_KEY);
        loadApiHistory();
      };
    }
    document.addEventListener('click',function(e){
      const btn=e.target&&e.target.closest&&e.target.closest('.fv-delete-one');
      if(!btn)return;
      e.preventDefault();
      deleteOneHistory(btn.dataset.jobId||'',btn.dataset.url||'');
    });
    setTimeout(loadApiHistory,0);
    setTimeout(loadApiHistory,700);
  }

  const originalFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input&&input.url)||'';
    const requestBody=bodyJson(init||{});
    const response=await originalFetch(input,init);

    if(url.includes('/api/seedance-start')){
      response.clone().json().then(data=>{
        const jobId=extractJobId(data);
        if(!jobId)return;
        localStorage.setItem(LAST_JOB_KEY,jobId);
        localStorage.setItem('flowvidLastSeedancePrompt',requestBody.prompt||'');
        localStorage.setItem('flowvidLastSeedanceMode',currentMode());
        saveRemote({
          jobId,
          status:'processing',
          mode:currentMode(),
          prompt:requestBody.prompt||'',
          referenceUrls:requestBody.reference_urls||requestBody.referenceUrls||requestBody.first_frame_url?[].concat(requestBody.reference_urls||requestBody.referenceUrls||requestBody.first_frame_url||[]):[],
          settings:{duration:requestBody.duration,resolution:requestBody.resolution,aspect_ratio:requestBody.aspect_ratio,model:requestBody.model}
        });
      }).catch(()=>{});
    }

    if(url.includes('/api/seedance-status')){
      response.clone().json().then(data=>{
        const jobId=data?.jobId||new URL(url,location.href).searchParams.get('id')||localStorage.getItem(LAST_JOB_KEY)||'';
        const videoUrl=data?.done===true&&data?.videoUrl?data.videoUrl:'';
        if(!jobId)return;
        if(videoUrl){
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

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',installApiHistoryUi);
  }else{
    installApiHistoryUi();
  }
})();
