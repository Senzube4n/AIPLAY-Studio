import * as THREE from 'three';

const disposedAssets=new WeakSet();
const lists=object=>Array.isArray(object.material)?object.material:[object.material];

/** Capture only the base graph before parts are added. Shared attachment inverse
 * binds must never be used by Skeleton.pose() to reconstruct the base bones. */
export function captureAvatarRestPose(scene){
  const transforms=[];scene.traverse(object=>transforms.push({object,position:object.position.clone(),quaternion:object.quaternion.clone(),scale:object.scale.clone()}));
  return ()=>{for(const {object,position,quaternion,scale} of transforms){object.position.copy(position);object.quaternion.copy(quaternion);object.scale.copy(scale);}scene.updateMatrixWorld(true);};
}
function resources(gltf){
  const geometries=new Set(),materials=new Set(),textures=new Set(),skeletons=new Set();
  for(const scene of gltf.scenes||[gltf.scene])scene?.traverse(object=>{
    if(object.geometry)geometries.add(object.geometry);
    if(object.skeleton)skeletons.add(object.skeleton);
    for(const material of lists(object)){if(!material)continue;materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}
  });
  return {geometries,materials,textures,skeletons};
}

/** Discard a separately loaded, unowned part after a failed or superseded load. */
export function disposeWardrobeGltf(gltf){
  if(!gltf||disposedAssets.has(gltf))return;
  disposedAssets.add(gltf);
  const owned=resources(gltf);
  for(const value of owned.skeletons)value.dispose();
  for(const value of owned.geometries)value.dispose();
  for(const value of owned.materials)value.dispose();
  for(const value of owned.textures)value.dispose();
  gltf.scene?.removeFromParent();
}

