/**
 * models_for_this_machine — the hardware answer, for an agent.
 *
 * THE GAP THIS CLOSES was one-directional in the rarer and more embarrassing
 * direction: the Models screen is one of the few surfaces in this app a person
 * could reach and an agent could not. /api/models had no tool at all. So an
 * assistant asked "what should I download to make videos on this machine"
 * had three options — guess from the README's hand-copied table, read the
 * source, or tell the user to go and look — and the first two are how a model
 * ends up confidently recommending a 43 GB download to an 8 GB card.
 *
 * ONE COMPUTATION, TWO READERS. This does not judge anything itself. It calls
 * the same GET the Models screen calls and returns the `fit` and `recommended`
 * blocks that server/fit.js computed for the page. If the screen says the card
 * is too small, the agent says the card is too small, in the same words and
 * from the same arithmetic — which is the whole reason the fit was computed on
 * the server rather than in web/app.js.
 *
 * ⚠ WHAT AN AGENT MAY AND MAY NOT START. Reading is free; starting a download
 * is `download_model`, and the acceptances stay with the person. MiniMax H3 is
 * licensed only outside four territories and the downloader refuses without an
 * explicit acknowledgement — which the tool may pass on ONLY after the person
 * has said it in the conversation, never by inferring it; LTX 2.5 needs its
 * licence accepted on the publisher's own page and cannot be fetched here at
 * all; the YuE2 GGUF kit has its own setup door, which demands the terms be
 * read first. An acknowledgement an agent clicks on your behalf is not an
 * acknowledgement.
 *
 * ⚠ This paragraph said "there is no download tool here" for months after one
 * was added below. A comment that describes the opposite of the file is worse
 * than no comment: the tools' own descriptions are read by a model that cannot
 * check them against the code.
 */
import { CATALOG } from "./models.js";

/**
 * The excluded territories, IN THE CATALOGUE'S OWN WORDS.
 *
 * This paragraph used to hand-type them, and got them right — which is exactly
 * why it had to stop. The same list is written out in six places in this tree
 * and two of them are already wrong: they say "the EU, the UK or South Korea",
 * three territories, because that WAS the list before the United States was
 * added to it. Nothing failed when it changed. A licence sentence that is
 * merely correct today is a sentence waiting to be stale, and this one is read
 * by an assistant deciding whether to tell somebody in Chicago that a model is
 * available to them.
 *
 * server/territory_test.js is the gate; `region.excluded` on the H3 entries is
 * the single source. Joined with "or" because it reads inside a prohibition.
 */
const H3_EXCLUDED = (CATALOG.find((c) => c.region)?.region.excluded || [])
  /* Every one of these four is a proper noun that takes the article in English,
   * and the catalogue stores them bare so they can also be rendered as a chip
   * list. Adding it here rather than storing it there keeps the data a list of
   * names and this a sentence. */
  .map((t) => `the ${t}`);
const H3_TERRITORIES = H3_EXCLUDED.length
  ? H3_EXCLUDED.slice(0, -1).join(", ") + " or " + H3_EXCLUDED[H3_EXCLUDED.length - 1]
  : "";

