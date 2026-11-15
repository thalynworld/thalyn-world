// ★ WORLD AS DATA · PHASE 2 · THE RIDES (client 2, 2026-11-15; Mike 11-15: zip wire, seats, rope, lamps at night, the day curve, BOATS;
// NO balloon, NO world views). Design: client repo Core Designs/WORLD_AS_DATA_WEB_RECREATION_DESIGN_NOV15_2026.md §4 (one by one) · §6 phase 2.
// PURE: no three.js, no DOM - each ride is a small state machine over plain numbers; node tests it (node viewer/thalyn-rides.test.mjs).
// The numbers are the APP'S, carried per item in extras.thalyn.interact.items[].params (Unity GltfInteractExtras.cs) - the viewer never
// guesses them; the fallbacks below are the same constants, used only when an older row lacks a field.
//
// ⚠ The design doc §4 row 1 quotes the A128 eased zip (g·sin·0.95 − 0.12, ease-out over 15 %). That ride was DELETED by A7622 "fast ends"
// (ZipWire.cs:509-525, gate retired ON 10-25): launch at speed, ~1 s to terminal, a short stop in the last metres. This file copies the LIVE one.

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (o, k, d) => (o && finite(o[k]) ? o[k] : d);

// ═══ ZIP WIRE (Widgets/ZipWire.cs) ═══════════════════════════════════════════════════════════════════════════════════════════════
export const ZIP = Object.freeze({
  hangM: 1.10,                                                         // HangBelowCableM :194
  fastArrivalMps: 8,                                                   // FastArrivalMps :516
  house: { launch: 14, accel: 14, brakeM: 3 },                         // FastLaunchMps / FastAccelMps2 / FastBrakeM :513-515
  sky: { down: 55, up: 40, launch: 22, accel: 30, brakeM: 8 },         // A7627 SkyDownMps … :534
  terminal: { base: 22, perM: 0.06, ceil: 30 },                        // ZipMaxSpeed / ZipSpeedPerCableM / ZipMaxSpeedCeil :217-219
  shimmy: { mps: 6, sprintMps: 12, cadenceS: 0.30, slideMps: 0.9, bobM: 0.035, grabInsetM: 0.35, dropMaxM: 3 },   // :292-299
});

/** TerminalFor (ZipWire.cs:1521): a long cable runs faster, capped. */
export const zipTerminal = len => clamp(ZIP.terminal.base + Math.max(0, len) * ZIP.terminal.perM, ZIP.terminal.base, ZIP.terminal.ceil);

/** FastSpeed (ZipWire.cs:521): launch at speed, accelerate to terminal, the stop in the last brakeM metres (still arriving at 8 m/s). */
export function fastSpeed(v, dt, terminal, metresLeft, launchMps, accelMps2, brakeM, arrivalMps = ZIP.fastArrivalMps) {
  const launch = Math.min(launchMps, terminal);
  v = clamp(v + accelMps2 * dt, launch, terminal);
  if (metresLeft < brakeM) v = Math.min(v, lerp(arrivalMps, terminal, clamp(metresLeft / brakeM, 0, 1)));
  return v;
}

/**
 * A cable from its params: { pts: flat [x,y,z,…] (the app's curve samples, glTF frame), topA, topB, sag, sky, … }.
 * Returns { pts: [[x,y,z]…], cum: [...], length, topA, topB, sag, sky } or null when the row is unusable.
 */
export function makeCable(p) {
  if (!p || !Array.isArray(p.pts) || p.pts.length < 6) return null;
  const pts = [];
  for (let i = 0; i + 2 < p.pts.length; i += 3) { const x = +p.pts[i], y = +p.pts[i + 1], z = +p.pts[i + 2]; if (!finite(x) || !finite(y) || !finite(z)) return null; pts.push([x, y, z]); }
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const v3 = a => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(finite) ? a.slice(0, 3) : null);
  return { pts, cum, length: cum[cum.length - 1], topA: v3(p.topA) || pts[0], topB: v3(p.topB) || pts[pts.length - 1], sag: pick(p, 'sag', 0), sky: !!p.sky };
}

