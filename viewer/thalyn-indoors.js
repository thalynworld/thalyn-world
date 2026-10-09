// ★ A5401 · WALKING INDOORS, CHEAPLY — glTF web parity slice I1 (2026-10-09).
//
// Floor (not roof) · stairs · walls · doors walked THROUGH, from the meshes already resident — collision costs 0 triangles.
// Consulted by makeWalk (thalyn-atmos.js) only while you WALK on the ground (fly mode never asks) and only when your feet are
// inside a SHOWN resident building's box (thalyn-interiors.js residentFor: distToBox == 0). Outdoors, sky worlds and every other
// caller of the ground probe (grass, fauna, VR) are untouched: floor() returns `undefined` and the walker falls back to groundAt.
//
//   floor(x, feetY, z)  ONE ray down from feet + stepUpM over the building's interior meshes (ALL of them — a storey band hiding
//                       the floor under you must not drop you, spec addendum §3 rule 2) + the shell/terrain walk meshes under (x, z).
//                       The highest hit within stepUpM + fallGuardM wins (a stair riser ≤ stepUpM is climbed by makeWalk's lerp).
//                       No hit ⇒ the last floor in this building (fall-through guard); never a floor in a different building.
//   wall(ox, oz, x, z, feetY)  THREE rays at chest height from where the step BEGAN (forward = the move, ±wallSpreadDeg), reach
//                       move + wallRayM, against the interior meshes that are VISIBLE (B2 hides by mesh.visible; r160's Raycaster
//                       ignores `visible`, so we skip them ourselves) + the shell. A hit pushes the walker out to wallRadiusM along the
//                       hit's horizontal normal (a slide — the blockAt contract). Returns {x, z} or null.
//   Door leaves: any floor/wall hit inside a door box (extras.thalyn.doors = shell leaves, interiors.buildings[].doors = partition
//   leaves; written by the export since A5400) is ignored — a closed door is walked through. No field ⇒ no boxes (old exports).
//
// Never `intersectObject(root, true)`: every cast iterates an explicit mesh list.
// Console proof lines:
//   [thalyn-walk] doors: N shell + M interior box(es)                              (on load)
//   [thalyn-walk] inside '<building>' storey N · floor y=… · bvh <ms> ms            (on entering, and on a storey change)
//   [thalyn-walk] outside '<building>'                                              (on leaving)
// (the per-building `[thalyn-walk] bvh '<b>' <tris> tris in <ms> ms` line is printed by thalyn-interiors.js when it builds.)
import * as THREE from 'three';
import { readDoorBoxes, inDoorBox } from './thalyn-interiors.js?v=20261009p2';

