import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { AAASoundSystem } from './audio.js';
import { AdManager } from './ads.js';

let save = JSON.parse(localStorage.getItem('tm3d_arcade_v3')) || {
  coins: 500, best: 0, selectedCar: 0, unlocked: [0], nitroLevel: 1,
  settings: { music: true, sfx: true, voice: true, haptics: true, controls: 'both' }
};
if (!save.settings) {
  save.settings = { music: true, sfx: true, voice: true, haptics: true, controls: 'both' };
}

const CAR_SPECS = [
  { name: "FERRARI 458 CYBER", hex: 0xff0033, rimHex: 0x00f2fe, flameHex: 0x00f2fe, price: 0, morph: "🦖 Mecha Rex-Truck", type: "truck" },
  { name: "NEON VIPER 458", hex: 0x00e5ff, rimHex: 0xff0066, flameHex: 0xff0066, price: 300, morph: "✈️ Supersonic Stealth Jet", type: "jet" },
  { name: "EMERALD HYPER 458", hex: 0x00ff66, rimHex: 0xffea00, flameHex: 0x00ff87, price: 750, morph: "🦖 Neon Crusher Rig", type: "truck" },
  { name: "ROYAL GOLD 458", hex: 0xffb800, rimHex: 0xffffff, flameHex: 0xffae00, price: 1500, morph: "✈️ Golden Valkyrie Jet", type: "jet" }
];

let state = 'MENU'; // 'MENU' | 'PLAYING' | 'PAUSED'
const sound = new AAASoundSystem();
sound.applySettings(save.settings);
AdManager.init();

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
scene.background = new THREE.Color(0x060218);
scene.fog = new THREE.FogExp2(0x060218, 0.009);

const camera = new THREE.PerspectiveCamera(58, wrapper.clientWidth / wrapper.clientHeight, 0.1, 240);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
wrapper.appendChild(renderer.domElement);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(wrapper.clientWidth, wrapper.clientHeight), 0.55, 0.35, 0.82);
composer.addPass(bloomPass);

const dirLight = new THREE.DirectionalLight(0xfff4e8, 2.5);
dirLight.position.set(10, 25, 15);
scene.add(dirLight);

// Synthwave Horizon Sun
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
}
createSynthHorizon();

// Mirror-Wet Highway
const LANES = [-3.2, 0, 3.2];
const mirrorRoad = new Reflector(new THREE.PlaneGeometry(11.6, 220), {
  clipBias: 0.003,
  textureWidth: wrapper.clientWidth * 0.6,
  textureHeight: wrapper.clientHeight * 0.6,
  color: 0x251a4a
});
mirrorRoad.rotation.x = -Math.PI / 2;
mirrorRoad.position.set(0, -0.02, -90);
scene.add(mirrorRoad);

function createAsphaltOverlayTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(14, 8, 32, 0.72)';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(0, 242, 254, 0.18)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  ctx.fillStyle = '#00f2fe'; ctx.fillRect(8, 0, 10, 512);
  ctx.fillStyle = '#ff0066'; ctx.fillRect(494, 0, 10, 512);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(168, 60, 10, 220);
  ctx.fillRect(334, 60, 10, 220);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 28);
  return tex;
}
const roadTex = createAsphaltOverlayTexture();
const roadOverlay = new THREE.Mesh(
  new THREE.PlaneGeometry(11.6, 220),
  new THREE.MeshStandardMaterial({ map: roadTex, transparent: true, roughness: 0.2, metalness: 0.5 })
);
roadOverlay.rotation.x = -Math.PI / 2;
roadOverlay.position.set(0, 0.01, -90);
scene.add(roadOverlay);

// Showroom Turntable Platform
const podiumGroup = new THREE.Group();
const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.3, 0.2, 48), new THREE.MeshStandardMaterial({ color: 0x160c38, metalness: 0.85, roughness: 0.15 }));
baseDisc.position.y = -0.1;
const neonRing = new THREE.Mesh(new THREE.TorusGeometry(3.15, 0.07, 16, 64).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x00f2fe }));
neonRing.position.y = 0.02;
podiumGroup.add(baseDisc, neonRing);
scene.add(podiumGroup);