/** PointAt (ZipWire.cs:1808): the point at arc length s and the live tangent of the parabola (A→B). */
export function cablePoint(c, s) {
  s = clamp(s, 0, c.length);
  let i = 1;
  while (i < c.cum.length - 1 && c.cum[i] < s) i++;
  const seg = Math.max(1e-4, c.cum[i] - c.cum[i - 1]);
  const u = clamp((s - c.cum[i - 1]) / seg, 0, 1);
  const a = c.pts[i - 1], b = c.pts[i];
  const pos = [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
  const t = c.pts.length > 1 ? (i - 1 + u) / (c.pts.length - 1) : 0;
  let d = [c.topB[0] - c.topA[0], c.topB[1] - c.topA[1] - c.sag * 4 * (1 - 2 * t), c.topB[2] - c.topA[2]];
  if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= 1e-6) d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return { pos, tan: l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 1] };
}

/** The speed rows a cable rides on (params.down / params.up from the export, else the app's constants for its kind). */
export function zipSpeeds(c, p) {
  const down = p && p.down, up = p && p.up;
  if (c.sky) return {
    down: { terminal: pick(down, 'terminal', ZIP.sky.down), launch: pick(down, 'launch', ZIP.sky.launch), accel: pick(down, 'accel', ZIP.sky.accel), brakeM: pick(down, 'brakeM', ZIP.sky.brakeM) },
    up: { lift: true, terminal: pick(up, 'terminal', ZIP.sky.up), launch: pick(up, 'launch', ZIP.sky.launch), accel: pick(up, 'accel', ZIP.sky.accel), brakeM: pick(up, 'brakeM', ZIP.sky.brakeM) },
  };
  const sh = (up && up.shimmy) || {};
  return {
    down: { terminal: pick(down, 'terminal', zipTerminal(c.length)), launch: pick(down, 'launch', ZIP.house.launch), accel: pick(down, 'accel', ZIP.house.accel), brakeM: pick(down, 'brakeM', ZIP.house.brakeM) },
    up: { lift: false, shimmy: Object.fromEntries(Object.entries(ZIP.shimmy).map(([k, v]) => [k, pick(sh, k, v)])) },
  };
}

/**
 * Mount (ZipWire.cs:1418): from the high end = a zip DOWN (s from 0); from the low end = a powered LIFT on a sky cable, else the hand-over-hand
 * SHIMMY that takes hold grabInsetM off the post. Returns the ride state.
 */
export function zipStart(c, p, fromHigh) {
  const sp = zipSpeeds(c, p);
  if (fromHigh) return { kind: 'zip', mode: 'zip', s: 0, v: 0, phase: 0, bob: 0, sp };
  if (sp.up.lift) return { kind: 'zip', mode: 'lift', s: c.length, v: 0, phase: 0, bob: 0, sp };
  return { kind: 'zip', mode: 'shimmy', s: Math.max(0, c.length - sp.up.shimmy.grabInsetM), v: 0, phase: 0, bob: 0, sp };
}

/**
 * One frame of the ride (dt clamped to 0.05 like UpdateRide). input = { up, down, sprint } (W / S / Shift; a phone's stick forward / back).
 * Returns { eye: [x,y,z] (the camera: hangM under the cable, plus the shimmy bob), done: null | { atHigh } }.
 */
