/**
 * The library, persisted.
 *
 * Job history used to live only in memory, so every restart emptied the library
 * while the audio sat there on disk. Two sources of truth, reconciled here:
 *
 *   - the FILES in ComfyUI's output folder are the real library. Anything on disk
 *     shows up, even if it was made before this app existed or by the bench rig.
 *   - a small JSON sidecar carries what the files cannot: title, seed, mix seed,
 *     steps, whether it was a re-roll.
 *
 * Files win. If a sidecar entry has no file it is dropped; if a file has no
 * sidecar entry it still appears, just with less detail. That way deleting audio
 * in Explorer does the obvious thing.
 */
import { readdir, stat, readFile, writeFile, mkdir, unlink, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

const SIDECAR = path.join(config.paths.appData, "library.json");
const PREFIXES = ["aiplay", "preview", "edit", "extend", "merge"];
// Every extension the app can emit. Kept in ONE place: the format is now a
// setting, and a listing that still only recognised .flac would make a library
// full of MP3s look empty.
const AUDIO_EXTS = [".flac", ".mp3", ".opus"];
const isAudio = (n) => AUDIO_EXTS.some((x) => n.endsWith(x));
const stemOf = (n) => n.replace(/\.(flac|mp3|opus)$/i, "");
// Trash is a real folder next to the output, not a flag. Deleting a take must be
// undoable in Explorer without this app's cooperation, and a 30 MB FLAC that only
// a JSON sidecar says is deleted is a file people lose.
const TRASH = path.join(config.outputDir, "trash");

export class Library {
  constructor() {
    this.meta = new Map();   // filename -> metadata
    this.playlists = [];     // { id, name, files[] }
    this.dirty = false;
  }

  async load() {
    await mkdir(config.paths.appData, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(SIDECAR, "utf8"));
      // Older sidecars were a bare filename->meta map; keep reading those.
      const meta = raw.meta ?? raw;
      for (const [k, v] of Object.entries(meta)) this.meta.set(k, v);
      this.playlists = raw.playlists ?? [];
    } catch {
      /* first run */
    }
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    await writeFile(SIDECAR, JSON.stringify({
      meta: Object.fromEntries(this.meta),
      playlists: this.playlists,
    }, null, 2), "utf8");
  }

  createPlaylist(name) {
    const pl = { id: Math.random().toString(36).slice(2, 9), name: String(name || "New playlist").slice(0, 60), files: [] };
    this.playlists.unshift(pl);
    this.dirty = true; this.save().catch(() => {});
    return pl;
  }

  togglePlaylistFile(id, file) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return null;
    const i = pl.files.indexOf(file);
    if (i >= 0) pl.files.splice(i, 1); else pl.files.push(file);
    this.dirty = true; this.save().catch(() => {});
    return pl;
  }

  deletePlaylist(id) {
    this.playlists = this.playlists.filter((p) => p.id !== id);
    this.dirty = true; this.save().catch(() => {});
  }

  /**
   * Stamp provenance into the file and get its true duration back.
   *
   * The metadata goes via a temp JSON file rather than argv — lyrics contain
   * newlines and quotes, and shell quoting mangles them.
   */
  async tagFile(file, meta, coverPath) {
    const metaPath = path.join(config.paths.appData, `tag_${Date.now()}.json`);
    const target = path.join(config.outputDir, file);
    await writeFile(metaPath, JSON.stringify(meta), "utf8");
    try {
      const out = await new Promise((resolve) => {
        const proc = spawn(config.python, [
          path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "tag_audio.py"),
          target, metaPath,
          /* The cover, when there is one to embed.
           *
           * Absent on the FIRST tagging pass by necessity: a song is tagged the
           * moment it lands, and its art is only queued after that and drawn
           * when the GPU is idle. So the art arrives minutes later and the file
           * is tagged a second time — see the re-tag in index.js. */
          ...(coverPath ? [coverPath] : []),
        ]);
        let so = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.on("exit", () => resolve(so));
        proc.on("error", () => resolve(""));
      });
      return JSON.parse(out || "{}");
    } finally {
      unlink(metaPath).catch(() => {});
    }
  }

  /** Duration straight from the file — the only honest source. Cached, because
   *  probing every track on every status poll would be wasteful. */
  async durationOf(file) {
    const m = this.meta.get(file);
    if (m?.durationSeconds) return m.durationSeconds;
    const out = await new Promise((resolve) => {
      const proc = spawn(config.python, [
        path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "tag_audio.py"),
        path.join(config.outputDir, file),
      ]);
      let so = "";
      proc.stdout.on("data", (d) => (so += d));
      proc.on("exit", () => resolve(so));
      proc.on("error", () => resolve(""));
    });
    let secs = 0;
    try { secs = Math.round(JSON.parse(out || "{}").seconds || 0); } catch { /* ignore */ }
    if (secs) this.remember(file, { durationSeconds: secs });
    return secs;
  }

  /**
   * Splice a generated extension onto the track it continues.
   *
   * The model rejoined the performance at `atSeconds`, so the original's audio
   * past that point has been replaced. Everything before the crossfade is the
   * original's own samples, untouched — which is what makes discarding a bad
   * extension free. Both source files survive; this writes a third.
   */
  async joinExtension(originalFile, extensionFile, atSeconds) {
    const out = `extend_${Date.now()}.flac`;
    const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
    const ops = JSON.stringify([{
      op: "join",
      with: path.join(config.outputDir, extensionFile),
      at: atSeconds,
      fade: 0.08,
    }]);
    const code = await new Promise((resolve) => {
      const proc = spawn(config.python, [
        path.join(here, "edit_audio.py"),
        path.join(config.outputDir, originalFile),
        path.join(config.outputDir, out),
        ops,
      ]);
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("exit", (c) => { if (c) console.error(`  join: ${err.trim()}`); resolve(c); });
      proc.on("error", () => resolve(1));
    });
    return code === 0 ? out : null;
  }

  /**
   * Stitch two trajectories so a joined track can be extended again.
   *
   * Without this, extending an extension resumes from only the new section and
   * the model forgets everything before the last seam — each extension would
   * drift further from the original song. Concatenating the kept prefix with the
   * new rows gives the joined file a trajectory describing the WHOLE thing, so
   * chains stay coherent.
   */
  async spliceTrajectory(priorCodes, newCodes, keepFrames) {
    if (!priorCodes || !newCodes) return null;
    const out = path.join(config.outputDir, ".codes", `joined_${Date.now()}.npz`);
    const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
    const code = await new Promise((resolve) => {
      const proc = spawn(config.python, [
        path.join(here, "splice_codes.py"), priorCodes, newCodes, String(keepFrames), out,
      ]);
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("exit", (c) => { if (c) console.error(`  splice: ${err.trim()}`); resolve(c); });
      proc.on("error", () => resolve(1));
    });
    return code === 0 ? out : null;
  }

  /** Read Vorbis comments back out of a file — how older tracks recover the
   *  lyrics and style the sidecar never stored. */
  async readTags(file) {
    const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
    const out = await new Promise((resolve) => {
      const proc = spawn(config.python, [
        path.join(here, "tag_audio.py"), path.join(config.outputDir, file), "--read",
      ]);
      let so = "";
      proc.stdout.on("data", (d) => (so += d));
      proc.on("exit", () => resolve(so));
      proc.on("error", () => resolve(""));
    });
    try { return JSON.parse(out || "{}"); } catch { return null; }
  }

  /** Record what the file itself cannot tell us. */
  remember(file, data) {
    if (!file) return;
    this.meta.set(file, { ...(this.meta.get(file) || {}), ...data });
    this.dirty = true;
    this.save().catch(() => {});
  }

  /** Star (favourite) and pin (revisit later) are independent: a pin is "come
   *  back to this", a star is "this one is good". Suno conflates them; keeping
   *  them apart costs nothing and they get used differently. */
  setFlag(file, flag, on) {
    if (!["starred", "pinned", "rating"].includes(flag)) return false;
    const m = this.meta.get(file) || {};
    m[flag] = on;
    this.meta.set(file, m);
    this.dirty = true;
    this.save();
    return true;
  }

  /** Move to a trash folder rather than unlinking. Reversible, and Explorer
   *  shows the truth. */
  async trash(file) {
    const src = path.join(config.outputDir, file);
    await mkdir(TRASH, { recursive: true });
    let dest = path.join(TRASH, file);
    try { await stat(dest); dest = path.join(TRASH, `${Date.now()}_${file}`); } catch { /* free */ }
    await rename(src, dest);
    const m = this.meta.get(file);
    if (m) { this.meta.set(file, { ...m, trashedAt: Date.now() }); this.dirty = true; this.save(); }
    return path.basename(dest);
  }

  async restore(file) {
    // Undo the collision suffix if one was added on the way in.
    const bare = file.replace(/^\d{13}_/, "");
    await rename(path.join(TRASH, file), path.join(config.outputDir, bare));
    const m = this.meta.get(bare);
    if (m) { delete m.trashedAt; this.meta.set(bare, m); this.dirty = true; this.save(); }
    return bare;
  }

  async listTrash() {
    try {
      const names = (await readdir(TRASH)).filter(isAudio);
      /* Objects, not bare names: the Trash view has to say WHAT was trashed
       * and WHEN, or a list of collision-suffixed filenames is all a person
       * gets to decide a restore by. The sidecar is keyed by the bare name
       * (trash() strips nothing, restore() strips the timestamp prefix). */
      const out = [];
      for (const file of names) {
        const bare = file.replace(/^\d{13}_/, "");
        const m = this.meta.get(bare) || {};
        let st = null;
        try { st = await stat(path.join(TRASH, file)); } catch { /* raced away */ }
        out.push({
          file, title: m.title || bare.replace(/\.[^.]+$/, ""),
          trashedAt: m.trashedAt || (st ? Math.round(st.mtimeMs) : 0),
          sizeBytes: st?.size ?? 0,
        });
      }
      out.sort((a, b) => b.trashedAt - a.trashedAt);
      return out;
    } catch { return []; }
  }

  /** Scan disk and merge in the sidecar. Files are the source of truth. */
  async list() {
    let entries = [];
    try {
      entries = await readdir(config.outputDir, { withFileTypes: true });
    } catch {
      return [];
    }
    // Covers are named after their track, so one directory read answers "does
    // this have art?" for the whole library. Disk wins over the sidecar here for
    // the same reason it does for audio: deleting a PNG in Explorer should do
    // the obvious thing.
    // Name -> mtime. The mtime becomes a cache-busting token on the URL: covers
    // are served with a long max-age (they rarely change and the list requests
    // fifty at once), but REGENERATING one rewrites the same filename. Without a
    // version the browser keeps showing the old picture forever, which made a
    // whole re-render of the library look like it had silently done nothing.
    const coverNames = new Map();
    try {
      const dir = path.join(config.outputDir, "covers");
      for (const n of await readdir(dir)) {
        if (!n.endsWith(".png")) continue;
        try { coverNames.set(n, Math.round((await stat(path.join(dir, n))).mtimeMs)); }
        catch { coverNames.set(n, 0); }
      }
    } catch { /* no covers drawn yet */ }

    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      if (!isAudio(name)) continue;
      if (!PREFIXES.some((p) => name.startsWith(p))) continue;
      let s;
      try { s = await stat(path.join(config.outputDir, name)); } catch { continue; }
      const m = this.meta.get(name) || {};
      const stem = stemOf(name);
      const coverName = `${stem}.png`;
      out.push({
        file: name,
        title: m.title || stem.replace(/_\d+$/, ""),
        // Null means "fall back to the deterministic gradient" — every surface
        // already handles that, so art is purely additive and a missing cover is
        // never a broken image.
        cover: coverNames.has(coverName) ? coverName : null,
        // The 256px copy. The list paints fifty 44px squares, and pointing those
        // at the full 1024² images meant decoding 81 MB to draw thumbnails.
        thumb: coverNames.has(`${stem}_t.png`) ? `${stem}_t.png` : null,
        // Version token, so a regenerated cover actually appears.
        coverV: coverNames.get(coverName) ?? coverNames.get(`${stem}_t.png`) ?? 0,
        // Whether the art is INSIDE the audio file, not merely beside it. The
        // backfill uses this to skip work, and it is worth surfacing: it is the
        // difference between a file that shows its cover in someone else's
        // player and one that does not.
        coverEmbedded: !!m.coverEmbedded,
        // Separated stems, if any. Recorded in the sidecar rather than scanned,
        // because the stems folder is nested per model and per track and walking
        // it for every row would cost a directory read each.
        stems: m.stems || null,
        // The looping clip, if one was rendered. Same trap as `cover` before it:
        // remembering it in the sidecar is useless unless the listing exposes it,
        // and the file sitting on disk while the UI shows nothing looks exactly
        // like a generation failure.
        clip: m.clip || null,
        // Timed lyrics, plus how much of that timing was measured rather than
        // interpolated — so the UI can flag a weak alignment instead of
        // presenting every LRC as equally trustworthy.
        lrc: m.lrc || null,
        wordLrc: m.wordLrc || null,
        lrcConfidence: m.lrcConfidence ?? null,
        // The user's own note about the track. Kept separate from `caption`,
        // which is the prompt the model was actually given — merging them would
        // destroy the provenance the file is stamped with.
        notes: m.notes || "",
        seed: m.seed ?? 0,
        mixSeed: m.mixSeed,
        steps: m.steps,
        // What actually produced the track. Stored all along but never surfaced
        // until the song panel existed to show it.
        caption: m.caption,
        lyrics: m.lyrics,
        cfg: m.cfg,
        model: m.model,
        // Only tracks captured since the resume patch carry a trajectory, so the
        // UI must gate "Extend" on this rather than offering it everywhere.
        codes: m.codes || null,
        // Which track this continues. Recorded on every join but never surfaced,
        // so a chain of extensions looked like unrelated files.
        extendedFrom: m.extendedFrom || null,
        // Seconds into the PARENT where the model rejoined. Everything after this
        // point in the file is material the parent never had, which is what makes
        // merging a tree possible without repeating the shared opening.
        joinedAt: m.joinedAt ?? null,
        starred: !!m.starred,
        pinned: !!m.pinned,
        rating: m.rating ?? 0,
        instrumental: !!m.instrumental,
        preview: name.startsWith("preview") || !!m.preview,
        edited: name.startsWith("edit"),
        reroll: !!m.reroll,
        // How long the MUSIC is. Distinct from renderSeconds, which is how long
        // it took to make — the library previously showed only the latter, and
        // for pre-existing files that was 0:00.
        durationSeconds: m.durationSeconds,
        renderSeconds: m.renderSeconds,
        // File mtime is the honest timestamp for anything we did not create.
        createdAt: m.createdAt ?? s.mtimeMs,
        sizeBytes: s.size,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);

    // Fill in missing durations a few at a time. Anything already on disk before
    // this app existed has no sidecar entry, so probe lazily rather than blocking
    // startup on decoding every file.
    const missing = out.filter((t) => !t.durationSeconds).slice(0, 3);
    for (const t of missing) {
      const s = await this.durationOf(t.file);
      if (s) t.durationSeconds = s;
    }
    return out;
  }
}
