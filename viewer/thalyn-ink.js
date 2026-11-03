// thalyn-ink.js — ★ LOOKING-GLASS IN THE BROWSER (2026-11-03, LOOK ENGINE; parity with Thalyn Final's ThalynInkRenderFeature +
// Hidden/Thalyn/InkRender, the look-driven path). ONE set of numbers drives both: the look row's "render.ink" block in looks/LookPalettes.json
// (a verbatim copy of the game's Resources/LookPalettes.json). The laws are the game shader's:
//   HAND-TINT  the local colour muted (saturation × mutedSat, greens → sage, grey stone warm, value lifted) over cream paper at keepLocal,
//              in display space; ONE rose accent pinned by hue (round 5, out5/lookingglass.html)
//   OUTLINE    the depth second difference (a sloped plane draws nothing), width by eye depth, the busy stand-down in leaf clutter
//   ENGRAVE    round 5's strokes (hairline swelling with shade, interleaved deep-shade line, cross-hatch in shadow), octave-stepped by
//              distance; on the SOLVED hatch field (TEXCOORD_4 → 'texcoord_4', world metres) where a mesh carries one (HIGH), else the
//              world fallback (contours on walls, diagonals on tops)
//   GLOW       an emissive warm pixel (HDR, pre-tonemap) keeps its glow; GRAIN screen-fixed paper tooth + fibre
// Tiers: lite = tint + outline (cheap) · laptop = + strokes · high = + the hatch field + diagonal taps + the octave blend.
// GAPS vs the app (the viewer has no normals buffer; said once in the console): no grass marker (strokes stand down where the
// depth-derived normal is noisy instead), no ground marker (up-facing surfaces fade over groundNear..groundFar instead), no crease lines.
// A file that says look.baked never comes here (its textures already wear the look). A file with no field = the world fallback, no errors.

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const FIELD_LAYER = 30;
export const TAG_LAYER = 29;    // ★ V3 meshes carrying the Looking-Glass node tags (lg_glow / lg_accent / lg_hatch_scale)

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = `
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D tField; uniform sampler2D tTag; uniform float uTagOn; uniform float uNight;
uniform float cameraNear, cameraFar, uP11; uniform mat4 uProjInv, uViewInv; uniform vec2 uRes;
uniform vec4 uLine, uEdge, uHatch, uPaper, uAccent, uTint, uGround, uGlow, uTier;
uniform vec3 uInk, uPaperCol;
varying vec2 vUv;

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y); }
vec3 rgb2hsv(vec3 c){ vec4 K = vec4(0., -1./3., 2./3., -1.); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-4)), d / (q.x + 1e-4), q.x); }
vec3 hsv2rgb(vec3 c){ vec3 p = abs(fract(c.xxx + vec3(1., 2./3., 1./3.)) * 6. - 3.); return c.z * mix(vec3(1.), clamp(p - 1., 0., 1.), c.y); }
vec3 toSrgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLin(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float rawDepth(vec2 uv){ return texture2D(tDepth, uv).x; }
float eyeDepth(vec2 uv){ return -perspectiveDepthToViewZ(rawDepth(uv), cameraNear, cameraFar); }
vec3 viewPos(vec2 uv){ float d = rawDepth(uv); vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }

float stripe(float u, float s, float th, float aa){ float x = fract(u / s) - 0.5; float d = abs(x) * s; float hw = th * 0.5 * s;
  return 1.0 - smoothstep(hw - aa, hw + aa, d); }
float engrave(float u1, float u2, float tone, float s, float aa){
  float dk = clamp((1.0 - tone) * uHatch.x, 0.0, 1.0);
  float c = stripe(u1, s, 0.05 + 0.42 * dk, aa);
  c = max(c, stripe(u1 + 0.5 * s, s, clamp((dk - 0.62) * 1.2, 0.0, 0.4), aa));
  c = max(c, stripe(u2, s * 1.15, clamp(dk - 0.5, 0.0, 0.35), aa));
  return c; }
vec3 handTint(vec3 hsv, float accent, float tone){
  // NIGHT (the app's 11-03 walk fix, same numbers): the value lift, the paper and the light floor fall with the night amount
  float night = clamp(uNight, 0.0, 1.0), lift = mix(0.42, 0.06, night);
  float green = smoothstep(0.14, 0.2, hsv.x) * (1.0 - smoothstep(0.42, 0.5, hsv.x));
  float hue = mix(hsv.x, 0.24, green * uTint.y);
  vec3 muted = hsv2rgb(vec3(hue, hsv.y * max(uTint.x - 0.08 * green, 0.0), lift + (1.0 - lift) * hsv.z));
  float stone = 1.0 - smoothstep(0.08, 0.28, hsv.y);
  muted = muted * (1.0 - uTint.z * stone) + vec3(0.93, 0.85, 0.71) * uTint.z * stone * (0.5 + 0.5 * hsv.z);
  float k = clamp(uPaper.z, 0.0, 1.0);
  vec3 b = toSrgb(uPaperCol) * mix(1.0, 0.25, night) * (1.0 - k) + muted * k;
  b *= mix(0.78, 0.35, night) + 0.27 * clamp(tone * 1.3, 0.0, 1.0);
  vec3 rose = hsv2rgb(vec3(uAccent.x, clamp(hsv.y * 0.6, 0.28, 0.5), 0.62 + 0.36 * hsv.z));
  return toLin(mix(b, rose, accent)); }

void main(){
  vec4 src = texture2D(tDiffuse, vUv); vec3 col = src.rgb;
  float raw = rawDepth(vUv); bool sky = raw >= 1.0 - 1e-6;
  float lum = dot(col, vec3(0.299, 0.587, 0.114)); float tone = clamp(sqrt(max(lum, 0.0)), 0.0, 1.0);
  vec3 hsv = rgb2hsv(toSrgb(clamp(col, 0.0, 1.0)));
  // ★ V3 THE NODE TAGS (the app's LookNodeTags): only where the tagged surface IS the visible one (its depth matches)
  float tagGlow = 0.0, tagAccent = 1.0, tagHatch = 1.0;
  if (uTagOn > 0.5 && !sky) {
    vec4 tg = texture2D(tTag, vUv); float dE = eyeDepth(vUv);
    if (tg.a > 0.0 && abs(tg.a - dE) < dE * 0.02 + 0.05) { tagGlow = tg.r; tagAccent = tg.g; tagHatch = tg.b; }
  }
  float dh = abs(hsv.x - uAccent.x); dh = min(dh, 1.0 - dh);
  float accent = (1.0 - smoothstep(uAccent.y * 0.6, uAccent.y, dh)) * smoothstep(uAccent.z * 0.7, uAccent.z, hsv.y) * uAccent.w * tagAccent;
  accent *= 1.0 - smoothstep(0.3, 0.8, clamp(uNight, 0.0, 1.0));   // the accent keys on the LIT colour: a warm light at night is not a rose
  float amber = smoothstep(0.03, 0.05, hsv.x) * (1.0 - smoothstep(0.14, 0.17, hsv.x)) * smoothstep(0.35, 0.5, hsv.y);
  float glow = sky ? 0.0 : max(tagGlow, uGlow.y * amber * smoothstep(uGlow.x, uGlow.x * 1.5, max(col.r, max(col.g, col.b))));
  vec3 base = handTint(hsv, accent, tone);
  base = mix(base, col + toLin(vec3(1.0, 0.80, 0.48)) * 0.55 * amber, glow);
  float ink = 0.0;
  if (!sky) {
    float depth = eyeDepth(vUv);
    float wPx = clamp(uLine.x * pow(5.0 / max(depth, 0.5), uLine.y), uLine.z, uLine.w);
    vec2 o = wPx / uRes;
    float dl = eyeDepth(vUv - vec2(o.x, 0.)), dr = eyeDepth(vUv + vec2(o.x, 0.)), du = eyeDepth(vUv + vec2(0., o.y)), dd = eyeDepth(vUv - vec2(0., o.y));
    float e2 = max(abs(dl + dr - 2.0 * depth), abs(du + dd - 2.0 * depth)) / depth;
    float edge = smoothstep(uEdge.x, uEdge.x * 2.0, e2);
    if (uTier.x >= 2.0) {
      vec2 od = o * 0.7071;
      float d1 = eyeDepth(vUv + od), d2 = eyeDepth(vUv - od), d3 = eyeDepth(vUv + vec2(od.x, -od.y)), d4 = eyeDepth(vUv + vec2(-od.x, od.y));
      edge = max(edge, smoothstep(uEdge.x, uEdge.x * 2.0, max(abs(d1 + d2 - 2.0 * depth), abs(d3 + d4 - 2.0 * depth)) / depth));
    }
    if (uEdge.y > 0.0 && edge > 0.0 && uTier.x >= 1.0) {      // the busy stand-down: depth steps all round = leaf clutter, not a silhouette
      float steps = 0.0;
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.785398;
        float dk = eyeDepth(vUv + vec2(cos(a), sin(a)) * o * 2.5);
        steps += step(uEdge.x * 4.0, abs(dk - depth) / depth);
      }
      edge *= 1.0 - uEdge.y * smoothstep(3.5, 6.5, steps);
    }
    ink = edge * uEdge.w;
    if (uTier.x >= 1.0) {
      vec3 vp = viewPos(vUv);
      vec3 wp = (uViewInv * vec4(vp, 1.0)).xyz;
      vec3 nW = normalize(mat3(uViewInv) * normalize(cross(dFdx(vp), dFdy(vp))));
      float noisy = smoothstep(0.6, 1.2, length(fwidth(nW)));        // GAP: no grass marker - noisy normals (blades, leaf cards) stand down
      float pixelWorld = depth / max(uP11 * 0.5 * uRes.y, 1.0);
      float oct = log2(max(pixelWorld * uHatch.y, 1e-4) / 0.05), o0 = floor(oct), fr = oct - o0;
      float s0 = 0.05 * exp2(o0), aa = pixelWorld * 0.75;
      vec3 field = vec3(0.0);
      if (uTier.y > 0.5) { vec4 fd = texture2D(tField, vUv); if (fd.a > 0.0 && abs(fd.a - depth) < depth * 0.02 + 0.05) field = vec3(fd.rg, 1.0); }
      float top = smoothstep(0.85, 0.95, abs(nW.y));
      float u1 = field.z > 0.5 ? field.x : mix(wp.y, (wp.x + wp.z) * 0.7071, top);
      float u2 = field.z > 0.5 ? field.y : dot(wp, vec3(0.577, -0.577, 0.577));
      float hatch = engrave(u1, u2, tone, s0, aa);
      if (uTier.x >= 2.0) hatch = mix(hatch, engrave(u1, u2, tone, s0 * 2.0, aa), smoothstep(0.0, 1.0, fr));
      float groundK = (uGround.w > 0.5 && nW.y > 0.85) ? uGround.z * (1.0 - smoothstep(uGround.x, uGround.y, depth)) : 1.0;   // GAP: no ground marker
      ink = max(ink, hatch * uHatch.w * (1.0 - accent * 0.8) * groundK * (1.0 - noisy) * tagHatch);
    }
    ink *= 1.0 - glow * 0.85;
  }
  vec3 outCol = mix(base, uInk, clamp(ink, 0.0, 1.0));
  vec2 sp = vUv * uRes;
  outCol *= 1.0 + (hash21(sp) - 0.5) * uPaper.x + (uTier.x >= 1.0 ? (vnoise(sp * vec2(0.35, 0.02)) - 0.5) * uPaper.y : 0.0);
  gl_FragColor = vec4(max(outCol, 0.0), 1.0);
}`;

