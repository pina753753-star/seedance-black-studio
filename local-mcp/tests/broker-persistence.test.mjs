import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';import {createBrokerStore} from '../broker-sqlite.mjs';
const moduleUrl=new URL('../broker-sqlite.mjs',import.meta.url).href;
function child(file,action){return new Promise((resolve,reject)=>{const script=`import {createBrokerStore} from ${JSON.stringify(moduleUrl)};const s=createBrokerStore(process.argv[1],Buffer.alloc(32,3));const a=new s.Adapter('AuthorizationCode');try{${action};process.stdout.write('ok');}catch{process.stdout.write('denied');}finally{s.close();}`;const p=spawn(process.execPath,['--input-type=module','-e',script,file],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',c=>out+=c);p.on('error',reject);p.on('exit',c=>c===0?resolve(out):reject(new Error('Child failed')));});}
test('separate processes persist state, consume once and retain revocation across reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pina-broker-process-')),file=join(dir,'db');let s;
 try{s=createBrokerStore(file,Buffer.alloc(32,3));const a=new s.Adapter('AuthorizationCode');await a.upsert('code',{grantId:'grant'},60);s.close();s=null;
 const results=await Promise.all([child(file,"await a.consume('code')"),child(file,"await a.consume('code')")]);assert.deepEqual(results.sort(),['denied','ok']);
 s=createBrokerStore(file,Buffer.alloc(32,3));assert.equal(await new s.Adapter('AuthorizationCode').find('code'),undefined);s.close();s=null;
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('revoke versus new token upsert in separate processes cannot resurrect grant',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pina-broker-race-')),file=join(dir,'db');let s;
 try{s=createBrokerStore(file,Buffer.alloc(32,3));s.close();s=null;
 await Promise.all([child(file,"await a.upsert('newcode',{grantId:'grant'},60)"),child(file,"await a.revokeByGrantId('grant')")]);
 s=createBrokerStore(file,Buffer.alloc(32,3));assert.equal(await new s.Adapter('AuthorizationCode').find('newcode'),undefined);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
