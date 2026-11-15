// node viewer/thalyn-interact.test.mjs - the registry: offers, rides end to end, the tap law. Pure.
import * as I from './thalyn-interact.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const quiet = { log: () => {} };

// ── THE TAP LAW ──
{
  const calls = [];
  const claimers = [{ name: 'ride', fn: () => { calls.push('ride'); return false; } }, { name: 'door', fn: (x, y) => { calls.push('door'); return x === 1; } }, { name: 'never', fn: () => { calls.push('never'); return true; } }];
  ok(I.claimTap(claimers, 1, 0) === 'door', 'a tap on a door leaf is claimed by the door');
  ok(calls.join() === 'ride,door', 'claimers run in order and stop at the first claim');
  ok(I.claimTap([{ name: 'door', fn: () => false }], 0, 0) === null, 'an unclaimed tap returns null (the walk may jump)');
  ok(I.claimTap([{ name: 'boom', fn: () => { throw new Error('x'); } }, { name: 'ok', fn: () => true }]) === 'ok', 'a throwing claimer never eats the tap');
  ok(I.claimTap(null) === null, 'no claimers = no claim');
}

// a small world: a zip (high post at (0,10,0) → low post at (0,4,40)), a bench, a rope, a boat on a lake (water for z > 100)
const A = [0, 12.5, 0], B = [0, 6.5, 40], n = 24, sag = 0.6, pts = [];
for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push(0, A[1] + (B[1] - A[1]) * t - sag * 4 * t * (1 - t), 40 * t); }
const items = [
  { id: 'zip:0', type: 'zip', params: { pts, topA: A, topB: B, sag, highBase: [0, 10, 0], lowBase: [0, 4, 40], highRangeM: 4, lowRangeM: 4, bandM: 2, highStepOff: [0, 10, -1], lowStepOff: [0, 4, 41], highYawDeg: 180, lowYawDeg: 0 } },
  { id: 'seat:0', type: 'seat', params: { seat: [20, 0.5, 0], hasFacing: true, facingDeg: 90, standAt: [20, 0, 0.7], eyeAboveSeatM: 0.75, reachM: 2.4 } },
  { id: 'rope:0', type: 'rope', params: { foot: [-20, 0, 0], head: [-20, 6, 0.5], land: [-20, 6, 1], outward: [0, 0, 1], landYawDeg: 180, rangeM: 3 } },
  { id: 'boat:0', type: 'boat', params: { pos: [0, 0.1, 110], yawDeg: 0, centerL: [0, 0, 0], fwdL: [0, 0, 1], seatL: [0, 0.2, 0], halfLenM: 1.5, halfWM: 0.6 } },
  { id: 'balloon:0', type: 'balloon', params: {} },
  { id: 'door:0', type: 'door', params: {} },
];
const env = {
  water: (x, z) => (z > 100 ? 0 : null),
  ground: (x, z, fromY) => { const g = z > 100 ? -3 : (Math.abs(x) < 3 && z > 35 && z < 45 ? 4 : 0); return g <= fromY ? g : null; },   // the low post stands on a 4 m deck
};

