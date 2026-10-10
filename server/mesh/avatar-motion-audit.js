/** Read-only VRM spring connectivity audit. A link is evidence of motion input,
 * not a judgement of appearance, collision, stiffness or animation quality. */
import {skinAccessor} from './glb.js';

const MIN_WEIGHT = .05;
const MAX_VERTICES = 1_000_000;
const MAX_CHAINS = 256;
const MAX_JOINTS = 4096;
const label = (value, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, 100) : fallback;

function unverified(reason, declaredChains = 0) {
  return {status: 'unverified', reason, minimumWeight: MIN_WEIGHT, declaredChains, linkedChains: 0, colliders: 0, chains: [], meshes: []};
}

export function inspectAvatarSpringMotion(doc, binary) {
  const spring = doc?.extensions?.VRMC_springBone;
  if (!spring) return {status: 'no_springs', minimumWeight: MIN_WEIGHT, declaredChains: 0, linkedChains: 0,
    colliders: 0, chains: [], meshes: []};
  if (!Array.isArray(spring.springs)) return unverified('Spring chains are unreadable.');
  if (!spring.springs.length) return {status: 'no_springs', minimumWeight: MIN_WEIGHT, declaredChains: 0, linkedChains: 0,
    colliders: spring.colliders?.length || 0, chains: [], meshes: []};
  const listed = Array.isArray(doc.extensionsUsed) && doc.extensionsUsed.includes('VRMC_springBone');
  if (!listed || spring.specVersion !== '1.0') return unverified('VRM 1.0 spring extension is not declared.', spring.springs.length);
  if (!Array.isArray(doc.nodes) || spring.springs.length > MAX_CHAINS ||
      spring.springs.some(chain => !Array.isArray(chain?.joints)) ||
      spring.springs.reduce((count, chain) => count + chain.joints.length, 0) > MAX_JOINTS)
    return unverified('Spring hierarchy exceeds the inspection limit.', spring.springs.length);

  try {
    const active = new Set(), visiting = new Set();
    function visit(nodeIndex) {
      if (!Number.isInteger(nodeIndex) || !doc.nodes[nodeIndex] || visiting.has(nodeIndex)) throw Error('Invalid scene hierarchy.');
      if (active.has(nodeIndex)) return;
      visiting.add(nodeIndex); active.add(nodeIndex);
      for (const child of doc.nodes[nodeIndex].children || []) visit(child);
      visiting.delete(nodeIndex);
    }
    for (const root of doc.scenes?.[doc.scene ?? 0]?.nodes || []) visit(root);
    if (!active.size) throw Error('Empty active scene.');

    const affected = new Map();
    function descendants(index, chainIndex, seen) {
      if (!Number.isInteger(index) || !doc.nodes[index] || seen.has(index)) throw Error('Invalid spring hierarchy.');
      seen.add(index);
      if (!affected.has(index)) affected.set(index, new Set());
      affected.get(index).add(chainIndex);
      for (const child of doc.nodes[index].children || []) descendants(child, chainIndex, seen);
    }
    const chains = spring.springs.map((chain, index) => {
      if (!Array.isArray(chain?.joints) || !chain.joints.length) throw Error('Empty spring chain.');
      const joints = chain.joints.map(joint => {
        if (!Number.isInteger(joint?.node) || !active.has(joint.node)) throw Error('Spring joint is outside the active scene.');
        descendants(joint.node, index, new Set());
        return {node: joint.node, name: label(doc.nodes[joint.node].name, `Joint ${joint.node}`)};
      });
      return {index, name: label(chain.name, `Chain ${index + 1}`), joints, weightedVertices: 0, rigidMeshes: 0, meshNodes: []};
    });

    const meshes = []; let scanned = 0;
    for (const nodeIndex of [...active].sort((a, b) => a - b)) {
      const node = doc.nodes[nodeIndex];
      if (!Number.isInteger(node.mesh)) continue;
      const mesh = doc.meshes?.[node.mesh];
      if (!mesh || !Array.isArray(mesh.primitives)) throw Error('Unknown mesh.');
      const row = {node: nodeIndex, name: label(node.name, `Mesh ${nodeIndex}`), kind: 'static', vertices: 0,
        weightedVertices: 0, chainIndices: []};
      if (node.skin !== undefined && !Number.isInteger(node.skin)) throw Error('Invalid mesh skin.');
      const linked = new Set();
      for (const primitive of mesh.primitives) {
        const attrs = primitive.attributes || {};
        const count = doc.accessors?.[attrs.POSITION]?.count;
        if (!Number.isSafeInteger(count) || count < 0 || scanned + count > MAX_VERTICES) throw Error('Mesh exceeds the motion inspection limit.');
        scanned += count; row.vertices += count;
        if (!Number.isInteger(node.skin)) continue;
        const skin = doc.skins?.[node.skin];
        if (!Array.isArray(skin?.joints)) throw Error('Unknown mesh skin.');
        row.kind = 'skinned';
        const sets = Object.keys(attrs).filter(name => /^JOINTS_\d+$/.test(name)).map(name => Number(name.slice(7))).sort((a, b) => a - b);
        if (!sets.length) throw Error('Missing skin weights.');
        const pairs = sets.map(set => [
          skinAccessor(doc, binary, attrs[`JOINTS_${set}`], {label: 'Motion joints', type: 'VEC4', types: [5121, 5123], vertex: true}),
          skinAccessor(doc, binary, attrs[`WEIGHTS_${set}`], {label: 'Motion weights', type: 'VEC4', types: [5121, 5123, 5126], normalized: true, vertex: true})
        ]);
        if (pairs.some(([joints, weights]) => joints.count !== count || weights.count !== count)) throw Error('Skin weight count differs from mesh vertices.');
        for (let vertex = 0; vertex < count; vertex++) {
          const perChain = new Map(); let total = 0;
          for (const [joints, weights] of pairs) for (let slot = 0; slot < 4; slot++) {
            const weight = weights.at(vertex, slot), bone = skin.joints[joints.at(vertex, slot)];
            if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(bone)) continue;
            const chainIds = affected.get(bone);
            if (!chainIds) continue;
            total += weight;
            for (const chainIndex of chainIds) perChain.set(chainIndex, (perChain.get(chainIndex) || 0) + weight);
          }
          if (total >= MIN_WEIGHT) row.weightedVertices++;
          for (const [chainIndex, weight] of perChain) if (weight >= MIN_WEIGHT) {
            chains[chainIndex].weightedVertices++; linked.add(chainIndex);
          }
        }
      }
      if (!Number.isInteger(node.skin)) {
        const chainIds = affected.get(nodeIndex);
        if (chainIds?.size) {
          row.kind = 'rigid';
          for (const chainIndex of chainIds) { chains[chainIndex].rigidMeshes++; linked.add(chainIndex); }
        }
      }
      row.chainIndices = [...linked].sort((a, b) => a - b);
      for (const chainIndex of linked) chains[chainIndex].meshNodes.push(nodeIndex);
      meshes.push(row);
    }
    const linkedChains = chains.filter(chain => chain.weightedVertices || chain.rigidMeshes).length;
    return {status: linkedChains ? 'linked' : 'unlinked', minimumWeight: MIN_WEIGHT, declaredChains: chains.length,
      linkedChains, colliders: spring.colliders?.length || 0, chains, meshes};
  } catch (error) {
    return unverified(`Motion check could not read this rig: ${String(error.message).slice(0, 120)}`, spring.springs.length);
  }
}
