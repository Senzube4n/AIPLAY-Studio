/**
 * THE ROUTER — how a chat with eight tools reaches two hundred and forty-one.
 *
 * ── the arithmetic that forces this design ───────────────────────────────────
 *
 * The model behind this chat is Qwen3-4B and its context ceiling is 32,768
 * tokens. The MCP surface is 241 tools whose full descriptions and schemas come
 * to 360,287 characters, about 100,080 tokens. Pasting the library in is not a
 * thing that can be done badly; it is a thing that cannot be done. Even the
 * summary form — name plus first sentence — is 55,073 characters, some 15,298
 * tokens, which fits but leaves the conversation almost nothing and would slow
 * every turn on a card that is usually also rendering.
 *
 * The names alone are 3,860 characters. That is the fact this file is built on:
 * choosing is cheap, describing is expensive. So the message is matched against
 * all 241 names and summaries in JavaScript, costing no model call and no card,
 * and only the handful that match are described in full.
 *
 * ── why there is a hand-written table below ──────────────────────────────────
 *
 * The chat refuses to spend without asking, and that gate reads one field:
 * `spends`. NOT ONE of the 241 MCP tools declares it — they carry name,
 * description, inputSchema and run, and nothing about cost.
 *
 * ⚠ MEASURED, 2026-09-07, and the reason this table is typed out by hand rather
 * than computed. The obvious derivation is to read each tool's own source and
 * look for a mutating call, and it was tried: 206 of 241 came back "read-only".
 * The classification is wrong in the direction that matters. `avatar_import`,
 * `music_input_prepare` and `music_input_cancel` were all called free, because
 * they reach their writes through a helper rather than calling api("POST") in
 * the body the regular expression could see; `image_measure` and
 * `vfx_effect_presets` were called spending for the mirror-image reason. A
 * classifier that says a render is free is not a rough edge on this feature, it
 * is the feature failing: the person is asked for nothing and the card goes.
 *
 * So the gate is declared, per tool, in ROUTABLE. Three consequences, all
 * deliberate:
 *
 *   1. A tool that is not in the table is NOT REACHABLE from chat. Absence is
 *      refusal, never permission. This is the only default that is safe when
 *      the table is incomplete, and it is incomplete on purpose — the excluded
 *      list at the bottom says which tools were left out and why.
 *   2. `gate` is what needs the person's word, and it has two kinds, because
 *      "are you sure" is owed for two different reasons. "gpu" costs card time.
 *      "destroys" costs work that already exists. Marking a delete as GPU would
 *      have been the convenient lie; the prompt says which it is.
 *   3. Everything else is free and runs without a card — reads, catalogues,
 *      status, and the small writes that only move numbers in a document.
 *
 * ── what this file does NOT claim ────────────────────────────────────────────
 *
 * The table is a human judgement about 241 tools and human judgement about 241
 * of anything contains mistakes. It is biased so that its mistakes are the
 * survivable kind: when a tool was ambiguous it was gated, so the failure this
 * table produces is a needless confirmation rather than a silent render. If a
 * tool here is later found to spend while marked free, that is a defect in this
 * table and not in the loop, and it is fixed here.
 */

import { TOOLS as MCP_TOOLS } from "../mcp.js";

/* ─────────────────────────────────────────────── the gate table
 *
 * null   — free: reads, catalogues, and writes that only edit a document
 * "gpu"  — holds the graphics card
 * "destroys" — removes work that exists
 */
