/**
 * THE RUNNER — the fourth verb, and the only one that spends anything.
 *
 * `start` runs the APPROVED items in array order and returns immediately. Every
 * other verb here is about stopping: pause lets the render in flight finish,
 * resume carries on from where it stopped, stop cancels the plan (and the
 * route cancels the clip in flight with it, server/mv/routes.js stopClipsOf).
 * The rail's Stop PAUSES a plan (pause with byStop): it cancels the render in
 * flight, so the item that render belonged to is approved again and Run
 * carries on from it; nothing the person approved is thrown away.
 *
 * ── THE INVARIANT THIS FILE IS ──────────────────────────────────────────────
 *
 * AN ITEM IS EXECUTED BY CALLING THE TOOL IT NAMES. The table is built by
 * `mvTools()` — the same function server/mcp.js spreads into its own tool list
 * — and the runner does `TOOLS[item.tool].run(item.args)`. There is no switch
 * here, no route path, no translation of a card into a call. That is
 * server/daw/ear.js's invariant 1 ("a proposal carries the REAL MCP call, and
 * the applier CALLS the tool, never a translation of it"), and the reason it
 * matters is that a translation layer is a second execution path: it can drift
 * from the tool the card promised, it can reach a capability an agent has not
 * got, and nobody finds out until a plan does something nobody approved.
 *
 * plan_test.js pins that statically — this file must contain no dispatch label
 * (a switch case on a string), no literal /api/mv fetch, and no hard-coded
 * array of mv_* names. If you are about to add one, the thing you actually want
 * is a tool. ⚠ The check is a plain source match, so it fires on a COMMENT that
 * spells the forbidden thing out as well; that is why this paragraph describes
 * it instead of quoting it.
 *
 * ── ONE ITEM, ONE PLAN, ONE GPU ─────────────────────────────────────────────
 *
 * The in-flight map is module-level and keyed by slug, and `anyRunning()`
 * refuses a second start anywhere. There is one graphics card; two plans
 * walking it at once is two renders queueing behind each other with two
 * progress bars claiming to be the truth.
 *
 * ── WHAT HAPPENS ON A FAILURE, WHICH IS A DECISION AND NOT A DETAIL ─────────
 *
 * `halt` (the default): the plan goes to `paused`, the failed item is `failed`,
 * and EVERY REMAINING APPROVED ITEM STAYS APPROVED. Nothing is un-approved by a
 * failure — a person approved those arguments and they are still approved. What
 * stops is the run, and starting it again is a deliberate act. Approve-then-
 * start holds on every resumption, not only the first.
 *
 * `continue`: the failure is recorded and stepped over, which is regen.js's
 * rule for the same reason ("one wedged render must not cost the caller the
 * ones that worked").
 */
import http from "node:http";
import { mvTools } from "../mcp-mv.js";
import { projectDir } from "./store.js";
import { LIVE_STATES, RUN_OPS, plannableTools } from "./plan.js";

/* ────────────────────────────────────────────── the loopback transport */

/**
 * The `api` a tool table is built with. It posts to this server's own HTTP
 * port, exactly as the MCP process does, so a plan item goes through the SAME
 * route, the same validation and the same provenance seam a direct tool call
 * goes through. In-process shortcuts around the route are how two surfaces
 * start to disagree.
 *
 * ⚠ THE HEADER IS `agent:plan`, EVEN WHEN A HUMAN PRESSED RUN, and that is the
 * opposite of laundering. provenance.js records a non-browser caller claiming
 * to be "user" as "system" precisely so no code path can fabricate a human
 * action — so the runner does not try. The human's contribution is recorded
 * where it actually happened: the `choice` event that approved the item, actor
 * `user`, carrying their edits and their words verbatim. Each `plan_step` names
 * that event in `approvedBy`, so the join is explicit and contemporaneous.
 */
export const PLAN_ACTOR = "agent:plan";

