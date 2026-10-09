// ★ A5392 · INTERIORS, LAZY-LOADED PER BUILDING (glTF web budget, step 4 — viewer side, 2026-10-09).
//
// Since A5391 World_web.glb (and its _lite copy) leave every building interior OUT — ~5.5 M of the ~12 M triangles a
// pass drew — and say where each one went in `extras.thalyn.interiors`:
//   { present, version: 1, frame: "gltf", count, totalBytes, totalTris,
//     buildings: [{ id, building, node, file: "Interiors_000_web.glb", rawFile, center:[x,y,z], extents:[hx,hy,hz],
//                   tris, bytes, rawBytes, storeys }] }
// `file` sits beside World_web.glb (the lite copy points at the same files); `center` is already in the glTF frame (X
// negated), `extents` are half-sizes of the world AABB. `node` is a LABEL only — gltfpack strips names.
//
// This module loads a building's interior when the camera comes near its box, by the tier's budget:
//   phone 1 resident within 30 m · laptop 2 within 60 m · desktop 4 within 120 m;
// it starts loading PREFETCH (30 m) before the radius, shows an interior only inside the radius, keeps loaded ones as an
// LRU cache while it has room, and disposes geometry + materials + textures on evict. One load in flight at a time.
//
// The decision is ONE pure function (planInteriors) with no three.js in it, so it is testable in node; the factory only
// carries it out. This file deliberately has NO `three` import — the host passes the root group, the loader and the
// renderer — so node can import it as-is.
//
// Console proof lines:
//   [thalyn-interiors] loaded '<building>' <tris> tris in <ms> ms · resident a/b
//   [thalyn-interiors] evicted '<building>' (<why>) · resident a/b
// and `text` (the ?perf=1 row): resident a/b · tris · shown · loading.

export const INTERIOR_BUDGET = {
  lite:   { max: 1, radius: 30 },
  laptop: { max: 2, radius: 60 },
  high:   { max: 4, radius: 120 },
};
// ★ A5401 · INDOORS I1 — the walk's knobs, one row per tier (PROVISIONAL: the lead folds these into the TIERS row as columns at merge;
// until then they live here and travel on the interiors object as `knobs`).
//   bvhSliceMs     0 = build a building's BVH on the main thread at load (desktop); > 0 = idle slices of at most that many ms (phone)
//   stepUpM        the floor ray starts this far above the feet (a stair riser you can climb; a ceiling above it is never a floor)
//   fallGuardM     no floor within this far under the feet ⇒ keep the last floor (a gap in a mesh never drops you)
//   wallRayM       the three horizontal wall rays' reach beyond the move, from chest height
//   wallSpreadDeg  the two side rays' angle off the move direction
//   wallRadiusM    how far from a wall the walker is kept (a 0.9 m doorway leaves 0.4 m)
//   chestM         chest height above the feet for the wall rays
export const INDOOR_DEFAULTS = {
  lite:   { bvhSliceMs: 16, stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2 },
  laptop: { bvhSliceMs: 0,  stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2 },
  high:   { bvhSliceMs: 0,  stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2 },
};
export const PREFETCH_M = 30;     // start loading this far before the radius
export const HYSTERESIS_M = 8;    // shown/hidden and the far eviction line wobble this much less at a boundary

