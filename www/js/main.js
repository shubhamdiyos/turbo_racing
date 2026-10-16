import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AAASoundSystem } from './audio.js';
import { AdManager } from './ads.js';
import {
  PRODUCTS, PURCHASES_ARE_SANDBOX, initOffer, offerLive, offerRemaining, countdown,
  priceOf, isOwned, markPurchased, requestPurchase, usd, LTO_OFF_PCT
} from './store.js';

let save = JSON.parse(localStorage.getItem('tm3d_arcade_v3')) || {
  coins: 500,
  best: 0,
  selectedCar: 0,
  unlocked: [0],
  nitroLevel: 1,
  settings: {
    music: true,
    sfx: true,
    voice: true,
    haptics: true,
    controls: 'both'
  }
};
if (!save.settings) {
  save.settings = { music: true, sfx: true, voice: true, haptics: true, controls: 'both' };
}

// The 3-system workshop replaces the old single Nitro ladder, but runs before this update spent
// coins on nitroLevel (up to 11). Seed MORPH/MAGNET from it so paid-for progress survives.
if (!save.tuning) {
  save.tuning = { speed: 1, morph: Math.min(5, save.nitroLevel || 1), magnet: Math.min(5, save.nitroLevel || 1) };
}

// Daily rewards key to the *local* calendar day. An ISO/UTC day rolls at 05:30 for most of our
// players, so "today's" reward would appear to be missing for hours after waking up.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBetween = (from, to) => Math.round(
  (new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000
);

// Streak, trophy chest and the paid-entitlement wallet. None of it is seeded from coins, so
// nothing a player already bought can be duplicated by the new reward loops.
if (typeof save.missionsTotal !== 'number') save.missionsTotal = 0;
if (typeof save.chestsOpened !== 'number') save.chestsOpened = 0;
if (!save.streak) save.streak = { day: 0, claimedOn: null };
if (!save.ent) save.ent = { noAds: false, headstarts: 0 };
delete save.crateDay;   // the once-a-day crate is now the streak claim inside the rewards modal
initOffer(save);

const persist = () => localStorage.setItem('tm3d_arcade_v3', JSON.stringify(save));
// A migration that never writes back leaves the launch offer un-anchored: reload the app before
// earning anything and the 12-hour clock quietly restarts, making the deal permanent instead of
// limited. Everything added above is additive, so this commits no loss of earned progress.
persist();

const CAR_SPECS = [
  { name: "FERRARI 458 CYBER", short: "458 CYBER", tier: "CORE", hex: 0xff0033, rimHex: 0x00f2fe, flameHex: 0x00f2fe, price: 0, morph: "Mecha Rex-Truck", type: "truck", baseSpd: 78, basePr: 740 },
  { name: "NEON VIPER 458", short: "VIPER 458", tier: "RARE", hex: 0x00e5ff, rimHex: 0xff0066, flameHex: 0xff0066, price: 300, morph: "Supersonic Stealth Jet", type: "jet", baseSpd: 85, basePr: 810 },
  { name: "EMERALD HYPER 458", short: "HYPER 458", tier: "EPIC", hex: 0x00ff66, rimHex: 0xffea00, flameHex: 0x00ff87, price: 750, morph: "Neon Crusher Rig", type: "truck", baseSpd: 92, basePr: 885 },
  { name: "ROYAL GOLD 458", short: "GOLD 458", tier: "MYTHIC", hex: 0xffb800, rimHex: 0xffffff, flameHex: 0xffae00, price: 1500, morph: "Golden Valkyrie Jet", type: "jet", baseSpd: 100, basePr: 950 }
];

// Neon accents are player-chosen per car, so they live in the save, not in CAR_SPECS defaults.
if (!save.customNeon) save.customNeon = save.neonAccents || {};
delete save.neonAccents;
Object.keys(save.customNeon).forEach(carIdx => {
  const hex = save.customNeon[carIdx];
  if (CAR_SPECS[carIdx] && typeof hex === 'number') {
    CAR_SPECS[carIdx].rimHex = hex;
    CAR_SPECS[carIdx].flameHex = hex;
  }
});

const MISSIONS = [
  { id: 0, type: 'smash', target: 3, desc: 'SMASH 3 TRAFFIC CARS', reward: 250 },
  { id: 1, type: 'nearmiss', target: 4, desc: 'GET 4 NEAR MISSES', reward: 250 },
  { id: 2, type: 'dist', target: 800, desc: 'REACH 800m IN ONE RUN', reward: 300 },
  { id: 3, type: 'stunt', target: 2, desc: 'HIT 2 STUNT RAMPS', reward: 250 }
];
if (typeof save.missionIdx !== 'number') save.missionIdx = 0;
if (typeof save.missionProg !== 'number') save.missionProg = 0;

let garageTab = 'showroom'; // 'showroom' | 'tuning' | 'neon'
let isMorphPreview = false;
let showroomCamTarget = new THREE.Vector3(0, 2.15, 6.5);
let showroomLookTarget = new THREE.Vector3(0, 0.55, 0);
let currentLookAt = new THREE.Vector3(0, 0.25, 0);
const _camScratch = new THREE.Vector3();
const _lookScratch = new THREE.Vector3();
let barrelRollAngle = 0;
let nitroPadBoost = 0;
let ramps = [];
let boostPads = [];

let state = 'MENU'; // 'MENU' | 'PLAYING' | 'PAUSED' | 'RESULTS'
const sound = new AAASoundSystem();
sound.applySettings(save.settings);

window.addEventListener('pointerdown', () => sound.init(() => state === 'PLAYING'), { once: true });
window.addEventListener('keydown', () => sound.init(() => state === 'PLAYING'), { once: true });

function showComicPopup(text, color = '#ffea00') {
  const el = document.getElementById('comicPopup');
  el.innerHTML = text;
  el.style.color = color;
  el.style.transform = 'translate(-50%, -50%) scale(1.15) rotate(-4deg)';
  setTimeout(() => { el.style.transform = 'translate(-50%, -50%) scale(0)'; }, 850);
}

// --- THREE.JS SCENE SETUP ---
const wrapper = document.getElementById('gameWrapper');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(58, wrapper.clientWidth / wrapper.clientHeight, 0.1, 240);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
wrapper.appendChild(renderer.domElement);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
// Ground and tarmac run away from the camera at a brutal angle. Capping anisotropy below the
// device maximum makes those surfaces snap between mip levels in visible horizontal bands.
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(wrapper.clientWidth, wrapper.clientHeight), 0.6, 0.42, 0.95);
composer.addPass(bloomPass);

// Final lens grade: vignette, film grain and edge chromatic fringe
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, strength: { value: 1 }, tint: { value: new THREE.Color(1, 1, 1) } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float strength; uniform vec3 tint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    vec3 aces(vec3 x) { return clamp(((x * (x * 2.51 + 0.03)) / (x * (x * 2.43 + 0.59) + 0.14)), vec3(0.0), vec3(1.0)); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      float ca = 0.012 * r2 * strength;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + d * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - d * ca).b;
      // The composer renders into a half-float target, so three skips its own tone mapping and
      // anything over 1.0 used to clip flat white. This rolloff is what keeps hot exhaust readable.
      col = aces(col * 1.1);
      col *= mix(1.0, 0.58, smoothstep(0.06, 0.42, r2) * strength);
      col *= tint;
      col += (hash(vUv * 1024.0 + fract(time) * 97.0) - 0.5) * 0.028 * strength;
      gl_FragColor = vec4(col, 1.0);
    }`
};
const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);

const dirLight = new THREE.DirectionalLight(0xfff2e6, 1.35);
dirLight.position.set(7, 16, 9);
scene.add(dirLight);

// Studio showroom rig — fades to a rim-only level once racing starts
const keySpot = new THREE.SpotLight(0xffffff, 300, 0, 0.62, 0.65, 2);
keySpot.position.set(-6.5, 11, 8);
const rimCyan = new THREE.SpotLight(0x35e6ff, 260, 0, 0.72, 0.8, 2);
rimCyan.position.set(-8.5, 5.5, -7);
const rimMagenta = new THREE.SpotLight(0xff2e7e, 240, 0, 0.72, 0.8, 2);
rimMagenta.position.set(8.5, 5, -6.5);
scene.add(keySpot, rimCyan, rimMagenta);
let showroomFactor = 1;

// ─── ATMOSPHERE ───────────────────────────────────────────────────────────
// Equirect gradient instead of a sky mesh: it renders at infinity, so the 240-unit
// camera far plane can never clip it.
function createSkyTexture() {
  const W = 16, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, '#04030e');
  g.addColorStop(0.24, '#0a0622');
  g.addColorStop(0.38, '#1f0a3c');
  g.addColorStop(0.455, '#5d1250');
  g.addColorStop(0.492, '#ff7a2f');
  g.addColorStop(0.508, '#7a1c3f');
  g.addColorStop(0.56, '#170b24');
  g.addColorStop(0.78, '#0a0616');
  g.addColorStop(1.00, '#05030c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 6;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const skyTex = createSkyTexture();
scene.background = skyTex;
// Studio IBL reflected a room the player can't see; the sky is the only light source in
// this world, so wet tarmac and chrome have to pick it up.
scene.environment = pmremGenerator.fromEquirectangular(skyTex).texture;
// Fog is only atmosphere, never a sight-line blocker: the near edge sits past the whole
// reaction band, so traffic is crisp from the moment it can be swerved for. Far stays at 214
// to hide the end of the ground plane (camera.far is 240).
scene.fog = new THREE.Fog(0x3a1140, 44, 214);

function createSynthHorizon() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#ffea00');
  grad.addColorStop(0.5, '#ff0066');
  grad.addColorStop(1, '#6a00ff');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(256, 256, 240, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#060218';
  for (let y = 290; y < 512; y += 22) ctx.fillRect(0, y, 512, (y - 270) * 0.08);
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(95, 95),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, fog: false })
  );
  sun.position.set(0, 25, -185);
  scene.add(sun);
  // Soft bloom feeder along the horizon line so the city bases don't sit on a hard seam
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 54),
    new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.17, fog: false, depthWrite: false })
  );
  glow.position.set(0, 7, -188);
  scene.add(glow);
}
createSynthHorizon();

// ─── GROUND ───────────────────────────────────────────────────────────────
// Without this the towers floated over the flat background colour.
function createGroundTexture() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0a0714'; ctx.fillRect(0, 0, S, S);
  // Broad tonal blotches: packed dirt drifts in patches. Drawn nine times so a blotch that
  // straddles the tile wraps — a sliced blotch leaves a hard seam line every repeat.
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 90 + Math.random() * 240;
    const lite = Math.random() > 0.55;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const X = x + ox * S, Y = y + oy * S;
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, lite ? 'rgba(48,38,74,0.20)' : 'rgba(3,2,9,0.26)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  for (let i = 0; i < 26000; i++) {
    const lite = Math.random() > 0.5;
    ctx.fillStyle = `rgba(${lite ? '58,46,88' : '3,2,8'},${0.04 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2.5, 1 + Math.random() * 2.5);
  }
  makeSeamless(ctx, S, 12);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(22, 22);
  tex.anisotropy = MAX_ANISO;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const groundTex = createGroundTexture();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(620, 620).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ map: groundTex, color: 0x1a1226, roughness: 0.86, metalness: 0.14 })
);
ground.position.y = -0.07;
scene.add(ground);

// ─── MIRROR-WET HIGHWAY ───────────────────────────────────────────────────
const LANES = [-3.2, 0, 3.2];
const ROAD_TILE = 11.6;      // world units per asphalt tile (square, so grit stays isotropic)
const MARK_TILE = 9.5;       // one dash + gap cycle
const mirrorRoad = new Reflector(new THREE.PlaneGeometry(11.6, 220), {
  clipBias: 0.003,
  textureWidth: wrapper.clientWidth * 0.6,
  textureHeight: wrapper.clientHeight * 0.6,
  color: 0x2c2350
});
mirrorRoad.rotation.x = -Math.PI / 2;
mirrorRoad.position.set(0, -0.02, -90);
scene.add(mirrorRoad);

// Painted lane layout in u: carriageway is 11.6 wide, so u = 0.5 + x / 11.6
const uAt = x => 0.5 + x / 11.6;

// Canvas draws clip at the border, so every tile would end with a hard, untextured seam that
// mipmapping smears into a visible grid along the road. Copy the opposite edge over instead.
function makeSeamless(ctx, S, b) {
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = S;
  const t = tmp.getContext('2d');
  t.drawImage(ctx.canvas, 0, 0);
  ctx.drawImage(tmp, 0, 0, S, b, 0, S - b, S, b);
  ctx.drawImage(tmp, 0, S - b, S, b, 0, 0, S, b);
  ctx.drawImage(tmp, 0, 0, b, S, S - b, 0, b, S);
  ctx.drawImage(tmp, S - b, 0, b, S, 0, 0, b, S);
}

function createAsphaltTextures() {
  const S = 1024;
  const col = document.createElement('canvas');
  col.width = col.height = S;
  const cx = col.getContext('2d');
  const rgh = document.createElement('canvas');
  rgh.width = rgh.height = S;
  const rx = rgh.getContext('2d');

  cx.fillStyle = '#15111f'; cx.fillRect(0, 0, S, S);
  rx.fillStyle = '#a8a8a8'; rx.fillRect(0, 0, S, S);   // matte tar by default

  // Aggregate: dense mineral speckle, both bright chippings and voids
  for (let i = 0; i < 30000; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 0.6 + Math.random() * 2.4;
    const v = Math.random();
    cx.fillStyle = v > 0.82 ? `rgba(150,146,168,${0.05 + Math.random() * 0.14})`
      : v > 0.5 ? `rgba(58,52,74,${0.08 + Math.random() * 0.18})`
        : `rgba(3,2,8,${0.1 + Math.random() * 0.22})`;
    cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill();
    rx.fillStyle = v > 0.5 ? `rgba(210,210,210,${0.05 + Math.random() * 0.1})` : `rgba(70,70,70,${0.06 + Math.random() * 0.12})`;
    rx.beginPath(); rx.arc(x, y, r, 0, Math.PI * 2); rx.fill();
  }

  // Tar patch repairs and res seams — darker, smoother, so they read wetter. Drawn nine times
  // so a patch that straddles the tile wraps instead of being sliced off.
  for (let p = 0; p < 7; p++) {
    const px = Math.random() * S, py = Math.random() * S, pw = 90 + Math.random() * 260, ph = 70 + Math.random() * 200;
    const rot = Math.random() * Math.PI, a = 0.3 + Math.random() * 0.25;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const X = px + ox * S, Y = py + oy * S;
        cx.fillStyle = `rgba(8,6,14,${a})`;
        cx.beginPath(); cx.ellipse(X, Y, pw / 2, ph / 2, rot, 0, Math.PI * 2); cx.fill();
        rx.fillStyle = 'rgba(150,150,150,0.5)';
        rx.beginPath(); rx.ellipse(X, Y, pw / 2, ph / 2, rot, 0, Math.PI * 2); rx.fill();
      }
    }
  }

  // Polished wheel tracks: tyre rubber burns the binder off, leaving a glossier lane under
  // each wheel line — the lane centres, not the paint, which is where nothing ever drives.
  const trackPx = LANES.map(l => uAt(l) * S);
  trackPx.forEach(tx => {
    const w = 78;
    const lg = cx.createLinearGradient(tx - w, 0, tx + w, 0);
    lg.addColorStop(0, 'rgba(30,26,40,0)');
    lg.addColorStop(0.5, 'rgba(38,33,50,0.42)');
    lg.addColorStop(1, 'rgba(30,26,40,0)');
    cx.fillStyle = lg; cx.fillRect(tx - w, 0, w * 2, S);
    const rg = rx.createLinearGradient(tx - w, 0, tx + w, 0);
    rg.addColorStop(0, 'rgba(60,60,60,0)');
    rg.addColorStop(0.5, 'rgba(46,46,46,0.85)');
    rg.addColorStop(1, 'rgba(60,60,60,0)');
    rx.fillStyle = rg; rx.fillRect(tx - w, 0, w * 2, S);
  });

  // Alligator cracking near the shoulders
  cx.strokeStyle = 'rgba(4,3,9,0.62)';
  for (let k = 0; k < 26; k++) {
    const sx = Math.random() * S, sy = Math.random() * S;
    const pts = [[sx, sy]];
    for (let s = 0; s < 7; s++) pts.push([pts[s][0] + (Math.random() - 0.5) * 60, pts[s][1] + (Math.random() - 0.5) * 60]);
    cx.lineWidth = 1 + Math.random() * 1.6;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        cx.beginPath();
        pts.forEach(([x, y], i) => (i ? cx.lineTo(x + ox * S, y + oy * S) : cx.moveTo(x + ox * S, y + oy * S)));
        cx.stroke();
      }
    }
  }

  makeSeamless(cx, S, 10);
  makeSeamless(rx, S, 10);

  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 220 / ROAD_TILE);
    t.anisotropy = MAX_ANISO;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { color: mk(col, true), rough: mk(rgh, false) };
}
const asphalt = createAsphaltTextures();
const roadTex = asphalt.color;
const roadOverlay = new THREE.Mesh(
  new THREE.PlaneGeometry(11.6, 220),
  new THREE.MeshStandardMaterial({
    map: asphalt.color, roughnessMap: asphalt.rough, roughness: 1, metalness: 0.28,
    transparent: true, opacity: 0.9
  })
);
roadOverlay.rotation.x = -Math.PI / 2;
roadOverlay.position.set(0, 0.01, -90);
roadOverlay.renderOrder = 1;
scene.add(roadOverlay);

