// Audit probes for the three highest-severity findings. Read-only: asserts facts,
// changes no application behaviour.
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
    innerHTML: '', value: '',
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    getContext: () => ctxStub, addEventListener: noop, dispatchEvent: noop,
    appendChild: noop, querySelectorAll: () => [],
  };
  return els[id];
}
el('modeSelect').value = 'adaptive';
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
;globalThis.__probe = {
  get state(){return state}, set state(v){state=v},
  tick, fresh, spawnEmergency, callPedestrian, get seed(){return seed}, set seed(v){seed=v},
  posToOffset, STOP_LINE, CENTERS, TILE_HALF, MIN_GAP, CONN,
};`, vm.createContext(sandbox), { filename: 'script.js' });

const P = sandbox.__probe;
const out = {};

// ---------------------------------------------------------------------------
// B1: does a neighbour's emergency pre-clear survive into the next tick?
// CONN.I00.E === 'I10', so an eastbound emergency vehicle at I00 pre-clears I10.
// ---------------------------------------------------------------------------
P.seed = 42; P.fresh();
const s = P.state;
s.intersections.I00.vehicles.push({
  id: 9001, d: 'E', pos: 330, wait: 0, tripWait: 0, passed: false,
  emergency: true, committed: false, route: { type: 'straight', outD: 'E' },
});
const preemptTrace = [];
const logTrace = [];
for (let i = 0; i < 6; i++) {
  P.tick(0.05);
  preemptTrace.push({
    step: i + 1,
    I10_preempting: s.intersections.I10.preempting,
    I10_signal: s.intersections.I10.signalState,
    I10_phase: s.intersections.I10.phase,
    I10_decision: s.intersections.I10.lastDecision,
  });
}
out.B1_preempt_trace = preemptTrace;
out.B1_log_lines = s.logs.slice(0, 6);

// ---------------------------------------------------------------------------
// B10: geometry of a car waiting at STOP_LINE vs the zebra band.
// For a northbound car: body spans y = cy-off-11 .. cy-off+11;
// the south zebra band (the one it must stop before) spans cy+35 .. cy+49.
// ---------------------------------------------------------------------------
const cy = P.CENTERS.I00[1];
const off = P.posToOffset(P.STOP_LINE);
const front = cy - off - 11;          // north edge of the car = leading edge
const bandNear = cy + 35, bandFar = cy + 49;
const overlap = Math.max(0, Math.min(bandFar, front + 22) - Math.max(bandNear, front));
out.B10 = {
  STOP_LINE: P.STOP_LINE,
  car_center_offset: +off.toFixed(2),
  car_leading_edge_offset: +(cy - front - cy).toFixed(2) === 0 ? null : +(-(front - cy)).toFixed(2),
  car_body_y: [+front.toFixed(2), +(front + 22).toFixed(2)],
  zebra_band_y: [bandNear, bandFar],
  overlap_units: +overlap.toFixed(2),
  car_length: 22,
  pct_of_car_on_zebra: +(overlap / 22 * 100).toFixed(1),
};
// smallest pos that keeps the leading edge clear of the far stripe edge
let safePos = 0;
for (let p = 140; p >= 0; p -= 0.5) {
  const f = cy - P.posToOffset(p) - 11;
  if (f >= bandFar) { safePos = p; break; }
}
out.B10_STOP_LINE_that_clears_zebra = safePos;

// ---------------------------------------------------------------------------
// B9: turn-render handoff. The Bezier starts at the box entry (offset -30) but
// straight-axis rendering is used until pos 250. Compute the visual jump.
// ---------------------------------------------------------------------------
const off250 = P.posToOffset(250);
const yStraight250 = cy - off250;              // where the car is actually drawn at pos 250
const curveStartY = cy + 30;                   // where the Bezier begins for an N-travelling car
let handoffPos = 0;
for (let p = 0; p <= 430; p += 0.5) { if (Math.abs(cy - P.posToOffset(p) - (cy + 30)) < 0.01) { handoffPos = p; break; } }
out.B9 = {
  drawn_y_at_pos250_straight_axis: +yStraight250.toFixed(2),
  bezier_start_y: curveStartY,
  visual_jump_at_handoff_units: +Math.abs(curveStartY - yStraight250).toFixed(2),
  correct_handoff_pos: handoffPos,
  current_handoff_pos: 250,
};

console.log(JSON.stringify(out, null, 2));
