# Local avatar parts and weight transfer

Studio can prepare an **already aligned attachment** using an existing weighted
base. The operation copies interpolated weights from nearby reference triangles;
it does not generate a body, invent a skeleton, repair fused legs, create facial
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

## Inputs and limits

- One self-contained GLB weighted base with exactly one skin, unique joint
  names, explicit inverse bind matrices and a default scene containing the full
  skeleton. Default transforms must represent its bind rest pose.
- One unrigged GLB attachment with one mesh node. Multiple material primitives
  are supported; join separate attachment objects before using this first
  version. UVs, vertex attributes, embedded texture bytes and material settings
  remain unchanged.
- Explicit 16-number, column-major glTF alignment matrix. Coordinates use +Y up
  and metres. The transform places the target into the reference's world space;
  it includes the target's existing node transforms. There is no automatic fit.
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

All reference joint nodes and their ancestor hierarchy are retained, including
joints unused by the attachment. The helper does not substitute a root bone.
Inverse bind matrices are calculated for the aligned target's rest transform.
The skeleton fingerprint covers joint ordering, names, parents and rest matrices,
independent of unrelated GLB node indices. Only that exact base is accepted after
inspection; similar bone names do not establish compatibility.

## UI, API and MCP

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

## Direct CLI

First inspect the selected base:

```text
python server/mesh/weight_transfer.py --inspect-reference /absolute/base.glb
```

Then use its `skeleton` value and the deliberately chosen alignment:

```text
python server/mesh/weight_transfer.py --reference /absolute/base.glb --target /absolute/outfit.glb --output /absolute/prepared-outfit.glb --expected-skeleton SHA256_FROM_INSPECTION --transform "[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]" --max-distance 0.02 --mode nearest-surface
```

On Windows, invoke the selected Python with the PowerShell call operator `&`.
Successful CLI output ends with `WEIGHT_TRANSFER_RESULT_JSON:` and JSON. Refusal
returns `ok:false` and exit code 2, preserving any previous output. The direct
CLI protects the skeleton and output paths; use the service when byte-hash pins,
job persistence and the Studio provenance ledger are required.

## Measured verification and remaining quality work

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
`server/mesh/weight_transfer_test.py -v` for geometry and actual imported-pose
checks. Without bpy the optional Python geometry suite reports an explicit skip.
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
