'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {ContractError}=require('./core');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Read only the first-party approval form; never coerce nested/duplicate values.
async function readApprovalBody(req){
 let body;
 if(req.readable===false&&req.body!==undefined){
  body=req.body;
  if(body&&typeof body==='object'&&!Buffer.isBuffer(body)){
   if(Array.isArray(body)||![Object.prototype,null].includes(Object.getPrototypeOf(body)))throw new Error('invalid_form');
   const entries=Object.entries(body);
   if(entries.some(([k,v])=>!['proposal_id','fingerprint','max_credits','csrf','decision'].includes(k)||typeof v!=='string'))throw new Error('invalid_form');
   body=new URLSearchParams(entries).toString();
  }
  if(typeof body!=='string'&&!Buffer.isBuffer(body))throw new Error('invalid_form');
  if(Buffer.byteLength(body)>4096)throw new Error('too_large');
 }else{
  let size=0;const chunks=[];for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>4096)throw new Error('too_large');chunks.push(b);}body=Buffer.concat(chunks);
 }
 return body.toString();
}
// Separate browser-session adapter. MCP Authorization headers are NOT sessions.
function createApprovalUI({core,resolveBrowserSession,csrfKey,origin,path='/approve',now=Date.now}){
 if(!Buffer.isBuffer(csrfKey)||csrfKey.length<32||typeof resolveBrowserSession!=='function')throw new Error('Approval dependencies required');
 const canonical=new URL(origin).origin;
 const mac=(session,q)=>createHmac('sha256',csrfKey).update(JSON.stringify(['pina-ui-v1',session.id,session.userId,q.id,q.fingerprint,q.credits,q.expiresAt])).digest('hex');
 const response=(status,body)=>({status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'},body});
 return async request=>{
  try{
   if(!['GET','POST'].includes(request.method))return response(405,'Method not allowed');
   const session=await resolveBrowserSession(request);
   if(!session||!session.id||!session.userId||!Number.isFinite(session.expiresAt)||session.expiresAt<=now()||!session.context)throw new ContractError('unauthenticated');
   const url=new URL(request.url,canonical);
   if(url.origin!==canonical||url.pathname!==path)throw new ContractError('invalid_request');
   if(request.method==='POST'&&(request.headers.origin!==canonical||request.headers['sec-fetch-site']==='cross-site'||request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'))throw new ContractError('csrf_rejected');
   const params=request.method==='POST'?new URLSearchParams(request.body):url.searchParams;
   if(request.method==='POST'&&(['proposal_id','fingerprint','max_credits','csrf','decision'].some(k=>params.getAll(k).length!==1)||[...params.keys()].some(k=>!['proposal_id','fingerprint','max_credits','csrf','decision'].includes(k))))throw new ContractError('invalid_request');
   const q=await core.approvalView(params.get('proposal_id'),session.context);
   if(q.userId!==session.userId)throw new ContractError('account_mismatch');
   const csrf=mac(session,q);
   if(request.method==='GET'){
    const details=Object.entries({...q.input,credits:q.credits,watermark:q.watermarkRequired,expires_at:new Date(q.expiresAt).toISOString()}).map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('');
    return response(200,`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Pina 生成承認</title><h1>生成内容を確認</h1><p>アカウント: ${escape(q.userId)}</p><dl>${details}</dl><form method="post" action="${escape(path)}"><input type="hidden" name="proposal_id" value="${escape(q.id)}"><input type="hidden" name="fingerprint" value="${escape(q.fingerprint)}"><input type="hidden" name="max_credits" value="${q.credits}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">${q.credits} クレジットまでの生成を承認</button></form><p>承認だけでは生成を開始しません。ChatGPTへ戻って開始してください。</p></html>`);
   }
   const given=params.get('csrf');
   if(!/^[a-f0-9]{64}$/.test(given||'')||!timingSafeEqual(Buffer.from(given,'hex'),Buffer.from(csrf,'hex')))throw new ContractError('csrf_rejected');
   if(params.get('decision')!=='approve'||params.get('fingerprint')!==q.fingerprint||params.get('max_credits')!==String(q.credits))throw new ContractError('proposal_changed');
   session.context.approvalSessionId=session.id;
   await core.approveProposal(q.id,q.fingerprint,session.context);
   return response(200,'<!doctype html><html lang="ja"><meta charset="utf-8"><title>承認済み</title><h1>承認しました</h1><p>ChatGPTへ戻って生成を開始できます。</p></html>');
  }catch(error){return response(error.code==='unauthenticated'?401:403,escape(error instanceof ContractError?error.code:'approval_unavailable'));}
 };
}
module.exports={createApprovalUI,readApprovalBody};
