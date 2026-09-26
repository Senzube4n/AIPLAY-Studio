/**
 * A failed friend video attempt is still time spent on the lender's card.
 * ArtRunner's duration is measured after this job starts, not while it waits
 * in the queue. A queued job stopped before starting has no duration.
 */

const VIDEO_FILE = /^clip:collab_(o_[0-9a-f]{12})$/;

export function videoIdFromArtFile(file) {
  return VIDEO_FILE.exec(String(file || ""))?.[1] || null;
}

export async function recordVideoFailure({ book, outDir, file, kind, cancelled = false,
  durationMs = null, runId = null, now = Date.now() } = {}) {
  const id = kind === "video" ? videoIdFromArtFile(file) : null;
  if (!id) return null;
  const row = await book.findOrder({ outDir, id, side: "in" });
  if (!row || row.jobType !== "video" || !["queued", "rendering"].includes(row.state)
      || row.renderStatus === "complete") return null;
  const measured = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs : null;
  // request() can refuse before it queues anything and emits the same event.
  // Its route then returns the row to landed; it did not start a render.
  if (row.state === "rendering" && measured === null) return null;
  try {
    return await book.transitionOrderState({ outDir, id, from: row.state, to: "failed",
      expected: { renderStatus: row.renderStatus },
      patch: {
        renderStatus: cancelled ? "stopped" : "failed", renderFailedAt: now,
        renderRunMs: measured, renderRunId: runId ?? null,
      } });
  } catch (error) {
    // A concurrent completion or return changed this row after the read.
    if (error?.reason === "order-state-changed") return null;
    throw error;
  }
}