// Markings ride their own plane so the paint stays crisp and can glow independently
function createMarkingTexture() {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const dash = (x, w, y0, y1) => {
    // faded, chipped paint: build the stroke from grains so edges are never vector-clean
    for (let y = y0; y < y1; y += 2) {
      for (let dx = -w / 2; dx < w / 2; dx += 2) {
        const a = 0.5 + Math.random() * 0.5;
        ctx.fillStyle = `rgba(238,240,255,${a})`;
        ctx.fillRect(x + dx + (Math.random() - 0.5), y, 2, 2);
      }
    }
  };
  // lane dividers, one dash per tile
  [-1.6, 1.6].forEach(lx => dash(uAt(lx) * W, 11, 40, 250));
  // edge lines run continuously — dashing them reads as a string of white blobs up close
  [uAt(-5.35), uAt(5.35)].forEach(ex => dash(ex * W, 9, 0, H));
  // cat's-eye reflectors at each dash head
  [-1.6, 1.6].forEach(lx => {
    ctx.fillStyle = 'rgba(255,252,235,0.95)';
    ctx.beginPath(); ctx.arc(uAt(lx) * W, 34, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(uAt(lx) * W, 286, 6, 0, Math.PI * 2); ctx.fill();
  });

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 220 / MARK_TILE);
  tex.anisotropy = MAX_ANISO;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const markTex = createMarkingTexture();
const markings = new THREE.Mesh(
  new THREE.PlaneGeometry(11.6, 220),
  new THREE.MeshStandardMaterial({
    map: markTex, transparent: true, roughness: 0.5, metalness: 0.0,
    emissive: 0xfff3d8, emissiveMap: markTex, emissiveIntensity: 0.58, depthWrite: false
  })
);
markings.rotation.x = -Math.PI / 2;
markings.position.set(0, 0.022, -90);
markings.renderOrder = 2;
scene.add(markings);

// ─── SHOULDER, KERB, GUARDRAIL & LIGHTING ─────────────────────────────────
// Everything that must recycle with the road registers here.
const envScenery = [];
const railMat = new THREE.MeshStandardMaterial({ color: 0x6d7484, metalness: 0.86, roughness: 0.44 });
// One mesh still carries both roadside materials, tinted per vertex: the mirror-road reflector
// redraws every object twice, so splitting shoulder from kerb with a second material would buy
// legibility at the price of doubling the busiest geometry on screen.
const kerbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.22, roughness: 0.78 });
const SHOULDER_TINT = new THREE.Color(0x7d7a83);   // pale concrete, against the burnt-out kerb face
const KERB_TINT = new THREE.Color(0x1b1726);
function paintTint(g, c) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
const lampMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3d, metalness: 0.8, roughness: 0.5 });
const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: true });
// A real streetlight sells itself with the pool it throws on the tarmac, not the bulb.
// Kept narrow and dim: additive pools overlapping down the straight used to merge into one
// washed band, which read as glare rather than as separate lamps.
const lampPoolMat = new THREE.MeshBasicMaterial({
  map: createRadialFadeTexture([[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]),
  color: 0xffb968, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});

// Cross-section, measured outward from the centreline. The carriageway is ±5.8, so every
// offset starts past that — anything overlapping it would poke through the road plane.
const ROAD_EDGE = 5.8;
const BED = -0.09;                       // buried footing so no slab floats over the ground plane
function slab(w, h, d, x, y, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  return g.translate(x, y + h / 2, z);
}
function buildRailSegment(side) {
  const s = side * ROAD_EDGE;
  const stone = [
    paintTint(slab(1.3, 0.165, 38, s + 0.65 * side, BED), SHOULDER_TINT),   // shoulder strip
    paintTint(slab(1.2, 0.39, 38, s + 1.8 * side, BED), KERB_TINT)          // kerb face
  ];
  const k = new THREE.Mesh(mergeGeometries(stone.map(g => g.index ? g.toNonIndexed() : g), false), kerbMat);
  const steel = [slab(0.14, 0.32, 38, s + 2.35 * side, 0.7)];
  for (let p = -1; p <= 1; p++) steel.push(slab(0.17, 0.95, 0.17, s + 2.35 * side, BED, p * 12.6));
  const r = new THREE.Mesh(mergeGeometries(steel.map(g => g.index ? g.toNonIndexed() : g), false), railMat);
  return [k, r];
}
function buildStreetlight(side) {
  const s = side * ROAD_EDGE;
  const parts = [
    slab(0.19, 6.7, 0.19, s + 3.1 * side, BED),          // mast
    slab(2.6, 0.16, 0.16, s + 1.9 * side, 6.5)           // inward-reaching arm
  ];
  const pole = new THREE.Mesh(mergeGeometries(parts.map(g => g.index ? g.toNonIndexed() : g), false), lampMat);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.55), lampHeadMat);
  head.position.set(s + 0.7 * side, 6.44, 0);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 15).rotateX(-Math.PI / 2), lampPoolMat);
  pool.position.set(s + 0.2 * side, 0.03, 0);
  pool.renderOrder = 3;
  return [pole, head, pool];
}
for (let z = 5; z > -185; z -= 38) {
  [-1, 1].forEach(side => {
    buildRailSegment(side).forEach(m => { m.position.z = z; scene.add(m); envScenery.push(m); });
    buildStreetlight(side).forEach(m => { m.position.z = z - 19; scene.add(m); envScenery.push(m); });
  });
}

// ─── LAYERED CITY ─────────────────────────────────────────────────────────
function createBuildingTexture(hueHex, density) {
  const W = 256, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#070314'; ctx.fillRect(0, 0, W, H);
  // floor slabs give the tower vertical rhythm instead of a flat window grid
  ctx.fillStyle = 'rgba(20,12,38,0.9)';
  for (let y = 0; y < H; y += 28) ctx.fillRect(0, y, W, 4);
  for (let y = 16; y < 490; y += 28) {
    for (let x = 16; x < 240; x += 28) {
      if (Math.random() > density) continue;
      const warm = Math.random();
      ctx.fillStyle = warm > 0.86 ? '#ffffff' : warm > 0.62 ? hueHex : `rgba(255,214,150,0.85)`;
      ctx.globalAlpha = 0.45 + Math.random() * 0.55;
      ctx.fillRect(x, y, 16, 17);
      ctx.globalAlpha = 1;
    }
  }
  // lit ground floor / storefront band
  const sg = ctx.createLinearGradient(0, H - 34, 0, H);
  sg.addColorStop(0, 'rgba(255,190,110,0)');
  sg.addColorStop(1, 'rgba(255,196,120,0.75)');
  ctx.fillStyle = sg; ctx.fillRect(0, H - 34, W, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const bTex = [
  createBuildingTexture('#00f2fe', 0.3),
  createBuildingTexture('#ff0066', 0.38),
  createBuildingTexture('#ffea00', 0.44)
];
// Shared materials: the old loop built one per tower, so nothing batched
const bMats = bTex.map((t, i) => new THREE.MeshStandardMaterial({
  color: 0x140b2c, map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.62, roughness: 0.44, metalness: 0.18
}));
const bFarMat = new THREE.MeshStandardMaterial({ color: 0x0d0a1e, roughness: 0.7, metalness: 0.1, emissive: 0x140828, emissiveIntensity: 0.5 });

// One merged mesh per tower: the mirror-road reflector redraws the whole scene every frame,
// so a separate rooftop-prop mesh would cost two extra draw calls on the cheapest detail there is.
// Facade tiles cover a fixed patch of world, so a 70-unit tower doesn't get 70-unit windows.
const FACADE_U = 21.6;   // 9 window columns at ~2.4 m each
const FACADE_V = 61.2;   // 18 floor slabs at ~3.4 m each
function facadeBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const face = (i / 4) | 0;
    if (face === 2 || face === 3) continue;             // roof stays untiled
    const span = (face === 0 || face === 1) ? d : w;
    uv.setXY(i, uv.getX(i) * (span / FACADE_U), uv.getY(i) * (h / FACADE_V));
  }
  g.translate(0, h / 2, 0);
  return g;
}
function addTower(x, z, w, d, h, mat) {
  const parts = [facadeBox(w, h, d)];
  if (h > 20 && Math.random() > 0.35) {
    const cw = w * 0.62, ch = h * 0.22, cd = d * 0.62;
    const crown = facadeBox(cw, ch, cd);
    crown.translate(0, h, 0);
    parts.push(crown);
  }
  if (h > 16 && Math.random() > 0.4) {
    parts.push(new THREE.BoxGeometry(1.1, 1.6, 1.1)
      .translate((Math.random() - 0.5) * w * 0.4, h + 0.8, (Math.random() - 0.5) * d * 0.4));
  }
  const tower = new THREE.Mesh(mergeGeometries(parts.map(g => g.index ? g.toNonIndexed() : g), false), mat);
  tower.position.set(x, 0, z);
  scene.add(tower);
  envScenery.push(tower);
}

// Three depth bands with gaps between them. Packed tight the city reads as a wall and swallows
// the sky; leaving slots empty and pushing the fronts back is what gives the street its depth.
for (let z = 5, k = 0; z > -185; z -= 19, k++) {
  if (k % 5 === 2) continue;                       // a deliberate hole in the skyline
  [-19, 19].forEach(bx => {
    const side = Math.sign(bx);
    const tall = Math.random() < 0.16;
    addTower(
      bx + side * Math.random() * 7, z - Math.random() * 6,
      8 + Math.random() * 5, 8 + Math.random() * 5,
      tall ? 42 + Math.random() * 18 : 12 + Math.random() * 19,
      bMats[Math.floor(Math.random() * bMats.length)]
    );
  });
}
for (let z = -2; z > -185; z -= 26) {
  [-36, 36].forEach(bx => {
    const side = Math.sign(bx);
    addTower(bx + side * Math.random() * 10, z, 12 + Math.random() * 8, 12 + Math.random() * 8,
      28 + Math.random() * 34, bFarMat);
  });
}
// unlit silhouettes pinned to the horizon to stop the skyline reading as a row of boxes
[-72, 72].forEach(bx => {
  const band = new THREE.Mesh(new THREE.BoxGeometry(20, 22, 200), bFarMat);
  band.position.set(bx, 11, -100);
  scene.add(band);
});


// Showroom Turntable Platform
function createRadialFadeTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 4, 128, 128, 124);
  stops.forEach(([at, col]) => g.addColorStop(at, col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
function createTickRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.translate(256, 256);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const long = i % 6 === 0;
    ctx.strokeStyle = long ? 'rgba(53,230,255,0.95)' : 'rgba(120,180,255,0.35)';
    ctx.lineWidth = long ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 176, Math.sin(a) * 176);
    ctx.lineTo(Math.cos(a) * (long ? 226 : 208), Math.sin(a) * (long ? 226 : 208));
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

const podiumGroup = new THREE.Group();
const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.3, 0.2, 64), new THREE.MeshStandardMaterial({ color: 0x0e0a24, metalness: 0.95, roughness: 0.09 }));
baseDisc.position.y = -0.1;
const neonRing = new THREE.Mesh(new THREE.TorusGeometry(3.15, 0.055, 16, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x35e6ff }));
neonRing.position.y = 0.02;
const outerRing = new THREE.Mesh(new THREE.TorusGeometry(3.62, 0.022, 12, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff2e7e }));
outerRing.position.y = 0.014;
const tickSpin = new THREE.Group();
const tickRing = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 72), new THREE.MeshBasicMaterial({ map: createTickRingTexture(), transparent: true, side: THREE.DoubleSide, opacity: 0.85, depthWrite: false }));
tickRing.rotation.x = -Math.PI / 2;
tickRing.position.y = 0.012;
tickSpin.add(tickRing);
podiumGroup.add(baseDisc, neonRing, outerRing, tickSpin);
scene.add(podiumGroup);

// --- TWIN-TURBO AFTERBURNER, SHIELD DOME & PLASMA EXHAUST SYSTEM ---
function createSoftGlowSpriteTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 60);
  g.addColorStop(0, 'rgba(255, 255, 255, 1)');
  g.addColorStop(0.35, 'rgba(255, 255, 255, 0.8)');
  g.addColorStop(0.7, 'rgba(255, 255, 255, 0.2)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const glowSpriteTex = createSoftGlowSpriteTexture();

// Heat ramp for the afterburner sheets, sampled along the cone's v axis: v=0 is the nozzle lip, v=1 the plume tip.
// Both brightness AND alpha fall off downstream, so the tail contributes almost nothing instead of stacking to white.
function makeFlameTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let row = 0; row < S; row++) {
    const t = row / (S - 1);
    const lip = Math.min(1, t / 0.06);
    const body = Math.pow(1 - t, 1.25);
    const diamonds = 0.8 + 0.2 * Math.cos(t * Math.PI * 5.5);
    const alpha = Math.max(0, Math.min(1, lip * body * diamonds * 1.15));
    const heat = Math.max(0, Math.min(1, 1 - t * 1.15));
    const lum = Math.round(255 * (0.3 + 0.7 * Math.pow(heat, 1.6)));
    for (let col = 0; col < S; col++) {
      const i = row * S + col;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = lum;
      img.data[i * 4 + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  return tex;
}
const flameTex = makeFlameTexture();

// Open cone anchored at its base, tip pointing rearward. FrontSide only: viewed down the
// exhaust axis a single shell lays exactly one additive pass over each pixel.
function plumeGeo(radius, length, seg) {
  return new THREE.ConeGeometry(radius, length, seg, 1, true)
    .rotateX(Math.PI / 2)
    .translate(0, 0, length / 2);
}

const playerRoot = new THREE.Group();
scene.add(playerRoot);

// Post-Morph Invincibility Shield Energy Dome
const shieldDome = new THREE.Mesh(
  new THREE.SphereGeometry(2.35, 24, 18),
  new THREE.MeshBasicMaterial({ color: 0x00f2fe, wireframe: true, transparent: true, opacity: 0.38 })
);
shieldDome.position.y = 0.85;
shieldDome.visible = false;
playerRoot.add(shieldDome);

// The plume glow has to stay off the paint: this light sits aft of the bumper, and at close range
// a physical point light easily blows out the clearcoat into a white blob that bloom then smears.
// So it is dim, short-ranged and parked low over the tarmac it is meant to light.
const exhaustLight = new THREE.PointLight(0x00f2fe, 0.6, 6.5);
exhaustLight.position.set(0, 0.18, 4);
playerRoot.add(exhaustLight);

const afterburnerNozzles = new THREE.Group();
const shockCones = [];
[-0.44, 0.44].forEach(nx => {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.095, 0.022, 12, 24),
    new THREE.MeshBasicMaterial({ color: 0x00f2fe })
  );
  ring.position.set(nx, 0.38, 2.15);
  afterburnerNozzles.add(ring);

  // Only the halo adds light; the hot core is a solid emissive sheet. Two additive passes over
  // the same pixels is all it takes to cross white and let bloom smear the whole nozzle.
  const mkShell = (radius, length, color, opacity, additive) => {
    const cone = new THREE.Mesh(
      plumeGeo(radius, length, 22),
      new THREE.MeshBasicMaterial({
        map: flameTex, color, transparent: true, opacity, depthWrite: false, toneMapped: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
      })
    );
    cone.position.set(nx, 0.38, 2.18);
    afterburnerNozzles.add(cone);
    return cone;
  };
  const halo = mkShell(0.15, 1.05, 0x00f2fe, 0.3, true);
  const core = mkShell(0.075, 0.6, 0xffd9a0, 0.95, false);

  // A cone viewed down its own axis can only ever paint a bright rim, which is what left the mouth
  // reading as an empty hoop. The hot core is a camera-facing billboard parked in the outlet.
  const heart = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSpriteTex, color: 0xffd9a0, transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
  }));
  heart.position.set(nx, 0.38, 2.2);
  heart.scale.set(0.17, 0.17, 0.17);
  afterburnerNozzles.add(heart);

  shockCones.push({ halo, core, ring, heart });
});
playerRoot.add(afterburnerNozzles);

