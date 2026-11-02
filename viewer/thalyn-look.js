// thalyn-look.js — ★ THE LOOK ENGINE, slice 2 (2026-11-02): the world's LOOK in the browser.
//
// The game writes extras.thalyn.look (Thalyn Final, Styles/LookExport.cs) only when a world wears a look: ids only —
//   { version, sceneRecipeId, sceneVersion, renderRow, byZone: [{ zone, recipeId, version, surface, form, formChoice, render, source, exportFallback }] }
// The viewer applies the RENDER row by id from its own copy of the game's table (looks/LookPalettes.json = Final's
// Assets/Thalyn/Resources/LookPalettes.json, copied verbatim — re-copy it when the game's table changes).
//
// WHAT IS APPLIED HERE, AND WHY ONLY THAT (parity, measured against the game's export, never a second grading):
//   · the SURFACE and the FORMS travel in the meshes and materials themselves — nothing to do;
//   · sun / ambient / fog are exported from the LIVE render settings, which the game already graded by the look
//     (AtmosphereRenderer → LookPalette.LightColor / TintFog) — grading them again here would DOUBLE the look;
//   · WATER is exported as the tone pair (+ the player's water style), NOT the look's grade — the game grades it at stamp time
//     (WaterReflectionProbe: `if (style.IsNone) LookPalette.TintWater(...)`), so the viewer, which re-colours water from the block,
//     used to UNDO the look. This module applies the same grade under the same rule (no player water style set).
//   · grass: the game's TintGrassBase/Tip have no caller in-app, so the viewer leaves grass alone too.
// No look block (a natural world, or an older file) = nothing here runs = the viewer exactly as before.

const canon = s => (s ? String(s) : 'natural').replace(/[_ ]/g, '').toLowerCase();

/** extras.thalyn.look, or null (natural / older export). */
export function readLook(tx) {
  const lk = tx && tx.look;
  return lk && typeof lk === 'object' && typeof lk.version === 'number' ? lk : null;
}

let _palettes = null;
/** The game's LookPalettes.json as a Map canon(styleId) → row. One fetch, shared. */
export function palettes(url = 'looks/LookPalettes.json') {
  if (!_palettes) {
    _palettes = fetch(url).then(r => r.ok ? r.json() : null).then(j => {
      const m = new Map();
      for (const l of (j && j.looks) || []) if (l && l.styleId) m.set(canon(l.styleId), l);
      return m;
    }).catch(e => { console.warn('[look] palette table failed to load', e); return new Map(); });
  }
  return _palettes;
}

/** The row the game had live at export; null = identity (natural, no row, or a row this copy lacks). */
export function rowFor(look, table) {
  if (!look || !table) return null;
  const id = canon(look.renderRow);
  if (id === 'natural') return null;   // the game's natural row carries crown palettes only — identity everywhere else (LookPalette.Apply D6)
  return table.get(id) || null;
}

/** LookPalette.Grade, bit for bit: saturation about Rec.709 luma first, then the RGB multiplier, floored at 0. Same space as the input. */
export function grade(rgb, mul, sat) {
  if (!Array.isArray(rgb) || rgb.length < 3) return rgb;
  const hasMul = Array.isArray(mul) && mul.length >= 3, hasSat = typeof sat === 'number' && Math.abs(sat - 1) > 1e-5;
  if (!hasMul && !hasSat) return rgb;
  let [r, g, b] = rgb;
  if (hasSat) { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
  if (hasMul) { r *= mul[0]; g *= mul[1]; b *= mul[2]; }
  const out = [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
  for (let i = 3; i < rgb.length; i++) out.push(rgb[i]);
  return out;
}

/** WaterStyle.IsNone: hue < 0, no effect, no rainbow — the game grades water by the look only then. */
export function waterStyleIsNone(water) {
  const st = water && water.style;
  if (!st) return true;
  const hue = typeof st.hue === 'number' ? st.hue : -1;
  return hue < 0 && (!st.effect || st.effect === 'none') && !st.rainbow;
}

/** The water block the game's stamp would have used under this look: a NEW object with graded deep/shallow, or the input itself
 *  when nothing applies (no row, no water row, or a player water style wins). */
export function lookWater(water, row) {
  const w = row && row.water;
  if (!water || !w || !waterStyleIsNone(water)) return water;
  return Object.assign({}, water, { deep: grade(water.deep, w.deepMul, w.sat), shallow: grade(water.shallow, w.shallowMul, w.sat) });
}

/** One console line per load: what the file says it wears and what the viewer did with it. */
export function describe(look, row, applied) {
  const zones = (look.byZone || []).filter(z => z && (z.surface || z.form));
  const zs = zones.map(z => `${z.zone}:${z.recipeId || z.surface}${z.form && z.form !== z.surface ? `+${z.form} shapes` : ''}`).join(' ');
  return `[look] scene '${look.sceneRecipeId || 'natural'}' · render row '${look.renderRow || 'identity'}'` +
    `${row ? '' : look.renderRow ? ' (not in this viewer\'s table - identity)' : ''} · biomes ${zs || 'natural'} · applied: ${applied.join(', ') || 'nothing'}`;
}
