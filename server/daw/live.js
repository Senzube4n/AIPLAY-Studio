/**
 * DAW — live document sync (the UI stage's one server-side addition).
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, beside the existing WebSocketServer:    │
 * │                                                                        │
 * │   import { createDawLive } from "./daw/live.js";                       │
 * │   const dawLive = createDawLive({                                      │
 * │     dir: path.join(config.outputDir, "daw"),                           │
 * │     broadcast: (msg) => { for (const c of wss.clients)                 │
 * │                            if (c.readyState === 1) c.send(msg); },     │
 * │   });                                                                  │
 * │   dawLive.start();                                                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS EXISTS. §13a of the DAW report: "AI edits are visibly live". The
 * DAW's write surface is one action-dispatched POST that both hands call —
 * the human page and the MCP tools — so the moment an agent adds a note, the
 * open page should show it without a refresh. This module is the push half.
 *
 * WHY IT WATCHES THE DOCUMENT AND NOT THE ROUTE. A callback fired inside
 * routes.js would only see mutations that went through THIS process's
 * dispatcher, and would have to be re-hooked for every action added later.
 * The document is the actual shared state: store.js writes
 * <output>/daw/<slug>/project.json atomically (tmp + rename), so ONE watch
 * catches every writer that exists or ever will — this server, a second
 * server, a repair script, a human with an editor. It also cannot drift out
 * of date when a new action lands, because it does not know about actions.
 *
 * WHAT IT PUSHES. The document's own revision (`updatedAt`) plus the newest
 * ledger entry — `by: "agent" | "user"`, the action name and its detail —
 * so the client can (a) skip frames for a revision it already holds and
 * (b) say WHO changed what. Nothing else: the page re-reads the project
 * through the normal GET, so there is one shape of the truth on the wire.
 *
 * IT IS PURELY ADDITIVE. It imports nothing from the DAW engine, mutates
 * nothing, and if the watch cannot start the DAW keeps working exactly as
 * it did before — the page simply falls back to seeing changes when it next
 * re-reads. `server/daw/ui_test.js` pins the frame shape and the debounce.
 */
import { watch } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** How long to wait after a write before reading: store.js renames a tmp
 *  file into place, so a rename event can arrive a hair before the metadata
 *  settles, and a burst of actions should produce one frame, not five. */
export const DEBOUNCE_MS = 45;

/** Turn a watch path into a project slug, or null if it is not a document.
 *  Region renders, take files and click beds all live under the same tree
 *  and must NOT wake the page — only the document is the shared state. */
export function slugOfEvent(filename) {
  if (!filename) return null;
  const parts = String(filename).split(/[\\/]/);
  if (parts.length !== 2) return null;                 // <slug>/project.json
  if (parts[1] !== "project.json") return null;        // .tmp-1234 included
  const slug = parts[0];
  if (!slug || slug.startsWith(".") || !/^[a-z0-9._-]+$/i.test(slug)) return null;
  return slug;
}

/** The wire frame for one document revision. Exported so the test can pin
 *  the field names the client binds to without starting a server. */
export function frameFor(slug, doc) {
  const top = Array.isArray(doc?.ledger) ? doc.ledger[0] : null;
  return {
    type: "daw",
    slug,
    name: doc?.name ?? slug,
    updatedAt: doc?.updatedAt ?? null,
    by: top?.by === "agent" ? "agent" : "user",
    action: top?.action ?? "write",
    detail: top?.detail ?? "",
    at: top?.at ?? Date.now(),
  };
}

export function createDawLive({ dir, broadcast, log = () => {} }) {
  let watcher = null;
  const timers = new Map();
  const lastSent = new Map();

  async function emit(slug) {
    let doc = null;
    try {
      doc = JSON.parse(await readFile(path.join(dir, slug, "project.json"), "utf8"));
    } catch {
      return;                     // mid-rename or deleted: the next event wins
    }
    const frame = frameFor(slug, doc);
    // One frame per revision. A render writes region files, not the document,
    // so this is already quiet; the guard covers a double fs event.
    if (lastSent.get(slug) === frame.updatedAt) return;
    lastSent.set(slug, frame.updatedAt);
    try { broadcast(JSON.stringify(frame)); } catch { /* a dead socket is not our problem */ }
  }

  function touch(slug) {
    clearTimeout(timers.get(slug));
    timers.set(slug, setTimeout(() => { timers.delete(slug); emit(slug); }, DEBOUNCE_MS));
  }

  return {
    /** Idempotent; safe to call before the directory exists. */
    async start() {
      if (watcher) return true;
      try {
        await mkdir(dir, { recursive: true });
        watcher = watch(dir, { recursive: true }, (_ev, filename) => {
          const slug = slugOfEvent(filename);
          if (slug) touch(slug);
        });
        watcher.on("error", (err) => {
          log(`daw live sync stopped: ${err.message}`);
          watcher = null;
        });
        return true;
      } catch (err) {
        // Recursive watch is unavailable on some filesystems. The DAW works
        // without it; only the follow-the-agent animation is lost, and the
        // page says so (its status dot never turns green on this path).
        log(`daw live sync unavailable (${err.message}) — the DAW still works, `
          + "the page just will not follow an agent's edits until it re-reads.");
        return false;
      }
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      try { watcher?.close(); } catch { /* already gone */ }
      watcher = null;
    },
    /** Test seam: push a document straight through the frame builder. */
    _emit: emit,
    _frame: frameFor,
  };
}
