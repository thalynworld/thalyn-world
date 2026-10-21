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

  /** Take over a water mesh's material (the one thalyn-atmos upgradeLiquid made): flat, ripples, the shared mirror. */
  function adopt(mesh) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = mats[0]; if (!mat) return false;
    const uOn = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uWTime: uTime, uMirror, uTexMat, uMirrorOn: uOn, uPlaneY, uRipple: { value: ripple } });
      shader.vertexShader = 'uniform mat4 uTexMat;\nvarying vec4 vMirrorCoord;\nvarying vec3 vWorldPosW;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vec4 _wp = modelMatrix * vec4(transformed, 1.0);
        vWorldPosW = _wp.xyz;
        vMirrorCoord = uTexMat * _wp;`);
      shader.fragmentShader = 'uniform float uWTime;\nuniform sampler2D uMirror;\nuniform float uMirrorOn;\nuniform float uPlaneY;\nuniform sampler2D uRipple;\nvarying vec4 vMirrorCoord;\nvarying vec3 vWorldPosW;\n' + shader.fragmentShader;
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
        #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'thalyn-water-a1232';
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
  }

  /** The export's water rectangles (extras.thalyn.liquids, APP frame: X negated — the same read as makeWaterProbe). The
   *  sea ring is left out: it never takes the mirror. Absent (a non-Thalyn glb) ⇒ each water mesh's own box. */
  function setLiquids(liquids) {
    rects = [];
    for (const l of (liquids || [])) {
      if (!l || l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
      if (/Horizon|Infinite|Sea|Ocean/i.test(l.name || '')) continue;
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
    if (rt) { rt.dispose(); rt = null; uMirror.value = null; }
  }

  return { adopt, setLiquids, setBudget, update, clear, get count() { return surfaces.length; }, get active() { return active; } };
}
