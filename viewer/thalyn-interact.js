// ★ WORLD AS DATA · PHASE 2 · THE INTERACT REGISTRY (client 2, 2026-11-15). Design §3.2 thalyn-interact.js: one registry - the nearest usable thing,
// its prompt, E / a tap, and the state machine per type (thalyn-rides.js does the motion). PURE: no three.js, no DOM - node tests it
// (node viewer/thalyn-interact.test.mjs). The walk (thalyn-walk.js) asks it on E and on a still phone tap, and hands it the frame while you ride.
//
// Items are the World Description's interact[] (thalyn-describe.js maps extras.thalyn.interact's typed rows onto them), filtered by rules.allowed.
// Types handled here: zip · seat · rope · boat (doors keep thalyn-doors.js; the cinema keeps thalyn-together.js). NO balloon, NO world views (Mike 11-15).
// Visitor changes are SESSION ONLY (design D3): a boat rowed across the lake stays there until the page reloads, and nothing is written back.
//
// THE TAP LAW (the phone wrinkle, lead 11-15: "a tap that opens a door must not also hop"): a still tap is offered to the claimers IN ORDER - a ride in
// progress (stand up / step off / let go), the thing you are next to, a door leaf under the finger - and only an unclaimed tap jumps. `claimTap` below.
//
// Console proof lines:  [thalyn-interact] N interactable(s): Z zip · S seat · R rope · B boat
//                       [thalyn-interact] riding zip 'zip:0' down|lift|shimmy · sat on 'seat:3' · climbing 'rope:1' up|down · aboard 'boat:0'
//                       [thalyn-interact] off 'zip:0' at the low end · stood up · on the deck · stepped ashore · let go (a 1.2 m drop)
import * as R from './thalyn-rides.js?v=20261115i2';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const v3 = a => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(finite) ? a.slice(0, 3).map(Number) : null);
export const RIDE_TYPES = ['zip', 'seat', 'rope', 'boat'];

/** THE TAP LAW: run the claimers in order; the first that returns truthy owns the tap (its name is returned). null = nobody: the tap may jump. */
export function claimTap(claimers, ...args) {
  for (const c of claimers || []) {
    if (!c || typeof c.fn !== 'function') continue;
    let r = false; try { r = c.fn(...args); } catch (e) { r = false; }
    if (r) return c.name || 'claimed';
  }
  return null;
}

const PROMPTS = {
  zipDown: 'ride the zip wire', zipLift: 'ride the wire up', zipShimmy: 'take hold of the wire (W climbs)',
  seat: 'sit', ropeUp: 'climb the rope', ropeDown: 'climb down', boat: 'board the rowboat',
};

