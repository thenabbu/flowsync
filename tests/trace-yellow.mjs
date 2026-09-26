// Trace the yellow-transition case: fixed mode, phase 0 (N), phaseDuration=1.
import fs from 'fs';
import vm from 'vm';
import path from 'path';

const root = process.argv[2] || '.';
const src = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradient;
    if (p === 'measureText') return () => ({ width: 10 });
    return noop;
  },
  set(t, p, v) { t[p] = v; return true; }
});
const els = {};
function el(id) {
  if (els[id]) return els[id];
  els[id] = {
    id, width: 680, height: 680, style: {}, dataset: {}, textContent: '', className: '',
    innerHTML: '', value: '', classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    getContext: () => ctxStub, addEventListener: noop, dispatchEvent: noop,
    appendChild: noop, querySelectorAll: () => [],
  };
  return els[id];
}
el('modeSelect').value = 'fixed';
el('trafficSelect').value = 'normal';
el('speedRange').value = '1';
const sandbox = {
  console, Math, Date, JSON, Uint8Array, requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop, performance: { now: () => Date.now() },
  setTimeout, clearTimeout, Event: class { constructor(t) { this.type = t; } },
  document: { getElementById: el, querySelectorAll: () => [], addEventListener: noop },
};
sandbox.globalThis = sandbox;
vm.runInContext(src + `
;globalThis.__probe = { get state(){return state}, set state(v){state=v}, tick, fresh,
  get seed(){return seed}, set seed(v){seed=v}, CONN, IDS, HORIZON, YELLOW_DURATION };`,
  vm.createContext(sandbox), { filename: 'script.js' });
const P = sandbox.__probe;

P.seed = 42; P.fresh();
const s = P.state;
s.mode = 'fixed';
s.schedules = s.schedules.map(() => new Uint8Array(P.HORIZON));
for (const i of P.IDS) s.intersections[i].vehicles.length = 0;
const st = s.intersections.I00;
st.phase = 0; st.signalState = 'green'; st.phaseTime = 0; st.phaseDuration = 1;
st.vehicles.push({ id: 9001, d: 'N', pos: 40, wait: 0, tripWait: 0,
  passed: false, emergency: false, committed: false, route: { type: 'straight', outD: 'N' } });

const trace = [];
let sawYellow = false, firstYellowStep = -1;
for (let i = 0; i < 400; i++) {
  if (st.signalState === 'yellow' && !sawYellow) { sawYellow = true; firstYellowStep = i; }
  if (i < 60 || i % 10 === 0) {
    trace.push(`step ${i}: state=${st.signalState} phase=${st.phase} phaseTime=${st.phaseTime.toFixed(2)} amberTimer=${st.amberTimer.toFixed(2)} phaseDuration=${st.phaseDuration} v.pos=${st.vehicles[0] ? st.vehicles[0].pos.toFixed(1) : '-'}`);
  }
  P.tick(0.05);
}
console.log('sawYellow:', sawYellow, 'at step', firstYellowStep, '| YELLOW_DURATION =', P.YELLOW_DURATION);
console.log(trace.slice(0, 45).join('\n'));
