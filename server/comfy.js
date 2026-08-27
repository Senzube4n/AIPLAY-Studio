/**
 * ComfyUI supervisor — ONE long-lived process for the lifetime of the app.
 *
 * This is the single most important architectural decision in the product, and the
 * easiest to lose in a refactor. ComfyUI caches node outputs within a process, and
 * the expensive autoregressive stage depends only on (caption, lyrics, seed,
 * max_duration, cfg, top_k). Change nothing but the sampler settings and that stage
 * is reused: measured 246 s -> 130 s, with the AR stage reporting 0.0 s.
 *
 * An identical re-run short-circuits entirely: 258 s -> 0.3 s.
 *
 * Restart per job and all of that is thrown away, the app becomes ~40% slower on
 * every re-roll, and nothing in the UI explains why.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";

export class ComfySupervisor extends EventEmitter {
  /** Consecutive unexpected exits, reset by a render that gets going. */
  #restarts = 0;

  constructor() {
    super();
    this.stopping = false;
    this.proc = null;
    this.ready = false;
    this.startedAt = null;
    /** Populated from the startup log. If the fused CUDA backend is disabled the
     *  whole product claim evaporates — see assertBackend(). */
    this.backend = { cudaFused: null, torch: null, device: null, warnings: [] };
    this.logLines = [];
  }

  get base() {
    return `http://${config.comfy.host}:${config.comfy.port}`;
  }

  /** Change the graphics-memory tier. Flags are read at process start, so this
   *  restarts the engine — which discards the AR cache, hence the warning in the
   *  UI rather than doing it silently. */
  async setTier(tier) {
    const t = config.vramTiers[tier];
    if (!t) throw new Error(`unknown tier: ${tier}`);
    this.tier = tier;
    this.flags = t.flags;
    await this.stop();
    await this.start();
    return this.assertBackend();
  }

  async start() {
    if (this.proc) return;
    /* THE ADOPTION GUARD. Readiness used to be a bare port poll, and a port is
     * not an identity: with another Studio's ComfyUI already on this port, our
     * child died on the bind (exit 1) while the NEIGHBOUR answered the poll —
     * so startup printed "engine ready" and every job ran through the foreign
     * engine, whose --output-directory wins, writing renders into the OTHER
     * install's library. Probing BEFORE spawning turns that incident into a
     * startup error that names the port and the remedy. */
    if (await this.#portAnswers()) {
      throw new Error(
        `port ${config.comfy.port} is already serving another ComfyUI instance — refusing to `
        + `adopt it: its --output-directory would win and this Studio's renders would land in `
        + `the other install's library. Close the other instance, or set AIPLAY_COMFY_PORT to `
        + `a free port for this one and restart.`,
      );
    }
    mkdirSync(config.paths.appData, { recursive: true });
    const logPath = path.join(config.paths.appData, "comfy.log");
    const logFile = createWriteStream(logPath, { flags: "a" });

    const args = [
      path.join(config.comfyDir, "main.py"),
      "--port", String(config.comfy.port),
      "--listen", config.comfy.host,
      "--disable-auto-launch",
      /* Point the engine at the folder Studio scans, instead of assuming the two
       * agree. They used to agree only because outputDir was DERIVED from the
       * ComfyUI path — the moment that became a user setting, an unset flag here
       * would have meant songs written to one place and a library reading
       * another, with no error anywhere. */
      "--output-directory", config.outputDir,
      "--input-directory", config.inputDir,
      ...(this.flags ?? config.comfy.flags),
    ];

    this.startedAt = Date.now();
    this.proc = spawn(config.python, args, {
      cwd: config.comfyDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onChunk = (buf) => {
      const text = buf.toString();
      logFile.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logLines.push(line);
        if (this.logLines.length > 400) this.logLines.shift();
        this.#sniff(line);
      }
    };
    this.proc.stdout.on("data", onChunk);
    this.proc.stderr.on("data", onChunk);

    this.proc.on("exit", (code) => {
      this.ready = false;
      this.proc = null;
      console.error(`[comfy] exited with code ${code}; see ${logPath}`);
      /* AN ENGINE CAN DIE MID-RENDER, and until now nothing downstream was told.
       *
       * The queue checks readiness BEFORE starting a job and retries politely,
       * which is why a cold start recovers — but a job already running holds
       * `current`, and #pump() returns early while `current` is set. So a crash
       * during a render wedged the whole queue silently and forever, which on a
       * hand-driven afternoon looks like one slow song and on an unattended
       * night ends the run at whatever it had reached.
       *
       * Measured cause, 2026-08-27: MiniMax Music's audio VAE aborted inside a
       * conv during decode after all 15 sampling steps had completed — the
       * expensive part done and thrown away.
       *
       * Two things have to happen and neither is optional: tell the listeners
       * so the in-flight job can be failed and the queue can move on, and bring
       * the engine back. A deliberate stop() sets `stopping`, so restarting the
       * app or switching tiers does not trigger a respawn race. */
      if (this.stopping) return;
      this.emit("died", { code });
      const wait = Math.min(30_000, 3000 * 2 ** this.#restarts++);
      /* Backoff, and a ceiling on attempts: an engine that cannot start is a
       * problem to report, not to hammer. */
      if (this.#restarts <= 6) {
        console.error(`[comfy] restarting in ${Math.round(wait / 1000)}s (attempt ${this.#restarts})`);
        setTimeout(() => {
          this.start().catch((e) => console.error(`[comfy] restart failed: ${e.message}`));
        }, wait);
      } else {
        console.error("[comfy] giving up after six restarts — see comfy.log");
        this.emit("gaveup");
      }
    });

    await this.#waitForReady();
    /* Back on its feet: a clean start clears the backoff so a crash weeks
     * later gets its full six attempts rather than inheriting a stale count. */
    this.#restarts = 0;
    this.stopping = false;
  }

  /**
   * Read the startup log for the one thing that silently costs 4.9x.
   *
   * With a cu128 torch build ComfyUI disables its comfy_kitchen fused-CUDA backend
   * — the int8 convrot kernels this model actually needs — and falls back to
   * `eager`. It prints ONE warning and then runs fine, just five times slower.
   * Almost nobody notices. Detecting it is the core of the product's claim.
   */
  #sniff(line) {
    const clean = line.replace(/\[[0-9;]*m/g, "");
    if (clean.includes("comfy_kitchen backend cuda")) {
      this.backend.cudaFused = /'disabled':\s*False/.test(clean);
    }
    const torch = clean.match(/pytorch version:\s*([^\s]+)/i);
    if (torch) this.backend.torch = torch[1];
    const dev = clean.match(/Device:\s*(.+)$/);
    if (dev) this.backend.device = dev[1].trim();
    if (/You need pytorch with cu\d+ or higher/i.test(clean)) {
      this.backend.warnings.push(clean.trim());
    }
  }

  /** Does ANYTHING answer on our port right now? Deliberately identity-blind —
   *  which is exactly why it may only ever gate, never confirm: a 200 here can
   *  be a neighbour's instance as easily as our child. */
  async #portAnswers() {
    try {
      const r = await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  #childAlive() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  async #waitForReady() {
    const deadline = Date.now() + config.comfy.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.#childAlive()) throw new Error("ComfyUI exited during startup; check comfy.log");
      let answered = false;
      try {
        const r = await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(2000) });
        answered = r.ok;
      } catch {
        /* not up yet */
      }
      if (answered) {
        /* The port answering is NOT proof our child answered (see start()'s
         * adoption guard). A child that lost the bind race dies within moments
         * of the port first answering, so give that exit a beat to surface and
         * then require the child alive — a dead child must never report ready,
         * whatever the port says. */
        await sleep(750);
        if (!this.#childAlive()) {
          throw new Error(
            `ComfyUI exited during startup while port ${config.comfy.port} kept answering — `
            + `a FOREIGN ComfyUI instance holds the port and must not be adopted (its `
            + `--output-directory would swallow this Studio's renders). Close the other `
            + `instance, or set AIPLAY_COMFY_PORT to a free port and restart. See comfy.log.`,
          );
        }
        this.ready = true;
        return;
      }
      await sleep(600);
    }
    throw new Error("ComfyUI did not become ready in time");
  }

  /**
   * The check the first-run warm-up must gate on. A build that ships on cu128
   * gives the user a silently 4.9x-slower app with no error, which is worse than
   * refusing to start.
   */
  assertBackend() {
    if (this.backend.cudaFused === false) {
      return {
        ok: false,
        code: "FUSED_BACKEND_DISABLED",
        message:
          "This install is running about 5x slower than it should. PyTorch needs CUDA 13.0 " +
          "or newer, otherwise the model's optimised kernels are disabled. " +
          `Detected torch: ${this.backend.torch || "unknown"}.`,
        fix: "Reinstall torch from the cu130 index, then restart AIPLAY Studio.",
      };
    }
    return { ok: true, torch: this.backend.torch, device: this.backend.device };
  }

  async submit(graph, clientId) {
    /* The same identity rule at the job door: if OUR child is not alive, the
     * thing answering this port (if anything) is somebody else's engine, and a
     * job posted to it renders into somebody else's library. */
    if (!this.ready || !this.#childAlive()) {
      throw new Error(
        `the engine is not running (this Studio's ComfyUI child is not alive) — refusing to `
        + `submit to port ${config.comfy.port}, which may be another instance's server.`,
      );
    }
    const r = await fetch(`${this.base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`ComfyUI rejected the job: ${detail.slice(0, 600)}`);
    }
    return (await r.json()).prompt_id;
  }

  async interrupt() {
    try {
      await fetch(`${this.base}/interrupt`, { method: "POST" });
    } catch {
      /* best effort */
    }
  }

  async stop() {
    /* Deliberate. Without this flag the exit handler would treat a restart or a
     * shutdown as a crash and race a respawn against the caller. */
    this.stopping = true;
    if (!this.proc) return;
    this.proc.kill();
    await sleep(400);
    if (this.proc) this.proc.kill("SIGKILL");
    /* Wait for the exit to actually land: a restart (setTier) probes the port
     * before spawning, and OUR OWN dying instance still holding the socket
     * must not be mistaken for a foreign one. */
    for (let i = 0; i < 25 && this.proc; i++) await sleep(200);
  }
}
