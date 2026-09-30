import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { fuselageSection } from "./fuselage";
import { lerp } from "./noise";
import type { VisualState } from "./aircraft";
import type { Telemetry } from "./instruments";
import * as TX from "./cockpitTextures";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export type ScreenId = "pfd" | "nd" | "ewd" | "sd";

export interface HotInfo { id: string; label: string; kind: TX.HotSpot["kind"] | "lever" }
export interface CockpitControls {
  /** raycast targets (userData.hot: HotInfo) */
  pickables: THREE.Object3D[];
  /** lit legend / toggle position */
  set: (id: string, on: boolean) => void;
  /** hover outline (null clears) */
  hover: (obj: THREE.Object3D | null) => void;
}

export interface CockpitRig {
  group: THREE.Group;
  controls: CockpitControls;
  screens: {
    pfd: HTMLCanvasElement; nd: HTMLCanvasElement; ewd: HTMLCanvasElement; sd: HTMLCanvasElement;
    /** mark display textures for upload after their canvases were redrawn (default: all) */
    refresh: (which?: ScreenId[]) => void;
    /** low-rate (~2 Hz) live values for glareshield / pedestal readouts (FCU windows, ISIS, clock, etc.) */
    panel: (t: Telemetry) => void;
  };
  update: (s: VisualState, dt: number) => void;
}

/* ------------------------------------------------------------------ */
/*  Inner lining helpers (superellipse upper half, ellipse lower half) */
/* ------------------------------------------------------------------ */
function wallHalf(z: number, y: number, off = 0.055): number {
  const s = fuselageSection(z), rw = s.rw - off, rh = s.rh - off, r = (y - s.cy) / rh;
  if (r >= 1) return 0;
  if (r >= 0) { const e = 2 / s.n, cs = Math.pow(r, 1 / e), sn = Math.sqrt(1 - cs * cs); return rw * Math.pow(sn, e); }
  return rw * Math.sqrt(1 - r * r);
}
function roofY(z: number, x: number, off = 0.055): number {
  const s = fuselageSection(z), rw = s.rw - off, rh = s.rh - off, e = 2 / s.n;
  const sn = Math.pow(Math.min(1, Math.abs(x) / rw), 1 / e);
  return s.cy + rh * Math.pow(Math.sqrt(1 - sn * sn), e);
}

/* ------------------------------------------------------------------ */
/*  Geometry accumulator (world space, optional uv / vertex colour)    */
/* ------------------------------------------------------------------ */
type UVFn = (p: THREE.Vector3, n: THREE.Vector3) => [number, number];
const tv = V(), tn = V(), tm3 = new THREE.Matrix3();
const UBOX = new THREE.BoxGeometry(1, 1, 1);
const UCYL = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
const UCYL8 = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
const USPH = new THREE.SphereGeometry(1, 14, 10);
const mx = (p: [number, number, number] = [0, 0, 0], r: [number, number, number] = [0, 0, 0], s: [number, number, number] = [1, 1, 1], order: THREE.EulerOrder = "XYZ") =>
  new THREE.Matrix4().compose(V(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], order)), V(...s));

class Mesher {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  constructor(public withUV = false, public withCol = false) {}
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, color?: THREE.ColorRepresentation, uvFn?: UVFn) {
    const base = this.pos.length / 3, p = g.attributes.position, nn = g.attributes.normal, gu = g.attributes.uv;
    tm3.getNormalMatrix(m);
    const c = color !== undefined ? new THREE.Color(color) : null;
    for (let i = 0; i < p.count; i++) {
      tv.fromBufferAttribute(p, i).applyMatrix4(m); tn.fromBufferAttribute(nn, i).applyMatrix3(tm3).normalize();
      this.pos.push(tv.x, tv.y, tv.z); this.nor.push(tn.x, tn.y, tn.z);
      if (this.withUV) { if (uvFn) { const t = uvFn(tv, tn); this.uv.push(t[0], t[1]); } else if (gu) this.uv.push(gu.getX(i), gu.getY(i)); else this.uv.push(0, 0); }
      if (this.withCol) this.col.push(c ? c.r : 1, c ? c.g : 1, c ? c.b : 1);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }
  box(c: [number, number, number], s: [number, number, number], color?: THREE.ColorRepresentation, r: [number, number, number] = [0, 0, 0], uvFn?: UVFn) {
    this.add(UBOX, mx(c, r, s), color, uvFn);
  }
  cyl(c: [number, number, number], rad: number, h: number, color?: THREE.ColorRepresentation, axis: "x" | "y" | "z" = "y", rad2 = rad, lo = false, uvFn?: UVFn) {
    const g = rad2 === rad ? (lo ? UCYL8 : UCYL) : new THREE.CylinderGeometry(rad2, rad, 1, lo ? 10 : 16, 1);
    const r: [number, number, number] = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    this.add(g, mx(c, r, rad2 === rad ? [rad, h, rad] : [1, h, 1]), color, uvFn);
  }
  sph(c: [number, number, number], s: [number, number, number], color?: THREE.ColorRepresentation, r: [number, number, number] = [0, 0, 0]) { this.add(USPH, mx(c, r, s), color); }
  rbox(c: [number, number, number], s: [number, number, number], rad: number, color?: THREE.ColorRepresentation, r: [number, number, number] = [0, 0, 0], uvFn?: UVFn, seg = 2) {
    this.add(new RoundedBoxGeometry(s[0], s[1], s[2], seg, rad), mx(c, r), color, uvFn);
  }
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color?: THREE.ColorRepresentation, toward?: THREE.Vector3) {
    // a,b,c,d ccw; flips when `toward` (a direction) says the front faces away
    const n = V().subVectors(b, a).cross(V().subVectors(d, a)).normalize();
    const pts = toward && n.dot(toward) < 0 ? [a, d, c, b] : [a, b, c, d];
    const nn = toward && n.dot(toward) < 0 ? n.negate() : n;
    const col = color !== undefined ? new THREE.Color(color) : null, base = this.pos.length / 3;
    for (const p of pts) { this.pos.push(p.x, p.y, p.z); this.nor.push(nn.x, nn.y, nn.z); if (this.withUV) this.uv.push(0, 0); if (this.withCol) this.col.push(col ? col.r : 1, col ? col.g : 1, col ? col.b : 1); }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color?: THREE.ColorRepresentation, toward?: THREE.Vector3) {
    const n = V().subVectors(b, a).cross(V().subVectors(c, a)).normalize();
    const flip = toward ? n.dot(toward) < 0 : false;
    const pts = flip ? [a, c, b] : [a, b, c], nn = flip ? n.negate() : n;
    const col = color !== undefined ? new THREE.Color(color) : null, base = this.pos.length / 3;
    for (const p of pts) { this.pos.push(p.x, p.y, p.z); this.nor.push(nn.x, nn.y, nn.z); if (this.withUV) this.uv.push(0, 0); if (this.withCol) this.col.push(col ? col.r : 1, col ? col.g : 1, col ? col.b : 1); }
    this.idx.push(base, base + 1, base + 2);
  }
  /** surface grid; rows = [{ty, a, b}] with the tx range per row */
  grid(S: Surf, rows: { ty: number; a: number; b: number }[], nu: number) {
    const base = this.pos.length / 3;
    rows.forEach((r) => {
      for (let i = 0; i <= nu; i++) {
        const tx = lerp(r.a, r.b, i / nu), p = S.pt(tx, r.ty), n = S.n(tx, r.ty);
        this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
        if (this.withUV) this.uv.push(tx / S.W, 1 - r.ty / S.H);
        if (this.withCol) this.col.push(1, 1, 1);
      }
    });
    for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      // order so that the geometric normal matches S.n
      const pa = V(this.pos[a * 3], this.pos[a * 3 + 1], this.pos[a * 3 + 2]), pb = V(this.pos[b * 3], this.pos[b * 3 + 1], this.pos[b * 3 + 2]), pc = V(this.pos[c * 3], this.pos[c * 3 + 1], this.pos[c * 3 + 2]);
      const gn = V().subVectors(pb, pa).cross(V().subVectors(pc, pa));
      const want = V(this.nor[a * 3], this.nor[a * 3 + 1], this.nor[a * 3 + 2]);
      if (gn.dot(want) >= 0) this.idx.push(a, b, c, b, d, c); else this.idx.push(a, c, b, b, c, d);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    if (this.withUV) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.withCol) g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  get tris() { return this.idx.length / 3; }
}

