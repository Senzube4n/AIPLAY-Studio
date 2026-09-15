import assert from "node:assert/strict";
import { test } from "node:test";
import { planMusic, createMusicPlanRoutes } from "./music-plan.js";
import { musicPlanTools } from "./mcp-music-plan.js";
import { Worker } from "node:worker_threads";
import { Readable } from "node:stream";
import { MUSIC_PLAN_BODY_LIMIT } from "./music-plan.js";

const abc = ['X:1', 'T:', 'M:4/4', 'L:1/16', 'Q:1/4=120',
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."', 'K:C', '% verse',
  'V: Vocal', '"C"C4D4E4G4|"F"A4G4E4C4|', 'V: Ins', 'C8G8|F8C8|'].join('\n');

test("outline uses musical units, rounds to bars and never promises generation", () => {
  assert.equal(planMusic({ bpm: 120, meter: "4/4", target_seconds: 180 }).bars, 90);
  assert.equal(planMusic({ bpm: 120, meter: "6/8", bars: 4 }).nominal_seconds, 6);
  const p = planMusic({ bpm: 90, meter: "3/4", target_seconds: 5 });
  assert.equal(p.bars, 3); assert.equal(p.nominal_seconds, 6);
  assert.equal(p.generated_audio, false); assert.equal(p.saved, false); assert.equal(p.abc, undefined);
  assert.match(p.note, /not guaranteed|not a generated melody/);
});
test("supplied score derives duration from note content and proposes a non-mutating tempo edit", () => {
  const p = planMusic({ abc });
  assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.bars, 2); assert.equal(p.nominal_seconds, 4);
  assert.equal(p.changed, false); assert.equal(p.abc, abc);
  const fit = planMusic({ abc, target_seconds: 8 });
  assert.equal(fit.bpm, 60); assert.equal(fit.nominal_seconds, 8); assert.equal(fit.changed, true);
  assert.equal(fit.abc.replace('Q:1/4=60', 'Q:1/4=120'), abc);
  assert.equal(planMusic({ abc, bpm: 240 }).nominal_seconds, 2);
});
test("malformed/mismatched notation is not silently treated as a valid duration", () => {
  assert.equal(planMusic({ abc: abc.replace('M:4/4', 'M:2/4') }).ok, false);
  assert.equal(planMusic({ abc: 'hello' }).ok, false);
  assert.throws(() => planMusic({ abc, target_seconds: 900 }), /outside/);
});
test("bounds, conflicting inputs and fake audio-extension fields are refused", () => {
  for (const value of [null, [], 0, 'hi']) assert.throws(() => planMusic(value));
  for (const bpm of ['120', NaN, Infinity, 0, 401, 25.5]) assert.throws(() => planMusic({ bpm }));
  for (const bars of [0, 1025, 1.5, '20']) assert.throws(() => planMusic({ bars }));
  for (const target_seconds of [0, 901, '30', NaN]) assert.throws(() => planMusic({ target_seconds }));
  for (const input of [{ abc, bpm: 120, target_seconds: 5 }, { abc, bars: 4 }, { abc, meter: '4/4' }, { bars: 4, target_seconds: 4 }, { audio_input: 'song.wav' }, { meter: 'garbage' }, { abc: 'é'.repeat(32769) }, { abc: '\0' }]) assert.throws(() => planMusic(input));
});
test("HTTP and MCP share the same read-only planning contract", async () => {
  let answer, calls = 0;
  const route = createMusicPlanRoutes({ json: (_res, status, body) => { answer = { status, body }; }, readBody: async req => req.body });
  const invoke = async body => { await route({ method: 'POST', body }, {}, new URL('http://localhost/api/music-plan')); return answer; };
  assert.equal((await invoke({ abc })).body.nominal_seconds, 4);
  assert.equal((await invoke({ reference_audio: 'song' })).status, 400);
  const [tool] = musicPlanTools(async (method, path, body) => {
    calls++; assert.equal(method, 'POST'); assert.equal(path, '/api/music-plan'); return (await invoke(body)).body;
  });
  assert.equal((await tool.run({ abc, target_seconds: 8 })).bpm, 60);
  assert.equal((await tool.run({ bpm: 120, meter: '6/8', bars: 4 })).nominal_seconds, 6);
  assert.equal(calls, 2); assert.match(tool.description, /Read-only/);
  await route({ method: 'GET' }, {}, new URL('http://localhost/api/music-plan')); assert.equal(answer.status, 405);
  assert.equal(await route({}, {}, new URL('http://localhost/no-such-route')), false);
});

test("MCP retains unsupported fields so the shared route refuses audio and unknown inputs", async () => {
  const seen = [];
  const [tool] = musicPlanTools(async (_method, _path, body) => {
    seen.push(body);
    return planMusic(body);
  });
  for (const args of [{ audio_input: "song.wav" }, { reference_audio: "recording.wav", bpm: 120 },
    { abc, continuation: true }, { bpm: 120, unknown_option: 5 }]) {
    await assert.rejects(async () => tool.run(args), /Unsupported planning fields/);
    assert.strictEqual(seen.at(-1), args);
  }
  assert.equal((await tool.run({ bpm: 120, bars: 4 })).nominal_seconds, 8);
});

