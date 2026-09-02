// Thalyn® — "come over to mine": two (or a few) people in one exported world, in the browser.
//
// A share link with ?session=<token> opens a small relay room. Everyone holding the link sees each other
// as a glowing wisp with a name tag, the host can stand a cinema screen anywhere and hold the remote
// (paste a link, play / pause / seek — everyone's screen follows), and push-to-talk voice goes browser to
// browser, heard from where the other person's wisp is.
//
// Sources on the screen are official embeds only (YouTube by its player API) or a plain media file
// (mp4 / webm, drawn straight onto the screen). Nothing is scraped. Voice is direct between the people
// on the link and is never recorded or relayed through a server. The token is an unguessable capability:
// holding the link is the invitation. Everything here degrades to nothing when there is no session.
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const POSE_HZ = 12;
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
export const CONSENT_LINE = 'You are connecting directly with someone you invited.';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// A fresh session token: 16 random bytes, url-safe base64 (22 chars). Never derived from anything.
export function mintSession() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function validSession(t) { return /^[A-Za-z0-9_-]{16,64}$/.test(String(t || '')); }

// YouTube URL / id → the 11-char id, or null. Anything that is not YouTube or a plain media file is refused.
export function parseSource(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { source: 'youtube', id: s };
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') { const id = u.pathname.slice(1).split('/')[0]; if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { source: 'youtube', id }; }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v'); if (/^[A-Za-z0-9_-]{11}$/.test(v || '')) return { source: 'youtube', id: v };
      const m = u.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/); if (m) return { source: 'youtube', id: m[1] };
    }
    if (u.protocol === 'https:' && /\.(mp4|webm|ogv|ogg|m4v)(\?.*)?$/i.test(u.pathname + u.search)) return { source: 'file', url: u.href };
  } catch (e) {}
  return null;
}

let tagTexCache = new Map();
function nameTagTexture(name, accent) {
  const key = name + '|' + accent;
  if (tagTexCache.has(key)) return tagTexCache.get(key);
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.font = '600 52px Georgia, serif';
  const w = Math.min(480, g.measureText(name).width + 56);
  g.fillStyle = 'rgba(13,20,17,0.72)';
  const x = (512 - w) / 2; g.beginPath(); g.roundRect(x, 24, w, 80, 22); g.fill();
  g.strokeStyle = accent; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#F2E6C4'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, 256, 66);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  tagTexCache.set(key, t); return t;
}
let wispTex = null;
function wispTexture() {
  if (wispTex) return wispTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.18, 'rgba(255,245,200,0.95)'); grd.addColorStop(0.45, 'rgba(232,198,106,0.45)'); grd.addColorStop(1, 'rgba(0,168,160,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  wispTex = new THREE.CanvasTexture(cv); wispTex.colorSpace = THREE.SRGBColorSpace; return wispTex;
}

