// Offline browser fixture: isolated app data, tiny synthetic model files and a test tone.
// Linux persistent mounts are simulated only through the worker's existing test injection.
// Every external request is blocked except explicitly mocked RunPod reads and synthetic start/stop.
// Never use a real account key or worker URL in this fixture. Run from the repository root.
import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import {createHash,randomUUID} from 'node:crypto';
await fs.mkdir(path.resolve('tmp/cloud-manager'),{recursive:true});const root=await fs.mkdtemp(path.resolve('tmp/cloud-manager/phase3-ui-fixture-'));console.log('QA_ROOT',root);
Object.assign(process.env,{AIPLAY_APPDATA:path.join(root,'appdata'),AIPLAY_RIG:path.join(root,'rig'),AIPLAY_OUTPUT:path.join(root,'songs'),AIPLAY_INPUT:path.join(root,'input'),AIPLAY_UI_PORT:'4457',AIPLAY_REMOTE_ONLY:'1',AIPLAY_PYTHON:process.env.AIPLAY_PYTHON||path.resolve(process.platform==='win32'?'tmp/gate-python/venv/Scripts/python.exe':'tmp/gate-python/venv/bin/python')});
const {MODEL_PROFILES}=await import('../../../shared/model-profiles.js');const profile=MODEL_PROFILES.find(p=>p.id==='ace15-xl-sft');
const {prepareAceMusicInput}=await import('../../../server/music/ace-comfy-input.js');const {createWorker}=await import('../../../worker/runpod-worker.js');
const {sendJSON,readBody}=await import('../../../server/engine/remote-common.js');const {setSecret}=await import('../../../server/secrets.js');
const {config}=await import('../../../server/config.js');
const TOKEN='synthetic-only-music-ui-worker-token-not-a-secret';
const listen=(s,port=0)=>new Promise(r=>s.listen(port,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const sha=b=>createHash('sha256').update(b).digest('hex');
const FLAC=Buffer.from('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','base64');const modelsDir=path.join(root,'worker-models'),outputDir=path.join(root,'worker-output');
const bundle={label:'Synthetic ACE fixtures, no model weights',files:[]};
for(const [i,relative] of ['diffusion_models/'+profile.settings.dit,'vae/ace_1.5_vae.safetensors','text_encoders/qwen_0.6b_ace15.safetensors','text_encoders/'+profile.settings.lm].entries()){
 const b=Buffer.from('SYNTHETIC FIXTURE NOT WEIGHTS '+i);await fs.mkdir(path.dirname(path.join(modelsDir,relative)),{recursive:true});await fs.writeFile(path.join(modelsDir,relative),b);
 bundle.files.push({relative,bytes:b.length,sha256:sha(b),url:'https://invalid.example/never-download'});
}bundle.totalBytes=bundle.files.reduce((n,f)=>n+f.bytes,0);
const form={...profile.hardwareAcceptance.workload,aceDit:profile.settings.dit,aceLm:profile.settings.lm,maxDuration:30,aceSteps:50,aceCfg:7,instrumental:true};
const shelf={dits:[profile.settings.dit],lms:[profile.settings.lm],lm:profile.settings.lm,ready:true};
const graph=prepareAceMusicInput(form,{shelf}).graph, objects=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
objects.UNETLoader.input.required.unet_name=[[profile.settings.dit]];objects.DualCLIPLoader.input.required={clip_name1:[['qwen_0.6b_ace15.safetensors']],clip_name2:[[profile.settings.lm]]};
objects.VAELoader.input.required.vae_name=[['ace_1.5_vae.safetensors']];objects.CheckpointLoaderSimple={input:{required:{ckpt_name:[[]]}}};
let hold=false,fail=false,submissions=0;const queue=[],history={};
async function complete(){while(queue.length){const q=queue.shift(),rel=q[2]['9'].inputs.filename_prefix+'_00001.flac';await fs.mkdir(path.dirname(path.join(outputDir,rel)),{recursive:true});await fs.writeFile(path.join(outputDir,rel),FLAC);history[q[1]]={prompt:q,status:{completed:!fail,status_str:fail?'error':'success'},outputs:fail?{}:{'9':{audio:[{filename:path.basename(rel),subfolder:path.dirname(rel).replaceAll('\\','/'),type:'output'}]}}};}}
const fake=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/v1/training/status')return sendJSON(res,200,{is_training:false});
 if(u.pathname==='/health')return sendJSON(res,200,{data:{status:'offline'}});
 if(u.pathname==='/system_stats')return sendJSON(res,200,{system:{comfyui_version:'SYNTHETIC UI TEST'},devices:[{name:'Synthetic GPU, not hardware inference',vram_total:80*2**30}]});
 if(u.pathname.startsWith('/object_info'))return sendJSON(res,200,objects);
 if(u.pathname==='/prompt'){const b=JSON.parse((await readBody(req)).toString()),id=randomUUID();submissions++;queue.push([0,id,b.prompt,b.extra_data]);if(!hold)setTimeout(()=>complete(),100);return sendJSON(res,200,{prompt_id:id});}
 if(u.pathname==='/queue')return sendJSON(res,200,{queue_running:queue.slice(0,1),queue_pending:queue.slice(1)});
 if(u.pathname.startsWith('/history')){const id=u.pathname.split('/')[2];return sendJSON(res,200,id?history[id]?{[id]:history[id]}:{}:history);}
 if(/^\/api\/jobs\/.+\/cancel$/.test(u.pathname)){const id=u.pathname.split('/')[3],i=queue.findIndex(q=>q[1]===id);if(i>=0){const[q]=queue.splice(i,1);history[id]={prompt:q,status:{completed:false,status_str:'error'}};}return sendJSON(res,200,{});}
 if(u.pathname==='/qa/release'){hold=false;await complete();return sendJSON(res,200,{submissions});}
 if(u.pathname==='/qa/hold'){hold=true;return sendJSON(res,200,{hold});}
 if(u.pathname==='/qa/provider'){const b=JSON.parse((await readBody(req)).toString());if(b.status)pod.status=b.status;if(b.empty!==undefined)providerEmpty=b.empty;if(b.failure!==undefined)providerFailure=b.failure;return sendJSON(res,200,{status:pod.status});}
 if(u.pathname==='/qa/status')return sendJSON(res,200,{submissions,queued:queue.length,completed:Object.keys(history).length,actions:fixtureActions});
 sendJSON(res,404,{});
 }catch(e){sendJSON(res,500,{error:e.message});}});
