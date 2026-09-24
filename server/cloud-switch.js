/**
 * NO STRONG GRAPHICS CARD? FRIEND FIRST, THEN YOUR OWN KEY.
 *
 * The owner, 2026-09-24: "people should be able to input their own api key
 * dont use existing keys. and we can have peer2peer collab also work in this
 * rather then API we could have friends make their hardware public and i think
 * that should be the first choice".
 *
 * So there is ONE answer to "this PC can't", and it has an order:
 *
 *   1. a friend with a strong card renders for you (Collab: free, a sealed
 *      file each way, nothing connects to anybody);
 *   2. a paid service on a key the person typed into Studio themselves: the
 *      hosted engine (MiniMax Music 3 on fal.ai) in Full Studio, and the
 *      launcher's Use Comfy API mode.
 *
 * The paid half is off by default, every paid run is confirmed on its own, and
 * nothing switches to it behind the person's back. This file holds the order
 * and the sentences (one copy: the Settings card, the Models screen's "no
 * video engine" note, the Welcome page and cloud_status all read them from
 * here), the two gates a paid run must pass, and GET/POST /api/cloud.
 *
 * It imports only server/h3tier.js (the screen's name and the lending clause),
 * which imports nothing. The keys, the spend ledger and the switch's writer are
 * handed in by index.js, so a test can drive every branch with fakes and
 * server/fit.js and the Welcome catalogue can read the sentences without
 * pulling the secret store in with them.
 */

import { H3_MV_SCREEN, LENDING_UNTRIED } from "./h3tier.js";

/** Lending is built, not yet tried between two PCs: every surface that offers
 *  it says so, in these words (the one copy lives in h3tier.js). */
export { LENDING_UNTRIED };

/** The card, in the words on screen. */
export const CLOUD_CARD_PLACE = "Settings → No strong graphics card?";

/** The Collab role a friend who renders for you is given, word for word as
 *  Collab → Friends offers it (web/app.js's role select; the stored value is
 *  `lender`). cloud-confirm_test.js fails when the page's option and this
 *  differ, so the Settings card never names a role that is not there. */
export const LENDER_ROLE_LABEL = "lending friend: we render single scenes for each other";

/** The order, as data. `paid` decides nothing on its own; it is what the page
 *  and an agent say beside each way. */
export const NO_STRONG_CARD = [
  {
    id: "friend",
    title: "Ask a friend with a strong card to render for you",
    where: "Collab",
    view: "collab",
    paid: false,
    /* ONE sentence: what it is and the button to press. Everything else is in
     * `limits`, which the card keeps behind "More". */
    how: `Free: a friend with a strong card renders your music video's scenes on their PC (${LENDING_UNTRIED}); `
      + `press Ask friend beside a scene on ${H3_MV_SCREEN} → Video clips and send them the sealed file it makes.`,
    limits: "First add each other once on Collab → Friends: swap key cards, read the twelve words to "
      + `each other, and make each other a "${LENDER_ROLE_LABEL}". Both of you run `
      + "Full Studio. Nothing connects to anybody: you pass the file on however you already send files, "
      + "and your friend sends the finished clip back as a file for you to look at before you keep it; "
      + "Keep it files it onto its scene, even one you never rendered. "
      + "It lends video scenes, not songs, one scene per sealed file, rendered on your friend's card without "
      + "your song under it, so keep singing close-ups for a card that has your song.",
  },
  {
    id: "own-key",
    title: "Or pay for a service with your own key",
    where: CLOUD_CARD_PLACE,
    view: "settings",
    paid: true,
    how: "Off until you switch it on. You paste a key you made yourself at the provider: Studio uses "
      + "only a key typed into Studio on this Windows account, never one from another program or an "
      + "environment variable, and the card says when it was saved and by which copy of Studio. Every "
      + "paid run asks first and says what it costs, and nothing switches to a paid service behind "
      + "your back.",
    limits: "The hosted engine makes songs (MiniMax Music 3 on fal.ai). The launcher's Use Comfy API "
      + "mode makes pictures, clips, sound and 3D on Comfy credits, but it has no Music, Music video or "
      + "Collab screen, so a music video still needs Full Studio.",
  },
];

/** The one-line form, for places with room for a sentence and not a card. */
export const NO_STRONG_CARD_LINE =
  `Ask a friend with a strong card to render for you first (Collab, free; ${LENDING_UNTRIED}). `
  + `After that, a paid service on your own key (${CLOUD_CARD_PLACE}).`;

/** The same answer for the video slot (the Models screen's "No video engine"
 *  note). The paid half is said as what it really is there: Full Studio's
 *  hosted engine makes songs, not clips, and the Comfy API's clips are made in
 *  another launch mode and cannot reach a music video's scenes. */
export const NO_STRONG_CARD_VIDEO_LINE =
  `Ask a friend with a strong card to render your music video's scenes for you first (Collab, free; ${LENDING_UNTRIED}). `
  + "A paid alternative on your own key makes clips in the launcher's Use Comfy API mode, outside a "
  + `music video (${CLOUD_CARD_PLACE}).`;

