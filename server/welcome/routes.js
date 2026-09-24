/**
 * WELCOME — HTTP routes, mounted at /api/welcome.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else:                          │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createWelcomeRoutes } from "./welcome/routes.js";         │
 * │                                                                        │
 * │  2. beside the other runners:                                          │
 * │     const welcomeRoutes = createWelcomeRoutes({ json, readBody });     │
 * │                                                                        │
 * │  3. first thing inside the request handler's `try`:                    │
 * │     if (p === "/api/welcome" || p.startsWith("/api/welcome/")) {       │
 * │       if (await welcomeRoutes(req, res, url)) return; }                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * SEVEN ACTIONS, and every one of them is there by the parity rule:
 *
 *   catalogue    what this studio is and can do (server/welcome/catalogue.js)
 *   screen_info  ONE screen: its paragraph, its limit, its first move, and what
 *                it needs — joined against what this machine actually has
 *   showcase     what it has actually made, off this disk (showcase.js)
 *   dismiss      remember that this person has seen the first-run lines
 *   reopen       forget that, so Home shows them again
 *   first_run    the three lines Home shows on a new install (firstrun.js),
 *                in place of the tour that used to open by itself (UI_PLAN B5)
 *   level        read, or with `level`, save, whether the make screens open
 *                Simple or Advanced (level.js, UI_PLAN E1)
 *
 * Every one of them is posted by web/welcome.js or web/level.js AND by a tool in
 * server/mcp-welcome.js. There is no read an agent can do that a person
 * cannot, and — the direction that actually finds bugs — no switch an agent can
 * flip that a person cannot. `reopen` exists as an ACTION rather than as a
 * checkbox in the window for exactly that reason: "show me that tour again" is
 * a thing you say to an assistant at least as often as you click it.
 *
 * THE FLAG LIVES IN settings.json, the store the app already uses, as a
 * top-level `welcome` key beside `rig` and `api`. NOT in config.js's PREF_PATHS
 * allow-list, and that is deliberate twice over: this is not a preference that
 * config.js needs at boot (nothing server-side branches on it), and PREF_PATHS
 * carries measured constants that a stale file must never be able to reach.
 * Read-modify-write, the same shape /api/settings and the API-mode route use.
 *
 * ⚠ browser storage was the other option and it is the wrong one. localStorage
 * is per-browser: the flag would come back on a second browser, vanish in a
 * private window, and — the part that matters here — be invisible to MCP, so an
 * agent could not answer "has this person been shown around yet" or act on the
 * answer. A flag only one of the two hands can see is exactly the UI-only state
 * this repo's binding rule forbids.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { catalogue, WELCOME_VERSION, TABS, screenFor, resolveNeeds, needState, NEED_STATES, NEED_WORDS } from "./catalogue.js";
import { showcase } from "./showcase.js";
import { firstRunLines } from "./firstrun.js";
import { levelState, saveLevel } from "./level.js";

/* ── where "will it run here" comes from ───────────────────────────────────
 *
 * IT IS A REQUEST TO THIS SAME SERVER, NOT A SECOND IMPLEMENTATION, and that
 * is the whole point. /api/models is where the fit is computed: it reads the
 * card once with readMachine(), divides it against every capability's
 * `requires` with fitFor(), probes the python interpreters, and sends the four
 * verdict words along with the answer so nothing downstream invents a fifth.
 * Every one of those inputs — the ModelManager, the GPU poller, the package
 * probe and its 30-second cache — lives in server/index.js's closure and is
 * reachable from here by exactly one door: the door the Models screen uses.
 *
 * So this panel asks the same question the same way and gets the same bytes. A
 * screen that says "fits your machine" while the Models screen says "below the
 * minimum" is the single worst thing this feature could do, and the only sure
 * way to prevent it is to have no second opinion to disagree with.
 *
 * server/videolab/routes.js answers itself the same way for the same reason.
 * The alternative was a probe function injected at construction, which would
 * have meant editing index.js — and would still have left the fit arithmetic
 * looking for a machine reading this module has no way to take.
 */
const modelsUrl = () => `http://127.0.0.1:${config.uiPort}/api/models`;

/* Five seconds. Long enough that opening three info panels in a row does not
 * re-run the python probe (which spawns interpreters), short enough that a
 * download finishing while a panel is open is reflected the next time it is. */
