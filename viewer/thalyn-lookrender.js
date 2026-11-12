// thalyn-lookrender.js — ★ R1e · THE RENDER LAYER OF A LOOK, in the browser (2026-11-02, LOOK ENGINE; parity with Thalyn Final's
// ThalynLookRenderFeature + Hidden/Thalyn/LookRender). ONE set of numbers drives both: the look row's "render" block in
// looks/LookPalettes.json (a verbatim copy of the game's Resources/LookPalettes.json). The laws are the game shader's, line for line:
//   GRADE   gated saturation · value · value posterize in a tone-mapped space · contrast about 0.18 · lift · warm · vignette · screen grain
//   FLATTEN Kuwahara (the calmest of four quadrants) + screen-fixed brush noise                         (laptop/desktop tiers)
//   TOON    lit frame × clamp(toon(lit) / smooth(lit)), N·L from normals RECONSTRUCTED FROM DEPTH, the live sun (no shadow term here)
//   OUTLINE silhouettes from the depth second difference (a sloped plane draws nothing)                  (laptop/desktop tiers)
// Tiers map as the game's: phone = LOW (grade only) · laptop = MEDIUM · desktop = HIGH (the viewer has no normals buffer, so no creases).
// A look in "ink" mode (Looking-Glass) is not drawn here yet (the viewer has no ink port) — identity, said once.
// No look / natural = the pass is disabled = the viewer exactly as before. The depth it reads is the composer's first target's own
// (attached once, the first time a look needs it) — no second scene render.

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = `
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth;
uniform float cameraNear, cameraFar; uniform mat4 uProjInv; uniform vec2 uRes; uniform vec3 uSunView;
uniform vec4 uGradeA, uGradeB, uGradeC, uLineA, uLineB, uLineC, uLineColor, uFlags, uFlatten, uToonA, uToonB, uToonC, uToonD;
varying vec2 vUv;

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y); }
float rawDepth(vec2 uv){ return texture2D(tDepth, uv).x; }
float eyeDepth(vec2 uv){ return -perspectiveDepthToViewZ(rawDepth(uv), cameraNear, cameraFar); }
vec3 viewPos(vec2 uv){ float d = rawDepth(uv); vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }

vec3 flatten(vec2 uv, vec3 centre){
  vec2 px = uFlatten.x / uRes; int n = int(uFlatten.y);
  vec3 bestMean = centre; float bestVar = 1e9;
  for (int q = 0; q < 4; q++) {
    vec2 dir = vec2((q == 1 || q == 3) ? 1.0 : -1.0, (q >= 2) ? 1.0 : -1.0);
    vec3 sum = vec3(0.0), sum2 = vec3(0.0); float cnt = 0.0;
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) {
      if (a >= n || b >= n) continue;
      vec2 o = dir * vec2(float(a), float(b)) / max(float(n) - 1.0, 1.0);
      vec3 c = texture2D(tDiffuse, uv + o * px).rgb; c = c / (1.0 + c);
      sum += c; sum2 += c * c; cnt += 1.0;
    }
    vec3 m = sum / cnt; vec3 v3 = sum2 / cnt - m * m; float v = v3.r + v3.g + v3.b;
    if (v < bestVar) { bestVar = v; bestMean = m; }
  }
  return bestMean / max(1.0 - bestMean, 1e-3);
}

vec3 grade(vec3 col, vec2 uv){
  if (uFlatten.x > 0.5) col = flatten(uv, col);
  if (uFlatten.z > 0.0) col *= 1.0 + (vnoise(uv * uRes / uFlatten.w) - 0.5) * uFlatten.z;
  float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
  float s = (mx - mn) / max(mx, 1e-4);
  float gate = smoothstep(uGradeA.y, uGradeA.z, s);
  float satMul = mix(1.0, uGradeA.x, uGradeA.x >= 1.0 ? gate : 1.0);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(l + (col - l) * satMul, 0.0) * uGradeA.w;
  if (uGradeB.x >= 2.0) {
    float v = max(col.r, max(col.g, col.b)); float vt = v / (1.0 + v);
    float q = (floor(vt * uGradeB.x) + 0.5) / uGradeB.x; float vq = q / max(1.0 - q, 1e-3);
    col *= mix(1.0, vq / max(v, 1e-4), uGradeB.y);
  }
  col = max((col - 0.18) * uGradeB.z + 0.18, 0.0) + uGradeB.w;
  col *= vec3(1.0 + uGradeC.x, 1.0, 1.0 - uGradeC.x);
  vec2 q2 = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= 1.0 - uGradeC.y * smoothstep(0.35, 1.05, length(q2));
  col *= 1.0 + (hash21(uv * uRes) - 0.5) * uGradeC.z;
  return max(col, 0.0);
}

float band(float ndl){
  if (uToonC.z > 0.5) return clamp((ndl + uToonC.y) / (1.0 + uToonC.y), 0.0, 1.0);
  float s = max(uToonA.w, 1e-3); float b = uToonA.x;
  b += (uToonA.y - uToonA.x) * smoothstep(uToonB.x - s, uToonB.x + s, ndl);
  b += (uToonA.z - uToonA.y) * smoothstep(uToonB.y - s, uToonB.y + s, ndl);
  return b;
}

vec3 toon(vec3 col, vec2 uv){
  vec2 px = 1.0 / uRes; vec3 p = viewPos(uv);
  vec3 pl = viewPos(uv - vec2(px.x, 0.0)), pr = viewPos(uv + vec2(px.x, 0.0));
  vec3 pd = viewPos(uv - vec2(0.0, px.y)), pu = viewPos(uv + vec2(0.0, px.y));
  vec3 dx = dot(pr - p, pr - p) < dot(p - pl, p - pl) ? pr - p : p - pl;
  vec3 dy = dot(pu - p, pu - p) < dot(p - pd, p - pd) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy)); if (dot(n, -p) < 0.0) n = -n;     // view space: the camera at the origin
  float ndl = dot(n, uSunView);
  float amb = uToonB.z, lit = clamp(ndl, 0.0, 1.0);                     // no shadow term in the viewer (the game multiplies its shadow here)
  float sm = amb + (1.0 - amb) * lit, tn = amb + (1.0 - amb) * band(ndl);
  float r = clamp(tn / max(sm, 1e-3), min(1.0, uToonD.x), max(1.0, uToonD.y));
  r = 1.0 + (r - 1.0) * clamp(uToonB.w, 0.0, 1.0);
  col *= r;
  if (uToonC.x > 0.0) { vec3 v = normalize(-p); float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0) * clamp(ndl + 0.3, 0.0, 1.0); col *= 1.0 + rim * uToonC.x; }
  return col;
}

float outline(vec2 uv, float depth){
  float wPx = clamp(uLineA.x * pow(5.0 / max(depth, 0.5), uLineA.y), uLineA.z, uLineA.w);
  vec2 o = wPx / uRes;
  float dl = eyeDepth(uv - vec2(o.x, 0.0)), dr = eyeDepth(uv + vec2(o.x, 0.0));
  float du = eyeDepth(uv + vec2(0.0, o.y)), dd = eyeDepth(uv - vec2(0.0, o.y));
  float e2 = max(abs(dl + dr - 2.0 * depth), abs(du + dd - 2.0 * depth)) / depth;
  float edge = smoothstep(uLineB.x, uLineB.x * 2.0, e2);
  // BUSYNESS STAND-DOWN: on a ring of 8 taps at 2.5 line widths, count the depth steps. A real silhouette has them on ONE side (about
  // half); leaf-card clutter has them scattered all round. Where the count is high, the line stands down (uLineC.x = how much, 0 = off).
  if (uLineC.x > 0.0 && edge > 0.0) {
    float steps = 0.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.785398;
      float dk = eyeDepth(uv + vec2(cos(a), sin(a)) * o * 2.5);
      steps += step(uLineB.x * 4.0, abs(dk - depth) / depth);
    }
    edge *= 1.0 - uLineC.x * smoothstep(3.5, 6.5, steps);
  }
  // DISTANCE FADE (uLineC.y = metres where the line is gone, 0 = off): from half that distance
  if (uLineC.y > 0.0) edge *= 1.0 - smoothstep(uLineC.y * 0.5, uLineC.y, depth);
  return edge * uLineB.w;
}

void main(){
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 col = src.rgb;
  float raw = rawDepth(vUv);
  bool sky = raw >= 1.0 - 1e-6;                 // the baked sky dome writes no depth
  if (uFlags.w > 0.5 && !sky) col = toon(col, vUv);   // the game runs the toon BEFORE the grade (after the skybox)
  if (uFlags.z > 0.5) col = grade(col, vUv);
  if (uFlags.x > 0.5 && !sky) col = mix(col, uLineColor.rgb, clamp(outline(vUv, eyeDepth(vUv)), 0.0, 1.0));
  gl_FragColor = vec4(col, src.a);
}`;

