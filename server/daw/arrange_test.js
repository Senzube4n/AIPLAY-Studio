/**
 * DAW — the arranger's proofs.
 *
 * Two halves. THE PLAN (no disk): bigroomPlan() is deterministic, its form
 * sums, every note it writes is a legal position on the grid inside the clip
 * that covers it, and the musical rules the module header promises actually
 * hold — the hook is a 2-4 note cell with an octave leap, call and response
 * differ, no lead note lands on a beat (beat 1 of a drop bar least of all),
 * the second drop plays the variant, the sub sits on the kick's rests, the
 * roll accelerates and climbs, the kick leaves the last beat before every
 * drop and nothing sustains into it, the kick is tuned to the key, the
 * sidechain release is the measured 3/16 of a beat, the riser starts above
 * the kick's band and the kick carries no EQ. THE CHAINS (the third take):
 * the lead's insert order (saturator → chorus → eq → delay → reverb →
 * sidechain), the delay's note value and the time it comes to at three
 * tempos, the sub's longer notes and release, the hats' velocity pattern
 * (accents on the "and" of 2 and 4, quieter closed sixteenths in the
 * drop), the clap on its own track with its saturator and room, and every
 * voice preset read from patches.json rather than retyped. Note counts are
 * checked against arithmetic (so many bars × so many hits, the hook's own
 * count × its repeats), not against a number copied from a previous run.
 *
 * THE TWO KNOBS SET BY A NUMBER (its own section): the sub's release and the
 * hat pair. The release shipped as 200 in patches.json and 600 in arrange.js
 * — two files, two numbers, neither measured against the kick — so the suite
 * checks that the shipped value IS the maximum of the sweep the plan carries
 * (SUB_RELEASE_SWEEP), that the two files now hold the same number, and that
 * the grid arithmetic the release is spent on (note-off 20 ticks before the
 * next kick, 500 ticks before the next sub note) comes out where it should.
 * The hat pair's reported "0.6-0.9 dB of top end" was a MONO reading: per
 * channel that cost is hat_vel's alone and is flat across three bands,
 * hat_width's is zero, and hat_width's ceiling is the Ear's mono-compatible
 * floor rather than a taste. HAT_KNOBS_MEASURED carries those numbers and
 * this suite holds the shipped preset to them.
 *
 * THE RUN (a temp dir): the plan is fed through the REAL route dispatcher —
 * createDawRoutes with a capturing response, the same code path the page and
 * the MCP tools hit — into a scratch output dir, and the document that comes
 * back is checked note by note with the store's own normPos. Then the MCP
 * tool drives the same route. Nothing needs python: the arranger renders
 * nothing.
 *
 * Runs standalone (`node server/daw/arrange_test.js`) and in the pre-commit
 * hook. The temp dir is removed at the end; KEEP_ARRANGE_TEST=1 keeps it.
 */
import os from "node:os";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and
 * static imports hoist — so every import below is dynamic. */