export function zipStep(r, c, input, dt) {
  dt = Math.min(dt, 0.05);
  let done = null;
  if (r.mode === 'zip') {
    const d = r.sp.down;
    r.v = fastSpeed(r.v, dt, d.terminal, c.length - r.s, d.launch, d.accel, d.brakeM);
    r.s += r.v * dt;
    if (r.s >= c.length) { r.s = c.length; done = { atHigh: false }; }
  } else if (r.mode === 'lift') {
    const u = r.sp.up;
    r.v = fastSpeed(r.v, dt, u.terminal, r.s, u.launch, u.accel, u.brakeM);
    r.s -= r.v * dt;
    if (r.s <= 0) { r.s = 0; done = { atHigh: true }; }
  } else {
    const sh = r.sp.up.shimmy;
    let move = 0;
    if (input && input.up) {
      const mps = input.sprint ? sh.sprintMps : sh.mps;
      r.phase = ((r.phase + dt / sh.cadenceS) % 1 + 1) % 1;
      const pull = Math.max(0, Math.sin(Math.PI * r.phase)) * (Math.PI * 0.5);   // mean of sin(πu) over a cycle is 2/π ⇒ mean pace = mps
      move = -mps * pull * dt;
      r.bob = Math.cos(Math.PI * 2 * r.phase) * sh.bobM;
    } else {
      if (input && input.down) { move = sh.slideMps * dt; r.phase = 0; }
      r.bob = r.bob > 0 ? Math.max(0, r.bob - dt * 0.2) : Math.min(0, r.bob + dt * 0.2);
    }
    r.v = Math.abs(move) / Math.max(1e-4, dt);
    r.s = clamp(r.s + move, 0, c.length);
    if (r.s <= 0.001) done = { atHigh: true };
    else if (input && input.down && r.s >= c.length - 0.001) done = { atHigh: false };
  }
  const { pos } = cablePoint(c, r.s);
  return { eye: [pos[0], pos[1] - ZIP.hangM + r.bob, pos[2]], done };
}

/** TryLetGo (ZipWire.cs:1569): only a shimmy may let go, and only over ground within dropMaxM of the feet. groundY = the ground under the eye. */
export function zipLetGo(r, eyeY, groundY, eyeM) {
  if (r.mode !== 'shimmy') return { ok: false, why: 'ride' };
  if (!finite(groundY)) return { ok: false, why: 'too high' };
  const fall = (eyeY - eyeM) - groundY;
  return fall <= r.sp.up.shimmy.dropMaxM ? { ok: true, fall: Math.max(0, fall) } : { ok: false, why: 'too high', fall };
}

// ═══ SEAT (Widgets/BenchAnchor.cs BenchSeat :617) ═════════════════════════════════════════════════════════════════════════════════
// E within reachM (OfferRadiusM 2.4) sits: the eye goes eyeAboveSeatM (0.75) over the seat - a SNAP, as the app does (Sit :791) - facing the spot's
// own way (a plain bench keeps your yaw). Any move key, Space or E stands you up at standAt (Stand :812), which the adapter grounds.
export const SEAT = Object.freeze({ reachM: 2.4, eyeAboveSeatM: 0.75 });

export function seatStart(p) {
  const seat = v3(p && p.seat); if (!seat) return null;
  return { kind: 'seat', eye: [seat[0], seat[1] + pick(p, 'eyeAboveSeatM', SEAT.eyeAboveSeatM), seat[2]], yawDeg: p.hasFacing ? pick(p, 'facingDeg', null) : null,
    standAt: v3(p.standAt) || seat };
}
/** input.pressed = a move key / Space / E went down this frame. */
export function seatStep(r, input) {
  return { eye: r.eye, done: input && input.pressed ? { feet: r.standAt, yawDeg: null } : null };
}

// ═══ ROPE CLIMB (Widgets/TreeHouse.Climb.cs) ══════════════════════════════════════════════════════════════════════════════════════
// E at the foot climbs up, E at the rope head climbs down (the nearer end within rangeM 3.0 wins). The path is a straight line foot ↔ deck landing,
// SmoothStep-eased, swung sideM (0.45) out along the open face and eased back over sideEaseM at each end (ClimbPoint); speed = ClimbSpeedFor(dist),
// at least 0.4 s; landing on the deck faces the open face (landYawDeg), stepping off at the bottom keeps your yaw.
export const ROPE = Object.freeze({ rangeM: 3.0, speedMps: 2.5, targetS: 3.2, sideM: 0.45, sideEaseM: 1.5, sideEaseS: 0.60 });
const smoothstep01 = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };   // Mathf.SmoothStep(0, 1, x)
export const ropeSpeedFor = dist => Math.max(ROPE.speedMps, dist / ROPE.targetS);   // ClimbSpeedFor (TreeHouse.cs:1041)

