import { useEffect, useRef, useState } from "react";
import { Sim, CAM_MODES, type CamMode, type SimMessage } from "./sim/engine";
import { TIMES } from "./sim/world";
import type { Telemetry } from "./sim/instruments";

type Tel = Telemetry & { cam: CamMode; paused: boolean; lights: boolean };
type EndInfo = { kind: "crash" | "landed"; title: string; lines: string[] } | null;

const KEYS: [string, string][] = [
  ["W/S or ↑/↓", "Pitch (sidestick)"],
  ["A/D or ←/→", "Roll"],
  ["Q / E", "Rudder & nosewheel steering"],
  ["Shift / Ctrl", "Thrust levers  (T = TOGA)"],
  ["P", "Parking brake"],
  ["Space", "Wheel brakes (hold)"],
  ["F / V", "Flaps extend / retract"],
  ["G", "Landing gear"],
  ["B", "Speedbrakes"],
  ["R", "Thrust reversers (ground)"],
  ["K", "Autopilot HDG/ALT"],
  ["J", "APPR – ILS autoland"],
  ["U", "Auto-thrust"],
  ["L", "Landing / taxi lights"],
  ["C or 1-7", "Cameras"],
  ["Mouse drag / wheel", "Look / orbit / zoom"],
  ["N", "Cycle time of day"],
  ["H", "Hide HUD   ·   M  Mute   ·   Esc  Pause"],
];

function Bar({ v, color = "bg-emerald-400" }: { v: number; color?: string }) {
  return (
    <div className="h-1.5 w-full rounded bg-white/10 overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
    </div>
  );
}