// Procedural City Skyscrapers
function createBuildingTexture(hueHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#070314'; ctx.fillRect(0, 0, 256, 512);
  for (let y = 16; y < 490; y += 28) {
    for (let x = 16; x < 240; x += 28) {
      if (Math.random() > 0.35) {
        ctx.fillStyle = Math.random() > 0.2 ? hueHex : '#ffffff';
        ctx.fillRect(x, y, 16, 18);
      }
    }
  }
  return new THREE.CanvasTexture(c);
}
const bTex1 = createBuildingTexture('#00f2fe');
const bTex2 = createBuildingTexture('#ff0066');
const bTex3 = createBuildingTexture('#ffea00');
const envScenery = [];

for (let z = 5; z > -185; z -= 13) {
  [-11.8, 11.8].forEach(bx => {
    const h = 15 + Math.random() * 26;
    const t = [bTex1, bTex2, bTex3][Math.floor(Math.random() * 3)];
    const bMat = new THREE.MeshStandardMaterial({
      color: 0x11092a, map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.8, roughness: 0.3
    });
    const bldg = new THREE.Mesh(new THREE.BoxGeometry(5.5, h, 5.5), bMat);
    bldg.position.set(bx + (Math.random() - 0.5) * 2, h / 2, z);
    scene.add(bldg);
    envScenery.push(bldg);
  });
}

// --- TWIN-TURBO AFTERBURNER & PLASMA EXHAUST SYSTEM ---
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

const playerRoot = new THREE.Group();
scene.add(playerRoot);

const exhaustLight = new THREE.PointLight(0x00f2fe, 4.5, 7.5);
exhaustLight.position.set(0, 0.45, 2.35);
playerRoot.add(exhaustLight);

const afterburnerNozzles = new THREE.Group();
const shockCones = [];
[-0.44, 0.44].forEach(nx => {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.13, 0.035, 12, 24),
    new THREE.MeshBasicMaterial({ color: 0x00f2fe })
  );
  ring.position.set(nx, 0.38, 2.15);
  afterburnerNozzles.add(ring);

  const innerCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.65, 16).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  innerCone.position.set(nx, 0.38, 2.45);
  afterburnerNozzles.add(innerCone);

  const outerCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 1.35, 16).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  outerCone.position.set(nx, 0.38, 2.75);
  afterburnerNozzles.add(outerCone);
  shockCones.push({ inner: innerCone, outer: outerCone, ring });
});
playerRoot.add(afterburnerNozzles);

const exhaustPlumes = [];
function emitPlasmaExhaust(isMorphed, isShifting) {
  const baseOffsets = isMorphed ? [-0.55, 0.55] : [-0.44, 0.44];
  const baseY = isMorphed ? 1.15 : 0.38;

  baseOffsets.forEach(ox => {
    const mat = new THREE.SpriteMaterial({
      map: glowSpriteTex,
      color: 0x00f2fe,           // start cyan — never pure white, avoids bloom washout
      transparent: true,
      opacity: 0.45,             // was 0.95 — toned down so bloom stays crisp
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    const spread = (Math.random() - 0.5) * 0.08;
    sprite.position.set(playerRoot.position.x + ox + spread, playerRoot.position.y + baseY + spread, playerRoot.position.z + 2.25);
    const initScale = isMorphed ? 0.48 : 0.32;   // was 0.55/0.52 — smaller, sharper diamonds
    sprite.scale.set(initScale, initScale, initScale);
    scene.add(sprite);

    exhaustPlumes.push({
      sprite,
      vx: (Math.random() - 0.5) * 0.03,
      vy: (Math.random() - 0.5) * 0.02 + 0.01,
      vz: 0.38 + Math.random() * 0.15,
      life: 1.0,
      isMorphed
    });
  });
}

function emitTireDriftSparks(dir) {
  const wheelX = dir > 0 ? -0.9 : 0.9;
  for (let i = 0; i < 14; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowSpriteTex,
      color: i % 2 === 0 ? 0xffea00 : 0xff5500,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(playerRoot.position.x + wheelX, playerRoot.position.y + 0.15, playerRoot.position.z + 1.4);
    sp.scale.setScalar(0.32);
    scene.add(sp);
    exhaustPlumes.push({
      sprite: sp,
      vx: -dir * (0.08 + Math.random() * 0.12),
      vy: 0.04 + Math.random() * 0.08,
      vz: 0.25 + Math.random() * 0.15,
      life: 0.85,
      isSpark: true
    });
  }
}

// --- REAL 3D FERRARI GLTF LOADER (local offline asset) ---
let baseFerrariModel = null;
let playerCarMesh = new THREE.Group();
let monsterTruckGroup = new THREE.Group();
let cyberJetGroup = new THREE.Group();
let playerWheels = [];
let monsterWheels = [];
let monsterTruckWheels = monsterWheels;
playerRoot.add(playerCarMesh, monsterTruckGroup, cyberJetGroup);
monsterTruckGroup.visible = false;
cyberJetGroup.visible = false;

const carBodyMat = new THREE.MeshPhysicalMaterial({
  color: CAR_SPECS[save.selectedCar].hex, metalness: 0.85, roughness: 0.14, clearcoat: 1.0, clearcoatRoughness: 0.04
});
const carDetailsMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.2 });
const carGlassMat = new THREE.MeshPhysicalMaterial({ color: 0x111122, metalness: 0.2, roughness: 0.05, transmission: 0.7, transparent: true });

