/**
 * NO PAID RUN WITHOUT ITS OWN YES, AND NONE WITH THE SWITCH OFF.
 *
 * The owner, 2026-09-24: a friend's card first, then a paid service on the
 * person's own key, off by default, every paid run confirmed, never a silent
 * fallback (server/cloud-switch.js). This lane holds every door a paid run can
 * pass through to that:
 *
 *   · the hosted engine itself refuses with the switch off or with no
 *     confirmation, before it reads a key (apiEngine.js generateViaApi);
 *   · the queue refuses a hosted song nobody confirmed, even one queued before
 *     the switch went on (jobs.js #pump);
 *   · /api/generate and /api/batch answer "confirm-spend" with the cost and the
 *     key, and mark only a confirmed job paidConfirmed (index.js, the real
 *     route text sliced out and run);
 *   · the Comfy API's run door refuses without confirmSpend (router/routes.js);
 *   · the page sets confirmSpend only after the person said yes, and the MCP
 *     tools forward it only as exactly true;
 *   · the switch itself is a same-origin door, a read for the chat and a set
 *     WITHHELD from it;
 *   · and a key is only ever one typed into Studio: no environment variable
 *     with KEY or TOKEN in its name is read unless it is an AIPLAY_ one, and a
 *     key another copy of Studio saved is shown as that.
 *
 * No server, no network, no GPU. Settings, the secret store and the ledger live
 * in a temp folder; fetch is counted so "nothing was sent" is measured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-cloud-confirm-"));
process.env.AIPLAY_APPDATA = tmp;
process.env.AIPLAY_OUTPUT = path.join(tmp, "out");
writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ api: { enabled: false, provider: "fal", monthlyCapUsd: 20 } }));

const { config } = await import("./config.js");
const cloud = await import("./cloud-switch.js");
const h3tier = await import("./h3tier.js");
const { generateViaApi } = await import("./apiEngine.js");
const { secretStatus } = await import("./secrets.js");
const { JobRunner } = await import("./jobs.js");
const { plannedSongs } = await import("./batch.js");
const { createRouterRoutes } = await import("./router/routes.js");
const { cloudTools } = await import("./mcp-cloud.js");
const { TOOLS } = await import("./mcp.js");
const { ROUTABLE, WITHHELD } = await import("./chat/router.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const INDEX = read("server/index.js");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error("no network in this lane"); };
test.after(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

/* The real guard, sliced out of index.js (the cross-origin-doors pattern). */
const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)({ uiPort: 4173 });
const HOST = "127.0.0.1:4173";
const PAGE = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" };
const FOREIGN = { host: HOST, origin: "https://evil.example", "content-type": "text/plain" };

const KEY = { set: true, usable: true, hint: "…abcd", savedAt: "2026-09-21T10:00:00.000Z", savedHere: false, savedBy: "C:\\Other\\Studio" };
const QUOTE = { provider: "fal", name: "fal.ai", label: "fal.ai — MiniMax Music 3", seconds: 180, usd: 0.36, key: KEY, spend: { spentUsd: 1.2, capUsd: 20 } };

