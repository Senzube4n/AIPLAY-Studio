/**
 * Optional StandRig 2D performer. This is deliberately one pinned loopback
 * peer, not a user-supplied proxy. StandRig owns its artwork and playback;
 * Studio never installs it or receives a model through this connector.
 *
 * Contract checked against StandRig 0.2.0, inputContractVersion 2:
 * docs/ADAPTERS.md and apps/service/src/playback.ts at upstream 33e15309.
 */
import { randomBytes } from "node:crypto";

const ORIGIN = "http://127.0.0.1:5180";
const PLAYER_URL = `${ORIGIN}/player`;
const RESPONSE_LIMIT = 128 * 1024;
const PARTS_LIMIT = 512 * 1024;

function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

/** Read only small JSON replies, even if an unrelated local program owns 5180. */
async function requestStandRig(method, pathname, body) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
    redirect: "error",
  });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > (["/api/parts", "/api/deformers"].includes(pathname) ? PARTS_LIMIT : RESPONSE_LIMIT)) {
      await response.body.cancel().catch(() => {});
      throw failure("StandRig returned an oversized reply.");
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure("StandRig returned an invalid JSON reply."); }
  if (!response.ok || data?.ok === false) {
    throw failure(typeof data?.error === "string" ? data.error.slice(0, 240)
      : `StandRig returned HTTP ${response.status}.`, response.status >= 400 ? response.status : 502);
  }
  return data;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visibleImagePart(parts, deformers) {
  const byId = new Map(parts.filter((part) => isObject(part) && typeof part.id === "string")
    .map((part) => [part.id, part]));
  const deformerById = new Map(deformers.filter((item) => isObject(item) && typeof item.id === "string")
    .map((item) => [item.id, item]));
  function deformerVisible(part) {
    const attached = part.deformerId ? deformerById.get(part.deformerId)
      : deformers.find((item) => item?.targetPartIds?.includes(part.id));
    const seen = new Set();
    let current = attached;
    while (current) {
      if (current.visible !== true || seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.parentId == null ? null : deformerById.get(current.parentId);
      if (current === undefined) return false;
    }
    return true;
  }
  return parts.some((part) => {
    if (part?.kind !== "image" || typeof part.assetId !== "string" || !part.assetId) return false;
    const seen = new Set();
    let current = part;
    while (current) {
      if (current.visible !== true || !deformerVisible(current) || seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.parentId == null ? null : byId.get(current.parentId);
      if (current === undefined) return false;
    }
    return true;
  });
}

function validatePatch(values, parameters) {
  if (!isObject(values)) throw failure("Parameter values must be an object.", 400);
  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > 32) throw failure("Send 1 to 32 parameters at once.", 400);
  const byId = new Map(parameters.map((item) => [item.id, item]));
  for (const [id, value] of entries) {
    const definition = byId.get(id);
    if (!definition) throw failure(`Unknown StandRig parameter: ${id.slice(0, 64)}.`, 400);
    if (typeof value !== "number" || !Number.isFinite(value)
      || !Number.isFinite(definition.min) || !Number.isFinite(definition.max)
      || value < definition.min || value > definition.max) {
      throw failure(`StandRig parameter ${id.slice(0, 64)} is outside its finite range.`, 400);
    }
  }
  return Object.fromEntries(entries);
}

/** `request` is injectable only for unit tests; production always calls ORIGIN. */
export function createStandRigConnector({ request = requestStandRig } = {}) {
  const source = `aiplay_studio_${randomBytes(8).toString("hex")}`;
  let sequence = 0;
  let sessionId = null;
  let modelVersion = null;
  let pending = Promise.resolve();

  async function status() {
    try {
      const health = await request("GET", "/api/health");
      if (health?.ok !== true || health?.app !== "standrig-modeling-tools" || health?.capabilities?.playback !== true) {
        return { connected: false, ready: false, hasArtwork: false, reason: "Port 5180 is not a compatible StandRig service.", playerUrl: null, playback: null };
      }
      const [state, rig, partList, deformerList] = await Promise.all([
        request("GET", "/api/playback"), request("GET", "/api/rig/summary"),
        request("GET", "/api/parts"), request("GET", "/api/deformers"),
      ]);
      const playback = state?.playback;
      if (state?.ok !== true || rig?.ok !== true || !isObject(playback)
        || playback.inputContractVersion !== 2 || typeof playback.sessionId !== "string"
        || !Number.isSafeInteger(playback.modelVersion) || !Array.isArray(playback.parameters)
        || !playback.parameters.every((item) => isObject(item) && typeof item.id === "string"
          && Number.isFinite(item.min) && Number.isFinite(item.max) && item.min <= item.max)
        || !isObject(playback.values)
        || !isObject(rig.summary?.counts) || partList?.ok !== true
        || !Array.isArray(partList.parts) || deformerList?.ok !== true
        || !Array.isArray(deformerList.deformers)) {
        return { connected: false, ready: false, hasArtwork: false, reason: "StandRig's playback contract is unsupported.", playerUrl: null, playback: null };
      }
      const counts = rig.summary.counts;
      const hasArtwork = Number(counts.imageParts) > 0;
      // Summary's visibleParts also counts groups. Only show a player when an
      // actual image part and every ancestor are visible.
      const ready = hasArtwork && Number(counts.assets) > 0
        && visibleImagePart(partList.parts, deformerList.deformers);
      return { connected: true, ready, hasArtwork,
        ...(ready ? {} : { reason: "Load a 2D model in StandRig." }),
        playerUrl: PLAYER_URL, playback, summary: rig.summary };
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? "StandRig did not answer on port 5180."
        : error?.status ? `StandRig is unavailable: ${error.message}`
        : "StandRig is not running on port 5180.";
      return { connected: false, ready: false, hasArtwork: false, reason, playerUrl: null, playback: null };
    }
  }

  async function perform(body) {
    if (!isObject(body) || !["parameters", "control"].includes(body.action)) {
      throw failure("Unknown StandRig action.", 400);
    }
    const current = await status();
    if (!current.connected) throw failure(current.reason, 503);
    if (body.action === "parameters") {
      const values = validatePatch(body.values, current.playback.parameters);
      if (sessionId !== current.playback.sessionId || modelVersion !== current.playback.modelVersion) {
        sessionId = current.playback.sessionId;
        modelVersion = current.playback.modelVersion;
        sequence = 0;
      }
      // Increment before the call. On a lost reply the next frame still has a
      // fresh sequence, whether StandRig accepted this one or not.
      const result = await request("POST", "/api/playback/parameters", {
        source, sequence: ++sequence, values,
        expectedSessionId: sessionId, expectedModelVersion: modelVersion,
      });
      if (result?.ok !== true || !isObject(result.playback)) throw failure("StandRig did not acknowledge the frame.");
      return { ...current, playback: result.playback };
    }
    if (!["play", "pause", "reset", "demo-start", "demo-stop"].includes(body.command)) throw failure("Unknown StandRig control.", 400);
    const result = await request("POST", "/api/playback/control", { command: body.command });
    if (result?.ok !== true || !isObject(result.playback)) throw failure("StandRig did not acknowledge playback control.");
    return { ...current, playback: result.playback };
  }

  // Studio UI and MCP may write concurrently. StandRig requires monotonic
  // source sequences, so serialize the complete read/validate/write cycle.
  function write(body) {
    const next = pending.then(() => perform(body));
    pending = next.catch(() => {});
    return next;
  }
  return { status, write };
}
