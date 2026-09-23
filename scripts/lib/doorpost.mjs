/**
 * POST JSON TO THE APP'S DOOR AND WAIT AS LONG AS THE RENDER ACTUALLY TAKES.
 *
 * ⚠ WHY THIS EXISTS, MEASURED RATHER THAN REASONED. `fetch()` in Node gives up
 * roughly 305 seconds after the request goes out if no response HEADERS have
 * arrived. A `wait: true` call to /api/engine holds the response open for the
 * entire render and sends nothing at all until it is finished — so the headers
 * arrive last, and any render past five minutes dies on the client side while
 * the engine is still working perfectly well:
 *
 *     a server that answers after 310 s, over plain fetch():
 *     DIED at 307.3s -> UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error
 *
 * That is not a corner case on this rig. The median H3 clip measured for
 * docs/RESOLUTION_FOR_FACES.md is 317 s, so the ORDINARY render is past the
 * line. Nineteen harnesses in this folder post `wait: true`, and three of them
 * ask for a `timeoutMs` of twenty or forty minutes — a deadline the transport
 * underneath them could never have honoured. The number was decoration, and
 * the failure it produced named headers rather than the render, which is the
 * worst possible thing for it to name.
 *
 * ⚠ AND THE ERROR IS INDISTINGUISHABLE FROM A CRASH IF YOU DO NOT KNOW. The
 * harness prints a transport error, the engine keeps rendering to completion,
 * and the output lands in the library with nothing waiting for it. Every arm
 * after the first in a sweep then runs against a busy engine.
 *
 * THE FIX IS NOT A BIGGER TIMEOUT. `AbortSignal.timeout(n)` is a ceiling, not
 * a floor — it cannot extend the one already there, and undici's headersTimeout
 * has no public knob without taking `undici` as a dependency, which this repo
 * does not have. node:http, which fetch is built on, sets no client deadline of
 * its own unless you ask for one. So this is the same request one layer down.
 *
 * It returns the three things every caller here reads off a Response — `ok`,
 * `status` and `json()` — so a call site changes by one word.
 */
import http from "node:http";
import https from "node:https";

/**
 * @param {string} url      the full door URL, http or https
 * @param {object} [opts]
 * @param {object} [opts.headers]  extra request headers; content-type is set
 * @param {string} [opts.body]     the request body, already stringified
 * @param {string} [opts.method]   defaults to POST
 * @param {number} [opts.timeoutMs] an EXPLICIT deadline, off by default. A
 *        render has no useful upper bound and the engine's own watcher already
 *        gives up and says so; a second guess here would only turn a slow
 *        render into a mystery.
 */
export function postJSON(url, opts = {}) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const body = opts.body ?? "{}";
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol, hostname: u.hostname, port: u.port,
        path: u.pathname + u.search, method: opts.method || "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(opts.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => text,
            /* Rejects the way Response.json() does, so a `.catch(() => ({}))`
             * at a call site keeps meaning what it meant. */
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    /* THE REFUSAL HAS TO SURVIVE THE SWAP. Several harnesses catch this and
     * print "start AIPLAY Studio first"; node:http reports a dead port on the
     * request object rather than as a rejected promise, and `e.cause?.code` is
     * where they look for it. Both spellings are filled in. */
    req.on("error", (e) => {
      if (!e.cause) e.cause = { code: e.code, message: e.message };
      reject(e);
    });
    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(Object.assign(new Error(
          `the door did not answer within ${Math.round(opts.timeoutMs / 1000)}s`,
        ), { cause: { code: "DOOR_TIMEOUT" } }));
      });
    }
    req.end(body);
  });
}
