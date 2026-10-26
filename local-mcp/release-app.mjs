import {createBroker,createOpaqueAuthenticator} from './broker.mjs';
import {createBrokerInteraction} from './broker-interaction.mjs';
import {createPostgresBrokerAdapter} from './broker-postgres.mjs';
import coreModule from './core.js';import quoteModule from './quote-integrity.js';
import ledgerModule from './postgres-store.js';import uiModule from './approval-ui.js';
import browserModule from './browser-session.js';import backendModule from './principal-backend.js';import sdkModule from './sdk-transport.js';
export function createReleaseApp({origin,clientId,redirectUri,db,confirmedAuth,startModule,statusModule,pricedModule,quoteKey,csrfKey,browserKey,storageKey,cookieKeys,jwks,artifactHosts,allowGeneration=false,timeoutMs=30000}){
 if(new URL(origin).origin!==origin||!artifactHosts?.length)throw new Error('Explicit origin and artifact hosts required');
 const issuer=origin+'/mcp/oauth',resource=origin+'/api/mcp';
 const rpc=(name,args)=>db.rpc(name,args);
 const Adapter=createPostgresBrokerAdapter({rpc,key:storageKey});
 const currentUser=async id=>{const {data,error}=await db.auth.admin.getUserById(id);const u=data?.user;if(error||u?.id!==id||!(u.email_confirmed_at||u.confirmed_at)||u.banned_until&&Date.parse(u.banned_until)>Date.now())return null;const p=await db.from('profiles').select('account_status').eq('id',id).maybeSingle();if(p.error||p.data?.account_status!=='active')return null;return u;};
 const provider=createBroker({issuer,resource,clientId,redirectUri,Adapter,cookieKeys,jwks,findAccount:async(ctx,id)=>await currentUser(id)?{accountId:id,claims:async()=>({sub:id})}:undefined});
 const opaque=createOpaqueAuthenticator({provider,resource,clientId,authorize:async({userId})=>await currentUser(userId)?{userId,active:true,emailConfirmed:true,accountStatus:'active',capabilities:['credits:read','generation:read','generation:write']}:null});
 const browser=browserModule.createBrowserSessions({confirmedAuth,db,key:browserKey,csrfKey,origin});
 const browserContexts=new WeakMap();
 const authenticate=context=>browserContexts.has(context)?Promise.resolve(browserContexts.get(context)):opaque(context);
 const query=async(sql,args)=>{if(sql!=='SELECT pina_mcp.dispatch($1::text,$2::jsonb) AS result')throw new Error('Invalid ledger query');const r=await rpc('pina_mcp_dispatch',{op:args[0],p:JSON.parse(args[1])});if(r.error)throw new Error('Ledger unavailable');return {rows:[{result:r.data}]};};
 const backend=backendModule.createPrincipalBackend({db,startModule,statusModule,pricedModule,timeoutMs});
 const core=coreModule.createCore({allowStart:allowGeneration,authenticate,store:ledgerModule.createPostgresStore({query}),integrity:quoteModule.createQuoteIntegrity(quoteKey),backend,artifactHosts,approvalBaseUrl:origin,approvalPath:'/mcp/approve'});
 const resolveBrowserSession=async req=>{const s=await browser.resolve(req),context={};browserContexts.set(context,{...s,scopes:['credits:read','generation:read','generation:write']});return {...s,context};};
 const ui=uiModule.createApprovalUI({core,resolveBrowserSession,csrfKey,origin,path:'/mcp/approve'});
 const interaction=createBrokerInteraction({provider,origin,clientId,resource,verifyPinaBrowserSession:browser.resolve,issueCsrf:browser.issueCsrf,verifyCsrf:browser.verifyCsrf});
 const mcp=sdkModule.createMcpHttpHandler({core,authenticate:opaque,resource,issuer});
 const callback=provider.callback();
 const send=(res,status,body,headers={})=>{res.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers});res.end(body);};
 const read=async req=>{let size=0;const chunks=[];for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>65536)throw new Error('too_large');chunks.push(b);}return Buffer.concat(chunks);};
 // Node request handler mount. No server/listener is created by this module.
 async function handler(req,res){
  try{
   const url=new URL(req.url,origin);if(url.origin!==origin||req.headers.host!==new URL(origin).host)return send(res,400,'invalid_host');
   if(url.pathname==='/mcp/browser-session'){
    const result=await browser.bootstrap(req);return send(res,204,'',{'Set-Cookie':result.cookie});
   }
   if(req.method==='GET'&&(url.pathname.startsWith('/interaction/')||url.pathname==='/mcp/approve')){try{await browser.resolve(req);}catch{return send(res,302,'',{'Location':'/mcp-session.html?next='+encodeURIComponent(url.pathname+url.search)});}}
   if(url.pathname.startsWith('/interaction/'))return await interaction(req,res);
   if(url.pathname==='/mcp/approve'){
    const r=await ui({method:req.method,url:url.href,headers:req.headers,body:(await read(req)).toString()});return send(res,r.status,r.body,r.headers);
   }
   if(['/.well-known/oauth-authorization-server/mcp/oauth','/.well-known/openid-configuration/mcp/oauth'].includes(url.pathname)){req.baseUrl='/mcp/oauth';req.originalUrl='/mcp/oauth/.well-known/openid-configuration';req.url='/.well-known/openid-configuration';return await callback(req,res);}
   if(url.pathname.startsWith('/mcp/oauth/')){
    // oidc-provider mounting: preserve originalUrl and expose the mount prefix.
    req.originalUrl=req.url;req.url=req.url.slice('/mcp/oauth'.length);return await callback(req,res);
   }
   if(url.pathname==='/api/mcp'||url.pathname.startsWith('/.well-known/oauth-protected-resource')){
    const body=['GET','HEAD'].includes(req.method)?undefined:await read(req);
    const response=await mcp(new Request(url,{method:req.method,headers:req.headers,body}));return send(res,response.status,Buffer.from(await response.arrayBuffer()),Object.fromEntries(response.headers));
   }
   return send(res,404,'not_found');
  }catch{return send(res,403,'request_denied');}
 }
 return {handler,provider,core};
}
