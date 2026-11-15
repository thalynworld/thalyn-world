// thalyn-water.js — the game's water look in the browser (A1232, founder 2026-10-21: "the water from unity vs the
// browser — there is still some differences"). Four things the game does that the viewer did not:
//   1. FLAT — the game's water is flat everywhere (founder law A996). The old viewer heaved every liquid ±0.12 m, and on the
//      exported lake's long ear-clip triangles two surfaces at one level crossed each other (a visible band).
//   2. THE MIRROR — ONE planar reflection of the scene, at the level of the nearest water surface under the eye, shared by
//      every surface at that level (WaterPlanarReflection A1212: "still ONE planar render"). gltfpack MERGES every water
//      surface into one mesh (lake, ponds, the graded river, the sea ring), so the share is PER PIXEL: the mirror fades out
//      by height away from the plane (the game's A1216 band), and the plane follows the eye along a sloping river. The sea
//      ring (extras liquids 'ThalynWater_Horizon') never takes the mirror — the game's sea keeps its ocean look. Budget per tier:
//      Desktop half res @30 Hz · Laptop quarter res @15 Hz · Phone OFF (the sky reflection only) — the game's A1214 budget.
//   3. RIPPLES — a tiling procedural normal map, two layers scrolling against each other, bends both the light and the
//      mirror's lookup (the game's ThalynWater normal map).
//   4. COLOUR — mostly opaque: the world's own water tone (tintWater), never less than 0.9 alpha, and FULLY opaque at a
//      grazing angle (Fresnel), so the bed shows only looking straight down near you.
// Lava is untouched (thalyn-atmos.js upgradeLiquid keeps its heave + glow).
import * as THREE from 'three';
import { isFrozen, foamBodies, foamWind, FOAM_DEFAULTS, FOAM_MAX_BODIES } from './thalyn-liquid.js?v=20261115i1';   // ★ A17150 / A17160 (bump with thalyn-liquid.js)
//   5. ★ A17150 SHORE FOAM (Mike 2026-11-15) — the game's band where the water meets the bed (ThalynWater.shader :1415-1440): water depth
//      over the terrain, from ONE top-down height map of the Thalyn_Terrain_Baked meshes rendered at load (a half-float target, height
//      relative to the mean water level so the shore keeps its precision). Each body's own width / intensity / colour (liquids[] A17150,
//      else the shader defaults), widened and strengthened by the file's wind like the game. Tier column shoreFoam = the map's size;
//      Phone = 0 = no foam. ?foam=0 turns it off for an A/B.

const MIRROR_RANGE = 320;     // m — the game's MirrorRangeM order: beyond it, no surface takes the mirror
const BAND_IN = 0.35, BAND_GONE = 1.2;   // m — the mirror is full within BAND_IN of its plane, gone by BAND_GONE (A1216)
const RIPPLE_TILE = 9.0;      // m per normal-map tile (first layer); the second runs at 0.37× the tile, crossing
const DISTORT = 0.035;        // how far a ripple bends the mirror lookup (screen-space)

