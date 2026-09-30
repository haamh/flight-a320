import * as THREE from "three";
import { makeCanvas } from "./textures";
import { mulberry } from "./noise";
import type { Telemetry } from "./instruments";

/* ------------------------------------------------------------------ */
/*  Canvas artwork for the flight deck. All panel drawing is done in   */
/*  millimetres (origin top-left of the face, y down).                 */
/* ------------------------------------------------------------------ */

export const COL = {
  body: "#4a5563", bodyD: "#3f4955", trim: "#5f6a79", leg: "#cdd3da", wht: "#f4f4f4", dim: "#2c3138", dimLeg: "#56606b",
  blk: "#0b0c0e", char: "#25272b", charL: "#33363b", amb: "#ffae00", blu: "#34b8ff", grn: "#2ee86a", red: "#ff3030", mag: "#ff4de6", yel: "#ffe000",
};
const FONT = "'Arial Narrow','Helvetica Neue',Arial,'Liberation Sans','DejaVu Sans',sans-serif";

export interface Part { k: "box" | "cyl" | "tog"; x: number; y: number; w: number; h: number; d: number }
export interface Anchor { x: number; y: number; w: number; h: number; d: number }
export interface Face { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number; s: number }
export interface Panel { face: Face; parts: Part[]; anchors: Record<string, Anchor> }

