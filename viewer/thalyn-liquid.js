// ★ A17160 / A17150 (2026-11-15, Mike: "a frozen lake must be walkable ice" · "fix SHORE FOAM") — the liquids[] decisions, PURE (no three.js,
// so node tests them: node viewer/thalyn-liquid.test.mjs).
//
// ICE. The game exports a frozen body (Sugar & Snow's freeze, or Snow / Blizzard) as a solid sheet named Thalyn_Ice_Baked and writes the
// freeze on its liquids[] row as `ice` 0..1 (client A17130, GltfExportAdapter BuildLiquidMetadata). At IceSheets.FrozenSolid (0.55) the
// walk stands on it. The viewer's swim probe (thalyn-atmos.js makeWaterProbe) read every 'water' row as swimmable, so you sank through the
// ice and swam. Now a row at or past the solid point is NOT water for the swim, the mirror, the foam or the soundscape: the sheet is an
// ordinary ground mesh (its material is not Thalyn_Water_Baked, so upgradeLiquid leaves it alone) and the walk stands on it. A part-frozen
// body (< 0.55) is still water, as in the game.
//
// FOAM. ThalynWater.shader draws the shore band from the water's depth over the bed (:1415-1440): width _FoamWidth (1.5 m) widened by the
// wind, intensity _FoamIntensity (0.7), colour _FoamColor (0.9, 0.95, 1.0). Each body's own numbers now ride its liquids[] row (client
// A17150: foamWidth / foamIntensity / foamColor); an older file (foamWidth 0) takes the shader's defaults.

export const ICE_SOLID_AT = 0.55;   // = IceSheets.FrozenSolid (client GltfExportAdapter IceSolidAt)

/** A water row the walk stands on (frozen solid), never swims in. */
export function isFrozen(l) {
  return !!l && l.type === 'water' && (+l.ice || 0) >= ICE_SOLID_AT;
}

/** The rows that are still liquid (lava stays: it is never water anyway; frozen water goes). */
export function openLiquids(liquids) {
  return (liquids || []).filter(l => l && !isFrozen(l));
}

/** One line for the console: how many bodies the file froze. */
export function describeIce(liquids) {
  const all = (liquids || []).filter(l => l && l.type === 'water');
  const solid = all.filter(isFrozen).length;
  const part = all.filter(l => !isFrozen(l) && (+l.ice || 0) > 0.001).length;
  return solid || part
    ? `[thalyn] A17160 ice: ${solid} frozen body(ies) walkable (no swim, no mirror, no foam) · ${part} part-frozen still water`
    : null;
}

// The shader's own defaults (ThalynWater.shader Properties "Shore Foam").
export const FOAM_DEFAULTS = Object.freeze({ width: 1.5, intensity: 0.7, color: [0.9, 0.95, 1.0], noiseScale: 12.0 });
export const FOAM_MAX_BODIES = 8;   // the shader loops at most this many rectangles (the rest take the world value)

/** The foam numbers of one row: its own when the file carries them, else the shader defaults. */
export function foamOf(l) {
  const w = +(l && l.foamWidth) || 0;
  if (w <= 0) return { width: FOAM_DEFAULTS.width, intensity: FOAM_DEFAULTS.intensity, color: FOAM_DEFAULTS.color.slice(), own: false };
  const c = l.foamColor;
  return {
    width: w,
    intensity: Math.max(0, Math.min(1, +l.foamIntensity || 0)),
    color: Array.isArray(c) && c.length >= 3 ? [+c[0], +c[1], +c[2]] : FOAM_DEFAULTS.color.slice(),
    own: true,
  };
}

/** The bodies the shader sees: open water only, APP frame X negated (the same read as makeWaterProbe), smallest first so a lake inside the
 *  sea's rectangle wins its own pixels (the shader takes the FIRST rectangle that holds the pixel). Plus the world value for the rest. */
export function foamBodies(liquids) {
  const rows = [];
  for (const l of openLiquids(liquids)) {
    if (l.type !== 'water' || !Array.isArray(l.centerXZ) || !Array.isArray(l.sizeXZ)) continue;
    const f = foamOf(l);
    rows.push({ name: l.name || 'water', cx: -l.centerXZ[0], cz: l.centerXZ[1], hx: Math.max(0.5, l.sizeXZ[0] * 0.5), hz: Math.max(0.5, l.sizeXZ[1] * 0.5),
      area: l.sizeXZ[0] * l.sizeXZ[1], ...f });
  }
  rows.sort((a, b) => a.area - b.area);
  const world = rows.length ? rows[rows.length - 1] : { ...foamOf(null) };   // the largest body (often the sea) speaks for the overflow
  return { bodies: rows.slice(0, FOAM_MAX_BODIES), world: { width: world.width, intensity: world.intensity, color: world.color }, total: rows.length,
    own: rows.filter(r => r.own).length };
}

/** The game's wind levers on the band (ThalynWater.shader :1419-1421), from the file's atmosphere.windStrength / windSpeed (the game's own
 *  _WEATHER_ values, clamped 0..6 there too): a stronger wind = a wider, whiter band; a faster wind = foam that churns faster. */
export function foamWind(windStrength, windSpeed) {
  const w = Math.min(Math.max(+windStrength || 0, 0), 6), s = Math.min(Math.max(+windSpeed || 0, 0), 6);
  return { boost: 1 + w * 0.55, widthMul: 1 + w * 0.45, scroll: 1 + s * 0.7 };
}

/** JS mirror of the shader's band ENVELOPE (no noise, no pulse): the primary mask² + the secondary band, capped 0.45 — what the bench checks.
 *  depth = water level − bed height (m). Out of water (depth < 0) = 0. */
export function foamEnvelope(depth, width, intensity, wind = 0) {
  if (!(depth >= 0)) return 0;
  const { boost, widthMul } = foamWind(wind);
  const fw = width * widthMul;
  const m1 = 1 - Math.min(1, depth / fw);
  const p = m1 * m1 * intensity * boost;
  const m2 = (1 - Math.min(1, depth / (fw * 2.5))) * Math.min(1, depth / fw);
  const s = m2 * intensity * 0.3 * boost;
  return Math.min(Math.max(p, s), 0.45);
}
