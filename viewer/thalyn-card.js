// Thalyn® World Viewer — a card (A13680–A13685).
//
// A card link is the viewer's ordinary ?model= link plus a #fragment: #card=1&to=…&from=…&msg=…&head=<phrase id>.
// Browsers never send a fragment to any server, so the words of a card live only in the link (and, for a card
// saved as a file, in card.txt beside the world). The world file carries extras.thalyn.card — the colour, the
// carol, and the hero spot where the name stands — but never the words and never a letter mesh: the raised
// letters and the holly over them are built here.
//
// The order a card opens in: a cover ("For Sarah", one Open button — the one tap starts the carol and, on an
// iPhone, asks for motion so the globe can be shaken) → the snow globe (thalyn-globe.js) → "Step inside" flies
// through the glass into the ordinary walk → when they leave the walk (or after about three minutes) one quiet
// line: made in Thalyn, make one back, and a small "Report this card".
//
// The words are untrusted: they are cleaned, cut to length (to/from ≤ 24, message ≤ 80), and only ever set as
// text (textContent, canvas text, glyph outlines) — never as HTML.
import * as THREE from 'three';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import * as TGL from './thalyn-globe.js?v=20261108c6';

// ── The wire (agreed client ⟷ server 2026-11-08) ─────────────────────────────
export const HEADLINES = {
  merry_christmas: 'Merry Christmas', happy_christmas: 'Happy Christmas', seasons_greetings: "Season's Greetings",
  with_love: 'With love', warm_wishes: 'Warm wishes',
  // full-game occasions (the app's CardCatalogue.Headlines)
  happy_birthday: 'Happy Birthday', welcome_home: 'Welcome Home', thank_you: 'Thank You', be_mine: 'Be Mine', happy_halloween: 'Happy Halloween',
};
export const OCCASIONS = { christmas: 'merry_christmas', birthday: 'happy_birthday', new_home: 'welcome_home', thank_you: 'thank_you', valentine: 'be_mine', halloween: 'happy_halloween' };
// What grows over the NAME (the greeting line always wears frost only). frost / bare grow nothing; bare has no snow caps either.
export const VINES = {
  holly:     { leaf: 0x1b4423, rough: 0.30, berry: 0x9c1420, berryP: 0.55, caps: true },
  ivy:       { leaf: 0x2c5527, rough: 0.50, berry: 0,        berryP: 0,    caps: true },
  mistletoe: { leaf: 0x6e8a48, rough: 0.55, berry: 0xe9e7dc, berryP: 0.7,  caps: true },
  frost:     { leaf: null, caps: true },
  bare:      { leaf: null, caps: false },
};
export const COLOURS = {   // non-emissive PBR, the same three the app offers
  berry_red:  { hex: 0x8E1B24, roughness: 0.45, metalness: 0 },
  pine_green: { hex: 0x1F4D2E, roughness: 0.55, metalness: 0 },
  gold_leaf:  { hex: 0xC9A04A, roughness: 0.30, metalness: 1 },
};
export const CAROLS = { silent_night: 'Silent Night', holly_and_ivy: 'The Holly and the Ivy', deck_the_halls: 'Deck the Halls' };
export const LIMITS = { to: 24, from: 24, msg: 80 };
export const CARD = {
  endAfterS: 180,          // the end line shows when they leave the walk, or after this long walking
  carolVolume: 0.7, carolWalkVolume: 0.45,
  flyS: 1.4,               // "Step inside": the flight through the glass
  reportUrl: 'https://api.thalyn.world/api/cards/report',
  demoMeltsOn: '2027-01-12', demoMeltsLabel: '12 January 2027',
  reasons: [['harassment', 'Harassment or bullying'], ['hate', 'Hate'], ['sexual', 'Sexual content'], ['violence', 'Violence or threats'],
            ['privacy', 'Private information'], ['spam', 'Spam or a scam'], ['copyright', 'Copyright'], ['illegal', 'Something illegal'], ['other', 'Something else']],
};

