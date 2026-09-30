export interface Telemetry {
  ias: number; gs: number; alt: number; vs: number; hdg: number; pitch: number; bank: number; alpha: number;
  n1: number; throttle: number; flapIdx: number; flapName: string; flapDeg: number; slat: number; gear: number; gearDown: boolean;
  ap: string; athr: boolean; apAlt: number; apHdg: number; apSpd: number;
  gsDev: number; locDev: number; ilsValid: boolean; distNm: number; destBrg: number; destName: string;
  mach: number; gload: number; spoilers: number; brake: number; parking: boolean; stall: boolean; tailstrike: boolean;
  onGround: boolean; agl: number; reverser: number; trend: number; time: number;
  route: { x: number; z: number }[]; pos: { x: number; z: number };
}

const GREEN = "#00ff3a", AMBER = "#ffb000", CYAN = "#29d2ff", MAG = "#ff3cf0", WHITE = "#f2f2f2", RED = "#ff3030", YEL = "#ffe600";
const TAPE = "#3b4148", SKY = "#1c8fd8", GND = "#8b5a2b";
const FONT = (s: number, b = "600") => `${b} ${s}px 'Consolas', 'DejaVu Sans Mono', 'Menlo', monospace`;
const F9 = FONT(9), F11 = FONT(11), F12 = FONT(12), F12B = FONT(12, "700"), F13 = FONT(13), F13B = FONT(13, "700"), F14 = FONT(14), F14B = FONT(14, "700"), F16B = FONT(16, "700"), F17B = FONT(17, "700");
const PI = Math.PI, D2R = PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const pad = (n: number, w: number) => { let s = String(Math.abs(Math.round(n))); while (s.length < w) s = "0" + s; return s; };
function tx(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, c: string, al: CanvasTextAlign = "left") { ctx.fillStyle = c; ctx.textAlign = al; ctx.fillText(s, x, y); }
function poly(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); }
function stripes(ctx: CanvasRenderingContext2D, x: number, w: number, yFrom: number, yTo: number, dir: number) {
  // red/black barber pole from yFrom extending in dir (+1 down / -1 up) until yTo
  ctx.fillStyle = RED;
  for (let y = yFrom; dir > 0 ? y < yTo : y > yTo; y += dir * 10) { const h = dir > 0 ? Math.min(5, yTo - y) : Math.min(5, y - yTo); ctx.fillRect(x, dir > 0 ? y : y - h, w, h); }
}