export function ropeStart(p, up) {
  const foot = v3(p && p.foot), land = v3(p && p.land); if (!foot || !land) return null;
  const from = up ? foot : land, to = up ? land : foot;
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const speed = pick(p, 'speedMps', ropeSpeedFor(dist));
  const sideEase = pick(p, 'sideEaseM', Math.max(ROPE.sideEaseM, speed * ROPE.sideEaseS));
  const out = v3(p.outward) || [0, 0, 1];
  return { kind: 'rope', up, from, to, dist, secs: Math.max(0.4, dist / speed), T: 0, sideM: pick(p, 'sideM', ROPE.sideM), sideEase, out,
    landYawDeg: up ? pick(p, 'landYawDeg', null) : null };
}
/** One frame: returns { feet: [x,y,z] (the adapter puts the eye eyeM above), done: null | { feet, yawDeg } }. */
export function ropeStep(r, dt) {
  r.T += Math.min(dt, 0.05) / r.secs;
  const k = smoothstep01(r.T);
  const near = Math.min(k, 1 - k) * r.dist;
  const side = smoothstep01(near / Math.max(0.01, r.sideEase)) * r.sideM;
  const feet = [0, 1, 2].map(c => lerp(r.from[c], r.to[c], k) + (c === 1 ? 0 : r.out[c] * side));
  return { feet, done: r.T >= 1 ? { feet: r.to.slice(), yawDeg: r.landYawDeg } : null };
}

// ═══ ROWBOAT (Widgets/ThalynRowboat.cs) ═══════════════════════════════════════════════════════════════════════════════════════════
// ⚠ The rowboat is fenced OUT of the demo APP (Mike 11-15); a full-game world's web viewer may still ride it.
// E within boardRangeM (3.5) of the hull - looking toward it beyond 1.2 m - boards; W/S stroke (back at 0.35), A/D turn; E steps off onto the nearest
// dry ground, bow side first (ThalynTransport.FindStepOff), or "No shore close enough" and you stay aboard. RideStep's numbers: speed MoveTowards
// the target at Accel (stroking) / Drag; turn = h × 40°/s × clamp01(0.3 + |speed|) reached at 120°/s²; a move is refused when it grounds MORE of the
// hull (MoveAllowed over 7 waterline probes: 5 along the keel, 2 at the beam). Not copied (the web has no colliders for them): the hull sweep
// against docks/rocks (A14462), the stuck-nudge (A14463), river currents (A13250) and the oars.
export const BOAT = Object.freeze({ boardRangeM: 3.5, maxSpeed: 2.2, accel: 1.2, drag: 1.1, turnDegPerS: 40, backFrac: 0.35, shoreRayHeadM: 1.2, shoreMarginM: 0.05, lookDot: 0.3, lookFromM: 1.2 });
const moveTowards = (v, target, maxDelta) => (Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta);
/** Turn a horizontal vector by deg about +Y (glTF frame; forward of yaw θ = (sin θ, cos θ)). */
export const rotY = (v, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; };

