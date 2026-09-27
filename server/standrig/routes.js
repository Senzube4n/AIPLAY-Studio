import { createStandRigConnector } from "./connector.js";

function loopback(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
}

function localHost(req) {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers?.host || "");
}

/** One exact Studio route; no dynamic target URL or arbitrary StandRig proxy. */
export function createStandRigRoutes({ json, readBody, sameOriginLocalJson, connector = createStandRigConnector() }) {
  return async function standRigRoutes(req, res) {
    if (!loopback(req) || !localHost(req)) return json(res, 403, { error: "StandRig is available on this machine only." });
    if (req.method === "GET") return json(res, 200, await connector.status());
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!sameOriginLocalJson(req)) {
      return json(res, 403, { error: "StandRig controls require a same-origin local JSON request." });
    }
    try {
      const body = await readBody(req, 8 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "Expected a StandRig action." });
      }
      const keys = Object.keys(body);
      const allowed = body.action === "parameters" ? ["action", "values"]
        : body.action === "control" ? ["action", "command"] : [];
      if (!allowed.length || keys.length !== 2 || keys.some((key) => !allowed.includes(key))) {
        return json(res, 400, { error: "Unknown StandRig action or field." });
      }
      return json(res, 200, await connector.write(body));
    } catch (error) {
      return json(res, error?.tooBig ? 413 : error?.status || 400,
        { error: error?.message || "StandRig request failed." });
    }
  };
}
