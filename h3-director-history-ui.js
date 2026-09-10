(function(){
  'use strict';

  if(!/\/h3-director\.html(?:$|[?#])/.test(location.pathname+location.search))return;

  var supabaseClient=typeof window.flowvidSupabaseClient==='function'?window.flowvidSupabaseClient():null;
  var overlay=null;
  var player=null;

  // H3 Max Live本体は最初に video/mp4;codecs=h264,aac を試すが、
  // Safari系では「video/mp4」や avc1/mp4a だけを対応形式として返す場合がある。
  // このページだけで MediaRecorder を薄く包み、ブラウザが実際に対応している
  // MP4形式が1つでもあれば、それを本体の最優先候補として使わせる。
  // MP4非対応端末では一切偽装せず、従来どおりWebM候補へフォールバックする。
  function installMp4RecorderCompatibility(){
    var NativeMediaRecorder=window.MediaRecorder;
    if(!NativeMediaRecorder||NativeMediaRecorder.__h3Mp4Compat)return;
    if(typeof NativeMediaRecorder.isTypeSupported!=='function')return;

    var mp4Candidates=[
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4'
    ];
    var supportedMp4='';
    for(var i=0;i<mp4Candidates.length;i++){
      try{
        if(NativeMediaRecorder.isTypeSupported(mp4Candidates[i])){
          supportedMp4=mp4Candidates[i];
          break;
        }
      }catch(e){}
    }
    if(!supportedMp4)return;

    function H3MediaRecorder(stream,options){
      var opts=options;
      if(options&&options.mimeType==='video/mp4;codecs=h264,aac'&&supportedMp4!==options.mimeType){
        opts=Object.assign({},options,{mimeType:supportedMp4});
      }
      return new NativeMediaRecorder(stream,opts);
    }

    try{Object.setPrototypeOf(H3MediaRecorder,NativeMediaRecorder)}catch(e){}
    H3MediaRecorder.prototype=NativeMediaRecorder.prototype;
    H3MediaRecorder.isTypeSupported=function(type){
      if(type==='video/mp4;codecs=h264,aac')return true;
      return NativeMediaRecorder.isTypeSupported(type);
    };
    H3MediaRecorder.__h3Mp4Compat=true;
    H3MediaRecorder.__h3SupportedMp4=supportedMp4;
    window.MediaRecorder=H3MediaRecorder;
  }

  installMp4RecorderCompatibility();

  async function authToken(){
    if(!supabaseClient)return'';
    try{
      var result=await supabaseClient.auth.getSession();
      return result&&result.data&&result.data.session&&result.data.session.access_token||'';
    }catch(e){
      return'';
    }
  }

  function showNotice(text){
    var notice=document.getElementById('notice');
    if(!notice)return;
    notice.textContent=text;
    notice.classList.add('show');
    setTimeout(function(){notice.classList.remove('show')},5000);
  }

  async function recordingInfo(sessionId){
    var token=await authToken();
    if(!token)throw new Error('ログインが必要です。');
    var response=await fetch(
      '/api/h3-director/recording-url?sessionId='+encodeURIComponent(sessionId),
      {method:'GET',cache:'no-store',headers:{Authorization:'Bearer '+token}}
    );
    var data={};
    try{data=await response.json()}catch(e){}
    if(!response.ok)throw new Error(data.message||data.error||'録画を取得できませんでした。');
    return data;
  }

  function ensureOverlay(){
    if(overlay&&player)return overlay;

    var style=document.createElement('style');
    style.id='h3-director-history-player-style';
    style.textContent=[
      'body.h3-history-open{overflow:hidden!important}',
      '.h3-history-player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:100000;background:#000;display:none;overflow:hidden;overscroll-behavior:none}',
      '.h3-history-player.show{display:flex!important;align-items:center;justify-content:center}',
      '.h3-history-player video{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;display:block!important;object-fit:contain!important;background:#000!important}',
      '.h3-history-close{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));left:14px;z-index:100001;width:42px;height:42px;border:0;border-radius:50%;background:rgba(50,50,50,.78);color:#fff;font-size:24px;line-height:1;display:grid;place-items:center;-webkit-tap-highlight-color:transparent;touch-action:manipulation}'
    ].join('');
    document.head.appendChild(style);

    overlay=document.createElement('div');
    overlay.id='h3HistoryPlayer';
    overlay.className='h3-history-player';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    overlay.setAttribute('aria-label','保存動画の再生');
    overlay.innerHTML='<video id="h3HistoryVideo" playsinline webkit-playsinline controls preload="metadata"></video><button type="button" class="h3-history-close" aria-label="閉じる">×</button>';
    document.body.appendChild(overlay);
    player=overlay.querySelector('video');

    overlay.querySelector('.h3-history-close').addEventListener('click',function(event){
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    });

    player.addEventListener('error',function(){
      showNotice('保存した動画を再生できませんでした。');
    });

    return overlay;
  }

  function closeOverlay(){
    if(!overlay||!player)return;
    try{player.pause()}catch(e){}
    player.removeAttribute('src');
    try{player.load()}catch(e){}
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden','true');
    document.body.classList.remove('h3-history-open');
  }

  async function playRecording(sessionId){
    if(document.body.classList.contains('live-mode')){
      showNotice('ライブ終了後に履歴を再生できます。');
      return;
    }

    try{
      var info=await recordingInfo(sessionId);
      ensureOverlay();
      try{player.pause()}catch(e){}
      player.removeAttribute('src');
      try{player.load()}catch(e){}
      player.src=info.url;
      player.setAttribute('playsinline','');
      player.setAttribute('webkit-playsinline','');
      player.controls=true;
      document.body.classList.add('h3-history-open');
      overlay.classList.add('show');
      overlay.removeAttribute('aria-hidden');
      try{player.load()}catch(e){}

      // iPhone/Safariでは履歴ボタン押下直後のplay()がネイティブ全画面へ
      // 移行してページ状態を崩すことがあるため、自動再生はしない。
      // controlsを常時表示し、ユーザーの明示タップで再生する。
      showNotice('再生ボタンを押してください。');
    }catch(e){
      showNotice(e&&e.message?e.message:'保存した動画を再生できませんでした。');
    }
  }

  async function saveRecordingFile(sessionId,button){
    var originalText=button?button.textContent:'保存';
    if(button){button.disabled=true;button.textContent='保存中…'}

    try{
      var info=await recordingInfo(sessionId);
      var response=await fetch(info.url,{cache:'no-store'});
      if(!response.ok)throw new Error('録画ファイルを取得できませんでした。');
      var blob=await response.blob();
      if(!blob||!blob.size)throw new Error('録画ファイルが空です。');

      var blobUrl=URL.createObjectURL(blob);
      var anchor=document.createElement('a');
      anchor.href=blobUrl;
      anchor.download=info.filename||('h3-director-'+sessionId+(blob.type==='video/mp4'?'.mp4':'.webm'));
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(function(){
        try{URL.revokeObjectURL(blobUrl)}catch(e){}
        anchor.remove();
      },1500);

      if(button)button.textContent='保存済み';
      setTimeout(function(){
        if(button){button.textContent=originalText;button.disabled=false}
      },1600);
    }catch(e){
      if(button){button.textContent=originalText;button.disabled=false}
      showNotice(e&&e.message?e.message:'保存できませんでした。');
    }
  }

  document.addEventListener('click',function(event){
    var playButton=event.target&&event.target.closest?event.target.closest('[data-play]'):null;
    if(playButton){
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      playRecording(playButton.dataset.play||'');
      return;
    }

    var saveButton=event.target&&event.target.closest?event.target.closest('[data-save]'):null;
    if(saveButton){
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      saveRecordingFile(saveButton.dataset.save||'',saveButton);
    }
  },true);

  window.addEventListener('pagehide',closeOverlay);
})();
