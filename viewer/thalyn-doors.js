// ★ A5403 · DOORS YOU CAN OPEN — glTF web parity slice I2 (2026-10-10, founder: "if we can open and close doors then yes please —
// the E key flies people right now in the web browser but in the Thalyn app it opens the doors").
//
// The export (Unity A5402) takes every door leaf OUT of World_web / World_web_lite / Interiors_NNN_web and packs the leaves, names
// kept (gltfpack -kn), into ONE small file beside them — its name is extras.thalyn.doorsWeb.file. Each door row (extras.thalyn.doors[]
// for the shell, interiors.buildings[].doors[] for the partitions) carries { glbNode, motion, hinge, axis, openDeg, nowDeg, nowT,
// pairNode, follower, staged, bothWays, foldChild, slide } in the glTF frame (X negated). This module loads that file, finds each
// leaf by NAME (fallback: the mesh whose world AABB centre lies within 0.15 m of the row's centre with extents within 10 %), hangs it
// on a pivot at its hinge, and swings it like the game (DoorLeaf.cs: 95° eased 0.8 s, reach 2.5 m, facing dot > 0.35, a pair together,
// a Dutch top first, the leaf blocks under 50°).
//
//   E (walking)   toggles the door you face within reach — and does NOT fly (makeWalk asks use() first). No door ⇒ E flies as before.
//   click / tap   on a leaf toggles it (phones have no E).
//   block()       a CLOSED leaf stops the walker (3 chest rays, slide — the blockAt contract), outdoors AND indoors; past 50° it passes.
// Rows the file does not answer keep A5401's walk-through (the indoor probe still skips their boxes) — an old export never traps anyone.
//
// THE MIRROR (one constant): the export writes Unity's AngleAxis(sign·deg, axisUnity) with the axis X-negated. Reflecting X turns a
// rotation by θ about a into a rotation by −θ about Ma, so the swing is setFromAxisAngle(axisGltf, SWING_SIGN · deg) with SWING_SIGN −1.
// Proof on ONE door: a leaf the game opens OUTWARD must open outward here; if it swings into the wall, flip SWING_SIGN (and only it).
//
// Console proof lines:
//   [thalyn-doors] N door(s) from extras · file <name>                       (adopt)
//   [thalyn-doors] N door(s) from extras · M matched (K by name, J by box) · U unclaimed node(s) hidden · <ms> ms   (file loaded)
//   [thalyn-doors] opened '<id>' (E|click|tap) · closed '<id>' (…)
//   [thalyn-doors] '<id>' <motion> — left still (rides its leaf / not a swing)
import * as THREE from 'three';

export const SWING_SIGN = -1;
export const DOOR_DEFAULTS = { doorReachM: 2.5, doorFacingDot: 0.35, doorSwingS: 0.8, doorBlockBelowDeg: 50, doorRadiusM: 0.35, doorChestM: 1.2, doorRaySpreadDeg: 25, doorMatchM: 0.15, doorMatchExt: 0.10, doorClickM: 6 };

// The game's cubic ease (DoorLeaf.Ease — never Mathf.SmoothStep).
export function ease(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

const num3 = a => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => typeof v === 'number' && isFinite(v));

// Every door row that carries swing data → a clean list. Pure (no three.js): { key, id, building, node, motion, hinge, axis, openDeg,
// nowDeg, nowT, pairNode, follower, staged, bothWays, foldChild, slide, center, extents, kind }.
export function readDoorRows(tx) {
  const out = [];
  if (!tx || typeof tx !== 'object') return out;
  const take = (d, kind, building) => {
    if (!d || typeof d.glbNode !== 'string' || !d.glbNode || typeof d.motion !== 'string') return;
    out.push({
      key: d.glbNode, id: d.id != null && d.id !== '' ? String(d.id) : d.glbNode, building: String(building || d.building || ''), node: d.glbNode,
      motion: d.motion, hinge: num3(d.hinge) ? d.hinge.slice(0, 3) : [0, 0, 0], axis: num3(d.axis) ? d.axis.slice(0, 3) : [0, 1, 0],
      openDeg: +d.openDeg || 0, nowDeg: +d.nowDeg || 0, nowT: Math.min(1, Math.max(0, +d.nowT || 0)),
      pairNode: typeof d.pairNode === 'string' ? d.pairNode : '', follower: !!d.follower, staged: !!d.staged, bothWays: !!d.bothWays,
      foldChild: !!d.foldChild, slide: num3(d.slide) ? d.slide.slice(0, 3) : null,
      center: num3(d.center) ? d.center.slice(0, 3) : null, extents: num3(d.extents) ? d.extents.slice(0, 3).map(Math.abs) : null, kind,
    });
  };
  if (Array.isArray(tx.doors)) for (const d of tx.doors) take(d, 'shell', d && d.building);
  const b = tx.interiors && Array.isArray(tx.interiors.buildings) ? tx.interiors.buildings : [];
  for (const bd of b) if (bd && Array.isArray(bd.doors)) for (const d of bd.doors) take(d, 'interior', bd.building);
  return out;
}

