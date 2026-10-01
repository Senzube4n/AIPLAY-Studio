import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat,readdir,copyFile,realpath,lstat,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {config} from '../config.js';
import {ffmpegPath} from '../clipjoin.js';
import {runTool} from './community-process.js';
import {trainingRecipe,nativeTrainingArgs} from './community-recipes.js';
import {externalMusicWork} from './exclusive.js';
import {fileURLToPath} from 'node:url';
import {installCommunityPack} from './community-install.js';
import {plannerRequest,plannerArgs} from './community-planner.js';
import {rightsStampFor} from '../models.js';
import {YUE_GGUF_MODEL,inspectGgufWav} from './yue-gguf.js';
import {midiDawPlan} from './community-midi-daw.js';

const safeId=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const exists=file=>stat(file).then(s=>s.isFile()).catch(()=>false);
const root=()=>process.env.AIPLAY_MUSIC_TOOLS_ROOT || path.join(config.rig,'community-tools');
const modelRoot=()=>path.join(root(),'models');
const tool=(name)=>process.env[name==='midi'?'AIPLAY_MUSCRIPTOR_CLI':'AIPLAY_NATIVE_TRAIN_CLI'] || path.join(root(),name,`music-${name}${process.platform==='win32'?'.exe':''}`);
const plannerCli=()=>process.env.AIPLAY_NATIVE_PLANNER_CLI || path.join(root(),'planner',`audiocpp_cli${process.platform==='win32'?'.exe':''}`);
const torchLib=()=>path.resolve(path.dirname(config.python),'..','Lib','site-packages','torch','lib');
const toolEnv=()=>({...process.env,PATH:[path.dirname(tool('train')),torchLib(),config.yueGguf?.cli?path.dirname(config.yueGguf.cli):'',process.env.AIPLAY_NATIVE_CUDA_LIB || '',process.env.PATH].join(path.delimiter)});
export const datasetFingerprint=dataset=>createHash('sha256').update(JSON.stringify(dataset.items.map(i=>({sha256:i.sha256,style:i.style,lyrics:i.lyrics,instrumental:i.instrumental})))).digest('hex');
const hashFile=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const stateRoot=()=>path.join(config.paths.appData,'music-tools');
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,file);}
async function read(file){return JSON.parse(await readFile(file,'utf8'));}
const datasetFile=id=>path.join(stateRoot(),'datasets',id,'dataset.json');
const datasetDir=id=>path.dirname(datasetFile(id));
const runFile=id=>path.join(stateRoot(),'runs',id,'run.json');
const runDir=id=>path.dirname(runFile(id));
export const MUSCRIPTOR_MODELS=Object.freeze({small:'31a8f75d6a8b5383fd71ad1371dc1620389ab722',medium:'27246ba68bd4d8f98bdec10a6edf8d7cf42a8826',large:'87f4bf981f56f90fb5043153b3f54af3c3053da9'});
const TRAIN_FILES=['yue2_3b_int8_convrot.safetensors','yue2-vae-standard-f32.gguf','yue2-tok-f16.gguf','sheetsage2-f16.gguf','nar_lora_joint_v9.safetensors','vocab.json','merges.txt'];
export async function communityCapabilities(){
  const models=modelRoot();
  const missing=[];for(const file of TRAIN_FILES)if(!await exists(path.join(models,file)))missing.push(file);
  const midiModels={};for(const size of Object.keys(MUSCRIPTOR_MODELS))midiModels[size]=await exists(path.join(models,`muscriptor-${size}`,'model.safetensors')) && await exists(path.join(models,`muscriptor-${size}`,'config.json'));
  return {root:root(),midi:{runtime:await exists(tool('midi')),models:midiModels,weights:'CC BY-NC 4.0',devices:['auto','cpu']},
    training:{runtime:await exists(tool('train')),missing,tokenizer:config.yueGguf?.modelDir || null,
      minimumVramGb:11,recipes:['fast','balanced','thorough','custom'],adapterFormats:['lora','lokr']},
    planner:{runtime:await exists(plannerCli()),version:'0.9.0',backend:'cuda'},
    processing:{vst:await exists(process.env.AIPLAY_VST_PYTHON || path.join(root(),'processing-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'))}};
}
export function nativePreparationStages({audio,models,tokenizer,dir,trigger}){
  const cache=path.join(dir,'cache'),manifest=path.join(cache,'yue2_preprocess.json'),prepared=path.join(dir,'prepared');
  return [
    {id:'latents',args:['yue2-preprocess','--audio',audio,'--out',cache,'--models',models,'--vae','standard','--caption-mode','yue2','--loudness-lufs','0']},
    {id:'codes',args:['yue2-tokenize','--manifest',manifest,'--models',models]},
    {id:'scores',args:['yue2-sheet','--manifest',manifest,'--models',models]},
    {id:'prepare',args:['yue2-prepare-aitk','--legacy-manifest',manifest,'--checkpoint',path.join(models,TRAIN_FILES[0]),
      '--tokenizer',tokenizer,'--output',prepared,'--model',`vae=${path.join(models,TRAIN_FILES[1])}`,
      '--model',`semantic=${path.join(models,TRAIN_FILES[2])}`,'--model',`sheetsage=${path.join(models,TRAIN_FILES[3])}`,
      '--lyric-timing','0',...(trigger?['--trigger',trigger]:[])]},
  ];
}