const dracoLoader = new DRACOLoader();
// Draco decoder is bundled locally in www/assets/draco/
dracoLoader.setDecoderPath('./assets/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// Load local ferrari.glb (vendored offline — no network required)
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

    playerCarMesh.clear();
    const myFerrari = baseFerrariModel.clone();
    playerWheels = [
      myFerrari.getObjectByName('wheel_fl'),
      myFerrari.getObjectByName('wheel_fr'),
      myFerrari.getObjectByName('wheel_rl'),
      myFerrari.getObjectByName('wheel_rr')
    ].filter(Boolean);
    playerCarMesh.add(myFerrari);

    monsterTruckGroup.clear();
    const liftedBody = baseFerrariModel.clone();
    liftedBody.position.y = 0.75;
    liftedBody.scale.set(1.08, 1.12, 1.05);
    monsterTruckGroup.add(liftedBody);

    const bigTireGeo = new THREE.CylinderGeometry(0.78, 0.78, 0.72, 24).rotateZ(Math.PI / 2);
    const bigTireMat = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.85 });
    const rimMat = new THREE.MeshBasicMaterial({ color: 0x00ff87 });
    const lugMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 });
    const spokeMat = new THREE.MeshBasicMaterial({ color: 0x00ff87 });

    monsterWheels.length = 0; // reset on each morph build

    [[-1.25, -1.35], [1.25, -1.35], [-1.25, 1.35], [1.25, 1.35]].forEach(([wx, wz]) => {
      // Giant tire mesh
      const bt = new THREE.Mesh(bigTireGeo, bigTireMat);
      bt.position.set(wx, 0.78, wz);

      // Neon rim disc
      const rimDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.76, 12).rotateZ(Math.PI / 2),
        rimMat
      );
      bt.add(rimDisc);

      // Neon outer rim ring
      const rimRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.44, 0.035, 12, 24).rotateY(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x00ff87 })
      );
      rimRing.position.x = wx > 0 ? 0.37 : -0.37;
      bt.add(rimRing);

      // 6 neon spokes radiating from hub
      for (let s = 0; s < 6; s++) {
        const angle = (s / 6) * Math.PI * 2;
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(0.76, 0.065, 0.065),
          spokeMat
        );
        spoke.position.set(0, Math.cos(angle) * 0.2, Math.sin(angle) * 0.2);
        spoke.rotation.x = angle;
        bt.add(spoke);
      }

      // 8 tread lugs around the outer circumference
      const lugGeo = new THREE.BoxGeometry(0.74, 0.12, 0.18);
      for (let l = 0; l < 8; l++) {
        const a = (l / 8) * Math.PI * 2;
        const lug = new THREE.Mesh(lugGeo, lugMat);
        lug.position.set(0, Math.cos(a) * 0.84, Math.sin(a) * 0.84);
        lug.rotation.x = a;
        bt.add(lug);
      }

      monsterTruckGroup.add(bt);
      monsterWheels.push(bt);
    });
  },
  (xhr) => {
    const pct = Math.round((xhr.loaded / xhr.total) * 100);
    const badge = document.getElementById('loaderBadge');
    if (badge) badge.innerText = `⚡ Loading Ferrari… ${pct}%`;
  },
  (err) => {
    console.error('[GLTF] Ferrari load error:', err);
    document.getElementById('loaderBadge').innerText = '⚠️ 3D Model Load Failed';
  }
);

