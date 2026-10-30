/* モーション (Kling v3.0 Pro Motion Control・運営専用BETA。内部名はdance)
 * generate-prod.html の専用セクション(#kdSection)を制御する。mainCard/絵コンテの入力・下書き・
 * assets には触れない。料金(1秒あたりのクレジット)はサーバーの /api/reference-dance-access が
 * 返す値だけを使い、未決定(null)の間は見積もりを出さず送信を無効にする。 */
(function(){
  'use strict';
  const METHOD='kling_v3_motion_control';
  const CARRIER_MODEL='bytedance/seedance-2.5';
  const $=id=>document.getElementById(id);
  if(!$('kdSection')||!$('danceTab'))return;

  const access={allowed:false,rate:null,min:4,max:10};
  const state={
    image:{status:'idle',url:'',name:'',error:'',previewUrl:''},
    video:{status:'idle',id:'',name:'',billableSeconds:0,durationMs:0,error:'',retryable:false},
    inFlight:false
  };

  const token=()=>window.FlowVidAuthGuard.getVerifiedToken(window.flowvidSupabaseClient?window.flowvidSupabaseClient():undefined);
  const busy=()=>state.inFlight||['uploading','checking'].includes(state.video.status)||state.image.status==='uploading';

  // 表示・送信・サーバーの見積もりを同じ式(秒数×サーバー提供の単価)に統一する。
  // Acceptance uses the measured length (no rounding first); billing uses the server's billed seconds.
  function inRange(v){return Number.isFinite(v.durationMs)&&v.durationMs>=access.min*1000&&v.durationMs<=access.max*1000&&v.billableSeconds===Math.ceil(v.durationMs/1000)}
  function estimate(){
    const v=state.video;
    if(v.status!=='ready'||!access.rate)return null;
    if(!inRange(v))return null;
    // Same rule as the server: billed seconds = the inspected ceil(durationMs/1000).
    return v.billableSeconds*access.rate;
  }

  function blockReason(){
    if(!access.allowed)return '運営専用BETAです';
    if(!access.rate)return 'モーションは現在準備中です。料金確定後にご利用いただけます。';
    if(state.image.status!=='completed')return 'キャラクター画像を1枚追加してください';
    if(state.video.status==='ready'&&!inRange(state.video))return `お手本動画は${access.min}〜${access.max}秒のものを選んでください。自動では短くしません。`;
    if(state.video.status!=='ready')return 'お手本動画を追加してください';
    return '';
  }

  function render(){
    const tab=$('danceTab');tab.hidden=!access.allowed;
    const img=state.image,vid=state.video;
    $('kdImageNote').textContent=img.status==='uploading'?'アップロード中…':img.status==='failed'?(img.error||'画像を利用できません'):img.status==='completed'?(img.name||'画像を追加済み'):'PNG／JPEG／WebP・1枚のみ';
    const prev=$('kdImagePreview');prev.style.display=img.previewUrl?'block':'none';if(img.previewUrl&&prev.getAttribute('src')!==img.previewUrl)prev.setAttribute('src',img.previewUrl);
    $('kdImageRemove').style.display=img.status!=='idle'&&!busy()?'block':'none';
    $('kdImageFile').disabled=busy();
    $('kdRights').disabled=busy()||vid.status!=='idle';
    $('kdVideoFile').disabled=busy()||!access.allowed||!access.rate||!$('kdRights').checked;
    $('kdVideoName').textContent=vid.name||`お手本動画: MP4／MOV・${access.min}〜${access.max}秒・最大50MB`;
    let note=`${access.max}秒を超える動画は使えません。自動では短くしません。`;
    if(vid.status==='uploading')note='非公開領域へアップロード中…';
    else if(vid.status==='checking')note='形式・長さ・安全性を検査中…';
    else if(vid.status==='ready')note=`検査完了・${(vid.durationMs/1000).toFixed(3)}秒（課金${vid.billableSeconds}秒）`;
    else if(vid.status==='failed')note=vid.error||'お手本動画を利用できません';
    else if(!$('kdRights').checked)note='権利確認にチェックすると選択できます';
    $('kdVideoNote').textContent=note;
    $('kdVideoRetry').style.display=vid.status==='failed'&&vid.retryable&&vid.id&&!busy()?'block':'none';
    $('kdVideoRemove').style.display=vid.status!=='idle'&&!busy()?'block':'none';
    const cost=estimate();const reason=blockReason();
    const btn=$('kdCreate');
    btn.textContent=cost?`作成する ✦ ${cost}`:'作成する';
    $('kdCost').textContent=cost?`消費クレジット: ${cost} cr（${access.rate}cr × ${state.video.billableSeconds}秒）`:(access.allowed&&access.rate?`お手本動画を入れると消費クレジットが表示されます（${access.rate}cr/秒）`:'');
    btn.disabled=!!reason||busy();
    btn.title=reason;
    return cost;
  }

  function showStatus(html){const el=$('kdStatus');el.innerHTML=html;el.style.display=html?'block':'none'}
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function loadAccess(){
    try{
      const t=await token();if(!t)return;
      const r=await fetch('/api/reference-dance-access',{headers:{Authorization:'Bearer '+t}});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.ok&&d.allowed===true&&d.klingDance&&d.klingDance.method===METHOD){
        access.allowed=true;
        access.rate=Number.isInteger(d.klingDance.creditsPerSecond)&&d.klingDance.creditsPerSecond>0?d.klingDance.creditsPerSecond:null;
        access.min=Number(d.klingDance.minSeconds)||4;access.max=Number(d.klingDance.maxSeconds)||10;
      }
    }catch(_){}
    render();
  }

  // ---- キャラクター画像(既存の3段階アップロードと同じ経路) ----
  async function uploadImage(file){
    if(!file||busy())return;
    const prev=state.image;
    state.image={status:'uploading',url:'',name:file.name||'画像',error:'',previewUrl:''};render();
    try{
      const t=await token();if(!t){location.href='./login.html';return}
      const prepared=await prepareImageForUpload(file);
      const blob=prepared&&dataUrlToBlob(prepared.dataUrl);
      if(!blob)throw new Error('画像の変換に失敗しました');
      const u=await fetch('/api/reference-image-upload-url',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({filename:file.name||'reference.jpg',contentType:prepared.contentType,byteSize:blob.size})});
      const ud=await u.json().catch(()=>null);
      if(!u.ok||!ud||!ud.ok||!ud.token||!ud.path)throw new Error((ud&&(ud.message||ud.error))||'アップロードに失敗しました');
      const client=window.flowvidSupabaseClient?window.flowvidSupabaseClient():null;if(!client)throw new Error('Supabase接続情報が未設定です');
      const up=await client.storage.from(ud.bucket||'reference-image-quarantine').uploadToSignedUrl(ud.path,ud.token,blob,{contentType:prepared.contentType});
      if(up.error)throw new Error('画像のアップロードに失敗しました');
      const c=await fetch('/api/reference-image-confirm-upload',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({path:ud.path})});
      const cd=await c.json().catch(()=>null);
      const url=cd&&(cd.publicUrl||cd.url);
      if(!c.ok||!cd||!cd.ok||!url)throw new Error((cd&&(cd.message||cd.error))||'アップロードに失敗しました');
      state.image={status:'completed',url,name:file.name||'画像',error:'',previewUrl:prepared.dataUrl};
    }catch(e){
      state.image=prev.status==='completed'?prev:{status:'failed',url:'',name:file.name||'画像',error:e&&e.message||'画像を利用できません',previewUrl:''};
    }
    render();
  }

  // ---- お手本動画(既存の reference-dance-* と同じ経路。トリムは常に無効) ----
  async function deleteAsset(id){if(!id)return;try{const t=await token();if(!t)return;await fetch('/api/reference-dance-delete',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({assetId:id})})}catch(_){}}
  async function confirmVideo(){
    const v=state.video;if(!v.id||v.status==='checking'||state.inFlight)return false;
    v.status='checking';v.error='';render();
    try{
      const t=await token();if(!t){location.href='./login.html';return false}
      const r=await fetch('/api/reference-dance-confirm-upload',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({assetId:v.id,allowBoundaryTrim:false})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok||d.status!=='ready'){const err=new Error(d.message||d.error||'お手本動画を安全に確認できませんでした');err.retryable=d.retryable===true||d.error==='reference_video_checking';throw err}
      v.status='ready';v.durationMs=Number(d.durationMs||0);v.billableSeconds=Number(d.billableSeconds||0);v.retryable=false;
      render();return true;
    }catch(e){v.status='failed';v.retryable=!!(e&&e.retryable);v.error=e&&e.message||'お手本動画を利用できません';render();return false}
  }
  async function uploadVideo(file){
    if(!file||busy()||!$('kdRights').checked)return;
    const type=String(file.type||'').toLowerCase();
    const bad=msg=>{const prevId=state.video.id;if(prevId)deleteAsset(prevId);state.video={status:'failed',id:'',name:file.name||'お手本動画',billableSeconds:0,durationMs:0,error:msg,retryable:false};render()};
    if(!['video/mp4','video/quicktime'].includes(type)&&!/[.](mp4|mov)$/.test(String(file.name||'').toLowerCase()))return bad('MP4またはMOV形式の動画を選択してください');
    if(file.size<=0||file.size>50*1024*1024)return bad('お手本動画は50MB以下にしてください');
    const previousId=state.video.id;
    state.video={status:'uploading',id:'',name:file.name||'お手本動画',billableSeconds:0,durationMs:0,error:'',retryable:false};render();
    if(previousId)deleteAsset(previousId);
    try{
      const t=await token();if(!t){location.href='./login.html';return}
      const ur=await fetch('/api/reference-dance-upload-url',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({filename:file.name,contentType:type||'video/mp4',byteSize:file.size,rightsConfirmed:true})});
      const ud=await ur.json().catch(()=>({}));
      if(!ur.ok||!ud.ok||!ud.assetId||!ud.path||!ud.token)throw new Error(ud.message||ud.error||'お手本動画のアップロードを開始できませんでした');
      state.video.id=ud.assetId;
      const client=window.flowvidSupabaseClient?window.flowvidSupabaseClient():null;if(!client)throw new Error('Supabase接続情報が未設定です');
      const up=await client.storage.from(ud.bucket).uploadToSignedUrl(ud.path,ud.token,file,{contentType:'video/mp4'});
      if(up.error)throw up.error;
      await confirmVideo();
      
    }catch(e){const failed=state.video.id;state.video.status='failed';state.video.retryable=false;state.video.error=e&&e.message||'お手本動画を利用できません';if(failed)deleteAsset(failed);render()}
  }
  function removeVideo(){if(busy())return;const id=state.video.id;state.video={status:'idle',id:'',name:'',billableSeconds:0,durationMs:0,error:'',retryable:false};$('kdVideoFile').value='';$('kdRights').checked=false;render();deleteAsset(id)}
  function removeImage(){if(busy())return;state.image={status:'idle',url:'',name:'',error:'',previewUrl:''};$('kdImageFile').value='';render()}

  // ---- 送信(二重送信防止・金額確認・失敗時の表示) ----
  async function submit(){
    if(state.inFlight||(typeof generationRequestInFlight!=='undefined'&&generationRequestInFlight))return;
    if(blockReason())return;
    const cost=estimate();if(!cost)return;
    state.inFlight=true;render();
    showStatus('');
    let tmpId='';
    try{
      const t=await token();if(!t){location.href='./login.html';return}
      const balance=await getBalance();
      if(balance!==null&&balance<cost){showStatus(`クレジットが足りません。必要: ${cost} cr／現在: ${balance} cr`);return}
      generationRequestInFlight=true;
      tmpId='tmp_'+Date.now();_activePtId=tmpId;
      _ptInsertCard({id:tmpId,prompt:'モーション（画像とお手本動画）',mode:'reference_to_video',ui_mode:'reference_to_video',aspect_ratio:'16:9',duration_seconds:String(state.video.billableSeconds),resolution:'720p',created_at:new Date().toISOString(),_sending:true});
      // 画像は input_references で渡す。flowvid-open-inline.js の送信後処理は
      // reference_url(s) を見て通常タブの追加画像を消すため、それを避ける。
      // プロンプトは送らない(サーバーが固定の指示を構築し、body.promptは無視する)。
      const body={model:CARRIER_MODEL,duration:'5',resolution:'720p',aspect_ratio:'16:9',generate_audio:true,mode:'reference_to_video',estimated_credits:cost,
        dance_method:METHOD,reference_video_asset_id:state.video.id,reference_video_rights_confirmed:true,input_references:[state.image.url]};
      const res=await fetch('/api/seedance-start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify(body)});
      const data=await res.json().catch(()=>({}));
      if(res.status===401){_ptRemove(tmpId);_activePtId='';location.href='./login.html';return}
      if(res.status===409&&data&&data.error==='credit_cost_changed'){_ptRemove(tmpId);_activePtId='';showStatus(`消費クレジットが変わりました（表示 ${esc(data.estimatedCredits||cost)} cr → 現在 ${esc(data.credits)} cr）。生成は開始していません。ページを再読み込みして金額を確認してください。`);return}
      if(res.status===402){_ptRemove(tmpId);_activePtId='';showStatus(`クレジットが足りません。必要: ${esc(data.required||cost)} cr`);return}
      const jobId=data.jobId||extractJobId(data.response)||extractJobId(data)||'';
      const pollingUrl=data.pollingUrl||'';
      const realId=data.taskId||jobId||tmpId;
      if(realId!==tmpId){_ptUpdateCardId(tmpId,realId);_activePtId=realId}
      if(!res.ok&&data&&data.providerStarted===true&&(jobId||pollingUrl)){
        // The provider job is running but tracking could not be saved: keep polling it, never claim "not charged", ask not to resubmit.
        showStatus(esc(data.message||'生成は開始されましたが、生成情報の保存に失敗しました。再度生成せず、サポートへお問い合わせください。'));
        _ptShowAccepted(realId);_ptStartPoll({id:realId,api_task_id:jobId,polling_url:pollingUrl,ui_mode:'reference_to_video'});_activePtId='';return}
      if(!res.ok){
        // "Not charged" is only stated for rejections before any deduction (4xx); a 5xx without a confirmed refund makes no claim.
        const msg=esc((data&&(data.message||data.error))||'生成を開始できませんでした');
        if(data&&data.refunded===true)showStatus(msg);else if(res.status>=400&&res.status<500)showStatus(msg+'（クレジットは消費されていません）');else showStatus(msg+'（クレジットの状態は履歴・残高で確認してください）');
        _ptFail(_activePtId,(data&&(data.message||data.error))||('生成開始に失敗しました（'+res.status+'）'),data&&data.refunded===true);_activePtId='';return}
      if(!jobId&&!pollingUrl){_ptFail(_activePtId,'生成IDを取得できませんでした。しばらくしてからリロードしてください。',undefined);_activePtId='';return}
      _ptShowAccepted(realId);_ptStartPoll({id:realId,api_task_id:jobId,polling_url:pollingUrl,ui_mode:'reference_to_video'});
      // 受付済み: 入力を空に戻す(失敗時は保持して再試行できる)。
      state.image={status:'idle',url:'',name:'',error:'',previewUrl:''};
      state.video={status:'idle',id:'',name:'',billableSeconds:0,durationMs:0,error:'',retryable:false};
      $('kdImageFile').value='';$('kdVideoFile').value='';$('kdRights').checked=false;
      loadPendingTasks();
    }catch(_){
      if(tmpId){_ptFail(_activePtId||tmpId,'通信エラーが発生しました。もう一度お試しください。',undefined);_activePtId=''}
      else showStatus('通信エラーが発生しました。もう一度お試しください。');
    }finally{
      state.inFlight=false;generationRequestInFlight=false;render();
    }
  }

  $('kdImageFile').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';uploadImage(f)});
  $('kdVideoFile').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';uploadVideo(f)});
  $('kdVideoRetry').addEventListener('click',()=>{confirmVideo()});
  $('kdVideoRemove').addEventListener('click',removeVideo);
  $('kdImageRemove').addEventListener('click',removeImage);
  $('kdRights').addEventListener('change',render);
  $('kdCreate').addEventListener('click',submit);

  window.flowvidDanceKling={state,access,estimate,render};
  render();
  loadAccess();
})();
