/**
 * WHICH MUSIC MODEL RUNS WHEN NOBODY CHOSE: the one answer, for the Studio and
 * the launcher alike.
 *
 * Pure, and it imports only cloud-switch.js (which imports only the pure
 * h3tier.js), on purpose. server/fit.js defaultFor("music") answers with it inside Studio;
 * launcher/musiccard.mjs answers with it on the launcher's first screen, which
 * may not import config.js (it computes a whole Studio configuration at import
 * time). Two hand-kept copies disagreed: the launcher went on naming MiniMax
 * Music 3 while Studio ran YuE2.
 *
 * A SAVED CHOICE ALWAYS WINS, ready or not, reported as the person's, with a
 * sentence when its files are missing, never a silent swap. A value carried
 * from a settings file an older Studio wrote on its own (`kept`) wins the same
 * way and is worded "Saved in your settings", because nobody can say it was
 * chosen. The machine never picks a paid row: MiniMax through an API key runs
 * only when the person switched the hosted engine on (Settings → No strong
 * graphics card? → Hosted engine), and the sentence says each song is billed
 * to their key. The YuE2 Python kit only when it is installed and ready.
 *
 * NOTHING READY IS NOT MINIMAX (UI_PLAN A1, INSTALLER_PLAN S5). With no music
 * model on this PC, the answer names the one to get, the way pictures do
 * (fit.js pictureDefault): YuE2 through ComfyUI in Full Studio on an NVIDIA
 * or AMD card (the int8 build the Models screen fetches; on AMD a bf16 build
 * already in models/checkpoints is loaded first, since that is the one
 * measured there), and the native YuE2 GGUF Q4 with no card, on an Intel card
 * (its Vulkan build: the ComfyUI row is listed for NVIDIA and AMD), without
 * ComfyUI, on a PC under the ComfyUI row's own card or RAM minimum, or in the
 * music-only launch. A fresh install used to name
 * MiniMax Music 3 here (config.js's old literal), call it "your selected
 * music engine" and, on AMD, warn about the engine it had picked itself.
 */
import { HOSTED_KEY_PLACE } from "./cloud-switch.js";

/** The hosted engine's switch, in the words on screen. */
const HOSTED_ON = `the hosted engine is on (your switch in ${HOSTED_KEY_PLACE})`;

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

/**
 * YUE2-THROUGH-COMFYUI'S OWN FLOOR on one machine, judged the way server/fit.js
 * fitFor judges any catalogue row: a card under the row's vramMinGb, or RAM
 * under its ramMinGb, will not run. From readings Studio and the launcher both
 * have: the card in whole GB (null: no card read) and RAM as h3tier.js
 * ramBoxGb reads it (null: unread). Studio (index.js, fit.js) and the launcher
 * (launcher/checks.mjs) both call it, so a PC with an 8 GB card and 8 GB of
 * RAM gets one answer on both; server/defaults_test.js holds it to fitFor over
 * a grid of machines. `short` names the half that fell short, for the sentence.
 * Returns { fits: true | false | undefined, short: "card" | "ram" | null }.
 */
export function yue2ComfyFit(requires, { vramGb = null, ramGb = null } = {}) {
  const r = requires || {};
  if (r.experimental) return { fits: undefined, short: null };
  const needVram = Number(r.vramMinGb) || 0;
  const needRam = Number(r.ramMinGb) || 0;
  if (vramGb !== null && vramGb !== undefined && vramGb < needVram) return { fits: false, short: "card" };
  if (ramGb !== null && ramGb !== undefined && needRam && ramGb < needRam) return { fits: false, short: "ram" };
  return { fits: vramGb === null || vramGb === undefined ? undefined : true, short: null };
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
 *   api:     { enabled, provider } | null         the hosted engine, the person's switch
 *   musicOnly
 *   comfy:   ComfyUI is part of this launch (Full Studio; the launcher: an
 *            install was found). Without it, nothing-ready names the GGUF.
 *   comfyFits: false when this PC is under the YuE2-for-ComfyUI row's own
 *            minimum (server/models.js musicYue2Comfy, judged by
 *            yue2ComfyFit above); nothing-ready then names the GGUF too.
 *            Unknown (undefined) is not a no.
 *   comfyShort: "card" | "ram", the half that fell short (yue2ComfyFit), so
 *            the sentence blames the right one. Absent: the card.
 * }
 * Returns { key, value, checkpoint, checkpointBy, precision, chosenBy, kept,
 *           ready, label, model, paid, savedValue, why }.
 */
