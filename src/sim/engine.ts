import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { buildAircraft, type AircraftRig, type VisualState } from "./aircraft";
import { buildWorld, TIMES, type World } from "./world";
import { FlightModel, FLAP_NAMES, runwayFrame, type Controls } from "./physics";
import { AIRPORTS, groundAt } from "./terrain";
import { drawPFD, drawND, drawEWD, drawSD, type Telemetry } from "./instruments";
import { SimAudio } from "./audio";
import { softPuffTexture } from "./textures";
import { clamp, lerp } from "./noise";

export type CamMode = "chase" | "cockpit" | "orbit" | "tower" | "flyby" | "cabin" | "gear";
export const CAM_MODES: { id: CamMode; name: string }[] = [
  { id: "chase", name: "Chase" },
  { id: "cockpit", name: "Cockpit" },
  { id: "orbit", name: "Free Orbit" },
  { id: "tower", name: "Tower" },
  { id: "flyby", name: "Fly-by" },
  { id: "cabin", name: "Wing View" },
  { id: "gear", name: "Undercarriage" },
];

export interface SimMessage { text: string; kind: "info" | "warn" | "good" | "bad"; t: number }
export interface SimCallbacks {
  onTelemetry: (t: Telemetry & { cam: CamMode; paused: boolean; lights: boolean }) => void;
  onMessage: (m: SimMessage) => void;
  onEnd: (r: { kind: "crash" | "landed"; title: string; lines: string[] }) => void;
}

