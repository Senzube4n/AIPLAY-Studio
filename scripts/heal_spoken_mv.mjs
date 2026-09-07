/**
 * Heal Spoken MV's cast drift.
 *
 * Its eight clips were rendered before clip prompts learned to NAME their
 * references, so each scene invented a different narrator — the exact drift
 * `mv_regen_stale` now detects (8/8 stale, reason "unnamed-refs"). This walks
 * them through the ordinary generate_clip route, one at a time, keeping every
 * earlier take so the strip becomes a before/after exhibit.
 *
 * Raw node:http on purpose: fetch gives up after five minutes waiting for
 * headers and a render legitimately answers only when it finishes.
 */
import http from "node:http";

const BASE = "http://127.0.0.1:4173";
const SEGMENTS = ["s1_0", "s1_1", "s1_2", "s1_3", "s1_4", "s1_5", "s1_6", "s1_7"];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function api(body, timeoutMs = 75 * 60e3) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${BASE}/api/mv`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { const d = JSON.parse(buf); d.error ? reject(new Error(d.error)) : resolve(d); }
        catch { reject(new Error(`bad response: ${buf.slice(0, 120)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

const started = Date.now();
let healed = 0;
for (const seg of SEGMENTS) {
  log(`regenerating ${seg} with named references`);
  try {
    const r = await api({ action: "generate_clip", slug: "spoken-mv", segmentId: seg });
    healed++;
    log(`  → ${r.clip} (takes now ${(r.takes || []).length})`);
  } catch (e) {
    log(`  ${seg} failed: ${e.message} — continuing`);
  }
}
try {
  const t = await api({ action: "build_timeline", slug: "spoken-mv" });
  log(`timeline rebuilt: "${t.project}" (${t.scenes} scenes)`);
} catch (e) {
  log(`timeline rebuild failed: ${e.message}`);
}
log(`done: ${healed}/${SEGMENTS.length} healed in ${Math.round((Date.now() - started) / 60000)} min`);
