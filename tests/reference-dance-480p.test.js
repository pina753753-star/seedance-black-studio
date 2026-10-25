'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { referenceDanceCredits, providerCostCents, validateReferenceDanceVariant } = require('../api/_lib/reference-dance');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing');
const html = fs.readFileSync(require('node:path').join(__dirname, '../generate-prod.html'), 'utf8');
const model = 'bytedance/seedance-2.5';
function extract(name, next) { return html.slice(html.indexOf('function '+name+'('), html.indexOf('function '+next+'(')); }
test('all 4–15 second prices agree in UI/server at both resolutions; unsupported resolution fails closed', () => {
  const elements = { duration: {value:'30'}, resolution: {value:'480p'}, model: {value:model}, danceRights: {checked:true} };
  const ctx = { $: id => elements[id], referenceDanceAccess:true, SEEDANCE_25_TURBO_MODEL:model, mode:'reference_to_video', sbLocked:false, urls:['mock'], referenceDanceAsset:{status:'ready',billableSeconds:4} };
  vm.createContext(ctx);
  vm.runInContext(extract('canUseReferenceDance','syncReferenceDanceUi') + extract('creditEstimate','updateCreditUi'), ctx);
  for (const resolution of ['480p','720p']) for(let seconds=4; seconds<=15; seconds++) {
    elements.resolution.value=resolution; ctx.referenceDanceAsset.billableSeconds=seconds;
    const expected = Math.ceil(((seconds*(resolution==='480p'?22:44)*11/12)/5))*5;
    assert.equal(ctx.creditEstimate(), expected);
    assert.equal(referenceDanceCredits(seconds,resolution), expected);
    assert.equal(calculateVideoCreditCost({model,mode:'reference_to_video',resolution,duration:30,referenceDanceBillableSeconds:seconds}),expected);
    assert.equal(validateReferenceDanceVariant({model,mode:'reference_to_video',resolution}),true);
  }
  assert.equal(providerCostCents(4,'480p'),88);
  assert.equal(referenceDanceCredits(4),165);
  for(const resolution of ['1080p','garbage','__proto__']) assert.throws(()=>referenceDanceCredits(4,resolution));
});
test('480p selector available only on admin reference form, never storyboard or ordinary modes', () => {
  const options=['480p','720p','1080p'].map(value=>({value}));
  const el={options,value:'480p'};
  const ctx={$:id=>id.endsWith('Resolution')||id==='resolution'?el:null,SEEDANCE_25_TURBO_MODEL:model,SEEDANCE_25_STANDARD_MODEL:'standard',isSeedance25Model:()=>true,referenceDanceAccess:true,referenceDanceAccessPending:false,sbLocked:false,mode:'reference_to_video'};
  vm.createContext(ctx);vm.runInContext(extract('syncSelectModelCapabilities','isComboBlocked'),ctx);
  ctx.syncSelectModelCapabilities(model,'unused','resolution','unused');
  assert.equal(options[0].disabled,false);assert.equal(el.value,'480p');
  for(const [access,mode,id] of [[false,'reference_to_video','resolution'],[true,'text_to_video','resolution'],[true,'reference_to_video','sbResolution']]) {
    ctx.referenceDanceAccess=access;ctx.mode=mode;el.value='480p';ctx.syncSelectModelCapabilities(model,'unused',id,'unused');
    assert.equal(options[0].disabled,true);assert.equal(el.value,'720p');
  }
});

test('saved 480p survives startup access check without enabling generation early', () => {
  const options=['480p','720p','1080p'].map(value=>({value}));
  const el={options,value:'480p'};
  const rights={checked:true};
  const ctx={$:id=>id==='resolution'?el:id==='model'?{value:model}:id==='danceRights'?rights:null,SEEDANCE_25_TURBO_MODEL:model,SEEDANCE_25_STANDARD_MODEL:'standard',isSeedance25Model:()=>true,referenceDanceAccess:false,referenceDanceAccessPending:true,sbLocked:false,mode:'reference_to_video'};
  vm.createContext(ctx);vm.runInContext(extract('syncSelectModelCapabilities','isComboBlocked')+extract('canUseReferenceDance','syncReferenceDanceUi'),ctx);
  ctx.syncSelectModelCapabilities(model,'unused','resolution','unused');
  assert.equal(el.value,'480p');assert.equal(options[0].disabled,true);assert.equal(ctx.canUseReferenceDance(),false);
  ctx.referenceDanceAccess=true;ctx.referenceDanceAccessPending=false;
  ctx.syncSelectModelCapabilities(model,'unused','resolution','unused');
  assert.equal(el.value,'480p');assert.equal(options[0].disabled,false);assert.equal(ctx.canUseReferenceDance(),true);
  ctx.referenceDanceAccess=false;
  ctx.syncSelectModelCapabilities(model,'unused','resolution','unused');
  assert.equal(options[0].disabled,true);assert.equal(ctx.canUseReferenceDance(),false);
});