let modelsCache = null;
async function liveModels() {
  if (modelsCache && Date.now() - modelsCache.at < 5000) return modelsCache.value;
  try {
    const r = await fetch(modelsUrl());
    const value = await r.json();
    if (!value || !Array.isArray(value.capabilities)) throw new Error("no capabilities in /api/models");
    modelsCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    /* NOT an error for the caller. The prose half of this answer is worth
     * having on its own, and a panel that refuses to open because the model
     * catalogue was slow is worse than a panel that opens and says it could not
     * read the machine. `unavailable` is what the UI and the tool both key on
     * so neither of them guesses. */
    return { unavailable: err?.message || String(err), capabilities: [], python: null };
  }
}

/**
 * The needs of one screen, joined against what this machine has.
 *
 * The left half comes from the catalogue (identities, one clause saying what
 * each is FOR, and the line a person types); the right half comes from
 * /api/models (label, size, licence, on-disk, fit). Nothing is composed here
 * that either side already knows — including the readiness word, which is
 * catalogue.js's `needState`, and the pip command, which arrives on the need.
 *
 * NOTHING IS DECIDED HERE ANY MORE, and both halves of that are repairs. The
 * state ladder was written inline in this function and consulted `packageReady`
 * only for a package-managed capability, so weights-on-disk-and-no-package was
 * badged green; it is now one exported function next to the vocabulary it picks
 * from, walked branch by branch by catalogue_test.js. And the install command
 * was found by scanning /api/models for the first capability declaring the same
 * module name, which is not what "owns" means: the compositor's `av` row was
 * handed the audio reference's `pip install numpy torch av`.
 */
function joinNeeds(tab, live) {
  const caps = new Map((live.capabilities || []).map((c) => [c.id, c]));
  const packages = live.python?.packages || null;
  const probedBy = live.python?.probed || {};

  return resolveNeeds(tab).map((n) => {
    if (n.kind === "package") {
      const known = packages && Object.prototype.hasOwnProperty.call(packages, n.id);
      const state = !known ? "unknown" : (packages[n.id] ? "installed" : "absent");
      return {
        ...n,
        label: n.id,
        state,
        status: NEED_STATES[state],
        /* `install` and `unlocks` ride in on the need itself — from the
         * capability that expanded into this row, or from the `pkg()` beside
         * the prose for a package a screen imports on its own account. Either
         * way it is a pip install and never a download, and that distinction is
         * the entire content of the message: Studio can fetch weights and
         * cannot fetch this, and a screen that offers a button for it is lying. */
        interpreter: probedBy[n.id] || live.python?.path || null,
        interpreterLine: (probedBy[n.id] || live.python?.path) ? NEED_WORDS.probedIn(probedBy[n.id] || live.python?.path) : null,
        fit: null,
      };
    }

    const cap = caps.get(n.capability) || null;
    const missingBytes = cap ? Math.max(0, (cap.totalBytes || 0) - (cap.haveBytes || 0)) : null;
    /* One line, and the ladder behind it is in catalogue.js beside the words it
     * chooses from — including the `managedByPackage` branch this comment used
     * to explain, which is still first for the same reason it always was. */
    const state = needState(cap);
    return {
      ...n,
      label: cap?.label ?? n.capability ?? n.id,
      required: !!cap?.required,
      /* The Models screen's own answer for a music row before an engine is
       * ready ("one music engine required"), carried so this panel and that
       * screen cannot disagree about the same row (models.js markRequired). */
      requiredGroup: cap?.requiredGroup ?? null,
      licence: cap?.licence ?? null,
      home: cap?.home ?? null,
      /* Carried whole, never summarised — the two that can cost somebody
       * something. The panel renders them; it does not paraphrase them. */
      region: cap?.region ?? null,
      gated: cap?.gated ?? null,
      totalBytes: cap?.totalBytes ?? null,
      missingBytes,
      state,
      status: NEED_STATES[state],
      /* Straight off /api/models. Same object web/modelfit.js badges on the
       * Models screen, same four words, same reason string. */
      fit: cap?.fit ?? null,
      packageReady: cap?.packageReady ?? null,
    };
  });
}

/**
 * One screen, everything about it. The object the panel renders and the object
 * `studio_screen_info` returns — the same bytes, as everywhere else here.
 */
