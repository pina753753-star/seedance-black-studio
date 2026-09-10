(function(){
  'use strict';

  if(!/\/h3-director\.html(?:$|[?#])/.test(location.pathname+location.search))return;

  var supabaseClient=typeof window.flowvidSupabaseClient==='function'?window.flowvidSupabaseClient():null;
  var overlay=null;
  var player=null;

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
      'body.h3-history-open{overflow:hidden}',
      '.h3-history-player{position:fixed;inset:0;z-index:100000;background:#000;display:none}',
      '.h3-history-player.show{display:block}',
      '.h3-history-player video{width:100vw;height:100dvh;display:block;object-fit:contain;background:#000}',
      '.h3-history-close{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:14px;z-index:100001;width:38px;height:38px;border:0;border-radius:50%;background:rgba(50,50,50,.72);color:#fff;font-size:22px;line-height:1;display:grid;place-items:center;-webkit-tap-highlight-color:transparent}'
    ].join('');
    document.head.appendChild(style);

    overlay=document.createElement('div');
    overlay.id='h3HistoryPlayer';
    overlay.className='h3-history-player';
    overlay.innerHTML='<video id="h3HistoryVideo" playsinline controls preload="metadata"></video><button type="button" class="h3-history-close" aria-label="閉じる">×</button>';
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
      document.body.classList.add('h3-history-open');
      overlay.classList.add('show');
      try{player.load()}catch(e){}
      var playPromise;
      try{playPromise=player.play()}catch(e){playPromise=null}
      if(playPromise&&typeof playPromise.catch==='function'){
        playPromise.catch(function(){
          showNotice('再生ボタンを押してください。');
        });
      }
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
