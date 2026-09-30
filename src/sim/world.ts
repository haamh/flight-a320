import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AIRPORTS, TERRAIN, buildTerrain, heightAt, WATER_LEVEL, type Airport } from "./terrain";
import {
  asphaltTexture, concreteTexture, farmlandTexture, grassDetailTexture, waterNormalTexture, textTexture,
  softPuffTexture, glowTexture, buildingFacadeTexture, windowGlowTexture, makeCanvas, tileNoise,
} from "./textures";
import { mulberry, fbm, smoothstep, lerp, clamp } from "./noise";
import { runwayFrame } from "./physics";

const D2R = Math.PI / 180;

export interface TimeOfDay { name: string; elev: number; az: number; turbidity: number; rayleigh: number }
export const TIMES: TimeOfDay[] = [
  { name: "Morning", elev: 14, az: 105, turbidity: 4, rayleigh: 1.6 },
  { name: "Midday", elev: 52, az: 170, turbidity: 2.5, rayleigh: 1.2 },
  { name: "Golden Hour", elev: 7, az: 250, turbidity: 6, rayleigh: 2.2 },
  { name: "Sunset", elev: 1.2, az: 262, turbidity: 8, rayleigh: 2.8 },
  { name: "Night", elev: -14, az: 280, turbidity: 2, rayleigh: 0.6 },
];

export interface World {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  dayFactor: number;
  setTime: (t: TimeOfDay, renderer: THREE.WebGLRenderer) => void;
  update: (time: number, dt: number, camPos: THREE.Vector3, acPos: THREE.Vector3, acQuat: THREE.Quaternion) => void;
  lensflareAnchor: THREE.Object3D;
  /** sun shadow box: tight around the flight deck / wing view, or around the whole aircraft */
  setShadowMode: (m: ShadowMode) => void;
  /** compile every shader variant up front (LOD meshes that are not visible yet would otherwise compile mid-flight) */
  warm: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void;
}

/* ---------------------------------------------------------------------- */
/* Terrain: world-aligned tiles, per-tile LOD (full res near, coarser with distance),
   super tiles for the far field and skirts that hide LOD cracks. heightAt()/groundAt()
   keep sampling TERRAIN.heights untouched. */
const TB = 30;                 // cells per base tile (122 m cells -> 3.7 km tiles)
const SBK = 3;                 // base tiles per super tile side
const BASE_STEPS = [1, 2, 3];  // cells per quad edge for base LOD 0..2
const SUPER_STEPS = [5, 10];   // same for super tile LOD 0..1
const BASE_LOD_RANGE = [6000, 11000];
const SUPER_ON = 20000;        // nearest distance beyond which super tiles replace base tiles
const SUPER_LOD_RANGE = 45000;

interface TerrainChunk {
  mesh: THREE.Mesh; lods: THREE.BufferGeometry[]; lod: number;
  cx: number; cz: number; hw: number; hmin: number; hmax: number; under: boolean;
}
interface TerrainSuper extends TerrainChunk { far: boolean; kids: TerrainChunk[] }

