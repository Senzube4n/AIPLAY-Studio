/**
 * WAITING FOR ONE ART JOB, the one the caller just queued, and judging it by
 * its own outcome.
 *
 * ONE COPY, THREE CALLERS: server/mcp.js (make_image, make_clip, restyle_clip,
 * extend_clip, through its waitForArt) and server/chat/tools.js (the chat's
 * make_image) poll with waitForArtJob; server/index.js's overnight dispatcher
 * (renderMediaForBatch) runs in the same process as the runner and hears its
 * events, so it asks only jobStanding() and ownFailure(). Each poller passes
 * its own `api` and `sleep`, because mcp.js is a separate stdio process
 * talking HTTP and the chat runs inside the server; that is also why this file
 * imports nothing.
 *
 * ⚠ THE WAIT USED TO BE QUEUE-WIDE AND THE VERDICT WAS `art.lastError`. That
 * field is the queue's most recent failure, whoever's it was, and art.js only
 * ever clears it in its constructor. So after ONE failed render, every later
 * make_image, make_clip, restyle_clip and extend_clip reported failure and
 * lost its file name, even when its own render succeeded, until the server
 * restarted: a false "failed" that invites paying for the render twice. The
 * chat's picture tool quoted the same stranger's error. The routes return
 * `job.id`, and the runner's status carries that id on the running job, every
 * queued one and every finished one, so the waiter follows its own and reads
 * its own `error`. `lastError` keeps its meaning for studio_status: the last
 * failure of the QUEUE, a fact about the queue and never a verdict on one job.
 *
 * Music still preempts: a job behind a song just stays queued, so a wait that
 * starts while a song renders waits for the song too. Said in the MCP tool
 * descriptions rather than worked around.
 */

/**
 * Where ONE job stands in one art status reading (`st.art`, the runner's
 * status().art), found by the id the routes return as `job.id`:
 *
 *   "unnamed"   the caller has no id, or the Studio answering does not SAY its
 *               rows carry ids (`jobIds`: an MCP process started after a pull,
 *               talking to a server nobody restarted). No row can be ours.
 *   "running"   it is `current`: where a real render spends its minutes.
 *   "queued"    it is among `items`.
 *   "finished"  it is in `recent`; `row` is that row, with its own `error`.
 *   "missing"   ids are reported and ours is in none of the three lists.
 *
 * Keyed on the flag, not on whether any row happens to carry an `id`: an
 * empty queue and an empty history (Studio just restarted) have no rows, and
 * reading that as "no ids" returned success at once for a job that was gone.
 * Every list is read, because a list skipped is a job reported "missing"
 * while it renders (qwen-cover_test.js holds the running row to that).
 */
export function jobStanding(art, jobId) {
  if (!jobId || art?.jobIds !== true) return { where: "unnamed", row: null };
  const mine = (j) => j?.id === jobId;
  if (mine(art.current)) return { where: "running", row: null };
  if ((art.items || []).some(mine)) return { where: "queued", row: null };
  const row = (art.recent || []).find(mine);
  return row ? { where: "finished", row } : { where: "missing", row: null };
}

/**
 * Resolves with the /api/status reading that settled it. Throws this job's own
 * failure, a "not running, not queued, not finished" error for an id the
 * server has lost, or, at the deadline, an error with `stillWorking: true`
 * (nothing was cancelled; the chat reports that instead of failing).
 */
