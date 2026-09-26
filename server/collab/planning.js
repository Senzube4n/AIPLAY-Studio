/** Local production planning. Nothing here packs files, contacts peers or reserves hardware. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PLAN_STAGES = Object.freeze(["storyboard", "ready", "assigned", "review", "approved"]);
const MAX_AGE = 24 * 60 * 60 * 1000;
function refuse(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function slugOf(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(value) || value.includes("..")) refuse("Choose a valid project slug.");
  return value;
}
const text = (value, limit, name) => {
  if (typeof value !== "string" || value.length > limit) refuse(`${name} must be text up to ${limit} characters.`);
  return value.trim();
};
const secondsOf = (scene) => {
  const seconds = Number(scene.durationSec ?? scene.seconds ?? scene.duration
    ?? (Number.isFinite(scene.endSec) && Number.isFinite(scene.startSec) ? scene.endSec - scene.startSec
      : Number.isFinite(scene.endMs) && Number.isFinite(scene.startMs) ? (scene.endMs - scene.startMs) / 1000
        : (Number(scene.end) || 0) - (Number(scene.start) || 0)));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};
const canRender = (peer) => peer.verified === true && ["lender", "collaborator"].includes(peer.role);

/** Greedy equal-count or longest-first time allocation, preserving pinned owners. */
export function allocatePlan({ shots, peers, segmentIds, peerIds, policy = "equal", capability = "", minVramMb = 0, minutesPerTenSeconds = {}, now = Date.now() }) {
  if (!["equal", "capability", "time"].includes(policy)) refuse("Unknown allocation policy.");
  if (!Array.isArray(segmentIds) || !segmentIds.length || segmentIds.length > 2000 || new Set(segmentIds).size !== segmentIds.length) refuse("Choose distinct scenes to allocate.");
  if (!Array.isArray(peerIds) || !peerIds.length || peerIds.length > 200 || new Set(peerIds).size !== peerIds.length) refuse("Choose distinct friends to allocate to.");
  if (!Number.isFinite(minVramMb) || minVramMb < 0 || minVramMb > 1048576) refuse("Minimum VRAM must be a nonnegative number of MB.");
  if (typeof capability !== "string" || capability.length > 120) refuse("Invalid capability.");
  if (policy !== "equal" && !capability) refuse("Choose the exact required capability for hardware or time allocation.");
  const scenes = segmentIds.map((id) => shots.find((shot) => shot.segmentId === id) || refuse(`Scene ${id} is no longer in this project.`, 409));
  const chosen = peerIds.map((id) => peers.find((peer) => peer.fp === id) || refuse(`Friend ${id} is no longer in the roster.`, 409));
  const assignments = [], excluded = [], unassigned = [], pinned = [];
  for (const peer of chosen) {
    const card = peer.resources, age = now - Number(card?.at), rate = Number(minutesPerTenSeconds?.[peer.fp]);
    let reason = !canRender(peer) ? "A verified lender or collaborator role is required" : "";
    if (!reason && policy !== "equal") {
      if (!card || !Number.isFinite(age) || age < 0 || age > MAX_AGE) reason = "Capability snapshot is missing, future-dated or older than 24 hours";
      else if (!(card.ready || []).includes(capability)) reason = `Missing advertised capability: ${capability}`;
      else if (minVramMb > 0 && Number(card.gpu?.vramMb || 0) < minVramMb) reason = "Insufficient or unknown advertised VRAM";
    }
    if (!reason && policy === "time" && (!Number.isFinite(rate) || rate <= 0 || rate > 600)) reason = "Enter an estimate above 0 and at most 600 minutes per 10 seconds of output";
    if (reason) excluded.push({ fp: peer.fp, nickname: peer.nickname, reason });
    else assignments.push({ fp: peer.fp, nickname: peer.nickname, segmentIds: [], estimatedMinutes: policy === "time" ? 0 : null, minutesPerTenSeconds: policy === "time" ? rate : null });
  }
  const add = (row, shot) => {
    row.segmentIds.push(shot.segmentId);
    if (policy === "time") row.estimatedMinutes += shot.seconds / 10 * row.minutesPerTenSeconds;
  };
  for (const shot of scenes.filter((shot) => shot.pinned)) {
    const row = assignments.find((row) => row.fp === shot.owner);
    const reason = !shot.owner ? "Pinned scene has no owner" : !row ? "Pinned owner is outside the eligible selection" : policy === "time" && !shot.seconds ? "Scene duration is unknown" : "";
    pinned.push({ segmentId: shot.segmentId, owner: shot.owner, reason });
    if (reason) unassigned.push({ segmentId: shot.segmentId, reason }); else add(row, shot);
  }
  const movable = scenes.filter((shot) => !shot.pinned);
  if (policy === "time") movable.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
  for (const shot of movable) {
    if (policy === "time" && !shot.seconds) { unassigned.push({ segmentId: shot.segmentId, reason: "Scene duration is unknown" }); continue; }
    const best = assignments.reduce((best, row) => {
      const cost = policy === "time" ? row.estimatedMinutes + shot.seconds / 10 * row.minutesPerTenSeconds : row.segmentIds.length;
      return !best || cost < best.cost ? { row, cost } : best;
    }, null);
    if (best) add(best.row, shot); else unassigned.push({ segmentId: shot.segmentId, reason: "No eligible friend in the selection" });
  }
  return { policy, capability, minVramMb, minutesPerTenSeconds, segmentIds, peerIds, assignments, excluded, unassigned, pinned,
    sceneFacts: scenes.map((shot) => [shot.segmentId, shot.seconds]),
    at: now, appliedAt: null, availability: "unknown", delivery: "not prepared", estimateSource: policy === "time" ? "user-entered estimates; no live queue or benchmark data" : null };
}

