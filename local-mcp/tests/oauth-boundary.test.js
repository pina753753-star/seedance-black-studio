'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createOAuthBoundary}=require('../oauth-boundary');
const {issuerFixture}=require('./fixture');
const {createJwksVerifier}=require('../jwks-verifier');
const user='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002',client='00000000-0000-4000-8000-000000000003';
function fixture(){
 const f=issuerFixture(),t=Date.now();let reads=0;
 const grant={userId:user,sessionId:session,clientId:client,sessionActive:true,consentActive:true,grantActive:true,emailConfirmed:true,accountStatus:'active',expiresAt:t+60000,capabilities:['credits:read']};
 const options={issuer:f.issuer,audience:f.audience,clientId:client,role:'pina_mcp_token',verifyToken:createJwksVerifier({loadJwks:async()=>({keys:[f.jwk]})}),authorize:async()=>{reads++;return grant;},now:()=>t};
 const mint=changes=>f.mint({sub:user,session_id:session,client_id:client,role:'pina_mcp_token',iat:Math.floor(t/1000)-1,...changes});
 return {grant,options,mint,auth:createOAuthBoundary(options),reads:()=>reads};
}
test('every issuer/client/audience/role and trusted adapter is mandatory',()=>{
 const f=fixture();
 for(const k of ['issuer','audience','clientId','role','verifyToken','authorize'])assert.throws(()=>createOAuthBoundary({...f.options,[k]:undefined}));
 for(const role of ['authenticated','service_role','anon'])assert.throws(()=>createOAuthBoundary({...f.options,role}));
});
test('signed exact token gets only fresh internal grant, not token scopes',async()=>{
 const f=fixture(),context={accessToken:f.mint({scope:'openid generation:write',user_metadata:{admin:true}})};
 assert.deepEqual((await f.auth(context)).scopes,['credits:read']);
 f.grant.grantActive=false;
 await assert.rejects(f.auth(context),{code:'unauthenticated'});assert.equal(f.reads(),2);
});
test('wrong issuer/audience/client/role, malformed time and broad tokens fail before grant lookup',async()=>{
 const f=fixture();
 for(const c of [{iss:'https://evil.invalid'},{aud:'authenticated'},{aud:[f.options.audience,'authenticated']},{client_id:user},{role:'authenticated'},{session_id:null},{sub:'not-uuid'},{exp:1},{iat:9999999999},{nbf:9999999999}])await assert.rejects(f.auth({accessToken:f.mint(c)}),{code:'unauthenticated'});
 assert.equal(f.reads(),0);
});
test('owner/session/client/consent/revocation and account changes fail closed',async()=>{
 const f=fixture(),base={...f.grant};
 for(const c of [{userId:client},{sessionId:user},{clientId:session},{sessionActive:false},{consentActive:false},{grantActive:false},{emailConfirmed:false},{accountStatus:'restricted'},{expiresAt:0},{capabilities:['admin']}]){
  Object.assign(f.grant,base,c);await assert.rejects(f.auth({accessToken:f.mint()}),{code:'unauthenticated'});
 }
});
test('invalid signature and unavailable authorization store fail closed',async()=>{
 const f=fixture();await assert.rejects(f.auth({accessToken:f.mint()+'.extra'}),{code:'unauthenticated'});
 const auth=createOAuthBoundary({...f.options,authorize:async()=>{throw new Error('private database diagnostic');}});
 await assert.rejects(auth({accessToken:f.mint()}),e=>e.code==='unauthenticated'&&!e.message.includes('database'));
});
