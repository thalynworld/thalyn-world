// ★ WORLD AS DATA · PHASE 1 bench: node viewer/thalyn-body.test.mjs → ALL PASS. Pure: thalyn-body.js + thalyn-collide.js only.
// A made-up world on flat ground y = 0:  a kerb (0.4 m) for x ≥ 5 · a WALL-HIGH block (2 m) for x ≥ 10 · a pit (−5 m) for z ≥ 5 ·
// a 1 m ledge for z ≤ −5 · a lake for x ≤ −5 (bed −3, surface 0).
import { BODY, makeBody, stepBody, bodyRules, jumpSpeed, placeBody } from './thalyn-body.js';
import { makeTrunkField, slideAlong, chainBlockers, pointBlocker } from './thalyn-collide.js';

let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { ok ? passes++ : fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const near = (a, b, e) => Math.abs(a - b) <= e;

function groundOf(x, z) {
  if (x <= -5) return -3;              // lake bed
  if (z >= 5) return -5;               // the pit
  if (z <= -5) return 1.0;             // the ledge
  if (x >= 10) return 2.0;             // the wall-high block
  if (x >= 5) return 0.4;              // the kerb
  return 0;
}
const env = {
  ground: (x, z, fromY) => { const g = groundOf(x, z); return g <= fromY ? g : null; },   // a surface above fromY is not "under" you
  water: (x, z) => x <= -5 ? 0 : null,
  block: null,
};
const R = bodyRules(null);
function run(s, input, seconds, e = env, dt = 1 / 60) { const evs = []; for (let t = 0; t < seconds - 1e-9; t += dt) evs.push(stepBody(s, input, e, R, dt)); return evs; }

// ── rules ──
check('rules default = today\'s walk', R.walkMps === 5 && R.runMps === 12 && R.eyeM === 1.7 && R.stepUpM === 0.6);
check('rules take finite numbers only', bodyRules({ walkMps: 3, runMps: NaN, jumpM: 2 }).walkMps === 3 && bodyRules({ runMps: NaN }).runMps === 12 && bodyRules({ jumpM: 2 }).jumpM === 2);
check('jump speed v = sqrt(2gh)', near(jumpSpeed(1.1, 9.81), Math.sqrt(2 * 9.81 * 1.1), 1e-9));

// ── standing, walking, running ──
{ const s = makeBody(0, 0, 0); run(s, { mx: 0, mz: 0 }, 1); check('stand still: stays put, grounded', s.x === 0 && s.y === 0 && s.grounded); }
{ const s = makeBody(0, 0, 0); run(s, { mx: 1, mz: 0 }, 0.8); check('walk 0.8 s at 5 m/s ≈ 4 m', near(s.x, 4, 0.05), s.x.toFixed(3)); }
{ const s = makeBody(0, 0, 0); run(s, { mx: 0, mz: -1, run: true }, 0.3); check('run 0.3 s at 12 m/s ≈ 3.6 m', near(s.z, -3.6, 0.05), s.z.toFixed(3)); }
{ const s = makeBody(0, 0, 0); run(s, { mx: 3, mz: 4 }, 0.2); check('diagonal input normalised (|m| ≤ 1)', near(Math.hypot(s.x, s.z), 1, 0.02)); }

// ── jump ──
{
  const s = makeBody(0, 0, 0);
  const ev0 = stepBody(s, { mx: 0, mz: 0, jump: true }, env, R, 1 / 60);
  let t = 1 / 60, peak = s.y, landed = 0;
  while (!s.grounded && t < 3) { const ev = stepBody(s, { mx: 0, mz: 0 }, env, R, 1 / 60); t += 1 / 60; peak = Math.max(peak, s.y); if (ev.landed) landed = ev.landed; }
  const air = 2 * jumpSpeed(R.jumpM, R.gravity) / R.gravity;
  check('jump: event', ev0.jumped);
  check('jump: apex ≈ jumpM (1.1 m)', near(peak, R.jumpM, 0.03), peak.toFixed(3));
  check('jump: air time ≈ 2v/g', near(t, air, 0.04), `${t.toFixed(3)} vs ${air.toFixed(3)}`);
  check('jump: lands grounded at y 0', s.grounded && s.y === 0 && landed > 0);
}
{ const s = makeBody(0, 0, 0); s.grounded = false; s.y = 1; s.vy = 0; const ev = stepBody(s, { mx: 0, mz: 0, jump: true }, env, R, 1 / 60); check('no double jump in the air', !ev.jumped); }

// ── steps, walls, ledges ──
{ const s = makeBody(4, 0, 0); run(s, { mx: 1, mz: 0 }, 0.5); check('kerb 0.4 m: stepped up', s.x > 5 && near(s.y, 0.4, 1e-6) && s.grounded, `x ${s.x.toFixed(2)} y ${s.y}`); }
{ const s = makeBody(9, 0.4, 0); const evs = run(s, { mx: 1, mz: 0 }, 1); check('2 m block: a wall (stopped before x 10)', s.x < 10 && s.y === 0.4 && evs.some(e => e.blocked), `x ${s.x.toFixed(2)}`); }
{
  // walk at the 1 m ledge: blocked; jump while walking: up and on
  const s = makeBody(0, 0, -4.5); run(s, { mx: 0, mz: -1 }, 0.5);
  check('1 m ledge on foot: blocked', s.z > -5 && s.y === 0, `z ${s.z.toFixed(2)}`);
  stepBody(s, { mx: 0, mz: -1, jump: true }, env, R, 1 / 60); run(s, { mx: 0, mz: -1 }, 1.2);
  check('1 m ledge with a jump: on top (jumpM 1.1 clears it)', s.z < -5 && near(s.y, 1.0, 1e-6) && s.grounded, `z ${s.z.toFixed(2)} y ${s.y.toFixed(2)}`);
}
{
  const hi = bodyRules({ jumpM: 0.3 }), s = makeBody(0, 0, -4.5);   // 0.3 m + the 0.6 m step = 0.9 m < the 1 m ledge
  for (let i = 0; i < 2; i++) stepBody(s, { mx: 0, mz: -1, jump: true }, env, hi, 1 / 60);
  for (let i = 0; i < 90; i++) stepBody(s, { mx: 0, mz: -1 }, env, hi, 1 / 60);
  check('1 m ledge with a 0.3 m jump: not reached (no snap-up)', s.z > -5 && s.y === 0, `z ${s.z.toFixed(2)} y ${s.y.toFixed(2)}`);
}

// ── falls ──
{
  const s = makeBody(0, 0, 4.5); let landed = 0, fell = false;
  for (let i = 0; i < 180; i++) { const ev = stepBody(s, { mx: 0, mz: i < 30 ? 1 : 0 }, env, R, 1 / 60); if (ev.fellOff) fell = true; if (ev.landed) landed = ev.landed; }
  check('walk off the pit edge: falls', fell);
  check('lands at the pit floor (−5)', s.grounded && s.y === -5);
  check('landing speed ≈ sqrt(2·g·5)', near(landed, Math.sqrt(2 * 9.81 * 5), 0.6), landed.toFixed(2));
}
{ const s = makeBody(0, 0, 0); s.grounded = false; s.y = 1e5; run(s, { mx: 0, mz: 0 }, 10); check('fall speed capped (maxFallMps)', s.vy >= -BODY.maxFallMps - 1e-9); }
{ const s = makeBody(4.9, 0.3, 0); s.y = 0.3; const ev = stepBody(s, { mx: 0, mz: 0 }, { ...env, ground: () => 0 }, R, 1 / 60); check('a 0.3 m drop is walked down (snap)', s.grounded && s.y === 0 && !ev.fellOff); }

{ const s = makeBody(0, 3, 0); const voidEnv = { ...env, ground: () => null }; stepBody(s, { mx: 0, mz: 0, jump: true }, voidEnv, R, 1 / 60); run(s, { mx: 0, mz: 0 }, 2, voidEnv);
  check('a jump with no ground under it lands back at take-off (never falls forever)', s.grounded && s.y === 3, `y ${s.y}`); }

// ── swim ──
{
  const s = makeBody(-4, 0, 0); let started = false;
  for (let i = 0; i < 120; i++) { const ev = stepBody(s, { mx: -1, mz: 0 }, env, R, 1 / 60); if (ev.swimStart) started = true; }
  check('into the lake: swimming', s.swimming && started);
  check('floats with the feet 1.1 m under the surface', near(s.y, -BODY.swimFloatM, 0.05), s.y.toFixed(3));
  const x0 = s.x; stepBody(s, { mx: -1, mz: 0 }, env, R, 0.1);
  check('half pace in water', near(x0 - s.x, R.walkMps * BODY.swimMul * 0.1, 0.02), (x0 - s.x).toFixed(3));
  let ended = false; for (let i = 0; i < 240; i++) { const ev = stepBody(s, { mx: 1, mz: 0 }, env, R, 1 / 60); if (ev.swimEnd) ended = true; }
  check('out of the lake: walking again on the shore', ended && !s.swimming && s.grounded && s.y === 0, `y ${s.y.toFixed(2)}`);
}

// ── sideways blockers ──
{
  const wall = (ox, oz, nx, nz) => nx > 3 ? { x: 3, z: nz } : null;
  const s = makeBody(0, 0, 0); run(s, { mx: 1, mz: 0 }, 1, { ...env, block: wall });
  check('a blocker stops the walk at x 3', near(s.x, 3, 1e-9));
}
{ const s = makeBody(0, 0, 0); stepBody(s, { mx: 1, mz: 0 }, env, R, 0.5); check('a 0.5 s frame is clamped and sub-stepped (moves 1.25 m, not 2.5)', near(s.x, 1.25, 0.02), s.x.toFixed(3)); }
{ const s = makeBody(0, 0, 0); placeBody(s, env, 7, 0, 50); check('placeBody stands on the kerb top', s.y === 0.4 && s.grounded && s.vy === 0); }
{ const s = makeBody(0, 0, 0); placeBody(s, { ...env, ground: () => null }, 1, 1, 50, 9); check('placeBody with no ground uses the fallback', s.y === 9); }

// ── collide: trunks, slide, chain ──
{
  const tf = makeTrunkField(0.45); tf.set([0, 0, 10, 10]);
  const r = tf.resolve(0.1, 0);
  check('trunk: a point inside is pushed to the radius', r && near(Math.hypot(r.x, r.z), 0.45, 1e-9));
  check('trunk: a point outside is free', tf.resolve(1, 1) === null && tf.count === 2);
}
{
  const r = slideAlong(0, 0, 1, 0, 0.6, -1, 0, 0.35);   // a wall at x 0.6, facing −x, moving +x by 1
  check('slide: head-on stops radius short of the wall', near(r.x, 0.25, 1e-9) && near(r.z, 0, 1e-9), `${r.x.toFixed(3)},${r.z.toFixed(3)}`);
  const o = slideAlong(0, 0, 1, 1, 0.6 * Math.SQRT2, -1, 0, 0.35);   // oblique: the +z part slides on
  check('slide: oblique keeps the sliding part', near(o.x, 0.25, 1e-9) && near(o.z, 1, 1e-9), `${o.x.toFixed(3)},${o.z.toFixed(3)}`);
  const p = slideAlong(0, 0, 0.1, 0, 0.2, -1, 0, 0.35);   // starting 0.2 from the wall: pushed back out to 0.35
  check('slide: a start inside the radius is pushed out', near(p.x, 0.2 - 0.35, 1e-9));
  check('slide: a normal facing away is flipped', near(slideAlong(0, 0, 1, 0, 0.6, 1, 0, 0.35).x, 0.25, 1e-9));
}
{
  const a = (ox, oz, nx, nz) => nx > 2 ? { x: 2, z: nz } : null, b = (ox, oz, nx, nz) => nz > 1 ? { x: nx, z: 1 } : null;
  const c = chainBlockers([a, null, b]);
  const r = c(0, 0, 3, 3, 0);
  check('chain: both blockers applied in order', r && r.x === 2 && r.z === 1);
  check('chain: nothing moved = null', c(0, 0, 1, 0.5, 0) === null);
  check('pointBlocker adapts (x, z) resolvers', pointBlocker((x, z) => x > 1 ? { x: 1, z } : null)(0, 0, 5, 0).x === 1);
}

console.log(fails === 0 ? `ALL PASS (${passes})` : `${fails} FAIL / ${passes} pass`);
process.exit(fails === 0 ? 0 : 1);