// ── the plan (LookRenderPlan.Decide, ported) ──────────────────────────────────────────────────────────────────────────────
const TIER = { lite: 0, laptop: 1, high: 2 };
const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const c01 = v => Math.min(1, Math.max(0, v));

export function decide(row, tierName) {
  const t = TIER[tierName] ?? 1, g = (row && row.grade) || {}, o = (row && row.outline) || {}, tn = (row && row.toon) || {};
  const d = { enqueue: false, grade: false, outline: false, toon: false, ink: false };
  if (!row || !row.on) return d;
  if (String(row.mode || '').toLowerCase() === 'ink') { d.ink = true; return d; }
  const identity = Math.abs(n(g.sat, 1) - 1) < 1e-4 && Math.abs(n(g.val, 1) - 1) < 1e-4 && (n(g.levels, 0) < 2 || n(g.pmix, 0) <= 0)
    && Math.abs(n(g.contrast, 1) - 1) < 1e-4 && Math.abs(n(g.lift, 0)) < 1e-5 && Math.abs(n(g.warm, 0)) < 1e-5 && n(g.vignette, 0) <= 0
    && n(g.grain, 0) <= 0 && n(g.blur, 0) <= 0 && n(g.brush, 0) <= 0;
  d.grade = !identity;
  d.outline = n(o.px, 0) > 0 && n(o.soft, 1) > 0 && t >= 1;
  d.toon = !!tn.on && n(tn.strength, 1) > 0 && t >= 1;
  d.enqueue = d.grade || d.outline || d.toon;
  return d;
}

