import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRemoteClient } from "./remote-client.js";
import { createRunpodAccount } from "./runpod-account.js";
import { studioBootstrap } from "./runpod-bootstrap.js";
import { containedFile, readBody, sendJSON } from "./remote-common.js";
import { bodyOfError } from "../safety/refusal.js";
import { checkpointGraph, buildAceStep15Graph, buildYue2ComfyGraph, videoGraph } from "../workflow.js";
import { qwenImageGraph } from "../qwen-image.js";

/** Additive HTTP surface; local generation continues to use its existing engine. */
export function createRemoteRoutes({ config, getSecret, setSecret, clearSecret, append, actorFrom, adopt, sameOriginLocalJson, fetchFn = fetch,
  bootstrap = studioBootstrap }) {
  if (typeof sameOriginLocalJson !== "function") throw new Error("createRemoteRoutes needs index.js sameOriginLocalJson: a door that spends a paid GPU without it is open to a rebound page.");
  let clientPromise;
  const client = () => clientPromise ||= createRemoteClient({ dataDir: config.dataDir, outputDir: config.outputDir,
    getToken: () => getSecret("RUNPOD_WORKER_TOKEN"), setToken: token => setSecret("RUNPOD_WORKER_TOKEN", token), append, adopt });
  const account = createRunpodAccount({ fetchFn, getApiKey: () => getSecret("RUNPOD_ACCOUNT_API_KEY"),
    setApiKey: key => setSecret("RUNPOD_ACCOUNT_API_KEY", key), clearApiKey: () => clearSecret("RUNPOD_ACCOUNT_API_KEY") });
  const route = async (req, res, url) => {
    if (!url.pathname.startsWith("/api/runpod")) return false;
    try {
      /* THIS MACHINE, ON THE UI PORT, FOR EVERY REQUEST. A same-origin GET
       * carries no Origin, so the Origin rule below never saw a page on a
       * rebound DNS name: it read the job labels (the first words of every
       * prompt), the balance, the Pod IDs and worker URLs, and the renders
       * (review, 2026-09-25). The Host is what such a page cannot fake. */
      const local = [`127.0.0.1:${config.uiPort}`, `localhost:${config.uiPort}`, `[::1]:${config.uiPort}`];
      if (!local.includes(String(req.headers.host || ""))) { sendJSON(res, 403, { error: "RunPod requests are answered only on this PC's own Studio address." }); return true; }
      // Protect local credentials and paid renders against cross-origin browser requests.
      const origin = req.headers.origin;
      const allowed = [`http://127.0.0.1:${config.uiPort}`, `http://localhost:${config.uiPort}`];
      if (origin && !allowed.includes(origin)) { sendJSON(res, 403, { error: "Cross-origin remote rendering requests are not allowed." }); return true; }
      if (req.method !== "GET" && !origin && !req.headers["x-aiplay-actor"]) {
        sendJSON(res, 403, { error: "Send an Origin from AIPLAY or x-aiplay-actor for scripted requests." }); return true;
      }
      /* Every POST but a reference upload is JSON, behind the house guard
       * (index.js sameOriginLocalJson): this Host, this Origin or none, and
       * application/json, which a cross-site page cannot send without a
       * preflight. The upload's body is the file itself. */
      if (req.method !== "GET" && url.pathname !== "/api/runpod/assets" && !sameOriginLocalJson(req)) {
        sendJSON(res, 403, { error: "Send JSON (Content-Type: application/json) from this PC's Studio." }); return true;
      }
      /* The Pod's install command, pinned to this Studio's commit
       * (runpod-bootstrap.js). Read by the setup window; never a branch. */
      if (req.method === "GET" && url.pathname === "/api/runpod/bootstrap") sendJSON(res, 200, bootstrap());
      else if (req.method === "GET" && url.pathname === "/api/runpod/account") sendJSON(res, 200, await account.status());
      else if (req.method === "GET" && url.pathname === "/api/runpod/account/overview") sendJSON(res, 200, await account.overview());
      else if (req.method === "POST" && url.pathname === "/api/runpod/account/connect") {
        const b = JSON.parse((await readBody(req)).toString("utf8")); sendJSON(res, 200, await account.connect(b.apiKey));
      } else if (req.method === "POST" && url.pathname === "/api/runpod/account/disconnect") sendJSON(res, 200, await account.disconnect());
      else if (req.method === "POST" && url.pathname === "/api/runpod/account/pods") {
        const b = JSON.parse((await readBody(req)).toString("utf8")); sendJSON(res, 201, await account.create(b));
      } else if (req.method === "GET" && url.pathname === "/api/runpod/account/templates") {
        sendJSON(res, 200, { templates: await account.templates() });
      } else if (req.method === "POST" && url.pathname === "/api/runpod/account/templates") {
        sendJSON(res, 201, await account.createTemplates());
      } else {
        const power = /^\/api\/runpod\/account\/pods\/([a-zA-Z0-9_-]+)\/(start|stop)$/.exec(url.pathname);
        if (req.method === "POST" && power) {
          if (power[2] === "start") {
            const b = JSON.parse((await readBody(req)).toString("utf8"));
            sendJSON(res, 200, await account.start(power[1], b.confirm));
          } else sendJSON(res, 200, await account.stop(power[1]));
        }
        else {
          const c = await client();
          if (req.method === "GET" && url.pathname === "/api/runpod") sendJSON(res, 200, c.status());
          else if (req.method === "POST" && url.pathname === "/api/runpod/connect") {
            sendJSON(res, 200, await c.connect(JSON.parse((await readBody(req)).toString("utf8"))));
          } else if (req.method === "GET" && url.pathname === "/api/runpod/models") sendJSON(res, 200, await c.models());
          else if (req.method === "GET" && url.pathname === "/api/runpod/setup") sendJSON(res, 200, await c.setup());
          else if (req.method === "POST" && url.pathname === "/api/runpod/setup/install") {
            const b = JSON.parse((await readBody(req)).toString("utf8"));
            sendJSON(res, 202, await c.installBundle(b.bundle, b.acceptLicense));
          } else if (req.method === "POST" && url.pathname === "/api/runpod/setup/cancel") {
            sendJSON(res, 200, await c.cancelInstall());
          } else if (req.method === "POST" && url.pathname === "/api/runpod/assets") {
            sendJSON(res, 200, await c.upload(url.searchParams.get("name"), req));
          } else if (req.method === "POST" && url.pathname === "/api/runpod/workflow") {
            const b = JSON.parse((await readBody(req)).toString("utf8"));
            const options = { ...b.options, prefix: "runpod", seed: Number(b.options?.seed || 0) };
            for (const key of ["width", "height", "seconds", "duration", "maxDuration"]) {
              if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key] <= 0)) throw new Error(`${key} must be a positive number.`);
            }
            if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("Seed must be a non-negative safe integer.");
            const builders = {
              checkpoint: checkpointGraph, qwen: qwenImageGraph, "ace-step15": buildAceStep15Graph,
              "yue2-comfy": buildYue2ComfyGraph, h3: opts => videoGraph({ ...opts, engine: "h3" }),
              ltx: opts => videoGraph({ ...opts, engine: "ltx" }),
            };
            if (!Object.hasOwn(builders, b.template)) throw new Error("Unknown remote workflow template.");
            // Graph building is pure: previewing a template never sends a render.
            sendJSON(res, 200, { graph: builders[b.template](options) });
          } else if (req.method === "POST" && url.pathname === "/api/runpod/jobs") {
            const b = JSON.parse((await readBody(req)).toString("utf8"));
            sendJSON(res, 202, await c.submit({ graph: b.graph, bindings: b.bindings, label: b.label, actor: actorFrom(req), private: b.private === true }));
          } else {
            const cancel = /^\/api\/runpod\/jobs\/([a-f0-9-]+)\/cancel$/.exec(url.pathname);
            const media = /^\/api\/runpod\/jobs\/([a-f0-9-]+)\/files\/([0-9]+)$/.exec(url.pathname);
            if (req.method === "POST" && cancel) sendJSON(res, 200, await c.cancel(cancel[1]));
            else if (req.method === "GET" && media) {
              const relative = c.file(media[1], media[2]);
              if (!relative) { sendJSON(res, 404, { error: "Output is not downloaded yet." }); return true; }
              const file = await containedFile(config.outputDir, relative);
              const size = (await stat(file)).size;
              const ext = path.extname(file).toLowerCase();
              const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
                ".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg" };
              const headers = { "Content-Type": types[ext] || "application/octet-stream", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
              const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
              let start = 0, end = size - 1;
              if (req.headers.range) {
                if (!range) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return true; }
                start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
                if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return true; }
                headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
              }
              res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": end - start + 1 });
              const stream = createReadStream(file, { start, end });
              stream.on("error", () => res.destroy()); stream.pipe(res);
              res.on("close", () => stream.destroy());
            } else sendJSON(res, 404, { error: "Unknown RunPod operation." });
          }
        }
      }
    } catch (e) {
      /* A minors refusal (remote-client.js submit) is the one sentence and a
       * 422, as at every other door; anything else stays a 400. */
      if (!res.headersSent) sendJSON(res, e?.safety ? 422 : 400, e?.safety ? bodyOfError(e) : { error: e.message });
    }
    return true;
  };
  route.start = client;
  return route;
}
