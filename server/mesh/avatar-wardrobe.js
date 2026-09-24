/** Fitted local parts, pinned to one imported avatar and its original skeleton. */
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rename,unlink,stat} from 'node:fs/promises';
import {Matrix4,Vector3,Quaternion} from 'three';
import validator from 'gltf-validator';
import {readGlb,assertSkinned,skinAccessor} from './glb.js';

export const WARDROBE_LIMITS=Object.freeze({bytes:32*1024*1024,triangles:60000,vertices:180000,materials:16,joints:256,nodes:512,parts:64,selected:8,textureSide:2048,texturePixels:16*1024*1024});
export const WARDROBE_SLOTS=Object.freeze(['hair','head','body','outfit','shoes','accessory']);
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const avatarPattern=new RegExp(`^av_${UUID}$`),partPattern=new RegExp(`^part_${UUID}$`),lookPattern=new RegExp(`^look_${UUID}$`);
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pin=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fault('A source SHA-256 is required.');return value;};
const checked=(value,pattern,label)=>{if(typeof value!=='string'||!pattern.test(value))throw fault(`Invalid ${label}.`);return value;};
const fields=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw fault('Unsupported wardrobe fields.');};
const text=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw fault(`${label} is required (up to ${max} characters).`);return value.trim();};
const queues=new Map();
async function serial(key,work){const prior=queues.get(key)||Promise.resolve(),next=prior.catch(()=>{}).then(work);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
async function atomic(file,value){const temp=`${file}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const near=(a,b)=>a.elements.every((v,i)=>Math.abs(v-b.elements[i])<=.0001*Math.max(1,Math.abs(v),Math.abs(b.elements[i])));

function hierarchy(json){
  const nodes=json.nodes||[],parents=new Map(),worlds=new Map(),active=new Set();
  for(let i=0;i<nodes.length;i++)for(const child of nodes[i].children||[]){if(!Number.isInteger(child)||!nodes[child]||parents.has(child))throw fault('Invalid or shared skeleton hierarchy.',422);parents.set(child,i);}
  function world(index,trail=new Set()){
    if(worlds.has(index))return worlds.get(index);
    if(trail.has(index)||!nodes[index])throw fault('Invalid skeleton cycle.',422);trail.add(index);
    const n=nodes[index],local=n.matrix?new Matrix4().fromArray(n.matrix):new Matrix4().compose(new Vector3().fromArray(n.translation||[0,0,0]),new Quaternion().fromArray(n.rotation||[0,0,0,1]),new Vector3().fromArray(n.scale||[1,1,1]));
    const result=parents.has(index)?world(parents.get(index),trail).clone().multiply(local):local;
    if(!result.elements.every(Number.isFinite)||Math.abs(result.determinant())<1e-12)throw fault('Skeleton has a nonfinite or singular rest transform.',422);
    worlds.set(index,result);return result;
  }
  function visit(index){if(active.has(index)||!nodes[index])throw fault('Invalid default scene hierarchy.',422);active.add(index);for(const child of nodes[index].children||[])visit(child);}
  for(const root of json.scenes?.[json.scene??0]?.nodes||[])visit(root);
  for(let i=0;i<nodes.length;i++)world(i);
  return {parents,worlds,active};
}

function baseSkeleton(json){
  const graph=hierarchy(json),joints=[...new Set((json.skins||[]).flatMap(s=>s.joints||[]))].sort((a,b)=>a-b),names=new Map();
  if(!joints.length||joints.length>256)throw fault('Base needs a bounded imported skeleton.',422);
  for(const index of joints){const name=json.nodes[index]?.name;if(typeof name!=='string'||!name||name.length>160||names.has(name)||!graph.active.has(index))throw fault('Base joints need unique names in the active scene.',422);names.set(name,index);}
  return {...graph,joints,names};
}
function textureSize(bytes,mime){
  if(mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216){let o=2;while(o+9<=bytes.length){if(bytes[o++]!==255)break;let marker=bytes[o++];while(marker===255)marker=bytes[o++];if(marker===217||marker===218)break;const len=bytes.readUInt16BE(o);if(len<2||o+len>bytes.length)break;if([192,193,194].includes(marker))return [bytes.readUInt16BE(o+5),bytes.readUInt16BE(o+3)];o+=len;}}
  throw fault('Part textures must be embedded PNG or JPEG.',422);
}

/** Validates independent exported bytes before they may share live base bones. */
export async function inspectWardrobePart(bytes,baseBytes,baseHash){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>WARDROBE_LIMITS.bytes)throw fault('Part must be a GLB up to 32 MiB.',413);
  const parsed=readGlb(bytes),base=readGlb(baseBytes);if(!parsed.ok||!base.ok)throw fault('Invalid GLB container.',422);
  const j=parsed.json,b=base.json;
  if((j.nodes?.length||0)>512||(j.accessors?.length||0)>4096||(j.meshes?.length||0)>64||(j.materials?.length||0)>16||(j.animations?.length||0)>0)throw fault('Part exceeds the mesh budget or contains independent animation.',422);
  if(j.buffers?.length!==1||j.buffers.some(x=>x.uri!==undefined)||j.images?.some(x=>x.uri!==undefined))throw fault('Embed every part buffer and texture.',422);
  const allowed=new Set(['KHR_materials_unlit','KHR_materials_emissive_strength','KHR_texture_transform']);
  function extensions(value){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(key==='extensions'&&Object.keys(child||{}).some(name=>!allowed.has(name)))throw fault('Parts use standard PBR only, with no duplicate VRM or physics state.',422);if(key!=='extras')extensions(child);}}
  if([...(j.extensionsUsed||[]),...(j.extensionsRequired||[])].some(x=>!allowed.has(x)))throw fault('Unsupported part extension.',422);extensions(j);
  const report=await validator.validateBytes(new Uint8Array(bytes),{format:'glb',maxIssues:50,externalResourceFunction:async()=>{throw Error('External resources disabled.');}});
  if(report.issues.numErrors)throw fault(`Part failed glTF validation (${report.issues.numErrors} errors).`,422);
  const skin=assertSkinned(j,parsed.binData);if(!skin.ok)throw fault(`Unusable part weights: ${skin.why.join('; ')}`,422);
  const baseGraph=baseSkeleton(b),graph=hierarchy(j),mapped=new Map(),partNames=new Set();
  const joints=[...new Set((j.skins||[]).flatMap(s=>s.joints||[]))];if(joints.length>256)throw fault('Part exceeds 256 joints.',422);
  for(const index of joints){const name=j.nodes[index]?.name,baseIndex=baseGraph.names.get(name);if(baseIndex===undefined||partNames.has(name)||!graph.active.has(index))throw fault('Part joints must map uniquely to this base skeleton.',422);partNames.add(name);mapped.set(index,baseIndex);if(!near(graph.worlds.get(index),baseGraph.worlds.get(baseIndex)))throw fault(`Part rest pose differs at ${name}. Fit it to this base first.`,422);}
  const mappedBase=new Set(mapped.values());
  const ancestor=(index,parents,set)=>{let parent=parents.get(index);while(parent!==undefined&&!set.has(parent))parent=parents.get(parent);return parent??null;};
  for(const [index,baseIndex] of mapped)if((mapped.get(ancestor(index,graph.parents,mapped))??null)!==ancestor(baseIndex,baseGraph.parents,mappedBase))throw fault('Part joint ancestry differs from the base.',422);
  const provenance=j.extras?.aiplayWeightTransfer||j.asset?.extras?.aiplayWeightTransfer;
  if(provenance?.referenceSha256!==undefined&&provenance.referenceSha256!==baseHash)throw fault('Part was fitted to a different source hash.',409);
  if(provenance?.baseJointNodes!==undefined){const skinJoints=j.skins[0]?.joints||[];if(j.skins.length!==1||!Array.isArray(provenance.baseJointNodes)||provenance.baseJointNodes.length!==skinJoints.length||skinJoints.some((n,i)=>mapped.get(n)!==provenance.baseJointNodes[i]))throw fault('Part base-joint mapping disagrees with its skeleton.',422);}
  let triangles=0,vertices=0,primitives=0;
  for(const mesh of j.meshes||[])for(const p of mesh.primitives||[]){if((p.mode??4)!==4||!Number.isInteger(p.material)||!j.materials?.[p.material]||p.targets?.length)throw fault('Part primitives require triangles, PBR materials and no independent morph targets.',422);triangles+=(j.accessors[p.indices??p.attributes.POSITION]?.count||0)/3;vertices+=j.accessors[p.attributes.POSITION]?.count||0;primitives++;}
  if(triangles>60000||vertices>180000||primitives>64)throw fault('Part exceeds its triangle, vertex or primitive budget.',422);
  let texturePixels=0;
  for(const image of j.images||[]){const view=j.bufferViews?.[image.bufferView];if(!view||view.buffer!==0)throw fault('Part texture must use the embedded buffer.',422);const [w,h]=textureSize(parsed.binData.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength),image.mimeType);if(!w||!h||w>2048||h>2048)throw fault('Part texture exceeds 2048 pixels.',422);texturePixels+=w*h;}
  if(texturePixels>WARDROBE_LIMITS.texturePixels)throw fault('Part combined textures exceed 16 megapixels.',422);
  const bindings=[];
  for(let index=0;index<(j.nodes||[]).length;index++)if(j.nodes[index].mesh!==undefined){
    const n=j.nodes[index],s=j.skins?.[n.skin];if(!s||!graph.active.has(index))throw fault('Every part mesh must be skinned in the active scene.',422);
    const inverse=skinAccessor(j,parsed.binData,s.inverseBindMatrices,{label:'Part inverse binds',type:'MAT4',types:[5126]});
    const matrices=s.joints.map((joint,i)=>new Matrix4().fromArray(Array.from({length:16},(_,k)=>inverse.at(i,k))));
    for(let i=0;i<s.joints.length;i++)if(!near(baseGraph.worlds.get(mapped.get(s.joints[i])).clone().multiply(matrices[i]),graph.worlds.get(index)))throw fault('Part inverse bind matrices do not fit the selected base.',422);
    bindings.push({node:index,skin:n.skin,baseJointNodes:s.joints.map(joint=>mapped.get(joint)),partJointNodes:[...s.joints],meshMatrix:graph.worlds.get(index).toArray()});
  }
  return {sha256:digest(bytes),bytes:bytes.length,triangles,vertices,materials:j.materials?.length||0,joints:joints.length,texturePixels,bindings,validation:{errors:0,warnings:report.issues.numWarnings},review:'needs_visual_review'};
}

export function createAvatarWardrobe({directory,inspectAsset,inspectLook,record=async()=>{}}){
  if(typeof inspectAsset!=='function')throw new TypeError('inspectAsset is required.');
  const dir=id=>path.join(directory,checked(id,avatarPattern,'avatar id'));
  const partPath=(id,part)=>path.join(dir(id),checked(part,partPattern,'part id')+'.json');
  const binaryPath=(id,part)=>path.join(dir(id),checked(part,partPattern,'part id')+'.glb');
  const contextId=look=>look===null||look===undefined?'default':checked(look,lookPattern,'look id');
  const selectionPath=(id,look)=>path.join(dir(id),`selection-${contextId(look)}.json`);
  async function source(id,hash){checked(id,avatarPattern,'avatar id');const result=await inspectAsset(id);if(!Buffer.isBuffer(result.bytes)||result.row.id!==id||result.row.inspection.sha256!==digest(result.bytes)||(hash!==undefined&&pin(hash)!==result.row.inspection.sha256))throw fault('Base avatar changed; reload its imported version.',409);return result;}
  async function context(id,look){contextId(look);if(look!==null&&look!==undefined){if(!inspectLook)throw fault('Named look context is unavailable.',409);await inspectLook(id,look);}}
  async function read(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')throw fault('Wardrobe record not found.',404);throw e;}}
  async function part(id,partId,hash){const row=await read(partPath(id,partId));if(row.schema!==1||row.id!==partId||row.avatarId!==id||row.baseSha256!==hash)throw fault('Part source identity changed.',409);return row;}
  async function names(id){try{return await readdir(dir(id));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  async function inventory({id}){const {row,bytes}=await source(id),j=readGlb(bytes).json,graph=baseSkeleton(j);return {avatarId:id,sha256:row.inspection.sha256,joints:graph.joints.map(index=>({index,name:j.nodes[index].name})),slots:WARDROBE_SLOTS,limits:WARDROBE_LIMITS};}
  async function list({id}){const {row}=await source(id);const files=(await names(id)).filter(name=>partPattern.test(name.replace(/\.json$/,''))&&name.endsWith('.json'));return {avatarId:id,sha256:row.inspection.sha256,parts:await Promise.all(files.map(name=>part(id,name.slice(0,-5),row.inspection.sha256)))};}
  async function file({id,part_id}){const base=await source(id),row=await part(id,part_id,base.row.inspection.sha256),bytes=await readFile(binaryPath(id,part_id));if(bytes.length!==row.inspection.bytes||digest(bytes)!==row.inspection.sha256)throw fault('Part bytes changed; import the file again.',409);return {row,bytes};}
  async function importPart(input,actor='system'){
    fields(input,['id','sha256','name','slot','source','license','data_base64','bytes','path']);if(input.bytes!==undefined&&!Buffer.isBuffer(input.bytes))throw fault('Internal part bytes must be a Buffer.');const request={...structuredClone({...input,bytes:undefined}),...(input.bytes===undefined?{}:{bytes:Buffer.from(input.bytes)})};
    const id=checked(request.id,avatarPattern,'avatar id'),hash=pin(request.sha256),name=text(request.name,'Part name',80),origin=text(request.source,'Source',2000),license=text(request.license,'License',2000);
    if(!WARDROBE_SLOTS.includes(request.slot))throw fault('Choose a supported part slot.');
    if(['bytes','data_base64','path'].filter(key=>request[key]!==undefined).length!==1)throw fault('Provide one GLB file or base64 upload.');
    let bytes;
    if(request.bytes!==undefined)bytes=request.bytes;
    if(request.data_base64!==undefined){const value=request.data_base64;if(typeof value!=='string'||!value.length||value.length>Math.ceil(WARDROBE_LIMITS.bytes/3)*4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fault('Invalid base64 part upload.',413);bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw fault('Invalid base64 part upload.');}
    if(request.path!==undefined){if(typeof request.path!=='string'||!path.isAbsolute(request.path)||path.extname(request.path).toLowerCase()!=='.glb'||request.path.includes('\0'))throw fault('Use an absolute local GLB path.');const info=await stat(request.path);if(!info.isFile()||info.size>WARDROBE_LIMITS.bytes)throw fault('Part exceeds 32 MiB.',413);bytes=await readFile(request.path);}
    return serial(path.resolve(dir(id)),async()=>{const base=await source(id,hash);if((await list({id})).parts.length>=64)throw fault('An avatar can hold 64 imported parts.',409);const inspection=await inspectWardrobePart(bytes,base.bytes,hash),partId=`part_${randomUUID()}`;
      const row={schema:1,id:partId,avatarId:id,baseSha256:hash,sha256:inspection.sha256,name,slot:request.slot,source:origin,license,inspection,createdAt:new Date().toISOString(),actor,files:{glb:`/api/avatars/wardrobe/file/${id}/${partId}`}};
      await mkdir(dir(id),{recursive:true});await record({type:'import',actor,asset:`avatar/${id}/parts/${partId}`,data:{op:'wardrobe_import',avatarId:id,partId,baseSha256:hash,sha256:inspection.sha256,source:origin,license}});
      await writeFile(binaryPath(id,partId),bytes,{flag:'wx'});try{await atomic(partPath(id,partId),row);}catch(e){await unlink(binaryPath(id,partId));throw e;}return structuredClone(row);
    });
  }
  async function selection({id,look_id=null}){const base=await source(id);await context(id,look_id);let row;try{row=await read(selectionPath(id,look_id));}catch(e){if(e.status!==404)throw e;return {schema:1,id,sha256:base.row.inspection.sha256,look_id,revision:0,part_ids:[],parts:[]};}
    if(row.id!==id||row.sha256!==base.row.inspection.sha256||row.look_id!==look_id)throw fault('Wardrobe selection source changed.',409);return {...row,parts:await Promise.all(row.part_ids.map(partId=>part(id,partId,row.sha256)))};}
  async function select(input,actor='system'){fields(input,['id','sha256','look_id','expected_revision','part_ids']);const request=structuredClone(input),id=checked(request.id,avatarPattern,'avatar id');pin(request.sha256);contextId(request.look_id);
    if(!Number.isSafeInteger(request.expected_revision)||request.expected_revision<0||request.expected_revision>=Number.MAX_SAFE_INTEGER)throw fault('Expected revision is required.');
    if(!Array.isArray(request.part_ids)||request.part_ids.length>8||new Set(request.part_ids).size!==request.part_ids.length)throw fault('Select up to eight distinct parts.');request.part_ids.forEach(value=>checked(value,partPattern,'part id'));
    return serial(path.resolve(dir(id)),async()=>{await source(id,request.sha256);const current=await selection({id,look_id:request.look_id??null});if(current.revision!==request.expected_revision)throw fault('Wardrobe changed; reload it before selecting parts.',409);
      const parts=await Promise.all(request.part_ids.map(part_id=>file({id,part_id})));const uniqueSlots=parts.map(({row})=>row.slot).filter(slot=>slot!=='accessory');if(new Set(uniqueSlots).size!==uniqueSlots.length)throw fault('Choose one part per slot; accessories may stack.');
      const row={schema:1,id,sha256:request.sha256,look_id:request.look_id??null,revision:current.revision+1,part_ids:request.part_ids,updatedAt:new Date().toISOString()};await mkdir(dir(id),{recursive:true});await record({type:'preset_apply',actor,asset:`avatar/${id}/wardrobe/${contextId(request.look_id)}`,data:{op:'wardrobe_select',avatarId:id,revision:row.revision,partIds:row.part_ids,lookId:row.look_id}});await atomic(selectionPath(id,request.look_id),row);return {...row,parts:parts.map(p=>p.row)};});}
  async function remove(input,actor='system'){fields(input,['id','sha256','part_id']);const request=structuredClone(input),id=checked(request.id,avatarPattern,'avatar id');pin(request.sha256);checked(request.part_id,partPattern,'part id');return serial(path.resolve(dir(id)),async()=>{
    await source(id,request.sha256);await part(id,request.part_id,request.sha256);
    for(const name of await names(id))if(name.startsWith('selection-')&&name.endsWith('.json')){
      const selected=await read(path.join(dir(id),name));
      // A deleted saved look cannot be selected again (look IDs are immutable).
      // Its orphan selection must not permanently prevent removing a part.
      if(selected.look_id&&inspectLook){try{await inspectLook(id,selected.look_id);}catch(error){if(error.status===404)continue;throw error;}}
      if(selected.part_ids.includes(request.part_id))throw fault('Remove this part from saved outfits before deleting it.',409);
    }
    await record({type:'edit',actor,asset:`avatar/${id}/parts/${request.part_id}`,data:{op:'wardrobe_delete',avatarId:id,partId:request.part_id}});await unlink(partPath(id,request.part_id));await unlink(binaryPath(id,request.part_id));return {deleted:request.part_id};
  });}
  return {inventory,importPart,list,file,selection,select,remove};
}

/** Parent must mount this only after its same-origin loopback guard. */
export function createAvatarWardrobeRoutes({directory,inspectAsset,inspectLook,json,provenance}){
  const service=createAvatarWardrobe({directory,inspectAsset,inspectLook,record:event=>provenance.append('library',event)});
  return async(req,res,url)=>{const match=url.pathname.match(new RegExp(`^/api/avatars/wardrobe/file/(av_${UUID})/(part_${UUID})$`));
    if(match&&req.method==='GET'){const {bytes}=await service.file({id:match[1],part_id:match[2]});res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;}
    if(url.pathname!=='/api/avatars/wardrobe')return false;if(req.method!=='POST')throw fault('Use POST for wardrobe controls.',405);
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fault('Wardrobe controls require JSON.',415);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>Math.ceil(WARDROBE_LIMITS.bytes/3)*4+10000)throw fault('Part request exceeds 32 MiB.',413);chunks.push(chunk);}
    let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('Invalid wardrobe JSON.');}fields(input,['action','id','sha256','name','slot','source','license','data_base64','path','look_id','expected_revision','part_ids','part_id']);
    const {action,...args}=input,actor=provenance.actorFrom(req);let result;
    if(action==='inventory'){fields(args,['id']);result=await service.inventory(args);}
    else if(action==='list'){fields(args,['id']);result=await service.list(args);}
    else if(action==='import')result=await service.importPart(args,actor);
    else if(action==='selection'){fields(args,['id','look_id']);result=await service.selection(args);}
    else if(action==='select')result=await service.select(args,actor);
    else if(action==='delete')result=await service.remove(args,actor);
    else throw fault('Unknown wardrobe action.');json(res,200,result);return true;
  };
}
