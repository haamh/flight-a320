import * as THREE from "three";
import { groundAt, heightAt, WATER_LEVEL, AIRPORTS, type Airport } from "./terrain";
import { clamp, lerp } from "./noise";
import { GEAR_HEIGHT } from "./aircraft";

const D2R = Math.PI / 180;
const G = 9.81;
const S = 122.6, B = 34.1, C = 4.19;
const MAX_THRUST = 118000;
export const FLAP_DEG = [0, 10, 15, 20, 35];
const FLAP_SLAT = [0, 0.7, 0.8, 0.8, 1];
const FLAP_DCL = [0, 0.3, 0.5, 0.7, 0.92];
const FLAP_DCD = [0, 0.006, 0.012, 0.02, 0.055];
export const FLAP_NAMES = ["0", "1+F", "2", "3", "FULL"];
const GEAR_EXT = 0.28; // oleo stroke

export interface Controls {
  pitch: number; roll: number; yaw: number; // -1..1 (+ nose up, + roll right, + yaw right)
  throttle: number; // 0..1
  brake: number; // 0..1
  parkingBrake: boolean;
  flapLever: number; // 0..4
  gearDown: boolean;
  speedbrake: number; // 0..1
  reverse: boolean;
}

export type APMode = "OFF" | "HDG/ALT" | "LOC" | "APPR" | "FLARE" | "ROLLOUT";

export interface FlightEvents {
  touchdown?: { fpm: number; airport: Airport | null; distFromThr: number; offCenter: number; g: number };
  crash?: string;
  tailstrike?: boolean;
  liftoff?: boolean;
}

export function runwayFrame(a: Airport, end: 0 | 1 = 0) {
  const hd = (a.heading + (end ? 180 : 0)) * D2R;
  const fwd = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd));
  const right = new THREE.Vector3(Math.cos(hd), 0, Math.sin(hd));
  const center = new THREE.Vector3(a.x, a.elev, a.z);
  const thr = center.clone().addScaledVector(fwd, -a.length / 2);
  return { fwd, right, center, thr, heading: (a.heading + (end ? 180 : 0)) % 360 };
}

export class FlightModel {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  omega = new THREE.Vector3(); // body rates (x pitch up, y yaw left, z roll left)
  mass = 64000;
  I = new THREE.Vector3(4.4e6, 6.6e6, 2.6e6);
  n1 = 0.21;
  gearPos = 1;
  flapDeg = 0; slat = 0;
  spoilers = 0; groundSpoilers = 0;
  reverser = 0;
  holdPitch = 0; holdBank = 0;
  onGround = true;
  airTime = 0;
  groundTime = 0;
  crashed = false;
  crashReason = "";
  comp: [number, number, number] = [0, 0, 0];
  noseSteer = 0;
  // derived telemetry
  alpha = 0; beta = 0; ias = 0; gs = 0; vs = 0; heading = 0; pitch = 0; bank = 0; agl = 0; gload = 1; mach = 0;
  surf = { aileron: 0, elevator: 0, rudder: 0 };
  stall = false;
  tailstrike = false;
  ap: APMode = "OFF";
  athr = false;
  apAlt = 900; apHdg = 90; apSpd = 250 * 0.5144;
  spoilersArmed = true;
  autobrake = true;
  private prevOnGround = true;
  accAlong = 0;
  landed = false;
  private accel = new THREE.Vector3();
  events: FlightEvents = {};

  // contacts in body coordinates
  contacts = {
    nose: new THREE.Vector3(0, -GEAR_HEIGHT - GEAR_EXT, -13.4),
    left: new THREE.Vector3(-3.55, -GEAR_HEIGHT - GEAR_EXT, 0.9),
    right: new THREE.Vector3(3.55, -GEAR_HEIGHT - GEAR_EXT, 0.9),
  };
  hardPoints: { name: string; p: THREE.Vector3 }[] = [];

