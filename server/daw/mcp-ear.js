/**
 * THE EAR — the MCP tools: daw_critique, daw_apply_choice, daw_ear_status,
 * daw_taste.
 *
 * Spread into dawTools() (server/mcp-daw.js), so the declared-and-dropped
 * guard, the daw_ family checks and the `by: "agent"` stamp cover these four
 * exactly as they cover the rack's three. Every capability calls the SAME
 * /api/daw/ear route the Ear panel calls — one loop, one reducer path, two
 * hands.
 *
 * ── THE ONE THING AN AGENT CANNOT DO HERE ────────────────────────────────
 * Record a human decision. An MCP call is stamped `agent:<client>` at the API
 * boundary, so `daw_apply_choice` answering a card lands as a **judge** event
 * under the human's delegation — never as a `choice`. The route refuses
 * outright if no delegation exists, and the refusal names the fix. This is
 * SPEC D1.0, and it is not configurable from this file or any other.
 *
 * What an agent SHOULD do with this surface: run daw_critique, read the cards
 * out to the human in their own words, and let the human answer. Auto mode
 * exists for long runs and is honest about being auto.
 */

const HONESTY =
  "Provenance: a card answered from the browser is a `choice` (actor user). A "
  + "card answered through MCP is a `judge` (actor agent:*) under the human's "
  + "`delegate` event. Nothing converts one into the other.";

