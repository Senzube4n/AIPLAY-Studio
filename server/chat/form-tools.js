/**
 * THE IMAGES AND VIDEO PANELS' "SIMPLE" ASSISTANTS — the same idea as the Music
 * panel's (music-tools.js), for a form that is much wider and changes shape
 * with its engine.
 *
 * So the tools are generic rather than one argument per control: the page sends
 * EVERY control of its form (web/assist.js) — id, label, current value, the
 * allowed values of a dropdown with the ones that cannot be used marked, a
 * number's range, and whether the control is showing for the current engine —
 * and `set_form` changes any of them by id. The assistant can therefore do
 * anything a person can do with the panel, including controls added after this
 * file was written, and a value the panel would not accept is refused here with
 * the allowed ones named.
 *
 * `generate` SPENDS and ENDS THE TURN, as in the Music panel: it is the page
 * pressing the panel's own Make button, and it runs as soon as it is called
 * with a warning and Cancel on the page (loop.js "GO, WITH A WARNING").
 *
 * Arguments are flat strings, because the loop refuses nested ones: the
 * changes are one "field = value" per line.
 */

import { guideLines } from "./model-guides.js";

const str = (v) => (v === undefined || v === null ? "" : String(v));

const KIND = {
  image: {
    noun: "image", panel: "Images", button: "Make image",
    craft: [
      "WRITING THE DESCRIPTION. One strong paragraph: the subject first, then what it is doing, the setting,",
      "the light, the composition and camera (angle, lens, depth of field), and the look (photo, painting,",
      "anime, 3D…). Concrete nouns and visible details, not feelings. Put words that must appear in the",
      "picture in quotes. Pick an engine that suits the look (anime → an anime model when installed) and a",
      "size that suits the shot (portrait for a person, wide for a landscape).",
      "FAST DRAFT (imgDraft, Qwen Image 2.1 only, when it is on the screen): about 3x quicker, but it may garble",
      "small text and add extra faces or fingers. Tick it for drafts, storyboards, thumbnails and quick variations;",
      "leave it off for words in the picture, crowds, close hands, two-reference style edits and a final picture.",
      "If it is marked fixed, tell them the reason given beside it; it is not the engine.",
    ],
  },
  video: {
    noun: "video clip", panel: "Video", button: "Render clip",
    craft: [
      "WRITING THE DESCRIPTION. A picture that moves: ONE subject, ONE clear action and ONE camera move",
      "(slow push in, pan left, orbit, static). Say what moves and how, the setting, the light and the look.",
      "A busy shot with many actions comes out as mush. To make a clip that starts from a picture, choose",
      "it in the starting-frame dropdown (a cover from the Library); a seamless loop ends where it starts.",
      "Keep length and size modest unless they ask: longer and bigger clips take much longer.",
      /* The REWIND A/B of 2026-09-24 (DIRECTING.md §2): the two things a newcomer
       * cannot recover afterwards, so the assistant raises them. */
      "KEEPING A PERSON. If the clip shows someone who must look the same as in other clips, set vidCharacter to",
      "their saved character (its options list them). With none saved, tell them 1–3 pictures of that person keep",
      "them the same (the Keep my character box takes them) and ask for them; never claim it is kept without",
      "pictures. Name each dropped picture in the description (\"<Picture 1> is Mira.\") and the character where",
      "they act. If they sing, set vidSndSong to the song and vidSndStart to where the sung line starts: on MiniMax",
      "H3 with pictures of the singer that is lip-sync (on LTX mouths do not follow it). A sound reference re-sings",
      "instead. Shots with no one in them need neither, and Fast is fine for them.",
    ],
  },
};

export function formIntro(kind) {
  const k = KIND[kind] || KIND.image;
  return [
    `You are the ${k.noun} assistant inside the ${k.panel} panel of AIPLAY Studio, running on this person's own`,
    `computer. You can do two things: set up the ${k.panel} form (set_form: the description and ANY setting`,
    `on the screen, by its field id) and make the ${k.noun} (generate, which presses "${k.button}").`,
    "You cannot reach the library, music or anything else — if asked, say so.",
    "",
    `WHEN THEY DESCRIBE A ${k.noun.toUpperCase()}: write the description and choose the settings that suit it, in ONE`,
    "set_form call. If they asked for it to be made (\"make\", \"generate\", \"go\"), call generate right after.",
    "When they ask to change something (\"brighter\", \"wider\", \"use Z-Image\", \"more steps\"), change just that.",
    "",
    "THE SCREEN lists every field: its id, its label, its current value, and for a dropdown the allowed",
    "values — use the value before the = sign. A value marked UNAVAILABLE is not installed or cannot be used",
    "here: never choose it, and say why if they asked for it. A field marked (hidden) belongs to another engine",
    "or option; it shows once that is chosen, and can be set in the same set_form after the line that chooses it.",
    "RENDERS on the screen says what is running and what failed and why: when something failed, tell them in",
    "plain words what failed, why, and what would fix it.",
    "HOW TO PROMPT on the screen is written for the model chosen right now. Write the description the way it says;",
    "when you switch the model, the next screen has the new model's rules: write for that one.",
    "",
    ...k.craft,
  ];
}

