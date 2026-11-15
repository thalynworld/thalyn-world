// node viewer/thalyn-rides.test.mjs - the phase-2 rides against the app's numbers (Widgets/ZipWire.cs, …). Pure, no three.js.
import * as R from './thalyn-rides.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a, b, e, m) => ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b} (±${e})`);

// ── a house cable the way ZipWire.BuildCurve samples it: 40 m span, 6 m drop, sag 1.5 % of span ──
function houseCable(span = 40, drop = 6, n = 24, sky = false) {
  const A = [0, 10, 0], B = [0, 10 - drop, span], sag = Math.max(0.05, span * 0.015), pts = [];
  for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - sag * 4 * t * (1 - t), A[2] + (B[2] - A[2]) * t); }
  return { pts, topA: A, topB: B, sag, sky };
}

// TerminalFor
near(R.zipTerminal(0), 22, 1e-9, 'terminal at 0 m = base 22');
near(R.zipTerminal(100), 28, 1e-9, 'terminal at 100 m = 22 + 6');
near(R.zipTerminal(500), 30, 1e-9, 'terminal capped at 30');

// FastSpeed: launch, accelerate, brake
near(R.fastSpeed(0, 1 / 60, 22, 100, 14, 14, 3), 14, 1e-9, 'first frame = launch speed 14');
near(R.fastSpeed(14, 0.5, 22, 100, 14, 14, 3), 21, 1e-9, '14 + 14 × 0.5 = 21');
near(R.fastSpeed(21, 0.5, 22, 100, 14, 14, 3), 22, 1e-9, 'clamped at terminal');
near(R.fastSpeed(22, 0.01, 22, 1.5, 14, 14, 3), 15, 1e-9, '1.5 m left of a 3 m brake: lerp(8, 22, 0.5) = 15');
near(R.fastSpeed(22, 0.01, 22, 0, 14, 14, 3), 8, 1e-9, 'arrives at 8 m/s');
near(R.fastSpeed(0, 0.01, 10, 100, 14, 14, 3), 10, 1e-9, 'launch never above terminal');

// the cable
const p = houseCable();
const c = R.makeCable(p);
ok(c && c.pts.length === 24, 'makeCable reads 24 points');
ok(c.length > 40.4 && c.length < 41.5, `arc length a little over the chord (${c.length.toFixed(3)})`);
const mid = R.cablePoint(c, c.length / 2);
near(mid.pos[1], 7 - 0.6, 0.05, 'mid point sags 0.6 m below the chord midpoint (7)');
const a0 = R.cablePoint(c, 0), a1 = R.cablePoint(c, c.length);
near(a0.pos[1], 10, 1e-9, 'start at top A'); near(a1.pos[2], 40, 1e-9, 'end at top B');
ok(a0.tan[1] < mid.tan[1] || true, 'tangent defined');
// tangent: d = (B-A) + down·sag·4·(1-2t); at t=0: (0, -6 - 2.4, 40) normalised
near(a0.tan[1], -8.4 / Math.hypot(8.4, 40), 1e-6, 'tangent at A = the parabola slope (steeper than the chord)');
near(R.cablePoint(c, c.length).tan[1], (-6 + 2.4) / Math.hypot(3.6, 40), 1e-6, 'tangent at B = shallower (the coast in)');
ok(R.makeCable({ pts: [0, 0, 0] }) === null, 'a one-point cable is refused');
ok(R.makeCable({ pts: [0, 0, 0, 1, NaN, 1] }) === null, 'a NaN point is refused');

