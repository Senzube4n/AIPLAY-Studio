/** The no-GPU Video Lab preview must describe the render that was requested. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { videoLabTools } from "../mcp-videolab.js";
import { createVideoLabRoutes, labState } from "./routes.js";

const requests = [];
const route = createVideoLabRoutes({
  json: (res, status, value) => { res.status = status; res.value = value; },
  readBody: async (req) => req.body,
  art: new EventEmitter(),
  rememberClip: () => {},
  sameOriginLocalJson: () => true,
});
const api = async (method, path, body) => {
  requests.push(body);
  const res = {};
  assert.equal(await route({ method, body }, res, new URL(path, "http://127.0.0.1")), true);
  assert.equal(res.status, 200);
  return res.value;
};
const tool = videoLabTools(api).find((entry) => entry.name === "video_compare");

// Use a known pair of trained profiles so this regression remains meaningful
// on machines with different downloaded LoRAs or saved shift overrides.
const h3 = config.video.engines.h3;
const saved = {
  turboLora4: h3.turboLora4,
  refTurboLora4: h3.refTurboLora4,
  turboShiftVideo: h3.turboShiftVideo,
  turboMaxSteps: h3.turboMaxSteps,
  turbo4MaxSteps: h3.turbo4MaxSteps,
  turboShiftByLora: h3.turboShiftByLora,
};
Object.assign(h3, {
  turboLora4: "plain-4.safetensors",
  refTurboLora4: "reference-4.safetensors",
  turboShiftVideo: 0,
  turboMaxSteps: 12,
  turbo4MaxSteps: 5,
  turboShiftByLora: {
    "plain-4.safetensors": { video: 6, audio: 3 },
    "reference-4.safetensors": { video: 12, audio: 3 },
  },
});

try {
  const plain = labState("h3").configs.find((arm) => arm.id === "h3_turbo4");
  const refs = ["character.png"];
  const requested = { width: 1024, height: 576, refImages: refs };
  const expected = labState("h3", requested).configs.find((arm) => arm.id === "h3_turbo4");
  assert.notEqual(expected.commitSigma, plain.commitSigma,
    "reference and plain profiles must exercise different shifts in this test");

  const preview = await tool.run({
    prompt: "A dancer turns toward camera",
    configs: ["h3_turbo4"],
    dry_run: true,
    ref_images: refs,
    width: requested.width,
    height: requested.height,
  });
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.arms.map((arm) => arm.config), ["h3_turbo4"]);
  assert.equal(preview.arms[0].commit_sigma, expected.commitSigma,
    "a referenced 4-step preview must report the referenced graph's commit sigma");
  assert.equal(preview.arms[0].size, `${expected.width}x${expected.height}`,
    "the preview must report the pinned render size");
  assert.deepEqual(requests[0].refImages, refs);
  assert.equal(requests[0].width, requested.width);
  assert.equal(requests[0].height, requested.height);

  const audioPreview = await tool.run({
    prompt: "A dancer follows the beat",
    configs: ["h3_turbo4", "hybrid"],
    dry_run: true,
    ref_audios: [{ name: "beat.wav", start: 3 }],
  });
  const expectedAudio = labState("h3", { refAudios: [{ name: "beat.wav", start: 3 }] })
    .configs.find((arm) => arm.id === "h3_turbo4");
  assert.equal(audioPreview.arms.find((arm) => arm.config === "h3_turbo4").commit_sigma,
    expectedAudio.commitSigma, "audio references also select the reference H3 path");
  assert.equal(audioPreview.hybrid_would_use, "h3");
} finally {
  Object.assign(h3, saved);
}

console.log("Video Lab MCP preview matches referenced H3 shift and pinned size");