export function drawPFD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.textBaseline = "middle";
  const cx = 196, cy = 181, sy0 = 66, sy1 = 296, sh = sy1 - sy0;
  const apOn = t.ap !== "OFF" && t.ap !== "ROLLOUT";
  // attitude sphere
  ctx.save();
  ctx.beginPath(); ctx.rect(78, sy0, 234, sh); ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-t.bank * D2R);
  const ppd = 4.2, off = clamp(t.pitch, -60, 60) * ppd;
  ctx.fillStyle = SKY; ctx.fillRect(-400, -800 + off, 800, 800);
  ctx.fillStyle = GND; ctx.fillRect(-400, off, 800, 800);
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-400, off); ctx.lineTo(400, off); ctx.stroke();
  ctx.fillStyle = WHITE; ctx.font = F11; ctx.textAlign = "center"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let p = -30; p <= 30; p += 2.5) {
    if (p === 0) continue;
    const y = off - p * ppd;
    if (y < -150 || y > 150) continue;
    const wd = p % 10 === 0 ? 50 : p % 5 === 0 ? 26 : 12;
    ctx.moveTo(-wd / 2, y); ctx.lineTo(wd / 2, y);
  }
  ctx.stroke();
  for (let p = -30; p <= 30; p += 10) {
    if (p === 0) continue;
    const y = off - p * ppd;
    if (y < -150 || y > 150) continue;
    ctx.fillText(String(Math.abs(p)), -38, y); ctx.fillText(String(Math.abs(p)), 38, y);
  }
  ctx.restore();
  // bank scale (fixed) + roll pointer (moving)
  ctx.save(); ctx.translate(cx, cy);
  const rad = 100;
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, rad, -150 * D2R, -30 * D2R);
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = (b - 90) * D2R, r2 = rad - (Math.abs(b) % 30 === 0 ? 11 : 6);
    ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad); ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
  }
  ctx.stroke();
  ctx.fillStyle = YEL; poly(ctx, 0, -rad + 1, -7, -rad - 10, 7, -rad - 10); ctx.fill(); // sky pointer (fixed)
  ctx.rotate(-t.bank * D2R);
  ctx.strokeStyle = YEL; ctx.lineWidth = 2;
  poly(ctx, 0, -rad + 2, -8, -rad + 14, 8, -rad + 14); ctx.stroke();
  ctx.strokeRect(-9, -rad + 16, 18, 5);
  ctx.restore();
  // flight director bars
  if (apOn) {
    let hy = 0, vx = 0;
    if (t.ilsValid) { hy = clamp(-t.gsDev / 0.35, -2.2, 2.2) * 14; vx = clamp(t.locDev / 1.0, -2.2, 2.2) * 14; }
    else hy = (clamp((t.apAlt - t.alt) / 500, -1, 1) * 5 - t.pitch) * ppd;
    hy = clamp(hy, -70, 70);
    ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - 60, cy + hy); ctx.lineTo(cx + 60, cy + hy); ctx.moveTo(cx + vx, cy - 70); ctx.lineTo(cx + vx, cy + 70); ctx.stroke();
  }
  // aircraft symbol
  ctx.lineJoin = "miter";
  ctx.beginPath(); ctx.moveTo(cx - 74, cy); ctx.lineTo(cx - 34, cy); ctx.lineTo(cx - 34, cy + 9); ctx.moveTo(cx + 74, cy); ctx.lineTo(cx + 34, cy); ctx.lineTo(cx + 34, cy + 9);
  ctx.strokeStyle = "#000"; ctx.lineWidth = 7; ctx.stroke();
  ctx.strokeStyle = YEL; ctx.lineWidth = 3.5; ctx.stroke();
  ctx.fillStyle = "#000"; ctx.fillRect(cx - 5, cy - 5, 10, 10); ctx.fillStyle = YEL; ctx.fillRect(cx - 3, cy - 3, 6, 6);
  // ILS deviation scales
  if (t.ilsValid) {
    ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      if (i) { ctx.moveTo(cx + 110 + 3, cy + i * 24); ctx.arc(cx + 110, cy + i * 24, 3, 0, 7); ctx.moveTo(cx + i * 24 + 3, sy1 - 8); ctx.arc(cx + i * 24, sy1 - 8, 3, 0, 7); }
    }
    ctx.moveTo(cx + 104, cy); ctx.lineTo(cx + 116, cy); ctx.moveTo(cx, sy1 - 14); ctx.lineTo(cx, sy1 - 2);
    ctx.stroke();
    const gy = cy + clamp(-t.gsDev / 0.35, -2.2, 2.2) * 24, lx = cx + clamp(t.locDev / 1.0, -2.2, 2.2) * 24;
    ctx.fillStyle = MAG;
    ctx.beginPath(); ctx.moveTo(cx + 110, gy - 8); ctx.lineTo(cx + 117, gy); ctx.lineTo(cx + 110, gy + 8); ctx.lineTo(cx + 103, gy); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(lx - 8, sy1 - 8); ctx.lineTo(lx, sy1 - 15); ctx.lineTo(lx + 8, sy1 - 8); ctx.lineTo(lx, sy1 - 1); ctx.closePath(); ctx.fill();
  }
  // speed tape
  const sx = 8, sw = 50, ppk = 3.4;
  ctx.fillStyle = TAPE; ctx.fillRect(sx, sy0, sw, sh);
  ctx.save(); ctx.beginPath(); ctx.rect(sx, sy0, sw, sh); ctx.clip();
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.font = F14; ctx.textAlign = "right"; ctx.lineWidth = 2;
  const s0 = Math.floor((t.ias - 50) / 10) * 10;
  ctx.beginPath();
  for (let s = s0; s < t.ias + 50; s += 10) {
    if (s < 30) continue;
    const y = cy - (s - t.ias) * ppk;
    ctx.moveTo(sx + sw - 10, y); ctx.lineTo(sx + sw - 4, y);
  }
  ctx.stroke();
  for (let s = s0; s < t.ias + 50; s += 10) { if (s >= 30 && s % 20 === 0) ctx.fillText(String(s), sx + sw - 14, cy - (s - t.ias) * ppk + 1); }
  const vls = t.flapIdx >= 3 ? 128 : t.flapIdx >= 1 ? 140 : 190;
  const yv = cy - (vls - t.ias) * ppk, yvs = cy - (vls * 0.86 - t.ias) * ppk;
  ctx.fillStyle = AMBER; ctx.fillRect(sx + sw - 4, yv, 4, Math.max(0, yvs - yv));
  stripes(ctx, sx + sw - 4, 4, yvs, sy1 + 10, 1);
  const vmax = [350, 230, 215, 195, 177][t.flapIdx] || 350;
  const ym = cy - (vmax - t.ias) * ppk;
  if (ym > sy0) stripes(ctx, sx + sw - 4, 4, Math.min(ym, sy1 + 6), sy0 - 6, -1);
  if (t.athr || apOn) {
    const ys = clamp(cy - (t.apSpd - t.ias) * ppk, sy0 + 4, sy1 - 4);
    ctx.strokeStyle = MAG; ctx.lineWidth = 2; poly(ctx, sx + sw - 16, ys, sx + sw - 4, ys - 6, sx + sw - 4, ys + 6); ctx.stroke();
  }
  ctx.restore();
  // speed trend arrow and yellow index
  if (Math.abs(t.trend) > 2) {
    const ty = cy - clamp(t.trend, -40, 40) * ppk, dy = ty < cy ? 1 : -1;
    ctx.strokeStyle = YEL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx + sw + 1, cy); ctx.lineTo(sx + sw + 1, ty); ctx.moveTo(sx + sw - 3, ty + dy * 6); ctx.lineTo(sx + sw + 1, ty); ctx.lineTo(sx + sw + 5, ty + dy * 6); ctx.stroke();
  }
  ctx.fillStyle = YEL; poly(ctx, sx + sw + 10, cy, sx + sw - 3, cy - 6, sx + sw - 3, cy + 6); ctx.fill();
  ctx.fillRect(sx + sw - 18, cy - 1, 16, 2);
  if (t.athr || apOn) tx(ctx, pad(t.apSpd, 3), sx + sw / 2, sy0 - 10, MAG, "center");
  ctx.font = F13; if (t.mach > 0.45) tx(ctx, "." + pad(t.mach * 1000, 3).slice(0, 2), sx + 6, sy1 + 14, GREEN);
  // altitude tape
  const ax = 314, aw = 48, ppf = 0.2;
  ctx.fillStyle = TAPE; ctx.fillRect(ax, sy0, aw, sh);
  ctx.save(); ctx.beginPath(); ctx.rect(ax, sy0, aw, sh); ctx.clip();
  ctx.fillStyle = WHITE; ctx.strokeStyle = WHITE; ctx.textAlign = "left"; ctx.font = F13; ctx.lineWidth = 2;
  const a0 = Math.floor((t.alt - 600) / 100) * 100;
  ctx.beginPath();
  for (let a = a0; a < t.alt + 600; a += 100) { const y = cy - (a - t.alt) * ppf; ctx.moveTo(ax, y); ctx.lineTo(ax + (a % 200 === 0 ? 12 : 7), y); }
  ctx.stroke();
  for (let a = a0; a < t.alt + 600; a += 100) { if (a % 200 === 0) ctx.fillText(pad(a / 100, 3), ax + 15, cy - (a - t.alt) * ppf + 1); }
  const gyy = cy + t.agl * 3.28 * ppf;
  if (t.agl * 3.28 < 600) { ctx.fillStyle = "rgba(255,40,40,0.85)"; ctx.fillRect(ax, gyy, 6, 300); }
  if (apOn) {
    const y = clamp(cy - (t.apAlt - t.alt) * ppf, sy0 + 8, sy1 - 8);
    ctx.strokeStyle = CYAN; ctx.lineWidth = 2.5; ctx.strokeRect(ax + 1, y - 7, 14, 14);
  }
  ctx.restore();
  ctx.fillStyle = "#000"; ctx.strokeStyle = YEL; ctx.lineWidth = 2;
  ctx.fillRect(ax - 4, cy - 13, aw + 2, 26); ctx.strokeRect(ax - 4, cy - 13, aw + 2, 26);
  ctx.font = F17B; tx(ctx, String(Math.round(t.alt / 10) * 10), ax + aw - 3, cy + 1, GREEN, "right");
  if (apOn) { ctx.font = F14B; tx(ctx, String(Math.round(t.apAlt / 100) * 100), ax + aw / 2, sy0 - 10, CYAN, "center"); }
  // vertical speed
  const vx = 364, vsy = (v: number) => { const a = Math.abs(v), o = a < 1000 ? a * 0.034 : a < 2000 ? 34 + (a - 1000) * 0.024 : 58 + Math.min(a - 2000, 4000) * 0.007; return cy + (v < 0 ? o : -o); };
  ctx.fillStyle = TAPE; ctx.fillRect(vx, cy - 90, 20, 180);
  ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.beginPath();
  for (const v of [1000, 2000, 4000, 6000]) { ctx.moveTo(vx, vsy(v)); ctx.lineTo(vx + 6, vsy(v)); ctx.moveTo(vx, vsy(-v)); ctx.lineTo(vx + 6, vsy(-v)); }
  ctx.moveTo(vx, cy); ctx.lineTo(vx + 8, cy); ctx.stroke();
  ctx.font = F9; ctx.textAlign = "left"; ctx.fillStyle = WHITE;
  for (const v of [1, 2, 4, 6]) { ctx.fillText(String(v), vx + 8, vsy(v * 1000)); ctx.fillText(String(v), vx + 8, vsy(-v * 1000)); }
  const vy = vsy(clamp(t.vs, -6000, 6000));
  ctx.strokeStyle = GREEN; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(vx + 20, cy); ctx.lineTo(vx + 3, vy); ctx.stroke();
  if (Math.abs(t.vs) > 200) { ctx.font = F12B; tx(ctx, String(Math.round(Math.abs(t.vs) / 100)), vx + 2, clamp(vy + (t.vs > 0 ? -10 : 10), sy0, sy1), GREEN); }
  // heading tape
  const hy = 314, hx0 = 106, hw = 180;
  ctx.fillStyle = TAPE; ctx.fillRect(hx0, hy, hw, 28);
  ctx.save(); ctx.beginPath(); ctx.rect(hx0, hy, hw, 28); ctx.clip();
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.font = F13; ctx.textAlign = "center"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  const h0 = Math.floor(t.hdg / 5) * 5 - 30;
  for (let h = h0; h < t.hdg + 30; h += 5) { const x = cx + (h - t.hdg) * 3.6; ctx.moveTo(x, hy + 2); ctx.lineTo(x, hy + (h % 10 === 0 ? 11 : 6)); }
  ctx.stroke();
  for (let h = h0; h < t.hdg + 30; h += 5) { if (h % 10 === 0) ctx.fillText(pad((((h % 360) + 360) % 360) / 10, 2), cx + (h - t.hdg) * 3.6, hy + 20); }
  if (apOn) {
    const rel = clamp(((t.apHdg - t.hdg + 540) % 360) - 180, -24, 24);
    ctx.strokeStyle = CYAN; ctx.lineWidth = 2; poly(ctx, cx + rel * 3.6, hy + 1, cx + rel * 3.6 - 6, hy + 10, cx + rel * 3.6 + 6, hy + 10); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = YEL; poly(ctx, cx, hy - 1, cx - 6, hy - 10, cx + 6, hy - 10); ctx.fill();
  // QNH
  ctx.font = F13B; tx(ctx, "QNH", 300, 330, WHITE); tx(ctx, "1013", 334, 330, CYAN);
  // FMA
  ctx.strokeStyle = "#8a8f94"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 5; i++) { ctx.moveTo(i * 76.8, 2); ctx.lineTo(i * 76.8, 50); }
  ctx.moveTo(0, 50); ctx.lineTo(384, 50); ctx.stroke();
  ctx.font = F13B;
  const cw = 76.8, mid = cw / 2;
  const r1: [string, string][] = [
    t.athr ? (t.ap === "FLARE" && t.agl < 9 ? ["RETARD", AMBER] : ["SPEED", GREEN]) : t.throttle > 0.97 ? ["MAN TOGA", GREEN] : t.onGround ? ["", GREEN] : ["MAN THR", WHITE],
    [t.ap === "APPR" ? "G/S" : t.ap === "FLARE" ? "FLARE" : t.ap === "HDG/ALT" || t.ap === "LOC" ? "ALT" : "", GREEN],
    [t.ap === "APPR" || t.ap === "LOC" ? "LOC" : t.ap === "FLARE" ? "LAND" : t.ap === "ROLLOUT" ? "ROLL OUT" : t.ap === "HDG/ALT" ? "HDG" : "", GREEN],
    [t.ap === "APPR" || t.ap === "FLARE" || t.ap === "ROLLOUT" ? "CAT 3" : t.ap === "LOC" ? "CAT 1" : "", WHITE],
    [apOn ? "AP1" : t.ap === "ROLLOUT" ? "" : "", WHITE],
  ];
  for (let i = 0; i < 5; i++) tx(ctx, r1[i][0], i * cw + mid, 13, r1[i][1], "center");
  tx(ctx, t.ap === "LOC" ? "G/S" : "", cw + mid, 29, CYAN, "center");
  tx(ctx, t.ap === "APPR" || t.ap === "FLARE" || t.ap === "ROLLOUT" ? "DUAL" : "", 3 * cw + mid, 29, WHITE, "center");
  tx(ctx, apOn ? "1FD2" : "", 4 * cw + mid, 29, WHITE, "center");
  tx(ctx, t.athr ? "A/THR" : "", 4 * cw + mid, 44, CYAN, "center");
  // warnings
  ctx.font = FONT(16, "800");
  if (t.stall) tx(ctx, "STALL", cx, cy + 60, RED, "center");
  else if (t.tailstrike) tx(ctx, "TAIL STRIKE", cx, cy + 60, AMBER, "center");
  if (t.agl < 760 && !t.onGround) tx(ctx, String(Math.round(t.agl * 3.28)), cx, cy + 86, t.agl < 122 ? AMBER : GREEN, "center");
  ctx.restore();
}

