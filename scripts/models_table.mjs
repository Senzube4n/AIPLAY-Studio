#!/usr/bin/env node
/**
 * Render the model tables in README.md and INSTALL.md FROM server/models.js.
 *
 * WHY THIS SCRIPT EXISTS. The catalogue has seventeen capabilities. On
 * 2026-09-02 the README's hand-typed table listed thirteen and INSTALL.md's
 * listed seven, and where they overlapped they disagreed with the catalogue and
 * with each other:
 *
 *   MiniMax H3        README "43 GB"   INSTALL "34.5 GB"   catalogue 42.9 GB
 *   DAV encoder       README "306 MB"  INSTALL "292 MB"    catalogue 306 MB
 *   RIFE 4.26         README "22 MB"                       catalogue 22.7 MB
 *   Ideogram 4, Anima, SFX, narration, BiRefNet, video refs — in neither table.
 *
 * None of that is carelessness; it is what a hand-kept second copy of a list
 * DOES. The sizes are the number a reader uses to decide whether they have the
 * disk, and the licences are the reason several of these models are in the app
 * at all — so the two documents a stranger reads before installing anything were
 * the two least trustworthy statements of both.
 *
 * So the tables are GENERATED, the way NOTICE already is (scripts/gen_notice.mjs
 * — same argument, same shape, same --check). One catalogue; the docs, the
 * Models screen, the recommendation block and NOTICE are all views of it.
 *
 *   node scripts/models_table.mjs           rewrite both tables in place
 *   node scripts/models_table.mjs --check   fail if either has drifted (pre-commit)
 *
 * Everything outside the marker comments is left exactly alone — the prose
 * around the table is a human's and this script has no opinion about it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../server/models.js";
import { installLines, SETTING_WORDS, PYTHON_MIN } from "../server/lrc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

export const BEGIN = "<!-- MODELS:BEGIN -->";
export const END = "<!-- MODELS:END -->";
export const TARGETS = ["README.md", "INSTALL.md"];

/**
 * Bytes as a person reads them.
 *
 * Decimal GB, because that is what the publishers' own pages say and what the
 * Models screen shows; a table that said 40.0 GiB beside a button that said
 * 42.9 GB would be two numbers for one file. One decimal below 100 GB, none
 * above, and MB under a gigabyte.
 */