export function mkFace(wMm: number, hMm: number, ppm: number): Face {
  const { c, ctx } = makeCanvas(Math.round(wMm * ppm), Math.round(hMm * ppm));
  ctx.scale(ppm, ppm);
  ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineCap = "round";
  return { c, ctx, w: wMm, h: hMm, s: ppm };
}
export function faceTex(f: { c: HTMLCanvasElement } | HTMLCanvasElement, aniso = 8, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture("c" in f ? f.c : f);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/* ---------------- drawing helpers ---------------- */
type C2 = CanvasRenderingContext2D;
export function rr(ctx: C2, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}
export function T(ctx: C2, s: string, x: number, y: number, size: number, col: string = COL.leg, align: CanvasTextAlign = "center", wt = "bold") {
  ctx.font = `${wt} ${size}px ${FONT}`; ctx.fillStyle = col; ctx.textAlign = align; ctx.fillText(s, x, y);
}
function line(ctx: C2, x0: number, y0: number, x1: number, y1: number, col: string, w = 0.6) {
  ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
function disc(ctx: C2, x: number, y: number, r: number, fill: string, stroke?: string, lw = 0.6) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

/** painted body with very faint grain/vignette so the flat colour does not read as CG */
function paintBase(f: Face, col: string, seed = 1, grain = 6) {
  const { ctx, w, h, s } = f;
  ctx.fillStyle = col; ctx.fillRect(0, 0, w, h);
  const r = mulberry(seed);
  const n = Math.min(14000, Math.floor(w * h * s * s / 60));
  for (let i = 0; i < n; i++) {
    const a = (r() - 0.5) * grain * 2;
    ctx.fillStyle = a > 0 ? `rgba(255,255,255,${a / 255})` : `rgba(0,0,0,${-a / 255})`;
    ctx.fillRect(r() * w, r() * h, 1.2 / s * 2, 1.2 / s * 2);
  }
}

export class Sink {
  parts: Part[] = []; anchors: Record<string, Anchor> = {}; ox = 0; oy = 0;
  constructor(public f: Face) {}
  get ctx() { return this.f.ctx; }
  panel(): Panel { return { face: this.f, parts: this.parts, anchors: this.anchors }; }
  /** shift the drawing origin (canvas and recorded parts stay in step) */
  shift(dx: number, dy: number) { this.f.ctx.translate(dx, dy); this.ox += dx; this.oy += dy; }
  box(x: number, y: number, w: number, h: number, d: number) { this.parts.push({ k: "box", x: x + this.ox, y: y + this.oy, w, h, d }); }
  cyl(x: number, y: number, r: number, d: number) { this.parts.push({ k: "cyl", x: x + this.ox, y: y + this.oy, w: r * 2, h: r * 2, d }); }
  tog(x: number, y: number, r: number, d: number) { this.parts.push({ k: "tog", x: x + this.ox, y: y + this.oy, w: r * 2, h: r * 2, d }); }
  anchor(n: string, x: number, y: number, w: number, h: number, d = 0) { this.anchors[n] = { x: x + this.ox, y: y + this.oy, w, h, d }; }
}

export interface PbOpt { t?: string; b?: string; tc?: string; bc?: string; tl?: boolean; bl?: boolean; size?: number; flat?: boolean }
/** square airbus pushbutton: black cap, upper (FAULT) and lower (OFF/ON) legend halves; (cx,cy) = centre */
export function pb(S: Sink, cx: number, cy: number, w: number, h: number, o: PbOpt = {}) {
  const { ctx } = S;
  rr(ctx, cx - w / 2 - 0.8, cy - h / 2 - 0.8, w + 1.6, h + 1.6, 1.6); ctx.fillStyle = "#1c1f23"; ctx.fill();
  rr(ctx, cx - w / 2, cy - h / 2, w, h, 1.2); ctx.fillStyle = "#08090a"; ctx.fill();
  ctx.strokeStyle = "#2f343a"; ctx.lineWidth = 0.35; ctx.stroke();
  const sz = o.size ?? Math.min(w * 0.3, 3.6);
  const both = o.t && o.b;
  if (o.t) {
    const c = o.tc ?? COL.amb, lit = o.tl;
    if (lit) { rr(ctx, cx - w / 2 + 1.3, cy - h / 2 + 1.3, w - 2.6, both ? h / 2 - 1.8 : h - 2.6, 0.8); ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fill(); }
    T(ctx, o.t, cx, both ? cy - h * 0.2 : cy, sz, lit ? c : COL.dim);
  }
  if (o.b) {
    const c = o.bc ?? COL.wht, lit = o.bl;
    T(ctx, o.b, cx, both ? cy + h * 0.2 : cy, sz, lit ? c : COL.dim);
  }
  if (!o.flat) S.box(cx - w / 2, cy - h / 2, w, h, 4.2);
}
/** knob: round black cap with white pointer; ang in degrees clockwise from up */
export function knob(S: Sink, cx: number, cy: number, r: number, ang: number, d = 9, cap = "#16181b") {
  const { ctx } = S;
  disc(ctx, cx, cy, r + 1.4, "#0a0b0c");
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, "#3a3e44"); g.addColorStop(1, cap);
  disc(ctx, cx, cy, r, g as unknown as string, "#2b2f34", 0.4);
  const a = ang * Math.PI / 180;
  line(ctx, cx + Math.sin(a) * r * 0.25, cy - Math.cos(a) * r * 0.25, cx + Math.sin(a) * r * 0.92, cy - Math.cos(a) * r * 0.92, COL.wht, Math.max(0.9, r * 0.14));
  S.cyl(cx, cy, r, d);
}
/** small scale with tick labels around a selector knob (angles in degrees, cw from up) */
export function ticks(S: Sink, cx: number, cy: number, r: number, items: [number, string][], size = 2.6, col: string = COL.leg) {
  const { ctx } = S;
  for (const [a, s] of items) {
    const rad = a * Math.PI / 180;
    line(ctx, cx + Math.sin(rad) * (r + 0.8), cy - Math.cos(rad) * (r + 0.8), cx + Math.sin(rad) * (r + 2.6), cy - Math.cos(rad) * (r + 2.6), col, 0.45);
    if (s) T(ctx, s, cx + Math.sin(rad) * (r + 5.4), cy - Math.cos(rad) * (r + 5.4) , size, col);
  }
}
function toggleSw(S: Sink, cx: number, cy: number, up = true) {
  const { ctx } = S;
  disc(ctx, cx, cy, 3.4, "#15171a", "#6c747e", 0.5);
  disc(ctx, cx, cy + (up ? -0.8 : 0.8), 1.6, "#b7bec6");
  S.tog(cx, cy, 2.2, 7);
}
/** framed sub-panel with a title (white outline like the printed overhead panels) */
function subPanel(ctx: C2, x: number, y: number, w: number, h: number, title: string, col: string = COL.leg, tsz = 4.2) {
  ctx.strokeStyle = col; ctx.lineWidth = 0.7; ctx.strokeRect(x, y, w, h);
  if (title) {
    ctx.font = `bold ${tsz}px ${FONT}`; const tw = ctx.measureText(title).width + 3;
    ctx.fillStyle = COL.body; ctx.fillRect(x + w / 2 - tw / 2, y - tsz * 0.6, tw, tsz * 1.2);
    T(ctx, title, x + w / 2, y, tsz, col);
  }
}
function screw(ctx: C2, x: number, y: number, r = 1.4) {
  disc(ctx, x, y, r, "#2b3139", "#151a20", 0.3); line(ctx, x - r * 0.7, y, x + r * 0.7, y, "#0e1216", 0.3);
}

/* ================================================================== */
/*  Main instrument panel faces                                       */
/* ================================================================== */
export const MIP = { W: 800, WC: 540, H: 700, DU: 215, duY: 124, ppm: 1.28 };

function lightingKnobs(S: Sink, cx: number, y: number, label: string) {
  const { ctx } = S;
  T(ctx, label, cx, y - 15, 3.8, COL.leg);
  knob(S, cx - 18, y, 7.5, -40, 8); knob(S, cx + 18, y, 7.5, 50, 8);
  T(ctx, "BRT", cx, y + 15, 3.2, COL.leg); T(ctx, "OFF", cx - 18, y + 13, 2.6, COL.leg); T(ctx, "OFF", cx + 18, y + 13, 2.6, COL.leg);
  ticks(S, cx - 18, y, 7.5, [[-135, ""], [135, ""]], 2);
}
function grille(S: Sink, cx: number, cy: number, w: number, h: number) {
  const { ctx } = S;
  rr(ctx, cx - w / 2, cy - h / 2, w, h, 4); ctx.fillStyle = "#15181c"; ctx.fill();
  for (let y = cy - h / 2 + 4; y < cy + h / 2 - 2; y += 4.2) { rr(ctx, cx - w / 2 + 4, y, w - 8, 1.8, 0.9); ctx.fillStyle = "#050607"; ctx.fill(); line(ctx, cx - w / 2 + 5, y + 2.6, cx + w / 2 - 5, y + 2.6, "#2a2f35", 0.35); }
  S.box(cx - w / 2, cy - h / 2, w, h, 2.5);
}
function duBezel(S: Sink, cx: number, cy: number, name: string, size = MIP.DU) {
  const { ctx } = S;
  rr(ctx, cx - size / 2, cy - size / 2, size, size, 5); ctx.fillStyle = "#070809"; ctx.fill();
  rr(ctx, cx - size / 2 + 0.6, cy - size / 2 + 0.6, size - 1.2, size - 1.2, 4.6); ctx.strokeStyle = "#1b1e22"; ctx.lineWidth = 0.9; ctx.stroke();
  S.box(cx - size / 2, cy - size / 2, size, size, 13);
  S.anchor(name, cx - 95, cy - 95, 190, 190, 13.4);
}
function mipFrame(f: Face) {
  const { ctx, w, h } = f;
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1.2; ctx.strokeRect(0.6, 0.6, w - 1.2, h - 1.2);
  ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(0, 0, w, 5);
  for (const [x, y] of [[6, 10], [w - 6, 10], [6, h - 8], [w - 6, h - 8]]) screw(ctx, x, y);
}
function railBar(S: Sink, x0: number, x1: number, y: number) {
  const { ctx } = S;
  const g = ctx.createLinearGradient(0, y, 0, y + 12); g.addColorStop(0, "#aeb6bf"); g.addColorStop(0.5, "#8d96a1"); g.addColorStop(1, "#6b737d");
  ctx.fillStyle = g; ctx.fillRect(x0, y, x1 - x0, 12);
  S.box(x0, y, x1 - x0, 12, 6);
}

/** captain (side = -1, inner edge at the right) or first officer (side = +1, inner edge at the left) outer section */
export function mipSide(side: -1 | 1): Panel {
  const { W, H, DU, duY } = MIP;
  const f = mkFace(W, H, MIP.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, COL.body, side < 0 ? 3 : 4);
  mipFrame(f);
  const X = (x: number) => (side < 0 ? W - x : x); // x measured from the inner edge
  const ndX = X(118), pfdX = X(341);
  duBezel(S, ndX, duY, "nd"); duBezel(S, pfdX, duY, "pfd");
  // under-display row
  const uy = duY + DU / 2 + 26;
  lightingKnobs(S, pfdX, uy, "PFD"); lightingKnobs(S, ndX, uy, "ND");
  // outboard column
  const ox = X(560);
  grille(S, ox, 92, 120, 110);
  T(ctx, "LOUDSPEAKER", ox, 158, 3.4, COL.leg);
  // switching block
  const by = 205;
  subPanel(ctx, ox - 100, by - 10, 200, 88, "EFIS SWITCHING", COL.leg, 3.6);
  pb(S, ox - 62, by + 22, 34, 34, { t: "FAULT", b: "OFF", size: 3.4 });
  pb(S, ox - 22, by + 22, 34, 34, { t: "FAULT", b: "OFF", size: 3.4 });
  T(ctx, side < 0 ? "CAPT" : "F/O", ox + 45, by + 14, 4.4, COL.leg); T(ctx, "3", ox + 45, by + 28, 3.6, COL.leg);
  ticks(S, ox + 62, by + 38, 8, [[-50, "CAPT"], [0, "NORM"], [50, "F/O"]], 2.6);
  knob(S, ox + 62, by + 38, 8, 0, 8);
  T(ctx, "ATT HDG", ox - 62, by + 58, 3, COL.leg); T(ctx, "AIR DATA", ox - 22, by + 58, 3, COL.leg);
  // DU brightness lower strip with rail bar
  railBar(S, 12, W - 12, 340);
  // lower half: panel seams, table flap & knee pads
  ctx.strokeStyle = "rgba(0,0,0,0.30)"; ctx.lineWidth = 0.9;
  ctx.strokeRect(40, 400, W - 80, 270);
  ctx.fillStyle = "rgba(0,0,0,0.12)"; ctx.fillRect(41, 401, W - 82, 268);
  T(ctx, "TABLE", X(400), 455, 4, COL.dimLeg);
  rr(ctx, X(400) - 34, 468, 68, 8, 3); ctx.fillStyle = "#15181b"; ctx.fill();
  S.box(X(400) - 34, 468, 68, 8, 4);
  for (let i = 0; i < 6; i++) line(ctx, 60, 490 + i * 30, W - 60, 490 + i * 30, "rgba(0,0,0,0.12)", 0.7);
  // ND range / chart labels on the map bar
  T(ctx, "MAP", X(430), 346, 4.2, "#1d2126");
  return S.panel();
}

export function mipCentre(): Panel {
  const { WC: W, H, DU, duY } = MIP;
  const f = mkFace(W, H, MIP.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, COL.body, 5);
  mipFrame(f);
  const ex = 270;
  duBezel(S, ex, duY, "ewd"); duBezel(S, ex, duY + DU + 9, "sd");
  const sdY = duY + DU + 9;
  // brightness strip under the SD
  lightingKnobs(S, ex, sdY + DU / 2 + 26, "ECAM");
  // ---- ISIS + clock column (left of the E/WD)
  const cxL = 77;
  rr(ctx, cxL - 62, 14, 124, 124, 5); ctx.fillStyle = "#070809"; ctx.fill();
  rr(ctx, cxL - 61.4, 14.6, 122.8, 122.8, 4.6); ctx.strokeStyle = "#1b1e22"; ctx.lineWidth = 0.9; ctx.stroke();
  S.box(cxL - 62, 14, 124, 124, 9);
  S.anchor("isis", cxL - 52, 24, 104, 104, 9.4);
  T(ctx, "ISIS", cxL, 147, 4, COL.leg);
  // clock
  rr(ctx, cxL - 62, 160, 124, 88, 3); ctx.fillStyle = "#1d2229"; ctx.fill(); ctx.strokeStyle = "#0b0d10"; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, cxL - 54, 168, 108, 46, 2); ctx.fillStyle = "#050607"; ctx.fill();
  S.box(cxL - 62, 160, 124, 88, 4);
  S.anchor("clock", cxL - 54, 168, 108, 46, 4.4);
  T(ctx, "GPS", cxL - 40, 226, 3.4, COL.leg); T(ctx, "UTC", cxL - 14, 226, 3.4, COL.leg); T(ctx, "ET", cxL + 10, 226, 3.4, COL.leg); T(ctx, "CHR", cxL + 36, 226, 3.4, COL.leg);
  knob(S, cxL - 36, 238, 4.5, 30, 6); knob(S, cxL + 36, 238, 4.5, -30, 6);
  // standby ADI/ALT selector area
  T(ctx, "ACCU", cxL, 270, 3.6, COL.leg); T(ctx, "PRESS", cxL, 276.5, 3.6, COL.leg);
  disc(ctx, cxL, 306, 22, "#0a0b0c", "#8a929b", 0.8);
  for (let a = -135; a <= 135; a += 27) { const r = a * Math.PI / 180; line(ctx, cxL + Math.sin(r) * 17, 306 - Math.cos(r) * 17, cxL + Math.sin(r) * 21, 306 - Math.cos(r) * 21, COL.wht, 0.7); }
  T(ctx, "0", cxL - 15, 324, 3, COL.wht); T(ctx, "4", cxL + 15, 324, 3, COL.wht);
  ctx.strokeStyle = COL.grn; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cxL, 306); ctx.lineTo(cxL + 12, 298); ctx.stroke();
  // ---- gear column (right of the SD)
  const gx = 459;
  rr(ctx, gx - 75, 16, 150, 122, 4); ctx.fillStyle = "#1b1f25"; ctx.fill();
  T(ctx, "LDG GEAR", gx, 26, 5.4, COL.wht);
  const lamp = (cx: number, cy: number, nm: string, lab: string) => {
    rr(ctx, cx - 21, cy - 27, 42, 54, 2.5); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#3a4149"; ctx.lineWidth = 0.6; ctx.stroke();
    T(ctx, "UNLK", cx, cy - 18, 4.2, "#3a1214"); T(ctx, lab, cx, cy + 22, 3.6, COL.leg);
    ctx.fillStyle = "#0f2a18"; ctx.beginPath(); ctx.moveTo(cx - 10, cy - 6); ctx.lineTo(cx + 10, cy - 6); ctx.lineTo(cx, cy + 12); ctx.closePath(); ctx.fill();
    S.box(cx - 21, cy - 27, 42, 54, 2.6);
    S.anchor(nm, cx - 21, cy - 27, 42, 54, 3.0);
  };
  lamp(gx - 46, 78, "lgL", "L"); lamp(gx, 78, "lgN", "NOSE"); lamp(gx + 46, 78, "lgR", "R");
  // gear lever slot
  const gy0 = 160, gy1 = 282;
  rr(ctx, gx - 20, gy0, 40, gy1 - gy0, 10); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#7a838d"; ctx.lineWidth = 0.7; ctx.stroke();
  T(ctx, "UP", gx + 34, gy0 + 10, 4.4, COL.wht, "left"); T(ctx, "DOWN", gx + 26, gy1 - 10, 4, COL.wht, "left");
  pb(S, gx - 58, 215, 26, 26, { t: "DOWN", b: "LOCK REL", tc: COL.red, size: 2.4, flat: false });
  S.anchor("gearSlot", gx - 20, gy0, 40, gy1 - gy0, 0);
  // A/SKID & N/W STRG
  subPanel(ctx, gx - 75, 300, 150, 44, "A/SKID & N/W STRG", COL.leg, 3.6);
  toggleSw(S, gx, 324, true); T(ctx, "ON", gx - 18, 318, 3.6, COL.leg); T(ctx, "OFF", gx + 18, 330, 3.6, COL.leg);
  // AUTO/BRK
  subPanel(ctx, gx - 75, 360, 150, 84, "AUTO/BRK", COL.leg, 4);
  const abx = [gx - 48, gx, gx + 48], abl = ["LO", "MED", "MAX"];
  abx.forEach((x, i) => pb(S, x, 400, 40, 50, { t: "DECEL", tc: COL.grn, b: "ON", bc: COL.blu, bl: i === 1, size: 3.6 }));
  abl.forEach((l, i) => T(ctx, l, abx[i], 431, 4.4, COL.wht));
  // brake pressure triple indicator
  rr(ctx, gx - 75, 456, 150, 84, 3); ctx.fillStyle = "#0a0b0d"; ctx.fill(); ctx.strokeStyle = "#7d858f"; ctx.lineWidth = 0.7; ctx.stroke();
  T(ctx, "BRAKES", gx, 466, 4, COL.wht);
  disc(ctx, gx, 505, 28, "#050607", "#9aa2ab", 0.7);
  for (let a = -90; a <= 90; a += 18) { const r = a * Math.PI / 180; line(ctx, gx + Math.sin(r) * 22, 505 - Math.cos(r) * 22, gx + Math.sin(r) * 27, 505 - Math.cos(r) * 27, COL.wht, 0.6); }
  T(ctx, "ACCU", gx, 520, 3.2, COL.wht); T(ctx, "L", gx - 34, 522, 3.6, COL.wht); T(ctx, "R", gx + 34, 522, 3.6, COL.wht);
  ctx.strokeStyle = COL.grn; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(gx, 505); ctx.lineTo(gx - 14, 492); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(gx, 505); ctx.lineTo(gx + 14, 492); ctx.stroke();
  // lower centre: switching and misc
  railBar(S, 12, W - 12, 584);
  T(ctx, "PUSH", ex, 610, 4, COL.dimLeg);
  rr(ctx, 60, 626, W - 120, 52, 3); ctx.fillStyle = "rgba(0,0,0,0.14)"; ctx.fill();
  return S.panel();
}

/* ================================================================== */
/*  Glareshield: FCU, EFIS control panels, master lights               */
/* ================================================================== */
export const GL = { W: 2200, H: 282, ppm: 1.3 };
const gx = (X: number) => GL.W / 2 + X;

