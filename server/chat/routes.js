/**
 * CHAT v1 — HTTP routes, mounted at /api/chat.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else:                          │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createChatRoutes } from "./chat/routes.js";               │
 * │                                                                        │
 * │  2. beside the other runners:                                          │
 * │     const chatRoutes = createChatRoutes({ json, readBody, config });    │
 * │                                                                        │
 * │  3. beside the other prefix blocks inside the handler's `try`:         │
 * │     if (p === "/api/chat" || p.startsWith("/api/chat/")) {             │
 * │       if (await chatRoutes(req, res, url)) return; }                   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * TWO ACTIONS, and the reason there are exactly two is that this surface is
 * small on purpose:
 *
 *   POST /api/chat            send one message; the answer streams back as SSE
 *   GET  /api/chat/sessions   the conversations on this disk (add ?id= for one)
 *
 * ── WHY SERVER-SENT EVENTS, AND WHAT IS AND IS NOT STREAMED ───────────────
 *
 * ⚠ THE MODEL IS ONE NODE OUTPUT, NOT A TOKEN STREAM. ComfyUI's TextGenerate
 * node returns its whole string when the graph finishes; there is no partial
 * decode to forward and this route does not pretend otherwise. What streams is
 * the loop's PHASES — thinking, tool_call, tool_result, say, proposal — and
 * those are worth streaming precisely because a single step can take seconds
 * and a tool behind it can take minutes. A person watching "thinking… calling
 * list_library… 14 tracks" knows the thing is alive; a person watching a
 * spinner for forty seconds does not. If token streaming is ever wanted, it is
 * a change to the NODE, not to this file.
 *
 * ── THE ATTRIBUTION RULE IS THE DOOR'S ────────────────────────────────────
 *
 * Same shape as server/engine/routes.js: a browser is recognised by the Origin
 * header it sends and needs nothing; anything else must say who it is with
 * `x-aiplay-actor`. This route spends GPU time (the model itself does) and
 * every one of its tools reaches a route that records, so a request nobody will
 * own is refused rather than filed under a name that means "the app did this on
 * its own".
 *
 * ── SESSIONS ARE JSONL, ONE FILE PER CONVERSATION ─────────────────────────
 *
 * `<appData>/chat/<id>.jsonl`, one JSON object per line, appended as the turn
 * happens. The same shape the provenance ledger uses and for the same reason:
 * an append cannot corrupt what is already written, a half-written line at the
 * end of a crash costs one turn rather than the conversation, and the file is
 * readable with `tail`. There is no database here and there should not be one.
 */
