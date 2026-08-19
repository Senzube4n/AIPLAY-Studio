/**
 * Documentation screenshots, taken by driving a headless Chrome over CDP.
 *
 * WHY A SCRIPT AND NOT A SCREENSHOT KEY. The README, the landing page and the
 * blog post all show the same views, and every UI change makes those pictures
 * quietly wrong. A hand-taken screenshot is a claim nobody can re-check; this
 * one is `node scripts/shots.mjs` and it is right again. It also means the
 * pictures are all the same size, same theme and same library state, which
 * hand-taken ones never are.
 *
 * WHY CDP RATHER THAN `chrome --screenshot`. Studio is a single page: the views
 * are switched by JavaScript, not by URL. A one-shot screenshot flag can only
 * ever photograph the Create view. Over CDP we can navigate, click into a view,
 * wait for it to settle, and only then capture — which is the difference between
 * six pictures and one.
 *
 * `ws` is already Studio's only runtime dependency, so this adds nothing to
 * install.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 9333;
const OUT = path.join(process.cwd(), "docs", "shots");
const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173/";
const WIDTH = 1600, HEIGHT = 1000;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));

/** Each shot: a name, and the script that puts the app into the state we want.
 *  The script runs in the page and resolves when the view has settled. */
const SHOTS = [
  { name: "create", title: "The Create view",
    setup: `document.querySelector('[data-view=create]').click(); await wait(1200);` },
  { name: "library", title: "The library, grouped by session",
    setup: `document.querySelector('[data-view=create]').click(); await wait(800);
            const g=document.getElementById('libGroup'); if(g){g.value='session'; g.dispatchEvent(new Event('change'));}
            await wait(900); window.scrollTo(0,0);` },
  { name: "video", title: "The Video view with both end frames chosen",
    setup: `document.querySelector('[data-view=video]').click(); await wait(1200);
            const f=document.getElementById('vidFrom'); f.selectedIndex=1; f.dispatchEvent(new Event('change'));
            await wait(900);
            const t=document.getElementById('vidTo'); t.selectedIndex=2; t.dispatchEvent(new Event('change'));
            await wait(1400);` },
  { name: "clips", title: "The clip library, grouped by day",
    setup: `document.querySelector('[data-view=video]').click(); await wait(1000);
            const g=document.getElementById('clipGroup'); g.value='day'; g.dispatchEvent(new Event('change'));
            await wait(1800);` },
  { name: "studio", title: "The studio timeline mid-crossfade",
    setup: `document.querySelector('[data-view=studio]').click(); await wait(1200);
            const clips=[...document.querySelectorAll('[data-clip]')];
            const drop=(i,name,px)=>{const lane=[...document.querySelectorAll('[data-lane]')][i];
              const dt=new DataTransfer(); dt.setData('text/aiplay-clip',name);
              const b=lane.getBoundingClientRect();
              lane.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,
                clientX:b.left+px,clientY:b.top+20}));};
            if(clips[0]){drop(1,clips[0].dataset.clip,0); await wait(2500);}
            if(clips[1]){drop(1,clips[1].dataset.clip,200); await wait(2500);}
            if(clips[3]){drop(0,clips[3].dataset.clip,420); await wait(2500);}
            /* The song dropdown became the Songs tab of the asset bin. */
            document.getElementById('stTabSongs').click(); await wait(400);
            const song=[...document.querySelectorAll('.stsong')].find(x=>x.title.includes('lyrics'))
              || document.querySelector('.stsong');
            if(song){song.click(); await wait(3000);}
            document.getElementById('stTabClips').click(); await wait(300);
            /* Park the playhead inside the crossfade so the shot shows BOTH the
               dissolve and the karaoke line, which is the whole point of the
               picture. Clicking empty timeline seeks; the top lane is empty at
               4.2s, so that is where we click. */
            const lane0=[...document.querySelectorAll('[data-lane]')][0];
            const lb0=lane0.getBoundingClientRect();
            lane0.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,
              clientX:lb0.left+4.2*60, clientY:lb0.top+20}));
            await wait(1800); window.scrollTo(0,0);` },
  { name: "models", title: "The Models screen",
    setup: `document.querySelector('[data-view=models]').click(); await wait(2500); window.scrollTo(0,0);` },
  { name: "overnight", title: "An Overnight run being planned",
    setup: `document.querySelector('[data-view=overnight]').click(); await wait(1800); window.scrollTo(0,0);` },
  { name: "settings", title: "Settings",
    setup: `document.querySelector('[data-view=settings]').click(); await wait(1200); window.scrollTo(0,0);` },
];

let idSeq = 0;
function rpc(ws, method, params = {}, sessionId) {
  const id = ++idSeq;
  return new Promise((res, rej) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off("message", onMsg);
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function main() {
  if (!CHROME) throw new Error("Chrome not found — set the path in scripts/shots.mjs");
  await mkdir(OUT, { recursive: true });

  const profile = path.join(process.env.TEMP || ".", `aiplay-shots-${Date.now()}`);
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--hide-scrollbars",
    // Video posters and the studio canvas need decoded frames, and the studio
    // starts media without a click.
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=CalculateNativeWinOcclusion",
    "about:blank",
  ], { stdio: "ignore" });

  // Wait for the debugger to answer rather than sleeping a fixed amount.
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  if (!target) { chrome.kill(); throw new Error("Chrome never opened its debug port"); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

  await rpc(ws, "Page.enable");
  await rpc(ws, "Runtime.enable");
  await rpc(ws, "Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });

  const results = [];
  for (const shot of SHOTS) {
    // Reload between shots so one view's state cannot leak into the next.
    await rpc(ws, "Page.navigate", { url: APP });
    await new Promise((r) => setTimeout(r, 3500));
    const expr = `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      try { ${shot.setup} } catch (e) { return "setup failed: " + e.message; }
      return "ok";
    })()`;
    const out = await rpc(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const status = out.result?.value ?? "?";
    const png = await rpc(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(OUT, `${shot.name}.png`);
    await writeFile(file, Buffer.from(png.data, "base64"));
    const kb = Math.round(Buffer.from(png.data, "base64").length / 1024);
    console.log(`  ${shot.name.padEnd(10)} ${String(kb).padStart(5)} KB  ${status}`);
    results.push({ ...shot, file, status, kb });
  }

  ws.close();
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});

  const bad = results.filter((r) => r.status !== "ok");
  console.log(`\n${results.length - bad.length}/${results.length} clean → ${OUT}`);
  if (bad.length) for (const b of bad) console.log(`  ⚠ ${b.name}: ${b.status}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