export function modelTools(api) {
  return [
    {
      name: "model_inventory",
      description: "Read the complete Models page inventory: catalogue files, native/quantized build provenance, byte/hash records, local overrides, progress and hardware fit. Use this when models_for_this_machine's compact summary omits a needed file or install detail. Does not download or install anything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("GET", "/api/models"); },
    },
    {
      name: "models_folder",
      description: "Scan a local models folder, use it for future downloads, or stop using a previous folder. scan reads only. use saves the preference and keeps models from the previous folder available after restart; force:true permits an empty folder and create:true also creates a missing folder under an existing parent. drop stops searching a previous folder after restart, without deleting its files. also adds a second folder of models that already exist, to check and load from after a restart; downloads still go to the models folder, and the main folder itself is refused. No model move, download or restart occurs in this tool.",
      inputSchema: { type: "object", required: ["action", "dir"], properties: { action: { type: "string", enum: ["scan", "use", "also", "drop"] }, dir: { type: "string", minLength: 1 }, force: { type: "boolean" }, create: { type: "boolean", description: "With use and force:true, create a missing folder whose parent exists." } }, additionalProperties: false },
      async run(a) {
        if (typeof a.dir !== "string" || !a.dir.trim()) throw new Error("Give a models folder.");
        if (a.action === "scan") return await api("POST", "/api/models", { action: "scanFolder", dir: a.dir });
        if (a.action === "drop") return await api("POST", "/api/models", { action: "dropAlso", dir: a.dir });
        if (a.action === "also") return await api("POST", "/api/models", { action: "addAlso", dir: a.dir });
        if (a.action !== "use") throw new Error("Choose scan, use, also or drop.");
        if (a.create && !a.force) throw new Error("Creating a new models folder requires force:true as well as create:true.");
        return await api("POST", "/api/models", { action: "setModelsDir", dir: a.dir, force: a.force === true, ...(a.create === true ? { create: true } : {}) });
      },
    },
    {
      name: "music_model_memory",
      description: "Load the selected YuE2 or ACE-Step ComfyUI music model with a short warm-up, or unload ComfyUI models to release memory. Models otherwise load automatically with a song. Both actions require idle music, artwork and engine queues; unload does not cancel work, delete model files or stop Studio. This does not unload the separate native YuE2 GGUF runtime.",
      inputSchema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["load", "unload"] } }, additionalProperties: false },
      async run(a) {
        if (!["load", "unload"].includes(a.action)) throw new Error("Choose load or unload.");
        return await api("POST", "/api/music", { action: a.action }, 900_000);
      },
    },
    {
      name: "model_override",
      description: "Map a catalogue filename to an installed file in the same model shelf, or clear the mapping with use:null. Uses the Models page validation. The mapping takes effect for subsequent graphs; this does not prove a different architecture or quantization is compatible.",
      inputSchema: { type: "object", required: ["file", "use"], properties: { file: { type: "string" }, use: { type: ["string", "null"] } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/models", { action: "override", file: a.file, use: a.use }); },
    },
    {
      name: "models_for_this_machine",
      description:
        "WHICH MODELS THIS COMPUTER CAN ACTUALLY RUN, and which to download first — the same answer "
        + "the Models screen shows its owner, computed from local GPU and system-memory readings against the "
        + "requirements each publisher states.\n\n"
        + "Read this BEFORE recommending any model, any engine or any download. The catalogue holds "
        + "capabilities ranging from a 22 MB frame interpolator to a 43 GB video engine, and "
        + "the difference between them is entirely the machine you are standing on.\n\n"
        + "EVERY CAPABILITY CARRIES A `fit`, one of five:\n"
        + "  • fits      at or above the recommended VRAM and RAM.\n"
        + "  • streams   above the minimum, under the recommendation. It RUNS — Studio's low-VRAM "
        + "tiers stream weights from system RAM — and it is slower. Not a refusal.\n"
        + "  • smaller   it RUNS at a smaller picture size and clip length MEASURED to fit a card this "
        + "size (the H3 family); `why` names the size. The Video screen starts there, and make_clip "
        + "uses it when no width and height are given (its reply says so). Not a refusal.\n"
        + "  • wont-run  below the stated floor (the publisher's, or for the H3 family the smallest card "
        + "and the RAM Studio offers it on).\n"
        + "  • unknown   the required hardware information could not be read, OR nobody has run it on a "
        + "machine like this (H3's experimental 6 GB preview, H3 on an AMD card). Windows AMD and Intel "
        + "cards may be detected too; unreadable usage is not zero usage. This is NOT 'no'. Do not turn it into one.\n"
        + "A fit with `recommendable: false` is offered and never recommended (H3 under 32 GB of RAM, on "
        + "AMD, or as the preview); `why` says which, and `warning` carries the RAM or AMD sentence.\n\n"
        + "`recommended` names one pick per slot with a reason: the required music engine, ONE video "
        + "engine and, beside it, the file that turns on its Fast setting (slot `video-fast`), ONE "
        + "image model, and the fit of the pip-installed extras. The video pick is always "
        + "one Studio can actually download — LTX 2.5 is faster and better and its repository is "
        + "access-gated, so it is reported under `notes` with the publisher's hand-fetch steps and is "
        + "never recommended. The image pick is chosen by LICENCE among those that fit, not by quality: "
        + "FLUX.2 klein and Z-Image are Apache-2.0, Ideogram 4's agreement is behind a login and unread.\n\n"
        + "Use download_model to start an available catalogue download and cancel_download to stop it. "
        + `Territory-locked rows require the user's explicit acknowledgement that they are outside ${H3_TERRITORIES}.`,
      inputSchema: {
        type: "object",
        properties: {
          /* The full forty-two is a lot of tokens for the common question,
           * which is "what do I get". Off by default, and the recommendation
           * alone answers that. */
          all: {
            type: "boolean",
            description: "Include every capability with its fit and licence, not just the recommendation. "
              + "Default false — the recommendation names what to fetch; this is for auditing the rest.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("GET", "/api/models");
        if (r.error) throw new Error(r.error);

        const slim = (c) => ({
          id: c.id,
          label: c.label,
          fit: c.fit?.state,
          why: c.fit?.why,
          /* The line the Models screen shows under the badge (H3's RAM and AMD
           * sentences), and H3's size for this card; null elsewhere. */
          warning: c.fit?.warning || null,
          h3Size: c.fit?.h3 || null,
          recommendable: c.fit?.recommendable ?? null,
          ready: c.ready,
          gigabytes: Number(((c.totalBytes || 0) / 1e9).toFixed(1)),
          licence: c.licence,
          outputRights: c.outputRights?.class || null,
          /* Carried on every row rather than only on the picks: an agent
           * scanning for "what else could I use" must not find a region-locked
           * or gated model and read it as freely available. */
          territoryExcluded: c.region?.excluded || null,
          downloadable: !c.gated,
          gatedHow: c.gated?.how || null,
          /* The module(s) actually missing: timed lyrics needs stable_whisper as
           * well as faster_whisper, and naming the one that imports sent an
           * agent to reinstall it. */
          needsPackage: c.packageReady === false
            ? (c.packageMissing?.length ? c.packageMissing.join(" and ") : c.needsPackage) : null,
          install: c.packageReady === false ? c.packageInstall : null,
          /* WHAT A POLL NEEDS TO SEE. `ready` alone cannot tell "still
           * fetching" from "failed ten seconds ago", and the route already
           * answers both — dropping them here left an agent polling a row that
           * would never turn ready. The failed state is cleared 15 s after the
           * failure (models.js), so an agent that polls slowly sees the row go
           * quiet rather than green: that is what `download_failed` is for. */
          downloading: c.progress && c.progress.state !== "failed"
            ? { received: c.progress.received, total: c.progress.total, file: c.progress.file, state: c.progress.state }
            : null,
          download_failed: c.progress?.state === "failed" ? (c.progress.error || "failed") : null,
        });

        return {
          machine: r.recommended?.machine || r.machine,
          headline: r.recommended?.headline,
          recommended: r.recommended
            ? {
                picks: r.recommended.picks.map((p) => ({
                  slot: p.slot, id: p.id, label: p.label,
                  fit: p.fit?.state, ready: p.ready,
                  gigabytes: Number(((p.bytes || 0) / 1e9).toFixed(1)),
                  licence: p.licence,
                  outputRights: p.outputRights?.class || null,
                  territoryExcluded: p.region?.excluded || null,
                  why: p.why,
                })),
                notes: r.recommended.notes,
                packages: r.recommended.packages.map((k) => ({
                  id: k.id, label: k.label, fit: k.fit?.state,
                  ready: k.packageReady, install: k.install, why: k.why,
                })),
                gigabytesTotal: Number(((r.recommended.totalBytes || 0) / 1e9).toFixed(1)),
                gigabytesToFetch: Number(((r.recommended.missingBytes || 0) / 1e9).toFixed(1)),
                diskFits: r.recommended.diskFits,
                bytesNote: r.recommended.bytesNote,
              }
            : null,
          capabilities: a?.all ? (r.capabilities || []).map(slim) : undefined,
          diskFreeGigabytes: r.disk ? Number((r.disk.freeBytes / 1e9).toFixed(1)) : null,
        };
      },
    },

    {
      name: "cancel_download",
      description:
        "Stop a catalogue download that is running — what the Models page's Cancel button does. The "
        + "part that arrived is KEPT, so starting the same row again resumes from it rather than "
        + "fetching it twice. An id that is not downloading is not an error; the answer says so.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "The capability id whose download should stop." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/models", { action: "cancel", id: String(a.id || "") });
        if (r.error) throw new Error(r.error);
        return { cancelled: String(a.id || ""), note: "The partial file is kept; downloading this row again resumes from it." };
      },
    },

    {
      name: "download_model",
      description:
        "Start a catalogue download — what the Models page's button does: the row's missing files "
        + "into the models folder, each checked on arrival against the byte count the catalogue "
        + "records, and against its sha256 where the catalogue records one ("
        + "a file whose hash does not match is deleted rather than kept). Read the row first with "
        + "models_for_this_machine (ready, gigabytes, licence, territoryExcluded, downloadable). "
        + "A territory-locked row (MiniMax H3 and its derivatives: the turbo LoRAs, the conditioning "
        + "bridges) is REFUSED unless accept_region is true — the same acknowledgement the page asks a "
        + "person for. Pass it ONLY when the person has told you, in this conversation, that they are "
        + "outside the excluded territories; never assume it. Gated rows (a licence to click through on "
        + "the publisher's site) cannot be fetched here, and the YuE2 GGUF kit has its own setup door. "
        + "Returns at once. Poll models_for_this_machine: `downloading` carries received/total bytes "
        + "and the file in flight, `ready` means every file landed, and `download_failed` carries the "
        + "reason — a failed row is NOT ready and never becomes ready, so a poll that only watches "
        + "`ready` waits for ever. cancel_download stops one.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "A capability id from models_for_this_machine, e.g. imageKrea2, videoH3Turbo3, coverSheetSage2." },
          accept_region: { type: "boolean", description: "The person's own acknowledgement of a territory-locked licence. Never assumed." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/models", {
          action: "download", id: String(a.id || ""),
          ...(a.accept_region === true ? { acceptRegion: true } : {}),
        });
        if (r.error) throw new Error(r.error + (r.setup ? ` (setup door: ${r.setup})` : ""));
        return { started: r.started ?? a.id, note: "Poll models_for_this_machine for ready; the Models page shows progress." };
      },
    },
  ];
}
