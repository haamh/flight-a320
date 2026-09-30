export interface Telemetry {
  ias: number; gs: number; alt: number; vs: number; hdg: number; pitch: number; bank: number; alpha: number;
  n1: number; throttle: number; flapIdx: number; flapName: string; flapDeg: number; slat: number; gear: number; gearDown: boolean;
  ap: string; athr: boolean; apAlt: number; apHdg: number; apSpd: number;
  gsDev: number; locDev: number; ilsValid: boolean; distNm: number; destBrg: number; destName: string;
  mach: number; gload: number; spoilers: number; brake: number; parking: boolean; stall: boolean; tailstrike: boolean;
  onGround: boolean; agl: number; reverser: number; trend: number; time: number;
  route: { x: number; z: number }[]; pos: { x: number; z: number };
}

const GREEN = "#1fe05a", AMBER = "#ffb000", CYAN = "#1ec8ff", MAG = "#ff4de6", WHITE = "#f2f2f2", RED = "#ff3030", YEL = "#ffe600";
const FONT = (s: number, b = "600") => `${b} ${s}px 'Consolas', 'DejaVu Sans Mono', 'Menlo', monospace`;

export function drawPFD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const H = W;
  const k = W / 384;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  // attitude
  const cx = 180, cy = 190, rad = 95;
  ctx.save();
  ctx.beginPath(); ctx.rect(cx - 82, cy - 100, 164, 200); ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-t.bank * Math.PI / 180);
  const ppd = 4.2;
  const off = t.pitch * ppd;
  ctx.fillStyle = "#1a7bd8"; ctx.fillRect(-300, -600 + off, 600, 600);
  ctx.fillStyle = "#8a5a2c"; ctx.fillRect(-300, off, 600, 600);
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-300, off); ctx.lineTo(300, off); ctx.stroke();
  ctx.fillStyle = WHITE; ctx.font = FONT(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = 1.5;
  for (let p = -30; p <= 30; p += 2.5) {
    if (p === 0) continue;
    const y = off - p * ppd;
    const wdt = p % 10 === 0 ? 50 : p % 5 === 0 ? 26 : 12;
    ctx.beginPath(); ctx.moveTo(-wdt / 2, y); ctx.lineTo(wdt / 2, y); ctx.stroke();
    if (p % 10 === 0) { ctx.fillText(String(Math.abs(p)), -wdt / 2 - 12, y); ctx.fillText(String(Math.abs(p)), wdt / 2 + 12, y); }
  }
  ctx.restore();
  // bank scale
  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  for (const b of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
    const a = (b - 90) * Math.PI / 180;
    const r2 = rad - (Math.abs(b) % 30 === 0 ? 12 : 7);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad); ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, rad, (-135) * Math.PI / 180, (-45) * Math.PI / 180); ctx.stroke();
  ctx.rotate(-t.bank * Math.PI / 180);
  ctx.fillStyle = YEL;
  ctx.beginPath(); ctx.moveTo(0, -rad + 2); ctx.lineTo(-8, -rad + 14); ctx.lineTo(8, -rad + 14); ctx.closePath(); ctx.fill();
  ctx.restore();
  // aircraft symbol
  ctx.fillStyle = "#000"; ctx.strokeStyle = YEL; ctx.lineWidth = 3;
  ctx.strokeRect(cx - 62, cy - 3, 34, 6); ctx.strokeRect(cx + 28, cy - 3, 34, 6);
  ctx.fillStyle = YEL; ctx.fillRect(cx - 4, cy - 4, 8, 8);
  // flight path vector-ish (alpha)
  // ILS
  if (t.ilsValid) {
    ctx.fillStyle = MAG; ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) { if (i) { ctx.beginPath(); ctx.arc(cx + 94, cy + i * 22, 3, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(cx + i * 22, cy + 112, 3, 0, 7); ctx.stroke(); } }
    const gy = cy + Math.max(-2.2, Math.min(2.2, -t.gsDev / 0.35)) * 22;
    const lx = cx + Math.max(-2.2, Math.min(2.2, t.locDev / 1.0)) * 22;
    ctx.beginPath(); ctx.moveTo(cx + 94, gy - 7); ctx.lineTo(cx + 100, gy); ctx.lineTo(cx + 94, gy + 7); ctx.lineTo(cx + 88, gy); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(lx - 7, cy + 112); ctx.lineTo(lx, cy + 106); ctx.lineTo(lx + 7, cy + 112); ctx.lineTo(lx, cy + 118); ctx.closePath(); ctx.fill();
  }
  // speed tape
  const sx = 12, sw = 58, sy0 = cy - 100, sh = 200;
  ctx.fillStyle = "#3a3d40"; ctx.fillRect(sx, sy0, sw, sh);
  ctx.save(); ctx.beginPath(); ctx.rect(sx, sy0, sw, sh); ctx.clip();
  const ppk = 3.2;
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.font = FONT(14); ctx.textAlign = "right"; ctx.lineWidth = 2;
  const s0 = Math.floor((t.ias - 40) / 10) * 10;
  for (let s = s0; s < t.ias + 40; s += 10) {
    if (s < 30) continue;
    const y = cy - (s - t.ias) * ppk;
    ctx.beginPath(); ctx.moveTo(sx + sw - 12, y); ctx.lineTo(sx + sw, y); ctx.stroke();
    if (s % 20 === 0) ctx.fillText(String(s).padStart(3, " "), sx + sw - 16, y + 1);
  }
  // VLS / stall band
  const vls = t.flapIdx >= 3 ? 128 : t.flapIdx >= 1 ? 140 : 190;
  const yv = cy - (vls - t.ias) * ppk;
  ctx.fillStyle = AMBER; ctx.fillRect(sx + sw - 5, yv, 5, 400);
  const vmax = [350, 230, 215, 195, 177][t.flapIdx] || 350;
  const ym = cy - (vmax - t.ias) * ppk;
  for (let y = ym; y > ym - 400; y -= 10) { ctx.fillStyle = RED; ctx.fillRect(sx + sw - 5, y - 5, 5, 5); }
  if (t.athr || t.ap !== "OFF") {
    const ys = cy - (t.apSpd - t.ias) * ppk;
    ctx.fillStyle = MAG; ctx.beginPath(); ctx.moveTo(sx + sw, ys); ctx.lineTo(sx + sw + 8, ys - 6); ctx.lineTo(sx + sw + 8, ys + 6); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // trend
  if (Math.abs(t.trend) > 1) {
    ctx.strokeStyle = YEL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx + sw + 4, cy); ctx.lineTo(sx + sw + 4, cy - t.trend * ppk); ctx.stroke();
  }
  ctx.fillStyle = YEL; ctx.fillRect(sx - 4, cy - 1.5, sw + 18, 3);
  // altitude tape
  const ax = 290, aw = 60;
  ctx.fillStyle = "#3a3d40"; ctx.fillRect(ax, sy0, aw, sh);
  ctx.save(); ctx.beginPath(); ctx.rect(ax, sy0, aw, sh); ctx.clip();
  const ppf = 0.2;
  ctx.fillStyle = WHITE; ctx.strokeStyle = WHITE; ctx.textAlign = "left"; ctx.font = FONT(13);
  const a0 = Math.floor((t.alt - 600) / 100) * 100;
  for (let a = a0; a < t.alt + 600; a += 100) {
    const y = cy - (a - t.alt) * ppf;
    ctx.beginPath(); ctx.moveTo(ax, y); ctx.lineTo(ax + (a % 500 === 0 ? 14 : 8), y); ctx.stroke();
    if (a % 500 === 0) ctx.fillText(String(Math.round(a / 100)).padStart(3, "0"), ax + 18, y + 1);
  }
  if (t.ap !== "OFF") { const y = cy - (t.apAlt - t.alt) * ppf; ctx.fillStyle = CYAN; ctx.fillRect(ax, y - 2, 12, 4); }
  // ground
  const gyy = cy + t.agl * 3.28 * ppf;
  ctx.fillStyle = "rgba(255,40,40,0.8)"; ctx.fillRect(ax, gyy, 8, 300);
  ctx.restore();
  ctx.fillStyle = "#000"; ctx.strokeStyle = YEL; ctx.lineWidth = 2;
  ctx.fillRect(ax + 6, cy - 14, aw - 4, 28); ctx.strokeRect(ax + 6, cy - 14, aw - 4, 28);
  ctx.fillStyle = GREEN; ctx.font = FONT(17, "700"); ctx.textAlign = "right";
  ctx.fillText(String(Math.round(t.alt / 10) * 10), ax + aw, cy + 1);
  // VS
  const vx = 356;
  ctx.fillStyle = "#3a3d40"; ctx.fillRect(vx, cy - 80, 20, 160);
  const vsy = cy - Math.sign(t.vs) * Math.min(75, Math.sqrt(Math.abs(t.vs)) * 1.6);
  ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(vx + 20, cy); ctx.lineTo(vx + 4, vsy); ctx.stroke();
  ctx.fillStyle = GREEN; ctx.font = FONT(11); ctx.textAlign = "center";
  if (Math.abs(t.vs) > 200) ctx.fillText(String(Math.round(Math.abs(t.vs) / 100)), vx + 10, vsy + (t.vs > 0 ? -8 : 10));
  // heading tape
  const hy = 330;
  ctx.fillStyle = "#3a3d40"; ctx.fillRect(cx - 90, hy, 180, 32);
  ctx.save(); ctx.beginPath(); ctx.rect(cx - 90, hy, 180, 32); ctx.clip();
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.font = FONT(13); ctx.textAlign = "center";
  for (let h = Math.floor(t.hdg / 5) * 5 - 25; h < t.hdg + 25; h += 5) {
    const x = cx + (h - t.hdg) * 3.6;
    ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + (h % 10 === 0 ? 10 : 5)); ctx.stroke();
    const hh = ((h % 360) + 360) % 360;
    if (hh % 10 === 0) ctx.fillText(String(hh / 10).padStart(2, "0"), x, hy + 22);
  }
  ctx.restore();
  ctx.fillStyle = YEL; ctx.fillRect(cx - 1.5, hy - 6, 3, 18);
  // FMA
  ctx.strokeStyle = "#777"; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(i * 76.8, 2); ctx.lineTo(i * 76.8, 42); ctx.stroke(); }
  ctx.font = FONT(12, "700"); ctx.textAlign = "center";
  const fma = [
    t.athr ? (t.ap === "FLARE" && t.agl < 9 ? "RETARD" : "SPEED") : (t.throttle > 0.97 ? "MAN TOGA" : ""),
    t.ap === "APPR" ? "G/S" : t.ap === "FLARE" ? "FLARE" : t.ap === "HDG/ALT" || t.ap === "LOC" ? "ALT" : "",
    t.ap === "APPR" || t.ap === "LOC" || t.ap === "FLARE" ? "LOC" : t.ap === "ROLLOUT" ? "ROLL OUT" : t.ap === "HDG/ALT" ? "HDG" : "",
    t.ap === "APPR" ? "CAT 3" : "",
    t.ap !== "OFF" && t.ap !== "ROLLOUT" ? "AP1" : "",
  ];
  fma.forEach((s, i) => { ctx.fillStyle = i === 4 ? WHITE : GREEN; ctx.fillText(s, i * 76.8 + 38.4, 16); });
  ctx.fillStyle = CYAN; ctx.fillText(t.athr ? "A/THR" : "", 4 * 76.8 + 38.4, 34);
  if (t.ap === "LOC") { ctx.fillStyle = CYAN; ctx.fillText("G/S", 76.8 + 38.4, 34); }
  // warnings
  ctx.font = FONT(16, "800");
  if (t.stall) { ctx.fillStyle = RED; ctx.fillText("STALL", cx, cy + 60); }
  else if (t.tailstrike) { ctx.fillStyle = AMBER; ctx.fillText("TAIL STRIKE", cx, cy + 60); }
  // mach
  ctx.fillStyle = GREEN; ctx.font = FONT(13); ctx.textAlign = "left";
  if (t.mach > 0.45) ctx.fillText("." + String(Math.round(t.mach * 1000)).padStart(3, "0").slice(0, 3), 14, 312);
  // radio altitude
  if (t.agl < 760 && !t.onGround) { ctx.fillStyle = t.agl < 122 ? AMBER : GREEN; ctx.font = FONT(18, "700"); ctx.textAlign = "center"; ctx.fillText(String(Math.round(t.agl * 3.28)), cx, cy + 86); }
  ctx.restore();
  void H;
}