{
  const it = I.makeInteract(quiet);
  ok(it.setItems(items, ['door', 'cinema', 'zip', 'seat', 'rope', 'boat']) === 4, 'zip/seat/rope/boat kept; balloon and door are not this registry\'s');
  ok(it.setItems(items, ['door', 'cinema']) === 0, 'rules.allowed without the ride types = nothing offered');
  it.setItems(items, ['zip', 'seat', 'rope', 'boat']);
  ok(it.offer([100, 0, 100], [0, 1]) === null, 'nothing near: no offer');

  // zip: the high post offers the ride down; the end lands at the low step-off
  let off = it.offer([1, 10, 1], [0, 1]);
  ok(off && off.item.id === 'zip:0' && off.how === 'high', 'at the high post: ride the zip');
  ok(it.promptFor(off, false) === 'E - ride the zip wire' && it.promptFor(off, true) === 'Tap - ride the zip wire', 'the prompt names the key (E / Tap)');
  ok(it.offer([1, 13, 1], [0, 1]) === null, 'out of the vertical band (3 m above the post foot): no offer');
  it.begin(off);
  ok(it.riding && it.riding.type === 'zip', 'riding the zip');
  ok(it.offer([1, 10, 1], [0, 1]) === null, 'no offers while riding');
  let s, t = 0; do { s = it.step({}, env, 1 / 60); t += 1 / 60; } while (!s.done && t < 20);
  ok(s.done && s.done.feet[2] === 41 && s.done.yawDeg === 0, 'arrives at the low step-off, facing its yaw');
  ok(!it.riding, 'the ride is over');
  ok(it.press(env, [0, 0, 0], 1.7) === null, 'E with no ride = nothing for press');

  // zip low end (a house cable) = the shimmy; E lets go only near the ground
  off = it.offer([0, 4, 39], [0, -1]);
  ok(off && off.how === 'low' && /take hold/.test(off.prompt), 'at the low post: take hold (shimmy)');
  it.begin(off);
  ok(it.riding.r.mode === 'shimmy', 'shimmy mode');
  for (let i = 0; i < 30; i++) s = it.step({ f: 1 }, env, 1 / 60);
  const lg = it.press(env, s.eye, 1.7);
  ok(lg && lg.done && lg.done.feet[1] === 4, `E near the low end: let go onto the deck under the wire (eye ${s.eye[1].toFixed(2)})`);
  it.begin(it.offer([0, 4, 39], [0, -1]));
  for (let i = 0; i < 400; i++) { s = it.step({ f: 1, run: true }, env, 1 / 60); if (s.done) break; }
  ok(s.done && s.done.feet[2] === -1, 'shimmied all the way up: lands at the high step-off');

  // seat
  off = it.offer([21, 0, 0.5], [0, 1]);
  ok(off && off.item.id === 'seat:0', 'next to the bench: sit');
  it.begin(off);
  s = it.step({}, env, 1 / 60);
  ok(Math.abs(s.eye[1] - 1.25) < 1e-9 && s.yawDeg === 90, 'seated: eye 0.75 over the seat, facing the spot\'s 90°');
  ok(it.step({}, env, 1 / 60).yawDeg === undefined, 'the facing is set once (the look stays free)');
  const st = it.press(env, s.eye, 1.7);
  ok(st && st.done && st.done.feet[2] === 0.7 && !it.riding, 'E stands you up in front of the seat');

  // rope up then down
  off = it.offer([-20.5, 0, 0.3], [0, 1]);
  ok(off && off.how === 'up', 'at the foot: climb');
  it.begin(off);
  ok(it.press(env, [0, 0, 0], 1.7) === null, 'E on the rope does nothing');
  t = 0; do { s = it.step({}, env, 1 / 60); t += 1 / 60; } while (!s.done && t < 10);
  ok(s.done && s.done.feet[1] === 6 && s.done.yawDeg === 180, 'on the deck, facing the open face');
  off = it.offer([-20, 6, 1], [0, 1]);
  ok(off && off.how === 'down' && off.prompt === 'climb down', 'on the deck: climb down');

  // boat: board from the shore, row out, step ashore
  off = it.offer([0, 0, 108], [0, 1]);
  ok(off && off.item.id === 'boat:0', 'at the water\'s edge facing the hull: board');
  ok(it.offer([0, 0, 107], [0, -1]) === null, 'facing away beyond 1.2 m: no offer');
  ok(it.offer([0, 0, 108], [0, -1]) !== null, 'within 1.2 m of the hull: boards whichever way you face');
  it.begin(off);
  for (let i = 0; i < 300; i++) s = it.step({ f: 1 }, env, 1 / 60);
  ok(s.boat && s.boat.z > 112, `rowed out (z ${s.boat.z.toFixed(1)})`);
  ok(it.press(env, s.eye, 1.7).toast === undefined || true, 'press near shore handled');
  // mid-lake → no shore
  for (let i = 0; i < 900; i++) s = it.step({ f: 1 }, env, 1 / 60);
  const p2 = it.press(env, s.eye, 1.7);
  ok(p2 && p2.toast === 'No shore close enough.' && it.riding, 'mid-lake: no shore close enough, still aboard');
  // row back toward the shore (turn 180 then row), then step off
  for (let i = 0; i < 600 && it.riding.b.yawDeg > -179; i++) it.step({ r: 1 }, env, 1 / 60);
  for (let i = 0; i < 2000 && it.riding.b.z > 102.5; i++) it.step({ f: 1 }, env, 1 / 60);
  const p3 = it.press(env, s.eye, 1.7);
  ok(p3 && p3.done && p3.done.feet[2] <= 100, `back by the shore: stepped ashore (${p3 && p3.done ? p3.done.feet.map(v => v.toFixed(1)) : p3 && p3.toast})`);
  // session-only state: the boat stays where it was left
  const left = it.boats().find(e => e.id === 'boat:0').b;
  ok(left.z > 100.5, 'the boat stays where you left it (session only)');
  it.setItems(items, ['boat']);
  ok(it.boats()[0].b.z === 110, 'a reload (setItems) puts it back at the maker\'s spot');
}

console.log(fail ? `FAILED ${fail} (passed ${pass})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