export function size(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return null;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

/** The licence NAME. Several entries carry a paragraph of reasoning after an
 *  em dash; that belongs on the Models screen, not in a table cell. */
const licenceName = (licence) =>
  String(licence || "see publisher").split(" — ")[0].replace(/\s+Licence$/i, "").trim();

/** "Cover art — FLUX.2 klein 4B" → "FLUX.2 klein 4B", for prose that has
 *  already said which capability it is talking about. */
const modelName = (label) => {
  const parts = String(label).split(" — ");
  return (parts.length > 1 ? parts.slice(1).join(" — ") : parts[0]).trim();
};

const bytesOf = (cap) => ((cap.defaultFiles || cap.files) || []).reduce((a, f) => a + (f.bytes || 0), 0);

/**
 * Which destination files belong to more than one capability.
 *
 * Not decoration. qwen_3_4b.safetensors is 8.04 GB and three entries need it,
 * so a reader who adds the rows up to plan their disk over-quotes themselves by
 * eight gigabytes — on the table whose only job is to be trusted. server/fit.js
 * dedupes the same way for the live recommendation; this is the static half of
 * that same fact, computed from the same field.
 */
export function sharedFiles() {
  const owners = new Map();
  for (const cap of CATALOG) {
    for (const f of (cap.defaultFiles || cap.files) || []) {
      /* ⚠ THE WHOLE DEST, NOT THE BASENAME — and this was a live wrong claim,
       * not a hypothetical. Shared means THE SAME FILE, which is a path; the
       * basename is only a proxy for it, and the proxy broke the moment two
       * capabilities arrived carrying the diffusers convention. TripoSG has a
       * transformer/ and a vae/ diffusion_pytorch_model.safetensors, and both
       * TripoSG and UniRig have a model.safetensors — so this table printed
       * "shared by TripoSG 1.5B, TripoSG 1.5B" and "(null)" for a file nothing
       * shares. On the one table whose only job is to be trusted about disk.
       * qwen_3_4b.safetensors is still deduplicated exactly as before, because
       * the three rows that need it name the same DEST. */
      const key = (f.dest || f.url || "").split("\\").join("/").toLowerCase();
      if (!key) continue;
      /* KEYED by the path, NAMED by the basename. The key answers the identity
       * question; the name is what a reader needs — and an absolute path off
       * THIS machine has no business in a public README, which is exactly what
       * keying and naming with the same value produced for one run of this. */
      if (!owners.has(key)) {
        owners.set(key, { name: path.basename(f.dest || f.url || ""), bytes: f.bytes || 0, caps: [] });
      }
      owners.get(key).caps.push(cap);
    }
  }
  return [...owners.entries()]
    .filter(([, v]) => v.caps.length > 1)
    .sort((a, b) => b[1].bytes - a[1].bytes);
}

/* ── the markers a cell can carry ──────────────────────────────────────────
 *
 * Each one is a fact already in the catalogue, and each is a reason somebody
 * might not be able to use a model at all — territory, a gate the downloader
 * cannot pass, output terms nobody has read. They are marked in the row and
 * explained once below it, generated from the entries that actually carry them,
 * so a marker can never outlive the thing it marks. */
const FLAGS = [
  {
    key: "territory",
    has: (c) => !!c.region,
    heading: "⚠ **territory**",
    /* THE ONE THING A ROW MAY SAY IN ITS OWN CELL. The markdown table marks the
     * row and explains it in a footnote below; docs/index.html has no footnote,
     * so its cell spells the territories out — from `excluded`, never typed.
     * Naming them is the point: on 2026-09-02 that list was hand-copied in five
     * files by five hands and two of them said three names where the catalogue
     * said four (server/territory_test.js). Same rule as the Thanks page and
     * the Models screen, which join the same array. */
    mark: (c) => `excludes ${c.region.excluded.join(", ")}`,
    /* The licence sentence is QUOTED from the catalogue rather than rebuilt out
     * of `excluded`. A generator that assembles its own wording for a territory
     * clause is a generator paraphrasing a licence, and the two entries that
     * carry one share a single text, so it is grouped by that text. */
    body: (caps) => {
      const byText = new Map();
      for (const c of caps) {
        if (!byText.has(c.region.text)) byText.set(c.region.text, []);
        byText.get(c.region.text).push(modelName(c.label));
      }
      return [...byText].map(([text, names]) =>
        `**${names.join(" and ")}.** ${text}`).join(" ")
        + " Studio treats this as a blocking acknowledgement and refuses the download without it.";
    },
  },
  {
    key: "gated",
    has: (c) => !!c.gated,
    heading: "⚠ **gated**",
    mark: () => "gated repo",
    body: (caps) => caps.map((c) =>
      `**${modelName(c.label)}.** The repository is access-gated, so the built-in downloader cannot `
      + `fetch it — it has no token and deliberately nowhere to keep one. ${c.gated.how} `
      + `Licence and access: ${c.gated.url}`).join(" "),
  },
  {
    key: "terms unread",
    has: (c) => c.outputRights?.class === "unknown",
    heading: "⚠ **terms unread**",
    /* The URL comes FIRST because the catalogue's own note says "the URL above"
     * — a sentence that is only true if one is. */
    body: (caps) => caps.map((c) =>
      `**${modelName(c.label)}** — ${c.outputRights.url}\n\n${c.outputRights.note}`).join("\n\n"),
  },
  {
    key: "not for sale",
    has: (c) => c.outputRights?.class === "not-for-sale",
    heading: "⚠ **not for sale**",
    body: (caps) => caps.map((c) =>
      `**${modelName(c.label)}.** Studio retains a conservative noncommercial / not-for-sale `
      + `classification. This does not establish that every generated output is governed by the `
      + `weights' licence. Review the source terms and output scope: ${c.outputRights.url}.`).join(" "),
  },
  {
    /* A LABEL THAT FOLLOWS THE AUTHORS' OWN STATEMENT rather than the licence
     * file (YuE2 since 2026-09-24, the owner's decision). The row's licence
     * cell still names the file (CC BY-NC 4.0), so without this marker the
     * table would say non-commercial while the app says sellable. The words
     * are the row's own chip; the file stays named beside it. */
    key: "sellable by individuals",
    has: (c) => c.outputRights?.basis === "authors-statement",
    heading: "⚠ **sellable by individuals**",
    body: (caps) => caps.map((c) =>
      `**${modelName(c.label)}.** ${c.outputRights.chip}. The licence file shipped with the weights still reads `
      + `${c.outputRights.licenceFile?.name || licenceName(c.licence)}; Studio's label follows the authors' statement: `
      + `${c.outputRights.url}.`).join(" "),
  },
  {
    /* `pip` on a row with no files means there is nothing to download at all;
     * `+pip` means the weights ARE a download and a python package is needed on
     * top of them. Two different first minutes, so two different markers. */
    key: "pip",
    has: (c) => !!c.viaPackage && !((c.defaultFiles || c.files) || []).length,
    heading: "**pip, not a download**",
    /* Spelled out rather than abbreviated to the key, because the page that
     * uses `mark` has no footnote under the table — a cell reading "pip" beside
     * a size is a puzzle, and this column exists to remove puzzles. */
    mark: () => "pip, not a download",
    body: () => pipBody(),
  },
  {
    key: "+pip",
    has: (c) => !!c.packageInstall && ((c.defaultFiles || c.files) || []).length > 0,
    heading: null,               // covered by the pip footnote above
    mark: () => "+ a pip package",
    body: () => "",
  },
  {
    key: "rights",
    has: () => false,            // a summary of the column, not a row marker
    heading: "**selling what you make**",
    body: () => {
      const by = (cls) => CATALOG.filter((c) => c.outputRights?.class === cls);
      const free = by("unrestricted");
      const cond = by("yours-with-conditions");
      const unread = by("unknown");
      const banned = by("not-for-sale");
      const engine = CATALOG.find((c) => c.required);
      const parts = [
        `Model licences and rights in generated material are separate questions. The catalogue `
        + `records them separately. ${free.length} of ${CATALOG.length} are classified as placing no licence conditions on generated material `
        + `(${free.map((c) => modelName(c.label)).join(", ")}).`,
        cond.length
          ? `${cond.length} say you may and attach conditions (${cond.map((c) => modelName(c.label)).join(", ")}).`
          : "",
        banned.length ? `${banned.length} are conservatively classified noncommercial / not for sale; that label does not resolve every output's legal status.` : "",
        unread.length ? `${unread.length} — ${unread.map((c) => modelName(c.label)).join(", ")} — nobody here has read.` : "",
      ];
      if (engine?.outputRights?.conditions?.length) {
        parts.push(`For ${modelName(engine.label)}: ${engine.outputRights.conditions[0]}`);
      }
      parts.push("The operative sentence is quoted verbatim in `server/models.js` and shown on the Models "
        + "screen before you download anything.");
      return parts.filter(Boolean).join(" ");
    },
  },
  {
    key: "shared",
    has: () => false,            // computed across entries, not from one
    heading: "**shared files**",
    body: () => {
      const shared = sharedFiles();
      const total = shared.reduce((a, [, v]) => a + v.bytes, 0);
      return `${shared.length} file${shared.length === 1 ? " is" : "s are"} used by more than one `
        + `capability, so picking two of those costs less than adding their rows — up to ${size(total)} less. `
        + shared.map(([name, v]) =>
            `\`${v.name}\` (${size(v.bytes)}) is shared by ${v.caps.map((c) => modelName(c.label)).join(", ")}`)
          .join("; ") + ". The Models screen quotes the deduplicated figure.";
    },
  },
];

/**
 * WHERE timed lyrics' packages go, under the generic line.
 *
 * The generic `python -m pip install faster-whisper stable-ts` is how a first
 * user put both packages into the python on their PATH, which Studio never runs
 * for timed lyrics, and got "alignment failed". So this row also says which
 * interpreter, and gives the verified commands from the same builder the app's
 * own messages use (server/lrc.js installLines). They are aimed at a path
 * RELATIVE to the user folder, which a new Command Prompt or PowerShell window
 * opens in: both shells run it as written, with a space in the user name or
 * not, where `%USERPROFILE%` would work in only one of them.
 */
const TARGET_LINES = {
  lyrics: () => installLines("aiplay-whisper\\venv\\Scripts\\python.exe", { platform: "win32", create: true }),
};
/** Every command line the target notes print. server/docs_test.js accepts
 *  these beside the catalogue's own lines: they come from the builder the app's
 *  messages use, so they are not a document inventing a pip command. */
export const targetCommands = () => Object.values(TARGET_LINES).flatMap((f) => f());

const TARGET_NOTES = {
  lyrics: () => {
    const lines = TARGET_LINES.lyrics();
    return "\n    → Into Studio's own whisper venv, not the python on your PATH: "
      + "`%USERPROFILE%\\aiplay-whisper\\venv` (or the python chosen in "
      + `${SETTING_WORDS}, or AIPLAY_WHISPER_PYTHON). With ${PYTHON_MIN}, in a new `
      + "Command Prompt or PowerShell window (both open in your user folder): "
      + lines.map((l) => `\`${l}\``).join(", then ")
      + ". The torch line is for an NVIDIA card only. On Linux the venv's python is "
      + "`aiplay-whisper/venv/bin/python`.";
  },
};

/** Every capability that needs something from pip, with the line to type. */
function pipBody() {
  const caps = CATALOG.filter((c) => c.viaPackage || c.packageInstall);
  const lines = caps.map((c) => {
    const what = c.packageInstall
      ? `\`${c.packageInstall}\``
      : `${c.viaPackage} — no single command; see the Models screen`;
    const extra = ((c.defaultFiles || c.files) || []).length
      ? ` (on top of the ${size(bytesOf(c))} of weights in the table)`
      : "";
    return `  · **${modelName(c.label)}** — ${what}${extra}${TARGET_NOTES[c.id]?.() || ""}`;
  });
  return "Some capabilities are Python packages that fetch their own weights, so Studio has no file to "
    + "verify and no button to press. They belong in a Python that is **not** ComfyUI's: installing them "
    + "there can pull the torch build the engine depends on back down, which costs about 5× the speed of "
    + "everything (INSTALL.md §5).\n\n" + lines.join("\n")
    + "\n\n`node scripts/extras_setup.mjs` prints the exact command for your machine, aimed at the "
    + "interpreter Studio will actually invoke, and says which are already installed.";
}

/** A row's flag markers, in FLAGS order so the table reads consistently. */
function flagsFor(cap) {
  return FLAGS.filter((f) => f.has(cap)).map((f) => f.key);
}

export function hardwareCell(minimum, recommended, { experimental = false, gpu = false } = {}) {
  if (!Number.isFinite(minimum)) return experimental ? "Unknown (experimental)" : "Unknown";
  const base = gpu && minimum === 0 ? "none" : `${minimum} GB`;
  return Number.isFinite(recommended) ? `${base} (${recommended} rec)` : base;
}

function row(cap) {
  const label = cap.label;
  const bytes = bytesOf(cap);
  const download = bytes
    ? size(bytes)
    : cap.approxBytes ? `~${size(cap.approxBytes)}` : "—";
  /* `pip`/`+pip` are not warnings — they are "there is no button on this row",
   * which is a fact about the install and not about the licence. */
  const marks = flagsFor(cap).map((m) => (m.endsWith("pip") ? m : `⚠ ${m}`));
  const licence = licenceName(cap.licence) + (marks.length ? ` · ${marks.join(" · ")}` : "");
  const r = cap.requires || {};
  const vram = hardwareCell(r.vramMinGb, r.vramRecGb, { experimental: r.experimental, gpu: true });
  const ram = hardwareCell(r.ramMinGb, r.ramRecGb, { experimental: r.experimental });
  /* Pipes inside a cell would end the cell. No label or licence contains one
   * today; escaping is cheaper than the day one does. */
  return `| ${[label, download, licence, vram, ram].map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
}

/** The generated block, identical in both documents on purpose: two tables that
 *  differ are two tables a reader has to reconcile. */
export function render() {
  const lines = [
    BEGIN,
    "<!-- Generated by scripts/models_table.mjs from server/models.js. Do not edit by hand:",
    "     the pre-commit hook fails if this block and the catalogue disagree. -->",
    "",
    "| capability | download | licence | your card | your RAM |",
    "|---|---|---|---|---|",
    ...CATALOG.map(row),
    "",
    `${CATALOG.length} capabilities. **Choose one music engine** and install the runtime and models `
      + "for the features you want. Native YuE2 music-only does not require MiniMax, ComfyUI or Python. "
      + "Hardware figures are capability-specific guidance, not a guarantee; an experimental Unknown "
      + "means no minimum has been established. Streaming support and memory measurements from other "
      + "engines must not be applied to native GGUF.",
  ];

  for (const flag of FLAGS) {
    if (!flag.heading) continue;                       // marker only, explained elsewhere
    const caps = CATALOG.filter((c) => flag.has(c));
    if (flag.key === "shared") {
      if (!sharedFiles().length) continue;
    } else if (flag.key === "rights") {
      /* always rendered: "nothing here restricts your output" is as much an
       * answer as a restriction, and it is the answer for most of the table */
    } else if (!caps.length) continue;
    lines.push("", `${flag.heading} — ${flag.body(caps)}`);
  }

  lines.push(
    "",
    "Studio hosts no weights and mirrors none: every download goes straight to the publisher, and the "
      + "licence is between you and them.",
    END,
  );
  return lines;
}

/**
 * ⚠ LINE ENDINGS ARE PART OF THE COMPARISON — the same trap gen_notice.mjs
 * documents. `core.autocrlf` is true on Windows, so a fresh clone hands this
 * script CRLF markdown; writing LF lines into it would report drift on a
 * checkout nobody has touched, and a gate that fails on a clean tree is a gate
 * people delete.
 */
export function rebuild(current, file) {
  const EOL = /\r\n/.test(current) ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === BEGIN);
  const end = lines.findIndex((l) => l.trim() === END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${file} has no ${BEGIN} … ${END} block — refusing to guess where the table goes.`);
  }
  /* ⚠ Flatten first. Several footnote bodies contain their own "\n\n" — a list
   * of pip commands, a URL above its note — and joining an array whose ELEMENTS
   * hold bare newlines into a CRLF file leaves nine mixed line endings behind.
   * They are invisible in every editor and make --check fail on a file it just
   * wrote. */
  const block = render().join("\n").split("\n");
  return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join(EOL);
}

