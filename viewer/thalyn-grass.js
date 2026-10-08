// ★ A5386 · THE GRASS FIELD, IN THE BROWSER (glTF web budget phase 1 — "grass as data", 2026-10-08).
//
// The founder's rule: what they export is what they get in the browser, smooth on a phone AND a desktop.
// World_web.glb used to carry the baked grass (~15 M triangles, ~1 GB raw) — the heaviest thing in the file and
// still not the game's grass. The app now writes what its GrassField is FED into extras.thalyn.grass (the 256²
// coverage + biome maps, per-layer species numbers + seeds, the tuft mesh, the wind), and this module grows the
// field the way the PC does (Assets/WorldStandard/Grass/Resources/ThalynGrassField.compute, ported line by line):
//
//   · a blade is a pure function of its WORLD-ANCHORED cell + the layer seed — the same cell and seed give the same
//     position, height, colour, stiffness and facing as in the app (wang_hash, the cell seed, the Voronoi clump pull,
//     the coverage keep, the biome mask — all verbatim);
//   · only the ground near the camera holds blades: 16 m tiles inside the tier's radius, generated on demand,
//     a few per frame, dropped when far behind;
//   · each tile's roots stand on the EXPORTED terrain (a 17×17 height grid per tile, probed once on the meshes that
//     wear Thalyn_Terrain_Baked — never a roof or a rock), and its slope is the grid's;
//   · distance thinning, width/height compensation, the edge fade, the wind (the scrolled 128² noise field +
//     the per-blade sines) and the colour/lighting terms of GrassShader_URP run in the vertex/fragment patch below.
//
// FRAME: the block is written in UNITY world space (frame "unity") because the kernel's cells are anchored there;
// blades are generated in that frame and turned into glTF (x → −x) at the very end of the vertex shader.
// Budget: one draw per layer. Radius × density per tier lives in TIERS (thalyn-atmos.js), like every other effect.
import * as THREE from 'three';

const TILE = 16;            // metres per generation tile (unity XZ)
const GRID = 17;            // height samples per tile side
const GRID_PAD = 2;         // metres of margin around a tile (a clump pull can carry a root just past the edge)
const FLOATS = 16;          // per blade: pos.xyz rot · height width hash stiff · rgb shade · n.xyz rank

// ── base64 → typed arrays ─────────────────────────────────────────────────────
function bytesOf(b64) {
  if (typeof b64 !== 'string' || !b64.length) return null;
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const f32Of = b64 => { const b = bytesOf(b64); return b ? new Float32Array(b.buffer, 0, b.length >> 2) : null; };
const u16Of = b64 => { const b = bytesOf(b64); return b ? new Uint16Array(b.buffer, 0, b.length >> 1) : null; };

// ── The kernel's hashes, verbatim (uint maths via Math.imul / >>> 0; float(h) rounds to float32 as in HLSL) ──
function wang(s) {
  s = ((s ^ 61) ^ (s >>> 16)) >>> 0;
  s = Math.imul(s, 9) >>> 0;
  s = (s ^ (s >>> 4)) >>> 0;
  s = Math.imul(s, 0x27d4eb2d) >>> 0;
  s = (s ^ (s >>> 15)) >>> 0;
  return s;
}
const INV32 = 1 / 4294967296;
const u01 = h => Math.fround(h) * INV32;
const rnd = (seed, n) => u01(wang((seed + Math.imul(n, 0x9E3779B9)) >>> 0));
const fract = x => x - Math.floor(x);
function hash2(px, py, out) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(px * 0.0973);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  out[0] = fract((x + y) * z); out[1] = fract((x + z) * y);
  return out;
}
function hash3x(px, py, pz) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(pz * 0.0973);
  const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}
const _h = [0, 0];
// voronoi_distance(uv, 0.5) → [dist, centreX, centreY]
function voronoi(ux, uy, angleOffset, out) {
  const gx = Math.floor(ux), gy = Math.floor(uy), fx = ux - gx, fy = uy - gy;
  let best = 8, cx = gx, cy = gy;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    hash2(gx + x, gy + y, _h);
    const a = _h[0] * 6.28318530718, ox = Math.cos(a) * angleOffset, oy = Math.sin(a) * angleOffset;
    const dx = x + ox - fx, dy = y + oy - fy, d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) { best = d; cx = gx + x + ox; cy = gy + y + oy; }
  }
  out[0] = best; out[1] = cx; out[2] = cy;
  return out;
}

// The wind field texture, verbatim from GrassField.BuildWindNoise (periodic value noise, fixed seeds).
function lattice(x, y, period, seed) {
  x = ((x % period) + period) % period; y = ((y % period) + period) % period;
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144665)) >>> 0;
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xFFFFFF) / 16777215;
}
function periodic(u, v, period, seed) {
  const x = u * period, y = v * period, x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = lattice(x0, y0, period, seed), b = lattice(x0 + 1, y0, period, seed);
  const c = lattice(x0, y0 + 1, period, seed), d = lattice(x0 + 1, y0 + 1, period, seed);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}
