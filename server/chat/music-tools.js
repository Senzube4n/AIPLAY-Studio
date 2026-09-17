/**
 * THE MUSIC PANEL'S "SIMPLE" ASSISTANT — three tools and nothing else.
 *
 * The Chat tab's assistant can reach the whole studio. This one sits inside the
 * Music panel and may only do what a person would do with that panel: write the
 * lyrics and the style, change the settings under them, and press Create.
 *
 * None of these tools touch the server's music state. Each returns a `form`
 * patch; web/app.js applies it to the controls on the page, so the words and
 * settings land where the person can see and edit them, and Create renders
 * exactly what the panel shows — engine, LoRA, seed and all. `generate` is the
 * page pressing Create.
 *
 * `generate` SPENDS: the loop's confirm gate holds it until the person presses
 * Generate (or types yes). It also ENDS THE TURN once confirmed, because the
 * song goes onto the same card the chat model uses, and a follow-up model call
 * would sit behind the whole render before it could say "started".
 *
 * Arguments are flat strings, numbers and booleans, as everywhere in this chat.
 */

export const MUSIC_INTRO = [
  "You are the songwriting assistant inside the Music panel of AIPLAY Studio, which runs on this",
  "person's own computer. You can ONLY do three things: write a song's lyrics and style into the",
  "form (write_song), change the settings below it (change_settings), and start the render",
  "(generate). You cannot reach the library, images, videos or anything else — if asked, say so.",
  "When they describe a song, call write_song with full lyrics and a style line in the same reply.",
  "Only call generate when they have asked for the song to be made.",
];

