/** A local preview of World outfit admission, never an authorization decision.
 * World checks the actual model, owner, license and persona binding itself. */
import {readGlb} from './glb.js';

export const WORLD_OUTFIT_PREVIEW_LIMITS=Object.freeze({
  baseSha256:'12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2',
  bytes:16*1024*1024,packageBytes:24*1024*1024,jsonBytes:2*1024*1024,
  nodes:512,meshes:64,skins:32,accessors:4096,bufferViews:4096,
  materials:32,textures:48,images:48,samplers:48,
  triangles:80000,primitives:128,textureSide:2048,texturePixels:32*1024*1024,
});

function dimensions(bytes,mime){
  if(mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(mime==='image/jpeg'&&bytes.length>=4&&bytes[0]===255&&bytes[1]===216){
    let offset=2;
    while(offset+9<=bytes.length){
      if(bytes[offset++]!==255)break;
      let marker=bytes[offset++];while(marker===255)marker=bytes[offset++];
      if(marker===217||marker===218)break;
      const length=bytes.readUInt16BE(offset);
      if(length<2||offset+length>bytes.length)break;
      if([192,193,194].includes(marker))return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  return null;
}
const printable=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const partSlots=new Set(['hair','head','body','outfit','shoes','accessory']);
const declaredPart=part=>part&&typeof part==='object'&&/^[a-f0-9]{64}$/.test(part.sha256||'')&&
  printable(part.name,80)&&partSlots.has(part.slot)&&printable(part.source,2000)&&printable(part.license,2000);

/** Run after composing the immutable VRM and package. A candidate can still be
 * refused by World's independent structural, rights and account checks. */
export function previewWorldAvatarOutfit({baseSha256,modelBytes,packageBytes,parts}={}){
  const limits=WORLD_OUTFIT_PREVIEW_LIMITS,reasons=[];
  if(baseSha256!==limits.baseSha256)reasons.push('World currently accepts outfits based on its reviewed sample VRM.');
  if(!Array.isArray(parts)||parts.length<1)reasons.push('World needs at least one saved outfit part.');
  else if(parts.length>8)reasons.push('World accepts up to eight outfit parts.');
  else if(parts.some(part=>!declaredPart(part)))reasons.push('World needs complete credits for each outfit part.');
  if(!Buffer.isBuffer(modelBytes)||modelBytes.length>limits.bytes)reasons.push('World model limit is 16 MiB.');
  if(!Number.isSafeInteger(packageBytes)||packageBytes<1||packageBytes>limits.packageBytes)reasons.push('World package limit is 24 MiB.');
  const parsed=Buffer.isBuffer(modelBytes)?readGlb(modelBytes):null;
  if(!parsed?.ok||!Buffer.isBuffer(parsed.binData)){reasons.push('World needs a valid embedded VRM file.');return {candidate:false,reasons};}
  if(modelBytes.readUInt32LE(12)>limits.jsonBytes)reasons.push('World model JSON limit is 2 MiB.');
  const doc=parsed.json;
  for(const key of ['nodes','meshes','skins','accessors','bufferViews','materials','textures','images','samplers'])
    if((doc[key]?.length||0)>limits[key])reasons.push(`World ${key} limit is ${limits[key]}.`);
  let triangles=0,primitives=0;
  for(const mesh of doc.meshes||[])for(const primitive of mesh.primitives||[]){
    const count=doc.accessors?.[primitive.indices??primitive.attributes?.POSITION]?.count;
    if(!Number.isSafeInteger(count)||count<1||count%3){reasons.push('World cannot count this model’s triangles.');break;}
    triangles+=count/3;primitives++;
  }
  if(triangles>limits.triangles)reasons.push(`World triangle limit is ${limits.triangles}.`);
  if(primitives>limits.primitives)reasons.push(`World primitive limit is ${limits.primitives}.`);
  let texturePixels=0;
  for(const image of doc.images||[]){
    const view=doc.bufferViews?.[image.bufferView];
    const start=view?.byteOffset||0,end=start+(view?.byteLength||0);
    const size=view&&view.buffer===0&&end<=parsed.binData.length?dimensions(parsed.binData.subarray(start,end),image.mimeType):null;
    if(!size){reasons.push('World needs embedded PNG or JPEG textures.');break;}
    if(size.some(side=>side<1||side>limits.textureSide))reasons.push(`World texture side limit is ${limits.textureSide} pixels.`);
    texturePixels+=size[0]*size[1];
  }
  if(texturePixels>limits.texturePixels)reasons.push('World texture total limit is 32 megapixels.');
  return {candidate:reasons.length===0,reasons:[...new Set(reasons)]};
}
