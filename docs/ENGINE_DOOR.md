# The engine door

**One way to the graphics card, and a record of everything that went through it.**

---

## The measurement this exists for

On 2026-09-02 the rig's output folder held **426 files written since the
previous noon. 424 of them had no ledger entry of any kind.**

```
gate/ 135   film/ 70   vace/ 40   previz/ 34   mv/ 31   ressweep/ 15   clips/ 85 …
```

They were not lost. They were rendered by scripts that POST straight to
ComfyUI's own port — a constant copied into nineteen files across two repos —
write into this app's output folder, and never open its ledger.

Two details sharpen it:

- **85 of them were in `clips/`**, the folder `/api/clips` reads with `readdir`.
  So the app **already listed them** and could say nothing whatsoever about
  them: no model, no prompt, no seed, no size, no elapsed time, no actor. The
  library was not missing the files. It was missing the **record**.
- **Two installs share one machine.** Both repos resolve to the same rig, the
  same output folder, the same app-data directory and — before this — the same
  engine port. A job posted at a port that answers can render happily into the
  other install's library, and the only symptom is an evening's work in a place
  nobody looks.

The honest answer to *"do we save all the metadata?"* was **"only for what does
not bypass us, and even then not much."** This subsystem makes the first half
impossible by construction and fixes the second half.

---

## What changed, in one paragraph

The engine is bound to loopback on a port the app picks **fresh at every start**
and does not publish. `server/engine/client.js` is the only file in the tree
that knows the number; the bypass census in `server/engine/ui_test.js` fails the
build if any other file names it, a ComfyUI route, or `config.comfy.port`.
Everything inside the app goes through `engine.dispatch()`. Everything outside
it goes through `POST /api/engine`. Both write the whole technical record to the
provenance ledger **before the GPU spends a millisecond**, and a ledger failure
costs the render — which is the one place in this application where that
inversion holds.

---

## Using it from a script

```bash
curl -sS http://127.0.0.1:4173/api/engine \
  -H 'content-type: application/json' \
  -H 'x-aiplay-actor: script:my_sweep' \
  -d '{"action":"prompt","graph":{...},"wait":true,"label":"arm 3 strength 0.30",
       "project":"measure-twice","shot":"s03","timeoutMs":1800000}'
```

`POST /api/engine/prompt` is honoured as an exact alias with the same body minus
`action`, so a one-graph script needs no envelope at all.

**Two things it will refuse.**

1. **A request it cannot attribute.** Send `x-aiplay-actor: script:<name>` (a
   harness) or `agent:<name>` (an MCP client). A browser is recognised by its
   `Origin` header and needs nothing. Nothing here will invent an actor for you:
   filing 245 renders under a name that means "the app did this on its own" is
   not a smaller lie than no record at all, it is a more convincing one.
2. **ComfyUI's ordinary Save.** That writes an editor document — nodes, links,
   positions, widget arrays — and `/prompt` cannot execute it. The one that
   works is **Save (API Format)** (enable Dev Mode in ComfyUI's settings if you
   cannot see it). The two files look equally like JSON and fail very
   differently; the door tells them apart and says which one you gave it.

**Answer shape.** `{ok, runId, promptId, status, error, elapsedSec, queuedSec,
runningSec, cached, outputs[], record, ledger}`. Each output carries `{file,
subfolder, kind, bytes, sha256, adoptedAs}` — `adoptedAs` is the name it was
filed under in the clip or picture library, or `null` when `adopt` was off.

**`timeoutMs` is measured from the moment the engine STARTS your job, never from
the moment you queued it.** Three numbers come back, because one cannot answer
both questions: `elapsedSec` is what you waited, `queuedSec` is what the engine
spent finishing somebody else's render first, and `runningSec` — elapsed minus
queued — is the only one that is about your render, and the only one the
deadline is checked against. A job still sitting in ComfyUI's `queue_pending`
when its deadline would have expired is **not** a timeout; a job that started
and then stopped producing a terminal status **is**, `timeoutMs` after it
started, and the error says so and names the queue it waited through.

That distinction is not theoretical. Run `mtm1al5b70067f` was posted while a
32-minute pass still held the engine, sat pending for most of the half hour,
then ran and wrote its files — and landed in the ledger as `status: "timeout"`,
`elapsedSec: 1800.456`, `queuedSec: 3.685`. The clock had been started at
queueing, and `queuedSec` measured to the prompt's first appearance in *either*
queue list rather than to the moment ComfyUI started it. The record said the
render failed; the files on disk said it had not. **The residual, stated rather
than implied:** a job that never starts at all is not bounded by this deadline.
What bounds it is the engine going away (the consecutive-poll-failure window)
or the queue losing it (the vanished-prompt window). What is left is the one
case where waiting is correct — a live engine with your job genuinely behind
another one — which is the thing the old rule got wrong.

