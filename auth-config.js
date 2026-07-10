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
    try{rows=JSON.parse(localStorage.getItem('flowvidUserOperations')||'[]')}catch(_){rows=[]}
    rows=rows.filter(row=>row&&row.operationName!==operationName);
    rows.unshift({operationName,email,startedAt:Date.now()});
    localStorage.setItem('flowvidUserOperations',JSON.stringify(rows.slice(0,10)));
  }
  async function checkOperation(row){
    const params=new URLSearchParams({operationName:row.operationName||''});
    if(row.email) params.set('userEmail',row.email);
    const res=await fetch('/api/check-veo-operation?'+params.toString());
    const data=await res.json();
    if(!res.ok||!data.ok) throw new Error(data.error||'生成状況を確認できませんでした');
    return data;
  }
  async function pollRememberedOperations(){
    if(!isGeneratePage()) return;
    let rows=[];
    try{rows=JSON.parse(localStorage.getItem('flowvidUserOperations')||'[]')}catch(_){rows=[]}
    if(!rows.length) return;
    const keep=[];
    for(const row of rows){
      if(!row?.operationName) continue;
      if(Date.now()-Number(row.startedAt||0)>1000*60*60*6) continue;
      try{
        const result=await checkOperation(row);
        if(result.completed){refreshTasksSoon()}else{keep.push(row)}
      }catch(_){keep.push(row)}
    }
    localStorage.setItem('flowvidUserOperations',JSON.stringify(keep.slice(0,10)));
  }
  async function ensureCredits(user){
    try{
      await fetch('/api/ensure-user-credits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.id,email:user.email||''})});
    }catch(_){}
  }
  async function totalCredits(client,userId){
    const {data}=await client.from('credit_balances').select('free_credits,subscription_credits,purchased_credits').eq('user_id',userId).maybeSingle();
    return Number(data?.free_credits||0)+Number(data?.subscription_credits||0)+Number(data?.purchased_credits||0);
  }
  async function createAndRun(){
    const client=currentClient();
    if(!client){status('Supabase接続情報が未設定です。',true);return}
    const {data:sessionData,error:sessionError}=await client.auth.getSession();
    const user=sessionData?.session?.user||null;
    if(sessionError||!user){location.href='./login.html';return}
    await ensureCredits(user);
    const balance=await totalCredits(client,user.id);
    if(balance<GENERATION_CREDIT_COST){status(`クレジット不足です。${GENERATION_CREDIT_COST}クレジット必要です。`,true);return}
    const prompt=(document.getElementById('prompt')?.value||'').trim();
    if(!prompt){status('プロンプトを入力してください。',true);return}
    const createBtn=document.getElementById('createBtn');
    const originalHTML=createBtn?.innerHTML||'作成する';
    if(createBtn){createBtn.disabled=true;createBtn.textContent='生成開始中…'}
    status('タスクを作成しています…');
    try{
      const taskPayload={
        user_id:user.id,
        mode:activeMode(),
        prompt,
        resolution:'veo',
        duration_seconds:Number(document.getElementById('duration')?.value||5),
        aspect_ratio:document.getElementById('aspectRatio')?.value||'9:16',
        credit_cost:GENERATION_CREDIT_COST,
        status:'draft',
        api_provider:'veo'
      };
      const {data:task,error:insertError}=await client.from('generation_tasks').insert(taskPayload).select('id').single();
      if(insertError||!task?.id) throw new Error(insertError?.message||'タスク作成に失敗しました');
      status('Veo生成を開始しています…');
      refreshTasksSoon();
      const res=await fetch('/api/run-generation-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:task.id})});
      const result=await res.json();
      if(!res.ok||!result.ok) throw new Error(result.error||'Veo生成開始に失敗しました');
      if(result.operationName) rememberOperation(result.operationName,user.email||'');
      document.getElementById('prompt').value='';
      status('生成中です。完成したら動画が表示されます。');
      refreshTasksSoon();
      [12000,30000,60000].forEach(ms=>setTimeout(pollRememberedOperations,ms));
    }catch(error){
      status('生成開始エラー：'+(error.message||String(error)),true);
    }finally{
      if(createBtn){createBtn.disabled=false;createBtn.innerHTML=originalHTML}
      applyUi();
    }
  }
  function hookCreate(){
    const btn=document.getElementById('createBtn');
    if(!btn||btn.dataset.flowvidRunHooked==='1') return;
    btn.dataset.flowvidRunHooked='1';
    btn.onclick=createAndRun;
  }
  function start(){
    if(!isGeneratePage()) return;
    applyUi();
    hookCreate();
    setInterval(()=>{applyUi();hookCreate()},700);
    setTimeout(pollRememberedOperations,2500);
    setInterval(pollRememberedOperations,30000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start);
  else start();
})();

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
    button.onclick=()=>{location.href='./admin-ops.html'};
    nav.insertBefore(button,logout||null);
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',addLink,{once:true});
  else addLink();
})();
