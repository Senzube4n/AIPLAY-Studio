/** Small adapters to existing catalogue rows and curated worker bundles.
 * No downloads, hardware probes, application config or credentials here. */
import { ACE_VARIANTS } from './model-bundles.js';

// Historical acceptance is evidence, never installation or minimum-resource state.
const xlSftA100 = Object.freeze({
  id: 'ace15-xl-sft-a100-2026-10-20', status: 'hardware-validated', date: '2026-10-20',
  report: 'docs/ACE_XL_SFT_A100_HARDWARE_ACCEPTANCE_RESULT.md',
  source: 'docs/evidence/ace15-xl-sft-a100-2026-10-20.json',
  archiveSha256: 'e5e90296d67e9139a58614ac69e3811784c994e34085cffeee3fd0d4fe51e1ee',
  artifactKey: 'e27477f233db97eb925e8f04f3ca8e4fb74a78f37aaa74de09bca933e94af077',
  workflowKey: 'a0e15341c36d6beefe4c4a2656e1cf4e9770b622f953404ad42ac2934de23c1e',
  preparedGraphSha256: '89969dd074b61bc40f31504e57ed3e3841ef6a7a4e826cac77766d82fe67f2df',
  executedGraphSha256: '7e961fad7cf91debfbe9235ddd6b1022d9d36b210f209276476653f9c8a65640',
  tested: Object.freeze({ target: 'runpod', cloud: 'SECURE', gpuId: 'NVIDIA A100-SXM4-80GB',
    gpuCount: 1, vramGiB: 80, allocatedRamGB: 117, vcpus: 24,
    image: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404' }),
  runtime: Object.freeze({ workerCommit: '7447b9b5f322aa9312e8227d348980338b9ac69e',
    comfyVersion: '0.41.0', comfyRevision: 'ce1e922d8623bb507180e32a0c01a7d0e29edef7',
    python: '3.12.3', torch: '2.8.0+cu128', cudaRuntime: '12.8' }),
  observed: Object.freeze({ gpuUsedBytes: 23080206336, comfyProcessRssBytes: 22331850752,
    loaderNodeSeconds: 1.8380317310075043, samplerNodeSeconds: 13.153547956004331,
    generationSeconds: 29.841, sampleIntervalSeconds: 1, samples: 375,
    containerMemoryMeasured: false, coldLoadingMeasured: false }),
  output: Object.freeze({ sha256: '15a832bd96a2ddc92541093e3217b0696729ef90aec172877af9ce721e0c051d',
    durationSeconds: 30, sampleRate: 48000, channels: 2, format: 'FLAC PCM_16', humanReview: 'sounds good' }),
  minimumRequirementsEstablished: false,
  workload: Object.freeze({ caption: 'Instrumental electronic music, 120 BPM, warm synthesizer chords, clear drum groove, evolving bass line, no vocals.',
    lyrics: '', seed: 20261019, duration: 30, bpm: 120, keyscale: 'C major', timesignature: '4', language: 'en',
    dit: 'acestep_v1.5_xl_sft_bf16.safetensors', lm: 'qwen_4b_ace15.safetensors', steps: 50, cfg: 7, codes: true, planTemperature: 0.85 }),
});

export const MODEL_PROFILES = Object.freeze([
  { id: 'yue2-comfy', category: 'music', capability: 'musicYue2Comfy', bundle: 'yue2-comfy', label: 'YuE2 3B (int8)',
    targets: ['local', 'runpod'], template: 'yue2-comfy', evidence: 'catalogue estimate; int8 inference not accepted here',
    settings: { checkpoint: 'yue2_3b_int8_convrot.safetensors', maxDuration: 30, steps: 32 }, workload: '30-second song, batch 1' },
  ...ACE_VARIANTS.map(v => ({ id: v.id, category: 'music', capability: v.capability, bundle: v.id,
    label: `ACE-Step 1.5 ${v.variant}${v.id === 'ace15-xl-sft' ? ' (A100 tested)' : v.variant.startsWith('XL') ? ' (experimental)' : ''}`, targets: ['local', 'runpod'], template: 'ace-step15',
    hardwareAcceptance: v.id === 'ace15-xl-sft' ? xlSftA100 : null,
    evidence: v.id === 'ace15-xl-sft' ? 'A100 SXM 80 GB tested: 30-second instrumental, 4B planner, 50 steps, CFG 7, batch 1; other configurations unverified.' : 'publisher manifest and ComfyUI template verified; live inference unverified',
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
