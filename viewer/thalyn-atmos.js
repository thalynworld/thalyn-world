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
  L.stars.visible = s.night > 0.35 && !scene.background; // the baked night sky already has its stars
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
              uVig: { value: 0.3 }, uLift: { value: 0 }, uAspect: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec3 uTint; uniform float uSat, uVig, uLift, uAspect; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = mix(vec3(l), c.rgb, uSat) * uTint + uLift;
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = smoothstep(0.35, 1.05, length(q));
      col *= 1.0 - uVig * v;
      gl_FragColor = vec4(col, c.a);
    }`
};
export function makePost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.92);
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  let enabled = true, tone = 'serene';
  function setTone(t) {
    tone = TONE_GRADES[t] ? t : 'serene';
    const g = TONE_GRADES[tone];
    grade.uniforms.uTint.value.set(g.tint[0], g.tint[1], g.tint[2]);
    grade.uniforms.uSat.value = g.sat; grade.uniforms.uVig.value = g.vig; grade.uniforms.uLift.value = g.lift;
    bloom.strength = g.bloom;
  }
  setTone(tone);
  return {
    composer, bloom, grade,
    get enabled() { return enabled; }, setEnabled(v) { enabled = !!v; },
    setTone, get tone() { return tone; },
    setNight(n) { bloom.strength = TONE_GRADES[tone].bloom * (1 + 0.6 * clamp(n, 0, 1)); },
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

// A ground probe over a list of {mesh, box} entries (walk mode stands on these).
export function makeGroundProbe(entries) {
  const ray = new THREE.Raycaster(); const down = new THREE.Vector3(0, -1, 0);
  return (x, z, fromY = 5000) => {
    ray.set(new THREE.Vector3(x, fromY, z), down); ray.far = fromY + 2000;
    let best = null;
    for (const e of entries) {
      if (x < e.box.min.x || x > e.box.max.x || z < e.box.min.z || z > e.box.max.z) continue;
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
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float _wph = transformed.x * 0.35 + transformed.z * 0.35;
         float _h = max(transformed.y, 0.0);
         transformed.x += sin(uWindTime * 1.6 + _wph) * uWindStrength * _h * 0.06;
         transformed.z += cos(uWindTime * 1.3 + _wph) * uWindStrength * _h * 0.045;`);
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

export const STEAM_URL = 'https://store.steampowered.com/app/4581800/Thalyn/';
export function steamLink(source) {
  return STEAM_URL + '?utm_source=thalyn_world&utm_medium=' + encodeURIComponent(source) + '&utm_campaign=share';
}