function efisPanel(S: Sink, side: -1 | 1) {
  const { ctx } = S;
  const m = side; // -1 captain (panel left of the FCU), +1 first officer
  const cx = m * 300;
  const x0 = gx(cx) - 85, y0 = 238;
  rr(ctx, x0, y0, 170, 160, 3); ctx.fillStyle = "#1b1d21"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 1; ctx.stroke();
  const L = (dx: number) => gx(cx + m * dx); // dx: outward positive from the panel centre
  T(ctx, "EFIS", gx(cx), y0 + 9, 4.4, COL.wht);
  // FD / LS
  pb(S, L(62), 268, 26, 22, { t: "FD", tc: COL.wht, tl: true, size: 4 });
  pb(S, L(62), 298, 26, 22, { t: "LS", tc: COL.wht, tl: true, size: 4 });
  S.anchor(`bar_fd${m < 0 ? "L" : "R"}`, L(62) - 9, 268 + 6.5, 18, 2.6, 4.45);
  S.anchor(`bar_ls${m < 0 ? "L" : "R"}`, L(62) - 9, 298 + 6.5, 18, 2.6, 4.45);
  // baro window + knob
  T(ctx, "QFE", L(26), 254, 3.4, COL.leg); T(ctx, "QNH", L(6), 254, 3.4, COL.leg);
  rr(ctx, L(16) - 24, 259, 48, 20, 1.5); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#3a4149"; ctx.lineWidth = 0.6; ctx.stroke();
  S.anchor(`baro${m < 0 ? "L" : "R"}`, L(16) - 22, 261, 44, 16, 0.3);
  knob(S, L(16), 305, 10, 0, 8);
  ticks(S, L(16), 305, 10, [[-60, ""], [60, ""]], 2);
  T(ctx, "BARO", L(16), 326, 3.6, COL.leg);
  T(ctx, "hPa", L(54), 320, 3.4, COL.leg); T(ctx, "inHg", L(54), 334, 3.4, COL.leg);
  toggleSw(S, L(54), 327, true);
  // 5 data buttons
  const names = ["CSTR", "WPT", "VORD", "NDB", "ARPT"];
  names.forEach((n, i) => { const y = 258 + i * 14; pb(S, L(-70), y, 24, 11, { t: n, tc: COL.wht, tl: true, size: 2.6 }); });
  // ND mode + range
  ticks(S, L(-28), 290, 13, [[-60, "LS"], [-30, "VOR"], [0, "NAV"], [30, "ARC"], [60, "PLAN"]], 3.4, COL.wht);
  knob(S, L(-28), 290, 13, 30, 10);
  T(ctx, "ND MODE", L(-28), 316, 3.6, COL.leg);
  ticks(S, L(-28), 353, 9, [[-75, "10"], [-45, "20"], [-15, "40"], [15, "80"], [45, "160"], [75, "320"]], 3.0, COL.wht);
  knob(S, L(-28), 353, 9, -15, 8);
  T(ctx, "RANGE", L(-28), 376, 3.6, COL.leg);
  // ADF / VOR selectors
  T(ctx, "ADF", L(54), 346, 3.2, COL.leg); T(ctx, "VOR", L(54), 372, 3.2, COL.leg);
  toggleSw(S, L(54), 358, false);
  T(ctx, "1", L(40), 350, 3.4, COL.leg); T(ctx, "2", L(40), 366, 3.4, COL.leg);
}

export function glareshield(): Panel {
  const { W, H } = GL;
  const f = mkFace(W, H, GL.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, COL.char, 7, 5);
  // anti-glare hood darker at the front
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "rgba(0,0,0,0.30)"); g.addColorStop(0.55, "rgba(0,0,0,0.05)"); g.addColorStop(1, "rgba(255,255,255,0.03)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // vent slots on the hood
  for (const m of [-1, 1]) for (let i = 0; i < 6; i++) { rr(ctx, gx(m * 600 + i * 26 * m) - 8, 34, 16, 2.4, 1); ctx.fillStyle = "#0b0c0e"; ctx.fill(); }
  for (const m of [-1, 1]) for (let i = 0; i < 6; i++) { rr(ctx, gx(m * 880 + i * 18 * m) - 6, 80, 12, 2.2, 1); ctx.fillStyle = "#0b0c0e"; ctx.fill(); }
  S.shift(0, -122); // instrument zone sits at the aft (pilot) edge
  // ---- FCU
  const fx0 = gx(-188), fy0 = 244;
  rr(ctx, fx0, fy0, 376, 154, 3); ctx.fillStyle = "#16181b"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = "#2a2d32"; ctx.lineWidth = 0.6; ctx.strokeRect(fx0 + 3, fy0 + 3, 370, 148);
  const win = (name: string, X: number, lab: string, sub?: string) => {
    rr(ctx, gx(X) - 27, 260, 54, 26, 1.5); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#383e45"; ctx.lineWidth = 0.6; ctx.stroke();
    T(ctx, lab, gx(X), 253, 3.6, COL.wht); if (sub) T(ctx, sub, gx(X), 293, 3, COL.leg);
    S.anchor(name, gx(X) - 25, 262, 50, 22, 0.3);
  };
  win("spd", -150, "SPD   MACH"); win("hdg", -82, "HDG   TRK", "LAT"); win("alt", 44, "ALT", "LVL/CH"); win("vs", 114, "V/S   FPA", "");
  // knobs
  const fk = (X: number, y: number, r: number, lab: string, ang: number) => { knob(S, gx(X), y, r, ang, 11); T(ctx, lab, gx(X), y + r + 5, 3.4, COL.leg); };
  fk(-150, 322, 11, "SPD", 10); fk(-82, 322, 11, "HDG", -20); fk(44, 322, 11, "ALT", 5); fk(114, 322, 11, "V/S", -8);
  disc(ctx, gx(44), 322, 15, "rgba(0,0,0,0)", "#55606b", 0.8);
  T(ctx, "100", gx(44) + 20, 316, 2.6, COL.leg, "left"); T(ctx, "1000", gx(44) + 20, 328, 2.6, COL.leg, "left");
  // centre buttons
  const fb = (name: string, X: number, y: number, lab: string, w = 25, h = 21) => {
    pb(S, gx(X), y, w, h, { t: lab, tc: COL.wht, tl: true, size: 3.6 });
    S.anchor("bar_" + name, gx(X) - w / 2 + 3, y + h / 2 - 5, w - 6, 2.6, 4.45);
  };
  fb("ap1", -31, 268, "AP1"); fb("ap2", -3, 268, "AP2"); fb("athr", -17, 293, "A/THR", 27);
  fb("loc", -46, 322, "LOC"); fb("exped", 6, 322, "EXPED", 26); fb("appr", 152, 322, "APPR");
  pb(S, gx(-150), 300, 20, 9, { t: "SPD MACH", tc: COL.wht, tl: true, size: 2.2 });
  pb(S, gx(-82), 304, 20, 9, { t: "HDG TRK", tc: COL.wht, tl: true, size: 2.2 });
  pb(S, gx(150), 268, 20, 12, { t: "METRIC", tc: COL.wht, tl: true, size: 2.4 });
  pb(S, gx(152), 294, 24, 12, { t: "ALT", tc: COL.wht, tl: true, size: 2.6 });
  T(ctx, "FCU", gx(-17), 388, 3.4, COL.dimLeg);
  // ---- EFIS panels
  efisPanel(S, -1); efisPanel(S, 1);
  // ---- ends: master lights, chrono, side stick priority, autoland
  for (const m of [-1, 1] as const) {
    const mx = m * 930;
    const mb = (name: string, y: number, lab: string, col: string) => {
      rr(ctx, gx(mx) - 25, y - 21, 50, 42, 3); ctx.fillStyle = "#0d0e10"; ctx.fill(); ctx.strokeStyle = "#2b2f34"; ctx.lineWidth = 0.8; ctx.stroke();
      T(ctx, lab, gx(mx), y - 6, 4.4, col === COL.red ? "#551518" : "#553a06"); T(ctx, "MASTER", gx(mx), y - 13, 3, COL.dimLeg);
      S.box(gx(mx) - 25, y - 21, 50, 42, 4.2);
      S.anchor(`${name}${m < 0 ? "L" : "R"}`, gx(mx) - 22, y - 18, 44, 36, 4.5);
    };
    mb("mw", 292, "WARN", COL.red); mb("mc", 346, "CAUT", COL.amb);
    // side stick priority
    const px = m * 985;
    rr(ctx, gx(px) - 16, 268, 32, 80, 3); ctx.fillStyle = "#0b0c0e"; ctx.fill(); ctx.strokeStyle = "#2b2f34"; ctx.lineWidth = 0.7; ctx.stroke();
    T(ctx, m < 0 ? "CAPT" : "F/O", gx(px), 278, 3.6, "#0f3a1c"); T(ctx, "PRIORITY", gx(px), 308, 3, "#551518"); T(ctx, "SIDE STICK", gx(px), 345, 2.6, COL.leg);
    S.box(gx(px) - 16, 268, 32, 80, 3);
    // chrono
    const cxr = m * 1050;
    disc(ctx, gx(cxr), 330, 16, "#101215", "#5c6670", 1); T(ctx, "CHRONO", gx(cxr), 330, 4, COL.wht);
    S.cyl(gx(cxr), 330, 16, 6);
    // autoland + AP off lights
    const ax = m * 790;
    rr(ctx, gx(ax) - 24, 318, 48, 28, 2.5); ctx.fillStyle = "#0b0c0e"; ctx.fill(); ctx.strokeStyle = "#2b2f34"; ctx.lineWidth = 0.7; ctx.stroke();
    T(ctx, "AUTO", gx(ax), 327, 4.2, "#551518"); T(ctx, "LAND", gx(ax), 338, 4.2, "#551518");
    S.box(gx(ax) - 24, 318, 48, 28, 3);
    // panel lip screws
    screw(ctx, gx(m * 1070), 392); screw(ctx, gx(m * 690), 392);
  }
  return S.panel();
}

/* ================================================================== */
/*  Pedestal top (front -> back, 320 mm x 1330 mm)                     */
/*    A 0..260 MCDU section  B 260..900 thrust quadrant  C 900..1330    */
/* ================================================================== */
export const PED = { W: 320, H: 1330, ppm: 1.3, A: 260, B: 900,
  thrX: [115, 205], thrIdle: 660, thrToga: 470, sbX: 40, flX: 283, parkX: 283, parkY: 850 };

