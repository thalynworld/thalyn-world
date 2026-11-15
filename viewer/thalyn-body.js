// ★ WORLD AS DATA · PHASE 1 · THE BODY (client 2, 2026-11-15; Mike 11-15: D1-D4 yes). Design: client repo
// Core Designs/WORLD_AS_DATA_WEB_RECREATION_DESIGN_NOV15_2026.md §3.2 (thalyn-body.js lifts makeWalk's movement) · §6 phase 1.
// PURE: no three.js, no DOM. The movement integrator a visitor's feet run on - node tests it (node viewer/thalyn-body.test.mjs).
//
// Before this module the walker had no body: its height was SET from the ground probe every frame (no velocity, no fall, no jump), E/Space flew.
// Now: a vertical velocity with gravity, a jump, landing, walking off a ledge into a fall, a step-up limit (a rise taller than stepUpM is a
// wall: cliffs, tall rocks, the edge of a roof), sideways blockers (trunks, walls, props, doors - thalyn-collide.js), and the old swim.
// The numbers are the World Description's `rules` (thalyn-describe.js DEFAULT_RULES = today's walk: 5 / 12 m/s, eye 1.7, step 0.6).
//
// env = { ground(x, z, fromY) -> y | null   the highest walkable surface under (x, z) at or below fromY
//         water(x, z) -> y | null           the water surface there (null = no water)
//         block(ox, oz, nx, nz, feetY) -> {x, z} | null   sideways resolution for a move ox,oz -> nx,nz (null = free) }
// input = { mx, mz   wanted horizontal direction in world space (length ≤ 1; the adapter turns WASD / the stick into it)
//           run      bool
//           jump     bool (edge: true on the frame the key went down) }

export const BODY = Object.freeze({
  walkMps: 5, runMps: 12, jumpM: 1.1, gravity: 9.81, eyeM: 1.7, stepUpM: 0.6,
  swimDepthM: 1.2,     // water deeper than this over the bed = swim (thalyn-atmos.js A171: > 1.2)
  swimFloatM: 1.1,     // feet this far under the surface while swimming (eye = surface + eyeM - 1.1, as before)
  swimMul: 0.5,        // half pace in water (as before)
  snapDownM: 0.35,     // a drop shallower than this is walked down (stairs, kerbs); deeper = a fall
  airControl: 0.35,    // how fast an airborne body turns toward the wanted velocity (1/s scale)
  maxFallMps: 45,
  subStepS: 1 / 60,
});

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** A body standing at feet (x, y, z). */
export function makeBody(x = 0, y = 0, z = 0) {
  return { x, y, z, vx: 0, vz: 0, vy: 0, grounded: true, swimming: false, airS: 0, peakY: y, takeoffY: undefined };
}

/** The rules a body runs on: the World Description's `rules` over BODY (only finite numbers win). */
export function bodyRules(rules) {
  const r = Object.assign({}, BODY);
  if (rules && typeof rules === 'object') for (const k of ['walkMps', 'runMps', 'jumpM', 'gravity', 'eyeM', 'stepUpM']) if (finite(rules[k])) r[k] = rules[k];
  return r;
}

/** The take-off speed for a jump of h metres under gravity g. */
export const jumpSpeed = (h, g) => Math.sqrt(Math.max(0, 2 * g * h));

/**
 * Advance the body by dt seconds (sub-stepped at 60 Hz so a slow frame never tunnels or launches). Mutates `s`.
 * Returns the events of the step: { landed: fallSpeed | 0, jumped, swimStart, swimEnd, blocked (a step-up refusal), fellOff }.
 */
export function stepBody(s, input, env, rules, dt) {
  const R = rules || BODY;
  const ev = { landed: 0, jumped: false, swimStart: false, swimEnd: false, blocked: false, fellOff: false };
  if (!(dt > 0)) return ev;
  dt = Math.min(dt, 0.25);
  const n = Math.max(1, Math.ceil(dt / R.subStepS)), h = dt / n;
  let jump = !!(input && input.jump);
  for (let i = 0; i < n; i++) { sub(s, input, env, R, h, jump, ev); jump = false; }
  return ev;
}

