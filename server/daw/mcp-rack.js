/**
 * DAW — the rack's MCP tools: daw_insert, daw_mixer, daw_meters.
 *
 * Spread into dawTools() (server/mcp-daw.js), so the declared-and-dropped
 * guard, the daw_ family checks and the `by: "agent"` stamp all cover these
 * three exactly as they cover the P0 family. Voice and shape follow the
 * house rules: snake_case, additionalProperties: false, errors that name the
 * fix, and every capability calls the SAME /api/daw route the UI calls.
 *
 * AUTOMATION, stated once and quoted where it applies: any *animatable*
 * number here also accepts the house keyframe shape
 * { "keys": [ { "t": <float bar>, "v": <value>, "ease"?: "linear|hold|
 * easeIn|easeOut|easeInOut" } ] } — `t` is a FLOAT BAR (3.5 = halfway
 * through bar 3), so automation is musical time and rides tempo changes.
 */

const AUTO =
  "Animatable values accept a number OR the keyframe shape "
  + '{ "keys": [{ "t": <float bar, 3.5 = mid-bar-3>, "v": <value>, '
  + '"ease"?: "linear"|"hold"|"easeIn"|"easeOut"|"easeInOut" }] }.';

const TARGET =
  "`target` is a track id, a return id (or unambiguous name), or the word "
  + "\"master\".";

export function rackTools({ daw, get, slugOf }) {
  return [
    {
      name: "daw_insert",
      description:
        "The insert chains — the rack. op `catalog` lists every device with its "
        + "parameters, ranges, defaults and what it is for (read it before adding "
        + "anything; a parameter not in the catalog does not exist). op `add` puts a "
        + "device on a chain, `set` changes params / enables / disables / reorders, "
        + "`remove` takes it off. " + TARGET + " Signal order is the chain order: "
        + "inserts run top to bottom, then fader/pan, then sends, then the master "
        + "chain. " + AUTO + " Every mutation answers with the regions it dirtied — "
        + "render those to hear it, daw_meters to measure it.",
      inputSchema: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["catalog", "add", "set", "remove"] },
          slug: { type: "string", description: "Project slug (all ops but catalog)." },
          target: { type: "string", description: "Track id, return id, or \"master\"." },
          type: {
            type: "string",
            enum: ["eq", "compressor", "limiter", "saturator", "chorus",
                   "delay", "reverb", "gate", "utility"],
            description: "Device to add (op add).",
          },
          insert: { type: "string", description: "Insert id (ops set/remove)." },
          params: {
            type: "object",
            description: "Device params from the catalog, partial on set. "
              + "Numbers clamp to the catalog range; unknown names are refused.",
          },
          enabled: { type: "boolean", description: "false = bypass (bit-exact passthrough)." },
          index: { type: "integer", description: "Chain position (0-based) — add inserts there, set moves there." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.op === "catalog") {
          const r = await get("/api/daw/rack");
          return { devices: r.catalog?.devices ?? r.catalog, pan_law: r.catalog?.pan_law,
                   sync_values: r.catalog?.sync_quarters, tables_agree: r.tables_agree };
        }
        const slug = slugOf(a.slug);
        if (a.op === "add") {
          const r = await daw({ action: "insert_add", slug, target: a.target, type: a.type,
                                params: a.params, enabled: a.enabled, index: a.index });
          return { insert_id: r.insertId, chain: r.chain, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "set") {
          const r = await daw({ action: "insert_set", slug, target: a.target, insert: a.insert,
                                params: a.params, enabled: a.enabled, index: a.index });
          return { insert: r.insert, chain: r.chain, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "remove") {
          const r = await daw({ action: "insert_remove", slug, target: a.target, insert: a.insert });
          return { removed: r.removed, chain: r.chain, dirty: r.dirty, updated_at: r.updatedAt };
        }
        throw new Error(`Unknown op "${a.op}" — catalog, add, set or remove.`);
      },
    },

    {
      name: "daw_mixer",
      description:
        "The mixer: faders, pans, solo, sends and return tracks. op `set` writes "
        + "fader (dB, -60..+12), pan (-1..1) and solo on a target (" + TARGET + " — "
        + "the master takes fader only; solo is tracks only, and any solo means ONLY "
        + "solo tracks sound). op `send_set` routes a track to a return (level dB, "
        + "`pre` taps before the fader) and creates the send if absent; `send_remove` "
        + "cuts it. `return_add`/`return_remove` manage up to 4 return tracks — put "
        + "shared effects (reverb, delay) on a return via daw_insert and feed it from "
        + "many tracks. " + AUTO + " Pan law: equal-power, centre-unity, +3 dB edges.",
      inputSchema: {
        type: "object",
        required: ["op", "slug"],
        properties: {
          op: { type: "string",
                enum: ["set", "send_set", "send_remove", "return_add", "return_remove"] },
          slug: { type: "string" },
          target: { type: "string", description: "op set: track id, return id, or \"master\"." },
          fader: { description: "dB, -60..+12. Number or keys." },
          pan: { description: "-1..1. Number or keys." },
          solo: { type: "boolean" },
          track: { type: "string", description: "send ops: the sending track." },
          to: { type: "string", description: "send ops: the return id (or name)." },
          level: { description: "Send level dB, -60..+12. Number or keys." },
          pre: { type: "boolean", description: "true = pre-fader tap." },
          name: { type: "string", description: "return_add: a name for the return." },
          return: { type: "string", description: "return_remove: the return id (or name)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = slugOf(a.slug);
        if (a.op === "set") {
          const r = await daw({ action: "mixer_set", slug, target: a.target,
                                fader: a.fader, pan: a.pan, solo: a.solo });
          return { target: r.target, kind: r.kind, fader: r.fader, pan: r.pan,
                   solo: r.solo, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "send_set") {
          const r = await daw({ action: "send_set", slug, track: a.track, to: a.to,
                                level: a.level, pre: a.pre });
          return { track: r.track, send: r.send, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "send_remove") {
          const r = await daw({ action: "send_remove", slug, track: a.track, to: a.to });
          return { track: r.track, sends: r.sends, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "return_add") {
          const r = await daw({ action: "return_add", slug, name: a.name });
          return { return_id: r.returnId, name: r.name, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op === "return_remove") {
          const r = await daw({ action: "return_remove", slug, return: a.return });
          return { removed: r.removed, sends_removed: r.sendsRemoved,
                   dirty: r.dirty, updated_at: r.updatedAt };
        }
        throw new Error(`Unknown op "${a.op}".`);
      },
    },

    {
      name: "daw_meters",
      description:
        "Offline metering for a bar range — the agent's ears on levels. Renders the "
        + "window through the full chain graph and answers, per track and return "
        + "(post-fader) and for the master (what the file holds): peak dBFS, RMS dB, "
        + "and integrated LUFS (BS.1770-4, K-weighted, gated); the master adds "
        + "true-peak dBTP (4x oversampled) and a short-term LUFS series (3 s window, "
        + "1 s hop). Nothing streams — call it again after an edit. A silent bus "
        + "reports lufs: null.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          from_bar: { type: "integer", description: "Default 1." },
          to_bar: { type: "integer", description: "Default: the last bar." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "meters", slug: slugOf(a.slug),
                              from_bar: a.from_bar, to_bar: a.to_bar });
        return { from_bar: r.fromBar, to_bar: r.toBar, master: r.master,
                 tracks: r.tracks, returns: r.returns, ms: r.ms };
      },
    },
  ];
}
