// Thalyn® World Viewer — the snow globe (A13681).
//
// A world opened as a globe: a circular crop of the world on a turned wooden plinth under a glass dome, with
// snow inside. Shake it (drag-jiggle, the Shake button, or shake the phone) and the snow lifts; when the globe
// carries a message, some of the flakes gather into its letters, hold, and fall again. Nothing here glows:
// the glass, the plinth and the snow are lit by the world's own sun and sky.
//
// Pieces: makeClip (the crop, as N clipping planes shared by every world material) · makeGlobe (plinth, cut
// wall, glass, snow, message, shake input). Sizes are one table, GLOBE; the flake count is the tier's
// globeFlakes column (TIERS in thalyn-atmos.js).
import * as THREE from 'three';

export const GLOBE = {
  clipPlanes: 24,        // the crop is a 24-sided prism circumscribing the circle (≤ 0.9 % off round)
  wallSegs: 96,          // the cut wall + plinth lathe segments
  gridN: 32,             // the snow's ground height grid (gridN² downward probes, sampled a few per frame)
  gridPerFrame: 48,
  stirDecayS: 6,         // a full stir dies away over this long
  slotStir: 0.6,         // a shake must reach this to bring the message
  swirlS: 0.9,           // after a shake, the flakes fly this long before the message starts to gather
  gatherS: 2.6,
  holdS: 4,
  slotsMax: 1600,        // at most this many flakes make the letters (and never more than 55 % of the snow)
  shakeAccel: 13,        // phone: m/s² of motion (gravity removed) that counts as a shake
  shakeCooldownS: 1.1,
  jiggleTurns: 3,        // desktop: this many quick reversals of a drag within jiggleWindowS
  jiggleWindowS: 0.7,
  jiggleSpeed: 900,      // px/s a drag must be moving for a reversal to count
};

// ── The crop: N planes, shared by every world material (one recompile when adopted; moved by constant only) ──
export function makeClip(n = GLOBE.clipPlanes) {
  const planes = [];
  for (let i = 0; i < n; i++) planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9));
  const adopted = new WeakSet();
  return {
    planes, n,
    /** Keep only what lies inside the prism circumscribing the circle (cx, cz, R). */
    set(cx, cz, R) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        planes[i].normal.set(-c, 0, -s);                // inward
        planes[i].constant = cx * c + cz * s + R;       // n·p + constant ≥ 0 inside
      }
    },
    /** No crop: every plane faces up with an enormous constant (no recompile). */
    open() { for (const p of planes) { p.normal.set(0, 1, 0); p.constant = 1e9; } },
    adopt(root) {
      let k = 0;
      root.traverse(o => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!m || adopted.has(m) || m.isShaderMaterial) continue;
          m.clippingPlanes = planes; m.needsUpdate = true; adopted.add(m); k++;
        }
      });
      return k;
    },
  };
}

