/** Immutable, local outfit snapshots. World always performs its own admission. */
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile, rename, rm} from 'node:fs/promises';
import {composeAvatarVrm, COMPOSITION_LIMITS} from './avatar-composition.js';
import {WARDROBE_LIMITS} from './avatar-wardrobe.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const avatarId = /^av_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const lookId = /^look_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exportId = /^outfit_[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{64}$/;
const seedSha = '12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2';
const files = {'outfit.vrm':'model/gltf-binary','outfit.aiplay-avatar.json':'application/json; charset=utf-8','manifest.json':'application/json; charset=utf-8'};
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const identity = row => `outfit_${hash(Buffer.from(JSON.stringify({bundleSha256:row.bundleSha256,avatarId:row.avatarId,lookId:row.lookId,lookRevision:row.lookRevision,wardrobeRevision:row.wardrobeRevision})))}`;
const fields = (value, allowed) => {
  if(!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw fail('Unsupported outfit export fields.');
};
export function createAvatarHandoff({directory, inspectAsset, appearance, wardrobe, record=async()=>{}, compose=composeAvatarVrm}) {
  let pending = null;
  function check(input) {
    fields(input,['id','sha256','look_id','expected_look_revision','expected_wardrobe_revision']);
    if(!avatarId.test(input.id||'') || !sha.test(input.sha256||'')) throw fail('An avatar id and source SHA-256 are required.');
    if(input.look_id!==null && !lookId.test(input.look_id||'')) throw fail('Choose a saved look or the base outfit.');
    for(const key of ['expected_look_revision','expected_wardrobe_revision']) if(!Number.isSafeInteger(input[key]) || input[key]<0) throw fail('Current look and outfit revisions are required.');
    if(input.look_id===null && input.expected_look_revision!==0) throw fail('The base outfit has no saved look revision.');
  }
  async function snapshot(input) {
    const base=await inspectAsset(input.id);
    if(base.row.id!==input.id || base.row.inspection.profile!=='vrm') throw fail('Outfit export requires an imported VRM 1.0 avatar.',422);
    if(hash(base.bytes)!==input.sha256 || base.row.inspection.sha256!==input.sha256) throw fail('Avatar changed. Reopen it before exporting.',409);
    const look=input.look_id===null ? null : await appearance.get(input.id,input.look_id);
    const selected=await wardrobe.selection({id:input.id,look_id:input.look_id});
    if((look?.revision??0)!==input.expected_look_revision || selected.revision!==input.expected_wardrobe_revision) throw fail('Look or outfit changed. Refresh it before exporting.',409);
    if((look && (look.sha256!==input.sha256 || look.avatarId!==input.id)) || selected.sha256!==input.sha256) throw fail('Outfit source changed.',409);
    return {base,look,selected};
  }
  async function prepare(raw, actor='system') {
    const input=structuredClone(raw);check(input);
    if(pending) throw fail('An outfit export is already running.',409);
    const token={};pending=token;
    let temporary;
    try {
      const before=await snapshot(input), parts=[];
      const selectedIds=before.selected.part_ids, selectedParts=before.selected.parts;
      if(!Array.isArray(selectedIds) || selectedIds.length>COMPOSITION_LIMITS.parts || new Set(selectedIds).size!==selectedIds.length ||
        !Array.isArray(selectedParts) || selectedParts.length!==selectedIds.length) throw fail('Saved outfit inventory is incomplete. Refresh it before exporting.',409);
      const advertised=new Map();
      let advertisedBytes=before.base.bytes.length, actualBytes=before.base.bytes.length;
      for(const part of selectedParts) {
        const size=part?.inspection?.bytes;
        if(!selectedIds.includes(part?.id) || advertised.has(part.id) || !Number.isSafeInteger(size) || size<=0 || size>WARDROBE_LIMITS.bytes) throw fail('Saved part size changed. Inspect the outfit again.',409);
        advertised.set(part.id,size);advertisedBytes+=size;
      }
      if(advertisedBytes>COMPOSITION_LIMITS.bytes) throw fail('Outfit input total exceeds 64 MiB. Select fewer or smaller parts.',413);
      for(const part_id of before.selected.part_ids) {
        const part=await wardrobe.file({id:input.id,part_id});
        if(!Buffer.isBuffer(part.bytes) || part.bytes.length!==advertised.get(part_id)) throw fail('A selected part changed size during export.',409);
        actualBytes+=part.bytes.length;
        if(actualBytes>COMPOSITION_LIMITS.bytes) throw fail('Outfit input total exceeds 64 MiB.',413);
        parts.push({id:part_id,bytes:part.bytes,sha256:part.row.sha256,name:part.row.name,slot:part.row.slot,source:part.row.source,license:part.row.license});
      }
      const composed=await compose({baseBytes:before.base.bytes,baseSha256:input.sha256,parts});
      if(!Buffer.isBuffer(composed.bytes) || hash(composed.bytes)!==composed.sha256) throw fail('Composed avatar integrity check failed.',422);
      const after=await snapshot(input);
      if(!same(before.look,after.look) || !same(before.selected,after.selected)) throw fail('Look or outfit changed during export. Try again.',409);
      // Detect deletion or modification while composition was running, including source metadata.
      for(const expected of parts) {
        const current=await wardrobe.file({id:input.id,part_id:expected.id});
        if(current.row.sha256!==expected.sha256 || hash(current.bytes)!==expected.sha256 ||
          ['name','slot','source','license'].some(key=>current.row[key]!==expected[key])) throw fail('A selected part changed during export.',409);
      }
      const name=(before.look?.name || before.base.row.name).slice(0,80);
      const bundle={schema:'aiplay.avatar-outfit.v1',name,base_sha256:input.sha256,sha256:composed.sha256,
        data_base64:composed.bytes.toString('base64'),appearance:{name,settings:before.look?.settings || {hidden_nodes:[],material_colors:{},expressions:{},spring_enabled:true}},
        parts:parts.map(({sha256,name,slot,source,license})=>({sha256,name,slot,source,license}))};
      const bundleBytes=Buffer.from(JSON.stringify(bundle));
      const context={bundleSha256:hash(bundleBytes),avatarId:input.id,lookId:input.look_id,lookRevision:input.expected_look_revision,wardrobeRevision:input.expected_wardrobe_revision};
      const id=identity(context), target=path.join(directory,id);
      await mkdir(directory,{recursive:true});
      const names=await readdir(directory);
      const manifest={schema:1,id,avatarId:input.id,baseSha256:input.sha256,sha256:composed.sha256,bytes:composed.bytes.length,
        bundleSha256:hash(bundleBytes),name,lookId:input.look_id,lookRevision:input.expected_look_revision,wardrobeRevision:input.expected_wardrobe_revision,
        parts:bundle.parts,inspection:composed.manifest,review:'needs_visual_review',
        worldCandidate:input.sha256===seedSha && composed.bytes.length<=16*1024*1024,
        files:{bundle:`/api/avatars/handoff/${id}/outfit.aiplay-avatar.json`,vrm:`/api/avatars/handoff/${id}/outfit.vrm`,manifest:`/api/avatars/handoff/${id}/manifest.json`}};
      if(!names.includes(id)) {
        if(names.filter(n=>exportId.test(n)).length>=64) throw fail('The local outfit export shelf is full (64 files).',409);
        temporary=path.join(directory,`.${randomUUID()}.tmp`);await mkdir(temporary);
        await writeFile(path.join(temporary,'outfit.vrm'),composed.bytes,{flag:'wx'});
        await writeFile(path.join(temporary,'outfit.aiplay-avatar.json'),bundleBytes,{flag:'wx'});
        await writeFile(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
        await rename(temporary,target);temporary=null;
      } else {
        // Never turn an export ID into a mutable URL, even after disk corruption.
        const existing=await get(id);
        if(existing.sha256!==manifest.sha256 || existing.bundleSha256!==manifest.bundleSha256) throw fail('Existing outfit export changed on disk.',409);
        // A valid manifest alone cannot establish that both downloads still
        // exist and contain the immutable snapshot their URLs promise.
        await file(id,'outfit.vrm');
        await file(id,'outfit.aiplay-avatar.json');
      }
      await record({type:'export',actor,asset:`avatar/${input.id}`,data:{op:'avatar_outfit_export',id,sha256:composed.sha256,baseSha256:input.sha256,lookId:input.look_id,partIds:parts.map(p=>p.id)}});
      return {...await get(id),localFiles:{bundle:path.join(target,'outfit.aiplay-avatar.json'),vrm:path.join(target,'outfit.vrm'),manifest:path.join(target,'manifest.json')}};
    } finally {
      if(temporary && path.dirname(path.resolve(temporary))===path.resolve(directory)) await rm(temporary,{recursive:true,force:true});
      if(pending===token) pending=null;
    }
  }
  async function get(id) {
    if(!exportId.test(id||'')) throw fail('Invalid outfit export id.');
    let row;
    try {row=JSON.parse(await readFile(path.join(directory,id,'manifest.json'),'utf8'));}
    catch(e){if(e.code==='ENOENT')throw fail('Outfit export not found.',404);throw e;}
    if(row.id!==id || !sha.test(row.sha256) || !sha.test(row.bundleSha256) || identity(row)!==id) throw fail('Outfit export identity changed.',409);
    return row;
  }
  async function file(id,name) {
    if(!Object.hasOwn(files,name)) throw fail('Unknown outfit export file.',404);
    const row=await get(id), bytes=await readFile(path.join(directory,id,name));
    if(name==='outfit.vrm' && hash(bytes)!==row.sha256 || name==='outfit.aiplay-avatar.json' && hash(bytes)!==row.bundleSha256) throw fail('Outfit export bytes changed.',409);
    return {row,bytes,type:files[name]};
  }
  return {prepare,get,file};
}

/** Parent enforces Studio's same-origin loopback guard before mounting. */
export function createAvatarHandoffRoutes({json,provenance,...options}) {
  const service=createAvatarHandoff({...options,record:event=>provenance.append('library',event)});
  return async(req,res,url)=>{
    const match=url.pathname.match(/^\/api\/avatars\/handoff\/(outfit_[a-f0-9]{64})\/(outfit\.vrm|outfit\.aiplay-avatar\.json|manifest\.json)$/);
    if(match && req.method==='GET') {
      const {bytes,type}=await service.file(match[1],match[2]);
      res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Content-Disposition':`attachment; filename="${match[2]}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
    }
    if(url.pathname!=='/api/avatars/handoff') return false;
    if(req.method!=='POST') throw fail('Use POST for outfit exports.',405);
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw fail('Outfit export requires JSON.',415);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)throw fail('Outfit request too large.',413);chunks.push(chunk);}
    let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('Invalid outfit JSON.');}
    const {action,...args}=input||{};let result;
    if(action==='prepare') result=await service.prepare(args,provenance.actorFrom(req));
    else if(action==='get'){fields(args,['export_id']);result=await service.get(args.export_id);}
    else throw fail('Unknown outfit export action.');
    json(res,200,result);return true;
  };
}
