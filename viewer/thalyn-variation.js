// ★ A17140 (2026-11-15, Mike: "send pure data to the three.js file and have the three.js mimic the variation") — PER-INSTANCE FOLIAGE
// VARIATION, re-run in the browser from extras.thalyn.foliage (client GltfAtmosphereExtras.FoliageVariationBlock, GltfExportAdapter A17140).
//
// What the walk does per tree / shrub (and what the export could not bake into its one texture per proxy):
//   1. THE HUE JITTER (ThalynPalette.hlsl:141-153): angle = (frac(sin(dot(instanceXZ, (127.1, 311.7))) * 43758.5453) * 2 - 1) × peak, folded
//      into the cohesion grade's YIQ hue rotation (:98-117) BEFORE the tint pull (:123-128). instanceXZ = the renderer's world origin
//      (unity_ObjectToWorld._m03/_m23) = here the mesh / EXT_mesh_gpu_instancing instance origin, X negated (glTFast writes -x).
//      The grade early-returns while a look is worn, so the block says `armed` and nothing jitters unless it is.
//      The export bakes the grade WITHOUT the jitter (A15450). Since the tint pull keeps the pixel's own Rec.709 luma, the pulled share is
//      recoverable from the baked texel g:  P = tint.rgb × luma(g) / luma(tint.rgb);  g' = Rot(j)·(g − a·P) + a·P  — exactly the walk's
//      Rot(hue + j) on the un-pulled (1 − a) share and the same pull on top (graded rows; an ungraded row just rotates).
//   2. Then per MATERIAL (TreeLeafCluster_URP.shader:785-830 = ShrubClusterMesh_URP.shader:730-770): the emotional PATTERN of its
//      _EMOTIONALMODE_* keyword at _PatternStrength / _PatternScale (on the card uv), the 1 m³ CELL variation hash(floor(positionWS)) ×
//      _ColorVariationStrength, the LEAF-EDGE darken (1 − 0.4·edge) and the RIM (pow(1 − N·V, 2) × edge × 0.25, the eerie / chaotic colour
//      × _GlowIntensity). Ported line for line below (GLSL); the hashes take the APP frame position so the cells sit where the walk's do.
// No textures are made: the numbers ARE the per-instance data (the position of every instance is already in the file).
// ⚠ Same distribution, not bit-identical per tree: the hash is fed float32 positions that pass through glTFast + gltfpack, and sin() of
//   a ~10⁴ rad argument differs between D3D and WebGL. Each tree still gets its own stable ±peak hue, as in the walk.
// ?variation=0 (index.html) = off, for an A/B. PURE maths at the top (node tests it: node viewer/thalyn-variation.test.mjs).

export const LUMA709 = [0.2126, 0.7152, 0.0722];   // THALYN_PALETTE_LUMA
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fract = x => x - Math.floor(x);

/** ThalynPaletteHueJitterAt (app-frame XZ). 0 when the peak is 0. */
export function hueJitterAt(x, z, peak) {
  if (!(peak > 0)) return 0;
  const h = fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
  return (h * 2 - 1) * peak;
}

/** The YIQ hue rotation of ThalynPaletteGradeWithJitter (:105-116), identity below 1e-5. */
export function yiqRotate(c, a) {
  if (Math.abs(a) <= 1e-5) return c.slice();
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const r = [0.299 + 0.701 * cosA + 0.168 * sinA, 0.587 - 0.587 * cosA + 0.330 * sinA, 0.114 - 0.114 * cosA - 0.497 * sinA];
  const g = [0.299 - 0.299 * cosA - 0.328 * sinA, 0.587 + 0.413 * cosA + 0.035 * sinA, 0.114 - 0.114 * cosA + 0.292 * sinA];
  const b = [0.299 - 0.300 * cosA + 1.250 * sinA, 0.587 - 0.588 * cosA - 1.050 * sinA, 0.114 + 0.886 * cosA - 0.203 * sinA];
  return [dot3(c, r), dot3(c, g), dot3(c, b)];
}

/** ThalynPaletteGradeWithJitter, line for line (the walk). grade = { sat, val, hueShift, tint: [r, g, b, a] }. */
export function gradeWithJitter(albedo, grade, j) {
  if (!(grade.sat > 0)) return albedo.slice();
  const l = dot3(albedo, LUMA709);
  let c = albedo.map(v => (l + (v - l) * grade.sat) * grade.val);
  c = yiqRotate(c, grade.hueShift + j);
  const t = grade.tint || [0, 0, 0, 0];
  if (t[3] > 0.001) {
    const tl = dot3(t, LUMA709), cl = dot3(c, LUMA709);
    const tinted = [t[0] * cl / Math.max(tl, 1e-3), t[1] * cl / Math.max(tl, 1e-3), t[2] * cl / Math.max(tl, 1e-3)];
    c = c.map((v, i) => v + (tinted[i] - v) * t[3]);
  }
  return c.map(v => Math.max(v, 0));
}

