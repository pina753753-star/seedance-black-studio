'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../vercel.json');
const handler = require('../api/maintenance.js');
const emergencyRoutes = config.routes.slice(0, 2);
const routeFor = (pathname) => emergencyRoutes.find((route) => new RegExp(route.src, 'i').test(pathname));
const blockedApis = ['seedance-start', 'seedance-start-priced', '_lib/seedance-start', 'h3-live/start', 'h3-director/start-session', 'h3-director/approve-prompt', 'video-edit', 'storyboard-prompt', 'stripe-checkout'];
for (const endpoint of blockedApis) test(`blocks new work ${endpoint}, including direct-file variants`, () => {
 for (const suffix of ['', '/', '.js', '.js/']) {
  assert.equal(routeFor('/api/' + endpoint + suffix)?.dest, '/api/maintenance');
  assert.equal(routeFor(('/api/' + endpoint + suffix).toUpperCase())?.dest, '/api/maintenance');
 }
});
const preservedApis = ['stripe-webhook', 'stripe-portal', 'stripe-config', 'cancel-subscription', 'ensure-user-credits', 'cron-annual-credit-grant', 'seedance-status', 'generated-videos', 'pending-tasks', 'openrouter-reconcile', 'wavespeed-reconcile', 'video-edit-status', 'video-edit-history', 'video-edit-reconcile', 'h3-live/status', 'h3-live/jobs', 'h3-live/reconcile', 'h3-director/heartbeat', 'h3-director/end-session', 'h3-director/history', 'h3-director/start-status', 'h3-director/record-prompt-event', 'h3-director/recording-upload-url', 'h3-director/recording-complete', 'h3-director/recording-url', 'h3-director/reconcile', 'reference-audio-cleanup', 'h3-live/image-cleanup'];
for (const endpoint of preservedApis) test(`does not intercept existing path ${endpoint}`, () => {
 for (const suffix of ['', '/', '.js', '.js/']) assert.equal(routeFor('/api/' + endpoint + suffix), undefined);
});
const blockedPages=['index','generate','generate-prod','generate-cool','pricing','h3-live','h3-max-beta','h3-director','seedance-reference-test','seedance-reference-test-v5','admin-seedance','admin-veo','maintenance'];
for(const name of blockedPages) test(`replaces ${name} page with 503 maintenance`,()=>{
 for (const suffix of ['', '/', '.html', '.html/']) {
  const rule=routeFor('/'+name+suffix); assert.equal(rule?.dest,'/maintenance.html');assert.equal(rule.status,503);assert.equal(rule.headers['Cache-Control'],'no-store');
 }
});
test('root is gated while billing, authentication, policies, help and assets remain reachable',()=>{
 assert.equal(routeFor('/')?.dest,'/maintenance.html');
 const allowed=['profile.html','cancel-subscription.html','login.html','logout.html','confirm-signup.html','recover.html','help.html','terms.html','privacy.html','legal.html','credits-info.html','content-policy.html','admin.html','auth-config.js','auth-guard.js','assets/brand/pina-logo-header-full.png','api/stripe-checkout-extra','not-pricing.html'];
 for(const p of allowed) assert.equal(routeFor('/'+p),undefined,p);
});
test('503 handler is deterministic for old tabs and repeated requests, without external side effects',()=>{
 for (const method of ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD','POST','POST']){
  const result={headers:{}};
  const res={setHeader(k,v){result.headers[k]=v;},status(s){result.status=s;return this;},json(b){result.body=b;return this;},end(){result.ended=true;return this;}};
  handler({method,body:{ignored:true}},res);
  assert.equal(result.status,503);assert.equal(result.headers['Cache-Control'],'no-store');
  if(method==='HEAD') assert.equal(result.ended,true);
  else assert.deepEqual(result.body,{ok:false,error:'maintenance_in_progress',errorCategory:'service_unavailable',message:'メンテナンス中です。復旧まで今しばらくお待ちください'});
 }
});
test('maintenance page has direct billing/cancellation links and no new-generation or checkout scripts',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../maintenance.html'),'utf8');
 for(const href of ['/profile.html','/cancel-subscription.html','/help.html','/terms.html','/privacy.html','/legal.html']) assert.ok(html.includes(`href="${href}"`),href);
 assert.ok(html.includes('メンテナンス中です。'));assert.ok(html.includes('復旧まで今しばらくお待ちください'));
 assert.doesNotMatch(html,/<script|\/api\/stripe-checkout|\/api\/.*start|setInterval|setTimeout/i);
 assert.match(html,/width=device-width/);assert.match(html,/focus-visible/);
});
