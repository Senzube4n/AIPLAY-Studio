# Project direction and working agreement

This is a reusable starting template. Replace every bracketed field. Keep it beside the project's planning files. It is a human-readable project brief, not an executable Studio configuration.

Community template updated 25 October 2026. Examples reflect Studio source `e95d81f`; always check the connected installation before applying a recipe.

## Read this first

Read this file before changing this project. Then read the application's current `AGENTS.md`, `DIRECTING.md`, and relevant workflow documentation. In Codex, add a short instruction to `AGENTS.md` to read this file; in Claude Code, add it to `CLAUDE.md`. Do not assume a file called `directors.md` is discovered automatically.

Use the connected Studio's live tool catalogue and readiness reports. Ask `studio_capabilities` with `showcase:false`, `studio_screen_info` for the intended screen, and `pipeline_guide` for the relevant topic. Read a tool's current schema before calling it. Do not guess parameter names, model availability, timings or memory limits.

## The project

- Working title: [title]
- Format: [music video / short film / episode / other]
- Intended audience and release destination: [audience, platform, aspect ratio]
- Creative purpose in one sentence: [what the viewer should feel or understand]
- Runtime target: [target; distinguish an editorial goal from a model guarantee]
- Current Studio project slug: [returned project slug]
- Current phase: [brief / song / boards / clips / cut / delivery]
- Owner and decision maker: [role or name]

## Creative brief

- Logline: [one sentence]
- Narrative shape: [beginning, turn, ending]
- Medium and visual style: [specific materials, photography or animation approach]
- Tone: [two or three useful words]
- Colour, light and contrast: [repeatable description]
- Music: [approved song filename or placeholder; owned/licensed sources only]
- Dialogue and sound: [requirements, delivery, quiet moments]
- Avoid: [unwanted motifs, framing, text, content or production choices]
- References: [owned/licensed reference files, their purpose, and permission to use]

## Agreed scope and spending

- Current task authorized by the human: [concrete task]
- Local GPU work authorized: [none / exact pilot / scene list and take limit]
- Model/runtime downloads authorized: [none / exact items and maximum size]
- Training authorized: [none / dataset, target, recipe and step limit]
- Paid provider work authorized: [none / provider, amount and approved runs]
- Sharing/publication authorized: [none / destination and approved assets]
- Stop condition: [what counts as a reviewable result]

Honor authorization already given. Continue routine reversible work inside it. Before an unapproved expensive action, finish the free planning and present a concrete proposal with engine, inputs, take count, expected download/cost if known, and reason. Do not request the same approval repeatedly. Do not invent an ETA from another machine's benchmark.

Do not install or upgrade dependencies, change the selected engine, restart Studio, overwrite a finished edit, or publish/send files unless the current scope authorizes that action. Keep keys, tokens, private paths and unrelated user media out of shared plans, screenshots and prompts.

## Installation and connection record

