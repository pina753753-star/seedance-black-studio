import {errors} from 'oidc-provider';
export const CONNECTION_MAX_SECONDS=30*24*60*60;
export const REFRESH_IDLE_SECONDS=7*24*60*60;
// Only the explicitly registered MCP client may use persistent authorization.
// Existing stored exp values remain authoritative; never migrate/extend grants.
export function connectionPolicy(clientId){
 const now=()=>Math.floor(Date.now()/1000);
 const requireClient=token=>{if(token?.clientId!==clientId)throw new errors.InvalidGrant('Invalid client for connection policy');};
 return {
  grantTTL(_ctx,grant){
   requireClient(grant);const t=now();
   if(grant.exp!==undefined){if(!Number.isSafeInteger(grant.exp)||grant.exp<=t)throw new errors.InvalidGrant('Expired grant');return grant.exp-t;}
   const issued=grant.iat??t;
   if(!Number.isSafeInteger(issued)||issued<=0||issued>t||issued+CONNECTION_MAX_SECONDS<=t)throw new errors.InvalidGrant('Invalid grant lifetime');
   grant.iat=issued;grant.exp=issued+CONNECTION_MAX_SECONDS;
   return grant.exp-t;
  },
  refreshTTL(_ctx,token){
   requireClient(token);const t=now(),issued=token.iiat;
   if(!Number.isSafeInteger(issued)||issued<=0||issued>t||issued+CONNECTION_MAX_SECONDS<=t)throw new errors.InvalidGrant('Expired refresh lifetime');
   return Math.min(REFRESH_IDLE_SECONDS,issued+CONNECTION_MAX_SECONDS-t);
  },
  expiresWithSession(_ctx,source){return source?.clientId!==clientId;},
 };
}
