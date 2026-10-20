/** Positive compatibility claims need a known file and the worker's actual workflow schema. */
import { MODEL_BUNDLES } from '../../worker/model-manager.js';
import { checkpointGraph } from '../workflow.js';
import { validateGraph } from './remote-common.js';

export function modelCompatibility({ file, folder, setup, objects }) {
  const unknown = { state: 'unknown', label: 'Compatibility unverified', note: 'Review the creator’s workflow and required components before downloading.' };
  if (!file || !setup || !objects) return { ...unknown, note: 'Connect the AI service to check this file against your setup.' };
  const known = Object.entries(MODEL_BUNDLES).find(([, bundle]) => bundle.files.some(f => f.sha256 === file.sha256 && f.bytes === file.bytes));
  if (!known) {
    if (folder === 'loras' && !objects.LoraLoader && !objects.LoraLoaderModelOnly)
      return { state: 'needs', label: 'Needs extra components', note: 'Your AI service has no supported LoRA loader.' };
    return unknown;
  }
  const [id, bundle] = known, spec = bundle.files.find(f => f.sha256 === file.sha256);
  if (folder !== spec.relative.split('/')[0]) return { state: 'needs', label: 'Choose the model folder', note: `This file belongs in ${spec.relative.split('/')[0]}.` };
  if (!setup.bundles?.some(b => b.id === id && b.state === 'ready'))
    return { state: 'needs', label: 'Needs extra components', note: `Install the complete ${bundle.label} bundle in AI models first.` };
  // Other bundles and arbitrary LoRAs remain unverified until their full workflows can be checked.
  if (id !== 'sdxl-turbo') return unknown;
  try {
    const graph = checkpointGraph({ ckpt: spec.relative.split('/').pop(), prompt: 'A watercolor landscape', negative: '', seed: 1,
      width: 512, height: 512, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'normal', prefix: 'compatibility' });
    validateGraph(graph, objects);
    return { state: 'works', label: 'Works with your setup', note: 'Verified SDXL Turbo file and Pictures workflow components.' };
  } catch { return { state: 'needs', label: 'Needs extra components', note: 'Your AI service is missing a component required by the SDXL Turbo workflow.' }; }
}
