/**
 * CHAT v1 — THE EIGHT TOOLS.
 *
 * ── WHY EIGHT, AND WHY THESE EIGHT ────────────────────────────────────────
 *
 * The model behind this chat is qwen_3_4b, the 8.7 GB text encoder already on
 * this disk as FLUX.2's, driven through ComfyUI's TextGenerate node. Four
 * billion parameters, greedy, single-shot. server/mv/sfxcue.js measured what it
 * can and cannot do on this rig and the finding is blunt: it answers FLAT JSON
 * reliably and NESTED JSON not at all. A tool list is therefore a budget, not a
 * catalogue — the MCP surface next door offers well over two hundred tools, and
 * handing two hundred descriptions to a 4B is the same as handing it none.
 *
 * So: eight, curated, each with a paragraph written FOR a 4B rather than for a
 * frontier model. Short sentences. The rule stated, not implied. The failure
 * named. No cross-references it would have to resolve.
 *
 *   make_song         SPENDS   caption + lyrics -> a job id
 *   song_status                one job or track, by id
 *   list_library               the recent tracks
 *   make_image        SPENDS   a prompt -> one picture in the Images library
 *   list_images                the pictures already made (free)
 *   mv_create_project          start a music-video project
 *   mv_previz_shot    SPENDS   block a shot in Blender
 *   mv_control_check           is this clip legal to steer with (free)
 *
 * ── WHAT THE SEVENTH AND EIGHTH COST THE OTHER SIX ────────────────────────
 *
 * Every tool added is two more paragraphs in the one prompt this model reads
 * before every reply, and a 4B choosing between eight descriptions chooses
 * worse than one choosing between six. That is the trade, and it is paid by
 * all of them rather than by the new pair. It is worth paying here for one
 * reason: the screen had already promised this. Asked for a picture, the chat
 * answered "Sure! Let me create the brainrot image for you" and then did
 * nothing at all, because not one of the six could draw — a confident sentence
 * in front of an empty tool list, which is the worst thing this panel can do.
 *
 * The pair is kept as cheap as a tool can be. make_image takes a prompt and an
 * engine name and NOTHING else: `ref_images`, `prompt_choices`, `dedupe` and
 * `count` are arrays and replay semantics, which is precisely the shape this
 * model gets wrong, so the full surface stays next door in server/mcp.js where
 * a frontier model can reach it. list_images is free, read-only and answers the
 * question make_image immediately raises — "did it work?" — which is what earns
 * it the eighth slot ahead of anything else.
 *
 * ── WHY THESE CALL /api/… AND NOT MCP ─────────────────────────────────────
 *
 * The MCP servers in this tree are stdio transports for EXTERNAL clients, and
 * every one of their tools is a thin wrapper over a route this same process
 * already serves (server/mcp.js, ~373 tools, all of them `api(...)` calls).
 * Speaking MCP to ourselves would mean spawning a second node process to talk
 * JSON-RPC over a pipe back into this one. So the wrappers are skipped and the
 * routes are called directly.
 *
 * Directly means over loopback to this app's own port, which is the shape
 * server/welcome/routes.js already uses for /api/models and states the reason
 * for: IT IS A REQUEST TO THIS SAME SERVER, NOT A SECOND IMPLEMENTATION. The
 * alternative — importing jobs.js and mv/store.js here — would need the runner
 * instances that live inside server/index.js's closure, which means editing
 * index.js past the one mount line this strand is allowed. One HTTP hop on
 * 127.0.0.1 costs under a millisecond and buys exactly one implementation of
 * every behaviour, which is this repo's whole binding principle.
 *
 * Every call carries `x-aiplay-actor: agent:chat`. A song written through this
 * panel is an agent's song in the ledger and says so.
 */
import { config } from "../config.js";
import { waitForArtJob } from "../art-wait.js";

/** The actor every request from this loop is filed under. Forced in code, the
 *  way server/mcp.js forces its own — no argument or setting can make this
 *  panel claim to be the user's own hands. */
export const CHAT_ACTOR = "agent:chat";

