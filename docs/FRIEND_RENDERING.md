# Ask a friend to render a movie scene

**Music video** → **Video clips** → **Ask friend** (on a scene's row) opens Collab on the saved project and scene. Choose the recipient, preview the resolved prompt/settings/references, then prepare the reviewed file. The recipient accepts it through the existing Collab workflow. Current transport is file handoff, not automatic network delivery; hardware cards are snapshots, not live presence.

This Ask friend carries the scene's **reference pictures**. For one text-only clip outside a project, use **Video** → **Ask friend** (below); each button's tooltip names the other.

MCP uses the same operations:

1. `collab_roster` to inspect permitted friends.
2. `collab_preview` with `slug`, `to` (fingerprint), `kind: "order"`, and `segment`.
3. Review the returned prompt, resolved settings and included files.
4. `collab_pack` with `preview_id` from that review.
5. Use `collab_orders` / `collab_plan` to inspect local progress; transfer the prepared file through the agreed channel.

The shortcut clears any seed, steps or engine override left from an earlier request. It reads the saved scene, not an unsaved inspector prompt. It never invokes a generator or sends a network request to a friend's machine. Multi-friend distribution stays in Collab's production planner. Standalone Image/Music requests still need typed contracts for their settings.

## If you have no strong card (borrowing)

Every scene is rendered by a friend, so none of them has ever been rendered on your machine. That is fine:

- **The finished take comes back as a file.** In **Collab** → **What arrived**, choose it and press **Check it against what I asked for**. Your Studio measures it against the order: the seed, the steps, the size, and the length the engine really renders — H3 rounds a clip up to its own grid (a 6-second scene is 158 frames, not 144) and LTX to its own, and the check expects exactly that.
- **Watch it before you keep it.** Each take under *Finished scenes waiting for you* has a player; nothing is loaded until you press play. **Keep it** files it on its scene — even a scene you never rendered — as a take nobody has picked; choose it in **Music video** → **Video clips** → **Inspect…** on that scene. Nothing plays there until you do.
- **A take that failed a check** shows the reason and a **Keep anyway…** button, which works once you have played the take and asks before it does anything. If this browser cannot play it (an .mkv, or a file your Studio could not measure), **Keep anyway…** asks whether to keep it unseen instead. The ledger records that the checks did not pass. (`collab_adopt` with `anyway: true` is the same override from an MCP client; the in-app chat is never offered it.)
- **Lip-sync does not travel.** Your song never leaves your machine. A scene you would render with the song under it — a board that sings, or **Song under the clip: always** — is still lent, but rendered without the song, so mouths will not follow the vocal. The preview says so before you prepare the file, and the returned take's notes say it again. Render those scenes yourself if the lips matter.
- **Speed-up files.** If your step count overruns the speed-up file your friend's PC loads (an 8-step order on a PC with only the 4-step files — the Models screen offers no 8-step file), the returned take's notes tell you, and the take may look burned or over-sharpened. To match their file next time, set the order's steps in **Collab** → **Send** → **Pin the exact numbers** → **Steps**.

## If you lend your card

- **Friends** tab: a friend you render for is a **lending friend: we render single scenes for each other** (the stored role is `lender`). **Minutes of my card per day** is checked when you accept one of their scenes: what your card has already rendered for them today (timed here, the render alone) plus what you accepted from them today and have not rendered yet, plus the new scene (both by the plan's estimate; a scene with no estimate makes the total "at least"). A friend made a lending friend or a collaborator starts at 60; 0 gives them none, and their row then says every scene will ask you first. The row also shows **Used today**.
- **Accept**: open the file, press **Show me exactly what they want**, read the prompt and pictures — and, beside them, whether this order's step count overruns the speed-up file your PC loads (with the matching file named, and whether the Models screen offers it, or a restart loads one already on disk) and what the scene costs against their minutes. You can render an overrun as it is (your friend's take notes say so) or leave the order unaccepted and ask for the step count your file is made for. Then **Yes — take the job**. If your card is busy or their minutes for today are used, you are asked **Accept anyway?** with every reason listed; answer **Not now** and pressing **Yes — take the job** again asks again. A paused queue or an engine the Studio cannot read is never overridable. (`collab_accept` with `anyway: true` is the same override from an MCP client, after the person's yes; the in-app chat is never offered it.)
- **Approve**: accepting renders nothing. The order becomes a project called **Order o_… from *their name*** with a proposed plan. **Open its plan in Music video** (under *What you agreed to render for friends*) takes you to that project; approve the item on its **Plan** card and press **Run 1 approved item**.
- **Send it home**: when it has rendered, **Send the take back** seals it for them and **Show me this file** finds it.


## Standalone Video recipes

**Video** → **Ask friend** opens Collab with a text-only recipe. Choose a verified lending friend or collaborator, preview, and prepare the signed, encrypted `.aiplay` file. Transfer it to the friend. They open it in Collab and press **Use video recipe**, review Video, then press **Render clip** separately.

Preserved: H3/LTX engine, prompt, negative prompt, dimensions, duration, steps, guidance, resolved seed and audio choice. Models are the receiver's defaults, custom LoRAs and conditioning bridge are off. Results can differ across installed models and hardware. Frames, reference images/audio, soundtracks, loops and custom model selections are refused before preparing a recipe — the refusal points to **Music video** → **Video clips** → **Ask friend**, which carries reference pictures. **Clear recipe mode** restores normal bridge behavior for subsequent renders.

This is a recipe handoff, not a queued remote job. There is no live delivery, automatic rendering, tracked return or adoption for this packet. Use movie scene orders when you need the existing order/return workflow. Older Studio versions cannot load this new recipe kind; both sides should update.

MCP: `collab_video_preview({to, video})` uses the same validation and frozen preview as the UI. `video` requires `engine`, `prompt`, `width`, `height`, `seconds`, `steps`, `guidance`, `keepAudio`; `negative` and `seed` are optional. Pack with `collab_pack({preview_id})`. The receiver's `collab_open` returns validated `videoRecipe` plus `makeClipArgs`. Review those arguments before separately calling `make_clip`; opening a packet never generates content.
