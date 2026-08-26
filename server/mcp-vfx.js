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
  + "name works too), timeRemap, audioLevels (gain in dB, -48..+12, on "
  + "audio/video/comp layers — the fade tool), and any shape item parameter as "
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
    // Document-state workspace furniture. An agent that cannot see the guides
    // cannot respect them, so they ride the summary, not only `full: true`.
    guides: comp.guides || [],
    layers: comp.layers.map((l, i) => ({
      index: i, id: l.id, name: l.name, type: l.type, src: l.src,
      window: `${l.start}-${l.end}s`, blend: l.blend,
      enabled: l.enabled, parent: l.parent, matte: l.trackMatte?.type ?? null,
      // only where sound is possible — a solid saying audio:true would be noise.
      // A keyed level says so rather than inlining its whole curve here.
      ...(["audio", "video", "comp"].includes(l.type)
        ? { audio: l.audio !== false,
            audio_levels: (l.audioLevels && typeof l.audioLevels === "object")
              ? "keyframed" : (l.audioLevels ?? 0) } : {}),
      animated: animatedPaths(l),
      effects: l.effects.map((f) => ({ id: f.id, type: f.type, enabled: f.enabled })),
      masks: l.masks.map((m) => ({ id: m.id, mode: m.mode, points: m.points.length })),
    })),
  });

  /** Which properties on this layer are keyframed, and how many keys each has. */
  const animatedPaths = (l) => {
    const out = {};
    const keyed = (v) => v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.keys);
    // The two curves that live on the layer itself rather than inside transform.
    for (const k of ["timeRemap", "audioLevels"]) {
      if (keyed(l[k])) out[k] = l[k].keys.length;
    }
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
        + "renders wrong. Filter with `group` — 'Blur & Sharpen', 'Color', 'Keying', "
        + "'Stylize', 'Noise & Grain', 'Distort', 'Generate', 'Time', 'Matte', "
        + "'Transition', 'Simulation', 'Expression Controls' (pixel no-ops that exist to "
        + "be keyframed and read by expressions as "
        + "thisComp.layer(\"x\").effect(\"<fxId>\")(\"<param>\")) "
        + "— or `search` when the full list is more than you need.",
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
          hide_shy: { type: "boolean", description: "Hide every shy layer from the timeline (the layers still render). Mark layers shy with vfx_set_layer." },
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
          hideShy: a.hide_shy,
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
        + "layer — set `src` to the child's slug), audio (a SOUND-ONLY source: a song from "
        + "the music library or a clip used for its sound. It paints nothing; a movie render "
        + "mixes it into the soundtrack, trimmed and levelled like everything else).\n"
        + "`src` is a LIBRARY NAME, never a path — 'raven.png' from list_images, "
        + "'clip_x.mp4' from the clips library, 'song.flac' from the music library for an "
        + "audio layer. A path is refused.\n"
        + "`start`/`end` are the layer's visibility window on the comp timeline in seconds "
        + "and default to the whole comp; a video or audio layer ends at its own length if "
        + "that is shorter. " + UNITS,
      inputSchema: {
        type: "object", required: ["slug", "type"],
        properties: {
          slug: { type: "string" },
          type: { type: "string", enum: ["image", "video", "solid", "text", "shape", "adjustment", "null", "camera", "comp", "audio"] },
          src: { type: "string", description: "Library NAME for image/video/audio layers, or the SLUG of the child comp for a comp layer. Never a path." },
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
        + "`in_point` is which second of the SOURCE is showing when the layer starts. All "
        + "three retime a layer's SOUND identically to its picture.\n"
        + "`audio` (audio/video/comp layers) switches the layer's sound in a movie render "
        + "on or off; `audio_levels` is its gain in dB, -48..+12, 0 = unity — keyframe it "
        + "with vfx_set_property path 'audioLevels' for fades. A time-remapped layer with "
        + "live audio refuses to render: set audio false or drop the remap.\n"
        + "`solo` hides every non-soloed layer while any layer is soloed (and silences its "
        + "sound the same way). A layer's type cannot be changed — add a new one instead.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: {
          slug: { type: "string" }, layer_id: { type: "string" },
          name: { type: "string" }, src: { type: "string", description: "Library NAME, not a path." },
          enabled: { type: "boolean" }, solo: { type: "boolean" }, locked: { type: "boolean" },
          shy: { type: "boolean", description: "Hide this layer from the TIMELINE while the comp's hide_shy is on (vfx_set_comp). It still renders — shy is organisation, exactly as in AE." },
          label: { type: "string", description: "Label colour, a NAME: none, red, yellow, aqua, pink, lavender, peach, seafoam, blue, green, purple, orange, brown, fuchsia, cyan, sandstone, darkgreen. Organisation only — never rendered." },
          blend: { type: "string" },
          start: { type: "number" }, end: { type: "number" },
          in_point: { type: "number" }, time_scale: { type: "number" },
          audio: { type: "boolean", description: "audio/video/comp layers: whether this layer's SOUND reaches a movie render. Absent means on." },
          audio_levels: { type: "number", description: "Gain in dB, -48..+12, 0 = unity. Keyframe it with vfx_set_property path 'audioLevels'." },
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
          auto_orient: {
            type: "string", enum: ["off", "alongPath"],
            description:
              "AE's auto-orient. 'alongPath' turns the layer to face along its position "
              + "track's motion (the real interpolated path — bezier tangents, roving keys "
              + "and expressions included); the layer's own rotation then composes on top "
              + "as an offset. Moving right is upright, moving down is +90. Not animatable, "
              + "exactly as in AE. There is no 'towardCamera': layer matrices are built "
              + "before the frame picks its camera, so the route refuses it rather than "
              + "render a wrong orientation silently — aim with rotationX/Y/Z instead.",
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
          shy: a.shy, label: a.label,
          start: a.start, end: a.end, inPoint: a.in_point, timeScale: a.time_scale,
          audio: a.audio, audioLevels: a.audio_levels,
          parent: a.parent, motionBlur: a.motion_blur, color: a.color, text: a.text,
          transform: a.transform,
          threeD: a.three_d, autoOrient: a.auto_orient,
          rotationX: a.rotation_x, rotationY: a.rotation_y,
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
      name: "vfx_layer_properties",
      description:
        "EVERY animatable property on a layer, whether or not it is keyed yet — the same list "
        + "the timeline tree draws, from the same function, so what you can name here and what "
        + "the UI can show cannot drift apart.\n"
        + "Each entry carries `path` (the exact spelling vfx_set_property accepts — no "
        + "translation needed), `label`, `group` (Transform / Time / Effects / Masks / Shape), "
        + "`arity`, `value` at t=0, `animated`, and any `expr` on it. Effect and shape "
        + "parameters also carry their `range` and `options` from the registry.\n"
        + "Call this before animating something you did not put there yourself: it is the "
        + "difference between naming a property and guessing at one, and a guessed RANGE is "
        + "accepted and renders wrong.",
      inputSchema: {
        type: "object", required: ["slug", "layer_id"],
        properties: {
          slug: { type: "string" },
          layer_id: { type: "string", description: "Layer id, or an unambiguous name." },
          group: { type: "string", description: "Only this group — Transform, Time, Effects, Masks, Shape." },
          animated_only: { type: "boolean", description: "Only properties that already have keyframes or an expression." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "layer_properties", slug: a.slug, layerId: a.layer_id });
        let rows = r.properties || [];
        if (a.group) rows = rows.filter((p) => String(p.group || "").toLowerCase() === String(a.group).toLowerCase());
        if (a.animated_only) rows = rows.filter((p) => p.animated || p.expr);
        return { layer: r.name, type: r.type, count: rows.length, properties: rows };
      },
    },
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

    {
      name: "vfx_effect_presets",
      description:
        "SAVE, LIST, APPLY, DELETE or RENAME effect/animation presets — After Effects' "
        + "Animation Presets. A preset is a named snapshot of a layer's effect stack "
        + "(parameters, keyframes and expressions, exactly as configured) and optionally "
        + "its keyframed TRANSFORM move, stored app-level so this tool and the VFX tab's "
        + "UI read the SAME shelf. This is how you curate a reusable library of looks: "
        + "build a grade once, save it, apply it to every plate in every comp.\n"
        + "· op 'list' — every preset with a summary: the effect types inside, whether "
        + "anything is keyframed, which transform properties ride along. Built-ins ship "
        + "named '(built-in)'; read them as worked examples of the format.\n"
        + "· op 'save' — snapshot from slug + layer_id under `name`. `include` (effect "
        + "ids or types) narrows it to part of the stack; include_transform true also "
        + "captures every KEYFRAMED transform property — the 'animation preset' half, a "
        + "saved move. Keyframe times are stored RELATIVE to the layer's start, so the "
        + "preset lands sensibly on any layer in any comp.\n"
        + "· op 'apply' — appends the preset's effects to slug + layer_id with FRESH "
        + "effect ids and writes its transform keys. `at` (seconds) is where the preset's "
        + "time zero lands; default is the target layer's own start. Merging is paste "
        + "semantics: the preset's keys replace existing keys only in the time range they "
        + "cover. Every effect type and parameter is validated against the CURRENT "
        + "catalog first — a stale preset is refused naming exactly what is unknown. "
        + "Expressions apply VERBATIM; one that references a layer name this comp does "
        + "not have comes back in `warnings`, not as a failure — read them and add or "
        + "rename the layer it wants.\n"
        + "· op 'delete' / 'rename' — your own presets only; built-ins are refused.",
      inputSchema: {
        type: "object", required: ["op"],
        properties: {
          op: { type: "string", enum: ["list", "save", "apply", "delete", "rename"] },
          name: { type: "string", description: "The preset's name — what save writes, and what apply/delete/rename act on." },
          slug: { type: "string", description: "save/apply: the comp." },
          layer_id: { type: "string", description: "save: the layer whose stack is snapshotted; apply: the layer that receives it. Id or unambiguous name." },
          include: { type: "array", items: { type: "string" }, description: "save: only these effects, each an fx_ id or a type. Omit to save the whole stack." },
          include_transform: { type: "boolean", description: "save: also capture every keyframed transform property, times relative to the layer's start." },
          note: { type: "string", description: "save: one line about what the preset is for; shown by list." },
          at: { type: "number", description: "apply: seconds on the comp timeline where the preset's time zero lands. Default: the target layer's start." },
          to: { type: "string", description: "rename: the new name." },
        },
        additionalProperties: false,
      },
      async run(a) {
        switch (a.op) {
          case "list": {
            const r = await vfx({ action: "list_fx_presets" });
            return { count: r.count, presets: r.presets };
          }
          case "save": {
            const r = await vfx({
              action: "save_fx_preset", slug: a.slug, layerId: a.layer_id, name: a.name,
              include: a.include, includeTransform: a.include_transform, note: a.note,
            });
            return { preset: r.preset, effects: r.effects, keyed: r.keyed, transform: r.transform, note: r.note };
          }
          case "apply": {
            const r = await vfx({ action: "apply_fx_preset", slug: a.slug, layerId: a.layer_id, preset: a.name, at: a.at });
            return { preset: r.preset, effect_ids: r.effectIds, transform: r.transform, at: r.at,
                     warnings: r.warnings, catalog: r.catalog };
          }
          case "delete": {
            const r = await vfx({ action: "delete_fx_preset", preset: a.name });
            return { deleted: r.deleted };
          }
          case "rename": {
            const r = await vfx({ action: "rename_fx_preset", preset: a.name, to: a.to });
            return { renamed: r.renamed };
          }
          default:
            throw new Error(`op must be list, save, apply, delete or rename — got "${a.op}".`);
        }
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
        "After Effects' precompose, the \"move all attributes\" mode, LIVE: the named layers "
        + "move — verbatim, keyframes, expressions and effects included — into a new comp of "
        + "the same size, fps and duration, and ONE comp layer (type 'comp', src = the new "
        + "comp's slug, spanning the parent's timeline) takes the place of the topmost of "
        + "them. The picture does not change: with normal blends and no links crossing the "
        + "boundary the rendered frame before and after is identical. The whole group can "
        + "then be transformed, masked or effected as one thing, and the child comp is "
        + "edited like any other.\n"
        + "layer_ids may be any selection, in any order — stacking order is preserved from "
        + "the parent — and selecting every layer is fine. Links that end up with one end "
        + "on each side (parenting, a track matte pair, an expression naming a layer on the "
        + "other side) are broken the way AE breaks them and reported in `warnings`; read "
        + "them. If name is omitted the comp is named \"Pre-comp N\", AE-style.",
      inputSchema: {
        type: "object", required: ["slug", "layer_ids"],
        properties: {
          slug: { type: "string" },
          layer_ids: { type: "array", items: { type: "string" }, description: "The layers to move. Any subset, any order; relative stacking is kept." },
          name: { type: "string", description: "Name for the new comp. Default: \"Pre-comp N\"." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "precompose", slug: a.slug, layerIds: a.layer_ids, name: a.name });
        return {
          precomp_slug: r.precompSlug, comp_layer_id: r.layerId,
          moved: r.moved, warnings: r.warnings, comp: summary(r.comp),
        };
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
          view: {
            type: "string", enum: ["active", "front", "back", "top", "bottom", "left", "right", "orbit"],
            description:
              "Render from a WORKSPACE view instead of the comp's active camera — the way to "
              + "see where 3D layers, cameras and lights actually sit in space. 'active' (the "
              + "default) is the comp's own camera; front/top/right etc. look at the scene from "
              + "that side; 'orbit' takes yaw/pitch. Only 3D layers change — 2D layers hold "
              + "their comp position in every view, as in AE.",
          },
          yaw: { type: "number", description: "orbit only: degrees around the vertical axis. Default 30." },
          pitch: { type: "number", description: "orbit only: degrees above (-) or below (+) the horizon. Default -25." },
          distance: { type: "number", description: "View camera's distance from the comp centre in px. Default width·50/36." },
          vzoom: { type: "number", description: "View camera's zoom (focal length in px). Default = distance, which renders the comp plane 1:1." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const q = new URLSearchParams({ t: String(a.t), meta: "1" });
        if (a.scale !== undefined) q.set("scale", String(a.scale));
        if (a.draft !== undefined) q.set("draft", a.draft ? "1" : "0");
        if (a.view !== undefined && a.view !== "active") {
          q.set("view", a.view);
          for (const k of ["yaw", "pitch", "distance", "vzoom"]) {
            if (a[k] !== undefined) q.set(k, String(a[k]));
          }
        }
        const r = await api("GET", `/api/vfx/frame/${encodeURIComponent(slugOf(a.slug))}?${q}`, undefined, 180_000);
        return {
          url: `${BASE}${r.url}`,
          width: r.width, height: r.height, t: r.t, scale: r.scale, draft: r.draft,
          view: r.view ?? null,
          render_ms: r.ms, from_cache: r.cached,
        };
      },
    },

    {
      name: "vfx_probe_pixel",
      description:
        "Read the RGBA under one point of the RENDERED frame — the way to VERIFY an edit "
        + "instead of assuming it: 'is the pixel at (400, 300) actually red now'. The value "
        + "comes off the same server-rendered PNG the viewer shows and a render would "
        + "produce, so what this reports is what ships. `x`/`y` are comp pixels from the "
        + "top-left; the reply carries both 0-255 (`rgba`) and 0-1 (`float`). Probe at "
        + "scale 1 (the default) unless you know the half-size pixel is what you want, and "
        + "note draft skips motion blur — probe with draft false when judging final pixels. "
        + "Takes the same `view` the preview does, so a Top-view probe reads Top-view pixels.",
      inputSchema: {
        type: "object", required: ["slug", "t", "x", "y"],
        properties: {
          slug: { type: "string" },
          t: { type: "number", description: "Seconds on the comp timeline." },
          x: { type: "number", description: "Comp pixels from the left edge." },
          y: { type: "number", description: "Comp pixels from the top edge." },
          scale: { type: "number", description: "0.05-1, default 1. The probe reads the frame rendered at this scale." },
          draft: { type: "boolean", description: "Default follows scale, like the preview. Pass false to probe final-quality pixels." },
          view: { type: "string", enum: ["active", "front", "back", "top", "bottom", "left", "right", "orbit"] },
          yaw: { type: "number" }, pitch: { type: "number" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const view = a.view && a.view !== "active"
          ? { name: a.view, yaw: a.yaw, pitch: a.pitch } : undefined;
        const r = await vfx({
          action: "probe_pixel", slug: a.slug, t: a.t, x: a.x, y: a.y,
          scale: a.scale, draft: a.draft, view,
        });
        return { x: r.x, y: r.y, rgba: r.rgba, float: r.float,
                 frame: { width: r.width, height: r.height, scale: r.scale, draft: r.draft, view: r.view } };
      },
    },

    {
      name: "vfx_view_overlay",
      description:
        "WHERE things are on screen — the workspace overlay's geometry, in comp pixels: the "
        + "named layer's axis tripod (anchor origin, local X/Y/Z directions as drawn "
        + "segments), its projected bounding outline, every camera layer's frustum "
        + "polylines and every light's wireframe. Computed by the engine's own projection, "
        + "so it is exactly where the renderer puts them — use it to check what a move DID "
        + "('did the card end up centred'), or to know what screen point to probe with "
        + "vfx_probe_pixel. Takes the same `view` as vfx_preview_frame, which is the main "
        + "use: in a Top or orbit view this is how you read the 3D arrangement without "
        + "guessing from pixels. An `outline: null` means the layer does not project in "
        + "this view (behind the lens).",
      inputSchema: {
        type: "object", required: ["slug", "t"],
        properties: {
          slug: { type: "string" },
          t: { type: "number", description: "Seconds on the comp timeline." },
          layer_id: { type: "string", description: "The layer whose tripod and outline you want. Omit for cameras and lights only." },
          view: { type: "string", enum: ["active", "front", "back", "top", "bottom", "left", "right", "orbit"] },
          yaw: { type: "number", description: "orbit only." },
          pitch: { type: "number", description: "orbit only." },
          distance: { type: "number" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const view = a.view && a.view !== "active"
          ? { name: a.view, yaw: a.yaw, pitch: a.pitch, distance: a.distance } : undefined;
        const r = await vfx({ action: "view_overlay", slug: a.slug, t: a.t, layerId: a.layer_id, view });
        return { width: r.width, height: r.height, has_camera: r.hasCamera,
                 selected: r.selected, cameras: r.cameras, lights: r.lights, view: r.view };
      },
    },

    {
      name: "vfx_align_layers",
      description:
        "Align or distribute layers in the comp's XY plane, like AE's Align panel. Bounds "
        + "come from the engine's own transforms — a rotated, scaled or parented layer "
        + "aligns by where it actually IS on the comp — and the moves are written through "
        + "transform.position, so they undo and read back like any other edit: a constant "
        + "position moves, a keyframed one gets a key at `t`, an expression keeps running "
        + "over the moved value.\n"
        + "`op`: left / centerH / right / top / centerV / bottom align; distributeH / "
        + "distributeV space the layers' centres evenly (needs 3+ layers, first and last "
        + "stay). `to` 'selection' (default) aligns within the group's own bounds — two or "
        + "more layers; 'comp' aligns against the comp edges and works on a single layer "
        + "(centerH+centerV with to:'comp' is 'centre this layer'). 3D layers align in "
        + "world XY; z is untouched.",
      inputSchema: {
        type: "object", required: ["slug", "layer_ids", "op"],
        properties: {
          slug: { type: "string" },
          layer_ids: { type: "array", items: { type: "string" }, description: "Layer ids (or unambiguous names)." },
          op: { type: "string", enum: ["left", "centerH", "right", "top", "centerV", "bottom", "distributeH", "distributeV"] },
          to: { type: "string", enum: ["selection", "comp"], description: "Align within the group's bounds, or against the comp edges." },
          t: { type: "number", description: "Seconds — where bounds are measured and where a key lands on an animated position. Default 0." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "align_layers", slug: a.slug, layerIds: a.layer_ids, op: a.op, to: a.to, t: a.t });
        return { op: r.op, to: r.to, moved: r.moved };
      },
    },

    {
      name: "vfx_set_guides",
      description:
        "REPLACE the comp's ruler guides — the lines a human drags out of the viewer's "
        + "rulers. Guides are part of the comp document (they survive reload and travel "
        + "with the comp), which is why this tool exists; vfx_get_comp shows the current "
        + "list. Each guide is { axis, position }: axis 'x' is a VERTICAL line at "
        + "x=position, axis 'y' a HORIZONTAL one at y=position, in comp pixels on the "
        + "comp raster (0..width / 0..height — outside is refused). The whole list is "
        + "replaced in one call, like markers: to add or move one, send the full list "
        + "back with the change; [] clears them. Guides never change a rendered pixel — "
        + "they are alignment furniture, and the GUI snaps layer drags to them. The "
        + "viewer's grid and title/action-safe overlays are VIEW state (per person, "
        + "never saved in the comp), so there is deliberately no tool for those.",
      inputSchema: {
        type: "object", required: ["slug", "guides"],
        properties: {
          slug: { type: "string" },
          guides: {
            type: "array",
            description: "The complete new guide list. Replaces what is there.",
            items: {
              type: "object", required: ["axis", "position"],
              properties: {
                axis: { type: "string", enum: ["x", "y"], description: "'x' = vertical line at x=position; 'y' = horizontal line at y=position." },
                position: { type: "number", description: "Comp pixels from the top-left. Fractions are legal." },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "set_guides", slug: a.slug, guides: a.guides });
        return { guides: r.guides };
      },
    },

    {
      name: "vfx_render_status",
      description:
        "The render queue: every render (and prewarm) job the server currently remembers, "
        + "across ALL comps, newest first — comp slug, status "
        + "(queued/running/done/failed/cancelled/stale), progress 0-1, current frame, "
        + "format, the clip name and output path once done, and the error when failed. "
        + "This is how you poll a job without re-reading the whole comp, or find a job "
        + "when you have lost track of which comp it belonged to. The list is IN MEMORY: "
        + "a server restart clears it, and a job a restart interrupted did not finish.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Only this comp's jobs." },
          kind: { type: "string", enum: ["render", "prewarm"], description: "Only this kind. Both by default." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const q = new URLSearchParams();
        if (a.slug) q.set("slug", slugOf(a.slug));
        if (a.kind) q.set("kind", a.kind);
        const qs = q.toString();
        const r = await api("GET", `/api/vfx/renders${qs ? `?${qs}` : ""}`);
        return { jobs: r.jobs, note: r.note };
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
        + "SOUND: mp4 and mov carry the comp's audio mix — audio layers, video layers' own "
        + "tracks and nested comps' mixes, trimmed and levelled per layer (audioLevels, in "
        + "dB, keyframable). A comp with no audio-bearing source renders exactly as before, "
        + "with no audio stream; a png sequence never carries sound. The finished job "
        + "reports the mix it muxed under `audio` (seconds, peakDb, rmsDb). A time-remapped "
        + "layer with live audio refuses the render and names the fix.\n"
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
        + "Audio items have two homes, your choice. Default: markers at their start times — "
        + "the Studio timeline keeps owning the song, which is what the export_studio round "
        + "trip needs (Studio plays video tracks MUTED, so a song baked into an exported "
        + "clip is a song the timeline cannot hear). audio_as 'layers': the items become "
        + "real audio layers, and a direct vfx_render then carries the whole mix — the "
        + "music-video path. Either way the comp's length follows the picture, not the "
        + "song. Any clip the project referenced that is no longer in the library is "
        + "listed in `missing_sources` rather than failing the import.",
      inputSchema: {
        type: "object", required: ["project"],
        properties: {
          project: { type: "string", description: "The Studio project name (with or without .json)." },
          name: { type: "string", description: "Name for the new comp; defaults to the project's." },
          audio_as: { type: "string", enum: ["markers", "layers"], description: "Where audio items land. Default 'markers' (Studio keeps the song for the round trip); 'layers' makes them audio layers so a direct render carries the mix." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await vfx({ action: "import_studio", project: a.project, name: a.name, audioAs: a.audio_as });
        return {
          slug: r.slug, layers: r.layers, audio_as_markers: r.audioAsMarkers,
          audio_as_layers: r.audioAsLayers,
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
        + "sit over other footage — it keeps the alpha, mp4 does not.\n"
        + "If the comp carries audio it is muxed into the clip — but Studio plays VIDEO "
        + "tracks muted, so for this round trip keep the song on the Studio timeline "
        + "(an audio track) rather than inside the comp; the reply's note repeats this "
        + "when it applies.",
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
