/**
 * The project board — a faithful port of the website's MvCrimeBoard, made
 * lane-generic so the music-video pipeline and the audiobook pipeline both
 * draw with it.
 *
 * Rendering: absolutely-positioned DOM buttons per node over ONE SVG of
 * vertical S-bezier links (control points at the vertical midpoint). Layout is
 * pure grid math — nothing measures the DOM. Two views on the same geometry:
 * "timeline" colors links by relationship TYPE and borders by STATUS;
 * "relations" colors everything by the clip/bundle each link belongs to.
 * Click a node to isolate its links (opacity only, nothing unmounts).
 */

const NODE_W = 116, NODE_H = 70, GAP_X = 26, PAD = 24, LANE_STEP = 136;

export const BOARD_PALETTE = ["#4f8cff", "#ff7eb6", "#46c6a0", "#ffb454", "#9b6bff", "#5fd0e6",
  "#e06fd6", "#8fd14f", "#ff6b6b", "#54a0ff", "#feca57", "#1dd1a1"];

export const STATUS_COLOR = {
  pending: "var(--edge)", planned: "var(--edge)",
  generating: "#ffb454", processing: "#ffb454", rendering: "#ffb454",
  ready: "#5fd0e6", rendered: "#5fd0e6", narrated: "#5fd0e6",
  approved: "#46c6a0", done: "#46c6a0", mixed: "#46c6a0", imported: "#46c6a0",
  stale: "#ff9f43", "stale-voice": "#ff9f43", "stale-cast": "#ff9f43",
  failed: "#ff5d5d", skipped: "#8a8a8a",
};

/**
 * model: {
 *   lanes: [{ key, label }],
 *   nodes: [{ key, lane, col, label, sub?, glyph?, status?, thumb?, video?, group?,
 *            flags?: string[], ghost?: boolean }],
 *          // group = clip/bundle column index -> palette color in Relations view
 *          // flags = continuity breaks this node is named in; any flag draws it broken
 *   links: [{ a, b, type, group, broken?, why? }],
 *   legend: [{ color, label }],       // timeline-view legend rows
 *   breaks?: [{ level, kind, where, msg, nodes: [key] }],
 *   note?: string,                    // extra hint line (e.g. truncation notice)
 *   onSelect?: (node|null) => void,
 * }
 */
const TYPE_COLORS = { character: "#4f8cff", prop: "#ffb454", background: "#46c6a0", board: "#9b6bff",
  chapter: "#4f8cff", bed: "#46c6a0", voice: "#ff7eb6", sfx: "#feca57" };

/* ⚠ ONE COLOUR MEANS ONE THING, and here it means BROKEN.
 *
 * The board's whole claim is that you do not have to read it. That only holds
 * if a break cannot be mistaken for anything else on the canvas, so alarm red
 * is spent on nothing but continuity and every broken edge is also DASHED —
 * colour alone is not a signal a colour-blind reader can act on, and a link
 * that is merely a different hue reads as another relationship type rather
 * than as a fault. */
const BREAK_COLOR = "#ff4d4d";

/* ⚠ AND ONE MORE COLOUR, FOR THE THING THAT IS NOT A BREAK AND IS NOT FINE.
 *
 * "Named, not sent": a reference this shot resolved, counted, and wrote into
 * the prompt as <Picture N>, which the video model was never handed — because
 * the engine has no named-reference input. Nothing is WRONG with the project,
 * so it must not wear alarm red; but the edge is not the promise a solid line
 * makes, so it must not be drawn as one either. Grey and dashed: present,
 * accounted for, carrying nothing. The dash is the signal a colour-blind reader
 * acts on, exactly as it is for a break. */
const NOTSENT_COLOR = "#8a8a8a";

