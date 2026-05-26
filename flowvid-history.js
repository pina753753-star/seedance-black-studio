(function(){
  const HISTORY_KEY='flowvidHistory';
  const DRAFT_KEY='flowvidGenerateDraft';
  const DEVICE_KEY='flowvidDeviceId';
  const FAVORITES_KEY='flowvidFavoriteJobs';
  const LAST_JOB_KEY='flowvidLastSeedanceJobId';
  const originalFetch=window.fetch.bind(window);

  function $(id){return document.getElementById(id)}
  function safeJson(text,fallback){try{return JSON.parse(text||'')}catch(_){return fallback}}
  function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
  function deviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id='dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);localStorage.setItem(DEVICE_KEY,id)}return id}
  function currentMode(){return localStorage.getItem('flowvidGenerateMode')||document.querySelector('[data-mode].on')?.dataset?.mode||'reference_to_video'}
  function modeLabel(v){v=String(v||'');return v==='image_to_video'?'画像から動画':v==='text_to_video'?'テキストから動画':v==='reference_to_video'?'リファレンス':'Seedance'}
  function readDraft(){return safeJson(localStorage.getItem(DRAFT_KEY),'{}')||{}}
  function getRefs(){
    const d=readDraft();
    const fromDraft=Array.isArray(d.referenceUrls)?d.referenceUrls.filter(Boolean):[];
    const fromDom=Array.from(document.querySelectorAll('#assets .thumb img')).map(img=>img.currentSrc||img.src||'').filter(url=>/^https?:\/\//i.test(url));
    return Array.from(new Set([...fromDraft,...fromDom])).filter(Boolean);
  }
  function toInputReferences(refs){return refs.map(url=>({type:'image_url',image_url:{url}}));}
  function extractJobId(d){if(!d||typeof d!=='object')return'';for(const k of ['jobId','job_id','id','request_id']){const v=d[k];if(typeof v==='string'&&v.trim())return v.trim()}for(const k of Object.keys(d)){const r=extractJobId(d[k]);if(r)return r}return''}
  function extractPollingUrl(d){if(!d||typeof d!=='object')return'';for(const k of ['pollingUrl','polling_url','statusUrl','status_url']){const v=d[k];if(typeof v==='string'&&/^https?:\/\//.test(v))return v}for(const k of Object.keys(d)){const r=extractPollingUrl(d[k]);if(r)return r}return''}
  function findVideoUrl(value){
    if(!value)return'';
    if(typeof value==='string'){
      if(/^https?:\/\//i.test(value)&&/\.(mp4|mov|webm)(\?|$)/i.test(value))return value;
      if(/^https?:\/\//i.test(value)&&/(download|output|storage|cdn|signed)/i.test(value)&&!/openrouter\.ai\/api\//i.test(value))return value;
      return'';
    }
    if(Array.isArray(value)){for(const item of value){const f=findVideoUrl(item);if(f)return f}return''}
    if(typeof value==='object'){
      for(const key of ['videoUrl','video_url','output_url','download_url','signed_url','url','uri','file_url','asset_url','play_url']){const f=findVideoUrl(value[key]);if(f)return f}
      for(const key of Object.keys(value)){const f=findVideoUrl(value[key]);if(f)return f}
    }
    return'';
  }
  function doneStatus(d){return d?.done===true||String(d?.jobStatus||d?.status||d?.response?.status||d?.response?.data?.status||'').toLowerCase()==='completed'}
  function failedStatus(d){const s=String(d?.jobStatus||d?.status||d?.response?.status||d?.response?.data?.status||'').toLowerCase();return ['failed','error','cancelled','canceled'].includes(s)||Number(d?.status)>=400}
  function normalize(row){const url=row?.video_url||row?.video_uri||row?.src||row?.url||'';if(!/^https?:\/\//i.test(url))return null;if(/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(url))return null;return{url,jobId:row?.job_id||row?.jobId||row?.id||'',prompt:row?.prompt||row?.title||'生成動画',mode:row?.mode||'',duration:row?.duration_seconds||row?.duration||5,aspect:row?.aspect_ratio||row?.aspectRatio||'9:16',createdAt:row?.created_at||row?.createdAt||''}}
  function localSave(item){if(!item?.url)return;const list=safeJson(localStorage.getItem(HISTORY_KEY),'[]')||[];if(!list.some(v=>v.url===item.url))list.unshift(item);localStorage.setItem(HISTORY_KEY,JSON.stringify(list.slice(0,20)))}
  async function remoteSave(payload){try{await originalFetch('/api/video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:deviceId(),...payload})})}catch(_){}}
  function favs(){const list=safeJson(localStorage.getItem(FAVORITES_KEY),'[]');return Array.isArray(list)?list:[]}
  function isFav(id){return favs().includes(String(id||''))}
  function toggleFav(id){if(!id)return;const s=String(id);const next=isFav(s)?favs().filter(v=>v!==s):[s,...favs()];localStorage.setItem(FAVORITES_KEY,JSON.stringify(next.slice(0,100)));loadHistory()}
  function shortDate(value){const d=value?new Date(value):null;if(!d||Number.isNaN(d.getTime()))return'';const m=Math.floor((Date.now()-d.getTime())/60000);if(m<1)return'今';if(m<60)return m+'分前';const h=Math.floor(m/60);if(h<24)return h+'時間前';return Math.floor(h/24)+'日前'}
  function style(){
    const old=$('fv-history-style');if(old)old.remove();
    const s=document.createElement('style');s.id='fv-history-style';
    s.textContent='#history{display:grid;gap:14px}#history .old{padding:10px;border-radius:22px;display:grid;gap:9px;background:#1b1e25;border:1px solid rgba(255,255,255,.08)}#history .fv-title-row{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}#history .fv-prompt-wrap{position:relative;min-width:0}#history .fv-prompt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#c8c8d2;font-weight:800;line-height:1.32;font-size:15px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:manipulation;cursor:pointer}#history .fv-prompt-pop{display:none;position:absolute;left:8px;right:8px;top:48px;z-index:20;background:#333947;color:#fff;border-radius:13px;padding:13px 14px;font-size:15px;line-height:1.55;font-weight:750;box-shadow:0 10px 30px rgba(0,0,0,.45);white-space:pre-wrap}#history .fv-prompt-pop:before{content:"";position:absolute;top:-10px;left:50%;margin-left:-10px;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:10px solid #333947}#history .fv-prompt-pop.show{display:block}#history .fv-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;color:#8d94a3;font-size:11px;font-weight:800}#history .fv-chip{border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:3px 7px;background:rgba(255,255,255,.04)}#history .fv-video-frame{width:100%;height:168px!important;max-height:168px!important;background:#050506;border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer}#history .fv-video-frame video{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;object-fit:contain!important;background:#000;border-radius:0;display:block;pointer-events:none}#history .fv-card-actions{display:flex;gap:8px;align-items:center;justify-content:space-between}#history .fv-left-actions{display:flex;gap:8px}#history .fv-action{min-width:52px;height:36px;border:0;border-radius:11px;background:#2b303a;color:#fff;text-decoration:none;display:grid;place-items:center;font-size:14px;font-weight:900;padding:0 11px}#history .fv-action.fav{width:44px;height:44px;min-width:44px;padding:0;font-size:20px}#history .fv-action.fav.on{background:rgba(251,191,36,.18);color:#fde68a}#history .fv-delete-one{background:transparent;color:#fecdd3;border:1px solid rgba(251,113,133,.35);min-width:58px}#history .fv-save[disabled]{opacity:.55}@media(max-width:520px){#history .fv-video-frame{height:168px!important;max-height:168px!important}#history .old{padding:10px}#history .fv-prompt-pop{left:0;right:0;top:50px}}';
    document.head.appendChild(s)
  }
  function prepareVideos(){document.querySelectorAll('#history video').forEach(v=>{v.pause();v.removeAttribute('autoplay');v.loop=false;v.muted=true;v.playsInline=true;v.setAttribute('muted','');v.setAttribute('playsinline','');v.addEventListener('loadedmetadata',()=>{try{v.currentTime=Math.min(0.2,Math.max(0.01,(v.duration||1)*0.04))}catch(_){}} ,{once:true});v.addEventListener('seeked',()=>{v.pause()}, {once:true});v.load()})}
  function renderHistory(items){const h=$('history');if(!h)return;style();if(!items.length){h.innerHTML='<div class="empty">まだ動画がありません</div>';return}h.innerHTML=items.map(it=>{const job=esc(it.jobId||'');const url=esc(it.url);const promptRaw=it.prompt||'生成動画';const prompt=esc(promptRaw);const meta=[modeLabel(it.mode),it.aspect,(it.duration||5)+'秒',shortDate(it.createdAt)].filter(Boolean).map(v=>'<span class="fv-chip">'+esc(v)+'</span>').join('');return '<article class="old" data-job-id="'+job+'"><div class="fv-title-row"><div class="fv-prompt-wrap"><div class="fv-prompt" data-full-prompt="'+prompt+'">'+esc(promptRaw.slice(0,72))+'</div><div class="fv-prompt-pop">'+prompt+'</div><div class="fv-meta">'+meta+'</div></div><button type="button" class="fv-action fav '+(isFav(job)?'on':'')+'" data-job-id="'+job+'">'+(isFav(job)?'★':'☆')+'</button></div><div class="fv-video-frame" data-open-url="'+url+'"><video muted playsinline preload="auto" src="'+url+'#t=0.2"></video></div><div class="fv-card-actions"><div class="fv-left-actions"><a class="fv-action" href="'+url+'" target="_blank" rel="noreferrer">開く</a><button type="button" class="fv-action fv-save" data-url="'+url+'" data-job-id="'+job+'">保存</button></div><button type="button" class="fv-action fv-delete-one" data-job-id="'+job+'">削除</button></div></article>'}).join('');prepareVideos()}
  async function loadHistory(){const h=$('history');if(!h)return;style();h.innerHTML='<div class="empty">履歴を読み込み中...</div>';try{const res=await originalFetch('/api/generated-videos?limit=50&t='+Date.now(),{cache:'no-store'});const data=await res.json();renderHistory((data?.rows||[]).map(normalize).filter(Boolean))}catch(_){const list=safeJson(localStorage.getItem(HISTORY_KEY),'[]')||[];renderHistory(list.map(normalize).filter(Boolean))}}
  async function deleteHistory(jobId){if(!jobId)return alert('削除対象がありません');if(!confirm('この動画を履歴から削除しますか？\n動画ファイル本体は削除しません。'))return;try{const res=await originalFetch('/api/video-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',jobId})});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data?.error||'削除失敗');loadHistory()}catch(e){alert('削除できませんでした: '+(e?.message||e))}}
  async function saveVideo(url, jobId, button){
    if(!url)return;
    const originalText=button?.textContent||'保存';
    if(button){button.disabled=true;button.textContent='保存中'}
    try{
      const res=await originalFetch(url,{cache:'no-store'});
      if(!res.ok)throw new Error('動画取得失敗: '+res.status);
      const blob=await res.blob();
      if(!blob.size)throw new Error('動画データが空です');
      const blobUrl=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=blobUrl;
      a.download='flowvid-'+(jobId||Date.now())+'.mp4';
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{URL.revokeObjectURL(blobUrl);a.remove()},1500);
      if(button)button.textContent='保存済';
      setTimeout(()=>{if(button){button.textContent=originalText;button.disabled=false}},1600);
    }catch(e){
      if(button){button.textContent=originalText;button.disabled=false}
      alert('保存できませんでした。開くボタンで動画を開いて、共有メニューから保存してください。');
    }
  }

  function credits(){const mode=currentMode();const duration=Number($('duration')?.value||5);const resolution=$('resolution')?.value||'720p';const refs=mode==='text_to_video'?0:Math.max(1,getRefs().length||1);let c=80;c+=Math.max(0,duration-5)*15;if(resolution==='1080p')c+=100;if(resolution==='480p')c-=20;if(mode==='reference_to_video')c+=Math.max(0,refs-1)*10;if(mode==='text_to_video')c-=10;if($('audio')?.value==='true')c+=15;return Math.max(50,c)}
  function updateCreate(){const b=$('create');if(b)b.textContent='作成する ✦ '+credits()}
  function startTimeout(ms){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);return {signal:c.signal,clear:()=>clearTimeout(t)}}
  async function parseJsonResponse(res){const text=await res.text();try{return text?JSON.parse(text):{}}catch(_){return{ok:false,error:text.slice(0,200)||'Invalid response'}}}
  function showError(msg){const now=$('now'),job=$('job'),create=$('create');if(job)job.textContent='送信失敗: '+String(msg||'unknown').slice(0,90);if(create)create.disabled=false;if(now)now.classList.add('show')}
  async function robustStart(){
    const prompt=($('prompt')?.value||'').trim();
    const mode=currentMode();
    const refs=getRefs();
    updateCreate();
    if(!prompt){alert('プロンプトを入力してください');return}
    if(mode!=='text_to_video'&&!refs.length){alert('画像をアップロードしてください');return}
    const create=$('create'),now=$('now'),done=$('done'),job=$('job');
    if(create)create.disabled=true;
    if(done)done.classList.remove('show');
    if(now)now.classList.add('show');
    if(job)job.textContent='送信中...';
    const body={model:$('model')?.value||'bytedance/seedance-2.0',prompt,duration:$('duration')?.value||'5',resolution:$('resolution')?.value||'720p',aspect_ratio:$('aspect')?.value||'9:16',generate_audio:$('audio')?.value==='true',estimated_credits:credits()};
    if(mode==='image_to_video')body.first_frame_url=refs[0];
    if(mode==='reference_to_video'){
      body.reference_url=refs[0];
      body.reference_urls=refs;
      body.input_references=toInputReferences(refs);
    }
    const timeout=startTimeout(25000);
    try{
      const res=await originalFetch('/api/seedance-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:timeout.signal});
      const data=await parseJsonResponse(res);
      const jobId=data.jobId||extractJobId(data.response)||extractJobId(data);
      const pollingUrl=data.pollingUrl||extractPollingUrl(data.response)||extractPollingUrl(data);
      if(!res.ok||!data.ok||(!jobId&&!pollingUrl)){
        showError(data.error||data.response?.error||data.message||('status '+res.status));
        return;
      }
      if(jobId)localStorage.setItem(LAST_JOB_KEY,jobId);
      localStorage.setItem('flowvidLastSeedancePrompt',prompt);
      localStorage.setItem('flowvidLastSeedanceMode',mode);
      if(job)job.textContent=pollingUrl||jobId;
      remoteSave({jobId,status:'processing',mode,prompt,referenceUrls:refs,settings:body});
      pollStatus(jobId,pollingUrl,prompt,mode);
    }catch(e){showError(e?.name==='AbortError'?'開始APIが25秒でタイムアウトしました。OpenRouterログに増えていなければ課金なしです。':(e?.message||e))}
    finally{timeout.clear()}
  }
  function pollStatus(jobId,pollingUrl,prompt,mode){
    let count=0;
    const timer=setInterval(async()=>{
      count++;
      try{
        const p=new URLSearchParams();if(pollingUrl)p.set('pollingUrl',pollingUrl);else p.set('id',jobId);
        const res=await originalFetch('/api/seedance-status?'+p.toString(),{cache:'no-store'});
        const data=await parseJsonResponse(res);
        const videoUrl=data.videoUrl||findVideoUrl(data);
        if(videoUrl&&doneStatus(data)){
          clearInterval(timer);
          if($('create'))$('create').disabled=false;
          if($('now'))$('now').classList.remove('show');
          if($('done'))$('done').classList.add('show');
          if($('video'))$('video').src=videoUrl;
          if($('open'))$('open').href=videoUrl;
          if($('download'))$('download').href=videoUrl;
          localSave({url:videoUrl,prompt,mode,jobId,createdAt:new Date().toISOString()});
          remoteSave({jobId,status:'completed',mode,prompt,videoUrl});
          loadHistory();
        }else if(failedStatus(data)||count>60){
          clearInterval(timer);if($('create'))$('create').disabled=false;if($('job'))$('job').textContent='取得停止: '+(data.error||data.jobStatus||data.status||'timeout');
        }
      }catch(e){if(count>5){clearInterval(timer);if($('create'))$('create').disabled=false;if($('job'))$('job').textContent='確認失敗: '+(e?.message||e)}}
    },12000);
  }
  function closePromptPops(){document.querySelectorAll('#history .fv-prompt-pop.show').forEach(p=>p.classList.remove('show'))}
  function togglePromptPop(promptEl){const pop=promptEl?.parentElement?.querySelector?.('.fv-prompt-pop');if(!pop)return;const shown=pop.classList.contains('show');closePromptPops();if(!shown)pop.classList.add('show')}
  function install(){
    style();loadHistory();
    const clear=$('clear');if(clear){clear.textContent='再読込';clear.onclick=()=>loadHistory()}
    document.addEventListener('click',e=>{const save=e.target?.closest?.('.fv-save');if(save){e.preventDefault();e.stopPropagation();saveVideo(save.dataset.url||'',save.dataset.jobId||'',save);return}const del=e.target?.closest?.('.fv-delete-one');if(del){e.preventDefault();deleteHistory(del.dataset.jobId||'');return}const fav=e.target?.closest?.('.fv-action.fav');if(fav){e.preventDefault();toggleFav(fav.dataset.jobId||'');return}const prompt=e.target?.closest?.('.fv-prompt');if(prompt){e.preventDefault();e.stopPropagation();togglePromptPop(prompt);return}const pop=e.target?.closest?.('.fv-prompt-pop');if(pop)return;closePromptPops();const frame=e.target?.closest?.('.fv-video-frame');if(frame?.dataset?.openUrl){window.open(frame.dataset.openUrl,'_blank','noopener')}});
    setTimeout(()=>{const create=$('create');if(create)create.onclick=robustStart;updateCreate()},800);
    ['duration','resolution','audio','model','aspect'].forEach(id=>$(id)?.addEventListener('change',()=>setTimeout(updateCreate,0)));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
