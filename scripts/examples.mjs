#!/usr/bin/env node
/**
 * Build `examples/` — the input beside the output, for every kind of thing
 * Studio makes.
 *
 * WHY IT EXISTS. The README described five pipelines and showed none of them.
 * A newcomer could read the whole thing and still not know what a caption looks
 * like, how long one is, whether lyrics need section tags, or what a "production
 * bible" actually is as a document. `docs/demo/` had the outputs — 3.9 MB of
 * real, licence-clean renders with a `why` per file — and none of the requests
 * that produced them. Half an example is a screenshot.
 *
 * ⚠ THE INPUTS ARE RECOVERED, NEVER INVENTED. Every request in here was read
 * back out of something this machine already stored:
 *
 *   · the caption and lyrics   — library.json's `meta` for the source render
 *   · the clip prompt, seeds,  — the mp4's own `prompt` metadata tag, which is
 *     sizes and sigmas           the API graph ComfyUI was handed, verbatim
 *   · the image reference list — the png's `tEXt` graph names its LoadImage
 *                                inputs, and those staged files are BYTE-
 *                                IDENTICAL to two gallery pictures (sha256
 *                                compared here, recorded in the manifest), so
 *                                which picture was "image 1" is proven rather
 *                                than assumed
 *   · the production bible     — the MV project document itself
 *
 * Where a field could not be recovered the manifest says "input not recorded".
 * It never says a plausible thing instead. An example that quietly invents its
 * own input is worse than no example, because it will be copied.
 *
 *   node scripts/examples.mjs            rebuild examples/ from this machine
 *   node scripts/examples.mjs --check    fail if the committed dir has drifted
 *
 * The build needs the rig (it reads renders out of ComfyUI's output folder).
 * The GATE does not — server/docs_test.js checks the committed directory
 * against its own manifest, so it runs on a clone that has never rendered
 * anything.
 */
import { mkdir, copyFile, writeFile, readFile, stat, rm, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../server/config.js";
import { CATALOG } from "../server/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "examples");
const SRC = config.outputDir;
const DEMO = path.join(ROOT, "docs", "demo");
const LIB = path.join(homedir(), ".aiplay-studio", "library.json");

/** The whole directory has to stay something a person will clone. */
const BUDGET_BYTES = 15_000_000;

const sha = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/* ── licence lines, read from the catalogue rather than typed ──────────────
 *
 * MiniMax-Music3 §3.1 is the one that reaches this directory: a commercial
 * product using it must show the name prominently in its interface. These files
 * are that model's output, published in this repository, so every one of them
 * carries the name the same way the app does — in the thing you look at, not on
 * a credits page. The sentence is the catalogue's own, so it cannot drift from
 * what the Models screen says before you download. */
function attributionFor(capId) {
  const cap = CATALOG.find((c) => c.id === capId);
  if (!cap) throw new Error(`no catalogue entry ${capId}`);
  const r = cap.outputRights || {};
  return {
    model: cap.label.split(" — ").pop().trim(),
    licence: cap.licence,
    outputRights: r.class,
    url: r.url || null,
    /* The condition verbatim, not summarised — this is the one a reader may
     * have to comply with themselves if they reuse the file. */
    conditions: r.conditions || [],
  };
}

/**
 * The API graph ComfyUI actually ran, out of the artifact's own metadata.
 *
 * ComfyUI writes it into a PNG `tEXt` chunk and an MP4 `prompt` tag. It is the
 * most trustworthy record of an input that exists here: not a log of what was
 * asked for, but the thing that was executed.
 */
function graphFromPng(file) {
  const b = readFileSync(file);
  let o = 8;
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    if (type === "tEXt") {
      const s = b.toString("utf8", o + 8, o + 8 + len);
      const nul = s.indexOf("\0");
      if (s.slice(0, nul) === "prompt") return JSON.parse(s.slice(nul + 1));
    }
    if (type === "IDAT") break;
    o += 12 + len;
  }
  return null;
}

async function graphFromMp4(file) {
  const { spawn } = await import("node:child_process");
  const FF = ["C:/ffmpeg/bin/ffprobe.exe", "/usr/bin/ffprobe", "ffprobe"]
    .find((p) => p === "ffprobe" || existsSync(p));
  return new Promise((res) => {
    const p = spawn(FF, ["-v", "error", "-show_entries", "format_tags=prompt",
                         "-of", "json", file]);
    let so = "";
    p.stdout.on("data", (d) => (so += d));
    p.on("error", () => res(null));
    p.on("exit", () => {
      try { res(JSON.parse(JSON.parse(so).format.tags.prompt)); } catch { res(null); }
    });
  });
}

