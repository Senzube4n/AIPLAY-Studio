/**
 * CHAT v1 — the eight tools, against the real routes.
 *
 * TWO PARTS, and the split is the whole design of this file.
 *
 * PART A runs every tool with a RECORDING STUB in place of the HTTP call, and
 * asserts the thing that actually breaks in production: which path it posts,
 * which action it names, and which fields it puts in the body. A tool that
 * posts `segment` where the route reads `segmentId` fails silently — the route
 * shrugs, files the previz against no scene, and answers 200. So the stub does
 * not check that a tool "works"; it checks the exact words on the wire against
 * the words server/mv/routes.js and server/index.js really read, which are
 * quoted here beside each assertion.
 *
 * PART B runs the READ-ONLY tools against the REAL app on 127.0.0.1, and is
 * SKIPPED when the app is not running. That is deliberate, and it is the
 * hook's own rule: "a hook that fails whenever the app is closed is a hook
 * people delete." Only `list_library`, `song_status` and `list_images` go
 * live, because they are the three that write nothing at all and spend no card
 * — `mv_create_project` would leave a project on the owner's disk every time
 * somebody committed, and `make_image` would spend ten seconds of a shared
 * graphics card. Neither is a test; the first is litter and the second is theft.
 *
 * Runs standalone (`node server/chat/tools_test.js`) and in the pre-commit hook.
 */
import { createChatTools, CHAT_ACTOR } from "./tools.js";
import { config } from "../config.js";
import { readFileSync } from "node:fs";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const skip = (label, why) => console.log(`  skip  ${label} — ${why}`);

/** A stub that records every call and answers from a table. */
function recorder(answers = {}) {
  const seen = [];
  const api = async (method, path, body) => {
    seen.push({ method, path, body });
    const key = `${method} ${path}`;
    const a = answers[key] ?? answers[path];
    if (a === undefined) return {};
    return typeof a === "function" ? a(body) : a;
  };
  api.seen = seen;
  api.last = () => seen[seen.length - 1];
  return api;
}

const STATUS = {
  current: null,
  queue: [],
  history: [
    { id: "j_done", title: "Neon Rain", state: "done", stage: null, stageLabel: null,
      overall: 1, etaSeconds: 0, file: "neon_rain.flac", durationSeconds: 184, error: null },
    { id: "j_run", title: "Half Light", state: "running", stage: "ar", stageLabel: "writing",
      overall: 0.42, etaSeconds: 120, file: null, durationSeconds: null, error: null },
    /* A job stopped mid-render KEEPS the stage, percent and ETA it had when it
     * stopped — that is what the app's own snapshot really holds, and it is
     * why the fields below have to be dropped rather than passed on. */
    { id: "j_stop", title: "Rain", state: "cancelled", stage: "ar", stageLabel: "composing",
      overall: 0.01, etaSeconds: 230, file: null, durationSeconds: null, error: null },
  ],
  library: [
    { file: "neon_rain.flac", title: "Neon Rain", durationSeconds: 184, cover: "a.png", lrc: "a.lrc" },
    { file: "half_light.flac", title: "Half Light", durationSeconds: 201, cover: null, lrc: null },
  ],
};

/* ══ A. the words on the wire ═════════════════════════════════════════════ */
console.log("\nTHE WORDS ON THE WIRE");