function initCyberJet() {
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xffd700, metalness: 0.9, roughness: 0.1, clearcoat: 1.0 });
  const wingMat = new THREE.MeshPhysicalMaterial({ color: 0x151528, metalness: 0.8, roughness: 0.2 });
  const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.75, 5.2, 24).rotateX(-Math.PI / 2), bodyMat);
  fuselage.position.y = 1.65;
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.48, 20, 14).scale(0.8, 0.6, 2.3), new THREE.MeshPhysicalMaterial({ color: 0x00f2fe, metalness: 0.95, roughness: 0.05 }));
  canopy.position.set(0, 1.98, -0.3);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.1, 1.5), wingMat);
  wings.position.set(0, 1.65, 0.5);
  cyberJetGroup.add(fuselage, canopy, wings);
}
initCyberJet();

function updatePlayerPaint() {
  const spec = CAR_SPECS[save.selectedCar];
  carBodyMat.color.setHex(spec.hex);
  carDetailsMat.color.setHex(spec.rimHex);
  exhaustLight.color.setHex(spec.flameHex);
  shockCones.forEach(sc => {
    sc.outer.material.color.setHex(spec.flameHex);
    sc.ring.material.color.setHex(spec.flameHex);
  });
}

// --- GAMEPLAY LOGIC ---
let lane = 1, playerY = 0, velY = 0;
let speed = 0.82, score = 0, runCoins = 0, morphTimer = 0, shakeIntensity = 0;
let obstacles = [], coins = [], particles = [], brainGateGroup = null;
let showroomAngle = 0.6;

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

// Dynamic Speed-Scaling Reflex Gates
function spawnReflexGate3D() {
  let a, b, correct, wrong, qText;
  if (score < 400) {
    a = Math.floor(Math.random() * 7) + 2; b = Math.floor(Math.random() * 6) + 2;
    correct = a + b; wrong = correct + (Math.random() > 0.5 ? 2 : -1);
    qText = `⚡ ${a} + ${b} = ?`;
  } else {
    a = Math.floor(Math.random() * 8) + 2; b = Math.floor(Math.random() * 6) + 2;
    correct = a * b; wrong = correct + (Math.random() > 0.5 ? 3 : -2);
    qText = `⚡ ${a} × ${b} = ?`;
  }

  const rightIsLeft = Math.random() > 0.5;
  brainGateGroup = new THREE.Group();
  brainGateGroup.position.z = -135;

  const portalGeo = new THREE.BoxGeometry(3.1, 3.8, 0.35);
  const leftMesh = new THREE.Mesh(portalGeo, new THREE.MeshBasicMaterial({ map: createGateTexture(rightIsLeft ? correct : wrong, '#00f2fe') }));
  leftMesh.position.set(LANES[0], 1.9, 0);
  const rightMesh = new THREE.Mesh(portalGeo, new THREE.MeshBasicMaterial({ map: createGateTexture(!rightIsLeft ? correct : wrong, '#ff0066') }));
  rightMesh.position.set(LANES[2], 1.9, 0);

  brainGateGroup.add(leftMesh, rightMesh);
  brainGateGroup.userData = { correctLane: rightIsLeft ? 0 : 2 };
  scene.add(brainGateGroup);

  const banner = document.getElementById('brainBanner');
  banner.innerText = qText;
  banner.style.display = 'block';
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

// Touch Controls supporting SWIPE, TAP EDGES, or BOTH
let sx = 0, sy = 0, stime = 0;
window.addEventListener('touchstart', e => {
  sx = e.touches[0].clientX;
  sy = e.touches[0].clientY;
  stime = Date.now();
}, { passive: true });

window.addEventListener('touchend', e => {
  if (state !== 'PLAYING') return;
  const dx = e.changedTouches[0].clientX - sx;
  const dy = e.changedTouches[0].clientY - sy;
  const dist = Math.hypot(dx, dy);
  const mode = save.settings.controls || 'both';

  // Swipe Handling
  if ((mode === 'swipe' || mode === 'both') && dist > 24) {
    if (Math.abs(dx) > Math.abs(dy)) shiftLane(dx > 0 ? 1 : -1);
    else if (dy < -24) triggerJump();
    return;
  }

  // Tap Left / Center / Right Screen Edge Handling
  if ((mode === 'tap' || mode === 'both') && dist <= 24 && (Date.now() - stime) < 280) {
    const rect = wrapper.getBoundingClientRect();
    const relX = (e.changedTouches[0].clientX - rect.left) / rect.width;
    if (relX < 0.36) shiftLane(-1);
    else if (relX > 0.64) shiftLane(1);
    else triggerJump();
  }
}, { passive: true });

// --- PAUSE, RESUME, RESTART, QUIT & SETTINGS CONTROLLERS ---
window.pauseGame = () => {
  if (state !== 'PLAYING') return;
  state = 'PAUSED';
  sound.isPaused = true;
  document.getElementById('pauseStatsTxt').innerText = `DISTANCE: ${Math.floor(score)}m  |  RUN COINS: +${runCoins}`;
  document.getElementById('pauseModal').style.display = 'flex';
};

window.resumeGame = () => {
  if (state !== 'PAUSED') return;
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  // Backgrounding suspends the AudioContext; resume() it on the way back in
  sound.init(() => state === 'PLAYING');
  sound.isPaused = false;
  state = 'PLAYING';
};

window.restartRace = () => {
  document.getElementById('pauseModal').style.display = 'none';
  sound.isPaused = false;
  startRun(false);
};

window.quitToGarage = () => {
  document.getElementById('pauseModal').style.display = 'none';
  sound.isPaused = false;
  state = 'MENU';
  podiumGroup.visible = true;
  morphTimer = 0;
  playerCarMesh.visible = true;
  monsterTruckGroup.visible = false;
  cyberJetGroup.visible = false;

  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }
  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];

  document.getElementById('brainBanner').style.display = 'none';
  document.getElementById('morphHud').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'none';
  document.getElementById('pauseBtn').style.display = 'none';
  document.getElementById('speedLines').style.opacity = '0';

  save.best = Math.max(save.best, Math.floor(score));
  syncUI();

  document.getElementById('menuTitle').innerText = "TURBO MORPH";
  document.getElementById('menuSub').innerText = `BEST: ${save.best}m  |  SAVED +${runCoins} COINS!`;
  document.getElementById('reviveBtn').style.display = 'none';
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