export function loopbackApi({ port, actor = PLAN_ACTOR, fetchImpl = null }) {
  const base = `http://127.0.0.1:${port}`;
  /* ⚠ NOT THE GLOBAL fetch FOR A RENDER. Node's fetch (undici) gives up
   * waiting for the response HEADERS after 300 s, whatever AbortSignal you
   * hand it — and a clip route answers only when the render is done. Eight
   * steps on H3 take about seven minutes, so every eight-step item of the
   * Hex Appeal run came back "fetch failed" while its clip landed as the
   * scene's take (2026-09-19); at three steps, about four minutes, one in
   * forty did. The call goes through node:http, which waits as long as
   * `timeoutMs` says. A `fetchImpl` is still honoured, for the tests' fakes. */
  return async (method, endpoint, body, timeoutMs = 120_000) => {
    if (fetchImpl) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(base + endpoint, {
          method,
          headers: { "content-type": "application/json", "x-aiplay-actor": actor },
          body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
          signal: ctl.signal,
        });
        const text = await res.text();
        let out;
        try { out = text ? JSON.parse(text) : {}; } catch { out = { error: text.slice(0, 400) }; }
        if (!res.ok && !out.error) out.error = `HTTP ${res.status}`;
        return out;
      } finally {
        clearTimeout(timer);
      }
    }
    const payload = method === "GET" ? null : JSON.stringify(body ?? {});
    return new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, method, path: endpoint,
        headers: { "content-type": "application/json", "x-aiplay-actor": actor, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { text += d; });
        res.on("end", () => {
          let out;
          try { out = text ? JSON.parse(text) : {}; } catch { out = { error: text.slice(0, 400) }; }
          if (res.statusCode >= 400 && !out.error) out.error = `HTTP ${res.statusCode}`;
          resolve(out);
        });
        res.on("error", (e) => resolve({ error: String(e.message || e) }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from ${endpoint} in ${Math.round(timeoutMs / 1000)} s`)));
      req.on("error", (e) => resolve({ error: String(e.message || e) }));
      if (payload) req.write(payload);
      req.end();
    });
  };
}

/** A six-line local copy of the name guard, as ear.js passes its own slugOf —
 *  the runner must not reach into the MCP entry point for a helper. */
export const safeName = (v, fallback = "item") => {
  const s = String(v ?? "").replace(/\\/g, "/").split("/").pop();
  return s && !s.includes("..") ? s : fallback;
};

/** name -> tool, built from the live tool list and nothing else. */
export function toolTable(api, nameGuard = safeName) {
  return Object.fromEntries(mvTools(api, nameGuard).map((t) => [t.name, t]));
}

/** The whitelist, DERIVED from that table. plan.js owns the rule; this is the
 *  one place that hands it the real names. */
export const plannableFrom = (tools) => plannableTools(Object.keys(tools));

/* ─────────────────────────────────────────────────── one plan in flight */

/** slug -> { planId, itemId, startedAt, cancelled, paused }. Module-level
 *  because the GPU is machine-wide, not per-request. */
const inFlight = new Map();

export const isRunning = (slug) => inFlight.has(slug);
export const anyRunning = () => (inFlight.size ? [...inFlight.keys()] : []);
export const runState = (slug) => inFlight.get(slug) ?? null;

/* ──────────────────────────────────────────────────────────── the runner */

/**
 * @param deps.tools          name -> {run(args)}. Injected so the walk is
 *                            testable without a server; production passes
 *                            toolTable(loopbackApi(...)).
 * @param deps.updateProject  store.js's, so every transition is serialised
 *                            against the routes and against a render landing.
 * @param deps.provenance     { append, read } — the ledger. `append` writes the
 *                            plan_step; `read` finds the `choice` event that
 *                            authorised the item. A failure to write one must
 *                            never cost a render, so both are caught.
 * @param deps.keepAwake      (on) => void. index.js owns the process.
 * @param deps.noteRun        store.js's, for the activity feed.
 * @param deps.now            the clock.
 */
export function createPlanRunner(deps = {}) {
  const {
    tools = {}, updateProject, provenance = null, keepAwake = () => {},
    noteRun = null, now = () => Date.now(),
  } = deps;

  const scopeFor = (slug) => ({ dir: projectDir(slug) });
  const assetFor = (slug) => `mv/${slug}`;

  async function event(slug, evt) {
    if (!provenance?.append) return null;
    try { return await provenance.append(scopeFor(slug), { asset: assetFor(slug), ...evt }); }
    catch (err) {
      /* Loudly, never silently — a compliance layer that fails quietly is not
       * one — but never fatally: a ledger write must not cost a render. */
      console.error(`[plan] provenance write failed for ${slug}:`, err?.message || err);
      return null;
    }
  }

  /** Read the plan, mutate it under the store's single-writer chain, and hand
   *  back whatever the mutator returned. One door for every transition. */
  async function edit(slug, planId, fn) {
    let out;
    await updateProject(slug, (doc) => {
      const plan = (doc.plans || []).find((p) => p.id === planId);
      if (!plan) throw new Error(`No plan ${planId} on ${slug}.`);
      out = fn(plan, doc);
      return doc;
    });
    return out;
  }

  /**
   * THE WALK. Approved items, in array order, one at a time.
   *
   * It is deliberately not a Promise.all and deliberately not a queue with a
   * concurrency knob: the resource being spent is one graphics card, and the
   * only honest ordering is the one the person reading the card saw.
   */
  async function walk(slug, planId) {
    const flight = inFlight.get(slug);
    let terminal = "done";
    try {
      for (;;) {
        /* Re-read the plan every step: pause, stop and an edit that landed
         * between two renders all arrive through updateProject, so the loop
         * must ask the document rather than trust a snapshot from ten minutes
         * and one H3 clip ago. */
        const step = await edit(slug, planId, (plan) => {
          if (plan.state === "paused") return { stop: "paused" };
          if (plan.state === "cancelled") {
            for (const it of plan.items) {
              if (it.status === "approved") {
                it.status = "skipped";
                it.error = "the plan was stopped before this item ran";
              }
            }
            return { stop: "cancelled" };
          }
          const item = plan.items.find((i) => i.status === "approved");
          if (!item) return { stop: "done" };
          item.status = "running";
          item.startedAt = now();
          plan.state = "running";
          plan.note = `running ${item.id} — ${item.tool}`;
          return { item: { id: item.id, tool: item.tool, args: JSON.parse(JSON.stringify(item.args)) } };
        });

        if (step.stop) { terminal = step.stop; break; }
        const { id, tool, args } = step.item;
        if (flight) { flight.itemId = id; flight.startedAt = now(); }

        const started = now();
        const impl = tools[tool];
        let result = null, error = null;
        if (!impl?.run) {
          /* Refused at propose time normally; reachable if a tool was renamed
           * between the approval and the run, which is exactly the case worth
           * naming rather than throwing a TypeError at. */
          error = `"${tool}" is not a tool this server has. It was legal when the plan was `
            + "proposed, so it has been renamed or removed since.";
        } else {
          try { result = await impl.run(args); }
          catch (err) { error = String(err?.message || err); }
        }
        const ms = now() - started;

        const after = await edit(slug, planId, (plan, doc) => {
          const item = plan.items.find((i) => i.id === id);
          if (!item) return { halted: false };
          item.finishedAt = now();
          if (error) {
            item.status = "failed";
            item.error = error;
            /* STOPPED WHILE IT RAN. Stop now cancels the clip in flight, so its
             * failure lands here on a plan that is already cancelled, and the
             * halt below would turn "stopped" back into "paused". The plan
             * stays what the person made it. */
            if (plan.state === "cancelled") {
              item.error = `stopped while it ran: ${error}`;
              return { halted: true, cancelled: true, failed: true };
            }
            /* PAUSED BY THE STOP BUTTON WHILE IT RAN. The rail's Stop cancels
             * every render in flight and pauses the plan; the render this item
             * was waiting on is one of them. The person approved this item and
             * nobody un-approved it, so it goes back to approved: Run renders it
             * again, and the plan carries on from here. */
            if (plan.state === "paused" && plan.pausedByStop) {
              item.status = "approved";
              item.error = null;
              item.stoppedAt = now();
              delete item.startedAt;
              delete item.finishedAt;
              plan.note = `Paused by the Stop button, which cancelled the render of ${id} (${tool}). `
                + "It is approved again, and everything approved stays approved: press Run to carry on.";
              return { halted: true, failed: false };
            }
            /* ⚠ NOTHING ELSE IS TOUCHED. Every remaining approved item stays
             * approved: a person approved those arguments and a different
             * item's failure did not un-approve them. */
            if (plan.policy.onFailure === "halt") {
              plan.state = "paused";
              plan.note = `stopped at ${id} (${tool}): ${error}. `
                + "The rest are still approved — press Run to carry on.";
            }
            if (noteRun) {
              noteRun(doc, { tool: "plan_step", outcome: `${plan.id} item ${id} failed: ${error}` });
            }
            return { halted: plan.policy.onFailure === "halt", failed: true };
          }
          item.status = "done";
          item.result = { at: now(), ms, ...(result && typeof result === "object" ? result : { value: result }) };
          return { halted: false, result: item.result };
        });

        await event(slug, {
          actor: PLAN_ACTOR,
          type: "plan_step",
          data: {
            planId, itemId: id, tool,
            argsHash: hashArgs(args),
            ok: !error, ms,
            asset: assetOf(result),
            error: error || undefined,
            /* The id of the `choice` event that authorised this item, written
             * by the route that approved it. The join between "a human decided"
             * and "a machine executed" is explicit, or it is not a join. */
            approvedBy: await approvedBy(slug, planId, id),
          },
        });

        if (after.halted) { terminal = after.cancelled ? "cancelled" : "paused"; break; }
      }
    } catch (err) {
      /* A throw out of the loop itself (the document vanished, the store
       * refused) leaves the plan paused rather than stuck at running — a plan
       * frozen at `running` with no runner is the state healPlan exists to
       * clean up, and producing one on purpose would be careless. */
      terminal = "paused";
      try {
        await edit(slug, planId, (plan) => {
          plan.state = "paused";
          plan.note = `the runner stopped: ${String(err?.message || err)}`;
        });
      } catch { /* the document is gone; nothing left to write to */ }
    } finally {
      inFlight.delete(slug);
      try { keepAwake(false); } catch { /* never fatal */ }
    }

    if (terminal === "done") {
      await edit(slug, planId, (plan, doc) => {
        plan.state = "done";
        plan.finishedAt = now();
        const failed = plan.items.filter((i) => i.status === "failed").length;
        const done = plan.items.filter((i) => i.status === "done").length;
        plan.note = `${done} of ${plan.items.length} done${failed ? `, ${failed} failed` : ""}.`;
        if (noteRun) noteRun(doc, { tool: "plan_run", outcome: `${plan.id}: ${plan.note}` });
      }).catch(() => {});
    }
    return terminal;
  }

  /** The `choice` event that approved this item, if the ledger has one. */
  async function approvedBy(slug, planId, itemId) {
    if (!provenance?.read) return null;
    try {
      const { events } = await provenance.read(scopeFor(slug), { asset: assetFor(slug), type: "choice" });
      /* The most recent approval naming this item — an item can be approved,
       * un-approved and approved again, and the one that authorised THIS run is
       * the last one. */
      for (let i = events.length - 1; i >= 0; i--) {
        const d = events[i].data || {};
        if (d.planId !== planId || d.status !== "approved") continue;
        if (Array.isArray(d.items) && !d.items.includes(itemId)) continue;
        return events[i].id;
      }
    } catch { /* no ledger is not an error here */ }
    return null;
  }

  return {
    /**
     * Start, and return immediately. Everything expensive happens behind this
     * call — poll plan_read.
     */
    async start(slug, planId, { resume = false } = {}) {
      if (inFlight.has(slug)) {
        throw new Error(`A plan is already running on ${slug}. Pause it first.`);
      }
      const others = anyRunning();
      if (others.length) {
        throw new Error(
          `A plan is already running on ${others.join(", ")} — there is one GPU. `
          + "Pause or stop that one first.");
      }
      const gate = await edit(slug, planId, (plan) => {
        if (!LIVE_STATES.has(plan.state)) {
          throw new Error(`Plan ${planId} is ${plan.state} and cannot be started.`);
        }
        const approved = (plan.items || []).filter((i) => i.status === "approved");
        if (!approved.length) {
          throw new Error(
            "Nothing is approved. Approve at least one item, or run mv_plan_decide with "
            + "status approved.");
        }
        plan.state = "running";
        plan.note = resume ? "resumed" : "started";
        delete plan.pausedByStop;
        if (!plan.startedAt) plan.startedAt = now();
        return { approved: approved.length };
      });
      inFlight.set(slug, { planId, itemId: null, startedAt: now() });
      try { keepAwake(true); } catch { /* never fatal */ }
      const done = walk(slug, planId);
      /* The promise is returned for tests and for a caller that genuinely wants
       * to wait; the route does not await it, which is what "returns
       * immediately" means. */
      return { started: true, approved: gate.approved, done };
    },

    /**
     * PAUSE LETS THE RENDER IN FLIGHT FINISH, exactly as batch.js does — killing
     * a nearly-complete H3 clip throws away twenty minutes for nothing, and
     * there is no cancel path from here into art.js anyway.
     */
    async pause(slug, planId, { note = null, byStop = false } = {}) {
      const r = await edit(slug, planId, (plan) => {
        /* Already pausing (the plan card's Pause) with its render still in
         * flight: the Stop button cancels that render too, so its item must
         * go back to approved the same way. */
        if (byStop && plan.state === "paused" && inFlight.has(slug)) {
          plan.pausedByStop = true;
          if (note) plan.note = note;
          return { changed: true, state: "paused" };
        }
        if (plan.state !== "running") return { changed: false, state: plan.state };
        plan.state = "paused";
        /* `byStop`: the caller is cancelling the render in flight (the
         * rail's Stop, server/mv/routes.js pauseRunningPlans), so the walk
         * puts that item back to approved instead of failing it. */
        if (byStop) plan.pausedByStop = true;
        plan.note = note || ("pausing — the render in flight will finish first, then the run stops. "
          + "The rest stay approved.");
        return { changed: true, state: "paused" };
      });
      const f = inFlight.get(slug);
      if (f) f.paused = true;
      return r;
    },

    async resume(slug, planId) {
      return this.start(slug, planId, { resume: true });
    },

    /** Replace the plan's note: a caller that learns what really happened
     *  after it changed the plan's state (a Stop, once the clip in flight
     *  has been reached or not) writes it here rather than guessing first. */
    async note(slug, planId, text) {
      return edit(slug, planId, (plan) => { plan.note = String(text || ""); return { note: plan.note }; });
    },

    /**
     * Stop cancels the PLAN. The render in flight is not this file's to
     * cancel: there is no path into art.js from here. The plan card's Stop
     * (server/mv/routes.js) cancels it with stopClipsOf and then writes what
     * really happened through note(); called alone, the note still says the
     * clip finishes, because then it does. The rail's Stop does not come
     * here: it pauses (pause with byStop), so no approval is lost.
     */
    async stop(slug, planId, { note = null } = {}) {
      return edit(slug, planId, (plan) => {
        plan.state = "cancelled";
        plan.finishedAt = now();
        const skipped = [];
        for (const it of plan.items) {
          if (it.status === "approved" || it.status === "proposed" || it.status === "edited") {
            it.status = "skipped";
            it.error = "the plan was stopped";
            skipped.push(it.id);
          }
        }
        plan.note = note || (inFlight.has(slug)
          ? "Stopped. The clip already on the GPU finishes — there is no way to cancel a render "
            + "in flight from here."
          : "Stopped.");
        return { skipped };
      });
    },

    isRunning, anyRunning, runState,
    tools,
  };
}

/* ────────────────────────────────────────────────────── small helpers */

/**
 * A stable fingerprint of the arguments that were actually run, so the ledger
 * can be compared against the plan without copying a prompt into every event.
 *
 * ⚠ KEY ORDER MUST NOT CHANGE THE ANSWER, and JSON.stringify's array-replacer
 * form does not do this: it applies the key list at EVERY depth, so a nested
 * object serialises as `{}` unless its keys happen to appear in the top-level
 * list. Two genuinely different `reference: {...}` blocks would then hash the
 * same. Sorted recursively instead.
 */
export function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

export function hashArgs(args) {
  const s = stableJson(args ?? {});
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `a_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Whatever file a tool says it made, in the several shapes tools return one.
 *  Null is a real answer and means the tool made no file. */
export function assetOf(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.clip === "string") return result.clip;
  if (typeof result.chosen === "string") return result.chosen;
  if (typeof result.file === "string") return result.file;
  if (result.clip && typeof result.clip.clipFile === "string") return result.clip.clipFile;
  if (Array.isArray(result.takes) && result.takes.length) {
    const t = result.takes[result.takes.length - 1];
    if (typeof t === "string") return t;
    if (t && typeof t === "object") return t.clip ?? t.file ?? null;
  }
  return null;
}

export { RUN_OPS };