**Useful fields.** `wait:false` returns as soon as the job is queued and the app
completes the record itself, even if you never come back — and for a render
longer than five minutes it is the only safe choice from Node, because
`fetch()`'s undici default abandons a response whose headers have not arrived in
300 s while the GPU keeps going. Poll `{"action":"run","runId":…}` until its
`result` is non-null, and `{"action":"status"}` in the meantime: each in-flight
row carries `state` (`queued` | `running`), `queuedSec` and `runningSec`, so a
caller can measure its own deadline from the start the same way the door does.
`adopt:false` leaves the output exactly where the graph put it — use it when the
script reads its own output back, because adoption MOVES the file. `pollMs`
keeps your own cadence (250 ms for a frame-by-frame feedback render, 3 s for a
half-hour pass). `dry_run:true` returns the record that would be written — model
files, steps, size, seed — and posts nothing.

**If the app is not running, the script now fails** with *"start AIPLAY Studio
first"*. That is correct, and it **is** the enforcement: a harness that cannot
find the app can no longer find the engine either.

---

## What is recorded

Two events per prompt, both on `asset: "engine/<runId>"`, both in the same hash
chain as everything else.

The **`delegate`**, written before the POST: the graph (hashed with sorted keys,
so key order cannot change the hash, and stored whole under that hash), the
resolved positive and negative prompt verbatim, every sampler's seed, steps,
cfg, sampler name, scheduler and denoise, the size, frame count, fps and
seconds, every model and LoRA **file** with its bytes and modification date,
every reference image with its SHA-256, the output prefixes, who asked, which
project and shot, and how exposed the engine was at the time.

The **`generate`**, written after the terminal poll: `promptId`, `status`
(`completed` | `error` | `rejected` | `timeout` | `vanished` | `cancelled`), the error, the
wall time, the queued time, the render's own time, whether ComfyUI served it
from its own cache (judged on the render's time, so a cache hit that waited
twenty minutes behind another job is still a cache hit), and
every file written with its bytes and SHA-256.

**A render that FAILED is recorded too.** Before this door existed, a failed
render left no trace of any kind.

**A cancel is addressed at one prompt, and `cancelled` is its own status.**
`engine.cancelRun({runId})` asks the engine to cancel that run's own prompt —
`POST /api/jobs/<promptId>/cancel`, which dequeues a pending prompt and
interrupts a running one *under the queue mutex*, so a cancel cannot land on the
next prompt if ours finishes in the gap; on an engine without that route it
falls back to `{delete:[id]}`, which touches the pending list only, plus an
`interrupt()` **only** when a fresh read says the engine is running this very
prompt. It never calls `interrupt()` or `{clear:true}` on the engine as a whole,
and a run with no prompt id touches the engine not at all. This is not
housekeeping: measured twice on 2026-09-05, one press of the app's Stop button
destroyed a chat turn queued behind a song (runs `mto5iphvf293e7` and
`mto5ngyxf4893c`) — no output file, absent from both `/history` and `/queue`,
and recorded `vanished`, which is this door's word for *a ComfyUI restart
discarded it*. Nothing had restarted; the app had cleared the queue. So the
ledger now separates the three: `vanished` still means the engine lost it,
`error` means the render failed, and `cancelled` means somebody stopped this
run on purpose — and every other run in the queue keeps its place and its own
status.

Read it back with `action:"activity"` (newest first, filterable by actor, via,
project, status and date), `action:"run"` (one run's whole record, plus the
graph itself when you ask), or the Engine panel, which shows the same rows.

### Weight hashing is an explicit choice

Every render records `{file, bytes, mtimeMs}` for every model input — free, and
enough to notice a swapped file. The full SHA-256 is the only thing that
*proves* which weights rendered a clip, and it costs about ten seconds per file
the first time each one is seen (a 21 GB transformer on NVMe), cached against
that file's path, size and date. **Off by default**, with that sentence next to
the toggle. Reference images and outputs are hashed always.

### The graph store is never pruned

`<appData>/provenance/graphs/sha256-<hex>.json`, content-addressed: a hundred
arms of one sweep share one file, and a re-run costs zero extra bytes. No
setting may be added to delete it — a ledger line naming a hash nothing can
resolve is worse than no record, because it looks like evidence. The Engine
panel reports the directory's size instead and lets a person decide with their
own hands.

---

## The port