// the hatch field pass: fielded meshes → (u1, u2 in world metres, 0, eye depth). Standard chunks, so instanced meshes work too.
const FIELD_VERT = `
#include <common>
attribute vec2 texcoord_4;
varying vec3 vH;
void main(){
  #include <begin_vertex>
  #include <project_vertex>
  float s = pow(abs(determinant(mat3(modelMatrix))), 1.0 / 3.0);
  vH = vec3(texcoord_4 * s, -mvPosition.z);
}`;
const FIELD_FRAG = `varying vec3 vH; void main(){ gl_FragColor = vec4(vH.x, vH.y, 0.0, vH.z); }`;

// ★ V3 the tag pass: tagged meshes → (lg_glow, lg_accent, lg_hatch_scale, eye depth); the values ride a per-vertex 'lgtag' baked at load
const TAG_VERT = `
#include <common>
attribute vec3 lgtag;
varying vec4 vT;
void main(){
  #include <begin_vertex>
  #include <project_vertex>
  vT = vec4(lgtag, -mvPosition.z);
}`;
const TAG_FRAG = `varying vec4 vT; void main(){ gl_FragColor = vT; }`;

const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const TIER = { lite: 0, laptop: 1, high: 2 };
const srgb = (a, d) => { const c = Array.isArray(a) && a.length >= 3 ? a : d; return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); };

