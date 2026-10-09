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
//   [thalyn-interiors] split '<building>' <n> mesh(es) → <m> storey slice(s) in <ms> ms   (A5398)
//   [thalyn-interiors] band '<building>' y <lo>…<hi> (cam <y>, storey <n>) shows <tris> of <tris> tris · a/b mesh(es)   (A5397 · B2)
// and `text` (the ?perf=1 row): resident a/b · tris · shown · shown tris (after the band) · loading.

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
// ★ A5397 · PERF P2 · B2 THE STOREY BAND — fallback when the tier row carries no band columns (TIERS bandBelowM / bandAboveM /
// bandCapTris, thalyn-atmos.js). A shown building draws only the meshes whose world Y range meets [camY − below, camY + above]
// plus the storey the camera is in and its two neighbours. bandCapTris is INFORMATIONAL (spec §C residentInteriorTris =
// min(tris, bandCap)) — the band never hides more to meet it; the band log says when a band is over it.
export const BAND_DEFAULTS = { bandBelowM: 7, bandAboveM: 12, bandCapTris: 350000 };
export const BAND_MOVE_M = 0.5;   // a band pass runs only when the camera moved more than this in Y since the last one (per building)

// ★ A5398 · THE STOREY SPLIT — gltfpack merges every storey of a building into a handful of meshes that each span the whole
// height (Interiors_006: 4 prims, 2.25 M tris, all 133 m tall), so the band above could never hide anything and the per-building
// BVH was one huge geometry. At load (after prepare, before the mesh index + BVH) every tall NON-instanced mesh is replaced by
// one child mesh per storey bin: triangles bucketed by world centroid Y on the planBand grid (base = unit centre − extent,
// storey height = 2·extent / storeys; storeys 0 ⇒ the TIERS column splitBinM, default 4 m). Vertex attributes are SHARED (no
// vertex copy — only a new index per bin); each slice carries its OWN boundingBox/boundingSphere from its triangles (a shared
// position's computeBoundingBox would cover the whole building ⇒ frustum culling and the band both break). three-mesh-bvh
// 0.7.6 reorders only the INDEX (sortUtils partition) and reads positions — the shared attribute is never written.
export const SPLIT_DEFAULTS = { splitBinM: 4, splitMinSpan: 1.5 };

// The bin grid for a unit: { base, sh } (pure). Same grid as planBand when storeys ≥ 1.
export function storeyGrid(unit, knobs) {
  const binM = knobs && knobs.splitBinM > 0 ? knobs.splitBinM : SPLIT_DEFAULTS.splitBinM;
  if (unit && unit.center && unit.extents && unit.extents[1] > 0) {
    const base = unit.center[1] - unit.extents[1], h = 2 * unit.extents[1];
    return { base, sh: unit.storeys >= 1 ? h / unit.storeys : binM };
  }
  return { base: 0, sh: binM };
}

// The raw position reader (plain or interleaved, normalized/quantized folded into one factor — gltfpack quantizes).
function posReader(a) {
  const inter = !!a.isInterleavedBufferAttribute, arr = inter ? a.data.array : a.array;
  let f = 1;
  if (a.normalized) f = arr instanceof Int16Array ? 1 / 32767 : arr instanceof Uint16Array ? 1 / 65535 : arr instanceof Int8Array ? 1 / 127 : arr instanceof Uint8Array ? 1 / 255 : 1;
  return { arr, stride: inter ? a.data.stride : a.itemSize, off: inter ? a.offset : 0, f };
}
// The root BufferAttribute class (no three import here): climb from whatever index class the geometry uses.
function bufferAttributeClass(gg) {
  let C = gg.index ? gg.index.constructor : new gg.constructor().setIndex([0]).index.constructor;
  while (Object.getPrototypeOf(C) !== Function.prototype) C = Object.getPrototypeOf(C);
  return C;
}

