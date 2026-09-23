# Local audio mouth motion

`web/avatar-lipsync.js` provides a local audio player and an amplitude-driven VRM mouth layer. It uses the imported model's `aa` expression, with `jawOpen` as a fallback when that custom expression exists. It does not create facial topology, recognize phonemes or infer vowels. Music can drive it too, including instruments; a clean voice track produces more useful mouth timing.

The Studio controls upload a user-selected audio file to private local storage, capped at 32 MiB, then load its managed local URL. Choosing a file loads metadata but does not start playback or create an AudioContext. An explicit `play()` command is required. There is no microphone request or external service. Browsers without Web Audio and models without the mouth expression can play audio with the limitation reported in `state().audioOnlyReason`.

## Integration

```js
import { createAvatarLipSync } from './avatar-lipsync.js';

const lip = createAvatarLipSync({
  expressionManager: runtime.vrm?.expressionManager,
  onState: state => updateAudioControls(state),
});

// Studio uploads through /api/avatars/playback before loading:
lip.loadUrl(audio.url, {name: audio.name, bytes: audio.bytes});
playButton.onclick = () => lip.play().catch(showAudioError);
pauseButton.onclick = () => lip.pause();
stopButton.onclick = () => lip.stop();
seekInput.oninput = () => lip.seek(Number(seekInput.value));

// Every viewer frame, after the animation mixer and before VRM expression update:
lip.update(dt);
runtime.update(dt);

// Every time an appearance is applied:
runtime.apply(settings);
lip.captureBaseline();

// Before replacing/discarding the avatar or closing its player:
await lip.dispose();
```

The module exposes `loadFile`, `loadUrl`, `play`, `pause`, `stop`, `seek`, `update`, `captureBaseline`, `state` and `dispose`. `loadFile`, `loadUrl`, pause/stop/seek return a state snapshot. The standalone `loadFile(File)` helper permits up to 256 MiB and uses a revocable object URL; the Studio transport has the smaller 32 MiB limit. `loadUrl` accepts only the exact managed relative path `/api/avatars/playback/audio/au_<UUID>`, never an arbitrary path, absolute URL, query or fragment. Play returns a promise and preserves playback error names: `NotAllowedError` reports phase `blocked`, while other playback failures report `error`. Dispose marks the controller unusable immediately and returns a promise for closing its owned audio context. Commands can be invoked by a UI or an explicitly routed local control request; an MCP command cannot bypass the browser's autoplay policy. A user may need to press Play once in the actual browser/OBS source.

`state()` returns phase, file name/size, time, nullable duration, playing, selected mouth expression, support/fallback information, current envelope level/RMS and the latest error. `onState` fires on media/state changes, including media time updates. The render loop can read `state().level` for a meter. Do not rely on UI labels as playback state.

Playback startup is bounded to eight seconds. A still-suspended AudioContext reports `blocked` and asks for a browser Play gesture; other readiness timeouts report `error`. Repeating Play while startup is pending retries both browser activation calls synchronously in the new gesture without depending on the earlier resume promise. Pause, replacement and disposal settle the pending operation and prevent late readiness from restarting playback.

The transparent overlay shows a small **Enable audio** button while playback startup is pending or blocked by browser activation. Click it in that source window (use OBS **Interact** for a browser source). It uses the same shared Play command as Studio, retries activation immediately in the click gesture, and disappears after playback starts. It stays hidden for ready/paused sources and decoder failures; it is not a second player or an autoplay bypass.

Each update reads the real audio waveform through `MediaElementAudioSourceNode -> AnalyserNode -> destination`. DC-removed RMS feeds a noise floor and a bounded mouth level, with exponential attack/release smoothing independent of frame rate. This is an audible graph, not a silent duplicate player. One source node is reused when the selected file changes.

Only the mouth expression is changed. The layer blends upward from the authored mouth value and keeps other expressions intact. `captureBaseline()` after every appearance update guarantees that a new authored mouth value becomes the restore point. Pause, stop, seeking, end, errors and disposal restore it; if another controller already changed that weight, restoration leaves the newer value alone. A VRM expression's authored `overrideMouth` or binary rules can still suppress or quantize the visible effect.

Replacing the selected file pauses playback and revokes its previous object URL. Disposal removes listeners, stops playback, disconnects graph nodes, closes the owned AudioContext and revokes the remaining URL. Call it before disposing the avatar's expression manager. Codec support comes from the browser; accepted file metadata does not guarantee successful decoding.

