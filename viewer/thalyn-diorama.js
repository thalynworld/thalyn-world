// thalyn-diorama.js — ★ THE DIORAMA OPENING (LOOK ENGINE boost, 2026-11-02; founder: "a world on a table", the glTF share's opening shot).
//
// The shared world first appears as a MODEL ON A TABLE, then you dive in. Port of the round-7 miniature recipe
// (D:\_GltfTest\style_variants\out7\REPORT.md, scripts\r7_miniature.py / r7_textures.py):
//   · THE CUT BASE (the star): Thalyn's straight scene edge becomes a block. Its four cut sides carry the strata (turf lip, topsoil with
//     roots, ochre clay, sand, grey rock with pebbles), and their TOP FOLLOWS THE REAL TERRAIN EDGE (a downward probe every few metres
//     along the perimeter), so the turf lip meets the grass;
//   · a black glossy PLINTH, a wooden TABLETOP, a PAINTED BACKDROP card (self-lit, so it reads as a print);
//   · TOY LIGHTING: a small warm table-lamp spot (crisp shadows) + a soft fill; the sky, the sea ring and the fog are put away while it shows;
//   · MACRO DoF: three's BokehPass focused on the model (the round-7 "focus follows the target"), so the table falls soft;
//   · DIVE IN: one button flies the camera down to the picture (extras.thalyn.camera) or the usual framing, the table fades,
//     and everything put away comes back exactly as it was.
// Everything is generated (canvas textures + plain geometry): no new files to download. Nothing here touches the world's own meshes.
// A world without a straight cut edge (a sky world of floating islands, a probe that misses) is not forced onto a table: open() says no.

import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';