export const ROUTABLE = {
  /* the map, and what this machine is */
  pipeline_guide: null,
  studio_capabilities: null,
  studio_screen_info: null,
  studio_showcase: null,
  models_for_this_machine: null,
  /* Reads what a one-click setup would build and how its job is going. */
  setup_status: null,
  /* No strong card? Friend first, then the person's own key: a read. Its twin
   * set_cloud is withheld below, because it decides whether songs bill. */
  cloud_status: null,
  studio_status: null,
  engine_status: null,
  engine_activity: null,
  engine_nodes: null,
  provenance_read: null,

  /* songs */
  list_songs: null,
  extend_song: "gpu",
  /* Reading a recording into YuE2's codes is the step BEFORE a continuation,
   * and doing it deliberately is what turns a three-minute wait at the start of
   * an Extend into none. It takes the card when the card is free and the
   * processor when it is not, so it is tiered like a render rather than free. */
  /* Reads a selection and answers with numbers — no card, no file written.
   * The chat should reach it freely: it is the one call that distinguishes
   * "my key is subtle" from "my key caught nothing and every op silently
   * did nothing", which is a question an assistant has constantly. */
  describe_selection: null,
  tokenize_track: "gpu",
  /* ⚠ AN HOUR OF THE CARD, NOT A RENDER'S FEW MINUTES. "gpu" is the right
   * class — the loop already asks before anything that spends — but this one
   * spends far more than the rest of this list, and the tool's own
   * description says so first, before what it makes. */
  train_lora: "gpu",
  /* Free on a track whose codes are already kept, and a tokenizer run on one
   * whose are not — tiered on the worse case rather than the common one. */
  sounds_like: "gpu",
  /* Who this Studio is, and who it knows. Reads, and nothing leaves. */
  collab_me: null,
  collab_roster: null,
  collab_resources: null,
  collab_credit: null,
  collab_free: null,
  collab_orders: null,
  collab_video_preview: null,
  collab_preview: null, // local snapshot; packing is a separate explicit write
  collab_add_peer: "writes",
  /* collab_set_role, collab_verify and collab_set_lend_minutes: WITHHELD below. */
  collab_remove_peer: "destroys",
  collab_set_resources: "writes",
  collab_pack: "writes",
  collab_open: null,
  collab_inbox: null,
  collab_quarantine: null,
  collab_accept: "writes",
  collab_send_back: "writes",
  collab_receive: "writes",
  collab_adopt: "writes",
  collab_drop: "destroys",
  collab_plan: null,
  qwen_image_status: null,
  image_capabilities: null,
  image_document_preview: null,
  image_ai_edit_create: "gpu",
  image_ai_edit_status: null,
  image_ai_edit_accept: null,
  image_ai_edit_undo: null,
  image_ai_edit_discard: null,
  reactive_status: null,
  training_status: null,
  list_trained_loras: null,
  audio_waveform: null,
  model_inventory: null,
  models_folder: "writes",
  model_override: "writes",
  music_model_memory: "gpu",
  set_video_enabled: "writes",
  studio_api_reference: null,
  import_local_media: "writes",
  /* Free, and on purpose: the pitch tracker READS one recording on the
   * processor (1 to 60 s of voice, a few seconds of work) and answers with a
   * score. It writes nothing, holds no card and spends nothing. The door itself
   * is sameOriginLocalJson, so only Studio's page and local clients (this chat
   * goes through MCP) reach it. */
  hum_to_score: null,
  song_to_score: "gpu",
  /* demucs over a library song: the card (measured here at about 12 s for a
   * 30 s track; a processor is slower and was not measured) and four new
   * files beside the song. A refusal names setup id "stems", which the chat
   * may not run (setup_feature is withheld below). */
  separate_stems: "gpu",
  /* The Stop button. It runs nothing, but it ends the person's own render and
   * drops the queue behind it. The gate word is "writes" (the contract's); the
   * card's sentence is its own, COST_TEXT_BY_TOOL below, because "it writes a
   * NEW FILE into your library" is false for Stop. */
  stop_generation: "writes",
  replace_section: "gpu",
  get_beats: null,
  music_plan: null, // arithmetic/ABC validation only; never saves or generates audio
  music_auditions: null,
  music_audition_create: "gpu",
  music_audition_status: null,
  music_audition_keep: null,
  music_audition_cancel: null,
  music_audition_discard: null,
  music_kit: null,
  music_kit_render: "gpu",
  music_reference_capabilities: null,
  music_reference_list: null,
  music_reference_prepare: "writes",
  music_reference_status: null,
  music_reference_analyze_visual: "gpu",
  music_reference_transcribe: "gpu",
  music_reference_update_brief: null,
  music_reference_update_score: null,
  music_reference_prepare_request: null,
  music_artifacts: null,
  music_artifact_inspect: null,
  music_artifact_prepare: "writes",
  music_artifact_render: "gpu",
  music_artifact_status: null,
  music_artifact_cancel: null,
  music_listening_lab: null,
  music_listening_lab_start: "gpu",

  /* finishing a take that already exists — see server/mcp-audio.js
   *
   * ⚠ NOT ONE OF THESE IS "destroys", AND THAT WAS CHECKED RATHER THAN
   * ASSUMED. server/index.js:5035 reads the source and writes
   * `edit_<ms>.flac`; /api/merge reads its sources and writes
   * `merge_<ms>.flac`. Confirmed by byte comparison on 2026-09-21 — the
   * source's sha256 was identical either side of a trim. A bad edit costs a
   * file, not a take, so asking "are you sure, this cannot be undone" would be
   * training the person to wave away a warning that is not true.
   *
   * ⚠ AND THE GPU GATE ON THE TWO EDITORS IS THE TABLE'S EXISTING LINE, NOT A
   * MEASUREMENT. audio_edit_song and audio_trim_song run pure DSP in Python
   * and never touch the card, so COST_TEXT.gpu — "it holds the card while it
   * runs" — is not true of them. They are gated anyway for the reason
   * image_to_svg and apply_lut are, twenty lines further down and CPU-bound
   * too: they write a NEW FILE into the user's library, which is the line
   * every file-writing tool here is gated on. The honest fix is a third gate
   * kind for "writes a file that will be there afterwards"; until that exists,
   * consistency with the siblings beats being clever about which ones happen
   * to be cheap, and the note at the top of this file says an ambiguous tool
   * is gated so the mistake is a needless confirmation. */
  audio_edit_song: "writes",
  audio_trim_song: "writes",
  /* This one earns the word outright, and not for the DSP: /api/merge queues
   * the merged track for COVER ART on its way out (index.js art.request), and
   * that is a real picture rendered on the card whenever it next goes idle. */
  audio_merge_takes: "gpu",
  audio_export_formats: null,   // the engine's encoder table, read; nothing runs
  /* A two-node graph through the engine door. Small, but it is a submitted
   * render that queues behind whatever the card is doing. */
  audio_export_song: "writes",
  /* Forty seconds of ffmpeg for a three-and-a-half-minute film, encoded with
   * h264_nvenc — the hardware encoder, so the card is literally held — with a
   * libx264 fallback when the driver refuses. It also OVERWRITES its own
   * output, `mv_<project>.mp4`, the same name every time that project is
   * rendered. That is regeneration rather than removal, and it is the same
   * file mv_render_video rewrites through the same renderer, so it takes the
   * same class its sibling has rather than a destructive one. */
  audio_render_timeline: "writes",

  /* pictures — reading */
  list_images: null,
  image_measure: null,
  /* Both ask a question and write nothing. measure_text lays the type out in
   * memory and reports where the ink would land — the answer a layout needs
   * BEFORE it commits to a size, and the only way to get it that does not cost
   * a render and a look. check_figure reads a list of contours and says which
   * way each winds, which is the only thing in this system that can tell you
   * why a letter is about to fill solid. */
  measure_text: null,
  check_figure: null,
  /* All three answer and write nothing. describe_styles is the one worth having
   * free: it says whether a picture HAS a shape to decorate, and a caller that
   * cannot ask that cheaply will just try a style and get a refusal instead. */
  image_styles_catalog: null,
  describe_styles: null,
  list_luts: null,
  lut_info: null,
  image_review: null,
  image_reviews: null,
  image_lineage: null,
  image_expect: null,
  image_verdict: null,
  image_presets: null,
  image_swatches: null,
  image_tools_catalog: null,
  image_effects_catalog: null,
  list_fonts: null,
  list_checkpoints: null,
  list_dits: null,
  list_loras: null,
  sampling_options: null,
  preview_prompt: null,
  list_prompt_templates: null,
  save_prompt_template: null,
  prompt_gallery: null,            // reads or saves a list of text; never touches the card
  list_personas: null,
  save_persona: null,

  /* pictures — spending */
  image_adjust: "writes",
  /* ⚠ THE SAME ENGINE PASS AS image_adjust, so the same gate. bake_selection
   * runs apply_edit and writes a new picture into the library; the note at the
   * top of this file says an ambiguous tool is gated so the mistake is a
   * needless confirmation rather than a silent spend, and a tool sharing a
   * gated sibling's code path is not where to start making exceptions. */
  bake_selection: "writes",
  /* Neither touches the card — one writes an SVG, one walks a lookup table —
   * but both write a NEW FILE into the user's library, which is the line every
   * other picture-writing tool here is gated on (image_vectorize and
   * image_export are CPU too, and both are "gpu"). The note at the top of this
   * file says an ambiguous tool is gated so the mistake is a needless
   * confirmation rather than a silent one; consistency with the siblings beats
   * being clever about which ones happen to be cheap. */
  image_to_svg: "writes",
  apply_lut: "writes",
  /* \u26a0 A BLANK PAGE IS A memset, AND IT IS GATED ANYWAY. Image.new() takes
   * milliseconds and never goes near the card, so COST_TEXT.gpu \u2014 "it holds
   * the card while it runs" \u2014 is untrue of it, exactly as it is untrue of the
   * two lines above and of audio_edit_song and audio_trim_song. It is gated for
   * the reason they are: it writes a NEW FILE into the user's library, which is
   * the line every file-writing tool in this table is gated on. Exempting this
   * one because it happens to be the cheapest would make it the only CPU
   * file-writer here that does not ask, decided on the grounds this file warns
   * against. The third gate kind those comments ask for \u2014 "writes a file that
   * will be there afterwards" \u2014 is still the honest fix, and still an owner's
   * call about words the chat shows people. */
  image_new_page: "writes",
  /* Paints a layer through apply_edit - numpy, never the card - and leaves a new
   * picture in the library, which is exactly what `writes` is for. */
  image_paint_layer: "writes",
  image_document: "writes",
  /* ⚠ GATED ON THE WORST THING THEY CAN DO, NOT THE AVERAGE THING. Both are
   * mostly harmless — list, open, save, rename, reorder — but image_documents
   * takes action:"delete", and imgdoc.py says in its own words that there is no
   * trash behind that shelf and that inventing one would be a second place
   * documents live. document_edit carries remove_layer and ungroup_layer
   * against a saved document with no undo buffer on this side of the wire. A
   * gate that reads the action parameter would be a gate that can be argued
   * with by the thing being gated. */
  image_documents: "destroys",
  document_edit: "destroys",
  image_composite: "writes",
  image_sheet: "writes",
  image_batch: "writes",
  image_analyze: "writes",
  image_cutout: "gpu",
  image_upscale: "gpu",
  image_vectorize: "writes",
  image_export: "writes",

  image_set_blur: null,
  engine_run: null,
  video_compare: "gpu",   /* renders the SAME prompt through several configurations */

  /* pictures — destroying */
  image_trash: "destroys",
  delete_persona: "destroys",
  delete_prompt_template: "destroys",

  /* clips and video */
  list_clips: null,
  video_quality: null,
  /* Its set path SAVES Video Lab defaults every later render reads (sparse
   * attention on Fast among them), so it asks first, with its own sentence. */
  video_settings: "writes",
  video_comparison: null,
  video_stills: null,
  video_verdict: null,
  list_projects: null,
  make_clip: "gpu",
  restyle_clip: "gpu",
  extend_clip: "gpu",
  reactive_render: "gpu",
  build_music_video: "gpu",
  studio_bounce: "gpu",

  /* the music video workflow — reading */
  mv_list_projects: null,
  mv_open_project: null,
  mv_shot: null,
  mv_crime_board: null,
  mv_lint: null,
  mv_previz_moves: null,
  mv_control_check: null,
  mv_control_conform: null,
  mv_control_catalogue: null,
  mv_blender_catalogue: null,
  mv_mesh_status: null,
  mv_plan_read: null,
  mv_bible_spec: null,
  mv_read_timeline: null,

  /* the music video workflow — writing a document */
  mv_attach_song: null,
  mv_import_song: null,
  mv_analyze: null,
  mv_segment: null,
  mv_update_segment: null,
  mv_set_brief: null,
  mv_add_asset: null,
  mv_update_asset: null,
  mv_import_asset: null,
  mv_import_clip: null,
  mv_pick_take: null,
  mv_set_shot: null,
  mv_set_board: null,
  mv_set_bible: null,
  mv_build_timeline: null,
  mv_plan_edit: null,

  /* the music video workflow — spending */
  mv_generate_asset: "gpu",
  mv_generate_clip: "gpu",
  mv_regen_clip: "gpu",
  mv_regen_stale: "gpu",
  mv_control_render: "gpu",
  mv_pose_extract: "gpu",
  mv_depth_extract: "gpu",
  mv_blender_sheet: "gpu",
  mv_mesh_from_image: "gpu",
  mv_mesh_rig: "gpu",
  mv_shot_plan: "gpu",
  mv_render_video: "gpu",

  /* the music video workflow — destroying */
  mv_delete: "destroys",

  /* the DAW — reading */
  daw_status: null,
  daw_get_project: null,
  daw_patches: null,
  daw_render_plan: null,
  daw_ledger: null,
  daw_credits: null,
  daw_meters: null,
  daw_analyze: null,
  daw_peaks: null,
  daw_profile_list: null,
  daw_profile_get: null,
  daw_delivery_targets: null,
  daw_check_delivery: null,
  daw_ear_status: null,
  daw_taste: null,
  daw_device_response: null,
  daw_takes: null,

  /* the DAW — writing notes and settings */
  daw_create_project: null,
  daw_set_length: null,
  /* Free, and it is the one tool here that can UNDO a mistake made with the
   * page rather than make one: every control for changing the layout lives
   * inside the layout, so a window folded down to nothing has its own fix off
   * screen. Gating the way back out behind a confirmation would be the wrong
   * side of the trade. It moves no sample and dirties no render region. */
  daw_layout: null,
  daw_add_track: null,
  daw_set_track: null,
  daw_add_clip: null,
  daw_set_clip: null,
  daw_add_note: null,
  daw_move_note: null,
  daw_set_meter: null,
  daw_set_tempo: null,
  daw_mixer: null,
  daw_insert: null,
  daw_import_audio: null,
  daw_edit_notes: null,

  /* the DAW — spending */
  daw_render: "gpu",
  daw_render_ahead: "gpu",
  daw_bounce: "gpu",
  daw_preview_note: "gpu",
  daw_render_stems: "gpu",
  daw_voice_lab: "gpu",
  daw_arrange_bigroom: "gpu",
  daw_profile_build: "gpu",
  daw_critique: "gpu",
  daw_reference: "gpu",

  /* the DAW — destroying */
  daw_delete_project: "destroys",
  daw_remove_track: "destroys",
  daw_remove_clip: "destroys",
  daw_delete_note: "destroys",
  daw_profile_delete: "destroys",

  /* the compositor — reading */
  vfx_list_comps: null,
  vfx_get_comp: null,
  vfx_layer_properties: null,
  vfx_effects_catalog: null,
  vfx_shape_catalog: null,
  vfx_templates: null,
  vfx_render_status: null,
  vfx_view_overlay: null,
  vfx_audio_peaks: null,

  /* the compositor — building */
  vfx_camera_move: null,
  vfx_set_property: null,
  vfx_add_mask: null,
  vfx_set_mask: null,
  vfx_set_matte: null,
  vfx_precompose: null,
  vfx_create_comp: null,
  vfx_set_comp: null,
  vfx_add_layer: null,
  vfx_set_layer: null,
  vfx_reorder_layer: null,
  vfx_duplicate_layer: null,
  vfx_add_keyframe: null,
  vfx_add_effect: null,
  vfx_set_effect: null,
  vfx_reorder_effect: null,
  vfx_align_layers: null,
  vfx_shape_preset: null,
  vfx_set_guides: null,

  /* the compositor — spending */
  vfx_preview_frame: "gpu",
  vfx_render: "gpu",
  /* One frame, not a movie: it renders a still out of a comp and files it
   * in the image library. Same class as vfx_render because it draws on the
   * same path, and a title card the chat can actually produce is the point. */
  vfx_still: "gpu",
  vfx_prewarm: "gpu",
  vfx_audio_notes: "gpu",
  vfx_track_motion: "gpu",
  vfx_export_studio: "gpu",
  vfx_instrument_rig: "gpu",
  vfx_import_studio: "gpu",
  vfx_probe_pixel: "gpu",   /* reads the RENDERED frame, so it renders one */
  vfx_audio_keys: "gpu",    /* analyses the audio before it writes the keys */

  /* the compositor — destroying */
  vfx_delete_comp: "destroys",
  vfx_remove_layer: "destroys",
  vfx_remove_effect: "destroys",
  vfx_remove_mask: "destroys",
  vfx_remove_keyframe: "destroys",

  /* score — the ABC lead sheet YuE2 plans before it sings.
   *
   * Five of these are text tools. An ABC score is a document: reading it,
   * validating it, editing it, transforming it mechanically or diffing two of
   * them costs nothing and a chat should be able to do all of it without
   * asking. score_render is the one that turns a score into audio, which is
   * minutes of card, so it is proposed and confirmed like every other spend. */
  score_get: null,
  score_check: null,
  score_edit: null,
  score_mechanical: null,
  score_compare: null,
  score_to_daw: null,
  score_export_midi: null,
  score_render: "gpu",

  /* avatars */
  avatar_list: null,
  avatar_playback_sessions: null,
  avatar_audio_upload: "writes",
  avatar_playback_command: null,
  avatar_weight_transfer_status: null,
  avatar_weight_transfer_inspect: null,
  avatar_weight_transfer_submit: "writes", // bounded local CPU work creating a new attachment
  avatar_weight_transfer_get: null,
  avatar_wardrobe_inventory: null,
  avatar_wardrobe_list: null,
  avatar_wardrobe_import: "writes",
  avatar_wardrobe_selection: null,
  avatar_wardrobe_select: "writes",
  avatar_wardrobe_delete: "writes",
  avatar_fitting_status: null,
  avatar_fitting_inspect: "writes",
  avatar_fitting_submit: "writes",
  avatar_fitting_get: null,
  avatar_inspect: null,
  avatar_import: null,
  avatar_install_example: null,
  avatar_appearance_inventory: null,
  avatar_appearance_list: null,
  avatar_appearance_get: null,
  avatar_appearance_save: null,
  avatar_appearance_delete: null,
  avatar_appearance_active: null,
  avatar_appearance_activate: null,

  avatar_export: null,
  avatar_outfit_export: 'writes',
  avatar_outfit_get: null,
};

