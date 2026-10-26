'use strict';
// Public metadata only. Does not load OAuth provider, DB bindings or secret values.
function discoveryOnly(req,res,origin){
 let base,url;try{base=new URL(origin);url=new URL(req.url,origin);if(base.protocol!=='https:'||base.origin!==origin||url.origin!==origin||req.headers.host!==base.host)throw Error();}catch{return res.status(400).json({error:'invalid_host'});}
 const issuer=origin+'/mcp/oauth',resource=origin+'/api/mcp';
 const scopes=['credits:read','generation:read','generation:write'];
 res.setHeader('Cache-Control','no-store');
 const metadata=['/.well-known/oauth-authorization-server/mcp/oauth','/.well-known/openid-configuration/mcp/oauth','/mcp/oauth/.well-known/openid-configuration','/mcp/oauth/.well-known/oauth-authorization-server'];
 if(req.method==='GET'&&metadata.includes(url.pathname))return res.status(200).json({issuer,authorization_endpoint:issuer+'/auth',token_endpoint:issuer+'/token',revocation_endpoint:issuer+'/token/revocation',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:scopes});
 if(req.method==='GET'&&['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/mcp'].includes(url.pathname))return res.status(200).json({resource,authorization_servers:[issuer],scopes_supported:scopes,bearer_methods_supported:['header']});
 if(url.pathname==='/api/mcp'){res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);return res.status(401).json({error:'unauthenticated'});}
 return res.status(503).json({error:'oauth_enrollment_disabled'});
}
module.exports={discoveryOnly};