**Ephemeral, chosen by the app at every spawn** — including the crash-restart
path and a memory-tier change. Three reasons, in order of how much they matter:

1. A number that is different every run **cannot be copied into a script**.
   Moving the constant from 8266 to 47821 would only change which constant gets
   copied.
2. Two Studios on one machine cannot collide. The adoption guard stops being the
   thing you read *after* losing an evening and becomes a thing that never
   fires. It stays anyway, unchanged, including the child-alive re-check —
   something can still take the port between our close and ComfyUI's bind, and
   that window is what the guard was written for.
3. It costs one listen-and-close, about a millisecond.

**`AIPLAY_COMFY_PORT` still pins it**, and is honoured *loudly*: the log says
what pinning costs, a `choice` event goes on `asset:"engine"`, and the Engine
panel shows a strip. An install that pinned the port did so because of a real
collision and taking it away would break them; silently honouring it would leave
the hole this subsystem exists to close.

**The Reveal control** on the Engine panel (and `engine_reveal_port` for an
agent) hands the number back and appends a dated `choice` event saying so. After
that the ledger can honestly say *"at 02:14 the port was revealed; renders after
that may have bypassed"* — which is the whole difference between an invisible
bypass and a visible one. `/api/provenance?asset=engine` is then the complete
history of how exposed this install has been.

`status` and `identity` return the number **only** when it is pinned or
revealed, because only then is it already discoverable. Hiding a number
`netstat` prints would help nobody, and pretending otherwise would be the
dishonest half.

---

## What this does not defend against, stated rather than implied

ComfyUI ships **no authentication of any kind**. No token, no password, no
per-request key, nothing to configure. `--listen <address>` is the whole of its
access control, and it controls which interface it binds — not who may call it.

- Binding `127.0.0.1` means **nothing off this machine can reach it**. That is
  real, and it is unchanged.
- **On this machine, anything can.** `Get-NetTCPConnection` finds the port in one
  command and a `curl` to it renders. An ephemeral port does not change that.
  What it changes is that nothing can find it by **guessing** — and guessing is
  exactly what a second copy of this app, a stale script with a number baked in,
  or a person following an old note actually does.
- So this door is a boundary against **accident, and against our own code
  drifting**, not against a determined local process. The adversary model for a
  single-user desktop tool is *me, at 2 a.m., with a script from the other
  repo*, and against that adversary an unpublished port plus a build-failing
  bypass census is decisive. **That residual is acceptable, and it is written
  down here so the decision is on the record rather than implied.**

If enforcement were ever wanted instead of obscurity, the two real options are a
token-checking reverse proxy in front of the engine (~80 lines, which on one
machine just moves the obscurity one layer down, since the app's own client must
carry the token in a file anything can read) or an OS-level rule scoped to a
process (Windows Firewall does not filter loopback). Neither is worth it today.
Named so nobody has to rediscover that.

**One rule does not rely on the door alone.** Sexual content involving minors
is refused by `dispatch()` before anything is recorded or sent, and ComfyUI
also carries Studio's own node, `server/comfy_nodes/aiplay_safety_gate.py`.
That node sends every graph posted to the engine, through any port, back to the
Studio's check. In a ComfyUI started by hand, without the Studio, the node
does nothing. It loads even when custom node packs are switched off, and
`reveal` refuses to hand out the port unless the node reports it is armed
(`GET /aiplay/safety_status`). See [SAFETY.md](SAFETY.md).

---

## Known gaps

- **`server/mesh/` — a SECOND DOOR, on purpose, and it is not a gap.** Listed
  here because a reader who has learned "one way to the graphics card" must be
  able to find the exception rather than discover it. TripoSG is a diffusers
  pipeline that needs a modern diffusers, and this app's interpreters are
  pinned (`server/config.js`: torch 2.13.0+cu130 in the engine's venv, because
  the music model's fused int8 kernels exist only on that build; torch
  2.5.1+cu121 with diffusers 0.7.0.dev0 in the system python demucs lives in).
  `pip install diffusers` into either of those does not fail — it succeeds, and
  the next song render dies hours later somewhere that says nothing whatsoever
  about a mesh. So the mesh stack gets its **own venv**, reached as a
  subprocess and never imported. The boundary is a version number, not a
  licence: TripoSG and UniRig are MIT for code *and* weights, which is why they
  were chosen over an alternative whose terms exclude the European Union.

  What it does **not** get to skip: it writes the **same `delegate` /
  `generate` pair** this door writes, in the same order, with the same actor
  discipline — and the delegate append is **awaited with no `.catch()`**, so a
  ledger failure costs the run. Every record carries a `door` field naming
  itself a second door and giving this reason, so a ledger row that did not
  come through here can be told apart from somebody bypassing the record again.
  It never speaks to ComfyUI, so it names no port and needs no census
  exemption.

  Its own residual, stated rather than implied: the two catalogue rows
  (`meshFromImage`, `meshRig`) carry **placeholder byte counts and hashes**
  until the install strand reports, `server/mesh/catalogue_test.js` fails while
  they do, and `server/mesh/mesh_cli.py` has not been executed end to end on
  this machine — every number the record carries is measured at run time rather
  than asserted by that file.

