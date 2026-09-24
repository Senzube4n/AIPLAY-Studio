/**
 * THE CAPABILITY CATALOGUE — one document, two readers.
 *
 * The owner's ask was "a kind of onboard welcome window displaying what is
 * what, what can be done with this studio", and separately "MCP controllable so
 * an agent can tab into it". Those are the same document or they are two
 * documents that will disagree by Friday. This file is that document: the
 * welcome window renders it, `studio_capabilities` returns it, and neither of
 * them writes a sentence of its own.
 *
 * That is the binding rule of this repo applied to PROSE rather than to
 * actions. web/daw.js states it for gestures — everything MCP-controllable and
 * completely human-adjustable, one document behind both. A capability list is
 * the thing most likely to grow a second copy (a marketing page here, a tool
 * description there), and the second copy is always the one that is wrong.
 *
 * WHAT IS TYPED HERE AND WHAT IS READ:
 *
 *   TYPED — the per-tab paragraphs. They are prose in the app's own voice and
 *     nothing can derive them. They are lifted in substance from the About
 *     page's honesty list (web/index.html), which is where this app already
 *     says what each screen does and what it cannot do, and extended to the two
 *     screens that list never covered: Workflow and the DAW.
 *
 *   READ — everything with a number or a licence in it. Engine names, sizes,
 *     measured wall-clocks and step machinery come from server/config.js;
 *     licence class, quoted clause and territory come from the CATALOG in
 *     server/models.js. A licence sentence retyped here would be a licence
 *     sentence that goes stale silently, and this app's whole posture on rights
 *     is that the user reads the publisher, never our summary.
 *
 * THE `cant` LINES ARE NOT DECORATION. Every tab carries one. The About page
 * says why: "an app that only tells you what it does well is advertising."
 * A welcome screen is exactly where that temptation is strongest, so the shape
 * of the data makes an honest limit mandatory — catalogue_test.js fails a tab
 * that has no `cant`.
 */
import { config } from "../config.js";
import { RUNGS as YUE_RUNGS } from "../music/yue_fit.js";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel, modulesOf } from "../models.js";
/* The compositor's own vocabulary. "Ten kinds of layer" was TYPED here while
 * the list had grown to eleven — an audio layer was added to vfx/store.js and
 * this sentence went on saying ten, because nothing checks a word. A count in
 * prose is a number like any other: read it. */
import { LAYER_TYPES } from "../vfx/store.js";
/* Where the commit point is computed for the Video lab's panel. The sigma
 * figures in the quality block are that same arithmetic rather than a second
 * copy of a table, so they follow the sigma shift if it is ever re-measured. */
import { commitSigma, COMPARE_CONFIGS } from "../videolab/catalog.js";
/* No strong card? Friend first, then your own key: the order is one list. */
import { NO_STRONG_CARD, LENDING_UNTRIED } from "../cloud-switch.js";

/* ── counts, spelled ─────────────────────────────────────────────────────────
 *
 * This page says "eleven kinds of layer", not "11 kinds of layer", because it
 * is written prose. That is the only reason these two lines exist: a spelled
 * number is still a number, and a number in this file is read from its source
 * or it is a claim waiting to go stale. The few that sit in COMMENTS, where
 * nothing can interpolate them, are pinned in catalogue_test.js instead.
 */
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
               "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
               "seventeen", "eighteen", "nineteen", "twenty"];
const count = (n) => WORDS[n] ?? String(n);
const Count = (n) => { const w = count(n); return w[0].toUpperCase() + w.slice(1); };

/**
 * Bump when a NEW capability appears that an existing user has never been told
 * about. The stored `welcome.seenVersion` is compared against this, so a bump
 * re-opens the window once for people who already dismissed it — and leaving it
 * alone is the difference between "we added a tab" and "we nagged everybody".
 * It is not a build number; do not bump it for copy edits.
 */
export const WELCOME_VERSION = "1";

/* ── what each screen NEEDS ─────────────────────────────────────────────────
 *
 * The owner: "for each component we need to show a little Info part which
 * explains the page and shows what you need for models or other dependencies."
 *
 * A need is an IDENTITY and never a description. Three kinds, and each one
 * names a thing some other file already defines:
 *
 *   model    a capability id from server/models.js CATALOG
 *   engine   a video-engine key from config.video.engines, which resolves to a
 *            capability through MODEL_TO_CAPABILITY
 *   package  the name of a python module server/index.js already probes
 *
 * Everything a reader actually wants to know — the label, the download size,
 * the licence, whether the files are on disk, whether THIS card can run it — is
 * joined on at read time from /api/models, the same builder the Models screen
 * reads. Not one fact about a model is written down twice here, which is the
 * only reason this panel cannot drift from that screen.
 *
 * THE IDS ARE DERIVED WHERE DERIVING IS POSSIBLE, for the reason server/fit.js
 * gives in its own header: a third video engine added to config.js must show up
 * on the Video screen's panel on the same commit, or the panel is lying by
 * omission. So the video and image sets are the config crossed with the map,
 * exactly as fit.js crosses them, rather than a list somebody keeps in step by
 * hand.
 *
 * PACKAGES ARRIVE FOR FREE wherever a capability declares one. `needsPackage`
 * is already in models.js — stems needs demucs, timed lyrics needs
 * faster_whisper, the audio reference needs av — so a screen that needs the
 * model needs the package by consequence, and the strings "demucs" and
 * "faster_whisper" are typed nowhere in this file.
 *
 * ⚠ THE PROBE IS NOT COMPLETE AND THIS FILE MUST NOT PRETEND IT IS.
 * server/index.js probes five modules. Two screens import more than five at the
 * top of their python, and those imports are every bit as required. They are
 * NOT in `needs` below, because a need this app cannot check is a claim rather
 * than a fact and the gate only admits needs it can resolve.
 *
 * EXCLUDING THEM FROM `needs` IS THE RIGHT RULE. SAYING NOTHING WAS NOT.
 * A panel that lists two packages for a screen whose engine imports four reads
 * as complete and is not — which is the one failure this whole file exists to
 * prevent. So the remainder is named in that screen's `needsNote`, which is the
 * field that exists for exactly this: a dependency that is real, that Studio can
 * neither fetch nor check, and that a reader must therefore be told about in a
 * sentence rather than shown as a badge.
 *
 * Each module is written down once — a probed one in a `pkg()` need, an
 * unprobeable one in the note — and catalogue_test.js reads the python itself
 * and fails the commit if a module-level import of either engine is in neither.
 * The day index.js probes one of them it moves from the note into a `pkg()`,
 * and the badge starts answering for it instead of the sentence.
 */
/**
 * THE READINESS VOCABULARY, and it lives here for the same reason FIT_STATES
 * lives in server/fit.js: four words on a badge are prose, and prose written in
 * a page is prose an agent never sees.
 *
 * It is a SEPARATE axis from fit and must stay one. "On disk" and "fits your
 * machine" answer different questions — a model can be downloaded and too big
 * for the card, or a perfect fit and 21 GB away — and collapsing them into one
 * chip is how somebody spends an evening waiting for a download that was never
 * going to run. The panel shows both, side by side, from their two sources.
 *
 * `tone` is the same four-value vocabulary fit.js uses, because web/modelfit.css
 * already dresses `.fitbadge.fit-<tone>` and a second palette here would be a
 * second design starting.
 *
 * TWO FLAGS, AND THEY ARE HERE BECAUSE THE PAGE HAD THEM AS LISTS OF NAMES.
 * Both were a state name typed into web/info.js, and a page that keeps its own
 * copy of which states are special goes stale the moment a state is added —
 * silently, because nothing renders differently until somebody hits the state
 * that was left off the list.
 *
 *   `inline`         the sentence must be SHOWN in the row rather than left on
 *                    the chip's tooltip. The typed list held three names and
 *                    `via-package` was not one of them, so the one state whose
 *                    chip reads "Ready" while meaning "its package downloads the
 *                    weights on first run" had a sentence nothing could render.
 *
 *   `nothingToFetch` there is no download outstanding for a person to start —
 *                    either every file is already here, or Studio was never
 *                    going to be the one fetching them. It decides two things on
 *                    the row: whether the size shown is the whole size or the
 *                    remainder, and whether a gated repository's hand-fetch
 *                    steps are worth showing. The typed version of it was
 *                    `state !== "ready" && state !== "via-package"`, which meant
 *                    the new "files here, package missing" state would have gone
 *                    back to telling somebody holding all 39.7 GB of a model how
 *                    to go and download it.
 *
 * A state that needs explaining, or that means the fetching is done, is the
 * thing that knows it — so it says so, once, here.
 */
