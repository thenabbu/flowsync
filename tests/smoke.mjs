// Headless smoke test: loads script.js in a stubbed DOM and exercises the simulation.
// Verifies: no exceptions, red-light enforcement, queue spacing, metric sanity.
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
  const e = {
    id, width: 680, height: 680, style: {}, dataset: {},
    textContent: '', className: '', innerHTML: '', value: '',
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    getContext: () => ctxStub,
    addEventListener: noop, dispatchEvent: noop, appendChild: noop,
    querySelectorAll: () => [],
  };
  els[id] = e;
  return e;
}
el('modeSelect').value = 'adaptive';
el('trafficSelect').value = 'normal';
el('speedRange').value = '1';

const sandbox = {
  console, Math, Date, JSON, Uint8Array, requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop, performance: { now: () => Date.now() },
  setTimeout, clearTimeout, Event: class { constructor(t) { this.type = t; } },
  document: {
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener: noop,
  },
  globalThis: null,
};
sandbox.globalThis = sandbox;
const ctxObj = vm.createContext(sandbox);

const probe = `
;globalThis.__probe = {
  get state(){return state}, set state(v){state=v},
  tick, fresh, spawnEmergency, callPedestrian, buildSchedules,
  get seed(){return seed}, set seed(v){seed=v},
  STOP_LINE, MIN_GAP, CONN, IDS, SPAWNS, HORIZON, YELLOW_DURATION
};`;

vm.runInContext(src + probe, ctxObj, { filename: 'script.js' });
const P = sandbox.__probe;
const { STOP_LINE, MIN_GAP, IDS, CONN } = P;

const DIRS = ['N', 'E', 'S', 'W'];
const fails = [];
const notes = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

function invariants(tag) {
  const s = P.state;
  check(Number.isFinite(s.t), `${tag}: sim clock is NaN/Infinity`);
  check(s.globalServed >= 0 && Number.isFinite(s.globalTotalWait), `${tag}: corrupt network metrics`);
  for (const id of IDS) {
    const st = s.intersections[id];
    check(['green', 'yellow'].includes(st.signalState), `${tag}: ${id} invalid signal state "${st.signalState}"`);
    check(st.phase >= 0 && st.phase < 4, `${tag}: ${id} invalid phase ${st.phase}`);
    check(st.amberTimer >= 0 && st.phaseTime >= 0, `${tag}: ${id} negative timer`);
    // red-light enforcement: a non-committed, non-exiting vehicle must never sit past the stop line
    for (const v of st.vehicles) {
      const green = st.signalState === 'green' && st.phase === DIRS.indexOf(v.d);
      if (!green && !v.committed && !v.exiting) {
        check(v.pos <= STOP_LINE + 1e-6, `${tag}: ${id} ${v.d} vehicle pos ${v.pos.toFixed(2)} past stop line ${STOP_LINE} on red`);
      }
      check(Number.isFinite(v.pos), `${tag}: ${id} vehicle pos NaN`);
      check(v.wait >= 0 && v.tripWait >= 0, `${tag}: ${id} negative wait`);
    }
    // spacing on each approach among queued (non-committed) vehicles
    for (const d of DIRS) {
      const lane = st.vehicles.filter(v => v.d === d && !v.committed && !v.exiting && !v.passed)
        .sort((a, b) => b.pos - a.pos);
      for (let i = 1; i < lane.length; i++) {
        const gap = lane[i - 1].pos - lane[i].pos;
        check(gap >= MIN_GAP - 0.01, `${tag}: ${id} ${d} overlap gap ${gap.toFixed(2)} < ${MIN_GAP}`);
      }
      const q = st.queues[d].length;
      check(q >= 0, `${tag}: ${id} ${d} negative queue`);
      check(q <= st.vehicles.filter(v => v.d === d).length, `${tag}: ${id} ${d} queue (${q}) exceeds vehicles in lane`);
    }
  }
}

function run(mode, profile, steps, tag) {
  P.seed = 42;
  el('modeSelect').value = mode;
  el('trafficSelect').value = profile;
  P.fresh();
  P.state.mode = mode;
  for (let i = 0; i < steps; i++) {
    P.tick(0.05);
    if (i % 500 === 0) invariants(`${tag}@step${i}`);
  }
  invariants(tag);
  const s = P.state;
  const active = IDS.reduce((a, id) => a + s.intersections[id].vehicles.length, 0);
  const maxQ = Math.max(...IDS.map(id => Math.max(...DIRS.map(d => s.intersections[id].maxQueue || 0))));
  return {
    mode, profile, t: +s.t.toFixed(1), served: s.globalServed, active,
    avgWait: s.globalServed ? +(s.globalTotalWait / s.globalServed).toFixed(2) : 0,
    maxQueueSeen: s.globalMaxQueue,
  };
}

const results = [];
try {
  results.push(run('adaptive', 'normal', 4000, 'adaptive-normal'));
  results.push(run('fixed', 'normal', 4000, 'fixed-normal'));
  results.push(run('adaptive', 'rush', 4000, 'adaptive-rush'));
  results.push(run('fixed', 'rush', 4000, 'fixed-rush'));
  results.push(run('adaptive', 'easy-heavy', 4000, 'adaptive-easy-heavy'));
  notes.push('6 scenario runs completed without throwing');
} catch (e) {
  fails.push('EXCEPTION: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

// emergency + pedestrian paths
try {
  P.seed = 42; el('modeSelect').value = 'adaptive'; el('trafficSelect').value = 'rush'; P.fresh();
  for (let i = 0; i < 600; i++) P.tick(0.05);
  P.spawnEmergency();
  for (let i = 0; i < 200; i++) { P.tick(0.05); if (i % 50 === 0) invariants(`emergency@${i}`); }
  P.callPedestrian();
  for (let i = 0; i < 400; i++) { P.tick(0.05); if (i % 50 === 0) invariants(`ped@${i}`); }
  invariants('emergency+ped final');
  notes.push('emergency dispatch + pedestrian call paths completed without throwing');
} catch (e) {
  fails.push('EXCEPTION (emergency/ped): ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

// determinism: identical seed must give identical results
function fingerprint(mode, profile) {
  P.seed = 42; el('modeSelect').value = mode; el('trafficSelect').value = profile;
  P.fresh(); P.state.mode = mode;
  for (let i = 0; i < 2000; i++) P.tick(0.05);
  const s = P.state;
  const veh = IDS.map(id => s.intersections[id].vehicles.map(v => `${v.id}:${v.d}:${v.pos.toFixed(3)}`).join(',')).join('|');
  return `${s.globalServed}|${s.globalTotalWait.toFixed(4)}|${veh}`;
}
for (const [mode, profile] of [['adaptive', 'normal'], ['fixed', 'rush'], ['adaptive', 'easy-heavy']]) {
  const a = fingerprint(mode, profile), b = fingerprint(mode, profile);
  if (a === b) notes.push(`deterministic RUN1==RUN2 for ${mode}/${profile}`);
  else fails.push(`NON-DETERMINISTIC: ${mode}/${profile} differs between identical runs (seed 42)`);
}

console.log('=== RESULTS ===');
for (const r of results) console.log(JSON.stringify(r));
console.log('=== NOTES ===');
for (const n of notes) console.log('  ok: ' + n);
console.log('=== FAILURES (' + fails.length + ') ===');
for (const f of fails.slice(0, 40)) console.log('  FAIL: ' + f);
console.log(fails.length ? 'STATUS: FAIL' : 'STATUS: PASS');
process.exit(fails.length ? 1 : 0);
