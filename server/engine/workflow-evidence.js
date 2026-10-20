/** Wordless model/workload identity for matching a prior successful test.
 * Private jobs deliberately produce no acceptance record. */
import { createHash } from 'node:crypto';
import { MODEL_BUNDLES } from '../../shared/model-bundles.js';
export function curatedArtifactKey(graph) {
  const names = new Set(Object.values(graph).flatMap(n => Object.values(n.inputs)).filter(v => typeof v === 'string' && /\.(safetensors|sft)$/i.test(v)).map(v => v.split('/').pop()));
  for (const [id, bundle] of Object.entries(MODEL_BUNDLES)) {
    const files = bundle.files;
    if (names.size === files.length && files.every(f => names.has(f.relative.split('/').pop())))
      return { id, key: createHash('sha256').update(JSON.stringify(files.map(({ relative, bytes, sha256 }) => ({ relative, bytes, sha256 })))).digest('hex') };
  }
  return null;
}
export function workflowEvidenceKey(graph) {
  const ignored = new Set(['text', 'text_g', 'text_l', 'prompt', 'negative', 'caption', 'style', 'lyrics', 'seed', 'noise_seed', 'filename_prefix']);
  const nodes = Object.entries(graph);
  const repeatedTypes = new Set(nodes.map(([, n]) => n.class_type)).size !== nodes.length;
  // A class identifies a node only when that class occurs once. Preserve those
  // historical keys; otherwise bind exact instance IDs and edges so a rewire
  // cannot inherit another workload's evidence. Renumbering a repeated-class
  // graph deliberately requires a fresh test, rather than guessing equivalence.
  const rows = nodes.map(([id, n]) => ({ ...(repeatedTypes ? { id } : {}), type: n.class_type, inputs: Object.fromEntries(Object.entries(n.inputs)
    .filter(([k]) => !ignored.has(k)).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, Array.isArray(v) ? [repeatedTypes ? String(v[0]) : graph[String(v[0])]?.class_type, v[1]] : v])) }));
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(repeatedTypes ? { version: 2, nodes: rows } : rows)).digest('hex');
}