export const NEED_STATES = {
  "ready": {
    tone: "ok", chip: "On disk", nothingToFetch: true,
    line: "Every file this needs is already downloaded.",
  },
  "partial": {
    tone: "warn", chip: "Part downloaded",
    line: "Some of its files are here and some are not — it will not run until the rest arrive.",
  },
  "missing": {
    tone: "bad", chip: "Not downloaded",
    line: "Studio never downloads anything on its own. Open the Models screen and ask for it.",
  },
  /* THE AWKWARD ONE, and web/app.js's model row learned it the expensive way:
   * a capability whose weights come down through its own python package has no
   * files Studio fetches, so a size beside no button read as "3.09 GB to
   * download" with nowhere to download it from. Say what actually happens. */
  "via-package": {
    tone: "ok", chip: "Ready", inline: true, nothingToFetch: true,
    line: "Not a Studio download: its Python package fetches the weights itself, once, the first "
        + "time it runs. The size beside this is what that first run will pull.",
  },
  "needs-package": {
    tone: "warn", chip: "Needs its package", inline: true,
    line: "The weights are not a download at all — they arrive with the Python package below, and "
        + "that package is not installed yet.",
  },
  /* THE ONE THE LADDER USED TO SWALLOW. Weights on disk and the module that
   * runs them missing is not "On disk" in any sense a reader means it: the row
   * was green, the package row underneath was red, and the two together said
   * nothing about whether the thing works. It does not. */
  "ready-no-package": {
    tone: "warn", chip: "Files here, package missing", inline: true, nothingToFetch: true,
    line: "Every file it needs is downloaded, and the Python module it runs through is not "
        + "installed — so it will not run yet. What is missing is the package below, which is a "
        + "pip install rather than a download.",
  },
  "installed": {
    tone: "ok", chip: "Installed",
    line: "The Python module imports in the interpreter Studio probes.",
  },
  "absent": {
    tone: "bad", chip: "Not installed", inline: true,
    /* "the interpreter named below", not "your SYSTEM Python": every package
     * row carries the python it was probed in (routes.js interpreterLine), and
     * for timed lyrics that is Studio's whisper venv. "SYSTEM Python" there
     * sent people to install into the python that never runs it. */
    line: "A pip install rather than a download — Studio cannot fetch this one for you. It goes in "
        + "the interpreter named below, never ComfyUI's, because installing it there can move the "
        + "torch build the engine depends on.",
  },
  "unknown": {
    tone: "unknown", chip: "Cannot tell", inline: true,
    line: "The model catalogue could not be read just now, so nothing is claimed either way.",
  },
};

/**
 * WHICH OF THOSE WORDS A CAPABILITY GETS, and it lives beside them on purpose.
 *
 * The ladder was in server/welcome/routes.js, inline in the join, and it read
 * `packageReady` only inside the `managedByPackage` branch. So a capability
 * whose WEIGHTS are all on disk and whose python package is missing — stems
 * without demucs, timed lyrics without faster-whisper, the audio reference
 * without av — fell through to `ready` and was badged green "On disk". It is
 * not on disk in the sense the badge means: it cannot run. Proven live by
 * pointing AIPLAY_SYS_PYTHON at an interpreter that does not exist.
 *
 * A pure function of one capability, exported, so catalogue_test.js can walk
 * every branch with a fabricated object — no server, no card, no disk. That is
 * the whole reason it is not a ternary in the join any more.
 *
 * `packageReady` is compared against `false` rather than trusted for truthiness:
 * server/index.js sends `true` for a capability that declares no package at all,
 * and an older server that sends the field not at all must read as "nothing
 * claimed", never as "missing".
 */
export function needState(cap) {
  if (!cap) return "unknown";
  if (cap.managedByPackage) return cap.packageReady ? "via-package" : "needs-package";
  if (!cap.ready) return cap.haveBytes > 0 ? "partial" : "missing";
  return cap.packageReady === false ? "ready-no-package" : "ready";
}

const need = (kind) => (id, why) => ({ kind, id, for: why });
const model = need("model");
const videoEngine = need("engine");

/**
 * A package this screen imports directly, and THE LINE A PERSON TYPES.
 *
 * The command is an argument because a package typed here belongs to no
 * capability, so there is nothing to read it off. Two consequences, both of
 * them defects the panel actually had:
 *
 *   numpy is declared by no capability at all, so the row said "Not installed"
 *   with nothing underneath it to type — a dead end on the one row whose whole
 *   content is a command.
 *
 *   `av` IS declared by a capability, the audio reference, whose install is
 *   `pip install numpy torch av` — so the compositor's `av` row was offering a
 *   torch install to somebody whose screen has nothing to do with torch. A
 *   package name matching is not ownership.
 *
 * Written once, here, because nothing else in the repo says it: models.js's
 * `packageInstall` belongs to the capability that declares the package, and
 * these two are not that. Never derive it from the module name — models.js has
 * its own note about `faster_whisper` importing under one name and installing
 * under another.
 */
const pkg = (id, why, install) => ({ kind: "package", id, for: why, install });

/* Found by `required`, not by id — the same way fit.js finds it, so a second
 * required capability is picked up rather than quietly left off every panel.
 * Since the music need follows the SELECTED engine (selectedMusicCapability
 * below), this is only its fallback: the catalogue's default engine, for a
 * saved engine name that maps to no row. */
const REQUIRED_IDS = CATALOG.filter((c) => c.required).map((c) => c.id);
const VIDEO_ENGINE_KEYS = Object.keys(config.video.engines);
/* THE ROWS THAT SAY THEY MAKE PICTURES — the same one rule fit.js asks, so the
 * screen and the recommendation cannot disagree about what a picture model is.
 *
 * It was a subtraction on both sides until 2026-09-03 ("every capability the
 * engine map names, minus the video ones, minus the required one"), and the two
 * copies agreeing is exactly what hid the defect: bridging the control models
 * into that map listed WAN 2.1 VACE and DWPose on THIS screen under "any one
 * picture model will do", and welcome/catalogue_test stayed 75/0 because
 * fit.js's identical subtraction agreed with it. See isPictureModel() in
 * models.js for why the rule is positive now. */
const IMAGE_CAP_IDS = CATALOG.filter(isPictureModel).map((c) => c.id);

/* THE MUSIC ENGINE THIS INSTALL HAS PICKED, not the catalogue's default one.
 * This was REQUIRED_IDS, i.e. always MiniMax Music 3, under "the one download
 * that is not optional"; the Models screen badges the selected engine, so on a
 * YuE2 install the panel named MiniMax as not optional beside no required chip
 * and never mentioned YuE2. Kind "music" is resolved in resolveNeeds() at the
 * moment the panel is asked, because the selection changes while Studio runs. */
const MUSIC_NEEDS = [need("music")("selected",
  "the song itself: Studio needs one music engine, the one picked in Music, not every one")];
/* The video engines whose licence leaves out whole territories, by their own
 * rows' `region`: the Video card names them rather than saying "one of them". */
const REGION_LOCKED_VIDEO = VIDEO_ENGINE_KEYS
  .filter((k) => CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY[k])?.region?.excluded?.length)
  .map((k) => config.video.engines[k].label);
const REGION_CLAUSE = !REGION_LOCKED_VIDEO.length ? ""
  : REGION_LOCKED_VIDEO.length === 1 ? `, and ${REGION_LOCKED_VIDEO[0]} excludes whole territories`
  : `, and ${REGION_LOCKED_VIDEO.slice(0, -1).join(", ")} and ${REGION_LOCKED_VIDEO.at(-1)} each exclude whole territories`;
const VIDEO_NEEDS = VIDEO_ENGINE_KEYS.map((k) =>
  videoEngine(k, "whichever engine you render with; one is enough"));
const IMAGE_NEEDS = IMAGE_CAP_IDS.map((id) =>
  model(id, "any one picture model will do — this is the whole choice"));

/**
 * The capability row of the music engine config.music.engine names, through the
 * same MODEL_TO_CAPABILITY map every other engine need goes through. A saved
 * name that maps to nothing falls back to the catalogue's default engine, so the
 * panel still names a real download rather than none.
 */
function selectedMusicCapability(music = config.music) {
  return MODEL_TO_CAPABILITY[music?.engine] ?? REQUIRED_IDS[0] ?? null;
}

