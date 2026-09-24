# Ported from aiplay.live

Every file in this directory that carries a website filename is a **hand port**,
not a copy and not a compiler output. TypeScript was stripped by hand because a
build step would poison Studio's zero-toolchain, one-npm-dependency promise
(`MV_FORK_PLAN.md` §61). Variable names, branch order, rounding, clamping and
tie-breaks are deliberately identical to the source, so `diff`-ing a port
against its `.ts` stays a line-by-line read.

**Source tree:** a local snapshot of the live site's music-video helpers.
taken 2026-08-12). All mtimes below are from that snapshot, local time
((local timezone), +0200), recorded 2026-08-24.

| Ported file | Source file | Source mtime | Bytes | SHA-256 of source |
|---|---|---|---|---|
| `lyricLines.js` | `lyricLines.ts` | 2026-06-04 09:34:38 +0200 | 3146 | `6d59796a5ca4b53cc8ef58e67bc2ed52ac7955bdd93ced667d2b6f9b926bd5e1` |
| `segmentation.js` | `segmentation.ts` | 2026-06-04 08:21:49 +0200 | 16954 | `3ea3a72f2aa374d0191c15e8869b5c317296281d8e5dddfa70ba806052fc3745` |
| `clipDuration.js` | `clipDuration.ts` | 2026-06-15 05:16:53 +0200 | 1591 | `a1b956b14b564c389b38974c5f97e7ce0cc1b9c275ff909afec0cbfbfadf22db` |
| `mvStages.js` | `mvStages.ts` | 2026-06-04 09:21:44 +0200 | 1687 | `5987720adf15ffa8422c07839cc7b335f427d869f5133e7b2eebfe404c6915be` |

The hash column is what makes this file worth keeping. An mtime survives a
`cp -p` and a re-clone; it does not tell you whether the website has edited the
source since. Re-run `sha256sum` against the snapshot before trusting a port
that has not been re-diffed.

`store.js` and `routes.js` are Studio-native and have no website ancestor.

## Deliberate departures

The ports are behaviour-identical. Three things could not be, and each is
flagged in the file itself as well as here:

- **Types are gone.** `as const` tuples became plain arrays, `Record<K,V>` became
  a plain object, and the three TS *type predicates* (`n is ClipDurationStep`,
  `v is MvStage`) became plain boolean returns. Their runtime bodies were
  already exactly the membership tests they still are. The exhaustiveness the
  compiler used to enforce — every `MV_STAGES` entry having a `MV_STAGE_LABELS`
  label — is now on the reader. JSDoc `@param`/`@returns` carries whatever the
  annotation used to say.

- **`clipDuration.js` gained two exports and one import.** `CLIP_DURATION_STEPS`,
  `recommendedClipSeconds` and `isClipDurationStep` are untouched, but
  `[5, 6, 8, 10, 12, 15]` is *Seedance's* per-second billing ladder and five of
  those six are illegal frame counts on MiniMax H3. `localClipSteps(engine)` and
  `recommendedLocalClipSeconds(startMs, endMs, engine)` re-derive the ladder per
  engine by probing `alignFrames()` in `../workflow.js` — the local rule is read
  from the engine, never restated, so it cannot drift. This makes the module
  server-only; the website's version was importable from client code too.

- **`segmentation.js` keeps the website's defaults; Studio passes its own
  longest scene, then closes the holes a shorter one opens.** `maxClipSec: 15`
  is Seedance's audio limit and runs past anything the H3 lab measured, so
  `routes.js` `segment()` sends the brief's default (`sizes.js sceneCutFor`:
  8 s at full size, 5 s at the smaller sizes and High, 15 s for an LTX project)
  unless the caller sends a number, from 1 to 15. A shorter cap makes two of the
  port's rare cases common, and each left song with no scene (black in the
  export): a line longer than the cap lost its tail, and a breath between two
  windows fell between them. `cutfill.js closeCutHoles` runs on every cut and
  fixes both (a long line is split into back-to-back scenes, a breath is held
  through within the cap). The port itself is unchanged, and `resnapSegment`
  still caps a hand-retimed scene at 15 s.

- **`mvStages.js` stayed pure.** The website reads the stage from
  `creator_projects.metadata.mvStage` (jsonb); here the same string lands in
  `<outputDir>/mv/<slug>/project.json`. `stageOf()` does not care which, which is
  why it ported with no changes at all.

## Verified by execution

A scratch harness imported both modules and exercised them — **159 assertions,
0 failures** (2026-08-24). What it pinned:

- `CLIP_DURATION_STEPS === [5, 6, 8, 10, 12, 15]`, and every one of the six
  round-trips through `isClipDurationStep`.
- `recommendedClipSeconds` swept at 1 ms over 0.001–20.000 s: it always returns
  a member of the ladder and never returns a step shorter than the segment
  (outside the documented 50 ms tolerance, and below the 15 s cap). It rounds
  **UP**. A clip shorter than its slot leaves black at the cut.
- The 13 stage ids and their 13 labels, in order; `stageIndex`, `isStage`,
  `nextStage` (clamping at `complete`) and `stageOf` across null / non-object /
  unknown-string inputs.
- Every value `localClipSteps()` returns survives `alignFrames()` unchanged —
  i.e. the engine does not silently lengthen it — for both engines, at 24 fps and
  again at 30 fps.

Measured ladders at 24 fps:

| Seedance step | H3 (`n mod 17 == 5`) | H3 frames | LTX (`fps*s + 1`) | LTX frames |
|---|---|---|---|---|
| 5 s | 5.166667 s | 124 | 5 s | 121 |
| 6 s | 6.583333 s | 158 | 6 s | 145 |
| 8 s | 8.000000 s | 192 | 8 s | 193 |
| 10 s | 10.125000 s | 243 | 10 s | 241 |
| 12 s | 12.250000 s | 294 | 12 s | 289 |
| 15 s | 15.083333 s | 362 | 15 s | 361 |

Only **8 s** of the six is legal on H3 as written. The other five are rounded up
inside `align_frame_count` with no error and no log line — a "6 second" clip
renders as 6.583 s. LTX's column being identical to Seedance's is a real result
rather than a copy-paste: its quantum is one frame, so every whole second is
already legal.
