import * as THREE from "three";
import { clamp, smoothstep } from "./noise";

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/*  Fuselage definition (A320, meters). Nose -> -Z, up +Y             */
/* ------------------------------------------------------------------ */
export const FUS = {
  R: 1.98,
  zNose: -18.6,
  zTail: 19.0,
  noseLen: 6.2,
  tailStart: 7.5,
};
export const FL = FUS.zTail - FUS.zNose;
export const GEAR_HEIGHT = 3.45; // fuselage centerline height above ground on static gear

/** monotone cubic (Fritsch-Butland) through (xs, ys) */
function pchip(pts: [number, number][]) {
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const h: number[] = [], d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    m[i] = (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / d[i - 1] + (h[i] + 2 * h[i - 1]) / d[i]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

/*
 * Nose: side-view crown / keel lines and plan-view half width (A320 3-view), interpolated in squared
 * distance from the radome tip so the tip stays round. The crown breaks sharply into the raked flat
 * windscreens at z = -16.62; the upper section is a superellipse (boxy flight-deck shoulders).
 */
const TIP_Y = -0.45;
const sq = (pts: [number, number][]) => pchip(pts.map(([z, v]) => [z, v * v] as [number, number]));
const crown = sq([
  [-18.6, 0], [-18.52, 0.23], [-18.35, 0.47], [-18.0, 0.72], [-17.5, 0.9], [-17.0, 1.01], [-16.7, 1.07], [-16.62, 1.095],
  [-16.36, 1.37], [-16.11, 1.63], // windscreen (46 deg)
  [-15.85, 1.86], [-15.45, 2.05], [-14.85, 2.22], [-14.05, 2.34], [-13.2, 2.41], [-12.4, 2.43], [-11, 2.43],
]);
const keel = sq([
  [-18.6, 0], [-18.52, 0.27], [-18.35, 0.55], [-18.0, 0.87], [-17.5, 1.11], [-17.0, 1.26], [-16.3, 1.38], [-15.5, 1.46],
  [-14.5, 1.51], [-13.4, 1.53], [-12.4, 1.53], [-11, 1.53],
]);
const halfW = sq([
  [-18.6, 0], [-18.52, 0.3], [-18.35, 0.6], [-18.0, 0.95], [-17.5, 1.24], [-17.0, 1.43], [-16.3, 1.62], [-15.5, 1.78],
  [-14.5, 1.9], [-13.4, 1.965], [-12.4, 1.98], [-11, 1.98],
]);
const upperN = pchip([[-18.6, 2.0], [-17.6, 2.1], [-16.8, 2.5], [-16.0, 2.6], [-15.2, 2.45], [-14.2, 2.15], [-13.0, 2.0], [-12.4, 2.0], [-11, 2.0]]);

export interface Section { cy: number; rw: number; rh: number; n: number }
export function fuselageSection(z: number): Section {
  const { R, zNose, noseLen, tailStart, zTail } = FUS;
  if (z <= zNose + noseLen) {
    const zz = Math.max(z, zNose);
    const top = TIP_Y + Math.sqrt(Math.max(0, crown(zz)));
    const bot = TIP_Y - Math.sqrt(Math.max(0, keel(zz)));
    return { cy: (top + bot) / 2, rh: (top - bot) / 2, rw: Math.sqrt(Math.max(0, halfW(zz))), n: upperN(zz) };
  }
  if (z < tailStart) return { cy: 0, rw: R, rh: R, n: 2 };
  const u = clamp((z - tailStart) / (zTail - tailStart), 0, 1);
  const bottom = -R + (0.8 + R) * Math.pow(u, 1.4);
  const top = R - (R - 1.12) * smoothstep(0.25, 1, u);
  const rw = R - (R - 0.16) * Math.pow(u, 1.35);
  return { cy: (top + bottom) / 2, rw, rh: (top - bottom) / 2, n: 2 };
}

/** unflattened section point; theta 0 = crown, PI/2 = right side, PI = keel */
function sectionXY(s: Section, th: number, out: V3, z: number) {
  const sn = Math.sin(th), cs = Math.cos(th);
  if (cs >= 0) {
    const e = 2 / s.n;
    return out.set(s.rw * Math.sign(sn) * Math.pow(Math.abs(sn), e), s.cy + s.rh * Math.pow(cs, e), z);
  }
  return out.set(s.rw * sn, s.cy + s.rh * cs, z);
}
function rawSP(z: number, th: number, out = V()) { return sectionXY(fuselageSection(z), th, out, z); }

export function thetaAtY(z: number, y: number, side: number) {
  const s = fuselageSection(z);
  const r = clamp((y - s.cy) / s.rh, -1, 1);
  const th = Math.acos(r >= 0 ? Math.pow(r, s.n / 2) : r);
  return side > 0 ? th : TAU - th;
}
function thetaAtX(z: number, x: number) {
  const s = fuselageSection(z);
  return Math.asin(Math.pow(clamp(Math.abs(x) / s.rw, 0, 1), s.n / 2));
}
/** theta whose (unflattened) section point lies on the ray from the section centre through p */
function thetaOfPoint(p: V3) {
  const s = fuselageSection(p.z);
  const target = Math.atan2(p.x, p.y - s.cy);
  const tmp = V();
  let lo = target < 0 ? -Math.PI : 0, hi = target < 0 ? 0 : Math.PI;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    sectionXY(s, mid, tmp, p.z);
    if (Math.atan2(tmp.x, tmp.y - s.cy) < target) lo = mid; else hi = mid;
  }
  const th = (lo + hi) / 2;
  return th < 0 ? th + TAU : th;
}

/* ------------------------------------------------------------------ */
/*  Flight deck windows: 6 flat panes                                  */
/* ------------------------------------------------------------------ */
export type WindowKind = "windscreen" | "slide" | "aft";
export interface FlightDeckWindow {
  kind: WindowKind;
  side: number; // +1 right (F/O), -1 left (CAPT)
  n: V3; d: number; // pane plane n.p = d (n points outward)
  e1: V3; e2: V3; o: V3; // in-plane basis (e1 along the sill, e2 up the pane) and origin
  corners2: THREE.Vector2[]; // pane quad in plane coords (sill-front, sill-aft/outboard, top-aft/outboard, top-front)
  outline2: THREE.Vector2[]; // rounded outline in plane coords (CCW seen from outside)
  zMin: number; zMax: number; thMin: number; thMax: number; // param bounds (with influence margin)
}

type CornerSpec = { z: number; x: number } | { z: number; y: number } | { x: number; y: number };
/** skin between the glass edge and here is flat (frame land), then blends back to the curved skin */
const FRAME_LAND = 0.05, FEATHER = 0.3;

function upperYAt(z: number, x: number) { const s = fuselageSection(z); const t = thetaAtX(z, x); return sectionXY(s, t, V(), z).y; }
function cornerPoint(c: CornerSpec): V3 {
  if ("z" in c && "x" in c) return rawSP(c.z, thetaAtX(c.z, c.x));
  if ("z" in c) return rawSP(c.z, thetaAtY(c.z, c.y, 1));
  // solve z so that the crown section passes through (x, y)
  let lo = -17.4, hi = -14.0;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (upperYAt(mid, c.x) < c.y) lo = mid; else hi = mid; }
  const z = (lo + hi) / 2;
  return rawSP(z, thetaAtX(z, c.x));
}