/* ── the order and the sentences ─────────────────────────────────────────── */
test("friend first, then your own key: one list, in that order, the paid one marked", () => {
  assert.deepEqual(cloud.NO_STRONG_CARD.map((w) => w.id), ["friend", "own-key"]);
  assert.equal(cloud.NO_STRONG_CARD[0].paid, false);
  assert.equal(cloud.NO_STRONG_CARD[0].view, "collab");
  assert.equal(cloud.NO_STRONG_CARD[1].paid, true);
  const line = cloud.NO_STRONG_CARD_LINE;
  assert.ok(line.indexOf("friend") >= 0 && line.indexOf("friend") < line.indexOf("paid"), "the line names the friend before the paid way");
  /* Step 1 is ONE plain sentence with the button to press; the setup and the
   * honest limits live behind "More". */
  const friend = cloud.NO_STRONG_CARD[0];
  assert.doesNotMatch(friend.how.replace(/\.$/, ""), /[.!?]\s/, `one sentence: ${friend.how}`);
  assert.match(friend.how, /^Free: .*Ask friend.*Music video → Video clips/);
  assert.match(friend.limits, /Collab → Friends/);
  assert.match(friend.limits, /video scenes, not songs/);
  assert.ok(friend.how.includes(`(${cloud.LENDING_UNTRIED})`), "the round trip is not promised, in the step's own sentence");
  assert.doesNotMatch(friend.limits, /acceptance-tested|tried between two PCs/, "said once, in the step, not twice");
  /* Own key: a key another copy of Studio saved is used AND shown, so the
   * sentence does not claim "only a key you paste here". */
  assert.match(cloud.NO_STRONG_CARD[1].how, /only a key typed into Studio on this Windows account, never one from another program or an environment variable/);
  assert.match(cloud.NO_STRONG_CARD[1].how, /when it was saved and by which copy of Studio/);
  assert.match(cloud.NO_STRONG_CARD[1].how, /Every paid run asks first/);
  assert.equal(cloud.NO_STRONG_CARD[1].where, cloud.CLOUD_CARD_PLACE);
  assert.equal(cloud.HOSTED_KEY_PLACE, `${cloud.CLOUD_CARD_PLACE} → Hosted engine`);
  /* The video slot says what the paid half really is there. */
  assert.match(cloud.NO_STRONG_CARD_VIDEO_LINE, /^Ask a friend .*first \(Collab, free; built, not yet tried between two PCs\)\. A paid alternative .*Use Comfy API mode, outside a music video/);
  /* Every surface says lending is untried between two PCs, in one clause. */
  assert.equal(cloud.LENDING_UNTRIED, "built, not yet tried between two PCs");
  for (const line of [cloud.NO_STRONG_CARD_LINE, cloud.NO_STRONG_CARD_VIDEO_LINE, friend.how]) assert.ok(line.includes(cloud.LENDING_UNTRIED), line);
  /* ...and the places the release critic found without it: the H3 rows'
   * friend sentence (Models, the Video screen's "not offered"), Explore's
   * "No strong graphics card?" tip (built from each step's `how`) and the
   * Comfy API card's pointer to a friend. One copy, in h3tier.js. */
  assert.equal(h3tier.LENDING_UNTRIED, cloud.LENDING_UNTRIED);
  assert.ok(h3tier.H3_ASK_A_FRIEND.includes(`(Collab, free; ${cloud.LENDING_UNTRIED})`), h3tier.H3_ASK_A_FRIEND);
  const catalogue = read("server/welcome/catalogue.js");
  assert.match(catalogue, /detail: NO_STRONG_CARD\.map\(\(w, i\) => `\$\{i \+ 1\}\. \$\{w\.title\}\. \$\{w\.how\}`\)/);
  assert.match(catalogue, /for you first \(Collab, free; \$\{LENDING_UNTRIED\}\)\./);
  assert.match(read("server/cloud-switch.js"), /import \{ H3_MV_SCREEN, LENDING_UNTRIED \} from "\.\/h3tier\.js";/);
  /* The role named is the one the Friends row offers, and the fix that landed
   * (Keep it files a take even onto a never-rendered scene) is not called missing. */
  assert.ok(friend.limits.includes(`"${cloud.LENDER_ROLE_LABEL}"`));
  assert.ok(read("web/app.js").includes(`["lender", "${cloud.LENDER_ROLE_LABEL}"]`), "the Friends row offers that role");
  assert.doesNotMatch(friend.limits, /may render single scenes for me|filing onto its scene by hand/);
});

test("the paid question speaks whole seconds: 179.6 s is 3:00, never 2:60", () => {
  const say = (seconds) => cloud.paidRefusal({ ...QUOTE, seconds }).body.error;
  assert.match(say(179.6), /for up to 3:00,/);
  assert.match(say(59.5), /for up to 1:00,/);
  assert.match(say(90), /for up to 1:30,/);
});