function keyRow(S: Sink, x: number, y: number, labels: string[], kw: number, kh: number, pitch: number, size: number, col: string = COL.wht) {
  const { ctx } = S;
  labels.forEach((l, i) => {
    const cx = x + i * pitch + kw / 2;
    rr(ctx, cx - kw / 2, y, kw, kh, 1.4); ctx.fillStyle = "#0c0d0f"; ctx.fill(); ctx.strokeStyle = "#2d3136"; ctx.lineWidth = 0.35; ctx.stroke();
    if (l) T(ctx, l, cx, y + kh / 2, size, col);
    S.box(cx - kw / 2, y, kw, kh, 3.2);
  });
}
function mcduBody(S: Sink, x0: number, y0: number, id: number) {
  const { ctx } = S;
  rr(ctx, x0, y0, 148, 250, 4); ctx.fillStyle = "#1f2227"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, x0 + 9, y0 + 6, 130, 100, 2.5); ctx.fillStyle = "#040506"; ctx.fill(); ctx.strokeStyle = "#3a4047"; ctx.lineWidth = 0.7; ctx.stroke();
  S.anchor("mcdu" + id, x0 + 14, y0 + 10, 120, 92, 0.3);
  for (let i = 0; i < 6; i++) for (const sx of [x0 + 2.5, x0 + 140.5]) { rr(ctx, sx, y0 + 12 + i * 14.6, 5, 7.5, 1); ctx.fillStyle = "#0b0c0e"; ctx.fill(); ctx.strokeStyle = "#444b53"; ctx.lineWidth = 0.3; ctx.stroke(); S.box(sx, y0 + 12 + i * 14.6, 5, 7.5, 2.6); }
  const kx = x0 + 6;
  keyRow(S, kx, y0 + 111, ["DIR", "PROG", "PERF", "INIT", "DATA", ""], 21, 8.6, 23.4, 3);
  keyRow(S, kx, y0 + 121.5, ["F-PLN", "RAD NAV", "FUEL PRED", "SEC F-PLN", "ATC COMM", "MCDU MENU"], 21, 8.6, 23.4, 2.3);
  keyRow(S, kx, y0 + 132, ["AIR PORT", "", "<", ">", "^", "v"], 21, 8.6, 23.4, 3);
  const nums = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "+/-"];
  nums.forEach((n, i) => keyRow(S, x0 + 7 + (i % 3) * 16, y0 + 147 + Math.floor(i / 3) * 14.2, [n], 14, 11.6, 16, 4.4));
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(["SP", "DEL", "/", "CLR"]);
  alpha.forEach((n, i) => keyRow(S, x0 + 59 + (i % 5) * 16, y0 + 147 + Math.floor(i / 5) * 14.2, [n], 14, 11.6, 16, n.length > 1 ? 3.2 : 4.4));
  T(ctx, id === 1 ? "MCDU 1" : "MCDU 2", x0 + 74, y0 + 243, 3.6, COL.leg);
}

function rmpPanel(S: Sink, x0: number, y0: number, id: number) {
  const { ctx } = S;
  rr(ctx, x0, y0, 148, 118, 3); ctx.fillStyle = "#23262b"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 0.9; ctx.stroke();
  T(ctx, `RMP ${id}`, x0 + 74, y0 + 8, 4.4, COL.wht);
  rr(ctx, x0 + 12, y0 + 16, 124, 20, 1.5); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#3a4149"; ctx.lineWidth = 0.6; ctx.stroke();
  S.anchor("rmp" + id, x0 + 14, y0 + 18, 120, 16, 0.3);
  keyRow(S, x0 + 8, y0 + 44, ["VHF1", "VHF2", "VHF3", "HF1", "HF2", "AM"], 20, 10, 22.2, 2.4);
  keyRow(S, x0 + 8, y0 + 58, ["NAV", "VOR", "ILS", "MLS", "ADF", "BFO"], 20, 10, 22.2, 2.4);
  pb(S, x0 + 24, y0 + 90, 26, 18, { t: "SEL", tc: COL.amb, b: "", size: 3.2 });
  knob(S, x0 + 86, y0 + 88, 11, 20, 8); ticks(S, x0 + 86, y0 + 88, 11, [[-100, ""], [100, ""]], 2);
  knob(S, x0 + 122, y0 + 88, 8, 0, 6);
  T(ctx, "TRANSFER", x0 + 24, y0 + 106, 2.6, COL.leg); T(ctx, "FREQ", x0 + 86, y0 + 106, 2.6, COL.leg); T(ctx, "VOL", x0 + 122, y0 + 102, 2.6, COL.leg);
}
function acpPanel(S: Sink, x0: number, y0: number, id: number) {
  const { ctx } = S;
  rr(ctx, x0, y0, 148, 104, 3); ctx.fillStyle = "#23262b"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 0.9; ctx.stroke();
  T(ctx, `ACP ${id}`, x0 + 74, y0 + 7, 4, COL.wht);
  const row1 = ["VHF1", "VHF2", "VHF3", "HF1", "HF2", "INT"], row2 = ["CAB", "PA", "VOR1", "VOR2", "ILS", "ADF"];
  row1.forEach((l, i) => { knob(S, x0 + 13 + i * 24.4, y0 + 28, 7, -30 + i * 7, 6); T(ctx, l, x0 + 13 + i * 24.4, y0 + 15, 2.6, COL.leg); });
  row2.forEach((l, i) => { knob(S, x0 + 13 + i * 24.4, y0 + 62, 7, 40 - i * 9, 6); T(ctx, l, x0 + 13 + i * 24.4, y0 + 49, 2.6, COL.leg); });
  keyRow(S, x0 + 8, y0 + 82, ["RESET", "MECH", "ATT", "CALL", "SPKR"], 25, 10, 27.6, 2.6);
}

export function pedestal(): Panel {
  const { W, H } = PED;
  const f = mkFace(W, H, PED.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, COL.body, 11, 6);
  // ---- A: MCDUs
  mcduBody(S, 4, 4, 1); mcduBody(S, 168, 4, 2);
  // ---- B: ECAM control panel
  subPanel(ctx, 52, 276, 216, 92, "ECAM CONTROL PANEL", COL.leg, 3.8);
  const eA = ["ENG", "BLEED", "PRESS", "ELEC", "HYD", "FUEL"], eB = ["APU", "COND", "DOOR", "WHEEL", "F/CTL", "STS"];
  eA.forEach((l, i) => pb(S, 76 + i * 34, 300, 28, 17, { t: l, tc: COL.wht, tl: true, size: 2.8 }));
  eB.forEach((l, i) => pb(S, 76 + i * 34, 322, 28, 17, { t: l, tc: COL.wht, tl: true, size: 2.8 }));
  pb(S, 94, 350, 34, 15, { t: "T.O CONFIG", tc: COL.wht, tl: true, size: 2.4 }); pb(S, 160, 350, 34, 15, { t: "EMER CANC", tc: COL.wht, tl: true, size: 2.4 });
  pb(S, 226, 350, 34, 15, { t: "RCL", tc: COL.wht, tl: true, size: 3 });
  // thrust quadrant
  const slot = (x: number, y0: number, y1: number, w: number) => { rr(ctx, x - w / 2, y0, w, y1 - y0, w / 2); ctx.fillStyle = "#050607"; ctx.fill(); ctx.strokeStyle = "#7c858f"; ctx.lineWidth = 0.6; ctx.stroke(); };
  PED.thrX.forEach((x) => slot(x, PED.thrToga - 14, 780, 12));
  const yDet: [number, string][] = [[PED.thrToga, "TOGA"], [512, "FLX/MCT"], [556, "CL"], [PED.thrIdle, "IDLE"], [690, "REV"], [750, "MAX REV"]];
  [0, 1].forEach((k) => {
    const sx = k === 0 ? 80 : 240, dir = k === 0 ? -1 : 1;
    line(ctx, sx, PED.thrToga - 6, sx, 760, COL.leg, 0.8);
    yDet.forEach(([y, l]) => { line(ctx, sx, y, sx + dir * 7, y, COL.leg, 0.8); T(ctx, l, sx + dir * 9, y, 3.4, COL.wht, k === 0 ? "right" : "left"); });
    for (let y = 580; y < 650; y += 7) line(ctx, sx, y, sx + dir * 3, y, COL.leg, 0.5);
  });
  // speed brake lever slot
  T(ctx, "SPEED", PED.sbX, 420, 3.6, COL.wht); T(ctx, "BRAKE", PED.sbX, 427, 3.6, COL.wht);
  slot(PED.sbX, 498, 700, 11);
  [[500, "RET"], [560, "1/2"], [630, "FULL"]].forEach(([y, l]) => { line(ctx, PED.sbX + 8, y as number, PED.sbX + 14, y as number, COL.leg, 0.7); T(ctx, l as string, PED.sbX + 16, y as number, 3.2, COL.wht, "left"); });
  T(ctx, "ARM", PED.sbX - 10, 480, 3, COL.grn, "right");
  // flap lever slot
  T(ctx, "FLAPS", PED.flX, 452, 3.8, COL.wht);
  slot(PED.flX, 500, 690, 11);
  [[560, "0"], [585, "1"], [610, "2"], [635, "3"], [660, "FULL"]].forEach(([y, l]) => { line(ctx, PED.flX - 8, y as number, PED.flX - 14, y as number, COL.leg, 0.7); T(ctx, l as string, PED.flX - 16, y as number, 3.4, COL.wht, "right"); });
  // pitch / rudder trim
  T(ctx, "PITCH TRIM", 160, 800, 4.4, COL.wht); T(ctx, "NOSE DN", 84, 814, 3.2, COL.leg); T(ctx, "NOSE UP", 236, 814, 3.2, COL.leg);
  subPanel(ctx, 96, 830, 128, 62, "RUD TRIM", COL.leg, 3.8);
  ticks(S, 160, 862, 10, [[-80, "L"], [0, ""], [80, "R"]], 3.4); knob(S, 160, 862, 10, 0, 8);
  pb(S, 126, 874, 26, 11, { t: "RESET", tc: COL.wht, tl: false, size: 2.4 });
  T(ctx, "PARK BRK", PED.parkX, 820, 3.6, COL.wht);
  // ---- C: engine master / mode
  subPanel(ctx, 22, 912, 276, 78, "ENG", COL.leg, 4);
  [[90, 1], [230, 2]].forEach(([x, n]) => {
    T(ctx, `MASTER ${n}`, x, 930, 3.6, COL.wht);
    rr(ctx, x - 13, 936, 26, 11, 1.5); ctx.fillStyle = "#0b0c0e"; ctx.fill();
    T(ctx, "FAULT", x - 6, 941.5, 2.4, "#4a2a06"); T(ctx, "FIRE", x + 7, 941.5, 2.4, "#4a1014");
    toggleSw(S, x, 966, true); T(ctx, "ON", x + 14, 960, 3, COL.leg, "left"); T(ctx, "OFF", x + 14, 972, 3, COL.leg, "left");
    rr(ctx, x - 12, 955, 24, 22, 1.5); ctx.strokeStyle = COL.red; ctx.lineWidth = 0.6; ctx.stroke();
  });
  ticks(S, 160, 962, 11, [[-55, "CRANK"], [0, "NORM"], [55, "IGN/START"]], 3.2, COL.leg); knob(S, 160, 962, 11, 0, 9);
  T(ctx, "MODE", 160, 924, 3.6, COL.wht);
  rmpPanel(S, 6, 1000, 1); rmpPanel(S, 166, 1000, 2);
  acpPanel(S, 6, 1126, 1); acpPanel(S, 166, 1126, 2);
  // misc: cockpit door, printer, WXR
  subPanel(ctx, 6, 1244, 100, 78, "COCKPIT DOOR", COL.leg, 3.6);
  rr(ctx, 14, 1254, 34, 11, 1.5); ctx.fillStyle = "#0b0c0e"; ctx.fill(); T(ctx, "UNLK", 31, 1259.5, 3, "#4a2a06");
  rr(ctx, 54, 1254, 40, 11, 1.5); ctx.fillStyle = "#0b0c0e"; ctx.fill(); T(ctx, "LOCK", 74, 1259.5, 3, "#0f3a1c");
  toggleSw(S, 56, 1294, true); T(ctx, "UNLOCK", 30, 1284, 3, COL.wht); T(ctx, "LOCK", 82, 1284, 3, COL.wht); T(ctx, "NORM", 56, 1312, 3, COL.wht);
  subPanel(ctx, 116, 1244, 76, 78, "WXR / TCAS", COL.leg, 3.6);
  knob(S, 136, 1282, 8, -30, 7); knob(S, 172, 1282, 8, 40, 7);
  T(ctx, "MODE", 136, 1297, 2.8, COL.leg); T(ctx, "GAIN", 172, 1297, 2.8, COL.leg);
  keyRow(S, 122, 1306, ["WXR", "TCAS", "ATC"], 20, 9, 22, 2.6);
  rr(ctx, 202, 1244, 112, 78, 3); ctx.fillStyle = "#1c1e22"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.stroke();
  T(ctx, "PRINTER", 258, 1254, 4, COL.wht);
  rr(ctx, 214, 1264, 88, 6, 2); ctx.fillStyle = "#020202"; ctx.fill();
  rr(ctx, 222, 1274, 72, 24, 2); ctx.fillStyle = "#15171a"; ctx.fill();
  pb(S, 228, 1311, 24, 10, { t: "PRINT", tc: COL.wht, size: 2.4 }); pb(S, 288, 1311, 24, 10, { t: "FEED", tc: COL.wht, size: 2.4 });
  // section joints
  for (const y of [258, 898]) { line(ctx, 0, y, W, y, "rgba(0,0,0,0.5)", 1); line(ctx, 0, y + 1.2, W, y + 1.2, "rgba(255,255,255,0.10)", 0.6); }
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1.4; ctx.strokeRect(0.7, 0.7, W - 1.4, H - 1.4);
  return S.panel();
}