/* The "music" placeholder, made an ordinary model need for the selected row.
 * ONE resolution for BOTH doors a need leaves by: resolveNeeds() (the Info
 * panel, studio_screen_info) and catalogue() (the tour, /api/welcome and
 * studio_capabilities). The catalogue used to hand TABS out raw, so an agent
 * reading studio_capabilities got {kind:"music", id:"selected"}, which is not a
 * capability id, where the same entry had named the real row before. */
const resolveMusicNeed = (n) => (n?.kind === "music" ? model(selectedMusicCapability(), n.for) : n);

/**
 * One need, resolved to WHAT IT POINTS AT — never to what this machine can run.
 *
 * The split matters. This half is pure and lives beside the prose, so
 * catalogue_test.js can prove every need on every screen names something real
 * without a server, a card or a disk. The other half — is it downloaded, does
 * it fit this card, is the package importable — is live, belongs to
 * /api/models, and is joined on in server/welcome/routes.js. The one input
 * read at call time is config.music.engine, for the music need: a choice the
 * person made, not a fact about the machine, and still no disk is touched.
 *
 * A model whose capability declares `needsPackage` expands into TWO needs: the
 * weights and the pip install. Reading it off the capability is what keeps the
 * package names out of this file.
 *
 * THE PACKAGE ROW CARRIES ITS OWN COMMAND FROM HERE, and that is the fix for a
 * join that used to go looking for one. The command a person types comes from
 * the capability that expanded into this row, or — for a package a screen
 * imports on its own account — from the `pkg()` beside the prose. What it must
 * never come from is "the first capability in the catalogue that happens to
 * name the same module", which is how the compositor's `av` row ended up
 * offering to install torch.
 */
