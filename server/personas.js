/**
 * Personas — a character you can put in another picture.
 *
 * A persona is a NAME, a prompt fragment, and the reference pictures that show
 * what the character looks like. Attaching one to a render prepends its
 * references to the strip and folds its fragment into the prompt, so "Mira on a
 * beach" becomes the same face on a beach rather than a new person with the
 * same description.
 *
 * WHY THIS IS A SHELF AND NOT A MODEL. There is no training here and nothing is
 * fine-tuned: it is the reference-image path, remembered. That matters for what
 * it can promise — identity holds well (tested: a character and a hat compose
 * into the same face wearing the hat) but it is not a LoRA and will drift over
 * a long sequence. Saying so is the difference between a useful tool and a
 * disappointing one.
 *
 * References are supported by FLUX.2 and Qwen Image 2.1, and by MiniMax H3 for a
 * clip (the Video screen's Keep my character, make_clip `persona`: up to three
 * of its pictures, bindPersonaForClip below). That is a capability,
 * not a guarantee that identities will survive every edit. Other engines need a
 * policy: Ideogram has no reference input, a bare checkpoint's LoraLoader path
 * takes none, and Z-Image's Omni node runs but returns noise because the
 * checkpoints it wants are unreleased (tested, not read). So a persona records
 * the engine it was built for and the picker says when it cannot be used —
 * offering a character that will be silently ignored is the failure this whole
 * file exists to avoid.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_PERSONAS = 200;
const MAX_REFS = 8;          // the route takes 10; a persona leaves room for a scene ref

const newId = () => `p_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** One store, loaded once and written whole — it is a few kilobytes of text. */
export function createPersonaStore(file) {
  let byId = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      for (const p of Array.isArray(raw) ? raw : raw.personas || []) {
        if (p && p.id) byId.set(p.id, p);
      }
    } catch { /* no file yet, or corrupt: an empty shelf is the honest fallback */ }
  }

  async function save() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ personas: [...byId.values()] }, null, 1));
    } catch { /* a shelf that cannot be written must not take the app down */ }
  }

  /** Names are matched case-insensitively: "Mira" and "mira" are one character. */
  const norm = (s) => String(s ?? "").trim();
  const key = (s) => norm(s).toLowerCase();

  return {
    async list() {
      await load();
      return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    },

    async get(idOrName) {
      await load();
      if (byId.has(idOrName)) return byId.get(idOrName);
      const k = key(idOrName);
      return [...byId.values()].find((p) => key(p.name) === k) || null;
    },

    /**
     * Create or update BY NAME, so saving "Mira" twice edits one character
     * rather than growing two. An explicit id still wins, which is what a
     * rename needs.
     */
    async save(input = {}) {
      await load();
      const name = norm(input.name);
      if (!name) throw new Error("A persona needs a name — it is how the prompt refers to it.");

      const existing = input.id ? byId.get(input.id) : await this.get(name);
      const refs = (Array.isArray(input.refImages) ? input.refImages : [])
        .map((r) => path.basename(String(r || "")))
        .filter(Boolean)
        .slice(0, MAX_REFS);

      const p = {
        id: existing?.id || newId(),
        name,
        /* What to SAY about them, folded into the prompt. Kept separate from the
         * references because the two do different jobs: the pictures carry the
         * face, the words carry what cannot be seen in a reference — a role, a
         * temperament, a way of dressing. */
        fragment: norm(input.fragment ?? existing?.fragment),
        notes: norm(input.notes ?? existing?.notes),
        refImages: refs.length ? refs : existing?.refImages || [],
        /* Which engine these references were made for. Recorded rather than
         * assumed: a persona built on FLUX is meaningless to an engine with no
         * reference input, and the picker needs to be able to say so. */
        engine: norm(input.engine ?? existing?.engine) || "flux2",
        at: existing?.at || Date.now(),
        updatedAt: Date.now(),
      };
      if (!p.refImages.length && !p.fragment) {
        throw new Error(`"${name}" would carry nothing — give it a reference picture, a description, or both.`);
      }
      byId.set(p.id, p);
      /* Oldest first out, and only ever at the cap. */
      while (byId.size > MAX_PERSONAS) byId.delete(byId.keys().next().value);
      await save();
      return p;
    },

    async remove(idOrName) {
      await load();
      const p = await this.get(idOrName);
      if (!p) return false;
      byId.delete(p.id);
      await save();
      return true;
    },
  };
}

/**
 * Fold a persona into a render.
 *
 * The persona's references go FIRST, because the prompt refers to them by
 * position ("image 1") and a character whose number moves when a scene
 * reference is added is a character that stops working. Its own refs are then
 * appended after, keeping any the caller passed.
 *
 * The fragment is prepended rather than appended for the same reason a subject
 * goes at the front of a sentence: the model weights early tokens more, and a
 * character named after four clauses of scenery is a character in the
 * background.
 */
