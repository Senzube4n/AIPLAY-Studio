/** Portable creative references, never executable graphs or resource commands. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODEL_PROFILES, validModelSelection } from '../shared/model-profiles.js';
import { MODEL_BUNDLES } from '../shared/model-bundles.js';
import { setupPlan, profileGraph } from './setup-plan.js';
import { workflowEvidenceKey, hardwareWorkflowMatches } from './engine/workflow-evidence.js';
import { jsonStore, readJSON, relativeFile } from './engine/remote-common.js';

const FORMAT = 'aiplay-template', VERSION = 1;
const keys = (v, allowed) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw Error('Unsupported template field.');
};
const safeText = (v, max = 8000) => {
  if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
    || /(?:[a-z]:[\\/]|\\\\|file:\/\/|(?:^|\s)\/[^\s/]+\/[^\s]+|\b(?:hf_|rpa_|sk-)[a-z0-9_-]{10,}|\bbearer\s+[a-z0-9_.-]{10,}|[?&](?:token|key|auth)=)/i.test(v))
    throw Error('Remove credentials and private paths from the template.');
  return v;
};
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const PARAMETERS = {
  caption: 'text', prompt: 'text', lyrics: 'text', negative: 'text', instrumental: 'boolean',
  duration: [1, 600], steps: [1, 200], cfg: [0, 30], seed: [0, 4294967295],
  bpm: [1, 300], keyscale: 'text', timesignature: 'text', language: 'text',
  codes: 'boolean', planTemperature: [0, 3], lm: 'file', dit: 'file', checkpoint: 'file',
  width: [64, 4096], height: [64, 4096], seconds: [1, 60],
};
export function validateCreativeTemplate(input) {
  if (JSON.stringify(input).length > 256000) throw Error('Template exceeds 256 KB.');
  const inspect = value => { if(typeof value==='string')safeText(value);else if(Array.isArray(value))value.forEach(inspect);else if(value && typeof value==='object')Object.values(value).forEach(inspect); };
  inspect(input);
  keys(input, ['format','version','name','description','creator','preferredLocation','selection','settings','artifacts','workflows','references']);
  if (input.format !== FORMAT || input.version !== VERSION) throw Error('Unsupported AIPLAY template version.');
  if (!safeText(input.name, 80).trim()) throw Error('Give the template a name.');
  if (!['local','runpod'].includes(input.preferredLocation) || !validModelSelection(input.selection)) throw Error('Choose supported models and a location.');
  keys(input.settings, Object.keys(input.selection));
  for (const [category, settings] of Object.entries(input.settings)) {
    keys(settings, Object.keys(PARAMETERS));
    for (const [key, value] of Object.entries(settings)) {
      const rule = PARAMETERS[key];
        if (Array.isArray(rule)) { if (!Number.isFinite(value) || value < rule[0] || value > rule[1] || ['duration','steps','seed','bpm','width','height','seconds'].includes(key) && !Number.isInteger(value)) throw Error(`Invalid ${key}.`); }
      else if (rule === 'boolean') { if (typeof value !== 'boolean') throw Error(`Invalid ${key}.`); }
      else { safeText(value); if (rule === 'file' && (relativeFile(value).includes('/') || !/\.safetensors$/i.test(value))) throw Error('Use a model filename, not a path.'); }
    }
    const profile = MODEL_PROFILES.find(p => p.id === input.selection[category]);
    const allowed = profile.template === 'ace-step15' ? ['caption','lyrics','instrumental','duration','steps','cfg','seed','bpm','keyscale','timesignature','language','codes','planTemperature','lm','dit']
      : profile.template === 'checkpoint' ? ['prompt','negative','width','height','steps','cfg','seed','checkpoint']
      : profile.template === 'ltx' ? ['prompt','width','height','seconds','steps','seed']
      : ['caption','lyrics','instrumental','seed','checkpoint'];
    if (Object.keys(settings).some(k => !allowed.includes(k))) throw Error('This workflow does not support one of these settings.');
    if (settings.dit && settings.dit !== profile.settings.dit || settings.checkpoint && settings.checkpoint !== profile.settings.checkpoint) throw Error('Model settings do not match the selected profile.');
    if (settings.lm && !['qwen_4b_ace15.safetensors','qwen_1.7b_ace15.safetensors'].includes(settings.lm)) throw Error('Choose a supported ACE planner.');
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 100 || !Array.isArray(input.references) || input.references.length > 30) throw Error('Invalid model references.');
  for (const a of input.artifacts) {
    keys(a,['relative','bytes','sha256']); relativeFile(a.relative);
    if (!hex(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > 100e9) throw Error('Invalid artifact identity.');
  }
  for (const r of input.references) {
    keys(r,['provider','id','revision','version','file','folder','sha256','bytes']);
    if (!['huggingface','civitai'].includes(r.provider) || !/^[\w.-]+(?:\/[\w.-]+)?$/.test(r.id || '') || r.id.includes('..')) throw Error('Invalid provider model reference.');
    if (r.provider === 'huggingface' && (!r.id.includes('/') || !/^[a-f0-9]{40}$/.test(r.revision || ''))
      || r.provider === 'civitai' && (!/^\d{1,14}$/.test(r.id) || !/^\d{1,14}$/.test(String(r.version)))) throw Error('Pin the provider model version.');
    relativeFile(r.file); if ((r.provider==='huggingface' ? !/\.safetensors$/i.test(r.file) : !/^\d{1,14}$/.test(r.file)) || !['checkpoints','loras','diffusion_models','vae','text_encoders','upscale_models'].includes(r.folder) || !hex(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > 100e9) throw Error('Invalid provider file identity.');
  }
  keys(input.workflows, Object.keys(input.selection));
  if (Object.values(input.workflows).some(v => !hex(v))) throw Error('Invalid workflow identity.');
  return JSON.parse(JSON.stringify({ ...input, name: input.name.trim(), description: safeText(input.description || '', 1000), creator: safeText(input.creator || '', 100) }));
}
function graphFor(profile, settings) {
  return profileGraph({ ...profile, settings: { ...profile.settings, ...settings } });
}
function effectiveSettings(plan, settings) {
  return Object.fromEntries(plan.profiles.map(p=>[p.category,p.template==='ace-step15'
    ? {...Object.fromEntries(Object.entries({...p.hardwareAcceptance?.workload,...p.settings}).filter(([k])=>Object.hasOwn(PARAMETERS,k))),instrumental:true,lyrics:'',...(settings[p.category]||{})}
    : {...(settings[p.category]||{})}]));
}
export function makeCreativeTemplate({ name, description = '', creator = '', preferredLocation = 'local', selection, settings = {}, references = [] }) {
  const plan = setupPlan({ selection, target: preferredLocation });
  const effective = effectiveSettings(plan,settings);
  return validateCreativeTemplate({ format: FORMAT, version: VERSION, name, description, creator, preferredLocation, selection,
    settings:effective, artifacts: plan.files, references,
    workflows: Object.fromEntries(plan.profiles.map(p => [p.category, workflowEvidenceKey(graphFor(p, effective[p.category]))])) });
}
export function previewCreativeTemplate(raw, { target, localFiles = [], machine } = {}) {
  const template = validateCreativeTemplate(raw), location = target || template.preferredLocation;
  const plan = setupPlan({ selection: template.selection, target: location, localFiles, machine });
  template.settings = effectiveSettings(plan,template.settings);
  const issues = [], identities = [];
  for (const f of plan.files) if (!template.artifacts.some(a => a.relative === f.relative && a.sha256 === f.sha256 && a.bytes === f.bytes)) issues.push(`Missing or changed companion: ${f.relative}`);
  for (const f of template.artifacts) if (!plan.files.some(a => a.relative === f.relative && a.sha256 === f.sha256 && a.bytes === f.bytes)) issues.push(`Unrecognized artifact: ${f.relative}`);
  for (const p of plan.profiles) {
    if(p.template==='ace-step15' && template.settings[p.category].lm!==p.settings.lm)
      issues.push(`Planner needs a companion outside this curated installation plan: ${template.settings[p.category].lm}`);
    const graph = graphFor(p, template.settings[p.category] || {}), workflowKey = workflowEvidenceKey(graph);
    const matches = template.workflows[p.category] === workflowKey;
    if (!matches) issues.push(`Workflow changed: ${p.label}`);
    identities.push({ category:p.category, workflowKey, matches, historicalHardwareValidated: matches && template.settings[p.category]?.instrumental !== false && hardwareWorkflowMatches(p.hardwareAcceptance, graph),
      currentWorkerReady:false, minimumRequirementsEstablished:false });
  }
  return { template, plan, issues, workflows:identities, missingModels:plan.profiles.filter(p => !p.localFilesPresent || location === 'runpod').map(p=>p.id),
    licenses:plan.profiles.map(p=>({id:p.id,url:MODEL_BUNDLES[p.bundle].licenseUrl})),
    references:template.references.map(r=>({...r,compatibility:'unknown',note:'Reference only; verify its adapter, model terms and companions before installing.'})),
    canApply:issues.length === 0, requiresInstallApproval:true, currentReadinessVerified:false };
}
export function createCreativeTemplates({ dir }) {
  const file = path.join(dir, 'creative-templates.json'), save = jsonStore(file), backup = jsonStore(path.join(dir,'creative-templates.previous.json'));
  let lane = Promise.resolve();
  const load = async () => {
    const data = await readJSON(file,{version:1,items:[]});
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length>200) throw Error('Saved templates could not be read; restore your exported backup.');
    for(const item of data.items)validateCreativeTemplate(item.template);
    return data;
  };
  const update = fn => { const next = lane.then(async()=>{const data=await load(), result=await fn(data);await backup(await load());await save(data);return result;});lane=next.catch(()=>{});return next; };
  return {
    list: async()=> (await load()).items,
    put: (template,id) => update(data=>{
      const clean=validateCreativeTemplate(template);if(id && !data.items.some(i=>i.id===id)) throw Error('Template not found.');
      if(!id && data.items.length>=200)throw Error('Export a backup and remove an old template first.');
      const item={id:id || randomUUID(),updatedAt:new Date().toISOString(),template:clean};
      data.items=[item,...data.items.filter(i=>i.id!==id)];return item;
    }),
    remove:id=>update(data=>{if(!data.items.some(i=>i.id===id))throw Error('Template not found.');data.items=data.items.filter(i=>i.id!==id);return {removed:true};}),
  };
}
