/** CPU song-cover controls share the Settings endpoint and existing cover queue. */
export function fastCoverTools(api) {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  return [
    { name: "fastcovers_status", description: "Read CPU song-cover readiness, setup and enabled state. Starts no setup, download or cover generation.",
      inputSchema: empty,
      async run(a = {}) { if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).length) throw new Error("No arguments expected."); return api("GET", "/api/fastcovers"); } },
    { name: "set_fastcovers", description: "Enable or disable CPU song covers when the user requests it. Enabling sets up the private Python and downloads the cover model; disabling restores the selected image engine for covers. Existing cover-generation tools use this setting. Does not change the main image generator.",
      inputSchema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } }, additionalProperties: false },
      async run(a) { if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some(k => k !== "enabled") || typeof a.enabled !== "boolean") throw new Error("enabled must be true or false."); return api("POST", "/api/fastcovers", { enabled: a.enabled }); } },
  ];
}
