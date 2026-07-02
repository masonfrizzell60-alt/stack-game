/* ============================================================
   STACK — a Three.js cube-stacking game
   - Stack cubes; perfect alignment keeps full size.
   - Whatever overhangs gets sliced off and falls into the void.
   - A COMPLETE miss doesn't end the run — it just drops that piece
     and spawns a fresh one to retry (forgiving, for streamers).
   - Random vivid colors, thick black fat-line outlines, low-poly 3D.
   - Auto-assist (Options / Ctrl+M): how close to perfect, as a % of
     the block, still snaps. 0% = exact only, 50% = very forgiving.
   - Esc pauses. Whole window is the live render surface (no letterbox).

   STREAMER-GRADE OPTIMIZATION (constant cost, any tower height):
   - Shared cube geometry + shared edge geometry + shared outline mat.
   - Off-screen culling: only the top MAX_VISIBLE cubes live in the
     scene; older ones removed + material disposed (flat draw calls).
   - O(1) per-frame work; no per-frame allocations.
   - high-performance GPU hint, capped pixel ratio, stencil off.
   ============================================================ */

const BOX_HEIGHT = 2.2;         // block thickness (taller = chunkier blocks)
const ORIGINAL_SIZE = 8;        // footprint of the foundation = the MAX block size
const PERFECTS_TO_GROW = 5;     // a streak of this many perfects grows the block once
const GROW_AMOUNT = 1.8;        // size regained per completed streak (capped at ORIGINAL_SIZE = max)
const SPAWN_OFFSET = 13;        // where a new cube enters from
const OUTLINE_PX = 6;           // outline thickness in screen pixels
const MAX_VISIBLE = 18;         // cubes kept in the scene at once (culling)
const MAX_PIXEL_RATIO = 1.5;    // cap GPU load on hi-DPI / while streaming
const DEFAULT_ASSIST = 10;      // default auto-assist strength (%)
const DEFAULT_SPEED = 20;       // slider units; actual block speed = value / 100
const DEFAULT_RANDOM = 8;       // % chance each new block becomes a random powerup

// Vertical world-units shown = the zoom anchor. The width fills the whole
// window so the ENTIRE screen is the live render surface (no letterbox);
// wider screens just reveal more scene on the sides. Bigger = zoomed out.
const VIEW_H = 24; // vertical world-units shown — bigger = zoomed OUT
const BLOOM_LAYER = 1; // objects on this layer get the glow/bloom
const MAX_SHAKE = 1.6; // cap on camera shake (world units)

let scene, camera, renderer, stageEl;
let bloomComposer, bloomPass, glowScene, glowCam;
let BLOOM = false;
let stack = [];      // cubes: { threejs, width, depth, direction, color, dirSign }
let overhangs = [];  // falling sliced pieces: { threejs, vy, vrot }
let pulsing = null;  // the single cube currently doing a perfect-pulse
let gameStarted = false;
let gameOver = false;
let paused = false;
let score = 0;
let combo = 0;
let camY = 0;          // smoothed camera pan height
let actionLocked = false; // at most one drop per animation frame
let resizePending = false;
let particles = [];       // sparkle/star burst sprites
let starTex = null;
let resetActive = false;  // 60s save-or-reset countdown
let resetSecondsLeft = 0;
let resetInterval = null;
let flashTimer = null;
let pendingNet = 0;       // signed running total on the held block: +N builds up, -N bombs down (they add)
let pendingSize = 1;      // size gift: 2 = next block 2x bigger, 0.5 = 2x smaller, 1 = none
let buildDir = 1;         // warp direction: +1 rocketing up, -1 falling down
let giftSprite = null;    // the rocket/bomb + "±N" label floating on the armed block
let cloneBuild = null;    // interval id while gift clones spawn one-by-one
let buildActive = false;  // gameplay frozen while a gift is building up
let popping = [];         // blocks currently doing a pop-in animation
// --- TNT down system: a "go down" gift drops a stick of dynamite that lands on
// the tower, explodes, and blows blocks off. Multiple gifts QUEUE and play one
// at a time (finish the first blast, then the next) so none are ever dropped. ---
let tntQueue = [];        // pending down amounts waiting for their own dynamite
let tntActive = null;     // the dynamite currently falling: { mesh, n, vy, targetY, spark, dirAfter }
let tntBusy = false;      // a full drop+explode+remove sequence is running
let shockwaves = [];      // expanding blast-flash sprites
let auraRings = [];       // rising transparent rings on a big (+500) rocket build
let shake = 0;            // current camera-shake intensity (world units)
let lastFrameTime = 0;    // for frame-rate-independent block movement
let displayedScore = 0;   // smoothed score driving the sky (eases on gift jumps)
let lastSkyApplied = -999;
let skyTick = 0;          // throttle counter for sky updates
let lastBgStr = "";       // cache: skip full-screen gradient repaints when unchanged
let lastStarsCov = -1;    // cache: skip star-mask recompute when unchanged

const clampAssist = (n) => Math.max(0, Math.min(50, Math.round(n) || 0));
const clampSpeed = (n) => Math.max(4, Math.min(40, Math.round(n) || DEFAULT_SPEED));
const clampRandom = (n) => Math.max(0, Math.min(30, isNaN(n) ? DEFAULT_RANDOM : Math.round(n)));
function loadSetting(key, dflt) {
  try { const v = localStorage.getItem(key); return v === null ? dflt : v; }
  catch (e) { return dflt; }
}
function saveSetting(key, val) {
  try { localStorage.setItem(key, String(val)); } catch (e) {}
}
let assistPercent = clampAssist(parseInt(loadSetting("stack_assist", DEFAULT_ASSIST), 10));
let speedSetting = clampSpeed(parseInt(loadSetting("stack_speed", DEFAULT_SPEED), 10));
const clampVol = (n) => Math.max(0, Math.min(100, isNaN(n) ? 50 : Math.round(n)));
let volume = clampVol(parseInt(loadSetting("stack_volume", 50), 10));
if (window.SFX) SFX.setVolume(volume / 100);
const sfx = (n, a, b) => { try { if (window.SFX && SFX[n]) SFX[n](a, b); } catch (e) {} };
// Every powerup has its own per-block % chance, tunable in the Options menu.
// Same ratios as before, but a QUARTER of the old ~8% -> ~2% total (~1 in 50
// blocks). Just a little spice between gifts.
// Each powerup is a slot with an editable amount + per-block % chance (both in Options).
const POWERUPS = [
  { key: "up25",     dir: "add",    amtDef: 25,   chanceDef: 0.63 },
  { key: "up250",    dir: "add",    amtDef: 250,  chanceDef: 0.2 },
  { key: "up1250",   dir: "add",    amtDef: 1250, chanceDef: 0.04 },
  { key: "size2x",   dir: "size",   amtDef: 2,    chanceDef: 0.1 },
  { key: "shrink2x", dir: "size",   amtDef: 0.5,  chanceDef: 0.3 },
  { key: "down25",   dir: "remove", amtDef: 25,   chanceDef: 0.5 },
  { key: "down250",  dir: "remove", amtDef: 250,  chanceDef: 0.15 },
  { key: "down1250", dir: "remove", amtDef: 1250, chanceDef: 0.04 },
];
const clampChance = (n) => Math.max(0, Math.min(10, isNaN(n) ? 0 : Math.round(n * 100) / 100));
// one-time rebalance: drop any old saved chances so the new lower defaults apply
try {
  if (loadSetting("stack_pct_v", "1") !== "2") {
    for (const p of POWERUPS) localStorage.removeItem("stack_pct_" + p.key);
    saveSetting("stack_pct_v", "2");
  }
} catch (e) {}
const clampAmt = (n) => Math.max(1, Math.min(999999, Math.floor(n) || 1));
const chances = {};
let powerupsOn = loadSetting("stack_powerupsOn", "0") !== "0"; // master on/off for random powerups (off by default)
const amounts = {}; // editable amount per slot (size slots keep their fixed multiplier)
for (const p of POWERUPS) {
  chances[p.key] = clampChance(parseFloat(loadSetting("stack_pct_" + p.key, p.chanceDef)));
  amounts[p.key] = p.dir === "size" ? p.amtDef : clampAmt(parseInt(loadSetting("stack_amt_" + p.key, p.amtDef), 10));
}
function powerupLabel(p) {
  if (p.dir === "size") return amounts[p.key] > 1 ? "2× size" : "½ size";
  return (p.dir === "add" ? "+" : "−") + amounts[p.key] + " blocks";
}
function armPowerup(p) {
  if (p.dir === "add") armClones(amounts[p.key]);
  else if (p.dir === "remove") armRemove(amounts[p.key]);
  else armSize(amounts[p.key]);
}
function refreshPowerupLabels() {
  document.querySelectorAll("#optionsPanel [data-amt-label]").forEach((el) => {
    const p = POWERUPS.find((x) => x.key === el.dataset.amtLabel);
    if (p) el.textContent = powerupLabel(p);
  });
}
// The +N/−N amount inputs now live next to each keybind in Controls.
function wireAmountInputs() {
  document.querySelectorAll("#optionsPanel input.amt-num[data-amt]").forEach((inp) => {
    const key = inp.dataset.amt;
    if (!(key in amounts)) return;
    inp.value = amounts[key];
    inp.addEventListener("input", () => {
      amounts[key] = clampAmt(parseInt(inp.value, 10));
      saveSetting("stack_amt_" + key, amounts[key]);
      refreshPowerupLabels();
    });
    inp.addEventListener("change", () => { inp.value = amounts[key]; });
    inp.addEventListener("focus", () => inp.select());
  });
}

// --- shared geometry & materials (created once) ---
let unitGeo, unitEdges, lineGeo, outlineMat, edgeMat, whiteOutlineMat, whiteEdgeMat;
let FAT = false; // whether fat-line outlines are available
let faceFlashes = []; // cubes flashing their faces white on a perfect

// --- UI elements ---
const scoreEl = document.getElementById("score");
const comboEl = document.getElementById("combo");
const recordEl = document.getElementById("recordValue");
const recordInput = document.getElementById("recordInput");
const overlay = document.getElementById("overlay");
const overlayMsg = document.getElementById("overlayMsg");
const startBtn = document.getElementById("startBtn");
const pauseOverlay = document.getElementById("pauseOverlay");
const resumeBtn = document.getElementById("resumeBtn");
const pauseResetBtn = document.getElementById("pauseResetBtn");
const optionsPanel = document.getElementById("optionsPanel");
const assistRange = document.getElementById("assistRange");
const assistVal = document.getElementById("assistVal");
const speedRange = document.getElementById("speedRange");
const speedVal = document.getElementById("speedVal");
const volRange = document.getElementById("volRange");
const volVal = document.getElementById("volVal");
const chanceListEl = document.getElementById("chanceList");
const optSearchEl = document.getElementById("optSearch");
const optClose = document.getElementById("optClose");
const bgEl = document.getElementById("bg");
const bgSkyEl = document.getElementById("bgSky");
const starsEl = document.getElementById("stars");
const cloudsEl = document.getElementById("clouds");
const nebulaEl = document.getElementById("nebula");
const galaxyEl = document.getElementById("galaxyBand");
const auroraEl = document.getElementById("aurora");
const planetEl = document.getElementById("planet");
const sunEl = document.getElementById("sun");
const shootEl = document.getElementById("shootingStars");
const motesEl = document.getElementById("motes");
const coreEl = document.getElementById("core");
const godraysEl = document.getElementById("godrays");
const bubblesEl = document.getElementById("bubbles");
const jungleraysEl = document.getElementById("junglerays");
const pollenEl = document.getElementById("pollen");
const leavesEl = document.getElementById("leaves");
const stormcloudsEl = document.getElementById("stormclouds");
const rainEl = document.getElementById("rain");
const lightningEl = document.getElementById("lightning");
const frostAuroraEl = document.getElementById("frostAurora");
const snowEl = document.getElementById("snow");
const iceGlintsEl = document.getElementById("iceGlints");
// region detail / depth layers
const DETAIL_LAYERS = ["jungle_farcanopy","jungle_mist","jungle_fireflies","jungle_vignette","jungle_canopy","jungle_undergrowth","frost_sun","frost_aurora2","frost_peaksFar","frost_peaksMid","frost_peaksNear","frost_gusts","storm_bankBack","storm_bankFront","storm_gust","storm_bolts","jv2_dapple","jv2_shafts","jv2_foliage"];
const detailEls = {};
for (const id of DETAIL_LAYERS) detailEls[id] = document.getElementById(id);
const zoneBannerEl = document.getElementById("zoneBanner");
const warpEl = document.getElementById("warp");
const buildGlowEl = document.getElementById("buildGlow");
let lastZoneIndex = -1;
let zoneBannerTimer = null;
let buildIntensity = 0; // how epic the current build is (0..1, scales with gift size)
let viewScale = 1;      // eased camera zoom (>1 = zoomed out during a big build)
let warpAmt = 0;        // eased warp/glow strength
let buildAccel = 0;     // 0..1 acceleration progress of the current build
let warpStreaks = [];   // {el, y} speed-line elements (JS-driven for variable speed)
const resetTimerEl = document.getElementById("resetTimer");
const rtClockEl = document.getElementById("rtClock");
const rtFillEl = document.getElementById("rtFill");
const flashEl = document.getElementById("flash");

let record = parseInt(loadSetting("stack_record", "0"), 10);
recordEl.textContent = record;
if (recordInput) {
  recordInput.value = record;
  recordInput.addEventListener("input", () => {
    record = Math.max(0, Math.floor(+recordInput.value) || 0);
    recordEl.textContent = record;
    saveSetting("stack_record", record);
  });
}

// --- World record badge: user-editable position + size (Options) ---
const recordWrap = document.getElementById("record");
let recordX = parseFloat(loadSetting("stack_recordX", "50"));
let recordY = parseFloat(loadSetting("stack_recordY", "2"));
let recordSize = parseFloat(loadSetting("stack_recordSize", "100"));
let recordShow = loadSetting("stack_recordShow", "1") !== "0";
function applyRecordLayout() {
  if (!recordWrap) return;
  recordWrap.style.position = "fixed";
  recordWrap.style.left = recordX + "%";
  recordWrap.style.top = recordY + "%";
  recordWrap.style.transform = "translateX(-50%) scale(" + (recordSize / 100) + ")";
  recordWrap.style.transformOrigin = "top center";
  recordWrap.style.margin = "0";
  recordWrap.style.zIndex = "5";
  recordWrap.style.display = recordShow ? "" : "none";
}
applyRecordLayout();
(function () {
  const cb = document.getElementById("recordShow");
  if (!cb) return;
  cb.checked = recordShow;
  cb.addEventListener("change", () => {
    recordShow = cb.checked;
    saveSetting("stack_recordShow", recordShow ? "1" : "0");
    applyRecordLayout();
  });
})();
(function () {
  const rows = [
    { sl: "recordSizeRange", lab: "recordSizeVal", suffix: "%", get: () => recordSize, set: (v) => { recordSize = v; }, key: "stack_recordSize" },
  ];
  for (const r of rows) {
    const sl = document.getElementById(r.sl), lab = document.getElementById(r.lab);
    if (!sl) continue;
    sl.value = r.get();
    if (lab) lab.textContent = r.get() + r.suffix;
    paintSlider(sl);
    sl.addEventListener("input", () => {
      const v = +sl.value;
      r.set(v);
      if (lab) lab.textContent = v + r.suffix;
      paintSlider(sl);
      applyRecordLayout();
      saveSetting(r.key, v);
    });
  }
})();

