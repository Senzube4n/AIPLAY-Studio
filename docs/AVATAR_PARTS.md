# Local avatar parts: fitting and weight transfer

Studio can fit a compatible unrigged GLB part to a selected avatar, preview the
prepared result, then import it into that avatar's wardrobe. The advanced
weight-transfer operation also supports an **already aligned attachment** using
an existing weighted base. Both copy interpolated weights from nearby triangles.
They do not generate a body, invent a skeleton, repair fused legs, create facial
expressions, retopologize hair, or add spring physics. The output remains a local
GLB requiring visual review before admission to a compatible part library.

A useful local sequence is: prepare body/head/hair/outfit geometry separately,
align them in the same rest pose and metre scale, establish a good weighted body,
then bind close-fitting parts. Long hair, skirts and loose accessories usually
need their own authored joints and weights. Transferring body weights to hair
will make it follow the body; it does not give it independent movement.

## Requirements

Use a Python interpreter with Blender's `bpy` package. The measured local runtime
is Python 3.11.9 with bpy 4.2.0. No GPU, neural checkpoint, external service or
download is needed. NVIDIA, AMD, Intel and CPU machines use the same CPU BVH path.

The service selects `AIPLAY_AVATAR_PYTHON`, then the configured UniRig Python,
then the configured image-to-3D Python, using the first existing interpreter.
An interpreter existing does not prove it contains bpy: **Inspect** imports the
runtime and checks the actual weighted base. An explicit environment override is
never silently replaced. Restart Studio after changing the environment variable.
There is no automatic package installation or mutation of an existing Python
environment.

