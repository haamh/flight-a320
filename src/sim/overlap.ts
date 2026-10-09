import * as THREE from "three";

/* ------------------------------------------------------------------ */
/*  Dev tool: finds solids that pass through each other.               */
/*                                                                    */
/*  Objects are meshes, the logical parts of merged meshes             */
/*  (userData.parts = [{ name, start, count }] as index ranges) and    */
/*  single instances of InstancedMeshes (userData.instanceNames).      */
/*  Two objects "overlap" when triangles of one cross triangles of    */
/*  the other and the crossing is deeper than `tol` (so seated /       */
/*  touching contacts are fine). Run via tools/overlap.mjs.            */
/* ------------------------------------------------------------------ */

export interface OverlapOptions {
  /** minimum penetration depth that counts, metres (default 1.5 mm) */
  tol?: number;
  /** restrict to meshes for which this returns true */
  filter?: (m: THREE.Mesh) => boolean;
  /** pairs whose names both match one of these entries are ignored: [regexA, regexB] */
  ignore?: [RegExp, RegExp][];
  /** report at most this many pairs (default 60) */
  max?: number;
}
/** depth = crossing-triangle poke (coarse: large triangles overstate it); vert = deepest vertex of one part below the other's surface (reliable up to ~8 cm) */
export interface OverlapHit { a: string; b: string; pairs: number; depth: number; vert: number; at: [number, number, number] }
export interface OverlapReport { objects: number; triangles: number; broadPairs: number; hits: OverlapHit[]; ms: number }

interface Obj { name: string; mesh: THREE.Mesh; pos: Float32Array; n: number; min: THREE.Vector3; max: THREE.Vector3; grid?: Map<number, number[]> }

const CELL = 0.04;
const cellKey = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

function pushTris(out: number[], g: THREE.BufferGeometry, m: THREE.Matrix4, from: number, count: number) {
  const p = g.attributes.position, idx = g.index, v = new THREE.Vector3();
  const total = idx ? idx.count : p.count;
  const end = Math.min(total, from + count);
  for (let i = from; i + 2 < end + 0; i += 3) {
    for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, idx ? idx.getX(i + k) : i + k).applyMatrix4(m); out.push(v.x, v.y, v.z); }
  }
}
function makeObj(name: string, mesh: THREE.Mesh, tris: number[]): Obj | null {
  if (tris.length < 9) return null;
  const pos = new Float32Array(tris), min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pos.length; i += 3) { min.x = Math.min(min.x, pos[i]); min.y = Math.min(min.y, pos[i + 1]); min.z = Math.min(min.z, pos[i + 2]); max.x = Math.max(max.x, pos[i]); max.y = Math.max(max.y, pos[i + 1]); max.z = Math.max(max.z, pos[i + 2]); }
  const c = (a: number, b: number) => ((a + b) / 2).toFixed(2);
  if (!/@/.test(name) && !name.includes(":")) name = `${name}@${c(min.x, max.x)},${c(min.y, max.y)},${c(min.z, max.z)}`;
  return { name, mesh, pos, n: pos.length / 9, min, max };
}