// Grounded contact shadow + neon underglow pool
const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(4.1, 2.5).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({
    map: createRadialFadeTexture([[0, 'rgba(0,0,0,0.88)'], [0.45, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0)']]),
    transparent: true, depthWrite: false, fog: false
  })
);
contactShadow.position.y = 0.03;
contactShadow.renderOrder = 1;
playerRoot.add(contactShadow);

const underglow = new THREE.Mesh(
  new THREE.PlaneGeometry(4.6, 3.0).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({
    map: createRadialFadeTexture([[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]),
    color: CAR_SPECS[save.selectedCar].flameHex,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.42, fog: false
  })
);
underglow.position.y = 0.045;
underglow.renderOrder = 2;
playerRoot.add(underglow);

const exhaustPlumes = [];
function emitPlasmaExhaust(isMorphed, isShifting) {
  const jetMorph = isMorphed && CAR_SPECS[save.selectedCar].type === 'jet';
  // The shells do the flame now - these embers only smear it. They are additive AND parked between
  // the camera and the rear bodywork, so overlapping sprites used to sum past white and bloom turned
  // that into a blob burnt onto the paint. Low peak alpha, small sprites, short life.
  if (isMorphed && tick % (jetMorph ? 3 : 2) !== 0) return;
  if (!isMorphed && tick % 2 !== 0) return;
  const baseOffsets = jetMorph ? [-0.24, 0.24] : (isMorphed ? [-0.64, 0.64] : [-0.44, 0.44]);
  const baseY = jetMorph ? JET_Y + 0.02 : (isMorphed ? 0.85 : 0.38);
  const backZ = jetMorph ? 3.35 : (isMorphed ? 3.25 : 2.25);
  const initScale = isMorphed ? (jetMorph ? 0.15 : 0.17) : (isShifting ? 0.19 : 0.16);
  const peakAlpha = isMorphed ? 0.12 : 0.1;

  baseOffsets.forEach(ox => {
    const mat = new THREE.SpriteMaterial({
      map: glowSpriteTex,
      color: 0x00f2fe,
      transparent: true,
      opacity: peakAlpha,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    const spread = (Math.random() - 0.5) * 0.08;
    sprite.position.set(playerRoot.position.x + ox + spread, playerRoot.position.y + baseY + spread, playerRoot.position.z + backZ);
    sprite.scale.set(initScale, initScale, initScale);
    scene.add(sprite);

    exhaustPlumes.push({
      sprite,
      s0: initScale,
      a0: peakAlpha,
      vx: (Math.random() - 0.5) * 0.03,
      vy: (Math.random() - 0.5) * 0.02 + 0.008,
      vz: (isMorphed ? 0.5 : 0.34) + Math.random() * 0.12,
      life: 1.0,
      decay: isMorphed ? 0.2 : 0.19,
      isMorphed
    });
  });
}

function emitTireDriftSparks(dir) {
  const wheelX = dir > 0 ? -0.9 : 0.9;
  // Same additive-over-paint trap as the exhaust embers: these launch from the rear arch and climb
  // past the deck lid, so they stay small, dim and few.
  for (let i = 0; i < 9; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowSpriteTex,
      color: i % 2 === 0 ? 0xffea00 : 0xff5500,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(playerRoot.position.x + wheelX, playerRoot.position.y + 0.12, playerRoot.position.z + 1.85);
    sp.scale.setScalar(0.17);
    scene.add(sp);
    exhaustPlumes.push({
      sprite: sp,
      s0: 0.17,
      a0: 0.12,
      vx: -dir * (0.08 + Math.random() * 0.12),
      vy: 0.02 + Math.random() * 0.05,
      vz: 0.25 + Math.random() * 0.15,
      life: 0.85,
      isSpark: true
    });
  }
}

// --- REAL 3D FERRARI GLTF LOADER ---
let baseFerrariModel = null;
let playerCarMesh = new THREE.Group();
let monsterTruckGroup = new THREE.Group();
let cyberJetGroup = new THREE.Group();
let playerWheels = [];
let monsterWheels = [];
playerRoot.add(playerCarMesh, monsterTruckGroup, cyberJetGroup);
monsterTruckGroup.visible = false;
cyberJetGroup.visible = false;

// Metallic base-coat flake: drives both roughness and clearcoat roughness
function createFlakeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7d7d7d';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3200; i++) {
    const v = Math.floor(110 + Math.random() * 145);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, 0.5 + Math.random() * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}
const flakeTex = createFlakeTexture();

const carBodyMat = new THREE.MeshPhysicalMaterial({
  color: CAR_SPECS[save.selectedCar].hex,
  metalness: 0.62, roughness: 0.34, roughnessMap: flakeTex,
  clearcoat: 1.0, clearcoatRoughness: 0.07, clearcoatRoughnessMap: flakeTex,
  envMapIntensity: 1.8, reflectivity: 0.62
});
const carDetailsMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff, metalness: 1.0, roughness: 0.17, clearcoat: 0.7, clearcoatRoughness: 0.08, envMapIntensity: 2.3
});
const carGlassMat = new THREE.MeshPhysicalMaterial({
  color: 0x070c18, metalness: 0.15, roughness: 0.03, transparent: true, opacity: 0.68,
  clearcoat: 1.0, clearcoatRoughness: 0.0, ior: 1.45, envMapIntensity: 2.6
});
const carTyreMat = new THREE.MeshPhysicalMaterial({
  color: 0x0a0a10, metalness: 0.0, roughness: 0.88, clearcoat: 0.28, clearcoatRoughness: 0.55, envMapIntensity: 0.7
});

// --- WHEEL MOTION RIG -------------------------------------------------------
// A long-exposure photograph of a spinning wheel is concentric rings, so this smear decal is
// built from a radial gradient alone: any angular detail would strobe rather than blur.
function createSpinBlurTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  [
    [0.00, 'rgba(112,124,142,0.22)'],
    [0.15, 'rgba(208,220,238,0.40)'],
    [0.28, 'rgba(90,102,120,0.24)'],
    [0.46, 'rgba(190,204,224,0.30)'],
    [0.60, 'rgba(80,90,108,0.22)'],
    [0.71, 'rgba(226,238,252,0.50)'],
    [0.79, 'rgba(26,30,40,0.58)'],
    [0.91, 'rgba(11,11,17,0.82)'],
    [0.98, 'rgba(11,11,17,0.40)'],
    [1.00, 'rgba(11,11,17,0.00)']
  ].forEach(([at, col]) => g.addColorStop(at, col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const spinBlurMat = new THREE.MeshBasicMaterial({
  map: createSpinBlurTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide
});
spinBlurMat.visible = false;
const spinBlurGeo = {};
[1, -1].forEach(side => {
  const g = new THREE.CircleGeometry(1, 44);
  g.rotateY(side * Math.PI / 2);
  spinBlurGeo[side] = g;
});

// rollR is in world units because the no-slip maths runs against worldStep, while the decal
// lives in the wheel's own frame, so discR and offX stay in that rig's model units.
function rigWheel(w, rollR, discR, offX) {
  w.userData.rollR = rollR;
  const side = w.position.x >= 0 ? 1 : -1;
  const disc = new THREE.Mesh(spinBlurGeo[side], spinBlurMat);
  disc.position.x = side * offX;
  disc.scale.setScalar(discR);
  disc.renderOrder = 3;
  w.add(disc);
}

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./assets/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

gltfLoader.load(
  './assets/models/ferrari.glb',
  (gltf) => {
    document.getElementById('loaderBadge').style.opacity = '0';
    baseFerrariModel = gltf.scene.children[0];
    baseFerrariModel.scale.set(0.88, 0.88, 0.88);

    const bodyObj = baseFerrariModel.getObjectByName('body');
    if (bodyObj) bodyObj.material = carBodyMat;
    ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim'].forEach(part => {
      const obj = baseFerrariModel.getObjectByName(part);
      if (obj) obj.material = carDetailsMat;
    });
    const glassObj = baseFerrariModel.getObjectByName('glass');
    if (glassObj) glassObj.material = carGlassMat;
    // wheel_* are groups, so assigning a material to them did nothing; the rubber and the
    // barrel are the tire / wheel meshes nested inside each one.
    ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach(part => {
      const grp = baseFerrariModel.getObjectByName(part);
      if (!grp) return;
      const tyre = grp.getObjectByName('tire');
      if (tyre) tyre.material = carTyreMat;
      const barrel = grp.getObjectByName('wheel');
      if (barrel) barrel.material = carDetailsMat;
    });

    playerCarMesh.clear();
    const myFerrari = baseFerrariModel.clone();
    playerWheels = [
      myFerrari.getObjectByName('wheel_fl'),
      myFerrari.getObjectByName('wheel_fr'),
      myFerrari.getObjectByName('wheel_rl'),
      myFerrari.getObjectByName('wheel_rr')
    ].filter(Boolean);
    playerCarMesh.add(myFerrari);
    // Tire radius 0.358 and barrel half-width 0.142 in ferrari.glb units, at the 0.88 scale
    // the hub sits 0.315 above the road, which is exactly the rolling radius.
    playerWheels.forEach(w => rigWheel(w, 0.358 * baseFerrariModel.scale.x, 0.38, 0.156));

    buildMechaRexTruck();
  },
  undefined,
  (err) => {
    console.error('[TurboMorph] Ferrari model failed to load:', err);
    const badge = document.getElementById('loaderBadge');
    badge.innerText = '⚠️ Model failed to load — check assets/models/ferrari.glb';
    badge.style.borderColor = '#ff2e7e';
    badge.style.opacity = '1';
  }
);

// --- MORPH VEHICLE MATERIALS (same polish tier as the base car) ---
const MORPH_MATS = {
  paint: new THREE.MeshPhysicalMaterial({
    color: CAR_SPECS[save.selectedCar].hex,
    metalness: 0.6, roughness: 0.3, roughnessMap: flakeTex,
    clearcoat: 1.0, clearcoatRoughness: 0.06, clearcoatRoughnessMap: flakeTex,
    envMapIntensity: 1.95, side: THREE.DoubleSide
  }),
  steel: new THREE.MeshPhysicalMaterial({
    color: 0x232a38, metalness: 1.0, roughness: 0.41,
    clearcoat: 0.35, clearcoatRoughness: 0.28, envMapIntensity: 1.6
  }),
  chrome: new THREE.MeshPhysicalMaterial({
    color: CAR_SPECS[save.selectedCar].rimHex, metalness: 0.92, roughness: 0.26,
    clearcoat: 0.85, clearcoatRoughness: 0.08, envMapIntensity: 0.9
  }),
  rubber: new THREE.MeshPhysicalMaterial({
    color: 0x07070c, metalness: 0.0, roughness: 0.93,
    clearcoat: 0.22, clearcoatRoughness: 0.7, envMapIntensity: 0.55
  }),
  coil: new THREE.MeshPhysicalMaterial({
    color: 0xffc93c, metalness: 0.82, roughness: 0.28,
    clearcoat: 0.6, clearcoatRoughness: 0.18, envMapIntensity: 1.8
  }),
  canopy: new THREE.MeshPhysicalMaterial({
    color: 0x0b3a4c, metalness: 0.1, roughness: 0.02, transparent: true, opacity: 0.66,
    clearcoat: 1.0, clearcoatRoughness: 0.0, ior: 1.5,
    emissive: 0x1b7f95, emissiveIntensity: 0.5, envMapIntensity: 2.9
  }),
  lamp: new THREE.MeshStandardMaterial({
    color: 0x1a1408, emissive: 0xffe6a8, emissiveIntensity: 1.75
  }),
  glow: new THREE.MeshStandardMaterial({ color: 0x0a0a0e, emissive: CAR_SPECS[save.selectedCar].flameHex, emissiveIntensity: 1.05 }),
  red: new THREE.MeshBasicMaterial({ color: 0xff2436, toneMapped: false }),
  navGreen: new THREE.MeshBasicMaterial({ color: 0x36ff9c, toneMapped: false }),
  flameCore: new THREE.MeshBasicMaterial({
    map: flameTex, color: 0xfff0dc, transparent: true, opacity: 0.95,
    depthWrite: false, toneMapped: false
  }),
  flameSoft: new THREE.MeshBasicMaterial({
    map: flameTex, color: CAR_SPECS[save.selectedCar].flameHex, transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
  })
};

// Merge many primitives into one draw call per material.
function lump(list, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  list.push(g);
}

function bake(list, mat, target) {
  if (!list.length) return null;
  const merged = mergeGeometries(list, false);
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, mat);
  target.add(mesh);
  return mesh;
}

// Airfoil-ish flat plate. pts = [spanwise/height, forward]; -Z is world forward.
function plateGeo(pts, thickness, mirror, vertical) {
  let list = pts.map(p => [mirror ? -p[0] : p[0], p[1]]);
  if (mirror) list = list.reverse();
  const shape = new THREE.Shape();
  shape.moveTo(list[0][0], list[0][1]);
  for (let i = 1; i < list.length; i++) shape.lineTo(list[i][0], list[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true,
    bevelThickness: thickness * 0.34, bevelSize: thickness * 0.42, bevelSegments: 2, steps: 1
  });
  if (vertical) { geo.rotateZ(Math.PI / 2); geo.rotateY(-Math.PI / 2); }
  else geo.rotateX(-Math.PI / 2);
  return geo;
}

function coilGeo(length, radius, turns) {
  const pts = [];
  const n = turns * 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new THREE.Vector3(
      Math.cos(t * turns * Math.PI * 2) * radius,
      t * length,
      Math.sin(t * turns * Math.PI * 2) * radius
    ));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, 0.036, 6, false);
}

function buildMonsterWheel(radius, width) {
  const wheel = new THREE.Group();
  const tyre = [];
  const hub = [];
  const axle = Math.PI / 2;

  lump(tyre, new THREE.CylinderGeometry(radius, radius * 0.97, width, 30, 1, false), 0, 0, 0, 0, 0, axle);
  const rows = 3, lugs = 15;
  for (let r = 0; r < rows; r++) {
    const rowX = (r - (rows - 1) / 2) * width * 0.36;
    for (let i = 0; i < lugs; i++) {
      const a = ((i + r * 0.5) / lugs) * Math.PI * 2;
      lump(tyre, new THREE.BoxGeometry(width * 0.27, radius * 0.22, 0.15),
        rowX, Math.cos(a) * (radius + 0.05), Math.sin(a) * (radius + 0.05), a);
    }
  }
  [-1, 1].forEach(s => lump(tyre, new THREE.TorusGeometry(radius * 0.9, 0.078, 8, 28),
    s * (width / 2 - 0.03), 0, 0, 0, axle));

  const face = width / 2 + 0.025;
  lump(hub, new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.09, 24), face, 0, 0, 0, 0, axle);
  lump(hub, new THREE.TorusGeometry(radius * 0.62, 0.038, 6, 26), face + 0.045, 0, 0, 0, axle);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    lump(hub, new THREE.BoxGeometry(0.1, radius * 0.62, 0.15),
      face + 0.045, Math.cos(a) * radius * 0.31, Math.sin(a) * radius * 0.31, a);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    lump(hub, new THREE.CylinderGeometry(0.05, 0.05, 0.09, 8),
      face + 0.08, Math.cos(a) * radius * 0.48, Math.sin(a) * radius * 0.48, 0, 0, axle);
  }
  lump(hub, new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, 0.2, 16), face + 0.09, 0, 0, 0, 0, axle);
  lump(hub, new THREE.CylinderGeometry(radius * 0.46, radius * 0.46, 0.07, 20), -(face), 0, 0, 0, 0, axle);

  bake(tyre, MORPH_MATS.rubber, wheel);
  bake(hub, MORPH_MATS.chrome, wheel);
  return wheel;
}

let truckBodyGroup = null;

function buildMechaRexTruck() {
  monsterTruckGroup.clear();
  monsterWheels = [];

  const body = new THREE.Group();
  const shell = baseFerrariModel.clone();
  shell.position.set(0, 1.0, 0);
  shell.scale.set(1.12, 1.18, 1.06);
  ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach(n => {
    const o = shell.getObjectByName(n);
    if (o) o.visible = false;
  });
  body.add(shell);

  const steel = [], chrome = [], lamps = [], glow = [], reds = [], coils = [];

  // Ladder frame + cross-members
  [-0.98, 0.98].forEach(x => lump(steel, new THREE.BoxGeometry(0.24, 0.26, 5.6), x, 0.8, 0));
  for (let i = 0; i < 5; i++) lump(steel, new THREE.BoxGeometry(1.98, 0.18, 0.24), 0, 0.8, -2.35 + i * 1.18);
  // Skid plate, rock sliders, rear guard
  lump(steel, new THREE.BoxGeometry(1.94, 0.1, 1.9), 0, 0.4, -1.75, 0.16);
  [-1.16, 1.16].forEach(x => lump(steel, new THREE.BoxGeometry(0.26, 0.18, 2.7), x, 0.62, 0.1));
  lump(steel, new THREE.BoxGeometry(2.3, 0.38, 0.34), 0, 0.82, -2.92);
  lump(steel, new THREE.BoxGeometry(2.24, 0.34, 0.3), 0, 0.86, 2.9);
  [-1, 1].forEach(s => lump(steel, new THREE.BoxGeometry(0.95, 0.62, 0.08), s * 1.22, 0.46, 2.66));
  // A-frame bumper guards
  [-1, 1].forEach(s => lump(steel, new THREE.BoxGeometry(0.17, 0.95, 0.17), s * 0.88, 1.16, -2.86, -0.12));

  // Winch, exhaust stacks, roll hoop
  lump(chrome, new THREE.CylinderGeometry(0.17, 0.17, 0.94, 18), 0, 0.95, -2.74, 0, 0, Math.PI / 2);
  [-0.26, 0.26].forEach(x => lump(chrome, new THREE.TorusGeometry(0.12, 0.045, 8, 18), x, 0.95, -2.88));
  [-0.64, 0.64].forEach(x => {
    lump(chrome, new THREE.CylinderGeometry(0.085, 0.1, 1.3, 16), x, 1.72, 0.62, -0.09);
    lump(chrome, new THREE.TorusGeometry(0.095, 0.035, 8, 16), x, 2.36, 0.56, Math.PI / 2);
  });
  [-1.02, 1.02].forEach(x => lump(chrome, new THREE.CylinderGeometry(0.062, 0.062, 0.9, 12), x, 1.86, 0.35));
  lump(chrome, new THREE.CylinderGeometry(0.062, 0.062, 2.14, 12), 0, 2.3, 0.35, 0, 0, Math.PI / 2);

  // Light bar, spot pods, head lamps
  for (let i = 0; i < 5; i++) lump(lamps, new THREE.BoxGeometry(0.25, 0.15, 0.09), -0.58 + i * 0.29, 1.24, -2.78);
  [-0.86, 0.86].forEach(x => lump(lamps, new THREE.CylinderGeometry(0.17, 0.17, 0.1, 18), x, 1.46, -2.68, Math.PI / 2));
  [-0.56, 0.56].forEach(x => lump(glow, new THREE.SphereGeometry(0.1, 12, 10), x, 1.02, -2.4));
  [-0.62, 0.62].forEach(x => lump(reds, new THREE.BoxGeometry(0.52, 0.13, 0.07), x, 1.16, 2.94));

  // Fender flares over the big tyres
  [[-1.3, -1.92], [1.3, -1.92], [-1.3, 1.96], [1.3, 1.96]].forEach(([fx, fz], i) => {
    lump(steel, new THREE.BoxGeometry(0.98, 0.15, 1.55), fx, 1.62, fz, 0, 0, (i % 2 ? -0.16 : 0.16));
  });

  // Coil-over suspension
  [[-1.24, -1.86], [1.24, -1.86], [-1.24, 1.9], [1.24, 1.9]].forEach(([sx, sz]) => {
    lump(coils, coilGeo(0.8, 0.17, 7), sx, 0.34, sz);
    lump(steel, new THREE.CylinderGeometry(0.055, 0.055, 1.1, 10), sx, 0.86, sz);
    lump(steel, new THREE.CylinderGeometry(0.11, 0.11, 0.14, 10), sx, 1.42, sz);
  });

  bake(steel, MORPH_MATS.steel, body);
  bake(chrome, MORPH_MATS.chrome, body);
  bake(lamps, MORPH_MATS.lamp, body);
  bake(glow, MORPH_MATS.glow, body);
  bake(reds, MORPH_MATS.red, body);
  bake(coils, MORPH_MATS.coil, body);
  monsterTruckGroup.add(body);
  truckBodyGroup = body;

  [[-1.28, -1.92], [1.28, -1.92], [-1.28, 1.96], [1.28, 1.96]].forEach(([wx, wz]) => {
    const w = buildMonsterWheel(0.94, 0.74);
    w.position.set(wx, 0.94, wz);
    // Hub hardware stands proud of the 0.74 tread, so the decal clears the spokes and the 0.94
    // ride height is the contact radius. The disc reaches the 1.09 lug tips.
    rigWheel(w, 0.94, 1.08, 0.55);
    monsterTruckGroup.add(w);
    monsterWheels.push(w);
  });
}

