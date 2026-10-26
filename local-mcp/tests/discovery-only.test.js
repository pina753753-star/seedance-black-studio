const test=require('node:test'),assert=require('node:assert/strict');const handler=require('../../api/mcp');
const origin='https://pina.example.invalid';
async function call(url,method='GET',headers={}){let status,body;const h={};const res={setHeader(k,v){h[k]=v;},status(n){status=n;return this;},json(v){body=v;return this;}};await handler({url,method,headers:{host:'pina.example.invalid',...headers}},res);return {status,body,headers:h};}
test('discovery works with no client, callback, database or secret; token and approval routes stay disabled',async()=>{
 const saved={...process.env};try{for(const key of Object.keys(process.env))if(key.startsWith('PINA_MCP_')||key.startsWith('SUPABASE_'))delete process.env[key];process.env.PINA_MCP_DISCOVERY_ONLY='true';process.env.PINA_MCP_ORIGIN=origin;process.env.PINA_MCP_ALLOW_GENERATION='false';
 const as=await call('/.well-known/oauth-authorization-server/mcp/oauth');assert.equal(as.status,200);assert.equal(as.body.issuer,origin+'/mcp/oauth');assert.equal(as.body.registration_endpoint,undefined);
 const resource=await call('/.well-known/oauth-protected-resource');assert.equal(resource.status,200);assert.equal(resource.body.resource,origin+'/api/mcp');
 for(const path of ['/mcp/oauth/auth?client_id=anything','/mcp/oauth/token','/mcp/browser-session','/mcp/approve','/interaction/anything'])for(const method of ['GET','POST'])assert.equal((await call(path,method)).status,503);
 assert.equal((await call('/api/mcp','POST',{authorization:'Bearer anything'})).status,401);assert.equal((await call('/api/mcp','GET',{host:'evil.invalid'})).status,400);
 assert.equal(Object.keys(require.cache).some(k=>k.endsWith('/release-app.mjs')),false);
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
