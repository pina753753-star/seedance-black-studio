// Disabled unless the release's explicit server-only configuration is installed.
// No keys are generated and no OAuth clients are registered by this handler.
let appPromise;
function key(name){const value=process.env[name];if(!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('Missing configuration');const b=Buffer.from(value,'base64');if(b.length!==32)throw new Error('Invalid configuration');return b;}
async function app(){
 const {createClient}=require('@supabase/supabase-js');
 const {createReleaseApp}=await import('../local-mcp/release-app.mjs');
 const origin=process.env.PINA_MCP_ORIGIN,clientId=process.env.PINA_MCP_CLIENT_ID,redirectUri=process.env.PINA_MCP_REDIRECT_URI;
 const url=process.env.SUPABASE_URL,serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_ROLE;
 if(!origin||!clientId||!redirectUri||!url||!serviceKey)throw new Error('Missing configuration');
 const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 const hosts=JSON.parse(process.env.PINA_MCP_ARTIFACT_HOSTS||'null');if(!Array.isArray(hosts)||!hosts.length||hosts.some(h=>typeof h!=='string'||new URL('https://'+h).hostname!==h))throw new Error('Invalid artifact hosts');
 return createReleaseApp({origin,clientId,redirectUri,db,confirmedAuth:require('./_lib/confirmed-auth').requireConfirmedAuth,startModule:require('./_lib/seedance-start'),statusModule:require('./seedance-status'),pricedModule:require('./seedance-start-priced'),quoteKey:key('PINA_MCP_QUOTE_SECRET'),csrfKey:key('PINA_MCP_CSRF_SECRET'),browserKey:key('PINA_MCP_BROWSER_KEY'),storageKey:key('PINA_MCP_OAUTH_STORAGE_KEY'),cookieKeys:[key('PINA_MCP_OAUTH_COOKIE_KEY').toString('base64')],jwks:JSON.parse(process.env.PINA_MCP_OAUTH_JWKS||'null'),artifactHosts:hosts,allowGeneration:process.env.PINA_MCP_ALLOW_GENERATION==='true'});
}
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(process.env.PINA_MCP_DISCOVERY_ONLY==='true')return require('../local-mcp/discovery-only').discoveryOnly(req,res,process.env.PINA_MCP_ORIGIN);
 if(process.env.PINA_MCP_ENABLED!=='true')return res.status(503).json({error:'mcp_not_enabled'});
 try{appPromise??=app().catch(e=>{appPromise=undefined;throw e;});return await (await appPromise).handler(req,res);}catch{return res.status(503).json({error:'mcp_unavailable'});}
};