const comfyURL=await listen(fake,4459);
async function fixtureFetch(input,init){const u=new URL(String(input));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('OFFLINE: external worker requests are blocked');return fetch(input,init);}
const worker=await createWorker({fetchFn:fixtureFetch,token:TOKEN,comfyURL,aceURL:comfyURL,inputDir:path.join(root,'worker-input'),outputDir,modelsDir,stateDir:path.join(root,'worker-state'),modelBundles:{'ace15-xl-sft':bundle},pollMs:250,cloudIntervalMs:0,podId:'syntheticmusic',persistentRoot:root,verifyPersistence:async()=>({verified:true,root}),installCommit:'a'.repeat(40)});
const workerURL=await listen(worker.server);
await setSecret('RUNPOD_WORKER_TOKEN',TOKEN);await setSecret('RUNPOD_ACCOUNT_API_KEY','fixture-only-account-key-no-provider-access');
await fs.mkdir(path.join(config.dataDir,'runpod'),{recursive:true});
await fs.writeFile(path.join(config.dataDir,'runpod/connection.json'),JSON.stringify({url:'https://syntheticmusic-8787.proxy.runpod.net',workerId:(await (await fetch(workerURL+'/v1/health',{headers:{Authorization:'Bearer '+TOKEN}})).json()).workerId}));
let providerEmpty=false,providerFailure=false;const fixtureActions=[];
const pod={id:'syntheticmusic',name:'OFFLINE SYNTHETIC WORKER',status:'RUNNING',gpu:{id:'NVIDIA A100-SXM4-80GB',count:1},cloud:'SECURE',dataCenterId:'synthetic-dc',cost:1.79,mounts:{persistent:{path:root,size:100}},disk:20,actions:['start','stop']};
await fs.writeFile(path.join(config.dataDir,'runpod/cloud-computer.json'),JSON.stringify({version:1,podId:pod.id,pod,phase:'running',sessions:[],minutes:0,alertUSD:null}));
await fs.writeFile(path.join(config.dataDir,'settings.json'),JSON.stringify({music:{engine:'ace-step15',aceModel:profile.settings.dit,aceLm:profile.settings.lm},cloudSetup:{plan:{music:profile.id,pictures:'sdxl-turbo'}},ui:{level:'advanced'},covers:{enabled:false},lrc:{enabled:false},stems:{enabled:false}}));
// config was already read before writing fixture prefs: set only this isolated process.
config.music.engine='ace-step15';config.music.aceModel=profile.settings.dit;config.music.aceLm=profile.settings.lm;
config.cloudSetup.plan={music:profile.id,pictures:'sdxl-turbo'};
config.stems.when='off';config.lyrics.when='off';config.video.when='off';config.art.enabled=false;
const realFetch=globalThis.fetch;
globalThis.fetch=async(input,opts={})=>{const u=new URL(String(input));if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return realFetch(input,opts);
 if(u.hostname==='syntheticmusic-8787.proxy.runpod.net')return realFetch(workerURL+u.pathname+u.search,opts);
 if(u.hostname==='api.runpod.io'&&u.pathname==='/graphql'){
 const q=JSON.parse(opts.body||'{}').query||'';if(!/^query Aiplay(AccountCheck|RunpodOverview)/.test(q.trim()))throw Error('OFFLINE: provider mutation blocked');
 if(providerFailure)return Response.json({error:'Invalid fixture credentials'},{status:401});
 return Response.json({data:{myself:{id:'synthetic-account',clientBalance:11.67,currentSpendPerHr:pod.status==='RUNNING'?1.79:0,pods:providerEmpty?[]:[{id:pod.id,name:pod.name,desiredStatus:pod.status,costPerHr:1.79,volumeInGb:100,containerDiskInGb:20,gpuCount:1,machine:{gpuDisplayName:'A100 SXM 80 GB',gpuTypeId:'NVIDIA A100-SXM4-80GB',secureCloud:true}}]},gpuTypes:[{id:'NVIDIA A100-SXM4-80GB',displayName:'A100 SXM 80 GB',memoryInGb:80,secureCloud:true,communityCloud:false,lowestPrice:{uninterruptablePrice:1.79,stockStatus:'High'}}]}});
 }
 if(u.hostname==='api.runpod.io'&&u.pathname==='/v2/pods/syntheticmusic/action'&&opts.method==='POST'){
 const b=JSON.parse(opts.body);if(!['start','stop'].includes(b.action))throw Error('OFFLINE: unsupported mutation');fixtureActions.push({action:b.action,at:Date.now()});pod.status=b.action==='start'?'RUNNING':'EXITED';if(b.action==='start')pod.startedAt=new Date().toISOString();return Response.json(pod);
 }
 if(u.hostname==='api.runpod.io'&&u.pathname.startsWith('/v2/')&&(!opts.method||opts.method==='GET')){
 if(providerFailure)return Response.json({error:'Invalid fixture credentials'},{status:401});
 if(u.pathname==='/v2/pods')return Response.json({pods:providerEmpty?[]:[pod],pagination:{hasNextPage:false}});
 if(u.pathname==='/v2/pods/syntheticmusic')return providerEmpty?Response.json({error:'Not found'},{status:404}):Response.json(pod);
 if(u.pathname.startsWith('/v2/catalog/gpus/'))return Response.json({id:pod.gpu.id,name:'A100 SXM 80 GB',price:{secure:1.79},availability:'HIGH',dataCenters:[{id:'synthetic-dc',availability:'HIGH'}]});
 }
 throw Error('OFFLINE FIXTURE: external network and provider mutations blocked');};
await import('../../../server/index.js');
const wrapper=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture');const w=u.searchParams.get('width')==='700'?700:1240;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>Synthetic Music UI test</title><body style="margin:8px;background:#11151b;color:#fff;font:14px system-ui"><h3>Offline UI fixture · synthetic worker and 1-second test tone</h3><button onclick="document.querySelector('iframe').width=700">700px</button><button onclick="document.querySelector('iframe').width=1240">Desktop</button><iframe title="AIPLAY Music fixture" src="http://127.0.0.1:4457/?view=create" width="${w}" height="1000" style="border:0"></iframe>`);});
await listen(wrapper,4460);
console.log('QA_READY http://127.0.0.1:4460/?width=700; real Music UI and routes, synthetic worker only.');