let _px = 0, _py = 0;
function proj(t: Telemetry, sinH: number, cosH: number, ppn: number, x: number, z: number) {
  const dx = (x - t.pos.x) / 1852, dz = (z - t.pos.z) / 1852;
  _px = (dx * cosH + dz * sinH) * ppn; _py = -(dx * sinH - dz * cosH) * ppn;
}

export function drawND(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.textBaseline = "middle";
  const cx = 192, cy = 316, R = 244;
  const rangeNm = t.distNm > 20 ? 40 : t.distNm > 10 ? 20 : 10;
  const ppn = R / rangeNm;
  const sinH = Math.sin(t.hdg * D2R), cosH = Math.cos(t.hdg * D2R);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 24, 384, 360); ctx.clip();
  ctx.translate(cx, cy);
  // arc, range ring
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, R, -PI * 0.82, -PI * 0.18); ctx.stroke();
  ctx.setLineDash([3, 7]); ctx.strokeStyle = "#9aa0a6"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, R / 2, -PI * 0.82, -PI * 0.18); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = F11; tx(ctx, String(rangeNm / 2), -R / 2 * 0.77 - 18, -R / 2 * 0.64, CYAN);
  tx(ctx, String(rangeNm / 2), R / 2 * 0.77 + 18, -R / 2 * 0.64, CYAN, "right");
  // compass ticks
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.textAlign = "center"; ctx.font = F13; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let h = 0; h < 360; h += 5) {
    const rel = ((h - t.hdg + 540) % 360) - 180;
    if (Math.abs(rel) > 58) continue;
    const a = (rel - 90) * D2R, len = h % 10 === 0 ? 12 : 6;
    ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len));
  }
  ctx.stroke();
  for (let h = 0; h < 360; h += 10) {
    const rel = ((h - t.hdg + 540) % 360) - 180;
    if (Math.abs(rel) > 56 || (h % 30 && Math.abs(rel) > 40)) continue;
    const a = (rel - 90) * D2R;
    ctx.fillText(String(h / 10), Math.cos(a) * (R - 25), Math.sin(a) * (R - 25));
  }
  // selected heading bug
  if (t.ap !== "OFF") {
    const rel = clamp(((t.apHdg - t.hdg + 540) % 360) - 180, -56, 56), a = (rel - 90) * D2R;
    ctx.strokeStyle = CYAN; ctx.lineWidth = 2.5; ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.04) * (R + 1), Math.sin(a - 0.04) * (R + 1)); ctx.lineTo(Math.cos(a - 0.04) * (R - 14), Math.sin(a - 0.04) * (R - 14));
    ctx.lineTo(Math.cos(a + 0.04) * (R - 14), Math.sin(a + 0.04) * (R - 14)); ctx.lineTo(Math.cos(a + 0.04) * (R + 1), Math.sin(a + 0.04) * (R + 1)); ctx.stroke();
  }
  // route: active leg from aircraft to first waypoint ahead
  const rt = t.route, n = rt.length;
  let act = 0;
  for (; act < n - 1; act++) { proj(t, sinH, cosH, ppn, rt[act].x, rt[act].z); if (_py < -4) break; }
  ctx.strokeStyle = GREEN; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(0, 0);
  for (let i = act; i < n; i++) { proj(t, sinH, cosH, ppn, rt[i].x, rt[i].z); ctx.lineTo(_px, _py); }
  ctx.stroke();
  ctx.lineWidth = 2;
  for (let i = act; i < n; i++) {
    proj(t, sinH, cosH, ppn, rt[i].x, rt[i].z);
    if (_py < -330 || _py > 60 || _px < -220 || _px > 220) continue;
    ctx.strokeStyle = i === act ? WHITE : GREEN;
    ctx.beginPath(); ctx.moveTo(_px, _py - 7); ctx.lineTo(_px + 6, _py); ctx.lineTo(_px, _py + 7); ctx.lineTo(_px - 6, _py); ctx.closePath(); ctx.stroke();
  }
  // runway + ILS course
  if (n) {
    const last = rt[n - 1];
    ctx.strokeStyle = MAG; ctx.lineWidth = 1.5; ctx.setLineDash([8, 5]); ctx.beginPath();
    proj(t, sinH, cosH, ppn, last.x - 18000, last.z); ctx.moveTo(_px, _py);
    proj(t, sinH, cosH, ppn, last.x, last.z); ctx.lineTo(_px, _py); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = WHITE; ctx.lineWidth = 3; ctx.beginPath();
    proj(t, sinH, cosH, ppn, last.x, last.z); ctx.moveTo(_px, _py);
    proj(t, sinH, cosH, ppn, last.x + 3000, last.z); ctx.lineTo(_px, _py); ctx.stroke();
  }
  ctx.restore();
  // aircraft symbol and heading index
  ctx.strokeStyle = YEL; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy + 20); ctx.moveTo(cx - 16, cy + 2); ctx.lineTo(cx + 16, cy + 2); ctx.moveTo(cx - 7, cy + 17); ctx.lineTo(cx + 7, cy + 17); ctx.stroke();
  ctx.fillStyle = YEL; poly(ctx, cx, cy - R + 2, cx - 7, cy - R - 12, cx + 7, cy - R - 12); ctx.fill();
  ctx.fillStyle = "#000"; ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.fillRect(cx - 22, 28, 44, 20); ctx.strokeRect(cx - 22, 28, 44, 20);
  ctx.font = F16B; tx(ctx, pad(t.hdg, 3), cx, 39, GREEN, "center");
  // header
  ctx.font = F12B; tx(ctx, "GS", 8, 12, WHITE); tx(ctx, "TAS", 8, 30, WHITE);
  ctx.font = F14B; tx(ctx, String(Math.round(t.gs)), 52, 12, GREEN); tx(ctx, String(Math.round(t.ias * (1 + t.alt / 1000 * 0.017))), 52, 30, GREEN);
  const eta = (Math.floor(t.time / 1000) + t.distNm / Math.max(t.gs, 80) * 3600) % 86400;
  ctx.font = F13B; tx(ctx, t.destName, 376, 12, WHITE, "right");
  tx(ctx, pad(Math.floor(eta / 3600), 2) + pad(Math.floor(eta / 60) % 60, 2), 376, 30, GREEN, "right");
  tx(ctx, t.distNm.toFixed(1), 340, 48, GREEN, "right"); tx(ctx, "NM", 376, 48, CYAN, "right");
  tx(ctx, pad(Math.round(t.destBrg) % 360, 3) + "°", 376, 66, GREEN, "right");
  if (t.ilsValid) { ctx.font = F12B; tx(ctx, "ILS 09", 8, 350, MAG); tx(ctx, "109.30", 8, 366, MAG); }
  ctx.restore();
}

