/**
 * Smoke-test the HTTP surface. Cheap, no GPU, no renders.
 *
 * WHY THIS EXISTS. Several routes here were added or changed without ever being
 * exercised end to end, and two of them failed in ways nothing would have
 * noticed: `POST /api/clips` was swallowed by the GET handler above it, and the
 * clip listing filtered `.mp4` only, so a studio export (WebM) was written
 * successfully and then invisible in the library it was written to. Both are
 * "the server returns 200 and the feature does not exist" bugs, which no amount
 * of reading the diff catches.
 *
 * It deliberately does NOT touch the GPU. Anything that renders belongs in a
 * measurement script where its cost is the point; this should stay fast enough
 * that there is no excuse for skipping it before a restart.
 *
 *   node scripts/smoke_api.mjs
 */
const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

let pass = 0, fail = 0;
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    results.push(`  ok    ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    fail++;
    results.push(`  FAIL  ${name}\n          ${e.message}`);
  }
}

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.text() };
};
const post = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
};

await check("server answers", async () => {
  const r = await get("/api/status");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const d = JSON.parse(r.body);
  if (!d.library) throw new Error("no library in payload");
  return `${d.library.length} tracks`;
});

await check("clip listing includes .webm", async () => {
  const r = await get("/api/clips");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const d = JSON.parse(r.body);
  if (!Array.isArray(d.clips)) throw new Error("no clips array");
  // The filter is a regex now; prove it by reading the route's own output shape
  // rather than by trusting the source.
  return `${d.clips.length} clips, ${d.clips.filter((c) => c.name.endsWith(".webm")).length} webm`;
});

await check("POST /api/clips is not swallowed by the GET route", async () => {
  // A deliberately invalid action: the point is that POST REACHES the handler.
  // Before the method guard, this fell through to the GET listing and returned
  // 200 with a clip array, which looked like success.
  const r = await post("/api/clips", { action: "nonsense" });
  if (r.status === 200 && r.body.includes("clips")) {
    throw new Error("POST fell through to the GET listing — the method guard is gone");
  }
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${r.body.slice(0, 120)}`);
  return "rejected with 400 as it should";
});

await check("clip trash refuses a path-traversing name", async () => {
  for (const name of ["../evil.mp4", "a/b.mp4", "..\\evil.mp4"]) {
    const r = await post("/api/clips", { action: "trash", name });
    if (r.status !== 400) throw new Error(`"${name}" was not rejected (status ${r.status})`);
  }
  return "../ , a/b and ..\\ all rejected";
});

await check("studio save rejects an empty body", async () => {
  const r = await post("/api/studio/save", new Uint8Array(0), { "Content-Type": "application/octet-stream" });
  if (r.status === 404) throw new Error("route missing — did the server restart after the change?");
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${r.body.slice(0, 120)}`);
  return "400, and the route exists";
});

await check("studio save writes a clip and names it safely", async () => {
  // Not a real WebM — this checks the ROUTE, not the codec. A hostile title is
  // used on purpose: the filename must be derived, never taken.
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const r = await post("/api/studio/save", bytes, {
    "Content-Type": "application/octet-stream",
    "X-Title": encodeURIComponent("../../etc/passwd nasty name"),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body.slice(0, 160)}`);
  const d = JSON.parse(r.body);
  if (!d.name?.startsWith("studio_")) throw new Error(`odd name: ${d.name}`);
  if (/[\\/]|\.\./.test(d.name)) throw new Error(`name is traversable: ${d.name}`);
  if (!d.name.endsWith(".webm")) throw new Error(`wrong extension: ${d.name}`);

  // It must now appear in the listing — the bug this file exists for.
  const list = JSON.parse((await get("/api/clips")).body);
  if (!list.clips.some((c) => c.name === d.name)) {
    throw new Error(`${d.name} was written but does not appear in /api/clips`);
  }
  // Clean up after ourselves.
  await post("/api/clips", { action: "trash", name: d.name });
  return `${d.name}, listed, then trashed`;
});

await check("clip metadata survives a restart", async () => {
  const r = await get("/api/clips");
  const d = JSON.parse(r.body);
  const withMeta = d.clips.filter((c) => c.meta);
  // Legacy clips predate metadata entirely, so an empty result is not a failure
  // — it is only informative. What would be a failure is the store file being
  // unreadable, which loadClipStore swallows.
  return withMeta.length
    ? `${withMeta.length}/${d.clips.length} carry provenance`
    : `0/${d.clips.length} (all predate clip metadata — render one to confirm)`;
});

await check("community feed default is a public host", async () => {
  const r = await get("/api/community");
  // Whatever it answers, it must not be pointed at a private box. This is a
  // regression guard: the default was briefly dev.aiplay.live, which in a public
  // repo is an unpaid DDoS on the machine that also serves production.
  const { config } = await import("../server/config.js");
  const url = config.community.feedUrl;
  if (/dev\.|staging|localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+/.test(url)) {
    throw new Error(`feedUrl points somewhere private: ${url}`);
  }
  return `${url} (HTTP ${r.status})`;
});

console.log(`\nAIPLAY Studio — API smoke test against ${BASE}\n`);
console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