function syncUI() {
  localStorage.setItem('tm3d_arcade_v3', JSON.stringify(save));
  document.getElementById('coinVal').innerText = save.coins;
  document.getElementById('scoreVal').innerText = Math.floor(score);

  const spec = CAR_SPECS[save.selectedCar];
  const owned = save.unlocked.includes(save.selectedCar);
  document.getElementById('carNameTxt').innerText = spec.name;
  document.getElementById('carMorphTxt').innerText = `Morphs into: ${spec.morph}`;

  const mainBtn = document.getElementById('mainPlayBtn');
  if (owned) {
    mainBtn.innerHTML = 'TAP TO RACE! 🚀';
    mainBtn.style.background = 'linear-gradient(180deg, #00ff87 0%, #00c964 55%, #009e4f 100%)';
  } else {
    mainBtn.innerHTML = `UNLOCK FERRARI (<span class="coin-icon"></span> ${spec.price})`;
    mainBtn.style.background = 'linear-gradient(180deg, #ffd700, #ff8800)';
  }

  const upgCost = save.nitroLevel * 150;
  document.getElementById('upgradeBtn').innerHTML = `⚡ NITRO LV.${save.nitroLevel}<br><span class='coin-icon' style='width:14px;height:14px;vertical-align:middle;'></span> ${upgCost}`;
}