/** Parts share raw base Bone objects, never another VRM manager or animation rig. */
export function createAvatarWardrobeRuntime({gltf,avatarId,sha256}){
  if(!gltf?.scene?.traverse||!gltf.parser?.associations||typeof avatarId!=='string'||typeof sha256!=='string')throw new TypeError('A loaded base and its imported identity are required.');
  const baseResources=resources(gltf),baseBones=new Map(),baseJson=gltf.parser.json;
  gltf.scene.traverse(object=>{const index=gltf.parser.associations.get(object)?.nodes;if(object.isBone&&Number.isInteger(index)){if(baseBones.has(index))throw Error('Base joint has ambiguous loaded instances.');baseBones.set(index,object);}});
  let current=new Map(),disposed=false;
  const ensureLive=()=>{if(disposed)throw Error('Wardrobe has been disposed.');};
  function release(entry){entry.group.removeFromParent();for(const skeleton of entry.skeletons)skeleton.dispose();disposeWardrobeGltf(entry.gltf);}
  function prepare(partGltf,manifest){
    if(!partGltf?.scene?.traverse||partGltf===gltf||disposedAssets.has(partGltf)||[...current.values()].some(entry=>entry.gltf===partGltf))throw Error('Use a separately loaded, unused part.');
    if(manifest?.avatarId!==avatarId||manifest.baseSha256!==sha256||typeof manifest.id!=='string'||!/^part_[a-f0-9-]{36}$/.test(manifest.id))throw Error('Part belongs to a different avatar source.');
    const bindings=manifest.inspection?.bindings;
    if(!Array.isArray(bindings)||!bindings.length||bindings.length>64||new Set(bindings.map(b=>b.node)).size!==bindings.length)throw Error('Part has no verified mesh bindings.');
    if(partGltf.userData?.vrm||(partGltf.animations||[]).length)throw Error('Part cannot run independent VRM state or animations.');
    const owned=resources(partGltf);
    for(const key of Object.keys(owned))for(const value of owned[key])if(baseResources[key].has(value))throw Error('Part must not share owned geometry or materials with the base.');
    const json=partGltf.parser?.json,associations=partGltf.parser?.associations;
    if(!json||!associations)throw Error('Part parser associations are required.');
    partGltf.scene.updateMatrixWorld(true);
    const plans=[],seen=new Set();
    partGltf.scene.traverse(mesh=>{
      if(!mesh.isMesh)return;
      if(!mesh.isSkinnedMesh)throw Error('Every part mesh must carry verified weights.');
      let owner=mesh,node;
      while(owner){const index=associations.get(owner)?.nodes;if(Number.isInteger(index)){node=index;break;}owner=owner.parent;}
      const binding=bindings.find(value=>value.node===node),skin=json.skins?.[json.nodes?.[node]?.skin];
      if(!binding||!skin||skin.joints.length!==mesh.skeleton.bones.length||binding.baseJointNodes?.length!==skin.joints.length||binding.partJointNodes?.length!==skin.joints.length)throw Error('Loaded part does not match its verified skin.');
      if(binding.skin!==json.nodes[node].skin||!Array.isArray(binding.meshMatrix)||binding.meshMatrix.length!==16||!binding.meshMatrix.every(Number.isFinite))throw Error('Invalid verified part transform.');
      const bones=binding.baseJointNodes.map((index,i)=>{
        const bone=baseBones.get(index),partNode=associations.get(mesh.skeleton.bones[i])?.nodes;
        if(!bone||partNode!==skin.joints[i]||binding.partJointNodes[i]!==partNode||json.nodes[partNode]?.name!==baseJson.nodes[index]?.name)throw Error('Loaded part joints do not match the pinned base.');
        return bone;
      });
      if(new Set(bones).size!==bones.length||mesh.skeleton.boneInverses.length!==bones.length)throw Error('Part inverse bind count is invalid.');
      const placement=new THREE.Matrix4().fromArray(binding.meshMatrix);
      if(Math.abs(placement.determinant())<1e-12)throw Error('Part placement is singular.');
      plans.push({mesh,bones,placement});seen.add(node);
    });
    if(seen.size!==bindings.length||!plans.length)throw Error('Verified part meshes are missing from the loaded scene.');
    // Validation finishes before allocating or changing any visible group.
    const group=new THREE.Group();group.name=`wardrobe_${manifest.id}`;
    const skeletons=[];
    try{
      for(const {mesh,bones,placement} of plans){
        const drawable=mesh.clone(false),skeleton=new THREE.Skeleton(bones,mesh.skeleton.boneInverses.map(m=>m.clone()));skeletons.push(skeleton);
        drawable.name=`wardrobe_${manifest.id}_${mesh.name}`;
        drawable.matrix.copy(placement);drawable.matrixAutoUpdate=false;
        placement.decompose(drawable.position,drawable.quaternion,drawable.scale);
        drawable.bindMode=THREE.AttachedBindMode;drawable.bind(skeleton,mesh.bindMatrix.clone());
        // Original bounds become stale while base animation or spring bones move.
        drawable.frustumCulled=false;group.add(drawable);
      }
    }catch(error){for(const skeleton of skeletons)skeleton.dispose();throw error;}
    return {gltf:partGltf,manifest,group,skeletons};
  }
  function replace(parts){
    ensureLive();if(!Array.isArray(parts)||parts.length>8||new Set(parts.map(p=>p.manifest?.id)).size!==parts.length||new Set(parts.map(p=>p.gltf)).size!==parts.length)throw Error('Select up to eight distinct loaded parts.');
    const prepared=[];
    try{for(const part of parts)prepared.push(prepare(part.gltf,part.manifest));}
    catch(error){for(const entry of prepared)for(const skeleton of entry.skeletons)skeleton.dispose();throw error;}
    const previous=current;
    current=new Map(prepared.map(entry=>[entry.manifest.id,entry]));
    for(const entry of prepared)gltf.scene.add(entry.group);
    for(const entry of previous.values())release(entry);
    update();return [...current.keys()];
  }
  function attach(partGltf,manifest){ensureLive();if(current.size>=8||current.has(manifest?.id))throw Error('Part already attached or wardrobe is full.');const entry=prepare(partGltf,manifest);current.set(manifest.id,entry);gltf.scene.add(entry.group);update();return manifest.id;}
  function remove(partId){ensureLive();const entry=current.get(partId);if(!entry)return false;current.delete(partId);release(entry);return true;}
  function clear(){ensureLive();for(const entry of current.values())release(entry);current.clear();}
  function update(){if(disposed)return;gltf.scene.updateMatrixWorld(true);for(const entry of current.values())for(const skeleton of entry.skeletons)skeleton.update();}
  function dispose(){if(disposed)return;clear();disposed=true;}
  return {replace,attach,remove,clear,update,dispose,get partIds(){return [...current.keys()];}};
}