export function earTools({ ear, earGet, slugOf }) {
  return [
    {
      name: "daw_critique",
      description:
        "THE EAR listens to the mix and hands back question cards. Renders the bar "
        + "range through the same graph the bounce uses, measures it (BS.1770-4 "
        + "integrated LUFS and true peak, 9-band spectral balance against a pink "
        + "reference, per-bar per-band inter-track masking, crest factor, stereo "
        + "correlation/width, DC and clipping — per track AND master), and turns "
        + "every measurement that is off target into a CARD: one concrete "
        + "observation plus 2-4 genuinely different creative routes, each carrying "
        + "the exact MCP call that would make it. Findings that can only name one "
        + "move come back as `notes`, not cards — a one-option card is a "
        + "confirmation dialog. Nothing is applied: this tool only listens. "
        + HONESTY,
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string", description: "Project slug." },
          from_bar: { type: "integer", description: "First bar to listen to. Default 1." },
          to_bar: { type: "integer", description: "Last bar. Default: the last bar." },
          genre: {
            type: "string",
            description: "Tilts the spectral reference curve. neutral (default), pop, "
              + "edm, hiphop, rock, acoustic. The reference is pink noise — equal "
              + "energy per octave — plus a small house tilt; it is a null "
              + "hypothesis, not a rule.",
          },
          max_cards: {
            type: "integer",
            description: "Cards per pass, default 5, hard max 12. Capped on purpose: a "
              + "wall of cards produces rubber-stamping, which is worthless.",
          },
          roles: {
            type: "object",
            description: "Optional track_id -> role (lead, vocal, drums, bass, guitar, "
              + "keys, pad, fx). Roles are otherwise INFERRED from track names and "
              + "ride at lower confidence; a track with no role gets measured but "
              + "never judged on level, because inventing its target would be a guess.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await ear({
          action: "critique", slug: slugOf(a.slug),
          from_bar: a.from_bar, to_bar: a.to_bar, genre: a.genre,
          max_cards: a.max_cards, roles: a.roles,
        });
        return {
          run: r.run, from_bar: r.from_bar, to_bar: r.to_bar, genre: r.genre,
          master: r.measure.master,
          stereo: r.measure.stereo,
          spectral: r.measure.spectral.bands,
          tracks: r.measure.tracks,
          objective_score: r.score,
          cards: r.cards.map((c) => ({
            id: c.id, metric: c.metric, severity: c.severity,
            confidence: c.confidence, observation: c.observation,
            where: c.where, how_much: c.how_much,
            rank_reason: c.rank_reason, auto_allowed: c.auto_allowed,
            routes: c.routes.map((x) => ({ id: x.id, text: x.text, why: x.why,
                                           mcp_call: x.op })),
            free_text: c.free_text, skip: c.skip,
          })),
          notes: r.notes,
          over_cap: r.over_cap,
          stems: r.stems, master_source: r.master_source,
          audio_clips_excluded: r.audio_clips_excluded,
          taste: r.taste,
          ms: r.ms,
        };
      },
    },

    {
      name: "daw_apply_choice",
      description:
        "Answer a card from daw_critique, and APPLY the route's edit. The route's "
        + "`mcp_call` is executed as the real tool (daw_insert / daw_mixer), the bar "
        + "range is re-measured, and an A/B GUARD reverts the edit if the objective "
        + "penalty got worse — a change that measurably hurts is undone and reported, "
        + "never kept quietly.\n"
        + "ops: `answer` picks a route (or writes free_text); `reject` refuses every "
        + "route; `skip` declines to decide and is logged as NOTHING; `auto` lets the "
        + "Ear answer its own cards for up to 3 iterations under the human's `brief`; "
        + "`review` ratifies or overrides one auto decision (this is what turns a "
        + "delegated decision into a real informed selection); `review_keep_all` "
        + "ratifies the rest in one action and is recorded AS BULK; `bulk_accept` "
        + "does the same for un-answered cards; `approve` records the human's final "
        + "approval after listening. " + HONESTY,
      inputSchema: {
        type: "object",
        required: ["op", "slug"],
        properties: {
          op: {
            type: "string",
            enum: ["answer", "reject", "skip", "auto", "review", "review_cards",
                   "review_keep_all", "bulk_accept", "approve", "state"],
          },
          slug: { type: "string" },
          run: { type: "string", description: "The run id from daw_critique (all ops but auto)." },
          card: { type: "string", description: "The card id (answer/reject/skip/review)." },
          choice: { type: "string", description: "The route id to take (answer), or the "
            + "replacement route id on an override (review)." },
          free_text: { type: "string", description: "Your own direction, in your own words, "
            + "recorded VERBATIM. Ranks above any menu pick in the dossier. Always allowed, "
            + "never penalised, and it may replace `choice` entirely." },
          reasoning: { type: "string", description: "Why — recorded verbatim, optional." },
          decide_ms: { type: "integer", description: "Wall-clock from card shown to decision. "
            + "Recorded as texture; never scored or gated on." },
          verdict: { type: "string", enum: ["keep", "override"],
                     description: "op review: keep ratifies the Ear's choice having seen the "
                       + "alternatives; override changes it." },
          brief: { type: "string", description: "op auto: the human's goals in THEIR words. "
            + "Required — every auto decision is recorded as delegated by this brief." },
          iterations: { type: "integer", description: "op auto: max iterations, hard cap 3." },
          from_bar: { type: "integer", description: "op auto: first bar (default 1)." },
          to_bar: { type: "integer", description: "op auto: last bar." },
          genre: { type: "string", description: "op auto: reference-curve tilt." },
          listened_seconds: { type: "integer",
            description: "op approve: how long the human actually listened." },
          subject_hash: { type: "string", description: "op approve: hash of the approved render." },
          note: { type: "string", description: "op approve: a note, verbatim." },
          cards: { type: "array", items: { type: "string" },
                   description: "op bulk_accept: which cards (default: all un-answered)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = slugOf(a.slug);
        const common = {
          slug, run: a.run, card: a.card, choice: a.choice,
          free_text: a.free_text, reasoning: a.reasoning, decide_ms: a.decide_ms,
        };
        if (a.op === "skip") return ear({ action: "answer", ...common, choice: "skip" });
        if (a.op === "answer") return ear({ action: "answer", ...common });
        if (a.op === "reject") return ear({ action: "reject", ...common });
        if (a.op === "auto") {
          return ear({ action: "auto", slug, brief: a.brief, iterations: a.iterations,
                       from_bar: a.from_bar, to_bar: a.to_bar, genre: a.genre });
        }
        if (a.op === "review_cards") return ear({ action: "review_cards", slug, run: a.run });
        if (a.op === "review") {
          return ear({ action: "review", ...common, verdict: a.verdict });
        }
        if (a.op === "review_keep_all") {
          return ear({ action: "review_keep_all", slug, run: a.run });
        }
        if (a.op === "bulk_accept") {
          return ear({ action: "bulk_accept", slug, run: a.run, cards: a.cards });
        }
        if (a.op === "approve") {
          return ear({ action: "approve", slug, run: a.run,
                       listened_seconds: a.listened_seconds,
                       subject_hash: a.subject_hash, note: a.note });
        }
        if (a.op === "state") return ear({ action: "state", slug, run: a.run });
        throw new Error(`Unknown op "${a.op}".`);
      },
    },

    {
      name: "daw_ear_status",
      description:
        "What the Ear can and cannot do on THIS machine. Lists every objective critic "
        + "and what it measures; reports whether the two band tables (python and JS) "
        + "still agree; and gives the SUBJECTIVE stage's availability verdict — which "
        + "aesthetic judges are installed, their licences, the exact install line, and "
        + "the VRAM guard's policy. When no judge is installed it says so and says what "
        + "the loop degrades to; it never invents a score. Also carries the taste "
        + "profile summary and the loop's constants (card cap, iteration cap, A/B "
        + "epsilon).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        return earGet("/api/daw/ear/status");
      },
    },

    {
      name: "daw_taste",
      description:
        "The taste profile — what the Ear has learned from the human's own accept / "
        + "reject / override decisions, per (metric, genre). Beta(5,5) prior, so it "
        + "stays neutral until about ten decisions. It biases card ORDER and whether a "
        + "class may be auto-applied; it never invents a finding and never hides a "
        + "measurement — a metric rejected three times is still measured and still "
        + "shown, it simply stops being applied on its own. Stored as local JSON, "
        + "derived from the provenance ledger, never transmitted. op `read` returns "
        + "it, op `reset` returns it to neutral (which changes nothing in the ledger).",
      inputSchema: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["read", "reset"] },
          slug: { type: "string", description: "op reset: any project slug (the profile "
            + "itself is project-independent; the route needs a scope)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.op === "read") return earGet("/api/daw/ear/taste");
        if (a.op === "reset") return ear({ action: "taste_reset", slug: a.slug });
        throw new Error(`Unknown op "${a.op}" — read or reset.`);
      },
    },
  ];
}
