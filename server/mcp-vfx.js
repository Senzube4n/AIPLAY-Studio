/**
 * VFX — the MCP tools.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { vfxTools } from "./mcp-vfx.js";                           │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...vfxTools(api, safeName),                                        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Spread into mcp.js's TOOLS array. Every tool calls the SAME /api/vfx route
 * the VFX tab calls, through the same api() transport the existing tools use —
 * one implementation, two surfaces, no drift. Voice and shape follow mcp-mv.js:
 * snake_case params, errors that name the fix.
 *
 * WHAT THE DESCRIPTIONS ARE FOR. An agent cannot see the comp. Every unit and
 * range in this file is here because guessing one is how you get a layer at
 * (0.5, 0.5) when the comp is 1920 wide, or an opacity of 0.8 on a 0-100 scale.
 * Anything animatable says so, because the difference between a value and a
 * keyframed value is the difference between a still and a shot.
 */

import { describeTemplates, listTemplates } from "./vfx/templates.js";

/** Where the running Studio answers — the same default mcp.js uses. */
const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

/** Written once, quoted by every tool that takes a property path. */
const PATHS =
  "Property paths: transform.position, transform.anchor, transform.scale, "
  + "transform.rotation, transform.opacity (or just 'opacity'), "
  + "effects.<effect_id>.<param>, masks.<mask_id>.<feather|opacity|expand>, "
  + "transform.rotationX / rotationY / rotationZ on a threeD layer (the bare "
  + "name works too), timeRemap, and any shape item parameter as "
  + "shapes.<i>.<param> — descend a group with shapes.<i>.items.<j>.<param>. "
  + "Shape indices count from the top of the layer's item list; "
  + "vfx_shape_catalog says which parameters animate.";

const UNITS =
  "Units: position in COMP pixels from the top-left; anchor in the LAYER's own "
  + "pixels (it is the pivot that rotation and scale turn around); scale in "
  + "percent (100 = original size, negative flips); rotation in degrees "
  + "clockwise; opacity 0-100; all times in seconds.";

