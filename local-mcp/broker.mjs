import coreModule from './core.js';
import {Provider,errors} from 'oidc-provider';
// Local evaluation only: no default issuer, client, credentials, listener or store.
export function createBroker({issuer,resource,clientId,redirectUri,Adapter,cookieKeys,jwks,findAccount}){
 const url=v=>{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)throw new Error('Exact HTTPS URL required');return v;};
 url(issuer);url(resource);url(redirectUri);
 if(issuer===resource||!clientId||!Adapter||!cookieKeys?.length||!jwks?.keys?.length||typeof findAccount!=='function')throw new Error('Explicit broker configuration required');
 const provider=new Provider(issuer,{
  adapter:Adapter, cookies:{keys:cookieKeys},jwks,
  clients:[{client_id:clientId,redirect_uris:[redirectUri],response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'}],
  ttl:{Grant:3600,AccessToken:300,RefreshToken:3600,AuthorizationCode:60,Interaction:300,Session:3600},
  findAccount, pkce:{required:()=>true},scopes:['openid','offline_access'],rotateRefreshToken:true,
  issueRefreshToken:()=>true,
  features:{devInteractions:{enabled:false},userinfo:{enabled:false},revocation:{enabled:true,allowedPolicy:async(ctx,client,token)=>client.clientId===clientId&&token.clientId===clientId},resourceIndicators:{enabled:true,defaultResource:()=>resource,useGrantedResource:()=>true,getResourceServerInfo:async(ctx,r)=>{if(r!==resource)throw new errors.InvalidTarget();return {scope:'credits:read generation:read generation:write',audience:resource,accessTokenFormat:'opaque',accessTokenTTL:300};}}},
  interactions:{url:async(ctx,interaction)=>'/interaction/'+interaction.uid},
 });
 provider.proxy=true;
 return provider;
}
export function createOpaqueAuthenticator({provider,resource,clientId,authorize}){
 if(!provider||!resource||!clientId||typeof authorize!=='function')throw new Error('Explicit resource authorization required');
 return async context=>{
  const deny=()=>{throw new coreModule.ContractError('unauthenticated');};
  try{
   const value=context?.accessToken;
   if(typeof value!=='string'||value.includes('.')||value.length>2048)return deny();
   const token=await provider.AccessToken.find(value);
   if(!token||token.isExpired||token.aud!==resource||token.clientId!==clientId||!token.grantId)return deny();
   if(!await provider.Grant.find(token.grantId))return deny();
   const g=await authorize({userId:token.accountId,clientId,grantId:token.grantId});
   if(!g||g.userId!==token.accountId||g.active!==true||g.emailConfirmed!==true||g.accountStatus!=='active'||!Array.isArray(g.capabilities))return deny();
   const allowed=['credits:read','generation:read','generation:write'];
   if(g.capabilities.some(x=>!allowed.includes(x)))return deny();
   return {userId:token.accountId,emailConfirmed:true,accountStatus:'active',expiresAt:token.exp*1000,scopes:g.capabilities.filter(x=>token.scopes.has(x))};
  }catch{return deny();}
 };
}
