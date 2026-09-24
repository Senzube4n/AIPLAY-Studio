/**
 * /api/router: the Comfy API page.
 *
 *   GET  /api/router                   key status (never the key), where results go
 *   POST /api/router {action}          key {key} · forget
 *   GET  /api/router/models            every model, featured first (&fresh=1 re-reads)
 *   GET  /api/router/schema?id=        one model's input, resolved, plus its simple form
 *   POST /api/router/run               {model, simple, files} or {model, body, files}
 *   GET  /api/router/runs              the run list
 *   POST /api/router/runs {action,id}  cancel · remove
 *   GET  /api/router/raw?id=           a finished run's kept answer
 *   GET  /api/router/file/<name>       a result file (ranges supported)
 *
 * The key is saved through server/secrets.js (DPAPI on Windows) and never
 * comes back out: the page gets `…abcd`. Saving checks it first with the one
 * free call there is, `GET /v2/models`.
 *
 * Only this app's own page (or a named script) may call these, because saving
 * a key or starting a paid run is not something another open website gets to
 * do.
 *
 * ⚠ AND THE HOST IS CHECKED FIRST, on every route, result files included. A
 * page on a REBOUND name (evil.example:4173 pointed at 127.0.0.1) is
 * same-origin with itself, so it may send x-aiplay-actor and JSON without a
 * preflight; without a Host check it could start paid runs, swap the saved
 * key for its own (so later prompts and pictures went to its account) and
 * read the run list. Every POST is then held to index.js
 * sameOriginLocalJson(), the one rule for requests that choose what runs or
 * spends on this machine, passed in rather than copied.
 */
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildSimple, featuredById } from "./adapters.js";
import { kindOf, labelOf, HIDDEN_FIELDS } from "./catalog.js";
import { validModelId } from "./client.js";

export const KEY_NAME = "comfyRouterKey";
const MAX_BODY = 100 * 1048576;     // the Router's own request-body cap

const MIME = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
};

/** A generic body from the page's "All settings" form: drops hidden and empty
 *  fields, and puts uploads where the schema said they go. */