import { mkdir, readdir, readFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { config as defaultConfig } from "../config.js";
import { createChatTools } from "./tools.js";
import { runTurn, newSession, createQwenModel } from "./loop.js";
import { createChatModels } from "./models.js";
import { createMusicTools, MUSIC_INTRO, describeForm, applyFormPatch } from "./music-tools.js";
import { createFormTools, formIntro, describeScreen, applyScreenPatch } from "./form-tools.js";
import { routedRegistry, ROUTABLE } from "./router.js";
import { engine as defaultEngine } from "../engine/client.js";

const HELP_ACTOR =
  "This route runs the local model on the shared graphics card and records what it does. "
  + "Send x-aiplay-actor: script:<name> or agent:<name> — a browser is recognised by its "
  + "Origin header and needs nothing.";

const ID_RE = /^[a-z0-9_-]{1,64}$/i;

/** Routed tools per message when a cloud model answers (the local model gets ROUTE_LIMIT). */
export const CLOUD_ROUTE_LIMIT = 16;

export function createChatRoutes(deps = {}) {
  const { json, readBody } = deps;
  const config = deps.config || defaultConfig;
  const engine = deps.engine || defaultEngine;
  /* SCOPE "music" is the Music panel's Simple mode: the same loop, sessions and
   * model, but only the three form tools, a narrower opening, its own
   * conversations folder and its own path (/api/chat/music). */
  /* SCOPES "image" AND "video" are the Images and Video panels' Simple mode
   * (form-tools.js): the same again, with generic form tools, at
   * /api/chat/image and /api/chat/video. */
  const scope = ["music", "image", "video"].includes(deps.scope) ? deps.scope : "studio";
  const panel = scope === "image" || scope === "video";
  const base = scope === "studio" ? "/api/chat" : `/api/chat/${scope}`;
  const tools = scope === "music" ? (deps.musicTools || createMusicTools())
    : panel ? createFormTools(scope)
    : (deps.tools || createChatTools({ uiPort: config.uiPort }));
  const cloud = deps.cloud || null;
  const chatModels = scope !== "studio"
    ? (deps.musicChatModels || createChatModels({ engine, config, key: "chatModelMusic", fallbackKey: "chatModel", cloud, gpu: deps.gpu }))
    : (deps.chatModels || createChatModels({ engine, config, cloud, gpu: deps.gpu }));
  const model = deps.model || createQwenModel({ engine, resolve: chatModels.resolve, cloud });
  const dir = scope !== "studio"
    ? ((scope === "music" && deps.musicDir) || path.join(deps.dir || path.join(config.paths.appData, "chat"), scope))
    : (deps.dir || path.join(config.paths.appData, "chat"));
  const musicRoutes = scope !== "studio" ? null
    : createChatRoutes({ ...deps, scope: "music", engine, config });
  const panelRoutes = scope !== "studio" ? []
    : ["image", "video"].map((s) => [`/api/chat/${s}`, createChatRoutes({ ...deps, scope: s, engine, config, chatModels: undefined, musicChatModels: deps.musicChatModels })]);

  /* Live sessions, so a multi-turn conversation keeps its pending proposal in
   * memory rather than re-reading it off disk between two messages. The JSONL
   * is the durable copy; this is the working one. */
  const live = new Map();

  /**
   * A browser on this app's own page, by headers a browser sends and a
   * command-line tool does not.
   *
   * ⚠ MEASURED IN A REAL BROWSER, 2026-09-05. `Origin` ALONE IS NOT ENOUGH, and
   * the reason is a rule of the fetch spec rather than anything about this app:
   * a browser sends `Origin` on a POST but OMITS IT on a same-origin GET. So
   * the page's own `GET /api/chat/sessions?limit=30` arrived with no Origin and
   * no actor and was refused 400 — every time, in Chrome, on the real page. The
   * visible cost was the whole "Earlier" picker: it silently emptied itself at
   * boot and blanked after the first turn, and no test caught it because every
   * test in server/chat/routes_test.js sends `x-aiplay-actor` and therefore
   * never walks the browser's path.
   *
   * `Sec-Fetch-Site: same-origin` is the header that closes it. It IS sent on
   * that GET, it is a FORBIDDEN HEADER NAME so no page script can forge it, and
   * a request from another site says `cross-site` and is still refused. curl
   * and node send neither header and must still name themselves, which is the
   * whole point of the gate.
   */
  function sameOriginBrowser(req) {
    const h = req?.headers || {};
    const o = String(h.origin || "");
    if (o) return o === `http://127.0.0.1:${config.uiPort}` || o === `http://localhost:${config.uiPort}`;
    return String(h["sec-fetch-site"] || "") === "same-origin";
  }

  const file = (id) => path.join(dir, `${id}.jsonl`);

  async function append(id, row) {
    await mkdir(dir, { recursive: true });
    await appendFile(file(id), `${JSON.stringify(row)}\n`, "utf8");
  }

  async function readSession(id) {
    let text;
    try { text = await readFile(file(id), "utf8"); } catch { return null; }
    const turns = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      /* A half-written last line is the crash case this format is chosen for:
       * it costs the turn it was writing and nothing before it. */
      try { turns.push(JSON.parse(line)); } catch { /* keep the rest */ }
    }
    return { id, turns };
  }

  async function listSessions(limit = 30) {
    let names;
    try { names = await readdir(dir); } catch { return []; }
    const rows = [];
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -6);
      let st; try { st = await stat(path.join(dir, n)); } catch { continue; }
      const s = await readSession(id);
      const first = (s?.turns || []).find((t) => t.role === "user");
      rows.push({
        id, at: st.mtimeMs, bytes: st.size,
        turns: (s?.turns || []).length,
        opened_with: first ? String(first.text).slice(0, 120) : null,
      });
    }
    rows.sort((a, b) => b.at - a.at);
    return rows.slice(0, limit);
  }

  /**
   * The JSONL rows, turned back into the turns the LOOP speaks.
   *
   * ⚠ MEASURED, 2026-09-05, adversarial re-check of this strand. Two shapes
   * meet in this file and they are not the same shape. What is APPENDED is the
   * stream: `{role:"user"}` for the person, and `{role:"event", type:…}` for
   * everything the loop emitted. What loop.js's renderTranscript READS is
   * `{role:"say"|"tool_call"|"tool_result"|"tool_error"|"note"}`. Handing the
   * raw rows back as `session.turns` therefore rendered — measured, exactly —
   *
   *     PERSON: what's in my library?
   *     PERSON: and how long is that one?
   *
   * and nothing else. Every answer and every tool result the conversation ever
   * had was dropped on the floor at the moment it was resumed, so the model saw
   * a person asking follow-up questions about things it had never been told.
   * The earlier-conversations picker looked like it worked because the PAGE
   * reads the event rows correctly; only the model was left amnesiac.
   *
   * The rows the loop does not need — thinking, raw, done, open, end, busy —
   * are dropped rather than translated: they are progress, not conversation.
   * A `proposal` becomes the same note the live loop writes, so a resumed
   * transcript says a spend was offered rather than implying it was run.
   */
  function turnsFromRows(rows) {
    const turns = [];
    for (const r of rows || []) {
      if (!r || typeof r !== "object") continue;
      if (r.role === "user") { turns.push({ role: "user", text: r.text, at: r.at }); continue; }
      if (r.role !== "event") { turns.push(r); continue; }   // already loop-shaped
      switch (r.type) {
        case "say": turns.push({ role: "say", text: r.text, at: r.at }); break;
        case "tool_call": turns.push({ role: "tool_call", tool: r.tool, args: r.args || {}, at: r.at }); break;
        case "tool_result":
          if (r.error) turns.push({ role: "tool_error", tool: r.tool, error: r.error, at: r.at });
          else turns.push({ role: "tool_result", tool: r.tool, result: r.result, at: r.at });
          break;
        case "proposal":
          turns.push({ role: "note", text: `proposed ${r.tool} and waited for the person to confirm`, at: r.at });
          break;
        case "confirmed":
          turns.push({ role: "note", text: `the person confirmed ${r.tool}`, at: r.at });
          break;
        /* `promise` belongs with the other progress rows: it records only that a
         * reply announced an action and was asked again, and the `say` after it
         * already carries the honest answer the person was actually given. */
        default: break;   // thinking / raw / reask / repeat / promise / busy / done / open / end / error
      }
    }
    return turns;
  }

  /** Get the in-memory session, rehydrating its turns off disk on first touch. */
  async function sessionFor(id) {
    if (id && live.has(id)) return live.get(id);
    if (id && ID_RE.test(id)) {
      const saved = await readSession(id);
      const s = newSession(id);
      if (saved) s.turns = turnsFromRows(saved.turns);
      /* `pending` is deliberately NOT restored. A proposal that outlived the
       * process is a spend nobody is watching for: a "yes" typed into a
       * reopened conversation would run arguments agreed at some earlier hour,
       * and the cost of not restoring it is one cheap re-ask. */
      live.set(s.id, s);
      return s;
    }
    const s = newSession();
    live.set(s.id, s);
    return s;
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (musicRoutes && (p === "/api/chat/music" || p === "/api/chat/music/models")) return musicRoutes(req, res, url);
    for (const [at, r] of panelRoutes) if (p === at || p === `${at}/models`) return r(req, res, url);
    const mine = scope !== "studio"
      ? (p === base || p === `${base}/models`)
      : (p === "/api/chat" || p === "/api/chat/sessions" || p === "/api/chat/models");
    if (!mine) return false;

    /* THE ATTRIBUTION GATE, before the body is even read. */
    if (!req.headers["x-aiplay-actor"] && !sameOriginBrowser(req)) {
      json(res, 400, { error: HELP_ACTOR });
      return true;
    }

    /* GET: the language models ComfyUI can load for chat, and the one in use.
     * POST {"model":"file"}: use that one from now on (saved in settings). */
    if (p === `${base}/models`) {
      if (req.method === "GET") { json(res, 200, await chatModels.status()); return true; }
      if (req.method !== "POST") { json(res, 405, { error: "GET or POST /api/chat/models" }); return true; }
      let body;
      try { body = await readBody(req); } catch { json(res, 400, { error: "that body is not JSON." }); return true; }
      if (typeof body?.model !== "string" || !body.model) { json(res, 400, { error: 'POST {"model":"<file>"}' }); return true; }
      try { await chatModels.choose(body.model); } catch (e) { json(res, 400, { error: e.message }); return true; }
      json(res, 200, await chatModels.status());
      return true;
    }

    if (p === "/api/chat/sessions") {
      if (req.method !== "GET") { json(res, 405, { error: "GET /api/chat/sessions" }); return true; }
      const id = url.searchParams.get("id");
      if (id) {
        if (!ID_RE.test(id)) { json(res, 400, { error: "bad session id" }); return true; }
        const s = await readSession(id);
        json(res, s ? 200 : 404, s || { error: "no such session" });
        return true;
      }
      json(res, 200, { sessions: await listSessions(Number(url.searchParams.get("limit")) || 30) });
      return true;
    }

    if (req.method !== "POST") {
      json(res, 405, { error: 'POST a body like {"message":"what is in my library?"}' });
      return true;
    }

    let b;
    try { b = await readBody(req); }
    catch { json(res, 400, { error: "that body is not JSON." }); return true; }

    const message = String(b.message ?? "").trim();
    if (!message) { json(res, 400, { error: "message is required" }); return true; }
    const wanted = b.session === undefined || b.session === null ? null : String(b.session);
    if (wanted && !ID_RE.test(wanted)) { json(res, 400, { error: "bad session id" }); return true; }

    const session = await sessionFor(wanted);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      /* The Studio serves itself and nothing else; this is here because a proxy
       * that buffers an event stream turns it back into the spinner this route
       * exists to replace. */
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    send({ type: "open", session: session.id });

    /* Written to disk as they happen rather than at the end, so a conversation
     * survives the tab being closed mid-render. */
    const writes = [];
    /* Simple mode: the form as the model should see it, kept current as its own
     * tools write into it during the turn. */
    const form = scope !== "studio" && b.form && typeof b.form === "object"
      ? { ...b.form, settings: { ...(b.form.settings || {}) } } : null;
    /* remix_song reads the attached songs and the remix models off this
     * snapshot. Its own tool set per message: one shared set held ONE screen,
     * so two tabs sending at once could remix against each other's songs. */
    const musicTurn = scope === "music" ? (deps.musicTools ? tools : createMusicTools())
      : panel ? createFormTools(scope) : null;
    musicTurn?.setScreen?.(form);
    /* The page's Stop aborts this request; the turn then stops at its next
     * step instead of carrying on with nobody listening. */
    let gone = false;
    res.on("close", () => { if (!res.writableEnded) gone = true; });
    const emit = (ev) => {
      if (form && ev.type === "tool_result" && ev.result?.form) (panel ? applyScreenPatch : applyFormPatch)(form, ev.result.form);
      send(ev);
      if (ev.type === "raw") return;   // the model's whole reply is in the turns already
      writes.push(append(session.id, { role: "event", ...ev, at: Date.now() }).catch(() => {}));
    };

    try {
      await append(session.id, { role: "user", text: message, at: Date.now() });
      /* THE TOOLS THIS MESSAGE MAY REACH. The eight written ones always, plus
       * whatever the router matched out of the wider surface — chosen in
       * JavaScript against names and one-line summaries, so it costs no model
       * call and no card.
       *
       * `pinned` carries the pending proposal through, and it is load-bearing
       * rather than tidy: a proposal is answered by the word "yes", "yes"
       * matches no tool by its own words, and without this the confirm turn
       * would look the agreed tool up in a registry that no longer held it and
       * call `.run` on undefined. */
      /* A cloud model has a context window the local 4B does not, so it is
       * shown more of the studio per message. */
      const cloudTurn = typeof model.usesCard === "function" && !(await model.usesCard().catch(() => true));
      /* Tools used in the last few turns stay reachable: "now do it to that
       * one" matches no tool by its own words, and the model lost the tool it
       * had just used. Never a deleting one — those come only when asked. */
      const recent = [...new Set(session.turns.filter((t) => t.role === "tool_call").slice(-4).reverse().map((t) => t.tool))]
        .filter((n) => ROUTABLE[n] !== undefined && ROUTABLE[n] !== "destroys").slice(0, 2);
      const turnTools = scope !== "studio" ? musicTurn : routedRegistry(tools, message, {
        pinned: [...new Set([...(session.pending ? [session.pending.tool] : []), ...recent])],
        ...(cloudTurn ? { limit: CLOUD_ROUTE_LIMIT } : {}),
      });
      if (turnTools.routed.length) emit({ type: "routed", tools: turnTools.routed });
      const out = await runTurn({
        tools: turnTools, engine, model, stopped: () => gone,
        /* GPU work runs when asked, with a warning and Cancel on the page
         * (loop.js "GO, WITH A WARNING"). settings.json chatConfirmGpu: true
         * brings the old ask-first card back. */
        autoSpend: deps.autoSpend ?? config.chatConfirmGpu !== true,
        ...(scope === "music" ? { intro: MUSIC_INTRO, context: () => describeForm(form) }
          : panel ? { intro: formIntro(scope), context: () => describeScreen(form, scope) } : {}),
      }, session, message, emit);
      await Promise.allSettled(writes);
      send({ type: "end", ok: out.ok !== false, session: session.id });
    } catch (e) {
      send({ type: "error", text: e?.message || String(e) });
      send({ type: "end", ok: false, session: session.id });
    }
    res.end();
    return true;
  }

  handle.listSessions = listSessions;
  handle.readSession = readSession;
  handle.turnsFromRows = turnsFromRows;
  handle.dir = dir;
  return handle;
}

export default createChatRoutes;
