/** Read-only recovery for listening pairs made before the Library stored the
 * full YuE2 comparison receipt. A lab row alone is never evidence: the saved
 * audio, engine runs, archived graphs and local provenance must agree. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { audioHash } from "./auditions.js";
import { sha256, sortedJSON } from "../engine/record.js";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const filename = value => typeof value === "string" && !/[/\\]|\.\./.test(value)
  && /\.(flac|wav|mp3|opus)$/i.test(value);
const same = (left, right) => sortedJSON(left) === sortedJSON(right);
const link = (value, id, slot) => same(value, [String(id), slot]);

async function savedPair(appData, before, after) {
  const directory = path.join(appData, "music-listening-lab");
  const names = (await readdir(directory).catch(() => []))
    .filter(name => /^lab-[a-f0-9]{24}\.json$/.test(name)).slice(0, 300);
  for (const name of names) {
    let lab;
    try { lab = JSON.parse(await readFile(path.join(directory, name), "utf8")); }
    catch { continue; }
    if (lab?.v !== 1 || `${lab.id}.json` !== name || !Array.isArray(lab.takes)) continue;
    const base = lab.takes.filter(t => t.file === before && t.role === "base" && t.state === "ready");
    const adapter = lab.takes.filter(t => t.file === after && t.role === "adapter" && t.state === "ready");
    if (base.length !== 1 || adapter.length !== 1 || base[0].caseId !== adapter[0].caseId) continue;
    if (![base[0], adapter[0]].every(t => digest(t.sha256)
      && typeof t.runId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(t.runId) && t.cached === false)) continue;
    return { lab, base: base[0], adapter: adapter[0] };
  }
  return null;
}

function runMatches(record, take) {
  const { request, result, graph } = record || {};
  if (record?.runId !== take.runId || request?.runId !== take.runId || result?.runId !== take.runId
      || request?.via !== "jobs.music" || result?.via !== "jobs.music"
      || result?.status !== "completed" || result.cached !== false || !graph
      || request.graphHash !== result.graphHash || request.graphHash !== sha256(sortedJSON(graph))) return false;
  return result.outputs?.some(output => output?.kind === "audio" && output.file === take.file) === true;
}

function songMatches(events, take, graph, lab, isAdapter) {
  const evidence = events.filter(e => e.type === "generate" && e.asset === take.file
    && e.data?.runId === take.runId && e.data?.params?.runtime === "comfy");
  return evidence.some(e => e.data.params.checkpoint === lab.checkpoint.name
    && e.data.params.lora === (isAdapter ? lab.adapter.name : null)
    && e.data.params.loraStrength === (isAdapter ? lab.strength : null)
    && e.data.seed === graph["5"].inputs.seed
    && e.data.mixSeed === graph["7"].inputs.seed);
}

async function pairChain(appData, events, base, adapter) {
  const raw = await readFile(path.join(appData, "provenance", "library.jsonl"), "utf8");
  const lines = raw.split("\n").filter(line => line.trim());
  if (lines.length !== events.length) return null;
  const first = events.findIndex(e => e.type === "delegate"
    && [base, adapter].some(take => e.asset === `engine/${take.runId}`));
  const pertinent = (e, take) => e.asset === `engine/${take.runId}` ||
    (e.type === "generate" && e.asset === take.file && e.data?.runId === take.runId);
  const last = events.findLastIndex(e => pertinent(e, base) || pertinent(e, adapter));
  if (first < 0 || last <= first) return null;
  for (let i = first + 1; i <= last; i++) {
    if (events[i]?.prev !== sha256(lines[i - 1])) return null;
  }
  return { gapBefore: first > 0 && events[first].prev !== sha256(lines[first - 1]) };
}

/** Return null unless an *existing* lab's two final audio files and the local
 * hash-consistent history prove that only the MODEL LoRA differed. Local
 * provenance has no external signature; this reports setting equality, not
 * audible improvement or authenticity against a machine owner who edits it. */