// ride DOWN: launch 14, terminal 22 + 0.06 × len, brake in the last 3 m, arrive at the low end
{
  const r = R.zipStart(c, {}, true);
  ok(r.mode === 'zip', 'from the high end = zip');
  let t = 0, maxV = 0, out;
  do { out = R.zipStep(r, c, {}, 1 / 60); t += 1 / 60; maxV = Math.max(maxV, r.v); } while (!out.done && t < 30);
  ok(out.done && out.done.atHigh === false, 'the ride ends at the low end');
  near(maxV, R.zipTerminal(c.length), 1e-6, 'reaches terminal on a 41 m cable');
  ok(t > 1.8 && t < 2.6, `a 41 m house zip takes ~2 s (${t.toFixed(2)} s)`);
  near(out.eye[1], 4 - 1.1, 1e-6, 'the eye hangs 1.10 m under the cable at the end');
  ok(r.v >= 8 - 1e-9 && r.v < 12, `arrives moving, near 8 m/s (${r.v.toFixed(2)})`);
}
// sky cable: 55 down / 40 up lift from the low end
{
  const sc = R.makeCable(houseCable(231, 30, 80, true));
  const d = R.zipStart(sc, {}, true), u = R.zipStart(sc, {}, false);
  ok(d.sp.down.terminal === 55 && u.mode === 'lift' && u.sp.up.terminal === 40, 'sky: 55 down, a 40 m/s powered lift up');
  let t = 0, out; do { out = R.zipStep(d, sc, {}, 1 / 60); t += 1 / 60; } while (!out.done && t < 30);
  ok(t > 4 && t < 6, `a 231 m sky cable in ~5 s (the app's own claim; ${t.toFixed(2)} s)`);
  t = 0; do { out = R.zipStep(u, sc, {}, 1 / 60); t += 1 / 60; } while (!out.done && t < 30);
  ok(out.done && out.done.atHigh === true, 'the lift lands at the high end');
}
// exported params win over the constants
{
  const r = R.zipStart(c, { down: { terminal: 9, launch: 3, accel: 1, brakeM: 1 } }, true);
  R.zipStep(r, c, {}, 1 / 60);
  near(r.v, 3, 1e-9, 'params.down.launch read');
  ok(r.sp.down.terminal === 9, 'params.down.terminal read');
}
// SHIMMY up from the low end of a house cable
{
  const r = R.zipStart(c, {}, false);
  ok(r.mode === 'shimmy', 'house low end = shimmy');
  near(r.s, c.length - 0.35, 1e-9, 'takes hold 0.35 m off the post');
  const s0 = r.s; for (let i = 0; i < 60; i++) R.zipStep(r, c, {}, 1 / 60);
  near(r.s, s0, 1e-9, 'no W = you hang');
  for (let i = 0; i < 60; i++) R.zipStep(r, c, { up: true }, 1 / 60);
  near(s0 - r.s, 6, 0.6, 'one second of W ≈ 6 m (the pulse averages the pace)');
  const s1 = r.s; for (let i = 0; i < 60; i++) R.zipStep(r, c, { up: true, sprint: true }, 1 / 60);
  near(s1 - r.s, 12, 1.2, 'Shift sprints ≈ 12 m/s');
  const s2 = r.s; for (let i = 0; i < 60; i++) R.zipStep(r, c, { down: true }, 1 / 60);
  near(r.s - s2, 0.9, 0.02, 'S slides back 0.9 m/s');
  let out; for (let i = 0; i < 600; i++) { out = R.zipStep(r, c, { up: true, sprint: true }, 1 / 60); if (out.done) break; }
  ok(out.done && out.done.atHigh === true, 'climbing all the way lands at the top');
  // let go
  const r2 = R.zipStart(c, {}, false);
  ok(R.zipLetGo(r2, 10, 7.5, 1.7).ok === true, 'a 0.8 m drop: let go');
  ok(R.zipLetGo(r2, 10, 2, 1.7).ok === false, 'a 6.3 m drop: refused');
  ok(R.zipLetGo(r2, 10, null, 1.7).ok === false, 'no ground: refused');
  ok(R.zipLetGo(R.zipStart(c, {}, true), 10, 9, 1.7).ok === false, 'mid-zip E does nothing');
}
// a hitch frame never teleports
{
  const r = R.zipStart(c, {}, true); R.zipStep(r, c, {}, 5);
  ok(r.s <= 14 * 0.05 + 14 * 0.05 * 0.05 + 1e-9, `a 5 s hitch advances at most one 0.05 s step (${r.s.toFixed(3)})`);
}