- Operating system and CPU architecture: [Windows / Linux / macOS; x64 / ARM64]
- Installed Studio build and installer release: [actual build and release]
- Engine/runtime and GPU: [actual versions, device and readiness]
- Model files already available: [exact component/adapter filenames]
- MCP connection: [copy the connected Studio's Agent screen configuration; keep private paths out of shared copies]

Use the current official installer for the platform. Linux and macOS installers include a private Node/npm runtime; do not assume `node` is available on the system PATH. Copy both `command` and `args` from Studio's Agent > MCP server card. Engine/model installation is a separate first-run step. A successful installer test does not certify GPU generation on every platform. Native YuE2 GGUF automatic runtime installation currently targets Windows x64; check supported alternatives on Linux/macOS.

The Windows installer is unsigned; the macOS app is ad-hoc signed, without Developer ID signing or notarization. Keep antivirus and operating-system protections enabled. Record an actual blocked file/command and obtain the supported repair path instead of advising broad exclusions. On Windows, Battery Safe's stop-on-battery reader now requires an explicit opt-in; do not assume this removes every use of PowerShell.

## Current H3 and picture recipes

For a beginner's MiniMax H3 reference pilot, keep Model file, Text encoder, Video VAE and Audio VAE on `auto`. Check Models readiness first and record which files the actual run selected. With reference images and 8 steps, Studio prefers the installed REF2V Turbo v1.1 adapter, falling back to v1.0; the 4-step reference recipe uses its separate v0.1 adapter. Do not add the automatically selected Turbo adapter again as a custom LoRA. Record resolution, native frame count, seed, reference order, shifts, sampler and adapter strength for comparisons.

The local matched v1.1/v1.0 test saved about 5.3% render time on one RTX 4070 Ti SUPER setup; it also changed sampled action and background adherence. Sampled still progression does not establish smooth motion or audio quality. Treat this as one measured comparison, not a universal speed, quality or lip-sync guarantee. Run an authorized short pilot before a full project.

MOSS-Image is an experimental text-to-image route. Start with Standard, one 1024-square image, then compare one preset at a time using the same prompt, seed and dimensions. Keep Qwen for the shipped reference-image/editing route: the MOSS multi-reference/edit prototype is not a shipped capability. Do not infer editing support from a text-to-image model name.

Record the exact MOSS recipe and its own files: Standard 25 steps/CFG 2.5; Spectrum H1/H2 requires its separate setup; Turbo 4 and DMD 8 use distinct adapters at CFG 1; Kromoss needs its own checkpoint and its DMD2 8-step option uses its own adapter. CFG-1 recipes reject negative prompts. MOSS HiRes (4 MP) is a direct 2048-square generation preset, not an upscaler; check adapter terms. NSFW Uncensored is an optional explicit preset, not the default; its recipe is 30 steps/CFG 3, adapter strength 0.7 and the `moss_xvstyle` trigger. Choose content appropriate to the project's audience and destination. Do not stack arbitrary adapters or assume every recipe fits the available VRAM.

## Continuity bible

Keep the same exact names in this file and the Studio bible. Use `mv_bible_spec` before authoring the first bible, then `mv_set_bible`. A planning file alone does not update Studio.

### Characters

For each character record:

- Exact name: [name]
- Role and motivation: [brief]
- Face and silhouette: [stable visible traits]
- Body, wardrobe and accessories: [stable traits]
- Approved reference files and roles: [identity / body / side / outfit / detail]
- Continuity constraints: [what must remain consistent]
- Current chosen take: [returned asset/take identifier]

### Locations, props and recurring motifs

- Exact name: [name]
- Description and scale: [geometry, material, light]
- Approved reference and intended purpose: [file, or explicitly words only]
- Recurs in: [scene/episode IDs]

Use a tight, single-panel identity reference where possible. A reference can influence pose, framing and background as well as identity. Do not call it a guaranteed identity lock. Review all boards together for duplicate people, wardrobe drift and inconsistent geography.

## Shot contract

For each scene keep:

| Field | Direction |
|---|---|
| Scene ID and exact time range | [returned ID; start/end on the approved timeline] |
| Purpose | [what changes for the audience] |
| Visible subject and count | [who/what is on screen] |
| Action | [one clear action] |
| Camera and framing | [one camera idea; face large enough for the emotional beat] |
| Geometry | [positions, eyelines, screen direction, reachable objects] |
| Cast, prop and background references | [exact declared names; intentional role for each] |
| Engine and readiness | [selected supported route; current hardware/licence check] |
| Audio | [song range, narration, dialogue, effects, or silence] |
| Acceptance check | [observable criterion, including motion] |
| Selected take and receipt | [IDs or filenames returned by Studio] |

Write one subject, one action and one camera idea per shot. Make the geometry physically coherent. Use close framing for facial detail. Treat storyboard pictures as planning evidence unless the chosen engine actually receives them. Read the current graph/receipt instead of assuming all engines use references the same way.

## Work loop

1. Read the existing project, current selections, run history and timeline before starting. Resume the saved state.
2. Write the brief, bible and boards. Use `mv_lint` and `mv_crime_board` before generation. Resolve missing names, absent boards and stale references.
3. Check measured beats against the song by ear. Cut around musical phrases and visual intention; do not assume each lyric line needs a cut.
4. Propose or render one authorized representative pilot. Review real playback with sound, including the first and last seconds. A thumbnail cannot prove motion, sync or continuity.
5. Keep good takes. Change one variable at a time when diagnosing failure. Record both the failure and the evidence for a change. A successful render is not automatically a successful shot.
6. After a chosen face or board changes, inspect stale dependencies. Use `mv_regen_stale` as a dry run before any paid/GPU run. Repair the minimum.
7. Use ordinary editing or VFX for titles, credits, grades, transitions and compositing. Use new generation when the photography, subject or action must change.
8. Before `mv_build_timeline` or the UI's rebuild action, preserve the current edit under another name if needed. Rebuild can replace timeline edits.
9. Watch and listen to the exported file itself. Confirm duration, framing, sound, cuts, titles and ending. Record the result honestly.

Poll saved run IDs. After an uncertain response, read status/history before starting again. Do not duplicate renders or training by retrying blindly. Keep the Studio queue's ownership and safety checks intact; use its public tools instead of bypassing them with raw engine requests.

## Song and adapter experiments

- Baseline recipe: [engine, checkpoint, exact lyrics/style, seed and settings]
- Adapter experiment: [target engine, adapter filename, slot(s), strength]
- Training sources: [rights reviewed, source IDs, region/dataset fingerprint]
- Held-out evaluation: [a different song/prompt/recording from training]
- Listening criteria: [desired change; unwanted effects; ending and intelligibility]

Native GGUF generation, the Training screen's single-recording Audio LoRA, and Music Lab's native dataset trainer are separate capabilities. Do not apply an exported adapter to another engine without an explicit compatible route. A loss curve or exported checkpoint does not prove audible improvement. Match comparison settings, record the strength and listen to held-out examples.

## Series and episode handoff

- Shared series bible revision: [revision/date]
- Episode project: [one project per episode]
- Canonical cast/prop/location assets: [approved files]
- Changes introduced in this episode: [facts that later episodes inherit]
- Previous episode's final state: [wardrobe, geography, time, unresolved story]

Studio projects do not automatically share one cast store. Carry the same bible names and import the approved reference files into each episode. Preserve the actual chosen images; matching prose alone does not preserve a face.

## Review and delivery

- Required output: [format, size, aspect, frame rate, audio specification]
- Review checkpoint: [who decides and which file they review]
- Credits and model/source notices: [required attribution, music/reference permissions]
- Public-safe assets: [explicit filenames approved for screenshots/sharing]
- Delivery location: [project-relative folder or private destination kept out of public copies]
- Version label: [project revision plus Studio build line]

Do not report a plan as completed work. Report what was actually rendered/exported, what was checked, and what remains uncertain. Keep the latest handoff below short enough for a new agent to use.

## Handoff log

- Date and agent:
- Human request and accepted constraints:
- What changed:
- Files/project/run IDs:
- What was actually watched/listened to:
- Evidence and unresolved issues:
- Next useful action:
- Authorization still available:
