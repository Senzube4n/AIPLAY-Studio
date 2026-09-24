/** Local avatar review shelf. Persona attribution is not an AIPlay ownership/binding grant. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import validator from 'gltf-validator';
import { readGlb, assertSkinned } from './glb.js';
import { deformReport } from './deform.js';
import { createExampleInstaller, AVATAR_EXAMPLE } from './avatar-example.js';
import { createAppearanceService } from './appearance.js';
import { createAvatarPlaybackRoutes } from './avatar-playback.js';
import { createAvatarWardrobe, createAvatarWardrobeRoutes } from './avatar-wardrobe.js';
import { createAvatarHandoffRoutes } from './avatar-handoff.js';
import { VRM_LIMITS, VRM_EXTENSIONS, inspectVrmDocument } from './vrm-profile.js';

export const AVATAR_LIMITS = Object.freeze({ bytes: 8*1024*1024, triangles: 30000, materials: 4, joints: 96, textureSide: 1024, texturePixels: 4*1024*1024 });
const fault = (message, status=400) => Object.assign(new Error(message), {status});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requiredClips = ['idle', 'walk', 'run'];
const text = (v, name, max=240) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw fault(`${name} is required (maximum ${max} characters).`);
  return v.trim();
};
function dimensions(bytes, mime) {
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset=2;
    while (offset+9 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      let marker=bytes[offset++]; while (marker===255) marker=bytes[offset++];
      if (marker===217 || marker===218) break;
      const length=bytes.readUInt16BE(offset);
      if (length<2 || offset+length>bytes.length) break;
      if ([192,193,194].includes(marker)) return [bytes.readUInt16BE(offset+5), bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  throw fault('Every texture must be an embedded, readable PNG or JPEG.');
}

export async function inspectAvatar(bytes, profile="world") {
  if(!["world","vrm"].includes(profile)) throw fault("Unknown avatar profile.");
  const limits=profile==="vrm"?VRM_LIMITS:AVATAR_LIMITS;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length>limits.bytes) throw fault(`Avatar must be nonempty and at most ${limits.bytes/1024/1024} MiB.`, 413);
  const g=readGlb(bytes);
  if (!g.ok) throw fault(g.why.join('; '),422);
  const j=g.json;
  if (j.buffers?.some(b=>b.uri) || j.images?.some(i=>i.uri)) throw fault('Embed all buffers and textures in the GLB; external and data URIs are not accepted.',422);
  // A review viewer must not load extensions it cannot faithfully render.
  const allowed=new Set(['KHR_materials_unlit','KHR_materials_emissive_strength','KHR_texture_transform']);
  if(profile==='vrm') for(const extension of VRM_EXTENSIONS) allowed.add(extension);
  const unsupported=[...new Set([...(j.extensionsUsed||[]),...(j.extensionsRequired||[])])].filter(x=>!allowed.has(x));
  if (unsupported.length) throw fault(`Export standard PBR without unsupported extensions: ${unsupported.join(', ')}.`,422);
  const vrm=profile==='vrm'?inspectVrmDocument(j):null;
  if ((j.nodes?.length||0)>512 || (j.accessors?.length||0)>4096 || (j.animations?.length||0)>32) throw fault('Avatar scene exceeds the local review complexity limit.',422);
  const report=await validator.validateBytes(new Uint8Array(bytes), {format:'glb', maxIssues:100, externalResourceFunction:()=>Promise.reject(new Error('External resources are disabled.'))});
  if (report.issues.numErrors) throw fault(`glTF validation failed: ${report.issues.messages.filter(x=>x.severity===0).slice(0,6).map(x=>`${x.code}: ${x.message}`).join('; ')}`,422);
  const skin=assertSkinned(j,g.binData);
  if (!skin.ok) throw fault(`Unusable skin: ${skin.why.join('; ')}`,422);
  /* ⚠ AND THE HALF assertSkinned CANNOT ASK. A GLB whose every vertex is
   * weighted to the root passes every structural check there is — same skins[],
   * same bind matrices, every weight row summing to one — and is not a rig: it
   * is a handle. `server/mesh/deform.js` poses the skeleton and measures the
   * change in the mesh's own internal distances, which is the only thing that
   * separates the two. This is the surface where people hand each other files,
   * so it is the surface that most needs the question asked.
   *
   * THREE STATES, AND ONLY ONE OF THEM IS ADMISSION. `deforms` is a pass;
   * `rigid` is a measured refusal; `unreadable` is "nobody could measure this",
   * which is also a refusal — an unasked question is not a yes. `bpy:false`
   * keeps this closed-form and in-process, because it runs on an upload path
   * and Blender is a GPL subprocess this tree does not require; the report
   * therefore carries the Blender cross-check as UNRUN, in those words, so its
   * absence cannot be read as its approval. */
  const deform=await deformReport(null,j,g.binData,{bpy:false});
  if (deform.state!=='deforms') throw fault(deform.state==='rigid'
    ? `The skin binds but does not deform: ${deform.why.join('; ')}`
    : `The skin could not be posed, so it was not shown to deform (this is not a pass): ${deform.why.join('; ')}`,422);
  const allJoints=new Set((j.skins||[]).flatMap(s=>s.joints));
  if (allJoints.size>limits.joints) throw fault(`Avatar exceeds the ${limits.joints}-joint budget.`,422);
  let triangles=0, primitives=0;
  for (const mesh of j.meshes||[]) for (const p of mesh.primitives||[]) {
    if ((p.mode??4)!==4) throw fault('Avatar primitives must be triangles.',422);
    triangles+=(j.accessors[p.indices??p.attributes.POSITION]?.count||0)/3; primitives++;
    if (!Number.isInteger(p.material) || !j.materials?.[p.material]) throw fault('Every primitive needs an explicit PBR material.',422);
  }
  const materials=j.materials?.length||0;
  if (triangles>limits.triangles || materials>limits.materials || primitives>(vrm?128:16)) throw fault(`Avatar exceeds ${limits.triangles} triangles, ${limits.materials} materials or ${vrm?128:16} primitives.`,422);
  const textures=(j.images||[]).map((image,index)=>{
    const v=j.bufferViews?.[image.bufferView];
    if (!v || v.buffer!==0) throw fault('Texture must use the embedded binary buffer.',422);
    const [width,height]=dimensions(g.binData.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength),image.mimeType);
    if (!width || !height || width>limits.textureSide || height>limits.textureSide) throw fault(`Texture dimensions exceed ${limits.textureSide} pixels.`,422);
    return {index,width,height,mimeType:image.mimeType};
  });
  const texturePixels=textures.reduce((n,t)=>n+t.width*t.height,0);
  if (texturePixels>limits.texturePixels) throw fault('Combined textures exceed the selected profile budget.',422);
  const clips=(j.animations||[]).map((clip,index)=>{
    const ends=clip.samplers.map(s=>j.accessors[s.input].max?.[0]??0);
    return {index,name:clip.name||`Animation ${index+1}`,duration:Math.max(0,...ends),channels:clip.channels.length};
  });
  const names=new Set(clips.map(c=>c.name.toLowerCase()));
  const missingClips=requiredClips.filter(n=>!names.has(n));
  const jointNames=[...allJoints].map(i=>({index:i,name:j.nodes[i].name||`node_${i}`}));
  const anchors=(j.nodes||[]).map((n,index)=>({name:n.name,index})).filter(n=>/^(anchor_(chest|back|hand_l|hand_r))$/i.test(n.name||''));
  const warnings=report.issues.messages.filter(x=>x.severity===1).map(x=>`${x.code}: ${x.message}`);
  if (!textures.length) warnings.push('No image textures; material colours only.');
  if (missingClips.length) warnings.push(`Missing own embedded clips: ${missingClips.join(', ')}.`);
  if (anchors.length<4) warnings.push('Chest, back and both hand attachment anchors are not all present.');
  return {profile,vrm,sha256:digest(bytes),bytes:bytes.length,triangles,primitives,materials,joints:allJoints.size,jointNames,textures,texturePixels,clips,anchors,
    validation:{validator:validator.version(),errors:0,warnings},missingClips,
    deformation:{state:deform.state,strain:deform.strain,joint:deform.jointName,probeDegrees:deform.probeDegrees,
      minStrain:deform.minStrain,sampled:deform.sampled,vertices:deform.vertices,probedJoints:deform.probedJoints,
      crossCheck:deform.cross.state,crossAgreed:deform.agree},
    state:'needs_visual_review',limits,
    caveat:'The skin was posed and its vertices really move, but that is existence, not quality: structural validation does not verify identity, deformation QUALITY (weights, volume loss, candy-wrapper twists), in-place motion, phone performance or account ownership. The Blender cross-check is UNRUN on this path, which is not a second opinion in favour.'};
}

export function createAvatarService({directory,record=async()=>{}}) {
  const idPath=id=>{
    if (!/^av_[a-f0-9-]{36}$/.test(String(id))) throw fault('Invalid avatar id.');
    return path.join(directory,id);
  };
  async function get(id) {
    try { const row=JSON.parse(await readFile(path.join(idPath(id),'manifest.json'),'utf8')); if(row.id!==id) throw fault('Avatar identity mismatch.',409); return row; }
    catch(e) { if(e.code==='ENOENT') throw fault('Avatar not found.',404); throw e; }
  }
  async function file(id) {
    const row=await get(id), bytes=await readFile(path.join(idPath(id),'avatar.glb'));
    if(digest(bytes)!==row.inspection.sha256) throw fault('Avatar changed on disk; import the changed file as a new version.',409);
    return {row,bytes};
  }
  async function list() {
    await mkdir(directory,{recursive:true}); const rows=[];
    for(const id of await readdir(directory)) if(/^av_[a-f0-9-]{36}$/.test(id)) { try { rows.push(await get(id)); } catch { /* incomplete transaction is not an asset */ } }
    return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async function importAsset(input,actor='system') {
    const profile=input.profile||'world', limits=profile==='vrm'?VRM_LIMITS:AVATAR_LIMITS;
    if(!['world','vrm'].includes(profile)) throw fault('Unknown avatar profile.');
    const name=text(input.name,'Name',100), license=text(input.license,'License/provenance',2000), source=text(input.source,'Source description',2000);
    const family=text(input.skeleton_family,'Skeleton family',100);
    const facing=input.facing;
    if(!['+Z','-Z','+X','-X'].includes(facing)) throw fault('Declare the character facing direction.');
    const personaId=input.persona_id===undefined||input.persona_id===''?null:String(input.persona_id);
    if(personaId!==null && !/^[1-9]\d{0,11}$/.test(personaId)) throw fault('Persona id must be a positive numeric attribution.');
    if(Boolean(input.path)===Boolean(input.data_base64)) throw fault('Supply exactly one local path or base64 GLB upload.');
    let bytes;
    if(input.path) {
      if(!path.isAbsolute(input.path)||!(profile==='vrm'?['.vrm','.glb']:['.glb']).includes(path.extname(input.path).toLowerCase())) throw fault('Use an absolute local GLB or VRM path for the selected profile.');
      const info=await stat(input.path); if(!info.isFile()||info.size>limits.bytes) throw fault(`Input exceeds the ${limits.bytes/1024/1024} MiB profile limit.`,413);
      bytes=await readFile(input.path);
    } else {
      if(typeof input.data_base64!=='string'||input.data_base64.length>Math.ceil(limits.bytes*4/3)+4||input.data_base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data_base64)) throw fault('Invalid base64 GLB upload.');
      bytes=Buffer.from(input.data_base64,'base64');
      if(bytes.toString('base64')!==input.data_base64) throw fault('Invalid base64 GLB upload.');
    }
    const inspection=await inspectAvatar(bytes,profile),id=`av_${randomUUID()}`;
    const row={schema:1,id,name,createdAt:new Date().toISOString(),actor,personaAttribution:{personaId,authority:'unverified source attribution; not an account binding'},source,license,skeletonFamily:family,coordinates:{units:'metres',up:'+Y',facing,declaredBy:actor},inspection,
      review:{state:'pending',note:'Inspect identity, skin deformation, foot contact, in-place motion and attachments before world adoption.'},
      files:{glb:`/api/avatars/${id}/avatar.glb`,manifest:`/api/avatars/${id}/manifest.json`},previewUrl:`/avatars.html?id=${id}`};
    await mkdir(idPath(id),{recursive:true});
    await writeFile(path.join(idPath(id),'avatar.glb'),bytes,{flag:'wx'});
    await record({type:'import',actor,asset:`avatar/${id}`,data:{sha256:inspection.sha256,name,source,license,personaAttribution:row.personaAttribution}});
    await writeFile(path.join(idPath(id),'manifest.tmp'),JSON.stringify(row,null,2),{flag:'wx'});
    await rename(path.join(idPath(id),'manifest.tmp'),path.join(idPath(id),'manifest.json'));
    return row;
  }
  async function inspect(id) { const {row,bytes}=await file(id); return {...row,inspection:await inspectAvatar(bytes,row.inspection.profile||"world")}; }
  async function exportAsset(id,actor='system') {
    const row=await inspect(id);
    await record({type:'export',actor,asset:`avatar/${id}`,data:{sha256:row.inspection.sha256,destination:'local handoff',reviewState:row.review.state}});
    return {...row,localFiles:{glb:path.join(idPath(id),'avatar.glb'),manifest:path.join(idPath(id),'manifest.json')},
      handoff:'Pass the GLB and manifest together. World installation requires its own owner-scoped import, inspected allowlist and adapter; no binding was changed.'};
  }
  return {list,get,file,importAsset,inspect,exportAsset};
}