export function resolveNeeds(tab) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    const key = `${n.kind}:${n.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const raw of tab?.needs || []) {
    // The selected music engine becomes an ordinary model need for its row.
    const n = resolveMusicNeed(raw);
    if (n.kind === "package") {
      push({
        kind: "package", id: n.id, for: n.for, package: n.id, capability: null,
        /* No capability declares this one, so nothing is unlocked BY it that
         * this file could name — the screen it is typed on is the answer to
         * "what for", and that is `for`. */
        install: n.install ?? null, unlocks: null,
      });
      continue;
    }
    /* An engine key is not a capability id — h3 is the key, `video` is the
     * capability. One map, in models.js, rather than a ternary retyped at each
     * of the places that needed it (index.js's own words, where a third engine
     * used to resolve silently to H3's row). */
    const capability = n.kind === "engine" ? (MODEL_TO_CAPABILITY[n.id] ?? null) : n.id;
    const cap = CATALOG.find((c) => c.id === capability) || null;
    push({ kind: n.kind, id: n.id, for: n.for, capability, package: null });
    /* One row per module that must import (`needsModules`, else the one
     * `needsPackage`): timed lyrics needs stable_whisper as well as
     * faster_whisper, and a panel showing only the second said "installed"
     * over a feature that could not run. */
    for (const mod of modulesOf(cap)) {
      push({
        kind: "package", id: mod, package: mod, capability: null,
        /* Derived from the capability that declares it, so this sentence names
         * whatever model the map points at rather than a label typed beside a
         * module name that could stop being true. */
        for: `${cap.label.split("—")[0].trim()} is a pip install, not a download`,
        /* From the capability that expanded into this row, not from a search
         * for the module name. Both are models.js's own words. */
        install: cap.packageInstall || null,
        unlocks: cap.label || null,
      });
    }
  }
  return out;
}

/** The screen a view id names, or null. The one lookup both surfaces use. */
export function screenFor(view) {
  return TABS.find((t) => t.id === String(view || "")) || null;
}

/* ── what this is ───────────────────────────────────────────────────────── */

const IDENTITY = {
  name: "AIPLAY Studio",
  lead:
    "A music and video studio that lives on your own computer. You describe a song and it gets "
    + "written, sung and mixed here, on your graphics card. You can draw pictures, render video "
    + "clips, arrange them into a track, composite the way a motion designer does, and put all of "
    + "it together into a finished music video — without an account, without a subscription, and "
    + "without your work ever leaving your machine.",
  promise: [
    "Local-first. No upload, no cloud render, no server that can lose your library or change its terms.",
    "Open source, Apache-2.0. No model weights ship inside it, and every model's licence is shown before anything is downloaded.",
    "Yours. The studio takes no rights over what you make; the models you run have their own terms, and those are shown to you rather than summarised away.",
    "Agent-drivable. Every tool a person can click is a tool an assistant can call over MCP — including the one that returned this page.",
  ],
};

/* ── where do I start ───────────────────────────────────────────────────── */

const START = [
  { what: "Or just say what you want", where: "Chat, under More tools",
    detail: "Describe what you want to make and it uses the studio for you, asking before it spends time on the graphics card." },
  { what: "Get the music model", where: "Models",
    detail: "The only required download. Its licence is shown before a byte is fetched." },
  { what: "Make your first song", where: "Music",
    detail: "Describe it in a sentence or two and press Create. Four to five minutes for a three-minute track; a cover picture arrives on its own." },
  { what: "Give it a picture", where: "Pictures",
    detail: "Generate a look, then open it in the editor — layers, curves, cutout, type. The original is never overwritten." },
  { what: "Make it move", where: "Video, then Studio",
    detail: "Render a clip or two, drop them on the timeline over the song, switch on the karaoke overlay, press Export." },
  /* THE WEAK-CARD ANSWER, in the owner's order: a friend's card before any
   * paid route (2026-09-24). Read from server/cloud-switch.js, so this page,
   * Settings and cloud_status cannot put them the other way round. */
  { what: "No strong graphics card?", where: NO_STRONG_CARD.map((w) => w.where).join(", then "),
    detail: NO_STRONG_CARD.map((w, i) => `${i + 1}. ${w.title}. ${w.how}`).join(" ") },
  { what: "Or hand the whole thing to an assistant", where: "Agent",
    detail: "Paste the MCP snippet into your assistant's config. After that, \"make me a music video\" is a sentence rather than a project." },
];

/* ── one paragraph per tab ──────────────────────────────────────────────────
 *
 * Order is the rail's order, because that is the order a new user meets them
 * in. `group` is the only editorial judgement here: twenty-six paragraphs in a row
 * is a wall, and three headings turn it into a shape.
 */
const TABS = [
  {
    id: "home", icon: "⌂", name: "Home", group: "make",
    lead: "The first page: the studio's mark and one row of ways in — Chat, Music, Video, Pictures and Explore.",
    makes: ["A place to start"],
    start: "Pick what you want to make.",
    needs: [],
    cant: "It does nothing on its own; every button opens another screen.",
  },
  {
    id: "chat", icon: "◗", name: "Chat", group: "make",
    lead:
      "Say what you want to make, in ordinary words, and it does it — writes and renders a song, "
      + "looks through what you have already made, starts a music-video project, blocks a shot in "
      + "Blender. The model answering you is Qwen3-4B, running on your own graphics card; nothing "
      + "you type here leaves this machine and there is no account and no key. It is the one "
      + "screen you can use without already knowing which of the others your idea belongs on.\n"
      + "Anything that costs time on the graphics card is PROPOSED rather than done: it shows you "
      + "the exact settings and what they cost, and waits for you to say yes.",
    makes: ["Songs, described in a sentence", "A music-video project to build in", "Blocked-out shots to watch before spending on a render", "Answers about what is already on this disk"],
    start: "Type what you want to make and press Enter.",
    needs: [
      /* The chat model IS the 8.7 GB text encoder that came down with the cover
       * artist — one file, already on this disk for most people, and saying so
       * is more honest than listing a separate download that does not exist. */
      model("coverArt", "the local language model this chat runs on — its text encoder IS the model"),
    ],
    needsNote:
      "No separate download. The model behind this chat is qwen_3_4b.safetensors, the text encoder "
      + "the cover artist already needs, so a machine that can draw covers can already chat.",
    cant:
      "It is a 4-billion-parameter model on a home graphics card, not a frontier assistant: it carries "
      + "eight written tools and reaches the rest of the studio's 241 a few at a time, matched to what "
      + "you asked, because the whole library at once is three times more than it can read. It cannot "
      + "see your screen and it will not spend GPU time without "
      + "being told yes. And it shares one card with every render — while a clip is generating, this "
      + "screen says so and waits rather than queueing behind it.",
  },
  {
    id: "create", icon: "♪", name: "Music", group: "make",
    lead:
      "Describe a song's style and lyrics, then create a new performance with your selected model. "
      + "Keep several takes, pull stems and timed lyrics, and export finished audio. "
      + "Generation time and supported controls depend on the selected runtime.",
    makes: ["Songs with vocals", "Instrumentals on supported backends", "Stems and timed lyrics"],
    start: "Write a style and lyrics, then press Create. To build on an existing idea, open Music Lab.",
    needs: [
      ...MUSIC_NEEDS,
      model("coverArt", "the cover picture painted for every finished track"),
      model("stems", "pulling the vocals, drums and instruments apart"),
      model("lyrics", "timing the words, so the karaoke overlay lands on the beat"),
      model("audioRef", "starting a song from a piece of audio you already have"),
    ],
    cant:
      "No piano roll: you steer with words, and takes vary. Everything shares the graphics card.",
    /* HOW EACH ENGINE RUNS, moved off the Make button (UI_PLAN C2: "no
     * rationale in the UI"). The receipt under Create says what will happen;
     * this says why it takes what it takes. Numbers read from config.js. */
    howItRuns: [
      "YuE2 through ComfyUI keeps the model loaded between songs, so only the first song after a start waits for it to load.",
      "The YuE2 Python kit starts a fresh Python process for every song and reloads the model each time, so every song pays for the load.",
      /* Both measured ratios come from the Long rung itself (music/yue_fit.js),
       * the one place they were measured into. */
      `Longer YuE2 songs (Python kit) use the configuration measured to reach them: the ${config.yue.queryChunk}-token `
        + "prefill block, plus the model's first half off the card during the solve. "
        + (YUE_RUNGS.find((r) => r.id === "long")?.costs?.[0]
          || `It is slightly slower than the standard ${config.music.engines.yue2?.realtimeRatio}× the song's length, and the same audio.`),
      "MiniMax Music 3 keeps what it worked out for a take, so a re-roll of the same song runs about 3× faster than the first render.",
    ],
  },
  {
    id: "router", icon: "☁", name: "Comfy API", group: "make",
    lead:
      "The launcher's Use Comfy API mode: image, video, audio, 3D and text models from many providers, "
      + "run on Comfy's cloud through Comfy Router with your own Comfy API key. Nothing runs on this "
      + "machine, so it needs no ComfyUI and no graphics card, and every run costs Comfy credits, which "
      + "is why it lives in its own mode and asks before each run. Featured models have a short form; "
      + "every other model gets a form built from its published fields, or its raw JSON.\n"
      + "It is the paid way, and the second one: without a strong card, ask a friend with one to render "
      + `for you first (Collab, free; ${LENDING_UNTRIED}).`,
    makes: ["Pictures, clips, sound and speech from hosted models", "3D models from a description", "Answers from hosted language models"],
    start: "Save your Comfy API key, pick a kind and a model, and press Run.",
    needs: [],
    needsNote: "A Comfy API key with credits, from platform.comfy.org. No model files.",
    cant:
      "It spends real credits and cannot quote a price before a run; the Router reports a cost after "
      + "some runs and not others, and your Comfy workspace has the full usage. Results are downloaded "
      + "as they finish, because their links expire within a day. It cannot make a music video: the mode "
      + "has no Music, Music video or Collab screen, and its results do not reach a project's scenes.",
  },
  {
    id: "musiclab", icon: "♫", name: "Music Lab", group: "make",
    lead:
      "Build on songs you already have. Compare chorus alternatives in the context of the song, keep reusable "
      + "episode themes and their cue variants, turn reference audio or footage into a reviewed music brief, "
      + "replay a saved plan, tokens or sound, and blind-test a trained LoRA against the base model.",
    makes: ["Chorus alternatives with contextual playback", "Saved episode themes and cue variants", "Reviewed music briefs from audio or footage", "Replayed stages", "Blind base-vs-LoRA comparisons"],
    start: "Pick a tab at the top. Anything ready to render loads back into the Music form.",
    needs: [...MUSIC_NEEDS],
    cant:
      "Reference media is analyzed into an editable brief or score; YuE2 does not natively watch footage. "
      + "A saved score does not guarantee the same singer, waveform, duration or exact synchronization. "
      + "Supplied-score themes currently require Python YuE2 or native GGUF.",
  },
  {
    id: "images", icon: "▣", name: "Pictures", group: "make",
    lead:
      "Makes pictures — standalone or as cover art — and opens them in a full image editor: layers and "
      + "blend modes, curves and levels, brushes, selections, one-click background cutout, a type tool, "
      + "and export in seven formats. Every committed edit renders on the server into a NEW file, so the "
      + "original is never destroyed.",
    makes: ["Cover art", "Reference stills to seed video from", "Edited and composited pictures", "Contact sheets and character sheets"],
    start: "Write a prompt, pick a size, generate. Then click the picture to edit it.",
    needs: [
      ...IMAGE_NEEDS,
      model("imageCutout", "the one-click background removal in the editor"),
      model("upscale", "the editor's ×2 upscale"),
    ],
    cant:
      "No CMYK and no print pipeline — everything is RGB, made for screens. Ideogram 4's agreement is "
      + "behind a login nobody here has been through, so what it says about selling the picture is "
      + "genuinely unknown; the app labels it that way rather than guessing, and does not stop you either way.",
  },
  {
    id: "video", icon: "▷", name: "Video", group: "make",
    lead:
      "Renders short video clips from a text prompt or from a picture you already made, on your own "
      + "machine, and keeps them in a searchable library grouped by song, day or engine. "
      + `${Count(Object.keys(config.video.engines).length)} engines are `
      + "supported and they are genuinely different tools — different frame rules, different valid sizes, "
      + "different cost curves and different licences. The size you pick is the single biggest decision "
      + "on this screen; see \"what size, and why\" below.",
    makes: ["Clips from a prompt", "Clips continued from one of your pictures", "Clips with their own generated audio (LTX)", "Longer pieces, as several renders chained"],
    start: "Pick an engine, pick a size, write the shot, render. Start at two seconds while you find the prompt.",
    needs: [
      ...VIDEO_NEEDS,
      model("videoRefs", "continuing a clip out of one of your own pictures"),
      model("interpolate", "the smoother / slow-motion pass on a finished clip"),
      model("upscale", "the bigger pass on a finished clip"),
    ],
    cant:
      "Each engine is a separate multi-gigabyte download with its own licence and its own hardware "
      + `appetite${REGION_CLAUSE}. One render is seconds of video and minutes `
      + "of waiting.",
  },
  {
    id: "daw", icon: "▭", name: "DAW", group: "make",
    lead:
      "A real arrangement window — tracks, a piano roll with its own ruler, mixed meter, a mixer with "
      + "sends and returns, automation lanes, sampled instruments and a mastering chain. It renders on "
      + "the server, so what you monitor IS the bounce: the browser never synthesises a note, it plays "
      + "the file the server made. An assistant editing the project over MCP writes the same document "
      + "this window is looking at, and the change appears while you watch it, tagged with who made it. "
      + "A badge in the transport says whether the next stretch of music will be rendered in time, in "
      + "the machine's own measured numbers, before you get there.",
    makes: ["Arrangements you wrote note by note", "Bounces — WAV and FLAC", "Recorded takes from a microphone or an instrument", "A critique pass from the Ear that names bars and bands"],
    start: "Open the DAW, make a project, add an instrument track and draw a few notes.",
    /* No weights at all — every sound here is synthesised or sampled by code
     * this repo ships. What it does need is the numerical stack the render runs
     * on, and saying so is the difference between "the DAW is silent" and "the
     * DAW is silent because numpy is missing". */
    needs: [pkg("numpy", "the server-side render — the browser never synthesises a note",
      "python -m pip install numpy")],
    /* The two the probe cannot see. See the ⚠ above this file's need helpers:
     * they are kept out of `needs` because nothing can check them, and named
     * here because leaving them out entirely is how a one-package list reads as
     * the whole story. catalogue_test.js proves this sentence against the
     * imports in server/daw/*.py. */
    needsNote:
      "Two more Python packages, which Studio cannot check for you. SciPy: imported at the top of the "
      + "render engine, the drum synth, the effects rack and the mastering chain, so nothing bounces "
      + "without it. And soundfile, which the sampled instruments and the mastered bounce read their "
      + "audio through. One line covers both, run with the engine's own python rather than a system "
      + "Python on PATH: \"<engine python>\" -m pip install scipy soundfile, where <engine python> is the "
      + "path shown under the launcher's \"ComfyUI install\" row (…\\venv\\Scripts\\python.exe in an "
      + "engine Studio installed, python_embeded\\python.exe in the portable ComfyUI). An engine Studio "
      + "installs for you comes with both.",
    /* The O(prefix) fact, in the same voice as the sentence above it. It is
     * the one thing about this screen that reads as a bug until it is named:
     * rack.chain_graph renders from absolute sample 0 every time — the rule
     * that makes a region's bytes the bounce's bytes — so the same four bars
     * cost more the deeper into the song they sit. Measured on a 128-bar,
     * 7-track project with five stateful inserts: 305 ms for bars 1-4 and
     * 11 068 ms for bars 125-128, against 7 500 ms of audio per region. */
    cant:
      "It is not a live-performance instrument: there is no client-side audio engine, so a note you draw "
      + "is heard after the server renders it. And once a project has a mixer chain, a stretch of music "
      + "renders more slowly the deeper into the song it is — the chain is rebuilt from the first sample "
      + "every time, which is exactly what makes what you hear identical to the bounce. On a 128-bar "
      + "track with five live inserts that is a third of a second for bars 1-4 and eleven seconds for "
      + "bars 125-128, against seven and a half seconds of music. The transport's readiness badge says "
      + "which bars will arrive late before you reach them; bounce, or simplify the chain. "
      + "Matching a reference track measures its SHAPE and never copies it: dB, milliseconds and "
      + "counts, per stem and for the mix, with no audio and no melody taken out of it — so it can "
      + "make a mix sit like a record and cannot make it sound like that record's parts. It needs the "
      + "track separated into four stems first, which is the Stems capability's demucs and not a "
      + "dependency of this screen. It opens as "
      + "its own page rather than a tab, because it owns a window's worth of chrome and its own transport.",
  },

  /* THE ONE SCREEN IN THE "make" GROUP THAT GENERATES NOTHING, and the paragraph
   * has to carry that or the reader arrives expecting a character creator. It is
   * in "make" rather than "run" because it does put a new file on your disk — a
   * validated GLB and its manifest — and because that is where the rail puts it,
   * directly after the DAW. */
  {
    id: "avatars", icon: "◇", name: "3D", group: "make",
    lead:
      "Import a self-contained GLB or VRM 1.0 avatar, inspect its skin and test its movement. "
      + "VRM models retain their embedded expressions, toon materials and spring-bone hair. "
      + "Choose existing parts, adjust colours, save named looks and control them through MCP. "
      + "Preview local voice audio with loudness-driven mouth motion and MCP playback. The transparent overlay follows the active look. Model files, manifests and looks export separately.",
    makes: ["Validated local avatar assets", "Saved looks with expressions and hair settings", "A transparent browser overlay", "Original model and manifest handoffs"],
    start: "Try anime sample, or import a rigged model. Use Test movement and save a look.",
    /* Runtime dependencies ship through npm. The curated reference model is
     * a separate, explicit download; this page needs no generation weights. */
    needs: [],
    cant:
      "Looks configure components already inside the model. This page does not fit arbitrary outfits, "
      + "create face or hair rigs, generate dance clips or infer phonemes from speech. "
      + "Image-to-3D and local body rigging remain in Music video. VRM workshop and World GLB use separate "
      + "import budgets; local VRM acceptance does not grant Agent World admission. A persona ID is "
      + "local attribution, not account ownership. Review deformation visually before handoff.",
  },

  {
    id: "workflow", icon: "❖", name: "Music video", group: "assemble",
    lead:
      "The music-video pipeline, as a project rather than a pile of files. It cuts the song into scenes, "
      + "holds a brief and a bible (the cast, the places, the rules the whole video obeys), storyboards "
      + "every scene, renders character sheets and background plates, keeps every take, and tracks what "
      + "went stale when you changed your mind. Planning here is free; only rendering costs the card. "
      + "Audiobooks use the same machinery with a different last step.",
    makes: ["A scene-by-scene plan bound to the song's bars", "Character sheets and background plates that stay consistent", "Storyboards that name the shot", "A timeline handed to Studio to finish"],
    start: "New video…, attach a song, segment it, then write the brief before rendering anything.",
    /* Planning is free and needs nothing. Everything this screen RENDERS it
     * renders with the Images and Video engines, so its needs are theirs —
     * spread from the same derived sets rather than restated, which is why a
     * new engine reaches this panel too. */
    needs: [
      ...IMAGE_NEEDS,
      ...VIDEO_NEEDS,
      model("narration", "the audiobook path's spoken track"),
      model("sfx", "sound-effect cues under a scene"),
    ],
    cant:
      "Consistency is a discipline the pipeline enforces, not a guarantee the model gives: names must be "
      + "declared before a board may use them, and re-segmenting is destructive — it versions the scene "
      + "set and marks boards and clips stale on purpose.",
  },
  {
    id: "vfx", icon: "◈", name: "VFX", group: "assemble",
    lead:
      `An After-Effects-class compositor: ${count(LAYER_TYPES.length)} kinds of layer, `
      + "keyframes on any property, expressions, 3D "
      + "layers with cameras and lights, a particle system, motion tracking, masks and mattes, nested "
      + "comps and presets — rendering to real video files with sound. It is real enough to follow "
      + "professional tutorials step by step, which is the fastest way to learn what it does.",
    makes: ["Titles and lower thirds", "Glows, shockwaves, particle reveals", "Tracked inserts and mattes", "Finished shots as mp4 with audio"],
    start: "Make a comp, add a text layer, add a glow, render.",
    /* Not one model. The compositor is arithmetic, and every pixel it makes is
     * made by code in this repo — which is why it runs on a machine with no
     * graphics card at all. The two packages are what that arithmetic runs on;
     * see the ⚠ above this file's need helpers for the two more it imports that
     * nothing probes yet. */
    needs: [
      pkg("numpy", "every frame the compositor draws", "python -m pip install numpy"),
      pkg("av", "reading and writing the video files", "python -m pip install av"),
    ],
    /* The two the probe cannot see, plus the one that is imported per effect.
     * Same reason as the DAW's note, and the same test: catalogue_test.js reads
     * server/vfx/*.py and fails if a module-level import is in neither the list
     * above nor this sentence. */
    needsNote:
      "Two more Python packages, which Studio cannot check for you: OpenCV (the cv2 module) and Pillow "
      + "(the PIL module). The render engine imports both at the top of the file, so no frame is drawn "
      + "without them. SciPy joins them inside a few effects — the curve interpolator and the tracker's "
      + "match step. One line covers all three, run with the engine's own python rather than a system "
      + "Python on PATH: \"<engine python>\" -m pip install opencv-python-headless pillow scipy, where "
      + "<engine python> is the path shown under the launcher's \"ComfyUI install\" row "
      + "(…\\venv\\Scripts\\python.exe in an engine Studio installed, python_embeded\\python.exe in the "
      + "portable ComfyUI). An engine Studio installs for you comes with all three.",
    cant:
      "Renders are CPU work — plan for a second or more per frame at 1080p with heavy effects. 3D layers "
      + "are flat cards drawn in stack order, so two of them never slice through each other per pixel. "
      + "There is no roto brush, and the tracker follows a rectangle and says so when it loses the shot.",
  },
  {
    id: "studio", icon: "✂", name: "Studio", group: "assemble",
    lead:
      "The video studio: lay clips on a timeline over a song, cut on the bar lines, add a karaoke word "
      + "overlay and a music visualiser, and export a finished video. One canvas does both the preview "
      + "and the export, so what you see is exactly what you get.",
    makes: ["Lyric videos", "Music videos cut to the beat", "Visualiser pieces", "A WebM you can post"],
    start: "Drop a song in, drag clips onto the timeline, press Export video.",
    /* Genuinely nothing. One canvas in your browser does the preview and the
     * export, which is also why the tab has to stay open — see `cant`. */
    needs: [],
    cant:
      "Export is a real-time capture of that canvas by the browser — a three-minute video takes three "
      + "minutes to save, lands as WebM, and the tab has to stay open. It is also why an assistant can "
      + "build the whole project but a person presses Export.",
  },
  {
    id: "reactive", icon: "◉", name: "Reactive", group: "assemble",
    lead:
      "Audio-reactive video: a song is analysed, its hits are found, and the picture arrives on the beat "
      + "instead of on a timer. Five cut-and-dissolve styles run on the compositor alone; two more repaint "
      + "a clip frame by frame so the figure moves and the look turns with the music.",
    makes: [
      "Beat-locked cuts and crossfades between your pictures",
      "A clip repainted in time with the bass, the figure held",
    ],
    start: "Pick a song and some pictures. The five cut styles need nothing else; Paint and Motion need the image engine.",
    /* ⚠ THIS ENTRY ONCE DEMANDED A SECOND ENGINE, and the demand is gone
     * because the reason for it is. The faithful version of this look is built
     * on three GPL-3.0 node packs, which an Apache-2.0 app cannot ship — so the
     * first draft of this page was instructions for installing a second ComfyUI
     * and the entry said `needs` was unprobeable. Each of those packs now has a
     * replacement of ours: the sliding ControlNet loader, the prompt schedule
     * and the IP-Adapter are in server/comfy_nodes, and the compositor styles
     * touch no engine at all. `needs` is empty here in the ordinary way — the
     * engine this Studio already boots is the only one involved. */
    needs: [],
    cant:
      "Paint and Motion repaint frames on the graphics card, which on this rig means NVIDIA and roughly "
      + "3.5 to 8 seconds a frame — a minute of video is an afternoon. The five cut styles are seconds and "
      + "run anywhere. It also will not invent a figure: those two styles restyle a clip you already have.",
  },

  {
    id: "training", icon: "⚙", name: "Training", group: "assemble",
    lead:
      "Teach the music model one of your own songs. A recording goes in and a small adapter — a LoRA — "
      + "comes out that pulls the model toward that song's character; afterwards you pick it on the Music "
      + "screen like any other. The song, the training and the adapter all stay on this computer.",
    makes: [
      "An adapter trained on a recording you own",
      "A Music screen that can then be asked to write in that character",
    ],
    start: "Pick a song from your library, give the adapter a name, and press Train. Twenty-four seconds of "
      + "audio is usually enough to carry a song's character.",
    /* ⚠ TWO HONEST SENTENCES, HERE AS WELL AS ON THE SCREEN. This page is read
     * by somebody deciding whether to spend an hour of their card, and the tour
     * is often where they decide. Neither belongs only in a document. */
    needs: [
      model("musicYue2Tokenizer", "reading your recording into the codes the model speaks — the encoder YuE2's own authors never shipped, and the reason this screen could not exist before"),
    ],
    cant:
      "It takes the graphics card completely for an hour or more and needs about 10 GB of free video memory "
      + "— measured here, a rank-8 run used 8.9 GB. The tokenizer that reads your recording is CC BY-NC 4.0, "
      + "so an adapter trained through it carries that non-commercial condition whatever the licence of the "
      + "song. And one thing is not yet measured: that the training loop runs is proven, but whether a given "
      + "number of steps produces an adapter you can HEAR is still an open question rather than a promise.",
  },

  {
    id: "collab", icon: "⚭", name: "Collab", group: "assemble",
    lead:
      "Make an episode with friends, or lend one of them a scene to render. A project travels as one "
      + "sealed file addressed to one person — there is no server anywhere in it, and nothing on the "
      + "screen opens a connection.",
    makes: [
      "A sealed project for a collaborator",
      "An order asking a friend to render one scene on their card",
      "A credit list saying who did what, folded out of the ledger",
    ],
    start: "Open it once to make this Studio's keys, swap key cards with a friend, and read twelve words aloud to each other.",
    /* Nothing to download and nothing to probe: the whole feature is node's own
     * crypto and a file on disk, so `needs` is genuinely empty here rather than
     * empty because something could not be listed. */
    needs: [],
    cant:
      "It cannot reach your friend for you. Phase one writes a file and reads one; sending it is whatever "
      + "you already use. It also will not verify anybody, will not accept a friend's scene past the minutes "
      + "a day you give them without asking you first (checked when you accept, from renders timed here and "
      + "estimates), and will not render what arrives until you have read it. What a friend says their machine "
      + "can do is a message they sent, not a window onto it, so every copy is shown with its age.",
  },

  {
    id: "overnight", icon: "☾", name: "Overnight", group: "run",
    lead:
      "Write down ideas at bedtime and let the machine render them while you sleep — songs, covers, stems, "
      + "even clips. The plan lives on disk, so a crash or a closed browser does not lose the run.",
    makes: ["A night's worth of songs", "Batches of images", "Batches of clips"],
    start: "List a few ideas, choose the stages, press Start, go to bed.",
    /* A stage is only offered if its model is installed — the `cant` says so.
     * Which stages exist is which of these you have, so the needs are the union
     * of what the stages call, spread from the same derived sets. */
    needs: [
      ...MUSIC_NEEDS,
      model("coverArt", "the covers stage"),
      model("stems", "the stems stage"),
      ...IMAGE_NEEDS,
      ...VIDEO_NEEDS,
    ],
    cant:
      "The computer has to stay on and awake; Studio keeps it awake but cannot open a closed lid. Stages "
      + "whose models are not installed are greyed out rather than silently skipped.",
  },
  {
    id: "models", icon: "▤", name: "Models", group: "run",
    lead:
      "The catalogue: every capability, which files it needs, how big they are, what your card needs to "
      + "run it, and the licence — shown before you download, because the licence is between you and the "
      + "model's publisher. Only the music engine is required; everything else is optional.",
    makes: ["An informed decision about what to install"],
    start: "Read the licence line next to the button before pressing it.",
    /* The screen that answers this question for every OTHER screen. It needs
     * nothing itself, and every info panel in the app links here. */
    needs: [],
    cant:
      "Studio never downloads anything on its own, so the first use of a new capability means a wait "
      + "measured in gigabytes. One repository is access-gated and cannot be fetched by the built-in "
      + "downloader at all — the page says how to get it instead of offering a button that fails.",
  },
  {
    id: "engine", icon: "⑁", name: "Engine", group: "run",
    lead:
      "The one door to the graphics card, and the record of everything that has gone through it. "
      + "ComfyUI runs here as a child process on a loopback port the app picks fresh at every start "
      + "and does not publish, so nothing else on this machine can find it by guessing — and every "
      + "render, from any hand, is written down before the card spends a millisecond: the graph "
      + "itself, the prompt, every seed and step count, the size, the model and LoRA files, the "
      + "reference pictures, who asked, how long it took, and the digest of every file it wrote. "
      + "A render that FAILED is recorded too.",
    makes: ["A complete, checkable record of what this machine rendered", "A way to run a ComfyUI graph of your own"],
    start: "Read the activity list first — it is the honest answer to \"what happened here last night\".",
    /* Nothing of its own: it is the engine every other screen already uses,
     * looked at from the front. What it needs is whatever the render needs. */
    needs: [],
    cant:
      "It cannot account for renders made before it existed, and it says so rather than guessing — "
      + "those files can be adopted with an honest \"origin unrecorded\" note and nothing more. "
      + "Revealing the port is offered, and it is a real cost: anything told the number can drive "
      + "the engine directly, and those renders will not appear here.",
  },
  {
    id: "settings", icon: "⚙", name: "Settings", group: "run",
    lead:
      "Cover-art style, output formats, folders, the graphics-memory tier for smaller cards, your own "
      + "ComfyUI workflows, and \"No strong graphics card?\": a friend who renders for you first, then an "
      + "opt-in paid service on your own key under a monthly spending cap.",
    makes: ["A studio that behaves the way you work"],
    start: "Set the output folder first; everything else has a working default.",
    needs: [],
    cant:
      "Changing the memory tier restarts the engine and clears the cached take, so the next re-roll costs "
      + "a full render — it says so before it does it. The paid service spends real money, which is exactly why "
      + "every paid song asks first and the cap exists.",
  },
  {
    id: "mcp", icon: "◆", name: "Agent", group: "run",
    /* ⚠ WHAT IT IS BEFORE HOW TO CONNECT IT. This entry used to open with
     * "how to point an AI assistant at Studio over MCP" — clear to somebody
     * who already knows what MCP is, opaque to everyone else, and this is the
     * page a person reads on their first day. The acronym was expanded nowhere
     * in the tour. */
    lead:
      "You can let an AI assistant — Claude, or anything like it — work the studio for you: you ask "
      + "for a song or a video in ordinary words and it presses the buttons, while you watch and can "
      + "stop it. It connects over something called MCP, which is simply an agreed way for a program "
      + "like this one to hand an assistant a list of what it can do — you paste one short snippet into "
      + "the assistant's settings and it can see the studio. Connecting sends nothing anywhere: the "
      + "assistant drives the copy on this machine. This screen has that snippet, the live list of every "
      + "tool, and a worked \"make me a music video\" example. Everything a person can click here, an "
      + "assistant can call — including asking for this catalogue, which is one tool call and the same "
      + "words you are reading.",
    makes: ["A studio somebody else can drive while you watch"],
    start: "Copy the snippet into your assistant's settings, then ask it what the studio can do.",
    /* Nothing on this machine. What it needs is at the other end of the pipe —
     * an assistant that speaks MCP — and Studio has no way to check that and
     * no business claiming to. */
    needs: [],
    needsNote:
      "An assistant that speaks MCP, at the other end. Nothing is installed on this machine for it: "
      + "the tools are the HTTP API this page is already serving.",
    cant:
      "That page carries its own confession section about what an agent honestly cannot do, and repeating "
      + "it here is how two copies start to disagree.",
  },
  {
    id: "community", icon: "◎", name: "Community", group: "run",
    lead:
      "A window onto aiplay.live — live listening rooms, events starting soon, and style packs that fill "
      + "the Music form with a starting point. It is the \"when you want people to hear it\" door; nothing "
      + "walks through it on its own.",
    makes: ["A way out of your own headphones"],
    start: "Have a look at what is playing, or borrow a style pack.",
    needs: [],
    needsNote:
      "An internet connection — the only screen in the app that wants one. No account, no sign-in, and "
      + "nothing you have made is uploaded to look at it.",
    cant:
      "Offline or behind a firewall it degrades to \"not reachable\", and that is fine — no feature in the "
      + "app needs a connection or an account, and nothing you make is uploaded anywhere.",
  },
  {
    id: "radio", icon: "∿", name: "Radio", group: "run",
    lead: "The AI PLAY radio stations: live streams from the platform's own channel list, opened in your browser.",
    makes: ["Something to listen to"],
    start: "Pick a station that is live.",
    needs: [],
    needsNote: "An internet connection to aiplay.live and to the streams themselves. No account, and nothing of yours is uploaded.",
    cant: "It plays in your browser, not in the app; offline it says so and shows nothing.",
  },
  {
    id: "blog", icon: "✎", name: "Blog", group: "run",
    lead: "Articles from the aiplay.live blog: guides, news and write-ups, opened in your browser.",
    makes: ["Something to read"],
    start: "Open an article.",
    needs: [],
    needsNote: "An internet connection to aiplay.live, where the articles live. No account needed, nothing is uploaded.",
    cant: "It only lists the articles; each one opens on the website in your browser, and offline the list is empty.",
  },
  {
    id: "games", icon: "⚄", name: "Games", group: "run",
    lead: "A small number puzzle for while the queue renders. Renders take minutes; the game is honest about why it is here.",
    makes: ["A way to spend four minutes"],
    start: "Only if a render is going.",
    needs: [],
    cant: "It is exactly one game, and your best score lives in this browser and nowhere else.",
  },
  {
    id: "about", icon: "✦", name: "About", group: "run",
    lead:
      "The long version of this window: what the studio is, what each page does and cannot do, the privacy "
      + "promise in full, what you need to run it, and the rights question answered model by model. This "
      + "welcome can be re-opened from there at any time.",
    makes: ["The answer to \"wait, what does this actually do\""],
    start: "Read it once; it is written prose, not a feature list.",
    needs: [],
    cant: "It cannot account for a model file you added yourself — that licence is between you and its author.",
  },
  {
    id: "thanks", icon: "♥", name: "Thanks", group: "run",
    lead:
      "The credits and the licences: every model, every borrowed idea, and what each licence asks of you, "
      + "built from the live catalogue so it cannot go stale.",
    makes: ["A clean conscience"],
    start: "Read it before you sell something you made here.",
    needs: [],
    cant:
      "It can only account for what it can see. A model file you dropped in yourself brings its own "
      + "licence, and that one is between you and its author — this page has never read it and will "
      + "not pretend to.",
  },
];