/**
 * DELIBERATELY NOT ROUTABLE, and why. Absence from ROUTABLE is already refusal;
 * this list exists so the next person can tell "decided against" from "not got
 * to yet", which is the difference between a boundary and an oversight.
 */
export const WITHHELD = {
  studio_api_request: "Raw API methods can mix reads, deletion, trust grants and generation; the local chat's per-tool gate cannot classify them. Use the typed tools here or explicitly invoke this fallback through external MCP.",
  enhance_style: "this chat IS a language model writing the words; asking a second model to rewrite them is a round trip for nothing, and a local one would take the card",
  enhance_lyrics: "the chat writes lyrics itself; a second model rewriting them is a round trip for nothing, and a local one would take the card",
  enhance_description: "the chat already turns an idea into a song; rewriting the idea through a second model adds nothing",
  enhance_model: "which model Enhance uses is a setting for a person, chosen in Settings",
  timed_lyrics_python: "names a program Studio will execute; a sentence typed into a chat box must not choose what runs on this machine (Settings > Songs, or MCP)",
  stems_python: "names a program Studio will execute (stem separation and the audio-reference encoder); a sentence typed into a chat box must not choose what runs on this machine (Settings > Songs, or MCP)",
  yue2_gguf_setup: "One tool combines status, runtime/model downloads and cancellation. Installation requires explicit download approval and licence review through Models or MCP, not this chat's generic per-tool confirmation.",
  vfx_audio_preview: "CPU audio preparation is bounded but still starts work; this chat has no CPU-specific confirmation gate. Use the explicit VFX playback control or MCP instead.",
  vfx_render_job: "One tool both cancels existing work and retries an expensive render. Its operation-specific approval cannot be represented by this chat's single per-tool gate; use the render queue or MCP explicitly.",
  cancel_download: "the twin of download_model, which is withheld for the same reason: what the Models page's buttons do stays with the person at that page",
  engine_run_graph: "runs an arbitrary graph on the card; nothing in a sentence typed into a chat box should assemble one",
  engine_stop: "stops work that is very likely the person's own render, from a model that cannot see what is running",
  engine_reveal_port: "hands out the engine's port and writes a dated line saying it did; that is a decision for a person",
  engine_hash_models: "turns on a real ongoing cost across every future run",
  engine_adopt_unrecorded: "rewrites the provenance of files the ledger never saw; a claim about history is not a chat action",
  engine_identity: "reports launch paths of the engine process; read by a person, not volunteered by a chatbot",
  engine_graph: "returns a stored graph by hash, which is of no use to this model and large in the prompt",
  overnight_start: "starts an unattended run measured in hours; the confirm card cannot convey that",
  overnight_control: "steers a run this chat did not start and cannot see",
  overnight_status: "harmless, but only meaningful beside the two above",
  mv_plan_run: "starts a whole music-video run; mv_plan_read and mv_plan_edit are routable so the plan can still be discussed",
  mv_plan_propose: "sets up a run for hand-over; the plan screen is where that belongs",
  mv_plan_decide: "approves spending in bulk, which is exactly what the per-call confirm exists to prevent",
  daw_calibrate: "takes base64 float32 PCM; not a thing a sentence produces",
  daw_record: "drives the recording transport and the microphone",
  daw_apply_choice: "answers a critique card by id; useless without the card in front of you",
  daw_audio_clip: "one call both moves and REMOVES a clip, so a single gate cannot be honest about it",
  music_input_prepare: "experimental audio-input path with a setup this table cannot verify is present",
  music_input_continue: "queues generation off that same unverified path",
  music_input_cancel: "cancels jobs this chat did not start",
  music_input_status: "harmless, but only meaningful beside the three above",
  music_input_capabilities: "harmless, but only meaningful beside the three above",
  set_video_engine: "changes a persistent app setting the person set on the Video page",
  set_image_engine: "changes a persistent app setting the person set on the Pictures page",
  set_music_engine: "changes a persistent app setting the person set on the Music page, and can switch paid API mode on",
  download_model: "downloads gigabytes and accepts a licence — the Models page is the door",
  setup_feature: "downloads gigabytes and changes which program Studio runs for a feature (timed lyrics, Studio's own engine packages) — the Set up button (Models, Settings) and the launcher's Try again are the doors, the same reason download_model is withheld",
  collab_set_lend_minutes: "raises or lowers how many minutes a day this card renders for a friend; with collab_accept routable, a chat could raise the allowance and then accept, walking past the minutes a person set exactly as the withheld \"anyway\" would. The Friends row on the Collab screen is where a person sets it (MCP clients keep the tool)",
  collab_set_role: "makes a friend a lending friend or a collaborator, a trust decision about who may send this card work or hold the whole project; a person makes it on the Collab screen's Friends row (MCP clients keep the tool)",
  collab_verify: "records that the twelve words were read aloud and matched, the one trust grant in Collab; a chat cannot hear the words, so a person presses it on the Collab screen (MCP clients keep the tool)",
  set_cloud: "switches a PAID service on, or raises its monthly cap: it decides whether songs bill the person's own key, and that is the person's decision on the Settings page (No strong graphics card?)",
  studio_welcome: "hides or re-shows the first-run lines and SAVES the Simple/Advanced level, a setting for a person (Settings > Screens), not a sentence in a chat box",
  wait_for_song: "blocks until a render finishes, which would hold the turn open for minutes",
  make_song: "the chat has its own make_song with a written caption guide",
  make_image: "the chat has its own make_image",
  mv_create_project: "the chat has its own mv_create_project",
  mv_previz_shot: "the chat has its own mv_previz_shot",
  vfx_effect_presets: "one call SAVES, APPLIES, RENAMES and DELETES a preset, so a single gate "
    + "cannot be honest about it — the same reason daw_audio_clip is withheld",
  ab_create_project: "the audiobook surface is a whole workflow of its own and has had no pass for chat",
};

