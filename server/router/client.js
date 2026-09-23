/**
 * COMFY ROUTER, the HTTP half: one Comfy API key, one route per model.
 *
 *   https://docs.comfy.org/development/comfy-router/reference
 *
 * Every model is `POST /v2/models/{provider}/{model}` with the model's own
 * native JSON body. Studio always uses the QUEUED form (`…/requests`): the
 * synchronous one is cut at ten minutes, video routinely takes longer, and a
 * queued request survives Studio restarting (the result is kept 24 hours).
 *
 * THE RULES THAT COST MONEY IF BROKEN
 *
 *  - Every submit carries an `Idempotency-Key`, minted once per generation and
 *    reused on every retry of it. A retried submit then returns the original
 *    request instead of queueing, and billing, a second one.
 *  - `error_type` is a plain string whose set is expected to grow, so an
 *    unknown value is treated as `internal_error`, never switched over.
 *  - The key goes in `X-API-Key` to api.comfy.org and nowhere else: asset URLs
 *    in results are fetched WITHOUT it (server/router/outputs.js).
 *
 * `fetchImpl` is injectable so the tests drive the whole flow without a network.
 */

export const ROUTER_BASE = "https://api.comfy.org";

/* The documented segments are lowercase alphanumeric slugs; real IDs also
 * carry dots and underscores (`bfl/flux-pro-1.1`, `elevenlabs/eleven_v3`). */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i;
export const validModelId = (id) => typeof id === "string" && MODEL_ID.test(id);

export const KNOWN_ERRORS = new Set([
  "invalid_input", "content_policy_violation", "provider_error", "provider_timeout",
  "insufficient_credits", "model_not_found", "unauthorized", "forbidden",
  "concurrency_limit_exceeded", "client_disconnected", "internal_error",
  "deadline_exceeded", "not_enabled", "service_unavailable", "rate_limited",
  "cancelled", "queue_timeout", "request_not_found",
]);

/** What a person is told for each bucket. Short, and says what to do. */
const SAY = {
  unauthorized: "The Comfy API key was not accepted. Save it again.",
  forbidden: "This key is not allowed to run that model.",
  insufficient_credits: "Not enough Comfy credits. Add credits at platform.comfy.org.",
  not_enabled: "Comfy Router is not switched on for this account yet.",
  model_not_found: "Comfy Router does not know that model.",
  content_policy_violation: "The provider refused this request on content grounds.",
  rate_limited: "Too many requests for now. It will try again shortly.",
  concurrency_limit_exceeded: "Too many runs at once. It will start when one finishes.",
  service_unavailable: "Comfy Router is unavailable right now. It will try again.",
  provider_timeout: "The model's provider did not answer in time.",
  queue_timeout: "The run waited too long in the queue and was dropped.",
  cancelled: "Cancelled.",
};

export class RouterError extends Error {
  constructor({ status = 0, type = "internal_error", detail = "", upstream = "", retryAfter = null, requestId = null } = {}) {
    const t = KNOWN_ERRORS.has(type) ? type : "internal_error";
    super(SAY[t] ? `${SAY[t]}${detail && !SAY[t].includes(detail) ? ` (${detail})` : ""}` : (detail || `Comfy Router answered ${status}.`));
    this.status = status;
    this.type = t;
    this.rawType = type;
    this.detail = detail;
    this.upstream = upstream;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
  }
  /** Worth trying the same call again later, with the same idempotency key. */
  get retryable() {
    return ["concurrency_limit_exceeded", "rate_limited", "service_unavailable", "internal_error", "client_disconnected"].includes(this.type)
      || this.status === 503 || this.status === 0;
  }
}

const seconds = (h) => {
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * @param {object}   o
 * @param {Function} o.getKey     async () => the Comfy API key, or null
 * @param {Function} [o.fetchImpl]
 * @param {string}   [o.base]
 */
export function createRouterClient({ getKey, fetchImpl = globalThis.fetch, base = ROUTER_BASE, timeoutMs = 60_000 } = {}) {
  async function call(method, path, { body, idem, key, accept = "application/json" } = {}) {
    const k = key ?? (await getKey());
    if (!k) throw new RouterError({ status: 401, type: "unauthorized", detail: "no key saved" });
    const headers = { "X-API-Key": k, Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idem) headers["Idempotency-Key"] = idem;
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RouterError({ status: 0, type: "service_unavailable", detail: e.message });
    }
    const h = (n) => res.headers?.get?.(n) ?? null;
    const ctype = String(h("content-type") || "");
    const meta = {
      status: res.status,
      requestId: h("x-comfy-request-id"),
      retryAfter: seconds(h("retry-after")),
      credits: h("x-comfy-credits-used"),
      dropped: h("x-comfy-router-dropped-params"),
      contentType: ctype,
    };
    if (res.status >= 400) {
      let j = null;
      try { j = await res.json(); } catch { /* not JSON */ }
      throw new RouterError({
        status: res.status,
        type: j?.error_type || h("x-comfy-error-type") || (res.status === 401 ? "unauthorized" : "internal_error"),
        detail: typeof j?.detail === "string" ? j.detail : (Array.isArray(j?.detail) ? validationText(j.detail) : ""),
        upstream: j?.upstream_detail || h("x-comfy-upstream-detail") || "",
        retryAfter: meta.retryAfter, requestId: meta.requestId,
      });
    }
    /* A result can be binary: an unauthored output may be `*∕*`. */
    if (ctype && !/json/i.test(ctype)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { ...meta, json: null, bytes };
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ...meta, json, bytes: null };
  }

  const seg = (id) => {
    if (!validModelId(id)) throw new RouterError({ status: 400, type: "invalid_input", detail: `not a model id: ${id}` });
    const [p, m] = id.split("/");
    return `${encodeURIComponent(p)}/${encodeURIComponent(m)}`;
  };
  const rid = (r) => encodeURIComponent(String(r || ""));

  return {
    /** Every model this key can run, with its billing facts. Free to call. */
    async listModels({ key } = {}) {
      const out = [];
      let cursor = null;
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ limit: "100" });
        if (cursor) q.set("cursor", cursor);
        const r = await call("GET", `/v2/models?${q}`, { key });
        for (const m of r.json?.data || []) out.push(m);
        if (!r.json?.has_more || !r.json?.next_cursor) break;
        cursor = r.json.next_cursor;
      }
      return out;
    },
    /** Queue a run. `idem` must be the same on every retry of one generation. */
    async submit(id, body, idem) {
      return call("POST", `/v2/models/${seg(id)}/requests`, { body, idem });
    },
    async status(id, requestId) {
      return call("GET", `/v2/models/${seg(id)}/requests/${rid(requestId)}/status`);
    },
    /** 200 with the native result, or 202 with the status body while running. */
    async result(id, requestId) {
      return call("GET", `/v2/models/${seg(id)}/requests/${rid(requestId)}`, { accept: "*/*" });
    },
    async cancel(id, requestId) {
      return call("PUT", `/v2/models/${seg(id)}/requests/${rid(requestId)}/cancel`);
    },
  };
}

/** A 422's `detail[]` as one readable line: "prompt: Field required; …". */
export function validationText(detail) {
  return detail.slice(0, 4).map((d) => {
    const at = Array.isArray(d?.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
    return `${at ? `${at}: ` : ""}${d?.msg || "invalid"}`;
  }).join("; ");
}
