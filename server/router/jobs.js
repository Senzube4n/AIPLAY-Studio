/**
 * COMFY ROUTER: the runs, from submit to files on disk.
 *
 *   waiting ─► queued ─► running ─► done
 *      │          │          │   └► failed / cancelled
 *      └──────────┴──────────┴────► (every state is written to disk)
 *
 * A run is submitted to the Router's QUEUE with an idempotency key minted
 * once and kept on the record, so a submit retried after a dropped connection
 * or a Studio restart returns the original request rather than a second bill.
 * The record also keeps the Router's request id, and the Router keeps a
 * finished result for 24 hours, so a run that finishes while Studio is closed
 * is collected on the next start.
 *
 * Polling honours `Retry-After` (at least two seconds, at most thirty). There
 * are no progress events in the Router: queue position and state are all
 * there is, and all the page is told.
 *
 * Results are downloaded the moment they arrive, because their URLs expire in
 * hours. The raw result is kept beside the run (long strings cut) so a model
 * whose answer holds more than media can still be read.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { RouterError, readCapped, MAX_ASSET_BYTES } from "./client.js";
import { findAssets, extFor, isAsset } from "./outputs.js";
import { checkPrompt } from "../safety/minors.js";
import { NEGATIVE_KEY, isBlob } from "../safety/graph.js";
import { announceRefusal, safetyError, CODE as SAFETY_CODE, REFUSAL } from "../safety/refusal.js";

/**
 * THE MINORS RULE ON THE CLOUD PATH, which never touches the engine door.
 *
 * A Comfy Router body is a provider's own JSON, and its prompt can sit under
 * any key: `prompt`, `input.prompt`, `instances[].prompt`, `contents[].parts[].text`,
 * `messages`, a system instruction... So every string in it counts, except a
 * key that names a negative prompt, a provider's own safety settings (Gemini's
 * `safetySettings` enums say HARM_CATEGORY_SEXUALLY_EXPLICIT precisely to
 * block it), and an inline picture or sound (a data: URI or base64 whose first
 * bytes are a media file; text padded to LOOK like base64 is read).
 *
 * Every kind is read, text models included: a chat model on this path can be
 * asked for an image tool, an OpenRouter image model is filed as "text", and
 * whatever a run returns is saved. Only a SOUND model is left alone, and only
 * when neither its id nor its body asks for a picture or a video. Checked when
 * a run is added AND again just before it is sent, because runs are kept on
 * disk and resumed after a restart.
 */
