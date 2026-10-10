/** Typed access to the Music workbench's existing routes; no parallel worker. */
import path from 'node:path';
import { plannerRequest } from './music/community-planner.js';
import { trainingRecipe } from './music/community-recipes.js';

const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' };
const file = { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^/\\\\\\x00-\\x1f]+\\.(wav|flac|mp3|m4a|ogg|opus)$',
  description: 'Recording filename from list_songs, not a path.' };
const seed = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const size = { type: 'string', enum: ['small', 'medium', 'large'] };
const run = { ...id, description: 'Saved native workbench run id from status or a start response.' };
const text = (maxLength) => ({ type: 'string', maxLength });
const number = (minimum, maximum, integer = false) => ({ type: integer ? 'integer' : 'number', minimum, maximum });
const recipe = { type: 'object', additionalProperties: false, properties: {
  preset: { type: 'string', enum: ['fast', 'balanced', 'thorough', 'custom'], description: 'Default balanced. Overrides require custom.' },
  steps: number(1, 20000, true), accumulation: number(1, 16, true),
  optimizer: { type: 'string', enum: ['adamw-lm', 'adamw', 'prodigy', 'muon'] },
  adapter: { type: 'string', enum: ['lora', 'lokr'] }, rank: number(1, 256, true), alpha: number(1, 512),
  lokrDim: number(1, 512, true), lokrFactor: number(1, 64, true), learningRate: number(.000001, .01),
  targetKl: number(0, 10), seed: number(0, 4294967295, true), saveEvery: number(1, 20000, true),
} };

// The stdio dispatcher does not enforce schemas. Validate here as well so
// unknown controls, nonfinite numbers and wrong primitive types never disappear.
function validate(schema, value, label = 'request') {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => { try { validate(candidate, value, label); return true; } catch { return false; } });
    if (matches.length !== 1) throw new Error(`${label} has an unsupported value.`);
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    if (schema.maxProperties != null && Object.keys(value).length > schema.maxProperties) throw new Error(`${label} has too many fields.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key] || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (!childSchema && schema.additionalProperties === false) throw new Error(`Unsupported ${label} field: ${key}.`);
      if (childSchema) validate(childSchema, child, `${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${label} has an invalid number of items.`);
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) throw new Error(`${label} must contain unique items.`);
    value.forEach((entry, index) => validate(schema.items, entry, `${label}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
      || value.includes('\0') || (schema.pattern && !new RegExp(schema.pattern, 'i').test(value))) throw new Error(`${label} must be valid text.`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))
      || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${label} is outside its numeric bounds.`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} is not a supported choice.`);
}

const recording = (value) => { if (value?.includes('..')) throw new Error('Choose a library recording filename.'); };
const bool = { type: 'boolean' };