function collect(root: THREE.Object3D, opt: OverlapOptions): Obj[] {
  root.updateMatrixWorld(true);
  const objs: Obj[] = [];
  const mi = new THREE.Matrix4(), mw = new THREE.Matrix4(), inv = root.matrixWorld.clone().invert(), mwl = new THREE.Matrix4();   // work in the root's own frame (metres around the aircraft)
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || m.userData.noOverlap) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.every((x) => x && x.visible === false)) return;
    if (opt.filter && !opt.filter(m)) return;
    let anc: THREE.Object3D | null = m.parent; while (anc && !anc.name) anc = anc.parent;
    const base = m.name || `${anc ? anc.name + "/" : ""}${m.geometry.type.replace("Geometry", "")}`;
    const im = m as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      const names: string[] | undefined = m.userData.instanceNames;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, mi); mw.multiplyMatrices(mwl.multiplyMatrices(inv, m.matrixWorld), mi);
        if (mw.elements[0] === 0 && mw.elements[5] === 0 && mw.elements[10] === 0) continue;   // scaled to zero = hidden
        const t: number[] = []; pushTris(t, m.geometry, mw, 0, Infinity);
        const ob = makeObj(names?.[i] ?? `${base}#${i}`, m, t); if (ob) objs.push(ob);
      }
      return;
    }
    const parts: { name: string; start: number; count: number }[] | undefined = m.userData.parts;
    if (parts && parts.length) {
      for (const p of parts) { const t: number[] = []; pushTris(t, m.geometry, mwl.multiplyMatrices(inv, m.matrixWorld), p.start, p.count); const ob = makeObj(`${base}:${p.name}`, m, t); if (ob) objs.push(ob); }
    } else {
      const t: number[] = []; pushTris(t, m.geometry, mwl.multiplyMatrices(inv, m.matrixWorld), 0, Infinity);
      const ob = makeObj(base, m, t); if (ob) objs.push(ob);
    }
  });
  return objs;
}