  resetOnRunway(a: Airport, distFromThr = 40) {
    const f = runwayFrame(a, 0);
    const p = f.thr.clone().addScaledVector(f.fwd, distFromThr);
    this.pos.set(p.x, a.elev + GEAR_HEIGHT + 0.0, p.z);
    this.vel.set(0, 0, 0);
    this.setAttitude(f.heading, 0, 0);
    this.omega.set(0, 0, 0);
    this.n1 = 0.21; this.gearPos = 1; this.flapDeg = 10; this.slat = 0.7;
    this.onGround = true; this.prevOnGround = true; this.crashed = false; this.crashReason = "";
    this.airTime = 0; this.groundTime = 0; this.holdPitch = 0; this.holdBank = 0;
    this.spoilers = 0; this.groundSpoilers = 0; this.reverser = 0; this.ap = "OFF"; this.athr = false;
    this.apAlt = 900; this.apHdg = f.heading; this.tailstrike = false; this.landed = false;
  }

  resetOnApproach(a: Airport, distNm: number) {
    const f = runwayFrame(a, 0);
    const d = distNm * 1852;
    const p = f.thr.clone().addScaledVector(f.fwd, -d);
    const alt = a.elev + 15 + d * Math.tan(3 * D2R);
    this.pos.set(p.x, alt, p.z);
    const v = 142 * 0.5144;
    const gam = -3 * D2R;
    this.vel.copy(f.fwd).multiplyScalar(v * Math.cos(gam)).setY(v * Math.sin(gam));
    this.setAttitude(f.heading, 2.2, 0);
    this.omega.set(0, 0, 0);
    this.n1 = 0.52; this.gearPos = 1; this.flapDeg = 35; this.slat = 1;
    this.onGround = false; this.prevOnGround = false; this.crashed = false; this.crashReason = "";
    this.airTime = 60; this.groundTime = 0; this.holdPitch = 2.2 * D2R; this.holdBank = 0;
    this.spoilers = 0; this.groundSpoilers = 0; this.reverser = 0; this.ap = "OFF"; this.athr = false;
    this.apAlt = alt; this.apHdg = f.heading; this.apSpd = 138 * 0.5144; this.tailstrike = false; this.landed = false;
  }

  setAttitude(hdgDeg: number, pitchDeg: number, bankDeg: number) {
    const e = new THREE.Euler(pitchDeg * D2R, -hdgDeg * D2R, -bankDeg * D2R, "YXZ");
    this.quat.setFromEuler(e);
  }

  private tmp = { f: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion() };

  computeAngles() {
    const { f, r, u } = this.tmp;
    f.set(0, 0, -1).applyQuaternion(this.quat);
    r.set(1, 0, 0).applyQuaternion(this.quat);
    u.set(0, 1, 0).applyQuaternion(this.quat);
    this.heading = ((Math.atan2(f.x, -f.z) / D2R) + 360) % 360;
    this.pitch = Math.asin(clamp(f.y, -1, 1));
    this.bank = Math.atan2(-r.y, u.y);
  }

  /** returns [x,z]-projected info about runway relative position */
  navTo(a: Airport) {
    const fr = runwayFrame(a, 0);
    const d = this.pos.clone().sub(fr.thr);
    const along = d.dot(fr.fwd);
    const cross = d.dot(fr.right);
    const alt = this.pos.y - GEAR_HEIGHT - a.elev;
    const gsAlt = 15 + Math.max(0, -along) * Math.tan(3 * D2R);
    const dist = Math.hypot(d.x, d.z);
    return { along, cross, alt, gsAlt, dist, fr, gsDevDeg: Math.atan2(alt - 15, Math.max(1, -along)) / D2R - 3, locDevDeg: Math.atan2(cross, Math.max(1, -along + a.length)) / D2R };
  }

  step(dtFrame: number, ctl: Controls) {
    this.events = {};
    if (this.crashed) return;
    const sub = 10;
    const dt = Math.min(dtFrame, 1 / 20) / sub;
    for (let i = 0; i < sub; i++) this.substep(dt, ctl);
    this.computeAngles();
  }

