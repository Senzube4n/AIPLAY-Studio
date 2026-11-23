import { Worker } from "node:worker_threads";

// Review each operation here for side effects. Some Studio reads use POST.
const READ_TOOLS = [
  "mv_list_projects",
  "mv_open_project",
  "mv_lint",
  "mv_shot",
  "models_for_this_machine",
];
const TIMEOUT_MS = 5_000;
const MAX_CALLS = 32;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
export const CODE_MODE_READ_LIMIT = 1024 * 1024;
const MAX_RUNS = 2;
let activeRuns = 0;

function readArguments(json, { name, inputSchema }) {
  if (typeof json !== "string" || Buffer.byteLength(json) > MAX_INPUT_BYTES) {
    throw new Error(`${name} arguments must fit in 16 KiB of JSON.`);
  }
  const args = JSON.parse(json);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${name} arguments must be a JSON object.`);
  }
  const { properties, required = [] } = inputSchema;
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error(`${name} requires ${key}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    // The pilot allowlist uses only string and boolean arguments.
    if (!Object.hasOwn(properties, key) || typeof value !== properties[key].type) {
      throw new Error(`${name} received an invalid argument.`);
    }
  }
  return args;
}

async function runProgram(code, allowed, runRead) {
  const abort = new AbortController();
  const worker = new Worker(new URL("./mcp-code-mode-worker.js", import.meta.url), {
    workerData: {
      code, toolNames: [...allowed.keys()], timeoutMs: TIMEOUT_MS, maxCalls: MAX_CALLS,
      maxInputBytes: MAX_INPUT_BYTES, maxResultBytes: MAX_RESULT_BYTES,
    },
    env: {},
    execArgv: [],
  });
  let timer;
  let calls = 0;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Studio Code Mode timed out.")), TIMEOUT_MS);
      worker.once("error", (cause) => reject(new Error("Studio Code Mode worker failed.", { cause })));
      worker.once("exit", () => reject(new Error("Studio Code Mode worker exited before returning a result.")));
      worker.on("message", async (message) => {
        if (abort.signal.aborted) return;
        if (message.type === "error") {
          reject(new Error(message.message));
          return;
        }
        if (message.type === "result") {
          try {
            if (Buffer.byteLength(message.json) > MAX_RESULT_BYTES) {
              throw new Error("Studio Code Mode result exceeds 64 KiB. Return a smaller summary.");
            }
            resolve(JSON.parse(message.json));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (message.type !== "call") return;
        if (++calls > MAX_CALLS) {
          reject(new Error(`Studio Code Mode allows at most ${MAX_CALLS} tool calls per run.`));
          return;
        }
        const reply = { type: "reply", id: message.id };
        try {
          const tool = allowed.get(message.name);
          if (!tool) throw new Error("That tool is unavailable in Studio Code Mode.");
          const args = readArguments(message.argsJson, tool);
          reply.json = JSON.stringify(await runRead(tool, args, abort.signal));
          if (typeof reply.json !== "string" || Buffer.byteLength(reply.json) > CODE_MODE_READ_LIMIT) {
            delete reply.json;
            throw new Error(`${tool.name} did not return JSON within the 1 MiB read limit.`);
          }
        } catch (error) {
          reply.error = String(error.message || error).slice(0, 1000);
        }
        if (!abort.signal.aborted) worker.postMessage(reply);
      });
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
    await worker.terminate();
  }
}

export function codeModeTool(getTool, runRead) {
  return {
    name: "studio_run",
    jsonOnly: true,
    description: "Run a read-only Studio workflow in local sandboxed JavaScript. "
      + "Use an async function body with an explicit JSON return value. "
      + "Call tools.mv_list_projects(), tools.mv_open_project({slug}), tools.mv_lint({slug}), "
      + "tools.mv_shot({slug, segment}), or tools.models_for_this_machine({all}). "
      + "These calls return promises, so independent reads can use Promise.all. "
      + "Use up to 32 reads within 5 seconds and return a compact result.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", minLength: 1, maxLength: MAX_INPUT_BYTES } },
      required: ["code"],
      additionalProperties: false,
    },
    async run(args) {
      const { code } = args;
      if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > MAX_INPUT_BYTES
        || Object.keys(args).some((key) => key !== "code")) {
        throw new Error("Supply a nonempty code string of at most 16 KiB.");
      }
      if (activeRuns >= MAX_RUNS) throw new Error("Studio Code Mode is busy. Try again when a run finishes.");
      const allowed = new Map(READ_TOOLS.map((name) => [name, getTool(name)]));
      activeRuns++;
      try {
        return await runProgram(code, allowed, runRead);
      } finally {
        activeRuns--;
      }
    },
  };
}
