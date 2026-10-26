'use strict';
const {ContractError}=require('./core');
const {readSubscriptionAccess}=require('../api/_lib/credit-access');
const {getSeedance25Entitlement}=require('../api/_lib/video-plan-entitlements');
const {calculateVideoCreditCost}=require('../api/_lib/video-pricing');
// Wiring only. No bypass principal / service-role HTTP identity, pricing,
// reservation, balance deduction, provider or refund implementation here.
// resolvePinaSession must be an existing server-owned Pina session binding.
// MCP OAuth tokens are NEVER forwarded as Supabase tokens.
function createExistingApiBackend({resolvePinaSession,confirmedAuth,startHandler,statusHandler,resolveAccount,bindRequest,timeoutMs=30000}){
 if((typeof resolveAccount!=='function'&&(typeof resolvePinaSession!=='function'||typeof confirmedAuth!=='function'))||typeof startHandler!=='function'||typeof statusHandler!=='function')throw new Error('Explicit existing API bindings required');
 async function account(userId){
  if(resolveAccount){const auth=await resolveAccount(userId);if(!auth?.ok||auth.user?.id!==userId||!auth.supabase)throw new ContractError('account_mismatch');return {headers:{},db:auth.supabase,auth};}
  const session=await resolvePinaSession(userId);
  if(!session||session.userId!==userId||!session.accessToken)throw new ContractError('pina_session_required');
  const headers={authorization:'Bearer '+session.accessToken};
  const auth=await confirmedAuth({headers});
  if(!auth.ok||auth.user?.id!==userId||!auth.supabase)throw new ContractError('account_mismatch');
  return {headers,db:auth.supabase};
 }
 async function accessFor(userId,db){
  const base=await readSubscriptionAccess(db,userId);
  const extra=await getSeedance25Entitlement(db,userId);
  if(!base.ok||!extra.ok)throw new ContractError('access_unavailable');
  return {userId,allowed:base.accountStatus==='active',availableCredits:base.balance,watermarkRequired:base.watermarkRequired,models:['bytedance/seedance-2.0','bytedance/seedance-2.0-fast',...(extra.allowed?['bytedance/seedance-2.5-standard','bytedance/seedance-2.5']:[])]};
 }
 return {
  async readAccess(userId){const {db}=await account(userId);return accessFor(userId,db);},
  async start({userId,input,expectedCredits,watermarkRequired}){
   const {headers,db,auth}=await account(userId), a=await accessFor(userId,db);
   if(!a.allowed||!a.models.includes(input.model))throw new ContractError('feature_unavailable');
   if(calculateVideoCreditCost(input)!==expectedCredits||a.watermarkRequired!==watermarkRequired)throw new ContractError('requote_required');
   // Existing handler performs confirmed auth AGAIN, emergency stop,
   // moderation, entitlements, reservation, deduction, provider and refunds.
   const req={method:'POST',headers,body:{...input}};
   if(bindRequest)bindRequest(req,auth);
   let status=500,body;
   const res={status(n){status=n;return this;},json(v){body=v;return this;},setHeader(){}};
   let timer;
   try{await Promise.race([Promise.resolve().then(()=>startHandler(req,res)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('start_timeout')),timeoutMs);})]);}
   finally{clearTimeout(timer);}
   if(status!==202||body?.ok!==true||typeof body.taskId!=='string'||body.creditCost!==expectedCredits)throw new Error('Unconfirmed existing API start');
   // response provider polling URL is deliberately not exposed to the caller.
   return {userId,taskId:body.taskId};
  },
  async refreshSnapshot(userId,taskId){
   const {headers,db,auth}=await account(userId);
   const {data,error}=await db.from('generation_tasks').select('id,user_id,status,api_task_id').eq('id',taskId).eq('user_id',userId).maybeSingle();
   if(error||!data||data.user_id!==userId||data.id!==taskId)throw new ContractError('not_found');
   if(!data.api_task_id||['failed','cancelled'].includes(data.status))return this.readSnapshot(userId,taskId);
   let status=500,body,timer;
   const res={status(n){status=n;return this},json(v){body=v;return this},setHeader(){}};
   const req={method:'GET',headers,query:{id:data.api_task_id}};if(bindRequest)bindRequest(req,auth);
   try{await Promise.race([Promise.resolve().then(()=>statusHandler(req,res)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('status_timeout')),timeoutMs);})]);}
   finally{clearTimeout(timer);}
   if(status!==200)throw new ContractError('status_unavailable');
   const snapshot=await this.readSnapshot(userId,taskId);
   return {...snapshot,...(typeof body?.refunded==='boolean'?{refunded:body.refunded}:{})};
  },
  async readSnapshot(userId,taskId){
   const {db}=await account(userId);
   const {data,error}=await db.from('generation_tasks').select('id,user_id,status,settings,output_url,watermarked_url').eq('id',taskId).eq('user_id',userId).maybeSingle();
   if(error)throw new ContractError('snapshot_unavailable');
   if(!data||data.user_id!==userId||data.id!==taskId)return null;
   return {userId,taskId,status:data.status,settings:data.settings,outputUrl:data.output_url,watermarkedUrl:data.watermarked_url,watermarkComplete:!!data.watermarked_url};
  }
 };
}
module.exports={createExistingApiBackend};
