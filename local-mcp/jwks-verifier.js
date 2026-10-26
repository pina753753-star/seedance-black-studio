'use strict';
const {createPublicKey,verify}=require('node:crypto');
// RS256 only. JWKS loader is trusted configuration, never token jku/x5u/iss.
// No fetch/discovery/default URL: tests supply a local mock issuer's JWKS.
function createJwksVerifier({loadJwks}){
 if(typeof loadJwks!=='function')throw new Error('Trusted JWKS loader required');
 return async token=>{
  if(typeof token!=='string'||token.length>16384)throw new Error('Invalid JWT');
  const parts=token.split('.');
  if(parts.length!==3||parts.some(x=>!/^[A-Za-z0-9_-]+$/.test(x)))throw new Error('Invalid JWT');
  const header=JSON.parse(Buffer.from(parts[0],'base64url'));
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit||header.jku||header.jwk||header.x5u)throw new Error('Invalid header');
  if(header.typ!==undefined&&!['JWT','at+jwt'].includes(header.typ))throw new Error('Invalid type');
  const jwks=await loadJwks();
  const keys=jwks?.keys?.filter(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig')&&(!k.key_ops||k.key_ops.includes('verify')));
  if(keys?.length!==1)throw new Error('Unknown or ambiguous key');
  const key=createPublicKey({key:keys[0],format:'jwk'});
  if(key.asymmetricKeyDetails?.modulusLength<2048||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))throw new Error('Invalid signature');
  return JSON.parse(Buffer.from(parts[1],'base64url'));
 };
}
module.exports={createJwksVerifier};
