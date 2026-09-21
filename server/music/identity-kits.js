/** Saved musical source material and explicit new-take recipes. No audio is
 * edited here. Saving, comparing and preparing never touch the generation queue. */
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkScore, compareScores, parseScore } from "../mcp-music-score.js";
import { prepareGgufJob } from "../music-gguf-input.js";

export const KIT_MODES = Object.freeze(["keep_melody", "keep_score", "revise"]);
export const KIT_ROLES = Object.freeze(["theme", "opening", "tension", "closing"]);
export const KIT_ENGINES = Object.freeze(["yue2", "yue2-gguf"]);
export const KIT_NOTE = "The saved notation is preserved as shown; generated audio may depart from it. Each render makes a new take. This does not preserve a singer, waveform or guaranteed duration.";
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const obj = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max, name, empty = false) => {
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (!empty && !value.trim())) fail(`${name} must be ${empty ? "" : "nonempty "}text up to ${max} characters.`);
  return value;
};
const keyOf = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : fail("Use a 1–100 character idempotency key containing letters, numbers, _ or -.");
const idOf = value => typeof value === "string" && /^kit-[0-9a-f]{24}$/.test(value) ? value : fail("Choose a valid music kit id.");
function only(body, fields) {
  if (!obj(body)) fail("Expected a music kit request object.");
  const extra = Object.keys(body).filter(k => !fields.includes(k));
  if (extra.length) fail(`Unsupported music kit fields: ${extra.join(", ")}.`);
}
function notation(abc) {
  text(abc, 65536, "ABC");
  if (Buffer.byteLength(abc) > 65536) fail("ABC exceeds 64 KiB UTF-8.");
  const check = checkScore(abc);
  if (!check.ok) fail(`Score needs attention: ${check.problems.slice(0, 4).map(p => p.says || p.code).join("; ")}`);
  const parsed = parseScore(abc);
  return { abc, sha256: check.sha256, header: check.header, facts: check.facts,
    harmony: Object.fromEntries(Object.entries(parsed.voices).map(([voice, v]) => [voice, v.chords || []])) };
}
function recipe(input, fallback = {}) {
  const engine = input.engine ?? fallback.engine ?? "yue2";
  if (!KIT_ENGINES.includes(engine)) fail("This workflow requires a supplied-ABC backend: YuE2 Python or native YuE2 GGUF. ComfyUI's current graph makes its own score.");
  const quantization = input.quantization ?? (engine === fallback.engine ? fallback.quantization : undefined) ?? (engine === "yue2" ? "none" : "q4_0");
  if (!(engine === "yue2" ? ["none", "fp8"] : ["q4_0", "q8_0"]).includes(quantization)) fail("That precision does not belong to the selected YuE2 backend.");
  const seed = input.seed ?? fallback.seed ?? 831001;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) fail("Seed must be an integer from 0 to 4294967295.");
  const instrumental = input.instrumental ?? fallback.instrumental ?? false;
  if (typeof instrumental !== "boolean") fail("Instrumental must be true or false.");
  const style = text(input.style ?? fallback.style ?? "", 2000, "Style").trim();
  const lyrics = text(input.lyrics ?? fallback.lyrics ?? "", 8000, "Lyrics", true);
  if (instrumental && lyrics.trim()) fail("Clear lyrics before choosing Instrumental; the saved words are never silently removed.");
  if (!instrumental && !lyrics.trim()) fail("Add lyrics or explicitly request Instrumental.");
  if (engine === "yue2-gguf" && (instrumental || !lyrics.trim())) fail("Native YuE2 GGUF currently requires nonempty lyrics. Choose YuE2 Python for an instrumental request.");
  return { style, lyrics, seed, engine, quantization, instrumental };
}

