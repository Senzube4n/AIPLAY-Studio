# COLLAB — sharing a project, and lending a card

⚠ **Part of this is built. This banner says which part, and it is the only place
in the document that is kept up to date** — everything below was written as a
design and still reads as one.

**Updated, 2026-09-24** — the identity, the friend list, the courier, the two
units and the lending loop, with a screen, two doors and twenty-four tools:

| | |
|---|---|
| `server/collab/identity.js` | two keypairs made on first sight of the screen, a 128-bit fingerprint over both of them, twelve words, the one-line key card |
| `server/collab/roster.js` | friends, their role, their minutes; adding is not trusting, and only a human marks anybody verified |
| `server/collab/seal.js` | one bundle sealed to one named friend and signed over the envelope, verified before it is decrypted |
| `server/collab/packet.js` | the two units — a whole project for a collaborator, one finished scene for somebody lending their card |
| `server/collab/resources.js` | what a Studio says it can do: the card, the memory, the catalogue ids that are ready — and never a path, a library or anything made here |
| `server/collab/credit.js` | who did what, folded out of the hash-chained ledger rather than out of the document — including the fifth actor class, `peer:<fp>:<their actor>` |
| `server/collab/order.js` | the frozen four-word vocabulary and the return's shape check, in one file so they cannot drift |
| `server/collab/free.js` | whether this machine is free to take somebody else's render — and it asks the ENGINE, because most work here never enters this app's queues |
| `server/collab/orderbook.js` | what I sent and what landed here, one atomic file each; the row is the guard against rendering one order twice |
| `server/collab/errand.js` | an order becomes a one-scene project, with the friend's prompt frozen so this machine's style bible cannot reach it |
| `server/collab/quarantine.js` | a returned take, measured here, held in a room until somebody presses Adopt |
| `server/collab/inbox.js` | reading the folder. It opens nothing |
| `server/collab/lending.js` | lending for a person with no strong card: the renderer's own frame count for a return, the speed-up file a lender lacks, the minutes a day read at accept, and filing a take onto a scene never rendered here |
| `server/index.js` `/api/collab` | the one door, same-origin gated, the role checked where the bundle is written |
| `server/index.js` `/api/collab-take/` | read-only: plays a quarantined take by its own name, so it can be watched before it is kept |
| `server/mcp-collab.js` | twenty-four tools, including `collab_accept` (needs `seen: true`; `anyway` walks past a busy card or the friend's minutes, never anything else) and `collab_adopt` (`anyway` keeps a take that failed its checks); the in-app chat asks before every write (`server/chat/router.js`, "writes") and is never shown `anyway` on either (`CHAT_WITHHELD_ARGS`) |
| the Collab screen | `web/index.html` / `web/app.js`, reached from the rail |
| `server/collab/collab_test.js` | pins in the hook, on the CPU, no engine and no network — section 7 evaluates the door's own text |
| `server/collab/lending_test.js` | the lending numbers pinned where they are computed: frame grid, filing, watching, lip-sync, minutes, speed-up files |

**The lending loop is built.** An order carries four words — the scene, the
seed, the steps and the engine mode — beside the finished prompt and the pictures
it names, and nothing else: no graph, no tool name, no model, no path. Accepting
one turns it into a one-scene project here with a plan that is **proposed**, and
nothing renders until a person approves it. The finished take is sealed home,
measured on arrival against the order it answers, and held in quarantine until
somebody presses Adopt — which files it as a take nobody has picked, carrying the
lender's own model and licence, under the actor `peer:<fp>:<their own actor>`.
The credit rollup has read that shape since the day it was written; this is the
writer it was waiting for.

**Updated, 2026-09-24 — lending works for a person with no strong card.**
A borrower with no GPU renders nothing at home, so every scene of theirs is one
"never rendered here", and the loop had five places that assumed otherwise.
Each is now fixed where the renderer's own function answers it:

- **A kept take is filed onto its scene** even when no clip row exists yet
  (rows were made only by a first render); it is still nobody's pick. The
  message no longer says such a scene "no longer exists".
- **The return check centres on the engine's own frame count** — H3 rounds a
  clip up to n mod 17 == 5 (a 6 s scene renders 158 frames, not 144), LTX to
  8k+1 — computed by `alignFrames` on the errand the lender will actually run,
  ± 4 frames of encoder slack. Order rows written before this accept either
  engine's grid.
- **A take that failed its checks can be watched and kept anyway** from the
  screen, after playing it and answering a question; the ledger says the checks
  did not pass.
- **Lip-sync does not travel, and it is said.** A singing board or "Song under
  the clip: always" is lent and rendered silent (the song never leaves); the
  order's own sentence says so at preview and on the lender's card, and the
  returned take's notes repeat it. Nothing is refused for it.
- **Minutes a day are read at accept**, against what the card has rendered for
  that friend today (timed on the art queue's own clock, so waiting behind
  other jobs is not charged) and promised (the plan's estimate; LTX scenes are
  priced too, and a scene with no estimate makes the total "at least"). Past
  it, and on a busy card, the screen asks "Accept anyway?" listing every
  reason; a paused queue or an unreadable engine is never overridable. Both
  lending roles start at 60 minutes when given; the Friends row shows what was
  used today (`collab_roster` `usedToday`).
- **The lender is told when the order's step count overruns the speed-up file
  their PC loads** (an 8-step order on a PC with only the 4-step files) before
  they say yes — by plancost's `trapBand`, the rule the Plan card uses — with
  the matching file named from the engine's own table and the Models screen's
  catalogue (which offers no 8-step file). The borrower's returned take is
  noted by the same rule, with where to order the matching count.
- The plan an accept proposes is the **Plan card in Music video**, on the new
  "Order … from <name>" project — there is no "Plan screen" — and Collab's
  **Open its plan in Music video** goes there. The screen's name is read off the
  rail on the page, and from one constant pinned to the rail on the server
  (`lending.js` `WORKFLOW_SCREEN`). The lender's role reads "lending
  friend: we render single scenes for each other" (stored value unchanged).

**Not built** — a project-bundle IMPORTER (an order carries its own scene, so
nothing here needs to swallow somebody else's whole document), standing consent,
and the socket. Those are still design. What changed the shape of the build is
worth recording: no packet in this repo moves a byte of picture data — every one
of them carries `{name, sha256, bytes}` where `bytes` is a COUNT — so an order
that was only a pointer would have pointed at nothing on the far side.
The manual lending routes can prepare, accept, render and return a scene. A real
two-PC render round-trip still needs acceptance testing; CPU route tests do not
prove that a friend's installed engine completes the job.

**Episode planning and order history are built.** Local plans support scene
owners, stages, dependencies, review notes and allocation across peers. The
planner reads outgoing order records by project and scene, displays every
request (including older requests), and offers separate actions for scene
metadata, a render request and reviewing returned takes. `collab_plan` exposes
the same read-only `delivery` projection through MCP. Reads do not change plan
revisions, assignments, selections or permissions. Prepared means a local sealed
file exists, not acknowledged delivery. Expiry limits acceptance, not the life
of a render already accepted. Return states are historical order records; a
take may since have been adopted or discarded. Resource cards remain snapshots,
and remote availability and live progress remain unknown. A failed order-book
read is an error, never an empty history. Refresh the plan to read newer records.

It answers one question the owner asked on 2026-09-20 — *could three friends make
an episode together, and could one of them borrow the others' idle cards?* — and
two they added while it was being written: *the group should see what resources
each person has*, and *credit should record who did what, whose agent and whose
user*.

It was produced by six independent designs judged on safety, feasibility and
honesty, written up from the winner, then extended by four more designs for the
two additions. Every number marked *measured* was produced on the author's own
machine while writing; every claim about the code carries the file and line it
came from. The questions near the end were put to the owner on 2026-09-20 and answered;
their answers are recorded beneath them and override anything above that
contradicts them.

Read it in this order: the five-sentence answer, then **what we should not
build**, then the open questions. The middle is mechanism and can wait.

---

## The design

*Written 2026-09-20 against `C:/temp/AIPLAYStudio-main` @ `main` and the rig at `D:/AI/aiplay-studio-bench`. Every number below marked "measured today" was produced on this machine in the course of writing this, node v22.15.0 / win32.*

---

## THE ANSWER IN FIVE SENTENCES

Build **a sealed, signed bundle and a four-word order vocabulary**, and ship the courier as a file before you ship it as a socket. Phase one: two keypairs per Studio, a friend list pinned at 128 bits and checked out loud, a project that travels as one `.aiplay` file sealed to a named friend, and a *render order* that names nothing but `{segmentId, seed, steps, mode}` — which arrives on your friend's machine as a `proposed` plan on the Plan screen they already have, is approved by a human hand, executes through the plan runner that already exists, and comes back as a take in quarantine that nobody auto-picks. Phase two swaps the courier for a TLS 1.3 socket over LAN or a tunnel the user chose, with the same format, the same signatures and the same refusals, so it is a transport change and not a redesign. Phase three is standing consent and a real farm evening, and it may not start until somebody has measured whether two cards render the same H3 clip — which nobody has, for any video model, ever. The order never carries a graph, the receiver names every file it writes, and a borrowed clip writes a `generate` event carrying the *lender's* model so the licence travels with the pixels.

---

## PHASE ONE — the sealed bundle

### 1. The ten decisions, each in one sentence

Where the six designs disagreed, this is the call and why.

| # | Decision | Why |
|---|---|---|
| D1 | **File courier first, socket second.** | The scenario's friends are AFK, which is a human condition and not a network one; a bundle waiting in an inbox needs zero networking code and the socket is a swap of courier on a format that already shipped. |
| D2 | **Bundles are sealed, not merely signed.** | A judge correctly killed a plaintext link shipped under the word "securely"; I measured sealing 30 MB with X25519 + AES-256-GCM at **33.7 ms (891 MiB/s), 0.0385 ms per ECDH, zero new dependencies** — at that price there is no tradeoff to weigh. |
| D3 | **The pinned fingerprint is 16 bytes (32 hex / 12 words), never 8 hex.** | Measured today: keypair + sha256 runs **0.1866 ms, 5,358 tries/sec single-threaded**, so a targeted 32-bit fingerprint preimage is **222.7 core-hours** — an afternoon on rented cores — while 2^64 is 9.6 × 10¹¹ core-hours and 2^128 is not a number. |
| D4 | **The key at rest is protected by an ACL, and `chmod` is never mentioned.** | Measured today: `fs.chmodSync(f, 0o600)` on win32 leaves node reporting mode `666` and `icacls` showing five ACEs including `SENZUBEAN\CodexSandboxUsers:(I)(M)`; after `icacls /inheritance:r /grant:r "%USERNAME%:F"` the ACL is exactly one entry, `chesy:(F)` — and node still says `666`, which is the proof that the mode bit is not a signal here. |
| D5 | **`peer:<fp>` becomes a fifth actor label; signatures stay detached and `append()` is not touched.** | A label is not a capability claim — `agent:` and `script:` are equally unverifiable today and the file says so at `provenance.js:22-29` — whereas embedding a `sig` key would put a signer inside the one serialised write path in the module. |
| D6 | **Parallelism is N independent plans on N machines, not one local runner walking remote items.** | `planrun.js:207` finds *one* `approved` item and blocks on `await impl.run(args)`; a "distribute" checkbox on that screen delivers serial offloading, which is slower than rendering it yourself. |
| D7 | **Returned clips land in quarantine and are adopted by a human, and adoption writes a `generate` event.** | Verified today: `import_clip` (`server/mv/routes.js:1087-1139`) pushes a take with `seed: null, imported: true`, sets `engine = "import"` and writes only a `noteRun` — **no provenance event at all**, so routing borrowed renders through it would launder the lender's model and its licence off the file. |
| D8 | **Parity gets three states — pass, fail, and UNMEASURED — and no number is shown outside its domain.** | Settled today: `D:/AI/aiplay-studio-bench/results/exactness.json` **does exist** (1,655 B, six cases) but every row's `file` is a `.flac` and it has an `ar_s` column — it is MiniMax Music 3, so the 19.02 % `--disable-smart-memory` figure is a *music* result and putting it on a video parity screen would teach the user to distrust every other number in the app. |
| D9 | **One owner per document; friends render and read, they do not edit.** | Cast ids are an array index plus four base36 characters of a millisecond clock (`routes.js:1012,1063`), segment and clip ids are fully deterministic (`:574`, `:1125`), and board→cast references are by *name* — these identifiers cannot carry a merge, and shipping one on top of them corrupts projects quietly. |
| D10 | **`graphHash` equality is a coherence check, never verification.** | It is `sha256(sortedJSON(graph))` of the *input* (`record.js:443`) — a dishonest peer echoes it for free — so it catches a stand-in model and catches nothing else, and it must never be the reason a peer's bytes are trusted. |

### 2. The mechanism

**Identity.** Two keypairs, generated on first visit to the Collab tab, never at boot:

```js
const sign = crypto.generateKeyPairSync("ed25519");   // spki 44 B, sig 64 B — measured
const seal = crypto.generateKeyPairSync("x25519");    // spki 44 B — measured
const fp   = sha256(signSpki || sealSpki).subarray(0, 16);  // 128 bits
```

Binding both keys into the fingerprint is what stops a substituted seal key. It is displayed two ways: `9f3a-1c2d-…` (32 hex, for logs and machines) and twelve words from the public-domain PGP biometric word list (for reading aloud). Both carry the same 128 bits. Stored at `<appData>/collab/identity.json`, written through the `tmp + rename` pattern at `mv/store.js:202-209`, then locked with `icacls /inheritance:r /grant:r` on win32 and `chmod 0600` on posix — **whichever one actually does something on that platform, and the tab prints which one ran.**

**Pairing.** Each Studio exports a ~200-character key card; the friend pastes it; both read the twelve words to each other on a channel an attacker cannot simultaneously control. Until that happens the row is `verified: false`, which may *receive* a project and may **not** send an order. Two independent booleans per peer, and this is the whole trust model:

```json
{ "fp":"9f3a1c2d…", "name":"mika",
  "sign":"<b64 spki>", "seal":"<b64 spki>",
  "verified": true, "addedAt": 1758300000000,
  "trust": { "returns": true, "orders": false },
  "lendMinutesPerDay": 0,
  "territory": null, "parity": null }
```

`trust.orders` defaults false and `lendMinutesPerDay` defaults 0: **adding a friend does not lend them your card, and a fresh install lends nothing to nobody.**

**The container.** Two layers, because the outer one must be checkable before 30 MB is decrypted.

```
AIPLAYSEAL1\n
<envelope JSON, one line>\n          {v,from:{fp,sign},to:{fp},eph,iv,tag,bytes}
<envelope signature JSON, one line>\n {alg:"ed25519",sig:"<b64 64B>"}
<ciphertext: AES-256-GCM over the entire inner bundle>
```

Inner bundle, after decryption:

```
AIPLAYBUNDLE1\n
<manifest JSON, one line>\n
<manifest signature JSON, one line>\n
<raw bodies, concatenated in manifest order>
```

Key = `HKDF-SHA256(X25519(eph, recipient.seal), salt = ephPub‖recipientPub, info = "aiplay-collab-seal-v1")`. The envelope signature is checked against the *pinned* key before a byte is decrypted, so an unknown sender costs one signature verify and nothing else. The manifest carries `bodySha256` plus a per-file `sha256`, so one inner signature covers everything and verification streams.

Manifest:

```json
{ "v":1, "kind":"project|order|return", "at":1758300000000,
  "from":{"fp":"…","name":"chesy"},
  "app":{"version":"AIPLAY Studio 0.1.0","commit":"<git sha, new at boot>"},
  "origin":{"ownerFp":"…","hop":1},
  "project":{"slug":"hex-appeal","id":"cebf8729","title":"Hex Appeal","kind":"mv","docSha256":"…"},
  "engine":{ /* §5 */ },
  "files":[{"name":"project.json","enc":"gzip","bytes":40708,"sha256":"…"},
           {"name":"assets/char_b53962174086.png","bytes":1048576,"sha256":"…"}],
  "order": null,
  "bodySha256":"…" }
```

**The order — and this is the security model.**

```json
{ "v":1, "id":"o_7f2a19c4", "slug":"hex-appeal", "docSha256":"…",
  "returnTo":{"fp":"…","name":"chesy"},
  "items":[{"id":"i1","segmentId":"s1_24","seed":91123,"steps":8,"mode":"fast"}],
  "allow":{"differentWeights":false,"differentBuild":false},
  "expect":{"frames":121,"width":1280,"height":704,"fps":24},
  "estimateSecondsEach":420, "expires":1758400000000 }
```

`ORDER_KEYS = ["segmentId","seed","steps","mode"]`, frozen and asserted by a test. **That is the entire vocabulary.** No graph. No tool name. No prompt. No filename. No model. The worker's own Studio builds the graph from its own `server/workflow.js`, its own weights chosen by its own `config.js:58-62` `pick()`, and its own copy of the project — which is why a fully compromised, fully trusted peer's best outcome is "renders scenes you already had, into takes you must pick by hand, logged under `peer:<fp>`".

The justification is not rhetorical. `graphProblems()` (`server/engine/record.js:245-265`) validates API-format shape, `inputs` presence and link targets — no class allowlist, nothing path-aware — and a graph on the wire would reach `ADE_LoadCameraPosesFromPath` (free `String` → `open()`, `nodes_cameractrl.py:366,392`), our own `AiplayLoadAudioLatent` (`np.load(path)` unchecked, `aiplay_latent_io.py:31,45`), `GLSLShader` (attacker-authored shader source to the graphics driver, `nodes_glsl.py:706-711`) and `MediaPipe-FaceMeshPreprocessor` (`pip install` into the engine's pinned venv on mere execution, `mediapipe_face.py:6-11,29`). And an allowlist over node classes is the wrong shape: it is generated from local history, it refuses `server/customWorkflows.js`'s legitimate bring-your-own graphs, and it *widens to fit* whatever last got through. The order has no words for any of it.

**The document is validated too.** A project doc is the graph one indirection up, and it arrives from the same party over the same channel, so `validateDoc()` runs before a byte is written: known top-level keys only (unknown keys **dropped and the dropped set displayed** — the lesson of `art.js:709-712`, where a silent whitelist ate `audioRef`); `brief` through the key whitelist and bounds `mv/routes.js:912,957-959` already enforces; `steps` clamped at the generate site, not on receipt; arrays capped (segments/boards/clips ≤ 200, cast ≤ 100, `runs` truncated to the 200 `noteRun` already bounds, `plans` **dropped entirely** — a peer's plan is not a plan of mine); prose strings capped at 20 000 chars each; every file pointer matching `^[a-z0-9][a-z0-9_.-]{0,95}$` *and* present in the manifest; the slug through `slugify()` plus collision dedupe, never overwriting.

**The receiver names every file it writes.** Assets are renamed by recomputing `${prefix}_${sha1(bytes).slice(0,12)}${ext}` exactly as `stageAsset` does (`mv/store.js:602-616`, read today) and refusing if the declared name disagrees; a sha1 hex has no path separators, so traversal is impossible rather than filtered. Clips land as `peer_<fp8>_<sha256[0..11]>.mp4`. The song — `output/Hex Appeal.wav`, a human-typed name in a global namespace, and the one real collision hazard — is received as `peer_<sha256[0..11]>.wav` with `song.file` rewritten. **No name from the wire is ever used as a name on disk.**

**Execution reuses the plan machinery entirely.** On import of `kind:"order"`, after every refusal in §4, `collab/routes.js` builds a plan through the existing `makeItem` (`mv/plan.js:117-139`) whose items are `{tool:"mv_generate_clip", args:{slug, segment, seed, steps}}`, `status:"proposed"`, `plan.title = "Order from @mika — 12 scenes"`, plus one new field `plan.fromPeer`. After that everything is code that already exists and is already right: approval is a human act on the Plan screen; the walk is one item at a time because "the resource being spent is one graphics card" (`planrun.js:200-206`); a second plan anywhere is refused (`planrun.js:352-360`, read today); a crash heals to `paused` (`plan.js:1046-1058`); the actor is `agent:plan` with the human joined by `approvedBy`.

**The busy check must read the art runner, not the plan runner.** `inFlight` is a `Map` keyed by **slug** that only `planrun.start()` populates (`planrun.js:144-149`, read today) — it tracks plans, not renders, and a hand-pressed local clip never enters it. The real serialiser is `ArtRunner`'s FIFO: `this.queue.push(job)` at `art.js:712`, `#schedule()` at `:733`, `if (!this.idle) return this.#schedule()` at `:762`, and `get idle()` at `:505` yields to **music only** (`this.comfy.ready && !this.jobs.current && this.jobs.queue.length === 0`). There is no priority field and no preempt. So phase one accepts an order only when `art.idle && art.queue.length === 0 && anyRunning().length === 0`, and the Accept card says plainly that once approved it runs to completion ahead of whatever the lender queues next.

**Returns go to quarantine.** `<outputDir>/collab/quarantine/<fp8>/`. Before anything in the app decodes it: hash equals the signed `result.sha256`; `ffprobe` agrees with `order.expect` (frames, width, height, exactly one video stream, no audio stream); `record.seed` equals the ordered seed. Then it sits there until a human presses **Adopt**, which copies it into `CLIP_DIR` under the receiver's own name, pushes a take with `pick:false`, and — the part `import_clip` does not do — **appends a `generate` event carrying the lender's `record.model` and the lender's `outputRights` verbatim**. That works today without touching the stamping logic, because `stampRights` (`provenance.js:272-280`, read today) says in its own words: *"A caller that supplies its own `outputRights` keeps it."*

### 3. Files

**New — `server/collab/`**

| file | owns |
|---|---|
| `identity.js` | the two keypairs, `fingerprint()`, `words()`, the platform-correct ACL lock |
| `words.js` | the PGP biometric word list, public domain, ~4 KB, no dependency |
| `peers.js` | `peers.json`, atomic write, pinning, `key_changed` |
| `seal.js` | envelope: X25519 + HKDF + AES-256-GCM, sign/verify |
| `bundle.js` | manifest build, stream verify, staging, receiver-side naming |
| `validate.js` | `validateDoc()`, `ORDER_KEYS`, `validateOrder()`, `validateReturn()` |
| `parity.js` | the probe, `parityClass`, the three-state comparison |
| `quarantine.js` | landing, ffprobe check, adopt (with the `generate` event) |
| `routes.js` | `/api/collab`, one door, the strong gate |
| `collab_test.js` | the lane |
| `server/mcp-collab.js` | the tools |
| `web/collab.js`, `web/collab.css` | the tab |

**Edited** — `server/index.js` (mount the route; stamp a git commit at boot — `grep -rn "gitSha\|git rev-parse" server/` returns nothing today and `appVersion` has been the same string on every install since the repo began); `server/provenance.js` (`PEER_RE = /^peer:[0-9a-f]{32}$/` in `normalizeActor`, its own group in `actorGroup` that **never** promotes `ai-generated` → `ai-assisted-human-edited` in `foldOrigin`, and two event types `share_out` / `share_in` — without the type registration `append` throws at `:291`, and without the actor registration every borrowed render files as `"system"`); `server/mv/store.js` (take rows accept `renderedBy`, `parityClass`, `peerRecord`; doc gains `collab:{origin, ownerFp, shares}` — both forward- and backward-readable so `DOC_VERSION` stays 1 per the stated rule at `:214-217`); `server/mv/routes.js` (a borrowed doc refuses mutating actions); `server/art.js` (peer orders bypass the **local** cost-model deadline — see the caveat); `server/chat/router.js` (three WITHHELD entries); `web/index.html`, `web/mv.js`, `server/mcp.js`.

**Dependencies added: zero.** Ed25519, X25519, HKDF, AES-256-GCM and gzip are all `node:crypto` / `node:zlib`, all verified working on this machine today. `package.json` stays at its three dependencies.

### 4. The refusals

Each returns `{error, reason}`; `reason` is the branchable string. Evaluated in this order — cheapest and most catastrophic first.

**Before a byte is decrypted**

| reason | when |
|---|---|
| `no_identity` | no keypair yet; nothing else runs |
| `bad_container` | first line is not `AIPLAYSEAL1` |
| `envelope_too_large` | envelope line > 8 KB, refused **before** `JSON.parse` |
| `not_for_me` | `to.fp` is not mine |
| `unknown_peer` | `from.fp` not in `peers.json`; never "add and continue" |
| `key_changed` | fp known, key bytes differ — **hard refusal, no auto-update**; re-added by hand after a voice call |
| `bad_signature` | Ed25519 verify fails on the envelope line |
| `bundle_too_large` | declared bytes > 4 GB cap, or > free disk × 0.66 |

**Opening and writing**

| reason | when |
|---|---|
| `seal_failed` | AES-GCM tag mismatch — truncated or tampered |
| `bad_manifest` | inner magic wrong, or manifest line > 1 MB |
| `manifest_signature` | inner signature fails (sealed is not signed; both are checked) |
| `unsafe_name` | a `files[].name` outside `assets/<base>` or `<base>`, or containing `..`, a separator, or a drive letter |
| `asset_name_not_content_hash` | staged name ≠ `${prefix}_${sha1(bytes).slice(0,12)}${ext}` |
| `blob_hash_mismatch` | received bytes ≠ declared sha256 |
| `blob_type_refused` | magic bytes outside `{png, jpeg, webp, mp4, wav, flac, glb}` |
| `doc_rejected:<key>` | `validateDoc()` — names the key |
| `slug_collision` | slug exists with a different `project.id`; import offers a new slug, never overwrites |
| `disk_space` | free < bundle × 1.5 |

**Before the card turns**

| reason | when |
|---|---|
| `peer_not_allowed_to_order` | `trust.orders` false — the default |
| `peer_unverified` | the twelve words were never read aloud |
| `budget_zero` / `budget_spent` | no minutes set (default), or today's are gone |
| `card_busy` | `!art.idle`, `art.queue.length`, or `anyRunning().length` |
| `order_expired` | past `expires` |
| `doc_out_of_date` | `docSha256` ≠ sha256 of my copy |
| `segment_unknown` | `segmentId` not in my copy |
| `steps_out_of_range` | outside 1–50, clamped and refused loudly |
| `order_too_large` | items > 50, or `items × estimateSecondsEach` over the lend budget |
| `build_mismatch` | `app.commit` differs and `allow.differentBuild` false — a warning on a project, a **refusal** on an order |
| `engine_mismatch:<field>` | any `weights.*` or `vendor` differs and `allow.differentWeights` false — names the field |
| `licence_territory` | the engine this order would use is `excluded` in **my** declared territory (`models.js:602,635,674`), decided from **my** catalogue |
| `rights_below_ceiling` | the engine's `outputRights` class is below the project's declared ceiling |

**On return**

| reason | when |
|---|---|
| `return_unknown_order` | `order.id` I never sent |
| `return_scene_not_in_order` | a `segmentId` that was not in that order |
| `result_hash` | bytes ≠ signed sha256 |
| `result_not_the_shot` | ffprobe disagrees with `expect{}`, or ≠1 video stream, or any audio stream |
| `record_inconsistent` | `record.seed` ≠ ordered seed, or `record.model` not in my catalogue |

**Deliberately not refusals:** a returned take is always a take and never auto-picked (picking is an artistic act); a mixed-engine project still renders and gets a badge per take plus a "mixed engines" line; and a `parityClass` difference is **displayed, not refused** — refusing would make the feature useless and staying silent would be worse.

### 5. Parity — the number behind the promise

On first pairing and daily after, both machines render one pinned graph — **512×512, 3 steps, seed 1, SD1.5 Dreamshaper 8**, which is one of the 37/79 catalogue rows that carries a real `sha256` — and exchange the output digest. This costs nothing to capture: `collectOutputs` already hashes every output unconditionally (`client.js:1005-1012`).

```json
{ "vendor":"nvidia", "gpu":"RTX 4070 Ti SUPER", "vramGb":16,
  "torch":"2.13.0+cu130", "engineVersion":"0.36.0",
  "flagsHash":"sha256:…", "probeSha256":"…", "probeSeconds":11.4,
  "parityClass":"3e91ac7d",
  "weights":{"dit":"…int8….safetensors","videoVae":"…fp16….safetensors","textEncoder":"…","turboLora3":"…"} }
```

`flagsHash` hashes the argv **with `--port`, `--output-directory` and `--input-directory` removed**, because the port is re-reserved at every start (`client.js:187-205`) and `engineArgvHash` therefore changes on every boot.

Three states, and the third is the point:

- **PASS** — same probe digest, same weight filenames. The two machines agreed on a real render.
- **FAIL** — different weight filenames, or different vendor. `pick()` (`config.js:58-62`, ten call sites at `:1030-1098`) falls int8 → int4 → w4a8 for the video DiT and fp16 → int8 for the video VAE from whatever is on disk, silently, at process start; `weight_dtype: "default"` in every `UNETLoader` (`workflow.js:137,420,488`) means two precisions produce the **same** `graphHash`; and 42 of 79 catalogue rows carry no `sha256` while `filePresent()` compares size only (`models.js:2795`).
- **UNMEASURED** — different torch, driver or ComfyUI build, and **nothing in this repo has measured whether that changes output.** The screen says exactly that, the user may walk through it knowingly, and the word rides along on every take so the timeline can later answer "which shots were never verified against each other". This is the default disposition for every parity field we have no number for, and there are more of those than there are numbers.

### 6. Control, number, tool

| feature | plain control | the number | tool |
|---|---|---|---|
| Identity | "Create my Collab identity" | 128-bit fingerprint, shown as 32 hex and 12 words | `collab_identity` |
| Friends | "Add a friend" → paste card → "We read the same twelve words" | verified date; `trust.returns` / `trust.orders` as two switches | `collab_peers` |
| Share | "Share project" + **"Seal to mika" checked by default** | 30.9 MB for hex-appeal — `project.json` **468,549 → 40,708 B gzip -9 (11.5×)**, `provenance.jsonl` **88,272 → 17,510 B**, 32 assets stored raw because PNG gains 0.08 %, seal adds **33.7 ms** (all measured today) | `collab_export` |
| Lend | "Lend my card" + minutes/day box | minutes lent today / budget; the Accept card's cost line (§below) | `collab_lend` |
| Order | scene picker + "Allow friends with different weights — clips may not match" | items × per-peer measured probe-scaled estimate; bundle ~4 KB | `collab_order` |
| Parity | "Check parity" | `parityClass`, probe seconds, per-field PASS / FAIL / **UNMEASURED** | `collab_parity` |
| Returns | "Adopt take" (one per clip) | bytes, sha256, `renderedBy`, `parityClass`, lender's model + `outputRights` | `collab_returns` |

**The Accept card, in the lender's own units, printed before either party presses anything:** *"Twelve scenes at 8 steps is roughly 84 minutes of your card. While it runs, your own renders wait — there is one GPU. It holds about 14.9 GB of VRAM, writes about 76 MB of clips, and costs you the electricity."* The 84 comes from `planrun.js:72-81`'s ~7 min at 8 steps; **after the first order it is replaced by that peer's own measured time**, because a timeout anecdote is not a benchmark.

Three tools go in the WITHHELD table (`chat/router.js:339-382`), in that table's voice:

```
collab_import:   "writes a stranger's file into a project directory; a signature is
                  checked by a person who knows whose it is",
collab_order:    "spends someone else's card for hours; that is theirs to accept",
collab_identity: "hands out a public key and the machine's engine fingerprint, which
                  together say what hardware is on the other end of this chat",
```

`collab_peers` and `collab_returns` (read-only) stay routable.

⚠ **As built, this list is superseded** (2026-09-24). There is no `collab_import`
or `collab_order` tool; orders are packed by `collab_preview` + `collab_pack`.
`collab_accept` and `collab_adopt` DO exist: accept requires `seen: true` (the
person read that exact file's prompt and pictures) and adopt keeps a failed take
only with `anyway: true`. The in-app chat routes them as "writes", so it asks
the person before each call; the banner at the top of this file is the current
list.

### 7. The gate

`GET/POST /api/collab`, gated by a copy of the **strongest** existing check — `server/chat/routes.js:122-133`, `Origin` when present and `Sec-Fetch-Site: same-origin` as the fallback, *"a FORBIDDEN HEADER NAME so no page script can forge it"* — and not the Origin-only version at `engine/routes.js:79-83`. This matters because 55 `readBody(req)` sites in `index.js` parse any content type with exactly one gated (`:2309-2314`), so any page the user visits can already queue GPU work through `/api/generate`. **Collab must not become the 56th.** Bundles live at `<outputDir>/collab/{out,in,.staging,quarantine}/`; `scan_inbox` lists `in/`, so pointing Syncthing at that folder is the entirety of "automatic peer-to-peer delivery" with no networking code in this repo.

### 8. The tests that would pin it

`server/collab/collab_test.js` **exists and is in the hook** — 156 pins, CPU only.
It covers the courier and the two units: the fingerprint as a commitment to both
keys (an adversarial review forged a card that resolved to a verified friend, and
that attack is line 1 of the lane), the seal bound to its recipient, one parser
for the bundle, a roster that refuses rather than empties itself, and a packet
that carries a scene without the script. It does NOT cover lanes 1, 4, 5 and 7
below, because the order vocabulary, the plan import and the quarantine they
describe are not built. The list is left here as written, as the specification
for the half that is missing:

1. **Round trip** — identity → pair → seal → open → import → order out → order in as a `proposed` plan → return → quarantine → adopt, asserting the adopted take carries `renderedBy`, `parityClass` and a `generate` event whose `outputRights` equals the lender's.
2. **One case per reason string**, all 30+, each asserting the exact `reason` — a refusal nobody can branch on is not a refusal.
3. **Tamper lane** — flip one byte of the body → `seal_failed`; one byte of the manifest → `manifest_signature`; substitute the sender's key → `key_changed`; truncate at 90 % → `seal_failed` with nothing written outside `.staging`.
4. **Hostile doc lane** — `../../` in a file pointer, 10 000 segments, a 40 MB prose string, `steps: 1e9`, `slug: "../../../evil"`, a `plans` array with a `mv_render_video` item. All refused by `reason`, none written.
5. **Vocabulary lane** — assert `ORDER_KEYS` is exactly those four names, and that the plan item built from an order has exactly `{slug, segment, seed, steps}`; a static assertion that no module under `server/collab/` ever calls `engine.dispatch`.
6. **Naming lane** — every asset name recomputed from bytes; a bundle whose declared name disagrees is refused; the same bundle imported twice is idempotent (hex-appeal: 32 referenced, 32 on disk, 0 orphans — still true today, 32 entries in `assets/`).
7. **Gate lane** — `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site` both refused.
8. **Fixture lane** — add `*.aiplay -text` to `.gitattributes` **before** the first fixture lands, because the system gitconfig here has `autocrlf=true` and a lane that hashes fixture bytes fails on a fresh worktree.

---

## PHASE TWO — the socket, same format

Swap the courier: a second `http.createServer` + `WebSocketServer` on its own port (default 4174), off by default, **never the 4173 app server**, carrying the identical envelope, signatures, order vocabulary and refusal list. Transport security is TLS 1.3 with an **external PSK derived from the pair secret**, so the pairing already done *is* the credential — measured in a sibling design at 23 ms handshake, 147.5 MiB/s loopback, wrong PSK → `EPROTO` with zero application bytes exchanged and `X25519` ephemeral confirmed, using the `ws` already in `package.json`. A bind guard refuses anything that is not loopback, RFC1918 or a tunnel interface, with reason `insecure_bind` — a forwarded port is not an equal option, because signing buys integrity and buys exactly no confidentiality. **Before it starts:** phase one has moved a real episode between two machines; the bundle format is frozen with a version test; the `ArtRunner` has a priority or preempt notion (today it is a bare FIFO with `get idle()` yielding to music only), because a socket makes orders arrive while the owner is sitting at the keyboard; and `collab_*` refusals have been exercised by someone who is not me.

## PHASE THREE — standing consent and a farm evening

`plan.policy.autoApproveUnderMinutes` already exists on every plan row and is untouched by phases one and two; phase three lets a peer's order auto-approve beneath a per-peer minute ceiling, adds a live progress frame every 5 s with a stale/lost/reclaim path (a reclaimed order's late result is not an error — `takes[]` is append-only, so it lands as an extra take), and lets the composer predict a whole episode across three cards from each peer's measured throughput. **Before it starts:** somebody must run the video equivalent of `exactness_suite.py` — the only exactness data on the rig is six MiniMax Music 3 cases producing `.flac`, and there is no H3, LTX or FLUX.2 equivalent anywhere; the art-runner deadline must stop being computed from the local cost model (memory: `art.js:1346` has no `refImages` term, and a knee clip predicted at 953 s timed out at 4,115 s and actually took 4,298 s — a borrowed render on a slower card is the case that fires it); and at least one episode must have shipped through phase two without a human wishing they had picked the takes themselves.

---

## WHAT WE SHOULD NOT BUILD

**A Collab tab that plans.** The ask says "a collaboration tab in which we can organise these and plan them" — organising is right and exists nowhere; **planning already exists** in `plan.js` + `planrun.js`, reviewed, approved, one-at-a-time, crash-healing, ledger-stamped and budget-aware. A second planning UI would drift within a month and would be where a plan gets approved without the guards. Collab is an address book, a courier and an inbox.

**Splitting a continuity run across three cards.** This is the part of the ask I push back on directly: two shots that cut together, rendered on two different DiT quantisations, with an identical `graphHash` because `weight_dtype: "default"`, is exactly where the drift lands and exactly where you cannot fix it later. Lend friends' cards for **b-roll, establishing shots, dance and VFX inserts** — scenes allowed to look like themselves — and keep a character-continuity run on one card. The composer should say so when the ticked scenes are contiguous. That is a directing note, and it is the honest consequence of the parity measurements rather than a gap in the feature.

**Concurrent editing, in any form.** See D9. One owner, one document, is the only shape these identifiers support, and shipping a merge on top of a four-character clock id would corrupt projects quietly — the worst outcome this codebase can produce.

**A graph on the wire. Ever.** Not a wait — a never. Every future capability arrives as a named order with a validated arg schema, reviewable and refusable by name on both sides.

**A rendezvous or relay server, in any version.** And the honest note in the docs, not the flattering one: Tailscale's **control plane is a company-run coordination server** — the device list and key exchange live there — so recommending it is recommending a third party you are choosing to trust, not local-first. The version with no company at all is Headscale or a hand-configured WireGuard. What stays true either way: *no server we run, and none that ever sees your project or your renders.*

**Lending the music queue.** `jobs.js` specs carry `rung`, fitted from the **local** `cudaCapability()` (`index.js:3012,3023-3024`), with fp8 refused below compute 8.9; a 24 GB fit on a 16 GB card OOMs and nothing in the spec records which card chose it. Fixable by re-fitting at the receiver, but that is a second measurement campaign and video is where the hours go.

**Sharing the DAW / timeline.** `store.js:8-14` says the timeline's save path re-serialises from a fixed field list and destroys unknown top-level keys the moment a human presses Save, and `output/projects/<slug>.json` overwrites by name. `timelineProject` is a name, not an id.

**Re-sharing prevented as a *guarantee*.** Keep the `not_owner` refusal, kill the word "cannot". The screen says: *"Your Studio will not re-export someone else's project. Nothing stops a person forwarding the file."*

---

## THE QUESTIONS, AND THE ANSWERS THEY GOT

1. **Do you actually want to share projects, or only to borrow cards?** If it is only cards, the unit can be a *recipe* — prompt, seed, settings, content-addressed reference hashes — and no project ever moves, which halves phase one. If it is projects, the 30.9 MB bundle is the unit. These are different first weeks.
2. **What territory does this machine declare, and will you ask your friends to declare theirs?** H3 and its distillations carry territory exclusions, and the list of them lives in `server/models.js` rather than in this sentence — a hand-typed copy of it drifts, which is why the gate refuses one. Nobody but the person sitting at each machine can answer where it is, and the refusal is decided by the *lender* from the *lender's* catalogue — you cannot assert it on their behalf.
3. **Does a project carry a commercial ceiling?** If you say "this episode must stay sellable", `rights_below_ceiling` becomes a refusal instead of a warning, and a friend whose only installed checkpoint is CC BY-NC simply cannot help on that project.
4. **How many minutes a day, per friend, by default — zero, or a number?** Zero is the safe default and it means every first lend requires you to type something.
5. **Is a friend allowed to read the script?** A project bundle carries `styleBible`, `lookBible` and all 44 board prompts. They need them to render. There is no version where they render blind.
6. **Twelve words read aloud, or a QR code on screen?** Both are 128 bits; the words survive a phone call, the QR survives a coffee shop.
7. **Who owns an episode three people made?** The design writes one `ownerFp` into the document and the ledger keeps it forever. If the answer is "it rotates", say so now, because that is a different field and a different set of refusals.

---

---
# THE OWNER'S ANSWERS, 2026-09-20

The seven questions above were put to the owner and answered. They are no longer
open, and this section is the record of what was decided and by whom. Where an
answer changes the design above, the design above is wrong and this is right.

**1 — Share projects, or only lend cards? BOTH, and the unit depends on the ROLE.**
A friend is a *collaborator* or a *lender*, and the difference is what leaves
your machine:

- a **collaborator** receives the project bundle — boards, cast, bibles, the
  plan — because they are making the episode with you;
- a **lender** receives a **shot packet** and nothing else: one composed prompt,
  the reference pictures that prompt needs, and the render settings. They never
  see the script, the other scenes, the song or the plan.

The packet is composed by the OWNER, which also closes a trap the design names
elsewhere: `clipPrompt()` prepends the local `styleBible` unconditionally, so a
prompt composed on the lender's machine would silently wear the lender's style
bible. A packet carries the finished prompt; the lender's Studio composes
nothing.

**2 — Territory: NOT ENFORCED, and that is the owner's decision.**
> "lets ignore the territory, they know themselves what models they can download
> when they use the software. if they are in any of the regions that are not
> allowed it's their own risk"

So there is no territory refusal in the lending path, and the design's
`licence_territory` refusal is withdrawn. What does NOT change: every render
still records the model that made it and its licence class, and an adopted clip
still carries the lender's stamp. The app keeps saying what a thing is; it stops
deciding where its user may stand. ⚠ This is a decision about liability made by
the person who owns the machines, recorded here so nobody later mistakes the
absence of a check for an oversight.

**3 — No commercial ceiling.** `rights_below_ceiling` stays a warning and never
becomes a refusal. A friend whose only checkpoint is non-commercial may help on
any project; the class travels with the clip and is shown at export.

**4 — `lendMinutesPerDay` defaults to ZERO** (the recommendation). Adding a
friend lends them nothing. The first lend is a number somebody types, which is
the only moment the question "how much of my machine is this?" is asked while it
can still be answered calmly.

**5 — What a friend may read: see 1.** A collaborator reads the script because
they are writing it. A lender reads one prompt because that is what renders.

**6 — TWELVE WORDS, not a QR code** (the recommendation). Both carry the same
128 bits, but a QR needs two people in one room, and the case this exists for is
three friends who are not. Words survive a phone call, a voice note and a
read-back over a game. The QR stays unbuilt rather than unavailable: if two
people are in a room, they can read twelve words to each other faster than they
can find a camera.

**7 — Ownership is PER PROJECT; the roster is SHARED.**
> "more people might be working on the same tv series but design different
> episodes… each might be working on a collaborative project but different
> owners yet the GPU/resources is shared across all"

So `ownerFp` stays a per-project field and does not rotate — each episode has
one owner, and different episodes of one series may have different owners. The
friend list, the capability cards and the lending limits are **global to the
machine**, not per project: you lend your card to a person, not to an episode,
and one roster serves every project they help with. A lender's daily minutes are
therefore spent across all projects, which is what makes the number meaningful.

## THE HONEST CAVEATS

**It will not make tonight faster.** A bundle is a file on a human timescale. Phase one's latency is however long your friend takes to wake up, and there is no round trip to measure.

**Nothing about video parity has ever been measured here.** The single exactness campaign on this rig is `D:/AI/aiplay-studio-bench/results/exactness.json` — verified today, 1,655 B, six cases, every output a `.flac`, MiniMax Music 3 int8. Its most quotable result (`--disable-smart-memory` changing 2,269,816 samples, 19.02 %) is a **music** number; it will not appear on any video screen in this feature, and it does not license any claim about H3, LTX or FLUX.2. `--highvram` and normal VRAM mode are untested for exactness even in audio, and the `auto` tier picks between all three by card size.

**Sealing has a limit.** The bundle is encrypted to the recipient's *static* seal key, so an attacker who later compromises that key can open every bundle that friend ever received. The sender's ephemeral gives forward secrecy in one direction only. And once your friend opens it, they have the plaintext — sealing protects the courier, not the friend.

**The ledger proves consistency, not authenticity** (`provenance.js:22-29`). A peer's `provenance.jsonl` rides along as `provenance.from-<fp>.jsonl`, is `verify()`-ed on arrival, and is **never appended to your chain**. It is a claim, filed as a claim. The detached signature beside it is the only part anyone can check.

**`peer:<fp>` is a label, not a proof.** So is `agent:` and so is `script:` — and today the *absence* of the `x-aiplay-actor` header is the only evidence of a human being (`provenance.js:192-199`). The reason `peer:` is worth adding is narrower than it looks: it keeps a friend's render out of the one promotion that matters, `foldOrigin`'s `who === "user"` at `:431`, so a borrowed clip can never become "ai-assisted-human-edited" on the strength of somebody else's hand.

**The licence problem, stated plainly, because it is the real wound.** The app records a licence and an `outputRights` class per model (`server/models.js`), and `stampRights` writes it into the `generate` event from `data.model`. Three things break when a friend's card renders:

- **Territory is theirs, not yours.** Asking a friend in the EU to render H3 asks them to break a licence *they* accepted. The refusal must be evaluated on the lender's machine from the lender's catalogue and the lender's declared territory, and it must be a refusal, not a warning — which is why `licence_territory` sits above the budget check in §4.
- **One non-commercial clip is enough.** If a friend's install renders even one shot with CC BY-NC weights, the finished episode is non-commercial, whether or not anyone notices. The rights floor makes that visible at Export instead of at a lawyer's office.
- **Today it would vanish silently.** `import_clip` (`routes.js:1087-1139`, read today) writes `seed: null, imported: true, engine: "import"` and a `noteRun` breadcrumb — **no provenance event, no model, therefore no rights stamp**. Route borrowed renders through it unchanged and distributed rendering becomes a rights launderer, on the machine of the person who will actually publish. The fix is in phase one and is not optional: adoption writes a `generate` event carrying the lender's `record.model` and their `outputRights` verbatim, which `stampRights` already declines to overwrite (`provenance.js:272-274`). A `renderedBy` string on a take row is a label; the ledger event is the record.

**One number in this document is not a measurement.** The "~84 minutes for twelve scenes at 8 steps" on the Accept card derives from `planrun.js:72-81`, which is a note about undici's 300-second header timeout, not a benchmark. It is the best figure available before the first order runs, and the design replaces it with each peer's own measured probe-scaled time the moment there is one. Everything else cited above with a number was either read out of the file today or run on this machine today.

---

# ADDENDUM — resources, and credit

## WHAT EACH STUDIO SAYS IT CAN DO

A Studio never forwards `/api/status`. Those routes answer *what is on this machine*; a friend is asking *what will you do for me*, and the second question has a much smaller true answer. `server/peer/card.js` builds a separate document — **the card** — by an allow-list, addressed to exactly one fingerprint, sealed to that peer's X25519 key and signed ed25519 over bytes that include `to`. It is built **only when a friend asks**, never on a timer: a card re-issued every hour whether or not anyone wanted it is a presence beacon with a signature on it.

**It advertises verbs, not nouns.** `server/peer/orders.js` is the coarsener and the only place a capability id becomes an order id:

```js
export const ORDERS = {
  "mv.clip":  { needs: ["videoH3Turbo3","video","videoLtx"], modes: ["fast","standard","best"] },
  "mv.still": { needs: ["imageKrea2","imageZImage"],         modes: ["standard"] },
  "music.song": { needs: ["musicYue2Comfy","musicAceStep15"], modes: ["standard"] },
};
```

An order is offered when any `needs` row is `ready` — the measured disk answer from `models.status()` (`server/models.js:2904`) — **and** the owner switched that order on. Three friends with three different video models all advertise `mv.clip`, which is the point: `server/mv/planrun.js` already runs orders, not graphs.

```json
{
  "v": 1,
  "kind": "aiplay.card",
  "from": "b7c19e402d558a13f0ab6c7291de3f48",
  "to":   "4a2fe81c6b90d7532ee1bb04c8571f6a",
  "nickname": "Senzu's desk",
  "issuedAt": "2026-09-20T11:04:12Z",
  "seq": 47,
  "ttlSeconds": 900,
  "level": "coarse",
  "catalogueRev": "sha256:41c8be03",
  "measured": {
    "engine": { "ready": true },
    "machine": { "vramBandGb": 16, "ramBandGb": 32, "reading": "nvidia-smi" },
    "busy": { "queued": 3, "runningKind": "clip", "runningSince": "2026-09-20T10:58:31Z",
              "freeAt": null, "freeAtReason": "no-measured-rate" },
    "orders": [
      { "id": "mv.clip",  "modes": ["fast","standard"], "ready": true,
        "digest": "sha256:9f1c7e40aa2b6d18", "files": 4, "hashable": 2 },
      { "id": "mv.still", "modes": ["standard"], "ready": true,
        "digest": "sha256:2b70ce18f4a09d33", "files": 2, "hashable": 2 },
      { "id": "music.song", "modes": ["standard"], "ready": false, "digest": null,
        "files": 5, "hashable": 5 }
    ]
  },
  "declared": { "studioVersion": "0.9.14",
                "orders": [ { "id": "mv.clip", "outputRights": "yours-with-conditions" } ] },
  "sig": { "alg": "ed25519", "by": "b7c19e402d558a13f0ab6c7291de3f48",
           "over": "canonicalJson(card minus sig)", "value": "3Jq7…" }
}
```

`digest` is `sha256` over the backing capability's id plus one sorted line per file, `slot|bytes|catalogueSha256|-`. No file is read. It proves *same catalogue row, same slots, same sizes* and nothing more; the card never hashes weights, because a card that costs a 20 GB read is a card nobody builds.

**Bands, not readings.** `vramBandGb` is 8/12/16/24/48, `ramBandGb` is 8/16/32/64/128, banded from the measured total. `reading` is `"nvidia-smi" | "engine-log" | "none"` — the data itself says whether the number was measured by a driver, scraped off ComfyUI's startup line (`server/comfy.js:303-304`), or neither. `"none"` is not a failure; it is an AMD or Intel box publishing its own box number and saying so.

**No throughput figure leaves this machine, at any level.** Not `elapsedSec` medians (that field is what the caller waited, includes queue time, and is written on timeouts and cache hits too — `server/engine/client.js:934-937`), not `art.recent[].ms` grouped by kind (one "clip" pool blends 3-step turbo and 8-step, 5 s and 12 s; on this rig that pool spans 105 s to 4298 s). `freeAtReason: "no-measured-rate"` is the honest field and it is the whole answer. `busy.queued` and `runningSince` are published and never refuse anything: a full queue is a wait, not a failure.

**Never published, at any level. These are not switches.** Absolute paths (`config.paths`, `python.path`, `python.probed`, `capabilities[].files[].dest`) — every one carries the Windows account name. `local.files[]`, the complete weights inventory including private fine-tunes, and `musicYue2Lora` by name. `/api/loras`' bare readdir, which for anyone who trains is a list of the people they have trained on. `region.excluded` and any territory acknowledgement. Free VRAM and every four-second number — a heartbeat is an attendance record. Disk. `library`, `trash`, `playlists`, `art.recent[].title`, `jobs.snapshot().title`, every caption and lyric. Engine internals and the launch line. And every sentence composed here: `assertNoProse()` requires each string to match `/^[a-z0-9._:-]{1,64}$/i` or be a known enum, so the only free text in a card is one 48-character nickname. A card structurally cannot carry a confession.

**The boundary is a test, not reviewer discipline.** `server/peer/card.js` may not import `server/index.js`'s status assembly; it calls `models.status()` and `gpuStatus()` and names every field it takes. `assertAllowed()` throws at build time on any key not in `CARD_KEYS`, and `server/peer/card_test.js` walks a card built against a fixture and fails when a new field appears. A deny-list over `/api/status` publishes the next field somebody adds in a hurry.

**Staleness.** `ttlSeconds` defaults to 900. Past it the roster greys the row and dispatch refuses. Nothing silently refreshes. In phase two the socket is pull-only, so there is no staleness problem at all: a borrower asks, and the lender builds a fresh card to answer.

**Consent is an affirmative signal, not an absent header.** `POST /api/peer/level` requires `X-AIPLAY-Consent`: a single-use 90-second token minted by the Sharing screen and bound to the fingerprint and the level. `prov.actorFrom(req)` still fills the ledger row's `actor` — but it returns `"user"` for any caller that simply omits a header (`server/provenance.js:192-199`), so it may not be the gate on the one door where disclosure becomes public. Being wrong there is a mislabel; being wrong here is an unconsented disclosure.

The disclosure is recorded, once per change:

```json
{"v":1,"id":"ev_…","t":"2026-09-20T11:04:12Z","actor":"user","type":"advertise",
 "asset":"peer/4a2fe81c6b90d7532ee1bb04c8571f6a",
 "data":{"level":"coarse","orders":["mv.clip","mv.still"],"vramBandGb":16,"ramBandGb":32,
         "cardHash":"sha256:9d1c…","ttlSeconds":900},"prev":"sha256:…"}
```

Scope `library`. It falls to `foldOrigin`'s `default: break` and changes no origin class — a disclosure is not authorship. Written only when `cardHash` or `level` differs from the last row for that fingerprint; a re-issue of an unchanged card writes nothing.

### The card authorises nothing

The card is a **filter** that saves a pointless round trip. The only reading that may permit a render is `assertCapability(id, {digest, mode})` in `server/peer/verify.js`, running on the lender's own disk in the seconds before the plan runner calls the tool — stat every required file, hash every file the catalogue records a sha256 for, cache by `path → {size, mtimeMs, ino, sha256}`. It writes a `capability_check` event and the resulting `plan_step` names its id beside `approvedBy`:

```json
{"v":1,"id":"ev_7c31…","t":"2026-09-20T11:19:02Z","actor":"agent:plan",
 "type":"capability_check","asset":"peer/b7c19e402d558a13f0ab6c7291de3f48",
 "data":{"phase":"atUse","order":"mv.clip","capability":"videoH3Turbo3","ok":true,
         "digestClaimed":"sha256:9f1c7e40aa2b6d18","digestNow":"sha256:9f1c7e40aa2b6d18",
         "files":4,"hashed":2,"hashable":2,"unhashed":2,"mode":"bytes","cacheHit":true,
         "ms":41,"cardSeq":47},"prev":"sha256:…"}
```

`server/mv/planrun.js` already turns a thrown string into a failed item, a paused plan and a `plan_step` with `ok:false` (lines 240-253), so the lender-side refusal path is a ten-line insertion. The two-leg join — *a human approved* / *a machine executed* — gains its third leg: **and the machine was the machine that was described.**

**Borrower-side, on the card — free, and never authoritative.** `PEER_CARD_STALE`: "Bucky's card was built 4 h 12 m ago and is good for fifteen minutes. That is a description of a machine which has had four hours to change." `PEER_CARD_NOT_ADDRESSED`: "This card is addressed to a fingerprint that is not yours. A forwarded card is a file about someone, not an offer to you." `PEER_CARD_UNSIGNED`. `PEER_CARD_REPLAY`: "This is seq 41 and you hold seq 47." `PEER_ORDER_UNKNOWN`. `PEER_CATALOGUE_DIVERGED`: "their `mv.clip` is catalogue 41c8be03, yours is 6a02f1d9 — 'ready' there means a different list of files."

**Lender-side, at use — the only reading that matters, and it costs the render.** `CAP_FILE_MISSING`: "…is not on this disk. The card that said otherwise was built at 11:04 and this was measured now." `CAP_FILE_SIZE`: "…is 4 102 293 504 bytes; the catalogue names 4 102 297 600. A file of the wrong length is not the file, and this render is refused rather than run to find out." `CAP_FILE_BYTES`: "…right length, wrong file (sha256 3b7e91…, expected 9c04af…). Nothing was rendered and nothing was deleted." `CAP_DIGEST_DRIFT`: "these files changed after the card your friend approved. They agreed to a machine that no longer exists here; ask them again." `CAP_PACKAGE_MISSING`. `CAP_ENGINE_DOWN`. A file the catalogue records no sha256 for is accepted on size and counted out loud as `unhashed` — refusing on a number nobody measured would be a new lie.

Building a card is the `stat` sweep `/api/models` already does — about 200 ms cold, and **`models.status()` is not to be cached to make this cheaper**: a stale catalogue right after a download finishes is exactly the moment the Models screen must be fresh. Cards are built only when asked, so the cost never mattered. The wire cost is ~600 bytes coarse; a forwarded `/api/status` is 200 KB–2 MB, nearly all of it somebody's library.

---

## WHO DID WHAT

### The fifth actor class

```js
const PEER_RE = /^peer:[0-9a-f]{32}:(user|system|agent:[a-z0-9_.:-]{1,40}|script:[a-z0-9_.-]{1,40})$/i;
```

Two colons split it; everything after the second is *their* actor string, verbatim, so `agent:plan` stays readable as `agent:plan`. That one field pair answers the whole question — whose person, whose agent — without two parallel tables. `normalizeActor()` accepts it **only** when called with `{peerOk:true}`, which only the claim-file writer passes; everywhere else a `peer:*` string still falls to `"system"`, so every existing ledger stays bit-identical. `actorGroup()` gains a `"peer"` arm; `editsBy`/`authoredBy` gain a `peer` counter. **The two `who === "user"` promotion gates are untouched: a peer's edit never promotes `ai-generated` → `ai-assisted-human-edited`, and a peer's `author_text` never assigns `human-authored`.**

### Filed, not merged

A lending machine mirrors every event under the borrowed project id into `<appData>/collab/<project>/out/provenance.jsonl` — ordinary events, ordinary actors, its own chain. **What it sends is a listed subset, not the mirror whole.** `bundle()` strips verbatim `delegate` briefs (the ledger stores prompts and lyrics as `promptHash`/`textHash` + `chars`, never text; a free-text field with no length bound must not be the exception), and strips `onCard`, `onCardVramMb` and per-run `elapsedSec` — a card model plus timings is a stable device fingerprint, and nothing in the rollup reads them. The lender sees the field list on their own screen before anything is sealed.

On arrival the bundle is written verbatim to `collab/<project>/in/<fp>/provenance.jsonl` with its `head.sig.json`, and the owner's chain gains exactly one line:

```json
{"v":1,"id":"m0k3x9q2a1b2c3d4e5","t":"2026-09-20T14:02:11Z","actor":"user",
 "type":"attest","asset":"mv/hex-appeal",
 "data":{"peer":"2f8a41c9e07b3d6a5c1e94b28d70f3ab","name":"Mara","nameSource":"verified-aloud",
   "alg":"ed25519","keyId":"sha256:ab12c0…","sig":"3Jq7…","head":"sha256:7c1d9f0e…","count":41,
   "first":"2026-09-19T20:11:03Z","last":"2026-09-20T13:58:44Z",
   "extends":"m0k2p4r8…","extendsHead":"sha256:41ba22…",
   "verified":{"sig":true,"chain":true,"brokenAt":null,"continues":true},
   "filed":"collab/mv__hex-appeal/in/2f8a41c9…/provenance.jsonl",
   "note":"filed as their account, not merged into mine"},"prev":"sha256:…"}
```

My chain says **when I received their word and what their word was at that moment — never what they did.** `extends`/`extendsHead` make the pointer mean something: a peer's account may grow, it may not be replaced. The signature is re-verified on **every** dossier read, not trusted from import: a claim file verified once is a claim file somebody edited afterwards.

Refusals, enforced in the writer rather than at call sites. `append()` with a `peer:*` actor outside a claim scope: *"a peer:\* actor may only be written to that peer's own claim file. A line in my chain saying a friend acted is my word for their act; filed separately under a signature, it is theirs. Write an attest instead."* Nested peer label: *"a peer label inside a peer label is not an identity, it is a relay claiming to be the thing it relays."* Bad signature: *"an unsigned claim is not a claim, it is a file. Nothing was written."* Broken foreign chain: *"their chain breaks at line 214. Filing it would anchor my project to a record already inconsistent with itself."* Fork: *"this does not continue the bundle filed on 19 Sep at sha256:41ba22…. A friend's account may grow; it may not be replaced."* Never verified aloud: files under `nameSource:"unverified-label"` and the dossier prints the fingerprint, not the name — *"the name on this is a label you typed, not a proof."*

### The join on the pixels

The adopted clip gets a declared class. It cannot ride the bare `import` branch, which folds to `third-party-licensed` and would send a WAN-VACE clip out of this app labelled as not machine-generated:

```json
{"type":"import","actor":"user","asset":"mv/hex-appeal/s1_24/take3.mp4",
 "data":{"clip":"take3.mp4","segmentId":"s1_24","declared":"ai-generated",
   "model":"wan2.2-vace-14b-Q6","modelVersion":"vace-1.0","modelSource":"peer",
   "renderedBy":"peer:2f8a41c9e07b3d6a5c1e94b28d70f3ab:agent:plan",
   "attestedBy":"m0k3x9q2a1b2c3d4e5","srcEvent":"m0k2zz91ab…",
   "outputRights":{"class":"yours-with-conditions","capability":"video-wan-vace",
     "source":"https://…","stampedAt":"2026-09-20T13:41:02Z","stampedBy":"peer"},
   "note":"rendered on a lender's machine; the model and its licence are the lender's stamp, replayed verbatim"}}
```

`foldOrigin`'s `case "import"` reads `declared` for its three legal values and, when it is `"ai-generated"`, adopts `model`, `modelVersion` and `outputRights` onto the row. `outputRights` is replayed, never re-looked-up — `stampRights()` already preserves a caller-supplied stamp for exactly this case. `declared:"ai-generated"` with `model:null` is refused: *"a clip a machine made must name the machine. An import that claims AI origin and no model launders the lender's licence off the file."* `server/collab/credit_test.js` pins the resulting **marker sentence**, not only the fold — the defect this replaces was invisible at the fold and visible in the chip.

### The rollup

`foldCredit(events, {roster, ownerPeer})` in `server/credit.js` is a pure sibling of `foldOrigin`: events in, roll out, no clock, no files, roster passed as an argument. `rollFor()` does the IO. It adds no store, no write path and no retention, it recomputes uncached, and `credit_roll`/`credit_note` fall through `foldOrigin`'s `default: break` — one test pins that a stream folds identically with and without them. It ships **before** collab: with no peers the roster is `{local}` and the roll is a solo credit that is still true.

**It folds the project's own ledger and the filed claim files, and nothing else.** An MV project ledger holds `generate`/`regen` spend stamps, `judge`, `import`, `choice`, `delegate` and `plan_step`. `author_text`, `edit`, `record` and `licence_attach` live in the library or DAW scope under different asset keys, and `pick_take` in MV writes no event at all. There is no cross-ledger join here: joining a global forever-growing ledger on asset names that `import_asset` and `cascadeRename` already make unreliable, under one `verified` flag covering two chain heads, is a different week's work. What is not folded is **counted and named**, the same as everything else that misses the roll.

Roles, shipped in the payload like `FIT_STATES`, ordered permanently with direction above execution: `directed` (choice, delegate) → *Direction*, decisions; `decided` (judge) → *Machine decisions*, decisions; `lent` (peer `generate`) → *Cards lent*, shots; `rendered` (local `generate`/`regen`) → *Rendering*, shots; `supplied` (import, licence_attach) → *Material*, files; `thanks` (credit_note) → *Also*. Order within a role is first-contribution time, earliest first — never count, never rank. `n` is always distinct assets touched.

An agent line carries `under` — the `delegate` that authorised it — **or it is not in the roll**. And `under` resolves honestly: a `delegate` written by `agent:*` carries `relayed: true` precisely because the existing code refuses to name the human behind a relayed brief. `foldCredit` may not undo that refusal.

```json
{ "role": "decided", "heading": "Machine decisions",
  "by": { "peer": "2f8a41c9", "display": "Ana", "verified": true,
          "kind": "agent", "agent": "agent:plan" },
  "n": 34, "unit": "decisions",
  "under": { "delegate": "ev_8b6e28d5", "relayed": false,
             "by": { "peer": "local", "display": "Senzu", "kind": "person" } },
  "firstAt": "2026-09-14", "lastAt": "2026-09-15", "from": ["judge"] }
```

When `relayed` is true, `under.by` is `{ "kind": "agent", "agent": "agent:mcp", "relayed": true }` and the line reads *under a brief relayed by agent:mcp* — or it goes to `unattributed` like any other unauthorised agent work. A named person there would be an agent inventing a contributor.

### The exact wording of a credit line

```
<Heading> — <who>, <n> <unit>[, under <authority>][. (claimed: <n>; <landed> landed here)]
```

`<who>` is the peer's display name; an agent is possessive and never alone — `Ana's agent:plan`; an unverified peer keeps the credit and loses the unqualified name — `Ana (unverified · 2f8a41c9)`; an unknown fingerprint prints as `2f8a41c9`. Rendered:

```
Direction — Senzu, 41 decisions.
Machine decisions — Ana's agent:plan, 34 decisions, under Senzu's brief.
Cards lent — Ana, 34 shots. (claimed: 41; 34 landed here)
Material — Senzu, 6 files.
Also — Mariam K., by Senzu's hand: "Lent the room and the good mic, and talked us out of the first ending."

61 events in this ledger are not in this roll:
  agent:mcp — 44, no delegate in this ledger names the authority these ran under
  script:gate_run — 12, a harness has a name here and no standing in a roll
  system — 5, the ledger did not record who asked
1 line was hidden by the owner. It is in the ledger and in the local record.
248 events belong to this project's assets in the library ledger and are not joined here.
```

**`unattributed` and `omitted` print under the roll at the same type size as the roll**, on the tail cards and in the container line, not only retained in a sidecar that does not survive an upload. A credit system that prints its own negative space as loudly as its content is the only one whose numbers read as counts rather than verdicts. There is no `share`, no `percent`, no `rank`, by construction: a percentage would be a made-up number wearing a real one's clothes, and it is the number that starts the argument.

`agreement` — **34 of 41** — is the one figure that can catch inflation: of the runs a peer claims for this project, how many produced a clip that landed and named that attest. Two independent records, printed as a fraction and a sentence. It is an acknowledgement at export, not a refusal: *"Mara claims 41 renders; 34 clips in this project name them. Export anyway, or look at the seven first."*

There is **no signed credit event and no sign-off button.** The dossier already is the credit list: computed, two-column (*Witnessed here* / *Claimed by a friend*, never summed, never interleaved), never stored, and impossible to wave at anyone as proof. A signed list adds ceremony, not evidence, and emits a document people would read as a certificate.

### What the finished episode can honestly export

**A screen you can see is not a file you send.** The full roll is legible on the Finish panel. What leaves is minimised, per the same rule the broken-chain refusal already applies: *"the chain broke at line 412. Every number in this roll is a count of lines in that file. Look at it here; do not send it."* No `force`.

`hex-appeal_final.mp4.credits.json`:

```json
{
  "v": 1, "project": "mv/hex-appeal", "title": "Hex Appeal", "builtAt": "2026-09-20",
  "deliverable": { "file": "hex-appeal_final.mp4", "seconds": 211.4, "sha256": "sha256:4d7a19c0…" },
  "ledger": { "events": 1447, "chainHead": "sha256:9c1e77ab…", "verified": true },
  "roll": [
    { "role": "directed", "heading": "Direction",
      "by": { "peer": "local", "display": "Senzu", "kind": "person" },
      "n": 41, "unit": "decisions", "firstAt": "2026-09-12", "lastAt": "2026-09-15" },
    { "role": "decided", "heading": "Machine decisions",
      "by": { "peer": "2f8a41c9", "display": "Ana", "kind": "agent", "agent": "agent:plan",
              "consent": "named" },
      "n": 34, "unit": "decisions",
      "under": { "delegate": "ev_8b6e28d5", "relayed": false,
                 "by": { "peer": "local", "display": "Senzu", "kind": "person" } } },
    { "role": "lent", "heading": "Cards lent",
      "by": { "peer": "2f8a41c9", "display": "Ana", "kind": "person", "consent": "named" },
      "n": 34, "unit": "shots", "claimed": 41, "landed": 34 }
  ],
  "models": [ { "model": "wan2.2-vace-14b-Q6",
                "outputRights": { "class": "yours-with-conditions", "text": "…" } } ],
  "unattributed": { "events": 61, "byActor": [
      { "actor": "agent:mcp", "events": 44,
        "why": "no delegate in this ledger names the authority these ran under" },
      { "actor": "script:gate_run", "events": 12,
        "why": "a harness has a name here and no standing in a roll" },
      { "actor": "system", "events": 5, "why": "the ledger did not record who asked" } ] },
  "omitted": { "lines": 1, "note": "hidden by the owner; kept in the local record" },
  "elsewhere": { "events": 248, "scope": "library",
                 "why": "words, edits and takes are recorded under their own assets and are not joined here" },
  "withheld": ["peer.fingerprint.full","peer.card","peer.models","peer.gpuMinutes","timestamps.time"],
  "rollDigest": "sha256:e01b…",
  "tool": "AIPLAY Studio 0.9.14"
}
```

The export carries a **12-hex prefix, never the 128-bit fingerprint** — a full fingerprint is a permanent unrotatable join key, and two exports from two owners would rebuild the lending graph in public, which is the concentration the no-server design exists to avoid. A peer's display name appears only with that peer's standing `creditConsent` (`"named" | "fingerprint-only"`, default the latter). No `card`, no `models`, no `gpuMinutes` for a third party — a timestamped statement of who ran which weights where, made about someone who is not at the keyboard and cannot decline it. Timestamps are date-only. `withheld` names what was dropped, and `rollDigest` is computed over the **published** subset, so the redaction is itself on the record and nothing lies. `credit_roll` writes the same digest, the ledger head, and `withheld` to `mv/<slug>`, and `mv_render_video` — which today writes no ledger event at all — also appends an `export` and pushes to `doc.exports`, the field `server/mv/store.js:421` tests for and nothing writes.

`credit_note` refuses any actor but `"user"`, refuses a count, and caps text at 240 characters: *"a credit you typed is a claim, not a count. Giving a note a number would let a sentence outrank a record."* `web/credits.js`'s `PEOPLE` table is never merged with this — that credits the *program*; this credits a *project*, and joining them would put "Wrote AIPLAY Studio" in somebody's music video.

---

## THE CONTROLS, THE NUMBERS, THE TOOLS

| Thing | Page control | The number behind it | MCP tool |
|---|---|---|---|
| Capability card | Sharing: **Share my card** (off) + per-friend **Off · Coarse · Detailed**, with a live pretty-print of the exact bytes, a greyed un-clickable **Never leaves** column, and a **What they can infer** panel | `ttlSeconds` 900 (5–1440 min) and the live byte count of the card | `peer_card_preview({to})`, `peer_who_can({order})` — read-only, no write tool |
| Orders I accept | One switch per order id | `busy.queued`, `runningSince` | same |
| Dispatch check | **Verify weights before rendering**: `bytes` (default) or `digest` | check `ms`, `hashed`/`unhashed` count, recorded in every `capability_check` | `peer_capability_check({order})` — measures my own disk |
| Filed claims | Credit panel: **Show what my friends say they did** (on) | `agreement` — 34 of 41 | `credit_file(project, bundle)` → attest id or the refusal verbatim; `credit_read(project)` |
| Credit roll | Finish: **Roll on the end of the film** (on) + per-line **Hide** (owner only) | each line's `n` + unit; `unattributed.events`; `omitted.lines`; `elsewhere.events`; short `chainHead` | `mv_credits({slug, verify})`, `mv_credit_note({slug, role, display, text})`, `mv_render_video({credits:"roll"\|"metadata"\|"none"})` |
| Naming a friend in an export | Per-peer **Name them in exported credits** (off) | `withheld[]` length | none — this is a consent, and an agent may not give one |

No tool builds a card from agent-supplied values, no tool sets the sharing switch, and there is no `credit_sign`. The absences are the feature and the tool text says so.

---

## WHAT THIS STILL CANNOT DO

**A label proves who sent a sentence. It proves nothing about whether the sentence is true.** `peer:2f8a41c9…:user` certifies that Mara's key signed that line. It cannot certify that the `choice` events in it were a hand on a mouse rather than her agent making a loopback call with no `x-aiplay-actor` header — which is trivially done, on her machine, by her, today. The masquerade guard works because *the browser never sets the header*; that is a fact about one machine's own traffic and it does not survive the trip. Every cross-machine credit line is testimony. That is why `who === "user"` stays untouched and a peer promotes nothing, ever — and the price is real: a friend who genuinely did the human work gets no credit in the origin class, only in the dossier, as a claim. That is the true state of the world being displayed instead of hidden. It cuts both ways: my chain is unsigned, local and rewritable, so from Mara's side my contributions are exactly as unproven as hers are from mine. Two accounts, fixed in time, attributable to a key, holdable against each other. That is all this buys, and it is still far better than one merged number that quietly averages a lie into the truth.

**When a friend lies, none of this catches them.** A peer who patches `assertCapability()` advertises anything they like; the digest proves sizes, not weights. What the design actually buys is that an *honest mistake* — a moved file, a half-finished download, a card from last Tuesday — costs forty milliseconds instead of four thousand seconds, and that every render which did happen can name the measurement that permitted it. Do not draw a padlock on the Sharing screen.

**Coarsening protects you only from the friends who never send you anything.** The card says `mv.clip`. The first clip that comes back carries an `import` naming `wan2.2-vace-14b-Q6`, because a `model: null` import launders the lender's model and licence off the file — that event exists for that reason. So the first order a friend accepts publishes, permanently and in *their* ledger rather than yours, the exact fact the band and the order id were shaped to withhold; and for a territory-limited model, the claim about where its owner lives travels with it. Worse: **refusing is also an answer.** Accept/refuse is a one-bit oracle over your shelves and cannot be closed without lying, which the ledger forbids everywhere else. Against a friend you actually render for, coarsening buys the *timing* of the disclosure and nothing else — they learn it when you choose to say yes, not when they choose to look. That is a real thing to own and much smaller than the screen would otherwise imply; a privacy control that oversells itself is the reason someone shares a card they would have thought twice about.

**When most of the work was done by agents, this roll will say so, and sometimes that is a slander of the person who did the hardest work.** Counts are counts of ledger events, and events are what machines produce in bulk. The person who chose the song, wrote the treatment and spent two days on the ending leaves forty-one `choice` lines; the agent that ran the plan leaves thirty-four `judge` lines and a lender's card leaves thirty-four `generate` lines — and the eye reads the big number. We do not fix that with weights, because a weight is a fiction and we already refuse fictions. We fix it by putting Direction permanently above execution, by letting a person write one sentence the ledger could never have seen, and by printing above the numbers, in the panel's own words: **these count events, not effort.**

**A credit names a peer, which is a machine's owner, not the hand on the keyboard.** If Ben spends an afternoon at Ana's Studio, this roll says Ana, and nothing in the design can tell the difference. And the roll is silent about the words, the edits and the takes, which live in another ledger under other asset keys — it says so, with the number, rather than implying it counted them.

Above every export button sits the ledger's own sentence, unsoftened: **this is a studio notebook, not a certificate.**
