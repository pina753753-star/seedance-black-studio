// First-party interaction adapter; cannot be invoked through an MCP tool.
export function createBrokerInteraction({provider,origin,clientId,resource,verifyPinaBrowserSession,issueCsrf,verifyCsrf}){
 if(!provider||new URL(origin).origin!==origin||!clientId||!resource||[verifyPinaBrowserSession,issueCsrf,verifyCsrf].some(f=>typeof f!=='function'))throw new Error('Trusted first-party adapters required');
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return async(req,res)=>{
  const reject=()=>{res.writeHead(403,{'Cache-Control':'no-store'});res.end('interaction_denied');};
  try{
   const user=await verifyPinaBrowserSession(req);
   if(!user?.userId||!user.emailConfirmed||user.accountStatus!=='active')return reject();
   const d=await provider.interactionDetails(req,res);
   if(d.params.client_id!==clientId||d.params.resource!==resource||d.session?.accountId&&d.session.accountId!==user.userId)return reject();
   const binding={interactionId:d.uid,userId:user.userId};
   if(req.method==='GET'){
    const csrf=await issueCsrf(binding,user);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});
    res.end(`<p>接続するアカウント: ${escape(user.email||user.userId)}</p><p><a href="/mcp-session.html?next=${encodeURIComponent('/interaction/'+d.uid)}">別のアカウントで本人確認し直す</a></p><form method="post"><p>Pinaの残高、見積、本人承認後の生成、状態と成果物への接続を許可します。動画の開始承認は別途必要です。</p><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="allow">接続を許可</button><button name="decision" value="deny">キャンセル</button></form>`);return;
   }
   if(req.method!=='POST'||req.headers.origin!==origin||!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return reject();
   let body='';for await(const c of req){body+=c;if(body.length>4096)return reject();}
   const fields=new URLSearchParams(body);
   if(fields.getAll('csrf').length!==1||fields.getAll('decision').length!==1||![...fields.keys()].every(k=>['csrf','decision'].includes(k))||!await verifyCsrf(fields.get('csrf'),binding,user))return reject();
   if(fields.get('decision')==='deny')return provider.interactionFinished(req,res,{error:'access_denied'},{mergeWithLastSubmission:false});
   if(fields.get('decision')!=='allow')return reject();
   const grant=new provider.Grant({accountId:user.userId,clientId});
   const allowed=['credits:read','generation:read','generation:write'];
   const scopes=String(d.params.scope||'').split(' ').filter(Boolean);
   if(scopes.some(x=>!allowed.includes(x)&&!['openid','offline_access'].includes(x)))return reject();
   grant.addResourceScope(resource,scopes.filter(x=>allowed.includes(x)).join(' '));
   grant.addOIDCScope(scopes.filter(x=>['openid','offline_access'].includes(x)).join(' '));
   const grantId=await grant.save();
   return provider.interactionFinished(req,res,{login:{accountId:user.userId},consent:{grantId}},{mergeWithLastSubmission:false});
  }catch{return reject();}
 };
}
