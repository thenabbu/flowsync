// FlowSync Cyber City — MapLibre map page (dark). Dependency-light so later
// agents can plug in vehicle/signal rendering without touching map code.

/* Global hooks for later agents (vehicles, signals, etc). */
window.globalState = {
  map: null,
  center: [77.086, 28.5022], // Gurgaon Cyber City
  zoom: 14,
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  attribution: '© CARTO, © OpenStreetMap contributors',
  vehicles: [],
  signals: [],
};

function setMapState(t) {
  const el = document.getElementById('mapState');
  if (el) el.textContent = t;
}

function initMap() {
  const container = document.getElementById('map');
  if (!container) {
    setMapState('Map container missing');
    return;
  }
  if (typeof maplibregl === 'undefined') {
    setMapState('MapLibre failed to load (CDN)');
    return;
  }

  const map = new maplibregl.Map({
    container,
    style: window.globalState.style,
    center: window.globalState.center,
    zoom: window.globalState.zoom,
    pitch: 0,
  });
  window.globalState.map = map;

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('load', () => setMapState('Ready · ' + window.globalState.vehicles.length + ' vehicles'));
  map.on('error', (e) => setMapState('Map error'));
}

// Gate on window load so the maplibre script tag is guaranteed present.
window.addEventListener('load', initMap);
if (document.readyState === 'complete') initMap(); // already loaded