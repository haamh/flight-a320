import * as THREE from "three";
import { mulberry } from "./noise";

export function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  return { c, ctx };
}

/** Tileable multi-octave value noise in [0,1] */
export function tileNoise(size: number, baseCells: number, octaves: number, seed = 1) {
  const out = new Float32Array(size * size);
  const rnd = mulberry(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const y1 = (y0 + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % cells;
        const a = g[y0 * cells + x0], b = g[y0 * cells + x1];
        const c = g[y1 * cells + x0], d = g[y1 * cells + x1];
        out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(c: HTMLCanvasElement, repeat = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 16;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function rgbaCanvas(S: number, fill: (i: number, o: Uint8ClampedArray) => void) {
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { fill(i, img.data as unknown as Uint8ClampedArray); }
  ctx.putImageData(img, 0, 0);
  return { c, ctx };
}

/** Neutral dark-grey runway / taxiway asphalt: fine aggregate, worn patches, sealed cracks, optional transverse joints + grooves. */
export function asphaltTexture(seed = 3, joints = false) {
  const S = 1024;
  const n = tileNoise(S, 4, 6, seed), n2 = tileNoise(S, 256, 2, seed + 9), n3 = tileNoise(S, 2, 4, seed + 31), n4 = tileNoise(S, 64, 3, seed + 5);
  const rnd = mulberry(seed * 7);
  const { c, ctx } = rgbaCanvas(S, (i, d) => {
    let v = 60 + (n[i] - 0.5) * 18 + (n2[i] - 0.5) * 30 + (n4[i] - 0.5) * 10;
    const r = rnd();
    if (r < 0.05) v += 18 + rnd() * 30; else if (r > 0.97) v -= 12;
    v += sstep(0.52, 0.75, n3[i]) * 9 - sstep(0.55, 0.8, 1 - n3[i]) * 4;
    d[i * 4] = v * 1.01; d[i * 4 + 1] = v * 0.995; d[i * 4 + 2] = v * 0.975; d[i * 4 + 3] = 255;
  });
  ctx.lineCap = "round";
  // sealed cracks
  for (let k = 0; k < 14; k++) {
    let x = rnd() * S, y = rnd() * S, a = rnd() * 6.28;
    ctx.strokeStyle = `rgba(14,14,15,${0.25 + rnd() * 0.25})`; ctx.lineWidth = 1 + rnd() * 1.5;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 12; s++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * 14; y += Math.sin(a) * 14; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  if (joints) {
    ctx.fillStyle = "rgba(0,0,0,0.05)";
    for (let x = 12; x < S; x += 52) ctx.fillRect(x, 0, 1.5, S);       // transverse grooves
    ctx.fillStyle = "rgba(10,10,10,0.42)";
    ctx.fillRect(0, 0, 3, S); ctx.fillRect(S - 2, 0, 2, S);            // transverse construction joint
    ctx.fillRect(0, 0, S, 2); ctx.fillRect(0, S / 2, S, 2);            // paving lane joints
    ctx.fillStyle = "rgba(255,255,255,0.03)"; ctx.fillRect(4, 0, 2, S);
  }
  return toTexture(c);
}

/** Warm light-grey concrete slabs (7.5 m) with per-slab tone, joints, stains. */
export function concreteTexture(seed = 11) {
  const S = 1024, cell = S / 4;
  const n = tileNoise(S, 4, 6, seed), n2 = tileNoise(S, 256, 2, seed + 2), n3 = tileNoise(S, 8, 4, seed + 8);
  const rnd = mulberry(seed * 3);
  const tone: number[] = []; for (let i = 0; i < 16; i++) tone.push((rnd() - 0.5) * 16);
  const { c, ctx } = rgbaCanvas(S, (i, d) => {
    const x = i % S, y = (i / S) | 0, t = tone[Math.floor(y / cell) * 4 + Math.floor(x / cell)];
    const v = 148 + t + (n[i] - 0.5) * 26 + (n2[i] - 0.5) * 18 - sstep(0.6, 0.85, n3[i]) * 14;
    d[i * 4] = v; d[i * 4 + 1] = v * 0.985; d[i * 4 + 2] = v * 0.94; d[i * 4 + 3] = 255;
  });
  ctx.globalAlpha = 0.12;
  for (let k = 0; k < 30; k++) { ctx.fillStyle = "#222"; const x = rnd() * S, y = rnd() * S; ctx.beginPath(); ctx.ellipse(x, y, 10 + rnd() * 40, 5 + rnd() * 14, rnd() * 3, 0, 6.28); ctx.fill(); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(45,42,38,0.6)";
  for (let i = 0; i < 4; i++) { ctx.fillRect(i * cell - 1.5, 0, 3, S); ctx.fillRect(0, i * cell - 1.5, S, 3); }
  ctx.fillStyle = "rgba(255,250,240,0.08)";
  for (let i = 0; i < 4; i++) { ctx.fillRect(i * cell + 2, 0, 2, S); ctx.fillRect(0, i * cell + 2, S, 2); }
  return toTexture(c);
}

/** Neutral luminance detail for terrain (multiplied onto the macro colour). */
export function grassDetailTexture() {
  const S = 512;
  const n = tileNoise(S, 8, 6, 21), n2 = tileNoise(S, 128, 2, 5);
  const { c } = rgbaCanvas(S, (i, d) => {
    const v = 0.62 + (n[i] - 0.5) * 0.5 + (n2[i] - 0.5) * 0.4;
    d[i * 4] = 165 * v; d[i * 4 + 1] = 166 * v; d[i * 4 + 2] = 152 * v; d[i * 4 + 3] = 255;
  });
  return toTexture(c);
}

/** Mown airfield grass: olive / yellow-green, mowing strips along X, dry patches, blade noise. 60 m tile. */
export function airfieldGrassTexture() {
  const S = 1024;
  const n = tileNoise(S, 4, 5, 61), n2 = tileNoise(S, 32, 4, 62), n3 = tileNoise(S, 256, 2, 63), n4 = tileNoise(S, 2, 3, 64);
  const { c } = rgbaCanvas(S, (i, d) => {
    const y = ((i / S) | 0) / S;
    const strip = Math.floor(y * 6) % 2 ? 1 : 0;
    const wob = Math.sin(y * 6 * Math.PI * 2);
    const dry = sstep(0.5, 0.72, n[i] * 0.7 + n4[i] * 0.3);
    let r = 82, g = 96, b = 46;
    r += dry * 52; g += dry * 30; b += dry * 22;
    const dark = sstep(0.55, 0.8, 1 - n2[i]) * 0.22;
    let k = 1 + (n2[i] - 0.5) * 0.35 + (n3[i] - 0.5) * 0.4 + strip * 0.08 + wob * 0.025 - dark;
    d[i * 4] = r * k; d[i * 4 + 1] = g * k; d[i * 4 + 2] = b * k; d[i * 4 + 3] = 255;
  });
  return toTexture(c);
}

/** Rock / scree / strata detail (neutral, tileable). */
export function rockTexture() {
  const S = 512;
  const n = tileNoise(S, 4, 6, 301), n2 = tileNoise(S, 64, 4, 302), w = tileNoise(S, 2, 3, 303);
  const rnd = mulberry(9);
  const { c } = rgbaCanvas(S, (i, d) => {
    const y = ((i / S) | 0) / S;
    const s = Math.sin((y * 14 + w[i] * 3.2 + n[i] * 1.5) * Math.PI * 2);
    let v = 0.62 + s * 0.09 + (n[i] - 0.5) * 0.45 + (n2[i] - 0.5) * 0.45;
    if (rnd() < 0.06) v *= 0.75 + rnd() * 0.6;
    d[i * 4] = 150 * v; d[i * 4 + 1] = 142 * v; d[i * 4 + 2] = 130 * v; d[i * 4 + 3] = 255;
  });
  return toTexture(c);
}

/** Macro patchwork farmland texture (tileable): muted field palette, hedgerows, clumpy forests, lanes, villages. */
export function farmlandTexture() {
  const S = 2048;
  const { c, ctx } = makeCanvas(S, S);
  const rnd = mulberry(77);
  ctx.fillStyle = "#6d6f40";
  ctx.fillRect(0, 0, S, S);
  const palette = ["#6c6f3e", "#7b7a45", "#8f8a52", "#a39a64", "#5e6b3a", "#75684a", "#6a5c43", "#81734f", "#9a9163", "#4f5f35", "#857f4c", "#b0a673", "#62613d", "#72794a", "#58633a", "#7f6f52"];
  const drawWrapped = (fn: (ox: number, oy: number) => void) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  for (let b = 0; b < 100; b++) {
    const bx = rnd() * S, by = rnd() * S, ang = (rnd() - 0.5) * 0.7 + (rnd() < 0.3 ? 0.8 : 0);
    const cols = 2 + Math.floor(rnd() * 4), rows = 2 + Math.floor(rnd() * 4);
    const fw = 36 + rnd() * 100, fh = 30 + rnd() * 90;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const col = palette[Math.floor(rnd() * palette.length)];
      const kind = rnd(), sAng = rnd() < 0.5;
      const pw = fw * (0.85 + rnd() * 0.3), ph = fh * (0.85 + rnd() * 0.3);
      drawWrapped((ox, oy) => {
        ctx.save();
        ctx.translate(bx + ox, by + oy); ctx.rotate(ang);
        ctx.fillStyle = col;
        ctx.fillRect(i * fw, j * fh, pw - 2, ph - 2);
        const g = ctx.createLinearGradient(i * fw, j * fh, i * fw + (sAng ? pw : 0), j * fh + (sAng ? 0 : ph));
        g.addColorStop(0, "rgba(255,240,190,0.07)"); g.addColorStop(1, "rgba(20,20,10,0.10)");
        ctx.fillStyle = g; ctx.fillRect(i * fw, j * fh, pw - 2, ph - 2);
        if (kind > 0.35) {
          ctx.strokeStyle = kind > 0.7 ? "rgba(0,0,0,0.07)" : "rgba(255,245,200,0.06)"; ctx.lineWidth = 1;
          for (let k = 0; k < (sAng ? pw : ph); k += 3) {
            ctx.beginPath();
            if (sAng) { ctx.moveTo(i * fw + k, j * fh); ctx.lineTo(i * fw + k, j * fh + ph - 2); } else { ctx.moveTo(i * fw, j * fh + k); ctx.lineTo(i * fw + pw - 2, j * fh + k); }
            ctx.stroke();
          }
        }
        // hedgerow on two sides
        ctx.strokeStyle = "rgba(38,52,30,0.85)"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(i * fw - 1, j * fh - 1); ctx.lineTo(i * fw + pw - 1, j * fh - 1); ctx.lineTo(i * fw + pw - 1, j * fh + ph - 1); ctx.stroke();
        ctx.restore();
      });
    }
  }
  // forests: clumpy dark blue-green stands
  for (let k = 0; k < 70; k++) {
    const x = rnd() * S, y = rnd() * S, R = 14 + rnd() * 60, cnt = Math.floor(R * 1.4);
    drawWrapped((ox, oy) => {
      for (let t = 0; t < cnt; t++) {
        const a = rnd() * 6.28, rr = Math.sqrt(rnd()) * R, r = 3 + rnd() * 6;
        ctx.fillStyle = `rgba(${26 + rnd() * 12},${44 + rnd() * 14},${36 + rnd() * 12},0.95)`;
        ctx.beginPath(); ctx.arc(x + ox + Math.cos(a) * rr, y + oy + Math.sin(a) * rr * 0.8, r, 0, 6.28); ctx.fill();
      }
    });
  }
  // lanes
  ctx.strokeStyle = "rgba(128,120,104,0.75)"; ctx.lineWidth = 1.4;
  for (let k = 0; k < 26; k++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2;
    drawWrapped((ox, oy) => {
      let xx = x, yy = y, aa = a;
      ctx.beginPath(); ctx.moveTo(xx + ox, yy + oy);
      for (let s = 0; s < 40; s++) { aa += (rnd() - 0.5) * 0.3; xx += Math.cos(aa) * 25; yy += Math.sin(aa) * 25; ctx.lineTo(xx + ox, yy + oy); }
      ctx.stroke();
    });
  }
  // villages
  for (let k = 0; k < 30; k++) {
    const x = rnd() * S, y = rnd() * S;
    for (let h = 0; h < 25; h++) {
      const hx = x + (rnd() - 0.5) * 40, hy = y + (rnd() - 0.5) * 40;
      ctx.fillStyle = rnd() > 0.5 ? "#8b6e5a" : "#a8a197";
      ctx.fillRect(hx, hy, 2 + rnd() * 2, 2 + rnd() * 2);
    }
  }
  const img = ctx.getImageData(0, 0, S, S);
  const n = tileNoise(S, 16, 4, 99), n2 = tileNoise(S, 256, 2, 98);
  for (let i = 0; i < S * S; i++) {
    const f = 0.88 + n[i] * 0.22 + (n2[i] - 0.5) * 0.1;
    img.data[i * 4] *= f; img.data[i * 4 + 1] *= f; img.data[i * 4 + 2] *= f;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}
export function waterNormalTexture() {
  const S = 512;
  const { c, ctx } = makeCanvas(S, S);
  const h = tileNoise(S, 8, 5, 42);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const hx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const hy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    const nx = -hx * 6, ny = -hy * 6, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    img.data[i * 4] = (nx / l * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = (nz / l * 0.5 + 0.5) * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, 1, false);
}

export function textTexture(text: string, w = 256, h = 512, font = "bold 400px 'Arial Narrow', Arial, sans-serif", color = "#f4f4f0") {
  const { c, ctx } = makeCanvas(w, h);
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.scale(1, 1.6);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

/** Cumulus billboard: RGB = view-facing normal of a cauliflower of spherical lobes (flat base), A = coverage. Lit in the cloud shader. */
export function softPuffTexture(seed = 5) {
  const S = 512;
  const rnd = mulberry(seed);
  const data = new Uint8Array(S * S * 4);
  const zb = new Float32Array(S * S).fill(-1);
  const covA = new Float32Array(S * S);
  const base = 0.8;
  const lobes: number[][] = [];
  const add = (cx: number, cy: number, r: number) => lobes.push([cx, cy, r]);
  for (let k = 0; k < 9; k++) add(0.5 + (rnd() - 0.5) * 0.5, base - 0.17 - rnd() * 0.3, 0.17 + rnd() * 0.07);
  for (let k = 0; k < 14; k++) { const cx = 0.5 + (rnd() - 0.5) * 0.66; const H = 0.5 * Math.sqrt(Math.max(0, 1 - ((cx - 0.5) / 0.4) ** 2)); const r = 0.1 + rnd() * 0.08; add(cx, base - r * 0.9 - rnd() * H * 0.25, r); }
  for (let k = 0; k < 34; k++) {
    const cx = 0.5 + (rnd() - 0.5) * 0.72; const H = 0.66 * Math.pow(Math.max(0, 1 - ((cx - 0.5) / 0.4) ** 2), 0.6);
    const r = 0.035 + rnd() * 0.075 * (0.4 + H);
    add(cx, base - r * 0.7 - rnd() * H, r);
  }
  for (const [cx, cy, r] of lobes) {
    const x0 = Math.max(0, Math.floor((cx - r * 1.3) * S)), x1 = Math.min(S - 1, Math.ceil((cx + r * 1.3) * S));
    const y0 = Math.max(0, Math.floor((cy - r * 1.3) * S)), y1 = Math.min(S - 1, Math.ceil((cy + r * 1.3) * S));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (y / S > base) continue;
      const dx = (x / S - cx) / r, dy = (y / S - cy) / r;
      const rough = 1 + 0.12 * Math.sin(Math.atan2(dy, dx) * 7 + cx * 40) * Math.sin(cy * 50);
      const d2 = (dx * dx + dy * dy) / (rough * rough);
      if (d2 >= 1) continue;
      const z = Math.sqrt(1 - d2) * r + cy * 0.06 * -1;
      const i = y * S + x;
      // soft, wispy lobe rims instead of hard-edged discs
      const cov = 1 - (d2 < 0.45 ? 0 : ((d2 - 0.45) / 0.55) ** 1.6);
      covA[i] = Math.max(covA[i], cov);
      if (z <= zb[i]) continue;
      zb[i] = z;
      const nz = Math.sqrt(1 - d2);
      data[i * 4] = (dx / rough * 0.5 + 0.5) * 255; data[i * 4 + 1] = (-dy / rough * 0.5 + 0.5) * 255; data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; data[i * 4 + 3] = 255;
    }
  }
  // coverage: soft lobe rims, then a few box-blur passes so edges read as vapour, not cut-outs
  let a1 = covA, a2 = new Float32Array(S * S);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 2; y < S - 2; y++) for (let x = 2; x < S - 2; x++) {
      const i = y * S + x;
      a2[i] = (a1[i] * 2 + a1[i - 1] + a1[i + 1] + a1[i - S] + a1[i + S] + a1[i - 2] + a1[i + 2] + a1[i - 2 * S] + a1[i + 2 * S]) / 10;
    }
    [a1, a2] = [a2, a1];
  }
  for (let i = 0; i < S * S; i++) { const a = Math.round(Math.min(1, a1[i] * 1.08) * 255); data[i * 4 + 3] = a; if (!zb[i] || zb[i] < -0.5) { data[i * 4] = 128; data[i * 4 + 1] = 128; data[i * 4 + 2] = 255; } }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
export function glowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.15, inner.replace(/,\s*1\)/, ",0.6)"));
  g.addColorStop(0.4, inner.replace(/,\s*1\)/, ",0.12)"));
  g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function flareRingTexture() {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  ctx.translate(S / 2, S / 2);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * S * 0.45, y = Math.sin(a) * S * 0.45;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.45);
  g.addColorStop(0, "rgba(255,255,255,0.05)");
  g.addColorStop(0.85, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0.4)");
  ctx.fillStyle = g; ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildingFacadeTexture(seed = 4) {
  const W = 256, H = 512;
  const { c, ctx } = makeCanvas(W, H);
  const rnd = mulberry(seed);
  ctx.fillStyle = "#8d9096"; ctx.fillRect(0, 0, W, H);
  for (let y = 8; y < H; y += 24) {
    for (let x = 8; x < W; x += 20) {
      const lit = rnd();
      ctx.fillStyle = lit > 0.85 ? "#e8d9a8" : lit > 0.5 ? "#39424e" : "#2a3038";
      ctx.fillRect(x, y, 13, 15);
    }
  }
  const t = toTexture(c);
  t.repeat.set(1, 1);
  return t;
}

export function windowGlowTexture(seed = 4) {
  const W = 256, H = 512;
  const { c, ctx } = makeCanvas(W, H);
  const rnd = mulberry(seed);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  for (let y = 8; y < H; y += 24) for (let x = 8; x < W; x += 20) {
    if (rnd() > 0.72) { ctx.fillStyle = `rgba(255,${200 + rnd() * 40},${120 + rnd() * 60},1)`; ctx.fillRect(x, y, 13, 15); }
  }
  const t = toTexture(c);
  return t;
}

export function sandTexture() {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileNoise(S, 8, 5, 8);
  for (let i = 0; i < S * S; i++) {
    const v = 0.8 + n[i] * 0.3;
    img.data[i * 4] = 190 * v; img.data[i * 4 + 1] = 175 * v; img.data[i * 4 + 2] = 140 * v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}
