// Thalyn® atmosphere runtime for the web viewers (/viewer/ and /commons/).
//
// A Thalyn .glb may carry a root `extras.thalyn` block (sky, fog, water tone, hearths, the camera the
// picture was taken from, the world's bounds) and a baked sky dome (an unlit sphere textured with an
// equirect of the sky). Any glTF viewer shows the dome; this module lifts it out of the scene and turns
// it into the real background + image-based light, blends the numeric block into three.js lighting,
// adds the cinematic pass (bloom + a per-tone grade), first-person walking, and a night sky.
// Everything degrades silently: no block → viewer defaults, no dome → procedural sky.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// BVH-accelerated raycasting: an optimised single-file world merges into a handful of huge meshes
// (a 13M-triangle ground-cover mesh was measured), and a per-frame linear raycast against that is
// seconds per step. Trees are built lazily, only for meshes the ground probe actually touches.
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.6/build/index.module.js';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const SKY_MATERIAL = /^Thalyn_Sky_Baked/i;
export const LIQUID = /^Thalyn_(Water|Lava)_Baked/i;
export const FOLIAGE = /(^|[^a-z])(leaf|foliage|flower|petal|grass|shrub|frond|canopy|billboard|bush|fern|vine)/i;

export const rgbOf = a => (Array.isArray(a) && a.length >= 3)
  ? new THREE.Color().setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace) : null;
const v3 = a => (Array.isArray(a) && a.length >= 3) ? new THREE.Vector3(a[0], a[1], a[2]) : null;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ── The block ────────────────────────────────────────────────────────────────
export function readBlock(gltf) {
  const j = gltf && gltf.parser && gltf.parser.json;
  const tx = j && j.extras && j.extras.thalyn;
  return (tx && typeof tx === 'object') ? tx : null;
}
export function hasBlock(tx) { return !!(tx && typeof tx.version === 'string'); }

export const TONES = ['serene', 'joyful', 'oppressive', 'desolate', 'eerie', 'chaotic'];
export function toneOf(tx) {
  const t = String(tx && tx.tone || '').toLowerCase();
  return TONES.includes(t) ? t : 'serene';
}

// ── Sky dome: lift the baked sky out of the world and make it the environment ─
// Returns the equirect texture (already oriented for three.js) or null. The dome meshes are removed
// from the scene so they neither draw nor take part in framing / walking / fog.
export function extractSkyDome(root) {
  let tex = null; const doomed = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.some(m => m && SKY_MATERIAL.test(m.name || ''))) return;
    for (const m of mats) { if (m && !tex && m.map) tex = m.map; }
    doomed.push(o);
  });
  for (const o of doomed) { if (o.parent) o.parent.remove(o); if (o.geometry) o.geometry.dispose(); }
  if (tex) {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
  }
  return tex;
}

// Owns scene.background / scene.environment: a baked dome when one is present, else the procedural sky.
export function makeSkyEnv(renderer, scene, roomEnvTexture) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const cache = new Map(); // texture → pmrem RT
  let current = null;
  function useDome(tex) {
    if (!tex) { current = null; scene.background = null; scene.environment = roomEnvTexture || null; return false; }
    if (current === tex) return true;
    let rt = cache.get(tex);
    if (!rt) { rt = pmrem.fromEquirectangular(tex); cache.set(tex, rt); }
    scene.background = tex;
    scene.backgroundBlurriness = 0;
    scene.environment = rt.texture;
    current = tex;
    return true;
  }
  return {
    useDome,
    get active() { return current; },
    dispose() { for (const rt of cache.values()) rt.dispose(); cache.clear(); pmrem.dispose(); }
  };
}

