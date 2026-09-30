import { fbm, ridged, smoothstep, lerp } from "./noise";

export interface Airport {
  icao: string;
  name: string;
  x: number;
  z: number;
  elev: number;
  heading: number; // runway true heading (deg) of the "low" runway end
  length: number;
  width: number;
  rwy: [string, string];
}

// World frame: +X = east, -Z = north, +Y = up. Units: meters.
export const AIRPORTS: Airport[] = [
  { icao: "EAUR", name: "Aurora International", x: 0, z: 0, elev: 0, heading: 90, length: 3200, width: 45, rwy: ["09", "27"] },
  { icao: "EBVR", name: "Bayview Regional", x: 41000, z: 3200, elev: 0, heading: 90, length: 3000, width: 45, rwy: ["09", "27"] },
];

export const TERRAIN = {
  size: 110000,
  N: 900,
  cx: 20000,
  cz: 0,
  heights: new Float32Array(0),
};

function airportFlatten(x: number, z: number, h: number) {
  for (const a of AIRPORTS) {
    const hd = (a.heading * Math.PI) / 180;
    const fx = Math.sin(hd), fz = -Math.cos(hd);
    const dx = x - a.x, dz = z - a.z;
    const along = dx * fx + dz * fz;
    const across = -dx * fz + dz * fx;
    const d = Math.max(Math.abs(along) - (a.length / 2 + 900), Math.abs(across) - 900, 0);
    const f = smoothstep(0, 3200, d);
    let hh = lerp(a.elev, h, f);
    const aa = Math.abs(along) - a.length / 2;
    if (aa < 18000) {
      // keep approach / departure corridors well below a 3° path
      const cf = smoothstep(900, 5000, Math.abs(across));
      const cap = a.elev + 12 + Math.max(aa, 0) * 0.022;
      if (hh > cap) hh = lerp(cap, hh, cf);
    }
    h = hh;
  }
  return h;
}

/** rounded ridges: fewer octaves blended with smooth noise (only used in the far mountain regions) */
function softRidge(x: number, y: number, oct: number) {
  const r = ridged(x, y, oct), b = 0.5 + 0.5 * fbm(x * 0.9 + 11, y * 0.9 - 5, 3);
  const m = 0.55 * r + 0.45 * b * 0.8;
  return m * (0.6 + 0.4 * m);
}

export function rawHeight(x: number, z: number) {
  let h = 28 + 38 * fbm(x / 7000, z / 7000, 5) + 9 * fbm(x / 900, z / 900, 3);
  // northern mountain range
  const north = smoothstep(-9000, -26000, z);
  if (north > 0) h += north * (softRidge(x / 8500 + 3.1, z / 8500 - 1.7, 4) * 2050 + 180 * fbm(x / 2000, z / 2000, 4));
  // southern hills
  const south = smoothstep(14000, 30000, z);
  if (south > 0) h += south * (softRidge(x / 6000 - 7.3, z / 6000 + 2.2, 4) * 700);
  // western hills
  const west = smoothstep(-8000, -24000, x);
  if (west > 0) h += west * softRidge(x / 7000, z / 7000 + 4.4, 4) * 900;
  // sea to the south-east
  const sea = smoothstep(46000, 60000, x) * smoothstep(-2000, 12000, z);
  h = lerp(h, -60 + 20 * fbm(x / 3000, z / 3000, 3), sea);
  // a lake north of the route
  const ldx = (x - 21000) / 5200, ldz = (z + 7200) / 2600;
  const ld = Math.sqrt(ldx * ldx + ldz * ldz) + 0.25 * fbm(x / 1500, z / 1500, 3);
  if (ld < 1.4) h = lerp(-14, h, smoothstep(0.75, 1.4, ld));
  return airportFlatten(x, z, h);
}

export function buildTerrain() {
  const { N, size, cx, cz } = TERRAIN;
  const hs = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    const z = cz - size / 2 + (j / N) * size;
    for (let i = 0; i <= N; i++) {
      const x = cx - size / 2 + (i / N) * size;
      hs[j * (N + 1) + i] = rawHeight(x, z);
    }
  }
  TERRAIN.heights = hs;
}

export function heightAt(x: number, z: number) {
  const { N, size, cx, cz, heights } = TERRAIN;
  const fx = ((x - (cx - size / 2)) / size) * N;
  const fz = ((z - (cz - size / 2)) / size) * N;
  if (fx < 0 || fz < 0 || fx >= N || fz >= N || heights.length === 0) return rawHeight(x, z);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const r = N + 1;
  const h00 = heights[j * r + i], h10 = heights[j * r + i + 1];
  const h01 = heights[(j + 1) * r + i], h11 = heights[(j + 1) * r + i + 1];
  // match triangle split used by PlaneGeometry (a-b-d / b-c-d)
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

export const WATER_LEVEL = -3;

/** Ground height including water surface */
export function groundAt(x: number, z: number) {
  return Math.max(heightAt(x, z), WATER_LEVEL);
}
