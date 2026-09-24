/**
 * Video lab — the Video panel's comparison, quality selector and turbo toggles.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE BINDING PRINCIPLE (web/daw.js states it; server/videolab/ui_test.js
 * enforces it): everything MCP-controllable AND completely human-adjustable,
 * ONE document behind both. Every gesture in this file posts one of the SAME
 * /api/videolab actions server/mcp-videolab.js posts. There is no second write
 * path — not one local-only field, not one control whose value lives in this
 * file. When you want one, you have found a missing action.
 *
 * ── WHY THIS IS A SEPARATE MODULE AND NOT PART OF app.js ──────────────────
 * Two other strands are editing this tree. A file of my own is additive by
 * construction: it is loaded by one <script> tag, it reaches into the existing
 * Video panel through the DOM, and it can be deleted without leaving a hole in
 * anything. The only cost is that it cannot see app.js's `state`, which turns
 * out not to matter — everything it needs is either on the server or on an
 * element, and the one thing that was neither (a reference's staged NAME) is
 * now a data attribute on the thumbnail app.js already draws.
 *
 * ── HOW IT COOPERATES WITH THE CONTROLS ALREADY THERE ─────────────────────
 * The quality selector does NOT keep its own size. It writes the size into the
 * existing #vidSize / #vidW / #vidH controls and dispatches `input`, so
 * app.js's own vidPaint recomputes the estimate and the Render button sends
 * exactly what this panel is showing. Then it posts `set_quality`, which writes
 * the same numbers into the engine's own width/height — the value every render
 * falls back to, and the one an agent reads. One size, three places that agree
 * because two of them are told by the third.
 *
 * ⚠ addEventListener, never `onchange =`. app.js owns those properties on these
 * elements; assigning one would silently delete its handler and take the cost
 * estimate down with it.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtSecs = (s) => (s == null ? "—" : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} m ${String(Math.round(s % 60)).padStart(2, "0")} s`);

/** Everything the server said last, so a repaint does not need a round trip. */
let LAB = null;
/** Which comparison the page is watching, and its poll timer. */
let watching = null, pollTimer = null;

