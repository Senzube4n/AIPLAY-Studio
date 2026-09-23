# Ask a friend to render a movie scene

Movie → Video clips → **Ask friend** opens Collab on the saved project and scene. Choose the recipient, preview the resolved prompt/settings/references, then prepare the reviewed file. The recipient accepts it through the existing Collab workflow. Current transport is file handoff, not automatic network delivery; hardware cards are snapshots, not live presence.

MCP uses the same operations:

1. `collab_roster` to inspect permitted friends.
2. `collab_preview` with `slug`, `to` (fingerprint), `kind: "order"`, and `segment`.
3. Review the returned prompt, resolved settings and included files.
4. `collab_pack` with `preview_id` from that review.
5. Use `collab_orders` / `collab_plan` to inspect local progress; transfer the prepared file through the agreed channel.

The shortcut clears any seed, steps or engine override left from an earlier request. It reads the saved scene, not an unsaved inspector prompt. It never invokes a generator or sends a network request to a friend's machine. Multi-friend distribution stays in Collab's production planner. Standalone Images/Video/Music requests need an expanded typed job contract before this shortcut can faithfully support their settings.