{
  const api = recorder({
    "POST /api/generate": { job: { id: "x" } },
    "GET /api/status": { ...STATUS, queue: [{ id: "j_new", title: "My Song" }] },
  });
  const tools = createChatTools({ api });
  const out = await tools.get("make_song").run({
    caption: "Global Metadata. 96 BPM, A minor. Vocal Details. One woman, close. Arrangement. Piano and brushes.",
    lyrics: "[Verse]\nrain on the wire",
    title: "My Song",
  });
  const gen = api.seen[0];
  ok("make_song posts /api/generate", gen.method === "POST" && gen.path === "/api/generate", JSON.stringify(gen));
  ok("...with `caption`, `lyrics`, `title`, `instrumental` — the four server/index.js reads",
    "caption" in gen.body && "lyrics" in gen.body && "title" in gen.body && "instrumental" in gen.body,
    JSON.stringify(Object.keys(gen.body)));
  ok("...and it does NOT invent a seed, so /api/generate keeps making its own",
    gen.body.seed === undefined);
  ok("then reads /api/status to find WHICH job is ours", api.seen[1].path === "/api/status");
  ok("...and takes the LAST in the queue, not the current job — /api/generate answers with "
     + "somebody else's song on a busy queue", out.job_id === "j_new", JSON.stringify(out));
  ok("...and says plainly that it is not finished", /Rendering has started/.test(out.note));

  let threw = null;
  try { await createChatTools({ api: recorder() }).get("make_song").run({ caption: "   " }); }
  catch (e) { threw = e.message; }
  ok("an empty caption is refused before anything is posted", /caption is required/i.test(threw || ""), String(threw));
}

{
  const api = recorder({ "GET /api/status": STATUS });
  const tools = createChatTools({ api });
  const running = await tools.get("song_status").run({ id: "j_run" });
  ok("song_status finds a job by id", running.found === "job" && running.job_id === "j_run");
  ok("...and reports the stage in words plus a percentage",
    running.stage === "writing" && running.percent === 42, JSON.stringify(running));
  const byFile = await tools.get("song_status").run({ id: "half_light.flac" });
  ok("...and a FILE NAME finds the finished track instead of nothing",
    byFile.found === "track" && byFile.title === "Half Light", JSON.stringify(byFile));
  const none = await tools.get("song_status").run({ id: "nothing_here" });
  ok("...and an unknown id says so rather than throwing", none.found === "nothing" && /list_library/.test(none.note));

  /* ⚠ THE NAME THAT IS BOTH, which is what every finished song is. `j_done`
   * rendered `neon_rain.flac` and that file is now a track in the library, so
   * the one handle the person has matches a job AND a track. Searching jobs by
   * id-or-file in a single pass gave the job, and a job row carries no `cover`
   * and no `lrc` — so "does aiplay_00086 have art yet?" was answered "it is
   * done", which is true and useless. MEASURED ON THE OWNER'S OWN DISK,
   * 2026-09-07: their newest track resolved to its own render job, and that is
   * the assertion in the live block at the bottom of this file which had been
   * failing for it. A job id still finds the job; a FILE NAME finds the file. */
  const both = await tools.get("song_status").run({ id: "neon_rain.flac" });
  ok("a name that is BOTH a finished job's file and a library track answers as the TRACK",
    both.found === "track" && both.file === "neon_rain.flac", JSON.stringify(both));
  ok("...which is the whole point: a job row cannot say whether it has cover art or lyrics",
    both.has_cover === true && both.has_lyrics === true, JSON.stringify(both));
  ok("...while the job id itself still answers as the job, because that name is unambiguous",
    (await tools.get("song_status").run({ id: "j_done" })).found === "job");

  /* THE THIRD PASS IS NOT A LEFTOVER. A render that has been given its name but
   * has not landed in the library yet is reachable only by matching a job on
   * its file — and that is exactly the moment the person asks "is it done?". */
  {
    const midRender = {
      ...STATUS,
      library: [],
      current: { id: "j_now", title: "Coming", state: "running", stage: "ar", stageLabel: "writing",
                 overall: 0.3, etaSeconds: 90, file: "coming.flac", durationSeconds: null, error: null },
    };
    const t2 = createChatTools({ api: recorder({ "GET /api/status": midRender }) });
    const inflight = await t2.get("song_status").run({ id: "coming.flac" });
    ok("a file name with no library entry yet still finds the job that is making it",
      inflight.found === "job" && inflight.job_id === "j_now" && inflight.still_running === true,
      JSON.stringify(inflight));
  }

  /* ⚠ A FINISHED JOB HAS NO PROGRESS. MEASURED LIVE, 2026-09-05: asked about a
   * job the person had just cancelled, this tool handed back state "cancelled"
   * alongside the stage, percent and ETA frozen at the moment it stopped, and
   * Qwen3-4B reported — verbatim — "The job cadfcb92 has been cancelled and is
   * currently in the Composing stage. It has 1% progress and an estimated time
   * of 230 seconds remaining." Every number in that sentence came from here. */
  const stopped = await tools.get("song_status").run({ id: "j_stop" });
  ok("a cancelled job reports its state", stopped.state === "cancelled");
  ok("...and NOT the stage it was frozen at, which a 4B reads as where it still is",
    stopped.stage === null, JSON.stringify(stopped));
  ok("...nor the percentage it never got past", stopped.percent === null, JSON.stringify(stopped));
  ok("...nor an ETA for something that is not coming", stopped.eta_seconds === null, JSON.stringify(stopped));
  ok("...and says in one field that it is over", stopped.still_running === false);
  const done = await tools.get("song_status").run({ id: "j_done" });
  ok("a FINISHED job drops them too, and answers with the file instead",
    done.stage === null && done.percent === null && done.file === "neon_rain.flac" && done.still_running === false,
    JSON.stringify(done));
  ok("...while a job that really is running keeps every one of them",
    running.stage === "writing" && running.percent === 42 && running.eta_seconds === 120
    && running.still_running === true, JSON.stringify(running));
}