// Split one mesh. Returns the slice meshes (not yet parented) or null when it should stay as it is.
export function splitMesh(o, grid, minSpan) {
  const gg = o.geometry, pa = gg && gg.attributes && gg.attributes.position;
  if (!pa || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || (gg.groups && gg.groups.length > 1) ||
      (gg.morphAttributes && Object.keys(gg.morphAttributes).length) || o.children.length ||
      gg.drawRange.start !== 0 || gg.drawRange.count !== Infinity || gg.boundsTree) return null;
  const V = pa.count, idx = gg.index ? gg.index.array : null, T = ((idx ? idx.length : V) / 3) | 0;
  if (T < 2) return null;
  const { arr, stride, off, f } = posReader(pa), e = o.matrixWorld.elements;
  const a1 = e[1] * f, a5 = e[5] * f, a9 = e[9] * f, a13 = e[13];
  const wy = new Float32Array(V);
  let yMin = Infinity, yMax = -Infinity;
  for (let v = 0, p = off; v < V; v++, p += stride) {
    const y = a1 * arr[p] + a5 * arr[p + 1] + a9 * arr[p + 2] + a13; wy[v] = y;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const sh = grid.sh, base = grid.base;
  if (!(sh > 0) || yMax - yMin <= minSpan * sh) return null;
  const k0 = Math.floor((yMin - base) / sh), nb = Math.floor((yMax - base) / sh) - k0 + 1;
  if (nb < 2 || nb > 65535) return null;
  const binOf = new Uint16Array(T), cnt = new Uint32Array(nb), inv3sh = 1 / (3 * sh), b0 = base / sh + k0;
  for (let t = 0; t < T; t++) {
    const i = 3 * t, va = idx ? idx[i] : i, vb = idx ? idx[i + 1] : i + 1, vc = idx ? idx[i + 2] : i + 2;
    let b = Math.floor((wy[va] + wy[vb] + wy[vc]) * inv3sh - b0);
    if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
    binOf[t] = b; cnt[b]++;
  }
  let used = 0; for (let b = 0; b < nb; b++) if (cnt[b]) used++;
  if (used < 2) return null;
  // Per-bin index + local box (positions read raw, scaled by f — the geometry's own local frame).
  const Big = V > 65535 ? Uint32Array : Uint16Array;
  const out = new Array(nb), fill = new Uint32Array(nb), bx = new Float64Array(nb * 6);
  for (let b = 0; b < nb; b++) { if (cnt[b]) out[b] = new Big(cnt[b] * 3); bx[b * 6] = bx[b * 6 + 1] = bx[b * 6 + 2] = Infinity; bx[b * 6 + 3] = bx[b * 6 + 4] = bx[b * 6 + 5] = -Infinity; }
  for (let t = 0; t < T; t++) {
    const b = binOf[t], dst = out[b], j = fill[b], o6 = b * 6, i = 3 * t;
    for (let c = 0; c < 3; c++) {
      const v = idx ? idx[i + c] : i + c; dst[j + c] = v;
      const p = off + v * stride, x = arr[p], y = arr[p + 1], z = arr[p + 2];
      if (x < bx[o6]) bx[o6] = x; if (x > bx[o6 + 3]) bx[o6 + 3] = x;
      if (y < bx[o6 + 1]) bx[o6 + 1] = y; if (y > bx[o6 + 4]) bx[o6 + 4] = y;
      if (z < bx[o6 + 2]) bx[o6 + 2] = z; if (z > bx[o6 + 5]) bx[o6 + 5] = z;
    }
    fill[b] = j + 3;
  }
  // Box3 / Sphere classes borrowed from the geometry (no three import in this file).
  if (!gg.boundingBox) gg.computeBoundingBox();
  if (!gg.boundingSphere) gg.computeBoundingSphere();
  const Box3 = gg.boundingBox.constructor, Sphere = gg.boundingSphere.constructor, BA = bufferAttributeClass(gg);
  const slices = [];
  for (let b = 0; b < nb; b++) {
    if (!cnt[b]) continue;
    const g2 = new gg.constructor();
    for (const n in gg.attributes) g2.setAttribute(n, gg.attributes[n]);   // SHARED, never copied
    g2.setIndex(new BA(out[b], 1));
    const o6 = b * 6, lo = (q) => bx[o6 + q] * f, hi = (q) => bx[o6 + 3 + q] * f;
    const box = new Box3(); box.min.set(Math.min(lo(0), hi(0)), Math.min(lo(1), hi(1)), Math.min(lo(2), hi(2))); box.max.set(Math.max(lo(0), hi(0)), Math.max(lo(1), hi(1)), Math.max(lo(2), hi(2)));
    g2.boundingBox = box; g2.boundingSphere = box.getBoundingSphere(new Sphere());
    g2.name = gg.name; g2.userData = { ...gg.userData };
    const k = k0 + b, s = new o.constructor(g2, o.material);
    s.name = (o.name || 'mesh') + '#s' + k;
    s.position.copy(o.position); s.quaternion.copy(o.quaternion); s.scale.copy(o.scale);
    s.matrixAutoUpdate = o.matrixAutoUpdate; s.matrix.copy(o.matrix); s.matrixWorld.copy(o.matrixWorld);
    s.castShadow = o.castShadow; s.receiveShadow = o.receiveShadow; s.frustumCulled = o.frustumCulled; s.renderOrder = o.renderOrder;
    s.visible = o.visible; s.layers.mask = o.layers.mask;
    if (o.customDepthMaterial) s.customDepthMaterial = o.customDepthMaterial;
    if (o.customDistanceMaterial) s.customDistanceMaterial = o.customDistanceMaterial;
    s.userData = { ...o.userData, __storeyBin: k };
    slices.push(s);
  }
  return slices;
}

// Split every tall mesh of a loaded interior in place. Returns { meshes, slices, tris, ms }.
export function splitByStorey(g, unit, knobs) {
  const t0 = performance.now(), grid = storeyGrid(unit, knobs);
  const minSpan = knobs && knobs.splitMinSpan > 0 ? knobs.splitMinSpan : SPLIT_DEFAULTS.splitMinSpan;
  g.updateMatrixWorld(true);
  const cand = [];
  g.traverse(o => { if (o.isMesh && o.parent) cand.push(o); });
  let meshes = 0, slices = 0, tris = 0;
  for (const o of cand) {
    const s = splitMesh(o, grid, minSpan);
    if (!s) continue;
    const parent = o.parent, at = parent.children.indexOf(o);
    parent.remove(o);
    for (const m of s) { parent.add(m); tris += m.geometry.index.count / 3; }
    // keep the original's place in the child order (cosmetic; the slices follow where it was)
    if (at >= 0) { const moved = parent.children.splice(parent.children.length - s.length, s.length); parent.children.splice(at, 0, ...moved); }
    meshes++; slices += s.length;
  }
  return { meshes, slices, tris, ms: performance.now() - t0, sh: grid.sh };
}

// Triangles a mesh entry draws (the same count `load()` sums into L.tris — instancing not multiplied, so shown ≤ resident).
export function meshTris(m) {
  const gg = m && m.mesh && m.mesh.geometry;
  if (!gg) return 0;
  return gg.index ? gg.index.count / 3 : (gg.attributes && gg.attributes.position ? gg.attributes.position.count / 3 : 0);
}

// THE BAND. Pure: no three.js, no side effects. Decides which of a building's meshes are shown for a camera height.
//   meshes   [{ yMin, yMax, … }]   (L.meshes; the whole-mesh world box, instanced meshes included)
//   camY     the camera's world Y
//   unit     { center:[x,y,z], extents:[hx,hy,hz], storeys }   (the interiors row; storeys 0 ⇒ one per 3 m, as INDOORS' storeyOf)
//   band     { bandBelowM, bandAboveM }
// Returns { lo, hi, storey, on: boolean[] } — on[i] ⇔ [yMin, yMax] meets [lo, hi], where [lo, hi] is the union of the band
// and the camera's storey ± 1 (both contain camY, so the union is one interval).
export function planBand(meshes, camY, unit, band) {
  const below = band && band.bandBelowM != null ? band.bandBelowM : BAND_DEFAULTS.bandBelowM;
  const above = band && band.bandAboveM != null ? band.bandAboveM : BAND_DEFAULTS.bandAboveM;
  let lo = camY - below, hi = camY + above, storey = -1;
  if (unit && unit.center && unit.extents) {
    const base = unit.center[1] - unit.extents[1], h = 2 * unit.extents[1];
    if (h > 0) {
      const n = unit.storeys > 0 ? unit.storeys : Math.max(1, Math.round(h / 3)), sh = h / n;
      storey = Math.min(n - 1, Math.max(0, Math.floor((camY - base) / sh + 1e-3)));
      lo = Math.min(lo, base + (storey - 1) * sh);
      hi = Math.max(hi, base + (storey + 2) * sh);
    }
  }
  const on = new Array(meshes.length);
  for (let i = 0; i < meshes.length; i++) { const m = meshes[i]; on[i] = m.yMax >= lo && m.yMin <= hi; }
  return { lo, hi, storey, on };
}

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
  let tierRow = null, bandEpoch = 0;              // A5397 · the tier row (band + indoor knob columns) and a re-band trigger on tier change
  const bandOf = new WeakMap();                   // L → { camY, epoch, shown, total, meshesOn, loggedShown } — dies with the building
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
  // A5397 · the indoor knobs are TIERS columns now (thalyn-atmos.js); INDOOR_DEFAULTS stays the fallback per key (identical numbers).
  const KNOB_KEYS = ['bvhSliceMs', 'stepUpM', 'fallGuardM', 'wallRayM', 'wallSpreadDeg', 'wallRadiusM', 'chestM'];
  let knobCache = null;
  const knobs = () => {
    if (knobCache) return knobCache;
    const d = INDOOR_DEFAULTS[tierName] || INDOOR_DEFAULTS.high, k = { ...d };
    if (tierRow) for (const n of KNOB_KEYS) if (typeof tierRow[n] === 'number' && isFinite(tierRow[n])) k[n] = tierRow[n];
    return (knobCache = k);
  };
  const bandKnobs = () => ({
    bandBelowM: tierRow && typeof tierRow.bandBelowM === 'number' ? tierRow.bandBelowM : BAND_DEFAULTS.bandBelowM,
    bandAboveM: tierRow && typeof tierRow.bandAboveM === 'number' ? tierRow.bandAboveM : BAND_DEFAULTS.bandAboveM,
    bandCapTris: tierRow && typeof tierRow.bandCapTris === 'number' ? tierRow.bandCapTris : BAND_DEFAULTS.bandCapTris,
  });

  // ★ A5397 · B2 — one band pass for a shown building: flips mesh.visible ONLY (never remove/dispose — evict is INDOORS-owned).
  // Runs when the camera moved > BAND_MOVE_M in Y since this building's last pass (or the tier changed, or it never ran).
  function bandPass(k, L, camY) {
    if (!L.meshes || !L.meshes.length) return;
    const prev = bandOf.get(L);
    if (prev && prev.epoch === bandEpoch && Math.abs(camY - prev.camY) <= BAND_MOVE_M) return;
    const u = unitByKey.get(k), bk = bandKnobs();
    const plan = planBand(L.meshes, camY, u, bk);
    let shown = 0, total = 0, meshesOn = 0;
    for (let i = 0; i < L.meshes.length; i++) {
      const m = L.meshes[i], t = meshTris(m), on = plan.on[i];
      total += t;
      if (on) { shown += t; meshesOn++; }
      if (m.mesh.visible !== on) m.mesh.visible = on;
    }
    const nx = { camY, epoch: bandEpoch, shown, total, meshesOn, loggedShown: prev ? prev.loggedShown : -1 };
    // one line when the shown set changes notably (>= 5 % of the building, or the first pass) — never per frame
    if (nx.loggedShown < 0 || Math.abs(shown - nx.loggedShown) >= Math.max(1000, 0.05 * total)) {
      nx.loggedShown = shown;
      console.info(`[thalyn-interiors] band '${u ? u.building : k}' y ${plan.lo.toFixed(1)}…${plan.hi.toFixed(1)} (cam ${camY.toFixed(1)}, storey ${plan.storey}) shows ` +
        `${Math.round(shown).toLocaleString()} of ${Math.round(total).toLocaleString()} tris · ${meshesOn}/${L.meshes.length} mesh(es)` +
        (shown > bk.bandCapTris ? ` · over bandCap ${Math.round(bk.bandCapTris).toLocaleString()}` : ''));
    }
    bandOf.set(L, nx);
  }

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
    if (t) tierRow = t;
    knobCache = null; bandEpoch++;   // A5397 · new tier => new knobs; every shown building re-bands on its next pass
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
      // ★ A5398 · the storey split — BEFORE the tris count, compileAsync, the mesh index and the BVH (each slice its own geometry)
      try {
        const sp = splitByStorey(g, u, { splitBinM: tierRow && typeof tierRow.splitBinM === 'number' ? tierRow.splitBinM : SPLIT_DEFAULTS.splitBinM });
        console.info(`[thalyn-interiors] split '${u.building}' ${sp.meshes} mesh(es) → ${sp.slices} storey slice(s) in ${sp.ms.toFixed(0)} ms` +
          (sp.meshes ? ` (bin ${sp.sh.toFixed(2)} m, ${Math.round(sp.tris).toLocaleString()} tris split)` : ''));
      } catch (e) { console.warn('[thalyn-interiors] split failed (ignored — the band and BVH see whole meshes)', e); }
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
      if (on) { try { bandPass(k, L, _cam.y); } catch (e) { console.warn('[thalyn-interiors] band failed (ignored)', e); } }   // A5397 · B2
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
      let tris = 0, shown = 0, shownTris = 0;
      for (const [k, L] of loaded) {
        tris += L.tris;
        if (st.shown.has(k)) { shown++; const b = bandOf.get(L); shownTris += b ? b.shown : L.tris; }   // A5397 · SHOWN tris (after the band)
      }
      const ld = [...st.loading].map(k => (unitByKey.get(k) || {}).building).filter(Boolean);
      return `${residentText()} · ${(tris / 1e6).toFixed(2)} M tris · ${shown} shown of ${units.length} · ${(shownTris / 1e6).toFixed(2)} M tris shown` +
        (ld.length ? ' · loading ' + ld.join(', ') : '') + (st.failed.size ? ' · ' + st.failed.size + ' failed' : '');
    },
  };
}
