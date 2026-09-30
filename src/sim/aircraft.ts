import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { makeCanvas, glowTexture } from "./textures";
import { clamp, lerp, smoothstep } from "./noise";
import { FUS, FL, GEAR_HEIGHT, fuselageSection, surfacePoint, surfaceNormal, skinPoint, thetaAtY, WINDOWS, offsetOutline, windowParamOutline, windowMatrix, windowPoint, type FlightDeckWindow } from "./fuselage";
import { buildCockpit, type CockpitRig } from "./cockpit";

export { FUS, GEAR_HEIGHT, fuselageSection, surfacePoint, surfaceNormal };

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;


/* ------------------------------------------------------------------ */
/*  Geometry helpers                                                  */
/* ------------------------------------------------------------------ */
function orient(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index!;
  let vol = 0;
  const a = V(), b = V(), c = V();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    vol += a.dot(b.clone().cross(c));
  }
  if (vol < 0) flipWinding(g);
  g.computeVertexNormals();
  return g;
}
function flipWinding(g: THREE.BufferGeometry) {
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const t = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, t);
  }
  idx.needsUpdate = true;
}
function mirrorX(g: THREE.BufferGeometry) {
  const m = g.clone();
  m.scale(-1, 1, 1);
  if (m.index) flipWinding(m);
  m.computeVertexNormals();
  return m;
}
const mirV = (v: V3) => V(-v.x, v.y, v.z);

function cylBetween(a: V3, b: V3, r: number, mat: THREE.Material, seg = 24, r2 = r) {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r2, r, d.length(), seg, 1);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function smoothProfile(pts: [number, number][], n = 64) {
  const curve = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return curve.getPoints(n);
}

/* ------------------------------------------------------------------ */
/*  Airfoil lofting                                                   */
/* ------------------------------------------------------------------ */
interface Sec { le: V3; chord: number; t: number; dir: V3; up: V3; camber: number }

function foil(x: number, t: number, m: number, p = 0.4): [number, number] {
  x = clamp(x, 0, 1);
  const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x);
  return [yc + yt, yc - yt];
}
function secPt(s: Sec, x: number, upper: boolean, off = 0): V3 {
  const [yu, yl] = foil(x, s.t, s.camber);
  const y = (upper ? yu : yl) * s.chord + off;
  return s.le.clone().addScaledVector(s.dir, x * s.chord).addScaledVector(s.up, y);
}
function camberPt(s: Sec, x: number): V3 {
  const [yu, yl] = foil(x, s.t, s.camber);
  return s.le.clone().addScaledVector(s.dir, x * s.chord).addScaledVector(s.up, ((yu + yl) / 2) * s.chord);
}
function xsample(a: number, b: number, n: number) {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = (1 - Math.cos(Math.PI * t)) / 2;
    xs.push(a + (b - a) * w);
  }
  return xs;
}
function foilRing(s: Sec, a: number, b: number, n: number): V3[] {
  const xs = xsample(a, b, n);
  const up = xs.map((x) => secPt(s, x, true));
  const lo = xs.slice().reverse().map((x) => secPt(s, x, false));
  if (a === 0) lo.pop();
  return up.concat(lo);
}
function spoilerRing(s: Sec, a: number, b: number, n: number): V3[] {
  const xs = xsample(a, b, n);
  const up = xs.map((x) => secPt(s, x, true, 0.012));
  const lo = xs.slice().reverse().map((x) => secPt(s, x, true, -0.02));
  return up.concat(lo);
}

type UVFn = (p: V3, k: number, i: number, nk: number, ni: number) => [number, number];