/* ══ the HTML view: docs/index.html ═══════════════════════════════════════
 *
 * The landing page is the THIRD document a stranger reads before they trust
 * anything, and it kept a third hand-typed copy of this table — six of the
 * seventeen capabilities, with H3's territory list typed out for the fourth
 * time in this repository. The easy-setup gate corrected its numbers on
 * 2026-09-02, which is the tell: a table somebody has to correct is a table
 * that will need correcting again.
 *
 * So it is generated, from the same rows, for the same reason. The page is not
 * markdown, so it gets its own renderer rather than a converted one — but the
 * FACTS are the same objects the markdown table reads, and the markers are the
 * same FLAGS list. Two views of one catalogue; no third copy.
 *
 * Two blocks, because the page states the catalogue in two places: the
 * capability table, and the disk line under "what your machine needs".
 */
export const HTML_TARGET = "docs/index.html";
export const htmlBegin = (name) => `<!-- MODELS:BEGIN${name ? ` ${name}` : ""} -->`;
export const htmlEnd = (name) => `<!-- MODELS:END${name ? ` ${name}` : ""} -->`;

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A row's markers as the page words them. `mark` where a flag states one,
 *  the key otherwise — one vocabulary, so the page and the README cannot come
 *  to describe the same restriction differently. */
function htmlMarks(cap) {
  return FLAGS.filter((f) => f.has(cap))
    .map((f) => (f.key.endsWith("pip") ? "" : "⚠ ") + (f.mark ? f.mark(cap) : f.key));
}

