/**
 * WHICH MUSIC MODEL RUNS WHEN NOBODY CHOSE: the one answer, for the Studio and
 * the launcher alike.
 *
 * Pure and import-free on purpose. server/fit.js defaultFor("music") answers
 * with it inside Studio; launcher/musiccard.mjs answers with it on the
 * launcher's first screen, which may not import config.js (it computes a whole
 * Studio configuration at import time). Two hand-kept copies disagreed: the
 * launcher went on naming MiniMax Music 3 while Studio ran YuE2.
 *
 * A SAVED CHOICE ALWAYS WINS, ready or not, reported as the person's, with a
 * sentence when its files are missing, never a silent swap. A value carried
 * from a settings file an older Studio wrote on its own (`kept`) wins the same
 * way and is worded "Saved in your settings", because nobody can say it was
 * chosen. The machine never picks a paid row: MiniMax through an API key runs
 * only when the person turned API mode on ("Use a hosted engine instead of my
 * GPU" in Settings), and the sentence says each song is billed to their key.
 * The YuE2 Python kit only when it is installed and ready.
 */

/** "YuE2 3B · int8_convrot" -> "YuE2 3B": the model half of a choice's label.
 *  The build stays in `label` for a tooltip or the Change screen. */
export const modelName = (label) => String(label || "").split(" · ")[0].trim();

/* An engine's name when the list in hand has no row for it (the music-only
 * launch lists YuE2 only, so a saved Python kit or MiniMax has none there).
 * The same words the model picker's rows use. */
const NAME_WITHOUT_ROW = {
  "yue2": "YuE2 3B (Python kit)", "yue2-comfy": "YuE2 3B", "yue2-gguf": "YuE2 GGUF",
  "minimax-music3": "MiniMax Music 3", "ace-step15": "ACE-Step 1.5",
};

/** Which YuE2-for-ComfyUI build to load from the files on disk: int8 on
 *  NVIDIA (the build the Models screen fetches), bf16 on AMD (the one measured
 *  there), else the first one. Null when there is none. */
export function yue2BuildFor(names, vendor) {
  const list = (names || []).filter(Boolean);
  const want = vendor === "amd" ? [/bf16/i, /int8/i] : [/int8/i, /bf16/i];
  for (const re of want) { const hit = list.find((n) => re.test(n)); if (hit) return hit; }
  return list[0] || null;
}

/** The API row for MiniMax: the provider API mode uses, else any. */
function apiRow(choices, api) {
  const rows = choices.filter((c) => c.api && c.engine === "minimax-music3");
  return rows.find((c) => c.api === api?.provider) || rows[0] || null;
}

/**
 * ctx: {
 *   saved:   { engine, checkpoint, kept } | null   what settings.json holds
 *   session: { engine, checkpoint, reason } | null this launch runs something else
 *            (a saved choice it cannot run); never saved, said in `why`
 *   choices: the music model list (index.js musicModelChoices, or the launcher's)
 *   machine: { gpu: {vendor} | null, amdMusicFixed }
 *   api:     { enabled, provider } | null         API mode, the person's switch
 *   musicOnly, literal
 * }
 * Returns { key, value, checkpoint, checkpointBy, precision, chosenBy, kept,
 *           ready, label, model, paid, savedValue, why }.
 */