test("the Models note, the Welcome page and the Settings card read that one list", () => {
  assert.match(read("server/fit.js"), /import \{ NO_STRONG_CARD, NO_STRONG_CARD_VIDEO_LINE \} from "\.\/cloud-switch\.js"/);
  assert.match(read("server/fit.js"), /headline: "No video engine is recommended for this machine\.",[\s\S]{0,600}Instead: \$\{NO_STRONG_CARD_VIDEO_LINE\}/);
  assert.match(read("server/fit.js"), /instead: NO_STRONG_CARD\.map\(\(w\) => \(\{ id: w\.id, title: w\.title, where: w\.where, view: w\.view, paid: w\.paid \}\)\)/);
  /* ...and the Models screen turns them into buttons, in that order, only for
   * a screen this launch mode shows. */
  const fitPage = read("web/modelfit.js");
  assert.match(fitPage, /\$\{insteadRow\(n, root\)\}/);
  assert.match(fitPage, /data-fitview="\$\{esc\(w\.view\)\}"/);
  assert.match(fitPage, /return !!a && !a\.hidden && a\.style\?\.display !== "none";/);
  assert.match(fitPage, /root\.querySelector\(`\.nav a\[data-view="\$\{CSS\.escape\(go\.dataset\.fitview\)\}"\]`\)\?\.click\(\);/);
  const cat = read("server/welcome/catalogue.js");
  assert.match(cat, /\{ what: "No strong graphics card\?", where: NO_STRONG_CARD\.map/);
  assert.match(cat, /It is the paid way, and the second one: without a strong card, ask a friend/);
  const html = read("web/index.html");
  const card = html.slice(html.indexOf('id="set-hosted"'), html.indexOf("</section>", html.indexOf('id="set-hosted"')));
  assert.ok(card.indexOf('id="cloudFriend"') > 0 && card.indexOf('id="cloudFriend"') < card.indexOf('id="cloudPaid"'), "step 1 is the friend");
  assert.ok(card.indexOf('id="apiKey"') < card.indexOf('id="apiEnabled"'), "the key field comes before the switch");
  assert.doesNotMatch(card, /id="apiBody" hidden/, "the key field is never hidden behind the switch");
  const go = card.indexOf('id="cloudFriendGo"'), more = card.indexOf('id="cloudFriendMore"');
  assert.ok(go > 0 && more > go && card.indexOf('id="cloudFriendLimits"') > more, "the button, then the limits behind More");
  assert.match(card, /<p class="hint warnhint" id="cloudHostedNote" hidden><\/p>/);
  for (const id of ["set-hosted", "apiEnabled", "apiBody", "apiProvider", "apiKey", "apiKeySave", "apiKeyClear", "apiCap", "apiCapSave", "apiKeyState", "apiMeter", "apiBarFill", "apiSpend", "apiProvNote", "apiState", "apiTradeoff"]) {
    assert.match(card, new RegExp(`id="${id}"`), `${id} kept (move, don't remove)`);
  }
});

/* ── the hosted engine: the last door before a provider ─────────────────── */
test("generateViaApi sends nothing with the switch off, or for a song nobody confirmed", async () => {
  config.api.enabled = false;
  await assert.rejects(generateViaApi({ caption: "x", maxDuration: 60, paidConfirmed: true }), /switched off, so nothing was sent/);
  config.api.enabled = true;
  await assert.rejects(generateViaApi({ caption: "x", maxDuration: 60 }), /not confirmed as a paid run, so nothing was sent/);
  await assert.rejects(generateViaApi({ caption: "x", maxDuration: 60, paidConfirmed: "true" }), /not confirmed/);
  /* Confirmed, switched on, no key saved in this profile: stops at the key. */
  await assert.rejects(generateViaApi({ caption: "x", maxDuration: 60, paidConfirmed: true }), /key is saved\. Add your own in Settings → No strong graphics card\? → Hosted engine/);
  config.api.enabled = false;
  assert.equal(fetches, 0, "not one request left this machine");
});

/* ── the queue ──────────────────────────────────────────────────────────── */
function settle(runner, id) {
  return new Promise((resolve) => {
    const look = () => {
      const done = runner.history.find((j) => j.id === id);
      if (done) { runner.off("update", look); resolve(done); }
    };
    runner.on("update", look);
    look();
  });
}
test("the queue refuses a hosted song nobody confirmed, and sends nothing", async () => {
  const runner = new JobRunner({ ready: true, on() {} });
  config.api.enabled = true;
  try {
    for (const engine of [undefined, "minimax-music3"]) {
      const job = runner.enqueue({ ...(engine ? { engine } : {}), title: "t", caption: "x", lyrics: "", maxDuration: 60 });
      const out = await settle(runner, job.id);
      assert.equal(out.state, "failed");
      assert.equal(out.error, JobRunner.UNCONFIRMED_PAID);
      assert.match(out.error, /no request was sent and nothing was billed/);
    }
    /* Confirmed: it passes the queue and meets the engine's own gates (no key here). */
    const ok = runner.enqueue({ engine: "minimax-music3", title: "t", caption: "x", lyrics: "", maxDuration: 60, paidConfirmed: true });
    const out = await settle(runner, ok.id);
    assert.equal(out.state, "failed");
    assert.match(out.error, /key is saved/, "a confirmed song reaches the hosted engine, which then wants a key");
    /* A job only this PC can do (a continuation, an audio-input song, an
     * audiobook bed): refused in words that fit it, nothing sent. */
    const local = runner.enqueue({ title: "bed", caption: "x", lyrics: "", maxDuration: 60, requiresLocal: true });
    const lout = await settle(runner, local.id);
    assert.equal(lout.state, "failed");
    assert.equal(lout.error, JobRunner.LOCAL_ONLY);
    assert.equal(fetches, 0);
  } finally { config.api.enabled = false; }
  /* Worded for every path that reaches the queue, not only Create. */
  assert.doesNotMatch(JobRunner.UNCONFIRMED_PAID, /Press Create/);
  assert.match(JobRunner.UNCONFIRMED_PAID, /Start it again and confirm the cost when Studio asks/);
  assert.doesNotMatch(JobRunner.LOCAL_ONLY, /audio-input|API mode/);
  assert.match(JobRunner.LOCAL_ONLY, /no API request was sent/, "the music-input lane's words still hold");
  /* The lifted-class lane keeps these statics literal; this pins them to the one card name. */
  assert.ok(JobRunner.LOCAL_ONLY.includes(cloud.CLOUD_CARD_PLACE));
  /* The audiobook bed is never a paid song: it is local-only. */
  const ab = read("server/mv/audiobook.js");
  const bed = ab.slice(ab.indexOf("export async function makeBed("), ab.indexOf("const done = await new Promise", ab.indexOf("export async function makeBed(")));
  assert.match(bed, /jobs\.enqueue\(\{[\s\S]*requiresLocal: true,\n\s+\}\);/);
});

/* ── /api/generate, the real route text ────────────────────────────────── */
test("/api/generate: a hosted song is refused with its cost until it carries its own confirmSpend", async () => {
  const start = INDEX.indexOf("      const paidSong = hostedWouldBill(");
  const end = INDEX.indexOf("      /* ── YuE2: the second kind of job.", start);
  assert.ok(start > INDEX.indexOf('if (p === "/api/generate" && req.method === "POST")') && end > start);
  const gate = new AsyncFunction("config", "musicEngine", "body", "json", "res", "hostedWouldBill", "paidRefusal", "hostedQuote",
    `${INDEX.slice(start, end)}\nreturn { passed: true, paidSong };`);
  const run = (apiEnabled, musicEngine, body, quote = QUOTE) =>
    gate({ api: { enabled: apiEnabled } }, musicEngine, body, (_r, status, b) => ({ status, body: b }), null,
      cloud.hostedWouldBill, cloud.paidRefusal, async (seconds) => ({ ...quote, seconds }));

  let r = await run(true, "minimax-music3", { caption: "x", maxDuration: 180 });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "confirm-spend");
  assert.match(r.body.error, /paid hosted engine \(fal\.ai — MiniMax Music 3\), about \$0\.36 for up to 3:00/);
  assert.match(r.body.error, /billed to your key …abcd saved on 21 Sep 2026 by another copy of Studio/);
  assert.match(r.body.error, /\$1\.20 of your \$20\.00 monthly cap is spent\. Nothing has been sent yet\./);
  for (const confirmSpend of [false, "true", 1, "yes"]) {
    assert.equal((await run(true, "minimax-music3", { caption: "x", confirmSpend })).status, 409, `confirmSpend ${JSON.stringify(confirmSpend)}`);
  }
  r = await run(true, "minimax-music3", { caption: "x", confirmSpend: true });
  assert.deepEqual(r, { passed: true, paidSong: true }, "confirmed: queued, and the job is marked paid");
  r = await run(false, "minimax-music3", { caption: "x" });
  assert.deepEqual(r, { passed: true, paidSong: false }, "switch off: a local song, never marked paid");
  for (const engine of ["yue2", "yue2-comfy", "ace-step15"]) {
    assert.deepEqual(await run(true, engine, { caption: "x" }), { passed: true, paidSong: false }, `${engine} is never hosted`);
  }
  r = await run(true, "minimax-music3", { caption: "x" }, { ...QUOTE, key: { set: false } });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, "needs-key");
  assert.match(r.body.error, /your own fal\.ai key[\s\S]*Settings → No strong graphics card\? → Hosted engine[\s\S]*Nothing was sent/);
  assert.match(INDEX, /actor: prov\.actorFrom\(req\),\n\s+\.\.\.\(paidSong \? \{ paidConfirmed: true \} : \{\}\),/,
    "the enqueue marks paidConfirmed only for a confirmed hosted song");
  assert.equal(INDEX.split("paidConfirmed: true").length, 2, "and nothing else in index.js marks a job paid");
});

