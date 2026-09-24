/**
 * cloud_status / set_cloud — "No strong graphics card?", for an agent.
 *
 * The same answer the Settings card shows (GET /api/cloud, server/
 * cloud-switch.js): friend first (Collab, free), then a paid service on the
 * person's OWN key. Two tools rather than one with an action, because the
 * in-app chat gates per tool: the read is free and reachable there, the set
 * turns a paid service on or raises its cap and is WITHHELD from the chat
 * (server/chat/router.js), like set_image_engine and download_model.
 *
 * Neither tool starts a paid run. A paid song still needs make_song with
 * confirm_spend, which an agent may pass only after the person agreed to pay
 * for that song in the conversation.
 */
import { PROVIDERS } from "./apiEngine.js";

export function cloudTools(api) {
  return [
    {
      name: "cloud_status",
      description:
        "What to do when this PC's graphics card can't make something, in the owner's order: FIRST ask a "
        + "friend with a strong card to render for you (Collab: free, a sealed file each way), THEN a paid "
        + "service on the person's own key. Returns `ways` in that order with plain sentences, the hosted "
        + "engine's switch (hosted.on: MiniMax Music 3 songs billed to the person's own fal.ai or MiniMax key; "
        + "hosted.runsHere is false in Music only and Use Comfy API, where it cannot make a song), its monthly "
        + "cap and this month's spend, and the Comfy API key's status (used only by the launcher's Use Comfy "
        + "API mode). Keys are never returned: only whether one is saved, its last four characters, "
        + "when it was saved and whether another copy of Studio on this Windows account saved it. Studio uses "
        + "only keys typed into Studio, never one from an environment variable or another program. Read-only; "
        + "starts nothing and spends nothing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("GET", "/api/cloud"); },
    },
    {
      name: "set_cloud",
      description:
        "Switch the paid hosted engine (MiniMax Music 3 on the person's own key) on or off, set its monthly "
        + "spending cap in USD (clamped to 0-1000), or choose its provider. It is off by default. Use this "
        + "ONLY when the person has asked for exactly this change: it decides whether songs bill their key. "
        + "It saves no key (a key is pasted by the person in Settings → No strong graphics card?), and it "
        + "starts no run: even switched on, every paid song is confirmed on its own (make_song confirm_spend). "
        + "Suggest asking a friend with a strong card (Collab) first; see cloud_status.",
      inputSchema: {
        type: "object",
        properties: {
          on: { type: "boolean", description: "true switches the paid hosted engine on, false off." },
          monthly_cap_usd: { type: "number", minimum: 0, maximum: 1000, description: "The hard monthly ceiling, checked before every paid song." },
          provider: { type: "string", enum: Object.keys(PROVIDERS), description: "The hosted provider: fal (fal.ai, exercised end to end) or minimax (MiniMax official, an untested adapter)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const body = { action: "set" };
        if (typeof a.on === "boolean") body.on = a.on;
        if (Number.isFinite(a.monthly_cap_usd)) body.monthlyCapUsd = a.monthly_cap_usd;
        if (typeof a.provider === "string") body.provider = a.provider;
        if (Object.keys(body).length === 1) throw new Error("Say what to change: on, monthly_cap_usd or provider.");
        const r = await api("POST", "/api/cloud", body);
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },
  ];
}