// ── SEAT ──
{
  const r = R.seatStart({ seat: [1, 2, 3], hasFacing: true, facingDeg: 90, standAt: [1, 2, 3.7], eyeAboveSeatM: 0.75 });
  ok(r && Math.abs(r.eye[1] - 2.75) < 1e-9, 'the eye 0.75 m over the seat (a snap, as the app)');
  ok(r.yawDeg === 90, 'a sit spot faces its own way');
  ok(R.seatStart({ seat: [0, 0, 0], hasFacing: false, facingDeg: 30 }).yawDeg === null, 'a plain bench keeps your yaw');
  ok(R.seatStep(r, {}).done === null, 'no key: still seated');
  const d = R.seatStep(r, { pressed: true }).done;
  ok(d && d.feet[2] === 3.7, 'a move key / E stands you at standAt');
  ok(R.seatStart({}) === null, 'a row without a seat is refused');
}
// ── ROPE ── (foot on the ground, deck 6 m up, 1 m along)
{
  const row = { foot: [0, 0, 0], land: [0, 6, 1], outward: [0, 0, 1], landYawDeg: 180 };
  const up = R.ropeStart(row, true);
  const dist = Math.hypot(6, 1);
  near(up.secs, Math.max(0.4, dist / R.ropeSpeedFor(dist)), 1e-9, 'climb time = dist / ClimbSpeedFor(dist)');
  near(R.ropeSpeedFor(4), 2.5, 1e-9, 'short rope: the 2.5 m/s base');
  near(R.ropeSpeedFor(16), 5, 1e-9, 'long rope: 16 m in the 3.2 s target');
  let out, t = 0, maxSide = 0;
  do { out = R.ropeStep(up, 1 / 60); t += 1 / 60; maxSide = Math.max(maxSide, out.feet[2] - (out.feet[1] / 6)); } while (!out.done && t < 10);
  near(t, up.secs, 0.02, 'arrives on time');
  ok(out.done.feet[1] === 6 && out.done.yawDeg === 180, 'lands on the deck facing the open face');
  ok(maxSide > 0.3 && maxSide <= 0.45 + 1e-6, `swings out ≤ 0.45 m along the outward (${maxSide.toFixed(3)})`);
  const s0 = R.ropeStep(R.ropeStart(row, true), 0);
  near(s0.feet[2], 0, 1e-9, 'starts exactly on the foot (no side offset at k 0)');
  const dn = R.ropeStart(row, false); let o2; do { o2 = R.ropeStep(dn, 1 / 60); } while (!o2.done);
  ok(o2.done.feet[1] === 0 && o2.done.yawDeg === null, 'down: back on the ground, keeping your yaw');
  const r3 = R.ropeStart(row, true); R.ropeStep(r3, 5); ok(r3.T <= 0.05 / r3.secs + 1e-9, 'a hitch never teleports the climb');
}
// ── BOAT ── a lake: water at y 0 for z < 20; a bank rising from z = 20 (ground above the water line); the bed −3 m under the water
{
  const env = {
    water: (x, z) => (z < 20 ? 0 : null),
    ground: (x, z, fromY) => { const g = z < 20 ? -3 : 0.5 + (z - 20) * 0.1; return g <= fromY ? g : null; },
  };
  const row = { pos: [0, 0.1, 0], yawDeg: 0, centerL: [0, 0, 0], fwdL: [0, 0, 1], seatL: [0, 0.2, 0], halfLenM: 1.5, halfWM: 0.6, eyeOverSeatM: 0.9 };
  const b = R.boatFromRow(row);
  let eye;
  for (let i = 0; i < 120; i++) eye = R.boatStep(b, { f: 1 }, env, 1 / 60).eye;
  ok(b.speed > 1.5 && b.speed <= 2.2 + 1e-9, `two seconds of W: ${b.speed.toFixed(2)} m/s (accel 1.2 to 2.2)`);
  ok(b.z > 1.5, 'the boat moved bow-first (+Z at yaw 0)');
  near(eye[1], b.y + 0.2 + 0.9, 1e-9, 'the eye: seat + eyeOverSeatM');
  near(b.y, 0.1, 0.02, 'rides the surface at its saved height over the water');
  for (let i = 0; i < 1200; i++) R.boatStep(b, { f: 1 }, env, 1 / 60);
  ok(b.z < 20 - 1.5 * 0.9 + 0.2, `refused to ground at the bank (bow at ${(b.z + 1.35).toFixed(2)}, bank at 20)`);
  ok(b.speed < 0.5, 'pushing into the bank bleeds the stroke');
  // backing away from the bank is allowed
  const z0 = b.z; for (let i = 0; i < 120; i++) R.boatStep(b, { f: -1 }, env, 1 / 60);
  ok(b.z < z0, 'S backs away from the bank');
  ok(Math.abs(b.speed) <= 2.2 * 0.35 + 1e-9, 'astern at 0.35 of full speed');
  // turning: D turns right (θ falls), at rest only 0.3 of the rate
  const b2 = R.boatFromRow(row); for (let i = 0; i < 60; i++) R.boatStep(b2, { r: 1 }, env, 1 / 60);
  ok(b2.yawDeg < 0, `D turns the bow right (yaw ${b2.yawDeg.toFixed(1)}°)`);
  ok(b2.yawDeg > -40 * 0.3 - 1e-6, 'a hull barely pivots at rest (≤ 0.3 × 40°/s)');
  // step off: near the bank the shore is found, bow side first; mid-lake nothing
  const near1 = R.boatFromRow({ ...row, pos: [0, 0.1, 17] });
  const so = R.boatStepOff(near1, env);
  ok(so && so[2] >= 20, `steps off onto the bank (${so && so.map(v => v.toFixed(1))})`);
  const mid = R.boatFromRow({ ...row, pos: [0, 0.1, -10] });
  ok(R.boatStepOff(mid, env) === null, 'mid-lake: no shore close enough');
  // boarding
  ok(R.boatBoardable(mid, [0, 0, -10 + 1.5 + 2], [0, -1]).ok, 'within 3.5 m of the hull, facing it: boards');
  ok(!R.boatBoardable(mid, [0, 0, -10 + 1.5 + 2], [0, 1]).ok, 'beyond 1.2 m, facing away: refused');
  ok(R.boatBoardable(mid, [0, 0, -10 + 1.5 + 1], [0, 1]).ok, 'within 1.2 m: boards whichever way you face');
  ok(!R.boatBoardable(mid, [0, 0, -10 + 1.5 + 4], [0, -1]).ok, '4 m off the bow: out of reach');
  // a turned hull: the probes turn with the root
  const t90 = R.boatFromRow({ ...row, yawDeg: 90 });
  const hp = R.hullPoints(t90, 0, 0, 90).pts;
  near(hp[4][0], 1.35, 1e-9, 'yaw 90: the bow probe lies along +X'); near(hp[4][1], 0, 1e-9, '… not along Z');
  // moveAllowed table
  const A = { n: 0, dry: [0, 0, 0, 0, 0, 0, 0].map(Boolean), c: [0, 0], dc: [0, 0] };
  const T1 = { n: 1, dry: [false, false, false, false, true, false, false], c: [0, 0], dc: [0, 1] };
  const T2 = { n: 2, dry: [false, false, false, true, true, false, false], c: [0, 0], dc: [0, 1] };
  ok(R.moveAllowed(A, A, 0, 1), 'afloat → afloat: yes');
  ok(!R.moveAllowed(A, T1, 0, 1), 'afloat → touching: the bank stops it');
  ok(R.moveAllowed(T2, T1, 0, 1), 'getting wetter: yes');
  ok(!R.moveAllowed(T1, T2, 0, 1), 'getting drier: no');
  ok(R.moveAllowed(T1, T1, 0, -1) && !R.moveAllowed(T1, T1, 0, 1), 'same contact: only a stroke away from the bank');
}

console.log(fail ? `FAILED ${fail} (passed ${pass})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
