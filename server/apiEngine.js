/**
 * API mode — generate music through a hosted MiniMax Music 3 instead of a GPU.
 *
 * WHY. The local engine needs 16 GB of VRAM, a ComfyUI install and ~12 GB of
 * weights. That rules out most laptops. The rest of Studio — the library, the
 * covers, the timeline editor, karaoke, overnight batching — has nothing to do
 * with a GPU, and it is the majority of the app. API mode lets someone use all
 * of that on hardware that could never run the model, and moves to the local
 * engine later with the same library and the same files.
 *
 * WHAT IT COSTS YOU, HONESTLY. Two things, and both are in the UI rather than
 * buried here:
 *
 *  1. MONEY. The local engine costs electricity. This one bills per second of
 *     output. Overnight runs are Studio's best feature and would be its worst
 *     bill — twenty ideas at three takes of three minutes is around twenty
 *     dollars. Hence the ledger and the hard cap below, which are not optional
 *     polish; without them someone queues 200 songs and finds out afterwards.
 *
 *  2. AUDIO REFERENCE. Gone. Studio's most distinctive feature encodes a real
 *     recording into the model's own latent and partially denoises it. Every
 *     hosted endpoint is text-in, audio-out — no latent input, no denoise. This
 *     is not an oversight to route around; it is the shape of the API. The UI
 *     disables the control and says why rather than failing at submit time.
 *
 * KEYS. Never stored here and never held in this module longer than a request.
 * They live DPAPI-encrypted via server/secrets.js and are read per call. Studio
 * talks to the provider DIRECTLY from the user's machine — nothing is proxied
 * through any AIPLAY server, so the transaction is between the user and the
 * provider they chose, and there is no place in the middle for keys to pool.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getSecret } from "./secrets.js";

const LEDGER = path.join(config.paths.appData, "spend.json");

/* ─────────────────────────────────────────────────────────────── providers */

/**
 * Each provider is: how to authenticate, how to submit, how to wait, and how to
 * find the audio in whatever it returns. Kept declarative so a new one is a
 * table entry rather than a new code path.
 *
 * ⚠ VERIFICATION STATUS is recorded per provider on purpose. `fal` is built from
 * its published schema. `minimax` is built from MiniMax's own platform docs and
 * has NOT been exercised against a live key here — it is marked as such in the
 * UI rather than presented as equally proven, because "we wrote the adapter" and
 * "we watched it work" are different claims.
 */
/**
 * Where each provider lives. Overridable so the engine can be pointed at a local
 * mock — the whole submit/poll/download/ledger path was otherwise untestable
 * without a real key and real money, which meant it shipped unexercised. Also
 * lets anyone behind a corporate proxy or a self-hosted relay redirect it.
 */
const BASE = {
  fal: process.env.AIPLAY_FAL_BASE || "https://queue.fal.run",
  minimax: process.env.AIPLAY_MINIMAX_BASE || "https://api.minimax.io",
};

