/** Curated manifests shared by the existing local catalogue and worker installer. */
// Metadata only, verified 2026-10-18. Never fetch moving refs or infer hashes.
export const ACE_REVISION = '6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc';
export const ACE_TEMPLATE_REVISION = '59a3b48bf369c5a15f29a1308bae3e279fa15505';
const aceFile = (relative, bytes, sha256) => Object.freeze({ relative, bytes, sha256,
  url: `https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/${ACE_REVISION}/split_files/${relative}` });
const companions = [
  aceFile('vae/ace_1.5_vae.safetensors', 337431732, '6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb'),
  aceFile('text_encoders/qwen_0.6b_ace15.safetensors', 1191588248, 'fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7'),
  aceFile('text_encoders/qwen_4b_ace15.safetensors', 8379154232, 'ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873'),
];
export const ACE_VARIANTS = Object.freeze([
  ['ace15-turbo', 'Turbo', 'acestep_v1.5_turbo.safetensors', 4787825604, '3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7', 'musicAceStep15', 8, 1],
  ['ace15-xl-sft', 'XL-SFT', 'acestep_v1.5_xl_sft_bf16.safetensors', 9974719930, '3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce', 'musicAceStep15XlSft', 50, 7],
  ['ace15-xl-turbo', 'XL-Turbo', 'acestep_v1.5_xl_turbo_bf16.safetensors', 9974719892, '86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71', 'musicAceStep15XlTurbo', 8, 1],
  ['ace15-xl-base', 'XL-Base', 'acestep_v1.5_xl_base_bf16.safetensors', 9974719930, '56bf816fc9a69a5f45635e867b2ad742e1e648eb51fadb7d124cb8332d2e0940', 'musicAceStep15XlBase', 50, 6],
].map(([id, variant, dit, bytes, sha, capability, steps, cfg]) => Object.freeze({ id, variant, dit, capability,
  settings: Object.freeze({ dit, lm: 'qwen_4b_ace15.safetensors', steps, cfg, shift: 3, sampler: 'euler', scheduler: 'simple', precision: variant.startsWith('XL') ? 'bf16' : 'default' }),
  files: Object.freeze([aceFile(`diffusion_models/${dit}`, bytes, sha), ...companions]),
})));
const aceBundles = Object.fromEntries(ACE_VARIANTS.map(v => [v.id, Object.freeze({
  label: `ACE-Step 1.5 ${v.variant}`, description: v.id === 'ace15-xl-sft' ? 'A100 SXM 80 GB workflow tested; this computer needs its own checks.' : 'ComfyUI split DiT, VAE, lyric encoder and 4B planner. Live inference unverified.',
  licenseUrl: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files',
  files: v.files, totalBytes: v.files.reduce((n, f) => n + f.bytes, 0),
})]));
export const MODEL_BUNDLES = Object.freeze({
  ...aceBundles,
  "ltx25": Object.freeze({
    label: 'LTX 2.5 video', description: 'The distilled video model and its text encoder, VAEs and upscaler.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.5', requiresToken: true,
    totalBytes: 39689918812,
    files: Object.freeze([
      ['diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 21504034224, 'c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334'],
      ['text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 15372969374, '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f'],
      ['vae/ltx-2.5-video-vae-conv-bf16.safetensors', 1452269922, '685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d'],
      ['vae/ltx-2.5-audio-vae-bf16.safetensors', 364866540, 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5'],
      ['latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', 995778752, 'eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8'],
    ].map(([relative, bytes, sha256]) => Object.freeze({ relative, bytes, sha256,
      url: `https://huggingface.co/Lightricks/LTX-2.5/resolve/49b093a39c19169a8a81721dcc541e07e945232f/${relative}` }))),
  }),
  "sdxl-turbo": Object.freeze({
    label: "SDXL Turbo pictures", description: "A compact picture checkpoint for the standard ComfyUI workflow.",
    licenseUrl: "https://huggingface.co/stabilityai/sdxl-turbo", totalBytes: 6938081905,
    files: Object.freeze([Object.freeze({ relative: "checkpoints/sd_xl_turbo_1.0_fp16.safetensors", bytes: 6938081905,
      sha256: "e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26",
      url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/71153311d3dbb46851df1931d3ca6e939de83304/sd_xl_turbo_1.0_fp16.safetensors" })]),
  }),
  "yue2-comfy": Object.freeze({
    label: "YuE2 3B for ComfyUI",
    description: "Text-to-music checkpoint used by AIPLAY's YuE2 ComfyUI workflow.",
    licenseUrl: "https://huggingface.co/Comfy-Org/YuE2",
    totalBytes: 3960938800,
    files: Object.freeze([Object.freeze({
      relative: "checkpoints/yue2_3b_int8_convrot.safetensors",
      bytes: 3960938800,
      sha256: "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6",
      url: "https://huggingface.co/Comfy-Org/YuE2/resolve/8e6fcf0f23252ed188b634bd50d44f4b01fba890/checkpoints/yue2_3b_int8_convrot.safetensors",
    })]),
  }),
});
