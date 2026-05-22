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
      if(/^https?:\/\//i.test(value)&&/(video|output|download|storage|cdn|signed)/i.test(value))return value;
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
        const videoUrl=findVideoUrl(data);
        if(!jobId)return;
        if(videoUrl){
          const prompt=localStorage.getItem('flowvidLastSeedancePrompt')||document.getElementById('prompt')?.value||'';
          const mode=localStorage.getItem('flowvidLastSeedanceMode')||currentMode();
          localSave({url:videoUrl,prompt,mode,jobId,createdAt:new Date().toISOString()});
          saveRemote({jobId,status:'completed',mode,prompt,videoUrl});
        }else{
          saveRemote({jobId,status:data?.jobStatus||data?.status||'processing',mode:currentMode(),prompt:localStorage.getItem('flowvidLastSeedancePrompt')||''});
        }
      }).catch(()=>{});
    }

    return response;
  };
})();