async function screenInfo(view) {
  const tab = screenFor(view);
  if (!tab) return null;
  const live = await liveModels();
  const needs = joinNeeds(tab, live);
  return {
    view: tab.id,
    name: tab.name,
    icon: tab.icon,
    group: tab.group,
    /* The four prose parts, verbatim from the catalogue. */
    lead: tab.lead,
    makes: tab.makes,
    cant: tab.cant,
    first: tab.start,
    /* Where to go to use it. The DAW owns a page; everything else is a view in
     * the one document, which is the same split web/welcome.js's cards make. */
    open: tab.id === "daw"
      ? { kind: "page", href: "daw.html", label: `Open ${tab.name}` }
      : { kind: "view", view: tab.id, label: `Open ${tab.name}` },
    needs,
    needsNote: tab.needsNote ?? null,
    /* How the screen's engines run (catalogue.js howItRuns): the internals
     * that used to sit under the Make button. */
    howItRuns: tab.howItRuns ?? null,
    /* BIT-TRANSPARENT. A screen with nothing to fetch says so out loud rather
     * than showing an empty box, and it is not the panel that decides — the
     * sentence is here so the window and the tool say the same one. */
    needsNothing: needs.length === 0 && !tab.needsNote,
    needsLine: needs.length === 0 && !tab.needsNote
      ? "Needs nothing beyond the app. No model, no download, no Python package."
      : null,
    /* Where the fit came from, quoted back so no sentence on the panel is
     * traceable to a reading nobody can see. */
    machine: live.machine ?? null,
    fitStates: live.fitStates ?? null,
    needStates: NEED_STATES,
    modelsView: "models",
    /* Said, not swallowed — and the sentence travels with it. The panel used to
     * reach into `needStates.unknown` for this line, which meant the page knew
     * a state's name; the vocabulary is this side's to own, and every list of
     * state names the page kept has since gone stale at least once. */
    machineUnavailable: live.unavailable ?? null,
    machineUnavailableLine: live.unavailable ? NEED_STATES.unknown.line : null,
  };
}

/* One path segment, no separators, no traversal, no surprises. Same posture as
 * every other file-serving route in this app: a client that could name a path
 * could name any file on the disk, and this server answers to a browser tab and
 * to an agent. */
const safeSeg = (s) => {
  const v = String(s || "");
  return /^[\w.-]{1,120}$/.test(v) && !v.includes("..") ? v : null;
};

async function readSettings() {
  try { return JSON.parse(await readFile(config.settingsFile, "utf-8")) || {}; }
  catch { return {}; }
}

async function writeWelcomeFlag(patch) {
  const cur = await readSettings();
  const next = { ...cur, welcome: { ...(cur.welcome || {}), ...patch } };
  await mkdir(path.dirname(config.settingsFile), { recursive: true });
  await writeFile(config.settingsFile, JSON.stringify(next, null, 2));
  return next.welcome;
}

/**
 * Has this install been shown around, and for which version of the catalogue?
 *
 * `firstRun` is true when the stored version does not match the current one, so
 * a genuinely new capability can re-open the window once — see WELCOME_VERSION,
 * which is documented as not-a-build-number for the obvious reason.
 */
async function state() {
  const w = (await readSettings()).welcome || {};
  return {
    version: WELCOME_VERSION,
    seenVersion: w.seenVersion ?? null,
    seenAt: w.seenAt ?? null,
    firstRun: w.seenVersion !== WELCOME_VERSION,
  };
}

