/** Optional fused YuE2 LoRAs. Publisher cards and HF blob API checked 2026-09-30.
 * These are ComfyUI files, not adapters supported by the Python or audio.cpp runners.
 * Each file contains both text_encoders.* (planner) and diffusion_model.* (audio).
 * No file is selected or downloaded by importing this metadata. */
import { modelName } from "../localmodels.js";

const HF = "https://huggingface.co";
const families = [
  { id: "trbdr", label: "TRBDR folk troubadour", repo: "becausereasons/yue2-trbdr-folk-troubadour",
    revision: "078b19e52baebaa71463ea94afac5ce13abfe29a", trigger: "trbdr", language: "English", voice: "male lead",
    description: "1960s acoustic folk, guitar and harmonica, with cinematic fantasy folk options.",
    prompt: "Start with trbdr, then describe an English male lead, vocal delivery, guitar or harmonica, mood and tempo. Use tagged verses with a refrain; empty interludes leave room for harmonica.",
    caution: "The publisher reports loops with Thinking Off and a preference for waltz time; change the seed if a section repeats.",
    files: [
      ["broadside", "Broadside", 117500816, "68e3aca03e7aa7ddf8a2ee5cf46ce68c2c18fc9fe432cc60b838b9f0e9b8171f", "Protest ballads and darker fantasy folk", "AI Toolkit", 700],
      ["lantern", "Lantern", 117500816, "48af1d8f3aa2a77b887ec825f8c0ce1e4b73ec7fd8cae3b04f20148431874b69", "Hymns, dirges and fingerpicked waltzes", "AI Toolkit", 600],
      ["hearth", "Hearth", 117500816, "37ee350bc1f9dad847b349b64c0e8ab58db98dacdb9b67aeeadd94b95689af05", "Earlier checkpoint, closer to the base model", "AI Toolkit", 400],
      ["ferryman", "Ferryman", 177279760, "1cf63a5ea51b8cb5dca91170b4a05b522cdd6f7ef06c0b867ef8dd67a4d7f86c", "Fingerpicked and fantasy folk", "FS_Audio", 700],
      ["porch", "Porch", 177279760, "a6a9cdbb980ded2f05d08ccb23b35ef1ef949a1e8da900683816020eaeb41832", "Country folk with a small band", "FS_Audio", 650],
    ] },
  { id: "grvl", label: "GRVL raspy rock and soul", repo: "becausereasons/yue2-grvl-raspy-rock-soul",
    revision: "314dbcf2779e92b1b04e8539f4c2ceee3516f969", trigger: "grvl", language: "English", voice: "female lead",
    description: "Raspy female rock, soul and pop vocals, from restrained verses to belted choruses.",
    prompt: "Start with grvl, then describe the era, genre, raspy female voice, verse and chorus delivery, instruments, mood and tempo. Thunder and Tempest use raspy gravelly alto female vocal with an explicit delivery arc.",
    caution: "The publisher reports thin high end at later checkpoints; try audio strength 0.8. A long score can hit the length cap and end abruptly.",
    files: [
      ["ember", "Ember", 117500800, "97449c739f7f503e19621ad83d8c85e8ef501a76a19dbc93b1b62bae32f54809", "v1, lightest voice touch", "AI Toolkit v1", 400],
      ["smoulder", "Smoulder", 117500808, "7edcb87dd497f0adf4d5a501efadfac89a20606199ffa19825441254d12e25a1", "v1, mild character for cool mid-tempo songs", "AI Toolkit v1", 500],
      ["cinder", "Cinder", 117500800, "2017b5b36c9d4232de3b017e6b007ef5120964e7543056a7b93fd622118888ad", "v1, stronger rasp and husky synth-pop", "AI Toolkit v1", 600],
      ["wildfire", "Wildfire", 117500808, "c25ac35a717f92cceb8553fbefe0867bc589415042e885cbf864bd3169ebeb9b", "v1, strongest character and belted choruses", "AI Toolkit v1", 800],
      ["thunder", "Thunder", 117500808, "553f2f159600e5af193bf1f26e84939227c6ec1467a2cfb972919503c6401d53", "v2, most consistent voice in the publisher's tests", "AI Toolkit v2", 800],
      ["tempest", "Tempest", 117500808, "3aaf5ffbe06aa54bc431b6f60e59f157d410b63bba544601c9a0324681c9cc18", "v2, strongest voice character", "AI Toolkit v2", 950],
    ] },
];

