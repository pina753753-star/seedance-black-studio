'use strict';
const {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHmac,timingSafeEqual}=require('node:crypto');
const {ContractError}=require('./core');
function createBrowserSessions({confirmedAuth,db,key,csrfKey,origin,now=Date.now}){
 if(typeof confirmedAuth!=='function'||!db||!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(csrfKey)||csrfKey.length!==32||new URL(origin).origin!==origin)throw new Error('Explicit browser bindings required');
 const cookieName='__Host-pina_mcp_browser';
 const seal=p=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(origin));return Buffer.concat([iv,c.update(JSON.stringify(p)),c.final(),c.getAuthTag()]).toString('base64url');};
 const unseal=s=>{const b=Buffer.from(s,'base64url');if(b.length>8192||b.length<30)throw new Error();const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(origin));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
 async function verify(token){
  if(typeof token!=='string'||token.length>8192||token.split('.').length!==3)throw new ContractError('unauthenticated');
  const auth=await confirmedAuth({headers:{authorization:'Bearer '+token}});
  if(!auth.ok||!auth.user?.id)throw new ContractError('unauthenticated');
  const {data,error}=await db.from('profiles').select('account_status').eq('id',auth.user.id).maybeSingle();
  if(error||data?.account_status!=='active'||auth.user.banned_until&&Date.parse(auth.user.banned_until)>now())throw new ContractError('account_restricted');
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
  if(!Number.isInteger(claims.exp)||claims.exp*1000<=now())throw new ContractError('unauthenticated');
  return {userId:auth.user.id,email:auth.user.email||null,emailConfirmed:true,accountStatus:'active',expiresAt:Math.min(claims.exp*1000,now()+900000)};
 }
 async function bootstrap(req){
  if(req.method!=='POST'||req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')throw new ContractError('csrf_rejected');
  const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');const user=await verify(token),id=randomUUID();
  const value=seal({id,userId:user.userId,token,expiresAt:user.expiresAt});
  return {cookie:`${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.floor((user.expiresAt-now())/1000))}`};
 }
 async function resolve(req){
  try{
   const matches=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));if(matches.length!==1)throw new Error();
   const session=unseal(matches[0].slice(cookieName.length+1));if(!session.id||session.expiresAt<=now())throw new Error();
   const user=await verify(session.token);if(user.userId!==session.userId)throw new Error();
   return {id:session.id,...user,expiresAt:Math.min(session.expiresAt,user.expiresAt)};
  }catch{throw new ContractError('unauthenticated');}
 }
 const csrf=(binding,session)=>createHmac('sha256',csrfKey).update(JSON.stringify(['broker-consent',binding.interactionId,binding.userId,session.id,session.expiresAt])).digest('hex');
 return {bootstrap,resolve,issueCsrf:csrf,verifyCsrf:(value,binding,session)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(csrf(binding,session),'hex'))};
}
module.exports={createBrowserSessions};