// Drag the WORLD RECORD badge directly with the mouse to reposition it.
if (recordWrap) {
  let dragging = false, offX = 0, offY = 0;
  recordWrap.addEventListener("pointerdown", (e) => {
    if (e.isPrimary === false) return;
    e.preventDefault();
    e.stopPropagation(); // don't let grabbing the badge drop a block
    dragging = true;
    recordWrap.classList.add("dragging");
    try { recordWrap.setPointerCapture(e.pointerId); } catch (x) {}
    const r = recordWrap.getBoundingClientRect();
    offX = e.clientX - (r.left + r.width / 2); // pointer offset from badge h-center
    offY = e.clientY - r.top;                  // pointer offset from badge top
  });
  recordWrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const cx = e.clientX - offX, ty = e.clientY - offY;
    recordX = Math.max(0, Math.min(100, (cx / Math.max(1, window.innerWidth)) * 100));
    recordY = Math.max(0, Math.min(100, (ty / Math.max(1, window.innerHeight)) * 100));
    applyRecordLayout();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    recordWrap.classList.remove("dragging");
    try { recordWrap.releasePointerCapture(e.pointerId); } catch (x) {}
    saveSetting("stack_recordX", recordX);
    saveSetting("stack_recordY", recordY);
  };
  recordWrap.addEventListener("pointerup", endDrag);
  recordWrap.addEventListener("pointercancel", endDrag);
}

// --- Draggable multi-goal progress bar ---
const goalBar = document.getElementById("goalBar");
const goalTargetEl = document.getElementById("goalTarget");
const goalFillEl = document.getElementById("goalFill");
let goalX = parseFloat(loadSetting("stack_goalX", "50"));
let goalY = parseFloat(loadSetting("stack_goalY", "86"));
let goalSize = parseFloat(loadSetting("stack_goalSize", "100"));
let goalShow = loadSetting("stack_goalShow", "1") !== "0";

function sortGoals(arr) {
  const seen = new Set();
  return arr.map((n) => Math.max(0, Math.floor(n) || 0))
    .filter((n) => n > 0 && !seen.has(n) && seen.add(n))
    .sort((a, b) => a - b);
}
let goals;
try { goals = JSON.parse(loadSetting("stack_goals", "")); } catch (e) { goals = null; }
if (!Array.isArray(goals) || !goals.length) {
  const old = parseInt(loadSetting("stack_goal", "0"), 10); // migrate old single goal
  goals = old > 0 ? [old] : [1000, 10000];
}
goals = sortGoals(goals);
let goalsDone = goals.filter((n) => score >= n).length; // already-passed goals (no celebration for these)
function saveGoals() { saveSetting("stack_goals", JSON.stringify(goals)); }

function applyGoalLayout() {
  if (!goalBar) return;
  goalBar.style.setProperty("--gscale", goalSize / 100);
  goalBar.style.left = goalX + "%";
  goalBar.style.top = goalY + "%";
  goalBar.style.transform = "translateX(-50%) scale(" + (goalSize / 100) + ")";
}

// Confetti burst — the win VFX.
function spawnConfetti(count) {
  const cont = document.getElementById("confetti");
  if (!cont) return;
  const colors = ["#ffd14d", "#36e0a0", "#2bd1c4", "#ff5da2", "#7c5cff", "#ff7a1e", "#ffffff"];
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = (Math.random() * 100).toFixed(1) + "%";
    p.style.background = colors[(Math.random() * colors.length) | 0];
    const sz = 6 + Math.random() * 9;
    p.style.width = sz.toFixed(0) + "px";
    p.style.height = (sz * 0.5).toFixed(0) + "px";
    const dur = 1.6 + Math.random() * 1.9;
    p.style.animationDuration = dur.toFixed(2) + "s";
    p.style.animationDelay = (Math.random() * 0.4).toFixed(2) + "s";
    p.style.setProperty("--rot", (Math.random() * 720 - 360).toFixed(0) + "deg");
    p.style.setProperty("--drift", (Math.random() * 240 - 120).toFixed(0) + "px");
    cont.appendChild(p);
    setTimeout(() => p.remove(), (dur + 0.6) * 1000);
  }
}
function pulseGoal() {
  if (!goalBar) return;
  goalBar.classList.remove("pulse"); void goalBar.offsetWidth; goalBar.classList.add("pulse");
}

// Called from refreshScore() so the bar tracks the live score.
function refreshGoal() {
  if (!goalBar) return;
  const g = goals;
  if (!goalShow || !g.length) { goalBar.classList.add("hidden"); return; }
  goalBar.classList.remove("hidden");
  let done = 0;
  for (const v of g) if (score >= v) done++;
  const allDone = done >= g.length;
  const target = allDone ? g[g.length - 1] : g[done];
  const prev = allDone ? (g[g.length - 2] || 0) : (done > 0 ? g[done - 1] : 0);
  const pct = allDone ? 100 : Math.max(0, Math.min(100, ((score - prev) / Math.max(1, target - prev)) * 100));
  goalTargetEl.textContent = target.toLocaleString();
  goalFillEl.style.width = pct + "%";
  goalBar.classList.toggle("alldone", allDone);

  if (done > goalsDone) { // a new goal (or several) just got hit
    pulseGoal();
    if (allDone) {
      spawnConfetti(170);
      flashMsg("🏆 ALL GOALS COMPLETE!", "#ffd14d");
      sfx("boom", true);
    } else {
      spawnConfetti(45);
      flashMsg("🎯 GOAL! " + g[done - 1].toLocaleString(), "#ffd14d");
      sfx("milestone");
    }
  }
  goalsDone = done;
}

// Options: editable goal list with add / remove (auto-sorted on edit).
function rebuildGoalList() {
  const list = document.getElementById("goalList");
  if (!list) return;
  list.innerHTML = "";
  goals.forEach((val, i) => {
    const row = document.createElement("div");
    row.className = "goal-row";
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.step = "100"; inp.className = "opt-num goal-num"; inp.value = val;
    inp.addEventListener("input", () => { goals[i] = Math.max(0, Math.floor(+inp.value) || 0); saveGoals(); refreshGoal(); });
    inp.addEventListener("change", commitGoals); // re-sort once they finish typing
    inp.addEventListener("focus", () => inp.select());
    const del = document.createElement("button");
    del.className = "goal-del"; del.textContent = "×"; del.setAttribute("aria-label", "Remove goal");
    del.addEventListener("click", () => { goals.splice(i, 1); commitGoals(); });
    row.appendChild(inp); row.appendChild(del);
    list.appendChild(row);
  });
}
function commitGoals() {
  goals = sortGoals(goals);
  saveGoals();
  goalsDone = goals.filter((n) => score >= n).length; // re-baseline so editing doesn't fire celebrations
  rebuildGoalList();
  refreshGoal();
}

applyGoalLayout();
rebuildGoalList();
refreshGoal();

(function () {
  const cb = document.getElementById("goalShow");
  if (!cb) return;
  cb.checked = goalShow;
  cb.addEventListener("change", () => {
    goalShow = cb.checked;
    saveSetting("stack_goalShow", goalShow ? "1" : "0");
    refreshGoal();
  });
})();

{
  const addBtn = document.getElementById("addGoalBtn");
  if (addBtn) addBtn.addEventListener("click", () => {
    goals.push(goals.length ? goals[goals.length - 1] * 2 : 1000);
    commitGoals();
  });
}
(function () {
  const gs = document.getElementById("goalSizeRange"), gv = document.getElementById("goalSizeVal");
  if (!gs) return;
  gs.value = goalSize;
  if (gv) gv.textContent = goalSize + "%";
  paintSlider(gs);
  gs.addEventListener("input", () => {
    goalSize = +gs.value;
    if (gv) gv.textContent = goalSize + "%";
    paintSlider(gs);
    applyGoalLayout();
    saveSetting("stack_goalSize", goalSize);
  });
})();

if (goalBar) {
  let dragging = false, offX = 0, offY = 0;
  goalBar.addEventListener("pointerdown", (e) => {
    if (e.isPrimary === false) return;
    e.preventDefault();
    e.stopPropagation(); // grabbing the bar shouldn't drop a block
    dragging = true;
    goalBar.classList.add("dragging");
    try { goalBar.setPointerCapture(e.pointerId); } catch (x) {}
    const r = goalBar.getBoundingClientRect();
    offX = e.clientX - (r.left + r.width / 2);
    offY = e.clientY - r.top;
  });
  goalBar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const cx = e.clientX - offX, ty = e.clientY - offY;
    goalX = Math.max(0, Math.min(100, (cx / Math.max(1, window.innerWidth)) * 100));
    goalY = Math.max(0, Math.min(100, (ty / Math.max(1, window.innerHeight)) * 100));
    applyGoalLayout();
  });
  const endGoalDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    goalBar.classList.remove("dragging");
    try { goalBar.releasePointerCapture(e.pointerId); } catch (x) {}
    saveSetting("stack_goalX", goalX);
    saveSetting("stack_goalY", goalY);
  };
  goalBar.addEventListener("pointerup", endGoalDrag);
  goalBar.addEventListener("pointercancel", endGoalDrag);
}

// --- Stream overlay: publish live state to the server + show the OBS link in Options ---
let overlayOn = false, _overlaySig = "";
(async function () {
  const inputs = Array.from(document.querySelectorAll(".ovl-url"));
  if (!inputs.length) return;
  let info = null;
  try { const r = await fetch("/api/overlay-url"); if (r.ok) info = await r.json(); } catch (e) {}
  if (info && info.available && info.url) {
    overlayOn = true;
    for (const inp of inputs) {
      inp.value = info.url + "?show=" + (inp.dataset.ovl || "both");
      const btn = inp.parentElement && inp.parentElement.querySelector(".ovl-copy");
      if (btn) btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(inp.value); }
        catch (e) { inp.focus(); inp.select(); try { document.execCommand("copy"); } catch (x) {} }
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1200);
      });
    }
  } else {
    for (const inp of inputs) { const sec = inp.closest(".opt-ovl"); if (sec) sec.style.display = "none"; }
  }
})();
setInterval(() => {
  if (!overlayOn) return;
  const sig = [score, record, recordX, recordY, recordSize, recordShow, goalX, goalY, goalSize, goalShow, goals.join("·")].join("|");
  if (sig === _overlaySig) return; // only publish when something actually changed
  _overlaySig = sig;
  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score, record, recordX, recordY, recordSize, recordShow, goals, goalX, goalY, goalSize, goalShow }),
  }).catch(() => {});
}, 300);

// Paint the filled portion of a range slider for a custom look.
function paintSlider(el) {
  const min = +el.min, max = +el.max, v = +el.value;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background =
    `linear-gradient(to right, #3a8ff0 0%, #6ec1ff ${pct}%, ` +
    `rgba(255,255,255,0.10) ${pct}%, rgba(255,255,255,0.10) 100%)`;
}

// reflect saved settings into the slider UI
assistRange.value = assistPercent;
assistVal.textContent = assistPercent + "%";
speedRange.value = speedSetting;
speedVal.textContent = speedSetting;
paintSlider(assistRange);
paintSlider(speedRange);
if (volRange) {
  volRange.value = volume;
  volVal.textContent = volume + "%";
  paintSlider(volRange);
}
buildChanceSliders();
refreshPowerupLabels();
wireAmountInputs();
(function () {
  const cb = document.getElementById("powerupsOn");
  if (!cb) return;
  cb.checked = powerupsOn;
  cb.addEventListener("change", () => {
    powerupsOn = cb.checked;
    saveSetting("stack_powerupsOn", powerupsOn ? "1" : "0");
  });
})();
makeCollapsible();
if (optSearchEl) optSearchEl.addEventListener("input", () => applySearch(optSearchEl.value));

/* ---------------- Scene setup ---------------- */
function init() {
  scene = new THREE.Scene();
  stageEl = document.getElementById("stage");

  // Lighting: low ambient + a soft cool sky/ground fill + one angled key.
  // Gives a crisp 3-tone look (bright top, medium side, darker side) with a
  // clean cool fill in the shadows — the "pristine" feel from the real game.
  scene.add(new THREE.AmbientLight(0xffffff, 0.34));
  scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x223048, 0.4));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(14, 20, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.22); // cool fill on the shadow side
  fill.position.set(-12, 6, -9);
  scene.add(fill);

  // Shared resources (created ONCE, reused by every cube)
  unitGeo = new THREE.BoxGeometry(1, 1, 1);
  applyVertexShade(unitGeo); // subtle baked top→bottom gradient on every face
  unitEdges = new THREE.EdgesGeometry(unitGeo);

  FAT = !!(THREE.LineSegmentsGeometry && THREE.LineMaterial && THREE.LineSegments2);
  if (FAT) {
    lineGeo = new THREE.LineSegmentsGeometry().fromEdgesGeometry(unitEdges);
    outlineMat = new THREE.LineMaterial({ color: 0x000000, linewidth: OUTLINE_PX });
    whiteOutlineMat = new THREE.LineMaterial({ color: 0xffffff, linewidth: OUTLINE_PX });
  } else {
    edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 });
    whiteEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff });
  }

  starTex = makeStarTexture(); // for sparkle/star bursts

  // Orthographic camera (clean isometric 3D look), full-window frustum
  const aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
  const viewW = VIEW_H * aspect;
  camera = new THREE.OrthographicCamera(
    -viewW / 2, viewW / 2, VIEW_H / 2, -VIEW_H / 2, 0.1, 400
  );
  camera.position.set(24, 22, 24);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: false,
    powerPreference: "high-performance",
  });
  stageEl.appendChild(renderer.domElement);
  renderer.setClearColor(0x000000, 0);
  resizeRenderer();

  // Bloom / glow post-processing (selective: only bright objects bloom)
  BLOOM = !!(THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass);
  if (BLOOM) {
    bloomComposer = new THREE.EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(new THREE.RenderPass(scene, camera));
    // render the bloom at half resolution — it's blurry anyway so it looks
    // identical, but the (expensive) blur passes do ~4x less work
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5), 1.3, 0.55, 0
    );
    bloomComposer.addPass(bloomPass);
    glowScene = new THREE.Scene();
    glowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    glowScene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        map: bloomComposer.renderTarget2.texture,
        transparent: true,
        // Add glow COLOR only — never touch the canvas alpha, so the
        // transparent background (CSS sky/clouds) stays visible.
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthTest: false, depthWrite: false,
      })
    ));
  }

  // build the warp speed-lines once (JS-driven so speed varies with acceleration)
  if (warpEl) {
    for (let n = 0; n < 18; n++) {
      const sd = document.createElement("div");
      sd.className = "streak";
      sd.style.left = (Math.random() * 100).toFixed(1) + "%";
      sd.style.height = (16 + Math.random() * 30).toFixed(0) + "vh";
      sd.style.opacity = (0.35 + Math.random() * 0.55).toFixed(2);
      warpEl.appendChild(sd);
      warpStreaks.push({ el: sd, y: -40 - Math.random() * 220 });
    }
  }

  buildElementalParticles();

  resetGame();
  renderer.setAnimationLoop(animate);
}

