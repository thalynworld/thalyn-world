// Thalyn® World Viewer — walking a shared world in a headset (WebXR, Meta Quest browser; A13560–A13565).
//
// "Enter VR" on any shared link: no app. Teleport is the default way to move (right stick forward draws an arc, let
// go to jump, a short blink); smooth walking is a choice on the wrist menu (2 m/s, the edges of the view dim while you
// move). Snap turn 30° on the right stick (left stick click switches 30/45). The left wrist carries a small menu,
// pointed at with the right hand's laser and clicked with the trigger: Teleport / Smooth, Size (life size or giant —
// the world at 1:10, a diorama at your feet), Exit. Messages that would be toasts on a screen show on the wrist.
// Controllers are drawn from the standard xr-standard profile (three's XRControllerModelFactory, same CDN host).
// Nothing here glows.
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export const XR = { arcSpeed: 7, arcGravity: 9.8, arcSteps: 40, arcDt: 0.06, blinkS: 0.15, snapDeg: [30, 45], giant: 10, stickDead: 0.12, stickFire: 0.6 };

/** deps: { renderer, scene, camera, dolly, groundAt(x, z, fromY), tierTable(), onEnter(), onExit() } */
export function makeXR(deps) {
  const { renderer, scene, camera, dolly } = deps;
  let mode = 'teleport', scale = 1, snapI = 0, snapCooldown = 0, active = false;
  const factory = new XRControllerModelFactory();
  const hands = { left: null, right: null };   // { ctrl, grip, src }

  // ── Controllers + models + the right hand's laser ──
  const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    const laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: 0xE8C66A, transparent: true, opacity: 0.55 }));
    laser.scale.z = 3; laser.visible = false; ctrl.add(laser);
    ctrl.addEventListener('connected', e => {
      const h = e.data.handedness === 'left' ? 'left' : 'right';
      hands[h] = { ctrl, grip, src: e.data, laser };
      laser.visible = h === 'right';
      if (h === 'left') grip.add(panel.mesh);
    });
    ctrl.addEventListener('disconnected', () => { for (const k of ['left', 'right']) if (hands[k] && hands[k].ctrl === ctrl) hands[k] = null; });
    ctrl.addEventListener('selectstart', () => { if (hands.right && hands.right.ctrl === ctrl) clickPanel(); });
    dolly.add(ctrl, grip);
  }

  // ── The wrist panel (a canvas on a small plane; the right laser points, the trigger clicks) ──
  const panel = (() => {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 384;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.12), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    mesh.position.set(0, 0.07, 0.04); mesh.rotation.set(-Math.PI / 3, 0, 0); mesh.name = 'XR_WristPanel';
    const items = [
      { id: 'move', label: () => 'Move: ' + (mode === 'teleport' ? 'Teleport' : 'Smooth walk') },
      { id: 'scale', label: () => 'Size: ' + (scale === 1 ? 'Life size' : 'Giant (1:' + XR.giant + ')') },
      { id: 'turn', label: () => 'Turn: ' + XR.snapDeg[snapI] + '°' },
      { id: 'exit', label: () => 'Leave VR' },
    ];
    let msg = '', msgT = 0, hover = -1;
    function draw() {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, 512, 384);
      g.fillStyle = 'rgba(13,20,17,0.88)'; g.strokeStyle = 'rgba(232,198,106,0.6)'; g.lineWidth = 4;
      g.beginPath(); g.roundRect(4, 4, 504, 376, 24); g.fill(); g.stroke();
      g.font = '600 30px Georgia, serif'; g.fillStyle = '#E8C66A'; g.textBaseline = 'middle'; g.fillText('Thalyn', 28, 40);
      items.forEach((it, i) => {
        const y = 86 + i * 64;
        g.fillStyle = i === hover ? 'rgba(232,198,106,0.32)' : 'rgba(232,198,106,0.12)'; g.beginPath(); g.roundRect(24, y, 464, 52, 12); g.fill();
        g.fillStyle = '#e8efe9'; g.font = '26px ui-sans-serif, system-ui, sans-serif'; g.fillText(it.label(), 44, y + 27);
      });
      if (msg) { g.fillStyle = '#cfe0d7'; g.font = '20px ui-sans-serif, system-ui, sans-serif'; g.fillText(msg.slice(0, 44), 28, 356); }
      tex.needsUpdate = true;
    }
    draw();
    return {
      mesh, items, draw,
      say(m) { msg = String(m || ''); msgT = 5; draw(); },
      tick(dt) { if (msgT > 0 && (msgT -= dt) <= 0) { msg = ''; draw(); } },
      setHover(i) { if (i !== hover) { hover = i; draw(); } },
      itemAt(uv) { const y = (1 - uv.y) * 384, x = uv.x * 512; if (x < 24 || x > 488) return -1; const i = Math.floor((y - 86) / 64); return i >= 0 && i < items.length && (y - 86) - i * 64 <= 52 ? i : -1; },
    };
  })();
  const ray = new THREE.Raycaster(), _m = new THREE.Matrix4();
  function panelHit() {
    const r = hands.right; if (!r || !panel.mesh.parent) return null;
    _m.identity().extractRotation(r.ctrl.matrixWorld);
    ray.ray.origin.setFromMatrixPosition(r.ctrl.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(_m);
    const h = ray.intersectObject(panel.mesh, false)[0];
    return h ? { i: panel.itemAt(h.uv), d: h.distance } : null;
  }
  function clickPanel() {
    const h = panelHit(); if (!h || h.i < 0) return;
    const id = panel.items[h.i].id;
    if (id === 'move') { mode = mode === 'teleport' ? 'smooth' : 'teleport'; panel.say(mode === 'teleport' ? 'Push the right stick forward, let go to jump' : 'Left stick walks'); }
    else if (id === 'scale') setScale(scale === 1 ? XR.giant : 1);
    else if (id === 'turn') snapI = (snapI + 1) % XR.snapDeg.length;
    else if (id === 'exit') { const s = renderer.xr.getSession(); if (s) s.end(); return; }
    panel.draw();
    console.info('[thalyn-xr] menu: ' + id + ' → ' + panel.items[h.i].label());
  }
  function setScale(k) {
    // Giant = the dolly grows (never the camera): the world becomes a diorama at your feet.
    const cw = camera.getWorldPosition(new THREE.Vector3());
    scale = k; dolly.scale.setScalar(k);
    const after = camera.getWorldPosition(new THREE.Vector3());
    dolly.position.x += cw.x - after.x; dolly.position.z += cw.z - after.z;
    panel.say(k === 1 ? 'Life size' : 'Giant: the world at your feet');
  }

  // ── Teleport arc + target ring + blink ──
  const ARC_N = XR.arcSteps;
  const arcPos = new Float32Array(ARC_N * 3), arcGeo = new THREE.BufferGeometry(); arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
  const arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0xE8C66A, transparent: true, opacity: 0.8 })); arc.frustumCulled = false; arc.visible = false;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.32, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xE8C66A, transparent: true, opacity: 0.85 }));
  ring.visible = false;
  scene.add(arc, ring);
  const blink = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false }));
  blink.renderOrder = 9999; camera.add(blink);
  const vignette = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.4, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false }));
  vignette.position.z = -0.1; vignette.renderOrder = 9998; camera.add(vignette);
  let aiming = false, target = null, blinkT = 0, pendingJump = null;
  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
  function traceArc() {
    const r = hands.right; if (!r) return null;
    _m.identity().extractRotation(r.ctrl.matrixWorld);
    _o.setFromMatrixPosition(r.ctrl.matrixWorld); _d.set(0, 0, -1).applyMatrix4(_m).multiplyScalar(XR.arcSpeed * scale);
    let hit = null, n = 0;
    _p.copy(_o);
    for (let i = 0; i < ARC_N; i++) {
      arcPos[i * 3] = _p.x; arcPos[i * 3 + 1] = _p.y; arcPos[i * 3 + 2] = _p.z; n = i + 1;
      const g = deps.groundAt(_p.x, _p.z, _p.y + 2 * scale);
      if (g !== null && _p.y <= g) { hit = new THREE.Vector3(_p.x, g, _p.z); break; }
      _p.addScaledVector(_d, XR.arcDt); _d.y -= XR.arcGravity * scale * XR.arcDt;
    }
    for (let i = n; i < ARC_N; i++) { arcPos[i * 3] = _p.x; arcPos[i * 3 + 1] = _p.y; arcPos[i * 3 + 2] = _p.z; }
    arcGeo.attributes.position.needsUpdate = true;
    return hit;
  }
  function jumpTo(p) {
    const cw = camera.getWorldPosition(new THREE.Vector3());
    dolly.position.x += p.x - cw.x; dolly.position.z += p.z - cw.z; dolly.position.y = p.y;
  }

  // ── Session ──
  renderer.xr.addEventListener('sessionstart', () => {
    active = true;
    const t = deps.tierTable() || {};
    try { if (t.foveation !== undefined) renderer.xr.setFoveation(t.foveation); } catch (e) {}
    panel.say(mode === 'teleport' ? 'Right stick forward: aim, let go to jump' : 'Left stick walks');
    console.info('[thalyn-xr] A13560 session start · move=' + mode + ' · scale ' + scale + ' · foveation ' + (t.foveation ?? 'default') + ' · framebuffer ' + (t.xrScale ?? 1));
    deps.onEnter && deps.onEnter();
  });
  renderer.xr.addEventListener('sessionend', () => {
    active = false; arc.visible = ring.visible = false; if (scale !== 1) { scale = 1; dolly.scale.setScalar(1); }
    console.info('[thalyn-xr] session end');
    deps.onExit && deps.onExit();
  });
  /** Set before a session starts (the framebuffer scale cannot change mid-session). */
  function prepare() { const t = deps.tierTable() || {}; try { renderer.xr.setFramebufferScaleFactor(t.xrScale || 1); } catch (e) {} }

  function step(dt) {
    const session = renderer.xr.getSession(); if (!session) return;
    snapCooldown = Math.max(0, snapCooldown - dt);
    panel.tick(dt);
    let mx = 0, mz = 0, rx = 0, ry = 0, lClick = false;
    for (const src of session.inputSources) {
      const gp = src.gamepad, a = gp && gp.axes; if (!a || a.length < 2) continue;
      const x = a.length >= 4 ? a[2] : a[0], y = a.length >= 4 ? a[3] : a[1];
      if (src.handedness === 'right') { rx = x; ry = y; } else { mx += x; mz += y; if (gp.buttons[3] && gp.buttons[3].pressed) lClick = true; }
    }
    if (lClick && snapCooldown === 0) { snapI = (snapI + 1) % XR.snapDeg.length; snapCooldown = 0.4; panel.say('Turn ' + XR.snapDeg[snapI] + '°'); panel.draw(); }
    // Snap turn (right stick sideways), around the head, not the dolly origin.
    if (Math.abs(rx) > XR.stickFire && Math.abs(rx) > Math.abs(ry) && snapCooldown === 0) {
      const cw = camera.getWorldPosition(new THREE.Vector3());
      dolly.rotateY(-Math.sign(rx) * XR.snapDeg[snapI] * Math.PI / 180);
      const after = camera.getWorldPosition(new THREE.Vector3());
      dolly.position.x += cw.x - after.x; dolly.position.z += cw.z - after.z;
      snapCooldown = 0.35;
    }
    // Teleport: right stick forward aims; letting go jumps (with a blink).
    if (mode === 'teleport') {
      const pushing = ry < -XR.stickFire && Math.abs(ry) > Math.abs(rx);
      if (pushing) { aiming = true; target = traceArc(); arc.visible = true; ring.visible = !!target; if (target) { ring.position.copy(target); ring.scale.setScalar(scale); } }
      else if (aiming && Math.abs(ry) < 0.3) {
        aiming = false; arc.visible = ring.visible = false;
        if (target) { pendingJump = target.clone(); blinkT = XR.blinkS * 2; console.info('[thalyn-xr] teleport → ' + target.x.toFixed(1) + ', ' + target.z.toFixed(1)); }
        target = null;
      }
    }
    if (blinkT > 0) {
      blinkT = Math.max(0, blinkT - dt);
      const half = XR.blinkS;
      if (pendingJump && blinkT <= half) { jumpTo(pendingJump); pendingJump = null; }
      blink.material.opacity = blinkT > half ? 1 - (blinkT - half) / half : blinkT / half;
    } else blink.material.opacity = 0;
    // Smooth walk (opt-in): left stick, the head's forward, with a vignette that closes with speed.
    let speed = 0;
    if (mode === 'smooth' && (Math.abs(mx) > XR.stickDead || Math.abs(mz) > XR.stickDead)) {
      const v = ((deps.tierTable() || {}).smoothMps || 2.0) * scale;
      camera.getWorldDirection(_f); _f.y = 0; if (_f.lengthSq() > 1e-4) _f.normalize();
      _r.set(-_f.z, 0, _f.x);
      dolly.position.addScaledVector(_f, -mz * dt * v).addScaledVector(_r, mx * dt * v);
      speed = Math.min(1, Math.hypot(mx, mz));
    }
    vignette.material.opacity += (speed * 0.75 - vignette.material.opacity) * Math.min(1, dt * 6);
    // Feet on the ground (both modes).
    if (!pendingJump) {
      const cw = camera.getWorldPosition(_p);
      const g = deps.groundAt(cw.x, cw.z, dolly.position.y + 5 * scale);
      if (g !== null) dolly.position.y += (g - dolly.position.y) * Math.min(1, dt * 8);
    }
    // The laser lights the menu item it points at.
    const h = panelHit(); panel.setHover(h ? h.i : -1);
    if (hands.right && hands.right.laser) hands.right.laser.scale.z = h ? h.d : 3;
  }
  return { step, prepare, say: m => panel.say(m), get active() { return active; }, get mode() { return mode; }, get scale() { return scale; } };
}