export function vfxTools(api, safeName) {
  const vfx = async (body) => {
    const r = await api("POST", "/api/vfx", body);
    if (r.error) throw new Error(r.error);
    return r;
  };

  /** A comp, small enough to read: no keyframe arrays, no run log. */
  const summary = (comp) => ({
    slug: comp.slug, name: comp.name,
    size: `${comp.width}x${comp.height}`, fps: comp.fps, duration: comp.duration,
    motion_blur: comp.motionBlur?.enabled ?? false,
    layers: comp.layers.map((l, i) => ({
      index: i, id: l.id, name: l.name, type: l.type, src: l.src,
      window: `${l.start}-${l.end}s`, blend: l.blend,
      enabled: l.enabled, parent: l.parent, matte: l.trackMatte?.type ?? null,
      animated: animatedPaths(l),
      effects: l.effects.map((f) => ({ id: f.id, type: f.type, enabled: f.enabled })),
      masks: l.masks.map((m) => ({ id: m.id, mode: m.mode, points: m.points.length })),
    })),
  });

  /** Which properties on this layer are keyframed, and how many keys each has. */
  const animatedPaths = (l) => {
    const out = {};
    const keyed = (v) => v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.keys);
    for (const [k, v] of Object.entries(l.transform || {})) {
      if (keyed(v)) out[`transform.${k}`] = v.keys.length;
    }
    for (const f of l.effects || []) {
      for (const [k, v] of Object.entries(f.params || {})) {
        if (keyed(v)) out[`effects.${f.id}.${k}`] = v.keys.length;
      }
    }
    for (const m of l.masks || []) {
      for (const k of ["feather", "opacity", "expand"]) {
        if (keyed(m[k])) out[`masks.${m.id}.${k}`] = m[k].keys.length;
      }
    }
    return out;
  };

  const slugOf = (s) => safeName(s, "comp");

  return [
    /* ── discovery ───────────────────────────────────────────────────── */

    {
      name: "vfx_shape_preset",
      description:
        "Add a ready-made shape layer — the fastest way to see what shape layers do, and a "
        + "worked example of the three things that are easy to get wrong unaided.\n"
        + "· lineDraw — a polyline that draws itself. `points` is a FLAT list, "
        + "[x0,y0,x1,y1,...], measured from the centre of the comp.\n"
        + "· progressRing — a ring filling clockwise from twelve o'clock over a grey track. "
        + "`from_pct`/`to_pct` are where the fill starts and ends.\n"
        + "· burst — a sunburst: one ray repeated and rotated, so it shows the repeater.\n"
        + "Colours are [r,g,b] 0-255. Every preset is built by the same code the catalog "
        + "describes, so reading the layer it produces is a good way to learn the grammar "
        + "before writing a `shapes` array by hand.",
      inputSchema: {
        type: "object", required: ["slug", "preset"],
        properties: {
          slug: { type: "string" },
          preset: { type: "string", enum: ["lineDraw", "progressRing", "burst"] },
          name: { type: "string", description: "Layer name. The preset picks one if you do not." },
          index: { type: "integer", description: "0 = top of the stack (the default)." },
          points: { type: "array", items: { type: "number" }, description: "lineDraw: flat [x0,y0,x1,y1,...] from the comp centre." },
          color: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "[r,g,b] 0-255." },
          track: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "progressRing: the unfilled part's colour." },
          width: { type: "number", description: "Stroke width in pixels." },
          radius: { type: "number", description: "progressRing." },
          from_pct: { type: "number", description: "progressRing: where the fill starts, 0-100." },
          to_pct: { type: "number", description: "progressRing: where it ends, 0-100." },
          rays: { type: "integer", description: "burst: how many." },
          length: { type: "number", description: "burst: ray length." },
          inner: { type: "number", description: "burst: hole radius at the centre." },
          spin: { type: "number", description: "burst: degrees turned over the duration." },
          duration: { type: "number", description: "Seconds the built-in animation takes." },
          start: { type: "number", description: "Seconds before it begins." },
          cap: { type: "string", enum: ["butt", "round", "square"] },
          join: { type: "string", enum: ["miter", "round", "bevel"] },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "add_shape_preset", ...a });
        return { layer_id: r.layerId, preset: r.preset, items: r.items };
      },
    },
    {
      name: "vfx_shape_catalog",
      description:
        "THE SHAPE REFERENCE — CALL THIS BEFORE BUILDING A SHAPE LAYER. Lists all 16 item "
        + "types with every parameter, its default, its range and whether it animates.\n"
        + "A shape layer's `shapes` array is drawn IN ORDER, and the order is the usual "
        + "mistake: a path first (rect, ellipse, polystar, path), then any operations "
        + "(trim, repeater, offsetPath, roundCorners, zigzag, wiggle, merge), then the "
        + "paint last (fill, stroke, gradientFill, gradientStroke). A stroke placed before "
        + "a trim consumes the path, leaving the trim nothing to shorten — it renders, it "
        + "just silently ignores the trim.\n"
        + "Groups are 'Path', 'Path Operation', 'Paint' and 'Group' (a nested group with "
        + "its own transform). Filter with `group` or `search`.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Only items in this group." },
          search: { type: "string", description: "Substring match on name, label or purpose." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const { shapes } = await api("GET", "/api/vfx/shapes");
        const q = String(a.search || "").toLowerCase();
        const g = String(a.group || "").toLowerCase();
        let rows = Object.entries(shapes);
        if (g) rows = rows.filter(([, s]) => String(s.group || "").toLowerCase().includes(g));
        if (q) {
          rows = rows.filter(([n, s]) =>
            n.toLowerCase().includes(q)
            || String(s.label || "").toLowerCase().includes(q)
            || String(s.why || "").toLowerCase().includes(q));
        }
        if (!rows.length) {
          throw new Error(`No shape item matches that. Call vfx_shape_catalog with no arguments to see all ${Object.keys(shapes).length}.`);
        }
        return {
          count: rows.length,
          items: Object.fromEntries(rows.map(([name, spec]) => [name, {
            label: spec.label, group: spec.group, why: spec.why,
            params: Object.fromEntries(Object.entries(spec.params || {}).map(([p, d]) => [p, {
              type: d.type, default: d.default,
              range: d.min !== undefined ? `${d.min}..${d.max}` : undefined,
              options: d.options,
              animatable: !!d.animatable,
              desc: d.desc,
            }])),
          }])),
        };
      },
    },
    {
      name: "vfx_audio_keys",
      description:
        "Drive any animatable property from a sound. Analyses an audio file into seven "
        + "tracks — amplitude, bass, lowMid, highMid, treble, onset, and beat (a decaying "
        + "pulse on each detected beat) — and, if you pass `apply`, writes one of them "
        + "straight onto a property as keyframes.\n"
        + "Without `apply` you get the track lengths, the BPM and the beat/bar times, which "
        + "is the way to check the analysis before committing to it.\n"
        + "Tracks are 0..1. `min`/`max` map that onto what the property actually wants: "
        + "scale between 100 and 140, rotation between -8 and 8, opacity between 30 and "
        + "100. For a vector property (position, scale) the value drives every component "
        + "unless you name an `axis` — 0 for x, 1 for y — and then the others keep the "
        + "value they already had.\n"
        + "`audio` is a library file name: a song from the music library or a clip whose "
        + "sound you want. Not a path.\n"
        + "Bands bleed at the crossovers — a strong bass note shows a little in lowMid — so "
        + "the reply carries `bandDb` and `silentBands` and leaves the judgement to you.",
      inputSchema: {
        type: "object", required: ["audio"],
        properties: {
          audio: { type: "string", description: "Library file name — a song, or a clip with sound." },
          fps: { type: "number", description: "Keys per second. 30 default. A 3-minute song at 30fps is about 5400 keys per track." },
          tracks: { type: "array", items: { type: "string" }, description: "Only these tracks, e.g. ['bass','beat']. All seven by default." },
          from: { type: "number", description: "Analyse from this second." },
          to: { type: "number", description: "Analyse up to this second." },
          offset: { type: "number", description: "Shift every key by this many seconds — for audio that does not start at the comp's zero." },
          gain: { type: "number", description: "Multiply the tracks. 1 default." },
          floor: { type: "number", description: "Clamp the bottom of the range, 0..1 — stops a quiet passage flattening to nothing." },
          attack: { type: "number", description: "Seconds to rise. 0.01 default; larger is lazier." },
          release: { type: "number", description: "Seconds to fall. 0.20 default; larger holds the peak." },
          smooth: { type: "boolean", description: "Envelope smoothing, on by default." },
          beatDecay: { type: "number", description: "Seconds for a beat pulse to fall back to zero. 0.25 default." },
          epsilon: { type: "number", description: "Drop keys that change less than this — thins the list without changing the look." },
          ease: { type: "string", description: "Ease written onto every key. 'linear' default." },
          apply: {
            type: "object",
            description: "Write a track onto a property. Omit to only analyse.",
            properties: {
              slug: { type: "string", description: "Comp slug." },
              layerId: { type: "string", description: "Layer id or unambiguous name." },
              path: { type: "string", description: "Property path, e.g. 'transform.scale', 'effects.fx_1.amount', or 'shapes.1.end' to drive a trim." },
              track: { type: "string", description: "Which track drives it. 'amplitude' default." },
              min: { type: "number", description: "Value when the track reads 0." },
              max: { type: "number", description: "Value when the track reads 1." },
              axis: { type: "integer", description: "Vector properties: drive only this component (0=x, 1=y). All of them by default." },
            },
          },
        },
      },
      async run(a) {
        const r = await vfx({ action: "audio_keys", ...a });
        return r.applied
          ? { applied: r.applied, track: r.track, range: r.range, bpm: r.bpm, beats: r.beats }
          : { bpm: r.bpm, beats: r.beats, bars: r.bars, seconds: r.seconds, fps: r.fps,
              tracks: r.tracks, silentBands: r.silentBands, note: r.note };
      },
    },
    {
      name: "vfx_track_motion",
      description:
        "Follow a feature through a clip, and either pin a layer to it or cancel its "
        + "movement.\n"
        + "`rect` is the patch to track, [x, y, w, h] in the CLIP's own pixels — something "
        + "with contrast and a corner. apply.mode 'follow' writes the feature's path onto "
        + "the property, so a layer rides along with it; 'stabilize' writes the inverse, so "
        + "the shot holds still.\n"
        + "IT REPORTS LOSING THE SHOT rather than guessing. If the feature is occluded or "
        + "leaves frame, tracking STOPS at that point, `lostAt` names the second, and no "
        + "invented positions are ever written — a short key list with a lostAt is the "
        + "tracker being honest, not failing quietly. Widen `search` or pick a different "
        + "rect and run it again.\n"
        + "High confidence on repetitive texture (a striped shirt, a brick wall) is the one "
        + "failure confidence cannot see, so `margin` is reported per frame as well: when "
        + "it collapses the tracker had rivals it could not tell apart.\n"
        + "Give `rect2` as well to measure rotation and scale from the two points.\n"
        + "A track is 2D by nature. Applied to a 3D layer it writes [x, y] and the layer's z "
        + "falls back to the default — track a 3D layer only if you meant to flatten it.",
      inputSchema: {
        type: "object", required: ["clip", "rect"],
        properties: {
          clip: { type: "string", description: "Clip library name. Not a path." },
          rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x, y, w, h] in clip pixels — the patch to follow." },
          rect2: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "A second patch; enables rotation and scale." },
          search: { type: "integer", description: "How many pixels each way to look per frame. 40 default — raise it for fast motion." },
          minConfidence: { type: "number", description: "Below this the frame counts as bad. 0.55 default." },
          lostAfter: { type: "integer", description: "Consecutive bad frames before the track is declared lost. 2 default." },
          stopOnLost: { type: "boolean", description: "Stop at the loss (default) rather than carrying on past it." },
          fromTime: { type: "number", description: "Start tracking at this second." },
          toTime: { type: "number", description: "Stop at this second." },
          adapt: { type: "number", description: "Blend the current patch into the template, 0..1. Off by default — it bakes in drift." },
          adaptAbove: { type: "number", description: "Only adapt when confidence is above this. 0.90 default." },
          stabilize: { type: "boolean", description: "Also compute the inverse-motion keys. On by default." },
          anchor: { type: "array", items: { type: "number" }, description: "[x, y] the stabilised shot settles on. Clip centre by default." },
          timeOrigin: { type: "number", description: "Comp time the clip's first frame sits at, so the keys land in the right place." },
          apply: {
            type: "object",
            description: "Write the result onto a property. Omit to only track.",
            properties: {
              slug: { type: "string", description: "Comp slug." },
              layerId: { type: "string", description: "Layer id or unambiguous name." },
              path: { type: "string", description: "Property path. 'transform.position' by default." },
              mode: { type: "string", enum: ["follow", "stabilize"], description: "follow = ride with the feature; stabilize = cancel its motion." },
            },
          },
        },
      },
      async run(a) {
        const r = await vfx({ action: "track_motion", ...a });
        return {
          applied: r.applied, mode: r.mode, frames: r.frames, fps: r.fps,
          lostAt: r.lostAt, confidence: r.confidence, dips: r.dips, note: r.note,
        };
      },
    },
    {
      name: "vfx_effects_catalog",
      description:
        "THE EFFECT REFERENCE — CALL THIS BEFORE YOU ADD OR SET ANY EFFECT. It lists every "
        + "effect the engine has, grouped, each with what it is for and every parameter it "
        + "takes: type, default, min, max, the options an enum accepts, and whether that "
        + "parameter can be keyframed. NEVER guess an effect name or a parameter name — a "
        + "guessed name is rejected, and a guessed RANGE is worse, because it is accepted and "
        + "renders wrong. Filter with `group` (e.g. 'Blur & Sharpen', 'Color', 'Keying', "
        + "'Stylize', 'Distort', 'Generate', 'Time', 'Matte') or `search` when the full list "
        + "is more than you need.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Only effects in this group." },
          search: { type: "string", description: "Substring match on name, label or purpose." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const { effects } = await api("GET", "/api/vfx/catalog");
        const q = String(a.search || "").toLowerCase();
        const rows = Object.entries(effects).filter(([name, spec]) => {
          if (a.group && spec.group !== a.group) return false;
          if (!q) return true;
          return `${name} ${spec.label ?? ""} ${spec.why ?? ""}`.toLowerCase().includes(q);
        });
        if (!rows.length) throw new Error(`No effect matches that. Call vfx_effects_catalog with no arguments to see all ${Object.keys(effects).length}.`);
        return {
          count: rows.length,
          effects: Object.fromEntries(rows.map(([name, spec]) => [name, {
            label: spec.label, group: spec.group, why: spec.why,
            params: Object.fromEntries(Object.entries(spec.params || {}).map(([p, d]) => [p, {
              type: d.type, default: d.default,
              range: d.min !== undefined ? `${d.min}..${d.max}` : undefined,
              options: d.options,
              animatable: !!d.animatable,
            }])),
          }])),
        };
      },
    },

    {
      name: "vfx_templates",
      description:
        "START HERE FOR ANYTHING THAT HAS A NAME FOR IT. A template builds a finished, "
        + "animated composition in one call — keyframes, effects and all — where "
        + "vfx_create_comp gives you an empty canvas you then have to fill a layer at a "
        + "time. Call with no arguments to list them; call with `template` to create one, "
        + "which returns the new comp's slug.\n"
        + "Everything is optional and every parameter has a working default, so "
        + "{ template: 'titleCard' } is a valid call. Override with `params`. Sizes are in "
        + "PIXELS, colours are [r,g,b] or [r,g,b,a] each 0-255, times are in SECONDS. "
        + "A parameter documented as 'auto' scales itself to the comp — leave it out unless "
        + "you have a reason.\n"
        + "SOURCES ARE LIBRARY NAMES, never paths: `image`/`clip`/`logo`/`plate`/`left`/"
        + "`right` take a name as list-images or list-clips reports it. Leave one out and "
        + "that layer becomes a solid placeholder so the comp still renders — the reply "
        + "names every layer that happened to.\n"
        + "The comp is created and saved; it is NOT rendered. Look at it with "
        + "vfx_preview_frame (pick a `t` while something is moving — a title card at t=0 is "
        + "a black frame and tells you nothing), edit it with the ordinary vfx_set_* tools, "
        + "then vfx_render.\n\n"
        + "  " + describeTemplates(),
      inputSchema: {
        type: "object",
        properties: {
          template: { type: "string", description: "Which template to create. Omit to list them all." },
          params: {
            type: "object",
            description: "The template's own parameters, as described above. Unknown names are rejected with the list of real ones.",
            additionalProperties: true,
          },
          name: { type: "string", description: "Comp name. Defaults to the template's label." },
          width: { type: "integer", description: "16-4096. Default 1920." },
          height: { type: "integer", description: "16-4096. Default 1080." },
          fps: { type: "number", description: "1-120. Default 30." },
          duration: { type: "number", description: "Seconds. Each template has its own default and its own minimum." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (!a.template) {
          return { count: listTemplates().length, templates: listTemplates() };
        }
        const r = await vfx({
          action: "from_template", template: a.template, params: a.params,
          name: a.name, width: a.width, height: a.height, fps: a.fps, duration: a.duration,
        });
        return {
          slug: r.slug, template: r.template,
          comp: summary(r.comp),
          sources: r.sources, placeholders: r.placeholders, note: r.note,
          next: `vfx_preview_frame { slug: "${r.slug}", t: ${(r.comp.duration * 0.5).toFixed(2)} } to see it.`,
        };
      },
    },

    /* ── comps ───────────────────────────────────────────────────────── */

    {
      name: "vfx_list_comps",
      description:
        "Every composition, newest edit first, with its size, frame rate, length in seconds "
        + "and layer count. Start here — a comp is the unit of work, and its `slug` is what "
        + "every other vfx tool takes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return (await api("GET", "/api/vfx/comps")).comps; },
    },

    {
      name: "vfx_create_comp",
      description:
        "Start a composition — a canvas with a length, like an After Effects comp. "
        + "width/height 16-4096 pixels (default 1920x1080), fps 1-120 (default 30), "
        + "duration 0.1-600 seconds (default 8). `bg` is [r,g,b,a] each 0-255 and defaults "
        + "to fully transparent [0,0,0,0], which is what you want if this comp will be "
        + "composited over something else; use [0,0,0,255] for black.",
      inputSchema: {
        type: "object", required: ["name"],
        properties: {
          name: { type: "string" },
          width: { type: "integer" }, height: { type: "integer" },
          fps: { type: "number" }, duration: { type: "number" },
          bg: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "create", name: a.name, width: a.width, height: a.height, fps: a.fps, duration: a.duration, bg: a.bg });
        return { slug: r.slug, comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_get_comp",
      description:
        "The whole composition: every layer in stack order (index 0 is the TOP, painted "
        + "last — After Effects order), which of its properties are keyframed and how many "
        + "keys each has, its effects with their ids, its masks, its track matte. Also "
        + "returns `renders` — the render jobs for this comp with their progress, which is "
        + "how you poll one started by vfx_render or vfx_export_studio. "
        + "Read this before editing: layer ids and effect ids come from here. "
        + "`full: true` returns the raw document with every keyframe value in it.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" }, full: { type: "boolean" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("GET", `/api/vfx/comp/${encodeURIComponent(slugOf(a.slug))}`);
        return a.full
          ? { comp: r.comp, renders: r.renders }
          : { comp: summary(r.comp), renders: r.renders };
      },
    },

    {
      name: "vfx_set_comp",
      description:
        "Change the composition itself: name, width/height (16-4096), fps (1-120), duration "
        + "(0.1-600 seconds), background colour [r,g,b,a] 0-255, timeline markers, and the "
        + "motion blur switch. Motion blur is a comp-level switch AND a per-layer opt-in — "
        + "turning it on here does nothing until a layer sets motion_blur too (vfx_set_layer). "
        + "`shutter` is the shutter angle in degrees, 1-720, where 180 is the film default; "
        + "`samples` 2-64 is how many sub-frames get averaged, and it costs linearly. "
        + "Shortening the duration trims any layer that ended past the new end; it does not "
        + "rescale anything, and changing width/height does not move or rescale layers either.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" }, name: { type: "string" },
          width: { type: "integer" }, height: { type: "integer" },
          fps: { type: "number" }, duration: { type: "number" },
          bg: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          motion_blur: { type: "boolean" },
          shutter: { type: "number", description: "Shutter angle in degrees, 1-720. 180 is the film default." },
          samples: { type: "integer", description: "Motion blur sub-frames, 2-64." },
          seed: {
            type: "integer",
            description:
              "The comp's noise seed. Every wiggle() and random() in every expression derives "
              + "from it, so changing it re-rolls all of them at once — and leaves each one "
              + "reproducible, which is why the same frame rendered twice is identical pixels. "
              + "Change it when the wiggle is right in character but wrong in detail.",
          },
          markers: {
            type: "array",
            description: "Replaces the marker list. Each { t: seconds, label }.",
            items: { type: "object", properties: { t: { type: "number" }, label: { type: "string" } } },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const mb = {};
        if (a.motion_blur !== undefined) mb.enabled = a.motion_blur;
        if (a.shutter !== undefined) mb.shutter = a.shutter;
        if (a.samples !== undefined) mb.samples = a.samples;
        const r = await vfx({
          action: "set_comp", slug: a.slug, name: a.name, width: a.width, height: a.height,
          fps: a.fps, duration: a.duration, bg: a.bg, markers: a.markers, seed: a.seed,
          motionBlur: Object.keys(mb).length ? mb : undefined,
        });
        return { comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_delete_comp",
      description:
        "Delete a composition and everything under it — its document, its cached preview "
        + "frames and any png sequences rendered into its folder. Clips it rendered into the "
        + "clips library are NOT deleted. This cannot be undone.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" } }, additionalProperties: false,
      },
      async run(a) { await vfx({ action: "delete", slug: a.slug }); return { deleted: a.slug }; },
    },

    /* ── layers ──────────────────────────────────────────────────────── */

    {
      name: "vfx_add_layer",
      description:
        "Add a layer. It lands at the TOP of the stack (index 0, painted last, in front of "
        + "everything) unless you give an `index`. A comp holds at most 64 layers.\n"
        + "Types: image (a still from the images library), video (a clip from the clips "
        + "library), solid (a flat rectangle of `color`, the full size of the comp), text, "
        + "adjustment (applies its effects to everything beneath it), null (renders nothing — "
        + "a handle to parent other layers to), shape (vector geometry drawn from a `shapes` "
        + "list — see vfx_shape_catalog), camera (a viewpoint; only layers with threeD:true "
        + "respond to it, and a comp uses the topmost one), comp (another comp nested as a "
        + "layer — set `src` to the child's slug).\n"
        + "`src` is a LIBRARY NAME, never a path — 'raven.png' from list_images, "
        + "'clip_x.mp4' from the clips library. A path is refused.\n"
        + "`start`/`end` are the layer's visibility window on the comp timeline in seconds "
        + "and default to the whole comp; a video layer ends at its own length if that is "
        + "shorter. " + UNITS,
      inputSchema: {
        type: "object", required: ["slug", "type"],
        properties: {
          slug: { type: "string" },
          type: { type: "string", enum: ["image", "video", "solid", "text", "shape", "adjustment", "null", "camera", "comp"] },
          src: { type: "string", description: "Library NAME for image/video layers, or the SLUG of the child comp for a comp layer. Never a path." },
          compSlug: { type: "string", description: "Deprecated alias for `src` on a comp layer. Prefer src." },
          threeD: { type: "boolean", description: "Opt this layer into 3D space, so a camera moves it and its transform vectors take a third component [x,y,z]." },
          shapes: {
            type: "array",
            description:
              "shape layers: the item list, drawn in order. Paths first (rect, ellipse, "
              + "polystar, path), then any operations (trim, repeater, offsetPath, "
              + "roundCorners, zigzag, wiggle, merge), then the paint (fill, stroke, "
              + "gradientFill, gradientStroke). ORDER MATTERS and is the usual mistake: a "
              + "stroke listed before a trim consumes the path first, and the trim then has "
              + "nothing left to shorten. Call vfx_shape_catalog for every item type, its "
              + "parameters and which of them animate.",
            items: { type: "object" },
          },
          name: { type: "string" },
          index: { type: "integer", description: "0 = top of the stack (the default)." },
          start: { type: "number", description: "Seconds on the comp timeline." },
          end: { type: "number", description: "Seconds on the comp timeline." },
          color: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "solid layers: [r,g,b,a] 0-255." },
          text: {
            type: "object",
            description: "text layers. content; font is a system font FILE NAME like 'georgia.ttf'; size in pixels; color [r,g,b,a] 0-255; align left|center|right; stroke in pixels; lineHeight as a multiple; tracking in pixels.",
            additionalProperties: true,
          },
          blend: { type: "string", description: "normal, multiply, screen, overlay, softlight, hardlight, add, subtract, difference, darken, lighten, colordodge, colorburn, hue, saturation, color, luminosity." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({
          action: "add_layer", slug: a.slug, type: a.type,
          // A comp layer's src is a SLUG, not a filename, so it must not go
          // through the library-name sanitiser that strips path-ish characters.
          src: a.type === "comp" ? (a.src ?? a.compSlug) : (a.src ? safeName(a.src, "source") : undefined),
          compSlug: a.compSlug,
          name: a.name, index: a.index, start: a.start, end: a.end, color: a.color, text: a.text, blend: a.blend,
          shapes: a.shapes, threeD: a.threeD,
        });
        return { layer_id: r.layerId, comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_set_layer",
      description:
        "Change a layer's own settings — everything except its effects, masks and matte, "
        + "which have their own tools.\n"
        + "`transform` is merged one property at a time, so setting rotation alone leaves "
        + "position (and its keyframes) untouched. Each of the five may be a constant here; "
        + "to ANIMATE one use vfx_set_property or vfx_add_keyframe instead. " + UNITS + "\n"
        + "`parent` is another layer's id: this layer's transform is then applied on top of "
        + "its parent's, so moving the parent moves the child. Loops are refused. Pass null "
        + "to unparent.\n"
        + "`time_scale` 1 is normal speed, 2 is twice as fast, negative plays it backwards; "
        + "`in_point` is which second of the SOURCE is showing when the layer starts.\n"
        + "`solo` hides every non-soloed layer while any layer is soloed. A layer's type "
        + "cannot be changed — add a new one instead.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          name: { type: "string" }, src: { type: "string", description: "Library NAME, not a path." },
          enabled: { type: "boolean" }, solo: { type: "boolean" }, locked: { type: "boolean" },
          blend: { type: "string" },
          start: { type: "number" }, end: { type: "number" },
          in_point: { type: "number" }, time_scale: { type: "number" },
          parent: { type: ["string", "null"] },
          motion_blur: { type: "boolean", description: "Per-layer opt-in; the comp switch must be on too." },
          color: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          text: { type: "object", additionalProperties: true },
          transform: {
            type: "object",
            description:
              "Any of anchor [x,y], position [x,y], scale [x,y] percent, rotation degrees, "
              + "opacity 0-100. On a THREE_D layer anchor/position/scale each take an "
              + "optional third component, [x,y,z] — both lengths are accepted.",
            additionalProperties: true,
          },
          three_d: {
            type: "boolean",
            description:
              "Put this layer in 3D space, so a camera moves it and its transform vectors "
              + "may carry a z. A 2D layer is untouched by every camera in the comp.",
          },
          rotation_x: { type: "number", description: "Degrees about X. Does nothing until three_d is on. Keyframe it with vfx_set_property path 'rotationX'." },
          rotation_y: { type: "number", description: "Degrees about Y. Does nothing until three_d is on." },
          rotation_z: { type: "number", description: "Degrees about Z. Does nothing until three_d is on." },
          camera: {
            type: "object",
            description:
              "Camera layers only. zoom is the focal length in pixels (1778 is roughly a "
              + "50mm on a 1920-wide comp). Turn depthOfField on and aperture/focusDistance "
              + "start to matter. The TOPMOST camera in the comp is the one that renders.",
            properties: {
              zoom: { type: "number" }, depthOfField: { type: "boolean" },
              aperture: { type: "number" }, focusDistance: { type: "number" },
              focalLength: { type: "number", description: "mm on 36mm film; another way of saying zoom." },
              blurLevel: { type: "number", description: "How strongly depth of field blurs, in percent." },
              pointOfInterest: {
                type: "array", items: { type: "number" }, minItems: 3, maxItems: 3,
                description:
                  "[x, y, z] in comp pixels — the spot the lens looks at. OMIT it to leave the "
                  + "camera free and aim it with rotationX/Y/Z instead; without it the lens does "
                  + "not turn at all, so a camera can be moved and never aimed.",
              },
            },
          },
          collapse: { type: "boolean", description: "Comp layers: continuous rasterisation, so a precomp scaled up stays sharp instead of showing the 100% raster." },
          preserve_transparency: {
            type: "boolean",
            description:
              "AE's T switch: the layer paints ONLY where what is already beneath it is "
              + "opaque, so it is masked by the composite so far rather than by a shape.",
          },
          origin: {
            type: "string", enum: ["center", "topleft"],
            description:
              "Shape layers: whether an item's coordinates are measured from the layer's "
              + "centre (the default, and what every preset assumes) or its top-left corner.",
          },
          frame_blend: { type: "string", enum: ["off", "mix"], description: "Retimed footage lands between two source frames. 'off' snaps to the nearest (the judder); 'mix' crossfades them." },
          shapes: {
            type: "array",
            description:
              "Shape layers: the whole item list, replacing what is there. Drawn IN ORDER — "
              + "paths, then operations, then paint. A stroke placed before a trim consumes "
              + "the path and the trim is silently ignored. vfx_shape_catalog lists all 16 "
              + "types with their parameters.",
            items: { type: "object", additionalProperties: true },
          },
          animators: {
            type: "array",
            description: "Text layers: per-character animation. Each entry is a selector plus the properties it drives.",
            items: { type: "object", additionalProperties: true },
          },
          styles: { type: ["object", "null"], additionalProperties: true, description: "Layer styles (drop shadow, glow, stroke). null clears them." },
          width: { type: "integer", description: "Solid layers only — its own pixel size. Other layers scale with transform.scale." },
          height: { type: "integer", description: "Solid layers only." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({
          action: "set_layer", slug: a.slug, layerId: a.layer_id, name: a.name,
          src: a.src ? safeName(a.src, "source") : undefined,
          enabled: a.enabled, solo: a.solo, locked: a.locked, blend: a.blend,
          start: a.start, end: a.end, inPoint: a.in_point, timeScale: a.time_scale,
          parent: a.parent, motionBlur: a.motion_blur, color: a.color, text: a.text,
          transform: a.transform,
          threeD: a.three_d, rotationX: a.rotation_x, rotationY: a.rotation_y,
          rotationZ: a.rotation_z, camera: a.camera,
          preserveTransparency: a.preserve_transparency, origin: a.origin,
          collapse: a.collapse, frameBlend: a.frame_blend, shapes: a.shapes,
          animators: a.animators, styles: a.styles, width: a.width, height: a.height,
        });
        return { comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_remove_layer",
      description:
        "Take a layer out of the stack. Anything parented to it is unparented, and a layer "
        + "that was using it as its track matte has that matte cleared — because under the "
        + "'matte is the layer directly above' rule it would otherwise start keying off a "
        + "different picture without saying so.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: { slug: { type: "string" }, layer_id: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "remove_layer", slug: a.slug, layerId: a.layer_id });
        return { comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_duplicate_layer",
      description:
        "Copy a layer — its transform, every keyframe, its effects and its masks — and place "
        + "the copy directly above the original. The copy gets fresh ids all the way down, so "
        + "a keyframe written against it cannot land on the original.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: { slug: { type: "string" }, layer_id: { type: "string" }, name: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "duplicate_layer", slug: a.slug, layerId: a.layer_id, name: a.name });
        return { layer_id: r.layerId, comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_reorder_layer",
      description:
        "Move a layer to another position in the stack. Index 0 is the TOP — painted last, in "
        + "front of everything. Order decides what covers what, and it is also what track "
        + "mattes read, since a matte always uses the layer directly above.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "to_index"],
        properties: { slug: { type: "string" }, layer_id: { type: "string" }, to_index: { type: "integer" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "reorder_layer", slug: a.slug, layerId: a.layer_id, toIndex: a.to_index });
        return { comp: summary(r.comp) };
      },
    },

    /* ── properties and keyframes ────────────────────────────────────── */

    {
      name: "vfx_set_property",
      description:
        "Set an animatable property, either to a CONSTANT or to a whole set of KEYFRAMES in "
        + "one call — pass `value` for one, `keys` for the other. Passing `keys` replaces any "
        + "animation that was there; passing `value` throws the animation away and pins it.\n"
        + PATHS + " " + UNITS + "\n"
        + "A key is { t: seconds, v: value, ease }. `v` must match the property's arity — two "
        + "numbers for position/anchor/scale, one for rotation/opacity and for every numeric "
        + "effect parameter. `ease` describes the segment LEAVING that key and is one of "
        + "linear (default), hold (jump, no movement until the next key), easeIn, easeOut, "
        + "easeInOut, or { bezier: [x1,y1,x2,y2] } with CSS cubic-bezier meaning. Before the "
        + "first key the value holds the first; after the last it holds the last.\n"
        + "Effect parameters are animatable only where the catalog says animatable: true — "
        + "call vfx_effects_catalog first.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "path"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          path: { type: "string", description: "e.g. transform.position, effects.fx_1a2b.radius" },
          value: { description: "A constant: a number, or an array of numbers." },
          keys: {
            type: "array",
            description: "Keyframes: [{ t, v, ease? }]. Given in any order; they are sorted.",
            items: {
              type: "object", required: ["t", "v"],
              properties: { t: { type: "number" }, v: {}, ease: {} },
            },
          },
          expr: {
            type: ["string", "null"],
            description:
              "An expression, evaluated every frame. It LAYERS OVER the property rather than "
              + "replacing it: whatever the property already is — a constant or keyframes — "
              + "stays underneath, and the expression reads it as `value`. Pass null or an "
              + "empty string to remove one and get that underlying value back.\n"
              + "Available: value, time, wiggle(freq, amp), random(), linear(t, a, b, c, d), "
              + "ease(t, a, b, c, d), loopIn(), loopOut(), valueAtTime(t), velocity(), and "
              + "links to another layer's properties by path.\n"
              + "Examples: 'value * 2' · 'wiggle(2, 30)' — jitter twice a second by 30 · "
              + "'linear(time, 0, 3, 0, 100)' — 0 to 100 over three seconds.\n"
              + "It is a sandbox, not Python: imports, attribute access and dunder names are "
              + "refused. An expression that fails at render time leaves the property at its "
              + "underlying value rather than failing the frame — so if a render looks "
              + "un-expressed, suspect the expression before the wiring.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.value === undefined && a.keys === undefined && a.expr === undefined) {
          throw new Error("Give `value` (a constant), `keys` (the animation), or `expr` (an expression).");
        }
        const r = await vfx({
          action: "set_prop", slug: a.slug, layerId: a.layer_id, path: a.path,
          value: a.value, keys: a.keys, expr: a.expr,
        });
        // The route answers with the CANONICAL path — "opacity" lands on
        // transform.opacity, and echoing back what was asked would hide that.
        return { path: r.path, animated: r.keys || false, value: r.value, expr: r.expr };
      },
    },

    {
      name: "vfx_add_keyframe",
      description:
        "Put ONE keyframe on a property at a moment — the stopwatch. If the property is still "
        + "a constant this is what turns it into an animation, and if you leave `v` out the "
        + "key holds exactly what it was worth before, so nothing jumps the instant it becomes "
        + "animated. Setting a key at a time that already has one replaces it.\n"
        + PATHS + " " + UNITS + "\n"
        + "`ease` shapes the segment LEAVING this key: linear (default), hold, easeIn, "
        + "easeOut, easeInOut, or { bezier: [x1,y1,x2,y2] }. Two keys with the same value and "
        + "easeIn/easeOut between them is the whole grammar of a move that starts and stops "
        + "instead of sliding.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "path", "t"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          path: { type: "string" },
          t: { type: "number", description: "Seconds on the comp timeline." },
          v: { description: "The value. Omit to hold whatever the property is worth at t." },
          ease: { description: "linear | hold | easeIn | easeOut | easeInOut | { bezier: [x1,y1,x2,y2] }" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "add_key", slug: a.slug, layerId: a.layer_id, path: a.path, t: a.t, v: a.v, ease: a.ease });
        return { path: r.path, keys: r.keys };
      },
    },

    {
      name: "vfx_remove_keyframe",
      description:
        "Take one keyframe off a property at time `t` in seconds, matched to the nearest "
        + "millisecond. "
        + "Removing the LAST key turns the property back into a constant holding the value it "
        + "had at that moment, so undoing an animation does not also move the layer. " + PATHS,
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "path", "t"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          path: { type: "string" }, t: { type: "number", description: "Seconds." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "remove_key", slug: a.slug, layerId: a.layer_id, path: a.path, t: a.t });
        return { path: r.path, keys: r.keys, now_a_constant: r.keys === 0 };
      },
    },

    /* ── effects ─────────────────────────────────────────────────────── */

    {
      name: "vfx_add_effect",
      description:
        "Add an effect to a layer. CALL vfx_effects_catalog FIRST — it is the only place the "
        + "effect names, the parameter names and their real ranges are written down, and a "
        + "parameter this tool does not recognise is refused rather than silently ignored. "
        + "Anything you leave out takes the catalog's default.\n"
        + "Effects run TOP TO BOTTOM, so order changes the result: blur-then-glow and "
        + "glow-then-blur are different shots. New effects go on the end unless you give an "
        + "`index`. At most 24 per layer. Numeric parameters marked animatable in the catalog "
        + "can be keyframed afterwards with vfx_set_property on effects.<effect_id>.<param>.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "type"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          type: { type: "string", description: "An effect name from vfx_effects_catalog." },
          params: { type: "object", description: "Parameter values. Names and ranges come from the catalog.", additionalProperties: true },
          index: { type: "integer", description: "Position in the stack; default is last." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "add_effect", slug: a.slug, layerId: a.layer_id, type: a.type, params: a.params, index: a.index });
        const layer = r.comp.layers.find((l) => l.id === a.layer_id) || {};
        return { effect_id: r.effectId, stack: (layer.effects || []).map((f) => f.type) };
      },
    },

    {
      name: "vfx_set_effect",
      description:
        "Change an effect's parameters or switch it off without removing it. `params` is a "
        + "PATCH — the ones you name change and the rest keep their value (and their "
        + "keyframes). Pass null for a parameter to put it back to the catalog default. To "
        + "ANIMATE a parameter use vfx_set_property on effects.<effect_id>.<param> instead. "
        + "Parameter names and ranges: vfx_effects_catalog.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "effect_id"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          effect_id: { type: "string", description: "The fx_ id, or the effect's type if the layer has only one of them." },
          params: { type: "object", additionalProperties: true },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "set_effect", slug: a.slug, layerId: a.layer_id, fxId: a.effect_id, params: a.params, enabled: a.enabled });
        const layer = r.comp.layers.find((l) => l.id === a.layer_id) || {};
        return { effects: (layer.effects || []).map((f) => ({ id: f.id, type: f.type, enabled: f.enabled, params: f.params })) };
      },
    },

    {
      name: "vfx_remove_effect",
      description: "Take an effect off a layer. Its keyframes go with it.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "effect_id"],
        properties: { slug: { type: "string" }, layer_id: { type: "string" }, effect_id: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "remove_effect", slug: a.slug, layerId: a.layer_id, fxId: a.effect_id });
        const layer = r.comp.layers.find((l) => l.id === a.layer_id) || {};
        return { stack: (layer.effects || []).map((f) => f.type) };
      },
    },

    {
      name: "vfx_reorder_effect",
      description:
        "Move an effect within a layer's stack. Effects run top to bottom and the order is "
        + "the look: a glow over a blur spreads soft light, a blur over a glow smears it. "
        + "Index 0 runs first.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "effect_id", "to_index"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          effect_id: { type: "string" }, to_index: { type: "integer" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "reorder_effect", slug: a.slug, layerId: a.layer_id, fxId: a.effect_id, toIndex: a.to_index });
        const layer = r.comp.layers.find((l) => l.id === a.layer_id) || {};
        return { stack: (layer.effects || []).map((f) => f.type) };
      },
    },

    /* ── masks and mattes ────────────────────────────────────────────── */

    {
      name: "vfx_add_mask",
      description:
        "Cut a shape out of a layer. `points` is a closed polygon in COMP pixels — at least "
        + "three [x,y] pairs; the last joins back to the first.\n"
        + "mode 'add' shows only what is inside the shape, 'subtract' hides what is inside, "
        + "'none' switches the mask off without deleting it. `feather` is the softness of the "
        + "edge in pixels, `expand` grows (positive) or shrinks (negative) the shape in "
        + "pixels, `opacity` 0-100 is how much the mask bites, and `invert` flips inside for "
        + "outside. feather, opacity and expand are all animatable "
        + "(vfx_set_property on masks.<mask_id>.<feather|opacity|expand>); the POINTS are not. "
        + "At most 24 masks per layer.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id", "points"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          points: { type: "array", description: "[[x,y], …] in comp pixels, at least 3.", items: { type: "array", items: { type: "number" } } },
          mode: { type: "string", enum: ["add", "subtract", "none"] },
          feather: { type: "number", description: "Edge softness in pixels." },
          opacity: { type: "number", description: "0-100." },
          expand: { type: "number", description: "Pixels; negative shrinks." },
          invert: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({
          action: "add_mask", slug: a.slug, layerId: a.layer_id, points: a.points,
          mode: a.mode, feather: a.feather, opacity: a.opacity, expand: a.expand, invert: a.invert,
        });
        return { mask_id: r.maskId };
      },
    },

    {
      name: "vfx_set_matte",
      description:
        "Use the layer DIRECTLY ABOVE this one as a matte — After Effects' rule, so the "
        + "stacking order IS the wiring. 'alpha' keeps this layer where the one above is "
        + "opaque; 'luma' keeps it where the one above is bright; 'alphaInv' and 'lumaInv' "
        + "are those inverted. The matte layer itself stops being drawn. Pass type null to "
        + "clear it. A layer at index 0 has nothing above it, so setting a matte there is "
        + "refused — move it down first.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          type: { type: ["string", "null"], enum: ["alpha", "luma", "alphaInv", "lumaInv", null] },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "set_matte", slug: a.slug, layerId: a.layer_id, type: a.type ?? null });
        return { comp: summary(r.comp) };
      },
    },

    {
      name: "vfx_precompose",
      description:
        "Move a group of layers into a composition of their own, so the whole group can be "
        + "transformed, masked or effected as one thing. The named layers leave this comp and "
        + "appear in a new one at the same pixel size, frame rate and length in seconds; a disabled placeholder layer "
        + "is left in their place.\n"
        + "It is a placeholder and not a live nested render, and that matters: to see the "
        + "group again you render the child comp with vfx_render format 'mov' (which keeps "
        + "alpha) and then point the placeholder at that clip with vfx_set_layer "
        + "{ src: <the clip>, enabled: true }. The reply spells this out in `next`.",
      inputSchema: {
        type: "object", required: ["slug", "layer_ids"],
        properties: {
          slug: { type: "string" },
          layer_ids: { type: "array", items: { type: "string" } },
          name: { type: "string", description: "Name for the new comp." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "precompose", slug: a.slug, layerIds: a.layer_ids, name: a.name });
        return { precomp_slug: r.precompSlug, placeholder_layer_id: r.layerId, next: r.next };
      },
    },

    /* ── seeing it, and getting it out ───────────────────────────────── */

    {
      name: "vfx_preview_frame",
      description:
        "Render ONE frame and hand back a URL you can fetch — this is how you SEE what you "
        + "have built instead of reasoning about a JSON document. Do it after every "
        + "meaningful change; a comp that reads correctly and looks wrong is the normal case.\n"
        + "`t` is the moment in seconds (0 to the comp's duration). `scale` 0.05-1 renders "
        + "smaller and faster — 0.5 is the working preview and is plenty to judge a "
        + "composition, colour or timing by. `draft` skips motion blur and the expensive "
        + "effect paths and is on by default below full scale; turn it off when you are "
        + "judging the final look. Frames are cached per edit, so asking for the same moment "
        + "twice is free until you change something.",
      inputSchema: {
        type: "object", required: ["slug", "t"],
        properties: {
          slug: { type: "string" },
          t: { type: "number", description: "Seconds on the comp timeline." },
          scale: { type: "number", description: "0.05-1. Default 1." },
          draft: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const q = new URLSearchParams({ t: String(a.t), meta: "1" });
        if (a.scale !== undefined) q.set("scale", String(a.scale));
        if (a.draft !== undefined) q.set("draft", a.draft ? "1" : "0");
        const r = await api("GET", `/api/vfx/frame/${encodeURIComponent(slugOf(a.slug))}?${q}`, undefined, 180_000);
        return {
          url: `${BASE}${r.url}`,
          width: r.width, height: r.height, t: r.t, scale: r.scale, draft: r.draft,
          render_ms: r.ms, from_cache: r.cached,
        };
      },
    },

    {
      name: "vfx_render",
      description:
        "Render the composition to a file and return a JOB ID — it does not block. Poll "
        + "vfx_get_comp and read `renders` for progress, the finished clip name, or the error.\n"
        + "format 'mp4' is the normal delivery, 'mov' is qtrle and KEEPS ALPHA (use it for a "
        + "precomp or anything that goes over something else), 'png' writes a numbered frame "
        + "sequence into the comp's folder. mp4 and mov land in the clips library, where the "
        + "Studio timeline and every clip tool can see them.\n"
        + "`from`/`to` in seconds render a range instead of the whole comp. `crf` 0-51 is "
        + "quality, lower is better and 18 is visually lossless. `scale` 0.05-1 renders "
        + "smaller. `draft` skips motion blur and expensive paths — good for a timing check, "
        + "wrong for delivery.\n"
        + "This is python compositing: budget 1-4 seconds PER FRAME at 1080p with effects, so "
        + "an 8-second comp at 30fps is minutes, not seconds. It also waits for the music "
        + "engine to be idle before it starts, so a song in the queue delays it.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          format: { type: "string", enum: ["mp4", "mov", "png"] },
          from: { type: "number" }, to: { type: "number" },
          crf: { type: "integer", description: "0-51, lower is better. Default 18." },
          scale: { type: "number", description: "0.05-1. Default 1." },
          draft: { type: "boolean" },
          codec: { type: "string", description: "Default 'auto' — h264_nvenc when present, else libx264." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({
          action: "render", slug: a.slug, format: a.format, from: a.from, to: a.to,
          crf: a.crf, scale: a.scale, draft: a.draft, codec: a.codec,
        });
        return { job_id: r.jobId, format: r.format, clip: r.clip, poll: `vfx_get_comp { slug: "${a.slug}" } → renders` };
      },
    },

    {
      name: "vfx_import_studio",
      description:
        "Turn a saved Studio timeline into a composition: every video item becomes a layer "
        + "sitting where it sat in time, with the same in-point, and the comp takes the "
        + "project's export size and frame rate. `project` is the project's name as "
        + "list-projects shows it.\n"
        + "A composition renders PICTURES — it has no audio track — so audio items are "
        + "recorded as markers at their start times in seconds rather than dropped silently, and the "
        + "comp's length follows the picture, not the song. Put the music back on the Studio "
        + "timeline when you export. Any clip the project referenced that is no longer in the "
        + "library is listed in `missing_sources` rather than failing the import.",
      inputSchema: {
        type: "object", required: ["project"],
        properties: {
          project: { type: "string", description: "The Studio project name (with or without .json)." },
          name: { type: "string", description: "Name for the new comp; defaults to the project's." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "import_studio", project: a.project, name: a.name });
        return {
          slug: r.slug, layers: r.layers, audio_as_markers: r.audioAsMarkers,
          missing_sources: r.missingSources, comp: summary(r.comp), note: r.note,
        };
      },
    },

    {
      name: "vfx_export_studio",
      description:
        "Render the composition and drop the finished clip onto a Studio timeline — the way "
        + "a comp becomes part of a longer edit. `project` names the Studio project; an "
        + "existing one is appended to, a new one is created. The clip lands at the end of the "
        + "first video track unless you give `start` in seconds.\n"
        + "Returns a JOB ID and does not block: the render runs first and the clip is placed "
        + "when it lands. Poll vfx_get_comp → `renders`; the finished job carries a `studio` "
        + "field naming the project file it wrote. Use format 'mov' if the comp is meant to "
        + "sit over other footage — it keeps the alpha, mp4 does not.",
      inputSchema: {
        type: "object", required: ["slug", "project"],
        properties: {
          slug: { type: "string" }, project: { type: "string" },
          start: { type: "number", description: "Seconds on the Studio timeline; default is after everything on the track." },
          format: { type: "string", enum: ["mp4", "mov"] },
          crf: { type: "integer" }, scale: { type: "number" }, draft: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({
          action: "export_studio", slug: a.slug, project: a.project, start: a.start,
          format: a.format, crf: a.crf, scale: a.scale, draft: a.draft,
        });
        return { job_id: r.jobId, project: r.project, poll: `vfx_get_comp { slug: "${a.slug}" } → renders`, note: r.note };
      },
    },
  ];
}