const OUT = path.join(os.tmpdir(), `daw-arrange-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const store = await import("./store.js");
const arrange = await import("./arrange.js");
const { MIXER_CATALOG } = await import("./mixer.js");
const { createDawRoutes } = await import("./routes.js");
const { dawTools } = await import("../mcp-daw.js");
const { evalProp } = await import("../vfx/store.js");

const { TICKS_PER_BEAT: T, normPos, noteInClip, PATCHES, buildTimeline } = store;
const { bigroomPlan, normStructure, parseKey, eighthMs, sidechainReleaseMs, kickTune, kickHz, hookNotes, hookBars, prng,
        resolveRefs, DEFAULT_STRUCTURE, DEFAULT_FORM, ROLES, FADERS, AND_SLOTS, PAIRS, MASTER, RISER, SIDECHAIN,
        SIDECHAIN_RELEASE_BEATS, loudnessTargetDoor, SUB_RELEASE_SWEEP, HAT_KNOBS_MEASURED,
        LEAD, LEAD_CHAIN, SUB, SUB_CHAIN, CLAP_CHAIN, CLAP, CLAP_VEL, HATS, HATS_EQ, ROLL,
        DELAY_SYNC, DELAY_QUARTERS, delayMs } = arrange;

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

/* ═══════════════════════════ THE PLAN ═══════════════════════════════════ */

console.log("\n  -- the form sums, and it is the brief's --");
const plan = bigroomPlan({});
const M = plan.meta;
{
  ok("default: 128 bars at 128 bpm in F minor, seed 1",
    M.bars === 128 && M.tempo === 128 && M.key === "F" && M.mode === "minor" && M.seed === 1);
  ok("128 bars of 4/4 at 128 is exactly 4:00", near(M.seconds, 240));
  ok("intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8",
    M.structure.map((s) => `${s.type} ${s.bars}`).join(" | ")
      === "intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8");
  ok("DEFAULT_FORM is that string, rendered from DEFAULT_STRUCTURE", DEFAULT_FORM === "intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8");
  ok("section ranges abut and cover 1..128",
    M.structure[0].from === 1 && M.structure[6].to === 128
    && M.structure.every((s, i) => i === 0 || s.from === M.structure[i - 1].to + 1));
  ok("builds, break and drops sit on the 16-bar phrase grid that the 8-bar intro sets",
    M.structure.filter((s) => s.type !== "intro" && s.type !== "outro")
      .every((s) => (s.from - 9) % 16 === 0));
  ok("the sidechain release is 3/16 of a beat: 60000/128 × 3/16 = 87.891 ms — not the eighth (234.375) the first draft reasoned to",
    near(M.sidechain_release_ms, 87.891) && near(sidechainReleaseMs(128), 87.891) && near(eighthMs(128), 234.375)
    && near(SIDECHAIN_RELEASE_BEATS, 3 / 16) && M.sidechain.release_beats === SIDECHAIN_RELEASE_BEATS);
  ok("the kick preset is read from patches.json, not retyped",
    JSON.stringify(M.kick_preset) === JSON.stringify(PATCHES.hybrid_kick.presets.bigroom.params));
  ok("roles name every track for the Ear — eight, the clap and the hats apart",
    Object.keys(M.roles).sort().join() === "clap+snare,crash,hats,impact,kick,lead,riser,sub"
    && M.roles.lead === "lead" && M.roles.sub === "bass" && M.roles.kick === "drums" && M.roles.riser === "fx"
    && M.roles["clap+snare"] === "drums" && M.roles.hats === "drums");
}

console.log("\n  -- the kick is in tune with the key --");
{
  const f1 = 440 * 2 ** ((29 - 69) / 12);                       // F1 = 43.6535 Hz
  ok("F: tune = 12·log2(F1 / 48) = −1.6432, so f0 = 43.65 Hz (was 48: +169 cents, a 4.4 Hz beat against the sub)",
    near(kickTune(5), Math.round(12 * Math.log2(f1 / 48) * 1e4) / 1e4) && near(kickTune(5), -1.6432, 1e-4)
    && near(kickHz(kickTune(5)), f1, 0.01) && M.kick_tune === kickTune(5) && near(M.kick_hz, 43.65, 0.01));
  ok("G: +0.3568 → 49.00 Hz (G1); C: +5.3568 → 65.41 Hz (C2, the root's octave nearest 48 Hz); |tune| ≤ 6 for every key",
    near(kickTune(7), 0.3568, 1e-4) && near(kickHz(kickTune(7)), 49.0, 0.01)
    && near(kickTune(0), 5.3568, 1e-4) && near(kickHz(kickTune(0)), 65.41, 0.01)
    && [...Array(12)].every((_, pc) => Math.abs(kickTune(pc)) <= 6));
  ok("every key's kick f0 is a root: f0 / (the key's C1..B1 root) is a power of two",
    [...Array(12)].every((_, pc) => {
      const root = 440 * 2 ** ((24 + pc - 69) / 12);
      const r = Math.log2(kickHz(kickTune(pc)) / root);
      return near(r, Math.round(r), 1e-4);
    }));
  ok("the kick's add_track carries the preset AND the tune",
    plan.steps[0].instrument === "hybrid_kick" && plan.steps[0].params.tune === kickTune(5) && plan.steps[0].params.punch === 1);
  const g = bigroomPlan({ seed: 3, key: "G" }), c = bigroomPlan({ seed: 3, key: "C" });
  ok("…for three keys: F −1.6432, G +0.3568, C +5.3568 in the steps themselves",
    plan.steps[0].params.tune === -1.6432 && g.steps[0].params.tune === 0.3568 && c.steps[0].params.tune === 5.3568
    && g.meta.kick_tune === 0.3568 && c.meta.kick_tune === 5.3568);
}

console.log("\n  -- the steps are route bodies, in a human's order --");
const steps = plan.steps;
const notesOf = (name) => steps.filter((s) => s.action === "record_notes" && s.track === `$track:${name}`)
  .flatMap((s) => s.notes);
{
  const actions = [...new Set(steps.map((s) => s.action))].sort().join();
  ok("only add_track, add_clip, record_notes, insert_add and mixer_set are used",
    actions === "add_clip,add_track,insert_add,mixer_set,record_notes", actions);
  const firstNonTrack = steps.findIndex((s) => s.action !== "add_track");
  ok("the eight tracks come first: kick, sub, lead, clap+snare, hats, crash, riser, impact",
    firstNonTrack === 8 && steps.slice(0, 8).map((s) => s.name).join() === "kick,sub,lead,clap+snare,hats,crash,riser,impact");
  ok("tracks are added WITHOUT the default full-length clip (sections get their own)",
    steps.slice(0, 8).every((s) => s.with_clip === false));
  ok("the sub trims its sub-octave; the riser starts its lowpass at 600 Hz (the musical move)",
    steps[1].params.sub_mix === 0.2 && steps[6].params.cutoff_start === RISER.cutoff_start && RISER.cutoff_start === 600);
  /* THE CHAINS: the voices' presets ride on add_track, read from patches.json */
  ok("the lead's add_track carries LEAD (cutoff 3500, 2.2 octaves, 120 ms, spread 1) AND the bigroom_lead preset, read from patches.json",
    JSON.stringify(steps[2].params) === JSON.stringify({ ...LEAD, ...PATCHES.bigroom_lead.presets.bigroom.params })
    && JSON.stringify(M.presets.lead) === JSON.stringify(PATCHES.bigroom_lead.presets.bigroom.params)
    && LEAD.cutoff === 3500 && LEAD.filter_amount === 2.2 && LEAD.spread === 1, JSON.stringify(steps[2].params));
  ok("the sub's add_track carries sub_mix 0.2, the sub_bass preset, then SUB's release 500 / mid_layer 0.8 / mid_cutoff 400 on top",
    steps[1].params.release === 500 && steps[1].params.mid_layer === 0.8 && steps[1].params.mid_cutoff === 400
    && JSON.stringify(M.presets.sub) === JSON.stringify(PATCHES.sub_bass.presets.bigroom.params)
    && Object.keys(PATCHES.sub_bass.presets.bigroom.params).every((k) => k in steps[1].params)
    && SUB.release === 500 && SUB.mid_layer === 0.8, JSON.stringify(steps[1].params));
  ok("clap+snare and hats carry the tr909 preset (clap_noise, clap_room, hat_vel, hat_width…); the clap's burst 0.7 over it, the hats' spread 0.6",
    JSON.stringify(M.presets.kit) === JSON.stringify(PATCHES.tr909.presets.bigroom.params)
    && Object.keys(PATCHES.tr909.presets.bigroom.params).every((k) => k in steps[3].params && k in steps[4].params)
    && steps[3].params.clap_noise === CLAP.clap_noise && CLAP.clap_noise === 0.7
    && steps[4].params.spread === HATS.spread && HATS.spread === 0.6 && steps[3].params.spread === undefined
    && steps[4].params.hat_width === PATCHES.tr909.presets.bigroom.params.hat_width);
  let paired = true;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].action !== "add_clip") continue;
    const n = steps[i + 1];
    if (!n || n.action !== "record_notes" || n.track !== steps[i].track) paired = false;
    if (!n.notes.every((x) => x.bar >= steps[i].from_bar && x.bar <= steps[i].from_bar + steps[i].bars - 1)) paired = false;
  }
  ok("every add_clip is followed by the record_notes that fills it, and the notes fit the clip", paired);
  /* kick 6, sub 3, lead 6, clap+snare 4 (two builds' rolls, two drops), hats 6, crash 2, riser 2, impact 2 */
  ok(`${M.clips} clips, one per (track, section it plays in): 6 + 3 + 6 + 4 + 6 + 2 + 2 + 2`,
    M.clips === steps.filter((s) => s.action === "add_clip").length && M.clips === 31);
  ok("clips are named for their section (\"drop 1\", \"build 2\"…)",
    steps.filter((s) => s.action === "add_clip").every((s) => /^(intro|build|drop|break|outro) \d$/.test(s.name)));
  ok("no record_notes call exceeds the route's 2000-note cap",
    steps.filter((s) => s.action === "record_notes").every((s) => s.notes.length <= 2000));
  ok("track references are symbolic until the store mints ids",
    steps.filter((s) => s.track).every((s) => s.track.startsWith("$track:")));
}

console.log("\n  -- every note is a legal position on the 32nd grid --");
{
  const all = steps.filter((s) => s.action === "record_notes").flatMap((s) => s.notes);
  ok(`${all.length} notes in total`, all.length === M.notes);
  ok("bars 1..128, beats 1..4, ticks 0..959 on the 120-tick (32nd) grid",
    all.every((n) => n.bar >= 1 && n.bar <= 128 && n.beat >= 1 && n.beat <= 4
      && n.tick >= 0 && n.tick < T && n.tick % (T / 8) === 0));
  ok("pitch 0..127, velocity 1..127, duration ≥ 1",
    all.every((n) => n.pitch >= 0 && n.pitch <= 127 && n.vel >= 1 && n.vel <= 127 && n.dur_ticks >= 1));
  /* against the store's own validator, on a blank 128-bar 4/4 document */
  const doc = store.blankProject("t", { bpm: 128, num: 4, den: 4, lengthBars: 128 });
  let legal = 0;
  for (const n of all) { try { normPos(doc, n, "n"); legal++; } catch { /* counted by the gap */ } }
  ok("normPos accepts every one of them", legal === all.length, `${legal}/${all.length}`);
}

console.log("\n  -- the counts are arithmetic, not memory --");
{
  const kick = notesOf("kick"), sub = notesOf("sub"), lead = notesOf("lead");
  const clap = notesOf("clap+snare"), hatsT = notesOf("hats"), kit = [...clap, ...hatsT];
  const crash = notesOf("crash"), riser = notesOf("riser"), impact = notesOf("impact");
  /* kick: intro 8×4, two builds (16×4 − 1) each, two drops 32×4, outro 8×4 */
  ok(`kick ${kick.length} = 32 + 2×63 + 2×128 + 32`, kick.length === 32 + 2 * 63 + 2 * 128 + 32);
  ok(`sub ${sub.length} = 2×128 + 32 (drops and outro, one per beat)`, sub.length === 2 * 128 + 32);
  ok("every sub note starts on the \"and\" and holds SUB.note_ticks = 460 (0.2245 s at 128): to 20 ticks before the next kick, not the old 420",
    sub.every((n) => n.tick === T / 2 && n.dur_ticks === SUB.note_ticks) && SUB.note_ticks === 460 && T / 2 + SUB.note_ticks === T - 20
    && near(M.sub.note_seconds, 460 / 960 * 60 / 128, 1e-4) && M.sub.release === 500);
  ok("the clap track holds the claps (39) and the roll (38) only; the hats track the open (46) and closed (42) hats only",
    clap.every((n) => n.pitch === 39 || n.pitch === 38) && hatsT.every((n) => n.pitch === 46 || n.pitch === 42)
    && clap.some((n) => n.pitch === 39) && clap.some((n) => n.pitch === 38) && hatsT.some((n) => n.pitch === 42));
  /* lead: the hook (H notes per 8 bars) plays intro ×1, builds ×2 each,
   * drop 1 ×4, break ×2, drop 2 ×4 as the variant (same count) — minus,
   * per build, the hook notes that start on beat 4 of its bar 8 */
  const H = M.hook.notes.length;
  const s4 = M.hook.notes.filter((n) => n.bar === 8 && n.slot >= 12).length;
  ok(`lead ${lead.length} = ${H} × (1 + 2 + 4 + 2 + 2 + 4) − 2 × ${s4}`, lead.length === H * 15 - 2 * s4);
  const hats = kit.filter((n) => n.pitch === 46).length;
  const claps = kit.filter((n) => n.pitch === 39).length;
  const roll = kit.filter((n) => n.pitch === 38).length;
  ok(`open hats ${hats} = 4 × (8 + 16 + 32 + 16 + 32 + 8) − 2`, hats === 4 * 112 - 2);
  ok(`claps ${claps} = 2 × 64 drop bars`, claps === 128);
  ok(`snare roll ${roll} = 2 × (8×8 + 4×16 + 4×32 − 8)`, roll === 2 * (64 + 64 + 128 - 8));
  ok("one crash, one impact, one riser per drop/build", crash.length === 2 && impact.length === 2 && riser.length === 2);
  ok("the total is the sum", M.notes === kick.length + sub.length + lead.length + kit.length + 6);
}

console.log("\n  -- the rules the header promises --");
{
  const kick = notesOf("kick"), sub = notesOf("sub"), lead = notesOf("lead");
  const clap = notesOf("clap+snare"), hatsT = notesOf("hats"), kit = [...clap, ...hatsT];
  const at = (list, bar, beat, tick) => list.filter((n) => n.bar === bar && n.beat === beat && n.tick === tick);
  ok("the lead NEVER lands on a beat — every note sits between kicks", lead.every((n) => n.tick !== 0));
  ok("…and never on beat 1 of a drop bar (the impact's beat)", !lead.some((n) => n.beat === 1 && n.tick === 0
    && ((n.bar >= 25 && n.bar <= 56) || (n.bar >= 89 && n.bar <= 120))));
  ok("the lead is silent in the outro and plays in the break", !lead.some((n) => n.bar > 120) && lead.some((n) => n.bar >= 57 && n.bar <= 72));
  ok("the kick is four on the floor through the drop", [...Array(32)].every((_, i) =>
    [1, 2, 3, 4].every((b) => at(kick, 25 + i, b, 0).length === 1 && at(kick, 25 + i, b, 0)[0].vel === 127)));
  ok("…and OUT for the last beat of each build (bars 24 and 88, beat 4)",
    at(kick, 24, 4, 0).length === 0 && at(kick, 88, 4, 0).length === 0 && at(kick, 24, 3, 0).length === 1);
  ok("…and absent from the break", !kick.some((n) => n.bar >= 57 && n.bar <= 72));
  ok("the sub sits on the kick's rests: every note at tick 480", sub.every((n) => n.tick === T / 2));
  ok("the sub carries the root motion in F1..E2 (MIDI 29..40)", sub.every((n) => n.pitch >= 29 && n.pitch <= 40));
  ok("the sub's first drop bar is the tonic F1 (29) — the pitch the kick is now tuned to", at(sub, 25, 1, T / 2)[0]?.pitch === 29
    && near(kickHz(M.kick_tune), 440 * 2 ** ((29 - 69) / 12), 0.01));
  ok("claps on 2 and 4 only, drops only",
    kit.filter((n) => n.pitch === 39).every((n) => (n.beat === 2 || n.beat === 4) && n.tick === 0
      && ((n.bar >= 25 && n.bar <= 56) || (n.bar >= 89 && n.bar <= 120))));
  ok("open hats on the off-beat eighth only", kit.filter((n) => n.pitch === 46).every((n) => n.tick === T / 2));
  const rollIn = (bar) => kit.filter((n) => n.pitch === 38 && n.bar === bar).length;
  ok("the roll accelerates: 8 per bar (bars 9-16), 16 (17-20), 32 (21-23), 24 in bar 24 (beat 4 silent)",
    rollIn(9) === 8 && rollIn(16) === 8 && rollIn(17) === 16 && rollIn(20) === 16
    && rollIn(21) === 32 && rollIn(23) === 32 && rollIn(24) === 24 && rollIn(25) === 0);
  const rollVel = kit.filter((n) => n.pitch === 38 && n.bar <= 24).map((n) => n.vel);
  ok("…and climbs ROLL.from 50 → ROLL.to 89 without ever stepping back (0.7× the second take's 72 → 127: the roll now has a saturator and a room)",
    rollVel[0] === ROLL.from && rollVel[rollVel.length - 1] === ROLL.to && ROLL.from === 50 && ROLL.to === 89
    && rollVel.every((v, i) => i === 0 || v >= rollVel[i - 1]));
  /* THE HATS, written into velocities */
  const open = hatsT.filter((n) => n.pitch === 46), closed = hatsT.filter((n) => n.pitch === 42);
  ok("the drop's open hats: 108 on the \"and\" of 2 and 4, 96 on the \"and\" of 1 and 3 (HATS.accent / HATS.plain)",
    open.filter((n) => n.bar >= 25 && n.bar <= 56).every((n) => n.tick === T / 2 && n.vel === (n.beat % 2 === 0 ? HATS.accent : HATS.plain))
    && HATS.accent === 108 && HATS.plain === 96);
  ok("the intro's open hats are the same pattern at 0.75 (72 / 81), the build's at 0.85 (82 / 92)",
    open.filter((n) => n.bar <= 8).every((n) => n.vel === (n.beat % 2 === 0 ? 81 : 72))
    && open.filter((n) => n.bar >= 9 && n.bar <= 24).every((n) => n.vel === (n.beat % 2 === 0 ? 92 : 82)));
  ok(`closed hats ${closed.length} = 2 × 4 × 64: drops only, on the "e" (tick 240, vel 82) and the "a" (tick 720, vel 92) — quieter than the open hats, the "a" the pickup`,
    closed.length === 2 * 4 * 64 && closed.every((n) => n.bar >= 25 && (n.bar <= 56 || n.bar >= 89))
    && closed.every((n) => (n.tick === T / 4 && n.vel === HATS.closed_e) || (n.tick === (3 * T) / 4 && n.vel === HATS.closed_a))
    && HATS.closed_e === 82 && HATS.closed_a === 92 && HATS.closed_a < HATS.plain);
  ok("the claps are at CLAP_VEL 118 on 2 and 4 of every drop bar", clap.filter((n) => n.pitch === 39).every((n) => n.vel === CLAP_VEL && n.tick === 0 && (n.beat === 2 || n.beat === 4))
    && clap.filter((n) => n.pitch === 39).length === 2 * 64 && CLAP_VEL === 118);
  ok("the beat before each drop is silent on every track — no note starts there",
    ![...kick, ...sub, ...lead, ...kit].some((n) => (n.bar === 24 || n.bar === 88) && n.beat === 4));
  ok("…and no lead note SUSTAINS into it (a held hook note is clipped at beat 3's end)",
    !lead.some((n) => (n.bar === 24 || n.bar === 88) && (n.beat - 1) * T + n.tick + n.dur_ticks > 3 * T));
  const riser = notesOf("riser");
  ok("the riser is ONE note over the build's last 8 bars, ending a beat early (31 beats), pitched F4 (65)",
    riser[0].bar === 17 && riser[0].beat === 1 && riser[0].tick === 0 && riser[0].dur_ticks === 31 * T
    && riser[1].bar === 81 && riser[1].dur_ticks === 31 * T && riser[0].pitch === 65 && M.riser.pitch === 65);
  const crash = notesOf("crash"), impact = notesOf("impact");
  ok("crash and impact on beat 1 of bars 25 and 89",
    crash.map((n) => `${n.bar}.${n.beat}.${n.tick}`).join() === "25.1.0,89.1.0"
    && impact.map((n) => `${n.bar}.${n.beat}.${n.tick}`).join() === "25.1.0,89.1.0");
  ok("the impact is key-tracked to the root: 36 + 5 = 41 for F", impact.every((n) => n.pitch === 41));
}

console.log("\n  -- the hook: the shape is the reference, the melody is original --");
{
  const h = M.hook;
  const bars = (rows, from, to) => rows.filter((n) => n.bar >= from && n.bar <= to);
  const sig = (rows, off = 0) => rows.map((n) => `${n.bar - off}.${n.slot}.${n.pitch}`).join(",");
  ok("the header says so: shape from the reference, melody original, nothing reproduced", /original/i.test(h.shape) && /reference/i.test(h.shape));
  ok(`the cell is ${h.cell_size} notes — 2, 3 or 4 — on the "and"s (slots ${h.slots.join(",")})`,
    h.cell_size >= 2 && h.cell_size <= 4 && h.slots.length === h.cell_size && h.slots.every((s) => AND_SLOTS.includes(s)));
  const bar1 = bars(h.notes, 1, 1);
  const leapPairs = bar1.filter((n, i) => i + 1 < bar1.length && Math.abs(bar1[i + 1].pitch - n.pitch) === 12);
  ok(`bar 1 IS the cell (${bar1.length} notes) and holds an octave leap between consecutive notes, on the root pair (F4 65 ↔ F5 77)`,
    bar1.length === h.cell_size && leapPairs.length >= 1
    && leapPairs.some((n) => [65, 77].includes(n.pitch)) && bar1.some((n) => n.pitch === 65) && bar1.some((n) => n.pitch === 77));
  ok("the hook is 8 bars, every note on an off-beat 16th (never 0, 4, 8, 12), inside C4..Ab5 (60..80)",
    h.notes.every((n) => n.bar >= 1 && n.bar <= 8 && n.slot % 4 !== 0 && n.pitch >= 60 && n.pitch <= 80));
  ok("…and, as written, every note of the hook proper is on an \"and\" (slots 2, 6, 10, 14)",
    h.notes.every((n) => AND_SLOTS.includes(n.slot)));
  ok("bar 3 repeats the cell; bar 7 repeats it again (the earworm)",
    sig(bars(h.notes, 3, 3), 2) === sig(bar1) && sig(bars(h.notes, 7, 7), 6) === sig(bar1));
  ok("the response (bars 5-8) differs from the call (bars 1-4): bar 5 answers on another octave pair, bar 8 ends differently",
    sig(bars(h.notes, 5, 8), 4) !== sig(bars(h.notes, 1, 4)) && sig(bars(h.notes, 5, 5), 4) !== sig(bar1)
    && ["fifth", "third"].includes(h.response_pair)
    && bars(h.notes, 5, 5).some((n) => n.pitch === 65 + PAIRS[h.response_pair][0] || n.pitch === 65 + PAIRS[h.response_pair][1]));
  const last = h.notes[h.notes.length - 1];
  ok("it ends on the root: the last note is F4 (65), held to the bar line", last.bar === 8 && last.pitch === 65 && last.role === "end"
    && last.slot * (T / 4) + last.dur === 16 * (T / 4));
  ok("every note holds until the next hook note or 5 sixteenths — a note on the \"and\" is still sounding when the next kick ducks it",
    h.notes.every((n) => n.dur >= T / 4 && (n.dur <= 5 * (T / 4) || n.role === "end")) && h.notes.some((n) => n.dur >= 4 * (T / 4)));
  ok("the rhythm has rests: no hook bar carries more than 4 notes, and the tail/turnaround bars fewer than the cell",
    [1, 2, 3, 4, 5, 6, 7, 8].every((b) => bars(h.notes, b, b).length <= 4) && bars(h.notes, 4, 4).length === 2 && bars(h.notes, 8, 8).length === 2);
  /* the variant */
  const v = h.variant_notes;
  ok(`the variant ("${h.variant}") keeps the call (bars 1-4) and changes the response`,
    sig(bars(v, 1, 4)) === sig(bars(h.notes, 1, 4)) && sig(bars(v, 5, 8)) !== sig(bars(h.notes, 5, 8)) && ["higher", "displaced"].includes(h.variant));
  ok("…a displaced variant sits on the \"a\" (slots 3, 7, 11, 15): a 16th later, still never on a beat",
    h.variant !== "displaced" || bars(v, 5, 8).every((n) => [3, 7, 11, 15].includes(n.slot)));
  const hi = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => bigroomPlan({ seed }).meta.hook).find((x) => x.variant === "higher");
  ok("…a higher variant moves the response's cells to the third pair (Ab4 68 ↔ Ab5 80)",
    !!hi && hi.variant_notes.filter((n) => n.bar === 5).some((n) => n.pitch === 68) && hi.variant_notes.filter((n) => n.bar === 5).some((n) => n.pitch === 80)
    && hi.variant_notes.filter((n) => n.bar === 5).every((n) => n.slot === hi.notes.filter((m) => m.bar === 5)[hi.variant_notes.filter((n) => n.bar === 5).indexOf(n)]?.slot));
  /* the drops play it */
  const lead = notesOf("lead");
  const drop1 = lead.filter((n) => n.bar >= 25 && n.bar <= 32).map((n) => `${n.bar - 24}.${n.beat}.${n.tick}.${n.pitch}`).join();
  const drop1b = lead.filter((n) => n.bar >= 33 && n.bar <= 40).map((n) => `${n.bar - 32}.${n.beat}.${n.tick}.${n.pitch}`).join();
  const drop2 = lead.filter((n) => n.bar >= 89 && n.bar <= 96).map((n) => `${n.bar - 88}.${n.beat}.${n.tick}.${n.pitch}`).join();
  const asPlayed = (rows, off) => rows.map((n) => `${n.bar - off}.${Math.floor(n.slot / 4) + 1}.${(n.slot % 4) * (T / 4)}.${n.pitch}`).join();
  ok("drop 1 plays the hook, 8 bars then again; drop 2 plays the VARIANT",
    drop1 === asPlayed(h.notes, 0) && drop1b === drop1 && drop2 === asPlayed(v, 0) && drop2 !== drop1);
  ok("velocity scales by section: intro < build < drop",
    lead.find((n) => n.bar === 1).vel < lead.find((n) => n.bar === 9).vel
    && lead.find((n) => n.bar === 9).vel < lead.find((n) => n.bar === 25).vel);
  /* seeds */
  const hooks = [...Array(16)].map((_, i) => JSON.stringify(bigroomPlan({ seed: i + 1 }).meta.hook.notes));
  ok(`sixteen seeds give ${new Set(hooks).size} different hooks`, new Set(hooks).size >= 12);
  ok("the same seed gives the same hook, note for note", hooks[6] === JSON.stringify(bigroomPlan({ seed: 7 }).meta.hook.notes));
  ok("every seed's hook keeps the shape: a leap in bar 1, response ≠ call, ends on the root, nothing on a beat",
    [...Array(16)].every((_, i) => {
      const x = bigroomPlan({ seed: i + 1 }).meta.hook;
      const b1 = x.notes.filter((n) => n.bar === 1);
      const leap = b1.some((n, j) => j + 1 < b1.length && Math.abs(b1[j + 1].pitch - n.pitch) === 12);
      const l = x.notes[x.notes.length - 1];
      return leap && sig(x.notes.filter((n) => n.bar >= 5), 4) !== sig(x.notes.filter((n) => n.bar <= 4))
        && l.pitch === 65 && x.notes.every((n) => n.slot % 4 !== 0) && x.variant_notes.every((n) => n.slot % 4 !== 0);
    }));
  ok("hookBars is pure: the same choices render the same notes; hookNotes draws only from the prng it is given",
    JSON.stringify(hookBars(hookNotes(prng(5), 5, [0, 8, 3, 10]))) === JSON.stringify(hookNotes(prng(5), 5, [0, 8, 3, 10]).notes));
  ok("the route's `riff` is the hook (bars 1..8), so nothing downstream changes shape", JSON.stringify(M.riff) === JSON.stringify(h.notes));
  ok("the progression starts on the tonic and uses flats (F minor's VI is Db)",
    M.progression[0] === "F" && !M.progression.some((n) => n.includes("#")));
}

console.log("\n  -- the mix, as steps --");
{
  const ins = steps.filter((s) => s.action === "insert_add");
  const on = (t, type) => ins.find((s) => s.target === t && s.type === type);
  ok("EQ high-pass on lead (150), clap+snare (150), hats (150), crash (300), riser (300) — and nowhere else",
    ins.filter((s) => s.type === "eq").map((s) => `${s.target}:${s.params.hp_hz}`).sort().join()
      === "$track:clap+snare:150,$track:crash:300,$track:hats:150,$track:lead:150,$track:riser:300"
    && ins.filter((s) => s.type === "eq").every((s) => s.params.hp_on === true));
  /* THE CHAINS */
  const chain = (t) => ins.filter((s) => s.target === t).map((s) => s.type).join();
  ok("the lead's chain, in signal order: saturator → chorus → eq → delay → reverb → sidechain compressor",
    chain("$track:lead") === "saturator,chorus,eq,delay,reverb,compressor" && M.chains.lead.join() === chain("$track:lead"));
  ok("the sub's chain: saturator → sidechain compressor; the clap's: saturator → eq → reverb; the hats': eq",
    chain("$track:sub") === "saturator,compressor" && chain("$track:clap+snare") === "saturator,eq,reverb" && chain("$track:hats") === "eq"
    && M.chains.sub.join() === "saturator,compressor" && M.chains["clap+snare"].join() === "saturator,eq,reverb");
  const leadOf = (type) => ins.find((s) => s.target === "$track:lead" && s.type === type).params;
  ok("the lead's saturator: tanh, drive 10, mix 0.9; chorus 0.35 Hz / 2.5 ms / mix 0.3 / quadrature — LEAD_CHAIN's rows verbatim",
    JSON.stringify(leadOf("saturator")) === JSON.stringify(LEAD_CHAIN.saturator) && leadOf("saturator").drive_db === 10
    && leadOf("saturator").character === "tanh" && JSON.stringify(leadOf("chorus")) === JSON.stringify(LEAD_CHAIN.chorus)
    && leadOf("chorus").rate_hz === 0.35 && leadOf("chorus").spread === 1);
  ok("the lead's eq: hp 150, a +2 dB bell at 1.5 kHz, a wide +5 dB bell at 8 kHz standing in for the shelf (the catalog has none) — and no 300-400 Hz cut (measured under the reference already)",
    leadOf("eq").hp_hz === 150 && leadOf("eq").b3_hz === 1500 && leadOf("eq").b3_gain_db === 2
    && leadOf("eq").b4_hz === 8000 && leadOf("eq").b4_gain_db === 5 && leadOf("eq").b4_q === 0.4
    && leadOf("eq").b2_gain_db === undefined && leadOf("eq").b1_gain_db === undefined);
  ok("the lead's delay: sync 1/8d (a dotted eighth, tempo-synced by the device), ping-pong, feedback 0.25, tone 5 kHz, mix 0.18",
    leadOf("delay").sync === "1/8d" && DELAY_SYNC === "1/8d" && leadOf("delay").pingpong === true
    && leadOf("delay").feedback === 0.25 && leadOf("delay").tone_hz === 5000 && leadOf("delay").mix === 0.18);
  ok("…and the time it comes to: 351.563 ms at 128, 321.429 at 140, 357.143 at 126 (3/4 of a beat), reported in meta.delay",
    DELAY_QUARTERS === 0.75 && near(delayMs(128), 351.563) && near(delayMs(140), 321.429) && near(delayMs(126), 357.143)
    && near(M.delay.ms, 351.563) && M.delay.sync === "1/8d" && near(bigroomPlan({ tempo: 140 }).meta.delay.ms, 321.429)
    && near(bigroomPlan({ tempo: 126 }).meta.delay.ms, 357.143));
  ok("the lead's reverb: room_size 0.85 (T60 ≈ 2.1 s measured), 20 ms pre-delay, mix 0.15, full width",
    leadOf("reverb").room_size === 0.85 && leadOf("reverb").predelay_ms === 20 && leadOf("reverb").mix === 0.15 && leadOf("reverb").width === 1);
  const clapOf = (type) => ins.find((s) => s.target === "$track:clap+snare" && s.type === type).params;
  ok("the clap's saturator (6 dB, mix 0.7) and room (room_size 0.45 ≈ 0.85 s, mix 0.25, 5 ms); its eq hp 150 with a +3 dB bell at 10 kHz",
    clapOf("saturator").drive_db === 6 && clapOf("saturator").mix === 0.7 && clapOf("reverb").room_size === 0.45
    && clapOf("reverb").mix === 0.25 && clapOf("reverb").predelay_ms === 5 && clapOf("eq").hp_hz === 150 && clapOf("eq").b4_hz === 10000
    && clapOf("eq").b4_gain_db === 3 && JSON.stringify(clapOf("reverb")) === JSON.stringify(CLAP_CHAIN.reverb));
  ok("the hats' eq: hp 150 and a +8 dB air bell at 12 kHz (the 909 hat is the only voice carrying 8-20 kHz; +4 left the first bounce's air at −4.0 dB)",
    JSON.stringify(ins.find((s) => s.target === "$track:hats" && s.type === "eq").params) === JSON.stringify(HATS_EQ)
    && HATS_EQ.b4_hz === 12000 && HATS_EQ.b4_gain_db === 8 && HATS_EQ.hp_hz === 150);
  ok("the sub's saturator: 4 dB, mix 0.5, BEFORE the sidechain",
    JSON.stringify(ins.find((s) => s.target === "$track:sub" && s.type === "saturator").params) === JSON.stringify(SUB_CHAIN.saturator)
    && SUB_CHAIN.saturator.drive_db === 4 && SUB_CHAIN.saturator.mix === 0.5
    && ins.indexOf(ins.find((s) => s.target === "$track:sub" && s.type === "saturator")) < ins.indexOf(ins.find((s) => s.target === "$track:sub" && s.type === "compressor")));
  ok("every chain fits the mixer's 8-insert limit", ["$track:lead", "$track:sub", "$track:clap+snare", "$track:hats"].every((t) => chain(t).split(",").length <= 8));
  ok("kick, sub and impact carry no EQ — the Ear's kick bell (−9 dB at 173 Hz) is NOT taken: the riser moved instead",
    !on("$track:kick", "eq") && !on("$track:sub", "eq") && !on("$track:impact", "eq")
    && !ins.some((s) => s.target === "$track:kick"));
  ok("the riser's musical move: tone an octave up (F4), cutoff_start 600 Hz, high-pass 300 Hz — out of the kick's 120-250 band",
    M.riser.pitch === 65 && M.riser.cutoff_start === 600 && M.riser.hp_hz === 300 && RISER.hp_hz === 300
    && on("$track:riser", "eq").params.hp_hz === 300);
  const lp = on("$track:lead", "eq").params;
  ok("the lead's EQ carries the break's low-pass: open, 500 Hz at bar 57, open again by bar 73",
    lp.lp_on === true && lp.lp_hz.keys.map((k) => `${k.t}:${k.v}`).join() === "1:20000,57:500,73:20000");
  ok("…held open before and after (hold), linear across the break",
    lp.lp_hz.keys[0].ease === "hold" && lp.lp_hz.keys[1].ease === "linear"
    && near(evalProp(lp.lp_hz, 40), 20000) && near(evalProp(lp.lp_hz, 65), 10250) && near(evalProp(lp.lp_hz, 100), 20000));
  const sc = on("$track:lead", "compressor").params;
  ok("sidechain compressors on lead and sub, keyed from the KICK",
    sc.sidechain === "$track:kick" && on("$track:sub", "compressor").params.sidechain === "$track:kick");
  ok("ratio 20, hard knee, 0.5 ms attack, −20 dB threshold (the only one of −20/−16/−12 that keeps the depth at −12 dB), no makeup",
    sc.ratio === 20 && sc.knee_db === 0 && sc.attack_ms === 0.5 && sc.threshold_db === -20 && sc.makeup_db === 0
    && SIDECHAIN.threshold_db === -20);
  ok("release = 3/16 of a beat at the tempo (87.891 ms at 128): back within 2 dB by the next \"and\"", near(sc.release_ms, 87.891));
  const lim = on("master", "limiter");
  ok("a true-peak limiter on the master at −1 dBTP, aiming at −8 LUFS",
    lim?.params.ceiling_db === -1 && MASTER.ceiling_db === -1 && MASTER.target_lufs === -8 && M.master.target_lufs === -8);
  const door = loudnessTargetDoor();
  const mset = steps.find((s) => s.action === "mixer_set" && s.target === "master");
  ok("ONE mixer_set on the master turns the stereo switch on and sets target_lufs -8 (the bounce's second pass)",
    mset && mset.stereo === true && mset.target_lufs === -8 && M.master.stereo === true
    && steps.filter((s) => s.action === "mixer_set" && s.target === "master").length === 1);
  ok(`target_lufs_sent names the master strip, plus a rack device only when the catalog declares it (door: ${door ? door.device : "none"})`,
    door === null ? lim.params.target_lufs === undefined && M.master.target_lufs_sent === "master"
      : door.device === "limiter" ? lim.params.target_lufs === -8 && M.master.target_lufs_sent === "master+limiter"
      : !!ins.find((s) => s.target === "master" && s.type === door.device && s.params.target_lufs === -8)
        && ins.indexOf(ins.find((s) => s.target === "master" && s.type === door.device)) < ins.indexOf(lim));
  ok("…and never a parameter the catalog would refuse",
    ins.every((s) => Object.keys(s.params).every((k) => MIXER_CATALOG[s.type].params[k])));
  ok("EQ comes before the compressor on the lead (chain order is signal order)",
    ins.indexOf(on("$track:lead", "eq")) < ins.indexOf(on("$track:lead", "compressor")));
  const fad = steps.filter((s) => s.action === "mixer_set" && s.fader !== undefined);
  ok("faders: kick 0 (no step), sub −3, lead +4, clap+snare −2, hats +9, crash −3, riser −1, impact −3 — measured on the drop window (THE CHAINS); the riser −10 → −1 for the Ear's masking card",
    fad.length === 7 && !fad.some((s) => s.target === "$track:kick")
    && fad.find((s) => s.target === "$track:lead").fader === 4 && fad.find((s) => s.target === "$track:sub").fader === -3
    && fad.find((s) => s.target === "$track:clap+snare").fader === -2 && fad.find((s) => s.target === "$track:hats").fader === 9
    && JSON.stringify(FADERS) === JSON.stringify({ kick: 0, sub: -3, lead: 4, "clap+snare": -2, hats: 9, crash: -3, riser: -1, impact: -3 }));
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE TWO KNOBS THAT WERE SET BY HABIT, AND ARE NOW SET BY A NUMBER.
 *
 * The sub's release shipped as 200 in patches.json and 600 here, so a report
 * quoted whichever file it had read and neither number had been measured
 * against the kick. The hat pair was reported as costing 0.6-0.9 dB of top
 * end, from a MONO measurement that cannot see what a decorrelated channel
 * does. Both were re-measured through rack.chain_graph on this arranger's own
 * drop window; the tables ride on the plan (SUB_RELEASE_SWEEP,
 * HAT_KNOBS_MEASURED) so what follows checks the shipped value against the
 * measurement rather than against a number somebody typed twice.
 * ────────────────────────────────────────────────────────────────────────*/
console.log("\n  -- the sub's release, and the hat knobs, against their own measurements --");
{
  const pump = SUB_RELEASE_SWEEP.pump_depth_db;
  const best = Object.keys(pump).map(Number).sort((a, b) => pump[b] - pump[a])[0];
  ok(`SUB.release ${SUB.release} ms IS the maximum of the measured pump sweep (${pump[best]} dB at ${best}), `
    + `not a round number — 200 measured ${pump[200]} and 800 ${pump[800]}`,
    SUB.release === best && SUB.release === 500 && pump[500] === 22.62
    && Object.keys(pump).length >= 9 && pump[200] < pump[500] && pump[800] < pump[500]);
  ok("the sweep is unimodal around it: every step away from 500 measures less pump, in both directions",
    [450, 400, 350, 300, 200, 80].every((v, i, a) => pump[v] < pump[i === 0 ? 500 : a[i - 1]])
    && [550, 600, 700, 800].every((v, i, a) => pump[v] < pump[i === 0 ? 500 : a[i - 1]]));
  ok("...and the OTHER measurement is monotone, so it can veto a value but never choose one: "
    + "kick over sub in 30-90 Hz falls from +29.6 dB at 80 to +13.7 at 800",
    Object.keys(SUB_RELEASE_SWEEP.kick_over_sub_db).map(Number).sort((a, b) => a - b)
      .every((v, i, a) => i === 0 || SUB_RELEASE_SWEEP.kick_over_sub_db[v] < SUB_RELEASE_SWEEP.kick_over_sub_db[a[i - 1]]));
  ok(`at the shipped 500 the kick keeps ${SUB_RELEASE_SWEEP.kick_over_sub_db[500]} dB over the sub in its own band `
    + "— far over the Ear's 6 dB masking margin, so the longer note does not smear the kick",
    SUB_RELEASE_SWEEP.kick_over_sub_db[500] > 6 && SUB_RELEASE_SWEEP.kick_over_sub_db[500] === 15.82);
  ok(`"slightly longer": the note sounds ${SUB_RELEASE_SWEEP.note_sounds_s[500]} s against `
    + `${SUB_RELEASE_SWEEP.note_sounds_s[80]} s at the patch default — 2.4x, and 0.1 s under what 600 gave`,
    SUB_RELEASE_SWEEP.note_sounds_s[500] > 2 * SUB_RELEASE_SWEEP.note_sounds_s[80]
    && SUB_RELEASE_SWEEP.note_sounds_s[500] < SUB_RELEASE_SWEEP.note_sounds_s[600]);
  ok("THE TWO FILES AGREE: arrange.js's SUB.release IS patches.json's sub_bass bigroom preset release, "
    + "so the override is a no-op and no report can quote a number the other file does not hold",
    SUB.release === PATCHES.sub_bass.presets.bigroom.params.release
    && /release 500/.test(PATCHES.sub_bass.presets.bigroom.doc));
  /* The arithmetic the release is spent on, taken from the grid rather than
   * from a comment: the note is 460 ticks from the "and", so note-off is 20
   * ticks before the next kick and 500 ticks before the next sub note. */
  ok(`note-off to the next kick ${M.sub.release_to_kick_ms} ms = 20 ticks, and to the next sub note `
    + `${M.sub.release_to_next_note_ms} ms = 500 ticks, at 128 BPM`,
    near(M.sub.release_to_kick_ms, 20 / T * 60000 / 128, 5e-3)
    && near(M.sub.release_to_next_note_ms, 500 / T * 60000 / 128, 5e-3)
    && near(M.sub.release_to_kick_ms, 9.77, 0.01) && near(M.sub.release_to_next_note_ms, 244.14, 0.01));
  /* `release` is a time to −60 dB, so the tail's level anywhere after
   * note-off is closed form: −60 × t / release dB. */
  const tailDb = (t, rel) => -60 * t / rel;
  ok(`at the kick the tail is ${tailDb(M.sub.release_to_kick_ms, SUB.release).toFixed(2)} dB down and by the next `
    + `sub note ${tailDb(M.sub.release_to_next_note_ms, SUB.release).toFixed(1)} dB down — the sidechain then takes `
    + "the first of those, which is why the MEASURED separation is 15.8 dB and not 1",
    near(tailDb(M.sub.release_to_kick_ms, SUB.release), -1.17, 0.01)
    && near(tailDb(M.sub.release_to_next_note_ms, SUB.release), -29.3, 0.05));
  ok("the plan carries the sweep, so a caller reading it sees why 500 rather than a bare 500",
    M.sub.release_sweep === SUB_RELEASE_SWEEP && /rack\.chain_graph/.test(M.sub.release_sweep.method));

  const hk = HAT_KNOBS_MEASURED;
  ok("the hat knobs the plan sends ARE the ones the measurement is about (0.6 and 0.6)",
    hk.hat_vel.value === PATCHES.tr909.presets.bigroom.params.hat_vel
    && hk.hat_width.value === PATCHES.tr909.presets.bigroom.params.hat_width
    && M.hats.knobs_measured === hk);
  ok("hat_vel's cost is a LEVEL trim, not a loss of top end: presence −0.84, brilliance −0.83, air −0.90 dB — "
    + "under 0.1 dB of spread across the three bands, and identical in both channels",
    Math.max(...Object.values(hk.hat_vel.hats_bus_db)) - Math.min(...Object.values(hk.hat_vel.hats_bus_db)) < 0.1
    && hk.hat_vel.hats_bus_db.air === -0.90 && /identical/.test(hk.hat_vel.per_channel));
  ok("hat_width costs NOTHING per channel — an allpass is flat in magnitude — and its whole price is the fold",
    Object.values(hk.hat_width.hats_bus_db).every((v) => v === 0)
    && hk.hat_width.fold_air_db_width_alone < -1 && /flat in magnitude/.test(hk.hat_width.per_channel));
  ok(`hat_width stops at ${hk.hat_width.value} because of the Ear's mono floor: correlation `
    + `${hk.hat_width.hats_bus_correlation[0.6]} there, ${hk.hat_width.hats_bus_correlation[0.8]} at 0.8 and `
    + `${hk.hat_width.hats_bus_correlation[1.0]} at 1 — and the floor is 0.2`,
    hk.hat_width.hats_bus_correlation[hk.hat_width.value] > 0.45
    && hk.hat_width.hats_bus_correlation[1.0] < 0.2 && /correlation > 0\.2/.test(hk.hat_width.capped_by));
  ok("...and the correlation table is monotone in width, which is what makes 0.2 a floor you can spend against",
    [0.0, 0.3, 0.45, 0.6, 0.8, 1.0].every((w, i, a) =>
      i === 0 || hk.hat_width.hats_bus_correlation[w] < hk.hat_width.hats_bus_correlation[a[i - 1]]));
  ok("patches.json's own preset doc carries the per-channel re-measurement, so the two documents say one thing",
    /RE-MEASURED PER CHANNEL/.test(PATCHES.tr909.presets.bigroom.doc)
    && /0\.00 dB in each channel/.test(PATCHES.tr909.presets.bigroom.doc));
}