// ── The session ─────────────────────────────────────────────────────────────
// opts: { relay (https/wss base), session, name, camera, scene, dom, onStatus(text), onPeers(list), onCinema(c), onHost(isHost), voice (bool) }
export function makeTogether(opts) {
  const { camera, scene } = opts;
  const relay = String(opts.relay || '').replace(/\/+$/, '');
  const session = opts.session;
  let ws = null, me = null, hostId = null, name = String(opts.name || 'Someone').slice(0, 24), closed = false;
  let offset = 0, rtt = 0;               // server clock offset (serverTs − local), ms
  const peers = new Map();               // id → { id, name, wisp, tag, target(Vector3), yaw, seen, pan, audioEl, pc, waveT }
  const wispRoot = new THREE.Group(); wispRoot.name = 'Thalyn_Wisps'; scene.add(wispRoot);
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Quaternion();
  let sendAcc = 0, lastSent = null, retry = 0, reconnectT = null;
  const status = t => { try { opts.onStatus && opts.onStatus(t); } catch (e) {} };
  const log = (...a) => console.info('[together]', ...a);

  // ── Wisps ──
  function addPeer(id, pname, pose) {
    if (peers.has(id)) return peers.get(id);
    const accent = '#E8C66A';
    const wisp = new THREE.Sprite(new THREE.SpriteMaterial({ map: wispTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 }));
    wisp.scale.setScalar(1.1); wisp.renderOrder = 20;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTagTexture(pname, accent), transparent: true, depthWrite: false, depthTest: false }));
    tag.scale.set(2.6, 0.65, 1); tag.renderOrder = 21;
    const light = new THREE.PointLight(0xE8C66A, 6, 9, 2);
    const g = new THREE.Group(); g.add(wisp, tag, light); tag.position.y = 0.95;
    g.visible = false; wispRoot.add(g);
    const p = { id, name: pname, group: g, wisp, tag, light, target: new THREE.Vector3(), yaw: 0, seen: 0, waveT: 0, phase: Math.random() * 7, pan: null, audioEl: null, pc: null, stream: null };
    if (pose && Array.isArray(pose.p)) { p.target.set(pose.p[0], pose.p[1], pose.p[2]); g.position.copy(p.target); g.visible = true; p.seen = performance.now(); }
    peers.set(id, p);
    peersChanged();
    return p;
  }
  function removePeer(id) {
    const p = peers.get(id); if (!p) return;
    wispRoot.remove(p.group);
    if (p.pc) { try { p.pc.close(); } catch (e) {} }
    if (p.audioEl) { try { p.audioEl.srcObject = null; p.audioEl.remove(); } catch (e) {} }
    if (p.pan) { try { p.pan.disconnect(); } catch (e) {} }
    peers.delete(id); peersChanged();
  }
  function peersChanged() { try { opts.onPeers && opts.onPeers([...peers.values()].map(p => ({ id: p.id, name: p.name }))); } catch (e) {} }

  // ── Socket ──
  function url() { return relay.replace(/^http/, 'ws') + '/s/' + encodeURIComponent(session); }
  function connect() {
    if (closed) return;
    status('Connecting…');
    try { ws = new WebSocket(url()); } catch (e) { status('Relay unavailable'); return; }
    ws.onopen = () => { retry = 0; send({ type: 'hello', name }); ping(); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } handle(m); };
    ws.onclose = ev => {
      ws = null;
      if (closed) return;
      if (ev && ev.code === 1013) { status('That session is full'); return; }
      status('Reconnecting…');
      reconnectT = setTimeout(connect, Math.min(8000, 800 * Math.pow(2, retry++)));
    };
    ws.onerror = () => {};
  }
  function send(m) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch (e) {} } }
  let pingT = null;
  function ping() { send({ type: 'ping', t: performance.now() }); clearTimeout(pingT); pingT = setTimeout(ping, 6000); }
  function serverNow() { return performance.now() + offset; }

  function handle(m) {
    switch (m.type) {
      case 'welcome': {
        me = m.id; hostId = m.host;
        for (const p of (m.peers || [])) addPeer(p.id, p.name, p.pose);
        if (m.cinema) cinema.apply(m.cinema, m.serverTs);
        cinema.trySeed();   // the world's own screen (extras.thalyn.cinema) stands itself when the room has none and I hold the remote
        status(peers.size ? `${peers.size + 1} here` : 'You are here alone — send the invite link');
        try { opts.onHost && opts.onHost(me === hostId); } catch (e) {}
        log('joined as', me, 'host', hostId, 'peers', peers.size);
        // Voice: connect to everyone already here (the lower id makes the offer, so two joiners never both offer).
        for (const p of peers.values()) voice.ensurePeer(p);
        return;
      }
      case 'pong': { const now = performance.now(); rtt = now - m.t; offset = m.serverTs - (m.t + rtt / 2); return; }
      case 'join': { const p = addPeer(m.id, m.name, null); status(`${m.name} is here · ${peers.size + 1} here`); log('join', m.id, m.name); voice.ensurePeer(p); cinema.nudge(); return; }
      case 'leave': { const p = peers.get(m.id); removePeer(m.id); status(peers.size ? `${p ? p.name + ' left · ' : ''}${peers.size + 1} here` : 'You are here alone'); log('leave', m.id); return; }
      case 'pose': { const p = peers.get(m.id) || addPeer(m.id, '…', null); p.target.set(m.p[0], m.p[1], m.p[2]); p.yaw = m.y || 0; if (!p.group.visible) { p.group.position.copy(p.target); p.group.visible = true; } if (!p.poses) { p.poses = 0; console.info('[together] first pose from', m.id, m.p.map(v => v.toFixed(1)).join(',')); } p.poses++; p.seen = performance.now(); return; }
      case 'host': { hostId = m.id; try { opts.onHost && opts.onHost(me === hostId); } catch (e) {} const who = hostId === me ? 'You hold the remote' : ((peers.get(hostId) || {}).name || 'Someone') + ' holds the remote'; status(who); cinema.trySeed(); return; }
      case 'cinema': cinema.apply(m.cinema, m.serverTs); return;
      case 'rtc': voice.onSignal(m.from, m.data); return;
      case 'wave': { const p = peers.get(m.id); if (p) p.waveT = 1.6; return; }
      case 'denied': status(m.reason || 'Not allowed'); return;
      case 'full': status('That session is full'); return;
    }
  }

  // ── Cinema ──
  const cinema = makeCinema({ scene, camera, dom: opts.dom, onState: t => status(t), isHost: () => me === hostId, joinedRoom: () => !!me, serverNow: () => serverNow(),
    sendCinema: c => send({ type: 'cinema', cinema: c }) });
  if (opts.cinemaSeed) cinema.setSeed(opts.cinemaSeed);   // the export's screen, when the world loaded before the session began

  // ── Voice (push-to-talk, P2P, spatial) ──
  const voice = makeVoice({ peers, send, myId: () => me, camera, enabled: !!opts.voice, onStatus: status });

  // ── Per-frame ──
  function tick(dt) {
    // my pose, at POSE_HZ and only when it changed
    sendAcc += dt;
    if (ws && ws.readyState === 1 && me && sendAcc >= 1 / POSE_HZ) {
      sendAcc = 0;
      camera.getWorldPosition(_p); camera.getWorldDirection(_f);
      const yaw = Math.atan2(_f.x, _f.z), pitch = Math.asin(clamp(_f.y, -1, 1));
      const key = `${_p.x.toFixed(1)},${_p.y.toFixed(1)},${_p.z.toFixed(1)},${yaw.toFixed(2)},${pitch.toFixed(2)}`;
      if (key !== lastSent) { lastSent = key; send({ type: 'pose', p: [_p.x, _p.y, _p.z], y: yaw, h: pitch }); }
    }
    // the others: interpolate, bob, face me, fade if silent
    const now = performance.now();
    camera.getWorldPosition(_p);
    for (const p of peers.values()) {
      if (!p.group.visible) continue;
      p.group.position.lerp(p.target, Math.min(1, dt * 9));
      p.phase += dt;
      const bob = Math.sin(p.phase * 1.7) * 0.08;
      p.wisp.position.y = bob; p.light.position.y = bob;
      p.light.intensity = 5 + Math.sin(p.phase * 5.3) * 1.2 + (p.waveT > 0 ? 8 * p.waveT : 0);
      const s = 1.05 + Math.sin(p.phase * 3.1) * 0.06 + (p.waveT > 0 ? 0.5 * p.waveT : 0);
      p.wisp.scale.setScalar(s);
      if (p.waveT > 0) p.waveT = Math.max(0, p.waveT - dt);
      const d = p.group.position.distanceTo(_p);
      p.tag.material.opacity = d < 3 ? 0.35 : clamp(1.6 - d / 120, 0.15, 1);
      p.tag.scale.set(2.6 + d * 0.02, 0.65 + d * 0.005, 1);
      if (now - p.seen > 20000) p.group.visible = false; // silent for 20 s — the wisp fades out of the world
      if (p.pan) voice.place(p, p.group.position);
    }
    voice.tick(dt);
    cinema.tick(dt);
  }

  function inviteURL() {
    const u = new URL(location.href);
    u.searchParams.set('session', session);
    u.searchParams.delete('name'); u.searchParams.delete('hidehud'); u.searchParams.delete('perf');
    return u.toString();
  }
  function wave() { send({ type: 'wave' }); }
  function passRemote(id) { if (me === hostId) send({ type: 'remote', to: id }); }
  function close() { closed = true; clearTimeout(reconnectT); clearTimeout(pingT); try { ws && ws.close(); } catch (e) {} for (const id of [...peers.keys()]) removePeer(id); voice.close(); cinema.dispose(); scene.remove(wispRoot); }

  connect();
  return {
    tick, inviteURL, wave, passRemote, close, cinema, voice,
    setCinemaSeed: c => cinema.setSeed(c),   // the world's own screen (extras.thalyn.cinema), when it loads after the session began
    get session() { return session; }, get me() { return me; }, get isHost() { return me === hostId; }, get hostId() { return hostId; },
    get peers() { return [...peers.values()].map(p => ({ id: p.id, name: p.name })); },
    get rtt() { return rtt; }, get connected() { return !!(ws && ws.readyState === 1); },
    get posesSeen() { let n = 0; for (const p of peers.values()) n += p.poses || 0; return n; },
    setName(n) { name = String(n || 'Someone').slice(0, 24); },
  };
}