const JET_Y = 1.14;

function buildStealthJet() {
  cyberJetGroup.clear();

  const paint = [], steel = [], chrome = [], canopy = [], glow = [], reds = [], greens = [];

  // Lathe-turned fuselage: profile = [radius, forward], nose closes at both ends
  const prof = [
    [0.001, -2.46], [0.2, -2.4], [0.32, -2.16], [0.38, -1.7], [0.43, -1.05],
    [0.48, -0.35], [0.5, 0.3], [0.47, 0.95], [0.4, 1.55], [0.3, 2.02],
    [0.16, 2.38], [0.001, 2.5]
  ].map(([r, s]) => new THREE.Vector2(r, s));
  lump(paint, new THREE.LatheGeometry(prof, 44), 0, JET_Y, 0, -Math.PI / 2);

  // Canopy, dorsal spine, pitot
  const cg = new THREE.SphereGeometry(0.42, 26, 18);
  cg.scale(0.94, 0.56, 1.95);
  lump(canopy, cg, 0, JET_Y + 0.33, -0.98);
  lump(canopy, new THREE.TorusGeometry(0.34, 0.032, 8, 26), 0, JET_Y + 0.26, -0.55, Math.PI / 2);
  lump(steel, new THREE.BoxGeometry(0.12, 0.4, 2.3), 0, JET_Y + 0.4, 0.75);
  lump(chrome, new THREE.CylinderGeometry(0.028, 0.028, 0.62, 10), 0, JET_Y, -2.75, Math.PI / 2);
  lump(glow, new THREE.SphereGeometry(0.07, 12, 10), 0, JET_Y + 0.02, -2.35);

  // Main delta wings (spanwise, forward chord)
  const wingPts = [[0.06, 1.02], [0.6, 0.5], [1.1, -0.08], [1.16, -0.22], [0.66, -0.44], [0.06, -1.3]];
  [1, -1].forEach(side => lump(paint, plateGeo(wingPts, 0.11, side < 0), 0, JET_Y - 0.04, 0.34, 0, 0, side * 0.075));
  // Leading-edge chrome strips
  const lePts = [[0.1, 1.06], [0.62, 0.54], [1.12, -0.04], [1.06, -0.14], [0.58, 0.4], [0.1, 0.9]];
  [1, -1].forEach(side => lump(chrome, plateGeo(lePts, 0.05, side < 0), side * 0.01, JET_Y + 0.07, 0.32, 0, 0, side * 0.075));

  // Tailplanes + canted twin fins
  const stabPts = [[0.05, 0.52], [0.5, 0.08], [0.52, -0.06], [0.05, -0.6]];
  [1, -1].forEach(side => lump(steel, plateGeo(stabPts, 0.08, side < 0), 0, JET_Y - 0.02, 1.72, 0, 0, side * 0.13));
  const finPts = [[0.02, 0.9], [0.5, -0.3], [0.56, -0.66], [0.06, -0.78]];
  [1, -1].forEach(side => lump(paint, plateGeo(finPts, 0.09, false, true), side * 0.3, JET_Y + 0.16, 1.5, 0, 0, -side * 0.34));

  // Engine intakes
  [-0.54, 0.54].forEach(x => {
    lump(steel, new THREE.BoxGeometry(0.32, 0.38, 1.1), x, JET_Y + 0.02, -0.25, 0, x > 0 ? -0.1 : 0.1);
    lump(glow, new THREE.BoxGeometry(0.22, 0.24, 0.07), x, JET_Y + 0.02, -0.78);
  });

  // Twin afterburners: chrome canshel, petal chevrons and a two-shell plume out of the exit cone
  jetPlumes = [];
  jetHearts = [];
  [-0.24, 0.24].forEach(x => {
    lump(chrome, new THREE.CylinderGeometry(0.2, 0.235, 0.78, 22, 1, true), x, JET_Y, 2.28, Math.PI / 2);
    lump(chrome, new THREE.TorusGeometry(0.205, 0.04, 10, 26), x, JET_Y, 2.0);
    lump(chrome, new THREE.TorusGeometry(0.245, 0.045, 10, 26), x, JET_Y, 2.64);
    for (let p = 0; p < 6; p++) {
      lump(chrome, plumeGeo(0.062, 0.3, 5).translate(0, 0.195, 0), x, JET_Y, 2.66, 0, 0, (p / 6) * Math.PI * 2);
    }
    lump(glow, new THREE.SphereGeometry(0.045, 10, 8), x, JET_Y, 2.62);

    const plume = new THREE.Group();
    plume.position.set(x, JET_Y, 2.66);
    const halo = [], core = [];
    lump(halo, plumeGeo(0.3, 1.35, 24));
    lump(core, plumeGeo(0.155, 0.85, 20));
    bake(halo, MORPH_MATS.flameSoft, plume);
    bake(core, MORPH_MATS.flameCore, plume);
    cyberJetGroup.add(plume);
    jetPlumes.push(plume);

    // Cones viewed down their own axis can only ever be a bright rim, so the hottest part of the
    // plume is a camera-facing billboard parked in the nozzle mouth.
    const heart = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowSpriteTex, color: 0xffe9c0, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    heart.position.set(x, JET_Y, 2.9);
    heart.scale.set(0.42, 0.42, 0.42);
    cyberJetGroup.add(heart);
    jetHearts.push(heart);
  });

  // Wingtip pods, nav lights, trailing-edge plasma strips
  [-1, 1].forEach(side => {
    lump(chrome, new THREE.BoxGeometry(0.14, 0.12, 0.6), side * 1.14, JET_Y - 0.03, 0.28, 0, 0, side * 0.075);
    lump(glow, new THREE.SphereGeometry(0.055, 12, 10), side * 1.19, JET_Y - 0.05, 0.24);
    lump(side < 0 ? reds : greens, new THREE.SphereGeometry(0.055, 12, 10), side * 1.2, JET_Y + 0.03, 0.3);
    lump(glow, new THREE.BoxGeometry(0.1, 0.035, 0.55), side * 0.55, JET_Y - 0.065, 0.55);
  });

  bake(paint, MORPH_MATS.paint, cyberJetGroup);
  bake(steel, MORPH_MATS.steel, cyberJetGroup);
  bake(chrome, MORPH_MATS.chrome, cyberJetGroup);
  bake(canopy, MORPH_MATS.canopy, cyberJetGroup);
  bake(glow, MORPH_MATS.glow, cyberJetGroup);
  bake(reds, MORPH_MATS.red, cyberJetGroup);
  bake(greens, MORPH_MATS.navGreen, cyberJetGroup);
}

let jetPlumes = [];
let jetHearts = [];
buildStealthJet();

function updatePlayerPaint() {
  const spec = CAR_SPECS[save.selectedCar];
  carBodyMat.color.setHex(spec.hex);
  carDetailsMat.color.setHex(spec.rimHex);
  exhaustLight.color.setHex(spec.flameHex);
  underglow.material.color.setHex(spec.flameHex);
  neonRing.material.color.setHex(spec.rimHex);
  shockCones.forEach(sc => {
    sc.halo.material.color.setHex(spec.flameHex);
    sc.ring.material.color.setHex(spec.flameHex);
  });
  MORPH_MATS.paint.color.setHex(spec.hex);
  MORPH_MATS.chrome.color.setHex(spec.rimHex);
  MORPH_MATS.coil.color.setHex(spec.rimHex === 0xffffff ? 0xffc93c : spec.rimHex);
  MORPH_MATS.glow.emissive.setHex(spec.flameHex);
  MORPH_MATS.flameSoft.color.setHex(spec.flameHex);
  MORPH_MATS.canopy.emissive.setHex(spec.flameHex);
}

// --- GAMEPLAY STATE & METRICS ---
let lane = 1, playerY = 0, velY = 0;
let speed = 0.82, score = 0, runCoins = 0, smashes = 0, nearMisses = 0, combo = 1, comboTimer = 0;
let morphTimer = 0, morphMaxFrames = 480, shieldTimer = 0, shakeIntensity = 0;
let magnetTimer = 0, magnetMax = 1, nextMagnetIn = 150;
let morphPunch = 0;
let nextMilestone = 500;
let obstacles = [], coins = [], magnetPickups = [], particles = [], brainGateGroup = null;
let showroomAngle = 0.6, isDraggingShowroom = false, lastDragX = 0;

function spawnExplosion3D(pos, hexColor, count = 24) {
  const geo = new THREE.OctahedronGeometry(0.26, 0);
  const mat = new THREE.MeshBasicMaterial({ color: hexColor });
  for (let i = 0; i < count; i++) {
    const p = new THREE.Mesh(geo, mat);
    p.position.copy(pos); p.position.y += 0.7;
    scene.add(p);
    particles.push({
      mesh: p,
      vx: (Math.random() - 0.5) * 0.7,
      vy: Math.random() * 0.55 + 0.15,
      vz: (Math.random() - 0.5) * 0.7,
      life: 1.0
    });
  }
}

function createGateTexture(numStr, borderHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const cx = c.getContext('2d');
  cx.fillStyle = 'rgba(10, 4, 32, 0.86)';
  cx.fillRect(0, 0, 256, 256);
  cx.strokeStyle = borderHex;
  cx.lineWidth = 22;
  cx.strokeRect(11, 11, 234, 234);
  cx.fillStyle = '#ffffff';
  cx.font = '900 120px sans-serif';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText(numStr, 128, 134);
  return new THREE.CanvasTexture(c);
}

function spawnReflexGate3D(allowed) {
  let a, b, correct, wrong, qText;
  if (score < 400) {
    a = Math.floor(Math.random() * 7) + 2; b = Math.floor(Math.random() * 6) + 2;
    correct = a + b; wrong = correct + (Math.random() > 0.5 ? 2 : -1);
    qText = `${a} + ${b} = ?`;
  } else {
    a = Math.floor(Math.random() * 8) + 2; b = Math.floor(Math.random() * 6) + 2;
    correct = a * b; wrong = correct + (Math.random() > 0.5 ? 3 : -2);
    qText = `${a} × ${b} = ?`;
  }

  // The answer lane is drawn from the lanes the caller already proved traffic-free, so a gate can
  // never demand a lane change straight into a car. (`correct` above is the arithmetic result.)
  const answerLane = allowed[Math.floor(Math.random() * allowed.length)];
  const rightIsLeft = answerLane === 0;
  brainGateGroup = new THREE.Group();
  brainGateGroup.position.z = -135;

  const portalGeo = new THREE.BoxGeometry(3.1, 3.8, 0.35);
  const leftMesh = new THREE.Mesh(portalGeo, new THREE.MeshBasicMaterial({ map: createGateTexture(rightIsLeft ? correct : wrong, '#00f2fe') }));
  leftMesh.position.set(LANES[0], 1.9, 0);
  const rightMesh = new THREE.Mesh(portalGeo, new THREE.MeshBasicMaterial({ map: createGateTexture(!rightIsLeft ? correct : wrong, '#ff0066') }));
  rightMesh.position.set(LANES[2], 1.9, 0);

  brainGateGroup.add(leftMesh, rightMesh);
  brainGateGroup.userData = { correctLane: answerLane };
  scene.add(brainGateGroup);

  const banner = document.getElementById('brainBanner');
  banner.innerText = qText;
  banner.style.display = 'block';
}

// The gate asks the player to commit to a lane seconds before it arrives, so the answer lane has
// to be empty for the whole decision stretch — otherwise the puzzle is a coin flip against a wall.
function trySpawnReflexGate() {
  const allowed = [0, 2].filter(l => laneOpen(l, -160, -40, false));
  if (allowed.length) spawnReflexGate3D(allowed);
}

function shiftLane(dir) {
  if (state !== 'PLAYING') return;
  const next = Math.max(0, Math.min(2, lane + dir));
  if (next !== lane) {
    lane = next;
    playerRoot.rotation.z = -dir * 0.19;
    sound.playTireScreech();
    emitTireDriftSparks(dir);
  }
}

function triggerJump() {
  if (state === 'PLAYING' && playerY <= 0.05) {
    velY = 0.44;
    sound.playJumpWhoosh();
  }
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
    if (state === 'PLAYING') window.pauseGame();
    else if (state === 'PAUSED') window.resumeGame();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'a') shiftLane(-1);
  if (e.key === 'ArrowRight' || e.key === 'd') shiftLane(1);
  if (e.key === 'ArrowUp' || e.key === ' ') triggerJump();
});

// Interactive 360° Showroom Spin (Mouse & Touch) + In-Game Steering
renderer.domElement.addEventListener('pointerdown', e => {
  if (state === 'MENU') {
    isDraggingShowroom = true;
    lastDragX = e.clientX;
  }
});
window.addEventListener('pointermove', e => {
  if (isDraggingShowroom && state === 'MENU') {
    const dx = e.clientX - lastDragX;
    lastDragX = e.clientX;
    showroomAngle += dx * 0.012;
  }
});
window.addEventListener('pointerup', () => { isDraggingShowroom = false; });

let sx = 0, sy = 0, stime = 0;
renderer.domElement.addEventListener('touchstart', e => {
  sx = e.touches[0].clientX;
  sy = e.touches[0].clientY;
  stime = Date.now();
}, { passive: true });

renderer.domElement.addEventListener('touchend', e => {
  if (state !== 'PLAYING') return;
  const dx = e.changedTouches[0].clientX - sx;
  const dy = e.changedTouches[0].clientY - sy;
  const dist = Math.hypot(dx, dy);
  const mode = save.settings.controls || 'both';

  if ((mode === 'swipe' || mode === 'both') && dist > 24) {
    if (Math.abs(dx) > Math.abs(dy)) shiftLane(dx > 0 ? 1 : -1);
    else if (dy < -24) triggerJump();
    return;
  }

  if ((mode === 'tap' || mode === 'both') && dist <= 24 && (Date.now() - stime) < 280) {
    const rect = wrapper.getBoundingClientRect();
    const relX = (e.changedTouches[0].clientX - rect.left) / rect.width;
    if (relX < 0.36) shiftLane(-1);
    else if (relX > 0.64) shiftLane(1);
    else triggerJump();
  }
}, { passive: true });

// --- PAUSE, RESUME, RESTART, QUIT & RESULTS FLOW ---
window.pauseGame = () => {
  if (state !== 'PLAYING') return;
  state = 'PAUSED';
  sound.isPaused = true;
  document.getElementById('pauseStatsTxt').innerText = `${Math.floor(score)}m  |  +${runCoins} COINS`;
  document.getElementById('pauseModal').style.display = 'flex';
};

window.resumeGame = () => {
  if (state !== 'PAUSED') return;
  sound.init(() => state === 'PLAYING');
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  sound.isPaused = false;
  state = 'PLAYING';
};

window.restartRace = () => {
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('resultsModal').style.display = 'none';
  sound.isPaused = false;
  startRun(false);
};

window.closeResultsToGarage = () => {
  document.getElementById('resultsModal').style.display = 'none';
  window.quitToGarage();
};

window.quitToGarage = () => {
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('resultsModal').style.display = 'none';
  sound.isPaused = false;
  state = 'MENU';
  podiumGroup.visible = true;
  morphTimer = 0;
  shieldTimer = 0;
  shieldDome.visible = false;
  playerCarMesh.visible = true;
  monsterTruckGroup.visible = false;
  cyberJetGroup.visible = false;

  isMorphPreview = false;
  setPreviewLabel(false);
  clearStuntProps();
  shiftBiome(0, true);

  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }
  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];
  clearMagnetState();

  document.getElementById('brainBanner').style.display = 'none';
  document.getElementById('morphHud').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'none';
  document.getElementById('pauseBtn').style.display = 'none';
  document.getElementById('comboPill').style.display = 'none';
  document.getElementById('speedLines').style.opacity = '0';

  save.best = Math.max(save.best, Math.floor(score));
  syncUI();
  document.getElementById('menuOverlay').style.display = 'flex';
};

let stateBeforeSettings = 'MENU';
window.openSettings = () => {
  sound.init(() => state === 'PLAYING');
  if (state === 'PLAYING') {
    stateBeforeSettings = 'PLAYING';
    state = 'PAUSED';
    sound.isPaused = true;
  } else {
    stateBeforeSettings = state;
  }
  syncSettingsUI();
  document.getElementById('settingsModal').style.display = 'flex';
};

window.closeSettings = () => {
  document.getElementById('settingsModal').style.display = 'none';
  if (stateBeforeSettings === 'PLAYING' && document.getElementById('pauseModal').style.display !== 'flex') {
    sound.isPaused = false;
    state = 'PLAYING';
  }
};