export async function compareArchivedTrainingPair({ appData, outputDir, before, after, baseline, adapterTake,
  prior, runRecord, readProvenance, verifyProvenance }) {
  if (prior?.status !== "unverified" || prior.checks.some(check => check.status === "mismatch")
      || !filename(before) || !filename(after) || before === after
      || baseline?.engine !== "yue2-comfy" || adapterTake?.engine !== "yue2-comfy") return null;
  const pair = await savedPair(appData, before, after);
  if (!pair) return null;
  const { lab, base, adapter } = pair;
  if (base.runId === adapter.runId || !lab.adapter?.name || !lab.checkpoint?.name
      || !Number.isFinite(lab.strength) || lab.strength === 0
      || adapterTake.lora !== lab.adapter.name || adapterTake.loraStrength !== lab.strength) return null;
  const qBase = base.request, qAdapter = adapter.request;
  if (qBase?.engine !== "yue2-comfy" || qAdapter?.engine !== "yue2-comfy"
      || qBase.checkpoint !== lab.checkpoint.name || qAdapter.checkpoint !== lab.checkpoint.name
      || qBase.lora || qAdapter.lora !== lab.adapter.name || qAdapter.loraStrength !== lab.strength) return null;
  const shared = request => Object.fromEntries(Object.entries(request)
    .filter(([key]) => !["lora", "loraStrength", "title"].includes(key)));
  if (!same(shared(qBase), shared(qAdapter))) return null;

  const [ledger, history, baseHash, adapterHash, baseHead, adapterHead] = await Promise.all([
    verifyProvenance(), readProvenance(), audioHash(path.join(outputDir, before)),
    audioHash(path.join(outputDir, after)), runRecord(base.runId), runRecord(adapter.runId),
  ]);
  /* The engine's graph store constructs a filename from a provenance hash.
   * Fetch only after validating that hash, never straight from a lab row or
   * an unvalidated event. */
  if (!ledger || history?.corrupt !== 0 || !Array.isArray(history.events)
      || baseHash !== base.sha256 || adapterHash !== adapter.sha256
      || ![baseHead, adapterHead].every(run => /^sha256:[a-f0-9]{64}$/i.test(run?.request?.graphHash || ""))) return null;
  const [baseRun, adapterRun] = await Promise.all([
    runRecord(base.runId, { graph: true }), runRecord(adapter.runId, { graph: true }),
  ]);
  if (baseRun?.request?.graphHash !== baseHead.request.graphHash
      || adapterRun?.request?.graphHash !== adapterHead.request.graphHash
      || !runMatches(baseRun, base) || !runMatches(adapterRun, adapter)) return null;
  const first = baseRun.graph, second = adapterRun.graph;
  if (first["1"]?.class_type !== "CheckpointLoaderSimple"
      || first["1"].inputs?.ckpt_name !== lab.checkpoint.name
      || first["5"]?.class_type !== "YuE2GenerateMusic"
      || first["7"]?.class_type !== "KSampler"
      || first["8"]?.class_type !== "VAEDecodeAudio"
      || first["9"]?.class_type !== "SaveAudio"
      || second["2"]?.class_type !== "LoraLoaderModelOnly"
      || !same(second["2"].inputs, { model: ["1", 0], lora_name: lab.adapter.name, strength_model: lab.strength })
      || !link(first["7"].inputs?.model, 1, 0) || !link(second["7"]?.inputs?.model, 2, 0)) return null;
  const normalized = structuredClone(second);
  delete normalized["2"];
  normalized["7"].inputs.model = ["1", 0];
  if (!same(first, normalized)
      || !songMatches(history.events || [], base, first, lab, false)
      || !songMatches(history.events || [], adapter, second, lab, true)) return null;
  /* A prior unrelated ledger gap cannot alter the equality of these two
   * archived graphs. Still require every link *within* their run segment and
   * surface the full-history gap instead of claiming a clean chain. */
  const chain = await pairChain(appData, history.events || [], base, adapter);
  if (!chain) return null;
  const provenanceWarning = !ledger.ok || chain.gapBefore;
  return {
    ...prior,
    status: provenanceWarning ? "unverified" : "matched",
    settingsMatch: true,
    checks: provenanceWarning ? prior.checks : prior.checks.map(check => check.status === "unknown"
      ? { ...check, status: "match", source: "archived-graph" } : check),
    adapter: lab.adapter.name, strength: lab.strength,
    evidence: { source: "archived-local-graphs", labId: lab.id,
      graphHashes: [baseRun.request.graphHash, adapterRun.request.graphHash],
      provenanceWarning: chain.gapBefore ? "The local provenance chain breaks immediately before this pair's first run."
        : provenanceWarning ? "The full local provenance chain has a gap elsewhere." : null },
    message: `Archived run graphs and saved audio fingerprints match structurally; only the MODEL LoRA differs (${lab.adapter.name} at strength ${lab.strength}). ${chain.gapBefore ? "The provenance link into this pair is broken, so Studio leaves its verification status unverified." : provenanceWarning ? "The full local provenance chain has a gap elsewhere, so Studio leaves its verification status unverified." : "Local provenance is hash-consistent but unsigned."} Listen to judge the sound; matching settings do not prove improvement.`,
  };
}