export function createWelcomeRoutes({ json, readBody, sameOriginLocalJson = null }) {
  return async function welcomeRoutes(req, res, url) {
    const p = url.pathname;

    /* A DAW bounce, streamed. The DAW's own /api/daw/audio/ serves the
     * content-addressed region cache and nothing else, so a finished bounce has
     * no url anywhere in the app — which would have left the showcase able to
     * NAME an arrangement and not play it. Serving it from here keeps the DAW's
     * routes untouched while another hand is in them. */
    if (p.startsWith("/api/welcome/bounce/") && req.method === "GET") {
      const parts = p.slice("/api/welcome/bounce/".length).split("/");
      const slug = safeSeg(decodeURIComponent(parts[0] || ""));
      const name = safeSeg(decodeURIComponent(parts[1] || ""));
      if (!slug || !name || !/\.(flac|wav)$/i.test(name)) {
        json(res, 400, { error: "bad bounce path" }); return true;
      }
      const full = path.join(config.outputDir, "daw", slug, "bounces", name);
      try {
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": name.toLowerCase().endsWith(".flac") ? "audio/flac" : "audio/wav",
          "Content-Length": st.size,
          "Cache-Control": "max-age=3600",
        });
        createReadStream(full).pipe(res);
      } catch {
        json(res, 404, { error: "No such bounce." });
      }
      return true;
    }

    /* The whole document plus the flag, in one GET. Convenience for curl and
     * for an agent that would rather not POST to read something — it has no
     * side effects and returns exactly what the `catalogue` action returns. */
    if (p === "/api/welcome" && req.method === "GET") {
      const withShowcase = url.searchParams.get("showcase") !== "0";
      json(res, 200, {
        ok: true,
        ...(await state()),
        catalogue: catalogue({ showcase: withShowcase ? await showcase() : null }),
      });
      return true;
    }

    if (p === "/api/welcome" && req.method === "POST") {
      let b = {};
      /* Capped while reading: every body this door takes is a few words. */
      try { b = await readBody(req, 64 * 1024); } catch { b = {}; }
      try {
        switch (String(b.action || "")) {
          /* What this studio is and can do. The window's whole render, and the
           * answer `studio_capabilities` gives an agent — one document, and the
           * only way to keep those two from drifting. */
          case "catalogue": {
            const want = b.showcase !== false;
            json(res, 200, {
              ok: true,
              ...(await state()),
              catalogue: catalogue({ showcase: want ? await showcase() : null }),
            });
            return true;
          }

          /* ONE screen, in the depth somebody standing on it wants.
           *
           * `catalogue` is the tour: sixteen paragraphs, read once. This is the
           * ⓘ in the corner of the page you are already on — the same paragraph,
           * plus the part the tour cannot carry, which is what THIS machine has
           * and has not got for THIS screen. Two actions rather than one field
           * on the first, because the second one reads the disk, the card and
           * the python interpreters and the tour must stay free. */
          case "screen_info": {
            const info = await screenInfo(b.view);
            if (!info) {
              json(res, 400, {
                error: `Unknown screen "${String(b.view ?? "")}". `
                     + `Try: ${TABS.map((t) => t.id).join(", ")}.`,
                screens: TABS.map((t) => t.id),
              });
              return true;
            }
            json(res, 200, { ok: true, ...info });
            return true;
          }

          /* Just the real outputs, so the window's Refresh button and an
           * agent's "what has this machine made" cost one disk read rather than
           * rebuilding the prose too. */
          case "showcase": {
            json(res, 200, { ok: true, showcase: await showcase() });
            return true;
          }

          /* Seen it. Since UI_PLAN B5 the tour no longer opens by itself: a new
           * install gets three lines on Home instead, and their Hide posts
           * this. Once written, Home stops showing them. */
          case "dismiss": {
            const w = await writeWelcomeFlag({
              seenVersion: WELCOME_VERSION,
              seenAt: new Date().toISOString(),
            });
            json(res, 200, { ok: true, welcome: w, ...(await state()) });
            return true;
          }

          /* Forget it, so Home shows the first-run lines again. The tour's own
           * button and an agent's `studio_welcome` both land here. */
          case "reopen": {
            const w = await writeWelcomeFlag({ seenVersion: null, seenAt: null });
            json(res, 200, {
              ok: true, welcome: w, ...(await state()),
              note: "Home will show the first-run lines again the next time this page is loaded.",
            });
            return true;
          }

          /* The three lines for Home. They need the machine, so they cost the
           * same /api/models round trip screen_info does; the tour stays free. */
          case "first_run": {
            json(res, 200, { ok: true, ...(await state()), ...firstRunLines(await liveModels()) });
            return true;
          }

          /* Simple or Advanced. Without `level` it reads; with it, it saves the
           * person's choice. Saving changes how every make screen opens, so it
           * answers only Studio's own page or a local MCP client, the same
           * guard the doors that choose what runs use (index.js). */
          case "level": {
            if (b.level === undefined || b.level === null) {
              json(res, 200, { ok: true, ...levelState() });
              return true;
            }
            /* Fails CLOSED: routes built without the guard cannot save at all. */
            if (typeof sameOriginLocalJson !== "function" || !sameOriginLocalJson(req)) {
              json(res, 403, { error: "The level is changed from Studio's own page or a local MCP client." });
              return true;
            }
            /* 400 for a level that does not exist; 409 when settings.json is
             * there and unreadable, which level.js refuses to write over. */
            try { json(res, 200, { ok: true, ...(await saveLevel(String(b.level))) }); }
            catch (err) { json(res, err?.status || 400, { ...levelState(), error: err?.message || String(err) }); }
            return true;
          }

          default:
            json(res, 400, {
              error: "Unknown action. Try: catalogue, screen_info, showcase, dismiss, reopen, first_run, level.",
            });
            return true;
        }
      } catch (err) {
        json(res, 500, { error: err?.message || String(err) });
        return true;
      }
    }

    /* Anything else under this prefix falls through to the app's own 404 — the
     * same bargain vfx and daw make, so an unknown path is still an honest
     * error rather than a silent 200. */
    return false;
  };
}

export { state as welcomeState };