export function musicDefault({ saved = null, session = null, choices = [], machine = null, api = null, musicOnly = false, literal = "minimax-music3" } = {}) {
  const key = "music.engine";
  const vendor = machine?.gpu ? (machine.gpu.vendor || "nvidia") : null;
  /* Paid rows are never a machine pick: only a person turns a key on. */
  const ready = choices.filter((c) => c.available && !c.api);
  const comfy = ready.filter((c) => c.engine === "yue2-comfy" && c.checkpoint);
  const comfyPick = () => {
    const name = yue2BuildFor(comfy.map((c) => c.checkpoint), vendor);
    return name ? comfy.find((c) => c.checkpoint === name) : null;
  };
  const gguf = ready.filter((c) => c.engine === "yue2-gguf")
    .sort((a, b) => Number(b.precision === "q4_0") - Number(a.precision === "q4_0"))[0] || null;
  const paidOn = !!api?.enabled;

  if (saved?.engine) {
    const said = (name) => (saved.kept ? `Saved in your settings: ${name} for music` : `You chose ${name} for music`);
    const paid = saved.engine === "minimax-music3" && paidOn;
    let isReady, label;
    if (paid) {
      /* API mode sends every MiniMax song to the hosted engine (jobs.js), so
       * the key, not the local files, is what has to be ready. */
      const row = apiRow(choices, api);
      isReady = !!row?.available;
      label = row?.label || "MiniMax Music 3 · API";
    } else {
      const mine = choices.filter((c) => c.engine === saved.engine && !c.api);
      isReady = saved.engine === "yue2-comfy"
        ? mine.some((c) => c.available && (!saved.checkpoint || c.checkpoint === saved.checkpoint))
        : mine.some((c) => c.available);
      label = (saved.engine === "yue2-comfy" && saved.checkpoint && mine.find((c) => c.checkpoint === saved.checkpoint)?.label)
        || mine.find((c) => c.available)?.label || mine[0]?.label || NAME_WITHOUT_ROW[saved.engine] || saved.engine;
    }
    let checkpoint = saved.checkpoint || null, checkpointBy = checkpoint ? "you" : null;
    if (saved.engine === "yue2-comfy" && !checkpoint) {
      const c = comfyPick();
      if (c) { checkpoint = c.checkpoint; checkpointBy = "machine"; }
    }
    const name = paid ? "MiniMax Music 3" : modelName(label);
    const row = {
      key, value: saved.engine, checkpoint, checkpointBy, precision: null, chosenBy: "you", kept: !!saved.kept,
      ready: isReady, label, model: name, paid,
      why: paid
        ? (isReady ? `${said(name)}, through your own API key (API mode is on): each song is billed to it.`
          : `${said(name)}, through your own API key, and the key is not ready. Settings has it; Studio does not switch for you.`)
        : isReady ? `${said(name)}.`
        : `${said(name)}, and it is not ready on this PC. The Models screen has it; Studio does not switch for you.`,
    };
    /* THIS LAUNCH RUNS SOMETHING ELSE, and says so. The music-only launch runs
     * YuE2 only; a saved native GGUF that is not installed runs through
     * ComfyUI. The saved choice stays in settings.json (config.js
     * overrideForSession) and is back the next time it can run. */
    const other = session?.engine && (session.engine !== saved.engine
      || (session.checkpoint && session.checkpoint !== (saved.checkpoint || checkpoint)));
    if (other) {
      const runs = choices.find((c) => c.engine === session.engine && !c.api && (!session.checkpoint || c.checkpoint === session.checkpoint))
        || choices.find((c) => c.engine === session.engine && !c.api);
      const runsName = runs ? modelName(runs.label) : NAME_WITHOUT_ROW[session.engine] || session.engine;
      /* Same engine, another build: the build is the news, so it is named. */
      const runsText = session.engine === saved.engine ? (runs?.label || runsName) : runsName;
      return {
        ...row, value: session.engine, savedValue: saved.engine, checkpoint: session.checkpoint || (session.engine === saved.engine ? checkpoint : null),
        checkpointBy: session.checkpoint ? "machine" : session.engine === saved.engine ? row.checkpointBy : null, ready: !!runs?.available, label: runs?.label || session.engine, model: runsName, paid: false,
        why: `${said(name)}. ${session.reason || "This launch cannot run it"}, so this session uses ${runsText}; your choice stays saved.`,
      };
    }
    return row;
  }

  /* API MODE IS THE PERSON'S SWITCH ("Use a hosted engine instead of my GPU"),
   * so with nothing else chosen the hosted MiniMax is theirs, billed to their
   * own key, as it was before defaults followed the disk. The machine never
   * turns it on and never picks it with API mode off. */
  if (paidOn && !musicOnly) {
    const row = apiRow(choices, api);
    return {
      key, value: "minimax-music3", checkpoint: null, checkpointBy: null, precision: null, chosenBy: "you", kept: false,
      ready: !!row?.available, label: row?.label || "MiniMax Music 3 · API", model: "MiniMax Music 3", paid: true,
      why: row?.available
        ? "API mode is on (your switch in Settings): songs go to MiniMax Music 3 through your own API key, billed per song."
        : "API mode is on (your switch in Settings), and its key is not ready. Settings has it; Studio does not switch for you.",
    };
  }

  /* No card, or the music-only launch: the native GGUF build first, because
   * YuE2 through ComfyUI without a card is the slow way to the same song. */
  const nativeFirst = musicOnly || !machine?.gpu;
  const order = nativeFirst ? [gguf, comfyPick()] : [comfyPick(), gguf];
  order.push(ready.find((c) => c.engine === "yue2") || null);
  if (!(vendor === "amd" && !machine?.amdMusicFixed)) order.push(ready.find((c) => c.engine === "minimax-music3") || null);
  order.push(ready.find((c) => c.engine === "ace-step15") || null);
  const pick = order.find(Boolean);
  if (pick) {
    return {
      key, value: pick.engine, checkpoint: pick.checkpoint || null, checkpointBy: pick.checkpoint ? "machine" : null,
      precision: pick.precision || null, chosenBy: "machine", kept: false, ready: true, label: pick.label, model: modelName(pick.label), paid: false,
      why: `Studio picked ${modelName(pick.label)} for music because it is ready on this PC.`,
    };
  }
  const named = choices.find((c) => c.engine === literal && !c.api)?.label || literal;
  return {
    key, value: literal, checkpoint: null, checkpointBy: null, precision: null, chosenBy: "machine", kept: false, ready: false,
    label: named, model: modelName(named), paid: false,
    why: `No music model is ready on this PC yet, so Studio names ${modelName(named)} until one is. The Models screen has them.`,
  };
}