function buildTerrainMesh() {
  buildTerrain();
  const { N, size, cx, cz, heights } = TERRAIN;
  const r = N + 1, cell = size / N, x0 = cx - size / 2, z0 = cz - size / 2;
  // per-vertex normal / material weights from the full-resolution grid (shared by every LOD so shading stays consistent)
  const nrm = new Int16Array(r * r * 4), col = new Uint8Array(r * r * 4);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const k = j * r + i;
    const x = x0 + i * cell, z = z0 + j * cell;
    const h = heights[k];
    const i0 = Math.max(0, i - 1), i1 = Math.min(N, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(N, j + 1);
    const hx = heights[j * r + i1] - heights[j * r + i0];
    const hz = heights[j1 * r + i] - heights[j0 * r + i];
    const slope = Math.hypot(hx, hz) / (2 * cell);
    const gx = -hx / ((i1 - i0) * cell), gz = -hz / ((j1 - j0) * cell);
    const il = 32767 / Math.sqrt(gx * gx + 1 + gz * gz);
    nrm[k * 4] = gx * il; nrm[k * 4 + 1] = il; nrm[k * 4 + 2] = gz * il;
    const n = fbm(x / 1200, z / 1200, 3);
    const rock = clamp(smoothstep(0.35, 0.7, slope + n * 0.1) + smoothstep(700, 1200, h + n * 200), 0, 1);
    const snow = smoothstep(1350, 1700, h + n * 250) * (1 - smoothstep(0.9, 1.3, slope));
    const sand = smoothstep(4, -1, h) * (1 - rock);
    col[k * 4] = Math.round(rock * 255); col[k * 4 + 1] = Math.round(snow * 255); col[k * 4 + 2] = Math.round(sand * 255); col[k * 4 + 3] = 255;
  }
  const farm = farmlandTexture();
  farm.repeat.set(size / 3800, size / 3800);
  const detail = grassDetailTexture();
  const mat = new THREE.MeshStandardMaterial({ map: farm, vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.fragmentShader = "uniform sampler2D detailMap;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", `
        vec4 farmC = texture2D(map, vMapUv);
        vec3 det = texture2D(detailMap, vMapUv * 90.0).rgb * 1.45;
        vec3 det2 = texture2D(detailMap, vMapUv * 7.0).rgb * 1.3;
        vec3 farm = farmC.rgb * mix(vec3(1.0), det, 0.55) * mix(vec3(1.0), det2, 0.35);
        vec3 rockC = vec3(0.30, 0.285, 0.26) * det * det2;
        vec3 snowC = vec3(0.92, 0.94, 0.97) * mix(vec3(1.0), det, 0.15);
        vec3 sandC = vec3(0.62, 0.56, 0.42) * det;
        vec3 cc = mix(farm, rockC, vColor.r);
        cc = mix(cc, snowC, vColor.g);
        cc = mix(cc, sandC, vColor.b);
        diffuseColor.rgb *= cc;
      `)
      .replace("#include <color_fragment>", "");
  };

  // index buffers are shared by every tile with the same grid size (top grid + 4 skirts, outward facing)
  const idxCache = new Map<number, THREE.BufferAttribute>();
  const gridIndex = (n: number) => {
    let ia = idxCache.get(n);
    if (ia) return ia;
    const w = n + 1, nv = w * w, sN = nv, sS = nv + w, sW = nv + 2 * w, sE = nv + 3 * w;
    const idx: number[] = [];
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const A = b * w + a, B = (b + 1) * w + a, C = (b + 1) * w + a + 1, D = b * w + a + 1;
      idx.push(A, B, D, B, C, D);
    }
    for (let a = 0; a < n; a++) {
      let p0 = a, p1 = a + 1, s0 = sN + a, s1 = s0 + 1;
      idx.push(p0, p1, s0, p1, s1, s0);
      p0 = n * w + a; p1 = p0 + 1; s0 = sS + a; s1 = s0 + 1;
      idx.push(p0, s0, p1, p1, s0, s1);
    }
    for (let b = 0; b < n; b++) {
      let p0 = b * w, p1 = (b + 1) * w, s0 = sW + b, s1 = s0 + 1;
      idx.push(p0, s0, p1, p1, s0, s1);
      p0 = b * w + n; p1 = (b + 1) * w + n; s0 = sE + b; s1 = s0 + 1;
      idx.push(p0, p1, s0, p1, s1, s0);
    }
    ia = new THREE.BufferAttribute(new Uint16Array(idx), 1);
    idxCache.set(n, ia);
    return ia;
  };

  // max deviation of a coarse grid (step) from the full-res heights inside a tile (triangle split as in heightAt)
  const lodError = (i0: number, j0: number, cells: number, step: number) => {
    let e = 0;
    for (let cj = 0; cj < cells; cj += step) for (let ci = 0; ci < cells; ci += step) {
      const I = i0 + ci, J = j0 + cj;
      const h00 = heights[J * r + I], h10 = heights[J * r + I + step], h01 = heights[(J + step) * r + I], h11 = heights[(J + step) * r + I + step];
      for (let dj = 0; dj <= step; dj++) for (let di = 0; di <= step; di++) {
        const tx = di / step, tz = dj / step;
        const hi = tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
        const d = Math.abs(heights[(J + dj) * r + I + di] - hi);
        if (d > e) e = d;
      }
    }
    return e;
  };

  const makeLod = (i0: number, j0: number, cells: number, step: number, depth: number, ox: number, oz: number, sphere: THREE.Sphere) => {
    const n = cells / step, w = n + 1, nv = w * w, tot = nv + 4 * w;
    const pos = new Float32Array(tot * 3), uv = new Float32Array(tot * 2), nr = new Int16Array(tot * 4), cl = new Uint8Array(tot * 4);
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) {
      const gi = i0 + a * step, gj = j0 + b * step, k = gj * r + gi, v = b * w + a;
      pos[v * 3] = x0 + gi * cell - ox; pos[v * 3 + 1] = heights[k]; pos[v * 3 + 2] = z0 + gj * cell - oz;
      uv[v * 2] = gi / N; uv[v * 2 + 1] = 1 - gj / N;
      nr[v * 4] = nrm[k * 4]; nr[v * 4 + 1] = nrm[k * 4 + 1]; nr[v * 4 + 2] = nrm[k * 4 + 2];
      cl[v * 4] = col[k * 4]; cl[v * 4 + 1] = col[k * 4 + 1]; cl[v * 4 + 2] = col[k * 4 + 2]; cl[v * 4 + 3] = 255;
    }
    const skirt = (s: number, d: number) => {
      pos[d * 3] = pos[s * 3]; pos[d * 3 + 1] = pos[s * 3 + 1] - depth; pos[d * 3 + 2] = pos[s * 3 + 2];
      uv[d * 2] = uv[s * 2]; uv[d * 2 + 1] = uv[s * 2 + 1];
      for (let c = 0; c < 4; c++) { nr[d * 4 + c] = nr[s * 4 + c]; cl[d * 4 + c] = cl[s * 4 + c]; }
    };
    for (let a = 0; a <= n; a++) { skirt(a, nv + a); skirt(n * w + a, nv + w + a); }
    for (let b = 0; b <= n; b++) { skirt(b * w, nv + 2 * w + b); skirt(b * w + n, nv + 3 * w + b); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nr, 4, true));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.BufferAttribute(cl, 4, true));
    g.setIndex(gridIndex(n));
    g.boundingSphere = sphere;
    return g;
  };

  const group = new THREE.Group();
  const nBase = N / TB, nSup = nBase / SBK, SC = TB * SBK;
  const errs: number[] = new Array(nBase * nBase);
  const bounds = (i0: number, j0: number, cells: number) => {
    let lo = Infinity, hi = -Infinity;
    for (let j = j0; j <= j0 + cells; j++) for (let i = i0; i <= i0 + cells; i++) { const h = heights[j * r + i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    return [lo, hi];
  };
  const mk = (i0: number, j0: number, cells: number, steps: number[], depth: number, lo: number, hi: number): TerrainChunk => {
    const hw = cells * cell / 2, ox = x0 + i0 * cell + hw, oz = z0 + j0 * cell + hw;
    const sphere = new THREE.Sphere(new THREE.Vector3(0, (lo + hi - depth) / 2, 0), Math.hypot(hw, hw, (hi - lo + depth) / 2));
    const lods = steps.map((s) => makeLod(i0, j0, cells, s, depth, ox, oz, sphere));
    const mesh = new THREE.Mesh(lods[lods.length - 1], mat);
    mesh.position.set(ox, 0, oz); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.receiveShadow = true; mesh.visible = false;
    group.add(mesh);
    return { mesh, lods, lod: lods.length - 1, cx: ox, cz: oz, hw, hmin: lo, hmax: hi, under: hi < WATER_LEVEL - 0.3 };
  };
  const bases: TerrainChunk[] = new Array(nBase * nBase);
  for (let tj = 0; tj < nBase; tj++) for (let ti = 0; ti < nBase; ti++) {
    const i0 = ti * TB, j0 = tj * TB;
    let e = 0;
    for (const s of [2, 3, 5, 10]) e = Math.max(e, lodError(i0, j0, TB, s));
    errs[tj * nBase + ti] = 2 + e * 1.25;
    const [lo, hi] = bounds(i0, j0, TB);
    bases[tj * nBase + ti] = mk(i0, j0, TB, BASE_STEPS, errs[tj * nBase + ti], lo, hi);
  }
  const supers: TerrainSuper[] = [];
  for (let sj = 0; sj < nSup; sj++) for (let si = 0; si < nSup; si++) {
    const kids: TerrainChunk[] = []; let depth = 0;
    for (let b = 0; b < SBK; b++) for (let a = 0; a < SBK; a++) { const q = (sj * SBK + b) * nBase + si * SBK + a; kids.push(bases[q]); depth = Math.max(depth, errs[q]); }
    const [lo, hi] = bounds(si * SC, sj * SC, SC);
    supers.push({ ...mk(si * SC, sj * SC, SC, SUPER_STEPS, depth, lo, hi), far: false, kids });
  }

  const dist = (c: TerrainChunk, p: THREE.Vector3) => {
    const dx = Math.max(Math.abs(p.x - c.cx) - c.hw, 0), dz = Math.max(Math.abs(p.z - c.cz) - c.hw, 0);
    const dy = p.y < c.hmin ? c.hmin - p.y : p.y > c.hmax ? p.y - c.hmax : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  const setLod = (c: TerrainChunk, l: number) => { if (c.lod !== l) { c.lod = l; c.mesh.geometry = c.lods[l]; } };
  let lx = 1e9, ly = 0, lz = 0;
  const update = (cam: THREE.Vector3) => {
    if (Math.abs(cam.x - lx) + Math.abs(cam.y - ly) + Math.abs(cam.z - lz) < 20) return;
    lx = cam.x; ly = cam.y; lz = cam.z;
    for (const s of supers) {
      const d = dist(s, cam);
      s.far = s.far ? d > SUPER_ON * 0.95 : d > SUPER_ON * 1.05;
      if (s.far) {
        setLod(s, s.lod === 1 ? (d > SUPER_LOD_RANGE * 0.96 ? 1 : 0) : (d > SUPER_LOD_RANGE * 1.04 ? 1 : 0));
        s.mesh.visible = !s.under;
        for (const k of s.kids) k.mesh.visible = false;
      } else {
        s.mesh.visible = false;
        for (const k of s.kids) {
          if (k.under) { k.mesh.visible = false; continue; }
          const dk = dist(k, cam);
          let l = k.lod;
          while (l < 2 && dk > BASE_LOD_RANGE[l] * 1.04) l++;
          while (l > 0 && dk < BASE_LOD_RANGE[l - 1] * 0.96) l--;
          setLod(k, l);
          k.mesh.visible = true;
        }
      }
    }
  };
  group.matrixAutoUpdate = false;
  return { mesh: group, update, reset: () => { lx = 1e9; } };
}

/* ---------------------------------------------------------------------- */
function tireMarksTexture() {
  const W = 1024, H = 256;
  const { c, ctx } = makeCanvas(W, H);
  const rnd = mulberry(9);
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const y = H / 2 + (rnd() - 0.5) * H * 0.5 + (rnd() > 0.5 ? 1 : -1) * H * 0.12;
    const x = rnd() * W * 0.6;
    const len = 80 + rnd() * 500;
    const g = ctx.createLinearGradient(x, 0, x + len, 0);
    g.addColorStop(0, "rgba(10,10,10,0)"); g.addColorStop(0.15, `rgba(10,10,10,${0.25 + rnd() * 0.3})`); g.addColorStop(1, "rgba(10,10,10,0)");
    ctx.fillStyle = g; ctx.fillRect(x, y, len, 2 + rnd() * 5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface AirportRuntime { update: (time: number, acPos: THREE.Vector3, day: number, camPos: THREE.Vector3) => void }

/** Static meshes of one parent merged per material / shadow flags (single-material, opaque, non-instanced only). */
function mergeStatic(parent: THREE.Object3D) {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const o of parent.children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material) || m.material.transparent || !m.visible) continue;
    const key = `${m.material.uuid}|${m.renderOrder}|${+m.castShadow}${+m.receiveShadow}`;
    let l = groups.get(key); if (!l) groups.set(key, l = []);
    l.push(m);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geoms = list.map((m) => {
      m.updateMatrix();
      const g = m.geometry.clone().applyMatrix4(m.matrix);
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
      return g;
    });
    const merged = geoms.every((g) => g.index && g.attributes.normal && g.attributes.uv) ? mergeGeometries(geoms) : null;
    geoms.forEach((g) => g.dispose());
    if (!merged) continue;
    const mm = new THREE.Mesh(merged, list[0].material);
    mm.castShadow = list[0].castShadow; mm.receiveShadow = list[0].receiveShadow; mm.renderOrder = list[0].renderOrder;
    for (const m of list) parent.remove(m);
    parent.add(mm);
  }
}

function buildAirport(scene: THREE.Scene, a: Airport, big: boolean, mats: Record<string, THREE.Material>, parked: ParkedPart[], lightPts: { pos: number[]; col: number[] }): AirportRuntime {
  const grp = new THREE.Group();
  grp.position.set(a.x, a.elev, a.z);
  grp.rotation.y = (90 - a.heading) * D2R;
  scene.add(grp);
  const L = a.length, Wd = a.width;
  const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(grp.matrixWorld);
  grp.updateMatrixWorld(true);
  const flat = (w: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rot = 0) => {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z); m.rotation.y = rot; m.receiveShadow = true;
    grp.add(m);
    return m;
  };
  const asphalt = mats.asphalt as THREE.MeshStandardMaterial;
  // grass field
  const grassM = mats.grass.clone() as THREE.MeshStandardMaterial;
  grassM.map = (mats.grass as THREE.MeshStandardMaterial).map!.clone();
  grassM.map.repeat.set((L + 1600) / 25, 1400 / 25);
  grassM.map.needsUpdate = true;
  flat(L + 1600, 1400, grassM, 0, 0.02, -250);
  // runway
  const rwM = asphalt.clone();
  rwM.map = asphalt.map!.clone(); rwM.map.repeat.set(L / 30, (Wd + 15) / 30); rwM.map.needsUpdate = true;
  flat(L + 120, Wd + 15, rwM, 0, 0.06, 0);
  // blast pads
  const padM = mats.concrete;
  flat(60, Wd, padM, -L / 2 - 90, 0.055, 0); flat(60, Wd, padM, L / 2 + 90, 0.055, 0);
  // tire marks
  const tm = new THREE.MeshStandardMaterial({ map: mats.tireMap ? (mats.tireMap as THREE.MeshBasicMaterial).map : null, transparent: true, depthWrite: false, roughness: 0.9 });
  const tmW = flat(700, 22, tm, -L / 2 + 480, 0.075, 0);
  tmW.renderOrder = 1;
  const tmE = flat(700, 22, tm, L / 2 - 480, 0.075, 0, Math.PI); tmE.renderOrder = 1;
  // markings
  const white: THREE.BufferGeometry[] = [];
  const quad = (x: number, z: number, lx: number, lz: number, arr = white) => {
    const g = new THREE.PlaneGeometry(lx, lz); g.rotateX(-Math.PI / 2); g.translate(x, 0.085, z); arr.push(g);
  };
  for (const e of [-1, 1]) {
    const xt = e * L / 2, inw = -e;
    for (let k = 0; k < 6; k++) for (const s of [-1, 1]) quad(xt + inw * (6 + 15), s * (3.9 + k * 3.0), 30, 1.8);
    quad(xt + inw * 0.9, 0, 1.8, Wd - 2); // threshold line
    const aim = 400;
    for (const s of [-1, 1]) quad(xt + inw * (aim + 25), s * 10.5, 50, 7);
    const tdz: [number, number][] = [[150, 3], [300, 3], [500, 2], [600, 2], [750, 1], [900, 1]];
    for (const [d, n] of tdz) for (let j = 0; j < n; j++) for (const s of [-1, 1]) quad(xt + inw * (d + 11), s * (6.5 + j * 3.0), 22.5, 1.8);
  }
  for (let x = -L / 2 + 80; x < L / 2 - 80; x += 60) quad(x + 18, 0, 36, 0.9);
  for (const s of [-1, 1]) quad(0, s * (Wd / 2 - 0.6), L, 0.9);
  const wm = new THREE.Mesh(mergeGeometries(white), mats.paint);
  wm.receiveShadow = true; wm.renderOrder = 2; grp.add(wm);
  // numbers
  for (const [e, txt] of [[-1, a.rwy[0]], [1, a.rwy[1]]] as [number, string][]) {
    const tex = textTexture(txt, 512, 512, "bold 300px 'Arial Narrow', Arial, sans-serif");
    const g = new THREE.PlaneGeometry(12, 18);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, depthWrite: false }));
    m.rotation.y = e < 0 ? -Math.PI / 2 : Math.PI / 2;
    m.position.set(e * L / 2 - e * 60, 0.09, 0);
    m.renderOrder = 3;
    grp.add(m);
  }
  // taxiway system
  const twZ = -190;
  const twM = asphalt.clone(); twM.map = asphalt.map!.clone(); twM.map.repeat.set(L / 40, 1); twM.map.needsUpdate = true;
  twM.color = new THREE.Color("#b8b8b8");
  flat(L, 23, twM, 0, 0.05, twZ);
  const connectors = [-L / 2 + 30, -L / 4, 0, L / 4, L / 2 - 30];
  for (const x of connectors) flat(23, Math.abs(twZ) - Wd / 2, twM, x, 0.045, twZ / 2 - Wd / 4);
  const yellow: THREE.BufferGeometry[] = [];
  quad(0, twZ, L, 0.3, yellow);
  for (const x of connectors) {
    quad(x, twZ / 2 - Wd / 4, 0.3, Math.abs(twZ) - Wd / 2 - 4, yellow);
    for (let k = 0; k < 4; k++) quad(x, -Wd / 2 - 45 - k * 0.6, 23, 0.15, yellow);
  }
  // apron
  const apW = big ? 1300 : 700, apD = 220;
  const apX = big ? -150 : 0;
  const apZ = twZ - 12 - apD / 2;
  const apM = (mats.concrete as THREE.MeshStandardMaterial).clone();
  apM.map = (mats.concrete as THREE.MeshStandardMaterial).map!.clone(); apM.map.repeat.set(apW / 30, apD / 30); apM.map.needsUpdate = true;
  flat(apW, apD, apM, apX, 0.04, apZ);
  const stands = big ? 6 : 3;
  const standXs: number[] = [];
  for (let s = 0; s < stands; s++) {
    const x = apX - apW / 2 + 120 + s * ((apW - 240) / Math.max(1, stands - 1));
    standXs.push(x);
    quad(x, apZ - 10, 0.3, apD - 40, yellow);
    quad(x, apZ - apD / 2 + 30, 6, 0.4, yellow);
  }
  const ym = new THREE.Mesh(mergeGeometries(yellow), mats.yellow); ym.renderOrder = 2; ym.receiveShadow = true; grp.add(ym);
  // terminal
  const tZ = apZ - apD / 2 - 30;
  const tW = apW - 100, tD = 60, tH = big ? 22 : 14;
  const term = new THREE.Mesh(new THREE.BoxGeometry(tW, tH, tD), [mats.facade, mats.facade, mats.roof, mats.roof, mats.glassFacade, mats.facade]);
  term.position.set(apX, tH / 2, tZ - tD / 2 + 30); term.castShadow = true; term.receiveShadow = true; grp.add(term);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(tW + 16, 1.2, tD + 16), mats.roofEdge);
  roof.position.set(apX, tH + 0.6, tZ - tD / 2 + 30); roof.castShadow = true; grp.add(roof);
  // mullions (glass facade fins)
  const fins: THREE.BufferGeometry[] = [];
  for (let x = -tW / 2; x <= tW / 2; x += 6) { const g = new THREE.BoxGeometry(0.3, tH, 0.6); g.translate(apX + x, tH / 2, tZ + 30 + 0.3); fins.push(g); }
  for (let y = 4; y < tH; y += 4.5) { const g = new THREE.BoxGeometry(tW, 0.35, 0.5); g.translate(apX, y, tZ + 30 + 0.3); fins.push(g); }
  grp.add(new THREE.Mesh(mergeGeometries(fins), mats.metal));
  // jet bridges + parked aircraft
  const rnd = mulberry(a.x + 7);
  const parkedAt: THREE.Vector3[] = [];
  standXs.forEach((x, i) => {
    const bz = tZ + 30;
    const rot = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4.5, 24), mats.facade);
    rot.position.set(x - 16, 5.5, bz + 14); rot.castShadow = true; grp.add(rot);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3.5, 12), mats.metal); col.position.set(x - 16, 1.75, bz + 14); grp.add(col);
    const t1 = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 14), mats.bridge); t1.position.set(x - 16, 5.8, bz + 7); t1.castShadow = true; grp.add(t1);
    const len = 20;
    const t2 = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.9, len), mats.bridge);
    t2.position.set(x - 16 + 5, 5.0, bz + 14 + len / 2 - 2); t2.rotation.y = 0.5; t2.rotation.x = 0.06; t2.castShadow = true; grp.add(t2);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 3.5, 1), mats.metal); leg.position.set(x - 16 + 10, 1.75, bz + 14 + 14); grp.add(leg);
    if (rnd() > 0.25) {
      const standZ = bz + 32;
      parkedAt.push(new THREE.Vector3(x, 3.45, standZ + 18.6)); // nose north (toward terminal)
      // ground service: tug & belt loader
      const tug = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 4.2), mats.gse); tug.position.set(x + 1.5, 0.7, standZ + 0.5 + 18.6 - 30); tug.castShadow = true; grp.add(tug);
      const bl = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 8), mats.gse); bl.position.set(x + 4.5, 0.9, standZ + 18.6 - 8.3); bl.rotation.x = -0.18; bl.castShadow = true; grp.add(bl);
    }
    void i;
  });
  // control tower
  const twX = big ? apX + apW / 2 + 120 : apX + apW / 2 + 80;
  const twH = big ? 52 : 32;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.6, twH, 32), mats.facade);
  shaft.position.set(twX, twH / 2, tZ + 10); shaft.castShadow = true; grp.add(shaft);
  const cabBase = new THREE.Mesh(new THREE.CylinderGeometry(8, 6, 3, 8), mats.facade); cabBase.position.set(twX, twH + 1.5, tZ + 10); cabBase.castShadow = true; grp.add(cabBase);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(8.6, 8, 5.5, 8, 1, true), mats.towerGlass); cab.position.set(twX, twH + 5.75, tZ + 10); grp.add(cab);
  const cabRoof = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 8.8, 1.2, 8), mats.roofEdge); cabRoof.position.set(twX, twH + 9.1, tZ + 10); cabRoof.castShadow = true; grp.add(cabRoof);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 12, 8), mats.metal); mast.position.set(twX, twH + 15.7, tZ + 10); grp.add(mast);
  const radar = new THREE.Mesh(new THREE.BoxGeometry(6, 1.2, 0.4), mats.metal); radar.position.set(twX + 40, 18, tZ - 20); grp.add(radar);
  const radarPole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 17, 12), mats.metal); radarPole.position.set(twX + 40, 8.5, tZ - 20); grp.add(radarPole);
  // hangars
  if (big) {
    for (let h = 0; h < 2; h++) {
      const hx = apX - apW / 2 - 130 - h * 110, hz = apZ - 20;
      const body = new THREE.Mesh(new THREE.BoxGeometry(90, 18, 70), mats.hangar); body.position.set(hx, 9, hz); body.castShadow = true; body.receiveShadow = true; grp.add(body);
      const rf = new THREE.Mesh(new THREE.CylinderGeometry(45, 45, 70, 48, 1, false, Math.PI / 2, Math.PI), mats.hangarRoof);
      rf.rotation.x = Math.PI / 2; rf.scale.set(1, 1, 0.28); rf.position.set(hx, 18, hz); rf.castShadow = true; grp.add(rf);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(80, 16), mats.hangarDoor); door.position.set(hx, 8, hz + 35.05); grp.add(door);
    }
    // fuel farm
    for (let f = 0; f < 3; f++) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 14, 40), mats.tank);
      tank.position.set(apX + apW / 2 + 250 + f * 30, 7, tZ - 60); tank.castShadow = true; grp.add(tank);
    }
  }
  // windsock
  {
    const wx = -L / 2 + 300, wz = Wd / 2 + 60;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 8), mats.metal); pole.position.set(wx, 3.5, wz); grp.add(pole);
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.2, 3.6, 16, 1, true), mats.sock);
    sock.rotation.z = Math.PI / 2 - 0.15; sock.position.set(wx + 1.8, 6.6, wz); grp.add(sock);
  }
  // ILS: localizer array beyond far end, glideslope antenna
  {
    const locX = L / 2 + 300;
    const arr: THREE.BufferGeometry[] = [];
    for (let k = -8; k <= 8; k++) { const g = new THREE.BoxGeometry(0.2, 2.5, 0.2); g.translate(locX, 1.25, k * 2.2); arr.push(g); }
    const bar = new THREE.BoxGeometry(0.3, 0.3, 36); bar.translate(locX, 2.4, 0); arr.push(bar);
    grp.add(new THREE.Mesh(mergeGeometries(arr), mats.redWhite));
    const gs = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 14, 8), mats.redWhite); gs.position.set(-L / 2 + 300, 7, Wd / 2 + 130); grp.add(gs);
    const hut = new THREE.Mesh(new THREE.BoxGeometry(3, 2.6, 3), mats.facade); hut.position.set(-L / 2 + 305, 1.3, Wd / 2 + 130); grp.add(hut);
  }

  /* ----------- lights ----------- */
  const addLight = (x: number, y: number, z: number, c: THREE.Color) => {
    const p = toWorld(x, y, z);
    lightPts.pos.push(p.x, p.y, p.z); lightPts.col.push(c.r, c.g, c.b);
  };
  const W_ = new THREE.Color(1.0, 0.92, 0.75), Y_ = new THREE.Color(1, 0.75, 0.2), R_ = new THREE.Color(1, 0.12, 0.08), G_ = new THREE.Color(0.2, 1, 0.35), B_ = new THREE.Color(0.25, 0.4, 1);
  const stubs: THREE.Vector3[] = [];
  for (let x = -L / 2; x <= L / 2 + 0.1; x += 60) for (const s of [-1, 1]) {
    const cc = x > L / 2 - 600 ? Y_ : W_;
    addLight(x, 0.45, s * (Wd / 2 + 1.5), cc); stubs.push(new THREE.Vector3(x, 0, s * (Wd / 2 + 1.5)));
  }
  for (let x = -L / 2 + 7.5; x < L / 2; x += 15) {
    const rem = L / 2 - x;
    const cc = rem < 300 ? R_ : rem < 900 ? (Math.round(x / 15) % 2 ? R_ : W_) : W_;
    addLight(x, 0.12, 0, cc);
  }
  for (let z = -Wd / 2 - 4; z <= Wd / 2 + 4; z += 3) { addLight(-L / 2 - 1, 0.35, z, G_); addLight(L / 2 + 1, 0.35, z, R_); }
  for (let x = -L / 2 + 20; x < L / 2; x += 45) for (const s of [-1, 1]) addLight(x, 0.35, twZ + s * 13, B_);
  // approach lighting system
  const alsPoles: THREE.Vector3[] = [];
  for (let d = 30; d <= 900; d += 30) {
    for (let k = -2; k <= 2; k++) addLight(-L / 2 - d, 1.2 + d * 0.004, k * 1.0, W_);
    alsPoles.push(new THREE.Vector3(-L / 2 - d, 0, 0));
    if (d === 300) for (let k = -7; k <= 7; k++) if (Math.abs(k) > 2) addLight(-L / 2 - d, 2.4, k * 1.5, W_);
    if (d <= 270 && d >= 60) for (const s of [-1, 1]) for (let k = 0; k < 3; k++) addLight(-L / 2 - d, 1.4, s * (6 + k * 1.5), R_);
  }
  // stubs + poles
  const stubG = new THREE.CylinderGeometry(0.07, 0.09, 0.45, 8); stubG.translate(0, 0.225, 0);
  const stubsM = new THREE.InstancedMesh(stubG, mats.yellowPaint, stubs.length);
  const mtx = new THREE.Matrix4();
  stubs.forEach((p, i) => { mtx.makeTranslation(p.x, p.y, p.z); stubsM.setMatrixAt(i, mtx); });
  grp.add(stubsM);
  const poleG = new THREE.BoxGeometry(0.15, 1, 0.15); poleG.translate(0, 0.5, 0);
  const polesM = new THREE.InstancedMesh(poleG, mats.redWhite, alsPoles.length * 2);
  alsPoles.forEach((p, i) => {
    mtx.compose(new THREE.Vector3(p.x, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1.2 + (Math.abs(p.x) - L / 2) * 0.004, 1)); polesM.setMatrixAt(i * 2, mtx);
    mtx.compose(new THREE.Vector3(p.x, 1.1 + (Math.abs(p.x) - L / 2) * 0.004, 0), new THREE.Quaternion(), new THREE.Vector3(1, 0.1, 30)); polesM.setMatrixAt(i * 2 + 1, mtx);
  });
  grp.add(polesM);

  // PAPI (left of runway 09 at 300m)
  const papiPos: THREE.Vector3[] = [];
  const papiG = new THREE.BufferGeometry();
  const pp: number[] = [], pc: number[] = [];
  for (let k = 0; k < 4; k++) {
    const lx = -L / 2 + 300, lz = -(Wd / 2 + 15 + k * 9);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.6), mats.facade); box.position.set(lx, 0.6, lz); grp.add(box);
    const w = toWorld(lx - 0.8, 0.8, lz);
    papiPos.push(w); pp.push(w.x, w.y, w.z); pc.push(1, 1, 1);
  }
  papiG.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
  papiG.setAttribute("color", new THREE.Float32BufferAttribute(pc, 3));
  const papiM = new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: mats.glowMap ? (mats.glowMap as THREE.SpriteMaterial).map : null, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const papi = new THREE.Points(papiG, papiM); papi.frustumCulled = false; scene.add(papi);
  // sequenced flasher (rabbit)
  const rabG = new THREE.BufferGeometry();
  rabG.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const rabM = new THREE.PointsMaterial({ size: 26, sizeAttenuation: false, map: papiM.map, color: "#e8f0ff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const rabbit = new THREE.Points(rabG, rabM); rabbit.frustumCulled = false; scene.add(rabbit);
  const fr = runwayFrame(a, 0);
  const angles = [3.5, 3.17, 2.83, 2.5];
  // parked aircraft: one InstancedMesh per baked material part, shared geometry
  const parkedMeshes: THREE.InstancedMesh[] = [];
  if (parkedAt.length) {
    const pm = new THREE.Matrix4();
    for (const part of parked) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, parkedAt.length);
      parkedAt.forEach((p, i) => im.setMatrixAt(i, pm.makeTranslation(p.x, p.y, p.z)));
      im.castShadow = part.cast; im.receiveShadow = part.receive; im.renderOrder = part.renderOrder;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      grp.add(im);
      parkedMeshes.push(im);
    }
  }
  mergeStatic(grp);
  const sd = new THREE.Vector3(), sw = new THREE.Vector3();
  const papiState = [-1, -1, -1, -1];
  const rabPos = rabG.attributes.position as THREE.BufferAttribute;
  return {
    update(time, acPos, day, camPos) {
      const near = Math.hypot(camPos.x - a.x, camPos.z - a.z) < 14000;
      for (const m of parkedMeshes) m.visible = near;
      const col = papiG.attributes.color as THREE.BufferAttribute;
      let dirty = false;
      for (let k = 0; k < papiPos.length; k++) {
        sd.copy(acPos).sub(papiPos[k]);
        const horiz = Math.max(1, -sd.dot(fr.fwd));
        const ang = Math.atan2(sd.y - 1.5, horiz) / D2R;
        const st = ang > angles[k] ? 1 : 0;
        if (st !== papiState[k]) { papiState[k] = st; dirty = true; if (st) col.setXYZ(k, 1, 0.95, 0.9); else col.setXYZ(k, 1, 0.1, 0.05); }
      }
      if (dirty) col.needsUpdate = true;
      papiM.opacity = 0.55 + (1 - day) * 0.45;
      const cycle = (time * 2) % 1;
      const idx = Math.floor(cycle * 24);
      const d = 900 - idx * 25;
      if (d >= 300) {
        sw.set(-L / 2 - d, 2.2, 0).applyMatrix4(grp.matrixWorld);
        rabPos.setXYZ(0, sw.x, sw.y, sw.z);
        rabPos.needsUpdate = true;
        rabbit.visible = true;
      } else rabbit.visible = false;
      rabM.opacity = 0.6 + (1 - day) * 0.4;
    },
  };
}