/** Read-only projection of the owner's order book. A sealed file is not a delivery receipt. */
export function projectOrderProgress({ slug, shots, orders, now = Date.now() }) {
  const labels = {
    prepared: ["Package prepared", "Transfer the reviewed file to your friend. Receipt and render progress are unknown."],
    expired: ["Acceptance window expired", "Check with your friend before preparing a replacement. An accepted render may still be running."],
    returned: ["Return passed checks", "Open Incoming to check whether the returned take still awaits review. It may already have been kept or discarded."],
    adopted: ["Take adopted", "The take was adopted into the library. Check its scene attachment; adoption does not select it or approve the scene."],
    refused: ["Return failed validation", "Inspect the return's validation results in Incoming."],
    cancelled: ["Cancelled locally", "This local record does not stop a render on another machine."],
    unknown: ["Order state unknown", "Inspect the order record before preparing more work."],
  };
  const time = (value) => Number.isFinite(value) && value >= 0 ? value : null;
  const rows = orders.filter((row) => row?.slug === slug).map((row) => {
    const expiresAt = time(row.expires);
    const status = row.state === "sent" ? (expiresAt !== null && now > expiresAt ? "expired" : "prepared")
      : ["returned", "adopted", "refused", "cancelled"].includes(row.state) ? row.state : "unknown";
    return { id: row.id, segmentId: row.order?.segmentId ?? null,
      to: { fp: row.to?.fp ?? null, nickname: row.to?.nickname ?? null },
      status, label: labels[status][0], nextStep: labels[status][1],
      preparedAt: time(row.sentAt ?? row.at), updatedAt: time(row.stateAt ?? row.sentAt ?? row.at), expiresAt,
      // Copy only display facts, never paths, prompt bodies or quarantined file references.
      returnCount: Array.isArray(row.returns) ? row.returns.length : 0,
      note: typeof row.note === "string" ? row.note.slice(0, 400) : null };
  }).sort((a, b) => (b.preparedAt ?? 0) - (a.preparedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  const sceneIds = new Set(shots.map((shot) => shot.segmentId));
  const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, rows.filter((row) => row.status === key).length]));
  return { observedAt: now, remoteAvailability: "unknown", counts,
    scenes: shots.map((shot) => ({ segmentId: shot.segmentId, orders: rows.filter((row) => row.segmentId === shot.segmentId) })),
    unmatchedOrders: rows.filter((row) => !sceneIds.has(row.segmentId)) };
}

/** One advisory handoff row per currently assigned friend. Historical orders
 * for another owner cannot satisfy this assignment. A prepared file is not a
 * delivery receipt, and an expired order may still be rendering remotely. */
