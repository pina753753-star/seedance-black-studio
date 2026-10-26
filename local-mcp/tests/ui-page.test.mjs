import {readFileSync} from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {uiPage,uiPolicy} from '../ui-page.mjs';
test('connection page viewport, safe static style hash, logo path and restrictive policy',()=>{
 const html=uiPage({title:'確認',step:2,body:'<h1>確認</h1>'}),css=html.match(/<style>([\s\S]*?)<\/style>/)[1],policy=uiPolicy('https://pina.example.invalid');
 assert.match(html,/width=device-width,initial-scale=1/);assert.match(html,/aria-current="step">2\./);
 assert.ok(policy.includes("style-src 'sha256-"+createHash('sha256').update(css).digest('base64')+"'"));
 assert.ok(policy.includes('img-src https://pina.example.invalid/assets/brand/pina-logo-header-full.png;'));
 for(const directive of ["default-src 'none'","form-action 'self'","frame-ancestors 'none'","base-uri 'none'"])assert.ok(policy.includes(directive));
 assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|data:|\*/);assert.doesNotMatch(html,/<script|@import|url\(/);
});

test('static identity page and packaged function use identical theme bytes',()=>{const css=readFileSync(new URL('../ui-theme.css',import.meta.url),'utf8');const html=readFileSync(new URL('../../mcp-session.html',import.meta.url),'utf8');assert.equal(html.match(/<style>([\s\S]*?)<\/style>/)[1],css);const config=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));assert.ok(JSON.stringify(config).includes('local-mcp/**'));});
