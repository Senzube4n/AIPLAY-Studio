/**
 * DAW — the big-room arranger. One whole song, planned as the ACTIONS a
 * human would have clicked, in the order they would have clicked them.
 *
 * ┌─ WHY THIS MODULE EXISTS ───────────────────────────────────────────────┐
 * │ The owner asked the DAW for "Animals"-shaped big-room house and got    │
 * │ nothing like it. synths.py fixed the palette (a unison-saw pluck, a    │
 * │ sub, a riser, an impact); OBJECTIVE.md:52 still reads "big-room EDM    │
 * │ with a hard four-on-the-floor transient and strict 16-bar phrasing —   │
 * │ unmet", because nothing ARRANGED those voices. This file does: 128     │
 * │ bars at 128 BPM in a minor key, laid down as tracks, clips, notes,     │
 * │ inserts and faders.                                                    │
 * │                                                                        │
 * │ It writes NOTHING itself. bigroomPlan() returns an ordered list of     │
 * │ plain route bodies — add_track, add_clip, record_notes, insert_add,    │
 * │ mixer_set — and routes.js's `arrange_bigroom` feeds them one at a time │
 * │ through the SAME dispatcher the page and the MCP tools use. So the     │
 * │ document that comes out is exactly the document a person would have   │
 * │ made by hand: every note carries `by`, every step is a ledger row,     │
 * │ every clip is a section you can drag, and there is no second write    │
 * │ path to keep honest.                                                   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * THE REFERENCE, AND ITS LIMIT
 *
 *   The owner said "a banger EDM track like Animals from Martin Garrix,
 *   instrumentally". That names a TARGET SHAPE, not a melody to copy, and
 *   this file treats it as exactly that: a big-room drop built on a 2-4
 *   note hook CELL with an octave leap; call (bars 1-4) and response (bars
 *   5-8); notes pushed onto the "and" so the kick's pump reads as a swell;
 *   rests on every beat so the pump has room; a filter-pluck lead over a
 *   sidechained sub; a 16-bar build with a snare roll doubling every 4 bars
 *   and a riser; one beat of silence before the drop; an impact on the
 *   downbeat. The MELODY is ORIGINAL: hookNotes() below writes it from the
 *   seed, differently for every seed, and nothing in this module quotes,
 *   reproduces or approximates that song's melody. The shape is the
 *   reference; the notes are ours.
 *
 * THE FORM (bars; the default, overridable per section)
 *
 *   intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8
 *   = 128 bars = exactly 4:00 at 128 BPM. Every section is a multiple of 4
 *   bars (the hook is 8, and a 4-bar section plays its call) and the
 *   builds/drops/break sit on 16-bar phrases; an override is refused if a
 *   section breaks the 4-bar grid, if there is no drop, or if the total
 *   passes the store's 256-bar limit. DEFAULT_FORM is the same form as the
 *   string the dialog shows; arrange_test pins web/daw.html to it.
 *
 * WHAT PLAYS WHERE
 *
 *   kick      hybrid_kick, the `bigroom` preset from patches.json (measured
 *             there: T60 0.50 s, so the tail clears before the next beat),
 *             plus a `tune` DERIVED FROM THE KEY — see THE KICK IN TUNE.
 *             Every beat in intro, build, drop and outro; NOT in the break;
 *             and OUT for the final beat of every build — the beat of
 *             silence before the drop, which every track keeps: no kick,
 *             no hat, no roll, no lead (not even a sustaining tail), and
 *             the riser has already ended.
 *   sub       sub_bass on the kick's RESTS — the off-beat eighth of every
 *             beat — carrying the bar's chord root in the sub octave (F1..E2
 *             for F minor: 43.6–77.8 Hz). Drop and outro only.
 *   lead      bigroom_lead, THE HOOK: one 8-bar phrase (below), repeated
 *             across the section; the second drop plays its VARIANT.
 *             Intro (quiet), build, drop (accented), break.
 *   clap+snare tr909: clap (39) on 2 and 4 in the drop (CLAP_VEL), and the
 *             build's snare roll (38) — eighths for the first half,
 *             sixteenths for the third quarter, thirty-seconds for the
 *             last, velocity ramping ROLL.from→ROLL.to, stopping at the end
 *             of beat 3 of the last bar. The hits that take the room: its
 *             chain is a saturator and a short reverb (THE CHAINS).
 *   hats      tr909: open hat (46) on every off-beat eighth outside the
 *             break, the "and" of 2 and 4 accented; in the drop, closed
 *             hats (42) on the "e" and the "a", quieter (HATS). Its own
 *             track because a fader is per track and the drop's hats want
 *             +9 dB where the clap's room does not.
 *   crash     tr909 crash (49) on beat 1 of every drop.
 *   riser     ONE note per build spanning its last 8 bars minus one beat
 *             (31 beats) — the riser's filter opens over the note's own
 *             length, so the note IS the sweep, and it ends where the
 *             silence starts. Pitched F4 (60 + key) and started with its
 *             lowpass at RISER.cutoff_start — see THE MUSICAL MOVE.
 *   impact    on beat 1 of every drop, key 36 + the key's semitone so the
 *             sub-drop lands on the song's root (F: key 41 → 44 Hz).
 *
 *   riser and impact are two TRACKS, not one "fx" track: a track holds one
 *   patch, and they are two patches. clap+snare and hats are two tracks of
 *   the same patch for the other reason: a chain and a fader are per track.
 *
 * THE HOOK (hookNotes / hookBars)
 *
 *   Register: [root4 − 5, root4 + 15] — C4..Ab5 for F. Three OCTAVE PAIRS
 *   live inside it: fifth (C4→C5), root (F4→F5), third (Ab4→Ab5).
 *
 *   The CELL is 2, 3 or 4 notes on the "and"s of one bar (16th slots 2, 6,
 *   10, 14 — never 0, 4, 8, 12, the kick's). Two consecutive cell notes are
 *   an octave leap on the root pair, up or down; the rest are chord tones
 *   of the tonic within an octave of root4. The seed chooses the size, the
 *   slots, the leap's direction and position, and the fillers.
 *
 *   Eight bars, on the seeded progression (chords c0 c1 c2 c3, twice):
 *
 *     bar 1  the cell                      ┐ the CALL
 *     bar 2  a tail: 1-2 notes in c1       │
 *     bar 3  the cell again                │
 *     bar 4  a turnaround: c3's root, and a pickup on the "and" of 4
 *     bar 5  the cell on the RESPONSE pair (fifth or third: the answer)  ┐ the RESPONSE
 *     bar 6  the tail                                                   │
 *     bar 7  the cell                                                   │
 *     bar 8  the ending: c3's root, then the ROOT, held through beats 3-4 ┘
 *
 *   Every note is held until the next hook note or 5 sixteenths, whichever
 *   is sooner (the ending's root: to the bar line) — so a note on the "and"
 *   is still sounding when the next kick ducks it, and the sidechain's
 *   recovery is heard as a SWELL rather than a gap. A note is clipped so
 *   nothing sustains into a section's beat of silence.
 *
 *   The VARIANT (second drop): "higher" moves the response's cells to the
 *   third pair; "displaced" shifts every response note one 16th later,
 *   onto the "a" — the anticipation of the next beat, still never on it.
 *   The seed picks which; a hook whose response is already on the third
 *   pair is displaced. The call is untouched, so the ear still knows the
 *   hook.
 *
 * THE KICK IN TUNE
 *
 *   hybrid_kick's sub sits at 48 Hz at key 36 with tune 0 (patches.json,
 *   measured). F1 is 43.65 Hz: untuned, the kick and the sub beat at 4.4 Hz
 *   under every drop. kickTune(pc) sends `tune` = 12·log2(f_root / 48)
 *   for the root's octave nearest 48 Hz (|tune| ≤ 6 semitones, so the kick
 *   stays closest to the voice that was measured): F → −1.643 (43.65 Hz),
 *   G → +0.357 (49.0 Hz), C → +5.357 (65.4 Hz, C2). Both hands can turn the
 *   knob afterwards; the arranger just stops sending zero.
 *
 * THE MIX
 *
 *   Sidechain compressors on lead and sub keyed from the KICK's dry signal
 *   (rack.py dev_compressor reads ctx["dry"][kick id]): ratio 20, hard knee,
 *   0.5 ms attack, threshold −20 dB, release = THREE SIXTEENTHS OF A BEAT
 *   (60000 / bpm · 3/16 = 87.89 ms at 128). MEASURED, not reasoned: the
 *   first draft argued its way to one eighth (60000/bpm/2 = 234.375 ms)
 *   and the render showed the gain still 5.9 dB down at the off-beat and
 *   never back past −2 dB before the next kick — the lead never surfaced.
 *   Fed through the real device against the real kick key (the hybrid
 *   kick's detector holds the compressor 12.08 dB down and sits above the
 *   threshold for 38 ms): 117 ms (a sixteenth) is still −2.96 dB at the
 *   "and", 90 ms is −1.99, 87.9 ms is −1.91, and −20 dB is the only
 *   threshold of {−20, −16, −12} that keeps the depth at −12 dB (−16
 *   gives −8.3, −12 gives −4.5). So: depth −12 dB at the kick, back
 *   within 2 dB by the next "and" — the pump metric, met.
 *
 *   EQ high-pass on everything that is not a sub element: lead 150 Hz,
 *   clap+snare 150 Hz, hats 150 Hz, crash 300 Hz, riser 300 Hz. Kick, sub
 *   AND impact are left alone — the impact is a sub-drop, and high-passing
 *   it would keep the click and throw away the point.
 *
 *   The lead's EQ also carries the BREAK's filter: lp_hz automated (float-
 *   bar keys, the house shape) from 500 Hz at the break's first bar opening
 *   to 20 kHz at the following section's first bar, held wide open
 *   everywhere else. One insert, two jobs.
 *
 *   Faders (FADERS): kick 0, sub −3, lead +4, clap+snare −2, hats +9, crash
 *   −3, riser −1, impact −3 dB — the third take's, measured with the
 *   chains in (THE CHAINS). The riser: at −10 the Ear's top card on the
 *   third take's second bounce was "lead masks riser, 500-1000 Hz, bars
 *   17-23, +20.7 dB" (the riser bus at −29 LUFS under a lead at −10); +9 on
 *   its fader moves every build band by under 0.3 dB (measured) and takes
 *   the margin to +11.7 — the riser is heard again. The second take's history, still true of how
 *   the numbers were found: the first draft had the lead at −6 and the drop was
 *   "kick + sub with a faint pluck" (the Ear: lead 500-2k at −38.6 dBFS
 *   against a sub band at −22; lead 6-8 dB under its role target). The
 *   brief guessed +2; the drop window (bars 25-32) rendered through the
 *   real graph with the Ear's own functions said otherwise: at +2 the lead
 *   sat 5.3 dB OVER its role target and masked the clap+hat at 1-2 kHz by
 *   12 dB; at 0, 3.8 over and 10 dB; at −2, 1.4 over and one marginal
 *   event. The hook itself carries the rest of the lift — held notes and
 *   the octave landing put the lead 10.7 dB louder than the old riff at
 *   the same fader. Sub −6 was tried and refused: the kick then masked
 *   the sub in its own band (20-120 Hz, +8.8 dB); at −3 the margin is
 *   under the Ear's 6 dB. clap+hat −8 → −5 puts the hats 2.6 dB from
 *   their role target instead of 5.7 and lifts 4-20 kHz by 2 dB. The Ear
 *   measures the render, and its numbers win.
 *
 *   MASTER: a true-peak limiter at MASTER.ceiling_db (−1 dBTP), and the
 *   master strip's two settings sent with one mixer_set on "master":
 *   `stereo: true` (the rack renders each voice's own channels — the lead's
 *   7-voice spread reaches the file instead of folding to (L+R)/2) and
 *   `target_lufs` (−8 LUFS): the bounce's second pass (master.loudness_stage)
 *   gains the assembled song into the −1 dBTP ceiling with at most 3 dB of
 *   limiting and reports what it reached. Should the rack's catalog ever
 *   declare `target_lufs` on a device, it is sent there too (loudnessTargetDoor);
 *   the plan's meta.master.target_lufs_sent says where it went.
 *
 * THE CHAINS (the third take, and the finding it exists for)
 *
 *   The owner listened to the second take and said: the lead is "extremely
 *   basic, it doesn't have the proper effects", the clap and hat "a bit
 *   simple", the bass should be "heavier and slightly longer". What was
 *   true of that track: the lead carried an EQ high-pass and the sidechain
 *   and nothing else; the clap and hat were one 909 voice each at a fixed
 *   velocity; the sub was a sine on off-beat eighths with an 80 ms release.
 *   And the prover's numbers agreed: 250-500 Hz +6 dB over ear.py's edm
 *   reference on the drop, 2-4 k −8, 4-8 k −13, 8-20 k −17.
 *
 *   The rack already had every device this needed (rack.py DEVICES), and the
 *   voices strand added the knobs (bigroom_lead layer_level, sub_bass
 *   mid_layer / a longer release, tr909 clap_noise / clap_room / hat_vel /
 *   hat_width) with a `bigroom` preset on each row of patches.json. This
 *   file sends those presets on add_track exactly as it sends the kick's,
 *   and places the devices as insert_add steps exactly as it places the
 *   eq and the sidechain — one door, no second write path.
 *
 *   The chains (LEAD_CHAIN, SUB_CHAIN, CLAP_CHAIN, HATS_EQ, each in signal
 *   order):
 *
 *     lead   saturator (tanh 10 dB, mix 0.9) → chorus (0.35 Hz, 2.5 ms,
 *            mix 0.3, quadrature) → eq (hp 150, +2 dB at 1.5 k, a wide +5
 *            dB bell at 8 k standing in for a shelf, and the break's
 *            low-pass) → delay (a dotted eighth, tempo-synced by the device:
 *            351.6 ms at 128, ping-pong, feedback 0.25, tone 5 k, mix 0.18)
 *            → reverb (room_size 0.85: T60 ≈ 2.1 s on an impulse, pre-delay
 *            20 ms, mix 0.15; the wet is taken after the eq, so it is
 *            already high-passed) → the sidechain compressor, unchanged.
 *            The voice: cutoff 3500 / filter_amount 2.2 / filter_decay 120
 *            / spread 1 (LEAD) plus the preset's layer_level 0.35.
 *     sub    saturator (4 dB, mix 0.5) → the sidechain. The voice: the
 *            preset's mid_layer 0.8 at 400 Hz, release 500 ms (SUB — see
 *            THE SUB'S RELEASE), notes held 460 ticks from the "and" — to
 *            20 ticks before the next kick (the old 420 left 60).
 *     clap   saturator (6 dB, mix 0.7) → eq (hp 150, +3 dB at 10 k) →
 *            reverb (room_size 0.45: T60 ≈ 0.85 s, 5 ms, mix 0.25). The
 *            voice: the preset's burst and room, clap_noise 0.7 over it.
 *     hats   eq (hp 150, +8 dB at 12 k). The voice: the preset (hat_vel 0.6
 *            turns quieter hats shorter; hat_width 0.6 decorrelates the
 *            right channel — the master's stereo switch is on; both re-read
 *            per channel, see THE HAT KNOBS) and spread 0.6. The velocities
 *            are WRITTEN (HATS): 108 / 96 on the open hats, 82 / 92 on the
 *            drop's closed sixteenths.
 *
 *   Measured on the drop window (bars 25-32) through the real graph with
 *   ear.py's own bands, second take → this one: boxiness +0.2 → +1.8, mid
 *   −5.0 → −0.6, upper-mid −10.3 → −2.0, presence −11.5 → −0.6, brilliance
 *   −13.6 → −1.8, air −15.9 → −3.4 dB; the master's L/R correlation 0.973 →
 *   0.78 (the lead bus 0.68 → 0.47, the hats 1.00 → 0.53); the crest
 *   (true peak over LUFS) 12.4 → 9.5 dB, under the 10 dB that −8 LUFS with
 *   3 dB of limiting allows; the lead's 500-2 k band 13 dB under the sub
 *   band → 0.6 dB under; the kick 8.9 dB over the sub in 30-90 Hz in the
 *   120 ms after each kick (the sidechain still holds; a dotted-eighth sub
 *   note measured 7.5, so the note ends before the kick instead). What each
 *   move bought, in order: opening the lead's filter took the boxiness
 *   band 2 dB UNDER the reference on its own, so the 300-400 Hz cut the
 *   brief asked for was tried (−3 dB → −5.9) and left out; the faders
 *   (lead −2 → +4, hats −5 → +9, clap −5 → −2, crash −9 → −3) bought the
 *   most of 2-20 kHz; the saturator at 10 dB is what closed the crest; the
 *   air bells on the hats and the clap took 8-20 k from −5.3 to −3.4, and
 *   that is the palette's limit: the 909 open hat (band-passed 6.5-15 kHz)
 *   and the clap's burst are the only voices with anything above 8 kHz.
 *   The build: the roll at 72→127 with the clap's chain sat 4.9 dB over
 *   the kick and made the build louder than the drop, so it ramps 50→89.
 *
 *   Bounced (bigroom-take-3-2 / -3 / -4, PCM_24, one move per round,
 *   measured on the FILE with ear.py's bands): round 1 (the chains) reached
 *   −8.76 LUFS at −1.01 dBTP, drop-1 L/R correlation 0.80, every drop band
 *   within 3 dB but air (−4.0); round 2 (the hats' air bell +4 → +8) air
 *   −2.0, upper-mid −2.8, the rest closer, −8.87 LUFS; round 3 (riser −10
 *   → −1) unchanged in the drop, the Ear's masking penalty 71.9 → 38.0 and
 *   its balance penalty 21.9 (second take) → 0.1. The second take's file:
 *   −9.71 LUFS, correlation 0.90, presence −8.3, brilliance −11.0, air
 *   −16.1. The hats' "breathing" is small and honest — the numbers are in
 *   THE HAT KNOBS below, re-measured per channel; the closed sixteenths
 *   ring 0.045 s, 9 dB under. The Ear still says the lead, hats and clap
 *   sit above where its role table expects them and that the lead masks the
 *   clap at 1-2 kHz by 12 dB — a lead at kick level is the genre, and the
 *   owner's ear decides.
 *
 *   EVERY BAND NUMBER ABOVE IS THE MONO FOLD, because that is all
 *   ear.spectral_balance measured when they were taken. It measures L, R
 *   and the fold now, and on this same window the fold is the wrong number
 *   twice: boxiness reads −0.02 folded and is +2.72 on the left against
 *   −0.22 on the right, and air reads −1.34 folded against −1.51 left and
 *   +0.40 right. The mix is more lopsided than the fold ever said.
 *
 * THE SUB'S RELEASE (the number two files disagreed about)
 *
 *   patches.json's sub_bass `bigroom` preset shipped release 200 and this
 *   file overrode it with 600, so a report quoted 200 or 600 depending on
 *   which of the two it had read, and neither number had been measured
 *   against the kick. Both are 500 now, and arrange_test fails if they ever
 *   diverge again.
 *
 *   `release` is a time to −60 dB after note-off. The sub note starts on the
 *   "and" and is 460 ticks long, so note-off is 9.77 ms before the next kick
 *   and 244.15 ms before the next sub note: the knob is entirely a decision
 *   about how much of each note lands on the kick and on its own successor.
 *
 *   Swept 80 → 800 ms through rack.chain_graph on the arranged drop window
 *   (bars 25-28, 586 notes — the same graph the bounce uses; bars 89-92
 *   measure the same to 0.01 dB, because kick and sub play the same bar in
 *   every drop bar). PUMP DEPTH is the master's 30-90 Hz envelope in 10 ms
 *   frames averaged over the window's 16 kicks, max minus min:
 *
 *     ms      80    200    300    350    400    450   [500]   550    600    700    800
 *     dB   21.69  21.83  22.04  22.20  22.38  22.54  22.62  22.57  22.38  21.59  20.47
 *
 *   and the kick's own band, kick over sub in 30-90 Hz across the 120 ms
 *   after each kick: +29.6 (80) / +21.8 (200) / +19.0 (300) / +17.1 (400) /
 *   +15.8 (500) / +14.9 (600) / +13.7 (800) dB — monotone, so this half is
 *   a straight trade and cannot pick a value on its own.
 *
 *   The note alone (460 ticks, 224.6 ms, at the arranger's sub params)
 *   sounds 0.30 s at the patch default 80, 0.43 at 200, 0.74 at 500, 0.84
 *   at 600, 1.04 at 800; and its tail where the NEXT sub note starts is
 *   exactly zero at 200 and under (the voice's buffer is dur + release +
 *   20 ms and ends first), −28.2 dB under the note's own body at 500,
 *   −23.2 at 600, −16.9 at 800.
 *
 *   500 it is. The pump — which is what big room actually is — peaks there
 *   and falls either side, and nothing trades against that choice: it keeps
 *   0.9 dB more kick separation than 600, bleeds 5 dB less into the next
 *   note, and still sounds 2.4x as long as the patch default, which is the
 *   "heavier and slightly longer" the owner asked for. 800 is where it
 *   stops being a trade at all — the pump loses 2.2 dB because the sub
 *   never gets out of the kick's way.
 *
 * THE HAT KNOBS, RE-READ PER CHANNEL (one of the two costs nothing)
 *
 *   The pair was reported as costing 0.6-0.9 dB of top end. Measured per
 *   channel on the same drop window against hat_vel 0 / hat_width 0, that
 *   cost belongs to ONE of them and is not a loss of top end:
 *
 *     hat_vel 0.6    hats bus presence −0.84, brilliance −0.83, air −0.90
 *                    dB — the SAME in both channels, so it is a near-flat
 *                    0.86 dB LEVEL trim. It reads as a top-end loss only
 *                    because the 909 hats hold nothing under 6.5 kHz. On
 *                    the master: air −0.60 L, −0.63 R, −1.88 folded. What
 *                    it buys at the velocities this file writes (108 over
 *                    96): the accent sits 1.46 dB over the plain hat rather
 *                    than 1.05, and rings 0.356 s against 0.345 (T30).
 *     hat_width 0.6  ±0.00 dB in EACH channel, in every band, at every
 *                    width — an allpass is flat in magnitude. Its entire
 *                    cost is the fold: on its own it takes 1.37 dB of the
 *                    hats bus's air, and with hat_vel's 0.90 beside it the
 *                    shipped pair folds 2.27 dB down (3.25 at width 0.8,
 *                    4.51 at 1.0). What it buys: the hats bus's L/R
 *                    correlation 1.000 → 0.513, the master's 0.858 → 0.791,
 *                    the master's width 0.277 → 0.342.
 *
 *   Both stay at 0.6, now for a number rather than a habit. hat_vel's 0.86
 *   dB is a level the hats' +9 dB fader was already measured with, so it is
 *   paid for. hat_width stops at 0.6 because the Ear calls a bus mono-
 *   compatible at correlation > 0.2 and the steps above spend that margin:
 *   0.8 leaves 0.04 of it and 1.0 fails outright at −0.05.
 *
 * THE MUSICAL MOVE (the riser, and why the kick keeps its EQ-less chain)
 *
 *   The Ear's top card on the first bounce was "kick masks riser, 120-250
 *   Hz, bars 17-20", and every route it offered was on the MASKER: a −9 dB
 *   bell at 173 Hz on the kick, a duck, a fader, a high-pass. Taking the
 *   bell cost 1.7 LUFS and 0.8 dB of kick transient and left the masking
 *   at +12 dB, because the riser had not moved: its tone started at F3
 *   (175 Hz) and its lowpass at 200 Hz, so for the first bars of its sweep
 *   its energy WAS the 120-250 band — the kick's band. A producer raises
 *   the riser instead: tone an octave up (F4), cutoff_start 600 Hz, EQ
 *   high-pass 300 Hz. The riser no longer needs that band, the Ear's
 *   salience gate stops counting it, and the kick keeps its transient. The
 *   Ear's routes are suggestions; when one lands on the masker, move the
 *   maskee.
 *
 * TELLING THE EAR. Track names are chosen so ear.js's ROLE_HINTS infer the
 * right role, and ROLES below is returned by the route so a caller can pass
 * it to daw_critique / daw_analyze explicitly — the Ear refuses to judge a
 * track's level on a guessed role, and it should not have to guess here.
 *
 * DETERMINISM. Same (seed, key, tempo, structure) → the same steps, byte
 * for byte (arrange_test.js pins it). The PRNG is mulberry32; nothing reads
 * the clock. Ids are minted by the store when the steps run, which is why
 * steps refer to tracks as "$track:<name>" and the runner resolves them.
 */