## Local control transport

`server/mesh/avatar-playback.js` mounts behind the avatar API's existing loopback Host, Origin and fetch-site checks. All JSON actions use `POST /api/avatars/playback`; audio bytes use `GET` or `HEAD /api/avatars/playback/audio/au_<UUID>`, with single byte-range support. There are no caller-supplied filesystem paths or remote fetches.

| Action | Required fields | Result |
| --- | --- | --- |
| `register` | `session_id` UUID, avatar `id`, source `sha256`, `capabilities: {audio, lip_sync}` booleans | A browser session with a 30-second lease |
| `heartbeat` | `session_id`, `applied_revision`, `status: {phase, time, duration, error?}` | Refreshed lease and latest desired playback |
| `sessions` | None | `{sessions: [...]}` for unexpired previews |
| `upload` | `name`, `data_base64` | Opaque `audio_id`, managed `url`, `name`, `bytes`, `sha256`, `mime`, `expiresAt` |
| `command` | `session_id`, `op`, optional UUID `command_id` | Updated desired playback and revision |

Commands are `load` with `audio_id`, `play`, `pause`, `stop`, and `seek` with `seconds`. Only load accepts an audio ID; only seek accepts seconds. Load always clears playback intent and starts at zero. A session retains desired audio metadata, `playing`, `time`, `load_revision` and `seek_revision`, so a rapid load followed by play remains coherent if both arrive between browser polls. `revision` increases for each new command; the browser reports its `applied_revision`. Reusing a `command_id` with identical arguments does not replay it; reusing it with different arguments fails. Registration pins the avatar source digest, which is checked again for every command.

Requested playback is not proof of audible playback. Browser status separately reports `empty`, `ready`, `loading`, `playing`, `paused`, `ended`, `blocked` or `error`, with bounded time, duration and error text. A blocked command can be acknowledged once while the UI offers Play; it must not be retried on every poll. Commands never extend the browser lease. After lease expiry, controls return HTTP 410 until the browser registers again. An open client should pause before recreating an expired session.

MCP exposes `avatar_playback_sessions`, `avatar_audio_upload` and `avatar_playback_command`, using the same handlers as the human controls. Register and heartbeat are browser-client protocol operations: they declare actual preview capabilities, liveness and applied status, so they are not advertised as agent tools. An agent discovers a live session, uploads audio, loads its ID, requests playback, then reads status. Source changes return HTTP 409; they require reloading the avatar rather than silently switching the target.

Storage is bounded to 32 sessions, 64 audio files and 256 MiB total audio. Upload accepts WAV, MP3, OGG/OGA/OPUS, FLAC, M4A, AAC and WEBM filenames; the browser validates actual codec support on playback. Each upload expires after 24 hours. Expired media is immediately unavailable, and the next registration or upload removes expired stored files. Audio is hash-checked before serving. Session and metadata files use atomic replacement; command mutations are serialized per storage directory. Session retry history is capped at 4,096 command IDs; clients must register a new session when it fills.

Provenance uses the existing `import`, `edit` and `preset_apply` vocabulary with the request actor. Registration, uploads, commands, expiry cleanup and meaningful heartbeat transitions are recorded. Heartbeats append an event only when the phase, error or applied revision changes; position, duration and lease refreshes persist without flooding the ledger.

## Verification

`node --test server/mesh/avatar-lipsync_test.js` uses the actual three-vrm expression manager and morph binding, with controlled media/audio adapters. It covers explicit playback, waveform-driven deformation, smoothing across frame rates, DC rejection, authored-expression preservation, late play completion, file replacement, object URL/node cleanup, natural end, seeking, autoplay refusal and audio-only fallback. Real browser playback should additionally be checked when integrating the controls; the test adapters do not establish installed browser codec or autoplay behavior.

`node --test server/mesh/avatar-playback_test.js` exercises persisted state, retry deduplication, expiry, bounded validation, source and audio hash conflicts, quiet heartbeats, and HTTP/MCP parity through the real guarded avatar route and real provenance writer. Its audio route checks GET/HEAD, byte ranges and cross-origin refusal.

Primary API references: [Web Audio specification](https://www.w3.org/TR/webaudio/), [MDN createMediaElementSource](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource), [MDN HTMLMediaElement.play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).