/** The viewer's step: the jitter put back on a texel that already carries the grade (graded) or on a raw one. */
export function jitterTexel(g, tint, j, graded) {
  if (!graded || !(tint && tint[3] > 0.001)) return yiqRotate(g, j).map(v => Math.max(v, 0));
  const tl = dot3(tint, LUMA709), k = dot3(g, LUMA709) / Math.max(tl, 1e-3);
  const aP = [tint[0] * k * tint[3], tint[1] * k * tint[3], tint[2] * k * tint[3]];
  const r = yiqRotate([g[0] - aP[0], g[1] - aP[1], g[2] - aP[2]], j);
  return [r[0] + aP[0], r[1] + aP[1], r[2] + aP[2]].map(v => Math.max(v, 0));
}

/** The leaf shaders' hash(float3) (TreeLeafCluster_URP.shader:287), for the 1 m³ cell variation. */
export function hash3(p) {
  let q = p.map(v => fract(v * 0.3183099 + 0.1) * 17.0);
  return fract(q[0] * q[1] * q[2] * (q[0] + q[1] + q[2]));
}

export const MODES = { serene: 1, joyful: 2, oppressive: 3, desolate: 4, eerie: 5, chaotic: 6 };

/** The per-material switches a row turns into (pure: what the shader is compiled with). */
export function definesFor(row, block) {
  const d = {};
  if (block && block.armed && row.jitter && block.hueJitter > 0) { d.TV_JITTER = ''; if (row.graded) d.TV_GRADED = ''; }
  const mode = MODES[String(row.mode || '').toLowerCase()] || 0;
  if (mode) d.TV_MODE = mode;
  return d;
}

// ── GLSL (three r160 MeshStandardMaterial chunks) ────────────────────────────────────────────────────────────────────────────────────────
export const VARIATION_VERTEX_HEAD = 'varying vec3 vTvWorld;\nvarying vec2 vTvOrigin;\n';
export const VARIATION_VERTEX = `
  #ifdef USE_INSTANCING
    vec4 tvW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    vTvOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
  #else
    vec4 tvW = modelMatrix * vec4(transformed, 1.0);
    vTvOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
  #endif
  vTvWorld = tvW.xyz;`;

