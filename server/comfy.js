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
 *
 * ── WHAT THIS FILE NO LONGER DOES ─────────────────────────────────────────
 *
 * It used to be a supervisor AND half an engine client: `get base()`,
 * `submit()`, `interrupt()`, and four bare `fetch()` calls. That second job has
 * moved WHOLE to `server/engine/client.js`, and this file now contains no
 * `fetch(` at all — asserted by `server/engine/ui_test.js`, because a
 * supervisor that can also post a prompt is a second door however carefully it
 * is written.
 *
 * What it kept is everything that is actually about a child process: the
 * lifecycle, the tier flags, the startup-log sniffing that catches a 4.9x
 * regression, the crash backoff, and BOTH halves of the adoption guard. Those
 * were each written after a measured incident and none of them moved.
 *
 * The one visible change: THE PORT IS NO LONGER A CONSTANT. It is reserved from
 * the OS at every start (including the crash-restart path and setTier), so two
 * Studios on one machine cannot collide at all, and a script cannot bake the
 * number in — which is the whole point, since fifteen scripts across two repos
 * had 8266 copied into them. `AIPLAY_COMFY_PORT` still pins it, loudly.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { buildLaunchArgs } from "./comfyargs.js";
import { deployStudioNodes } from "./comfy_nodes.js";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { engine } from "./engine/client.js";
import { setGpuFallback } from "./gpu.js";
import { writeModelPathsYaml, samePath } from "./localmodels.js";

/**
 * The environment an ACTIVATED venv would have: the interpreter's own folder
 * first on PATH, and VIRTUAL_ENV set when it is a venv.
 *
 * Launching `venv\Scripts\python.exe` directly skips activation, and a ROCm
 * torch (TheRock wheels) ships its helper tools — hipInfo.exe, rocm-sdk.exe —
 * in that Scripts folder and runs them at startup to identify the card. Without
 * this the engine logs "Could not detect ROCm GPU architecture: [WinError 2]",
 * which ComfyUI Desktop (it activates the venv) never shows. Harmless for CUDA
 * and portable builds: prepending the interpreter's folder changes nothing there.
 */