/* ================================================================== */
/*  Side console top (sidestick, tiller, table, cup holder)           */
/* ================================================================== */
export const CON = { W: 650, H: 1350, ppm: 0.9, stickXi: 85, stickY: 480, tillerXi: 95, tillerY: 240 };
export function consoleTop(side: -1 | 1): Panel {
  const { W, H } = CON;
  const f = mkFace(W, H, CON.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, COL.char, side < 0 ? 21 : 22, 5);
  const X = (xi: number) => (side < 0 ? W - xi : xi); // xi from the inner edge
  // table stowage seam + latch
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1.2; ctx.strokeRect(X(330), 640, 210, 250);
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.strokeRect(X(330) + 1, 641, 208, 248);
  T(ctx, "TABLE", X(225), 670, 6, "#6e7883");
  rr(ctx, X(225) - 24, 700, 48, 8, 3); ctx.fillStyle = "#0b0c0e"; ctx.fill(); S.box(X(225) - 24, 700, 48, 8, 3);
  // tiller mount
  rr(ctx, X(CON.tillerXi) - 40, CON.tillerY - 50, 80, 100, 10); ctx.fillStyle = "#17191c"; ctx.fill(); ctx.strokeStyle = "#0a0b0c"; ctx.lineWidth = 1.4; ctx.stroke();
  T(ctx, "TILLER", X(CON.tillerXi), CON.tillerY + 62, 6, "#7b858f");
  // "pull to block" decal
  rr(ctx, X(CON.tillerXi) - 46, CON.tillerY + 78, 92, 20, 2); ctx.fillStyle = "#0c0d0f"; ctx.fill();
  T(ctx, "PULL TO BLOCK", X(CON.tillerXi), CON.tillerY + 88, 8.5, COL.yel);
  // sidestick base plate
  disc(ctx, X(CON.stickXi), CON.stickY, 58, "#15171a", "#0a0b0c", 2);
  disc(ctx, X(CON.stickXi), CON.stickY, 46, "#1b1d21", "#2c3036", 1);
  T(ctx, "SIDE STICK", X(CON.stickXi), CON.stickY + 76, 6.5, "#7b858f");
  // window/ash tray/vent details
  for (let i = 0; i < 7; i++) { rr(ctx, X(300) - 30, 360 + i * 9, 60, 3.6, 1.6); ctx.fillStyle = "#08090a"; ctx.fill(); }
  T(ctx, "WINDOW", X(300), 344, 6, "#6e7883");
  rr(ctx, X(300) - 36, 450, 72, 42, 4); ctx.fillStyle = "#15171a"; ctx.fill(); T(ctx, "ASHTRAY", X(300), 471, 6.5, "#6e7883");
  S.box(X(300) - 36, 450, 72, 42, 2);
  // cup holder
  disc(ctx, X(250), 1120, 44, "#0e0f11", "#3b4148", 2.5); disc(ctx, X(250), 1120, 34, "#050506");
  S.cyl(X(250), 1120, 44, 2.5);
  // oxygen mask stowage footprint
  T(ctx, "OXYGEN", X(540), 900, 7, "#6e7883");
  for (const y of [300, 700, 1000, 1300]) { screw(ctx, X(30), y, 3); screw(ctx, X(620), y, 3); }
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.5; ctx.strokeRect(1, 1, W - 2, H - 2);
  return S.panel();
}

/* ================================================================== */
/*  Overhead panel (960 x 1490 mm, top edge = forward)                 */
/* ================================================================== */
export const OVH = { W: 960, H: 1150, ppm: 1.5 };