// Strip control / bidi / zero-width characters, fold whitespace, cut to n characters (code points, not UTF-16 units).
export function cleanText(s, n) {
  s = String(s == null ? '' : s).normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, n).join('').trim();
}
/** Read card words from a fragment, a whole link, or a card.txt — null when there is no card=1. */
export function parseCardText(text) {
  if (!text) return null;
  // card.txt carries the fragment on its own line (the 2nd); a pasted link or a bare fragment works too.
  let s = String(text).split(/\r?\n/).map(l => l.trim()).find(l => /(^|[#&?])card=1(&|$)/.test(l)) || '';
  const hash = s.indexOf('#'); if (hash >= 0) s = s.slice(hash + 1);
  const i = s.search(/(^|&)card=1(&|$)/); if (i < 0) return null;
  let q; try { q = new URLSearchParams(s); } catch (e) { return null; }
  if (q.get('card') !== '1') return null;
  const head = q.get('head');
  return { to: cleanText(q.get('to'), LIMITS.to), from: cleanText(q.get('from'), LIMITS.from), msg: cleanText(q.get('msg'), LIMITS.msg),
           head: HEADLINES[head] ? head : null };
}
// The card block in the world file — only the fields the wire names, each checked.
export function readBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const sp = b.spot && typeof b.spot === 'object' ? b.spot : null;
  const num = v => (Number.isFinite(+v) ? +v : null);
  const spot = sp && [sp.x, sp.y, sp.z].every(v => num(v) !== null)
    ? { x: +sp.x, y: +sp.y, z: +sp.z, yaw: num(sp.yaw) || 0, width: Math.max(1, Math.min(60, num(sp.width) || 8)), height: Math.max(0.4, Math.min(2.4 / 0.7, num(sp.height) || 2.4)) } : null;
  return {
    v: +b.v || 1, occasion: String(b.occasion || 'christmas'), template: String(b.template || ''),
    colour: COLOURS[b.colour] ? b.colour : 'berry_red', vine: VINES[b.vine] ? b.vine : 'holly', plinth: ['wood', 'stone', 'brass'].includes(b.plinth) ? b.plinth : 'wood',
    carol: CAROLS[b.carol] ? b.carol : null, date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : '',
    headline: HEADLINES[b.headline] ? b.headline : null, spot,
  };
}

// ── Letters (Cinzel outlines → extruded, frosted on top, a chosen colour, never emissive) ──
let fontP = null;
export function loadFont(url) {
  if (!fontP) fontP = new Promise((res, rej) => new TTFLoader().load(url, json => { try { res(new Font(json)); } catch (e) { rej(e); } }, undefined, rej));
  return fontP;
}
function cuttable(font, s) {   // only what the font can cut; anything else is dropped, never drawn as '?'
  const g = font.data.glyphs;
  return Array.from(s).filter(ch => ch === ' ' || g[ch]).join('').trim();
}
function textGeo(font, str, size) {
  const depth = size * 0.16;
  const g = new TextGeometry(str, { font, size, height: depth, depth, curveSegments: 5,
    bevelEnabled: true, bevelThickness: size * 0.025, bevelSize: size * 0.018, bevelSegments: 1 });
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -depth / 2);
  g.computeBoundingBox();
  return g;
}
// Frost: the faces that look up whiten (snow lying on the letters). A vertex colour, so the material stays one.
function frost(g, base, amount = 0.8) {
  if (g.index) g = g.toNonIndexed();
  g.computeVertexNormals();
  const n = g.attributes.normal, c = new Float32Array(n.count * 3), col = new THREE.Color(base), white = new THREE.Color(0xf3f6f8), t = new THREE.Color();
  for (let i = 0; i < n.count; i++) {
    const up = THREE.MathUtils.smoothstep(n.getY(i), 0.45, 0.9) * amount;
    t.copy(col).lerp(white, up);
    c[i * 3] = t.r; c[i * 3 + 1] = t.g; c[i * 3 + 2] = t.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function letterMaterial(colourId) {
  const p = COLOURS[colourId] || COLOURS.berry_red;
  // The colour lives in the vertex colours (with the frost); the material itself is white, lit, not emissive.
  return new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: p.roughness, metalness: p.metalness });
}
// Bend a straight line of letters onto a cylinder of radius r (the plinth's front band): x → angle.
function bendOntoCylinder(g, r) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), a = x / r, rr = r + z;
    p.setXYZ(i, Math.sin(a) * rr, p.getY(i), Math.cos(a) * rr);
  }
  p.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// ── Holly: glossy dark leaves + red berries, instanced, scattered over the letters' up-facing faces ──
let leafGeo = null, berryGeo = null;
function hollyLeaf() {
  if (leafGeo) return leafGeo;
  const s = new THREE.Shape(), side = [[0.1, 0.12], [0.2, 0.25], [0.3, 0.14], [0.45, 0.27], [0.57, 0.14], [0.72, 0.23], [0.85, 0.1], [1, 0]];
  s.moveTo(0, 0);
  for (const [x, y] of side) s.lineTo(x, y);
  for (let i = side.length - 2; i >= 0; i--) s.lineTo(side[i][0], -side[i][1]);
  s.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(s, 2);
  g.rotateX(-Math.PI / 2);                                  // flat in XZ, the stem at the origin, pointing +X
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, Math.abs(p.getZ(i)) * 0.45 + Math.sin(p.getX(i) * Math.PI) * 0.04);   // a crease + a curl
  g.computeVertexNormals();
  return (leafGeo = g);
}
function grownHolly(meshes, leafSize, seedN = 1, vine = VINES.holly) {
  if (!vine || vine.leaf === null) return null;
  // Area-weighted samples on the faces that look up (world space).
  const tris = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let total = 0;
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const p = m.geometry.attributes.position;
    for (let i = 0; i + 2 < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(p, i + 1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(p, i + 2).applyMatrix4(m.matrixWorld);
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const area = n.length() * 0.5; if (area < 1e-6) continue;
      n.normalize(); if (n.y < 0.55) continue;
      total += area; tris.push({ a: a.clone(), b: b.clone(), c: c.clone(), n: n.clone(), acc: total });
    }
  }
  if (!tris.length) return null;
  let rnd = seedN * 9301 + 49297; const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  const spots = Math.max(12, Math.min(180, Math.round(total / (leafSize * leafSize) * 0.7)));
  const leaves = new THREE.InstancedMesh(hollyLeaf(), new THREE.MeshStandardMaterial({ color: vine.leaf, roughness: vine.rough, metalness: 0, side: THREE.DoubleSide }), spots * 3);
  if (!berryGeo) berryGeo = new THREE.SphereGeometry(1, 10, 8);
  const berries = new THREE.InstancedMesh(berryGeo, new THREE.MeshStandardMaterial({ color: vine.berry || 0x9c1420, roughness: 0.28, metalness: 0 }), spots * 3);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), pos = new THREE.Vector3(), e = new THREE.Euler();
  let nl = 0, nb = 0;
  for (let s = 0; s < spots; s++) {
    const pick = rand() * total; let lo = 0, hi = tris.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tris[mid].acc < pick) lo = mid + 1; else hi = mid; }
    const t = tris[lo]; let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    pos.copy(t.a).addScaledVector(ab.subVectors(t.b, t.a), u).addScaledVector(ac.subVectors(t.c, t.a), v).addScaledVector(t.n, leafSize * 0.04);
    q.setFromUnitVectors(up, t.n);
    const fan = 2 + (rand() < 0.5 ? 1 : 0), base = rand() * Math.PI * 2;
    for (let k = 0; k < fan; k++) {
      e.set((rand() - 0.5) * 0.5, base + (k / fan) * Math.PI * 2 + (rand() - 0.5) * 0.6, -0.15 - rand() * 0.25, 'YXZ');
      qy.setFromEuler(e).premultiply(q);
      const s0 = leafSize * (0.8 + rand() * 0.45);
      M.compose(pos, qy, sc.set(s0, s0, s0)); leaves.setMatrixAt(nl++, M);
    }
    if (rand() < vine.berryP) for (let k = 0; k < 3; k++) {
      const br = leafSize * (0.085 + rand() * 0.03), ang = rand() * Math.PI * 2;
      const bp = pos.clone().add(new THREE.Vector3(Math.cos(ang) * leafSize * 0.12, leafSize * 0.08 + br, Math.sin(ang) * leafSize * 0.12).applyQuaternion(q));
      M.compose(bp, q, sc.set(br, br, br)); berries.setMatrixAt(nb++, M);
    }
  }
  leaves.count = nl; berries.count = nb;
  leaves.instanceMatrix.needsUpdate = true; berries.instanceMatrix.needsUpdate = true;
  for (const m of [leaves, berries]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
  const g = new THREE.Group(); g.name = 'Card_Holly'; g.add(leaves, berries);
  g.userData.counts = { leaves: nl, berries: nb };
  return g;
}