- **`server/reactive.js` — no longer a second engine.** It used to be a
  client for a user-installed ComfyUI on port 8288 with GPL-3.0 node packs,
  writing zero provenance, and was exempted by name in the census. Since
  2026-09-18 it is a recipe over the Studio's own compositor: it talks to
  `/api/vfx` and `/api/image` by loopback and to no engine directly, so the
  render carries the compositor's provenance and the exemption is moot (it
  still must never name `config.comfy.*`, which keeps the census honest if
  someone puts an engine back).
- **Two gaps that used to be listed here are closed**, and their entries are
  gone rather than edited — the census is written so that closing a bypass
  *forces* its line to be deleted, and leaving a dead exemption behind is how
  the next person reads it as permission. `server/config.js`'s
  `port: Number(env || 8266)` is now `pinnedPort: … : null`, null unless
  somebody really pinned it, so a pin can be told from a default and no reader
  has to go behind config's back to the raw variable; and `host` is deleted,
  because the thing that passes `--listen` and the thing that builds `http://…`
  are now one constant in one file. And `server/control/control.js`'s private
  engine client — whose own header called itself "the leftover" — is DELETED
  rather than rerouted: it briefly became a thin shim over `dispatch()`, and
  the wiring pass then removed the shim and its one caller too. That directory
  now builds graphs and measures clips and reaches nothing.
- **The control directory's three lines of debt are paid, and the census's debt
  list is now EMPTY with `DEBT_BUDGET` at 0** — so
  `AIPLAY_ENGINE_GATE_STRICT=1` passes as well as the default run.
  `POSE_GATE.engine = "127.0.0.1:8266"` was a *record* of where the 2026-09-03
  gate ran rather than a call, and it is `engine_run: null` now with the honest
  note that the gate predates this door and has no runId to give. The two
  `/object_info` probes in `pose_test.js` and `vace_test.js` took the fix this
  section proposed: `POST {action:"object_info"}` with an actor header,
  through `server/control/live_test_lib.js`. They had been silently skipping
  since the door landed — and they now RUN: measured 2026-09-03, pose_test went
  54 → 57 assertions and vace_test 45 → 48, the three extra in each being the
  live checks coming back to life. Everything the control path renders now goes
  through `dispatch()` from `server/mv/control.js`; the private client at the
  end of `server/control/control.js` is deleted, along with `extractPose`, the
  only caller that made it necessary.

## The base repo's experiment scripts

`C:\temp\AIPLAYStudio` (the base repo, not this fork) drives three overnight
harnesses at the engine directly. They are the origin of 245 of the 424
unrecorded files. **Do not edit them from this repo** — the change is written
here so it can be applied there deliberately. It has since been applied and
verified live against this fork's app on 4173; the notes below were corrected
against what that verification actually found, not just what was planned.

`scripts/gate_lib.mjs` carries the shared half. `gate_run.mjs` and
`vace_run.mjs` genuinely need only their `BASE` line changed, because both
already import `gate_lib.mjs`'s dispatcher and identity check. `film_run.mjs`
is NOT a one-line change: it never shared `gate_lib.mjs` — it POSTed straight
to ComfyUI's own `/prompt` and `/history` with its own inline `post()` /
`wait()` helpers — so migrating it means replacing that pair with a `door()`
function of its own (the same shape `ltx_smoke.mjs` and `h3_smoke.mjs` in this
repo already use) and rewriting its one dispatch call site.