let _noiseTex = null;
function windNoise() {
  if (_noiseTex) return _noiseTex;
  const N = 128, px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    let r = 0.5 * periodic(u, v, 4, 11) + 0.3 * periodic(u, v, 8, 23) + 0.2 * periodic(u, v, 16, 37);
    const g = 0.6 * periodic(u, v, 4, 51) + 0.4 * periodic(u, v, 8, 67);
    r = Math.min(1, Math.max(0, (r - 0.2) / 0.6));
    const i = (y * N + x) * 4;
    px[i] = Math.round(r * 255); px[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255); px[i + 2] = 0; px[i + 3] = 255;
  }
  _noiseTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
  _noiseTex.magFilter = _noiseTex.minFilter = THREE.LinearFilter;
  _noiseTex.colorSpace = THREE.NoColorSpace;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

// ── The shader patch (GrassShader_URP, THALYN_GRASS_FIELD path) ─────────────
const VERT_HEAD = `
attribute vec4 iA; attribute vec4 iB; attribute vec4 iC; attribute vec4 iD; attribute vec2 gUv;
uniform float uTime; uniform vec3 uCamU; uniform sampler2D uNoise;
uniform vec4 uWindA; uniform vec4 uWindB; uniform vec4 uWindC;
uniform vec4 uField;   // R, falloffStart, farDensity, edgeFade
uniform float uDensityMul; uniform float uGrowth;
uniform vec3 uMatBase; uniform vec3 uMatTip; uniform float uColorVar;
uniform float uWidthMul; uniform float uHeightVar; uniform float uRestBend; uniform float uBendGain; uniform float uUpBias;
varying vec3 vGrassCol; varying float vGrassV; varying float vGrassD;
vec3 grassUpTo(vec3 v, vec3 n) {
  float c = n.y; vec3 k = vec3(n.z, 0.0, -n.x); float s = length(k);
  if (s < 1e-4) return v;
  k /= s;
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;
const VERT_BODY = `
  vec3 gPos = iA.xyz; float gRot = iA.w;
  float gHash = iB.z; float gStiff = iB.w;
  vec3 gN = normalize(mix(vec3(0.0, 1.0, 0.0), iD.xyz, 0.4));   // A2015: lean 40 % into the slope
  float gRank = iD.w;
  // Distance thinning (the kernel's, per frame): width/height compensation, the fractional fade, the edge fade.
  float gD = length(uCamU - gPos);
  float gT = clamp((gD - uField.y) / max(0.001, uField.x - uField.y), 0.0, 1.0);
  float gKeep = mix(1.0, uField.z, gT);
  float gFade = clamp((gKeep - gRank) / 0.1 + 1.0, 0.0, 1.0);
  float gEdge = clamp((uField.x - gD) / max(0.001, uField.w), 0.0, 1.0);
  float gKeepAll = max(gKeep * uDensityMul, 0.05);
  float gWComp = min(3.0, pow(1.0 / gKeepAll, 0.6));
  float gHComp = pow(1.0 / gKeepAll, 0.15);
  bool gGone = gRank >= gKeep + 0.1 || gD > uField.x || gFade * gEdge <= 0.001;
  float gHeight = iB.x * gHComp;
  float gWidth = iB.y * gWComp * gFade * gEdge;
  // Wind (LoadBlade): the scrolled noise field + the per-blade sines, in the unity frame.
  float phase = gHash * 6.28318;
  float spatial = gPos.x * 0.05 + gPos.z * 0.08 + phase;
  float wtime = uWindB.y * uWindA.y;
  vec2 wdir = uWindC.xy;
  vec2 nuv = (gPos.xz - wdir * (uWindB.y * uWindC.w)) * uWindC.z;
  vec2 nz = textureLod(uNoise, nuv, 0.0).rg;
  float gustField = mix(0.15, 1.15, nz.r);
  float primary = sin(wtime + spatial) * 0.4 + 0.5;
  float detail = sin(wtime * 2.2 + spatial * 1.3 + phase * 0.5) * uWindA.z;
  float gust = sin(wtime * uWindB.x + phase * 0.7) * uWindA.w * 0.5;
  float total = (gustField * 0.8 + primary * 0.2 + (detail * 0.3 + gust) * 0.5) * uWindA.x;
  float windForce = total / max(0.001, gStiff * 2.5);
  float sideBend = sin(wtime * 1.5 + phase * 1.3) * uWindA.z * uWindB.z * 0.05;
  float wob = (nz.g - 0.5) * 0.6; float cw = cos(wob), sw = sin(wob);
  vec2 bdir = vec2(wdir.x * cw - wdir.y * sw, wdir.x * sw + wdir.y * cw);
  // TransformBladeVertex
  vec3 vp = position;
  float bladeW = gWidth * uWidthMul;
  vp.x *= bladeW; vp.z *= bladeW;
  vp.y *= gHeight * (1.0 + uHeightVar * (fract(gHash * 13.73) * 2.0 - 1.0)) * uGrowth;
  float origLen = length(vp);
  float cr = cos(gRot), sr = sin(gRot);
  vp = vec3(cr * vp.x + sr * vp.z, vp.y, -sr * vp.x + cr * vp.z);
  float bendAmount = windForce * uBendGain + uRestBend;
  float bendFactor = gUv.y * gUv.y;
  vec2 windDisp = bdir * bendAmount * bendFactor + vec2(-bdir.y, bdir.x) * sideBend * bendFactor * 0.3;
  vp.xz += windDisp * gHeight;
  if (origLen > 0.001) vp = normalize(vp) * origLen;
  vp = grassUpTo(vp, gN);
  vp += gPos;
  if (gGone) vp = gPos;                       // collapsed: every vertex at the root → no fragments
  vec3 transformed = vec3(-vp.x, vp.y, vp.z); // unity → glTF
  // Colour (vert): base→tip gradient, per-blade brightness + warm/cool, the clump's self-shadow.
  vec3 gradC = mix(iC.rgb * uMatBase, uMatTip, gUv.y);
  float bright = mix(1.0 - 0.45 * uColorVar, 1.0 + 0.45 * uColorVar, gHash);
  vec3 warmCool = mix(vec3(1.14, 1.0, 0.74), vec3(0.84, 1.05, 1.14), fract(gHash * 7.31));
  vGrassCol = gradC * bright * mix(vec3(1.0), warmCool, clamp(uColorVar * 0.8, 0.0, 1.0));
  vGrassCol *= 1.0 - 0.25 * (1.0 - gUv.y) * iC.a;
  vGrassV = gUv.y;
  vGrassD = gD;