{
  const api = recorder({ "GET /api/status": STATUS });
  const tools = createChatTools({ api });
  const all = await tools.get("list_library").run({});
  ok("list_library reads /api/status and returns file, title, seconds",
    all.count === 2 && all.tracks[0].file === "neon_rain.flac" && all.tracks[0].seconds === 184,
    JSON.stringify(all));
  ok("...and says how many there are in total, so a limit does not read as the whole library",
    all.total === 2);
  const one = await tools.get("list_library").run({ limit: 1 });
  ok("...and honours a limit", one.count === 1);
  const daft = await tools.get("list_library").run({ limit: 5000 });
  ok("...and clamps a silly one rather than sending 5000 rows to a 4B", daft.count === 2);
}

/* ── make_image, and the four things it has to get right ──────────────────
 *
 * The route answers the moment the job is QUEUED and never names a file, so the
 * only honest way to say which picture is ours is to read the folder before and
 * after. These pin that sequence, the words on the wire, and the two refusals —
 * an engine name server/index.js does not recognise is SILENTLY turned into
 * flux2 there, which would hand a person who asked for a photograph the general
 * model with nothing said about it. */
{
  let listed = 0;
  const api = recorder({
    "GET /api/images": () => ({
      images: listed++ === 0
        ? [{ name: "old.png", meta: { prompt: "a cat" }, model: "FLUX.2 klein" }]
        : [{ name: "new.png", meta: { prompt: "a lighthouse" }, model: "FLUX.2 klein" },
           { name: "old.png", meta: { prompt: "a cat" }, model: "FLUX.2 klein" }],
    }),
    "GET /api/images/qwen-status": { ready: true },
    "POST /api/image": { ok: true, id: "i123", seed: 42 },
    /* An idle art queue, which is what ends the wait on the first poll. */
    "GET /api/status": { art: { queued: 0, current: null, lastError: null } },
  });
  const tools = createChatTools({ api });
  const out = await tools.get("make_image").run({ prompt: "a lighthouse in fog" });

  ok("make_image reads /api/images BEFORE it asks for anything — the route never names the file",
    api.seen[0].method === "GET" && api.seen[0].path === "/api/images", JSON.stringify(api.seen[0]));
  const post = api.seen.find((call) => call.method === "POST");
  ok("...then posts /api/image", post.method === "POST" && post.path === "/api/image", JSON.stringify(post));
  ok('...with action "create", the prompt and an engine — the three server/index.js reads',
    post.body.action === "create" && post.body.prompt === "a lighthouse in fog"
    && post.body.engine === "qwen-image-2.1", JSON.stringify(post.body));
  ok("Qwen readiness is checked before queueing", api.seen[1].path === "/api/images/qwen-status");
  ok("...and NOTHING ELSE: no refImages, no promptChoices, no dedupe, no count, because every one "
     + "of those is an array or a replay semantic and this model cannot emit them",
    Object.keys(post.body).sort().join(",") === "action,engine,prompt",
    Object.keys(post.body).join(","));
  ok("...then waits on /api/status until the art queue is quiet",
    api.seen[3].method === "GET" && api.seen[3].path === "/api/status");
  ok("...and names the file by DIFFING the folder, which is the only handle there is",
    out.image === "new.png" && out.made === 1, JSON.stringify(out));
  ok("...and says where it landed and how to look at it, not just that it worked",
    /Pictures screen/.test(out.where) && out.url === "/api/image/new.png", JSON.stringify(out));

  let noPrompt = null;
  try { await createChatTools({ api: recorder() }).get("make_image").run({ prompt: "  " }); }
  catch (e) { noPrompt = e.message; }
  ok("an empty prompt is refused before the card is touched",
    /what the picture should show/i.test(noPrompt || ""), String(noPrompt));

  let badEngine = null;
  try { await createChatTools({ api: recorder() }).get("make_image").run({ prompt: "a cat", engine: "dalle" }); }
  catch (e) { badEngine = e.message; }
  ok("an INVENTED ENGINE NAME is refused by name — /api/image would silently fall back to flux2 and "
     + "hand back a different model with nothing said",
    /no engine called "dalle"/.test(badEngine || "") && /flux2 or zimage/.test(badEngine || ""),
    String(badEngine));
}