/* ---------------------------------------------------------------------- */
/** Tree crown: deformed icosahedron (detail 0/1) or octahedron, vertex colour = white. */
function crownGeometry(kind: "ico1" | "ico0" | "octa") {
  const crown = kind === "octa" ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, kind === "ico1" ? 1 : 0);
  const pos = crown.attributes.position as THREE.BufferAttribute;
  const rnd = mulberry(3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const s = 0.85 + rnd() * 0.3;
    pos.setXYZ(i, pos.getX(i) * s * (1 - y * 0.25), y * 1.4 * s, pos.getZ(i) * s * (1 - y * 0.25));
  }
  crown.translate(0, 2.3, 0);
  crown.computeVertexNormals();
  crown.deleteAttribute("uv");
  crown.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  return crown;
}

/** Near tree: 80-face crown + open 5-sided trunk. */
function treeGeometry() {
  const crown = crownGeometry("ico1");
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.6, 5, 1, true); trunk.translate(0, 0.8, 0);
  const tc = new Float32Array(trunk.attributes.position.count * 3);
  for (let i = 0; i < tc.length; i += 3) { tc[i] = 0.45; tc[i + 1] = 0.35; tc[i + 2] = 0.3; }
  trunk.setAttribute("color", new THREE.BufferAttribute(tc, 3));
  trunk.deleteAttribute("uv");
  return mergeGeometries([crown, trunk.toNonIndexed()])!;
}

