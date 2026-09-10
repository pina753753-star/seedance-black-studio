(function(){
  'use strict';

  if(!/\/h3-director\.html(?:$|[?#])/.test(location.pathname+location.search))return;

  var supabaseClient=typeof window.flowvidSupabaseClient==='function'?window.flowvidSupabaseClient():null;

  // H3 Max Live本体は最初に video/mp4;codecs=h264,aac を試すが、
  // Safari系では「video/mp4」や avc1/mp4a だけを対応形式として返す場合がある。
  // MP4対応端末では、その端末が実際に対応しているMP4形式へ安全に読み替える。
  // MP4非対応端末では何も変更せず、本体のWebM候補へフォールバックする。
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

  function installHistoryStyle(){
    if(document.getElementById('h3-director-history-inline-style'))return;
    var style=document.createElement('style');
    style.id='h3-director-history-inline-style';
    style.textContent=[
      '#history{display:grid;gap:10px}',
      '#history .history-item{display:grid;gap:8px;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#070708;overflow:hidden}',
      '#history .history-item>p{margin:0;color:#d5d5da;font-size:11.5px;line-height:1.5;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
      '#history .history-item>small{display:block;color:#777;font-size:10px;line-height:1.45}',
      '#history .h3-history-video-frame{position:relative;width:100%;aspect-ratio:16/9;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;background:#000;display:grid;place-items:center}',
      '#history .h3-history-video-frame.portrait{aspect-ratio:9/16;max-height:320px;justify-self:start;width:auto;min-width:180px}',
      '#history .h3-history-video-frame video{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;object-fit:contain!important;background:#000;display:none}',
      '#history .h3-history-video-frame.ready video{display:block}',
      '#history .h3-history-video-placeholder{position:absolute;inset:0;display:grid;place-items:center;color:#777;font-size:10.5px;letter-spacing:.03em;pointer-events:none}',
      '#history .h3-history-video-frame.ready .h3-history-video-placeholder{display:none}',
      '#history .h3-history-actions{display:flex;gap:7px}',
      '#history .h3-history-actions button{flex:1;min-height:36px;margin:0;padding:7px 10px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:#151519;color:#eee;font-size:10.5px;font-weight:700}',
      '#history .h3-history-actions button:disabled{opacity:.5}',
      '@media(max-width:520px){#history .history-item{padding:9px}#history .h3-history-video-frame.portrait{max-height:280px;min-width:158px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function stopOtherHistoryVideos(except){
    document.querySelectorAll('#history .h3-history-video-frame video').forEach(function(video){
      if(video===except)return;
      try{video.pause()}catch(e){}
      var item=video.closest('.history-item');
      var button=item&&item.querySelector('[data-play]');
      if(button&&!button.disabled)button.textContent='再生';
    });
  }

  function enhanceHistoryItem(item){
    if(!item||item.dataset.h3HistoryEnhanced==='1')return;
    var playButton=item.querySelector('[data-play]');
    var saveButton=item.querySelector('[data-save]');
    if(!playButton&&!saveButton)return;

    item.dataset.h3HistoryEnhanced='1';
    var ratio=playButton&&playButton.dataset.ratio==='9:16'?'9:16':'16:9';
    var frame=document.createElement('div');
    frame.className='h3-history-video-frame'+(ratio==='9:16'?' portrait':'');
    frame.innerHTML='<video playsinline webkit-playsinline controls preload="metadata"></video><div class="h3-history-video-placeholder">再生するとここに表示されます</div>';

    var actionHost=(playButton&&playButton.parentElement)||(saveButton&&saveButton.parentElement);
    if(actionHost){
      actionHost.classList.add('h3-history-actions');
      item.insertBefore(frame,actionHost);
    }else{
      item.appendChild(frame);
    }

    var video=frame.querySelector('video');
    video.addEventListener('play',function(){
      stopOtherHistoryVideos(video);
      if(playButton)playButton.textContent='停止';
    });
    video.addEventListener('pause',function(){
      if(playButton&&!playButton.disabled)playButton.textContent='再生';
    });
    video.addEventListener('error',function(){
      frame.classList.remove('ready');
      if(playButton){playButton.disabled=false;playButton.textContent='再生'}
      showNotice('保存した動画を再生できませんでした。');
    });
  }

  function enhanceHistory(){
    installHistoryStyle();
    document.querySelectorAll('#history .history-item').forEach(enhanceHistoryItem);
  }

  async function playRecording(button){
    if(document.body.classList.contains('live-mode')){
      showNotice('ライブ終了後に履歴を再生できます。');
      return;
    }

    var item=button&&button.closest('.history-item');
    if(!item)return;
    enhanceHistoryItem(item);

    var frame=item.querySelector('.h3-history-video-frame');
    var video=frame&&frame.querySelector('video');
    if(!frame||!video)return;

    if(video.src){
      if(video.paused){
        stopOtherHistoryVideos(video);
        var replay;
        try{replay=video.play()}catch(e){replay=null}
        if(replay&&typeof replay.catch==='function')replay.catch(function(){showNotice('動画内の再生ボタンを押してください。')});
      }else{
        try{video.pause()}catch(e){}
      }
      return;
    }

    var originalText=button.textContent||'再生';
    button.disabled=true;
    button.textContent='読み込み中…';

    try{
      var info=await recordingInfo(button.dataset.play||'');
      stopOtherHistoryVideos(video);
      video.src=info.url;
      video.setAttribute('playsinline','');
      video.setAttribute('webkit-playsinline','');
      video.controls=true;
      frame.classList.add('ready');
      try{video.load()}catch(e){}
      button.disabled=false;
      button.textContent='再生';

      var firstPlay;
      try{firstPlay=video.play()}catch(e){firstPlay=null}
      if(firstPlay&&typeof firstPlay.catch==='function'){
        firstPlay.catch(function(){
          showNotice('動画内の再生ボタンを押してください。');
        });
      }
    }catch(e){
      button.disabled=false;
      button.textContent=originalText;
      frame.classList.remove('ready');
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
      playRecording(playButton);
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

  var historyRoot=document.getElementById('history');
  if(historyRoot){
    enhanceHistory();
    new MutationObserver(enhanceHistory).observe(historyRoot,{childList:true,subtree:true});
  }else if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',function(){
      historyRoot=document.getElementById('history');
      if(!historyRoot)return;
      enhanceHistory();
      new MutationObserver(enhanceHistory).observe(historyRoot,{childList:true,subtree:true});
    },{once:true});
  }
})();