  private autopilot(ctl: Controls, dt: number) {
    const dest = AIRPORTS[1];
    const V = Math.max(this.ias, 40);
    let targetVS = 0, targetBank = 0;
    const nav = this.navTo(dest);
    if (this.ap === "HDG/ALT" || this.ap === "LOC") {
      targetVS = clamp((this.apAlt - (this.pos.y - GEAR_HEIGHT)) * 0.08, -9, 9);
      let hdgT = this.apHdg;
      if (this.ap === "LOC") {
        hdgT = nav.fr.heading - clamp(nav.cross * 0.03, -30, 30);
      }
      if (Math.abs(nav.cross) < 1500 && nav.along < -1500 && nav.along > -30000 && Math.abs(((this.heading - nav.fr.heading + 540) % 360) - 180) < 60 && this.ap === "LOC") {
        if (nav.alt >= nav.gsAlt - 30 && nav.alt < nav.gsAlt + 150) this.ap = "APPR";
      }
      const err = ((hdgT - this.heading + 540) % 360) - 180;
      targetBank = clamp(err * 1.4, -25, 25) * D2R;
    }
    if (this.ap === "APPR" || this.ap === "FLARE") {
      const hdgT = nav.fr.heading - clamp(nav.cross * 0.035 + this.vel.dot(nav.fr.right) * 0.25, -25, 25);
      const err = ((hdgT - this.heading + 540) % 360) - 180;
      targetBank = clamp(err * 1.5, -20, 20) * D2R;
      const gsVS = -V * Math.sin(3 * D2R);
      targetVS = gsVS + clamp((nav.gsAlt - nav.alt) * 0.12, -4, 4);
      if (this.agl < 16 && this.ap === "APPR") this.ap = "FLARE";
      if (this.ap === "FLARE") { targetVS = lerp(-0.6, gsVS, clamp((this.agl - 1) / 15, 0, 1)); targetBank = clamp(err, -3, 3) * D2R; }
    }
    if (this.ap !== "OFF" && this.ap !== "ROLLOUT") {
      const gamma = Math.asin(clamp(targetVS / V, -0.3, 0.3));
      const want = clamp(gamma + this.alpha, -10 * D2R, 18 * D2R);
      this.holdPitch += clamp(want - this.holdPitch, -2.5 * D2R * dt, 2.5 * D2R * dt);
      this.holdBank += clamp(targetBank - this.holdBank, -4 * D2R * dt, 4 * D2R * dt);
    }
    if (this.athr) {
      let spd = this.apSpd;
      if (this.ap === "FLARE" && this.agl < 9) spd = 0;
      const e = spd - this.ias;
      ctl.throttle = spd === 0 ? Math.max(0, ctl.throttle - dt * 0.4) : clamp(ctl.throttle + (e * 0.025 - this.accAlong * 0.3) * dt, 0.03, 0.95);
    }
  }

