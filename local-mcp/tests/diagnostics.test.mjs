import test from 'node:test';import assert from 'node:assert/strict';
import {createDiagnosticReporter} from '../diagnostics.mjs';
import {createPostgresBrokerAdapter} from '../broker-postgres.mjs';
test('diagnostics discard unknown categories and arbitrary data, sink failure is contained',()=>{
 const lines=[],report=createDiagnosticReporter(line=>lines.push(line));
 report('consent_finalize_failed',{token:'secret',user:'private',url:'https://private.invalid'});
 for(const value of ['secret',new Error('secret'),{category:'consent_finalize_failed',token:'secret'},null])report(value);
 assert.deepEqual(lines,['{"event":"pina_mcp_diagnostic","category":"consent_finalize_failed"}']);
 assert.doesNotThrow(()=>createDiagnosticReporter(()=>{throw Error('private');})('consent_finalize_failed'));
});
test('RPC failure diagnostics contain only read/write/rejected categories, never payload/error values',async()=>{
 for(const variant of ['returned','thrown','rejected']){
  const lines=[],diagnostic=createDiagnosticReporter(x=>lines.push(x));
  const rpc=async()=>{if(variant==='thrown')throw Error('sensitive-token');return variant==='returned'?{error:{message:'private SQL value'}}:{data:{error:'private grant id'}};};
  const Adapter=createPostgresBrokerAdapter({rpc,key:Buffer.alloc(32,8),diagnostic});const a=new Adapter('Interaction');
  await assert.rejects(a.find('private-id'));await assert.rejects(a.upsert('private-id',{secret:'private-payload'},60));
  assert.deepEqual(lines.map(x=>JSON.parse(x).category),variant==='rejected'?['oauth_store_rejected','oauth_store_rejected']:['oauth_store_read_failed','oauth_store_write_failed']);
  assert.doesNotMatch(lines.join(''),/private|sensitive|payload|token/);
 }
});

test('successful store lookup with invalid encrypted payload emits only decode classification',async()=>{
 const lines=[];const Adapter=createPostgresBrokerAdapter({rpc:async()=>({data:{id:'private-id',payload:'invalid-private-payload'}}),key:Buffer.alloc(32,7),diagnostic:createDiagnosticReporter(x=>lines.push(x))});
 await assert.rejects(new Adapter('Interaction').find('private-id'),{message:'OAuth state unavailable'});
 assert.deepEqual(lines,['{"event":"pina_mcp_diagnostic","category":"oauth_store_decode_failed"}']);
});