function roundedOutline(q: THREE.Vector2[], r: number, seg = 6) {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const da = a.clone().sub(p).normalize(), db = b.clone().sub(p).normalize();
    const half = Math.acos(clamp(da.dot(db), -1, 1)) / 2;
    const t = r / Math.tan(half);
    const pa = p.clone().addScaledVector(da, t), pb = p.clone().addScaledVector(db, t);
    const c = p.clone().addScaledVector(da.clone().add(db).normalize(), r / Math.sin(half));
    const a0 = Math.atan2(pa.y - c.y, pa.x - c.x), a1raw = Math.atan2(pb.y - c.y, pb.x - c.x);
    let a1 = a1raw;
    // take the short arc
    while (a1 - a0 > Math.PI) a1 -= TAU;
    while (a1 - a0 < -Math.PI) a1 += TAU;
    for (let k = 0; k <= seg; k++) { const ang = a0 + ((a1 - a0) * k) / seg; out.push(new THREE.Vector2(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r)); }
  }
  return out;
}

function buildWindow(spec: (typeof PANE_SPECS)[number], side: number): FlightDeckWindow {
  const pts = spec.c.map(cornerPoint);
  if (side < 0) pts.forEach((p) => (p.x = -p.x));
  const cen = pts.reduce((a, p) => a.add(p), V()).multiplyScalar(0.25);
  const n = pts[2].clone().sub(pts[0]).cross(pts[3].clone().sub(pts[1])).normalize();
  const radial = V(cen.x, cen.y - fuselageSection(cen.z).cy, 0).normalize();
  if (n.dot(radial) < 0) n.negate();
  // plane through the best-fit centre, nudged outward so the pane corners sit on the skin rather than inside it
  const d = pts.reduce((m, p) => Math.max(m, n.dot(p)), -Infinity) * 0.35 + n.dot(cen) * 0.65;
  const toPlane = (p: V3) => p.clone().addScaledVector(n, d - n.dot(p));
  const P = pts.map(toPlane);
  const e1 = P[1].clone().sub(P[0]).normalize();
  const e2 = n.clone().cross(e1).normalize();
  if (e2.y < 0) { e2.negate(); e1.negate(); } // keep (e1, e2, n) right-handed
  const o = P[0].clone();
  const to2 = (p: V3) => new THREE.Vector2(p.clone().sub(o).dot(e1), p.clone().sub(o).dot(e2));
  let corners2 = P.map(to2);
  // keep CCW when seen from outside (n toward viewer)
  const area = corners2.reduce((a, p, i) => { const q = corners2[(i + 1) % 4]; return a + p.x * q.y - q.x * p.y; }, 0);
  const flip = area < 0;
  if (flip) corners2 = [corners2[0], corners2[3], corners2[2], corners2[1]];
  const outline2 = roundedOutline(corners2, spec.r);
  // param bounds incl. influence margin
  const m = FRAME_LAND + FEATHER + 0.05;
  let zMin = Infinity, zMax = -Infinity, thMin = Infinity, thMax = -Infinity;
  for (const c of corners2) for (const [dx, dy] of [[-m, -m], [m, -m], [m, m], [-m, m]]) {
    const p = o.clone().addScaledVector(e1, c.x + dx).addScaledVector(e2, c.y + dy);
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z);
    const tt = wrapTheta(thetaOfPoint(p), side);
    thMin = Math.min(thMin, tt); thMax = Math.max(thMax, tt);
  }
  return { kind: spec.kind, side, n, d, e1, e2, o, corners2, outline2, zMin, zMax, thMin, thMax };
}