/* The one count that moves whenever somebody adds a screen — so it is counted,
 * not typed. TABS is above; a heading that says "four screens" over five of
 * them is the smallest possible lie and nobody would notice it for months. */
const inGroup = (id) => TABS.filter((t) => t.group === id).length;

const GROUPS = [
  { id: "make", name: "Make something", note: `The ${count(inGroup("make"))} screens that put a new file on your disk.` },
  { id: "assemble", name: "Put it together", note: "Where clips, pictures and a song become one piece." },
  { id: "run", name: "Run the place", note: "Models, settings, unattended runs, and the door for an assistant." },
];

/* ── the video quality facts, read from config and from what was measured ──
 *
 * The owner: "when we gen we want the highest native quality we can use … we
 * can upscale but it loses details … explain what happens when. make a user
 * understand it."
 *
 * So this block exists to make one idea land on day one: NATIVE IS A DECISION
 * YOU MAKE BEFORE THE RENDER, and no later step recovers it. Every number is
 * measured on this rig and cited; nothing here is modelled or guessed.
 *
 * The sizes are read from config so this can never advertise a size the picker
 * does not offer — the exact failure the fork's own size-list fix was about.
 */

/* THE TWO STEP COUNTS THIS PAGE NAMES ARE THE DISTILLATIONS' OWN. A LoRA file
 * is called `..._turbo_4step_...`, so the number is IN the choice config.js
 * made rather than in a sentence somebody typed beside it — and on a machine
 * that only has one of the two builds, `pick` falls back and this page says
 * what that machine will actually run. The literal is the same "?? today's
 * value" fallback the rest of the app uses for a field that may be absent. */
