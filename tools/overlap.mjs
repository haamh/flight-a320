// Interpenetration check for the aircraft and the flight deck (dev tool).
// Usage: node tools/overlap.mjs [--url http://localhost:5173] [--scope all|ext|int] [--pose static|flaps|gearup|spoilers|ctrl|reverser|all] [--tol 1.5] [--max 40]
// Needs the Vite dev server (it uses window.sim and window.checkOverlaps, both dev-only).
import { createRequire } from "module";
import { execSync } from "child_process";
import path from "path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require(path.join(execSync("npm root -g").toString().trim(), "playwright")); }

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const url = opt("--url", "http://localhost:5173");
const scope = opt("--scope", "all");
const poseArg = opt("--pose", "static");
const tol = Number(opt("--tol", "1.5")) / 1000;
const max = Number(opt("--max", "40"));

const browser = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.sim && window.sim.running && window.checkOverlaps, null, { timeout: 240000 });

const POSES = {
  static: { },
  flaps: { flapDeg: 35, slat: 1, flapLever: 4 },
  gearup: { gear: 0, gearLever: false },
  spoilers: { spoilers: 1, groundSpoilers: 1, speedbrakeLever: 1 },
  ctrl: { aileron: 1, elevator: 1, rudder: 1, stickX: 1, stickY: 1, pedal: 1 },
  ctrl2: { aileron: -1, elevator: -1, rudder: -1, stickX: -1, stickY: -1, pedal: -1 },
  reverser: { reverser: 1, reverseSelected: true, throttle: 0.6 },
};
const names = poseArg === "all" ? Object.keys(POSES) : [poseArg];

for (const name of names) {
  const rep = await page.evaluate(({ pose, scope, tol, max }) => {
    const s = window.sim, rig = s.rig;
    const vs = Object.assign({}, s.vs, { lights: { ...s.vs.lights } }, pose);
    vs.gear = pose.gear ?? 1; vs.comp = [0, 0, 0];
    rig.update(vs, 0, 0);
    const ext = rig.root.children[0];
    const inExt = (m) => { for (let o = m; o; o = o.parent) if (o === ext) return true; return false; };
    const filter = scope === "ext" ? (m) => inExt(m) : scope === "int" ? (m) => !inExt(m) : undefined;
    return window.checkOverlaps({ tol, max, filter });
  }, { pose: POSES[name], scope, tol, max });
  console.log(`\n== pose ${name} | scope ${scope} | ${rep.objects} objects, ${(rep.triangles / 1000).toFixed(0)}k tris, ${rep.broadPairs} broad pairs, ${rep.ms} ms | tol ${(tol * 1000).toFixed(1)} mm`);
  if (!rep.hits.length) console.log("   no overlaps deeper than the tolerance");
  for (const h of rep.hits) console.log(`   vert ${(h.vert * 1000).toFixed(1).padStart(6)} mm | tri ${(h.depth * 1000).toFixed(0).padStart(4)} mm | x${String(h.pairs).padEnd(5)} ${h.a}  <->  ${h.b}   @ (${h.at.map((v) => v.toFixed(2)).join(", ")})`);
}
await browser.close();
