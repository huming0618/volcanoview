#!/usr/bin/env node
/**
 * Pre-seed tiles for alert offline-regions into public/offline-tiles/{z}/{x}/{y}.png
 * Reads public/offline-regions.json (zmin/zmax + bbox per region).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'offline-tiles');
const REGIONS_PATH = path.join(ROOT, 'public', 'offline-regions.json');

const WORKERS = 4;
const DELAY_MS = 180;
const UA =
  'VolcanoViewOfflineSeeder/1.0 (https://github.com/huming0618/volcanoview; offline pack; contact via GitHub issues)';

const OSM_TMPL = (s, z, x, y) => `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
const CARTO_TMPL = (s, z, x, y) =>
  `https://${s}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
const SUBS = ['a', 'b', 'c', 'd'];

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let preferCarto = true;
let osmFailStreak = 0;

async function fetchTile(z, x, y) {
  const s = SUBS[(x + y) % SUBS.length];
  const osmS = s === 'd' ? 'a' : s;
  const urls = preferCarto
    ? [CARTO_TMPL(s, z, x, y), OSM_TMPL(osmS, z, x, y)]
    : [OSM_TMPL(osmS, z, x, y), CARTO_TMPL(s, z, x, y)];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
          Referer: 'https://github.com/huming0618/volcanoview',
        },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status === 403 || res.status === 429 || res.status === 418) preferCarto = true;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50) {
        lastErr = new Error('tiny');
        continue;
      }
      if (url.includes('cartocdn')) preferCarto = true;
      else osmFailStreak = 0;
      return { buf, fromCarto: url.includes('cartocdn') };
    } catch (e) {
      lastErr = e;
    }
  }
  osmFailStreak++;
  if (osmFailStreak >= 3) preferCarto = true;
  throw lastErr || new Error('fail');
}

async function main() {
  const data = JSON.parse(fs.readFileSync(REGIONS_PATH, 'utf8'));
  const regions = data.regions || [];
  const zMin = data.zmin ?? 11;
  // Bundle z11–13 only (~5.6k tiles); z14 left to runtime cache when online
  const zMax = Math.min(data.zmax ?? 13, 13);
  const tileSet = new Map();
  const regionMeta = [];

  for (const r of regions) {
    const { south, west, north, east } = r.bbox;
    const z0 = Math.max(r.zmin ?? zMin, zMin);
    const z1 = Math.min(r.zmax ?? zMax, zMax);
    let count = 0;
    for (let z = z0; z <= z1; z++) {
      const x0 = lon2tile(west, z);
      const x1 = lon2tile(east, z);
      const y0 = lat2tile(north, z);
      const y1 = lat2tile(south, z);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${z}/${x}/${y}`;
          if (!tileSet.has(key)) tileSet.set(key, { z, x, y });
          count++;
        }
      }
    }
    regionMeta.push({ id: r.id, title: r.title, bbox: r.bbox, tileCount: count });
    console.log(`${r.title}: ${count} tiles (raw)`);
  }

  const jobs = [...tileSet.values()];
  console.log(`Unique tiles: ${jobs.length}`);
  fs.mkdirSync(OUT, { recursive: true });

  let ok = 0,
    fail = 0,
    skipped = 0,
    cartoCount = 0,
    osmCount = 0,
    next = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const { z, x, y } = jobs[i];
      const destDir = path.join(OUT, String(z), String(x));
      const dest = path.join(destDir, `${y}.png`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 50) {
        skipped++;
        ok++;
      } else {
        fs.mkdirSync(destDir, { recursive: true });
        try {
          const { buf, fromCarto } = await fetchTile(z, x, y);
          fs.writeFileSync(dest, buf);
          ok++;
          if (fromCarto) cartoCount++;
          else osmCount++;
        } catch (e) {
          fail++;
          console.warn(`FAIL ${z}/${x}/${y}: ${e.message}`);
        }
        await sleep(DELAY_MS);
      }
      if ((ok + fail) % 50 === 0 || i === jobs.length - 1) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(
          `[${ok + fail}/${jobs.length}] ok=${ok} fail=${fail} skip=${skipped} carto=${cartoCount} ${elapsed}s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  let fileCount = 0,
    bytes = 0;
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.png')) {
        fileCount++;
        bytes += fs.statSync(p).size;
      }
    }
  }
  walk(OUT);

  const manifest = {
    generatedAt: new Date().toISOString(),
    zoom: { min: zMin, max: zMax },
    policy: data.policy || 'alert-only',
    regions: regionMeta,
    uniqueRequested: jobs.length,
    downloadedOk: ok,
    failed: fail,
    skippedExisting: skipped,
    providersUsed: { osm: osmCount, carto: cartoCount },
    attribution:
      'Map tiles © OpenStreetMap contributors and/or © CARTO. Bundled for offline Volcano View demo only.',
    pathTemplate: 'offline-tiles/{z}/{x}/{y}.png',
    onDiskPngCount: fileCount,
    onDiskBytes: bytes,
    onDiskMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('DONE', manifest.onDiskMB, 'MB', fileCount, 'pngs fail=', fail);
  if (fail > jobs.length * 0.08) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