const D2R = Math.PI / 180;
const KT = 0.514444;

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, amount: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float amount; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float d = length(c);
      vec2 off = c * d * 0.0025 * amount;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;
      float vig = smoothstep(0.95, 0.35, d);
      col *= mix(1.0, vig, 0.55 * amount);
      col += (hash(vUv * 1000.0 + time) - 0.5) * 0.018 * amount;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Sim {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  world!: World;
  rig!: AircraftRig;
  fm = new FlightModel();
  audio = new SimAudio();
  ctl: Controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: true, flapLever: 1, gearDown: true, speedbrake: 0, reverse: false };
  cam: CamMode = "chase";
  paused = true;
  running = false;
  lights = { nav: true, beacon: true, strobe: true, landing: true, taxi: true };
  timeIdx = 2;
  private keys = new Set<string>();
  private clock = new THREE.Clock();
  private simTime = 0;
  private frame = 0;
  private orbitYaw = 0.35; private orbitPitch = 0.12; private orbitDist = 48;
  private headYaw = 0; private headPitch = -0.08;
  private camPos = new THREE.Vector3();
  private camSmoothQ = new THREE.Quaternion();
  private flybyPos = new THREE.Vector3();
  private flybyValid = false;
  private dragging = false; private lastMouse = [0, 0];
  private bloom: UnrealBloomPass;
  private vignette: ShaderPass;
  private smoke: { s: THREE.Sprite; v: THREE.Vector3; life: number }[] = [];
  private smokeMat!: THREE.SpriteMaterial;
  private endShown = false;
  private disposed = false;
  private raf = 0;
  private cb: SimCallbacks;
  private startClock = Date.UTC(2026, 5, 21, 17, 42, 0);
  private lastTrendIas = 0; private trend = 0;
  hudVisible = true;
  menuOrbit = true;
  /** dev tooling: body-frame look-at point for the undercarriage camera */
  debugTarget: [number, number, number] | null = null;
  shake = new THREE.Vector3();

  constructor(private container: HTMLElement, cb: SimCallbacks) {
    this.cb = cb;
    const r = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.setSize(container.clientWidth, container.clientHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.55;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(r.domElement);
    r.domElement.style.display = "block";
    this.renderer = r;
    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.05, 320000);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.95);
    this.vignette = new ShaderPass(VignetteShader);
  }

  /** Heavy build step (call after first paint) */
  build() {
    this.rig = buildAircraft();
    const rig = this.rig;
    const parkedTemplate = rig.root.clone(true);
    const toRemove: THREE.Object3D[] = [];
    parkedTemplate.traverse((o) => {
      if ((o as THREE.Light).isLight || (o as THREE.Sprite).isSprite) toRemove.push(o);
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial && (m.material as THREE.MeshBasicMaterial).toneMapped === false && m.geometry.type !== "PlaneGeometry") toRemove.push(o);
    });
    toRemove.forEach((o) => o.parent?.remove(o));
    this.world = buildWorld(() => parkedTemplate.clone(true));
    this.world.scene.add(rig.root);
    rig.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.castShadow || false; } });
    this.fm.hardPoints = rig.hardPoints;
    // post
    this.composer.addPass(new RenderPass(this.world.scene, this.camera));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.vignette);
    this.world.setTime(TIMES[this.timeIdx], this.renderer);
    this.smokeMat = new THREE.SpriteMaterial({ map: softPuffTexture(9), color: "#d8d8d8", transparent: true, depthWrite: false, opacity: 0.6 });
    this.bindInput();
    this.resetDeparture();
    this.paused = true;
    this.running = true;
    this.clock.start();
    this.loop();
  }

  setTimeOfDay(i: number) {
    this.timeIdx = i;
    this.world.setTime(TIMES[i], this.renderer);
    const night = this.world.dayFactor < 0.5;
    this.lights.landing = night || true;
  }

  resetDeparture() {
    this.fm.resetOnRunway(AIRPORTS[0], 45);
    Object.assign(this.ctl, { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: true, flapLever: 1, gearDown: true, speedbrake: 0, reverse: false });
    this.fm.flapDeg = 10; this.fm.slat = 0.7;
    this.endShown = false;
    this.flybyValid = false;
    this.snapCamera();
    this.msg("Cleared for takeoff runway 09. Release parking brake (P), set TOGA (T), rotate at 145 kt.", "info");
  }
  resetApproach() {
    this.fm.resetOnApproach(AIRPORTS[1], 8);
    Object.assign(this.ctl, { pitch: 0, roll: 0, yaw: 0, throttle: 0.34, brake: 0, parkingBrake: false, flapLever: 4, gearDown: true, speedbrake: 0, reverse: false });
    this.endShown = false;
    this.flybyValid = false;
    this.snapCamera();
    this.msg("Established ILS 09 at Bayview, 8 NM. Press J for autoland or hand-fly the glideslope.", "info");
  }

  private msg(text: string, kind: SimMessage["kind"] = "info") { this.cb.onMessage({ text, kind, t: performance.now() }); }

  private snapCamera() {
    this.camPos.set(0, 0, 0);
    this.camSmoothQ.copy(this.fm.quat);
  }

  setCam(c: CamMode) {
    this.cam = c;
    this.flybyValid = false;
    if (c === "cockpit" || c === "cabin") { this.headYaw = c === "cabin" ? 1.95 : 0; this.headPitch = c === "cabin" ? -0.22 : -0.1; }
    if (c === "chase") { this.orbitYaw = 0; this.orbitPitch = 0.1; this.orbitDist = 52; }
    if (c === "orbit") { this.orbitYaw = 2.3; this.orbitPitch = 0.15; this.orbitDist = 60; }
    if (c === "gear") { this.orbitYaw = 0.9; this.orbitPitch = -0.1; this.orbitDist = 14; }
  }

  private bindInput() {
    const el = this.renderer.domElement;
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " ", "pageup", "pagedown"].includes(k)) e.preventDefault();
      if (!this.keys.has(k)) this.onKeyPress(k, e);
      this.keys.add(k);
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", () => this.keys.clear());
    el.addEventListener("mousedown", (e) => { this.dragging = true; this.lastMouse = [e.clientX, e.clientY]; });
    window.addEventListener("mouseup", () => (this.dragging = false));
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse[0], dy = e.clientY - this.lastMouse[1];
      this.lastMouse = [e.clientX, e.clientY];
      if (this.cam === "cockpit" || this.cam === "cabin") {
        this.headYaw -= dx * 0.004; this.headPitch = clamp(this.headPitch - dy * 0.004, -1.2, 1.2);
      } else { this.orbitYaw -= dx * 0.006; this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, -1.3, 1.4); }
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.cam === "cockpit" || this.cam === "cabin" || this.cam === "tower" || this.cam === "flyby") this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.08 : 0.92), 0.25, 1.6);
      else this.orbitDist = clamp(this.orbitDist * (e.deltaY > 0 ? 1.1 : 0.9), 8, 900);
    }, { passive: false });
    const onResize = () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
    this.cleanup = () => {
      window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); window.removeEventListener("resize", onResize);
    };
  }
  private zoom = 1;
  private cleanup: () => void = () => {};

  private onKeyPress(k: string, e: KeyboardEvent) {
    const c = this.ctl, fm = this.fm;
    if (k === "escape") { this.paused = !this.paused; return; }
    if (this.paused && k !== "c" && !/^[1-7]$/.test(k) && k !== "h") return;
    switch (k) {
      case "g":
        if (fm.onGround && c.gearDown) { this.msg("Gear lever locked - weight on wheels", "warn"); break; }
        c.gearDown = !c.gearDown; this.msg(c.gearDown ? "Gear DOWN" : "Gear UP", "info"); break;
      case "f": c.flapLever = Math.min(4, c.flapLever + 1); this.msg("Flaps " + FLAP_NAMES[c.flapLever], "info"); break;
      case "v": c.flapLever = Math.max(0, c.flapLever - 1); this.msg("Flaps " + FLAP_NAMES[c.flapLever], "info"); break;
      case "p": c.parkingBrake = !c.parkingBrake; this.msg(c.parkingBrake ? "Parking brake SET" : "Parking brake RELEASED", "info"); break;
      case "t": c.throttle = 1; fm.athr = false; this.msg("TOGA thrust", "info"); break;
      case "r": if (fm.onGround) { c.reverse = !c.reverse; if (c.reverse) c.throttle = Math.max(c.throttle, 0.0); this.msg(c.reverse ? "Reversers deployed" : "Reversers stowed", "info"); } else this.msg("Reverse inhibited in flight", "warn"); break;
      case "b": c.speedbrake = c.speedbrake > 0 ? 0 : 1; this.msg(c.speedbrake ? "Speedbrakes extended" : "Speedbrakes retracted", "info"); break;
      case "l": { const on = !this.lights.landing; this.lights.landing = on; this.lights.taxi = on; this.msg(on ? "Landing & taxi lights ON" : "Landing & taxi lights OFF", "info"); break; }
      case "k":
        if (fm.onGround) { this.msg("Autopilot unavailable on ground", "warn"); break; }
        if (fm.ap === "OFF") { fm.ap = "HDG/ALT"; fm.apAlt = Math.max(300, Math.round((fm.pos.y - 3.45) / 30.48) * 30.48); fm.apHdg = Math.round(fm.heading); this.msg(`AP1 ON - HDG ${Math.round(fm.heading)} / ALT ${Math.round(fm.apAlt * 3.28)} ft`, "good"); }
        else { fm.ap = "OFF"; this.msg("AP1 OFF", "warn"); this.audio.say("autopilot"); }
        break;
      case "j":
        if (fm.onGround) break;
        fm.ap = "LOC"; fm.apAlt = Math.max(fm.apAlt, fm.pos.y - 3.45); fm.athr = true; fm.apSpd = (c.flapLever >= 3 ? 138 : c.flapLever >= 1 ? 170 : 220) * KT;
        this.msg("APPR armed - LOC/G-S capture, A/THR ON. Configure flaps FULL + gear down.", "good");
        break;
      case "u": fm.athr = !fm.athr; fm.apSpd = Math.round(fm.ias / KT) * KT; this.msg(fm.athr ? `A/THR ON - SPD ${Math.round(fm.ias / KT)} kt` : "A/THR OFF", fm.athr ? "good" : "warn"); break;
      case "c": { const i = CAM_MODES.findIndex((m) => m.id === this.cam); this.setCam(CAM_MODES[(i + 1) % CAM_MODES.length].id); break; }
      case "h": this.hudVisible = !this.hudVisible; break;
      case "m": this.audio.enabled = !this.audio.enabled; this.msg(this.audio.enabled ? "Sound ON" : "Sound OFF", "info"); break;
      case "n": this.setTimeOfDay((this.timeIdx + 1) % TIMES.length); this.msg("Time: " + TIMES[this.timeIdx].name, "info"); break;
      default:
        if (/^[1-7]$/.test(k)) this.setCam(CAM_MODES[parseInt(k) - 1].id);
    }
    void e;
  }

  private readControls(dt: number) {
    const K = this.keys, c = this.ctl;
    const has = (...a: string[]) => a.some((x) => K.has(x));
    let tp = (has("arrowdown", "s") ? 1 : 0) - (has("arrowup", "w") ? 1 : 0);
    let tr = (has("arrowright", "d") ? 1 : 0) - (has("arrowleft", "a") ? 1 : 0);
    let ty = (has("e") ? 1 : 0) - (has("q") ? 1 : 0);
    let thrDelta = (has("shift", "pageup", "=", "+") ? 1 : 0) - (has("control", "pagedown", "-") ? 1 : 0);
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      if (dz(p.axes[0]) || dz(p.axes[1])) { tr = dz(p.axes[0]); tp = dz(p.axes[1]); }
      if (p.axes.length > 2 && dz(p.axes[2])) ty = dz(p.axes[2]);
      if (p.buttons[7]?.value > 0.05) thrDelta = p.buttons[7].value;
      if (p.buttons[6]?.value > 0.05) thrDelta = -p.buttons[6].value;
      break;
    }
    const rate = Math.min(1, dt * 5);
    c.pitch += (tp - c.pitch) * rate;
    c.roll += (tr - c.roll) * rate;
    c.yaw += (ty - c.yaw) * Math.min(1, dt * 4);
    if (thrDelta !== 0) { c.throttle = clamp(c.throttle + thrDelta * dt * 0.35, 0, 1); if (this.fm.athr && Math.abs(thrDelta) > 0) { /* override */ } }
    c.brake = has(" ") ? 1 : 0;
    if (c.parkingBrake && c.throttle > 0.3 && this.fm.onGround && this.fm.gs < 1 && this.frame % 120 === 0) this.msg("Parking brake is SET - press P", "warn");
  }

  private visual(): VisualState {
    const fm = this.fm;
    return {
      gear: fm.gearPos, flapDeg: fm.flapDeg, slat: fm.slat,
      aileron: fm.surf.aileron, elevator: fm.surf.elevator, rudder: fm.surf.rudder,
      spoilers: fm.spoilers, groundSpoilers: fm.groundSpoilers, n1: fm.n1, reverser: fm.reverser,
      wheelSpeed: fm.onGround ? fm.gs : fm.gearPos > 0.5 ? Math.max(0, this.lastWheel * 0.985) : 0,
      noseSteer: fm.noseSteer, comp: fm.comp, throttle: this.ctl.throttle,
      stickX: this.ctl.roll, stickY: this.ctl.pitch, flapLever: this.ctl.flapLever,
      lights: { ...this.lights, landing: this.lights.landing && fm.gearPos > 0.5 || (this.lights.landing && fm.pos.y < 3000) },
      dayFactor: this.world.dayFactor,
    };
  }
  private lastWheel = 0;

  private telemetry(): Telemetry {
    const fm = this.fm;
    const dest = AIRPORTS[1];
    const nav = fm.navTo(dest);
    const fr = runwayFrame(dest, 0);
    const dx = fr.thr.x - fm.pos.x, dz = fr.thr.z - fm.pos.z;
    const brg = ((Math.atan2(dx, -dz) / D2R) + 360) % 360;
    const ilsValid = nav.along < 0 && nav.along > -35000 && Math.abs(nav.locDevDeg) < 10;
    return {
      ias: fm.ias / KT, gs: fm.gs / KT, alt: (fm.pos.y - 3.45) * 3.28084, vs: fm.vs * 196.85, hdg: fm.heading,
      pitch: fm.pitch / D2R, bank: fm.bank / D2R, alpha: fm.alpha / D2R, n1: fm.n1, throttle: this.ctl.throttle,
      flapIdx: this.ctl.flapLever, flapName: FLAP_NAMES[this.ctl.flapLever], flapDeg: fm.flapDeg, slat: fm.slat,
      gear: fm.gearPos, gearDown: this.ctl.gearDown, ap: fm.ap, athr: fm.athr, apAlt: fm.apAlt * 3.28084, apHdg: fm.apHdg, apSpd: fm.apSpd / KT,
      gsDev: nav.gsDevDeg, locDev: nav.locDevDeg, ilsValid, distNm: Math.hypot(dx, dz) / 1852, destBrg: brg, destName: dest.icao,
      mach: fm.mach, gload: fm.gload, spoilers: Math.max(fm.spoilers, fm.groundSpoilers), brake: Math.max(this.ctl.brake, this.ctl.parkingBrake ? 1 : 0),
      parking: this.ctl.parkingBrake, stall: fm.stall && !fm.onGround, tailstrike: fm.tailstrike, onGround: fm.onGround, agl: fm.agl,
      reverser: fm.reverser, trend: this.trend, time: this.startClock + this.simTime * 1000,
      route: [{ x: 1600, z: 0 }, { x: 11000, z: 0 }, { x: 22000, z: 3200 }, { x: fr.thr.x - 11000, z: fr.thr.z }, { x: fr.thr.x, z: fr.thr.z }],
      pos: { x: fm.pos.x, z: fm.pos.z },
    };
  }

  private updateCamera(dt: number) {
    const fm = this.fm, cam = this.camera;
    const acPos = fm.pos;
    const q = fm.quat;
    let fov = 55;
    // shake
    const rough = fm.onGround ? clamp(fm.gs / 60, 0, 1) * 0.6 : clamp((fm.ias - 60) / 200, 0, 1) * 0.15 + (fm.gearPos > 0.5 ? 0.05 : 0);
    const t = this.simTime;
    this.shake.set(Math.sin(t * 37.1) + Math.sin(t * 23.7) * 0.6, Math.sin(t * 41.3) * 0.8 + Math.sin(t * 17.9), Math.sin(t * 29.3)).multiplyScalar(rough * 0.012);
    this.camSmoothQ.slerp(q, Math.min(1, dt * 3));
    const up = new THREE.Vector3(0, 1, 0);
    if (this.cam === "cockpit" || this.cam === "cabin") {
      const eye = this.cam === "cockpit" ? this.rig.eye.clone() : new THREE.Vector3(-2.2, 1.55, 5.2);
      const gOff = new THREE.Vector3(0, -(fm.gload - 1) * 0.025, 0);
      eye.add(gOff).add(this.shake);
      cam.position.copy(eye.applyQuaternion(q).add(acPos));
      const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.headPitch, this.headYaw, 0, "YXZ"));
      cam.quaternion.copy(q).multiply(hq);
      fov = (this.cam === "cockpit" ? 62 : 58) * this.zoom;
      cam.near = 0.03;
    } else if (this.cam === "chase" || this.cam === "orbit" || this.cam === "gear") {
      let base: THREE.Quaternion;
      if (this.cam === "chase") {
        const hdg = Math.atan2(-new THREE.Vector3(0, 0, -1).applyQuaternion(this.camSmoothQ).x, -new THREE.Vector3(0, 0, -1).applyQuaternion(this.camSmoothQ).z);
        base = new THREE.Quaternion().setFromAxisAngle(up, hdg);
      } else if (this.cam === "gear") base = q.clone();
      else base = new THREE.Quaternion();
      const off = new THREE.Vector3(0, 0, this.orbitDist).applyEuler(new THREE.Euler(-this.orbitPitch, this.orbitYaw, 0, "YXZ")).applyQuaternion(base);
      const local = this.cam === "gear" ? (this.debugTarget ? new THREE.Vector3(...this.debugTarget) : new THREE.Vector3(0, -2.2, -4)) : new THREE.Vector3(0, 1.2, 0);
      const target = acPos.clone().add(local.applyQuaternion(this.cam === "gear" ? q : new THREE.Quaternion()));
      const want = target.clone().add(off);
      const gh = groundAt(want.x, want.z) + 1.2;
      if (want.y < gh) want.y = gh;
      cam.position.copy(want).add(this.shake.clone().multiplyScalar(4));
      cam.up.set(0, 1, 0);
      if (this.cam === "gear") cam.up.copy(up.clone().applyQuaternion(q));
      cam.lookAt(target);
      fov = 50;
      cam.near = 0.1;
    } else if (this.cam === "tower") {
      let best = AIRPORTS[0], bd = 1e12;
      for (const a of AIRPORTS) { const d = Math.hypot(a.x - acPos.x, a.z - acPos.z); if (d < bd) { bd = d; best = a; } }
      const big = best === AIRPORTS[0];
      const tpos = new THREE.Vector3(best.x + (big ? 620 : 430), (big ? 52 : 32) + 6, best.z - 431);
      cam.position.copy(tpos);
      cam.up.set(0, 1, 0);
      cam.lookAt(acPos);
      const dist = tpos.distanceTo(acPos);
      fov = clamp(2 * Math.atan(60 / dist) / D2R, 1.2, 60) * this.zoom;
      cam.near = 0.5;
    } else if (this.cam === "flyby") {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const rel = this.flybyPos.clone().sub(acPos);
      if (!this.flybyValid || rel.dot(fwd) < -250 || rel.length() > 2000) {
        const sp = Math.max(fm.gs, 20);
        this.flybyPos.copy(acPos).addScaledVector(fwd, sp * 5).add(new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(45 + Math.random() * 40));
        const g = groundAt(this.flybyPos.x, this.flybyPos.z) + 1.7;
        this.flybyPos.y = fm.onGround ? g : Math.max(g, acPos.y + (Math.random() - 0.4) * 30);
        this.flybyValid = true;
      }
      cam.position.copy(this.flybyPos).add(this.shake.clone().multiplyScalar(2)).add(new THREE.Vector3(Math.sin(t * 1.3) * 0.05, Math.sin(t * 1.7) * 0.04, 0));
      cam.up.set(0, 1, 0);
      cam.lookAt(acPos);
      const dist = this.flybyPos.distanceTo(acPos);
      fov = clamp(2 * Math.atan(28 / dist) / D2R, 8, 60) * this.zoom;
      cam.near = 0.2;
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = lerp(cam.fov, fov, Math.min(1, dt * 6)); }
    cam.updateProjectionMatrix();
    // hide interior shell when outside? keep - it's occluded.
    this.vignette.uniforms.amount.value = this.cam === "cockpit" || this.cam === "cabin" ? 0.7 : 1;
  }

  private spawnSmoke(p: THREE.Vector3, n: number, strength: number) {
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(this.smokeMat.clone());
      s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.3, (Math.random() - 0.5) * 1.2));
      s.scale.setScalar(1.5);
      this.world.scene.add(s);
      const v = this.fm.vel.clone().multiplyScalar(0.25 + Math.random() * 0.2).add(new THREE.Vector3((Math.random() - 0.5) * 3, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 3));
      this.smoke.push({ s, v, life: 2.5 * strength + Math.random() });
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.frame++;
    const fm = this.fm;
    if (!this.paused && !fm.crashed) {
      this.readControls(dt);
      this.simTime += dt;
      const prevGear = fm.gearPos;
      fm.step(dt, this.ctl);
      const ev = fm.events;
      if (ev.liftoff) { this.msg("Positive rate - gear up (G), flaps up (V) above 1000 ft", "good"); }
      if (ev.touchdown) {
        const td = ev.touchdown;
        const strength = clamp(Math.abs(td.fpm) / 300, 0.3, 3);
        this.audio.thump(strength);
        const q = fm.quat;
        for (const cp of [fm.contacts.left, fm.contacts.right]) this.spawnSmoke(cp.clone().applyQuaternion(q).add(fm.pos), 6, strength);
        const rating = Math.abs(td.fpm) < 120 ? "BUTTER" : Math.abs(td.fpm) < 240 ? "Smooth" : Math.abs(td.fpm) < 450 ? "Firm" : Math.abs(td.fpm) < 800 ? "Hard" : "Very hard";
        this.msg(`Touchdown ${Math.round(td.fpm)} fpm - ${rating}${td.airport ? `, ${Math.round(td.distFromThr)} m past threshold, ${Math.abs(td.offCenter).toFixed(1)} m off centerline` : ""}`, Math.abs(td.fpm) < 450 ? "good" : "warn");
        this.lastTouchdown = td;
      }
      if (fm.gearPos !== prevGear) this.gearMoving = 0.2; else this.gearMoving = Math.max(0, this.gearMoving - dt);
      // IAS trend (10s)
      const acc = (fm.ias / KT - this.lastTrendIas) / Math.max(dt, 1e-3);
      this.lastTrendIas = fm.ias / KT;
      this.trend = lerp(this.trend, acc * 10, 0.05);
      this.audio.callouts(fm.agl * 3.28, fm.vs, fm.onGround);
      if (fm.stall && !fm.onGround && this.frame % 90 === 0) this.audio.say("stall");
    }
    if (fm.crashed && !this.endShown) {
      this.endShown = true;
      this.paused = true;
      this.spawnSmoke(fm.pos.clone(), 30, 3);
      this.cb.onEnd({ kind: "crash", title: "CRASH", lines: [fm.crashReason, `Speed ${Math.round(fm.gs / KT)} kt · V/S ${Math.round(fm.vs * 196.85)} fpm`] });
    }
    if (!fm.crashed && !this.endShown && fm.landed && fm.onGround && fm.gs < 3 && this.lastTouchdown?.airport?.icao === AIRPORTS[1].icao) {
      this.endShown = true;
      const td = this.lastTouchdown!;
      const score = Math.max(0, Math.round(100 - Math.max(0, Math.abs(td.fpm) - 100) / 8 - Math.abs(td.offCenter) * 2 - Math.max(0, Math.abs(td.distFromThr - 400) - 150) / 20));
      this.cb.onEnd({ kind: "landed", title: "WELCOME TO BAYVIEW", lines: [`Touchdown rate: ${Math.round(td.fpm)} fpm`, `Touchdown point: ${Math.round(td.distFromThr)} m past threshold`, `Centerline deviation: ${Math.abs(td.offCenter).toFixed(1)} m`, `Flight time: ${Math.floor(this.simTime / 60)} min ${Math.round(this.simTime % 60)} s`, `Landing score: ${score} / 100`] });
    }
    this.lastWheel = fm.onGround ? fm.gs : this.lastWheel * 0.99;
    // visuals
    this.rig.root.position.copy(fm.pos);
    this.rig.root.quaternion.copy(fm.quat);
    this.rig.update(this.visual(), this.paused ? 0 : dt, this.simTime + this.frame * 0.0001);
    if (this.menuOrbit) this.orbitYaw += dt * 0.06;
    this.updateCamera(dt);
    this.world.update(this.simTime, dt, this.camera.position, fm.pos);
    // smoke
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const p = this.smoke[i];
      p.life -= dt;
      p.v.multiplyScalar(1 - dt * 1.2);
      p.s.position.addScaledVector(p.v, dt);
      p.s.scale.multiplyScalar(1 + dt * 1.6);
      (p.s.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(0.6, p.life * 0.3));
      if (p.life <= 0) { this.world.scene.remove(p.s); (p.s.material as THREE.Material).dispose(); this.smoke.splice(i, 1); }
    }
    // audio
    this.audio.update({ n1: fm.n1, ias: fm.ias / KT, gs: fm.gs, onGround: fm.onGround, gearMoving: this.gearMoving > 0, gearDown: fm.gearPos > 0.5, inside: this.cam === "cockpit", reverser: fm.reverser, spoilers: Math.max(fm.spoilers, fm.groundSpoilers) });
    // instruments
    if (this.frame % 3 === 0) {
      const tel = this.telemetry();
      const s = this.rig.screens;
      drawPFD(s.pfd.getContext("2d")!, s.pfd.width, tel);
      drawND(s.nd.getContext("2d")!, s.nd.width, tel);
      if (this.frame % 6 === 0) { drawEWD(s.ewd.getContext("2d")!, s.ewd.width, tel); drawSD(s.sd.getContext("2d")!, s.sd.width, tel); }
      s.refresh();
      this.cb.onTelemetry({ ...tel, cam: this.cam, paused: this.paused, lights: this.lights.landing });
    }
    this.vignette.uniforms.time.value = this.simTime;
    this.composer.render();
  };
  private gearMoving = 0;
  private lastTouchdown: { fpm: number; airport: { icao: string } | null; distFromThr: number; offCenter: number } | null = null;

  start(mode: "departure" | "approach") {
    this.menuOrbit = false;
    this.audio.start();
    if (mode === "departure") this.resetDeparture(); else this.resetApproach();
    this.paused = false;
    if (mode === "approach") this.lights.landing = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
