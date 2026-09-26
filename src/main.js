import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

const LEVEL_LABEL = { red: '红', orange: '橙', yellow: '黄' };
const LEVEL_ORDER = { red: 0, orange: 1, yellow: 2 };

const el = {
  meta: document.getElementById('meta'),
  status: document.getElementById('status'),
  sheet: document.getElementById('sheet'),
  sheetLevel: document.getElementById('sheet-level'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetSummary: document.getElementById('sheet-summary'),
  sheetMeta: document.getElementById('sheet-meta'),
  sheetLink: document.getElementById('sheet-link'),
  btnFit: document.getElementById('btn-fit'),
  btnClose: document.getElementById('btn-close'),
};

/** @type {L.Map} */
let map;
/** @type {L.LayerGroup} */
let markersLayer;
/** @type {object[]} */
let alerts = [];
/** @type {string|null} */
let generatedAt = null;

function showStatus(text) {
  if (!text) {
    el.status.hidden = true;
    el.status.textContent = '';
    return;
  }
  el.status.hidden = false;
  el.status.textContent = text;
}

function markerIcon(level) {
  const lv = LEVEL_LABEL[level] ? level : 'yellow';
  return L.divIcon({
    className: '',
    html: `<div class="volcano-marker ${lv}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [0, -16],
  });
}

function openSheet(a) {
  const lv = a.level || 'yellow';
  el.sheetLevel.className = `badge ${lv}`;
  el.sheetLevel.textContent = LEVEL_LABEL[lv] || lv;
  el.sheetTitle.textContent = a.title || a.id;
  el.sheetSummary.textContent = a.summary || '';
  el.sheetMeta.textContent = [
    a.source ? `来源 ${a.source}` : null,
    a.updated_at ? `更新 ${a.updated_at}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (a.url) {
    el.sheetLink.href = a.url;
    el.sheetLink.hidden = false;
  } else {
    el.sheetLink.hidden = true;
  }
  el.sheet.hidden = false;
}

function closeSheet() {
  el.sheet.hidden = true;
}

function fitAll() {
  const pts = alerts
    .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))
    .map((a) => [a.lat, a.lon]);
  if (!pts.length) {
    map.setView([20, 0], 2);
    return;
  }
  map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 6 });
}

function renderMarkers() {
  markersLayer.clearLayers();
  const sorted = [...alerts].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9),
  );
  for (const a of sorted) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    const m = L.marker([a.lat, a.lon], {
      icon: markerIcon(a.level),
      title: a.title,
      zIndexOffset: 1000 - (LEVEL_ORDER[a.level] ?? 9) * 10,
    });
    m.on('click', () => openSheet(a));
    markersLayer.addLayer(m);
  }
}

function updateMeta() {
  const n = alerts.length;
  const counts = { red: 0, orange: 0, yellow: 0 };
  for (const a of alerts) {
    if (counts[a.level] != null) counts[a.level] += 1;
  }
  const parts = [
    `${n} 条预警`,
    counts.red ? `红 ${counts.red}` : null,
    counts.orange ? `橙 ${counts.orange}` : null,
    counts.yellow ? `黄 ${counts.yellow}` : null,
    generatedAt ? `数据 ${generatedAt}` : null,
  ].filter(Boolean);
  el.meta.textContent = parts.join(' · ');
}

async function loadAlerts() {
  const urls = [
    new URL('alerts.json', import.meta.url.replace(/\/assets\/.*$/, '/')).href,
    './alerts.json',
    'alerts.json',
  ];
  // Prefer root-relative for Vite/Capacitor public assets
  const candidates = [
    new URL('alerts.json', window.location.href).href,
    `${import.meta.env.BASE_URL}alerts.json`.replace(/\/{2,}/g, '/').replace(':/', '://'),
  ];
  // Deduplicate
  const tried = new Set();
  let lastErr = null;
  for (const u of [...candidates, ...urls]) {
    if (!u || tried.has(u)) continue;
    tried.add(u);
    try {
      const res = await fetch(u, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${u}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.alerts)) throw new Error('bad schema');
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('alerts.json not found');
}

function addBaseTiles() {
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap',
  });
  const carto = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    {
      maxZoom: 18,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  );
  osm.on('tileerror', () => {
    if (!map.hasLayer(carto)) {
      map.removeLayer(osm);
      carto.addTo(map);
    }
  });
  osm.addTo(map);
}

async function init() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
  }).setView([20, 120], 3);
  L.control.zoom({ position: 'topright' }).addTo(map);
  addBaseTiles();
  markersLayer = L.layerGroup().addTo(map);

  el.btnFit.addEventListener('click', () => {
    closeSheet();
    fitAll();
  });
  el.btnClose.addEventListener('click', closeSheet);
  map.on('click', closeSheet);

  showStatus('加载预警数据…');
  try {
    const data = await loadAlerts();
    alerts = data.alerts || [];
    generatedAt = data.generated_at || null;
    renderMarkers();
    updateMeta();
    fitAll();
    showStatus('');
  } catch (e) {
    console.error(e);
    el.meta.textContent = '预警数据加载失败';
    showStatus('无法读取 alerts.json');
  }
}

init();