/** "id = value" lines → [[id, value]]; blank lines and "#" notes are skipped. */
export function parseChanges(text) {
  const out = [];
  for (const raw of str(text).replace(/\r\n/g, "\n").split(/\n|;(?=\s*[A-Za-z][\w-]*\s*[=:])/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
    if (!m) throw new Error(`"${line.slice(0, 60)}" is not "field = value".`);
    out.push([m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]);
  }
  return out;
}

const truthy = (v) => /^(1|true|yes|on|checked|tick(ed)?)$/i.test(str(v).trim());
const falsy = (v) => /^(0|false|no|off|unchecked|untick(ed)?)$/i.test(str(v).trim());

/** One requested value, checked against the field it is for. Returns the value the page should set. */
export function checkValue(field, value) {
  const v = str(value).trim();
  /* `why`: the page's own reason for a locked field (web/assist.js reads
   * data-why), e.g. Fast draft greyed by Transparent; the engine is not it. */
  if (field.fixed && field.why) throw new Error(`${field.id} cannot be changed right now (now ${str(field.value)}): ${str(field.why)}`);
  if (field.fixed) throw new Error(`${field.id} is fixed by this engine (now ${str(field.value)}); choose another engine to change it.`);
  if (field.type === "select") {
    const opts = Array.isArray(field.options) ? field.options : [];
    const lc = v.toLowerCase();
    const hit = opts.find((o) => str(o.v) === v) || opts.find((o) => str(o.v).toLowerCase() === lc)
      || opts.find((o) => str(o.t).toLowerCase() === lc)
      || (lc ? opts.find((o) => str(o.t).toLowerCase().includes(lc)) : null);
    if (!hit) {
      throw new Error(`${field.id} has no choice "${v}". Its choices: ${opts.filter((o) => !o.off).map((o) => `${o.v}=${str(o.t).slice(0, 40)}`).join(", ") || "none"}.`);
    }
    if (hit.off) throw new Error(`${field.id}: "${str(hit.t) || hit.v}" is UNAVAILABLE here${hit.why ? ` (${hit.why})` : ""}. Choose another.`);
    return str(hit.v);
  }
  if (field.type === "checkbox") {
    if (truthy(v)) return true;
    if (falsy(v)) return false;
    throw new Error(`${field.id} is a tick box: use true or false.`);
  }
  if (field.type === "number" || field.type === "range") {
    const n = Number(v.replace(/[^\d.+-]/g, ""));
    if (!v || !Number.isFinite(n)) throw new Error(`${field.id} takes a number${field.min !== undefined ? ` from ${field.min} to ${field.max}` : ""}.`);
    let x = n;
    if (Number.isFinite(field.min)) x = Math.max(field.min, x);
    if (Number.isFinite(field.max)) x = Math.min(field.max, x);
    return x;
  }
  return v;
}

export function createFormTools(kind = "image") {
  const k = KIND[kind] || KIND.image;
  let screen = null;
  const TOOLS = [
    {
      name: "set_form",
      spends: false,
      description:
        `Changes the ${k.panel} form: the description and any setting on the screen, by field id. It does NOT `
        + `make anything; call generate for that. Give the description in prompt, and every other change in `
        + `changes, one "field = value" per line, in the order they should happen (choose an engine before its `
        + `own settings).`,
      args: {
        prompt: { type: "string", note: `The full description of the ${k.noun}. Leave out to keep the one on the screen.` },
        changes: { type: "string", note: 'One "field_id = value" per line, e.g. "imgEngine = zimage". Values from the screen.' },
      },
      async run(a) {
        const f = screen || {};
        const fields = Array.isArray(f.fields) ? f.fields : [];
        const byId = new Map(fields.map((x) => [x.id, x]));
        const byLabel = new Map(fields.map((x) => [str(x.label).toLowerCase(), x]));
        const set = {};
        const said = [];
        const prompt = a.prompt !== undefined ? str(a.prompt).replace(/\r\n/g, "\n").trim() : null;
        if (prompt !== null && f.promptField) { set[f.promptField] = prompt; said.push("the description"); }
        for (const [name, value] of parseChanges(a.changes)) {
          const field = byId.get(name) || byLabel.get(name.toLowerCase());
          if (!field) {
            throw new Error(`There is no field "${name}" on the screen. Fields: ${fields.map((x) => x.id).join(", ")}.`);
          }
          if (field.id === f.promptField && prompt !== null) continue;
          const v = checkValue(field, value);
          set[field.id] = v;
          said.push(`${field.label || field.id} → ${typeof v === "boolean" ? (v ? "on" : "off") : str(v).slice(0, 40)}`);
        }
        if (!said.length) throw new Error("Give a prompt, or changes as \"field = value\" lines.");
        return { form: { fields: set }, changed: said.join(", "), note: `Set in the ${k.panel} panel. Nothing is being made yet.` };
      },
    },
    {
      name: "generate",
      spends: true,
      endsTurn: true,
      cost: "the graphics card for a while (seconds for an image, minutes for a clip), and it holds the card while it runs",
      description:
        `Presses "${k.button}": makes the ${k.noun} the form describes now, with its settings. Call it only when `
        + "the form has a description and the person wants it made.",
      args: {},
      async run() {
        return { action: "generate", say: `Pressing "${k.button}" now; the line below says whether it started.` };
      },
    },
  ];
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return {
    all: TOOLS,
    setScreen: (s) => { screen = s && typeof s === "object" ? s : null; },
    names: TOOLS.map((t) => t.name),
    get: (n) => byName.get(String(n)) || null,
    spending: TOOLS.filter((t) => t.spends).map((t) => t.name),
    routed: [],
  };
}

/** What the model reads as "the screen". */
export function describeScreen(f, kind = f?.kind) {
  if (!f || typeof f !== "object") return null;
  const clip = (s, n) => { const t = str(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const lines = [];
  const fields = Array.isArray(f.fields) ? f.fields.slice(0, 90) : [];
  const shown = (x) => (x.hidden ? " (hidden)" : x.fixed ? (x.why ? ` (fixed: ${clip(x.why, 200)})` : " (fixed by this engine)") : "");
  lines.push("FIELDS (id · label · value):");
  for (const x of fields) {
    let line = `- ${x.id} · ${clip(x.label, 50) || "?"}${shown(x)} · `;
    if (x.type === "select") {
      const opts = Array.isArray(x.options) ? x.options.slice(0, 40) : [];
      line += `now ${clip(x.value, 60) || "(none)"} · choices: ${opts.map((o) => `${clip(o.v, 50)}=${clip(o.t, 50)}${o.off ? ` UNAVAILABLE${o.why ? ` (${clip(o.why, 60)})` : ""}` : ""}`).join("; ")}`;
    } else if (x.type === "checkbox") {
      line += `tick box, ${x.value ? "on" : "off"}`;
    } else if (x.type === "number" || x.type === "range") {
      line += `now ${x.value} · number ${x.min ?? "?"} to ${x.max ?? "?"}${x.step ? ` step ${x.step}` : ""}`;
    } else {
      line += `text: ${clip(x.value, x.id === f.promptField ? 600 : 160) || "(empty)"}`;
    }
    lines.push(line);
  }
  if (f.promptField) lines.push(`(the description is field ${f.promptField})`);
  if (kind === "image" || kind === "video") lines.push("", ...guideLines(kind, fields));
  if (f.button) lines.push(`make button: ${f.button.ready ? "ready" : `NOT ready${f.button.why ? ` — ${clip(f.button.why, 160)}` : ""}`}`);
  const r = f.renders && typeof f.renders === "object" ? f.renders : null;
  if (r) {
    lines.push("", "RENDERS:");
    lines.push(r.running ? `- running now: ${clip(r.running, 200)}` : "- nothing of this kind running now");
    if (r.queued) lines.push(`- waiting in the queue: ${r.queued}`);
    for (const x of Array.isArray(r.recent) ? r.recent.slice(0, 4) : []) lines.push(`- ${clip(x, 300)}`);
    if (r.note) lines.push(`- panel says: ${clip(r.note, 300)}`);
  }
  return lines.join("\n");
}

/** A tool's patch, applied to the snapshot so the rest of the turn sees it. */
export function applyScreenPatch(f, patch) {
  if (!f || !patch?.fields) return f;
  for (const [id, v] of Object.entries(patch.fields)) {
    const x = (f.fields || []).find((y) => y.id === id);
    if (x) x.value = v;
  }
  return f;
}

export default createFormTools;
