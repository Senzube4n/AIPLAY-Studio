/**
 * Games — a place to be while the render queue grinds.
 *
 * One game so far: 2248, the connect-merge number game (the Block Blast /
 * 2048 Blast ruleset). Everything lives on one canvas; state autosaves to
 * localStorage so a render finishing mid-chain costs nothing.
 *
 * Rules implemented (the genre's canonical set):
 * - Drag a chain through adjacent tiles, diagonals included. The first two
 *   tiles must be equal; after that each tile must equal the previous one or
 *   double it.
 * - The chain's sum becomes the largest power of two ≤ sum, placed on the
 *   LAST tile of the chain. (Block Blast rounds the same way; if it ever
 *   feels off, flip Math.floor to Math.ceil in resultTier below.)
 * - Tiles fall, new ones drop in. Reaching a tile 8 tiers above the current
 *   floor levels you up: every tile of the lowest value blasts off the board
 *   and stops spawning. That is the whole "infinite, you just level up" loop.
 */

const COLS = 6, ROWS = 8, TILE = 62, GAP = 8;
const W = COLS * TILE + (COLS + 1) * GAP;
const H = ROWS * TILE + (ROWS + 1) * GAP;
const SAVE_KEY = "aiplay.g2248";

// tier t = the exponent: value 2^t. Hues picked to read like the genre's
// palette (2 green, 8 blue, 16 purple, 32 magenta...), cycling with a shift
// so late-game tiers stay distinguishable.
const HUES = [135, 88, 210, 275, 330, 25, 0, 185, 300, 45, 15, 255];
const tileColor = (t) => {
  const cycle = Math.floor((t - 1) / HUES.length);
  const hue = (HUES[(t - 1) % HUES.length] + cycle * 17) % 360;
  return `hsl(${hue},72%,${52 - cycle * 4}%)`;
};

const fmt = (v) =>
  v >= 1048576 ? `${Math.round(v / 1048576)}M`
  : v >= 10000 ? `${Math.round(v / 1024)}k`
  : String(v);

let booted = false;

