/** Validate requested video adapters before any files are staged or work queued. */
export function videoLoraInput(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 8) throw new Error("Video loras must be an array of at most eight adapters.");
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).some((key) => !["name", "strength"].includes(key))) {
      throw new Error("Each video LoRA needs a name and optional strength.");
    }
    const name = row.name;
    if (typeof name !== "string" || !name || /[/\\]|\.\./.test(name) || !/\.safetensors$/i.test(name)) {
      throw new Error("A video LoRA must be a bare .safetensors filename from list_loras.");
    }
    if (seen.has(name)) throw new Error(`Video LoRA is listed twice: ${name}.`);
    seen.add(name);
    const strength = row.strength ?? 1;
    if (typeof strength !== "number" || !Number.isFinite(strength) || strength < -4 || strength > 4) {
      throw new Error("Video LoRA strength must be a finite number from -4 to 4.");
    }
    return { name, strength };
  });
}

/**
 * `loraBase` is the engine's own (config.js video.engines.<name>.loraBase, the
 * name detect.js gives LoRAs made for it), passed in by the caller so this file
 * keeps no copy of the list: a copy here and another on the Video screen left
 * FastH3 out of both, and every LoRA was offered and then refused with "Choose
 * H3 or LTX" while FastH3 was already chosen. No base: this engine takes none.
 */
export async function validateVideoLoras(value, { engine, loraBase, label, shelf, probe, automatic = [] }) {
  const rows = videoLoraInput(value);
  if (!rows?.length) return rows;
  const expected = loraBase;
  if (!expected) throw new Error(`${label || engine || "This engine"} takes no LoRAs of your own. Clear the LoRA list, or switch to an engine that does.`);
  const files = await shelf();
  for (const row of rows) {
    if (automatic.includes(row.name)) throw new Error(`${row.name} is an engine speed adapter and loads automatically; remove it from the custom stack.`);
    const file = files.find((f) => f.folder === "loras" && f.name === row.name);
    if (!file) throw new Error(`No such file in a models/loras folder: ${row.name}.`);
    const found = await probe(file.full);
    if (found.family !== "lora") throw new Error(`${row.name} is not a recognized LoRA file.`);
    // An unrecognized base remains explicitly unverified, as in the UI. Known
    // incompatible architectures must never render successfully with no effect.
    if (found.variant && found.variant !== expected) throw new Error(`${row.name} was made for ${found.variant}, not ${expected}.`);
  }
  return rows;
}
