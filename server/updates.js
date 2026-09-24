/**
 * HAS EITHER REPOSITORY MOVED SINCE THIS BUILD?
 *
 * Two public GET requests to api.github.com, no account and no token, nothing
 * about this machine or anything on it sent. It is the same kind of request
 * scripts/install-engine.mjs already makes to find a ComfyUI release, and it is
 * the fourth and last place Studio touches the internet at all.
 *
 * ⚠ THIS IS NOT WHAT COLLAB ASKS. Two friends' Studios agree or disagree on the
 * protocol number in their packets (server/collab/packet.js PACKET_V), which is
 * answered offline from what each build already carries. Nothing here is ever
 * on that path: this only answers "is there something newer to pull", which is
 * a question for a person, not for a file transfer.
 *
 * The compare call is the useful one. Asked against the upstream commit THIS
 * build contains, GitHub answers with how many commits are on top of it, which
 * is the honest version of "you are behind", rather than comparing dates or
 * counting all of history.
 *
 * Never throws, never blocks a screen: a refusal, a rate limit (60 an hour for
 * an address with no token) or no connection all come back as `ok: false` with
 * a sentence, and the answer is kept for an hour so opening About repeatedly
 * costs nothing.
 */
import { appVersion } from "./version.js";

const API = "https://api.github.com";
const HOUR = 60 * 60 * 1000;
const HEADERS = {
  Accept: "application/vnd.github+json",
  /* GitHub refuses an anonymous request with no user agent. It names the app
   * and nothing else: no machine name, no user, no version of anything private. */
  "User-Agent": "AIPLAY-Studio",
};

let cache = null;

async function get(url, ms = 6000) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  if (r.status === 403 || r.status === 429) throw new Error("GitHub is rate-limiting this address. It allows 60 checks an hour; try later.");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  return r.json();
}

const short = (s) => String(s || "").slice(0, 7);
/** The first line of a commit message, which is the only part worth showing. */
const headline = (c) => String(c?.commit?.message || "").split("\n")[0].slice(0, 120);

/**
 * @param {{ force?: boolean }} opts `force` ignores the hour's cache (the
 *   button), anything else uses it (a screen opening).
 */
export async function checkUpdates({ force = false } = {}) {
  if (cache && !force && Date.now() - cache.at < HOUR) return { ...cache, cached: true };
  const v = appVersion();
  const out = { at: Date.now(), ok: true, why: "", upstream: null, fork: null, build: v.line, cached: false };
  try {
    /* What the ORIGINAL has on top of the commit this build contains. With no
     * base recorded (a build that never knew), fall back to this build's own
     * commit, which is the same question on the original itself. */
    const from = v.base?.commit || v.commit;
    const up = v.upstreamRepo;
    const head = await get(`${API}/repos/${up}/commits/main`);
    const upstream = { repo: up, head: short(head.sha), date: head.commit?.committer?.date || "", ahead: null, newest: headline(head) };
    if (from) {
      try {
        const cmp = await get(`${API}/repos/${up}/compare/${from}...main`);
        upstream.ahead = Number(cmp.ahead_by) || 0;
        upstream.behind = Number(cmp.behind_by) || 0;
        /* Newest first: GitHub lists a comparison oldest first. */
        upstream.titles = (cmp.commits || []).slice(-5).reverse().map(headline);
      } catch (err) {
        /* A commit GitHub does not know (a local-only build) is not an error
         * worth failing the whole check for — the head is still useful. */
        upstream.ahead = null;
        upstream.why = err.message;
      }
    }
    out.upstream = upstream;

    /* And the fork's own repository, for anyone running a build older than what
     * the fork has pushed. Skipped on the original, where they are the same. */
    if (v.fork && v.repo && v.repo !== up) {
      const mine = await get(`${API}/repos/${v.repo}/commits/main`);
      out.fork = { repo: v.repo, head: short(mine.sha), date: mine.commit?.committer?.date || "", newest: headline(mine), current: short(mine.sha) === v.commit };
    }
  } catch (err) {
    out.ok = false;
    out.why = err.name === "TimeoutError" ? "GitHub did not answer in time." : err.message;
  }
  cache = out;
  return out;
}

/** What was last found, without asking GitHub anything. */
export function lastCheck() {
  return cache ? { ...cache, cached: true } : null;
}

/** The next step when a newer build exists: the launcher's own button. */
export const UPDATE_HOW = "Stop Studio, then press Update at the bottom of the launcher window.";

/**
 * One sentence for a screen. Written here rather than in three front ends, so
 * the launcher, About and any agent say the same thing.
 */
export function updateSentence(r, v = appVersion()) {
  if (!r) return "Not checked yet.";
  if (!r.ok) return r.why || "Could not reach GitHub.";
  const bits = [];
  const up = r.upstream;
  if (up?.ahead === 0) bits.push(v.fork ? "Up to date with the original." : "Up to date.");
  /* Behind: the count, then what to DO about it, in the words the launcher
   * uses. Both front ends show this sentence, and a count with no next step
   * left a person re-downloading the zip. Update replaces the app files only;
   * songs, settings, models and the engine stay where they are. One chain:
   * the "not a commit GitHub knows" line is for ahead === null only. */
  else if (up?.ahead > 0) bits.push(`${up.ahead} commit${up.ahead === 1 ? "" : "s"} on the original you do not have${up.newest ? `, newest: ${up.newest}` : ""}.`, UPDATE_HOW);
  else if (up?.head) bits.push(`The original is at ${up.head}; this build's base is not a commit GitHub knows.`);
  if (r.fork && !r.fork.current) bits.push(`Your own repository has ${r.fork.head}, which this build is not.`);
  return bits.join(" ") || "Nothing to report.";
}