export function makeIndoorProbe(getInteriors, shellEntries) {
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = false;   // short rays, BVH-accelerated: every hit, nearest first, so a door leaf can be skipped to what lies past it
  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3(), _im = new THREE.Matrix4();
  const _p = { x: 0, y: 0, z: 0 };
  let shellDoors = [];
  let lastKey = null, lastFloor = null, lastStorey = -1, lastBuilding = '';

  function reset() { shellDoors = []; lastKey = null; lastFloor = null; lastStorey = -1; lastBuilding = ''; }
  function setDoors(list) {
    shellDoors = readDoorBoxes(list);
    const it = getInteriors();
    console.info(`[thalyn-walk] doors: ${shellDoors.length} shell + ${it ? it.doorBoxCount : 0} interior box(es)` +
      (shellDoors.length || (it && it.doorBoxCount) ? ' — closed doors are walked through' : ' (none in this export — a closed door stops the walker indoors)'));
  }

  function lazyBvh(mesh) {
    const g = mesh.geometry;
    if (g && !g.boundsTree && g.attributes.position && g.attributes.position.count > 3000) { try { g.computeBoundsTree(); } catch (e) { /* linear */ } }
  }
  // The nearest hit on `mesh` along the current ray that is not inside a door box (or null).
  function firstSolid(mesh, doors) {
    const hits = ray.intersectObject(mesh, false);
    for (const h of hits) if (!inDoorBox(doors, h.point)) return h;
    return null;
  }
  function shellUnder(x, z, yLo, yHi, pad = 0) {
    const out = [];
    for (const e of shellEntries) {
      const b = e.box;
      if (x < b.min.x - pad || x > b.max.x + pad || z < b.min.z - pad || z > b.max.z + pad || b.max.y < yLo || b.min.y > yHi) continue;
      out.push(e.mesh);
    }
    return out;
  }
  function storeyOf(u, y) {
    const lo = u.center[1] - u.extents[1], h = 2 * u.extents[1];
    const n = u.storeys > 0 ? u.storeys : Math.max(1, Math.round(h / 3));
    return Math.min(n - 1, Math.max(0, Math.floor((y - lo) / (h / n) + 1e-3)));
  }
  function here(x, feetY, z) {
    const it = getInteriors();
    if (!it || !it.residentFor) return null;
    _p.x = x; _p.y = feetY + 0.3; _p.z = z;
    const r = it.residentFor(_p);
    return r && r.bvhReady ? r : null;   // a phone still slicing its BVH: outdoors rules until it is ready
  }

  function floor(x, feetY, z) {
    const r = here(x, feetY, z);
    if (!r) {
      if (lastKey !== null) { console.info(`[thalyn-walk] outside '${lastBuilding}'`); lastKey = null; lastFloor = null; lastStorey = -1; }
      return undefined;
    }
    const k = getInteriors().knobs;
    const doors = r.doors.length ? (shellDoors.length ? r.doors.concat(shellDoors) : r.doors) : shellDoors;
    _o.set(x, feetY + k.stepUpM, z); _d.set(0, -1, 0);
    ray.set(_o, _d); ray.near = 0; ray.far = k.stepUpM + k.fallGuardM;
    let best = null;
    for (const m of r.meshes) {   // ALL the building's meshes (band-hidden ones too): the floor under you never vanishes
      const bx = m.box;
      if (x < bx.min.x || x > bx.max.x || z < bx.min.z || z > bx.max.z || m.yMax < _o.y - ray.far || m.yMin > _o.y) continue;
      const h = firstSolid(m.mesh, doors);
      if (h && (best === null || h.point.y > best)) best = h.point.y;
    }
    for (const mesh of shellUnder(x, z, _o.y - ray.far, _o.y)) {
      lazyBvh(mesh);
      const h = firstSolid(mesh, doors);
      if (h && (best === null || h.point.y > best)) best = h.point.y;
    }
    if (best === null) return (lastKey === r.key && lastFloor !== null) ? lastFloor : undefined;   // fall-through guard
    const s = storeyOf(r.unit, best);
    if (lastKey !== r.key || s !== lastStorey)
      console.info(`[thalyn-walk] inside '${r.building}' storey ${s} · floor y=${best.toFixed(2)} · bvh ${r.bvhMs.toFixed(0)} ms`);
    lastKey = r.key; lastFloor = best; lastStorey = s; lastBuilding = r.building;
    return best;
  }

  function wall(ox, oz, x, z, feetY) {
    const dx = x - ox, dz = z - oz, len = Math.hypot(dx, dz);
    if (len < 1e-5) return null;
    const r = here(x, feetY, z) || here(ox, feetY, oz);
    if (!r) return null;
    const k = getInteriors().knobs;
    const doors = r.doors.length ? (shellDoors.length ? r.doors.concat(shellDoors) : r.doors) : shellDoors;
    const chest = feetY + k.chestM, reach = len + k.wallRayM;
    const fx = dx / len, fz = dz / len;
    const meshes = [];
    for (const m of r.meshes) {   // only what you can SEE stops you (B2's hidden storeys do not)
      if (!m.mesh.visible || m.yMax < chest || m.yMin > chest) continue;
      const bx = m.box;
      if (Math.max(ox, x) + reach < bx.min.x || Math.min(ox, x) - reach > bx.max.x || Math.max(oz, z) + reach < bx.min.z || Math.min(oz, z) - reach > bx.max.z) continue;
      meshes.push(m.mesh);
    }
    for (const mesh of shellUnder((ox + x) / 2, (oz + z) / 2, chest, chest, reach)) { lazyBvh(mesh); meshes.push(mesh); }
    if (!meshes.length) return null;
    let px = x, pz = z, moved = false;
    const spread = THREE.MathUtils.degToRad(k.wallSpreadDeg);
    for (const a of [0, spread, -spread]) {
      const c = Math.cos(a), s = Math.sin(a);
      _o.set(ox, chest, oz); _d.set(fx * c - fz * s, 0, fx * s + fz * c);
      ray.set(_o, _d); ray.near = 0; ray.far = reach;
      let hit = null;
      for (const mesh of meshes) { const h = firstSolid(mesh, doors); if (h && h.face && (!hit || h.distance < hit.distance)) hit = h; }
      if (!hit) continue;
      // the hit's horizontal normal in world space, facing the walker (an instanced piece carries its instance matrix too)
      _n.copy(hit.face.normal);
      if (hit.object.isInstancedMesh && hit.instanceId !== undefined) { hit.object.getMatrixAt(hit.instanceId, _im); _im.premultiply(hit.object.matrixWorld); _nm.getNormalMatrix(_im); }
      else _nm.getNormalMatrix(hit.object.matrixWorld);
      _n.applyMatrix3(_nm); _n.y = 0;
      const nl = Math.hypot(_n.x, _n.z);
      if (nl < 0.2) continue;   // a floor, a ceiling or a stair tread seen edge-on — not a wall
      _n.x /= nl; _n.z /= nl;
      if (_n.x * _d.x + _n.z * _d.z > 0) { _n.x = -_n.x; _n.z = -_n.z; }
      const sd = (px - hit.point.x) * _n.x + (pz - hit.point.z) * _n.z;
      if (sd < k.wallRadiusM) { const push = k.wallRadiusM - sd; px += _n.x * push; pz += _n.z * push; moved = true; }
    }
    return moved ? { x: px, z: pz } : null;
  }

  return { floor, wall, setDoors, reset, get shellDoors() { return shellDoors.length; } };
}