function localRequest(req) {
  const local=new Set(['localhost','127.0.0.1','[::1]']); let here;
  try { const host=req.headers.host; here=new URL(`http://${host}`); if(!local.has(here.hostname)||here.host!==host||here.pathname!=='/'||here.search||here.hash||(req.socket?.localPort&&Number(here.port||80)!==req.socket.localPort)) throw Error(); }
  catch { throw fault('Avatar access requires this Studio loopback Host and port.',403); }
  if(req.headers['sec-fetch-site']==='cross-site') throw fault('Open avatars from this Studio window.',403);
  if(req.headers.origin!==undefined && req.headers.origin!==here.origin) throw fault('Open avatars from this Studio window.',403);
}
export function createAvatarRoutes({directory,json,provenance}) {
  const service=createAvatarService({directory,record:event=>provenance.append('library',event)});
  const playback=createAvatarPlaybackRoutes({directory:path.join(directory,'playback'),inspectAsset:service.file,json,provenance});
  const installExample=createExampleInstaller(service);
  const appearance=createAppearanceService({directory:path.join(directory,'looks'),inspectAsset:service.file,record:event=>provenance.append('library',event)});
  const wardrobe=createAvatarWardrobeRoutes({directory:path.join(directory,'wardrobe'),inspectAsset:service.file,inspectLook:(id,lookId)=>appearance.get(id,lookId),json,provenance});
  const handoff=createAvatarHandoffRoutes({directory:path.join(directory,'handoffs'),inspectAsset:service.file,appearance,
    wardrobe:createAvatarWardrobe({directory:path.join(directory,'wardrobe'),inspectAsset:service.file,inspectLook:(id,lookId)=>appearance.get(id,lookId)}),json,provenance});
  const vendor=new Map([
    ['three.module.js','build/three.module.js'],['three.core.js','build/three.core.js'],
    ['loaders/GLTFLoader.js','examples/jsm/loaders/GLTFLoader.js'],['controls/OrbitControls.js','examples/jsm/controls/OrbitControls.js'],
    ['utils/BufferGeometryUtils.js','examples/jsm/utils/BufferGeometryUtils.js'],['utils/SkeletonUtils.js','examples/jsm/utils/SkeletonUtils.js'],
    ['LICENSE','LICENSE'],
  ]);
  return async(req,res,url)=>{
    if(url.pathname!=='/api/avatars'&&!url.pathname.startsWith('/api/avatars/')) return false;
    try {
      localRequest(req);
      res.setHeader('Cache-Control','private, no-store'); res.setHeader('X-Content-Type-Options','nosniff');
      if(await playback(req,res,url))return true;
      if(await wardrobe(req,res,url))return true;
      if(await handoff(req,res,url))return true;
      if(req.method==='GET'&&['/api/avatars/vendor/three-vrm.module.js','/api/avatars/vendor/three-vrm-LICENSE'].includes(url.pathname)) {
        const name=url.pathname.endsWith('LICENSE')?'LICENSE':'lib/three-vrm.module.js';
        const bytes=await readFile(fileURLToPath(new URL(`../../node_modules/@pixiv/three-vrm/${name}`,import.meta.url)));
        res.writeHead(200,{'Content-Type':name==='LICENSE'?'text/plain':'text/javascript; charset=utf-8'});res.end(bytes);return true;
      }
      const module=vendor.get(url.pathname.replace('/api/avatars/vendor/',''));
      if(req.method==='GET'&&url.pathname.startsWith('/api/avatars/vendor/')&&module) {
        const bytes=await readFile(fileURLToPath(new URL(`../../node_modules/three/${module}`,import.meta.url)));
        res.writeHead(200,{'Content-Type':module==='LICENSE'?'text/plain':'text/javascript; charset=utf-8'});res.end(bytes);return true;
      }
      const match=url.pathname.match(/^\/api\/avatars\/(av_[a-f0-9-]{36})\/(avatar\.glb|manifest\.json|appearance\.json)$/);
      if(req.method==='GET'&&match) {
        const {row,bytes}=await service.file(match[1]);
        if(match[2]==='appearance.json') {json(res,200,await appearance.active(match[1]));return true;}
        if(match[2]==='manifest.json') {json(res,200,row);return true;}
        res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Content-Disposition':`inline; filename="${match[1]}.glb"`});res.end(bytes);return true;
      }
      if(url.pathname!=='/api/avatars') throw fault('Avatar route not found.',404);
      if(req.method==='GET') {json(res,200,{avatars:await service.list(),limits:AVATAR_LIMITS,vrmLimits:VRM_LIMITS,example:AVATAR_EXAMPLE});return true;}
      if(req.method!=='POST') throw fault('Use GET or POST.',405);
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw fault('Avatar POST requires application/json.',415);
      const limit=Math.ceil(VRM_LIMITS.bytes*4/3)+10000,chunks=[];let size=0;
      for await(const part of req) {size+=part.length;if(size>limit)throw fault('Avatar request exceeds 64 MiB upload limit.',413);chunks.push(part);}
      let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('Invalid JSON.');}
      if(!b||typeof b!=='object'||Array.isArray(b))throw fault('Request must be an object.');
      const actor=provenance.actorFrom(req);let result;
      const {action,...input}=b;
      if(action==='install_example') result=await installExample(actor);
      else if(action==='appearance_inventory') result=await appearance.inventory(b.id);
      else if(action==='appearance_list') result=await appearance.list(b.id);
      else if(action==='appearance_get') result=await appearance.get(b.id,b.look_id);
      else if(action==='appearance_save') result=await appearance.save(input,actor);
      else if(action==='appearance_delete') result=await appearance.remove(input,actor);
      else if(action==='appearance_active') result=await appearance.active(b.id);
      else if(action==='appearance_activate') result=await appearance.activate(input,actor);
      else if(b.action==='import') result=await service.importAsset(b,actor);
      else if(b.action==='inspect')result=await service.inspect(b.id);
      else if(b.action==='export'){result=await service.exportAsset(b.id,actor);const look=await appearance.active(b.id);if(look)result={...result,appearance:look,files:{...result.files,look:`/api/avatars/${b.id}/appearance.json`}};}
      else throw fault('Unknown avatar action.');
      json(res,200,result);
    } catch(e) {json(res,e.status||500,{error:e.message});}
    return true;
  };
}