window.toggleSetting = (key) => {
  save.settings[key] = !save.settings[key];
  sound.applySettings(save.settings);
  if (key === 'sfx' && save.settings.sfx) sound.playCoinChime(4);
  syncSettingsUI();
  syncUI();
};

window.setControlMode = (mode) => {
  save.settings.controls = mode;
  sound.playCoinChime(6);
  syncSettingsUI();
  syncUI();
};

function syncSettingsUI() {
  const map = [
    ['music', 'toggleMusicBtn'],
    ['sfx', 'toggleSfxBtn'],
    ['voice', 'toggleVoiceBtn'],
    ['haptics', 'toggleHapticsBtn']
  ];
  map.forEach(([k, btnId]) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    const isOn = save.settings[k] !== false;
    el.innerText = isOn ? 'ON' : 'OFF';
    el.className = `toggle-pill ${isOn ? 'on' : 'off'}`;
  });

  const cMode = save.settings.controls || 'both';
  document.getElementById('ctrlSwipe').classList.toggle('active', cMode === 'swipe');
  document.getElementById('ctrlTap').classList.toggle('active', cMode === 'tap');
  document.getElementById('ctrlBoth').classList.toggle('active', cMode === 'both');
}

function tuningLevel(part) {
  return Math.max(1, Math.min(5, save.tuning[part] || 1));
}
// Display-only Performance Rating: chassis tier sets the floor, the three upgrade ladders add
// up to +96, and 999 caps the scale so a fully tuned MYTHIC reads as a ceiling number.
function carPR(idx) {
  const earned = (tuningLevel('speed') - 1) + (tuningLevel('morph') - 1) + (tuningLevel('magnet') - 1);
  return Math.min(999, CAR_SPECS[idx].basePr + earned * 8);
}
// Normalised so every level on every car moves the bar — raw baseSpd tops out at 100.
function speedPct(finalSpd) {
  return Math.round(55 + ((finalSpd - 78) / 46) * 45);
}
function finalSpeed(idx) {
  return CAR_SPECS[idx].baseSpd + (tuningLevel('speed') - 1) * 6;
}
function morphSecs(idx) {
  return (8.0 + tuningLevel('morph') * 1.5 + idx * 0.5).toFixed(1);
}
function morphFrames() {
  return 480 + tuningLevel('morph') * 90;
}
function magnetFrames() {
  return 240 + tuningLevel('magnet') * 40;
}
function pipBar(el, lvl) {
  el.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('span');
    s.className = `pip${i < lvl ? ' filled' : ''}`;
    el.appendChild(s);
  }
}

function syncUI() {
  persist();
  document.getElementById('coinVal').innerText = save.coins;
  document.getElementById('scoreVal').innerText = Math.floor(score);
  document.getElementById('bestScoreBadge').innerText = save.best;

  const spec = CAR_SPECS[save.selectedCar];
  const owned = save.unlocked.includes(save.selectedCar);
  document.getElementById('carNameTxt').innerText = spec.name;
  document.getElementById('carPrBadge').innerText = `PR ${carPR(save.selectedCar)}`;
  document.getElementById('carMorphTxt').innerText = `MORPH SYSTEM: ${spec.morph.toUpperCase()}`;

  const ownedTag = document.getElementById('carOwnedTag');
  ownedTag.innerText = owned ? 'EQUIPPED' : `LOCKED ${spec.price}`;
  ownedTag.className = `owned-tag ${owned ? '' : 'locked'}`;

  // 4-car thumbnail dock
  const carousel = document.getElementById('carCarousel');
  carousel.innerHTML = '';
  CAR_SPECS.forEach((c, i) => {
    const isOwned = save.unlocked.includes(i);
    const thumb = document.createElement('button');
    thumb.className = `car-thumb${save.selectedCar === i ? ' active' : ''}${isOwned ? '' : ' locked-thumb'}`;
    thumb.onclick = () => window.selectCar(i);
    thumb.innerHTML = `<span class="thumb-swatch" style="background:#${c.hex.toString(16).padStart(6, '0')};color:#${c.hex.toString(16).padStart(6, '0')};"></span>`
      + `<span class="thumb-name">${c.short}</span>`
      + `<span class="thumb-tier tier-${c.tier}">${isOwned ? c.tier : 'LOCK ' + c.price}</span>`;
    carousel.appendChild(thumb);
  });

  // Telemetry bars
  const spd = finalSpeed(save.selectedCar);
  const spdPct = speedPct(spd);
  const mSecs = morphSecs(save.selectedCar);
  const magPct = Math.min(100, 40 + tuningLevel('magnet') * 12);
  document.getElementById('statSpdVal').innerText = `${spdPct}%`;
  document.getElementById('statSpdBar').style.width = `${spdPct}%`;
  document.getElementById('statMorphVal').innerText = `${mSecs}s`;
  document.getElementById('statMorphBar').style.width = `${Math.min(100, (parseFloat(mSecs) / 18) * 100)}%`;
  document.getElementById('statMagVal').innerText = `LV.${tuningLevel('magnet')}`;
  document.getElementById('statMagBar').style.width = `${magPct}%`;

  // Tuning bay pips + costs
  [['speed', 'pipsSpeed', 'btnUpgSpeed'], ['morph', 'pipsMorph', 'btnUpgMorph'], ['magnet', 'pipsMagnet', 'btnUpgMagnet']]
    .forEach(([part, pipsId, btnId]) => {
      const lvl = tuningLevel(part);
      pipBar(document.getElementById(pipsId), lvl);
      const btn = document.getElementById(btnId);
      if (lvl >= 5) {
        btn.innerText = 'MAX';
        btn.classList.add('maxed');
      } else {
        btn.innerHTML = `<span class="coin-icon mini"></span> ${lvl * 150}`;
        btn.classList.remove('maxed');
      }
    });

  // Neon studio swatch state
  document.querySelectorAll('.neon-swatch').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.hex, 16) === spec.rimHex);
  });

  // Live mission tracker
  updateMissionBanner();

  // The crate is a garage affordance — keep it out of the race HUD. It is now the rewards entry
  // point, so it stays put while either payout is waiting and dims once both are banked.
  const cratePing = (streakClaimable() || chestsReady() > 0) && state === 'MENU';
  const crateBtn = document.getElementById('crateBtn');
  crateBtn.style.display = state === 'MENU' ? 'flex' : 'none';
  crateBtn.classList.toggle('claimed', !cratePing);
  document.getElementById('headstartBtn').style.display = owned ? 'none' : 'flex';

  // Headstart prices itself out of the token wallet first, coins second.
  document.getElementById('hsCostTxt').innerHTML = save.ent.headstarts > 0
    ? `TOKEN · ${save.ent.headstarts} LEFT`
    : `<span class="coin-icon mini"></span> ${HEADSTART_COST}`;
  updateHubBadges();

  const mainBtn = document.getElementById('mainPlayBtn');
  mainBtn.classList.toggle('locked', !owned);
  mainBtn.innerHTML = owned
    ? '<span class="btn-label">TAP TO RACE</span><span class="btn-chev">▸</span>'
    : `<span class="btn-label">UNLOCK ${spec.short}</span><span class="cost"><span class="coin-icon mini"></span>${spec.price}</span>`;
}

window.cycleCar = (dir) => {
  window.selectCar((save.selectedCar + dir + CAR_SPECS.length) % CAR_SPECS.length);
};

window.handleMainBtn = () => {
  sound.init(() => state === 'PLAYING');
  const spec = CAR_SPECS[save.selectedCar];
  if (save.unlocked.includes(save.selectedCar)) {
    startRun(false);
  } else if (save.coins >= spec.price) {
    save.coins -= spec.price;
    save.unlocked.push(save.selectedCar);
    sound.playMorphPowerup();
    showComicPopup("FERRARI UNLOCKED!", "#00ff87");
    syncUI();
  } else {
    showComicPopup(`NEED ${spec.price - save.coins} COINS!`, "#ff0055");
  }
};

window.selectCar = (idx) => {
  sound.init(() => state === 'PLAYING');
  save.selectedCar = idx;
  updatePlayerPaint();
  if (isMorphPreview) {
    const morphType = CAR_SPECS[idx].type;
    playerCarMesh.visible = false;
    monsterTruckGroup.visible = (morphType === 'truck');
    cyberJetGroup.visible = (morphType === 'jet');
  }
  sound.triggerExhaustBackfire();
  syncUI();
};

window.switchGarageTab = (tab) => {
  sound.init(() => state === 'PLAYING');
  garageTab = tab;
  sound.playCoinChime(3);

  document.getElementById('tabShowroom').classList.toggle('active', tab === 'showroom');
  document.getElementById('tabTuning').classList.toggle('active', tab === 'tuning');
  document.getElementById('tabNeon').classList.toggle('active', tab === 'neon');

  document.getElementById('panelShowroom').style.display = tab === 'showroom' ? 'grid' : 'none';
  document.getElementById('panelTuning').style.display = tab === 'tuning' ? 'grid' : 'none';
  document.getElementById('panelNeon').style.display = tab === 'neon' ? 'flex' : 'none';

  // Swoop the showroom camera to match the active inspection bay
  if (tab === 'showroom') {
    showroomCamTarget.set(0, 2.15, 6.5);
    showroomLookTarget.set(0, 0.55, 0);
  } else if (tab === 'tuning') {
    showroomCamTarget.set(2.4, 1.55, 5.2);
    showroomLookTarget.set(0, 0.65, 0);
  } else if (tab === 'neon') {
    showroomCamTarget.set(-2.2, 1.05, 4.9);
    showroomLookTarget.set(0, 0.35, 0);
  }
};

// The preview pill owns an inline SVG, so rewriting its innerText would delete the icon.
function setPreviewLabel(onMorph) {
  const btn = document.getElementById('morphPreviewBtn');
  if (!btn) return;
  btn.classList.toggle('morph-active', onMorph);
  document.getElementById('morphPreviewTxt').innerText = onMorph ? 'SHOWROOM VIEW' : 'MORPH PREVIEW';
}

window.toggleMorphPreview = () => {
  sound.init(() => state === 'PLAYING');
  isMorphPreview = !isMorphPreview;
  setPreviewLabel(isMorphPreview);

  const morphType = CAR_SPECS[save.selectedCar].type;
  playerCarMesh.visible = !isMorphPreview;
  monsterTruckGroup.visible = isMorphPreview && morphType === 'truck';
  cyberJetGroup.visible = isMorphPreview && morphType === 'jet';

  spawnExplosion3D(playerRoot.position, isMorphPreview ? 0x00ff87 : 0x00f2fe, 22);
  sound.playMorphPowerup();
};

window.resetShowroomCamera = () => {
  showroomAngle = 0.6;
  isMorphPreview = false;
  playerCarMesh.visible = true;
  monsterTruckGroup.visible = false;
  cyberJetGroup.visible = false;
  setPreviewLabel(false);
  window.switchGarageTab('showroom');
};

window.upgradePart = (part) => {
  sound.init(() => state === 'PLAYING');
  const lvl = tuningLevel(part);
  if (lvl >= 5) {
    showComicPopup('MAX LEVEL REACHED!', "#00ff87");
    return;
  }
  const cost = lvl * 150;
  if (save.coins >= cost) {
    save.coins -= cost;
    save.tuning[part] = lvl + 1;
    save.nitroLevel = Math.max(save.nitroLevel || 1, save.tuning.morph);
    spawnExplosion3D(playerRoot.position, 0x00ff87, 20);
    sound.playMorphPowerup();
    showComicPopup(`${part.toUpperCase()} LV.${save.tuning[part]}!`, "#00ff87");
    syncUI();
  } else {
    showComicPopup(`NEED ${cost - save.coins} COINS!`, "#ff0055");
  }
};

window.setNeonAccent = (hexColor, btnEl) => {
  sound.init(() => state === 'PLAYING');
  const spec = CAR_SPECS[save.selectedCar];
  spec.rimHex = spec.flameHex = hexColor;
  save.customNeon[save.selectedCar] = hexColor;
  neonRing.material.color.setHex(hexColor);
  updatePlayerPaint();
  sound.playCoinChime(5);
  document.querySelectorAll('.neon-swatch').forEach(el => el.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  syncUI();
};

window.useHeadstartMorph = () => {
  sound.init(() => state === 'PLAYING');
  // Tokens are the paid/reward currency and get spent before coins; the old "free if you are
  // broke" branch handed the morph to anyone who never banked a coin.
  if (save.ent.headstarts > 0) {
    save.ent.headstarts--;
    syncUI();
    startRun(true);
  } else if (save.coins >= HEADSTART_COST) {
    save.coins -= HEADSTART_COST;
    syncUI();
    startRun(true);
  } else {
    sound.triggerExhaustBackfire();
    showComicPopup(`NEED ${HEADSTART_COST} COINS OR A TOKEN`, '#ff0055');
  }
};

window.useReviveShield = () => {
  sound.init(() => state === 'PLAYING');
  if (save.coins >= 100) {
    save.coins -= 100;
  }
  syncUI();
  document.getElementById('resultsModal').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'flex';
  document.getElementById('pauseBtn').style.display = 'flex';
  podiumGroup.visible = false;
  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  activateMorphState(morphFrames());
  sound.isPaused = false;
  state = 'PLAYING';
};

function activateMorphState(frames = 480) {
  morphTimer = frames;
  morphMaxFrames = frames;
  shieldTimer = 0;
  shieldDome.visible = false;
  const morphType = CAR_SPECS[save.selectedCar].type;
  playerCarMesh.visible = false;
  monsterTruckGroup.visible = (morphType === 'truck');
  cyberJetGroup.visible = (morphType === 'jet');
  morphPunch = 1;
  monsterTruckGroup.position.set(0, 0, 0);
  cyberJetGroup.position.set(0, 0, 0);
  monsterTruckGroup.rotation.set(0, 0, 0);
  cyberJetGroup.rotation.set(0, 0, 0);
  if (truckBodyGroup) truckBodyGroup.rotation.set(0, 0, 0);
  document.getElementById('morphTitleTxt').innerText = `${CAR_SPECS[save.selectedCar].morph.toUpperCase()} ACTIVE!`;
  document.getElementById('morphBarFill').style.width = '100%';
  document.getElementById('morphHud').style.display = 'flex';
  document.getElementById('speedLines').style.opacity = '1';
  sound.playMorphPowerup();
}

function boostCombo() {
  combo = Math.min(5, combo + 1);
  comboTimer = 260;
  const pill = document.getElementById('comboPill');
  document.getElementById('comboVal').innerText = `x${combo}`;
  pill.style.display = 'flex';
  pill.style.transform = 'scale(1.22)';
  setTimeout(() => { pill.style.transform = 'scale(1)'; }, 120);
}

function startRun(withMorph) {
  sound.init(() => state === 'PLAYING');
  if (!save.unlocked.includes(save.selectedCar)) {
    save.selectedCar = 0; updatePlayerPaint();
  }
  document.getElementById('menuOverlay').style.display = 'none';
  document.getElementById('crateBtn').style.display = 'none';
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  document.getElementById('resultsModal').style.display = 'none';
  document.getElementById('rewardsModal').style.display = 'none';
  document.getElementById('shopModal').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'flex';
  document.getElementById('pauseBtn').style.display = 'flex';
  podiumGroup.visible = false;

  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];
  clearMagnetState();
  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }
  document.getElementById('brainBanner').style.display = 'none';

  score = 0; runCoins = 0; smashes = 0; nearMisses = 0; combo = 1; comboTimer = 0;
  nextMilestone = 500;
  coinDoubled = false;
  lastRunCoins = 0;
  document.getElementById('comboPill').style.display = 'none';

  const spec = CAR_SPECS[save.selectedCar];
  speed = 0.80 + (finalSpeed(save.selectedCar) - 78) * 0.004;
  lane = 1;
  playerRoot.position.set(0, 0, 0);
  playerRoot.rotation.set(0, 0, 0);
  // Swoop camera from high behind on launch
  camera.position.set(0, 6.2, 12.5);

  // Launching a run takes over the morph meshes, so drop any showroom preview state first.
  isMorphPreview = false;
  setPreviewLabel(false);
  clearStuntProps();

  if (withMorph) activateMorphState(morphFrames() + 20);
  else {
    morphTimer = 0;
    shieldTimer = 90; // 1.5s launch shield
    playerCarMesh.visible = true; monsterTruckGroup.visible = false; cyberJetGroup.visible = false;
    document.getElementById('morphHud').style.display = 'none';
    document.getElementById('speedLines').style.opacity = '0';
    showComicPopup("🏁 GO! GO! GO!", "#00ff87");
    sound.speakAnnouncer("LET'S GO!");
  }
  sound.isPaused = false;
  state = 'PLAYING';
}

function triggerCrash() {
  state = 'RESULTS';
  podiumGroup.visible = true;
  shakeIntensity = 0.85;
  sound.playCrashImpact();
  spawnExplosion3D(playerRoot.position, 0xff0055, 32);

  morphTimer = 0;
  shieldTimer = 0;
  shieldDome.visible = false;
  playerCarMesh.visible = true;
  monsterTruckGroup.visible = false;
  cyberJetGroup.visible = false;
  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }

  document.getElementById('brainBanner').style.display = 'none';
  document.getElementById('morphHud').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'none';
  document.getElementById('pauseBtn').style.display = 'none';
  document.getElementById('comboPill').style.display = 'none';
  document.getElementById('speedLines').style.opacity = '0';

  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];
  clearMagnetState();

  const finalDist = Math.floor(score);
  const isNewRecord = finalDist > save.best;
  save.best = Math.max(save.best, finalDist);
  syncUI();

  // flex, not inline-block — the pill is now an svg + label row and needs to keep them aligned.
  document.getElementById('newBestBanner').style.display = isNewRecord ? 'flex' : 'none';
  document.getElementById('resDistVal').innerText = `${finalDist}m`;
  document.getElementById('resCoinsVal').innerText = `+${runCoins}`;
  document.getElementById('resSmashVal').innerText = smashes;
  document.getElementById('resNearVal').innerText = nearMisses;

  lastRunCoins = runCoins;
  coinDoubled = false;
  const dblBtn = document.getElementById('doubleBtn');
  dblBtn.style.display = runCoins > 0 ? 'flex' : 'none';
  dblBtn.disabled = false;
  document.getElementById('doubleTxt').innerText = 'WATCH AD · 2× COINS';

  // A run is only monetised while the no-ads entitlement is missing — buying it has to remove
  // something the player actually experiences.
  if (!save.ent.noAds) AdManager.tryShowInterstitial();

  document.getElementById('resultsModal').style.display = 'flex';
}