/**
 * ARGUMENTS THE CHAT MAY NOT SEND, on tools it may otherwise call.
 *
 * Withholding a whole tool is too much here: accepting a friend's order and
 * keeping a returned take are ordinary writes the chat may do after its
 * per-call confirm. But each carries an OVERRIDE whose only purpose is to walk
 * past a check a person set up or a check that failed, and the confirm card
 * says "it writes a NEW FILE" -- it cannot say "and past the minutes a day you
 * gave this friend". So the model is never shown the argument, and a call that
 * sends it anyway is refused by name, never silently stripped. External MCP
 * clients keep the typed schema; the person's own "Accept anyway" / "Keep
 * anyway" on the Collab screen is where these belong.
 */
export const CHAT_WITHHELD_ARGS = {
  collab_accept: {
    anyway: "walks past a busy card or this friend's minutes a day; a person answers \"Accept anyway\" on the Collab screen",
  },
  collab_adopt: {
    anyway: "keeps a take that failed its checks; a person watches it and answers \"Keep anyway\" on the Collab screen",
  },
};

/* Every audiobook tool, withheld as a group rather than one line each. */
for (const t of MCP_TOOLS) {
  if (t.name.startsWith("ab_") && !(t.name in WITHHELD)) {
    WITHHELD[t.name] = "the audiobook surface is a whole workflow of its own and has had no pass for chat";
  }
}

