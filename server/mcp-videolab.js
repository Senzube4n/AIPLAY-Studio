/**
 * Video lab — the MCP tools.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { videoLabTools } from "./mcp-videolab.js";                 │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...videoLabTools(api),                                             │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Every tool here posts the SAME /api/videolab actions web/videolab.js posts,
 * through the same api() transport the rest of the MCP layer uses. One
 * implementation, two surfaces; server/videolab/ui_test.js fails the commit if
 * either side grows something the other cannot reach.
 *
 * WHAT THE DESCRIPTIONS ARE FOR. An agent cannot see the clip, cannot see the
 * face it is trying to make readable, and cannot re-run a sweep to find out
 * what a size costs. So every description below carries the measured
 * consequence of the choice it offers, with the document it came from named in
 * the text — the same sentences the human sees beside the same control. A tool
 * description that says "sets the sigma shift" has told the agent nothing it
 * could act on; one that says where the render then commits has.
 *
 * The measurements: docs/RESOLUTION_FOR_FACES.md (six H3 renders, one prompt,
 * one seed, one reference, 56 frames, only the size varied) and
 * docs/H3_REFERENCE_BLEED.md (why a reference occupies the opening frames of a
 * 4-step clip, traced from ComfyUI's own source). Read either before arguing
 * with a number in here.
 */

import { excludedTerritoriesText } from "./models.js";
import { COMPARE_CONFIGS } from "./videolab/catalog.js";
const H3_EXCLUDED = excludedTerritoriesText();