export function drawND(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  const cx = 192, cy = 300, R = 240;
  const rangeNm = t.distNm > 20 ? 40 : t.distNm > 10 ? 20 : 10;
  const ppn = R / rangeNm;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 30, 384, 354); ctx.clip();
  ctx.translate(cx, cy);
  // arc
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, R, -Math.PI * 0.82, -Math.PI * 0.18); ctx.stroke();
  ctx.setLineDash([4, 6]); ctx.strokeStyle = "#8a8a8a"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, R / 2, -Math.PI * 0.82, -Math.PI * 0.18); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CYAN; ctx.font = FONT(11); ctx.textAlign = "left";
  ctx.fillText(String(rangeNm / 2), -R / 2 * 0.7 - 20, -R / 2 * 0.7);
  // compass ticks
  ctx.strokeStyle = WHITE; ctx.fillStyle = WHITE; ctx.textAlign = "center"; ctx.font = FONT(13);
  for (let h = 0; h < 360; h += 5) {
    const rel = ((h - t.hdg + 540) % 360) - 180;
    if (Math.abs(rel) > 60) continue;
    const a = (rel - 90) * Math.PI / 180;
    const len = h % 10 === 0 ? 12 : 6;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len)); ctx.stroke();
    if (h % 30 === 0) ctx.fillText(String(h / 10), Math.cos(a) * (R - 24), Math.sin(a) * (R - 24) + 4);
  }
  // route
  const toScreen = (x: number, z: number) => {
    const dx = (x - t.pos.x) / 1852, dz = (z - t.pos.z) / 1852;
    const h = t.hdg * Math.PI / 180;
    const fwd = dx * Math.sin(h) - dz * Math.cos(h);
    const rgt = dx * Math.cos(h) + dz * Math.sin(h);
    return [rgt * ppn, -fwd * ppn];
  };
  ctx.strokeStyle = GREEN; ctx.lineWidth = 2.5;
  ctx.beginPath();
  t.route.forEach((p, i) => { const [x, y] = toScreen(p.x, p.z); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = WHITE; ctx.font = FONT(11);
  t.route.forEach((p, i) => {
    const [x, y] = toScreen(p.x, p.z);
    ctx.strokeStyle = i === t.route.length - 1 ? WHITE : GREEN;
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke();
  });
  // ILS course line
  ctx.setLineDash([8, 5]); ctx.strokeStyle = MAG; ctx.lineWidth = 1.5;
  const last = t.route[t.route.length - 1];
  const [lx1, ly1] = toScreen(last.x - 18000, last.z);
  const [lx2, ly2] = toScreen(last.x + 3000, last.z);
  ctx.beginPath(); ctx.moveTo(lx1, ly1); ctx.lineTo(lx2, ly2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  // aircraft symbol
  ctx.strokeStyle = YEL; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy + 20); ctx.moveTo(cx - 16, cy); ctx.lineTo(cx + 16, cy); ctx.moveTo(cx - 7, cy + 16); ctx.lineTo(cx + 7, cy + 16); ctx.stroke();
  ctx.fillStyle = YEL; ctx.beginPath(); ctx.moveTo(cx, 58); ctx.lineTo(cx - 7, 44); ctx.lineTo(cx + 7, 44); ctx.closePath(); ctx.fill();
  // header
  ctx.font = FONT(13, "700"); ctx.textAlign = "left";
  ctx.fillStyle = WHITE; ctx.fillText("GS", 8, 18); ctx.fillStyle = GREEN; ctx.fillText(String(Math.round(t.gs)), 32, 18);
  ctx.fillStyle = WHITE; ctx.fillText("TAS", 72, 18); ctx.fillStyle = GREEN; ctx.fillText(String(Math.round(t.ias * (1 + t.alt / 1000 * 0.017))), 104, 18);
  ctx.textAlign = "right";
  ctx.fillStyle = WHITE; ctx.fillText(t.destName, 376, 16);
  ctx.fillStyle = GREEN; ctx.fillText(`${t.distNm.toFixed(1)} NM`, 376, 32);
  ctx.fillText(`${String(Math.round(t.destBrg) % 360).padStart(3, "0")}°`, 376, 48);
  if (t.ilsValid) { ctx.textAlign = "left"; ctx.fillStyle = MAG; ctx.fillText("ILS 09 109.30", 8, 372); }
  ctx.restore();
}

function dial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, v: number, label: string, txt: string, maxV = 1) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.1;
  ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke();
  ctx.strokeStyle = RED; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r, a1 - 0.2, a1); ctx.stroke();
  const a = a0 + (a1 - a0) * Math.min(1.05, v / maxV);
  ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * (r - 2), y + Math.sin(a) * (r - 2)); ctx.stroke();
  ctx.fillStyle = "#000"; ctx.strokeStyle = WHITE; ctx.lineWidth = 1;
  ctx.fillRect(x + 4, y + 6, 54, 22); ctx.strokeRect(x + 4, y + 6, 54, 22);
  ctx.fillStyle = GREEN; ctx.font = FONT(16, "700"); ctx.textAlign = "right"; ctx.fillText(txt, x + 55, y + 18);
  ctx.fillStyle = WHITE; ctx.font = FONT(11); ctx.textAlign = "center"; ctx.fillText(label, x, y - r - 6);
}

