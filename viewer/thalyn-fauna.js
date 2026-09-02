// Thalyn® — living worlds: THE ANIMALS (A166, 2026-09-02).
//
// A Thalyn export never carries an animal mesh. It carries what the animals DO — `extras.thalyn.living.fauna`:
// the creatures the maker's walk had (species, where they stood, which way they faced, how long they are),
// the world's own routed paths (the fox's trot loop), and the roofline perches birds land on. This module
// owns ONE animated .glb per species (creatures/<species>.glb — made once by BlenderPipeline/
// export_creature_glb.py from the same rig the app animates, cached by the browser for ever) and drives
// them the way the app drives its own: a fox trots the path and sits to watch you, a deer grazes at the
// treeline and bolts when you close in, a rabbit lollops and freezes, wolves and bears prowl their ground;
// songbirds (owls after dark) fly routes between the world's edge, its shores and its rooftops, bank on
// the turns, land, and lift off when you come too near. Bird routes are rolled here from the same rules
// the app rolls its own by — they are random per walk there too.
//
// Everything budgets against the quality tier (creatures / bird routes / perched birds) and sleeps beyond
// its viewing distance. A species whose .glb is missing is skipped with one console line, never a crash.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const CREATURE_SLEEP_M = 250, BIRD_SLEEP_M = 420;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerpAngle = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

// Per-species behaviour — the app's own numbers (AmbientFauna.cs constants), clip names from
// animate_creature.py: quadrupeds walk / trot / idle / sit / graze, birds flap / glide / perch_hop / takeoff / idle_perch.
const SPEC = {
  fox:    { move: 'trot', movePace: 2.3, idle: ['sit', 'idle'],   slow: 2.3, fast: 4.6, homeR: 0,  path: true,  notice: 18, flee: 8,  hide: [60, 120], pause: [4, 8],   every: [25, 60], watch: true,  lengthM: 1.05 },
  deer:   { move: 'walk', movePace: 1.3, idle: ['graze', 'idle'], slow: 1.3, fast: 8.5, homeR: 12, path: false, notice: 30, flee: 18, hide: [90, 180], pause: [20, 40], every: [10, 25], watch: true,  lengthM: 2.2 },
  rabbit: { move: 'walk', movePace: 0.9, idle: ['graze', 'sit'],  slow: 0.9, fast: 3.6, homeR: 8,  path: false, notice: 12, flee: 6,  hide: [40, 90],  pause: [3, 8],   every: [4, 10],  watch: false, lengthM: 0.5 },
  wolf:   { move: 'walk', movePace: 1.2, idle: ['sit', 'idle'],   slow: 1.2, fast: 1.2, homeR: 20, path: false, notice: 0,  flee: 0,  hide: [0, 0],    pause: [6, 15],  every: [15, 40], watch: false, lengthM: 1.6 },
  bear:   { move: 'walk', movePace: 1.0, idle: ['idle', 'graze'], slow: 1.0, fast: 1.0, homeR: 20, path: false, notice: 0,  flee: 0,  hide: [0, 0],    pause: [8, 20],  every: [15, 40], watch: false, lengthM: 2.0 },
};
const BIRD = { songbird: { lengthM: 0.30, flyScale: 2.6 }, owl: { lengthM: 0.42, flyScale: 2.4 } };