/** opts: { log(msg) } */
export function makeInteract(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : (m => console.info(m));
  let items = [], cables = new Map(), boats = new Map(), ride = null;

  /** items = describe doc.interact; allowed = rules.allowed. Returns the count kept. */
  function setItems(list, allowed) {
    const allow = Array.isArray(allowed) ? new Set(allowed) : null;
    items = []; cables = new Map(); boats = new Map(); ride = null;
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || !RIDE_TYPES.includes(it.type) || (allow && !allow.has(it.type))) continue;
      if (it.type === 'zip') { const c = R.makeCable(it.params); if (!c) continue; cables.set(it.id, c); }
      if (it.type === 'boat') { const b = R.boatFromRow(it.params); if (!b) continue; boats.set(it.id, b); }
      if (it.type === 'seat' && !v3(it.params && it.params.seat)) continue;
      if (it.type === 'rope' && !(v3(it.params && it.params.foot) && v3(it.params && it.params.land))) continue;
      items.push(it);
    }
    const n = t => items.filter(i => i.type === t).length;
    if (items.length) log(`[thalyn-interact] ${items.length} interactable(s): ${n('zip')} zip · ${n('seat')} seat · ${n('rope')} rope · ${n('boat')} boat`);
    return items.length;
  }

  /**
   * The nearest thing you can use from feet [x, y, z], looking along look [fx, fz]. Each type's own reach, the app's rules:
   *   zip  - a post foot within its rangeM horizontally and bandM vertically (ZipWire.OfferAndMount)
   *   seat - the seat within reachM (BenchSeat measures from the capsule pivot; here: horizontal reach, 1.6 m of height)
   *   rope - the foot or the rope head within rangeM (TreeHouse.OfferAndClimb: a plain 3D distance from the feet)
   *   boat - the hull's footprint within boardRangeM, facing it beyond 1.2 m (ThalynRowboat boarding)
   * Returns { item, how, d, prompt } or null.
   */
  function offer(feet, look) {
    if (ride || !Array.isArray(feet)) return null;
    let best = null;
    const take = (item, how, d, prompt) => { if (!best || d < best.d) best = { item, how, d, prompt }; };
    for (const it of items) {
      const p = it.params || {};
      if (it.type === 'zip') {
        const c = cables.get(it.id);
        for (const end of ['high', 'low']) {
          const b = v3(p[end + 'Base']); if (!b) continue;
          if (Math.abs(feet[1] - b[1]) > (finite(p.bandM) ? p.bandM : 2)) continue;
          const d = Math.hypot(feet[0] - b[0], feet[2] - b[2]);
          if (d > (finite(p[end + 'RangeM']) ? p[end + 'RangeM'] : 4)) continue;
          take(it, end, d, end === 'high' ? PROMPTS.zipDown : (c && c.sky || p.upLift ? PROMPTS.zipLift : PROMPTS.zipShimmy));
        }
      } else if (it.type === 'seat') {
        const s = v3(p.seat); const d = Math.hypot(feet[0] - s[0], feet[2] - s[2]);
        if (d <= (finite(p.reachM) ? p.reachM : R.SEAT.reachM) && Math.abs(feet[1] - s[1]) <= 1.6) take(it, 'sit', d, PROMPTS.seat);
      } else if (it.type === 'rope') {
        const rng = finite(p.rangeM) ? p.rangeM : R.ROPE.rangeM;
        const f = v3(p.foot), h = v3(p.head) || v3(p.land);
        const df = Math.hypot(feet[0] - f[0], feet[1] - f[1], feet[2] - f[2]), dh = Math.hypot(feet[0] - h[0], feet[1] - h[1], feet[2] - h[2]);
        if (df <= rng) take(it, 'up', df, PROMPTS.ropeUp);
        if (dh <= rng) take(it, 'down', dh, PROMPTS.ropeDown);
      } else if (it.type === 'boat') {
        const b = boats.get(it.id); const q = b && R.boatBoardable(b, feet, look);
        if (q && q.ok) take(it, 'board', q.d, PROMPTS.boat);
      }
    }
    return best;
  }

  /** Start what offer() found. Returns the ride (or null). */
  function begin(off) {
    if (!off || ride) return null;
    const it = off.item, p = it.params || {};
    if (it.type === 'zip') {
      const c = cables.get(it.id); if (!c) return null;
      const r = R.zipStart(c, p, off.how === 'high');
      ride = { type: 'zip', id: it.id, item: it, c, r };
      log(`[thalyn-interact] riding zip '${it.id}' ${r.mode === 'zip' ? 'down' : r.mode} (${c.length.toFixed(0)} m of cable${r.mode === 'zip' ? `, terminal ${r.sp.down.terminal.toFixed(0)} m/s` : ''})`);
    } else if (it.type === 'seat') {
      const r = R.seatStart(p); if (!r) return null;
      ride = { type: 'seat', id: it.id, item: it, r };
      log(`[thalyn-interact] sat on '${it.id}'${r.yawDeg !== null ? ` facing ${r.yawDeg.toFixed(0)}°` : ''}`);
    } else if (it.type === 'rope') {
      const r = R.ropeStart(p, off.how === 'up'); if (!r) return null;
      ride = { type: 'rope', id: it.id, item: it, r };
      log(`[thalyn-interact] climbing '${it.id}' ${off.how} (${r.dist.toFixed(1)} m in ${r.secs.toFixed(1)} s)`);
    } else if (it.type === 'boat') {
      const b = boats.get(it.id); if (!b) return null;
      b.speed = 0; b.yawVel = 0;
      ride = { type: 'boat', id: it.id, item: it, b };
      log(`[thalyn-interact] aboard '${it.id}' - W/S row, A/D turn, E steps ashore`);
    }
    return ride;
  }

  /**
   * One frame while riding. input = { f, r (−1..1), run, pressed (a move key / Space / E went down) }, env = { ground(x, z, fromY), water(x, z) }.
   * Returns { eye?: [x,y,z], feet?: [x,y,z], yawDeg?: number (a facing to set once), boat?: {id, x, y, z, yawDeg}, done?: {feet, yawDeg} } or null.
   */
  function step(input, env, dt) {
    if (!ride) return null;
    const out = {};
    if (ride.type === 'zip') {
      const s = R.zipStep(ride.r, ride.c, { up: input && input.f > 0.3, down: input && input.f < -0.3, sprint: !!(input && input.run) }, dt);
      out.eye = s.eye;
      if (s.done) out.done = endZip(s.done.atHigh);
    } else if (ride.type === 'seat') {
      const s = R.seatStep(ride.r, input);
      out.eye = s.eye;
      if (!ride.faced && ride.r.yawDeg !== null) { out.yawDeg = ride.r.yawDeg; ride.faced = true; }
      if (s.done) { out.done = s.done; log(`[thalyn-interact] stood up from '${ride.id}'`); ride = null; }
    } else if (ride.type === 'rope') {
      const s = R.ropeStep(ride.r, dt);
      out.feet = s.feet;
      if (s.done) { out.done = s.done; log(`[thalyn-interact] ${ride.r.up ? 'on the deck' : 'back on the ground'} ('${ride.id}')`); ride = null; }
    } else if (ride.type === 'boat') {
      const s = R.boatStep(ride.b, input || {}, env, dt);
      out.eye = s.eye;
      out.boat = { id: ride.id, x: ride.b.x, y: ride.b.y, z: ride.b.z, yawDeg: ride.b.yawDeg, row: ride.b.row };
      if (s.aground && !ride.saidAground) { ride.saidAground = true; out.toast = 'Aground - the bank is not a road.'; log(`[thalyn-interact] '${ride.id}' aground - stopped`); }
      else if (!s.aground) ride.saidAground = false;
    }
    return out;
  }
  function endZip(atHigh) {
    const p = ride.item.params || {};
    const feet = v3(atHigh ? p.highStepOff : p.lowStepOff) || v3(atHigh ? p.highBase : p.lowBase);
    const yaw = finite(atHigh ? p.highYawDeg : p.lowYawDeg) ? (atHigh ? p.highYawDeg : p.lowYawDeg) : null;
    log(`[thalyn-interact] off '${ride.id}' at the ${atHigh ? 'high' : 'low'} end${ride.r.mode === 'zip' ? ` at ${ride.r.v.toFixed(1)} m/s` : ''}`);
    ride = null;
    return { feet, yawDeg: yaw };
  }

  /** E (or a still tap) while riding: stand up · step ashore · let go of the wire (if the ground is near). Returns { done?, toast? } or null (nothing to do). */
  function press(env, eye, eyeM) {
    if (!ride) return null;
    if (ride.type === 'seat') { const r = ride; ride = null; log(`[thalyn-interact] stood up from '${r.id}'`); return { done: { feet: r.r.standAt, yawDeg: null } }; }
    if (ride.type === 'boat') {
      const f = R.boatStepOff(ride.b, env);
      if (!f) return { toast: 'No shore close enough.' };
      log(`[thalyn-interact] stepped ashore from '${ride.id}' at (${f.map(v => v.toFixed(1)).join(', ')})`);
      ride = null;
      return { done: { feet: f, yawDeg: null } };
    }
    if (ride.type === 'zip' && ride.r.mode === 'shimmy' && Array.isArray(eye)) {
      const g = env.ground(eye[0], eye[2], eye[1]);
      const q = R.zipLetGo(ride.r, eye[1], g, eyeM);
      if (!q.ok) return { toast: q.fall ? `Too high to let go - ${q.fall.toFixed(0)} m down.` : 'Too high to let go.' };
      log(`[thalyn-interact] let go of '${ride.id}' (a ${q.fall.toFixed(1)} m drop)`);
      ride = null;
      return { done: { feet: [eye[0], g, eye[2]], yawDeg: null } };
    }
    return null;   // mid-zip, on the lift, on the rope: E does nothing (the app's rule)
  }

  return {
    setItems, offer, begin, step, press,
    clear() { items = []; cables = new Map(); boats = new Map(); ride = null; },
    abort(why) { if (ride) { log(`[thalyn-interact] '${ride.id}' ended - ${why}`); ride = null; } },
    get riding() { return ride; }, get count() { return items.length; },
    boats: () => [...boats.entries()].map(([id, b]) => ({ id, b })),
    promptFor(off, touch) { return off ? `${touch ? 'Tap' : 'E'} - ${off.prompt}` : ''; },
  };
}