export const VARIATION_FRAGMENT_HEAD = `
varying vec3 vTvWorld; varying vec2 vTvOrigin;
uniform vec4 uTvTint; uniform float uTvJitter; uniform vec4 uTvPat; uniform float uTvTime;
const vec3 TV_LUMA = vec3(0.2126, 0.7152, 0.0722);
float tvHash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tvHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tvNoise(vec3 x) {
  vec3 p = floor(x); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(tvHash3(p), tvHash3(p + vec3(1,0,0)), f.x), mix(tvHash3(p + vec3(0,1,0)), tvHash3(p + vec3(1,1,0)), f.x), f.y),
             mix(mix(tvHash3(p + vec3(0,0,1)), tvHash3(p + vec3(1,0,1)), f.x), mix(tvHash3(p + vec3(0,1,1)), tvHash3(p + vec3(1,1,1)), f.x), f.y), f.z);
}
float tvFbm(vec3 x, int oct) {
  float v = 0.0, a = 0.5, fr = 1.0, t = 0.0;
  for (int i = 0; i < 3; i++) { if (i >= oct) break; v += a * tvNoise(x * fr); t += a; a *= 0.5; fr *= 2.0; }
  return v / t;
}
vec3 tvRGBtoHSV(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 tvHSVtoRGB(vec3 c) { vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
vec3 tvHSVShift(vec3 c, float hue, float sat, float bri) { vec3 h = tvRGBtoHSV(c); h.x = fract(h.x + hue / 360.0); h.y = clamp(h.y * sat, 0.0, 1.0); h.z = clamp(h.z * bri, 0.0, 1.0); return tvHSVtoRGB(h); }
vec3 tvYiq(vec3 c, float a) {
  if (abs(a) <= 1e-5) return c;
  float cosA = cos(a), sinA = sin(a);
  vec3 r = vec3(0.299 + 0.701 * cosA + 0.168 * sinA, 0.587 - 0.587 * cosA + 0.330 * sinA, 0.114 - 0.114 * cosA - 0.497 * sinA);
  vec3 g = vec3(0.299 - 0.299 * cosA - 0.328 * sinA, 0.587 + 0.413 * cosA + 0.035 * sinA, 0.114 - 0.114 * cosA + 0.292 * sinA);
  vec3 b = vec3(0.299 - 0.300 * cosA + 1.250 * sinA, 0.587 - 0.588 * cosA - 1.050 * sinA, 0.114 + 0.886 * cosA - 0.203 * sinA);
  return vec3(dot(c, r), dot(c, g), dot(c, b));
}
vec3 tvPatternSerene(vec2 uv, vec3 base, float s) { float d = length(uv - 0.5); float g = 1.0 - smoothstep(0.0, 0.7, d); return mix(base, base * 1.15, g * s * 0.5); }
vec3 tvPatternJoyful(vec2 uv, vec3 base, float s, float sc, vec3 wp) {
  vec2 gu = uv * 15.0 * sc; vec2 gid = floor(gu); vec2 gf = fract(gu) - 0.5; float sparkle = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y)); vec2 id = gid + o; float rnd = tvHash2(id);
    if (rnd > 0.7) { vec2 sp = vec2(tvHash2(id + 100.0), tvHash2(id + 200.0)) - 0.5; float d = length(gf - o - sp * 0.8);
      float tw = sin(uTvTime * 5.0 + rnd * 6.28) * 0.5 + 0.5; sparkle += (1.0 - smoothstep(0.0, 0.15, d)) * tw; }   // = HLSL smoothstep(0.15, 0.0, d): GLSL leaves edge0 > edge1 undefined
  }
  float cs = tvNoise(vec3(wp.xz * 2.0, uTvTime * 0.5)) * 0.3;
  vec3 sh = tvHSVShift(base, cs * 60.0, 1.1, 1.0);
  return mix(base, sh + vec3(1.0, 0.95, 0.7) * sparkle, s);
}
vec3 tvPatternOppressive(vec2 uv, vec3 base, float s, float sc) {
  vec2 vu = uv * 8.0 * sc;
  float v1 = abs(sin(vu.x * 3.14159 + vu.y * 2.0)), v2 = abs(sin(vu.y * 3.14159 - vu.x * 1.5));
  float veins = pow(min(v1, v2), 0.5); veins = veins * (0.7 + tvNoise(vec3(uv * 15.0 * sc, 0.0)) * 0.3);
  vec3 dk = base * 0.7; vec3 op = mix(dk, dk * vec3(0.3, 0.1, 0.05), 1.0 - veins);
  return mix(base, op, s);
}
vec3 tvPatternChaotic(vec2 uv, vec3 base, float s, float sc, vec3 wp) {
  vec2 c = uv - 0.5; float d = length(c); float an = atan(c.y, c.x);
  float s1 = sin(an * 4.0 + d * 20.0 * sc - uTvTime * 3.0), s2 = sin(an * 7.0 - d * 15.0 * sc + uTvTime * 2.0), s3 = cos(an * 3.0 + d * 25.0 * sc + uTvTime);
  float chaos = (s1 + s2 + s3) / 3.0;
  float rnd = tvHash3(floor(wp * 5.0));
  vec3 cc = tvHSVShift(base, rnd * 120.0 - 60.0, 1.3, 1.0);
  float streak = pow(clamp(chaos * 0.5 + 0.5, 0.0, 1.0), 4.0);
  vec3 res = mix(base, cc + vec3(0.9, 0.3, 0.1) * streak, s);
  float dis = tvFbm(vec3(uv * 10.0 * sc, uTvTime * 0.5), 3);
  return mix(res, res * (0.8 + dis * 0.4), s * 0.5);
}
vec3 tvPatternDesolate(vec2 uv, vec3 base, float s, float sc) {
  vec2 cu = uv * 6.0 * sc; vec2 cid = floor(cu); vec2 cf = fract(cu); float m1 = 1.0, m2 = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y)); vec2 id = cid + o; vec2 cc = vec2(tvHash2(id), tvHash2(id + 100.0));
    float d = length(cf - o - cc); if (d < m1) { m2 = m1; m1 = d; } else if (d < m2) { m2 = d; }
  }
  float crack = smoothstep(0.0, 0.1, m2 - m1);
  vec3 db = tvHSVShift(base, -40.0, 0.4, 0.8);
  return mix(base, mix(db, vec3(0.15, 0.1, 0.05), 1.0 - crack), s);
}
vec3 tvPatternEerie(vec2 uv, vec3 base, float s, float sc, vec3 wp) {
  float t = uTvTime * 0.5; vec2 fu = uv * 5.0 * sc;
  float w = (sin(fu.x * 2.0 + fu.y * 3.0 + t) * sin(fu.x * 3.0 - fu.y * 2.0 - t * 0.7)) * 0.5 + 0.5; w = w * w;
  w *= (0.5 + tvFbm(vec3(uv * 8.0 * sc, t * 0.3), 2) * 0.5);
  vec3 eb = tvHSVShift(base, 60.0, 0.5, 0.9);
  float pulse = sin(t * 2.0 + tvHash3(wp) * 6.28) * 0.2 + 0.8;
  return mix(base, eb + vec3(0.7, 0.9, 1.0) * w * pulse, s);
}
`;