const PROVIDER_SAFETY_KEY = /^(safetySettings|safety_settings|safetySetting|safety_identifier|safetyFilterLevel|safety_filter_level|safety_tolerance|moderation|personGeneration|person_generation)$/i;
export function routerWords(body) {
  const out = [];
  const walk = (v, key, depth) => {
    if (depth > 24) return;
    if (PROVIDER_SAFETY_KEY.test(key)) return;
    if (typeof v === "string") {
      if (!NEGATIVE_KEY.test(key) && !isBlob(v) && v.trim()) out.push(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(body, "", 0);
  return out;
}
/** Does this run make a picture or a video, whatever its catalogue kind says? */
const VISUAL_ASK = /image|video|picture|photo|visual|vision|img|mv\b/i;
function asksForPictures(model, body) {
  if (VISUAL_ASK.test(String(model || ""))) return true;
  const probe = JSON.stringify({ m: body?.modalities, r: body?.response_modalities, o: body?.output_modalities,
    f: body?.response_format, t: body?.tools, g: body?.generationConfig?.responseModalities });
  return /image|video/i.test(probe);
}
export function routerVerdict(kind, body, { model = "", prompt = "" } = {}) {
  if (kind === "audio" && !asksForPictures(model, body)) return { ok: true };
  return checkPrompt([...routerWords(body), ...(typeof prompt === "string" && prompt.trim() ? [prompt] : [])]);
}

const KEEP = 300;
const ACTIVE = new Set(["waiting", "queued", "running", "collecting"]);

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";

/** Long base64 and the like, cut, so a kept result stays readable and small. */
export function trimResult(v, depth = 0) {
  if (depth > 12) return "…";
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 200)}… (${v.length} characters)` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trimResult(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimResult(x, depth + 1)]));
  return v;
}

/**
 * @param {object} o
 * @param {object} o.client     createRouterClient()
 * @param {string} o.dir        where the run list and kept results live
 * @param {string} o.outDir     where result files go
 * @param {Function} [o.fetchImpl]  for downloading result assets (never given the key)
 * @param {Function} [o.now]
 */
export function createRouterJobs({ client, dir, outDir, fetchImpl = globalThis.fetch, now = () => Date.now(), tickMs = 2000 } = {}) {
  const file = path.join(dir, "runs.json");
  let runs = [];
  let loaded = false;
  let timer = null;
  let inflight = null;
  const listeners = new Set();

  async function load() {
    if (loaded) return;
    loaded = true;
    try { runs = JSON.parse(await readFile(file, "utf8")) || []; } catch { runs = []; }
  }
  /* ONE WRITER AT A TIME. add() saves and then starts a tick that saves too,
   * and both used the one `runs.json.tmp`: the first rename moved it, and the
   * second threw ENOENT out of add() for a run that HAD been queued. Each save
   * now waits for the one before it; a failed save still lets the next run. */
  let saving = Promise.resolve();
  function save() {
    const next = saving.then(writeRuns, writeRuns);
    saving = next.catch(() => {});
    return next;
  }
  async function writeRuns() {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(runs.slice(0, KEEP)), "utf8");
    await rename(tmp, file);
    for (const fn of listeners) { try { fn(); } catch { /* a listener's problem */ } }
  }
  const view = (r) => ({
    id: r.id, model: r.model, kind: r.kind, label: r.label, prompt: r.prompt,
    status: r.status, position: r.position ?? null, createdAt: r.createdAt, doneAt: r.doneAt || null,
    files: r.files || [], text: r.text || null, error: r.error || null, credits: r.credits ?? null,
    dropped: r.dropped || null, requestId: r.requestId || null,
  });

  function fail(r, e) {
    r.status = e?.type === "cancelled" ? "cancelled" : "failed";
    r.error = { type: e?.type || "internal_error", message: e?.message || String(e), upstream: e?.upstream || "" };
    r.doneAt = now();
    r.body = undefined;
  }

  async function download(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    // Counted as it arrives: a chunked answer with no length is capped too.
    const bytes = await readCapped(res, MAX_ASSET_BYTES);
    return { bytes, mime: res.headers?.get?.("content-type") || "" };
  }

  async function collect(r, got) {
    await mkdir(outDir, { recursive: true });
    const stamp = new Date(r.createdAt).toISOString().slice(0, 10);
    const base = `${stamp}_${slug(r.model.split("/")[1])}_${r.id}`;
    const files = [];
    const put = async (bytes, mime, url = "") => {
      const ext = extFor(mime, url, bytes);
      if (!isAsset(mime, ext)) return;
      const name = `${base}_${files.length + 1}.${ext}`;
      await writeFile(path.join(outDir, name), bytes);
      files.push({ name, mime: String(mime || "").split(";")[0] || null, bytes: bytes.length, ext });
    };
    if (got.bytes) {
      await put(got.bytes, got.contentType);
    } else {
      const found = findAssets(got.json);
      for (const a of found.inline) {
        try { await put(Buffer.from(a.b64.replace(/\s+/g, ""), "base64"), a.mime || ""); } catch { /* not decodable */ }
      }
      for (const u of found.urls) {
        try { const d = await download(u.url); await put(d.bytes, d.mime, u.url); } catch (e) { r.warnings = [...(r.warnings || []), `${u.key || "asset"}: ${e.message}`]; }
      }
      r.text = found.text;
      await mkdir(path.join(dir, "results"), { recursive: true });
      await writeFile(path.join(dir, "results", `${r.id}.json`), JSON.stringify(trimResult(got.json), null, 1), "utf8");
    }
    r.files = files;
    if (got.credits != null) r.credits = Number(got.credits);
    r.status = files.length || r.text ? "done" : "failed";
    if (r.status === "failed") r.error = { type: "no_output", message: "The run finished but returned nothing Studio could save. Its raw answer is kept." };
    r.doneAt = now();
    r.body = undefined;
  }

  async function step(r) {
    /* Cancelled since this tick listed it (cancel() runs between our awaits). */
    if (!ACTIVE.has(r.status)) return;
    if (r.nextAt && r.nextAt > now()) return;
    const wait = (sec, fallback = 5) => { r.nextAt = now() + Math.min(30, Math.max(2, sec ?? fallback)) * 1000; };
    try {
      if (r.status === "waiting") {
        /* ⚠ AGAIN, AT THE LAST STEP: a run added by an older build, or resumed
         * from disk, is checked before a byte of it leaves this machine. */
        const verdict = routerVerdict(r.kind, r.body, { model: r.model, prompt: r.prompt });
        if (!verdict.ok) {
          announceRefusal({ door: "router.step", via: r.model });
          fail(r, { type: SAFETY_CODE, message: REFUSAL });
          r.prompt = "";
          return;
        }
        const s = await client.submit(r.model, r.body, r.idem);
        r.requestId = s.json?.request_id;
        if (!r.requestId) throw new RouterError({ status: s.status, type: "internal_error", detail: "no request id in the answer" });
        /* ⚠ A CANCEL PRESSED WHILE THE SUBMIT WAS IN FLIGHT. cancel() marked
         * the run cancelled and the page said so, but the Router has it now:
         * setting the status below would un-cancel it, and it would be billed
         * and collected after the person was told "cancelled". Tell the
         * Router too, now that there is a request id to cancel. */
        if (r.status === "cancelled") {
          try { await client.cancel(r.model, r.requestId); }
          catch (e) {
            r.error = { type: "cancel_refused", message: `Cancelled while it was being sent, but Comfy had already taken it and refused the cancel (${e.message}). It may still be charged.`, upstream: "" };
          }
          r.body = undefined;
          return;
        }
        r.status = s.json?.status === "IN_PROGRESS" ? "running" : "queued";
        r.position = s.json?.queue_position ?? null;
        if (s.dropped) r.dropped = s.dropped;
        r.body = undefined;          // sent; the Router holds it now
        wait(3);
        return;
      }
      const st = await client.status(r.model, r.requestId);
      if (r.status === "cancelled") return;   // cancelled while the poll was out
      const j = st.json || {};
      if (j.status === "COMPLETED") {
        if (j.error_type) { fail(r, new RouterError({ type: j.error_type, detail: j.detail || "" })); return; }
        r.status = "collecting";
        const got = await client.result(r.model, r.requestId);
        if (got.status === 202) { r.status = "running"; wait(got.retryAfter); return; }
        await collect(r, got);
        return;
      }
      r.status = j.status === "IN_PROGRESS" ? "running" : "queued";
      r.position = j.queue_position ?? null;
      wait(st.retryAfter);
    } catch (e) {
      // A submit or poll that failed after a cancel stays cancelled: no retry.
      if (r.status === "cancelled") { r.body = undefined; return; }
      const err = e instanceof RouterError ? e : new RouterError({ status: 0, type: "internal_error", detail: e.message });
      /* A submit or poll that can succeed later waits, with the SAME key. */
      if (err.retryable && (r.tries = (r.tries || 0) + 1) < 40) {
        r.note = err.message;
        wait(err.retryAfter, Math.min(30, 2 ** Math.min(r.tries, 5)));
        return;
      }
      fail(r, err);
    }
  }

  /* One tick at a time; a second call waits for the one in flight. */
  function tick() {
    if (!inflight) inflight = tickOnce().finally(() => { inflight = null; });
    return inflight;
  }
  async function tickOnce() {
    {
      await load();
      const active = runs.filter((r) => ACTIVE.has(r.status));
      if (!active.length) { stop(); return; }
      let changed = false;
      for (const r of active) {
        const before = JSON.stringify(view(r));
        if (r.status === "collecting") r.status = "running";   // a collect cut off by a restart starts over
        await step(r);
        if (JSON.stringify(view(r)) !== before) changed = true;
      }
      if (changed) await save();
    }
  }
  function start() {
    if (!timer) {
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      timer.unref?.();
    }
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    /** Picks up runs left active by the last session. */
    async resume() {
      await load();
      if (runs.some((r) => ACTIVE.has(r.status))) start();
    },
    async list() {
      await load();
      return runs.map(view);
    },
    /**
     * Queue a run. Nothing is spent until the tick submits it, a moment later.
     * @param {object} o {model, kind, label, prompt, body}
     */
    async add({ model, kind, label, prompt = "", body }) {
      /* Refused before the run exists, so nothing of it is written to disk. */
      const verdict = routerVerdict(kind, body, { model, prompt });
      if (!verdict.ok) {
        announceRefusal({ door: "router.run", via: model });
        throw safetyError({ door: "router.run", hint: verdict.hint, found: verdict.found });
      }
      await load();
      const r = {
        id: randomUUID().slice(0, 8), idem: randomUUID(), model, kind, label,
        prompt: String(prompt || "").slice(0, 300), status: "waiting", createdAt: now(), body,
      };
      runs.unshift(r);
      await save();
      start();
      tick().catch(() => {});
      return view(r);
    },
    async cancel(id) {
      await load();
      const r = runs.find((x) => x.id === id);
      if (!r || !ACTIVE.has(r.status)) return { ok: false, error: "That run is not running." };
      if (r.status === "waiting" && !r.requestId) {
        r.status = "cancelled"; r.doneAt = now(); r.body = undefined;
        await save();
        return { ok: true };
      }
      try {
        await client.cancel(r.model, r.requestId);
        r.status = "cancelled"; r.doneAt = now();
        await save();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /** Forget a finished run. Its files stay where they are. */
    async remove(id) {
      await load();
      const i = runs.findIndex((x) => x.id === id);
      if (i < 0 || ACTIVE.has(runs[i].status)) return { ok: false };
      runs.splice(i, 1);
      await save();
      return { ok: true };
    },
    async rawResult(id) {
      try { return JSON.parse(await readFile(path.join(dir, "results", `${String(id).replace(/[^\w-]/g, "")}.json`), "utf8")); } catch { return null; }
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    tick, stop,
    get outDir() { return outDir; },
  };
}
