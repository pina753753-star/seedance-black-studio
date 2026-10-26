// Local test adapter only. No production DB or external connection.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { errors } from 'oidc-provider';
export function createBrokerStore(filename,key){
 if(!filename||!Buffer.isBuffer(key)||key.length!==32)throw new Error('Explicit local file and encryption key required');
 const db=new DatabaseSync(filename);
 db.exec(`PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS state(kind TEXT,id TEXT,payload BLOB,expires INTEGER,consumed INTEGER,grant_id TEXT,uid TEXT,user_code TEXT,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS revoked(id TEXT PRIMARY KEY);`);
 const hash=v=>v?createHash('sha256').update(v).digest('hex'):null;
 const seal=(p,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return Buffer.concat([iv,c.update(JSON.stringify(p)),c.final(),c.getAuthTag()]);};
 const open=(b,aad)=>{b=Buffer.from(b);const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 const revoked=id=>id&&db.prepare('SELECT 1 FROM revoked WHERE id=?').get(id);
 class Adapter{
  constructor(kind){this.kind=kind;}
  async upsert(id,p,ttl){return transaction(()=>{const h=hash(id),g=hash(p.grantId);if(revoked(g)||this.kind==='Grant'&&revoked(h))throw new errors.InvalidGrant('Revoked grant');db.prepare('INSERT INTO state VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code').run(this.kind,h,seal(p,this.kind+':'+h),Math.floor(Date.now()/1000)+(ttl??3600),null,g,hash(p.uid),hash(p.userCode));});}
  decode(r){if(!r||r.expires<=Date.now()/1000||revoked(r.grant_id)||this.kind==='Grant'&&revoked(r.id))return undefined;return {...open(r.payload,this.kind+':'+r.id),...(r.consumed?{consumed:r.consumed}:{})};}
  async find(id){return this.decode(db.prepare('SELECT * FROM state WHERE kind=? AND id=?').get(this.kind,hash(id)));}
  async findByUid(uid){return this.decode(db.prepare('SELECT * FROM state WHERE kind=? AND uid=?').get(this.kind,hash(uid)));}
  async findByUserCode(code){return this.decode(db.prepare('SELECT * FROM state WHERE kind=? AND user_code=?').get(this.kind,hash(code)));}
  async destroy(id){db.prepare('DELETE FROM state WHERE kind=? AND id=?').run(this.kind,hash(id));}
  async revokeByGrantId(id){return transaction(()=>{const g=hash(id);db.prepare('INSERT OR IGNORE INTO revoked VALUES(?)').run(g);db.prepare('DELETE FROM state WHERE grant_id=? OR (kind=\'Grant\' AND id=?)').run(g,g);});}
  async consume(id){const ok=transaction(()=>{const h=hash(id);const result=db.prepare('UPDATE state SET consumed=? WHERE kind=? AND id=? AND consumed IS NULL AND expires>?').run(Math.floor(Date.now()/1000),this.kind,h,Date.now()/1000);if(result.changes===1)return true;const r=db.prepare('SELECT grant_id FROM state WHERE kind=? AND id=?').get(this.kind,h);if(r?.grant_id)db.prepare('INSERT OR IGNORE INTO revoked VALUES(?)').run(r.grant_id);return false;});if(!ok)throw new errors.InvalidGrant('Already consumed');}
 }
 return {Adapter,close:()=>db.close()};
}