export function drawEWD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.textBaseline = "middle";
  const n1 = t.n1 * 100;
  dial(ctx, 70, 70, 44, n1, "N1 %", n1.toFixed(1), 104);
  dial(ctx, 200, 70, 44, n1, "", n1.toFixed(1), 104);
  const egt = 380 + t.n1 * 520;
  dial(ctx, 70, 180, 36, egt, "EGT °C", String(Math.round(egt)), 1000);
  dial(ctx, 200, 180, 36, egt, "", String(Math.round(egt)), 1000);
  ctx.fillStyle = CYAN; ctx.font = FONT(12); ctx.textAlign = "center";
  ctx.fillText("FF KG/H", 135, 245);
  ctx.fillStyle = GREEN; ctx.font = FONT(15, "700");
  const ff = Math.round(300 + t.n1 * t.n1 * 3200);
  ctx.fillText(String(ff), 70, 262); ctx.fillText(String(ff), 200, 262);
  // thrust mode
  ctx.fillStyle = CYAN; ctx.font = FONT(14, "700"); ctx.textAlign = "left";
  const mode = t.reverser > 0.5 ? "REV" : t.throttle > 0.97 ? "TOGA" : t.throttle > 0.85 ? "FLX" : t.throttle > 0.7 ? "CL" : "MAN";
  ctx.fillText(mode, 280, 22);
  ctx.fillStyle = GREEN; ctx.fillText((t.throttle * 100).toFixed(1) + "%", 280, 42);
  if (t.reverser > 0.05) { ctx.fillStyle = t.reverser > 0.95 ? GREEN : AMBER; ctx.font = FONT(16, "800"); ctx.fillText("REV", 120, 110); }
  // flaps
  ctx.fillStyle = WHITE; ctx.font = FONT(12); ctx.fillText("S", 276, 90); ctx.fillText("F", 362, 90);
  ctx.strokeStyle = "#555"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(292, 90); ctx.lineTo(352, 90); ctx.stroke();
  ctx.strokeStyle = GREEN; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(318, 88); ctx.lineTo(318 - t.slat * 26, 88 + t.slat * 16); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(326, 88); ctx.lineTo(326 + (t.flapDeg / 35) * 28, 88 + (t.flapDeg / 35) * 22); ctx.stroke();
  ctx.fillStyle = CYAN; ctx.font = FONT(14, "700"); ctx.textAlign = "center"; ctx.fillText("FLAP " + t.flapName, 320, 130);
  // memo
  ctx.textAlign = "left"; ctx.font = FONT(13, "600");
  const memo: [string, string][] = [];
  if (t.parking) memo.push(["PARK BRK", GREEN]);
  if (t.spoilers > 0.05) memo.push(["SPEED BRK", t.spoilers > 0.5 && t.flapIdx > 2 ? AMBER : GREEN]);
  if (t.gearDown) memo.push(["LDG GEAR DN", GREEN]); else memo.push(["LDG GEAR UP", WHITE]);
  if (t.ap !== "OFF") memo.push(["AP1 ENGD", GREEN]);
  if (t.stall) memo.push(["STALL STALL", RED]);
  if (!t.gearDown && t.agl < 230 && !t.onGround && t.vs < 0) memo.push(["L/G NOT DOWN", RED]);
  memo.push(["GND SPLRS ARMED", GREEN]);
  memo.forEach(([s, c], i) => { ctx.fillStyle = c; ctx.fillText(s, 20, 300 + i * 17); });
  ctx.restore();
}

