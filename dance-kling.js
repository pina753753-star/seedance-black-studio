/* モーション (Kling v3.0 Pro Motion Control・一般向けBETA。内部名はdance)
 * generate-prod.html の専用セクション(#kdSection)を制御する。mainCard/絵コンテの入力・下書き・
 * assets には触れない。料金(1秒あたりのクレジット)はサーバーの /api/reference-dance-access が
 * 返す値だけを使い、未決定(null)の間は見積もりを出さず送信を無効にする。 */
(function(){
  'use strict';
  const METHOD='kling_v3_motion_control';
  const CARRIER_MODEL='bytedance/seedance-2.5';
  const $=id=>document.getElementById(id);
  if(!$('kdSection')||!$('danceTab'))return;

  const access={allowed:false,rate:null,min:4,max:10,sourceMax:60,imageMax:10,lengthSelect:false};
  const state={
    image:{status:'idle',url:'',name:'',error:'',previewUrl:''},
    video:newVideo(),
    inFlight:false
  };
  // seq invalidates late responses (replaced asset, newer length choice); masterMs = longest usable length of
  // the inspected file (<= 30 s), sourceMs = the original's length as reported at inspection, useSeconds = chosen
  // cut (null = the whole master), chosen = the current length has a successful server inspection.
  function newVideo(){return {status:'idle',id:'',name:'',billableSeconds:0,durationMs:0,error:'',retryable:false,masterMs:0,sourceMs:0,useSeconds:null,chosen:true,recutting:false,seq:0}}

  const token=()=>window.FlowVidAuthGuard.getVerifiedToken(window.flowvidSupabaseClient?window.flowvidSupabaseClient():undefined);
  const busy=()=>state.inFlight||state.video.recutting||['uploading','checking'].includes(state.video.status)||state.image.status==='uploading';

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
    if(!access.allowed)return '利用可能な無料・購入クレジット、または対象サブスクが必要です';
    if(!access.rate)return 'モーションは現在準備中です。料金確定後にご利用いただけます。';
    const reasons=[];
    if(state.image.status!=='completed')reasons.push('キャラクター画像を1枚追加してください');
    if(state.video.status==='ready'&&!inRange(state.video))reasons.push(`お手本動画は${access.min}〜${access.max}秒のものを選んでください。自動では短くしません。`);
    if(state.video.status!=='ready')reasons.push('お手本動画を追加してください');
    if(state.video.recutting)reasons.push('使用する長さを反映中です');
    if(access.lengthSelect&&!state.video.chosen)reasons.push('使用する長さを選んでください');
    return reasons.join('。');
  }

  // Seconds text without trailing zeros: 16200 -> "16.2", 15000 -> "15".
  const fmtSec=ms=>String(Number((ms/1000).toFixed(3)));
  const orientationOf=ms=>ms>access.imageMax*1000?'video':'image';

  // Length choice: whole master, or the first N seconds (N whole seconds shorter than the master).
  function renderLength(){
    const v=state.video,box=$('kdLengthBox');
    const show=access.lengthSelect&&v.id&&['ready','failed'].includes(v.status)&&(v.masterMs>0||v.restored===true);
    box.style.display=show?'block':'none';
    if(!show)return;
    const sel=$('kdLength');
    if(v.restored){
      if(sel.dataset.key!=='restored'){sel.innerHTML='<option value="saved"></option>';sel.options[0].textContent=`保存済みの${fmtSec(v.durationMs)}秒を使用`;sel.dataset.key='restored';}
      sel.value=v.chosen?'saved':'';sel.disabled=state.inFlight;
      $('kdSourceInfo').textContent='前回検査した使用区間を復元しました。元動画の長さは復元できないため、別の長さにする場合は元動画をもう一度追加してください。';
      $('kdUseSummary').textContent=v.chosen?`保存済み区間の実測${fmtSec(v.durationMs)}秒を使用`:'';
      $('kdOrientationNote').style.display=orientationOf(v.durationMs)==='video'?'block':'none';return;
    }
    const capped=v.sourceMs>access.max*1000;
    const wholeLabel=capped?`先頭${access.max}秒（元動画は${fmtSec(v.sourceMs)}秒）`:`お手本全体（${fmtSec(v.masterMs)}秒）`;
    const opts=[['whole',`自動：${wholeLabel}`]];
    if(!v.chosen)opts.push(['','長さを選んでください']);
    for(let n=access.min;n*1000<v.masterMs&&n<=access.max;n++)opts.push([String(n),`先頭${n}秒`]);
    const key=opts.map(o=>o.join('=')).join('|');
    if(sel.dataset.key!==key){sel.innerHTML='';opts.forEach(([val,label])=>{const o=document.createElement('option');o.value=val;o.textContent=label;sel.appendChild(o)});sel.dataset.key=key}
    sel.value=!v.chosen?'':(v.useSeconds===null?'whole':String(v.useSeconds));
    sel.disabled=state.inFlight||v.recutting||v.status==='uploading';
    $('kdSourceInfo').textContent=capped?`元動画は${fmtSec(v.sourceMs)}秒です。先頭${access.max}秒まで使えます。`:`元動画は${fmtSec(v.sourceMs||v.masterMs)}秒です。`;
    let summary='';
    if(v.recutting)summary='使用する長さを反映中…';
    else if(v.status==='ready'&&v.chosen&&inRange(v)){
      summary=`先頭から実測${fmtSec(v.durationMs)}秒を使用`;
    }
    $('kdUseSummary').textContent=summary;
    $('kdOrientationNote').style.display=v.status==='ready'&&inRange(v)&&orientationOf(v.durationMs)==='video'?'block':'none';
  }

  function render(){
    const tab=$('danceTab');tab.hidden=!access.allowed;
    const img=state.image,vid=state.video;
    $('kdImageNote').textContent=img.status==='uploading'?'アップロード中…':img.status==='failed'?(img.error||'画像を利用できません'):img.status==='completed'?(img.name||'画像を追加済み'):'PNG／JPEG／WebP・1枚のみ';
    const prev=$('kdImagePreview');prev.style.display=img.previewUrl?'block':'none';if(img.previewUrl&&prev.getAttribute('src')!==img.previewUrl)prev.setAttribute('src',img.previewUrl);
    $('kdImageRemove').style.display=img.status!=='idle'&&!busy()?'block':'none';
    $('kdImageFile').disabled=busy()||!access.allowed;
    $('kdRights').disabled=busy()||vid.status!=='idle';
    $('kdVideoFile').disabled=busy()||!access.allowed||!access.rate||!$('kdRights').checked;
    $('kdVideoName').textContent=vid.name||(access.lengthSelect?`お手本動画: MP4／MOV・${access.min}〜${access.sourceMax}秒・最大50MB`:`お手本動画: MP4／MOV・${access.min}〜${access.max}秒・最大50MB`);
    let note=access.lengthSelect?`自動でお手本の長さに合わせます（${access.max}秒超は先頭${access.max}秒）。`:`${access.max}秒を超える動画は使えません。自動では短くしません。`;
    if(vid.status==='uploading')note='非公開領域へアップロード中…';
    else if(vid.status==='checking')note='形式・長さ・安全性を検査中…';
    else if(vid.status==='ready')note=inRange(vid)?`検査完了・${(vid.durationMs/1000).toFixed(3)}秒（課金${vid.billableSeconds}秒）`:`検査完了・${(vid.durationMs/1000).toFixed(3)}秒。ただしモーションは${access.min}〜${access.max}秒の動画が必要です。この動画では生成できません。`;
    else if(vid.status==='failed')note=vid.error||'お手本動画を利用できません';
    else if(!$('kdRights').checked)note='権利確認にチェックすると選択できます';
    $('kdVideoNote').textContent=note;
    renderLength();
    $('kdVideoRetry').style.display=vid.status==='failed'&&vid.retryable&&vid.id&&!busy()?'block':'none';
    $('kdVideoRemove').style.display=vid.status!=='idle'&&!busy()?'block':'none';
    const cost=estimate();const reason=blockReason();
    const btn=$('kdCreate');
    btn.textContent='作成する';
    $('kdCost').textContent=cost&&(!access.lengthSelect||state.video.chosen)?`消費クレジット: ${cost} cr（${access.rate}cr × ${state.video.billableSeconds}秒）`:(access.allowed&&access.rate?`${access.rate}cr/秒`:'');
    btn.disabled=!!reason||busy();
    btn.title=reason;
    const why=$('kdReason');
    if(why){
      const initial=access.allowed&&access.rate&&img.status==='idle'&&vid.status==='idle';
      why.textContent=initial?'画像とお手本動画を追加してください':busy()?'処理中です。完了までお待ちください。':reason;
      why.style.color=img.status==='failed'||vid.status==='failed'||(vid.status==='ready'&&!inRange(vid))?'#fca5a5':'#9ca3af';why.hidden=!why.textContent;
    }
    if(vid.status==='ready'&&!inRange(vid))$('kdCost').textContent='対応する長さの動画を選ぶと見積もりを表示します。';
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
        access.imageMax=Number(d.klingDance.imageOrientationMaxSeconds)||10;access.sourceMax=Number(d.klingDance.sourceMaxSeconds)||60;
        access.lengthSelect=d.klingDance.lengthSelectEnabled===true&&access.max>access.imageMax;
      }
    }catch(_){}
    render();
    if(access.allowed)restoreReadyMotion();
  }

  // Restore only an owned, unexpired, already-inspected motion asset. Never re-inspect on reload.
  async function restoreReadyMotion(){
    try{
      if(state.video.id||state.video.status!=='idle')return;
      const t=await token();if(!t)return;
      const r=await fetch('/api/reference-dance-latest?profile=motion',{headers:{Authorization:'Bearer '+t}});
      const d=await r.json().catch(()=>({}));const a=d.asset;
      if(!r.ok||!d.ok||!a||a.status!=='ready'||!a.id||state.video.id||state.video.status!=='idle')return;
      state.video={...newVideo(),id:a.id,name:a.name||'前回のお手本動画',status:'ready',durationMs:Number(a.durationMs),billableSeconds:Number(a.billableSeconds),restored:true,chosen:true};
      // The original/master length is not persisted in the existing registry. Restore the sealed current clip only;
      // do not invent a length choice or silently re-cut it. A fresh upload can choose another length.
      render();
    }catch(_){}
  }

  // ---- キャラクター画像(既存の3段階アップロードと同じ経路) ----
  async function uploadImage(file){
    if(!file||busy()||!access.allowed)return;
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
      const r=await fetch('/api/reference-dance-confirm-upload',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify(access.lengthSelect?{assetId:v.id,allowBoundaryTrim:false,profile:'motion'}:{assetId:v.id,allowBoundaryTrim:false})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok||d.status!=='ready'){const err=new Error(d.message||d.error||'お手本動画を安全に確認できませんでした');err.retryable=d.retryable===true||d.error==='reference_video_checking';throw err}
      v.status='ready';v.durationMs=Number(d.durationMs||0);v.billableSeconds=Number(d.billableSeconds||0);v.retryable=false;
      if(access.lengthSelect&&d.motion){
        v.masterMs=Number(d.motion.masterDurationMs)||v.durationMs;v.sourceMs=Number(d.motion.sourceDurationMs)||v.masterMs;v.useSeconds=Number.isInteger(d.motion.useSeconds)?d.motion.useSeconds:null;
        // Automatic use follows the measured source, capped at the first 30 seconds.
        v.chosen=true;
      }
      render();return true;
    }catch(e){v.status='failed';v.retryable=!!(e&&e.retryable);v.error=e&&e.message||'お手本動画を利用できません';render();return false}
  }
  // Change the used length (first N seconds, or the whole master). Only the newest choice is applied; a late response
  // for an older choice or a replaced asset is ignored. A request refused as busy is retried while it is still the newest.
  async function changeLength(value){
    const v=state.video;
    if(!access.lengthSelect||!v.id||!['ready','failed'].includes(v.status)||state.inFlight||value==='')return;
    if(v.restored){if(value==='saved'){v.chosen=true;render();}return;}
    const useSeconds=value==='whole'?null:Number(value);
    const seq=++v.seq,assetId=v.id;
    v.recutting=true;v.error='';render();
    try{
      for(let attempt=0;attempt<6;attempt++){
        const t=await token();if(!t){location.href='./login.html';return}
        const r=await fetch('/api/reference-dance-confirm-upload',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({assetId,allowBoundaryTrim:false,profile:'motion',useSeconds})});
        const d=await r.json().catch(()=>({}));
        if(seq!==state.video.seq||assetId!==state.video.id)return;
        if(r.status===409&&d.error==='reference_video_checking'){await new Promise(res=>setTimeout(res,1300));if(seq!==state.video.seq)return;continue}
        if(!r.ok||!d.ok||d.status!=='ready'){const e=new Error(d.message||d.error||'使用する長さを反映できませんでした');e.code=d.error;throw e}
        v.durationMs=Number(d.durationMs||0);v.billableSeconds=Number(d.billableSeconds||0);v.status='ready';v.retryable=false;v.error='';
        if(d.motion){v.masterMs=Number(d.motion.masterDurationMs)||v.masterMs;v.useSeconds=Number.isInteger(d.motion.useSeconds)?d.motion.useSeconds:null}
        v.chosen=true;
        return;
      }
      throw new Error('長さを変更中です。少し待ってからもう一度選んでください。');
    }catch(e){
      if(seq!==state.video.seq)return;
      // The server may have kept either the previous or a retry state: the numbers on screen are no longer trusted, so
      // sending is blocked until a length is chosen again.
      v.status='failed';v.retryable=false;v.chosen=false;v.error=(e&&e.message||'使用する長さを反映できませんでした')+'（もう一度、使う長さを選んでください）';
    }finally{
      if(seq===state.video.seq){v.recutting=false;render()}
    }
  }

  async function uploadVideo(file){
    if(!file||busy()||!access.allowed||!$('kdRights').checked)return;
    const type=String(file.type||'').toLowerCase();
    const bad=msg=>{const prevId=state.video.id;if(prevId)deleteAsset(prevId);state.video={...newVideo(),status:'failed',name:file.name||'お手本動画',error:msg};render()};
    if(!['video/mp4','video/quicktime'].includes(type)&&!/[.](mp4|mov)$/.test(String(file.name||'').toLowerCase()))return bad('MP4またはMOV形式の動画を選択してください');
    if(file.size<=0||file.size>50*1024*1024)return bad('お手本動画は50MB以下にしてください');
    const previousId=state.video.id;
    state.video={...newVideo(),status:'uploading',name:file.name||'お手本動画',seq:state.video.seq+1};render();
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
  function removeVideo(){if(busy())return;const id=state.video.id;state.video={...newVideo(),seq:state.video.seq+1};$('kdVideoFile').value='';$('kdRights').checked=false;render();deleteAsset(id)}
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
        dance_method:METHOD,reference_video_asset_id:state.video.id,reference_video_rights_confirmed:true,input_references:[state.image.url],
        // What the screen showed (billed seconds and the orientation basis) is sent back; the server derives both from the sealed
        // file and refuses (409, nothing charged) if they differ, so a stale selection can never be billed or generated.
        ...(access.lengthSelect?{use_billable_seconds:state.video.billableSeconds,orientation_mode:orientationOf(state.video.durationMs)}:{})};
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
      state.video={...newVideo(),seq:state.video.seq+1};
      $('kdImageFile').value='';$('kdVideoFile').value='';$('kdRights').checked=false;
      loadPendingTasks();
    }catch(_){
      if(tmpId){_ptFail(_activePtId||tmpId,'通信エラーが発生しました。もう一度お試しください。',undefined);_activePtId=''}
      else showStatus('通信エラーが発生しました。もう一度お試しください。');
    }finally{
      state.inFlight=false;generationRequestInFlight=false;render();
    }
  }

  // Inline disclosure panels stay within the card at every viewport width.
  const helpButtons=[...document.querySelectorAll('#kdSection .kdHelpButton')];
  function closeHelp(button,restoreFocus=false){$(button.getAttribute('aria-controls')).hidden=true;button.setAttribute('aria-expanded','false');if(restoreFocus)button.focus();}
  helpButtons.forEach(button=>button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')==='true';helpButtons.forEach(b=>closeHelp(b));if(!open){$(button.getAttribute('aria-controls')).hidden=false;button.setAttribute('aria-expanded','true');}}));
  document.addEventListener('click',event=>{helpButtons.forEach(button=>{if(!button.contains(event.target)&&!$(button.getAttribute('aria-controls')).contains(event.target))closeHelp(button);});});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const open=helpButtons.find(b=>b.getAttribute('aria-expanded')==='true');if(open){closeHelp(open,true);event.preventDefault();}}});

  $('kdImageFile').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';uploadImage(f)});
  $('kdVideoFile').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';uploadVideo(f)});
  $('kdVideoRetry').addEventListener('click',()=>{confirmVideo()});
  $('kdLength').addEventListener('change',e=>{changeLength(e.target.value)});
  $('kdVideoRemove').addEventListener('click',removeVideo);
  $('kdImageRemove').addEventListener('click',removeImage);
  $('kdRights').addEventListener('change',render);
  $('kdCreate').addEventListener('click',submit);

  window.flowvidDanceKling={state,access,estimate,render};
  render();
  loadAccess();
})();
