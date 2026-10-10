# VST3 effects in the DAW

Open **DAW → Plugins** in the bottom dock. **Set up host** installs the optional
CPU audio host when needed. **Install ZIP…** accepts a plugin developer's ZIP;
**Folders and local files** also accepts a local `.vst3` file/bundle or an extra
plugin folder. Standard system VST3 folders are discovered automatically.

Click **Check plugin** to inspect a discovered plugin. Once it is ready, select
a track, return or master channel and click **Add to chain**. Inspected plugins
also appear in the Chain insert picker. The Chain panel provides the plugin's
own exposed parameters, numeric entry, bypass, reordering and removal.

Installation copies files into Studio's user plugin directory, without an admin
installer. ZIPs are checked for unsafe paths, links and excessive expansion.
Scanning lists files; inspection explicitly loads native code in a separate,
bounded worker. Use plugins from developers you trust and retain their notices.

The saved project records the inspected plugin identity, binary fingerprint,
host version, initial native state and parameter values. Plugin binaries are
installed separately on each machine. Missing or changed enabled plugins report
an error; their saved inserts remain available for bypass or removal.

Playback, metering, stems and bounce use the same native insert chain. Effects
render from the start of the project for each region so their history crosses
region boundaries. Leave space at the end of the project for reverb and delay
tails; the export ends at the project boundary. Plugin parameters are static
in this first version. Changing one regenerates affected cached audio.

## MCP

Use `daw_plugins` to `list`, `scan`, `install`, `inspect` or `setup`. Then use
`daw_insert` with `op: "add"`, `type: "vst3"`, a `plugin` id from inspection,
the project `slug` and a track/return id or `target: "master"`. Read the inspected
parameter schema before sending values. `daw_insert set` changes parameters,
bypasses an insert or changes its index; `remove` removes it. These are the same
actions used by the UI.

## Current scope

Use 64-bit **VST3 audio effects** matching the host operating system and CPU
architecture. Pedalboard compatibility varies between plugins; successful
installation is followed by inspection and an audio check. This is native
rendering for DAW playback and export, not low-latency live input monitoring.
VST2 `.dll` plugins, MIDI instruments, native editor windows and plugin parameter
automation are outside this DAW implementation.

The host uses the optional processing environment or `AIPLAY_VST_PYTHON`; it
does not replace the DAW's NumPy/SciPy environment. No GPU is required.
[Pedalboard documentation](https://spotify.github.io/pedalboard/reference/pedalboard.html)
describes format support and plugin parameter access.
