/**
 * The Engine panel — the door to the GPU, seen from the front.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE BINDING PRINCIPLE (web/daw.js states it; server/engine/ui_test.js
 * enforces it): everything MCP-controllable AND completely human-adjustable,
 * ONE document behind both. Every gesture in this file posts one of the SAME
 * /api/engine actions server/mcp-engine.js posts. There is no second write
 * path, not one local-only field, and not one control whose value lives in
 * this file. When you want one, you have found a missing action.
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ─────────────────────────────────────────
 *
 * On 2026-09-02 the output folder held 426 files written since the previous
 * noon and 424 of them had no ledger entry of any kind — 85 of those in the
 * very folder the clip library lists, so the app was already SHOWING files it
 * could say nothing whatsoever about. Not the model, not the prompt, not the
 * seed, not the size, not who asked. They had been posted straight at
 * ComfyUI's own port by scripts with a number baked into them.
 *
 * The engine no longer has a number to bake in. What this screen does is make
 * the consequence visible rather than merely true: the activity list is the
 * whole record, the exposure badge says how findable the engine is right now,
 * and the Reveal control hands the number back to anyone who really needs it
 * — while writing down that it did.
 *
 * ── WHY A SEPARATE MODULE AND NOT PART OF app.js ──────────────────────────
 *
 * Other strands are editing that file. This one is additive by construction:
 * one <script> tag, it reaches its own <div id="engine"> through the DOM, it
 * posts its own route, and deleting it leaves no hole anywhere. The cost is
 * that it cannot see app.js's `state` — which does not matter, because
 * everything it needs is on the server.
 *
 * ⚠ addEventListener, never `onclick =`. app.js owns those properties on the
 * rail links; assigning one would silently delete its handler and take the
 * whole navigation down with it.
 */