export function planHandoffs({ plan, peers = [], delivery, now = Date.now() }) {
  const assignedInDraft = new Map((plan?.draft?.appliedAt && !plan.draft.stale ? plan.draft.assignments || [] : [])
    .flatMap((row) => (row.segmentIds || []).map((id) => [id, row.fp])));
  return (plan?.shots || []).filter((shot) => shot.mode === "generate" && shot.owner && shot.owner !== "self").map((shot) => {
    const peer = peers.find((item) => item.fp === shot.owner) || null;
    const eligible = peer?.verified === true && ["lender", "collaborator"].includes(peer.role);
    const orders = delivery?.scenes?.find((scene) => scene.segmentId === shot.segmentId)?.orders || [];
    const current = orders.find((order) => order.to?.fp === shot.owner) || null;
    const otherOwnerOrders = orders.filter((order) => order.to?.fp !== shot.owner).length;
    const card = peer?.resources;
    const cardAt = Number(card?.at);
    const age = now - cardAt;
    const cardState = !card || !Number.isFinite(cardAt) || cardAt <= 0 ? "missing"
      : age < 0 ? "future" : age > MAX_AGE ? "stale" : "current";
    const capability = assignedInDraft.get(shot.segmentId) === shot.owner ? plan.draft.capability || null : null;
    const minVramMb = capability ? Number(plan.draft.minVramMb) || 0 : 0;
    const cardFit = !capability ? "not-checked" : cardState !== "current" ? "unknown"
      : !(card.ready || []).includes(capability) ? "not-listed"
        : minVramMb > 0 && Number(card.gpu?.vramMb || 0) < minVramMb ? "vram-below-minimum" : "listed";
    return { segmentId: shot.segmentId, title: shot.title, owner: shot.owner,
      peer: peer ? { fp: peer.fp, nickname: peer.nickname, eligible } : { fp: shot.owner, nickname: null, eligible: false },
      status: current?.status || "not-prepared", orderId: current?.id || null,
      nextStep: current?.nextStep || "Preview this scene, then prepare a sealed file for manual transfer.",
      otherOwnerOrders, card: { state: cardState, saidAt: cardState === "missing" ? null : cardAt,
        source: "self-reported", capability, minVramMb, fit: cardFit },
      remoteAvailability: "unknown" };
  });
}