// ── The cinema screen ────────────────────────────────────────────────────────
// A framed screen in the world. A YouTube showing is the official IFrame player on a CSS3D layer that
// sits over the canvas (so it draws on top of the world — nothing can stand in front of it, an accepted
// V1 limit); a plain media file is a VideoTexture on the screen mesh itself (fully in the world).
// Sync: the host's state {playing|paused, t, at(serverTs)} → everyone snaps to t + (now − at).
function makeCinema({ scene, camera, dom, onState, isHost, joinedRoom, serverNow, sendCinema }) {
  let state = null;            // last cinema record from the room
  // A165 · THE WORLD'S OWN SCREEN. A Thalyn export carries `extras.thalyn.cinema` — the screen the maker stood
  // in the app (centre, facing, width; never any media). When the room has no screen yet and I hold the
  // remote, that screen is stood exactly there, once; the host may still move or remove it, and a room that
  // already has a screen keeps it. Host-placed remains the fallback for worlds exported without one.
  let seed = null, seedSent = false;
  function setSeed(c) {
    seed = (c && Array.isArray(c.pos) && c.pos.length === 3 && c.pos.every(Number.isFinite))
      ? { pos: c.pos.map(Number), yaw: Number(c.yaw) || 0, pitch: clamp(Number(c.pitch) || 0, -1.55, 1.55), floating: !!c.floating, w: clamp(Number(c.w) || 8, 2, 60) } : null;
    trySeed();
  }
  function trySeed() {
    if (!seed || seedSent || !(joinedRoom && joinedRoom()) || !isHost()) return;
    seedSent = true;
    if (state && state.placed) { console.info('[together] cinema: the room already has a screen — the export\'s own is not applied'); return; }
    sendCinema({ pos: seed.pos, yaw: seed.yaw, pitch: seed.pitch, floating: seed.floating, w: seed.w });
    console.info('[together] cinema seeded from the export', JSON.stringify(seed));
  }
  const group = new THREE.Group(); group.name = 'Thalyn_Cinema'; group.visible = false; scene.add(group);
  let W = 8, H = 4.5;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.6, metalness: 0.2 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xE8C66A, roughness: 0.35, metalness: 0.85, emissive: 0x3a2a08, emissiveIntensity: 0.6 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.24), frameMat);
  const rim = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.2), goldMat);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x05070a });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
  screen.position.z = 0.13;
  const glow = new THREE.PointLight(0x9fd8ff, 0, 18, 2); glow.position.set(0, 0, 2);
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1, 8), goldMat), legR = legL.clone();
  group.add(frame, rim, screen, glow, legL, legR);
  // CSS3D layer for the YouTube player
  const css = new CSS3DRenderer();
  css.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4';
  const cssScene = new THREE.Scene();
  let cssObj = null, ytDiv = null, yt = null, ytReady = false, ytLoading = false, video = null, videoTex = null, joined = false, muted = true;
  let driftT = 0, lastApplied = '';

  function layout() {
    frame.scale.set(W + 0.7, H + 0.7, 1); rim.scale.set(W + 0.5, H + 0.5, 1); rim.position.z = 0.02; frame.position.z = -0.02;
    screen.scale.set(W, H, 1);
    legL.scale.y = Math.max(0.5, H * 0.5); legR.scale.y = legL.scale.y;
    legL.position.set(-W * 0.4, -H / 2 - legL.scale.y / 2 - 0.3, -0.1); legR.position.set(W * 0.4, legL.position.y, -0.1);
    if (cssObj) { cssObj.scale.setScalar(W / 640); }
  }
  function ensureCss() {
    if (cssObj) return;
    dom.appendChild(css.domElement);
    ytDiv = document.createElement('div'); ytDiv.style.cssText = 'width:640px;height:360px;background:#000;pointer-events:none';
    const inner = document.createElement('div'); ytDiv.appendChild(inner);
    cssObj = new CSS3DObject(ytDiv); cssObj.position.z = 0.14; cssObj.scale.setScalar(W / 640);
    cssScene.add(cssObj);
    ytDiv.__inner = inner;
  }
  function loadYT() {
    return new Promise(res => {
      if (window.YT && window.YT.Player) return res();
      if (!ytLoading) {
        ytLoading = true;
        const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev && prev(); res(); };
    });
  }
  async function showYouTube(id) {
    ensureCss(); disposeVideo();
    await loadYT();
    if (yt && ytReady) { yt.loadVideoById(id); yt.pauseVideo(); return; }
    if (yt) { try { yt.destroy(); } catch (e) {} yt = null; }
    ytReady = false;
    const host = document.createElement('div'); ytDiv.__inner.replaceChildren(host);
    yt = new window.YT.Player(host, {
      width: 640, height: 360, videoId: id,
      playerVars: { controls: 0, rel: 0, playsinline: 1, modestbranding: 1, disablekb: 1, iv_load_policy: 3, origin: location.origin, enablejsapi: 1 },
      events: {
        onReady: () => { ytReady = true; if (muted) yt.mute(); applyState(true); },
        onStateChange: ev => { if (ev.data === 1 && !isHost() && state && state.state === 'paused') { try { yt.pauseVideo(); } catch (e) {} } },
        onError: ev => onState('That video cannot be played here (embedding is off for it)'),
      },
    });
    const ifr = host.tagName === 'IFRAME' ? host : ytDiv.querySelector('iframe');
    if (ifr) ifr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
  }
  function disposeVideo() { if (video) { try { video.pause(); video.src = ''; video.load(); } catch (e) {} video = null; } if (videoTex) { videoTex.dispose(); videoTex = null; } screenMat.map = null; screenMat.color.set(0x05070a); screenMat.needsUpdate = true; }
  function showFile(u) {
    if (yt) { try { yt.destroy(); } catch (e) {} yt = null; ytReady = false; if (ytDiv) ytDiv.__inner.replaceChildren(); }
    disposeVideo();
    video = document.createElement('video'); video.crossOrigin = 'anonymous'; video.playsInline = true; video.loop = false; video.muted = muted; video.preload = 'auto';
    video.src = u; video.load();
    videoTex = new THREE.VideoTexture(video); videoTex.colorSpace = THREE.SRGBColorSpace;
    screenMat.map = videoTex; screenMat.color.set(0xffffff); screenMat.needsUpdate = true;
    video.addEventListener('loadedmetadata', () => applyState(true), { once: true });
  }
  function expectedTime() {
    if (!state) return 0;
    return state.state === 'playing' ? state.t + Math.max(0, (serverNow() - state.at) / 1000) : state.t;
  }
  function applyState(force) {
    if (!state || !state.source) return;
    const key = state.source + state.id + state.url + state.state + state.t + state.at;
    if (!force && key === lastApplied) return; lastApplied = key;
    const t = expectedTime();
    if (state.source === 'youtube' && yt && ytReady) {
      try {
        if (state.state === 'playing') { if (Math.abs(yt.getCurrentTime() - t) > 1.0) yt.seekTo(t, true); if (yt.getPlayerState() !== 1) yt.playVideo(); }
        else { if (yt.getPlayerState() === 1) yt.pauseVideo(); if (Math.abs(yt.getCurrentTime() - t) > 0.5) yt.seekTo(t, true); }
      } catch (e) {}
    } else if (state.source === 'file' && video) {
      if (state.state === 'playing') { if (Math.abs(video.currentTime - t) > 0.6) video.currentTime = t; video.play().catch(() => {}); }
      else { video.pause(); if (Math.abs(video.currentTime - t) > 0.3) video.currentTime = t; }
    }
  }
  function apply(c, serverTs) {
    const prevSrc = state && (state.source + state.id + state.url);
    state = c;
    if (c && c.placed && Array.isArray(c.pos)) {
      // Yaw about the world's up, then pitch about the screen's own horizontal axis (a floating screen looks down at you).
      group.position.set(c.pos[0], c.pos[1], c.pos[2]); group.rotation.order = 'YXZ'; group.rotation.set(c.pitch || 0, c.yaw || 0, 0);
      W = c.w || 8; H = W * 9 / 16; layout(); group.visible = true;
      legL.visible = legR.visible = !c.floating;   // a floating screen has nothing to stand on
    } else group.visible = false;
    const src = c && (c.source + c.id + c.url);
    if (c && c.source && src !== prevSrc) {
      if (c.source === 'youtube') showYouTube(c.id); else if (c.source === 'file') showFile(c.url);
      onState(isHost() ? 'Showing loaded — press Play' : 'A showing is ready — tap “Join the showing”');
    } else if (c && !c.source && prevSrc) { if (yt) { try { yt.destroy(); } catch (e) {} yt = null; ytReady = false; if (ytDiv) ytDiv.__inner.replaceChildren(); } disposeVideo(); }
    glow.intensity = (c && c.source && c.state === 'playing') ? 4 : 0;
    applyState(true);
    console.info('[together] cinema', JSON.stringify({ placed: !!(c && c.placed), source: c && c.source, state: c && c.state, t: c && c.t }));
  }
  // Host actions
  function placeHere() {
    if (!isHost()) { onState('Only the host places the screen'); return; }
    const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; if (f.lengthSq() < 1e-6) f.set(0, 0, -1); f.normalize();
    const p = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(f, 9);
    const yaw = Math.atan2(-f.x, -f.z); // face back toward the placer
    const w = state && state.w ? state.w : 8;
    p.y += w * 9 / 16 * 0.5 + 0.4;
    sendCinema({ pos: [p.x, p.y, p.z], yaw, w, pitch: 0, floating: false });
  }
  function remove() { if (isHost()) sendCinema({ placed: false, source: null }); }
  function resize(w) { if (isHost()) sendCinema({ w: clamp(w, 2, 60) }); }
  function load(raw) {
    if (!isHost()) return false;
    const src = parseSource(raw);
    if (!src) { onState('Paste a YouTube link, or a direct .mp4 / .webm link'); return false; }
    sendCinema(src.source === 'youtube' ? { source: 'youtube', id: src.id } : { source: 'file', url: src.url });
    return true;
  }
  // Only judge drift once the media can actually play (a file still buffering, a player not yet ready, sits at 0 honestly).
  function mediaReady() {
    if (state.source === 'youtube') { try { return !!(yt && ytReady && yt.getDuration() > 0); } catch (e) { return false; } }
    if (state.source === 'file') return !!(video && video.readyState >= 2);
    return false;
  }
  function current() {
    if (state && state.source === 'youtube' && yt && ytReady) { try { return yt.getCurrentTime() || 0; } catch (e) {} }
    if (state && state.source === 'file' && video) return video.currentTime || 0;
    return expectedTime();
  }
  function play() { if (isHost() && state && state.source) sendCinema({ state: 'playing', t: current() }); }
  function pause() { if (isHost() && state && state.source) sendCinema({ state: 'paused', t: current() }); }
  function seek(dt) { if (isHost() && state && state.source) sendCinema({ state: state.state, t: Math.max(0, current() + dt) }); }
  function resync() { if (isHost() && state && state.source) sendCinema({ state: state.state, t: current() }); }
  // Everyone: the one click that lets sound + autoplay happen on this device
  function join() {
    joined = true; muted = false;
    if (yt && ytReady) { try { yt.unMute(); yt.setVolume(80); } catch (e) {} }
    if (video) video.muted = false;
    applyState(true);
    onState('Joined the showing');
  }
  function nudge() { /* a newcomer joined — nothing to do here; the room sends them the cinema record */ }
  function tick(dt) {
    if (group.visible) { css.render(cssScene, camera); if (cssObj) { cssObj.position.copy(group.position); cssObj.quaternion.copy(group.quaternion); cssObj.translateZ(0.14); } }
    else if (cssObj) cssObj.position.set(0, -1e6, 0);
    driftT += dt;
    if (driftT > 2 && state && state.source && state.state === 'playing' && mediaReady()) {
      driftT = 0;
      const t = expectedTime(), cur = current();
      if (Math.abs(cur - t) > 1.5) {
        // The host's own player is the truth: it re-broadcasts its clock (an ad, a stall); everyone else snaps to the room's.
        console.info('[together] cinema drift', (cur - t).toFixed(2), 's —', isHost() ? 're-broadcasting the host clock' : 're-snapping');
        if (isHost()) resync(); else applyState(true);
      }
    }
    if (videoTex) videoTex.needsUpdate = true;
  }
  function dispose() { if (yt) { try { yt.destroy(); } catch (e) {} } disposeVideo(); scene.remove(group); if (css.domElement.parentNode) css.domElement.remove(); }
  function onResize(w, h) { css.setSize(w, h); }
  onResize(innerWidth, innerHeight);
  addEventListener('resize', () => onResize(innerWidth, innerHeight));
  return { apply, placeHere, remove, resize, load, play, pause, seek, resync, join, nudge, tick, dispose, setSeed, trySeed,
    get state() { return state; }, get placed() { return !!(state && state.placed); }, get hasShowing() { return !!(state && state.source); }, get joined() { return joined; },
    get playing() { return !!(state && state.state === 'playing'); }, get width() { return W; }, group };
}

