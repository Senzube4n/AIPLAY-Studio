# Ask a friend to render a movie scene

Movie → Video clips → **Ask friend** opens Collab on the saved project and scene. Choose the recipient, preview the resolved prompt/settings/references, then prepare the reviewed file. The recipient accepts it through the existing Collab workflow. Current transport is file handoff, not automatic network delivery; hardware cards are snapshots, not live presence.

MCP uses the same operations:

1. `collab_roster` to inspect permitted friends.
2. `collab_preview` with `slug`, `to` (fingerprint), `kind: "order"`, and `segment`.
3. Review the returned prompt, resolved settings and included files.
4. `collab_pack` with `preview_id` from that review.
5. Use `collab_orders` / `collab_plan` to inspect local progress; transfer the prepared file through the agreed channel.

The shortcut clears any seed, steps or engine override left from an earlier request. It reads the saved scene, not an unsaved inspector prompt. It never invokes a generator or sends a network request to a friend's machine. Multi-friend distribution stays in Collab's production planner. Standalone Image/Music requests still need typed contracts for their settings.


## Standalone Video recipes

Video → **Ask friend** opens Collab with a text-only recipe. Choose a verified lender/collaborator, preview, and prepare the signed, encrypted `.aiplay` file. Transfer it to the friend. They open it in Collab and press **Use video recipe**, review Video, then press Render separately.

Preserved: H3/LTX engine, prompt, negative prompt, dimensions, duration, steps, guidance, resolved seed and audio choice. Models are the receiver's defaults, custom LoRAs and conditioning bridge are off. Results can differ across installed models and hardware. Frames, reference images/audio, soundtracks, loops and custom model selections are refused before preparing a recipe. **Clear recipe mode** restores normal bridge behavior for subsequent renders.

This is a recipe handoff, not a queued remote job. There is no live delivery, automatic rendering, tracked return or adoption for this packet. Use movie scene orders when you need the existing order/return workflow. Older Studio versions cannot load this new recipe kind; both sides should update.

MCP: `collab_video_preview({to, video})` uses the same validation and frozen preview as the UI. `video` requires `engine`, `prompt`, `width`, `height`, `seconds`, `steps`, `guidance`, `keepAudio`; `negative` and `seed` are optional. Pack with `collab_pack({preview_id})`. The receiver's `collab_open` returns validated `videoRecipe` plus `makeClipArgs`. Review those arguments before separately calling `make_clip`; opening a packet never generates content.