const post = async (body) => {
  const r = await (await fetch("/api/videolab", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  if (r.error) throw new Error(r.error);
  return r;
};

/* The engine the Video panel is on. Read from the existing select rather than
 * kept here, because app.js owns that choice and a second copy would be a
 * second thing to keep in step.
 *
 * ⚠ No literal fallback. This used to end `|| "ltx"`, which is the page having
 * an opinion about which engine exists — and the parity gate caught it, because
 * the same string is a comparison arm's id. Undefined is the honest answer:
 * the route then uses whatever the machine is actually set to. */
const currentEngine = () => $("vidEngine")?.value || LAB?.engine || undefined;

/**
 * The references attached in the panel above, by their SERVER-STAGED names.
 *
 * app.js holds these in a closure this file cannot see, so the thumbnails carry
 * `data-refname`. Read from the DOM on purpose: it means the comparison always
 * uses exactly what is on screen, and cannot render an arm against a reference
 * the user removed a moment ago.
 */
function attachedRefs() {
  const imgs = [...document.querySelectorAll("#vidRefImgPrev [data-refname]")]
    .map((el) => el.dataset.refname).filter(Boolean);
  const auds = [...document.querySelectorAll("#vidRefAudPrev [data-refname]")]
    .map((el) => ({ name: el.dataset.refname, start: Number(el.dataset.refstart) || 0 }))
    .filter((a) => a.name);
  return { refImages: imgs, refAudios: auds };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * QUALITY — the selector that explains itself
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rows come from the server (server/videolab/catalog.js), including the
 * measured sentence under each size and the three rules above the list. Nothing
 * here knows a number, which is the point: re-measure, edit one file, and both
 * this panel and the MCP tool say the new thing.
 */
function paintQuality() {
  const box = $("vlabQuality");
  if (!box || !LAB?.quality) return;
  const q = LAB.quality;
  const sel = `${q.width}x${q.height}`;

  box.innerHTML = `
    <div class="vlab-rules">
      ${q.rules.map((r) => `<details class="vlab-rule">
        <summary><b>${esc(r.headline)}</b></summary>
        <p>${esc(r.body)}</p>
        <p class="vlab-cite">Measured in <code>${esc(r.cite)}</code></p>
      </details>`).join("")}
    </div>
    <div class="vlab-sizes">
      ${q.sizes.map((z) => {
        /* "Native" is a PIXEL BUDGET, so the portrait entry is native too — and
         * two rows both reading "native" with nothing to tell them apart is a
         * list that looks broken. The orientation goes in the badge. */
        const badge = z.native
          ? `<span class="vlab-badge native">native${z.portrait ? " · portrait" : ""}</span>`
          : z.aboveNative ? '<span class="vlab-badge above">above native</span>'
          : '<span class="vlab-badge below">below native</span>';
        const added = z.added ? '<span class="vlab-badge added">not in config.js</span>' : "";
        const delivered = (z.deliveredW !== z.w || z.deliveredH !== z.h)
          ? `<span class="vlab-delivered">delivers ${z.deliveredW}&times;${z.deliveredH}</span>` : "";
        return `<label class="vlab-size${sel === z.id ? " on" : ""}">
          <input type="radio" name="vlabsize" value="${esc(z.id)}"${sel === z.id ? " checked" : ""}>
          <span class="vlab-size-head">
            <b>${z.w}&times;${z.h}</b> ${badge}${added}
            <span class="vlab-pct">${z.ofNative == null ? "" : z.ofNative + "% of native"}</span>
            ${delivered}
          </span>
          <span class="vlab-size-why">${z.note ? esc(z.note)
            : `<i>Not in the sweep — offered, but nothing here has measured it.</i>`}</span>
          <span class="vlab-territory">${esc(z.territory || "")}</span>
          ${z.gridWarning ? `<span class="vlab-warn">⚠ ${esc(z.gridWarning)}</span>` : ""}
        </label>`;
      }).join("")}
    </div>
    <p class="vlab-cite">Every figure above: <code>${esc(LAB.docs.faces)}</code></p>
  `;

  for (const input of box.querySelectorAll('input[name="vlabsize"]')) {
    input.addEventListener("change", () => chooseSize(input.value));
  }
}

/**
 * Choose a size. Writes the page's own controls FIRST so the estimate and the
 * Render button agree with what was clicked even if the server round trip is
 * slow, then records it as the engine's default so an agent reads the same
 * number.
 */
async function chooseSize(id) {
  const [w, h] = String(id).split("x").map(Number);
  if (!w || !h) return;
  /* Through the custom pair rather than by selecting an option, because the
   * measured best size is not in the engine's own list — the whole reason
   * catalog.js can add one. The custom path takes any legal size and app.js
   * already shows what will really be delivered. */
  if ($("vidSize")) { $("vidSize").value = "custom"; $("vidSize").dispatchEvent(new Event("input", { bubbles: true })); }
  if ($("vidW")) { $("vidW").value = w; $("vidW").dispatchEvent(new Event("input", { bubbles: true })); }
  if ($("vidH")) { $("vidH").value = h; $("vidH").dispatchEvent(new Event("input", { bubbles: true })); }
  try {
    const r = await post({ action: "set_quality", engine: currentEngine(), width: w, height: h });
    LAB = r.state;
    paintAll();
  } catch (err) { note(err.message); }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMMIT POINT — one line, recomputed live
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single most explanatory number on the H3 path, and it depends on two
 * controls a person is already looking at. Recomputed by the server rather than
 * here so the formula lives in one place — it is the schedule the engine really
 * runs, reused from workflow.js, not a copy.
 */
function paintCommit() {
  const el = $("vlabCommit");
  if (!el) return;
  if (!LAB || !LAB.commit) { el.hidden = true; return; }
  el.hidden = false;
  const c = LAB.commit;
  el.innerHTML = `<b>${c.steps} steps at sigma shift ${c.shift}${c.turbo ? " (turbo path)" : " (quality path)"}</b>
    — ${esc(c.note)}
    <span class="vlab-cite">Traced in <code>${esc(c.cite)}</code></span>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * TOGGLES — rows, not controls
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Every day people put out new workflows", so the list is DATA the server
 * hands over and this function renders whatever arrives. A new switch is a row
 * in server/videolab/catalog.js and nothing at all in here — which is the only
 * version of this that survives contact with a weekly release cycle.
 */
/* ONE CONTROL PER VALUE (UI_PLAN C3). A row whose value the Video screen already
 * has a control for (`formControl`, server/videolab/catalog.js: the steps
 * slider, H3 audio, sparse attention) shows that control's value and a way to
 * it, not a second control that could say the opposite, and beside it the
 * saved default video_settings reads and sets, each named, so the row never
 * shows one value while the tool reports another under the same name. */
function mirrorText(el) {
  if (!el) return "";
  if (el.type === "checkbox") return el.checked ? "on" : "off";
  if (el.tagName === "SELECT") return el.selectedOptions?.[0]?.textContent?.trim() || el.value || "";
  return String(el.value ?? "");
}
/** The saved default a mirrored row stands for, as video_settings reports it. */
function savedText(k) {
  if (k.kind === "bool") return k.value ? "on" : "off";
  return k.value == null ? "unset" : String(k.value);
}
function paintMirrors() {
  for (const m of document.querySelectorAll("#vlabKnobs [data-mirror] b")) {
    m.textContent = mirrorText($(m.parentElement.dataset.mirror));
  }
}
function showControl(id) {
  const el = $(id);
  if (!el) return;
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  el.focus?.();
}

function paintKnobs() {
  const box = $("vlabKnobs");
  if (!box || !LAB) return;
  const rows = LAB.knobs;
  if (!rows.length) { box.innerHTML = "<p class='hint'>This engine has no exposed settings.</p>"; return; }

  box.innerHTML = rows.map((k) => {
    let control;
    const mirror = k.formControl ? $(k.formControl) : null;
    if (mirror) {
      /* Two values, each named: the form's, which a clip made on the Video
       * screen uses, and the saved default video_settings reads and sets,
       * which a render that names none uses (make_clip, the API). */
      control = `<span class="vlab-mirror" data-mirror="${esc(k.formControl)}"><b>${esc(mirrorText(mirror))}</b>
        on the Video screen · <i>${esc(savedText(k))}</i> for a render that names none
        <button class="edtool" type="button" data-show="${esc(k.formControl)}">Show</button></span>`;
    } else if (k.kind === "bool") {
      control = `<input type="checkbox" data-knob="${esc(k.id)}"${k.value ? " checked" : ""}>`;
    } else if (k.kind === "enum") {
      control = `<select class="sel2 sm" data-knob="${esc(k.id)}">${k.options
        .map((o) => `<option value="${esc(o)}"${String(k.value) === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (k.kind === "number") {
      control = `<input class="line sm num" type="number" data-knob="${esc(k.id)}"
        min="${k.min}" max="${k.max}" step="${k.step}" value="${k.value ?? k.unsetAt ?? k.min}">`;
    } else {
      control = `<input class="line" type="text" data-knob="${esc(k.id)}" value="${esc(k.value ?? "")}">`;
    }
    const unset = !mirror && k.unsetAt != null && (k.value == null || k.value === k.unsetAt)
      ? `<span class="vlab-badge">unset — today's behaviour</span>` : "";
    return `<div class="vlab-knob">
      <div class="vlab-knob-head">
        <label>${esc(k.label)}</label>${control}${unset}
      </div>
      <p class="vlab-knob-why">${esc(k.effect)}</p>
      <p class="vlab-cite">From <code>${esc(k.cite)}</code> · writes <code>${esc(k.path)}</code></p>
    </div>`;
  }).join("");

  for (const b of box.querySelectorAll("[data-show]")) b.addEventListener("click", () => showControl(b.dataset.show));
  for (const el of box.querySelectorAll("[data-knob]")) {
    el.addEventListener("change", async () => {
      const id = el.dataset.knob;
      const value = el.type === "checkbox" ? el.checked
        : el.type === "number" ? Number(el.value)
        : el.value;
      try {
        const r = await post({ action: "set_knob", id, value, engine: currentEngine() });
        LAB = r.state;
        note(`${id} → ${JSON.stringify(r.value)}`);
        paintAll();
      } catch (err) {
        note(err.message);
        refresh();          // put the control back to what the server actually holds
      }
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * COMPARE — the same shot, several ways
 * ═══════════════════════════════════════════════════════════════════════════ */
function paintConfigs() {
  const box = $("vlabConfigs");
  if (!box || !LAB) return;
  /* TWO THINGS THIS ROW SHOWS THAT NOTHING ELSE DOES, and why they are read
   * from the arm rather than decided here:
   *
   *   `routing` is set only by an arm that RESOLVED to an engine instead of
   *   naming one, so the "→ engine" badge follows the data — the page never
   *   learns which arm is the routed one, and a second routed arm would get
   *   the badge for free.
   *
   *   `licence` rides on the arm because a comparison is the one surface that
   *   puts somebody on an engine they did not pick: five arms, tick them all,
   *   press go. A territory restriction has to be readable HERE and not only
   *   on the Models page.
   *
   * ⚠ Both explanations live in this comment rather than in an HTML comment
   * inside the template below — a backtick in emitted markup terminates the
   * template literal, which is how this function last failed to parse. */
  box.innerHTML = LAB.configs.map((c) => `<label class="vlab-cfg">
      <input type="checkbox" data-cfg="${esc(c.id)}" checked>
      <span class="vlab-cfg-head"><b>${esc(c.label)}</b>
        <span class="vlab-pct">${esc(c.sizeLabel)}</span>
        ${c.routing ? `<span class="vlab-badge" title="${esc(c.routing)}">→ ${esc(c.engine)}</span>` : ""}
      </span>
      <span class="vlab-cfg-why">${esc(c.why)}</span>
      ${c.licence ? `<span class="vlab-warn">${esc(c.licence)}</span>` : ""}
      <span class="vlab-cite">${esc(c.cite)}</span>
    </label>`).join("");
}

async function paintHybrid() {
  const el = $("vlabHybrid");
  if (!el) return;
  const refs = attachedRefs();
  try {
    const r = await post({ action: "resolve_hybrid", refImages: refs.refImages, refAudios: refs.refAudios });
    el.textContent = `Hybrid would render on ${r.engine.toUpperCase()} — ${r.reason}`;
    el.hidden = false;
  } catch { el.hidden = true; }
}

function paintGroups() {
  const box = $("vlabGroups");
  if (!box || !LAB) return;
  const gs = LAB.groups || [];
  if (!gs.length) {
    box.innerHTML = "<p class='hint'>No comparisons yet. Write a description above, tick the arms you want, and press Compare.</p>";
    return;
  }
  box.innerHTML = gs.map((g) => renderGroup(g)).join("");
  wireGroups(box);
}

/* ── THE STILL STRIP, THE TRANSPORT AND THE ZOOM ──────────────────────────────
 *
 * WHAT WAS WRONG WITH THE CARDS THIS REPLACES, measured on this page's own
 * markup: the arms were a one-column grid of 260 px videos. The panel above
 * them argues an 84 px face at the measured knee against a 58 px face at native
 * — at 260 px wide those are about 12 px and 11 px on screen. The one
 * difference the whole surface exists to teach was invisible in it, and four
 * independent <video controls> meant no two arms could be looked at at the same
 * moment anyway.
 *
 * Three answers, in the order they earn their keep:
 *
 *   1. THE STILL STRIP — the same numbered frames out of every arm, at full
 *      resolution, drawn at a scale you pick and 1:1 on click. Rows are arms,
 *      columns are frames. This is the cheap win: it answers the bleed question
 *      (frame 0), the motion question (frame 15) and the frozen-tail question
 *      (the last frame of the shortest arm) without playing anything.
 *   2. ONE TRANSPORT — one play/pause/scrub driving every arm off a shared
 *      currentTime, so the comparison is at one moment rather than four.
 *   3. THE ZOOM — 1:1 pixels, with the size the arm ASKED FOR beside the size
 *      the file really holds.
 *
 * WHAT LIVES IN THIS FILE AND WHAT DOES NOT. The strips are keyed by group id in
 * a module map so a six-second poll repaint does not throw them away and refetch
 * — that is a cache of a server answer, not a second document. The frame numbers
 * themselves are NOT kept here: they are posted and written onto the group, so
 * an agent reading it afterwards sees the columns a person chose.
 */

/** The last still payload per group id. A cache of a server answer, nothing more. */
const STILLS = new Map();
/** How big to draw a still, per group. A view preference; nothing reads it back. */
const SCALE = new Map();
/** One shared clock per group: {playing, raf}. */
const TRANSPORT = new Map();

const SCALES = [
  { id: "quarter", label: "1:4", factor: 0.25 },
  { id: "half", label: "1:2", factor: 0.5 },
  { id: "full", label: "1:1", factor: 1 },
];
const scaleOf = (gid) => SCALES.find((s) => s.id === (SCALE.get(gid) || "half")) || SCALES[1];

/** "0, 15, 60" in the box → [0, 15, 60]. Anything unreadable is simply dropped. */
function readFrames(text) {
  return String(text || "").split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function renderGroup(g) {
  const done = g.arms.filter((a) => a.status === "done");
  /* Fastest and slowest are worth marking because that IS the comparison —
   * the wall time is half the answer and the eye cannot see it. */
  const times = done.map((a) => a.wallSeconds).filter((n) => n != null);
  const fastest = times.length ? Math.min(...times) : null;
  const slowest = times.length ? Math.max(...times) : null;
  const playable = g.arms.filter((a) => a.clip).length;
  /* `data-running` rather than sniffing the rendered text for the word.
   * Reading state back out of your own markup is how a repaint stops polling
   * the moment somebody rewords a label. */
  return `<div class="vlab-group" data-group="${esc(g.id)}"${g.running ? ' data-running="1"' : ""}>
    <div class="vlab-group-head">
      <b>${esc(g.prompt).slice(0, 80)}</b>
      <span class="vlab-pct">seed ${g.seed} · ${g.arms.length} arms${g.running ? " · running" : ""}</span>
    </div>
    ${renderVerdict(g)}
    ${playable ? renderStrip(g) : ""}
    ${playable > 1 ? renderTransport(g) : ""}
    <div class="vlab-arms">
      ${g.arms.map((a) => {
        const mark = a.wallSeconds != null && times.length > 1
          ? (a.wallSeconds === fastest ? '<span class="vlab-badge native">fastest</span>'
            : a.wallSeconds === slowest ? '<span class="vlab-badge above">slowest</span>' : "") : "";
        const won = g.verdict && g.verdict.armId === a.id
          ? '<span class="vlab-badge native">the verdict</span>' : "";
        return `<div class="vlab-arm ${esc(a.status)}${won ? " won" : ""}" data-arm="${esc(a.id)}">
          <div class="vlab-arm-head"><b>${esc(a.label)}</b> ${mark}${won}
            <span class="vlab-pct">${esc(a.sizeLabel)}</span></div>
          <div class="vlab-arm-body">
            ${a.clip ? `<video src="/api/clip/${encodeURIComponent(a.clip)}" preload="metadata"
              playsinline muted data-armvid="${esc(a.id)}"></video>
              <button class="edtool" type="button" data-zoomvid="${esc(a.id)}">This frame at 1:1</button>` : ""}
            <div class="vlab-arm-facts">
              <span class="vlab-time">${a.status === "done" ? fmtSecs(a.wallSeconds) : esc(a.status)}</span>
              ${a.commitSigma != null ? `<span class="vlab-pct">commits at sigma ${a.commitSigma.toFixed(3)}</span>` : ""}
              ${a.routing ? `<span class="vlab-pct">${esc(a.routing)}</span>` : ""}
              ${a.clip ? `<code>${esc(a.clip)}</code>` : ""}
              ${a.note ? `<span class="vlab-warn">${esc(a.note)}</span>` : ""}
              ${a.error ? `<span class="vlab-warn">⚠ ${esc(a.error)}</span>` : ""}
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${renderVerdictForm(g)}
  </div>`;
}

/**
 * The strip. Rows are arms, columns are frames, and the first column carries the
 * arm's name and the size its file really holds — the two things you need to
 * read the row beside it.
 */
function renderStrip(g) {
  const s = STILLS.get(g.id);
  const def = LAB?.stills?.defaultFrames || [];
  const shown = (s?.frames?.length ? s.frames : (g.frames?.length ? g.frames : def)).join(", ");
  const sc = scaleOf(g.id);
  const head = `<div class="vlab-strip-head">
      <b>Frame-locked stills</b>
      <label class="vlab-strip-frames">frames
        <input class="line sm" type="text" data-frames="${esc(g.id)}" value="${esc(shown)}"
          size="12" title="The same frame numbers for every arm, comma separated."></label>
      <button class="edtool" type="button" data-stills="${esc(g.id)}">${s ? "Retake" : "Take stills"}</button>
      <span class="vlab-scale">${SCALES.map((o) => `<label><input type="radio"
        name="vlabscale${esc(g.id)}" value="${esc(o.id)}" data-scale="${esc(g.id)}"${o.id === sc.id ? " checked" : ""}> ${esc(o.label)}</label>`).join("")}</span>
    </div>`;

  if (!s) {
    return `<div class="vlab-strip">${head}
      <p class="hint">${esc(LAB?.stills?.why || "")}
        <span class="vlab-cite">Extracted by <code>${esc(LAB?.stills?.cite || "")}</code></span></p></div>`;
  }
  if (!s.frames.length || !s.rows.some((r) => r.stills.length)) {
    return `<div class="vlab-strip">${head}<p class="hint">${esc(s.note || "Nothing to take a frame out of.")}</p></div>`;
  }

  const cols = s.frames.length;
  const cells = s.rows.map((r) => {
    const delivered = r.width
      ? `${r.width}&times;${r.height}${r.width !== r.askedWidth || r.height !== r.askedHeight
        ? ` <span class="vlab-warn">asked ${r.askedWidth}&times;${r.askedHeight}</span>` : ""}`
      : "";
    const label = `<div class="vlab-gl"><b>${esc(r.label)}</b>
      <span class="vlab-pct">${delivered}</span>
      ${r.sourceFrames ? `<span class="vlab-pct">${r.sourceFrames} frames</span>` : ""}
      ${r.error ? `<span class="vlab-warn">${esc(r.error)}</span>` : ""}</div>`;
    const row = s.frames.map((f) => {
      const st = r.stills.find((x) => x.frame === f);
      if (!st) {
        const miss = r.missing.find((x) => x.frame === f);
        return `<div class="vlab-gc empty">${esc(miss?.error || "not taken")}</div>`;
      }
      return `<div class="vlab-gc"><img loading="lazy" src="${esc(st.url)}"
        width="${Math.max(1, Math.round(st.w * sc.factor))}"
        data-zoom="${esc(st.url)}" data-zoomarm="${esc(r.armId)}" data-zoomframe="${st.frame}"
        alt="${esc(r.label)} frame ${st.frame}"></div>`;
    }).join("");
    return label + row;
  }).join("");

  const heads = `<div class="vlab-gh"></div>` + s.frames.map((f, i) => {
    const at = s.rows.find((r) => r.stills.length)?.stills.find((x) => x.frame === f)?.atSec;
    return `<div class="vlab-gh">frame ${f}${at != null ? ` <span class="vlab-pct">${at.toFixed(2)} s</span>` : ""}${i === 0 ? ' <span class="vlab-pct">the bleed frame</span>' : ""}</div>`;
  }).join("");

  return `<div class="vlab-strip">${head}
    ${s.clamped ? `<p class="vlab-warn">⚠ ${esc(s.clamped)}</p>` : ""}
    <div class="vlab-grid-scroll"><div class="vlab-grid" style="--vlab-cols:${cols}">
      ${heads}${cells}
    </div></div>
    <p class="vlab-cite">Full-resolution frames, drawn at ${esc(sc.label)}. Click any one for 1:1 pixels.
      Extracted by <code>${esc(LAB?.stills?.cite || "")}</code></p>
  </div>`;
}

/** One play/pause/scrub for the whole group. */
function renderTransport(g) {
  return `<div class="vlab-transport" data-transport="${esc(g.id)}">
    <button class="edtool" type="button" data-play="${esc(g.id)}">Play all</button>
    <input type="range" data-scrub="${esc(g.id)}" min="0" max="1" step="0.01" value="0">
    <span class="vlab-clock" data-clock="${esc(g.id)}">0.00 s</span>
    <span class="hint">One clock for every arm. An arm that runs out of frames first holds on its last one.</span>
  </div>`;
}

function renderVerdict(g) {
  if (!g.verdict) return "";
  const arm = g.arms.find((a) => a.id === g.verdict.armId);
  return `<p class="vlab-verdict">
    <b>${esc(arm ? arm.label : "None of them")}</b> — ${esc(g.verdict.note)}
    <span class="vlab-cite">${esc(g.verdict.by)} · ${new Date(g.verdict.at).toLocaleString()}</span></p>`;
}

/**
 * Writing one down. `by` is fixed to the person here and to the agent in the
 * tool — the same actor-honesty rule the rest of this app holds at every seam
 * where a machine and a person write into one field. A comparison costs several
 * full renders; whose call it was is part of the result.
 */
function renderVerdictForm(g) {
  if (g.running || !g.arms.some((a) => a.clip)) return "";
  const opts = g.arms.map((a) => `<option value="${esc(a.id)}"${g.verdict?.armId === a.id ? " selected" : ""}>${esc(a.label)}</option>`).join("");
  return `<div class="vlab-verdict-form">
    <label>Verdict</label>
    <select class="sel2 sm" data-varm="${esc(g.id)}">
      <option value=""${g.verdict && !g.verdict.armId ? " selected" : ""}>none of them</option>
      ${opts}
    </select>
    <input class="line" type="text" data-vnote="${esc(g.id)}" placeholder="Why — one sentence you could act on in a month"
      value="${esc(g.verdict?.note || "")}">
    <button class="edtool" type="button" data-vsave="${esc(g.id)}">Save</button>
    <span class="hint">Saved on the comparison, read back by the tools. Clear the box and save to take it back.</span>
  </div>`;
}

function wireGroups(box) {
  for (const el of box.querySelectorAll("[data-group][data-running]")) watch(el.dataset.group);

  for (const b of box.querySelectorAll("[data-stills]")) {
    b.addEventListener("click", () => takeStills(b.dataset.stills));
  }
  for (const r of box.querySelectorAll("[data-scale]")) {
    r.addEventListener("change", () => { SCALE.set(r.dataset.scale, r.value); paintGroups(); });
  }
  for (const img of box.querySelectorAll("[data-zoom]")) {
    img.addEventListener("click", () => zoomStill(img));
  }
  for (const b of box.querySelectorAll("[data-zoomvid]")) {
    b.addEventListener("click", () => zoomVideoFrame(b));
  }
  for (const b of box.querySelectorAll("[data-vsave]")) {
    b.addEventListener("click", () => saveVerdict(b.dataset.vsave));
  }
  for (const el of box.querySelectorAll("[data-transport]")) wireTransport(el);
}

/**
 * Ask the server for the strip. The frame numbers go WITH the request and come
 * back written onto the group, so the box on screen and the number an agent
 * reads are the same number.
 */
async function takeStills(id) {
  const input = document.querySelector(`[data-frames="${id}"]`);
  const frames = readFrames(input?.value);
  const btn = document.querySelector(`[data-stills="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Reading frames…"; }
  try {
    const r = await post({ action: "stills", id, frames: frames.length ? frames : undefined });
    STILLS.set(id, r);
    const g = (LAB.groups || []).find((x) => x.id === id);
    if (g && r.frames.length) g.frames = r.frames;
    paintGroups();
    note(r.clamped || `Stills at frames ${r.frames.join(", ")}.`);
  } catch (err) {
    note(err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Take stills"; }
  }
}

async function saveVerdict(id) {
  const armId = document.querySelector(`[data-varm="${id}"]`)?.value || "";
  const noteText = document.querySelector(`[data-vnote="${id}"]`)?.value || "";
  try {
    /* `by` is the page's own word for the hand that is writing, and it is not a
     * control — a box a person could type "agent" into would defeat the one
     * thing this field is for. */
    const r = await post({ action: "verdict", id, armId, note: noteText, by: "person" });
    const at = (LAB.groups || []).findIndex((x) => x.id === id);
    if (at >= 0) LAB.groups[at] = r.group;
    paintGroups();
    note(r.verdict ? "Verdict saved on the comparison." : "Verdict cleared.");
  } catch (err) { note(err.message); }
}

/* ── the zoom ───────────────────────────────────────────────────────────────
 * Built as DOM nodes rather than markup, because one of the two things it shows
 * is a canvas grab of a paused video and a data URL of a 1344-wide frame is a
 * megabyte of string to push through innerHTML. */
function showZoom(src, caption) {
  document.getElementById("vlabZoom")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "vlab-zoom";
  wrap.id = "vlabZoom";
  const cap = document.createElement("p");
  cap.className = "vlab-zoom-cap";
  cap.textContent = caption;
  const pane = document.createElement("div");
  pane.className = "vlab-zoom-pane";
  const img = document.createElement("img");
  img.src = src;
  pane.appendChild(img);
  wrap.append(cap, pane);
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  wrap.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
}

function zoomStill(img) {
  const gid = img.closest("[data-group]")?.dataset.group;
  const s = STILLS.get(gid);
  const row = s?.rows.find((r) => r.armId === img.dataset.zoomarm);
  const st = row?.stills.find((x) => String(x.frame) === img.dataset.zoomframe);
  const asked = row && (row.width !== row.askedWidth || row.height !== row.askedHeight)
    ? ` — the arm asked for ${row.askedWidth}×${row.askedHeight}` : "";
  showZoom(img.dataset.zoom,
    `${row?.label || ""} · frame ${img.dataset.zoomframe}${st ? ` at ${st.atSec.toFixed(2)} s` : ""}`
    + ` · the file holds ${st?.w}×${st?.h}${asked} · shown 1:1`);
}

/**
 * The frame a video is paused on, at 1:1. Canvas rather than another server
 * round trip: the pixels are already decoded in the page, and the point of this
 * button is to answer "what am I actually looking at" without a wait.
 */
function zoomVideoFrame(btn) {
  const group = btn.closest("[data-group]");
  const gid = group?.dataset.group;
  const vid = group?.querySelector(`[data-armvid="${btn.dataset.zoomvid}"]`);
  if (!vid || !vid.videoWidth) { note("That arm has not decoded a frame yet — press play, or scrub."); return; }
  const g = (LAB.groups || []).find((x) => x.id === gid);
  const arm = g?.arms.find((a) => a.id === btn.dataset.zoomvid);
  const c = document.createElement("canvas");
  c.width = vid.videoWidth; c.height = vid.videoHeight;
  c.getContext("2d").drawImage(vid, 0, 0);
  const asked = arm && (arm.width !== vid.videoWidth || arm.height !== vid.videoHeight)
    ? ` — the arm asked for ${arm.width}×${arm.height}` : "";
  showZoom(c.toDataURL("image/png"),
    `${arm?.label || ""} · ${vid.currentTime.toFixed(2)} s`
    + ` · the file holds ${vid.videoWidth}×${vid.videoHeight}${asked} · shown 1:1`);
}

/* ── one transport ──────────────────────────────────────────────────────────
 *
 * The longest arm is the CLOCK and the others are set from it, rather than every
 * element running free. Arms differ in length — this app's own proof group has a
 * 49-frame LTX arm beside 56-frame H3 ones — so an arm that runs out holds on
 * its last frame instead of looping, going black, or quietly finishing early and
 * leaving a comparison of one moment against another.
 */
function wireTransport(el) {
  const gid = el.dataset.transport;
  const group = el.closest("[data-group]");
  const vids = [...group.querySelectorAll("[data-armvid]")];
  if (!vids.length) return;
  const scrub = el.querySelector("[data-scrub]");
  const clock = el.querySelector("[data-clock]");
  const play = el.querySelector("[data-play]");

  const longest = () => vids.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a), vids[0]);
  const span = () => Math.max(...vids.map((v) => v.duration || 0), 0);

  const sync = (t) => {
    for (const v of vids) {
      const end = (v.duration || 0) - 0.04;
      if (!(end > 0)) continue;
      if (t >= end) {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - end) > 0.02) v.currentTime = end;
      } else if (Math.abs(v.currentTime - t) > 0.08) {
        v.currentTime = t;
      }
    }
    if (scrub) scrub.value = String(t);
    if (clock) clock.textContent = `${t.toFixed(2)} s`;
  };

  const meta = () => {
    const d = span();
    if (scrub && d > 0) { scrub.max = String(d); scrub.step = "0.01"; }
  };
  for (const v of vids) v.addEventListener("loadedmetadata", meta);
  meta();

  const state = TRANSPORT.get(gid) || {};
  TRANSPORT.set(gid, state);

  const tick = () => {
    if (!state.playing) return;
    const master = longest();
    sync(master.currentTime);
    if (master.ended || master.currentTime >= (master.duration || 0) - 0.04) stop();
    else state.raf = requestAnimationFrame(tick);
  };

  /* ⚠ requestAnimationFrame DOES NOT FIRE IN A HIDDEN TAB, and the media keeps
   * playing. Measured on this page: switch away mid-playback and the arms carry
   * on at their own rates with nothing correcting them, so they come back out of
   * step and the short arm sails past the end it was supposed to hold at — which
   * is precisely the failure one transport exists to prevent. `timeupdate` keeps
   * firing while hidden, so IT is the correctness path and rAF is only there to
   * make the clock smooth. Attached to every arm and filtered to whichever is
   * currently longest, because the durations are not known when this runs. */
  for (const v of vids) {
    v.addEventListener("timeupdate", () => {
      if (!state.playing || v !== longest()) return;
      sync(v.currentTime);
    });
    v.addEventListener("ended", () => { if (state.playing && v === longest()) stop(); });
  }
  const stop = () => {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    for (const v of vids) v.pause();
    if (play) play.textContent = "Play all";
  };
  const start = () => {
    const master = longest();
    if (master.currentTime >= (master.duration || 0) - 0.05) sync(0);
    state.playing = true;
    if (play) play.textContent = "Pause";
    for (const v of vids) {
      if ((v.duration || 0) > master.currentTime) v.play().catch(() => {});
    }
    state.raf = requestAnimationFrame(tick);
  };

  play?.addEventListener("click", () => (state.playing ? stop() : start()));
  scrub?.addEventListener("input", () => { if (state.playing) stop(); sync(Number(scrub.value)); });
}

/** Poll one comparison while it renders. Arms are minutes, so this is gentle. */
function watch(id) {
  if (watching === id) return;
  watching = id;
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const { group } = await post({ action: "group", id });
      LAB = LAB || {};
      LAB.groups = LAB.groups || [];
      const at = LAB.groups.findIndex((g) => g.id === id);
      if (at >= 0) LAB.groups[at] = group; else LAB.groups.unshift(group);
      paintGroups();
      if (!group.running) { clearInterval(pollTimer); watching = null; }
    } catch { clearInterval(pollTimer); watching = null; }
  }, 6000);
}

async function startCompare() {
  const prompt = $("vidPrompt")?.value.trim();
  if (!prompt) { note("Describe the clip first — every arm renders the same description."); return; }
  const configs = [...document.querySelectorAll("#vlabConfigs [data-cfg]")]
    .filter((c) => c.checked).map((c) => c.dataset.cfg);
  if (!configs.length) { note("Tick at least one configuration."); return; }
  const refs = attachedRefs();
  const btn = $("vlabCompare");
  btn.disabled = true;
  try {
    const r = await post({
      action: "compare",
      prompt,
      configs,
      seconds: Number($("vidSecs")?.value) || undefined,
      /* Seed: whatever is typed above, or the server rolls ONE and holds it
       * across every arm. A comparison on different seeds is not a comparison —
       * the seed spread on this model is larger than several of the effects
       * people try to read off a single pair of clips. */
      seed: $("vidSeed")?.value.trim() ? Number($("vidSeed").value.trim()) : undefined,
      fromCover: $("vidFrom")?.value || undefined,
      refImages: refs.refImages.length ? refs.refImages : undefined,
      refAudios: refs.refAudios.length ? refs.refAudios : undefined,
      negative: $("vidNeg")?.value.trim() || undefined,
    });
    LAB = LAB || {};
    LAB.groups = [r.group, ...(LAB.groups || []).filter((g) => g.id !== r.group.id)];
    paintGroups();
    watch(r.group.id);
    note(`Comparing ${r.group.arms.length} configurations on seed ${r.group.seed}. Each arm is a full render — they run one at a time, and music always goes first.`);
  } catch (err) {
    note(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */

function note(msg) {
  const el = $("vlabNote");
  if (el) el.textContent = msg;
}

function paintAll() {
  paintQuality();
  paintCommit();
  paintKnobs();
  paintConfigs();
  paintGroups();
  paintHybrid();
}

async function refresh() {
  try {
    /* The references go WITH the state request, so the hybrid arm's badge says
     * the engine it would really route to. Sending nothing makes it read
     * "-> ltx" on a shot carrying cast, which is the misreport this fork
     * already paid an evening for. */
    LAB = await post({ action: "state", engine: currentEngine(), ...attachedRefs() });
    paintAll();
  } catch (err) { note(err.message); }
}

function mount() {
  const host = $("vlab");
  if (!host) return;
  /* The "older comparisons" button is a real control, not a nicety: `state`
   * carries only the last twelve, and a comparison costs several full renders,
   * so reaching an old one has to beat running it again. It is also the human
   * half of the `groups` action — without it that would be an agent-only
   * capability, which the parity gate refuses.
   *
   * ⚠ No HTML comments inside this template. A backtick in emitted markup ends
   * the template literal, and an explanatory comment is exactly where one gets
   * written. Explanations go here. */
  host.innerHTML = `
    <details class="field vlab">
      <summary><b>Quality</b> <span class="sp meta">what each size actually buys</span></summary>
      <div id="vlabQuality"></div>
      <p class="vlab-commit" id="vlabCommit" hidden></p>
    </details>

    <details class="field vlab">
      <summary><b>Engine settings</b> <span class="sp meta">turbo, steps, sigma shift — with reasons</span></summary>
      <div id="vlabKnobs"></div>
    </details>

    <details class="field vlab">
      <summary><b>Compare</b> <span class="sp meta">one shot, several configurations</span></summary>
      <p class="hint">Same description, same seed, same references — only the configuration
        changes. Each arm is a full render and they run one at a time, so keep the length
        short. Results land in the clip library tagged as one group.</p>
      <div id="vlabConfigs"></div>
      <p class="hint" id="vlabHybrid" hidden></p>
      <div class="framepick"><button class="edtool" type="button" id="vlabCompare">Compare</button></div>
      <p class="ctanote" id="vlabNote"></p>
      <div id="vlabGroups"></div>
      <button class="edtool" type="button" id="vlabMore">Older comparisons&hellip;</button>
    </details>
  `;
  $("vlabCompare").addEventListener("click", startCompare);
  $("vlabMore").addEventListener("click", async () => {
    try {
      const r = await post({ action: "groups", limit: 50 });
      LAB.groups = r.groups || [];
      paintGroups();
      note(`${LAB.groups.length} comparison${LAB.groups.length === 1 ? "" : "s"} on record.`);
    } catch (err) { note(err.message); }
  });

  /* app.js owns `.oninput` / `.onchange` on these; addEventListener sits
   * beside its handlers instead of replacing them. Assigning the property here
   * would silently delete the cost estimate. */
  $("vidSteps")?.addEventListener("input", onStepsMoved);
  $("vidEngine")?.addEventListener("change", () => setTimeout(refresh, 150));
  /* The mirrored rows follow the form's own controls as they move. */
  for (const id of ["vidSteps", "vidAudio", "vidSparse"]) {
    $(id)?.addEventListener("input", paintMirrors);
    $(id)?.addEventListener("change", paintMirrors);
  }

  /* The size list is rebuilt by app.js on every engine switch, which is also
   * the moment this panel's numbers stop being about the right engine. Watching
   * the rebuild is more reliable than racing the fetch that caused it. */
  const sizeSel = $("vidSize");
  if (sizeSel) new MutationObserver(() => refresh()).observe(sizeSel, { childList: true });

  refresh();
}

/** Steps moved: the commit point changes, so ask the server what it becomes. */
let stepTimer = null;
function onStepsMoved() {
  clearTimeout(stepTimer);
  stepTimer = setTimeout(async () => {
    const steps = Number($("vidSteps").value);
    const [w, h] = ($("vidSize").value === "custom")
      ? [Number($("vidW").value), Number($("vidH").value)]
      : String($("vidSize").value).split("x").map(Number);
    if (!w || !h) return;
    try {
      const r = await post({ action: "set_quality", engine: currentEngine(), width: w, height: h, steps });
      LAB = r.state;
      paintCommit();
      paintKnobs();
    } catch { /* the estimate above is still right; a stale commit line is not worth an alert */ }
  }, 400);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
