'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../vercel.json');
const handler = require('../api/maintenance.js');
const emergencyRoutes = config.routes.filter((route) => ['/api/maintenance', '/maintenance.html'].includes(route.dest));
const routeFor = (pathname) => emergencyRoutes.find((route) => new RegExp(route.src, 'i').test(pathname));
const restoredApis = ['seedance-start', 'seedance-start-priced', '_lib/seedance-start', 'h3-live/start', 'h3-director/start-session', 'h3-director/approve-prompt', 'video-edit', 'storyboard-prompt', 'stripe-checkout'];
for (const endpoint of restoredApis) test(`restores new work ${endpoint}, including direct-file variants`, () => {
 for (const suffix of ['', '/', '.js', '.js/']) {
  assert.equal(routeFor('/api/' + endpoint + suffix), undefined);
  assert.equal(routeFor(('/api/' + endpoint + suffix).toUpperCase()), undefined);
 }
});
const preservedApis = ['stripe-webhook', 'stripe-portal', 'stripe-config', 'cancel-subscription', 'ensure-user-credits', 'cron-annual-credit-grant', 'seedance-status', 'generated-videos', 'pending-tasks', 'openrouter-reconcile', 'wavespeed-reconcile', 'video-edit-status', 'video-edit-history', 'video-edit-reconcile', 'h3-live/status', 'h3-live/jobs', 'h3-live/reconcile', 'h3-director/heartbeat', 'h3-director/end-session', 'h3-director/history', 'h3-director/start-status', 'h3-director/record-prompt-event', 'h3-director/recording-upload-url', 'h3-director/recording-complete', 'h3-director/recording-url', 'h3-director/reconcile', 'reference-audio-cleanup', 'h3-live/image-cleanup'];
for (const endpoint of preservedApis) test(`does not intercept existing path ${endpoint}`, () => {
 for (const suffix of ['', '/', '.js', '.js/']) assert.equal(routeFor('/api/' + endpoint + suffix), undefined);
});
const restoredPages=['index','generate','generate-prod','generate-cool','pricing','h3-live','h3-max-beta','h3-director','seedance-reference-test','seedance-reference-test-v5','admin-seedance','admin-veo','maintenance'];
for(const name of restoredPages) test(`does not replace ${name} page with maintenance`,()=>{
 for (const suffix of ['', '/', '.html', '.html/']) {
  assert.equal(routeFor('/'+name+suffix),undefined);
 }
});
test('root, billing, authentication, policies, help and assets are not maintenance-gated',()=>{
 assert.equal(routeFor('/'),undefined);
 const allowed=['profile.html','cancel-subscription.html','login.html','logout.html','confirm-signup.html','recover.html','help.html','terms.html','privacy.html','legal.html','credits-info.html','content-policy.html','admin.html','auth-config.js','auth-guard.js','assets/brand/pina-logo-header-full.png','api/stripe-checkout-extra','not-pricing.html'];
 for(const p of allowed) assert.equal(routeFor('/'+p),undefined,p);
});
test('standalone 503 handler is deterministic for old tabs and repeated requests, without external side effects',()=>{
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

test('restored routes retain priced generation, storyboard polling, H3 navigation and filesystem order',()=>{
 assert.deepEqual(config.routes,[
  {src:'/api/seedance-start',dest:'/api/seedance-start-priced'},
  {src:'/api/storyboard',dest:'/api/seedance-status?_r=sb'},
  {src:'/h3-live.html',dest:'/h3-max-beta.html'},
  {handle:'filesystem'},
  {src:'/',dest:'/index.html'}
 ]);
 assert.equal(config.buildCommand,'npm run build');
 assert.equal(config.outputDirectory,'public');
});
test('recovery, credit grants and cleanup cron schedules stay unchanged',()=>{
 assert.deepEqual(config.crons,[
  {path:'/api/cron-annual-credit-grant',schedule:'15 0 * * *'},
  {path:'/api/openrouter-reconcile',schedule:'*/15 * * * *'},
  {path:'/api/wavespeed-reconcile',schedule:'*/5 * * * *'},
  {path:'/api/video-edit-reconcile',schedule:'*/5 * * * *'},
  {path:'/api/reference-audio-cleanup',schedule:'37 * * * *'},
  {path:'/api/h3-live/image-cleanup',schedule:'47 * * * *'}
 ]);
});
