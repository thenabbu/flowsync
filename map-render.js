// FlowSync Cyber City — map rendering (vehicles + junction signals on MapLibre).
// Reads from window.flowEngine (map-engine.js) and window.globalState.map (map.js).
(function () {
  'use strict';

  const TICK_MS = 1000 / 60;
  let running = false, simTime = 0;
  let junctions = [], graphIndex = {};
  let map = null;

  const PHASE_COLORS = { green: '#39d98a', red: '#ff5c70', yellow: '#ffc94a' };

  // Vehicle node buffer: reuse same array to avoid GC pressure
  let vehicleFeatures = [];

  async function boot() {
    map = window.globalState?.map;
    if (!map) { console.error('FlowSync render: map not ready'); return; }
    if (!map.loaded()) { map.on('load', () => boot()); return; }

    // Load junction locations
    const jr = await fetch('junctions.json');
    junctions = await jr.json();

    // Engine must be initialized by map.js or we init it ourselves
    const engine = window.flowEngine;
    if (engine?.init) await engine.init();

    // Build graph index from engine's exposed graphNodes
    const gNodes = engine.graphNodes ? engine.graphNodes() : {};
    // gNodes is a map of nodeId -> {id, lat, lon}
    graphIndex = gNodes;

    setupMapLayers();
    setupControls();
    startLoop();
  }

  function setupMapLayers() {
    // Junction markers
    const jf = junctions.map(j => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [j.lon, j.lat] },
      properties: { name: j.name, signalState: 'green' }
    }));
    map.addSource('junctions-src', { type: 'geojson', data: { type: 'FeatureCollection', features: jf } });
    map.addLayer({
      id: 'junction-glow', type: 'circle', source: 'junctions-src',
      paint: { 'circle-radius': 18, 'circle-color': '#39d98a', 'circle-opacity': 0.15 }
    });
    map.addLayer({
      id: 'junction-dot', type: 'circle', source: 'junctions-src',
      paint: { 'circle-radius': 8, 'circle-color': '#39d98a', 'circle-stroke-color': '#0c1322', 'circle-stroke-width': 2 }
    });
    map.addLayer({
      id: 'junction-label', type: 'symbol', source: 'junctions-src',
      layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.8], 'text-anchor': 'top' },
      paint: { 'text-color': '#dfeaf2', 'text-halo-color': '#0c1322', 'text-halo-width': 2 }
    });

    // Vehicle dots
    map.addSource('vehicles-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'vehicle-dot', type: 'circle', source: 'vehicles-src',
      paint: { 'circle-radius': 5, 'circle-color': '#35e0ff', 'circle-stroke-color': '#031318', 'circle-stroke-width': 1 }
    });
    map.addLayer({
      id: 'vehicle-emergency', type: 'circle', source: 'vehicles-src',
      filter: ['==', ['get', 'emergency'], true],
      paint: { 'circle-radius': 7, 'circle-color': '#ff4d6d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }
    });
  }

  // Compute vehicle lat/lon from engine state
  // Vehicle: {fromJunction, direction (neighbor nodeId), pos (distance from junction center), maxDistance}
  // pos < 0 = approaching junction, pos > 0 = past junction heading away
  function vehicleToLatLng(engine, v) {
    const jd = engine.junctionData ? engine.junctionData() : [];
    const j = jd[v.fromJunction];
    if (!j) return null;

    const jNode = graphIndex[j.nodeId];
    const nbNode = graphIndex[v.direction];
    if (!jNode || !nbNode) return null;

    // Vehicle travels from nbNode toward jNode (approaching) then continues past
    // Total edge length = v.maxDistance
    // pos ranges from -(STOP_LINE + some offset) to +(EXIT_DISTANCE)
    // Map pos to fraction: pos goes from negative (far from junction) to positive (past junction)
    // At pos=0, vehicle is at junction center.
    // Before junction: interpolate nbNode -> jNode
    // After junction: extrapolate jNode in same direction
    const totalEdge = v.maxDistance || 1;
    const t = v.pos / totalEdge; // t=0 at junction center, t<0 before, t>0 after

    const lat = jNode.lat + (nbNode.lat - jNode.lat) * (-t);
    const lon = jNode.lon + (nbNode.lon - jNode.lon) * (-t);
    return [lon, lat];
  }

  function startLoop() {
    const engine = window.flowEngine;
    if (!engine) return;

    function frame() {
      const dt = TICK_MS / 1000 * (engine.getState ? engine.getState().speed : 1);
      if (running) {
        engine.tick(dt);
        simTime += dt;
      }

      // Update junction colors from engine state
      const st = engine.state();
      if (st && st.intersections) {
        const jf = junctions.map((j, i) => {
          const iState = st.intersections[i];
          let sig = 'green';
          if (iState.pedestrian?.active) sig = 'red';
          else if (iState.preempting) sig = 'red';
          else if (iState.signalState === 'yellow') sig = 'yellow';
          else sig = 'green'; // both phases green-looking; differentiate with phase
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [j.lon, j.lat] },
            properties: { name: j.name, signalState: sig, phase: iState.phase }
          };
        });
        map.getSource('junctions-src')?.setData({ type: 'FeatureCollection', features: jf });

        // Color based on signal
        map.setPaintProperty('junction-dot', 'circle-color',
          ['match', ['get', 'signalState'], 'yellow', '#ffc94a', 'red', '#ff5c70', '#39d98a']);
        map.setPaintProperty('junction-glow', 'circle-color',
          ['match', ['get', 'signalState'], 'yellow', '#ffc94a', 'red', '#ff5c70', '#39d98a']);

        // Vehicle positions
        vehicleFeatures = [];
        for (let ji = 0; ji < st.intersections.length; ji++) {
          const iState = st.intersections[ji];
          if (!iState.vehicles) continue;
          for (const v of iState.vehicles) {
            if (v.passed) continue;
            const ll = vehicleToLatLng(engine, v);
            if (!ll) continue;
            vehicleFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: ll },
              properties: { emergency: v.emergency || false }
            });
          }
        }
        map.getSource('vehicles-src')?.setData({ type: 'FeatureCollection', features: vehicleFeatures });
      }

      // Update side panel
      updateMetrics(engine);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function updateMetrics(engine) {
    const m = engine.getMetrics?.() || {};
    const safe = (v, d = 1) => typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '0.0';
    const txt = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    txt('avgWait', safe(m.avgWait) + 's');
    txt('maxQueue', Math.round(m.maxQueue || 0));
    txt('throughput', Math.round(m.throughput || 0));
    txt('totalDelay', safe(m.totalDelay) + 's');

    const decDiv = document.getElementById('decisions');
    if (decDiv) {
      const decs = engine.getDecisions?.() || [];
      decDiv.innerHTML = decs.slice(-8).map(d =>
        '<div class="text-xs p-2 rounded bg-white/5">' + (d.text || d.reasoning || d) + '</div>'
      ).join('') || '<div class="text-xs opacity-40">No decisions yet</div>';
    }
    const logDiv = document.getElementById('log');
    if (logDiv) {
      const logs = engine.getLog?.() || [];
      logDiv.innerHTML = logs.slice(-10).map(l =>
        '<div class="text-xs mono opacity-70">' + l + '</div>'
      ).join('');
      logDiv.scrollTop = logDiv.scrollHeight;
    }

    // Status dot
    const st = document.getElementById('mapState');
    if (st) st.textContent = running ? 'Running · ' + simTime.toFixed(0) + 's' : 'Paused';
  }

  function setupControls() {
    document.getElementById('startBtn')?.addEventListener('click', () => {
      running = !running;
      const btn = document.getElementById('startBtn');
      if (btn) btn.textContent = running ? '⏸ Pause' : '▶ Start';
    });
    document.getElementById('resetBtn')?.addEventListener('click', () => {
      window.flowEngine?.reset?.();
      simTime = 0; running = false;
      const btn = document.getElementById('startBtn');
      if (btn) btn.textContent = '▶ Start';
    });
    document.getElementById('modeSelect')?.addEventListener('change', e => {
      window.flowEngine?.setMode?.(e.target.value);
    });
    document.getElementById('trafficSelect')?.addEventListener('change', e => {
      window.flowEngine?.setTraffic?.(e.target.value);
    });
    document.getElementById('speedRange')?.addEventListener('input', e => {
      window.flowEngine?.setSpeed?.(parseFloat(e.target.value));
    });
    document.getElementById('emergencyBtn')?.addEventListener('click', () => {
      window.flowEngine?.dispatchEmergency?.();
    });
    document.getElementById('pedBtn')?.addEventListener('click', () => {
      window.flowEngine?.callPedestrian?.();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
