/** Planning adapter, not a registry or installer. Every artifact comes from
 * the existing catalogue/curated manifests and every fit verdict uses fitFor. */
import { CATALOG } from './models.js';
import { fitFor } from './fit.js';
import { MODEL_BUNDLES } from '../shared/model-bundles.js';
import { MODEL_PROFILES, defaultModelSelection, validModelSelection } from '../shared/model-profiles.js';
import { checkpointGraph, buildAceStep15Graph, buildYue2ComfyGraph, videoGraph } from './workflow.js';
import { validateGraph } from './engine/remote-common.js';
import { buildRecord } from './engine/record.js';
import { workflowEvidenceKey, curatedArtifactKey } from './engine/workflow-evidence.js';

export function selectionFor(config, target) {
  const saved = target === 'runpod' ? config.cloudSetup?.plan : config.modelSetup?.local;
  return validModelSelection(saved) ? { ...saved } : defaultModelSelection(target === 'runpod' ? config.cloudSetup?.goal : 'all', config.music);
}
export function setupPlan({ selection, target, machine, localFiles = [] }) {
  if (!['local', 'runpod'].includes(target) || !validModelSelection(selection)) throw Error('Choose a model for each selected category.');
  const profiles = Object.values(selection).map(id => {
    const p = MODEL_PROFILES.find(p => p.id === id), cap = CATALOG.find(c => c.id === p.capability), bundle = MODEL_BUNDLES[p.bundle];
    const localPresent = bundle.files.every(f => localFiles.some(on => {
      const [folder, name] = f.relative.split('/');
      const aliases = { diffusion_models: ['diffusion_models', 'unet'], text_encoders: ['text_encoders', 'clip'] };
      return (aliases[folder] || [folder]).includes(on.folder) && on.name === name && on.bytes === f.bytes;
    }));
    const graph = profileGraph(p);
    const acceptance = p.hardwareAcceptance;
    const hardwareAcceptance = acceptance && acceptance.workflowKey === workflowEvidenceKey(graph)
      && acceptance.artifactKey === curatedArtifactKey(graph)?.key ? acceptance : null;
    return { ...p, hardwareAcceptance, requires: cap.requires, licence: cap.licence, licenseUrl: bundle.licenseUrl,
      dependencies: { runtime: 'ComfyUI', nodes: [...new Set(Object.values(graph).map(n => n.class_type))],
        installation: target === 'runpod' ? 'Existing AI service installer or guided worker update' : 'Existing Engine setup; node availability checked before use' },
      requiresToken: !!bundle.requiresToken, outputRights: cap.outputRights, region: cap.region || null,
      install: { capability: p.capability, bundle: p.bundle, target },
      files: bundle.files.map(f => ({ relative: f.relative, bytes: f.bytes, sha256: f.sha256 })),
      totalBytes: bundle.totalBytes, localFilesPresent: localPresent,
      fit: machine ? fitFor(cap.requires, machine, { target, graph }) : null };
  });
  const files = [...new Map(profiles.flatMap(p => p.files).map(f => [f.relative + ':' + f.sha256, f])).values()];
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const unknownHardware = profiles.some(p => p.requires.experimental);
  const max = key => unknownHardware ? null : Math.max(...profiles.map(p => Number(p.requires[key] || 0)));
  return { target, selection: { ...selection }, profiles, choices: MODEL_PROFILES.filter(p => p.targets.includes(target)), files,
    storage: { modelBytes: bytes, workingReserveBytes: 20e9, minimumGB: Math.ceil(bytes / 1e9 + 20),
      note: 'Shared files counted once; allow extra space for outputs and partial downloads.' },
    hardware: { vramMinGb: max('vramMinGb'), vramRecGb: max('vramRecGb'), ramMinGb: max('ramMinGb'), ramRecGb: max('ramRecGb'),
      unknown: unknownHardware, execution: 'sequential', note: 'One workflow at a time with ComfyUI model unloading; larger workloads need a fresh fit check.' },
    modeRequired: target === 'runpod' ? 'RunPod GPU' : 'Full Studio',
  };
}

export function rankSetupGpus(plan, gpus = []) {
  // Inventory does not report host RAM or performance benchmarks. Rank by
  // published VRAM floors + price, and keep those limitations on the result.
  const assessed = gpus.filter(g => /^NVIDIA\b/i.test(g.id || '')).map(g => {
    const machine = { gpu: { id: g.id, name: g.name, vendor: 'nvidia', vramGb: g.memoryInGb, count: 1 }, ram: { totalGb: 0 }, secureCloud: g.secureCloud };
    const fits = plan.profiles.map(p => {
      const graph = profileGraph(p);
      return fitFor({ ...p.requires, ramMinGb: 0, ramRecGb: 0 }, machine, { target: plan.target, graph });
    });
    const hardwareEvidenceCandidate = fits.every(f => ['fits', 'streams'].includes(f.state) || f.hardwareValidation?.state === 'candidate')
      && fits.some(f => !!f.hardwareValidation);
    return { ...g, hardwareEvidenceCandidate, gpuFit: fits.some(f => f.state === 'wont-run') ? 'wont-run' : fits.some(f => f.state === 'unknown') ? 'unknown' : fits.every(f => f.state === 'fits') ? 'fits' : 'streams' };
  });
  const candidates = assessed.filter(g => Number.isFinite(g.memoryInGb) && g.memoryInGb > 0 && (['fits', 'streams'].includes(g.gpuFit) || g.hardwareEvidenceCandidate) && ['Low', 'Medium', 'High', 'LOW', 'MEDIUM', 'HIGH'].includes(g.stock)
    && Number.isFinite(g.pricePerHr) && g.pricePerHr > 0).sort((a, b) => a.pricePerHr - b.pricePerHr || a.memoryInGb - b.memoryInGb || a.id.localeCompare(b.id));
  const budget = candidates[0], recommended = candidates.find(g => g.gpuFit === 'fits') || budget;
  const performance = [...candidates].sort((a, b) => b.memoryInGb - a.memoryInGb || a.pricePerHr - b.pricePerHr)[0];
  return { gpus: assessed, budget: budget?.id || null, recommended: recommended?.id || null, performance: performance?.id || null,
    provisional: true, note: recommended?.hardwareEvidenceCandidate ? 'A100 workflow tested; review a fresh Secure quote, host allocation and runtime.' : plan.hardware.unknown ? 'Selected model hardware is unverified; choose manually after reviewing requirements.'
      : 'VRAM and price estimates; host RAM and runtime need checking. Performance means memory headroom, not measured speed.' };
}