```js
// gate_lib.mjs — the dispatcher posts to the app instead of to the engine
export function makeDispatcher(appBase, { actor, deadlineMs, adopt = false, project = null } = {})
//   POST `${appBase}/api/engine`
//   body    { action: "prompt", graph: job.graph, wait: FALSE, adopt, project,
//             label: job.label, timeoutMs: deadlineMs }
//   headers { "x-aiplay-actor": actor }        // e.g. "script:gate_run"
//   then    POST { action: "run", runId } every few seconds until `result`,
//           with { action: "status" } alongside it until the run's own row
//           says it STARTED (state/queuedSec), which is where the caller's
//           deadline begins — the same instant the door's own does.
//   RETURN SHAPE UNCHANGED: { ...job, ok, secs, why }
//     ok   <- status === "completed"
//     secs <- elapsedSec
//     why  <- error
//
// ⚠ `wait: true` IS WRONG HERE AND WAS THE FIRST DISPATCH'S BUG. It holds one
// HTTP response open for the whole render, and Node's fetch (undici) abandons a
// response whose headers have not arrived within 300 s — so a 32-minute pass
// reported "start AIPLAY Studio first" at 306 s while the GPU carried on and
// the app recorded the run correctly. Nothing was wrong except the harness's
// own connection. Long renders poll; they do not hold.

export async function engineIdentity(appBase)   // POST { action: "identity" }
//   MAPPED, NOT UNCHANGED. The door's actual "identity" response, confirmed
//   live against this fork's app, is:
//     { version, mainPy, inputDirectory, outputDirectory,
//       matchesThisStudio, mode, port, problems[] }
//   — no `up`, no `argv`, and the two directory fields spelled out rather
//   than abbreviated. gate_lib.mjs maps this onto the shape its two callers
//   already read ({ up, version, argv, inputDir, outputDir, port, problems }),
//   so neither needs to change beyond BASE: `up` is inferred from whether the
//   POST itself succeeded, `argv` can only be approximated as `[mainPy]` (the
//   door does not expose the engine's full launch argv the way /system_stats
//   used to), and `matchesThisStudio` — the door's own pass/fail verdict — is
//   carried through as an extra field so a caller can name it rather than
//   guessing why `problems` is non-empty. `port` is null unless the engine is
//   pinned or revealed, and `mode` (e.g. "ephemeral") says why — which is the
//   honest answer, and gate_lib only ever printed it.
```

⚠ **`adopt` defaults to `false` here, not `true`.** All three harnesses find
their own output by reading ComfyUI's raw output tree by convention, not
through the app: `gate_score.py` globs `<root>/<arm>/*.mp4` straight out of
ComfyUI's own output folder (`GATE = ".../output/gate"`), and `vace_run.mjs`
and `film_run.mjs` each run their own `readdir()` resume check against that
same tree to decide whether an arm is already rendered. `adopt: true` — this
door's own default everywhere else in this repo — would MOVE a finished clip
into the app's clip library the instant it lands, and none of those checks
would error: they would just find nothing, silently. `gate_score.py` would
report "no .mp4 in `<arm_dir>`" against a run that actually rendered fine, and
`vace_run.mjs`'s "skip if already rendered" would re-render every arm on every
invocation, forever, defeating the resumable design its own file header
documents. So for these three callers, and only for these three, `adopt`
stays off.

```js
// gate_run.mjs / vace_run.mjs — genuinely one line each
const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
```

`film_run.mjs` needs the same `BASE` line plus its own `door()`, replacing
`post()` / `wait()`, per above.

The bounded poll loop, the vanished-prompt counter and the failure taxonomy
**stay in `gate_lib.mjs` as the record of where they came from** — they were
hardened after a measured incident, and `server/engine/client.js` ports them
verbatim (same six constants, with the two windows restated as durations so a
fast caller cannot weaken them). The runners keep their own deadlines:
`gate_run` passes 20 minutes, VACE more.

**`--preflight`'s arity and input-name cross-check breaks too, and needs its
own small fix.** `gate_run.mjs`'s and `vace_run.mjs`'s `--preflight` blocks
each did a raw `GET ${BASE}/object_info` against ComfyUI directly, to prove
their hand-written node-arity tables (and, in `vace_run.mjs`, `WanVaceToVideo`'s
declared input schema) against the live server. Once `BASE` is this app rather
than ComfyUI, that path is dead — confirmed live, 404 — and degrades silently
rather than crashing, because both scripts already wrap the call in their own
try/catch and print "arity table could not check: …". The fix is the same
shape as `engineIdentity`: one more `gate_lib.mjs` export,
`engineObjectInfo(appBase) => POST {action:"object_info"}` (no `node` filter),
returning the response's `nodes` dict — byte-identical to what ComfyUI's own
`/object_info` always returned. Both preflight blocks call this instead of
`fetch`, with no other change: same variable name (`info`), same downstream
logic. Verified live: `vace_run.mjs --preflight` now prints `arity table
matches /object_info` and `strength server says min 0 max 1000 step 0.01
default 1 ok — matches nodes_wan.py:301`, the latter read straight off
`info.WanVaceToVideo.input.required.strength`.

Verify with a single cheap LTX arm: it should appear in **this fork's** ledger as
`script:gate_run`, and in the clip library.
