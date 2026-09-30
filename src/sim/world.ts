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
  update: (time: number, dt: number, camPos: THREE.Vector3, acPos: THREE.Vector3) => void;
  lensflareAnchor: THREE.Object3D;
}

/* ---------------------------------------------------------------------- */
function buildTerrainMesh() {
  buildTerrain();
  const { N, size, cx, cz, heights } = TERRAIN;
  const r = N + 1;
  const pos = new Float32Array(r * r * 3);
  const uv = new Float32Array(r * r * 2);
  const col = new Float32Array(r * r * 3);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const k = j * r + i;
    const x = cx - size / 2 + (i / N) * size;
    const z = cz - size / 2 + (j / N) * size;
    const h = heights[k];
    pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
    uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
    const hx = heights[j * r + Math.min(N, i + 1)] - heights[j * r + Math.max(0, i - 1)];
    const hz = heights[Math.min(N, j + 1) * r + i] - heights[Math.max(0, j - 1) * r + i];
    const slope = Math.hypot(hx, hz) / (2 * size / N);
    const n = fbm(x / 1200, z / 1200, 3);
    const rock = clamp(smoothstep(0.35, 0.7, slope + n * 0.1) + smoothstep(700, 1200, h + n * 200), 0, 1);
    const snow = smoothstep(1350, 1700, h + n * 250) * (1 - smoothstep(0.9, 1.3, slope));
    const sand = smoothstep(4, -1, h) * (1 - rock);
    col[k * 3] = rock; col[k * 3 + 1] = snow; col[k * 3 + 2] = sand;
  }
  const idx = new Uint32Array(N * N * 6);
  let p = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * r + i, b = (j + 1) * r + i, c = (j + 1) * r + i + 1, d = j * r + i + 1;
    idx[p++] = a; idx[p++] = b; idx[p++] = d;
    idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
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
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
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

interface AirportRuntime { update: (time: number, acPos: THREE.Vector3, day: number) => void }

function buildAirport(scene: THREE.Scene, a: Airport, big: boolean, mats: Record<string, THREE.Material>, makeParked: () => THREE.Object3D, lightPts: { pos: number[]; col: number[] }): AirportRuntime {
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
      const pk = makeParked();
      const standZ = bz + 32;
      pk.position.copy(new THREE.Vector3(x, 3.45, standZ + 18.6));
      pk.rotation.y = 0; // nose north (toward terminal)
      grp.add(pk);
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
  return {
    update(time, acPos, day) {
      const col = papiG.attributes.color as THREE.BufferAttribute;
      papiPos.forEach((p, k) => {
        const d = acPos.clone().sub(p);
        const horiz = Math.max(1, -d.dot(fr.fwd));
        const ang = Math.atan2(d.y - 1.5, horiz) / D2R;
        if (ang > angles[k]) col.setXYZ(k, 1, 0.95, 0.9); else col.setXYZ(k, 1, 0.1, 0.05);
      });
      col.needsUpdate = true;
      papiM.opacity = 0.55 + (1 - day) * 0.45;
      const cycle = (time * 2) % 1;
      const idx = Math.floor(cycle * 24);
      const d = 900 - idx * 25;
      if (d >= 300) {
        const w = toWorld(-L / 2 - d, 2.2, 0);
        (rabG.attributes.position as THREE.BufferAttribute).setXYZ(0, w.x, w.y, w.z);
        rabG.attributes.position.needsUpdate = true;
        rabbit.visible = true;
      } else rabbit.visible = false;
      rabM.opacity = 0.6 + (1 - day) * 0.4;
    },
  };
}

/* ---------------------------------------------------------------------- */
function treeGeometry() {
  const crown = new THREE.IcosahedronGeometry(1, 2);
  const pos = crown.attributes.position as THREE.BufferAttribute;
  const rnd = mulberry(3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const s = 0.85 + rnd() * 0.3;
    pos.setXYZ(i, pos.getX(i) * s * (1 - y * 0.25), y * 1.4 * s, pos.getZ(i) * s * (1 - y * 0.25));
  }
  crown.translate(0, 2.3, 0);
  crown.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.6, 6); trunk.translate(0, 0.8, 0);
  const cc = new Float32Array(crown.attributes.position.count * 3).fill(1);
  crown.setAttribute("color", new THREE.BufferAttribute(cc, 3));
  const tc = new Float32Array(trunk.attributes.position.count * 3);
  for (let i = 0; i < tc.length; i += 3) { tc[i] = 0.45; tc[i + 1] = 0.35; tc[i + 2] = 0.3; }
  trunk.setAttribute("color", new THREE.BufferAttribute(tc, 3));
  trunk.deleteAttribute("uv"); crown.deleteAttribute("uv");
  return mergeGeometries([crown.toNonIndexed(), trunk.toNonIndexed()]);
}

function nearAirport(x: number, z: number, margin: number) {
  for (const a of AIRPORTS) if (Math.abs(x - a.x) < a.length / 2 + 1400 + margin && Math.abs(z - a.z) < 700 + margin) return true;
  return false;
}

