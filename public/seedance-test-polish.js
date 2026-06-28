(function(){
  function addStyle(){
    if(document.getElementById('seedanceTestPolish')) return;
    const style=document.createElement('style');
    style.id='seedanceTestPolish';
    style.textContent=`
      body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Hiragino Sans','Noto Sans JP',system-ui,sans-serif!important;}
      .urlList{display:none!important;}
      #imageUrl{display:none!important;}
      .upload{border-style:solid!important;border-color:rgba(255,255,255,.12)!important;background:#0f1118!important;}
      .previews{grid-template-columns:repeat(3,1fr)!important;gap:10px!important;}
      .previewItem{position:relative;border-radius:18px!important;background:#080a10!important;border:1px solid rgba(255,255,255,.12)!important;min-height:132px;}
      .previewItem img{height:132px!important;object-fit:cover!important;}
      .previewItem small{position:absolute;left:8px;bottom:8px;right:auto!important;display:inline-flex!important;background:rgba(0,0,0,.64)!important;color:#fff!important;border-radius:999px!important;padding:5px 8px!important;font-size:12px!important;font-weight:800!important;max-width:calc(100% - 16px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .previewItem.is-unused{opacity:.38;filter:grayscale(.8);}
      .previewItem.is-unused:after{content:'未使用';position:absolute;right:8px;top:8px;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:4px 7px;font-size:10px;font-weight:800;color:#ddd;}
      .previewItem.is-active:before{content:'使用中';position:absolute;right:8px;top:8px;background:rgba(134,239,172,.16);border:1px solid rgba(134,239,172,.35);border-radius:999px;padding:4px 7px;font-size:10px;font-weight:800;color:#dcfce7;z-index:3;}
      .previewItem.is-main:before{content:'最初のフレーム';position:absolute;right:8px;top:8px;background:rgba(147,197,253,.16);border:1px solid rgba(147,197,253,.35);border-radius:999px;padding:4px 7px;font-size:10px;font-weight:800;color:#dbeafe;z-index:3;}
      .imageUseInfo{margin:10px 0 0;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.72);font-size:12px;line-height:1.5;font-weight:700;}
      .meta{word-break:normal!important;color:rgba(255,255,255,.7)!important;}
      @media(max-width:430px){.previews{grid-template-columns:repeat(3,1fr)!important}.previewItem img{height:106px!important}.previewItem{min-height:106px}.previewItem small{font-size:11px!important}}
    `;
    document.head.appendChild(style);
  }
  function ensureInfo(){
    let el=document.getElementById('imageUseInfo');
    if(el) return el;
    el=document.createElement('div');
    el.id='imageUseInfo';
    el.className='imageUseInfo';
    const previews=document.getElementById('previews');
    if(previews) previews.insertAdjacentElement('beforebegin',el);
    return el;
  }
  function getMode(){
    return document.getElementById('imageBtn')?.classList.contains('active')?'image':'reference';
  }
  function updateUseState(){
    const mode=getMode();
    const items=Array.from(document.querySelectorAll('.previewItem'));
    const info=ensureInfo();
    items.forEach((item,index)=>{
      item.classList.remove('is-active','is-unused','is-main');
      if(mode==='image'){
        if(index===0)item.classList.add('is-main');
        else item.classList.add('is-unused');
      }else{
        item.classList.add('is-active');
      }
      const small=item.querySelector('small');
      if(small){
        const name=(small.textContent||'').replace(/^\d+\.\s*/,'').trim();
        small.textContent='図'+(index+1)+(name?'｜'+name:'');
      }
    });
    if(!items.length){
      info.textContent=mode==='image'?'画像から動画：画像を1枚アップロードしてください。':'リファレンス：最大5枚まで画像を使えます。';
    }else if(mode==='image'){
      info.textContent='画像から動画：図1だけを最初のフレームとして使います。図2以降は使いません。';
    }else{
      info.textContent='リファレンス：表示中の画像をまとめて参考画像として使います。';
    }
  }
  function hook(){
    addStyle();
    ensureInfo();
    ['referenceBtn','imageBtn'].forEach(id=>{
      const btn=document.getElementById(id);
      if(btn&&!btn.dataset.polished){
        btn.dataset.polished='1';
        btn.addEventListener('click',()=>setTimeout(updateUseState,50));
      }
    });
    const previews=document.getElementById('previews');
    if(previews&&!previews.dataset.polished){
      previews.dataset.polished='1';
      new MutationObserver(()=>setTimeout(updateUseState,50)).observe(previews,{childList:true,subtree:true});
    }
    updateUseState();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hook);else hook();
})();