/** keep each side's theta range contiguous across the crown: right side in (-PI/2, 3PI/2), left side in (PI/2, 5PI/2) */
function wrapTheta(th: number, side: number) { return side > 0 ? (th > 1.5 * Math.PI ? th - TAU : th) : (th < 0.5 * Math.PI ? th + TAU : th); }

/*
 * Right-hand panes, corners ordered sill-inner/front, sill-outer/aft, top-outer/aft, top-inner/front.
 * Windscreen ~0.98 x 0.74 m raked 46 deg with a narrow centre post; the sliding window's front edge runs parallel to
 * the windscreen's outboard edge behind a wide corner pillar; the fixed aft window is smaller with its top edge
 * sloping down aft.
 */
const WS_SILL = 0.62, WS_TOP = 1.18, SIDE_SILL = 0.6;
const wsOB = cornerPoint({ x: 1.02, y: WS_SILL }), wsOT = cornerPoint({ x: 0.99, y: WS_TOP });
const s2FB = wsOB.z + 0.17, s2FT = wsOT.z + 0.17, s2RB = s2FB + 0.62, s2RT = s2FT + 0.52;
const rake2 = (s2RT - s2RB) / (1.16 - SIDE_SILL);
const s3FB = s2RB + 0.12, s3FT = s3FB + (1.1 - SIDE_SILL) * rake2, s3RT = s3FT + 0.36, s3RB = s3RT - (0.96 - SIDE_SILL) * rake2;
const PANE_SPECS: { kind: WindowKind; c: CornerSpec[]; r: number }[] = [
  { kind: "windscreen", r: 0.055, c: [{ z: -16.62, x: 0.052 }, { x: 1.02, y: WS_SILL }, { x: 0.99, y: WS_TOP }, { z: -16.11, x: 0.052 }] },
  { kind: "slide", r: 0.05, c: [{ z: s2FB, y: SIDE_SILL }, { z: s2RB, y: SIDE_SILL }, { z: s2RT, y: 1.16 }, { z: s2FT, y: 1.18 }] },
  { kind: "aft", r: 0.045, c: [{ z: s3FB, y: SIDE_SILL }, { z: s3RB, y: SIDE_SILL }, { z: s3RT, y: 0.96 }, { z: s3FT, y: 1.1 }] },
];