/* ---------------------------------------------------------------------- */
export function buildWorld(makeParked: () => THREE.Object3D): World {
  const scene = new THREE.Scene();
  const sky = new Sky();
  sky.scale.setScalar(250000);
  const skyU = sky.material.uniforms;
  skyU.mieCoefficient.value = 0.004;
  skyU.mieDirectionalG.value = 0.82;
  if (skyU.cloudCoverage) { skyU.cloudCoverage.value = 0.35; skyU.cloudDensity.value = 0.35; skyU.cloudScale.value = 0.00012; }
  scene.add(sky);

  const sun = new THREE.DirectionalLight("#fff4e5", 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 1200;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight("#bcd4ff", "#4a4535", 0.6);
  scene.add(hemi);
  const fog = new THREE.FogExp2("#b9c9da", 1 / 42000);
  scene.fog = fog;

  // terrain + water
  const terrain = buildTerrainMesh();
  scene.add(terrain);
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
  const airports = AIRPORTS.map((a, i) => buildAirport(scene, a, i === 0, mats, makeParked, lightPts));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(lightPts.pos, 3));
  lg.setAttribute("color", new THREE.Float32BufferAttribute(lightPts.col, 3));
  const lightMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: glowMap, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const lightsObj = new THREE.Points(lg, lightMat);
  lightsObj.frustumCulled = false;
  scene.add(lightsObj);

  // trees
  const rnd = mulberry(2024);
  const treeG = treeGeometry();
  const treeM = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.95 });
  const NT = 14000;
  const trees = new THREE.InstancedMesh(treeG, treeM, NT);
  trees.castShadow = true; trees.receiveShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
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
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
      sv.set(s * (0.8 + rnd() * 0.4), s * (0.9 + rnd() * 0.5), s * (0.8 + rnd() * 0.4));
      m4.compose(pv, q, sv);
      trees.setMatrixAt(placed, m4);
      colr.setHSL(0.24 + rnd() * 0.08, 0.35 + rnd() * 0.25, 0.14 + rnd() * 0.1);
      trees.setColorAt(placed, colr);
      placed++;
    }
  }
  trees.count = placed;
  scene.add(trees);

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
  const bld = new THREE.InstancedMesh(roofG, bMat, NB);
  bld.castShadow = true; bld.receiveShadow = true;
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
      m4.compose(pv.set(x, h0 - 0.5, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0), sv.set(w, hgt, d));
      bld.setMatrixAt(nb, m4);
      colr.setHSL(0.08 + rnd() * 0.5, 0.05 + rnd() * 0.1, 0.55 + rnd() * 0.35);
      bld.setColorAt(nb, colr);
      nb++;
    }
  }
  bld.count = nb;
  scene.add(bld);

  // clouds
  const puff = softPuffTexture(5);
  const cloudGroup = new THREE.Group();
  const cloudMats: THREE.SpriteMaterial[] = [];
  for (let v = 0; v < 3; v++) cloudMats.push(new THREE.SpriteMaterial({ map: puff, color: "#ffffff", transparent: true, depthWrite: false, fog: true, opacity: 0.85 }));
  for (let c = 0; c < 55; c++) {
    const cx = -15000 + rnd() * 75000, cz = -22000 + rnd() * 44000, cy = 1500 + rnd() * 700;
    if (Math.abs(cz - 1600) < 2500 && cx > -3000 && cx < 44000 && rnd() < 0.6) continue;
    const n = 8 + Math.floor(rnd() * 10);
    const size = 350 + rnd() * 450;
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(cloudMats[i % 3]);
      const ox = (rnd() - 0.5) * size * 2.2, oz = (rnd() - 0.5) * size * 1.6, oy = rnd() * size * 0.45 * (1 - Math.abs(ox) / (size * 1.2));
      s.position.set(cx + ox, cy + oy, cz + oz);
      const ss = size * (0.7 + rnd() * 0.8) * (1 - Math.abs(ox) / (size * 2.4));
      s.scale.set(ss, ss * 0.8, 1);
      cloudGroup.add(s);
    }
  }
  scene.add(cloudGroup);

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
  const world: World = {
    scene, sun, sunDir, dayFactor: 1, lensflareAnchor,
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
      cloudMats.forEach((m, i) => {
        const base = new THREE.Color("#1a2030").lerp(new THREE.Color(warm > 0.4 ? "#ffffff" : "#ffd9bd"), day);
        m.color.copy(base).multiplyScalar(0.92 + i * 0.04);
        m.opacity = 0.55 + day * 0.35;
      });
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
    update(time, dt, camPos, acPos) {
      sky.position.copy(camPos);
      stars.position.copy(camPos);
      // shadow follows aircraft
      sun.target.position.copy(acPos);
      sun.position.copy(acPos).addScaledVector(sunDir, 600);
      lensflareAnchor.position.copy(camPos).addScaledVector(sunDir, 150000);
      wn.offset.x = time * 0.004; wn.offset.y = time * 0.002;
      if (skyU.time) skyU.time.value = time;
      airports.forEach((a) => a.update(time, acPos, world.dayFactor));
      void dt;
    },
  };
  void tileNoise; void wn2;
  return world;
}
