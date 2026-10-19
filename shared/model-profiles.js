/** Small adapters to existing catalogue rows and curated worker bundles.
 * No downloads, hardware probes, application config or credentials here. */
import { ACE_VARIANTS } from './model-bundles.js';

export const MODEL_PROFILES = Object.freeze([
  { id: 'yue2-comfy', category: 'music', capability: 'musicYue2Comfy', bundle: 'yue2-comfy', label: 'YuE2 3B (int8)',
    targets: ['local', 'runpod'], template: 'yue2-comfy', evidence: 'catalogue estimate; int8 inference not accepted here',
    settings: { checkpoint: 'yue2_3b_int8_convrot.safetensors', maxDuration: 30, steps: 32 }, workload: '30-second song, batch 1' },
  ...ACE_VARIANTS.map(v => ({ id: v.id, category: 'music', capability: v.capability, bundle: v.id,
    label: `ACE-Step 1.5 ${v.variant}${v.variant.startsWith('XL') ? ' (experimental)' : ''}`, targets: ['local', 'runpod'], template: 'ace-step15',
    evidence: 'publisher manifest and ComfyUI template verified; live inference unverified',
    settings: { ...v.settings, duration: 30 }, workload: '30-second song, 4B planner, batch 1', experimental: v.variant.startsWith('XL') })),
  { id: 'sdxl-turbo', category: 'pictures', capability: 'imageSdxlTurbo', bundle: 'sdxl-turbo', label: 'SDXL Turbo (fp16)',
    targets: ['local', 'runpod'], template: 'checkpoint', evidence: 'A40 image acceptance documented; other hardware estimated',
    settings: { checkpoint: 'sd_xl_turbo_1.0_fp16.safetensors', width: 512, height: 512, steps: 4, cfg: 1 }, workload: '512 × 512, 4 steps, batch 1' },
  { id: 'ltx25', category: 'video', capability: 'videoLtx', bundle: 'ltx25', label: 'LTX 2.5 distilled (int8)',
    targets: ['local', 'runpod'], template: 'ltx', evidence: 'existing catalogue measurement: 16 GB, 5 s, 1280 × 704; RunPod inference unverified',
    settings: { width: 1280, height: 704, duration: 5, seconds: 5 }, workload: '5-second clip, 1280 × 704, batch 1' },
].map(p => Object.freeze(p)));
export const SETUP_CATEGORIES = Object.freeze(['music', 'pictures', 'video']);
export function selectedAceDit(names, preferred) {
  return preferred ? names.includes(preferred) ? preferred : null : names[0] || null;
}
export function validModelSelection(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.keys(value).length <= 3
    && Object.entries(value).every(([category, id]) => SETUP_CATEGORIES.includes(category)
      && MODEL_PROFILES.some(p => p.id === id && p.category === category));
}
export function defaultModelSelection(goal = 'all', music = {}) {
  // Saved generation preferences win; planning itself never changes them.
  const ace = ACE_VARIANTS.find(v => v.dit === music.aceModel);
  const ids = { music: music.engine === 'ace-step15' ? ace?.id || 'ace15-turbo' : 'yue2-comfy', pictures: 'sdxl-turbo', video: 'ltx25' };
  return Object.fromEntries(SETUP_CATEGORIES.filter(c => goal === 'all' || goal === c).map(c => [c, ids[c]]));
}