/** One loopback call to this same server. */
function makeApi(uiPort) {
  return async function api(method, path, body, timeoutMs = 120_000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`http://127.0.0.1:${uiPort}${path}`, {
        method,
        headers: {
          "x-aiplay-actor": CHAT_ACTOR,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
      if (r.status >= 400) throw new Error(parsed?.error || `HTTP ${r.status}`);
      return parsed;
    } finally { clearTimeout(t); }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (v === undefined || v === null ? "" : String(v));
const int = (v, dflt) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt);
const bool = (v) => v === true || v === "true" || v === 1 || v === "yes";

/** A library/clip name that must not walk out of its folder. */
function safeName(v, what) {
  const s = str(v).trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
    throw new Error(`that is not a usable ${what} name`);
  }
  return s;
}

/**
 * THE TWO ENGINE NAMES THIS PANEL OFFERS, and why it is not the route's six.
 *
 * server/index.js accepts flux2, zimage, zimage-base, anima, ideogram4 and
 * checkpoint. Four of those cannot be picked with a name alone: `checkpoint`
 * and `anima` are refused without a second argument naming a file on this disk,
 * `ideogram4` carries a non-commercial licence whose text is gated and unread,
 * and `zimage-base` is the 25-step variant whose whole reason to exist is the
 * negative prompt and the cfg dial this panel does not expose. Offering a name
 * that needs an argument the model cannot supply is offering a refusal.
 *
 * So two, and both are Apache-2.0 and need nothing else: flux2 (FLUX.2 klein,
 * 4 steps, the app's default) and zimage (Z-Image Turbo, 8 steps, the
 * photographic one). A third name is REFUSED BY NAME here rather than quietly
 * turned into the default — the route silently falls back to flux2 for anything
 * it does not recognise, and a person who asked for a photograph and was given
 * the general model without being told is the failure that fallback causes.
 */
const CHAT_IMAGE_ENGINES = ["qwen-image-2.1", "flux2", "zimage"];

/** One picture's row, trimmed for a 4B's context: the whole prompt of an
 *  overnight render is longer than the loop's entire result budget. */
const shortPrompt = (v) => {
  const s = str(v).replace(/\s+/g, " ").trim();
  return s.length > 140 ? `${s.slice(0, 140)}…` : (s || null);
};

/**
 * The eight.
 *
 * `spends` is the load-bearing field: server/chat/loop.js will not call a tool
 * carrying it until the person has said yes in a following turn. `cost` is the
 * sentence shown beside the confirm button, and it is written from what this
 * repo has measured rather than from a guess — an invented number in front of a
 * confirm button is worse than no number, because it will be believed.
 *
 * `args` is FLAT AND ONLY FLAT. Every value is a string, an integer or a
 * boolean; there is no object and no array anywhere in this file's schemas,
 * because a 4B asked for one produces something that does not parse. The tools
 * next door that need a nested `spec` or `reference` are deliberately not here.
 */
export function createChatTools(deps = {}) {
  const api = deps.api || makeApi(deps.uiPort ?? config.uiPort);

  /* ── THE SET NAMES ARE THE TOOLKIT'S, AND THIS NOTE IS FILLED IN ──────────
   *
   * ⚠ THIS NOTE USED TO SPELL SEVEN SET NAMES, and it was one of five copies of
   * the toolkit's list in this app. The toolkit grew an eighth ('stage') and
   * every copy became a lie — this one in the worst way, because the note IS
   * the prompt: a 4B told the sets are "corridor, room, street, turntable,
   * atrium, warship or dig" will never ask for the eighth, and would be right
   * not to. So the list is asked for and written in here; until it arrives the
   * note names none of them and says plainly not to guess, which costs one
   * clarifying turn rather than a set that does not exist.
   *
   * loop.js re-renders the tool block from `args` on every turn, so a note
   * updated after construction reaches the model on the next thing it reads.
   *
   * The refresh only runs when this instance built its OWN transport. A caller
   * that passed `api` passed a stub — the two test suites do — and reaching
   * past a stub to the real port would be a second transport, which is the one
   * thing the header of this file promises not to do. */
  const sceneArg = {
    type: "string",
    note: "The grey-box Blender set to block the shot in. corridor by default. "
      + "Do not invent a set name — if you need one other than corridor, ask which sets exist.",
  };
  if (!deps.api) {
    Promise.resolve()
      .then(() => api("GET", "/api/mv/previz"))
      .then((r) => {
        const names = r?.sets?.names || r?.scenes;
        if (Array.isArray(names) && names.length) {
          sceneArg.note = `The grey-box Blender set. One of: ${names.join(", ")}. `
            + "corridor by default. Use one of those names exactly.";
        }
      })
      /* The studio answers this route itself, so a failure here means it is not
       * up yet. The fallback note is still true and the route still refuses a
       * set that does not exist, with the real list in the sentence. */
      .catch(() => {});
  }

  const TOOLS = [
    {
      name: "make_song",
      spends: true,
      cost: "about 4 to 5 minutes of GPU for a 3 minute song, and it holds the card while it runs",
      description:
        "Writes and renders a complete song with vocals on this machine. It returns a job id "
        + "straight away; the song is not finished when this returns. Use song_status with that "
        + "id to see how it is going.\n"
        + "The caption is the biggest quality lever there is. Write it in THREE PARTS, as three "
        + "sentences or three short paragraphs: 'Global Metadata.' the BPM, the key, the genre, "
        + "how the feeling moves through the song, and the production style. 'Vocal Details.' who "
        + "is singing and how they sing, or say plainly that it is instrumental. 'Arrangement.' "
        + "the main instruments, the secondary instruments, the groove and how much space there "
        + "is. A comma separated list of tags works much worse than these three parts.\n"
        + "The LENGTH OF THE OUTPUT TRACKS THE LENGTH OF THE LYRICS more than it tracks any "
        + "setting. Short lyrics make a short song. If a longer song is wanted, write more "
        + "verses.\n"
        + "Use [Verse], [Chorus] and [Bridge] on their own lines inside the lyrics.",
      args: {
        caption: { type: "string", required: true, note: "The three-part style description described above." },
        lyrics: { type: "string", note: "The words, with [Verse] / [Chorus] section tags. Leave out for an instrumental." },
        title: { type: "string", note: "Optional. One is worked out from the lyrics if you leave it out." },
        instrumental: { type: "boolean", note: "true means no vocals at all." },
      },
      async run(a) {
        const caption = str(a.caption).trim();
        if (!caption) throw new Error("A caption is required — the three-part one described in the tool.");
        await api("POST", "/api/generate", {
          caption,
          lyrics: str(a.lyrics).trim(),
          title: str(a.title).trim() || undefined,
          instrumental: bool(a.instrumental),
        });
        /* ⚠ /api/generate answers with the CURRENT job, which on a busy queue is
         * somebody else's song. Ours is the last one in the queue, or the
         * current job when the queue was empty — the same read server/mcp.js's
         * make_song makes, for the same reason. */
        const st = await api("GET", "/api/status");
        const mine = (st.queue || []).length ? st.queue[st.queue.length - 1] : st.current;
        return {
          job_id: mine?.id ?? null,
          title: mine?.title ?? null,
          position_in_queue: (st.queue || []).length,
          note: "Rendering has started. Ask song_status with this job_id.",
        };
      },
    },

    {
      name: "song_status",
      spends: false,
      description:
        "Says how one song is doing, by its id. Give it a job id from make_song and it reports "
        + "the stage it is on and how far through it is, or the file name once it has landed. "
        + "Give it a file name from list_library instead and it reports that finished track. "
        + "Free and instant. Nothing is cancelled by asking.",
      args: {
        id: { type: "string", required: true, note: "A job id from make_song, or a file name from list_library." },
      },
      async run(a) {
        const id = str(a.id).trim();
        if (!id) throw new Error("Give me a job id or a file name.");
        const st = await api("GET", "/api/status");
        const jobs = [st.current, ...(st.queue || []), ...(st.history || [])].filter(Boolean);
        const track = (st.library || []).find((t) => t.file === id);
        /* ⚠ THE ORDER OF THESE THREE LOOKUPS IS THE ANSWER, and it used to be
         * two. `id` is documented as EITHER a job id OR a file name, and a
         * finished song is BOTH — it has a job in the history whose `file` is
         * the track now sitting in the library. Searching jobs by id-or-file in
         * one pass meant the job always won, so asking about a finished track
         * by the only handle the person has answered "found: job, state: done"
         * and dropped `has_cover` and `has_lyrics` on the floor — the two facts
         * that question is usually asked to get. Measured on this disk: the
         * newest track, aiplay_00086.flac, resolved to its own render job.
         *
         * A job id is unambiguous, so it is asked first and keeps its meaning.
         * A FILE NAME names the file, and the file is the track — so the
         * library is asked next. A job matched BY FILE is still reachable, and
         * that third pass is not a leftover: a render that has been given its
         * name but has not landed in the library yet is found only there, and
         * that is precisely the "is it done?" the person asks while waiting. */
        const job = jobs.find((j) => j.id === id)
          || (track ? null : jobs.find((j) => j.file === id));
        if (job) {
          /* ⚠ A FINISHED JOB HAS NO PROGRESS, and saying otherwise is how a
           * small model produces a confident nonsense sentence. MEASURED LIVE,
           * 2026-09-05: asked about a job the person had just cancelled, this
           * tool handed back state "cancelled" AND the stage, percent and ETA
           * frozen at the moment it stopped, and Qwen3-4B faithfully reported
           * "has been cancelled and is currently in the Composing stage. It has
           * 1% progress and an estimated time of 230 seconds remaining." Every
           * number in that sentence came from here. A stopped job is not 230
           * seconds from anything, so the fields are dropped rather than left
           * for the model to reconcile — the state is the whole answer. */
          const finished = ["done", "failed", "cancelled"].includes(String(job.state));
          return {
            found: "job", job_id: job.id, title: job.title, state: job.state,
            stage: finished ? null : (job.stageLabel || job.stage || null),
            percent: finished || job.overall == null ? null : Math.round(job.overall * 100),
            eta_seconds: finished ? null : (job.etaSeconds ?? null),
            still_running: !finished,
            file: job.file || null, seconds: job.durationSeconds ?? null,
            error: job.error || null,
          };
        }
        if (track) {
          return {
            found: "track", file: track.file, title: track.title,
            seconds: track.durationSeconds ?? null,
            has_cover: !!track.cover, has_lyrics: !!track.lrc,
          };
        }
        return { found: "nothing", note: `Nothing here is called ${id}. Try list_library.` };
      },
    },

    {
      name: "list_library",
      spends: false,
      description:
        "Lists the songs already finished on this machine, newest first. Each one comes back "
        + "with its file name, its title, how long it is, and whether it has cover art or timed "
        + "lyrics yet. Free and instant. The file name is the handle every other tool wants when "
        + "it needs a track.",
      args: {
        limit: { type: "integer", note: "How many to return. 10 by default, 50 at most." },
      },
      async run(a) {
        const limit = Math.min(50, Math.max(1, int(a.limit, 10)));
        const st = await api("GET", "/api/status");
        const rows = (st.library || []).slice(0, limit).map((t) => ({
          file: t.file, title: t.title, seconds: t.durationSeconds ?? null,
          has_cover: !!t.cover, has_lyrics: !!t.lrc,
        }));
        return { count: rows.length, total: (st.library || []).length, tracks: rows };
      },
    },

    {
      name: "make_image",
      spends: true,
      cost: "holds the graphics card while drawing. Qwen Image 2.1 is the default; its runtime and peak memory "
        + "have not been measured on this machine, and it needs the model files and a compatible ComfyUI",
      description:
        "Draws one picture from a description and saves it on this machine. It waits until the "
        + "picture is finished, so when this answers the picture exists and it hands back the file "
        + "name.\n"
        + "Write the prompt as a plain description of the picture. Say what is in it, where it is "
        + "and what the light is like. Do not write it as a message — no 'please draw' and no "
        + "question inside it. The words you send are the words the model paints.\n"
        /* ⚠ MEASURED ON THE OWNER'S OWN SENTENCE, 2026-09-07. Asked for "a
         * little brainrot image that SAYS casperino assasino", the model wrote
         * `A little blonde boy named Casperino assassin with glasses…`. It read
         * "says" as "named", and the picture that came back — a good picture in
         * every other respect, blonde boy, glasses, filthy bare feet — had no
         * writing on it anywhere. The one word the person leant on was the one
         * word dropped, and the render cost the card in full.
         *
         * Nothing above told the model that lettering is a thing a picture can
         * CONTAIN, so it did the only other thing the sentence allows. This is
         * the missing instruction, and it names that exact confusion rather
         * than describing it in general terms — a 4B follows an example and
         * skims a principle. */
        + "WORDS IN THE PICTURE. If they asked for something written ON it — a sign, a caption, a "
        + "name across the top — put those words in the prompt inside double quotes, spelled the "
        + "way they spelled them, and say where they sit: the text \"casperino assasino\" in bold "
        + "letters across the bottom.\n"
        + "\"an image that SAYS x\" means the letters x are painted in the picture. It does not "
        + "mean the thing in the picture is CALLED x. A picture that was asked to say something "
        + "and says nothing is the wrong picture, and it spent the card just the same.\n"
        + "ONE picture per call. There is no way to ask for several here, and asking twice costs "
        + "the card twice.\n"
        + "The picture goes into the Studio's own Pictures library. Tell the person the file name "
        + "and tell them to open Pictures in the left rail to look at it.\n"
        + "Use list_images afterwards to see what is in that library.",
      args: {
        prompt: { type: "string", required: true,
          note: "What the picture shows, in plain words. One or two sentences is enough. Any words "
            + "that must be WRITTEN in the picture go in here too, inside double quotes." },
        engine: { type: "string",
          note: "Which drawing model. qwen-image-2.1 is the default (native INT8, 25 steps, noncommercial research licence). "
            + "flux2 and zimage remain explicit alternatives. These three names are accepted; missing Qwen files "
            + "or runtime support are reported before queueing, without silently switching models." },
      },
      async run(a) {
        const prompt = str(a.prompt).trim();
        if (!prompt) throw new Error("Say what the picture should show first.");
        const engine = str(a.engine).trim().toLowerCase() || CHAT_IMAGE_ENGINES[0];
        if (!CHAT_IMAGE_ENGINES.includes(engine)) {
          throw new Error(
            `There is no engine called "${engine.slice(0, 40)}" in this chat. `
            + `It is ${CHAT_IMAGE_ENGINES.join(" or ")}. Leave it out for ${CHAT_IMAGE_ENGINES[0]}.`);
        }

        /* WHICH FILE IS OURS. The route answers the moment the job is QUEUED —
         * `id`, `seed`, `job.id` and the art queue's state, never a file name,
         * because the picture does not exist yet. `job.id` is what the wait
         * below follows, so the VERDICT is this job's own; the file is still
         * named by knowing the folder before and after, because no status row
         * carries the picture's final name. */
        const before = new Set(((await api("GET", "/api/images")).images || []).map((i) => i.name));
        if (engine === "qwen-image-2.1") {
          const readiness = await api("GET", "/api/images/qwen-status");
          if (!readiness.ready) throw new Error(readiness.error || "Qwen Image 2.1 is not ready. Check its files in Models and the ComfyUI runtime.");
        }
        const r = await api("POST", "/api/image", { action: "create", prompt, engine });

        /* ⚠ THE OFF SWITCH, WHICH THIS ROUTE OBEYS IN SILENCE. Every picture
         * goes to the art runner as kind "cover", and ArtRunner.request()
         * answers `null` for a cover while the Settings screen's Cover art
         * switch is off — the route still returns 200, nothing is ever queued,
         * and the wait below would sit here for five minutes and then say the
         * render was slow. It was not slow; it never started. The answer
         * already carries both halves (a null job, and the runner's own
         * `enabled`), so it is read rather than waited out.
         *
         * NOT a silent fallback to another engine or a retry: the person turned
         * something off, and the only honest move is to say which thing. */
        if (!r.job && r.art && r.art.enabled === false) {
          throw new Error("Pictures are switched off in this Studio — the Cover art switch on the Settings screen. Nothing was queued and no card was spent. Turn it on and ask me again.");
        }

        /* WAIT FOR THIS PICTURE, by its job id: the same waiter MCP's make_image
         * runs (server/art-wait.js), not a copy of it. The person is sitting in
         * front of a chat panel: "it started" is not an answer to "draw me a
         * picture". The chat waits up to five minutes. This is a response
         * budget, not a performance claim about Qwen; running out REPORTS rather
         * than throws — a render that is still going has not failed. Its own
         * failure throws, in its own words; it no longer waits for the whole
         * queue and then quotes whatever failed last. */
        try {
          await waitForArtJob({ api, sleep, timeoutMs: 300_000, kind: "image", jobId: r.job?.id, pollMs: 1500 });
        } catch (err) {
          if (err?.stillWorking) {
            return {
              made: 0, still_drawing: true, engine, seed: r.seed ?? null,
              note: "The picture is taking longer than five minutes and it is still drawing. "
                + "Nothing was cancelled. Ask list_images in a while to see whether it landed.",
            };
          }
          throw new Error(`The picture did not come out: ${err.message}`);
        }

        const made = ((await api("GET", "/api/images")).images || [])
          .map((i) => i.name).filter((n) => !before.has(n));
        if (!made.length) {
          /* Nothing appeared and the render is over, so it produced no file.
           * Thrown rather than returned: the loop draws a failed tool card for
           * a throw and a satisfied one for a result, and a person told a
           * picture was drawn when none was is exactly the sentence this whole
           * strand exists to stop. NOT `art.lastError`: its own failure has
           * already thrown above, so whatever lastError holds here is some
           * other job's, and quoting it would blame this picture for it. */
          throw new Error("The picture queue went quiet without producing a file. Look at Pictures in the left rail.");
        }
        return {
          made: made.length, image: made[0], engine, seed: r.seed ?? null,
          /* WHERE IT LANDED, in the words of the screen it landed on, and the
           * address that shows it — the same /api/image/<name> the Pictures screen
           * itself paints from. */
          where: "the Pictures screen in the left rail of the Studio",
          url: `/api/image/${made[0]}`,
          ...(r.note ? { note: r.note } : {}),
        };
      },
    },

    {
      name: "list_images",
      spends: false,
      description:
        "Lists the pictures already on this machine, newest first. Each one comes back with its "
        + "file name, the words it was drawn from and the model that drew it. Free and instant — "
        + "it reads a folder and draws nothing, so it costs no graphics card at all.\n"
        + "This is how you check whether a picture arrived: call make_image, then call this and "
        + "look for the file name at the top.\n"
        + "The file name is what the person will see on the Pictures screen in the left rail, so say it "
        + "to them.",
      args: {
        limit: { type: "integer", note: "How many to return. 10 by default, 50 at most." },
      },
      async run(a) {
        const limit = Math.min(50, Math.max(1, int(a.limit, 10)));
        const all = (await api("GET", "/api/images")).images || [];
        return {
          count: Math.min(all.length, limit),
          total: all.length,
          where: "the Pictures screen in the left rail of the Studio",
          images: all.slice(0, limit).map((i) => ({
            file: i.name,
            /* The prompt is TRIMMED. An overnight render's prompt runs to
             * several hundred characters and ten of those is more than the
             * loop's whole 2400-character result budget — the measured failure
             * where a list is cut mid-word and the model reports the cut as the
             * end of the data (see RESULT_BUDGET in loop.js). */
            prompt: shortPrompt(i.meta?.prompt),
            model: i.model ?? null,
          })),
        };
      },
    },

    {
      name: "mv_create_project",
      spends: false,
      description:
        "Starts a music-video project and returns its slug. A project is the folder everything "
        + "about one video lives in: which song it is cut to, where the scenes fall, the look, "
        + "the cast, the boards and every clip. Free and instant. Every other video tool needs "
        + "the slug this gives you, so make the project first.",
      args: {
        title: { type: "string", required: true, note: "What the video is called." },
      },
      async run(a) {
        const title = str(a.title).trim();
        if (!title) throw new Error("Give the project a title.");
        const r = await api("POST", "/api/mv", { action: "create", title });
        return { slug: r.slug, title, note: "Use this slug with the other video tools." };
      },
    },

    {
      name: "mv_previz_shot",
      spends: true,
      cost: "about 25 seconds of Blender on this machine per shot, and it competes with a render for the card",
      description:
        "Blocks one shot in Blender: grey boxes moving through a grey set, so a person can watch "
        + "the camera move before spending half an hour of video model on it. It returns a small "
        + "mp4 and the words of the shot.\n"
        + "The grey-box clip is FOR A PERSON TO WATCH. Do not offer it as an input to a video "
        + "model. That was measured and it failed: handed to LTX as an appearance guide it gives "
        + "the grey boxes back rather than the camera move.\n"
        + "The move must be one of the names the studio knows. Ask for a move you invented and it "
        + "will refuse. If Blender is not installed you get the words and a sentence saying which "
        + "half is missing, not an error.",
      args: {
        slug: { type: "string", required: true, note: "From mv_create_project." },
        move: { type: "string", required: true, note: "The camera move by name, for example push_in, orbit, follow, crane." },
        scene: sceneArg,
        segment: { type: "string", note: "Optional. Which scene of the song this shot belongs to." },
        frames: { type: "integer", note: "121 to 480. 144 is six seconds at 24 fps." },
      },
      async run(a) {
        const slug = safeName(a.slug, "project");
        const move = str(a.move).trim();
        if (!move) throw new Error("Which camera move? Ask for the list first if you are not sure.");
        const r = await api("POST", "/api/mv", {
          action: "previz_shot", slug, move,
          scene: str(a.scene).trim() || undefined,
          segmentId: str(a.segment).trim() || undefined,
          frames: Number.isFinite(Number(a.frames)) ? int(a.frames) : undefined,
        }, 300_000);
        return {
          plan: r.plan ?? null, previz: r.previz ?? null,
          installed: r.installed ?? null, note: r.note ?? null,
        };
      },
    },

    {
      name: "mv_control_check",
      spends: false,
      description:
        "Measures a video clip and says whether it is legal to steer a render with. Free, "
        + "instant, no GPU at all — it reads the file and reports three numbers.\n"
        + "A clip used for steering must be EXACTLY 1280 by 704, EXACTLY 24 frames per second, "
        + "and at least 121 frames long. All three go wrong SILENTLY if they are not: the wrong "
        + "size is squashed and cropped, a short clip is padded with flat grey so the end of the "
        + "shot is steered by nothing, and the wrong frame rate is simply not read. Each one "
        + "finishes, reports success, and hands back a shot nobody asked for after the GPU time "
        + "is already spent.\n"
        + "So run this before steering, every single time. It is the same measurement the "
        + "expensive tool runs, stopped before it spends anything.",
      args: {
        slug: { type: "string", required: true, note: "The project slug." },
        clip: { type: "string", required: true, note: "The name of a clip in the video library." },
        segment: { type: "string", note: "Optional. Which scene this is for." },
      },
      async run(a) {
        const slug = safeName(a.slug, "project");
        const clip = safeName(a.clip, "clip");
        const r = await api("POST", "/api/mv", {
          action: "control_render", slug, clip, source: "clip",
          mode: "check", segmentId: str(a.segment).trim() || undefined,
        }, 120_000);
        return {
          ok: !!r.ok, clip: r.clip ?? clip, measured: r.validation ?? null, why: r.why ?? null,
          next: r.ok
            ? "legal — this clip can steer a render"
            : "not legal — fix it to 1280x704 / 24 fps / at least 121 frames, or pick another",
        };
      },
    },
  ];

  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return {
    all: TOOLS,
    names: TOOLS.map((t) => t.name),
    get: (n) => byName.get(String(n)) || null,
    spending: TOOLS.filter((t) => t.spends).map((t) => t.name),
  };
}

/** The default set, wired to this app's own port. */
export const chatTools = createChatTools();
export default chatTools;