export function overheadPanel(): Panel {
  const { W, H } = OVH;
  const f = mkFace(W, H, OVH.ppm); const S = new Sink(f); const { ctx } = S;
  paintBase(f, "#4d5763", 31, 6);
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  const B = (cx: number, cy: number, o: PbOpt = {}) => pb(S, cx, cy, 26, 26, { size: 3, ...o });
  const lab = (s: string, x: number, y: number, sz = 3.2, c: string = COL.leg) => T(ctx, s, x, y, sz, c);
  const K = (cx: number, cy: number, ang: number, it: [number, string][], r = 10, l?: string) => { ticks(S, cx, cy, r, it, 3); knob(S, cx, cy, r, ang, 9); if (l) lab(l, cx, cy + r + 10, 3.2); };
  const FP = { t: "FAULT", b: "OFF" } as PbOpt;
  const lamp = (x: number, y: number, w: number, h: number, txt: string, col: string) => { rr(ctx, x - w / 2, y - h / 2, w, h, 1.5); ctx.fillStyle = "#0a0b0c"; ctx.fill(); ctx.strokeStyle = "#30353b"; ctx.lineWidth = 0.5; ctx.stroke(); T(ctx, txt, x, y, 3.2, col); };
  const guard = (x: number, y: number, w: number, h: number) => { ctx.strokeStyle = COL.red; ctx.lineWidth = 0.9; ctx.strokeRect(x - w / 2, y - h / 2, w, h); };
  const tog = (x: number, y: number, up: boolean) => toggleSw(S, x, y, up);
  type Pn = { h: number; t: string; d: (x: number, y: number, w: number) => void };
  const lay = (x0: number, w: number, list: Pn[]) => {
    const tot = list.reduce((a, p) => a + p.h, 0), gap = (H - 26 - tot) / (list.length - 1);
    let y = 14;
    list.forEach((p) => { if (p.t) subPanel(ctx, x0, y, w, p.h, p.t, COL.leg, 4.4); p.d(x0, y, w); y += p.h + gap; });
  };
  const blank = (x: number, y: number, w: number, h: number, slots = false) => {
    ctx.strokeStyle = "rgba(0,0,0,0.30)"; ctx.lineWidth = 0.8; ctx.strokeRect(x, y, w, h);
    if (slots) { for (let i = 0; i < Math.floor((h - 16) / 7); i++) { rr(ctx, x + 30, y + 10 + i * 7, w - 60, 3, 1.4); ctx.fillStyle = "#08090a"; ctx.fill(); } S.box(x + 30, y + 10, w - 60, h - 18, 1.5); }
    else for (let i = 0; i < Math.floor(h / 24); i++) line(ctx, x + 8, y + 12 + i * 24, x + w - 8, y + 12 + i * 24, "rgba(0,0,0,0.16)", 0.8);
    screw(ctx, x + 8, y + 8, 1.8); screw(ctx, x + w - 8, y + 8, 1.8); screw(ctx, x + 8, y + h - 8, 1.8); screw(ctx, x + w - 8, y + h - 8, 1.8);
  };

  // ---------- left column ----------
  lay(10, 290, [
    { h: 124, t: "ADIRS", d: (x, y) => {
      lamp(x + 30, y + 14, 38, 11, "ON BAT", COL.amb);
      [0, 1, 2].forEach((i) => { const cx = x + 48 + i * 97; lab(`IR ${i + 1}`, cx, y + 14, 4, COL.wht); B(cx, y + 36, FP); B(cx, y + 66, { t: "FAULT", b: "ALIGN", bc: COL.wht, size: 2.6 }); K(cx, y + 100, 0, [[-55, "OFF"], [0, "NAV"], [55, "ATT"]], 9); });
      lab("ADR", x + 12, y + 36, 3); lab("IR", x + 10, y + 66, 3); } },
    { h: 66, t: "FLT CTL", d: (x, y) => ["ELAC 1", "SEC 1", "FAC 1"].forEach((n, i) => { const cx = x + 48 + i * 97; B(cx, y + 26, FP); lab(n, cx, y + 50, 3.4, COL.wht); }) },
    { h: 78, t: "EVAC", d: (x, y) => {
      B(x + 50, y + 30, { t: "HORN", b: "SHUT OFF", bc: COL.wht, size: 2.4 }); guard(x + 150, y + 30, 36, 34); B(x + 150, y + 30, { t: "COMMAND", tc: COL.wht, size: 2.4 });
      tog(x + 240, y + 34, true); lab("CAPT &", x + 240, y + 20, 3); lab("PURS", x + 240, y + 26, 3); lab("CAPT", x + 240, y + 50, 3); } },
    { h: 92, t: "EMER ELEC PWR", d: (x, y) => {
      lamp(x + 36, y + 16, 40, 11, "ON BAT", COL.amb);
      B(x + 50, y + 44, { t: "SMOKE", b: "ON", tc: COL.amb, bc: COL.wht }); lab("GEN 1 LINE", x + 50, y + 68, 3.2);
      guard(x + 150, y + 44, 38, 36); B(x + 150, y + 44, { t: "MAN", b: "ON", bc: COL.blu, tc: COL.wht }); lab("RAT & EMER GEN", x + 160, y + 70, 2.8);
      B(x + 240, y + 44, { t: "TEST", tc: COL.wht, size: 3 }); lab("EMER GEN TEST", x + 240, y + 70, 2.8); } },
    { h: 84, t: "GPWS", d: (x, y) => {
      ["SYS", "G/S MODE", "FLAP MODE", "TERR"].forEach((n, i) => { const cx = x + 34 + i * 74; B(cx, y + 30, FP); lab(n, cx, y + 54, 3, COL.wht); });
      tog(x + 120, y + 70, true); lab("LDG FLAP 3", x + 170, y + 70, 3.4, COL.wht); } },
    { h: 62, t: "RCDR", d: (x, y) => {
      B(x + 50, y + 26, { t: "", b: "ON", bc: COL.blu }); lab("GND CTL", x + 50, y + 49, 3.2, COL.wht);
      B(x + 150, y + 26, { b: "TEST", bc: COL.wht }); lab("CVR TEST", x + 150, y + 49, 3.2, COL.wht);
      lab("CVR", x + 240, y + 22, 4, COL.wht); lab("FDR", x + 240, y + 36, 4, COL.wht); } },
    { h: 86, t: "OXYGEN", d: (x, y) => {
      B(x + 50, y + 30, { t: "", b: "OFF", bc: COL.wht }); lab("CREW SUPPLY", x + 50, y + 54, 3);
      guard(x + 150, y + 30, 38, 34); B(x + 150, y + 30, { t: "", b: "ON", bc: COL.blu }); lab("MASK MAN ON", x + 150, y + 54, 3);
      B(x + 240, y + 30, { t: "", b: "ON", bc: COL.blu }); lab("PASSENGER SYS", x + 240, y + 54, 3); lab("TMR RESET", x + 150, y + 74, 3, COL.dimLeg); } },
    { h: 62, t: "CALLS", d: (x, y) => ["MECH", "ALL", "FWD", "AFT"].forEach((n, i) => { const cx = x + 34 + i * 74; B(cx, y + 26, { t: "CALL", tc: COL.amb, b: "", size: 3.2 }); lab(n, cx, y + 49, 3.2, COL.wht); }) },
    { h: 80, t: "WIPER", d: (x, y) => {
      K(x + 60, y + 34, 0, [[-60, "OFF"], [0, "SLOW"], [60, "FAST"]], 11); lab("CAPT", x + 60, y + 62, 3.4, COL.wht);
      B(x + 170, y + 30, { t: "", b: "ON", bc: COL.blu }); lab("RAIN RPLNT", x + 170, y + 54, 3);
      B(x + 240, y + 30, { t: "", b: "WASH", bc: COL.wht, size: 2.8 }); lab("WASHER", x + 240, y + 54, 3); } },
    { h: 84, t: "FLOOD / INTEG LT", d: (x, y) => [["MAIN PNL", -20], ["OVHD INTEG", 30], ["FLOOD LT", 60], ["STBY COMPASS", 0]].forEach(([n, a], i) => { const cx = x + 40 + i * 70; K(cx, y + 36, a as number, [[-130, ""], [130, ""]], 10); lab(n as string, cx, y + 62, 2.8, COL.wht); }) },
    { h: 78, t: "CKPT DOOR", d: (x, y) => {
      tog(x + 50, y + 40, true); lab("UNLK", x + 50, y + 24, 3); lab("NORM", x + 50, y + 58, 3);
      B(x + 140, y + 34, { t: "", b: "ON", bc: COL.blu }); lab("VIDEO", x + 140, y + 56, 3);
      K(x + 232, y + 34, 40, [[-100, ""], [100, ""]], 10, "LOUDSPEAKER"); } },
  ]);

  // ---------- centre column ----------
  lay(316, 328, [
    { h: 108, t: "FIRE", d: (x, y) => ([["ENG 1", 58], ["APU", 164], ["ENG 2", 270]] as [string, number][]).forEach(([n, dx]) => {
      const cx = x + dx;
      lab(n, cx, y + 13, 4.2, COL.wht);
      rr(ctx, cx - 25, y + 22, 50, 40, 4); ctx.fillStyle = "#a81212"; ctx.fill(); ctx.strokeStyle = "#ff6a4a"; ctx.lineWidth = 1; ctx.stroke();
      T(ctx, "FIRE", cx, y + 42, 7, "#ffe6e0"); S.box(cx - 25, y + 22, 50, 40, 12);
      B(cx - 16, y + 84, { t: "SQUIB", tc: COL.wht, b: "DISCH", bc: COL.amb, size: 2.4 }); lab("AGENT", cx - 16, y + 70, 2.6);
      B(cx + 22, y + 84, { t: "", b: "TEST", bc: COL.wht, size: 2.6 });
    }) },
    { h: 112, t: "HYD", d: (x, y) => {
      [["GREEN", "ENG 1 PUMP", 62, "#35d66a"], ["BLUE", "ELEC PUMP", 164, "#2fb0ff"], ["YELLOW", "ENG 2 PUMP", 266, "#ffd21a"]].forEach(([nm, pl, dx, col]) => {
        const cx = x + (dx as number); lab(nm as string, cx, y + 14, 3.8, col as string); B(cx, y + 36, FP); lab(pl as string, cx, y + 56, 3, COL.wht); line(ctx, cx, y + 62, cx, y + 72, col as string, 2); });
      line(ctx, x + 62, y + 72, x + 266, y + 72, "#6f7883", 1.2);
      B(x + 62, y + 92, FP); B(x + 164, y + 92, { t: "", b: "ON", bc: COL.blu }); B(x + 266, y + 92, FP);
      lab("PTU", x + 113, y + 92, 3.4, COL.wht); lab("RAT MAN ON", x + 215, y + 92, 3, COL.wht); } },
    { h: 104, t: "FUEL", d: (x, y) => {
      [["L TK", 65], ["CTR TK", 165], ["R TK", 265]].forEach(([n, dx]) => lab(n as string, x + (dx as number), y + 14, 3.6, COL.wht));
      [0, 1, 2, 3, 4, 5].forEach((i) => { B(x + 40 + i * 50, y + 34, FP); lab(String(i % 2 + 1), x + 40 + i * 50, y + 54, 3.2); });
      line(ctx, x + 30, y + 62, x + 300, y + 62, "#6f7883", 1);
      B(x + 90, y + 80, { t: "FAULT", b: "AUTO", bc: COL.wht }); lab("MODE SEL", x + 140, y + 80, 3.2);
      B(x + 210, y + 80, { t: "", b: "OPEN", bc: COL.blu }); lab("X FEED", x + 260, y + 80, 3.2); } },
    { h: 108, t: "ELEC", d: (x, y) => {
      ["BAT 1", "BAT 2", "GEN 1", "GEN 2", "APU GEN", "EXT PWR"].forEach((n, i) => { const cx = x + 40 + i * 50; B(cx, y + 32, i === 5 ? { t: "AVAIL", tc: COL.grn, b: "ON", bc: COL.blu } : FP); lab(n, cx, y + 52, 2.8); });
      ["IDG 1", "BUS TIE", "AC ESS FEED", "GALY & CAB", "COMMERCIAL", "IDG 2"].forEach((n, i) => { const cx = x + 40 + i * 50; B(cx, y + 78, i === 0 || i === 5 ? { t: "FAULT", b: "DISC", bc: COL.wht } : i === 1 ? { t: "", b: "ALL", bc: COL.wht } : FP); lab(n, cx, y + 98, 2.6); }); } },
    { h: 108, t: "AIR COND", d: (x, y) => {
      [["COCKPIT", 44], ["FWD CAB", 104], ["AFT CAB", 164]].forEach(([n, dx]) => { const cx = x + (dx as number); K(cx, y + 30, 0, [[-110, "C"], [110, "H"]], 11); lab(n as string, cx, y + 54, 2.8); });
      K(x + 238, y + 30, 0, [[-60, "SHUT"], [0, "AUTO"], [60, "OPEN"]], 10, "X BLEED"); K(x + 296, y + 30, 0, [[-50, "LO"], [0, "NORM"], [50, "HI"]], 9, "FLOW");
      ["PACK 1", "HOT AIR", "PACK 2", "ENG 1 BLEED", "APU BLEED", "ENG 2 BLEED"].forEach((n, i) => { const cx = x + 40 + i * 50; B(cx, y + 76, FP); lab(n, cx, y + 96, 2.6); }); } },
    { h: 64, t: "ANTI ICE", d: (x, y) => {
      ["ENG 1", "WING", "ENG 2"].forEach((n, i) => { const cx = x + 50 + i * 100; B(cx, y + 28, { t: "FAULT", b: "ON", bc: COL.blu }); lab(n, cx, y + 50, 3.2, COL.wht); });
      B(x + 290, y + 28, { t: "", b: "ON", bc: COL.blu }); lab("PROBE/WDW HEAT", x + 285, y + 50, 2.4); } },
    { h: 72, t: "CABIN PRESS", d: (x, y) => {
      B(x + 50, y + 28, { t: "FAULT", b: "MAN", bc: COL.blu }); lab("MODE SEL", x + 50, y + 52, 3);
      K(x + 150, y + 30, 0, [[-90, "-2"], [0, "AUTO"], [90, "14"]], 11, "LDG ELEV");
      tog(x + 250, y + 32, false); lab("UP", x + 250, y + 18, 3); lab("DN", x + 250, y + 46, 3); lab("V/S CTL", x + 290, y + 32, 2.8); } },
    { h: 92, t: "EXT LT", d: (x, y) => {
      [["STROBE", 0], ["BEACON", 1], ["WING", 1], ["NAV & LOGO", 0]].forEach(([n, up], i) => { const cx = x + 40 + i * 82; tog(cx, y + 32, !!up); lab(n as string, cx, y + 16, 3, COL.wht); lab("ON", cx, y + 22, 2.4); lab("OFF", cx, y + 44, 2.4); });
      [["RWY TURN OFF", 1], ["L LAND", 0], ["R LAND", 0], ["NOSE", 0]].forEach(([n, up], i) => { const cx = x + 40 + i * 82; tog(cx, y + 72, !!up); lab(n as string, cx, y + 56, 3, COL.wht); lab("OFF", cx, y + 84, 2.4); }); } },
    { h: 62, t: "APU", d: (x, y) => {
      B(x + 100, y + 26, { t: "FAULT", b: "ON", bc: COL.blu }); lab("MASTER SW", x + 100, y + 50, 3.2, COL.wht);
      B(x + 228, y + 26, { t: "ON", tc: COL.blu, b: "AVAIL", bc: COL.grn }); lab("START", x + 228, y + 50, 3.2, COL.wht); } },
    { h: 62, t: "SIGNS / INT LT", d: (x, y) => [["SEAT BELTS", 0], ["NO SMOKING", 20], ["EMER EXIT LT", 0], ["DOME", -40]].forEach(([n, a], i) => { const cx = x + 40 + i * 82; K(cx, y + 26, a as number, [[-90, ""], [0, ""], [90, ""]], 9); lab(n as string, cx, y + 50, 2.8, COL.wht); }) },
  ]);

  // ---------- right column ----------
  lay(660, 290, [
    { h: 100, t: "FLT CTL", d: (x, y) => {
      ["ELAC 2", "SEC 2", "SEC 3", "FAC 2"].forEach((n, i) => { const cx = x + 38 + i * 71; B(cx, y + 28, FP); lab(n, cx, y + 50, 3.2, COL.wht); });
      B(x + 70, y + 76, { t: "", b: "ON", bc: COL.blu }); lab("GND CTL", x + 130, y + 76, 3.2); } },
    { h: 104, t: "CARGO SMOKE", d: (x, y) => {
      lamp(x + 70, y + 18, 48, 11, "SMOKE", COL.red); lamp(x + 220, y + 18, 48, 11, "SMOKE", COL.red);
      lab("FWD", x + 70, y + 31, 3.4, COL.wht); lab("AFT", x + 220, y + 31, 3.4, COL.wht);
      guard(x + 70, y + 66, 36, 34); B(x + 70, y + 66, { t: "", b: "DISCH", bc: COL.amb, size: 2.6 }); B(x + 150, y + 66, { t: "FAULT", b: "OFF", size: 2.6 });
      lab("ISOL", x + 150, y + 88, 2.8); B(x + 230, y + 66, FP); lab("TEST", x + 230, y + 88, 2.8); } },
    { h: 98, t: "VENTILATION", d: (x, y) => {
      ["BLOWER", "EXTRACT"].forEach((n, i) => { const cx = x + 50 + i * 72; B(cx, y + 30, { t: "FAULT", b: "OVRD", bc: COL.wht, size: 2.6 }); lab(n, cx, y + 52, 3, COL.wht); });
      B(x + 210, y + 30, { t: "", b: "OFF", bc: COL.wht }); lab("CAB FANS", x + 210, y + 52, 3, COL.wht);
      B(x + 50, y + 74, FP); lab("LAV & GALLEY", x + 130, y + 74, 2.8); B(x + 240, y + 74, { t: "", b: "OFF", bc: COL.wht }); } },
    { h: 86, t: "ENG", d: (x, y) => [1, 2].forEach((n, i) => { const cx = x + 70 + i * 150; B(cx, y + 30, { t: "FAULT", b: "ON", bc: COL.blu }); lab(`${n} MAN START`, cx, y + 52, 3, COL.wht); lab(`ENG ${n}`, cx, y + 68, 3, COL.wht); }) },
    { h: 84, t: "WIPER", d: (x, y) => {
      K(x + 60, y + 34, 0, [[-60, "OFF"], [0, "SLOW"], [60, "FAST"]], 11); lab("F/O", x + 60, y + 62, 3.4, COL.wht);
      B(x + 170, y + 30, { t: "", b: "ON", bc: COL.blu }); lab("RAIN RPLNT", x + 170, y + 54, 3);
      B(x + 240, y + 30, { t: "", b: "WASH", bc: COL.wht, size: 2.8 }); lab("WASHER", x + 240, y + 54, 3); } },
    { h: 84, t: "HEADSET / PA", d: (x, y) => { K(x + 60, y + 34, -30, [[-100, ""], [100, ""]], 10, "CAPT"); K(x + 145, y + 34, 20, [[-100, ""], [100, ""]], 10, "F/O"); K(x + 230, y + 34, 60, [[-100, ""], [100, ""]], 10, "OBS"); } },
    { h: 86, t: "ENG / WARN", d: (x, y) => {
      B(x + 60, y + 30, FP); B(x + 145, y + 30, { t: "", b: "TEST", bc: COL.wht }); B(x + 230, y + 30, { t: "", b: "RESET", bc: COL.wht, size: 2.8 });
      lab("ENG FIRE", x + 60, y + 54, 3); lab("LT TEST", x + 145, y + 54, 3); lab("CHIME", x + 230, y + 54, 3); } },
    { h: 100, t: "", d: (x, y, w) => blank(x, y, w, 100, true) },
    { h: 110, t: "", d: (x, y, w) => blank(x, y, w, 110) },
    { h: 100, t: "", d: (x, y, w) => blank(x, y, w, 100) },
  ]);
  [[8, 8], [W - 8, 8], [8, H - 8], [W - 8, H - 8], [W / 2, 6], [W / 2, H - 6]].forEach(([x, y]) => screw(ctx, x, y, 2));
  return S.panel();
}