// Traffic paints are built once and cycled. Per-spawn material allocation used to force a
// shader recompile on every car that entered the frame.
const ENEMY_PALETTE = [0x9b59b6, 0xff9100, 0x00e5ff, 0xff0055];
const ENEMY_BODY_MATS = ENEMY_PALETTE.map(color => new THREE.MeshPhysicalMaterial({
  color, metalness: 0.8, roughness: 0.18, clearcoat: 1.0
}));
const ENEMY_BLOCK_MATS = ENEMY_PALETTE.map(color => new THREE.MeshStandardMaterial({ color }));
let enemyPaint = 0;

const enemyTailMat = new THREE.MeshBasicMaterial({ color: 0xff2436, toneMapped: false });
const enemyTailGeo = (() => {
  const parts = [
    new THREE.BoxGeometry(0.5, 0.15, 0.07).translate(-0.6, 0, 0),
    new THREE.BoxGeometry(0.5, 0.15, 0.07).translate(0.6, 0, 0)
  ].map(g => g.index ? g.toNonIndexed() : g);
  return mergeGeometries(parts, false);
})();
// The rear face and light height come from the rig's real bounds, not a hand-guessed offset,
// so the strip stays glued to the bodywork if the model is ever rescaled. Keyed by rig source
// because traffic can start spawning before the GLB arrives, and the stand-in box is a
// different shape.
const enemyTailAnchors = {};
function getEnemyTailAnchor(enemy, key) {
  if (enemyTailAnchors[key]) return enemyTailAnchors[key];
  const box = new THREE.Box3().setFromObject(enemy);
  const h = box.max.y - box.min.y;
  enemyTailAnchors[key] = {
    y: (box.min.y + h * 0.44 - enemy.position.y) / enemy.scale.y,
    z: (box.max.z - enemy.position.z) / enemy.scale.z
  };
  return enemyTailAnchors[key];
}

function spawnEnemyTrafficCar(laneIndex) {
  const enemy = baseFerrariModel
    ? baseFerrariModel.clone()
    : new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 3.8), ENEMY_BLOCK_MATS[enemyPaint % ENEMY_BLOCK_MATS.length]);
  if (baseFerrariModel) {
    const body = enemy.getObjectByName('body');
    if (body) body.material = ENEMY_BODY_MATS[enemyPaint % ENEMY_BODY_MATS.length];
  }
  enemyPaint++;

  // Taillights are the one cue that survives fog, bloom and a purple car in front of a purple
  // city: a hazard marker the player reads as "car ahead" instead of "scenery".
  scene.add(enemy);
  enemy.position.set(LANES[laneIndex], 0, -140);
  enemy.updateWorldMatrix(true, false);
  const a = getEnemyTailAnchor(enemy, baseFerrariModel ? 'rig' : 'block');
  const tails = new THREE.Mesh(enemyTailGeo, enemyTailMat);
  tails.position.set(0, a.y, a.z - 0.02);
  enemy.add(tails);

  enemy.userData = { nearMissed: false, wheels: ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']
    .map(n => enemy.getObjectByName(n)).filter(Boolean) };
  obstacles.push(enemy);
}

let tick = 0;
const coinGeo = new THREE.TorusGeometry(0.48, 0.16, 12, 24);
const coinMat = new THREE.MeshPhysicalMaterial({ color: 0xffd700, emissive: 0xaa5500, metalness: 0.95, roughness: 0.08, clearcoat: 1.0 });

// Horseshoe magnet pickup: merged red body + silver poles, one draw call each
const magnetShellGeo = (() => {
  const parts = [
    new THREE.TorusGeometry(0.4, 0.125, 10, 20, Math.PI),
    new THREE.CylinderGeometry(0.125, 0.125, 0.52, 10).translate(-0.4, -0.26, 0),
    new THREE.CylinderGeometry(0.125, 0.125, 0.52, 10).translate(0.4, -0.26, 0)
  ].map(g => g.index ? g.toNonIndexed() : g);
  return mergeGeometries(parts, false);
})();
const magnetPoleGeo = (() => {
  const parts = [
    new THREE.CylinderGeometry(0.125, 0.125, 0.17, 10).translate(-0.4, -0.6, 0),
    new THREE.CylinderGeometry(0.125, 0.125, 0.17, 10).translate(0.4, -0.6, 0)
  ].map(g => g.index ? g.toNonIndexed() : g);
  return mergeGeometries(parts, false);
})();
const magnetShellMat = new THREE.MeshStandardMaterial({ color: 0xc81050, emissive: 0xff2e7e, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.34 });
const magnetPoleMat = new THREE.MeshPhysicalMaterial({ color: 0xdfe9ff, metalness: 0.95, roughness: 0.18, envMapIntensity: 0.8 });

function spawnMagnetPickup(lane) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(magnetShellGeo, magnetShellMat));
  g.add(new THREE.Mesh(magnetPoleGeo, magnetPoleMat));
  g.position.set(LANES[lane], 1.1, -112);
  scene.add(g);
  magnetPickups.push(g);
}

function clearMagnetState() {
  magnetPickups.forEach(m => scene.remove(m));
  magnetPickups = [];
  magnetTimer = 0;
  nextMagnetIn = 150;
  document.getElementById('magnetPill').style.display = 'none';
}

// --- BIOME SHIFTS -------------------------------------------------------------
// scene.background is an equirect CanvasTexture, so it has no .lerp() — the palette shift is
// carried by fog, the streetlight bulbs and a colour-grade tint on the final pass instead.
const BIOMES = [
  { name: "NEON CYBER-CITY", sky: 0x060218, fog: 0x3a1140, tint: [0.88, 0.94, 1.12], lamp: 0xffd9a0 },
  { name: "SOLAR OVERDRIVE", sky: 0x1f0510, fog: 0x4a1a20, tint: [1.14, 0.96, 0.78], lamp: 0xffe8b0 },
  { name: "EMERALD MATRIX", sky: 0x021810, fog: 0x14402f, tint: [0.86, 1.10, 0.92], lamp: 0xd9ffe6 },
  { name: "HYPER ZERO-G", sky: 0x030b26, fog: 0x241f5a, tint: [0.96, 0.88, 1.16], lamp: 0xcfd8ff }
];
let biomeIdx = 0;
const targetFogColor = new THREE.Color(BIOMES[0].fog);
const targetTint = new THREE.Color(BIOMES[0].tint[0], BIOMES[0].tint[1], BIOMES[0].tint[2]);
const targetLampColor = new THREE.Color(BIOMES[0].lamp);

function shiftBiome(idx, silent = false) {
  const next = ((idx % BIOMES.length) + BIOMES.length) % BIOMES.length;
  if (next === biomeIdx) return;
  biomeIdx = next;
  const b = BIOMES[biomeIdx];
  targetFogColor.setHex(b.fog);
  targetTint.setRGB(b.tint[0], b.tint[1], b.tint[2]);
  targetLampColor.setHex(b.lamp);
  if (silent) return;
  showComicPopup(`🌎 ${b.name}!`, "#00f2fe");
  sound.playMorphPowerup();
}

// --- STUNT RAMPS + NITRO PADS -------------------------------------------------
const RAMP_TILT = 0.28;
const rampBodyGeo = new THREE.BoxGeometry(2.5, 0.35, 3.6);
const rampFaceGeo = new THREE.PlaneGeometry(2.42, 3.5);
const rampRailGeo = new THREE.BoxGeometry(0.1, 0.1, 3.62);
const rampLipGeo = new THREE.BoxGeometry(2.62, 0.1, 0.2);
const rampApronGeo = new THREE.PlaneGeometry(3.4, 3.4).rotateX(-Math.PI / 2);
const rampBodyMat = new THREE.MeshStandardMaterial({ color: 0x0b0716, emissive: 0x092334, roughness: 0.5, metalness: 0.35 });
const rampRailMat = new THREE.MeshBasicMaterial({ color: 0xff2e7e });
const rampLipMat = new THREE.MeshBasicMaterial({ color: 0xbdf8ff });
const RAMP_LIP_BASE = rampLipMat.color.clone();
const RAMP_RAIL_BASE = rampRailMat.color.clone();

// Chevrons drawn up the launch face: v=1 of this map is the far edge of the kicker, so the apexes
// point the way the car is about to go.
function makeRampTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 256);
  x.fillStyle = 'rgba(189,248,255,0.5)';
  x.fillRect(5, 0, 5, 256); x.fillRect(118, 0, 5, 256);
  x.lineCap = 'round'; x.lineJoin = 'round';
  for (let i = 0; i < 4; i++) {
    const y = 46 + i * 56;
    x.strokeStyle = 'rgba(0,242,254,0.8)'; x.lineWidth = 22;
    x.beginPath(); x.moveTo(22, y + 30); x.lineTo(64, y); x.lineTo(106, y + 30); x.stroke();
    x.strokeStyle = 'rgba(255,255,255,0.95)'; x.lineWidth = 7;
    x.beginPath(); x.moveTo(22, y + 30); x.lineTo(64, y); x.lineTo(106, y + 30); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rampFaceMat = new THREE.MeshBasicMaterial({
  map: makeRampTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});
const rampApronMat = new THREE.MeshBasicMaterial({
  map: createRadialFadeTexture([[0, 'rgba(0,242,254,0.62)'], [0.45, 'rgba(0,242,254,0.22)'], [1, 'rgba(0,0,0,0)']]),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});

function makePadTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 256);
  x.strokeStyle = 'rgba(255,255,255,1)';
  x.lineWidth = 18;
  x.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const y = 58 + i * 68;
    x.beginPath(); x.moveTo(18, y + 34); x.lineTo(64, y); x.lineTo(110, y + 34); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const padGeo = new THREE.PlaneGeometry(2.4, 4.6).rotateX(-Math.PI / 2);
const padMat = new THREE.MeshBasicMaterial({
  map: makePadTexture(), color: 0xffea00, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});

function spawnStuntRamp3D(laneIndex) {
  const g = new THREE.Group();

  const body = new THREE.Mesh(rampBodyGeo, rampBodyMat);
  body.rotation.x = RAMP_TILT;
  body.position.y = 0.35;
  g.add(body);

  const face = new THREE.Mesh(rampFaceGeo, rampFaceMat);
  face.rotation.x = -Math.PI / 2 + RAMP_TILT;
  face.position.set(0, 0.528, 0.05);
  face.renderOrder = 3;
  g.add(face);

  [-1.24, 1.24].forEach(rx => {
    const rail = new THREE.Mesh(rampRailGeo, rampRailMat);
    rail.rotation.x = RAMP_TILT;
    rail.position.set(rx, 0.52, 0.05);
    g.add(rail);
  });

  const lip = new THREE.Mesh(rampLipGeo, rampLipMat);
  lip.rotation.x = RAMP_TILT;
  lip.position.set(0, 1.02, -1.66);
  g.add(lip);

  const apron = new THREE.Mesh(rampApronGeo, rampApronMat);
  apron.position.set(0, 0.02, 2.1);
  apron.renderOrder = 2;
  g.add(apron);

  g.position.set(LANES[laneIndex], 0, -150);
  scene.add(g);
  ramps.push(g);
}

function spawnBoostPad3D(laneIndex) {
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.position.set(LANES[laneIndex], 0.035, -150);
  pad.renderOrder = 2;
  scene.add(pad);
  boostPads.push(pad);
}

function clearStuntProps() {
  ramps.forEach(r => scene.remove(r)); ramps = [];
  boostPads.forEach(p => scene.remove(p)); boostPads = [];
  barrelRollAngle = 0;
  nitroPadBoost = 0;
  playerCarMesh.rotation.z = 0;
  monsterTruckGroup.rotation.z = 0;
}

// --- TRACK OCCUPANCY ----------------------------------------------------------
// Nothing spawns without first asking the road whether that stretch is free. This reads the live
// scene arrays rather than a reservation ledger, so a reservation can never outlive the prop it
// was made for, and nothing has to be un-reserved when an object is removed early.
const TRAFFIC_HALF_L = 2.6;   // 3.8-long chassis plus margin

const laneOf = (x) => {
  let best = 0, bd = Infinity;
  LANES.forEach((lx, i) => { const d = Math.abs(lx - x); if (d < bd) { bd = d; best = i; } });
  return best;
};
const spansBand = (o, halfL, zFrom, zTo) => o.position.z + halfL > zFrom && o.position.z - halfL < zTo;
const sameLane = (o, lane) => Math.abs(o.position.x - LANES[lane]) < 1.7;

// Lanes that already hold traffic inside this depth band.
function lanesWalled(zFrom, zTo) {
  const walled = new Set();
  obstacles.forEach(o => { if (spansBand(o, TRAFFIC_HALF_L, zFrom, zTo)) walled.add(laneOf(o.position.x)); });
  return walled;
}

// props:false tests only for traffic. Ramps, pads and pickups are things you drive *through*,
// so they need the lane to be reachable, not a lane to themselves.
function laneOpen(lane, zFrom, zTo, props = true) {
  if (obstacles.some(o => sameLane(o, lane) && spansBand(o, TRAFFIC_HALF_L, zFrom, zTo))) return false;
  if (!props) return true;
  // A gate's portals physically straddle the two outer lanes, so it blocks those and nothing else.
  if (brainGateGroup && lane !== 1 && spansBand(brainGateGroup, 2.2, zFrom, zTo)) return false;
  if (ramps.some(r => sameLane(r, lane) && spansBand(r, 2.4, zFrom, zTo))) return false;
  if (boostPads.some(p => sameLane(p, lane) && spansBand(p, 2.6, zFrom, zTo))) return false;
  if (magnetPickups.some(m => sameLane(m, lane) && spansBand(m, 1.1, zFrom, zTo))) return false;
  return true;
}

// A prop lane: empty through its own approach, so the player can commit to it and get out.
function pickPropLane(zSpawn, approach) {
  const open = [0, 1, 2].filter(l => laneOpen(l, zSpawn - approach, zSpawn + 6));
  return open.length ? open[Math.floor(Math.random() * open.length)] : -1;
}

// The Always-1-Open-Lane rule: a band may hold at most two cars, and the chosen lane must also be
// clear of props so nothing stacks nose-to-tail.
function pickTrafficLane() {
  const z = -140;
  if (lanesWalled(z - TRAFFIC_HALF_L * 2, z + TRAFFIC_HALF_L * 2).size >= 2) return -1;
  const free = [0, 1, 2].filter(l => laneOpen(l, z - 11, z + 11));
  return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
}

// --- MISSION TRACKER ----------------------------------------------------------
function updateMissionBanner() {
  const m = MISSIONS[save.missionIdx % MISSIONS.length];
  const prog = Math.min(m.target, save.missionProg || 0);
  document.getElementById('missionTxt').innerText = `${m.desc} (${prog}/${m.target})`;
  document.getElementById('missionReward').innerText = m.reward;
  document.getElementById('missionBarFill').style.width = `${(prog / m.target) * 100}%`;
}

// Runs mid-race, so it only touches the two nodes it needs — a full syncUI() here would
// rebuild the car carousel and pip bars on every smash.
function advanceMission(type, amount = 1) {
  const m = MISSIONS[save.missionIdx % MISSIONS.length];
  if (m.type !== type) return;
  save.missionProg = (save.missionProg || 0) + amount;
  if (save.missionProg >= m.target) {
    save.coins += m.reward;
    runCoins += m.reward;
    save.missionIdx = (save.missionIdx + 1) % MISSIONS.length;
    save.missionProg = 0;
    // The chest is driven by a lifetime counter, not by the cycling mission index, so it can
    // only ever pay once per three real completions.
    save.missionsTotal++;
    persist();
    sound.playMorphPowerup();
    spawnExplosion3D(playerRoot.position, 0x00ff87, 26);
    showComicPopup(`🎯 MISSION COMPLETE! +${m.reward} <span class="coin-icon" style="width:24px;height:24px;vertical-align:middle;"></span>`, "#00ff87");
    updateHubBadges();
  }
  document.getElementById('coinVal').innerText = save.coins;
  updateMissionBanner();
}

// ─── REWARDS: DAILY STREAK, TROPHY CHEST, HEADSTART TOKENS ──────────────────
// Everything here pays out of one wallet (save.coins + save.ent.headstarts) and every gate is
// a persisted counter, so a reward cannot be farmed by quitting, reloading or changing the clock.
const STREAK_REWARDS = [
  { coins: 250 }, { coins: 400 }, { coins: 600, tokens: 1 }, { coins: 800 },
  { coins: 1100 }, { coins: 1500, tokens: 1 }, { coins: 2500, tokens: 2 }
];
const CHEST_EVERY = 3;
const CHEST_REWARD = { coins: 1200, tokens: 2 };
const HEADSTART_COST = 100;

