(function(){
  const HISTORY_KEY='flowvidHistory';
  const DRAFT_KEY='flowvidGenerateDraft';
  const DEVICE_KEY='flowvidDeviceId';
  const FAVORITES_KEY='flowvidFavoriteJobs';
  const LAST_JOB_KEY='flowvidLastSeedanceJobId';
  const HIDDEN_KEY='flowvidHiddenVideos';
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
  function toggleFav(id){if(!id)return;const s=String(id);const next=isFav(s)?favs().filter(v=>v!==s):[s,...favs()];localStorage.setItem(FAVORITES_KEY,JSON.stringify(next.slice(0,100)));loadHistory(_lastFilterMode)}
  function hiddenSet(){const s=safeJson(localStorage.getItem(HIDDEN_KEY),'[]');return new Set(Array.isArray(s)?s:[])}
  function hideVideo(url,jobId){const s=hiddenSet();if(url)s.add(url);if(jobId)s.add(jobId);localStorage.setItem(HIDDEN_KEY,JSON.stringify([...s].slice(0,200)))}
  function shortDate(value){const d=value?new Date(value):null;if(!d||Number.isNaN(d.getTime()))return'';const m=Math.floor((Date.now()-d.getTime())/60000);if(m<1)return'今';if(m<60)return m+'分前';const h=Math.floor(m/60);if(h<24)return h+'時間前';return Math.floor(h/24)+'日前'}
  function style(){
    const old=$('fv-history-style');if(old)old.remove();
    const s=document.createElement('style');s.id='fv-history-style';
    s.textContent='#fv-prompt-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.75);display:none;align-items:flex-end;padding-bottom:env(safe-area-inset-bottom,0)}#fv-prompt-modal.show{display:flex}#fv-prompt-modal-inner{background:#14171f;border-radius:24px 24px 0 0;width:100%;max-height:72vh;overflow-y:auto;padding:24px 20px 32px}#fv-prompt-modal-label{color:#6b7280;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:0 0 10px}#fv-prompt-modal-text{color:#e8eaf0;font-size:15px;line-height:1.4;white-space:pre-wrap;word-break:break-word;margin:0 0 16px;padding:10px 13px;background:rgba(255,255,255,.05);border-radius:14px;border:1px solid rgba(255,255,255,.09)}#fv-prompt-modal-btns{display:flex;gap:10px}#fv-prompt-modal-copy,#fv-prompt-modal-close{flex:1;height:48px;border:0;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}#fv-prompt-modal-copy{background:linear-gradient(90deg,#eee8ff,#8ed8ff);color:#050506}#fv-prompt-modal-close{background:#252a35;color:#c0c4d0}#history{display:grid;gap:14px}#history .old{padding:12px;border-radius:20px;display:grid;gap:10px;background:#13161e;border:1px solid rgba(255,255,255,.09)}#history .fv-prompt-wrap{min-width:0}#history .fv-prompt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#c8cad6;font-weight:700;line-height:1.4;font-size:14px;cursor:pointer;-webkit-user-select:none;user-select:none}#history .fv-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;color:#6b7280;font-size:11px;font-weight:700}#history .fv-chip{border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:2px 7px;background:rgba(255,255,255,.04)}#history .fv-chip-mode{background:rgba(139,92,246,.18);border-color:rgba(139,92,246,.4);color:#c4b5fd}#history .fv-video-frame{width:100%;height:168px!important;max-height:168px!important;background:#050506;border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer}#history .fv-video-frame video{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;object-fit:contain!important;background:#000;border-radius:0;display:block;pointer-events:none}#history .fv-actions-row{display:flex;gap:7px}#history .fv-action{flex:1;height:36px;min-width:0;border:0;border-radius:10px;background:#1e2230;color:#b8bcc8;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:12px;font-weight:700;padding:0 10px;cursor:pointer;white-space:nowrap}#history .fv-action svg{flex-shrink:0;opacity:.8}#history .fv-fav-btn.on{background:rgba(251,191,36,.14);color:#fde68a;border:1px solid rgba(251,191,36,.22)}#history .fv-delete-one{background:transparent;color:#fca5a5;border:1px solid rgba(251,113,133,.3)}#history .fv-save[disabled]{opacity:.5}@media(max-width:520px){#history .fv-video-frame{height:168px!important}#history .old{padding:10px}#history .fv-actions-row{gap:5px}#history .fv-action{font-size:11px;padding:0 8px;gap:4px}}';
    document.head.appendChild(s)
  }
  function prepareVideos(){document.querySelectorAll('#history video').forEach(v=>{v.pause();v.removeAttribute('autoplay');v.loop=false;v.muted=true;v.playsInline=true;v.setAttribute('muted','');v.setAttribute('playsinline','');v.addEventListener('loadedmetadata',()=>{try{v.currentTime=Math.min(0.2,Math.max(0.01,(v.duration||1)*0.04))}catch(_){}} ,{once:true});v.addEventListener('seeked',()=>{v.pause()}, {once:true});v.load()})}
  const icOpen='<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 12 12"><path d="M2 10L10 2M5.5 2H10v4.5"/></svg>';
  const icDl='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 14 14"><path d="M7 1.5v8M3.5 6.5L7 10l3.5-3.5M1.5 12.5h11"/></svg>';
  const icCopy='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" viewBox="0 0 14 14"><rect x="4.5" y="4.5" width="8.5" height="8.5" rx="1.5"/><path d="M9.5 4.5v-1a1 1 0 00-1-1H2a1 1 0 00-1 1v7.5a1 1 0 001 1h1.5"/></svg>';
  const icX='<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2L2 10"/></svg>';
  const icStarOff='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" viewBox="0 0 14 14"><path d="M7 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.5l-3.2 1.9.6-3.6-2.6-2.5 3.6-.5z"/></svg>';
  const icStarOn='<svg width="13" height="13" fill="#fde68a" stroke="#fde68a" stroke-width="1" viewBox="0 0 14 14"><path d="M7 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.5l-3.2 1.9.6-3.6-2.6-2.5 3.6-.5z"/></svg>';
  function renderHistory(items){const h=$('history');if(!h)return;style();if(!items.length){h.innerHTML='<div class="empty">まだ動画がありません</div>';return}h.innerHTML=items.map(it=>{const job=esc(it.jobId||'');const url=esc(it.url);const promptRaw=it.prompt||'生成動画';const prompt=esc(promptRaw);const modeTag=it.mode?'<span class="fv-chip fv-chip-mode">'+esc(modeLabel(it.mode))+'</span>':'';const meta=modeTag+[it.aspect,(it.duration||5)+'秒',shortDate(it.createdAt)].filter(Boolean).map(v=>'<span class="fv-chip">'+esc(v)+'</span>').join('');const favOn=isFav(job);return '<article class="old" data-job-id="'+job+'"><div class="fv-prompt-wrap"><div class="fv-prompt" data-full-prompt="'+prompt+'">'+esc(promptRaw.slice(0,72))+'</div><div class="fv-meta">'+meta+'</div></div><div class="fv-video-frame" data-open-url="'+url+'"><video muted playsinline preload="auto" src="'+url+'#t=0.2"></video></div><div class="fv-actions-row"><a class="fv-action fv-open" href="'+url+'" target="_blank" rel="noreferrer">'+icOpen+' 開く</a><button type="button" class="fv-action fv-save" data-url="'+url+'" data-job-id="'+job+'">'+icDl+' 保存</button><button type="button" class="fv-action fv-copy" data-prompt="'+prompt+'">'+icCopy+' コピー</button></div><div class="fv-actions-row"><button type="button" class="fv-action fv-fav-btn'+(favOn?' on':'')+'" data-job-id="'+job+'">'+(favOn?icStarOn+' お気に入り済み':icStarOff+' お気に入り')+'</button><button type="button" class="fv-action fv-delete-one" data-job-id="'+job+'" data-url="'+url+'">'+icX+' 削除</button></div></article>'}).join('');prepareVideos()}
  let _lastFilterMode;
  async function loadHistory(filterMode){const h=$('history');if(!h)return;_lastFilterMode=filterMode;style();h.innerHTML='<div class="empty">履歴を読み込み中...</div>';try{const res=await originalFetch('/api/generated-videos?limit=50&t='+Date.now(),{cache:'no-store'});const data=await res.json();const hidden=hiddenSet();let items=(data?.rows||[]).map(normalize).filter(it=>it&&!hidden.has(it.url)&&!hidden.has(it.jobId));if(filterMode)items=items.filter(it=>!it.mode||it.mode===filterMode);renderHistory(items)}catch(_){const list=safeJson(localStorage.getItem(HISTORY_KEY),'[]')||[];const hidden2=hiddenSet();let items=list.map(normalize).filter(it=>it&&!hidden2.has(it.url)&&!hidden2.has(it.jobId));if(filterMode)items=items.filter(it=>!it.mode||it.mode===filterMode);renderHistory(items)}}
  window.flowvidLoadHistory=loadHistory;
  function deleteHistory(jobId,url){if(!jobId&&!url)return;if(!confirm('この動画を履歴から削除しますか？\n動画ファイル本体は削除しません。'))return;hideVideo(url||'',jobId||'');loadHistory(_lastFilterMode)}
  async function saveVideo(url, jobId, button){
    if(!url)return;
    const originalText=button?.innerHTML||'保存';
    if(button){button.disabled=true;button.innerHTML='保存中'}
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
      if(button)button.innerHTML='保存済';
      setTimeout(()=>{if(button){button.innerHTML=originalText;button.disabled=false}},1600);
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
          loadHistory(_lastFilterMode);
        }else if(failedStatus(data)||count>60){
          clearInterval(timer);if($('create'))$('create').disabled=false;if($('job'))$('job').textContent='取得停止: '+(data.error||data.jobStatus||data.status||'timeout');
        }
      }catch(e){if(count>5){clearInterval(timer);if($('create'))$('create').disabled=false;if($('job'))$('job').textContent='確認失敗: '+(e?.message||e)}}
    },12000);
  }
  function ensurePromptModal(){let m=document.getElementById('fv-prompt-modal');if(m)return m;m=document.createElement('div');m.id='fv-prompt-modal';m.innerHTML='<div id="fv-prompt-modal-inner"><p id="fv-prompt-modal-label">プロンプト</p><div id="fv-prompt-modal-text"></div><div id="fv-prompt-modal-btns"><button type="button" id="fv-prompt-modal-copy">コピー</button><button type="button" id="fv-prompt-modal-close">閉じる</button></div></div>';document.body.appendChild(m);m.addEventListener('click',e=>{if(e.target===m)closePromptModal()});document.getElementById('fv-prompt-modal-close').addEventListener('click',closePromptModal);document.getElementById('fv-prompt-modal-copy').addEventListener('click',()=>{const text=document.getElementById('fv-prompt-modal-text').textContent||'';navigator.clipboard?.writeText(text).then(()=>{const btn=document.getElementById('fv-prompt-modal-copy');const t=btn.textContent;btn.textContent='コピー済';setTimeout(()=>{btn.textContent=t},1500)})});return m}
  function openPromptModal(text){if(!text)return;ensurePromptModal();const display=text.replace(/\n+/g,' ').replace(/\s{2,}/g,' ').trim();document.getElementById('fv-prompt-modal-text').textContent=display;document.getElementById('fv-prompt-modal').classList.add('show')}
  function closePromptModal(){document.getElementById('fv-prompt-modal')?.classList.remove('show')}
  function install(){
    style();loadHistory();
    const clear=$('clear');if(clear){clear.textContent='再読込';clear.onclick=()=>loadHistory()}
    document.addEventListener('click',e=>{const save=e.target?.closest?.('.fv-save');if(save){e.preventDefault();e.stopPropagation();saveVideo(save.dataset.url||'',save.dataset.jobId||'',save);return}const del=e.target?.closest?.('.fv-delete-one');if(del){e.preventDefault();e.stopPropagation();deleteHistory(del.dataset.jobId||'',del.dataset.url||'');return}const copy=e.target?.closest?.('.fv-copy');if(copy){e.preventDefault();e.stopPropagation();const p=copy.dataset.prompt||'';if(p)navigator.clipboard?.writeText(p).then(()=>{const t=copy.innerHTML;copy.innerHTML='コピー済';setTimeout(()=>{copy.innerHTML=t},1500)});return}const fav=e.target?.closest?.('.fv-fav-btn');if(fav){e.preventDefault();e.stopPropagation();toggleFav(fav.dataset.jobId||'');return}const promptEl=e.target?.closest?.('.fv-prompt');if(promptEl){e.preventDefault();e.stopPropagation();openPromptModal(promptEl.dataset.fullPrompt||promptEl.textContent||'');return}const frame=e.target?.closest?.('.fv-video-frame');if(frame?.dataset?.openUrl){window.open(frame.dataset.openUrl,'_blank','noopener')}});
    setTimeout(()=>{const create=$('create');if(create)create.onclick=window.flowvidCreateHandler||robustStart;updateCreate()},800);
    ['duration','resolution','audio','model','aspect'].forEach(id=>$(id)?.addEventListener('change',()=>setTimeout(updateCreate,0)));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
