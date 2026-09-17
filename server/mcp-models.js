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
 * ⚠ READ ONLY, AND THAT ASYMMETRY IS DELIBERATE. There is no download tool
 * here, so this is a capability a person has that an agent does not — the
 * opposite of the usual gap and the one the parity rule normally forbids. The
 * reason is that two of these downloads cannot be started without ACCEPTING
 * SOMETHING. MiniMax H3 is licensed only outside four territories and the
 * downloader refuses without an explicit acknowledgement; LTX 2.5 needs its
 * licence accepted on the publisher's own page. An acknowledgement that an
 * agent can click on your behalf is not an acknowledgement. So the agent may
 * read the whole picture and tell you exactly which button to press, and the
 * pressing stays yours.
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
      name: "models_for_this_machine",
      description:
        "WHICH MODELS THIS COMPUTER CAN ACTUALLY RUN, and which to download first — the same answer "
        + "the Models screen shows its owner, computed from nvidia-smi and os.totalmem against the "
        + "requirements each publisher states.\n\n"
        + "Read this BEFORE recommending any model, any engine or any download. The catalogue holds "
        + "seventeen capabilities ranging from a 22 MB frame interpolator to a 43 GB video engine, and "
        + "the difference between them is entirely the machine you are standing on.\n\n"
        + "EVERY CAPABILITY CARRIES A `fit`, one of four:\n"
        + "  • fits      at or above the recommended VRAM and RAM.\n"
        + "  • streams   above the minimum, under the recommendation. It RUNS — Studio's low-VRAM "
        + "tiers stream weights from system RAM — and it is slower. Not a refusal.\n"
        + "  • wont-run  below the publisher's stated floor.\n"
        + "  • unknown   no NVIDIA card could be read (nvidia-smi is NVIDIA-only, so every Apple, AMD "
        + "and Intel machine lands here). This is NOT 'no'. Do not turn it into one.\n\n"
        + "`recommended` names one pick per slot with a reason: the required music engine, ONE video "
        + "engine, ONE image model, and the fit of the pip-installed extras. The video pick is always "
        + "one Studio can actually download — LTX 2.5 is faster and better and its repository is "
        + "access-gated, so it is reported under `notes` with the publisher's hand-fetch steps and is "
        + "never recommended. The image pick is chosen by LICENCE among those that fit, not by quality: "
        + "FLUX.2 klein and Z-Image are Apache-2.0, Ideogram 4's agreement is behind a login and unread.\n\n"
        + "⚠ Downloads are not available to you, on purpose. MiniMax H3's licence grants no rights "
        + `inside ${H3_TERRITORIES}, and its download refuses without an `
        + "explicit acknowledgement from the person whose machine it is. Name the model and the button; "
        + "let them press it.",
      inputSchema: {
        type: "object",
        properties: {
          /* The full seventeen is a lot of tokens for the common question,
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
          needsPackage: c.packageReady === false ? c.needsPackage : null,
          install: c.packageReady === false ? c.packageInstall : null,
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
      name: "download_model",
      description:
        "Start a catalogue download — what the Models page's button does: the row's missing files, "
        + "verified by size and hash on arrival, into the models folder. Read the row first with "
        + "models_for_this_machine (ready, gigabytes, licence, territoryExcluded, downloadable). "
        + "A territory-locked row (MiniMax H3 and its derivatives: the turbo LoRAs, the conditioning "
        + "bridges) is REFUSED unless accept_region is true — the same acknowledgement the page asks a "
        + "person for. Pass it ONLY when the person has told you, in this conversation, that they are "
        + "outside the excluded territories; never assume it. Gated rows (a licence to click through on "
        + "the publisher's site) cannot be fetched here, and the YuE2 GGUF kit has its own setup door. "
        + "Returns at once; poll models_for_this_machine until the row reads ready.",
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
