/** Local VRM preview has its own budget; it is not admission to Agent World. */
export const VRM_LIMITS = Object.freeze({bytes:64*1024*1024,triangles:150000,materials:32,joints:256,textureSide:4096,texturePixels:64*1024*1024});
export const VRM_EXTENSIONS = ['VRMC_vrm','VRMC_springBone','VRMC_materials_mtoon','VRMC_node_constraint','VRMC_materials_hdr_emissiveMultiplier'];
const fail=message=>{throw Object.assign(new Error(message),{status:422});};
export function inspectVrmDocument(j) {
  const vrm=j.extensions?.VRMC_vrm;
  if(vrm?.specVersion!=='1.0') fail('Use a VRM 1.0 export for the local avatar workshop.');
  const node=(n,label)=>{if(!Number.isInteger(n)||!j.nodes?.[n])fail(`Invalid VRM ${label} node.`);};
  const finite=(v,label,min=0,max=1000)=>{if(v!==undefined&&(!Number.isFinite(v)||v<min||v>max))fail(`Invalid VRM ${label}.`);};
  const object=(v,label)=>{if(!v||typeof v!=='object'||Array.isArray(v))fail(`Invalid VRM ${label}.`);return v;};
  const list=(v,label,max=512)=>{if(v===undefined)return [];if(!Array.isArray(v)||v.length>max)fail(`Invalid VRM ${label}.`);return v;};
  const vector=(v,size,label,{optional=false,min=-Infinity,max=Infinity}={})=>{
    if(v===undefined&&optional)return;
    if(!Array.isArray(v)||v.length!==size)fail(`Invalid VRM ${label}.`);
    // Check by index: Array.every skips holes, which would become undefined in fromArray().
    for(let i=0;i<size;i++)if(typeof v[i]!=='number'||!Number.isFinite(v[i])||v[i]<min||v[i]>max)fail(`Invalid VRM ${label}.`);
  };
  const enumValue=(v,values,label,optional=false)=>{if(v===undefined&&optional)return;if(!values.includes(v))fail(`Invalid VRM ${label}.`);};
  const human=vrm.humanoid?.humanBones;
  const required=['hips','spine','head','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'];
  if(!human||required.some(n=>!human[n]))fail('VRM is missing required humanoid bones.');
  const humanNodes=new Set();
  for(const [name,bone] of Object.entries(human)){node(bone?.node,name);if(humanNodes.has(bone.node))fail('VRM humanoid bones must be distinct.');humanNodes.add(bone.node);}
  const expressions=[];
  for(const [kind,group] of Object.entries(vrm.expressions||{})){
    if(!['preset','custom'].includes(kind)||!group||typeof group!=='object'||Array.isArray(group))fail('Invalid VRM expressions.');
    for(const [name,e] of Object.entries(group)){
      if(!name||name.length>100)fail('Invalid VRM expression.');object(e,'expression');
      if(e.isBinary!==undefined&&typeof e.isBinary!=='boolean')fail('Invalid VRM binary expression flag.');
      for(const key of ['overrideBlink','overrideLookAt','overrideMouth'])enumValue(e[key],['none','block','blend'],'expression override',true);
      for(const bind of list(e.morphTargetBinds,'morph target binds')){object(bind,'morph target bind');node(bind.node,'expression');const mesh=j.meshes?.[j.nodes[bind.node].mesh];if(!Number.isInteger(bind.index)||bind.index<0||!mesh?.primitives?.every(p=>p.targets?.[bind.index]))fail('VRM expression references a missing morph target.');finite(bind.weight,'expression weight',0,1);}
      const material=bind=>{object(bind,'material bind');if(!Number.isInteger(bind.material)||!j.materials?.[bind.material])fail('VRM expression references a missing material.');};
      for(const bind of list(e.materialColorBinds,'material color binds')){
        material(bind);
        enumValue(bind.type,['color','emissionColor','shadeColor','matcapColor','rimColor','outlineColor'],'material color type');
        // three-vrm 3.5.5 immediately calls Color.fromArray and reads alpha.
        // Emission targets may be HDR; validate finiteness rather than clamping to 1.
        vector(bind.targetValue,4,'material target value');
      }
      for(const bind of list(e.textureTransformBinds,'texture transform binds')){
        material(bind);vector(bind.scale,2,'texture scale',{optional:true});vector(bind.offset,2,'texture offset',{optional:true});
      }
      expressions.push({name,kind,isBinary:!!e.isBinary});
    }
  }
  if(expressions.length>128)fail('Too many VRM expressions.');
  const spring=j.extensions?.VRMC_springBone;
  if(spring&&spring.specVersion!=='1.0')fail('Unsupported VRM spring-bone version.');
  const springs=list(spring?.springs,'springs',256),colliders=list(spring?.colliders,'colliders'),groups=list(spring?.colliderGroups,'collider groups',256);
  for(const c of colliders){
    object(c,'collider');node(c.node,'collider');object(c.shape,'collider shape');
    const shapes=['sphere','capsule'].filter(key=>Object.hasOwn(c.shape,key));if(shapes.length!==1)fail('Unsupported VRM collider shape.');
    const shape=object(c.shape[shapes[0]],'collider shape');finite(shape.radius,'collider radius',0,100);
    vector(shape.offset,3,'collider offset',{optional:true,min:-100,max:100});
    if(shapes[0]==='capsule')vector(shape.tail,3,'collider tail',{optional:true,min:-100,max:100});
  }
  for(const g of groups){object(g,'collider group');for(const n of list(g.colliders,'collider references'))if(!Number.isInteger(n)||!colliders[n])fail('VRM references a missing collider.');}
  let jointCount=0;
  for(const s of springs){object(s,'spring');if(s.center!==undefined)node(s.center,'spring centre');if(!Array.isArray(s.joints)||!s.joints.length)fail('VRM spring has no joints.');jointCount+=s.joints.length;const seen=new Set();for(const b of s.joints){object(b,'spring joint');node(b.node,'spring');if(seen.has(b.node))fail('VRM spring repeats a joint.');seen.add(b.node);for(const key of ['hitRadius','stiffness','gravityPower'])finite(b[key],key);finite(b.dragForce,'drag',0,1);vector(b.gravityDir,3,'gravity direction',{optional:true,min:-1,max:1});}for(const n of list(s.colliderGroups,'spring collider groups',256))if(!Number.isInteger(n)||!groups[n])fail('VRM references a missing collider group.');}
  if(jointCount>4096)fail('VRM spring joint budget exceeded.');
  // Constraints introduce dependencies beyond the glTF hierarchy.
  const edges=new Map();
  (j.nodes||[]).forEach((n,index)=>{const c=n.extensions?.VRMC_node_constraint;if(!c)return;if(c.specVersion!=='1.0')fail('Unsupported VRM constraint version.');const entries=Object.entries(object(c.constraint,'constraint'));if(entries.length!==1||!['roll','aim','rotation'].includes(entries[0][0]))fail('Invalid VRM constraint.');const [kind,value]=entries[0];object(value,'constraint');node(value.source,'constraint source');finite(value.weight,'constraint weight',0,1);if(kind==='roll')enumValue(value.rollAxis,['X','Y','Z'],'roll axis',true);if(kind==='aim')enumValue(value.aimAxis,['PositiveX','NegativeX','PositiveY','NegativeY','PositiveZ','NegativeZ'],'aim axis',true);edges.set(index,value.source);});
  for(const n of edges.keys()){let at=n;const seen=new Set();while(edges.has(at)){if(seen.has(at))fail('Cyclic VRM node constraints.');seen.add(at);at=edges.get(at);}}
  return {version:'1.0',humanoidBones:Object.keys(human),expressions,spring:{chains:springs.length,joints:jointCount,colliders:colliders.length},meta:vrm.meta||{},worldReady:false};
}