function gauge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, v: number, maxV: number, white: number, red: number, step: number, txt: string) {
  const a0 = PI * 0.75, sw = PI * 1.25, f = (q: number) => a0 + sw * clamp(q / maxV, 0, 1.03);
  ctx.lineWidth = 2; ctx.strokeStyle = WHITE; ctx.beginPath(); ctx.arc(x, y, r, a0, f(white)); ctx.stroke();
  ctx.strokeStyle = AMBER; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r, f(white), f(red)); ctx.stroke();
  ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let q = 0; q <= white; q += step) { const a = f(q); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.lineTo(x + Math.cos(a) * (r - 5), y + Math.sin(a) * (r - 5)); }
  ctx.stroke();
  ctx.strokeStyle = RED; ctx.lineWidth = 3; ctx.beginPath(); const ar = f(red); ctx.moveTo(x + Math.cos(ar) * (r + 2), y + Math.sin(ar) * (r + 2)); ctx.lineTo(x + Math.cos(ar) * (r - 8), y + Math.sin(ar) * (r - 8)); ctx.stroke();
  const a = f(v);
  ctx.strokeStyle = GREEN; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, r - 8, a0, a); ctx.stroke();
  ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * (r + 1), y + Math.sin(a) * (r + 1)); ctx.stroke();
  ctx.fillStyle = "#000"; ctx.fillRect(x + r * 0.05, y + r * 0.22, r * 0.95, r * 0.5);
  ctx.strokeStyle = WHITE; ctx.lineWidth = 1; ctx.strokeRect(x + r * 0.05, y + r * 0.22, r * 0.95, r * 0.5);
  tx(ctx, txt, x + r * 0.98 - 2, y + r * 0.47, GREEN, "right");
}

