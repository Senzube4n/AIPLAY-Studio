/**
 * Did the picture come back with what was asked for?
 *
 * A guitar with five strings. A hand with six fingers, or four. Text that is
 * nearly words. These are the characteristic failures of image models, and this
 * app could not see any of them: it asked ComfyUI for a file, got a file, and
 * called that success. image_analyze measures brightness, chroma and clipping —
 * real measurements, and none of them can tell you how many strings are on a
 * guitar. The gap is not in the measuring, it is that nothing ever LOOKED.
 *
 * WHAT THIS FILE CAN AND CANNOT DO, because the distinction is the whole design.
 * It cannot judge. There is no vision model on this machine, and adding one
 * would break the local-first premise the same way a cloud LLM would in
 * prompts.js. What it can do is make the judging possible and make it stick:
 *
 *   1. HAND OVER THE PIXELS. MCP carries image content natively and this app
 *      only ever returned text, so an agent driving it was blind to its own
 *      output. mcp.js now emits image blocks; this file prepares them.
 *   2. REMEMBER WHAT WAS ASKED. A render records an `expect` checklist in the
 *      words of whoever wanted it — "six strings", "both hands visible". Vague
 *      is fine. It exists so the check runs against an INTENTION rather than
 *      against a fresh look at the picture, which tends to approve whatever it
 *      happens to see.
 *   3. RECORD WHAT WAS SEEN. A verdict names which expectations failed, goes in
 *      the provenance ledger as a judge event, and stays attached to the image.
 *
 * VERDICTS GO STALE, and that is not a detail. Every edit in this app writes a
 * new file, but a re-render can reuse a name, and a verdict that silently
 * vouched for a different picture would be worse than no verdict at all. So a
 * verdict fingerprints the bytes it was given (size and mtime) and reports
 * "stale" the moment they move. The same applies when the checklist grows: a
 * pass on three expectations is not a pass on five.
 *
 * The default state is UNCHECKED, never "fine". Nothing here assumes a picture
 * is good because no one has complained about it yet.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_ENTRIES = 4000;
const MAX_EXPECT = 24;

const norm = (s) => String(s ?? "").trim();

/** The checklist, cleaned: no blanks, no duplicates, bounded. */
export function cleanExpect(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = norm(raw).slice(0, 200);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_EXPECT) break;
  }
  return out;
}

/**
 * A checklist proposed from the prompt.
 *
 * Writing expectations is the step people skip, and skipping it is what makes a
 * render "fine" by default. So the obvious ones are offered for free, drawn
 * from what image models measurably get wrong rather than from what would be
 * nice to check: countable parts, anatomy at close range, and lettering.
 *
 * WHAT THIS IS NOT. It is not a judgement and cannot become one — nothing here
 * looks at a picture. It is a prompt read for the failure modes it invites, and
 * the list it returns is a starting point to edit, which is why the UI puts it
 * in a textarea rather than a set of fixed rules. A suggestion that cannot be
 * deleted would be a rule pretending to be help.
 *
 * The patterns are deliberately few. A long list of weak guesses trains people
 * to clear the whole thing without reading it, and then the checklist is worse
 * than nothing because it looks like diligence.
 */
const RISKS = [
  /* Close-range anatomy is the single biggest source of "the file exists and
   * it is wrong". The hint names what to count rather than asserting a hand is
   * in frame — at a distance the same prompt is perfectly safe, and a checklist
   * that cries wolf gets cleared without reading. */
  [/\b(hands?|fingers?|fist|palm|grip|gripping|holding|playing|typing|writing)\b/i,
   "hands: four fingers and a thumb each, individually distinct — no fused or extra digits"],
  /* "mountain face", "cliff face", "rock face" — the first version of this
   * suggested checking the eyes on a mountain, which is how a checklist teaches
   * people to ignore it. The lookbehind is cheap and the list of things that
   * have a face without having eyes is short. */
  [/\b((?<!mountain |cliff |rock |stone |brick |wall |north |south |east |west |clock |watch )face|portrait|eyes|smiling|teeth)\b/i,
   "face: eyes matched and level, teeth and ears plausible"],
  /* Countable parts. An instrument with the wrong string count reads as wrong
   * to anyone who plays and is invisible to everyone who does not — exactly the
   * kind of defect that ships. */
  [/\b(guitars?|guitarist)\b/i, "six strings, and the same count along the whole neck"],
  [/\bbass(\s+guitar)?\b/i, "four strings on the bass"],
  [/\b(violin|viola|cello|fiddle)\b/i, "four strings, and a bow held plausibly"],
  [/\b(piano|keyboard|synth|synthesiser|synthesizer)\b/i,
   "black keys in alternating groups of two and three"],
  [/\b(drum kit|drums|drummer|cymbals?)\b/i,
   "drum hardware connects — a stand under every drum, no floating cymbals"],
  [/\b(clocks?|watch|wristwatch)\b/i, "clock face: numerals in order, hands attached at the centre"],
  [/\b(bicycles?|bikes?|motorcycles?|wheels?|cars?|trucks?)\b/i,
   "wheels round, spokes even, and both sides of the vehicle agree"],
  [/\b(stairs|staircase|steps|ladder)\b/i, "the stairs actually connect the two levels"],
  [/\b(mirror|reflections?|reflected)\b/i, "the reflection shows what is in front of it"],
  /* Lettering. Models produce confident nonsense, and on a cover or a poster it
   * is the first thing a viewer's eye lands on. */
  [/\b(signs?|signage|text|lettering|logos?|labels?|posters?|billboard|title|album cover|books?|newspaper)\b/i,
   "no invented or garbled lettering — any text is readable and correct, or absent"],
  [/\b(crowd|audience|people|figures|band)\b/i,
   "background figures have plausible bodies — count the limbs on the nearest few"],
];