export function videoLabTools(api) {
  const lab = async (body) => {
    const r = await api("POST", "/api/videolab", body);
    if (r.error) throw new Error(r.error);
    return r;
  };

  return [
    {
      name: "video_compare",
      description:
        "Render the SAME prompt, seed and references through several engine configurations, so "
        + "the difference on screen is the configuration and nothing else. Starts the run and "
        + "returns immediately with a group id — the arms are minutes each — then poll "
        + "video_comparison for wall times and clip names.\n\n"
        + "THE CONFIGURATIONS (pass any subset in `configs`; default is all of them):\n"
        + COMPARE_CONFIGS.filter(c => c.engine === "h3").map(c => `  • ${c.id} — ${c.why}\n`).join("")
        + "  • ltx — LTX 2.5, a different tool rather than a faster H3: 8 steps at half "
        + "resolution, a latent x2 upscale, 3 steps at full size. ~121 s for 5 s. ⚠ NO reference "
        + "input exists on LTX at all, so references are dropped for this arm and the result says "
        + "so.\n"
        + "  • hybrid — the fork's routing rule, not a third model: H3 when the shot carries "
        + "references, LTX otherwise. The result records which engine it became and why.\n\n"
        + "Arms run one at a time and in engine order (switching reloads ~20 GB), each is awaited, "
        + "and a FAILED arm is recorded rather than discarded — 'H3 at 1920x1088 is out of memory' "
        + "is a comparison result. Every clip lands in the normal clip library tagged with the "
        + "group, so list_clips shows them and the group survives a restart.\n\n"
        + "⚠ LICENCE, and a comparison is where it bites: three of the five arms are MiniMax H3, "
        + "whose licence grants NO rights in " + H3_EXCLUDED + ". Where that applies, run "
        + "`configs: [\"ltx\"]` — or check each arm's `licence` field, which video_compare with "
        + "`dry_run` returns before anything is spent.\n\n"
        + "⚠ ONE SEED ACROSS EVERY ARM, rolled and recorded if you do not pass one. Seed spread "
        + "on this model is larger than several of the effects people try to read off a single "
        + "pair of clips — a shift finding has already been retracted for exactly that — so a "
        + "comparison run on different seeds is not a comparison. To judge a setting properly, "
        + "run the whole comparison twice with two seeds.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "What happens in the shot. The same text goes to every arm. Describe motion, not just a subject." },
          configs: {
            type: "array", items: { type: "string" },
            description: "Which arms to run: h3_quality, h3_turbo4, h3_turbo8, ltx, hybrid. Default: all five.",
          },
          seed: { type: "integer", description: "Held across every arm. Rolled and recorded when omitted." },
          seconds: { type: "integer", description: "Clip length for every arm. Keep it short for a comparison: inside the measured range length costs little next to size (a 2.7x band), and above roughly 331k latent tokens it stops being cheap at all - 30% more frames for 2.6x in an outside replication, which is past anything rendered here." },
          width: { type: "integer", description: "Pin a size for every arm. Omit and each arm renders at ITS engine's native size, which is usually what you want — asking LTX for H3's 1344x768 silently gets you 1280x704 after its halve-then-floor." },
          height: { type: "integer", description: "Pinned with width, or omitted with it. Both arms of a comparison must be the same size or the comparison has two variables in it." },
          ref_images: { type: "array", items: { type: "string" }, maxItems: 9, description: "Image names the prompt calls as <Picture 1>… H3 arms use them; the LTX arm cannot and says so on its result." },
          /* AUDIO REFERENCES ROUTE THE HYBRID ARM, which is why this is not an
           * optional nicety. resolveHybrid() counts images AND audio, so a
           * single audio reference is the difference between the hybrid arm
           * rendering on H3 and on LTX — a different engine, a different
           * licence line and roughly ten times the cost. The Video panel has
           * always sent these; the tool could not, so the same request meant
           * two different renders depending on which hand made it. Caught by
           * the parameter census in server/videolab/ui_test.js. */
          ref_audios: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "A staged audio name." },
                start: { type: "number", description: "Seconds into the file to read from. Default 0." },
              },
              required: ["name"],
              additionalProperties: false,
            },
            maxItems: 4,
            description: "Audio the prompt calls as <Audio 1>… H3 arms only. ⚠ These ROUTE the hybrid arm: any reference at all sends `hybrid` to H3, so attaching one changes which engine that arm compares. Use dry_run first to see where it lands.",
          },
          first_frame: { type: "string", description: "An image name every arm opens on." },
          negative: { type: "string", description: "LTX arms only — H3 has no negative prompt." },
          timeout_seconds: { type: "integer", description: "Per arm. Default 3600, which is above the slowest measured render." },
          dry_run: { type: "boolean", description: "Spend nothing: return the arms this would run — engine, size, step count, where each commits, and what `hybrid` resolves to and why — so the cost is visible before the GPU is committed. Worth doing whenever references are attached, because hybrid routes on them." },
        },
        additionalProperties: false,
      },
      async run(a) {
        /* THE PLAN BEFORE THE BILL. `hybrid` once quietly meant "everything on
         * the ten-times-more-expensive engine" for most of an evening, because
         * nothing reported which engine a clip chose until after it had run.
         * This is that report, moved to before the render. */
        if (a.dry_run) {
          const s = await lab({ action: "state" });
          const hy = await lab({
            action: "resolve_hybrid",
            refImages: Array.isArray(a.ref_images) ? a.ref_images : [],
            // Counted by resolveHybrid exactly like the images — omitting them
            // here made the dry run confidently predict the wrong engine.
            refAudios: Array.isArray(a.ref_audios) ? a.ref_audios : [],
          });
          const want = Array.isArray(a.configs) && a.configs.length ? a.configs : s.configs.map((c) => c.id);
          return {
            dry_run: true,
            hybrid_would_use: hy.engine, hybrid_because: hy.reason,
            arms: s.configs.filter((c) => want.includes(c.id)).map((c) => ({
              config: c.id, label: c.label,
              engine: c.declaredEngine === "hybrid" ? hy.engine : c.engine,
              size: `${c.width}x${c.height}`, steps: c.steps,
              commit_sigma: c.commitSigma,
              licence: c.licence,
              why_this_arm: c.why,
            })),
          };
        }
        const r = await lab({
          action: "compare",
          prompt: a.prompt,
          configs: a.configs,
          seed: Number.isFinite(a.seed) ? a.seed : undefined,
          seconds: Number.isFinite(a.seconds) ? a.seconds : undefined,
          width: Number.isFinite(a.width) ? a.width : undefined,
          height: Number.isFinite(a.height) ? a.height : undefined,
          refImages: Array.isArray(a.ref_images) && a.ref_images.length ? a.ref_images : undefined,
          refAudios: Array.isArray(a.ref_audios) && a.ref_audios.length ? a.ref_audios : undefined,
          fromCover: a.first_frame || undefined,
          negative: a.negative || undefined,
          timeoutSeconds: Number.isFinite(a.timeout_seconds) ? a.timeout_seconds : undefined,
        });
        return {
          group: r.group.id,
          seed: r.group.seed,
          arms: r.group.arms.map((x) => ({ config: x.id, label: x.label, engine: x.engine, size: x.sizeLabel, status: x.status })),
          note: "Started. Poll video_comparison with this group id — each arm takes minutes.",
        };
      },
    },

    {
      name: "video_comparison",
      description:
        "Read a comparison back: every arm with its wall time, its clip filename, the size and "
        + "step count it used, and where its schedule committed. With no id, lists recent "
        + "comparisons newest first.\n\n"
        + "`running: true` means arms are still rendering; the finished ones are already filled "
        + "in, so this is safe to poll. `wall_seconds` is measured render time, not an estimate. "
        + "A failed arm carries its error and is still part of the result.\n\n"
        + "The clips are ordinary library clips — list_clips shows them, and each carries the "
        + "group in its metadata, so a comparison stays a group in the place people actually look "
        + "at clips rather than only in this tool.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "A group id from video_compare. Omit to list recent ones." },
          limit: { type: "integer", description: "When listing. Default 12." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (!a.group) {
          const r = await lab({ action: "groups", limit: a.limit });
          return (r.groups || []).map((g) => ({
            group: g.id, at: new Date(g.at).toISOString(), prompt: g.prompt, seed: g.seed,
            running: !!g.running,
            arms: g.arms.length,
            done: g.arms.filter((x) => x.status === "done").length,
            /* WHICH COMPARISONS WERE ACTUALLY CONCLUDED. Without this the list
             * cannot tell a question that was answered from one that was only
             * paid for, which is the difference that decides whether to run the
             * comparison again. */
            verdict: g.verdict ? `${g.verdict.armId || "none of them"} — ${g.verdict.by}` : null,
          }));
        }
        const { group } = await lab({ action: "group", id: a.group });
        return {
          group: group.id, prompt: group.prompt, seed: group.seed, running: !!group.running,
          /* The judgement, beside the wall times it was made against. Written by
           * whichever hand reached the conclusion — video_verdict from here, the
           * Video panel from a person — and `by` says which, because an agent's
           * reading of the numbers and a person's look at the picture are not
           * the same claim. */
          verdict: group.verdict
            ? {
              arm: group.verdict.armId, note: group.verdict.note, by: group.verdict.by,
              at: new Date(group.verdict.at).toISOString(),
            }
            : null,
          still_frames: group.frames || null,
          arms: group.arms.map((x) => ({
            config: x.id, label: x.label,
            engine: x.engine,
            routed_because: x.routing || undefined,
            size: `${x.width}x${x.height}`, steps: x.steps,
            commit_sigma: x.commitSigma,
            status: x.status,
            wall_seconds: x.wallSeconds,
            clip: x.clip,
            note: x.note || undefined,
            error: x.error || undefined,
            why_this_arm: x.why,
          })),
        };
      },
    },

    {
      name: "video_stills",
      description:
        "The SAME numbered frames out of every arm of a comparison, at full resolution. This is "
        + "the tool that lets a comparison be LOOKED AT rather than read off a table of wall "
        + "times — and the one an agent needs, because a clip is not something you can inspect "
        + "and a still is.\n\n"
        + "WHY FRAME NUMBERS AND NOT TIMES. Arms differ in length (the LTX arm of this app's own "
        + "proof group is 49 frames against H3's 56), so 'half way through' is a different "
        + "moment in each one and a strip built that way compares two variables. The frames are "
        + "the same integers for every arm and are CLAMPED TO THE SHORTEST — never per arm, "
        + "which would put different moments under one heading. When the clamp fires the result "
        + "says so and names the short arm.\n\n"
        + "THE DEFAULT SET is 0, 15, 60, and each is chosen: 0 because that is where a reference "
        + "bleeds into a turbo clip (docs/H3_REFERENCE_BLEED.md), 15 because the motion has "
        + "committed by then, and 60 because it usually overshoots — so the clamp fires and you "
        + "are shown the shortest arm's last frame, which is where a frozen tail hides.\n\n"
        + "Each still comes back as a URL under the clip library plus the size the file REALLY "
        + "holds, beside the size the arm asked for. Those agree on everything measured so far; "
        + "if they ever stop agreeing, the file is the one telling the truth.\n\n"
        + "The frame numbers are written onto the group, so a person who moves the strip and an "
        + "agent that reads it afterwards are looking at the same three columns.",
      inputSchema: {
        type: "object",
        required: ["group"],
        properties: {
          group: { type: "string", description: "A group id from video_compare or video_comparison." },
          frames: {
            type: "array", items: { type: "integer" }, maxItems: 8,
            description: "Frame numbers, the same for every arm. Omit to reuse this group's last "
              + "choice, or the measured default if it has none. Clamped to the shortest arm.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await lab({
          action: "stills",
          id: a.group,
          frames: Array.isArray(a.frames) && a.frames.length ? a.frames : undefined,
        });
        return {
          group: r.id,
          frames: r.frames,
          requested: r.requested,
          clamped: r.clamped || undefined,
          shortest_arm: r.shortest || undefined,
          arms: (r.rows || []).map((row) => ({
            config: row.armId, label: row.label, engine: row.engine,
            clip: row.clip,
            asked_for: row.askedWidth ? `${row.askedWidth}x${row.askedHeight}` : null,
            delivered: row.width ? `${row.width}x${row.height}` : null,
            source_frames: row.sourceFrames, fps: row.fps, duration_sec: row.durationSec,
            stills: row.stills.map((s) => ({ frame: s.frame, at_sec: s.atSec, url: s.url, width: s.w, height: s.h })),
            missing: row.missing?.length ? row.missing : undefined,
            error: row.error || undefined,
          })),
        };
      },
    },

    {
      name: "video_verdict",
      description:
        "Write the CONCLUSION of a comparison onto the group, so several full renders leave "
        + "behind a decision instead of only a table of wall times. Read it back with "
        + "video_comparison; the Video panel shows the same field beside the same arms.\n\n"
        + "⚠ WHOSE CALL IT IS TRAVELS WITH IT. A verdict written through this tool is recorded "
        + "as an AGENT's — that spelling is not yours to choose, and `as` only adds your name "
        + "beside it. An agent has not seen the clips: what it can honestly file is a reading of "
        + "the numbers (this arm cost a quarter as much for the same measured face) and never "
        + "'this one looks better'. A person's verdict written at the panel says person, and the "
        + "two must not read alike.\n\n"
        + "Send an empty note with no arm to clear a verdict.",
      inputSchema: {
        type: "object",
        required: ["group"],
        properties: {
          group: { type: "string", description: "A group id from video_compare." },
          arm: { type: "string", description: "The config id of the arm that won — h3_quality, ltx and so on. Omit for a verdict that picks none of them." },
          note: { type: "string", description: "Why. One sentence a person reading this in a month can act on. Empty, with no arm, clears the verdict." },
          as: { type: "string", description: "Your name, added beside 'agent'. It cannot replace it." },
        },
        additionalProperties: false,
      },
      async run(a) {
        /* ACTOR HONESTY AT THIS SEAM. The spelling is built here and the caller
         * cannot reach it — the same rule the DAW's critique loop holds, where
         * `judge` refuses a user actor and `choice` refuses an agent one. An
         * agent's reading of the numbers filed as somebody's judgement of the
         * picture would be the most expensive kind of wrong on this surface:
         * the next comparison would not be run. */
        const r = await lab({
          action: "verdict",
          id: a.group,
          armId: a.arm || "",
          note: a.note ?? "",
          /* `as` cannot smuggle the OTHER hand's word in. Caught proving this:
           * `as: "person"` produced "agent · person", which starts with the
           * honest word and still gives somebody skimming a verdict list the
           * wrong impression in one glance. The prefix is not the caller's to
           * choose and neither is the confusion. */
          by: `agent${a.as ? ` · ${String(a.as).replace(/person/gi, "").slice(0, 40).trim()}` : ""}`.trim().replace(/·$/, "").trim(),
        });
        return {
          group: r.group.id,
          verdict: r.verdict
            ? { arm: r.verdict.armId, note: r.verdict.note, by: r.verdict.by, at: new Date(r.verdict.at).toISOString() }
            : null,
          note: r.verdict ? "Recorded on the group. The Video panel shows it beside the arms." : "Verdict cleared.",
        };
      },
    },

    {
      name: "video_quality",
      description:
        "The render size, and what each one measurably costs and buys. Call with no arguments to "
        + "READ the annotated list; pass width and height to SET it (the same value the Video "
        + "page's size selector writes, and the default every render falls back to).\n\n"
        + "WHAT THE MEASUREMENTS SAY, so you can choose without re-running the sweep — H3, six "
        + "renders, one prompt, one seed, 56 frames, only the size varied:\n"
        + "  • 1344x768 native — 58 px face. Eyelid crease, lash line and nostril are absent and "
        + "the mouth is a smear. 275.6 s.\n"
        + "  • 1792x1008 — THE KNEE, and it is not in config.js's own list. 84 px face, the first "
        + "size where 1-2 px features survive. 591.2 s. 1.75x the model's declared canvas, so it "
        + "renders cleanly but is untrained territory.\n"
        + "  • 1920x1088 — identical face and mouth figures to the knee for 22% more wall clock. "
        + "It buys nothing.\n"
        + "  • 1536x864 — cost 36% MORE than native and produced the SMALLEST face on the ladder "
        + "(50 px), because the model chose to frame the subject further away. More pixels, "
        + "smaller face.\n\n"
        + "⚠ THE THREE RULES THAT MATTER MORE THAN THE LIST:\n"
        + "  1. FRAMING IS THE LEVER. Set the bar at a lip-syncable mouth (~96 px of face) and no "
        + "size on the ladder reaches it. Reframe the shot chest-up in the PROMPT and 1792x1008 "
        + "clears it with margin; stay knees-up and no render size rescues it.\n"
        + "  2. UPSCALING INVENTS DETAIL, IT DOES NOT RECOVER IT. There is nothing to read a lash "
        + "line off, so an upscaler draws a plausible one. Render native or above.\n"
        + "  3. LENGTH IS CHEAP UNTIL IT ISN'T. Inside the range this rig has measured, size is the "
        + "bill and the ladder alone is 2.7x. Above roughly 331k latent tokens that stops holding: "
        + "an outside replication over 158 renders measured 30% more frames costing 2.6x, with hard "
        + "out-of-memory failures. The largest render behind these numbers is 149k tokens; 1792x1008 "
        + "at 209 frames is 437k, well past it. Cut to the music inside the measured range, and "
        + "treat a long clip at a large size as unmeasured rather than cheap.\n\n"
        + "Sizes are per engine and not interchangeable: H3's native 1344x768 is not a legal LTX "
        + "size. Setting one records it for that engine only.",
      inputSchema: {
        type: "object",
        properties: {
          engine: { type: "string", enum: ["h3", "ltx"], description: "Whose sizes. Default: the engine currently selected." },
          width: { type: "integer", description: "256-3840. Pass with height to set." },
          height: { type: "integer", description: "256-3840. Sizes are per engine and not interchangeable — H3's native 1344x768 is not a legal LTX size." },
          steps: { type: "integer", description: "H3 only, 2-40. Remember this picks the MODEL, not a quality level: 4 loads the 4-step distillation, 8 the 8-step one, 20 loads no LoRA at all." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (Number.isFinite(a.width) && Number.isFinite(a.height)) {
          const r = await lab({ action: "set_quality", engine: a.engine, width: a.width, height: a.height, steps: a.steps });
          const q = r.state.quality;
          return { engine: r.state.engine, width: q.width, height: q.height, steps: q.steps, commit: r.state.commit?.note };
        }
        const s = await lab({ action: "state", engine: a.engine });
        return {
          engine: s.engine,
          selected: { width: s.quality.width, height: s.quality.height, steps: s.quality.steps },
          commit: s.commit?.note,
          rules: s.quality.rules.map((r) => `${r.headline} ${r.body}`),
          sizes: s.quality.sizes.map((z) => ({
            size: z.id,
            territory: z.native ? "native" : z.aboveNative ? "above native" : "below native",
            percent_of_native: z.ofNative,
            delivered: `${z.deliveredW}x${z.deliveredH}`,
            measured: z.measured ? z.note : null,
            warning: z.gridWarning || undefined,
            not_in_config: z.added || undefined,
          })),
          measured_in: s.docs.faces,
        };
      },
    },

    {
      name: "video_settings",
      description:
        "Every switchable part of the render, with what each one does TO THE PICTURE. Call with "
        + "no arguments to read them; pass id and value to change one.\n\n"
        + "The list is DATA on the server, not a fixed schema here — new workflows arrive weekly "
        + "and a new toggle is a row rather than a rebuild — so read it before setting anything "
        + "and trust what it returns over anything memorised. Each row carries its own effect "
        + "sentence, its range, and the document the claim came from.\n\n"
        + "THE THREE WORTH KNOWING BEFORE YOU TOUCH ANYTHING:\n"
        + "  • turbo_lora — there is NO on/off for the distillation; the STEP COUNT picks the "
        + "model, and this sets the threshold it is compared against. Off means the bare model "
        + "runs at every step count. The LoRA at 20 steps over-shoots into crunchy texture and "
        + "2-3x the inter-frame churn, which is the long-standing 'jittery' report.\n"
        + "  • turbo_shift_video — the one that fixes reference bleed, and it costs nothing. At 4 "
        + "steps with the default shift 12 the clip you get is the model's guess at sigma 0.800: "
        + "80% of the picture invented in one jump, with your reference the only clean image in "
        + "view, so it leans on it — measured, the first frames come back as the reference almost "
        + "verbatim. Set 3 and 4 steps commits at 0.500 instead. Applies only when a turbo LoRA is "
        + "loaded, so the 20-step path keeps the measured 12. Pair with turbo_shift_audio 0.75 to "
        + "keep the 4:1 ratio.\n"
        + "  • lora_strength — worth a 1.0-vs-0.0 A/B before trusting any other turbo setting: the "
        + "LoRA is merged into an int8 checkpoint, and on a quantised base a low-rank delta can be "
        + "rounded away. If the two look alike, the LoRA is barely doing anything.\n\n"
        + "Changes persist and apply to the next render, from either surface. Values are checked "
        + "against the row's own range and REFUSED rather than clamped, so what you asked for is "
        + "what happened.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Which setting. Read the list first — ids are server-side data." },
          value: { description: "Boolean, number, or string, matching the row's `kind`." },
          engine: { type: "string", enum: ["h3", "ltx"], description: "Filter the listing to one engine's settings." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.id !== undefined) {
          if (a.value === undefined) throw new Error(`Pass a value for "${a.id}". Call video_settings with no arguments to see its kind and range.`);
          const r = await lab({ action: "set_knob", id: a.id, value: a.value, engine: a.engine });
          return { id: r.id, value: r.value, commit: r.state.commit?.note };
        }
        const s = await lab({ action: "state", engine: a.engine });
        return {
          engine: s.engine,
          commit: s.commit?.note,
          settings: (a.engine ? s.knobs : s.allKnobs).map((k) => ({
            id: k.id, label: k.label, engine: k.applies, kind: k.kind,
            value: k.value,
            range: k.kind === "number" ? `${k.min} to ${k.max}` : k.options ? k.options.join(" | ") : undefined,
            unset_at: k.unsetAt,
            effect: k.effect,
            measured_in: k.cite,
          })),
        };
      },
    },
  ];
}
