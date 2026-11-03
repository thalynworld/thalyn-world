// thalyn-zoneatmo.js — ★ PER-BIOME SKY + FOG in the browser (2026-11-03, LOOK ENGINE; parity with Thalyn Final's ZoneAtmosphereController +
// LookPalette's atmosphere pair). The game exports extras.thalyn.zones: a coarse zone map (256², run-length encoded, UNITY frame like the grass
// block: glTF x = −unity x) + each zone's sky / fog / light as RATIOS to what the block's own sky + fog captured (the biome the camera stood in at
// export). Ratios compose with the viewer's own hour / night; at the export camera's spot every ratio is 1.
// The camera's zone (with the app's 3 m border hysteresis) cross-fades the ratios over the app's fade (2.5 s). A file without the block = null =
// the viewer exactly as before. GAP vs the app: the sky-tint ratio is carried but unused (the viewer's sky is its own dome / procedural sky; the
// fog colour carries the horizon).

const ONE = { fog: [1, 1, 1], fogDensity: 1, sun: [1, 1, 1], sunI: 1, amb: 1 };

function decodeRle(b64, n) {
  const bin = atob(b64), out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i + 1 < bin.length && o < n; i += 2) {
    const v = bin.charCodeAt(i), run = bin.charCodeAt(i + 1);
    out.fill(v, o, Math.min(n, o + run)); o += run;
  }
  return o >= n ? out : null;   // a short map = a broken block: ignore it
}

const arr3 = (a) => (Array.isArray(a) && a.length >= 3 ? [+a[0] || 1, +a[1] || 1, +a[2] || 1] : [1, 1, 1]);
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 1);

/** extras.thalyn.zones → a zone atmosphere, or null (absent / not present / unreadable). */
export function makeZoneAtmo(tx) {
  const z = tx && tx.zones;
  if (!z || !z.present || !z.rle || !(z.res > 0) || !Array.isArray(z.worldMin) || !(z.worldSize > 0)) return null;
  const res = z.res | 0, map = decodeRle(z.rle, res * res);
  if (!map) { console.warn('[zoneatmo] zone map unreadable - one sky'); return null; }
  const byZone = new Map();
  for (const e of z.zoneAtmos || []) {
    if (!e || typeof e.zone !== 'number') continue;
    byZone.set(e.zone, { row: e.row || 'natural', fog: arr3(e.fogColorMul), fogDensity: num(e.fogDensityMul), sun: arr3(e.sunColorMul), sunI: num(e.sunIntensityMul), amb: num(e.ambientMul) });
  }
  const minX = +z.worldMin[0], minZ = +z.worldMin[1], size = +z.worldSize, cell = size / res;
  const hyst = num(z.hysteresisM) || 3, fade = num(z.fadeSeconds) || 2.5;

  // zone at a glTF position (UNITY frame map: unity x = −glTF x); −1 outside / no zone
  function zoneAt(gx, gz) {
    const ux = -gx, uz = gz;
    const xi = Math.floor((ux - minX) / cell), zi = Math.floor((uz - minZ) / cell);
    if (xi < 0 || zi < 0 || xi >= res || zi >= res) return -1;
    return map[zi * res + xi] - 1;
  }
  const settledIn = (zone, x, zz) => zoneAt(x + hyst, zz) === zone && zoneAt(x - hyst, zz) === zone && zoneAt(x, zz + hyst) === zone && zoneAt(x, zz - hyst) === zone;

  let cur = -2, from = ONE, to = ONE, t = 1, said = '';
  const lerp = (a, b, k) => a + (b - a) * k;
  function blended() {
    const k = t * t * (3 - 2 * t);
    return {
      fog: [0, 1, 2].map(i => lerp(from.fog[i], to.fog[i], k)), fogDensity: lerp(from.fogDensity, to.fogDensity, k),
      sun: [0, 1, 2].map(i => lerp(from.sun[i], to.sun[i], k)), sunI: lerp(from.sunI, to.sunI, k), amb: lerp(from.amb, to.amb, k),
    };
  }
  let last = ONE;

  /** Per frame. Returns true when the multipliers moved (the caller re-applies its atmosphere state). */
  function update(dt, camPos) {
    let moved = false;
    const zone = zoneAt(camPos.x, camPos.z);
    if (zone !== cur && (cur < 0 || zone < 0 || settledIn(zone, camPos.x, camPos.z))) {
      const first = cur === -2;
      const target = byZone.get(zone) || ONE;
      from = first ? target : (t < 0.5 ? from : to); to = target; t = first ? 1 : 0; cur = zone; moved = true;
      const line = `${zone}|${target.row || 'natural'}`;
      if (line !== said) { said = line; console.log(`[zoneatmo] camera in biome ${zone} → sky + fog '${target.row || 'natural'}'${first ? ' (snap)' : ` over ${fade} s`}`); }
    }
    if (t < 1) { t = Math.min(1, t + dt / fade); moved = true; }
    if (moved) last = blended();
    return moved;
  }

  console.log(`[zoneatmo] per-biome sky + fog: ${byZone.size} zone(s), map ${res}² over ${size.toFixed(0)} m, base biome ${z.baseZone} '${z.baseRow}' (hysteresis ${hyst} m, fade ${fade} s)`);
  return { update, get mul() { return last; }, zoneAt };
}