/** Chord annotations live in music lines, not quoted voice/header names. */
export function melodyWithoutChords(abc) {
  const source = notation(abc);
  const stripped = abc.split("\n").map(line => /^\s*(?:[A-Za-z]:|%)/.test(line) ? line : line.replace(/"[^"\r\n]*"/g, "")).join("\n");
  const target = notation(stripped), compared = compareScores(source.abc, target.abc);
  if (Object.values(compared.voices).some(v => !v.notes_identical) || compared.header_changes.length) fail("Removing chord annotations unexpectedly changed notes or timing.");
  return target;
}

export function previewKitVariant(base, input) {
  if (!KIT_MODES.includes(input.mode)) fail("Choose keep_melody, keep_score or revise.");
  if (!KIT_ROLES.includes(input.role) || input.role === "theme") fail("Choose opening, tension or closing for a variant.");
  const name = text(input.name || input.role, 120, "Variant name").trim();
  if (input.mode !== "revise" && input.abc !== undefined && input.abc !== base.score.abc) fail("To change notes, choose Revise composition explicitly.");
  const score = input.mode === "keep_melody" ? melodyWithoutChords(base.score.abc)
    : input.mode === "revise" ? notation(input.abc) : structuredClone(base.score);
  const r = recipe(input, base.recipe), diff = compareScores(base.score.abc, score.abc);
  return { name, role: input.role, mode: input.mode, score, recipe: r, cot: input.mode === "keep_melody" ? "melody" : "full",
    sourceScore: base.sourceScore || null, sourceProvenance: structuredClone(base.sourceProvenance || null),
    changes: diff, note: input.mode === "keep_melody"
      ? `Chord annotations removed; both written note lines remain. Accompaniment is generated from this melody score and the new style. ${KIT_NOTE}`
      : input.mode === "keep_score" ? `Score bytes unchanged; instrumentation and production are style requests. ${KIT_NOTE}` : `Composition explicitly revised. ${KIT_NOTE}` };
}

/** Public generator input, with no unsupported GGUF knobs or claimed score lineage. */
export function kitGenerationRequest(kit, variant, overrides = {}) {
  only(overrides, ["engine", "quantization", "seed", "title"]);
  const r = recipe(overrides, variant.recipe);
  const request = { engine: r.engine, title: text(overrides.title ?? `${kit.name} · ${variant.name}`, 120, "Title"),
    caption: r.style, lyrics: r.lyrics, seed: r.seed, cot: variant.cot, abc: variant.score.abc,
    quantization: r.quantization, instrumental: r.instrumental, narSteps: 32 };
  if (r.engine === "yue2") {
    request.maxDuration = Math.max(1, Math.round(variant.score.facts.nominal_seconds));
    if (variant.sourceScore) {
      request.scoreSlug = variant.sourceScore.slug;
      request.scoreVersion = variant.sourceScore.version;
    }
  } else prepareGgufJob(request, "system"); // shared actual native allowlist and validation
  return request;
}

const mutableFields = ["name", "role", "mode", "abc", "style", "lyrics", "seed", "engine", "quantization", "instrumental"];
const variantHash = v => hash({ score: v.score.sha256, recipe: v.recipe, cot: v.cot, role: v.role, name: v.name });

export function createMusicKits({ appData, readScoreSnapshot, submitGenerate, readJob, capabilities, now = Date.now }) {
  const directory = path.join(appData, "music-kits"), locks = new Map();
  const fileOf = id => path.join(directory, `${idOf(id)}.json`);
  const sources = readScoreSnapshot || (async source => (await import("../score/routes.js")).readScoreVersionSnapshot(source));
  const engines = async () => capabilities ? await capabilities() : KIT_ENGINES.map(id => ({ id, suppliedAbc: true, ready: null }));
  async function load(id) {
    try {
      const saved = JSON.parse(await readFile(fileOf(id), "utf8"));
      if (saved.v !== 1 || saved.id !== id || !Array.isArray(saved.variants) || !Array.isArray(saved.renders)) fail("Saved music kit is invalid; it has not been replaced.", 500);
      return saved;
    } catch (e) { if (e.code === "ENOENT") fail("Music kit was not found.", 404); throw e; }
  }
  async function save(kit) {
    await mkdir(directory, { recursive: true });
    const temp = `${fileOf(kit.id)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(kit, null, 2), "utf8"); await rename(temp, fileOf(kit.id)); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  const locked = (id, fn) => {
    const run = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(id, run); run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => {}); return run;
  };
  const bump = (kit, actor) => { kit.revision++; kit.updatedAt = now(); kit.changedBy = actor; };
  const revision = (kit, expected) => { if (!Number.isInteger(expected) || expected !== kit.revision) fail("This kit changed in another view. Reload before saving or rendering.", 409); };
  const variantOf = (kit, id) => kit.variants.find(v => v.id === id) || fail("That variant does not belong to this kit.", 404);
  const answer = async kit => ({ ok: true, kit, engines: await engines(), note: KIT_NOTE });

  async function list() {
    let entries;
    try { entries = await readdir(directory); } catch (e) { if (e.code === "ENOENT") return { ok: true, kits: [], engines: await engines() }; throw e; }
    const kits = [];
    for (const name of entries.filter(n => /^kit-[0-9a-f]{24}\.json$/.test(n))) {
      const kit = await load(name.slice(0, -5));
      kits.push({ id: kit.id, name: kit.name, theme: kit.theme, revision: kit.revision, updatedAt: kit.updatedAt, variants: kit.variants.length, renders: kit.renders.length });
    }
    return { ok: true, kits: kits.sort((a, b) => b.updatedAt - a.updatedAt), engines: await engines() };
  }
  async function create(body, actor) {
    only(body, ["action", "idempotencyKey", "name", "theme", "abc", "sourceScore", "style", "lyrics", "seed", "engine", "quantization", "instrumental"]);
    const key = keyOf(body.idempotencyKey), id = `kit-${hash(key).slice(0, 24)}`, inputHash = hash(body);
    return locked(id, async () => {
      let existing;
      try { existing = await load(id); } catch (e) { if (e.status !== 404) throw e; }
      if (existing) { if (existing.createHash !== inputHash) fail("That creation key already describes a different kit.", 409); return answer(existing); }
      if ((body.abc !== undefined) === (body.sourceScore !== undefined)) fail("Supply ABC text or an exact source score/version, not both.");
      let source = null;
      if (body.sourceScore !== undefined) {
        only(body.sourceScore, ["slug", "version"]);
        source = await sources(body.sourceScore);
      }
      const score = notation(source?.abc ?? body.abc);
      const r = recipe(body, source ? { style: source.style, lyrics: source.lyrics, seed: source.seed } : {});
      const base = { id: "theme", name: "Theme", role: "theme", mode: "keep_score", score, recipe: r,
        cot: source?.cot === "melody" ? "melody" : "full", createdAt: now(), by: actor,
        sourceScore: source ? { slug: source.slug, version: source.version, sha256: source.sha256 || score.sha256 } : null,
        sourceProvenance: source ? { identity: source.identity || null, weights: source.weights || null,
          verified: source.verified || null, requestVerified: !!source.requestVerified, requestWarning: source.requestWarning || null, by: source.by || null } : null };
      base.hash = variantHash(base);
      const kit = { v: 1, id, name: text(body.name, 120, "Kit name").trim(), theme: text(body.theme ?? "", 2000, "Theme notes", true),
        revision: 1, createHash: inputHash, createdAt: now(), updatedAt: now(), createdBy: actor, changedBy: actor,
        variants: [base], prepared: [], renders: [] };
      await save(kit); return answer(kit);
    });
  }
  async function act(body, actor = "system") {
    if (body?.action === "create") return create(body, actor);
    const id = idOf(body?.id);
    return locked(id, async () => {
      const kit = await load(id);
      const shared = ["action", "id", "expectedRevision"];
      if (body.action === "update") {
        only(body, [...shared, "name", "theme"]); revision(kit, body.expectedRevision);
        if (body.name !== undefined) kit.name = text(body.name, 120, "Kit name").trim();
        if (body.theme !== undefined) kit.theme = text(body.theme, 2000, "Theme notes", true);
      } else if (body.action === "preview_variant" || body.action === "save_variant") {
        only(body, [...shared, "baseVariantId", "idempotencyKey", ...mutableFields]);
        const base = variantOf(kit, body.baseVariantId || "theme"), proposed = previewKitVariant(base, body);
        if (body.action === "preview_variant") { revision(kit, body.expectedRevision); return { ok: true, variant: proposed, generatedAudio: false, saved: false }; }
        const key = keyOf(body.idempotencyKey), variantId = `v-${hash(key).slice(0, 24)}`;
        const prior = kit.variants.find(v => v.id === variantId);
        if (prior) { if (prior.hash !== variantHash(proposed) || prior.parent !== base.id) fail("That variant key already describes another recipe.", 409); return answer(kit); }
        revision(kit, body.expectedRevision);
        if (kit.variants.length >= 100) fail("This kit already has 100 variants. Start a new kit.");
        kit.variants.push({ ...proposed, id: variantId, hash: variantHash(proposed), parent: base.id, createdAt: now(), by: actor });
      } else if (body.action === "prepare") {
        only(body, [...shared, "variantId", "engine", "quantization", "seed", "title"]); revision(kit, body.expectedRevision);
        const variant = variantOf(kit, body.variantId), overrides = Object.fromEntries(["engine", "quantization", "seed", "title"].filter(k => body[k] !== undefined).map(k => [k, body[k]]));
        const request = kitGenerationRequest(kit, variant, overrides);
        // A stored source is a lineage claim. Confirm its exact bytes still exist before reusing that pointer.
        if (variant.sourceScore && request.engine === "yue2") {
          const current = await sources(variant.sourceScore);
          if (hash(current.abc) !== variant.sourceScore.sha256) fail("The original score changed or is missing. Save a new kit from the intended source.", 409);
        }
        const prepared = { id: randomUUID(), variantId: variant.id, variantHash: variant.hash, request, requestHash: hash(request),
          createdAt: now(), expiresAt: now() + 30 * 60_000, by: actor, notationSeconds: variant.score.facts.nominal_seconds, note: KIT_NOTE };
        kit.prepared = [...kit.prepared.filter(p => p.expiresAt > now()).slice(-19), prepared];
        bump(kit, actor); await save(kit); return { ...await answer(kit), prepared, generatedAudio: false };
      } else if (body.action === "render") {
        only(body, [...shared, "preparedId", "idempotencyKey"]);
        const key = keyOf(body.idempotencyKey), prior = kit.renders.find(r => r.idempotencyKey === key);
        if (prior) { if (prior.preparedId !== body.preparedId) fail("That render key already belongs to another reviewed request.", 409); return { ...await answer(kit), render: prior, replayed: true,
          note: prior.jobId ? KIT_NOTE : "This submission was not confirmed. It will not be submitted again automatically; inspect the queue before preparing another request." }; }
        revision(kit, body.expectedRevision);
        if (!submitGenerate) fail("The generation adapter is not available.", 503);
        const prepared = kit.prepared.find(p => p.id === body.preparedId);
        if (!prepared || prepared.expiresAt <= now()) fail("Prepare and review this request again; the previous review expired.", 409);
        const variant = variantOf(kit, prepared.variantId);
        if (variant.hash !== prepared.variantHash || hash(prepared.request) !== prepared.requestHash) fail("The reviewed request no longer matches its saved data.", 409);
        if (kit.renders.length >= 2000) fail("This kit reached its render-record limit. Start a new kit; existing idempotency records remain intact.");
        const row = { id: randomUUID(), idempotencyKey: key, preparedId: prepared.id, variantId: variant.id,
          request: prepared.request, requestHash: prepared.requestHash, status: "submitting", jobId: null, file: null,
          score: null, createdAt: now(), by: actor, error: null };
        kit.renders.push(row); bump(kit, actor); await save(kit);
        try {
          const result = await submitGenerate({ request: structuredClone(row.request), actor, requestId: row.id });
          const job = result?.job || result;
          if (typeof job?.id !== "string" || !job.id) throw new Error("Generation did not return the exact queued job id.");
          row.jobId = job.id; row.status = job.status || "queued";
        } catch (error) {
          row.status = error.definitelyNotQueued ? "refused" : "submission_unknown";
          row.error = error.message;
        }
        bump(kit, actor); await save(kit);
        return { ...await answer(kit), render: row, note: row.status === "submission_unknown"
          ? "The queue response was uncertain. This key will not submit again; inspect the queue before preparing another render." : KIT_NOTE };
      } else if (body.action === "refresh_job") {
        only(body, ["action", "id", "renderId"]);
        const row = kit.renders.find(r => r.id === body.renderId) || fail("That render record does not belong to this kit.", 404);
        if (!row.jobId || !readJob) return { ...await answer(kit), render: row, note: "No exact job is available to query. Nothing was resubmitted." };
        const result = await readJob(row.jobId), job = result?.job || result;
        if (!job || job.id !== row.jobId) fail("The exact job is no longer available; its existing record was retained.", 404);
        row.status = job.status || row.status; row.file = typeof job.file === "string" ? job.file : row.file;
        row.error = job.error || null; row.durationSeconds = job.durationSeconds ?? row.durationSeconds ?? null;
        row.score = job.score || (job.scoreSlug && job.scoreVersion ? { slug: job.scoreSlug, version: job.scoreVersion } : row.score);
        row.updatedAt = now();
      } else fail("Unknown music kit action.");
      bump(kit, actor); await save(kit); return answer(kit);
    });
  }
  async function resolveCue(link) {
    only(link, ["kitId", "variantId", "variantHash"]);
    const kit = await load(idOf(link.kitId)), variant = variantOf(kit, link.variantId);
    if (link.variantHash && link.variantHash !== variant.hash) fail("The chosen music variant changed.", 409);
    return { kitId: kit.id, kitName: kit.name, variantId: variant.id, variantName: variant.name,
      variantHash: variant.hash, role: variant.role, notationSeconds: variant.score.facts.nominal_seconds };
  }
  return { list, get: async id => answer(await load(idOf(id))), act, resolveCue };
}

export function createMusicKitRoutes({ json, readBody, actorFrom = () => "system", ...dependencies }) {
  const store = createMusicKits(dependencies);
  const route = async (req, res, url) => {
    if (url.pathname !== "/api/music-kits") return false;
    try {
      if (req.method === "GET") json(res, 200, url.searchParams.get("id") ? await store.get(url.searchParams.get("id")) : await store.list());
      else if (req.method === "POST") {
        if (Number(req.headers?.["content-length"]) > 192 * 1024) fail("Music kit request exceeds 192 KiB.", 413);
        let body;
        if (typeof req[Symbol.asyncIterator] === "function") {
          const chunks = []; let bytes = 0;
          const input = req.iterator ? req.iterator({ destroyOnReturn: false }) : req;
          for await (const chunk of input) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length;
            if (bytes > 192 * 1024) { req.resume?.(); fail("Music kit request exceeds 192 KiB.", 413); }
            chunks.push(part);
          }
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } else body = await readBody(req);
        if (Buffer.byteLength(JSON.stringify(body)) > 192 * 1024) fail("Music kit request exceeds 192 KiB.", 413);
        json(res, 200, await store.act(body, actorFrom(req)));
      } else json(res, 405, { error: "Use GET or POST." });
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
  route.store = store;
  return route;
}