/** Tag every mesh of a freshly loaded world that carries the hatch field (TEXCOORD_4 → 'texcoord_4') onto FIELD_LAYER. Returns the count. */
export function tagFieldMeshes(root) {
  let count = 0;
  root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.texcoord_4) { o.layers.enable(FIELD_LAYER); count++; } });
  return count;
}

/** ★ V3 · tag every mesh whose node (or a parent node, up to 2 levels) carries lg_glow / lg_accent / lg_hatch_scale in its glTF extras
 *  (three's userData) onto TAG_LAYER, its values baked into a per-vertex 'lgtag' (glow, accent, hatch). Per NODE, never per material. */
export function tagNodeTags(root) {
  let count = 0;
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) ? +v : undefined);
  root.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
    const get = (k) => { for (let p = o, i = 0; p && i < 3; p = p.parent, i++) { const v = num(p.userData && p.userData[k]); if (v !== undefined) return v; } return undefined; };
    const g = get('lg_glow'), a = get('lg_accent'), h = get('lg_hatch_scale');
    if (g === undefined && a === undefined && h === undefined) return;
    const glow = Math.min(1, Math.max(0, g ?? 0)), acc = Math.min(1, Math.max(0, a ?? 1)), hat = Math.min(2, Math.max(0, h ?? 1));
    if (glow <= 0 && acc >= 1 && Math.abs(hat - 1) < 1e-6) return;   // identity: nothing to draw
    const n = o.geometry.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[3 * i] = glow; arr[3 * i + 1] = acc; arr[3 * i + 2] = hat; }
    o.geometry.setAttribute('lgtag', new THREE.BufferAttribute(arr, 3));
    o.layers.enable(TAG_LAYER); count++;
  });
  return count;
}

