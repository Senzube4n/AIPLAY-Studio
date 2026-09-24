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

import { LYRIC_RULES, lyricTells } from "../lyric-style.js";

export const MUSIC_INTRO = [
  "You are the songwriting assistant inside the Music panel of AIPLAY Studio, which runs on this",
  "person's own computer. You can ONLY do three things: write a song's lyrics and style into the",
  "form (write_song), change the settings below it (change_settings), and start the render",
  "(generate). You cannot reach the library, images, videos or anything else — if asked, say so.",
  "When they describe a song, call write_song with full lyrics, a style line and a short title in the same reply.",
  "Only call generate when they have asked for the song to be made.",
  "",
  "ATTACHED SONGS. The person can drop songs from their Library into the box; they are listed under",
  "ATTACHED SONGS on the screen with their style, lyrics and seed. With one attached you can:",
  "- REWORK it. THIS IS THE DEFAULT. \"Rewrite it\", \"remix the lyrics\", \"make it about…\", \"change the",
  "  genre\", \"use YuE2\" are all REWORK: a NEW song from new words and a new style line. Call write_song",
  "  with the new style and lyrics (keep what they did not ask to change), then change_settings with that",
  "  song's seed and random_seed false (and music_model when they named one), so the new take keeps the same",
  "  energy. Nothing is transcribed: the model makes a fresh melody for the new words.",
  "- REMIX it ONLY when they want THE RECORDING ITSELF sung again with its melody kept (\"cover it\", \"keep",
  "  the tune\", \"same melody but as metal\"): call remix_song. ACE-Step 1.5 re-performs the audio directly.",
  "  YuE2 first TRANSCRIBES the recording's melody on the graphics card (about a minute) and sings that score:",
  "  say so when you set one up. If the music model on the screen cannot remix and they did not name one, ASK",
  "  which of the remix models listed on the screen to use. Never pick one for them.",
  "MODELS AND JOBS. The screen lists every music model with installed or MISSING (and why), the render that is",
  "running, and recent renders with FAILED and the reason. Use it: never pick a missing model, and when a",
  "render or a transcription failed, tell them what failed and why in plain words, and what would fix it.",
  "Choose the settings a remix needs (tempo, key, time signature, language on ACE-Step) with change_settings.",
  "With two or three attached you can also COMBINE them: when asked to mix, merge or mash their lyrics into",
  "one song, read all of them and write ONE new set of lyrics that takes lines, story and chorus ideas from",
  "each (not one pasted after the other), with a style that blends theirs, in a single write_song. To also",
  "re-perform a recording with the merged words, call remix_song with those lyrics on the song they want as",
  "the base; ask which one if they did not say.",
  "",
  ...LYRIC_RULES,
];

/* The engines that can re-perform a song: ACE-Step 1.5 (ComfyUI's Set Reference
 * Audio) and YuE2 (a SheetSage transcription sung again). */
export const REMIX_ENGINES = ["ace-step15", "yue2-comfy", "yue2-gguf", "yue2"];

const str = (v) => (v === undefined || v === null ? "" : String(v));

/* ONE SPELLING OF A KEY. The assistant writes keys every way people do ("Em",
 * "e minor", "E Minor", "Cb"); YuE2's score seed takes only [A-G](b|#)?m? and
 * ACE-Step's dropdown only its own "E minor" names, so anything else broke the
 * render (YuE2: HTTP 400) or quietly became Auto (ACE-Step). Returned as the
 * short form (Em, F#, Bb); the page writes ACE-Step's long form from it.
 * null = not a key. */