// Before the alpha test (alphaToCoverage remaps diffuseColor.a inside it): the albedo chain on the raw texel.
export const VARIATION_FRAGMENT_ALBEDO = `
  vec3 tvBefore = diffuseColor.rgb;
  float tvEdge = 0.0;
  {
    vec3 c = diffuseColor.rgb;
    #ifdef TV_JITTER
      float tvJ = (tvHash2(vec2(-vTvOrigin.x, vTvOrigin.y)) * 2.0 - 1.0) * uTvJitter;   // the APP frame XZ (glTFast wrote -x)
      #ifdef TV_GRADED
        vec3 tvAP = (uTvTint.a > 0.001) ? uTvTint.rgb * (dot(c, TV_LUMA) / max(dot(uTvTint.rgb, TV_LUMA), 1e-3)) * uTvTint.a : vec3(0.0);
        c = max(tvYiq(c - tvAP, tvJ) + tvAP, 0.0);
      #else
        c = max(tvYiq(c, tvJ), 0.0);
      #endif
    #endif
    #ifdef TV_MODE
      vec3 tvWp = vec3(-vTvWorld.x, vTvWorld.y, vTvWorld.z);
      #ifdef USE_MAP
        vec2 tvUv = vMapUv;
      #else
        vec2 tvUv = vec2(0.5);
      #endif
      #if TV_MODE == 2
        c = tvPatternJoyful(tvUv, c, uTvPat.x, uTvPat.y, tvWp);
      #elif TV_MODE == 3
        c = tvPatternOppressive(tvUv, c, uTvPat.x, uTvPat.y);
      #elif TV_MODE == 4
        c = tvPatternDesolate(tvUv, c, uTvPat.x, uTvPat.y);
      #elif TV_MODE == 5
        c = tvPatternEerie(tvUv, c, uTvPat.x, uTvPat.y, tvWp);
      #elif TV_MODE == 6
        c = tvPatternChaotic(tvUv, c, uTvPat.x, uTvPat.y, tvWp);
      #else
        c = tvPatternSerene(tvUv, c, uTvPat.x);
      #endif
      c += (tvHash3(floor(tvWp)) * 2.0 - 1.0) * uTvPat.z;
      #ifdef USE_ALPHATEST
        float tvCut = alphaTest;
      #else
        float tvCut = 0.5;
      #endif
      tvEdge = clamp(1.0 - (diffuseColor.a - tvCut) * 3.0, 0.0, 1.0);
      c *= 1.0 - tvEdge * 0.4;
    #endif
    diffuseColor.rgb = c;
  }`;

// After the normal is known: the rim, added to the albedo as the walk adds it (before lighting).
export const VARIATION_FRAGMENT_RIM = `
  #ifdef TV_MODE
  {
    float tvRim = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    tvRim = tvRim * tvRim * tvEdge * 0.25;
    #if TV_MODE == 6
      diffuseColor.rgb += tvRim * vec3(0.8, 0.3, 0.2) * uTvPat.w;
    #elif TV_MODE == 5
      diffuseColor.rgb += tvRim * vec3(0.5, 0.55, 0.9) * uTvPat.w;
    #else
      diffuseColor.rgb += tvRim * vec3(0.2, 0.3, 0.1);
    #endif
  }
  #endif`;

// The export's emissive floor samples the same texture (emissiveMap = map): it follows the albedo's change, or a varied canopy would glow unvaried.
export const VARIATION_FRAGMENT_EMISSIVE = `
  #ifdef TV_EMISSIVE_ALBEDO
    totalEmissiveRadiance *= clamp(diffuseColor.rgb / max(tvBefore, vec3(1e-3)), 0.0, 4.0);
  #endif`;