export function cleanBody(body, files = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body && typeof body === "object" && !Array.isArray(body) ? body : {})) {
    if (HIDDEN_FIELDS.has(k) || v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  for (const [k, f] of Object.entries(files || {})) {
    if (!f?.data || HIDDEN_FIELDS.has(k)) continue;
    out[k] = f.as === "raw" ? f.data : `data:${f.mime || "application/octet-stream"};base64,${f.data}`;
  }
  return out;
}

/** The words a run is remembered by in the list. */
export function promptOf(simple, body) {
  const s = simple?.prompt || body?.prompt || body?.text_prompt || body?.text || body?.promptText || body?.input?.prompt
    || body?.instances?.[0]?.prompt || body?.content?.find?.((c) => c?.type === "text")?.text
    || body?.messages?.[0]?.content || body?.contents?.[0]?.parts?.[0]?.text || body?.inputs?.[0]?.text || "";
  return typeof s === "string" ? s : "";
}

export function createRouterRoutes({ json, readBody, config, sameOriginLocalJson, secrets, client, catalog, jobs }) {
  if (typeof sameOriginLocalJson !== "function") throw new Error("createRouterRoutes needs index.js sameOriginLocalJson: a credit-spending door without it is open to a rebound page.");
  /* This machine, on the UI port. A rebound DNS name fails here. */
  const localHost = (req) => [`127.0.0.1:${config.uiPort}`, `localhost:${config.uiPort}`, `[::1]:${config.uiPort}`]
    .includes(String(req.headers?.host || ""));
  const fromPage = (req) => {
    const h = req.headers || {};
    if (!localHost(req)) return false;
    if (h["x-aiplay-actor"]) return true;
    const o = String(h.origin || "");
    if (o) return o === `http://${h.host}`;
    return String(h["sec-fetch-site"] || "") === "same-origin";
  };
  const live = async () => ((await secrets.has(KEY_NAME)) ? client.listModels() : null);

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/router" && !p.startsWith("/api/router/")) return false;
    if (!localHost(req)) { json(res, 403, { error: "Only Studio on this machine may use the Comfy API page." }); return true; }

    /* Result files are read by <img>/<video>/<audio>, which send no Origin. */
    if (p.startsWith("/api/router/file/")) {
      const name = decodeURIComponent(p.slice("/api/router/file/".length));
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) { json(res, 400, { error: "bad name" }); return true; }
      const full = path.join(jobs.outDir, name);
      let size;
      try { size = (await stat(full)).size; } catch { json(res, 404, { error: "no such file" }); return true; }
      /* ⚠ A PROVIDER'S FILE, SERVED FROM STUDIO'S OWN ORIGIN. The vector models
       * answer in SVG, and a scripted SVG opened in a tab would run with every
       * door of this app in reach. `sandbox` (alone, so a picture or a video
       * opened directly still shows) gives it an opaque origin with no
       * scripts; nosniff stops a mislabelled file being read as HTML. */
      const head = { "Content-Type": MIME[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" };
      if (url.searchParams.get("download") === "1") head["Content-Disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
        if (start > end || start >= size) { res.writeHead(416, { ...head, "Content-Range": `bytes */${size}` }); res.end(); return true; }
        res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        createReadStream(full, { start, end }).pipe(res);
        return true;
      }
      res.writeHead(200, { ...head, "Content-Length": size });
      createReadStream(full).pipe(res);
      return true;
    }

    if (!fromPage(req)) { json(res, 400, { error: "Send x-aiplay-actor: script:<name>, or use the Comfy API page." }); return true; }
    if (req.method === "POST" && !sameOriginLocalJson(req)) {
      json(res, 403, { error: "Saving a Comfy key or starting a paid run requires a same-origin local JSON request." });
      return true;
    }

    try {
      if (p === "/api/router" && req.method === "GET") {
        json(res, 200, { key: await secrets.status(KEY_NAME), outDir: jobs.outDir, cloudOnly: !!config.cloudOnly });
        return true;
      }
      if (p === "/api/router" && req.method === "POST") {
        const b = await readBody(req);
        if (b.action === "key") {
          const key = String(b.key || "").trim();
          if (!/^\S{16,400}$/.test(key)) { json(res, 400, { error: "That does not look like a Comfy API key." }); return true; }
          try { await client.listModels({ key }); }
          catch (e) { json(res, 400, { error: e.type === "unauthorized" ? "Comfy did not accept that key." : e.message }); return true; }
          const r = await secrets.set(KEY_NAME, key);
          json(res, 200, { ok: true, method: r.method, key: await secrets.status(KEY_NAME) });
          return true;
        }
        if (b.action === "forget") {
          await secrets.clear(KEY_NAME);
          json(res, 200, { ok: true, key: await secrets.status(KEY_NAME) });
          return true;
        }
        json(res, 400, { error: "unknown action" });
        return true;
      }
      if (p === "/api/router/models") {
        json(res, 200, await catalog.models({ live, fresh: url.searchParams.get("fresh") === "1" }));
        return true;
      }
      if (p === "/api/router/schema") {
        const id = url.searchParams.get("id") || "";
        if (!validModelId(id)) { json(res, 400, { error: "not a model id" }); return true; }
        json(res, 200, await catalog.schema(id));
        return true;
      }
      if (p === "/api/router/run" && req.method === "POST") {
        const b = await readBody(req, MAX_BODY);
        const model = String(b.model || "");
        if (!validModelId(model)) { json(res, 400, { error: "Pick a model." }); return true; }
        if (!(await secrets.has(KEY_NAME))) { json(res, 400, { error: "Save your Comfy API key first." }); return true; }
        /* EVERY RUN ASKED FOR ON ITS OWN (server/cloud-switch.js). The page
         * sends confirmSpend only after its "Use Comfy credits?" box said
         * Run; a script has to say it too. Without it nothing is sent. */
        if (b.confirmSpend !== true) {
          json(res, 409, { error: `Running ${labelOf(model)} uses credits from your Comfy account. Nothing was sent: confirm this run first (confirmSpend: true).`, reason: "confirm-spend" });
          return true;
        }
        let body;
        if (b.simple && featuredById(model)?.adapter) {
          body = buildSimple(model, b.simple, b.files || {});
        } else if (b.raw !== undefined) {
          if (!b.raw || typeof b.raw !== "object" || Array.isArray(b.raw)) { json(res, 400, { error: "The JSON must be one object." }); return true; }
          body = b.raw;
        } else {
          body = cleanBody(b.body, b.files);
        }
        if (!Object.keys(body).length) { json(res, 400, { error: "Nothing to send. Fill in the form first." }); return true; }
        const run = await jobs.add({ model, kind: kindOf(model), label: labelOf(model), prompt: promptOf(b.simple, body), body });
        json(res, 200, { ok: true, run });
        return true;
      }
      if (p === "/api/router/runs" && req.method === "GET") {
        json(res, 200, { runs: await jobs.list() });
        return true;
      }
      if (p === "/api/router/runs" && req.method === "POST") {
        const b = await readBody(req);
        const id = String(b.id || "");
        if (b.action === "cancel") { json(res, 200, await jobs.cancel(id)); return true; }
        if (b.action === "remove") { json(res, 200, await jobs.remove(id)); return true; }
        json(res, 400, { error: "unknown action" });
        return true;
      }
      if (p === "/api/router/raw") {
        const r = await jobs.rawResult(url.searchParams.get("id") || "");
        json(res, r ? 200 : 404, r ? { result: r } : { error: "No kept answer for that run." });
        return true;
      }
      json(res, 404, { error: "unknown /api/router route" });
      return true;
    } catch (e) {
      /* A refusal under the minors rule answers 422 with its code, like every door. */
      if (e.safety) { json(res, 422, { error: e.message, code: e.code, ...(e.hint ? { hint: e.hint } : {}), ...(e.found ? { found: e.found } : {}) }); return true; }
      json(res, e.tooBig ? 413 : 400, { error: e.tooBig ? "That upload is over the Router's 100 MB limit." : e.message });
      return true;
    }
  };
}