const stepsInLora = (name, fallback) => {
  const m = /turbo_(\d+)step/.exec(String(name ?? ""));
  return m ? Number(m[1]) : fallback;
};
const FAST_STEPS = stepsInLora(config.video.engines.h3?.turboLora4, 4);
const MID_STEPS = stepsInLora(config.video.engines.h3?.turboLora, 8);
/* AND THE BARE MODEL'S, which no LoRA file carries. The sigma sentence below
 * used to end on config.js's default step count, which was 20 and so named
 * the no-LoRA path; since 2026-09-23 that default is the matched turbo
 * setting the disk has (8 with both 8-step files, else 4), so it equals
 * MID_STEPS or FAST_STEPS and the sentence said one number twice. Read from
 * the Video Lab's no-LoRA arm, which is 20 like the Best chip and make_clip's
 * "best". */
const BARE_STEPS = COMPARE_CONFIGS.find((c) => c.id === "h3_quality")?.steps ?? 20;
const SHIFT = config.video.engines.h3?.shiftVideo ?? 12;
/* Three decimals, because that is the precision docs/H3_REFERENCE_BLEED.md
 * reports and the Video lab's panel shows. */
const sigmaAt = (steps) => commitSigma(steps, SHIFT)?.toFixed(3);

function videoFacts() {
  const engines = Object.entries(config.video.engines).map(([id, e]) => ({
    id,
    label: e.label,
    native: `${e.width} x ${e.height}`,
    sizes: (e.sizes || []).map((s) => ({ w: s.w, h: s.h, label: s.label })),
    /* H3 exposes a step count; LTX bakes two schedules into literal sigma
     * strings and has no single `steps` number, so the field is absent rather
     * than filled with a fiction — and so is the sentence about it. A UI that
     * has to compose that sentence itself is a UI that will get LTX wrong. */
    steps: e.steps ?? null,
    turboMaxSteps: e.turboMaxSteps ?? null,
    /* A distilled engine with a fixed schedule (FastH3) loads no turbo LoRA,
     * so "applies only below 0" would be a sentence about nothing. */
    stepsNote: e.fixedSteps
      ? `${e.fixedSteps} fixed steps: a distilled model, no turbo LoRA.`
      : e.steps
      ? `${e.steps} steps by default; the turbo distillation applies only below ${e.turboMaxSteps}.`
      /* "Two passes" is COUNTED — one per literal sigma string this engine
       * declares (`sigmasLow`, `sigmasHigh`). An engine that grew a third would
       * otherwise be described by a sentence that had stopped being true. */
      : `No single step count — the schedule is ${count(Object.keys(e).filter((k) => /^sigmas/.test(k)).length)} `
        + "passes, and the step counts are baked into it.",
    frameRule: e.frameRule,
    fps: e.fps,
    dropAudio: !!e.dropAudio,
  }));

  return {
    engines,
    current: config.video.engine,
    /* Each entry: the claim, then where it was measured. A number on a welcome
     * screen with no provenance is exactly the kind of thing the rest of this
     * app spends its time refusing to trust. */
    quality: [
      {
        headline: "Pick the size before the render, not after.",
        body:
          "Upscaling invents detail; it cannot recover what was never rendered. At "
          + `${config.video.engines.h3?.label}'s native `
          + `${config.video.engines.h3?.width}x${config.video.engines.h3?.height} `
          + "a performer standing a few metres back gets about 58 pixels of face — enough for a "
          + "head, not enough for a mouth, and the mouth comes out a smear. That is not a sampler setting "
          + "and no later step fixes it.",
        source: "Six H3 renders, one prompt, one seed, only the size varied (2026-09-02) — "
          + "docs/RESOLUTION_FOR_FACES.md.",
      },
      {
        headline: "1792x1008 is the knee. 1920x1088 buys nothing.",
        body:
          "1792x1008 is the first size where one- and two-pixel features survive — eyelid crease, lash "
          + "line, brow hairs, nostril wing — at 84 px of face. 1920x1088 measures an identical face and "
          + "mouth for 22% more wall clock. Above the knee you are paying for time, not detail.",
        source: "Same sweep: 591 s at 1792x1008 against 721 s at 1920x1088, 56 frames each.",
      },
      {
        headline: "More pixels can give you a SMALLER face.",
        body:
          "1536x864 cost 36% more than native and produced the smallest face on the whole ladder, because "
          + "the model chose to frame the subject further away. Resolution is not composition, and the "
          + "engine gets a vote on composition.",
        source: "Measured: 5.73% of frame height at 1536x864 against 7.55% at native 1344x768.",
      },
      {
        headline: "Framing is the lever resolution is not.",
        body:
          "Set the bar at \"this mouth could be lip-synced\" — about 96 px of face — and NO size on the "
          + "ladder reaches it, 1920x1088 included. Reframe the shot chest-up and 1792x1008 clears it with "
          + "margin; stay knees-up and no render size rescues you. Write the framing into the prompt.",
        source: "Same sweep. The honest limit of the resolution answer.",
      },
      {
        /* ⚠ THIS CARD USED TO SAY "clip length is not what costs you", quote a
         * 16-to-21 GPU-hour envelope as measured, and tell you to cut to the
         * music and not to the budget. RESOLUTION_FOR_FACES.md withdrew all of
         * that on 2026-09-10: every row of that sweep was 56 frames, and the
         * 56-to-209 band was the cost model extrapolated over lengths nothing
         * here has ever rendered. The card is the withdrawal, because a page
         * that keeps giving retracted advice is worse than one that says
         * nothing — the reader has no way to know it was taken back. */
        headline: "Length is cheap until it isn't, and we never rendered the cliff.",
        body:
          "Inside the range this rig has measured, size is the bill: the ladder spans 2.7x and length "
          + "costs almost nothing. That stops being true somewhere above 331k latent tokens, where an "
          + "outside replication over 158 renders found 30% more frames costing 2.6x, with hard "
          + "out-of-memory failures. Our largest render is 149k. 1792x1008 at 209 frames is 437k. Cut "
          + "to the music inside the measured range, and treat a long clip at a large size as unknown.",
        source: "Measured here to 149k latent tokens; the cliff is somebody else's 158 renders.",
      },
      {
        headline: `${Count(FAST_STEPS)} steps is a different model, not a faster one.`,
        body:
          "The turbo distillation is applied only in the fast half of the step slider (below "
          + `${config.video.engines.h3?.turboMaxSteps ?? 12} steps on H3); above that the bare model runs on its own schedule, which is what `
          + `the vendor's own flows do. At ${FAST_STEPS} steps with the default sigma shift of ${SHIFT} `
          + `the model's last look at the noise is at sigma ${sigmaAt(FAST_STEPS)} — it invents `
          + `${Math.round(commitSigma(FAST_STEPS, SHIFT) * 100)}% of the picture in one jump, and the `
          + "cleanest thing in its field of view is your reference image, which is why references occupy "
          + "the opening frames and then hand over. "
          + `${Count(MID_STEPS)} steps commits at ${sigmaAt(MID_STEPS)}, and the bare model's `
          + `${count(BARE_STEPS)} at ${sigmaAt(BARE_STEPS)}.`,
        source: "Read from ComfyUI's own scheduler and confirmed frame by frame on a 4-step clip "
          + "(2026-09-02) — docs/H3_REFERENCE_BLEED.md. The sigmas here are computed by the same "
          + "function the Video lab's panel shows, server/videolab/catalog.js commitSigma, so they "
          + "follow the shift rather than quoting a table.",
      },
    ],
  };
}