/** The raised name (and the greeting above it) at the hero spot, frosted, holly over the top. */
export function buildSpotLetters(font, { name, head, colour, spot, vine = 'holly' }) {
  const V = VINES[vine] || VINES.holly;
  const group = new THREE.Group(); group.name = 'Thalyn_CardLetters';
  const nameStr = cuttable(font, name || ''), headStr = cuttable(font, head || '');
  const mat = letterMaterial(colour), base = (COLOURS[colour] || COLOURS.berry_red).hex;
  const boxW = spot.width, boxH = Math.min(spot.height, 2.4 / 0.7);
  const meshes = [];
  let y = 0;
  const line = (str, hTarget, caps) => {
    if (!str) return null;
    const g0 = textGeo(font, str, 1), bb = g0.boundingBox, w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y;
    const k = Math.min(hTarget / Math.max(1e-3, h), boxW / Math.max(1e-3, w));
    g0.dispose();
    const g = frost(textGeo(font, str, k), base, caps ? 0.8 : 0);
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
    return { m, h: g.boundingBox.max.y - g.boundingBox.min.y };
  };
  const nm = line(nameStr, Math.min(2.4, boxH * 0.7), V.caps);
  const hd = line(headStr, boxH * 0.26, true);   // the greeting always wears frost only
  if (nm) { nm.m.position.y = 0; group.add(nm.m); meshes.push(nm.m); y = nm.h; }
  if (hd) { hd.m.position.y = y + boxH * 0.06; group.add(hd.m); meshes.push(hd.m); }
  group.position.set(spot.x, spot.y, spot.z);
  group.rotation.y = spot.yaw * Math.PI / 180;   // front = (sin yaw, 0, cos yaw) — the same convention as the cinema screen
  group.updateMatrixWorld(true);                 // the holly samples the letters in world space
  const holly = nm ? grownHolly([nm.m], Math.max(0.14, nm.h * 0.21), nameStr.length + 7, V) : null;   // the vine grows on the name
  return { group, holly, name: nameStr, head: headStr };
}

