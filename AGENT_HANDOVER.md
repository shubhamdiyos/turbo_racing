# 🤖 AI AGENT HANDOVER SPEC (v0 -> Android & iOS Production)

## Project Overview
- **Title:** Turbo Morph 3D
- **Platforms:** Android (Google Play `.aab`) & iOS (App Store `.ipa`)
- **Design Focus:** 100% Pure Arcade Racing & Vehicle Morphing (No parental gates, no age-selector clutter).
- **Tech Stack:** Three.js (r160 ES Modules) + WebAudio V12 Engine Synth + Capacitor 6 (Android & iOS).

## Architecture Map
- `www/index.html` — Clean arcade HUD, 3D Showroom Garage, Speed/Nitro Upgrade UI, and ES Module import map.
- `www/css/main.css` — Cross-platform iOS/Android safe-area styling (`env(safe-area-inset-*)`), responsive portrait layout.
- `www/js/audio.js` — `AAASoundSystem` with iOS WebKit silent-buffer unlock, V12 engine synth, 5-speed gearbox backfires, and 128 BPM synthwave BGM.
- `www/js/ads.js` — `AdManager` for Rewarded Video boosts (Start Morphed, Revive Run, 2x Coins) and capped Interstitials.
- `www/js/main.js` — Core Three.js WebGL engine, Real 3D Ferrari 458 GLTF loader, Mirror-Wet Highway, Plasma Exhaust, and 60FPS loop.
- `native-config/AndroidManifest.patch.xml` — Portrait lock & hardware acceleration for Android.
- `native-config/Info.plist.patch.xml` — Portrait lock, status bar hidden, and SKAdNetwork config for iOS.

## Immediate Tasks for Next Agent (Claude / Argon 4)
1. **Vendor 3D Assets Offline (Zero-Network Startup):**
   - Download `https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/ferrari.glb` to `www/assets/models/ferrari.glb` and point `GLTFLoader` in `www/js/main.js` to the local file.
   - Bundle `three` and `three/addons/` locally using Vite so both Android and iOS builds run 100% offline.
2. **Initialize Both Android & iOS Native Projects:**
   - Run `npm install && npm run mobile:init`.
   - Apply `native-config/AndroidManifest.patch.xml` to `android/app/src/main/AndroidManifest.xml`.
   - Apply `native-config/Info.plist.patch.xml` to `ios/App/App/Info.plist`.
3. **Wire Native AdMob Plugin:**
   - Connect `@capacitor-community/admob` inside `www/js/ads.js` for both Android and iOS Ad Unit IDs.