function sub(s, input, env, R, dt, jump, ev) {
  const mx = input && finite(input.mx) ? input.mx : 0, mz = input && finite(input.mz) ? input.mz : 0;
  const len = Math.hypot(mx, mz), k = len > 1 ? 1 / len : 1;
  const speed = (input && input.run ? R.runMps : R.walkMps) * (s.swimming ? R.swimMul : 1);
  const wx = mx * k * speed, wz = mz * k * speed;
  // horizontal velocity: instant on the ground and in water (the old walk), a slow turn in the air (you keep your run-up)
  if (s.grounded || s.swimming) { s.vx = wx; s.vz = wz; }
  else { const a = 1 - Math.exp(-R.airControl * 4 * dt); s.vx += (wx - s.vx) * a; s.vz += (wz - s.vz) * a; }

  // ── sideways ──
  if (s.vx !== 0 || s.vz !== 0) {
    let nx = s.x + s.vx * dt, nz = s.z + s.vz * dt;
    if (env.block) { const b = env.block(s.x, s.z, nx, nz, s.y); if (b) { nx = b.x; nz = b.z; } }
    // the step-up law: a rise taller than stepUpM is a wall. The same in the air: a jump reaches a ledge because at the jump's top the
    // feet are already above it (no snap-up "mantle"). A swimmer is exempt: the bank is climbed on leaving the water (below).
    if (!s.swimming && wallAt(s, env, R, nx, nz)) { nx = s.x; nz = s.z; ev.blocked = true; }
    s.x = nx; s.z = nz;
  }

  // ── water ──
  const g = env.ground(s.x, s.z, s.y + R.stepUpM + 0.05);
  const w = env.water ? env.water(s.x, s.z) : null;
  if (g !== null && w !== null && w - g > R.swimDepthM && s.y <= w - R.swimFloatM + 0.25) {
    if (!s.swimming) { s.swimming = true; ev.swimStart = true; }
    s.grounded = false; s.vy = 0;
    s.y += ((w - R.swimFloatM) - s.y) * Math.min(1, dt * 4);   // ease to floating height (the old 4/s ease)
    return;
  }
  if (s.swimming) {
    // leaving the water: climb out onto a bank up to (float depth + one step) above the feet; otherwise drop to whatever is below
    s.swimming = false; ev.swimEnd = true; s.vy = 0;
    const top = g !== null ? g : env.ground(s.x, s.z, s.y + 50);
    if (top !== null && top >= s.y - R.snapDownM && top - s.y <= R.swimFloatM + R.stepUpM + 0.25) { s.y = top; s.grounded = true; }
    else s.grounded = false;
  }

  // ── vertical ──
  if (s.grounded) {
    if (jump) { s.vy = jumpSpeed(R.jumpM, R.gravity); s.grounded = false; s.airS = 0; s.peakY = s.y; s.takeoffY = s.y; ev.jumped = true; }
    else if (g === null) { /* off every surface (beyond the world's edge): stand where you are */ }
    else if (s.y - g <= R.snapDownM && g - s.y <= R.stepUpM) { s.y = g; }   // walk up and down steps and slopes
    else if (s.y - g > R.snapDownM) { s.grounded = false; s.vy = 0; s.airS = 0; s.peakY = s.y; s.takeoffY = undefined; ev.fellOff = true; }
  }
  if (!s.grounded) {
    s.airS += dt;
    const v0 = s.vy;
    s.vy = Math.max(-R.maxFallMps, s.vy - R.gravity * dt);
    s.y += (v0 + s.vy) * 0.5 * dt;   // the average of the step's speeds: exact under constant gravity (a jump peaks at jumpM, not short of it)
    if (s.y > s.peakY) s.peakY = s.y;
    if (g !== null && s.y <= g && s.vy <= 0) { ev.landed = Math.max(ev.landed, -s.vy || 0.0001); s.y = g; s.vy = 0; s.grounded = true; s.airS = 0; }
    // a jump taken where nothing is under you (past the world's edge, a model with no ground) lands back at its take-off height, never falls forever
    else if (g === null && s.takeoffY !== undefined && s.y <= s.takeoffY && s.vy <= 0) { ev.landed = Math.max(ev.landed, -s.vy || 0.0001); s.y = s.takeoffY; s.vy = 0; s.grounded = true; s.airS = 0; }
  }
}

/**
 * Is (x, z) a wall for a body whose feet are at s.y? The low probe (from just above step height) finds the floor at our level; it misses when
 * that start point is INSIDE something - a cliff (a heightfield seen from below has no faces), a building's solid base - and then a probe from
 * high above finds the top: taller than one step = a wall. A floor under an overhang (a bridge, a roof, a branch) is found by the low probe
 * and never blocks. Solid PROPS seen from inside return the ground under them to the low probe: those are the side probe's (thalyn-collide.js).
 */
export function wallAt(s, env, R, x, z) {
  const low = env.ground(x, z, s.y + R.stepUpM + 0.05);
  if (low !== null) return low - s.y > R.stepUpM;
  const top = env.ground(x, z, s.y + 50);
  return top !== null && top - s.y > R.stepUpM;
}

/** Teleport the body onto the ground at (x, z) - a spawn, an enter. fromY = where to look down from. Returns the feet Y used. */
export function placeBody(s, env, x, z, fromY, fallbackY) {
  const g = env.ground(x, z, fromY);
  s.x = x; s.z = z; s.y = g !== null ? g : (finite(fallbackY) ? fallbackY : 0);
  s.vx = s.vz = s.vy = 0; s.grounded = true; s.swimming = false; s.airS = 0; s.peakY = s.y;
  return s.y;
}