export async function waitForArtJob({ api, sleep, timeoutMs, kind, jobId, pollMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let unseen = 0;
  await sleep(1200);                       // let the request reach the queue
  for (;;) {
    const st = await api("GET", "/api/status");
    const art = st.art || {};
    const busy = art.queued > 0 || !!art.current;
    const { where, row: done } = jobStanding(art, jobId);
    /* NO WAY TO NAME OUR JOB (see jobStanding). The queue emptying is then the
     * only signal there is, and the verdict is left to the caller's
     * before/after file diff. Never `lastError`: that is somebody's failure,
     * not necessarily ours, which is the whole bug above. */
    if (where === "unnamed") {
      if (!busy) return st;
    } else if (where === "running" || where === "queued") {
      unseen = 0;                          // still running or waiting: keep waiting
    } else {
      if (done?.error) throw new Error(ownFailure(done, art.lastError, kind));
      if (done) return st;
      /* Not running, not queued, not finished. One repoll rides out a torn
       * read; past that it was dropped from the queue or Studio restarted, and
       * waiting out the timeout would claim "still working" for a job that is
       * gone. Same rule mcp.js's waitForSong keeps for an id nobody knows. */
      if (++unseen >= 2) {
        throw new Error(
          `The ${kind || "art"} job ${jobId} is not running, not queued and not among the finished `
          + "jobs: it was dropped from the queue or Studio restarted. Nothing was cancelled by this call.",
        );
      }
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error(
        `Still working after ${Math.round(timeoutMs / 1000)}s`
        + (art.current ? ` (${art.current.kind} for ${art.current.title})` : "")
        + `, ${art.queued} queued. Nothing was cancelled.`,
      ), { stillWorking: true });
    }
    await sleep(pollMs);
  }
}

/**
 * This job's failure, in full when the full text is to be had.
 *
 * A finished row's `error` is cut to 200 characters on the wire (art.js
 * status()), and a missing-files message runs past that: the Qwen one ended
 * "...Choose Downloa" instead of "...Choose Download in Models when ready."
 * `lastError` holds the same text uncut, written `${title}: ${error}` when a
 * job fails. When it begins with THIS job's title and THIS job's (cut) error,
 * it is this job's own words and is quoted whole; a stranger's failure would
 * have to share the title and the first 200 characters to pass. Otherwise the
 * cut text is still ours, which beats borrowing anybody else's.
 */
export function ownFailure(done, lastError, kind) {
  /* The row's own uncut text first (art.js status() keeps it on the newest
   * rows): a success clears `lastError` now, and between a failure and the
   * next poll a quick job can succeed. */
  if (typeof done.fullError === "string" && done.fullError) return `${done.title || kind}: ${done.fullError}`;
  const own = `${done.title}: ${done.error}`;
  if (done.title && typeof lastError === "string" && lastError.startsWith(own)) return lastError;
  return `${done.title || kind}: ${done.error}`;
}

/**
 * What an MCP render tool says when its wait ended and no new file is in the
 * library. `st` is the reading waitForArtJob resolved with; `list` is the
 * listing tool that shows what IS there (list_images, list_clips).
 *
 * ⚠ THE OLD NOTE SENT THE AGENT TO THE WRONG ERROR. All four tools ended an
 * empty result with "check studio_status for the last error". Once the wait
 * follows its own job, this job's own failure has already THROWN, in its own
 * words, before any note is written. So when the job was followed, this is
 * reached only for a job that finished CLEAN and left no new file (the engine
 * can hand back a file it had already made), and the last error studio_status
 * shows is somebody else's: the exact borrowing art-wait.js exists to stop.
 * The job's own finished row is in `st`, so the files IT names are quoted.
 *
 * When the job could NOT be followed (no id from the route, or a Studio that
 * does not report ids), nothing about its outcome was read, and the note says
 * that rather than claiming a clean finish it never saw.
 */
export function emptyResultNote(st, jobId, list) {
  const { where, row } = jobStanding(st?.art || {}, jobId);
  if (where === "finished" && !row.error) {
    const named = [row.clip, ...(Array.isArray(row.covers) ? row.covers : [])].filter(Boolean);
    return "The job finished without an error of its own, but no new file appeared in the library"
      + (named.length ? ` (its own record names ${named.join(", ")}; the engine can hand back a file it had already made)`
        : " (its own record names no file)")
      + `. See ${list} for what is there.`;
  }
  return "Nothing new appeared, and this call could not follow its own job (the route returned no job id, "
    + "or this Studio's status does not report job ids), so no verdict on it was read. studio_status's "
    + `lastError is the queue's last failure, not necessarily this job's; see ${list} for what is there.`;
}