export const WINDOWS: FlightDeckWindow[] = [];
for (const side of [1, -1]) for (const s of PANE_SPECS) WINDOWS.push(buildWindow(s, side));
const WZ_MIN = Math.min(...WINDOWS.map((w) => w.zMin)), WZ_MAX = Math.max(...WINDOWS.map((w) => w.zMax));

/** plane coords -> 3D point on the pane plane (offset along the pane normal) */
export function windowPoint(w: FlightDeckWindow, u: number, v: number, off = 0, out = V()) {
  return out.copy(w.o).addScaledVector(w.e1, u).addScaledVector(w.e2, v).addScaledVector(w.n, off);
}
/** outline offset outward (+) / inward (-) in the pane plane */
export function offsetOutline(w: FlightDeckWindow, dist: number): THREE.Vector2[] {
  const c = w.outline2.reduce((a, p) => a.add(p), new THREE.Vector2()).multiplyScalar(1 / w.outline2.length);
  const N = w.outline2.length;
  return w.outline2.map((p, i) => {
    const a = w.outline2[(i + N - 1) % N], b = w.outline2[(i + 1) % N];
    const t = b.clone().sub(a).normalize();
    let nn = new THREE.Vector2(t.y, -t.x);
    if (nn.dot(p.clone().sub(c)) < 0) nn.negate();
    return p.clone().addScaledVector(nn, dist);
  });
}
/** window outline in fuselage param space (z, theta) for texture masks; `off` selects a parallel skin layer (negative = inside) */
export function windowParamOutline(w: FlightDeckWindow, grow = 0, off = 0): [number, number][] {
  return offsetOutline(w, grow).map((p) => { const q = windowPoint(w, p.x, p.y, off); return [q.z, thetaOfPoint(q)] as [number, number]; });
}
/** local -> body transform of a pane: x along e1, y along e2, z along the outward normal */
export function windowMatrix(w: FlightDeckWindow) {
  return new THREE.Matrix4().makeBasis(w.e1, w.e2, w.n).setPosition(w.o);
}

/** signed distance from p (plane coords) to the pane quad (negative inside) */
function quadDist(w: FlightDeckWindow, x: number, y: number) {
  let dmax = -Infinity;
  const c = w.corners2;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty);
    const nx = ty / l, ny = -tx / l; // outward for CCW
    dmax = Math.max(dmax, (x - a.x) * nx + (y - a.y) * ny);
  }
  return dmax;
}

const _s = V(), _c = V(), _dir = V(), _x = V(), _acc = V(), _n = V();
/**
 * Skin point with the flat window facets applied. `off` moves along the surface normal (negative = inward,
 * e.g. the cabin lining); facet planes are shifted by the same amount. Points are moved radially within their
 * section so the (z, theta) parametrisation (UVs, texture masks) stays consistent.
 */
