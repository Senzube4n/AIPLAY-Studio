/** Prepare a real layered PSD from a saved image document for StandRig import. */
export function standRigPsdTools(api) {
  return [{
    name: "image_standrig_psd_export",
    description: "Export a saved image document's separately painted parts as a layered PSD for StandRig. The local server refuses a flat image or unsupported stack. Returns an opaque same-origin download URL, layer list and warnings; it does not rig or animate the parts.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id: { type: "string", minLength: 1, maxLength: 120, description: "Saved image document id or slug from image_documents." },
    }, additionalProperties: false },
    run: async ({ id }) => api("POST", "/api/images/standrig-psd", { id }),
  }];
}