The helper scripts import `bpy`: `weight_transfer.py` directly, and the fitter
`attachment_fit.py` through `weight_transfer`. By the Blender Foundation's
stated position that makes them derivative works of Blender, and this repository
is Apache-2.0, so it ships no copy of either script or of their test suites,
`weight_transfer_test.py` and `attachment_fit_test.py`. All four live, under
GPL-3.0-or-later, in the GPL Blender toolkit
[AIPLAY-previz-blender](https://github.com/Senzube4n/AIPLAY-previz-blender), in
its `previz/` folder beside the deformation cross-check's `deform.py`. That
repository is not public yet: until it is, the link opens only for people it
has been shared with, and the 503 sentence below says so too
(`PREVIZ_TOOLKIT_PUBLIC` in `server/mesh/previz-toolkit.js`; a test keeps this
paragraph and that flag in step). Keep the four together: the fitter imports
`weight_transfer`, and its suite loads `weight_transfer_test.py` from its own
folder.

Point Studio at them in one of three ways:

- **Clone the toolkit into `vendor/previz-blender` in the Studio folder.** With
  nothing set, Studio looks beside the toolkit's `cli.py`, which defaults to
  `vendor/previz-blender/previz/cli.py`, so the clone is found as it is. From a
  ZIP instead of `git clone`, unpack it so that this `previz/cli.py` exists (a
  GitHub ZIP adds one folder level). The previz blockouts use the same clone,
  and both a Setup.exe reinstall and the launcher's Update keep the folder.
- **Clone it anywhere and set `AIPLAY_PREVIZ`** to the clone's
  `previz/cli.py`. Studio then looks in that `previz/` folder.
- **Set `AIPLAY_WEIGHT_TRANSFER_SCRIPT`** to a `weight_transfer.py`. The fitter
  is looked for beside it, or at `AIPLAY_ATTACHMENT_FIT_SCRIPT`.

A set variable wins over any clone, so a variable left pointing at a missing
file must be fixed or unset; the 503 sentence then names that variable and
offers nothing else. With none of these, Studio also tries
`<rig>/blender-toolkit/`. Restart Studio after changing an environment variable.
Studio spawns both scripts with the transfer script's folder and `server/mesh`
on `PYTHONPATH`, so the fitter loads that same `weight_transfer` and both can
import `unirig_adapter`, a stdlib-only helper that stays in this tree. Without a
script, the panel's status reads "Setup needed", and Inspect and Submit return a
503 sentence, before anything is written or recorded, that names the toolkit's
address, the script's `previz/` path and the one remedy that would take effect:
the variable that decided the path when one is set, otherwise the clone folder
Studio looks in, `AIPLAY_PREVIZ` and the script's own variable. The status tools
(`avatar_weight_transfer_status`, `avatar_fitting_status`) return the same
sentence. Nothing is downloaded.

To run the scripts' own suites (11 and 5 tests), use the same Blender Python with
the toolkit's `previz/` folder and this repository's `server/mesh` on
`PYTHONPATH`; the toolkit README has the command lines. The pre-commit hook runs
both through the same resolvers and prints UNRUN, never a pass, when a script,
its suite or the interpreter is missing.

## Fit, preview, import

Choose an avatar, upload an unrigged self-contained GLB part, and inspect it.
Select the corresponding reference surface by its material name: a shirt should
use a matching shirt/body region, rather than the entire avatar. **Bounds** finds
a uniform scale and aligns bounding-box centres. **Keep** uses the existing
placement. Neither mode rotates the target or infers anatomical correspondence.
Both need compatible, already oriented geometry in the same rest pose.

Surface fitting projects vertices to the nearest reference triangle plus an
outward clearance along its interpolated normal. This supports close-fitting
parts with corresponding shapes, not arbitrary garment reconstruction.

| Setting | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `clearance` | 0.006 m | 0–0.03 m | Outward distance from the selected surface |
| `max_displacement` | 0.1 m | 0.001–0.2 m | Maximum per-vertex correction **after** global alignment |
| `max_scale_change` | 2 | 1–3 | Factor; 2 permits uniform scale 0.5–2 |

Every vertex must satisfy the displacement limit. A collapsed/reversed triangle,
extreme area change, or orientation disagreement refuses the whole operation.
These checks do not detect every possible intersection. Fitting changes positions
and normals and removes stale tangents so viewers can derive their tangent frame.
UV/colour attributes, used material settings and embedded texture bytes remain
unchanged. Unused resources are removed from the prepared part.

Fit completion is a prepared preview. Importing into the wardrobe and selecting
the part for a look remain explicit actions. Review rest alignment, shoulder/hip
bends, twisting, clipping and all intended motions before use.

`POST /api/avatar-fitting` uses these actions:

| Action | Fields | Result |
| --- | --- | --- |
| `status` | None | Interpreter, defaults, limits and running state |
| `inspect` | `avatar_id`; optional one of `target_data_base64`, `target_path` | Source/target hashes, immutable `target_id`, `skeleton`, named `reference_surfaces` and bounds |
| `submit` | Avatar id and `source_sha256`, target id and `target_sha256`, `expected_skeleton`, `reference_mesh_node`, `reference_primitive`, all four fitting settings, `name`, `source`, `license` | Job `id`, initially `running` |
| `get` | Job `id` | `running`, `complete`, `failed` or `interrupted` |

The four settings are `alignment`, `clearance`, `max_displacement` and
`max_scale_change`. Source surfaces are identified by the returned mesh-node and
primitive pair. Inspection snapshots uploaded bytes. Submission verifies both
hashes, uses the selected imported avatar, and never rereads a user-selected path.
The fitting API accepts 64 MiB files. Targets must use embedded resources; paths
must be absolute local GLB paths and uploads must be canonical base64.

Tools `avatar_fitting_status`, `avatar_fitting_inspect`, `avatar_fitting_submit`
and `avatar_fitting_get` use the same HTTP actions. MCP inspection accepts a local
path; the UI uses uploads. A completed job returns `result.output`,
`result.files.glb` (controlled preview URL), `vertices`, `joints`, `fit`, output
`sha256` and validation counts. After review, pass that output path to
`avatar_wardrobe_import` and select the part for the desired look.

The routes independently enforce Studio's loopback Host/port and same origin.
Each job snapshots inputs, checks hashes, records delegate/edit provenance, and
spawns Python without a shell, with a five-minute timeout and a one-MiB log cap.
One fitting job runs at a time. The job receipt, skin data, output provenance and
Khronos validation must pass before completion. Polling and preview fetches
recheck output hashes. Interrupted jobs are not silently retried. Input files are
untouched; no live persona/account binding is granted.

## Shared inputs and explicit weight-transfer limits

- One self-contained GLB/VRM weighted base with unique raw joint names, explicit
  inverse binds and a default scene containing the complete skeleton. Multiple
  skins use a canonical union of their joints. The chosen source surface is
  sampled in its actual default skin pose. If vertices move more than 5 mm from
  the raw exported rest coordinates, the source is refused as a posed mesh.
- One unrigged GLB attachment with one mesh node. Multiple material primitives
  are supported; join separate attachment objects before using this first
  version. UVs, vertex attributes, embedded texture bytes and material settings
  remain unchanged in explicit transfer. Fitting updates positions/normals as
  described above.
- Explicit 16-number, column-major glTF alignment matrix. Coordinates use +Y up
  and metres. The transform places the target into the reference's world space;
  it includes the target's existing node transforms. This advanced operation
  does not automatically fit; use the separate fitting workflow for that.
- Explicit maximum surface distance, greater than zero and at most one metre.
  **Every vertex** must meet the limit. One unmatched vertex rejects the entire
  transfer. A small distance does not prove the nearest surface is anatomically
  correct, especially between legs, fingers, overlapping clothes or folded arms.
- At most 128 MiB per input/output, 200,000 total vertices per input, 400,000
  triangles per input, 2,048 hierarchy nodes and 256 joints. These preparation
  limits do not grant admission to the stricter world-avatar profile.
  World-space geometry must remain finite and within 100 km of the origin to
  avoid overflowing Blender's geometry calculations.
- Triangle meshes only; compressed geometry, morph targets, animated targets and
  target scene/node extensions require a separate preparation step. Supported
  material extensions remain embedded. External resources are never loaded.

The nearest triangle supplies barycentric interpolation, rather than the nearest
vertex's complete weights. At most four influences are retained and normalized.
If this would discard more than 10% of a vertex's interpolated weight, the whole
operation is refused. Degenerate reference triangles are refused.

All reference skin joints and their ancestor hierarchy are retained, including
joints unused by the attachment. The helper does not substitute a root bone.
Inverse bind matrices are calculated for the aligned target's rest transform.
The skeleton fingerprint covers joint ordering, names, parents and rest matrices,
independent of unrelated GLB node indices. Only that exact base is accepted after
inspection; similar bone names do not establish compatibility.

`extras.aiplayWeightTransfer` records the exact reference hash and
`baseJointNodes` in output skin-slot order. Raw names and world rest transforms
are retained. VRM node constraints are not duplicated in the output. Wardrobe
checks its mapping against the exact source, then binds to the avatar's original
bones so the avatar remains the single owner of constraints, springs and motion.

## Advanced weight-transfer UI, API and MCP

The advanced local 3D workshop can use `POST /api/avatar-weight-transfer`:

| Action | Required fields | Result |
| --- | --- | --- |
| `status` | None | Configured interpreter, limits and running state |
| `inspect` | `reference_path`; optional `target_path` | `skeleton`, `reference_sha256`, optional `target_sha256`, joint names |
| `submit` | Both paths and hashes, `expected_skeleton`, `transform`, `max_distance`, `name`, `source`, `license` | Unique job `id`, initial `running` state |
| `get` | `id` | `running`, `complete`, `failed` or `interrupted` |

Paths must be absolute and local. This endpoint requires Studio's loopback Host,
port and same-origin requests. The service also accepts `reference_bytes` and
`target_bytes` Buffers for a future upload handler; the current JSON endpoint
does not accept raw/base64 uploads.

Equivalent tools are `avatar_weight_transfer_status`,
`avatar_weight_transfer_inspect`, `avatar_weight_transfer_submit` and
`avatar_weight_transfer_get`. MCP uses the same HTTP path and actor provenance.
Caller-supplied actors are not accepted in request bodies.

Each transfer snapshots both inputs in a unique job directory, verifies the
inspected hashes, records a `delegate` event, and runs Python with bounded argv,
no shell, a five-minute timeout and a one-MiB log limit. Only one transfer runs at
a time. Successful output must pass binary skin checks and the Khronos glTF
validator before an `edit` event is recorded. Completion stores an output hash;
polling revalidates it. A restart never silently retries an interrupted job.
Original input files are never changed. The result is not installed or attached
to an avatar automatically, and no live persona/account binding is granted.

## Export a saved outfit

Save the appearance and wardrobe selection, then choose **Export outfit** in
the wardrobe panel. **Download outfit** produces one `.aiplay-avatar.json`
package containing the composed VRM, saved appearance and declared part credits.
**Download VRM** provides the composed model separately. Export does not activate
the saved look or modify the original avatar or part files.

The composer appends admitted part geometry, materials and embedded textures to
the VRM and binds it to the original joints. Original VRM expressions, springs,
constraints and binary resources remain intact. Appearance settings are stored
separately in the package; they are not baked into the VRM. Up to eight compatible
parts and 64 MiB of combined model data are supported. This operation creates no
new rig, facial expressions or hair physics.

`avatar_outfit_export` uses the same handler as `POST /api/avatars/handoff` with
`action: "prepare"`, `id`, `sha256`, `look_id`, `expected_look_revision` and
`expected_wardrobe_revision`. Use `avatar_outfit_get` with `export_id` to read its
immutable receipt and download locations. Revision checks refuse a changed or
unsaved selection. Downloads are loopback-only and checked against stored hashes.

The World importer has narrower admission rules: currently it accepts only an
append-only outfit based on the reviewed VRM Consortium sample, up to 16 MiB.
World verifies the original model and added resources independently. Part credits
are uploader declarations, not verified license grants. Import selects the asset
and look for review; binding it to a persona is a separate action. A successful
Studio export alone does not establish World admission or multiplayer acceptance.

## Direct CLI

Run the script from the toolkit clone's `previz/` folder (or wherever
`AIPLAY_WEIGHT_TRANSFER_SCRIPT` points), with this repository's `server/mesh`
folder on `PYTHONPATH`. First inspect the selected base:

```text
python /absolute/previz-blender/previz/weight_transfer.py --inspect-reference /absolute/base.glb
```

The explicit helper also supports `--reference-mesh-node` and
`--reference-primitive`. The fitting helper accepts:

```text
python /absolute/previz-blender/previz/attachment_fit.py --reference /absolute/base.vrm --target /absolute/outfit.glb --inspect
python /absolute/previz-blender/previz/attachment_fit.py --reference /absolute/base.vrm --target /absolute/outfit.glb --output /absolute/fitted.glb --options '{"expected_skeleton":"HASH","reference_mesh_node":0,"reference_primitive":3,"alignment":"bounds","clearance":0.006,"max_displacement":0.1,"max_scale_change":2}'
```

Its result marker is `AVATAR_FITTING_RESULT_JSON:`; refusals return exit code 2
and preserve an existing output. Use the service for persistence and byte pins.

Then use its `skeleton` value and the deliberately chosen alignment:

```text
python /absolute/previz-blender/previz/weight_transfer.py --reference /absolute/base.glb --target /absolute/outfit.glb --output /absolute/prepared-outfit.glb --expected-skeleton SHA256_FROM_INSPECTION --transform "[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]" --max-distance 0.02 --mode nearest-surface
```

On Windows, invoke the selected Python with the PowerShell call operator `&`.
Successful CLI output ends with `WEIGHT_TRANSFER_RESULT_JSON:` and JSON. Refusal
returns `ok:false` and exit code 2, preserving any previous output. The direct
CLI protects the skeleton and output paths; use the service when byte-hash pins,
job persistence and the Studio provenance ledger are required.