export function makeInk(post, camera, scene, renderer) {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, tField: { value: null }, tTag: { value: null }, uTagOn: { value: 0 }, uNight: { value: 0 },
      cameraNear: { value: 0.1 }, cameraFar: { value: 1000 }, uP11: { value: 1 },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2(1, 1) },
      uLine: { value: new THREE.Vector4(3.5, 0.35, 1.2, 5) }, uEdge: { value: new THREE.Vector4(0.015, 0.9, 0, 1) },
      uHatch: { value: new THREE.Vector4(1, 6, 0.45, 0.9) }, uPaper: { value: new THREE.Vector4(0.06, 0.05, 0.66, 0) },
      uAccent: { value: new THREE.Vector4(0.965, 0.07, 0.35, 1) }, uTint: { value: new THREE.Vector4(0.58, 0.25, 0.35, 1) },
      uGround: { value: new THREE.Vector4(5, 20, 0.3, 1) }, uGlow: { value: new THREE.Vector4(1.5, 1, 0, 1) }, uTier: { value: new THREE.Vector4(1, 0, 0, 0) },
      uInk: { value: new THREE.Color() }, uPaperCol: { value: new THREE.Color() },
    },
    vertexShader: VERT, fragmentShader: FRAG,
  });
  pass.enabled = false;
  let inserted = false, said = '', tierN = 1, fieldMeshes = 0, edgeStrength = 1, tagMeshes = 0;

  // the depth: the composer's own targets (the look render attaches it the same way)
  function ensureDepth() {
    for (const rt of [post.composer.renderTarget1, post.composer.renderTarget2]) {
      if (rt.depthTexture) continue;
      rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
      rt.depthTexture.type = THREE.UnsignedIntType;
      rt.dispose();
    }
  }

  // the hatch field target (HIGH only, and only with fielded meshes): float, its own depth so fielded meshes occlude each other
  const gl = renderer.getContext();
  const floatOk = !!(renderer.capabilities.isWebGL2 && gl.getExtension('EXT_color_buffer_float'));
  let fieldRT = null;
  const fieldMat = new THREE.ShaderMaterial({ vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, side: THREE.DoubleSide });
  const _clear = new THREE.Color(), _layers = new THREE.Layers();

  const tagMat = new THREE.ShaderMaterial({ vertexShader: TAG_VERT, fragmentShader: TAG_FRAG, side: THREE.DoubleSide });
  let tagRT = null;
  function renderField(w, h) {
    if (!fieldRT || fieldRT.width !== w || fieldRT.height !== h) {
      if (fieldRT) fieldRT.dispose();
      fieldRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    }
    return renderLayer(fieldRT, FIELD_LAYER, fieldMat);
  }
  function renderTags(w, h) {
    // half float is plenty for the 0..2 tag values; the depth channel only has to MATCH within 2 % (+5 cm)
    if (!tagRT || tagRT.width !== w || tagRT.height !== h) {
      if (tagRT) tagRT.dispose();
      tagRT = new THREE.WebGLRenderTarget(w, h, { type: floatOk ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    }
    return renderLayer(tagRT, TAG_LAYER, tagMat);
  }
  function renderLayer(rt, layer, mat) {
    const prevTarget = renderer.getRenderTarget(), prevOverride = scene.overrideMaterial, prevAuto = renderer.autoClear, prevBg = scene.background;
    renderer.getClearColor(_clear); const prevAlpha = renderer.getClearAlpha();
    _layers.mask = camera.layers.mask;
    try {
      camera.layers.set(layer);
      scene.overrideMaterial = mat; scene.background = null;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = _layers.mask;
      scene.overrideMaterial = prevOverride; scene.background = prevBg;
      renderer.setRenderTarget(prevTarget); renderer.setClearColor(_clear, prevAlpha); renderer.autoClear = prevAuto;
    }
    return rt.texture;
  }

  // ── the COST line (lead 11-03): GPU timer where the browser has one, else the frame-time delta over 120 frames ──
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let q = null, qPending = false, qSum = 0, qN = 0, costSaid = false;
  let frameSum = 0, frameN = 0, baseMs = 0, lastT = 0, onSum = 0, onN = 0;
  // ?inkcost=1 (opt-in, for the perf lap): an explicit A/B - 120 frames with the ink OFF, then 120 ON - the honest delta when the browser
  // has no GPU timer (the ink is briefly absent on purpose). Without it: the GPU timer, else the frame time vs the frames before the look.
  const abWanted = (() => { try { return new URLSearchParams(location.search).get('inkcost') === '1'; } catch (e) { return false; } })();
  let ab = null;   // { phase: 'off' | 'on', sum, n, off }
  const MAX_DT = 1000;   // a frame over 1 s is a tab switch / a load stall, never the ink
  function timeBegin() { if (!timerExt || qPending || costSaid) return false; q = q || gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q); return true; }
  function timeEnd(began) {
    if (began) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); qPending = true; }
    if (qPending && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      qPending = false;
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) { qSum += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; qN++; }
      if (qN >= 120 && !costSaid) {
        costSaid = true;
        console.log(`[ink] COST (${tierName()}): ${(qSum / qN).toFixed(2)} ms/frame on the GPU (ink${tierN >= 2 && fieldMeshes > 0 ? ' + the hatch field' : ''}, ${qN} frames, EXT_disjoint_timer_query)`);
      }
    }
  }
  const tierName = () => Object.keys(TIER).find(k => TIER[k] === tierN) || 'laptop';

  const baseRender = pass.render.bind(pass);
  pass.render = (r, writeBuffer, readBuffer, deltaTime, maskActive) => {
    const began = timeBegin();
    const u = pass.uniforms;
    u.tDepth.value = readBuffer.depthTexture || null;
    const fieldOn = tierN >= 2 && fieldMeshes > 0 && floatOk && !!readBuffer.depthTexture;
    u.tField.value = fieldOn ? renderField(readBuffer.width, readBuffer.height) : null;
    const tagsOn = tierN >= 1 && tagMeshes > 0 && !!readBuffer.depthTexture;   // lite stays cheap: no tag pass
    u.tTag.value = tagsOn ? renderTags(readBuffer.width, readBuffer.height) : null;
    u.uTagOn.value = tagsOn ? 1 : 0;
    // re-derived EVERY frame from the stored numbers: no depth yet = tint only (never a garbage line), and it comes back by itself
    const hasDepth = !!readBuffer.depthTexture;
    u.uTier.value.set(hasDepth ? tierN : -1, fieldOn ? 1 : 0, 0, 0);
    u.uEdge.value.w = hasDepth ? edgeStrength : 0;
    baseRender(r, writeBuffer, readBuffer, deltaTime, maskActive);
    timeEnd(began);
  };

  /** The worn look's render block (an "ink" row); null / not ink / baked = off. */
  function set(row, tierNameIn, styleId, opts = {}) {
    const on = !!(row && row.on && String(row.mode || '').toLowerCase() === 'ink' && row.ink && !opts.baked);
    const k = (row && row.ink) || {};
    tierN = TIER[tierNameIn] ?? 1;
    fieldMeshes = opts.fieldMeshes ?? fieldMeshes;
    tagMeshes = opts.tagMeshes ?? tagMeshes;
    const line = `${on}|${styleId}|${tierNameIn}|${fieldMeshes}|${tagMeshes}`;
    const changed = line !== said;   // the viewer re-applies the same look on a load: only a real change restarts the cost measure
    if (changed) {
      said = line;
      console.log(!on ? `[ink] off${opts.baked ? ` - the file is BAKED ('${styleId}'): its textures already wear the look` : ''}`
        : `[ink] '${styleId}' drawn live · tier ${tierNameIn}: hand-tint ✓ · outline ✓ · strokes ${tierN >= 1 ? '✓' : '- (lite: tint + outline only)'} · ` +
          `hatch field ${tierN >= 2 ? (fieldMeshes > 0 ? (floatOk ? `✓ (${fieldMeshes} mesh(es))` : '- (no float render targets: world fallback)') : '- (this file carries none: world fallback)') : '-'} · ` +
          `node tags ${tagMeshes > 0 ? (tierN >= 1 ? `✓ (${tagMeshes} mesh(es): lg_glow / lg_accent / lg_hatch_scale)` : '- (lite)') : '-'} · ` +
          `GAPS vs the app: no grass marker (noisy normals stand down), no ground marker (up-facing surfaces fade ${n(k.groundNear, 5)}-${n(k.groundFar, 20)} m), no crease lines`);
    }
    if (!on) { pass.enabled = false; ab = null; return { ink: false }; }
    if (!inserted) { post.composer.insertPass(pass, 1); inserted = true; }   // right after the scene render (its depth), before the clamp + bloom
    ensureDepth();
    const u = pass.uniforms;
    u.uLine.value.set(n(k.lineNearPx, 2.5), n(k.lineFalloff, 0.35), n(k.lineMinPx, 0.8), Math.max(n(k.lineMinPx, 0.8), n(k.lineMaxPx, 4)));
    edgeStrength = n(k.outlineStrength, 1);
    u.uEdge.value.set(n(k.depthThreshold, 0.015), 0.9, 0, edgeStrength);
    u.uHatch.value.set(n(k.hatchDensity, 1), Math.max(2, n(k.hatchPeriodPx, 6)), n(k.hatchThickness, 0.45), n(k.hatchStrength, 0.9));
    u.uPaper.value.set(n(k.grain, 0.06), n(k.fibre, 0.05), n(k.keepLocal, 0.66), 0);
    u.uAccent.value.set(n(k.accentHue, 0.965), n(k.accentRange, 0.07), n(k.accentMinSat, 0.35), n(k.accentStrength, 1));
    u.uTint.value.set(n(k.mutedSat, 0.58), n(k.sage, 0.25), n(k.stoneWarm, 0.35), 1);
    const gInk = n(k.groundInk, 1);
    u.uGround.value.set(n(k.groundNear, 5), Math.max(n(k.groundNear, 5) + 0.01, n(k.groundFar, 20)), gInk, gInk < 0.999 ? 1 : 0);
    u.uGlow.value.set(Math.max(0.01, n(k.glowHdr, 1.5)), n(k.windowGlow, 0), 0, 1);
    u.uInk.value.copy(srgb(k.ink, [0.08, 0.065, 0.055]));
    u.uPaperCol.value.copy(srgb(k.paper, [0.96, 0.90, 0.78]));
    if (!changed && (pass.enabled || ab)) return { ink: true };
    costSaid = false; qSum = 0; qN = 0; onSum = 0; onN = 0;
    if (abWanted) { ab = { phase: 'off', sum: 0, n: 0, off: 0 }; pass.enabled = false; console.log('[ink] COST A/B (?inkcost=1): 120 frames with the ink OFF, then 120 ON - hold the view still'); return { ink: true }; }
    pass.enabled = true;
    return { ink: true };
  }

  /** Every frame (cheap when off: the frame-time baseline for the no-timer cost line). */
  function update(width, height, night = 0) {
    const t = performance.now(), dt = lastT ? t - lastT : 0; lastT = t;
    if (ab) {
      if (dt > 0 && dt < MAX_DT) { ab.sum += dt; ab.n++; }
      if (ab.n >= 120) {
        if (ab.phase === 'off') { ab.off = ab.sum / ab.n; ab.phase = 'on'; ab.sum = 0; ab.n = 0; pass.enabled = true; }
        else {
          const on = ab.sum / ab.n;
          console.log(`[ink] COST A/B (${tierName()}): frame ${ab.off.toFixed(2)} ms with the ink OFF · ${on.toFixed(2)} ms ON · Δ ${(on - ab.off).toFixed(2)} ms (120 + 120 frames)`);
          ab = null; costSaid = true;
        }
      }
      if (!pass.enabled) return;
    } else if (!pass.enabled) {
      if (dt > 0 && dt < MAX_DT) { frameSum += dt; frameN++; if (frameN >= 120) { baseMs = frameSum / frameN; frameSum = 0; frameN = 0; } }
      return;
    }
    if (!timerExt && !costSaid && !ab && dt > 0 && dt < MAX_DT) {
      onSum += dt; onN++;
      if (onN >= 120) {
        costSaid = true;
        console.log(`[ink] COST (${tierName()}): frame ${(onSum / onN).toFixed(2)} ms with the ink${baseMs > 0 ? ` vs ${baseMs.toFixed(2)} ms before (Δ ${(onSum / onN - baseMs).toFixed(2)} ms)` : ' (no baseline yet)'} - 120-frame average, no GPU timer in this browser`);
      }
    }
    const u = pass.uniforms;
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    u.uP11.value = camera.projectionMatrix.elements[5];
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    u.uRes.value.set(width, height);
    u.uNight.value = night || 0;
  }

  return { set, update, get enabled() { return pass.enabled; }, pass, setFieldMeshes(c) { fieldMeshes = c; }, setTagMeshes(c) { tagMeshes = c; } };
}
