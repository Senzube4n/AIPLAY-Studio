/**
 * Reactive — pictures that move with a song, on the Studio's own compositor.
 * 2026-09-18. Replaces the second-engine client this file used to be.
 *
 * WHAT IT MAKES. A song plus a handful of pictures becomes a video with the
 * song on it: a picture per bar (or per beat, or per hit), cut or cross-faded
 * on the beat, the whole frame breathing with the bass, a flash on every
 * beat, and a look on top (film grain and vignette, or a hue that turns with
 * the loudness). Nothing here needs a video model: the compositor is
 * server/vfx (CPU, numpy, muxes the song itself), so the same recipe renders
 * on an AMD card where H3 and LTX do not run — and on NVIDIA the pictures
 * can come from FLUX.2 or Z-Image first.
 *
 * WHERE THE IDEA COMES FROM. ComfyUI_Yvann-Nodes (GPL-3.0, Yvann Barbot and
 * Lilia) — audio analysis into per-frame weights, transitions on peaks, a
 * prompt per peak. This is a re-creation of the idea on our own engine, not
 * their code: the audio side is vfx/audiokeys.py (seven tracks, beats,
 * bars), the picture side is compositor layers with keyframes.
 *
 * TWO LAYERS OF CONTROL. The page and reactive_render take a song, pictures
 * (or a prompt and a count), a style and a cut; what they build is a comp of
 * ordinary layers and keyframes, so the result opens on the VFX screen for
 * anyone who wants to keep editing, and every knob is also a vfx_* tool.
 */
import path from "node:path";

export const STYLES = {
  cuts: { label: "Cuts", note: "A picture per bar, hard cuts on the beat, the frame breathing with the bass." },
  crossfade: { label: "Crossfade", note: "The same, dissolved across the beat rather than cut." },
  pulse: { label: "Pulse", note: "Cuts, a stronger bass breath, and a white flash on every beat." },
  film: { label: "Film", note: "Crossfades with grain, a vignette and a slow push-in — the music-video look." },
  psychedelic: { label: "Psychedelic", note: "Cuts, the hue turning with the loudness, a flash on the beat." },
  /* THE DIFFUSION LOOK. Not a cut between pictures: a clip repainted frame by
   * frame by the image engine, the pictures as the look rotating on the bars,
   * the bass deciding how hard, the figure kept. server/reactive_paint.js. */
  paint: { label: "Paint (diffusion)", note: "The clip in the slots is repainted frame by frame by the image engine: your pictures are the look and take turns on the bars, the bass decides how hard, the figure is kept. NVIDIA only, about 8 s a frame." },
  /* THE MOTION-MODULE LOOK. The clip repainted by SD1.5 under AnimateDiff v3:
   * the whole piece as one batch through sliding windows (no flicker), the
   * figure held by depth and line art, the look changing on the bars by
   * prompt. server/reactive_motion.js + server/animatediff.js. */
  motion: { label: "Motion (AnimateDiff)", note: "The clip in the slots is repainted by SD1.5 under the AnimateDiff v3 motion module — no flicker — the figure held by depth and line art, the pictures you pick as the look switching on the drum hits (or prompts on the bars, Motion dials). NVIDIA only, about 3.5 s a frame." },
};
export const CUTS = { bar: "one picture per bar", beat: "one picture per beat", hit: "a picture on every onset above the threshold" };
export const ORIENTATIONS = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);
/** A slot may hold a clip instead of a picture: the same names the clips
 *  library admits. A clip plays IN SYNC with the song — its own time equals
 *  the comp's, looping over its length — so several renders of one shot cut
 *  between each other on the beat without a jump in the motion. */
export const CLIP_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;
export const HITS = { mix: "the whole mix", drums: "the drums alone, separated first — cleaner hits" };
const R = (n) => Number(Number(n).toFixed(4));

/**
 * The scale at which a picture fills the frame. The compositor reports the
 * source size on the layer it made; without it the picture sits at 100 %.
 */
export function coverScale(layer, w, h) {
  const sw = Number(layer?.srcWidth) || 0, sh = Number(layer?.srcHeight) || 0;
  if (!sw || !sh) return 100;
  return R(Math.max(w / sw, h / sh) * 100);
}

