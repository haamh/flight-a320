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

export function asphaltTexture(seed = 3) {
  const S = 1024;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileNoise(S, 4, 6, seed);
  const n2 = tileNoise(S, 64, 3, seed + 9);
  const rnd = mulberry(seed * 7);
  for (let i = 0; i < S * S; i++) {
    const speck = rnd() < 0.08 ? (rnd() - 0.3) * 60 : 0;
    const v = 58 + n[i] * 34 + n2[i] * 22 + speck;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 1.03; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // rubber / tar patches
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "#111" : "#777";
    const x = rnd() * S, y = rnd() * S, w = 20 + rnd() * 160;
    ctx.fillRect(x, y, w, 4 + rnd() * 10);
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

export function concreteTexture(seed = 11) {
  const S = 1024;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileNoise(S, 4, 6, seed);
  const n2 = tileNoise(S, 128, 2, seed + 2);
  for (let i = 0; i < S * S; i++) {
    const v = 150 + n[i] * 45 + n2[i] * 25;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v * 0.99; img.data[i * 4 + 2] = v * 0.95; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "rgba(40,40,40,0.55)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(i * S / 4, 0); ctx.lineTo(i * S / 4, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * S / 4); ctx.lineTo(S, i * S / 4); ctx.stroke();
  }
  return toTexture(c);
}

export function grassDetailTexture() {
  const S = 512;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileNoise(S, 8, 6, 21);
  const n2 = tileNoise(S, 128, 2, 5);
  for (let i = 0; i < S * S; i++) {
    const v = 0.72 + n[i] * 0.35 + (n2[i] - 0.5) * 0.35;
    img.data[i * 4] = 170 * v; img.data[i * 4 + 1] = 180 * v; img.data[i * 4 + 2] = 160 * v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Macro patchwork farmland texture (tileable) */
export function farmlandTexture() {
  const S = 2048;
  const { c, ctx } = makeCanvas(S, S);
  const rnd = mulberry(77);
  ctx.fillStyle = "#56693a";
  ctx.fillRect(0, 0, S, S);
  const palette = ["#5f7437", "#6d7c3c", "#8a8a4a", "#a39a62", "#4f6a33", "#79703f", "#627d3d", "#93904f", "#566a2f", "#7d8a48", "#9a8c5a", "#4a5f2e"];
  const drawWrapped = (fn: (ox: number, oy: number) => void) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy);
  };
  // fields as rotated rectangles in blocks
  for (let b = 0; b < 90; b++) {
    const bx = rnd() * S, by = rnd() * S, ang = (rnd() - 0.5) * 0.6;
    const cols = 2 + Math.floor(rnd() * 4), rows = 2 + Math.floor(rnd() * 4);
    const fw = 40 + rnd() * 90, fh = 30 + rnd() * 80;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const col = palette[Math.floor(rnd() * palette.length)];
      const stripes = rnd() > 0.5;
      drawWrapped((ox, oy) => {
        ctx.save();
        ctx.translate(bx + ox, by + oy); ctx.rotate(ang);
        ctx.fillStyle = col;
        ctx.fillRect(i * fw, j * fh, fw - 2, fh - 2);
        if (stripes) {
          ctx.strokeStyle = "rgba(0,0,0,0.06)"; ctx.lineWidth = 1;
          for (let k = 0; k < fw; k += 4) { ctx.beginPath(); ctx.moveTo(i * fw + k, j * fh); ctx.lineTo(i * fw + k, j * fh + fh - 2); ctx.stroke(); }
        }
        ctx.restore();
      });
    }
  }
  // forests (dark blobs)
  for (let k = 0; k < 160; k++) {
    const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 50;
    drawWrapped((ox, oy) => {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, "rgba(28,48,22,0.95)"); g.addColorStop(0.7, "rgba(34,56,26,0.8)"); g.addColorStop(1, "rgba(34,56,26,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
    });
  }
  // roads
  ctx.strokeStyle = "rgba(120,115,105,0.8)"; ctx.lineWidth = 1.6;
  for (let k = 0; k < 26; k++) {
    let x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2;
    drawWrapped((ox, oy) => {
      let xx = x, yy = y, aa = a;
      ctx.beginPath(); ctx.moveTo(xx + ox, yy + oy);
      for (let s = 0; s < 40; s++) { aa += (rnd() - 0.5) * 0.3; xx += Math.cos(aa) * 25; yy += Math.sin(aa) * 25; ctx.lineTo(xx + ox, yy + oy); }
      ctx.stroke();
    });
    x += 0; y += 0; a += 0;
  }
  // villages
  for (let k = 0; k < 30; k++) {
    const x = rnd() * S, y = rnd() * S;
    for (let h = 0; h < 25; h++) {
      const hx = x + (rnd() - 0.5) * 40, hy = y + (rnd() - 0.5) * 40;
      ctx.fillStyle = rnd() > 0.5 ? "#8a6f5e" : "#a9a39a";
      ctx.fillRect(hx, hy, 2 + rnd() * 2, 2 + rnd() * 2);
    }
  }
  // subtle noise overlay
  const img = ctx.getImageData(0, 0, S, S);
  const n = tileNoise(S, 16, 4, 99);
  for (let i = 0; i < S * S; i++) {
    const f = 0.85 + n[i] * 0.3;
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

export function softPuffTexture(seed = 5) {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileNoise(S, 4, 5, seed);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    const i = y * S + x;
    let a = Math.max(0, 1 - d);
    a = Math.pow(a, 1.2) * (0.55 + n[i] * 0.9);
    a = Math.min(1, a * 1.5);
    const shade = 235 + (1 - dy) * 10;
    img.data[i * 4] = shade; img.data[i * 4 + 1] = shade; img.data[i * 4 + 2] = shade + 5;
    img.data[i * 4 + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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