/* ================================================================== */
/*  Seat fabric (dark blue pinstripe), carpet                          */
/* ================================================================== */
export function seatFabricTex(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = "#1f2b40"; ctx.fillRect(0, 0, 256, 256);
  const r = mulberry(5);
  for (let i = 0; i < 9000; i++) { ctx.fillStyle = `rgba(${r() < 0.5 ? "255,255,255" : "0,0,0"},${r() * 0.07})`; ctx.fillRect(r() * 256, r() * 256, 1.5, 1.5); }
  ctx.strokeStyle = "rgba(120,140,185,0.55)"; ctx.lineWidth = 1.2;
  for (let x = 6; x < 256; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke(); }
  ctx.strokeStyle = "rgba(0,0,0,0.12)"; ctx.lineWidth = 1;
  for (let y = 0; y < 256; y += 3) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
export function carpetTex(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = "#2a3039"; ctx.fillRect(0, 0, 256, 256);
  const r = mulberry(9);
  for (let i = 0; i < 16000; i++) { const v = r(); ctx.fillStyle = v < 0.5 ? `rgba(255,255,255,${r() * 0.08})` : `rgba(0,0,0,${r() * 0.18})`; ctx.fillRect(r() * 256, r() * 256, 2, 2); }
  ctx.strokeStyle = "rgba(0,0,0,0.12)"; ctx.lineWidth = 1;
  for (let x = 0; x < 256; x += 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

/* ================================================================== */
/*  Live atlas: every small self-luminous readout in one 1024^2 canvas  */
/*  (FCU windows, baro windows, ISIS, clock, MCDU/RMP screens, lamps)   */
/* ================================================================== */
interface Rect { x: number; y: number; w: number; h: number }
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
export const LIVE: Record<string, Rect> = {
  spd: R(0, 0, 200, 88), hdg: R(200, 0, 200, 88), alt: R(400, 0, 200, 88), vs: R(600, 0, 200, 88),
  baroL: R(808, 0, 176, 64), baroR: R(808, 72, 176, 64),
  isis: R(0, 144, 320, 320), clock: R(336, 144, 320, 138), rmp1: R(336, 296, 320, 44), rmp2: R(336, 348, 320, 44),
  mcdu1: R(672, 144, 320, 246), mcdu2: R(672, 398, 320, 246),
  lgL: R(0, 480, 84, 108), lgN: R(96, 480, 84, 108), lgR: R(192, 480, 84, 108),
  mwL: R(0, 600, 88, 72), mwR: R(96, 600, 88, 72), mcL: R(192, 600, 88, 72), mcR: R(288, 600, 88, 72),
};
const BARS = ["ap1", "ap2", "athr", "loc", "exped", "appr", "fdL", "lsL", "fdR", "lsR"];
BARS.forEach((n, i) => { LIVE["bar_" + n] = R(i * 40, 700, 32, 12); });
const MONO = "'Consolas','DejaVu Sans Mono','Menlo','Liberation Mono',monospace";

function pad(n: number, w: number, ch = "0") { return String(Math.round(n)).padStart(w, ch); }

export class LiveAtlas {
  c: HTMLCanvasElement; ctx: C2; tex: THREE.CanvasTexture;
  private key: Record<string, string> = {};
  constructor() {
    const { c, ctx } = makeCanvas(1024, 1024);
    this.c = c; this.ctx = ctx;
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 8;
    ctx.textBaseline = "middle";
  }
  private begin(name: string, key: string, opaque: boolean) {
    if (this.key[name] === key) return null;
    this.key[name] = key;
    const r = LIVE[name], ctx = this.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    if (opaque) { ctx.fillStyle = "#020303"; ctx.fillRect(r.x, r.y, r.w, r.h); }
    ctx.translate(r.x, r.y);
    return r;
  }
  private lcd(name: string, txt: string, col: string, sub?: string) {
    const r = this.begin(name, txt + (sub ?? "") + col, true); if (!r) return false;
    const ctx = this.ctx;
    ctx.font = `bold ${r.h * 0.74}px ${MONO}`; ctx.fillStyle = col; ctx.textAlign = "right"; ctx.fillText(txt, r.w - 10, r.h * 0.54);
    if (sub) { ctx.font = `bold ${r.h * 0.22}px ${MONO}`; ctx.textAlign = "left"; ctx.fillText(sub, 8, r.h * 0.2); }
    ctx.restore(); return true;
  }
  private bar(name: string, on: boolean) {
    const r = this.begin(name, on ? "1" : "0", false); if (!r) return false;
    if (on) { this.ctx.fillStyle = "#2cf06a"; this.ctx.fillRect(0, 0, r.w, r.h); }
    this.ctx.restore(); return true;
  }
  /** returns true when any region was redrawn (texture needs an upload) */
  update(t: Telemetry): boolean {
    let ch = false;
    const ctx = this.ctx;
    const AMB = "#ffa21a";
    // FCU
    ch = this.lcd("spd", pad(t.apSpd, 3), AMB, "SPD") || ch;
    ch = this.lcd("hdg", pad(t.apHdg, 3), AMB, "HDG") || ch;
    ch = this.lcd("alt", pad(Math.round(t.apAlt / 100) * 100, 5), AMB, "LVL") || ch;
    ch = this.lcd("vs", "-----", AMB, "V/S") || ch;
    const baro = t.alt > 5500 ? "Std" : "1013";
    ch = this.lcd("baroL", baro, AMB) || ch; ch = this.lcd("baroR", baro, AMB) || ch;
    // lamps / bars
    const ap = t.ap !== "OFF" && t.ap !== "ROLLOUT";
    const bars: [string, boolean][] = [["ap1", ap], ["ap2", false], ["athr", t.athr], ["loc", t.ap === "LOC" || t.ap === "APPR" || t.ap === "FLARE"], ["exped", false], ["appr", t.ap === "APPR" || t.ap === "FLARE"], ["fdL", true], ["lsL", t.ilsValid], ["fdR", true], ["lsR", t.ilsValid]];
    for (const [n, on] of bars) ch = this.bar("bar_" + n, on) || ch;
    const warn = t.stall || (!t.gearDown && t.agl < 230 && !t.onGround && t.vs < 0), caut = t.tailstrike;
    for (const s of ["L", "R"]) {
      let r = this.begin("mw" + s, warn ? "1" : "0", false);
      if (r) { if (warn) { rr(ctx, 2, 2, r.w - 4, r.h - 4, 6); ctx.fillStyle = "#ff2418"; ctx.fill(); ctx.font = `bold 15px Arial, sans-serif`; ctx.fillStyle = "#330000"; ctx.textAlign = "center"; ctx.fillText("MASTER", r.w / 2, 26); ctx.font = `bold 20px Arial, sans-serif`; ctx.fillText("WARN", r.w / 2, 46); } ctx.restore(); ch = true; }
      r = this.begin("mc" + s, caut ? "1" : "0", false);
      if (r) { if (caut) { rr(ctx, 2, 2, r.w - 4, r.h - 4, 6); ctx.fillStyle = "#ffa800"; ctx.fill(); ctx.font = `bold 15px Arial, sans-serif`; ctx.fillStyle = "#3a2400"; ctx.textAlign = "center"; ctx.fillText("MASTER", r.w / 2, 26); ctx.font = `bold 20px Arial, sans-serif`; ctx.fillText("CAUT", r.w / 2, 46); } ctx.restore(); ch = true; }
    }
    // landing gear lamps (triangle geometry mirrors the printed panel, 2 px per mm)
    const gs = t.gear > 0.99 ? 2 : t.gear < 0.01 ? 0 : 1;
    for (const n of ["lgL", "lgN", "lgR"]) {
      const r = this.begin(n, String(gs), false); if (!r) continue;
      if (gs === 2) { ctx.fillStyle = "#2cf06a"; ctx.beginPath(); ctx.moveTo(22, 42); ctx.lineTo(62, 42); ctx.lineTo(42, 78); ctx.closePath(); ctx.fill(); }
      if (gs === 1) { ctx.fillStyle = "#ff2a24"; ctx.font = `bold 17px Arial, sans-serif`; ctx.textAlign = "center"; ctx.fillText("UNLK", 42, 18); }
      ctx.restore(); ch = true;
    }
    ch = this.clock(t) || ch;
    ch = this.isis(t) || ch;
    ch = this.rmp() || ch;
    ch = this.mcdu1(t) || ch;
    ch = this.mcdu2(t) || ch;
    if (ch) this.tex.needsUpdate = true;
    return ch;
  }
  private clock(t: Telemetry) {
    const tm = new Date(t.time);
    const hh = pad(tm.getUTCHours(), 2), mm = pad(tm.getUTCMinutes(), 2), ss = pad(tm.getUTCSeconds() - (tm.getUTCSeconds() % 2), 2);
    const r = this.begin("clock", hh + mm + ss, true); if (!r) return false;
    const ctx = this.ctx;
    ctx.font = `bold 62px ${MONO}`; ctx.fillStyle = "#3cf070"; ctx.textAlign = "center"; ctx.fillText(`${hh}:${mm}`, r.w * 0.44, 52);
    ctx.font = `bold 34px ${MONO}`; ctx.fillText(ss, r.w * 0.9, 62);
    ctx.font = `bold 22px ${MONO}`; ctx.fillStyle = "#e8e8e8"; ctx.textAlign = "left"; ctx.fillText("UTC", 8, 112); ctx.fillText("ET 0:00", 140, 112); ctx.fillStyle = "#3cf070"; ctx.fillText("GPS", 8, 14);
    ctx.restore(); return true;
  }
  private isis(t: Telemetry) {
    const key = `${Math.round(t.ias)}|${Math.round(t.alt / 10)}|${Math.round(t.pitch * 2)}|${Math.round(t.bank)}`;
    const r = this.begin("isis", key, true); if (!r) return false;
    const ctx = this.ctx, cx = 160, cy = 168, k = 6.2;
    ctx.save(); ctx.beginPath(); ctx.rect(4, 4, 312, 312); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-t.bank * Math.PI / 180);
    const off = t.pitch * k;
    ctx.fillStyle = "#1a78d8"; ctx.fillRect(-400, -800 + off, 800, 800);
    ctx.fillStyle = "#7a4a24"; ctx.fillRect(-400, off, 800, 800);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-400, off); ctx.lineTo(400, off); ctx.stroke();
    ctx.lineWidth = 2; ctx.font = `bold 18px ${MONO}`; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    for (let p = -20; p <= 20; p += 5) { if (!p) continue; const y = off - p * k * 1.6, w = p % 10 ? 26 : 50; ctx.beginPath(); ctx.moveTo(-w / 2, y); ctx.lineTo(w / 2, y); ctx.stroke(); if (!(p % 10)) { ctx.fillText(String(Math.abs(p)), -w / 2 - 16, y); ctx.fillText(String(Math.abs(p)), w / 2 + 16, y); } }
    ctx.restore();
    ctx.strokeStyle = "#ffe000"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(cx - 70, cy); ctx.lineTo(cx - 24, cy); ctx.lineTo(cx - 24, cy + 12); ctx.moveTo(cx + 70, cy); ctx.lineTo(cx + 24, cy); ctx.lineTo(cx + 24, cy + 12); ctx.stroke();
    ctx.fillStyle = "#ffe000"; ctx.fillRect(cx - 4, cy - 4, 8, 8);
    // tapes
    ctx.fillStyle = "rgba(20,22,26,0.88)"; ctx.fillRect(6, 40, 62, 256); ctx.fillRect(252, 40, 62, 256);
    ctx.font = `bold 20px ${MONO}`; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(pad(t.ias, 3), 37, 168); ctx.strokeStyle = "#ffe000"; ctx.lineWidth = 2; ctx.strokeRect(8, 152, 58, 32);
    ctx.fillText(String(Math.round(t.alt / 10) * 10), 283, 168); ctx.strokeRect(254, 152, 58, 32);
    ctx.font = `bold 15px ${MONO}`; ctx.fillStyle = "#1ec8ff"; ctx.fillText("1013", 283, 300); ctx.fillStyle = "#fff"; ctx.fillText("KT", 37, 54); ctx.fillText("FT", 283, 54);
    ctx.restore(); return true;
  }
  private rmp() {
    const a = this.begin("rmp1", "a", true); if (a) { this.lcd2(a, "118.300", "121.500"); }
    const b = this.begin("rmp2", "b", true); if (b) { this.lcd2(b, "118.300", "121.800"); }
    return !!(a || b);
  }
  private lcd2(r: Rect, act: string, stby: string) {
    const ctx = this.ctx;
    ctx.font = `bold 34px ${MONO}`; ctx.fillStyle = "#ffa21a"; ctx.textAlign = "left"; ctx.fillText(act, 10, r.h / 2);
    ctx.textAlign = "right"; ctx.fillText(stby, r.w - 10, r.h / 2);
    ctx.restore();
  }
  private mcRows(r: Rect, rows: [string, string, string, number][], title: string, page: string) {
    const ctx = this.ctx, cw = r.w / 24, rh = r.h / 14;
    ctx.fillStyle = "#050707"; ctx.fillRect(0, 0, r.w, r.h);
    ctx.font = `bold ${rh * 0.86}px ${MONO}`; ctx.textAlign = "center"; ctx.fillStyle = "#f2f2f2"; ctx.fillText(title, r.w / 2, rh * 0.6);
    ctx.textAlign = "right"; ctx.fillText(page, r.w - 4, rh * 0.6);
    for (const [txt, col, al, row] of rows) {
      const big = row % 2 === 0;
      ctx.font = `bold ${rh * (big ? 0.92 : 0.62)}px ${MONO}`; ctx.fillStyle = col;
      ctx.textAlign = al === "l" ? "left" : al === "r" ? "right" : "center";
      ctx.fillText(txt, al === "l" ? cw * 0.8 : al === "r" ? r.w - cw * 0.8 : r.w / 2, row * rh + rh * (big ? 0.55 : 0.4) + rh * 0.4);
    }
    ctx.restore();
  }
  private mcdu1(t: Telemetry) {
    const dist = pad(t.distNm, 3, " ").trim();
    const r = this.begin("mcdu1", dist + (t.onGround ? "g" : "a"), true); if (!r) return false;
    const GRN = "#3cf070", WHT = "#f2f2f2", CYN = "#35c8ff", MAG = "#ff60e8";
    const toD = Math.max(0, t.distNm);
    const eta = (n: number) => { const tm = new Date(t.time + (n / Math.max(120, t.gs)) * 3600e3); return `${pad(tm.getUTCHours(), 2)}${pad(tm.getUTCMinutes(), 2)}`; };
    const rows: [string, string, string, number][] = [
      ["FROM", CYN, "l", 1], ["EAUR09", WHT, "l", 2], ["TIME", CYN, "r", 1], ["----", WHT, "r", 2],
      ["AURA1", GRN, "l", 4], ["240/FL100", GRN, "r", 4],
      ["BAYVU", GRN, "l", 6], ["260/FL240", GRN, "r", 6],
      ["FAF09", MAG, "l", 8], [`${eta(toD - 7)}`, MAG, "r", 8], ["180/2400", MAG, "r", 9],
      ["EBVR09", WHT, "l", 10], [`${eta(toD)}`, WHT, "r", 10], ["140/----", WHT, "r", 11],
      ["DEST", CYN, "l", 11], [`${dist}NM  EBVR`, WHT, "l", 12],
    ];
    this.mcRows(r, rows, "F-PLN", "1/2");
    return true;
  }
  private mcdu2(t: Telemetry) {
    const ph = t.onGround && t.gs < 60 ? "TO" : t.gear > 0.5 || t.agl < 4000 ? "APPR" : "CRZ";
    const r = this.begin("mcdu2", ph, true); if (!r) return false;
    const GRN = "#3cf070", WHT = "#f2f2f2", CYN = "#35c8ff", AMB = "#ffa21a";
    let rows: [string, string, string, number][];
    if (ph === "TO") rows = [["V1", CYN, "l", 1], ["138", GRN, "l", 2], ["VR", CYN, "c", 1], ["140", GRN, "c", 2], ["V2", CYN, "r", 1], ["145", GRN, "r", 2],
      ["TRANS ALT", CYN, "l", 3], ["5000", GRN, "l", 4], ["THR RED/ACC", CYN, "r", 3], ["1500/1500", GRN, "r", 4],
      ["FLAPS/THS", CYN, "l", 5], ["1/UP0.5", GRN, "l", 6], ["FLEX TO TEMP", CYN, "r", 5], ["55^", GRN, "r", 6],
      ["RWY", CYN, "l", 7], ["09", GRN, "l", 8], ["ENG OUT ACC", CYN, "r", 7], ["1500", GRN, "r", 8], ["PHASE", AMB, "l", 12]];
    else if (ph === "APPR") rows = [["QNH", CYN, "l", 1], ["1013", GRN, "l", 2], ["TEMP", CYN, "r", 1], ["+10^", GRN, "r", 2],
      ["MAG WIND", CYN, "l", 3], ["090/08", GRN, "l", 4], ["TRANS ALT", CYN, "r", 3], ["5000", GRN, "r", 4],
      ["FINAL", CYN, "l", 5], ["ILS09", GRN, "l", 6], ["LDG CONF", CYN, "r", 5], ["CONF FULL", GRN, "r", 6],
      ["VAPP", CYN, "l", 7], [pad(t.apSpd, 3), GRN, "l", 8], ["MINIMUM", CYN, "r", 7], ["BARO 200", GRN, "r", 8]];
    else rows = [["CRZ", CYN, "l", 1], ["FL240", GRN, "l", 2], ["OPT", CYN, "r", 1], ["FL380", GRN, "r", 2], ["CI", CYN, "l", 3], ["35", GRN, "l", 4], ["RECMD MAX", CYN, "r", 3], ["FL391", GRN, "r", 4]];
    this.mcRows(r, rows, ph === "TO" ? "TAKE OFF" : ph === "APPR" ? "APPROACH" : "CRUISE", "1/1");
    void WHT;
    return true;
  }
}

// @@NEXT
