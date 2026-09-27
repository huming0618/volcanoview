import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './style.css';
import {
  createCachedTileLayer,
  warmCacheFromBundled,
  syncOfflineZoomLimits,
  isOnline,
  prefetchTiles,
  SEEDED_MAX_ZOOM,
} from './tileCache.js';

const LEVEL_LABEL = { red: '红', orange: '橙', yellow: '黄' };
const STATUS_LABEL = {
  alert: '预警',
  active: '活跃',
  dormant: '休眠',
  unknown: '未知',
  extinct: '死火山',
};

/** Filters: alerts | active (alert+active+dormant) | all */
const FILTERS = {
  alerts: (v) => v.status === 'alert',
  active: (v) =>
    v.status === 'alert' || v.status === 'active' || v.status === 'dormant',
  all: () => true,
};

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
  filters: document.getElementById('filters'),
};

/** @type {L.Map} */
let map;
/** @type {L.MarkerClusterGroup} */
let cluster;
/** @type {object[]} */
let volcanoes = [];
/** @type {string|null} */
let generatedAt = null;
/** @type {'alerts'|'active'|'all'} */
let currentFilter = 'active';

function showStatus(text) {
  if (!text) {
    el.status.hidden = true;
    el.status.textContent = '';
    return;
  }
  el.status.hidden = false;
  el.status.textContent = text;
}

function markerClass(v) {
  if (v.status === 'alert' && LEVEL_LABEL[v.level]) return v.level;
  if (v.status === 'active') return 'active';
  if (v.status === 'dormant') return 'dormant';
  if (v.status === 'extinct') return 'extinct';
  return 'unknown';
}

