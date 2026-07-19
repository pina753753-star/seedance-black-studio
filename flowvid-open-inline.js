(function(){
  const STANDARD_MODEL='bytedance/seedance-2.0';
  const FAST_MODEL='bytedance/seedance-2.0-fast';
  const PRICING_SAFETY_MULTIPLIER=1.15;
  const DEFAULTS_APPLIED_KEY='flowvidPricingDefaultsV2';
  const DRAFT_KEY='flowvidGenerateDraft';

  function roundUpToFive(value){
    return Math.ceil(Math.max(50,Math.min(400,value))/5)*5;
  }

  function calculateCredits(){
    const duration=Number(document.getElementById('duration')?.value||5);
    const resolution=document.getElementById('resolution')?.value||'720p';
    const model=document.getElementById('model')?.value||FAST_MODEL;
    const mode=document.querySelector('[data-mode].on')?.dataset?.mode||localStorage.getItem('flowvidGenerateMode')||'reference_to_video';
    const refs=Math.max(1,document.querySelectorAll('#assets .thumb').length||1);
    if(mode==='storyboard')return roundUpToFive(Math.max(50,duration*12));
    let credits=80;
    credits+=Math.max(0,duration-5)*15;
    if(resolution==='1080p')credits+=100;
    if(resolution==='480p')credits-=20;
    if(mode==='text_to_video')credits-=10;
    credits+=15;
    const multiplier=(model===FAST_MODEL||model==='bytedance/seedance-2.0-lite')?0.8:1;
    const modeMultiplier=mode==='reference_to_video'?PRICING_SAFETY_MULTIPLIER:1;
    return roundUpToFive(credits*multiplier*modeMultiplier);
  }

  function syncCreditButton(){
    const button=document.getElementById('create');
    if(!button)return;
    const expected='作成する ✦ '+calculateCredits();
    if(button.textContent!==expected)button.textContent=expected;
  }

  function clearStoredReferences(){
    try{
      const draft=JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}');
      delete draft.referenceUrls;
      localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));
    }catch(_){
      localStorage.removeItem(DRAFT_KEY);
    }
  }

  function clearUploadedImages(){
    const file=document.getElementById('file');
    if(file)file.value='';

    let guard=0;
    while(document.querySelector('#assets .thumb')&&guard<12){
      if(typeof window.removeAsset==='function')window.removeAsset(0);
      else document.querySelector('#assets .thumb')?.remove();
      guard++;
    }

    clearStoredReferences();
    document.querySelectorAll('#assets .thumb').forEach(el=>el.remove());
  }
  window.flowvidClearUploadedImages=clearUploadedImages;

  function installModeImageReset(){
    if(window.__flowvidModeImageResetInstalled)return;
    window.__flowvidModeImageResetInstalled=true;
    document.querySelectorAll('.tabs button[data-mode]').forEach(button=>{
      button.addEventListener('click',()=>{
        const current=document.querySelector('.tabs button.on')?.dataset?.mode||localStorage.getItem('flowvidGenerateMode')||'';
        const next=button.dataset.mode||'';
        if((current==='reference_to_video'&&next==='image_to_video')||(current==='image_to_video'&&next==='reference_to_video'))clearUploadedImages();
      },true);
    });
  }

  function moderationUiMessage(data){
    const code=String(data?.error||'');
    const category=String(data?.errorCategory||'');
    if(code==='content_policy_violation'){
      return 'アップロードした画像またはプロンプトの内容が、生成AIのコンテンツポリシーに抵触したため生成できませんでした。内容を変更して再度お試しください。クレジットは消費されていません。';
    }
    if(code==='content_safety_check_unavailable'||code==='moderation_unavailable'||category==='moderation_unavailable'){
      return '現在コンテンツの安全確認を行えないため、生成を開始できません。しばらくしてからもう一度お試しください。クレジットは消費されていません。';
    }
    return '';
  }

  function installModerationErrorDisplay(){
    if(window.__flowvidModerationErrorDisplayInstalled||typeof window._ptFail!=='function')return;
    window.__flowvidModerationErrorDisplayInstalled=true;
    const originalFail=window._ptFail;
    window._ptFail=function(taskId,errMsg,refunded){
      const message=window.__flowvidPendingModerationMessage||'';
      window.__flowvidPendingModerationMessage='';
      if(!message)return originalFail(taskId,errMsg,refunded);
      originalFail(taskId,message,false);
      const card=document.querySelector('[data-ptask-id="'+CSS.escape(String(taskId||''))+'"]');
      const frame=card?.querySelector('[data-ptask-frame]');
      if(!frame)return;
      frame.querySelectorAll('p').forEach(p=>{
        if((p.textContent||'').includes('返金状況を確認できませんでした'))p.remove();
      });
      frame.querySelector('[data-pt-copy-id]')?.remove();
    };
  }

  function installGenerationImageReset(){
    if(window.__flowvidGenerationImageResetInstalled)return;
    window.__flowvidGenerationImageResetInstalled=true;
    const originalFetch=window.fetch.bind(window);
    window.fetch=async function(input,init){
      let isSeedanceStart=false;
      let submittedMode=null;
      let submittedUrls=[];
      try{
        const url=typeof input==='string'?input:(input&&input.url)||'';
        if(String(url).includes('/api/seedance-start')){
          isSeedanceStart=true;
          const bodyStr=typeof init?.body==='string'?init.body:'';
          if(bodyStr){
            const body=JSON.parse(bodyStr);
            submittedMode=body.mode||null;
            if(!submittedMode){
              if(body.first_frame_url)submittedMode='image_to_video';
              else if(body.reference_url||body.reference_urls)submittedMode='reference_to_video';
            }
            if(submittedMode==='image_to_video'&&body.first_frame_url){
              submittedUrls=[body.first_frame_url];
            }else if(submittedMode==='reference_to_video'){
              const refs=Array.isArray(body.reference_urls)?body.reference_urls:(body.reference_url?[body.reference_url]:[]);
              refs.forEach(u=>{const s=typeof u==='string'?u:(u&&u.image_url&&u.image_url.url)||'';if(s)submittedUrls.push(s);});
            }
          }
        }
      }catch(_){}
      const response=await originalFetch(input,init);
      if(!isSeedanceStart)return response;
      try{
        const data=await response.clone().json().catch(()=>null);
        if(!response.ok){
          const message=moderationUiMessage(data);
          if(message)window.__flowvidPendingModerationMessage=message;
          return response;
        }
        const hasJob=Boolean(data?.jobId||data?.job_id||data?.pollingUrl||data?.polling_url||data?.response);
        if(data?.ok===false||!hasJob)return response;
        if(submittedMode!=='image_to_video'&&submittedMode!=='reference_to_video')return response;
        if(!submittedUrls.length)return response;
        setTimeout(()=>{
          const curSrcs=[...document.querySelectorAll('#assets .thumb img')].map(el=>el.src);
          const same=submittedUrls.length===curSrcs.length&&submittedUrls.every((u,i)=>curSrcs[i]===u);
          if(same)clearUploadedImages();
        },0);
      }catch(_){}
      return response;
    };
  }

  function applyPricingDefaults(select){
    if(localStorage.getItem(DEFAULTS_APPLIED_KEY))return;
    select.value=FAST_MODEL;
    const duration=document.getElementById('duration');
    const resolution=document.getElementById('resolution');
    if(duration)duration.value='5';
    if(resolution)resolution.value='720p';
    localStorage.setItem(DEFAULTS_APPLIED_KEY,'1');
  }

  function installCreditSync(){
    if(window.__flowvidCreditSyncInstalled)return;
    window.__flowvidCreditSyncInstalled=true;
    ['model','duration','resolution'].forEach(id=>{
      document.getElementById(id)?.addEventListener('change',()=>setTimeout(syncCreditButton,0));
    });
    document.querySelectorAll('[data-mode]').forEach(button=>{
      button.addEventListener('click',()=>setTimeout(syncCreditButton,0));
    });
    const create=document.getElementById('create');
    if(create){
      const observer=new MutationObserver(()=>syncCreditButton());
      observer.observe(create,{childList:true,subtree:true,characterData:true});
      window.__flowvidCreditButtonObserver=observer;
    }
    const assets=document.getElementById('assets');
    if(assets){
      const assetsObserver=new MutationObserver(()=>setTimeout(syncCreditButton,0));
      assetsObserver.observe(assets,{childList:true,subtree:true});
      window.__flowvidAssetsObserver=assetsObserver;
    }
  }

  function applyFastModelPricing(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    const select=document.getElementById('model');
    if(!select)return;

    const legacyOption=Array.from(select.options).find(item=>item.value==='bytedance/seedance-2.0-lite');
    if(legacyOption){
      legacyOption.value=FAST_MODEL;
      legacyOption.textContent='Seedance 2.0 Fast';
    }
    const fastOption=Array.from(select.options).find(item=>item.value===FAST_MODEL);
    if(fastOption)fastOption.textContent='Seedance 2.0 Fast';

    const resolution=document.getElementById('resolution');
    const option720=Array.from(resolution?.options||[]).find(item=>item.value==='720p');
    const option1080=Array.from(resolution?.options||[]).find(item=>item.value==='1080p');
    if(option720)option720.textContent='720p（おすすめ）';
    if(option1080)option1080.textContent='1080p（高画質・最終出力向け）';

    applyPricingDefaults(select);
    window.creditEstimate=calculateCredits;
    window.__flowvidFastCreditEstimate=true;
    installCreditSync();
    installModeImageReset();
    installGenerationImageReset();
    installModerationErrorDisplay();
    if(typeof window.updateCreditUi==='function')window.updateCreditUi();
    syncCreditButton();
  }

  function ensureGenerateHistory(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    if(document.getElementById('history'))return;
    const main=document.querySelector('main.wrap');
    if(!main)return;
    const section=document.createElement('section');
    section.className='section';
    section.innerHTML='<h2>過去動画</h2><button id="clear" type="button">再読込</button>';
    const historyDiv=document.createElement('div');
    historyDiv.className='history';
    historyDiv.id='history';
    historyDiv.innerHTML='<div class="empty">履歴を読み込み中...</div>';
    main.appendChild(section);
    main.appendChild(historyDiv);
    const getMode=()=>document.querySelector('[data-mode].on')?.dataset?.mode||localStorage.getItem('flowvidGenerateMode')||'';
    if(typeof window.flowvidLoadHistory==='function')window.flowvidLoadHistory(getMode());
    section.querySelector('#clear').onclick=()=>{if(typeof window.flowvidLoadHistory==='function')window.flowvidLoadHistory(getMode())};
  }

  const HIDE_MS = 3200;
  let _hideTimer = null;

  function ensureOverlay(){
    let overlay=document.getElementById('fv-inline-video-overlay');
    if(overlay)return overlay;

    const style=document.createElement('style');
    style.textContent=[
      'body.fv-video-open{overflow:hidden}',
      '.fv-inline-video-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}',
      '.fv-inline-video-overlay.show{display:block}',
      '.fv-inline-video-overlay>video{width:100vw;height:100dvh;object-fit:contain;background:#000;display:block}',
      '.fv-inline-close{',
      '  position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:14px;z-index:100000;',
      '  width:34px;height:34px;border:0;border-radius:50%;',
      '  background:rgba(60,60,60,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
      '  color:rgba(255,255,255,.9);font-size:18px;font-weight:400;line-height:1;',
      '  display:grid;place-items:center;cursor:pointer;',
      '  opacity:0;transition:opacity .2s;pointer-events:none;',
      '  -webkit-tap-highlight-color:transparent;',
      '}',
      '.fv-inline-close.on{opacity:1;pointer-events:auto}',
    ].join('');
    document.head.appendChild(style);

    overlay=document.createElement('div');
    overlay.id='fv-inline-video-overlay';
    overlay.className='fv-inline-video-overlay';
    overlay.innerHTML='<video playsinline controls></video><button class="fv-inline-close" type="button" aria-label="閉じる">×</button>';
    document.body.appendChild(overlay);

    const video=overlay.querySelector('video');
    const closeBtn=overlay.querySelector('.fv-inline-close');

    function showClose(){closeBtn.classList.add('on')}
    function hideClose(){closeBtn.classList.remove('on')}
    function scheduleHide(){
      clearTimeout(_hideTimer);
      _hideTimer=setTimeout(hideClose, HIDE_MS);
    }
    function onInteraction(){
      showClose();
      if(!video.paused)scheduleHide();
      else clearTimeout(_hideTimer);
    }

    overlay.addEventListener('touchstart', onInteraction, {passive:true});
    overlay.addEventListener('click', onInteraction);
    video.addEventListener('play', ()=>{showClose();scheduleHide()});
    video.addEventListener('pause', ()=>{showClose();clearTimeout(_hideTimer)});
    video.addEventListener('ended', ()=>{showClose();clearTimeout(_hideTimer)});
    closeBtn.addEventListener('click', e=>{e.stopPropagation();closeOverlay()});

    overlay._showClose=showClose;
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
    overlay._showClose();
  }
  function closeOverlay(){
    const overlay=document.getElementById('fv-inline-video-overlay');
    if(!overlay)return;
    clearTimeout(_hideTimer);
    const video=overlay.querySelector('video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    overlay.classList.remove('show');
    overlay.querySelector('.fv-inline-close').classList.remove('on');
    document.body.classList.remove('fv-video-open');
  }
  function findUrlFromTarget(target){
    const openLink=target.closest&&target.closest('a.fv-action');
    if(openLink&&(openLink.textContent||'').trim()==='開く')return openLink.href;
    const oldOpen=target.closest&&target.closest('a.icon');
    if(oldOpen&&oldOpen.href&&(oldOpen.textContent||'').includes('↗'))return oldOpen.href;
    const expand=target.closest&&target.closest('.fv-expand-btn');
    if(expand?.dataset?.url)return expand.dataset.url;
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
  window.fvOpenOverlay=openOverlay;

  function loadVlloEditor(){
    if(!/\/generate-prod\.html(?:$|[?#])/i.test(location.pathname+location.search))return;
    if(document.querySelector('script[data-flowvid-vllo-editor]'))return;
    const script=document.createElement('script');
    script.src='./flowvid-video-edit-vllo.js?v=31c03589';
    script.dataset.flowvidVlloEditor='1';
    document.head.appendChild(script);
  }

  function boot(){applyFastModelPricing();ensureGenerateHistory();loadVlloEditor()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  window.addEventListener('pageshow',()=>{applyFastModelPricing();loadVlloEditor()});
})();
