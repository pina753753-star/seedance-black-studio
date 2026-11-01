'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {validateReferenceDanceProbe:validate,planMotionOutput,motionOutputOptions,validateMotionOutput,motionMediaDiagnostics}=require('../watermark-server/reference-dance-inspection');
const input={motion:true,allowHevcInput:true};
const fixture=(extra={})=>({format:{format_name:'mov,mp4',duration:'8'},streams:[{codec_type:'video',codec_name:'hevc',profile:'Main',pix_fmt:'yuvj420p',color_range:'pc',width:640,height:360,duration:'8',r_frame_rate:'60/1',avg_frame_rate:'60/1',...extra}]});
test('separate SDR input eligibility from sealed output; legacy unchanged; 10bit distinct from HDR',()=>{
 assert.equal(validate(fixture(),input).inputRange,'full');
 assert.equal(validate(fixture({pix_fmt:'yuv420p'}),input).inputRange,'full');
 assert.throws(()=>validate(fixture(),{allowHevcInput:true}),{publicCode:'VIDEO_PROFILE_UNSUPPORTED'});
 assert.throws(()=>validate(fixture({pix_fmt:'yuv420p10le',profile:'Main 10',bits_per_raw_sample:'10'}),input),{publicCode:'VIDEO_PROFILE_UNSUPPORTED'});
 for(const color_transfer of ['smpte2084','arib-std-b67'])assert.throws(()=>validate(fixture({color_transfer}),input),{publicCode:'VIDEO_HDR_UNSUPPORTED'});
 assert.throws(()=>validate(fixture({sample_aspect_ratio:'9:1'}),input),{publicCode:'VIDEO_PROFILE_UNSUPPORTED'});
 assert.equal(validate(fixture({sample_aspect_ratio:'4:3'}),input).inputRange,'full');
 const d=motionMediaDiagnostics(fixture({profile:'https://secret',tags:{token:'secret'},sample_aspect_ratio:'secret'}));assert.ok(!JSON.stringify(d).includes('secret'));
});
test('real SDR H264/HEVC limited/full: range conversion, SAR, rotation, selected duration and original preserved',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-sdr-'));
 const ff=args=>execFileSync('ffmpeg',['-v','error','-y',...args],{timeout:90000,maxBuffer:4*1024*1024});
 const probe=f=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',f]));
 const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 try{
 for(const codec of ['libx264','libx265'])for(const full of [false,true]){
 const source=path.join(dir,`${codec}-${full}.mov`);
 ff(['-f','lavfi','-i',"nullsrc=s=160x120:r=30:d=31,geq=lum='if(lt(X,W/2),0,255)':cb=128:cr=128",'-vf',`scale=in_range=full:out_range=${full?'full':'limited'},setsar=4/3`,'-c:v',codec,'-threads','2',...(codec==='libx265'?['-x265-params',`pools=none:frame-threads=1:log-level=error:range=${full?'full':'limited'}`,'-tag:v','hvc1']:['-bsf:v',`h264_metadata=video_full_range_flag=${full?1:0}`]),'-pix_fmt','yuv420p','-color_range',full?'pc':'tv',source]);
 const before=hash(source), p=probe(source), meta=validate(p,input);assert.ok(full ? meta.inputRange==='full' : ['limited','auto'].includes(meta.inputRange),JSON.stringify({codec,full,range:p.streams[0].color_range,pix:p.streams[0].pix_fmt}));
 for(const seconds of [4,16,null]){
 const plan=planMotionOutput({sourceDurationSeconds:meta.durationSeconds,useSeconds:seconds}),out=path.join(dir,'out.mp4');
 ff(['-threads','1','-i',source,...motionOutputOptions(plan,50*1024*1024,meta),out]);
 const q=probe(out),v=q.streams.find(s=>s.codec_type==='video'),approved=validate(q,{motion:true,requireNoAudio:true});validateMotionOutput(plan,approved);
 assert.equal(approved.durationMs,(seconds||30)*1000);assert.equal(Math.ceil(approved.durationMs/1000)*19,(seconds||30)*19);assert.equal(v.sample_aspect_ratio,'1:1');assert.equal(v.color_range,'tv');assert.ok(Math.abs(v.width/v.height-16/9)<0.02);
 const raw=ff(['-i',out,'-frames:v','1','-pix_fmt','yuv420p','-f','rawvideo','pipe:1']);assert.ok(Math.abs(raw[10*v.width+10]-16)<=3);assert.ok(Math.abs(raw[10*v.width+v.width-10]-235)<=3);
 }
 assert.equal(hash(source),before);
 // Rotation metadata is applied by decoder before the display-aspect scale.
 const rotated=path.join(dir,'rotated.mov');ff(['-display_rotation:v:0','90','-i',source,'-c','copy',rotated]);const rp=probe(rotated),rm=validate(rp,input),out=path.join(dir,'rotated.mp4');ff(['-i',rotated,...motionOutputOptions(planMotionOutput({sourceDurationSeconds:rm.durationSeconds,useSeconds:4}),50*1024*1024,rm),out]);const rv=probe(out).streams[0];assert.ok(Math.abs(rv.width/rv.height-9/16)<0.02,JSON.stringify({width:rv.width,height:rv.height,sar:rv.sample_aspect_ratio,rotation:rp.streams[0].side_data_list}));assert.equal(rv.sample_aspect_ratio,'1:1');assert.ok(!(rv.side_data_list||[]).some(s=>s.rotation));
 }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('real HEVC 10bit SDR and HDR are distinguished and rejected without tone mapping',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-depth-'));
 try{for(const hdr of [false,true]){
 const f=path.join(dir,`${hdr}.mov`);
 execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=s=128x96:r=30:d=4','-c:v','libx265','-threads','1','-x265-params','pools=none:frame-threads=1:log-level=error','-pix_fmt','yuv420p10le','-color_trc',hdr?'smpte2084':'bt709','-color_primaries',hdr?'bt2020':'bt709','-colorspace',hdr?'bt2020nc':'bt709','-tag:v','hvc1',f],{timeout:90000});
 const p=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',f]));assert.equal(p.streams[0].pix_fmt,'yuv420p10le');assert.throws(()=>validate(p,input),{publicCode:hdr?'VIDEO_HDR_UNSUPPORTED':'VIDEO_PROFILE_UNSUPPORTED'});
 }}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