function inject(shader, row, uniforms, emissiveFromAlbedo) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = VARIATION_VERTEX_HEAD + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>' + VARIATION_VERTEX);
  let f = VARIATION_FRAGMENT_HEAD + shader.fragmentShader;
  f = f.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>' + VARIATION_FRAGMENT_ALBEDO);
  f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + VARIATION_FRAGMENT_RIM);
  if (emissiveFromAlbedo) f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + VARIATION_FRAGMENT_EMISSIVE);
  shader.fragmentShader = f;
}

/** Hang the chain on every material the block names. uTime = { value } the caller advances (seconds). Returns the counts for the console. */
export function applyFoliageVariation(block, root, uTime) {
  const out = { materials: 0, meshes: 0, instanced: 0, unmatched: 0, jitter: 0, patterns: {} };
  if (!block || !block.present || !Array.isArray(block.materials) || !root) return out;
  const rows = new Map(block.materials.filter(r => r && r.name).map(r => [r.name, r]));
  const t = Array.isArray(block.tint) && block.tint.length >= 4 ? block.tint : [0, 0, 0, 0];
  const shared = { uTvTint: { value: { x: +t[0], y: +t[1], z: +t[2], w: +t[3] } }, uTvJitter: { value: block.armed ? +block.hueJitter || 0 : 0 }, uTvTime: uTime || { value: 0 } };
  const seen = new Set(), matched = new Set();
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    let hit = false;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      const row = m && rows.get(m.name);
      if (!row) continue;
      hit = true; matched.add(m.name);
      if (seen.has(m) || (m.userData && m.userData.__tvVar)) continue;
      seen.add(m);
      const defines = definesFor(row, block);
      if (!Object.keys(defines).length) continue;   // nothing per instance on this row (disarmed jitter, no pattern props)
      const emissiveFromAlbedo = !!(m.emissiveMap && m.map && m.emissiveMap === m.map);
      if (emissiveFromAlbedo) defines.TV_EMISSIVE_ALBEDO = '';
      m.defines = Object.assign({}, m.defines || {}, defines);
      const uniforms = Object.assign({ uTvPat: { value: { x: +row.pattern || 0, y: +row.patternScale || 1, z: +row.cellVar || 0, w: +row.glow || 0 } } }, shared);
      const prev = m.onBeforeCompile;
      const prevKey = prev ? prev.toString() : '';
      m.onBeforeCompile = function (shader, renderer) {
        if (prev) prev.call(this, shader, renderer);
        inject(shader, row, uniforms, emissiveFromAlbedo);
      };
      const key = 'tvar-a17140|' + JSON.stringify(defines) + '|' + prevKey;
      m.customProgramCacheKey = () => key;
      m.userData.__tvVar = true;
      m.needsUpdate = true;
      out.materials++;
      if (defines.TV_JITTER !== undefined) out.jitter++;
      const mode = Object.keys(MODES).find(k => MODES[k] === defines.TV_MODE);
      if (mode) out.patterns[mode] = (out.patterns[mode] || 0) + 1;
    }
    if (hit) { out.meshes++; if (o.isInstancedMesh) out.instanced++; }
  });
  out.unmatched = [...rows.keys()].filter(n => !matched.has(n)).length;
  return out;
}

/** The console line (an absent block is said plainly: an older export, or the client gate Thalyn_GltfFoliageVariation = 0). */
export function describeVariation(block, r, off) {
  if (off) return '[thalyn] A17140 foliage variation OFF (?variation=0) - the proxies as baked';
  if (!block || !block.present) return '[thalyn] A17140 foliage variation: no extras.thalyn.foliage in this file (an older export, or the client gate Thalyn_GltfFoliageVariation = 0) - the proxies as baked';
  const pats = Object.entries((r && r.patterns) || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const n = (block.materials || []).length;
  return `[thalyn] A17140 foliage variation: ${r ? r.materials : 0} of ${n} material(s) re-run per instance on ${r ? r.meshes : 0} mesh(es) (${r ? r.instanced : 0} instanced) · ` +
    (block.armed ? `hue jitter ±${((+block.hueJitter || 0) * 180 / Math.PI).toFixed(1)}° on ${r ? r.jitter : 0}` : 'jitter DISARMED (a look is worn)') +
    ` · patterns: ${pats}` + (r && r.unmatched ? ` · ${r.unmatched} row(s) matched no material in this file` : '');
}