const streakClaimable = () => save.streak.claimedOn !== todayKey();
const chestsReady = () => Math.floor(save.missionsTotal / CHEST_EVERY) - save.chestsOpened;
// A gap of exactly one calendar day extends the run; anything longer — clock changes included —
// restarts it at day 1, which is the only rule that makes a streak mean something.
function nextStreakDay() {
  if (!save.streak.claimedOn || !save.streak.day) return 1;
  return daysBetween(save.streak.claimedOn, todayKey()) === 1 ? (save.streak.day % 7) + 1 : 1;
}

// Garage-side payout: it moves the wallet but never runCoins, which is race telemetry only.
function grantWallet(coins, tokens = 0) {
  save.coins += coins;
  save.ent.headstarts += tokens;
  persist();
  document.getElementById('coinVal').innerText = save.coins;
}

window.claimStreak = () => {
  if (!streakClaimable()) return;
  const day = nextStreakDay();
  const r = STREAK_REWARDS[day - 1];
  save.streak.day = day;
  save.streak.claimedOn = todayKey();
  grantWallet(r.coins, r.tokens || 0);
  sound.playMorphPowerup();
  spawnExplosion3D(playerRoot.position, 0xffd700, 28);
  showComicPopup(`📅 DAY ${day} · +${r.coins}${r.tokens ? ` · +${r.tokens} TOKENS` : ''}`, '#ffd700');
  renderRewards();
  updateHubBadges();
};

window.claimChest = () => {
  if (chestsReady() <= 0) {
    sound.triggerExhaustBackfire();
    showComicPopup('COMPLETE 3 MORE MISSIONS', '#ff9100');
    return;
  }
  save.chestsOpened++;
  grantWallet(CHEST_REWARD.coins, CHEST_REWARD.tokens);
  sound.playMorphPowerup();
  spawnExplosion3D(playerRoot.position, 0x00ff87, 32);
  showComicPopup(`🏆 CHEST! +${CHEST_REWARD.coins} · +${CHEST_REWARD.tokens} TOKENS`, '#00ff87');
  renderRewards();
  updateHubBadges();
};

function renderRewards() {
  const claimable = streakClaimable();
  const hotDay = claimable ? nextStreakDay() : save.streak.day;
  const grid = document.getElementById('streakGrid');
  grid.innerHTML = '';
  STREAK_REWARDS.forEach((r, i) => {
    const d = i + 1;
    const cell = document.createElement('div');
    const done = d < hotDay || (d === hotDay && !claimable);
    cell.className = 'streak-cell'
      + (d === hotDay ? ' today' : '')
      + (done ? ' claimed' : '')
      + (d === 7 ? ' jackpot' : '');
    cell.innerHTML = `<span class="streak-day">DAY ${d}</span>`
      + `<span class="streak-val"><span class="coin-icon mini"></span>${r.coins}`
      + (r.tokens ? `<small>+${r.tokens}T</small>` : '') + `</span>`;
    grid.appendChild(cell);
  });

  const btn = document.getElementById('claimStreakBtn');
  if (claimable) {
    const d = nextStreakDay();
    btn.innerText = `CLAIM DAY ${d} · +${STREAK_REWARDS[d - 1].coins}`;
    btn.disabled = false;
  } else {
    btn.innerText = 'CLAIMED · RETURN TOMORROW';
    btn.disabled = true;
  }
  document.getElementById('streakSub').innerText = save.streak.day > 1
    ? `${save.streak.day}-DAY RUN · SKIP A DAY AND IT RESETS TO DAY 1`
    : 'ONE CLAIM PER DAY · SKIP A DAY AND THE RUN RESETS';

  const ready = chestsReady() > 0;
  const intoNext = save.missionsTotal % CHEST_EVERY;
  document.getElementById('chestProg').innerText = ready ? `×${chestsReady()}` : `${intoNext}/${CHEST_EVERY}`;
  document.getElementById('chestBarFill').style.width = `${(intoNext / CHEST_EVERY) * 100}%`;
  document.getElementById('chestRow').classList.toggle('ready', ready);
  document.getElementById('chestTag').innerText = ready ? 'OPEN NOW' : 'LOCKED';
  document.getElementById('tokenCount').innerText = save.ent.headstarts;
  const adsTag = document.getElementById('noAdsTag');
  adsTag.innerText = save.ent.noAds ? 'ACTIVE' : 'NO';
  adsTag.className = save.ent.noAds ? 'yes' : '';
}

// ─── SANDBOX STORE + 12-HOUR LAUNCH OFFER ───────────────────────────────────
function applyGrants(g) {
  const lines = [];
  if (g.coins) { save.coins += g.coins; lines.push(`+${g.coins} COINS`); }
  if (g.headstarts) { save.ent.headstarts += g.headstarts; lines.push(`${g.headstarts} HEADSTART TOKENS`); }
  if (g.noAds && !save.ent.noAds) { save.ent.noAds = true; lines.push('ADS REMOVED'); }
  const add = (idx) => {
    const spec = CAR_SPECS[idx];
    // Append to the garage instead of selecting: a purchase should never hijack what the
    // player is standing on the turntable looking at.
    if (spec && !save.unlocked.includes(idx)) { save.unlocked.push(idx); lines.push(`${spec.name} UNLOCKED`); }
  };
  if (g.unlockAllCars) CAR_SPECS.forEach((_, i) => add(i));
  (g.unlockCars || []).forEach(add);
  return lines;
}

function renderShop() {
  const live = offerLive(save);
  document.getElementById('ltoBanner').classList.toggle('dead', !live);
  document.getElementById('ltoClock').innerText = countdown(offerRemaining(save));

  const list = document.getElementById('shopList');
  list.innerHTML = '';
  PRODUCTS.forEach(p => {
    const price = priceOf(save, p);
    const owned = isOwned(save, p);
    const row = document.createElement('div');
    row.className = `shop-row${owned ? ' owned' : ''}`;

    const body = document.createElement('div');
    body.className = 'shop-body';
    body.innerHTML = `<span class="shop-title">${p.title}</span>`
      + `<span class="shop-blurb">${p.blurb}</span>`
      + (price.off ? `<span class="price-was">${usd(price.list)}</span>` : '');

    const btn = document.createElement('button');
    btn.className = 'buy-btn';
    if (owned) {
      btn.innerText = 'OWNED';
      btn.disabled = true;
    } else {
      btn.innerHTML = `${usd(price.pay)}<b>${PURCHASES_ARE_SANDBOX ? 'SANDBOX' : 'BUY'}</b>`;
      btn.onclick = () => window.buyProduct(p.id);
    }
    row.append(body, btn);
    list.appendChild(row);
  });

  document.getElementById('sandboxNote').innerText = PURCHASES_ARE_SANDBOX
    ? 'Sandbox build: no billing SDK is installed, so nothing is charged and these USD figures are placeholders. Live prices come from Play Billing / App Store per country.'
    : 'Prices are your store catalogue values for your country.';
}

window.buyProduct = async (id) => {
  const p = PRODUCTS.find(x => x.id === id);
  if (!p || isOwned(save, p)) return;
  if (!(await requestPurchase(save, p))) {
    sound.triggerExhaustBackfire();
    return;
  }
  markPurchased(save, p);
  const lines = applyGrants(p.grants);
  persist();
  sound.playMorphPowerup();
  spawnExplosion3D(playerRoot.position, 0xffea00, 30);
  showComicPopup(lines.length ? lines[0] : 'PURCHASE COMPLETE', '#00ff87');
  renderShop();
  renderRewards();
  syncUI();
};

function updateHubBadges() {
  const ping = streakClaimable() || chestsReady() > 0;
  document.getElementById('rewardsDot').style.display = ping ? 'block' : 'none';
  const crate = document.getElementById('crateBtn');
  if (crate) crate.classList.toggle('claimed', !ping);
  const tag = document.getElementById('shopOfferTag');
  const live = offerLive(save);
  tag.classList.toggle('gone', !live);
  if (live) tag.innerText = `−70% ${countdown(offerRemaining(save))}`;
}

window.openRewards = () => {
  sound.init(() => state === 'PLAYING');
  sound.playCoinChime(3);
  renderRewards();
  document.getElementById('rewardsModal').style.display = 'flex';
};
window.closeRewards = () => {
  document.getElementById('rewardsModal').style.display = 'none';
  syncUI();
};
window.openShop = () => {
  sound.init(() => state === 'PLAYING');
  sound.playCoinChime(5);
  renderShop();
  document.getElementById('shopModal').style.display = 'flex';
};
window.closeShop = () => {
  document.getElementById('shopModal').style.display = 'none';
};

// The offer window is a one-off event: expiresAt is persisted and never rolled forward, so this
// ticker only has to watch for the moment it flips off and repaint the price list once.
let offerWasLive = offerLive(save);
setInterval(() => {
  if (document.getElementById('shopModal').style.display === 'flex') {
    document.getElementById('ltoClock').innerText = countdown(offerRemaining(save));
  }
  const live = offerLive(save);
  if (live !== offerWasLive) {
    offerWasLive = live;
    renderShop();
  }
  updateHubBadges();
}, 1000);

// ─── POST-RACE 2× COIN DOUBLER (real rewarded-ad gate) ──────────────────────
let coinDoubled = false;
let lastRunCoins = 0;

window.doubleRunCoins = () => {
  const btn = document.getElementById('doubleBtn');
  if (coinDoubled || lastRunCoins <= 0) return;
  btn.disabled = true;
  AdManager.showRewardedAd('2× RACE COINS', () => {
    coinDoubled = true;
    save.coins += lastRunCoins;
    runCoins += lastRunCoins;
    persist();
    document.getElementById('coinVal').innerText = save.coins;
    document.getElementById('resCoinsVal').innerText = `+${runCoins}`;
    document.getElementById('doubleTxt').innerText = 'DOUBLE BANKED';
    sound.playCoinChime(7);
    spawnExplosion3D(playerRoot.position, 0xffd700, 26);
  }).then(() => {
    // A declined or failed ad must leave the offer standing, not grey it out.
    if (!coinDoubled) btn.disabled = false;
  });
};

