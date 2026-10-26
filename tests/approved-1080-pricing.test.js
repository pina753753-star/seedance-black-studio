'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {calculateVideoCreditCost:cost}=require('../api/_lib/video-pricing');
test('approved aspect floors apply to every mode without discounting existing rates',()=>{
 const expected={'1:1':[110,210,305],'4:3':[140,275,405],'3:4':[140,275,405],'16:9':[185,360,535],'9:16':[185,360,535]};
 for(const [aspectRatio,floors] of Object.entries(expected))for(const [i,duration] of [5,10,15].entries())for(const mode of ['text_to_video','image_to_video','reference_to_video','storyboard']){
 let old=mode==='storyboard'?Math.max(50,duration*12):195+Math.max(0,duration-5)*15-(mode==='text_to_video'?10:0);if(mode==='reference_to_video')old*=1.15;old=Math.ceil(Math.max(50,Math.min(400,old))/5)*5;
 assert.equal(cost({model:'bytedance/seedance-2.0',resolution:'1080p',duration,aspectRatio,mode}),Math.max(old,floors[i]));
 }
});
test('all integer durations meet approved discounted Ultimate reserve at180 with no400 ceiling truncation',()=>{
 for(const [aspectRatio,pixels] of Object.entries({'1:1':1166400,'4:3':1555200,'3:4':1555200,'16:9':2073600,'9:16':2073600}))for(let duration=1;duration<=15;duration++){
 const c=cost({model:'bytedance/seedance-2.0',resolution:'1080p',duration,aspectRatio,mode:'text_to_video'});
 assert.ok(c*(15800/5100)*.9*(1/1.1-.036)+1e-8 >= pixels*24*duration/1024*.0000077*180*1.055*1.2+20);
 }
});
test('history pricing forwards aspect and missing calculator blocks fallback generation',()=>{
 const s=fs.readFileSync(require.resolve('../flowvid-history.js'),'utf8');
 const slice=s.slice(s.indexOf('  function credits()'),s.indexOf('  function startTimeout'));
 const els={aspect:{value:'1:1'},duration:{value:'15'},resolution:{value:'1080p'},create:{textContent:''}};
 let arg;const ctx={$:id=>els[id],currentMode:()=> 'text_to_video',selectedModel:()=> 'bytedance/seedance-2.0',window:{flowvidComputeCredits:x=>{arg=x;return cost(x)}}};vm.createContext(ctx);vm.runInContext(slice,ctx);ctx.updateCreate();assert.equal(arg.aspectRatio,'1:1');assert.match(els.create.textContent,/335$/);delete ctx.window.flowvidComputeCredits;assert.equal(ctx.credits(),null);ctx.updateCreate();assert.match(els.create.textContent,/料金を確認できません/);
});
