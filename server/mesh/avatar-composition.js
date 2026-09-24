/** Append admitted wardrobe meshes to a VRM while retaining its original rig.
 * Index semantics: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * No appearance overrides, authoring or filesystem side effects occur here. */
import {createHash} from 'node:crypto';
import validator from 'gltf-validator';
import {readGlb,assertSkinned} from './glb.js';
import {inspectWardrobePart} from './avatar-wardrobe.js';
import {VRM_LIMITS,VRM_EXTENSIONS,inspectVrmDocument} from './vrm-profile.js';

export const COMPOSITION_LIMITS=Object.freeze({...VRM_LIMITS,parts:8,nodes:512,accessors:4096,bufferViews:8192,primitives:128,animations:32});
const materialExtensions=['KHR_materials_unlit','KHR_materials_emissive_strength','KHR_texture_transform'];
const baseExtensions=new Set([...materialExtensions,...VRM_EXTENSIONS]);
const arrays=['nodes','meshes','skins','accessors','bufferViews','materials','textures','images','samplers','animations'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fault=(message,status=422)=>Object.assign(new Error(message),{status});
const requireThat=(condition,message,status)=>{if(!condition)throw fault(message,status);};
const pin=(value,label)=>requireThat(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),`${label} must be an exact SHA-256.`,400);
const clone=structuredClone;
const counts=doc=>Object.fromEntries(arrays.map(key=>[key,doc[key]?.length||0]));

function document(bytes,label){
  const parsed=readGlb(bytes);requireThat(parsed.ok,`${label} is not a valid GLB container.`);
  let offset=12,chunks=0;while(offset<bytes.length){const type=bytes.subarray(offset+4,offset+8).toString('latin1');requireThat(type==='JSON'||type==='BIN\0',`${label} contains an unsupported GLB chunk.`);offset+=8+bytes.readUInt32LE(offset);chunks++;}
  requireThat(chunks===2,`${label} must contain one JSON and one embedded BIN chunk.`);
  const j=parsed.json;requireThat(j.buffers?.length===1&&j.buffers[0].uri===undefined&&!j.images?.some(image=>image.uri!==undefined),`${label} must embed its buffer and textures.`);
  return parsed;
}
function extensions(doc,allowed,label){
  requireThat([...(doc.extensionsUsed||[]),...(doc.extensionsRequired||[])].every(name=>allowed.has(name)),`${label} contains an unsupported extension.`);
  function visit(value){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(key==='extras')continue;if(key==='extensions')requireThat(child&&typeof child==='object'&&!Array.isArray(child)&&Object.keys(child).every(name=>allowed.has(name)),`${label} contains an unsupported embedded extension.`);visit(child);}}
  visit(doc);
}
function partExtensionLocations(doc){
  function visit(value,location=[]){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){
    if(key==='extras')continue;
    if(key==='extensions'){
      const at=location.join('/'),allowed=/^materials\/\d+$/.test(at)?new Set(['KHR_materials_unlit','KHR_materials_emissive_strength']):/^materials\/\d+\/(?:pbrMetallicRoughness\/(?:baseColorTexture|metallicRoughnessTexture)|normalTexture|occlusionTexture|emissiveTexture)$/.test(at)?new Set(['KHR_texture_transform']):new Set();
      requireThat(Object.keys(child||{}).every(name=>allowed.has(name)),'Part extension appears outside a supported material or texture-info location.');
    }
    visit(child,[...location,key]);
  }}
  visit(doc);
}
function dimensions(bytes,mime){
  if(mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216){let offset=2;while(offset+9<=bytes.length){if(bytes[offset++]!==255)break;let marker=bytes[offset++];while(marker===255)marker=bytes[offset++];if(marker===217||marker===218)break;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;if([192,193,194].includes(marker))return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];offset+=size;}}
  throw fault('Composition requires embedded PNG or JPEG images.');
}
function budget(doc,binary){
  const result={...counts(doc),triangles:0,vertices:0,primitives:0,joints:new Set((doc.skins||[]).flatMap(skin=>skin.joints)).size,texturePixels:0};
  for(const key of ['nodes','accessors','bufferViews','materials','animations','joints'])requireThat(result[key]<=COMPOSITION_LIMITS[key],`Composition exceeds its ${key} budget.`,413);
  for(const mesh of doc.meshes||[])for(const primitive of mesh.primitives||[]){
    requireThat((primitive.mode??4)===4&&Number.isInteger(primitive.material)&&doc.materials?.[primitive.material],'Composition requires triangles with explicit materials.');
    result.triangles+=(doc.accessors[primitive.indices??primitive.attributes.POSITION]?.count||0)/3;result.vertices+=doc.accessors[primitive.attributes.POSITION]?.count||0;result.primitives++;
  }
  for(const key of ['triangles','primitives'])requireThat(result[key]<=COMPOSITION_LIMITS[key],`Composition exceeds its ${key} budget.`,413);
  for(const image of doc.images||[]){const view=doc.bufferViews?.[image.bufferView];requireThat(view&&view.buffer===0,'Composition images must use the embedded buffer.');const [width,height]=dimensions(binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength),image.mimeType);requireThat(width>0&&height>0&&width<=COMPOSITION_LIMITS.textureSide&&height<=COMPOSITION_LIMITS.textureSide,'Composition texture side exceeds its budget.',413);result.texturePixels+=width*height;}
  requireThat(result.texturePixels<=COMPOSITION_LIMITS.texturePixels,'Composition combined textures exceed 64 megapixels.',413);return result;
}
async function validate(bytes,label){
  const report=await validator.validateBytes(new Uint8Array(bytes),{format:'glb',maxIssues:100,externalResourceFunction:async()=>{throw Error('External resources are disabled.');}});
  requireThat(report.issues.numErrors===0,`${label} failed glTF validation (${report.issues.numErrors} errors).`);
  return {validator:validator.version(),errors:0,warnings:report.issues.numWarnings};
}
function pack(doc,binary){
  const raw=Buffer.from(JSON.stringify(doc)),json=Buffer.concat([raw,Buffer.alloc((-raw.length)&3,32)]),bin=Buffer.concat([binary,Buffer.alloc((-binary.length)&3)]);
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.write('JSON',16);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(bin.length);binHeader.write('BIN\0',4);return Buffer.concat([header,json,binHeader,bin]);
}
function offsetMaterial(material,offset){
  const result=clone(material);
  for(const info of [result.pbrMetallicRoughness?.baseColorTexture,result.pbrMetallicRoughness?.metallicRoughnessTexture,result.normalTexture,result.occlusionTexture,result.emissiveTexture])if(info)info.index+=offset;
  return result;
}

