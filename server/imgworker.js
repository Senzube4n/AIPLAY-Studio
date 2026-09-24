/* THE WARM PYTHON, AND WHY THERE IS ONE.
 *
 * Measured on this machine at 1024x1024, through the live route:
 *
 *     one brush stroke, end to end         653 ms
 *     the same call with ops={} - NO WORK   596 ms
 *     the stroke rasterisation itself        11 ms
 *
 * An edit that does nothing costs 91% of an edit that does something, because
 * every request spawns a fresh interpreter and pays numpy + cv2 + PIL again
 * (~390 ms of it). Through this worker the same edits measure 126 ms for the
 * first and then 65-71 ms - about ten times faster, and inside the budget where
 * dragging a brush stops feeling like submitting a form.
 *
 * ⚠ ONE WORKER, SERIALISED, AND THAT IS DELIBERATE. The engine is numpy on a
 * single picture; two concurrent renders would contend for the same cores and
 * the same cache, and a pool would need every caller to think about which
 * worker holds which decoded source. Requests queue in arrival order.
 *
 * ⚠ IT IS FOR PREVIEWS, NOT FOR COMMITS. Nothing here writes the library, files
 * provenance or makes a thumbnail. The committing routes keep their own spawn:
 * a preview that dies costs a frame, and a commit that dies costs the work.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ImgWorker {
  /* `script` is imgworker.py; a test passes a stand-in so a worker that dies
   * on a missing module can be driven without a python. */
  constructor(python, { onLog = () => {}, script = path.join(__dirname, "imgworker.py") } = {}) {
    this.python = python;
    this.onLog = onLog;
    this.script = script;
    this.stderrTail = "";
    this.proc = null;
    this.buf = "";
    this.next = 1;
    this.pending = new Map();
    this.ready = null;
  }

  /* Spawned on first use rather than at boot: a studio that never opens the
   * image editor should not hold an idle interpreter, and the 258 ms handshake
   * is paid once by whoever asks first. */
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.python, [this.script], { windowsHide: true });
      this.stderrTail = "";
      this.proc = proc;
      let settled = false;
      proc.stdout.on("data", (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { this.onLog(`[imgworker] ${line.slice(0, 200)}`); continue; }
          if (msg.ready && !settled) { settled = true; resolve(this); continue; }
          const w = this.pending.get(msg.id);
          if (w) { this.pending.delete(msg.id); w.resolve(msg); }
        }
      });
      proc.stderr.on("data", (d) => {
        this.onLog(`[imgworker] ${String(d).trim().slice(0, 400)}`);
        /* The last few KB are kept for the error a death rejects with: a
         * worker whose `import imagetools` fails on a missing cv2 dies before
         * its handshake, and "exited (1)" alone told the person nothing. The
         * door reads `err.stderr` for the module (engineModuleRefusal). */
        this.stderrTail = (this.stderrTail + d).slice(-4096);
      });
      /* ⚠ A DEAD WORKER MUST REJECT EVERY WAITER. Without this the caller's
       * promise never settles and the request hangs until the browser gives
       * up — the failure mode that looks like the studio freezing. */
      const die = (why) => {
        this.proc = null; this.ready = null;
        const stderr = this.stderrTail;
        const last = stderr.trim().split(/\r?\n/).pop() || "";
        const fail = () => Object.assign(new Error(`image worker ${why}${last ? `: ${last.slice(0, 300)}` : ""}`), { stderr });
        for (const [, w] of this.pending) w.reject(fail());
        this.pending.clear();
        if (!settled) { settled = true; reject(fail()); }
      };
      proc.on("error", (err) => die(`could not start: ${err.message}`));
      /* 'close', not 'exit': 'exit' can come before the last of stderr has
       * been read, and the tail is what says which module was missing. */
      proc.on("close", (code) => die(`exited (${code})`));
    });
    return this.ready;
  }

  /** One job. Resolves with the engine's own reply object. */
  async run(mode, job, { timeoutMs = 30_000 } = {}) {
    await this.start();
    const id = this.next++;
    const reply = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`image worker timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(t); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, mode, job })}\n`);
      } catch (err) {
        this.pending.delete(id); clearTimeout(t); reject(err);
      }
    });
    /* The engine's own sentence; a lazy import that failed inside it (scipy
     * for curves) reads "ModuleNotFoundError: No module named 'scipy'", which
     * the door turns into the engine-package refusal. */
    if (reply.ok === false) throw Object.assign(new Error(reply.error || "image worker refused the job"), { stderr: reply.error || "" });
    return reply;
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* already gone */ } }
    this.proc = null; this.ready = null;
  }
}
