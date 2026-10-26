'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {generateKeyPairSync,sign}=require('node:crypto');
const {createAuthenticator}=require('../identity');
const {createJwksVerifier}=require('../jwks-verifier');
const {createExistingApiBackend}=require('../existing-api-backend');
const root=path.resolve(__dirname,'../..');
// Ephemeral, meaningless test-only signing material; not a configured credential.
function issuerFixture(){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'dummy',alg:'RS256',use:'sig'};
 const issuer='https://issuer.example.invalid',audience='https://pina.example.invalid/mcp';
 const mint=(claims={},header={})=>{const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const s=encode({alg:'RS256',typ:'at+jwt',kid:'dummy',...header})+'.'+encode({iss:issuer,aud:audience,sub:'user-a',exp:Math.floor(Date.now()/1000)+3600,scope:'credits:read generation:read generation:write',...claims});return s+'.'+sign('RSA-SHA256',Buffer.from(s),privateKey).toString('base64url');};
 const verifyToken=createJwksVerifier({loadJwks:async()=>({keys:[jwk]})});
 const authenticate=createAuthenticator({issuer,audience,verifyToken,resolveIdentity:async({subject})=>['user-a','user-b'].includes(subject)?{userId:subject,emailConfirmed:true,accountStatus:'active'}:null});
 return {issuer,audience,mint,authenticate,jwk};
}
function load(file,overrides){
 const filename=path.join(root,file),req=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:p=>Object.hasOwn(overrides,p)?overrides[p]:req(p),process:{env:{SUPABASE_URL:'https://db.example.invalid',SUPABASE_SERVICE_ROLE_KEY:'dummy-not-a-credential',OPENROUTER_API_KEY:'dummy-not-a-credential',WAVESPEED_API_KEY:'dummy-not-a-credential'}},fetch:overrides.fetch,console:{log(){},warn(){},error(){}},URL,Buffer,setTimeout,clearTimeout,AbortController,Response},{filename});
 return module.exports;
}
function apiFixture(externalDb){
 const counters={auth:0,moderation:0,reserve:0,deduct:0,provider:0,refund:0,poll:0,watermark:0};
 const tasks=new Map();let stopped=false,policyBlock=false,timeout=false,providerState='processing';
 const row={free_credits:10000,subscription_credits:0,purchased_credits:0,subscription_expires_at:null,purchased_expires_at:null};
 const mockDb={auth:{async getUser(token){counters.auth++;return token==='pina-test-session'?{data:{user:{id:'user-a',email_confirmed_at:'2026-01-01'}}}:{error:{name:'AuthApiError',code:'bad_jwt'}};}},
 from(table){let filters={},updates=null;const chain={select(){return chain},eq(k,v){filters[k]=v;return chain},is(){return chain},in(k,v){filters[k]=v;return chain},order(){return chain},single(){return Promise.resolve(result(true))},limit(){return chain},update(v){updates=v;return chain},insert(){return chain},async maybeSingle(){return result(true)},then(a,b){return Promise.resolve(result(false)).then(a,b)}};
 function result(single){let data;
 if(table==='profiles')data={plan:'free',account_status:'active'};
 else if(table==='credit_balances')data={...row};
 else if(table==='service_controls')data={enabled:!stopped};
 else if(table==='generation_tasks'){data=[...tasks.values()].find(t=>Object.entries(filters).every(([k,v])=>Array.isArray(v)?v.includes(t[k]):t[k]===v));if(data&&updates)Object.assign(data,updates);if(!single)data=data?[{id:data.id}]:[];}
 else data=null;
 return {data,error:null};}return chain;
 },async rpc(name,args){
 if(name==='reserve_generation_task'){counters.reserve++;const id='00000000-0000-4000-8000-'+String(counters.reserve).padStart(12,'0');tasks.set(id,{id,user_id:args.p_user_id,status:'queued',settings:{},credit_cost:args.p_credit_cost});return {data:[{task_id:id}],error:null};}
 if(name==='deduct_generation_credits_atomic'){counters.deduct++;row.free_credits-=args.p_credit_cost;return {data:{ok:true,new_balance:row.free_credits,from_free:args.p_credit_cost},error:null};}
 if(name==='refund_generation_task_atomic'){const t=tasks.get(args.p_task_id);if(t.status!=='failed'){counters.refund++;row.free_credits+=t.credit_cost;t.status='failed';}return {data:{ok:true,code:'refunded'},error:null};}
 throw new Error('Unexpected RPC '+name);
 }};
 const db=externalDb||mockDb;
 db.storage={from:()=>({upload:async()=>({error:null}),getPublicUrl:p=>({data:{publicUrl:'https://storage.example.invalid/storage/v1/object/public/test/'+p}}),remove:async()=>({error:null})})};
 const confirmedAuth=load('api/_lib/confirmed-auth.js',{'@supabase/supabase-js':{createClient:()=>db}}).requireConfirmedAuth;
 const coreHandler=load('api/_lib/seedance-start.js',{'@supabase/supabase-js':{createClient:()=>db},'./confirmed-auth.js':{requireConfirmedAuth:confirmedAuth},'./openai-moderation.js':{moderateContent:async()=>{counters.moderation++;return {ok:true,flagged:policyBlock,categories:policyBlock?['sexual']:[],results:[]};}},fetch:async()=>{counters.provider++;if(timeout)return new Promise(()=>{});return {ok:true,status:202,text:async()=>JSON.stringify({id:'dummy-provider-job',status:'queued'})};}});
 const startHandler=load('api/seedance-start-priced.js',{'./_lib/seedance-start.js':coreHandler});
 const statusHandler=load('api/seedance-status.js',{'@supabase/supabase-js':{createClient:()=>db},'./_lib/confirmed-auth.js':{requireConfirmedAuth:confirmedAuth},fetch:async(url,options={})=>{
  if(String(url).endsWith('/watermark')){counters.watermark++;return new Response(JSON.stringify({watermarkedUrl:'https://storage.example.invalid/watermarked.mp4'}),{status:200});}
  if(String(url).includes('/generation?'))return new Response('{}',{status:200});
  if(String(url).includes('/api/v1/videos/')){counters.poll++;return new Response(JSON.stringify({status:providerState,...(providerState==='completed'?{video_url:'https://provider.example.invalid/movie.mp4'}:{})}),{status:200});}
  return new Response(options.method==='HEAD'?null:Buffer.alloc(2048),{status:200,headers:{'content-type':'video/mp4','content-length':'2048'}});
 }});
 const backend=createExistingApiBackend({resolvePinaSession:async userId=>({userId,accessToken:'pina-test-session'}),confirmedAuth,startHandler,statusHandler,timeoutMs:100});
 return {backend,db,counters,tasks,row,complete:()=>{providerState='completed'},fail:()=>{providerState='failed'},stop:()=>{stopped=true},block:()=>{policyBlock=true},timeout:()=>{timeout=true},startHandler,statusHandler,confirmedAuth,startModule:coreHandler,statusModule:statusHandler,pricedModule:startHandler};
}
module.exports={issuerFixture,apiFixture};
