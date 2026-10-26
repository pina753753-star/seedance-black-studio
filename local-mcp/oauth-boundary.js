'use strict';
// Local-only boundary. Not wired into production or a real OAuth issuer.
const {ContractError}=require('./core');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITIES=['credits:read','generation:read','generation:write'];
function createOAuthBoundary({issuer,audience,clientId,role,verifyToken,authorize,now=Date.now}={}){
 const https=v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
 if(!https(issuer)||!https(audience)||issuer===audience||!UUID.test(clientId||'')||typeof role!=='string'||!/^pina_mcp_[a-z_]+$/.test(role)||typeof verifyToken!=='function'||typeof authorize!=='function')throw new Error('Explicit isolated OAuth configuration required');
 const deny=()=>{throw new ContractError('unauthenticated');};
 return async context=>{
  try{
   if(typeof context?.accessToken!=='string'||!context.accessToken) return deny();
   const c=await verifyToken(context.accessToken),t=now();
   // Single exact audience: never accept a token also intended for authenticated.
   if(c?.iss!==issuer||c.aud!==audience||c.client_id!==clientId||c.role!==role||!UUID.test(c.sub||'')||!UUID.test(c.session_id||'')||!Number.isInteger(c.exp)||c.exp*1000<=t||!Number.isInteger(c.iat)||c.iat*1000>t||c.iat>=c.exp||(c.nbf!==undefined&&(!Number.isInteger(c.nbf)||c.nbf*1000>t)))return deny();
   // Fresh server read per request. Token scopes/user_metadata never grant capability.
   const g=await authorize({subject:c.sub,sessionId:c.session_id,clientId,issuer});
   if(!g||g.userId!==c.sub||g.sessionId!==c.session_id||g.clientId!==clientId||g.sessionActive!==true||g.consentActive!==true||g.grantActive!==true||g.emailConfirmed!==true||g.accountStatus!=='active'||!Number.isFinite(g.expiresAt)||g.expiresAt<=t||!Array.isArray(g.capabilities)||g.capabilities.some(x=>!CAPABILITIES.includes(x)))return deny();
   return {userId:c.sub,emailConfirmed:true,accountStatus:'active',expiresAt:Math.min(c.exp*1000,g.expiresAt),scopes:[...new Set(g.capabilities)]};
  }catch{return deny();}
 };
}
module.exports={createOAuthBoundary};