export function suggestExpect(prompt) {
  const p = String(prompt || "");
  const out = [];
  for (const [re, hint] of RISKS) if (re.test(p) && !out.includes(hint)) out.push(hint);
  return cleanExpect(out);
}

/** What the bytes were when a verdict was given, so a swap can be noticed. */
async function fingerprint(file) {
  try {
    const st = await stat(file);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch { return null; }
}

/**
 * unchecked | pass | fail | stale
 *
 * `stale` is a real answer rather than an error: the picture WAS judged, the
 * judgement no longer applies, and saying so is different from both "nobody
 * looked" and "it failed".
 */
export function reviewState(entry, current) {
  if (!entry || !entry.verdict) return "unchecked";
  const v = entry.verdict;
  if (current && v.fingerprint
      && (current.size !== v.fingerprint.size || current.mtime !== v.fingerprint.mtime)) {
    return "stale";
  }
  /* Judged against a shorter list than the one now attached: the extra
   * expectations have never been looked at. */
  const checked = Array.isArray(v.against) ? v.against.length : 0;
  if ((entry.expect || []).length > checked) return "stale";
  return v.ok ? "pass" : "fail";
}

export function createReviewStore(file) {
  /** image name -> { expect: string[], verdict: {...}|null, at } */
  let byName = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      for (const [k, v] of Object.entries(raw.reviews || {})) if (v) byName.set(k, v);
    } catch { /* no reviews yet: everything is unchecked, which is the truth */ }
  }

  async function save() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ reviews: Object.fromEntries(byName) }, null, 1));
    } catch { /* a lost review must never take a render down */ }
  }

  function trim() {
    while (byName.size > MAX_ENTRIES) byName.delete(byName.keys().next().value);
  }

  return {
    async get(name) {
      await load();
      return byName.get(name) || null;
    },

    /** What was asked for. Recorded at render time, editable after. */
    async expect(name, list) {
      await load();
      const e = byName.get(name) || { expect: [], verdict: null, at: Date.now() };
      e.expect = cleanExpect(list);
      e.updatedAt = Date.now();
      byName.set(name, e);
      trim();
      await save();
      return e;
    },

    /**
     * What was seen. `failed` names the expectations that did not hold, and it
     * is the field that matters: "it failed" is a complaint, "the string count
     * is five, not six" is something the next prompt can act on.
     */
    async verdict(name, { ok, failed = [], notes = "", by = "agent", file: imgFile } = {}) {
      await load();
      const e = byName.get(name) || { expect: [], verdict: null, at: Date.now() };
      const bad = cleanExpect(failed);
      e.verdict = {
        /* A verdict that names failures cannot also be a pass. The caller does
         * not get to say both, because a pass-with-notes is exactly how a known
         * defect travels downstream unnoticed. */
        ok: Boolean(ok) && bad.length === 0,
        failed: bad,
        notes: norm(notes).slice(0, 2000),
        by: norm(by) || "agent",
        against: [...(e.expect || [])],
        fingerprint: imgFile ? await fingerprint(imgFile) : null,
        at: Date.now(),
      };
      e.updatedAt = Date.now();
      byName.set(name, e);
      trim();
      await save();
      return e;
    },

    async clear(name) {
      await load();
      const had = byName.delete(name);
      if (had) await save();
      return had;
    },

    /** Everything known, for a screen, a gate, or a report. */
    async all() {
      await load();
      return Object.fromEntries(byName);
    },
  };
}

/**
 * The picture, small enough to send.
 *
 * Downscaled because a 4K render is megabytes of base64, and a long edge of 768
 * is plenty to count the strings on a guitar or the fingers on a hand — the
 * failures this exists to catch are gross, not subtle. JPEG rather than PNG for
 * the same reason: this is evidence to look at, not a master to edit.
 *
 * Goes through PIL, like every other image helper here, because this app
 * deliberately carries one node dependency and adding an image library to make
 * a thumbnail would be a poor trade.
 */
const THUMB_PY = [
  "import sys, io, base64",
  "from PIL import Image",
  "src, edge = sys.argv[1], int(sys.argv[2])",
  "im = Image.open(src)",
  "im = im.convert('RGB') if im.mode not in ('RGB', 'L') else im",
  "w, h = im.size",
  "if max(w, h) > edge:",
  "    s = edge / float(max(w, h))",
  "    im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)",
  "buf = io.BytesIO()",
  "im.save(buf, 'JPEG', quality=82)",
  "sys.stdout.write(base64.b64encode(buf.getvalue()).decode('ascii'))",
].join("\n");

export function makeThumbnailer(python) {
  return async function thumbnail(filePath, maxEdge = 768) {
    const edge = Math.max(256, Math.min(1536, Number(maxEdge) || 768));
    return await new Promise((resolve, reject) => {
      const proc = spawn(python, ["-c", THUMB_PY, filePath, String(edge)]);
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("error", (e) => reject(new Error(`could not run python to read the image: ${e.message}`)));
      proc.on("close", (code) => {
        if (code !== 0 || !out) {
          /* Named plainly: without Pillow the review tool cannot show a
           * picture, and a caller who is told that can go and install it. */
          return reject(new Error(
            `could not read ${path.basename(filePath)} for review`
            + (/No module named/i.test(err) ? " — Pillow is not installed for this python" : "")
            + (err ? `: ${err.trim().split("\n").pop()}` : "")));
        }
        resolve({ data: out, mimeType: "image/jpeg" });
      });
    });
  };
}