const str = (v) => (v === undefined || v === null ? "" : String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";

export function createMusicTools() {
  const TOOLS = [
    {
      name: "write_song",
      spends: false,
      description:
        "Writes into the Music form: the lyrics, the style, and optionally the title. It does NOT "
        + "render anything. Write COMPLETE lyrics: section tags like [Verse], [Chorus] and [Bridge] "
        + "each on their own line, then the sung lines. Longer lyrics make a longer song. The style "
        + "is one line of genre, mood, instruments, who sings and the tempo, e.g. "
        + "'dark synthwave, female vocal, pulsing bass, 110 BPM'. For an instrumental set "
        + "instrumental to true and leave lyrics out.",
      args: {
        style: { type: "string", required: true, note: "Genre, mood, instruments, voice, tempo — one line." },
        lyrics: { type: "string", note: "Complete lyrics with [Verse] / [Chorus] tags. Leave out for an instrumental." },
        title: { type: "string", note: "Optional song title." },
        instrumental: { type: "boolean", note: "true for no vocals." },
      },
      async run(a) {
        const style = str(a.style).trim();
        if (!style) throw new Error("style is required — one line of genre, mood, instruments and voice.");
        const instrumental = bool(a.instrumental);
        const lyrics = instrumental ? "" : str(a.lyrics).replace(/\r\n/g, "\n").trim();
        if (!instrumental && !lyrics) throw new Error("lyrics are required unless instrumental is true.");
        const form = { style, instrumental };
        if (!instrumental) form.lyrics = lyrics;
        if (str(a.title).trim()) form.title = str(a.title).trim().slice(0, 120);
        return {
          form,
          written: instrumental ? "style (instrumental)" : `style and ${lyrics.split("\n").filter((l) => l.trim()).length} lines of lyrics`,
          note: "It is in the form now. Nothing is rendering yet.",
        };
      },
    },

    {
      name: "change_settings",
      spends: false,
      description:
        "Changes the settings under the lyrics in the Music panel. Give only the ones to change. "
        + "It does NOT render anything.",
      args: {
        length_seconds: { type: "integer", note: "Longest the song may run, 30 to 360." },
        takes: { type: "integer", note: "How many versions to make per generate, 1 to 4." },
        seed: { type: "integer", note: "A fixed seed, to repeat a result." },
        random_seed: { type: "boolean", note: "true = a new seed every time." },
        instrumental: { type: "boolean", note: "true for no vocals, false for a song with vocals." },
        key: { type: "string", note: "YuE2 only. Like Em, G, Bb, F#m. Empty lets the model decide." },
        tempo: { type: "integer", note: "YuE2 only. Beats per minute, 40 to 240." },
        meter: { type: "string", note: "YuE2 only. 4/4, 3/4, 6/8 or 2/4." },
        thinking: { type: "string", note: "YuE2 only. full, melody or off — how much it plans before singing." },
        steps: { type: "integer", note: "YuE2: 32 or 16 (16 is faster, measured the same). MiniMax: quality 6 to 30." },
        guidance: { type: "number", note: "How strictly it follows the style, e.g. 1.0 to 3.0." },
      },
      async run(a) {
        const form = {};
        const changed = [];
        const set = (k, v, label) => { form[k] = v; changed.push(label); };
        const len = num(a.length_seconds);
        if (len !== null) set("lengthSeconds", Math.max(30, Math.min(360, Math.round(len))), `length ${Math.round(len)} s`);
        const takes = num(a.takes);
        if (takes !== null) set("takes", Math.max(1, Math.min(4, Math.round(takes))), `${Math.round(takes)} takes`);
        const seed = num(a.seed);
        if (seed !== null) set("seed", Math.max(0, Math.round(seed)), `seed ${Math.round(seed)}`);
        if (a.random_seed !== undefined) set("randomSeed", bool(a.random_seed), bool(a.random_seed) ? "random seed" : "fixed seed");
        if (a.instrumental !== undefined) set("instrumental", bool(a.instrumental), bool(a.instrumental) ? "instrumental" : "song with vocals");
        if (a.key !== undefined) {
          const k = str(a.key).trim();
          if (k && !/^[A-Ga-g][b#]?m?$/.test(k)) throw new Error(`key "${k}" is not a key — use a letter A to G, optional b or #, optional m for minor.`);
          set("key", k, k ? `key ${k}` : "key decided by the model");
        }
        const tempo = num(a.tempo);
        if (tempo !== null) set("tempo", Math.max(40, Math.min(240, Math.round(tempo))), `${Math.round(tempo)} BPM`);
        if (a.meter !== undefined) {
          const m = str(a.meter).trim();
          if (m && !["4/4", "3/4", "6/8", "2/4"].includes(m)) throw new Error("meter must be 4/4, 3/4, 6/8 or 2/4.");
          set("meter", m, m ? `meter ${m}` : "meter decided by the model");
        }
        if (a.thinking !== undefined) {
          const t = str(a.thinking).trim().toLowerCase();
          if (!["full", "melody", "off"].includes(t)) throw new Error("thinking must be full, melody or off.");
          set("thinking", t, `thinking ${t}`);
        }
        const steps = num(a.steps);
        if (steps !== null) set("steps", Math.round(steps), `${Math.round(steps)} steps`);
        const g = num(a.guidance);
        if (g !== null) set("guidance", Math.max(0, Math.min(20, g)), `guidance ${g}`);
        if (!changed.length) throw new Error("Give at least one setting to change.");
        return { form, changed: changed.join(", "), note: "Changed in the panel. Nothing is rendering yet." };
      },
    },

    {
      name: "generate",
      spends: true,
      endsTurn: true,
      cost: "the graphics card for a few minutes per take, and it holds the card while it runs",
      description:
        "Presses Create: renders the song that is in the Music form right now, with its settings. "
        + "Call it only when the form has a style (and lyrics, unless instrumental) and the person "
        + "wants the song made.",
      args: {},
      async run() {
        return { action: "generate", say: "Started — it is rendering now. Watch the Library for the new song." };
      },
    },
  ];

  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return {
    all: TOOLS,
    names: TOOLS.map((t) => t.name),
    get: (n) => byName.get(String(n)) || null,
    spending: TOOLS.filter((t) => t.spends).map((t) => t.name),
    routed: [],
  };
}

/** One line per field of the form snapshot the page sends with each message. */
export function describeForm(f) {
  if (!f || typeof f !== "object") return null;
  const lines = [];
  const clip = (s, n) => { const t = str(s).trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  if (f.engine) lines.push(`music model: ${clip(f.engine, 60)}`);
  lines.push(`mode: ${f.instrumental ? "instrumental" : "song with vocals"}`);
  lines.push(`title: ${clip(f.title, 80) || "(none)"}`);
  lines.push(`style: ${clip(f.style, 300) || "(empty)"}`);
  const lyr = str(f.lyrics).trim();
  lines.push(lyr ? `lyrics (${lyr.split("\n").filter((l) => l.trim()).length} lines): ${clip(lyr.replace(/\n/g, " / "), 400)}` : "lyrics: (empty)");
  const s = f.settings && typeof f.settings === "object" ? f.settings : {};
  const kv = Object.entries(s).filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${clip(v, 40)}`);
  if (kv.length) lines.push(`settings: ${kv.join(", ")}`);
  return lines.join("\n");
}

/**
 * Apply a tool's form patch to the snapshot the model is shown, so the next
 * step of the SAME turn sees what it just wrote. Without this the "on the
 * screen" block kept the form as it was when the message was sent, and a model
 * that reads it carefully (measured with Claude, 2026-09-17) concluded its own
 * edits had been wiped and refused to press Create.
 */
const SETTING_NAMES = { lengthSeconds: "length_seconds", randomSeed: "random_seed" };
export function applyFormPatch(form, patch) {
  if (!form || !patch || typeof patch !== "object") return form;
  form.settings = form.settings && typeof form.settings === "object" ? form.settings : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (["style", "lyrics", "title", "instrumental"].includes(k)) form[k] = v;
    else form.settings[SETTING_NAMES[k] || k] = v;
  }
  if (patch.instrumental === true) form.lyrics = "";
  return form;
}

export default createMusicTools;