import { PATCHES, LIMITS, TICKS_PER_BEAT } from "./store.js";
import { MIXER_CATALOG } from "./mixer.js";

/* ─────────────────────────────────────────────────────────── the form */

export const SECTION_TYPES = ["intro", "build", "drop", "break", "outro"];

export const DEFAULT_STRUCTURE = [
  { type: "intro", bars: 8 },
  { type: "build", bars: 16 },
  { type: "drop", bars: 32 },
  { type: "break", bars: 16 },
  { type: "build", bars: 16 },
  { type: "drop", bars: 32 },
  { type: "outro", bars: 8 },
];

/** The form as the dialog's field shows it: "intro 8 | build 16 | …". */
export const formString = (list) => list.map((s) => `${s.type} ${s.bars}`).join(" | ");
export const DEFAULT_FORM = formString(DEFAULT_STRUCTURE);

/** Validate a structure override: [{type, bars}], bars a positive multiple
 * of 4, at least one drop, total within the store's length limit. Returns
 * the sections with their absolute bar ranges filled in. */
export function normStructure(list) {
  const src = list === undefined || list === null ? DEFAULT_STRUCTURE : list;
  if (!Array.isArray(src) || !src.length) {
    throw new Error("structure must be a non-empty array of { type, bars } — "
      + `types ${SECTION_TYPES.join(", ")}; e.g. ${JSON.stringify(DEFAULT_STRUCTURE)}.`);
  }
  const out = [];
  let bar = 1;
  const counts = {};
  for (const [i, s] of src.entries()) {
    const type = String(s?.type || "");
    if (!SECTION_TYPES.includes(type)) {
      throw new Error(`structure[${i}].type "${type}" is not one of ${SECTION_TYPES.join(", ")}.`);
    }
    const bars = Number(s?.bars);
    if (!Number.isInteger(bars) || bars < 4 || bars % 4) {
      throw new Error(`structure[${i}] (${type}).bars must be a positive multiple of 4 — the hook's call is 4 bars — got ${s?.bars}.`);
    }
    counts[type] = (counts[type] || 0) + 1;
    out.push({ type, bars, from: bar, to: bar + bars - 1, n: counts[type] });
    bar += bars;
  }
  const total = bar - 1;
  if (total > LIMITS.lengthBars) {
    throw new Error(`structure totals ${total} bars; the store's limit is ${LIMITS.lengthBars}.`);
  }
  if (!counts.drop) throw new Error("structure needs at least one drop — that is the song.");
  return out;
}