export function applyPersona(persona, { prompt, refImages = [] } = {}) {
  if (!persona) return { prompt, refImages, applied: false };
  const refs = [...(persona.refImages || []), ...refImages].slice(0, 10);
  const frag = String(persona.fragment || "").trim();
  const base = String(prompt || "").trim();
  /* If the prompt already names them, the fragment is not repeated — "Mira, a
   * tall woman with cropped hair, Mira on a beach" is worse than either half. */
  const named = persona.name && new RegExp(`\\b${persona.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(base);
  const merged = !frag ? base
    : named ? `${base}. ${frag}`
    : `${persona.name}: ${frag}. ${base}`;
  return {
    prompt: merged.replace(/\s+/g, " ").trim(),
    refImages: refs,
    applied: true,
    usedRefs: (persona.refImages || []).length,
  };
}

/* H3's reference node takes nine pictures (mv/shot.js REF_CAP, the Video
 * screen's REF_IMG_MAX). */
const CLIP_REF_CAP = 9;
/** How many of a character's pictures ride in a clip: the measured setup is
 *  1-3 of one character (the REWIND A/B, 2026-09-24). /api/personas?for=h3
 *  sends it, so the Video screen's preview strip keeps no number of its own. */
export const CLIP_PERSONA_PICTURES = 3;
const nameRe = (name) => new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

/** Does this description name the persona? The word-boundary test applyPersona uses. */
export const promptNames = (prompt, name) => !!String(name || "").trim() && nameRe(String(name).trim()).test(String(prompt || ""));

/** How many of a saved character's pictures a clip can carry beside `own`
 *  pictures the person attached: up to `max` (3), within the node's nine. */
export function clipPersonaRoom(own = 0, max = CLIP_PERSONA_PICTURES) {
  return Math.max(0, Math.min(max, CLIP_REF_CAP - Math.max(0, Number(own) || 0)));
}

/**
 * A saved character in a CLIP (MiniMax H3). Up to `max` (3) of its pictures
 * ride AFTER the ones the person attached, so tags they typed keep their
 * numbers; each is bound as "<Picture N> is <Name>." (the binding line
 * mv/shot.js writes; the A/B's winning arm bound one name per view, "Hex
 * body", "Hex", which a saved character cannot say yet) unless the
 * description already uses that tag; the fragment follows as "Name:
 * fragment." like the Pictures screen, then the description. The total stays
 * within the node's nine.
 *
 * `persona.pictures`, when set, is the character's full count where
 * `refImages` holds only the staged riders (stagePersonaForClip), so `extra`
 * still counts what the cap leaves out.
 *
 * @returns {{prompt:string, refImages:string[], used:number, extra:number, named:boolean, room:number}}
 *   `used` the character's pictures that ride, `extra` the ones the cap left
 *   out, `named` whether the description itself names them, `room` how many
 *   could ride beside the person's own.
 */
export function bindPersonaForClip(persona, { prompt, refImages = [], max = CLIP_PERSONA_PICTURES } = {}) {
  const own = (Array.isArray(refImages) ? refImages : []).filter(Boolean);
  const base = String(prompt || "").trim();
  if (!persona) return { prompt: base, refImages: own, used: 0, extra: 0, named: false, room: 0 };
  const all = (persona.refImages || []).filter(Boolean);
  const room = clipPersonaRoom(own.length, max);
  const take = all.slice(0, room);
  const total = Number.isFinite(persona.pictures) ? persona.pictures : all.length;
  const name = String(persona.name || "").trim();
  const tagged = (n) => new RegExp(`<\\s*Picture\\s+${n}\\s*>`, "i").test(base);
  const bindings = take.map((_, i) => own.length + i + 1).filter((n) => !tagged(n)).map((n) => `<Picture ${n}> is ${name}.`);
  const frag = String(persona.fragment || "").trim().replace(/[.\s]+$/, "");
  return {
    prompt: [...bindings, frag ? `${name}: ${frag}.` : "", base].filter(Boolean).join(" "),
    refImages: [...own, ...take],
    used: take.length,
    extra: Math.max(0, total - room),
    named: promptNames(base, name),
    room,
  };
}

/**
 * A saved character's pictures, STAGED for a clip by the door's own `stage`
 * (/api/video's: a picture uploaded on Pictures is already in ComfyUI's input
 * folder under its aiplay_frame_ name, a library picture is copied there).
 * Only the ones that can ride are staged (the first clipPersonaRoom), so a
 * picture the cap leaves out anyway is never counted as lost.
 *
 * @returns {Promise<{persona: object|null, lost: number}>} the character with
 *   the staged names and its full count (`pictures`), and how many of its
 *   riders could not be found.
 */
export async function stagePersonaForClip(persona, { own = 0, stage, max = CLIP_PERSONA_PICTURES } = {}) {
  if (!persona) return { persona: null, lost: 0 };
  const all = (persona.refImages || []).filter(Boolean);
  const want = all.slice(0, clipPersonaRoom(own, max));
  const got = (await Promise.all(want.map(async (v) => {
    try { return await stage(v); } catch { return undefined; }
  }))).filter(Boolean);
  return { persona: { ...persona, refImages: got, pictures: all.length }, lost: want.length - got.length };
}

/** Can this persona be used on this engine at all? Three states, as elsewhere. */
export function personaFits(engine) {
  if (engine === "h3") return { fit: "yes", why: "MiniMax H3 takes reference pictures: 1 to 3 of one character is the measured setup" };
  if (engine === "qwen-image-2.1") return { fit: "yes", why: "Qwen Image 2.1 takes reference images" };
  if (engine === "flux2") return { fit: "yes", why: "FLUX.2 takes reference images" };
  return {
    fit: "no",
    why: engine === "ideogram4" ? "Ideogram 4 has no reference input"
      : engine === "zimage" || engine === "zimage-base"
        ? "no released Z-Image checkpoint accepts references — its Omni node runs but returns noise"
      : engine === "anima" ? "Anima has no reference input"
      : "a bring-your-own checkpoint has no reference input — use Qwen Image 2.1 or FLUX.2",
  };
}
