'use strict';
const {Server,WebStandardStreamableHTTPServerTransport}=require('@modelcontextprotocol/server');
function createSdkServer(core,context){
 const server=new Server({name:'pina-local',version:'0.1.0'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',()=>({tools:core.listTools().map(t=>({...t,_meta:{securitySchemes:t.securitySchemes}}))}));
 server.setRequestHandler('tools/call',r=>core.handle(r,context));
 return server;
}
// Web-standard Streamable HTTP handler; no listen(), public address or defaults.
// Each request gets its own SDK instance and verified bearer context; no shared
// identity/session state. Tests call this through an in-process fetch adapter.
function createMcpHttpHandler({core,authenticate,resource,issuer}){
 const endpoint=new URL(resource), metadata=new URL('/.well-known/oauth-protected-resource',endpoint);
 const json=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
 return async request=>{
  const url=new URL(request.url);
  if(url.origin!==endpoint.origin)return json(400,{error:'invalid_host'});
  const origin=request.headers.get('origin');
  if(origin&&origin!==endpoint.origin)return json(403,{error:'invalid_origin'});
  if([metadata.pathname,metadata.pathname+endpoint.pathname].includes(url.pathname)&&request.method==='GET')return json(200,{resource,authorization_servers:[issuer],scopes_supported:['credits:read','generation:read','generation:write'],bearer_methods_supported:['header']});
  if(url.pathname!==endpoint.pathname)return json(404,{error:'not_found'});
  const value=request.headers.get('authorization')||'';
  const context={accessToken:/^Bearer [^\s]+$/i.test(value)?value.slice(7):''};
  try{await authenticate(context);}catch{return json(401,{error:'unauthenticated'},{'WWW-Authenticate':`Bearer resource_metadata="${metadata.href}"`});}
  if(request.headers.has('mcp-session-id'))return json(400,{error:'stateless_only'});
  if(request.method!=='POST')return json(405,{error:'method_not_allowed'},{Allow:'POST'});
  const server=createSdkServer(core,context);
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{
   await server.connect(transport);
   const response=await transport.handleRequest(request);
   const body=await response.arrayBuffer();
   return new Response(body.byteLength?body:null,{status:response.status,headers:response.headers});
  }finally{await server.close();}
 };
}
module.exports={createSdkServer,createMcpHttpHandler};
