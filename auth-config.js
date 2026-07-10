window.FLOWVID_AUTH = {
  supabaseUrl: "https://jflpjsdjmlkmkqfahxwy.supabase.co",
  supabaseAnonKey: "sb_publishable_YbRKnQh1fCVO5VDJyVWfyQ_sNzHqvCE",
  redirectTo: "https://flowvid-studio.vercel.app/profile.html",
  adminRedirectTo: "https://flowvid-studio.vercel.app/admin.html",
  adminEmails: ["hinaran53@gmail.com"]
};

window.flowvidSupabaseClient = function(){
  const cfg=window.FLOWVID_AUTH||{};
  if(!window.supabase||!cfg.supabaseUrl||!cfg.supabaseAnonKey) return null;
  if(!window.__flowvidUserClient){
    window.__flowvidUserClient=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);
  }
  return window.__flowvidUserClient;
};

(function flowvidAdminAquariumLink(){
  if(!/\/admin\.html$/.test(location.pathname)) return;
  const addLink=()=>{
    const nav=document.querySelector('#drawer .nav');
    if(!nav||document.getElementById('adminAquariumLink')) return;
    const logout=document.getElementById('drawerLogoutBtn');
    const button=document.createElement('button');
    button.id='adminAquariumLink';
    button.type='button';
    button.textContent='AI運営水族館';
    button.onclick=()=>{ location.href='./admin-ops.html'; };
    nav.insertBefore(button,logout||null);
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',addLink,{once:true});
  else addLink();
})();

(function flowvidGeneratePageEnhancements(){
  const GENERATION_CREDIT_COST=80;
  const ACTIVE_TASK_WINDOW_MS=1000*60*60*2;
  function isGeneratePage(){return /\/generate(-prod)?\.html$/.test(location.pathname)}
  function modeLabel(){return document.querySelector('.modeTabs button.active')?.textContent?.trim() || 'リファレンス'}
  function injectStyle(){
    if(document.getElementById('flowvidGenerateEnhancementStyle')) return;
    const style=document.createElement('style');
    style.id='flowvidGenerateEnhancementStyle';
    style.textContent=`
      body.flowvid-ui .settings .estimate{display:none!important;}
      body.flowvid-ui #notice{display:none!important;}
      body.flowvid-ui #createBtn{display:flex!important;align-items:center!important;justify-content:center!important;gap:10px!important;}
      body.flowvid-ui #createBtn .flowvidCreateCost{display:inline-flex!important;align-items:center!important;gap:4px!important;font-weight:1000!important;opacity:.92!important;}
      body.flowvid-ui #createBtn .flowvidCostIcon{width:22px!important;height:22px!important;border-radius:999px!important;display:inline-grid!important;place-items:center!important;background:#050506!important;color:#fff!important;font-size:13px!important;line-height:1!important;}
      body.flowvid-ui .flowvid-unfinished-task .taskPreview{display:none!important;}
      body.flowvid-ui .flowvid-unfinished-task .taskActions{display:none!important;}
      body.flowvid-ui .flowvid-unfinished-task{padding-bottom:13px!important;}
      body.flowvid-ui .flowvid-stale-unfinished-task{display:none!important;}
      body.flowvid-ui .flowvidActionLabel{width:auto!important;min-width:58px!important;height:42px!important;padding:4px 9px!important;display:grid!important;grid-template-rows:auto auto!important;place-items:center!important;gap:2px!important;line-height:1.05!important;font-size:11px!important;font-weight:900!important;}
      body.flowvid-ui .flowvidActionLabel .flowvidIcon{font-size:15px;line-height:1;display:block;}
      body.flowvid-ui .flowvidActionLabel .flowvidLabel{font-size:10px;line-height:1;display:block;opacity:.9;letter-spacing:.02em;}
    `;
    document.head.appendChild(style);
  }
  function cardTimeText(card){
    const nodes=Array.from(card.querySelectorAll('div'));
    return nodes.map(n=>(n.textContent||'').trim()).reverse().find(t=>/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}$/.test(t)) || '';
  }
  function cardTime(card){
    const text=cardTimeText(card);
    if(!text) return 0;
    const d=new Date(text.replace(/\//g,'-'));
    return Number.isNaN(d.getTime())?0:d.getTime();
  }
  function hasVideo(card){return Boolean(card.querySelector('.taskVideoWrap'))}
  function isFreshUnfinished(card){
    const t=cardTime(card);
    if(!t) return false;
    return Date.now()-t < ACTIVE_TASK_WINDOW_MS;
  }
  function sortCardsNewestFirst(){
    const list=document.getElementById('taskList');
    if(!list) return;
    const cards=Array.from(list.querySelectorAll(':scope > .taskCard'));
    if(cards.length<2) return;
    cards.slice().sort((a,b)=>cardTime(b)-cardTime(a)).forEach(card=>list.appendChild(card));
  }
  function markCards(){
    document.querySelectorAll('.taskCard').forEach(card=>{
      const video=hasVideo(card);
      card.classList.toggle('flowvid-unfinished-task',!video);
      card.classList.toggle('flowvid-stale-unfinished-task',!video&&!isFreshUnfinished(card));
    });
  }
  function setActionLabel(el,icon,label){
    if(!el||el.dataset.flowvidLabel===label) return;
    el.classList.add('flowvidActionLabel');
    el.dataset.flowvidLabel=label;
    el.innerHTML=`<span class="flowvidIcon">${icon}</span><span class="flowvidLabel">${label}</span>`;
  }
  function labelActions(){
    document.querySelectorAll('.taskActions .actionGroup').forEach(group=>{
      const items=Array.from(group.children);
      setActionLabel(items[0],'✦','編集');
      setActionLabel(items[1],'↗','開く');
      setActionLabel(items[2],'↓','保存');
    });
  }
  function updateCreateButton(){
    const createBtn=document.getElementById('createBtn');
    if(createBtn&&!createBtn.disabled){
      createBtn.innerHTML=`<span>作成する</span><span class="flowvidCreateCost"><span class="flowvidCostIcon">✦</span>${GENERATION_CREDIT_COST}</span>`;
    }
    const label=document.getElementById('modeLabel');
    if(label) label.textContent=modeLabel();
  }
  function applyUi(){
    if(!isGeneratePage()) return;
    document.body.classList.add('flowvid-ui');
    injectStyle();
    sortCardsNewestFirst();
    markCards();
    labelActions();
    updateCreateButton();
  }

  function currentClient(){
    return window.flowvidSupabaseClient?window.flowvidSupabaseClient():null;
  }
  function activeMode(){return document.querySelector('.modeTabs button.active')?.dataset.mode || 'reference_to_video'}
  function status(message,bad=false){
    const el=document.getElementById('status');
    if(!el) return;
    el.textContent=message;
    el.className='status show'+(bad?' bad':'');
  }
  function refreshTasksSoon(){
    const btn=document.getElementById('loadTasksBtn');
    if(!btn) return;
    [500,2500,7000].forEach(ms=>setTimeout(()=>btn.click(),ms));
  }
  function rememberOperation(operationName,email){
    if(!operationName) return;
    try{
      const key='flowvidOperationMap';
      const map=JSON.parse(localStorage.getItem(key)||'{}');
      map[operationName]={email:email||'',mode:activeMode(),createdAt:new Date().toISOString()};
      localStorage.setItem(key,JSON.stringify(map));
    }catch(_){ }
  }
  function patchFetch(){
    if(window.__flowvidFetchPatched) return;
    window.__flowvidFetchPatched=true;
    const original=window.fetch.bind(window);
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:(input?.url||'');
      if(!url.includes('/api/seedance-start')) return original(input,init);
      const client=currentClient();
      const {data}=client?await client.auth.getSession():{data:{session:null}};
      if(!data?.session?.user?.email){
        status('ログイン状態を確認できません。もう一度ログインしてください。',true);
        throw new Error('Authentication required');
      }
      const headers=new Headers(init?.headers||{});
      headers.set('Authorization','Bearer '+data.session.access_token);
      const response=await original(input,{...(init||{}),headers});
      const clone=response.clone();
      clone.json().then(body=>{
        const operationName=body?.operationName||body?.jobId||body?.id||'';
        rememberOperation(operationName,data.session.user.email);
        refreshTasksSoon();
      }).catch(()=>{});
      return response;
    };
  }
  function observe(){
    const root=document.getElementById('taskList')||document.body;
    let timer=null;
    new MutationObserver(()=>{
      clearTimeout(timer);
      timer=setTimeout(applyUi,80);
    }).observe(root,{childList:true,subtree:true});
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{patchFetch();applyUi();observe()},{once:true});
  }else{
    patchFetch();applyUi();observe();
  }
})();