// Distance from a point to an axis-aligned box given as centre + half-extents (0 inside).
export function distToBox(p, c, e) {
  const dx = Math.max(0, Math.abs(p.x - c[0]) - e[0]);
  const dy = Math.max(0, Math.abs(p.y - c[1]) - e[1]);
  const dz = Math.max(0, Math.abs(p.z - c[2]) - e[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Read + validate the block. Returns a clean list (bad rows dropped) or null when there is nothing to do.
export function readInteriorsBlock(block) {
  if (!block || typeof block !== 'object' || block.present !== true || !Array.isArray(block.buildings)) return null;
  const out = [];
  const num3 = a => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => typeof v === 'number' && isFinite(v));
  block.buildings.forEach((b, i) => {
    if (!b || typeof b.file !== 'string' || !b.file || !num3(b.center) || !num3(b.extents)) return;
    out.push({
      key: String(b.file),                    // the file is the identity of a lazy unit (ids could repeat across exports)
      id: b.id, file: b.file, building: String(b.building || b.node || b.file),
      center: b.center.slice(0, 3), extents: b.extents.slice(0, 3).map(v => Math.abs(v)),
      tris: Number(b.tris) || 0, bytes: Number(b.bytes) || 0, storeys: Number(b.storeys) || 0, index: i,
      doors: readDoorBoxes(b.doors),          // A5401 · I1: partition door-leaf boxes (absent on old exports ⇒ [])
    });
  });
  return out.length ? out : null;
}

// A5401 · I1: door-leaf boxes { id, center:[x,y,z], extents:[hx,hy,hz] } (glTF frame, as the interiors rows) → a clean list
// { id, min:[x,y,z], max:[x,y,z] }. Accepts an array or { doors:[…] }; bad rows dropped; missing ⇒ [].
export function readDoorBoxes(list) {
  const arr = Array.isArray(list) ? list : (list && Array.isArray(list.doors) ? list.doors : []);
  const num3 = a => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => typeof v === 'number' && isFinite(v));
  const out = [];
  for (const d of arr) {
    if (!d || !num3(d.center) || !num3(d.extents)) continue;
    const c = d.center, e = d.extents.map(v => Math.abs(v));
    out.push({ id: d.id != null ? String(d.id) : '', min: [c[0] - e[0], c[1] - e[1], c[2] - e[2]], max: [c[0] + e[0], c[1] + e[1], c[2] + e[2]] });
  }
  return out;
}
export function inDoorBox(boxes, p, pad = 0.05) {
  for (const b of boxes) {
    if (p.x >= b.min[0] - pad && p.x <= b.max[0] + pad && p.y >= b.min[1] - pad && p.y <= b.max[1] + pad && p.z >= b.min[2] - pad && p.z <= b.max[2] + pad) return true;
  }
  return false;
}

// THE DECISION. Pure: no side effects, no three.js.
//   units     [{ key, center, extents }]
//   cam       { x, y, z }
//   budget    { max, radius, prefetch?, hysteresis?, concurrent? }
//   st        { resident: Map(key → lastWantedTick), loading: Set(key), failed: Set(key), shown: Set(key) }
//   tick      a monotonically increasing number (the LRU clock)
// Returns { keep:[key], touch:[key], load:[key], evict:[{key, why}], show:Set(key), dist: Map(key → m) }.
//   keep  = the nearest `max` units within radius + prefetch (the ones that should be resident);
//   load  = kept, not resident, not loading — nearest first, at most `concurrent − loading` and only into free slots;
//   evict = anything resident beyond the far line (radius + prefetch + hysteresis), then — only when a kept unit needs
//           the slot — the least-recently-wanted resident that is not kept;
//   show  = resident and within radius (hysteresis keeps a shown one shown until radius + hysteresis).
export function planInteriors(units, cam, budget, st, tick) {
  const max = Math.max(0, budget.max | 0), R = Math.max(0, budget.radius || 0);
  const pre = budget.prefetch != null ? budget.prefetch : PREFETCH_M;
  const hy = budget.hysteresis != null ? budget.hysteresis : HYSTERESIS_M;
  const conc = Math.max(1, budget.concurrent || 1);
  const dist = new Map();
  for (const u of units) dist.set(u.key, distToBox(cam, u.center, u.extents));

  const cand = units.filter(u => !st.failed.has(u.key) && dist.get(u.key) <= R + pre)
                    .sort((a, b) => dist.get(a.key) - dist.get(b.key));
  const keep = cand.slice(0, max).map(u => u.key);
  const keepSet = new Set(keep);
  const touch = keep.filter(k => st.resident.has(k));

  const evict = [], evicted = new Set();
  // 1 · beyond the far line: out, whatever the room.
  for (const k of st.resident.keys()) {
    if (keepSet.has(k)) continue;
    const d = dist.has(k) ? dist.get(k) : Infinity;
    if (d > R + pre + hy) { evict.push({ key: k, why: 'beyond ' + Math.round(R + pre) + ' m' }); evicted.add(k); }
  }
  // 2 · a kept unit needs a slot: evict LRU among the resident not kept (touched ones count as just used).
  const toLoad = keep.filter(k => !st.resident.has(k) && !st.loading.has(k));
  let occupied = st.resident.size - evicted.size + st.loading.size;
  const want = Math.min(toLoad.length, Math.max(0, conc - st.loading.size));
  const spare = [...st.resident.entries()].filter(([k]) => !keepSet.has(k) && !evicted.has(k))
                                          .sort((a, b) => a[1] - b[1]);   // oldest first
  while ((occupied + want > max || occupied > max) && spare.length) {   // a tier drop (4 → 1) also trims to the cap
    const [k] = spare.shift();
    evict.push({ key: k, why: want > 0 ? 'LRU — a nearer building needs the slot' : 'LRU — over the tier cap' }); evicted.add(k); occupied--;
  }
  const load = toLoad.slice(0, Math.max(0, Math.min(want, max - occupied)));

  const show = new Set();
  for (const k of st.resident.keys()) {
    if (evicted.has(k)) continue;
    const d = dist.get(k);
    if (d === undefined) continue;
    if (d <= R || (st.shown.has(k) && d <= R + hy)) show.add(k);
  }
  return { keep, touch, load, evict, show, dist, tick };
}

// Free everything a loaded glTF scene owns: geometry, materials and every texture a material points at.
export function disposeTree(root) {
  const seenTex = new Set();
  root.traverse(o => {
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (!m) continue;
      for (const k in m) { const v = m[k]; if (v && v.isTexture && !seenTex.has(v)) { seenTex.add(v); v.dispose(); } }
      if (m.dispose) m.dispose();
    }
  });
  if (root.parent) root.parent.remove(root);
}

