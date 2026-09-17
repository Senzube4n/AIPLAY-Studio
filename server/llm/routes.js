/**
 * /api/llm — the Agent page's cloud model settings.
 *
 *   GET  /api/llm                     every provider: connected?, key hint, chosen model, this month's tokens
 *   GET  /api/llm/models?provider=id  that provider's chat models, oldest first (&fresh=1 skips the cache)
 *   POST /api/llm {action, provider, …}
 *        connect     {key, base?}     check the key against the provider, then save it
 *        disconnect                   forget the key and the chosen model
 *        model       {model}          use this model from now on
 *        test                         send one tiny message and report the reply and the time
 *
 * The key never comes back out of any of these. The page gets `…abcd` and how
 * it is protected, the same bargain as /api/apimode.
 */
import { CloudError, providerById } from "./providers.js";

export function createLlmRoutes({ json, readBody, cloud, config }) {
  function fromBrowserOrNamed(req) {
    const h = req.headers || {};
    if (h["x-aiplay-actor"]) return true;
    const o = String(h.origin || "");
    if (o) return o === `http://127.0.0.1:${config.uiPort}` || o === `http://localhost:${config.uiPort}`;
    return String(h["sec-fetch-site"] || "") === "same-origin";
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/llm" && p !== "/api/llm/models") return false;
    /* Saving a key, or spending tokens on a test, is not something another
     * website open in the same browser gets to do. */
    if (!fromBrowserOrNamed(req)) {
      json(res, 400, { error: "Send x-aiplay-actor: script:<name>, or use the Agent page." });
      return true;
    }

    try {
      if (p === "/api/llm/models") {
        const id = url.searchParams.get("provider") || "";
        if (!providerById(id)) { json(res, 400, { error: "unknown provider" }); return true; }
        const models = await cloud.listModels(id, { fresh: url.searchParams.get("fresh") === "1" });
        json(res, 200, { provider: id, models, current: config.llm.models[id] || null });
        return true;
      }

      if (req.method === "GET") { json(res, 200, await cloud.status()); return true; }
      if (req.method !== "POST") { json(res, 405, { error: "GET or POST /api/llm" }); return true; }

      let b;
      try { b = await readBody(req); } catch { json(res, 400, { error: "that body is not JSON." }); return true; }
      const id = String(b?.provider || "");
      if (!providerById(id)) { json(res, 400, { error: "unknown provider" }); return true; }

      switch (b.action) {
        case "connect": {
          const r = await cloud.connect(id, { key: b.key, base: b.base });
          json(res, 200, { ok: true, ...r, status: await cloud.status() });
          return true;
        }
        case "disconnect":
          await cloud.disconnect(id);
          json(res, 200, { ok: true, status: await cloud.status() });
          return true;
        case "model":
          await cloud.chooseModel(id, b.model);
          json(res, 200, { ok: true, status: await cloud.status() });
          return true;
        case "test": {
          const model = config.llm.models[id];
          if (!model) { json(res, 400, { error: "Pick a model first." }); return true; }
          const t0 = Date.now();
          const text = await cloud.complete({ provider: id, model },
            'Reply with exactly this JSON and nothing else: {"say":"Connected."}', { maxTokens: 512, timeoutMs: 60_000 });
          json(res, 200, { ok: true, model, ms: Date.now() - t0, reply: String(text).slice(0, 300) });
          return true;
        }
        default:
          json(res, 400, { error: "action must be connect, disconnect, model or test" });
          return true;
      }
    } catch (e) {
      const code = e instanceof CloudError ? 400 : 500;
      json(res, code, { error: e?.message || String(e) });
      return true;
    }
  };
}

export default createLlmRoutes;