// ── Numeric atmosphere state (blendable) ────────────────────────────────────
// One flat record every page can lerp: sun direction/colour/intensity, hemisphere, exposure, fog, night.
export function defaultState(worldRadius = 100) {
  return {
    sunDir: new THREE.Vector3(0.4, 0.55, 0.6).normalize(),
    sunColor: new THREE.Color(0xfff4e0), sunIntensity: 2.2,
    hemiSky: new THREE.Color(0xbfd8ff), hemiGround: new THREE.Color(0x4a3f33), hemiIntensity: 0.6,
    exposure: 1.0,
    fogColor: new THREE.Color(0xbcd0e0), fogDensity: 0, // 0 = none
    night: 0, tone: 'serene', hasBlock: false,
  };
}
export function stateFromBlock(tx, worldRadius = 100) {
  const s = defaultState(worldRadius);
  if (!hasBlock(tx)) return s;
  s.hasBlock = true; s.tone = toneOf(tx);
  const sk = tx.sky || {};
  const d = v3(sk.sunDirection);
  if (d && d.lengthSq() > 1e-6) s.sunDir.copy(d.normalize());
  const below = s.sunDir.y < 0.02;
  const sc = rgbOf(sk.sunColor); if (sc) s.sunColor.copy(sc);
  if (below) s.sunIntensity = 0.12;
  else if (typeof sk.sunIntensity === 'number' && sk.sunIntensity > 0) s.sunIntensity = clamp(sk.sunIntensity, 0.15, 4);
  const amb = rgbOf(sk.ambient);
  if (amb && (sk.ambient[0] + sk.ambient[1] + sk.ambient[2]) > 0.15) s.hemiSky.copy(amb);
  if (typeof sk.ambientIntensity === 'number' && sk.ambientIntensity > 0) s.hemiIntensity = clamp(sk.ambientIntensity, 0.05, 2);
  if (typeof sk.exposure === 'number' && sk.exposure > 0) s.exposure = clamp(sk.exposure, 0.3, 2.5);
  const ns = tx.nightSky;
  if (ns && ns.enabled) {
    const z = rgbOf(ns.zenith), h = rgbOf(ns.horizon);
    if (z) s.hemiSky.copy(z).multiplyScalar(4);
    if (h) s.hemiGround.copy(h);
    s.hemiIntensity = Math.max(s.hemiIntensity, 0.35);
    s.night = 1;
  } else if (below) s.night = 1;
  else if (typeof tx.timeOfDay === 'number' && tx.timeOfDay >= 0) {
    const t = tx.timeOfDay; s.night = (t < 0.22 || t > 0.8) ? 1 : (t < 0.28 ? (0.28 - t) / 0.06 : (t > 0.74 ? (t - 0.74) / 0.06 : 0));
  }
  // Fog: the exported fog verbatim, else the haze band, folded into one exponential density.
  const fg = tx.fog || {}; const hf = fg.heightFog;
  const fc = fg.enabled ? rgbOf(fg.color) : null, hc = hf && hf.armed ? rgbOf(hf.hazeColor) : null;
  if (fc || hc) {
    s.fogColor.copy(fc || hc);
    let dens = fc ? (String(fg.mode || '').toLowerCase().includes('linear') && fg.end > fg.start ? 3 / Math.max(1, fg.end) : fg.density) : hf.hazeDensity;
    if (!(dens > 0)) dens = 1.2 / Math.max(1, worldRadius);
    s.fogDensity = Math.min(dens, 0.05);
  } else {
    // A gentle aerial perspective sized to the world, so even a block without fog gets distance.
    s.fogDensity = 0.6 / Math.max(60, worldRadius);
    s.fogColor.copy(s.night ? new THREE.Color(0x1a2230) : s.hemiSky.clone().lerp(new THREE.Color(0xdde6ee), 0.5));
  }
  return s;
}
export function lerpState(a, b, t, out) {
  out = out || defaultState();
  t = clamp(t, 0, 1);
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, t).normalize();
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;
  out.exposure = a.exposure + (b.exposure - a.exposure) * t;
  out.fogColor.copy(a.fogColor).lerp(b.fogColor, t);
  out.fogDensity = a.fogDensity + (b.fogDensity - a.fogDensity) * t;
  out.night = a.night + (b.night - a.night) * t;
  out.tone = t < 0.5 ? a.tone : b.tone;
  out.hasBlock = a.hasBlock || b.hasBlock;
  return out;
}

// The lights every page owns: a Sky, a directional sun (shadows), a hemisphere. Apply a state to them.
export function makeLights() {
  const sky = new Sky(); sky.scale.setScalar(450000);
  const u = sky.material.uniforms;
  u['turbidity'].value = 8; u['rayleigh'].value = 2.2; u['mieCoefficient'].value = 0.005; u['mieDirectionalG'].value = 0.8;
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a3f33, 0.6);
  const stars = makeStars(1400); stars.visible = false;
  return { sky, sun, hemi, stars };
}
export function applyState(s, L, renderer, scene, fogOn = true) {
  L.sky.material.uniforms['sunPosition'].value.copy(s.sunDir);
  L.sun.position.copy(s.sunDir).multiplyScalar(8000);
  L.sun.color.copy(s.sunColor); L.sun.intensity = s.sunIntensity;
  L.hemi.color.copy(s.hemiSky); L.hemi.groundColor.copy(s.hemiGround); L.hemi.intensity = s.hemiIntensity;
  renderer.toneMappingExposure = s.exposure;
  if (fogOn && s.fogDensity > 0) {
    if (scene.fog && scene.fog.isFogExp2) { scene.fog.color.copy(s.fogColor); scene.fog.density = s.fogDensity; }
    else scene.fog = new THREE.FogExp2(s.fogColor.getHex(), s.fogDensity);
  } else scene.fog = null;
  // Stars at night — including over a baked night dome (the bake carries the sky's colour, but the
  // moon and stars are drawn objects, not the sky material, so a night bake is honestly near-black).
  L.stars.visible = s.night > 0.35;
  if (L.stars.visible) L.stars.material.opacity = clamp((s.night - 0.35) / 0.4, 0, 1);
}
// Sun elevation from a slider (0..1) keeping the current azimuth — the HUD's "Sun" control.
export function sunFromElevation(s, elev) {
  const az = Math.atan2(s.sunDir.z, s.sunDir.x);
  const phi = THREE.MathUtils.degToRad(90 - elev * 90);
  s.sunDir.set(Math.cos(az) * Math.sin(phi), Math.cos(phi), Math.sin(az) * Math.sin(phi)).normalize();
  s.sunIntensity = 0.4 + elev * 2.4;
}