// ── The globe ────────────────────────────────────────────────────────────────
// opts.surfaceAt(x, z) → the top surface (ground or water) or null. opts.front = the unit XZ direction the plinth
// faces (the reader). Returns { group, build, setBudget, setMessage, shake, tilt, tick, dispose, … }.
export function makeGlobe(opts) {
  const { scene, camera, renderer } = opts;
  const group = new THREE.Group(); group.name = 'Thalyn_Globe'; group.visible = false;
  scene.add(group);
  let built = null;       // { cx, cz, baseY, R, Rw, H, Rg, cy, front }
  let flakes = null, budget = 3000;
  let stir = 0, stirPeak = 0, msgPhase = 'idle', msgT = 0, msgCells = null, onMessage = null;
  const tiltV = new THREE.Vector2();
  let grid = null, gridIdx = 0, gridMin = 0;
  const disposables = [];

  // Height of the snow's floor at (x, z): the grid (filled a few probes per frame), else the lowest rim height.
  function floorAt(x, z) {
    if (!grid) return gridMin;
    const b = built, N = GLOBE.gridN;
    const u = ((x - b.cx) / b.Rw * 0.5 + 0.5) * (N - 1), v = ((z - b.cz) / b.Rw * 0.5 + 0.5) * (N - 1);
    const i = Math.max(0, Math.min(N - 1, Math.round(u))), j = Math.max(0, Math.min(N - 1, Math.round(v)));
    const h = grid[j * N + i];
    return Number.isFinite(h) ? h : gridMin;
  }
  function yTopAt(r) { const b = built; return b.cy + Math.sqrt(Math.max(0, b.Rg * b.Rg - r * r)) * 0.96; }

  /** b = { center: Vector3 (cx, ground base, cz), R, topY, front: Vector3 } — builds plinth, wall, glass, snow. */
  function build(b) {
    clearMeshes();
    const n = GLOBE.clipPlanes, Rw = b.R / Math.cos(Math.PI / n) * 1.002;
    const cx = b.center.x, cz = b.center.z;
    // The cut wall's top follows the surface on the rim; the plinth top sits just under its lowest point.
    const segs = GLOBE.wallSegs, rim = new Float32Array(segs + 1);
    let lo = Infinity;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const h = opts.surfaceAt(cx + Math.cos(a) * Rw * 0.995, cz + Math.sin(a) * Rw * 0.995);
      rim[i] = (h === null || !Number.isFinite(h)) ? NaN : h;
      if (Number.isFinite(rim[i])) lo = Math.min(lo, rim[i]);
    }
    if (!Number.isFinite(lo)) lo = b.center.y;
    const baseY = Math.min(lo, b.center.y) - Math.max(0.5, b.R * 0.04);
    for (let i = 0; i <= segs; i++) if (!Number.isFinite(rim[i])) rim[i] = lo;
    const H = Math.max(b.R * 0.25, (b.topY - baseY) * 1.08);
    const c = H * 0.45, Rg = Math.sqrt(Rw * Rw + (H - c) * (H - c)) * 1.03, cy = baseY + c;
    const r0 = Math.sqrt(Math.max(1e-6, Rg * Rg - c * c));
    const front = (b.front && b.front.lengthSq() > 1e-6 ? b.front.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1));
    built = { cx, cz, baseY, R: b.R, Rw, H, Rg, cy, r0, front, frontYaw: Math.atan2(front.x, front.z) };
    gridMin = lo;

    // Wall: a ring from the plinth top up to the rim surface, earth banded by height, a snow lip on top.
    {
      const pos = [], col = [], idx = [];
      const earthA = new THREE.Color(0x4a3526), earthB = new THREE.Color(0x6b5038), stone = new THREE.Color(0x5d5a52), snow = new THREE.Color(0xe9eef2);
      const ROWS = 6, tmp = new THREE.Color();
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2, x = cx + Math.cos(a) * Rw, z = cz + Math.sin(a) * Rw;
        for (let r = 0; r <= ROWS; r++) {
          const k = r / ROWS, y = baseY + (rim[i] - baseY) * k;
          pos.push(x, y, z);
          const band = 0.5 + 0.5 * Math.sin(y / Math.max(0.5, H * 0.06) + Math.sin(a * 5) * 0.6);
          tmp.copy(earthA).lerp(earthB, band).lerp(stone, k < 0.35 ? (0.35 - k) * 1.6 : 0);
          if (r === ROWS) tmp.copy(snow);
          col.push(tmp.r, tmp.g, tmp.b);
        }
      }
      for (let i = 0; i < segs; i++) for (let r = 0; r < ROWS; r++) {
        const a = i * (ROWS + 1) + r, bq = (i + 1) * (ROWS + 1) + r;
        idx.push(a, a + 1, bq, bq, a + 1, bq + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
      const wall = new THREE.Mesh(g, m); wall.receiveShadow = true; wall.name = 'Globe_Wall';
      group.add(wall); disposables.push(g, m);
    }

    // Plinth: one turned (lathe) profile in warm wood, the grain as vertex-colour rings. Not emissive.
    const ph = Math.max(Rg * 0.34, 1);
    const prof = [[0, 0], [r0 * 0.985, 0], [r0 * 1.03, -0.02], [r0 * 1.07, -0.06], [r0 * 1.08, -0.12], [r0 * 1.10, -0.16],
                  [r0 * 1.10, -0.74], [r0 * 1.15, -0.80], [r0 * 1.21, -0.88], [r0 * 1.23, -0.97], [r0 * 1.21, -1.0], [0, -1.0]]
      .map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), baseY + y * ph));
    {
      const g = new THREE.LatheGeometry(prof, segs);
      const p = g.attributes.position, colArr = new Float32Array(p.count * 3);
      const wa = new THREE.Color(0x2e1a0e), wb = new THREE.Color(0x4a2c17), t = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
        const ring = 0.5 + 0.5 * Math.sin((y - baseY) / ph * 46 + Math.sin(a * 3) * 1.4 + Math.sin(a * 11) * 0.3);
        t.copy(wa).lerp(wb, ring * ring);
        colArr[i * 3] = t.r; colArr[i * 3 + 1] = t.g; colArr[i * 3 + 2] = t.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, envMapIntensity: 0.35 });
      const plinth = new THREE.Mesh(g, m); plinth.position.set(cx, 0, cz); plinth.castShadow = true; plinth.receiveShadow = true; plinth.name = 'Globe_Plinth';
      group.add(plinth); disposables.push(g, m);
    }
    built.plinth = { radius: r0 * 1.10, yTop: baseY - 0.16 * ph, yBottom: baseY - 0.74 * ph, height: ph };

    // Glass: lit, fresnel-weighted alpha (more glass at the rim, almost none face-on). No transmission pass.
    {
      const thetaLen = Math.acos(Math.max(-1, Math.min(1, -c / Rg)));
      const g = new THREE.SphereGeometry(Rg, 96, 64, 0, Math.PI * 2, 0, thetaLen);
      const m = new THREE.MeshPhysicalMaterial({ color: 0xf2f7fb, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.035,
        depthWrite: false, side: THREE.FrontSide, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 });
      m.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n  { float fr = pow(1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0), 3.0);\n    gl_FragColor.a = clamp(opacity + fr * 0.5, 0.0, 0.62); }');
      };
      const glass = new THREE.Mesh(g, m); glass.position.set(cx, cy, cz); glass.renderOrder = 20; glass.name = 'Globe_Glass';
      group.add(glass); disposables.push(g, m);
      built.glass = glass;
    }

    // The snow floor grid starts empty (rim height) and fills a few probes per frame.
    grid = new Float32Array(GLOBE.gridN * GLOBE.gridN).fill(NaN); gridIdx = 0;
    makeFlakes();
    group.visible = true;
    console.info(`[thalyn-globe] built: crop R ${b.R.toFixed(1)} m · glass ${Rg.toFixed(1)} m · plinth ${ph.toFixed(1)} m · ${budget} flake(s)`);
    return built;
  }

  // ── Snow: one Points draw, simulated on the CPU (positions written into one buffer per frame) ──
  function makeFlakes() {
    if (flakes) { group.remove(flakes.points); flakes.geo.dispose(); flakes.mat.dispose(); flakes = null; }
    if (!built) return;
    const n = budget, b = built;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), size = new Float32Array(n), slot = new Float32Array(n);
    const seed = new Float32Array(n), settled = new Uint8Array(n), target = new Float32Array(n * 3), tslot = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(Math.random()) * b.Rw * 0.95, a = Math.random() * Math.PI * 2;
      const x = b.cx + Math.cos(a) * r, z = b.cz + Math.sin(a) * r;
      const top = yTopAt(r), fl = floorAt(x, z);
      pos[i * 3] = x; pos[i * 3 + 1] = fl + Math.random() * Math.max(1, top - fl); pos[i * 3 + 2] = z;
      size[i] = 0.55 + Math.random() * 0.9;
      seed[i] = Math.random();
    }
    // A shuffled order: the first k of it make the message (so the letter flakes are spread through the snow).
    const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
    for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uFlake: { value: b.Rg * 0.0065 }, uLight: { value: new THREE.Color(0.8, 0.82, 0.86) } },
      vertexShader: `attribute float aSize; attribute float aSlot; uniform float uScale; uniform float uFlake; varying float vSlot;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vSlot = aSlot;
          gl_PointSize = clamp(uFlake * aSize * (1.0 + 0.35 * aSlot) * uScale / max(0.001, -mv.z), 1.0, 24.0); }`,
      fragmentShader: `uniform vec3 uLight; varying float vSlot;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard;
          float a = smoothstep(0.25, 0.06, r); gl_FragColor = vec4(min(uLight * (1.0 + 0.12 * vSlot), vec3(0.9)), a * 0.92); }`,
      transparent: true, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 10; points.name = 'Globe_Snow';
    group.add(points);
    flakes = { n, pos, vel, size, slot, seed, settled, target, tslot, order, geo, mat, points, nSlots: 0 };
  }

  // ── The message: Cinzel on a canvas → lit cells → flake targets on a plane facing the camera ──
  let msgText = '', msgFont = 'Georgia, serif';
  function setMessage(text, fontFamily, cb) { msgText = String(text || ''); if (fontFamily) msgFont = fontFamily; onMessage = cb || null; msgCells = null; }
  function wrap(text, maxChars) {
    const words = text.split(' '), lines = []; let cur = '';
    for (const w of words) {
      if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 4);
  }
  function rasterise() {
    if (!msgText) return null;
    const lines = wrap(msgText, msgText.length > 40 ? 22 : 18), px = 44, lh = px * 1.18;
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    cx.font = `600 ${px}px ${msgFont}`;
    const w = Math.ceil(Math.max(...lines.map(l => cx.measureText(l).width)) + px * 0.5), h = Math.ceil(lines.length * lh + px * 0.3);
    cv.width = w; cv.height = h;
    cx.font = `600 ${px}px ${msgFont}`; cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    lines.forEach((l, i) => cx.fillText(l, w / 2, px * 0.15 + lh * (i + 0.5)));
    const data = cx.getImageData(0, 0, w, h).data;
    const want = Math.min(GLOBE.slotsMax, Math.floor((flakes ? flakes.n : 0) * 0.55));
    for (let cell = 2; cell <= 12; cell++) {      // the finest grid whose lit cells fit the flakes we have
      const out = [];
      for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
        let s = 0, k = 0;
        for (let yy = y; yy < Math.min(h, y + cell); yy++) for (let xx = x; xx < Math.min(w, x + cell); xx++) { s += data[(yy * w + xx) * 4 + 3]; k++; }
        if (s / k > 110) out.push((x + cell / 2) / w - 0.5, 0.5 - (y + cell / 2) / h);
      }
      if (out.length / 2 <= want) return { cells: out, aspect: h / w };
    }
    return null;
  }
  function placeTargets() {
    const b = built, f = flakes;
    if (!msgCells) msgCells = rasterise();
    if (!msgCells || !f) { f && (f.nSlots = 0); return false; }
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let W = b.Rw * 1.45, Hh = W * msgCells.aspect;
    const room = (yTopAt(W * 0.5) - b.baseY) * 0.62;
    if (Hh > room) { W *= room / Hh; Hh = room; }
    const midY = Math.min(yTopAt(W * 0.5) - Hh * 0.6, Math.max(gridMin + Hh * 0.75, b.baseY + b.H * 0.55));
    const k = msgCells.cells.length / 2;
    f.nSlots = k;
    for (let s = 0; s < f.n; s++) f.tslot[s] = -1;
    for (let s = 0; s < k; s++) {
      const i = f.order[s], u = msgCells.cells[s * 2], v = msgCells.cells[s * 2 + 1];
      f.tslot[i] = s;
      f.target[i * 3] = b.cx + right.x * u * W; f.target[i * 3 + 1] = midY + v * Hh; f.target[i * 3 + 2] = b.cz + right.z * u * W;
    }
    return true;
  }

  // flurry = the snow falling as the globe opens: it lifts the snow but never brings the message (only a shake does).
  function shake(strength = 1, flurry = false) {
    if (!flakes) return;
    stir = flurry ? Math.max(stir, 0.5 * strength) : Math.min(1, Math.max(stir, 0.55) + 0.45 * strength); stirPeak = Math.max(stirPeak, stir);
    if (!flurry && msgText && msgPhase === 'idle' && stir >= GLOBE.slotStir) { msgPhase = 'swirl'; msgT = 0; }
  }
  function tilt(x, z) { tiltV.set(x, z); }

  // ── Input: drag-jiggle on the canvas (desktop + touch drag), devicemotion (phones) ──
  let lastMove = null, reversals = [], lastSx = 0, lastSy = 0, active = false;
  function onPointerMove(e) {
    if (!active || !(e.buttons & 1) && e.pointerType === 'mouse') { lastMove = null; return; }
    const t = performance.now();
    if (lastMove) {
      const dt = Math.max(1, t - lastMove.t) / 1000, vx = (e.clientX - lastMove.x) / dt, vy = (e.clientY - lastMove.y) / dt;
      const sx = Math.abs(vx) > GLOBE.jiggleSpeed ? Math.sign(vx) : 0, sy = Math.abs(vy) > GLOBE.jiggleSpeed ? Math.sign(vy) : 0;
      if ((sx && lastSx && sx !== lastSx) || (sy && lastSy && sy !== lastSy)) reversals.push(t);
      if (sx) lastSx = sx; if (sy) lastSy = sy;
      reversals = reversals.filter(r => t - r < GLOBE.jiggleWindowS * 1000);
      if (reversals.length >= GLOBE.jiggleTurns) { reversals.length = 0; fireShake('drag'); }
    }
    lastMove = { x: e.clientX, y: e.clientY, t };
  }
  let lastShakeT = 0, lastG = null;
  function fireShake(how, mag) {
    const t = performance.now();
    if (t - lastShakeT < GLOBE.shakeCooldownS * 1000) { shake(0.4); return; }
    lastShakeT = t; shake(1);
    console.info('[thalyn-globe] shake (' + how + (mag ? ' ' + mag.toFixed(1) + ' m/s²' : '') + ') → stir ' + stir.toFixed(2) + (msgText ? ' · the message gathers' : ''));
    opts.onShake && opts.onShake(how);
  }
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function onMotion(e) {
    if (!active) return;
    const a = e.acceleration, g = e.accelerationIncludingGravity;
    let mag = 0;
    if (a && a.x !== null) mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    else if (g && g.x !== null && lastG) mag = Math.hypot(g.x - lastG.x, g.y - lastG.y, g.z - lastG.z);
    if (g && g.x !== null) {
      lastG = { x: g.x, y: g.y, z: g.z };
      const s = isIOS ? -1 : 1;   // iOS reports the opposite sign to Android
      tilt(Math.max(-1, Math.min(1, -s * g.x / 9.8)), Math.max(-1, Math.min(1, s * g.y / 9.8 - 0.55)));
    }
    if (mag > GLOBE.shakeAccel) fireShake('motion', mag);
  }
  function setActive(on) {
    active = !!on;
    if (on) { addEventListener('pointermove', onPointerMove); addEventListener('devicemotion', onMotion); }
    else { removeEventListener('pointermove', onPointerMove); removeEventListener('devicemotion', onMotion); tiltV.set(0, 0); }
  }

  // ── The frame ──
  const _f = new THREE.Vector3(), _db = new THREE.Vector2();
  function tick(dt, light) {
    if (!built || !flakes || !group.visible) return;
    const b = built, f = flakes, N = GLOBE.gridN;
    // Fill the floor grid a few probes per frame.
    if (gridIdx < N * N) {
      for (let k = 0; k < GLOBE.gridPerFrame && gridIdx < N * N; k++, gridIdx++) {
        const i = gridIdx % N, j = (gridIdx / N) | 0;
        const x = b.cx + ((i / (N - 1)) * 2 - 1) * b.Rw, z = b.cz + ((j / (N - 1)) * 2 - 1) * b.Rw;
        const h = Math.hypot(x - b.cx, z - b.cz) <= b.Rw * 1.02 ? opts.surfaceAt(x, z) : null;
        grid[gridIdx] = (h === null || !Number.isFinite(h)) ? NaN : h;
      }
    }
    if (light) f.mat.uniforms.uLight.value.copy(light);
    f.mat.uniforms.uScale.value = renderer.getDrawingBufferSize(_db).y * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    stir = Math.max(0, stir - dt / GLOBE.stirDecayS);
    if (stir === 0) stirPeak = 0;
    // The message's clock.
    if (msgPhase !== 'idle') {
      msgT += dt;
      if (msgPhase === 'swirl' && msgT > GLOBE.swirlS) { msgPhase = placeTargets() ? 'gather' : 'idle'; msgT = 0; }
      else if (msgPhase === 'gather' && msgT > GLOBE.gatherS) { msgPhase = 'hold'; msgT = 0; onMessage && onMessage(true); console.info('[thalyn-globe] message formed in the snow (' + f.nSlots + ' flakes)'); }
      else if (msgPhase === 'hold' && msgT > GLOBE.holdS) { msgPhase = 'idle'; msgT = 0; onMessage && onMessage(false);
        for (let s = 0; s < f.n; s++) if (f.tslot[s] >= 0) { f.tslot[s] = -1; f.slot[s] = 0; f.settled[s] = 0; f.vel[s * 3 + 1] = -b.Rg * 0.02; }
        f.geo.attributes.aSlot.needsUpdate = true; }
    }
    const gathering = msgPhase === 'gather' || msgPhase === 'hold';
    const Rg = b.Rg, t = performance.now() / 1000, k = Math.min(1, dt * 1.6), kg = Math.min(1, dt * (msgPhase === 'hold' ? 6 : 2.2));
    const swirl = stir * Rg * 0.42, lift = stir * Rg * 0.30, tx = tiltV.x * Rg * 0.10, tz = tiltV.y * Rg * 0.10;
    camera.getWorldDirection(_f); _f.y = 0; if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1); _f.normalize();
    const rx = -_f.z, rz = _f.x;   // screen-right on the ground plane: the phone's tilt drifts the snow on screen axes
    const driftX = rx * tx - _f.x * tz, driftZ = rz * tx - _f.z * tz;
    const P = f.pos, V = f.vel;
    let slotDirty = false;
    for (let i = 0; i < f.n; i++) {
      const i3 = i * 3;
      if (gathering && f.tslot[i] >= 0) {
        P[i3] += (f.target[i3] - P[i3]) * kg; P[i3 + 1] += (f.target[i3 + 1] - P[i3 + 1]) * kg; P[i3 + 2] += (f.target[i3 + 2] - P[i3 + 2]) * kg;
        if (f.slot[i] < 1) { f.slot[i] = 1; slotDirty = true; }
        f.settled[i] = 0; continue;
      }
      const sd = f.seed[i];
      if (f.settled[i]) {
        if (stir > 0.2 && Math.random() < stir * dt * 4) {
          f.settled[i] = 0; V[i3 + 1] = lift * (0.4 + sd); V[i3] = (Math.random() - 0.5) * swirl; V[i3 + 2] = (Math.random() - 0.5) * swirl;
        } else if (stir === 0 && Math.random() < dt * 0.006) {   // a light flurry that never quite stops
          const r = Math.sqrt(Math.random()) * b.Rw * 0.9, a = Math.random() * Math.PI * 2;
          P[i3] = b.cx + Math.cos(a) * r; P[i3 + 2] = b.cz + Math.sin(a) * r; P[i3 + 1] = yTopAt(r) * 0.98 + b.cy * 0.02;
          f.settled[i] = 0; V[i3] = V[i3 + 1] = V[i3 + 2] = 0;
        } else continue;
      }
      const dx = P[i3] - b.cx, dz = P[i3 + 2] - b.cz, r = Math.hypot(dx, dz) || 1e-3, rn = r / b.Rw;
      const vt = Rg * (0.07 + 0.06 * sd);
      const wob = Rg * 0.012;
      const txv = (-dz / r) * swirl * (0.6 + sd * 0.8) + Math.sin(t * (0.7 + sd) + sd * 40) * wob + driftX;
      const tzv = (dx / r) * swirl * (0.6 + sd * 0.8) + Math.cos(t * (0.6 + sd) + sd * 23) * wob + driftZ;
      const tyv = -vt + lift * (1 - 2 * rn) * (0.5 + sd);
      V[i3] += (txv - V[i3]) * k; V[i3 + 1] += (tyv - V[i3 + 1]) * k; V[i3 + 2] += (tzv - V[i3 + 2]) * k;
      P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
      // Inside the glass: the crop's wall, the dome, the floor.
      const ndx = P[i3] - b.cx, ndz = P[i3 + 2] - b.cz, nr = Math.hypot(ndx, ndz), lim = b.Rw * 0.97;
      if (nr > lim) { P[i3] = b.cx + ndx / nr * lim; P[i3 + 2] = b.cz + ndz / nr * lim; V[i3] *= -0.3; V[i3 + 2] *= -0.3; }
      const top = yTopAt(Math.min(nr, lim));
      if (P[i3 + 1] > top) { P[i3 + 1] = top; V[i3 + 1] = -Math.abs(V[i3 + 1]) * 0.3; }
      const fl = floorAt(P[i3], P[i3 + 2]) + Rg * 0.002;
      if (P[i3 + 1] < fl) {
        P[i3 + 1] = fl;
        if (stir < 0.2) { f.settled[i] = 1; V[i3] = V[i3 + 1] = V[i3 + 2] = 0; }
        else V[i3 + 1] = Math.abs(V[i3 + 1]) * 0.5;
      }
      if (f.slot[i] > 0) { f.slot[i] = 0; slotDirty = true; }
    }
    f.geo.attributes.position.needsUpdate = true;
    if (slotDirty) f.geo.attributes.aSlot.needsUpdate = true;
  }

  function setBudget(n) {
    const v = Math.max(200, Math.min(12000, (n | 0) || 3000));
    if (v === budget) return; budget = v;
    if (built) { makeFlakes(); msgCells = null; msgPhase = 'idle'; }
  }
  function clearMeshes() {
    for (const c of [...group.children]) group.remove(c);
    for (const d of disposables) d.dispose(); disposables.length = 0;
    if (flakes) { flakes.geo.dispose(); flakes.mat.dispose(); flakes = null; }
  }
  /** Fade the glass + snow (0..1) — the doorway: the camera flies through as they go. */
  function setFade(a) {
    if (built && built.glass) built.glass.material.opacity = 0.035 * a;
    if (flakes) flakes.points.visible = a > 0.02;
  }
  function dispose() { setActive(false); clearMeshes(); built = null; group.visible = false; msgPhase = 'idle'; onMessage && onMessage(false); }

  return {
    group, build, setBudget, setMessage, shake, tilt, tick, setActive, setFade, dispose,
    get built() { return built; }, get stir() { return stir; }, get phase() { return msgPhase; }, get flakeCount() { return flakes ? flakes.n : 0; },
  };
}