export function musicDefault({ saved = null, session = null, choices = [], machine = null, api = null, musicOnly = false, comfy = true, comfyFits, comfyShort = null } = {}) {
  const key = "music.engine";
  const vendor = machine?.gpu ? (machine.gpu.vendor || "nvidia") : null;
  /* Paid rows are never a machine pick: only a person turns a key on. */
  const ready = choices.filter((c) => c.available && !c.api);
  const comfyRows = ready.filter((c) => c.engine === "yue2-comfy" && c.checkpoint);
  const comfyPick = () => {
    const name = yue2BuildFor(comfyRows.map((c) => c.checkpoint), vendor);
    return name ? comfyRows.find((c) => c.checkpoint === name) : null;
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
        ? (isReady ? `${said(name)}, through your own API key (${HOSTED_ON}): each song is billed to it.`
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

  /* THE HOSTED ENGINE IS THE PERSON'S SWITCH (Settings → Hosted engine),
   * so with nothing else chosen the hosted MiniMax is theirs, billed to their
   * own key, as it was before defaults followed the disk. The machine never
   * turns it on and never picks it with API mode off. */
  if (paidOn && !musicOnly) {
    const row = apiRow(choices, api);
    return {
      key, value: "minimax-music3", checkpoint: null, checkpointBy: null, precision: null, chosenBy: "you", kept: false,
      ready: !!row?.available, label: row?.label || "MiniMax Music 3 · API", model: "MiniMax Music 3", paid: true,
      why: row?.available
        ? `The hosted engine is on (your switch in ${HOSTED_KEY_PLACE}): songs go to MiniMax Music 3 through your own API key, billed per song.`
        : `The hosted engine is on (your switch in ${HOSTED_KEY_PLACE}), and its key is not ready. Settings has it; Studio does not switch for you.`,
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
  /* NOTHING READY: the one to get, never MiniMax (see the header). The label
   * names the file the Models screen fetches (int8), on AMD too; the sizes
   * are the Models screen's to say, from the catalogue row. */
  const intel = vendor === "intel";
  const viaComfy = !nativeFirst && !intel && comfy !== false && comfyFits !== false;
  if (viaComfy) {
    return {
      key, value: "yue2-comfy", checkpoint: null, checkpointBy: null, precision: "int8", chosenBy: "machine", kept: false,
      ready: false, label: `${NAME_WITHOUT_ROW["yue2-comfy"]} for ComfyUI · int8`, model: NAME_WITHOUT_ROW["yue2-comfy"], paid: false,
      why: vendor === "amd"
        ? "No music model is on this PC yet. Studio picked YuE2 3B through ComfyUI: the Models screen fetches its "
          + "int8 build, which is not yet measured on AMD cards. The bf16 build is the one measured there, so "
          + "Studio loads it first when it is in models/checkpoints."
        : "No music model is on this PC yet. Studio picked YuE2 3B through ComfyUI, the int8 build; "
          + "the Models screen has it.",
    };
  }
  const why = musicOnly ? "the music-only launch runs it natively"
    : !machine?.gpu ? "no graphics card was read, so it runs natively (on the CPU without a card, which is slow)"
    : comfy === false ? "this launch has no ComfyUI, and it runs without one"
    : intel ? "on an Intel card it runs through Vulkan, and YuE2 through ComfyUI is listed for NVIDIA and AMD cards only"
    : comfyShort === "ram" ? "this PC has less RAM than YuE2 through ComfyUI asks for, and the native build asks for none"
    : "this card is under the minimum YuE2 through ComfyUI asks for, and the native build asks for none";
  return {
    key, value: "yue2-gguf", checkpoint: null, checkpointBy: null, precision: "q4_0", chosenBy: "machine", kept: false,
    ready: false, label: NAME_WITHOUT_ROW["yue2-gguf"] + " · Q4", model: NAME_WITHOUT_ROW["yue2-gguf"], paid: false,
    why: `No music model is on this PC yet. Studio picked YuE2 GGUF Q4, because ${why}; the Models screen sets it up.`,
  };
}