function makeStars(n) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    const y = Math.abs(u) * 0.92 + 0.06;
    pos[i * 3] = r * Math.cos(a) * 9000; pos[i * 3 + 1] = y * 9000; pos[i * 3 + 2] = r * Math.sin(a) * 9000;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = -1000;
  return p;
}

// ── Hearths / torches → warm point lights + glow sprites, with a live flicker ─
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,220,160,1)'); grd.addColorStop(0.35, 'rgba(255,160,70,0.55)'); grd.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(cv); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
export function buildAnchors(list, parent) {
  const root = new THREE.Group(); root.name = 'Thalyn_Anchors';
  const flames = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 48)) {
    const p = a && a.position; if (!Array.isArray(p) || p.length < 3) continue;
    const kind = String(a.builder || '').toLowerCase();
    const torch = kind.includes('torch'), hearth = kind.includes('hearth') || kind.includes('fire') || kind.includes('camp');
    if (!torch && !hearth) continue;
    const colour = torch ? 0xffb050 : 0xff8a38;
    const light = new THREE.PointLight(colour, torch ? 14 : 28, torch ? 12 : 22, 2);
    light.position.set(p[0], p[1] + (torch ? 1.6 : 0.9), p[2]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: colour, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
    const base = torch ? 1.4 : 3.2;
    sprite.scale.setScalar(base);
    sprite.position.set(p[0], p[1] + (torch ? 1.5 : 0.7), p[2]);
    root.add(light, sprite);
    flames.push({ light, sprite, base: light.intensity, scale: base, phase: Math.random() * 10 });
  }
  parent.add(root);
  root.userData.flames = flames;
  return root;
}
export function tickAnchors(root, t) {
  const flames = root && root.userData && root.userData.flames; if (!flames) return;
  for (const f of flames) {
    const n = 0.86 + 0.14 * Math.sin(t * 9.1 + f.phase) * Math.sin(t * 3.7 + f.phase * 1.3) + 0.06 * Math.sin(t * 23 + f.phase);
    f.light.intensity = f.base * n; f.sprite.scale.setScalar(f.scale * (0.92 + 0.08 * n));
  }
}

export function tintWater(water, root, lavaMats) {
  const deep = rgbOf(water && water.deep), shallow = rgbOf(water && water.shallow);
  if (!deep) return 0;
  const tint = shallow ? deep.clone().lerp(shallow, 0.35) : deep;
  const clarity = (typeof water.clarity === 'number' && water.clarity > 0) ? water.clarity : 1;
  const opacity = clamp(0.95 - 0.1 * clarity, 0.55, 0.95);
  let n = 0;
  root.traverse(o => {
    if (!o.isMesh || (!o.userData.__liquid && !/^Thalyn_Water/i.test(o.name || ''))) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (!m || !m.color || (lavaMats && lavaMats.includes(m))) return;
      m.color.copy(tint); if (m.transparent) m.opacity = opacity; m.needsUpdate = true; n++;
    });
  });
  return n;
}

// The camera the picture was taken from (present only when the export carried it).
export function cameraPose(tx) {
  const c = tx && tx.camera; if (!c || !c.present) return null;
  const p = v3(c.position), f = v3(c.forward); if (!p || !f) return null;
  return { position: p, forward: f.normalize(), fov: (c.fovDeg > 10 && c.fovDeg < 150) ? c.fovDeg : null,
           yaw: typeof c.yawDeg === 'number' ? c.yawDeg : null, pitch: typeof c.pitchDeg === 'number' ? c.pitchDeg : null };
}
export function worldBounds(tx) {
  const b = tx && tx.bounds; if (!b || !b.present) return null;
  const c = v3(b.center); if (!c) return null;
  return { center: c, radius: b.radius > 0 ? b.radius : 100, minY: b.minY, maxY: b.maxY };
}