function animate() {
  requestAnimationFrame(animate);

  const spec = CAR_SPECS[save.selectedCar];
  sound.updateEngine(speed, state === 'PLAYING', morphTimer > 0, spec.type);

  if (state === 'PAUSED') {
    composer.render();
    return;
  }

  tick++;

  const rigTarget = (state === 'MENU' || state === 'RESULTS') ? 1 : 0.22;
  showroomFactor += (rigTarget - showroomFactor) * 0.05;
  keySpot.intensity = 300 * showroomFactor;
  rimCyan.intensity = 260 * showroomFactor;
  rimMagenta.intensity = 240 * showroomFactor;
  gradePass.uniforms.time.value = tick * 0.017;
  gradePass.uniforms.strength.value = state === 'PLAYING' ? 0.7 : 1;

  const pulse = 0.85 + Math.sin(tick * 0.65) * 0.28;
  const boostMult = morphTimer > 0 ? 1.25 : (state === 'PLAYING' ? 1.05 : 0.45);

  morphPunch *= 0.87;
  if (morphPunch < 0.002) morphPunch = 0;
  const punch = 1 + morphPunch * 0.2;
  const punchSpin = morphPunch * Math.PI * 1.75;
  monsterTruckGroup.scale.setScalar(punch);
  cyberJetGroup.scale.setScalar(punch);
  monsterTruckGroup.rotation.y = punchSpin;
  cyberJetGroup.rotation.y = -punchSpin;

  let jetBob = 0;
  if (morphTimer > 0) {
    if (truckBodyGroup) {
      truckBodyGroup.position.y = Math.sin(tick * 0.21) * 0.045 + morphPunch * 0.14;
      truckBodyGroup.rotation.z = Math.sin(tick * 0.13) * 0.016;
      truckBodyGroup.rotation.x = Math.sin(tick * 0.17) * 0.012;
    }
    jetBob = Math.sin(tick * 0.055) * 0.1 - morphPunch * 0.1;
    cyberJetGroup.position.y = jetBob;
    cyberJetGroup.rotation.z += (playerRoot.rotation.z * 0.6 - cyberJetGroup.rotation.z) * 0.16;
    cyberJetGroup.rotation.x += (-0.035 - cyberJetGroup.rotation.x) * 0.12;
    const plumeStretch = 0.84 + Math.sin(tick * 0.52) * 0.13 + Math.random() * 0.06;
    jetPlumes.forEach((p, i) => {
      const girth = 0.96 + plumeStretch * 0.05;
      p.scale.set(girth, girth, plumeStretch * (i ? 1 : 1.05));
    });
    const heartSize = 0.38 + pulse * 0.08 + Math.random() * 0.03;
    jetHearts.forEach(h => {
      h.scale.set(heartSize, heartSize, heartSize);
      h.material.opacity = 0.48 + pulse * 0.14;
    });
    MORPH_MATS.flameCore.opacity = 0.9 + pulse * 0.1;
    MORPH_MATS.flameSoft.opacity = 0.38 + pulse * 0.1;
  } else if (morphPunch === 0) {
    if (truckBodyGroup) {
      truckBodyGroup.position.y = 0;
      truckBodyGroup.rotation.set(0, 0, 0);
    }
    cyberJetGroup.position.y = 0;
    cyberJetGroup.rotation.set(0, 0, 0);
  }

  const isJetMorph = morphTimer > 0 && spec.type === 'jet';
  const nozzleTargetY = morphTimer > 0 ? (isJetMorph ? JET_Y - 0.38 + jetBob : 0.45) : 0.02;
  const nozzleTargetX = isJetMorph ? 0.55 : (morphTimer > 0 ? 1.45 : 1);
  afterburnerNozzles.position.y += (nozzleTargetY - afterburnerNozzles.position.y) * 0.18;
  // Truck shells sit 0.76 further aft than the car's, so the plumes need to clear the rear guard or
  // they render buried inside the bodywork.
  afterburnerNozzles.position.z += ((isJetMorph ? 0.4 : (morphTimer > 0 ? 0.95 : 0)) - afterburnerNozzles.position.z) * 0.18;
  afterburnerNozzles.scale.x += (nozzleTargetX - afterburnerNozzles.scale.x) * 0.18;
  const plumeLen = (0.72 + pulse * 0.45) * boostMult;
  const plumeGirth = 0.9 + Math.random() * 0.16;
  shockCones.forEach(sc => {
    sc.halo.scale.set(plumeGirth, plumeGirth, plumeLen * 1.05);
    sc.core.scale.set(plumeGirth, plumeGirth, plumeLen * 0.62);
    const mouth = 0.13 + plumeLen * 0.09;
    sc.heart.scale.set(mouth, mouth, mouth);
  });

  for (let i = exhaustPlumes.length - 1; i >= 0; i--) {
    const ep = exhaustPlumes[i];
    ep.sprite.position.x += ep.vx;
    ep.sprite.position.y += ep.vy;
    ep.sprite.position.z += ep.vz;
    ep.life -= ep.isSpark ? 0.065 : ep.decay;

    if (!ep.isSpark) {
      if (ep.isMorphed) {
        ep.sprite.material.color.setHex(ep.life > 0.66 ? 0xfff0cf : (ep.life > 0.36 ? 0xffab3d : 0xff5a1e));
      } else {
        if (ep.life > 0.72) ep.sprite.material.color.setHex(0x00f2fe);
        else if (ep.life > 0.4) ep.sprite.material.color.setHex(spec.flameHex);
        else ep.sprite.material.color.setHex(0xff0066);
      }
    }

    // Embers shrink as they cool. They used to swell on the way out, which put a fat additive quad
    // over the rear bodywork right when it was closest to the camera.
    const s = ep.s0 * (0.4 + Math.max(0, ep.life) * 0.6);
    ep.sprite.scale.set(s, s, s);
    ep.sprite.material.opacity = Math.max(0, ep.life * ep.a0);
    if (ep.life <= 0) {
      scene.remove(ep.sprite);
      exhaustPlumes.splice(i, 1);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.mesh.position.x += p.vx; p.mesh.position.y += p.vy; p.mesh.position.z += p.vz;
    p.mesh.rotation.x += 0.1; p.mesh.rotation.y += 0.1;
    p.vy -= 0.018; p.life -= 0.032;
    p.mesh.scale.setScalar(Math.max(0.01, p.life));
    if (p.life <= 0) { scene.remove(p.mesh); particles.splice(i, 1); }
  }

  if (state === 'MENU' || state === 'RESULTS') {
    const neonBay = garageTab === 'neon';
    afterburnerNozzles.visible = neonBay;
    exhaustLight.intensity = neonBay ? 0.9 : 0;
    if (!isDraggingShowroom) showroomAngle += 0.011;
    playerRoot.position.set(0, 0.02, 0);
    contactShadow.visible = true;
    playerRoot.rotation.set(0, showroomAngle, 0);
    podiumGroup.rotation.y = -showroomAngle * 0.5;
    tickSpin.rotation.y += 0.006;
    playerWheels.forEach(w => { w.rotation.x -= 0.02; });
    // The morph preview shows the truck, so its tyres browse-turn too or the rig looks dead.
    monsterWheels.forEach(w => { w.rotation.x -= 0.02; });
    spinBlurMat.visible = false;
    spinBlurMat.opacity = 0;
    underglow.material.opacity = 0.34 + Math.sin(tick * 0.045) * 0.12;
    // Breathe is added on top of the active bay's framing so the car never sits perfectly still.
    const breathe = Math.sin(tick * 0.011);
    const fovTarget = garageTab === 'showroom' ? 47 : garageTab === 'tuning' ? 41 : 36;
    camera.fov += (fovTarget - camera.fov) * 0.07;
    camera.updateProjectionMatrix();
    // The garage deck is tall, so aim below the car to keep it clear of the panels.
    _camScratch.copy(showroomCamTarget);
    _camScratch.x += breathe * 0.22;
    _camScratch.y += breathe * 0.07;
    _camScratch.z -= breathe * 0.05;
    camera.position.lerp(_camScratch, 0.08);
    _lookScratch.set(showroomLookTarget.x, showroomLookTarget.y - 0.3, showroomLookTarget.z);
    currentLookAt.lerp(_lookScratch, 0.1);
    camera.lookAt(currentLookAt);
    composer.render();
    return;
  }

  // PLAYING STATE
  afterburnerNozzles.visible = !isJetMorph;
  contactShadow.visible = false;
  exhaustLight.position.y += ((isJetMorph ? JET_Y : (morphTimer > 0 ? 0.8 : 0.18)) - exhaustLight.position.y) * 0.18;
  // Every rig parks its light behind its own bodywork. The truck's shell runs back to z 2.94, so the
  // car's z 3.3 buried a candela point light inside the rear panel and blew it out to a white ball —
  // and the car's own bumper ends at z ~2.2, so 3.3 did exactly the same thing one size up.
  exhaustLight.position.z += ((isJetMorph ? 4.2 : (morphTimer > 0 ? 4.7 : 4)) - exhaustLight.position.z) * 0.18;
  exhaustLight.intensity = morphTimer > 0 ? 0.8 + Math.random() * 0.3 : (0.6 + Math.random() * 0.15) * boostMult;
  bloomPass.threshold = morphTimer > 0 ? 1.1 : 0.95;
  underglow.material.opacity = morphTimer > 0 ? 0.24 : 0.3;
  playerRoot.rotation.y = 0;

  // Biome palette eases in over ~1s so a shift never pops.
  scene.fog.color.lerp(targetFogColor, 0.03);
  gradePass.uniforms.tint.value.lerp(targetTint, 0.03);
  lampHeadMat.color.lerp(targetLampColor, 0.03);

  const carBonus = (finalSpeed(save.selectedCar) - 78) * 0.0022;
  if (nitroPadBoost > 0) nitroPadBoost--;
  speed = Math.min(1.86, 0.82 + score * 0.00045 + carBonus + (nitroPadBoost > 0 ? 0.22 : 0));
  score += speed * 0.42;

  // Milestone Toasts every 500m
  if (score >= nextMilestone) {
    showComicPopup(`🏁 ${nextMilestone}m SPEED BOOST!`, "#00f2fe");
    sound.playCoinChime(7);
    shiftBiome(nextMilestone / 500);
    if (nextMilestone >= 800) advanceMission('dist', 800);
    nextMilestone += 500;
  }

  // 360° mid-air barrel roll while a stunt ramp has the car airborne. The jet owns its own
  // rotation.z further down, so only the car and the truck get rolled.
  if (barrelRollAngle > 0) {
    barrelRollAngle = Math.max(0, barrelRollAngle - 0.24);
    playerCarMesh.rotation.z = barrelRollAngle;
    monsterTruckGroup.rotation.z = barrelRollAngle;
  } else {
    playerCarMesh.rotation.z = 0;
    monsterTruckGroup.rotation.z = 0;
  }

  // Stunt ramps and nitro pads, staggered so they never land on top of a reflex gate. Each one
  // only drops into a lane that is empty for its whole approach — a refused slot is simply lost
  // until the next cycle, which is cheaper than a prop the player cannot reach or read.
  if (tick % 190 === 95 && (!brainGateGroup || brainGateGroup.position.z > -60)) {
    const rLane = pickPropLane(-150, 34);
    if (rLane >= 0) spawnStuntRamp3D(rLane);
  }
  if (tick % 190 === 8) {
    const pLane = pickPropLane(-150, 18);
    if (pLane >= 0) spawnBoostPad3D(pLane);
  }

  // Shared materials, so every kicker on screen breathes as one set piece.
  const rampPulse = 0.78 + Math.sin(tick * 0.16) * 0.22;
  rampLipMat.color.copy(RAMP_LIP_BASE).multiplyScalar(rampPulse);
  rampRailMat.color.copy(RAMP_RAIL_BASE).multiplyScalar(rampPulse);

  for (let i = ramps.length - 1; i >= 0; i--) {
    const r = ramps[i];
    r.position.z += speed * 1.45;
    if (Math.abs(r.position.z - playerRoot.position.z) < 2.2 && Math.abs(r.position.x - playerRoot.position.x) < 1.5 && playerY < 0.6) {
      velY = 0.58;
      barrelRollAngle = Math.PI * 2;
      save.coins += 25; runCoins += 25;
      boostCombo();
      advanceMission('stunt', 1);
      sound.playJumpWhoosh();
      sound.playCoinChime(6);
      spawnExplosion3D(playerRoot.position, 0x00f2fe, 18);
      showComicPopup("🌪️ BARREL ROLL! +25", "#00f2fe");
      scene.remove(r); ramps.splice(i, 1);
      continue;
    }
    if (r.position.z > 14) { scene.remove(r); ramps.splice(i, 1); }
  }

  for (let i = boostPads.length - 1; i >= 0; i--) {
    const p = boostPads[i];
    p.position.z += speed * 1.45;
    if (Math.abs(p.position.z - playerRoot.position.z) < 2.4 && Math.abs(p.position.x - playerRoot.position.x) < 1.6 && playerY < 0.9) {
      nitroPadBoost = 110;
      sound.playMorphPowerup();
      spawnExplosion3D(playerRoot.position, 0xffea00, 16);
      showComicPopup("🔥 NITRO PAD!", "#ffea00");
      scene.remove(p); boostPads.splice(i, 1);
      continue;
    }
    if (p.position.z > 14) { scene.remove(p); boostPads.splice(i, 1); }
  }

  // Combo Decay
  if (comboTimer > 0) {
    comboTimer--;
    if (comboTimer === 0) {
      combo = 1;
      document.getElementById('comboPill').style.display = 'none';
    }
  }

  document.getElementById('gearTxt').innerText = morphTimer > 0 ? 'MAX' : `G${sound.gear}`;
  document.getElementById('rpmBarFill').style.width = `${Math.floor(sound.rpm * 100)}%`;
  document.getElementById('mphVal').innerText = Math.floor(140 + (speed - 0.82) * 240 + (morphTimer > 0 ? 85 : 0));

  emitPlasmaExhaust(morphTimer > 0, false);

  // Surface scroll must equal the scenery rate (speed * 1.45 world units/frame) or the tarmac
  // crawls while the city flies past. Local +V runs away from the camera, so the offset grows.
  const worldStep = speed * 1.45;
  // No-slip rolling: a wheel has to turn through worldStep / radius radians per frame, so the
  // two rigs can't share one rate — the 0.315 car tyre spins three times faster than the 0.94
  // truck tyre over the same ground.
  playerWheels.forEach(w => { w.rotation.x -= worldStep / w.userData.rollR; });
  monsterWheels.forEach(w => { w.rotation.x -= worldStep / w.userData.rollR; });
  // Past about half a revolution per frame a spoked wheel strobes instead of spinning, so the
  // smear decal takes over. Its weight tracks contact-patch speed, shared by both rigs. The
  // chase cam sits ~84 degrees off the axle, so this reads as a bright lip ring more than a
  // face veil — which is why the truck's lug pattern needs it far more than the car's.
  spinBlurMat.opacity = Math.min(0.8, worldStep * 0.45);
  spinBlurMat.visible = spinBlurMat.opacity > 0.02;
  roadTex.offset.y += worldStep / ROAD_TILE;
  asphalt.rough.offset.y = roadTex.offset.y;
  markTex.offset.y += worldStep / MARK_TILE;
  groundTex.offset.y += worldStep / (620 / groundTex.repeat.x);

  const targetFOV = morphTimer > 0 ? 75 : 58;
  camera.fov += (targetFOV - camera.fov) * 0.1;
  camera.updateProjectionMatrix();

  const shakeX = (Math.random() - 0.5) * shakeIntensity;
  const shakeY = (Math.random() - 0.5) * shakeIntensity;
  shakeIntensity *= 0.86;

  const camY = 2.85 + playerRoot.position.y * 0.75 + shakeY;
  camera.position.lerp(new THREE.Vector3(playerRoot.position.x * 0.52 + shakeX, camY, 6.6), 0.18);
  camera.lookAt(playerRoot.position.x * 0.3, 0.9 + playerRoot.position.y * 0.65, -15);

  envScenery.forEach(b => {
    b.position.z += speed * 1.45;
    if (b.position.z > 16) b.position.z -= 190;
  });

  playerRoot.position.x += (LANES[lane] - playerRoot.position.x) * 0.24;
  playerRoot.rotation.z *= 0.82;

  if (playerY > 0 || velY !== 0) {
    playerY += velY;
    velY -= 0.025;
    if (playerY <= 0) { playerY = 0; velY = 0; }
  }
  playerRoot.position.y = playerY;

  // Depleting Morph Timer Bar + 2.5s Post-Morph Invincibility Shield
  if (morphTimer > 0) {
    morphTimer--;
    const pct = Math.max(0, (morphTimer / morphMaxFrames) * 100);
    document.getElementById('morphBarFill').style.width = `${pct}%`;

    if (morphTimer === 0) {
      playerCarMesh.visible = true; monsterTruckGroup.visible = false; cyberJetGroup.visible = false;
      document.getElementById('morphHud').style.display = 'none';
      document.getElementById('speedLines').style.opacity = '0';
      spawnExplosion3D(playerRoot.position, 0x00f2fe, 18);
      shieldTimer = 150; // 2.5 seconds of Post-Morph Shield protection!
      showComicPopup("🛡️ SHIELD ACTIVE!", "#00f2fe");
    }
  }

  if (shieldTimer > 0) {
    shieldTimer--;
    shieldDome.visible = (shieldTimer % 6 < 4);
    shieldDome.rotation.y += 0.08;
    if (shieldTimer === 0) shieldDome.visible = false;
  }

  if (tick % 32 === 0) {
    // Weaving runs make you steer for the payout; straight runs reward holding a line. A line
    // only lands where no traffic is standing, otherwise the coins hide inside a car.
    const weave = Math.random() < 0.4;
    const shapes = weave ? [[0, 1], [1, 2]] : [[0, 0], [1, 1], [2, 2]];
    const usable = shapes.filter(([a, b]) =>
      laneOpen(a, -138, -114, false) && laneOpen(b, -138, -114, false));
    if (usable.length) {
      const [a, b] = usable[Math.floor(Math.random() * usable.length)];
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(coinGeo, coinMat);
        c.position.set(LANES[i % 2 ? b : a], 0.95, -120 - i * 4.8);
        scene.add(c);
        coins.push(c);
      }
    }
  }

  if (tick % 340 === 160 && !brainGateGroup) {
    trySpawnReflexGate();
  } else if (tick % 48 === 0 && (!brainGateGroup || brainGateGroup.position.z > -75)) {
    const tLane = pickTrafficLane();
    if (tLane >= 0) spawnEnemyTrafficCar(tLane);
  }

  // Gold rings only fly to the car while a magnet (or a morph) is running - otherwise you have
  // to steer into their lane to bank them.
  const pullRange = morphTimer > 0 ? 26 : (magnetTimer > 0 ? 8 + tuningLevel('magnet') * 2.6 : 0);
  const pullWidth = morphTimer > 0 ? 4.4 : 5.4;
  const grabWidth = morphTimer > 0 ? 1.9 : 1.15;
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    c.position.z += speed * 1.4;
    c.rotation.y += 0.09;
    if (pullRange && c.position.z > -pullRange && Math.abs(c.position.x - playerRoot.position.x) < pullWidth) {
      c.position.x += (playerRoot.position.x - c.position.x) * 0.2;
    }
    if (Math.abs(c.position.z - playerRoot.position.z) < 1.9 && Math.abs(c.position.x - playerRoot.position.x) < grabWidth) {
      const earned = combo;
      save.coins += earned; runCoins += earned;
      sound.playCoinChime(runCoins);
      spawnExplosion3D(c.position, 0xffd700, 6);
      scene.remove(c); coins.splice(i, 1);
    } else if (c.position.z > 12) {
      scene.remove(c); coins.splice(i, 1);
    }
  }

  // The magnet is a treat you have to earn: never let a pickup hit the road while one is already
  // active or while a morph is vacuuming, otherwise the two overlap and coins look automatic.
  if (nextMagnetIn > 0) nextMagnetIn--;
  else if (magnetPickups.length === 0 && magnetTimer === 0 && morphTimer === 0) {
    const mLane = pickPropLane(-112, 22);
    if (mLane >= 0) {
      spawnMagnetPickup(mLane);
      nextMagnetIn = 780 + Math.floor(Math.random() * 300);
    }
  }
  for (let i = magnetPickups.length - 1; i >= 0; i--) {
    const m = magnetPickups[i];
    m.position.z += speed * 1.4;
    m.rotation.y += 0.055;
    m.position.y = 1.1 + Math.sin(tick * 0.11) * 0.13;
    if (Math.abs(m.position.z - playerRoot.position.z) < 2.1 && Math.abs(m.position.x - playerRoot.position.x) < 1.5) {
      magnetTimer = magnetMax = magnetFrames();
      document.getElementById('magnetPill').style.display = 'flex';
      sound.playMorphPowerup();
      showComicPopup('🧲 MAGNET!', '#ff2e7e');
      spawnExplosion3D(m.position, 0xff2e7e, 16);
      scene.remove(m); magnetPickups.splice(i, 1);
    } else if (m.position.z > 12) {
      scene.remove(m); magnetPickups.splice(i, 1);
    }
  }

  if (magnetTimer > 0) {
    magnetTimer--;
    document.getElementById('magnetBarFill').style.width = `${(magnetTimer / magnetMax) * 100}%`;
    if (magnetTimer === 0) document.getElementById('magnetPill').style.display = 'none';
  }

  // Update Reflex Gate
  if (brainGateGroup) {
    brainGateGroup.position.z += speed * 1.3;
    if (Math.abs(brainGateGroup.position.z - playerRoot.position.z) < 1.9) {
      if (lane === brainGateGroup.userData.correctLane) {
        activateMorphState(morphFrames());
        save.coins += 20; runCoins += 20;
        boostCombo();
        shakeIntensity = 0.6;
        spawnExplosion3D(playerRoot.position, 0x00ff87, 30);
        showComicPopup("⚡ MEGA MORPH! +20", "#00ff87");
      } else {
        sound.triggerExhaustBackfire();
        showComicPopup("MISSED GATE!", "#ff9100");
      }
      document.getElementById('brainBanner').style.display = 'none';
      scene.remove(brainGateGroup); brainGateGroup = null;
    } else if (brainGateGroup && brainGateGroup.position.z > 12) {
      document.getElementById('brainBanner').style.display = 'none';
      scene.remove(brainGateGroup); brainGateGroup = null;
    }
  }

  // Update Enemy Supercars + Near-Miss Detection
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.position.z += speed * 1.18;
    // Traffic is overtaken, not parked: it creeps forward against the tarmac at
    // (1.45 - 1.18) * speed, so its tyres roll at that rate over the 0.315 radius.
    o.userData.wheels.forEach(w => { w.rotation.x -= speed * 0.857; });
    const dz = Math.abs(o.position.z - playerRoot.position.z);
    const dx = Math.abs(o.position.x - playerRoot.position.x);

    // Collision Check
    if (dz < 3.1 && dx < 1.65 && playerY < 1.3) {
      if (morphTimer > 0 || shieldTimer > 0) {
        smashes++;
        const bonus = 5 * combo;
        save.coins += bonus; runCoins += bonus;
        advanceMission('smash', 1);
        boostCombo();
        shakeIntensity = 0.5;
        sound.playCrashImpact();
        sound.speakAnnouncer("SMASH!");
        spawnExplosion3D(o.position, 0xff0055, 24);
        showComicPopup(`SMASH! +${bonus} <span class="coin-icon" style="width:26px;height:26px;vertical-align:middle;"></span>`, "#ffea00");
        scene.remove(o); obstacles.splice(i, 1);
        continue;
      } else {
        triggerCrash();
        return;
      }
    }

    // Near-Miss Detection (Passing closely in adjacent lane!)
    if (!o.userData.nearMissed && o.position.z > playerRoot.position.z + 1.5 && dx > 1.7 && dx < 3.6) {
      o.userData.nearMissed = true;
      nearMisses++;
      boostCombo();
      const nmBonus = 5 * combo;
      save.coins += nmBonus; runCoins += nmBonus;
      advanceMission('nearmiss', 1);
      sound.playCoinChime(combo + 3);
      showComicPopup(`🔥 NEAR MISS! x${combo}`, "#00f2fe");
    }

    if (o.position.z > 14) {
      scene.remove(o); obstacles.splice(i, 1);
    }
  }

  document.getElementById('coinVal').innerText = save.coins;
  document.getElementById('scoreVal').innerText = Math.floor(score);
  composer.render();
}

window.addEventListener('resize', () => {
  camera.aspect = wrapper.clientWidth / wrapper.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
  composer.setSize(wrapper.clientWidth, wrapper.clientHeight);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state === 'PLAYING') window.pauseGame();
    if (sound.ctx && sound.ctx.state === 'running') sound.ctx.suspend();
  } else if (!document.hidden && state !== 'PAUSED') {
    if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
  }
});

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    if (document.getElementById('shopModal').style.display === 'flex') {
      window.closeShop();
    } else if (document.getElementById('rewardsModal').style.display === 'flex') {
      window.closeRewards();
    } else if (document.getElementById('settingsModal').style.display === 'flex') {
      window.closeSettings();
    } else if (state === 'PLAYING') {
      window.pauseGame();
    } else if (state === 'PAUSED') {
      window.resumeGame();
    } else if (state === 'RESULTS') {
      window.closeResultsToGarage();
    } else if (state === 'MENU') {
      window.Capacitor.Plugins.App.exitApp();
    }
  });
}

syncUI();
syncSettingsUI();
renderRewards();
AdManager.init();
animate();
