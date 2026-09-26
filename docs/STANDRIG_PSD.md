# Preparing layered art for StandRig

StandRig imports a PSD with at least two painted image layers. Studio's image
document shelf can now export that PSD from **saved, already separated** layers.
It does not split a flat photograph, model a rig, or assign movement. The PSD
is the artwork input to StandRig's separate modeling service.

The editor's Documents dock sends `{ "id": "<saved document id>" }` to
`POST /api/images/standrig-psd`. MCP calls the same route. Its reply contains
`downloadUrl`, layer names, canvas size, and any part-separation warnings.
The download is a same-machine GET; generated files live for 24 hours in the
image library's `_standrig` folder. The browser reply does not expose a disk
path. The export action writes a library provenance event.

The exporter rasterizes each source layer independently at full canvas size
through Studio's own image-document renderer. It keeps alpha, transforms,
masks, stack order, group names, and visibility. The saved original remains
editable in Studio. StandRig receives image pixels, not Studio's native layer
effects or type objects. The exporter refuses an opaque document backdrop,
adjustment layers, clipping, non-normal blends, and groups with transforms,
masks, opacity or effects, because splitting those would silently change the
art. It also refuses missing sources, empty parts, and fewer than two painted
parts. Nearly full-canvas parts generate a warning to inspect the separation.

Export limits are 4,194,304 canvas pixels, 2–32 painted layers, 40 MiB of raw
layer pixels, 16,777,216 pixels and 32 MiB per source image, and 64 MiB for
the final PSD. These caps keep the local export bounded. StandRig's imported
model JSON may grow past its own 64 MiB request cap after images are embedded,
especially with many detailed parts, so a smaller canvas may still be needed.

The file is encoded and read back with ag-psd before Studio offers it. The
readback checks each part's name, visibility, and pixels. A separate acceptance
test also opens a saved Studio document, rasterizes it, writes the PSD, and
checks the image layers again. Run it with a Studio-capable Python:

```powershell
$env:AIPLAY_STANDRIG_TEST_PYTHON = "C:\\path\\to\\python.exe"
node --test server/standrig/psd-export_test.js
```

StandRig's own [PSD input guide](https://github.com/sayaka-aiart/StandRig/blob/main/docs/PSD.md)
still applies: draw the material hidden behind moving parts, and inspect layer
placement after import. PSD compatibility does not imply a finished animation.