// Name first, then the AABB fallback. `nodes` = [{ name, center:[x,y,z], extents:[hx,hy,hz], ref }] (world, glTF frame). Pure.
// Returns Map(rowKey → { ref, by: 'name'|'box' }); a node is claimed at most once.
export function matchRows(rows, nodes, k = DOOR_DEFAULTS) {
  const byName = new Map();
  for (const n of nodes) if (n.name && !byName.has(n.name)) byName.set(n.name, n);
  const claimed = new Set(), out = new Map();
  for (const r of rows) { const n = byName.get(r.node); if (n && !claimed.has(n)) { claimed.add(n); out.set(r.key, { ref: n.ref, by: 'name' }); } }
  for (const r of rows) {
    if (out.has(r.key) || !r.center || !r.extents) continue;
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      if (claimed.has(n) || !n.center || !n.extents) continue;
      const d = Math.hypot(n.center[0] - r.center[0], n.center[1] - r.center[1], n.center[2] - r.center[2]);
      if (d > k.doorMatchM || d >= bestD) continue;
      let ok = true;
      for (let i = 0; i < 3; i++) { const a = r.extents[i], b = n.extents[i]; if (Math.abs(a - b) > Math.max(0.01, k.doorMatchExt * Math.max(a, b))) { ok = false; break; } }
      if (ok) { best = n; bestD = d; }
    }
    if (best) { claimed.add(best); out.set(r.key, { ref: best.ref, by: 'box' }); }
  }
  return out;
}

// The door the walker answers: within reach and roughly faced (DoorLeaf.Update). Pure. `doors` = [{ center:{x,y,z} }], cam/fwd plain.
export function pickDoor(doors, cam, fwd, k = DOOR_DEFAULTS) {
  let best = null, bestS = -Infinity;
  for (const d of doors) {
    const dx = d.center.x - cam.x, dy = d.center.y - cam.y, dz = d.center.z - cam.z, dist = Math.hypot(dx, dy, dz);
    if (dist > k.doorReachM || dist < 1e-4) continue;
    const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist;
    if (dot < k.doorFacingDot) continue;
    const s = dot - dist / k.doorReachM * 0.5;   // facing it most, nearest second
    if (s > bestS) { bestS = s; best = d; }
  }
  return best;
}

// The game's toggle (DoorLeaf.SetOpen / Update E): a Dutch top opens alone, its bottom on the next press, then both shut; a pair follows.
export function toggleDoor(d) {
  const p = d.partner;
  if (d.staged && p && d.open && !p.open) { p.open = true; return [p]; }
  const o = !d.open; d.open = o;
  const moved = [d];
  if (p && !(d.staged && o) && p.open !== o) { p.open = o; moved.push(p); }
  return moved;
}

