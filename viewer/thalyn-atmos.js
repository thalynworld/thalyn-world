// Thalyn® atmosphere runtime for the web viewers (/viewer/ and /commons/).
//
// A Thalyn .glb may carry a root `extras.thalyn` block (sky, fog, water tone, hearths, the camera the
// picture was taken from, the world's bounds) and a baked sky dome (an unlit sphere textured with an
// equirect of the sky). Any glTF viewer shows the dome; this module lifts it out of the scene and turns
// it into the real background + image-based light, blends the numeric block into three.js lighting,
// adds the cinematic pass (bloom + a per-tone grade), first-person walking, and a night sky.
// A `living` sub-block (waterfalls the world measured, where its tree cover is thickest) becomes running
// water and a positional soundscape; every effect budgets against ONE quality-tier table (TIERS).
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

// ── Sky dome: the baked sky stays a MESH and becomes the environment light ────
// Returns { tex, domes }: `tex` = the equirect for PMREM (or null), `domes` = the dome meshes, which now STAY in the
// scene and are drawn as the sky — exactly as Blender / Sketchfab / model-viewer draw them — marked
// userData.__skyDome so framing, walking, shadows, foliage patching and triangle counts skip them.
// WHY (2026-09-03, measured): handing the compressed KTX2 equirect to scene.background rendered BLACK on every web
// export since the KTX2 pack (three.js r160 converts it to a cube internally and that pass samples this texture
// black — the PMREM pass and an ordinary textured mesh both show it). The dome mesh carries its own UVs and the
// loader's texture transform, so it is right by construction; the only thing the viewer adds is the IBL.
const domeHaze = { color: { value: new THREE.Color(0xc8ccd0) }, strength: { value: 0.85 } };
/** The horizon haze on the baked sky follows the scene fog: colour verbatim, strength from density (none → clear). */
export function setDomeHaze(fog) {
  if (fog && fog.color) { domeHaze.color.value.copy(fog.color); domeHaze.strength.value = Math.min(0.9, 0.35 + (fog.density || 0) * 250); }
  else domeHaze.strength.value = 0;
}
export function extractSkyDome(root) {
  let tex = null; const domes = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.some(m => m && SKY_MATERIAL.test(m.name || ''))) return;
    for (const m of mats) { if (m && !tex && m.map) tex = m.map; }
    domes.push(o);
  });
  for (const o of domes) {
    o.userData.__skyDome = true;
    o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = -1000;
    // The export sizes the dome at 3× the world (so a DCC frames the world, not the sky); here the framing camera
    // can stand OUTSIDE that sphere and see its silhouette cut the sky. A sky is at infinity: `follow` recentres
    // the dome on the camera every frame (its vertices sit off the node origin, so the centre is measured, not
    // assumed — scaling about the origin threw the sphere across the world).
    try {
      if (o.geometry && !o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const c = o.geometry && o.geometry.boundingSphere ? o.geometry.boundingSphere.center.clone().multiply(o.scale) : new THREE.Vector3();
      o.userData.__domeCentre = c;
    } catch (e) {}
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.fog = false; m.depthWrite = false; m.side = THREE.DoubleSide;
      // HORIZON HAZE: the scene fog cannot touch a sky (it would grey the whole dome at 1 km), yet the fogged water
      // table / far ground meet it in a hard line at the horizon. The PC hides that seam with its horizon shroud;
      // here the dome itself fades into the fog colour over the last few degrees above the horizon.
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uHzColor = domeHaze.color; sh.uniforms.uHzStrength = domeHaze.strength;
        sh.vertexShader = 'varying vec3 vDomeDir;\n' + sh.vertexShader.replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n vec4 _dwp = modelMatrix * vec4(transformed, 1.0); vDomeDir = _dwp.xyz - cameraPosition;');
        sh.fragmentShader = 'varying vec3 vDomeDir; uniform vec3 uHzColor; uniform float uHzStrength;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n { float _el = normalize(vDomeDir).y; float _h = 1.0 - smoothstep(-0.06, 0.12, _el); gl_FragColor.rgb = mix(gl_FragColor.rgb, uHzColor, _h * uHzStrength); }');
      };
      m.needsUpdate = true;
    }
  }
  if (tex) {
    const env = tex.clone();              // the mesh keeps its transformed map; the IBL gets a plain copy
    env.mapping = THREE.EquirectangularReflectionMapping;
    env.colorSpace = THREE.SRGBColorSpace;
    env.repeat.set(1, 1); env.offset.set(0, 0);
    env.needsUpdate = true;
    return { tex: env, domes };
  }
  return { tex: null, domes };
}