export function makeFauna(scene, getLoader, groundAt, base = 'creatures/') {
  const root = new THREE.Group(); root.name = 'Thalyn_Fauna'; scene.add(root);
  const protos = new Map();         // species → Promise<{scene, clips, length, minY, height}|null>
  const creatures = [];             // quadrupeds
  const birds = [];                 // flying + perched
  let budget = { creatures: 48, birdRoutes: 6, perched: 24 };
  let night = 0, tone = '', ctx = null, built = 0, missing = new Set();
  const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

  // ── Species prototypes ──
  function proto(species) {
    if (protos.has(species)) return protos.get(species);
    const loader = getLoader();
    const p = loader.loadAsync(base + species + '.glb').then(g => {
      const s = g.scene;
      s.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = true; if (o.material) { o.material.side = THREE.FrontSide; } } });
      const box = new THREE.Box3().setFromObject(s);
      const size = box.getSize(new THREE.Vector3());
      const clips = new Map();
      for (const c of (g.animations || [])) { const n = String(c.name).split('|').pop().toLowerCase(); clips.set(n, c); }
      console.info('[fauna] ' + species + '.glb — ' + [...clips.keys()].join(' ') + ' · ' + size.x.toFixed(2) + '×' + size.y.toFixed(2) + '×' + size.z.toFixed(2) + ' m');
      return { scene: s, clips, length: Math.max(size.x, size.z, 0.01), minY: box.min.y, height: size.y };
    }).catch(e => { if (!missing.has(species)) { missing.add(species); console.warn('[fauna] no ' + base + species + '.glb — ' + species + ' skipped (' + (e && e.message) + ')'); } return null; });
    protos.set(species, p);
    return p;
  }

  function instance(pr, lengthM) {
    const obj = skeletonClone(pr.scene);
    const scale = lengthM / pr.length;
    obj.scale.setScalar(scale);
    obj.position.y = -pr.minY * scale;   // feet on the group's origin
    const g = new THREE.Group(); g.add(obj);
    const mixer = new THREE.AnimationMixer(obj);
    const actions = new Map();
    for (const [n, c] of pr.clips) { const a = mixer.clipAction(c); a.enabled = true; a.setEffectiveWeight(0); a.play(); actions.set(n, a); }
    return { g, obj, mixer, actions, scale, current: null };
  }
  function play(inst, name, fade = 0.35, timeScale = 1) {
    const a = inst.actions.get(name) || inst.actions.get(name === 'trot' ? 'walk' : name === 'walk' ? 'trot' : 'idle') || [...inst.actions.values()][0];
    if (!a) return;
    a.timeScale = timeScale;
    if (inst.current === a) return;
    if (inst.current) inst.current.crossFadeTo(a, fade, false); else a.setEffectiveWeight(1);
    a.enabled = true; a.setEffectiveWeight(1); a.reset(); a.play();
    if (inst.current && inst.current !== a) { const prev = inst.current; setTimeout(() => { if (inst.current !== prev) prev.setEffectiveWeight(0); }, fade * 1000 + 50); }
    inst.current = a;
  }

  // ── Ground ──
  function ground(x, z, hint) { try { const y = groundAt(x, z, (hint == null ? 500 : hint) + 40); return (typeof y === 'number' && isFinite(y)) ? y : null; } catch (e) { return null; } }

  // ── Paths (the fox's loop): polylines in the glTF frame, grounded once ──
  let polylines = [];
  function preparePaths(paths) {
    polylines = [];
    for (const p of (paths || [])) {
      const f = p && p.points; if (!Array.isArray(f) || f.length < 6) continue;
      const pts = [];
      for (let i = 0; i + 2 < f.length; i += 3) {
        const x = f[i], y0 = f[i + 1], z = f[i + 2];
        const y = ground(x, z, y0 > 0 ? y0 : null); pts.push(new THREE.Vector3(x, y == null ? y0 : y, z));
      }
      if (pts.length >= 2) polylines.push(pts);
    }
  }
  function nearestPolyline(pos) {
    let best = null, bd = Infinity, bi = 0;
    for (const pl of polylines) for (let i = 0; i < pl.length; i++) { const d = pl[i].distanceToSquared(pos); if (d < bd) { bd = d; best = pl; bi = i; } }
    return best ? { pl: best, i: bi, d: Math.sqrt(bd) } : null;
  }

  // ── Creatures ──
  function addCreature(c, index) {
    const species = String(c.species || '').toLowerCase();
    const spec = SPEC[species]; if (!spec) { if (!missing.has(species)) { missing.add(species); console.info('[fauna] unknown species "' + species + '" — skipped'); } return; }
    if (!Array.isArray(c.pos) || c.pos.length < 3) return;
    const home = new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]);
    const gy = ground(home.x, home.z, home.y); if (gy != null) home.y = gy;
    const rec = { species, spec, home, index, lengthM: clamp(Number(c.lengthM) || spec.lengthM, spec.lengthM * 0.5, spec.lengthM * 2), yaw: (Number(c.yawDeg) || 0) * Math.PI / 180,
      inst: null, state: 'pause', t: rnd(0.5, 3), target: null, pos: home.clone(), vel: 0, hidden: false, hideT: 0, path: null, dir: 1, seen: 0, awake: true, vis: 1 };
    creatures.push(rec);
    proto(species).then(pr => {
      if (!pr || !creatures.includes(rec)) return;
      rec.inst = instance(pr, rec.lengthM);
      rec.inst.g.position.copy(rec.pos); rec.inst.g.rotation.y = rec.yaw;
      root.add(rec.inst.g);
      if (spec.path && polylines.length) { const n = nearestPolyline(rec.pos); if (n && n.d < 60) { rec.path = n.pl; rec.pathI = n.i; } }
      play(rec.inst, spec.idle[0], 0);
      built++;
    });
  }

  function pickTarget(r) {
    const s = r.spec;
    if (r.path) {
      let i = r.pathI + r.dir;
      if (i < 0 || i >= r.path.length) { r.dir = -r.dir; i = r.pathI + r.dir; }
      r.pathI = clamp(i, 0, r.path.length - 1);
      r.target = r.path[r.pathI].clone();
      return;
    }
    const a = rnd(0, Math.PI * 2), d = rnd(s.homeR * 0.25, s.homeR);
    const x = r.home.x + Math.cos(a) * d, z = r.home.z + Math.sin(a) * d;
    const y = ground(x, z, r.pos.y); r.target = new THREE.Vector3(x, y == null ? r.pos.y : y, z);
  }

  function tickCreature(r, dt, cam) {
    const s = r.spec, inst = r.inst; if (!inst) return;
    const dCam = r.pos.distanceTo(cam);
    if (r.state !== 'hidden' && dCam > CREATURE_SLEEP_M) { if (r.awake) { r.awake = false; inst.g.visible = false; } return; }
    if (!r.awake && r.state !== 'hidden') { r.awake = true; inst.g.visible = true; }
    r.t -= dt;
    // notice / flee (the app's own radii)
    if (s.flee > 0 && r.state !== 'hidden' && r.state !== 'flee' && dCam < s.flee) { r.state = 'flee'; r.t = 6; r.fleeFrom = cam.clone(); play(inst, 'trot', 0.2, s.fast / Math.max(0.5, s.movePace)); }
    else if (s.watch && s.notice > 0 && r.state === 'move' && dCam < s.notice && dCam > s.flee) { r.state = 'watch'; r.t = rnd(4, 9); play(inst, s.species === 'fox' ? 'sit' : 'idle', 0.4); }

    switch (r.state) {
      case 'pause': if (r.t <= 0) { r.state = 'move'; pickTarget(r); r.moveT = rnd(s.every[0], s.every[1]); play(inst, s.move, 0.35, s.slow / s.movePace); } break;
      case 'watch': { _d.subVectors(cam, r.pos); r.yaw = lerpAngle(r.yaw, Math.atan2(_d.x, _d.z), dt * 3); if (r.t <= 0) { r.state = 'pause'; r.t = rnd(1, 3); play(inst, s.idle[1] || s.idle[0], 0.4); } break; }
      case 'move': {
        if (!r.target) pickTarget(r);
        _d.subVectors(r.target, r.pos); _d.y = 0; const dist = _d.length();
        if (dist < 0.6) { r.moveT -= 0; if (r.path) pickTarget(r); else { r.state = 'pause'; r.t = rnd(s.pause[0], s.pause[1]); play(inst, s.idle[Math.random() < 0.5 ? 0 : 1] || s.idle[0], 0.4); break; } }
        else { _d.multiplyScalar(1 / dist); const step = Math.min(dist, s.slow * dt); r.pos.addScaledVector(_d, step); r.yaw = lerpAngle(r.yaw, Math.atan2(_d.x, _d.z), dt * 4); }
        r.moveT = (r.moveT || 10) - dt;
        if (r.path && r.moveT <= 0) { r.state = 'pause'; r.t = rnd(s.pause[0], s.pause[1]); play(inst, s.idle[Math.random() < 0.5 ? 0 : 1] || s.idle[0], 0.4); }
        break;
      }
      case 'flee': {
        _d.subVectors(r.pos, r.fleeFrom); _d.y = 0; if (_d.lengthSq() < 1e-4) _d.set(1, 0, 0); _d.normalize();
        if (r.path) { // along the path, away from the viewer
          const ahead = r.path[clamp(r.pathI + r.dir, 0, r.path.length - 1)]; _c.subVectors(ahead, r.pos); _c.y = 0;
          if (_c.dot(_d) < 0) r.dir = -r.dir;
          pickTarget(r); _d.subVectors(r.target, r.pos); _d.y = 0; if (_d.lengthSq() > 1e-4) _d.normalize();
        }
        r.pos.addScaledVector(_d, s.fast * dt); r.yaw = lerpAngle(r.yaw, Math.atan2(_d.x, _d.z), dt * 6);
        r.vis = Math.max(0, r.vis - dt / 5);
        if (r.t <= 0 || r.pos.distanceTo(r.fleeFrom) > 45) { r.state = 'hidden'; r.hideT = rnd(s.hide[0], s.hide[1]); inst.g.visible = false; }
        break;
      }
      case 'hidden': {
        r.hideT -= dt;
        if (r.hideT <= 0 && dCam > s.notice + 5) { r.state = 'pause'; r.t = rnd(1, 3); r.vis = 1; r.pos.copy(r.home); const gy = ground(r.home.x, r.home.z, r.home.y); if (gy != null) r.pos.y = gy; if (r.path) { const n = nearestPolyline(r.pos); if (n) r.pathI = n.i; } inst.g.visible = true; play(inst, s.idle[0], 0); }
        return;
      }
    }
    // ground conform + place
    const gy = ground(r.pos.x, r.pos.z, r.pos.y); if (gy != null) r.pos.y += (gy - r.pos.y) * Math.min(1, dt * 10);
    inst.g.position.copy(r.pos); inst.g.rotation.y = r.yaw;
    inst.mixer.update(dt);
  }

  // ── Birds ──
  let perches = [], shores = [], edgeR = 120, centre = new THREE.Vector3();
  function birdKind() { return night > 0.5 ? 'owl' : 'songbird'; }
  function randomEdge(alt) { const a = rnd(0, Math.PI * 2); const r = edgeR * rnd(0.8, 1.05); const x = centre.x + Math.cos(a) * r, z = centre.z + Math.sin(a) * r; const g = ground(x, z, null); return new THREE.Vector3(x, (g == null ? centre.y : g) + alt, z); }
  function randomDest() {
    const u = Math.random();
    if (perches.length && u < 0.35) { const p = perches[Math.floor(Math.random() * perches.length)]; return { pos: p.clone(), kind: 'perch' }; }
    if (shores.length && u < 0.65) { const p = shores[Math.floor(Math.random() * shores.length)]; return { pos: p.clone(), kind: 'shore' }; }
    return { pos: randomEdge(rnd(25, 90)), kind: 'edge' };
  }
  function addRoute() {
    const kind = birdKind(), bk = BIRD[kind];
    const n = Math.floor(rnd(3, 7));
    const route = { birds: [], kind, from: randomEdge(rnd(25, 90)), dest: randomDest(), speed: rnd(6, 11), t: 0, phase: 'fly', rest: 0 };
    for (let i = 0; i < n; i++) {
      const b = { route, kind, off: new THREE.Vector3(rnd(-6, 6), rnd(-2, 2), rnd(-6, 6)), pos: route.from.clone(), yaw: 0, roll: 0, inst: null, perched: false, scale: bk.lengthM * bk.flyScale * rnd(0.85, 1.25), flapT: rnd(0, 5) };
      b.pos.add(b.off);
      route.birds.push(b); birds.push(b);
      proto(kind).then(pr => { if (!pr || !birds.includes(b)) return; b.inst = instance(pr, b.scale); root.add(b.inst.g); play(b.inst, 'flap', 0); });
    }
    return route;
  }
  function addPerched(perch) {
    const kind = birdKind(), bk = BIRD[kind];
    const b = { kind, pos: perch.clone(), home: perch.clone(), yaw: rnd(0, Math.PI * 2), inst: null, perched: true, scale: bk.lengthM * rnd(0.85, 1.2), state: 'perch', t: rnd(0, 4), flee: rnd(10, 14), away: null };
    birds.push(b);
    proto(kind).then(pr => { if (!pr || !birds.includes(b)) return; b.inst = instance(pr, b.scale); b.inst.g.position.copy(b.pos); b.inst.g.rotation.y = b.yaw; root.add(b.inst.g); play(b.inst, 'idle_perch', 0); });
  }
  const routes = [];
  function tickRoute(rt, dt, cam) {
    // the route's head flies from → dest; birds trail it with their offsets
    if (rt.phase === 'fly') {
      _d.subVectors(rt.dest.pos, rt.from); const dist = _d.length();
      if (dist < 2) { rt.phase = 'rest'; rt.rest = rt.dest.kind === 'perch' ? rnd(20, 60) : rnd(5, 20); }
      else { _d.multiplyScalar(1 / dist); rt.from.addScaledVector(_d, Math.min(dist, rt.speed * dt)); rt.head = _d.clone(); }
    } else { rt.rest -= dt; if (rt.rest <= 0) { rt.phase = 'fly'; rt.dest = randomDest(); rt.speed = rnd(6, 11); } }
    for (const b of rt.birds) {
      const inst = b.inst; if (!inst) continue;
      const landing = rt.phase === 'rest' && rt.dest.kind === 'perch';
      // target = head + offset (offsets collapse when landing on a perch)
      _c.copy(rt.from); if (!landing) _c.add(b.off);
      const dCam = b.pos.distanceTo(cam);
      if (dCam > BIRD_SLEEP_M) { if (inst.g.visible) inst.g.visible = false; b.pos.copy(_c); continue; }
      if (!inst.g.visible) inst.g.visible = true;
      _d.subVectors(_c, b.pos); const d = _d.length();
      const sp = rt.phase === 'fly' ? rt.speed * (1 + Math.min(0.6, d / 30)) : 4;
      if (d > 0.05) { _d.multiplyScalar(1 / d); b.pos.addScaledVector(_d, Math.min(d, sp * dt)); const want = Math.atan2(_d.x, _d.z); const dy = lerpAngle(b.yaw, want, 1) - b.yaw; b.roll = THREE.MathUtils.lerp(b.roll, clamp(-dy * 2.2, -0.9, 0.9), dt * 3); b.yaw = lerpAngle(b.yaw, want, dt * 2.5); }
      else b.roll = THREE.MathUtils.lerp(b.roll, 0, dt * 3);
      b.flapT -= dt;
      if (landing && d < 0.3) { if (inst.current !== inst.actions.get('idle_perch')) play(inst, 'idle_perch', 0.3); }
      else if (b.flapT <= 0) { const glide = Math.random() < 0.35; play(inst, glide ? 'glide' : 'flap', 0.4); b.flapT = glide ? rnd(1.5, 4) : rnd(2, 6); }
      inst.g.position.copy(b.pos); inst.g.rotation.set(0, b.yaw, 0, 'YXZ'); inst.g.rotation.z = b.roll; inst.g.rotation.x = clamp(-_d.y * 0.6, -0.5, 0.5);
      inst.mixer.update(dt);
    }
  }
  function tickPerched(b, dt, cam) {
    const inst = b.inst; if (!inst) return;
    const dCam = b.pos.distanceTo(cam);
    if (dCam > BIRD_SLEEP_M) { if (inst.g.visible) inst.g.visible = false; return; }
    if (!inst.g.visible && b.state !== 'gone') inst.g.visible = true;
    b.t -= dt;
    switch (b.state) {
      case 'perch':
        if (dCam < b.flee) { b.state = 'off'; b.t = rnd(3, 5); _d.subVectors(b.pos, cam); _d.y = 0; if (_d.lengthSq() < 1e-4) _d.set(1, 0, 0); _d.normalize(); b.away = _d.clone(); b.yaw = Math.atan2(_d.x, _d.z); play(inst, 'takeoff', 0.1); setTimeout(() => { if (b.state === 'off') play(inst, 'flap', 0.2); }, 350); }
        else if (b.t <= 0) { b.t = rnd(6, 20); play(inst, Math.random() < 0.3 ? 'perch_hop' : 'idle_perch', 0.3); }
        break;
      case 'off': b.pos.addScaledVector(b.away, 9 * dt); b.pos.y += 4 * dt; if (b.t <= 0) { b.state = 'gone'; b.t = rnd(40, 90); inst.g.visible = false; } break;
      case 'gone': if (b.t <= 0 && dCam > b.flee + 4) { b.state = 'perch'; b.t = rnd(2, 6); b.pos.copy(b.home); b.yaw = rnd(0, Math.PI * 2); inst.g.visible = true; play(inst, 'idle_perch', 0); } return;
    }
    inst.g.position.copy(b.pos); inst.g.rotation.set(0, b.yaw, 0);
    inst.mixer.update(dt);
  }

  // ── Build / clear ──
  function clear() {
    for (const r of creatures) if (r.inst) root.remove(r.inst.g);
    for (const b of birds) if (b.inst) root.remove(b.inst.g);
    creatures.length = 0; birds.length = 0; routes.length = 0; polylines = []; perches = []; shores = []; built = 0;
  }
  function build(fauna, c) {
    clear();
    ctx = c || {}; tone = String(ctx.tone || ''); night = +ctx.night || 0;
    if (ctx.center && Array.isArray(ctx.center)) centre.set(ctx.center[0], ctx.center[1], ctx.center[2]); else if (ctx.center && ctx.center.isVector3) centre.copy(ctx.center);
    edgeR = Math.max(40, +ctx.worldRadius || 120);
    // shores from the liquids (APP frame — negate X), sampled round each rectangle's edge
    for (const l of (ctx.liquids || [])) {
      if (!l || l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
      const cx = -l.centerXZ[0], cz = l.centerXZ[1], hx = Math.max(2, l.sizeXZ[0] * 0.5), hz = Math.max(2, l.sizeXZ[1] * 0.5), y = +l.surfaceY || 0;
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; shores.push(new THREE.Vector3(cx + Math.cos(a) * hx, y + 0.15, cz + Math.sin(a) * hz)); }
    }
    if (!fauna || !fauna.present) return { creatures: 0, birds: 0 };
    preparePaths(fauna.paths);
    for (const p of (fauna.perches || [])) if (p && Array.isArray(p.pos) && p.pos.length >= 3) perches.push(new THREE.Vector3(p.pos[0], p.pos[1] + 0.05, p.pos[2]));
    const list = (fauna.creatures || []).slice(0, budget.creatures);
    list.forEach((cr, i) => addCreature(cr, i));
    // birds: routes like the app (3-6 by scene size), perched 2-4 per roofline, both tier-capped
    const nRoutes = Math.min(budget.birdRoutes, edgeR < 120 ? 3 : edgeR < 260 ? 4 : 6);
    for (let i = 0; i < nRoutes; i++) routes.push(addRoute());
    let perchedLeft = budget.perched;
    for (const p of perches) { const k = Math.floor(rnd(2, 5)); for (let j = 0; j < k && perchedLeft > 0; j++, perchedLeft--) { const off = new THREE.Vector3(rnd(-1.1, 1.1), 0, rnd(-1.1, 1.1)); addPerched(p.clone().add(off)); } }
    console.info('[fauna] ' + list.length + ' creature(s) (' + list.map(x => x.species).join(', ') + '), ' + polylines.length + ' path(s), ' + perches.length + ' perch(es), ' + shores.length + ' shore point(s) → ' + nRoutes + ' bird route(s), ' + (budget.perched - perchedLeft) + ' perched ' + birdKind() + 's');
    return { creatures: list.length, birds: birds.length };
  }
  function setBudget(t) { budget = { creatures: t.creatures ?? 48, birdRoutes: t.birdRoutes ?? 6, perched: t.perched ?? 24 }; }
  function setNight(n) { night = n; }
  function tick(dt, camera) {
    dt = Math.min(0.1, dt);
    camera.getWorldPosition(_p);
    for (const r of creatures) tickCreature(r, dt, _p);
    for (const rt of routes) tickRoute(rt, dt, _p);
    for (const b of birds) if (b.perched) tickPerched(b, dt, _p);
  }
  return { build, clear, tick, setBudget, setNight,
    get count() { return creatures.length; }, get awake() { let n = 0; for (const r of creatures) if (r.inst && r.inst.g.visible) n++; return n; },
    get birds() { return birds.length; }, get ready() { return built; }, root };
}
