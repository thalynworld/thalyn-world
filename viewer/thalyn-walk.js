// ★ WORLD AS DATA · PHASE 1 · THE WALK ADAPTER (client 2, 2026-11-15). Lifted from thalyn-atmos.js makeWalk (A171 swim, A308 trunks,
// A5401 indoor walls, A5403 doors, the touch stick) and put on a BODY (thalyn-body.js): gravity, a jump, falls, the step-up law, and the
// sideways blockers of thalyn-collide.js. Same API as before, so index.html's calls are unchanged; new: enterSpawn, opts.rules, opts.sideProbe,
// opts.allowFly, and the `[thalyn-body]` console lines.
//
// Keys (desktop): WASD / arrows walk · Shift runs · SPACE JUMPS · E opens the door you face (thalyn-doors.js) · Esc / V leaves.
//   Flying is OFF for visitors (World Description rules.fly, default false). ?fly=1 (or rules.fly) brings the old keys back: F toggles
//   flight, then E / Space rise and Q / C sink; F again drops you (you fall under gravity).
// Touch: left thumb walks (push far to run), right thumb looks, a quick tap on the right half (no drag) jumps.
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { makeBody, stepBody, placeBody, bodyRules } from './thalyn-body.js?v=20261115p1';
import { chainBlockers, pointBlocker } from './thalyn-collide.js?v=20261115p1';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// groundAt(x, z, fromY) → y or null. onState(walking, why) is called on lock/unlock and on a swim/walk change.
// opts: touch · waterAt(x, z) · blockAt(x, z) (trunks + a card's fence, a point resolver) · indoor (thalyn-indoors.js) · doors (thalyn-doors.js)
//       sideProbe(ox, oz, nx, nz, feetY) (thalyn-collide.js makeMeshSideProbe) · rules (World Description rules) · allowFly (bool)
export function makeWalk(camera, dom, groundAt, onState, opts = {}) {
  let R = bodyRules(opts.rules);
  let allowFly = !!opts.allowFly || !!(opts.rules && opts.rules.fly);
  const touch = !!opts.touch;
  const ctl = new PointerLockControls(camera, dom);
  const keys = new Set();
  const body = makeBody();
  let walking = false, fly = false, flyY = 0, jumpQueued = false, lastLog = 0;
  // Touch state
  let yaw = 0, pitch = 0, joyId = null, lookId = null, jx = 0, jy = 0, jox = 0, joy = 0, lx = 0, ly = 0, lookT0 = 0, lookMoved = 0;
  let stickEl = null, knobEl = null;

  // the body's world: the ground probe (indoors: floor, not roof), the water, and every sideways blocker chained
  const blockers = [];
  if (opts.blockAt) blockers.push(pointBlocker(opts.blockAt));
  if (opts.sideProbe) blockers.push(opts.sideProbe);
  if (opts.indoor) blockers.push((ox, oz, nx, nz, feetY) => opts.indoor.wall(ox, oz, nx, nz, feetY));
  if (opts.doors) blockers.push((ox, oz, nx, nz, feetY) => opts.doors.block(ox, oz, nx, nz, feetY));
  const env = {
    ground: (x, z, fromY) => {
      const gi = opts.indoor ? opts.indoor.floor(x, fromY - R.stepUpM - 0.05, z) : undefined;   // A5401 · I1: feet + step height inside a building
      return gi !== undefined ? gi : groundAt(x, z, fromY);
    },
    water: (x, z) => opts.waterAt ? opts.waterAt(x, z) : null,
    block: chainBlockers(blockers),
  };

  ctl.addEventListener('lock', () => { walking = true; onState && onState(true); });
  ctl.addEventListener('unlock', () => { walking = false; keys.clear(); onState && onState(false); });
  document.addEventListener('pointerlockerror', () => { walking = false; onState && onState(false, 'refused'); });
  function syncAngles() { const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); yaw = e.y; pitch = e.x; }
  function begin() {
    if (touch) { syncAngles(); walking = true; showStick(true); onState && onState(true); }
    else ctl.lock();
  }
  function land(x, z, fromY, fallbackFeet) {
    const feet = placeBody(body, env, x, z, fromY, fallbackFeet);
    camera.position.set(x, feet + R.eyeM, z);
    fly = false;
    return feet;
  }
  function enterAt(pos, lookAt) {
    land(pos.x, pos.z, pos.y + 50, pos.y - R.eyeM);
    if (lookAt) camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    begin();
  }
  // The export shot. A crane shot (more than 4 m above the ground) used to start the walk FLYING; a visitor with no flight now stands on the
  // ground beneath it, looking the same way (with ?fly=1 the crane shot is kept, as before).
  function enterPose(pose) {
    const g = groundAt(pose.position.x, pose.position.z, pose.position.y + 50);
    const high = g === null || Math.abs((pose.position.y - R.eyeM) - g) > 4;
    if (high && allowFly) {
      fly = true; flyY = pose.position.y;
      camera.position.copy(pose.position);
      body.x = pose.position.x; body.z = pose.position.z; body.y = pose.position.y - R.eyeM; body.vy = 0; body.grounded = false;
    } else land(pose.position.x, pose.position.z, pose.position.y + 50, pose.position.y - R.eyeM);
    const fwd = pose.forward.clone(); if (!fly) { fwd.y = Math.max(-0.35, Math.min(0.35, fwd.y)); }
    camera.lookAt(camera.position.clone().add(fwd));
    console.info(`[thalyn-body] entered at the export shot${high && !allowFly ? ' (a crane shot: you stand on the ground below it)' : ''}`);
    begin();
  }
  // ★ the World Description's world.spawn (the app's own GAP-7 landing, client A16040): pos = the ground point, yawDeg = facing (glTF frame).
  function enterSpawn(spawn) {
    if (!spawn || !Array.isArray(spawn.pos)) return false;
    const [x, y, z] = spawn.pos;
    land(x, z, y + 50, y);
    const a = (spawn.yawDeg || 0) * Math.PI / 180;
    camera.lookAt(camera.position.x + Math.sin(a), camera.position.y, camera.position.z + Math.cos(a));
    console.info(`[thalyn-body] entered at the world's spawn (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) facing ${(spawn.yawDeg || 0).toFixed(0)}°`);
    begin();
    return true;
  }
  function exit() {
    if (!walking) return;
    if (touch) { walking = false; joyId = lookId = null; jx = jy = 0; showStick(false); onState && onState(false); }
    else ctl.unlock();
  }
  // Touch input — only installed for touch mode, only acted on while walking.
  if (touch) {
    const opt = { passive: false };
    dom.addEventListener('touchstart', e => {
      if (!walking) return;
      for (const t of e.changedTouches) {
        if (t.target && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|LABEL)$/.test(t.target.tagName)) continue;
        if (t.clientX < innerWidth * 0.5 && joyId === null) { joyId = t.identifier; jox = t.clientX; joy = t.clientY; jx = jy = 0; placeStick(jox, joy); }
        else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; lookT0 = performance.now(); lookMoved = 0; }
        else continue;
        e.preventDefault();
      }
    }, opt);
    dom.addEventListener('touchmove', e => {
      if (!walking) return;
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          const Rr = 56; const dx = t.clientX - jox, dy = t.clientY - joy; const d = Math.hypot(dx, dy) || 1; const k = Math.min(1, d / Rr);
          jx = dx / d * k; jy = dy / d * k; moveKnob(jx * Rr, jy * Rr); e.preventDefault();
        } else if (t.identifier === lookId) {
          lookMoved += Math.abs(t.clientX - lx) + Math.abs(t.clientY - ly);
          yaw -= (t.clientX - lx) * 0.0045; pitch -= (t.clientY - ly) * 0.0045;
          pitch = clamp(pitch, -1.45, 1.45); lx = t.clientX; ly = t.clientY; e.preventDefault();
        }
      }
    }, opt);
    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) { joyId = null; jx = jy = 0; moveKnob(0, 0); }
        if (t.identifier === lookId) { if (lookMoved < 8 && performance.now() - lookT0 < 250) jumpQueued = true; lookId = null; }   // a quick still tap jumps
      }
    };
    dom.addEventListener('touchend', end); dom.addEventListener('touchcancel', end);
  }
  function showStick(on) {
    if (!touch) return;
    if (!stickEl) {
      stickEl = document.createElement('div'); stickEl.id = 'thalyn-stick';
      stickEl.style.cssText = 'position:fixed;left:24px;bottom:90px;width:112px;height:112px;border-radius:50%;border:1px solid rgba(232,198,106,0.45);background:rgba(13,20,17,0.35);z-index:9;pointer-events:none;display:none';
      knobEl = document.createElement('div');
      knobEl.style.cssText = 'position:absolute;left:36px;top:36px;width:40px;height:40px;border-radius:50%;background:rgba(232,198,106,0.55);box-shadow:0 0 10px rgba(232,198,106,0.5)';
      stickEl.appendChild(knobEl); document.body.appendChild(stickEl);
    }
    stickEl.style.display = on ? 'block' : 'none';
    if (on) { stickEl.style.left = '24px'; stickEl.style.bottom = '90px'; stickEl.style.top = ''; moveKnob(0, 0); }
  }
  function placeStick(x, y) { if (!stickEl) return; stickEl.style.left = (x - 56) + 'px'; stickEl.style.top = (y - 56) + 'px'; stickEl.style.bottom = ''; }
  function moveKnob(dx, dy) { if (knobEl) knobEl.style.transform = `translate(${dx}px, ${dy}px)`; }

  const _fwd = new THREE.Vector3();
  function step(dt) {
    if (!walking) return;
    let f = 0, r = 0, run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
    if (touch) {
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      if (Math.hypot(jx, jy) > 0.08) { f = -jy; r = jx; run = Math.hypot(jx, jy) > 0.85; }
    }
    // the wanted direction in world space from the camera's yaw (the old ctl.moveForward / moveRight, flat)
    camera.getWorldDirection(_fwd); _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const n = Math.max(1, Math.hypot(f, r));
    const mx = (_fwd.x * f - _fwd.z * r) / n, mz = (_fwd.z * f + _fwd.x * r) / n;

    if (fly) {   // ?fly=1 only: the old free flight (no gravity, no blockers but the ground)
      let u = 0;
      if (keys.has('KeyE') || keys.has('Space')) u += 1;
      if (keys.has('KeyQ') || keys.has('KeyC')) u -= 1;
      const sp = run ? R.runMps : R.walkMps;
      body.x += mx * sp * dt; body.z += mz * sp * dt; flyY += u * sp * dt;
      const g = groundAt(body.x, body.z, flyY + 3);
      if (g !== null && flyY - R.eyeM < g) flyY = g + R.eyeM;
      body.y = flyY - R.eyeM;
      camera.position.set(body.x, flyY, body.z);
      return;
    }
    const wasSwim = body.swimming, beforeY = body.y;
    const ev = stepBody(body, { mx, mz, run, jump: jumpQueued }, env, R, dt);
    jumpQueued = false;
    if (ev.swimStart && !wasSwim) onState && onState(true, 'swim');
    if (ev.swimEnd && wasSwim) onState && onState(true, 'walk');
    if (ev.jumped) console.info('[thalyn-body] jump');
    if (ev.landed > 6 && performance.now() - lastLog > 500) { lastLog = performance.now(); console.info(`[thalyn-body] landed at ${ev.landed.toFixed(1)} m/s`); }
    // the eye: follows the body exactly in the air (a jump must feel immediate); a step up or down on the ground is eased (the old 12/s)
    const eyeY = body.y + R.eyeM;
    camera.position.x = body.x; camera.position.z = body.z;
    if (!body.grounded || body.swimming && Math.abs(body.y - beforeY) > 0.5) camera.position.y = eyeY;
    else camera.position.y += (eyeY - camera.position.y) * Math.min(1, dt * (body.swimming ? 4 : 12));
  }
  // A5403 · I2 · E OPENS THE DOOR YOU FACE (the app's E). Space jumps. A press a door took is ignored until its key-up.
  let eTaken = false;
  function onKey(e, down) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return false;
    if (e.code === 'KeyE') {
      if (!down) { eTaken = false; keys.delete(e.code); return true; }
      if (eTaken) return true;
      if (walking && !e.repeat && opts.doors && opts.doors.use()) { eTaken = true; keys.delete('KeyE'); return true; }
    }
    if (e.code === 'Space' && down && walking && !e.repeat && !fly) { jumpQueued = true; if (e.preventDefault) e.preventDefault(); }
    if (e.code === 'KeyF' && down && walking && !e.repeat && allowFly) {
      if (fly) { fly = false; body.vy = 0; body.grounded = false; console.info('[thalyn-body] flight off - falling'); }
      else { fly = true; flyY = camera.position.y; console.info('[thalyn-body] flight on (?fly=1)'); }
    }
    if (down) keys.add(e.code); else keys.delete(e.code);
    return true;
  }
  function setRules(rules) { R = bodyRules(rules); allowFly = !!opts.allowFly || !!(rules && rules.fly); }
  return { enterAt, enterPose, enterSpawn, exit, step, onKey, setRules, body,
    get active() { return walking; }, get flying() { return fly; }, get swimming() { return body.swimming; }, get grounded() { return body.grounded; },
    get touch() { return touch; }, get allowFly() { return allowFly; }, ctl };
}
