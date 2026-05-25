(function(){
  function cleanIndexSamples(){
    if(!/\/index\.html$|\/$/.test(location.pathname))return;
    document.querySelectorAll('.realVideo').forEach(el=>el.remove());
    document.querySelectorAll('.watermark,.sampleInfo').forEach(el=>el.remove());
  }

  function makeSaveLinksOpenable(){
    document.querySelectorAll('a').forEach(a=>{
      if((a.textContent||'').trim()==='保存' || a.hasAttribute('download')){
        if(a.href){
          a.removeAttribute('download');
          a.setAttribute('target','_blank');
          a.setAttribute('rel','noreferrer');
          a.style.pointerEvents='auto';
        }
      }
    });
  }

  function run(){
    cleanIndexSamples();
    makeSaveLinksOpenable();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
  setTimeout(run,500);
  setTimeout(run,1500);
  new MutationObserver(run).observe(document.documentElement,{childList:true,subtree:true});
})();
