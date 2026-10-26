'use strict';
// Composition only. No environment reads, listener, external fetch, credential
// issuance or defaults. The host must explicitly supply its existing bindings.
const {createCore}=require('./core');
const {createPostgresStore}=require('./postgres-store');
const {createAuthenticator}=require('./identity');
const {createJwksVerifier}=require('./jwks-verifier');
const {createQuoteIntegrity}=require('./quote-integrity');
const {createApprovalUI}=require('./approval-ui');
const {createExistingApiBackend}=require('./existing-api-backend');
const {createMcpHttpHandler}=require('./sdk-transport');
function createLocalApp({query,issuer,resource,loadJwks,resolveIdentity,resolveBrowserSession,resolvePinaSession,confirmedAuth,startHandler,statusHandler,quoteKey,csrfKey,artifactHosts=[]}){
 const origin=new URL(resource).origin;
 const authenticate=createAuthenticator({issuer,audience:resource,verifyToken:createJwksVerifier({loadJwks}),resolveIdentity});
 const core=createCore({authenticate,store:createPostgresStore({query}),integrity:createQuoteIntegrity(quoteKey),backend:createExistingApiBackend({resolvePinaSession,confirmedAuth,startHandler,statusHandler}),artifactHosts,approvalBaseUrl:origin});
 const ui=createApprovalUI({core,resolveBrowserSession,csrfKey,origin});
 const mcp=createMcpHttpHandler({core,authenticate,resource,issuer});
 return async request=>{
  const url=new URL(request.url);
  if(url.pathname!=='/approve')return mcp(request);
  if(url.origin!==origin)return new Response('invalid_host',{status:400});
  // A bounded streaming read, not a trusted Content-Length check.
  let body='';
  if(request.body){const reader=request.body.getReader();let size=0;const chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return new Response('too_large',{status:413});}chunks.push(Buffer.from(value));}body=Buffer.concat(chunks).toString('utf8');}finally{reader.releaseLock();}}
  const result=await ui({method:request.method,url:request.url,headers:Object.fromEntries(request.headers),body});
  return new Response(result.body,{status:result.status,headers:result.headers});
 };
}
module.exports={createLocalApp};