/**
 * Keys for one property from one analysis track: the track's values inside a
 * window, mapped from [0,1] onto [lo,hi]. `shape(t, v)` turns the mapped
 * value into the property's value (a scalar, or a scale pair).
 */
export function driveKeys(track, { from, to, lo, hi, shape = (t, v) => v }) {
  const inside = (track || []).filter((k) => k.t > from && k.t < to);
  const before = (track || []).filter((k) => k.t <= from);
  const first = before.length ? before[before.length - 1] : (inside[0] ?? { v: 0 });
  const last = inside[inside.length - 1] ?? first;
  const map = (v) => lo + (hi - lo) * clamp(v, 0, 1);
  const keys = [{ t: R(from), v: shape(from, map(first.v)), ease: "linear" }];
  for (const k of inside) keys.push({ t: R(k.t), v: shape(k.t, map(k.v)), ease: "linear" });
  keys.push({ t: R(to), v: shape(to, map(last.v)), ease: "linear" });
  return keys;
}

/**
 * The cut times: where each picture starts. Bars from the analysis, beats,
 * or onsets above a threshold with a least gap. Always starts at 0, never
 * lands within 50 ms of the end.
 */
export function cutTimes({ beats = [], bars = [], onsets = [], duration, cut = "bar", threshold = 0.5, minGap = 0.25 }) {
  let times;
  if (cut === "beat") times = beats;
  else if (cut === "hit") {
    times = [];
    let last = -Infinity;
    for (const o of onsets) {
      if (o.v >= threshold && o.t - last >= minGap) { times.push(o.t); last = o.t; }
    }
  } else times = bars.length ? bars : beats;
  const out = [0];
  for (const t of times) if (t > out[out.length - 1] + 0.05 && t < duration - 0.05) out.push(Number(Number(t).toFixed(3)));
  return out;
}

/**
 * The plan: pure, from cut times and pictures. Each cut opens a slot
 * [start, end); slots take the pictures round-robin. A cross-faded picture
 * starts one fade early and ends one fade late, so the overlap is where both
 * show; a cut is exact. Opacity keys are holds for a cut, eases for a fade.
 */
export function planReactive({ pictures, times, duration, style = "cuts", fade = 0.35 }) {
  if (!pictures?.length) throw new Error("Reactive needs at least one picture.");
  const xfade = style === "crossfade" || style === "film";
  const slots = times.map((t, i) => ({ start: t, end: i + 1 < times.length ? times[i + 1] : duration }));
  const layers = slots.map((s, i) => {
    const pic = pictures[i % pictures.length];
    const f = xfade ? Math.min(fade, Math.max(0.05, (s.end - s.start) / 2)) : 0;
    const start = xfade && i > 0 ? Math.max(0, s.start - f) : s.start;
    const end = xfade && i + 1 < slots.length ? Math.min(duration, s.end + f) : s.end;
    const keys = xfade
      ? [
        ...(i > 0 ? [{ t: start, v: 0, ease: "easeInOut" }, { t: s.start + f, v: 100, ease: "easeInOut" }] : [{ t: start, v: 100, ease: "hold" }]),
        ...(i + 1 < slots.length ? [{ t: s.end - f, v: 100, ease: "easeInOut" }, { t: end, v: 0, ease: "easeInOut" }] : []),
      ]
      : [{ t: start, v: 100, ease: "hold" }];
    return { name: `pic ${i + 1} · ${pic}`, src: pic, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), opacityKeys: keys };
  });
  return { slots, layers, xfade };
}

