/** One musical cue, two existing project stores. No model generation. */
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, readdir, stat} from 'node:fs/promises';
import {renameAtomic} from '../fs-atomic.js';
import {config} from '../config.js';
import * as dawStore from '../daw/store.js';
import * as vfxStore from '../vfx/store.js';
import {instrumentsDir} from '../daw/patches.js';
import {previewAudioKey} from '../daw/preview-key.js';
import {actorFrom} from '../provenance.js';

const ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const finite = (value, min, max, name, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  return value;
};
const idOf = id => {if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose a saved cue id.'); return id;};
const byOf = actor => actor === 'user' ? 'user' : 'agent';

export const SHARED_CUE_CAPABILITIES = Object.freeze({
  accents: ['impact', 'kick'], visualTargets: ['flash'],
  unsupportedTargets: ['camera', 'light', 'avatar'],
  clock: 'DAW bar/beat/tick plus explicit composition offset in seconds',
});

export function sharedCueRecipe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cue settings must be an object.');
  const allowed = ['name','project','comp','bar','beat','tick','accent','velocity','gainDb','durationBeats','flashStrength','compOffsetSeconds'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported cue setting: ${key}.`);
  for (const key of ['project','comp']) if (typeof input[key] !== 'string' || !SLUG.test(input[key])) throw new Error(`Choose an existing ${key}.`);
  const name = input.name ?? 'Drop';
  if (typeof name !== 'string' || !name.trim() || name.length > 32 || /[\x00-\x1f]/.test(name)) throw new Error('Cue name must be 1 to 32 characters.');
  const accent = input.accent ?? 'impact';
  if (!SHARED_CUE_CAPABILITIES.accents.includes(accent)) throw new Error('Choose impact or kick.');
  return {name: name.trim(), project: input.project, comp: input.comp,
    bar: finite(input.bar, 1, 256, 'bar', true), beat: finite(input.beat ?? 1, 1, 32, 'beat', true), tick: finite(input.tick ?? 0, 0, 959, 'tick', true), accent,
    velocity: finite(input.velocity ?? 100, 1, 127, 'velocity', true), gainDb: finite(input.gainDb ?? -6, -24, 0, 'accent gain'),
    durationBeats: finite(input.durationBeats ?? .5, .1, 4, 'duration'), flashStrength: finite(input.flashStrength ?? 20, 1, 50, 'flash strength'),
    compOffsetSeconds: finite(input.compOffsetSeconds ?? 0, -600, 600, 'composition offset')};
}

/** Pure plan. Musical timing is resolved by the DAW's own mixed-meter clock. */
export function sharedCuePlan(cue, project, comp, stores = {daw: dawStore, vfx: vfxStore}) {
  const {daw,vfx} = stores, r = sharedCueRecipe(cue.recipe);
  if (!project || project.slug !== r.project) throw new Error('The DAW project is no longer available.');
  if (!comp || comp.slug !== r.comp) throw new Error('The VFX composition is no longer available.');
  const position = daw.normPos(project,r), musicSeconds = daw.posToSeconds(project,position);
  const durTicks = Math.round(r.durationBeats * daw.TICKS_PER_BEAT), durationSeconds = daw.durationSeconds(project,position,durTicks);
  const patch = r.accent === 'kick' ? 'tr909' : 'impact', tail = daw.TAILS[patch];
  if (durationSeconds + tail > 10) throw new Error('Shorten the cue to fit the 10-second accent preview.');
  if (musicSeconds + durationSeconds + tail > daw.projectSeconds(project) + 1e-6) throw new Error('Extend the DAW project so the accent tail can finish.');
  const visualSeconds = musicSeconds + r.compOffsetSeconds;
  if (visualSeconds < 0 || visualSeconds + durationSeconds > comp.duration + 1e-6) throw new Error('Adjust the composition offset or extend the VFX composition to fit this cue.');
  if (project.tracks.length >= daw.LIMITS.tracks) throw new Error('The DAW project has no free track slot.');
  if (comp.layers.length >= vfx.LIMITS.layers) throw new Error('The VFX composition has no free layer slot.');
  if (project.tracks.some(t => t.solo && !t.mute)) throw new Error('Clear DAW solo before applying an accent.');
  if (comp.layers.some(l => l.solo && l.enabled !== false)) throw new Error('Clear VFX solo before applying a flash.');
  if (comp.layers[0]?.trackMatte) throw new Error('Clear the top VFX layer’s track matte before adding a flash above it.');
  const track = daw.blankTrack(`${r.name} cue`, patch, {gainDb:r.gainDb});
  track.id = `trk_cue_${cue.id}`;
  const clip = daw.blankClip(position.bar,position.bar,{name:r.name}); clip.id = `clp_cue_${cue.id}`;
  clip.notes = [{id:`nt_cue_${cue.id}`, ...position, durTicks, pitch:36, vel:r.velocity, by:cue.by === 'agent' ? 'agent' : 'user'}];
  track.clips = [clip];
  const layer = vfx.blankLayer(comp,'solid',{name:`${r.name} flash`, start:visualSeconds, end:visualSeconds + durationSeconds});
  layer.id = `ly_cue_${cue.id}`;
  layer.transform.opacity = {keys:vfx.normalizeKeys([{t:visualSeconds,v:r.flashStrength,ease:'linear'}, {t:visualSeconds + durationSeconds,v:0}],{arity:1})};
  // Compare the shape that survives both stores' migrations, not constructor order.
  const normalizedTrack = daw.migrate({...clone(project),tracks:[track]}).tracks[0];
  const normalizedLayer = vfx.migrate({...clone(comp),layers:[layer]}).layers[0];
  const marker = {t:visualSeconds,label:`${r.name} [cue:${cue.id}]`};
  const sr = daw.SR, startSample = Math.round(musicSeconds * sr);
  const audioJob = {sr,start_sample:0,n_samples:Math.round((durationSeconds + tail)*sr),instruments_dir:instrumentsDir(),
    notes:[{inst:patch,params:{},midi:36,vel:r.velocity,start_sample:0,dur_samples:Math.round(durationSeconds*sr),
      gain_db:r.gainDb,seed:daw.noteSeed(track.id,clip.notes[0].id,36,startSample)}]};
  const plan = {cueId:cue.id,recipe:r,projectRevision:project.updatedAt,compRevision:comp.updatedAt,
    musicSeconds,visualSeconds,durationSeconds,position,track:normalizedTrack,layer:normalizedLayer,marker,audioJob,
    previewKind:'accent audio with a flash overlay on a composition still',
    frameUrl:`/api/vfx/frame/${encodeURIComponent(comp.slug)}?t=${visualSeconds}&scale=0.25&draft=1`};
  return {...plan,previewToken:fingerprint(plan)};
}

export function createSharedCueService({daw = dawStore,vfx = vfxStore, root = () => path.join(config.paths.appData,'music-cues'),renderAccent} = {}) {
  const chains = new Map(), previewChains = new Map();
  const cuePath = id => path.join(root(),idOf(id)+'.json');
  async function write(cue) {
    await mkdir(root(),{recursive:true}); const file=cuePath(cue.id),temp=file+'.'+randomUUID()+'.tmp';
    cue.updatedAt=Math.max(Date.now(),(cue.updatedAt||0)+1);
    await writeFile(temp,JSON.stringify(cue,null,2)); await renameAtomic(temp,file); return cue;
  }
  async function read(id) {
    try {return JSON.parse(await readFile(cuePath(id),'utf8'));}
    catch(error) {if(error.code==='ENOENT') throw new Error('This saved cue no longer exists.'); throw error;}
  }
  function lock(id,fn) {
    const previous=chains.get(id)||Promise.resolve(),next=previous.then(fn,fn); chains.set(id,next.then(()=>{},()=>{})); return next;
  }
  const docs = cue => Promise.all([daw.readProject(cue.recipe.project),vfx.readComp(cue.recipe.comp)]);
  async function preview(id) {const cue=await read(id),[project,comp]=await docs(cue); return {cue,plan:sharedCuePlan(cue,project,comp,{daw,vfx})};}
  async function reconcile(cue) {
    if (!['applying','undoing','partial','applied'].includes(cue.state) || !cue.receipt) return cue;
    const [project,comp]=await docs(cue),r=cue.receipt;
    const audio=project?.tracks.some(t=>t.id===r.track.id),visual=comp?.layers.some(l=>l.id===r.layer.id),marker=comp?.markers.some(m=>fingerprint(m)===fingerprint(r.marker));
    const nextState=audio && visual && marker ? 'applied' : !audio && !visual && !marker ? (cue.state==='applying' ? 'draft' : 'undone') : 'partial';
    if(nextState===cue.state)return cue;cue.state=nextState;return write(cue);
  }
  async function save(input,actor='system') {
    const {id,...settings}=input,recipe=sharedCueRecipe(settings),key=id ? idOf(id) : randomUUID().replaceAll('-','');
    return lock(key,async()=>{
      const old=id ? await reconcile(await read(id)) : null;
      if(old && !['draft','undone'].includes(old.state)) throw new Error('Undo this cue before changing its settings.');
      const cue={id:key,recipe,state:'draft',by:byOf(actor),actor,createdAt:old?.createdAt||Date.now()};
      const [project,comp]=await docs(cue),plan=sharedCuePlan(cue,project,comp,{daw,vfx}); await write(cue); return {cue,plan};
    });
  }
  async function apply(id,previewToken,actor='system') {
    idOf(id); if(typeof previewToken!=='string'||!/^[a-f0-9]{64}$/.test(previewToken)) throw new Error('Preview this cue before applying it.');
    return lock(id,async()=>{
      const cue=await reconcile(await read(id));
      if(cue.state==='applied') return {cue,alreadyApplied:true};
      if(!['draft','undone'].includes(cue.state)) throw new Error('This cue has a partial change. Undo it before applying again.');
      const [project,comp]=await docs(cue),plan=sharedCuePlan(cue,project,comp,{daw,vfx});
      if(plan.previewToken!==previewToken) throw new Error('The cue or either project changed. Preview again before applying.');
      if(project.tracks.some(t=>t.id===plan.track.id)||comp.layers.some(l=>l.id===plan.layer.id)||comp.markers.some(m=>m.label===plan.marker.label)) throw new Error('Cue-owned content already exists. Read this cue and resolve its earlier change before applying.');
      cue.state='applying'; cue.receipt={track:plan.track,layer:plan.layer,marker:plan.marker,musicSeconds:plan.musicSeconds,visualSeconds:plan.visualSeconds};
      await write(cue); // A crash can now be recovered by status/read/undo.
      try {
        await daw.updateProject(cue.recipe.project,async d=>{
          if(d.updatedAt!==plan.projectRevision) throw new Error('The DAW project changed. Preview again.');
          await vfx.withCompRevision(cue.recipe.comp,plan.compRevision,async()=>vfx.updateComp(cue.recipe.comp,c=>{
            c.layers.unshift(clone(plan.layer)); c.markers.push(clone(plan.marker)); c.markers.sort((a,b)=>a.t-b.t);
            vfx.noteRun(c,{tool:'shared_cue',actor,outcome:`Apply ${cue.recipe.name}`});
          }));
          d.tracks.push(clone(plan.track)); daw.noteLedger(d,{by:byOf(actor),actor,action:'shared_cue',detail:`Apply ${cue.recipe.name}`});
        });
        cue.state='applied'; cue.appliedAt=Date.now(); cue.error=null; await write(cue); return {cue,plan};
      } catch(error) {
        cue.error=error.message; await reconcile(cue);
        const partial=cue.state==='partial';
        throw Object.assign(new Error(partial ? `${error.message} One project changed; use Undo to recover this cue.` : error.message),{code:partial?'cue_partial':'cue_conflict',cue});
      }
    });
  }
  const ownedState = (cue,project,comp) => {
    const r=cue.receipt,track=project?.tracks.find(t=>t.id===r.track.id),layer=comp?.layers.find(l=>l.id===r.layer.id);
    if(track && fingerprint(track)!==fingerprint(r.track)) throw new Error('The cue accent was edited. Restore it before Undo, or remove that track in the DAW.');
    if(track && [...(project.tracks||[]),...(project.returns||[]),project.master].filter(Boolean).some(t=>t.id!==track.id && (t.inserts||[]).some(i=>i.params?.sidechain===track.id))) throw new Error('Another DAW chain uses this accent as a sidechain. Remove that link before Undo.');
    if(layer && fingerprint(layer)!==fingerprint(r.layer)) throw new Error('The cue flash was edited. Restore it before Undo, or remove that layer in VFX.');
    const sameLabel=comp?.markers.filter(m=>m.label===r.marker.label)||[];
    if(sameLabel.some(m=>fingerprint(m)!==fingerprint(r.marker)) || sameLabel.length>1) throw new Error('The cue marker was edited. Restore it before Undo, or remove that marker in VFX.');
    // Deleting a parent must never strand somebody else's nested content.
    if(layer && comp.layers.some((l,index)=>l.id!==layer.id && (l.parent===layer.id || l.trackMatte?.layer===layer.id || (index>0 && comp.layers[index-1].id===layer.id && l.trackMatte)))) throw new Error('Another VFX layer uses this flash. Remove that link before Undo.');
    return {track,layer,marker:sameLabel[0]};
  };
  async function undo(id,actor='system') {
    idOf(id); return lock(id,async()=>{
      const cue=await reconcile(await read(id));
      if(['draft','undone'].includes(cue.state)) return {cue,alreadyUndone:true};
      if(!cue.receipt) throw new Error('This cue has no applied change to undo.');
      const [project,comp]=await docs(cue); ownedState(cue,project,comp);
      cue.state='undoing'; await write(cue);
      try {
        const removeVisual=async()=>{if(!comp) return;
          await vfx.updateComp(cue.recipe.comp,c=>{
            ownedState(cue,null,c); c.layers=c.layers.filter(l=>l.id!==cue.receipt.layer.id);
            c.markers=c.markers.filter(m=>fingerprint(m)!==fingerprint(cue.receipt.marker));
            vfx.noteRun(c,{tool:'shared_cue',actor,outcome:`Undo ${cue.recipe.name}`});
          });};
        if(project) await daw.updateProject(cue.recipe.project,async d=>{
          ownedState(cue,d,null); await removeVisual(); d.tracks=d.tracks.filter(t=>t.id!==cue.receipt.track.id);
          daw.noteLedger(d,{by:byOf(actor),actor,action:'shared_cue_undo',detail:`Undo ${cue.recipe.name}`});
        }); else await removeVisual();
        cue.state='undone'; cue.error=null; await write(cue); return {cue};
      } catch(error) {cue.error=error.message;await reconcile(cue);throw Object.assign(new Error(error.message),{code:'cue_partial',cue});}
    });
  }
  async function audition(id,previewToken) {
    const {cue,plan}=await preview(id);
    if(plan.previewToken!==previewToken) throw new Error('Preview again before auditioning this cue.');
    if(typeof renderAccent!=='function') throw new Error('The DAW accent preview renderer is unavailable.');
    const name=`pv_${plan.audioJob.notes[0].inst}_${previewAudioKey(plan.audioJob)}.wav`,dir=path.join(daw.DAW_DIR(),'_previews'),full=path.join(dir,name);
    if(!previewChains.has(name)) previewChains.set(name,(async()=>{
      await mkdir(dir,{recursive:true}); if(await stat(full).then(s=>s.size>44).catch(()=>false)) return;
      const temp=full+'.'+randomUUID()+'.tmp'; await renderAccent(clone(plan.audioJob),temp); await renameAtomic(temp,full);
    })().finally(()=>previewChains.delete(name)));
    await previewChains.get(name);
    return {cue,plan,audioUrl:`/api/daw/preview/${name}`,frameUrl:plan.frameUrl,seconds:plan.audioJob.n_samples/plan.audioJob.sr};
  }
  async function status() {
    const entries=(await readdir(root()).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))).filter(name=>/^[a-f0-9]{32}\.json$/.test(name));
    const cues=await Promise.all(entries.map(name=>lock(name.slice(0,-5),async()=>reconcile(await read(name.slice(0,-5))))));
    return {ok:true,capabilities:{...SHARED_CUE_CAPABILITIES,audioPreview:typeof renderAccent==='function'},
      projects:await daw.listProjects(),comps:await vfx.listComps(),cues:cues.sort((a,b)=>b.updatedAt-a.updatedAt)};
  }
  return {save,preview,apply,undo,audition,status,read:async id=>lock(id,async()=>({cue:await reconcile(await read(id))}))};
}

export function createSharedCueRoutes({json,readBody,renderAccent,...options}) {
  const service=createSharedCueService({...options,renderAccent});
  return async(req,res,url)=>{
    if(url.pathname!=='/api/music-cues') return false;
    try {
      if(req.method==='GET') {json(res,200,await service.status());return true;}
      if(req.method!=='POST') {json(res,405,{error:'Use GET or POST.'});return true;}
      const b=await readBody(req),actor=actorFrom(req); let result;
      const allowed={save:['action','id','name','project','comp','bar','beat','tick','accent','velocity','gainDb','durationBeats','flashStrength','compOffsetSeconds'],preview:['action','id'],read:['action','id'],apply:['action','id','previewToken'],undo:['action','id'],audition:['action','id','previewToken']};
      if(!b||!allowed[b.action]) throw new Error('Choose save, preview, read, apply, undo or audition.');
      for(const key of Object.keys(b)) if(!allowed[b.action].includes(key)) throw new Error(`Unsupported cue field: ${key}.`);
      if(b.action==='save') {const {action,...input}=b;result=await service.save(input,actor);}
      if(b.action==='preview') result=await service.preview(b.id);
      if(b.action==='read') result=await service.read(b.id);
      if(b.action==='apply') result=await service.apply(b.id,b.previewToken,actor);
      if(b.action==='undo') result=await service.undo(b.id,actor);
      if(b.action==='audition') result=await service.audition(b.id,b.previewToken);
      json(res,200,{ok:true,...result});
    }catch(error){json(res,error.code==='cue_partial'||error.code==='cue_conflict'?409:400,{error:error.message,code:error.code,cue:error.cue});}
    return true;
  };
}
