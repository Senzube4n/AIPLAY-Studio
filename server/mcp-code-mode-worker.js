import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";

const MEMORY_LIMIT = 16 * 1024 * 1024;
const STACK_LIMIT = 256 * 1024;
const ERROR_LIMIT = 400;

// Compile the bridge separately so the supplied function has no lexical access
// to the host callback. All data crossing that callback is already JSON text.
const MAKE_WORKFLOW = `(() => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const create = Object.create;
  const freeze = Object.freeze;
  return async (request, names, workflow) => {
    const tools = create(null);
    for (const name of parse(names)) {
      tools[name] = async (args = {}) => {
        const json = stringify(args);
        if (typeof json !== "string") throw new TypeError("Tool arguments must be JSON.");
        return parse(await request(name, json));
      };
    }
    const value = await workflow(freeze(tools));
    const json = stringify(value);
    if (typeof json !== "string") throw new TypeError("Return a JSON value from the workflow.");
    return json;
  };
})()`;

const DESCRIBE_ERROR = `(() => {
  const string = String;
  const slice = Function.call.bind(String.prototype.slice);
  return (error) => slice(string(error), 0, ${ERROR_LIMIT});
})()`;

async function runWorkflow({ code, toolNames, timeoutMs, maxCalls, maxInputBytes, maxResultBytes }) {
  const deadline = performance.now() + timeoutMs;
  const quickjs = await newQuickJSWASMModuleFromVariant(releaseSync);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(STACK_LIMIT);
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const context = runtime.newContext();
  const allowed = new Set(toolNames);
  const pending = new Map();
  const handles = [];
  let nextCallId = 0;
  let callLimitExceeded = false;
  let onReply;
  let describeError;

  function guestError(error) {
    try {
      if (performance.now() >= deadline) return new Error("Workflow timed out.");
      if (describeError) {
        const described = context.callFunction(describeError, context.undefined, error);
        if (described.error) described.error.dispose();
        else return new Error(described.value.consume((value) => context.getString(value)));
      }
      return new Error("Workflow execution failed.");
    } finally {
      error.dispose();
    }
  }

  function keep(result) {
    if (result.error) throw guestError(result.error);
    handles.push(result.value);
    return result.value;
  }

  try {
    describeError = keep(context.evalCode(DESCRIBE_ERROR, "studio-errors.js"));
    const makeWorkflow = keep(context.evalCode(MAKE_WORKFLOW, "studio-tools.js"));
    const workflow = keep(context.evalCode(`(async function(tools) {\n"use strict";\n${code}\n})`, "studio-workflow.js"));
    if (context.typeof(workflow) !== "function") throw new Error("Expected an async workflow body.");
    const names = context.newString(JSON.stringify(toolNames));
    handles.push(names);
    const request = context.newFunction("requestStudioTool", (nameValue, argsValue) => {
      if (context.typeof(nameValue) !== "string" || context.typeof(argsValue) !== "string") {
        throw new TypeError("Tool requests must contain JSON arguments.");
      }
      const name = context.getString(nameValue);
      if (!allowed.has(name)) throw new Error("Tool is unavailable in Code Mode.");
      const argsJson = context.getString(argsValue);
      if (Buffer.byteLength(argsJson) > maxInputBytes) throw new Error("Tool arguments are too large.");
      if (nextCallId >= maxCalls) {
        callLimitExceeded = true;
        throw new Error(`Studio Code Mode allows at most ${maxCalls} tool calls per run.`);
      }
      const deferred = context.newPromise();
      const id = ++nextCallId;
      pending.set(id, deferred);
      parentPort.postMessage({ type: "call", id, name, argsJson });
      return deferred.handle;
    });
    handles.push(request);
    const completion = keep(context.callFunction(makeWorkflow, context.undefined, request, names, workflow));

    return await new Promise((resolve, reject) => {
      function advance() {
        const jobs = runtime.executePendingJobs();
        if (callLimitExceeded) {
          jobs.error?.dispose();
          throw new Error(`Studio Code Mode allows at most ${maxCalls} tool calls per run.`);
        }
        if (jobs.error) throw guestError(jobs.error);
        const state = context.getPromiseState(completion);
        if (state.type === "rejected") throw guestError(state.error);
        if (state.type === "pending") {
          if (!pending.size) throw new Error("Workflow is awaiting a promise that cannot finish.");
          return;
        }
        const json = state.value.consume((value) => context.getString(value));
        if (Buffer.byteLength(json) > maxResultBytes) throw new Error("Workflow result is too large.");
        resolve(json);
      }

      onReply = (message) => {
        if (message.type !== "reply") return;
        const deferred = pending.get(message.id);
        if (!deferred) return;
        pending.delete(message.id);
        try {
          if (typeof message.error === "string") {
            context.newError(message.error.slice(0, ERROR_LIMIT)).consume((value) => deferred.reject(value));
          } else {
            context.newString(message.json).consume((value) => deferred.resolve(value));
          }
          advance();
        } catch (error) {
          reject(error);
        } finally {
          deferred.dispose();
        }
      };
      parentPort.on("message", onReply);
      advance();
    });
  } finally {
    if (onReply) parentPort.off("message", onReply);
    for (const deferred of pending.values()) deferred.dispose();
    for (const handle of handles.reverse()) handle.dispose();
    context.dispose();
    runtime.dispose();
  }
}

try {
  const json = await runWorkflow(workerData);
  parentPort.postMessage({ type: "result", json });
} catch (error) {
  const message = error instanceof Error ? error.message : "Workflow execution failed.";
  parentPort.postMessage({ type: "error", message: message.slice(0, ERROR_LIMIT) });
}