// Populate the elemental region layers with their drifting particle children.
function buildElementalParticles() {
  const fill = (id, n, build) => {
    const el = document.getElementById(id);
    if (!el) return;
    for (let i = 0; i < n; i++) build(el);
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  fill("bubbles", 22, (el) => {
    const b = document.createElement("div"); b.className = "bubble";
    const s = rnd(6, 26).toFixed(1);
    b.style.left = rnd(0, 100).toFixed(1) + "%"; b.style.width = s + "px"; b.style.height = s + "px";
    b.style.animationDuration = rnd(9, 20).toFixed(1) + "s";
    b.style.animationDelay = "-" + rnd(0, 18).toFixed(1) + "s";
    el.appendChild(b);
  });
  fill("pollen", 22, (el) => {
    const d = document.createElement("div"); d.className = "spore";
    const s = rnd(3, 10).toFixed(1);
    d.style.width = s + "px"; d.style.height = s + "px"; d.style.left = rnd(0, 100).toFixed(1) + "%";
    d.style.animationDuration = rnd(11, 23).toFixed(1) + "s";
    d.style.animationDelay = "-" + rnd(0, 18).toFixed(1) + "s";
    el.appendChild(d);
  });
  fill("leaves", 12, (el) => {
    const d = document.createElement("div"); d.className = "leaf";
    const s = rnd(18, 40).toFixed(0);
    d.style.width = s + "px"; d.style.height = s + "px"; d.style.left = rnd(0, 100).toFixed(1) + "%";
    d.style.opacity = rnd(0.55, 0.9).toFixed(2);
    d.style.animationDuration = rnd(16, 30).toFixed(1) + "s";
    d.style.animationDelay = "-" + rnd(0, 28).toFixed(1) + "s";
    el.appendChild(d);
  });
  fill("rain", 24, (el) => {
    const d = document.createElement("div"); d.className = "raindrop";
    d.style.left = rnd(-4, 114).toFixed(2) + "%";
    d.style.height = rnd(9, 18).toFixed(1) + "vh";
    d.style.width = (Math.random() < 0.35 ? 3 : 2) + "px";
    d.style.opacity = rnd(0.5, 1).toFixed(2);
    d.style.animationDuration = rnd(0.5, 1).toFixed(2) + "s";
    d.style.animationDelay = "-" + rnd(0, 1).toFixed(2) + "s";
    el.appendChild(d);
  });
  fill("snow", 22, (el) => {
    const f = document.createElement("div"); f.className = "flake";
    const s = rnd(2, 8).toFixed(1);
    f.style.left = rnd(0, 100).toFixed(2) + "%"; f.style.width = s + "px"; f.style.height = s + "px";
    f.style.opacity = rnd(0.45, 0.95).toFixed(2);
    f.style.animationDuration = rnd(7, 16).toFixed(1) + "s";
    f.style.animationDelay = "-" + rnd(0, 16).toFixed(1) + "s";
    el.appendChild(f);
  });
  fill("iceGlints", 18, (el) => {
    const g = document.createElement("div"); g.className = "glint";
    const s = rnd(6, 16).toFixed(1);
    g.style.left = rnd(0, 100).toFixed(2) + "%"; g.style.top = rnd(0, 92).toFixed(2) + "%";
    g.style.width = s + "px"; g.style.height = s + "px";
    g.style.animationDuration = rnd(3, 7).toFixed(1) + "s";
    g.style.animationDelay = "-" + rnd(0, 7).toFixed(1) + "s";
    el.appendChild(g);
  });
  // --- region detail particles ---
  fill("jungle_fireflies", 22, (el) => {
    const f = document.createElement("div"); f.className = "jungle_fly";
    const s = rnd(3, 7).toFixed(1);
    f.style.width = s + "px"; f.style.height = s + "px";
    f.style.left = rnd(2, 98).toFixed(1) + "%"; f.style.top = rnd(28, 94).toFixed(1) + "%";
    f.style.animationDuration = rnd(9, 18).toFixed(1) + "s, " + rnd(2.4, 5.5).toFixed(1) + "s";
    f.style.animationDelay = "-" + rnd(0, 18).toFixed(1) + "s, -" + rnd(0, 5).toFixed(1) + "s";
    el.appendChild(f);
  });
  fill("frost_gusts", 20, (el) => {
    const g = document.createElement("div"); g.className = "frost_gust";
    const s = rnd(2, 7).toFixed(1);
    g.style.width = s + "px"; g.style.height = s + "px";
    g.style.top = rnd(0, 96).toFixed(1) + "%"; g.style.left = rnd(-18, 40).toFixed(1) + "%";
    g.style.opacity = rnd(0.35, 0.9).toFixed(2);
    g.style.animationDuration = rnd(2.2, 5.5).toFixed(2) + "s";
    g.style.animationDelay = "-" + rnd(0, 6).toFixed(2) + "s";
    el.appendChild(g);
  });
  fill("storm_gust", 22, (el) => {
    const d = document.createElement("div"); d.className = "storm_gustStreak";
    d.style.left = rnd(8, 128).toFixed(2) + "%";
    d.style.height = rnd(18, 34).toFixed(1) + "vh";
    d.style.width = (Math.random() < 0.3 ? 3 : 2) + "px";
    d.style.opacity = rnd(0.45, 1).toFixed(2);
    d.style.animationDuration = rnd(0.45, 0.85).toFixed(2) + "s";
    d.style.animationDelay = "-" + rnd(0, 0.9).toFixed(2) + "s";
    el.appendChild(d);
  });
}

// Curated color sheet — every block randomly picks a swatch from this list.
const PALETTE = [
  "#ff4d4d", "#ff8a2e", "#ffd02e", "#a6f23a", "#3ff06b",
  "#1fe0c4", "#2bc4ff", "#3a86ff", "#9a5cff", "#d24dff",
  "#ff4db5", "#ff6b6b", "#ffb02e", "#5cf0ff", "#b6ff4d",
];
let lastColorIdx = -1;
function randomColor() {
  let i;
  do { i = Math.floor(Math.random() * PALETTE.length); }
  while (i === lastColorIdx && PALETTE.length > 1); // avoid two identical in a row
  lastColorIdx = i;
  return new THREE.Color(PALETTE[i]);
}

// Bake a subtle top→bottom brightness gradient into the geometry's vertex
// colors (multiplies the block color). Cheap way to get the pretty per-face
// gradient from the real game. Shared geometry => computed once.
function applyVertexShade(geo) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const vY = y + 0.5;                       // 0 bottom .. 1 top
    const vD = ((0.5 - x) + (0.5 - z)) / 2;   // 0 front corner .. 1 back corner
    let s = 0.66 + 0.26 * vY + 0.1 * vD;      // baked ambient occlusion (brighter overall)
    if (s > 1) s = 1;
    colors[i * 3] = s; colors[i * 3 + 1] = s; colors[i * 3 + 2] = s;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/* Build a cube as a Group: colored mesh + black edge outline.
   Group scale encodes the actual dimensions (geometry is a unit cube).
   The unique per-cube material is stored on userData.mat for disposal. */
function makeCube(x, y, z, width, depth, color) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.set(width, BOX_HEIGHT, depth);

  // Faces pushed back in depth (polygonOffset) so the outline never z-fights.
  const mat = new THREE.MeshPhongMaterial({
    color,
    vertexColors: true,                   // baked per-face gradient
    shininess: 14,
    specular: new THREE.Color(0x2e2e2e),  // subtle sheen
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  group.userData.mat = mat;
  group.add(new THREE.Mesh(unitGeo, mat));

  // Black outline on the 12 edges. Fat screen-space lines if available, else
  // 1px lines. Constant thickness regardless of scale, sit ON the edges, so
  // they don't break at stacking seams.
  let outline;
  if (FAT) outline = new THREE.LineSegments2(lineGeo, outlineMat);
  else outline = new THREE.LineSegments(unitEdges, edgeMat);
  group.add(outline);
  group.userData.outline = outline;

  scene.add(group);
  return { group, mat };
}

// Remove a cube from the scene and free its unique material.
function disposeCube(group) {
  if (!group) return;
  scene.remove(group);
  if (group.userData.mat) group.userData.mat.dispose();
  if (pulsing === group) pulsing = null;
}

function addLayer(x, z, width, depth, direction) {
  const y = BOX_HEIGHT * stack.length;
  const color = randomColor();
  const { group } = makeCube(x, y, z, width, depth, color);
  stack.push({ threejs: group, x, z, width, depth, direction, color, dirSign: 1 });

  // Cull the cube that just scrolled out of view (keeps draw calls flat).
  const cutoff = stack.length - MAX_VISIBLE - 1;
  if (cutoff >= 0 && stack[cutoff].threejs) {
    disposeCube(stack[cutoff].threejs);
    stack[cutoff].threejs = null;
  }
}

function addOverhang(x, y, z, width, depth, color, vy) {
  const { group } = makeCube(x, y, z, width, depth, color);
  overhangs.push({
    threejs: group,
    vy: vy || -0.02,
    vrot: (x !== 0 ? Math.sign(x) : Math.sign(z) || 1) * 0.03,
  });
}

function resetGame() {
  stack.forEach((b) => { if (b.threejs) disposeCube(b.threejs); });
  overhangs.forEach((o) => disposeCube(o.threejs));
  particles.forEach((p) => { scene.remove(p.sprite); p.sprite.material.dispose(); });
  if (tntActive) { scene.remove(tntActive.mesh); tntActive = null; } // clear any live dynamite
  shockwaves.forEach((s) => { scene.remove(s.sprite); s.sprite.material.dispose(); });
  auraRings.forEach((r) => { scene.remove(r.mesh); r.mat.dispose(); });
  if (warpEl) warpEl.classList.remove("down");   // drop any TNT descent warp
  if (buildGlowEl) buildGlowEl.classList.remove("down");
  buildDir = 1; buildIntensity = 0; buildAccel = 0;
  stack = [];
  overhangs = [];
  particles = [];
  shockwaves = [];
  auraRings = [];
  tntQueue = [];
  tntBusy = false;
  pulsing = null;
  if (giftSprite) {
    scene.remove(giftSprite);
    giftSprite.material.dispose(); // map is a shared cached texture — don't dispose it
    giftSprite = null;
  }
  pendingNet = 0;
  pendingSize = 1;
  if (cloneBuild) { clearInterval(cloneBuild); cloneBuild = null; }
  buildActive = false;
  popping.forEach((pp) => { scene.remove(pp.group); if (pp.group.userData.mat) pp.group.userData.mat.dispose(); });
  popping = [];
  flashOutlines = [];
  shake = 0;
  score = 0;
  combo = 0;
  camY = 0;
  gameOver = false;
  gameStarted = false;
  paused = false;
  pauseOverlay.classList.add("hidden");
  resetActive = false;
  if (resetInterval) { clearInterval(resetInterval); resetInterval = null; }
  if (resetTimerEl) resetTimerEl.classList.add("hidden");
  buildIntensity = 0;
  warpAmt = 0;
  viewScale = 1;
  if (warpEl) warpEl.style.opacity = 0;
  if (buildGlowEl) buildGlowEl.style.opacity = 0;
  if (scoreEl) scoreEl.classList.remove("pump");

  scoreEl.textContent = "0";
  comboEl.classList.remove("show");
  displayedScore = 0;
  lastSkyApplied = -999;
  lastZoneIndex = -1;
  lastBgStr = "";
  lastStarsCov = -1;
  applySky(0);

  // foundation + first moving cube (slides along x)
  addLayer(0, 0, ORIGINAL_SIZE, ORIGINAL_SIZE);
  addLayer(-SPAWN_OFFSET, 0, ORIGINAL_SIZE, ORIGINAL_SIZE, "x");

  // pop the fresh cubes IN so a reset grows in smoothly instead of snapping
  for (let k = 0; k < stack.length; k++) {
    const g = stack[k].threejs;
    if (g) {
      const w = stack[k].width, d = stack[k].depth;
      g.scale.set(w * 0.2, BOX_HEIGHT * 0.2, d * 0.2);
      popping.push({ group: g, tw: w, td: d, t: 0 });
    }
  }

  camera.position.set(24, 22, 24);
  camera.lookAt(0, 0, 0);
}

function startGame() {
  if (gameStarted) return; // idempotent: ignore redundant starts (pointerdown + click)
  resetGame();
  gameStarted = true;
  overlay.classList.add("hidden");
  sfx("resume");
  sfx("start");
}

/* ---------------- Core mechanic ---------------- */
function placeBlock() {
  if (!gameStarted || gameOver || paused || resetActive || buildActive) return;

  const top = stack[stack.length - 1];
  const prev = stack[stack.length - 2];
  const dir = top.direction;

  const delta = top.threejs.position[dir] - prev.threejs.position[dir];
  const overhangSize = Math.abs(delta);
  const size = dir === "x" ? top.width : top.depth;
  const overlap = size - overhangSize;

  if (overlap <= 0) {
    // COMPLETE MISS — the piece tumbles into the void, but you're NOT out.
    // Drop it and spawn a fresh piece to retry this same level.
    addOverhang(
      top.threejs.position.x, top.threejs.position.y, top.threejs.position.z,
      top.width, top.depth, top.color, -0.05
    );
    disposeCube(top.threejs);
    top.threejs = null;
    stack.pop();
    combo = 0;
    comboEl.classList.remove("show");
    // A whiff arms a -25 onto the held block (doesn't dock score now). Keep missing
    // and it stacks (-50, -75...); it only hits your score once you place it.
    pendingNet -= 25;
    pendingSize = 1;
    flashMsg("-25!", "#ff5a52");
    sfx("miss");

    const base = stack[stack.length - 1]; // the block we're retrying onto
    const retryX = dir === "x" ? -SPAWN_OFFSET : base.threejs.position.x;
    const retryZ = dir === "z" ? -SPAWN_OFFSET : base.threejs.position.z;
    addLayer(retryX, retryZ, base.width, base.depth, dir);
    setGiftVisual(); // re-show the rocket on the retry block if still armed
    addShake(0.4);   // thud
    return;
  }

  // Auto-assist: snap to perfect if within assistPercent of the block size.
  const threshold = (assistPercent / 100) * size;
  let perfectHit = false;
  let grew = false;

  if (overhangSize <= threshold) {
    // PERFECT (snapped) — align exactly on, take the block-below's size
    perfectHit = true;
    top.threejs.position[dir] = prev.threejs.position[dir];
    top.width = prev.width;
    top.depth = prev.depth;
    combo++;
    showCombo(); // score stays = block count; streaks pay off via milestone squares, not raw points
    sfx("perfect", combo); // chime that climbs the scale with your streak
    // The streak keeps climbing (never resets on a perfect). Every 5th perfect
    // grows the block back toward max — but only if it isn't already max size
    // (so it never says "BIGGER!" when you're already full size).
    if (combo % PERFECTS_TO_GROW === 0) {
      const w0 = top.width, d0 = top.depth;
      if (w0 < ORIGINAL_SIZE || d0 < ORIGINAL_SIZE) {
        top.width = Math.min(ORIGINAL_SIZE, w0 + GROW_AMOUNT);
        top.depth = Math.min(ORIGINAL_SIZE, d0 + GROW_AMOUNT);
        // grow TOWARD center (0,0): pull the block back toward the middle by the
        // fraction of the remaining size-gap we just closed, so a corner piece
        // re-centers as it grows instead of ballooning out from the corner.
        const fx = ORIGINAL_SIZE > w0 ? (top.width - w0) / (ORIGINAL_SIZE - w0) : 0;
        const fz = ORIGINAL_SIZE > d0 ? (top.depth - d0) / (ORIGINAL_SIZE - d0) : 0;
        top.threejs.position.x -= top.threejs.position.x * fx;
        top.threejs.position.z -= top.threejs.position.z * fz;
        grew = true;
      }
    }
    top.threejs.scale.x = top.width;
    top.threejs.scale.z = top.depth;
    if (pulsing && pulsing !== top.threejs) pulsing.scale.y = BOX_HEIGHT;
    pulsing = top.threejs;
    pulsing.userData.pulse = 1;
  } else {
    combo = 0;
    comboEl.classList.remove("show");
    sfx("slice");

    // slice the cube down to the overlapping part
    top.threejs.scale[dir] = overlap;
    top.threejs.position[dir] -= delta / 2;
    if (dir === "x") top.width = overlap; else top.depth = overlap;

    // the sliced-off overhang falls into the void
    const shift = (overlap / 2 + overhangSize / 2) * Math.sign(delta);
    const ohX = dir === "x" ? top.threejs.position.x + shift : top.threejs.position.x;
    const ohZ = dir === "z" ? top.threejs.position.z + shift : top.threejs.position.z;
    const ohW = dir === "x" ? overhangSize : top.width;
    const ohD = dir === "z" ? overhangSize : top.depth;
    addOverhang(ohX, top.threejs.position.y, ohZ, ohW, ohD, top.color, -0.01);
  }

  // remember the placed block's final position (so it can be rebuilt later)
  top.x = top.threejs.position.x;
  top.z = top.threejs.position.z;

  // Size gift: an armed 2x / half resizes this block (and the size carries forward)
  if (pendingSize !== 1) {
    const m = pendingSize;
    pendingSize = 1;
    if (top.threejs && top.threejs.userData.mat) top.threejs.userData.mat.emissive.setHex(0x000000);
    const w0 = top.width, d0 = top.depth;
    top.width = Math.max(0.7, Math.min(ORIGINAL_SIZE, w0 * m));
    top.depth = Math.max(0.7, Math.min(ORIGINAL_SIZE, d0 * m));
    if (m > 1) { // growing: pull back toward center like the streak-grow
      const fx = ORIGINAL_SIZE > w0 ? (top.width - w0) / (ORIGINAL_SIZE - w0) : 0;
      const fz = ORIGINAL_SIZE > d0 ? (top.depth - d0) / (ORIGINAL_SIZE - d0) : 0;
      top.threejs.position.x -= top.threejs.position.x * fx;
      top.threejs.position.z -= top.threejs.position.z * fz;
    }
    top.threejs.scale.x = top.width;
    top.threejs.scale.z = top.depth;
    top.x = top.threejs.position.x;
    top.z = top.threejs.position.z;
    setGiftVisual();
    const sx2 = top.threejs.position.x, sy2 = top.threejs.position.y + BOX_HEIGHT / 2, sz2 = top.threejs.position.z;
    if (m > 1) { spawnBurst(sx2, sy2, sz2, 0x6bff5a, 16, { up: 1, speed: 0.2 }); flashMsg("2× SIZE!", "#6bff5a"); }
    else { spawnBurst(sx2, sy2, sz2, 0xff8a3c, 14, { up: 0.6, speed: 0.16 }); flashMsg("½ SIZE!", "#ff8a3c"); }
    addShake(0.4);
  }

  // sparkle / star burst on the freshly placed block
  const bx = top.threejs.position.x;
  const by = top.threejs.position.y + BOX_HEIGHT / 2;
  const bz = top.threejs.position.z;
  if (perfectHit) {
    // sparkles + a white face flash (not the outline, so no black-stroke conflict)
    spawnBurst(bx, by, bz, 0xffd24d, 16, { up: 0.8, speed: 0.16 }); // gold sparkles
    spawnBurst(bx, by, bz, 0xff4d4d, 10, { up: 1.8, speed: 0.12 }); // red stars upward
    flashFace(top.threejs);
  }
  if (grew) {
    spawnBurst(bx, by, bz, 0x6bff5a, 16, { up: 1.2, speed: 0.2 }); // green grow burst
    flashMsg("BIGGER!", "#6bff5a");
    addShake(0.4);
    sfx("grow");
  }

  score++; // one block placed = one point (score = tower height)

  // Streak milestones: every 5 -> +5, every 25 -> +25, every 50 -> +1250. Fold the
  // reward INTO pendingNet so it COMBINES with any queued gift instead of being
  // skipped (the old order let a pending gift return early and eat your streak payout).
  if (perfectHit && combo > 0 && combo % 5 === 0) {
    const milestoneN = combo % 50 === 0 ? 1250 : combo % 25 === 0 ? 25 : 5;
    pendingNet += milestoneN;
    flashMsg("STREAK x" + combo + "  +" + milestoneN + "!", "#ffd24d");
    sfx("milestone");
  }

  // Apply the running net (gifts + streak): +N rockets up, -N bombs down. They add
  // into one signed pendingNet, so a -25 then a +250 = a +225 block.
  if (pendingNet !== 0) {
    if (top.threejs && top.threejs.userData.mat) top.threejs.userData.mat.emissive.setHex(0x000000);
    const n = pendingNet;
    pendingNet = 0;
    setGiftVisual();
    refreshScore();
    if (n > 0) { flashMsg("+" + n, "#6bff5a"); startCloneBuild(n, top.x, top.z, top.width, top.depth, dir); }
    else { flashMsg(String(n), "#ff5a52"); startRemoveBuild(-n, dir); }
    return;
  }

  refreshScore();

  // next moving block, alternating direction
  const nextDir = dir === "x" ? "z" : "x";
  const nextX = nextDir === "x" ? -SPAWN_OFFSET : top.x;
  const nextZ = nextDir === "z" ? -SPAWN_OFFSET : top.z;
  addLayer(nextX, nextZ, top.width, top.depth, nextDir);
  maybeRandomPowerup(); // chance for the new block to be a random powerup
}

function showCombo() {
  comboEl.textContent = "PERFECT x" + combo;
  comboEl.classList.remove("show");
  void comboEl.offsetWidth; // restart the pop animation
  comboEl.classList.add("show");
}

/* ---------------- Animation loop (O(1) per frame) ---------------- */
function animate() {
  actionLocked = false; // one action allowed per frame

  // frame-rate-independent timing: 1.0 at 60fps, ~2.0 at 30fps (clamped so a lag
  // spike / tab refocus can't teleport a block across the screen)
  const _now = performance.now();
  const dtf = lastFrameTime ? Math.min(3, (_now - lastFrameTime) / 16.6667) : 1;
  lastFrameTime = _now;

  if (!paused) {
    if (gameStarted && !gameOver && !resetActive && !buildActive && stack.length >= 2) {
      const top = stack[stack.length - 1];
      // Base speed never ramps with HEIGHT/score. A very subtle bump scales with
      // your STREAK (combo) to make huge streaks harder; a miss resets it to base.
      const streakBump = 1 + Math.min(1.4, combo * 0.02); // streak 0=1x, 25=1.5x, 50=2x, 70+=2.4x (cap)
      const speed = (speedSetting / 100) * streakBump;
      top.threejs.position[top.direction] += speed * top.dirSign * dtf;
      const p = top.threejs.position[top.direction];
      if (p > SPAWN_OFFSET) { top.threejs.position[top.direction] = SPAWN_OFFSET; top.dirSign = -1; }
      else if (p < -SPAWN_OFFSET) { top.threejs.position[top.direction] = -SPAWN_OFFSET; top.dirSign = 1; }
    }

    // falling overhang pieces tumble into the void
    for (let i = overhangs.length - 1; i >= 0; i--) {
      const o = overhangs[i];
      o.vy -= (o.g || 0.012);                   // explosion debris falls faster (heavier g)
      o.threejs.position.y += o.vy;
      if (o.vx) o.threejs.position.x += o.vx;   // explosion debris flies off the sides
      if (o.vz) o.threejs.position.z += o.vz;
      o.threejs.rotation.z += o.vrot;
      o.threejs.rotation.x += o.vrot * 0.6;
      if (o.threejs.position.y < -50) {
        disposeCube(o.threejs);
        overhangs.splice(i, 1);
      }
    }

    updateParticles(); // sparkle / star bursts
    updateTNT(dtf);        // falling dynamite
    updateShockwaves(dtf); // blast flashes
    updateAuraRings(dtf);  // big-rocket rings

    // white face flash on perfects -> fade the cube's emissive back to normal
    for (let i = faceFlashes.length - 1; i >= 0; i--) {
      const ff = faceFlashes[i];
      ff.t += 0.08;
      const e = Math.max(0, 1 - ff.t) * 0.9;
      ff.mat.emissive.setRGB(e, e, e);
      if (ff.t >= 1) { ff.mat.emissive.setRGB(0, 0, 0); faceFlashes.splice(i, 1); }
    }

    // pop-in animation for freshly spawned gift clones
    for (let i = popping.length - 1; i >= 0; i--) {
      const pp = popping[i];
      pp.t += pp.out ? 0.2 : 0.16;
      if (pp.out) {
        // bomb removal: shrink to nothing, then dispose
        const m = Math.max(0, 1 - pp.t);
        pp.group.scale.set(pp.tw * m, BOX_HEIGHT * m, pp.td * m);
        if (pp.t >= 1) {
          scene.remove(pp.group);
          if (pp.group.userData.mat) pp.group.userData.mat.dispose();
          popping.splice(i, 1);
        }
      } else {
        // clone pop-in: grow from small to full
        const e = pp.t >= 1 ? 1 : 1 - Math.pow(1 - pp.t, 3);
        const m = 0.2 + 0.8 * e;
        pp.group.scale.set(pp.tw * m, BOX_HEIGHT * m, pp.td * m);
        if (pp.t >= 1) { pp.group.scale.set(pp.tw, BOX_HEIGHT, pp.td); popping.splice(i, 1); }
      }
    }

    // keep the rocket gift label sitting on the moving block
    if (giftSprite) {
      const mv = stack[stack.length - 1];
      if (mv && mv.threejs) {
        giftSprite.position.set(
          mv.threejs.position.x,
          mv.threejs.position.y + BOX_HEIGHT / 2 + 2.6,
          mv.threejs.position.z
        );
      }
    }

    // perfect-placement squash pulse (single tracked cube)
    if (pulsing) {
      const p = (pulsing.userData.pulse -= 0.08);
      if (p <= 0) {
        pulsing.scale.y = BOX_HEIGHT;
        pulsing = null;
      } else {
        pulsing.scale.y = BOX_HEIGHT * (1 + p * 0.07);
      }
    }

    // Sky: smoothed + throttled — eases toward the score (so big jumps still
    // scroll through the zones) but only repaints a few times/sec, and the
    // gradient/mask are cached so unchanged frames cost nothing.
    displayedScore += (score - displayedScore) * 0.04; // slower = gentler region transitions on score jumps
    // skip the sky update when the score isn't meaningfully changing (avoids the
    // per-frame colour allocations / GC churn that caused occasional input hitches)
    if (Math.abs(displayedScore - lastSkyApplied) > 0.1) {
      applySky(displayedScore);
      lastSkyApplied = displayedScore;
    }

    // smooth camera follow as the tower grows (+ camera shake)
    const goal = Math.max(0, BOX_HEIGHT * (stack.length - 2));
    // follow much faster during a gift build so the camera keeps up with it
    camY += (goal - camY) * (buildActive ? 0.45 : 0.08);
    let sx = 0, sy = 0, sz = 0;
    if (shake > 0.002) {
      sx = (Math.random() * 2 - 1) * shake;
      sy = (Math.random() * 2 - 1) * shake;
      sz = (Math.random() * 2 - 1) * shake;
      shake *= 0.86;
    } else { shake = 0; }
    camera.position.set(24 + sx, 22 + camY + sy, 24 + sz);
    camera.lookAt(sx, camY + sy, sz); // shift target equally => pure translation jitter

    // Big-build warp: speed-lines, edge glow, camera zoom-out, score pump.
    // All ramp with the build's ACCELERATION (accel), scaled by gift size (bi).
    const bi = buildActive ? buildIntensity : 0;
    const accel = buildActive ? buildAccel : 0;
    const warpTarget = bi * (0.2 + 0.8 * accel);
    warpAmt += (warpTarget - warpAmt) * 0.12;
    if (warpEl) warpEl.style.opacity = warpAmt.toFixed(3);
    if (buildGlowEl) buildGlowEl.style.opacity = (warpAmt * 0.85).toFixed(3);
    if (warpAmt > 0.01) {
      const spd = (7 + accel * 26) * buildDir; // rocket: streaks fall; bomb: streaks rush up
      for (let n = 0; n < warpStreaks.length; n++) {
        const stk = warpStreaks[n];
        stk.y += spd;
        if (stk.y > 178) stk.y = -40 - Math.random() * 40;
        else if (stk.y < -45) stk.y = 178 + Math.random() * 40;
        stk.el.style.transform = "translateY(" + stk.y.toFixed(1) + "vh)";
      }
    }
    const zoomTarget = 1 + 0.34 * bi * accel; // zoom-out ramps with acceleration too
    viewScale += (zoomTarget - viewScale) * 0.08;
    if (Math.abs(viewScale - 1) > 0.002) {
      const aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
      const vh = VIEW_H * viewScale, vw = vh * aspect;
      camera.left = -vw / 2; camera.right = vw / 2; camera.top = vh / 2; camera.bottom = -vh / 2;
      camera.updateProjectionMatrix();
    } else if (viewScale !== 1) {
      viewScale = 1;
      resizeRenderer(); // settle back to the exact base frustum
    }
    if (scoreEl) scoreEl.classList.toggle("pump", bi > 0.3 && accel > 0.15);
  }

  if (BLOOM) {
    try {
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(scene, camera);       // full scene -> screen (transparent bg)
      camera.layers.set(BLOOM_LAYER);
      bloomComposer.render();               // glow of bright objects -> target
      camera.layers.set(0);
      renderer.autoClear = false;
      renderer.render(glowScene, glowCam);  // add the glow on top
      renderer.autoClear = true;
    } catch (e) {
      BLOOM = false;                        // fall back to plain render on any error
      renderer.autoClear = true;
      renderer.render(scene, camera);
    }
  } else {
    renderer.render(scene, camera);
  }
}

/* ---------------- Sizing (full window, vertical-anchored zoom) ---------------- */
function resizeRenderer() {
  resizePending = false;
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  const aspect = w / h;
  const viewW = VIEW_H * aspect;
  camera.left = -viewW / 2;
  camera.right = viewW / 2;
  camera.top = VIEW_H / 2;
  camera.bottom = -VIEW_H / 2;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setSize(w, h);
  if (FAT && outlineMat) outlineMat.resolution.set(w, h);
  if (FAT && whiteOutlineMat) whiteOutlineMat.resolution.set(w, h);
  if (BLOOM && bloomComposer) {
    const bw = Math.max(1, Math.round(w * 0.5)), bh = Math.max(1, Math.round(h * 0.5));
    bloomComposer.setSize(bw, bh); // half-res glow (looks identical, far cheaper)
    if (bloomPass) bloomPass.setSize(bw, bh);
  }
}
function scheduleResize() {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(resizeRenderer);
}
window.addEventListener("resize", scheduleResize);
if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleResize);

/* ---------------- Effects ---------------- */
function makeStarTexture() {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const cx = s / 2, cy = s / 2;
  // faint soft halo behind the star
  const rg = g.createRadialGradient(cx, cy, 0, cx, cy, cx);
  rg.addColorStop(0, "rgba(255,255,255,0.55)");
  rg.addColorStop(0.4, "rgba(255,255,255,0.12)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  // crisp 4-point sparkle (thin arms, bright)
  const R = cx * 0.95, rIn = cx * 0.14;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI / 4) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? R : rIn;
    const px = cx + Math.cos(ang) * rad;
    const py = cy + Math.sin(ang) * rad;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fillStyle = "rgba(255,255,255,1)";
  g.fill();
  return new THREE.CanvasTexture(c);
}

function spawnBurst(x, y, z, colorHex, count, opt) {
  if (!starTex) return;
  opt = opt || {};
  const baseScale = opt.scale || 0.55;
  const speed = opt.speed || 0.14;
  const up = opt.up == null ? 0.6 : opt.up;
  for (let k = 0; k < count; k++) {
    const mat = new THREE.SpriteMaterial({
      map: starTex, color: colorHex, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z);
    const s = baseScale * (0.7 + Math.random() * 0.6);
    sp.scale.set(s, s, s);
    sp.layers.enable(BLOOM_LAYER); // sparkles glow
    scene.add(sp);
    const ang = Math.random() * Math.PI * 2;
    const rad = speed * (0.4 + Math.random());
    particles.push({
      sprite: sp,
      vx: Math.cos(ang) * rad,
      vz: Math.sin(ang) * rad,
      vy: (up + Math.random() * 0.6) * speed * 2.2,
      life: 0.7 + Math.random() * 0.4,
      maxLife: 1.1,
      baseScale: s,
      spin: (Math.random() - 0.5) * 0.25,
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= 0.016;
    p.vy -= 0.006;
    p.sprite.position.x += p.vx;
    p.sprite.position.y += p.vy;
    p.sprite.position.z += p.vz;
    p.sprite.material.rotation += p.spin;
    const t = Math.max(0, p.life) / p.maxLife;
    p.sprite.material.opacity = Math.min(1, t * 1.7);
    const sc = p.baseScale * (0.4 + 0.6 * t);
    p.sprite.scale.set(sc, sc, sc);
    if (p.life <= 0) {
      scene.remove(p.sprite);
      p.sprite.material.dispose();
      particles.splice(i, 1);
    }
  }
}

/* ---------------- Background by height (warm low -> blue sky high) ---------------- */
// ---- Sky zones: a slow journey from open sky up to deep cosmos ----
// Each zone: start score, sky colors (bottom/top) and how much of each thing.
// A vertical journey: up out of the ocean, through a jungle, the open sky, a
// storm and frozen peaks, then on into space. Each zone lists ONLY the layers it
// shows (mix() treats missing fields as 0).
const ZONES = [
  { at: 0,      name: "Open Sky",      bottom: "#cfeafe", top: "#4a93dd", clouds: 0.55, sun: 1.0 },
  { at: 300,    name: "Ocean Depths",  bottom: "#021c2b", top: "#3fb6c9", godrays: 1, bubbles: 0.9 },
  { at: 750,    name: "Jungle Canopy", bottom: "#0b3a1e", top: "#bfe85a", pollen: 0.9, leaves: 0.7, jungle_mist: 0.55, jungle_fireflies: 1, jungle_vignette: 0.8, jv2_dapple: 0.85, jv2_shafts: 0.7, jv2_foliage: 0.9 },
  { at: 1500,   name: "Stormfront",    bottom: "#252d39", top: "#0a0e16", stormclouds: 1, rain: 0.9, lightning: 1, storm_bankBack: 1, storm_bankFront: 1, storm_gust: 0.9, storm_bolts: 1 },
  { at: 3000,   name: "Frozen Peaks",  bottom: "#9cc9e8", top: "#e6f4ff", snow: 1, frostAurora: 0.7, iceGlints: 0.9, frost_sun: 1, frost_aurora2: 1, frost_peaksFar: 1, frost_peaksMid: 1, frost_peaksNear: 1, frost_gusts: 1 },
  { at: 6000,   name: "High Altitude", bottom: "#a9d6f5", top: "#1f63b0", clouds: 1.0, sun: 0.85 },
  { at: 11000,  name: "Edge of Space", bottom: "#f0974f", top: "#101f48", clouds: 0.25, stars: 0.45, planet: 0.3, sun: 0.25 },
  { at: 19000,  name: "Outer Space",   bottom: "#0b1733", top: "#03060f", stars: 1.0, planet: 1.0 },
  { at: 32000,  name: "The Galaxy",    bottom: "#0d1436", top: "#070420", stars: 1.0, nebula: 0.45, band: 1.0, planet: 0.5 },
  { at: 55000,  name: "Nebula",        bottom: "#240a3e", top: "#0c0422", stars: 1.0, nebula: 1.0, band: 0.3 },
  { at: 90000,  name: "Aurora Void",   bottom: "#042016", top: "#02080a", stars: 1.0, nebula: 0.12, aurora: 1.0 },
  { at: 150000, name: "The Beyond",    bottom: "#2e0a48", top: "#0c0420", stars: 1.0, nebula: 0.9, aurora: 0.4, band: 0.5, core: 1.0 },
];

// Pre-parse each zone's colours once, and reuse scratch Colors, so the sky update
// allocates nothing per frame (avoids GC stutter).
const _scratchA = new THREE.Color();
const _scratchB = new THREE.Color();
for (const z of ZONES) { z._b = new THREE.Color(z.bottom); z._t = new THREE.Color(z.top); }

// set opacity AND pause the layer's CSS animation while it's invisible (so its
// filter/hue animations stop repainting when you can't see it) — no visual change.
function paintLayer(el, op) {
  if (!el) return;
  el.style.opacity = op;
  // pause the layer AND its particle children while invisible (no offscreen repaint)
  el.classList.toggle("fx-paused", op <= 0.01);
}

// Set the whole sky from a (smoothed) score: gradient + clouds + stars.
function applySky(s) {
  skyTick++;
  let i = ZONES.length - 1;
  for (let z = 0; z < ZONES.length; z++) if (s >= ZONES[z].at) i = z;
  const cur = ZONES[i];
  const nxt = ZONES[i + 1] || cur;
  const span = (nxt.at - cur.at) || 1;
  const t = nxt === cur ? 0 : Math.max(0, Math.min(1, (s - cur.at) / span));
  // The sky GRADIENT glides smoothly over the whole span (uses t, below).
  // The decorative LAYERS instead stay fully "in" their zone for ~80% of the span,
  // then cross-fade only in the last stretch — so distinct region elements (leaves,
  // lightning, peaks) don't ghost over the previous zone for the whole transition.
  const HOLD = 0.8;
  const tb = Math.max(0, Math.min(1, (t - HOLD) / (1 - HOLD)));
  const tBand = tb * tb * (3 - 2 * tb); // smoothstep the handoff
  const mix = (a, b) => { a = a || 0; b = b || 0; return a + (b - a) * tBand; };

  const bottom = _scratchA.copy(cur._b).lerp(nxt._b, t).getStyle();
  const top = _scratchB.copy(cur._t).lerp(nxt._t, t).getStyle();
  if (bgEl) {
    const bgStr = "linear-gradient(to top, " + bottom + " 0%, " + top + " 100%)";
    // only repaint the full-screen gradient ~15x/sec (it's the expensive part)
    if (bgStr !== lastBgStr && (skyTick % 4 === 0 || lastBgStr === "")) {
      bgEl.style.background = bgStr;
      lastBgStr = bgStr;
    }
  }

  if (cloudsEl) cloudsEl.style.opacity = mix(cur.clouds, nxt.clouds);

  if (starsEl) {
    const stars = mix(cur.stars, nxt.stars);
    starsEl.style.opacity = stars > 0.01 ? 0.95 : 0;
    starsEl.style.animationPlayState = stars > 0.01 ? "running" : "paused"; // pause twinkle when hidden
    const cov = Math.round(stars * 100); // stars fill in from the TOP of the screen
    if (cov !== lastStarsCov) {
      const mask = "linear-gradient(to bottom, #000 " + cov + "%, transparent " + Math.min(100, cov + 18) + "%)";
      starsEl.style.webkitMaskImage = mask;
      starsEl.style.maskImage = mask;
      lastStarsCov = cov;
    }
  }

  paintLayer(nebulaEl, mix(cur.nebula, nxt.nebula));
  paintLayer(galaxyEl, mix(cur.band, nxt.band));
  paintLayer(auroraEl, mix(cur.aurora, nxt.aurora));
  paintLayer(planetEl, mix(cur.planet, nxt.planet) * 0.95);
  paintLayer(sunEl, mix(cur.sun, nxt.sun));
  paintLayer(shootEl, mix(cur.stars, nxt.stars)); // shooting stars in space
  paintLayer(motesEl, Math.max(mix(cur.stars, nxt.stars) * 0.4, mix(cur.nebula, nxt.nebula), mix(cur.aurora, nxt.aurora)) * 0.9);
  paintLayer(coreEl, mix(cur.core, nxt.core));

  // elemental regions
  paintLayer(godraysEl, mix(cur.godrays, nxt.godrays));
  paintLayer(bubblesEl, mix(cur.bubbles, nxt.bubbles));
  paintLayer(jungleraysEl, mix(cur.junglerays, nxt.junglerays));
  paintLayer(pollenEl, mix(cur.pollen, nxt.pollen));
  paintLayer(leavesEl, mix(cur.leaves, nxt.leaves));
  paintLayer(stormcloudsEl, mix(cur.stormclouds, nxt.stormclouds));
  paintLayer(rainEl, mix(cur.rain, nxt.rain));
  paintLayer(lightningEl, mix(cur.lightning, nxt.lightning));
  paintLayer(frostAuroraEl, mix(cur.frostAurora, nxt.frostAurora));
  paintLayer(snowEl, mix(cur.snow, nxt.snow));
  paintLayer(iceGlintsEl, mix(cur.iceGlints, nxt.iceGlints));

  // region detail / depth layers (sparse fields, mix defaults to 0)
  for (const id of DETAIL_LAYERS) paintLayer(detailEls[id], mix(cur[id], nxt[id]));

  // Parallax: layers drift DOWN as you climb (different rates = depth)
  if (cloudsEl) cloudsEl.style.transform = "translateY(" + (s * 0.05).toFixed(2) + "vh)";
  if (starsEl) starsEl.style.backgroundPositionY = (s * 0.5).toFixed(1) + "px";

  // Announce when you cross into a new region
  if (i !== lastZoneIndex) {
    if (lastZoneIndex !== -1) showZoneBanner(cur.name);
    lastZoneIndex = i;
  }
}

function showZoneBanner(name) {
  if (!zoneBannerEl) return;
  zoneBannerEl.textContent = name;
  zoneBannerEl.classList.remove("show");
  void zoneBannerEl.offsetWidth; // restart the entrance animation
  zoneBannerEl.classList.add("show");
  if (zoneBannerTimer) clearTimeout(zoneBannerTimer);
  zoneBannerTimer = setTimeout(() => zoneBannerEl.classList.remove("show"), 2600);
}

function refreshScore() {
  scoreEl.textContent = score;
  if (score > record) {
    record = score;
    recordEl.textContent = record;
    saveSetting("stack_record", record);
  }
  refreshGoal();
  // sky is updated from a throttled, smoothed score in animate() (perf)
}

function addShake(amount) {
  shake = Math.min(MAX_SHAKE, shake + amount);
}

// Flash a cube's faces white briefly — on a perfect landing (no outline conflict).
function flashFace(group) {
  const m = group && group.userData.mat;
  if (!m) return;
  m.emissive.setRGB(1, 1, 1);
  faceFlashes.push({ mat: m, t: 0 });
}


/* ---------------- Gift actions ---------------- */
// Recreate meshes for the top MAX_VISIBLE blocks, drop the rest (after removals).
function rebuildVisible() {
  const startIdx = Math.max(0, stack.length - MAX_VISIBLE);
  for (let i = 0; i < stack.length; i++) {
    const b = stack[i];
    if (i < startIdx) {
      if (b.threejs) { disposeCube(b.threejs); b.threejs = null; }
    } else if (!b.threejs) {
      const { group } = makeCube(b.x, BOX_HEIGHT * i, b.z, b.width, b.depth, b.color);
      b.threejs = group;
    }
  }
}

function ensureStarted() {
  if (!gameStarted) startGame();
}

function softReset() {
  resetGame();
  gameStarted = true;
  overlay.classList.add("hidden");
}

function flashMsg(text, color) {
  flashEl.textContent = text;
  flashEl.style.color = color || "#fff";
  flashEl.classList.remove("show");
  void flashEl.offsetWidth;
  flashEl.classList.add("show");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashEl.classList.remove("show"), 900);
}

// A "+N" powerup ARMS the next drop: you place ONE block (shown as a rocket
// gift block) and on landing it clones upward into N blocks.
function armClones(n) {
  ensureStarted();
  pendingNet += n; // adds into the running net (+/- combine: -25 then +250 = +225)
  pendingSize = 1;
  setGiftVisual();
  flashMsg("+" + n + "!", "#ffd24d");
  sfx("arm", true);
}

// A "go down" gift now DROPS DYNAMITE instead of arming a bomb on the held block.
// It queues a TNT that falls from the sky, lands on the tower and explodes.
function armRemove(n) {
  ensureStarted();
  queueTNT(n);
}

/* ---------------- TNT / dynamite down system ---------------- */
// Shared dynamite geometry/materials, built once (after THREE + starTex exist).
let dynAssets = null;
function ensureDynAssets() {
  if (dynAssets) return dynAssets;
  dynAssets = {
    stick: new THREE.CylinderGeometry(0.44, 0.44, 3.0, 16),
    band: new THREE.CylinderGeometry(0.47, 0.47, 0.55, 16),
    fuse: new THREE.CylinderGeometry(0.09, 0.09, 1.3, 8),
    body: new THREE.MeshPhongMaterial({ color: 0xd8342a, emissive: 0x3a0a06, shininess: 28, specular: 0x552018 }),
    tape: new THREE.MeshPhongMaterial({ color: 0xf2c14e, emissive: 0x2a1e06, shininess: 10 }), // yellow band
    fuseMat: new THREE.MeshPhongMaterial({ color: 0x2b2b2b }),
    spark: starTex
      ? new THREE.SpriteMaterial({ map: starTex, color: 0xffe08a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
      : null,
  };
  return dynAssets;
}

// A small stick of dynamite: a little bundle of red sticks with a yellow band
// and a lit fuse spark on top.
function makeDynamite() {
  const a = ensureDynAssets();
  const g = new THREE.Group();
  const offs = [[-0.48, 0.14], [0.48, 0.14], [0, -0.5]]; // three sticks bundled
  offs.forEach((o) => {
    const s = new THREE.Mesh(a.stick, a.body);
    s.position.set(o[0], 0, o[1]);
    g.add(s);
    const band = new THREE.Mesh(a.band, a.tape);
    band.position.set(o[0], 0.25, o[1]);
    g.add(band);
  });
  const fuse = new THREE.Mesh(a.fuse, a.fuseMat);
  fuse.position.set(0.15, 2.0, 0.05);
  fuse.rotation.z = 0.5; // droops to one side
  g.add(fuse);
  let spark = null;
  if (a.spark) {
    spark = new THREE.Sprite(a.spark);
    spark.position.set(0.42, 2.55, 0.05); // burning tip
    spark.scale.set(1.7, 1.7, 1.7);
    spark.layers.enable(BLOOM_LAYER); // fuse glows
    g.add(spark);
  }
  g.userData.spark = spark;
  return g;
}

// Enqueue a down amount. Starts immediately if nothing else is animating;
// otherwise it waits its turn so every gift still plays (one blast at a time).
function queueTNT(n) {
  if (n <= 0 || gameOver || resetActive || !gameStarted) return;
  tntQueue.push(n);
  flashMsg("TNT −" + n + "!", "#ff5a52");
  if (!tntBusy && !buildActive) startNextTNT();
}

// Drain one dynamite from the queue and drop it onto the tower.
function startNextTNT(dirAfter) {
  if (!tntQueue.length) { tntBusy = false; return; }
  tntBusy = true;
  buildActive = true; // freeze the sliding block while the blast plays out
  const n = tntQueue.shift();
  const top = stack[stack.length - 1];
  // Drop onto the SETTLED tower center (the placed block below the sliding one),
  // not wherever the moving block happens to be — otherwise it lands off to the
  // edge / off-screen. The camera always frames the tower's center column.
  const settled = stack[stack.length - 2] || top;
  const cx = settled && settled.threejs ? settled.threejs.position.x : 0;
  const cz = settled && settled.threejs ? settled.threejs.position.z : 0;
  // Snap the sliding block back OVER the tower so it doesn't sit frozen off to
  // the side during the blast (that was the "block stuck to the left" glitch).
  if (top && top.threejs && top !== settled) {
    top.threejs.position.x = cx;
    top.threejs.position.z = cz;
    top.x = settled.x; top.z = settled.z;
  }
  const topSurface = BOX_HEIGHT * (stack.length - 1) + BOX_HEIGHT / 2;
  // No warp during the fall/pause — the descent warp engages only at the blast.
  buildDir = 1; buildIntensity = 0; buildAccel = 0;
  if (warpEl) warpEl.classList.remove("down");
  if (buildGlowEl) buildGlowEl.classList.remove("down");
  const mesh = makeDynamite();
  mesh.position.set(cx, topSurface + 9, cz); // a short, readable drop from just overhead
  mesh.rotation.z = 0.2;
  scene.add(mesh);
  sfx("dive", Math.min(1, n / 500)); // falling whistle
  tntActive = {
    mesh, n, cx, cz,
    phase: "fall",
    vy: -0.06,                  // eases in gently so the drop is watchable
    targetY: topSurface + 1.7,  // rest the dynamite on top of the tower
    armT: 0, fuseT: 0, blinkT: 0,
    spark: mesh.userData.spark,
    dirAfter: dirAfter || (top && top.direction === "x" ? "z" : "x"),
  };
}

const TNT_ARM_FRAMES = 54; // ~0.9s the crate sits armed before it blows

// Per-frame TNT life: FALL onto the tower, then sit ARMED (fuse burning) before
// it detonates. Called from animate while unpaused.
function updateTNT(dtf) {
  const t = tntActive;
  if (!t) return;

  if (t.phase === "fall") {
    t.vy -= 0.03 * dtf;                // gravity (gentle, so the fall is visible)
    t.mesh.position.y += t.vy * dtf;
    t.mesh.rotation.x += 0.045 * dtf;  // tumble as it falls
    t.mesh.rotation.z += 0.015 * dtf;
    if (t.spark) t.spark.material.opacity = 0.55 + 0.45 * Math.sin(t.mesh.position.y * 2);
    if (t.mesh.position.y <= t.targetY) {
      t.mesh.position.set(t.cx, t.targetY, t.cz);
      t.mesh.rotation.set(0, 0, 0);
      t.mesh.scale.set(1.28, 0.68, 1.28); // impact squash (eases back while armed)
      t.phase = "armed";
      sfx("tntland");
      addShake(0.55);
      flashMsg("💥 EXPLOSION 💥", "#ff3b30");
    }
    return;
  }

  // ARMED: recover from the squash, then buzz harder as the fuse burns down.
  t.armT += dtf;
  const p = Math.min(1, t.armT / TNT_ARM_FRAMES);
  const rec = Math.min(1, t.armT / 8);                 // squash recovery
  const sq = 1 + (1 - rec) * 0.28, sy = 1 - (1 - rec) * 0.32;
  t.mesh.scale.set(sq, sy, sq);
  const buzz = 0.05 + p * 0.55;                         // vibration grows toward the blast
  t.mesh.position.x = t.cx + (Math.random() - 0.5) * buzz;
  t.mesh.position.z = t.cz + (Math.random() - 0.5) * buzz;
  t.mesh.rotation.z = (Math.random() - 0.5) * buzz * 0.12;
  if (t.spark) {
    const ss = 2.4 * (1 + p * 1.3);                     // fuse spark flares up
    t.spark.scale.set(ss, ss, ss);
    t.spark.material.opacity = 0.5 + 0.5 * Math.abs(Math.sin(t.armT * 0.7));
  }
  addShake(0.04 + p * 0.2);
  t.fuseT += dtf;
  const every = Math.max(2.5, 9 - p * 7);               // fuse ticks quicken
  if (t.fuseT >= every) { t.fuseT = 0; sfx("fuse", p); }
  t.blinkT += dtf;
  if (t.blinkT >= 15) { t.blinkT = 0; flashMsg("💥 EXPLOSION 💥", "#ff3b30"); } // blinking warning
  if (t.armT >= TNT_ARM_FRAMES) {
    const n = t.n, dirAfter = t.dirAfter, cx = t.cx, cz = t.cz;
    scene.remove(t.mesh); // shared geo/mats — nothing to dispose
    tntActive = null;
    explodeTNT(n, dirAfter, cx, cz);
  }
}

// Shatter a block into several small chunks that fly off the sides and fall
// away. Disposes the block's own mesh (so nothing is left stuck) and spawns the
// fragments as debris.
function shatterBlock(group, width, depth, color) {
  const px = group.position.x, py = group.position.y, pz = group.position.z;
  disposeCube(group); // the block cracks into four chunks
  // Split into 4 quadrant chunks. They separate a little, then just FALL DOWN
  // under gravity — no sideways blast, no glow.
  const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let q = 0; q < 4; q++) {
    const sx = quads[q][0], sz = quads[q][1];
    const { group: frag } = makeCube(
      px + sx * (width / 4),
      py,
      pz + sz * (depth / 4),
      (width / 2) * 0.88, // small gap so the four read as separate pieces
      (depth / 2) * 0.88,
      color
    );
    overhangs.push({
      threejs: frag,
      vy: -0.02 + Math.random() * 0.04,          // basically no pop; it just drops
      vx: sx * (0.04 + Math.random() * 0.05),    // tiny nudge apart, not a blast
      vz: sz * (0.04 + Math.random() * 0.05),
      vrot: (Math.random() - 0.5) * 0.28,        // slow, gentle tumble
      g: 0.022,                                  // light gravity -> slow, soft fall
    });
  }
}

// The blast: a huge flash/shockwave, the top blocks BREAK APART and fly off the
// sides, then the tower DESCENDS with the same red down-warp as the old bomb,
// score ticking down, ending on a heavy boom.
function explodeTNT(n, dirAfter, cx, cz) {
  const top = stack[stack.length - 1];
  const cy = BOX_HEIGHT * (stack.length - 1) + BOX_HEIGHT / 2;
  const intensity = Math.min(1, n / 500);

  // ---- THE IMPACT ----  a solid thump + a puff of smoke/dust, nothing flashy
  sfx("explode", intensity);
  addShake(1.1);
  spawnBurst(cx, cy, cz, 0x8a8a8a, 16, { up: 0.5, speed: 0.24, scale: 1.6 }); // smoke
  spawnBurst(cx, cy, cz, 0xa8a29a, 12, { up: 0.7, speed: 0.18, scale: 2.0 }); // more smoke
  spawnBurst(cx, cy, cz, 0xd9c8a0, 8, { up: 0.35, speed: 0.2, scale: 1.0 });  // faint dust

  // Remove blocks in proportion to the score removed, so the foundation is only
  // exposed when the score actually reaches 0 (mirrors the old bomb math).
  const startScore = score;
  const keepW = top ? top.width : SPAWN_OFFSET * 2;
  const keepD = top ? top.depth : SPAWN_OFFSET * 2;
  const removable = stack.length - 1;
  const scoreRemoved = Math.min(n, startScore);
  let blocksToRemove = startScore > 0 ? Math.round((scoreRemoved / startScore) * removable) : removable;
  if (scoreRemoved >= startScore) blocksToRemove = removable;
  blocksToRemove = Math.max(0, Math.min(removable, blocksToRemove));

  // SHATTER & DROP: engage the red down-warp and rip the whole removed section
  // apart into a dense, continuous spray of glowing shards. A CONSTANT brisk
  // cadence (no accelerating steps, no start hold) so it never stutters/pauses,
  // and EVERY visible block that comes off shatters (newly-exposed blocks get
  // meshes each frame, so the shatter keeps going the whole way down).
  buildDir = -1;
  buildIntensity = Math.max(0.3, intensity * 0.5); // subtle red tint, not a full warp
  buildAccel = 0.5;
  if (warpEl) warpEl.classList.add("down");
  if (buildGlowEl) buildGlowEl.classList.add("down");
  sfx("dive", intensity); // falling whoosh into the drop

  const steps = Math.max(1, Math.min(blocksToRemove, 46)); // brisk, ~1s total
  let i = 0, removed = 0;
  function step() {
    if (paused) { cloneBuild = setTimeout(step, 80); return; }
    i++;
    buildAccel = Math.min(1, 0.6 + i / steps);
    const removeTarget = Math.round((blocksToRemove * i) / steps);
    while (removed < removeTarget && stack.length > 1) {
      const b = stack.pop(); // never remove the foundation
      if (b && b.threejs) {
        // shatter every on-screen block; if the shard cloud is already dense,
        // just drop the block (off-screen ones have no mesh anyway)
        if (overhangs.length < 130) shatterBlock(b.threejs, b.width, b.depth, b.color);
        else disposeCube(b.threejs);
        b.threejs = null;
      }
      removed++;
    }
    rebuildVisible(); // re-mesh newly-exposed top blocks so they shatter next frame
    addShake(0.14);
    if (i % 4 === 0) sfx("build", false, i); // descending rumble
    score = Math.max(0, startScore - Math.round((n * i) / steps));
    refreshScore();
    if (i >= steps) {
      score = Math.max(0, startScore - n);
      refreshScore();
      sfx("boom", false); // heavy thud payoff
      buildDir = 1; buildAccel = 0;
      if (warpEl) warpEl.classList.remove("down");
      if (buildGlowEl) buildGlowEl.classList.remove("down");
      finishTNT(dirAfter, keepW, keepD);
      return;
    }
    cloneBuild = setTimeout(step, 55); // slower, even cadence -> the break reads clearly
  }
  cloneBuild = setTimeout(step, 90); // a beat after the impact, then it drops
}

// After a blast: reset if wiped out, else play the next queued dynamite, else
// hand a fresh moving block back and unfreeze.
function finishTNT(dirAfter, keepW, keepD) {
  buildDir = 1; buildIntensity = 0; buildAccel = 0; // make sure the warp is off
  if (warpEl) warpEl.classList.remove("down");
  if (buildGlowEl) buildGlowEl.classList.remove("down");
  if (score <= 0) { tntQueue = []; tntBusy = false; buildActive = false; softReset(); return; }
  if (tntQueue.length) { startNextTNT(dirAfter); return; } // chain straight into the next stick
  tntBusy = false;
  buildActive = false;
  const topNow = stack[stack.length - 1];
  const nextDir = dirAfter === "x" ? "z" : "x";
  const w = Math.min(keepW, topNow.width); // a bomb never hands you a wider base
  const d = Math.min(keepD, topNow.depth);
  // Hand the next block back CENTERED over the tower (not sliding in from the far
  // edge) so after a bomb you place it again right where the tower is.
  addLayer(topNow.x, topNow.z, w, d, nextDir);
}

// If any dynamite is queued (e.g. it arrived mid-build), start it. Returns true
// if it took over so the caller can bail out of spawning its own next block.
function maybeStartQueuedTNT(dirAfter) {
  if (tntBusy || !tntQueue.length) return false;
  startNextTNT(dirAfter);
  return true;
}

// Expanding bright ring/flash at the blast center.
function spawnShockwave(x, y, z) {
  if (!starTex) return;
  const mat = new THREE.SpriteMaterial({ map: starTex, color: 0xfff0c0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sp = new THREE.Sprite(mat);
  sp.position.set(x, y, z);
  sp.scale.set(3, 3, 3);
  sp.layers.enable(BLOOM_LAYER);
  scene.add(sp);
  shockwaves.push({ sprite: sp, t: 0 });
}

function updateShockwaves(dtf) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i];
    s.t += 0.06 * dtf;
    const e = s.t >= 1 ? 1 : 1 - Math.pow(1 - s.t, 2);
    const sc = 3 + e * 34;
    s.sprite.scale.set(sc, sc, sc);
    s.sprite.material.opacity = Math.max(0, 1 - s.t);
    if (s.t >= 1) {
      scene.remove(s.sprite);
      s.sprite.material.dispose();
      shockwaves.splice(i, 1);
    }
  }
}

// Big-rocket aura: transparent glowing rings that shoot up the tower during a
// huge (+500) up-build, then fade so everything returns to normal.
let auraTorusGeo = null;
function spawnAuraRing(y) {
  if (auraRings.length >= 12) return; // keep it a handful of ripples, never a whiteout
  if (!auraTorusGeo) auraTorusGeo = new THREE.TorusGeometry(10, 0.32, 8, 44);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xdff1ff, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(auraTorusGeo, mat);
  ring.rotation.x = Math.PI / 2; // lie flat, wrapping the tower
  ring.position.set(0, y, 0);
  ring.scale.set(0.7, 0.7, 0.7);
  scene.add(ring);
  auraRings.push({ mesh: ring, mat, vy: 0.8, life: 1 });
}
function updateAuraRings(dtf) {
  for (let i = auraRings.length - 1; i >= 0; i--) {
    const r = auraRings[i];
    r.life -= 0.028 * dtf;
    r.mesh.position.y += r.vy * dtf;   // rush upward
    const s = 0.7 + (1 - r.life) * 1.5; // expand outward as it fades
    r.mesh.scale.set(s, s, s);
    r.mat.opacity = Math.max(0, r.life) * 0.8;
    if (r.life <= 0) {
      scene.remove(r.mesh);
      r.mat.dispose();
      auraRings.splice(i, 1);
    }
  }
}

// A size powerup ARMS the next drop: place it and the block resizes
// (mult 2 = twice as big, 0.5 = half) and that size carries forward.
function armSize(mult) {
  ensureStarted();
  pendingSize = mult;
  pendingNet = 0;
  setGiftVisual();
  flashMsg(mult > 1 ? "2x SIZE!" : "1/2 SIZE!", mult > 1 ? "#6bff5a" : "#ff8a3c");
  sfx("arm", mult > 1);
}

// Random powerups: each block independently rolls every powerup's own % chance,
// so the run stays lively even when nobody is donating. One powerup max per block.
function maybeRandomPowerup() {
  if (!powerupsOn) return; // master toggle off
  if (pendingNet !== 0 || pendingSize !== 1) return; // already armed
  for (const p of POWERUPS) {
    const c = chances[p.key];
    if (c <= 0 || Math.random() * 100 >= c) continue;
    if (p.dir === "remove" && score <= amounts[p.key]) continue; // a random bomb never resets you
    armPowerup(p);
    return;
  }
}

// Build the per-powerup chance rows (a slider + a click-to-type % field) into the menu.
function buildChanceSliders() {
  if (!chanceListEl) return;
  chanceListEl.innerHTML = "";
  for (const p of POWERUPS) {
    const row = document.createElement("div");
    row.className = "chance-row";
    const head = document.createElement("div");
    head.className = "chance-head";
    const lab = document.createElement("span");
    lab.className = "chance-label";
    // The amount (+N / −N) is now edited next to its keybind in Controls; here we
    // just show it (kept in sync via data-amt-label) alongside the % chance.
    lab.textContent = powerupLabel(p);
    lab.setAttribute("data-amt-label", p.key);

    const valWrap = document.createElement("span");
    valWrap.className = "chance-val";
    const num = document.createElement("input");
    num.type = "number";
    num.min = "0";
    num.max = "10";
    num.step = "0.01";
    num.value = chances[p.key];
    num.className = "chance-num";
    const pctSign = document.createElement("span");
    pctSign.textContent = "%";
    valWrap.appendChild(num);
    valWrap.appendChild(pctSign);

    head.appendChild(lab);
    head.appendChild(valWrap);

    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "10";
    range.step = "0.01";
    range.value = chances[p.key];
    range.className = "chance-range";

    const apply = (v, fromTyping) => {
      chances[p.key] = v;
      range.value = v;
      if (!fromTyping) num.value = v;
      saveSetting("stack_pct_" + p.key, v);
      paintSlider(range);
    };
    range.addEventListener("input", () => apply(clampChance(parseFloat(range.value)), false));
    num.addEventListener("input", () => {
      const raw = parseFloat(num.value);
      if (!isNaN(raw)) apply(clampChance(raw), true);
    });
    num.addEventListener("change", () => { num.value = chances[p.key]; }); // tidy on blur/enter
    num.addEventListener("focus", () => num.select());

    row.appendChild(head);
    row.appendChild(range);
    chanceListEl.appendChild(row);
    paintSlider(range);
  }
}

// Turn each tagged Options card into a collapsible section (collapsed by default).
function makeCollapsible() {
  document.querySelectorAll("#optionsPanel .opt-card[data-sec]").forEach((card) => {
    if (card.querySelector(":scope > .opt-head")) return; // already wrapped
    const head = document.createElement("button");
    head.type = "button";
    head.className = "opt-head";
    head.innerHTML = "<span></span><span class=\"opt-chev\">›</span>";
    head.firstChild.textContent = card.getAttribute("data-sec");
    const body = document.createElement("div");
    body.className = "opt-body";
    while (card.firstChild) body.appendChild(card.firstChild);
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener("click", () => card.classList.toggle("open"));
  });
}

// Filter the Options menu by the search box (and auto-expand matching sections).
function applySearch(q) {
  q = (q || "").trim().toLowerCase();
  document.querySelectorAll("#optionsPanel .opt-card").forEach((card) => {
    const rows = card.querySelectorAll(".key-row, .chance-row");
    if (!q) {
      card.style.display = "";
      rows.forEach((r) => (r.style.display = ""));
      card.classList.remove("open"); // collapse back to the default when not searching
      return;
    }
    const head = card.querySelector(".opt-head");
    const titleMatch = head ? head.textContent.toLowerCase().includes(q) : false;
    let shown;
    if (rows.length) {
      let any = false;
      rows.forEach((r) => {
        const m = titleMatch || r.textContent.toLowerCase().includes(q);
        r.style.display = m ? "" : "none";
        if (m) any = true;
      });
      shown = any;
    } else {
      shown = card.textContent.toLowerCase().includes(q);
    }
    card.style.display = shown ? "" : "none";
    card.classList.toggle("open", shown); // open the sections that matched
  });
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Gift-label textures are cached & reused (building a 256px canvas + uploading a
// GPU texture every time a powerup armed caused an occasional input hitch).
const giftTexCache = {};

function makeGiftLabel(n, type) {
  const key = type + ":" + n;
  if (giftTexCache[key]) return giftTexCache[key];
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "128px serif";
  g.fillText(type === "remove" ? "💣" : "🚀", 128, 92);
  g.fillStyle = "rgba(0,0,0,0.6)";
  roundRect(g, 50, 150, 156, 70, 22);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "900 60px 'Trebuchet MS', sans-serif";
  g.fillText((type === "remove" ? "−" : "+") + n, 128, 188);
  const tex = new THREE.CanvasTexture(c);
  giftTexCache[key] = tex;
  return tex;
}

function makeSizeLabel(mult) {
  const key = "size:" + mult;
  if (giftTexCache[key]) return giftTexCache[key];
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "120px serif";
  g.fillText(mult > 1 ? "🔼" : "🔽", 128, 84);
  g.fillStyle = "rgba(0,0,0,0.6)";
  roundRect(g, 54, 150, 148, 70, 22);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "900 64px 'Trebuchet MS', sans-serif";
  g.fillText(mult > 1 ? "2×" : "½", 128, 188);
  const tex = new THREE.CanvasTexture(c);
  giftTexCache[key] = tex;
  return tex;
}

// Show/refresh (or clear) the rocket + "+N" label on the current moving block,
// and give that block a flat glowing look.
function setGiftVisual() {
  if (giftSprite) {
    scene.remove(giftSprite);
    giftSprite.material.dispose(); // map is a shared cached texture — don't dispose it
    giftSprite = null;
  }
  const mv = stack[stack.length - 1];
  let tex = null, sig = null;
  if (pendingNet > 0) {
    tex = makeGiftLabel(pendingNet, "add");
    sig = pendingNet >= 1250 ? 0xffe600 : pendingNet >= 250 ? 0x00ff85 : 0x4dff7a; // neon
  } else if (pendingNet < 0) {
    const m = -pendingNet;
    tex = makeGiftLabel(m, "remove");
    sig = m >= 1250 ? 0xff007f : m >= 250 ? 0xff1f5a : 0xff5fae; // neon
  } else if (pendingSize !== 1) {
    tex = makeSizeLabel(pendingSize);
    sig = pendingSize > 1 ? 0x19e6ff : 0xff9500; // neon
  }
  const cubeMat = mv && mv.threejs ? mv.threejs.userData.mat : null;
  if (!tex) {
    // disarmed: restore the block's own colour + kill the glow/bloom
    if (cubeMat && mv) {
      cubeMat.color.copy(mv.color); // mv.color is a THREE.Color object, not a hex number
      cubeMat.emissive.setHex(0x000000);
      const m0 = mv.threejs && mv.threejs.children[0];
      if (m0) m0.layers.disable(BLOOM_LAYER);
    }
    return;
  }
  // armed: give the cube a signature body colour + matching glow (so each powerup
  // reads differently even before you see the emoji label)
  if (cubeMat) {
    cubeMat.color.setHex(sig);
    // self-lit neon (NO bloom layer) — bloom is an additive overlay with no depth,
    // so it bled through/over other cubes. Emissive alone stays depth-occluded.
    cubeMat.emissive = new THREE.Color(sig).multiplyScalar(0.5);
    const m0 = mv.threejs && mv.threejs.children[0];
    if (m0) m0.layers.disable(BLOOM_LAYER);
  }
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  giftSprite = new THREE.Sprite(mat);
  giftSprite.scale.set(4.5, 4.5, 1);
  scene.add(giftSprite); // NOT on the bloom layer — keep the emoji/text crisp
}

// Spawn the gift clones one-by-one with a pop + sparkle, score spinning up to +n,
// then spawn the next moving block. Gameplay is frozen until it finishes.
// Cash gifts/streaks that piled up while a build was running — chain straight into
// another build so a gift flood never drops anything. Returns true if it started one.
function cashPending(topNow, dirAfter, maxW, maxD) {
  if (pendingNet === 0 || gameOver || resetActive || !gameStarted) return false;
  const np = pendingNet;
  pendingNet = 0;
  setGiftVisual();
  refreshScore();
  if (np > 0) {
    const w = maxW != null ? Math.min(maxW, topNow.width) : topNow.width;
    const d = maxD != null ? Math.min(maxD, topNow.depth) : topNow.depth;
    flashMsg("+" + np, "#6bff5a");
    startCloneBuild(np, topNow.x, topNow.z, w, d, dirAfter);
  } else {
    flashMsg(String(np), "#ff5a52");
    startRemoveBuild(-np, dirAfter);
  }
  return true;
}

function startCloneBuild(n, x, z, w, d, dirAfter) {
  if (cloneBuild) { clearTimeout(cloneBuild); clearInterval(cloneBuild); }
  buildActive = true;
  // +500 or bigger = a MEGA rocket: super fast, full warp, transparent aura rings.
  const mega = n >= 500;
  buildIntensity = mega ? 1 : Math.min(1, n / 1000); // +25 barely, +1250 full warp
  buildDir = 1; // rocketing up: streaks fall, green glow
  if (warpEl) warpEl.classList.remove("down");
  if (buildGlowEl) buildGlowEl.classList.remove("down");
  if (n >= 150) sfx("launch", buildIntensity); // epic whoosh on big rockets
  const total = Math.min(n, 120); // build up to 120 blocks visually
  let i = 0;
  let added = 0;
  let delay = mega ? 75 : 120; // slower so the rocket is watchable; accelerates from here
  function step() {
    if (paused) { cloneBuild = setTimeout(step, 120); return; } // freeze the build while paused
    i++;
    buildAccel = Math.min(1, i / total); // ramps 0->1 as the build accelerates
    addLayer(x, z, w, d, "x");
    const g = stack[stack.length - 1].threejs;
    if (g) {
      g.scale.set(w * 0.2, BOX_HEIGHT * 0.2, d * 0.2); // start small, pop up
      popping.push({ group: g, tw: w, td: d, t: 0 });
      if (i % 2 === 0) spawnBurst(g.position.x, g.position.y + BOX_HEIGHT / 2, g.position.z, 0xffd24d, 7, { up: 0.9, speed: 0.16 });
      if (mega && i % 4 === 0) spawnAuraRing(g.position.y - BOX_HEIGHT * 3); // rings rush up the tower
    }
    addShake(mega ? 0.2 : 0.12); // continuous rumble as it stacks
    if (i % 3 === 0) sfx("build", true, i); // ascending arpeggio (thinned out)
    const target = Math.round((n * i) / total); // climb the score toward +n
    score += target - added;
    added = target;
    refreshScore();
    if (i >= total) {
      cloneBuild = null;
      buildActive = false;
      if (n >= 150) sfx("boom", true); // triumphant payoff
      const topNow = stack[stack.length - 1];
      if (cashPending(topNow, dirAfter)) return; // chain gifts that arrived mid-build
      buildActive = false;
      if (maybeStartQueuedTNT(dirAfter)) return; // drop any dynamite that queued mid-build
      const nextDir = dirAfter === "x" ? "z" : "x";
      const nx = nextDir === "x" ? -SPAWN_OFFSET : topNow.x;
      const nz = nextDir === "z" ? -SPAWN_OFFSET : topNow.z;
      addLayer(nx, nz, topNow.width, topNow.depth, nextDir);
      return;
    }
    delay = Math.max(mega ? 30 : 50, delay * (mega ? 0.94 : 0.965)); // slower floor, gentler accel
    cloneBuild = setTimeout(step, delay);
  }
  cloneBuild = setTimeout(step, delay);
}

// Bomb block: remove blocks one-by-one from the top (shrink-out + red burst),
// score ticking down, then spawn the next moving block. Game frozen meanwhile.
// Bomb block: tear blocks off the top one-by-one, ACCELERATING, score ticking
// down, with the falling-fast warp (red streaks rushing UP, red glow). Mirrors
// the rocket build. Game frozen meanwhile.
function startRemoveBuild(n, dirAfter) {
  if (cloneBuild) { clearTimeout(cloneBuild); clearInterval(cloneBuild); }
  buildActive = true;
  buildIntensity = Math.min(1, n / 1000); // bigger bomb = stronger fall FX
  buildDir = -1; // falling: streaks rush up, red glow
  if (warpEl) warpEl.classList.add("down");
  if (buildGlowEl) buildGlowEl.classList.add("down");
  if (n >= 150) sfx("dive", buildIntensity); // dive whoosh on big bombs
  const startScore = score;
  const keepW = stack[stack.length - 1].width; // width when the bomb was placed
  const keepD = stack[stack.length - 1].depth;
  const removable = stack.length - 1; // cubes above the foundation
  const scoreRemoved = Math.min(n, startScore);
  // Remove cubes IN PROPORTION to the score removed, so the foundation is only ever
  // exposed when the score actually hits 0 — not when the few gift-cubes run out.
  let blocksToRemove = startScore > 0 ? Math.round((scoreRemoved / startScore) * removable) : removable;
  if (scoreRemoved >= startScore) blocksToRemove = removable; // full wipe -> down to the foundation
  blocksToRemove = Math.max(0, Math.min(removable, blocksToRemove));
  const steps = Math.max(1, Math.min(blocksToRemove, 120)); // animate up to 120 frames
  let i = 0, removed = 0, delay = 95;
  function step() {
    if (paused) { cloneBuild = setTimeout(step, 120); return; } // freeze while paused
    i++;
    buildAccel = Math.min(1, i / steps);
    const removeTarget = Math.round((blocksToRemove * i) / steps); // chunked if > 120 to tear off
    while (removed < removeTarget && stack.length > 1) {
      const b = stack.pop(); // never remove the foundation
      if (b && b.threejs) {
        spawnBurst(b.threejs.position.x, b.threejs.position.y + BOX_HEIGHT / 2, b.threejs.position.z, 0xff4d4d, 8, { up: 0.4, speed: 0.18 });
        popping.push({ group: b.threejs, tw: b.width, td: b.depth, t: 0, out: true });
      }
      removed++;
    }
    rebuildVisible();
    addShake(0.18);
    if (i % 3 === 0) sfx("build", false, i); // descending arpeggio (thinned out)
    const target = Math.round((n * i) / steps);
    score = Math.max(0, startScore - target);
    refreshScore();
    if (i >= steps) {
      cloneBuild = null;
      buildActive = false;
      if (n >= 150) sfx("boom", false); // heavy thud payoff
      score = Math.max(0, startScore - n);
      refreshScore();
      if (score <= 0) { softReset(); return; } // hit 0 -> fresh full-size starting cube
      const topNow = stack[stack.length - 1];
      if (cashPending(topNow, dirAfter, keepW, keepD)) return; // chain gifts from mid-bomb
      if (maybeStartQueuedTNT(dirAfter)) return; // drop any dynamite that queued mid-bomb
      const nextDir = dirAfter === "x" ? "z" : "x";
      const nx = nextDir === "x" ? -SPAWN_OFFSET : topNow.x;
      const nz = nextDir === "z" ? -SPAWN_OFFSET : topNow.z;
      // keep the width you had when you placed the bomb (a bomb shouldn't hand you a wider base)
      const w = Math.min(keepW, topNow.width);
      const d = Math.min(keepD, topNow.depth);
      addLayer(nx, nz, w, d, nextDir);
      return;
    }
    delay = Math.max(26, delay * 0.945);
    cloneBuild = setTimeout(step, delay);
  }
  cloneBuild = setTimeout(step, delay);
}

function removeBlocks(n) {
  ensureStarted();
  score = Math.max(0, score - n);
  if (score <= 0) {
    score = 0;
    softReset();
    refreshScore();
    flashMsg("RESET!", "#ff5a52");
    return;
  }
  const moving = stack.pop();
  if (moving && moving.threejs) disposeCube(moving.threejs);
  let toRemove = Math.min(n, stack.length - 1); // always keep the foundation
  while (toRemove-- > 0 && stack.length > 1) {
    const b = stack.pop();
    if (b && b.threejs) disposeCube(b.threejs);
  }
  rebuildVisible();
  const top = stack[stack.length - 1];
  addLayer(-SPAWN_OFFSET, top.z, top.width, top.depth, "x");
  refreshScore();
  flashMsg("-" + n, "#ff8a3c");
}

/* ---------------- 60-second save-or-reset countdown ---------------- */
function resetTick() {
  resetSecondsLeft--;
  const s = Math.max(0, resetSecondsLeft);
  rtClockEl.textContent = String(s);
  rtClockEl.classList.remove("tick");
  void rtClockEl.offsetWidth; // replay the pop animation
  rtClockEl.classList.add("tick");
  if (rtFillEl) rtFillEl.style.width = (s / 60) * 100 + "%";
  if (resetSecondsLeft <= 10) resetTimerEl.classList.add("urgent");
  if (resetSecondsLeft <= 10 && resetSecondsLeft > 0) addShake(0.28); // pulse as time runs out
  if (resetSecondsLeft > 0) sfx("tick", resetSecondsLeft <= 10);
  if (resetSecondsLeft <= 0) doReset();
}
function startResetCountdown() {
  if (resetActive) return; // pressing reset again mid-countdown does nothing
  ensureStarted();
  resetActive = true;
  resetSecondsLeft = 60;
  resetTimerEl.classList.remove("hidden", "urgent");
  rtClockEl.textContent = "60";
  if (rtFillEl) rtFillEl.style.width = "100%";
  resetInterval = setInterval(resetTick, 1000);
}

function cancelReset(saved) {
  if (!resetActive) return;
  resetActive = false;
  if (resetInterval) { clearInterval(resetInterval); resetInterval = null; }
  resetTimerEl.classList.add("hidden");
  resetTimerEl.classList.remove("urgent");
  if (saved) flashMsg("SAVED!", "#6bff5a");
}

function doReset() {
  if (resetInterval) { clearInterval(resetInterval); resetInterval = null; }
  resetActive = false;
  resetTimerEl.classList.add("hidden");
  resetTimerEl.classList.remove("urgent");
  softReset();
  refreshScore();
  flashMsg("RESET!", "#ff5a52");
  addShake(1.4); // big jolt on wipe
  sfx("reset");
}

function saveRun() {
  addShake(0.5);
  sfx("save");
  spawnConfetti(120); // celebrate the save
  if (resetActive) { cancelReset(true); return; } // a save cancels the countdown
  saveSetting("stack_savedScore", score);
  flashMsg("SAVED!", "#6bff5a");
}

/* ---------------- Auto-pause when the tab/window loses focus ---------------- */
function pauseForBlur() {
  if (gameStarted && !gameOver && !paused) togglePause();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) pauseForBlur(); });
window.addEventListener("blur", pauseForBlur);

/* ---------------- Pause & Options ---------------- */
function togglePause() {
  paused = !paused;
  pauseOverlay.classList.toggle("hidden", !paused);
  if (paused) {
    // freeze the reset countdown too
    if (resetInterval) { clearInterval(resetInterval); resetInterval = null; }
  } else if (resetActive && !resetInterval) {
    resetInterval = setInterval(resetTick, 1000); // resume it
  }
}
function toggleOptions() {
  optionsPanel.classList.toggle("open");
}

assistRange.addEventListener("input", () => {
  assistPercent = clampAssist(+assistRange.value);
  assistVal.textContent = assistPercent + "%";
  saveSetting("stack_assist", assistPercent);
  paintSlider(assistRange);
});
speedRange.addEventListener("input", () => {
  speedSetting = clampSpeed(+speedRange.value);
  speedVal.textContent = speedSetting;
  saveSetting("stack_speed", speedSetting);
  paintSlider(speedRange);
});
if (volRange) {
  volRange.addEventListener("input", () => {
    volume = clampVol(+volRange.value);
    volVal.textContent = volume + "%";
    saveSetting("stack_volume", volume);
    if (window.SFX) SFX.setVolume(volume / 100);
    paintSlider(volRange);
  });
}
/* per-powerup chance sliders + search are wired up in buildChanceSliders()/applySearch() */
optClose.addEventListener("click", (e) => { e.stopPropagation(); optionsPanel.classList.remove("open"); });
resumeBtn.addEventListener("click", (e) => { e.stopPropagation(); if (paused) togglePause(); });
pauseResetBtn.addEventListener("click", (e) => { e.stopPropagation(); softReset(); });

/* ---------------- Keybinds (rebindable) ---------------- */
const DEFAULT_BINDS = { drop: " ", pause: "escape", reset: "r", save: "s", up25: "i", up250: "o", up1250: "p", down25: "k", down250: "l", down1250: "j", size2x: "g", shrink2x: "h" };
function loadBinds() {
  try {
    const raw = localStorage.getItem("stack_binds");
    if (raw) return Object.assign({}, DEFAULT_BINDS, JSON.parse(raw));
  } catch (e) {}
  return Object.assign({}, DEFAULT_BINDS);
}
function saveBinds() { try { localStorage.setItem("stack_binds", JSON.stringify(binds)); } catch (e) {} }
let binds = loadBinds();
let listeningAction = null;

function keyLabel(k) {
  if (!k) return "—";
  if (k === " ") return "Space";
  if (k === "escape") return "Esc";
  if (k === "arrowup") return "↑";
  if (k === "arrowdown") return "↓";
  if (k === "arrowleft") return "←";
  if (k === "arrowright") return "→";
  if (k === "enter") return "Enter";
  return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
}
function refreshBindLabels() {
  document.querySelectorAll("#optionsPanel [data-bind]").forEach((el) => {
    el.classList.remove("listening");
    el.textContent = keyLabel(binds[el.dataset.bind]);
  });
}
function cancelListening() {
  if (!listeningAction) return;
  listeningAction = null;
  refreshBindLabels();
}
document.querySelectorAll("#optionsPanel [data-bind]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const action = el.dataset.bind;
    if (listeningAction === action) { cancelListening(); return; }
    cancelListening();
    listeningAction = action;
    el.classList.add("listening");
    el.textContent = "Press…";
  });
});
const resetBindsBtn = document.getElementById("resetBinds");
if (resetBindsBtn) {
  resetBindsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    binds = Object.assign({}, DEFAULT_BINDS);
    saveBinds();
    cancelListening();
    refreshBindLabels();
  });
}
refreshBindLabels();

