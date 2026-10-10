/** Receiver-local H3 base graph settings captured at the Render press.
 * This object rides on the queued ArtRunner job, rather than reading mutable
 * video_settings again when music releases the GPU hours later. */
import { h3SamplerFor, h3SigmaShiftFor } from "../workflow.js";

export function receiverBaseH3Models(engine, shared = {}) {
  const effective = { ...shared, ...engine, turboMaxSteps: 19,
    sparseAttention: null, sparse: "off", sparseAll: false, solAttn: null,
    blockCache: false, blockCacheRecipe: null, fixedSteps: null };
  const sigma = h3SigmaShiftFor(effective, { steps: 20, refs: false });
  const sampler = h3SamplerFor(effective, { steps: 20, refs: false });
  return {
    dit: effective.dit, textEncoder: effective.textEncoder,
    videoVae: effective.videoVae, audioVae: effective.audioVae,
    fps: 24, fixedSteps: null, scheduler: effective.scheduler, sampler,
    shiftVideo: sigma.video, shiftAudio: sigma.audio,
    /* Even a saved turbo_max_steps=20 cannot load an 8/4/3-step adapter. */
    turboMaxSteps: 19, turbo4MaxSteps: 0, turbo3MaxSteps: 0,
    turboLora: null, turboLora4: null, turboLora3: null,
    turboShiftVideo: null, turboShiftAudio: null, turboShiftByLora: null,
    sparseAttention: null, sparse: "off", sparseAll: false, solAttn: null,
    blockCache: false, blockCacheRecipe: null,
    /* SaveVideo's encode choice is part of the graph, not merely a preference. */
    saveCrf: Number(engine.saveCrf ?? shared.saveCrf ?? 0),
  };
}