import { appConfirm, appPrompt } from "./dialog.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtSecs = (s) => (s == null ? "—" : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} m ${String(Math.round(s % 60)).padStart(2, "0")} s`);
const fmtBytes = (b) => {
  if (!Number.isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};
const fmtWhen = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—"
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const post = async (body) => {
  const r = await (await fetch("/api/engine", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  if (r.error) throw new Error(r.error);
  return r;
};

/** What the server said last, so a repaint costs no round trip. */
let STATUS = null;
let RUNS = [];
let UNREC = [];
let openRun = null;

const show = (el, html) => { el.hidden = false; el.innerHTML = html; };
const fail = (el, e) => show(el, `<b>That did not work.</b><p class="eng-prob">${esc(e.message || e)}</p>`);

/* ── this engine ──────────────────────────────────────────────────────────── */

/**
 * The exposure sentence, which is the one fact this screen exists to state.
 *
 * Written per state rather than as a template with a hole in it, because the
 * three states do not mean the same thing with a different word: ephemeral is
 * a property of the app, pinned is a decision somebody made and its price, and
 * revealed is a dated event in the ledger.
 */
const EXPOSURE = {
  ephemeral: "Hidden port: nothing can render without being recorded here.",
  pinned: "AIPLAY_COMFY_PORT is set, so other programs can render here without being recorded.",
  revealed: "The port was revealed this session (logged). Renders sent straight to it are not recorded.",
};

async function loadStatus() {
  STATUS = await post({ action: "status" });
  paintStatus();
}

function paintStatus() {
  const s = STATUS;
  if (!s) return;
  const mode = s.mode || "ephemeral";
  $("engHead").textContent = s.ready
    ? `running${s.version ? ` · ComfyUI ${s.version}` : ""}`
    : s.ours ? "starting" : "not running";
  $("engHead").className = `chip ${s.ready ? "ok" : s.ours ? "busy" : "err"}`;

  /* The pinned strip, and ONLY in pinned mode. It is not a scolding: an
   * install that pinned the port did so because of a real collision. It says
   * what that costs, which is the half nobody was told before. */
  const warn = $("engPinned");
  warn.hidden = mode !== "pinned";
  if (mode === "pinned") {
    warn.innerHTML = `<b>Pinned to a published port (${esc(String(s.port))}).</b>`
      + `${esc(EXPOSURE.pinned)} Unset it to hide the port again.`;
  }

  /* One tile per fact: a label and a value. The explanation is the tile's
   * tooltip, not a paragraph under it. */
  const fact = (k, v, why) => `<div class="eng-fact"${why ? ` title="${esc(why)}"` : ""}><span class="k">${esc(k)}${why ? " ⓘ" : ""}</span>`
    + `<span class="v">${v}</span></div>`;

  const q = s.queue ? `${s.queue.running} running, ${s.queue.pending} waiting` : "—";
  const backend = s.backend
    ? (s.backend.cudaFused === false
      ? "NOT the fused CUDA build"
      : s.backend.cudaFused === true ? "fused CUDA" : "unknown")
    : "—";
  $("engStatus").innerHTML = [
    fact("exposure", `<span class="eng-badge ${esc(mode)}">${esc(mode)}</span>`
      + (s.port ? ` <span class="v">${esc(String(s.port))}</span>` : ""), EXPOSURE[mode]),
    fact("engine", s.ready ? "ready" : s.ours ? "starting" : "not running",
      s.ours ? null : "This app's own ComfyUI is not running, so nothing will be sent to it."),
    fact("queue", esc(q), s.running?.length
      ? s.running.map((r) => `${r.via}: ${fmtSecs(r.elapsedSec)}`).join(", ") : null),
    fact("memory tier", esc(String(s.tier ?? "—")), null),
    fact("backend", esc(backend),
      s.backend?.cudaFused === false ? "A non-fused torch build costs roughly 5x and everything still appears to work." : null),
    fact("uptime", s.uptimeSec == null ? "—" : fmtSecs(s.uptimeSec), null),
    fact("runs recorded", esc(String(s.ledgerEntries ?? "—")),
      "Two events per run: the request, then the result."),
    fact("stored graphs", `${s.graphStore?.count ?? 0} · ${fmtBytes(s.graphStore?.bytes ?? 0)}`,
      "Every graph ever run, kept so any run can be repeated exactly."),
  ].join("");

  $("engHash").checked = s.hashModels === true;
  $("engReveal").disabled = mode !== "ephemeral";
  if (mode !== "ephemeral") {
    $("engRevealNote").textContent = mode === "pinned"
      ? "Already published (see above)."
      : `Revealed this session: ${s.port}. The ledger has the line.`;
  }
}

/* ── activity ─────────────────────────────────────────────────────────────── */

const activityFilters = () => ({
  limit: Number($("engFLimit").value) || 50,
  actor: $("engFActor").value.trim() || undefined,
  since: $("engFSince").value.trim() || undefined,
  project: $("engFProject").value.trim() || undefined,
  status: $("engFStatus").value || undefined,
  via: $("engFVia").value.trim() || undefined,
});

async function loadRuns() {
  const f = activityFilters();
  const r = await post({
    action: "activity",
    limit: f.limit, actor: f.actor, since: f.since,
    project: f.project, status: f.status, via: f.via,
  });
  RUNS = r.runs || [];
  paintRuns(r.total);
}

function paintRuns(total) {
  const host = $("engRuns");
  if (!RUNS.length) {
    /* THE EMPTY STATE IS A CLAIM, and it is worth spelling out. Because the
     * door is the only way in, an empty list means nothing rendered — not that
     * something rendered unrecorded, which is what an empty list meant before
     * this subsystem existed. */
    host.innerHTML = '<p class="eng-empty">Nothing has rendered yet.</p>';
    return;
  }
  host.innerHTML = RUNS.map((r) => {
    const bad = r.status && r.status !== "completed" && r.status !== "running";
    const size = r.width && r.height ? `${r.width}×${r.height}` : "";
    const what = [r.label, r.model, size].filter(Boolean).join(" · ") || r.runId;
    return `<div class="eng-run${openRun === r.runId ? " on" : ""}" data-run="${esc(r.runId)}">`
      + `<span class="t">${esc(fmtWhen(r.t))}</span>`
      + `<span class="who">${esc(r.actor || "")}</span>`
      + `<span class="what" title="${esc(what)}">${esc(what)}</span>`
      + `<span class="num">${r.cached ? "cached" : fmtSecs(r.elapsedSec)}</span>`
      + `<span class="st${bad ? " bad" : ""}${r.status === "running" ? " run" : ""}">${esc(r.status || "")}</span>`
      + "</div>";
  }).join("")
    + (total > RUNS.length ? `<p class="eng-empty">${total - RUNS.length} more — raise the row count.</p>` : "");
}

/**
 * One run's whole record, with the graph.
 *
 * The graph is asked for every time rather than behind a second click: it is
 * the field that makes a render REPRODUCIBLE rather than merely described, and
 * a person who opened a run is asking exactly that question.
 */
async function openDetail(runId) {
  openRun = runId;
  paintRuns(RUNS.length);
  const host = $("engDetail");
  try {
    const r = await post({ action: "run", runId, graph: true });
    /* `request` and `result`, exactly as server/engine/client.js's runRecord()
     * names them. Spelled `requested` here once, and the panel then showed a
     * run with no prompt, no model and no seed while looking perfectly healthy
     * — which is the failure mode this whole subsystem exists to make loud, so
     * it is worth a line: a reader with the wrong key gets silence, not an
     * error. */
    const q = r.request || {};
    const res = r.result || {};
    const row = (k, v) => (v == null || v === "" ? "" : `<span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span>`);
    const files = (list) => (list || []).map((f) => `${f.file}${f.bytes ? ` (${fmtBytes(f.bytes)})` : ""}${f.sha256 ? ` ${f.sha256.slice(0, 19)}…` : ""}`).join("\n");
    show(host, `<div class="eng-kv">`
      + row("run", r.runId)
      + row("asked by", q.actor_echo || "")
      + row("via", q.via)
      + row("status", res.status)
      + row("error", res.error)
      + row("elapsed", res.elapsedSec == null ? "" : fmtSecs(res.elapsedSec))
      + row("queued", res.queuedSec == null ? "" : fmtSecs(res.queuedSec))
      + row("served from cache", res.cached === true ? "yes" : "")
      + row("model", q.model)
      + row("prompt", q.prompt)
      + row("negative", q.negative)
      + row("prompt resolved", q.promptResolved === false ? "no — the graph's wiring is not walkable, so texts[] is kept instead" : "")
      + row("seed", q.seed) + row("steps", q.steps) + row("cfg", q.cfg)
      + row("size", q.width && q.height ? `${q.width}×${q.height}` : "")
      + row("frames", q.frames) + row("fps", q.fps) + row("seconds", q.seconds)
      + row("project", q.project) + row("shot", q.shot)
      + row("graph", `${q.graphHash || ""} — ${q.graphNodes ?? "?"} nodes`)
      + row("model files", files(q.engineFiles))
      + row("loras", (q.loras || []).map((l) => `${l.file} @ ${l.strength_model}`).join("\n"))
      + row("references", files(q.references))
      + row("wrote", (res.outputs || []).map((o) => `${o.subfolder ? `${o.subfolder}/` : ""}${o.file}${o.adoptedAs ? ` → ${o.adoptedAs}` : ""} ${fmtBytes(o.bytes)}`).join("\n"))
      + "</div>"
      + (r.graph ? `<details><summary>the graph itself</summary><pre>${esc(JSON.stringify(r.graph, null, 1))}</pre></details>` : ""));
  } catch (e) { fail(host, e); }
}

/* ── running a graph ──────────────────────────────────────────────────────── */

/**
 * The body the Run and Dry-run buttons post.
 *
 * `pollMs` is a cadence, not a preference: three seconds of pure waiting is
 * nothing on a half-hour pass and most of the wall time on a three-second
 * image, which is why the door lets its caller choose rather than holding one
 * number for every graph this machine can run.
 */
function graphBody(dry) {
  let graph;
  try { graph = JSON.parse($("engGraph").value); }
  catch { throw new Error("That is not JSON. Paste the file ComfyUI writes with Save (API Format)."); }
  return {
    action: "prompt",
    graph,
    wait: $("engWait").checked,
    adopt: $("engAdopt").checked,
    label: $("engLabel").value.trim() || null,
    note: $("engNote").value.trim() || null,
    project: $("engProject").value.trim() || null,
    shot: $("engShot").value.trim() || null,
    timeoutMs: Math.max(1, Number($("engTimeout").value) || 30) * 60000,
    pollMs: Math.round(Math.max(0.1, Number($("engPoll").value) || 3) * 1000),
    dry_run: dry,
  };
}

async function runGraph(dry) {
  const host = $("engRunOut");
  show(host, dry ? "Reading the graph…" : "Recording the request, then submitting…");
  try {
    const r = await post(graphBody(dry));
    if (r.dry_run) {
      const rec = r.record || {};
      show(host, "<b>Nothing was spent.</b> This is the record that would be written:"
        + `<pre>${esc(JSON.stringify(rec, null, 1))}</pre>`
        + (r.problems?.length ? `<ul class="eng-prob">${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""));
      return;
    }
    show(host, `<b>${esc(r.status)}</b> — ${esc(r.runId)}${r.elapsedSec ? `, ${fmtSecs(r.elapsedSec)}` : ""}`
      + (r.error ? `<p class="eng-prob">${esc(r.error)}</p>` : "")
      + ((r.outputs || []).length
        ? `<pre>${esc(r.outputs.map((o) => `${o.file}${o.adoptedAs ? ` → ${o.adoptedAs}` : ""}  ${o.sha256 || ""}`).join("\n"))}</pre>`
        : ""));
    await loadRuns();
  } catch (e) { fail(host, e); }
}

/* ── the files nothing knows about ────────────────────────────────────────── */

async function scanUnrecorded() {
  const host = $("engUnrec");
  host.innerHTML = "Scanning the output folder…";
  try {
    const r = await post({
      action: "list_unrecorded",
      limit: Number($("engULimit").value) || 200,
      prefix: $("engUPrefix").value.trim() || null,
    });
    UNREC = r.files || [];
    host.innerHTML = UNREC.length
      ? `<p class="eng-empty">${r.total} file${r.total === 1 ? "" : "s"} in ${esc(r.scanned)} with no record.</p>`
        + UNREC.map((f) => `<label><input type="checkbox" class="eng-u" value="${esc(f.path)}">`
          + `<span>${esc(f.path)}</span><span class="b">${fmtBytes(f.bytes)}</span>`
          + `<span class="d">${esc(fmtWhen(f.mtimeMs))}</span></label>`).join("")
      : '<p class="eng-empty">Every file in the output folder is accounted for.</p>';
  } catch (e) { host.innerHTML = `<p class="eng-empty">${esc(e.message)}</p>`; }
}

const checkedUnrecorded = () => [...document.querySelectorAll(".eng-u")].filter((c) => c.checked).map((c) => c.value);

async function adoptUnrecorded(dry) {
  const host = $("engUOut");
  const all = $("engUAll").checked;
  const files = checkedUnrecorded();
  if (!all && !files.length) {
    show(host, "Tick the files first, or tick “every file the scan can see”.");
    return;
  }
  show(host, dry ? "Building the events…" : "Appending…");
  try {
    const r = await post({ action: "adopt_unrecorded", files, all, dry_run: dry });
    show(host, `<b>${r.dry_run ? "Nothing was written." : `${r.adopted} adopted.`}</b>`
      + `<pre>${esc((r.events || []).slice(0, 60).map((e) => `${e.ok ? "ok  " : "FAIL"} ${e.file}${e.error ? ` — ${e.error}` : ""}`).join("\n"))}</pre>`
      + (r.dry_run ? "" : "<p class=\"eng-prob\">Each one is an <code>edit</code> event whose origin is "
        + "<code>unrecorded</code>, which folds to the class <b>composite</b>: parts may be "
        + "AI-generated, origin partially unrecorded. It claims nothing more than that.</p>"));
    if (!dry) await scanUnrecorded();
  } catch (e) { fail(host, e); }
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

function wire() {
  if (!$("engRuns")) return;   // not this page (the DAW loads its own modules)

  $("engRefresh").addEventListener("click", () => { loadStatus().catch(() => {}); loadRuns().catch(() => {}); });

  $("engWho").addEventListener("click", async () => {
    const host = $("engIdentity");
    show(host, "Asking the engine what it is…");
    try {
      const r = await post({ action: "identity" });
      show(host, `<div class="eng-kv">`
        + `<span class="k">version</span><span class="v">${esc(r.version ?? "—")}</span>`
        + `<span class="k">main.py</span><span class="v">${esc(r.mainPy ?? "—")}</span>`
        + `<span class="k">reads inputs from</span><span class="v">${esc(r.inputDirectory ?? "—")}</span>`
        + `<span class="k">writes outputs to</span><span class="v">${esc(r.outputDirectory ?? "—")}</span>`
        + `<span class="k">is this Studio's</span><span class="v">${r.matchesThisStudio ? "yes" : "not proven"}</span>`
        + "</div>"
        + (r.problems?.length
          ? `<ul class="eng-prob">${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
          : "<p class=\"eng-prob\">A port is not an identity — this is read from the engine's own launch arguments.</p>"));
    } catch (e) { fail(host, e); }
  });

  $("engInterrupt").addEventListener("click", async () => {
    try { await post({ action: "interrupt" }); } catch { /* the panel repaints either way */ }
    await loadStatus().catch(() => {});
    await loadRuns().catch(() => {});
  });

  $("engClear").addEventListener("click", async () => {
    try {
      const r = await post({ action: "clear_queue" });
      $("engHead").textContent = `${r.dropped ?? 0} dropped from the queue`;
    } catch { /* repaint below says what is true now */ }
    await loadStatus().catch(() => {});
  });

  $("engHash").addEventListener("change", async () => {
    try { await post({ action: "set_hash_models", on: $("engHash").checked }); }
    catch (e) { alert(e.message); }
    await loadStatus().catch(() => {});
  });

  /* ⚠ CONFIRMED, because this is the one control on the screen that makes the
   * app less able to tell the truth about itself. The confirmation is not
   * ceremony: it is where the cost gets said to the person who is about to pay
   * it, and the reveal is recorded whether they read it or not. */
  $("engReveal").addEventListener("click", async () => {
    const okToo = (await appConfirm(
      "Reveal the engine's port?\n\n"
      + "Anything on this machine that is told the number can then drive the engine directly, "
      + "and those renders will not appear in this list, in the clip library, or in any project.\n\n"
      + "A dated line is written into the ledger saying the port was revealed, so this install's "
      + "history can afterwards say which renders might have bypassed it."));
    if (!okToo) return;
    try {
      const r = await post({ action: "reveal" });
      $("engRevealNote").textContent = `The port is ${r.port}. The ledger has the line.`;
    } catch (e) { alert(e.message); }
    await loadStatus().catch(() => {});
  });

  for (const id of ["engFActor", "engFVia", "engFProject", "engFSince", "engFLimit"]) {
    $(id).addEventListener("change", () => loadRuns().catch(() => {}));
  }
  $("engFStatus").addEventListener("change", () => loadRuns().catch(() => {}));

  $("engRuns").addEventListener("click", (e) => {
    const row = e.target.closest("[data-run]");
    if (row) openDetail(row.dataset.run);
  });

  /* RUN AN EARLIER RENDER AGAIN, EXACTLY. The graph store is content-addressed,
   * so this is the whole of "reproduce it": paste the hash the record carries,
   * get the identical bytes back, and press Run. Nothing here is ever pruned,
   * which is what makes that promise keepable a year later. */
  $("engLoadGraph").addEventListener("click", async () => {
    const host = $("engRunOut");
    const graphHash = $("engGraphHash").value.trim();
    if (!graphHash) { show(host, "Paste the sha256:… a run's record carries."); return; }
    show(host, "Fetching the stored graph…");
    try {
      const r = await post({ action: "graph", graphHash });
      $("engGraph").value = JSON.stringify(r.graph, null, 1);
      show(host, `Loaded ${esc(r.graphHash)} — ${Object.keys(r.graph || {}).length} nodes. `
        + "Dry run first if you have changed anything.");
    } catch (e) { fail(host, e); }
  });

  $("engDry").addEventListener("click", () => runGraph(true));
  $("engRun").addEventListener("click", () => runGraph(false));

  $("engUScan").addEventListener("click", () => scanUnrecorded());
  $("engUPreview").addEventListener("click", () => adoptUnrecorded(true));
  $("engUAdopt").addEventListener("click", () => adoptUnrecorded(false));

  $("engNodes").addEventListener("click", async () => {
    const host = $("engNodeOut");
    show(host, "Asking the engine…");
    try {
      const r = await post({ action: "object_info", node: $("engNode").value.trim() || null });
      const n = r.nodes || {};
      const keys = Object.keys(n);
      show(host, keys.length > 40
        ? `<b>${keys.length} node classes.</b><pre>${esc(keys.join("\n"))}</pre>`
        : `<pre>${esc(JSON.stringify(n, null, 1))}</pre>`);
    } catch (e) { fail(host, e); }
  });

  /* Fill on arrival, not on load: the scan walks the whole output folder and
   * the activity read folds the ledger, and neither is worth doing for a
   * person who never opens this tab. addEventListener so app.js's own onclick
   * — which is what actually switches the view — survives. */
  const link = document.querySelector('.nav a[data-view="engine"]');
  if (link) {
    link.addEventListener("click", () => {
      loadStatus().catch((e) => { $("engHead").textContent = e.message; });
      loadRuns().catch(() => {});
    });
  }
}

wire();
