/** One CPU/render worker, bounded waiting list and durable honest outcomes.
 * Never resumes work on boot: an interrupted job needs an explicit retry. */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const LIVE = new Set(["queued", "running", "cancelling"]);
export class VfxRenderQueue {
  constructor({ dir, records, limit = 8 }) {
    this.dir = dir; this.records = records; this.limit = limit;
    this.pending = []; this.active = null; this.loading = null;
    this.writes = Promise.resolve();
  }
  load() {
    if (!this.loading) this.loading = this._load();
    return this.loading;
  }
  async _load() {
    let saved;
    try { saved = JSON.parse(await readFile(path.join(this.dir, "render-jobs.json"), "utf8")); }
    catch (err) { if (err.code !== "ENOENT") throw new Error(`Cannot read VFX render history: ${err.message}`); return; }
    if (!Array.isArray(saved?.jobs)) throw new Error("VFX render history is invalid; it has not been overwritten.");
    let changed = false;
    for (const row of saved.jobs.slice(-60)) {
      if (!row || typeof row.id !== "string" || typeof row.slug !== "string") continue;
      const rec = { ...row };
      if (LIVE.has(rec.status)) {
        rec.status = "interrupted";
        rec.error = "Studio stopped before this render completed. Retry explicitly; no work was resumed automatically.";
        rec.finishedAt = Date.now(); changed = true;
      }
      if (!this.records.has(rec.id)) this.records.set(rec.id, rec);
    }
    if (changed) await this.save();
  }
  save() {
    const jobs = [...this.records.values()].filter(r => (r.kind ?? "render") === "render").slice(-60);
    const data = JSON.stringify({ version: 1, jobs }, null, 2);
    const write = async () => {
      await mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, "render-jobs.json");
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, data); await rename(tmp, file);
    };
    const done = this.writes.then(write, write);
    this.writes = done.catch(() => {});
    return done;
  }
  async add(rec, run) {
    await this.load();
    if (this.pending.length + (this.active ? 1 : 0) >= this.limit) {
      throw new Error(`The VFX render queue is full (${this.limit} jobs). Wait or cancel a queued render.`);
    }
    const entry = { rec, run, controller: new AbortController(), ready: false };
    this.records.set(rec.id, rec); this.pending.push(entry); // reserve BEFORE await
    try { await this.save(); entry.ready = true; }
    catch (err) { this.pending = this.pending.filter(x => x !== entry); this.records.delete(rec.id); throw err; }
    this.drain(); return rec;
  }
  drain() {
    if (this.active || !this.pending[0]?.ready) return;
    const entry = this.pending.shift();
    this.active = entry; entry.rec.status = "running";
    (async () => {
      try {
        await this.save();
        if (!entry.controller.signal.aborted) {
          await entry.run(entry.controller.signal);
          if (entry.rec.status === "running") entry.rec.status = "done";
        }
      } catch (err) {
        entry.rec.status = "failed"; entry.rec.error = String(err.message || err);
      } finally {
        if (entry.controller.signal.aborted && !entry.rec.finalized) {
          entry.rec.status = "cancelled"; entry.rec.error = "Cancelled by user or agent.";
        }
        entry.rec.finishedAt = Date.now();
        try { await this.save(); }
        catch (err) { entry.rec.persistenceError = String(err.message || err); }
        this.active = null; this.drain();
      }
    })();
  }
  async cancel(id) {
    await this.load();
    const pending = this.pending.find(x => x.rec.id === id);
    const entry = pending || (this.active?.rec.id === id ? this.active : null);
    if (!entry || entry.rec.finalized) return false;
    entry.controller.abort();
    if (pending) {
      this.pending = this.pending.filter(x => x !== entry);
      entry.rec.status = "cancelled"; entry.rec.finishedAt = Date.now();
      entry.rec.error = "Cancelled before rendering.";
    } else entry.rec.status = "cancelling";
    await this.save(); this.drain(); return true;
  }
}