## Measured verification and remaining quality work

The real `VRM1_Constraint_Twist_Sample` has three skins and a 154-joint union.
Its original shirt supplied a local-only fixture: weights removed, uniform scale
changed to 1.12 and translation offset applied. Fitting recovered scale
0.8928572, applied 6 mm clearance, and produced 717 vertices / 1,210 triangles.
Maximum surface correction was 6.041 mm. Used texture bytes and the original
sample attribution were retained. This is a sample-derived garment, not evidence
of arbitrary generated outfit quality.

Real MCP stdio calls against Studio completed inspection, submit/poll, preview
download, wardrobe import and selection for a dedicated acceptance look. The CPU
helper took 1.328 seconds; the validated job completed in 1.736 seconds on the
tested machine. Output was 289,140 bytes, one 2 MP texture, 154 joints, zero
Khronos errors and one warning. Wardrobe checked the exact source mapping, rest
transforms and inverse binds.

Blender 4.2 imported the fitted shirt and rebound it to the original avatar
armature. Rotating its left shoulder by 0.55 radians moved 197 shirt vertices
over 1 mm, maximum 0.1663 m. Rest/posed renders showed the shoulder following
without gross separation in that pose. Plain glTF import does not evaluate VRM
node constraints; this check poses a directly weighted parent chain. The Studio
VRM runtime evaluates the full source constraint/spring system.