/** What each style asks of the compositor. */
export function styleRecipe(style = "cuts") {
  switch (style) {
    case "crossfade": return { pulse: [100, 106], flash: null, effects: [], push: 0 };
    case "pulse": return { pulse: [100, 116], flash: [0, 0.9], effects: [], push: 0 };
    case "film": return { pulse: [100, 104], flash: null, effects: [["addGrain", { intensity: 0.18 }], ["vignette", { amount: 0.45 }]], push: 8 };
    case "psychedelic": return { pulse: [100, 110], flash: [0, 0.6], effects: [["hueSaturation", { hue: 0 }]], hueDrive: [0, 120], push: 0 };
    /* The paint already moves with the music inside every frame; the
     * compositor adds only a soft flash on the beat and the faintest breath. */
    case "paint": return { pulse: [100, 103], flash: [0, 0.5], effects: [], push: 0, paint: true };
    case "motion": return { pulse: [100, 103], flash: [0, 0.5], effects: [], push: 0, motion: true };
    default: return { pulse: [100, 110], flash: null, effects: [], push: 0 };
  }
}

/**
 * Build and render. `deps` are the doors, so a lane can hand in fakes:
 *   analyse(song, fps, { hits }) → { beats:[s], bars:[s], onsets:[{t,v}], duration,
 *                          (hits "drums": beats, bars and onsets read off the
 *                          separated drum stem; the tracks stay the mix's)
 *                          tracks:{ bass:[{t,v}], beat:[{t,v}], amplitude:[{t,v}] } }
 *                        (one analysis; every keyframe below is cut from it)
 *   vfx(body)          → the compositor door (create, add_layer, set_prop, add_effect, audio_keys, render)
 *   image(body)        → the image door, for pictures made from a prompt
 *   images()           → the images library, [{ name }]
 *   waitIdle()         → resolves when the art queue is idle
 *   paint(o)           → the Paint look's renderer (server/reactive_paint.js): repaints a
 *                        clip frame by frame and answers { file, frames, seconds }
 *
 * @param {object} o  song, pictures[] | prompt + count, style, cut, seconds, orientation, name, engine, threshold, minGap
 */