export function drawSD(ctx: CanvasRenderingContext2D, W: number, t: Telemetry) {
  const k = W / 384;
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 384, 384);
  ctx.fillStyle = WHITE; ctx.font = FONT(15, "700"); ctx.textAlign = "center"; ctx.fillText("WHEEL", 192, 20);
  const gearCol = t.gear > 0.99 ? GREEN : t.gear < 0.01 ? "#333" : RED;
  const tri = (x: number, y: number) => { ctx.fillStyle = gearCol; ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x - 14, y - 8); ctx.lineTo(x + 14, y - 8); ctx.closePath(); ctx.fill(); };
  tri(192, 70); tri(100, 150); tri(284, 150);
  ctx.fillStyle = WHITE; ctx.font = FONT(12);
  ctx.fillText(t.gear > 0.99 ? "DOWN & LOCKED" : t.gear < 0.01 ? "UP & LOCKED" : "IN TRANSIT", 192, 110);
  const bt = Math.round(40 + t.brake * 180);
  for (const [x, y] of [[80, 220], [120, 220], [264, 220], [304, 220]]) {
    ctx.strokeStyle = WHITE; ctx.strokeRect(x - 14, y - 26, 28, 52);
    ctx.fillStyle = bt > 300 ? AMBER : GREEN; ctx.fillText(String(bt), x, y + 44);
  }
  ctx.fillStyle = CYAN; ctx.fillText("°C", 192, 264);
  ctx.fillStyle = t.parking ? AMBER : GREEN; ctx.font = FONT(13, "700");
  ctx.fillText(t.parking ? "PARK BRK ON" : "AUTO BRK MED", 192, 300);
  ctx.fillStyle = WHITE; ctx.font = FONT(12); ctx.textAlign = "left";
  ctx.fillText("TAT +12 °C", 12, 340); ctx.fillText("SAT +9 °C", 12, 358);
  ctx.textAlign = "right";
  const tm = new Date(t.time);
  ctx.fillStyle = GREEN; ctx.fillText(`${String(tm.getUTCHours()).padStart(2, "0")} H ${String(tm.getUTCMinutes()).padStart(2, "0")}`, 372, 340);
  ctx.fillStyle = WHITE; ctx.fillText("GW 64000 KG", 372, 358);
  ctx.textAlign = "center"; ctx.fillStyle = WHITE; ctx.fillText(`G LOAD ${t.gload.toFixed(2)}`, 192, 380);
  ctx.restore();
}