export function profileGraph(profile) {
  const opts = { prompt: 'A peaceful landscape', caption: 'A peaceful instrumental melody', lyrics: '', negative: '', seed: 1, prefix: 'setup-check', count: 1,
    ...profile.hardwareAcceptance?.workload, ...profile.settings };
  if (profile.template === 'checkpoint') return checkpointGraph({ ...opts, ckpt: opts.checkpoint });
  if (profile.template === 'ace-step15') return buildAceStep15Graph(opts);
  if (profile.template === 'yue2-comfy') return buildYue2ComfyGraph(opts);
  if (profile.template === 'ltx') return videoGraph({ ...opts, engine: 'ltx' });
  throw Error('This model needs a supported workflow.');
}

export function selectedModelReadiness(plan, { connected = false, stopped = false, bundles = [], objects, verifiedFiles = true, evidenceFor = () => null } = {}) {
  return plan.profiles.map(p => {
    const files = connected && (verifiedFiles ? bundles.some(b => b.id === p.bundle && b.state === 'ready') : p.localFilesPresent);
    let graph, error = null, dependencies = false, workflow = false;
    if (connected && objects) {
      try {
        graph = profileGraph(p);
        dependencies = Object.values(graph).every(n => !!objects[n.class_type]);
        if (files && dependencies) { validateGraph(graph, objects); workflow = true; }
      } catch (e) { error = e.message; }
    }
    const evidence = workflow && !stopped ? evidenceFor(graph) : null;
    return { id: p.id, label: p.label, stopped, workerConnected: connected && !stopped,
      filesDownloaded: !!files && !stopped, filesVerified: !!files && verifiedFiles && !stopped,
      dependenciesAvailable: dependencies && !stopped, workflowValidated: workflow && !stopped,
      inferenceValidated: !!evidence, inference: evidence ? 'Previous test succeeded on this worker build and workload' : 'Not validated on this runtime',
      inferenceEvidence: evidence, historicalHardwareValidated: !!p.hardwareAcceptance, hardwareAcceptance: p.hardwareAcceptance, experimental: !!p.experimental, error };
  });
}

/** Reuse local engine receipts and its existing file/hash cache. Old unhashed
 * receipts remain unverified; no inference or preference changes happen here. */
export async function localModelReadiness(plan, { engine, connected, objects, verify = false }) {
  const rows = selectedModelReadiness(plan, { connected, objects, verifiedFiles: false });
  if (!rows.some(r => r.workflowValidated)) return rows;
  const status = await engine.status().catch(() => null);
  const history = await engine.activity({ limit: 50, statusOf: 'completed' }).catch(() => ({ runs: [] }));
  const records = new Map();
  for (const row of rows) {
    if (!row.workflowValidated) continue;
    const profile = plan.profiles.find(p => p.id === row.id), graph = profileGraph(profile);
    const current = buildRecord(graph, { actor: 'system', via: 'setup.check' });
    await engine.store.resolveRecordFiles(current, { hashModels: verify });
    const exact = files => profile.files.every(f => files.some(on => on.file === f.relative.split('/').pop()
      && on.bytes === f.bytes && on.sha256 === `sha256:${f.sha256}`));
    if (verify) row.filesVerified = exact(current.engineFiles);
    if (!status?.version) continue;
    for (const run of history.runs || []) {
      if (!records.has(run.runId)) records.set(run.runId, await engine.runRecord(run.runId, { graph: true }).catch(() => null));
      const rec = records.get(run.runId);
      if (!rec?.graph || !rec.request?.graphHash || rec.request.enginePort === 'remote'
        || rec.request.engineVersion !== status.version || rec.result?.status !== 'completed'
        || !rec.result.outputs?.some(o => /^(sha256:)?[a-f0-9]{64}$/.test(o.sha256 || '') && o.bytes > 0) || !exact(rec.request.engineFiles || [])
        || workflowEvidenceKey(rec.graph) !== workflowEvidenceKey(graph)) continue;
      const unchanged = (rec.request.engineFiles || []).every(old => current.engineFiles.some(now => now.file === old.file
        && now.resolvedPath === old.resolvedPath && now.bytes === old.bytes && now.mtimeMs === old.mtimeMs));
      if (!unchanged || verify && !row.filesVerified) continue;
      row.filesVerified = true; row.inferenceValidated = true;
      row.inference = 'Previous local inference verified against hashed model files and runtime';
      row.inferenceEvidence = { at: run.t, engineVersion: status.version }; break;
    }
  }
  return rows;
}