function buildGrid(o: Obj) {
  const g = new Map<number, number[]>();
  const p = o.pos;
  for (let t = 0; t < o.n; t++) {
    const b = t * 9;
    const x0 = Math.floor(Math.min(p[b], p[b + 3], p[b + 6]) / CELL), x1 = Math.floor(Math.max(p[b], p[b + 3], p[b + 6]) / CELL);
    const y0 = Math.floor(Math.min(p[b + 1], p[b + 4], p[b + 7]) / CELL), y1 = Math.floor(Math.max(p[b + 1], p[b + 4], p[b + 7]) / CELL);
    const z0 = Math.floor(Math.min(p[b + 2], p[b + 5], p[b + 8]) / CELL), z1 = Math.floor(Math.max(p[b + 2], p[b + 5], p[b + 8]) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) continue;     // huge sliver: ignore for the broad grid
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = cellKey(x, y, z); const a = g.get(k); if (a) a.push(t); else g.set(k, [t]);
    }
  }
  o.grid = g;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _n = new THREE.Vector3();
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _ap = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _s2 = new THREE.Vector3();
/** closest point on triangle (Ericson) into _q */
function closest(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  _ab.subVectors(b, a); _ac.subVectors(c, a); _ap.subVectors(p, a);
  const d1 = _ab.dot(_ap), d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) return _q.copy(a);
  const bp = _t1.subVectors(p, b), d3 = _ab.dot(bp), d4 = _ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return _q.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return _q.copy(a).addScaledVector(_ab, d1 / (d1 - d3));
  const cp = _t1.subVectors(p, c), d5 = _ab.dot(cp), d6 = _ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return _q.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return _q.copy(a).addScaledVector(_ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return _q.copy(b).addScaledVector(_t2.subVectors(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  return _q.copy(a).addScaledVector(_ab, vb * den).addScaledVector(_ac, vc * den);
}
/** deepest vertex of P that lies below the nearest surface triangle of Q (within ~8 cm) */
function vertDepth(P: Obj, Q: Obj, reach = 2): { d: number; at: [number, number, number] } {
  if (!Q.grid) buildGrid(Q);
  const g = Q.grid!, qp = Q.pos;
  let best = 0, at: [number, number, number] = [0, 0, 0];
  const seen = new Set<number>();
  for (let i = 0; i < P.pos.length; i += 3) {
    const x = P.pos[i], y = P.pos[i + 1], z = P.pos[i + 2];
    if (x < Q.min.x - 0.1 || x > Q.max.x + 0.1 || y < Q.min.y - 0.1 || y > Q.max.y + 0.1 || z < Q.min.z - 0.1 || z > Q.max.z + 0.1) continue;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let bd = Infinity, sd = 0;
    seen.clear(); _p.set(x, y, z);
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
      const cell = g.get(cellKey(cx + dx, cy + dy, cz + dz)); if (!cell) continue;
      for (const u of cell) {
        if (seen.has(u)) continue; seen.add(u);
        const k = u * 9;
        _a.set(qp[k], qp[k + 1], qp[k + 2]); _b.set(qp[k + 3], qp[k + 4], qp[k + 5]); _c.set(qp[k + 6], qp[k + 7], qp[k + 8]);
        const pt = closest(_p, _a, _b, _c);
        const d = pt.distanceTo(_p);
        if (d < bd) { bd = d; _n.subVectors(_b, _a).cross(_s2.subVectors(_c, _a)).normalize(); sd = _n.dot(_t1.subVectors(_p, pt)); }
      }
    }
    if (bd < Infinity && sd < 0 && bd > best) { best = bd; at = [x, y, z]; }
  }
  return { d: best, at };
}

const EPS = 1e-9;
/** segment p0->p1 against triangle (a,b,c); returns parameter t in (0,1) or -1 */
function segTri(p: Float32Array, i0: number, i1: number, q: Float32Array, j: number): number {
  const dx = p[i1] - p[i0], dy = p[i1 + 1] - p[i0 + 1], dz = p[i1 + 2] - p[i0 + 2];
  const e1x = q[j + 3] - q[j], e1y = q[j + 4] - q[j + 1], e1z = q[j + 5] - q[j + 2];
  const e2x = q[j + 6] - q[j], e2y = q[j + 7] - q[j + 1], e2z = q[j + 8] - q[j + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < EPS) return -1;
  const inv = 1 / det;
  const sx = p[i0] - q[j], sy = p[i0 + 1] - q[j + 1], sz = p[i0 + 2] - q[j + 2];
  const u = (sx * hx + sy * hy + sz * hz) * inv; if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-6 && t < 1 - 1e-6 ? t : -1;
}
function triTri(a: Float32Array, i: number, b: Float32Array, j: number): boolean {
  if (segTri(a, i, i + 3, b, j) >= 0 || segTri(a, i + 3, i + 6, b, j) >= 0 || segTri(a, i + 6, i, b, j) >= 0) return true;
  return segTri(b, j, j + 3, a, i) >= 0 || segTri(b, j + 3, j + 6, a, i) >= 0 || segTri(b, j + 6, j, a, i) >= 0;
}
/** how far the smaller side of triangle a pokes through the plane of triangle b */
function poke(a: Float32Array, i: number, b: Float32Array, j: number): number {
  const e1x = b[j + 3] - b[j], e1y = b[j + 4] - b[j + 1], e1z = b[j + 5] - b[j + 2];
  const e2x = b[j + 6] - b[j], e2y = b[j + 7] - b[j + 1], e2z = b[j + 8] - b[j + 2];
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return 0; nx /= l; ny /= l; nz /= l;
  let pos = 0, neg = 0;
  for (let k = 0; k < 3; k++) { const d = (a[i + k * 3] - b[j]) * nx + (a[i + k * 3 + 1] - b[j + 1]) * ny + (a[i + k * 3 + 2] - b[j + 2]) * nz; if (d > 0) pos = Math.max(pos, d); else neg = Math.max(neg, -d); }
  return Math.min(pos, neg);
}

export function checkOverlaps(root: THREE.Object3D, opt: OverlapOptions = {}): OverlapReport {
  const t0 = performance.now();
  const tol = opt.tol ?? 0.0015, ign = opt.ignore ?? [];
  const objs = collect(root, opt);
  let tris = 0; for (const o of objs) tris += o.n;
  // sweep and prune on x
  const order = objs.map((_, i) => i).sort((a, b) => objs[a].min.x - objs[b].min.x);
  const hits = new Map<string, OverlapHit>();
  let broad = 0;
  const lo = new THREE.Vector3(), hi = new THREE.Vector3();
  for (let ii = 0; ii < order.length; ii++) {
    const A = objs[order[ii]];
    for (let jj = ii + 1; jj < order.length; jj++) {
      const B = objs[order[jj]];
      if (B.min.x > A.max.x + tol) break;
      if (A.min.y > B.max.y + tol || B.min.y > A.max.y + tol || A.min.z > B.max.z + tol || B.min.z > A.max.z + tol) continue;
      if (A.name === B.name) continue;
      if (ign.some(([ra, rb]) => (ra.test(A.name) && rb.test(B.name)) || (ra.test(B.name) && rb.test(A.name)))) continue;
      broad++;
      // narrow phase: iterate the smaller object's triangles inside the shared box, look them up in the other's grid
      const [S, L] = A.n <= B.n ? [A, B] : [B, A];
      if (!L.grid) buildGrid(L);
      lo.set(Math.max(S.min.x, L.min.x) - tol, Math.max(S.min.y, L.min.y) - tol, Math.max(S.min.z, L.min.z) - tol);
      hi.set(Math.min(S.max.x, L.max.x) + tol, Math.min(S.max.y, L.max.y) + tol, Math.min(S.max.z, L.max.z) + tol);
      const sp = S.pos, lp = L.pos, grid = L.grid!;
      let count = 0, depth = 0, ax = 0, ay = 0, az = 0, vert = 0;
      const seen = new Set<number>();
      for (let t = 0; t < S.n; t++) {
        const b = t * 9;
        const mnx = Math.min(sp[b], sp[b + 3], sp[b + 6]), mxx = Math.max(sp[b], sp[b + 3], sp[b + 6]);
        const mny = Math.min(sp[b + 1], sp[b + 4], sp[b + 7]), mxy = Math.max(sp[b + 1], sp[b + 4], sp[b + 7]);
        const mnz = Math.min(sp[b + 2], sp[b + 5], sp[b + 8]), mxz = Math.max(sp[b + 2], sp[b + 5], sp[b + 8]);
        if (mxx < lo.x || mnx > hi.x || mxy < lo.y || mny > hi.y || mxz < lo.z || mnz > hi.z) continue;
        const x0 = Math.floor(mnx / CELL), x1 = Math.floor(mxx / CELL), y0 = Math.floor(mny / CELL), y1 = Math.floor(mxy / CELL), z0 = Math.floor(mnz / CELL), z1 = Math.floor(mxz / CELL);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) continue;
        seen.clear();
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          const cell = grid.get(cellKey(x, y, z)); if (!cell) continue;
          for (const u of cell) {
            if (seen.has(u)) continue; seen.add(u);
            const c = u * 9;
            if (!triTri(sp, b, lp, c)) continue;
            const d = Math.min(poke(sp, b, lp, c), poke(lp, c, sp, b));
            if (d > tol) { count++; if (d > depth) { depth = d; ax = (sp[b] + sp[b + 3] + sp[b + 6]) / 3; ay = (sp[b + 1] + sp[b + 4] + sp[b + 7]) / 3; az = (sp[b + 2] + sp[b + 5] + sp[b + 8]) / 3; } }
          }
        }
      }
      if (count) {
        const v1 = vertDepth(A, B), v2 = vertDepth(B, A);
        vert = Math.max(v1.d, v2.d);
        if (vert > 0) { const w = v1.d >= v2.d ? v1 : v2; ax = w.at[0]; ay = w.at[1]; az = w.at[2]; }
        const key = A.name < B.name ? `${A.name}|${B.name}` : `${B.name}|${A.name}`;
        const h = hits.get(key);
        if (h) { h.pairs += count; if (depth > h.depth) h.depth = depth; if (vert > h.vert) { h.vert = vert; h.at = [ax, ay, az]; } }
        else hits.set(key, { a: A.name < B.name ? A.name : B.name, b: A.name < B.name ? B.name : A.name, pairs: count, depth, vert, at: [ax, ay, az] });
      }
    }
  }
  const list = [...hits.values()].sort((a, b) => b.vert - a.vert || b.depth - a.depth).slice(0, opt.max ?? 60);
  return { objects: objs.length, triangles: tris, broadPairs: broad, hits: list, ms: Math.round(performance.now() - t0) };
}