export function createCommunityRoutes({json,readBody,library,jobs,engine,provenance,daw}){
  let active=null;
  const assetUrl=file=>'/api/music-tools/file/'+file.split(path.sep).map(encodeURIComponent).join('/');
  async function list(kind){const dir=path.join(stateRoot(),kind);const names=await readdir(dir).catch(()=>[]);return Promise.all(names.filter(safeId).map(id=>read(path.join(dir,id,kind==='datasets'?'dataset.json':'run.json')).catch(()=>null))).then(rows=>rows.filter(Boolean));}
  async function source(file){
    if(typeof file!=='string'||file!==path.basename(file)||file.includes('..'))throw new Error('Choose a library recording.');
    if(!(await library.list()).some(row=>row.file===file))throw new Error('Recording is no longer in the library.');
    return path.join(config.outputDir,file);
  }
  async function verifyItems(dataset){
    for(const item of dataset.items) if(await hashFile(item.path)!==item.sha256)throw new Error(`${item.title}: source changed. Import a fresh dataset.`);
  }
  async function launch(kind,body,work){
    if(active)throw new Error('Another music tool is running.');
    const release=externalMusicWork.acquire(kind), controller=new AbortController();
    try{
      const snapshot=jobs.snapshot(),st=await engine.status().catch(()=>({running:[]}));
      if(snapshot.current || st.running?.length || Number(st.queue?.running)>0 || Number(st.queue?.pending)>0)throw new Error('Wait for the current render to finish.');
      await engine.freeMemory({unloadModels:true});
      const id=randomUUID().replaceAll('-',''),row={id,kind,state:'running',stage:'starting',createdAt:Date.now(),body,log:[]};
      active={row,controller};await save(runFile(id),row);
      void (async()=>{
        try{await work(row,controller.signal);row.state='done';}
        catch(error){row.state=controller.signal.aborted?'stopped':'failed';row.error=error.message;}
        finally{row.finishedAt=Date.now();await save(runFile(id),row).catch(()=>{});active=null;release();}
      })();
      return row;
    }catch(error){release();throw error;}
  }
  async function native(row,args,signal){
    await runTool(tool('train'),args,{signal,env:toolEnv(),timeoutMs:24*3600000,onLine:line=>{row.log.push(line);row.log=row.log.slice(-100);try{const progress=JSON.parse(line);if(progress.step!=null||progress.done!=null)row.progress=progress;}catch{}}});
  }
  async function prepareDataset(dataset,row,signal){
    await verifyItems(dataset);const dir=datasetDir(dataset.id),audio=path.join(dir,'audio');await mkdir(audio,{recursive:true});
    for(const item of dataset.items){
      signal.throwIfAborted();row.stage='audio';row.item=item.title;
      const stem=item.id,target=path.join(audio,stem+'.wav');
      if(!item.prepared){
        await runTool(ffmpegPath(),['-v','error','-y','-i',item.path,'-map','0:a:0','-ar','48000','-ac','2',target],{signal});
        const style=item.style.replace(/\s+/g,' ').trim();
        await writeFile(path.join(audio,stem+'.txt'),`caption: ${style}\nis_instrumental: ${!!item.instrumental}\nlyrics:\n${item.lyrics}\n`);
        await writeFile(path.join(audio,stem+'.yue2.txt'),style+'\n');item.prepared=true;await save(datasetFile(dataset.id),dataset);
      }
    }
    row.stage='ready';dataset.state='prepared';await save(datasetFile(dataset.id),dataset);
  }
  return async(req,res,url)=>{
    const p=url.pathname;if(!p.startsWith('/api/music-tools'))return false;
    try{
      if(p.startsWith('/api/music-tools/file/')&&req.method==='GET'){
        const rel=p.slice('/api/music-tools/file/'.length).split('/').map(decodeURIComponent);
        if(rel.some(part=>!safeId(part.replace(/\.(wav|mid|json|abc|safetensors)$/,''))))throw new Error('Invalid output path.');
        const file=path.join(stateRoot(),...rel),actual=await realpath(file),base=await realpath(stateRoot());
        if(!actual.startsWith(base+path.sep))throw new Error('Invalid output path.');
        const info=await stat(actual),headers={'Content-Type':file.endsWith('.mid')?'audio/midi':file.endsWith('.wav')?'audio/wav':file.endsWith('.abc')?'text/plain':file.endsWith('.json')?'application/json':'application/octet-stream','Cache-Control':'no-store','Accept-Ranges':'bytes'};
        let start=0,end=info.size-1,status=200;
        if(req.headers.range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(match&&(match[1]||match[2])){start=match[1]?Number(match[1]):Math.max(0,info.size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),end):end;}
          if(!match||!(match[1]||match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return true;}
          status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
        }
        headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
        if(!info.size)res.end();else createReadStream(actual,{start,end}).on('error',error=>res.destroy(error)).pipe(res);return true;
      }
      if(p!=='/api/music-tools')return false;
      const b=req.method==='POST'?await readBody(req):{action:'status'}, action=b.action||'status';
      if(action==='status'){json(res,200,{ok:true,capabilities:await communityCapabilities(),active:active?.row || null,datasets:await list('datasets'),runs:await list('runs')});return true;}
      if(action==='read'){if(!safeId(b.run))throw new Error('Choose a saved run.');json(res,200,{ok:true,run:await read(runFile(b.run))});return true;}
      if(action==='stop'){active?.controller.abort(new Error('Stopped by user'));json(res,200,{ok:true});return true;}
      if(action==='install'){
        if(!['midi','train','planner'].includes(b.kind)||!Object.hasOwn(MUSCRIPTOR_MODELS,b.size||'small'))throw new Error('Choose a valid native pack.');
        const row=await launch('install',b,async(row,signal)=>{
          row.stage='downloading';row.installation=await installCommunityPack({root:root(),kind:b.kind,size:b.size||'small',signal,
            checkpoint:path.join(config.rig,'ComfyUI','models','checkpoints',TRAIN_FILES[0]),onProgress:value=>{row.progress=value;}});
          row.stage='checking runtime';await runTool(b.kind==='planner'?plannerCli():tool(b.kind),[b.kind==='planner'?'--version':'--help'],{signal,env:toolEnv(),timeoutMs:60000});
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='plan'||action==='replay'){
        if(!await exists(plannerCli()))throw new Error('Install the native planner first.');
        let request,parent=null,semanticFile,semanticFrames;
        if(action==='replay'){
          if(!safeId(b.run))throw new Error('Choose a saved native run.');parent=await read(runFile(b.run));
          if(parent.kind!=='plan'||parent.state!=='done'||!parent.request)throw new Error('Choose a completed native run.');
          const parentScore=parent.score||parent.request.abc;
          request=plannerRequest({...parent.request,stage:'audio',abc:b.abc??parentScore,seed:b.seed??parent.request.seed});
          if(b.useTokens===true){
            if(b.abc!=null&&b.abc!==parentScore)throw new Error('Edited scores require fresh semantic tokens.');
            semanticFile=path.join(runDir(parent.id),'semantic.json');const tokens=await read(semanticFile);
            if(!Array.isArray(tokens)||tokens.some(n=>!Number.isInteger(n)||n<0||n>=32768))throw new Error('Saved semantic tokens are invalid.');
            if(await hashFile(semanticFile)!==parent.semanticHash)throw new Error('Saved semantic tokens changed.');semanticFrames=tokens.length;
          }
        }else request=plannerRequest(b);
        if(config.gpu.vendor!=='nvidia')throw new Error('This optional planner pack requires NVIDIA CUDA. Use Studio score planning on this machine.');
        const model=path.join(config.yueGguf.modelDir,`yue2-3b-${request.quantization}.gguf`);
        if(!await exists(model))throw new Error('Install the selected native YuE2 model first.');
        const row=await launch('plan',b,async(row,signal)=>{
          row.request=request;row.score=request.abc||null;row.parent=parent?.id||null;row.stage=request.stage;const dir=runDir(row.id);
          const version=await runTool(plannerCli(),['--version'],{signal,env:toolEnv(),timeoutMs:60000});
          const match=/audio\.cpp (\d+)\.(\d+)\.(\d+)/.exec(version.log);
          if(!match||!(Number(match[1])>0||Number(match[2])>=9))throw new Error('Native planning requires audio.cpp 0.9 or newer.');
          row.runtimeVersion=match.slice(1).join('.');
          row.modelHash=await hashFile(model);row.runtimeHash=await hashFile(plannerCli());
          if(parent&&(parent.modelHash!==row.modelHash||parent.runtimeHash!==row.runtimeHash))throw new Error('The native model or runtime changed. Start a fresh run.');
          if(request.abc)await writeFile(path.join(dir,'input.abc'),request.abc);
          await save(path.join(dir,'request.json'),{request,modelHash:row.modelHash,runtimeHash:row.runtimeHash});
          await runTool(plannerCli(),plannerArgs(request,{modelDir:config.yueGguf.modelDir,dir,semanticFile,semanticFrames,threads:config.yueGguf.threads}),
            {signal,env:toolEnv(),onLine:line=>{row.log.push(line);row.log=row.log.slice(-100);}});
          const score=path.join(dir,'score.abc');if(await exists(score)){row.score=await readFile(score,'utf8');row.scoreUrl=assetUrl(path.relative(stateRoot(),score));}
          const semantic=path.join(dir,'semantic.json');if(await exists(semantic)){row.semanticHash=await hashFile(semantic);row.semanticUrl=assetUrl(path.relative(stateRoot(),semantic));row.frames=(await read(semantic)).length;}
          const output=path.join(dir,'audio.wav');if(await exists(output)){Object.assign(row,await inspectGgufWav(output));row.outputUrl=assetUrl(path.relative(stateRoot(),output));row.sha256=await hashFile(output);}
          if(request.stage==='abc'&&!row.score)throw new Error('Native planner returned no score.');
          if(request.stage==='semantic'&&!row.semanticUrl)throw new Error('Native planner returned no semantic tokens.');
          if(request.stage==='audio'&&!row.outputUrl)throw new Error('Native renderer returned no audio.');
          row.requestUrl=assetUrl(path.relative(stateRoot(),path.join(dir,'request.json')));
          await provenance.append('library',{actor:provenance.actorFrom(req),type:'generate',asset:`music-tools/${row.id}`,data:{tool:'audio.cpp 0.9.0',stage:request.stage,modelHash:row.modelHash,runtimeHash:row.runtimeHash,semanticHash:row.semanticHash||null,sha256:row.sha256||null}});
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='dataset'){
        if(!b.folder&&(!Array.isArray(b.files)||!b.files.length||b.files.length>200))throw new Error('Choose 1 to 200 recordings.');
        const id=randomUUID().replaceAll('-',''),items=[];
        let files=b.files||[],folder;
        if(b.folder){
          if(typeof b.folder!=='string'||!path.isAbsolute(b.folder))throw new Error('Enter an absolute folder path.');
          folder=await realpath(b.folder);files=(await readdir(folder)).filter(file=>/\.(wav|flac|mp3|m4a|ogg|opus)$/i.test(file)).sort();
          if(!files.length||files.length>200)throw new Error('The folder must contain 1 to 200 audio files.');
        }
        for(const [index,file]of [...new Set(files)].entries()){
          const filePath=folder?path.join(folder,file):await source(file);
          if(folder&&!(await lstat(filePath)).isFile())throw new Error('Folder recordings must be regular files.');
          let meta=folder?{}:library.meta.get(file)||{};
          if(folder){try{const sidecar=await read(path.join(folder,path.parse(file).name+'.json'));meta={title:sidecar.title,caption:sidecar.caption||sidecar.style,lyrics:sidecar.lyrics,instrumental:sidecar.instrumental};}catch{}}
          items.push({id:'song_'+index,path:filePath,file,title:meta.title||file,sha256:await hashFile(filePath),
            style:typeof meta.caption==='string'?meta.caption:'',lyrics:typeof meta.lyrics==='string'?meta.lyrics:'',instrumental:!!meta.instrumental,prepared:false});
        }
        const dataset={id,name:String(b.name||'Training dataset').slice(0,100),trigger:'aiplay_'+id.slice(0,10),state:'review',items,stages:[]};
        await save(datasetFile(id),dataset);json(res,201,{ok:true,dataset});return true;
      }
      if(action==='edit'){
        if(!safeId(b.id))throw new Error('Choose a dataset.');
        if(active?.row.body?.dataset===b.id)throw new Error('Stop preparation before editing.');
        const dataset=await read(datasetFile(b.id)),item=dataset.items.find(i=>i.id===b.item);
        if(!item)throw new Error('Unknown song.');
        for(const key of ['style','lyrics'])if(typeof b[key]!=='string'||b[key].length>20000)throw new Error('Style and lyrics must be text up to 20000 characters.');
        Object.assign(item,{style:b.style,lyrics:b.lyrics,instrumental:b.instrumental===true,prepared:false});dataset.stages=[];dataset.state='review';
        // Only regenerate this dataset's derived caches. Source recordings are untouched.
        const base=path.resolve(datasetDir(dataset.id));
        for(const name of ['cache','prepared']){const target=path.resolve(base,name);if(path.dirname(target)!==base)throw new Error('Invalid cache path.');await rm(target,{recursive:true,force:true});}
        await save(datasetFile(b.id),dataset);json(res,200,{ok:true,dataset});return true;
      }
      if(action==='prepare'){
        if(!safeId(b.dataset))throw new Error('Choose a dataset.');const dataset=await read(datasetFile(b.dataset));
        for(const item of dataset.items)if(!item.style.trim()||(!item.instrumental&&!item.lyrics.trim()))throw new Error(`${item.title}: review its style and lyrics first.`);
        const row=await launch('prepare',b,(row,signal)=>prepareDataset(dataset,row,signal));json(res,202,{ok:true,run:row});return true;
      }
      if(action==='train'||action==='continue'){
        if(config.gpu.vendor!=='nvidia'||config.gpu.totalMb<11000)throw new Error('Native joint training requires an NVIDIA GPU with at least 11 GB VRAM. Use the existing Studio training path on this machine.');
        const caps=await communityCapabilities();if(!caps.training.runtime||caps.training.missing.length)throw new Error('Install the native training pack first.');
        const tokenizer=modelRoot();
        let previous=null,dataset,recipe,resume;
        if(action==='continue'){
          if(!safeId(b.run))throw new Error('Choose a saved run.');previous=await read(runFile(b.run));dataset=await read(datasetFile(previous.body.dataset));
          if(previous.datasetHash!==datasetFingerprint(dataset))throw new Error('Dataset changed since this checkpoint. Start a fresh training run.');
          recipe={...previous.recipe,steps:b.steps};trainingRecipe({...recipe,preset:'custom'});
          const outputs=await readdir(path.join(runDir(previous.id),'output')).catch(()=>[]);
          const checkpoints=outputs.map(name=>({name,step:Number(/^checkpoint-step(\d+)$/.exec(name)?.[1])})).filter(r=>r.step>0).sort((a,b)=>b.step-a.step);
          for(const checkpoint of checkpoints){const file=path.join(runDir(previous.id),'output',checkpoint.name,'optimizer.resume');if(await exists(file)){resume=file;if(b.steps<=checkpoint.step)throw new Error('Total steps must exceed the saved checkpoint.');break;}}
          if(!resume)throw new Error('No resumable optimizer checkpoint exists for this run.');
        }else{if(!safeId(b.dataset))throw new Error('Choose a dataset.');dataset=await read(datasetFile(b.dataset));recipe=trainingRecipe(b.recipe);}
        await verifyItems(dataset);
        for(const item of dataset.items)if(!item.style.trim()||(!item.instrumental&&!item.lyrics.trim()))throw new Error(`${item.title}: review its style and lyrics first.`);
        const row=await launch('train',{...b,dataset:dataset.id},async(row,signal)=>{
          row.recipe=recipe;row.datasetHash=datasetFingerprint(dataset);row.parent=previous?.id||null;await prepareDataset(dataset,row,signal);const models=modelRoot(),dir=datasetDir(dataset.id);
          if(!previous)for(const stage of nativePreparationStages({audio:path.join(dir,'audio'),models,tokenizer,dir,trigger:dataset.trigger})){
            if(dataset.stages.includes(stage.id))continue;row.stage=stage.id;
            if(stage.id==='prepare'){const base=path.resolve(dir),target=path.resolve(base,'prepared');if(path.dirname(target)!==base)throw new Error('Invalid cache path.');await rm(target,{recursive:true,force:true});}
            await save(runFile(row.id),row);await native(row,stage.args,signal);dataset.stages.push(stage.id);await save(datasetFile(dataset.id),dataset);
          }
          row.stage='train';await save(runFile(row.id),row);
          await native(row,nativeTrainingArgs({models,companion:path.join(models,TRAIN_FILES[4]),dataset:path.join(dir,'prepared','dataset.json'),
            output:path.join(runDir(row.id),'output'),recipe,resume}),signal);
          row.output=path.join(runDir(row.id),'output');
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='midi'){
        const size=b.size||'small',device=b.device||'auto';if(!Object.hasOwn(MUSCRIPTOR_MODELS,size)||!['auto','cpu'].includes(device))throw new Error('Invalid transcription settings.');
        const caps=await communityCapabilities();if(!caps.midi.runtime||!caps.midi.models[size])throw new Error(`Install MuScriptor ${size} first.`);
        const input=await source(b.file);
        const row=await launch('midi',b,async(row,signal)=>{
          const dir=runDir(row.id),raw=path.join(dir,'input.f32'),output=path.join(dir,'audio.mid');row.stage='reading';
          await runTool(ffmpegPath(),['-v','error','-y','-i',input,'-map','0:a:0','-ac','1','-ar','16000','-f','f32le',raw],{signal});
          row.stage='transcribing';const notes=[],open=new Map();
          await runTool(tool('midi'),['--model',path.join(modelRoot(),`muscriptor-${size}`),'--transcribe-raw',raw,'--out',output,'--jsonl','--device',device],
            {signal,env:toolEnv(),onLine:line=>{try{const event=JSON.parse(line);if(event.type==='progress')row.progress=event;
              if(event.type==='note_start'){const note={pitch:event.pitch,start:event.time,instrument:event.instrument};open.set(event.index,note);notes.push(note);}
              if(event.type==='note_end'&&open.has(event.index))open.get(event.index).end=event.time;
            }catch{} }});
          const bytes=await readFile(output);if(bytes.subarray(0,4).toString()!=='MThd')throw new Error('The transcriber returned no valid MIDI file.');
          await save(path.join(dir,'notes.json'),notes);row.notes=notes.length;row.sha256=await hashFile(output);row.notesHash=await hashFile(path.join(dir,'notes.json'));row.outputUrl=assetUrl(path.relative(stateRoot(),output));
          row.notesUrl=assetUrl(path.relative(stateRoot(),path.join(dir,'notes.json')));
          await provenance.append('library',{actor:provenance.actorFrom(req),type:'generate',asset:`music-tools/${row.id}`,data:{source:b.file,tool:'MuScriptor',size,sha256:await hashFile(output),notes:notes.length,rights:'CC BY-NC 4.0'}});
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='exportAdapter'){
        if(!safeId(b.run))throw new Error('Choose a training run.');const parent=await read(runFile(b.run));
        if(parent.kind!=='train'||parent.state==='running')throw new Error('Finish or stop training before exporting.');
        const output=path.join(runDir(parent.id),'output');
        const names=(await readdir(output)).filter(n=>/^checkpoint-step\d+$/.test(n)).sort((a,b)=>Number(b.slice(15))-Number(a.slice(15)));
        let checkpoint;for(const name of names)if(await exists(path.join(output,name,'native-ar.safetensors'))&&await exists(path.join(output,name,'native-nar.safetensors'))){checkpoint=path.join(output,name);break;}
        if(!checkpoint)throw new Error('No complete AR and NAR checkpoint is available.');
        const row=await launch('export',b,async(row,signal)=>{
          row.parent=parent.id;row.stage='converting';const dir=runDir(row.id),dest=path.join(dir,'adapter.safetensors'),job=path.join(dir,'export.json');
          const dataset=await read(datasetFile(parent.body.dataset));
          await save(job,{ar:path.join(checkpoint,'native-ar.safetensors'),nar:path.join(checkpoint,'native-nar.safetensors'),output:dest,name:dataset.name,trigger:dataset.trigger});
          await runTool(config.python,[fileURLToPath(new URL('./native_adapter_export.py',import.meta.url)),job],{signal});
          row.sha256=await hashFile(dest);row.outputUrl=assetUrl(path.relative(stateRoot(),dest));row.trigger=dataset.trigger;
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='toDaw'){
        if(!safeId(b.run)||!daw)throw new Error('Choose a completed transcription.');const row=await read(runFile(b.run));
        if(row.kind!=='midi'||row.state!=='done')throw new Error('Finish transcription first.');
        if(row.daw){json(res,200,{ok:true,slug:row.daw,ready:!!row.dawReady});return true;}
        const notesFile=path.join(runDir(row.id),'notes.json');
        if(row.notesHash&&await hashFile(notesFile)!==row.notesHash)throw new Error('Predicted notes changed after transcription.');
        const plan=midiDawPlan(await read(notesFile),b.bpm??120),by='user';
        const project=await daw({action:'create',name:'MuScriptor · '+row.body.file,bpm:plan.bpm,num:4,den:4,length_bars:plan.bars,by},provenance.actorFrom(req));
        row.daw=project.slug;row.dawReady=false;await save(runFile(row.id),row);
        for(const track of plan.tracks){
          const created=await daw({action:'add_track',slug:row.daw,name:track.name,instrument:'pluck',by},provenance.actorFrom(req));
          for(let start=0;start<track.notes.length;start+=2000)await daw({action:'record_notes',slug:row.daw,track:created.trackId||created.track.id,notes:track.notes.slice(start,start+2000),by},provenance.actorFrom(req));
        }
        row.dawReady=true;row.dawOmitted=plan.omitted;row.dawTempo=plan.bpm;await save(runFile(row.id),row);
        json(res,200,{ok:true,slug:row.daw,omitted:plan.omitted});return true;
      }
      if(action==='installAdapter'){
        if(!safeId(b.run))throw new Error('Choose an exported adapter.');const row=await read(runFile(b.run));
        if(row.kind!=='export'||row.state!=='done')throw new Error('Export the adapter first.');
        const file=path.join(runDir(row.id),'adapter.safetensors');if(await hashFile(file)!==row.sha256)throw new Error('The adapter changed after export.');
        const name='mine_native_'+row.id+'.safetensors',dest=path.join(config.rig,'ComfyUI','models','loras');await mkdir(dest,{recursive:true});
        await copyFile(file,path.join(dest,name));row.installedAs=name;await save(runFile(row.id),row);
        await provenance.append('library',{actor:provenance.actorFrom(req),type:'import',asset:`adapter/${name}`,data:{sourceRun:row.parent,sha256:row.sha256,trigger:row.trigger}});
        json(res,200,{ok:true,name,trigger:row.trigger});return true;
      }
      if(action==='keepSong'){
        if(!safeId(b.run))throw new Error('Choose a native song.');const row=await read(runFile(b.run));
        if(row.kind!=='plan'||row.state!=='done'||!row.outputUrl)throw new Error('Render audio first.');
        const output=path.join(runDir(row.id),'audio.wav');if(await hashFile(output)!==row.sha256)throw new Error('The rendered audio changed.');
        const file='aiplay_native_'+row.id+'.wav';await copyFile(output,path.join(config.outputDir,file));
        library.remember(file,{title:row.request.lyrics.split(/\r?\n/).find(line=>line.trim()&&!line.startsWith('['))||'Native YuE2 song',
          caption:row.request.style,lyrics:row.request.lyrics,seed:row.request.seed,cot:row.request.cot,model:'YuE2 GGUF '+(row.request.quantization==='q8_0'?'Q8':'Q4'),engine:'yue2-gguf',
          durationSeconds:row.audioSeconds??null,musicToolsRun:row.id,rights:rightsStampFor(YUE_GGUF_MODEL),createdAt:Date.now()});
        row.keptAs=file;await save(runFile(row.id),row);json(res,200,{ok:true,file});return true;
      }
      if(action==='process'){
        const input=await source(b.file), reference=b.reference?await source(b.reference):null;
        const plugins=b.plugins||[];
        if(!Array.isArray(plugins)||plugins.length>12)throw new Error('Choose up to 12 VST3 plugins.');
        for(const plugin of plugins){
          if(typeof plugin.path!=='string'||!plugin.path.toLowerCase().endsWith('.vst3')||!await stat(plugin.path).then(()=>true).catch(()=>false))throw new Error('Choose an installed VST3 plugin.');
          if(plugin.parameters && (typeof plugin.parameters!=='object'||Array.isArray(plugin.parameters)||Object.keys(plugin.parameters).length>100))throw new Error('Invalid plugin parameters.');
        }
        const amount=b.smoothing??0;if(typeof amount!=='number'||!Number.isFinite(amount)||amount<0||amount>1)throw new Error('Smoothing must be between 0 and 1.');
        const row=await launch('process',b,async(row,signal)=>{
          const dir=runDir(row.id),output=path.join(dir,'audio.wav');
          const filters=[];
          if(b.denoise===true)filters.push('afftdn=nf=-25');
          if(amount>0)filters.push(`equalizer=f=8000:t=q:w=0.7:g=${-6*amount}`);
          const base=path.join(dir,'processed.wav');row.stage='processing';
          await runTool(ffmpegPath(),['-v','error','-y','-i',input,'-map','0:a:0',...(filters.length?['-af',filters.join(',')]:[]),'-c:a','pcm_f32le',base],{signal});
          let processed=base;
          if(plugins.length){
            row.stage='plugins';const vstOutput=path.join(dir,'plugins.wav'),job=path.join(dir,'vst.json');
            await save(job,{input:base,output:vstOutput,plugins});
            const python=process.env.AIPLAY_VST_PYTHON || path.join(root(),'processing-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
            if(!await exists(python))throw new Error('Install the optional VST3 processor first.');
            await runTool(python,[fileURLToPath(new URL('./vst_process.py',import.meta.url)),job],{signal});processed=vstOutput;
          }
          if(reference){
            row.stage='mastering';const target=await runTool(ffmpegPath(),['-hide_banner','-nostats','-i',reference,'-af','loudnorm=I=-14:TP=-1:LRA=11:print_format=json','-f','null','-'],{signal});
            const match=/\{\s*"input_i"[\s\S]*?\}/.exec(target.log),facts=match?JSON.parse(match[0]):null;
            if(!facts||!Number.isFinite(Number(facts.input_i)))throw new Error('The reference has no measurable loudness.');
            const loudness=Math.max(-70,Math.min(-5,Number(facts.input_i)));
            await runTool(ffmpegPath(),['-v','error','-y','-i',processed,'-af',`loudnorm=I=${loudness}:TP=-1:LRA=11`,'-ar','48000','-c:a','pcm_f32le',output],{signal});
            row.referenceLufs=loudness;
          }else await copyFile(processed,output);
          row.sourceHash=await hashFile(input);row.sha256=await hashFile(output);row.outputUrl=assetUrl(path.relative(stateRoot(),output));
          row.originalUrl='/api/audio/'+encodeURIComponent(b.file);
        });json(res,202,{ok:true,run:row});return true;
      }
      if(action==='keep'){
        if(!safeId(b.run))throw new Error('Choose a processed take.');const row=await read(runFile(b.run));
        if(row.kind!=='process'||row.state!=='done')throw new Error('Processing has not finished.');
        if(row.keptAs){json(res,200,{ok:true,file:row.keptAs});return true;}
        const original=await source(row.body.file),output=path.join(runDir(row.id),'audio.wav');
        if(await hashFile(original)!==row.sourceHash||await hashFile(output)!==row.sha256)throw new Error('The source or processed take changed.');
        const file='processed_'+row.id+'.wav',target=path.join(config.outputDir,file);
        await copyFile(output,target);library.remember(file,{...(library.meta.get(row.body.file)||{}),
          title:(library.meta.get(row.body.file)?.title || row.body.file)+' (processed)',derivedFrom:row.body.file,
          processing:row.body,processingRun:row.id,createdAt:Date.now()});
        await provenance.append('library',{actor:provenance.actorFrom(req),type:'generate',asset:file,data:{tool:'music-process',source:row.body.file,sourceHash:row.sourceHash,sha256:row.sha256,settings:row.body}});
        row.keptAs=file;await save(runFile(row.id),row);json(res,200,{ok:true,file});return true;
      }
      throw new Error('Unknown music tool action.');
    }catch(error){json(res,400,{error:error.message});return true;}
  };
}