/* ── licences, from the live catalogue ─────────────────────────────────────
 *
 * "It must be honest about licences the way config.js is."
 *
 * Two facts belong on day one because they are the two that can cost somebody
 * something: LTX has a revenue ceiling and a competing-product bar, and H3's
 * grant stops at a territory boundary that includes most of the places reading
 * this. Both are QUOTED and LINKED rather than paraphrased, and both are pulled
 * out of models.js so they cannot drift from what the Models screen shows.
 */
function licenceFacts() {
  const notable = [];
  for (const cap of CATALOG) {
    const r = cap.outputRights;
    if (!cap.region && !(r?.conditions?.length)) continue;
    notable.push({
      id: cap.id,
      label: cap.label,
      licence: cap.licence || null,
      class: r?.class ?? null,
      sellable: r?.sellable ?? null,
      quote: r?.quote ?? null,
      clause: r?.clause ?? null,
      url: r?.url ?? cap.region?.url ?? null,
      conditions: r?.conditions ?? [],
      /* Territory is a SEPARATE axis from selling, and the About page already
       * says so. Null for everything but H3. */
      region: cap.region ? { excluded: cap.region.excluded, text: cap.region.text, url: cap.region.url } : null,
      gated: cap.gated ? { url: cap.gated.url, how: cap.gated.how } : null,
    });
  }
  const unrestricted = CATALOG
    .filter((c) => c.outputRights?.class === "unrestricted")
    .map((c) => c.label);
  /* The sentence, not just the list. Composed here rather than in the page for
   * the same reason as everything else in this file: an agent asking what it
   * may sell should be told, not handed an array and left to phrase it. */
  const unrestrictedLine = unrestricted.length
    ? `Nothing in these licences touches what you generate: ${unrestricted.join(", ")}.`
    : null;

  return {
    lead:
      "AIPLAY Studio takes no rights over anything you make with it. The models you run are made by other "
      + "people, and each model's licence governs the material it generates. Most are generous. Two are "
      + "worth knowing about before you start, not after.",
    /* The single most misunderstood sentence in this whole area, and it costs
     * people money in both directions. Kept here because a new user meets the
     * word "non-commercial" on the Models screen within their first ten
     * minutes. */
    nonCommercial:
      "\"Non-commercial\" nearly always means the WEIGHTS, not your picture — you may not run them inside "
      + "a paid service or build a product on them. It is usually not a rule about what you just made. One "
      + "or two go the other way and mean it, and one keeps its agreement behind a login nobody here has "
      + "been through, so the honest answer there is \"we do not know\" rather than a confident guess.",
    notable,
    unrestricted,
    unrestrictedLine,
    neverBlocks:
      "The studio never blocks an export. It cannot know whether a file is going to a paying client or a "
      + "group chat, and a tool that guesses wrong about that is a tool people work around. It records "
      + "which model made what, at the moment it was made, so months later you can still show what the "
      + "terms were on the day.",
  };
}