export function musicWorkbenchTools(api) {
  const post = async (body) => {
    const result = await api('POST', '/api/music-tools', body, 900_000);
    if (result?.error) throw new Error(result.error);
    return result;
  };
  const tool = (name, description, action, properties = {}, required = [], check = () => {}) => {
    const schema = { type: 'object', additionalProperties: false, properties, required };
    return { name, description, inputSchema: schema, async run(input = {}) {
      validate(schema, input); check(input);
      return post({ action, ...input });
    } };
  };
  return [{
    name: 'music_workbench_status',
    description: 'Read installed native music packs, datasets, saved runs and current owned activity. No generation, training or installation. UI: Music Lab > Native tools. Dataset receipts may contain local source paths; keep them local.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async run(input = {}) {
      validate(this.inputSchema, input);
      const result = await api('GET', '/api/music-tools');
      if (result?.error) throw new Error(result.error);
      return result;
    },
  },
  tool('music_workbench_run', 'Read one saved native run, exact effective request, progress, errors and artifact URLs. Poll this after a start; done confirms worker completion, not musical quality.', 'read', { run }, ['run']),
  tool('music_workbench_stop', 'Stop the currently active workbench worker only. It does not stop Studio generation jobs or remove source recordings; completed artifacts remain in saved runs.', 'stop'),
  tool('music_native_install', 'Download and verify an optional planner, joint-training or MuScriptor pack only when installation is requested. Read status first for readiness and hardware limits. Models can require gigabytes; MuScriptor weights use CC BY-NC 4.0.',
    'install', { kind: { type: 'string', enum: ['planner', 'train', 'midi'] }, size }, ['kind'], (a) => {
      if (a.size !== undefined && a.kind !== 'midi') throw new Error('Model size applies only to the MIDI pack.');
    }),
  tool('music_dataset_create', 'Create a local native-training dataset from 1–200 library recordings OR an explicitly supplied absolute folder. Folder import is flat and reads optional matching JSON metadata sidecars; it retains originals. Review style, exact lyrics and instrumental status before preparation.',
    'dataset', { name: text(100), files: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: file },
      folder: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute local audio folder supplied by the owner; not a URL.' } }, [], (a) => {
      if (Object.hasOwn(a, 'files') === Object.hasOwn(a, 'folder')) throw new Error('Choose exactly one files list or folder.');
      if (a.folder !== undefined && !path.isAbsolute(a.folder)) throw new Error('Choose an absolute local folder.');
      a.files?.forEach(recording);
    }),
  tool('music_dataset_edit', 'Save one dataset song’s style, exact lyrics and instrumental flag. This invalidates its dataset’s derived preparation caches; original audio is retained. Item ids come from workbench status.',
    'edit', { id, item: id, style: text(20000), lyrics: text(20000), instrumental: bool }, ['id', 'item', 'style', 'lyrics', 'instrumental']),
  tool('music_dataset_prepare', 'Prepare reviewed dataset recordings as 48 kHz stereo and metadata. Retries skip completed recordings. Full latent/code/score preparation is performed by the native training run; this action alone does not train an adapter.',
    'prepare', { dataset: id }, ['dataset']),
  tool('music_native_train', 'Start native YuE2 joint AR/NAR training from a reviewed dataset. Requires installed models and NVIDIA CUDA with at least 11 GB VRAM. Overrides require custom; fixed recipes use 200/600/1200 steps. Poll the run, audition, then export explicitly.',
    'train', { dataset: id, recipe }, ['dataset'], (a) => {
      const r = a.recipe || {};
      if ((r.preset || 'balanced') !== 'custom' && Object.keys(r).some((key) => key !== 'preset')) throw new Error('Training overrides require the custom preset.');
      if (r.adapter === 'lora' && (r.lokrDim !== undefined || r.lokrFactor !== undefined)) throw new Error('LoKr settings require the LoKr adapter.');
      if (r.optimizer === 'prodigy' && r.learningRate !== undefined && r.learningRate !== 1) throw new Error('Prodigy uses its fixed native learning rate; omit learningRate.');
      trainingRecipe(r);
    }),
  tool('music_native_continue', 'Resume a saved optimizer checkpoint with the same dataset and recipe. steps is the new TOTAL step count and must exceed the checkpoint; changed dataset fingerprints are refused. It is a new tracked run, not an adapter-quality verdict.',
    'continue', { run, steps: number(1, 20000, true) }, ['run', 'steps']),
  tool('music_native_plan', 'Generate score/tokens/audio with the optional audio.cpp 0.9 CUDA planner and native Q4/Q8 weights. Saves exact lyrics/settings and hashes. Requires nonempty lyrics; supplied ABC requires semantic/audio stage. maxTokens limits tokens, not duration. Keep explicitly.',
    'plan', { style: { ...text(2000), minLength: 1 }, lyrics: { ...text(8000), minLength: 1 },
      stage: { type: 'string', enum: ['abc', 'semantic', 'audio'] }, seed,
      abc: { ...text(65536), minLength: 1 }, quantization: { type: 'string', enum: ['q4_0', 'q8_0'] },
      narSteps: number(1, 256, true), maxTokens: number(1, 9000, true) }, ['style', 'lyrics'], (a) => plannerRequest(a)),
  tool('music_native_replay', 'Render a completed native run with edited ABC for a fresh performance, or useTokens=true for verified saved tokens. Token reuse refuses changed ABC or primary model/runtime. Identical output across runs/hardware is not promised.',
    'replay', { run, abc: { ...text(65536), minLength: 1 }, useTokens: bool, seed }, ['run'], (a) => {
      if (a.abc !== undefined && (!a.abc.trim() || Buffer.byteLength(a.abc) > 65536)) throw new Error('ABC must be nonempty text up to 64 KiB.');
      if (a.abc !== undefined && a.useTokens === true) throw new Error('Edited scores require fresh semantic tokens. Omit ABC to replay saved tokens.');
    }),
  tool('music_native_keep', 'Copy a completed native audio take into the Studio library as a separate WAV, retaining its effective request and native-run link. Score-only or token-only runs cannot be kept as songs.', 'keepSong', { run }, ['run']),
  tool('music_audio_transcribe', 'Run MuScriptor on a library recording to predict multi-instrument MIDI and timed note events. Requires the explicitly installed selected model; auto or CPU device. Weights use CC BY-NC 4.0. Download and audition predictions before treating them as a faithful transcription.',
    'midi', { file, size, device: { type: 'string', enum: ['auto', 'cpu'] } }, ['file'], (a) => recording(a.file)),
  tool('music_midi_to_daw', 'Import completed MuScriptor notes into an editable DAW project. Event seconds map onto provisional 4/4 at 120 BPM by default, using pluck sounds; original tempo/timbres are not reconstructed. Limits/partial imports stay visible; retries return the saved project.',
    'toDaw', { run, bpm: number(40, 240) }, ['run']),
  tool('music_adapter_export', 'Export the latest complete native AR/NAR checkpoint from a finished or stopped training run as a combined ComfyUI LoRA. The source checkpoint remains intact; this does not install or select the adapter. A trained adapter’s licensing and musical quality still require assessment.',
    'exportAdapter', { run }, ['run']),
  tool('music_adapter_install', 'Copy an exported adapter into ComfyUI/models/loras under its native-run filename. Returns name/trigger. On Music > YuE2 through ComfyUI, select the returned file in both Audio LoRA and Planner LoRA; installation does not select it.',
    'installAdapter', { run }, ['run']),
  tool('music_process_preview', 'Make a separate denoise/high-frequency EQ/offline VST3 preview with optional reference loudness matching. VST3 needs an installed Pedalboard host and local plugin paths. Compare before keeping. Reference matching is loudness-only; DAW mastering is separate.',
    'process', { file, reference: file, denoise: bool, smoothing: number(0, 1),
      plugins: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 }, parameters: { type: 'object', maxProperties: 100,
          additionalProperties: { oneOf: [{ type: 'number' }, bool, text(1000)] } },
      } } } }, ['file'], (a) => {
      recording(a.file); recording(a.reference);
      for (const plugin of a.plugins || []) if (!path.isAbsolute(plugin.path) || !/\.vst3$/i.test(plugin.path)) throw new Error('Choose an absolute path to an installed VST3 plugin.');
    }),
  tool('music_process_keep', 'Keep a completed processing preview as a new library recording after comparison. Verifies source and preview hashes; the original remains intact. Retrying an already kept preview returns its existing library file.',
    'keep', { run }, ['run']),
  ];
}