// ── tiny seeded RNG (the same picture every visit) ─────────────────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ── textures (r7_textures.py, ported to canvas) ──────────────────────────────────────────────────────────────────────────
function strataTexture() {
  const W = 2048, H = 256, r = rng(7), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const wav = (u, f, a, ph) => a * Math.sin(u * f * 2 * Math.PI + ph) + a * 0.5 * Math.sin(u * f * 5.3 * 2 * Math.PI + ph * 2);
  const cols = [[0.33, 0.42, 0.18], [0.24, 0.16, 0.10], [0.58, 0.40, 0.22], [0.80, 0.70, 0.50], [0.50, 0.49, 0.47]];
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const b = [0, 0.06 + wav(u, 3, 0.006, 0.3), 0.30 + wav(u, 2, 0.02, 1.1), 0.55 + wav(u, 4, 0.02, 2.0), 0.66 + wav(u, 3, 0.015, 0.7), 1];
    for (let k = 0; k < 5; k++) {
      const [cr, cg, cb] = cols[k];
      g.fillStyle = `rgb(${cr * 255 | 0},${cg * 255 | 0},${cb * 255 | 0})`;
      g.fillRect(x, Math.floor(b[k] * H), 1, Math.ceil((b[k + 1] - b[k]) * H) + 1);
    }
  }
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const n = 1 + gauss(r) * 0.06; d[i] *= n; d[i + 1] *= n; d[i + 2] *= n; }
  g.putImageData(im, 0, 0);
  for (let i = 0; i < 1300; i++) {                     // pebbles in the rock + sand layers
    const x0 = r() * W, y0 = (0.6 + r() * 0.4) * H, rad = 1 + r() * 5, v = 80 + r() * 110 | 0;
    g.fillStyle = `rgb(${v},${v - 5},${v - 12})`; g.beginPath(); g.ellipse(x0, y0, rad, rad * 0.7, 0, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = 'rgb(150,120,80)'; g.lineWidth = 1;
  for (let i = 0; i < 450; i++) {                      // roots in the topsoil
    const x0 = r() * W, y0 = (0.06 + r() * 0.19) * H;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + (r() - 0.5) * 30, y0 + 5 + r() * 20); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

function woodTexture() {
  const S = 1024, r = rng(11), c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d'), im = g.createImageData(S, S), d = im.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // fine, straight-ish grain with a slow wander (a planed board), low contrast — a table, never dunes
    const w = Math.sin((x * 0.11) + Math.sin(y * 0.004) * 1.2 + Math.sin(y * 0.017) * 0.25) * 0.5 + 0.5;
    const k = 0.90 + 0.10 * Math.pow(w, 4) + (r() - 0.5) * 0.04, i = (y * S + x) * 4;
    d[i] = 0.42 * 255 * k; d[i + 1] = 0.28 * 255 * k; d[i + 2] = 0.16 * 255 * k; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

function backdropTexture() {
  const W = 2048, H = 768, r = rng(3), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#6f97c4'); sky.addColorStop(0.62, '#b9cde0'); sky.addColorStop(1, '#ead9bd');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  g.filter = 'blur(6px)';                                // painted cumulus
  for (let k = 0; k < 9; k++) {
    const cx = r() * W, cy = H * (0.18 + r() * 0.35), s = 60 + r() * 90;
    for (let j = 0; j < 7; j++) {
      const ox = (r() - 0.5) * s * 2.4, oy = (r() - 0.5) * s * 0.6, rad = s * (0.5 + r() * 0.6), shade = 228 + r() * 25 | 0;
      g.fillStyle = `rgba(${shade},${shade - 3},${shade - 8},0.75)`; g.beginPath(); g.ellipse(cx + ox, cy + oy, rad, rad * 0.6, 0, 0, Math.PI * 2); g.fill();
    }
  }
  g.filter = 'none';
  const im = g.getImageData(0, 0, W, H), d = im.data;  // canvas tooth
  for (let i = 0; i < d.length; i += 4) { const n = 1 + gauss(r) * 0.025; d[i] *= n; d[i + 1] *= n; d[i + 2] *= n; }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── the base: four strata walls whose top follows the terrain edge ───────────────────────────────────────────────────────
function perimeter(box, inset) {
  const x0 = box.min.x + inset, x1 = box.max.x - inset, z0 = box.min.z + inset, z1 = box.max.z - inset;
  return [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
}

function buildWalls(box, groundAt, tex) {
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z);
  const inset = span * 0.0015;
  const step = Math.max(2, span / 400);
  const tops = [], pts = [], edges = [];
  let hits = 0, total = 0;
  for (const [ax, az, bx, bz] of perimeter(box, inset)) {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(8, Math.ceil(len / step));
    const e = { n, hit: 0, runs: [] }; edges.push(e); let runStart = -1;
    for (let i = 0; i < n; i++) {                         // the corner sample belongs to the next edge
      const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const y = groundAt(x, z, box.max.y + 50);
      const ok = y !== null && Number.isFinite(y);
      total++; if (ok) { hits++; e.hit++; }
      if (!ok && runStart < 0) runStart = i;
      if ((ok || i === n - 1) && runStart >= 0) { e.runs.push(`${(runStart / n * 100).toFixed(0)}-${((ok ? i : n) / n * 100).toFixed(0)}%`); runStart = -1; }
      pts.push([x, z]); tops.push(y);
    }
  }
  const edgeText = edges.map((e, k) => `edge${k} ${(e.hit / e.n * 100).toFixed(0)}%${e.runs.length ? ' miss ' + e.runs.slice(0, 4).join(',') : ''}`).join(' · ');
  // A ground world: every cut side is mostly ground (a floating-island world's square edge is mostly AIR — its islands sit inside), and the
  // probe's misses are holes along a real edge (measured on a Serene export: 69-93 % per side, the edge flat at the terrain's rim).
  const minEdge = Math.min(...edges.map(e => e.hit / e.n));
  if (total === 0 || hits / total < 0.6 || minEdge < 0.5) return { ok: false, coverage: total ? hits / total : 0, edgeText };
  // fill each miss by straight interpolation between the nearest real heights on either side — never a height from nowhere
  const okAt = i => tops[i] !== null && Number.isFinite(tops[i]);
  const filled = tops.slice(), N = tops.length;
  for (let i = 0; i < N; i++) if (!okAt(i)) {
    let a = 1; while (a < N && !okAt((i - a + N) % N)) a++;
    let b = 1; while (b < N && !okAt((i + b) % N)) b++;
    const ya = tops[(i - a + N) % N], yb = tops[(i + b) % N];
    filled[i] = ya + (yb - ya) * (a / (a + b));
  }
  for (let i = 0; i < N; i++) tops[i] = filled[i];
  const minTop = Math.min(...tops), depth = span * 0.16, bottom = minTop - depth;
  const n = pts.length, pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2), idx = [];
  let run = 0;
  const repeatLen = depth * 8;                             // the strata sheet is 8:1 — one sheet per 8 × depth of perimeter
  for (let i = 0; i <= n; i++) {
    const j = i % n, [x, z] = pts[j], y = tops[j];
    if (i > 0) { const [px, pz] = pts[i - 1]; run += Math.hypot(x - px, z - pz); }
    pos.set([x, y, z, x, bottom, z], i * 6);
    uv.set([run / repeatLen, 1, run / repeatLen, 0], i * 4);
    if (i < n) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide, transparent: true });
  const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'Diorama_Strata';
  return { ok: true, mesh, bottom, depth, span, coverage: hits / total, edgeText };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function makeDiorama({ scene, camera, renderer, controls, post, worldRoot, lights }) {
  let root = null, saved = null, bokeh = null, active = false, diving = null, ui = null, lamp = null, fill = null;
  const fadeMats = [];

  const ROOM = new THREE.Color(0x2b231c);
  function putAway(box) {
    saved = {
      background: scene.background, fog: scene.fog, autoRotate: controls.autoRotate, autoRotateSpeed: controls.autoRotateSpeed,
      sky: lights && lights.sky ? lights.sky.visible : null, stars: lights && lights.stars ? lights.stars.visible : null,
      sun: lights && lights.sun ? lights.sun.intensity : null, hemi: lights && lights.hemi ? lights.hemi.intensity : null,
      hidden: [], clipped: [], localClipping: renderer.localClippingEnabled, exposure: renderer.toneMappingExposure,
    };
    scene.traverse(o => {
      // the sky dome (a sky is at infinity — not in a room)
      if (o.userData && o.userData.__skyDome && o.visible) { o.visible = false; saved.hidden.push(o); }
    });
    // the water: gltfpack MERGES every water surface (lake, ponds, river, the sea ring) into one mesh, so the sea cannot be hidden by name —
    // it is CLIPPED to the model's square instead: the lake and the river stay on the model, the sea around it goes
    const m = 0.002 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -(box.min.x + m)), new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.max.x - m),
                    new THREE.Plane(new THREE.Vector3(0, 0, 1), -(box.min.z + m)), new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z - m)];
    worldRoot.traverse(o => {
      if (!o.isMesh || !(o.userData.__liquid || /water/i.test(o.name || ''))) return;
      for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!mat || saved.clipped.some(c => c.mat === mat)) continue;
        saved.clipped.push({ mat, planes: mat.clippingPlanes }); mat.clippingPlanes = planes; mat.needsUpdate = true;
      }
    });
    renderer.localClippingEnabled = true;
    scene.background = ROOM;                                   // a dim room
    scene.fog = null;
    if (lights) {
      if (lights.sky) lights.sky.visible = false;
      if (lights.stars) lights.stars.visible = false;
      if (lights.sun) lights.sun.intensity = saved.sun * 0.35;  // the room's daylight, under the lamp
      if (lights.hemi) lights.hemi.intensity = saved.hemi * 0.5;
    }
  }

  function bringBack() {
    if (!saved) return;
    scene.background = saved.background; scene.fog = saved.fog;
    controls.autoRotate = saved.autoRotate; controls.autoRotateSpeed = saved.autoRotateSpeed;
    if (lights) {
      if (lights.sky && saved.sky !== null) lights.sky.visible = saved.sky;
      if (lights.stars && saved.stars !== null) lights.stars.visible = saved.stars;
      if (lights.sun && saved.sun !== null) lights.sun.intensity = saved.sun;
      if (lights.hemi && saved.hemi !== null) lights.hemi.intensity = saved.hemi;
    }
    for (const o of saved.hidden) o.visible = true;
    for (const c of saved.clipped) { c.mat.clippingPlanes = c.planes; c.mat.needsUpdate = true; }
    renderer.localClippingEnabled = saved.localClipping;
    renderer.toneMappingExposure = saved.exposure;
    saved = null;
  }

  function addUi(onDive) {
    ui = document.createElement('div');
    ui.id = 'diorama-ui';
    ui.style.cssText = 'position:fixed;left:50%;bottom:9vh;transform:translateX(-50%);z-index:30;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none;font-family:inherit';
    const cap = document.createElement('div');
    cap.textContent = 'A world on a table';
    cap.style.cssText = 'color:#f3e6c8;font-size:15px;letter-spacing:.12em;text-transform:uppercase;text-shadow:0 1px 6px rgba(0,0,0,.6)';
    const b = document.createElement('button');
    b.textContent = 'Dive in';
    b.style.cssText = 'pointer-events:auto;cursor:pointer;padding:12px 30px;border-radius:24px;border:1px solid rgba(230,190,110,.8);background:linear-gradient(180deg,rgba(60,44,22,.85),rgba(30,22,12,.9));color:#f6dfa8;font-size:17px;letter-spacing:.06em;box-shadow:0 4px 18px rgba(0,0,0,.45)';
    b.onclick = e => { e.stopPropagation(); onDive(); };
    ui.append(cap, b);
    document.body.appendChild(ui);
    const key = e => { if (e.key === 'Enter' && active && !diving) { e.preventDefault(); onDive(); } };
    window.addEventListener('keydown', key);
    ui._unkey = () => window.removeEventListener('keydown', key);
  }

  /** Put the loaded world on the table. box = the framing box (terrain + species, never liquids); groundAt = the walk probe.
   *  Returns false (and changes nothing) when the world has no straight cut edge to stand on a table. */
  function open(box, groundAt, opts = {}) {
    if (active || !box || box.isEmpty() || typeof groundAt !== 'function') return false;
    const walls = buildWalls(box, groundAt, strataTexture());
    if (!walls.ok) { console.info(`[diorama] skipped: only ${(walls.coverage * 100).toFixed(0)} % of the edge has ground under it (a sky world or no straight cut) - the world opens as before · ${walls.edgeText}`); return false; }
    root = new THREE.Group(); root.name = 'Thalyn_Diorama';
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3()), span = walls.span;
    root.add(walls.mesh); fadeMats.push(walls.mesh.material);
    // the plinth: black painted wood, glossy
    const pH = walls.depth * 0.22;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(size.x + span * 0.03, pH, size.z + span * 0.03),
      new THREE.MeshPhysicalMaterial({ color: 0x050505, roughness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.2, transparent: true }));
    plinth.position.set(center.x, walls.bottom - pH / 2, center.z); plinth.castShadow = true; plinth.receiveShadow = true;
    root.add(plinth); fadeMats.push(plinth.material);
    // the tabletop
    const wood = woodTexture(); wood.repeat.set(10, 10);
    const table = new THREE.Mesh(new THREE.CircleGeometry(span * 2.4, 96), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.45, transparent: true }));
    table.rotation.x = -Math.PI / 2; table.position.set(center.x, walls.bottom - pH, center.z); table.receiveShadow = true;
    root.add(table); fadeMats.push(table.material);
    // the painted backdrop card, curved, behind the model from the opening view
    const view = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);   // the camera stands on this side; the card faces it from the far side
    const R = span * 1.9, Hc = span * 1.0;
    const card = new THREE.Mesh(new THREE.CylinderGeometry(R, R, Hc, 64, 1, true, 0, Math.PI * 0.9),
      new THREE.MeshBasicMaterial({ map: backdropTexture(), side: THREE.BackSide, transparent: true, color: new THREE.Color(0.5, 0.48, 0.45) }));   // a print in a dim room, not a sky
    const yaw = Math.atan2(-view.x, -view.z);
    card.rotation.y = yaw - Math.PI * 0.45;              // three's cylinder: theta from +Z, x = sin θ — the arc's middle lands on the far side
    card.position.set(center.x, walls.bottom - pH + Hc / 2, center.z);
    root.add(card); fadeMats.push(card.material);
    // the table lamp: a small warm spot (crisp shadows) + a soft fill
    lamp = new THREE.SpotLight(new THREE.Color(1.0, 0.86, 0.66), 0, span * 6, Math.PI / 5, 0.45, 0);
    lamp.position.set(center.x + span * 0.15, box.max.y + span * 1.1, center.z - span * 0.75);   // over the visitor's shoulder (the opening view is +x −z)
    lamp.target.position.copy(center); lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048); lamp.shadow.camera.near = span * 0.2; lamp.shadow.camera.far = span * 4; lamp.shadow.bias = -0.0004;
    fill = new THREE.HemisphereLight(0xfff1dc, 0x3a2a1c, 0);
    root.add(lamp, lamp.target, fill);
    scene.add(root);
    putAway(box);
    lamp.intensity = 3.2 * (opts.lampScale || 1); lamp.decay = 0;   // decay 0: the lamp's strength does not depend on the world's size
    fill.intensity = 0.55;
    // the opening camera: three-quarter view, high, the whole model + some table
    const dist = (span * 0.62) / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const dir = view.clone().multiplyScalar(Math.cos(0.5)).add(new THREE.Vector3(0, Math.sin(0.5), 0)).normalize();
    const look = new THREE.Vector3(center.x, walls.bottom + walls.depth * 0.5, center.z);
    camera.position.copy(look).addScaledVector(dir, dist);
    controls.target.copy(look); controls.update();
    controls.autoRotate = !opts.reduceMotion; controls.autoRotateSpeed = 0.35;
    // macro DoF on the model: sharp at the model, the table and the card soft
    if (post && post.composer && !opts.noDof) {
      // the blur reaches its cap about one model-width from the focus: the model stays nearly sharp, the table and the card go soft
      bokeh = new BokehPass(scene, camera, { focus: dist, aperture: 0.009 / Math.max(1, span), maxblur: 0.009 });
      post.composer.insertPass(bokeh, 1);
    }
    active = true;
    addUi(() => dive(opts.onDive));
    console.info(`[diorama] the world is on the table: base ${size.x.toFixed(0)}×${size.z.toFixed(0)} m, cut ${walls.depth.toFixed(0)} m deep, edge probed ${(walls.coverage * 100).toFixed(0)} % (${walls.edgeText}) · DoF ${bokeh ? 'on' : 'off'} · press "Dive in"`);
    return true;
  }

  /** Fly down into the world and put the table away. arrive(pose?) lets the page finish (enter the picture / walk). */
  function dive(arrive) {
    if (!active || diving) return;
    if (ui) { ui._unkey && ui._unkey(); ui.remove(); ui = null; }
    const pose = arrive && arrive.pose ? arrive.pose() : null;   // { position, target } or null = the page's own framing after close
    controls.autoRotate = false;
    diving = { t: 0, dur: 2.4, from: camera.position.clone(), fromT: controls.target.clone(), pose, arrive };
    console.info('[diorama] dive in');
  }

  function close() {
    if (!active) return;
    if (bokeh && post && post.composer) { post.composer.removePass(bokeh); bokeh.dispose && bokeh.dispose(); bokeh = null; }
    if (root) {
      scene.remove(root);
      root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      if (lamp && lamp.shadow && lamp.shadow.map) lamp.shadow.map.dispose();
      root = null;
    }
    fadeMats.length = 0;
    if (ui) { ui._unkey && ui._unkey(); ui.remove(); ui = null; }
    bringBack();
    active = false; diving = null;
  }

  function tick(dt) {
    if (!active) return;
    // the page's atmosphere passes (apply, weather) re-show the sky and re-fog: hold the room while the table shows
    if (scene.fog) scene.fog = null;
    if (scene.background !== ROOM) scene.background = ROOM;
    if (saved) for (const o of saved.hidden) if (o.visible) o.visible = false;
    if (lights && lights.sky && lights.sky.visible) lights.sky.visible = false;
    if (!diving) return;
    diving.t += dt;
    const k = Math.min(1, diving.t / diving.dur), e = k * k * (3 - 2 * k);
    const fade = Math.max(0, 1 - k / 0.55);
    for (const m of fadeMats) m.opacity = fade;
    if (lamp) lamp.intensity = 3.2 * fade;
    if (bokeh) bokeh.uniforms['maxblur'].value = 0.009 * fade;
    if (diving.pose) {
      camera.position.lerpVectors(diving.from, diving.pose.position, e);
      controls.target.lerpVectors(diving.fromT, diving.pose.target, e);
    } else {
      camera.position.lerpVectors(diving.from, diving.fromT, e * 0.55);   // no picture: sink toward the model; the page frames after
    }
    controls.update();
    if (k >= 1) {
      const arrive = diving.arrive;
      close();
      console.info('[diorama] arrived - the world as it was, the table put away');
      if (arrive && arrive.done) arrive.done();
    }
  }

  return { open, dive, close, tick, get active() { return active; }, get diving() { return !!diving; } };
}