Run `node server/mesh/avatar-fitting_test.js` for service/API/MCP checks and the
configured bpy Python on `attachment_fit_test.py`, beside the script outside
this repository and with the same `PYTHONPATH`, for geometry, refusal limits,
reversed orientation, resource compaction and actual imported deformation. The
test explicitly skips when bpy is unavailable, and the pre-commit gate prints
UNRUN, never a pass, when the script, the suite or a Blender Python is missing.

The Python suite includes a weighted planar base and a UV/textured attachment,
both with non-identity scene transforms. The attachment sits 0.02 m above the
base after explicit alignment. All four vertices receive the expected continuous
0.25/0.75 weight mixtures; the complete hierarchy retains an unused hair joint.
Blender 4.2 imports the result at zero measured rest-coordinate error. Rotating
the non-root joint moves all four vertices, up to approximately 0.111 m. This is
a geometry regression fixture, not evidence of finished anime-character quality.

The production Node-to-Python run also completed with zero Khronos errors;
skinned-node transform warnings remain visible in its result. Materials, texture
bytes, UV accessors and source-file hashes are checked by regression tests.

Run `node server/mesh/avatar-weight-transfer_test.js` for service, process,
provenance and HTTP checks. Run the configured Blender Python on
`weight_transfer_test.py -v`, beside the script outside this repository, for
geometry and actual imported-pose checks. Without bpy the optional Python
geometry suite reports an explicit skip. The pre-commit gate finds that suite
through the same `AIPLAY_WEIGHT_TRANSFER_SCRIPT` resolver and prints UNRUN, never
a pass, when the script, the suite or a Blender Python is missing.
The real import/deformation test uses a disposable subprocess; on Windows it
flushes its result and terminates that worker explicitly because the bpy 4.2
wheel reports an erroneous nonzero status during glTF-addon finalization.
Assertion failures still fail the parent test. Production transfer does not use
that workaround and exits normally.

Before using a prepared part, inspect rest alignment, shoulder/hip bends,
twisting limbs, clipping and all intended motions. A matched fingerprint and
100% weight coverage do not certify appearance, topology, facial animation,
collision, mobile performance or hair physics. Existing VRM springs remain a
separate authored system. UniMate is not invoked by this operation.