/* ─────────────────────────────────────────────────────────── the key */

const PITCH_CLASS = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5, "F#": 6, GB: 6,
  G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11,
};

/** "F", "f", "F minor", "Fm", "F#", "Gb" → { name: "F", pc: 5 }. Minor is
 * the only mode here (big room is minor), so "major" is refused rather than
 * silently played minor. */
export function parseKey(key) {
  const raw = key === undefined || key === null || key === "" ? "F" : String(key).trim();
  if (/maj/i.test(raw)) throw new Error(`key "${raw}": the arranger writes MINOR keys only — give the root, e.g. "F".`);
  const m = raw.match(/^([A-Ga-g])([#b]?)/);
  if (!m) throw new Error(`key "${raw}" is not a note name — use C, C#, Db, D … B (minor is implied).`);
  const name = m[1].toUpperCase() + m[2];
  const pc = PITCH_CLASS[name.toUpperCase()];
  return { name, pc };
}

/** hybrid_kick's fundamental at key 36 with tune 0 — patches.json's word,
 * measured there ("f0 stays 48 Hz at key 36"). */
export const KICK_F0_HZ = 48;

/** The `tune` (semitones) that puts the kick's fundamental ON the song's
 * root, in the root's octave nearest 48 Hz. F → −1.643 (F1, 43.65 Hz). */
export function kickTune(keyPc) {
  const midiOf48 = 69 + 12 * Math.log2(KICK_F0_HZ / 440);     // 30.643: where 48 Hz sits on the MIDI line
  let tune = (24 + keyPc) - midiOf48;                          // the sub's octave: C1..B1
  while (tune > 6) tune -= 12;
  while (tune <= -6) tune += 12;
  return Math.round(tune * 1e4) / 1e4;
}

/** The kick's fundamental in Hz for a tune value — for tests and meta. */
export const kickHz = (tune) => KICK_F0_HZ * 2 ** (tune / 12);

/* ───────────────────────────────────────────────── the musical material */

/** Chord-root progressions as semitone offsets from the key, one per bar of
 * the 4-bar cycle (the hook is two cycles). Every chord is diatonic to the
 * natural minor; the seed picks one. i–VI–III–VII first, because it is the
 * anthem. */
export const PROGRESSIONS = [
  [0, 8, 3, 10],   // i  VI III VII
  [0, 0, 8, 10],   // i  i  VI  VII
  [0, 3, 8, 10],   // i  III VI VII
  [0, 8, 5, 10],   // i  VI iv  VII
  [0, 8, 10, 10],  // i  VI VII VII
];

/** Chord tones (semitones above the key) for a diatonic root: minor on
 * i/iv/v, major on III/VI/VII. */
function chordTones(root) {
  const third = [0, 5, 7].includes(root) ? 3 : 4;
  return [root, (root + third) % 12, (root + 7) % 12];
}

/** The "and" of each beat, as 16th slots of a bar. The beats themselves
 * (0, 4, 8, 12) are the kick's and never carry a hook note. */
export const AND_SLOTS = [2, 6, 10, 14];

/** The octave pairs a cell can leap across, as semitone offsets from root4,
 * all inside the hook's register [root4 − 5, root4 + 15]. */
export const PAIRS = { fifth: [-5, 7], root: [0, 12], third: [3, 15] };

/** Sixteenths a hook note may sustain — a beat and a quarter, so a note on
 * the "and" is still sounding when the next kick ducks it. */
const HOLD_SLOTS = 5;

/** mulberry32 — small, seedable, good enough to pick notes. */
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

/** n of the four "and" slots, in order, chosen by the seed. */
function chooseSlots(rnd, n) {
  const pool = [...AND_SLOTS];
  const out = [];
  while (out.length < n) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out.sort((a, b) => a - b);
}

/**
 * Draw the hook's CHOICES from the seed — every decision the header lists,
 * and nothing else consumes randomness — so hookBars() can render the hook
 * and its variant from the same choices. Returns the choices plus the
 * rendered hook (`notes`) and variant (`variant`).
 *
 *   cellSize      2, 3 or 4 notes
 *   slots         which "and"s the cell sits on
 *   leapUp        the octave leap rises (60 %) or falls
 *   leapAt        index of the leap's first note in the cell
 *   fillers       chord tones of the tonic within an octave of root4, for
 *                 the cell's non-leap notes (drawn once; the response cell
 *                 keeps them and changes only the pair)
 *   responsePair  "fifth" or "third" — the answer's octave pair
 *   tail          { count 1|2, slots } for bars 2 and 6
 *   pickup        the turnaround's pickup: the fifth above or below root4
 *   variantKind   "higher" or "displaced" for the second drop
 */
export function hookNotes(rnd, keyPc, progression) {
  const root4 = 60 + keyPc;
  const cellSize = 2 + Math.floor(rnd() * 3);
  const slots = chooseSlots(rnd, cellSize);
  const leapUp = rnd() < 0.6;
  const leapAt = Math.floor(rnd() * (cellSize - 1));
  const tonic = chordTones(progression[0]).map((t) => (t + keyPc) % 12);
  const fillerPool = [];
  for (let p = root4 - 5; p <= root4 + 7; p++) {
    if (p !== root4 && tonic.includes(((p % 12) + 12) % 12)) fillerPool.push(p);
  }
  const fillers = [];
  for (let i = 0; i < cellSize - 2; i++) fillers.push(pick(rnd, fillerPool));
  const responsePair = rnd() < 0.5 ? "fifth" : "third";
  const tailCount = rnd() < 0.5 ? 1 : 2;
  const tail = { count: tailCount, slots: tailCount === 1 ? [pick(rnd, [2, 6])] : pick(rnd, [[2, 10], [6, 14]]) };
  const pickup = rnd() < 0.5 ? 7 : -5;
  let variantKind = rnd() < 0.5 ? "higher" : "displaced";
  if (variantKind === "higher" && responsePair === "third") variantKind = "displaced";
  const choices = { root4, keyPc, progression, cellSize, slots, leapUp, leapAt, fillers, responsePair, tail, pickup, variantKind };
  return { ...choices, notes: hookBars(choices), variant: hookBars(choices, variantKind) };
}

/**
 * Render the 8-bar hook from its choices: notes { bar 0..7, slot 0..15,
 * dur (ticks), pitch, vel, role }. `variant` is "higher", "displaced" or
 * null (the hook as written). Pure: the same choices give the same notes.
 */
export function hookBars(c, variant = null) {
  const { root4, keyPc, progression } = c;
  const lo = root4 - 5, hi = root4 + 15;
  const tonesOf = (off) => chordTones(off).map((t) => (t + keyPc) % 12);
  const rootPcOf = (off) => (off + keyPc) % 12;
  /** The pitch of class `pc` nearest to `near`, inside the register. */
  const place = (pc, near, not = null) => {
    let best = null;
    for (let p = lo; p <= hi; p++) {
      if (p % 12 !== pc || p === not) continue;
      if (best === null || Math.abs(p - near) < Math.abs(best - near)) best = p;
    }
    return best ?? root4;
  };
  /** The chord tone of `off` nearest `near`, not `not`. */
  const nearestTone = (off, near, not = null) => {
    const tones = tonesOf(off);
    let best = null;
    for (let p = lo; p <= hi; p++) {
      if (!tones.includes(p % 12) || p === not) continue;
      if (best === null || Math.abs(p - near) < Math.abs(best - near)) best = p;
    }
    return best ?? root4;
  };
  const cell = (pairName) => {
    const [a, b] = PAIRS[pairName].map((o) => root4 + o);
    const leap = c.leapUp ? [a, b] : [b, a];
    const pitches = [];
    let k = 0;
    for (let i = 0; i < c.cellSize; i++) {
      if (i === c.leapAt) { pitches.push(leap[0], leap[1]); i++; } else pitches.push(c.fillers[k++]);
    }
    return c.slots.map((slot, i) => ({
      slot, pitch: pitches[i],
      vel: i === c.leapAt + 1 ? 122 : i === c.leapAt ? 112 : 106,
      role: i === c.leapAt + 1 ? "leap" : i === c.leapAt ? "leap" : "cell",
    }));
  };
  const tail = (off, from) => {
    const first = nearestTone(off, root4 + 2, from);
    const rows = [{ slot: c.tail.slots[0], pitch: first, vel: 100, role: "tail" }];
    if (c.tail.count === 2) rows.push({ slot: c.tail.slots[1], pitch: place(rootPcOf(off), root4), vel: 100, role: "tail" });
    return rows;
  };
  const turnaround = (off) => [
    { slot: 2, pitch: place(rootPcOf(off), root4), vel: 104, role: "turn" },
    { slot: 14, pitch: root4 + c.pickup, vel: 108, role: "pickup" },
  ];
  const ending = (off) => [
    { slot: 2, pitch: place(rootPcOf(off), root4), vel: 104, role: "turn" },
    { slot: 6, pitch: root4, vel: 116, role: "end" },
  ];

  const responsePair = variant === "higher" ? "third" : c.responsePair;
  const A = cell("root"), R = cell(responsePair);
  const bars = [
    A, tail(progression[1], A[A.length - 1].pitch), A, turnaround(progression[3]),
    R, tail(progression[1], R[R.length - 1].pitch), A, ending(progression[3]),
  ];
  if (variant === "displaced") {
    for (let b = 4; b < 8; b++) bars[b] = bars[b].map((n) => ({ ...n, slot: n.slot + 1 }));
  }
  /* durations: to the next hook note (cyclically) or HOLD_SLOTS sixteenths;
   * the ending's root holds to the bar line */
  const flat = [];
  bars.forEach((rows, bar) => rows.forEach((n) => flat.push({ bar, ...n })));
  const S = TICKS_PER_BEAT / 4;
  for (const [i, n] of flat.entries()) {
    const at = n.bar * 16 + n.slot;
    const next = i + 1 < flat.length ? flat[i + 1].bar * 16 + flat[i + 1].slot : flat[0].bar * 16 + flat[0].slot + 128;
    const gap = next - at;
    const cap = n.role === "end" ? 16 - n.slot : HOLD_SLOTS;
    n.dur = Math.min(gap, cap) * S;
  }
  return flat;
}

/* ───────────────────────────────────────────── the mix, as constants */

/** One eighth at the tempo, in ms — the release the first draft reasoned
 * its way to. Kept for the record; the release the plan sends is measured. */
export const eighthMs = (bpm) => Math.round(60000 / bpm / 2 * 1000) / 1000;

/** The sidechain release, as a fraction of a beat: 3/16 (a dotted 32nd),
 * 87.891 ms at 128 — the largest release whose gain is back within 2 dB by
 * the next "and" against the hybrid kick's key (see THE MIX). */
export const SIDECHAIN_RELEASE_BEATS = 3 / 16;
export const sidechainReleaseMs = (bpm) => Math.round(60000 / bpm * SIDECHAIN_RELEASE_BEATS * 1000) / 1000;
export const SIDECHAIN = { threshold_db: -20, ratio: 20, attack_ms: 0.5, knee_db: 0, makeup_db: 0 };

/** The master's aim: −8 LUFS integrated under a −1 dBTP ceiling. */
export const MASTER = { target_lufs: -8, ceiling_db: -1 };

/** The riser's musical move: out of the kick's band. */
export const RISER = { cutoff_start: 600, hp_hz: 300, octave: 60 };

/* ─────────────────────────────────────────── THE CHAINS (the third take) */

/** The lead's own filter, opened: the pluck RESTED at 320 Hz with Q≈3, and
 * that resonance was the boxiness the second take measured (250-500 Hz +6
 * dB over the reference). Measured on the drop window, see THE CHAINS. */
export const LEAD = { cutoff: 3500, filter_amount: 2.2, filter_decay: 120, spread: 1.0 };

/** The delay is TEMPO-SYNCED by the device (rack.py reads `sync` against
 * the tempo map), so the arranger sends a note value and reports the time
 * it comes to: a dotted eighth = 3/4 of a beat = 351.5625 ms at 128. */
export const DELAY_SYNC = "1/8d";
export const DELAY_QUARTERS = 0.75;
export const delayMs = (bpm) => Math.round(60000 / bpm * DELAY_QUARTERS * 1000) / 1000;

/** The lead's chain, in signal order. Every row is one insert_add; the
 * keys are rack.py CATALOG names (arrange_test checks every one against
 * MIXER_CATALOG, so a typo cannot reach the store). The sidechain
 * compressor (SIDECHAIN, below) closes the chain. */
export const LEAD_CHAIN = {
  saturator: { drive_db: 10, character: "tanh", mix: 0.9, trim_db: 0 },
  chorus: { rate_hz: 0.35, depth_ms: 2.5, mix: 0.3, spread: 1 },
  /* hp 150; the "shelf" above 6 kHz is a wide bell at 8 kHz (Q 0.4) — the
   * catalog has no shelf. The 300-400 Hz cut the brief asked for is NOT
   * here: with the filter opened (LEAD) the boxiness band measured 2 dB
   * UNDER the reference before any bell, and a −3 dB bell took it to −6 */
  eq: { hp_on: true, hp_hz: 150, b3_hz: 1500, b3_gain_db: 2, b3_q: 0.8, b4_hz: 8000, b4_gain_db: 5, b4_q: 0.4 },
  delay: { sync: DELAY_SYNC, feedback: 0.25, mix: 0.18, pingpong: true, tone_hz: 5000 },
  /* room_size 0.85 measured T60 ≈ 2.1 s on an impulse (0.8 → 1.8, 0.9 →
   * 2.5); the wet is taken AFTER the eq, so it is already high-passed */
  reverb: { room_size: 0.85, damp: 0.5, width: 1, mix: 0.15, predelay_ms: 20 },
};

/** The sub: longer notes (SUB.note_ticks from the "and", see the plan), a
 * longer release, the mid layer up so the bass reads on a phone, and a
 * light saturator BEFORE the sidechain so the pump is not re-shaped.
 *
 * THE RELEASE IS 500 ms AND IT WAS MEASURED, not reasoned to. `release` is a
 * time-to-−60 dB, so it decides how far each off-beat note runs into the
 * kick that lands 9.77 ms after note-off and into the next sub note 244.15
 * ms after it. Swept 80 → 800 ms through rack.chain_graph on this arranger's
 * own drop window — the table is in THE SUB'S RELEASE, up in the header.
 * The master's 30-90 Hz pump depth peaks at 500 (22.62 dB) and falls either
 * side of it, the kick keeps 15.8 dB over the sub in its own band, and the
 * note sounds 0.74 s against 0.30 at the patch default. patches.json's
 * `bigroom` preset carries the same 500 and arrange_test refuses to let the
 * two drift apart again: the preset said 200 while this file sent 600, and
 * every report quoted whichever number it happened to read. */
export const SUB = { note_ticks: 460, release: 500, mid_layer: 0.8, mid_cutoff: 400 };
export const SUB_CHAIN = { saturator: { drive_db: 4, character: "tanh", mix: 0.5, trim_db: 0 } };

/** The sweep SUB.release came out of, carried as data rather than left in a
 * comment: the plan returns it, and arrange_test asserts the shipped value
 * IS this table's maximum — so moving the knob without re-measuring fails
 * the commit rather than quietly becoming another undocumented number. */
export const SUB_RELEASE_SWEEP = {
  method: "rack.chain_graph on the arranged drop window (bars 25-28, 586 notes), "
    + "the same graph the bounce uses; bars 89-92 measure the same to 0.01 dB",
  /* max − min of the master's 30-90 Hz envelope in 10 ms frames, averaged
   * over the window's 16 kicks. THIS is what picks the value. */
  pump_depth_db: {
    80: 21.69, 200: 21.83, 300: 22.04, 350: 22.20, 400: 22.38, 450: 22.54,
    500: 22.62, 550: 22.57, 600: 22.38, 700: 21.59, 800: 20.47,
  },
  /* kick over sub in 30-90 Hz across the 120 ms after each kick: monotone,
   * so it can veto a value but never choose one. */
  kick_over_sub_db: { 80: 29.57, 200: 21.82, 300: 18.98, 400: 17.13, 500: 15.82, 600: 14.89, 800: 13.71 },
  /* the note alone, 460 ticks at 128 BPM, at the arranger's sub params */
  note_sounds_s: { 80: 0.304, 200: 0.433, 300: 0.533, 400: 0.639, 500: 0.740, 600: 0.845, 800: 1.037 },
  /* its tail where the NEXT sub note starts, dB under the note's own body;
   * null = the voice's buffer has already ended, so it is exactly zero */
  tail_at_next_note_db: { 80: null, 200: null, 300: -48.33, 400: -35.74, 500: -28.19, 600: -23.17, 800: -16.94 },
};

/** The hat knobs, re-measured PER CHANNEL (ear.spectral_balance reports L, R
 * and the fold now). The pair was reported as costing 0.6-0.9 dB of top end;
 * per channel that cost is hat_vel's alone and is a flat level trim, and
 * hat_width's cost exists only in the mono fold. See THE HAT KNOBS. */
export const HAT_KNOBS_MEASURED = {
  method: "the same drop window, against hat_vel 0 / hat_width 0; band LEVEL, not share",
  hat_vel: {
    value: 0.6,
    hats_bus_db: { presence: -0.84, brilliance: -0.83, air: -0.90 },
    per_channel: "identical L and R — a level trim, not a tone change",
    master_air_db: { left: -0.60, right: -0.63, fold: -1.88 },
    buys: "accent over plain 1.05 → 1.46 dB, T30 0.356 s against 0.345",
  },
  hat_width: {
    value: 0.6,
    hats_bus_db: { presence: 0.0, brilliance: 0.0, air: 0.0 },
    per_channel: "an allpass is flat in magnitude: zero at every width",
    /* the fold, WITH hat_vel at its shipped 0.6 — so each entry carries
     * hat_vel's own −0.90 as well; width alone at 0.6 is −1.37 of it */
    fold_air_db_with_hat_vel: { 0.3: -1.27, 0.45: -1.70, 0.6: -2.27, 0.8: -3.25, 1.0: -4.51 },
    fold_air_db_width_alone: -1.37,
    /* hat_vel does not move this: 0.513 at hat_vel 0, 0.514 at 0.6 */
    hats_bus_correlation: { 0.0: 1.0, 0.3: 0.856, 0.45: 0.701, 0.6: 0.513, 0.8: 0.239, 1.0: -0.046 },
    buys: "master correlation 0.858 → 0.791, master width 0.277 → 0.342",
    capped_by: "the Ear's mono-compatible floor, correlation > 0.2",
  },
};

/** The clap's chain, in signal order: a saturator for snap, the high-pass,
 * then a short room (room_size 0.45 measured T60 ≈ 0.85 s) at a quarter. */
export const CLAP_CHAIN = {
  saturator: { drive_db: 6, character: "tanh", mix: 0.7, trim_db: 0 },
  eq: { hp_on: true, hp_hz: 150, b4_hz: 10000, b4_gain_db: 3, b4_q: 0.5 },
  reverb: { room_size: 0.45, damp: 0.5, width: 1, mix: 0.25, predelay_ms: 5 },
};
/** The clap's noise burst, over the preset's 0.5: the top end is where the
 * second take was 13-17 dB dark, and the burst is 6-16 kHz. */
export const CLAP = { clap_noise: 0.7 };

/** The hats' EQ: the high-pass, and an air bell at 12 kHz — the 909 open
 * hat is band-passed 6.5-15 kHz and is the ONLY voice carrying 8-20 kHz.
 * +4 was the first bounce (air −4.0 dB in the file); +8 measured air −1.4
 * on the drop window with the rest of the bands within 2.5. */
export const HATS_EQ = { hp_on: true, hp_hz: 150, b4_hz: 12000, b4_gain_db: 8, b4_q: 0.5 };

/** The hats, WRITTEN into velocities: the open hat on every "and", accented
 * on the "and" of 2 and 4; in the drop, closed hats on the "e" and the "a"
 * (the other two off-beat sixteenths), quieter, the "a" a shade louder as
 * the pickup. The 909's hat_vel (preset) turns quieter into shorter, so
 * the pattern breathes rather than ticks. */
export const HATS = { accent: 108, plain: 96, closed_e: 82, closed_a: 92, spread: 0.6 };

/** What each track IS, for the Ear. Keyed by track name; the route re-keys
 * by id once the ids exist. */
export const ROLES = {
  kick: "drums", sub: "bass", lead: "lead", "clap+snare": "drums", hats: "drums",
  crash: "drums", riser: "fx", impact: "fx",
};

/** Measured on the drop window through the real graph (THE CHAINS): the
 * second take's lead −2 / clap+hat −5 / crash −9 left 2-20 kHz 8-16 dB
 * under the reference. */
export const FADERS = { kick: 0, sub: -3, lead: 4, "clap+snare": -2, hats: 9, crash: -3, riser: -1, impact: -3 };

/** The build's snare roll, velocity from → to. The second take ramped 72 →
 * 127; with the clap's saturator and room on the same track that roll sat
 * 4.9 dB OVER the kick and made the build louder than the drop (−10.7
 * against −14.1 LUFS on the graph), so it ramps 0.7× as high. */
export const ROLL = { from: 50, to: 89 };
/** The drop's clap velocity (the 909's level law is 0.28 + 0.72·v, so 118
 * against 110 is +0.5 dB; the clap's level is the fader's job). */
export const CLAP_VEL = 118;
/** The plain high-passes (one EQ each); the lead's, the clap's and the
 * hats' EQs live in their chains above. */
const HIGHPASS = { crash: 300, riser: RISER.hp_hz };

/** The 909's keys, named once. */
const K909 = { snare: 38, clap: 39, closedhat: 42, openhat: 46, crash: 49 };

/**
 * Where `target_lufs` goes: on the limiter when the rack's catalog declares
 * it there; else on the first other device that declares it (added to the
 * master before the limiter); else nowhere yet. Read from MIXER_CATALOG so
 * a plan can never send a parameter the store would refuse.
 */
export function loudnessTargetDoor() {
  if (MIXER_CATALOG.limiter?.params?.target_lufs) return { device: "limiter" };
  for (const [name, d] of Object.entries(MIXER_CATALOG)) {
    if (name !== "limiter" && d?.params?.target_lufs) return { device: name };
  }
  return null;
}

/* ───────────────────────────────────────────────────────────── the plan */

const ref = (name) => `$track:${name}`;
const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));

/**
 * The whole song as route bodies. Every body is complete except for track
 * ids, written as "$track:<name>" (resolveRefs fills them in). `slug` and
 * `by` are the runner's to add.
 */
export function bigroomPlan(opts = {}) {
  const seed = Number.isFinite(Number(opts.seed)) ? Math.floor(Number(opts.seed)) : 1;
  const key = parseKey(opts.key);
  const tempo = opts.tempo === undefined || opts.tempo === null ? 128
    : Math.min(LIMITS.bpm[1], Math.max(LIMITS.bpm[0], Number(opts.tempo) || 128));
  const sections = normStructure(opts.structure);
  const bars = sections[sections.length - 1].to;
  const rnd = prng(seed);
  const progression = pick(rnd, PROGRESSIONS);
  const hook = hookNotes(rnd, key.pc, progression);
  const release = sidechainReleaseMs(tempo);
  const tune = kickTune(key.pc);

  /* Notes per track, gathered per section, then emitted as clip + notes. */
  const T = TICKS_PER_BEAT;
  const notes = Object.fromEntries(Object.keys(ROLES).map((n) => [n, []]));
  const note = (track, bar, beat, tick, dur, pitch, vel) =>
    notes[track].push({ bar, beat, tick, dur_ticks: dur, pitch, vel: clampVel(vel) });

  /* The voices' `bigroom` presets, read from patches.json (the same door as
   * the kick's): nothing applies a preset for you, so the arranger sends
   * each one as the track's params. */
  const preset = (patch) => PATCHES[patch]?.presets?.bigroom?.params || {};
  const kickPreset = preset("hybrid_kick");
  const kickParams = { ...kickPreset, tune };
  const leadPreset = preset("bigroom_lead"), subPreset = preset("sub_bass"), kitPreset = preset("tr909");
  const leadParams = { ...LEAD, ...leadPreset };
  const subParams = { sub_mix: 0.2, ...subPreset, release: SUB.release, mid_layer: SUB.mid_layer, mid_cutoff: SUB.mid_cutoff };
  const hatsParams = { ...kitPreset, spread: HATS.spread };
  const clapParams = { ...kitPreset, ...CLAP };
  const subRoot = 24 + key.pc;                     // F1 for F: the sub octave
  const impactKey = 36 + key.pc;                   // impact key-tracks from 36
  const riserPitch = RISER.octave + key.pc;        // F4 for F

  /** The hook across a section, velocity scaled; `skipLast` leaves the
   * final beat empty — the beat of silence belongs to every track, so a
   * note is dropped if it starts there and clipped if it would sustain
   * into it. `rows` is the hook or its variant. */
  function lead(sec, rows, scale, skipLast = false) {
    const secEnd = (sec.to - sec.from + 1) * 4 * T;
    for (let b = sec.from; b <= sec.to; b++) {
      const hb = (b - sec.from) % 8;
      const barStart = (b - sec.from) * 4 * T;
      for (const n of rows) {
        if (n.bar !== hb) continue;
        const beat = Math.floor(n.slot / 4) + 1;
        const tick = (n.slot % 4) * (T / 4);
        const at = barStart + (beat - 1) * T + tick;
        let dur = Math.min(n.dur, secEnd - at);
        if (skipLast && b === sec.to) {
          if (beat === 4) continue;
          dur = Math.min(dur, 3 * T - (beat - 1) * T - tick);
        }
        if (dur < 1) continue;
        note("lead", b, beat, tick, dur, n.pitch, n.vel * scale);
      }
    }
  }
  /** Four on the floor across a section; `skipLast` leaves the final beat empty. */
  function kick(sec, vel, skipLast = false) {
    for (let b = sec.from; b <= sec.to; b++) {
      for (let beat = 1; beat <= 4; beat++) {
        if (skipLast && b === sec.to && beat === 4) continue;
        note("kick", b, beat, 0, 240, 36, vel);
      }
    }
  }
  /** Open hats on the off-beat eighths, the "and" of 2 and 4 accented
   * (HATS.accent / HATS.plain, scaled per section); `skipLast` for the beat
   * of silence. */
  function hats(sec, scale, skipLast = false) {
    for (let b = sec.from; b <= sec.to; b++) {
      for (let beat = 1; beat <= 4; beat++) {
        if (skipLast && b === sec.to && beat === 4) continue;
        note("hats", b, beat, T / 2, 240, K909.openhat, (beat % 2 === 0 ? HATS.accent : HATS.plain) * scale);
      }
    }
  }
  /** The drop's closed hats on the "e" and the "a" of every beat — the
   * quieter sixteenths between the open hats, the "a" a shade louder. */
  function closedHats(sec) {
    for (let b = sec.from; b <= sec.to; b++) {
      for (let beat = 1; beat <= 4; beat++) {
        note("hats", b, beat, T / 4, 120, K909.closedhat, HATS.closed_e);
        note("hats", b, beat, (3 * T) / 4, 120, K909.closedhat, HATS.closed_a);
      }
    }
  }
  /** The sub on the kick's rests, carrying the bar's chord root, held
   * SUB.note_ticks — to just before the next kick (see THE CHAINS). */
  function sub(sec, vel) {
    for (let b = sec.from; b <= sec.to; b++) {
      const rootOff = progression[(b - sec.from) % 4];
      const pitch = subRoot + rootOff;             // within [root, root+11]: F1..E2
      for (let beat = 1; beat <= 4; beat++) note("sub", b, beat, T / 2, SUB.note_ticks, pitch, vel);
    }
  }
  function claps(sec, vel) {
    for (let b = sec.from; b <= sec.to; b++) {
      note("clap+snare", b, 2, 0, 240, K909.clap, vel);
      note("clap+snare", b, 4, 0, 240, K909.clap, vel);
    }
  }
  /** The snare roll: eighths → sixteenths → thirty-seconds, ROLL.from →
   * ROLL.to, silent on the last beat. */
  function roll(sec) {
    const B = sec.bars;
    const rows = [];
    for (let b = sec.from; b <= sec.to; b++) {
      const i = b - sec.from;                      // 0-based bar within the build
      const grid = i < B / 2 ? T / 2 : i < (3 * B) / 4 ? T / 4 : T / 8;
      const lastBar = b === sec.to;
      for (let beat = 1; beat <= 4; beat++) {
        if (lastBar && beat === 4) continue;
        for (let tick = 0; tick < T; tick += grid) rows.push({ b, beat, tick });
      }
    }
    rows.forEach((r, i) => {
      const vel = ROLL.from + (ROLL.to - ROLL.from) * (i / Math.max(1, rows.length - 1));
      note("clap+snare", r.b, r.beat, r.tick, 120, K909.snare, vel);
    });
  }
  /** One riser note over the build's last 8 bars, ending a beat early. */
  function riser(sec) {
    const span = Math.min(8, sec.bars);
    const from = sec.to - span + 1;
    note("riser", from, 1, 0, span * 4 * T - T, riserPitch, 100);
  }

  for (const sec of sections) {
    switch (sec.type) {
      case "intro":
        kick(sec, 112); hats(sec, 0.75); lead(sec, hook.notes, 0.75);
        break;
      case "build":
        kick(sec, 118, true); hats(sec, 0.85, true); lead(sec, hook.notes, 0.9, true); roll(sec); riser(sec);
        break;
      case "drop":
        kick(sec, 127); sub(sec, 118); lead(sec, sec.n % 2 === 0 ? hook.variant : hook.notes, 1);
        claps(sec, CLAP_VEL); hats(sec, 1); closedHats(sec);
        note("crash", sec.from, 1, 0, 240, K909.crash, 118);
        note("impact", sec.from, 1, 0, 240, impactKey, 127);
        break;
      case "break":
        lead(sec, hook.notes, 0.92);
        break;
      case "outro":
        kick(sec, 112); sub(sec, 104); hats(sec, 0.75);
        break;
    }
  }

  /* ── the steps, in the order a person would take them ─────────────── */
  const steps = [];
  const tracks = [
    { name: "kick", instrument: "hybrid_kick", params: kickParams },
    { name: "sub", instrument: "sub_bass", params: subParams },
    { name: "lead", instrument: "bigroom_lead", params: leadParams },
    { name: "clap+snare", instrument: "tr909", params: clapParams },
    { name: "hats", instrument: "tr909", params: hatsParams },
    { name: "crash", instrument: "tr909" },
    { name: "riser", instrument: "riser", params: { cutoff_start: RISER.cutoff_start } },
    { name: "impact", instrument: "impact" },
  ];
  for (const t of tracks) {
    steps.push({ action: "add_track", name: t.name, instrument: t.instrument,
                 ...(t.params ? { params: t.params } : {}), with_clip: false });
  }

  /* Clips: one per section a track plays in, named for the section, so the
   * arrangement window shows the form and every clip is a draggable part. */
  let clipCount = 0, noteCount = 0;
  for (const t of tracks) {
    for (const sec of sections) {
      const rows = notes[t.name].filter((n) => n.bar >= sec.from && n.bar <= sec.to);
      if (!rows.length) continue;
      const clipName = `${sec.type} ${sec.n}`;
      steps.push({ action: "add_clip", track: ref(t.name), from_bar: sec.from, bars: sec.bars, name: clipName });
      steps.push({ action: "record_notes", track: ref(t.name), notes: rows });
      clipCount++; noteCount += rows.length;
    }
  }

  /* Inserts. The lead's EQ: high-pass, plus the break's low-pass sweep as
   * float-bar keys — held open at 20 kHz, dropped to 500 Hz on the break's
   * first bar, opened linearly to 20 kHz by the next section's first bar. */
  const breaks = sections.filter((s) => s.type === "break");
  const lpKeys = [{ t: 1, v: 20000, ease: "hold" }];
  for (const s of breaks) {
    lpKeys.push({ t: s.from, v: 500, ease: "linear" });
    lpKeys.push({ t: s.to + 1, v: 20000, ease: "hold" });
  }
  for (const [name, hz] of Object.entries(HIGHPASS)) {
    steps.push({ action: "insert_add", target: ref(name), type: "eq", params: { hp_on: true, hp_hz: hz } });
  }
  steps.push({ action: "insert_add", target: ref("hats"), type: "eq", params: { ...HATS_EQ } });
  const sidechain = { sidechain: ref("kick"), ...SIDECHAIN, release_ms: release };
  /* THE CHAINS, each in signal order (a chain's rows are its insert order).
   * lead: saturator → chorus → eq (+ the break's low-pass) → delay → reverb
   * → sidechain; sub: saturator → sidechain; clap: saturator → eq → room. */
  for (const [type, params] of Object.entries(LEAD_CHAIN)) {
    const p = { ...params };
    if (type === "eq" && breaks.length) Object.assign(p, { lp_on: true, lp_hz: { keys: lpKeys } });
    steps.push({ action: "insert_add", target: ref("lead"), type, params: p });
  }
  steps.push({ action: "insert_add", target: ref("lead"), type: "compressor", params: sidechain });
  for (const [type, params] of Object.entries(SUB_CHAIN)) {
    steps.push({ action: "insert_add", target: ref("sub"), type, params: { ...params } });
  }
  steps.push({ action: "insert_add", target: ref("sub"), type: "compressor", params: sidechain });
  for (const [type, params] of Object.entries(CLAP_CHAIN)) {
    steps.push({ action: "insert_add", target: ref("clap+snare"), type, params: { ...params } });
  }
  const door = loudnessTargetDoor();
  const limiter = { ceiling_db: MASTER.ceiling_db, release_ms: 80, lookahead_ms: 5 };
  if (door?.device === "limiter") limiter.target_lufs = MASTER.target_lufs;
  else if (door) {
    const spec = MIXER_CATALOG[door.device].params;
    const params = { target_lufs: MASTER.target_lufs };
    if (spec.ceiling_db) params.ceiling_db = MASTER.ceiling_db;
    steps.push({ action: "insert_add", target: "master", type: door.device, params });
  }
  steps.push({ action: "insert_add", target: "master", type: "limiter", params: limiter });
  /* The master strip's two settings, through the same door as a fader:
   * stereo ON (the rack renders each voice's own channels — a project the
   * arranger fills into is new or empty, so no cached bytes are at stake)
   * and the loudness target the bounce's second pass aims at. */
  steps.push({ action: "mixer_set", target: "master", stereo: true, target_lufs: MASTER.target_lufs });
  for (const [name, db] of Object.entries(FADERS)) {
    if (db) steps.push({ action: "mixer_set", target: ref(name), fader: db });
  }

  const hookRows = (rows) => rows.map((n) => ({ bar: n.bar + 1, slot: n.slot, dur: n.dur, pitch: n.pitch, vel: n.vel, role: n.role }));
  return {
    meta: {
      seed, key: key.name, mode: "minor", tempo, bars,
      seconds: Number((bars * 4 * 60 / tempo).toFixed(3)),
      structure: sections,
      progression: progression.map((o) => noteName((o + key.pc) % 12)),
      /* `riff` is the route's word for the melody it returns: the hook, bars 1..8 */
      riff: hookRows(hook.notes),
      hook: {
        shape: "2-4 note cell with an octave leap; call bars 1-4, response bars 5-8; notes on the 'and'; ends on the root. Original material — the shape is the reference, the melody is not.",
        cell_size: hook.cellSize, slots: hook.slots, leap: hook.leapUp ? "up" : "down", leap_at: hook.leapAt,
        response_pair: hook.responsePair, variant: hook.variantKind,
        notes: hookRows(hook.notes), variant_notes: hookRows(hook.variant),
      },
      sidechain: { ...SIDECHAIN, release_ms: release, release_beats: SIDECHAIN_RELEASE_BEATS },
      sidechain_release_ms: release,
      kick_preset: kickPreset,
      kick_tune: tune, kick_hz: Number(kickHz(tune).toFixed(2)),
      riser: { pitch: riserPitch, cutoff_start: RISER.cutoff_start, hp_hz: RISER.hp_hz },
      /* THE CHAINS: the presets the voices carry, the insert orders, and
       * the delay's time at this tempo (a dotted eighth, tempo-synced). */
      presets: { lead: leadPreset, sub: subPreset, kit: kitPreset },
      lead_params: leadParams, sub_params: subParams, hats_params: hatsParams, clap_params: clapParams,
      chains: {
        lead: [...Object.keys(LEAD_CHAIN), "compressor"], sub: [...Object.keys(SUB_CHAIN), "compressor"],
        "clap+snare": Object.keys(CLAP_CHAIN), hats: ["eq"], crash: ["eq"], riser: ["eq"], kick: [], impact: [],
      },
      delay: { sync: DELAY_SYNC, quarters: DELAY_QUARTERS, ms: delayMs(tempo) },
      /* The sub's release is the one knob two files disagreed about (the
       * preset said 200, this file sent 600). It is 500 in both now, and
       * the sweep it came out of rides along so a caller reading the plan
       * sees WHY rather than a bare number. */
      sub: {
        ...SUB,
        note_seconds: Number((SUB.note_ticks / T * 60 / tempo).toFixed(4)),
        release_to_kick_ms: Number(((T - SUB.note_ticks - T / 2) / T * 60000 / tempo).toFixed(2)),
        release_to_next_note_ms: Number(((T + T / 2 - (T / 2 + SUB.note_ticks)) / T * 60000 / tempo).toFixed(2)),
        release_sweep: SUB_RELEASE_SWEEP,
      },
      hats: { ...HATS, knobs_measured: HAT_KNOBS_MEASURED },
      /* target_lufs_sent: where the number went — always the master strip
       * (mixer_set, honoured by the bounce's loudness stage), and also on a
       * rack device when the catalog declares the parameter there. */
      master: { ...MASTER, stereo: true, target_lufs_sent: door ? `master+${door.device}` : "master" },
      faders: { ...FADERS },
      roles: { ...ROLES },
      clips: clipCount, notes: noteCount,
    },
    steps,
  };
}

/* Flats: these are minor keys, and F minor's VI is Db, not C#. */
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const noteName = (pc) => NAMES[((pc % 12) + 12) % 12];

/**
 * Replace every "$track:<name>" in a step with the id the store minted —
 * one level into `params` too, which is where a compressor's sidechain
 * lives. Throws on a name that has no id yet: a plan that references a
 * track before adding it is a planner bug, and it should say so.
 */
export function resolveRefs(step, ids) {
  const fix = (v) => {
    if (typeof v === "string" && v.startsWith("$track:")) {
      const name = v.slice(7);
      if (!ids[name]) throw new Error(`arranger: "${name}" is referenced before its track exists.`);
      return ids[name];
    }
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(step)) {
    if (k === "params" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, fix(pv)]));
    } else {
      out[k] = fix(v);
    }
  }
  return out;
}
