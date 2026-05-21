window.FLOWVID_AUTH = {
  supabaseUrl: "https://jflpjsdjmlkmkqfahxwy.supabase.co",
  supabaseAnonKey: "sb_publishable_YbRKnQh1fCVO5VDJyVWfyQ_sNzHqvCE",
  redirectTo: "https://pina753753-star.github.io/seedance-black-studio/profile.html",
  adminRedirectTo: "https://pina753753-star.github.io/seedance-black-studio/admin.html",
  adminEmails: ["hinaran53@gmail.com"]
};

(function addGeneratedVideoHistoryToAdminMenu(){
  function addButton(){
    if(!/\/admin\.html$/.test(location.pathname))return;
    const nav=document.querySelector('.drawer .nav');
    if(!nav||document.getElementById('generatedVideoHistoryMenuBtn'))return;
    const button=document.createElement('button');
    button.id='generatedVideoHistoryMenuBtn';button.type='button';button.textContent='生成動画履歴';
    button.onclick=()=>{location.href='./admin-video-history.html'};
    const settingsButton=Array.from(nav.querySelectorAll('button')).find(item=>item.textContent.includes('API'));
    settingsButton?nav.insertBefore(button,settingsButton):nav.appendChild(button);
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',()=>setTimeout(addButton,0)):setTimeout(addButton,0);
})();

(function persistAdminViewAcrossReloads(){
  const allowed=new Set(['dashboard','veo','result','settings']);
  const hashView=()=>{const raw=String(location.hash||'').replace(/^#/,'').trim();return allowed.has(raw)?raw:''};
  const savedView=()=>{const raw=localStorage.getItem('flowvidAdminView')||'';return allowed.has(raw)?raw:''};
  function remember(view){if(!allowed.has(view))return;localStorage.setItem('flowvidAdminView',view);if(location.hash!==`#${view}`)history.replaceState(null,'',`#${view}`)}
  function hook(){
    if(!/\/admin\.html$/.test(location.pathname)||typeof window.showView!=='function')return false;
    if(!window.showView.__flowvidPersistHooked){const original=window.showView;window.showView=function(name){const r=original.apply(this,arguments);if(allowed.has(name))remember(name);return r};window.showView.__flowvidPersistHooked=true}
    const view=hashView()||savedView();if(view){window.showView(view);remember(view)}
    document.querySelectorAll('.drawer .nav button[data-view]').forEach(btn=>{if(btn.dataset.flowvidRememberView)return;btn.dataset.flowvidRememberView='1';btn.addEventListener('click',()=>remember(btn.dataset.view||''))});
    return true;
  }
  function start(){if(!/\/admin\.html$/.test(location.pathname))return;let n=0;const timer=setInterval(()=>{n++;if(hook()||n>40)clearInterval(timer)},150)}
  addEventListener('hashchange',()=>{const view=hashView();if(view&&typeof window.showView==='function'){window.showView(view);remember(view)}});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',start):start();
})();

(function autoSaveCompletedVeoResults(){
  function findVideoUri(obj){if(!obj||typeof obj!=='object')return'';if(obj.video&&obj.video.uri)return obj.video.uri;if(obj.uri&&String(obj.uri).includes('/files/'))return obj.uri;for(const key of Object.keys(obj)){const found=findVideoUri(obj[key]);if(found)return found}return''}
  function findOperationName(obj){if(!obj||typeof obj!=='object')return'';if(obj.operationName)return obj.operationName;if(obj.name&&String(obj.name).includes('/operations/'))return obj.name;for(const key of Object.keys(obj)){const found=findOperationName(obj[key]);if(found)return found}return''}
  function readJson(el){if(!el)return null;const text=(el.textContent||'').trim();if(!text.startsWith('{'))return null;try{return JSON.parse(text)}catch(_){return null}}
  async function save(el){
    const data=readJson(el);if(!data||data.done!==true)return;
    const videoUri=findVideoUri(data),operationName=findOperationName(data);if(!videoUri||!operationName)return;
    const storageKey=`flowvidSavedVideo:${operationName}`;if(localStorage.getItem(storageKey)==='saved')return;localStorage.setItem(storageKey,'saving');
    const payload={operationName,videoUri,response:data,userEmail:(document.getElementById('adminEmail')?.textContent||'').trim()||'hinaran53@gmail.com',provider:'veo',model:document.getElementById('model')?.value||data.model||'models/veo-3.0-fast-generate-001',prompt:document.getElementById('prompt')?.value||null,aspectRatio:document.getElementById('aspectRatio')?.value||null,durationSeconds:5,creditCost:128,status:'completed'};
    try{const response=await fetch('/api/generated-videos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'保存に失敗しました');localStorage.setItem(storageKey,'saved');el.textContent=`${JSON.stringify(data,null,2)}\n\n✅ generated_videos に保存しました`}catch(error){localStorage.removeItem(storageKey);el.textContent=`${JSON.stringify(data,null,2)}\n\n⚠️ DB保存エラー：${error.message||String(error)}`}
  }
  function observe(id){const el=document.getElementById(id);if(!el||el.dataset.flowvidAutoSaveObserver)return;el.dataset.flowvidAutoSaveObserver='1';new MutationObserver(()=>save(el)).observe(el,{childList:true,characterData:true,subtree:true});save(el)}
  function start(){if(!/\/admin\.html$/.test(location.pathname))return;observe('veoStatus');observe('resultStatus')}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',()=>setTimeout(start,300)):setTimeout(start,300);
})();

(function addRunDraftTaskButtons(){
  function extractTaskId(item){const code=item.querySelector('button[onclick^="deleteTask"]')?.getAttribute('onclick')||'';return code.match(/deleteTask\('([^']+)'\)/)?.[1]||''}
  function setTaskStatus(message,bad=false){const el=document.getElementById('taskStatus');if(!el)return;el.textContent=message;el.className='status show'+(bad?' bad':'')}
  async function runTask(taskId,button){
    if(!confirm('このdraftをVeoで実行します。Google側で課金が発生する可能性があります。実行しますか？'))return;
    const original=button.textContent;button.disabled=true;button.textContent='Veo実行中…';setTaskStatus('Veo生成を開始しています…');
    try{const response=await fetch('/api/run-generation-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId})});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Veo実行に失敗しました');if(result.operationName)localStorage.setItem('flowvidVeoOperation',result.operationName);setTaskStatus(`${JSON.stringify(result,null,2)}\n\n✅ Veo実行を開始しました。operationName が出ています。`);document.getElementById('refreshTasksBtn')&&setTimeout(()=>document.getElementById('refreshTasksBtn').click(),900)}catch(error){setTaskStatus('Veo実行エラー：'+(error.message||String(error)),true)}finally{button.disabled=false;button.textContent=original}
  }
  function enhance(){if(!/\/admin\.html$/.test(location.pathname))return;document.querySelectorAll('#taskList .taskItem').forEach(item=>{if(item.dataset.flowvidRunButtonAdded)return;const status=item.querySelector('.taskTop span')?.textContent?.trim()||'';if(!['draft','queued','pending','failed','error'].includes(status))return;const taskId=extractTaskId(item),actions=item.querySelector('.taskActions');if(!taskId||!actions)return;const btn=document.createElement('button');btn.type='button';btn.className='taskBtn';btn.textContent='Veo実行';btn.onclick=()=>runTask(taskId,btn);actions.insertBefore(btn,actions.firstChild);item.dataset.flowvidRunButtonAdded='1'})}
  function start(){if(!/\/admin\.html$/.test(location.pathname))return;const list=document.getElementById('taskList');if(!list)return;enhance();new MutationObserver(enhance).observe(list,{childList:true,subtree:true})}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',()=>setTimeout(start,500)):setTimeout(start,500);
})();

(function addCurrentUsageEstimate(){
  const monthlyLimit=2000;const yen=v=>`¥${Math.round(Number(v||0)).toLocaleString('ja-JP')}`;
  function monthRows(rows){const now=new Date(),year=now.getFullYear(),month=now.getMonth();return(rows||[]).filter(row=>{const date=row.created_at?new Date(row.created_at):null;return date&&!Number.isNaN(date.getTime())&&date.getFullYear()===year&&date.getMonth()===month})}
  function ensureCard(){const settings=document.getElementById('settings');if(!settings||document.getElementById('currentUsageEstimateCard'))return;const card=document.createElement('article');card.className='card';card.id='currentUsageEstimateCard';card.innerHTML=`<h2>今月の利用状況</h2><div class="row"><span>FlowVid記録の利用額</span><strong id="flowvidUsageAmount">読み込み中</strong></div><div class="row"><span>生成回数</span><strong id="flowvidUsageCount">-</strong></div><div class="row"><span>月上限まで残り</span><strong id="flowvidUsageRemaining">-</strong></div><div class="row"><span>上限使用率</span><strong id="flowvidUsagePercent">-</strong></div><div class="mini" id="flowvidUsageNote">generated_videos の credit_cost を集計した目安です。Google AI Studioの実請求額は下のボタンから確認してください。</div><button class="btn secondary" id="refreshUsageEstimateBtn" type="button">利用状況を再読み込み</button>`;const first=settings.querySelector('.card');first?.nextSibling?first.parentNode.insertBefore(card,first.nextSibling):settings.appendChild(card);document.getElementById('refreshUsageEstimateBtn')?.addEventListener('click',loadUsage)}
  async function loadUsage(){ensureCard();const a=document.getElementById('flowvidUsageAmount'),c=document.getElementById('flowvidUsageCount'),r=document.getElementById('flowvidUsageRemaining'),p=document.getElementById('flowvidUsagePercent'),n=document.getElementById('flowvidUsageNote');if(!a)return;a.textContent='読み込み中';try{const response=await fetch('/api/generated-videos?limit=50');const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'利用状況を取得できませんでした');const completed=monthRows(data.rows||[]).filter(row=>['completed','processing'].includes(String(row.status||'')));const total=completed.reduce((sum,row)=>sum+Number(row.credit_cost||0),0);a.textContent=yen(total);c.textContent=`${completed.length}回`;r.textContent=yen(Math.max(monthlyLimit-total,0));p.textContent=`${Math.min((total/monthlyLimit)*100,999).toFixed(1)}%`;n.textContent=`更新：${new Date().toLocaleString('ja-JP')}。この表示はFlowVid内の記録ベースです。Google AI Studio側の実測額とは数円ずれる可能性があります。`}catch(error){a.textContent='取得エラー';c.textContent='-';r.textContent='-';p.textContent='-';if(n)n.textContent=error.message||String(error)}}
  function start(){if(!/\/admin\.html$/.test(location.pathname))return;ensureCard();loadUsage();const nav=document.querySelector('.drawer .nav');if(nav&&!nav.dataset.flowvidUsageHooked){nav.dataset.flowvidUsageHooked='1';nav.addEventListener('click',e=>{if(e.target.closest('button[data-view="settings"]'))setTimeout(loadUsage,400)})}}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',()=>setTimeout(start,600)):setTimeout(start,600);
})();

(function labelGenerateActionButtons(){
  function injectStyle(){if(document.getElementById('flowvidGenerateActionLabelStyle'))return;const style=document.createElement('style');style.id='flowvidGenerateActionLabelStyle';style.textContent=`.flowvidActionLabel{width:auto!important;min-width:58px!important;height:42px!important;padding:4px 9px!important;display:grid!important;grid-template-rows:auto auto!important;place-items:center!important;gap:2px!important;line-height:1.05!important;font-size:11px!important;font-weight:900!important}.flowvidActionLabel .flowvidIcon{font-size:15px;line-height:1;display:block}.flowvidActionLabel .flowvidLabel{font-size:10px;line-height:1;display:block;opacity:.9;letter-spacing:.02em}`;document.head.appendChild(style)}
  function setLabel(el,icon,label){if(!el||el.dataset.flowvidLabel===label)return;el.classList.add('flowvidActionLabel');el.dataset.flowvidLabel=label;el.innerHTML=`<span class="flowvidIcon">${icon}</span><span class="flowvidLabel">${label}</span>`}
  function labelActions(){if(!/\/generate\.html$/.test(location.pathname))return;injectStyle();document.querySelectorAll('.taskActions .actionGroup').forEach(group=>{const items=Array.from(group.children);setLabel(items[0],'✦','編集');setLabel(items[1],'↗','開く');setLabel(items[2],'↓','保存')})}
  function start(){if(!/\/generate\.html$/.test(location.pathname))return;labelActions();const list=document.getElementById('taskList');if(list&&!list.dataset.flowvidActionLabelObserver){list.dataset.flowvidActionLabelObserver='1';new MutationObserver(labelActions).observe(list,{childList:true,subtree:true})}setTimeout(labelActions,800);setTimeout(labelActions,1800)}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',start):start();
})();

(function runUserCreateButtonWithVeo(){
  const isGeneratePage=()=>/\/generate\.html$/.test(location.pathname);
  function status(message,bad=false){const el=document.getElementById('status');if(!el)return;el.textContent=message;el.className='status show'+(bad?' bad':'')}
  function notice(message,bad=false){const el=document.getElementById('notice');if(!el)return;el.textContent=message;el.className=bad?'pill bad':'pill'}
  const activeMode=()=>document.querySelector('.modeTabs button.active')?.dataset.mode||'reference_to_video';
  function currentClient(){const cfg=window.FLOWVID_AUTH||{};if(!window.supabase||!cfg.supabaseUrl||!cfg.supabaseAnonKey)return null;if(!window.__flowvidUserClient)window.__flowvidUserClient=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);return window.__flowvidUserClient}
  function refreshTasksSoon(){const btn=document.getElementById('loadTasksBtn');if(btn){setTimeout(()=>btn.click(),500);setTimeout(()=>btn.click(),2500);setTimeout(()=>btn.click(),7000)}}
  function rememberOperation(operationName,email){if(!operationName)return;let rows=[];try{rows=JSON.parse(localStorage.getItem('flowvidUserOperations')||'[]')}catch(_){rows=[]}rows=rows.filter(row=>row&&row.operationName!==operationName);rows.unshift({operationName,email,startedAt:Date.now()});localStorage.setItem('flowvidUserOperations',JSON.stringify(rows.slice(0,10)))}
  async function checkOperation(row){const params=new URLSearchParams({operationName:row.operationName||''});if(row.email)params.set('userEmail',row.email);const response=await fetch('/api/check-veo-operation?'+params.toString());const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'生成状況を確認できませんでした');return data}
  async function pollRememberedOperations(){if(!isGeneratePage())return;let rows=[];try{rows=JSON.parse(localStorage.getItem('flowvidUserOperations')||'[]')}catch(_){rows=[]}if(!rows.length)return;const kept=[];for(const row of rows){if(!row?.operationName)continue;if(Date.now()-Number(row.startedAt||0)>1000*60*60*6)continue;try{const result=await checkOperation(row);if(result.completed){notice('動画が完成しました');refreshTasksSoon()}else kept.push(row)}catch(_){kept.push(row)}}localStorage.setItem('flowvidUserOperations',JSON.stringify(kept.slice(0,10)))}
  async function createAndRun(){
    const client=currentClient();if(!client){status('Supabase接続情報が未設定です。',true);return}
    const{data:sessionData,error:sessionError}=await client.auth.getSession();const user=sessionData?.session?.user||null;if(sessionError||!user){location.href='./login.html';return}
    const prompt=(document.getElementById('prompt')?.value||'').trim();if(!prompt){status('プロンプトを入力してください。',true);return}
    const createBtn=document.getElementById('createBtn'),originalText=createBtn?.textContent||'作成する';if(createBtn){createBtn.disabled=true;createBtn.textContent='生成開始中…'}notice('Veo生成を開始しています…');status('タスクを作成しています…');
    try{const payload={user_id:user.id,mode:activeMode(),prompt,resolution:'veo',duration_seconds:Number(document.getElementById('duration')?.value||5),aspect_ratio:document.getElementById('aspectRatio')?.value||'9:16',credit_cost:128,status:'draft',api_provider:'veo'};const{data:task,error:insertError}=await client.from('generation_tasks').insert(payload).select('id').single();if(insertError||!task?.id)throw new Error(insertError?.message||'タスク作成に失敗しました');status('タスクを作成しました。Veo生成を開始しています…');refreshTasksSoon();const response=await fetch('/api/run-generation-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:task.id})});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Veo生成開始に失敗しました');if(result.operationName)rememberOperation(result.operationName,user.email||'');document.getElementById('prompt').value='';notice('生成中です');status('Veo生成を開始しました。完成したらタスク欄に動画が表示されます。');refreshTasksSoon();setTimeout(pollRememberedOperations,12000);setTimeout(pollRememberedOperations,30000);setTimeout(pollRememberedOperations,60000)}catch(error){notice('生成開始に失敗しました',true);status('生成開始エラー：'+(error.message||String(error)),true)}finally{if(createBtn){createBtn.disabled=false;createBtn.textContent=originalText}}
  }
  function hookCreateButton(){if(!isGeneratePage())return;const button=document.getElementById('createBtn');if(!button)return;if(button.dataset.flowvidUserRunHooked==='1')return;button.dataset.flowvidUserRunHooked='1';button.onclick=createAndRun}
  function start(){if(!isGeneratePage())return;let attempts=0;const timer=setInterval(()=>{attempts++;const button=document.getElementById('createBtn');if(button){button.dataset.flowvidUserRunHooked='';hookCreateButton()}if(attempts>20)clearInterval(timer)},400);setTimeout(pollRememberedOperations,2500);setInterval(pollRememberedOperations,30000)}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',start):start();
})();

(function flowvidCreditUi(){
  function isGeneratePage(){return /\/generate\.html$/.test(location.pathname)}
  function injectStyle(){if(document.getElementById('flowvidCreditUiStyle'))return;const style=document.createElement('style');style.id='flowvidCreditUiStyle';style.textContent=`body.flowvid-credit-ui .settings .estimate{display:none!important}body.flowvid-credit-ui #modeLabel{border:1px solid rgba(215,184,106,.26)!important;background:rgba(215,184,106,.08)!important;color:#f8e7b5!important;border-radius:999px!important;padding:7px 9px!important;font-size:12px!important;font-weight:900!important;white-space:nowrap!important}`;document.head.appendChild(style)}
  function apply(){if(!isGeneratePage())return;document.body.classList.add('flowvid-credit-ui');injectStyle();const modeLabel=document.getElementById('modeLabel');if(modeLabel)modeLabel.textContent='消費 128クレジット';document.querySelector('.settings .estimate')?.setAttribute('aria-hidden','true')}
  function start(){if(!isGeneratePage())return;apply();setInterval(apply,700)}
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',start):start();
})();
