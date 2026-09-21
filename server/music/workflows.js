import { createMusicKitRoutes } from "./identity-kits.js";
import { createMusicReferences } from "./references.js";

/** Shared browser/MCP HTTP boundary. Preparing a reference never submits music. */
export function createMusicWorkflowRoutes({ config, engine, songToScore, json, readBody,
  provenance, submitGenerate, readJob, capabilities }) {
  const kits = createMusicKitRoutes({ json,
    readBody: req => readBody(req, 192 * 1024),
    appData: config.paths.appData, actorFrom: provenance.actorFrom,
    submitGenerate, readJob, capabilities });
  const references = createMusicReferences({ config, engine, songToScore });
  const routes = async (req, res, url) => {
    if (url.pathname === "/api/music-kits") return kits(req, res, url);
    if (url.pathname !== "/api/music-references") return false;
    try {
      if (!["GET", "POST"].includes(req.method)) {
        json(res, 405, { error: "Use GET or POST." }); return true;
      }
      const body = req.method === "GET"
        ? url.searchParams.has("id") ? { action: "get", referenceId: url.searchParams.get("id"), preview: url.searchParams.get("preview") === "true" } : { action: "list" }
        : await readBody(req, 128 * 1024);
      json(res, 200, await references.request(body, { actor: provenance.actorFrom(req) }));
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
  routes.resolveKitCue = link => kits.store.resolveCue(link);
  return routes;
}
