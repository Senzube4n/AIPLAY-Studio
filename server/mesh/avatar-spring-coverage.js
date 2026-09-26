/** Report only motion a prepared part can inherit from its base VRM.
 * Wardrobe parts cannot introduce spring joints: their skins are rebound to
 * the base skeleton, whose VRM spring manager remains the sole owner. */
import {skinAccessor} from './glb.js';

const MIN_VISIBLE_WEIGHT=.05;

export function inspectPartSpringCoverage(base,part,binary,bindings){
  const extension=base.extensions?.VRMC_springBone;
  const springs=Array.isArray(base.extensionsUsed)&&base.extensionsUsed.includes('VRMC_springBone')&&extension?.specVersion==='1.0'?extension.springs:null;
  if(Array.isArray(springs)&&springs.length>256)return {mode:'unverified',baseSpringChains:springs.length,springLinkedJoints:0,springLinkedVertices:0,minimumWeight:MIN_VISIBLE_WEIGHT};
  const chains=Array.isArray(springs)?springs.filter(chain=>Array.isArray(chain?.joints)&&chain.joints.length):[];
  const springNodes=new Set();
  for(const chain of chains){
    if(!Array.isArray(chain?.joints))continue;
    for(const joint of chain.joints)if(Number.isInteger(joint?.node)&&base.nodes?.[joint.node])springNodes.add(joint.node);
  }
  const linkedNodes=new Set();let weightedVertices=0;
  for(const binding of bindings){
    const mesh=part.meshes[part.nodes[binding.node].mesh];
    for(const primitive of mesh.primitives){
      const attributes=primitive.attributes,sets=Object.keys(attributes).filter(name=>/^JOINTS_\d+$/.test(name)).map(name=>Number(name.slice(7))).sort((a,b)=>a-b);
      const pairs=sets.map(set=>[
        skinAccessor(part,binary,attributes[`JOINTS_${set}`],{label:'Part motion joints',type:'VEC4',types:[5121,5123],vertex:true}),
        skinAccessor(part,binary,attributes[`WEIGHTS_${set}`],{label:'Part motion weights',type:'VEC4',types:[5121,5123,5126],normalized:true,vertex:true})
      ]);
      for(let vertex=0;vertex<pairs[0][0].count;vertex++){
        let springWeight=0;const vertexNodes=new Set();
        for(const [joints,weights] of pairs)for(let slot=0;slot<4;slot++){
          const baseNode=binding.baseJointNodes[joints.at(vertex,slot)];
          if(springNodes.has(baseNode)){
            const weight=weights.at(vertex,slot);
            springWeight+=weight;
            if(weight>0)vertexNodes.add(baseNode);
          }
        }
        if(springWeight>=MIN_VISIBLE_WEIGHT){weightedVertices++;for(const node of vertexNodes)linkedNodes.add(node);}
      }
    }
  }
  return {mode:linkedNodes.size?'base_springs':'none',baseSpringChains:chains.length,springLinkedJoints:linkedNodes.size,springLinkedVertices:weightedVertices,minimumWeight:MIN_VISIBLE_WEIGHT};
}