window.cycleCar = (dir) => {
  sound.init(() => state === 'PLAYING');
  save.selectedCar = (save.selectedCar + dir + CAR_SPECS.length) % CAR_SPECS.length;
  updatePlayerPaint();
  sound.triggerExhaustBackfire();
  syncUI();
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

window.upgradeNitro = () => {
  sound.init(() => state === 'PLAYING');
  const cost = save.nitroLevel * 150;
  if (save.coins >= cost) {
    save.coins -= cost;
    save.nitroLevel++;
    sound.playMorphPowerup();
    showComicPopup(`NITRO LV.${save.nitroLevel} MAXED!`, "#00f2fe");
    syncUI();
  } else {
    AdManager.showRewardedAd("Free +200 Coins Boost", () => {
      save.coins += 200;
      syncUI();
      showComicPopup("+200 COINS!", "#ffd700");
    });
  }
};

window.watchAdStartMorph = () => {
  sound.init(() => state === 'PLAYING');
  AdManager.showRewardedAd("Start With Mega Morph", () => startRun(true));
};

window.watchAdRevive = () => {
  sound.init(() => state === 'PLAYING');
  AdManager.showRewardedAd("Revive Run", () => {
    document.getElementById('menuOverlay').style.display = 'none';
    document.getElementById('rpmHud').style.display = 'flex';
    document.getElementById('pauseBtn').style.display = 'flex';
    podiumGroup.visible = false;
    obstacles.forEach(o => scene.remove(o)); obstacles = [];
    activateMorphState(480 + save.nitroLevel * 45);
    sound.isPaused = false;
    state = 'PLAYING';
  });
};

function activateMorphState(frames = 480) {
  morphTimer = frames;
  const morphType = CAR_SPECS[save.selectedCar].type;
  playerCarMesh.visible = false;
  monsterTruckGroup.visible = (morphType === 'truck');
  cyberJetGroup.visible = (morphType === 'jet');
  document.getElementById('morphHud').innerText = `${CAR_SPECS[save.selectedCar].morph.toUpperCase()} ACTIVE!`;
  document.getElementById('morphHud').style.display = 'block';
  document.getElementById('speedLines').style.opacity = '1';
  sound.playMorphPowerup();
}

function startRun(withMorph) {
  if (!save.unlocked.includes(save.selectedCar)) {
    save.selectedCar = 0; updatePlayerPaint();
  }
  document.getElementById('menuOverlay').style.display = 'none';
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'flex';
  document.getElementById('pauseBtn').style.display = 'flex';
  podiumGroup.visible = false;
  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];
  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }
  document.getElementById('brainBanner').style.display = 'none';

  score = 0; runCoins = 0; speed = 0.82; lane = 1;
  playerRoot.position.set(0, 0, 0);
  playerRoot.rotation.set(0, 0, 0);

  if (withMorph) activateMorphState(500 + save.nitroLevel * 45);
  else {
    morphTimer = 0;
    playerCarMesh.visible = true; monsterTruckGroup.visible = false; cyberJetGroup.visible = false;
    document.getElementById('morphHud').style.display = 'none';
    document.getElementById('speedLines').style.opacity = '0';
    sound.speakAnnouncer("LET'S GO!");
  }
  sound.init(() => state === 'PLAYING');
  sound.isPaused = false;
  state = 'PLAYING';
}

function triggerCrash() {
  state = 'MENU';
  podiumGroup.visible = true;
  shakeIntensity = 0.85;
  sound.playCrashImpact();
  AdManager.tryShowInterstitial();
  spawnExplosion3D(playerRoot.position, 0xff0055, 32);

  morphTimer = 0;
  playerCarMesh.visible = true;
  monsterTruckGroup.visible = false;
  cyberJetGroup.visible = false;
  if (brainGateGroup) { scene.remove(brainGateGroup); brainGateGroup = null; }

  document.getElementById('brainBanner').style.display = 'none';
  document.getElementById('morphHud').style.display = 'none';
  document.getElementById('rpmHud').style.display = 'none';
  document.getElementById('pauseBtn').style.display = 'none';
  document.getElementById('speedLines').style.opacity = '0';

  obstacles.forEach(o => scene.remove(o)); obstacles = [];
  coins.forEach(c => scene.remove(c)); coins = [];

  save.best = Math.max(save.best, Math.floor(score));
  syncUI();

  document.getElementById('menuTitle').innerText = "CRASHED!";
  document.getElementById('menuSub').innerText = `RUN: ${Math.floor(score)}m (BEST: ${save.best}m) | +${runCoins} COINS`;
  document.getElementById('reviveBtn').style.display = 'block';
  document.getElementById('menuOverlay').style.display = 'flex';
}