  private substep(dt: number, ctl: Controls) {
    const t = this.tmp;
    const q = this.quat;
    const fwd = t.f.set(0, 0, -1).applyQuaternion(q).clone();
    const right = t.r.set(1, 0, 0).applyQuaternion(q).clone();
    const up = t.u.set(0, 1, 0).applyQuaternion(q).clone();
    const alt = this.pos.y;
    const rho = 1.225 * Math.exp(-Math.max(0, alt) / 8500);
    const V = this.vel.length();
    const qinv = q.clone().invert();
    const vb = this.vel.clone().applyQuaternion(qinv);
    const u = -vb.z, w = vb.y;
    this.alpha = V > 2 ? Math.atan2(-w, Math.max(u, 0.1)) : 0;
    this.beta = V > 2 ? Math.asin(clamp(vb.x / V, -1, 1)) : 0;
    const qbar = 0.5 * rho * V * V;
    this.ias = V * Math.sqrt(rho / 1.225);
    this.mach = V / 330;
    this.computeAngles();

    // systems
    const fl = clamp(Math.round(ctl.flapLever), 0, 4);
    const flapTarget = FLAP_DEG[fl];
    this.flapDeg += clamp(flapTarget - this.flapDeg, -2.2 * dt, 2.2 * dt);
    this.slat += clamp(FLAP_SLAT[fl] - this.slat, -0.12 * dt, 0.12 * dt);
    const gearTarget = ctl.gearDown ? 1 : 0;
    if (!(this.onGround && !ctl.gearDown)) this.gearPos += clamp(gearTarget - this.gearPos, -dt / 9, dt / 9);
    this.spoilers += clamp(ctl.speedbrake - this.spoilers, -dt * 1.2, dt * 1.2);
    const wantGS = this.spoilersArmed && this.onGround && this.groundTime > 0.3 && ctl.throttle < 0.12 && this.gs > 4 ? 1 : 0;
    this.groundSpoilers += clamp(wantGS - this.groundSpoilers, -dt * 1.5, dt * 2.5);
    if (this.onGround && ctl.throttle > 0.3) this.landed = false;
    const wantRev = ctl.reverse && this.onGround ? 1 : 0;
    this.reverser += clamp(wantRev - this.reverser, -dt / 2, dt / 2);

    this.agl = Math.max(0, this.pos.y - GEAR_HEIGHT - groundAt(this.pos.x, this.pos.z));
    // autopilot (may modify controls)
    if (this.ap === "FLARE" && this.onGround) { this.ap = "ROLLOUT"; this.athr = false; ctl.throttle = 0; }
    if (this.ap === "ROLLOUT") { const nv = this.navTo(AIRPORTS[1]); ctl.yaw = clamp(-nv.cross * 0.04 - this.vel.dot(nv.fr.right) * 0.4, -1, 1); }
    if (this.ap === "ROLLOUT" && this.ias < 30) { this.ap = "OFF"; this.athr = false; }
    if (this.ap !== "OFF") this.autopilot(ctl, dt);

    // engines
    const thrCmd = this.reverser > 0.5 ? 0.21 + ctl.throttle * 0.6 : 0.21 + ctl.throttle * 0.79;
    const spool = this.n1 < 0.5 ? 0.18 : 0.42;
    this.n1 += clamp(thrCmd - this.n1, -1, 1) * spool * dt * (thrCmd > this.n1 ? 1 : 1.4);
    const n = clamp((this.n1 - 0.21) / 0.79, 0, 1);
    const thrustEng = MAX_THRUST * (0.035 + 0.965 * Math.pow(n, 1.45)) * Math.pow(rho / 1.225, 0.75) * (1 - 0.33 * Math.min(this.mach, 0.8));
    const revEff = this.reverser > 0.95 ? -0.45 : this.reverser > 0.05 ? 0 : 1;
    const F = new THREE.Vector3().addScaledVector(fwd, 2 * thrustEng * revEff);
    this.accel.set(0, 0, 0);

    // aerodynamics
    if (V > 1) {
      const vdir = this.vel.clone().divideScalar(V);
      const fIdx = FLAP_DEG.findIndex((d) => d >= this.flapDeg - 0.01);
      const fT = fIdx <= 0 ? 0 : (this.flapDeg - FLAP_DEG[fIdx - 1]) / (FLAP_DEG[fIdx] - FLAP_DEG[fIdx - 1]);
      const dCL = fIdx <= 0 ? 0 : lerp(FLAP_DCL[fIdx - 1], FLAP_DCL[fIdx], fT);
      const dCD = fIdx <= 0 ? 0 : lerp(FLAP_DCD[fIdx - 1], FLAP_DCD[fIdx], fT);
      const aStall = (15 + this.slat * 3 - (dCL > 0.5 ? 1 : 0)) * D2R;
      const a = this.alpha;
      let CL: number;
      const CLa = 5.4;
      const CL0 = 0.22 + dCL;
      if (a < aStall) CL = CL0 + CLa * a;
      else CL = Math.max(0.3, CL0 + CLa * aStall - (a - aStall) * 3.2);
      if (a < -12 * D2R) CL = CL0 + CLa * -12 * D2R;
      this.stall = a > aStall;
      const spoil = Math.max(this.spoilers * 0.6, this.groundSpoilers);
      CL *= 1 - 0.55 * spoil;
      // ground effect
      const h = Math.max(0.5, this.pos.y - GEAR_HEIGHT - heightAt(this.pos.x, this.pos.z));
      const ge = h < B ? (1 - h / B) : 0;
      CL *= 1 + 0.1 * ge;
      const k = 0.046 * (1 - 0.45 * ge);
      const CD = 0.021 + k * CL * CL + dCD + this.gearPos * 0.017 + spoil * 0.06 + Math.abs(this.beta) * 0.25 + (this.stall ? 0.08 : 0) + this.reverser * 0.02;
      const liftDir = new THREE.Vector3().crossVectors(right, vdir).normalize();
      F.addScaledVector(liftDir, qbar * S * CL);
      F.addScaledVector(vdir, -qbar * S * CD);
      F.addScaledVector(right, -qbar * S * 0.9 * this.beta);
    }
    F.y -= this.mass * G;

    const torque = new THREE.Vector3(); // world
    // ground contacts
    const gH = groundAt(this.pos.x, this.pos.z);
    this.agl = Math.max(0, this.pos.y - GEAR_HEIGHT - gH);
    const wWorld = this.omega.clone().applyQuaternion(q);
    let anyContact = false;
    const steerMax = lerp(65, 6, clamp(this.gs / 30, 0, 1)) * D2R;
    this.noseSteer = ctl.yaw * steerMax;
    const brakeCmd = Math.max(ctl.brake, ctl.parkingBrake ? 1 : 0, this.autobrake && this.landed && this.onGround && ctl.throttle < 0.12 ? 0.32 : 0);
    const contactList: [keyof FlightModel["contacts"], number, number, number][] = [["nose", 1.45e5, 3.5e4, 0], ["left", 1.05e6, 2.4e5, 1], ["right", 1.05e6, 2.4e5, 2]];
    const flatF = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    for (const [name, k, c, ci] of contactList) {
      const rb = this.contacts[name];
      const rw = rb.clone().applyQuaternion(q);
      const p = rw.clone().add(this.pos);
      const gh = groundAt(p.x, p.z);
      const d = gh - p.y;
      this.comp[ci] = clamp(d, 0, GEAR_EXT + 0.05) - GEAR_EXT;
      if (d > 0 && this.gearPos > 0.98) {
        anyContact = true;
        const vc = this.vel.clone().add(new THREE.Vector3().crossVectors(wWorld, rw));
        let N = k * d + 6e7 * Math.max(0, d - GEAR_EXT) ** 2 * 10 - c * vc.y;
        N = Math.max(0, N);
        let wf = flatF.clone();
        if (name === "nose") wf.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.noseSteer);
        const wl = new THREE.Vector3(-wf.z, 0, wf.x); // right
        const vLong = vc.dot(wf), vLat = vc.dot(wl);
        const mu = 0.75;
        const Flat = -clamp(vLat * N * 6, -mu * N, mu * N);
        const brk = name === "nose" ? 0 : brakeCmd;
        const Flong = -Math.tanh(vLong / 0.4) * (0.012 + brk * 0.55) * N;
        const Fc = new THREE.Vector3(0, N, 0).addScaledVector(wf, Flong).addScaledVector(wl, Flat);
        F.add(Fc);
        torque.add(new THREE.Vector3().crossVectors(rw, Fc));
        // touchdown event
        if (!this.prevOnGround && this.airTime > 3 && name !== "nose" && !this.events.touchdown) {
          const fpm = this.vs * 196.85;
          let best: Airport | null = null, bd = 0, bo = 0;
          for (const ap of AIRPORTS) {
            const fr = runwayFrame(ap, 0);
            const dd = this.pos.clone().sub(fr.thr);
            const al = dd.dot(fr.fwd), cr = dd.dot(fr.right);
            if (al > -60 && al < ap.length + 60 && Math.abs(cr) < ap.width / 2 + 8) { best = ap; bd = al; bo = cr; }
          }
          this.landed = true;
          this.events.touchdown = { fpm, airport: best, distFromThr: bd, offCenter: bo, g: this.gload };
          if (fpm < -1400) this.crash("Structural failure - touchdown at " + Math.round(fpm) + " fpm");
          else if (!best) {
            if (p.y <= WATER_LEVEL + 0.2) this.crash("Ditched in water");
            else if (this.gs > 30) this.crash("Off-runway landing - gear collapsed");
          }
        }
      }
    }
    // hard points (structure)
    this.tailstrike = false;
    for (const hp of this.hardPoints) {
      const rw = hp.p.clone().applyQuaternion(q);
      const p = rw.clone().add(this.pos);
      const gh = groundAt(p.x, p.z);
      const d = gh - p.y;
      if (d > 0) {
        const vc = this.vel.clone().add(new THREE.Vector3().crossVectors(wWorld, rw));
        if (hp.name === "tail" || hp.name === "aft belly") {
          this.tailstrike = true;
          const N = Math.max(0, 3e6 * d - 3e5 * vc.y);
          const Fc = new THREE.Vector3(0, N, 0).addScaledVector(vc.clone().setY(0).normalize(), -0.4 * N);
          F.add(Fc); torque.add(new THREE.Vector3().crossVectors(rw, Fc));
          if (d > 0.5 || vc.y < -4) this.crash("Severe tail strike");
        } else if (this.gearPos < 0.98 && hp.name === "belly" && Math.abs(vc.y) < 3) {
          const N = Math.max(0, 3e6 * d - 3e5 * vc.y);
          const Fc = new THREE.Vector3(0, N, 0).addScaledVector(vc.clone().setY(0).normalize(), -0.5 * N);
          F.add(Fc); torque.add(new THREE.Vector3().crossVectors(rw, Fc));
          if (this.gs < 2) this.crash("Gear-up landing");
        } else {
          this.crash(`Impact: ${hp.name} struck the ground`);
          return;
        }
      }
    }
    if (this.pos.y - 1 < gH && !anyContact && this.gearPos < 0.98) { /* belly handled above */ }
    if (this.pos.y < gH - 1) { this.crash("Controlled flight into terrain"); return; }

