# 火山预警 · Volcano View

全球火山预警地图（USGS / GDACS），手机优先 Leaflet 视图，可打成 Android APK。

## 数据

读取根目录 `public/alerts.json`（由 volcano-watch 扫描刷新）。字段：`id`、`level`、`lat`、`lon`、`title`、`summary`、`updated_at`、`source`、`url`。

## 本地

```bash
npm install
npm run dev
```

## Android

```bash
npm run build:android
cd android && ./gradlew assembleDebug
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`
