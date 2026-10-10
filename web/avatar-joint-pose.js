import * as THREE from 'three';

/** Temporary bend inspection for an imported GLB. It never edits the asset. */
export function createAvatarJointPose(gltf, jointNames) {
  if (!gltf?.scene?.traverse || !gltf.parser?.associations || !Array.isArray(jointNames))
    throw new TypeError('A loaded avatar and its verified joint inventory are required.');
  const allowed = new Set(jointNames.map(joint => joint.index));
  const bones = new Map(), rest = new Map();
  gltf.scene.traverse(object => {
    const index = gltf.parser.associations.get(object)?.nodes;
    if (!object.isBone || !allowed.has(index)) return;
    if (bones.has(index)) throw new Error('Loaded joint has ambiguous instances.');
    bones.set(index, object);
    rest.set(index, object.quaternion.clone());
  });
  const joints = jointNames.filter(joint => bones.has(joint.index))
    .map(joint => ({index:joint.index,name:joint.name}));
  let current = null;
  const axisVector = {x:new THREE.Vector3(1,0,0),y:new THREE.Vector3(0,1,0),z:new THREE.Vector3(0,0,1)};
  function reset() {
    if (current !== null) bones.get(current).quaternion.copy(rest.get(current));
    current = null;
    gltf.scene.updateMatrixWorld(true);
  }
  function apply({node_index,axis,degrees}) {
    if (!Number.isInteger(node_index) || !bones.has(node_index) || !Object.hasOwn(axisVector,axis) ||
        typeof degrees !== 'number' || !Number.isFinite(degrees) || Math.abs(degrees)>45)
      throw new TypeError('Choose an imported joint, axis and bend from -45° to 45°.');
    reset();
    const bone = bones.get(node_index);
    bone.quaternion.copy(rest.get(node_index)).multiply(new THREE.Quaternion().setFromAxisAngle(axisVector[axis],THREE.MathUtils.degToRad(degrees)));
    current = node_index;
    gltf.scene.updateMatrixWorld(true);
  }
  function worldPosition(node_index) {
    const bone=bones.get(node_index);
    if (!bone) return null;
    bone.updateWorldMatrix(true,false);
    return bone.getWorldPosition(new THREE.Vector3());
  }
  return {joints,apply,reset,worldPosition,get current(){return current;}};
}