    // control laws
    const tauBody = torque.clone().applyQuaternion(qinv);
    const Vs = Math.max(V, 20);
    const authP = qbar * S * C * 0.45 + 2e5;
    const authR = qbar * S * B * 0.055 + 5e4;
    const authY = qbar * S * B * 0.03 + 5e4;
    const om = this.omega;
    // aero damping + stability
    const dampK = qbar * S / (2 * Vs);
    tauBody.x += -dampK * C * C * 14 * om.x;
    tauBody.z += -dampK * B * B * 0.45 * om.z;
    tauBody.y += -dampK * B * B * 0.12 * om.y;
    tauBody.y += -qbar * S * B * 0.1 * this.beta; // weathercock (nose toward relative wind)
    tauBody.z += qbar * S * B * 0.06 * this.beta; // dihedral effect

    const inAir = !anyContact;
    let cmdX = 0, cmdY = 0, cmdZ = 0;
    const apOn = this.ap !== "OFF" && this.ap !== "ROLLOUT";
    const sp = apOn ? 0 : ctl.pitch, sr = apOn ? 0 : ctl.roll;
    if (inAir) {
      // Normal law: pitch/bank attitude hold, stick = rate
      const pitchRate = 5 * D2R, rollRate = 15 * D2R;
      let thDot: number, phDot: number;
      if (Math.abs(sp) > 0.04) { thDot = sp * pitchRate; this.holdPitch = this.pitch; }
      else thDot = clamp((this.holdPitch - this.pitch) * 1.2, -3 * D2R, 3 * D2R);
      if (Math.abs(sr) > 0.04) {
        phDot = sr * rollRate; this.holdBank = this.bank;
        if (Math.abs(this.bank) > 67 * D2R && Math.sign(sr) === Math.sign(this.bank)) phDot = 0;
      } else {
        let target = this.holdBank;
        if (Math.abs(target) > 33 * D2R) target = Math.sign(target) * 33 * D2R;
        if (Math.abs(target) < 1 * D2R && !apOn) target = 0;
        this.holdBank = target;
        phDot = clamp((target - this.bank) * 1.5, -rollRate, rollRate);
      }
      // protections
      const aMax = (14 + this.slat * 2.5) * D2R;
      if (this.alpha > aMax - 2 * D2R) thDot = Math.min(thDot, -(this.alpha - (aMax - 2 * D2R)) * 2);
      if (this.pitch > 30 * D2R) thDot = Math.min(thDot, 0);
      if (this.pitch < -15 * D2R) thDot = Math.max(thDot, 0);
      const psiDot = G * Math.tan(this.bank) / Vs + ctl.yaw * 0.06;
      const th = this.pitch, ph = this.bank;
      const p = phDot - psiDot * Math.sin(th);
      const qq = thDot * Math.cos(ph) + psiDot * Math.cos(th) * Math.sin(ph);
      const r = -thDot * Math.sin(ph) + psiDot * Math.cos(th) * Math.cos(ph);
      cmdX = qq; cmdY = -r; cmdZ = -p;
      const K = 2.5;
      tauBody.x += clamp(this.I.x * K * (cmdX - om.x) - 0 * tauBody.x, -authP, authP);
      tauBody.y += clamp(this.I.y * K * (cmdY - om.y), -authY, authY);
      tauBody.z += clamp(this.I.z * K * (cmdZ - om.z), -authR, authR);
      this.surf.elevator = clamp((cmdX - om.x) * 6 + sp * 0.3, -1, 1);
      this.surf.aileron = clamp(-(cmdZ - om.z) * 5 + sr * 0.4, -1, 1);
      this.surf.rudder = clamp(ctl.yaw + this.beta * 3, -1, 1);
    } else {
      // ground law: direct
      if (Math.abs(sp) > 0.04) tauBody.x += clamp(this.I.x * 2.5 * (sp * 4 * D2R - om.x), -authP, authP);
      tauBody.z += -sr * authR * 0.4;
      tauBody.y += -ctl.yaw * authY * 0.8;
      this.holdPitch = this.pitch; this.holdBank = 0;
      this.surf.elevator = sp; this.surf.aileron = sr; this.surf.rudder = ctl.yaw;
    }

