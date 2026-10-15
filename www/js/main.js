import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AAASoundSystem } from './audio.js';

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

const CAR_SPECS = [
  { name: "FERRARI 458 CYBER", hex: 0xff0033, rimHex: 0x00f2fe, flameHex: 0x00f2fe, price: 0, morph: "🦖 Mecha Rex-Truck", type: "truck", baseSpd: 78 },
  { name: "NEON VIPER 458", hex: 0x00e5ff, rimHex: 0xff0066, flameHex: 0xff0066, price: 300, morph: "✈️ Supersonic Stealth Jet", type: "jet", baseSpd: 85 },
  { name: "EMERALD HYPER 458", hex: 0x00ff66, rimHex: 0xffea00, flameHex: 0x00ff87, price: 750, morph: "🦖 Neon Crusher Rig", type: "truck", baseSpd: 92 },
  { name: "ROYAL GOLD 458", hex: 0xffb800, rimHex: 0xffffff, flameHex: 0xffae00, price: 1500, morph: "✈️ Golden Valkyrie Jet", type: "jet", baseSpd: 100 }
];

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
scene.background = new THREE.Color(0x060218);
scene.fog = new THREE.FogExp2(0x060218, 0.009);

const camera = new THREE.PerspectiveCamera(58, wrapper.clientWidth / wrapper.clientHeight, 0.1, 240);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
wrapper.appendChild(renderer.domElement);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(wrapper.clientWidth, wrapper.clientHeight), 0.6, 0.42, 0.95);
composer.addPass(bloomPass);

// Final lens grade: vignette, film grain and edge chromatic fringe
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, strength: { value: 1 } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float strength;
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
  ctx.fillStyle = 'rgba(10, 7, 26, 0.8)';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(0, 242, 254, 0.14)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0, 242, 254, 0.62)'; ctx.fillRect(8, 0, 10, 512);
  ctx.fillStyle = 'rgba(255, 0, 102, 0.62)'; ctx.fillRect(494, 0, 10, 512);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
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
  new THREE.MeshStandardMaterial({ map: roadTex, transparent: true, roughness: 0.42, metalness: 0.34 })
);
roadOverlay.rotation.x = -Math.PI / 2;
roadOverlay.position.set(0, 0.01, -90);
scene.add(roadOverlay);

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

const exhaustLight = new THREE.PointLight(0x00f2fe, 1.4, 7.5);
exhaustLight.position.set(0, 0.32, 3.3);
playerRoot.add(exhaustLight);