// ── DOM (built here so the viewer page stays as it was) ──
const CSS = `
@font-face { font-family: 'ThalynCinzel'; src: url('fonts/Cinzel.ttf') format('truetype'); font-weight: 400 900; font-display: swap; }
#card-cover { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center; padding: 16px;
  background: radial-gradient(ellipse at 50% 30%, rgba(40,28,20,0.86), rgba(9,12,11,0.96)); }
#card-cover.show { display: flex; }
#card-cover .cc { width: min(380px, 100%); text-align: center; padding: 22px 20px 18px; border-radius: 16px; background: rgba(18,22,19,0.88);
  border: 1px solid rgba(232,198,106,0.45); box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
#card-cover .cc-thumb { width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #1a211d; margin-bottom: 14px; display: none; }
#card-cover .cc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
#card-cover .cc-kicker { font: 13px/1.3 'ThalynCinzel', Georgia, serif; letter-spacing: 0.12em; color: #9DBCAC; text-transform: uppercase; }
#card-cover .cc-for { font: 600 30px/1.2 'ThalynCinzel', Georgia, serif; color: #E8C66A; margin: 8px 0 2px; overflow-wrap: anywhere; }
#card-cover .cc-from { font: 15px/1.4 Georgia, serif; color: #cfe0d7; min-height: 21px; overflow-wrap: anywhere; }
#card-cover button.cc-open { margin-top: 16px; width: 100%; padding: 13px; border-radius: 12px; cursor: pointer; font: 600 17px 'ThalynCinzel', Georgia, serif;
  letter-spacing: 0.04em; background: rgba(232,198,106,0.22); color: #E8C66A; border: 1px solid rgba(232,198,106,0.65); }
#card-cover button.cc-open:hover { background: rgba(232,198,106,0.32); }
#card-cover button:focus-visible, .card-ui button:focus-visible, .card-ui a:focus-visible { outline: 2px solid #E8C66A; outline-offset: 2px; }
#card-cover .cc-melt { display: flex; justify-content: center; margin-bottom: 8px; opacity: 0.85; }
#card-cover .cc-make { display: inline-block; margin-top: 12px; color: #E8C66A; font-size: 14px; }
#card-cover .cc-status { margin-top: 10px; font-size: 13px; color: #9DBCAC; min-height: 18px; }
#card-cover .cc-paste { margin-top: 10px; font-size: 12px; color: #9DBCAC; text-align: left; }
#card-cover .cc-paste textarea { width: 100%; margin-top: 6px; height: 54px; border-radius: 8px; border: 1px solid rgba(232,198,106,0.3); background: rgba(255,255,255,0.05); color: #e8efe9; font: 12px ui-monospace, Consolas, monospace; }
#card-cover .cc-paste button { margin-top: 6px; padding: 6px 12px; border-radius: 8px; cursor: pointer; background: rgba(232,198,106,0.14); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); }
.card-ui { position: fixed; z-index: 50; display: none; }
body.card-globe .card-ui.g, body.card-on .card-ui.a { display: flex; }
#card-tag { left: 50%; top: 16px; transform: translateX(-50%); flex-direction: column; align-items: center; text-align: center; pointer-events: none; max-width: calc(100vw - 120px); }
#card-tag .h { font: 600 24px/1.15 'ThalynCinzel', Georgia, serif; color: #E8C66A; text-shadow: 0 2px 14px rgba(0,0,0,0.75); overflow-wrap: anywhere; }
#card-tag .f { font: 14px/1.4 Georgia, serif; color: #e8efe9; text-shadow: 0 1px 8px rgba(0,0,0,0.85); margin-top: 3px; overflow-wrap: anywhere; }
#card-bar { left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%); gap: 10px; flex-wrap: wrap; justify-content: center; width: min(560px, calc(100vw - 32px)); }
#card-bar button { padding: 11px 18px; border-radius: 12px; cursor: pointer; font: 600 15px 'ThalynCinzel', Georgia, serif; background: rgba(13,20,17,0.82);
  color: #E8C66A; border: 1px solid rgba(232,198,106,0.55); backdrop-filter: blur(8px); }
#card-bar button.in { background: rgba(232,198,106,0.24); }
#card-bar .hint { width: 100%; text-align: center; font-size: 13px; color: #cfe0d7; text-shadow: 0 1px 8px rgba(0,0,0,0.9); }
#card-msg { left: 50%; bottom: calc(max(16px, env(safe-area-inset-bottom)) + 96px); transform: translateX(-50%); max-width: min(520px, calc(100vw - 32px)); text-align: center; pointer-events: none;
  font: 600 18px/1.35 'ThalynCinzel', Georgia, serif; color: #f4f1e8; text-shadow: 0 2px 16px rgba(0,0,0,0.9); opacity: 0; transition: opacity 0.9s; overflow-wrap: anywhere; }
#card-msg.on { opacity: 1; }
body.card-globe #card-msg { display: block; }
#card-mute { right: 14px; top: 14px; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 12px; cursor: pointer;
  background: rgba(13,20,17,0.82); color: #E8C66A; border: 1px solid rgba(232,198,106,0.4); backdrop-filter: blur(8px); padding: 0; }
#card-mute svg { width: 22px; height: 22px; }
#card-mute .off { display: none; } #card-mute.muted .on { display: none; } #card-mute.muted .off { display: block; }
body.card-walk #card-mute { top: 64px; }
#card-end { left: 50%; bottom: max(14px, env(safe-area-inset-bottom)); transform: translateX(-50%); align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center;
  padding: 8px 14px; border-radius: 12px; background: rgba(13,20,17,0.82); border: 1px solid rgba(232,198,106,0.35); backdrop-filter: blur(8px);
  font-size: 13px; color: #cfe0d7; width: max-content; max-width: calc(100vw - 32px); text-align: center; }
#card-end.show { display: flex; }
#card-end a { color: #E8C66A; }
#card-end button { background: none; border: none; color: #9DBCAC; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 2px 4px; }
#card-end button.x { text-decoration: none; font-size: 16px; color: #9DBCAC; }
#card-report { left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 70; width: min(360px, calc(100vw - 32px)); flex-direction: column; gap: 8px;
  padding: 18px; border-radius: 14px; background: rgba(13,20,17,0.95); border: 1px solid rgba(232,198,106,0.45); font-size: 13px; color: #cfe0d7; }
#card-report.show { display: flex; }
#card-report h2 { margin: 0; font: 600 16px Georgia, serif; color: #E8C66A; }
#card-report select, #card-report textarea { width: 100%; border-radius: 8px; border: 1px solid rgba(232,198,106,0.3); background: rgba(255,255,255,0.05); color: #e8efe9; padding: 6px 8px; font-size: 13px; }
#card-report textarea { height: 70px; resize: vertical; }
#card-report .row { display: flex; gap: 8px; } #card-report .row button { flex: 1; }
#card-report button { padding: 8px; border-radius: 8px; cursor: pointer; background: rgba(232,198,106,0.16); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); }
#card-report .st { min-height: 18px; color: #E8C66A; }
body.card-cover-on #hud, body.card-cover-on #b-hud, body.card-cover-on #b-walk-m, body.card-cover-on #cta, body.card-cover-on #b-fs, body.card-cover-on #title, body.card-cover-on #VRButton,
body.card-globe #hud, body.card-globe #b-hud, body.card-globe #b-walk-m, body.card-globe #cta, body.card-globe #title { display: none !important; }
body.card-on #cta { display: none !important; }
body.card-on #empty { display: none !important; }
`;
const FLAKE = '<svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="#cfe0d7" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">'
  + '<g id="arm"><path d="M32 6v52M32 14l-6-6M32 14l6-6M32 50l-6 6M32 50l6 6"/></g><use href="#arm" transform="rotate(60 32 32)"/><use href="#arm" transform="rotate(120 32 32)"/></svg>';
const SPEAKER = '<svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12"/></svg>'
  + '<svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';