/** How the confirm card explains each kind of gate. */
export const COST_TEXT = {
  gpu: "graphics card time, and it holds the card while it runs",
  /* \u26a0 THE THIRD KIND, AND THE ONE THE OTHER TWO COMMENTS KEPT ASKING FOR.
   * Measured by reading which routes reach runImageGraph: exactly TWO image
   * tools hold the card (cutout and upscale). Every other one is numpy and PIL,
   * and this table was telling people a collage "holds the card while it runs".
   * They are still gated \u2014 they put a file in somebody's library that is
   * still there afterwards \u2014 but the sentence is now true. */
  writes: "no graphics card time \u2014 but it writes a NEW FILE into your library, which is still there afterwards",
  destroys: "nothing to run, but it REMOVES work that already exists and cannot be undone from here",
};

/** A tool whose gate's sentence would be false for it gets its own. The gate
 *  word still decides whether and how the chat asks; only the words change. */
export const COST_TEXT_BY_TOOL = {
  stop_generation: "no graphics card time and no new file — it ends the render you have running and drops the queue behind it",
  /* The router gates the whole tool, so a plain read asks too: the card says
   * that reading changes nothing. */
  video_settings: "no graphics card time and no new file — reading your video settings changes nothing; a setting it changes is SAVED, and every later render uses it",
};