export const YUE2_STYLE_ADAPTERS = Object.freeze(families.flatMap((family) => family.files.map(
  ([key, name, bytes, sha256, character, trainer, step]) => {
    const file = `${family.id}_${key}.safetensors`, home = `${HF}/${family.repo}`;
    return Object.freeze({
      id: `musicYue2Style-${family.id}-${key}`, family: family.id, familyLabel: family.label,
      label: `${family.id.toUpperCase()} ${name}`, file, bytes, sha256, character, trainer, step,
      repo: family.repo, revision: family.revision, home, url: `${home}/resolve/${family.revision}/${file}`,
      licence: "CC BY-NC 4.0", gated: false, engine: "yue2-comfy", fused: true,
      trigger: family.trigger, language: family.language, voice: family.voice,
      description: family.description, prompt: family.prompt, caution: family.caution,
      recipe: Object.freeze({ cot: "full", plannerStrength: 1, audioStrength: 1, steps: 32,
        sampler: "dpm_2", scheduler: "sgm_uniform" }),
      baseModel: "Comfy-Org/YuE2", publisherTestedCheckpoint: "yue2_3b_bf16.safetensors",
      outputRights: Object.freeze({
        class: "not-for-sale", sellable: false, quote: "Non-commercial use only",
        clause: "Publisher model card, License and credits", url: `${home}/blob/${family.revision}/README.md`,
        attribution: `${family.id.toUpperCase()} LoRAs by becausereasons`,
        note: "The adapter publisher explicitly limits these weights to noncommercial use. Studio conservatively labels the resulting song not for sale. The base YuE2 authors' separate statement does not grant rights to these adapters.",
      }),
    });
  },
)));

const relativeKey = file => modelName(file)?.replace(/\\/g, "/") || null;
const sameShelfPath = (a, b) => {
  const left = relativeKey(a), right = relativeKey(b);
  return left !== null && right !== null && (process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase() : left === right);
};

export function yue2StyleAdapterFor(file, discovered = []) {
  if (!file) return null;
  const key = relativeKey(file);
  const exact = key ? discovered.filter(adapter => relativeKey(adapter?.file) === key) : [];
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (key && process.platform === "win32") {
    const aliases = discovered.filter(adapter => {
      const candidate = relativeKey(adapter?.file);
      return candidate && candidate.toLowerCase() === key.toLowerCase();
    });
    if (aliases.length) return aliases.length === 1 ? aliases[0] : null;
  }
  const name = String(file || "").split(/[\\/]/).pop().toLowerCase();
  return YUE2_STYLE_ADAPTERS.find((adapter) => adapter.file.toLowerCase() === name) || null;
}

/** Turn a tensor-verified installed fused adapter into a shared UI/MCP row.
 * The catalogue enriches known files; an unfamiliar file gets no guessed
 * trigger, licence, or score mode. Its exact shelf path remains its identity. */
export function yue2StyleAdapterFromProbe(file, probe) {
  const name = modelName(file);
  if (!name || !/\.safetensors$/i.test(name) || probe?.family !== "lora" || probe.variant !== "YuE2"
    || probe.loraParts?.audio !== true || probe.loraParts?.planner !== true) return null;
  const known = yue2StyleAdapterFor(name);
  if (known) return { ...known, file: name, installed: true, source: "catalog" };
  const metadata = probe.metadata && typeof probe.metadata === "object" ? probe.metadata : {};
  const text = (value, cap) => typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, cap) : "";
  const label = text(metadata.name || metadata.ss_output_name, 160)
    || name.split(/[\\/]/).pop().replace(/\.safetensors$/i, "");
  const trigger = text(metadata.trigger || metadata.trigger_word || metadata.ss_trigger_word, 200);
  const licence = text(metadata.license || metadata.licence || metadata.ss_license, 160);
  return { file: name, label, engine: "yue2-comfy", fused: true, installed: true, source: "local",
    recipe: { audioStrength: 1, plannerStrength: 1 },
    ...(trigger ? { trigger } : {}), ...(licence ? { licence } : {}) };
}

/** Validate an active/requested adapter, not dormant saved ComfyUI preferences.
 * Callers rendering another engine must pass explicit:false for retained slots.
 * Never silently change the engine, score mode, trigger or strengths. */
export function validateYue2StyleAdapter({ engine, lora, loraClip, cot = "full", explicit = true } = {}) {
  const audio = yue2StyleAdapterFor(lora), planner = yue2StyleAdapterFor(loraClip);
  if (!audio && !planner) return null;
  if (engine !== "yue2-comfy" && !explicit) return null;
  const refuse = (reason, message) => {
    const error = new Error(message);
    Object.assign(error, { status: 400, reason, engine, adapter: (audio || planner).file });
    throw error;
  };
  if (engine !== "yue2-comfy") refuse("yue2-style-engine", "These YuE2 style adapters require the YuE2 ComfyUI engine. The native Python and GGUF engines do not support these LoRAs.");
  // Catalog names provide recipes; only actual shelf paths can identify a pair.
  if (!audio || !planner || !sameShelfPath(lora, loraClip)) refuse("yue2-style-pair", "Choose the same fused YuE2 style adapter for the planner and audio slots; each file patches both halves.");
  if (cot !== "full") refuse("yue2-style-score", "These YuE2 style adapters use Thinking Full. Select Full before generating with this adapter.");
  return audio;
}

export function yue2StyleAdapterGuide(selection = {}) {
  const adapter = yue2StyleAdapterFor(selection.lora) || yue2StyleAdapterFor(selection.loraClip);
  return adapter ? { name: adapter.label, trigger: adapter.trigger, rules: [adapter.prompt,
    "Use the same file in planner and audio slots with Thinking Full; start both strengths at 1.",
    adapter.caution, "This adapter's publisher permits noncommercial use only."] } : null;
}