function htmlRow(cap) {
  const bytes = bytesOf(cap);
  const download = bytes ? size(bytes) : cap.approxBytes ? `~${size(cap.approxBytes)}` : "—";
  const marks = htmlMarks(cap);
  const licence = licenceName(cap.licence) + (marks.length ? ` · ${marks.join(" · ")}` : "");
  /* `.flag` is the page's warn colour. A pip note is not a warning — it is
   * "there is no button on this row" — so it does not colour the cell. */
  const warn = marks.some((m) => m.startsWith("⚠"));
  return `    <tr><td>${esc(cap.label)}</td>`
    + `<td class="n">${esc(download)}</td>`
    + `<td${warn ? ' class="flag"' : ""}>${esc(licence)}</td></tr>`;
}

const GENERATED_BY =
  "<!-- Generated by scripts/models_table.mjs from server/models.js. Do not edit by hand:\n"
  + "     server/docs_test.js fails if this block and the catalogue disagree. -->";

function renderHtmlTable() {
  return [
    ...GENERATED_BY.split("\n"),
    "<table>",
    "  <thead><tr><th>Capability</th><th>Download</th><th>Licence</th></tr></thead>",
    "  <tbody>",
    ...CATALOG.map(htmlRow),
    "  </tbody>",
    "</table>",
  ];
}

