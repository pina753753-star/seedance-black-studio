import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {errors} from 'oidc-provider';
export function createPostgresBrokerAdapter({rpc,key,diagnostic=()=>{}}){
 if(typeof rpc!=='function'||!Buffer.isBuffer(key)||key.length!==32)throw new Error('Explicit RPC and storage encryption key required');
 const hash=v=>v?createHash('sha256').update(v).digest('hex'):null;
 const seal=(p,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return Buffer.concat([iv,c.update(JSON.stringify(p)),c.final(),c.getAuthTag()]).toString('base64url');};
 const open=(s,aad)=>{const b=Buffer.from(s,'base64url'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
 async function call(op,p){
  const report=code=>{try{diagnostic(code);}catch{}};
  let result;try{result=await rpc('pina_mcp_oauth_store',{op,p});if(result.error)throw new Error();}catch{report(['find','uid','user_code'].includes(op)?'oauth_store_read_failed':'oauth_store_write_failed');throw new Error('OAuth store unavailable');}
  if(result.data?.error){report('oauth_store_rejected');throw new errors.InvalidGrant('Invalid or revoked grant');}return result.data;
 }
 return class Adapter{
  constructor(kind){this.kind=kind;}
  async upsert(id,p,ttl){const i=hash(id);await call('upsert',{kind:this.kind,id:i,payload:seal(p,this.kind+':'+i),expires:Math.floor(Date.now()/1000)+(ttl??3600),grant_id:hash(p.grantId),uid:hash(p.uid),user_code:hash(p.userCode)});}
  async lookup(op,p){const r=await call(op,{kind:this.kind,...p});if(!r)return undefined;try{return {...open(r.payload,this.kind+':'+r.id),...(r.consumed?{consumed:r.consumed}:{})};}catch{try{diagnostic('oauth_store_decode_failed');}catch{}throw new Error('OAuth state unavailable');}}
  find(id){return this.lookup('find',{id:hash(id)});}
  findByUid(uid){return this.lookup('uid',{uid:hash(uid)});}
  findByUserCode(code){return this.lookup('user_code',{user_code:hash(code)});}
  destroy(id){return call('destroy',{kind:this.kind,id:hash(id)});}
  consume(id){return call('consume',{kind:this.kind,id:hash(id)});}
  revokeByGrantId(id){return call('revoke',{kind:this.kind,id:hash(id)});}
 };
}