// ── Cinematic pass: bloom + per-tone grade ───────────────────────────────────
export const TONE_GRADES = {
  serene:     { tint: [1.02, 1.00, 0.97], sat: 1.05, vig: 0.28, lift: 0.00, bloom: 0.32 },
  joyful:     { tint: [1.04, 1.01, 0.95], sat: 1.18, vig: 0.16, lift: 0.01, bloom: 0.40 },
  oppressive: { tint: [0.92, 0.95, 1.03], sat: 0.80, vig: 0.48, lift: -0.02, bloom: 0.26 },
  desolate:   { tint: [1.02, 0.97, 0.90], sat: 0.72, vig: 0.42, lift: -0.01, bloom: 0.22 },
  eerie:      { tint: [0.90, 1.02, 0.98], sat: 0.86, vig: 0.52, lift: -0.02, bloom: 0.45 },
  chaotic:    { tint: [1.06, 0.96, 0.98], sat: 1.14, vig: 0.36, lift: 0.00, bloom: 0.50 },
};
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1 },
              uVig: { value: 0.3 }, uLift: { value: 0 }, uAspect: { value: 1 }, uCon: { value: 1 },
              uSplitS: { value: new THREE.Vector3(1, 1, 1) }, uSplitH: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec3 uTint, uSplitS, uSplitH;
    uniform float uSat, uVig, uLift, uAspect, uCon; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = mix(vec3(l), c.rgb, uSat) * uTint + uLift;
      col = (col - 0.18) * uCon + 0.18;                       // contrast about mid grey (pre-tonemap)
      float lm = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)) * 1.4, 0.0, 1.0);
      col *= mix(uSplitS, uSplitH, lm);                       // split-tone: shadows vs highlights
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = smoothstep(0.35, 1.05, length(q));
      col *= 1.0 - uVig * v;
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }`
};
// Film looks — parameter-fitted grades in the spirit of the app's looks (parameters only; nothing shipped
// as a LUT). 'auto' = the world's mood chooses (TONE_GRADES); every other look overrides it.
export const LOOKS = {
  auto:      null,
  golden:    { tint: [1.08, 1.00, 0.86], sat: 1.10, con: 1.04, lift: 0.010, vig: 0.30, bloom: 0.42, splitS: [1.00, 0.97, 0.92], splitH: [1.06, 1.01, 0.90] },
  silver:    { tint: [0.99, 1.00, 1.02], sat: 0.55, con: 1.10, lift: 0.000, vig: 0.34, bloom: 0.26, splitS: [0.96, 0.98, 1.04], splitH: [1.02, 1.02, 1.00] },
  verdant:   { tint: [0.97, 1.04, 0.96], sat: 1.16, con: 1.02, lift: 0.008, vig: 0.24, bloom: 0.34, splitS: [0.95, 1.02, 0.97], splitH: [1.02, 1.03, 0.96] },
  noir:      { tint: [1.00, 1.00, 1.00], sat: 0.00, con: 1.22, lift: -0.012, vig: 0.55, bloom: 0.22, splitS: [0.98, 0.99, 1.03], splitH: [1.01, 1.01, 1.00] },
  tealamber: { tint: [1.02, 1.00, 0.99], sat: 1.06, con: 1.08, lift: 0.000, vig: 0.32, bloom: 0.36, splitS: [0.90, 1.00, 1.08], splitH: [1.10, 1.01, 0.88] },
  bleach:    { tint: [1.00, 1.00, 1.00], sat: 0.55, con: 1.20, lift: -0.006, vig: 0.30, bloom: 0.30, splitS: [0.98, 0.99, 1.00], splitH: [1.03, 1.03, 1.01] },
  pastel:    { tint: [1.03, 1.00, 1.02], sat: 0.85, con: 0.90, lift: 0.030, vig: 0.14, bloom: 0.45, splitS: [1.02, 0.99, 1.04], splitH: [1.03, 1.01, 1.00] },
  ember:     { tint: [1.10, 0.96, 0.88], sat: 1.05, con: 1.10, lift: -0.006, vig: 0.42, bloom: 0.50, splitS: [1.04, 0.94, 0.88], splitH: [1.10, 1.00, 0.86] },
  moonlit:   { tint: [0.92, 0.97, 1.10], sat: 0.80, con: 1.06, lift: -0.004, vig: 0.44, bloom: 0.55, splitS: [0.90, 0.95, 1.10], splitH: [1.00, 1.01, 1.05] },
};
export function makePost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.92);
  composer.addPass(bloom);
  const shafts = new ShaderPass(SunShaftsShader);
  composer.addPass(shafts);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  let enabled = true, tone = 'serene', look = 'auto', shaftStrength = 0;
  function applyGrade() {
    const t = TONE_GRADES[tone] || TONE_GRADES.serene;
    const g = (look !== 'auto' && LOOKS[look]) ? LOOKS[look] : t;
    grade.uniforms.uTint.value.set(g.tint[0], g.tint[1], g.tint[2]);
    grade.uniforms.uSat.value = g.sat; grade.uniforms.uVig.value = g.vig; grade.uniforms.uLift.value = g.lift;
    grade.uniforms.uCon.value = g.con || 1;
    const ss = g.splitS || [1, 1, 1], sh = g.splitH || [1, 1, 1];
    grade.uniforms.uSplitS.value.set(ss[0], ss[1], ss[2]);
    grade.uniforms.uSplitH.value.set(sh[0], sh[1], sh[2]);
    bloom.strength = g.bloom;
  }
  function setTone(t) { tone = TONE_GRADES[t] ? t : 'serene'; applyGrade(); }
  function setLook(k) { look = LOOKS.hasOwnProperty(k) ? k : 'auto'; applyGrade(); }
  applyGrade();
  return {
    composer, bloom, grade, shafts,
    get enabled() { return enabled; }, setEnabled(v) { enabled = !!v; },
    setTone, get tone() { return tone; },
    setLook, get look() { return look; },
    setNight(n) {
      const g = (look !== 'auto' && LOOKS[look]) ? LOOKS[look] : (TONE_GRADES[tone] || TONE_GRADES.serene);
      bloom.strength = g.bloom * (1 + 0.6 * clamp(n, 0, 1));
    },
    // Call once per frame: the sun's screen position (0..1) and a target strength (0 = off).
    // Damped internally so shafts breathe in/out instead of popping at the frame edge.
    setSunScreen(x, y, strength) {
      shaftStrength += (clamp(strength, 0, 1) - shaftStrength) * 0.06;
      shafts.uniforms.uSun.value.set(x, y);
      shafts.uniforms.uStrength.value = enabled ? shaftStrength * 0.85 : 0;
    },
    resize(w, h) { composer.setSize(w, h); grade.uniforms.uAspect.value = w / h; bloom.resolution.set(w, h); },
    render() { if (enabled) composer.render(); else renderer.render(scene, camera); },
  };
}

// ── First-person walk (pointer lock + WASD + ground follow) ──────────────────
// groundAt(x, z, fromY) → y or null. onState(walking) is called on lock/unlock.
export function makeWalk(camera, dom, groundAt, onState) {
  const EYE = 1.7;
  const ctl = new PointerLockControls(camera, dom);
  const keys = new Set();
  let walking = false, walkY = 0, fly = false;
  ctl.addEventListener('lock', () => { walking = true; onState && onState(true); });
  ctl.addEventListener('unlock', () => { walking = false; keys.clear(); onState && onState(false); });
  document.addEventListener('pointerlockerror', () => { walking = false; onState && onState(false, 'refused'); });
  function enterAt(pos, lookAt) {
    const g = groundAt(pos.x, pos.z, pos.y + 50);
    walkY = (g !== null ? g : pos.y - EYE) + EYE;
    camera.position.set(pos.x, walkY, pos.z);
    if (lookAt) camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    ctl.lock();
  }
  function enterPose(pose) {
    const g = groundAt(pose.position.x, pose.position.z, pose.position.y + 50);
    // Keep the picture's height if it stood within a few metres of the ground (a crane shot stays a crane shot).
    fly = g === null || Math.abs((pose.position.y - EYE) - g) > 4;
    walkY = pose.position.y;
    camera.position.copy(pose.position);
    camera.lookAt(pose.position.clone().add(pose.forward));
    ctl.lock();
  }
  function exit() { if (walking) ctl.unlock(); }
  function step(dt) {
    if (!walking) return;
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = run ? 12 : 5;
    let f = 0, r = 0, u = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
    if (keys.has('KeyE') || keys.has('Space')) u += 1;
    if (keys.has('KeyQ') || keys.has('KeyC')) u -= 1;
    if (f || r) { const n = Math.hypot(f, r); ctl.moveForward(f / n * speed * dt); ctl.moveRight(r / n * speed * dt); }
    if (u) { fly = true; walkY += u * speed * dt; }
    if (!fly) {
      const g = groundAt(camera.position.x, camera.position.z, camera.position.y + 3);
      if (g !== null) walkY = g + EYE;
    } else if (keys.has('KeyF')) { fly = false; }
    camera.position.y += (walkY - camera.position.y) * Math.min(1, dt * 12);
  }
  function onKey(e, down) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return false;
    if (down) keys.add(e.code); else keys.delete(e.code);
    return true;
  }
  return { enterAt, enterPose, exit, step, onKey, get active() { return walking; }, get flying() { return fly; }, ctl };
}

// You stand on terrain, rock and built things — never on blades and petals. A mesh whose every
// material is foliage is scenery for the eyes, not ground for the feet (and in an optimised world
// it can be one enormous merged mesh that would make each step a full-mesh raycast).
export function isGroundMesh(mesh) {
  if (!mesh || !mesh.isMesh) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let any = false;
  for (const m of mats) {
    if (!m) continue;
    any = true;
    if (!FOLIAGE.test((m.name || '') + '|' + (mesh.name || ''))) return true; // one non-foliage material = walkable
  }
  return !any; // material-less mesh: keep (planks, plinths)
}

// A ground probe over a list of {mesh, box} entries (walk mode stands on these). Each touched mesh
// gets a lazily-built BVH the first time a step lands on its footprint; the downward ray then takes
// the first (= highest) hit instead of testing every triangle.
export function makeGroundProbe(entries) {
  const ray = new THREE.Raycaster(); const down = new THREE.Vector3(0, -1, 0);
  ray.firstHitOnly = true; // closest along a downward ray = the topmost surface
  return (x, z, fromY = 5000) => {
    ray.set(new THREE.Vector3(x, fromY, z), down); ray.far = fromY + 2000;
    let best = null;
    for (const e of entries) {
      if (x < e.box.min.x || x > e.box.max.x || z < e.box.min.z || z > e.box.max.z) continue;
      const g = e.mesh.geometry;
      if (g && !g.boundsTree && g.attributes.position && g.attributes.position.count > 3000) {
        try { g.computeBoundsTree(); } catch (err) { /* fall back to linear */ }
      }
      const hits = ray.intersectObject(e.mesh, false);
      if (hits.length && (best === null || hits[0].point.y > best)) best = hits[0].point.y;
    }
    return best;
  };
}

// ── Shared material patches (foliage relight + wind, animated liquids) ──────
export function makeMaterialKit() {
  const uWindTime = { value: 0 }, uWindStrength = { value: 0 };
  const windMaterials = [], lavaMats = [];
  const FLOOR = 0.40;
  function patchFoliage(mat, ownerName) {
    if (!mat || mat.userData.__foliage) return;
    if (!FOLIAGE.test((mat.name || '') + '|' + (ownerName || ''))) return;
    mat.userData.__foliage = true;
    if (mat.map || mat.emissiveMap) {
      if (!mat.emissiveMap && mat.map) mat.emissiveMap = mat.map;
      const cur = mat.emissive ? Math.max(mat.emissive.r, mat.emissive.g, mat.emissive.b) : 0;
      if (cur < FLOOR) mat.emissive = new THREE.Color().setScalar(FLOOR);
    } else if (mat.color) mat.emissive = mat.color.clone().multiplyScalar(FLOOR);
    mat.emissiveIntensity = 1.0;
    mat.alphaToCoverage = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = uWindTime; shader.uniforms.uWindStrength = uWindStrength;
      shader.vertexShader = 'uniform float uWindTime;\nuniform float uWindStrength;\n' + shader.vertexShader;
      // An optimised world merges foliage into big world-space meshes, so vertex height is height above
      // the ORIGIN, not above a tree's root — an uncapped height factor swung whole canopies metres wide
      // ("twirling"). Cap the lever arm and ripple the phase at leaf scale so the canopy shimmers in
      // patches instead of moving as one body.
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float _wph = transformed.x * 1.9 + transformed.z * 1.5;
         float _h = clamp(transformed.y, 0.0, 2.5);
         float _wamp = uWindStrength * _h;
         transformed.x += (sin(uWindTime * 1.6 + _wph) + 0.5 * sin(uWindTime * 3.1 + _wph * 2.7)) * _wamp * 0.035;
         transformed.z += (cos(uWindTime * 1.3 + _wph) + 0.5 * cos(uWindTime * 2.6 + _wph * 2.3)) * _wamp * 0.028;`);
    };
    mat.needsUpdate = true;
    windMaterials.push(mat);
  }
  function upgradeLiquid(mesh) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!mats.some(m => m && LIQUID.test(m.name || ''))) return false;
    const isLava = mats.some(m => m && /Lava/i.test(m.name || '')) || /lava/i.test(mesh.name || '');
    let mat;
    if (isLava) {
      mat = new THREE.MeshStandardMaterial({ color: 0x3a0c03, emissive: new THREE.Color(1.0, 0.42, 0.10), emissiveIntensity: 1.5, roughness: 0.55, metalness: 0.0 });
      lavaMats.push(mat);
    } else {
      mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.13, 0.28), roughness: 0.04, metalness: 0.0,
        transparent: true, opacity: 0.82, depthWrite: true, envMapIntensity: 1.4 });
    }
    const amp = isLava ? 0.22 : 0.12, freq = isLava ? 0.55 : 1.1;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = uWindTime;
      shader.vertexShader = 'uniform float uWindTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.y += sin(uWindTime*${freq.toFixed(2)} + transformed.x*0.12 + transformed.z*0.12)*${amp.toFixed(2)}
                        + cos(uWindTime*${(freq * 0.6).toFixed(2)} + transformed.x*0.05)*${(amp * 0.6).toFixed(2)};`);
    };
    mat.needsUpdate = true;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData.__liquid = true;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(m => (m && LIQUID.test(m.name || '')) ? (m.dispose(), mat) : m);
    else { mesh.material.dispose(); mesh.material = mat; }
    return true;
  }
  function tick(dt) {
    uWindTime.value += dt;
    const t = uWindTime.value;
    for (let i = 0; i < lavaMats.length; i++) lavaMats[i].emissiveIntensity = 1.3 + Math.sin(t * 0.8 + i) * 0.5;
  }
  function reset() { windMaterials.length = 0; lavaMats.length = 0; }
  return { uWindTime, uWindStrength, windMaterials, lavaMats, patchFoliage, upgradeLiquid, tick, reset };
}

// ── Weather (rain / snow / storm / fog / dust / ash) ────────────────────────
// Driven by the world's own `weather` string. Particles live in a wrap-around box that follows the
// camera; heavy weather also dims the sun, thickens the haze and leans the wind. No lightning flashes
// anywhere (deliberate — photosensitivity). Profiles cover every value the string can take.
export const WEATHER_PROFILES = {
  clear:     { rain: 0, snow: 0, dust: 0, fogMul: 1.0, sunDim: 1.0, wind: 0.0, shafts: true },
  cloudy:    { rain: 0, snow: 0, dust: 0, fogMul: 1.3, sunDim: 0.75, wind: 0.2, shafts: true },
  foggy:     { rain: 0, snow: 0, dust: 0, fogMul: 3.2, sunDim: 0.55, wind: 0.1, shafts: false },
  lightrain: { rain: 500, snow: 0, dust: 0, fogMul: 1.5, sunDim: 0.7, wind: 0.35, shafts: false },
  heavyrain: { rain: 1600, snow: 0, dust: 0, fogMul: 2.2, sunDim: 0.5, wind: 0.6, shafts: false },
  storm:     { rain: 2600, snow: 0, dust: 0, fogMul: 2.6, sunDim: 0.38, wind: 1.0, shafts: false },
  snow:      { rain: 0, snow: 900, dust: 0, fogMul: 1.6, sunDim: 0.8, wind: 0.25, shafts: false },
  blizzard:  { rain: 0, snow: 2600, dust: 0, fogMul: 3.4, sunDim: 0.5, wind: 1.0, shafts: false },
  dust:      { rain: 0, snow: 0, dust: 900, fogMul: 2.0, sunDim: 0.7, wind: 0.7, shafts: false },
  ash:       { rain: 0, snow: 0, dust: 700, fogMul: 2.2, sunDim: 0.6, wind: 0.4, shafts: false, ash: true },
};
export function weatherKey(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  return WEATHER_PROFILES[k] ? k : 'clear';
}
const RAIN_MAX = 2600, FLAKE_MAX = 2600, BOX = 46, BOXY = 30;
export function makeWeather(scene, camera) {
  // Rain = line streaks; snow / dust = points. Buffers sized for the maximum; draw range set per profile.
  const rainGeo = new THREE.BufferGeometry();
  const rainPos = new Float32Array(RAIN_MAX * 6);
  const rainSeed = new Float32Array(RAIN_MAX * 3);
  for (let i = 0; i < RAIN_MAX; i++) { rainSeed[i * 3] = Math.random(); rainSeed[i * 3 + 1] = Math.random(); rainSeed[i * 3 + 2] = Math.random(); }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.32, fog: false, depthWrite: false }));
  rain.frustumCulled = false; rain.visible = false; rain.renderOrder = 900;

  const flakeGeo = new THREE.BufferGeometry();
  const flakePos = new Float32Array(FLAKE_MAX * 3);
  const flakeSeed = new Float32Array(FLAKE_MAX * 3);
  for (let i = 0; i < FLAKE_MAX; i++) { flakeSeed[i * 3] = Math.random(); flakeSeed[i * 3 + 1] = Math.random(); flakeSeed[i * 3 + 2] = Math.random(); }
  flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3).setUsage(THREE.DynamicDrawUsage));
  const flakes = new THREE.Points(flakeGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  flakes.frustumCulled = false; flakes.visible = false; flakes.renderOrder = 900;
  scene.add(rain, flakes);

  let profile = WEATHER_PROFILES.clear, key = 'clear', t = 0, level = 0, target = 0;
  function set(weatherString) {
    key = weatherKey(weatherString);
    profile = WEATHER_PROFILES[key];
    target = (profile.rain || profile.snow || profile.dust) ? 1 : 0;
    if (profile.snow || profile.dust) {
      flakes.material.size = profile.dust ? 1.6 : 2.4;
      flakes.material.color.set(profile.ash ? 0x8a8a8a : (profile.dust ? 0xcbb27a : 0xffffff));
      flakes.material.opacity = profile.dust ? 0.5 : 0.85;
    }
  }
  const _camW = new THREE.Vector3();
  function tick(dt, windStrength) {
    t += dt;
    level += (target - level) * Math.min(1, dt * 2);
    const c = camera.getWorldPosition(_camW); // world position — correct in VR too, where camera sits in a rig
    const lean = (0.35 + windStrength) * profile.wind * 10; // metres of sideways drift over a fall
    const nRain = Math.round((profile.rain || 0) * level);
    rain.visible = nRain > 0;
    if (rain.visible) {
      for (let i = 0; i < nRain; i++) {
        const sx = rainSeed[i * 3], sy = rainSeed[i * 3 + 1], sz = rainSeed[i * 3 + 2];
        const speed = 34 + sz * 14;
        const y = BOXY - (((sy * BOXY * 4) + t * speed) % BOXY);
        const x = ((sx * BOX * 2 + t * lean) % (BOX * 2)) - BOX;
        const z = (sz * BOX * 2) - BOX;
        const j = i * 6;
        rainPos[j] = c.x + x; rainPos[j + 1] = c.y + y; rainPos[j + 2] = c.z + z;
        rainPos[j + 3] = c.x + x - lean * 0.02; rainPos[j + 4] = c.y + y + 0.9 + sz * 0.5; rainPos[j + 5] = c.z + z;
      }
      rainGeo.setDrawRange(0, nRain * 2);
      rainGeo.attributes.position.needsUpdate = true;
    }
    const nFlake = Math.round(((profile.snow || 0) + (profile.dust || 0)) * level);
    flakes.visible = nFlake > 0;
    if (flakes.visible) {
      const fall = profile.dust ? 1.6 : 2.6;
      for (let i = 0; i < nFlake; i++) {
        const sx = flakeSeed[i * 3], sy = flakeSeed[i * 3 + 1], sz = flakeSeed[i * 3 + 2];
        const y = BOXY - (((sy * BOXY * 4) + t * (fall + sz * 1.5)) % BOXY);
        const sway = Math.sin(t * (0.6 + sx) + sx * 9) * (1.4 + profile.wind * 2);
        const x = ((sx * BOX * 2 + t * lean * 0.7) % (BOX * 2)) - BOX + sway;
        const z = ((sz * BOX * 2 + Math.cos(t * 0.5 + sz * 7) * 1.2) % (BOX * 2)) - BOX;
        const j = i * 3;
        flakePos[j] = c.x + x; flakePos[j + 1] = c.y + y; flakePos[j + 2] = c.z + z;
      }
      flakeGeo.setDrawRange(0, nFlake);
      flakeGeo.attributes.position.needsUpdate = true;
    }
  }
  return { set, tick, get key() { return key; }, get profile() { return profile; },
           get fogMul() { return profile.fogMul; }, get sunDim() { return profile.sunDim; },
           get windFloor() { return profile.wind; }, get shaftsOk() { return profile.shafts; } };
}

// ── Sun shafts (screen-space radial scatter toward the sun) ─────────────────
// A light-weight god-ray approximation: the thresholded frame is smeared toward the sun's screen
// position with exponential decay and added back. No occlusion pre-pass — the threshold keeps it to
// the sky/bright band, and it fades as the sun leaves the frame or drops to the horizon.
export const SunShaftsShader = {
  uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) },
              uStrength: { value: 0.0 }, uDecay: { value: 0.94 }, uThreshold: { value: 0.55 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uStrength, uDecay, uThreshold; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength <= 0.001) { gl_FragColor = base; return; }
      vec2 delta = (uSun - vUv) / 32.0;
      vec2 uv = vUv; float w = 1.0; vec3 acc = vec3(0.0);
      for (int i = 0; i < 32; i++) {
        uv += delta;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        acc += s * max(0.0, l - uThreshold) * w;
        w *= uDecay;
      }
      gl_FragColor = vec4(base.rgb + acc * (uStrength / 32.0) * 3.0, base.a);
    }`
};