/** The tag the chat's tool list shows beside a gated tool whose gate's own tag
 *  would be false for it (server/chat/loop.js gateLabel). video_settings is
 *  "writes" for its confirm, but it saves a setting, not a file. */
export const GATE_WORDS_BY_TOOL = {
  video_settings: "SAVES A SETTING",
};

/* ─────────────────────────────────────────────── the flat-argument rule
 *
 * A 4B emits flat JSON. Nested objects and arrays inside `args` are a measured
 * failure of this model, not a stylistic preference, and the loop's own parser
 * is built around that. A tool whose REQUIRED arguments include an object or an
 * array therefore cannot be called correctly however well it is described, and
 * offering it produces a confident malformed call and a wasted model turn.
 *
 * So the shape decides, not the table: required scalars only. Optional nested
 * arguments are fine — they are simply never sent.
 */
const SCALAR = new Set(["string", "number", "integer", "boolean"]);

// The local chat emits flat arguments. These reviewed workflows need arrays or
// selection/document objects, so represent those arguments as JSON strings at
// this boundary and decode before invoking the unchanged MCP tool. Nothing is
// silently dropped. External MCP clients still use the original typed schema.
const JSON_ARGUMENT_TOOLS = new Set([
  "image_ai_edit_create", "image_document_preview", "collab_plan", "collab_set_resources", "reactive_render",
  "music_kit", "music_audition_create", "music_reference_update_brief", "music_listening_lab",
  /* The score tools take `source` as an object and the note editor takes an
   * array of notes; without these three the chat could not reach them at all
   * ("turn my hum into a score" went to score_* tools). hum_to_score and
   * song_to_score also take a flat `library_file`, which a 4B sends best. */
  "hum_to_score", "song_to_score", "daw_edit_notes",
]);