function makeRippleTexture(size = 256) {
  // Tileable: a sum of sines at INTEGER frequencies over the tile, so the edges meet. Height → normal by central difference.
  const h = new Float32Array(size * size);
  const waves = [[1, 2, 0.9, 0.3], [3, -1, 0.55, 1.7], [-2, 4, 0.4, 4.1], [5, 3, 0.28, 2.2], [-6, 5, 0.18, 0.9], [7, -8, 0.12, 5.3], [11, 9, 0.07, 3.6]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0; const u = x / size * Math.PI * 2, w = y / size * Math.PI * 2;
    for (const [a, b, amp, ph] of waves) v += amp * Math.sin(a * u + b * w + ph);
    h[y * size + x] = v;
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = h[y * size + ((x - 1 + size) % size)], xr = h[y * size + ((x + 1) % size)];
    const yd = h[((y - 1 + size) % size) * size + x], yu = h[((y + 1) % size) * size + x];
    let nx = (xl - xr) * 0.9, nz = (yd - yu) * 0.9, ny = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * size + x) * 4;
    data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (nz * 0.5 + 0.5) * 255; data[i + 2] = ny * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

const SHORE_LAYER = 9;   // ★ A17150 the terrain is enabled on this layer only while the height map renders

// ★ A17150 the game's shore band (ThalynWater.shader :1415-1440), ported: primary mask² × wave pulse × soft noise threshold × intensity ×
// wind boost × detail fade, a secondary band out to 2.5× the width, capped at 0.45. water_vnoise → a smooth value noise; detail fade 30 → 200 m
// (the material defaults _DetailFadeStart / _DetailFadeEnd). Depth = the water pixel's height over the bed from the top-down map (the game
// uses the eye-depth difference; vertical depth is the same band on flat water). Returns 0 when the map is off or the pixel is off-map.
// The map's G channel is coverage (1 where terrain drew); a filtered edge texel divides R by G so a half-covered texel keeps its height.
export const SHORE_FOAM_GLSL = `
uniform sampler2D uShoreTex; uniform vec4 uShoreBox; uniform float uShoreRef; uniform float uShoreOn;
uniform vec4 uFoamRect[${FOAM_MAX_BODIES}]; uniform vec4 uFoamPar[${FOAM_MAX_BODIES}]; uniform int uFoamN; uniform vec4 uFoamWorld;
uniform vec3 uFoamColor; uniform vec3 uFoamWind; uniform float uFoamLight;
float thalynFoamHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float thalynFoamNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(thalynFoamHash(i), thalynFoamHash(i + vec2(1.0, 0.0)), f.x), mix(thalynFoamHash(i + vec2(0.0, 1.0)), thalynFoamHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float thalynShoreFoam(vec3 wp) {
  if (uShoreOn < 0.5) return 0.0;
  vec2 suv = vec2((wp.x - uShoreBox.x) / uShoreBox.z, (uShoreBox.y - wp.z) / uShoreBox.w);
  if (suv.x <= 0.0 || suv.y <= 0.0 || suv.x >= 1.0 || suv.y >= 1.0) return 0.0;
  vec4 sh = texture2D(uShoreTex, suv);
  if (sh.g < 0.5) return 0.0;
  float depth = wp.y - (sh.r / max(sh.g, 1e-3) + uShoreRef);
  if (depth < 0.0) return 0.0;
  vec2 par = uFoamWorld.xy;
  for (int i = 0; i < ${FOAM_MAX_BODIES}; i++) {
    if (i >= uFoamN) break;
    vec4 r = uFoamRect[i];
    if (abs(wp.x - r.x) <= r.z && abs(wp.z - r.y) <= r.w) { par = uFoamPar[i].xy; break; }
  }
  float boost = uFoamWind.x, fw = par.x * uFoamWind.y, scroll = uFoamWind.z;
  float camDist = distance(cameraPosition, wp);
  float df = clamp(1.0 - (camDist - 30.0) / 170.0, 0.0, 1.0); df = df * df * (3.0 - 2.0 * df);
  float m1 = 1.0 - clamp(depth / fw, 0.0, 1.0);
  float pulse = sin(uWTime * 1.5 * scroll + wp.x * 0.3 + wp.z * 0.2) * 0.3 + 0.7;
  vec2 fp = wp.xz * (${FOAM_DEFAULTS.noiseScale.toFixed(1)} * 0.2);
  float n1 = thalynFoamNoise(fp + uWTime * 0.3 * scroll);
  float n2 = thalynFoamNoise(fp * 2.1 + 17.3 - uWTime * 0.2 * scroll);
  float fn = n1 * 0.6 + n2 * 0.4;
  float foam = m1 * m1 * pulse * smoothstep(0.55, 0.8, fn) * par.y * boost * df;
  float m2 = (1.0 - clamp(depth / (fw * 2.5), 0.0, 1.0)) * clamp(depth / fw, 0.0, 1.0);
  float foam2 = m2 * smoothstep(0.55, 0.8, n1) * par.y * 0.3 * boost * df;
  return min(max(foam, foam2), 0.45);
}
`;

export function makeWater() {
  const ripple = makeRippleTexture();
  const uTime = { value: 0 };
  const uMirror = { value: null };
  const uTexMat = { value: new THREE.Matrix4() };
  const uPlaneY = { value: -1e6 };
  let rects = [];               // the export's water rectangles minus the sea (setLiquids)
  const ray = new THREE.Raycaster(); ray.far = 4000;
  let nextChoose = 0;
  const surfaces = [];          // { mesh, mat, uOn: {value}, box }
  let rt = null, scale = 0.5, hz = 30, nextRender = 0, active = null, planeY = 0;
  const mirrorCam = new THREE.PerspectiveCamera();
  const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _t = new THREE.Vector3(),
        _look = new THREE.Vector3(), _rot = new THREE.Matrix4(), _q = new THREE.Vector4(), _plane = new THREE.Plane(),
        _clip = new THREE.Vector4(), _size = new THREE.Vector2();
  // ★ A17150 shore foam state (shared by every adopted surface)
  const uShoreTex = { value: null }, uShoreBox = { value: new THREE.Vector4(0, 0, 1, 1) }, uShoreRef = { value: 0 }, uShoreOn = { value: 0 };
  const uFoamRect = { value: Array.from({ length: FOAM_MAX_BODIES }, () => new THREE.Vector4()) };
  const uFoamPar = { value: Array.from({ length: FOAM_MAX_BODIES }, () => new THREE.Vector4()) };
  const uFoamN = { value: 0 }, uFoamWorld = { value: new THREE.Vector4(FOAM_DEFAULTS.width, FOAM_DEFAULTS.intensity, 0, 0) };
  const uFoamColor = { value: new THREE.Color(...FOAM_DEFAULTS.color) }, uFoamWind = { value: new THREE.Vector3(1, 1, 1) }, uFoamLight = { value: 1 };
  let shoreRT = null, shoreRes = 0, shoreArgs = null;
  const shoreOff = (() => { try { return new URLSearchParams(location.search).get('foam') === '0'; } catch (e) { return false; } })();

  /** Take over a water mesh's material (the one thalyn-atmos upgradeLiquid made): flat, ripples, the shared mirror. */
  function adopt(mesh) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = mats[0]; if (!mat) return false;
    const uOn = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uWTime: uTime, uMirror, uTexMat, uMirrorOn: uOn, uPlaneY, uRipple: { value: ripple },
        uShoreTex, uShoreBox, uShoreRef, uShoreOn, uFoamRect, uFoamPar, uFoamN, uFoamWorld, uFoamColor, uFoamWind, uFoamLight });
      shader.vertexShader = 'uniform mat4 uTexMat;\nvarying vec4 vMirrorCoord;\nvarying vec3 vWorldPosW;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vec4 _wp = modelMatrix * vec4(transformed, 1.0);
        vWorldPosW = _wp.xyz;
        vMirrorCoord = uTexMat * _wp;`);
      shader.fragmentShader = 'uniform float uWTime;\nuniform sampler2D uMirror;\nuniform float uMirrorOn;\nuniform float uPlaneY;\nuniform sampler2D uRipple;\nvarying vec4 vMirrorCoord;\nvarying vec3 vWorldPosW;\n' + SHORE_FOAM_GLSL + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 _uvA = vWorldPosW.xz / ${RIPPLE_TILE.toFixed(1)} + vec2(uWTime * 0.021, uWTime * 0.013);
        vec2 _uvB = vWorldPosW.xz / ${(RIPPLE_TILE * 0.37).toFixed(2)} - vec2(uWTime * 0.017, -uWTime * 0.025);
        vec3 _ra = texture2D(uRipple, _uvA).xyz * 2.0 - 1.0, _rb = texture2D(uRipple, _uvB).xyz * 2.0 - 1.0;
        vec2 _rip = (_ra.xy + _rb.xy) * 0.5;
        vec3 _nW = normalize(vec3(_rip.x, 1.0, _rip.y) * vec3(0.55, 1.0, 0.55));
        normal = normalize((viewMatrix * vec4(_nW, 0.0)).xyz);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        vec3 _V = normalize(cameraPosition - vWorldPosW);
        float _fres = 0.06 + 0.94 * pow(1.0 - clamp(dot(_nW, _V), 0.0, 1.0), 4.0);
        float _band = 1.0 - smoothstep(${BAND_IN.toFixed(2)}, ${BAND_GONE.toFixed(2)}, abs(vWorldPosW.y - uPlaneY));
        if (uMirrorOn > 0.5 && _band > 0.001) {
          vec2 _muv = vMirrorCoord.xy / vMirrorCoord.w + _rip * ${DISTORT.toFixed(3)};
          vec3 _refl = texture2D(uMirror, clamp(_muv, 0.001, 0.999)).rgb;
          outgoingLight = mix(outgoingLight, _refl, clamp(0.55 + 0.45 * _fres, 0.0, 0.92) * _band);
        }
        diffuseColor.a = mix(max(diffuseColor.a, 0.9), 1.0, _fres);
        float _foam = thalynShoreFoam(vWorldPosW);   // ★ A17150 the game's composite: lerp(finalColor, _FoamColor, foam)
        outgoingLight = mix(outgoingLight, uFoamColor * uFoamLight, _foam);
        diffuseColor.a = max(diffuseColor.a, _foam);
        #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'thalyn-water-a1232-a17150';
    mat.needsUpdate = true;
    const box = new THREE.Box3().setFromObject(mesh);
    surfaces.push({ mesh, mat, uOn, box });
    return true;
  }

  function setBudget(t, name) {
    const s = name === 'lite' ? 0 : name === 'laptop' ? 0.25 : 0.5;
    scale = (t && typeof t.mirrorScale === 'number') ? t.mirrorScale : s;
    hz = (t && typeof t.mirrorHz === 'number') ? t.mirrorHz : (name === 'laptop' ? 15 : 30);
    if (scale <= 0 && rt) { rt.dispose(); rt = null; uMirror.value = null; }
    console.info(`[thalyn] water A1232: mirror ${scale > 0 ? `${Math.round(scale * 100)} % res @${hz} Hz` : 'OFF (sky reflection only)'} · tier ${name}`);
    // ★ A17150 the shore map's size rides the tier (TIERS.shoreFoam; Phone 0 = no foam)
    const res = shoreOff ? 0 : ((t && typeof t.shoreFoam === 'number') ? t.shoreFoam : (name === 'lite' ? 0 : name === 'laptop' ? 512 : 1024));
    if (res !== shoreRes) { shoreRes = res; if (shoreArgs) buildShore(shoreArgs); else if (res <= 0) dropShore(); }
  }

  function dropShore() { if (shoreRT) { shoreRT.dispose(); shoreRT = null; } uShoreTex.value = null; uShoreOn.value = 0; }

  /** ★ A17150 the top-down terrain height map the foam reads. terrain = the Thalyn_Terrain_Baked meshes; liquids = extras.thalyn.liquids. */
  function setShore(renderer, scene, terrain, liquids, windStrength, windSpeed) {
    shoreArgs = { renderer, scene, terrain: terrain || [], liquids: liquids || [], windStrength, windSpeed };
    return buildShore(shoreArgs);
  }
  function buildShore(a) {
    const fb = foamBodies(a.liquids);
    uFoamN.value = fb.bodies.length;
    fb.bodies.forEach((b, i) => { uFoamRect.value[i].set(b.cx, b.cz, b.hx, b.hz); uFoamPar.value[i].set(b.width, b.intensity, 0, 0); });
    uFoamWorld.value.set(fb.world.width, fb.world.intensity, 0, 0);
    uFoamColor.value.setRGB(fb.world.color[0], fb.world.color[1], fb.world.color[2]);
    const w = foamWind(a.windStrength, a.windSpeed); uFoamWind.value.set(w.boost, w.widthMul, w.scroll);
    if (shoreRes <= 0 || !a.terrain.length || !fb.total || !surfaces.length) {
      dropShore();
      const why = shoreOff ? '?foam=0' : shoreRes <= 0 ? 'tier' : !fb.total ? 'no open water in the file' : !surfaces.length ? 'no animated water surface' : 'no Thalyn_Terrain_Baked mesh';
      console.info('[thalyn] water A17150 shore foam OFF (' + why + ')');
      return 0;
    }
    const t0 = performance.now();
    const box = new THREE.Box3();
    for (const m of a.terrain) box.expandByObject(m);
    if (box.isEmpty()) { dropShore(); return 0; }
    const open = a.liquids.filter(l => l && l.type === 'water' && !isFrozen(l));
    const ref = open.length ? open.reduce((s, l) => s + (+l.surfaceY || 0), 0) / open.length : 0;
    const sx = Math.max(1, box.max.x - box.min.x), sz = Math.max(1, box.max.z - box.min.z);
    const cam = new THREE.OrthographicCamera(-sx / 2, sx / 2, sz / 2, -sz / 2, 0.5, (box.max.y - box.min.y) + 20);
    cam.position.set((box.min.x + box.max.x) / 2, box.max.y + 10, (box.min.z + box.max.z) / 2);
    cam.up.set(0, 0, -1); cam.lookAt(cam.position.x, box.min.y, cam.position.z);   // screen right = +X, screen up = -Z (uv.y = (maxZ - z) / sz)
    cam.updateMatrixWorld(); cam.layers.set(SHORE_LAYER);
    for (const m of a.terrain) m.layers.enable(SHORE_LAYER);
    const res = shoreRes;
    if (!shoreRT || shoreRT.width !== res) {
      if (shoreRT) shoreRT.dispose();
      shoreRT = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    }
    const hm = new THREE.ShaderMaterial({ uniforms: { uRef: { value: ref } }, side: THREE.DoubleSide,
      vertexShader: 'varying float vY; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform float uRef; varying float vY; void main(){ gl_FragColor = vec4(vY - uRef, 1.0, 0.0, 1.0); }' });
    const r = a.renderer, prevTarget = r.getRenderTarget(), prevXr = r.xr.enabled, prevShadow = r.shadowMap.autoUpdate;
    const prevOverride = a.scene.overrideMaterial, prevBg = a.scene.background, prevFog = a.scene.fog, prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    try {
      r.xr.enabled = false; r.shadowMap.autoUpdate = false;
      a.scene.overrideMaterial = hm; a.scene.background = null; a.scene.fog = null;
      r.setRenderTarget(shoreRT); r.setClearColor(0x000000, 0); r.clear(); r.render(a.scene, cam);
    } finally {
      r.setRenderTarget(prevTarget); r.xr.enabled = prevXr; r.shadowMap.autoUpdate = prevShadow; r.setClearColor(prevClear, prevAlpha);
      a.scene.overrideMaterial = prevOverride; a.scene.background = prevBg; a.scene.fog = prevFog;
      for (const m of a.terrain) m.layers.disable(SHORE_LAYER);
      hm.dispose();
    }
    uShoreTex.value = shoreRT.texture; uShoreRef.value = ref;
    uShoreBox.value.set(box.min.x, box.max.z, sx, sz);
    uShoreOn.value = 1;
    console.info(`[thalyn] water A17150 shore foam ON: ${res}² height map over ${sx.toFixed(0)}×${sz.toFixed(0)} m (${(sx / res).toFixed(2)} m/texel) · ` +
      `${fb.total} open body(ies), ${fb.own} with their own foam numbers (the rest the shader defaults ${FOAM_DEFAULTS.width} m × ${FOAM_DEFAULTS.intensity}) · ` +
      `wind ×${w.boost.toFixed(2)} · ${(performance.now() - t0).toFixed(0)} ms`);
    return res;
  }

  /** ★ A17150 the foam is flat colour (the game's lerp); dim it with the night like the rest of the viewer's unlit accents. */
  function setNight(n) { uFoamLight.value = 1 - 0.7 * Math.min(1, Math.max(0, +n || 0)); }

  /** The export's water rectangles (extras.thalyn.liquids, APP frame: X negated — the same read as makeWaterProbe). The
   *  sea ring is left out: it never takes the mirror. Absent (a non-Thalyn glb) ⇒ each water mesh's own box. */
  function setLiquids(liquids) {
    rects = [];
    for (const l of (liquids || [])) {
      if (!l || l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
      if (/Horizon|Infinite|Sea|Ocean/i.test(l.name || '')) continue;
      if (isFrozen(l)) continue;   // ★ A17160 a frozen sheet is ground, never a mirror plane
      rects.push({ name: l.name || 'water', cx: -l.centerXZ[0], cz: l.centerXZ[1], hx: Math.max(0.5, l.sizeXZ[0] * 0.5), hz: Math.max(0.5, l.sizeXZ[1] * 0.5), y: +l.surfaceY || 0 });
    }
  }

  // The surface level at (x, z): a straight-down ray onto the water meshes (a sloping river reads its own height there),
  // else the rectangle's served level.
  function levelAt(x, z, fallback) {
    _p.set(x, (fallback || 0) + 200, z); _v.set(0, -1, 0);
    ray.set(_p, _v);
    const hits = ray.intersectObjects(surfaces.map(s => s.mesh), false);
    for (const h of hits) if (Math.abs(h.point.y - fallback) < 25) return h.point.y;
    return fallback;
  }

  function choose(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    let best = null, bestD = Infinity;
    const list = rects.length ? rects : surfaces.map(s => ({ name: s.mesh.name, cx: (s.box.min.x + s.box.max.x) / 2, cz: (s.box.min.z + s.box.max.z) / 2,
      hx: (s.box.max.x - s.box.min.x) / 2, hz: (s.box.max.z - s.box.min.z) / 2, y: s.box.max.y }));
    for (const r of list) {
      if (camera.position.y < r.y) continue;                                  // the eye must be above the water
      const px = Math.max(r.cx - r.hx, Math.min(cx, r.cx + r.hx)), pz = Math.max(r.cz - r.hz, Math.min(cz, r.cz + r.hz));
      const d = Math.hypot(px - cx, pz - cz);
      if (d < MIRROR_RANGE && d < bestD) { bestD = d; best = { r, px, pz }; }
    }
    if (!best) return null;
    return { name: best.r.name, y: levelAt(best.px, best.pz, best.r.y) };
  }

  /** Before the frame's own render: pick the plane (4×/s), render the mirror within the tier's budget. */
  function update(renderer, scene, camera, now) {
    uTime.value = now;
    if (!surfaces.length) return;
    if (now >= nextChoose) {
      nextChoose = now + 0.25;
      const want = scale > 0 ? choose(camera) : null;
      const was = active;
      active = want; planeY = active ? active.y : -1e6; uPlaneY.value = planeY;
      for (const s of surfaces) s.uOn.value = active ? 1 : 0;
      const changed = !!was !== !!active || (was && active && was.name !== active.name);
      if (changed) {
        nextRender = 0;
        console.info('[thalyn] water A1232 mirror ' + (active
          ? `ON at ${planeY.toFixed(2)} m (nearest '${active.name}'; every surface within ${BAND_GONE} m of it shares the one render, the sea never)`
          : 'OFF (no water under the eye within range)'));
      }
    }
    if (!active || now < nextRender) return;
    nextRender = now + 1 / hz;

    renderer.getDrawingBufferSize(_size);
    const w = Math.max(64, Math.floor(_size.x * scale)), h = Math.max(64, Math.floor(_size.y * scale));
    if (!rt) { rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType }); uMirror.value = rt.texture; }
    else if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

    // The reflected camera (three.js Reflector's construction, at the shared level).
    _n.set(0, 1, 0); _p.set(0, planeY, 0);
    camera.updateMatrixWorld();
    _v.setFromMatrixPosition(camera.matrixWorld);
    _v.y = 2 * planeY - _v.y;
    _rot.extractRotation(camera.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(camera.position);
    _t.copy(_look); _t.y = 2 * planeY - _t.y;
    mirrorCam.position.copy(_v);
    mirrorCam.up.set(0, 1, 0).applyMatrix4(_rot); mirrorCam.up.y = -mirrorCam.up.y;
    mirrorCam.lookAt(_t);
    mirrorCam.far = camera.far; mirrorCam.near = camera.near;
    mirrorCam.updateMatrixWorld();
    mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
    uTexMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
    // Oblique near plane = the water: nothing under it lands in the mirror.
    _plane.setFromNormalAndCoplanarPoint(_n, _p).applyMatrix4(mirrorCam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const pm = mirrorCam.projectionMatrix;
    _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
    _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
    _q.z = -1.0; _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    _clip.multiplyScalar(2.0 / _clip.dot(_q));
    pm.elements[2] = _clip.x; pm.elements[6] = _clip.y; pm.elements[10] = _clip.z + 1.0; pm.elements[14] = _clip.w;

    const hidden = [];
    for (const s of surfaces) if (s.mesh.visible) { s.mesh.visible = false; hidden.push(s.mesh); }
    const prevTarget = renderer.getRenderTarget(), prevXr = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, mirrorCam);
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr; renderer.shadowMap.autoUpdate = prevShadow;
    for (const m of hidden) m.visible = true;
  }

  function clear() {
    surfaces.length = 0; rects = []; active = null; uPlaneY.value = -1e6;
    shoreArgs = null; dropShore();   // ★ A17150
    if (rt) { rt.dispose(); rt = null; uMirror.value = null; }
  }

  return { adopt, setLiquids, setBudget, update, clear, setShore, setNight, get count() { return surfaces.length; }, get active() { return active; }, get shoreOn() { return uShoreOn.value > 0.5; } };
}