export function initGames() {
  if (booted) return;
  booted = true;

  const canvas = document.getElementById("g2248");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.scale(dpr, dpr);

  const hud = {
    score: document.getElementById("g2248Score"),
    best: document.getElementById("g2248Best"),
    level: document.getElementById("g2248Level"),
    max: document.getElementById("g2248Max"),
    note: document.getElementById("g2248Note"),
  };

  /* ── state ── */
  let grid, floor, score, best, bestTier;
  let chain = [];            // [{r,c}] while dragging
  let pointer = null;        // {x,y} while dragging
  let fx = [];               // pop particles: {x,y,t,color,age}
  let noteTimer = null;

  const cellAt = (r, c) => grid[r][c];
  const rnd = (n) => Math.floor(Math.random() * n);

  // spawn low tiers often, higher ones rarely — always relative to the floor
  const spawnTier = () => floor + [0, 0, 0, 0, 1, 1, 1, 2, 2, 3][rnd(10)];

  const newTile = (t, dropFrom = 0) => ({ t, dy: dropFrom, pop: 0 });

  function freshBoard() {
    grid = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => newTile(spawnTier())));
  }

  function reset(keepBest = true) {
    floor = 1; score = 0; bestTier = 0;
    if (!keepBest) best = 0;
    freshBoard();
    save(); paintHud();
  }

  /* ── persistence ── */
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1, floor, score, best, bestTier,
        grid: grid.map((row) => row.map((x) => x.t)),
      }));
    } catch { /* storage full/blocked — the game just won't resume */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (d?.v !== 1 || !Array.isArray(d.grid)) return false;
      floor = d.floor; score = d.score; best = d.best || 0; bestTier = d.bestTier || 0;
      grid = d.grid.map((row) => row.map((t) => newTile(t)));
      return grid.length === ROWS && grid.every((r) => r.length === COLS);
    } catch { return false; }
  }

  /* ── chain rules ── */
  const adjacent = (a, b) => Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1 && !(a.r === b.r && a.c === b.c);
  const inChain = (r, c) => chain.some((p) => p.r === r && p.c === c);

  function canExtend(next) {
    const last = chain[chain.length - 1];
    if (!adjacent(last, next) || inChain(next.r, next.c)) return false;
    const lt = cellAt(last.r, last.c).t, nt = cellAt(next.r, next.c).t;
    return chain.length === 1 ? nt === lt : nt === lt || nt === lt + 1;
  }

  const chainSum = () => chain.reduce((s, p) => s + 2 ** cellAt(p.r, p.c).t, 0);
  const resultTier = () => Math.floor(Math.log2(chainSum()));

  /* ── board mechanics ── */
  function applyGravity() {
    for (let c = 0; c < COLS; c++) {
      const stack = [];
      for (let r = ROWS - 1; r >= 0; r--) if (grid[r][c]) stack.push({ tile: grid[r][c], from: r });
      for (let i = 0; i < ROWS; i++) {
        const r = ROWS - 1 - i;
        if (i < stack.length) {
          const { tile, from } = stack[i];
          if (r !== from) tile.dy = (from - r) * (TILE + GAP);   // fall from the old row
          grid[r][c] = tile;
        } else {
          // new tiles start above the canvas and cascade in
          grid[r][c] = newTile(spawnTier(), -(GAP + r * (TILE + GAP) + TILE + rnd(40)));
        }
      }
    }
  }

  function blast(r, c) {
    const { x, y } = cellXY(r, c);
    const color = tileColor(grid[r][c].t);
    for (let i = 0; i < 8; i++) fx.push({ x: x + TILE / 2, y: y + TILE / 2, a: (i / 8) * Math.PI * 2, color, age: 0 });
    grid[r][c] = null;
  }

  function note(msg) {
    hud.note.textContent = msg;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { hud.note.textContent = ""; }, 2600);
  }

  function commitChain() {
    if (chain.length < 2) { chain = []; return; }
    const tier = resultTier();
    const last = chain[chain.length - 1];
    for (const p of chain.slice(0, -1)) blast(p.r, p.c);
    grid[last.r][last.c] = newTile(tier);
    grid[last.r][last.c].pop = 1;
    score += 2 ** tier;
    if (score > best) best = score;

    if (tier > bestTier) {
      bestTier = tier;
      // level up: the lowest number has outlived its usefulness
      if (tier >= floor + 8) {
        floor += 1;
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
          if (grid[r][c] && grid[r][c].t < floor) blast(r, c);
        }
        note(`Level up! ${fmt(2 ** (floor - 1))}s cleared from the board.`);
      } else {
        note(`New best tile: ${fmt(2 ** tier)}`);
      }
    }
    chain = [];
    applyGravity();
    ensureMovable();
    save(); paintHud();
  }

  function ensureMovable() {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS) continue;
        if (grid[r][c] && grid[r2][c2] && grid[r][c].t === grid[r2][c2].t) return;
      }
    }
    // effectively unreachable with 6 spawn tiers on 48 cells, but the rule
    // needs an answer: reshuffle rather than end an "infinite" game
    note("No moves left — board reshuffled.");
    const tiers = grid.flat().map((x) => x.t).sort(() => Math.random() - 0.5);
    grid = Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => newTile(tiers[r * COLS + c])));
  }

  /* ── geometry ── */
  const cellXY = (r, c) => ({ x: GAP + c * (TILE + GAP), y: GAP + r * (TILE + GAP) });
  function cellUnder(x, y) {
    const c = Math.floor((x - GAP) / (TILE + GAP));
    const r = Math.floor((y - GAP) / (TILE + GAP));
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    // demand the middle 72% of the tile, so diagonal drags don't clip corners
    const { x: tx, y: ty } = cellXY(r, c);
    const m = TILE * 0.14;
    if (x < tx + m || x > tx + TILE - m || y < ty + m || y > ty + TILE - m) return null;
    return { r, c };
  }

  /* ── input ── */
  const evXY = (e) => {
    const b = canvas.getBoundingClientRect();
    return { x: (e.clientX - b.left) * (W / b.width), y: (e.clientY - b.top) * (H / b.height) };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointer = evXY(e);
    const hit = cellUnder(pointer.x, pointer.y);
    if (hit && grid[hit.r][hit.c]) chain = [hit];
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!chain.length) return;
    pointer = evXY(e);
    const hit = cellUnder(pointer.x, pointer.y);
    if (!hit) return;
    const prev = chain[chain.length - 2];
    if (prev && hit.r === prev.r && hit.c === prev.c) chain.pop();       // backtrack
    else if (canExtend(hit)) chain.push(hit);
  });
  const up = () => { commitChain(); pointer = null; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", () => { chain = []; pointer = null; });

  document.getElementById("g2248New").onclick = () => { reset(); note("New game."); };

  /* ── drawing ── */
  function roundRect(x, y, w, h, rad) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rad);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "hsla(220,15%,10%,.65)";
    roundRect(0, 0, W, H, 14); ctx.fill();

    let animating = false;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const tile = grid[r][c];
      const { x, y } = cellXY(r, c);
      ctx.fillStyle = "hsla(220,10%,16%,.5)";
      roundRect(x, y, TILE, TILE, 10); ctx.fill();
      if (!tile) continue;

      if (tile.dy < 0) { tile.dy = Math.min(0, tile.dy + 14); animating = true; }
      if (tile.pop > 0) { tile.pop = Math.max(0, tile.pop - 0.12); animating = true; }
      const scale = 1 + tile.pop * 0.22;
      const linked = inChain(r, c);
      const cx = x + TILE / 2, cy = y + tile.dy + TILE / 2;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.fillStyle = tileColor(tile.t);
      if (linked) { ctx.shadowColor = "white"; ctx.shadowBlur = 14; }
      roundRect(-TILE / 2, -TILE / 2, TILE, TILE, 10); ctx.fill();
      ctx.shadowBlur = 0;
      if (linked) { ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2.5; ctx.stroke(); }
      const label = fmt(2 ** tile.t);
      ctx.fillStyle = "white";
      ctx.font = `700 ${label.length > 3 ? 17 : 21}px ${getComputedStyle(document.body).getPropertyValue("--disp") || "system-ui"}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, 0, 1);
      ctx.restore();
    }

    // chain connector + running result bubble
    if (chain.length) {
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      chain.forEach((p, i) => {
        const { x, y } = cellXY(p.r, p.c);
        i ? ctx.lineTo(x + TILE / 2, y + TILE / 2) : ctx.moveTo(x + TILE / 2, y + TILE / 2);
      });
      if (pointer) ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
      if (chain.length >= 2 && pointer) {
        const v = fmt(2 ** resultTier());
        ctx.font = "700 15px system-ui";
        const w = ctx.measureText(v).width + 18;
        ctx.fillStyle = tileColor(resultTier());
        roundRect(pointer.x - w / 2, pointer.y - 46, w, 26, 13); ctx.fill();
        ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(v, pointer.x, pointer.y - 33);
      }
      animating = true;
    }

    // blast particles — age BEFORE filtering: a particle drawn past age 1 has
    // a negative arc radius, and ctx.arc throws on that (one throw used to
    // kill the whole render loop while the game kept playing underneath)
    fx = fx.filter((p) => (p.age += 0.06) < 1);
    for (const p of fx) {
      const d = p.age * 30;
      ctx.globalAlpha = 1 - p.age;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(p.a) * d, p.y + Math.sin(p.a) * d, 4 * (1 - p.age), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      animating = true;
    }
    return animating;
  }

  function paintHud() {
    hud.score.textContent = fmt(score);
    hud.best.textContent = fmt(best);
    hud.level.textContent = floor;
    hud.max.textContent = bestTier ? fmt(2 ** bestTier) : "—";
  }

  /* ── loop: draw only while the tab is visible; idle frames are cheap but
   *    not free, and this box also renders video ── */
  function loop() {
    // schedule FIRST: a draw exception must cost one frame, not the loop
    requestAnimationFrame(loop);
    try {
      if (!document.getElementById("games").hidden) draw();
    } catch (e) {
      console.error("g2248 draw:", e);
    }
  }

  best = 0;
  if (!load()) reset();
  paintHud();
  loop();
}