/** the skin stays smooth: glass and seals are built to follow it, so nothing dents or steps around a window */
const CONFORM_WINDOWS = true;
export function skinPoint(z: number, th: number, off = 0, out = V()): V3 {
  const s = fuselageSection(z);
  sectionXY(s, th, _s, z);
  if (off !== 0) _s.addScaledVector(rawNormal(z, th, _n), off);
  out.copy(_s);
  if (CONFORM_WINDOWS || z > WZ_MAX || z < WZ_MIN) return out;
  let wsum = 0;
  _acc.set(0, 0, 0);
  const thR = wrapTheta(th, 1), thL = wrapTheta(th, -1);
  for (const w of WINDOWS) {
    if (z < w.zMin || z > w.zMax) continue;
    const tt = w.side > 0 ? thR : thL;
    if (tt < w.thMin || tt > w.thMax) continue;
    _c.set(0, s.cy, z);
    _dir.copy(_s).sub(_c);
    const nd = w.n.dot(_dir);
    if (nd <= 1e-4) continue;
    const t = (w.d + off - w.n.dot(_c)) / nd;
    _x.copy(_c).addScaledVector(_dir, t);
    const px = _x.x - w.o.x, py = _x.y - w.o.y, pz = _x.z - w.o.z;
    const u = px * w.e1.x + py * w.e1.y + pz * w.e1.z, v = px * w.e2.x + py * w.e2.y + pz * w.e2.z;
    const dist = quadDist(w, u, v);
    const wt = 1 - smoothstep(FRAME_LAND, FRAME_LAND + FEATHER, dist);
    if (wt <= 0) continue;
    _acc.addScaledVector(_x.sub(_s), wt);
    wsum += wt;
  }
  if (wsum > 0) out.addScaledVector(_acc, 1 / Math.max(1, wsum));
  return out;
}

function rawNormal(z: number, th: number, out = V()) {
  const e = 0.004;
  const a = rawSP(Math.min(z + e, FUS.zTail), th), b = rawSP(Math.max(z - e, FUS.zNose + 1e-4), th);
  const dz = a.sub(b);
  const c = rawSP(z, th + e), dd = rawSP(z, th - e);
  const dt = c.sub(dd);
  out.crossVectors(dt, dz).normalize();
  const radial = V(Math.sin(th), Math.cos(th), 0);
  if (out.dot(radial) < 0 && Math.abs(out.z) < 0.99) out.negate();
  if (z < FUS.zNose + 0.02) out.set(0, 0, -1);
  return out;
}

export function surfaceNormal(z: number, th: number): V3 {
  const e = 0.004;
  const dz = skinPoint(Math.min(z + e, FUS.zTail), th).sub(skinPoint(Math.max(z - e, FUS.zNose + 1e-4), th));
  const dt = skinPoint(z, th + e).sub(skinPoint(z, th - e));
  const n = new THREE.Vector3().crossVectors(dt, dz).normalize();
  const radial = V(Math.sin(th), Math.cos(th), 0);
  if (n.dot(radial) < 0 && Math.abs(n.z) < 0.99) n.negate();
  if (z < FUS.zNose + 0.02) n.set(0, 0, -1);
  return n;
}

export function surfacePoint(z: number, th: number, off = 0): V3 {
  const p = skinPoint(z, th);
  if (off !== 0) p.addScaledVector(surfaceNormal(z, th), off);
  return p;
}


/** signed height of the skin above a pane's plane (along its normal) at pane coords (u, v) */
export function skinHeight(w: FlightDeckWindow, u: number, v: number) {
  const p = windowPoint(w, u, v);
  const q = skinPoint(p.z, thetaOfPoint(p));
  return w.n.dot(q.sub(p));
}
/** range of skinHeight over the pane outline grown by `grow` (so interior parts can stay inside the shell) */
export function skinHeightRange(w: FlightDeckWindow, grow = 0) {
  let lo = Infinity, hi = -Infinity;
  for (const p of offsetOutline(w, grow)) { const h = skinHeight(w, p.x, p.y); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const c = w.corners2.reduce((a, p) => a.add(p), new THREE.Vector2()).multiplyScalar(0.25);
  const hc = skinHeight(w, c.x, c.y); lo = Math.min(lo, hc); hi = Math.max(hi, hc);
  return { lo, hi };
}