/** Where the person types the hosted engine's key, in the words on screen. */
export const HOSTED_KEY_PLACE = `${CLOUD_CARD_PLACE} → Hosted engine`;

/**
 * Would this music job bill the hosted engine? The same rule JobRunner routes
 * by (server/jobs.js #pump): the switch is on, the job is MiniMax Music 3 (or
 * names no engine, which the runner treats as MiniMax), and it is not a job
 * that only the local engine can do.
 */
export function hostedWouldBill({ apiEnabled, engine, requiresLocal = false } = {}) {
  return !!apiEnabled && !requiresLocal && (engine == null || engine === "" || engine === "minimax-music3");
}

/** A paid run's own confirmation: exactly `true`, never truthy. */
export const spendConfirmed = (body) => body?.confirmSpend === true;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "21 Sep 2026". Written out rather than locale-formatted so the server and
 *  every browser say the same date. */
export function dayOf(at) {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : null;
}

/**
 * The sentence a saved key is shown with. A key saved by another copy of
 * Studio on this Windows account is the person's own, and it is still SHOWN
 * rather than silently reused: when, which copy, how it is kept.
 */
export function keySentence(k, { what = "key" } = {}) {
  if (!k?.set) return `No ${what} saved.`;
  const when = k.savedAt ? ` saved on ${dayOf(k.savedAt)}` : "";
  if (k.usable === false) {
    return `A ${what}${when} is on this computer, but it cannot be read under this Windows account or on this PC. Paste it again.`;
  }
  const who = k.savedHere === false
    ? ` by another copy of Studio on this Windows account${k.savedBy ? ` (${k.savedBy})` : ""}`
    : k.savedHere == null && k.savedAt ? " (before Studio noted which copy saved it)" : "";
  return `Using the ${what} ${k.hint || ""}${when}${who}.`.replace(/\s+/g, " ").replace(" .", ".");
}