export async function runReactive(o, deps) {
  const style = STYLES[o.style] ? o.style : "cuts";
  const cut = CUTS[o.cut] ? o.cut : "bar";
  const [w, h] = ORIENTATIONS[o.orientation] || ORIENTATIONS.landscape;
  const fps = 30;
  const song = path.basename(String(o.song || ""));
  if (!song) throw new Error("Pick a song.");
  const hits = o.hits === "drums" ? "drums" : "mix";
  /* Where in the song the piece begins. A song's drums may start a verse in
   * (this library's 128 bpm dance track has none for its first 25 s), and a
   * piece cut on the drums wants to start where they do. The song plays from
   * `start`, the cut times and every drive track shift with it. */
  const start = clamp(o.start || 0, 0, 3600);

  /* 1. The analysis: beats, bars, onsets, length — the hits from the drum stem
   * when asked, the way Yvann's workflow detects peaks on "Drums Only". */
  const an = await deps.analyse(song, fps, { hits });
  const songSeconds = Number(an.duration) || 0;
  const avail = Math.max(0, songSeconds - start);
  if (songSeconds && avail < 2) throw new Error(`The song is ${songSeconds.toFixed(1)} s long; starting at ${start} s leaves nothing to cut. Start earlier.`);
  const duration = clamp(o.seconds || avail || 30, 2, Math.min(600, avail || 600));
  const shiftT = (arr) => (arr || []).map((t) => R(t - start)).filter((t) => t >= 0);
  const shiftK = (arr) => (arr || []).map((k) => ({ t: R(k.t - start), v: k.v })).filter((k) => k.t >= 0);
  const times = cutTimes({ beats: shiftT(an.beats), bars: shiftT(an.bars), onsets: shiftK(an.onsets), duration, cut, threshold: o.threshold ?? 0.5, minGap: o.minGap ?? 0.25 });

  /* 2. The pictures: named, or made from a prompt and waited for. */
  let pictures = Array.isArray(o.pictures) ? o.pictures.map((p) => path.basename(String(p))).filter(Boolean) : [];
  let made = [];
  if (!pictures.length && o.prompt) {
    const count = clamp(o.count || 6, 1, 24);
    const before = new Set((await deps.images()).map((i) => i.name));
    /* The image door makes up to four pictures per request (one text encode
     * serves four), so a bigger count is several requests on the same queue. */
    for (let left = count; left > 0; left -= 4) {
      const r = await deps.image({ action: "create", prompt: String(o.prompt), count: Math.min(4, left), ...(o.engine ? { engine: o.engine } : {}) });
      if (r?.error) throw new Error(r.error);
    }
    await deps.waitIdle?.();
    const after = await deps.images();
    // The library lists newest first; a sequence wants them in the order they were made.
    made = after.filter((i) => !before.has(i.name)).sort((a, b) => (a.at || 0) - (b.at || 0)).map((i) => i.name).slice(0, count);
    pictures = made;
  }
  if (!pictures.length) throw new Error("Reactive needs pictures: pick some from the Images library, or give a prompt and a count.");

  /* 2b. The Paint look: the clip in the slots is repainted frame by frame
   * (the pictures are the look), and the painted clip becomes the ONE slot
   * of the piece — the cuts live inside the paint, on the bars. */
  let painted = null;
  if (style === "paint" || style === "motion") {
    const sourceClip = pictures.find((p) => CLIP_RE.test(p));
    if (!sourceClip) {
      throw new Error(style === "paint"
        ? "The Paint look repaints a clip: pick one in the Clips grid — the pictures you pick are the look."
        : "The Motion look repaints a clip: pick one in the Clips grid — the pictures you pick are the look, switching on the hits (or the prompts under Motion dials).");
    }
    if (style === "paint") {
      const styles = pictures.filter((p) => !CLIP_RE.test(p));
      if (!styles.length) throw new Error("The Paint look needs at least one picture for the look: pick some, or give a prompt and a count.");
      if (typeof deps.paint !== "function") throw new Error("The Paint look is not available here: it needs the image engine.");
      painted = await deps.paint({ clip: sourceClip, song, start, seconds: duration, orientation: o.orientation, styles, dials: o.paint || {} });
    } else {
      if (typeof deps.motion !== "function") throw new Error("The Motion look is not available here: it needs the image engine and the AnimateDiff pack.");
      /* The bars are the song's (the drum stem's when asked); the renderer shifts them to the piece. */
      painted = await deps.motion({
        clip: sourceClip, start, seconds: duration, orientation: o.orientation,
        bars: an.bars || [], beats: an.beats || [],
        /* the pictures picked are the LOOK — the reference workflow's way — and switch on the hits */
        pictures: pictures.filter((p) => !CLIP_RE.test(p)),
        dials: o.motion || {},
      });
    }
    pictures = [painted.file];
  }
  const slotTimes = (style === "paint" || style === "motion") ? [0] : times;

  /* 3. The comp: the song as an audio layer, the pictures as timed layers. */
  const name = String(o.name || `Reactive · ${song.replace(/\.[a-z0-9]+$/i, "")}`).slice(0, 80);
  const created = await deps.vfx({ action: "create", name, width: w, height: h, fps, duration });
  if (created?.error) throw new Error(created.error);
  const slug = created.slug || created.comp?.slug;
  const plan = planReactive({ pictures, times: slotTimes, duration, style });
  const recipe = styleRecipe(style);
  const idOf = (r) => r?.layerId || r?.layer?.id || r?.id;
  /* Every call on a layer goes through the door CHECKED. The door answers
   * {error} for a layer it cannot find or a key it cannot take, and a recipe
   * that shrugged at that shipped comps with no cover scale, no start offset
   * and no flash: the door reads `layerId`, the recipe used to say the
   * snake-case name, and nobody read the reply (every piece before 2026-09-19 —
   * the Paint and Motion clips sat at 768x432 inside 1080p, the song from 0:00
   * under a clip rendered from 25.6 s). */
  const door = async (body) => {
    const r = await deps.vfx(body);
    if (r?.error) throw new Error(`compositor ${body.action}${body.path ? ` ${body.path}` : ""}: ${r.error}`);
    return r;
  };
  const audio = await deps.vfx({ action: "add_layer", slug, type: "audio", src: song, name: "song" });
  if (audio?.error) throw new Error(audio.error);
  if (start > 0) await door({ action: "set_layer", slug, layerId: idOf(audio), inPoint: start });
  const tracks = Object.fromEntries(Object.entries(an.tracks || {}).map(([k, v]) => [k, shiftK(v)]));
  const ids = [];
  for (const L of plan.layers) {
    const isClip = CLIP_RE.test(L.src);
    const r = await deps.vfx({ action: "add_layer", slug, type: isClip ? "video" : "image", src: L.src, name: L.name, start: L.start, end: L.end, index: 0 });
    if (r?.error) throw new Error(`${L.src}: ${r.error}`);
    const id = idOf(r);
    ids.push(id);
    if (isClip) {
      /* In sync with the song: the clip's own time equals the comp's, wrapped
       * over its length, so two renders of one shot cut between each other
       * mid-move without the move jumping. */
      const dur = Number(r?.layer?.srcDuration) || 0;
      await door({ action: "set_layer", slug, layerId: id, inPoint: dur > 0 ? R(L.start % dur) : 0 });
    }
    await door({ action: "set_prop", slug, layerId: id, path: "transform.opacity", keys: L.opacityKeys });
    /* The picture fills the frame; above that it breathes with the bass
     * (the style's bounds, as a factor) and, for a push, grows over its slot.
     * The keys are cut from the ONE analysis rather than analysing the song
     * again per picture — eleven pictures used to mean eleven analyses. */
    const base = coverScale(r?.layer, w, h);
    const [lo, hi] = recipe.pulse || [100, 100];
    const span = Math.max(L.end - L.start, 1e-6);
    const shape = (t, factor) => {
      const s = base * (factor / 100) * (1 + ((recipe.push || 0) / 100) * clamp((t - L.start) / span, 0, 1));
      return [R(s), R(s)];
    };
    await door({ action: "set_prop", slug, layerId: id, path: "transform.scale",
      keys: driveKeys(tracks.bass, { from: L.start, to: L.end, lo, hi, shape }) });
  }
  /* 4. The look on top: one adjustment layer, its effects driven by the song. */
  let lookId = null;
  if (recipe.flash || recipe.effects.length) {
    const adj = await deps.vfx({ action: "add_layer", slug, type: "adjustment", name: "look", index: 0 });
    lookId = idOf(adj);
    for (const [type, params] of recipe.effects) {
      const fx = await door({ action: "add_effect", slug, layerId: lookId, type, params });
      const fxId = fx?.effectId || fx?.effect?.id;
      if (type === "hueSaturation" && recipe.hueDrive && fxId) {
        await door({ action: "set_prop", slug, layerId: lookId, path: `effects.${fxId}.hue`,
          keys: driveKeys(tracks.amplitude, { from: 0, to: duration, lo: recipe.hueDrive[0], hi: recipe.hueDrive[1], shape: (t, v) => R(v) }) });
      }
    }
    if (recipe.flash) {
      const fx = await door({ action: "add_effect", slug, layerId: lookId, type: "exposure", params: { exposure: 0 } });
      const fxId = fx?.effectId || fx?.effect?.id;
      if (fxId) await door({ action: "set_prop", slug, layerId: lookId, path: `effects.${fxId}.exposure`,
        keys: driveKeys(tracks.beat, { from: 0, to: duration, lo: recipe.flash[0], hi: recipe.flash[1], shape: (t, v) => R(v) }) });
    }
  }
  /* 5. Render: the movie lands in the clips library with the song on it. */
  const render = await deps.vfx({ action: "render", slug, format: "mp4" });
  if (render?.error) throw new Error(render.error);
  return {
    ok: true, slug, name, jobId: render.jobId, clip: render.clip, out: render.out,
    style, cut, hits, start, orientation: [w, h], seconds: duration, fps,
    pictures, made, cuts: slotTimes.length, bpm: an.bpm ?? null,
    paint: style === "paint" ? painted : null, motion: style === "motion" ? painted : null,
    note: "The comp is on the VFX screen under this name — open it to keep editing; the movie appears in the clips library when the render finishes (poll GET /api/vfx/comp/<slug> → renders[]).",
  };
}

/** The page's status: this needs nothing but the compositor now. */
export async function status() {
  return { ok: true, engine: "compositor", styles: STYLES, cuts: CUTS, hits: HITS, orientations: Object.keys(ORIENTATIONS) };
}
