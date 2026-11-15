// ★ WORLD AS DATA · PHASE 1 · COLLISION (client 2, 2026-11-15). Design §3.2 thalyn-collide.js: one static collision world the body asks.
// PURE at the top (no three.js import - THREE is handed in where a raycast is needed), so node tests it: node viewer/thalyn-collide.test.mjs.
//
// What blocks a walker sideways (the body's env.block), in this order:
//   1. TRUNKS  - circles from extras.thalyn.living.trunks (A308, moved here from thalyn-atmos.js unchanged)
//   2. MESHES  - NEW: two horizontal rays (knee above the step, chest) against the world's own walk meshes (every non-foliage mesh the viewer
//                already stands on: heroes, props, fences, walls, rocks, the terrain), with the ground probe's lazy BVHs. A hit = slide along it.
//                ⚠ The export carries NO per-object collision data (gltfpack strips node names, so a mesh's kind cannot be read): the viewer
//                therefore collides with what it can SEE. Foliage-named meshes never block (the same FOLIAGE rule the ground probe uses);
//                invisible app colliders do not travel. Phase 3's kit.collider replaces this for instances.
//   3. INDOOR walls, 4. CLOSED door leaves, 5. a CARD's fence  - the existing probes (thalyn-indoors.js, thalyn-doors.js, thalyn-card.js), chained.
// Low obstacles (kerbs, stairs, a rock under 0.6 m) are not blockers at all: the body steps up them (thalyn-body.js stepUpM).

/** A308 · the trees you cannot walk through: circles of `radius` round each trunk point (flat x,z pairs, glTF frame). */
export function makeTrunkField(radius = 0.45) {
  const CELL = 8; let cells = new Map(), count = 0;
  const key = (cx, cz) => cx + ',' + cz;
  function set(flat) {
    cells = new Map(); count = 0;
    if (!Array.isArray(flat)) return;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = +flat[i], z = +flat[i + 1]; if (!isFinite(x) || !isFinite(z)) continue;
      const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
      let c = cells.get(k); if (!c) { c = []; cells.set(k, c); }
      c.push(x, z); count++;
    }
  }
  function resolve(x, z) {
    if (!count) return null;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let ox = x, oz = z, moved = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = cells.get(key(cx + dx, cz + dz)); if (!c) continue;
      for (let i = 0; i < c.length; i += 2) {
        const tx = c[i], tz = c[i + 1];
        let ddx = ox - tx, ddz = oz - tz; const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2) || 1e-4; if (d < 1e-4) { ddx = 1e-4; ddz = 0; }
        ox = tx + ddx / d * radius; oz = tz + ddz / d * radius; moved = true;
      }
    }
    return moved ? { x: ox, z: oz } : null;
  }
  return { set, resolve, get count() { return count; } };
}

/**
 * Slide a move (ox,oz → nx,nz) along a vertical wall hit at distance `dist` from (ox,oz) with horizontal normal (wnx, wnz), keeping `radius`
 * clear of it. Returns the resolved {x, z}. Pure.
 */
export function slideAlong(ox, oz, nx, nz, dist, wnx, wnz, radius) {
  const mx = nx - ox, mz = nz - oz, len = Math.hypot(mx, mz);
  if (len < 1e-9) return { x: ox, z: oz };
  const dx = mx / len, dz = mz / len;
  let nl = Math.hypot(wnx, wnz);
  if (nl < 1e-6) { wnx = -dx; wnz = -dz; nl = 1; }
  wnx /= nl; wnz /= nl;
  if (wnx * dx + wnz * dz > 0) { wnx = -wnx; wnz = -wnz; }   // the normal faces the mover
  // the wall plane passes through the hit point; the end must stay `radius` on the mover's side of it. Pushing the end straight back out
  // along the normal removes exactly the part of the move that went into the wall: the rest slides along it (and a start already inside
  // the radius is pushed back out too).
  const hx = ox + dx * dist, hz = oz + dz * dist;
  const sd = (nx - hx) * wnx + (nz - hz) * wnz;
  if (sd >= radius) return { x: nx, z: nz };
  return { x: nx + wnx * (radius - sd), z: nz + wnz * (radius - sd) };
}

/** Chain sideways blockers (each fn(ox, oz, nx, nz, feetY) -> {x, z} | null). Each sees the move as the previous ones left it. Null = nothing moved it. */
export function chainBlockers(list) {
  const fns = (list || []).filter(f => typeof f === 'function');
  return (ox, oz, nx, nz, feetY) => {
    let x = nx, z = nz, moved = false;
    for (const f of fns) { const r = f(ox, oz, x, z, feetY); if (r && Number.isFinite(r.x) && Number.isFinite(r.z)) { x = r.x; z = r.z; moved = true; } }
    return moved ? { x, z } : null;
  };
}

/** Adapt a point resolver (x, z) -> {x, z} | null (the trunk field, the card fence) to the blocker signature. */
export const pointBlocker = fn => (ox, oz, nx, nz) => fn(nx, nz);

/**
 * NEW · the mesh side probe: two horizontal rays from where the step began, toward where it wants to end, at `heights` above the feet
 * (default: just above the step height, and chest). The nearest hit inside move + radius slides the move along that face.
 * `entries` = the walk meshes ({mesh, box}, the array the ground probe reads - it may be rebuilt in place). THREE is handed in.
 */
export function makeMeshSideProbe(THREE, entries, opts = {}) {
  const radius = opts.radius != null ? opts.radius : 0.35;
  let heights = opts.heights || [0.75, 1.45];
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const o = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  const skip = typeof opts.skip === 'function' ? opts.skip : null;
  function probe(ox, oz, nx, nz, feetY) {
    const mx = nx - ox, mz = nz - oz, len = Math.hypot(mx, mz);
    if (len < 1e-6) return null;
    d.set(mx / len, 0, mz / len);
    const far = len + radius;
    let best = null;
    const lo = Math.min(ox, nx) - radius, hi = Math.max(ox, nx) + radius, lz = Math.min(oz, nz) - radius, hz = Math.max(oz, nz) + radius;
    for (const h of heights) {
      const y = feetY + h;
      o.set(ox, y, oz); ray.set(o, d); ray.far = far;
      for (const e of entries) {
        const b = e.box;
        if (hi < b.min.x || lo > b.max.x || hz < b.min.z || lz > b.max.z || y < b.min.y || y > b.max.y) continue;
        if (skip && skip(e)) continue;
        const g = e.mesh.geometry;
        if (g && !g.boundsTree && g.attributes && g.attributes.position && g.attributes.position.count > 3000 && g.computeBoundsTree) { try { g.computeBoundsTree(); } catch (err) { /* linear */ } }
        const hits = ray.intersectObject(e.mesh, false);
        if (!hits.length) continue;
        const hit = hits[0];
        if (best && hit.distance >= best.dist) continue;
        if (hit.face) { nm.getNormalMatrix(e.mesh.matrixWorld); n.copy(hit.face.normal).applyMatrix3(nm); }
        else n.set(-d.x, 0, -d.z);
        if (Math.abs(n.y) > 0.75) continue;   // a floor or a roof face met edge-on is the ground probe's business, not a wall
        best = { dist: hit.distance, nx: n.x, nz: n.z };
      }
    }
    if (!best) return null;
    return slideAlong(ox, oz, nx, nz, best.dist, best.nx, best.nz, radius);
  }
  probe.setHeights = hs => { if (Array.isArray(hs) && hs.length) heights = hs.filter(Number.isFinite); };
  return probe;
}