function spawnEnemyTrafficCar(laneIndex) {
  const palette = [0x9b59b6, 0xff9100, 0x00e5ff, 0xff0055];
  const enemyColor = palette[Math.floor(Math.random() * palette.length)];
  let enemy;
  if (baseFerrariModel) {
    enemy = baseFerrariModel.clone();
    const bodyObj = enemy.getObjectByName('body');
    if (bodyObj) {
      bodyObj.material = new THREE.MeshPhysicalMaterial({
        color: enemyColor, metalness: 0.8, roughness: 0.18, clearcoat: 1.0
      });
    }
  } else {
    enemy = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 3.8), new THREE.MeshStandardMaterial({ color: enemyColor }));
  }
  enemy.position.set(LANES[laneIndex], 0, -140);
  scene.add(enemy);
  obstacles.push(enemy);
}

let tick = 0;
const coinGeo = new THREE.TorusGeometry(0.48, 0.16, 12, 24);
const coinMat = new THREE.MeshPhysicalMaterial({ color: 0xffd700, emissive: 0xaa5500, metalness: 0.95, roughness: 0.08, clearcoat: 1.0 });

function animate() {
  requestAnimationFrame(animate);

  const spec = CAR_SPECS[save.selectedCar];
  sound.updateEngine(speed, state === 'PLAYING', morphTimer > 0, spec.type);

  // Freeze scene simulation cleanly while PAUSED
  if (state === 'PAUSED') {
    composer.render();
    return;
  }

  tick++;

  const pulse = 0.85 + Math.sin(tick * 0.65) * 0.28;
  const boostMult = morphTimer > 0 ? 1.85 : (state === 'PLAYING' ? 1.15 : 0.45);
  exhaustLight.intensity = (3.5 + Math.random() * 2.0) * boostMult;
  afterburnerNozzles.position.y = morphTimer > 0 ? 0.72 : 0;
  shockCones.forEach(sc => {
    sc.inner.scale.set(1, pulse * boostMult, 1);
    sc.outer.scale.set(1 + Math.random() * 0.15, (pulse + 0.2) * boostMult, 1 + Math.random() * 0.15);
  });

  for (let i = exhaustPlumes.length - 1; i >= 0; i--) {
    const ep = exhaustPlumes[i];
    ep.sprite.position.x += ep.vx;
    ep.sprite.position.y += ep.vy;
    ep.sprite.position.z += ep.vz;
    ep.life -= ep.isSpark ? 0.065 : 0.075;

    if (!ep.isSpark) {
      // cyan → car color → magenta — no pure white so bloom stays tight
      if (ep.life > 0.72) ep.sprite.material.color.setHex(0x00f2fe);
      else if (ep.life > 0.4) ep.sprite.material.color.setHex(ep.isMorphed ? 0xffae00 : spec.flameHex);
      else ep.sprite.material.color.setHex(0xff0066);

      const s = Math.max(0.05, (1.15 - ep.life) * (ep.isMorphed ? 1.35 : 0.9));
      ep.sprite.scale.set(s, s, s);
    }

    ep.sprite.material.opacity = Math.max(0, Math.min(0.45, ep.life));
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

  if (state === 'MENU') {
    showroomAngle += 0.012;
    playerRoot.position.set(0, 0.02, 0);
    playerRoot.rotation.set(0, showroomAngle, 0);
    podiumGroup.rotation.y = -showroomAngle * 0.5;
    camera.fov += (50 - camera.fov) * 0.1;
    camera.updateProjectionMatrix();
    // Hide exhaust cones while parked on showroom turntable
    afterburnerNozzles.visible = false;
    exhaustLight.intensity = 0;
    // Camera pulled back to Z=6.6 so the entire Ferrari fits inside the portrait frame
    camera.position.lerp(new THREE.Vector3(0, 2.15, 6.6), 0.08);
    camera.lookAt(0, 0.55, 0);
    composer.render();
    return;
  }

  // Restore exhaust FX now that we are in PLAYING state
  afterburnerNozzles.visible = true;

  playerRoot.rotation.y = 0;
  speed = Math.min(1.65, 0.82 + score * 0.00045);
  score += speed * 0.42;

  document.getElementById('gearTxt').innerText = morphTimer > 0 ? 'MAX' : `G${sound.gear}`;
  document.getElementById('rpmBarFill').style.width = `${Math.floor(sound.rpm * 100)}%`;
  document.getElementById('mphTxt').innerText = `${Math.floor(140 + (speed - 0.82) * 240 + (morphTimer > 0 ? 85 : 0))} KM/H`;

  playerWheels.forEach(w => { w.rotation.x -= speed * 0.45; });
  monsterWheels.forEach(w => w.rotation.x -= speed * 0.45);
  emitPlasmaExhaust(morphTimer > 0, false);

  roadTex.offset.y -= speed * 0.048;

  const targetFOV = morphTimer > 0 ? 75 : 58;
  camera.fov += (targetFOV - camera.fov) * 0.1;
  camera.updateProjectionMatrix();

  const shakeX = (Math.random() - 0.5) * shakeIntensity;
  const shakeY = (Math.random() - 0.5) * shakeIntensity;
  shakeIntensity *= 0.86;

  camera.position.lerp(new THREE.Vector3(playerRoot.position.x * 0.52 + shakeX, 2.75 + shakeY, 6.5), 0.2);
  camera.lookAt(playerRoot.position.x * 0.3, 0.9, -15);

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

  if (morphTimer > 0) {
    morphTimer--;
    if (morphTimer === 0) {
      playerCarMesh.visible = true; monsterTruckGroup.visible = false; cyberJetGroup.visible = false;
      document.getElementById('morphHud').style.display = 'none';
      document.getElementById('speedLines').style.opacity = '0';
      spawnExplosion3D(playerRoot.position, 0x00f2fe, 18);
    }
  }

  if (tick % 32 === 0) {
    const cLane = Math.floor(Math.random() * 3);
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.position.set(LANES[cLane], 0.95, -120 - i * 4.8);
      scene.add(c);
      coins.push(c);
    }
  }

  if (tick % 340 === 160 && !brainGateGroup) {
    spawnReflexGate3D();
  } else if (tick % 48 === 0 && (!brainGateGroup || brainGateGroup.position.z > -75)) {
    spawnEnemyTrafficCar(Math.floor(Math.random() * 3));
  }

  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    c.position.z += speed * 1.4;
    c.rotation.y += 0.09;
    if (morphTimer > 0 && c.position.z > -28) {
      c.position.x += (playerRoot.position.x - c.position.x) * 0.2;
    }
    if (Math.abs(c.position.z - playerRoot.position.z) < 2.3 && Math.abs(c.position.x - playerRoot.position.x) < 1.65) {
      save.coins++; runCoins++;
      sound.playCoinChime(runCoins);
      spawnExplosion3D(c.position, 0xffd700, 6);
      scene.remove(c); coins.splice(i, 1);
    } else if (c.position.z > 12) {
      scene.remove(c); coins.splice(i, 1);
    }
  }

  if (brainGateGroup) {
    brainGateGroup.position.z += speed * 1.3;
    if (Math.abs(brainGateGroup.position.z - playerRoot.position.z) < 1.9) {
      if (lane === brainGateGroup.userData.correctLane) {
        activateMorphState(480 + save.nitroLevel * 45);
        save.coins += 20; runCoins += 20;
        shakeIntensity = 0.6;
        spawnExplosion3D(playerRoot.position, 0x00ff87, 30);
        showComicPopup("⚡ MEGA MORPH!", "#00ff87");
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

  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.position.z += speed * 1.18;
    if (Math.abs(o.position.z - playerRoot.position.z) < 3.2 && Math.abs(o.position.x - playerRoot.position.x) < 1.65 && playerY < 1.3) {
      if (morphTimer > 0) {
        save.coins += 5; runCoins += 5;
        shakeIntensity = 0.5;
        sound.playCrashImpact();
        sound.speakAnnouncer("SMASH!");
        spawnExplosion3D(o.position, 0xff0055, 24);
        showComicPopup('SMASH! +5 <span class="coin-icon" style="width:28px;height:28px;vertical-align:middle;"></span>', '#ffea00');
        scene.remove(o); obstacles.splice(i, 1);
        continue;
      } else {
        triggerCrash();
        return;
      }
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

syncUI();
syncSettingsUI();
animate();

// --- APP BACKGROUNDING + ANDROID HARDWARE BACK BUTTON ---
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
    if (document.getElementById('settingsModal').style.display === 'flex') {
      window.closeSettings();
    } else if (state === 'PLAYING') {
      window.pauseGame();
    } else if (state === 'PAUSED') {
      window.resumeGame();
    }
  });
}