/* ── the whole document ─────────────────────────────────────────────────── */

/**
 * The catalogue the window renders and `studio_capabilities` returns.
 *
 * `showcase` is passed in rather than read here, because it is the one part
 * that comes off the disk and can legitimately be empty — see showcase.js. A
 * caller that does not want the disk read (the MCP tool answering "what can
 * this studio do" with the Studio's library on a slow drive) omits it.
 */
export function catalogue({ showcase = null } = {}) {
  return {
    version: WELCOME_VERSION,
    identity: IDENTITY,
    groups: GROUPS,
    /* Copies with the music need resolved at the moment of asking, never
     * written back into TABS: the selection changes while Studio runs, and a
     * resolution stored in TABS would answer every later call with the first
     * engine it saw. A tab with no music need is handed out as it is. */
    tabs: TABS.map((t) => ((t.needs || []).some((n) => n.kind === "music")
      ? { ...t, needs: t.needs.map(resolveMusicNeed) } : t)),
    start: START,
    video: videoFacts(),
    licences: licenceFacts(),
    showcase,
  };
}

export { TABS, GROUPS, START, IDENTITY };

/** Sentences the Info panel renders VERBATIM about a package row. They live here,
 * not in web/info.js, so studio_screen_info carries the same words a person sees.
 * `probedIn` matters more than it looks: the probe writes a hard false when the
 * spawn itself fails, and two rows on one panel can be answered by two different
 * pythons (whisper has its own venv) — a verdict with no interpreter is certainty
 * about nothing. */
export const NEED_WORDS = Object.freeze({
  probedIn: (path) => `Probed in ${path} — the interpreter that runs it.`,
});