function pythonEnv(python) {
  const env = { ...process.env };
  const binDir = path.dirname(python);
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  env[key] = [binDir, env[key]].filter(Boolean).join(path.delimiter);
  const venvRoot = path.dirname(binDir);
  if (existsSync(path.join(venvRoot, "pyvenv.cfg"))) env.VIRTUAL_ENV = venvRoot;
  /* UTF-8 stdio. From a plain cmd window Python's piped stdout is cp1252, and
   * the first custom node that prints an emoji (rgthree-comfy's 🎉) raises
   * UnicodeEncodeError inside logging and kills startup with exit code 1. */
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

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
    /** The port this start() reserved. Kept only so the error messages below
     *  can name it; nothing builds a URL from it — see engine/client.js. */
    this.port = null;
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
    /* A tier change restarts the engine, which in ephemeral mode also REBINDS
     * it. Both facts belong on `asset:"engine"`, so /api/provenance?asset=engine
     * reads as the whole history of what this install did to its own engine. */
    await engine.announceTier(tier);
    return this.assertBackend();
  }

  async start() {
    if (this.proc) return;
    /* THE PORT, CHOSEN FRESH AT EVERY START — including the crash-restart path
     * below and setTier's restart above.
     *
     * A constant is a thing a script bakes in, and that is not a hypothetical:
     * 8266 was copied verbatim into fifteen scripts here and three in the other
     * repo, and in one night those posted 245 renders straight past the ledger.
     * Moving the constant to another number just changes which constant gets
     * copied. A number that is different every run cannot be copied at all.
     *
     * `pinFromEnv()` honours AIPLAY_COMFY_PORT for installs that pinned it after
     * a real collision — loudly, saying what it costs, and leaving a dated line
     * in the ledger via announcePort() below. */
    this.port = engine.pinFromEnv() ?? await engine.reservePort();
    /* THE ADOPTION GUARD. Readiness used to be a bare port poll, and a port is
     * not an identity: with another Studio's ComfyUI already on this port, our
     * child died on the bind (exit 1) while the NEIGHBOUR answered the poll —
     * so startup printed "engine ready" and every job ran through the foreign
     * engine, whose --output-directory wins, writing renders into the OTHER
     * install's library. Probing BEFORE spawning turns that incident into a
     * startup error that names the port and the remedy.
     *
     * ⚠ AN EPHEMERAL PORT MAKES THIS RARE, NOT UNNECESSARY. Something can still
     * take the port between our close and ComfyUI's bind — the window is
     * milliseconds, and this is what catches it. It stays, both halves. */
    if (await this.#portAnswers()) {
      throw new Error(
        `port ${this.port} is already serving another ComfyUI instance — refusing to `
        + `adopt it: its --output-directory would win and this Studio's renders would land in `
        + `the other install's library. `
        + (engine.mode === "pinned"
          ? `Close the other instance, or set AIPLAY_COMFY_PORT to a free port for this one `
            + `and restart — or unset it entirely and let the app pick an unpublished port at `
            + `every start, which makes this collision impossible.`
          : `The app picks an unpublished port at every start, so something took this one in `
            + `the moment between reserving it and launching: restarting will choose another. `
            + `(AIPLAY_COMFY_PORT is not set; setting it would pin the port and bring this `
            + `collision back.)`),
      );
    }
    mkdirSync(config.paths.appData, { recursive: true });
    const logPath = path.join(config.paths.appData, "comfy.log");
    const logFile = createWriteStream(logPath, { flags: "a" });

    /* A models folder outside the install (Models screen, or a Desktop default)
     * is handed to ComfyUI as one more extra_model_paths YAML, so the engine
     * loads from the folder Studio checks and downloads into. */
    /* The Studio's own nodes (server/comfy_nodes/*.py) ride into the engine's
     * custom_nodes folder, copied only when their bytes changed. */
    try {
      const d = deployStudioNodes(path.join(config.comfyDir, "custom_nodes"));
      if (d.copied.length) console.log(`[comfy] studio nodes deployed: ${d.copied.join(", ")}`);
    } catch (err) {
      console.error(`[comfy] could not deploy the studio nodes: ${err.message}`);
    }
    const modelArgs = [];
    if (!samePath(config.modelsDir, path.join(config.comfyDir, "models"))) {
      try {
        modelArgs.push("--extra-model-paths-config", await writeModelPathsYaml(config.modelsDir, config.paths.appData));
      } catch (err) {
        console.error(`[comfy] could not write the models-folder config: ${err.message}`);
      }
    }

    const args = [
      path.join(config.comfyDir, "main.py"),
      "--port", String(this.port),
      /* Loopback, and the address comes from the client so that the thing that
       * BINDS and the thing that CONNECTS cannot drift apart. Nothing off this
       * machine can reach the engine; on this machine, see the residual stated
       * at the top of engine/client.js. */
      "--listen", engine.listenHost,
      "--disable-auto-launch",
      /* Point the engine at the folder Studio scans, instead of assuming the two
       * agree. They used to agree only because outputDir was DERIVED from the
       * ComfyUI path — the moment that became a user setting, an unset flag here
       * would have meant songs written to one place and a library reading
       * another, with no error anywhere. */
      "--output-directory", config.outputDir,
      "--input-directory", config.inputDir,
      /* Tier flags, then the install's own flags, then the launcher's
       * Advanced choices — each choice replacing its family in the first two
       * (server/comfyargs.js), so argparse never sees two exclusive flags. */
      ...buildLaunchArgs({
        tierFlags: this.flags ?? config.comfy.flags,
        installFlags: config.comfy.extraArgs,
        useInstallFlags: config.comfy.useInstallFlags,
        values: config.comfy.options,
      }),
      ...modelArgs,
    ];

    this.startedAt = Date.now();
    this.proc = spawn(config.python, args, {
      cwd: config.comfyDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: pythonEnv(config.python),
    });
    /* IDENTITY, not a port. `engine.isOurs()` is how the rest of the app asks
     * "is the thing on the other end of that socket the child WE started" — the
     * question a 200 from /system_stats can never answer. */
    engine.attachChild(this.proc);

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
      /* Detach FIRST, before anything downstream can be told. From this instant
       * `engine.isOurs()` is false, so dispatch() refuses rather than posting a
       * job at a port whose owner just died — which, if a neighbour then took
       * the port, is exactly how renders land in another install's library. */
      engine.detachChild();
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
    /* On ROCm the fused kernels live in the `hip` backend and `cuda` reports
     * disabled, so either one enabled counts as fused. */
    const ck = clean.match(/comfy_kitchen backend (cuda|hip)\b/);
    if (ck) {
      const on = /'disabled':\s*False/.test(clean);
      if (on) this.backend.cudaFused = true;
      else if (this.backend.cudaFused !== true) this.backend.cudaFused = false;
    }
    const vram = clean.match(/Total VRAM (\d+) MB/);
    if (vram) this.backend.totalVramMb = Number(vram[1]);
    const torch = clean.match(/pytorch version:\s*([^\s]+)/i);
    if (torch) this.backend.torch = torch[1];
    const dev = clean.match(/Device:\s*(.+)$/);
    if (dev) this.backend.device = dev[1].trim();
    /* torch names the card and its VRAM on CUDA and ROCm alike — the only
     * reading an AMD machine gets, since nvidia-smi does not exist there. */
    if ((vram || dev) && this.backend.device && this.backend.totalVramMb) {
      setGpuFallback({
        name: this.backend.device.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*[\w-]+$/, ""),
        totalMb: this.backend.totalVramMb,
        source: "ComfyUI startup log",
      });
    }
    if (/You need pytorch with cu\d+ or higher/i.test(clean)) {
      this.backend.warnings.push(clean.trim());
    }
  }

  /** Does ANYTHING answer on our port right now? Deliberately identity-blind —
   *  which is exactly why it may only ever gate, never confirm: a 200 here can
   *  be a neighbour's instance as easily as our child.
   *
   *  Kept as a named method over the client's probe rather than inlined: what
   *  `scripts/test_matrixfix.mjs` pins is that start() asks this question BEFORE
   *  it spawns, and a check whose subject has no name is a check that quietly
   *  stops being about anything. */
  async #portAnswers() {
    return engine.probePort();
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
        await engine.systemStats(2000);
        answered = true;
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
            `ComfyUI exited during startup while port ${this.port} kept answering — `
            + `a FOREIGN ComfyUI instance holds the port and must not be adopted (its `
            + `--output-directory would swallow this Studio's renders). Close the other `
            + `instance, or set AIPLAY_COMFY_PORT to a free port and restart. See comfy.log.`,
          );
        }
        this.ready = true;
        /* Read the engine's own launch flags ONCE, here, so every record this
         * session writes can carry its version and argv hash. Deliberately not
         * from dispatch(): that function must make exactly ONE wire call before
         * it polls, so "the ledger threw, therefore nothing was sent" stays
         * provable by counting fetches. Never fatal — an argv we could not read
         * is a null in a record, not a failed startup. */
        await engine.refreshFacts();
        /* One `choice` on asset:"engine" per start, saying how exposed this
         * session is. In pinned mode it says so in the ledger as well as in the
         * console, which is what lets the record answer, months later, "were the
         * renders in this window complete?" */
        await engine.announcePort();
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

  /* `submit()`, `interrupt()` and `get base()` USED TO LIVE HERE.
   *
   * They are gone, and the identity rule they carried is not: it moved into
   * `engine.dispatch()` word for word — if this Studio's child is not alive,
   * whatever is answering (if anything) is somebody else's engine, and a job
   * posted to it renders into somebody else's library. What dispatch() adds is
   * that the run is written to the ledger BEFORE the POST, which is the one
   * thing a bare submit() could never do.
   *
   * Callers use `engine.run` / `engine.submit` / `engine.interrupt`. This class
   * supervises a process; it does not talk to it. */

  async stop() {
    /* Deliberate. Without this flag the exit handler would treat a restart or a
     * shutdown as a crash and race a respawn against the caller. */
    this.stopping = true;
    if (!this.proc) { engine.detachChild(); return; }
    this.proc.kill();
    await sleep(400);
    if (this.proc) this.proc.kill("SIGKILL");
    /* Wait for the exit to actually land: a restart (setTier) probes the port
     * before spawning, and OUR OWN dying instance still holding the socket
     * must not be mistaken for a foreign one. */
    for (let i = 0; i < 25 && this.proc; i++) await sleep(200);
  }
}