/** The boat's live pose from its row: { x, y, z (root), yawDeg (glTF), speed, yawVel, row }. */
export function boatFromRow(p) {
  const pos = v3(p && p.pos); if (!pos) return null;
  return { kind: 'boat', x: pos[0], y: pos[1], z: pos[2], yawDeg: pick(p, 'yawDeg', 0), yaw0: pick(p, 'yawDeg', 0), speed: 0, yawVel: 0, row: p };
}
// the row's local vectors live in the ROOT's frame: the root's world yaw turns them
function hullFrame(b, x, z, yawDeg) {
  const p = b.row, cL = v3(p.centerL) || [0, 0, 0], fL = v3(p.fwdL) || [0, 0, 1];
  const c = rotY(cL, yawDeg), f = rotY(fL, yawDeg);
  const fl = Math.hypot(f[0], f[2]) || 1;
  return { c: [x + c[0], z + c[2]], f: [f[0] / fl, f[2] / fl] };
}
/** The 7 waterline points of ProbeHull (stern … bow along the keel, then port / starboard at 0.85 of the half beam). */
export function hullPoints(b, x, z, yawDeg) {
  const { c, f } = hullFrame(b, x, z, yawDeg), l = [f[1], -f[0]];
  const hl = pick(b.row, 'halfLenM', 1), hw = pick(b.row, 'halfWM', 0.5);
  const pts = [-0.9, -0.45, 0, 0.45, 0.9].map(t => [c[0] + f[0] * t * hl, c[1] + f[1] * t * hl]);
  pts.push([c[0] - l[0] * 0.85 * hw, c[1] - l[1] * 0.85 * hw], [c[0] + l[0] * 0.85 * hw, c[1] + l[1] * 0.85 * hw]);
  return { pts, c };
}
/** WaterAtKeel per point: dry = no water there, or solid ground within shoreRayHeadM over / shoreMarginM under the water line. */
export function probeHull(b, env, x, z, yawDeg) {
  const { pts, c } = hullPoints(b, x, z, yawDeg);
  const head = pick(b.row, 'shoreRayHeadM', BOAT.shoreRayHeadM), margin = pick(b.row, 'shoreMarginM', BOAT.shoreMarginM);
  const dry = [];
  let n = 0, sx = 0, sz = 0;
  for (const [px, pz] of pts) {
    const w = env.water(px, pz);
    let d = w === null || w === undefined;
    if (!d) { const g = env.ground(px, pz, w + head); d = g !== null && g !== undefined && g >= w - margin; }
    dry.push(d);
    if (d) { n++; sx += px; sz += pz; }
  }
  return { dry, n, c, dc: n ? [sx / n, sz / n] : c };
}
/** MoveAllowed (ThalynRowboat.cs:502): fully afloat, or no MORE aground than now and (for a stroke) heading away from the bank. */
export function moveAllowed(now, next, sx, sz) {
  if (next.n === 0) return true;
  if (now.n === 0) return false;
  if (next.n < now.n) return true;
  if (next.n > now.n) return false;
  if (next.dry[2] && !now.dry[2]) return false;
  if (sx * sx + sz * sz < 1e-12) return true;
  const ax = now.c[0] - now.dc[0], az = now.c[1] - now.dc[1];
  return ax * ax + az * az < 1e-8 || sx * ax + sz * az > 0;
}
/** The seat's eye in the world at the boat's pose (seatL turned by the root's yaw, plus eyeOverSeatM). */
export function boatEye(b) {
  const s = rotY(v3(b.row.seatL) || [0, 0.3, 0], b.yawDeg);
  return [b.x + s[0], b.y + s[1] + pick(b.row, 'eyeOverSeatM', 0.9), b.z + s[2]];
}
/** One frame of rowing. input = { f (−1..1, W/S), r (−1..1, D/A) }. env = { water(x, z), ground(x, z, fromY) }. Returns { eye, aground }. */
export function boatStep(b, input, env, dt) {
  dt = Math.min(dt, 0.05);
  const p = b.row, v = clamp(input && finite(input.f) ? input.f : 0, -1, 1), h = clamp(input && finite(input.r) ? input.r : 0, -1, 1);
  const max = pick(p, 'maxSpeed', BOAT.maxSpeed);
  const target = v > 0 ? v * max : v * max * pick(p, 'backFrac', BOAT.backFrac);
  const stroking = Math.abs(v) > 0.05;
  b.speed = moveTowards(b.speed, target, (stroking ? pick(p, 'accel', BOAT.accel) : pick(p, 'drag', BOAT.drag)) * dt);
  // D (h +) turns the bow to the rower's RIGHT. With forward = (sin θ, cos θ) in the glTF frame, the rower's right is (−cos θ, sin θ) (Y up, right-handed): a right turn LOWERS θ.
  const turnWant = -h * pick(p, 'turnDegPerS', BOAT.turnDegPerS) * clamp(0.3 + Math.abs(b.speed), 0, 1);
  b.yawVel = moveTowards(b.yawVel, turnWant, 120 * dt);
  const { f } = hullFrame(b, b.x, b.z, b.yawDeg);
  const nx = b.x + f[0] * b.speed * dt, nz = b.z + f[1] * b.speed * dt, ny = b.yawDeg + b.yawVel * dt;
  const now = probeHull(b, env, b.x, b.z, b.yawDeg);
  const moving = (nx - b.x) ** 2 + (nz - b.z) ** 2 > 1e-10;
  const moved = moving ? probeHull(b, env, nx, nz, b.yawDeg) : now;
  const moveOk = !moving || moveAllowed(now, moved, nx - b.x, nz - b.z);
  const turnOk = Math.abs(b.yawVel * dt) < 1e-5 || moveAllowed(moveOk ? moved : now, probeHull(b, env, moveOk ? nx : b.x, moveOk ? nz : b.z, ny), 0, 0);
  let aground = false;
  if (moveOk) { b.x = nx; b.z = nz; } else { b.speed *= Math.exp(-dt / 0.1); aground = true; }
  if (turnOk) b.yawDeg = ny; else b.yawVel = 0;
  // ride the surface: the root keeps its height over the water it was saved at (the app's 0.25 s SmoothDamp, as an exponential ease)
  const w = env.water(b.x, b.z);
  if (b.over === undefined) { const w0 = env.water(v3(p.pos)[0], v3(p.pos)[2]); b.over = w0 === null || w0 === undefined ? 0 : v3(p.pos)[1] - w0; }
  if (w !== null && w !== undefined) b.y += ((w + b.over) - b.y) * Math.min(1, dt / 0.25);
  return { eye: boatEye(b), aground };
}
/** ThalynTransport.FindStepOff: the nearest ring (minR … maxR every 0.75 m, every 15°) with dry ground; bow side preferred. Returns feet or null. */
export function boatStepOff(b, env) {
  const p = b.row, { c, f } = hullFrame(b, b.x, b.z, b.yawDeg);
  const r0 = Math.max(pick(p, 'halfLenM', 1), pick(p, 'halfWM', 0.5));
  const minR = pick(p, 'stepOffMinM', r0 + 0.4), maxR = pick(p, 'stepOffMaxM', r0 + 4);
  let best = null, bestS = Infinity;
  for (let r = minR; r <= maxR + 0.01; r += 0.75) {
    for (let a = 0; a < 360; a += 15) {
      const dx = Math.sin(a * Math.PI / 180), dz = Math.cos(a * Math.PI / 180);
      const x = c[0] + dx * r, z = c[1] + dz * r;
      const g = env.ground(x, z, b.y + 8);
      if (g === null || g === undefined) continue;
      const w = env.water(x, z);
      if (w !== null && w !== undefined && w > g - 0.05) continue;   // wet: not a shore
      const s = r - 0.6 * (dx * f[0] + dz * f[1]);
      if (s < bestS) { bestS = s; best = [x, g, z]; }
    }
    if (best) break;
  }
  return best;
}
/** Can the visitor board from feet [x, y, z] looking along [fx, fz]? Distance to the hull's footprint box; beyond 1.2 m he must face it. */
export function boatBoardable(b, feet, look) {
  const p = b.row, { c, f } = hullFrame(b, b.x, b.z, b.yawDeg);
  const dx = feet[0] - c[0], dz = feet[2] - c[1];
  const along = dx * f[0] + dz * f[1], across = dx * f[1] - dz * f[0];
  const ex = Math.max(0, Math.abs(along) - pick(p, 'halfLenM', 1)), ez = Math.max(0, Math.abs(across) - pick(p, 'halfWM', 0.5));
  const d = Math.hypot(ex, ez);
  if (d > pick(p, 'boardRangeM', BOAT.boardRangeM)) return { ok: false, d };
  if (d > BOAT.lookFromM && look) {
    const l = Math.hypot(dx, dz) || 1, ll = Math.hypot(look[0], look[1]) || 1;
    if ((-dx / l) * (look[0] / ll) + (-dz / l) * (look[1] / ll) < BOAT.lookDot) return { ok: false, d, why: 'look' };
  }
  return { ok: true, d };
}

function v3(a) { return Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(finite) ? a.slice(0, 3).map(Number) : null; }
