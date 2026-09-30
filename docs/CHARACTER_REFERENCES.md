# Named reference packs

A character, background or prop can hold up to six single reference images under
its existing name. Roles are `identity`, `body`, `side`, `outfit`, `style` and
`detail`, with one image per role. Use tight single views rather than contact
sheets. The normal `imageFile` stays the default identity image on older projects.

Open **Reference pack** on the existing asset card to assign saved takes, add a
picture through Library or Upload, or remove extra roles. The board editor and
shot inspector offer those roles beside the named asset. Unselected names remain
outside the scene; an enabled name with no explicit role selection uses identity
(or its first available pack image when identity is absent).

The existing MCP tools use the same actions:

```json
{"tool":"mv_import_asset","args":{"slug":"my-video","target":"character","id":"Mara","path":"C:\\pictures\\mara-side.png","referenceRole":"side"}}
{"tool":"mv_set_shot","args":{"slug":"my-video","segment":"s1","refs":["Mara"],"refRoles":{"Mara":["identity","side"]}}}
```

`mv_update_asset.referenceImages` replaces the extra pack using project asset
filenames, for example `[{"file":"char_abc.png","role":"body"}]`. An empty array
clears extra images and leaves the adopted `imageFile`. `mv_set_board` and
`mv_set_bible` accept typed `refRoles` on boards. Omitting that field preserves
existing role choices for names still referenced; `{}` resets those choices.

Images retain the asset's prominence. Within each asset the order is identity,
body, side, outfit, style, detail. H3's existing nine-picture limit applies to
images, and lower prominence images are reported as dropped. Picture numbers
are assigned after selection and capping, so the prompt legend and actual staged
files agree. Multiple views keep one cast name and one subject.

Single-still boards use the same role selection at their existing ten-image
limit. The existing sequence-board draw behavior stays in its measured path.
LTX has no named-reference input, so its shot record continues to report resolved
pictures as unsent. Pack and role edits mark affected boards and clips stale;
new take evidence stores each role and file so a changed body image can be
distinguished from a changed face image. Renaming an asset cascades its role
selection keys along with the existing name bindings.

Collab scene orders carry only the selected views, in the same Picture order,
and keep the sender's finished prompt. The receiver groups those views under the
original asset name, restores the selected roles, and remaps each image to a
local content-derived filename. A fixed role suffix keeps identical image bytes
from collapsing two different views. Per-image safety fingerprints travel with
the views and are retained on the received takes.

The version 1 wire format adds `assetName` and `referenceRole` to image refs;
distinct view labels and canonical attachment order preserve Picture slots on
older receivers that read only `name`. Each reference slot needs a separate
source filename; orders that reuse one filename are refused before staging.
Copy a shared image to separate files before lending the scene. Equal bytes
under distinct filenames remain supported. Existing single-image orders remain
accepted. Whole-project bundles
already discover nested `referenceImages[].file` entries in their manifest and
retain role selections in the document. Those bundles remain document/manifest
metadata; Collab's whole-project importer is still unimplemented.