test("/api/generate keeps its guard before the body is read", () => {
  const at = INDEX.indexOf('if (p === "/api/generate" && req.method === "POST")');
  const head = INDEX.slice(at, INDEX.indexOf("const body = await readBody(req);", at));
  assert.match(head, /if \(!sameOriginLocalJson\(req\)\) return json\(res, 403/);
});

test("a MiniMax continuation is local-only: refused at the door with the hosted engine on, never sent to it", async () => {
  const at = INDEX.indexOf("resumeFrom: `${meta.codes}#${resumeFrames}`,");
  assert.ok(at > 0);
  assert.match(INDEX.slice(at, at + 400), /requiresLocal: true,/);
  assert.equal(cloud.hostedWouldBill({ apiEnabled: true, engine: null, requiresLocal: true }), false);
  /* The door itself, sliced out and run: with the switch on nothing is queued. */
  const route = INDEX.indexOf('if ((p === "/api/extend" || p === "/api/replace") && req.method === "POST") {');
  const start = INDEX.indexOf("      if (hostedWouldBill({ apiEnabled: !!config.api.enabled, engine: null })) {", route);
  const end = INDEX.indexOf("      // Resume from a POINT, not from the end.", start);
  assert.ok(route > 0 && start > route && end > start && start < at, "the refusal sits before the MiniMax enqueue");
  const door = new AsyncFunction("hostedWouldBill", "config", "json", "res", "replacing", "CLOUD_CARD_PLACE",
    `${INDEX.slice(start, end)}\nreturn { queued: true };`);
  const hit = (on, replacing) => door(cloud.hostedWouldBill, { api: { enabled: on } }, (_r, status, body) => ({ status, body }), null, replacing, cloud.CLOUD_CARD_PLACE);
  for (const replacing of [false, true]) {
    const r = await hit(true, replacing);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "hosted-on");
    assert.match(r.body.error, new RegExp(`^${replacing ? "Replace" : "Extend"} always renders on this PC's own Music 3, .*nothing was queued or sent`));
    assert.deepEqual(await hit(false, replacing), { queued: true }, "switch off: the continuation queues as before");
  }
});

