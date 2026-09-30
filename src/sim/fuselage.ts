import * as THREE from "three";
import { clamp, smoothstep } from "./noise";

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/*  Fuselage definition (A320-class, meters). Nose -> -Z, up +Y       */
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

export function fuselageSection(z: number) {
  const { R, zNose, noseLen, tailStart, zTail } = FUS;
  if (z <= zNose + noseLen) {
    const u = clamp((z - zNose) / noseLen, 0, 1);
    const k = Math.pow(Math.max(0, 1 - Math.pow(1 - u, 2.1)), 1 / 2.1);
    return { cy: -0.34 * R * (1 - u) * (1 - u), rw: R * k, rh: R * k };
  }
  if (z < tailStart) return { cy: 0, rw: R, rh: R };
  const u = clamp((z - tailStart) / (zTail - tailStart), 0, 1);
  const bottom = -R + (0.8 + R) * Math.pow(u, 1.4);
  const top = R - (R - 1.12) * smoothstep(0.25, 1, u);
  const rw = R - (R - 0.16) * Math.pow(u, 1.35);
  return { cy: (top + bottom) / 2, rw, rh: (top - bottom) / 2 };
}

export function surfacePoint(z: number, th: number, off = 0): V3 {
  const s = fuselageSection(z);
  const p = V(s.rw * Math.sin(th), s.cy + s.rh * Math.cos(th), z);
  if (off !== 0) p.addScaledVector(surfaceNormal(z, th), off);
  return p;
}
function rawSP(z: number, th: number) {
  const s = fuselageSection(z);
  return V(s.rw * Math.sin(th), s.cy + s.rh * Math.cos(th), z);
}
export function surfaceNormal(z: number, th: number): V3 {
  const e = 0.004;
  const dz = rawSP(Math.min(z + e, FUS.zTail), th).sub(rawSP(Math.max(z - e, FUS.zNose + 1e-4), th));
  const dt = rawSP(z, th + e).sub(rawSP(z, th - e));
  const n = new THREE.Vector3().crossVectors(dt, dz).normalize();
  const radial = V(Math.sin(th), Math.cos(th), 0);
  if (n.dot(radial) < 0 && Math.abs(n.z) < 0.99) n.negate();
  if (z < FUS.zNose + 0.02) n.set(0, 0, -1);
  return n;
}
export function thetaAtY(z: number, y: number, side: number) {
  const s = fuselageSection(z);
  const th = Math.acos(clamp((y - s.cy) / s.rh, -1, 1));
  return side > 0 ? th : TAU - th;
}

// cockpit panes (right side) : corners [z, thetaDeg]
export const PANES: [number, number][][] = [
  [[-17.35, 4.2], [-17.35, 30], [-15.78, 44], [-15.78, 4.2]],
  [[-15.62, 45.5], [-14.78, 48], [-14.78, 66.5], [-15.62, 66]],
  [[-14.62, 48.5], [-13.74, 50], [-13.74, 67.5], [-14.62, 67]],
  [[-13.6, 51], [-13.16, 53], [-13.16, 66], [-13.6, 67.5]],
];
export function paneCorners(p: [number, number][], side: number): [number, number][] {
  return p.map(([z, d]) => [z, side > 0 ? d * D2R : TAU - d * D2R]);
}
