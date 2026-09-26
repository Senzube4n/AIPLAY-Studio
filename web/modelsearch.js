/**
 * THE MODELS SCREEN'S SEARCH, under "For this machine".
 *
 * Typing hides every catalogue row that does not match and every section left
 * with none. `#tags` narrow to a section (#music, #video, #images, #3d, #chat)
 * or a state (#ready, #missing); every other word must appear in the row's
 * name, id, licence or one of its file names. Not its notes: they mention
 * other models ("faster than H3"), and "h3" found LTX. "#video h3" is the
 * H3 rows of the Video section.
 *
 * It filters what web/app.js already painted and fetches nothing. The list is
 * repainted on every download tick, so app.js calls paintSearch() after each
 * paint and the filter is put back on the fresh rows.
 *
 * Sections are opened while a search shows rows in them and put back as the
 * person left them when the search is cleared. `data-searching` on the list
 * tells app.js's toggle listener not to save those openings as a choice.
 */

/* Tag words people reach for, to the section ids server/index.js sends in
 * `groups`. A tag not listed here is matched as a plain word (#whisper). */
const GROUP_TAGS = {
  music: "music", audio: "music", song: "music", songs: "music", sound: "music", lyrics: "music",
  image: "images", images: "images", picture: "images", pictures: "images", pic: "images", art: "images", cover: "images", covers: "images",
  video: "video", videos: "video", clip: "video", clips: "video",
  "3d": "3d", mesh: "3d",
  chat: "chat", writing: "chat", text: "chat", llm: "chat",
};
const STATE_TAGS = { ready: true, installed: true, missing: false, download: false };

/** Split a query into the sections, the state and the words it asks for. */
export function parseQuery(q) {
  const groups = new Set();
  const words = [];
  let ready = null;
  for (const raw of String(q || "").toLowerCase().split(/\s+/).filter(Boolean)) {
    const tag = raw.startsWith("#") ? raw.slice(1) : null;
    if (tag && GROUP_TAGS[tag]) groups.add(GROUP_TAGS[tag]);
    else if (tag && tag in STATE_TAGS) ready = STATE_TAGS[tag];
    else if (tag) words.push(tag);
    else words.push(raw);
  }
  return { groups, words, ready };
}

/** Everything a row can be found by, lower case. */
function haystack(c) {
  return [c.id, c.label, c.licence,
    ...(c.files || []).map((f) => f.name), ...(c.variants || []).map((v) => v.label)]
    .filter(Boolean).join(" ").toLowerCase();
}

/** Whether one capability row matches a parsed query. */
export function matches(c, p) {
  if (p.groups.size && !p.groups.has(c.group || "music")) return false;
  if (p.ready !== null && !!c.ready !== p.ready) return false;
  if (!p.words.length) return true;
  const h = haystack(c);
  return p.words.every((w) => h.includes(w));
}

let last = null;          // the payload app.js last painted
let getOpen = () => new Set();

function ensureBox(root) {
  let box = root.getElementById("modelSearch");
  const list = root.getElementById("modelList");
  if (!list) return null;
  if (!box) {
    box = root.createElement("div");
    box.id = "modelSearch";
    box.className = "msearch";
    box.innerHTML = `<input type="search" class="line" id="modelSearchIn" spellcheck="false" autocomplete="off"
        placeholder="Search models, e.g. #video h3" aria-label="Search models">
      <span class="hint" id="modelSearchNote" role="status" aria-live="polite"></span>`;
    box.querySelector("input").addEventListener("input", () => filter(root));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && e.target.value) { e.target.value = ""; filter(root); }
    });
  }
  /* Directly under "For this machine", above the list. */
  if (box.nextElementSibling !== list) list.parentNode.insertBefore(box, list);
  return box;
}

function filter(root) {
  const list = root.getElementById("modelList");
  const input = root.getElementById("modelSearchIn");
  const note = root.getElementById("modelSearchNote");
  if (!list || !input || !last) return 0;
  const q = input.value.trim();
  const p = parseQuery(q);
  const byId = Object.fromEntries((last.capabilities || []).map((c) => [c.id, c]));
  let shown = 0;
  for (const card of list.querySelectorAll(".modelcard[data-cap]")) {
    const c = byId[card.dataset.cap];
    const ok = !q || (c ? matches(c, p) : false);
    card.hidden = !ok;
    if (ok) shown++;
  }
  const open = getOpen();
  if (q) list.dataset.searching = "1";
  else delete list.dataset.searching;
  for (const g of list.querySelectorAll("details.mgroup")) {
    const any = !!g.querySelector(".modelcard[data-cap]:not([hidden])");
    g.hidden = !!q && !any;
    const want = q ? any : open.has(g.dataset.mgroup);
    if (g.open !== want) g.open = want;
  }
  note.textContent = !q ? "" : shown ? `${shown} match${shown === 1 ? "" : "es"}` : "No model matches.";
  return shown;
}

/**
 * Called by web/app.js after every paint of #modelList, with the payload it
 * painted and a reader for the sections the person left open.
 */
export function paintSearch(d, opts = {}, root = document) {
  last = d;
  if (opts.getOpen) getOpen = opts.getOpen;
  if (!ensureBox(root)) return;
  filter(root);
}

/**
 * Put a query in the box and show what it finds: the Pre-Configure picks use
 * it to point at a model that is not installed. Scrolls to and flashes `focus`
 * (a capability id) when it is among the results. Returns how many matched.
 */
export function searchModels(q, focus = null, root = document) {
  const input = root.getElementById("modelSearchIn");
  if (!input) return 0;
  input.value = q;
  const n = filter(root);
  const card = focus && root.querySelector(`#modelList [data-cap="${CSS.escape(focus)}"]`);
  const target = card && !card.hidden ? card : root.getElementById("modelSearch");
  target?.scrollIntoView({ behavior: "smooth", block: card ? "center" : "start" });
  if (card && !card.hidden) {
    card.classList.remove("fitflash");
    void card.offsetWidth;
    card.classList.add("fitflash");
  }
  return n;
}

/** The query that finds one row: its section tag and its name. */
export function queryFor(c) {
  const tag = { music: "music", images: "images", video: "video", "3d": "3d", chat: "chat" }[c?.group || "music"] || "music";
  return `#${tag} ${modelName(c)}`;
}

/** A row's model name without its section and its bracket:
 *  "Images — Krea 2 Turbo (community licence)" is "Krea 2 Turbo". */
export function modelName(c) {
  const label = String(c?.label || c?.id || "");
  const tail = label.split(/\s[—–-]\s/).pop();
  return tail.replace(/\([^)]*\)/g, " ").replace(/[·]/g, " ").replace(/\s+/g, " ").trim() || label;
}
