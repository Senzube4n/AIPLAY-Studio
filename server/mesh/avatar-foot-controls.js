/** Read-only foot control check. Separate weights do not prove separate geometry. */
import {nodeHierarchy, skinAccessor} from './glb.js';

const MIN_WEIGHT=.05;
const MAX_VERTICES=1_000_000;
const unverified=reason=>({state:'unverified',reason,leftVertices:0,rightVertices:0,sharedVertices:0,
  minimumWeight:MIN_WEIGHT,geometrySeparation:'unverified',reviewRequired:true});

export function inspectAvatarFootControls(doc,binary){
  const human=doc?.extensions?.VRMC_vrm?.specVersion==='1.0'
    ? doc.extensions.VRMC_vrm.humanoid?.humanBones:null;
  const left=human?.leftFoot?.node,right=human?.rightFoot?.node;
  if(!Number.isInteger(left)||!Number.isInteger(right)||left===right||!doc.nodes?.[left]||!doc.nodes?.[right])
    return unverified('No distinct VRM 1.0 left and right foot mappings to inspect.');
  if(!Buffer.isBuffer(binary))return unverified('Embedded skin data is unavailable.');
  if(doc.nodes.length>2048)return unverified('Foot hierarchy exceeds the inspection limit.');
  try{
    const hierarchy=nodeHierarchy(doc.nodes);
    const active=new Set(),pending=[...(doc.scenes?.[doc.scene??0]?.nodes||[])];
    while(pending.length){const index=pending.pop();if(!Number.isInteger(index)||!doc.nodes[index])throw Error('Invalid active scene.');
      if(active.has(index))continue;active.add(index);pending.push(...(doc.nodes[index].children||[]));}
    if(!active.has(left)||!active.has(right))return unverified('Foot controls are outside the active scene.');
    const leftTree=hierarchy.descendantsOf(left),rightTree=hierarchy.descendantsOf(right);
    if([...leftTree].some(node=>rightTree.has(node)))return unverified('Foot bone branches overlap.');
    let leftVertices=0,rightVertices=0,sharedVertices=0,scanned=0;
    for(const [nodeIndex,node] of doc.nodes.entries()){
      if(!active.has(nodeIndex))continue;
      if(!Number.isInteger(node?.mesh)||!Number.isInteger(node.skin))continue;
      const mesh=doc.meshes?.[node.mesh],skin=doc.skins?.[node.skin];
      if(!Array.isArray(mesh?.primitives)||!Array.isArray(skin?.joints))throw Error('Missing skinned mesh.');
      for(const primitive of mesh.primitives){
        const attrs=primitive.attributes||{},count=doc.accessors?.[attrs.POSITION]?.count;
        if(!Number.isSafeInteger(count)||count<0||scanned+count>MAX_VERTICES)throw Error('Foot scan exceeds the vertex limit.');
        scanned+=count;
        const sets=Object.keys(attrs).filter(key=>/^JOINTS_\d+$/.test(key)).map(key=>Number(key.slice(7))).sort((a,b)=>a-b);
        if(!sets.length)throw Error('Missing skin weights.');
        const pairs=sets.map(set=>[
          skinAccessor(doc,binary,attrs[`JOINTS_${set}`],{label:'Foot joints',type:'VEC4',types:[5121,5123],vertex:true}),
          skinAccessor(doc,binary,attrs[`WEIGHTS_${set}`],{label:'Foot weights',type:'VEC4',types:[5121,5123,5126],normalized:true,vertex:true})
        ]);
        if(pairs.some(([joints,weights])=>joints.count!==count||weights.count!==count))throw Error('Skin weights do not match vertex count.');
        for(let vertex=0;vertex<count;vertex++){
          let leftWeight=0,rightWeight=0;
          for(const [joints,weights] of pairs)for(let slot=0;slot<4;slot++){
            const bone=skin.joints[joints.at(vertex,slot)],weight=weights.at(vertex,slot);
            if(leftTree.has(bone))leftWeight+=weight;
            if(rightTree.has(bone))rightWeight+=weight;
          }
          const hasLeft=leftWeight>=MIN_WEIGHT,hasRight=rightWeight>=MIN_WEIGHT;
          if(hasLeft)leftVertices++;
          if(hasRight)rightVertices++;
          if(hasLeft&&hasRight)sharedVertices++;
        }
      }
    }
    const state=!leftVertices||!rightVertices?'unweighted'
      :sharedVertices?'cross_weighted':'independent_weights';
    return {state,reason:null,leftFootNode:left,rightFootNode:right,leftVertices,rightVertices,sharedVertices,minimumWeight:MIN_WEIGHT,
      geometrySeparation:'unverified',reviewRequired:true};
  }catch(error){return unverified(`Foot weights could not be inspected: ${String(error.message).slice(0,120)}`);}
}
