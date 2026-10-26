(function(root){
 'use strict';
 // Carry only an allowlisted local flow path, never an arbitrary return URL.
 function validNext(value){return typeof value==='string'&&(/^\/interaction\/[A-Za-z0-9_-]{1,128}$/.test(value)||/^\/mcp\/approve\?proposal_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));}
 function single(search,key){const values=new URLSearchParams(search).getAll(key);return values.length===1&&validNext(values[0])?values[0]:null;}
 function sessionPath(next){return validNext(next)?'/mcp-session.html?next='+encodeURIComponent(next):null;}
 const api={validNext,single,sessionPath,loginTarget:search=>sessionPath(single(search,'mcpNext'))||'./profile.html'};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.PinaMcpReturn=api;
})(typeof window==='undefined'?globalThis:window);
