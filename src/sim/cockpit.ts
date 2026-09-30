import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { makeCanvas } from "./textures";
import { lerp } from "./noise";
import { fuselageSection } from "./fuselage";
import type { VisualState } from "./aircraft";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export interface CockpitRig {
  group: THREE.Group;
  screens: { pfd: HTMLCanvasElement; nd: HTMLCanvasElement; ewd: HTMLCanvasElement; sd: HTMLCanvasElement; refresh: () => void };
  update: (s: VisualState, dt: number) => void;
}

function overheadTexture() {
  const { c, ctx } = makeCanvas(512, 512);
  ctx.fillStyle = "#4b525b"; ctx.fillRect(0, 0, 512, 512);
  for (let py = 0; py < 8; py++) for (let px = 0; px < 5; px++) {
    const x = 12 + px * 100, y = 10 + py * 62;
    ctx.strokeStyle = "#c9ced4"; ctx.lineWidth = 1; ctx.strokeRect(x, y, 90, 54);
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = "#23272c"; ctx.fillRect(x + 8 + k * 28, y + 14, 22, 22);
      if ((px + py + k) % 4 === 0) { ctx.fillStyle = "#1ec8ff"; ctx.fillRect(x + 10 + k * 28, y + 30, 18, 4); }
      if ((px * 3 + py + k) % 7 === 0) { ctx.fillStyle = "#ffb000"; ctx.fillRect(x + 10 + k * 28, y + 16, 18, 4); }
    }
    ctx.fillStyle = "#e6e6e6"; ctx.font = "9px Arial"; ctx.fillText(["ELEC", "HYD", "FUEL", "AIR", "ADIRS", "APU", "ANTI ICE", "LIGHTS"][py], x + 4, y + 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Flight deck interior (everything inside the pressure shell except the window frames / lining). Body frame: nose -Z, up +Y, right +X. */
export function buildCockpit(): CockpitRig {
  const group = new THREE.Group();
  const IM = {
    lining: new THREE.MeshStandardMaterial({ color: "#8f969e", roughness: 0.85, side: THREE.DoubleSide }),
    panel: new THREE.MeshStandardMaterial({ color: "#3b4148", roughness: 0.7, metalness: 0.1 }),
    panelDark: new THREE.MeshStandardMaterial({ color: "#23272c", roughness: 0.6, metalness: 0.2 }),
    seat: new THREE.MeshStandardMaterial({ color: "#2c3545", roughness: 0.75 }),
    floor: new THREE.MeshStandardMaterial({ color: "#2a2d33", roughness: 0.95, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ color: "#9aa0a6", roughness: 0.3, metalness: 0.9 }),
    black: new THREE.MeshStandardMaterial({ color: "#0e0f11", roughness: 0.5 }),
    overhead: new THREE.MeshStandardMaterial({ map: overheadTexture(), roughness: 0.6 }),
  };
  {
    // bulkhead with door
    const bh = new THREE.Mesh(new THREE.CircleGeometry(1.95, 64), IM.lining);
    bh.position.z = -11.95; group.add(bh);
    const dr = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.06), IM.panel); dr.position.set(0, 0.4, -11.98); group.add(dr);
    // floor shaped to fuselage
    const fy = -0.4;
    const sh = new THREE.Shape();
    const zsF: number[] = []; for (let z = -17.2; z <= -11.95; z += 0.1) zsF.push(z);
    const hw = (z: number) => { const s = fuselageSection(z); const d = (fy - s.cy) / s.rh; return s.rw * Math.sqrt(Math.max(0, 1 - d * d)) - 0.06; };
    sh.moveTo(hw(zsF[0]), zsF[0]);
    zsF.forEach((z) => sh.lineTo(hw(z), z));
    zsF.slice().reverse().forEach((z) => sh.lineTo(-hw(z), z));
    const fg = new THREE.ShapeGeometry(sh); fg.rotateX(Math.PI / 2); fg.translate(0, fy, 0);
    const floor = new THREE.Mesh(fg, IM.floor); floor.receiveShadow = true; group.add(floor);
  }
  // instrument panel
  const panel = new THREE.Mesh(new RoundedBoxGeometry(2.3, 0.95, 0.12, 3, 0.03), IM.panel);
  panel.position.set(0, 0.16, -16.12); panel.rotation.x = -0.12; group.add(panel);
  const glare = new THREE.Mesh(new RoundedBoxGeometry(2.1, 0.1, 0.5, 3, 0.04), IM.panelDark);
  glare.position.set(0, 0.66, -16.05); group.add(glare);
  const fcu = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.1, 0.06, 2, 0.01), IM.panel);
  fcu.position.set(0, 0.66, -15.78); group.add(fcu);
  // screens
  const mkScreen = (w: number, h: number) => { const { c } = makeCanvas(w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return { c, t }; };
  const S_PFD = mkScreen(384, 384), S_ND = mkScreen(384, 384), S_EWD = mkScreen(384, 384), S_SD = mkScreen(384, 384);
  const screenMat = (t: THREE.Texture) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  const screenAt = (t: THREE.Texture, x: number, y: number, z: number, rx: number) => {
    const bez = new THREE.Mesh(new RoundedBoxGeometry(0.235, 0.235, 0.03, 2, 0.01), IM.black);
    bez.position.set(x, y, z); bez.rotation.x = rx; group.add(bez);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), screenMat(t));
    m.position.set(x, y, z).add(V(0, Math.sin(rx) * -0.017, 0.017 * Math.cos(rx))); m.rotation.x = rx; group.add(m);
  };
  const pz = -16.05, prx = -0.12;
  screenAt(S_PFD.t, -0.8, 0.3, pz, prx); screenAt(S_ND.t, -0.53, 0.3, pz, prx);
  screenAt(S_PFD.t, 0.8, 0.3, pz, prx); screenAt(S_ND.t, 0.53, 0.3, pz, prx);
  screenAt(S_EWD.t, 0, 0.36, pz, prx); screenAt(S_SD.t, 0, 0.1, pz + 0.02, prx);
  // pedestal
  const ped = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.5, 1.2, 3, 0.04), IM.panel);
  ped.position.set(0, -0.15, -15.25); group.add(ped);
  const pedTop = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 1.1), IM.panelDark);
  pedTop.position.set(0, 0.11, -15.25); group.add(pedTop);
  const lever = (x: number, color: string) => {
    const piv = new THREE.Group(); piv.position.set(x, 0.12, -15.45); group.add(piv);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.03), IM.metal); arm.position.y = 0.1; piv.add(arm);
    const knob = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.045, 0.06, 2, 0.015), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    knob.position.y = 0.21; piv.add(knob);
    return piv;
  };
  const thrL = lever(-0.07, "#1e1f22"), thrR = lever(0.07, "#1e1f22");
  const flapL = lever(0.17, "#e9e9e9"); flapL.position.z = -15.05;
  const sbL = lever(-0.17, "#222"); sbL.position.z = -15.05;
  // side consoles + sidesticks
  const sticks: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const con = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.3, 1.0, 3, 0.04), IM.panel);
    con.position.set(1.12 * side, -0.2, -15.0); group.add(con);
    const st = new THREE.Group(); st.position.set(1.1 * side, -0.05, -15.25); group.add(st);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.1, 12), IM.black); shaft.position.y = 0.05; st.add(shaft);
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.09, 6, 12), IM.black); grip.position.y = 0.15; grip.rotation.x = 0.25; st.add(grip);
    sticks.push(st);
    // seats
    const seat = new THREE.Group(); seat.position.set(0.55 * side, -0.4, -14.55); group.add(seat);
    const pan = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.14, 0.52, 3, 0.05), IM.seat); pan.position.y = 0.45; seat.add(pan);
    const back = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.8, 0.14, 3, 0.05), IM.seat); back.position.set(0, 0.9, 0.25); back.rotation.x = -0.12; seat.add(back);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.18, 0.12, 3, 0.04), IM.seat); head.position.set(0, 1.4, 0.32); seat.add(head);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 0.4, 16), IM.metal); base.position.y = 0.2; seat.add(base);
    for (const ax of [-1, 1]) { const arm = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.06, 0.4, 2, 0.02), IM.seat); arm.position.set(0.28 * ax, 0.66, 0.05); seat.add(arm); }
    // rudder pedals
    for (const px of [-0.12, 0.12]) { const pd = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.22, 0.03, 2, 0.01), IM.metal); pd.position.set(0.55 * side + px, -0.22, -15.85); pd.rotation.x = -0.5; group.add(pd); }
  }
  // overhead panel
  const ovh = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.06, 1.2, 2, 0.02), [IM.panel, IM.panel, IM.panel, IM.overhead, IM.panel, IM.panel]);
  ovh.position.set(0, 1.42, -15.1); ovh.rotation.x = -0.35; group.add(ovh);
  const cockpitLight = new THREE.PointLight("#ffe7c4", 0.6, 3.5, 1.5);
  cockpitLight.position.set(0, 1.2, -15.0); group.add(cockpitLight);


  const update = (s: VisualState, dt: number) => {
    const tl = lerp(0.5, -0.55, s.throttle) - s.reverser * 0.35;
    thrL.rotation.x = tl; thrR.rotation.x = tl;
    flapL.rotation.x = lerp(0.5, -0.4, s.flapLever / 4);
    sbL.rotation.x = lerp(0.4, -0.3, s.spoilers);
    sticks.forEach((st) => { st.rotation.x = s.stickY * 0.3; st.rotation.z = -s.stickX * 0.3; });
    cockpitLight.intensity = 0.25 + (1 - s.dayFactor) * 1.2;
    void dt;
  };

  return {
    group, update,
    screens: {
      pfd: S_PFD.c, nd: S_ND.c, ewd: S_EWD.c, sd: S_SD.c,
      refresh: () => { S_PFD.t.needsUpdate = true; S_ND.t.needsUpdate = true; S_EWD.t.needsUpdate = true; S_SD.t.needsUpdate = true; },
    },
  };
}
