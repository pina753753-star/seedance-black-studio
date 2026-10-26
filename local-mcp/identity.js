'use strict';
// No JWT parsing shortcut: verifier must cryptographically validate tokens.
// No issuer discovery, tokens, keys, or external connections are configured here.
const { ContractError } = require('./core');
function createAuthenticator({issuer,audience,verifyToken,resolveIdentity,now=Date.now}){
  if(!issuer||!audience||typeof verifyToken!=='function'||typeof resolveIdentity!=='function')throw new Error('Verified identity adapters required');
  return async context=>{
    const token=context?.accessToken;
    if(typeof token!=='string'||!token)throw new ContractError('unauthenticated');
    let c;try{c=await verifyToken(token);}catch{throw new ContractError('unauthenticated');}
    const audiences=Array.isArray(c?.aud)?c.aud:[c?.aud];
    if(c?.iss!==issuer||!audiences.includes(audience)||typeof c.sub!=='string'||!c.sub||!Number.isFinite(c.exp)||c.exp*1000<=now()||(c.nbf!==undefined&&(!Number.isFinite(c.nbf)||c.nbf*1000>now())))throw new ContractError('unauthenticated');
    // Resolve an established issuer+subject link, never user metadata or email.
    const p=await resolveIdentity({issuer:c.iss,subject:c.sub});
    if(!p||typeof p.userId!=='string'||!p.userId)throw new ContractError('unauthenticated');
    return {userId:p.userId,emailConfirmed:p.emailConfirmed===true,accountStatus:p.accountStatus,expiresAt:c.exp*1000,scopes:typeof c.scope==='string'?c.scope.split(/\s+/).filter(Boolean):[]};
  };
}
module.exports={createAuthenticator};
