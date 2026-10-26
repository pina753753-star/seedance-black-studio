'use strict';
// Test harness only: local docker socket, no network or ports or credentials.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
function createDockerQuery(container){
 if(!/^pina-mcp-test-[a-z0-9]+$/.test(container))throw new Error('Dedicated local test container required');
 return async(sql,args)=>{
  if(sql!=='SELECT pina_mcp.dispatch($1::text,$2::jsonb) AS result')throw new Error('Unsupported local query');
  // Hex literals contain no SQL delimiters, even for adversarial quote input.
  const literal=x=>"convert_from(decode('"+Buffer.from(x).toString('hex')+"','hex'),'UTF8')";
  const statement=`SELECT pina_mcp.dispatch(${literal(args[0])},${literal(args[1])}::jsonb);`;
  const {stdout}=await exec('docker',['exec',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_mcp_test','-c',statement],{timeout:15000,maxBuffer:1024*1024});
  return {rows:[{result:JSON.parse(stdout.trim())}]};
 };
}
module.exports={createDockerQuery};
