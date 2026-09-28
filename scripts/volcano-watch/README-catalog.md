# Volcano catalog for volcanoview

`volcanoes.json` is built from:
1. Smithsonian GVP Holocene (TidyTuesday CSV mirror)
2. Live USGS elevated + GDACS VO alerts (`alerts.json`)
3. OpenStreetMap `natural=volcano` with `volcano:status=extinct` (worldwide)
4. **All named OSM volcanoes in China bbox** (even without status tag) — closes gaps like 乌兰哈达
5. Manual supplements in rebuild (乌兰哈达火山群, 黄花沟火山群, …)

Rebuild: run the merge logic after refreshing OSM extracts under `/tmp/osm_*.json`, then push to `huming0618/volcanoview` `public/volcanoes.json`.

App filters: alert-only / active+dormant / all (includes unknown+extinct).

Also: US OSM named volcanoes (CONUS, Alaska, Hawaii; territories best-effort).
