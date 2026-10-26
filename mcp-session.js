(function(){
 const next=window.PinaMcpReturn.single(location.search,'next');
 const valid=next!==null;
 const message=document.getElementById('message'),button=document.getElementById('continue');
 if(!valid){message.textContent='接続元の承認リンクから開き直してください。';button.disabled=true;return;}
 document.getElementById('login').href='/login.html?mcpNext='+encodeURIComponent(next);
 button.onclick=async()=>{button.disabled=true;try{const c=window.FLOWVID_AUTH||{};if(!window.supabase||!window.FlowVidAuthGuard||!c.supabaseUrl||!c.supabaseAnonKey)throw Error();const client=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);const result=await window.FlowVidAuthGuard.verify(client);if(result.state!=='confirmed'){message.textContent='Pinaへのログインを確認できません。ログイン後にもう一度お試しください。';return;}const response=await fetch('/mcp/browser-session',{method:'POST',headers:{Authorization:'Bearer '+result.token},credentials:'same-origin',redirect:'error'});if(!response.ok)throw Error();location.replace(next);}catch{message.textContent='本人確認を完了できませんでした。時間をおいて再確認してください。';}finally{button.disabled=false;}};
})();