console.log("\n  -- deterministic, seeded, and refusing what it should --");
{
  ok("the same inputs give the same steps, byte for byte",
    JSON.stringify(bigroomPlan({})) === JSON.stringify(bigroomPlan({ seed: 1, key: "F", tempo: 128 })));
  const g = bigroomPlan({ seed: 3, key: "G", tempo: 140 });
  ok("key G: the hook's leap is on G4/G5 (67/79), sub on G1 (31), impact on 43, riser on G4 (67), kick tuned +0.357",
    g.meta.hook.notes.filter((n) => n.bar === 1).some((n) => n.pitch === 67) && g.meta.hook.notes.filter((n) => n.bar === 1).some((n) => n.pitch === 79)
    && notesOfPlan(g, "sub")[0].pitch === 31 && notesOfPlan(g, "impact")[0].pitch === 43 && notesOfPlan(g, "riser")[0].pitch === 67
    && g.meta.kick_tune === 0.3568);
  ok("tempo 140: release is 80.357 ms (3/16 of 428.571), the song 219.4 s",
    near(g.meta.sidechain_release_ms, 80.357) && near(g.meta.seconds, 128 * 4 * 60 / 140, 1e-3));
  ok("parseKey: 'f', 'F minor', 'Fm' and 'Gb' all parse; 'F major' and 'H' refuse",
    parseKey("f").pc === 5 && parseKey("F minor").pc === 5 && parseKey("Fm").pc === 5 && parseKey("Gb").pc === 6
    && throws(() => parseKey("F major"), /MINOR/) && throws(() => parseKey("H"), /note name/));
  ok("a structure with a 6-bar section is refused (the call is 4 bars)",
    throws(() => normStructure([{ type: "intro", bars: 6 }, { type: "drop", bars: 16 }]), /multiple of 4/));
  ok("a structure without a drop is refused", throws(() => normStructure([{ type: "intro", bars: 8 }]), /drop/));
  ok("a structure past 256 bars is refused", throws(() => normStructure([{ type: "drop", bars: 260 }]), /256/));
  ok("an unknown section type is refused", throws(() => normStructure([{ type: "chorus", bars: 8 }]), /chorus/));
  const short = bigroomPlan({ structure: [{ type: "build", bars: 8 }, { type: "drop", bars: 16 }] });
  ok("a short form: 24 bars, roll 4+2+2 bars, riser spans the whole 8-bar build minus a beat",
    short.meta.bars === 24 && notesOfPlan(short, "riser")[0].bar === 1 && notesOfPlan(short, "riser")[0].dur_ticks === 31 * T
    && notesOfPlan(short, "clap+snare").filter((n) => n.pitch === 38).length === 4 * 8 + 2 * 16 + 2 * 32 - 8);
  ok("a 4-bar section plays the hook's call only (bars 1-4)",
    (() => { const p = bigroomPlan({ structure: [{ type: "intro", bars: 4 }, { type: "drop", bars: 16 }] });
             const l = notesOfPlan(p, "lead").filter((n) => n.bar <= 4);
             return l.length === p.meta.hook.notes.filter((n) => n.bar <= 4).length && l.every((n) => n.bar <= 4); })());
  ok("no break → no low-pass on the lead's EQ",
    !short.steps.find((s) => s.action === "insert_add" && s.target === "$track:lead" && s.type === "eq").params.lp_on);
  ok("resolveRefs swaps names for ids, one level into params, and refuses a name with no id",
    resolveRefs({ track: "$track:kick", params: { sidechain: "$track:kick", ratio: 20 } }, { kick: "trk_1" }).params.sidechain === "trk_1"
    && throws(() => resolveRefs({ track: "$track:ghost" }, {}), /before its track exists/));
  ok("DEFAULT_STRUCTURE and ROLES are exported for the tools to quote",
    DEFAULT_STRUCTURE.length === 7 && Object.keys(ROLES).length === 8);
}
function notesOfPlan(p, name) {
  return p.steps.filter((s) => s.action === "record_notes" && s.track === `$track:${name}`).flatMap((s) => s.notes);
}