export function makeLookRender(post, camera) {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
      uProjInv: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2(1, 1) }, uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uGradeA: { value: new THREE.Vector4(1, 0.12, 0.35, 1) }, uGradeB: { value: new THREE.Vector4(0, 0, 1, 0) }, uGradeC: { value: new THREE.Vector4() },
      uLineA: { value: new THREE.Vector4(0, 0.35, 0.8, 4) }, uLineB: { value: new THREE.Vector4(0.015, 0.55, 60, 0) }, uLineC: { value: new THREE.Vector4(0, 0, 0, 0) }, uLineColor: { value: new THREE.Vector4(0.02, 0.02, 0.025, 1) },
      uFlags: { value: new THREE.Vector4() }, uFlatten: { value: new THREE.Vector4(0, 2, 0, 6) },
      uToonA: { value: new THREE.Vector4(1, 1, 1, 0.02) }, uToonB: { value: new THREE.Vector4(0, 0.5, 0.35, 0) }, uToonC: { value: new THREE.Vector4() }, uToonD: { value: new THREE.Vector4(1, 1, 0, 0) },
    },
    vertexShader: VERT, fragmentShader: FRAG,
  });
  pass.enabled = false;
  let inserted = false, said = '';
  const _v = new THREE.Vector3();

  // The composer SWAPS its two targets on every swapping pass, so the target the RenderPass draws into alternates frame to frame.
  // Both get a depth texture, and this pass runs RIGHT AFTER the RenderPass: its readBuffer IS the scene (colour + depth) this frame.
  let depthOn = false;
  function ensureDepth() {
    if (depthOn) return;
    depthOn = true;
    for (const rt of [post.composer.renderTarget1, post.composer.renderTarget2]) {
      if (rt.depthTexture) continue;
      rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
      rt.depthTexture.type = THREE.UnsignedIntType;
      rt.dispose();                              // rebuilt with the depth attachment on the next render
    }
  }
  const baseRender = pass.render.bind(pass);
  pass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
    pass.uniforms.tDepth.value = readBuffer.depthTexture || null;
    if (!readBuffer.depthTexture) pass.uniforms.uFlags.value.x = pass.uniforms.uFlags.value.w = 0;   // no depth yet: grade only, never a garbage outline
    baseRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  };

  /** Set the worn look's render block (null / natural = off). tierName = the viewer tier ('lite' | 'laptop' | 'high'). */
  function set(row, tierName, styleId) {
    const d = decide(row, tierName);
    const u = pass.uniforms, g = (row && row.grade) || {}, o = (row && row.outline) || {}, tn = (row && row.toon) || {}, t = TIER[tierName] ?? 1;
    const line = `${styleId || 'natural'}|${JSON.stringify(d)}|${tierName}`;
    if (line !== said) {
      said = line;
      console.log(d.ink ? `[lookrender] '${styleId}': ink mode - not drawn in this viewer yet (identity)`
        : !d.enqueue ? `[lookrender] '${styleId || 'natural'}': nothing (natural / no render block)`
        : `[lookrender] '${styleId}': grade ${d.grade ? '✓' : '-'} · outline ${d.outline ? '✓' : '-'} · toon ${d.toon ? '✓ (normals from depth, no shadow term)' : '-'} · tier ${tierName}`);
    }
    if (!d.enqueue) { pass.enabled = false; return d; }
    if (!inserted) { post.composer.insertPass(pass, 1); inserted = true; }   // right after the scene render (its depth), before the NaN clamp + bloom
    if (d.outline || d.toon) ensureDepth();
    u.uGradeA.value.set(n(g.sat, 1), n(g.satGateLo, 0.12), Math.max(n(g.satGateLo, 0.12) + 1e-3, n(g.satGateHi, 0.35)), n(g.val, 1));
    u.uGradeB.value.set(n(g.levels, 0) >= 2 ? n(g.levels, 0) : 0, c01(n(g.pmix, 0)), n(g.contrast, 1), n(g.lift, 0));
    u.uGradeC.value.set(n(g.warm, 0), c01(n(g.vignette, 0)), c01(n(g.grain, 0)), 0);
    u.uFlatten.value.set(t >= 1 ? Math.min(8, Math.max(0, n(g.blur, 0))) : 0, t === 2 ? 4 : 2, c01(n(g.brush, 0)), Math.max(1, n(g.brushScale, 6)));
    u.uLineA.value.set(Math.max(0, n(o.px, 0)), n(o.falloff, 0.35), n(o.minPx, 0.8), Math.max(n(o.minPx, 0.8), n(o.maxPx, 4)));
    u.uLineB.value.set(n(o.depthThreshold, 0.015), n(o.normalThreshold, 0.55), Math.max(1, n(o.normalFadeM, 60)), c01(n(o.soft, 1)));
    u.uLineC.value.set(c01(n(o.busy, 0)), Math.max(0, n(o.fadeM, 0)), 0, 0);
    const oc = Array.isArray(o.color) && o.color.length >= 3 ? o.color : [0.02, 0.02, 0.025];
    u.uLineColor.value.set(oc[0], oc[1], oc[2], 1);
    const soft = Math.max(1e-3, n(tn.soft, 0.02)), e0 = n(tn.e0, -0.05);
    u.uToonA.value.set(n(tn.L0, 0.40), n(tn.L1, 0.74), n(tn.L2, 1), soft);
    u.uToonB.value.set(e0, Math.max(e0 + 1e-3, n(tn.e1, 0.45)), c01(n(tn.amb, 0.35)), c01(n(tn.strength, 1)));
    u.uToonC.value.set(Math.max(0, n(tn.rim, 0)), c01(n(tn.wrap, 0.45)), String(tn.ramp || 'bands').toLowerCase() === 'wrap' ? 1 : 0, 0);
    u.uToonD.value.set(Math.min(1, n(tn.ratioMin, 0.5)), Math.max(1, n(tn.ratioMax, 1.8)), 0, 0);
    u.uFlags.value.set(d.outline ? 1 : 0, 0, d.grade ? 1 : 0, d.toon ? 1 : 0);
    pass.enabled = true;
    return d;
  }

  /** Per frame, before the composer renders: the camera's matrices + the sun (world direction toward the sun). */
  function update(sunDirWorld, width, height) {
    if (!pass.enabled) return;
    const u = pass.uniforms;
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uRes.value.set(width, height);
    _v.copy(sunDirWorld).transformDirection(camera.matrixWorldInverse);
    u.uSunView.value.copy(_v);
  }

  return { set, update, get enabled() { return pass.enabled; }, pass };
}