// ── Ambient audio beds ──────────────────────────────────────────────────────
// Starts only on a user gesture (the Sound toggle). Tries a recorded bed at audio/<tone>.mp3 first
// (drop files in later — absence is silent, not an error); until one exists, a procedural bed plays:
// filtered noise as wind, a second band as rain when the weather calls for it. Everything is gain-
// ramped so toggles and weather changes breathe instead of clicking.
export function makeAudioBeds(baseUrl = 'audio/') {
  let ctx = null, master = null, windGain = null, rainGain = null, el = null, elTone = '';
  let enabled = false, tone = 'serene', night = 0, wkey = 'clear', wind = 0;
  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown-ish
    const mk = (type, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(master); src.start();
      return g;
    };
    windGain = mk('lowpass', 420, 0.6);
    rainGain = mk('bandpass', 2400, 0.5);
    // A slow breath on the wind so it never reads as a constant hiss.
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.12;
    lfo.connect(lfoG); lfoG.connect(windGain.gain); lfo.start();
  }
  function ramp(g, v, t = 1.2) { if (g && ctx) g.gain.setTargetAtTime(v, ctx.currentTime, t); }
  function refresh() {
    if (!enabled) return;
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    const rain = /rain|storm/.test(wkey) ? (wkey === 'storm' ? 0.16 : (wkey === 'heavyrain' ? 0.12 : 0.07)) : 0;
    const windLvl = 0.10 + 0.10 * Math.min(2, wind) + (/blizzard|storm|dust/.test(wkey) ? 0.10 : 0);
    ramp(master, 0.9); ramp(windGain, windLvl); ramp(rainGain, rain);
    // Recorded bed, when one exists for this tone — layered under the procedural weather.
    if (el && elTone !== tone) { el.pause(); el = null; }
    if (!el) {
      const a = new Audio(baseUrl + tone + '.mp3');
      a.loop = true; a.volume = 0.0;
      a.play().then(() => { el = a; elTone = tone; const fade = setInterval(() => { a.volume = Math.min(0.5, a.volume + 0.05); if (a.volume >= 0.5) clearInterval(fade); }, 120); })
       .catch(() => { /* no recorded bed for this tone — the procedural bed carries it */ });
    }
  }
  return {
    setEnabled(v) {
      enabled = !!v;
      if (enabled) refresh();
      else { if (master && ctx) ramp(master, 0, 0.4); if (el) { el.pause(); el = null; elTone = ''; } }
    },
    get enabled() { return enabled; },
    setScene(t, n, w, ws) { tone = t || 'serene'; night = n || 0; wkey = w || 'clear'; wind = ws || 0; refresh(); },
  };
}

export const STEAM_URL = 'https://store.steampowered.com/app/4581800/Thalyn/';
export function steamLink(source) {
  return STEAM_URL + '?utm_source=thalyn_world&utm_medium=' + encodeURIComponent(source) + '&utm_campaign=share';
}