export function callableShape(schema) {
  const props = schema?.properties || {};
  const required = schema?.required || [];
  for (const name of required) {
    const p = props[name];
    if (!p) return false;
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    if (type && !SCALAR.has(type)) return false;
    if (!type && (p.properties || p.items)) return false;
  }
  return true;
}

/* ─────────────────────────────────────────────── the adapter */

/** The one-sentence form the scorer and the prompt both read. */
export const summarise = (description) =>
  String(description).split(/\.\s/)[0].split("\n").join(" ").trim();

/**
 * An MCP tool in the shape the chat loop understands.
 *
 * The description is TRIMMED. MCP descriptions are written for a large model
 * with room to spare and run to 9,966 characters at the extreme, which is a
 * third of this model's whole context for one tool. What survives is the first
 * paragraph, which is where these descriptions put the point.
 */
export function adaptTool(tool, gate, { budget = 1200 } = {}) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const args = {};
  const jsonArgs = new Set();
  const withheldArgs = CHAT_WITHHELD_ARGS[tool.name] || {};
  for (const [name, spec] of Object.entries(props)) {
    if (name in withheldArgs) continue;
    const type = Array.isArray(spec?.type) ? spec.type[0] : spec?.type;
    if (!SCALAR.has(type)) {
      if (JSON_ARGUMENT_TOOLS.has(tool.name)) {
        args[name] = { type: "string", required: required.has(name), note: `JSON ${type || "object"}: ${spec?.description || name}` };
        jsonArgs.add(name);
      }
      continue;
    }
    args[name] = {
      type: type === "integer" ? "number" : type,
      required: required.has(name),
      note: spec?.description ? summarise(spec.description).slice(0, 160) : undefined,
    };
  }

  let description = String(tool.description);
  if (description.length > budget) {
    const cut = description.slice(0, budget);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
    description = (stop > budget * 0.4 ? cut.slice(0, stop + 1) : cut).trim();
  }

  return {
    name: tool.name,
    description,
    args,
    spends: !!gate,
    gate: gate || null,
    cost: gate ? (COST_TEXT_BY_TOOL[tool.name] || COST_TEXT[gate]) : undefined,
    gateWords: gate ? GATE_WORDS_BY_TOOL[tool.name] || null : null,
    routed: true,
    run: (a) => {
      const decoded = { ...a };
      for (const [name, why] of Object.entries(withheldArgs)) {
        if (decoded[name] !== undefined && decoded[name] !== false) {
          throw new Error(`${name} is not available in this chat: it ${why}.`);
        }
        delete decoded[name];
      }
      for (const name of jsonArgs) {
        if (decoded[name] === undefined) continue;
        if (typeof decoded[name] !== "string") throw new Error(`${name} must be a JSON string in local chat.`);
        let value;
        try { value = JSON.parse(decoded[name]); } catch { throw new Error(`${name} must contain valid JSON.`); }
        const type = props[name].type;
        if (type === "array" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value))
          throw new Error(`${name} must decode to ${type}.`);
        decoded[name] = value;
      }
      return tool.run(decoded);
    },
  };
}

/* ─────────────────────────────────────────────── the scorer
 *
 * Deliberately lexical. A model call to choose which tools to describe to a
 * model is a second inference on the same busy card, and it would double the
 * latency of every turn to save a few hundred tokens of prompt.
 */

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "in", "on", "at", "by", "with", "from",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "as",
  "i", "me", "my", "you", "your", "we", "us", "our", "can", "could", "would", "should", "will",
  "do", "does", "did", "have", "has", "had", "please", "want", "need", "make", "get", "give",
  "some", "any", "all", "one", "two", "new", "up", "out", "now", "then", "so", "if", "not",
]);

