'use strict';
const {createExistingApiBackend}=require('./existing-api-backend');
const {isConfirmed}=require('../api/_lib/confirmed-auth');
// Private in-process requests only. No HTTP header or body can inject identity.
function createPrincipalBackend({db,startModule,statusModule,pricedModule,timeoutMs}){
 const identities=new WeakMap();
 const authenticate=async req=>identities.get(req)||{ok:false,status:401,body:{error:'UNAUTHORIZED'}};
 const resolveAccount=async userId=>{
  const {data,error}=await db.auth.admin.getUserById(userId);
  const user=data?.user;
  if(error||user?.id!==userId||!isConfirmed(user)||user.banned_until&&Date.parse(user.banned_until)>Date.now())return {ok:false};
  return {ok:true,user,supabase:db};
 };
 const startHandler=pricedModule.createHandler(startModule.createHandler(authenticate));
 const statusHandler=statusModule.createHandler(authenticate);
 return createExistingApiBackend({resolveAccount,bindRequest:(req,auth)=>identities.set(req,auth),startHandler,statusHandler,timeoutMs});
}
module.exports={createPrincipalBackend};
