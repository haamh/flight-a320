// Headless screenshot + render-stats harness.
// Usage: node tools/snap.mjs [--url http://localhost:5173] [--out shots] [--time 1] [--w 1280 --h 720] [--nopost] preset1 preset2 ...
// Presets: cockpit, cockpit-wide, cockpit-left, cockpit-up, overhead, pedestal, nose-front, nose-side, nose-34, chase, approach-cockpit
// Needs the Vite dev server running (npm run dev) because it drives the dev-only window.sim handle.
import { createRequire } from "module";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require(path.join(execSync("npm root -g").toString().trim(), "playwright")); }

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const url = opt("--url", "http://localhost:5173");
const out = opt("--out", "shots");
const timeIdx = Number(opt("--time", "1"));
const w = Number(opt("--w", "1280")), h = Number(opt("--h", "720"));
const noPost = args.includes("--nopost"); if (noPost) args.splice(args.indexOf("--nopost"), 1);
const presets = args.length ? args : ["cockpit", "nose-front", "nose-side"];
fs.mkdirSync(out, { recursive: true });

// cam: engine camera mode; head: [yaw, pitch] for cockpit; orbit: [yaw, pitch, dist]; zoom: fov multiplier
const P = {
  "cockpit": { mode: "departure", cam: "cockpit", head: [0, -0.1] },
  "cockpit-wide": { mode: "departure", cam: "cockpit", head: [-0.35, -0.12], zoom: 1.45 },
  "cockpit-left": { mode: "departure", cam: "cockpit", head: [1.2, -0.05] },
  "cockpit-right": { mode: "departure", cam: "cockpit", head: [-0.9, -0.1] },
  "cockpit-up": { mode: "departure", cam: "cockpit", head: [-0.4, 0.55] },
  "overhead": { mode: "departure", cam: "cockpit", head: [-0.4, 0.95], zoom: 1.2 },
  "pedestal": { mode: "departure", cam: "cockpit", head: [-0.55, -0.75], zoom: 1.2 },
  "panel": { mode: "departure", cam: "cockpit", head: [-0.3, -0.35], zoom: 1.0 },
  "approach-cockpit": { mode: "approach", cam: "cockpit", head: [0, -0.1], run: 1.5 },
  "nose-front": { mode: "departure", cam: "gear", orbit: [Math.PI, 0.03, 14], target: "nose" },
  "nose-side": { mode: "departure", cam: "gear", orbit: [Math.PI / 2, 0.05, 12], target: "nose" },
  "nose-34": { mode: "departure", cam: "gear", orbit: [Math.PI - 0.75, 0.12, 14], target: "nose" },
  "nose-front-close": { mode: "departure", cam: "gear", orbit: [Math.PI, 0.06, 7.5], target: "nose" },
  "nose-side-close": { mode: "departure", cam: "gear", orbit: [Math.PI / 2 + 0.25, 0.08, 6.5], target: "nose" },
  "ref-34": { mode: "departure", cam: "gear", orbit: [-Math.PI + 0.95, 0.06, 34], target: "mid" },
  "nose-far": { mode: "departure", cam: "gear", orbit: [Math.PI - 0.5, 0.05, 60], target: "nose" },
  "ws-front": { mode: "departure", cam: "gear", orbit: [Math.PI, 0.18, 3.6], target: "ws" },
  "ws-side": { mode: "departure", cam: "gear", orbit: [Math.PI / 2 + 0.55, 0.12, 3.2], target: "ws" },
  "ws-macro": { mode: "departure", cam: "gear", orbit: [Math.PI / 2 + 0.35, 0.1, 1.3], target: "wsm" },
  "chase": { mode: "departure", cam: "chase", orbit: [0.4, 0.12, 55] },
};

const browser = await pw.chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.sim && window.sim.running, null, { timeout: 180000 });
// --nopost: bypass the post-processing chain (software GL renders the HDR chain washed out)
if (noPost) await page.evaluate(() => { const s = window.sim; s.composer.render = () => s.renderer.render(s.world.scene, s.camera); });

let menuOpen = true;
for (const name of presets) {
  const p = P[name];
  if (!p) { console.log(`unknown preset ${name}`); continue; }
  if (menuOpen) {
    await page.evaluate((t) => window.sim.setTimeOfDay(t), timeIdx);
    await page.getByText(p.mode === "approach" ? "Final approach Bayview" : "Takeoff from Aurora").click({ timeout: 240000 });
    menuOpen = false;
  }
  const stats = await page.evaluate(async ({ p, timeIdx }) => {
    const sim = window.sim;
    if (sim.timeIdx !== timeIdx) sim.setTimeOfDay(timeIdx);
    sim.start(p.mode);
    sim.hudVisible = false;
    sim.setCam(p.cam);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait((p.run ?? 0.3) * 1000);
    sim.paused = true;
    if (p.head) { sim.headYaw = p.head[0]; sim.headPitch = p.head[1]; }
    if (p.orbit) { sim.orbitYaw = p.orbit[0]; sim.orbitPitch = p.orbit[1]; sim.orbitDist = p.orbit[2]; }
    sim.zoom = p.zoom ?? 1;
    sim.debugTarget = p.target === "nose" ? [0, 0.6, -15.8] : p.target === "mid" ? [0, -0.5, -3] : p.target === "ws" ? [0.45, 0.95, -16.2] : p.target === "wsm" ? [1.5, 0.65, -15.9] : null;
    // let camera fov lerp settle and gather frame timings
    const info = sim.renderer.info;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    await frame(); await frame();
    const t0 = performance.now(); let frames = 0; const span = window.__snapSpan ?? 2000;
    while (performance.now() - t0 < span || frames < 2) { await frame(); frames++; }
    const ms = (performance.now() - t0) / frames;
    info.autoReset = false; info.reset(); await frame(); info.autoReset = true;
    return { calls: info.render.calls, triangles: info.render.triangles, points: info.render.points, geometries: info.memory.geometries, textures: info.memory.textures, frameMs: +ms.toFixed(1) };
  }, { p, timeIdx });
  const file = path.join(out, `${name}.png`);
  console.log(`${name}: ${JSON.stringify(stats)}`);
  await page.screenshot({ path: file, timeout: 240000 });
  console.log(`  -> ${file}`);
}
if (logs.length) console.log("console:\n" + [...new Set(logs)].slice(0, 30).join("\n"));
await browser.close();