export function createCollabPlanning({ appData, readProject, readPeers, readOrders = async () => [], resolveKitCue, now = Date.now }) {
  const locks = new Map(), directory = path.join(appData, "collab", "plans");
  const filename = (slug) => path.join(directory, `${slugOf(slug)}.json`);
  const peersNow = async () => { const result = await readPeers(); return Array.isArray(result) ? result : result.peers || []; };
  async function context(slug) {
    const project = await readProject(slug);
    if (!project || !Array.isArray(project.segments)) refuse("Project was not found or has no scene list.", 404);
    let saved = null;
    try { saved = JSON.parse(await readFile(filename(slug), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") refuse("The saved collaboration plan could not be read; it has not been replaced.", 500); }
    const shots = project.segments.map((scene) => ({ segmentId: scene.id,
      title: scene.title || scene.name || scene.label || scene.id, seconds: secondsOf(scene), mode: scene.mode || null,
      stage: "storyboard", owner: null, reviewNote: "", pinned: false, dependsOn: null,
      ...(saved?.shots || []).find((shot) => shot.segmentId === scene.id),
      segmentId: scene.id, title: scene.title || scene.name || scene.label || scene.id, seconds: secondsOf(scene) }));
    const plan = { v: 1, slug, title: project.title || slug, revision: saved?.revision || 0,
      notes: saved?.notes || "", updatedAt: saved?.updatedAt || null, changedBy: saved?.changedBy || null,
      shots, draft: saved?.draft || null, musicCues: saved?.musicCues || [], removedSceneCount: (saved?.shots || []).filter((shot) => !shots.some((s) => s.segmentId === shot.segmentId)).length };
    const peers = await peersNow(), observedAt = now();
    const delivery = projectOrderProgress({ slug, shots, orders: await readOrders(), now: observedAt });
    delivery.handoffs = planHandoffs({ plan, peers, delivery, now: observedAt });
    return { plan, peers, delivery };
  }
  async function get(slug) { return { ok: true, ...await context(slugOf(slug)) }; }
  async function mutate(body, actor = "system") {
    const slug = slugOf(body.slug), previous = locks.get(slug) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const { plan, peers, delivery } = await context(slug);
      if (!Number.isInteger(body.expectedRevision) || body.expectedRevision !== plan.revision) refuse("This plan changed in another view. Reload it before saving your changes.", 409);
      if (body.action === "update_episode") plan.notes = text(body.notes, 8000, "Episode notes");
      else if (body.action === "set_music_cue") {
        if (!["opening", "tension", "closing"].includes(body.slot)) refuse("Choose an opening, tension or closing cue.");
        const segmentId = body.segmentId ?? null;
        if (segmentId !== null && !plan.shots.some(s => s.segmentId === segmentId)) refuse("The scene for this cue is no longer in the episode.", 409);
        if (body.musicKit !== null && !resolveKitCue) refuse("Music kit linking is not available.", 503);
        const link = body.musicKit === null ? null : await resolveKitCue(body.musicKit);
        plan.musicCues = plan.musicCues.filter(cue => cue.slot !== body.slot || cue.segmentId !== segmentId);
        if (link) plan.musicCues.push({ slot: body.slot, segmentId, ...link, updatedAt: now(), changedBy: actor });
      }
      else if (body.action === "update_shot") {
        const shot = plan.shots.find((s) => s.segmentId === body.segmentId);
        if (!shot) refuse("Scene is no longer in this project.", 409);
        if (Object.hasOwn(body, "stage")) { if (!PLAN_STAGES.includes(body.stage)) refuse("Unknown production stage."); shot.stage = body.stage; }
        if (Object.hasOwn(body, "owner")) {
          if (body.owner !== null && body.owner !== "self" && !peers.some((p) => p.fp === body.owner)) refuse("The planned owner is not in the friend roster.");
          shot.owner = body.owner;
        }
        if (Object.hasOwn(body, "reviewNote")) shot.reviewNote = text(body.reviewNote, 4000, "Review note");
        if (Object.hasOwn(body, "pinned")) { if (typeof body.pinned !== "boolean") refuse("Pinned must be true or false."); shot.pinned = body.pinned; }
        if (Object.hasOwn(body, "dependsOn")) {
          if (body.dependsOn !== null && (!plan.shots.some((s) => s.segmentId === body.dependsOn) || body.dependsOn === shot.segmentId)) refuse("Choose another scene as the dependency.");
          shot.dependsOn = body.dependsOn;
          let cursor = shot.dependsOn; const seen = new Set([shot.segmentId]);
          while (cursor) { if (seen.has(cursor)) refuse("Scene dependencies cannot form a cycle."); seen.add(cursor); cursor = plan.shots.find((s) => s.segmentId === cursor)?.dependsOn; }
        }
        if (shot.stage === "assigned" && !shot.owner) refuse("Choose an owner before marking a scene Assigned.");
        shot.updatedAt = now(); shot.changedBy = actor;
        // A changed scene makes an older allocation a reference, not an applicable command.
        if (plan.draft) plan.draft.stale = true;
      } else if (body.action === "allocate" || body.action === "preview_allocation") {
        plan.draft = allocatePlan({ shots: plan.shots, peers, segmentIds: body.segmentIds, peerIds: body.peerIds,
          policy: body.policy, capability: body.capability, minVramMb: body.minVramMb, minutesPerTenSeconds: body.minutesPerTenSeconds, now: now() });
        if (body.action === "preview_allocation") return { ok: true, plan, peers,
          delivery: { ...delivery, handoffs: planHandoffs({ plan, peers, delivery, now: now() }) }, previewOnly: true };
      } else if (body.action === "apply_draft") {
        const draft = plan.draft;
        if (!draft || draft.stale) refuse("Create a current allocation draft before applying it.", 409);
        if (draft.appliedAt) refuse("This allocation draft was already applied.", 409);
        const eligible = allocatePlan({ ...draft, shots: plan.shots, peers, now: now() });
        if (JSON.stringify(eligible.sceneFacts) !== JSON.stringify(draft.sceneFacts)) refuse("Scene durations changed. Create a new draft.", 409);
        if (JSON.stringify(eligible.assignments.map((r) => [r.fp, r.segmentIds])) !== JSON.stringify(draft.assignments.map((r) => [r.fp, r.segmentIds]))) refuse("Peer capabilities, permissions or scene durations changed. Create a new draft.", 409);
        for (const row of draft.assignments) for (const id of row.segmentIds) {
          const shot = plan.shots.find((s) => s.segmentId === id);
          if (!shot) refuse("A drafted scene was removed. Create a new draft.", 409);
          shot.owner = row.fp;
          if (["storyboard", "ready", "assigned"].includes(shot.stage)) shot.stage = "assigned";
          shot.updatedAt = now(); shot.changedBy = actor;
        }
        draft.appliedAt = now();
      } else refuse("Unknown collaboration planning action.");
      plan.revision++; plan.updatedAt = now(); plan.changedBy = actor;
      await mkdir(directory, { recursive: true });
      const tmp = `${filename(slug)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(plan, null, 2), "utf8");
      await rename(tmp, filename(slug));
      return { ok: true, plan, peers,
        delivery: { ...delivery, handoffs: planHandoffs({ plan, peers, delivery, now: now() }) } };
    });
    locks.set(slug, work);
    work.finally(() => { if (locks.get(slug) === work) locks.delete(slug); }).catch(() => {});
    return work;
  }
  return { get, mutate };
}

export function createCollabPlanningRoutes({ json, readBody, appData, readProject, readPeers, readOrders, resolveKitCue, actorFrom = () => "system" }) {
  const store = createCollabPlanning({ appData, readProject, readPeers, readOrders, resolveKitCue });
  return async (req, res, url) => {
    if (url.pathname !== "/api/collab/plan") return false;
    try {
      if (req.method === "GET") json(res, 200, await store.get(url.searchParams.get("slug")));
      else if (req.method === "POST") json(res, 200, await store.mutate(await readBody(req), actorFrom(req)));
      else json(res, 405, { error: "Use GET or POST." });
    } catch (error) { json(res, error.status || 500, { error: error.message }); }
    return true;
  };
}