function loftRings(rings: V3[][], uvFn?: UVFn, cap = true) {
  const n = rings[0].length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  rings.forEach((r, k) => r.forEach((p, i) => {
    pos.push(p.x, p.y, p.z);
    const u = uvFn ? uvFn(p, k, i, rings.length, n) : [k / (rings.length - 1), i / n];
    uv.push(u[0], u[1]);
  }));
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    const a = k * n + i, b = k * n + i2, c = (k + 1) * n + i2, d = (k + 1) * n + i;
    idx.push(a, b, c, a, c, d);
  }
  if (cap) {
    for (const k of [0, rings.length - 1]) {
      const r = rings[k];
      const cen = r.reduce((acc, p) => acc.add(p), V()).multiplyScalar(1 / n);
      const ci = pos.length / 3;
      pos.push(cen.x, cen.y, cen.z);
      const cu = uvFn ? uvFn(cen, k, 0, rings.length, n) : [k / (rings.length - 1), 0];
      uv.push(cu[0], cu[1]);
      for (let i = 0; i < n; i++) idx.push(ci, k * n + i, k * n + ((i + 1) % n));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return orient(g);
}
function loft(secs: Sec[], a: number, b: number, n = 30, uvFn?: UVFn) {
  return loftRings(secs.map((s) => foilRing(s, a, b, n)), uvFn);
}

/* ------------------------------------------------------------------ */
/*  Wing planform                                                     */
/* ------------------------------------------------------------------ */
const DIH = 5.1 * D2R;
const SWEEP = 27 * D2R;
const SPAN = 16.9;
const KINK = 6.3;
export const wLeZ = (s: number) => -4.2 + s * Math.tan(SWEEP);
const wTeZ = (s: number) => (s <= KINK ? 2.4 + s * 0.05 : lerp(2.4 + KINK * 0.05, wLeZ(SPAN) + 1.5, (s - KINK) / (SPAN - KINK)));
export function wingSec(s: number): Sec {
  const le = V(s, -1.25 + s * Math.tan(DIH), wLeZ(s));
  const chord = wTeZ(s) - wLeZ(s);
  const t = s < KINK ? lerp(0.155, 0.12, s / KINK) : lerp(0.12, 0.105, (s - KINK) / (SPAN - KINK));
  const inc = lerp(2.5, -0.5, s / SPAN) * D2R;
  const ax = V(Math.cos(DIH), Math.sin(DIH), 0);
  const dir = V(0, 0, 1).applyAxisAngle(ax, inc);
  const up = V(-Math.sin(DIH), Math.cos(DIH), 0).applyAxisAngle(ax, inc);
  return { le, chord, t, dir, up, camber: 0.022 };
}
const W = (list: number[]) => list.map(wingSec);

/* ------------------------------------------------------------------ */
/*  Textures specific to the aircraft                                 */
/* ------------------------------------------------------------------ */
/** flight deck window cut-outs for the skin (and the lining, `off` < 0), sampled through the uv1 nose channel */
export const NOSE_MASK_LEN = 7.0;
function windowMask(off: number, grow: number) {
  const S = 2048;
  const { c, ctx } = makeCanvas(S, S);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#000";
  for (const w of WINDOWS) {
    ctx.beginPath();
    windowParamOutline(w, grow, off).forEach(([z, th], i) => {
      const x = ((z - FUS.zNose) / NOSE_MASK_LEN) * S, y = (th / TAU) * S;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.channel = 1; t.anisotropy = 8;
  return t;
}

function buildLivery() {
  const Wc = 4096, Hc = 2048;
  const { c, ctx } = makeCanvas(Wc, Hc);
  const img = ctx.createImageData(Wc, Hc);
  const navy = [14, 34, 78], cyan = [0, 164, 214], white = [243, 245, 247], belly = [192, 197, 204];
  const bz = (z: number) => -2.15 + 3.95 * Math.pow(smoothstep(2.0, 19.2, z), 0.8);
  for (let px = 0; px < Wc; px++) {
    const z = FUS.zNose + ((px + 0.5) / Wc) * FL;
    const s = fuselageSection(z);
    const b = bz(z);
    for (let py = 0; py < Hc; py++) {
      const th = ((py + 0.5) / Hc) * TAU;
      const y = s.cy + s.rh * Math.cos(th);
      let col = white;
      const bl = smoothstep(-1.22, -1.28, y);
      let r = lerp(white[0], belly[0], bl), g = lerp(white[1], belly[1], bl), bb = lerp(white[2], belly[2], bl);
      if (z > 2.0) {
        if (y < b) { col = navy; r = col[0]; g = col[1]; bb = col[2]; }
        else if (y < b + 0.17) { col = cyan; r = col[0]; g = col[1]; bb = col[2]; }
        else if (y > b + 0.26 && y < b + 0.31) { r = navy[0]; g = navy[1]; bb = navy[2]; }
      }
      const i = (py * Wc + px) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = bb; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const toPx = (z: number, th: number): [number, number] => [((z - FUS.zNose) / FL) * Wc, (th / TAU) * Hc];
  const pathZY = (pts: [number, number][], side: number) => {
    ctx.beginPath();
    pts.forEach(([z, y], i) => { const [x, yy] = toPx(z, thetaAtY(z, y, side)); if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy); });
    ctx.closePath();
  };
  const rr = (zc: number, yc: number, w: number, h: number, r: number): [number, number][] => {
    const pts: [number, number][] = [];
    const cs: [number, number, number][] = [[zc + w / 2 - r, yc + h / 2 - r, 0], [zc - w / 2 + r, yc + h / 2 - r, 90], [zc - w / 2 + r, yc - h / 2 + r, 180], [zc + w / 2 - r, yc - h / 2 + r, 270]];
    for (const [cx, cy, a0] of cs) for (let k = 0; k <= 6; k++) {
      const a = (a0 + (k / 6) * 90) * D2R;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  };
  // panel lines
  ctx.strokeStyle = "rgba(90,95,105,0.35)"; ctx.lineWidth = 1.2;
  for (const z of [-12.4, -8.9, -5.2, -1.0, 3.4, 7.5, 11.8, 15.4]) {
    const [x] = toPx(z, 0);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Hc); ctx.stroke();
  }
  for (const d of [28, 62, 118, 150, 210, 242, 298, 332]) {
    const y = (d / 360) * Hc;
    ctx.beginPath(); ctx.moveTo(toPx(-12.4, 0)[0], y); ctx.lineTo(toPx(12, 0)[0], y); ctx.stroke();
  }
  for (const side of [1, -1]) {
    // passenger windows
    for (let k = 0; k < 40; k++) {
      const z = -11.15 + k * 0.533;
      if (z > 9.9) break;
      if (Math.abs(z - (-2.0)) < 0.1) continue;
      const pts = rr(z, 0.42, 0.235, 0.335, 0.09);
      pathZY(pts, side);
      ctx.fillStyle = "#12161c"; ctx.fill();
      ctx.strokeStyle = "rgba(120,126,134,0.9)"; ctx.lineWidth = 2.2; ctx.stroke();
    }
    // doors
    ctx.strokeStyle = "rgba(70,76,86,0.95)"; ctx.lineWidth = 2.6;
    for (const zc of [-12.72, 11.05]) {
      pathZY(rr(zc, 0.28, 0.82, 1.86, 0.16), side); ctx.stroke();
      pathZY(rr(zc, 0.62, 0.2, 0.26, 0.07), side); ctx.fillStyle = "#12161c"; ctx.fill();
      pathZY(rr(zc + 0.26 * (side > 0 ? -1 : 1), 0.18, 0.14, 0.05, 0.02), side); ctx.fillStyle = "rgba(90,96,106,1)"; ctx.fill();
    }
    // over-wing exits
    for (const zc of [-2.25, -1.55]) { pathZY(rr(zc, 0.34, 0.5, 0.96, 0.1), side); ctx.stroke(); }
    // cargo doors (right side)
    if (side > 0) {
      for (const zc of [-8.3, 5.4]) { pathZY(rr(zc, -1.02, 1.8, 1.22, 0.1), side); ctx.stroke(); }
    }
    // titles
    const drawText = (txt: string, z: number, y: number, hM: number, color: string, font = "900") => {
      const [x, yy] = toPx(z, thetaAtY(z, y, side));
      const pxU = Wc / FL, pxV = Hc / (TAU * FUS.R);
      ctx.save();
      ctx.translate(x, yy);
      ctx.scale((side > 0 ? -1 : 1) * pxU / 100, (side > 0 ? 1 : -1) * pxV / 100);
      ctx.fillStyle = color;
      ctx.font = `${font} ${hM * 100}px 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    };
    drawText("AERIS", -5.2, 1.22, 1.05, "#0e224e");
    drawText("AIRWAYS", -0.9, 1.26, 0.42, "#00a4d6", "700");
    drawText("D-AERS", 13.6, 0.95, 0.34, "#ffffff", "700");
    drawText("A320", -14.2, -0.35, 0.16, "#7a808a", "700");
  }
  // radome joint, static port plates
  ctx.strokeStyle = "rgba(96,102,112,0.55)"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 0; k <= 96; k++) {
    const th = (k / 96) * TAU;
    const [x, y] = toPx(-16.78 + 0.18 * (1 - Math.cos(th)) / 2, th);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  for (const side of [1, -1]) {
    pathZY(rr(-15.35, -0.32, 0.26, 0.2, 0.03), side);
    ctx.fillStyle = "#e9ebee"; ctx.fill(); ctx.strokeStyle = "#c8323a"; ctx.lineWidth = 2.5; ctx.stroke();
    pathZY(rr(-15.35, -0.32, 0.07, 0.07, 0.035), side); ctx.fillStyle = "#8d949c"; ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return { map: t, alpha: windowMask(0, 0.006), liningAlpha: windowMask(-0.055, 0.03) };
}

/** laminated windscreen glass: faint green tint, transmission high at normal incidence, reflective at grazing angles */
function flightDeckGlass() {
  const m = new THREE.MeshPhysicalMaterial({ color: "#3d5a52", metalness: 0, roughness: 0.03, transparent: true, opacity: 0.1, envMapIntensity: 1.6, specularIntensity: 1, side: THREE.DoubleSide, depthWrite: false });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <opaque_fragment>", `
      float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
      diffuseColor.a = mix(diffuseColor.a, 0.92, fres);
      #include <opaque_fragment>`);
  };
  return m;
}

function finTexture() {
  const S = 1024;
  const { c, ctx } = makeCanvas(S, S);
  ctx.fillStyle = "#0e224e"; ctx.fillRect(0, 0, S, S);
  const g = ctx.createLinearGradient(0, S, S, 0);
  g.addColorStop(0, "#0a1a3c"); g.addColorStop(1, "#15306a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  // stylised swoosh logo
  ctx.save();
  ctx.translate(S * 0.55, S * 0.52);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(0, 0, S * (0.34 - i * 0.07), S * (0.14 - i * 0.03), -0.55, 0.25, Math.PI * 1.25);
    ctx.lineWidth = S * 0.035;
    ctx.strokeStyle = i === 1 ? "#ffffff" : "#00a4d6";
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(S * 0.02, -S * 0.01, S * 0.045, 0, TAU); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
  // cyan fin tip band
  ctx.fillStyle = "#00a4d6"; ctx.fillRect(0, 0, S, S * 0.05);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return t;
}

function spinnerTexture() {
  const { c, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = "#9da3aa"; ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#f4f4f4"; ctx.lineWidth = 18;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const t = i / 40; const x = t * 256 * 0.35, y = t * 256; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function treadTexture() {
  const { c, ctx } = makeCanvas(64, 256);
  ctx.fillStyle = "#2a2a2a"; ctx.fillRect(0, 0, 64, 256);
  ctx.fillStyle = "#0a0a0a";
  for (const v of [0.42, 0.47, 0.53, 0.58]) ctx.fillRect(0, v * 256 - 2, 64, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


/* ------------------------------------------------------------------ */
/*  Visual state                                                      */
/* ------------------------------------------------------------------ */
export interface VisualState {
  gear: number; // 0 = up, 1 = down
  flapDeg: number;
  slat: number; // 0..1
  aileron: number; // -1..1 (+ = roll right)
  elevator: number; // -1..1 (+ = nose up)
  rudder: number; // -1..1 (+ = yaw right)
  spoilers: number; // speedbrake 0..1
  groundSpoilers: number; // 0..1
  n1: number; // 0..1
  reverser: number; // 0..1
  wheelSpeed: number; // m/s ground speed
  noseSteer: number; // rad
  comp: [number, number, number]; // nose, left, right oleo compression (m)
  throttle: number;
  stickX: number; stickY: number;
  flapLever: number; // 0..4
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean };
  dayFactor: number; // 1 day .. 0 night
  // flight deck controls
  parkingBrake: boolean;
  gearLever: boolean; // true = down
  pedal: number; // rudder pedal input -1..1 (+ = right)
  speedbrakeLever: number; // 0..1
  reverseSelected: boolean;
  onGround: boolean;
}

export interface Hinge {
  pivot: THREE.Object3D;
  set: (angle: number, offset?: V3) => void;
}

function makeHinge(parent: THREE.Object3D, geom: THREE.BufferGeometry, p0: V3, p1: V3, mat: THREE.Material): Hinge {
  const dir = p1.clone().sub(p0).normalize();
  const q0 = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), dir);
  const g = geom.clone();
  g.translate(-p0.x, -p0.y, -p0.z);
  g.applyQuaternion(q0.clone().invert());
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const pivot = new THREE.Group();
  pivot.position.copy(p0); pivot.quaternion.copy(q0);
  pivot.add(mesh);
  parent.add(pivot);
  const qa = new THREE.Quaternion();
  const X = V(1, 0, 0);
  return {
    pivot,
    set(angle: number, offset?: V3) {
      qa.setFromAxisAngle(X, angle);
      pivot.quaternion.copy(q0).multiply(qa);
      pivot.position.copy(p0);
      if (offset) pivot.position.add(offset);
    },
  };
}

export interface AircraftRig {
  root: THREE.Group;
  eye: V3;
  update: (s: VisualState, dt: number, time: number) => void;
  screens: CockpitRig["screens"];
  controls: CockpitRig["controls"];
  wheelContacts: { nose: V3; left: V3; right: V3 };
  hardPoints: { name: string; p: V3 }[];
  lightPositions: { beaconTop: V3 };
}

/* ------------------------------------------------------------------ */
/*  Build                                                             */
/* ------------------------------------------------------------------ */
export function buildAircraft(): AircraftRig {
  const root = new THREE.Group();
  root.name = "A320";
  const ext = new THREE.Group();
  root.add(ext);

  const liv = buildLivery();
  const M = {
    paint: new THREE.MeshPhysicalMaterial({ map: liv.map, alphaMap: liv.alpha, alphaTest: 0.5, alphaToCoverage: true, roughness: 0.3, metalness: 0.02, clearcoat: 1, clearcoatRoughness: 0.07 }),
    wing: new THREE.MeshPhysicalMaterial({ color: "#c3c8cf", roughness: 0.42, metalness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.25 }),
    wingLE: new THREE.MeshPhysicalMaterial({ color: "#c9cdd2", roughness: 0.22, metalness: 0.85, clearcoat: 0.3 }),
    belly: new THREE.MeshPhysicalMaterial({ color: "#c0c5cc", roughness: 0.4, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.15 }),
    white: new THREE.MeshPhysicalMaterial({ color: "#f1f3f5", roughness: 0.3, metalness: 0.02, clearcoat: 1, clearcoatRoughness: 0.08 }),
    navy: new THREE.MeshPhysicalMaterial({ color: "#0e224e", roughness: 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide }),
    fin: new THREE.MeshPhysicalMaterial({ map: finTexture(), roughness: 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 }),
    inlet: new THREE.MeshStandardMaterial({ color: "#e4e7ea", metalness: 1, roughness: 0.1, side: THREE.DoubleSide }),
    duct: new THREE.MeshStandardMaterial({ color: "#3a3d42", metalness: 0.3, roughness: 0.55, side: THREE.DoubleSide }),
    exhaust: new THREE.MeshStandardMaterial({ color: "#5d5853", metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide }),
    blade: new THREE.MeshStandardMaterial({ color: "#8e949b", metalness: 1, roughness: 0.25, side: THREE.DoubleSide }),
    spinner: new THREE.MeshStandardMaterial({ map: spinnerTexture(), metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }),
    chrome: new THREE.MeshStandardMaterial({ color: "#e6e8ea", metalness: 1, roughness: 0.08 }),
    gear: new THREE.MeshStandardMaterial({ color: "#d4d7db", metalness: 0.25, roughness: 0.45 }),
    rubber: new THREE.MeshStandardMaterial({ map: treadTexture(), color: "#ffffff", roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ color: "#b8bcc1", metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: "#1d2024", roughness: 0.6, metalness: 0.3 }),
    glass: flightDeckGlass(),
    seal: new THREE.MeshStandardMaterial({ color: "#121416", roughness: 0.55, metalness: 0.1 }),
    winFrame: new THREE.MeshStandardMaterial({ color: "#5a626d", roughness: 0.7, metalness: 0.05 }),
    pylon: new THREE.MeshPhysicalMaterial({ color: "#c9ced4", roughness: 0.38, metalness: 0.3, clearcoat: 0.6, side: THREE.DoubleSide }),
  };

  const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = ext) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  /* ---------------- Fuselage ---------------- */
  const zs: number[] = [];
  for (let i = 0; i <= 170; i++) zs.push(FUS.zNose + FUS.noseLen * (1 - Math.cos((Math.PI / 2) * (i / 170))));
  for (let z = FUS.zNose + FUS.noseLen + 0.25; z < FUS.tailStart; z += 0.25) zs.push(z);
  for (let i = 0; i <= 110; i++) zs.push(FUS.tailStart + (FUS.zTail - FUS.tailStart) * (i / 110));
  function tube(zlist: number[], nth: number, off: number, capEnd: boolean) {
    const pos: number[] = [], uv: number[] = [], uv1: number[] = [], idx: number[] = [];
    const p = V();
    zlist.forEach((z) => {
      for (let j = 0; j <= nth; j++) {
        skinPoint(z, (j / nth) * TAU, off, p);
        pos.push(p.x, p.y, p.z);
        uv.push((z - FUS.zNose) / FL, j / nth);
        uv1.push(clamp((z - FUS.zNose) / NOSE_MASK_LEN, 0, 1), j / nth);
      }
    });
    const r = nth + 1;
    for (let k = 0; k < zlist.length - 1; k++) for (let j = 0; j < nth; j++) {
      const a = k * r + j, b = k * r + j + 1, c = (k + 1) * r + j + 1, d = (k + 1) * r + j;
      idx.push(a, b, c, a, c, d);
    }
    if (capEnd) {
      const k = zlist.length - 1;
      const s = fuselageSection(zlist[k]);
      const ci = pos.length / 3;
      pos.push(0, s.cy, zlist[k]); uv.push(1, 0.5); uv1.push(1, 0.5);
      for (let j = 0; j < nth; j++) idx.push(ci, k * r + j, k * r + j + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("uv1", new THREE.Float32BufferAttribute(uv1, 2));
    g.setIndex(idx);
    orient(g);
    // weld seam normals
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < zlist.length; k++) {
      const a = k * r, b = k * r + nth;
      const nx = nrm.getX(a) + nrm.getX(b), ny = nrm.getY(a) + nrm.getY(b), nz = nrm.getZ(a) + nrm.getZ(b);
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.setXYZ(a, nx / l, ny / l, nz / l); nrm.setXYZ(b, nx / l, ny / l, nz / l);
    }
    return g;
  }
  const fus = add(tube(zs, 144, 0, true), M.paint);
  fus.name = "fuselage";

  // cockpit window glass (conforming patches)
  function patch(corners: [number, number][], off: number, n = 14) {
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const s = i / n, t = j / n;
      const z = lerp(lerp(corners[0][0], corners[1][0], s), lerp(corners[3][0], corners[2][0], s), t);
      const th = lerp(lerp(corners[0][1], corners[1][1], s), lerp(corners[3][1], corners[2][1], s), t);
      const p = surfacePoint(z, th, off);
      pos.push(p.x, p.y, p.z); uv.push(s, t);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  /* ---------------- Flight deck windows: flat panes, seals, wipers ---------------- */
  const paneShape = (w: FlightDeckWindow, outer: THREE.Vector2[], inner: THREE.Vector2[] | null, off: number, depth = 0) => {
    const sh = new THREE.Shape(outer);
    if (inner) sh.holes.push(new THREE.Path(inner));
    const g = depth > 0 ? new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 }) : new THREE.ShapeGeometry(sh, 1);
    g.translate(0, 0, off);
    g.applyMatrix4(windowMatrix(w));
    g.deleteAttribute("uv");
    return g;
  };
  const glassG: THREE.BufferGeometry[] = [], sealG: THREE.BufferGeometry[] = [], frameG: THREE.BufferGeometry[] = [];
  for (const w of WINDOWS) {
    glassG.push(paneShape(w, w.outline2, null, -0.004));
    sealG.push(paneShape(w, offsetOutline(w, 0.018), offsetOutline(w, -0.012), 0.0035));
    // interior window frame (covers the lining cut-out)
    frameG.push(paneShape(w, offsetOutline(w, 0.05), offsetOutline(w, -0.006), -0.062, 0.045));
  }
  // dark flight-deck backing seen through the glass when the interior is culled (distant views, parked aircraft)
  const backG: THREE.BufferGeometry[] = [];
  for (const w of WINDOWS) backG.push(paneShape(w, offsetOutline(w, 0.02), null, -0.32));
  const backing = new THREE.Mesh(mergeGeometries(backG), new THREE.MeshStandardMaterial({ color: "#1a1d22", roughness: 0.9, side: THREE.DoubleSide }));
  backing.name = "windowBacking"; backing.visible = false;
  ext.add(backing);
  const glass = new THREE.Mesh(mergeGeometries(glassG), M.glass);
  glass.renderOrder = 5;
  ext.add(glass);
  const seals = new THREE.Mesh(mergeGeometries(sealG), M.seal);
  seals.receiveShadow = true;
  ext.add(seals);
  const winFrames = new THREE.Mesh(mergeGeometries(frameG), M.winFrame);
  winFrames.castShadow = true; winFrames.receiveShadow = true;
  root.add(winFrames);
  // wipers, parked vertically along the centre post
  {
    const wg: THREE.BufferGeometry[] = [];
    for (const w of WINDOWS.filter((w) => w.kind === "windscreen")) {
      const c3 = w.corners2.map((c) => windowPoint(w, c.x, c.y));
      const order = c3.map((p, i) => [Math.abs(p.x), i] as [number, number]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      const ia = order[0], ib = order[1];
      const lo = c3[ia].y < c3[ib].y ? ia : ib, hi = lo === ia ? ib : ia;
      const a2 = w.corners2[lo], b2 = w.corners2[hi];
      const dir = b2.clone().sub(a2).normalize();
      const inward = new THREE.Vector2(-dir.y, dir.x);
      const cen = w.corners2.reduce((acc, p) => acc.add(p), new THREE.Vector2()).multiplyScalar(0.25);
      if (inward.dot(cen.clone().sub(a2)) < 0) inward.negate();
      const L = a2.distanceTo(b2);
      const m = windowMatrix(w);
      const ang = Math.atan2(dir.y, dir.x);
      const part = (len: number, wd: number, th: number, along: number, across: number, lift: number) => {
        const g = new THREE.BoxGeometry(len, wd, th);
        g.translate(len / 2, 0, 0);
        g.rotateZ(ang);
        const base = a2.clone().addScaledVector(dir, along).addScaledVector(inward, across);
        g.translate(base.x, base.y, lift);
        g.applyMatrix4(m);
        return g;
      };
      wg.push(part(L * 0.78, 0.016, 0.012, L * 0.06, 0.034, 0.012)); // blade
      wg.push(part(L * 0.7, 0.012, 0.008, -0.03, 0.04, 0.028)); // arm
      wg.push(part(0.05, 0.05, 0.03, -0.055, 0.04, 0.012)); // pivot
    }
    const wipers = new THREE.Mesh(mergeGeometries(wg), M.dark);
    wipers.castShadow = true;
    ext.add(wipers);
  }
  // standby compass on the centre post
  {
    const ws = WINDOWS.filter((w) => w.kind === "windscreen").map((w) => w.corners2.map((c) => windowPoint(w, c.x, c.y)));
    const top = ws.flat().filter((p) => Math.abs(p.x) < 0.2).sort((a, b) => b.y - a.y)[0];
    const comp = new THREE.Mesh(new RoundedBoxGeometry(0.085, 0.07, 0.07, 2, 0.012), M.dark);
    comp.position.set(0, top.y - 0.115, top.z + 0.07);
    root.add(comp);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.03), new THREE.MeshBasicMaterial({ color: "#d8d2bf" }));
    face.position.set(0, top.y - 0.115, top.z + 0.1055);
    root.add(face);
    root.add(cylBetween(V(0, top.y - 0.08, top.z + 0.07), V(0, top.y - 0.02, top.z + 0.05), 0.008, M.dark, 8));
  }

  // tail cone APU exhaust
  {
    const s = fuselageSection(FUS.zTail);
    const g = new THREE.CylinderGeometry(0.12, 0.14, 0.3, 32, 1, true);
    g.rotateX(Math.PI / 2);
    const m = add(g, M.exhaust); m.position.set(0, s.cy, FUS.zTail + 0.1);
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), M.dark);
    d.position.set(0, s.cy, FUS.zTail + 0.05); ext.add(d);
  }

  // belly fairing
  {
    const g = new THREE.SphereGeometry(1, 96, 48);
    g.scale(2.3, 0.95, 8.2);
    const m = add(g, M.belly); m.position.set(0, -1.38, -0.4);
  }

  // antennas & probes
  const blade = (pos: V3, up: boolean, h = 0.32, len = 0.42) => {
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(len, 0); sh.lineTo(len * 0.85, h * 0.25); sh.lineTo(len * 0.45, h); sh.lineTo(len * 0.25, h); sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 });
    g.translate(-len / 2, 0, -0.015);
    g.rotateY(Math.PI / 2);
    if (!up) g.rotateX(Math.PI);
    const m = add(g, M.white); m.position.copy(pos); return m;
  };
  blade(surfacePoint(-6.5, 0, -0.01), true);
  blade(surfacePoint(2.0, 0, -0.01), true, 0.24, 0.3);
  blade(V(0, -2.3, -3.8), false, 0.26, 0.34);
  blade(surfacePoint(-10, Math.PI, -0.01), false, 0.22, 0.3);
  for (const [z, d] of [[-16.2, 72], [-16.2, 288], [-16.0, 150], [-16.0, 210]] as [number, number][]) {
    const th = d * D2R;
    const base = surfacePoint(z, th, 0);
    const n = surfaceNormal(z, th);
    const tip = base.clone().addScaledVector(n, 0.16).add(V(0, 0, -0.08));
    ext.add(cylBetween(base, tip, 0.018, M.chrome, 12, 0.01));
  }
  // AoA vanes
  for (const d of [84, 276]) {
    const th = d * D2R;
    const base = surfacePoint(-15.2, th, 0);
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.06, 0.12), M.dark);
    vane.position.copy(base.addScaledVector(surfaceNormal(-15.2, th), 0.04));
    ext.add(vane);
  }

  /* ---------------- Wings ---------------- */
  const rightWing = new THREE.Group(); rightWing.name = "rightWing";
  const leftWing = new THREE.Group(); leftWing.name = "leftWing";
  ext.add(rightWing, leftWing);
  const both = (g: THREE.BufferGeometry, m: THREE.Material) => { add(g, m, rightWing); add(mirrorX(g), m, leftWing); };
  const GAP = 0.025;
  // wing box
  both(loft(W([0.6, 1.4, 2.3, 5.2, KINK, 6.5, 9, 11.5, 12.4, 14, 15.9, 16.3, SPAN]), 0.13, 0.74, 34), M.wing);
  // fixed leading edges
  both(loft(W([0.6, 1.4, 2.3]), 0, 0.13, 26), M.wingLE);
  both(loft(W([5.2, KINK, 6.5]), 0, 0.13, 26), M.wingLE);
  both(loft(W([16.3, SPAN]), 0, 0.13, 26), M.wingLE);
  // fixed trailing edges
  both(loft(W([0.6, 1.4, 2.3]), 0.74, 1, 16), M.wing);
  both(loft(W([15.9, SPAN]), 0.74, 1, 16), M.wing);

  interface Surf { r: Hinge; l: Hinge }
  const hingePair = (geom: THREE.BufferGeometry, p0: V3, p1: V3, mat: THREE.Material): Surf => ({
    r: makeHinge(rightWing, geom, p0, p1, mat),
    l: makeHinge(leftWing, mirrorX(geom), mirV(p1), mirV(p0), mat),
  });
  // slats
  const slats: { s: Surf; dir: V3; up: V3 }[] = [];
  for (const [a, b] of [[2.3, 5.2], [6.5, 9], [9, 11.5], [11.5, 14], [14, 16.3]]) {
    const g = loft(W([a + GAP, b - GAP]), 0, 0.13, 26);
    const sa = wingSec(a), sb = wingSec(b);
    slats.push({ s: hingePair(g, camberPt(sa, 0.13), camberPt(sb, 0.13), M.wingLE), dir: sa.dir.clone(), up: sa.up.clone() });
  }
  // flaps
  const flaps: { s: Surf; dir: V3; up: V3; chord: number }[] = [];
  for (const [a, b] of [[2.3, KINK], [KINK, 12.4]]) {
    const g = loft(W([a + GAP, b - GAP]), 0.74, 1, 22);
    const sa = wingSec(a), sb = wingSec(b);
    flaps.push({ s: hingePair(g, camberPt(sa, 0.74), camberPt(sb, 0.74), M.wing), dir: sa.dir.clone(), up: sa.up.clone(), chord: (sa.chord + sb.chord) * 0.13 });
  }
  // ailerons
  const ail = (() => {
    const a = 12.4, b = 15.9;
    const g = loft(W([a + GAP, b - GAP]), 0.74, 1, 22);
    return hingePair(g, camberPt(wingSec(a), 0.74), camberPt(wingSec(b), 0.74), M.wing);
  })();
  // spoilers (5 per side)
  const spoilers: Surf[] = [];
  const spStations = [3.2, 5.0, KINK, 8.3, 10.3, 12.3];
  for (let i = 0; i < 5; i++) {
    const a = spStations[i] + GAP, b = spStations[i + 1] - GAP;
    const g = loftRings([spoilerRing(wingSec(a), 0.585, 0.74, 10), spoilerRing(wingSec(b), 0.585, 0.74, 10)]);
    spoilers.push(hingePair(g, secPt(wingSec(a), 0.585, true), secPt(wingSec(b), 0.585, true), M.wing));
  }
  // sharklets
  {
    const T = wingSec(SPAN);
    const mk = (d: V3, chord: number, phi: number, t: number): Sec => ({
      le: T.le.clone().add(d), chord, t, camber: 0.015, dir: V(0, 0, 1), up: V(-Math.sin(phi * D2R), Math.cos(phi * D2R), 0),
    });
    const secs = [T, mk(V(0.3, 0.1, 0.22), 1.34, 22, 0.1), mk(V(0.52, 0.38, 0.48), 1.16, 50, 0.1), mk(V(0.64, 0.85, 0.8), 0.96, 74, 0.095), mk(V(0.7, 1.6, 1.32), 0.7, 81, 0.09), mk(V(0.73, 2.35, 1.95), 0.42, 83, 0.085)];
    both(loft(secs, 0, 1, 26), M.navy);
  }
  // flap track fairings
  {
    const prof = smoothProfile([[0.0, 0], [0.12, 0.08], [0.2, 0.3], [0.22, 0.55], [0.19, 0.8], [0.1, 0.95], [0.0, 1.0]], 40);
    for (const s of [3.9, 7.6, 9.9, 12.0]) {
      const sec = wingSec(s);
      const len = sec.chord * 0.8;
      const g = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p.x * 1.15, p.y * len)), 32);
      g.scale(0.62, 1, 1);
      g.rotateX(Math.PI / 2);
      const start = secPt(sec, 0.45, false).addScaledVector(sec.up, -0.05);
      g.translate(start.x, start.y, start.z);
      both(g, M.wing);
    }
  }

  /* ---------------- Engines ---------------- */
  const engS = 5.75;
  const engLE = wingSec(engS).le;
  const E = V(engS, -1.86, engLE.z - 2.35);
  const fans: THREE.Object3D[] = [];
  const reverserDoors: Hinge[] = [];
  function buildEngine(side: number) {
    const g = new THREE.Group();
    g.position.set(E.x * side, E.y, E.z);
    ext.add(g);
    const lathe = (pts: [number, number][], mat: THREE.Material, n = 96, segs = 48) => {
      const p = smoothProfile(pts, segs).map((v) => new THREE.Vector2(v.x, v.y));
      const geo = new THREE.LatheGeometry(p, n);
      geo.rotateX(Math.PI / 2);
      return add(geo, mat, g);
    };
    lathe([[0.84, 0.2], [0.87, 0.08], [0.905, 0.018], [0.95, 0.0], [0.99, 0.022], [1.015, 0.09], [1.035, 0.24]], M.inlet, 96, 40);
    lathe([[1.035, 0.24], [1.05, 0.6], [1.05, 1.2], [1.035, 1.8], [1.0, 2.4], [0.93, 3.0], [0.83, 3.5], [0.7, 4.0]], M.navy, 96, 60);
    lathe([[0.7, 4.0], [0.665, 3.98], [0.69, 3.6], [0.76, 2.9]], M.exhaust, 64, 16);
    lathe([[0.795, 0.85], [0.81, 0.55], [0.83, 0.35], [0.84, 0.2]], M.duct, 64, 16);
    lathe([[0.001, 4.85], [0.16, 4.72], [0.34, 4.4], [0.48, 4.05], [0.56, 3.7], [0.6, 3.3]], M.exhaust, 64, 30);
    const turb = new THREE.Mesh(new THREE.CircleGeometry(0.78, 48), M.dark);
    turb.position.z = 3.0; turb.rotation.y = Math.PI; g.add(turb);
    const back = new THREE.Mesh(new THREE.CircleGeometry(0.8, 48), M.dark);
    back.position.z = 1.1; back.rotation.y = Math.PI; g.add(back);
    // fan
    const fan = new THREE.Group(); fan.position.z = 0.82; g.add(fan);
    const bl: THREE.BufferGeometry[] = [];
    const NB = 24;
    for (let b = 0; b < NB; b++) {
      const pos: number[] = [], idx: number[] = [];
      const ns = 10, nc = 5;
      for (let j = 0; j <= ns; j++) {
        const t = j / ns;
        const r = lerp(0.3, 0.785, t);
        const tw = lerp(58, 22, t) * D2R;
        const w = lerp(0.16, 0.3, Math.sin(t * Math.PI * 0.7));
        const sweep = t * t * 0.06;
        for (let i = 0; i <= nc; i++) {
          const c = (i / nc - 0.5) * w;
          pos.push(Math.cos(tw) * c, r, Math.sin(tw) * c + sweep);
        }
      }
      for (let j = 0; j < ns; j++) for (let i = 0; i < nc; i++) {
        const a = j * (nc + 1) + i;
        idx.push(a, a + 1, a + nc + 2, a, a + nc + 2, a + nc + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.rotateZ((b / NB) * TAU);
      bl.push(geo);
    }
    const bm = mergeGeometries(bl); bm.computeVertexNormals();
    const blades = new THREE.Mesh(bm, M.blade); fan.add(blades);
    const sp = smoothProfile([[0.001, -0.42], [0.08, -0.36], [0.17, -0.24], [0.25, -0.1], [0.3, 0.05]], 30).map((v) => new THREE.Vector2(v.x, v.y));
    const spg = new THREE.LatheGeometry(sp, 64); spg.rotateX(Math.PI / 2);
    fan.add(new THREE.Mesh(spg, M.spinner));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.12, 48), M.blade);
    hub.rotation.x = Math.PI / 2; hub.position.z = 0.1; fan.add(hub);
    fans.push(fan);
    // thrust reverser doors (pivoting door type)
    for (let k = 0; k < 4; k++) {
      const roll = new THREE.Group();
      roll.rotation.z = (k * 90 + 45) * D2R;
      g.add(roll);
      const pts = smoothProfile([[1.05, 1.75], [1.035, 1.95], [1.02, 2.2], [1.0, 2.4]], 12).map((v) => new THREE.Vector2(v.x + 0.006, v.y));
      const dg = new THREE.LatheGeometry(pts, 16, Math.PI - 0.42, 0.84);
      dg.rotateX(Math.PI / 2);
      reverserDoors.push(makeHinge(roll, dg, V(-0.6, 1.03, 2.08), V(0.6, 1.03, 2.08), M.navy));
    }
    // nacelle chine
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.6), M.navy);
    ch.position.set(-0.55 * side, 0.9, 0.9); ch.rotation.z = 0.5 * side; g.add(ch);
    // pylon
    const sh = new THREE.Shape();
    const lower: [number, number][] = [[0.7, 0.98], [1.2, 1.0], [2.4, 0.95], [3.0, 0.88], [3.5, 0.78], [4.0, 0.64], [4.6, 0.6], [5.6, 0.62], [6.5, 0.68], [7.05, 0.8]];
    const upper: [number, number][] = [[6.4, 0.9], [5.2, 1.04], [2.6, 1.13], [1.4, 1.1]];
    sh.moveTo(lower[0][0], lower[0][1]);
    lower.slice(1).forEach(([x, y]) => sh.lineTo(x, y));
    upper.forEach(([x, y]) => sh.lineTo(x, y));
    sh.closePath();
    const pg = new THREE.ExtrudeGeometry(sh, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 4, curveSegments: 12 });
    pg.translate(0, 0, -0.15);
    pg.rotateY(-Math.PI / 2);
    pg.computeVertexNormals();
    add(pg, M.pylon, g);
  }
  buildEngine(1); buildEngine(-1);

  /* ---------------- Tail ---------------- */
  const finSecs = (ys: number[]): Sec[] => ys.map((y) => {
    const t = (y - 1.35) / (7.9 - 1.35);
    return { le: V(0, y, 10.6 + (y - 1.35) * Math.tan(34 * D2R)), chord: lerp(6.0, 1.9, t), t: 0.11, dir: V(0, 0, 1), up: V(1, 0, 0), camber: 0 };
  });
  const finUV: UVFn = (p) => [(p.z - 10.2) / 7.2, (p.y - 1.2) / 6.8];
  add(loft(finSecs([1.35, 2.0, 7.8, 7.9]), 0, 0.7, 34, finUV), M.fin);
  add(loft(finSecs([1.35, 2.0]), 0.7, 1, 16, finUV), M.fin);
  add(loft(finSecs([7.8, 7.9]), 0.7, 1, 16, finUV), M.fin);
  const rudderG = loft(finSecs([2.0 + GAP, 7.8 - GAP]), 0.7, 1, 18, finUV);
  const rs = finSecs([2.0, 7.8]);
  const rudder = makeHinge(ext, rudderG, camberPt(rs[0], 0.7), camberPt(rs[1], 0.7), M.fin);
  // dorsal fillet
  {
    const g = loft([
      { le: V(0, 1.5, 8.6), chord: 2.2, t: 0.12, dir: V(0, 0, 1), up: V(1, 0, 0), camber: 0 },
      { le: V(0, 2.05, 10.95), chord: 0.5, t: 0.4, dir: V(0, 0, 1), up: V(1, 0, 0), camber: 0 },
    ], 0, 1, 16, finUV);
    add(g, M.fin);
  }
  const HDIH = 6 * D2R;
  const hSec = (s: number): Sec => {
    const t = (s - 0.4) / (6.2 - 0.4);
    return { le: V(s, 0.45 + s * Math.tan(HDIH), 13.6 + (s - 0.4) * Math.tan(30 * D2R)), chord: lerp(3.9, 1.35, t), t: 0.1, dir: V(0, 0, 1), up: V(-Math.sin(HDIH), Math.cos(HDIH), 0), camber: -0.01 };
  };
  const HS = (l: number[]) => l.map(hSec);
  const hsR = new THREE.Group(), hsL = new THREE.Group();
  ext.add(hsR, hsL);
  const bothH = (g: THREE.BufferGeometry, m: THREE.Material) => { add(g, m, hsR); add(mirrorX(g), m, hsL); };
  bothH(loft(HS([0.4, 0.9, 6.0, 6.2]), 0, 0.72, 30), M.wing);
  bothH(loft(HS([0.4, 0.9]), 0.72, 1, 14), M.wing);
  bothH(loft(HS([6.0, 6.2]), 0.72, 1, 14), M.wing);
  const elevG = loft(HS([0.9 + GAP, 6.0 - GAP]), 0.72, 1, 16);
  const e0 = camberPt(hSec(0.9), 0.72), e1 = camberPt(hSec(6.0), 0.72);
  const elev = { r: makeHinge(hsR, elevG, e0, e1, M.wing), l: makeHinge(hsL, mirrorX(elevG), mirV(e1), mirV(e0), M.wing) };

  /* ---------------- Landing gear ---------------- */
  function wheel(R0: number, Wd: number, rimR: number) {
    const w = new THREE.Group();
    const tp = smoothProfile([[rimR, -Wd * 0.46], [R0 * 0.86, -Wd * 0.5], [R0 * 0.965, -Wd * 0.44], [R0, -Wd * 0.28], [R0 * 1.005, 0], [R0, Wd * 0.28], [R0 * 0.965, Wd * 0.44], [R0 * 0.86, Wd * 0.5], [rimR, Wd * 0.46]], 48).map((v) => new THREE.Vector2(v.x, v.y));
    const tg = new THREE.LatheGeometry(tp, 72); tg.rotateZ(-Math.PI / 2);
    const tire = new THREE.Mesh(tg, M.rubber); tire.castShadow = true; w.add(tire);
    const rp = smoothProfile([[rimR, Wd * 0.46], [rimR * 0.94, Wd * 0.38], [rimR * 0.9, Wd * 0.18], [rimR * 0.6, Wd * 0.14], [rimR * 0.35, Wd * 0.24], [rimR * 0.18, Wd * 0.26], [0.001, Wd * 0.26]], 30).map((v) => new THREE.Vector2(v.x, v.y));
    const rg = new THREE.LatheGeometry(rp, 48); rg.rotateZ(-Math.PI / 2);
    const rimA = new THREE.Mesh(rg, M.rim); w.add(rimA);
    const rimB = new THREE.Mesh(rg, M.rim); rimB.rotation.y = Math.PI; w.add(rimB);
    const bolts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 10; k++) {
      const b = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8); b.rotateZ(Math.PI / 2);
      const a = (k / 10) * TAU;
      b.translate(Wd * 0.25, Math.cos(a) * rimR * 0.42, Math.sin(a) * rimR * 0.42);
      bolts.push(b);
    }
    w.add(new THREE.Mesh(mergeGeometries(bolts), M.chrome));
    return w;
  }
  const gearParts = {
    main: [] as { leg: THREE.Group; lower: THREE.Group; wheels: THREE.Group[]; side: number }[],
    nose: null as unknown as { leg: THREE.Group; steer: THREE.Group; lower: THREE.Group; wheels: THREE.Group[] },
  };
  const MAIN_PIVOT = (side: number) => V(3.55 * side, -1.05, 0.9);
  for (const side of [1, -1]) {
    const rootG = new THREE.Group(); rootG.position.copy(MAIN_PIVOT(side)); ext.add(rootG);
    const leg = new THREE.Group(); rootG.add(leg);
    const axleY = -(GEAR_HEIGHT - 0.635) + 1.05; // relative to pivot
    leg.add(cylBetween(V(0, 0.05, 0), V(0, -1.1, 0), 0.135, M.gear, 32));
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.025, 12, 32), M.gear); collar.rotation.x = Math.PI / 2; collar.position.y = -1.08; leg.add(collar);
    leg.add(cylBetween(V(0, -0.45, 0), V(-1.15 * side, 0.1, 0.05), 0.05, M.gear, 16));
    leg.add(cylBetween(V(0, -0.45, 0), V(-0.2 * side, 0.1, -0.9), 0.045, M.gear, 16));
    const door = new THREE.Mesh(new RoundedBoxGeometry(0.035, 1.25, 0.95, 3, 0.015), M.belly);
    door.position.set(0.19 * side, -0.62, 0.02); door.castShadow = true; leg.add(door);
    const lower = new THREE.Group(); leg.add(lower);
    lower.add(cylBetween(V(0, -0.95, 0), V(0, axleY + 0.08, 0), 0.098, M.chrome, 28));
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.0, 20), M.gear);
    axle.rotation.z = Math.PI / 2; axle.position.y = axleY; lower.add(axle);
    const fit = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.26, 0.3, 2, 0.04), M.gear); fit.position.y = axleY + 0.05; lower.add(fit);
    leg.add(cylBetween(V(0, -0.98, -0.15), V(0, -1.22, -0.32), 0.035, M.gear, 10));
    lower.add(cylBetween(V(0, -1.22, -0.32), V(0, axleY + 0.2, -0.14), 0.035, M.gear, 10));
    const wheels: THREE.Group[] = [];
    for (const wx of [-0.42, 0.42]) {
      const w = wheel(0.635, 0.42, 0.39); w.position.set(wx, axleY, 0);
      if (wx < 0) w.rotation.y = Math.PI;
      const spin = new THREE.Group(); spin.position.copy(w.position); w.position.set(0, 0, 0); spin.add(w);
      lower.add(spin); wheels.push(spin);
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 24), M.dark);
      brake.rotation.z = Math.PI / 2; brake.position.set(wx * 0.9, axleY, 0); lower.add(brake);
    }
    gearParts.main.push({ leg, lower, wheels, side });
  }
  // nose gear
  const NOSE_PIVOT = V(0, -1.45, -13.4);
  const nwR = 0.38;
  let noseDoors: Hinge[] = [];
  let taxiLight: THREE.SpotLight;
  let noseLightBulb: THREE.Mesh;
  {
    const rootG = new THREE.Group(); rootG.position.copy(NOSE_PIVOT); ext.add(rootG);
    const leg = new THREE.Group(); rootG.add(leg);
    const axleY = -(GEAR_HEIGHT - nwR) + 1.45;
    leg.add(cylBetween(V(0, 0.05, 0), V(0, -0.9, 0), 0.1, M.gear, 28));
    leg.add(cylBetween(V(0, -0.35, 0), V(0, 0.1, 0.95), 0.04, M.gear, 12));
    const steer = new THREE.Group(); leg.add(steer);
    const lower = new THREE.Group(); steer.add(lower);
    lower.add(cylBetween(V(0, -0.8, 0), V(0, axleY + 0.05, 0), 0.075, M.chrome, 24));
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 16), M.gear);
    axle.rotation.z = Math.PI / 2; axle.position.y = axleY; lower.add(axle);
    const wheels: THREE.Group[] = [];
    for (const wx of [-0.19, 0.19]) {
      const w = wheel(nwR, 0.24, 0.22);
      if (wx < 0) w.rotation.y = Math.PI;
      const spin = new THREE.Group(); spin.position.set(wx, axleY, 0); spin.add(w); lower.add(spin); wheels.push(spin);
    }
    const lightBox = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.12, 0.12, 2, 0.02), M.gear);
    lightBox.position.set(0, -0.62, -0.14); leg.add(lightBox);
    noseLightBulb = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
    noseLightBulb.position.set(0, -0.62, -0.205); noseLightBulb.rotation.y = Math.PI; leg.add(noseLightBulb);
    taxiLight = new THREE.SpotLight("#fff4e0", 0, 600, 18 * D2R, 0.5, 2.0);
    taxiLight.position.set(0, -0.62, -0.3); leg.add(taxiLight);
    const tgt = new THREE.Object3D(); tgt.position.set(0, -3.5, -80); leg.add(tgt); taxiLight.target = tgt;
    gearParts.nose = { leg, steer, lower, wheels };
    // nose gear doors (conforming panels)
    const dPatch = (th0: number, th1: number) => patch([[-15.4, th0], [-15.4, th1], [-13.2, th1], [-13.2, th0]], 0.006, 10);
    const dr = dPatch(Math.PI - 0.02, Math.PI - 0.21);
    const dl = dPatch(Math.PI + 0.02, Math.PI + 0.21);
    const hr0 = surfacePoint(-15.4, Math.PI - 0.21, 0.006), hr1 = surfacePoint(-13.2, Math.PI - 0.21, 0.006);
    const hl0 = surfacePoint(-15.4, Math.PI + 0.21, 0.006), hl1 = surfacePoint(-13.2, Math.PI + 0.21, 0.006);
    noseDoors = [makeHinge(ext, dr, hr0, hr1, M.belly), makeHinge(ext, dl, hl1, hl0, M.belly)];
  }

  /* ---------------- Lights ---------------- */
  const glow = glowTexture();
  const mkLight = (pos: V3, color: string, size: number) => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    bulb.position.copy(pos); ext.add(bulb);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    sp.position.copy(pos); sp.scale.setScalar(size); sp.renderOrder = 10; ext.add(sp);
    return { bulb, sp, base: size };
  };
  const tipR = wingSec(SPAN).le.clone().add(V(0.05, 0.02, 0.15));
  const navR = mkLight(tipR, "#33ff66", 0.9);
  const navL = mkLight(mirV(tipR), "#ff2a2a", 0.9);
  const tailS = fuselageSection(FUS.zTail);
  const navT = mkLight(V(0, tailS.cy + 0.2, FUS.zTail - 0.05), "#ffffff", 0.8);
  const strR = mkLight(tipR.clone().add(V(0.06, 0.02, 0.3)), "#ffffff", 2.4);
  const strL = mkLight(mirV(tipR).add(V(-0.06, 0.02, 0.3)), "#ffffff", 2.4);
  const strT = mkLight(V(0, tailS.cy + 0.02, FUS.zTail + 0.28), "#ffffff", 2.0);
  const beaconTop = V(0, FUS.R + 0.06, -1.5);
  const bcnT = mkLight(beaconTop, "#ff2200", 1.4);
  const bcnB = mkLight(V(0, -2.34, 1.5), "#ff2200", 1.4);
  const landingSpots: THREE.SpotLight[] = [];
  const landingBulbs: THREE.Mesh[] = [];
  for (const side of [1, -1]) {
    const p = V(1.9 * side, -1.9, -2.6);
    const sl = new THREE.SpotLight("#fff6e6", 0, 1500, 12 * D2R, 0.4, 2.0);
    sl.position.copy(p); ext.add(sl);
    const tg = new THREE.Object3D(); tg.position.set(4 * side, -12, -300); ext.add(tg); sl.target = tg;
    landingSpots.push(sl);
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
    b.position.copy(p).add(V(0, -0.02, -0.05)); b.rotation.x = Math.PI * 0.6; ext.add(b);
    landingBulbs.push(b);
  }
  // logo lights / wing scan simplified as emissive fin wash handled via material

  /* ---------------- Cockpit interior ---------------- */
  const cockpit = new THREE.Group(); root.add(cockpit);
  const lining = new THREE.MeshStandardMaterial({ color: "#6f7883", roughness: 0.9, side: THREE.BackSide, alphaMap: liv.liningAlpha, alphaTest: 0.5 });
  {
    const zl: number[] = [];
    for (let z = -18.2; z <= -11.9; z += 0.06) zl.push(z);
    const shell = new THREE.Mesh(tube(zl, 96, -0.055, false), lining);
    shell.receiveShadow = true; cockpit.add(shell);
  }
  const flightDeck = buildCockpit();
  cockpit.add(flightDeck.group);

  /* ---------------- Update ---------------- */
  const tmp = V();
  let wheelAngle = 0, noseWheelAngle = 0, fanAngle = 0;
  const update = (s: VisualState, dt: number, time: number) => {
    // flaps: fowler motion
    const fd = s.flapDeg * D2R;
    const fe = s.flapDeg / 35;
    for (const f of flaps) {
      tmp.copy(f.dir).multiplyScalar(f.chord * 0.9 * fe).addScaledVector(f.up, -0.12 * fe);
      f.s.r.set(fd, tmp); f.s.l.set(fd, tmp.clone().setX(-tmp.x));
    }
    for (const sl of slats) {
      tmp.copy(sl.dir).multiplyScalar(-0.3 * s.slat).addScaledVector(sl.up, -0.14 * s.slat);
      sl.s.r.set(-20 * D2R * s.slat, tmp); sl.s.l.set(-20 * D2R * s.slat, tmp.clone().setX(-tmp.x));
    }
    const aDef = s.aileron * 25 * D2R;
    ail.r.set(-aDef); ail.l.set(aDef);
    const spd = Math.max(s.spoilers * 0.7, s.groundSpoilers);
    spoilers.forEach((sp, i) => {
      let rollR = 0, rollL = 0;
      if (i >= 1 && i <= 4) { rollR = Math.max(0, s.aileron) * 0.5; rollL = Math.max(0, -s.aileron) * 0.5; }
      const aR = -(Math.min(1, spd + rollR)) * 45 * D2R, aL = -(Math.min(1, spd + rollL)) * 45 * D2R;
      sp.r.set(i === 0 ? -s.groundSpoilers * 45 * D2R : aR);
      sp.l.set(i === 0 ? -s.groundSpoilers * 45 * D2R : aL);
    });
    const ed = -s.elevator * 25 * D2R;
    elev.r.set(ed); elev.l.set(ed);
    rudder.set(s.rudder * 25 * D2R);
    // fans
    fanAngle += (s.n1 * 5200 / 60) * TAU * dt * 0.08 + s.n1 * 0.9;
    fans.forEach((f) => (f.rotation.z = fanAngle));
    reverserDoors.forEach((d) => d.set(s.reverser * 38 * D2R));
    // gear
    const g = s.gear;
    const doorOpen = g >= 0.999 ? 1 : clamp(g / 0.15, 0, 1);
    const legT = smoothstep(0.12, 1, g);
    for (const m of gearParts.main) m.leg.rotation.z = -m.side * (Math.PI / 2) * (1 - legT);
    gearParts.nose.leg.rotation.x = (Math.PI / 2) * (1 - legT) * 1.0;
    noseDoors[0].set(doorOpen * 85 * D2R);
    noseDoors[1].set(doorOpen * 85 * D2R);
    gearParts.nose.lower.position.y = s.comp[0];
    gearParts.main.forEach((m) => (m.lower.position.y = m.side < 0 ? s.comp[1] : s.comp[2]));
    gearParts.nose.steer.rotation.y = -s.noseSteer;
    wheelAngle -= (s.wheelSpeed / 0.635) * dt;
    noseWheelAngle -= (s.wheelSpeed / nwR) * dt;
    gearParts.main.forEach((m) => m.wheels.forEach((w) => (w.rotation.x = wheelAngle)));
    gearParts.nose.wheels.forEach((w) => (w.rotation.x = noseWheelAngle));
    flightDeck.update(s, dt);
    // lights
    const night = 1 - s.dayFactor;
    const vis = (l: { bulb: THREE.Mesh; sp: THREE.Sprite; base: number }, on: boolean, k = 1) => {
      l.bulb.visible = on; l.sp.visible = on;
      (l.sp.material as THREE.SpriteMaterial).opacity = (0.35 + night * 0.65) * k;
    };
    vis(navR, s.lights.nav); vis(navL, s.lights.nav); vis(navT, s.lights.nav);
    const st = time % 1.2;
    const strobeOn = s.lights.strobe && (st < 0.06 || (st > 0.16 && st < 0.22));
    vis(strR, strobeOn); vis(strL, strobeOn); vis(strT, strobeOn);
    const bc = time % 1.0;
    const bk = bc < 0.5 ? Math.sin((bc / 0.5) * Math.PI) : 0;
    vis(bcnT, s.lights.beacon && bk > 0.05, bk); vis(bcnB, s.lights.beacon && bk > 0.05, bk);
    const landOn = s.lights.landing;
    landingSpots.forEach((l) => (l.intensity = landOn ? 5000 * (0.15 + night) : 0));
    landingBulbs.forEach((b) => (b.visible = landOn));
    taxiLight.intensity = s.lights.taxi && g > 0.9 ? 2500 * (0.15 + night) : 0;
    noseLightBulb.visible = s.lights.taxi && g > 0.9;
  };

  const eye = V(-0.53, 0.93, -15.58);
  const hardPoints = [
    { name: "tail", p: V(0, -0.2, 16.5) },
    { name: "aft belly", p: V(0, -1.2, 11.5) },
    { name: "belly", p: V(0, -2.33, -0.4) },
    { name: "nose", p: V(0, -1.9, -15.5) },
    { name: "right engine", p: V(E.x, E.y - 1.05, E.z + 1.2) },
    { name: "left engine", p: V(-E.x, E.y - 1.05, E.z + 1.2) },
    { name: "right wingtip", p: wingSec(SPAN).le.clone().add(V(0, -0.1, 0.8)) },
    { name: "left wingtip", p: mirV(wingSec(SPAN).le).add(V(0, -0.1, 0.8)) },
  ];
  return {
    root, eye, update,
    screens: flightDeck.screens,
    controls: flightDeck.controls,
    wheelContacts: {
      nose: V(0, -GEAR_HEIGHT + nwR - nwR, NOSE_PIVOT.z),
      left: V(-3.55, -GEAR_HEIGHT, 0.9),
      right: V(3.55, -GEAR_HEIGHT, 0.9),
    },
    hardPoints,
    lightPositions: { beaconTop },
  };
}
