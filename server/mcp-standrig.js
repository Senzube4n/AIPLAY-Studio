/** Studio's optional local 2D performer connector, shared with the Radio UI. */
export function standRigTools(api) {
  return [
    {
      name: "standrig_status",
      description: "Read the optional local StandRig 2D performer, its rig readiness, parameter ranges, transient playback and fixed transparent player URL. Works when StandRig is offline; does not install or import artwork.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => api("GET", "/api/standrig"),
    },
    {
      name: "standrig_parameters",
      description: "Send 1-32 finite, in-range values to the local StandRig performer. Read standrig_status for the model's parameter IDs/ranges. Studio supplies the current session and sequence; values are transient.",
      inputSchema: { type: "object", required: ["values"], additionalProperties: false,
        properties: { values: { type: "object", minProperties: 1, maxProperties: 32,
          additionalProperties: { type: "number" } } } },
      run: ({ values }) => api("POST", "/api/standrig", { action: "parameters", values }),
    },
    {
      name: "standrig_control",
      description: "Control the optional local StandRig 2D performer: play, pause, reset or start/stop its fixed showcase motion test. Does not install a model, stream, record or edit artwork.",
      inputSchema: { type: "object", required: ["command"], additionalProperties: false,
        properties: { command: { type: "string", enum: ["play", "pause", "reset", "demo-start", "demo-stop"] } } },
      run: ({ command }) => api("POST", "/api/standrig", { action: "control", command }),
    },
  ];
}
