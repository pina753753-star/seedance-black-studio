'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {readApprovalBody,createApprovalUI}=require('../approval-ui');
async function parsed(body){const r=Readable.from(['consumed']);for await(const x of r){}r.body=body;return r;}
test('approval reader accepts bounded raw form, Vercel parsed string/Buffer/plain fields without flattening',async()=>{
 const fields={proposal_id:'q',fingerprint:'hash',max_credits:'55',csrf:'test',decision:'approve'},body=new URLSearchParams(fields).toString();
 for(const r of [Readable.from([body]),await parsed(body),await parsed(Buffer.from(body)),await parsed(fields),await parsed(Object.assign(Object.create(null),fields))])assert.equal(await readApprovalBody(r),body);
});
test('approval reader rejects duplicates-as-arrays, nesting, unknown fields, nonform types and oversized inputs',async()=>{
 for(const body of [{csrf:['one','two']},{csrf:{value:'x'}},{unknown:'x'},[],4,null,new Date(),'x'.repeat(4097),Buffer.alloc(4097)])await assert.rejects(readApprovalBody(await parsed(body)));
 await assert.rejects(readApprovalBody(Readable.from(['x'.repeat(4097)])));
 assert.equal(await readApprovalBody(await parsed('csrf=a&csrf=b')),'csrf=a&csrf=b');
});
test('approval still rejects null/foreign Origin, cross-site, changed CSRF and duplicate scalar fields',async()=>{
 const origin='https://pina.invalid',q={id:'q',userId:'u',fingerprint:'hash',credits:55,expiresAt:Date.now()+60000,input:{prompt:'test'}};let approvals=0;
 const ui=createApprovalUI({origin,path:'/mcp/approve',csrfKey:Buffer.alloc(32,9),resolveBrowserSession:async()=>({id:'s',userId:'u',expiresAt:Date.now()+60000,context:{}}),core:{approvalView:async()=>q,approveProposal:async()=>approvals++}});
 const page=await ui({method:'GET',url:'/mcp/approve?proposal_id=q',headers:{}});assert.equal(page.headers['Referrer-Policy'],'same-origin');
 const form={};for(const m of page.body.matchAll(/name="([^"]+)" value="([^"]*)"/g))form[m[1]]=m[2];form.decision='approve';
 const post=(headers={},body=new URLSearchParams(form).toString())=>ui({method:'POST',url:'/mcp/approve',headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers},body});
 for(const headers of [{origin:'null'},{origin:'https://evil.invalid'},{origin:undefined},{'sec-fetch-site':'cross-site'}])assert.equal((await post(headers)).body,'csrf_rejected');
 assert.equal((await post({},new URLSearchParams({...form,csrf:'0'.repeat(64)}).toString())).body,'csrf_rejected');
 assert.equal((await post({},new URLSearchParams(form)+'&csrf=second')).body,'invalid_request');assert.equal(approvals,0);
 assert.equal((await post()).status,200);assert.equal(approvals,1);
});
