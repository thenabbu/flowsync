// FlowSync Map Engine — adaptive traffic controller for real Cyber City OSM graph.
// Port of script.js algorithm to real junctions + graph traversal.
// Pure JS, no deps. Exposes window.flowEngine.

(function () {
  'use strict';

  // ── Constants (from script.js) ──────────────────────────────────────────
  var YELLOW_DURATION = 3;
  var PED_DURATION = 5;
  var PED_CHANCE = 0.0012;
  var STOP_LINE = 124;
  var HORIZON = 24000;
  var EXIT_DISTANCE = 430;
  var JUNCTION_APPROACH = 100;
  var JUNCTION_QUEUED_MAX = 250;

  // ── State ───────────────────────────────────────────────────────────────
  var state = null;
  var graph = null;
  var graphNodes = {};
  var bidirectionalAdj = {};
  var junctionData = [];
  var junctionPaths = {};
  var neighborToJunction = {};
  var nextIdCounter = 1;
  var loaded = false;
  var graphCenterLat = 0, graphCenterLon = 0;

  // ── Helpers ─────────────────────────────────────────────────────────────
  function lcg(s0) {
    var s = s0 >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    var dlat = lat2 - lat1, dlon = lon2 - lon1;
    return (Math.atan2(dlon, dlat) * 180 / Math.PI + 360) % 360;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Graph loading ───────────────────────────────────────────────────────
  function buildBidirectional(adj) {
    var bd = {};
    var keys = Object.keys(adj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = adj[k];
      var ki = Number(k);
      if (!bd[ki]) bd[ki] = [];
      for (var j = 0; j < v.length; j++) {
        var nb = v[j];
        if (!bd[nb]) bd[nb] = [];
        if (bd[ki].indexOf(nb) === -1) bd[ki].push(nb);
        if (bd[nb].indexOf(ki) === -1) bd[nb].push(ki);
      }
    }
    return bd;
  }

  // Classify junction neighbors into two perpendicular groups (phase 0 / phase 1).
  // Sort by bearing, find largest angular gap, split there.
  // For degenerate cases (2 neighbors = straight road), put one in each group.
  function classifyGroups(neighbors, jLat, jLon) {
    if (neighbors.length === 0) return [[], []];
    var bearings = neighbors.map(function (nbId) {
      var nb = graphNodes[nbId];
      if (!nb) return { id: nbId, angle: 0 };
      return { id: nbId, angle: bearingDeg(jLat, jLon, nb.lat, nb.lon) };
    });
    bearings.sort(function (a, b) { return a.angle - b.angle; });

    var n = bearings.length;
    if (n === 1) return [[bearings[0].id], []];
    if (n === 2) {
      // Straight road or perpendicular: just split 1 vs 1
      return [[bearings[0].id], [bearings[1].id]];
    }
    // 3+ neighbors: find max gap, split there
    var maxGap = 0, splitAfter = 0;
    for (var i = 0; i < n; i++) {
      var gap = ((bearings[(i + 1) % n].angle - bearings[i].angle) + 360) % 360;
      if (gap > maxGap) { maxGap = gap; splitAfter = i; }
    }
    var g0 = [], g1 = [];
    for (var i = 0; i < n; i++) {
      if (i <= splitAfter) g0.push(bearings[i].id);
      else g1.push(bearings[i].id);
    }
    return [g0, g1];
  }

  // Pre-compute local neighborhood around each junction: nodes within ~200m.
  function buildLocalNeighborhood(junctionNodeId, maxDist) {
    var result = {};
    var jn = graphNodes[junctionNodeId];
    if (!jn) return result;
    var queue = [junctionNodeId];
    result[junctionNodeId] = 0;
    while (queue.length > 0) {
      var cur = queue.shift();
      var curDist = result[cur];
      var nbs = bidirectionalAdj[cur] || [];
      for (var i = 0; i < nbs.length; i++) {
        var nb = nbs[i];
        if (result[nb] !== undefined) continue;
        var nbNode = graphNodes[nb];
        if (!nbNode) continue;
        var curNode = graphNodes[cur];
        var edgeLen = haversineM(curNode.lat, curNode.lon, nbNode.lat, nbNode.lon);
        var newDist = curDist + edgeLen;
        if (newDist > maxDist) continue;
        result[nb] = newDist;
        queue.push(nb);
      }
    }
    return result;
  }

  // ── Fresh intersection state (mirrors script.js freshIntersection) ──────
  function freshIntersection() {
    return {
      phase: 0, phaseTime: 0, phaseDuration: 20,
      signalState: 'green', amberTimer: 0,
      queues: {}, vehicles: [], served: 0, totalWait: 0, maxQueue: 0,
      lastDecision: 'Waiting to start', preempting: false,
      pedestrian: { active: false, timer: 0, side: null },
      history: [],
      phaseGroups: [[], []],  // neighbor node IDs for phase 0 and phase 1
      approachDirs: {}        // neighborId -> 'phase0' or 'phase1'
    };
  }

  function phaseName(iState) {
    return iState.phase === 0 ? 'Phase-A' : 'Phase-B';
  }

  function getApproachDir(jIdx, neighborId) {
    var j = junctionData[jIdx];
    return j.approachDirs[neighborId] || null;
  }

  function greenFor(jIdx, iState, dir) {
    // dir is a neighbor node ID; check if it belongs to current phase's group
    if (iState.signalState !== 'green') return false;
    var groups = iState.phaseGroups;
    if (iState.phase === 0) return groups[0].indexOf(dir) !== -1;
    return groups[1].indexOf(dir) !== -1;
  }

  function effectiveGreen(jIdx, iState, dir) {
    if (iState.pedestrian && iState.pedestrian.active) return false;
    return greenFor(jIdx, iState, dir);
  }

  function queueCount(iState, dir) {
    return (iState.queues[dir] || []).length;
  }

  function totalQueue(iState) {
    var s = 0;
    var keys = Object.keys(iState.queues);
    for (var i = 0; i < keys.length; i++) s += iState.queues[keys[i]].length;
    return s;
  }

  // ── Schedules ───────────────────────────────────────────────────────────
  function buildSchedules(profile, baseSeed) {
    return junctionData.map(function (j, idx) {
      var rnd = lcg((baseSeed + idx * 7919) >>> 0);
      var neighbors = bidirectionalAdj[j.nodeId] || [];
      // Pick spawn neighbors: the ones furthest from graph center
      var spawnNeighbors = neighbors.slice().sort(function (a, b) {
        var na = graphNodes[a], nb2 = graphNodes[b];
        var da = Math.abs(na.lat - graphCenterLat) + Math.abs(na.lon - graphCenterLon);
        var db = Math.abs(nb2.lat - graphCenterLat) + Math.abs(nb2.lon - graphCenterLon);
        return db - da;
      });
      // Use top 2 spawn directions per junction
      var spawnDirs = spawnNeighbors.slice(0, Math.min(2, spawnNeighbors.length));
      // Rate per direction
      var rates = spawnDirs.map(function (nbId) {
        var nb2 = graphNodes[nbId];
        // Rough direction based on bearing from center
        var bearing = bearingDeg(graphCenterLat, graphCenterLon, nb2.lat, nb2.lon);
        // East-heavy: boost bearings near 90 (east)
        if (profile === 'rush') return 0.85;
        if (profile === 'imbalanced') {
          if (bearing > 45 && bearing < 135) return 0.95;
          if (bearing > 225 && bearing < 315) return 0.65;
          return 0.25;
        }
        return 0.22;
      });

      var arr = new Uint8Array(HORIZON);
      for (var t = 0; t < HORIZON; t++) {
        for (var d = 0; d < spawnDirs.length; d++) {
          if (rnd() < rates[d] * 0.05 * 0.75) arr[t] |= (1 << d);
        }
      }
      return { dirs: spawnDirs, arr: arr };
    });
  }

  // ── Vehicle management ──────────────────────────────────────────────────
  function addVehicle(jIdx, toNeighborId, delay, emergency, tripWait) {
    delay = delay || 0;
    emergency = !!emergency;
    tripWait = tripWait || 0;
    var j = junctionData[jIdx];
    var nbNode = graphNodes[toNeighborId];
    var jNode = graphNodes[j.nodeId];
    // Vehicle starts before the junction, heading toward it
    var edgeLen = haversineM(nbNode.lat, nbNode.lon, jNode.lat, jNode.lon);
    var iState = state.intersections[jIdx];
    iState.vehicles.push({
      id: nextIdCounter++,
      fromJunction: jIdx,
      direction: toNeighborId,   // neighbor node ID we're heading toward junction FROM
      pos: -(STOP_LINE + delay * 22),
      maxDistance: edgeLen,
      wait: 0, tripWait: tripWait,
      passed: false, emergency: emergency,
      committed: false,
      edgePath: [],
      lat: 0, lon: 0  // computed during tick
    });
  }

  // ── Pathfinding (BFS shortest on full graph) ──────────────────────────
  // ponytail: BFS with parent map instead of full path copies — O(V+E) not O(V*E)
  function findPath(fromNodeId, toNodeId, maxDepth) {
    maxDepth = maxDepth || 200;
    if (fromNodeId === toNodeId) return [fromNodeId];
    var visited = {};
    visited[fromNodeId] = true;
    var parent = {};
    var queue = [fromNodeId];
    var depth = {};
    depth[fromNodeId] = 0;
    while (queue.length > 0) {
      var cur = queue.shift();
      if (depth[cur] >= maxDepth) continue;
      var nbs = bidirectionalAdj[cur] || [];
      for (var i = 0; i < nbs.length; i++) {
        var nb = nbs[i];
        if (visited[nb]) continue;
        visited[nb] = true;
        parent[nb] = cur;
        depth[nb] = depth[cur] + 1;
        if (nb === toNodeId) {
          // Reconstruct path
          var path = [];
          var node = nb;
          while (node !== undefined) {
            path.unshift(node);
            node = parent[node];
          }
          return path;
        }
        queue.push(nb);
      }
    }
    return null;
  }

  // ── Controller (port of script.js controllerFor) ────────────────────────
  function controllerFor(jIdx) {
    var iState = state.intersections[jIdx];
    if (iState.preempting || iState.signalState === 'yellow') return;

    var groups = iState.phaseGroups;
    var active = 0, other = 0;
    for (var i = 0; i < groups[0].length; i++) active += queueCount(iState, groups[0][i]);
    for (var i = 0; i < groups[1].length; i++) other += queueCount(iState, groups[1][i]);

    if (iState.phase === 0) {
      // active = group0, other = group1
    } else {
      var tmp = active; active = other; other = tmp;
    }

    if (state.mode === 'fixed') { iState.phaseDuration = 20; return; }

    iState.phaseDuration = clamp(10, 10 + active * 1.8, 30);

    if (iState.phaseTime >= 10 && other > active * 1.35) {
      var activeName = iState.phase === 0 ? 'A' : 'B';
      var otherName = iState.phase === 0 ? 'B' : 'A';
      iState.signalState = 'yellow';
      iState.amberTimer = 0;
      iState.lastDecision = activeName + ' yielding — yellow before switching to ' + otherName + '.';
      state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
      state.logs = state.logs.slice(0, 20);
      state.decisions.unshift({
        id: jIdx, type: 'switch', t: state.t,
        reasoning: otherName + ' queue (' + other + ') is ' + (other / Math.max(1, active)).toFixed(2) +
          '× the ' + activeName + ' queue (' + active + '), past 1.35× threshold after 10s min green → yellow.',
        text: '[' + jIdx + '] ' + iState.lastDecision
      });
      state.decisions = state.decisions.slice(0, 8);
    }
  }

  // ── Handle vehicle exit (port of script.js handleExit) ──────────────────
  function handleExit(jIdx, v) {
    var iState = state.intersections[jIdx];
    iState.served++;
    iState.totalWait += v.wait;

    // Find next junction using precomputed neighbor->junction mapping
    var reachable = (neighborToJunction[jIdx] || {})[v.direction] || [];
    var nextJunction = reachable.length > 0 ? reachable[0] : -1;

    if (nextJunction >= 0) {
      // Hand off to next junction: vehicle enters from the direction of jIdx
      var nj = junctionData[nextJunction];
      // Find which neighbor of next junction connects back toward jIdx
      var nbs = bidirectionalAdj[nj.nodeId] || [];
      var entryNeighbor = -1;
      for (var i = 0; i < nbs.length; i++) {
        var path = findPath(nbs[i], junctionData[jIdx].nodeId, 30);
        if (path && path.length <= 8) {
          entryNeighbor = nbs[i];
          break;
        }
      }
      if (entryNeighbor >= 0) {
        var niState = state.intersections[nextJunction];
        niState.vehicles.push({
          id: v.id,
          fromJunction: nextJunction,
          direction: entryNeighbor,
          pos: -(STOP_LINE),
          maxDistance: 200,
          wait: 0, tripWait: v.tripWait,
          passed: false, emergency: v.emergency,
          committed: false,
          edgePath: [],
          lat: 0, lon: 0
        });
      } else {
        state.globalServed++;
        state.globalTotalWait += v.tripWait;
      }
    } else {
      state.globalServed++;
      state.globalTotalWait += v.tripWait;
    }
  }

  // ── Tick ────────────────────────────────────────────────────────────────
  function tick(dt) {
    if (!loaded) return;
    state.t += dt;
    var step = state.stepIndex++;

    // Spawn vehicles from schedules
    for (var j = 0; j < junctionData.length; j++) {
      var sched = state.schedules[j];
      if (!sched || step >= HORIZON) continue;
      var bits = sched.arr[step];
      for (var d = 0; d < sched.dirs.length; d++) {
        if (bits & (1 << d)) {
          addVehicle(j, sched.dirs[d], 0, false, 0);
        }
      }
    }

    // Process each junction
    for (var jIdx = 0; jIdx < junctionData.length; jIdx++) {
      var iState = state.intersections[jIdx];
      iState.phaseTime += dt;

      // Signal controller
      if (!iState.preempting && !iState.pedestrian.active) {
        if (iState.signalState === 'yellow') {
          iState.amberTimer += dt;
          if (iState.amberTimer >= YELLOW_DURATION) {
            iState.phase = 1 - iState.phase;
            iState.phaseTime = 0;
            iState.signalState = 'green';
            iState.amberTimer = 0;
            var groups = iState.phaseGroups;
            var active = 0;
            var activeGroup = iState.phase === 0 ? groups[0] : groups[1];
            for (var g = 0; g < activeGroup.length; g++) active += queueCount(iState, activeGroup[g]);
            iState.phaseDuration = clamp(10, 10 + active * 1.8, 30);
            iState.lastDecision = 'Phase changed to ' + phaseName(iState) + '.';
            state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
            state.logs = state.logs.slice(0, 20);
          }
        } else {
          if (iState.phaseTime >= iState.phaseDuration) {
            iState.signalState = 'yellow';
            iState.amberTimer = 0;
            iState.lastDecision = phaseName(iState) + ' ending — yellow, then switching.';
            state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
            state.logs = state.logs.slice(0, 20);
          }
          controllerFor(jIdx);
        }
      }

      // Move vehicles
      for (var vi = 0; vi < iState.vehicles.length; vi++) {
        var v = iState.vehicles[vi];
        if (v.passed) continue;

        var green = effectiveGreen(jIdx, iState, v.direction);
        if (!v.committed && green && v.pos >= STOP_LINE - 2) {
          v.committed = true;
        }
        var speed = (green || v.committed) ? 0.95 : 0;
        var nextPos = v.pos + speed * dt * 35;
        if (!v.committed && !green) {
          v.pos = Math.min(v.pos, STOP_LINE);
        } else {
          v.pos = nextPos;
        }
        if (!v.committed && !green && v.pos >= STOP_LINE) v.pos = STOP_LINE;
        if (v.committed && v.pos >= EXIT_DISTANCE) {
          v.passed = true;
          handleExit(jIdx, v);
          continue;
        }
        if (v.pos >= JUNCTION_APPROACH && !green && !v.committed) {
          v.wait += dt;
          v.tripWait += dt;
        }
      }

      iState.vehicles = iState.vehicles.filter(function (v) { return !v.passed; });

      // Update queues
      var groups = iState.phaseGroups;
      var allDirs = groups[0].concat(groups[1]);
      iState.queues = {};
      for (var d = 0; d < allDirs.length; d++) {
        var dir = allDirs[d];
        iState.queues[dir] = iState.vehicles.filter(function (v) {
          return v.direction === dir && v.pos > JUNCTION_APPROACH && v.pos < JUNCTION_QUEUED_MAX && !v.passed;
        });
      }
      var maxQ = 0;
      for (var d = 0; d < allDirs.length; d++) {
        var qLen = queueCount(iState, allDirs[d]);
        if (qLen > maxQ) maxQ = qLen;
      }
      iState.maxQueue = Math.max(iState.maxQueue, maxQ);

      iState.history.push({ t: state.t, q: totalQueue(iState) });
      if (iState.history.length > 160) iState.history.shift();

      // Emergency preemption
      var emVeh = null;
      for (var vi = 0; vi < iState.vehicles.length; vi++) {
        if (iState.vehicles[vi].emergency && !iState.vehicles[vi].passed) {
          emVeh = iState.vehicles[vi]; break;
        }
      }
      if (emVeh && iState.pedestrian.active) {
        iState.pedestrian.active = false;
        iState.pedestrian.timer = 0;
        iState.lastDecision = '🚶 Pedestrian crossing cut short — emergency vehicle approaching.';
        state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
        state.logs = state.logs.slice(0, 20);
        state.decisions.unshift({
          id: jIdx, type: 'ped-clear', t: state.t,
          reasoning: 'Emergency vehicle detected — walk phase ended early.',
          text: '[' + jIdx + '] ' + iState.lastDecision
        });
        state.decisions = state.decisions.slice(0, 8);
      }
      if (emVeh) {
        // Force green for emergency vehicle's approach
        var groups = iState.phaseGroups;
        var reqPhase = (groups[0].indexOf(emVeh.direction) !== -1) ? 0 : 1;
        if (iState.phase !== reqPhase || iState.signalState !== 'green') {
          iState.phase = reqPhase;
          iState.phaseTime = 0;
          iState.signalState = 'green';
          iState.amberTimer = 0;
        }
        if (!iState.preempting) {
          iState.preempting = true;
          iState.lastDecision = '🚨 Preemption — forcing ' + phaseName(iState) + ' for emergency vehicle.';
          state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
          state.logs = state.logs.slice(0, 20);
          state.decisions.unshift({
            id: jIdx, type: 'preempt', t: state.t,
            reasoning: 'Emergency vehicle detected — adaptive control suspended, immediate green forced.',
            text: '[' + jIdx + '] ' + iState.lastDecision
          });
          state.decisions = state.decisions.slice(0, 8);
        }
        // Pre-clear downstream
        if (emVeh.pos > 320) {
          var reachable = (neighborToJunction[jIdx] || {})[emVeh.direction] || [];
          var downJunction = reachable.length > 0 ? reachable[0] : -1;
          if (downJunction >= 0) {
            var ns2 = state.intersections[downJunction];
            if (!ns2.preempting) {
              ns2.preempting = true;
              var groups2 = ns2.phaseGroups;
              ns2.phase = (groups2[0].indexOf(emVeh.direction) !== -1) ? 0 : 1;
              ns2.phaseTime = 0;
              ns2.signalState = 'green';
              ns2.amberTimer = 0;
              ns2.lastDecision = '🚨 Pre-clearing ahead of approaching emergency vehicle.';
              state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + downJunction + '] ' + ns2.lastDecision);
              state.logs = state.logs.slice(0, 20);
              var eta = ((EXIT_DISTANCE - emVeh.pos) / (0.95 * 35)).toFixed(1);
              state.decisions.unshift({
                id: downJunction, type: 'preempt', t: state.t,
                reasoning: 'Emergency vehicle inbound from ' + jIdx + ' (ETA ~' + eta + 's) — pre-clearing corridor.',
                text: '[' + downJunction + '] ' + ns2.lastDecision
              });
              state.decisions = state.decisions.slice(0, 8);
            }
          }
        }
      } else if (iState.preempting) {
        iState.preempting = false;
        iState.phaseTime = 0;
        iState.lastDecision = 'Emergency corridor cleared — resuming normal control.';
        state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
        state.logs = state.logs.slice(0, 20);
        state.decisions.unshift({
          id: jIdx, type: 'resume', t: state.t,
          reasoning: 'No emergency vehicle present — adaptive controller resumed.',
          text: '[' + jIdx + '] ' + iState.lastDecision
        });
        state.decisions = state.decisions.slice(0, 8);
      }

      // Pedestrian
      if (!iState.preempting) {
        if (iState.pedestrian.active) {
          iState.pedestrian.timer += dt;
          if (iState.pedestrian.timer >= PED_DURATION) {
            iState.pedestrian.active = false;
            iState.pedestrian.timer = 0;
            iState.phaseTime = 0;
            iState.lastDecision = 'Crosswalk cleared — vehicles released, signal control resumed.';
            state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
            state.logs = state.logs.slice(0, 20);
            state.decisions.unshift({
              id: jIdx, type: 'ped-clear', t: state.t,
              reasoning: 'Pedestrian finished crossing after ' + PED_DURATION + 's.',
              text: '[' + jIdx + '] ' + iState.lastDecision
            });
            state.decisions = state.decisions.slice(0, 8);
          }
        } else if (Math.random() < PED_CHANCE) {
          triggerPedestrian(jIdx);
        }
      }
    }

    // Global history
    var totalQ = 0;
    for (var j = 0; j < junctionData.length; j++) totalQ += totalQueue(state.intersections[j]);
    state.historyGlobal.push({ t: state.t, q: totalQ });
    if (state.historyGlobal.length > 160) state.historyGlobal.shift();
    state.globalMaxQueue = 0;
    for (var j = 0; j < junctionData.length; j++) {
      if (state.intersections[j].maxQueue > state.globalMaxQueue)
        state.globalMaxQueue = state.intersections[j].maxQueue;
    }
  }

  // ── Public actions ──────────────────────────────────────────────────────
  function triggerPedestrian(jIdx) {
    var iState = state.intersections[jIdx];
    if (iState.preempting || iState.pedestrian.active) return false;
    var groups = iState.phaseGroups;
    var allDirs = groups[0].concat(groups[1]);
    var side = allDirs.length > 0 ? allDirs[Math.floor(Math.random() * allDirs.length)] : 0;
    iState.pedestrian.active = true;
    iState.pedestrian.timer = 0;
    iState.pedestrian.side = side;
    state.pedCount++;
    iState.lastDecision = '🚶 Pedestrian crossing called — all approaches held for ' + PED_DURATION + 's.';
    state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] ' + iState.lastDecision);
    state.logs = state.logs.slice(0, 20);
    state.decisions.unshift({
      id: jIdx, type: 'pedestrian', t: state.t,
      reasoning: 'Walk button pressed at junction ' + jIdx + ' — every approach stops for ' + PED_DURATION + 's.',
      text: '[' + jIdx + '] ' + iState.lastDecision
    });
    state.decisions = state.decisions.slice(0, 8);
    return true;
  }

  function spawnEmergency() {
    var jIdx = Math.floor(Math.random() * junctionData.length);
    var nbs = bidirectionalAdj[junctionData[jIdx].nodeId] || [];
    if (nbs.length === 0) return;
    var dir = nbs[Math.floor(Math.random() * nbs.length)];
    addVehicle(jIdx, dir, 0, true, 0);
    state.logs.unshift('[' + state.t.toFixed(1) + 's] [' + jIdx + '] 🚨 Emergency vehicle dispatched.');
    state.logs = state.logs.slice(0, 20);
    state.decisions.unshift({
      id: jIdx, type: 'dispatch', t: state.t,
      reasoning: 'New emergency vehicle spawned at junction ' + jIdx + '.',
      text: '[' + jIdx + '] 🚨 Emergency vehicle dispatched.'
    });
    state.decisions = state.decisions.slice(0, 8);
  }

  function callPedestrian() {
    var order = [];
    for (var i = 0; i < junctionData.length; i++) order.push(i);
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    var found = false;
    for (var i = 0; i < order.length; i++) {
      if (triggerPedestrian(order[i])) { found = true; break; }
    }
    if (!found) {
      state.logs.unshift('[' + state.t.toFixed(1) + 's] Crosswalk busy or under preemption — try again.');
      state.logs = state.logs.slice(0, 20);
    }
  }

  function getMetrics() {
    return {
      avgWait: state.globalServed ? state.globalTotalWait / state.globalServed : 0,
      maxQueue: state.globalMaxQueue,
      throughput: state.globalServed,
      totalDelay: state.globalTotalWait
    };
  }

  function getDecisions() {
    return state.decisions;
  }

  function getLog() {
    return state.logs;
  }

  function getJunctionState(junctionIndex) {
    return state.intersections[junctionIndex] || null;
  }

  function setMode(m) {
    state.mode = m;
    state.logs.unshift('[' + state.t.toFixed(1) + 's] Mode changed to ' + m);
    state.logs = state.logs.slice(0, 20);
  }

  function setTraffic(t) {
    state.traffic = t;
    var seed = 42;
    state.schedules = buildSchedules(t, seed);
    state.stepIndex = 0;
    state.logs.unshift('[' + state.t.toFixed(1) + 's] Traffic profile changed to ' + t);
    state.logs = state.logs.slice(0, 20);
  }

  function setSpeed(s) {
    state.speed = s;
  }

  function dispatchEmergency() {
    spawnEmergency();
  }

  function freshState(traffic) {
    var seed = 42;
    state = {
      running: false,
      mode: 'adaptive',
      traffic: traffic || 'normal',
      speed: 1,
      t: 0, stepIndex: 0,
      schedules: buildSchedules(traffic || 'normal', seed),
      intersections: [],
      decisions: [], logs: [],
      globalServed: 0, globalTotalWait: 0, globalMaxQueue: 0,
      historyGlobal: [], pedCount: 0
    };
    for (var i = 0; i < junctionData.length; i++) {
      state.intersections.push(freshIntersection());
      state.intersections[i].phaseGroups = junctionData[i].phaseGroups.slice();
      state.intersections[i].approachDirs = Object.assign({}, junctionData[i].approachDirs);
    }
    nextIdCounter = 1;
    // Initial vehicles
    for (var i = 0; i < junctionData.length; i++) {
      var nbs = bidirectionalAdj[junctionData[i].nodeId] || [];
      for (var d = 0; d < Math.min(2, nbs.length); d++) {
        addVehicle(i, nbs[d], d * 0.4, false, 0);
      }
    }
    state.logs.unshift('[' + state.t.toFixed(1) + 's] Simulation reset — Cyber City network online.');
  }

  // ── Initialization ──────────────────────────────────────────────────────
  async function init() {
    try {
      var graphRes = await fetch('./cybercity-graph.json');
      graph = await graphRes.json();
    } catch (e) {
      console.error('FlowSync: failed to load cybercity-graph.json', e);
      return;
    }

    var junctionRes = await fetch('./junctions.json');
    var rawJunctions = await junctionRes.json();

    // Index graph nodes
    for (var i = 0; i < graph.nodes.length; i++) {
      graphNodes[graph.nodes[i].id] = graph.nodes[i];
    }

    // Build bidirectional adjacency
    bidirectionalAdj = buildBidirectional(graph.adjList);

    // Graph center
    var sumLat = 0, sumLon = 0;
    for (var i = 0; i < graph.nodes.length; i++) {
      sumLat += graph.nodes[i].lat;
      sumLon += graph.nodes[i].lon;
    }
    graphCenterLat = sumLat / graph.nodes.length;
    graphCenterLon = sumLon / graph.nodes.length;

    // Process junctions
    junctionData = rawJunctions.map(function (j) {
      var nid = j.nodeId;
      var nbs = bidirectionalAdj[nid] || [];
      var groups = classifyGroups(nbs, j.lat, j.lon);
      var dirs = {};
      for (var i = 0; i < groups[0].length; i++) dirs[groups[0][i]] = 'phase0';
      for (var i = 0; i < groups[1].length; i++) dirs[groups[1][i]] = 'phase1';
      return {
        nodeId: nid, name: j.name,
        lat: j.lat, lon: j.lon,
        neighbors: nbs,
        phaseGroups: groups,
        approachDirs: dirs
      };
    });

    // Pre-computed: for each junction, for each neighbor, which junctions are reachable through that neighbor
  // neighborToJunction[jIdx][neighborId] = [junctionIdx, ...]

  // Pre-compute junction-to-junction paths (BFS once at init, not per tick)
    junctionPaths = {};  // "fromIdx-toIdx" -> { neighborId, pathLen, entryNeighbor }
    for (var i = 0; i < junctionData.length; i++) {
      neighborToJunction[i] = {};
      var nbs = bidirectionalAdj[junctionData[i].nodeId] || [];
      for (var n = 0; n < nbs.length; n++) {
        neighborToJunction[i][nbs[n]] = [];
      }
      for (var j = 0; j < junctionData.length; j++) {
        if (i === j) continue;
        var path = findPath(junctionData[i].nodeId, junctionData[j].nodeId, 200);
        if (path && path.length <= 60) {
          // Find which neighbor of junction i the path starts through
          var firstStep = path[1]; // first node after junction i
          if (firstStep && neighborToJunction[i][firstStep]) {
            neighborToJunction[i][firstStep].push(j);
          }
          // Find which neighbor of junction j the path enters through
          var entryNeighbor = -1;
          var jNbs = bidirectionalAdj[junctionData[j].nodeId] || [];
          for (var n = 0; n < jNbs.length; n++) {
            var subPath = findPath(jNbs[n], junctionData[i].nodeId, 200);
            if (subPath && subPath.length <= 60) {
              entryNeighbor = jNbs[n];
              break;
            }
          }
          junctionPaths[i + '-' + j] = {
            path: path,
            pathLen: path.length,
            entryNeighbor: entryNeighbor
          };
        }
      }
    }

    freshState('normal');
    loaded = true;

    console.log('FlowSync map engine initialized:', junctionData.length, 'junctions,', graph.nodes.length, 'graph nodes');
  }

  // ── Self-test (Node.js) ─────────────────────────────────────────────────
  if (typeof module !== 'undefined' && require.main === module) {
    var fs = require('fs');
    var path = require('path');

    // Mock fetch for Node.js
    var origFetch = global.fetch;
    global.fetch = function (url) {
      var filePath = path.resolve(__dirname, url.replace('./', ''));
      var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Promise.resolve({ json: function () { return Promise.resolve(data); } });
    };

    init().then(function () {
      console.log('=== FlowSync Map Engine Self-Test ===');
      console.log('Junctions:', junctionData.length);
      for (var i = 0; i < junctionData.length; i++) {
        var j = junctionData[i];
        console.log('  [' + i + '] ' + j.name + ': ' + j.neighbors.length + ' neighbors, groups=' +
          JSON.stringify(j.phaseGroups.map(function (g) { return g.length; })));
      }

      // Run 50 ticks
      for (var t = 0; t < 50; t++) tick(0.05);

      console.log('\nAfter 50 ticks (t=' + state.t.toFixed(2) + 's):');
      console.log('  Mode:', state.mode);
      console.log('  Global served:', state.globalServed);
      console.log('  Global total wait:', state.globalTotalWait.toFixed(1));
      console.log('  History entries:', state.historyGlobal.length);

      var allOk = true;
      for (var i = 0; i < state.intersections.length; i++) {
        var ist = state.intersections[i];
        var q = totalQueue(ist);
        console.log('  [' + i + '] phase=' + ist.phase + ' signal=' + ist.signalState +
          ' phaseTime=' + ist.phaseTime.toFixed(1) + ' vehicles=' + ist.vehicles.length +
          ' queue=' + q + ' served=' + ist.served);
        if (!ist.signalState) { allOk = false; console.error('FAIL: junction ' + i + ' has no signalState'); }
      }

      // Assertions
      var assert = function (cond, msg) {
        if (!cond) { allOk = false; console.error('ASSERT FAIL:', msg); }
      };
      assert(state.intersections.length === 4, 'Expected 4 junctions');
      assert(state.t > 0, 'Time should advance');
      assert(state.historyGlobal.length > 0, 'Should have history');
      for (var i = 0; i < state.intersections.length; i++) {
        var ist = state.intersections[i];
        assert(typeof ist.signalState === 'string', 'Junction ' + i + ' has signalState');
        assert(typeof ist.phase === 'number', 'Junction ' + i + ' has phase');
        assert(typeof ist.phaseDuration === 'number', 'Junction ' + i + ' has phaseDuration');
      }

      console.log('\n' + (allOk ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED'));
      process.exit(allOk ? 0 : 1);
    }).catch(function (e) {
      console.error('Self-test failed:', e);
      process.exit(1);
    });
  }

  // ── Expose API ──────────────────────────────────────────────────────────
  var win = typeof window !== 'undefined' ? window : {};
  win.flowEngine = {
    init: init,
    state: function () { return state; },
    junctionData: function () { return junctionData; },
    graphNodes: function () { return graphNodes; },
    tick: tick,
    reset: function () { if (loaded) freshState(state.traffic); },
    getJunctionState: getJunctionState,
    spawnEmergency: spawnEmergency,
    triggerPedestrian: triggerPedestrian,
    getMetrics: getMetrics,
    getDecisions: getDecisions,
    getLog: getLog,
    setMode: setMode,
    setTraffic: setTraffic,
    setSpeed: setSpeed,
    dispatchEmergency: dispatchEmergency,
    callPedestrian: callPedestrian,
    CONN: function () {
      // Return junction connectivity from precomputed paths
      var conn = {};
      for (var i = 0; i < junctionData.length; i++) {
        var c = {};
        for (var j = 0; j < junctionData.length; j++) {
          if (i === j) continue;
          var key = i + '-' + j;
          if (junctionPaths[key]) c[j] = junctionPaths[key].pathLen;
        }
        conn[i] = c;
      }
      return conn;
    }
  };
})();