/** Pull the human-meaningful values out of a graph, by node class. */
const nodesOf = (g, cls) => Object.entries(g || {}).filter(([, n]) => n.class_type === cls);
const firstInput = (g, cls, key) => {
  const n = nodesOf(g, cls)[0];
  return n ? n[1].inputs[key] : null;
};

/* ══════════════════════════════════════════════════════════════════════════
 * The examples themselves.
 *
 * Each one is INPUT + OUTPUT + how the input was recovered. `build` returns the
 * files to write and the manifest entry; nothing here hard-codes a prompt.
 * ══════════════════════════════════════════════════════════════════════════ */

const EXAMPLES = [
  {
    dir: "01-song",
    title: "A song, from a caption and lyrics",
    why: "The one capability that is not optional, so this is the example to read first. It is the "
       + "exact request behind docs/demo/demo-song.mp3, and the shape of that caption is most of "
       + "what decides the quality.",
    async build() {
      const lib = readJson(LIB);
      const m = lib.meta["aiplay_00060.flac"];
      if (!m?.caption) throw new Error("aiplay_00060.flac has no recorded caption in library.json");
      const audio = path.join(DEMO, "demo-song.mp3");
      return {
        files: [
          { name: "caption.txt", text: m.caption + "\n" },
          { name: "lyrics.txt", text: m.lyrics + "\n" },
          {
            name: "request.json",
            json: {
              _: "The make_song MCP tool, or POST /api/generate with the same fields.",
              _tool: "make_song",
              caption: m.caption,
              lyrics: m.lyrics,
              title: m.title,
              seed: m.seed,
            },
          },
          { name: "glass-and-neon.mp3", copyFrom: audio },
        ],
        entry: {
          input: ["caption.txt", "lyrics.txt", "request.json"],
          output: ["glass-and-neon.mp3"],
          recoveredFrom: "~/.aiplay-studio/library.json → meta['aiplay_00060.flac'], which is what "
                       + "the render itself wrote. The mp3 is docs/demo/demo-song.mp3, transcoded "
                       + "from that FLAC by scripts/demos.mjs.",
          measured: {
            audioSeconds: m.durationSeconds,
            renderSeconds: m.renderSeconds ?? null,
            seed: m.seed,
            model: m.model,
          },
          teaches: "The caption is three labelled parts — Global Metadata, Vocal Details, "
                 + "Arrangement. Lyrics carry [Verse] / [Chorus] / [Bridge] tags, and song LENGTH "
                 + "follows lyric length: the same request with an empty lyrics box stops after "
                 + "about 30 seconds.",
          attribution: attributionFor("engine"),
        },
      };
    },
  },

  {
    dir: "02-audio-reference",
    title: "Starting from a real song — the strength dial, three settings",
    why: "The same reference at three denoise values, so the cliff is audible rather than asserted. "
       + "This is the control people most often set wrong.",
    async build() {
      const dial = [
        ["0.60", "aref-denoise-060.mp3"],
        ["0.85", "aref-denoise-085.mp3"],
        ["0.95", "aref-denoise-095.mp3"],
      ];
      const manifest = readJson(path.join(DEMO, "manifest.json"));
      const whyOf = (out) => manifest.find((x) => x.out === out)?.why || null;
      return {
        files: [
          ...dial.map(([v, src]) => ({ name: `denoise-${v}.mp3`, copyFrom: path.join(DEMO, src) })),
          {
            name: "request.json",
            json: {
              _: "POST /api/generate with an audio reference attached. `denoise` is the whole dial: "
               + "it trims the sigma schedule, so a lower number leaves more of the reference intact.",
              /* No MCP tool takes a reference recording — checked against the live
               * tool list, and docs_test.js re-checks it. The parity gap is stated
               * rather than papered over with a tool name that does not exist. */
              _tool: null,
              _toolNote: "There is no MCP tool for this. Audio reference is HTTP and UI only, "
                       + "because the reference is a FILE the agent would have to put on disk first.",
              caption: "input not recorded",
              reference: "input not recorded — the source recording these three were steered by is "
                       + "not named in any store on this machine. What IS recorded is the dial value "
                       + "and the measured correlation at each, below.",
              denoise: dial.map(([v]) => Number(v)),
            },
          },
        ],
        entry: {
          input: ["request.json"],
          output: dial.map(([v]) => `denoise-${v}.mp3`),
          recoveredFrom: "docs/demo/manifest.json, written by scripts/demos.mjs, which measured each "
                       + "file before shipping it. The caption and the reference recording are NOT "
                       + "recorded anywhere and are not guessed at here.",
          measured: Object.fromEntries(dial.map(([v, src]) => [`denoise ${v}`, whyOf(src)])),
          teaches: "0.85 is the shipped default and the only setting that is a genuine blend. Below "
                 + "0.80 you get a copy; at 0.90 and above the trim removes less than one step and "
                 + "the reference stops steering anything.",
          attribution: attributionFor("audioRef"),
        },
      };
    },
  },

  {
    dir: "03-video-clip",
    title: "A video clip, prompt in",
    why: "Five seconds of 1280x704 with its own audio track. The request here is not a reconstruction "
       + "— it is the graph ComfyUI was handed, read back out of the mp4.",
    async build() {
      const mp4 = path.join(DEMO, "demo-clip-ltx.mp4");
      const g = await graphFromMp4(mp4);
      if (!g) throw new Error("could not read the prompt tag out of demo-clip-ltx.mp4");
      const [pos, neg] = nodesOf(g, "CLIPTextEncode").map(([, n]) => n.inputs.text);
      const low = nodesOf(g, "EmptyLTXVLatentVideo")[0][1].inputs;
      const fps = firstInput(g, "LTXVConditioning", "frame_rate");
      const seeds = nodesOf(g, "RandomNoise").map(([, n]) => n.inputs.noise_seed);
      return {
        files: [
          { name: "prompt.txt", text: pos + "\n" },
          {
            name: "request.json",
            json: {
              _: "The make_clip MCP tool, or POST /api/clips. Every value here was read back out "
               + "of the mp4's own `prompt` metadata tag — the API graph ComfyUI executed.",
              _tool: "make_clip",
              /* ⚠ ONLY FIELDS THE TOOL ACTUALLY TAKES. The first draft of this file
               * carried `frames`, `fps` and a `seeds` array because that is what the
               * graph holds — and make_clip's schema is additionalProperties:false, so
               * copying it would have been refused. An example that cannot be run is
               * worse than none, and docs_test.js now checks every key here against
               * the live tool schema. The graph's own numbers live in `_graph`. */
              engine: "ltx",
              prompt: pos,
              negative: neg,
              width: low.width * 2,
              height: low.height * 2,
              seconds: Math.round(low.length / fps),
              _graph: {
                _: "What the executed graph held. Not request fields — Studio derives these "
                 + "from `seconds` and the engine's own frame rule.",
                frames: low.length,
                fps,
                lowResPass: `${low.width}x${low.height}`,
                noiseSeeds: seeds,
                note: `LTX samples at ${low.width}x${low.height}, upscales the LATENT x2, then `
                    + "re-samples three steps at full size. Almost nothing is spent at full "
                    + "resolution — that two-pass split is the whole speed story.",
              },
            },
          },
          { name: "clip-1280x704.mp4", copyFrom: mp4 },
        ],
        entry: {
          input: ["prompt.txt", "request.json"],
          output: ["clip-1280x704.mp4"],
          recoveredFrom: "The mp4's own `prompt` metadata tag — the executed graph, verbatim. It also "
                       + "identifies the file as the first output of scripts/ltx_smoke.mjs "
                       + "(filename_prefix `clips/ltx`, the same two-pass sigmas).",
          measured: {
            resolution: `${low.width * 2}x${low.height * 2}`,
            frames: low.length,
            fps,
            seconds: Math.round((low.length / fps) * 100) / 100,
            renderSeconds: 121,
            renderNote: "121 s measured on a 16 GB RTX 4070 Ti SUPER (config.js, video engines).",
          },
          teaches: "LTX's frame count is fps x seconds + 1 — 121, not 120. H3's rule is different "
                 + "(n mod 17 == 5), which is why the two engines are not interchangeable and "
                 + "Studio refuses a mismatched size rather than rounding it.",
          attribution: attributionFor("videoLtx"),
          alsoNote: "⚠ LTX 2.5's repository is access-gated, so Studio cannot download it for you — "
                  + "see the gated note in the README's model table. The shipped default engine is "
                  + "MiniMax H3, which Studio CAN fetch.",
        },
      };
    },
  },

  {
    dir: "04-image-references",
    title: "A picture that uses two other pictures",
    why: "FLUX.2 klein's reference images are how a character stays the same character across "
       + "pictures, and the Images screen has no attach control for them yet — so this example is "
       + "the documentation for a feature you can otherwise only find in the API.",
    async build() {
      const gal = path.join(SRC, "images");
      const outPng = path.join(gal, "imtb3bkeu.png");
      const g = graphFromPng(outPng);
      if (!g) throw new Error("no tEXt graph in imtb3bkeu.png");
      const prompt = firstInput(g, "CLIPTextEncode", "text");
      const seed = firstInput(g, "RandomNoise", "noise_seed");
      /* WHICH staged file was "image 1" is the whole question, and the graph
       * answers it by filename. Those staged files are then hashed against the
       * gallery pictures, so the pairing in the manifest is proven, not read
       * off a timestamp. */
      const staged = nodesOf(g, "LoadImage").map(([id, n]) => ({ id, file: n.inputs.image }));
      const candidates = ["imtb3bfdj.png", "imtb3b0ud.png"];
      const byHash = new Map();
      for (const c of candidates) byHash.set(sha(readFileSync(path.join(gal, c))), c);
      const refs = staged.map((s, i) => {
        const h = sha(readFileSync(path.join(config.inputDir, s.file)));
        const match = byHash.get(h);
        if (!match) throw new Error(`staged reference ${s.file} matches no gallery picture`);
        return { slot: i + 1, gallery: match, sha256: h };
      });
      const meta = readJson(path.join(gal, "_meta.json"));
      const names = { "imtb3bfdj.png": "ref-1-portrait.png", "imtb3b0ud.png": "ref-2-red-hat.png" };
      return {
        files: [
          ...refs.map((r) => ({ name: names[r.gallery], copyFrom: path.join(gal, r.gallery) })),
          { name: "prompt.txt", text: prompt + "\n" },
          {
            name: "request.json",
            json: {
              _: "The make_image MCP tool, or POST /api/images. `ref_images` is ORDERED: the prompt "
               + "refers to them as 'image 1' and 'image 2', and that is their position in this list.",
              _tool: "make_image",
              engine: "flux2",
              prompt,
              seed,
              width: firstInput(g, "EmptyFlux2LatentImage", "width"),
              height: firstInput(g, "EmptyFlux2LatentImage", "height"),
              steps: firstInput(g, "Flux2Scheduler", "steps"),
              ref_images: refs.map((r) => names[r.gallery]),
            },
          },
          { name: "output-composite.png", copyFrom: outPng },
        ],
        entry: {
          input: refs.map((r) => names[r.gallery]).concat(["prompt.txt", "request.json"]),
          output: ["output-composite.png"],
          recoveredFrom: "The output PNG's own tEXt graph names its two LoadImage inputs. Those staged "
                       + "files were sha256-compared against the gallery and are byte-identical to "
                       + refs.map((r) => `${r.gallery} (${r.sha256.slice(0, 23)}…, slot ${r.slot})`).join(" and ")
                       + " — so the ordering here is proven, not inferred from timestamps.",
          measured: {
            engine: meta["imtb3bkeu.png"]?.engine,
            seed,
            referencePrompts: Object.fromEntries(refs.map((r) =>
              [names[r.gallery], meta[r.gallery]?.prompt || "input not recorded"])),
          },
          teaches: "The two reference pictures are themselves examples: each was made from one plain "
                 + "sentence. The composite's prompt never describes the face or the hat — it points "
                 + "at them. That is the whole technique.",
          attribution: attributionFor("coverArt"),
        },
      };
    },
  },

  {
    dir: "05-music-video",
    title: "A production bible, and one scene it rendered",
    why: "The music-video pipeline's eleven stages all read one document. This is a real one, whole — "
       + "the smallest complete project on this machine — beside a clip it produced.",
    async build() {
      const proj = path.join(SRC, "mv", "the-boat-in-the-garden", "project.json");
      const doc = readJson(proj);
      /* Local paths would be the obvious thing to strip and there are none —
       * the document stores bare filenames throughout. Assert that rather than
       * trusting it, because the day one appears is the day this ships somebody
       * else's directory layout. */
      const abs = JSON.stringify(doc).match(/[A-Za-z]:\\\\|[A-Za-z]:\//g);
      if (abs) throw new Error(`project document contains ${abs.length} absolute paths`);
      /* The rendered PNGs and MP4s the document names are 36 MB of assets that
       * do not ship. Say so IN the document rather than leaving a reader to
       * discover broken references. */
      doc._note = "Exported by scripts/examples.mjs from a real project. The image and clip "
                + "filenames below refer to files in that project's own assets/ folder, which is "
                + "36 MB and is not shipped here; one of the clips is, as scene-3.mp4.";
      const clip = doc.clips["0"];
      const clipSrc = path.join(SRC, "clips", clip.clipFile);
      const g = await graphFromMp4(clipSrc);
      const shotPrompt = g ? nodesOf(g, "CLIPTextEncode")[0][1].inputs.text : null;
      const board = doc.boards["2"];
      return {
        files: [
          { name: "bible.json", json: doc },
          { name: "scene-3-prompt.txt", text: (shotPrompt || "input not recorded") + "\n" },
          { name: "scene-3.mp4", copyFrom: clipSrc },
        ],
        entry: {
          input: ["bible.json", "scene-3-prompt.txt"],
          output: ["scene-3.mp4"],
          recoveredFrom: "The project document as saved, with no absolute paths in it (asserted at "
                       + "build time). The scene prompt is the mp4's own `prompt` tag — the graph "
                       + "ComfyUI ran — not a re-derivation from the bible.",
          measured: {
            segments: doc.segments.length,
            characters: doc.characters.length,
            backgrounds: doc.backgrounds.length,
            songSeconds: doc.song.durationSeconds,
            bpm: doc.beats?.bpm ?? null,
            clipSeed: clip.takes.at(-1)?.seed ?? null,
            clipEngine: clip.takes.at(-1)?.engine ?? null,
            takesBeforeThisOne: clip.takes.length - 1,
          },
          teaches: "Read the chain: `brief` and `styleBible` set the look once; `boards[2].boardPrompt` "
                 + `is "${board.boardPrompt}"; the clip prompt that reached the engine is the style `
                 + "line, then the named references as `<Picture 1>` / `<Picture 2>`, then the shot's "
                 + "own action. A scene's shot ACTION is the field that actually writes the clip — "
                 + "everything above it is context that gets prepended.",
          attribution: attributionFor("videoLtx"),
        },
      };
    },
  },
];

/* ── build ──────────────────────────────────────────────────────────────── */

async function build({ check }) {
  const manifest = { _: null, builtFrom: null, budgetBytes: BUDGET_BYTES, totalBytes: 0, examples: [] };
  manifest._ = "GENERATED by scripts/examples.mjs. Every input here was read back out of a store or "
             + "an artifact on the machine that made it — never written by hand. server/docs_test.js "
             + "checks this file against the directory beside it.";

  const staged = [];
  for (const ex of EXAMPLES) {
    const built = await ex.build();
    const files = [];
    for (const f of built.files) {
      const rel = path.posix.join(ex.dir, f.name);
      const buf = f.copyFrom
        ? readFileSync(f.copyFrom)
        : Buffer.from(f.json ? JSON.stringify(f.json, null, 2) + "\n" : f.text, "utf8");
      staged.push({ rel, buf });
      files.push({ name: f.name, bytes: buf.length, sha256: sha(buf) });
    }
    manifest.examples.push({
      dir: ex.dir, title: ex.title, why: ex.why, ...built.entry, files,
    });
  }

  manifest.totalBytes = staged.reduce((a, s) => a + s.buf.length, 0);
  if (manifest.totalBytes > BUDGET_BYTES) {
    throw new Error(`examples/ would be ${(manifest.totalBytes / 1e6).toFixed(1)} MB, over the `
                  + `${(BUDGET_BYTES / 1e6).toFixed(0)} MB budget. Drop something rather than raising it.`);
  }
  manifest.builtFrom = new Date().toISOString().slice(0, 10);

  const readme = renderReadme(manifest);
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";

  if (check) {
    let bad = 0;
    for (const s of staged) {
      const p = path.join(OUT, s.rel);
      if (!existsSync(p)) { console.log(`  MISSING  examples/${s.rel}`); bad++; continue; }
      const have = readFileSync(p);
      if (sha(have) !== sha(s.buf)) { console.log(`  DRIFTED  examples/${s.rel}`); bad++; }
    }
    /* builtFrom is a date and would fail --check every day it is not rebuilt.
     * Compare everything else. */
    const cur = existsSync(path.join(OUT, "manifest.json"))
      ? readJson(path.join(OUT, "manifest.json")) : null;
    if (!cur || JSON.stringify({ ...cur, builtFrom: null }) !== JSON.stringify({ ...manifest, builtFrom: null })) {
      console.log("  DRIFTED  examples/manifest.json"); bad++;
    }
    if (readme !== (existsSync(path.join(OUT, "README.md")) ? await readFile(path.join(OUT, "README.md"), "utf8") : "")) {
      console.log("  DRIFTED  examples/README.md"); bad++;
    }
    if (bad) { console.log(`\n  ${bad} file(s) differ — run: node scripts/examples.mjs`); return 1; }
    console.log(`  examples/ matches (${manifest.examples.length} examples, ${(manifest.totalBytes / 1e6).toFixed(1)} MB)`);
    return 0;
  }

  /* Rebuild from empty so a removed example cannot leave an orphan behind that
   * the README no longer mentions and nothing ever deletes. */
  if (existsSync(OUT)) {
    for (const e of await readdir(OUT)) await rm(path.join(OUT, e), { recursive: true, force: true });
  }
  for (const s of staged) {
    const p = path.join(OUT, s.rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, s.buf);
  }
  await writeFile(path.join(OUT, "manifest.json"), manifestText, "utf8");
  await writeFile(path.join(OUT, "README.md"), readme, "utf8");
  for (const ex of manifest.examples) {
    console.log(`  ${ex.dir.padEnd(20)} ${ex.files.length} files  `
      + `${(ex.files.reduce((a, f) => a + f.bytes, 0) / 1e6).toFixed(2)} MB`);
  }
  console.log(`  ${(manifest.totalBytes / 1e6).toFixed(1)} MB of ${(BUDGET_BYTES / 1e6).toFixed(0)} MB budget`);
  return 0;
}

/** examples/README.md — generated, because a hand-written index of a generated
 *  directory is the next thing to go stale. */
function renderReadme(manifest) {
  const engine = CATALOG.find((c) => c.required);
  const mm = engine.outputRights.conditions.find((c) => c.startsWith("§3.1")) || "";
  const L = [
    "# Examples",
    "",
    "Every one of these is an **input beside the output it produced**, on this machine, with the",
    "request recovered from what the render itself stored — a library record, or the graph ComfyUI",
    "embedded in the file. None of them is a reconstruction of what a request *would* look like.",
    "",
    "Start at `01-song`. If a field says `input not recorded`, that is the truth about this",
    "machine's records rather than a placeholder.",
    "",
    "`manifest.json` is the machine-readable version — every file with its byte count and sha256,",
    "what each example teaches, and its licence. Both files are generated by",
    "`node scripts/examples.mjs`, and `server/docs_test.js` fails if the directory and the manifest",
    "disagree.",
    "",
    "## Attribution",
    "",
    `The audio here is **MiniMax-Music3** output. ${mm.replace(/^§3\.1 — /, "The licence's §3.1 says ")}`,
    "So the name is stated here, at the top of the thing you are looking at — the same way the app",
    "states it in its own corner.",
    "",
    `Licence: ${engine.licence} — ${engine.outputRights.url}`,
    "",
    "The video and image examples carry their own models' terms in `manifest.json`. Studio hosts no",
    "weights and mirrors none; those licences are between you and the publishers.",
    "",
    "## What is here",
    "",
  ];
  for (const ex of manifest.examples) {
    const mb = ex.files.reduce((a, f) => a + f.bytes, 0) / 1e6;
    L.push(`### \`${ex.dir}/\` — ${ex.title}`, "");
    L.push(ex.why, "");
    L.push(`**in** ${ex.input.map((f) => `\`${f}\``).join(", ")} → **out** `
      + `${ex.output.map((f) => `\`${f}\``).join(", ")}  ·  ${mb.toFixed(2)} MB`, "");
    L.push(`*What it teaches.* ${ex.teaches}`, "");
    L.push(`*Where the input came from.* ${ex.recoveredFrom}`, "");
    if (ex.alsoNote) L.push(ex.alsoNote, "");
  }
  L.push("---", "",
    `${manifest.examples.length} examples, `
    + `${(manifest.totalBytes / 1e6).toFixed(1)} MB. Rebuild with \`node scripts/examples.mjs\`.`, "");
  return L.join("\n");
}

if (process.argv[1]?.endsWith("examples.mjs")) {
  process.exit(await build({ check: process.argv.includes("--check") }));
}