/* ── /api/batch: a paid night ───────────────────────────────────────────── */
test("/api/batch: a music night on the hosted engine is asked for once, with the night's estimate", async () => {
  const at = INDEX.indexOf('if (p === "/api/batch" && req.method === "POST") {');
  const head = INDEX.slice(at, INDEX.indexOf("const b = await readBody(req);", at));
  assert.match(head, /if \(!sameOriginLocalJson\(req\)\) return json\(res, 403/, "a night of bills is a same-origin door");
  const start = INDEX.indexOf('        if (b.action === "start") {', at);
  const end = INDEX.indexOf('        if (b.action === "pause")', start);
  const branch = new AsyncFunction("b", "config", "json", "res", "req", "hostedWouldBill", "paidRefusal", "hostedQuote", "batch", "prov", "plannedSongs",
    `${INDEX.slice(start, end)}\nreturn { fellThrough: true };`);
  const started = [];
  const run = (apiEnabled, b) => branch(b, { api: { enabled: apiEnabled } }, (_r, status, body) => ({ status, body }), null, {},
    cloud.hostedWouldBill, cloud.paidRefusal, async (seconds) => ({ ...QUOTE, seconds }),
    { start: (x) => { started.push(x); return { ok: true }; } }, { actorFrom: () => "agent:test" }, plannedSongs);
  const items = [{ caption: "a", maxDuration: 120 }, { caption: "b", maxDuration: 200 }, { caption: "" }];

  let r = await run(true, { action: "start", items, takes: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "confirm-spend");
  assert.equal(r.body.paid.runs, 6, "two ideas with a style × three takes");
  assert.match(r.body.error, /This would render 6 songs on the paid hosted engine/);
  assert.equal(started.length, 0, "nothing started");
  r = await run(true, { action: "start", items, takes: 3, cap: 4 });
  assert.equal(r.body.paid.runs, 4, "the cap bounds the estimate");
  assert.equal(r.body.paid.seconds, 200, "priced at the longest idea");
  r = await run(true, { action: "start", items: [{ caption: "" }] });
  assert.equal(r.status, 200, "no idea with a style: nothing to pay for, start() refuses in its own words");
  assert.equal(started.pop().paidConfirmed, false);
  r = await run(true, { action: "start", items, takes: 3, confirmSpend: true, paidConfirmed: true });
  assert.equal(r.status, 200);
  assert.equal(started.pop().paidConfirmed, true);
  r = await run(false, { action: "start", items, paidConfirmed: true });
  assert.equal(r.status, 200);
  assert.equal(started.pop().paidConfirmed, false, "switch off: never a paid night, whatever the body claims");
  r = await run(true, { action: "start", kind: "image", items: [{ prompt: "p" }] });
  assert.equal(started.pop().paidConfirmed, false, "pictures never bill the hosted engine");
  const batchSrc = read("server/batch.js");
  assert.match(batchSrc, /paidConfirmed: paidConfirmed === true,/);
  assert.match(batchSrc, /batchId: r\.id,\n\s+paidConfirmed: r\.paidConfirmed === true,/, "each song of the night carries the night's answer");
});

/* ── the Comfy API run door ─────────────────────────────────────────────── */
test("Comfy API: a run without its own confirmSpend is refused and spends nothing; the mode is the switch", async () => {
  const out = [], spent = [];
  const routes = createRouterRoutes({
    json: (_r, status, body) => out.push({ status, body }), readBody: async (req) => req._body,
    config: { uiPort: 4173, cloudOnly: true }, sameOriginLocalJson,
    secrets: { has: async () => true, set: async () => ({}), clear: async () => {}, status: async () => ({ set: true }) },
    client: { listModels: async () => [] }, catalog: {},
    jobs: { outDir: tmp, add: async (r) => { spent.push(r); return { id: "x" }; } },
  });
  const hit = async (body) => { await routes({ method: "POST", headers: PAGE, _body: body }, {}, new URL("http://x/api/router/run")); return out.pop(); };
  const model = "bfl/flux-2-pro";
  for (const confirmSpend of [undefined, false, "true", 1]) {
    const r = await hit({ model, raw: { prompt: "p" }, ...(confirmSpend === undefined ? {} : { confirmSpend }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "confirm-spend");
  }
  assert.equal(spent.length, 0);
  assert.equal((await hit({ model, raw: { prompt: "p" }, confirmSpend: true })).status, 200);
  assert.equal(spent.length, 1);
  assert.match(INDEX, /const routerRoutes = config\.cloudOnly \? createRouterRoutes\(/, "Full Studio mounts no door that spends Comfy credits");
});

/* ── the page asks, then sends ──────────────────────────────────────────── */
test("the page sets confirmSpend only after the person said yes", () => {
  const app = read("web/app.js");
  const sets = [...app.matchAll(/confirmSpend: true/g)].map((m) => m.index);
  assert.ok(sets.length >= 4, `found ${sets.length}`);
  for (const at of sets) {
    const before = app.slice(Math.max(0, at - 1500), at);
    assert.match(before, /await confirmPaidRun\(/, `confirmSpend at ${app.slice(0, at).split("\n").length} follows a confirmPaidRun`);
  }
  assert.match(app, /if \(j\.reason === "confirm-spend" && typeof confirmPaidRun === "function"\) \{\n\s+if \(!\(await confirmPaidRun\(j, \{ takes: n \}\)\)\) return;/,
    "Create: a no is a stop, not a failSay");
  const sw = read("web/cloudswitch.js");
  assert.match(sw, /if \(reply\?\.reason !== "confirm-spend"\) return false;/);
  assert.match(sw, /return !!\(await appConfirm\(`\$\{reply\.error\}\$\{more\}`/, "the question is the server's sentence");
  assert.doesNotMatch(sw, /confirmSpend/, "the card itself never sends a paid yes");
  const router = read("web/router.js");
  const ask = router.indexOf('{ title: "Use Comfy credits?", ok: "Run", cancel: "Not now" });');
  assert.ok(ask > 0 && router.indexOf("if (!ok) return;", ask) < router.indexOf("payload.confirmSpend = true;", ask));
  assert.equal(router.split("confirmSpend = true").length, 2, "one place on the Comfy page, after its question");
  const html = read("web/index.html");
  assert.match(html, /<p class="pcard-sub" id="rtKeySub">Kept on this computer and sent only to Comfy\.<\/p>/,
    "the Comfy key card does not claim encryption before it knows");
  assert.match(router, /: k\.encrypted \? "Kept encrypted on this computer and sent only to Comfy\."/);
  /* The Hosted key's save message is the saved key's own sentence, so it
   * cannot contradict the card when DPAPI fails. */
  assert.match(app, /alert\(`Saved, but not encrypted\. \$\{r\.status\?\.protection \|\| /);
  assert.doesNotMatch(app, /no OS keystore available/);
  assert.match(app, /"Off: nothing is billed"/, "off is about money, not a GPU the person may not have");
  /* The picker's key place is the server's words, not a copy. */
  assert.match(app, /lead: `Paste your own key in \$\{c\.keyPlace \|\| "Settings"\}/);
  assert.match(INDEX, /keyPlace: HOSTED_KEY_PLACE,/);
  assert.match(read("server/apiEngine.js"), /import \{ CLOUD_CARD_PLACE, HOSTED_KEY_PLACE \} from "\.\/cloud-switch\.js";/);
  /* The Agent page shows a key another copy saved, as the other cards do. */
  assert.match(read("server/llm/providers.js"), /said: st\?\.said \|\| null, savedHere: st\?\.savedHere \?\? null/);
  assert.match(read("web/agent.js"), /const keyWords = \(p\.said \|\| `Key \$\{p\.hint\}`\)/);
});

/* ── the tools ──────────────────────────────────────────────────────────── */
test("make_song and overnight_start forward the paid yes only as exactly true", () => {
  const song = TOOLS.find((t) => t.name === "make_song");
  assert.equal(song.inputSchema.properties.confirm_spend.type, "boolean");
  assert.match(song.inputSchema.properties.confirm_spend.description, /ONLY after the person agreed to pay for THIS song/);
  assert.match(String(song.run), /confirmSpend: a\.confirm_spend === true \? true : undefined/);
  const night = TOOLS.find((t) => t.name === "overnight_start");
  assert.equal(night.inputSchema.properties.confirm_spend.type, "boolean");
  assert.match(String(night.run), /confirmSpend: a\.confirm_spend === true \? true : undefined/);
});

test("cloud_status reads, set_cloud sets through the same-origin door, and the chat may only read", async () => {
  const calls = [];
  const tools = cloudTools(async (method, route, body) => { calls.push({ method, route, body }); return { ok: true }; });
  const [status, set] = ["cloud_status", "set_cloud"].map((n) => tools.find((t) => t.name === n));
  await status.run({});
  await set.run({ on: true, monthly_cap_usd: 5 });
  await assert.rejects(set.run({}), /Say what to change/);
  assert.deepEqual(calls, [
    { method: "GET", route: "/api/cloud", body: undefined },
    { method: "POST", route: "/api/cloud", body: { action: "set", on: true, monthlyCapUsd: 5 } },
  ]);
  assert.equal(ROUTABLE.cloud_status, null, "the read is free in the chat");
  assert.ok(!("set_cloud" in ROUTABLE), "the set is not routable");
  assert.match(WITHHELD.set_cloud, /PAID/, "and is withheld, with the reason");
  assert.ok(TOOLS.some((t) => t.name === "cloud_status") && TOOLS.some((t) => t.name === "set_cloud"), "both are on the MCP surface");
});

test("POST /api/cloud: another website changes nothing; the page's own JSON switches, caps and saves", async () => {
  const out = [], configured = [], saved = [], forgot = [];
  const routes = cloud.createCloudRoutes({
    json: (_r, status, body) => out.push({ status, body }),
    readBody: async (req, max) => { if (req._big) { const e = new Error("big"); e.tooBig = true; throw e; } assert.ok(max > 0 && max <= 1048576, "capped before parse"); return req._body; },
    config: { uiPort: 4173, cloudOnly: false, musicOnly: false }, sameOriginLocalJson,
    hosted: {
      status: async () => ({ enabled: false, provider: "fal", providers: { fal: { label: "fal.ai — MiniMax Music 3", usdPerSecond: 0.002, verified: true } }, spend: { capUsd: 20, spentUsd: 0 }, key: KEY }),
      configure: async (p) => { configured.push(p); },
    },
    comfy: {
      status: async () => ({ set: false }),
      save: async (k) => { saved.push(k); return k.length < 16 ? { error: "That does not look like a Comfy API key." } : { method: "dpapi" }; },
      forget: async () => { forgot.push(1); },
    },
  });
  const hit = async (headers, body, extra = {}) => { await routes({ method: body ? "POST" : "GET", headers, _body: body, ...extra }, {}, new URL("http://x/api/cloud")); return out.pop(); };

  const st = await hit(PAGE);
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.order, ["friend", "own-key"]);
  assert.equal(st.body.hosted.on, false);
  assert.match(st.body.hosted.keySaid, /^Using the key …abcd saved on 21 Sep 2026 by another copy of Studio on this Windows account/);
  assert.match(st.body.comfy.note, /outside a music video\. Music videos are made in Full Studio's Music video screen/);
  assert.ok(!JSON.stringify(st.body).includes("value"), "no key value in the status");
  assert.equal((await hit({ host: "rebind.evil.example:4173" })).status, 403, "a rebound page reads nothing");

  for (const body of [{ action: "set", on: true, monthlyCapUsd: 1000 }, { action: "comfyKey", key: "attacker-key-0123456789" }, { action: "forgetComfyKey" }]) {
    assert.equal((await hit(FOREIGN, body)).status, 403, body.action);
  }
  assert.deepEqual([configured, saved, forgot], [[], [], []], "a foreign page switched, saved and forgot nothing");

  assert.equal((await hit(PAGE, { action: "set", on: true, monthlyCapUsd: 7 })).status, 200);
  assert.deepEqual(configured.pop(), { enabled: true, monthlyCapUsd: 7 });
  assert.equal((await hit(PAGE, { action: "set" })).status, 400, "a set that says nothing changes nothing");
  assert.equal((await hit(PAGE, { action: "comfyKey", key: "short" })).status, 400);
  assert.equal((await hit(PAGE, { action: "comfyKey", key: "comfyui-0123456789abcdef" })).status, 200);
  assert.equal((await hit(PAGE, { action: "forgetComfyKey" })).status, 200);
  assert.equal(forgot.length, 1);
  assert.equal((await hit(PAGE, { action: "spend" })).status, 400);
  assert.equal((await hit(PAGE, {}, { _big: true })).status, 413);
  assert.throws(() => cloud.createCloudRoutes({ json() {}, readBody() {}, config: {}, hosted: {}, comfy: {} }), /sameOriginLocalJson/);
  /* ONE WRITER: /api/cloud, /api/apimode and the Music picker's model action
   * all switch the hosted engine through applyApiConfig, and nothing else in
   * index.js assigns the switch. */
  assert.match(INDEX, /configure: \(patch\) => applyApiConfig\(patch\)/, "the switch has one writer");
  assert.match(INDEX, /if \(b\.action === "config"\) return json\(res, 200, await applyApiConfig\(b\)\);/, "shared with POST /api/apimode");
  assert.match(INDEX, /await applyApiConfig\(\{ enabled: want, \.\.\.\(want \? \{ provider: choice\.api \} : \{\}\) \}\);/, "and with the Music picker");
  assert.doesNotMatch(INDEX, /config\.api\.(enabled|provider|monthlyCapUsd)\s*=[^=]/, "nothing else assigns the switch");
  assert.equal(INDEX.split("Object.assign(config.api,").length, 2);
  const music = INDEX.indexOf('if (p === "/api/music" && req.method === "POST") {');
  assert.match(INDEX.slice(music, INDEX.indexOf("const b = await readBody(req);", music)), /if \(!sameOriginLocalJson\(req\)\) return json\(res, 403/,
    "the picker door is same-origin, asked before its body is read");
});

test("GET /api/cloud in each launch mode: the hosted engine says where it runs; the Comfy note fits the mode", async () => {
  const configured = [];
  const mk = (modes) => {
    const out = [];
    const routes = cloud.createCloudRoutes({
      json: (_r, status, body) => out.push({ status, body }), readBody: async (req) => req._body,
      config: { uiPort: 4173, ...modes }, sameOriginLocalJson,
      hosted: { status: async () => ({ enabled: false, provider: "fal", providers: {}, spend: {} }), configure: async (p) => { configured.push(p); } },
      comfy: { status: async () => ({ set: false }), save: async () => ({}), forget: async () => {} },
    });
    const get = async () => { await routes({ method: "GET", headers: PAGE }, {}, new URL("http://x/api/cloud")); return out.pop().body; };
    get.set = async (body) => { await routes({ method: "POST", headers: PAGE, _body: { action: "set", ...body } }, {}, new URL("http://x/api/cloud")); return out.pop(); };
    return get;
  };
  /* set_cloud cannot switch it ON where it cannot make a song; off and the cap still work. */
  for (const modes of [{ musicOnly: true }, { cloudOnly: true }]) {
    const r = await mk(modes).set({ on: true });
    assert.equal(r.status, 409, JSON.stringify(modes));
    assert.equal(r.body.reason, "not-this-mode");
    assert.equal((await mk(modes).set({ on: false, monthlyCapUsd: 3 })).status, 200);
  }
  assert.deepEqual(configured, [{ enabled: false, monthlyCapUsd: 3 }, { enabled: false, monthlyCapUsd: 3 }], "only the allowed changes were written");
  const full = await (mk({}))();
  assert.equal(full.hosted.runsHere, true);
  assert.equal(full.hosted.note, null);
  assert.equal(full.friend.available, true);
  assert.match(full.comfy.note, /^Comfy API clips are made in the launcher's Use Comfy API mode, outside a music video\. Music videos are made in Full Studio's Music video screen; without a strong card, ask a friend on Collab/);
  const musicOnly = await (mk({ musicOnly: true }))();
  assert.equal(musicOnly.hosted.runsHere, false, "Music only refuses MiniMax, so the hosted engine cannot run there");
  assert.match(musicOnly.hosted.note, /makes songs in Full Studio only/);
  assert.equal(musicOnly.friend.available, false);
  const comfyOnly = await (mk({ cloudOnly: true }))();
  assert.equal(comfyOnly.hosted.runsHere, false);
  assert.match(comfyOnly.comfy.note, /^Music videos need Full Studio: this mode has no Music, Music video or Collab screen\. Without a strong card, start Full Studio/);
  /* The page shows those notes and keeps a switch it cannot use from being turned on. */
  const sw = read("web/cloudswitch.js");
  assert.match(sw, /say\("cloudHostedNote", d\.hosted\?\.note\);/);
  assert.match(sw, /\$\("apiEnabled"\)\.disabled = d\.hosted\?\.runsHere === false && !d\.hosted\?\.on;/);
  assert.match(sw, /\$\("cloudComfyNote"\)\.textContent = d\.comfy\.note;/);
  assert.match(sw, /\$\("cloudFriendLimits"\)\.textContent = friend\.limits/);
  assert.match(read("web/router.js"), /if \(d\?\.comfy\?\.note && \$\("rtNoMv"\)\) \$\("rtNoMv"\)\.textContent = d\.comfy\.note;/, "the Comfy page paints the same sentence");
});

test("GET /api/apimode answers only this machine's own host: key status names where the key file is", async () => {
  const at = INDEX.indexOf('if (p === "/api/apimode" && req.method !== "POST") {');
  const head = INDEX.slice(at + 'if (p === "/api/apimode" && req.method !== "POST") {'.length, INDEX.indexOf("const st = await apiStatus();", at));
  const run = new AsyncFunction("req", "res", "json", "localUiHost", "config", `${head}\nreturn { passed: true };`);
  const json = (_r, status, body) => ({ status, body });
  for (const host of ["rebind.evil.example:4173", "192.168.1.9:4173", "127.0.0.1:9999", ""]) {
    assert.equal((await run({ headers: { host } }, null, json, cloud.localUiHost, { uiPort: 4173 }))?.status, 403, host || "no Host");
  }
  for (const host of ["127.0.0.1:4173", "localhost:4173", "[::1]:4173"]) {
    assert.deepEqual(await run({ headers: { host } }, null, json, cloud.localUiHost, { uiPort: 4173 }), { passed: true }, host);
  }
});

/* ── own key only ───────────────────────────────────────────────────────── */
test("no key is read from the environment unless it is an AIPLAY_ variable the person set", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".") || e === "__pycache__") continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|cjs|py|ps1)$/.test(e)) files.push(p);
    }
  };
  for (const d of ["server", "scripts", "launcher", "installer"]) walk(path.join(ROOT, d));
  assert.ok(files.length > 100, `read ${files.length} files`);
  const names = new Set();
  const re = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])|os\.environ(?:\.get\(|\[)\s*["']([A-Za-z0-9_]+)["']|\$env:([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(re)) names.add(m[1] || m[2] || m[3] || m[4]);
  assert.ok(names.has("AIPLAY_APPDATA") && names.has("AIPLAY_FAL_BASE"), "the sweep sees the variables it should");
  const keyish = [...names].filter((n) => /KEY|TOKEN|SECRET|PASSW|AUTH/i.test(n) && !/^AIPLAY_/.test(n));
  assert.deepEqual(keyish, [], `a key read from a variable Studio does not own: ${keyish.join(", ")}`);
});

test("a key another copy of Studio saved is shown as that; 'encrypted' only when DPAPI did it", async () => {
  writeFileSync(path.join(tmp, "secrets.json"), JSON.stringify({
    FAL_KEY: { method: "file-permissions", value: "plain-key-wxyz", hint: "wxyz", at: Date.parse("2026-09-21T10:00:00Z"), from: path.join(tmp, "another-studio") },
    comfyRouterKey: { method: "file-permissions", value: "k", hint: "1234", at: Date.parse("2026-09-20T10:00:00Z") },
  }));
  const k = await secretStatus("FAL_KEY");
  assert.equal(k.encrypted, false);
  assert.equal(k.savedHere, false);
  assert.match(k.protection, /^Not encrypted: it is stored as plain text in .*secrets\.json/);
  assert.match(k.said, /^Using the key …wxyz saved on 21 Sep 2026 by another copy of Studio on this Windows account \(another-studio\)\.$/);
  /* The status reaches the page, cloud_status and the in-app chat's model:
   * the other copy by its folder NAME, and no path that names the Windows user. */
  assert.equal(k.savedBy, "another-studio");
  for (const field of ["where", "protection", "said", "savedBy"]) {
    assert.ok(!String(k[field]).toLowerCase().includes(os.homedir().toLowerCase()), `${field} names no home folder: ${k[field]}`);
  }
  assert.match(k.where, /secrets\.json$/);
  const old = await secretStatus("comfyRouterKey");
  assert.equal(old.savedHere, null);
  assert.match(old.said, /saved on 20 Sep 2026 \(before Studio noted which copy saved it\)/);
  assert.equal((await secretStatus("nothing")).said, "No key saved.");
  assert.match(read("server/secrets.js"), /store\[name\] = \{ method, value: payload, hint: v\.slice\(-4\), at: Date\.now\(\), from: STUDIO_ROOT \};/,
    "every save notes which Studio saved it");
});