    // integrate linear
    this.accel.copy(F).divideScalar(this.mass);
    if (V > 1) this.accAlong = this.accel.dot(this.vel) / V;
    this.vel.addScaledVector(this.accel, dt);
    this.pos.addScaledVector(this.vel, dt);
    // integrate angular
    const Iw = new THREE.Vector3(this.I.x * om.x, this.I.y * om.y, this.I.z * om.z);
    const gyro = new THREE.Vector3().crossVectors(om, Iw);
    tauBody.sub(gyro);
    om.x += (tauBody.x / this.I.x) * dt;
    om.y += (tauBody.y / this.I.y) * dt;
    om.z += (tauBody.z / this.I.z) * dt;
    const dq = new THREE.Quaternion(om.x * dt * 0.5, om.y * dt * 0.5, om.z * dt * 0.5, 1);
    q.multiply(dq).normalize();

    // telemetry
    this.gs = Math.hypot(this.vel.x, this.vel.z);
    this.vs = this.vel.y;
    const aUp = this.accel.clone().add(new THREE.Vector3(0, G, 0)).dot(up);
    this.gload = lerp(this.gload, aUp / G, 0.05);
    this.onGround = anyContact;
    if (anyContact) { this.groundTime += dt; if (this.groundTime > 0.5) this.airTime = 0; }
    else { this.airTime += dt; if (this.airTime > 1) this.groundTime = 0; }
    if (this.prevOnGround && !anyContact && this.airTime > 0) this.events.liftoff = true;
    this.prevOnGround = anyContact;
    void cmdY;
  }

  crash(reason: string) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.events.crash = reason;
  }
}