export const PROVIDERS = {
  fal: {
    label: "fal.ai — MiniMax Music 3",
    verified: true,
    keyName: "FAL_KEY",
    keyHelp: "From fal.ai → Keys. Looks like a long id:secret pair.",
    signup: "https://fal.ai/models/minimax/music-3",
    // $0.002 per second of generated audio, per fal's published price.
    usdPerSecond: 0.002,
    submit: async (key, { caption, lyrics, seed, seconds }) => {
      const r = await fetch(`${BASE.fal}/fal-ai/minimax/music-3`, {
        method: "POST",
        headers: { "Authorization": `Key ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: caption,
          lyrics,
          ...(Number.isFinite(seed) ? { seed } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(providerError(r.status, d));
      return { pollUrl: d.status_url || d.response_url, resultUrl: d.response_url };
    },
    poll: async (key, { pollUrl, resultUrl }) => {
      const r = await fetch(pollUrl, { headers: { "Authorization": `Key ${key}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(providerError(r.status, d));
      if (d.status === "COMPLETED") {
        const rr = await fetch(resultUrl, { headers: { "Authorization": `Key ${key}` } });
        const res = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error(providerError(rr.status, res));
        const url = res?.audio?.url || res?.audio_url || res?.output?.url;
        if (!url) throw new Error("The provider reported success but returned no audio URL.");
        return { done: true, url };
      }
      if (d.status === "FAILED" || d.status === "ERROR") {
        throw new Error(d.error || "The provider reported the job failed.");
      }
      /* IN_QUEUE and IN_PROGRESS are different things and the user should be
       * told which. Inferring "rendering" from a MISSING queue position, as the
       * first version did, meant the status went straight from "queued (1
       * ahead)" to "downloading" — so the minute or so actually spent generating
       * looked like a stall. Reported by the mock-provider test, which is the
       * only reason it was noticed before someone sat through it. */
      return { done: false, queue: d.status === "IN_QUEUE" ? d.queue_position : null };
    },
  },

  /* ⚠ EXPERIMENTAL, and gated in the UI behind an explicit opt-in.
   *
   * Written from MiniMax's platform docs and never run against a live key —
   * unlike fal, whose contract was exercised end-to-end against a mock built
   * from its published schema (scripts/test_apimode.mjs). The endpoint shape,
   * the auth header and the response fields are all THEIR DOCUMENTATION'S
   * CLAIMS, not observations. Kept rather than deleted because the official
   * platform is the cheaper direct route once someone confirms it — the first
   * user with a real key either validates this adapter in one render or
   * disproves it in one error, and either outcome is worth having. */
  minimax: {
    label: "MiniMax (official) — Music 3",
    verified: false,
    experimental: true,
    keyName: "MINIMAX_API_KEY",
    keyHelp: "From the MiniMax platform console. Some accounts also need a GroupId.",
    signup: "https://www.minimax.io/platform",
    usdPerSecond: 0.002,
    submit: async (key, { caption, lyrics }) => {
      const r = await fetch(`${BASE.minimax}/v1/music_generation`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "music-3", prompt: caption, lyrics }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(providerError(r.status, d));
      // Some responses are synchronous, some hand back a task id.
      const url = d?.data?.audio || d?.audio_url;
      if (url) return { immediate: url };
      const id = d?.task_id || d?.data?.task_id;
      if (!id) throw new Error("Could not find an audio URL or a task id in the response.");
      return { taskId: id };
    },
    poll: async (key, { taskId, immediate }) => {
      if (immediate) return { done: true, url: immediate };
      const r = await fetch(`${BASE.minimax}/v1/query/music_generation?task_id=${encodeURIComponent(taskId)}`,
        { headers: { "Authorization": `Bearer ${key}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(providerError(r.status, d));
      const url = d?.data?.audio || d?.audio_url;
      if (url) return { done: true, url };
      if (d?.status === "failed") throw new Error(d?.message || "The provider reported the job failed.");
      return { done: false };
    },
  },
};

/**
 * Turn a provider failure into something a person can act on.
 *
 * The default here would be to surface whatever JSON came back, and that is how
 * you end up printing someone's key into a log or a screenshot when an endpoint
 * echoes the request. Status codes carry the actionable part anyway.
 */
function providerError(status, body) {
  const detail = typeof body?.detail === "string" ? body.detail
    : typeof body?.message === "string" ? body.message
    : typeof body?.error === "string" ? body.error : "";
  const safe = detail.slice(0, 200).replace(/[A-Za-z0-9_-]{24,}/g, "…");
  if (status === 401 || status === 403) return "The provider rejected your key. Check it in Settings.";
  if (status === 402) return "The provider says the account has no credit.";
  if (status === 429) return "Rate limited by the provider — it will need a moment.";
  if (status >= 500) return `The provider had a server error (${status}).${safe ? " " + safe : ""}`;
  return `The provider refused the request (${status}).${safe ? " " + safe : ""}`;
}

/* ─────────────────────────────────────────────────────────── the spend ledger */

async function readLedger() {
  try { return JSON.parse(await readFile(LEDGER, "utf8")); } catch { return { entries: [] }; }
}

const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

/** What has been spent this calendar month, and what remains under the cap. */
export async function spendSummary() {
  const led = await readLedger();
  const m = monthKey();
  const entries = led.entries || [];
  const month = entries.filter((e) => monthKey(e.at) === m);
  const spent = month.reduce((n, e) => n + (e.usd || 0), 0);
  const cap = Number(config.api?.monthlyCapUsd ?? 20);
  return {
    month: m,
    spentUsd: Math.round(spent * 1000) / 1000,
    capUsd: cap,
    remainingUsd: Math.max(0, Math.round((cap - spent) * 1000) / 1000),
    tracks: month.length,
    overCap: spent >= cap,
  };
}

async function record(usd, meta) {
  const led = await readLedger();
  led.entries = (led.entries || []).concat([{ at: Date.now(), usd, ...meta }]);
  // Keep a year. The ledger is for "what am I spending", not accounting.
  const cutoff = Date.now() - 366 * 864e5;
  led.entries = led.entries.filter((e) => e.at >= cutoff);
  await mkdir(path.dirname(LEDGER), { recursive: true });
  await writeFile(LEDGER, JSON.stringify(led, null, 2), "utf8");
}

/** What a render will cost, before it is started. */
export function estimateUsd(seconds, providerName = config.api?.provider) {
  const p = PROVIDERS[providerName] || PROVIDERS.fal;
  return Math.round(p.usdPerSecond * Math.max(1, seconds || 0) * 1000) / 1000;
}

/* ────────────────────────────────────────────────────────────── generation */

/**
 * Run one song through the hosted engine.
 *
 * Emits progress through `onStage` so the existing UI — which was written for a
 * websocket carrying ComfyUI's step counts — has something honest to show. There
 * are no steps to report here: the provider gives a queue position at best, so
 * saying "queued" and "rendering" is the truthful version of a progress bar
 * rather than an invented percentage.
 */
export async function generateViaApi(spec, { onStage = () => {}, signal } = {}) {
  const providerName = config.api?.provider || "fal";
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown provider "${providerName}".`);

  const key = await getSecret(provider.keyName);
  if (!key) throw new Error(`No ${provider.label} key is saved. Add one in Settings → API mode.`);

  // The cap is checked HERE, immediately before spending, not only in the UI.
  // An overnight batch queues once and runs for hours; a check that happened at
  // queue time would authorise the whole night in one go.
  const summary = await spendSummary();
  const estimate = estimateUsd(spec.maxDuration || 60, providerName);
  if (summary.spentUsd + estimate > summary.capUsd) {
    throw new Error(
      `This would put you over your monthly cap ($${summary.capUsd}). ` +
      `Spent so far: $${summary.spentUsd}. Raise the cap in Settings if you meant to.`);
  }

  onStage("queued");
  const handle = await provider.submit(key, {
    caption: spec.caption,
    lyrics: spec.lyrics,
    seed: spec.seed,
    seconds: spec.maxDuration,
  });

  // Poll rather than hold a socket: these take tens of seconds and a dropped
  // websocket mid-render would lose a track that has already been paid for.
  const started = Date.now();
  const deadline = started + (config.api?.timeoutMs ?? 10 * 60_000);
  let url = null;
  for (let i = 0; !url; i++) {
    if (signal?.aborted) throw new Error("Cancelled.");
    if (Date.now() > deadline) throw new Error("The provider did not finish in time.");
    await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 5000));
    const st = await provider.poll(key, handle);
    if (st.done) url = st.url;
    else onStage(st.queue != null ? `queued (${st.queue} ahead)` : "rendering");
  }

  onStage("downloading");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the finished track (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Providers return mp3. Studio's library reads whatever is on disk, so this
  // needs no conversion — it simply is not a FLAC, and the library says so.
  const stem = `api_${Date.now().toString(36)}`;
  const ext = /\.wav(\?|$)/i.test(url) ? "wav" : "mp3";
  const file = `${stem}.${ext}`;
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(path.join(config.outputDir, file), buf);

  const wall = (Date.now() - started) / 1000;
  // Bill on what was ASKED for. Actual duration is not known until the file is
  // probed, and over-reporting a cost is a much kinder failure than under-.
  const usd = estimateUsd(spec.maxDuration || 60, providerName);
  await record(usd, { provider: providerName, file, seconds: spec.maxDuration });

  return { file, bytes: buf.length, seconds: wall, usd };
}

/** Everything the Settings screen needs, with no secrets in it. */
export async function apiStatus() {
  const out = { enabled: !!config.api?.enabled, provider: config.api?.provider || "fal", providers: {} };
  for (const [name, p] of Object.entries(PROVIDERS)) {
    out.providers[name] = {
      label: p.label, verified: p.verified, keyName: p.keyName,
      keyHelp: p.keyHelp, signup: p.signup, usdPerSecond: p.usdPerSecond,
    };
  }
  out.spend = await spendSummary();
  return out;
}
