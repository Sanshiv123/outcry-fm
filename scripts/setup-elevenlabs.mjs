import { existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync } from 'node:fs';
process.loadEnvFile('.env');
const key=process.env.ELEVENLABS_API_KEY;
if(!key)throw Error('ELEVENLABS_API_KEY missing');
function saveEnv(values){let s=readFileSync('.env','utf8');for(const [k,v]of Object.entries(values)){const re=new RegExp(`^${k}=.*$`,'m');s=re.test(s)?s.replace(re,()=>`${k}=${v}`):s+`\n${k}=${v}\n`;}writeFileSync('.env',s,{mode:0o600});chmodSync('.env',0o600);}
async function request(path,body){const r=await fetch('https://api.elevenlabs.io'+path,{method:body?'POST':'GET',headers:{'xi-api-key':key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});if(!r.ok){let status='';try{const j=await r.json();status=typeof j.detail?.status==='string'?j.detail.status:'';}catch{}throw Error(`ElevenLabs ${path.split('?')[0]}: HTTP ${r.status} ${status}`);}return r;}
mkdirSync('data/setup',{recursive:true});mkdirSync('data/audio',{recursive:true});
const voices=(await (await request('/v2/voices?page_size=100')).json()).voices;
const a=voices.find(v=>v.name.startsWith('Roger'))||voices.find(v=>v.labels?.gender==='male');
const b=voices.find(v=>v.name.startsWith('Jessica'))||voices.find(v=>v.labels?.gender==='female');
if(!a||!b)throw Error('Two distinct voices unavailable');
saveEnv({ELEVENLABS_VOICE_A:a.voice_id,ELEVENLABS_VOICE_B:b.voice_id,ENABLE_GROK:'false'});
console.log(`Configured Max: ${a.name}; Jules: ${b.name}. Grok disabled.`);
const lines=[{speaker:'A',line:'Welcome to Outcry. I am Max. Trading used to have a voice. We gave it back. You are listening to a simulated market demo. No real funds move here.'},{speaker:'B',line:'And I am Jules. Listen like a podcast, trade with one tap, or call the floor. Every ticket is read back before you confirm. Hosts are AI. Not financial advice.'}];
const results=await Promise.allSettled(lines.map(async(l,i)=>{const file=`data/audio/1-${i}.mp3`;if(!existsSync(file)){const r=await request(`/v1/text-to-speech/${i===0?a.voice_id:b.voice_id}`,{text:l.line,model_id:'eleven_multilingual_v2'});writeFileSync(file,new Uint8Array(await r.arrayBuffer()));}console.log(`Generated intro ${l.speaker}: ${file}`);}));
for(const r of results)if(r.status==='rejected')console.log(r.reason.message);
try{if(!existsSync('data/audio/0-0.mp3')){const r=await request('/v1/sound-generation',{text:'One short vintage trading floor bell, clean metallic ding, no voices.',duration_seconds:1.5});writeFileSync('data/audio/0-0.mp3',new Uint8Array(await r.arrayBuffer()));}console.log('Pit bell ready.');}catch(e){console.log(e.message);}
const schema=await fetch('https://api.elevenlabs.io/openapi.json',{signal:AbortSignal.timeout(20000)});
if(schema.ok){const data=await schema.json();writeFileSync('data/setup/elevenlabs-openapi.json',JSON.stringify(data));console.log('Downloaded official API schema for agent setup.');}