/** Pure composition. Bytes and supplied hashes are checked again, even when a
 * caller already inspected them. Returned manifest is external: no original
 * base JSON objects or BIN prefix are overwritten with provenance metadata. */
export async function composeAvatarVrm({baseBytes,baseSha256,parts=[]}={}){
  requireThat(Buffer.isBuffer(baseBytes)&&baseBytes.length>0&&baseBytes.length<=COMPOSITION_LIMITS.bytes,'Base VRM must be at most 64 MiB.',413);pin(baseSha256,'baseSha256');
  requireThat(Array.isArray(parts)&&parts.length<=COMPOSITION_LIMITS.parts,'Choose up to eight parts.',400);
  const selected=parts.map(part=>{
    requireThat(part&&typeof part==='object'&&!Array.isArray(part)&&/^part_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(part.id),'Each part needs its imported id.',400);
    requireThat(Buffer.isBuffer(part.bytes)&&part.bytes.length>0&&part.bytes.length<=32*1024*1024,'Each part must be at most 32 MiB.',413);pin(part.sha256,'Part sha256');
    const entry={id:part.id,bytes:part.bytes,sha256:part.sha256};
    for(const [key,max] of [['name',100],['source',2000],['license',2000]])if(part[key]!==undefined){requireThat(typeof part[key]==='string'&&part[key].length<=max&&!/[\u0000-\u001f]/.test(part[key]),`Invalid part ${key}.`,400);entry[key]=part[key];}
    return entry;
  });
  requireThat(new Set(selected.map(part=>part.id)).size===selected.length,'Duplicate selected part ids.',400);
  // Refuse oversized selections before copying any input. Callers may hold
  // eight individually admissible parts whose combined size is much larger.
  requireThat(baseBytes.length+selected.reduce((sum,part)=>sum+part.bytes.length,0)<=COMPOSITION_LIMITS.bytes,'Composition input total exceeds 64 MiB.',413);
  const baseCopy=Buffer.from(baseBytes);for(const part of selected)part.bytes=Buffer.from(part.bytes);
  requireThat(digest(baseCopy)===baseSha256,'Base VRM changed since inspection.',409);
  const base=document(baseCopy,'Base VRM');extensions(base.json,baseExtensions,'Base VRM');inspectVrmDocument(base.json);budget(base.json,base.binData);await validate(baseCopy,'Base VRM');
  const originalSkin=assertSkinned(base.json,base.binData);requireThat(originalSkin.ok,`Base VRM has unusable weights: ${originalSkin.why.join('; ')}`);
  const doc=clone(base.json),buffers=[Buffer.from(base.binData)],manifest={schema:1,baseSha256,binaryLength:base.binData.length,bufferByteLength:base.json.buffers[0].byteLength,baseCounts:counts(base.json),parts:[],review:'needs_visual_review'};
  let binaryLength=base.binData.length;
  const scene=doc.scenes?.[doc.scene??0];requireThat(scene&&Array.isArray(scene.nodes),'Base needs a default scene with roots.');
  for(const part of selected){
    requireThat(digest(part.bytes)===part.sha256,'Part changed since inspection.',409);
    const inspection=await inspectWardrobePart(part.bytes,baseCopy,baseSha256),parsed=document(part.bytes,'Part'),j=parsed.json,offset=counts(doc);
    extensions(j,new Set(materialExtensions),'Part');partExtensionLocations(j);
    // The only supported part extensions have no node/accessor/image pointers.
    // Their texture-info index lives in the standard PBR material fields below.
    const append=(key,values)=>{if(values?.length)(doc[key]??=[]).push(...values);};
    append('bufferViews',j.bufferViews?.map(view=>({...clone(view),buffer:0,byteOffset:binaryLength+(view.byteOffset||0)})));
    append('accessors',j.accessors?.map(accessor=>{const result=clone(accessor);if(result.bufferView!==undefined)result.bufferView+=offset.bufferViews;if(result.sparse){result.sparse.indices.bufferView+=offset.bufferViews;result.sparse.values.bufferView+=offset.bufferViews;}return result;}));
    append('images',j.images?.map(image=>({...clone(image),bufferView:image.bufferView+offset.bufferViews})));
    append('samplers',j.samplers?.map(value=>clone(value)));
    append('textures',j.textures?.map(texture=>{const result=clone(texture);if(result.source!==undefined)result.source+=offset.images;if(result.sampler!==undefined)result.sampler+=offset.samplers;return result;}));
    append('materials',j.materials?.map(material=>offsetMaterial(material,offset.textures)));
    append('meshes',j.meshes?.map(mesh=>{const result=clone(mesh);for(const primitive of result.primitives){primitive.attributes=Object.fromEntries(Object.entries(primitive.attributes).map(([name,index])=>[name,index+offset.accessors]));if(primitive.indices!==undefined)primitive.indices+=offset.accessors;primitive.material+=offset.materials;}return result;}));
    const skinMap=new Map(),nodeIndices=[],skinIndices=[];
    for(const binding of inspection.bindings){
      if(!skinMap.has(binding.skin)){const original=j.skins[binding.skin],skin={joints:[...binding.baseJointNodes],inverseBindMatrices:original.inverseBindMatrices+offset.accessors};
        for(const key of ['name','extras'])if(Object.hasOwn(original,key))skin[key]=clone(original[key]);
        skinMap.set(binding.skin,doc.skins.length);skinIndices.push(doc.skins.length);doc.skins.push(skin);
      }
      const original=j.nodes[binding.node],node={mesh:original.mesh+offset.meshes,skin:skinMap.get(binding.skin),matrix:[...binding.meshMatrix]};
      for(const key of ['name','extras'])if(Object.hasOwn(original,key))node[key]=clone(original[key]);
      nodeIndices.push(doc.nodes.length);scene.nodes.push(doc.nodes.length);doc.nodes.push(node);
    }
    for(const key of ['extensionsUsed','extensionsRequired'])if(j[key]?.length)doc[key]=[...new Set([...(doc[key]||[]),...j[key]])];
    buffers.push(Buffer.from(parsed.binData));binaryLength+=parsed.binData.length;
    manifest.parts.push({id:part.id,sha256:part.sha256,...Object.fromEntries(['name','source','license'].filter(key=>part[key]!==undefined).map(key=>[key,part[key]])),nodeIndices,skinIndices,binaryOffset:binaryLength-parsed.binData.length,binaryLength:parsed.binData.length});
  }
  const binary=Buffer.concat(buffers);doc.buffers[0].byteLength=binaryLength;manifest.counts=budget(doc,binary);inspectVrmDocument(doc);
  const skin=assertSkinned(doc,binary);requireThat(skin.ok,`Composed VRM has unusable weights: ${skin.why.join('; ')}`);
  const bytes=pack(doc,binary);requireThat(bytes.length<=COMPOSITION_LIMITS.bytes,'Composed VRM exceeds 64 MiB.',413);manifest.validation=await validate(bytes,'Composed VRM');
  return {bytes,sha256:digest(bytes),manifest};
}
