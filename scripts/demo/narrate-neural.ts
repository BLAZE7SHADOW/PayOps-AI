/** Production narration: sends only the public storyboard to Gemini TTS, using env.ts for credentials. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadServerEnv } from '../../packages/core/src/config/env';
const work=process.argv[2] || '/private/tmp/payops-video';
const sample=process.argv.includes('--sample');
const voice=process.env.DEMO_VOICE || 'Kore';
const env=loadServerEnv({JWT_SECRET:'temporary-demo-narration-config'});
if(!env.GEMINI_API_KEY)throw new Error('Configure GEMINI_API_KEY through the normal server environment');
mkdirSync(join(work,'neural'),{recursive:true});
const scenes=JSON.parse(readFileSync(process.env.DEMO_STORYBOARD||'docs/demo/storyboard.json','utf8')) as Array<{id:string;title:string;lines:string[];duration?:number;cues?:Array<{start:number;end:number;text:string}>}>;
const duration=(p:string)=>Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',p],{encoding:'utf8'}).trim());
const ff=(args:string[])=>execFileSync('ffmpeg',['-y','-v','error',...args],{stdio:'ignore'});
const style='A warm, articulate female narrator presenting a thoughtful product demo. Natural conversational English with a light Indian English accent. Confident and clear, with deliberate cadence, varied sentence stress, and short pauses between ideas. About 150 words per minute. Let the opening contrast land; bring a little lift to the product reveal; be precise and calm when describing evidence. No exaggerated advertising voice, no monotonous rhythm. Pronounce PayOps as pay-ops, AI as the letters A I, and Jev as jev. Read the supplied transcript exactly.';
for(const scene of (sample?scenes.slice(0,1):scenes)){
 const fingerprint=createHash('sha256').update(JSON.stringify({voice,style,lines:scene.lines})).digest('hex').slice(0,12);
 const raw=join(work,'neural',scene.id+'-'+fingerprint+'.wav');
 if(!existsSync(raw)){
  for(let attempt=0;attempt<3;attempt++){
   const response=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'gemini-3.8-flash-tts',input:[{type:'user_input',content:[{type:'text',text:scene.lines.join(' '),annotations:[{type:'speech_metadata',style}]}]}],response_format:{type:'audio'},generation_config:{speech_config:[{voice}]}}),signal:AbortSignal.timeout(120000)});
   if(!response.ok){if([429,500,502,503,504].includes(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,10000));continue}throw new Error(`Speech generation failed for ${scene.id}: HTTP ${response.status}`)}
   const body=await response.json() as {steps?:Array<{content?:Array<{type:string;data?:string}>}>};
   const blocks=(body.steps??[]).flatMap(s=>s.content??[]).filter(p=>p.type==='audio'&&p.data);
   const audio=blocks[blocks.length-1];if(!audio?.data)throw new Error(`No generated audio for ${scene.id}`);
   writeFileSync(raw,Buffer.from(audio.data,'base64'));break;
  }
 }
 const len=duration(raw);if(!Number.isFinite(len)||len<3)throw new Error('Invalid speech file');
 ff(['-i',raw,'-af','adelay=300,apad=pad_dur=0.6,loudnorm=I=-16:TP=-1.5:LRA=11','-ar','48000',join(work,scene.id+'.wav')]);
 scene.duration=duration(join(work,scene.id+'.wav'));
 const words=scene.lines.join(' ').split(/\s+/);const total=words.length;const cues=[];let pos=.3;
 while(words.length){const chunk=words.splice(0,9);const end=pos+len*chunk.length/total;cues.push({start:pos,end,text:chunk.join(' ')});pos=end}
 scene.cues=cues;console.log(`Neural narration: ${scene.id} (${scene.duration.toFixed(1)}s)`);
}
if(!sample){writeFileSync(join(work,'timing.json'),JSON.stringify(scenes,null,2));console.log('Total seconds',scenes.reduce((s,c)=>s+(c.duration??0),0).toFixed(1))}
else ff(['-i',join(work,'intro.wav'),'-c:a','aac','-b:a','160k','docs/demo/voice-preview.m4a']);
