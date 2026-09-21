/** Exact saved-stage contracts for the reviewed YuE2 Python runtime. */
import { readFile, readdir, lstat, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const REPLAY_RUNTIME = Object.freeze({ package: "yue2-infer", version: "0.1.6",
  sha256: "17963197ec6c7a87f7519cda132ad70c9843acecf65eeb0d58e41506a744b3ed" });
export const REPLAY_STAGES = Object.freeze({
  plan: { reuse: ["plan"], run: ["semantic", "synthesis", "decode"] },
  semantic: { reuse: ["plan", "semantic"], run: ["synthesis", "decode"] },
  latent: { reuse: ["plan", "semantic", "latent"], run: ["decode"] },
});
const REQUIRED = ["audio.flac", "request.json", "config.json", "plan.json", "plan_manifest.json", "abc_tokens.npy", "prefix.npy", "semantic.npy", "latent.npy"];
const ALLOWED = new Set([...REQUIRED, "score.abc", "aiplay_replay.json"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const bad = message => Object.assign(new Error(message), { status: 409, refusal: "artifact-replay" });
const stable = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value; }
export async function hashArtifact(file) { const h = createHash("sha256"); for await (const part of createReadStream(file)) h.update(part); return h.digest("hex"); }
export async function replayRuntime(python) {
  const home = path.dirname(path.dirname(python));
  let site = path.join(home, "Lib", "site-packages");
  if (!(await stat(site).catch(() => null))?.isDirectory()) {
    const dirs = await readdir(path.join(home, "lib")).catch(() => []);
    const name = dirs.filter(n => /^python\d+\.\d+$/.test(n)).sort().at(-1);
    if (!name) throw bad("The configured Python has no readable YuE2 package; no replay was queued.");
    site = path.join(home, "lib", name, "site-packages");
  }
  const metadata = await readFile(path.join(site, "yue2_infer-0.1.6.dist-info", "METADATA"), "utf8").catch(() => "");
  const version = /^Version: (.+)$/m.exec(metadata)?.[1]?.trim();
  if (version !== REPLAY_RUNTIME.version) throw bad("Artifact replay is pinned to yue2-infer 0.1.6. The installed version is not the reviewed adapter.");
  const root = path.join(site, "yue2"), names = (await readdir(root)).filter(n => n.endsWith(".py")).sort();
  const entries = Object.fromEntries(await Promise.all(names.map(async n => [n, await hashArtifact(path.join(root, n))])));
  const sha256 = digest(stable(entries));
  if (sha256 !== REPLAY_RUNTIME.sha256) throw bad("The installed YuE2 runtime source changed. Replay requires a reviewed compatible runtime, not only the same version label.");
  return { ...REPLAY_RUNTIME, sha256 };
}
/** Actual weight hashing remains the pipeline's mandatory pre-load check. This
 * preflight compares the pinned manifests/config; it never downloads anything. */
export async function replayModelIdentities(modelDir, vaeDir) {
  const result = {};
  for (const [role, dir] of [["mot", modelDir], ["vae", vaeDir]]) {
    const manifest = JSON.parse(await readFile(path.join(dir, "weights_manifest.json"), "utf8"));
    if (!manifest.files || !Object.keys(manifest.files).length) throw bad(`Missing ${role} weight manifest.`);
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!/^model(?:-\d{5}-of-\d{5})?\.safetensors$/.test(name) || !/^[0-9a-f]{64}$/.test(expected.sha256 || "")) throw bad(`Invalid ${role} weight manifest.`);
      if ((await stat(path.join(dir, name))).size !== expected.bytes) throw bad(`${role}/${name} is incomplete.`);
    }
    result[role] = { files: manifest.files, config_sha256: await hashArtifact(path.join(dir, "config.json")) };
  }
  return result;
}
async function checkedFile(dir, name) {
  const file = path.join(dir, name), entry = await lstat(file).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 2 * 1024 ** 3) throw bad(`Missing, linked or oversized saved artifact: ${name}.`);
  return { file, bytes: entry.size, sha256: await hashArtifact(file) };
}
export async function inspectReplaySource(dir, { runtime, weights } = {}) {
  if ((await lstat(dir)).isSymbolicLink()) throw bad("Linked artifact directories are not accepted.");
  const sourceDir = await realpath(dir), receiptFile = await checkedFile(sourceDir, "result.json");
  const receipt = JSON.parse(await readFile(receiptFile.file, "utf8"));
  if (receipt.status !== "complete" || !/^[0-9a-f]{64}$/.test(receipt.identity || "")) throw bad("Only complete, identified Python YuE2 runs can be replayed.");
  if (!(receipt.audio_seconds > 0) || receipt.sample_rate !== 48000) throw bad("The saved run has no valid 48 kHz audio duration.");
  const names = Object.keys(receipt.artifacts || {});
  if (REQUIRED.some(name => !names.includes(name)) || names.some(name => !ALLOWED.has(name))) throw bad("The saved run has an incomplete or unsupported artifact manifest.");
  const files = { "result.json": { bytes: receiptFile.bytes, sha256: receiptFile.sha256 } };
  for (const name of names) {
    const actual = await checkedFile(sourceDir, name), expected = receipt.artifacts[name];
    if (expected?.bytes !== actual.bytes || expected?.sha256 !== actual.sha256) throw bad(`Saved artifact changed: ${name}. The source was not replayed.`);
    files[name] = { bytes: actual.bytes, sha256: actual.sha256 };
  }
  const request = JSON.parse(await readFile(path.join(sourceDir, "request.json"), "utf8"));
  const config = JSON.parse(await readFile(path.join(sourceDir, "config.json"), "utf8"));
  const plan = JSON.parse(await readFile(path.join(sourceDir, "plan.json"), "utf8"));
  const planManifest = JSON.parse(await readFile(path.join(sourceDir, "plan_manifest.json"), "utf8"));
  for (const name of ["plan.json", "abc_tokens.npy", "prefix.npy", ...(plan.abc !== null ? ["score.abc"] : [])])
    if (planManifest[name] !== files[name]?.sha256) throw bad(`Plan integrity differs from the run: ${name}.`);
  if (Object.keys(planManifest).some(n => !["plan.json", "abc_tokens.npy", "prefix.npy", "score.abc"].includes(n))) throw bad("Unexpected saved-plan artifact.");
  if (stable(plan.request) !== stable(request)) throw bad("The plan and saved request disagree.");
  if (config.runtime_sha256 !== REPLAY_RUNTIME.sha256 || (runtime && stable(runtime) !== stable(REPLAY_RUNTIME))) throw bad("Saved artifacts belong to an incompatible YuE2 runtime.");
  if (config.generation?.version !== "yue2-native-v1" || config.generation?.context !== 24576 || config.generation?.ode_method !== "midpoint") throw bad("Saved artifacts use an unsupported generation protocol.");
  if (weights && stable(receipt.weights) !== stable(weights)) throw bad("Saved model/VAE identities differ from the installed listening models. No replay was queued.");
  return { sourceDir, identity: receipt.identity, files, request, config, weights: receipt.weights,
    audioSeconds: receipt.audio_seconds, truncated: receipt.truncated, runtime: REPLAY_RUNTIME };
}
export async function verifyReplayManifest(ref, { runtime, weights } = {}) {
  if (!ref || !Object.hasOwn(REPLAY_STAGES, ref.stage) || !/^[0-9a-f]{64}$/.test(ref.manifestSha256 || "")) throw bad("Invalid prepared replay reference.");
  const raw = await readFile(ref.manifestPath);
  if (digest(raw) !== ref.manifestSha256) throw bad("The prepared replay manifest changed.");
  const manifest = JSON.parse(raw);
  if (manifest.v !== 1 || manifest.stage !== ref.stage || path.resolve(manifest.sourceDir) !== path.resolve(ref.sourceDir)) throw bad("The prepared replay source or stage changed.");
  const current = await inspectReplaySource(ref.sourceDir, { runtime, weights });
  if (stable(current) !== stable(manifest.source)) throw bad("The source changed after replay preparation. Prepare again to review the new source.");
  return manifest;
}