test("Windows CRLF is normalized only in the returned planner draft", () => {
  const windows = abc.replaceAll("\n", "\r\n");
  const checked = planMusic({ abc: windows });
  assert.equal(checked.ok, true); assert.equal(checked.abc, abc); assert.equal(checked.changed, false);
  assert.equal(checked.nominal_seconds, 4);
  const changed = planMusic({ abc: windows, bpm: 60 });
  assert.equal(changed.abc, abc.replace("Q:1/4=120", "Q:1/4=60"));
  assert.equal(changed.nominal_seconds, 8); assert.equal(changed.saved, false);
  assert.ok(windows.includes("\r\n"), "the input string/local file is not mutated");
});

test("hostile numeric durations and mechanical expansions terminate in a disposable bounded Worker", async () => {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.planner), import(workerData.score)]).then(([{planMusic},{checkScore,applyMechanical}]) => {
      parentPort.postMessage({ready:true});
      const abc = workerData.abc;
      const bad = [
        abc.replace('C4D4E4G4', 'C' + '9'.repeat(400)),
        abc.replace('C4D4E4G4', 'C1000000000'),
        abc.replace('C4D4E4G4', 'C9007199254740993'),
        abc.replace('M:4/4', 'M:' + '9'.repeat(400) + '/4'),
        abc.replace('Q:1/4=120', 'Q:1/4=' + '9'.repeat(400)),
      ];
      const answers = bad.map(text => ({parser:checkScore(text).ok, planner:planMusic({abc:text}).ok}));
      const rests = abc.replace('M:4/4','M:1000000/1').replace('"C"C4D4E4G4|"F"A4G4E4C4|','Z|').replace('C8G8|F8C8|','Z|');
      let refused = false;
      try { applyMechanical('meter',{abc:rests,meter:'1/1024'}); }
      catch(error) { refused = /expand beyond/.test(error.message); }
      parentPort.postMessage({answers,refused,valid:planMusic({abc}).ok});
    }).catch(error => { throw error; });
  `;
  const worker = new Worker(code, { eval: true, execArgv: ["--preserve-symlinks", "--preserve-symlinks-main"],
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
    workerData: { abc, planner: new URL("./music-plan.js", import.meta.url).href,
      score: new URL("./mcp-music-score.js", import.meta.url).href } });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker import/start deadline exceeded")), 3000);
      worker.on("error", reject);
      worker.on("message", message => {
        clearTimeout(timer);
        if (message.ready) timer = setTimeout(() => reject(new Error("Numeric score parsing exceeded its bounded Worker deadline")), 750);
        else resolve(message);
      });
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.answers, Array.from({ length: 5 }, () => ({ parser: false, planner: false })));
    assert.equal(result.refused, true);
  } finally { clearTimeout(timer); await worker.terminate(); }
});

test("planner HTTP bounds declared, chunked, and injected JSON before parsing", async () => {
  let answer, fallbackCalls = 0;
  const route = createMusicPlanRoutes({ json: (_res, status, body) => { answer = { status, body }; },
    readBody: async req => { fallbackCalls++; return req.body; } });
  async function stream(parts, headers = {}) {
    const req = Readable.from(parts);
    req.method = "POST"; req.headers = { "content-type": "application/json", ...headers };
    await route(req, {}, new URL("http://localhost/api/music-plan"));
    req.destroy(); return answer;
  }
  assert.equal((await stream([Buffer.from("{}")], { "content-length": String(MUSIC_PLAN_BODY_LIMIT + 1) })).status, 413);
  assert.equal((await stream(["{}", " ".repeat(MUSIC_PLAN_BODY_LIMIT - 1)])).status, 413);
  assert.equal((await stream(["{}", " ".repeat(MUSIC_PLAN_BODY_LIMIT - 2)])).status, 200);
  assert.equal((await stream(["{}"], { "content-type": "text/plain" })).status, 415);
  assert.equal((await stream(["{broken"])).status, 400);
  assert.equal(fallbackCalls, 0, "real streams never use the unbounded shared reader");
  await route({ method: "POST", body: { abc: "x".repeat(MUSIC_PLAN_BODY_LIMIT) } }, {}, new URL("http://localhost/api/music-plan"));
  assert.equal(answer.status, 413); assert.equal(fallbackCalls, 1);
});

test("ABC byte limits remain distinct from the bounded JSON envelope", () => {
  const atLimit = abc + " ".repeat(65536 - Buffer.byteLength(abc));
  assert.doesNotThrow(() => planMusic({ abc: atLimit }));
  assert.throws(() => planMusic({ abc: atLimit + "x" }), /64 KiB/);
  assert.throws(() => planMusic({ abc: "é".repeat(32769) }), /64 KiB/);
  assert.throws(() => planMusic({ abc: "C\0" }), /NUL/);
});