function nearAirport(x: number, z: number, margin: number) {
  for (const a of AIRPORTS) if (Math.abs(x - a.x) < a.length / 2 + 1400 + margin && Math.abs(z - a.z) < 700 + margin) return true;
  return false;
}

/* ---------------------------------------------------------------------- */
/** Spatial bins of instance matrices / colours -> one InstancedMesh (per LOD) per cell so frustum culling works. */
class InstanceBins {
  cells = new Map<number, { m: number[]; c: number[] }>();
  constructor(private cell: number) {}
  add(m: THREE.Matrix4, c: THREE.Color) {
    const e = m.elements;
    const key = (Math.floor(e[12] / this.cell) + 512) * 4096 + Math.floor(e[14] / this.cell) + 512;
    let b = this.cells.get(key); if (!b) this.cells.set(key, b = { m: [], c: [] });
    for (let i = 0; i < 16; i++) b.m.push(e[i]);
    b.c.push(c.r, c.g, c.b);
  }
}
interface LodChunk { cx: number; cy: number; cz: number; r: number; meshes: THREE.InstancedMesh[] }

function buildChunks(bins: InstanceBins, geoms: THREE.BufferGeometry[], mat: THREE.Material, flags: { cast: boolean; recv: boolean }[], parent: THREE.Object3D): LodChunk[] {
  const out: LodChunk[] = [];
  for (const b of bins.cells.values()) {
    const n = b.c.length / 3;
    const im = new THREE.InstancedBufferAttribute(new Float32Array(b.m), 16);
    const ic = new THREE.InstancedBufferAttribute(new Float32Array(b.c), 3);
    const meshes = geoms.map((g, k) => {
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.instanceMatrix = im; mesh.instanceColor = ic;
      mesh.castShadow = flags[k].cast; mesh.receiveShadow = flags[k].recv; mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      return mesh;
    });
    meshes[0].computeBoundingSphere();
    const s = meshes[0].boundingSphere!;
    for (const m of meshes) m.boundingSphere = s;
    out.push({ cx: s.center.x, cy: s.center.y, cz: s.center.z, r: s.radius, meshes });
  }
  return out;
}