const ENHARMONIC = { cb: "B", fb: "E", "e#": "F", "b#": "C" };
export function normalizeKey(v) {
  const k = str(v).trim().replace(/♭/g, "b").replace(/♯/g, "#");
  if (!k) return "";
  const m = k.match(/^([A-Ga-g])([b#]?)\s*(m|min|minor|maj|major)?$/i);
  if (!m) return null;
  let root = m[1].toUpperCase() + m[2];
  root = ENHARMONIC[root.toLowerCase()] || root;
  return root + (/^m(in(or)?)?$/i.test(m[3] || "") ? "m" : "");
}

/* ACE-Step's languages (web/app.js ACE_LANGS), and what models write instead.
 * An unknown code used to leave the dropdown blank and render in English while
 * the tool said otherwise. */
export const ACE_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk", "bg", "cs", "ro", "sv", "da", "no",
  "fi", "el", "tr", "ar", "he", "fa", "hi", "bn", "ur", "ta", "te", "pa", "ne", "zh", "yue", "ja", "ko", "vi", "th", "id", "ms",
  "tl", "sw", "hu", "hr", "sr", "sk", "lt", "is", "ca", "az", "ht", "la", "sa", "unknown"];
const LANG_ALIAS = {
  jp: "ja", cn: "zh", kr: "ko", gr: "el", se: "sv", dk: "da", ua: "uk", cz: "cs", iw: "he", in: "id", br: "pt", nb: "no",
  english: "en", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt", dutch: "nl", polish: "pl",
  russian: "ru", ukrainian: "uk", bulgarian: "bg", czech: "cs", romanian: "ro", swedish: "sv", danish: "da", norwegian: "no",
  finnish: "fi", greek: "el", turkish: "tr", arabic: "ar", hebrew: "he", persian: "fa", farsi: "fa", hindi: "hi",
  bengali: "bn", urdu: "ur", tamil: "ta", telugu: "te", punjabi: "pa", nepali: "ne", chinese: "zh", mandarin: "zh",
  cantonese: "yue", japanese: "ja", korean: "ko", vietnamese: "vi", thai: "th", indonesian: "id", malay: "ms",
  tagalog: "tl", filipino: "tl", swahili: "sw", hungarian: "hu", croatian: "hr", serbian: "sr", slovak: "sk",
  lithuanian: "lt", icelandic: "is", catalan: "ca", azerbaijani: "az", latin: "la", sanskrit: "sa", none: "unknown", other: "unknown",
};
export function normalizeLanguage(v) {
  const l = str(v).trim().toLowerCase();
  if (!l) return "";
  const code = LANG_ALIAS[l] || l;
  return ACE_LANGUAGES.includes(code) ? code : null;
}

/* Which settings each kind of music model has. The rest used to be "changed"
 * in the reply and ignored by the page. */
/* YuE2 through ComfyUI plans from nothing or sings a given score: it cannot
 * seed a key, tempo or meter and has no Guidance setting, and its door
 * refuses them by sentence (server/music/yue2-comfy-input.js), so they are
 * skipped here, not filled. A CLEAR still goes through (CLEAR_ON): clearing
 * them is what that refusal asks for, and the rows keep values carried over
 * from the Python kit. */
const ONLY_ON = { key: ["ace", "yue"], tempo: ["ace", "yue"], meter: ["ace", "yue"], language: ["ace"], thinking: ["yue", "yue-comfy"],
  guidance: ["ace", "yue", "other"] };
const CLEAR_ON = { key: ["yue-comfy"], tempo: ["yue-comfy"], meter: ["yue-comfy"], guidance: ["yue-comfy"] };
const blank = (v) => v === null || (typeof v === "string" && !v.trim());
const engineKind = (id) => (id === "ace-step15" ? "ace" : id === "yue2-comfy" ? "yue-comfy" : /^yue2/.test(str(id)) ? "yue" : "other");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";

export function createMusicTools() {
  /* The form snapshot of the message being answered (routes.js sets it), so
   * remix_song can check the song is attached and which models can remix. */
  let screen = null;
  const TOOLS = [
    {
      name: "write_song",
      spends: false,
      description:
        "Writes into the Music form: the lyrics, the style and a short title. It does NOT "
        + "render anything. Follow HOW TO WRITE LYRICS above. Write COMPLETE lyrics: section tags like [Verse], [Chorus] and [Bridge] "
        + "each on their own line, then the sung lines. Longer lyrics make a longer song. The style "
        + "is one line of genre, mood, instruments, who sings and the tempo, e.g. "
        + "'dark synthwave, female vocal, pulsing bass, 110 BPM'. For an instrumental set "
        + "instrumental to true and leave lyrics out.",
      args: {
        style: { type: "string", required: true, note: "Genre, mood, instruments, voice, tempo — one line." },
        lyrics: { type: "string", note: "Complete lyrics with [Verse] / [Chorus] tags. Leave out for an instrumental." },
        title: { type: "string", note: "A short song title, 2 to 6 words. Always give one: in Simple mode it is the field left in view." },
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
        /* Not a refusal: the words are written either way. The model is told
         * which banned words slipped in, so its next write_song can fix them. */
        const tells = instrumental ? [] : lyricTells(lyrics);
        return {
          form,
          written: instrumental ? "style (instrumental)" : `style and ${lyrics.split("\n").filter((l) => l.trim()).length} lines of lyrics`,
          note: "It is in the form now. Nothing is rendering yet.",
          ...(tells.length ? { avoid_words_used: tells.join(", "),
            fix: "These are on the never-use list. Unless the person asked for them, call write_song again with those lines rewritten in plain words." } : {}),
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
        length_seconds: { type: "integer", note: "Longest the song may run, 30 up to the model's most (on the screen)." },
        takes: { type: "integer", note: "How many versions to make per generate, 1 to 4." },
        seed: { type: "integer", note: "A fixed seed, to repeat a result." },
        random_seed: { type: "boolean", note: "true = a new seed every time." },
        instrumental: { type: "boolean", note: "true for no vocals, false for a song with vocals." },
        key: { type: "string", note: "ACE-Step and the YuE2 Python kit. Like Em, G, Bb, F#m (or E minor). Empty lets the model decide (and clears it on any YuE2)." },
        tempo: { type: "integer", note: "ACE-Step and the YuE2 Python kit. Beats per minute, 40 to 240. Empty clears it." },
        meter: { type: "string", note: "ACE-Step and the YuE2 Python kit. 4/4, 3/4, 6/8 or 2/4. Empty clears it." },
        language: { type: "string", note: "ACE-Step only. The lyrics' language code: en, es, fr, de, it, pt, ru, bg, ja, ko, zh…" },
        thinking: { type: "string", note: "YuE2 only. full, melody or off — how much it plans before singing." },
        steps: { type: "integer", note: "YuE2: 32 or 16 (16 is faster, measured the same). MiniMax: quality 6 to 30." },
        guidance: { type: "number", note: "How strictly it follows the style, e.g. 1.0 to 3.0. Empty returns to the model's default. Not on YuE2 through ComfyUI." },
        clear_remix: { type: "boolean", note: "true = stop using an attached song as a remix source (for a fresh original)." },
        music_model: { type: "string", note: "Switch the music model: its engine (ace-step15, yue2-gguf, yue2-comfy, minimax-music3) or its name from MUSIC MODELS. Installed ones only." },
      },
      async run(a) {
        const form = {};
        const changed = [];
        const set = (k, v, label) => { form[k] = v; changed.push(label); };
        /* What this model has: with no screen (a script) everything is allowed. */
        let kind = screen ? engineKind(screen.engine_id) : null;
        const skipped = [];
        const has = (k, v) => !kind || !ONLY_ON[k] || ONLY_ON[k].includes(kind)
          || (CLEAR_ON[k]?.includes(kind) && blank(v)) || (skipped.push(k), false);
        if (a.music_model !== undefined && str(a.music_model).trim()) {
          const want = str(a.music_model).trim().toLowerCase();
          const all = Array.isArray(screen?.music_models) ? screen.music_models : [];
          const hit = all.find((m) => m.available && (str(m.value).toLowerCase() === want || str(m.engine).toLowerCase() === want))
            || all.find((m) => m.available && str(m.label).toLowerCase().includes(want))
            || (/^yue ?2?$/.test(want) ? all.find((m) => m.available && /^yue2/.test(m.engine)) : null);
          if (!hit) {
            const gone = all.find((m) => str(m.engine).toLowerCase() === want || str(m.label).toLowerCase().includes(want));
            throw new Error(gone ? `${gone.label} is not installed here (${gone.note || "missing"}). Installed: ${all.filter((m) => m.available).map((m) => m.label).join(", ") || "none"}.`
              : `No music model called "${a.music_model}". Installed: ${all.filter((m) => m.available).map((m) => m.label).join(", ") || "none"}.`);
          }
          set("musicModel", hit.value, `music model ${hit.label}`);
          kind = engineKind(hit.engine);          // the settings below are for the model it switches to
        }
        const len = num(a.length_seconds);
        if (len !== null) {
          const top = num(screen?.max_length) || 360;
          const v = Math.max(30, Math.min(top, Math.round(len)));
          set("lengthSeconds", v, `length ${v} s${v !== Math.round(len) ? ` (${top} s is the most this model makes)` : ""}`);
        }
        const takes = num(a.takes);
        if (takes !== null) set("takes", Math.max(1, Math.min(4, Math.round(takes))), `${Math.round(takes)} takes`);
        const seed = num(a.seed);
        if (seed !== null) set("seed", Math.max(0, Math.round(seed)), `seed ${Math.round(seed)}`);
        if (a.random_seed !== undefined) set("randomSeed", bool(a.random_seed), bool(a.random_seed) ? "random seed" : "fixed seed");
        if (a.instrumental !== undefined) set("instrumental", bool(a.instrumental), bool(a.instrumental) ? "instrumental" : "song with vocals");
        if (a.language !== undefined && has("language")) {
          const l = normalizeLanguage(a.language);
          if (l === null) throw new Error(`language "${str(a.language).trim()}" is not one ACE-Step sings — use one of ${ACE_LANGUAGES.join(", ")}.`);
          set("language", l, `language ${l || "default"}`);
        }
        if (a.key !== undefined && has("key", a.key)) {
          const k = normalizeKey(a.key);
          if (k === null) throw new Error(`key "${str(a.key).trim()}" is not a key — use a letter A to G, optional b or #, optional m for minor (Em, F#m, Bb).`);
          set("key", k, k ? `key ${k}` : "key decided by the model");
        }
        const tempo = num(a.tempo);
        /* Empty clears it (it used to read as 0 and land on 40 BPM). */
        if (a.tempo !== undefined && blank(a.tempo)) { if (has("tempo", a.tempo)) set("tempo", "", "tempo decided by the model"); }
        else if (tempo !== null && has("tempo", a.tempo)) set("tempo", Math.max(40, Math.min(240, Math.round(tempo))), `${Math.round(tempo)} BPM`);
        if (a.meter !== undefined && has("meter", a.meter)) {
          const m = str(a.meter).trim();
          if (m && !["4/4", "3/4", "6/8", "2/4"].includes(m)) throw new Error("meter must be 4/4, 3/4, 6/8 or 2/4.");
          set("meter", m, m ? `meter ${m}` : "meter decided by the model");
        }
        if (a.thinking !== undefined && has("thinking")) {
          const t = str(a.thinking).trim().toLowerCase();
          if (!["full", "melody", "off"].includes(t)) throw new Error("thinking must be full, melody or off.");
          set("thinking", t, `thinking ${t}`);
        }
        const steps = num(a.steps);
        if (steps !== null) set("steps", Math.round(steps), `${Math.round(steps)} steps`);
        const g = num(a.guidance);
        if (a.guidance !== undefined && blank(a.guidance)) { if (has("guidance", a.guidance)) set("guidance", "", "guidance at the model's default"); }
        else if (g !== null && has("guidance", a.guidance)) set("guidance", Math.max(0, Math.min(20, g)), `guidance ${g}`);
        if (a.clear_remix !== undefined && bool(a.clear_remix)) set("remix", null, "remix cleared");
        const notHere = skipped.length ? `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not a setting on ${screen?.engine || "this music model"}` : "";
        if (!changed.length) throw new Error(notHere ? `Nothing changed: ${notHere}.` : "Give at least one setting to change.");
        return { form, changed: changed.join(", "), note: "Changed in the panel. Nothing is rendering yet.", ...(notHere ? { not_changed: notHere } : {}) };
      },
    },

    {
      name: "remix_song",
      spends: false,
      description:
        "Sets up a REMIX of a song the person attached: the same recording performed again in a new style. "
        + "It fills the form (the new style, the lyrics, the song's seed) and points the music model at the "
        + "attached song. It does NOT render anything; call generate after, when they want it made. Only "
        + "ACE-Step 1.5 and YuE2 can remix: give engine when the music model on the screen cannot.",
      args: {
        song: { type: "string", required: true, note: "The attached song's file name (from ATTACHED SONGS)." },
        style: { type: "string", required: true, note: "The new style: genre, mood, instruments, voice, tempo — one line." },
        lyrics: { type: "string", note: "New lyrics. Leave out to keep the song's own." },
        title: { type: "string", note: "A short title for the remix." },
        engine: { type: "string", note: "ace-step15 or yue2. Leave out to use the music model on the screen, if it can remix." },
      },
      async run(a) {
        const f = screen || {};
        const attached = Array.isArray(f.attached) ? f.attached : [];
        const want = str(a.song).trim();
        const song = attached.find((s) => s.file === want) || attached.find((s) => str(s.title).toLowerCase() === want.toLowerCase());
        if (!song) {
          throw new Error(attached.length
            ? `"${want}" is not attached. Attached: ${attached.map((s) => s.file).join(", ")}.`
            : "No song is attached. Ask the person to drag one from the Library into the box.");
        }
        const style = str(a.style).trim();
        if (!style) throw new Error("style is required — the new style for the remix, one line.");
        const models = Array.isArray(f.remix_models) ? f.remix_models : [];
        let engine = str(a.engine).trim().toLowerCase();
        if (engine === "yue2" || engine === "yue") {
          engine = /^yue2/.test(str(f.engine_id)) && models.some((m) => m.engine === f.engine_id)
            ? f.engine_id : models.find((m) => /^yue2/.test(m.engine))?.engine || "yue2-comfy";
        }
        if (engine === "ace" || engine === "ace-step") engine = "ace-step15";
        if (!engine) engine = REMIX_ENGINES.includes(f.engine_id) ? f.engine_id : "";
        if (!engine) {
          throw new Error(`The music model on the screen (${f.engine || "unknown"}) cannot remix. Ask the person which to use: `
            + (models.length ? models.map((m) => m.label).join(" or ") : "ACE-Step 1.5 or YuE2 — neither is installed, so say so") + ".");
        }
        if (!REMIX_ENGINES.includes(engine)) throw new Error("engine must be ace-step15 or yue2.");
        if (models.length && !models.some((m) => m.engine === engine)) {
          throw new Error(`${engine} is not installed here. Remix models on this machine: ${models.map((m) => m.label).join(", ") || "none"}.`);
        }
        const lyrics = a.lyrics !== undefined ? str(a.lyrics).replace(/\r\n/g, "\n").trim() : str(song.lyrics).trim();
        const form = { style, remix: { song: song.file, engine }, randomSeed: false };
        if (Number.isFinite(Number(song.seed))) form.seed = Math.round(Number(song.seed));
        /* Words mean a sung take, explicitly (the form may be in Instrumental).
         * No words is an instrumental only when the song was one; otherwise its
         * lyrics simply were not on the screen, and a silent instrumental remix
         * of a song with vocals is the wrong answer. */
        if (lyrics) { form.lyrics = lyrics; form.instrumental = false; }
        else if (song.instrumental) form.instrumental = true;
        else throw new Error(`The lyrics of "${song.title || song.file}" are not on the screen. Pass them (or new words) as lyrics; if you do not know them, ask the person.`);
        if (str(a.title).trim()) form.title = str(a.title).trim().slice(0, 120);
        return {
          form,
          remix: `${song.title || song.file} on ${engine === "ace-step15" ? "ACE-Step 1.5" : "YuE2"}`,
          note: engine === "ace-step15"
            ? "The form is set: ACE-Step will re-perform the attached song in the new style. Nothing is rendering yet."
            : "The form is set for YuE2. generate transcribes the song's melody first (on the graphics card, about a "
              + "minute; once per song) and then renders it, so when they want it made just call generate. Tell them the "
              + "melody is transcribed first. Do not ask them to press Transcribe or anything else.",
        };
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
        + "wants the song made. For a YuE2 remix it transcribes the attached song first, then renders: "
        + "one call does both.",
      args: {},
      async run() {
        /* The page presses Create and reports under this whether it started
         * (web/chat.js aiplay:simple-generated), so this says what is being done,
         * not that it worked. */
        const yueRemix = /^yue2/.test(str(screen?.remix?.engine));
        return { action: "generate", say: yueRemix
          ? "Transcribing the song first, then rendering the remix. The line below says when the render has started."
          : "Pressing Create now; it starts rendering in a moment. The line below confirms it." };
      },
    },
  ];

  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return {
    all: TOOLS,
    setScreen: (f) => { screen = f && typeof f === "object" ? f : null; },
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
  if (f.engine_id) {
    lines.push(`can this model remix: ${REMIX_ENGINES.includes(f.engine_id) ? "yes" : "no"}`);
    const rm = Array.isArray(f.remix_models) ? f.remix_models : [];
    lines.push(`remix models on this machine: ${rm.length ? rm.map((m) => `${m.label} (engine ${m.engine})`).join(", ") : "none"}`);
  }
  if (f.remix?.song) lines.push(`remix set up: ${clip(f.remix.song, 80)} on ${clip(f.remix.engine, 20)}`);
  /* What is installed, what is running, what failed and why — so the model
   * can say "that failed because…" instead of guessing, and never picks a
   * model that is not there. */
  const mm = Array.isArray(f.music_models) ? f.music_models.slice(0, 16) : [];
  if (mm.length) {
    lines.push("", "MUSIC MODELS:");
    for (const m of mm) lines.push(`- ${clip(m.label, 60)} (engine ${clip(m.engine, 24)}): ${m.available ? "installed" : "MISSING"}${m.note ? ` — ${clip(m.note, 120)}` : ""}${m.current ? " · on the screen now" : ""}`);
  }
  const jb = f.jobs && typeof f.jobs === "object" ? f.jobs : null;
  if (jb) {
    lines.push("", "RENDERS:");
    lines.push(jb.running ? `- running now: ${clip(jb.running, 200)}` : "- nothing rendering now");
    if (jb.queued) lines.push(`- waiting in the queue: ${jb.queued}`);
    for (const r of Array.isArray(jb.recent) ? jb.recent.slice(0, 4) : []) lines.push(`- ${clip(r, 400)}`);
  }
  if (f.transcription) lines.push(`melody transcription: ${clip(f.transcription, 400)}`);
  const s = f.settings && typeof f.settings === "object" ? f.settings : {};
  const kv = Object.entries(s).filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${clip(v, 40)}`);
  if (kv.length) lines.push(`settings: ${kv.join(", ")}`);
  /* Songs the person dropped into the box: everything the assistant needs to
   * rework or remix them, lyrics in full up to a budget. */
  const att = Array.isArray(f.attached) ? f.attached.slice(0, 3) : [];
  if (att.length) {
    lines.push("", `ATTACHED SONGS (${att.length}):`);
    for (const s2 of att) {
      lines.push(`- "${clip(s2.title, 80)}" · file ${clip(s2.file, 120)} · made with ${clip(s2.model || "?", 40)}`
        + ` · seed ${s2.seed ?? "?"}${s2.seconds ? ` · ${Math.round(s2.seconds)} s` : ""}${s2.instrumental ? " · instrumental" : ""}`);
      lines.push(`  style: ${clip(s2.style, 400) || "(none recorded)"}`);
      const ly = str(s2.lyrics).trim();
      lines.push(ly ? `  lyrics:\n${clip(ly, 2400).split("\n").map((l) => `    ${l}`).join("\n")}` : "  lyrics: (none recorded)");
    }
  }
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
    if (k === "musicModel") {
      const m = (Array.isArray(form.music_models) ? form.music_models : []).find((x) => x.value === v);
      if (m) { form.engine_id = m.engine; form.engine = m.label; }
      continue;
    }
    if (["style", "lyrics", "title", "instrumental", "remix"].includes(k)) form[k] = v;
    else form.settings[SETTING_NAMES[k] || k] = v;
  }
  /* A remix switches the music model: the rest of this turn must see the new
   * one, or it is told "can this model remix: no" and asks again. */
  if (patch.remix?.engine) {
    form.engine_id = patch.remix.engine;
    form.engine = patch.remix.engine === "ace-step15" ? "ACE-Step 1.5" : "YuE2";
  }
  if (patch.instrumental === true) form.lyrics = "";
  return form;
}

export default createMusicTools;