const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
/* Whole seconds first: 179.6 s is "3:00", never "2:60". */
const mmss = (s) => {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * The refusal a paid song gets without its own confirmation, and the words
 * the confirmation shows. `quote` is what index.js read: provider label, the
 * key's status, the estimate and the month's spend. `songs` > 1 for a batch.
 */
export function paidRefusal(quote, { songs = 1, what = "song" } = {}) {
  const q = quote || {};
  const n = Math.max(1, Math.round(songs) || 1);
  if (!q.key?.set || q.key.usable === false) {
    return {
      status: 400,
      body: {
        error: `The hosted engine needs your own ${q.name || "provider"} key and none is ${q.key?.set ? "readable here" : "saved"}. `
          + `Add it in ${HOSTED_KEY_PLACE}, or pick a music model that runs on this PC. Nothing was sent.`,
        reason: "needs-key",
      },
    };
  }
  const each = Number(q.usd) || 0;
  const total = each * n;
  const spend = q.spend || {};
  const head = n > 1
    ? `This would render ${n} ${what}s on the paid hosted engine (${q.label || "hosted"}), about ${money(each)} each, about ${money(total)} in all`
    : `This ${what} runs on the paid hosted engine (${q.label || "hosted"}), about ${money(each)} for up to ${mmss(q.seconds || 0)}`;
  const key = keySentence(q.key).replace(/^Using the key/, "billed to your key").replace(/\.$/, "");
  const month = Number.isFinite(spend.capUsd)
    ? ` ${money(spend.spentUsd)} of your ${money(spend.capUsd)} monthly cap is spent.` : "";
  return {
    status: 409,
    body: {
      error: `${head}, ${key}.${month} Nothing has been sent yet.`,
      reason: "confirm-spend",
      paid: {
        provider: q.provider || null, label: q.label || null, usdEach: each, usdTotal: Math.round(total * 1000) / 1000,
        runs: n, seconds: q.seconds || null, key: q.key.hint || null, keySavedAt: q.key.savedAt || null,
        spentUsd: spend.spentUsd ?? null, capUsd: spend.capUsd ?? null,
      },
      how: "Confirm it on the page that asked, or send the request again with confirmSpend: true "
        + "(make_song: confirm_spend) once the person has agreed to pay for it.",
    },
  };
}

/** This machine, on the UI port: the one Host a key's status is shown to. A
 *  page on a rebound DNS name gets nothing (GET /api/cloud, GET /api/apimode). */
export function localUiHost(req, uiPort) {
  return [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`, `[::1]:${uiPort}`].includes(String(req?.headers?.host || ""));
}

/**
 * GET /api/cloud — the order, the paid switch and both keys, never a key.
 * POST /api/cloud — {action:"set", on, monthlyCapUsd, provider} (the switch,
 * through the same writer as POST /api/apimode), {action:"comfyKey", key}
 * (checked with Comfy's one free call first) and {action:"forgetComfyKey"}.
 *
 * Every POST is sameOriginLocalJson: another website must not switch a paid
 * service on, raise its cap or swap in its own key.
 */
export function createCloudRoutes({ json, readBody, config, sameOriginLocalJson, hosted, comfy }) {
  if (typeof sameOriginLocalJson !== "function") throw new Error("createCloudRoutes needs index.js sameOriginLocalJson: a paid switch without it is open to any website.");
  const MAX_BODY = 64 * 1024;

  async function status() {
    const h = await hosted.status();
    const ck = await comfy.status();
    const modes = { full: !config.cloudOnly && !config.musicOnly, musicOnly: !!config.musicOnly, cloudOnly: !!config.cloudOnly };
    return {
      order: NO_STRONG_CARD.map((w) => w.id),
      ways: NO_STRONG_CARD,
      line: NO_STRONG_CARD_LINE,
      friend: {
        available: modes.full,
        note: modes.full ? null : "Collab runs in Full Studio. Start Full Studio from the launcher to ask a friend.",
      },
      hosted: {
        on: !!h.enabled,
        what: "songs: MiniMax Music 3",
        /* Only Full Studio's Music screen sends a song to it: Music only runs
         * YuE2 and refuses MiniMax, and Use Comfy API has no Music screen. */
        runsHere: modes.full,
        note: modes.full ? null
          : "The hosted engine makes songs in Full Studio only. Start Full Studio from the launcher to use it; "
            + "switching it on here would bill nothing and make nothing.",
        provider: h.provider,
        label: h.providers?.[h.provider]?.label || h.provider,
        usdPerSecond: h.providers?.[h.provider]?.usdPerSecond ?? null,
        verified: h.providers?.[h.provider]?.verified ?? null,
        capUsd: h.spend?.capUsd ?? null,
        spend: h.spend || null,
        key: h.key || { set: false },
        keySaid: keySentence(h.key),
        where: HOSTED_KEY_PLACE,
        confirmEveryRun: true,
      },
      comfy: {
        what: "pictures, clips, sound, 3D and text on Comfy credits",
        runsHere: modes.cloudOnly,
        where: "the launcher's Use Comfy API mode",
        key: ck || { set: false },
        keySaid: keySentence(ck, { what: "Comfy API key" }),
        musicVideo: false,
        /* Said for the mode the person is in: the Comfy API page shows it in
         * both (web/router.js), and the Settings card in Full Studio. */
        note: modes.cloudOnly
          ? "Music videos need Full Studio: this mode has no Music, Music video or Collab screen. Without a "
            + "strong card, start Full Studio from the launcher and ask a friend on Collab to render the "
            + "scenes (free)."
          : "Comfy API clips are made in the launcher's Use Comfy API mode, outside a music video. Music "
            + "videos are made in Full Studio's Music video screen; without a strong card, ask a friend on "
            + "Collab to render the scenes (free).",
        confirmEveryRun: true,
      },
      ownKeyOnly: "Studio uses only a key typed into Studio on this Windows account, and each key says "
        + "when it was saved and by which copy of Studio. It reads no key from another app, another "
        + "program's settings or an environment variable such as FAL_KEY or OPENAI_API_KEY.",
      modes,
    };
  }

  /* This machine, on the UI port. The status says where the key file is and
   * which Studio folder saved a key; a page on a rebound DNS name reads none
   * of it (the Comfy API routes check the Host the same way). */
  const localHost = (req) => localUiHost(req, config.uiPort);

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/cloud") return false;
    if (!localHost(req)) { json(res, 403, { error: "Only Studio on this machine may read or change its paid services." }); return true; }
    if (req.method !== "POST") { json(res, 200, await status()); return true; }
    if (!sameOriginLocalJson(req)) {
      json(res, 403, { error: "The paid services are only switched from Studio's own Settings page or a local client." });
      return true;
    }
    let b;
    try { b = await readBody(req, MAX_BODY); }
    catch (e) { json(res, e.tooBig ? 413 : 400, { error: e.tooBig ? "That request is too large." : "That is not JSON." }); return true; }

    if (b.action === "set") {
      const patch = {};
      if (typeof b.on === "boolean") patch.enabled = b.on;
      if (Number.isFinite(b.monthlyCapUsd)) patch.monthlyCapUsd = b.monthlyCapUsd;
      if (typeof b.provider === "string") patch.provider = b.provider;
      if (!Object.keys(patch).length) { json(res, 400, { error: "Say what to change: on, monthlyCapUsd or provider." }); return true; }
      /* Switched ON only where it can make a song (Full Studio); switching it
       * off, the cap and the provider are always allowed. */
      if (patch.enabled === true && (config.cloudOnly || config.musicOnly)) {
        json(res, 409, { error: "The hosted engine makes songs in Full Studio only. Start Full Studio from the launcher to switch it on.", reason: "not-this-mode" });
        return true;
      }
      await hosted.configure(patch);
      json(res, 200, { ok: true, ...(await status()) });
      return true;
    }
    if (b.action === "comfyKey") {
      const r = await comfy.save(String(b.key || ""));
      if (r?.error) { json(res, 400, { error: r.error }); return true; }
      json(res, 200, { ok: true, method: r.method, ...(await status()) });
      return true;
    }
    if (b.action === "forgetComfyKey") {
      await comfy.forget();
      json(res, 200, { ok: true, ...(await status()) });
      return true;
    }
    json(res, 400, { error: "Unknown action. Try: set, comfyKey, forgetComfyKey." });
    return true;
  };
}