// Owns scene.background / scene.environment: a baked dome when one is present, else the procedural sky.
export function makeSkyEnv(renderer, scene, roomEnvTexture) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const cache = new Map(); // texture → pmrem RT
  let current = null, domes = [];
  // `tex` lights the world (PMREM → scene.environment); the dome MESHES draw the sky, so scene.background stays null.
  function useDome(tex, domeMeshes) {
    domes = domeMeshes || [];
    if (!tex) { current = null; scene.background = null; scene.environment = roomEnvTexture || null; return false; }
    if (current === tex) return true;
    let rt = cache.get(tex);
    if (!rt) { rt = pmrem.fromEquirectangular(tex); cache.set(tex, rt); }
    scene.background = null;
    scene.environment = rt.texture;
    current = tex;
    return true;
  }
  function setVisible(on) { for (const d of domes) d.visible = !!on; }
  const _cw = new THREE.Vector3();
  function follow(camera) {
    if (!domes.length) return;
    camera.getWorldPosition(_cw);
    for (const d of domes) {
      const c = d.userData.__domeCentre; if (!c) continue;
      if (d.parent) d.parent.worldToLocal(_cw.clone()); // parents are identity here; keep the world position
      d.position.copy(_cw).sub(c);
    }
  }
  return {
    useDome, setVisible, follow,
    get active() { return current; },
    get domes() { return domes; },
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
  // NO SHADOWS (found 2026-09-03): the shadow camera was never configured, so it kept three.js's default ±5-unit
  // orthographic box with far = 500 while the sun stood 8000 units out — a 2048² map was rendered every frame and
  // covered nothing. The box is sized per tier (TIERS.shadowHalf) and FOLLOWS the viewer in `followShadow`.
  sun.shadow.normalBias = 0.04;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 2600;
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a3f33, 0.6);
  const stars = makeStars(1400); stars.visible = false;
  return { sky, sun, hemi, stars };
}
// Per frame: an orthographic shadow box of ±half metres centred a little ahead of the viewer, snapped to the map's
// texel pitch so edges don't crawl as you walk. The light sits 1200 m up-sun of the focus so the whole box is inside
// near/far. Off when the tier has no shadows.
const _sfwd = new THREE.Vector3(), _sfocus = new THREE.Vector3();
export function followShadow(L, camera, half, sunDir) {
  const sun = L.sun;
  if (!sun.castShadow || !(half > 0)) return;
  const cam = sun.shadow.camera;
  if (cam.right !== half) { cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half; cam.updateProjectionMatrix(); }
  _sfwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _sfocus.copy(camera.position).addScaledVector(_sfwd, half * 0.45);
  const texel = (2 * half) / Math.max(256, sun.shadow.mapSize.x);
  _sfocus.x = Math.round(_sfocus.x / texel) * texel; _sfocus.y = Math.round(_sfocus.y / texel) * texel; _sfocus.z = Math.round(_sfocus.z / texel) * texel;
  sun.position.copy(_sfocus).addScaledVector(sunDir, 1200);
  sun.target.position.copy(_sfocus);
  sun.target.updateMatrixWorld();
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
  setDomeHaze(scene.fog);
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
// maxLights = the tier's point-light budget (TIERS.fireLights): every fire keeps its glow sprite, only the
// first N also cast real light — a phone is never asked to shade dozens of point lights.
export function buildAnchors(list, parent, maxLights = 48) {
  const root = new THREE.Group(); root.name = 'Thalyn_Anchors';
  const flames = [];
  let lit = 0;
  for (const a of (Array.isArray(list) ? list : []).slice(0, 96)) {
    const p = a && a.position; if (!Array.isArray(p) || p.length < 3) continue;
    const kind = String(a.builder || '').toLowerCase();
    const torch = kind.includes('torch'), hearth = kind.includes('hearth') || kind.includes('fire') || kind.includes('camp');
    if (!torch && !hearth) continue;
    const colour = torch ? 0xffb050 : 0xff8a38;
    const light = new THREE.PointLight(colour, torch ? 14 : 28, torch ? 12 : 22, 2);
    light.position.set(p[0], p[1] + (torch ? 1.6 : 0.9), p[2]);
    light.visible = lit++ < maxLights;
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
// `night` 0..1: a fire's LIGHT is barely visible under a daytime sun (the PC frame shows the flame, not a red wash
// over the ground); the glow sprite always shows. Measured 2026-09-03: at 15:21 the hearth painted half the frame red.
export function tickAnchors(root, t, night = 1) {
  const flames = root && root.userData && root.userData.flames; if (!flames) return;
  for (const f of flames) {
    const n = 0.86 + 0.14 * Math.sin(t * 9.1 + f.phase) * Math.sin(t * 3.7 + f.phase * 1.3) + 0.06 * Math.sin(t * 23 + f.phase);
    if (f.light.visible) f.light.intensity = f.base * n * (0.22 + 0.78 * Math.min(1, Math.max(0, night)));
    f.sprite.scale.setScalar(f.scale * (0.92 + 0.08 * n));
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
// The amplifier guard (2026-09-02): NaN or Infinity anywhere in the HDR frame is smeared across it by the bloom blur
// (84% of the frame went BLACK on an RTX; a mesh WITHOUT normals was the source — three.js flat-shades it from screen
// derivatives and those go NaN). The source is fixed in ingest (normals computed when missing); this pass stays as the
// belt: clamp and drop NaN BEFORE the amplifier. ⚠ D3D's shader compiler assumes no NaN and may fold isnan() away
// (warning X3577) — so never rely on this pass alone; fix NaN at its source.
const ClampShader = {
  uniforms: { tDiffuse: { value: null }, uMax: { value: 16.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uMax; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv);
      vec3 rgb = c.rgb; rgb = mix(rgb, vec3(0.0), vec3(isnan(rgb)));
      gl_FragColor = vec4(min(rgb, vec3(uMax)), 1.0); }`,
};
export function makePost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new ShaderPass(ClampShader));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.92);
  composer.addPass(bloom);
  const shafts = new ShaderPass(SunShaftsShader);
  composer.addPass(shafts);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  let enabled = true, tone = 'serene', look = 'auto', shaftStrength = 0, shaftsAllowed = true;
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
      shaftStrength += (clamp(shaftsAllowed ? strength : 0, 0, 1) - shaftStrength) * 0.06;
      shafts.uniforms.uSun.value.set(x, y);
      shafts.uniforms.uStrength.value = (enabled && shaftsAllowed) ? shaftStrength * 0.85 : 0;
    },
    resize(w, h) { composer.setSize(w, h); grade.uniforms.uAspect.value = w / h; bloom.resolution.set(w, h); },
    // Tier budget: MSAA samples on the HDR target, bloom on/off, shafts on/off (bloom off = the pass is skipped).
    setQuality(q) {
      if (!q) return;
      if (typeof q.msaa === 'number' && target.samples !== q.msaa) { target.samples = q.msaa; target.dispose(); }
      bloom.enabled = q.bloom !== false;
      shaftsAllowed = q.shafts !== false;
      if (!shaftsAllowed) shafts.uniforms.uStrength.value = 0;
    },
    render() { if (enabled) composer.render(); else renderer.render(scene, camera); },
  };
}

// ── First-person walk (pointer lock + WASD + ground follow; on a touch screen, a thumb-stick + look-drag) ──
// groundAt(x, z, fromY) → y or null. onState(walking) is called on lock/unlock.
// opts.touch = true → no pointer lock: the left half of the screen is a thumb-stick (drag to walk, push far
// to run), the right half looks (drag). The stick is drawn by this module (two rings) and only while walking.
export function makeWalk(camera, dom, groundAt, onState, opts = {}) {
  const EYE = 1.7;
  const touch = !!opts.touch;
  const ctl = new PointerLockControls(camera, dom);
  const keys = new Set();
  let walking = false, walkY = 0, fly = false, swimming = false;
  // Touch state
  let yaw = 0, pitch = 0, joyId = null, lookId = null, jx = 0, jy = 0, jox = 0, joy = 0, lx = 0, ly = 0;
  let stickEl = null, knobEl = null;
  ctl.addEventListener('lock', () => { walking = true; onState && onState(true); });
  ctl.addEventListener('unlock', () => { walking = false; keys.clear(); onState && onState(false); });
  document.addEventListener('pointerlockerror', () => { walking = false; onState && onState(false, 'refused'); });
  function syncAngles() { const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); yaw = e.y; pitch = e.x; }
  function begin() {
    if (touch) { syncAngles(); walking = true; showStick(true); onState && onState(true); }
    else ctl.lock();
  }
  function enterAt(pos, lookAt) {
    const g = groundAt(pos.x, pos.z, pos.y + 50);
    walkY = (g !== null ? g : pos.y - EYE) + EYE;
    camera.position.set(pos.x, walkY, pos.z);
    if (lookAt) camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    fly = false;
    begin();
  }
  function enterPose(pose) {
    const g = groundAt(pose.position.x, pose.position.z, pose.position.y + 50);
    // Keep the picture's height if it stood within a few metres of the ground (a crane shot stays a crane shot).
    fly = g === null || Math.abs((pose.position.y - EYE) - g) > 4;
    walkY = pose.position.y;
    camera.position.copy(pose.position);
    camera.lookAt(pose.position.clone().add(pose.forward));
    begin();
  }
  function exit() {
    if (!walking) return;
    if (touch) { walking = false; joyId = lookId = null; jx = jy = 0; showStick(false); onState && onState(false); }
    else ctl.unlock();
  }
  // Touch input — only installed for touch mode, only acted on while walking.
  if (touch) {
    const opt = { passive: false };
    dom.addEventListener('touchstart', e => {
      if (!walking) return;
      for (const t of e.changedTouches) {
        if (t.target && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|LABEL)$/.test(t.target.tagName)) continue;
        if (t.clientX < innerWidth * 0.5 && joyId === null) { joyId = t.identifier; jox = t.clientX; joy = t.clientY; jx = jy = 0; placeStick(jox, joy); }
        else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
        else continue;
        e.preventDefault();
      }
    }, opt);
    dom.addEventListener('touchmove', e => {
      if (!walking) return;
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          const R = 56; const dx = t.clientX - jox, dy = t.clientY - joy; const d = Math.hypot(dx, dy) || 1; const k = Math.min(1, d / R);
          jx = dx / d * k; jy = dy / d * k; moveKnob(jx * R, jy * R); e.preventDefault();
        } else if (t.identifier === lookId) {
          yaw -= (t.clientX - lx) * 0.0045; pitch -= (t.clientY - ly) * 0.0045;
          pitch = clamp(pitch, -1.45, 1.45); lx = t.clientX; ly = t.clientY; e.preventDefault();
        }
      }
    }, opt);
    const end = e => { for (const t of e.changedTouches) { if (t.identifier === joyId) { joyId = null; jx = jy = 0; moveKnob(0, 0); } if (t.identifier === lookId) lookId = null; } };
    dom.addEventListener('touchend', end); dom.addEventListener('touchcancel', end);
  }
  function showStick(on) {
    if (!touch) return;
    if (!stickEl) {
      stickEl = document.createElement('div'); stickEl.id = 'thalyn-stick';
      stickEl.style.cssText = 'position:fixed;left:24px;bottom:90px;width:112px;height:112px;border-radius:50%;border:1px solid rgba(232,198,106,0.45);background:rgba(13,20,17,0.35);z-index:9;pointer-events:none;display:none';
      knobEl = document.createElement('div');
      knobEl.style.cssText = 'position:absolute;left:36px;top:36px;width:40px;height:40px;border-radius:50%;background:rgba(232,198,106,0.55);box-shadow:0 0 10px rgba(232,198,106,0.5)';
      stickEl.appendChild(knobEl); document.body.appendChild(stickEl);
    }
    stickEl.style.display = on ? 'block' : 'none';
    if (on) { stickEl.style.left = '24px'; stickEl.style.bottom = '90px'; stickEl.style.top = ''; moveKnob(0, 0); }
  }
  function placeStick(x, y) { if (!stickEl) return; stickEl.style.left = (x - 56) + 'px'; stickEl.style.top = (y - 56) + 'px'; stickEl.style.bottom = ''; }
  function moveKnob(dx, dy) { if (knobEl) knobEl.style.transform = `translate(${dx}px, ${dy}px)`; }
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
  function step(dt) {
    if (!walking) return;
    let f = 0, r = 0, u = 0, run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
    if (keys.has('KeyE') || keys.has('Space')) u += 1;
    if (keys.has('KeyQ') || keys.has('KeyC')) u -= 1;
    if (touch) {
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      if (Math.hypot(jx, jy) > 0.08) { f = -jy; r = jx; run = Math.hypot(jx, jy) > 0.85; }
    }
    const speed = (run ? 12 : 5) * (swimming ? 0.5 : 1);
    if (f || r) {
      const n = Math.max(1, Math.hypot(f, r));
      if (touch) {
        camera.getWorldDirection(_fwd); _fwd.y = 0; if (_fwd.lengthSq() > 1e-6) _fwd.normalize();
        _right.set(-_fwd.z, 0, _fwd.x);
        camera.position.addScaledVector(_fwd, f / n * speed * dt).addScaledVector(_right, r / n * speed * dt);
      } else { ctl.moveForward(f / n * speed * dt); ctl.moveRight(r / n * speed * dt); }
    }
    if (u) { fly = true; walkY += u * speed * dt; }
    if (!fly) {
      const g = groundAt(camera.position.x, camera.position.z, camera.position.y + 3);
      // A171 · SWIMMING (founder 2026-09-02: "there's no water to swim in, only the surface"): where the bed lies
      // under a liquid surface you float, chest-deep, and move at half pace — the app's own swim. Deeper than
      // the eye's reach the ground is left alone (the surface carries you); wading is just walking.
      const w = opts.waterAt ? opts.waterAt(camera.position.x, camera.position.z) : null;
      if (g !== null && w !== null && w - g > 1.2) { walkY = w + EYE - 1.1; if (!swimming) { swimming = true; onState && onState(true, 'swim'); } }
      else { if (g !== null) walkY = g + EYE; if (swimming) { swimming = false; onState && onState(true, 'walk'); } }
    } else if (keys.has('KeyF')) { fly = false; }
    camera.position.y += (walkY - camera.position.y) * Math.min(1, dt * (swimming ? 4 : 12));
  }
  function onKey(e, down) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return false;
    if (down) keys.add(e.code); else keys.delete(e.code);
    return true;
  }
  return { enterAt, enterPose, exit, step, onKey, get active() { return walking; }, get flying() { return fly; }, get swimming() { return swimming; }, get touch() { return touch; }, ctl };
}

// A171 · the liquid surface under a point, from the export's own liquid rectangles (APP frame — X is negated
// here, the same read the soundscape and the fauna make). Returns the surface Y or null. Lava is never water.
export function makeWaterProbe(liquids) {
  const rects = [];
  for (const l of (liquids || [])) {
    if (!l || l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
    rects.push({ cx: -l.centerXZ[0], cz: l.centerXZ[1], hx: Math.max(0.5, l.sizeXZ[0] * 0.5), hz: Math.max(0.5, l.sizeXZ[1] * 0.5), y: +l.surfaceY || 0 });
  }
  return (x, z) => {
    let best = null;
    for (const r of rects) if (Math.abs(x - r.cx) <= r.hx && Math.abs(z - r.cz) <= r.hz && (best === null || r.y > best)) best = r.y;
    return best;
  };
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
  // The exported leaf/grass materials carry a DAYTIME emissive floor (so they are never black in a bare viewer);
  // at night the PC darkens its foliage to the ambient ratio, floored at 18 %. Mirror that here.
  let _nightMul = 1;
  function setNight(n) {
    const mul = 1 - 0.82 * Math.min(1, Math.max(0, n || 0));
    if (Math.abs(mul - _nightMul) < 0.005) return;
    _nightMul = mul;
    for (const m of windMaterials) m.emissiveIntensity = mul;
  }
  function tick(dt) {
    uWindTime.value += dt;
    const t = uWindTime.value;
    for (let i = 0; i < lavaMats.length; i++) lavaMats[i].emissiveIntensity = 1.3 + Math.sin(t * 0.8 + i) * 0.5;
  }
  function reset() { windMaterials.length = 0; lavaMats.length = 0; }
  return { uWindTime, uWindStrength, windMaterials, lavaMats, patchFoliage, upgradeLiquid, tick, reset, setNight };
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

  let profile = WEATHER_PROFILES.clear, key = 'clear', t = 0, level = 0, target = 0, budget = 1;
  function setBudget(mul) { budget = clamp(+mul || 1, 0.05, 1); }
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
    const nRain = Math.round((profile.rain || 0) * level * budget);
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
    const nFlake = Math.round(((profile.snow || 0) + (profile.dust || 0)) * level * budget);
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
  return { set, tick, setBudget, get key() { return key; }, get profile() { return profile; },
           get fogMul() { return profile.fogMul; }, get sunDim() { return profile.sunDim; },
           get windFloor() { return profile.wind; }, get shaftsOk() { return profile.shafts; },
           get particles() { return (rain.visible ? rainGeo.drawRange.count / 2 : 0) + (flakes.visible ? flakeGeo.drawRange.count : 0); } };
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

// ── Soundscape: beds + positional sources ───────────────────────────────────
// Starts only on a user gesture (the Sound toggle / the join click — browsers require it). Nothing is
// downloaded: every voice is synthesised in Web Audio (filtered noise, short tone bursts), so there are
// no files, no CORS, no attribution — the same choice the app makes for its own falling-water rumble.
// A recorded bed at audio/<tone>.mp3 is still layered under the wind when one exists.
//
//   beds      wind + rain, sized by the weather (global, as before)
//   waterfall a roar AT the plunge point (roar ∝ drop × flow; rolls off over ~200 m)
//   shore     lapping along a water body's edge — the source sits at the nearest shoreline point to you
//   canopy    birdsong by day / crickets by night from the thickest tree cover
//
// Voices are capped per quality tier: the nearest N play, the rest are ramped to silence (not stopped —
// walking back into range never clicks). The listener is the camera.
export function makeSoundscape(baseUrl = 'audio/') {
  let ctx = null, master = null, bedGain = null, windGain = null, rainGain = null, el = null, elTone = '';
  let enabled = false, volume = 0.9, tone = 'serene', night = 0, wkey = 'clear', wind = 0, voiceCap = 8;
  let noiseBuf = null, whiteBuf = null;
  const sources = []; // { kind, pos: Vector3, gain, panner, want, update(dt, cam), free() }
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();
  let chirpBudget = 0, tickT = 0, lastCam = null;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    bedGain = ctx.createGain(); bedGain.gain.value = 1; bedGain.connect(master);
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    whiteBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0), w = whiteBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const r = Math.random() * 2 - 1; w[i] = r; last = (last + 0.02 * r) / 1.02; d[i] = last * 3.5; } // brown-ish
    const mk = (buf, type, freq, q, dest) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(dest); src.start();
      return g;
    };
    windGain = mk(noiseBuf, 'lowpass', 420, 0.6, bedGain);
    rainGain = mk(noiseBuf, 'bandpass', 2400, 0.5, bedGain);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.12;
    lfo.connect(lfoG); lfoG.connect(windGain.gain); lfo.start();
    for (const src of sources) src.attach();
  }
  function ramp(g, v, t = 1.2) { if (g && ctx) g.gain.setTargetAtTime(v, ctx.currentTime, t); }
  function refresh() {
    if (!enabled) return;
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    const rain = /rain|storm/.test(wkey) ? (wkey === 'storm' ? 0.16 : (wkey === 'heavyrain' ? 0.12 : 0.07)) : 0;
    const windLvl = 0.10 + 0.10 * Math.min(2, wind) + (/blizzard|storm|dust/.test(wkey) ? 0.10 : 0);
    ramp(master, volume); ramp(windGain, windLvl); ramp(rainGain, rain);
    if (el && elTone !== tone) { el.pause(); el = null; }
    if (!el && !noBed.has(tone)) {
      const a = new Audio(baseUrl + tone + '.mp3');
      a.loop = true; a.volume = 0.0;
      a.play().then(() => { el = a; elTone = tone; const fade = setInterval(() => { a.volume = Math.min(0.5, a.volume + 0.05); if (a.volume >= 0.5) clearInterval(fade); }, 120); })
       .catch(() => { noBed.add(tone); /* no recorded bed for this tone — the procedural bed carries it; asked once */ });
    }
  }
  const noBed = new Set();

  // A positional voice: gain → panner → master. `build` wires the synth into `gain` once the context exists.
  function voice(kind, pos, opts) {
    const v = { kind, pos: pos.clone(), want: 0, level: 0, gain: null, panner: null, built: false, opts,
      attach() {
        if (this.built || !ctx) return;
        this.built = true;
        this.gain = ctx.createGain(); this.gain.gain.value = 0;
        this.panner = ctx.createPanner();
        this.panner.panningModel = 'HRTF'; this.panner.distanceModel = 'inverse';
        this.panner.refDistance = opts.ref; this.panner.maxDistance = opts.max; this.panner.rolloffFactor = opts.roll;
        this.gain.connect(this.panner); this.panner.connect(master);
        this.place(this.pos);
        opts.build(this);
      },
      place(p) { this.pos.copy(p); if (!this.panner) return; const t = ctx.currentTime;
        if (this.panner.positionX) { this.panner.positionX.setTargetAtTime(p.x, t, 0.05); this.panner.positionY.setTargetAtTime(p.y, t, 0.05); this.panner.positionZ.setTargetAtTime(p.z, t, 0.05); }
        else this.panner.setPosition(p.x, p.y, p.z); },
      free() { try { opts.free && opts.free(this); this.gain && this.gain.disconnect(); this.panner && this.panner.disconnect(); } catch (e) {} },
    };
    return v;
  }
  const noiseChain = (v, buf, stages, level) => {
    let node = ctx.createBufferSource(); node.buffer = buf; node.loop = true; node.start();
    v.nodes = [node];
    let head = node;
    for (const st of stages) { const f = ctx.createBiquadFilter(); f.type = st.type; f.frequency.value = st.f; f.Q.value = st.q || 0.7; head.connect(f); head = f; v.nodes.push(f); }
    const g = ctx.createGain(); g.gain.value = level; head.connect(g); g.connect(v.gain); v.nodes.push(g);
    return g;
  };
  const freeNodes = v => { for (const n of (v.nodes || [])) { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} } };

  function addWaterfall(w) {
    const p = v3(w.plunge) || v3(w.lip); if (!p) return;
    const drop = Math.max(2, +w.drop || 4), flow = clamp(+w.flow || 0.5, 0.15, 1), width = Math.max(1, +w.width || 3);
    const loud = clamp(0.35 + 0.65 * flow, 0, 1) * clamp(drop / 12, 0.4, 1.4);
    const v = voice('waterfall', p, { ref: 5 + width * 0.6, max: 240, roll: 1.15,
      build(v) {
        noiseChain(v, whiteBuf, [{ type: 'lowpass', f: 700 + 60 * drop, q: 0.5 }], 0.55);
        noiseChain(v, noiseBuf, [{ type: 'lowpass', f: 180, q: 0.8 }], 0.9);
        const hiss = noiseChain(v, whiteBuf, [{ type: 'bandpass', f: 2600, q: 0.6 }], 0.10 + 0.12 * flow);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.21 + Math.random() * 0.2;
        const lg = ctx.createGain(); lg.gain.value = 0.05; lfo.connect(lg); lg.connect(hiss.gain); lfo.start(); v.nodes.push(lfo, lg);
      }, free: freeNodes });
    v.want = loud;
    sources.push(v);
  }
  function addShore(rect) {
    // rect: { cx, cz, hx, hz, y } in the viewer frame. The source follows the nearest edge point to the listener.
    const v = voice('shore', new THREE.Vector3(rect.cx, rect.y, rect.cz), { ref: 8, max: 160, roll: 1.0,
      build(v) {
        const g = noiseChain(v, noiseBuf, [{ type: 'lowpass', f: 650, q: 0.7 }], 0.5);
        const swell = ctx.createOscillator(); swell.frequency.value = 0.11 + Math.random() * 0.05;
        const sg = ctx.createGain(); sg.gain.value = 0.22; swell.connect(sg); sg.connect(g.gain); swell.start();
        const swell2 = ctx.createOscillator(); swell2.frequency.value = 0.29; const sg2 = ctx.createGain(); sg2.gain.value = 0.12;
        swell2.connect(sg2); sg2.connect(g.gain); swell2.start();
        v.nodes.push(swell, sg, swell2, sg2);
        v.lapAt = 0;
      }, free: freeNodes });
    v.rect = rect; v.want = 0.55;
    v.update = (dt, cam) => {
      // nearest point on the rectangle's edge; inside the rect (over the water) the lap sits under you
      const dx = clamp(cam.x, rect.cx - rect.hx, rect.cx + rect.hx), dz = clamp(cam.z, rect.cz - rect.hz, rect.cz + rect.hz);
      let px = dx, pz = dz;
      const inside = Math.abs(cam.x - rect.cx) < rect.hx && Math.abs(cam.z - rect.cz) < rect.hz;
      if (inside) { // snap to the closest edge so the sound still reads as a shoreline
        const ex = rect.hx - Math.abs(cam.x - rect.cx), ez = rect.hz - Math.abs(cam.z - rect.cz);
        if (ex < ez) px = rect.cx + Math.sign(cam.x - rect.cx || 1) * rect.hx; else pz = rect.cz + Math.sign(cam.z - rect.cz || 1) * rect.hz;
      }
      _p.set(px, rect.y, pz);
      if (_p.distanceToSquared(v.pos) > 0.25) v.place(_p);
      // an occasional lap: a short bandpass burst
      if (v.built && v.level > 0.02) { v.lapAt -= dt; if (v.lapAt <= 0) { v.lapAt = 1.8 + Math.random() * 3.5; burst(v, whiteBuf, 900 + Math.random() * 500, 0.35, 0.6 + Math.random() * 0.5); } }
    };
    sources.push(v);
  }
  function burst(v, buf, freq, level, dur) {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.9;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(v.gain); src.start(t); src.stop(t + dur + 0.05);
  }
  // A fire: a low filtered-noise bed with random pops (short bandpass bursts) — heard from the hearth.
  function addHearth(a, torch) {
    const p = v3(a.position); if (!p) return;
    const v = voice('hearth', p.clone().setY(p.y + (torch ? 1.4 : 0.6)), { ref: torch ? 1.5 : 2.5, max: torch ? 24 : 45, roll: 1.3,
      build(v) { noiseChain(v, noiseBuf, [{ type: 'lowpass', f: 900, q: 0.6 }], torch ? 0.28 : 0.45); v.next = Math.random(); },
      free: freeNodes });
    v.want = torch ? 0.45 : 0.7;
    v.update = (dt) => {
      if (!v.built || v.level < 0.03) return;
      v.next -= dt;
      if (v.next > 0) return;
      v.next = 0.08 + Math.random() * (torch ? 0.9 : 0.5);
      burst(v, whiteBuf, 1800 + Math.random() * 2600, 0.12 + Math.random() * 0.2, 0.03 + Math.random() * 0.06);
    };
    sources.push(v);
  }
  function addCanopy(c) {
    const p = v3(c.center); if (!p) return;
    const r = Math.max(8, +c.radius || 18);
    const v = voice('canopy', p.clone().setY(p.y + 6), { ref: r * 0.6, max: 110, roll: 1.1,
      build(v) { v.next = Math.random() * 3; v.base = 1900 + Math.random() * 1400; v.pattern = 2 + Math.floor(Math.random() * 3); v.rate = 0.7 + Math.random() * 0.8; },
      free: freeNodes });
    v.want = 0.7 * clamp((+c.trees || 8) / 30, 0.5, 1.2);
    v.update = (dt) => {
      if (!v.built || v.level < 0.03) return;
      v.next -= dt * v.rate;
      if (v.next > 0) return;
      if (night > 0.6) { v.next = 0.9 + Math.random() * 1.6; cricket(v); }
      else { v.next = 1.4 + Math.random() * 5.5; song(v); }
    };
    sources.push(v);
  }
  // Birdsong: a handful of sine chirps with a glissando each, a per-zone "species" (base pitch, count, pace).
  function song(v) {
    if (chirpBudget <= 0) return; chirpBudget--;
    const n = v.pattern + Math.floor(Math.random() * 2);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const f0 = v.base * (0.9 + Math.random() * 0.25), f1 = f0 * (1.15 + Math.random() * 0.35);
      const dur = 0.06 + Math.random() * 0.08;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.7); o.frequency.exponentialRampToValueAtTime(f0 * 0.95, t + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(v.gain); o.start(t); o.stop(t + dur + 0.02);
      t += dur + 0.05 + Math.random() * 0.12;
    }
  }
  function cricket(v) {
    if (chirpBudget <= 0) return; chirpBudget--;
    const t = ctx.currentTime + 0.02, dur = 0.5 + Math.random() * 0.8;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 4100 + Math.random() * 500;
    const am = ctx.createOscillator(); am.frequency.value = 28 + Math.random() * 10;
    const amg = ctx.createGain(); amg.gain.value = 0.03; am.connect(amg);
    const g = ctx.createGain(); g.gain.value = 0; amg.connect(g.gain);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.035, t + 0.05); g.gain.setValueAtTime(0.035, t + dur - 0.08); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(v.gain); o.start(t); am.start(t); o.stop(t + dur + 0.02); am.stop(t + dur + 0.02);
  }

  // ── THE LISTENING WOOD (2026-09-05): the maker's tune ────────────────────────────────────────
  // In the app the maker held Shift+E and hummed; a bird answered. The export carries ONLY the notes the
  // bird sang (extras.thalyn.song — MIDI pitch + timing + the voice + where it sang from; never audio).
  // Here a positional voice in that spot sings it a beat after the world loads and then every couple of
  // minutes: "shared worlds sing their maker's tune via the viewer's audio block" (master brief §17).
  // Rendering is the same recipe as the app's BirdVoiceSynth — sine + a downward chirp on every onset, a
  // trill on long notes, a crow = noise croaks, an owl = slow soft hoots — so both sides sing the same bird.
  let makerSong = null, songVoice = null, songTimer = 0, songSung = 0;
  function setMakerSong(song, canopies) {
    makerSong = null; songVoice = null; songSung = 0;
    if (!song || !Array.isArray(song.midi) || song.midi.length === 0) return;
    let p;
    if (Array.isArray(song.pos) && song.pos.length >= 3 && song.pos.every(Number.isFinite)) p = new THREE.Vector3(song.pos[0], song.pos[1], song.pos[2]);
    else if (canopies && canopies.length && Array.isArray(canopies[0].center)) p = new THREE.Vector3(canopies[0].center[0], canopies[0].center[1] + 7, canopies[0].center[2]);
    else p = new THREE.Vector3(0, 12, 0);
    makerSong = { voice: String(song.voice || 'Thrush'), midi: song.midi.slice(), start: (song.start || []).slice(), duration: (song.duration || []).slice() };
    songVoice = voice('song', p, { ref: 8, max: 220, roll: 0.8, build(v) { v.want = 1; } });
    sources.push(songVoice);
    songTimer = 8;   // a beat after the world arrives
  }
  function singMaker() {
    if (!ctx || !makerSong || !songVoice || !songVoice.built) return;
    const s = makerSong, v = s.voice, t0 = ctx.currentTime + 0.05;
    const passes = v === 'Echo' ? [[0, 1], [0.9, 0.4]] : [[0, 1]];
    for (const [delay, gain] of passes) {
      for (let i = 0; i < s.midi.length; i++) {
        const st = t0 + delay + (+s.start[i] || i * 0.25), dur = Math.max(0.05, +s.duration[i] || 0.15);
        if (v === 'Crow') { croakAt(st, dur, gain); continue; }
        let midi = s.midi[i];
        if (v === 'Glitch' && Math.random() < 0.35) midi += Math.random() < 0.5 ? 12 : -12;
        toneAt(440 * Math.pow(2, (midi - 69) / 12), st, dur, v, gain);
      }
    }
    songSung++;
  }
  function toneAt(f, st, dur, v, gain) {
    const o = ctx.createOscillator(); o.type = 'sine';
    const chirp = v === 'Chirrup' ? 1.35 : v === 'Glitch' ? 1.5 : v === 'Owl' ? 0.95 : 1.10;
    const glide = v === 'Owl' ? 0.12 : 0.02;
    o.frequency.setValueAtTime(f * chirp, st); o.frequency.exponentialRampToValueAtTime(f, st + Math.min(dur * 0.5, glide));
    const trill = (v === 'Chirrup' || v === 'Glitch') ? dur > 0.12 : (v !== 'Owl' && dur > 0.25);
    let lfo = null, lg = null;
    if (trill) { lfo = ctx.createOscillator(); lfo.frequency.value = (v === 'Chirrup' || v === 'Glitch') ? 30 : 7; lg = ctx.createGain(); lg.gain.value = f * ((v === 'Chirrup' || v === 'Glitch') ? 0.025 : 0.008); lfo.connect(lg); lg.connect(o.frequency); lfo.start(st + 0.04); lfo.stop(st + dur + 0.05); }
    const attack = v === 'Owl' ? 0.06 : 0.006, release = v === 'Owl' ? 0.12 : 0.04, peak = 0.22 * gain * (v === 'Echo' ? 0.7 : 1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(peak, st + attack);
    g.gain.setValueAtTime(peak * 0.8, st + Math.max(attack, dur - release)); g.gain.exponentialRampToValueAtTime(0.001, st + dur);
    let head = o;
    if (v === 'Echo' || v === 'Owl') { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = v === 'Owl' ? 1800 : 3200; o.connect(lp); head = lp; }
    head.connect(g); g.connect(songVoice.gain); o.start(st); o.stop(st + dur + 0.05);
  }
  function croakAt(st, dur, gain) {
    const n = ctx.createBufferSource(); n.buffer = whiteBuf; n.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600;
    const am = ctx.createOscillator(); am.type = 'square'; am.frequency.value = 80 + Math.random() * 30;
    const amg = ctx.createGain(); amg.gain.value = 0.35; am.connect(amg);
    const body = ctx.createGain(); body.gain.value = 0.65; amg.connect(body.gain);
    const env = ctx.createGain(); const d = Math.min(0.26, Math.max(0.1, dur)), peak = 0.3 * gain;
    env.gain.setValueAtTime(0, st); env.gain.linearRampToValueAtTime(peak, st + 0.012); env.gain.exponentialRampToValueAtTime(0.001, st + d);
    n.connect(lp); lp.connect(body); body.connect(env); env.connect(songVoice.gain);
    n.start(st); am.start(st); n.stop(st + d + 0.05); am.stop(st + d + 0.05);
  }

  function clearWorld() { for (const v of sources) v.free(); sources.length = 0; makerSong = null; songVoice = null; }
  // world = { waterfalls: [...living.waterfalls], liquids: [...extras.liquids (app frame — X is negated here)], canopies: [...], song: extras.thalyn.song }
  function setWorld(world) {
    clearWorld();
    if (!world) return;
    setMakerSong(world.song, world.canopies);
    for (const w of (world.waterfalls || []).slice(0, 24)) addWaterfall(w);
    for (const l of (world.liquids || [])) {
      if (!l || l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
      const hx = Math.abs(l.sizeXZ[0]) / 2, hz = Math.abs(l.sizeXZ[1]) / 2;
      if (!(hx > 2 && hz > 2)) continue;
      addShore({ cx: -l.centerXZ[0], cz: l.centerXZ[1], hx, hz, y: +l.surfaceY || 0 }); // app → viewer frame: X negated
    }
    for (const c of (world.canopies || []).slice(0, 14)) addCanopy(c);
    for (const a of (world.anchors || []).slice(0, 48)) {
      const k = String(a && a.builder || '').toLowerCase();
      if (k.includes('torch')) addHearth(a, true); else if (k.includes('hearth') || k.includes('fire') || k.includes('camp')) addHearth(a, false);
    }
    if (ctx) for (const v of sources) v.attach();
  }
  function tick(dt, camera) {
    if (!enabled || !ctx) return;
    camera.getWorldPosition(_p); lastCam = _p;
    const L = ctx.listener, t = ctx.currentTime;
    camera.getWorldDirection(_f); _u.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    if (L.positionX) {
      L.positionX.setTargetAtTime(_p.x, t, 0.04); L.positionY.setTargetAtTime(_p.y, t, 0.04); L.positionZ.setTargetAtTime(_p.z, t, 0.04);
      L.forwardX.setTargetAtTime(_f.x, t, 0.04); L.forwardY.setTargetAtTime(_f.y, t, 0.04); L.forwardZ.setTargetAtTime(_f.z, t, 0.04);
      L.upX.setTargetAtTime(_u.x, t, 0.04); L.upY.setTargetAtTime(_u.y, t, 0.04); L.upZ.setTargetAtTime(_u.z, t, 0.04);
    } else { L.setPosition(_p.x, _p.y, _p.z); L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z); }
    chirpBudget = 6; // per frame — keeps a dense grove from scheduling hundreds of oscillators at once
    if (makerSong && songVoice) { songTimer -= dt; if (songTimer <= 0) { singMaker(); songTimer = 100 + Math.random() * 60; } }   // the maker's tune, then every couple of minutes
    for (const v of sources) if (v.update) v.update(dt, _p);
    // Voice cap: nearest N audible, the rest ramped to silence.
    tickT += dt;
    if (tickT > 0.25) {
      tickT = 0;
      const ranked = sources.map(v => ({ v, d: v.pos.distanceTo(_p) / (v.opts.max || 200) })).sort((a, b) => a.d - b.d);
      let on = 0;
      for (const { v, d } of ranked) {
        const audible = on < voiceCap && d < 1.05;
        if (audible) on++;
        const target = audible ? v.want : 0;
        if (v.built && Math.abs(v.level - target) > 0.005) { v.level = target; ramp(v.gain, target, 0.6); }
      }
    }
  }
  return {
    setEnabled(v) {
      enabled = !!v;
      if (enabled) { refresh(); for (const s of sources) s.attach(); if (makerSong && !songSung) songTimer = Math.min(songTimer, 3); }
      else { if (master && ctx) ramp(master, 0, 0.4); if (el) { el.pause(); el = null; elTone = ''; } }
    },
    get song() { return makerSong ? makerSong.midi.length : 0; },   // THE LISTENING WOOD — notes in the maker's tune (0 = none)
    singMaker,
    get enabled() { return enabled; },
    setVolume(v) { volume = clamp(+v, 0, 1); if (enabled && master) ramp(master, volume, 0.2); },
    setVoiceCap(n) { voiceCap = Math.max(1, n | 0); },
    setScene(t, n, w, ws) { tone = t || 'serene'; night = n || 0; wkey = w || 'clear'; wind = ws || 0; refresh(); },
    setWorld, tick,
    get context() { return ctx; },
    get voices() { let n = 0; for (const v of sources) if (v.level > 0.01) n++; return n; },
    get sources() { return sources.length; },
  };
}

export const STEAM_URL = 'https://store.steampowered.com/app/4581800/Thalyn/';
export function steamLink(source) {
  return STEAM_URL + '?utm_source=thalyn_world&utm_medium=' + encodeURIComponent(source) + '&utm_campaign=share';
}

// ── Quality tiers: ONE table every effect budgets against ───────────────────
// The scar this honours: individually cheap effects, added one at a time, are what sank a Cosy world's
// frame rate in the app. Here nothing sizes itself — every effect registers with makeTier and reads
// its numbers from the row below; a new effect adds a column, never a private constant.
export const TIERS = {
  high:   { label: 'Desktop', pixelRatio: 2.0, shadows: true,  shadowMap: 2048, shadowHalf: 150, msaa: 4, bloom: true,  shafts: true,  weather: 1.0,  sprayPerFall: 220, fallsMax: 24, sheetRows: 28, foam: true,  voices: 12, canopies: 6, wisps: 8, fireLights: 48, lanternLights: 16, creatures: 48, birdRoutes: 6, perched: 24 },
  laptop: { label: 'Laptop',  pixelRatio: 1.5, shadows: true,  shadowMap: 1024, shadowHalf: 100, msaa: 2, bloom: true,  shafts: false, weather: 0.55, sprayPerFall: 90,  fallsMax: 12, sheetRows: 20, foam: true,  voices: 8,  canopies: 4, wisps: 8, fireLights: 20, lanternLights: 8,  creatures: 16, birdRoutes: 4, perched: 12 },
  lite:   { label: 'Phone',   pixelRatio: 1.0, shadows: false, shadowMap: 512,  shadowHalf: 0,   msaa: 0, bloom: false, shafts: false, weather: 0.30, sprayPerFall: 36,  fallsMax: 6,  sheetRows: 12, foam: false, voices: 5,  canopies: 3, wisps: 8, fireLights: 6,  lanternLights: 3,  creatures: 6,  birdRoutes: 2, perched: 6 },
};
// Heuristic: what the device says about itself. Returns { name, why } so the HUD can show the reason.
export function guessTier(renderer) {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) && !/Chrome/.test(ua));
  let gpu = '';
  try { const gl = renderer.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info'); if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''; } catch (e) {}
  const g = gpu.toLowerCase();
  if (mobile) return { name: 'lite', why: 'phone/tablet' };
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return { name: 'lite', why: 'software GPU' };
  if (/intel|iris|uhd|hd graphics|mali|adreno|apple gpu|apple m1|powervr/.test(g)) return { name: 'laptop', why: gpu.slice(0, 40) || 'integrated GPU' };
  if ((navigator.hardwareConcurrency || 8) <= 4) return { name: 'laptop', why: 'few cores' };
  return { name: 'high', why: gpu.slice(0, 40) || 'desktop' };
}
export function makeTier(renderer, forced) {
  const listeners = [];
  const guess = guessTier(renderer);
  let name = TIERS[forced] ? forced : guess.name, auto = !TIERS[forced];
  function set(n) {
    if (n === 'auto' || !n) { auto = true; n = guess.name; } else auto = false;
    if (!TIERS[n]) n = guess.name;
    name = n;
    for (const fn of listeners) { try { fn(TIERS[name], name); } catch (e) { console.warn('[tier]', e); } }
  }
  return {
    on(fn) { listeners.push(fn); try { fn(TIERS[name], name); } catch (e) { console.warn('[tier]', e); } },
    set, get name() { return name; }, get table() { return TIERS[name]; }, get auto() { return auto; }, get guess() { return guess; },
  };
}

// ── Waterfalls: running water where the world says it falls ─────────────────
// One sheet (a scrolling-noise ribbon, lip → plunge, over a free-fall arc), one foam disc at the plunge,
// one spray cloud. Three draws per fall; spray count and fall count come from the tier. Falls further than
// ~260 m from the camera stop animating their spray (the sheet keeps scrolling — it is what you see from afar).
const SheetShader = {
  vertexShader: `
    attribute float aEdge; attribute float aSeed;
    varying vec2 vUv; varying float vEdge; varying float vSeed; varying vec3 vN; varying vec3 vV;
    void main(){ vUv = uv; vEdge = aEdge; vSeed = aSeed; vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `
    uniform float uTime; uniform vec3 uTint; uniform float uAlpha; uniform vec3 uFog; uniform float uFogD; uniform float uLight;
    varying vec2 vUv; varying float vEdge; varying float vSeed; varying vec3 vN; varying vec3 vV;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    void main(){
      float v = vUv.y;                                   // 0 lip → 1 plunge
      float speed = 1.6 + 1.2 * v;                       // water accelerates as it falls
      float n1 = noise(vec2(vUv.x * 3.0 + vSeed * 7.0, v * 6.0 - uTime * speed));
      float n2 = noise(vec2(vUv.x * 9.0 + vSeed * 3.0, v * 14.0 - uTime * speed * 1.7));
      float streak = smoothstep(0.30, 0.78, n1 * 0.62 + n2 * 0.38);
      vec3 nn = normalize(vN + vec3(1e-6)); vec3 vv = normalize(vV + vec3(1e-6));
      float rim = pow(max(0.0, 1.0 - abs(dot(nn, vv))), 2.0);
      float lipFade = smoothstep(0.0, 0.08, v);
      // Translucent streaks, not a white wall: alpha lives mostly in the froth, and the sheet is LIT by the scene
      // (uLight = day 1 → night ~0.08) so at night it reads as dim moving water, never a lamp. Colour is capped so
      // only the brightest froth crosses the bloom threshold.
      float a = (0.10 + 0.42 * streak) * vEdge * lipFade * uAlpha;
      vec3 col = mix(uTint, vec3(1.0), streak * 0.7 + rim * 0.2) * uLight * (0.85 + 0.35 * streak + 0.25 * rim);
      col = min(col, vec3(1.25));
      float fog = 1.0 - exp(-uFogD * length(vV));
      col = mix(col, uFog, fog);
      gl_FragColor = vec4(col, a * (1.0 - fog * 0.6));
    }`,
};
const FoamShader = {
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform float uTime; uniform vec3 uTint; uniform float uAlpha; uniform float uLight; varying vec2 vUv;
    // NaN law: atan(0,0) and pow(<0, x) are UNDEFINED in GLSL; one NaN pixel through the bloom blur blacks out the frame.
    void main(){ vec2 q = vUv - 0.5; float r = length(q) * 2.0; float ang = (r > 0.002) ? atan(q.y, q.x) : 0.0;
      float rings = 0.5 + 0.5 * sin(r * 14.0 - uTime * 2.6 + sin(ang * 5.0 + uTime) * 0.6);
      float a = smoothstep(1.0, 0.25, r) * (0.25 + 0.55 * rings) * smoothstep(0.0, 0.12, r) * uAlpha * (0.25 + 0.75 * uLight);
      gl_FragColor = vec4(mix(uTint, vec3(1.0), 0.7), a); }`,
};
const SprayShader = {
  vertexShader: `
    attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
    void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `
    uniform sampler2D uTex; uniform vec3 uTint; varying float vA;
    void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(mix(uTint, vec3(1.0), 0.8), t.a * vA * 0.55); }`,
};
let sprayTex = null;
function sprayTexture() {
  if (sprayTex) return sprayTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d'); const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  sprayTex = new THREE.CanvasTexture(cv); return sprayTex;
}
export function makeWaterfalls(scene) {
  const root = new THREE.Group(); root.name = 'Thalyn_Waterfalls'; scene.add(root);
  const falls = [];
  let budget = TIERS.high, pending = null, pendingTint = null;
  const uTime = { value: 0 };
  const uFog = { value: new THREE.Color(0xbcd0e0) }, uFogD = { value: 0 }, uLight = { value: 1 }, uScale = { value: 900 };
  function sheetGeometry(lip, plunge, dir, width, rows) {
    const cols = 5, W = width, W2 = width * 1.4;
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const run = new THREE.Vector3(plunge.x - lip.x, 0, plunge.z - lip.z);
    const drop = lip.y - plunge.y;
    const pos = [], nrm = [], uv = [], edge = [], idx = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      // free-fall arc: horizontal advance linear in t, vertical quadratic — starts level at the brink, ends near-vertical
      const cx = lip.x + run.x * t, cz = lip.z + run.z * t, cy = lip.y - drop * t * t;
      const w = W + (W2 - W) * t;
      // tangent for the normal
      const tx = run.x, tz = run.z, ty = -2 * drop * t;
      const tangent = new THREE.Vector3(tx, ty, tz).normalize();
      const n = new THREE.Vector3().crossVectors(side, tangent).normalize();
      for (let c = 0; c <= cols; c++) {
        const u = c / cols, k = (u - 0.5) * w;
        pos.push(cx + side.x * k, cy, cz + side.z * k);
        nrm.push(n.x, n.y, n.z);
        uv.push(u, t);
        edge.push(1 - Math.pow(Math.abs(u - 0.5) * 2, 2.2)); // soft sides
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + cols + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    const seed = Math.random(); g.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(seed), 1));
    g.setIndex(idx); g.computeBoundingSphere();
    return g;
  }
  function build(list, tint) {
    clear();
    pending = Array.isArray(list) ? list : null; pendingTint = tint || null;
    if (!pending) return 0;
    const col = (tint && tint.isColor) ? tint.clone() : new THREE.Color(0.62, 0.82, 0.9);
    const usable = pending.filter(w => v3(w.lip) && v3(w.plunge)).slice(0, budget.fallsMax);
    for (const w of usable) {
      const lip = v3(w.lip), plunge = v3(w.plunge);
      const dir = v3(w.dir) || new THREE.Vector3(plunge.x - lip.x, 0, plunge.z - lip.z);
      dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
      const width = Math.max(1, +w.width || 3), drop = Math.max(1, lip.y - plunge.y), flow = clamp(+w.flow || 0.5, 0.15, 1);
      const rapids = w.kind === 4;
      const fall = { lip, plunge, width, drop, flow, rapids, group: new THREE.Group(), asleep: false };
      // sheet
      const sm = new THREE.ShaderMaterial({ uniforms: { uTime, uTint: { value: col }, uAlpha: { value: rapids ? 0.5 : 0.8 }, uFog, uFogD, uLight },
        vertexShader: SheetShader.vertexShader, fragmentShader: SheetShader.fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const sheet = new THREE.Mesh(sheetGeometry(lip, plunge, dir, width, budget.sheetRows), sm);
      sheet.frustumCulled = true; sheet.renderOrder = 5;
      fall.group.add(sheet); fall.sheet = sheet;
      // foam
      if (budget.foam) {
        const fm = new THREE.ShaderMaterial({ uniforms: { uTime, uTint: { value: col }, uAlpha: { value: 0.35 + 0.2 * flow }, uLight },
          vertexShader: FoamShader.vertexShader, fragmentShader: FoamShader.fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        const foam = new THREE.Mesh(new THREE.CircleGeometry(width * 0.9 + drop * 0.12, 28), fm);
        foam.rotation.x = -Math.PI / 2; foam.position.set(plunge.x, plunge.y + 0.06, plunge.z); foam.renderOrder = 4;
        fall.group.add(foam);
      }
      // spray
      const n = Math.max(0, Math.round(budget.sprayPerFall * (0.5 + 0.5 * flow)));
      if (n > 0) {
        const pos = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
        const vel = new Float32Array(n * 3), life = new Float32Array(n), age = new Float32Array(n);
        for (let i = 0; i < n; i++) { age[i] = Math.random() * 1.2; life[i] = 0.7 + Math.random() * 0.9; size[i] = 0.10 + Math.random() * 0.22; } // metres
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
        const pm = new THREE.ShaderMaterial({ uniforms: { uTex: { value: sprayTexture() }, uTint: { value: col }, uScale },
          vertexShader: SprayShader.vertexShader, fragmentShader: SprayShader.fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        const pts = new THREE.Points(g, pm); pts.frustumCulled = false; pts.renderOrder = 6;
        fall.group.add(pts);
        fall.spray = { pts, pos, vel, life, age, alpha, n, dir, up: Math.min(7, 2.5 + drop * 0.35) };
        for (let i = 0; i < n; i++) respawn(fall.spray, i, plunge, width);
      }
      root.add(fall.group);
      falls.push(fall);
    }
    return falls.length;
  }
  function respawn(sp, i, plunge, width) {
    const j = i * 3, a = Math.random() * Math.PI * 2, r = Math.random() * width * 0.5;
    sp.pos[j] = plunge.x + Math.cos(a) * r; sp.pos[j + 1] = plunge.y + 0.1; sp.pos[j + 2] = plunge.z + Math.sin(a) * r;
    const out = 0.6 + Math.random() * 1.8;
    sp.vel[j] = Math.cos(a) * out + sp.dir.x * 0.8; sp.vel[j + 1] = sp.up * (0.5 + Math.random() * 0.8); sp.vel[j + 2] = Math.sin(a) * out + sp.dir.z * 0.8;
    sp.age[i] = 0;
  }
  const _c = new THREE.Vector3();
  function setLight(v) { uLight.value = clamp(v, 0.05, 1.2); }
  function tick(dt, camera, fogDensity, fogColor) {
    uTime.value += dt;
    // pixels per metre at 1 m: half the viewport height over tan(fov/2) — a 0.2 m droplet at 10 m is ~20 px at 1080p
    if (camera && camera.isPerspectiveCamera) uScale.value = (innerHeight * 0.5) / Math.tan(camera.fov * 0.5 * Math.PI / 180);
    if (fogColor) uFog.value.copy(fogColor);
    uFogD.value = fogDensity > 0 ? fogDensity : 0;
    if (!falls.length) return;
    camera.getWorldPosition(_c);
    for (const f of falls) {
      const d2 = f.plunge.distanceToSquared(_c);
      f.asleep = d2 > 260 * 260;
      if (f.asleep || !f.spray) { if (f.spray) f.spray.pts.visible = false; continue; }
      const sp = f.spray; sp.pts.visible = true;
      for (let i = 0; i < sp.n; i++) {
        const j = i * 3;
        sp.age[i] += dt;
        if (sp.age[i] > sp.life[i]) respawn(sp, i, f.plunge, f.width);
        sp.vel[j + 1] -= 9.8 * dt;
        sp.pos[j] += sp.vel[j] * dt; sp.pos[j + 1] += sp.vel[j + 1] * dt; sp.pos[j + 2] += sp.vel[j + 2] * dt;
        const k = sp.age[i] / sp.life[i];
        sp.alpha[i] = Math.sin(k * Math.PI) * (sp.pos[j + 1] > f.plunge.y - 0.5 ? 1 : 0);
      }
      sp.pts.geometry.attributes.position.needsUpdate = true;
      sp.pts.geometry.attributes.aAlpha.needsUpdate = true;
    }
  }
  function clear() {
    for (const f of falls) { root.remove(f.group); f.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    falls.length = 0;
  }
  function setBudget(t) { budget = t || TIERS.high; if (pending) build(pending, pendingTint); }
  return { build, tick, clear, setBudget, setLight, root,
    get count() { return falls.length; },
    get awake() { let n = 0; for (const f of falls) if (!f.asleep) n++; return n; },
    get particles() { let n = 0; for (const f of falls) if (!f.asleep && f.spray) n += f.spray.n; return n; } };
}

// ── Perf HUD (dev): frame time, draw calls, triangles, live effect counts — behind ?perf=1 ──
export function makePerfHud(renderer) {
  const el = document.createElement('div');
  el.id = 'perf';
  el.style.cssText = 'position:fixed;top:14px;right:14px;z-index:25;padding:8px 10px;background:rgba(13,20,17,0.82);border:1px solid rgba(232,198,106,0.3);border-radius:8px;color:#9DBCAC;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;min-width:190px';
  document.body.appendChild(el);
  let ema = 16.7, worst = 0, frames = 0, acc = 0, shown = '';
  const samples = [];
  // The composer's passes each reset renderer.info — hold it for the whole frame and reset here instead.
  renderer.info.autoReset = false;
  let calls = 0, tris = 0;
  return {
    el,
    tick(dt, extra) {
      const ms = dt * 1000; ema += (ms - ema) * 0.08; worst = Math.max(worst, ms); frames++; acc += dt;
      samples.push(ms); if (samples.length > 600) samples.shift();
      calls = renderer.info.render.calls; tris = renderer.info.render.triangles; renderer.info.reset();
      if (acc < 0.25) return; acc = 0;
      const sorted = [...samples].sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || ema;
      const inf = { calls, triangles: tris };
      const lines = [
        `frame ${ema.toFixed(1)} ms  (${(1000 / Math.max(1, ema)).toFixed(0)} fps)`,
        `p95   ${p95.toFixed(1)} ms   worst ${worst.toFixed(0)} ms`,
        `draws ${inf.calls}   tris ${(inf.triangles / 1e6).toFixed(2)} M`,
        `dpr ${renderer.getPixelRatio().toFixed(2)}  ${innerWidth}×${innerHeight}`,
      ];
      for (const k in (extra || {})) lines.push(`${k} ${extra[k]}`);
      shown = lines.join('\n'); el.textContent = shown; worst *= 0.98;
    },
    get text() { return shown; },
  };
}

// ── Lanterns, fairy lights, water lights: the world's glow points ────────────
// `extras.thalyn.living.lights[]` is every point the app itself lights — string-light bulbs, hung lanterns,
// floating water lanterns — {pos, color, kind: 'lantern'|'water'|'bulb', priority, mul}. The app's own
// design is reproduced: glow mass is FREE (an additive sprite per point, bloom does the rest) and realness
// is a small ROLLING POOL of true point lights that re-assign to the points nearest the camera. Water
// lanterns bob. Everything fades up with the night (by day a lit lantern is a faint warm dot).
let discGeo = null;
function discGeometry() { return discGeo || (discGeo = new THREE.CircleGeometry(1.3, 24)); }
let lanternTex = null;
function lanternTexture() {
  if (lanternTex) return lanternTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.22, 'rgba(255,255,255,0.85)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.28)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  lanternTex = new THREE.CanvasTexture(cv); lanternTex.colorSpace = THREE.SRGBColorSpace; return lanternTex;
}
export function makeLanterns(scene) {
  const root = new THREE.Group(); root.name = 'Thalyn_Lanterns'; scene.add(root);
  const points = [];            // { pos, base(Vector3), color, kind, sprite, mul, phase }
  const pool = [];              // PointLights
  let poolSize = 16, night = 0, acc = 0;
  const _c = new THREE.Vector3();
  function build(list) {
    clear();
    for (const e of (Array.isArray(list) ? list : []).slice(0, 600)) {
      const p = v3(e.pos); if (!p) continue;
      const col = rgbOf(e.color) || new THREE.Color(1.0, 0.78, 0.45);
      const kind = String(e.kind || 'lantern');
      const size = kind === 'bulb' ? 0.55 : (kind === 'water' ? 0.7 : 0.9);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: lanternTexture(), color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }));
      sprite.scale.setScalar(size * (0.8 + 0.6 * clamp(+e.mul || 1, 0.5, 2))); sprite.position.copy(p); sprite.renderOrder = 8;
      root.add(sprite);
      // A floating lantern: the app's own ruling (2026-09-01, "water default = ZERO real lights + glow discs") —
      // a flat additive disc on the surface carries the glow; no point light ever sits on a mirror-smooth water plane.
      let disc = null;
      if (kind === 'water') {
        disc = new THREE.Mesh(discGeometry(), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
        disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, p.y + 0.03, p.z); disc.renderOrder = 7; root.add(disc);
      }
      points.push({ pos: p.clone(), base: p, color: col, kind, sprite, disc, mul: clamp(+e.mul || 1, 0.5, 2), priority: +e.priority || 0, phase: Math.random() * 6.28, light: null });
    }
    ensurePool();
    return points.length;
  }
  function ensurePool() {
    while (pool.length < poolSize) { const l = new THREE.PointLight(0xffc878, 0, 14, 2); l.visible = false; root.add(l); pool.push(l); }
    while (pool.length > poolSize) { const l = pool.pop(); root.remove(l); }
  }
  function setBudget(t) { poolSize = Math.max(0, (t && t.lanternLights) | 0); ensurePool(); }
  function setNight(n) { night = clamp(n, 0, 1); }
  function tick(dt, camera) {
    if (!points.length) return;
    const t = performance.now() / 1000;
    const glow = 0.18 + 0.82 * night;                 // lanterns come alive with the dark
    for (const pt of points) {
      if (pt.kind === 'water') { pt.pos.y = pt.base.y + Math.sin(t * 0.9 + pt.phase) * 0.04; pt.sprite.position.y = pt.pos.y; }
      const flick = 0.92 + 0.08 * Math.sin(t * 6.3 + pt.phase) * Math.sin(t * 2.1 + pt.phase * 1.7);
      pt.sprite.material.opacity = 0.62 * glow * flick;
      if (pt.disc) pt.disc.material.opacity = 0.22 * glow * (0.85 + 0.15 * Math.sin(t * 0.7 + pt.phase));
      if (pt.light) { pt.light.position.copy(pt.pos); pt.light.intensity = (pt.kind === 'bulb' ? 0.9 : 2.2) * pt.mul * glow * flick; }
    }
    acc += dt;
    if (acc < 0.4 || !pool.length) return;
    acc = 0;
    // the rolling pool: the N nearest points (priority breaks ties) own the real lights
    camera.getWorldPosition(_c);
    const ranked = points.filter(pt => pt.kind !== 'water').map(pt => ({ pt, d: pt.pos.distanceToSquared(_c) - pt.priority * 25 })).sort((a, b) => a.d - b.d);
    const keep = new Set();
    for (let i = 0; i < Math.min(poolSize, ranked.length); i++) keep.add(ranked[i].pt);
    for (const pt of points) if (pt.light && !keep.has(pt)) { pt.light.visible = false; pool.push(pt.light); pt.light = null; }
    const free = pool.filter(l => !l.visible);
    for (const pt of keep) {
      if (pt.light) continue;
      const l = free.pop(); if (!l) break;
      l.visible = true; l.color.copy(pt.color); l.distance = pt.kind === 'bulb' ? 6 : 9; pt.light = l;
    }
  }
  function clear() { for (const pt of points) { root.remove(pt.sprite); pt.sprite.material.dispose(); if (pt.disc) { root.remove(pt.disc); pt.disc.material.dispose(); } } points.length = 0; for (const l of pool) l.visible = false; }
  return { build, tick, setBudget, setNight, clear, root, get count() { return points.length; }, get lit() { let n = 0; for (const pt of points) if (pt.light) n++; return n; } };
}