{
  /* ITS OWN FAILURE, IN ITS OWN WORDS. The wait follows the `job.id` the route
   * returned (server/art-wait.js, the waiter MCP's make_image runs) and throws
   * that job's `error`. It used to wait for the whole queue and quote
   * `lastError`, the queue's last failure: somebody else's, here. */
  const api = recorder({
    "GET /api/images": { images: [{ name: "old.png" }] },
    "GET /api/images/qwen-status": { ready: true },
    "POST /api/image": { ok: true, id: "i1", job: { id: "j1" } },
    "GET /api/status": { art: { jobIds: true, queued: 0, current: null, items: [],
      recent: [{ id: "j1", title: "a cat", error: "CUDA out of memory" }],
      lastError: "an overnight clip: disk full" } },
  });
  let threw = null;
  try { await createChatTools({ api }).get("make_image").run({ prompt: "a cat" }); }
  catch (e) { threw = e.message; }
  ok("a render that fails FAILS rather than reporting a picture, and carries its OWN job's error",
    /did not come out/.test(threw || "") && /CUDA out of memory/.test(threw || ""), String(threw));
  ok("...never the queue's last error, which belongs to another job",
    !/disk full/.test(threw || ""), String(threw));
}

{
  /* Nothing new in the folder and its own job finished clean: the render is over
   * and it produced no file. It THROWS: the loop draws a failed tool card for a
   * throw and a satisfied one for a result, and "your picture is ready" over an
   * empty folder is the sentence this whole strand exists to stop. A stranger's
   * failure in `lastError` is not the reason, so it is not quoted. */
  const api = recorder({
    "GET /api/images": { images: [{ name: "old.png" }] },
    "GET /api/images/qwen-status": { ready: true },
    "POST /api/image": { ok: true, id: "i2", job: { id: "j2" } },
    "GET /api/status": { art: { jobIds: true, queued: 0, current: null, items: [],
      recent: [{ id: "j2", title: "a dog", error: null }], lastError: "an overnight clip: CUDA out of memory" } },
  });
  let threw = null;
  try { await createChatTools({ api }).get("make_image").run({ prompt: "a dog" }); }
  catch (e) { threw = e.message; }
  ok("a render that produces no file FAILS rather than reporting a picture",
    /went quiet without producing a file/.test(threw || ""), String(threw));
  ok("...and does not blame it on another job's failure",
    !/CUDA out of memory/.test(threw || ""), String(threw));
}

