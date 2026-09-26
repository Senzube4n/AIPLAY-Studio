/** Local UI fixture. No GPU, model downloads, RunPod account or cloud requests. */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createWorker } from "../worker/runpod-worker.js";
import { readBody, sendJSON } from "../server/engine/remote-common.js";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-mock-worker-"));
const inputDir = path.join(root, "input"), outputDir = path.join(root, "output");
await mkdir(outputDir, { recursive: true });
const token = "local-demo-token-not-a-secret-1234567890";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const history = {}, queue = [];
const info = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["MOCK-NO-GPU.safetensors"]] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } } },
  EmptyLatentImage: { input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } } },
  KSampler: { input: { required: { model: ["MODEL"], positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"], seed: ["INT"] } } },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } } },
  ImageScale: { input: { required: { image: ["IMAGE"], width: ["INT"], height: ["INT"] } } },
};
const fake = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/system_stats") return sendJSON(res, 200, { system: { comfyui_version: "MOCK" }, devices: [{ name: "SIMULATED GPU · no rendering charges" }] });
    if (url.pathname === "/object_info") return sendJSON(res, 200, info);
    if (url.pathname === "/prompt") {
      const body = JSON.parse((await readBody(req)).toString());
      const id = randomUUID(), row = [0, id, body.prompt, body.extra_data];
      queue.push(row);
      setTimeout(async () => {
        try {
          if (!queue.includes(row)) return;
          const filename = `${id}.png`;
          await writeFile(path.join(outputDir, filename), png);
          history[id] = { prompt: row, status: { completed: true, status_str: "success" }, outputs: { "7": { images: [{ filename, subfolder: "", type: "output" }] } } };
          queue.splice(queue.indexOf(row), 1);
        } catch (error) { console.error(error.message); }
      }, 1000);
      return sendJSON(res, 200, { prompt_id: id });
    }
    if (url.pathname === "/queue") return sendJSON(res, 200, { queue_running: queue, queue_pending: [] });
    if (url.pathname.startsWith("/history")) {
      const id = url.pathname.split("/")[2];
      return sendJSON(res, 200, id ? history[id] ? { [id]: history[id] } : {} : history);
    }
    sendJSON(res, 404, {});
  } catch (error) { sendJSON(res, 400, { error: error.message }); }
});
await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
const worker = await createWorker({ token, comfyURL: `http://127.0.0.1:${fake.address().port}`,
  inputDir, outputDir, stateDir: path.join(root, "state"), pollMs: 250 });
worker.server.listen(8788, "127.0.0.1", () => {
  console.log("LOCAL MOCK ONLY: http://127.0.0.1:8788");
  console.log(`Demo token: ${token}`);
  console.log(`Temporary test files: ${root}`);
  console.log("Use a separate AIPLAY_APPDATA directory. Outputs are test pixels, not generated media.");
});