`;
const NORMAL_BODY = `
  vec3 gTan = normalize(vec3(cos(iA.w), 0.0, sin(iA.w)));
  vec3 gNn = normalize(mix(vec3(0.0, 1.0, 0.0), iD.xyz, 0.4));
  vec3 gBit = normalize(cross(gNn, gTan));
  vec3 gNw = vec3(dot(gTan, normal), dot(gNn, normal), dot(gBit, normal));   // mul(float3x3(t, n, b), nOS), verbatim
  gNw = normalize(mix(gNw, vec3(0.0, 1.0, 0.0), uUpBias));
  vec3 objectNormal = vec3(-gNw.x, gNw.y, gNw.z);
`;
const FRAG_HEAD = `
uniform vec4 uField; uniform float uFadeFrac;
uniform vec3 uGround; uniform float uTint; uniform float uGroundBlend; uniform float uBaseAO;
uniform vec3 uSss; uniform float uSssStrength; uniform vec3 uSunView; uniform vec3 uSunCol; uniform float uNight;
varying vec3 vGrassCol; varying float vGrassV; varying float vGrassD;
`;

function makeLayerMaterial(L, shared) {
  // Lambert: the app's grass has no specular (GrassMaterial _SpecularStrength 0) and no IBL reflection — a PBR
  // material's grazing Fresnel turned edge-on blades sky-white. Cull Off like the app (_Cull 0).
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  const g = L.ground || [1, 1, 1];
  const u = {
    uTime: shared.uTime, uCamU: shared.uCamU, uNoise: { value: windNoise() },
    uWindA: { value: new THREE.Vector4() }, uWindB: shared.uWindB, uWindC: shared.uWindC,
    uField: shared.uField, uDensityMul: shared.uDensityMul, uGrowth: shared.uGrowth, uFadeFrac: shared.uFadeFrac,
    uMatBase: { value: new THREE.Vector3().fromArray(L.matBase || [0.2, 0.4, 0.1]) },
    uMatTip: { value: new THREE.Vector3().fromArray(L.matTip || [0.5, 0.8, 0.3]) },
    uColorVar: { value: +L.matColorVar || 0 },
    uWidthMul: { value: +L.widthMul || 1 }, uHeightVar: { value: +L.heightVariance || 0 },
    uRestBend: { value: +L.restBend || 0 }, uBendGain: { value: L.windBendGain != null ? +L.windBendGain : 6 },
    uUpBias: { value: L.normalUpBias != null ? +L.normalUpBias : 0.8 },
    uGround: { value: new THREE.Vector3(g[0], g[1], g[2]) }, uTint: { value: L.tintStrength != null ? +L.tintStrength : 1 },
    uGroundBlend: { value: +L.groundBlend || 0 }, uBaseAO: { value: +L.baseAO || 0 },
    uSss: { value: new THREE.Vector3().fromArray(L.subsurface || [0.4, 0.6, 0.2]) }, uSssStrength: { value: +L.subsurfaceStrength || 0 },
    uSunView: shared.uSunView, uSunCol: shared.uSunCol, uNight: shared.uNight,
  };
  mat.userData.grassUniforms = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = VERT_HEAD + shader.vertexShader
      .replace('#include <beginnormal_vertex>', NORMAL_BODY)
      .replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gR = max(1.0, uField.x);
        float gTS = smoothstep(uFadeFrac * gR, 0.9 * gR, vGrassD);
        float gTE = smoothstep(0.8 * gR, gR, vGrassD);
        vec3 gAlb = uGround * mix(vec3(1.0), vGrassCol, uTint);
        gAlb = mix(gAlb, uGround, uGroundBlend * (1.0 - vGrassV));
        gAlb *= mix(1.0 - uBaseAO * (1.0 - 0.8 * gTS), 1.0, vGrassV);
        gAlb = mix(gAlb, uGround, gTE);
        diffuseColor.rgb = gAlb;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), gTS));   // A2015 anti-shimmer`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // The app's flat floor (albedo × 0.20) + its simplified subsurface — as emission, dimmed at night like the foliage.
        vec3 gV = normalize(vViewPosition);
        vec3 gVL = uSunView + normal * uSssStrength;
        float gSub = pow(clamp(dot(gV, -gVL), 0.0, 1.0), 3.0) * uSssStrength;
        totalEmissiveRadiance += (gAlb * 0.20 + gSub * uSss * uSunCol) * uNight;`);
  };
  mat.customProgramCacheKey = () => 'thalyn-grass-v1';
  return mat;
}

// The far tuft: the app's GrassTuftMesh is 12 blades × 6 rows (a 12-vertex strip, indices 0,2,1 / 1,2,3 …). Past the
// tier's LOD distance a blade keeps rows 0, 3 and 5 (root, middle, tip) — 4 triangles instead of 10. Same outline,
// same uv.y, so the wind bend and the colour ramp read the same from where it is seen. Not strips → no far tuft.
function makeLodTuft(geo) {
  const idx = geo.index.array, nv = geo.getAttribute('position').count, PER = 12;
  if (nv % PER !== 0 || idx.length !== (nv / PER) * 30) return null;
  for (let b = 0; b < nv / PER; b++) {
    const o = b * 30, v = b * PER;
    if (idx[o] !== v || idx[o + 1] !== v + 2 || idx[o + 2] !== v + 1 || idx[o + 3] !== v + 1 || idx[o + 4] !== v + 2 || idx[o + 5] !== v + 3) return null;
  }
  const keep = [0, 3, 5], blades = nv / PER, out = [];
  for (let b = 0; b < blades; b++)
    for (let r = 0; r + 1 < keep.length; r++) {
      const a = b * PER + keep[r] * 2, c = b * PER + keep[r + 1] * 2;
      out.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'gUv', 'normal']) g.setAttribute(k, geo.getAttribute(k));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(out), 1));
  return g;
}

// ── The field ────────────────────────────────────────────────────────────────
export function makeGrass(scene) {
  const shared = {
    uTime: { value: 0 }, uCamU: { value: new THREE.Vector3() },
    uWindB: { value: new THREE.Vector4() }, uWindC: { value: new THREE.Vector4() },
    uField: { value: new THREE.Vector4(60, 18, 0.15, 5) }, uDensityMul: { value: 1 }, uGrowth: { value: 1 },
    uFadeFrac: { value: 0.35 }, uSunView: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3(1, 1, 1) },
    uNight: { value: 1 },
  };
  const root = new THREE.Group(); root.name = 'ThalynGrassField';
  let block = null, layers = [], cov = null, bio = null, res = 0, wMinX = 0, wMinZ = 0, wSize = 1;
  let probe = null, probeKind = '';
  let budget = { radius: 40, density: 0.6, lod: 10, name: 'laptop' };
  const tiles = new Map();          // key → { tx, tz, h: Float32Array|null, minY, maxY, per: [ {data, n, ranks} ] }
  let queue = [];                    // tile keys waiting for generation (nearest first)
  let lastCam = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3();
  let dirty = true, drawn = 0, drawnTris = 0, logged = '';
  const frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _box = new THREE.Box3();
  const _v = new THREE.Vector3(), _vd = new THREE.Vector3(), _vo = [0, 0, 0];
  let tuftGeo = null, lodGeo = null, tuftTris = 0, lodTris = 0, maxBladeH = 1;

  function clear() {
    for (const e of layers) { for (const d of e.draws) { root.remove(d.mesh); d.geo.dispose(); } e.mat.dispose(); }
    layers = []; tiles.clear(); queue = []; working = null; block = null; cov = bio = null; probe = null;
    if (tuftGeo) { tuftGeo.dispose(); tuftGeo = null; }
    if (lodGeo) { lodGeo.dispose(); lodGeo = null; }
    if (root.parent) root.parent.remove(root);
    drawn = drawnTris = 0; logged = '';
  }

  // The world's grass block + the probe to stand blades on. Returns the layer count (0 = nothing to grow).
  function build(tx, terrainProbe, kind) {
    clear();
    const gb = tx && tx.grass;
    if (!gb || !gb.present || !Array.isArray(gb.layers) || !gb.layers.length) return 0;
    cov = bytesOf(gb.coverage); bio = bytesOf(gb.biome); res = gb.res | 0;
    const pos = f32Of(gb.meshPositions), uvs = f32Of(gb.meshUvs), nrm = f32Of(gb.meshNormals), idx = u16Of(gb.meshIndices);
    if (!cov || !bio || res <= 0 || cov.length < res * res || !pos || !uvs || !idx) { console.warn('[thalyn-grass] the grass block is incomplete — no grass'); return 0; }
    block = gb; probe = terrainProbe; probeKind = kind || '';
    wMinX = gb.worldMin[0]; wMinZ = gb.worldMin[1]; wSize = gb.worldSize;
    tuftGeo = new THREE.BufferGeometry();
    tuftGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    tuftGeo.setAttribute('gUv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    if (nrm && nrm.length === pos.length) tuftGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    else tuftGeo.computeVertexNormals();
    tuftGeo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    tuftTris = idx.length / 3;
    lodGeo = makeLodTuft(tuftGeo);   // fewer rows per blade past the tier's LOD distance (null = the tuft is not strips)
    lodTris = lodGeo ? lodGeo.index.count / 3 : tuftTris;
    shared.uGrowth.value = gb.growth > 0 ? gb.growth : 1;
    shared.uFadeFrac.value = gb.fadeStartFrac || 0.35;
    const wd = gb.windDir || [1, 0.3];
    shared.uWindB.value.set(gb.windGustFrequency || 0.3, 0, gb.windStrength || 2, 0);
    shared.uWindC.value.set(wd[0], wd[1], 1 / (128 * 1.75), 4 * Math.max(0.1, gb.windSpeed || 1));
    maxBladeH = 0.5;
    for (const L of gb.layers) {
      if (!(L.cellSize > 0)) continue;
      const mat = makeLayerMaterial(L, shared);
      mat.userData.grassUniforms.uWindA.value.set((gb.windStrength || 2) * (L.windMult || 1), gb.windSpeed || 1, gb.windTurbulence || 0.3, gb.windGust || 0.4);
      const draws = [];
      for (const src of lodGeo ? [tuftGeo, lodGeo] : [tuftGeo]) {
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = src.index;
        for (const k of ['position', 'gUv', 'normal']) geo.setAttribute(k, src.getAttribute(k));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;   // the app: shadows Off, receives
        mesh.name = 'ThalynGrass_' + (L.species || 'layer') + (src === lodGeo ? '_far' : '');
        const d = { geo, mesh, cap: 0, buf: null, n: 0 };
        ensureCap(d, 4096);
        root.add(mesh);
        draws.push(d);
      }
      const entry = { L, mat, draws, seed: (L.seed >>> 0), clip: L.clip };
      layers.push(entry);
      maxBladeH = Math.max(maxBladeH, (L.heightRange ? L.heightRange[1] : 1) * 1.3 * 1.5);
    }
    scene.add(root);
    dirty = true;
    console.info('[thalyn-grass] field from the world: ' + layers.length + ' layer(s) ' + layers.map(e => (e.L.species || '?') + ' ' + (1 / (e.L.cellSize * e.L.cellSize)).toFixed(0) + '/m²').join(', ')
      + ' · coverage ' + (gb.coveragePct != null ? gb.coveragePct.toFixed(1) + ' %' : '?') + ' of ' + res + '² · tuft ' + tuftTris + ' tris (far ' + lodTris + ') · roots on ' + probeKind);
    return layers.length;
  }

  function ensureCap(e, n) {
    if (e.cap >= n) return;
    const cap = Math.max(n, Math.ceil(e.cap * 1.5), 1024);
    const ib = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * FLOATS), FLOATS, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    e.geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    e.geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    e.geo.setAttribute('iC', new THREE.InterleavedBufferAttribute(ib, 4, 8));
    e.geo.setAttribute('iD', new THREE.InterleavedBufferAttribute(ib, 4, 12));
    e.buf = ib; e.cap = cap;
    // three r160 caches the instance limit ONCE (WebGLBindingStates sets geometry._maxInstanceCount only while it is
    // undefined), so a grown buffer would still draw at most the first capacity. Keep it in step with the buffer.
    e.geo._maxInstanceCount = cap;
  }

  // Tier: radius × density (TIERS.grassRadius / grassDensity). The app's falloff start scales with the radius.
  function setBudget(t, name) {
    const r = t && t.grassRadius > 0 ? t.grassRadius : 40, d = t && t.grassDensity > 0 ? t.grassDensity : 0.6;
    const changedDensity = Math.abs(d - budget.density) > 1e-3;
    budget = { radius: r, density: d, lod: t && t.grassLod > 0 ? t.grassLod : 10, name: name || '' };
    shared.uDensityMul.value = d;
    if (changedDensity) { tiles.clear(); queue = []; working = null; }
    dirty = true; logged = '';
  }

  // ── sampling the maps exactly as the kernel does ──
  function biomeAt(u, v) {   // point sample
    const x = Math.min(res - 1, Math.max(0, Math.floor(u * res))), z = Math.min(res - 1, Math.max(0, Math.floor(v * res)));
    const i = z * res + x, b = bio[i >> 1];
    return (i & 1) ? (b >> 4) : (b & 15);
  }
  function coverageAt(u, v) { // bilinear, clamp
    const fx = u * res - 0.5, fz = v * res - 0.5;
    let x0 = Math.floor(fx), z0 = Math.floor(fz); const tx = fx - x0, tz = fz - z0;
    const cl = a => Math.min(res - 1, Math.max(0, a));
    const x1 = cl(x0 + 1), z1 = cl(z0 + 1); x0 = cl(x0); z0 = cl(z0);
    const a = cov[z0 * res + x0], b = cov[z0 * res + x1], c = cov[z1 * res + x0], d = cov[z1 * res + x1];
    return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) / 255;
  }

  // The tile's ground: 17×17 probes over the tile ± GRID_PAD, unity (x, z) → glTF probe at (−x, z).
  function* probeTile(t) {
    const span = TILE + 2 * GRID_PAD, step = span / (GRID - 1), x0 = t.tx * TILE - GRID_PAD, z0 = t.tz * TILE - GRID_PAD;
    const h = new Float32Array(GRID * GRID); let mn = Infinity, mx = -Infinity, hits = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      if (i === 0 && (j & 3) === 3) yield;
      const y = probe(-(x0 + i * step), z0 + j * step);
      const v = (y === null || y === undefined || !isFinite(y)) ? NaN : y;
      h[j * GRID + i] = v;
      if (v === v) { hits++; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    t.h = h; t.x0 = x0; t.z0 = z0; t.step = step; t.minY = hits ? mn : 0; t.maxY = hits ? mx : 0; t.empty = hits === 0;
  }
  function heightIn(t, x, z) {
    const fx = (x - t.x0) / t.step, fz = (z - t.z0) / t.step;
    const i = Math.min(GRID - 2, Math.max(0, Math.floor(fx))), j = Math.min(GRID - 2, Math.max(0, Math.floor(fz)));
    const ax = Math.min(1, Math.max(0, fx - i)), az = Math.min(1, Math.max(0, fz - j));
    const h = t.h, a = h[j * GRID + i], b = h[j * GRID + i + 1], c = h[(j + 1) * GRID + i], d = h[(j + 1) * GRID + i + 1];
    return (a + (b - a) * ax) * (1 - az) + (c + (d - c) * ax) * az;   // NaN if any corner missed the terrain
  }

  // One layer's blades for one tile — the kernel's GenerateVisible minus the per-frame camera tests.
  // A generator: it yields every few cell rows so one tile never stalls a frame (the driver runs it on a time budget).
  function* genLayer(t, e) {
    const L = e.L, cs = L.cellSize, seedL = e.seed, clip = e.clip;
    const cx0 = Math.ceil(t.tx * TILE / cs), cx1 = Math.ceil((t.tx + 1) * TILE / cs) - 1;
    const cz0 = Math.ceil(t.tz * TILE / cs), cz1 = Math.ceil((t.tz + 1) * TILE / cs) - 1;
    const tmp = [], ranks = [];
    const hr = L.heightRange || [0.2, 0.5], wr = L.widthRange || [0.003, 0.008];
    const base = L.bladeBase || [0.2, 0.4, 0.1], tip = L.bladeTip || [0.5, 0.8, 0.3];
    const mask = L.biomeMask | 0, dens = budget.density, band = L.wildHeight ? (block.moistureBandM || 8) : 0;
    const water = block.waterLevelY || 0, boost = block.moistureBoost || 0.4;
    const clump = !!L.useClumping, tight = Math.max(0.01, (L.clumpSize || 2) * 0.3);
    for (let cz = cz0; cz <= cz1; cz++) {
     if (((cz - cz0) & 7) === 7) yield;
     for (let cx = cx0; cx <= cx1; cx++) {
      const seed = wang((Math.imul(cx, 0x8DA6B343) ^ Math.imul(cz, 0xD8163841) ^ Math.imul(seedL, 0xCB1AB31F)) >>> 0);
      let px = (cx + rnd(seed, 1)) * cs, pz = (cz + rnd(seed, 2)) * cs;
      if (clip && (px < clip[0] || pz < clip[1] || px > clip[2] || pz > clip[3])) continue;
      const u = (px - wMinX) / wSize, v = (pz - wMinZ) / wSize;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      if ((mask & (1 << biomeAt(u, v))) === 0) continue;
      if (rnd(seed, 3) >= coverageAt(u, v)) continue;
      if (dens < 1 && rnd(seed, 9) >= dens) continue;   // the viewer's tier thinning (a hash the kernel never uses)
      let hMul = 1, cMul = 1, shade = 0, facing = 0, tcx = 0, tcz = 0;
      if (clump) {
        voronoi(px / tight, pz / tight, 0.5, _vo);
        const dist = _vo[0], ccx = _vo[1] * tight, ccz = _vo[2] * tight;
        hash2(ccx, ccz, _h);
        const cVar = 1 - (L.clumpVariation || 0) * (1 - _h[0]);
        tcx = ccx - px; tcz = ccz - pz;
        const pull = (L.clumpStrength || 0) * 1.5 * cVar * (1 - dist);
        px += tcx * pull; pz += tcz * pull;
        px = Math.min(wMinX + wSize, Math.max(wMinX, px)); pz = Math.min(wMinZ + wSize, Math.max(wMinZ, pz));
        hash2(ccx * 1.713 + 3.17, ccz * 1.713 + 3.17, _h);
        hMul = 0.7 + 0.6 * _h[0]; cMul = 1 + (_h[1] - 0.5) * 0.12;
        shade = Math.min(1, Math.max(0, 1 - dist)) * cVar; facing = 0.4;
      }
      const py = heightIn(t, px, pz);
      if (py !== py) continue;   // no terrain under this root (off the export, or a hole)
      const hash = rnd(seed, 4);
      let height = hr[0] + (hr[1] - hr[0]) * rnd(seed, 5);
      if (band > 0) { const above = py - water; const wet = Math.min(1, Math.max(0, 1 - above / band)) * (above >= 0 ? 1 : 0); height *= 1 + boost * wet; }
      height *= hMul;
      const width = wr[0] + (wr[1] - wr[0]) * rnd(seed, 6);
      let rot = rnd(seed, 7) * 6.28318530718;
      if (facing > 0 && (tcx * tcx + tcz * tcz) > 1e-6) {
        const target = Math.atan2(tcz, tcx), delta = Math.atan2(Math.sin(target - rot), Math.cos(target - rot));
        rot += delta * facing;
      }
      const stiff = (L.stiffness || 1) * (0.7 + 0.6 * rnd(seed, 8));
      const cl = hash3x(px, pz, hash) * (L.colorVariation || 0);
      const e2 = Math.max(0.05, t.step);
      const hL = heightIn(t, px - e2, pz), hR = heightIn(t, px + e2, pz), hD = heightIn(t, px, pz - e2), hU = heightIn(t, px, pz + e2);
      let nx = 0, ny = 1, nz = 0;
      if (hL === hL && hR === hR && hD === hD && hU === hU) { nx = hL - hR; ny = 2 * e2; nz = hD - hU; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; }
      const rank = fract(hash * 1.37 + 0.13);
      tmp.push(px, py, pz, rot, height, width, hash, stiff,
        (base[0] + (tip[0] - base[0]) * cl) * cMul, (base[1] + (tip[1] - base[1]) * cl) * cMul, (base[2] + (tip[2] - base[2]) * cl) * cMul, shade,
        nx, ny, nz, rank);
      ranks.push(rank);
     }
    }
    // Sort by rank so a far tile can hand over just its prefix (the blades the thinning keeps).
    const n = ranks.length, order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => ranks[a] - ranks[b]);
    const data = new Float32Array(n * FLOATS), sortedRanks = new Float32Array(n);
    for (let k = 0; k < n; k++) { const s = order[k] * FLOATS; for (let f = 0; f < FLOATS; f++) data[k * FLOATS + f] = tmp[s + f]; sortedRanks[k] = ranks[order[k]]; }
    return { data, n, ranks: sortedRanks };
  }

  function* genTile(t) {
    yield* probeTile(t);
    const per = [];
    for (const e of layers) {
      const c = e.clip;
      const x0 = t.tx * TILE, z0 = t.tz * TILE;
      if (t.empty || (c && (x0 > c[2] || z0 > c[3] || x0 + TILE < c[0] || z0 + TILE < c[1]))) { per.push({ data: null, n: 0, ranks: null }); continue; }
      per.push(yield* genLayer(t, e));
    }
    t.per = per;
    t.ready = true;
  }
  let working = null, landed = false, lastAssemble = 0;   // the one tile being grown ({ key, it })

  // Per frame: queue the tiles in range, generate a few within a time budget, re-assemble the draw when the
  // camera has moved/turned enough or new tiles landed.
  function tick(dt, camera, opts = {}) {
    if (!block || !layers.length) return;
    if (opts.animate !== false) shared.uTime.value += dt;
    shared.uWindB.value.y = shared.uTime.value;
    const cp = camera.getWorldPosition(_v);
    const ux = -cp.x, uz = cp.z;
    shared.uCamU.value.set(ux, cp.y, uz);
    if (opts.sunDir) shared.uSunView.value.copy(opts.sunDir).transformDirection(camera.matrixWorldInverse);
    if (opts.sunColor) shared.uSunCol.value.set(opts.sunColor.r, opts.sunColor.g, opts.sunColor.b).multiplyScalar(opts.sunIntensity != null ? opts.sunIntensity : 1);
    if (opts.night != null) shared.uNight.value = 1 - 0.82 * Math.min(1, Math.max(0, opts.night));

    const R = budget.radius, gR = block.maxDistance > 0 ? block.maxDistance : 60;
    shared.uField.value.set(R, (block.falloffStart || 18) * (R / gR), block.farDensity != null ? block.farDensity : 0.15, block.edgeFade || 5);

    // Which tiles the disk touches.
    const t0x = Math.floor((ux - R) / TILE), t1x = Math.floor((ux + R) / TILE), t0z = Math.floor((uz - R) / TILE), t1z = Math.floor((uz + R) / TILE);
    const want = [];
    for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
      const nx = Math.max(tx * TILE, Math.min(ux, (tx + 1) * TILE)), nz = Math.max(tz * TILE, Math.min(uz, (tz + 1) * TILE));
      const dn = Math.hypot(nx - ux, nz - uz);
      if (dn > R) continue;
      want.push({ key: tx + ',' + tz, tx, tz, dn });
    }
    // Drop tiles well outside the disk; queue the missing ones nearest first.
    for (const [k, t] of tiles) {
      const cx = (t.tx + 0.5) * TILE, cz = (t.tz + 0.5) * TILE;
      if (Math.hypot(cx - ux, cz - uz) > R + 2.5 * TILE) { tiles.delete(k); dirty = true; }
    }
    for (const w of want) if (!tiles.has(w.key)) tiles.set(w.key, { tx: w.tx, tz: w.tz, ready: false });
    // Grow the tiles IN VIEW first (nearest first), then the rest — on a time budget; a tile is a resumable generator
    // (probe rows, then cell rows). While nothing is drawn yet the budget doubles, so a world opens green quickly.
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(_m);
    for (const w of want) {
      _box.min.set(-(w.tx + 1) * TILE - GRID_PAD, -1e4, w.tz * TILE - GRID_PAD);
      _box.max.set(-w.tx * TILE + GRID_PAD, 1e4, (w.tz + 1) * TILE + GRID_PAD);
      w.order = frustum.intersectsBox(_box) ? w.dn : w.dn + 4 * R;
    }
    queue = want.filter(w => !tiles.get(w.key).ready).sort((a, b) => a.order - b.order);
    const budgetMs = (opts.genMs || (budget.name === 'lite' ? 3 : 6)) * (drawn === 0 ? 2 : 1);
    const tStart = performance.now();
    while (performance.now() - tStart < budgetMs) {
      if (working && !tiles.has(working.key)) working = null;   // dropped while growing
      if (!working) {
        const w = queue.shift(); if (!w) break;
        working = { key: w.key, it: genTile(tiles.get(w.key)) };
      }
      if (working.it.next().done) { working = null; landed = true; }
    }
    const now = performance.now();
    if (landed && now - lastAssemble > 200) { dirty = true; landed = false; }

    // Re-assemble on movement / turning / new tiles.
    camera.getWorldDirection(_vd);
    if (!dirty && cp.distanceToSquared(lastCam) < 1.5 * 1.5 && _vd.dot(lastDir) > 0.995) return;
    lastCam.copy(cp); lastDir.copy(_vd); dirty = false; lastAssemble = now;
    const far = shared.uField.value.z, fs = shared.uField.value.y, lod2 = budget.lod * budget.lod, R2 = R * R;
    const cx = ux, cy = cp.y, cz = uz;
    let total = 0, tris = 0;
    for (let li = 0; li < layers.length; li++) {
      const e = layers[li];
      // The tiles in view and, per tile, the rank prefix its NEAREST point could keep (an upper bound) …
      let n = 0; const picks = [];
      for (const w of want) {
        const t = tiles.get(w.key); if (!t || !t.ready || t.empty) continue;
        const p = t.per[li]; if (!p || !p.n) continue;
        _box.min.set(-(t.tx + 1) * TILE - GRID_PAD, t.minY - 0.5, t.tz * TILE - GRID_PAD);
        _box.max.set(-t.tx * TILE + GRID_PAD, t.maxY + maxBladeH, (t.tz + 1) * TILE + GRID_PAD);
        if (!frustum.intersectsBox(_box)) continue;
        const tt = Math.min(1, Math.max(0, (w.dn - fs) / Math.max(0.001, R - fs)));
        const keepMax = (1 + (far - 1) * tt) + 0.1;
        let lo = 0, hi = p.n;   // first index with rank >= keepMax
        while (lo < hi) { const mid = (lo + hi) >> 1; if (p.ranks[mid] < keepMax) lo = mid + 1; else hi = mid; }
        if (lo > 0) { picks.push(p, lo); n += lo; }
      }
      // … then the kernel's own per-blade test (radius + rank < keep(d) + 0.1), split near (full tuft) / far (LOD tuft).
      const dn = e.draws[0], df = e.draws[1] || e.draws[0];
      ensureCap(dn, n); if (df !== dn) ensureCap(df, n);
      const an = dn.buf.array, af = df.buf.array; let on = 0, of = 0;
      for (let k = 0; k < picks.length; k += 2) {
        const p = picks[k], c = picks[k + 1], src = p.data;
        for (let i = 0; i < c; i++) {
          const s0 = i * FLOATS, dx = src[s0] - cx, dy = src[s0 + 1] - cy, dz = src[s0 + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > R2) continue;
          const d = Math.sqrt(d2), tt = Math.min(1, Math.max(0, (d - fs) / Math.max(0.001, R - fs)));
          if (src[s0 + 15] >= (1 + (far - 1) * tt) + 0.1) continue;
          if (d2 < lod2 || df === dn) { an.set(src.subarray(s0, s0 + FLOATS), on); on += FLOATS; }
          else { af.set(src.subarray(s0, s0 + FLOATS), of); of += FLOATS; }
        }
      }
      for (const [dd, used] of df === dn ? [[dn, on]] : [[dn, on], [df, of]]) {
        if (dd.buf.addUpdateRange) { dd.buf.clearUpdateRanges(); dd.buf.addUpdateRange(0, Math.max(used, FLOATS)); }
        else { dd.buf.updateRange.offset = 0; dd.buf.updateRange.count = Math.max(used, FLOATS); }
        dd.buf.needsUpdate = true;
        dd.geo.instanceCount = dd.n = used / FLOATS;
      }
      total += on / FLOATS + (df === dn ? 0 : of / FLOATS);
      tris += (on / FLOATS) * tuftTris + (df === dn ? 0 : (of / FLOATS) * lodTris);
    }
    drawn = total; drawnTris = tris;
    if (!queue.length && !working) {
      const line = 'tier=' + budget.name + ' R=' + R + ' density×' + budget.density + ' lod=' + budget.lod + 'm blades=' + drawn.toLocaleString() + ' tris=' + (drawnTris / 1e6).toFixed(2) + 'M';
      if (!logged) { logged = line; console.info('[thalyn-grass] ' + line + ' (' + layers.length + ' layer(s), ' + tiles.size + ' tile(s) of ' + TILE + ' m, roots on ' + probeKind + ')'); }
    }
  }

  return {
    build, clear, setBudget, tick,
    get layers() { return layers.length; },
    get blades() { return drawn; },
    get tris() { return drawnTris; },
    get pending() { return queue.length + (working ? 1 : 0); },
    get cached() { let n = 0, k = 0; for (const t of tiles.values()) if (t.ready) { k++; for (const p of t.per) n += p.n; } return { tiles: k, blades: n }; },
  };
}