console.log("\n  -- the two doors quote the arranger, not a copy of it --");
{
  const html = await readFile(path.join(HERE, "..", "..", "web", "daw.html"), "utf8");
  const val = html.match(/id="arrForm"[^>]*\svalue="([^"]*)"/)?.[1];
  ok("web/daw.html's form field defaults to DEFAULT_FORM, character for character", val === DEFAULT_FORM, `${val} vs ${DEFAULT_FORM}`);
  ok("…and its blurb says the melody is original and the kick is tuned", /original/i.test(html.slice(html.indexOf('id="arrDlg"'), html.indexOf('id="kmDlg"')))
    && /tune/i.test(html.slice(html.indexOf('id="arrDlg"'), html.indexOf('id="kmDlg"'))));
  const tool = dawTools(async () => ({}), (x) => x).find((t) => t.name === "daw_arrange_bigroom");
  ok("the MCP tool's description carries DEFAULT_FORM, the measured release (87.891 ms, 3/16 of a beat), the kick tune and 'original'",
    tool.description.includes(DEFAULT_FORM) && /87\.891/.test(tool.description) && /3\/16/.test(tool.description)
    && /tune/i.test(tool.description) && /original/i.test(tool.description) && /-8 LUFS/.test(tool.description));
}

/* ═══════════════════════════ THE RUN ════════════════════════════════════ */

