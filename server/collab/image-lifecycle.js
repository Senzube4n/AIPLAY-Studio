/**
 * A friend image order is queued exactly once. Only the ArtRunner's own
 * terminal event may mark that accepted queue attempt complete or failed.
 * A lost HTTP receipt is deliberately absent from this path: it might have
 * reached the queue, so it must stay in the uncertain `rendering` state.
 */

const IMAGE_FILE = /^image:(i[a-z0-9]+)$/;

export function imageIdFromArtFile(file) {
  return IMAGE_FILE.exec(String(file || ""))?.[1] || null;
}

export function recentImageOutcome(status, imageId) {
  const recent = status?.art?.recent;
  if (!Array.isArray(recent)) return null;
  const entry = recent.find((item) => item?.file === `image:${imageId}` && item?.kind === "cover");
  if (!entry) return null;
  if (entry.error) return { type: "failed", cancelled: entry.cancelled === true };
  if (Array.isArray(entry.covers) && entry.covers.includes(`${imageId}.png`)) return { type: "complete" };
  return null;
}

/**
 * Records an observed terminal outcome against only the exact queued image ID.
 * A different order, an old attempt, and an order already being returned are
 * untouched. Returns the updated row or null when this event has no match.
 */
export async function recordImageOutcome({ book, outDir, file, outcome, now = Date.now() }) {
  const imageId = imageIdFromArtFile(file);
  if (!imageId || !["complete", "failed"].includes(outcome?.type)) return null;
  const rows = await book.listOrders({ outDir, side: "in" });
  const row = rows.find((item) => item?.jobType === "image" && item?.imageId === imageId && item?.state === "queued");
  if (!row) return null;
  if (outcome.type === "complete" && row.renderStatus === "complete") return row;
  if (outcome.type === "complete" && outcome.cover !== `${imageId}.png`) return null;
  if (outcome.type === "failed" && row.renderStatus === "complete") return null;
  const patch = outcome.type === "complete"
    ? { renderStatus: "complete", renderCompletedAt: now, renderFailedAt: null }
    : { renderStatus: outcome.cancelled ? "stopped" : "failed", renderFailedAt: now,
        renderCompletedAt: null };
  try {
    return await book.transitionOrderState({ outDir, id: row.id, from: "queued",
      to: outcome.type === "complete" ? "queued" : "failed", patch });
  } catch (error) {
    // A return or another reconciliation claimed the row between list and CAS.
    if (error?.reason === "order-state-changed") return null;
    throw error;
  }
}