// ── Voice: push-to-talk, direct between browsers, heard from the other wisp ──
// No relay server for the audio (trusted trial). Signalling (offer / answer / ICE) rides the session
// socket. Every pair opens ONE audio channel the moment they meet (so you always hear the other side);
// the mic track is swapped into it when the key is first held — no renegotiation, no glare — and the
// negotiation itself follows the "perfect negotiation" pattern (the higher id is the polite peer).
function makeVoice({ peers, send, myId, camera, enabled, onStatus }) {
  let stream = null, ctx = null, master = null, talking = false, wanted = !!enabled, micState = 'off';
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();
  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  }
  async function ensureMic() {
    if (stream) return true;
    if (!wanted) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const t = stream.getAudioTracks()[0];
      if (t) { t.enabled = talking; for (const p of peers.values()) if (p.tx) p.tx.sender.replaceTrack(t).catch(() => {}); }
      micState = 'ready';
      console.info('[together] mic ready — track swapped into', [...peers.values()].filter(p => p.tx).length, 'channel(s)');
      return true;
    } catch (e) { micState = 'denied'; onStatus('Microphone not available — voice off'); return false; }
  }
  function polite(peerId) { return String(myId()) > String(peerId); }
  function ensurePeer(p) {
    if (p.pc || !myId()) return;
    const pc = new RTCPeerConnection({ iceServers: STUN });
    p.pc = pc; p.makingOffer = false; p.ignoreOffer = false;
    p.tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (stream) { const t = stream.getAudioTracks()[0]; if (t) p.tx.sender.replaceTrack(t).catch(() => {}); }
    pc.onicecandidate = ev => { if (ev.candidate) send({ type: 'rtc', to: p.id, data: { ice: ev.candidate } }); };
    pc.ontrack = ev => attachRemote(p, ev.streams[0] || new MediaStream([ev.track]));
    pc.onconnectionstatechange = () => {
      console.info('[together] voice', p.id, pc.connectionState);
      if (pc.connectionState === 'connected') onStatus(`Voice connected with ${p.name} — hold T to talk`);
      if (pc.connectionState === 'failed') { try { pc.close(); } catch (e) {} p.pc = null; p.tx = null; }
    };
    pc.onnegotiationneeded = async () => {
      try { p.makingOffer = true; await pc.setLocalDescription(); send({ type: 'rtc', to: p.id, data: { sdp: pc.localDescription } }); }
      catch (e) { console.warn('[together] offer', e); }
      finally { p.makingOffer = false; }
    };
  }
  async function onSignal(from, data) {
    const p = peers.get(from); if (!p) return;
    if (!p.pc) ensurePeer(p);
    const pc = p.pc; if (!pc) return;
    try {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !polite(from) && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') { await pc.setLocalDescription(); send({ type: 'rtc', to: p.id, data: { sdp: pc.localDescription } }); }
      } else if (data.ice) {
        try { await pc.addIceCandidate(data.ice); } catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('[together] signal', e); }
  }
  function attachRemote(p, remote) {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    // Chrome only pumps a remote WebRTC stream into Web Audio while some media element holds it — keep a muted one.
    if (!p.audioEl) { p.audioEl = document.createElement('audio'); p.audioEl.muted = true; p.audioEl.autoplay = true; p.audioEl.style.display = 'none'; document.body.appendChild(p.audioEl); }
    p.audioEl.srcObject = remote; p.audioEl.play().catch(() => {});
    if (p.pan) { try { p.pan.disconnect(); } catch (e) {} }
    const src = ctx.createMediaStreamSource(remote);
    const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 2.5; pan.maxDistance = 80; pan.rolloffFactor = 1.2;
    src.connect(pan); pan.connect(master); p.pan = pan; p.srcNode = src;
    place(p, p.group.position);
    console.info('[together] voice from', p.id, 'attached (spatial)');
  }
  function place(p, pos) { if (!p.pan || !ctx) return; const t = ctx.currentTime; if (p.pan.positionX) { p.pan.positionX.setTargetAtTime(pos.x, t, 0.05); p.pan.positionY.setTargetAtTime(pos.y, t, 0.05); p.pan.positionZ.setTargetAtTime(pos.z, t, 0.05); } else p.pan.setPosition(pos.x, pos.y, pos.z); }
  function tick(dt) {
    if (!ctx) return;
    const L = ctx.listener, t = ctx.currentTime;
    camera.getWorldPosition(_p); camera.getWorldDirection(_f); _u.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    if (L.positionX) { L.positionX.setTargetAtTime(_p.x, t, 0.04); L.positionY.setTargetAtTime(_p.y, t, 0.04); L.positionZ.setTargetAtTime(_p.z, t, 0.04);
      L.forwardX.setTargetAtTime(_f.x, t, 0.04); L.forwardY.setTargetAtTime(_f.y, t, 0.04); L.forwardZ.setTargetAtTime(_f.z, t, 0.04);
      L.upX.setTargetAtTime(_u.x, t, 0.04); L.upY.setTargetAtTime(_u.y, t, 0.04); L.upZ.setTargetAtTime(_u.z, t, 0.04); }
    else { L.setPosition(_p.x, _p.y, _p.z); L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z); }
  }
  async function setTalking(on) {
    if (!wanted) return;
    talking = !!on;
    if (on && !stream) { const ok = await ensureMic(); if (!ok) return; }
    if (stream) for (const t of stream.getAudioTracks()) t.enabled = talking;
  }
  function setWanted(v) {
    wanted = !!v;
    if (!wanted && stream) { for (const p of peers.values()) if (p.tx) p.tx.sender.replaceTrack(null).catch(() => {}); for (const t of stream.getTracks()) t.stop(); stream = null; micState = 'off'; }
  }
  function close() { setWanted(false); for (const p of peers.values()) { if (p.pc) { try { p.pc.close(); } catch (e) {} p.pc = null; p.tx = null; } } if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; } }
  return { ensurePeer, onSignal, place, tick, setTalking, setWanted, close, ensureMic,
    get talking() { return talking; }, get wanted() { return wanted; }, get micState() { return micState; },
    get connected() { let n = 0; for (const p of peers.values()) if (p.pc && p.pc.connectionState === 'connected') n++; return n; } };
}