console.log("\n  -- THE RUN: through the real route, into a scratch dir --");
{
  ok(`the store writes under the scratch dir (${OUT})`, store.DAW_DIR().startsWith(OUT));
}
if (!store.DAW_DIR().startsWith(OUT)) {
  console.log("  refusing to run the disk half anywhere but the scratch dir");
} else {
  const json = (res, code, body) => { res.writeHead(code, {}); res.end(JSON.stringify(body)); };
  const readBody = async (req) => req.body;
  const handle = createDawRoutes({ json, readBody, config: { outputDir: OUT, python: "python" } });
  async function call(method, pathname, body) {
    const cap = { code: 0, out: "" };
    const res = {
      writeHead(c) { cap.code = c; return res; }, setHeader() { return res; },
      write(s) { cap.out += s; return true; }, end(s) { if (s != null) cap.out += s; },
    };
    const handled = await handle({ method, body, headers: {} }, res, new URL(`http://daw.test${pathname}`));
    if (!handled) throw new Error(`unhandled ${method} ${pathname}`);
    const j = JSON.parse(cap.out);
    if (j.error) throw new Error(j.error);
    return j;
  }
  const post = (body) => call("POST", "/api/daw", body);
  const project = (slug) => call("GET", `/api/daw/project/${encodeURIComponent(slug)}`);
  const stripPos = (n) => `${n.bar}.${n.beat}.${n.tick}.${n.durTicks}.${n.pitch}.${n.vel}`;

  let r, doc;
  try {
    const t0 = Date.now();
    r = await post({ action: "arrange_bigroom", seed: 1, by: "agent" });
    const ms = Date.now() - t0;
    ok(`arrange_bigroom created ${r.slug} in ${ms} ms and ${r.steps} steps`, r.created === true && r.steps === plan.steps.length + 1);
    ok("it reports 8 tracks, 128 bars, 240 s, 32 regions", r.tracks.length === 8 && r.bars === 128 && near(r.seconds, 240) && r.regions === 32);
    ok(`it reports ${r.notes} notes — the plan's count`, r.notes === M.notes);
    ({ project: doc } = await project(r.slug));
  } catch (err) {
    ok("the arranger ran", false, err.stack || err.message);
  }

  if (doc) {
    const rows = buildTimeline(doc);
    ok("the document is 128 bars of 4/4 at 128 with one meter and one tempo event",
      doc.lengthBars === 128 && rows.length === 128 && doc.meterMap.length === 1 && doc.tempoMap.length === 1
      && doc.tempoMap[0].bpm === 128 && near(rows[127].sec + rows[127].secLen, 240));
    const names = doc.tracks.map((t) => t.name).join();
    ok("tracks: kick, sub, lead, clap+snare, hats, crash, riser, impact", names === "kick,sub,lead,clap+snare,hats,crash,riser,impact", names);
    ok("patches: hybrid_kick, sub_bass, bigroom_lead, tr909, tr909, tr909, riser, impact",
      doc.tracks.map((t) => t.instrument.patch).join() === "hybrid_kick,sub_bass,bigroom_lead,tr909,tr909,tr909,riser,impact");
    const kick = doc.tracks[0];
    ok("the kick holds the bigroom preset AND tune −1.6432 (drive 0.1 equals the default and is dropped on write)",
      JSON.stringify(kick.instrument.params) === JSON.stringify({ tune: -1.6432, decay: 0.06, snap: 0.2, pitch_amount: 0.6, punch: 1 }),
      JSON.stringify(kick.instrument.params));
    ok("the riser holds cutoff_start 600 (the store kept the knob: it is declared in patches.json)",
      doc.tracks[6].instrument.params.cutoff_start === 600, JSON.stringify(doc.tracks[6].instrument.params));
    ok("the lead holds LEAD and the preset's layer_level 0.35 (layer_octave 1 is the default and is dropped on write)",
      JSON.stringify(doc.tracks[2].instrument.params) === JSON.stringify({ spread: 1, cutoff: 3500, filter_amount: 2.2, filter_decay: 120, layer_level: 0.35 }),
      JSON.stringify(doc.tracks[2].instrument.params));
    ok("the sub holds sub_mix 0.2, release 500, mid_layer 0.8 (mid_cutoff 400 is the default and is dropped)",
      JSON.stringify(doc.tracks[1].instrument.params) === JSON.stringify({ sub_mix: 0.2, release: 500, mid_layer: 0.8 }),
      JSON.stringify(doc.tracks[1].instrument.params));
    ok("clap+snare holds the tr909 preset with clap_noise 0.7; hats hold it with spread 0.6 — every key declared, none refused",
      doc.tracks[3].instrument.params.clap_noise === 0.7 && doc.tracks[3].instrument.params.clap_room === 0.4 && doc.tracks[3].instrument.params.hat_width === 0.6
      && doc.tracks[4].instrument.params.spread === 0.6 && doc.tracks[4].instrument.params.hat_vel === 0.6 && doc.tracks[4].instrument.params.clap_noise === 0.5,
      JSON.stringify([doc.tracks[3].instrument.params, doc.tracks[4].instrument.params]));

    let stored = 0, legal = 0, inside = 0, onGrid = 0;
    for (const t of doc.tracks) for (const c of t.clips) for (const n of c.notes) {
      stored++;
      try { const p = normPos(doc, n, "n"); if (p.bar === n.bar && p.beat === n.beat && p.tick === n.tick) legal++; } catch { /* gap */ }
      if (noteInClip(c, n)) inside++;
      if (n.tick % (T / 8) === 0) onGrid++;
    }
    ok(`${stored} notes stored — every one a valid {bar, beat, tick} in range`, stored === M.notes && legal === stored, `${legal}/${stored}`);
    ok("every note is inside its clip, so every note sounds", inside === stored);
    ok("every note is on the 32nd grid", onGrid === stored);
    ok("every note is stamped by: agent (the caller's attribution)",
      doc.tracks.every((t) => t.clips.every((c) => c.notes.every((n) => n.by === "agent"))));
    const perTrack = Object.fromEntries(doc.tracks.map((t) => [t.name, t.clips.reduce((a, c) => a + c.notes.length, 0)]));
    ok("per-track counts match the plan",
      Object.keys(ROLES).every((n) => perTrack[n] === notesOf(n).length), JSON.stringify(perTrack));
    ok("31 clips, named for their sections",
      doc.tracks.reduce((a, t) => a + t.clips.length, 0) === 31
      && doc.tracks.every((t) => t.clips.every((c) => /^(intro|build|drop|break|outro) \d$/.test(c.name))));
    ok("clips do not overlap on any track (record_notes needs exactly one clip per bar)",
      doc.tracks.every((t) => t.clips.every((c, i) => t.clips.every((d, j) => i === j || c.toBar < d.fromBar || d.toBar < c.fromBar))));
    ok("the sounding events equal the stored notes (nothing muted, nothing outside)",
      store.noteEvents(doc).length === stored);
    ok("the hook's held notes keep their length through the store (dur ≥ a 16th, the ending 2400 ticks)",
      doc.tracks[2].clips[0].notes.every((n) => n.durTicks >= T / 4) && doc.tracks[2].clips.some((c) => c.notes.some((n) => n.durTicks === 2400)));

    const byName = Object.fromEntries(doc.tracks.map((t) => [t.name, t]));
    const lead = byName.lead, sub = byName.sub;
    ok("lead chain: saturator, chorus, eq, delay, reverb, compressor; sub chain: saturator, compressor; clap+snare: saturator, eq, reverb — the store kept the order",
      lead.inserts.map((i) => i.type).join() === "saturator,chorus,eq,delay,reverb,compressor" && sub.inserts.map((i) => i.type).join() === "saturator,compressor"
      && byName["clap+snare"].inserts.map((i) => i.type).join() === "saturator,eq,reverb" && byName.hats.inserts.map((i) => i.type).join() === "eq");
    ok("both compressors are keyed from the kick's ID (not its name)",
      lead.inserts[5].params.sidechain === kick.id && sub.inserts[1].params.sidechain === kick.id);
    ok("release 87.891 ms, ratio 20, attack 0.5 ms, knee 0, threshold −20 survived normParams",
      near(lead.inserts[5].params.release_ms, 87.891) && lead.inserts[5].params.ratio === 20
      && lead.inserts[5].params.attack_ms === 0.5 && lead.inserts[5].params.knee_db === 0 && lead.inserts[5].params.threshold_db === -20);
    ok("the lead EQ: hp 150 on, lp on with three float-bar keys, the 1.5 k and 8 k bells",
      lead.inserts[2].params.hp_on === true && lead.inserts[2].params.hp_hz === 150
      && lead.inserts[2].params.lp_on === true && lead.inserts[2].params.lp_hz.keys.length === 3
      && lead.inserts[2].params.b4_hz === 8000 && lead.inserts[2].params.b4_gain_db === 5 && lead.inserts[2].params.b3_gain_db === 2);
    ok("the lead's delay kept sync \"1/8d\" (an enum the store honours), pingpong true, tone 5000; the reverb room_size 0.85 / predelay 20; the saturator tanh 10 dB",
      lead.inserts[3].params.sync === "1/8d" && lead.inserts[3].params.pingpong === true && lead.inserts[3].params.tone_hz === 5000
      && lead.inserts[4].params.room_size === 0.85 && lead.inserts[4].params.predelay_ms === 20 && lead.inserts[4].params.mix === 0.15
      && lead.inserts[0].params.drive_db === 10 && lead.inserts[0].params.character === "tanh" && lead.inserts[1].params.rate_hz === 0.35,
      JSON.stringify(lead.inserts.map((i) => i.params)));
    ok("clap+snare (150), hats (150 + 12 k bell), crash, riser (300 Hz) have an EQ; kick and impact have none; the sub has no EQ",
      byName["clap+snare"].inserts[1]?.type === "eq" && byName["clap+snare"].inserts[1].params.hp_hz === 150
      && byName.hats.inserts[0].params.hp_hz === 150 && byName.hats.inserts[0].params.b4_hz === 12000 && byName.hats.inserts[0].params.b4_gain_db === 8
      && byName.crash.inserts[0]?.type === "eq"
      && byName.riser.inserts[0]?.type === "eq" && byName.riser.inserts[0].params.hp_hz === 300
      && !kick.inserts.length && !byName.impact.inserts.length && !sub.inserts.some((i) => i.type === "eq"));
    ok("the master carries its limiter at −1 dBTP, last in its chain",
      doc.master.inserts.length >= 1 && doc.master.inserts[doc.master.inserts.length - 1].type === "limiter"
      && doc.master.inserts[doc.master.inserts.length - 1].params.ceiling_db === -1);
    ok("faders: kick 0, sub −3, lead +4, clap+snare −2, hats +9, crash −3, riser −1, impact −3",
      doc.tracks.map((t) => t.fader).join() === "0,-3,4,-2,9,-3,-1,-3", doc.tracks.map((t) => t.fader).join());
    ok("the mixer is non-default, so the render would go through the chain graph", !(await import("./mixer.js")).isDefaultMixer(doc));
    ok("the sidechain edge is in the region reach (mixerReach sees the kick keys a compressor)",
      (await import("./mixer.js")).mixerReach(doc, kick).fwd === Infinity);

    ok("the ledger holds every step, all by agent, none by the store's own hand",
      doc.ledger.length >= 75 && doc.ledger.every((e) => e.by === "agent")
      && new Set(doc.ledger.map((e) => e.action)).size === 6, [...new Set(doc.ledger.map((e) => e.action))].join());
    ok("the reply's roles map the minted ids to the Ear's vocabulary",
      Object.keys(r.roles).length === 8 && r.roles[kick.id] === "drums" && r.roles[lead.id] === "lead" && r.roles[sub.id] === "bass"
      && r.roles[byName.hats.id] === "drums" && r.roles[byName["clap+snare"].id] === "drums");
    ok("the reply's per-track rows name id, patch, role, clips and inserts — and the kick's params carry the tune",
      r.tracks.every((t) => t.id && t.patch && t.role && Array.isArray(t.clips) && Array.isArray(t.inserts))
      && r.tracks[0].params.tune === -1.6432);

    /* the same seed twice → the same music (ids differ, the notes do not) */
    const r2 = await post({ action: "arrange_bigroom", seed: 1, by: "agent" });
    const { project: doc2 } = await project(r2.slug);
    const flat = (d) => d.tracks.map((t) => t.clips.flatMap((c) => c.notes.map(stripPos)).join("|")).join("#");
    ok("arranging seed 1 again gives note-for-note the same song in a new slug",
      r2.slug !== r.slug && flat(doc2) === flat(doc));

    /* the refusals */
    let refused = "";
    try { await post({ action: "arrange_bigroom", slug: r.slug }); } catch (e) { refused = e.message; }
    ok("arranging into the arranged project is refused, naming what is there", /is not empty/.test(refused), refused);
    try { refused = ""; await post({ action: "arrange_bigroom", slug: "no-such-project-here" }); } catch (e) { refused = e.message; }
    ok("an unknown slug is refused", /No such project/.test(refused), refused);
    try { refused = ""; await post({ action: "arrange_bigroom", structure: [{ type: "drop", bars: 6 }] }); } catch (e) { refused = e.message; }
    ok("a bad structure is refused before anything is created", /multiple of 4/.test(refused), refused);
    try { refused = ""; await post({ action: "arrange_bigroom", key: "F major" }); } catch (e) { refused = e.message; }
    ok("a major key is refused", /MINOR/.test(refused), refused);

    /* an existing EMPTY project, other key and tempo */
    const c = await post({ action: "create", name: "empty", bpm: 100, length_bars: 4 });
    const r3 = await post({ action: "arrange_bigroom", slug: c.slug, seed: 4, key: "Ab", tempo: 130 });
    const { project: doc3 } = await project(c.slug);
    ok("an empty project is arranged in place: length, meter and tempo set first",
      r3.created === false && r3.slug === c.slug && r3.steps === plan.steps.length + 3
      && doc3.lengthBars === 128 && doc3.tempoMap[0].bpm === 130 && doc3.tracks.length === 8);
    ok("…at 130 the delay is 346.154 ms (3/4 of 461.538), the sub note 0.2123 s, and the store kept sync \"1/8d\"",
      near(delayMs(130), 346.154) && near(doc3.tracks[1].clips[0].notes[0].durTicks, 460)
      && doc3.tracks[2].inserts.find((i) => i.type === "delay").params.sync === "1/8d");
    ok("Ab minor at 130: release 86.538 ms, the hook's leap on Ab4/Ab5 (68/80), kick tuned +1.357 (Ab1, 51.9 Hz)",
      near(r3.sidechain_release_ms, 86.538) && r3.riff.filter((n) => n.bar === 1).some((n) => n.pitch === 68)
      && r3.riff.filter((n) => n.bar === 1).some((n) => n.pitch === 80) && r3.key === "Ab"
      && doc3.tracks[0].instrument.params.tune === 1.3568);

    /* the MCP tool, over the same handler */
    const api = async (method, p, body) => { try { return await call(method, p, body); } catch (e) { return { error: e.message }; } };
    const tool = dawTools(api, (s) => s).find((t) => t.name === "daw_arrange_bigroom");
    ok("daw_arrange_bigroom exists, refuses undeclared properties, requires nothing",
      !!tool && tool.inputSchema.additionalProperties === false && !(tool.inputSchema.required || []).length);
    ok("its description teaches the release (3/16 of a beat, 87.891 ms), the form, the hook and the roles",
      /87\.891/.test(tool.description) && /intro 8 \| build 16 \| drop 32/.test(tool.description) && /roles/.test(tool.description)
      && /hook/i.test(tool.description));
    const t4 = await tool.run({ seed: 9, key: "D", tempo: 126, name: "tool run",
      structure: [{ type: "intro", bars: 4 }, { type: "build", bars: 8 }, { type: "drop", bars: 16 }, { type: "outro", bars: 4 }] });
    ok("the tool run: 32 bars in D minor at 126, 8 tracks, roles by id, kick tune reported (−4.643 → D1 36.7 Hz)",
      t4.bars === 32 && t4.key === "D minor" && t4.tempo === 126 && t4.tracks.length === 8
      && Object.values(t4.roles).sort().join() === "bass,drums,drums,drums,drums,fx,fx,lead" && t4.kick_tune === -4.6432, JSON.stringify(t4).slice(0, 300));
    ok("…its structure has no break, so the lead's EQ has no low-pass; the chain is still saturator … compressor",
      t4.tracks.find((t) => t.name === "lead").inserts.join() === "saturator,chorus,eq,delay,reverb,compressor"
      && !(await project(t4.slug)).project.tracks.find((t) => t.name === "lead").inserts[2].params.lp_on);
    const gp = dawTools(api, (s) => s).find((t) => t.name === "daw_get_project");
    const summary = await gp.run({ slug: r.slug, include_notes: true });
    ok("daw_get_project reads the arranged song back with every note",
      summary.tracks.length === 8 && summary.notes.reduce((a, t) => a + t.notes.length, 0) === M.notes);
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (!process.env.KEEP_ARRANGE_TEST) await rm(OUT, { recursive: true, force: true });
else console.log(`  kept ${OUT}\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