export function words(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Singular/plural and a few studio-specific synonyms folded together. */
const SYNONYM = {
  picture: "image", pictures: "image", images: "image", photo: "image", photos: "image",
  drawing: "image", art: "image", artwork: "image",
  song: "song", songs: "song", track: "song", tracks: "song", music: "song", tune: "song",
  video: "clip", videos: "clip", clips: "clip", movie: "clip", footage: "clip",
  comp: "comp", comps: "comp", composition: "comp", compositing: "comp", effects: "effect",
  effect: "effect", layers: "layer", layer: "layer",
  project: "project", projects: "project",
  character: "character", characters: "character", cast: "character",
  camera: "camera", cameras: "camera", shot: "shot", shots: "shot", scene: "segment",
  scenes: "segment", storyboard: "board", board: "board", boards: "board",
  mesh: "mesh", model3d: "mesh", rig: "rig", rigged: "rig", rigging: "rig", skeleton: "rig",
  avatar: "avatar", avatars: "avatar",
  note: "note", notes: "note", midi: "note", drum: "patch", drums: "patch",
  instrument: "patch", instruments: "patch", patch: "patch", patches: "patch",
  mix: "mixer", mixing: "mixer", mixer: "mixer", master: "master", mastering: "master",
  loud: "loudness", loudness: "loudness", volume: "gain",
  render: "render", rendering: "render", renders: "render", export: "export",
  delete: "delete", remove: "delete", trash: "delete", erase: "delete",
  list: "list", show: "list", what: "list",
};

const fold = (w) => SYNONYM[w] || (w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w);

/** A tool's searchable tokens: its name carries far more signal than its prose. */
export function toolTokens(tool) {
  const name = new Set(words(String(tool.name).split(/[_-]/).join(" ")).map(fold));
  const summary = new Set(words(summarise(tool.description)).map(fold));
  return { name, summary };
}

/**
 * How well one tool answers one message.
 *
 * A name hit is worth five, because `mv_generate_clip` matching "clip" is the
 * whole reason a name is a name. A summary hit is worth one. There is no
 * normalisation by length: a tool with a long summary genuinely is a broader
 * answer to a vague message, and pretending otherwise buried the catalogues.
 */
export function scoreTool(messageWords, tokens) {
  let score = 0;
  for (const w of messageWords) {
    if (tokens.name.has(w)) score += 5;
    else if (tokens.summary.has(w)) score += 1;
  }
  return score;
}

/**
 * A DESTRUCTIVE TOOL IS NEVER VOLUNTEERED.
 *
 * ⚠ MEASURED, 2026-09-07, on the first working build of this router. "what
 * songs do i have?" offered `daw_remove_track`, and "upscale that picture and
 * remove its background" put `image_trash` at the TOP of the list, above
 * image_upscale and image_cutout — because "remove" folds to "delete" and
 * `trash` is a name token, so a request to remove a BACKGROUND scored as a
 * request to bin the picture.
 *
 * The confirm card would have caught both, and that is not the point. Putting a
 * delete in front of a model that was asked to do something else is how a
 * confirm card gets a reflexive yes, and a person who is asked to approve
 * destruction they never mentioned is being trained to stop reading.
 *
 * So removal words are required before a destructive tool is even in the
 * running, and the rank drops it below anything that scored the same without
 * destroying something. Discovery is not lost: ask to delete a project and
 * the delete tools are there, first.
 */
export const REMOVAL_WORDS = new Set([
  "delete", "remove", "trash", "erase", "drop", "clear", "wipe", "discard",
  "bin", "scrap", "purge", "undo", "kill", "unwanted", "rid",
]);

export const wantsRemoval = (messageWords) => messageWords.some((w) => REMOVAL_WORDS.has(w));

/* ─────────────────────────────────────────────── the router */

export const ROUTE_LIMIT = 6;

/** The routable MCP tools, adapted once at module load rather than per turn. */
function buildIndex() {
  const out = [];
  for (const tool of MCP_TOOLS) {
    if (!(tool.name in ROUTABLE)) continue;
    if (!callableShape(tool.inputSchema) && !JSON_ARGUMENT_TOOLS.has(tool.name)) continue;
    const adapted = adaptTool(tool, ROUTABLE[tool.name]);
    out.push({ tool: adapted, tokens: toolTokens(tool) });
  }
  return out;
}

let INDEX = null;
export const index = () => (INDEX ||= buildIndex());

/**
 * Choose the tools this message may reach.
 *
 * `pinned` is not optional in practice and the reason is a real bug it closes:
 * a proposal is answered by the word "yes", and "yes" routes to nothing, so the
 * confirm turn would look up a tool that is no longer in the registry and call
 * `.run` on undefined. Whatever is pending is always in the list.
 */
export function chooseTools(message, { limit = ROUTE_LIMIT, pinned = [] } = {}) {
  const ws = [...new Set(words(message).map(fold))];
  const removal = wantsRemoval(ws);
  const scored = [];
  for (const { tool, tokens } of index()) {
    const score = scoreTool(ws, tokens);
    if (score <= 0) continue;
    /* asked for nothing to be removed, so nothing that removes is offered */
    if (tool.gate === "destroys" && !removal) continue;
    scored.push({ tool, score, destroys: tool.gate === "destroys" });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || (a.destroys ? 1 : 0) - (b.destroys ? 1 : 0)
    || a.tool.name.localeCompare(b.tool.name));

  const chosen = [];
  const seen = new Set();
  for (const name of pinned) {
    const hit = index().find((e) => e.tool.name === name);
    if (hit && !seen.has(name)) { chosen.push(hit.tool); seen.add(name); }
  }
  for (const { tool } of scored) {
    if (chosen.length >= limit) break;
    if (seen.has(tool.name)) continue;
    chosen.push(tool);
    seen.add(tool.name);
  }
  return chosen;
}

/**
 * The registry one turn sees: the eight written tools, always, plus whatever
 * this message reached for.
 *
 * The core eight are never displaced. They are the ones with hand-written
 * descriptions, measured against this model, and they cover what people
 * actually ask for; a routed tool is an addition to them and never a
 * replacement, so a bad match degrades to today's behaviour rather than to a
 * worse one.
 */
export function routedRegistry(core, message, { limit = ROUTE_LIMIT, pinned = [] } = {}) {
  const coreTools = Array.isArray(core) ? core : core.all;
  const coreNames = new Set(coreTools.map((t) => t.name));
  const extra = chooseTools(message, { limit, pinned }).filter((t) => !coreNames.has(t.name));
  const all = [...coreTools, ...extra];
  const byName = new Map(all.map((t) => [t.name, t]));
  return {
    all,
    names: all.map((t) => t.name),
    get: (n) => byName.get(String(n)) || null,
    spending: all.filter((t) => t.spends).map((t) => t.name),
    routed: extra.map((t) => t.name),
  };
}

export default { ROUTABLE, WITHHELD, CHAT_WITHHELD_ARGS, routedRegistry, chooseTools, adaptTool, scoreTool, index };
