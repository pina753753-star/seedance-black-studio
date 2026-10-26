'use strict';
const { ContractError } = require('./core');
function original(q) { const {approval,requestId,...rest}=q; return {...rest,approved:false}; }
function createPostgresStore({query}) {
 if(typeof query!=='function')throw new Error('Local SQL adapter required');
 async function call(op,p){
  // query implements parameter binding; never string-interpolate user data.
  const result=await query('SELECT pina_mcp.dispatch($1::text,$2::jsonb) AS result',[op,JSON.stringify(p)]);
  const value=result.rows[0].result;
  if(value?.error)throw new ContractError(value.error);
  return value;
 }
 return {
  createProposal:quote=>call('create',{quote}), getProposal:id=>call('get',{id}),
  approve:(id,user,hash,now,q,sessionId)=>call('approve',{id,user,hash,now,quote:original(q),sessionId}),
  getRequest:async(user,request)=>(await call('request',{user,request}))?.record,
  claim:(user,request,id,hash,now,q)=>call('claim',{user,request,id,hash,now,quote:original(q)}),
  complete:(user,request,task)=>call('complete',{user,request,task}),
  markUncertain:(user,request)=>call('uncertain',{user,request})
 };
}
module.exports={createPostgresStore};