export default function App() {
  const mount = useRef<HTMLDivElement>(null);
  const pfdRef = useRef<HTMLDivElement>(null);
  const ndRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Sim | null>(null);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [tel, setTel] = useState<Tel | null>(null);
  const [msgs, setMsgs] = useState<SimMessage[]>([]);
  const [end, setEnd] = useState<EndInfo>(null);
  const [timeIdx, setTimeIdx] = useState(2);
  const [help, setHelp] = useState(false);
  const [hud, setHud] = useState(true);
  const [, force] = useState(0);

  useEffect(() => {
    if (!mount.current) return;
    const sim = new Sim(mount.current, {
      onTelemetry: (t) => { setTel(t); setHud(sim.hudVisible); },
      onMessage: (m) => setMsgs((p) => [...p.slice(-4), m]),
      onEnd: (r) => setEnd(r),
    });
    simRef.current = sim;
    if (import.meta.env.DEV) (window as unknown as { sim?: Sim }).sim = sim;
    const id = setTimeout(() => {
      sim.build();
      setReady(true);
    }, 60);
    const t = setInterval(() => setMsgs((p) => p.filter((m) => performance.now() - m.t < 7000)), 1000);
    return () => { clearTimeout(id); clearInterval(t); sim.dispose(); };
  }, []);

  useEffect(() => {
    const sim = simRef.current;
    if (!ready || !sim) return;
    const place = (ref: React.RefObject<HTMLDivElement | null>, c: HTMLCanvasElement) => {
      if (ref.current && c.parentElement !== ref.current) {
        c.style.width = "100%"; c.style.height = "100%"; c.style.display = "block";
        ref.current.appendChild(c);
      }
    };
    place(pfdRef, sim.rig.screens.pfd);
    place(ndRef, sim.rig.screens.nd);
  }, [ready, started, hud]);

  const start = (mode: "departure" | "approach") => {
    const sim = simRef.current; if (!sim) return;
    sim.setTimeOfDay(timeIdx);
    sim.start(mode);
    setStarted(true);
    setEnd(null);
    force((x) => x + 1);
  };

  const sim = simRef.current;
  const t = tel;
  const phase = !t ? "" : t.onGround ? (t.gs < 3 ? "PARKED / HOLDING" : t.gs < 40 ? "TAXI / ROLLOUT" : "TAKEOFF ROLL / LANDING ROLL") : t.ap === "APPR" || t.ap === "FLARE" ? "FINAL APPROACH" : t.alt < 3000 && t.vs > 300 ? "INITIAL CLIMB" : t.distNm < 12 ? "APPROACH" : "EN ROUTE";

  return (
    <div className="fixed inset-0 bg-black text-white select-none overflow-hidden" style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>
      <div ref={mount} className="absolute inset-0" />

      {/* HUD */}
      {started && t && hud && (
        <>
          <div className="absolute top-4 left-4 rounded-xl bg-black/45 backdrop-blur-md border border-white/10 px-4 py-3 text-xs shadow-2xl min-w-[260px]">
            <div className="flex items-center gap-2 text-[11px] tracking-[0.2em] text-sky-300 font-semibold">AERIS 320 · A320-214</div>
            <div className="mt-1 text-lg font-bold tracking-wide">EAUR <span className="text-white/40">→</span> EBVR</div>
            <div className="text-white/60">{phase}</div>
            <div className="mt-2 grid grid-cols-3 gap-2 font-mono">
              <div><div className="text-white/40 text-[10px]">IAS</div><div className="text-emerald-300 text-base">{Math.round(t.ias)}<span className="text-[10px] text-white/40"> kt</span></div></div>
              <div><div className="text-white/40 text-[10px]">ALT</div><div className="text-emerald-300 text-base">{Math.round(t.alt)}<span className="text-[10px] text-white/40"> ft</span></div></div>
              <div><div className="text-white/40 text-[10px]">V/S</div><div className={`text-base ${t.vs < -1000 ? "text-amber-300" : "text-emerald-300"}`}>{Math.round(t.vs / 10) * 10}</div></div>
              <div><div className="text-white/40 text-[10px]">HDG</div><div className="text-base">{String(Math.round(t.hdg) % 360).padStart(3, "0")}°</div></div>
              <div><div className="text-white/40 text-[10px]">GS</div><div className="text-base">{Math.round(t.gs)}</div></div>
              <div><div className="text-white/40 text-[10px]">DIST</div><div className="text-base">{t.distNm.toFixed(1)}<span className="text-[10px] text-white/40"> nm</span></div></div>
            </div>
          </div>

          <div className="absolute top-4 right-4 flex flex-col items-end gap-2">
            <div className="flex gap-1 flex-wrap justify-end max-w-[520px]">
              {CAM_MODES.map((c, i) => (
                <button key={c.id} onClick={() => { sim?.setCam(c.id); force((x) => x + 1); }}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition ${t.cam === c.id ? "bg-sky-500/90 border-sky-300 text-white" : "bg-black/45 border-white/10 text-white/70 hover:bg-white/10"}`}>
                  <span className="text-white/40 mr-1">{i + 1}</span>{c.name}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <button onClick={() => setHelp((h) => !h)} className="px-2.5 py-1.5 rounded-lg text-[11px] bg-black/45 border border-white/10 hover:bg-white/10">Controls</button>
              <button onClick={() => { if (!sim) return; const n = (sim.timeIdx + 1) % TIMES.length; sim.setTimeOfDay(n); setTimeIdx(n); }} className="px-2.5 py-1.5 rounded-lg text-[11px] bg-black/45 border border-white/10 hover:bg-white/10">☀ {TIMES[sim?.timeIdx ?? 0].name}</button>
              <button onClick={() => { if (sim) sim.paused = !sim.paused; }} className="px-2.5 py-1.5 rounded-lg text-[11px] bg-black/45 border border-white/10 hover:bg-white/10">{t.paused ? "▶ Resume" : "❚❚ Pause"}</button>
            </div>
            {help && (
              <div className="mt-1 rounded-xl bg-black/55 backdrop-blur-md border border-white/10 p-3 text-[11px] w-[300px]">
                {KEYS.map(([k, d]) => (
                  <div key={k} className="flex justify-between gap-3 py-[2px]"><span className="font-mono text-sky-300 whitespace-nowrap">{k}</span><span className="text-white/70 text-right">{d}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none">
            {msgs.map((m) => (
              <div key={m.t} className={`px-4 py-1.5 rounded-full text-xs backdrop-blur-md border shadow-lg ${m.kind === "good" ? "bg-emerald-600/40 border-emerald-300/40" : m.kind === "warn" ? "bg-amber-600/40 border-amber-300/40" : m.kind === "bad" ? "bg-red-600/50 border-red-300/40" : "bg-black/50 border-white/15"}`}>{m.text}</div>
            ))}
          </div>

          {/* glass cockpit displays */}
          <div className={`absolute bottom-4 left-4 flex gap-2 ${t.cam === "cockpit" ? "opacity-0 pointer-events-none" : ""}`}>
            <div className="rounded-xl overflow-hidden border-4 border-neutral-800 shadow-2xl bg-black" style={{ width: "min(24vh, 250px)", height: "min(24vh, 250px)" }} ref={pfdRef} />
            <div className="rounded-xl overflow-hidden border-4 border-neutral-800 shadow-2xl bg-black" style={{ width: "min(24vh, 250px)", height: "min(24vh, 250px)" }} ref={ndRef} />
          </div>

          {/* systems */}
          <div className="absolute bottom-4 right-4 rounded-xl bg-black/50 backdrop-blur-md border border-white/10 p-3 text-[11px] w-[250px] shadow-2xl">
            <div className="flex justify-between mb-1"><span className="text-white/50">THRUST</span><span className="font-mono">{t.reverser > 0.5 ? "REV " : ""}{Math.round(t.throttle * 100)}% · N1 {(t.n1 * 100).toFixed(1)}</span></div>
            <Bar v={t.throttle} color={t.reverser > 0.5 ? "bg-amber-400" : "bg-sky-400"} />
            <div className="mt-1"><Bar v={(t.n1 - 0.2) / 0.82} /></div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3">
              <div className="flex justify-between"><span className="text-white/50">FLAPS</span><span className="font-mono text-cyan-300">{t.flapName}</span></div>
              <div className="flex justify-between"><span className="text-white/50">GEAR</span><span className={`font-mono ${t.gear > 0.99 ? "text-emerald-300" : t.gear < 0.01 ? "text-white/60" : "text-red-400"}`}>{t.gear > 0.99 ? "DOWN" : t.gear < 0.01 ? "UP" : "TRANSIT"}</span></div>
              <div className="flex justify-between"><span className="text-white/50">SPD BRK</span><span className="font-mono">{t.spoilers > 0.05 ? Math.round(t.spoilers * 100) + "%" : "RET"}</span></div>
              <div className="flex justify-between"><span className="text-white/50">BRAKES</span><span className={`font-mono ${t.parking ? "text-amber-300" : ""}`}>{t.parking ? "PARK" : t.brake > 0 ? "ON" : "OFF"}</span></div>
              <div className="flex justify-between"><span className="text-white/50">AP</span><span className={`font-mono ${t.ap !== "OFF" ? "text-emerald-300" : "text-white/50"}`}>{t.ap}</span></div>
              <div className="flex justify-between"><span className="text-white/50">A/THR</span><span className={`font-mono ${t.athr ? "text-emerald-300" : "text-white/50"}`}>{t.athr ? Math.round(t.apSpd) + "kt" : "OFF"}</span></div>
              <div className="flex justify-between"><span className="text-white/50">AoA</span><span className={`font-mono ${t.alpha > 12 ? "text-red-400" : ""}`}>{t.alpha.toFixed(1)}°</span></div>
              <div className="flex justify-between"><span className="text-white/50">G</span><span className="font-mono">{t.gload.toFixed(2)}</span></div>
            </div>
            {t.stall && <div className="mt-2 text-center font-bold text-red-400 animate-pulse">STALL · STALL</div>}
            {!t.gearDown && !t.onGround && t.agl < 250 && t.vs < 0 && <div className="mt-2 text-center font-bold text-red-400 animate-pulse">TOO LOW · GEAR</div>}
          </div>
          {t.paused && !end && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-4xl font-black tracking-[0.4em] text-white/80 drop-shadow-2xl">PAUSED</div>
            </div>
          )}
        </>
      )}

      {/* Menu */}
      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/70 via-black/40 to-black/80">
          <div className="max-w-3xl w-full mx-4 rounded-3xl border border-white/10 bg-black/55 backdrop-blur-xl p-8 shadow-[0_40px_120px_rgba(0,0,0,0.7)]">
            <div className="text-[11px] tracking-[0.5em] text-sky-300 font-semibold">AERIS FLIGHT SIMULATOR</div>
            <h1 className="mt-2 text-4xl md:text-5xl font-black tracking-tight">A320 <span className="text-white/40 font-light">Neo-Classic</span></h1>
            <p className="mt-3 text-white/60 text-sm leading-relaxed">
              Procedurally modelled Airbus A320 with articulated flaps, slats, spoilers, ailerons, elevators, rudder, retractable gear with oleo
              struts &amp; steering, spinning CFM fans, pivot-door thrust reversers, strobes/beacons/nav lights and a live glass cockpit.
              One route: <span className="text-white">Aurora Intl (EAUR) RWY 09 → Bayview Regional (EBVR) ILS 09</span>, 22 NM.
            </p>
            <div className="mt-5">
              <div className="text-[11px] text-white/50 mb-2 tracking-widest">TIME OF DAY</div>
              <div className="flex flex-wrap gap-2">
                {TIMES.map((tm, i) => (
                  <button key={tm.name} onClick={() => { setTimeIdx(i); simRef.current?.setTimeOfDay(i); }}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition ${timeIdx === i ? "bg-sky-500 border-sky-300" : "bg-white/5 border-white/10 hover:bg-white/10"}`}>{tm.name}</button>
                ))}
              </div>
            </div>
            <div className="mt-6 grid md:grid-cols-2 gap-3">
              <button disabled={!ready} onClick={() => start("departure")}
                className="group text-left rounded-2xl p-5 bg-gradient-to-br from-sky-600 to-blue-800 hover:from-sky-500 hover:to-blue-700 disabled:opacity-40 transition border border-sky-300/30 shadow-xl">
                <div className="text-xs tracking-widest text-sky-100/80">FULL FLIGHT</div>
                <div className="text-xl font-bold mt-1">Takeoff from Aurora</div>
                <div className="text-xs text-sky-100/70 mt-1">Lined up RWY 09 · Flaps 1+F · Parking brake set</div>
              </button>
              <button disabled={!ready} onClick={() => start("approach")}
                className="text-left rounded-2xl p-5 bg-white/5 hover:bg-white/10 disabled:opacity-40 transition border border-white/15 shadow-xl">
                <div className="text-xs tracking-widest text-white/60">LANDING CHALLENGE</div>
                <div className="text-xl font-bold mt-1">Final approach Bayview</div>
                <div className="text-xs text-white/60 mt-1">ILS 09 · 8 NM · Flaps FULL · Gear down</div>
              </button>
            </div>
            <div className="mt-5 text-[11px] text-white/40">
              {ready ? "World ready. Mouse-drag to look around, C to change camera, J for autoland." : "Generating terrain, airports, aircraft geometry & textures…"}
            </div>
          </div>
        </div>
      )}

      {/* End */}
      {end && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className={`rounded-3xl border p-8 w-[440px] shadow-2xl ${end.kind === "crash" ? "border-red-400/40 bg-red-950/60" : "border-emerald-400/40 bg-emerald-950/60"}`}>
            <div className={`text-3xl font-black tracking-widest ${end.kind === "crash" ? "text-red-300" : "text-emerald-300"}`}>{end.title}</div>
            <div className="mt-4 space-y-1 text-sm text-white/80">{end.lines.map((l) => <div key={l}>{l}</div>)}</div>
            <div className="mt-6 flex gap-2">
              <button onClick={() => start("departure")} className="flex-1 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 font-semibold text-sm">Fly again</button>
              <button onClick={() => start("approach")} className="flex-1 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 font-semibold text-sm">Landing only</button>
              {end.kind === "landed" && <button onClick={() => { setEnd(null); if (simRef.current) simRef.current.paused = false; }} className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-sm">Taxi</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