// The factory.
//   opts.root       a THREE.Group already in the scene (NOT under worldRoot: framing, the walk probe and the grass never see it)
//   opts.getLoader  () => the viewer's GLTFLoader (KTX2 + Meshopt + Draco — shared, never a second one)
//   opts.renderer, opts.scene   for compileAsync (shader programs built before the interior is shown — fewer hitches)
//   opts.prepare    (gltfScene) => void   the host's per-mesh prep (normals, foliage patch, strip baked lights)
export function makeInteriors(opts) {
  const root = opts.root;
  let units = null, unitByKey = new Map();
  let source = null;            // { url } (siblings resolved by URL) or { files: Map(name → File) } (a dropped folder)
  let budget = { ...INTERIOR_BUDGET.high }, tierName = 'high';
  // ★ A5396 · B3 (landing dip): the FIRST interior load waits until the frame EMA is under TIERS.interiorFirstEmaMs for
  // interiorFirstCalmS (or interiorFirstCapS at most) — one 15–20 MB decode must not land on the landing frames.
  // A tiny frame clock of its own (measured between tick() calls) — no global state.
  let firstGate = { emaMs: 20, calmS: 1, capS: 6 }, gateOpen = false, gateHeld = false, gateT0 = 0, gateLast = 0, gateEma = 16.7, gateCalm = 0;
  const st = { resident: new Map(), loading: new Set(), failed: new Set(), shown: new Set() };
  const loaded = new Map();     // key → { root, tris }
  let epoch = 0, tickN = 0, frame = 0;
  const _cam = { x: 0, y: 0, z: 0 };
  let _camV = null;

  const residentText = () => `resident ${st.resident.size}/${budget.max}`;
  const knobs = () => INDOOR_DEFAULTS[tierName] || INDOOR_DEFAULTS.high;

  // ★ A5401 · INDOORS I1 — the building's mesh list (world AABB + Y range) and its BVH, built ONCE at load (never per step, never per
  // storey band). PERF's B2 band READS L.meshes and flips mesh.visible only; evict()/clear() are the only places that dispose.
  function triCountOf(gg) { return gg.index ? gg.index.count / 3 : (gg.attributes.position ? gg.attributes.position.count / 3 : 0); }
  function indexMeshes(g) {
    g.updateMatrixWorld(true);
    const list = [];
    g.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      let box = null;
      try {
        if (o.isInstancedMesh && o.computeBoundingBox) { o.computeBoundingBox(); box = o.boundingBox.clone().applyMatrix4(o.matrixWorld); }
        else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); }
      } catch (e) { return; }
      list.push({ mesh: o, box, yMin: box.min.y, yMax: box.max.y });
    });
    return list;
  }
  function buildBvh(key, L, u) {
    const geos = [], seen = new Set();
    for (const m of L.meshes) { const gg = m.mesh.geometry; if (gg && !seen.has(gg)) { seen.add(gg); geos.push(gg); } }
    L.bvh = { ready: false, ms: 0, tris: 0, slices: 0 };
    const slice = knobs().bvhSliceMs, t0 = performance.now();
    let i = 0;
    const one = gg => {
      const t = performance.now();
      try { if (!gg.boundsTree && typeof gg.computeBoundsTree === 'function') gg.computeBoundsTree(); } catch (e) { /* linear raycast for this one */ }
      L.bvh.ms += performance.now() - t; L.bvh.tris += triCountOf(gg);
    };
    const done = () => {
      L.bvh.ready = true;
      console.info(`[thalyn-walk] bvh '${u.building}' ${Math.round(L.bvh.tris).toLocaleString()} tris in ${L.bvh.ms.toFixed(0)} ms` +
        (slice > 0 ? ` (${L.bvh.slices} idle slice(s) ≤ ${slice} ms, ${(performance.now() - t0).toFixed(0)} ms wall)` : ' (main thread)') + ` · ${L.meshes.length} mesh(es) · ${(u.doors || []).length} door box(es)`);
    };
    if (!(slice > 0)) { for (const gg of geos) one(gg); done(); return; }
    // three-mesh-bvh 0.7.6's bundle carries no worker generator ⇒ the phone builds in idle slices (iOS Safari has no requestIdleCallback: a timer stands in)
    const idle = typeof requestIdleCallback === 'function' ? cb => requestIdleCallback(cb, { timeout: 500 })
                                                         : cb => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => slice }), 16);
    const step = dl => {
      if (loaded.get(key) !== L) return;   // evicted (or the world changed) while slicing
      const s0 = performance.now(); L.bvh.slices++;
      do { one(geos[i++]); } while (i < geos.length && performance.now() - s0 < slice && (dl.didTimeout || dl.timeRemaining() > 1));
      if (i < geos.length) idle(step); else done();
    };
    if (geos.length) idle(step); else done();
  }
  function disposeBvh(L) {
    if (!L || !L.meshes) return;
    for (const m of L.meshes) { const gg = m.mesh.geometry; try { if (gg && gg.boundsTree && gg.disposeBoundsTree) gg.disposeBoundsTree(); } catch (e) {} }
    L.meshes = null;
  }
  // The read API: the SHOWN resident building whose box holds p (distToBox == 0; the smallest box when boxes nest), else null.
  // A hidden building (root.visible false — outside its radius) is absent: no floor, no walls (spec §3 rule 3).
  function residentFor(p) {
    let best = null, bestVol = Infinity;
    for (const [k, L] of loaded) {
      if (!L.root.visible || !L.meshes) continue;
      const u = unitByKey.get(k); if (!u || distToBox(p, u.center, u.extents) > 0) continue;
      const vol = u.extents[0] * u.extents[1] * u.extents[2];
      if (vol < bestVol) { bestVol = vol; best = { key: k, unit: u, building: u.building, root: L.root, meshes: L.meshes, doors: u.doors || [],
                                                   bvhReady: !!(L.bvh && L.bvh.ready), bvhMs: L.bvh ? L.bvh.ms : 0 }; }
    }
    return best;
  }

  function setSource(s) { source = s || null; }

  // Called from ingest with extras.thalyn.interiors (absent ⇒ nothing to do, the old behaviour).
  function adopt(block) {
    const list = readInteriorsBlock(block);
    if (!list) return 0;
    units = list; unitByKey = new Map(list.map(u => [u.key, u]));
    const tris = list.reduce((s, u) => s + u.tris, 0), bytes = list.reduce((s, u) => s + u.bytes, 0);
    console.info(`[thalyn-interiors] ${list.length} building interior(s) listed — ${(tris / 1e6).toFixed(2)} M tris, ${(bytes / 1048576).toFixed(1)} MB, loaded by distance ` +
      `(tier ${tierName}: ${budget.max} within ${budget.radius} m, prefetch +${PREFETCH_M} m) · source ${source ? (source.files ? 'dropped files (' + source.files.size + ')' : 'URL') : 'NONE'}`);
    if (source && source.files) {
      const missing = list.filter(u => !source.files.has(u.file));
      if (missing.length) console.warn(`[thalyn-interiors] ${missing.length} interior file(s) were not among the dropped files (drop the whole folder): ` + missing.slice(0, 6).map(u => u.file).join(', ') + (missing.length > 6 ? ' …' : ''));
    }
    return list.length;
  }

  function setBudget(t, name) {
    tierName = name || tierName;
    if (t && t.interiorFirstEmaMs) firstGate = { emaMs: t.interiorFirstEmaMs, calmS: t.interiorFirstCalmS || 1, capS: t.interiorFirstCapS || 6 };
    budget = { ...(INTERIOR_BUDGET[tierName] || INTERIOR_BUDGET.high) };
    if (units) console.info(`[thalyn-interiors] tier ${tierName}: ${budget.max} resident within ${budget.radius} m (prefetch +${PREFETCH_M} m)`);
  }

  function urlFor(u) {
    if (!source) return null;
    if (source.files) { const f = source.files.get(u.file); return f ? { url: URL.createObjectURL(f), blob: true } : null; }
    // A5395: a re-share keeps the same file names, so carry the model's ?v= onto each interior (a phone never serves an old copy)
    try { const m = new URL(source.url, location.href), r = new URL(u.file, m); r.search = m.search; return { url: r.href, blob: false }; } catch (e) { return null; }
  }

  async function load(u) {
    const my = epoch;
    const src = urlFor(u);
    if (!src) { st.failed.add(u.key); console.warn(`[thalyn-interiors] '${u.building}' — no file to load (${u.file} ${source && source.files ? 'not dropped' : 'has no address'}); skipped for this world`); return; }
    st.loading.add(u.key);
    const t0 = performance.now();
    try {
      const gltf = await opts.getLoader().loadAsync(src.url);
      if (my !== epoch) { disposeTree(gltf.scene); return; }              // the world changed while it loaded
      const g = gltf.scene;
      g.name = 'Interior_' + u.building;
      g.userData.__interior = u.key;
      try { if (opts.prepare) opts.prepare(g); } catch (e) { console.warn('[thalyn-interiors] prepare failed (ignored)', e); }
      let tris = 0;
      g.traverse(o => { if (o.isMesh && o.geometry) { const gg = o.geometry; tris += gg.index ? gg.index.count / 3 : (gg.attributes.position ? gg.attributes.position.count / 3 : 0); } });
      g.visible = false;
      // Build the shader programs off the critical frame where the renderer can (three r158+); never fatal.
      if (opts.renderer && opts.renderer.compileAsync && opts.camera) {
        try { await opts.renderer.compileAsync(g, opts.camera, opts.scene); } catch (e) {}   // r160: compiles every material in g (traverse, not traverseVisible)
        if (my !== epoch) { disposeTree(g); return; }
      }
      root.add(g);
      const L = { root: g, tris, meshes: indexMeshes(g), bvh: null };   // ★ A5401 · I1: mesh list once, BVH once (sliced on a phone)
      loaded.set(u.key, L);
      st.resident.set(u.key, tickN);
      buildBvh(u.key, L, u);
      console.info(`[thalyn-interiors] loaded '${u.building}' ${Math.round(tris).toLocaleString()} tris in ${(performance.now() - t0).toFixed(0)} ms · ${residentText()}`);
    } catch (e) {
      st.failed.add(u.key);
      console.warn(`[thalyn-interiors] '${u.building}' failed to load (${u.file}) — skipped for this world; the scene is unaffected`, e);
    } finally {
      st.loading.delete(u.key);
      if (src.blob) URL.revokeObjectURL(src.url);
    }
  }

  function evict(key, why) {
    const L = loaded.get(key);
    loaded.delete(key); st.resident.delete(key); st.shown.delete(key);
    if (L) { disposeBvh(L); disposeTree(L.root); }   // ★ A5401: the BVH goes with its building
    const u = unitByKey.get(key);
    console.info(`[thalyn-interiors] evicted '${u ? u.building : key}' (${why}) · ${residentText()}`);
  }

  // Per frame from the render loop; does its work every 8th frame (the game housekeeps on a timer too).
  function tick(camera) {
    if (!units || !source) return;
    if (!gateOpen && gateHeld) gateT0 = 0;   // the host is still landing the world (hidden while its shaders compile)
    else if (!gateOpen) {
      const now = performance.now();
      if (!gateT0) { gateT0 = now; gateLast = now; gateCalm = 0; }
      else { gateEma += (now - gateLast - gateEma) * 0.08; gateLast = now; }
      if (gateEma < firstGate.emaMs) { if (!gateCalm) gateCalm = now; } else gateCalm = 0;
      const calm = gateCalm && now - gateCalm >= firstGate.calmS * 1000, capped = now - gateT0 >= firstGate.capS * 1000;
      if (calm || capped) {
        gateOpen = true;
        console.info(`[thalyn-interiors] first load released after ${((now - gateT0) / 1000).toFixed(1)} s — ` +
          (calm ? `frame EMA ${gateEma.toFixed(1)} ms < ${firstGate.emaMs} ms for ${firstGate.calmS} s` : `cap ${firstGate.capS} s reached (EMA ${gateEma.toFixed(1)} ms)`));
      }
    }
    if ((frame++ & 7) !== 0) return;
    tickN++;
    // World position: in VR the camera rides the dolly, so its local position is not where it is.
    const p = camera.getWorldPosition ? camera.getWorldPosition(_camV || (_camV = camera.position.clone())) : camera.position;
    _cam.x = p.x; _cam.y = p.y; _cam.z = p.z;
    let plan;
    try { plan = planInteriors(units, _cam, budget, st, tickN); } catch (e) { console.warn('[thalyn-interiors] plan failed (ignored)', e); return; }
    for (const k of plan.touch) st.resident.set(k, tickN);
    for (const e of plan.evict) evict(e.key, e.why);
    for (const k of st.resident.keys()) {
      const L = loaded.get(k); if (!L) continue;
      const on = plan.show.has(k);
      if (L.root.visible !== on) L.root.visible = on;
      if (on) st.shown.add(k); else st.shown.delete(k);
    }
    if (gateOpen) for (const k of plan.load) load(unitByKey.get(k));   // async; the loading set guards duplicates (A5396: gated until the landing is calm)
  }

  function clear() {
    epoch++;
    for (const k of [...loaded.keys()]) { const L = loaded.get(k); if (L) { disposeBvh(L); disposeTree(L.root); } }
    loaded.clear(); st.resident.clear(); st.loading.clear(); st.failed.clear(); st.shown.clear();
    units = null; unitByKey = new Map(); source = null; frame = 0;
    gateOpen = false; gateT0 = 0; gateEma = 16.7; gateCalm = 0;   // A5396 · the next world's landing waits again
  }

  // Every material currently resident (tone-mapping changes flag them for recompile).
  function forEachMaterial(fn) { root.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && fn(m)); }); }

  // A5396 · the host holds the first-load gate while the world is hidden for compileAsync; the calm clock starts on release.
  function holdFirstLoad(on) { gateHeld = !!on; }

  return {
    adopt, setSource, setBudget, tick, clear, forEachMaterial, holdFirstLoad, residentFor,
    get count() { return units ? units.length : 0; },
    get tier() { return tierName; },
    get knobs() { return knobs(); },
    get doorBoxCount() { return units ? units.reduce((s, u) => s + (u.doors ? u.doors.length : 0), 0) : 0; },
    get resident() { return st.resident.size; },
    get text() {
      if (!units) return 'none';
      let tris = 0, shown = 0;
      for (const [k, L] of loaded) { tris += L.tris; if (st.shown.has(k)) shown++; }
      const ld = [...st.loading].map(k => (unitByKey.get(k) || {}).building).filter(Boolean);
      return `${residentText()} · ${(tris / 1e6).toFixed(2)} M tris · ${shown} shown of ${units.length}` +
        (ld.length ? ' · loading ' + ld.join(', ') : '') + (st.failed.size ? ' · ' + st.failed.size + ' failed' : '');
    },
  };
}