export function drawEWD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.textBaseline = "middle";
  const n1 = t.n1 * 100, egt = 380 + t.n1 * 520, n2 = 60 + t.n1 * 40, ff = Math.round(300 + t.n1 * t.n1 * 3200);
  ctx.font = F12; tx(ctx, "FOB:", 8, 12, WHITE); tx(ctx, "6200", 50, 12, GREEN); tx(ctx, "KG", 92, 12, CYAN);
  ctx.font = F16B;
  gauge(ctx, 80, 84, 42, n1, 110, 100, 110, 10, n1.toFixed(1));
  gauge(ctx, 212, 84, 42, n1, 110, 100, 110, 10, n1.toFixed(1));
  ctx.font = F14B;
  gauge(ctx, 80, 164, 30, egt, 1100, 900, 950, 100, String(Math.round(egt)));
  gauge(ctx, 212, 164, 30, egt, 1100, 900, 950, 100, String(Math.round(egt)));
  ctx.font = F12; tx(ctx, "N1", 146, 72, CYAN, "center"); tx(ctx, "%", 146, 88, CYAN, "center");
  tx(ctx, "EGT", 146, 156, CYAN, "center"); tx(ctx, "°C", 146, 172, CYAN, "center");
  tx(ctx, "N2", 146, 206, CYAN, "center"); tx(ctx, "FF", 146, 230, CYAN, "center"); tx(ctx, "KG/H", 146, 244, CYAN, "center");
  ctx.font = F16B;
  tx(ctx, n2.toFixed(1), 100, 206, GREEN, "right"); tx(ctx, n2.toFixed(1), 232, 206, GREEN, "right");
  tx(ctx, String(ff), 100, 232, GREEN, "right"); tx(ctx, String(ff), 232, 232, GREEN, "right");
  // thrust mode
  ctx.font = F14B;
  const mode = t.reverser > 0.5 ? "REV" : t.throttle > 0.97 ? "TOGA" : t.throttle > 0.85 ? "FLX" : t.throttle > 0.7 ? "CL" : "MAN";
  tx(ctx, mode, 330, 22, CYAN, "center");
  tx(ctx, (t.throttle * 100).toFixed(0) + "%", 330, 40, GREEN, "center");
  if (t.reverser > 0.05) { ctx.font = F16B; tx(ctx, "REV", 146, 120, t.reverser > 0.95 ? GREEN : AMBER, "center"); }
  // flap / slat
  ctx.font = F12; tx(ctx, "S", 290, 80, WHITE, "center"); tx(ctx, "F", 368, 80, WHITE, "center");
  ctx.strokeStyle = "#666"; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < 4; i++) { ctx.moveTo(300 + i * 6, 96 + i * 4); ctx.lineTo(300 + i * 6, 101 + i * 4); ctx.moveTo(324 + i * 10, 96 + i * 4); ctx.lineTo(324 + i * 10, 101 + i * 4); }
  ctx.stroke();
  ctx.strokeStyle = GREEN; ctx.lineWidth = 4; ctx.beginPath();
  ctx.moveTo(316, 92); ctx.lineTo(316 - t.slat * 18, 92 + t.slat * 14);
  ctx.moveTo(326, 92); ctx.lineTo(326 + (t.flapDeg / 35) * 32, 92 + (t.flapDeg / 35) * 22);
  ctx.stroke();
  ctx.font = F14B; tx(ctx, t.flapName || "0", 334, 126, GREEN, "center"); tx(ctx, "FLAPS", 334, 62, WHITE, "center");
  // separator
  ctx.strokeStyle = "#8a8f94"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 262); ctx.lineTo(384, 262); ctx.stroke();
  // memo
  ctx.font = F13;
  const memo: [string, string][] = [];
  if (t.stall) memo.push(["STALL STALL", RED]);
  if (!t.gearDown && t.agl < 230 && !t.onGround && t.vs < 0) memo.push(["L/G NOT DOWN", RED]);
  if (t.parking) memo.push(["PARK BRK", GREEN]);
  if (t.spoilers > 0.05) memo.push(["SPEED BRK", t.spoilers > 0.5 && t.flapIdx > 2 ? AMBER : GREEN]);
  memo.push(t.gearDown ? ["LDG GEAR DN", GREEN] : ["LDG GEAR UP", WHITE]);
  if (t.ap !== "OFF") memo.push(["AP1 ENGD", GREEN]);
  memo.push(["GND SPLRS ARMED", GREEN]);
  for (let i = 0; i < memo.length && i < 8; i++) tx(ctx, memo[i][0], i < 4 ? 12 : 198, 282 + (i % 4) * 18, memo[i][1]);
  ctx.restore();
}

