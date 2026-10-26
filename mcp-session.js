(function(){
 const next=new URLSearchParams(location.search).get('next')||'';
 const valid=/^\/interaction\/[A-Za-z0-9_-]+$/.test(next)||/^\/mcp\/approve\?proposal_id=[A-Za-z0-9_%.-]+$/.test(next);
 const message=document.getElementById('message'),button=document.getElementById('continue');
 if(!valid){message.textContent='接続元の承認リンクから開き直してください。';button.disabled=true;return;}
 button.onclick=async()=>{button.disabled=true;try{const c=window.FLOWVID_AUTH||{};if(!window.supabase||!window.FlowVidAuthGuard||!c.supabaseUrl||!c.supabaseAnonKey)throw Error();const client=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);const result=await window.FlowVidAuthGuard.verify(client);if(result.state!=='confirmed'){message.textContent='Pinaへのログインを確認できません。ログイン後にもう一度お試しください。';return;}const response=await fetch('/mcp/browser-session',{method:'POST',headers:{Authorization:'Bearer '+result.token},credentials:'same-origin',redirect:'error'});if(!response.ok)throw Error();location.replace(next);}catch{message.textContent='本人確認を完了できませんでした。時間をおいて再確認してください。';}finally{button.disabled=false;}};
})();