/**
 * The clip engines, by the catalogue's own naming.
 *
 * `Video clips — …` is how models.js labels an engine you render clips with;
 * `Video references — …` is the H3 add-on and is deliberately not one. Read
 * from the label rather than from a list of ids kept here, so a third engine
 * appears on the page the day it appears in the catalogue.
 */
const clipEngines = () => CATALOG.filter((c) => /^Video clips\b/.test(c.label));

/** "Video clips — MiniMax H3 (quantised)" → "MiniMax H3". The build is on the
 *  Models screen; a hardware table wants the name people say out loud. */
const shortName = (label) => modelName(label).replace(/\s*\([^()]*\)\s*$/, "").trim();

function renderHtmlDiskRow() {
  const cell = clipEngines().map((c) => `${size(bytesOf(c))} (${shortName(c.label)})`).join(" or ");
  return [`<tr><td>Disk</td><td class="n">${esc(cell)}</td></tr>`];
}

export const HTML_BLOCKS = [
  { name: "", render: renderHtmlTable },
  { name: "video-disk", render: renderHtmlDiskRow },
];

/**
 * Same bargain as rebuild(), with two differences that matter.
 *
 * The MARKER LINES SURVIVE rather than being reprinted, and the block is
 * re-indented to whatever column its opening marker sits at — an HTML page is
 * read by people in a way a generated markdown table is not, and a block that
 * fought the surrounding indentation would be the reason somebody "tidied" it
 * back into a hand-typed table.
 *
 * Line endings are still part of the comparison: docs/index.html is CRLF in
 * this working tree, and a gate that fails on a clean checkout gets deleted.
 */