function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * The card's whole life in the viewer. deps:
 *  scene, camera, renderer, controls, walk, surfaceAt(x,z), worldRoot(), worldBox() → Box3 (no liquids / sky),
 *  toast(msg), modelURL() → the loaded model's address (no fragment), tierTable(), steamLink(src),
 *  setGlobeLook(on) (the viewer's sky / weather / fog for the globe), setWorldSound(on), worldSoundOn(),
 *  sunLight() → THREE.Color (light falling on the snow), enterDefault() (walk where the world says, no spot).
 */
export function makeCard(deps) {
  const { scene, camera, renderer, controls } = deps;
  let words = null, block = null, active = false, opened = false, ready = false, removed = false;
  let mode = 'none';            // none | cover | globe | flying | walk | done
  let font = null, letters = null, plinthText = null, walkS = 0, endShown = false, fly = null;
  const clip = TGL.makeClip();
  const globe = TGL.makeGlobe({ scene, camera, renderer, surfaceAt: deps.surfaceAt, onShake: () => { hintEl.textContent = words && words.msg ? 'Watch the snow…' : 'Shake it again whenever you like'; } });
  globe.setBudget((deps.tierTable() || {}).globeFlakes || 3000);

  // DOM
  el('style', { text: CSS }, document.head);
  const cover = el('div', { id: 'card-cover', role: 'dialog', 'aria-label': 'A card for you' }, document.body);
  const cc = el('div', { cls: 'cc' }, cover);
  const thumb = el('div', { cls: 'cc-thumb' }, cc), thumbImg = el('img', { alt: '' }, thumb);
  const kicker = el('div', { cls: 'cc-kicker', text: 'A card for you' }, cc);
  const forEl = el('div', { cls: 'cc-for' }, cc), fromEl = el('div', { cls: 'cc-from' }, cc);
  const openBtn = el('button', { cls: 'cc-open', type: 'button', text: 'Open your card' }, cc);
  const status = el('div', { cls: 'cc-status', role: 'status', 'aria-live': 'polite' }, cc);
  const paste = el('details', { cls: 'cc-paste' }, cc); paste.hidden = true;
  el('summary', { text: 'Have a card code? (card.txt)' }, paste);
  const pasteBox = el('textarea', { 'aria-label': 'Paste the card code', placeholder: '#card=1&to=…' }, paste);
  const pasteGo = el('button', { type: 'button', text: 'Use it' }, paste);

  const tag = el('div', { id: 'card-tag', cls: 'card-ui g', 'aria-hidden': 'false' }, document.body);
  const tagH = el('div', { cls: 'h' }, tag), tagF = el('div', { cls: 'f' }, tag);
  const msgEl = el('div', { id: 'card-msg', cls: 'card-ui g', role: 'status', 'aria-live': 'polite' }, document.body);
  const bar = el('div', { id: 'card-bar', cls: 'card-ui g' }, document.body);
  const hintEl = el('div', { cls: 'hint' }, bar);
  const shakeBtn = el('button', { type: 'button', text: 'Shake it' }, bar);
  const inBtn = el('button', { type: 'button', cls: 'in', text: 'Step inside' }, bar);
  const mute = el('button', { id: 'card-mute', cls: 'card-ui a', type: 'button', 'aria-label': 'Sound off', title: 'Sound on / off' }, document.body);
  mute.innerHTML = SPEAKER;   // static markup, no card text
  const end = el('div', { id: 'card-end', cls: 'card-ui', role: 'contentinfo' }, document.body);
  el('span', { text: 'Made in Thalyn' }, end); el('span', { text: '·', 'aria-hidden': 'true' }, end);
  const endLink = el('a', { target: '_blank', rel: 'noopener', text: 'make one back: free demo on Steam ↗' }, end);
  const repBtn = el('button', { type: 'button', text: 'Report this card' }, end);
  const endX = el('button', { type: 'button', cls: 'x', 'aria-label': 'Close', text: '×' }, end);
  const rep = el('div', { id: 'card-report', cls: 'card-ui', role: 'dialog', 'aria-label': 'Report this card' }, document.body);
  el('h2', { text: 'Report this card' }, rep);
  el('div', { text: 'Tell us what is wrong. A reported card is taken down straight away while we look.' }, rep);
  const repReason = el('select', { 'aria-label': 'What is wrong' }, rep);
  for (const [v, t] of CARD.reasons) el('option', { value: v, text: t }, repReason);
  const repNote = el('textarea', { maxlength: '1000', placeholder: 'Anything else we should know (optional)', 'aria-label': 'Details' }, rep);
  const repIncl = el('label', {}, rep); const repInclBox = el('input', { type: 'checkbox' }, repIncl);
  repIncl.appendChild(document.createTextNode(" Include the card's words (they live only in your link, so we can't read them otherwise)"));
  const repSt = el('div', { cls: 'st', role: 'status', 'aria-live': 'polite' }, rep);
  const repRow = el('div', { cls: 'row' }, rep);
  const repSend = el('button', { type: 'button', text: 'Send report' }, repRow), repClose = el('button', { type: 'button', text: 'Close' }, repRow);
  endLink.href = deps.steamLink('card');

  // ── Carol: a hosted static file by id (carols/<id>.ogg|.m4a); not there yet → silent, the toggle stays ──
  const carol = new Audio(); carol.loop = true; carol.preload = 'none'; carol.volume = CARD.carolVolume;
  let carolOk = false, muted = false;
  carol.addEventListener('playing', () => { if (!carolOk) { carolOk = true; console.info('[thalyn-card] carol playing: ' + (block && CAROLS[block.carol])); } });
  carol.addEventListener('error', () => { console.info('[thalyn-card] carol "' + (block && block.carol) + '" is not hosted yet — the card stays quiet (mute toggle kept)'); });
  function carolSrc(id) {
    const a = document.createElement('audio');
    const ext = (a.canPlayType('audio/ogg; codecs="opus"') || a.canPlayType('audio/ogg; codecs="vorbis"')) ? 'ogg' : 'm4a';
    return 'carols/' + id + '.' + ext;
  }
  function startCarol() {   // called inside the Open tap (the gesture a browser needs)
    if (!block || !block.carol || muted) return;
    try { if (!carol.src) carol.src = carolSrc(block.carol); const p = carol.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
  function setMuted(m) {
    muted = m; mute.classList.toggle('muted', m); mute.setAttribute('aria-label', m ? 'Sound on' : 'Sound off');
    if (m) carol.pause(); else if (opened) startCarol();
    deps.setWorldSound(!m);
  }
  mute.onclick = () => setMuted(!muted);

  // ── Words → the page ──
  const headline = () => HEADLINES[(words && words.head) || (block && block.headline) || (block && OCCASIONS[block.occasion]) || ''] || 'Merry Christmas';
  function paint() {
    const to = words && words.to, from = words && words.from;
    forEl.textContent = to ? 'For ' + to : 'For you';
    fromEl.textContent = from ? 'from ' + from : '';
    kicker.textContent = headline();
    tagH.textContent = to ? headline() + ', ' + to : headline();
    tagF.textContent = from ? 'from ' + from : '';
    paste.hidden = !!words;
    hintEl.textContent = words && words.msg ? 'Shake it' + (matchMedia('(pointer: coarse)').matches ? ' (shake your phone, or tap Shake it)' : ' (drag it back and forth fast, or press Shake it)') + ' — something is hiding in the snow' : 'Shake it to stir the snow';
    globe.setMessage(words && words.msg, "'ThalynCinzel', Georgia, serif", on => {
      msgEl.textContent = on && words ? words.msg : ''; msgEl.classList.toggle('on', !!on);
    });
  }
  function showThumb() {
    const m = /^(https:\/\/[^#?]+\/)World_web(?:_lite)?\.glb(\?.*)?$/i.exec(deps.modelURL() || new URLSearchParams(location.search).get('model') || '');
    if (!m) return;
    const tryOne = names => { if (!names.length) return; thumbImg.onerror = () => tryOne(names.slice(1)); thumbImg.onload = () => { thumb.style.display = 'block'; }; thumbImg.src = m[1] + names[0]; };
    tryOne(['postcard.jpg', 'postcard.png']);
  }

  // Demo cards live under cards-demo/ and melt on CARD.demoMeltsOn (the server deletes them that day).
  function modelParam() { return deps.modelURL() || new URLSearchParams(location.search).get('model') || ''; }
  function isDemoCard() { return /\/cards-demo\//i.test(modelParam()); }
  function melted(why) {
    openBtn.style.display = 'none'; paste.hidden = true;
    if (!cc.querySelector('.cc-melt')) {
      const m = el('div', { cls: 'cc-melt' }); m.innerHTML = FLAKE;   // static drawing, no card text
      cc.insertBefore(m, kicker);
    }
    kicker.textContent = 'This card has melted';
    status.textContent = 'Christmas cards made in the free demo stay until ' + CARD.demoMeltsLabel + '.';
    if (!cc.querySelector('.cc-make')) { const a = el('a', { cls: 'cc-make', target: '_blank', rel: 'noopener', text: 'Make one of your own: free demo on Steam ↗' }, cc); a.href = deps.steamLink('card_melted'); }
    cover.classList.add('show'); document.body.classList.add('card-cover-on');
    console.info('[thalyn-card] demo card melted (' + why + ')');
  }
  function activate() {
    if (active) { paint(); return; }
    active = true; mode = 'cover';
    document.body.classList.add('card-on', 'card-cover-on');
    renderer.localClippingEnabled = true;
    deps.setClean && deps.setClean(true);   // a friend opening a card gets the card, not the viewer's panels (H / the corner button brings them back)
    cover.classList.add('show'); paint(); showThumb();
    openBtn.focus({ preventScroll: true });
    if (isDemoCard() && new Date().toISOString().slice(0, 10) >= CARD.demoMeltsOn) { melted('past ' + CARD.demoMeltsOn); return; }
    loadFont('fonts/Cinzel.ttf').then(f => { font = f; buildLetters(); }).catch(e => console.warn('[thalyn-card] font failed (no raised letters)', e));
    console.info('[thalyn-card] card ' + JSON.stringify({ to: !!(words && words.to), from: !!(words && words.from), msg: words ? Array.from(words.msg).length : 0, head: (words && words.head) || (block && block.headline) || null, block: !!block }));
  }

  openBtn.onclick = () => {
    // One tap, three jobs: (1) iPhone motion permission — asked FIRST, while the gesture is fresh; (2) the carol; (3) the moment.
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
        DeviceMotionEvent.requestPermission().then(s => console.info('[thalyn-card] motion permission: ' + s)).catch(() => {});
    } catch (e) {}
    startCarol();
    deps.setWorldSound(!muted);
    opened = true;
    if (ready) enterGlobe(); else { openBtn.disabled = true; status.textContent = 'Unwrapping…'; }
  };
  pasteGo.onclick = () => { const w = parseCardText(pasteBox.value); if (w) { words = w; paint(); buildLetters(true); status.textContent = ''; } else status.textContent = "That doesn't look like a card code."; };

  // ── The globe ──
  const hidden = [];
  const HIDE = /^(Thalyn_Fauna|Thalyn_Waterfalls|Thalyn_Lanterns|Thalyn_Interiors|ThalynGrassField|Thalyn_Doors|Thalyn_Cinema|Thalyn_Wisps)$/;
  function hideExtras(on) {
    if (on) { for (const c of scene.children) if (HIDE.test(c.name) && c.visible) { c.visible = false; hidden.push(c); } }
    else { for (const c of hidden) c.visible = true; hidden.length = 0; }
  }
  let saved = null;
  function cropOf() {
    const box = deps.worldBox(); if (!box || box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    let R = Math.max(2, Math.min(s.x, s.z) * 0.5), cx = c.x, cz = c.z;
    const sp = block && block.spot;
    if (sp && Math.hypot(sp.x - cx, sp.z - cz) > R * 0.8) { cx = sp.x; cz = sp.z; }   // the hero spot is always inside the globe
    return { cx, cz, R, topY: box.max.y, baseY: box.min.y };
  }
  function enterGlobe() {
    if (mode === 'globe') return;
    const cr = cropOf();
    cover.classList.remove('show'); document.body.classList.remove('card-cover-on');
    if (!cr) { stepInside(true); return; }
    const sp = block && block.spot, front = sp ? new THREE.Vector3(Math.sin(sp.yaw * Math.PI / 180), 0, Math.cos(sp.yaw * Math.PI / 180)) : new THREE.Vector3(0, 0, 1);
    clip.set(cr.cx, cr.cz, cr.R);
    const g0 = deps.surfaceAt(cr.cx, cr.cz);
    const b = globe.build({ center: new THREE.Vector3(cr.cx, Math.max(cr.baseY, Math.min(g0 === null ? cr.baseY : g0, cr.topY)), cr.cz), R: cr.R, topY: cr.topY, front, plinth: block ? block.plinth : 'wood' });
    buildPlinthText();
    saved = { minD: controls.minDistance, maxD: controls.maxDistance, pan: controls.enablePan, maxPolar: controls.maxPolarAngle, auto: controls.autoRotate, autoS: controls.autoRotateSpeed, near: camera.near, far: camera.far };
    const tgt = new THREE.Vector3(b.cx, b.baseY + b.H * 0.25, b.cz);
    const fit = (b.Rg * 1.35) / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.min(1, Math.max(0.45, camera.aspect));
    controls.target.copy(tgt);
    camera.position.copy(tgt).addScaledVector(front, fit * Math.cos(0.24)).add(new THREE.Vector3(0, fit * Math.sin(0.24), 0));
    camera.near = Math.max(0.05, b.Rg / 800); camera.far = Math.max(camera.far, fit * 10); camera.updateProjectionMatrix();
    controls.minDistance = b.Rg * 1.3; controls.maxDistance = fit * 2.2; controls.enablePan = false; controls.maxPolarAngle = Math.PI * 0.5 + 0.12;
    controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches; controls.autoRotateSpeed = 0.35;
    controls.enabled = true; controls.update();
    deps.setGlobeLook(true); hideExtras(true);
    globe.setFade(1); globe.setActive(true);
    document.body.classList.add('card-globe');
    mode = 'globe';
    setTimeout(() => { if (mode === 'globe') globe.shake(1, true); }, 400);   // snow falls as it opens (a flurry: never the message)
    shakeBtn.focus({ preventScroll: true });
    console.info('[thalyn-card] globe open: crop R ' + cr.R.toFixed(1) + ' m · ' + globe.flakeCount + ' flakes' + (block && block.carol ? ' · carol ' + block.carol : ''));
  }
  shakeBtn.onclick = () => { globe.shake(1); console.info('[thalyn-globe] shake (button)'); hintEl.textContent = words && words.msg ? 'Watch the snow…' : ''; };
  inBtn.onclick = () => stepInside(false);

  function leaveGlobe() {
    if (mode !== 'globe' && mode !== 'flying') return;
    globe.setActive(false); globe.dispose(); disposePlinthText();
    clip.open();
    hideExtras(false); deps.setGlobeLook(false);
    if (saved) {
      controls.minDistance = saved.minD; controls.maxDistance = saved.maxD; controls.enablePan = saved.pan; controls.maxPolarAngle = saved.maxPolar;
      controls.autoRotate = saved.auto; controls.autoRotateSpeed = saved.autoS; camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix(); saved = null;
    }
    document.body.classList.remove('card-globe'); msgEl.classList.remove('on');
  }
  // "Step inside": fly through the glass to the walk start (in front of the name), then walk from there.
  function walkStart() {
    const sp = block && block.spot;
    if (!sp) {   // no hero spot: the world's own picture pose if it has one (null → enterDefault), else the globe's middle
      const b = globe.built; if (!b || deps.hasShot()) return null;
      const pos = new THREE.Vector3(b.cx, 0, b.cz).addScaledVector(b.front, Math.min(30, b.R * 0.3)), look = new THREE.Vector3(b.cx, 0, b.cz);
      const g = deps.surfaceAt(pos.x, pos.z), gl = deps.surfaceAt(look.x, look.z);
      pos.y = (g === null ? b.baseY : g) + 1.7; look.y = (gl === null ? b.baseY : gl) + 1.7;
      return { pos, look, centre: true };
    }
    const f = new THREE.Vector3(Math.sin(sp.yaw * Math.PI / 180), 0, Math.cos(sp.yaw * Math.PI / 180));
    // Far enough that the whole name fits the screen, a portrait phone included (its horizontal view is narrow).
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * Math.min(1, camera.aspect);
    const d = Math.max(8, 1.2 * sp.width, sp.width * 0.62 / Math.max(0.05, tanH));
    const pos = new THREE.Vector3(sp.x, sp.y, sp.z).addScaledVector(f, d);
    const g = deps.surfaceAt(pos.x, pos.z); pos.y = (g === null ? sp.y : g) + 1.7;
    return { pos, look: new THREE.Vector3(sp.x, sp.y + Math.min(2.4, sp.height * 0.7) * 0.5, sp.z) };
  }
  function stepInside(now) {
    const st = walkStart();
    if (now || !st || mode !== 'globe') { leaveGlobe(); beginWalk(st); return; }
    controls.enabled = false; controls.autoRotate = false;
    fly = { t0: performance.now(), t: 0, from: camera.position.clone(), fromLook: controls.target.clone(), to: st.pos, look: st.look, left: false, st };
    mode = 'flying';
    console.info('[thalyn-card] step inside → flying through the glass');
  }
  function beginWalk(st) {
    mode = 'walk'; walkS = 0;
    document.body.classList.add('card-walk');
    carol.volume = CARD.carolWalkVolume;
    pendingSt = st;
    if (st) { controls.target.copy(st.look); deps.walk.enterAt(st.pos, st.look); } else deps.enterDefault();
    console.info('[thalyn-card] walking in the card' + (st ? (st.centre ? ' (no hero spot: the middle of the globe)' : ' (in front of the name)') : ' (no hero spot: the world\'s own picture)'));
    // A browser may refuse pointer lock (the tap's activation went stale, or an embedded frame): never leave the camera stuck.
    setTimeout(() => {
      if (mode !== 'walk' || deps.walk.active || walkedOnce) return;
      controls.enabled = true; controls.update();
      deps.toast('Click the world to walk in your card (or press V)');
      console.info('[thalyn-card] walk not started (pointer lock refused): a click on the world starts it');
    }, 1200);
  }
  let pendingSt = null, walkedOnce = false;
  renderer.domElement.addEventListener('click', () => {
    if (mode !== 'walk' || deps.walk.active || walkedOnce) return;
    if (pendingSt) deps.walk.enterAt(pendingSt.pos, pendingSt.look); else deps.enterDefault();
  });
  function showEnd(why) {
    if (endShown) return; endShown = true;
    end.classList.add('show');
    repBtn.style.display = deps.modelURL() ? '' : 'none';   // a card opened from a file has no address to report
    console.info('[thalyn-card] end line shown (' + why + ')');
  }
  endX.onclick = () => end.classList.remove('show');

  // ── Report ──
  repBtn.onclick = () => { repSt.textContent = ''; repSend.disabled = false; rep.classList.add('show'); repReason.focus(); };
  repClose.onclick = () => rep.classList.remove('show');
  repSend.onclick = async () => {
    const url = deps.modelURL(); if (!url) { repSt.textContent = 'This card was opened from a file — there is nothing online to take down.'; return; }
    const body = { url: url.split('#')[0], reason: repReason.value };
    const note = cleanText(repNote.value, 1000); if (note) body.details = note;
    if (repInclBox.checked && words) {
      body.cardText = Array.from(['to: ' + words.to, 'from: ' + words.from, 'msg: ' + words.msg, 'head: ' + ((words.head) || (block && block.headline) || '')].join(' · ')).slice(0, 200).join('');
    }
    repSend.disabled = true; repSt.textContent = 'Sending…';
    try {
      const r = await fetch(CARD.reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' });
      if (r.ok) { repSt.textContent = 'Thank you. The card has been taken down while we look.'; console.info('[thalyn-card] report sent (' + r.status + ')'); }
      else if (r.status === 429) { repSt.textContent = 'Too many reports from here just now. Please try again later.'; repSend.disabled = false; }
      else { repSt.textContent = "We couldn't send that (" + r.status + '). Please try again.'; repSend.disabled = false; console.warn('[thalyn-card] report refused', r.status); }
    } catch (e) { repSt.textContent = "We couldn't reach Thalyn. Please try again."; repSend.disabled = false; console.warn('[thalyn-card] report failed', e); }
  };

  // ── Letters ──
  function buildLetters(force) {
    if (!font || !ready || !block || !block.spot) return;
    if (letters && !force) return;
    if (letters) { scene.remove(letters.group); if (letters.holly) scene.remove(letters.holly); }
    const name = (words && words.to) || '';
    letters = buildSpotLetters(font, { name, head: headline(), colour: block.colour, spot: block.spot, vine: block.vine });
    scene.add(letters.group); if (letters.holly) scene.add(letters.holly);
    const hc = letters.holly ? letters.holly.userData.counts : { leaves: 0, berries: 0 };
    console.info(`[thalyn-card] raised letters at the hero spot: "${letters.head}" / ${letters.name ? Array.from(letters.name).length + ' letter name' : '(no name)'} · ${block.colour} · ${block.vine} ${hc.leaves} leaves + ${hc.berries} berries · emissive none`);
    if (mode === 'globe') buildPlinthText();
  }
  function disposePlinthText() { if (plinthText) { plinthText.parent && plinthText.parent.remove(plinthText); plinthText = null; } }
  function buildPlinthText() {
    disposePlinthText();
    const b = globe.built; if (!font || !b) return;
    const band = b.plinth, bandH = band.yTop - band.yBottom, rb = band.radius;
    const grp = new THREE.Group(); grp.name = 'Globe_PlinthText';
    const colour = block ? block.colour : 'gold_leaf', base = (COLOURS[colour] || COLOURS.gold_leaf).hex, mat = letterMaterial(colour);
    const maxW = rb * 1.6;   // at most ~92° of the plinth
    const rows = [[cuttable(font, (words && words.to) || ''), 0.40, 0.42], [cuttable(font, block && block.date ? block.date.split('-').reverse().join(' · ') : ''), 0.13, 0.16]];
    for (const [str, hFrac, yFrac] of rows) {
      if (!str) continue;
      const g0 = textGeo(font, str, 1), w = g0.boundingBox.max.x - g0.boundingBox.min.x, h = g0.boundingBox.max.y - g0.boundingBox.min.y; g0.dispose();
      const k = Math.min(bandH * hFrac / Math.max(1e-3, h), maxW / Math.max(1e-3, w));
      const g = bendOntoCylinder(frost(textGeo(font, str, k), base, 0.35), rb + k * 0.05);
      const m = new THREE.Mesh(g, mat); m.castShadow = true;
      m.position.y = band.yBottom + bandH * yFrac;
      grp.add(m);
    }
    grp.position.set(b.cx, 0, b.cz); grp.rotation.y = b.frontYaw;
    globe.group.add(grp); plinthText = grp;
  }

  // ── The frame ──
  const _ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function tick(dt) {
    if (!active) return;
    if (mode === 'globe' || mode === 'flying') {
      if (scene.fog) scene.fog = null;
      globe.tick(dt, deps.sunLight());
    }
    if (mode === 'flying' && fly) {
      fly.t = (performance.now() - fly.t0) / (CARD.flyS * 1000);   // wall clock: the click's activation must still be fresh for pointer lock
      const k = _ease(Math.min(1, fly.t));
      camera.position.lerpVectors(fly.from, fly.to, k);
      const look = fly.fromLook.clone().lerp(fly.look, k);
      camera.lookAt(look);
      globe.setFade(1 - Math.min(1, fly.t * 1.6));
      if (!fly.left && fly.t > 0.55) { fly.left = true; leaveGlobe(); mode = 'flying'; }
      if (fly.t >= 1) { const st = fly.st; fly = null; beginWalk(st); }
    } else if (mode === 'walk') {
      if (deps.walk.active) { walkS += dt; if (walkS > CARD.endAfterS) showEnd('three minutes walking'); }
    }
  }
  function onWalk(on, why) {
    if (!active || mode !== 'walk') return;
    if (on) walkedOnce = true;
    if (!on && why !== 'refused') showEnd('left the walk');
    if (!on && why === 'refused') deps.toast('Click the world (or press V) to walk in the card');
  }

  return {
    /** The words from the fragment / a card.txt / a paste. */
    setWords(w) { if (!w) return false; words = w; activate(); buildLetters(true); return true; },
    /** extras.thalyn.card from the world file. */
    setBlock(b) { const r = readBlock(b); if (!r) return; block = r; console.info('[thalyn-card] extras.thalyn.card ' + JSON.stringify({ template: r.template, colour: r.colour, carol: r.carol, spot: !!r.spot, date: r.date })); activate(); },
    /** Before the world's shaders compile: the crop planes go on every world material (one compile, not two). */
    prepareWorld(root) { if (!active) return; const n = clip.adopt(root); console.info('[thalyn-card] crop planes on ' + n + ' world material(s)'); },
    /** After the world is framed. */
    worldReady() {
      if (!active) return;
      ready = true; buildLetters();
      if (opened) enterGlobe(); else status.textContent = '';
    },
    loadFailed(removedNow) {
      if (!active) return;
      removed = !!removedNow;
      // A removed marker = taken down. A demo card that is gone (or past its date) has MELTED (server ruling 11-08).
      if (!removed && isDemoCard()) { melted('the link is gone'); return; }
      openBtn.style.display = 'none';
      status.textContent = removed ? 'This card was taken down.' : "This card can't be opened. The link may have expired.";
      cover.classList.add('show'); document.body.classList.add('card-cover-on');
    },
    leaveGlobeNow() { if (mode === 'globe' || mode === 'flying') { fly = null; leaveGlobe(); mode = 'walk'; } },
    setBudget(t) { globe.setBudget((t && t.globeFlakes) || 3000); },
    tick, onWalk, globe,
    get active() { return active; }, get mode() { return mode; },
    get quiet() { return active && (mode === 'cover' || mode === 'globe' || mode === 'flying'); },
  };
}