function updateChunks(chunks: LodChunk[], cam: THREE.Vector3, ranges: number[], maxD: number) {
  for (const ch of chunks) {
    const dx = cam.x - ch.cx, dy = cam.y - ch.cy, dz = cam.z - ch.cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - ch.r;
    let l = -1;
    if (d < maxD) { l = ranges.length; for (let i = 0; i < ranges.length; i++) if (d < ranges[i]) { l = i; break; } }
    for (let k = 0; k < ch.meshes.length; k++) ch.meshes[k].visible = k === l;
  }
}

/* ---------------------------------------------------------------------- */
export interface ParkedPart { geometry: THREE.BufferGeometry; material: THREE.Material; cast: boolean; receive: boolean; renderOrder: number }
export interface ParkedTemplate { parts: ParkedPart[]; stats: { meshes: number; interiorMeshes: number; dropped: number; parts: number; triangles: number } }

/** Bake the exterior of an aircraft root into merged geometry grouped by material. Only the first child of
 *  the root (exterior group) is used; interior (back-faced lining, anything else), lights, sprites and
 *  emissive bulbs are left out. */
export function bakeParked(root: THREE.Object3D): ParkedTemplate {
  const tpl = root.clone(true);
  tpl.position.set(0, 0, 0); tpl.quaternion.identity(); tpl.scale.set(1, 1, 1);
  tpl.updateMatrixWorld(true);
  const stats = { meshes: 0, interiorMeshes: 0, dropped: 0, parts: 0, triangles: 0 };
  tpl.children.forEach((c, i) => { if (i > 0) c.traverse((o) => { if ((o as THREE.Mesh).isMesh) stats.interiorMeshes++; }); });
  const ext = tpl.children[0];
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; ro: number; geoms: THREE.BufferGeometry[] }>();
  const isBulb = (mt: THREE.Material, g: THREE.BufferGeometry) => (mt as THREE.MeshBasicMaterial).isMeshBasicMaterial && mt.toneMapped === false && g.type !== "PlaneGeometry";
  const tmp = new THREE.Matrix4();
  const bake = (m: THREE.Mesh, mw: THREE.Matrix4) => {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const src = m.geometry;
    const g = src.clone();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv" && k !== "uv1" && k !== "color") g.deleteAttribute(k);
    g.morphAttributes = {};
    if (!g.attributes.normal) g.computeVertexNormals();
    const cnt = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(cnt * 2), 2));
    if (!g.index) g.setIndex(Array.from({ length: cnt }, (_, i) => i));
    g.applyMatrix4(mw);
    if (mw.determinant() < 0) { const ix = g.index!.array as Uint16Array | Uint32Array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
    const ranges = src.groups.length && Array.isArray(m.material) ? src.groups.map((gr) => ({ s: gr.start, c: gr.count, mi: gr.materialIndex ?? 0 })) : [{ s: 0, c: g.index!.count, mi: 0 }];
    for (const r of ranges) {
      const mt = mats[r.mi];
      if (!mt || isBulb(mt, src) || mt.side === THREE.BackSide) { stats.dropped++; continue; }
      const sub = ranges.length === 1 ? g : new THREE.BufferGeometry();
      if (sub !== g) {
        for (const k of Object.keys(g.attributes)) sub.setAttribute(k, g.attributes[k]);
        sub.setIndex(Array.from((g.index!.array as Uint32Array).subarray(r.s, r.s + r.c)));
      }
      const key = `${mt.uuid}|${m.renderOrder}|${+m.castShadow}${+m.receiveShadow}`;
      let b = buckets.get(key); if (!b) buckets.set(key, b = { mat: mt, cast: m.castShadow, recv: m.receiveShadow, ro: m.renderOrder, geoms: [] });
      b.geoms.push(sub);
    }
  };
  ext.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) { stats.dropped++; return; }
    stats.meshes++;
    if ((m as THREE.InstancedMesh).isInstancedMesh) {
      const im = m as THREE.InstancedMesh;
      for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, tmp); bake(m, tmp.premultiply(m.matrixWorld)); }
    } else bake(m, m.matrixWorld);
  });
  const parts: ParkedPart[] = [];
  for (const b of buckets.values()) {
    const cnt = b.mat.vertexColors;
    const opt = b.geoms.some((g) => g.attributes.uv1);
    for (const g of b.geoms) {
      const n = g.attributes.position.count;
      if (opt && !g.attributes.uv1) g.setAttribute("uv1", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
      if (cnt) {
        const c = g.attributes.color;
        if (!c) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
        else if (c.itemSize !== 3) { const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i); } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); }
      } else g.deleteAttribute("color");
    }
    const merged = mergeGeometries(b.geoms, false);
    if (!merged) { stats.dropped += b.geoms.length; continue; }
    merged.computeBoundingSphere();
    stats.triangles += merged.index!.count / 3;
    parts.push({ geometry: merged, material: b.mat, cast: b.cast, receive: b.recv, renderOrder: b.ro });
  }
  stats.parts = parts.length;
  return { parts, stats };
}