/** parametric surface in panel millimetres (tx right, ty down from the top-left) */
class Surf {
  sgn = 1;
  constructor(public W: number, public H: number, public pt: (tx: number, ty: number) => THREE.Vector3, toward: THREE.Vector3) {
    const c = this.raw(W / 2, H / 2);
    this.sgn = c.dot(V().subVectors(toward, pt(W / 2, H / 2))) >= 0 ? 1 : -1;
  }
  private raw(tx: number, ty: number) {
    const e = 1, a = this.pt(tx - e, ty), b = this.pt(tx + e, ty), c = this.pt(tx, ty - e), d = this.pt(tx, ty + e);
    return V().subVectors(b, a).cross(V().subVectors(d, c)).normalize();
  }
  n(tx: number, ty: number) { return this.raw(tx, ty).multiplyScalar(this.sgn); }
}
const EYE_REF = V(-0.53, 0.93, -15.58);
function rectSurf(M: THREE.Matrix4, W: number, H: number, toward = EYE_REF) {
  return new Surf(W, H, (tx, ty) => V((tx - W / 2) / 1000, (H / 2 - ty) / 1000, 0).applyMatrix4(M), toward);
}

/** add the 3D keycaps / knobs / bezels recorded by a panel drawing, with planar UVs from the panel art */
function addParts(mh: Mesher, S: Surf, parts: TX.Part[]) {
  const o = V(), eu = V(), ev = V(), en = V(), ex = V();
  for (const p of parts) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    o.copy(S.pt(cx, cy));
    eu.subVectors(S.pt(cx + 1, cy), o).normalize();
    ev.subVectors(S.pt(cx, cy - 1), o).normalize();
    en.copy(S.n(cx, cy));
    ex.crossVectors(ev, en).normalize(); ev.crossVectors(en, ex).normalize();
    const M = new THREE.Matrix4().makeBasis(ex, ev, en).setPosition(o);
    const oo = o.clone(), eu2 = eu.clone(), ev2 = ev.clone();
    const uvFn: UVFn = (q) => { const d = V().subVectors(q, oo); return [(cx + d.dot(eu2) * 1000) / S.W, 1 - (cy - d.dot(ev2) * 1000) / S.H]; };
    const d = p.d / 1000;
    if (p.k === "box") mh.add(UBOX, M.clone().multiply(mx([0, 0, d / 2 - 0.0004], [0, 0, 0], [p.w / 1000, p.h / 1000, d + 0.0008])), undefined, uvFn);
    else if (p.k === "cyl") mh.add(UCYL, M.clone().multiply(mx([0, 0, d / 2 - 0.0004], [Math.PI / 2, 0, 0], [p.w / 2000, d + 0.0008, p.h / 2000])), undefined, uvFn);
    else mh.add(UCYL8, M.clone().multiply(mx([0, 0, d / 2], [Math.PI / 2, 0, 0], [p.w / 2000 * 0.55, d, p.h / 2000 * 0.55])), undefined, uvFn);
  }
}

/** clickable controls: invisible pick boxes, moving toggle levers and lit-legend overlays */
class HotBuilder {
  pickables: THREE.Object3D[] = [];
  toggles = new Map<string, { piv: THREE.Group; up: boolean }>();
  leds: { id: string; M: THREE.Matrix4; col: string }[] = [];
  pickMat = new THREE.MeshBasicMaterial({ visible: false });
  batG: THREE.BufferGeometry;
  constructor(public group: THREE.Group, public batMat: THREE.Material) {
    const m = new Mesher(false, true);
    m.cyl([0, 0.0065, 0], 0.0016, 0.013, "#c9ced4", "y", 0.0022);
    m.sph([0, 0.0135, 0], [0.0032, 0.0032, 0.0032], "#e3e6ea");
    m.cyl([0, 0.0005, 0], 0.0042, 0.002, "#8e949c", "y");
    this.batG = m.geometry();
  }
  basis(S: Surf, cx: number, cy: number) {
    const o = S.pt(cx, cy), eu = V().subVectors(S.pt(cx + 1, cy), o).normalize(), ev = V().subVectors(S.pt(cx, cy - 1), o).normalize(), en = S.n(cx, cy);
    const ex = V().crossVectors(ev, en).normalize(); ev.crossVectors(en, ex).normalize();
    void eu;
    return new THREE.Matrix4().makeBasis(ex, ev, en).setPosition(o);
  }
  add(S: Surf, list: TX.HotSpot[]) {
    for (const h of list) {
      const M = this.basis(S, h.x + h.w / 2, h.y + h.h / 2);
      const info: HotInfo = { id: h.id, label: h.label, kind: h.kind };
      const pick = new THREE.Mesh(UBOX, this.pickMat);
      M.clone().multiply(mx([0, 0, 0.006], [0, 0, 0], [h.w / 1000, h.h / 1000, 0.016])).decompose(pick.position, pick.quaternion, pick.scale);
      pick.userData.hot = info; pick.userData.rect = [h.w / 1000, h.h / 1000];
      this.group.add(pick); this.pickables.push(pick);
      if (h.kind === "toggle") {
        const piv = new THREE.Group(); M.decompose(piv.position, piv.quaternion, piv.scale);
        const bat = new THREE.Mesh(this.batG, this.batMat); bat.rotation.x = Math.PI / 2; // lever stands off the panel along its normal
        const tilt = new THREE.Group(); tilt.add(bat); piv.add(tilt);
        this.group.add(piv);
        this.toggles.set(h.id, { piv: tilt, up: !!h.up });
        tilt.rotation.x = h.up ? -0.5 : 0.5;
      }
      if (h.led) {
        const l = h.led, L = this.basis(S, l.x + l.w / 2, l.y + l.h / 2);
        this.leds.push({ id: h.id, M: L.multiply(mx([0, 0, 0.00455], [0, 0, 0], [l.w / 1000, l.h / 1000, 1])), col: l.col });
      }
    }
  }
}