export function mountBoard(host, model) {
  const lanes = model.lanes;
  const laneY = Object.fromEntries(lanes.map((l, i) => [l.key, 16 + i * LANE_STEP]));
  const cols = Math.max(1, ...model.nodes.map((n) => n.col + 1));
  const width = PAD * 2 + cols * (NODE_W + GAP_X);
  const height = 16 + lanes.length * LANE_STEP - (LANE_STEP - NODE_H) + 16;

  const nodeByKey = new Map();
  for (const n of model.nodes) {
    n.x = PAD + n.col * (NODE_W + GAP_X);
    n.y = laneY[n.lane] ?? 16;
    n.color = n.group != null ? BOARD_PALETTE[n.group % BOARD_PALETTE.length] : null;
    nodeByKey.set(n.key, n);
  }
  const lines = model.links.map((l) => {
    const a = nodeByKey.get(l.a), b = nodeByKey.get(l.b);
    if (!a || !b) return null;
    // always bottom edge of the upper node to top edge of the lower one
    const [up, dn] = a.y <= b.y ? [a, b] : [b, a];
    return { x1: up.x + NODE_W / 2, y1: up.y + NODE_H, x2: dn.x + NODE_W / 2, y2: dn.y,
             typeColor: TYPE_COLORS[l.type] || "var(--edge-s)",
             groupColor: BOARD_PALETTE[(l.group ?? 0) % BOARD_PALETTE.length],
             broken: !!l.broken, notSent: !!l.notSent, why: l.why || "",
             a: l.a, b: l.b };
  }).filter(Boolean);

  /* ⚠ ABSENT IS NOT THE SAME AS ZERO. A model that carries a `breaks` array has
   * been checked and found clean, and saying so is the point — an empty space
   * is indistinguishable from a check that never ran. A model with NO array
   * (the audiobook board) has not been checked at all, and printing "no
   * continuity breaks" over it would be inventing a guarantee: a bundle has no
   * references to resolve, so the sentence is not even meaningful there. */
  const checked = Array.isArray(model.breaks);
  const breaks = model.breaks || [];

  let view = "timeline";
  /* SELECTION IS A SET, not a key. It used to be one node, which was enough for
   * "show me what this face touches" and useless for the thing this board is
   * now for: a break names two or three nodes at once — the prop, the board it
   * is referenced on, the clip that already shipped without it — and lighting
   * one of them at a time makes the reader do the join themselves. */
  let sel = null;                 // Set<key> | null
  let selLabel = "";              // what put it there, shown so it can be cleared

  const isSel = (key) => !!sel && sel.has(key);
  const connected = (key) => !!sel && (isSel(key)
    || lines.some((l) => (isSel(l.a) && l.b === key) || (isSel(l.b) && l.a === key)));
  const pick = (keys, label) => {
    const next = new Set(keys);
    // clicking the same thing twice clears it — the only way back to the whole map
    if (sel && sel.size === next.size && [...next].every((k) => sel.has(k))) { sel = null; selLabel = ""; }
    else { sel = next; selLabel = label; }
    draw();
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function draw() {
    const svg = lines.map((l) => {
      const hot = !sel || isSel(l.a) || isSel(l.b);
      /* A broken edge keeps its alarm colour in BOTH views. Relations view
       * recolours everything by clip, and a fault that disappears when you
       * change tabs is a fault the reader will conclude they imagined. */
      /* Broken beats not-sent beats the view's own palette. A fault outranks a
       * limitation, and a limitation outranks decoration — in both views, for
       * the same reason a break keeps its colour in Relations. */
      const stroke = l.broken ? BREAK_COLOR
        : l.notSent ? NOTSENT_COLOR
        : (view === "relations" ? l.groupColor : l.typeColor);
      const dashed = l.broken || l.notSent;
      return `<path d="M ${l.x1} ${l.y1} C ${l.x1} ${(l.y1 + l.y2) / 2}, ${l.x2} ${(l.y1 + l.y2) / 2}, ${l.x2} ${l.y2}"
        fill="none" stroke="${stroke}" stroke-opacity="${sel ? (hot ? 0.95 : 0.05) : (l.broken ? 0.9 : l.notSent ? 0.45 : 0.5)}"
        ${dashed ? `stroke-dasharray="${l.broken ? "5 4" : "2 5"}" ` : ""}stroke-width="${l.broken ? 2.4 : (sel && hot ? 2.6 : 1.6)}"
        ><title>${esc(l.why || "")}</title></path>`;
    }).join("");

    const nodes = model.nodes.map((n) => {
      const dim = !!sel && !connected(n.key);
      const isGrouped = n.group != null;
      const bad = (n.flags || []).length > 0;
      /* Broken beats grouped beats status. A node the reader must act on must
       * not be wearing its clip's palette colour on the tab where that palette
       * is the subject. */
      const border = bad ? BREAK_COLOR
        : (view === "relations" && isGrouped && n.color ? n.color : (STATUS_COLOR[n.status] || "var(--edge)"));
      const media = n.video
        ? `<video src="${esc(n.video)}" preload="metadata" muted></video>`
        : n.thumb ? `<img src="${esc(n.thumb)}" loading="lazy" alt="">`
        : `<span class="bkind">${esc(n.glyph || n.lane[0].toUpperCase())}</span>`;
      return `<button class="bnode${isSel(n.key) ? " bsel" : ""}${bad ? " bbad" : ""}${n.ghost ? " bghost" : ""}"
        data-key="${esc(n.key)}"
        style="left:${n.x}px;top:${n.y}px;border-color:${border};opacity:${dim ? 0.35 : 1}"
        title="${esc(bad ? `${n.label} — ${(n.flags || []).join(", ")}` : n.label)}">
        <span class="bthumb">${media}</span>
        <span class="blabel" title="${esc(n.label)}">${esc(n.label)}</span>
        ${bad ? `<i class="bwarn" aria-hidden="true">!</i>` : ""}
        ${n.status ? `<i class="bdot" style="background:${bad ? BREAK_COLOR : (STATUS_COLOR[n.status] || "var(--edge)")}"
           title="${esc(n.status)}"></i>` : ""}
      </button>`;
    }).join("");

    const labels = lanes.map((l) => `<div class="blane" style="top:${(laneY[l.key] ?? 16) + NODE_H / 2 - 8}px">${esc(l.label)}</div>`).join("");

    /* A dashed entry gets a dashed swatch. A legend that draws every line as a
     * solid bar cannot explain the one distinction the canvas is making. */
    const legend = view === "timeline"
      ? (model.legend || []).map((g) => `<span class="bleg"${g.title ? ` title="${esc(g.title)}"` : ""}><i${
          g.dash
            ? ` class="dash" style="background:repeating-linear-gradient(90deg,${g.color} 0 3px,transparent 3px 6px)"`
            : ` style="background:${g.color}"`}></i>${esc(g.label)}</span>`).join("")
      : `<span class="hint">each ${esc(model.groupNoun || "clip")} has its own color — click any node to isolate its links</span>`;

    /* ── THE BREAK BAR ───────────────────────────────────────────────────────
     * The count comes FIRST, before the view toggles and before the legend,
     * because it is the one thing on this page somebody has to act on. When
     * there are none it says so rather than disappearing: an empty space is
     * indistinguishable from a check that never ran, and "0 continuity breaks"
     * is the sentence that makes the green state mean something. */
    /* ⚠ A NOTE IS NOT A BREAK, and this bar was counting them as one.
     *
     * The server has separated them since the map was built — crimeBoard sorts
     * error, warn, note and its `counts` reports `breaks` (error and warn) and
     * `notes` apart, with the reason written beside it: "a note is not a break —
     * nothing about it is wrong". This bar read `breaks.length`, which is the
     * whole array, so a project with six clean findings and two notes announced
     * EIGHT continuity breaks in red, and the one number on this screen a person
     * is meant to act on was the one number that could not be acted on.
     *
     * The counts are the SERVER's where it sends them, and derived from the list
     * only as a fallback for a board that predates them — never recomputed
     * beside a count that already exists, because two rules over one list is how
     * the sentence and the highlight start disagreeing. */
    const errs = model.counts?.errors ?? breaks.filter((b) => b.level === "error").length;
    const noteN = model.counts?.notes ?? breaks.filter((b) => b.level === "note").length;
    const realN = model.counts?.breaks ?? breaks.filter((b) => b.level !== "note").length;
    const notesOnly = !realN && noteN;
    const breakBar = breaks.length
      ? `<div class="bbreakbar${errs ? " haserr" : notesOnly ? " ok" : ""}">
           <b>${realN
              ? `${realN} continuity break${realN === 1 ? "" : "s"}`
              : "No continuity breaks."}</b>
           ${errs ? `<span class="berr">${errs} already wrong</span>` : ""}
           ${noteN ? `<span class="bnotecount">${noteN} note${noteN === 1 ? "" : "s"}</span>` : ""}
           <span class="hint">click one to light up what it is about${
             noteN ? " — a note is not something to fix, it is what the picture does not say" : ""}</span>
         </div>
         <ul class="bbreaks">${breaks.map((b, i) => `
           <li class="bbreak ${esc(b.level)}" data-break="${i}">
             <span class="bkindtag">${esc(b.kind)}</span>
             <b>${esc(b.where)}</b>
             <span>${esc(b.msg)}</span>
           </li>`).join("")}</ul>`
      : checked
        ? `<div class="bbreakbar ok"><b>No continuity breaks.</b>
             <span class="hint">every reference on every board resolves to a rendered sheet</span></div>`
        : "";

    /* ── THE BANNER, ABOVE EVERYTHING ────────────────────────────────────────
     * It goes first because it changes how the whole picture must be READ, and
     * a caveat under a canvas is a caveat nobody reaches. This is the sentence
     * the map owed its reader: on some projects half of what it draws is
     * bookkeeping, and it says so rather than letting green mean handed-over. */
    const banner = model.banner
      ? `<div class="bnote"><b>${esc(model.banner.head)}</b> ${esc(model.banner.body)}</div>` : "";

    host.innerHTML = `
      ${banner}
      <div class="bbar">
        <span class="btoggle">
          <button data-bview="timeline" ${view === "timeline" ? 'class="on"' : ""}>Timeline</button>
          <button data-bview="relations" ${view === "relations" ? 'class="on"' : ""}>Relations</button>
        </span>
        ${legend}
        <span class="hint bscroll">scroll right = later in the ${esc(model.orderNoun || "song")} →</span>
      </div>
      ${sel ? `<div class="bselbar">showing <b>${esc(selLabel)}</b>
         <button class="edtool sm" data-bclear>show everything</button></div>` : ""}
      <div class="bscrollbox">
        <div class="bcanvas" style="width:${width}px;height:${height}px">
          <svg class="bsvg" width="${width}" height="${height}">${svg}</svg>
          ${labels}
          ${nodes}
        </div>
      </div>
      ${breakBar}
      ${model.note ? `<p class="hint">${esc(model.note)}</p>` : ""}`;

    host.querySelectorAll("[data-bview]").forEach((b) => {
      b.onclick = () => { view = b.dataset.bview; draw(); };
    });
    /* A break lights the nodes it NAMES. The server already worked out which
     * rows and scenes each finding is about, so the page never re-derives it —
     * which is why the highlight cannot disagree with the sentence beside it. */
    host.querySelectorAll("[data-break]").forEach((li) => {
      li.onclick = () => {
        const b = breaks[Number(li.dataset.break)];
        if (!b) return;
        const keys = (b.nodes || []).filter((k) => nodeByKey.has(k));
        if (!keys.length) return;
        pick(keys, `${b.kind} · ${b.where}`);
        host.querySelector(".bscrollbox")?.scrollTo({
          left: Math.max(0, (nodeByKey.get(keys[0]).x || 0) - 180), behavior: "smooth" });
      };
    });
    const clear = host.querySelector("[data-bclear]");
    if (clear) clear.onclick = () => { sel = null; selLabel = ""; draw(); model.onSelect?.(null); };
    host.querySelectorAll(".bnode").forEach((b) => {
      b.onclick = () => {
        const n = nodeByKey.get(b.dataset.key);
        pick([b.dataset.key], n?.label || b.dataset.key);
        model.onSelect?.(sel ? n : null);
      };
    });
  }
  draw();
}

/* ───────────────────────── model builders ───────────────────────── */

/**
 * The SERVER's relationship map → this painter's model.
 *
 * ⚠ THIS USED TO BUILD ITS OWN GRAPH from the project document, and that was
 * the bug. There were two builders — this one for the page, crimeBoard() for
 * mv_crime_board — walking the same document to different answers: neither drew
 * props, and only the server's knew about staleness. So the map a person looked
 * at and the map an agent read disagreed about a project's continuity, which is
 * worse than either being absent, because a map that omits the failure reads as
 * confirmation that there isn't one.
 *
 * Now the server owns the graph AND the findings, and this function is an
 * adapter: lanes, columns and links come down already decided, and all that
 * happens here is turning file names into URLs and picking glyphs. A finding
 * added to crimeBoard() appears on this page in the same edit, with no second
 * rule to keep in step.
 *
 * @param board  the crime_board payload: { lanes, nodes, edges, breaks, counts }
 */
export function mvBoardModel(board, assetUrl) {
  const GLYPH = { character: "C", prop: "P", background: "B", board: "S", clip: "▶" };
  const nodes = (board.nodes || []).map((n) => ({
    key: n.id, lane: n.lane, col: n.col, group: n.group,
    /* A ghost has no row of its own, so it is labelled as the thing that is
     * missing rather than as a thing that exists. */
    label: n.ghost ? `${n.label}?` : n.label,
    glyph: GLYPH[n.kind] || n.kind[0].toUpperCase(),
    status: n.status,
    /* Clips play from the clips library; everything else is a project asset.
     * A ghost never has a picture — that is what makes it a ghost. */
    video: n.kind === "clip" && n.file ? `/api/clip/${encodeURIComponent(n.file)}` : null,
    thumb: n.kind !== "clip" && n.file ? assetUrl(n.file) : null,
    flags: n.flags || [], ghost: !!n.ghost,
    usedIn: n.usedIn || [],
  }));
  /* ── NAMED, NOT SENT ──────────────────────────────────────────────────────
   *
   * `carried` marks an edge the clip's own take recorded as a reference. It has
   * been written unconditionally, from the take's `refs`, without asking
   * whether the render was actually HANDED them — and on a project set to the
   * ltx engine it never is: resolveShot works out `refsSent` and comes back
   * false on every one of them. So the map drew a solid line from a face to a
   * clip that was rendered from words alone. That is the one thing this screen
   * is not allowed to do.
   *
   * Two sources, in that order. `sent` is the server's own answer, per edge,
   * and is believed whenever it is present — it knows about cases this cannot
   * see (cast references switched off, a scene carrying no cast at all).
   *
   * The fallback asks the CLIP NODE what it actually rendered on, and that is a
   * better question than the project's videoEngine setting even though the
   * setting was the obvious place to look: "hybrid" renders some scenes on h3
   * and some on ltx, so a project-wide answer would dash edges into clips that
   * really were handed their sheets, and reassure about clips that were not.
   * The engine recorded on the clip is what happened. When every running build
   * emits `sent`, this stops firing on its own and can be deleted; until then a
   * page that reloads without an app restart still tells the truth. */
  const BLIND = new Set(["ltx"]);          // engines with no named-reference input
  const clipEngine = new Map((board.nodes || [])
    .filter((n) => n.kind === "clip")
    .map((n) => [n.id, String(n.engine || "").toLowerCase()]));
  const blindClips = [...clipEngine.values()].filter((e) => BLIND.has(e)).length;
  let notSentCount = 0;
  const links = (board.edges || []).map((e) => {
    const notSent = e.sent === false
      || (e.sent === undefined && e.carried === true && BLIND.has(clipEngine.get(e.to)));
    if (notSent) notSentCount++;
    return {
      a: e.from, b: e.to, type: e.type, group: e.group, broken: !!e.broken,
      notSent,
      why: e.why || (notSent
        ? "named in the prompt as <Picture N>, and not handed to the video model"
        : ""),
    };
  });

  const legend = [{ color: TYPE_COLORS.character, label: "character" },
                  { color: TYPE_COLORS.prop, label: "prop" },
                  { color: TYPE_COLORS.background, label: "background" },
                  { color: TYPE_COLORS.board, label: "board → clip" },
                  { color: BREAK_COLOR, label: "continuity break" }];
  if (notSentCount) {
    legend.push({ color: NOTSENT_COLOR, label: "named, not sent", dash: true,
      title: "The shot resolved this reference and wrote it into the prompt. The video "
        + "model was not given the picture." });
  }

  /* The banner's sentence, built in one place rather than inside the object
   * literal — the counts change three words in it and a nested conditional
   * template is unreadable the day after it is written. */
  const one = notSentCount === 1;
  const dashedWhy = `${blindClips} of the clips here rendered on ltx, which has no `
    + "named-reference input"
    + (notSentCount
        ? `, so the ${notSentCount} dashed grey edge${one ? "" : "s"} into them `
          + `${one ? "was" : "were"} NAMED and not sent`
        : "")
    + ". The board image pinned as frame 0 is the only carrier of identity there — which is "
    + "why a board drawn before a prop existed loses that prop for good, however green this "
    + "map goes. The cast → board edges are real: that is where the sheets are genuinely used.";

  return {
    lanes: board.lanes || [],
    nodes, links,
    breaks: board.breaks || [],
    /* THE SERVER'S OWN TALLY, carried rather than recomputed. crimeBoard already
     * separates a note from a break and counts each; the bar reads these when
     * they are here and falls back to the list when an older payload has none.
     * Two rules over one array is how a count and the list under it start
     * disagreeing about the same project. */
    counts: board.counts || null,
    legend,
    /* The server's own sentence wins if it sends one — it is closer to the
     * decision and can be more specific than a reading of the clip rows. */
    banner: board.note ? { head: "Read this map with one caveat:", body: board.note }
      : blindClips ? { head: "Sheets do not reach the video model on this project.", body: dashedWhy }
      : null,
    groupNoun: "clip", orderNoun: "song",
  };
}

/** Audiobook project doc → board model. Wide books show a window of columns —
 * the chapter manager is the complete inventory, the board is the map. */
export function abBoardModel(doc, { maxCols = 80 } = {}) {
  const nodes = [], links = [];
  const bundles = (doc.bundles || []).slice(0, maxCols);
  const truncated = (doc.bundles || []).length - bundles.length;

  // voices: the narrator plus every cast member, one column each
  const voices = [{ key: "v_narr", label: doc.voice ? `${doc.voice.persona}` : "narrator", who: null }];
  for (const c of doc.cast || []) {
    if (c.voice?.persona) voices.push({ key: `v_${c.name}`, label: `${c.name}`, who: c });
  }
  voices.forEach((v, i) => nodes.push({
    key: v.key, lane: "voice", col: i, label: v.label, glyph: "V",
    status: doc.voice ? "done" : "pending",
  }));

  (doc.beds || []).forEach((bed, i) => nodes.push({
    key: `bed_${bed.id}`, lane: "ambient", col: i, label: `${bed.mood} bed`, glyph: "A",
    status: "done", sub: `${bed.seconds || "?"}s`,
  }));
  // distinct rendered sfx labels share the ambient lane, after the beds
  const sfxLabels = new Map();
  for (const b of bundles) for (const fx of b.sfx || []) {
    if (!sfxLabels.has(fx.label)) sfxLabels.set(fx.label, []);
    sfxLabels.get(fx.label).push(b.idx);
  }
  [...sfxLabels.keys()].forEach((label, i) => nodes.push({
    key: `sfx_${label}`, lane: "ambient", col: (doc.beds || []).length + i,
    label: `⚡ ${label}`, glyph: "S", status: "done",
  }));

  for (const [bi, b] of bundles.entries()) {
    nodes.push({ key: `bu_${b.idx}`, lane: "bundle", col: bi,
      label: b.title || `Bundle ${b.idx + 1}`, glyph: "F",
      sub: `${b.estMinutes}m`, status: b.status || "planned", group: bi });

    (b.chapterIdxs || []).forEach((ci, j) => {
      const ch = doc.book?.chapters?.[ci];
      if (!ch) return;
      nodes.push({ key: `ch_${ci}`, lane: "chapter", col: bi, label: ch.title, glyph: "C",
        status: ch.skip ? "skipped" : (b.status === "mixed" ? "done" : b.status === "narrated" ? "narrated" : "planned"),
        group: bi });
      if (j === 0) links.push({ a: `ch_${ci}`, b: `bu_${b.idx}`, type: "chapter", group: bi });
    });

    if (b.bedId && (doc.beds || []).some((x) => x.id === b.bedId)) {
      links.push({ a: `bed_${b.bedId}`, b: `bu_${b.idx}`, type: "bed", group: bi });
    }
    const used = new Set((b.narration || []).map((n) => n.voice).filter(Boolean));
    links.push({ a: "v_narr", b: `bu_${b.idx}`, type: "voice", group: bi });
    for (const v of voices.slice(1)) {
      if (used.has(v.who?.voice?.persona)) links.push({ a: v.key, b: `bu_${b.idx}`, type: "voice", group: bi });
    }
    for (const fx of b.sfx || []) links.push({ a: `sfx_${fx.label}`, b: `bu_${b.idx}`, type: "sfx", group: bi });
  }

  return {
    lanes: [{ key: "voice", label: "voices" }, { key: "ambient", label: "beds · sfx" },
            { key: "chapter", label: "chapters" }, { key: "bundle", label: "files" }],
    nodes, links,
    legend: [{ color: TYPE_COLORS.voice, label: "voice → file" },
             { color: TYPE_COLORS.bed, label: "bed → file" },
             { color: TYPE_COLORS.sfx, label: "sfx → file" },
             { color: TYPE_COLORS.chapter, label: "chapter → file" }],
    groupNoun: "file", orderNoun: "book",
    note: truncated > 0 ? `showing the first ${bundles.length} of ${(doc.bundles || []).length} files — the chapter manager lists everything` : "",
  };
}