function markerIcon(v) {
  const cls = markerClass(v);
  const size = v.status === 'alert' ? 20 : 12;
  return L.divIcon({
    className: '',
    html: `<div class="volcano-marker ${cls}" style="width:${size}px;height:${size}px"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size + 2],
  });
}

function badgeFor(v) {
  if (v.status === 'alert' && LEVEL_LABEL[v.level]) {
    return { text: LEVEL_LABEL[v.level], cls: v.level };
  }
  const st = v.status || 'unknown';
  return { text: STATUS_LABEL[st] || st, cls: markerClass(v) };
}

function openSheet(v) {
  const b = badgeFor(v);
  el.sheetLevel.className = `badge ${b.cls}`;
  el.sheetLevel.textContent = b.text;
  el.sheetTitle.textContent = v.title || v.id;
  el.sheetSummary.textContent = v.summary || '';
  el.sheetMeta.textContent = [
    v.country || null,
    v.last_eruption ? `末次喷发 ${v.last_eruption}` : null,
    v.source ? `来源 ${v.source}` : null,
    v.updated_at ? `更新 ${v.updated_at}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (v.url) {
    el.sheetLink.href = v.url;
    el.sheetLink.hidden = false;
  } else {
    el.sheetLink.hidden = true;
  }
  el.sheet.hidden = false;
  const reg = regionForVolcano(v);
  if (reg) prefetchRegion(reg);
}

function closeSheet() {
  el.sheet.hidden = true;
}

function visibleList() {
  const pred = FILTERS[currentFilter] || FILTERS.active;
  return volcanoes.filter(
    (v) => Number.isFinite(v.lat) && Number.isFinite(v.lon) && pred(v),
  );
}

function fitVisible() {
  const pts = visibleList().map((v) => [v.lat, v.lon]);
  if (!pts.length) {
    map.setView([20, 0], 2);
    return;
  }
  map.fitBounds(L.latLngBounds(pts), {
    padding: [56, 56],
    maxZoom: currentFilter === 'alerts' ? 5 : 3,
  });
}

function renderMarkers() {
  cluster.clearLayers();
  const list = visibleList();
  // Alerts on top: add others first
  const ordered = [...list].sort((a, b) => {
    const ao = a.status === 'alert' ? 0 : 1;
    const bo = b.status === 'alert' ? 0 : 1;
    return bo - ao;
  });
  const layers = [];
  for (const v of ordered) {
    const m = L.marker([v.lat, v.lon], {
      icon: markerIcon(v),
      title: v.title,
      zIndexOffset: v.status === 'alert' ? 1000 : 0,
    });
    m.on('click', () => openSheet(v));
    layers.push(m);
  }
  cluster.addLayers(layers);
  updateMeta(list.length);
}

function updateMeta(shown) {
  const counts = { alert: 0, active: 0, dormant: 0, unknown: 0, extinct: 0 };
  for (const v of volcanoes) {
    if (counts[v.status] != null) counts[v.status] += 1;
  }
  const filterLabel =
    currentFilter === 'alerts'
      ? '仅预警'
      : currentFilter === 'all'
        ? '全部'
        : '活跃+休眠';
  el.meta.textContent = [
    `显示 ${shown}`,
    `库 ${volcanoes.length}`,
    filterLabel,
    counts.alert ? `预警 ${counts.alert}` : null,
    generatedAt ? `数据 ${generatedAt}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function setFilter(name) {
  if (!FILTERS[name]) return;
  currentFilter = name;
  for (const btn of el.filters.querySelectorAll('.filter-btn')) {
    btn.classList.toggle('active', btn.dataset.filter === name);
  }
  closeSheet();
  renderMarkers();
  fitVisible();
}

async function fetchJson(name) {
  const candidates = [
    new URL(name, window.location.href).href,
    `${import.meta.env.BASE_URL}${name}`.replace(/\/{2,}/g, '/').replace(':/', '://'),
    `./${name}`,
    name,
  ];
  const tried = new Set();
  let lastErr = null;
  for (const u of candidates) {
    if (!u || tried.has(u)) continue;
    tried.add(u);
    try {
      const res = await fetch(u, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${u}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${name} not found`);
}

/** @type {import('leaflet').TileLayer|null} */
let baseTiles = null;
/** @type {object[]} */
let offlineRegions = [];

function addBaseTiles() {
  baseTiles = createCachedTileLayer(L, {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18,
    maxNativeZoom: SEEDED_MAX_ZOOM,
  });
  baseTiles.addTo(map);
  syncOfflineZoomLimits(map, baseTiles);
  window.addEventListener('online', () => syncOfflineZoomLimits(map, baseTiles));
  window.addEventListener('offline', () => syncOfflineZoomLimits(map, baseTiles));
}

async function loadOfflineRegions() {
  try {
    const data = await fetchJson('offline-regions.json');
    offlineRegions = Array.isArray(data.regions) ? data.regions : [];
  } catch {
    offlineRegions = [];
  }
}

function regionForVolcano(v) {
  if (!v) return null;
  return offlineRegions.find((r) => r.id === v.id) || null;
}

function prefetchRegion(region) {
  if (!region?.bbox || !isOnline()) return;
  const b = region.bbox;
  const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
  const z0 = Math.max(region.zmin ?? 11, 11);
  const z1 = Math.min(region.zmax ?? SEEDED_MAX_ZOOM, SEEDED_MAX_ZOOM);
  prefetchTiles(bounds, z0, z1).catch(() => {});
}

async function init() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    maxZoom: 18,
  }).setView([20, 120], 3);
  L.control.zoom({ position: 'topright' }).addTo(map);
  addBaseTiles();

  cluster = L.markerClusterGroup({
    maxClusterRadius: 48,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 8,
    chunkedLoading: true,
  });
  map.addLayer(cluster);

  el.btnFit.addEventListener('click', () => {
    closeSheet();
    fitVisible();
  });
  el.btnClose.addEventListener('click', closeSheet);
  map.on('click', closeSheet);
  el.filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    setFilter(btn.dataset.filter);
  });

  showStatus('加载火山数据…');
  try {
    await loadOfflineRegions();
    await warmCacheFromBundled();
    syncOfflineZoomLimits(map, baseTiles);
    const data = await fetchJson('volcanoes.json');
    volcanoes = Array.isArray(data.volcanoes) ? data.volcanoes : [];
    generatedAt = data.generated_at || null;
    if (!volcanoes.length) {
      const a = await fetchJson('alerts.json');
      volcanoes = (a.alerts || []).map((x) => ({ ...x, status: 'alert' }));
      generatedAt = a.generated_at || generatedAt;
    }
    setFilter('alerts');
    // Warm runtime cache for alert regions when online
    for (const r of offlineRegions) prefetchRegion(r);
    showStatus('');
  } catch (e) {
    console.error(e);
    el.meta.textContent = '数据加载失败';
    showStatus('无法读取 volcanoes.json');
  }
}

init();
