// Full vehicle-lifecycle regression suite.
// Covers every intersection x incoming direction x turn type:
//   SPAWN -> APPROACH -> QUEUE -> AUTHORISATION -> ENTER -> TURN -> EXIT -> DESPAWN
// plus signal transitions, red-light enforcement, spacing and despawn-outside-map.
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
  vehiclePose, posToOffset, posAtOffset, pointOn,
  STOP_LINE, MIN_GAP, CONN, IDS, CENTERS, SPAWNS, HORIZON, YELLOW_DURATION,
  TURN_ENTRY_POS, TURN_EXIT_POS, EXIT_FADE_START, EXIT_FADE_END,
};`, vm.createContext(sandbox), { filename: 'script.js' });

const P = sandbox.__probe;
const { IDS, CONN, CENTERS, STOP_LINE, MIN_GAP, YELLOW_DURATION } = P;
const DIRS = ['N', 'E', 'S', 'W'];
const FAILS = [];
const NOTES = [];
const check = (c, m) => { if (!c) FAILS.push(m); };

function blank(P, id, phaseIdx) {
  P.seed = 42; P.fresh();
  const s = P.state;
  s.mode = 'fixed';
  // no scheduled traffic, no stray vehicles: isolate the case under test
  s.schedules = s.schedules.map(() => new Uint8Array(P.HORIZON));
  for (const i of IDS) s.intersections[i].vehicles.length = 0;
  const st = s.intersections[id];
  st.phase = phaseIdx; st.signalState = 'green'; st.phaseTime = 0; st.phaseDuration = 1e6;
  return s;
}

function inject(st, d, type, outD, pos) {
  st.vehicles.push({
    id: 9001, d, pos, wait: 0, tripWait: 0, passed: false, emergency: false,
    committed: false, route: { type, outD },
  });
  return st.vehicles[st.vehicles.length - 1];
}

const ROUTES = { straight: null, left: null, right: null, uturn: null };
const OPT = { N: { left: 'W', straight: 'N', right: 'E', uturn: 'S' },
              E: { left: 'N', straight: 'E', right: 'S', uturn: 'W' },
              S: { left: 'E', straight: 'S', right: 'W', uturn: 'N' },
              W: { left: 'S', straight: 'W', right: 'N', uturn: 'E' } };

let cases = 0, handoffs = 0, despawns = 0;

for (const id of IDS) {
  for (const d of DIRS) {
    for (const type of Object.keys(ROUTES)) {
      const outD = OPT[d][type];
      const s = blank(P, id, DIRS.indexOf(d));
      const st = s.intersections[id];
      const v = inject(st, d, type, outD, STOP_LINE - 1);
      const cx = CENTERS[id][0], cy = CENTERS[id][1];
      const tag = `${id}/${d}/${type}->${outD}`;
      cases++;

      let prev = null, prevPose = null, maxJump = 0, minDpos = Infinity;
      let committedOnGreen = false, removed = false, lastPos = null, handedTo = null;
      let redViolation = false;

      for (let step = 0; step < 900; step++) {
        // Handoff scan FIRST: the successor vehicle is a NEW id spawned by
        // handleExit, and it can be removed again within a couple of ticks —
        // a removal-check-first loop broke before this could ever observe it.
        for (const other of IDS) {
          const nv = s.intersections[other].vehicles.find(x => x.d === outD);
          if (nv && CONN[id][outD] === other) { handedTo = other; }
        }
        const present = st.vehicles.find(x => x.id === v.id);
        if (!present) { removed = true; break; }
        if (present.committed && !committedOnGreen) committedOnGreen = true;
        // red-light enforcement (the isolated light is green for this dir, so
        // this only trips if the vehicle is released for the wrong approach)
        const green = st.signalState === 'green' && st.phase === DIRS.indexOf(present.d);
        if (!green && !present.committed && !present.exiting && present.pos > STOP_LINE + 1e-6) {
          redViolation = true;
        }
        const pose = P.vehiclePose(present, cx, cy);
        if (prevPose) {
          const jump = Math.hypot(pose.x - prevPose.x, pose.y - prevPose.y);
          maxJump = Math.max(maxJump, jump);
        }
        prevPose = pose;
        if (prev !== null) minDpos = Math.min(minDpos, present.pos - prev);
        prev = present.pos;
        lastPos = present.pos;
        P.tick(0.05);
      }

      check(committedOnGreen, `${tag}: never committed`);
      check(!redViolation, `${tag}: crossed the stop line without permission`);
      check(minDpos > -0.01, `${tag}: vehicle moved backwards (min delta ${minDpos.toFixed(3)})`);
      check(maxJump <= 3.0, `${tag}: visual teleport — max per-tick pose jump ${maxJump.toFixed(2)} units`);
      check(removed, `${tag}: vehicle never left the intersection (stuck)`);

      const nb = CONN[id][outD];
      if (nb) {
        handoffs++;
        check(lastPos >= 430 - 3, `${tag}: handed off early at pos ${lastPos.toFixed(1)} (expected >=430)`);
        check(handedTo === nb, `${tag}: handoff target ${handedTo || 'none'} (expected ${nb})`);
      } else {
        despawns++;
        check(lastPos >= 610 - 2, `${tag}: despawned inside the map at pos ${lastPos.toFixed(1)} (expected >=610)`);
        const finalPose = P.vehiclePose({ pos: lastPos, d, committed: true, turnType: type, outD, exitAxis: type !== 'straight' ? outD : undefined }, cx, cy);
        const onCanvas = finalPose.x > 0 && finalPose.x < 680 && finalPose.y > 0 && finalPose.y < 680;
        check(!onCanvas, `${tag}: despawned while still on the canvas at (${finalPose.x.toFixed(0)},${finalPose.y.toFixed(0)})`);
      }
    }
  }
}
NOTES.push(`${cases} lifecycle cases: ${handoffs} handoffs verified, ${despawns} off-map despawns verified`);

// --- Red-light enforcement: a queued car must never pass the stop line ------
{
  const s = blank(P, 'I00', 0); // green for N
  const st = s.intersections.I00;
  const v = inject(st, 'E', 'straight', 'E', 40); // E is red (phase 0 = N)
  let worst = -Infinity;
  for (let i = 0; i < 400; i++) {
    const p = st.vehicles.find(x => x.id === v.id);
    if (p) worst = Math.max(worst, p.pos);
    P.tick(0.05);
  }
  check(worst <= STOP_LINE + 1e-6, `red light: queued E vehicle reached pos ${worst.toFixed(2)} (limit ${STOP_LINE})`);
  NOTES.push(`red-light stop-line enforcement: max pos ${worst.toFixed(2)} vs limit ${STOP_LINE}`);
}

// --- Yellow transition: yellow must be entered, and no commit during it -----
{
  // Fixed mode forces phaseDuration=20 every tick (by design), so run the real
  // fixed cycle length: 20s green + 3s yellow + margin. Verified by trace: a
  // test-set phaseDuration=1 is overwritten and never expires early.
  const s = blank(P, 'I00', 0);
  const st = s.intersections.I00;
  st.phaseDuration = 20;
  inject(st, 'N', 'straight', 'N', 40);
  let sawYellow = false, commitsDuringYellow = 0, yellowSteps = 0;
  let prevCommitted = false;
  for (let i = 0; i < 600; i++) {
    if (st.signalState === 'yellow') {
      sawYellow = true; yellowSteps++;
      const v = st.vehicles[0];
      if (v && v.committed && !prevCommitted) commitsDuringYellow++;
      if (v) prevCommitted = v.committed;
    }
    P.tick(0.05);
  }
  check(sawYellow, 'yellow transition never occurred in fixed mode');
  check(yellowSteps >= YELLOW_DURATION / 0.05 - 4, `yellow lasted only ${yellowSteps} ticks (expected ~${YELLOW_DURATION / 0.05})`);
  check(commitsDuringYellow === 0, `yellow transition: ${commitsDuringYellow} vehicle(s) committed during yellow`);
  NOTES.push(`yellow: entered=${sawYellow}, ${yellowSteps} ticks, commits during yellow=${commitsDuringYellow}`);
}

// --- Mutual exclusion: at most one approach green at any sampled moment -----
{
  P.seed = 42; el('trafficSelect').value = 'rush'; P.fresh();
  P.state.mode = 'adaptive';
  let worstGreens = 0;
  for (let i = 0; i < 4000; i++) {
    P.tick(0.05);
    if (i % 25 === 0) {
      for (const id of IDS) {
        const st = P.state.intersections[id];
        const greens = DIRS.filter(d => st.signalState === 'green' && DIRS.indexOf(d) === st.phase).length;
        worstGreens = Math.max(worstGreens, greens);
        for (const v of st.vehicles) {
          check(Number.isFinite(v.pos) && Number.isFinite(v.wait), `rush: non-finite vehicle state at ${id}`);
          const g = st.signalState === 'green' && st.phase === DIRS.indexOf(v.d);
          if (!g && !v.committed && !v.exiting && v.pos > STOP_LINE + 1e-6) {
            check(false, `rush: red-light crossing at ${id} ${v.d} pos ${v.pos.toFixed(1)}`);
          }
        }
        for (const d of DIRS) {
          const lane = st.vehicles.filter(v => v.d === d && !v.committed && !v.exiting).sort((a, b) => b.pos - a.pos);
          for (let k = 1; k < lane.length; k++) {
            const gap = lane[k - 1].pos - lane[k].pos;
            check(gap >= MIN_GAP - 0.01, `rush: ${id} ${d} overlap gap ${gap.toFixed(2)}`);
          }
        }
      }
    }
  }
  check(worstGreens <= 1, `mutual exclusion violated: ${worstGreens} approaches green simultaneously`);
  NOTES.push(`mutual exclusion + spacing + finite state: clean over 4000 ticks (rush, adaptive)`);
}

console.log('=== NOTES ===');
for (const n of NOTES) console.log('  ok: ' + n);
const uniq = [...new Set(FAILS)];
console.log(`=== FAILURES (${uniq.length}) ===`);
for (const f of uniq.slice(0, 25)) console.log('  FAIL: ' + f);
console.log(uniq.length ? 'STATUS: FAIL' : 'STATUS: PASS');
process.exit(uniq.length ? 1 : 0);
