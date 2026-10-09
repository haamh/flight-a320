import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { buildAircraft, type AircraftRig, type VisualState } from "./aircraft";
import { buildWorld, bakeParked, TIMES, type World } from "./world";
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
/** frame statistics: smoothed fps / frame ms, CPU and (when the browser exposes timer queries) GPU ms, render scale (fraction of the pixel-ratio cap), whole-frame draw calls / triangles */
export interface PerfStats { fps: number; ms: number; cpuMs: number; gpuMs: number; scale: number; calls: number; tris: number }
export type SimTelemetry = Telemetry & { cam: CamMode; paused: boolean; lights: boolean; perf: PerfStats; hover: string };
export interface SimCallbacks {
  onTelemetry: (t: SimTelemetry) => void;
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

/** render-scale steps as a fraction of the pixel-ratio cap */
const SCALE_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

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
  timeIdx = 1;
  /** live frame statistics (also delivered through onTelemetry) */
  perf: PerfStats = { fps: 60, ms: 16.7, cpuMs: 0, gpuMs: 0, scale: 1, calls: 0, tris: 0 };
  /** dynamic resolution: off under browser automation (software GL is always "slow") */
  /** dynamic resolution: off by default (buffer reallocation on a scale change can flash a blank frame); toggle with O */
  dynRes = false;
  /** true when the reversed float depth buffer is active (otherwise logarithmic depth is the fallback) */
  readonly reversedDepth: boolean;
  private keys = new Set<string>();
  private timer = new THREE.Timer();
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
  private endShown = false;
  private disposed = false;
  private raf = 0;
  private cb: SimCallbacks;
  private startClock = Date.UTC(2026, 5, 21, 17, 42, 0);
  private lastTrendIas = 0; private trend = 0;
  hudVisible = true;
  perfVisible = false;
  menuOrbit = true;
  /** dev tooling: body-frame look-at point for the undercarriage camera */
  debugTarget: [number, number, number] | null = null;
  shake = new THREE.Vector3();
  // scratch objects (no allocations in the frame loop)
  private sUp = new THREE.Vector3(0, 1, 0);
  private s1 = new THREE.Vector3(); private s2 = new THREE.Vector3(); private s3 = new THREE.Vector3(); private s4 = new THREE.Vector3();
  private sq1 = new THREE.Quaternion(); private sEul = new THREE.Euler();
  private vsLights = { nav: true, beacon: true, strobe: true, landing: true, taxi: true };
  private vs!: VisualState;
  private tel!: Telemetry;
  private destFrame = runwayFrame(AIRPORTS[1], 0);
  private audioArgs = { n1: 0, ias: 0, gs: 0, onGround: true, gearMoving: false, gearDown: true, inside: false, reverser: 0, spoilers: 0 };
  private interior: THREE.Object3D[] = [];
  private interiorOn = true;
  private windowBacking: THREE.Object3D | null = null;
  // frame timing / dynamic resolution
  private cap: number;
  private scaleIdx = 0;
  private lastFrameT = 0;
  private frameMs = 16.7; private cpuMs = 0; private gpuMs = 0;
  private drLow = 0; private drHigh = 0; private drCool = 0; private drProbe = 20000; private drProbeT = 0; private drTrial = 0;
  private lastTelT = 0; private lastPanelT = 0; private redrawAll = true;
  private gl: WebGL2RenderingContext | null = null;
  private tq: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; pool: WebGLQuery[]; pending: WebGLQuery[] } | null = null;

  constructor(private container: HTMLElement, cb: SimCallbacks) {
    this.cb = cb;
    const make = (reversed: boolean) => new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", ...(reversed ? { reversedDepthBuffer: true } : { logarithmicDepthBuffer: true }) } as THREE.WebGLRendererParameters);
    let r = make(true);
    if (!r.capabilities.reversedDepthBuffer) { r.dispose(); r.forceContextLoss(); r = make(false); }
    this.reversedDepth = r.capabilities.reversedDepthBuffer;
    this.cap = Math.min(window.devicePixelRatio, 1.75);
    r.setPixelRatio(this.cap);
    r.setSize(container.clientWidth, container.clientHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.55;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    container.appendChild(r.domElement);
    r.domElement.style.display = "block";
    this.renderer = r;
    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.05, 320000);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    // scene target: 4x MSAA half float; with the reversed depth buffer it needs a 32 bit float depth attachment to keep the precision
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4, depthTexture: this.reversedDepth ? new THREE.DepthTexture(size.x, size.y, THREE.FloatType) : undefined });
    rt.resolveDepthBuffer = false;
    this.composer = new EffectComposer(r, rt);
    this.composer.renderTarget2.resolveDepthBuffer = false;
    // only the scene (read) buffer needs MSAA; the tone-map / vignette passes write into a plain target
    const plain = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false });
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget1 = plain; this.composer.writeBuffer = plain;
    this.composer.setSize(container.clientWidth, container.clientHeight);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.05, 0.35, 8);
    this.vignette = new ShaderPass(VignetteShader);
    this.timer.connect(document);
    try {
      const gl = r.getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (ext) { this.gl = gl; this.tq = { ext, pool: [], pending: [] }; }
    } catch { /* no timer queries */ }
    this.vs = this.makeVisual();
    this.tel = this.makeTelemetry();
  }

  /** Heavy build step (call after first paint) */
  build() {
    this.rig = buildAircraft();
    const rig = this.rig;
    const parked = bakeParked(rig.root);
    if (import.meta.env.DEV) console.info("[parked aircraft baked]", parked.stats);
    this.world = buildWorld(parked);
    this.world.scene.add(rig.root);
    this.interior = rig.root.children.slice(1);
    this.windowBacking = rig.root.getObjectByName("windowBacking") ?? null;
    this.fm.hardPoints = rig.hardPoints;
    // post
    this.composer.addPass(new RenderPass(this.world.scene, this.camera));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.vignette);
    this.setTimeOfDay(this.timeIdx);
    const puff = softPuffTexture(9);
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff, color: "#d8d8d8", transparent: true, depthWrite: false, opacity: 0.6 }));
      s.visible = false;
      this.world.scene.add(s);
      this.smoke.push({ s, v: new THREE.Vector3(), life: 0 });
    }
    this.bindInput();
    this.syncControls();
    this.resetDeparture();
    this.paused = true;
    this.running = true;
    this.world.update(0, 0, this.camera.position, this.fm.pos, this.fm.quat);
    if (!navigator.webdriver) this.world.warm(this.renderer, this.camera);
    this.timer.update();
    this.loop();
  }

  /** the flight deck is shielded from the sky: bind the (re-baked) environment to its materials at a low intensity */
  private dimInteriorReflections() {
    const env = this.world.scene.environment;
    for (const o of this.interior) o.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || !m.isMeshStandardMaterial) return;
      if (m.envMap !== env) { m.envMap = env; m.needsUpdate = true; }
      m.envMapIntensity = 0.4;
    });
  }

  setTimeOfDay(i: number) {
    this.timeIdx = i;
    this.world.setTime(TIMES[i], this.renderer);
    // bloom is for light sources: the daylit sky sits far above any fixed threshold and would veil the whole frame
    this.dimInteriorReflections();
    const nf = 1 - this.world.dayFactor;
    this.bloom.strength = 0.03 + 0.14 * nf; this.bloom.threshold = 8 - 6.5 * nf;
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
    this.lastPanelT = 0; this.redrawAll = true;
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
    const onBlur = () => this.keys.clear();
    let downAt = [0, 0], downT = 0, downBtn = 0;
    const onDown = (e: MouseEvent) => { this.dragging = true; this.lastMouse = [e.clientX, e.clientY]; downAt = [e.clientX, e.clientY]; downT = performance.now(); downBtn = e.button; };
    const onUp = (e: MouseEvent) => {
      const wasDrag = !this.dragging || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5 || performance.now() - downT > 450;
      this.dragging = false;
      if (!wasDrag && e.target === el && this.cam === "cockpit") { const h = this.pick(e.clientX, e.clientY); if (h) this.cockpitAction(h.userData.hot.id, downBtn === 2 ? -1 : 1, "click"); }
    };
    const onCtx = (e: MouseEvent) => { if (this.cam === "cockpit") e.preventDefault(); };
    el.addEventListener("contextmenu", onCtx);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", onBlur);
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    const onMove = (e: MouseEvent) => {
      this.mouseXY[0] = e.clientX; this.mouseXY[1] = e.clientY; this.hoverDirty = true;
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse[0], dy = e.clientY - this.lastMouse[1];
      this.lastMouse = [e.clientX, e.clientY];
      if (this.cam === "cockpit" || this.cam === "cabin") {
        this.headYaw -= dx * 0.004; this.headPitch = clamp(this.headPitch - dy * 0.004, -1.2, 1.5);
      } else { this.orbitYaw -= dx * 0.006; this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, -1.3, 1.4); }
    };
    window.addEventListener("mousemove", onMove);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.cam === "cockpit") { const h = this.pick(e.clientX, e.clientY); if (h && (h.userData.hot.kind === "knob" || h.userData.hot.kind === "lever")) { this.cockpitAction(h.userData.hot.id, e.deltaY < 0 ? 1 : -1, "wheel"); return; } }
      if (this.cam === "cockpit" || this.cam === "cabin" || this.cam === "tower" || this.cam === "flyby") this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.08 : 0.92), 0.25, 1.6);
      else this.orbitDist = clamp(this.orbitDist * (e.deltaY > 0 ? 1.1 : 0.9), 8, 900);
    }, { passive: false });
    const onResize = () => this.applySize();
    window.addEventListener("resize", onResize);
    this.cleanup = () => {
      window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur); window.removeEventListener("mouseup", onUp); window.removeEventListener("mousemove", onMove);
      el.removeEventListener("mousedown", onDown);
    };
  }
  private zoom = 1;
  private cleanup: () => void = () => {};

  /* ---------------- clickable flight deck ---------------- */
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private mouseXY = [0, 0];
  private hoverDirty = false;
  private hovered: THREE.Object3D | null = null;
  /** label of the control under the mouse (HUD tooltip) */
  hoverLabel = "";
  /** switch / pushbutton states that have no flight-model counterpart */
  panel: Record<string, boolean> = { eng_master1: true, eng_master2: true, ovh_bat_1: false, ovh_bat_2: false, lt_wing: false, lt_rwy: true, ovh_sign_seat_belts: true, ovh_sign_no_smoking: true, probe_heat: true };
  private pick(cx: number, cy: number): THREE.Object3D | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.raycaster.far = 3;
    const hits = this.raycaster.intersectObjects(this.rig.controls.pickables, false);
    return hits.length ? hits[0].object : null;
  }
  private updateHover() {
    if (!this.hoverDirty && this.frame % 10) return;
    this.hoverDirty = false;
    const h = this.cam === "cockpit" && !this.dragging ? this.pick(this.mouseXY[0], this.mouseXY[1]) : null;
    if (h !== this.hovered) {
      this.hovered = h;
      this.rig.controls.hover(h);
      this.hoverLabel = h ? h.userData.hot.label : "";
      this.renderer.domElement.style.cursor = h ? "pointer" : "";
    }
  }
  /** keep switch positions / lit legends in step with the systems they drive */
  private syncControls() {
    const set = this.rig.controls.set, L = this.lights, c = this.ctl;
    set("lt_strobe", L.strobe); set("lt_beacon", L.beacon); set("lt_nav", L.nav);
    set("lt_landL", L.landing); set("lt_landR", L.landing); set("lt_nose", L.taxi);
    for (const [k, v] of Object.entries(this.panel)) set(k, v);
    void c;
  }
  private cockpitAction(id: string, dir: number, how: "click" | "wheel") {
    const fm = this.fm, c = this.ctl, L = this.lights, P = this.panel;
    const tog = (k: string, label: string) => { P[k] = !P[k]; this.msg(`${label} ${P[k] ? "ON" : "OFF"}`, "info"); };
    this.audio.click();
    switch (id) {
      case "fcu_ap1": case "fcu_ap2": this.onKeyPress("k", null); break;
      case "fcu_athr": this.onKeyPress("u", null); break;
      case "fcu_loc": case "fcu_appr": this.onKeyPress("j", null); break;
      case "fcu_exped": this.msg("EXPED not available in this simulation", "warn"); break;
      case "fcu_spd":
        if (how === "wheel") { fm.apSpd = clamp(Math.round(fm.apSpd / KT + dir) * KT, 100 * KT, 350 * KT); if (!fm.athr) this.msg(`SPD ${Math.round(fm.apSpd / KT)} (A/THR off)`, "info"); }
        else { fm.athr = true; this.msg(`A/THR ON - SPD ${Math.round(fm.apSpd / KT)} kt`, "good"); }
        break;
      case "fcu_hdg":
        if (how === "wheel") fm.apHdg = ((Math.round(fm.apHdg) + dir) % 360 + 360) % 360;
        else if (!fm.onGround) { fm.ap = "HDG/ALT"; this.msg(`HDG ${Math.round(fm.apHdg)} selected`, "good"); }
        break;
      case "fcu_alt":
        if (how === "wheel") fm.apAlt = Math.max(100 / 3.28084, fm.apAlt + dir * 100 / 3.28084);
        else if (!fm.onGround) { fm.ap = "HDG/ALT"; this.msg(`ALT ${Math.round(fm.apAlt * 3.28084 / 100) * 100} ft`, "good"); }
        break;
      case "fcu_vs": this.msg("V/S mode not modelled - altitude is flown in OP/ALT", "info"); break;
      case "mw": case "mc": this.msg("Master light reset", "info"); break;
      case "gear": this.onKeyPress("g", null); break;
      case "flaps": this.onKeyPress(dir > 0 ? "f" : "v", null); break;
      case "spdbrk": this.onKeyPress("b", null); break;
      case "park": this.onKeyPress("p", null); break;
      case "thrust": {
        if (how === "wheel") { c.throttle = clamp(c.throttle + dir * 0.04, 0, 1); fm.athr = false; }
        else { const det = [0, 0.8, 0.9, 1], i = det.findIndex((d) => d > c.throttle + 0.01); const cur = i < 0 ? 3 : Math.max(0, i - 1); const n = clamp(cur + dir, 0, 3); c.throttle = det[n]; fm.athr = false; this.msg(["IDLE", "CL", "FLX/MCT", "TOGA"][n], "info"); }
        break;
      }
      case "lt_strobe": L.strobe = !L.strobe; this.msg(`Strobe ${L.strobe ? "ON" : "OFF"}`, "info"); break;
      case "lt_beacon": L.beacon = !L.beacon; this.msg(`Beacon ${L.beacon ? "ON" : "OFF"}`, "info"); break;
      case "lt_nav": L.nav = !L.nav; this.msg(`Nav & logo lights ${L.nav ? "ON" : "OFF"}`, "info"); break;
      case "lt_landL": case "lt_landR": L.landing = !L.landing; this.msg(`Landing lights ${L.landing ? "ON" : "OFF"}`, "info"); break;
      case "lt_nose": L.taxi = !L.taxi; this.msg(`Nose light ${L.taxi ? "TAXI" : "OFF"}`, "info"); break;
      case "eng_master1": case "eng_master2": tog(id, `ENG MASTER ${id.slice(-1)}`); if (!P.eng_master1 && !P.eng_master2 && !fm.onGround) this.msg("Both engines shut down!", "bad"); break;
      default: tog(id, this.rig.controls.pickables.find((o) => o.userData.hot.id === id)?.userData.hot.label ?? id);
    }
    this.syncControls();
  }

  private onKeyPress(k: string, e: KeyboardEvent | null) {
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
      case "i": this.perfVisible = !this.perfVisible; break;
      case "o": this.dynRes = !this.dynRes; if (!this.dynRes && this.scaleIdx) this.setScale(0); this.msg(this.dynRes ? "Dynamic resolution ON" : "Dynamic resolution OFF (full resolution)", "info"); break;
      case "m": this.audio.enabled = !this.audio.enabled; this.msg(this.audio.enabled ? "Sound ON" : "Sound OFF", "info"); break;
      case "n": this.setTimeOfDay((this.timeIdx + 1) % TIMES.length); this.msg("Time: " + TIMES[this.timeIdx].name, "info"); break;
      default:
        if (/^[1-7]$/.test(k)) this.setCam(CAM_MODES[parseInt(k) - 1].id);
    }
    void e;
    if (this.rig) this.syncControls();
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


  private makeVisual(): VisualState {
    const fm = this.fm;
    return {
      gear: 0, flapDeg: 0, slat: 0, aileron: 0, elevator: 0, rudder: 0, spoilers: 0, groundSpoilers: 0, n1: 0, reverser: 0,
      wheelSpeed: 0, noseSteer: 0, comp: fm.comp, throttle: 0, stickX: 0, stickY: 0, flapLever: 0,
      lights: this.vsLights, dayFactor: 1, parkingBrake: false, gearLever: true, pedal: 0, speedbrakeLever: 0, reverseSelected: false, onGround: true,
    };
  }
  private visual(): VisualState {
    const fm = this.fm, v = this.vs, c = this.ctl, L = this.lights;
    v.gear = fm.gearPos; v.flapDeg = fm.flapDeg; v.slat = fm.slat;
    v.aileron = fm.surf.aileron; v.elevator = fm.surf.elevator; v.rudder = fm.surf.rudder;
    v.spoilers = fm.spoilers; v.groundSpoilers = fm.groundSpoilers; v.n1 = fm.n1; v.reverser = fm.reverser;
    v.wheelSpeed = fm.onGround ? fm.gs : fm.gearPos > 0.5 ? Math.max(0, this.lastWheel * 0.985) : 0;
    v.noseSteer = fm.noseSteer; v.comp = fm.comp; v.throttle = c.throttle;
    v.stickX = c.roll; v.stickY = c.pitch; v.flapLever = c.flapLever;
    const vl = this.vsLights;
    vl.nav = L.nav; vl.beacon = L.beacon; vl.strobe = L.strobe; vl.taxi = L.taxi;
    vl.landing = L.landing && fm.gearPos > 0.5 || (L.landing && fm.pos.y < 3000);
    v.dayFactor = this.world.dayFactor;
    v.parkingBrake = c.parkingBrake; v.gearLever = c.gearDown; v.pedal = c.yaw;
    v.speedbrakeLever = c.speedbrake; v.reverseSelected = c.reverse; v.onGround = fm.onGround;
    return v;
  }
  private lastWheel = 0;

  private makeTelemetry(): Telemetry {
    const fm = this.fm, fr = this.destFrame;
    return {
      ias: 0, gs: 0, alt: 0, vs: 0, hdg: 0, pitch: 0, bank: 0, alpha: 0, n1: 0, throttle: 0,
      flapIdx: 0, flapName: "", flapDeg: 0, slat: 0, gear: 0, gearDown: true, ap: "OFF", athr: false, apAlt: 0, apHdg: 0, apSpd: 0,
      gsDev: 0, locDev: 0, ilsValid: false, distNm: 0, destBrg: 0, destName: AIRPORTS[1].icao,
      mach: 0, gload: 1, spoilers: 0, brake: 0, parking: true, stall: false, tailstrike: false, onGround: true, agl: 0, reverser: 0, trend: 0, time: 0,
      route: [{ x: 1600, z: 0 }, { x: 11000, z: 0 }, { x: 22000, z: 3200 }, { x: fr.thr.x - 11000, z: fr.thr.z }, { x: fr.thr.x, z: fr.thr.z }],
      pos: { x: fm.pos.x, z: fm.pos.z },
    };
  }
  /** fills the shared telemetry record in place (route and pos objects are reused) */
  private telemetry(): Telemetry {
    const fm = this.fm, t = this.tel, c = this.ctl;
    const dest = AIRPORTS[1];
    const nav = fm.navTo(dest);
    const fr = this.destFrame;
    const dx = fr.thr.x - fm.pos.x, dz = fr.thr.z - fm.pos.z;
    t.ias = fm.ias / KT; t.gs = fm.gs / KT; t.alt = (fm.pos.y - 3.45) * 3.28084; t.vs = fm.vs * 196.85; t.hdg = fm.heading;
    t.pitch = fm.pitch / D2R; t.bank = fm.bank / D2R; t.alpha = fm.alpha / D2R; t.n1 = fm.n1; t.throttle = c.throttle;
    t.flapIdx = c.flapLever; t.flapName = FLAP_NAMES[c.flapLever]; t.flapDeg = fm.flapDeg; t.slat = fm.slat;
    t.gear = fm.gearPos; t.gearDown = c.gearDown; t.ap = fm.ap; t.athr = fm.athr; t.apAlt = fm.apAlt * 3.28084; t.apHdg = fm.apHdg; t.apSpd = fm.apSpd / KT;
    t.gsDev = nav.gsDevDeg; t.locDev = nav.locDevDeg;
    t.ilsValid = nav.along < 0 && nav.along > -35000 && Math.abs(nav.locDevDeg) < 10;
    t.distNm = Math.hypot(dx, dz) / 1852; t.destBrg = ((Math.atan2(dx, -dz) / D2R) + 360) % 360; t.destName = dest.icao;
    t.mach = fm.mach; t.gload = fm.gload; t.spoilers = Math.max(fm.spoilers, fm.groundSpoilers); t.brake = Math.max(c.brake, c.parkingBrake ? 1 : 0);
    t.parking = c.parkingBrake; t.stall = fm.stall && !fm.onGround; t.tailstrike = fm.tailstrike; t.onGround = fm.onGround; t.agl = fm.agl;
    t.reverser = fm.reverser; t.trend = this.trend; t.time = this.startClock + this.simTime * 1000;
    t.pos.x = fm.pos.x; t.pos.z = fm.pos.z;
    return t;
  }

  private updateCamera(dt: number) {
    const fm = this.fm, cam = this.camera;
    const acPos = fm.pos;
    const q = fm.quat;
    const up = this.sUp, s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4, sq = this.sq1, eu = this.sEul;
    let fov = 55;
    // shake
    const rough = fm.onGround ? clamp(fm.gs / 60, 0, 1) * 0.6 : clamp((fm.ias - 60) / 200, 0, 1) * 0.15 + (fm.gearPos > 0.5 ? 0.05 : 0);
    const t = this.simTime;
    this.shake.set(Math.sin(t * 37.1) + Math.sin(t * 23.7) * 0.6, Math.sin(t * 41.3) * 0.8 + Math.sin(t * 17.9), Math.sin(t * 29.3)).multiplyScalar(rough * 0.012);
    this.camSmoothQ.slerp(q, Math.min(1, dt * 3));
    if (this.cam === "cockpit" || this.cam === "cabin") {
      const eye = s1;
      if (this.cam === "cockpit") eye.copy(this.rig.eye); else eye.set(-2.2, 1.55, 5.2);
      eye.y -= (fm.gload - 1) * 0.025;
      eye.add(this.shake);
      cam.position.copy(eye.applyQuaternion(q).add(acPos));
      sq.setFromEuler(eu.set(this.headPitch, this.headYaw, 0, "YXZ"));
      cam.quaternion.copy(q).multiply(sq);
      fov = (this.cam === "cockpit" ? 62 : 58) * this.zoom;
      cam.near = 0.03;
    } else if (this.cam === "chase" || this.cam === "orbit" || this.cam === "gear") {
      if (this.cam === "chase") {
        const f = s1.set(0, 0, -1).applyQuaternion(this.camSmoothQ);
        sq.setFromAxisAngle(up, Math.atan2(-f.x, -f.z));
      } else if (this.cam === "gear") sq.copy(q);
      else sq.identity();
      const off = s2.set(0, 0, this.orbitDist).applyEuler(eu.set(-this.orbitPitch, this.orbitYaw, 0, "YXZ")).applyQuaternion(sq);
      const local = s3;
      if (this.cam === "gear") { if (this.debugTarget) local.set(this.debugTarget[0], this.debugTarget[1], this.debugTarget[2]); else local.set(0, -2.2, -4); local.applyQuaternion(q); }
      else local.set(0, 1.2, 0);
      const target = s4.copy(acPos).add(local);
      const want = s1.copy(target).add(off);
      const gh = groundAt(want.x, want.z) + 1.2;
      if (want.y < gh) want.y = gh;
      cam.position.copy(want).addScaledVector(this.shake, 4);
      cam.up.set(0, 1, 0);
      if (this.cam === "gear") cam.up.applyQuaternion(q);
      cam.lookAt(target);
      fov = 50;
      cam.near = 0.1;
    } else if (this.cam === "tower") {
      let best = AIRPORTS[0], bd = 1e12;
      for (const a of AIRPORTS) { const d = Math.hypot(a.x - acPos.x, a.z - acPos.z); if (d < bd) { bd = d; best = a; } }
      const big = best === AIRPORTS[0];
      const tpos = s1.set(best.x + (big ? 620 : 430), (big ? 52 : 32) + 6, best.z - 431);
      cam.position.copy(tpos);
      cam.up.set(0, 1, 0);
      cam.lookAt(acPos);
      const dist = tpos.distanceTo(acPos);
      fov = clamp(2 * Math.atan(60 / dist) / D2R, 1.2, 60) * this.zoom;
      cam.near = 0.5;
    } else if (this.cam === "flyby") {
      const fwd = s1.set(0, 0, -1).applyQuaternion(q);
      const rel = s2.copy(this.flybyPos).sub(acPos);
      if (!this.flybyValid || rel.dot(fwd) < -250 || rel.length() > 2000) {
        const sp = Math.max(fm.gs, 20);
        this.flybyPos.copy(acPos).addScaledVector(fwd, sp * 5).add(s3.set(fwd.z, 0, -fwd.x).multiplyScalar(45 + Math.random() * 40));
        const g = groundAt(this.flybyPos.x, this.flybyPos.z) + 1.7;
        this.flybyPos.y = fm.onGround ? g : Math.max(g, acPos.y + (Math.random() - 0.4) * 30);
        this.flybyValid = true;
      }
      cam.position.copy(this.flybyPos).addScaledVector(this.shake, 2).add(s3.set(Math.sin(t * 1.3) * 0.05, Math.sin(t * 1.7) * 0.04, 0));
      cam.up.set(0, 1, 0);
      cam.lookAt(acPos);
      const dist = this.flybyPos.distanceTo(acPos);
      fov = clamp(2 * Math.atan(28 / dist) / D2R, 8, 60) * this.zoom;
      cam.near = 0.2;
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = lerp(cam.fov, fov, Math.min(1, dt * 6)); }
    cam.updateProjectionMatrix();
    this.vignette.uniforms.amount.value = this.cam === "cockpit" || this.cam === "cabin" ? 0.7 : 1;
  }

  private spawnSmoke(p: THREE.Vector3, n: number, strength: number) {
    for (let i = 0; i < n; i++) {
      const e = this.smoke.find((x) => x.life <= 0);
      if (!e) return;
      const s = e.s;
      s.position.copy(p); s.position.x += (Math.random() - 0.5) * 1.2; s.position.y += 0.3; s.position.z += (Math.random() - 0.5) * 1.2;
      s.scale.setScalar(1.5);
      s.visible = true;
      e.v.copy(this.fm.vel).multiplyScalar(0.25 + Math.random() * 0.2);
      e.v.x += (Math.random() - 0.5) * 3; e.v.y += 1 + Math.random() * 1.5; e.v.z += (Math.random() - 0.5) * 3;
      e.life = 2.5 * strength + Math.random();
    }
  }

  /** frame interval EMA + dynamic resolution (steps down past ~17.5 ms, back up with hysteresis and back-off) */
  private pace(now: number) {
    const dtMs = now - this.lastFrameT; this.lastFrameT = now;
    if (dtMs <= 0 || dtMs > 250) return;
    if (this.drCool > 0) { this.drCool -= dtMs; return; }
    this.frameMs += (dtMs - this.frameMs) * 0.04;
    const P = this.perf;
    P.ms = this.frameMs; P.fps = 1000 / this.frameMs; P.cpuMs = this.cpuMs; P.gpuMs = this.gpuMs;
    if (!this.dynRes) return;
    const gpu = this.gpuMs, cur = SCALE_STEPS[this.scaleIdx];
    // a step down only helps when the GPU is (or may be) the limit
    if (this.frameMs > 17.5 && (gpu <= 0 || gpu > 11)) this.drLow += dtMs; else this.drLow = Math.max(0, this.drLow - dtMs * 2);
    if (this.drLow > 700 && this.scaleIdx < SCALE_STEPS.length - 1) {
      this.drLow = 0; this.drHigh = 0; this.drProbeT = 0;
      // a failed step up: stay down longer next time
      if (this.drTrial > 0) { this.drProbe = Math.min(this.drProbe * 2, 240000); this.drTrial = 0; }
      this.setScale(this.scaleIdx + 1);
      return;
    }
    if (this.scaleIdx > 0) {
      const nxt = SCALE_STEPS[this.scaleIdx - 1], k = (nxt / cur) * (nxt / cur);
      // headroom: GPU timer prediction, or a frame interval well below 60 fps pacing (high refresh displays)
      const headroom = gpu > 0 ? gpu * k < 13 && this.frameMs < 17.3 : this.frameMs < 12.5 / k;
      if (headroom) this.drHigh += dtMs; else this.drHigh = 0;
      this.drProbeT += dtMs;
      if (this.drTrial > 0) { this.drTrial -= dtMs; if (this.drTrial <= 0) { this.drTrial = 0; this.drProbe = 20000; } }
      if (this.drHigh > 2000 || (gpu <= 0 && this.drProbeT > this.drProbe && this.frameMs < 17.2)) {
        if (this.drHigh <= 2000) this.drTrial = 6000;
        this.drHigh = 0; this.drProbeT = 0;
        this.setScale(this.scaleIdx - 1);
      }
    }
  }
  private setScale(i: number) {
    this.scaleIdx = i;
    this.drCool = 1500;
    this.applySize();
  }
  private applySize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const pr = this.cap * SCALE_STEPS[this.scaleIdx];
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.perf.scale = SCALE_STEPS[this.scaleIdx];
  }

  /** GPU time of the scene + post chain via timer queries (async: results arrive a few frames later) */
  private gpuBegin(): WebGLQuery | null {
    const tq = this.tq, gl = this.gl;
    if (!tq || !gl) return null;
    const q = tq.pool.pop() ?? gl.createQuery();
    gl.beginQuery(tq.ext.TIME_ELAPSED_EXT, q);
    return q;
  }
  private gpuEnd(q: WebGLQuery | null) {
    const tq = this.tq, gl = this.gl;
    if (!tq || !gl || !q) return;
    gl.endQuery(tq.ext.TIME_ELAPSED_EXT);
    tq.pending.push(q);
    if (tq.pending.length > 6) { const o = tq.pending.shift()!; tq.pool.push(o); }
    const disjoint = gl.getParameter(tq.ext.GPU_DISJOINT_EXT);
    while (tq.pending.length > 1 && gl.getQueryParameter(tq.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const o = tq.pending.shift()!;
      if (!disjoint) {
        const ms = (gl.getQueryParameter(o, gl.QUERY_RESULT) as number) / 1e6;
        if (ms > 0 && ms < 500) this.gpuMs = this.gpuMs > 0 ? this.gpuMs + (ms - this.gpuMs) * 0.1 : ms;
      }
      tq.pool.push(o);
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    this.pace(t0);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
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
        for (const cp of [fm.contacts.left, fm.contacts.right]) this.spawnSmoke(this.s1.copy(cp).applyQuaternion(q).add(fm.pos), 6, strength);
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
      this.spawnSmoke(fm.pos, 30, 3);
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
    this.updateHover();
    // interior is only ever seen through the windows from nearby: hide it from distant exterior cameras
    const inside = this.cam === "cockpit" || this.cam === "cabin";
    const showInterior = inside || this.camera.position.distanceToSquared(fm.pos) < 45 * 45;
    if (showInterior !== this.interiorOn) { this.interiorOn = showInterior; for (const o of this.interior) o.visible = showInterior; if (this.windowBacking) this.windowBacking.visible = !showInterior; }
    this.world.setShadowMode(this.cam === "cockpit" ? "deck" : this.cam === "cabin" ? "cabin" : "exterior");
    this.world.update(this.simTime, dt, this.camera.position, fm.pos, fm.quat);
    // smoke
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      p.v.multiplyScalar(1 - dt * 1.2);
      p.s.position.addScaledVector(p.v, dt);
      p.s.scale.multiplyScalar(1 + dt * 1.6);
      p.s.material.opacity = Math.max(0, Math.min(0.6, p.life * 0.3));
      if (p.life <= 0) p.s.visible = false;
    }
    // audio
    const au = this.audioArgs;
    au.n1 = fm.n1; au.ias = fm.ias / KT; au.gs = fm.gs; au.onGround = fm.onGround; au.gearMoving = this.gearMoving > 0; au.gearDown = fm.gearPos > 0.5;
    au.inside = this.cam === "cockpit"; au.reverser = fm.reverser; au.spoilers = Math.max(fm.spoilers, fm.groundSpoilers);
    this.audio.update(au);
    // instruments: canvases are only redrawn where they can be seen (flight deck in the cockpit camera, HUD mini displays otherwise)
    const f = this.frame, cockpit = this.cam === "cockpit", mini = this.hudVisible && !cockpit;
    const all = this.redrawAll && (cockpit || mini); if (all) this.redrawAll = false;
    const dPFD = all || (cockpit ? f % 2 === 0 : mini && f % 3 === 0);
    const dND = all || (cockpit ? f % 4 === 1 : mini && f % 6 === 2);
    const dEWD = cockpit && (all || f % 8 === 3), dSD = cockpit && (all || f % 8 === 7);
    const panelDue = cockpit && t0 - this.lastPanelT > 500;
    const cbDue = t0 - this.lastTelT > 95;
    if (dPFD || dND || dEWD || dSD || panelDue || cbDue) {
      const tel = this.telemetry();
      const s = this.rig.screens;
      if (dPFD) { drawPFD(s.pfd.getContext("2d")!, s.pfd.width, tel); s.refresh(["pfd"]); }
      if (dND) { drawND(s.nd.getContext("2d")!, s.nd.width, tel); s.refresh(["nd"]); }
      if (dEWD) { drawEWD(s.ewd.getContext("2d")!, s.ewd.width, tel); s.refresh(["ewd"]); }
      if (dSD) { drawSD(s.sd.getContext("2d")!, s.sd.width, tel); s.refresh(["sd"]); }
      if (panelDue) { this.lastPanelT = t0; s.panel(tel); }
      if (cbDue) { this.lastTelT = t0; this.cb.onTelemetry({ ...tel, cam: this.cam, paused: this.paused, lights: this.lights.landing, perf: { ...this.perf }, hover: this.hoverLabel }); }
    }
    this.vignette.uniforms.time.value = this.simTime;
    // whole-frame renderer statistics (the composer issues several render calls per frame)
    const info = this.renderer.info;
    info.autoReset = false; info.reset();
    const q = this.gpuBegin();
    this.composer.render();
    this.gpuEnd(q);
    const P = this.perf;
    P.calls = info.render.calls; P.tris = info.render.triangles;
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
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
    this.timer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