export function makeDoors(opts = {}) {
  const scene = opts.scene, camera = opts.camera;
  const root = new THREE.Group(); root.name = 'Thalyn_Doors';
  if (scene) scene.add(root);
  let source = null, rows = [], file = '', epoch = 0, loaded = null, knobs = { ...DOOR_DEFAULTS };
  let doors = [], leaders = [], blockers = [], meshes = [];
  const liveNodes = new Set();
  let nextHint = 0, hintFor = null;
  const ray = new THREE.Raycaster();
  const _q = new THREE.Quaternion(), _ax = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(),
        _nm = new THREE.Matrix3(), _fwd = new THREE.Vector3(), _box = new THREE.Box3(), _c = new THREE.Vector3(), _s = new THREE.Vector3();

  function setBudget(t) { knobs = { ...DOOR_DEFAULTS }; if (t) for (const k of Object.keys(DOOR_DEFAULTS)) if (typeof t[k] === 'number') knobs[k] = t[k]; }
  function setSource(s) { source = s || null; }

  function clear() {
    epoch++;
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && m.dispose && m.dispose());
    });
    while (root.children.length) root.remove(root.children[0]);
    rows = []; file = ''; loaded = null; doors = []; leaders = []; blockers = []; meshes = []; liveNodes.clear(); hintFor = null;
  }

  function urlFor(name) {
    if (!source) return null;
    if (source.files) { const f = source.files.get(name); return f ? { url: URL.createObjectURL(f), blob: true } : null; }
    try { const m = new URL(source.url, location.href), r = new URL(name, m); r.search = m.search; return { url: r.href, blob: false }; } catch (e) { return null; }
  }

  // tx = the world's extras.thalyn. Returns the number of swinging rows (0 ⇒ nothing to load: the A5401 boxes rule alone).
  function adopt(tx) {
    clear();
    rows = readDoorRows(tx);
    const dw = tx && tx.doorsWeb;
    file = dw && typeof dw.file === 'string' ? dw.file : '';
    if (!rows.length || !file) { if (rows.length) console.warn(`[thalyn-doors] ${rows.length} door row(s) carry swing data but no doorsWeb.file — doors stay walk-through`); return 0; }
    console.info(`[thalyn-doors] ${rows.length} door(s) from extras · file ${file}`);
    const src = urlFor(file);
    if (!src) { console.warn(`[thalyn-doors] ${file} ${source && source.files ? 'was not among the dropped files (drop the whole folder)' : 'has no address'} — doors stay walk-through`); return rows.length; }
    const my = epoch, t0 = performance.now();
    const loader = opts.getLoader && opts.getLoader();
    if (!loader) return rows.length;
    loader.loadAsync(src.url).then(g => {
      if (src.blob) URL.revokeObjectURL(src.url);
      if (my !== epoch) { g.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); }); return; }
      rig(g.scene, t0);
    }).catch(e => { if (src.blob) URL.revokeObjectURL(src.url); console.warn(`[thalyn-doors] ${file} could not be loaded — the doors stay walk-through`, e); });
    return rows.length;
  }

  // The loaded file → pivots. Exposed for the node test (rigScene).
  function rig(sceneG, t0 = performance.now()) {
    sceneG.updateMatrixWorld(true);
    try { if (opts.prepare) opts.prepare(sceneG); } catch (e) { console.warn('[thalyn-doors] prepare failed (ignored)', e); }
    const nodes = [];
    sceneG.traverse(o => {
      if (o === sceneG) return;
      let has = false; o.traverse(c => { if (c.isMesh) has = true; });
      if (!has) return;
      _box.setFromObject(o); if (_box.isEmpty()) return;
      _box.getCenter(_c); _box.getSize(_s);
      nodes.push({ name: o.name || '', center: [_c.x, _c.y, _c.z], extents: [_s.x / 2, _s.y / 2, _s.z / 2], ref: o });
    });
    const m = matchRows(rows, nodes, knobs);
    root.add(sceneG);
    const byKey = new Map();
    let byName = 0, byBox = 0, still = 0;
    for (const r of rows) {
      const hit = m.get(r.key);
      if (!hit) continue;
      if (hit.by === 'name') byName++; else byBox++;
      const node = hit.ref;
      liveNodes.add(r.node);
      if (r.motion !== 'swing' && r.motion !== 'slide' && r.motion !== 'lift') {   // a bifold panel / a motion-less row: rides its parent, stays where it is
        still++; console.info(`[thalyn-doors] '${r.id}' ${r.motion} — left still (${r.foldChild ? 'rides its leaf, no fold' : 'not a swing'})`); continue;
      }
      // a leaf nested under another matched leaf rides it (the export writes only roots; a nested one is never pivoted twice)
      let nested = false; for (let p = node.parent; p && p !== sceneG; p = p.parent) for (const q of byKey.values()) if (q.node === p) nested = true;
      if (nested) { still++; continue; }
      const pivot = new THREE.Object3D(); pivot.name = 'DoorPivot_' + r.id;
      if (r.motion === 'swing') pivot.position.set(r.hinge[0], r.hinge[1], r.hinge[2]);
      root.add(pivot); pivot.updateMatrixWorld(true);
      pivot.attach(node);   // keeps the leaf's world pose: the file's node TRS never matters
      _box.setFromObject(node); _box.getCenter(_c);
      const d = { row: r, id: r.id, node, pivot, open: r.nowT > 0.5, t: r.nowT, center: _c.clone(), partner: null, staged: r.staged, follower: r.follower, meshes: [] };
      node.traverse(o => { if (o.isMesh) { d.meshes.push(o); meshes.push(o); o.userData.__door = d; } });
      _ax.set(r.axis[0], r.axis[1], r.axis[2]); if (_ax.lengthSq() < 1e-8) _ax.set(0, 1, 0); d.axis = _ax.clone().normalize();
      if (r.slide) d.slide = new THREE.Vector3(r.slide[0], r.slide[1], r.slide[2]);
      byKey.set(r.key, d); doors.push(d);
    }
    for (const d of doors) if (d.row.pairNode) { const p = byKey.get(d.row.pairNode); if (p && p !== d) { d.partner = p; if (!p.partner) p.partner = d; } }
    leaders = doors.filter(d => !d.follower || !d.partner);
    // what the file holds that no row claims: hidden (the export left that leaf merged in the world — never drawn twice)
    let hidden = 0;
    const claimedSet = new Set(); for (const d of doors) d.node.traverse(o => claimedSet.add(o));
    for (const r of rows) { const h = m.get(r.key); if (h) h.ref.traverse(o => claimedSet.add(o)); }
    sceneG.traverse(o => { if (o.isMesh && !claimedSet.has(o)) { o.visible = false; hidden++; } });
    for (const d of doors) apply(d);
    loaded = { matched: byName + byBox, byName, byBox, hidden, still };
    console.info(`[thalyn-doors] ${rows.length} door(s) from extras · ${byName + byBox} matched (${byName} by name, ${byBox} by box) · ${hidden} unclaimed node(s) hidden · ${(performance.now() - t0).toFixed(0)} ms`);
    if (opts.onReady) try { opts.onReady(loaded); } catch (e) {}
    return loaded;
  }

  function angleOf(d) { return d.row.openDeg * ease(d.t); }
  function blocking(d) {
    if (d.row.motion === 'swing') return Math.abs(angleOf(d)) < knobs.doorBlockBelowDeg;
    return ease(d.t) < 0.5;   // slide / lift: blocks until half-way (DoorLeaf.ApplyPose)
  }
  function apply(d) {
    if (d.row.motion === 'swing') {
      const deg = angleOf(d) - d.row.nowDeg;   // the file stands at nowDeg
      d.pivot.quaternion.setFromAxisAngle(d.axis, SWING_SIGN * THREE.MathUtils.degToRad(deg));
    } else if (d.slide) {
      d.pivot.position.copy(d.slide).multiplyScalar(ease(d.t) - d.row.nowT);
    }
    d.pivot.updateMatrixWorld(true);
  }

  function tick(dt) {
    if (!doors.length) return;
    const step = dt / Math.max(0.05, knobs.doorSwingS);
    for (const d of doors) {
      const target = d.open ? 1 : 0;
      if (d.t === target) continue;
      d.t = d.t < target ? Math.min(target, d.t + step) : Math.max(target, d.t - step);
      apply(d);
    }
    // the game's hint: "E opens it" / "E closes it" (a phone: tap)
    if (opts.isWalking && opts.isWalking() && opts.toast && camera) {
      const d = aimed();
      const now = performance.now();
      if (d && (d !== hintFor || now >= nextHint)) {
        hintFor = d; nextHint = now + 3000;
        const key = opts.touch ? 'Tap the door' : 'E';
        opts.toast(d.open ? `${key} ${opts.touch ? 'to close it' : 'closes it'}` : `${key} ${opts.touch ? 'to open it' : 'opens it'}`);
      } else if (!d) hintFor = null;
    }
  }

  function aimed() {
    if (!leaders.length || !camera) return null;
    camera.getWorldDirection(_fwd);
    const cand = [];
    for (const d of leaders) { cand.push({ center: d.center, d }); if (d.partner) cand.push({ center: d.partner.center, d }); }
    const hit = pickDoor(cand, camera.position, _fwd, knobs);
    return hit ? hit.d : null;
  }

  function say(moved, how) { for (const m of moved) console.info(`[thalyn-doors] ${m.open ? 'opened' : 'closed'} '${m.id}' (${how})`); }

  // E while walking: true = a door took the key (the walker must not fly).
  function use() {
    const d = aimed();
    if (!d) return false;
    say(toggleDoor(d), 'E');
    hintFor = null; nextHint = 0;
    return true;
  }

  // A click / tap at normalised device coords (−1…1). True = a leaf was hit and toggled.
  function clickAt(ndcX, ndcY, how = 'click') {
    if (!meshes.length || !camera) return false;
    ray.setFromCamera({ x: ndcX, y: ndcY }, camera);
    ray.far = knobs.doorClickM;
    const hits = ray.intersectObjects(meshes, false);
    for (const h of hits) {
      if (!h.object.visible) continue;
      let d = h.object.userData.__door;
      if (!d) continue;
      if (d.follower && d.partner) d = d.partner;   // a pair: the leader answers for both
      say(toggleDoor(d), how);
      return true;
    }
    return false;
  }

  // The walker's slide off a CLOSED leaf (3 chest rays from where the step began). Returns {x, z} or null.
  function block(ox, oz, x, z, feetY) {
    if (!doors.length) return null;
    const dx = x - ox, dz = z - oz, len = Math.hypot(dx, dz);
    if (len < 1e-5) return null;
    const near = [];
    const R = knobs.doorReachM + len + 1;
    for (const d of doors) {
      if (!blocking(d)) continue;
      if (Math.hypot(d.center.x - x, d.center.z - z) > R) continue;
      for (const mm of d.meshes) near.push(mm);
    }
    if (!near.length) return null;
    const chest = feetY + knobs.doorChestM, reach = len + knobs.doorRadiusM, fx = dx / len, fz = dz / len;
    const spread = THREE.MathUtils.degToRad(knobs.doorRaySpreadDeg);
    let px = x, pz = z, moved = false;
    for (const a of [0, spread, -spread]) {
      const c = Math.cos(a), s = Math.sin(a);
      _o.set(ox, chest, oz); _d.set(fx * c - fz * s, 0, fx * s + fz * c);
      ray.set(_o, _d); ray.near = 0; ray.far = reach;
      const hits = ray.intersectObjects(near, false);
      const hit = hits.find(h => h.face);
      if (!hit) continue;
      _n.copy(hit.face.normal); _nm.getNormalMatrix(hit.object.matrixWorld); _n.applyMatrix3(_nm); _n.y = 0;
      const nl = Math.hypot(_n.x, _n.z);
      if (nl < 0.2) continue;
      _n.x /= nl; _n.z /= nl;
      if (_n.x * _d.x + _n.z * _d.z > 0) { _n.x = -_n.x; _n.z = -_n.z; }
      const sd = (px - hit.point.x) * _n.x + (pz - hit.point.z) * _n.z;
      if (sd < knobs.doorRadiusM) { const push = knobs.doorRadiusM - sd; px += _n.x * push; pz += _n.z * push; moved = true; }
    }
    return moved ? { x: px, z: pz } : null;
  }

  function forEachMaterial(fn) { root.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && fn(m)); }); }

  return {
    root, adopt, setSource, setBudget, clear, tick, use, clickAt, block, forEachMaterial, rig,
    liveNodes,                      // the indoor probe stops walking through these leaves' A5401 boxes
    get fileName() { return file; }, get count() { return doors.length; }, get rows() { return rows.length; }, get loaded() { return loaded; },
    get doors() { return doors; },
  };
}