/* ---------------------------------------------------------------------- */
export type ShadowMode = "deck" | "cabin" | "exterior";
const SHADOW_MODES: Record<ShadowMode, { half: number; near: number; far: number; bias: number; normalBias: number; off: [number, number, number] }> = {
  deck: { half: 10, near: 200, far: 1000, bias: -0.00004, normalBias: 0.015, off: [0, 0.8, -14.2] },
  cabin: { half: 26, near: 10, far: 1200, bias: -0.0002, normalBias: 0.03, off: [0, 0, 1] },
  exterior: { half: 60, near: 10, far: 1200, bias: -0.0003, normalBias: 0.06, off: [0, 0, 0] },
};

/* ---------------------------------------------------------------------- */
export function buildWorld(parked: ParkedTemplate): World {
  const scene = new THREE.Scene();
  const sky = new Sky();
  sky.scale.setScalar(250000);
  const skyU = sky.material.uniforms;
  skyU.mieCoefficient.value = 0.004;
  skyU.mieDirectionalG.value = 0.82;
  if (skyU.cloudCoverage) { skyU.cloudCoverage.value = 0.35; skyU.cloudDensity.value = 0.35; skyU.cloudScale.value = 0.00012; }
  // drawn after all opaque geometry: with depth testing on, covered sky pixels are rejected before the (expensive) sky shader runs.
  // The sky sits at the far plane: depth 1 (standard) or 0 (reversed depth buffer).
  sky.material.vertexShader = sky.material.vertexShader.replace("gl_Position.z = gl_Position.w; // set z to camera.far",
    "#ifdef USE_REVERSED_DEPTH_BUFFER\n gl_Position.z = 0.0;\n #else\n gl_Position.z = gl_Position.w;\n #endif");
  sky.renderOrder = 1000;
  scene.add(sky);

  const sun = new THREE.DirectionalLight("#fff4e5", 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  scene.add(sun, sun.target);
  let shadowMode: ShadowMode | null = null;
  const shadowOff = new THREE.Vector3();
  const setShadowMode = (m: ShadowMode) => {
    if (m === shadowMode) return;
    shadowMode = m;
    const c = SHADOW_MODES[m];
    sc.left = -c.half; sc.right = c.half; sc.top = c.half; sc.bottom = -c.half; sc.near = c.near; sc.far = c.far;
    sc.updateProjectionMatrix();
    sun.shadow.bias = c.bias; sun.shadow.normalBias = c.normalBias;
    shadowOff.set(...c.off);
  };
  setShadowMode("exterior");
  const hemi = new THREE.HemisphereLight("#bcd4ff", "#4a4535", 0.6);
  scene.add(hemi);
  const fog = new THREE.FogExp2("#b9c9da", 1 / 42000);
  scene.fog = fog;

  // terrain + water
  const terrain = buildTerrainMesh();
  scene.add(terrain.mesh);
  const wn = waterNormalTexture();
  wn.repeat.set(1800, 1800);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN.size, TERRAIN.size).rotateX(-Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: "#123447", roughness: 0.06, metalness: 0, normalMap: wn, normalScale: new THREE.Vector2(0.4, 0.4), clearcoat: 0.5, envMapIntensity: 1.2 }));
  water.position.set(TERRAIN.cx, WATER_LEVEL, TERRAIN.cz);
  water.receiveShadow = true;
  scene.add(water);
  const wn2 = wn.clone(); wn2.repeat.set(9000, 9000);
  const farRing = new THREE.Mesh(new THREE.RingGeometry(TERRAIN.size * 0.7, 400000, 64, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#3e5230", roughness: 1 }));
  farRing.position.set(TERRAIN.cx, -30, TERRAIN.cz);
  scene.add(farRing);

  // shared materials
  const glowMap = glowTexture();
  const grassTex = grassDetailTexture();
  const mats: Record<string, THREE.Material> = {
    asphalt: new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.88, metalness: 0 }),
    concrete: new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.85 }),
    grass: new THREE.MeshStandardMaterial({ map: grassTex, color: "#6f8c47", roughness: 1 }),
    paint: new THREE.MeshStandardMaterial({ color: "#eeeeea", roughness: 0.65 }),
    yellow: new THREE.MeshStandardMaterial({ color: "#e3b12a", roughness: 0.65 }),
    yellowPaint: new THREE.MeshStandardMaterial({ color: "#d9a520", roughness: 0.5 }),
    facade: new THREE.MeshStandardMaterial({ color: "#c9ccd0", roughness: 0.6, metalness: 0.1 }),
    roof: new THREE.MeshStandardMaterial({ color: "#8a8e93", roughness: 0.8 }),
    roofEdge: new THREE.MeshStandardMaterial({ color: "#dfe2e5", roughness: 0.4, metalness: 0.5 }),
    glassFacade: new THREE.MeshPhysicalMaterial({ color: "#6b8799", metalness: 0.85, roughness: 0.06, envMapIntensity: 1.5 }),
    towerGlass: new THREE.MeshPhysicalMaterial({ color: "#3d5a6b", metalness: 0.9, roughness: 0.05, envMapIntensity: 1.6, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ color: "#a7abb0", metalness: 0.8, roughness: 0.35 }),
    bridge: new THREE.MeshStandardMaterial({ color: "#d6d9dc", metalness: 0.6, roughness: 0.3 }),
    hangar: new THREE.MeshStandardMaterial({ color: "#b9bec4", metalness: 0.5, roughness: 0.45 }),
    hangarRoof: new THREE.MeshStandardMaterial({ color: "#8e959c", metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }),
    hangarDoor: new THREE.MeshStandardMaterial({ color: "#5a646e", metalness: 0.6, roughness: 0.5 }),
    tank: new THREE.MeshStandardMaterial({ color: "#eef0f2", metalness: 0.4, roughness: 0.35 }),
    sock: new THREE.MeshStandardMaterial({ color: "#ff6a00", roughness: 0.8, side: THREE.DoubleSide }),
    redWhite: new THREE.MeshStandardMaterial({ color: "#d8452e", roughness: 0.6 }),
    gse: new THREE.MeshStandardMaterial({ color: "#f0c419", roughness: 0.5 }),
    tireMap: new THREE.MeshBasicMaterial({ map: tireMarksTexture() }),
    glowMap: new THREE.SpriteMaterial({ map: glowMap }),
  };
  const lightPts = { pos: [] as number[], col: [] as number[] };
  const airports = AIRPORTS.map((a, i) => buildAirport(scene, a, i === 0, mats, parked.parts, lightPts));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(lightPts.pos, 3));
  lg.setAttribute("color", new THREE.Float32BufferAttribute(lightPts.col, 3));
  const lightMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: glowMap, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const lightsObj = new THREE.Points(lg, lightMat);
  lightsObj.frustumCulled = false;
  scene.add(lightsObj);

  // trees: binned into 2.5 km cells, three LODs per cell (80 faces / 20 faces / octahedron), culled beyond ~20 km
  const rnd = mulberry(2024);
  const treeM = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.95 });
  const NT = 14000;
  const treeBins = new InstanceBins(2500);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const colr = new THREE.Color();
  let placed = 0, tries = 0;
  while (placed < NT && tries < NT * 12) {
    tries++;
    const x = -8000 + rnd() * 58000, z = -9000 + rnd() * 20000;
    if (fbm(x / 2600, z / 2600, 3) < 0.12) continue;
    if (nearAirport(x, z, 150)) continue;
    const h = heightAt(x, z);
    if (h < 1 || h > 900) continue;
    for (let c = 0; c < 6 && placed < NT; c++) {
      const xx = x + (rnd() - 0.5) * 90, zz = z + (rnd() - 0.5) * 90;
      if (nearAirport(xx, zz, 100)) continue;
      const s = 5 + rnd() * 7;
      pv.set(xx, heightAt(xx, zz) - 0.3, zz);
      q.setFromAxisAngle(yAxis, rnd() * 6.28);
      sv.set(s * (0.8 + rnd() * 0.4), s * (0.9 + rnd() * 0.5), s * (0.8 + rnd() * 0.4));
      m4.compose(pv, q, sv);
      colr.setHSL(0.24 + rnd() * 0.08, 0.35 + rnd() * 0.25, 0.14 + rnd() * 0.1);
      treeBins.add(m4, colr);
      placed++;
    }
  }
  const treeGroup = new THREE.Group();
  treeGroup.matrixAutoUpdate = false;
  const treeChunks = buildChunks(treeBins, [treeGeometry(), crownGeometry("ico0"), crownGeometry("octa")], treeM,
    [{ cast: true, recv: true }, { cast: true, recv: true }, { cast: false, recv: false }], treeGroup);
  scene.add(treeGroup);

  // city near Bayview + town near Aurora
  const facade = buildingFacadeTexture(3);
  const glowW = windowGlowTexture(3);
  const bMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.55, metalness: 0.25, emissive: "#ffd9a0", emissiveMap: glowW, emissiveIntensity: 0 });
  bMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
      #ifdef USE_INSTANCING
        vec2 bsc = vec2(length(instanceMatrix[0].xyz) / 38.0, length(instanceMatrix[1].xyz) / 75.0);
        vMapUv *= bsc;
        vEmissiveMapUv *= bsc;
      #endif`);
  };
  const roofG = new THREE.BoxGeometry(1, 1, 1); roofG.translate(0, 0.5, 0);
  const NB = 2600;
  const bldBins = new InstanceBins(2500);
  let nb = 0;
  const cities = [{ x: 45500, z: 8200, r: 3200, tall: true }, { x: -2500, z: 5200, r: 1500, tall: false }, { x: 20000, z: 4800, r: 900, tall: false }];
  for (const c of cities) {
    const count = c.tall ? 1700 : c.r > 1000 ? 600 : 300;
    for (let i = 0; i < count && nb < NB; i++) {
      const ang = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.7) * c.r;
      let x = c.x + Math.cos(ang) * rr, z = c.z + Math.sin(ang) * rr;
      x = Math.round(x / 40) * 40 + (rnd() - 0.5) * 6; z = Math.round(z / 40) * 40 + (rnd() - 0.5) * 6;
      if (nearAirport(x, z, 300)) continue;
      const h0 = heightAt(x, z);
      if (h0 < 0.5) continue;
      const centre = 1 - rr / c.r;
      const hgt = c.tall && centre > 0.75 && rnd() > 0.5 ? 60 + rnd() * 160 : 6 + rnd() * (10 + centre * 30);
      const w = 14 + rnd() * 18, d = 14 + rnd() * 18;
      m4.compose(pv.set(x, h0 - 0.5, z), q.setFromAxisAngle(yAxis, 0), sv.set(w, hgt, d));
      colr.setHSL(0.08 + rnd() * 0.5, 0.05 + rnd() * 0.1, 0.55 + rnd() * 0.35);
      bldBins.add(m4, colr);
      nb++;
    }
  }
  const bldGroup = new THREE.Group();
  bldGroup.matrixAutoUpdate = false;
  const bldChunks = buildChunks(bldBins, [roofG], bMat, [{ cast: true, recv: true }], bldGroup);
  scene.add(bldGroup);

  // clouds: one instanced camera-facing octagon per puff, re-sorted back to front at a low rate
  const puff = softPuffTexture(5);
  const cp: number[] = [], cs: number[] = [], ct: number[] = [];
  for (let c = 0; c < 55; c++) {
    const cx = -15000 + rnd() * 75000, cz = -22000 + rnd() * 44000, cy = 1500 + rnd() * 700;
    if (Math.abs(cz - 1600) < 2500 && cx > -3000 && cx < 44000 && rnd() < 0.6) continue;
    const n = 8 + Math.floor(rnd() * 10);
    const size = 350 + rnd() * 450;
    for (let i = 0; i < n; i++) {
      const ox = (rnd() - 0.5) * size * 2.2, oz = (rnd() - 0.5) * size * 1.6, oy = rnd() * size * 0.45 * (1 - Math.abs(ox) / (size * 1.2));
      cp.push(cx + ox, cy + oy, cz + oz);
      const ss = size * (0.7 + rnd() * 0.8) * (1 - Math.abs(ox) / (size * 2.4));
      cs.push(ss, ss * 0.8);
      ct.push(i % 3);
    }
  }
  const NC = ct.length;
  const cloudGeo = new THREE.InstancedBufferGeometry();
  {
    const R = 0.5 / Math.cos(Math.PI / 8), p: number[] = [0, 0, 0], u: number[] = [0.5, 0.5], ix: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + k * Math.PI / 4, x = Math.cos(a) * R, y = Math.sin(a) * R;
      p.push(x, y, 0); u.push(x + 0.5, y + 0.5);
      ix.push(0, 1 + k, 1 + (k + 1) % 8);
    }
    cloudGeo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    cloudGeo.setAttribute("uv", new THREE.Float32BufferAttribute(u, 2));
    cloudGeo.setIndex(ix);
  }
  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(NC * 3), 3);
  const aSize = new THREE.InstancedBufferAttribute(new Float32Array(NC * 2), 2);
  const aTint = new THREE.InstancedBufferAttribute(new Float32Array(NC), 1);
  aPos.setUsage(THREE.DynamicDrawUsage); aSize.setUsage(THREE.DynamicDrawUsage); aTint.setUsage(THREE.DynamicDrawUsage);
  cloudGeo.setAttribute("iPos", aPos); cloudGeo.setAttribute("iSize", aSize); cloudGeo.setAttribute("iTint", aTint);
  cloudGeo.instanceCount = NC;
  const cloudTints = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const cloudU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog) as Record<string, THREE.IUniform>;
  cloudU.map = { value: puff }; cloudU.tints = { value: cloudTints }; cloudU.opacity = { value: 0.85 };
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: cloudU, transparent: true, depthWrite: false, fog: true,
    vertexShader: `
      attribute vec3 iPos; attribute vec2 iSize; attribute float iTint;
      varying vec2 vUv; varying float vTint;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vTint = iTint;
        vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
        mvPosition.xy += position.xy * iSize;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform vec3 tints[3]; uniform float opacity;
      varying vec2 vUv; varying float vTint;
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(tints[int(vTint + 0.5)] * t.rgb, t.a * opacity);
        #include <fog_fragment>
      }`,
  });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.frustumCulled = false; clouds.matrixAutoUpdate = false;
  scene.add(clouds);
  const cOrder = new Uint16Array(NC), cKey = new Float32Array(NC);
  for (let i = 0; i < NC; i++) cOrder[i] = i;
  const cCmp = (a: number, b: number) => cKey[b] - cKey[a];
  let cloudTimer = 1e9;
  const sortClouds = (cam: THREE.Vector3) => {
    for (let i = 0; i < NC; i++) { const dx = cp[i * 3] - cam.x, dy = cp[i * 3 + 1] - cam.y, dz = cp[i * 3 + 2] - cam.z; cKey[i] = dx * dx + dy * dy + dz * dz; }
    cOrder.sort(cCmp);
    const pa = aPos.array as Float32Array, sa = aSize.array as Float32Array, ta = aTint.array as Float32Array;
    for (let k = 0; k < NC; k++) {
      const i = cOrder[k];
      pa[k * 3] = cp[i * 3]; pa[k * 3 + 1] = cp[i * 3 + 1]; pa[k * 3 + 2] = cp[i * 3 + 2];
      sa[k * 2] = cs[i * 2]; sa[k * 2 + 1] = cs[i * 2 + 1]; ta[k] = ct[i];
    }
    aPos.needsUpdate = true; aSize.needsUpdate = true; aTint.needsUpdate = true;
  };

  // stars
  const starG = new THREE.BufferGeometry();
  const sp: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
    const y = Math.abs(u);
    const r = Math.sqrt(1 - y * y);
    sp.push(Math.cos(th) * r * 180000, y * 180000, Math.sin(th) * r * 180000);
  }
  starG.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
  const starM = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, color: "#ffffff", transparent: true, opacity: 0, fog: false, depthWrite: false });
  const stars = new THREE.Points(starG, starM);
  stars.frustumCulled = false;
  scene.add(stars);

  const lensflareAnchor = new THREE.Object3D();
  scene.add(lensflareAnchor);

  // env map
  const envScene = new THREE.Scene();
  const envSky = new Sky(); envSky.scale.setScalar(900);
  envScene.add(envSky);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(800, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#4b5540" }));
  envGround.position.y = -20;
  envScene.add(envGround);
  let pmrem: THREE.PMREMGenerator | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;

  const sunDir = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
  let lodX = 1e9, lodY = 0, lodZ = 0;
  const world: World = {
    scene, sun, sunDir, dayFactor: 1, lensflareAnchor, setShadowMode,
    warm(renderer, camera) {
      terrain.mesh.traverse((o) => { o.visible = true; });
      for (const ch of treeChunks) for (const m of ch.meshes) m.visible = true;
      for (const ch of bldChunks) for (const m of ch.meshes) m.visible = true;
      renderer.compile(scene, camera);
      terrain.reset(); lodX = 1e9;
    },
    setTime(t, renderer) {
      const phi = (90 - t.elev) * D2R, theta = (180 - t.az) * D2R;
      sunDir.setFromSphericalCoords(1, phi, theta);
      skyU.sunPosition.value.copy(sunDir);
      skyU.turbidity.value = t.turbidity; skyU.rayleigh.value = t.rayleigh;
      const eu = envSky.material.uniforms;
      eu.sunPosition.value.copy(sunDir); eu.turbidity.value = t.turbidity; eu.rayleigh.value = t.rayleigh;
      eu.mieCoefficient.value = 0.004; eu.mieDirectionalG.value = 0.82;
      if (eu.showSunDisc) eu.showSunDisc.value = 0;
      const day = smoothstep(-7, 9, t.elev);
      world.dayFactor = day;
      const warm = smoothstep(0, 28, t.elev);
      sun.color.set(new THREE.Color("#ff9a55").lerp(new THREE.Color("#fff5e8"), warm));
      sun.intensity = 3.4 * smoothstep(-1.5, 8, t.elev) + (t.elev < 0 ? 0.12 : 0);
      if (t.elev < -1) { sun.color.set("#9fb4ff"); }
      hemi.intensity = 0.15 + 0.55 * day;
      hemi.color.set(new THREE.Color("#1b2640").lerp(new THREE.Color(warm > 0.5 ? "#bcd4ff" : "#f2c7a0"), day));
      hemi.groundColor.set(new THREE.Color("#0b0b0e").lerp(new THREE.Color("#4a4535"), day));
      const fogC = new THREE.Color("#0b1020").lerp(new THREE.Color(warm > 0.4 ? "#b7c8da" : "#d9b28f"), day);
      fog.color.copy(fogC);
      fog.density = 1 / lerp(30000, 45000, warm);
      envGround.material.color.set(new THREE.Color("#0a0b0c").lerp(new THREE.Color("#4b5540"), day));
      tmpC2.set("#1a2030").lerp(tmpC.set(warm > 0.4 ? "#ffffff" : "#ffd9bd"), day);
      for (let i = 0; i < 3; i++) cloudTints[i].copy(tmpC2).multiplyScalar(0.92 + i * 0.04);
      cloudU.opacity.value = 0.55 + day * 0.35;
      starM.opacity = 1 - smoothstep(-8, -2, t.elev);
      renderer.toneMappingExposure = lerp(0.9, 0.52, day);
      bMat.emissiveIntensity = (1 - day) * 1.6;
      lightMat.opacity = 0.35 + (1 - day) * 0.65;
      lightMat.size = lerp(11, 7, day);
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      if (envRT) envRT.dispose();
      envRT = pmrem.fromScene(envScene, 0, 1, 1000);
      scene.environment = envRT.texture;
      scene.environmentIntensity = lerp(0.25, 1, day);
    },
    update(time, dt, camPos, acPos, acQuat) {
      sky.position.copy(camPos);
      stars.position.copy(camPos);
      // shadow box follows the aircraft (flight deck in cockpit mode); the projection only changes with the mode
      tgt.copy(shadowOff).applyQuaternion(acQuat).add(acPos);
      sun.target.position.copy(tgt);
      sun.position.copy(tgt).addScaledVector(sunDir, 600);
      lensflareAnchor.position.copy(camPos).addScaledVector(sunDir, 150000);
      wn.offset.x = time * 0.004; wn.offset.y = time * 0.002;
      if (skyU.time) skyU.time.value = time;
      for (let i = 0; i < airports.length; i++) airports[i].update(time, acPos, world.dayFactor, camPos);
      if (Math.abs(camPos.x - lodX) + Math.abs(camPos.y - lodY) + Math.abs(camPos.z - lodZ) > 20) {
        lodX = camPos.x; lodY = camPos.y; lodZ = camPos.z;
        updateChunks(treeChunks, camPos, [500, 2500], 20000);
        updateChunks(bldChunks, camPos, [], 65000);
      }
      terrain.update(camPos);
      cloudTimer += dt;
      if (cloudTimer > 0.25) { cloudTimer = 0; sortClouds(camPos); }
    },
  };
  void tileNoise; void wn2;
  return world;
}