export function rebuildHtml(current, file) {
  const EOL = /\r\n/.test(current) ? "\r\n" : "\n";
  let lines = current.split(/\r?\n/);
  for (const block of HTML_BLOCKS) {
    const b = htmlBegin(block.name), e = htmlEnd(block.name);
    const start = lines.findIndex((l) => l.trim() === b);
    const end = lines.findIndex((l) => l.trim() === e);
    if (start < 0 || end < 0 || end < start) {
      throw new Error(`${file} has no ${b} … ${e} block — refusing to guess where it goes.`);
    }
    const indent = lines[start].match(/^\s*/)[0];
    /* Flatten first — the same trap rebuild() documents. A renderer element
     * carrying its own newline would otherwise land in a CRLF file with LF
     * endings inside it, invisible in every editor and enough to make --check
     * fail on the file it has just written. */
    const body = block.render().join("\n").split("\n").map((l) => (l ? indent + l : l));
    lines = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)];
  }
  return lines.join(EOL);
}

/* Paths, not URL text: `file://${argv[1]}` never equals a percent-encoded,
 * three-slash import.meta.url on Windows, and the endsWith() rescue that made
 * it work would also fire for any other script of the same name. */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes("--check");
  let drifted = 0;
  /* Three documents, two renderers, one catalogue. The HTML page is rebuilt by
   * the same command as the markdown so nobody can regenerate half of them. */
  const jobs = [...TARGETS.map((n) => [n, rebuild]), [HTML_TARGET, rebuildHtml]];
  for (const [name, build] of jobs) {
    const file = path.join(ROOT, name);
    const current = readFileSync(file, "utf8");
    const next = build(current, name);
    if (current === next) {
      console.log(`  ${name} model table matches the catalogue`);
      continue;
    }
    if (check) {
      drifted++;
      console.log(`  ${name} has DRIFTED from server/models.js — run: node scripts/models_table.mjs`);
      const a = current.split(/\r?\n/), b = next.split(/\r?\n/);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`    first difference at line ${i + 1}:`);
          console.log(`      ${name}:    ${JSON.stringify(a[i] ?? null)}`);
          console.log(`      catalogue: ${JSON.stringify(b[i] ?? null)}`);
          break;
        }
      }
    } else {
      writeFileSync(file, next, "utf8");
      console.log(`  ${name} regenerated from the catalogue (${CATALOG.length} capabilities)`);
    }
  }
  process.exit(drifted ? 1 : 0);
}
