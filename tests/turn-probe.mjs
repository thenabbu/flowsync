// B9 verification: a committed left-turning car must advance through the
// junction with no positional discontinuity, and its route must complete.
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
  tick, fresh, get seed(){return seed}, set seed(v){seed=v},
  posToOffset, STOP_LINE, CENTERS, TILE_HALF,
};`, vm.createContext(sandbox), { filename: 'script.js' });

const P = sandbox.__probe;
const out = {};

// Committed left-turning northbound car at the stop line, green for N.
P.seed = 42; P.fresh();
const s = P.state;
s.intersections.I00.vehicles.length = 0;
s.intersections.I00.vehicles.push({
  id: 9001, d: 'N', pos: P.STOP_LINE, wait: 0, tripWait: 0, passed: false,
  emergency: false, committed: true, turnType: 'left', outD: 'W',
  route: { type: 'left', outD: 'W' },
});
s.intersections.I00.phase = 0;
s.intersections.I00.signalState = 'green';
s.intersections.I00.phaseDuration = 30;

const positions = [];
let despawned = false;
for (let i = 0; i < 300; i++) {
  const v = s.intersections.I00.vehicles.find(v => v.id === 9001);
  if (!v) { despawned = true; break; }
  positions.push(+v.pos.toFixed(2));
  P.tick(0.05);
}
let worst = 0;
for (let i = 1; i < positions.length; i++) {
  worst = Math.max(worst, positions[i] - positions[i - 1]);
}
out.B9_left_turn = {
  pos_first: positions[0], pos_last: positions[positions.length - 1],
  ticks_to_complete: positions.length,
  despawned,
  max_tick_delta: +worst.toFixed(3),
  per_tick_travel: 0.05 * 35,
  monotonic: positions.every((p, i) => i === 0 || p >= positions[i - 1]),
};

// Same check for a right turn and a U-turn.
for (const [tt, od] of [['right', 'E'], ['uturn', 'S']]) {
  P.seed = 42; P.fresh();
  const s2 = P.state;
  s2.intersections.I00.vehicles.length = 0;
  s2.intersections.I00.vehicles.push({
    id: 9002, d: 'N', pos: P.STOP_LINE, wait: 0, tripWait: 0, passed: false,
    emergency: false, committed: true, turnType: tt, outD: od,
    route: { type: tt, outD: od },
  });
  s2.intersections.I00.phase = 0;
  s2.intersections.I00.signalState = 'green';
  s2.intersections.I00.phaseDuration = 30;
  const pos2 = [];
  let done2 = false;
  for (let i = 0; i < 300; i++) {
    const v = s2.intersections.I00.vehicles.find(v => v.id === 9002);
    if (!v) { done2 = true; break; }
    pos2.push(+v.pos.toFixed(2));
    P.tick(0.05);
  }
  let w2 = 0;
  for (let i = 1; i < pos2.length; i++) w2 = Math.max(w2, pos2[i] - pos2[i - 1]);
  out['B9_' + tt] = {
    ticks_to_complete: pos2.length, despawned: done2,
    max_tick_delta: +w2.toFixed(3), monotonic: pos2.every((p, i) => i === 0 || p >= pos2[i - 1]),
  };
}

console.log(JSON.stringify(out, null, 2));
