/** Read-only GLB source check before a person spends time rigging or importing. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import validator from 'gltf-validator';
import {readGlb, assertSkinned} from './glb.js';

export const AVATAR_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;
const fault = (message, status=400) => Object.assign(new Error(message), {status});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const short = value => typeof value === 'string' ? value.slice(0, 100) : '';

async function sourceBytes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['path','data_base64'].includes(key))) throw fault('Choose one local GLB or VRM source.');
  const hasPath = Object.hasOwn(input,'path'), hasUpload = Object.hasOwn(input,'data_base64');
  if (hasPath === hasUpload) throw fault('Choose exactly one local path or upload.');
  if (hasPath) {
    const file=input.path;
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0') ||
        !['.glb','.vrm'].includes(path.extname(file).toLowerCase())) throw fault('Use an absolute local .glb or .vrm path.');
    let info;
    try { info=await stat(file); } catch { throw fault('Source file could not be read.',404); }
    if (!info.isFile() || !info.size || info.size > AVATAR_SOURCE_LIMIT_BYTES) throw fault('Source must be a nonempty GLB up to 64 MiB.',413);
    return readFile(file);
  }
  const encoded=input.data_base64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(AVATAR_SOURCE_LIMIT_BYTES*4/3)+4 ||
      encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw fault('Upload must be a canonical base64 GLB up to 64 MiB.');
  const bytes=Buffer.from(encoded,'base64');
  if (!bytes.length || bytes.length > AVATAR_SOURCE_LIMIT_BYTES || bytes.toString('base64') !== encoded) throw fault('Upload must be a canonical base64 GLB up to 64 MiB.');
  return bytes;
}

function materialTextureBindings(material) {
  const pbr=material.pbrMetallicRoughness || {};
  return [pbr.baseColorTexture,pbr.metallicRoughnessTexture,material.normalTexture,
    material.occlusionTexture,material.emissiveTexture].filter(Boolean).length;
}

/** Facts only. Mesh-node counts do not detect fused limbs or prove swappable parts. */
export async function inspectAvatarSourceBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > AVATAR_SOURCE_LIMIT_BYTES) throw fault('Source must be a nonempty GLB up to 64 MiB.',413);
  const parsed=readGlb(bytes);
  if (!parsed.ok) throw fault(parsed.why.join('; '),422);
  const doc=parsed.json;
  if (doc.buffers?.some(buffer=>buffer.uri!==undefined) || doc.images?.some(image=>image.uri!==undefined))
    throw fault('Embed all buffers and images before source inspection.',422);
  const validation=await validator.validateBytes(new Uint8Array(bytes), {format:'glb',maxIssues:100,
    externalResourceFunction:async()=>{throw Error('External resources are disabled.');}});
  if (validation.issues.numErrors) {
    const examples=validation.issues.messages.filter(issue=>issue.severity===0).slice(0,3).map(issue=>`${issue.code}: ${issue.message}`);
    throw fault(`Source GLB failed validation (${validation.issues.numErrors} errors): ${examples.join('; ')}`,422);
  }
  const primitives=(doc.meshes||[]).flatMap(mesh=>mesh.primitives||[]);
  const meshNodes=(doc.nodes||[]).flatMap((node,index)=>Number.isInteger(node.mesh)
    ? [{index,name:short(node.name)||`Node ${index}`,mesh:node.mesh,primitives:doc.meshes[node.mesh]?.primitives?.length||0}]
    : []);
  let triangles=0, vertices=0, otherPrimitives=0, withUv=0, withVertexColor=0;
  for (const primitive of primitives) {
    const position=doc.accessors?.[primitive.attributes?.POSITION];
    vertices+=position?.count||0;
    if ((primitive.mode??4)===4) triangles+=(doc.accessors?.[primitive.indices??primitive.attributes.POSITION]?.count||0)/3;
    else otherPrimitives++;
    if (primitive.attributes?.TEXCOORD_0!==undefined) withUv++;
    if (primitive.attributes?.COLOR_0!==undefined) withVertexColor++;
  }
  const materials=doc.materials||[], images=doc.images||[], skins=doc.skins||[];
  const skin=skins.length?assertSkinned(doc,parsed.binData):null;
  const expressions=doc.extensions?.VRMC_vrm?.expressions||{};
  const next=[];
  if (!materials.length && !images.length && !withVertexColor)
    next.push({code:'surface',text:'Add materials or texture data before rigging.'});
  else if (!images.length)
    next.push({code:'images',text:'No embedded image textures. Check the intended colour source.'});
  if (meshNodes.length < 2)
    next.push({code:'parts',text:'For swappable parts, prepare separate head, hair and outfit files.'});
  if (!skins.length)
    next.push({code:'rig',text:'Rig a clean body, then review bends before avatar import.'});
  else if (!skin.ok)
    next.push({code:'skin',text:'Repair the skin data before avatar import.'});
  if (doc.extensions?.VRMC_vrm?.specVersion!=='1.0')
    next.push({code:'vrm',text:'For expressions and spring hair, author a VRM 1.0 export.'});
  return {
    schema:1,sha256:sha256(bytes),bytes:bytes.length,
    geometry:{meshes:doc.meshes?.length||0,meshNodes:meshNodes.length,meshNodeSample:meshNodes.slice(0,24),
      primitives:primitives.length,triangles,vertices,otherPrimitives},
    surface:{materials:materials.length,images:images.length,textureBindings:materials.reduce((sum,material)=>sum+materialTextureBindings(material),0),
      primitivesWithUv:withUv,primitivesWithVertexColor:withVertexColor},
    skin:{skins:skins.length,joints:new Set(skins.flatMap(entry=>entry.joints||[])).size,
      structural:!skins.length?'absent':skin.ok?'valid':'invalid',why:skin?.ok?[]:(skin?.why||[])},
    vrm:{version:doc.extensions?.VRMC_vrm?.specVersion||null,
      declaredExpressions:Object.values(expressions).reduce((sum,group)=>sum+Object.keys(group||{}).length,0),
      declaredSpringChains:doc.extensions?.VRMC_springBone?.springs?.length||0},
    validation:{errors:0,warnings:validation.issues.numWarnings},next,
    caveat:'Structural checks cannot judge fused anatomy, silhouette, texture quality, joint bends, independent hair motion or World admission.'
  };
}

export async function inspectAvatarSource(input) { return inspectAvatarSourceBytes(await sourceBytes(input)); }