const afterburnerNozzles = new THREE.Group();
const shockCones = [];
[-0.44, 0.44].forEach(nx => {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.11, 0.03, 12, 24),
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
  shockCones.push({ halo, core, ring });
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
  // The shells do the flame now - these embers only smear it. Additive sprites stack along the
  // view axis, so every state emits sparingly and stays small.
  if (isMorphed && tick % (jetMorph ? 3 : 2) !== 0) return;
  if (!isMorphed && tick % 2 !== 0) return;
  const baseOffsets = jetMorph ? [-0.24, 0.24] : (isMorphed ? [-0.64, 0.64] : [-0.44, 0.44]);
  const baseY = jetMorph ? JET_Y + 0.02 : (isMorphed ? 0.85 : 0.38);
  const backZ = jetMorph ? 3.35 : (isMorphed ? 3.25 : 2.25);
  const initScale = isMorphed ? (jetMorph ? 0.15 : 0.24) : (isShifting ? 0.34 : 0.3);

  baseOffsets.forEach(ox => {
    const mat = new THREE.SpriteMaterial({
      map: glowSpriteTex,
      color: 0x00f2fe,
      transparent: true,
      opacity: isMorphed ? 0.18 : 0.3,
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
      vx: (Math.random() - 0.5) * 0.03,
      vy: (Math.random() - 0.5) * 0.02 + 0.01,
      vz: (isMorphed ? 0.5 : 0.3) + Math.random() * 0.12,
      life: 1.0,
      decay: isMorphed ? 0.16 : 0.115,
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
    ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach(part => {
      const obj = baseFerrariModel.getObjectByName(part);
      if (obj) obj.material = carTyreMat;
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

function syncUI() {
  localStorage.setItem('tm3d_arcade_v3', JSON.stringify(save));
  document.getElementById('coinVal').innerText = save.coins;
  document.getElementById('scoreVal').innerText = Math.floor(score);
  document.getElementById('bestScoreBadge').innerText = save.best;

  const spec = CAR_SPECS[save.selectedCar];
  const owned = save.unlocked.includes(save.selectedCar);
  document.getElementById('carNameTxt').innerText = spec.name;
  document.getElementById('carMorphTxt').innerText = spec.morph;

  const ownedTag = document.getElementById('carOwnedTag');
  ownedTag.innerText = owned ? 'OWNED' : `🪙 ${spec.price}`;
  ownedTag.className = `owned-tag ${owned ? '' : 'locked'}`;

  // Update Garage Performance Stat Bars
  const morphSecs = (8.0 + save.nitroLevel * 0.75 + save.selectedCar * 0.5).toFixed(1);
  const morphPct = Math.min(100, Math.floor((parseFloat(morphSecs) / 14) * 100));
  const magPct = Math.min(100, 45 + save.nitroLevel * 10);

  document.getElementById('statSpdVal').innerText = `${spec.baseSpd}%`;
  document.getElementById('statSpdBar').style.width = `${spec.baseSpd}%`;
  document.getElementById('statMorphVal').innerText = `${morphSecs}s`;
  document.getElementById('statMorphBar').style.width = `${morphPct}%`;
  document.getElementById('statMagVal').innerText = `LV.${save.nitroLevel}`;
  document.getElementById('statMagBar').style.width = `${magPct}%`;

  const mainBtn = document.getElementById('mainPlayBtn');
  mainBtn.classList.toggle('locked', !owned);
  mainBtn.innerHTML = owned
    ? '<span class="btn-label">TAP TO RACE</span><span class="btn-chev">▸</span>'
    : `<span class="btn-label">UNLOCK ${spec.name}</span><span class="cost"><span class="coin-icon mini"></span>${spec.price}</span>`;

  const upgCost = save.nitroLevel * 150;
  document.getElementById('upgradeBtn').innerHTML = `<span class="sub-ico">⚡</span><span class="sub-txt">NITRO LV.${save.nitroLevel}</span><span class="cost"><span class="coin-icon mini"></span>${upgCost}</span>`;
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
    showComicPopup(`NITRO LV.${save.nitroLevel} UPGRADED!`, "#00f2fe");
    syncUI();
  } else {
    showComicPopup(`NEED ${cost - save.coins} MORE COINS!`, "#ff9100");
  }
};

window.useHeadstartMorph = () => {
  sound.init(() => state === 'PLAYING');
  if (save.coins >= 100) {
    save.coins -= 100;
    syncUI();
    startRun(true);
  } else {
    // Free Headstart if under 100 coins so kids can always enjoy the feature!
    startRun(true);
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
  activateMorphState(480 + save.nitroLevel * 45);
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
  pill.innerText = `🔥 x${combo}`;
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
  document.getElementById('pauseModal').style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  document.getElementById('resultsModal').style.display = 'none';
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
  document.getElementById('comboPill').style.display = 'none';

  const spec = CAR_SPECS[save.selectedCar];
  speed = 0.80 + (spec.baseSpd - 78) * 0.004;
  lane = 1;
  playerRoot.position.set(0, 0, 0);
  playerRoot.rotation.set(0, 0, 0);
  // Swoop camera from high behind on launch
  camera.position.set(0, 6.2, 12.5);

  if (withMorph) activateMorphState(500 + save.nitroLevel * 45);
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

  document.getElementById('newBestBanner').style.display = isNewRecord ? 'inline-block' : 'none';
  document.getElementById('resDistVal').innerText = `${finalDist}m`;
  document.getElementById('resCoinsVal').innerText = `+${runCoins}`;
  document.getElementById('resSmashVal').innerText = smashes;
  document.getElementById('resNearVal').innerText = nearMisses;
  document.getElementById('resultsModal').style.display = 'flex';
}

function spawnEnemyTrafficCar(laneIndex) {
  const palette = [0x9b59b6, 0xff9100, 0x00e5ff, 0xff0055];
  const enemyColor = palette[Math.floor(Math.random() * palette.length)];
  let enemy;
  if (baseFerrariModel) {
    enemy = baseFerrariModel.clone();
    enemy.getObjectByName('body').material = new THREE.MeshPhysicalMaterial({
      color: enemyColor, metalness: 0.8, roughness: 0.18, clearcoat: 1.0
    });
  } else {
    enemy = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 3.8), new THREE.MeshStandardMaterial({ color: enemyColor }));
  }
  enemy.position.set(LANES[laneIndex], 0, -140);
  enemy.userData = { nearMissed: false };
  scene.add(enemy);
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
        const s = 0.05 + ep.life * 0.16;
        ep.sprite.scale.set(s, s, s);
      } else {
        if (ep.life > 0.72) ep.sprite.material.color.setHex(0x00f2fe);
        else if (ep.life > 0.4) ep.sprite.material.color.setHex(spec.flameHex);
        else ep.sprite.material.color.setHex(0xff0066);

        const s = Math.max(0.05, (1.1 - ep.life) * 0.36);
        ep.sprite.scale.set(s, s, s);
      }
    }

    ep.sprite.material.opacity = Math.max(0, ep.life * (ep.isMorphed ? 0.2 : 0.3));
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
    afterburnerNozzles.visible = false;
    exhaustLight.intensity = 0;
    if (!isDraggingShowroom) showroomAngle += 0.009;
    playerRoot.position.set(0, 0.02, 0);
    contactShadow.visible = true;
    playerRoot.rotation.set(0, showroomAngle, 0);
    podiumGroup.rotation.y = -showroomAngle * 0.5;
    tickSpin.rotation.y += 0.006;
    playerWheels.forEach(w => { w.rotation.x -= 0.02; });
    underglow.material.opacity = 0.34 + Math.sin(tick * 0.045) * 0.12;
    const breathe = Math.sin(tick * 0.011);
    camera.fov += (47 - camera.fov) * 0.1;
    camera.updateProjectionMatrix();
    camera.position.lerp(new THREE.Vector3(breathe * 0.22, 1.9 + breathe * 0.07, 6.25 - breathe * 0.05), 0.08);
    camera.lookAt(0, 0.34 + breathe * 0.02, 0);
    composer.render();
    return;
  }

  // PLAYING STATE
  afterburnerNozzles.visible = !isJetMorph;
  contactShadow.visible = false;
  exhaustLight.position.y += ((isJetMorph ? JET_Y : (morphTimer > 0 ? 0.8 : 0.32)) - exhaustLight.position.y) * 0.18;
  // Every rig parks its light behind its own bodywork. The truck's shell runs back to z 2.94, so the
  // car's z 3.3 buried a candela point light inside the rear panel and blew it out to a white ball.
  exhaustLight.position.z += ((isJetMorph ? 4.2 : (morphTimer > 0 ? 4.7 : 3.3)) - exhaustLight.position.z) * 0.18;
  exhaustLight.intensity = morphTimer > 0 ? 0.8 + Math.random() * 0.3 : (1.3 + Math.random() * 0.6) * boostMult;
  bloomPass.threshold = morphTimer > 0 ? 1.1 : 0.95;
  underglow.material.opacity = morphTimer > 0 ? 0.14 : 0.18;
  playerRoot.rotation.y = 0;
  speed = Math.min(1.68, 0.82 + score * 0.00045);
  score += speed * 0.42;

  // Milestone Toasts every 500m
  if (score >= nextMilestone) {
    showComicPopup(`🏁 ${nextMilestone}m SPEED BOOST!`, "#00f2fe");
    sound.playCoinChime(7);
    nextMilestone += 500;
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
  document.getElementById('mphTxt').innerText = `${Math.floor(140 + (speed - 0.82) * 240 + (morphTimer > 0 ? 85 : 0))} KM/H`;

  playerWheels.forEach(w => { w.rotation.x -= speed * 0.45; });
  monsterWheels.forEach(w => { w.rotation.x -= speed * 0.45; });
  emitPlasmaExhaust(morphTimer > 0, false);

  roadTex.offset.y -= speed * 0.048;

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
    // Weaving runs make you steer for the payout; straight runs reward holding a line
    const weave = Math.random() < 0.4;
    const cLane = weave ? Math.floor(Math.random() * 2) : Math.floor(Math.random() * 3);
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.position.set(LANES[cLane + (weave && i % 2 ? 1 : 0)], 0.95, -120 - i * 4.8);
      scene.add(c);
      coins.push(c);
    }
  }

  if (tick % 340 === 160 && !brainGateGroup) {
    spawnReflexGate3D();
  } else if (tick % 48 === 0 && (!brainGateGroup || brainGateGroup.position.z > -75)) {
    spawnEnemyTrafficCar(Math.floor(Math.random() * 3));
  }

  // Gold rings only fly to the car while a magnet (or a morph) is running - otherwise you have
  // to steer into their lane to bank them.
  const pullRange = morphTimer > 0 ? 26 : (magnetTimer > 0 ? 8 + save.nitroLevel * 1.2 : 0);
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
    spawnMagnetPickup(Math.floor(Math.random() * 3));
    nextMagnetIn = 780 + Math.floor(Math.random() * 300);
  }
  for (let i = magnetPickups.length - 1; i >= 0; i--) {
    const m = magnetPickups[i];
    m.position.z += speed * 1.4;
    m.rotation.y += 0.055;
    m.position.y = 1.1 + Math.sin(tick * 0.11) * 0.13;
    if (Math.abs(m.position.z - playerRoot.position.z) < 2.1 && Math.abs(m.position.x - playerRoot.position.x) < 1.5) {
      magnetTimer = magnetMax = 240 + save.nitroLevel * 18;
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
        activateMorphState(480 + save.nitroLevel * 45);
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
    const dz = Math.abs(o.position.z - playerRoot.position.z);
    const dx = Math.abs(o.position.x - playerRoot.position.x);

    // Collision Check
    if (dz < 3.1 && dx < 1.65 && playerY < 1.3) {
      if (morphTimer > 0 || shieldTimer > 0) {
        smashes++;
        const bonus = 5 * combo;
        save.coins += bonus; runCoins += bonus;
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
    if (document.getElementById('settingsModal').style.display === 'flex') {
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
animate();
