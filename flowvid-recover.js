(function(){
  const LAST_JOB_KEY='flowvidLastSeedanceJobId';
  const LAST_POLLING_KEY='flowvidLastSeedancePollingUrl';
  const HISTORY_KEY='flowvidHistory';

  function safeJson(text,fallback){try{return JSON.parse(text||'')}catch(_){return fallback}}
  function $(id){return document.getElementById(id)}
  function findVideoUrl(value){
    if(!value)return'';
    if(typeof value==='string'){
      if(/^https?:\/\//i.test(value)&&/\.(mp4|mov|webm)(\?|$)/i.test(value))return value;
      if(/^https?:\/\//i.test(value)&&/\/storage\/v1\/object\/public\//i.test(value))return value;
      return'';
    }
    if(Array.isArray(value)){for(const item of value){const found=findVideoUrl(item);if(found)return found}return''}
    if(typeof value==='object'){
      for(const key of ['videoUrl','video_url','video_uri','src','url','publicUrl','public_url']){const found=findVideoUrl(value[key]);if(found)return found}
      for(const key of Object.keys(value)){const found=findVideoUrl(value[key]);if(found)return found}
    }
    return'';
  }
  function saveLocal(item){
    if(!item||!item.url)return;
    const list=safeJson(localStorage.getItem(HISTORY_KEY),'[]')||[];
    if(!list.some(v=>v.url===item.url))list.unshift(item);
    localStorage.setItem(HISTORY_KEY,JSON.stringify(list.slice(0,30)));
  }
  async function check(jobId,pollingUrl){
    const p=new URLSearchParams();
    if(pollingUrl)p.set('pollingUrl',pollingUrl);else p.set('id',jobId);
    const res=await fetch('/api/seedance-status?'+p.toString(),{cache:'no-store'});
    const data=await res.json();
    const url=data.videoUrl||findVideoUrl(data);
    if(data.done&&url){
      const prompt=localStorage.getItem('flowvidLastSeedancePrompt')||'生成動画';
      const mode=localStorage.getItem('flowvidLastSeedanceMode')||'';
      saveLocal({url,prompt,mode,jobId:data.jobId||jobId,createdAt:new Date().toISOString()});
      localStorage.removeItem(LAST_JOB_KEY);
      localStorage.removeItem(LAST_POLLING_KEY);
      const now=$('now');if(now)now.classList.remove('show');
      const video=$('video');if(video)video.src=url;
      const open=$('open');if(open)open.href=url;
      const download=$('download');if(download)download.href=url;
      const done=$('done');if(done)done.classList.add('show');
      const clear=$('clear');if(clear)clear.click();
      setTimeout(()=>location.reload(),300);
      return true;
    }
    return false;
  }
  async function recover(){
    const jobId=localStorage.getItem(LAST_JOB_KEY)||'';
    const pollingUrl=localStorage.getItem(LAST_POLLING_KEY)||'';
    if(!jobId&&!pollingUrl)return;
    const now=$('now');if(now)now.classList.add('show');
    const job=$('job');if(job)job.textContent=pollingUrl||jobId;
    try{await check(jobId,pollingUrl)}catch(_){/* keep existing UI */}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',recover);else recover();
})();