/** emissive (integral lighting) from the panel art itself: bright pixels glow, dark body only faintly */
function glowMat(map: THREE.Texture, flood: number, rough = 0.82) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: 0, emissive: "#ffffff", emissiveIntensity: 0.2 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFlood = { value: flood };
    sh.fragmentShader = "uniform float uFlood;\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>",
      `#ifdef USE_MAP
        float gLum = max(sampledDiffuseColor.r, max(sampledDiffuseColor.g, sampledDiffuseColor.b));
        float gMk = smoothstep(0.2, 0.4, gLum);
        totalEmissiveRadiance *= sampledDiffuseColor.rgb * (gMk + uFlood * (1.0 - gMk));
      #endif`);
  };
  m.customProgramCacheKey = () => "cockpitGlow";
  return m;
}

const C = { body: "#4a5563", trim: "#5f6a79", char: "#26282c", charL: "#34373c", blk: "#0c0d0f", grey: "#8b939c", steel: "#a2a8b0", leather: "#1a1e29", navy: "#1c2638", red: "#c0181a", yel: "#e0c020", door: "#66707b" };

/** Flight deck interior (everything inside the pressure shell except the window frames / lining). Body frame: nose -Z, up +Y, right +X. */
export function buildCockpit(): CockpitRig {
  const group = new THREE.Group();
  const FLOOR = -0.4;

  /* ---------------- materials ---------------- */
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05 });
  const satin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.85 });
  const carpetT = TX.carpetTex(); carpetT.repeat.set(2.5, 2.5);
  const carpet = new THREE.MeshStandardMaterial({ map: carpetT, roughness: 0.98 });
  const fabricT = TX.seatFabricTex();
  const fabric = new THREE.MeshStandardMaterial({ map: fabricT, roughness: 0.92, metalness: 0 });
  const glow: THREE.MeshStandardMaterial[] = [];
  const gm = (map: THREE.Texture, flood = 0) => { const m = glowMat(map, flood); glow.push(m); return m; };
  const liveAtlas = new TX.LiveAtlas();
  const liveMat = new THREE.MeshBasicMaterial({ map: liveAtlas.tex, alphaTest: 0.5, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mkScreen = () => { const c = document.createElement("canvas"); c.width = 512; c.height = 512; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return { c, t, m: new THREE.MeshBasicMaterial({ map: t, toneMapped: false }) }; };
  const S_PFD = mkScreen(), S_ND = mkScreen(), S_EWD = mkScreen(), S_SD = mkScreen();
  S_PFD.c.getContext("2d")!.fillStyle = "#000";

  const HB = new HotBuilder(group, satin);
  const MT = new Mesher(false, true);   // static matte parts (vertex colours)
  const SA = new Mesher(false, true);   // static satin parts
  const FB = new Mesher(true, false);   // seat fabric
  const LV = new Mesher(true, false);   // live atlas quads
  const duM: Record<string, Mesher> = { pfd: new Mesher(true), nd: new Mesher(true), ewd: new Mesher(true), sd: new Mesher(true) };
  const addMesh = (mh: Mesher, mat: THREE.Material) => { const m = new THREE.Mesh(mh.geometry(), mat); group.add(m); return m; };
  const frameObj = (M: THREE.Matrix4) => { const o = new THREE.Group(); M.decompose(o.position, o.quaternion, o.scale); group.add(o); return o; };

  /* ---------------- floor, bulkhead, door ---------------- */
  {
    const sh = new THREE.Shape();
    const zs: number[] = []; for (let z = -17.4; z <= -11.96; z += 0.12) zs.push(z);
    const hw = (z: number) => Math.max(0.05, wallHalf(z, FLOOR) - 0.015);
    sh.moveTo(hw(zs[0]), zs[0]);
    zs.forEach((z) => sh.lineTo(hw(z), z));
    zs.slice().reverse().forEach((z) => sh.lineTo(-hw(z), z));
    const fg = new THREE.ShapeGeometry(sh); fg.rotateX(Math.PI / 2); fg.translate(0, FLOOR, 0);
    // rotateX(+90deg) maps shape-y to +z and flips the face to point down: flip back
    const pos = fg.attributes.position, idx = fg.index!;
    for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); }
    void pos; fg.computeVertexNormals();
    group.add(new THREE.Mesh(fg, carpet));
  }
  {
    const bz = -11.95;
    const bh = new THREE.CircleGeometry(1.93, 48); bh.rotateY(Math.PI);
    MT.add(bh, mx([0, 0, bz]), "#8f969e");
    MT.box([0, 0.52, bz - 0.03], [0.82, 1.86, 0.06], C.door);
    MT.box([0, 0.52, bz - 0.062], [0.70, 1.74, 0.01], "#5b646e");
    MT.box([0.27, 0.42, bz - 0.075], [0.03, 0.10, 0.03], C.steel);           // handle
    MT.box([-0.27, 0.42, bz - 0.07], [0.06, 0.10, 0.02], C.blk);              // keypad
    MT.cyl([0, 0.98, bz - 0.07], 0.012, 0.02, C.blk, "z");                  // peephole
    MT.box([0, FLOOR + 0.03, bz - 0.02], [1.6, 0.06, 0.04], C.charL);
  }

  /* ---------------- main instrument panel ---------------- */
  const TILT = 15 * Math.PI / 180, YAW = 12 * Math.PI / 180;
  const MIPTOP = { y: 0.665, z: -16.31 }, XC = 0.27;
  const qTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-TILT, 0, 0));
  const hC = TX.MIP.H / 1000;
  const cenC = V(0, MIPTOP.y - (hC / 2) * Math.cos(TILT), MIPTOP.z + (hC / 2) * Math.sin(TILT));
  const faceM = (centre: THREE.Vector3, yaw: number) => new THREE.Matrix4().compose(centre, qTilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw)), V(1, 1, 1));
  const sideCentre = (side: -1 | 1) => {
    const q = qTilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), -side * YAW));
    const inner = V(side * XC, cenC.y, cenC.z);
    return inner.add(V(side * TX.MIP.W / 2000, 0, 0).applyQuaternion(q));   // outward from the inner edge
  };
  const mipCentreP = TX.mipCentre(), mipCapP = TX.mipSide(-1), mipFoP = TX.mipSide(1);
  const Mc = faceM(cenC, 0), Ml = faceM(sideCentre(-1), YAW), Mr = faceM(sideCentre(1), -YAW);
  const surfC = rectSurf(Mc, TX.MIP.WC, TX.MIP.H), surfL = rectSurf(Ml, TX.MIP.W, TX.MIP.H), surfR = rectSurf(Mr, TX.MIP.W, TX.MIP.H);
  const mipMesh = (p: TX.Panel, S: Surf) => {
    const mh = new Mesher(true);
    mh.grid(S, [{ ty: 0, a: 0, b: S.W }, { ty: S.H, a: 0, b: S.W }], 1);
    addParts(mh, S, p.parts);
    return addMesh(mh, gm(TX.faceTex(p.face)));
  };
  mipMesh(mipCentreP, surfC); mipMesh(mipCapP, surfL); mipMesh(mipFoP, surfR);
  // bottom edge corners (for kick panel / footwell) and end caps
  const edgePts = (M: THREE.Matrix4, W: number, H: number) => ({
    tl: V(-W / 2000, H / 2000, 0).applyMatrix4(M), tr: V(W / 2000, H / 2000, 0).applyMatrix4(M),
    bl: V(-W / 2000, -H / 2000, 0).applyMatrix4(M), br: V(W / 2000, -H / 2000, 0).applyMatrix4(M),
  });
  const eC = edgePts(Mc, TX.MIP.WC, TX.MIP.H), eL = edgePts(Ml, TX.MIP.W, TX.MIP.H), eR = edgePts(Mr, TX.MIP.W, TX.MIP.H);
  const botY = eC.bl.y;
  const BACKZ = -16.52;
  {
    const dark = "#16181b", up = V(0, 1, 0);
    // footwell ceiling (knee shelf), back wall, side walls
    const pts: [number, number][] = [[eL.bl.x, eL.bl.z], [eL.br.x, eL.br.z], [eC.bl.x, eC.bl.z], [eC.br.x, eC.br.z], [eR.bl.x, eR.bl.z], [eR.br.x, eR.br.z]];
    const pl = [...pts, [eR.br.x, BACKZ] as [number, number], [eL.bl.x, BACKZ] as [number, number]];
    const cy = botY - 0.002;
    // ceiling as a fan (points are convex enough)
    const c0 = V(0, cy, (eC.bl.z + BACKZ) / 2);
    for (let i = 0; i < pl.length; i++) { const a = pl[i], b = pl[(i + 1) % pl.length]; MT.tri(c0, V(a[0], cy, a[1]), V(b[0], cy, b[1]), dark, V(0, -1, 0)); }
    MT.quad(V(eL.bl.x, FLOOR, BACKZ), V(eR.br.x, FLOOR, BACKZ), V(eR.br.x, cy, BACKZ), V(eL.bl.x, cy, BACKZ), "#0f1012", V(0, 0, 1));
    MT.quad(V(eL.bl.x, FLOOR, BACKZ), V(eL.bl.x, cy, BACKZ), V(eL.bl.x, cy, eL.bl.z), V(eL.bl.x, FLOOR, eL.bl.z), "#111316", V(1, 0, 0));
    MT.quad(V(eR.br.x, FLOOR, BACKZ), V(eR.br.x, cy, BACKZ), V(eR.br.x, cy, eR.br.z), V(eR.br.x, FLOOR, eR.br.z), "#111316", V(-1, 0, 0));
    // panel end caps (outer) and top/bottom returns
    MT.quad(eL.tl, eL.bl, V(eL.bl.x, eL.bl.y, eL.bl.z - 0.2), V(eL.tl.x, eL.tl.y, eL.tl.z - 0.2), C.char, V(1, 0, 0.3));
    MT.quad(eR.tr, eR.br, V(eR.br.x, eR.br.y, eR.br.z - 0.2), V(eR.tr.x, eR.tr.y, eR.tr.z - 0.2), C.char, V(-1, 0, 0.3));
    void up;
    // front face of the knee shelf (visible lower lip of the panel)
    for (const [a, b] of [[eL.bl, eL.br], [eC.bl, eC.br], [eR.bl, eR.br]] as [THREE.Vector3, THREE.Vector3][]) MT.quad(a, b, V(b.x, b.y - 0.03, b.z - 0.0), V(a.x, a.y - 0.03, a.z - 0.0), C.charL, V(0, 0, 1));
  }
  // DU screens (quads on the bezels)
  const screenQuad = (mh: Mesher, S: Surf, a: TX.Anchor) => {
    const P = (tx: number, ty: number) => S.pt(tx, ty).addScaledVector(S.n(tx, ty), a.d / 1000);
    const p00 = P(a.x, a.y), p10 = P(a.x + a.w, a.y), p11 = P(a.x + a.w, a.y + a.h), p01 = P(a.x, a.y + a.h);
    const base = mh.pos.length / 3, n = S.n(a.x, a.y);
    for (const [p, u, v] of [[p00, 0, 1], [p10, 1, 1], [p11, 1, 0], [p01, 0, 0]] as [THREE.Vector3, number, number][]) { mh.pos.push(p.x, p.y, p.z); mh.nor.push(n.x, n.y, n.z); mh.uv.push(u, v); }
    mh.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  screenQuad(duM.pfd, surfL, mipCapP.anchors.pfd); screenQuad(duM.pfd, surfR, mipFoP.anchors.pfd);
  screenQuad(duM.nd, surfL, mipCapP.anchors.nd); screenQuad(duM.nd, surfR, mipFoP.anchors.nd);
  screenQuad(duM.ewd, surfC, mipCentreP.anchors.ewd); screenQuad(duM.sd, surfC, mipCentreP.anchors.sd);
  addMesh(duM.pfd, S_PFD.m); addMesh(duM.nd, S_ND.m); addMesh(duM.ewd, S_EWD.m); addMesh(duM.sd, S_SD.m);
  // live overlays on the MIP
  const liveQuad = (S: Surf, a: TX.Anchor, region: string, flipV = false) => {
    const r = TX.LIVE[region];
    const P = (tx: number, ty: number) => S.pt(tx, ty).addScaledVector(S.n(tx, ty), a.d / 1000);
    const base = LV.pos.length / 3, n = S.n(a.x, a.y);
    const U = (f: number) => (r.x + f * r.w) / 1024, Vv = (f: number) => 1 - (r.y + (flipV ? 1 - f : f) * r.h) / 1024;
    for (const [tx, ty, fu, fv] of [[a.x, a.y, 0, 0], [a.x + a.w, a.y, 1, 0], [a.x + a.w, a.y + a.h, 1, 1], [a.x, a.y + a.h, 0, 1]]) {
      const p = P(tx, ty); LV.pos.push(p.x, p.y, p.z); LV.nor.push(n.x, n.y, n.z); LV.uv.push(U(fu), Vv(fv));
    }
    LV.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (const k of ["isis", "clock", "lgL", "lgN", "lgR"]) liveQuad(surfC, mipCentreP.anchors[k], k);

  /* ---------------- glareshield ---------------- */
  {
    const rearZ = -16.06, frontZ = -16.34, rearY = 0.728, frontY = 0.700;
    const gp = TX.glareshield();
    const cen = V(0, (rearY + frontY) / 2, (rearZ + frontZ) / 2);
    const fwd = V(0, frontY - rearY, frontZ - rearZ).normalize();
    const X = V(1, 0, 0), Zn = V().crossVectors(X, fwd).normalize();
    const M = new THREE.Matrix4().makeBasis(X, fwd, Zn).setPosition(cen);
    const len = V(0, frontY - rearY, frontZ - rearZ).length() * 1000;
    const S = rectSurf(M, TX.GL.W, len);
    const mh = new Mesher(true);
    const rows: { ty: number; a: number; b: number }[] = [];
    for (let i = 0; i <= 8; i++) {
      const ty = (i / 8) * len, p = S.pt(TX.GL.W / 2, ty);
      const xe = Math.min(1.1, wallHalf(p.z, p.y) - 0.02) * 1000;
      rows.push({ ty, a: TX.GL.W / 2 - xe, b: TX.GL.W / 2 + xe });
    }
    mh.grid(S, rows, 40);
    // the texture was drawn for 282 mm depth, stretch to the real depth
    addParts(mh, S, gp.parts);
    addMesh(mh, gm(TX.faceTex(gp.face), 0.05));
    HB.add(S, gp.hot);
    for (const k of ["spd", "hdg", "alt", "vs", "baroL", "baroR", "mwL", "mwR", "mcL", "mcR"]) liveQuad(S, gp.anchors[k], k);
    for (const b of ["ap1", "ap2", "athr", "loc", "exped", "appr", "fdL", "lsL", "fdR", "lsR"]) liveQuad(S, gp.anchors["bar_" + b], "bar_" + b);
    // rear lip + front edge (charcoal)
    const edge = (z: number, y: number, dz: number) => { const xe = Math.min(1.1, wallHalf(z, y) - 0.02); MT.quad(V(-xe, y, z), V(xe, y, z), V(xe, y - 0.04, z + dz), V(-xe, y - 0.04, z + dz), C.char, V(0, 0, dz > 0 ? 1 : -1)); };
    edge(rearZ, rearY, 0.0); edge(frontZ, frontY, 0);
  }

  /* ---------------- pedestal ---------------- */
  const pedP = TX.pedestal();
  const PZ0 = -16.21, PY0 = 0.235, A_LEN = 0.26, AN = 4.4 * Math.PI / 180, PCN = 3.5 * Math.PI / 180;
  const pedNodes = [
    V(0, PY0, PZ0),
    V(0, PY0 - A_LEN * Math.sin(AN), PZ0 + A_LEN * Math.cos(AN)),
  ];
  pedNodes.push(V(0, pedNodes[1].y, pedNodes[1].z + 0.64));
  pedNodes.push(V(0, pedNodes[2].y - 0.43 * Math.sin(PCN), pedNodes[2].z + 0.43 * Math.cos(PCN)));
  const pedTy = [0, TX.PED.A, TX.PED.B, TX.PED.H];
  const pedAt = (tx: number, ty: number) => {
    let j = 0; while (j < 2 && ty > pedTy[j + 1]) j++;
    const t = (ty - pedTy[j]) / (pedTy[j + 1] - pedTy[j]);
    return V((tx - TX.PED.W / 2) / 1000, 0, 0).add(pedNodes[j].clone().lerp(pedNodes[j + 1], t));
  };
  const pedS = new Surf(TX.PED.W, TX.PED.H, pedAt, V(0, 1.2, -15.4));
  {
    const mh = new Mesher(true);
    mh.grid(pedS, pedTy.map((ty) => ({ ty, a: 0, b: TX.PED.W })), 1);
    addParts(mh, pedS, pedP.parts);
    addMesh(mh, gm(TX.faceTex(pedP.face), 0.10));
    HB.add(pedS, pedP.hot);
    for (const k of ["mcdu1", "mcdu2", "rmp1", "rmp2"]) liveQuad(pedS, pedP.anchors[k], k);
    // body: flanks, rear, front
    const hw = TX.PED.W / 2000;
    for (const sd of [-1, 1]) for (let j = 0; j < 3; j++) {
      const a = pedNodes[j], b = pedNodes[j + 1], x = sd * hw;
      MT.quad(V(x, FLOOR, a.z), V(x, a.y, a.z), V(x, b.y, b.z), V(x, FLOOR, b.z), C.body, V(sd, 0, 0));
    }
    const e = pedNodes[3];
    MT.quad(V(-hw, FLOOR, e.z), V(hw, FLOOR, e.z), V(hw, e.y, e.z), V(-hw, e.y, e.z), C.body, V(0, 0, 1));
    // quadrant rails + side trim
    for (const sd of [-1, 1]) MT.box([sd * (hw + 0.003), pedNodes[2].y - 0.012, (pedNodes[1].z + pedNodes[3].z) / 2], [0.008, 0.024, pedNodes[3].z - pedNodes[1].z], C.trim);
    // pitch trim wheels
    for (const sd of [-1, 1]) {
      const wz = pedNodes[2].z - 0.3;
      SA.cyl([sd * (hw + 0.004), pedNodes[2].y - 0.092, wz], 0.075, 0.032, C.steel, "x");
      SA.cyl([sd * (hw + 0.004), pedNodes[2].y - 0.092, wz], 0.05, 0.036, "#3a3e44", "x");
      for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; MT.box([sd * (hw + 0.006), pedNodes[2].y - 0.092 + Math.sin(a) * 0.072, wz + Math.cos(a) * 0.072], [0.03, 0.012, 0.012], C.blk, [a, 0, 0]); }
    }
  }
  const pedZ = (ty: number) => pedAt(160, ty).z;
  const pedTopY = pedNodes[2].y;
  // thrust levers
  const thrGeom = () => {
    const m = new Mesher(false, true);
    m.box([0, 0.085, 0], [0.011, 0.17, 0.016], C.steel);
    m.rbox([0, 0.215, 0.0], [0.036, 0.09, 0.05], 0.012, "#131417");
    m.box([0, 0.262, -0.004], [0.022, 0.018, 0.048], "#2c2f34");        // reverse latch
    m.box([0.0185, 0.235, -0.012], [0.004, 0.022, 0.02], C.red);         // TOGA buttons
    m.box([-0.0185, 0.235, -0.012], [0.004, 0.022, 0.02], C.red);
    m.box([0, 0.16, 0.022], [0.028, 0.03, 0.006], "#1a1c20");
    return m.geometry();
  };
  const thrG = thrGeom();
  const idleTh = 0.22, togaTh = -0.56;
  const thrZp = pedZ(TX.PED.thrIdle) - 0.25 * Math.sin(idleTh);
  const thrL = [-1, 1].map((i) => { const g = new THREE.Group(); g.position.set((TX.PED.thrX[i > 0 ? 1 : 0] - 160) / 1000, pedTopY - 0.085, thrZp); g.add(new THREE.Mesh(thrG, matte)); group.add(g); return g; });
  // speed brake + flap levers
  const simpleLever = (h: number, knobSize: [number, number, number], col: string) => {
    const m = new Mesher(false, true);
    m.box([0, h / 2 - 0.03, 0], [0.01, h, 0.014], C.steel);
    m.rbox([0, h - 0.02, 0], knobSize, 0.008, col);
    return m.geometry();
  };
  const sbG = simpleLever(0.135, [0.05, 0.03, 0.078], "#1d1f23"), flG = simpleLever(0.13, [0.045, 0.028, 0.036], "#15171a");
  const sbPiv = new THREE.Group(); sbPiv.position.set((TX.PED.sbX - 160) / 1000, pedTopY - 0.04, pedZ(560)); sbPiv.add(new THREE.Mesh(sbG, matte)); group.add(sbPiv);
  const flPiv = new THREE.Group(); flPiv.position.set((TX.PED.flX - 160) / 1000, pedTopY - 0.04, pedZ(610)); flPiv.add(new THREE.Mesh(flG, matte)); group.add(flPiv);
  // parking brake handle
  const pbG = (() => { const m = new Mesher(false, true); m.cyl([0, 0, 0.03], 0.0055, 0.06, C.steel, "z"); m.cyl([0, 0, 0.066], 0.011, 0.028, "#b01616", "x"); m.rbox([0, 0, 0.066], [0.03, 0.022, 0.022], 0.006, "#b01616"); return m.geometry(); })();
  const pbPiv = new THREE.Group(); pbPiv.position.set((TX.PED.parkX - 160) / 1000, pedTopY + 0.004, pedZ(TX.PED.parkY) - 0.03); pbPiv.add(new THREE.Mesh(pbG, matte)); group.add(pbPiv);
  MT.box([(TX.PED.parkX - 160) / 1000, pedTopY + 0.003, pedZ(TX.PED.parkY) - 0.025], [0.045, 0.01, 0.03], "#2a2d31");
  // gear lever on the centre panel
  const gearFrame = frameObj(Mc);
  const gearSlot = mipCentreP.anchors.gearSlot;
  const glX = (gearSlot.x + gearSlot.w / 2 - TX.MIP.WC / 2) / 1000, glTop = (TX.MIP.H / 2 - (gearSlot.y + 18)) / 1000, glBot = (TX.MIP.H / 2 - (gearSlot.y + gearSlot.h - 18)) / 1000;
  const gearG = (() => {
    const m = new Mesher(false, true);
    m.cyl([0, 0, 0.012], 0.006, 0.03, C.steel, "z");
    m.cyl([0, 0, 0.032], 0.029, 0.02, "#0f1012", "z");
    m.cyl([0, 0, 0.0425], 0.0215, 0.003, "#c9cdd2", "z");
    m.cyl([0, 0, 0.044], 0.012, 0.003, "#15171a", "z");
    return m.geometry();
  })();
  const gearMesh = new THREE.Mesh(gearG, matte); gearMesh.position.set(glX, glBot, 0); gearFrame.add(gearMesh);

  /* ---------------- side consoles ---------------- */
  const conTopY = 0.19, conX0 = 0.80, conZ0 = -16.22, conZ1 = -14.80;
  const sticks: THREE.Group[] = [];
  const stickG = (() => {
    const m = new Mesher(false, true);
    m.cyl([0, 0.03, 0], 0.017, 0.07, "#15161a", "y");
    m.sph([0, 0.128, -0.006], [0.031, 0.056, 0.034], "#0f1012", [-0.22, 0, 0]);
    m.rbox([0, 0.078, 0.022], [0.04, 0.05, 0.03], 0.012, "#131416", [-0.22, 0, 0]);       // palm rest
    m.cyl([0, 0.181, -0.03], 0.0075, 0.006, "#d01414", "y");                                 // AP disconnect
    m.box([0, 0.12, -0.04], [0.01, 0.026, 0.012], "#2a2c30", [-0.22, 0, 0]);                 // trigger
    m.box([0.0, 0.17, -0.004], [0.006, 0.01, 0.022], "#3a3d42");
    return m.geometry();
  })();
  const conP = [TX.consoleTop(-1), TX.consoleTop(1)];
  [-1, 1].forEach((sd, ci) => {
    const p = conP[ci];
    const W = TX.CON.W, H = TX.CON.H;
    const x0 = sd * conX0;
    // texture u grows with world +x; captain: inner edge at the texture right
    const cen = V(sd * (conX0 + W / 2000), conTopY, conZ0 + H / 2000);
    const M = new THREE.Matrix4().makeBasis(V(1, 0, 0), V(0, 0, -1), V(0, 1, 0)).setPosition(cen);
    const S = rectSurf(M, W, H);
    const mh = new Mesher(true);
    mh.grid(S, [{ ty: 0, a: 0, b: W }, { ty: H, a: 0, b: W }], 1);
    // parts: convert to tex-space of a rect whose x grows to +X: captain face was drawn with inner at right -> need u to grow toward the centre
    addParts(mh, S, p.parts);
    addMesh(mh, gm(TX.faceTex(p.face), 0.06));
    // body
    const bw = W / 1000, bh = conTopY - FLOOR, bl = conZ1 - conZ0;
    MT.box([sd * (conX0 + bw / 2), FLOOR + bh / 2, conZ0 + bl / 2], [bw, bh, bl], C.charL);
    MT.box([x0 - sd * 0.004, conTopY - 0.03, conZ0 + bl / 2], [0.012, 0.06, bl], C.trim);             // inner edge trim
    // gaiter (static) + sidestick
    const sz = conZ0 + TX.CON.stickY / 1000, stx = sd * (conX0 + TX.CON.stickXi / 1000);
    MT.cyl([stx, conTopY + 0.004, sz], 0.052, 0.008, "#15161a", "y");
    for (let k = 0; k < 5; k++) MT.cyl([stx, conTopY + 0.014 + k * 0.014, sz], 0.046 - k * 0.0045, 0.012, k % 2 ? "#1b1d21" : "#101113", "y");
    const grp = new THREE.Group(); grp.position.set(stx, conTopY + 0.084, sz); grp.add(new THREE.Mesh(stickG, matte)); group.add(grp); sticks.push(grp);
    // tiller
    const tx = sd * (conX0 + TX.CON.tillerXi / 1000), tz = conZ0 + TX.CON.tillerY / 1000;
    MT.cyl([tx, conTopY + 0.02, tz], 0.012, 0.04, C.steel, "y");
    MT.rbox([tx, conTopY + 0.05, tz], [0.05, 0.022, 0.03], 0.01, "#131416", [0, sd * 0.3, 0]);
    // oxygen mask stowage box against the side wall
    const ox = sd * (wallHalf(-15.25, 0.42) - 0.11);
    MT.rbox([ox, 0.42, -15.25], [0.14, 0.2, 0.26], 0.012, "#58626e");
    MT.box([ox - sd * 0.071, 0.44, -15.25], [0.004, 0.11, 0.2], "#d8d22a");
    MT.box([ox - sd * 0.072, 0.365, -15.25], [0.004, 0.03, 0.06], C.red);
    MT.cyl([ox - sd * 0.075, 0.49, -15.25], 0.02, 0.012, "#151719", "x");
    // cup holder ring
    const cxp = sd * (conX0 + 0.25), czp = conZ0 + 1.12;
    MT.cyl([cxp, conTopY + 0.004, czp], 0.046, 0.008, "#2a2d31", "y");
  });

  /* ---------------- overhead panel ---------------- */
  {
    const ovp = TX.overheadPanel();
    const Z0 = -16.0, dFront = 0.04, dAft = 0.075;
    const pt = (tx: number, ty: number) => {
      const x = (tx - TX.OVH.W / 2) / 1000, z = Z0 + ty / 1000, d = lerp(dFront, dAft, ty / TX.OVH.H);
      return V(x, roofY(z, x) - d, z);
    };
    const S = new Surf(TX.OVH.W, TX.OVH.H, pt, V(0, 0.9, -15.6));
    const mh = new Mesher(true);
    const rows = []; for (let i = 0; i <= 23; i++) rows.push({ ty: (i / 23) * TX.OVH.H, a: 0, b: TX.OVH.W });
    mh.grid(S, rows, 12);
    addParts(mh, S, ovp.parts);
    const mat = gm(TX.faceTex(ovp.face, 16), 0.04);
    addMesh(mh, mat);
    HB.add(S, ovp.hot);
    // skirt: panel edge up to the lining
    const up = (p: THREE.Vector3) => V(p.x, roofY(p.z, p.x) + 0.004, p.z);
    const edgeList: THREE.Vector3[][] = [[], [], [], []];
    for (let i = 0; i <= 23; i++) { const ty = (i / 23) * TX.OVH.H; edgeList[0].push(pt(0, ty)); edgeList[1].push(pt(TX.OVH.W, ty)); }
    for (let i = 0; i <= 12; i++) { const tx = (i / 12) * TX.OVH.W; edgeList[2].push(pt(tx, 0)); edgeList[3].push(pt(tx, TX.OVH.H)); }
    const ctr = pt(TX.OVH.W / 2, TX.OVH.H / 2);
    for (const el of edgeList) { const mid = el[Math.floor(el.length / 2)]; const tw = V().subVectors(ctr, mid); for (let i = 0; i < el.length - 1; i++) MT.quad(el[i], el[i + 1], up(el[i + 1]), up(el[i]), "#24272b", tw); }
    // a few deeper things: the FIRE handle guards etc are already in parts
  }

  /* ---------------- seats ---------------- */
  const fbUV: UVFn = (p, n) => (Math.abs(n.x) > 0.7 ? [p.z * 5, p.y * 5] : [p.x * 5 + p.z * 0.3, p.y * 2.5 + p.z * 5]);
  for (const sd of [-1, 1]) {
    const sx = sd * 0.53, sz = -15.45, y0 = FLOOR;
    const P = (x: number, y: number, z: number): [number, number, number] => [sx + x, y0 + y, sz + z];
    // rails + base
    for (const rx of [-0.17, 0.17]) { SA.box(P(rx, 0.025, -0.05), [0.04, 0.05, 0.9], "#7d838b"); }
    MT.box(P(0, 0.09, -0.02), [0.42, 0.05, 0.46], "#2a2d32");
    SA.cyl(P(0, 0.22, -0.02), 0.06, 0.26, "#8e949c", "y");
    MT.box(P(0, 0.375, -0.02), [0.46, 0.05, 0.48], "#22252a");
    // pan
    FB.rbox(P(0, 0.455, -0.03), [0.40, 0.09, 0.44], 0.025, undefined, [0.02, 0, 0], fbUV);
    MT.rbox(P(-0.235, 0.47, -0.03), [0.065, 0.11, 0.44], 0.025, C.leather, [0.02, 0, 0]);
    MT.rbox(P(0.235, 0.47, -0.03), [0.065, 0.11, 0.44], 0.025, C.leather, [0.02, 0, 0]);
    MT.rbox(P(0, 0.44, -0.27), [0.46, 0.075, 0.07], 0.03, C.leather);
    // back
    const bk = -0.1;
    MT.rbox(P(0, 0.95, 0.27), [0.52, 0.86, 0.07], 0.03, C.leather, [bk, 0, 0]);
    FB.rbox(P(0, 0.93, 0.225), [0.36, 0.66, 0.08], 0.03, undefined, [bk, 0, 0], fbUV);
    MT.rbox(P(-0.225, 0.93, 0.23), [0.065, 0.7, 0.11], 0.03, C.leather, [bk, 0, 0]);
    MT.rbox(P(0.225, 0.93, 0.23), [0.065, 0.7, 0.11], 0.03, C.leather, [bk, 0, 0]);
    // headrest
    MT.rbox(P(0, 1.47, 0.33), [0.32, 0.22, 0.09], 0.04, C.leather, [bk, 0, 0]);
    FB.rbox(P(0, 1.47, 0.285), [0.22, 0.14, 0.06], 0.025, undefined, [bk, 0, 0], fbUV);
    SA.cyl(P(-0.09, 1.3, 0.33), 0.007, 0.16, "#9096a0", "y"); SA.cyl(P(0.09, 1.3, 0.33), 0.007, 0.16, "#9096a0", "y");
    // armrests
    for (const ax of [-1, 1]) { MT.rbox(P(ax * 0.29, 0.62, 0.0), [0.06, 0.045, 0.36], 0.018, "#15171a"); SA.box(P(ax * 0.29, 0.56, 0.17), [0.012, 0.1, 0.02], "#8e949c"); }
  }

  /* ---------------- rudder pedals ---------------- */
  const pedalG = (left: boolean) => {
    const m = new Mesher(false, true);
    for (const sd of [-1, 1]) {
      const px = sd * 0.53 + (left ? -0.115 : 0.115), pz = -16.27, py = -0.17;
      m.rbox([px, py, pz], [0.115, 0.2, 0.022], 0.006, "#1f2226", [-0.5, 0, 0]);
      m.box([px, py + 0.01, pz + 0.013], [0.1, 0.17, 0.004], "#2b2e33", [-0.5, 0, 0]);
      for (let k = 0; k < 5; k++) m.box([px, py - 0.06 + k * 0.03, pz + 0.014 - k * 0.0012 + 0.0], [0.096, 0.004, 0.005], "#0e0f11", [-0.5, 0, 0]);
      m.rbox([px, py + 0.118, pz - 0.028], [0.11, 0.07, 0.022], 0.008, "#101113", [-0.95, 0, 0]);        // brake pedal
      m.cyl([px, py - 0.15, pz - 0.05], 0.012, 0.22, C.steel, "y");
      m.box([px, -0.385, pz - 0.05], [0.13, 0.03, 0.12], "#2a2d32");
    }
    return m.geometry();
  };
  const pedL = new THREE.Mesh(pedalG(true), matte), pedR = new THREE.Mesh(pedalG(false), matte);
  group.add(pedL, pedR);

  /* ---------------- finalise statics ---------------- */
  addMesh(MT, matte); addMesh(SA, satin); addMesh(FB, fabric); addMesh(LV, liveMat);

  // lit legends: one instanced quad per pushbutton, scaled to zero when dark
  const ledIndex = new Map<string, number>();
  const ledMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.92, depthWrite: false }), Math.max(1, HB.leds.length));
  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  HB.leds.forEach((l, i) => { ledIndex.set(l.id, i); ledMesh.setMatrixAt(i, zeroM); ledMesh.setColorAt(i, new THREE.Color(l.col).multiplyScalar(1.6)); });
  ledMesh.count = HB.leds.length; ledMesh.frustumCulled = false; ledMesh.renderOrder = 3;
  group.add(ledMesh);
  // hover outline
  const hl = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: "#7fe3ff", toneMapped: false, depthTest: false, transparent: true }));
  hl.visible = false; hl.renderOrder = 20; group.add(hl);
  // levers are pickable too
  const lever = (o: THREE.Object3D, id: string, label: string) => o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.userData.hot = { id, label, kind: "lever" } as HotInfo; HB.pickables.push(c); } });
  lever(gearMesh, "gear", "Landing gear lever (click)");
  lever(flPiv, "flaps", "Flap lever (left click extend / right click retract / scroll)");
  lever(sbPiv, "spdbrk", "Speed brake lever (click)");
  lever(pbPiv, "park", "Parking brake (click)");
  thrL.forEach((g) => lever(g, "thrust", "Thrust levers (scroll, left/right click for detents)"));

  const cockpitLight = new THREE.PointLight("#ffe7c4", 0.6, 3.6, 1.5);
  cockpitLight.position.set(0, 1.0, -15.4); group.add(cockpitLight);

  /* ---------------- animation ---------------- */
  let thTarget = idleTh, th = idleTh, flap = 0, sb = 0, pk = 0, gl = 1, lastDay = -1;
  const dispBase = [S_PFD.m, S_ND.m, S_EWD.m, S_SD.m];
  const update = (s: VisualState, dt: number) => {
    const k = Math.min(1, dt * 10);
    thTarget = s.reverser > 0.02 || s.reverseSelected ? idleTh + 0.1 + s.reverser * 0.2 : lerp(idleTh, togaTh, Math.min(1, Math.max(0, s.throttle)));
    th += (thTarget - th) * Math.min(1, dt * 14);
    thrL[0].rotation.x = th; thrL[1].rotation.x = th;
    flap += (s.flapLever - flap) * Math.min(1, dt * 12);
    flPiv.rotation.x = (flap - 2) * 0.165;
    sb += (Math.max(s.speedbrakeLever, s.spoilers) - sb) * k;
    sbPiv.rotation.x = lerp(-0.42, 0.42, sb);
    pk += ((s.parkingBrake ? 1 : 0) - pk) * Math.min(1, dt * 8);
    pbPiv.rotation.x = -pk * 1.15;
    gl += ((s.gearLever ? 1 : 0) - gl) * Math.min(1, dt * 9);
    gearMesh.position.y = lerp(glTop, glBot, gl);
    for (let i = 0; i < 2; i++) { sticks[i].rotation.x = s.stickY * 0.3; sticks[i].rotation.z = -s.stickX * 0.3; }
    pedL.position.z = 0.04 * s.pedal; pedR.position.z = -0.04 * s.pedal;
    if (s.dayFactor !== lastDay) {
      lastDay = s.dayFactor;
      const night = 1 - s.dayFactor;
      const ei = 0.22 + 0.78 * night;
      for (const m of glow) m.emissiveIntensity = ei;
      const dm = 0.55 + 0.45 * s.dayFactor;
      for (const m of dispBase) m.color.setScalar(dm);
      liveMat.color.setScalar(0.6 + 0.4 * s.dayFactor);
      cockpitLight.intensity = 0.25 + night * 1.2;
    }
  };

  const hlBox = new THREE.Box3(), hlSize = V();
  const controls: CockpitControls = {
    pickables: HB.pickables,
    set: (id, on) => {
      const t = HB.toggles.get(id);
      if (t) { t.up = on; t.piv.rotation.x = on ? -0.5 : 0.5; }
      const i = ledIndex.get(id);
      if (i !== undefined) { ledMesh.setMatrixAt(i, on ? HB.leds[i].M : zeroM); ledMesh.instanceMatrix.needsUpdate = true; }
    },
    hover: (obj) => {
      if (!obj) { hl.visible = false; return; }
      const r = obj.userData.rect as [number, number] | undefined;
      if (r) {
        hl.position.copy(obj.position); hl.quaternion.copy(obj.quaternion); hl.scale.set(r[0] + 0.004, r[1] + 0.004, 1);
        hl.translateZ(0.0085); hl.visible = true;
      } else {
        // lever: outline its bounding box face toward the pilot
        hlBox.setFromObject(obj); hlBox.getSize(hlSize); hlBox.getCenter(hl.position);
        group.worldToLocal(hl.position); hl.quaternion.identity(); hl.scale.set(Math.max(hlSize.x, 0.03), Math.max(hlSize.y, 0.03), 1);
        hl.visible = true;
      }
    },
  };

  return {
    group, update, controls,
    screens: {
      pfd: S_PFD.c, nd: S_ND.c, ewd: S_EWD.c, sd: S_SD.c,
      refresh: (which: ScreenId[] = ["pfd", "nd", "ewd", "sd"]) => { const m = { pfd: S_PFD, nd: S_ND, ewd: S_EWD, sd: S_SD }; for (const k of which) m[k].t.needsUpdate = true; },
      panel: (t: Telemetry) => { liveAtlas.update(t); },
    },
  };
}
