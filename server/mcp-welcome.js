/**
 * studio_capabilities and friends — the welcome window, for an agent.
 *
 * "MCP controllable so an agent can tab into it."
 *
 * These tools post the SAME /api/welcome actions web/welcome.js posts, and get
 * back the SAME document the window renders. Not a summary of it, not a
 * hand-written description of the app that happens to sit next to it — the
 * bytes. Ask an assistant "what can this studio do" and it reads the sentences
 * the person beside it is reading.
 *
 * WHY THIS IS NOT pipeline_guide. That tool is the map of the TOOL SURFACE —
 * which of a hundred-odd tools to reach for at each stage of making a music
 * video, written for a model with a job to do. This one is the map of the
 * PRODUCT: what the screens are, what each can and cannot make, the licences
 * that bite, what the size choice costs, and what this machine has actually
 * produced. An agent introducing the studio to its user needs the second; an
 * agent already making something needs the first. Both exist because they
 * answer different questions, and neither restates the other.
 *
 * TWO DEPTHS, ONE DOCUMENT. `studio_capabilities` is the tour — every screen,
 * one paragraph each, read once at the start of a conversation.
 * `studio_screen_info` is the ⓘ in the corner of a single page, and it carries
 * the one thing a tour cannot: what THIS machine has and has not got for THAT
 * screen, joined from the same /api/models the Models screen reads. An agent
 * about to render on a page it has not used should call the second one first,
 * which is what its description says in the first line.
 *
 * THE STATE-CHANGING PAIR is here for the parity rule, not for convenience:
 * `dismiss` and `reopen` are the two halves of one switch, and a switch an
 * agent can flip one way and not the other is how a render ends up unstoppable
 * from the screen. Both directions, both surfaces, or neither.
 */

export function welcomeTools(api) {
  const post = async (body) => {
    const r = await api("POST", "/api/welcome", body);
    if (r.error) throw new Error(r.error);
    return r;
  };

  return [
    {
      name: "studio_capabilities",
      description:
        "WHAT THIS STUDIO IS AND WHAT IT CAN MAKE — the exact document the app's welcome window "
        + "shows a new person, returned verbatim. Every screen with one paragraph on what it makes "
        + "and one on what it honestly cannot; where to start; the two model licences that actually "
        + "bite (a revenue ceiling and a territory exclusion), quoted and linked; and what choosing "
        + "a video size costs, measured on this machine. Call this when your user asks what the "
        + "studio can do, what a tab is for, whether they may sell what they made, or what size to "
        + "render at. For WHICH TOOL TO CALL at each stage of a job, read `pipeline_guide` instead — "
        + "that maps this tool surface; this one maps the product.",
      inputSchema: {
        type: "object",
        properties: {
          showcase: {
            type: "boolean",
            description:
              "Include real examples this machine has already made, with the prompt or caption that "
              + "produced each. Default true. Set false to skip the disk read and get only the prose.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await post({ action: "catalogue", showcase: a.showcase !== false });
        return {
          /* Whether the human has been shown around yet. An agent that knows
           * this can offer the tour instead of explaining the app twice. */
          welcome_seen: !r.firstRun,
          catalogue_version: r.version,
          ...r.catalogue,
        };
      },
    },

    {
      name: "studio_screen_info",
      description:
        "READ THIS BEFORE YOU DRIVE A SCREEN. One page of the studio, in the depth somebody standing "
        + "on it needs: the paragraph that explains it, the honest limit on what it cannot do, the "
        + "first move to make on it, where to open it — and, the part no static document can carry, "
        + "WHAT IT NEEDS ON THIS MACHINE. Every model the page uses, with its licence, its download "
        + "size, whether the files are already on disk, and whether this card can run it; every Python "
        + "package it needs, with the exact pip command, because Studio can fetch weights and cannot "
        + "fetch a pip install. A page that needs nothing beyond the app says so in as many words. "
        + "Call it before you generate on a page you have not used this session. It is one request, "
        + "and it is the difference between 'render failed' twenty minutes in and 'the video engine is "
        + "still 21 GB away — shall I ask them to download it?'. It reads the same /api/models the "
        + "Models screen reads, so your answer and the screen beside your user cannot disagree. "
        + "`studio_capabilities` is the whole tour; this is one page of it, plus this machine.",
      inputSchema: {
        type: "object",
        properties: {
          view: {
            type: "string",
            description:
              "Which screen. The ids are the ones `studio_capabilities` lists under `tabs` — e.g. "
              + "create (which is the Music screen), images, video, daw, workflow, vfx, studio, "
              + "reactive, overnight, models, settings, mcp, community, games, about, thanks. An "
              + "unknown id is refused with the full list rather than guessed at.",
          },
        },
        required: ["view"],
        additionalProperties: false,
      },
      async run(a) {
        const r = await post({ action: "screen_info", view: String(a.view || "") });
        /* The route's own object, minus the transport flag. A tool that
         * reshaped this would be the second description of a screen that this
         * whole file exists to prevent. */
        const { ok, ...info } = r;
        return info;
      },
    },

    {
      name: "studio_showcase",
      description:
        "WHAT THIS MACHINE HAS ACTUALLY MADE: a handful of real pictures, songs, video clips and DAW "
        + "bounces off this disk, each with the prompt or caption that produced it and a url you can "
        + "fetch. Nothing here ships with the app — a fresh install returns empty panels that say so "
        + "rather than sample content. Use it to show a user what their own studio has produced, or "
        + "to read back the prompt behind something they liked.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await post({ action: "showcase" });
        return r.showcase;
      },
    },

    {
      name: "studio_welcome",
      description:
        "The first run and the level. `first_run` returns the three lines Home shows a new install "
        + "about THIS PC (what card Studio read, which music and picture models, whether video clips "
        + "fit), word for word. `reopen` makes Home show them again next load; `dismiss` hides them. "
        + "`level` reads whether Music, Pictures and Video open Simple or Advanced, who chose it, and "
        + "what Advanced adds on each screen; with `level` set it saves the person's choice, the "
        + "same switch as Settings > Screens > Show every setting. Ask before changing it. The tour "
        + "itself no longer opens by itself; it is under About.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string", enum: ["reopen", "dismiss", "first_run", "level"],
            description: "reopen = show the first-run lines again next load; dismiss = hide them; "
              + "first_run = read them; level = read the Simple/Advanced level, or save it with `level`.",
          },
          level: {
            type: "string", enum: ["simple", "advanced"],
            description: "With action level: save this as how the make screens open. Leave out to read.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async run(a) {
        const want = String(a.action || "");
        if (want === "first_run") {
          const r = await post({ action: "first_run" });
          return { lines: r.lines, links: r.links, machine: r.machine, shown_on_home: r.firstRun };
        }
        if (want === "level") {
          const r = a.level === undefined
            ? await post({ action: "level" })
            : await post({ action: "level", level: String(a.level) });
          const { ok, ...state } = r;
          return state;
        }
        if (want !== "reopen" && want !== "dismiss") {
          throw new Error('action must be "reopen", "dismiss", "first_run" or "level".');
        }
        /* Two literal posts rather than one interpolated `action: want`, so the
         * parity gate can SEE both names in this file. A gate that reads source
         * cannot follow a variable, and an action it cannot see is an action
         * nobody is checking. */
        const r = want === "reopen"
          ? await post({ action: "reopen" })
          : await post({ action: "dismiss" });
        return {
          first_run_lines_next_load: r.firstRun,
          seen_version: r.seenVersion,
          seen_at: r.seenAt,
          note: r.note ?? "Home will not show the first-run lines again.",
        };
      },
    },
  ];
}
