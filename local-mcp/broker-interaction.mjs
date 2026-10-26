import {errors} from 'oidc-provider';
// Vercel Node helpers may consume the IncomingMessage before invoking us.
// Match the provider's parsed-body fallback, but reject duplicates/non-scalars
// rather than flattening them. All normal CSRF and Origin checks still apply.
async function consentFields(req){
 let body;
 if(req.readable===false&&req.body!==undefined){
  body=req.body;
  if(body&&typeof body==='object'&&!Buffer.isBuffer(body)){
   if(Array.isArray(body)||![Object.prototype,null].includes(Object.getPrototypeOf(body)))throw new Error();
   const entries=Object.entries(body);
   if(entries.some(([k,v])=>!['csrf','decision'].includes(k)||typeof v!=='string'))throw new Error();
   body=new URLSearchParams(entries).toString();
  }
  if(typeof body!=='string'&&!Buffer.isBuffer(body))throw new Error();
  if(Buffer.byteLength(body)>4096)throw new Error();
 }else{
  const chunks=[];let size=0;
  for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>4096)throw new Error();chunks.push(b);}
  body=Buffer.concat(chunks);
 }
 return new URLSearchParams(body.toString());
}
// First-party interaction adapter; cannot be invoked through an MCP tool.
export function createBrokerInteraction({provider,origin,clientId,resource,verifyPinaBrowserSession,issueCsrf,verifyCsrf,diagnostic=()=>{}}){
 if(!provider||new URL(origin).origin!==origin||!clientId||!resource||[verifyPinaBrowserSession,issueCsrf,verifyCsrf].some(f=>typeof f!=='function'))throw new Error('Trusted first-party adapters required');
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return async(req,res)=>{
  // Koa rebuilds a context for each provider interaction API call. Preserve
  // this request's actual transport reference across asynchronous persistence;
  // serverless request cleanup may detach req.socket before the second call.
  // Only metadata APIs receive this view; never replace the original stream or
  // infer TLS/proxy facts from headers, another request, or a synthetic socket.
  const socket=req.socket;
  const providerRequest=new Proxy(req,{get(target,key){return key==='socket'?socket:Reflect.get(target,key,target);}});
  let stage='session';
  const report=code=>{try{diagnostic(code);}catch{}};
  const reject=()=>{
   // A failed redirect may already have committed headers. Never send a second
   // response or infer that the persisted grant was rolled back.
   if(res.headersSent||res.writableEnded){report('consent_response_failed');if(!res.writableEnded){try{res.end();}catch{}}return;}
   res.writeHead(403,{'Cache-Control':'no-store'});res.end('interaction_denied');
  };
  // Save through the public provider API, then require a same-tab user link.
  // A normal link starts a fresh navigation; do not broaden form-action CSP.
  const finish=async result=>{
   stage='finalize_result';
   const returnTo=await provider.interactionResult(providerRequest,res,result,{mergeWithLastSubmission:false});
   stage='finalize_response';
   const resume=new URL(returnTo,origin);
   if(resume.origin!==origin||resume.username||resume.password||resume.search||resume.hash||!/^\/mcp\/oauth\/auth\/[A-Za-z0-9_-]+$/.test(resume.pathname))throw new Error('invalid_resume');
   res.statusCode=200;
   for(const [key,value] of Object.entries({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}))res.setHeader(key,value);
   const message=result.error?'接続をキャンセルしました。ChatGPTへ戻って手続きを終了してください。':'同意を保存しました。ChatGPTでの接続はまだ完了していません。';
   res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>ChatGPTへ戻る</title><h1>接続手続きを続ける</h1><p>'+message+'</p><p><a href="'+escape(resume.pathname)+'">ChatGPTへ戻る</a></p><p>リンクは一度だけ押してください。期限切れの場合はChatGPTから接続手続きを開き直してください。</p></html>');
  };
  try{
   if(!socket||typeof socket!=='object')return reject();
   const user=await verifyPinaBrowserSession(req);
   if(!user?.userId||!user.emailConfirmed||user.accountStatus!=='active')return reject();
   stage='details';
   let d;
   try{d=await provider.interactionDetails(providerRequest,res);}catch(error){
    if(req.method==='GET'&&error instanceof errors.SessionNotFound){
     report('consent_details_missing');
     res.writeHead(403,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
     res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>接続手続きを確認してください</title><p>接続手続きの有効期限が切れたか、接続用Cookieを確認できませんでした。</p><p>Pinaに再ログインする必要はありません。ChatGPTに戻り、接続手続きを最初から開き直してください。</p></html>');return;
    }
    throw error;
   }
   stage='validation';
   if(d.params.client_id!==clientId||d.params.resource!==resource||d.session?.accountId&&d.session.accountId!==user.userId)return reject();
   const binding={interactionId:d.uid,userId:user.userId};
   if(req.method==='GET'){
    const csrf=await issueCsrf(binding,user);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});
    res.end(`<p>接続するアカウント: ${escape(user.email||user.userId)}</p><p><a href="/mcp-session.html?next=${encodeURIComponent('/interaction/'+d.uid)}">別のアカウントで本人確認し直す</a></p><form method="post"><p>Pinaの残高、見積、本人承認後の生成、状態と成果物への接続を許可します。動画の開始承認は別途必要です。</p><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="allow">接続を許可</button><button name="decision" value="deny">キャンセル</button></form>`);return;
   }
   if(req.method!=='POST'||req.headers.origin!==origin||!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return reject();
   stage='body';
   const fields=await consentFields(req);
   stage='csrf';
   if(fields.getAll('csrf').length!==1||fields.getAll('decision').length!==1||![...fields.keys()].every(k=>['csrf','decision'].includes(k))||!await verifyCsrf(fields.get('csrf'),binding,user))return reject();
   if(fields.get('decision')==='deny'){return await finish({error:'access_denied'});}
   if(fields.get('decision')!=='allow')return reject();
   const grant=new provider.Grant({accountId:user.userId,clientId});
   const allowed=['credits:read','generation:read','generation:write'];
   const scopes=String(d.params.scope||'').split(' ').filter(Boolean);
   if(scopes.some(x=>!allowed.includes(x)))return reject();
   grant.addResourceScope(resource,scopes.filter(x=>allowed.includes(x)).join(' '));
   grant.addOIDCScope(scopes.join(' '));
   stage='grant_save';
   const grantId=await grant.save();
   return await finish({login:{accountId:user.userId},consent:{grantId}});
  }catch(error){
   if(stage==='finalize_result'){
    const socket=req.socket==null?'missing':'present';
    const type=error instanceof TypeError?'type_error':error instanceof RangeError?'range_error':'other';
    report('consent_result_socket_'+socket+'_'+type);
   }
   report(['ERR_HTTP_HEADERS_SENT','ERR_INVALID_CHAR','ERR_HTTP_INVALID_HEADER_VALUE'].includes(error?.code)?'consent_response_failed':error instanceof errors.SessionNotFound&&['details','finalize_result'].includes(stage)?'consent_'+stage+'_missing':'consent_'+stage+'_failed');return reject();}
 };
}