{
  /* REUSED, NOT COPIED: one waiter for MCP and the chat, so the next fix to it
   * lands in both. A second hand-written loop here is how this one went stale. */
  const src = readFileSync(new URL("./tools.js", import.meta.url), "utf8");
  ok("the chat's picture wait is server/art-wait.js, following the route's job id",
    /import \{ waitForArtJob \} from "\.\.\/art-wait\.js";/.test(src)
    && /await waitForArtJob\(\{ api, sleep, timeoutMs: 300_000, kind: "image", jobId: r\.job\?\.id, pollMs: 1500 \}\);/.test(src));
  // Comments may still tell the history; code may not read the field.
  ok("...and no picture error is built from lastError any more",
    !/lastError/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

{
  /* THE OFF SWITCH. ArtRunner.request() answers null for a cover while the
   * Settings screen's Cover art switch is off, and the route still returns 200
   * — so nothing is queued, nothing will ever appear, and a wait loop would
   * spend five minutes discovering that. The answer says so on the way out. */
  const api = recorder({
    "GET /api/images": { images: [] },
    "GET /api/images/qwen-status": { ready: true },
    "POST /api/image": { ok: true, id: "i9", job: null, art: { enabled: false, queued: 0, current: null } },
  });
  let threw = null;
  try { await createChatTools({ api }).get("make_image").run({ prompt: "a cat" }); }
  catch (e) { threw = e.message; }
  ok("a picture asked for while the Cover art switch is OFF says so at once, rather than "
     + "waiting five minutes for a render that was never queued",
    /switched off/.test(threw || "") && /Cover art switch/.test(threw || ""), String(threw));
  ok("...and it never reaches the wait loop, so it costs one call and no card",
    api.seen.filter((c) => c.path === "/api/status").length === 0,
    api.seen.map((c) => `${c.method} ${c.path}`).join(" → "));
}

{
  const api = recorder({ "GET /api/images": { images: [] }, "GET /api/images/qwen-status": { ready: false, error: "ComfyUI is missing TextEncodeQwenImage21" } });
  let message;
  try { await createChatTools({ api }).get("make_image").run({ prompt: "a lighthouse" }); }
  catch (error) { message = error.message; }
  ok("unavailable Qwen explains its preflight refusal and queues no alternate engine",
    /TextEncodeQwenImage21/.test(message || "") && !api.seen.some((call) => call.method === "POST"), message);
  ok("the Qwen cost sentence makes no invented speed claim", /not been measured/.test(createChatTools({ api }).get("make_image").cost));
}

{
  const api = recorder({
    "GET /api/images": {
      images: [
        { name: "a.png", meta: { prompt: "x".repeat(400) }, model: "FLUX.2 klein" },
        { name: "b.png", meta: null, model: null },
      ],
    },
  });
  const tools = createChatTools({ api });
  const out = await tools.get("list_images").run({});
  ok("list_images GETs /api/images and nothing else — free, read-only, no card at all",
    api.seen.length === 1 && api.seen[0].method === "GET" && api.seen[0].path === "/api/images",
    JSON.stringify(api.seen));
  ok("...and returns the file name, the words and the model that drew it",
    out.images[0].file === "a.png" && out.images[0].model === "FLUX.2 klein", JSON.stringify(out.images[0]));
  ok("...with the prompt TRIMMED, because ten full prompts is more than the loop's whole result budget",
    out.images[0].prompt.length <= 141 && out.images[0].prompt.endsWith("…"),
    `${out.images[0].prompt.length} characters`);
  ok("...and a picture with no recorded prompt says null rather than inventing one",
    out.images[1].prompt === null && out.images[1].model === null);
  ok("...and says where they are, which is the answer to 'where did my picture go'",
    /Pictures screen/.test(out.where), out.where);
  const one = await createChatTools({
    api: recorder({ "GET /api/images": { images: [{ name: "a.png" }, { name: "b.png" }] } }),
  }).get("list_images").run({ limit: 1 });
  ok("...and honours a limit while still saying the real total",
    one.count === 1 && one.total === 2, JSON.stringify(one));
}

{
  const api = recorder({ "POST /api/mv": { ok: true, slug: "midnight-drive" } });
  const tools = createChatTools({ api });
  const out = await tools.get("mv_create_project").run({ title: "Midnight Drive" });
  const call = api.last();
  ok("mv_create_project posts /api/mv", call.path === "/api/mv" && call.method === "POST");
  ok('...with action "create" and a title — the two server/mv/routes.js `case "create"` reads',
    call.body.action === "create" && call.body.title === "Midnight Drive", JSON.stringify(call.body));
  ok("...and hands back the slug every other video tool needs", out.slug === "midnight-drive");
}

{
  const api = recorder({ "POST /api/mv": { ok: true, plan: { line: "a slow push" }, previz: "previz_01.mp4", installed: true } });
  const tools = createChatTools({ api });
  const out = await tools.get("mv_previz_shot").run({ slug: "midnight-drive", move: "push_in", scene: "corridor", segment: "s02", frames: 144 });
  const b = api.last().body;
  ok('mv_previz_shot posts action "previz_shot"', b.action === "previz_shot");
  ok("...and spells the scene key `segmentId`, which is what the route reads — `segment` would "
     + "file the shot against no scene and still answer 200", b.segmentId === "s02", JSON.stringify(b));
  ok("...and passes slug, move, scene and frames through unchanged",
    b.slug === "midnight-drive" && b.move === "push_in" && b.scene === "corridor" && b.frames === 144);
  ok("...and returns the plan and the previz separately, because they have different standings",
    out.plan?.line === "a slow push" && out.previz === "previz_01.mp4");

  const bare = createChatTools({ api: recorder({ "POST /api/mv": { ok: true } }) });
  let threw = null;
  try { await bare.get("mv_previz_shot").run({ slug: "x" }); } catch (e) { threw = e.message; }
  ok("a previz with no move is refused here rather than at the far end", /camera move/i.test(threw || ""), String(threw));

  let esc = null;
  try { await bare.get("mv_previz_shot").run({ slug: "../../etc", move: "push_in" }); } catch (e) { esc = e.message; }
  ok("a slug that walks out of its folder is refused — the model's output is not trusted input",
    /usable project name/.test(esc || ""), String(esc));
}

{
  const api = recorder({
    "POST /api/mv": { ok: false, clip: "shot.mp4", validation: { width: 1920, height: 1080, fps: 30, frames: 96 },
                      why: "1920x1080 is not 1280x704" },
  });
  const tools = createChatTools({ api });
  const out = await tools.get("mv_control_check").run({ slug: "midnight-drive", clip: "shot.mp4" });
  const b = api.last().body;
  ok('mv_control_check posts action "control_render" with mode "check"',
    b.action === "control_render" && b.mode === "check", JSON.stringify(b));
  ok("...which is the SAME code path the expensive tool runs, stopped before it stages a byte — "
     + "so the answer here and the refusal there cannot disagree", b.source === "clip" && b.clip === "shot.mp4");
  ok("...a failing clip comes back ok:false with the three measured numbers",
    out.ok === false && out.measured.width === 1920 && out.measured.fps === 30 && out.measured.frames === 96);
  ok("...and the next step names the contract rather than saying 'invalid'",
    /1280x704/.test(out.next) && /24 fps/.test(out.next) && /121 frames/.test(out.next), out.next);

  const good = createChatTools({ api: recorder({ "POST /api/mv": { ok: true, clip: "ok.mp4", validation: { width: 1280, height: 704, fps: 24, frames: 121 } } }) });
  const pass2 = await good.get("mv_control_check").run({ slug: "s", clip: "ok.mp4" });
  ok("...and a legal clip says so", pass2.ok === true && /legal/.test(pass2.next));
}

/* Every tool carries a paragraph long enough to be a paragraph, and the two
 * that spend carry a cost sentence. An empty `cost` on a spending tool would
 * put a confirm button in front of a person with nothing beside it. */
{
  const tools = createChatTools({ api: recorder() });
  ok("every tool has a description of at least 200 characters",
    tools.all.every((t) => String(t.description).length >= 200),
    tools.all.filter((t) => String(t.description).length < 200).map((t) => t.name).join(", "));
  ok("every spending tool has a cost sentence",
    tools.all.filter((t) => t.spends).every((t) => String(t.cost || "").length > 20),
    tools.all.filter((t) => t.spends && !t.cost).map((t) => t.name).join(", "));
  ok("no free tool claims a cost", tools.all.filter((t) => !t.spends).every((t) => !t.cost));
  ok("EVERY ARGUMENT OF EVERY TOOL IS FLAT — no object and no array anywhere, because a 4B "
     + "asked for one produces something that does not parse",
    tools.all.every((t) => Object.values(t.args || {}).every((a) => ["string", "integer", "boolean"].includes(a.type))),
    tools.all.flatMap((t) => Object.entries(t.args || {}).filter(([, a]) => !["string", "integer", "boolean"].includes(a.type)).map(([k]) => `${t.name}.${k}`)).join(", "));
  ok("the actor is forced to agent:chat and cannot be configured away", CHAT_ACTOR === "agent:chat");
}

/* ══ B. against the running app ═══════════════════════════════════════════ */
console.log("\nAGAINST THE RUNNING APP");

let up = false;
try {
  const r = await fetch(`http://127.0.0.1:${config.uiPort}/api/status`, {
    headers: { "x-aiplay-actor": CHAT_ACTOR },
    signal: AbortSignal.timeout(3000),
  });
  up = r.ok;
} catch { up = false; }

if (!up) {
  skip("the read-only tools against the real routes", `no Studio on 127.0.0.1:${config.uiPort}`);
  skip("...song_status against a real job id", "same");
} else {
  const live = createChatTools({ uiPort: config.uiPort });
  const lib = await live.get("list_library").run({ limit: 5 });
  ok(`list_library reads the REAL library (${lib.total} tracks on this disk)`,
    Number.isInteger(lib.total) && Array.isArray(lib.tracks) && lib.count <= 5,
    JSON.stringify(lib).slice(0, 200));
  ok("...and every row it returns has the handle the other tools need",
    lib.tracks.every((t) => typeof t.file === "string" && t.file.length > 0));

  const first = lib.tracks[0];
  if (first) {
    const st = await live.get("song_status").run({ id: first.file });
    ok(`song_status finds that real track back by its file name (${first.file})`,
      st.found === "track" && st.file === first.file, JSON.stringify(st));
  } else {
    skip("song_status against a real track", "the library is empty on this machine");
  }
  const nope = await live.get("song_status").run({ id: "definitely_not_a_real_id" });
  ok("...and an id that is not there answers rather than throwing", nope.found === "nothing");

  /* list_images goes live for the same reason list_library does: it reads a
   * folder, writes nothing and spends no card. make_image does NOT — a test
   * suite that renders a picture on every commit is spending a shared 16 GB
   * card on nobody's behalf. */
  const pics = await live.get("list_images").run({ limit: 5 });
  ok(`list_images reads the REAL images folder (${pics.total} pictures on this disk)`,
    Number.isInteger(pics.total) && Array.isArray(pics.images) && pics.count <= 5,
    JSON.stringify(pics).slice(0, 200));
  ok("...and every row carries the file name the person will see on the Pictures screen",
    pics.images.every((i) => typeof i.file === "string" && i.file.length > 0));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