/* ---------------- Input ---------------- */
function onAction(e) {
  if (e && e.isPrimary === false) return; // ignore secondary multi-touch pointers
  sfx("resume"); // unlock the audio context on the first user gesture
  if (e && e.target && e.target.closest &&
      (e.target.closest("#startBtn") ||
       e.target.closest("#optionsPanel") ||
       e.target.closest("#pauseOverlay"))) return;
  if (paused) return;
  if (!gameStarted) {
    if (!overlay.classList.contains("hidden")) startGame();
    return;
  }
  if (actionLocked) return; // at most one drop per frame
  actionLocked = true;
  placeBlock();
}

window.addEventListener("pointerdown", onAction);
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  sfx("resume"); // unlock the audio context on the first key

  // Rebinding: capture the next key for the chosen action
  if (listeningAction) {
    e.preventDefault();
    const action = listeningAction;
    for (const a in binds) if (binds[a] === k && a !== action) binds[a] = ""; // keys stay unique
    binds[action] = k;
    saveBinds();
    listeningAction = null;
    refreshBindLabels();
    return;
  }

  // Options menu is always Ctrl+M (fixed, so you can never lock yourself out)
  if (e.ctrlKey && k === "m") { e.preventDefault(); toggleOptions(); return; }
  // typing in a settings field (search / chance %) must not trigger game keys
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.repeat && !POWERUPS.some((p) => k === binds[p.key])) return; // let rapid-fire gift keys all through

  if (k === binds.drop) {
    e.preventDefault();
    if (paused) return;
    if (!gameStarted) { startGame(); return; }
    if (actionLocked) return;
    actionLocked = true;
    placeBlock();
  } else if (k === binds.pause) {
    if (gameStarted && !gameOver) togglePause();
  } else if (k === binds.reset) {
    e.preventDefault(); startResetCountdown();
  } else if (k === binds.save) {
    e.preventDefault(); saveRun();
  } else {
    for (const p of POWERUPS) {
      if (k === binds[p.key]) { e.preventDefault(); armPowerup(p); break; }
    }
  }
});
startBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  startGame();
});

init();
