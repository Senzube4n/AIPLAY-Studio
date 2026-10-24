/** Music request adapter for the existing ACE graph/queue, with no I/O. */
import { buildAceStep15Graph, aceMeta, ACE_DEFAULTS, ACE_LANGUAGES, aceKindOf } from '../workflow.js';
import { MODEL_PROFILES } from '../../shared/model-profiles.js';
import { selectedAceDit } from '../../shared/model-profiles.js';
import { hardwareWorkflowMatches } from '../engine/workflow-evidence.js';

// Exact curated artifact metadata only; a filename suffix or a MiniMax
// preference cannot establish the precision of a custom or historical output.
export function aceArtifactPrecision(dit) {
  const precision = MODEL_PROFILES.find(p => p.settings?.dit === dit)?.settings.precision;
  return precision && precision !== 'default' ? precision : null;
}

export function selectAceMusicModels(shelf, { dit, lm } = {}) {
  if (dit != null && (typeof dit !== 'string' || !dit.trim())) throw Error('Choose an installed ACE model.');
  const selected = selectedAceDit(shelf.dits || [], dit);
  if (!selected || !shelf.ready) throw Error('The selected ACE model or its companions are missing. Open Models or Cloud Setup.');
  const planner = lm == null ? shelf.lm : lm;
  if (!planner || !shelf.lms?.includes(planner)) throw Error('The selected planner is missing. Choose an installed planner; no replacement was selected.');
  return { dit: selected, lm: planner };
}
export function prepareAceMusicInput(body, { shelf, savedDit, savedLm, lora = null, cover = null, maxDuration = 600, defaultLoraStrength = 1, requireInstalled = true } = {}) {
  const asked = { dit: body.aceDit ?? savedDit, lm: body.aceLm ?? savedLm ?? shelf.lm };
  const { dit, lm } = requireInstalled ? selectAceMusicModels(shelf, asked) : asked;
  if (!dit || !lm) throw Error('Select an ACE model and planner first.');
  const seed = Number.isFinite(body.seed) ? body.seed : 0;
  const abcKey = typeof body.key === 'string' ? body.key.trim().match(/^([A-Ga-g])([#b]?)(m?)$/) : null;
  const meta = aceMeta({ caption: body.caption, seed, bpm: body.bpm,
    keyscale: body.keyscale || (abcKey ? `${abcKey[1].toUpperCase()}${abcKey[2]} ${abcKey[3] ? 'minor' : 'major'}` : undefined),
    timesignature: body.timesignature || (typeof body.meter === 'string' ? body.meter.split('/')[0] : undefined) });
  const defaults = ACE_DEFAULTS[aceKindOf(dit)];
  const duration = Math.min(Math.max(Number(body.maxDuration) || 240, 30), maxDuration);
  const profile = MODEL_PROFILES.find(p => p.settings?.dit === dit);
  const instrumental = body.instrumental || !String(body.lyrics || '').trim();
  const lyrics = instrumental ? (profile?.id === 'ace15-xl-sft' ? '' : '[Instrumental]') : String(body.lyrics).trim();
  const job = { engine: 'ace-step15', aceDit: dit, aceLm: lm, lora, aceCover: cover,
    acePrecision: aceArtifactPrecision(dit),
    loraStrength: Number.isFinite(Number(body.loraStrength)) ? Math.min(Math.max(Number(body.loraStrength), -4), 4) : defaultLoraStrength,
    bpm: meta.bpm, keyscale: meta.keyscale, timesignature: meta.timesignature, aceMetaFrom: meta.from,
    language: ACE_LANGUAGES.includes(body.language) ? body.language : 'en',
    aceSteps: Number(body.aceSteps) > 0 ? Math.min(Math.round(Number(body.aceSteps)), 100) : defaults.steps,
    aceCfg: Number(body.aceCfg) > 0 ? Math.min(Number(body.aceCfg), 20) : defaults.cfg,
    aceCodes: cover ? false : body.aceCodes === undefined ? !lora : !!body.aceCodes,
    acePlanTemp: Number.isFinite(Number(body.acePlanTemp)) && body.acePlanTemp !== '' && body.acePlanTemp != null ? Math.min(Math.max(Number(body.acePlanTemp), 0), 2) : 0.85,
    maxDuration: duration };
  job.steps = job.aceSteps; job.cfg = job.aceCfg;
  const graph = buildAceStep15Graph({ caption: String(body.caption || '').trim(), lyrics, seed, mixSeed: body.mixSeed,
    duration, bpm: job.bpm, keyscale: job.keyscale, timesignature: job.timesignature, language: job.language,
    steps: job.aceSteps, cfg: job.aceCfg, dit, lm, lora, loraStrength: job.loraStrength,
    codes: job.aceCodes, planTemperature: job.acePlanTemp, cover, prefix: 'aiplay' });
  const accepted = body.instrumental === true && hardwareWorkflowMatches(profile?.hardwareAcceptance, graph);
  job.aceHardwareEvidenceId = accepted ? profile.hardwareAcceptance.id : null;
  return { job, lyrics, graph, profile, historicalHardwareValidated: !!accepted };
}

/** Read-only readiness for the form, separate from historical acceptance. */
export async function checkAceMusic(body, { config, getShelf, localFiles, engine, remoteReadiness, prepared: submitted }) {
  const { setupPlan, selectedModelReadiness, localModelReadiness } = await import('../setup-plan.js');
  if (config.remoteOnly && (body.lora || body.aceCover)) throw Error('Remote ACE references need a supported upload workflow.');
  const prepared = submitted || prepareAceMusicInput(body, { shelf: await getShelf(), savedDit: config.music.aceModel,
    savedLm: config.music.aceLm, maxDuration: config.music.engines['ace-step15'].maxDuration || 300, requireInstalled: false,
    lora: config.remoteOnly ? null : body.lora || null, cover: body.aceCover?.upload || body.aceCover?.song || null });
  if (!prepared.profile) throw Error('Use Cloud Setup or Engine to check this custom ACE workflow.');
  const target = config.remoteOnly ? 'runpod' : 'local';
  const plan = setupPlan({ selection: { music: prepared.profile.id }, target,
    localFiles: target === 'local' ? await localFiles() : [] });
  const graphFor = () => prepared.graph;
  let row, computer, podId;
  if (config.remoteOnly) {
    try { const checked = await remoteReadiness(plan, { graphFor }); row = checked.readiness[0]; computer = checked.computer; podId = checked.podId; }
    catch (e) { row = selectedModelReadiness(plan, { graphFor })[0]; row.error = 'Connect the selected RunPod computer and check its AI service.'; }
  } else {
    const names = [...new Set(Object.values(prepared.graph).map(n => n.class_type))];
    const objects = Object.assign({}, ...await Promise.all(names.map(n => engine.objectInfo(n).catch(() => ({})))));
    row = (await localModelReadiness(plan, { engine, connected: Object.keys(objects).length > 0, objects,
      verify: body.verify === true, graphFor }))[0];
  }
  row.historicalHardwareValidated = prepared.historicalHardwareValidated;
  row.hardwareAcceptance = prepared.historicalHardwareValidated ? prepared.profile.hardwareAcceptance : null;
  if (prepared.profile.id === 'ace15-xl-sft' && prepared.job.aceLm !== prepared.profile.settings.lm) {
    row.filesVerified = false; row.inferenceValidated = false;
    row.error = 'XL-SFT verification requires its 4B planner. Select 4B or return to Model setup.';
  }
  return { ...row, target, computer, podId, reference: prepared.profile.hardwareAcceptance || null,
    ready: row.workerConnected && row.filesVerified && row.workflowValidated, effective: prepared.job };
}
