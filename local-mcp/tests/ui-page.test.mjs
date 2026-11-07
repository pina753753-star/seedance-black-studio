import {readFileSync,mkdtempSync,copyFileSync,readdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {uiPage,uiPolicy} from '../ui-page.mjs';
const CSS_SHA256='sha256-NEEaq7roguy6/r7QZroIAmUiYFDAtgb13tVON+eXQzE=';
test('connection page viewport, safe static style hash, logo path and restrictive policy',()=>{
 const html=uiPage({title:'確認',step:2,body:'<h1>確認</h1>'}),css=html.match(/<style>([\s\S]*?)<\/style>/)[1],policy=uiPolicy('https://pina.example.invalid');
 assert.match(html,/width=device-width,initial-scale=1/);assert.match(html,/aria-current="step">2\./);
 assert.ok(policy.includes("style-src 'sha256-"+createHash('sha256').update(css).digest('base64')+"'"));
 assert.ok(policy.includes('img-src https://pina.example.invalid/assets/brand/pina-logo-header-full.png;'));
 for(const directive of ["default-src 'none'","form-action 'self'","frame-ancestors 'none'","base-uri 'none'"])assert.ok(policy.includes(directive));
 assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|data:|\*/);assert.doesNotMatch(html,/<script|@import|url\(/);
});

test('static identity page and packaged function use identical theme bytes',()=>{const css=readFileSync(new URL('../ui-theme.css',import.meta.url),'utf8');const html=readFileSync(new URL('../../mcp-session.html',import.meta.url),'utf8');assert.equal(html.match(/<style>([\s\S]*?)<\/style>/)[1],css);const config=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));assert.ok(JSON.stringify(config).includes('local-mcp/**'));});

test('module CSS, ui-theme.css and static identity page CSS are byte-identical',()=>{
 const file=readFileSync(new URL('../ui-theme.css',import.meta.url),'utf8'),inPage=readFileSync(new URL('../../mcp-session.html',import.meta.url),'utf8').match(/<style>([\s\S]*?)<\/style>/)[1],inModule=uiPage({title:'t',body:''}).match(/<style>([\s\S]*?)<\/style>/)[1];
 assert.ok(file.endsWith('\n'));assert.equal(Buffer.compare(Buffer.from(inModule),Buffer.from(file)),0);assert.equal(Buffer.compare(Buffer.from(inPage),Buffer.from(file)),0);
});

test('CSS hash is the approved fixed value and is the only style the policy allows',()=>{
 const css=readFileSync(new URL('../ui-theme.css',import.meta.url),'utf8'),policy=uiPolicy('https://pina.example.invalid');
 assert.equal('sha256-'+createHash('sha256').update(css).digest('base64'),CSS_SHA256);
 assert.ok(policy.includes("style-src '"+CSS_SHA256+"';"));assert.equal(policy.match(/style-src [^;]*/g).length,1);
});

test('module has no file-read dependency: imports and renders from an isolated dir without the CSS file',()=>{
 assert.doesNotMatch(readFileSync(new URL('../ui-page.mjs',import.meta.url),'utf8'),/node:fs|readFileSync|import\.meta\.url/);
 const dir=mkdtempSync(join(tmpdir(),'pina-ui-page-'));
 try{
  copyFileSync(new URL('../ui-page.mjs',import.meta.url),join(dir,'ui-page.mjs'));assert.deepEqual(readdirSync(dir),['ui-page.mjs']);
  const code="import {uiPage,uiPolicy} from './ui-page.mjs';process.stdout.write(JSON.stringify({policy:uiPolicy('https://pina.example.invalid'),html:uiPage({title:'t',step:2,body:'<h1>x</h1>'})}))";
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout);assert.ok(out.policy.includes("style-src '"+CSS_SHA256+"'"));
  assert.equal(out.html,uiPage({title:'t',step:2,body:'<h1>x</h1>'}));assert.equal(out.policy,uiPolicy('https://pina.example.invalid'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('identity bridge copy covers both connection and video approval',()=>{
 const html=readFileSync(new URL('../../mcp-session.html',import.meta.url),'utf8');
 assert.match(html,/ChatGPTとの接続または動画の承認/);assert.doesNotMatch(html,/CONNECT TO CHATGPT|3\. ChatGPTへ戻る/);
 assert.match(html,/id="continue"/);assert.match(html,/id="login"/);
});