export function drawSD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.textBaseline = "middle";
  ctx.font = F14B; tx(ctx, "WHEEL", 192, 14, WHITE, "center");
  ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(158, 25); ctx.lineTo(226, 25); ctx.stroke();
  const gearCol = t.gear > 0.99 ? GREEN : t.gear < 0.01 ? "" : RED;
  if (gearCol) {
    ctx.fillStyle = gearCol;
    poly(ctx, 192, 76, 178, 50, 206, 50); ctx.fill(); poly(ctx, 70, 146, 56, 120, 84, 120); ctx.fill(); poly(ctx, 314, 146, 300, 120, 328, 120); ctx.fill();
  }
  ctx.font = F11;
  tx(ctx, "N/W", 192, 92, WHITE, "center"); tx(ctx, "L/G DOORS", 192, 108, t.gear < 0.01 || t.gear > 0.99 ? WHITE : AMBER, "center");
  tx(ctx, t.gear > 0.99 ? "DOWN" : t.gear < 0.01 ? "UP" : "TRANSIT", 192, 124, t.gear > 0.99 ? GREEN : t.gear < 0.01 ? WHITE : RED, "center");
  // brake temps
  const bt = Math.round(40 + t.brake * 180), bc = bt > 300 ? AMBER : GREEN;
  const wx = [46, 94, 290, 338];
  for (let i = 0; i < 4; i++) {
    const x = wx[i];
    ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.strokeRect(x - 16, 160, 32, 18);
    tx(ctx, String(i + 1), x, 152, WHITE, "center");
    ctx.font = F14B; tx(ctx, String(bt), x, 169, bc, "center"); ctx.font = F11;
    ctx.strokeStyle = bc; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, 204, 12, 0, 7); ctx.stroke();
  }
  tx(ctx, "°C", 192, 169, CYAN, "center");
  tx(ctx, "NORM BRK", 192, 200, GREEN, "center");
  tx(ctx, "ANTI SKID", 70, 240, GREEN, "center"); tx(ctx, "ANTI SKID", 314, 240, GREEN, "center");
  ctx.font = F13B; tx(ctx, t.parking ? "PARK BRK ON" : "AUTO BRK MED", 192, 280, t.parking ? AMBER : GREEN, "center");
  // permanent data
  ctx.strokeStyle = "#8a8f94"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 326); ctx.lineTo(384, 326); ctx.stroke();
  ctx.font = F12;
  tx(ctx, "TAT", 10, 342, WHITE); tx(ctx, "+12", 62, 342, GREEN); tx(ctx, "°C", 72, 342, CYAN);
  tx(ctx, "SAT", 10, 362, WHITE); tx(ctx, "+9", 62, 362, GREEN); tx(ctx, "°C", 72, 362, CYAN);
  const sec = Math.floor(t.time / 1000) % 86400;
  tx(ctx, pad(Math.floor(sec / 3600), 2), 168, 342, GREEN, "right"); tx(ctx, "H", 180, 342, CYAN, "center"); tx(ctx, pad(Math.floor(sec / 60) % 60, 2), 192, 342, GREEN);
  tx(ctx, "G LOAD " + t.gload.toFixed(2), 192, 362, WHITE, "center");
  tx(ctx, "GW", 268, 342, WHITE); tx(ctx, "64000", 346, 342, GREEN, "right"); tx(ctx, "KG", 350, 342, CYAN);
  tx(ctx, "CG", 268, 362, WHITE); tx(ctx, "28.0", 346, 362, GREEN, "right"); tx(ctx, "%", 350, 362, CYAN);
  ctx.restore();
}
