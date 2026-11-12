// ★ A15440 (client 2, 2026-11-12) · glTF parity slice C, the viewer half = spec GLTF_WEB_PARITY_LOCKED_SPEC_OCT9 §D.1.
// The game now writes the walk's EVALUATED URP grade into extras.thalyn.grade (client GltfAtmosphereExtras.GradeBlock):
//   { present, postOn, tonemapper "ACES"|"Neutral"|"None", postExposure EV, contrast, saturation, hueShift, colorFilter [r,g,b] linear,
//     temperature, tint, bloomIntensity, bloomThreshold, bloomScatter, vignetteIntensity, vignetteSmoothness, source }
// This module turns that block into the numbers the viewer's grade pass + renderer take. PURE (no three.js), so node tests it.
// No block (an older export, or the client gate Thalyn_GltfGradeBlock = 0) → null → the viewer keeps its own per-tone table (TONE_GRADES).
// Mapping (URP units → the viewer's GradeShader in thalyn-atmos.js):
//   saturation s → uSat = 1 + s/100 (URP: lerp(luma, c, 1 + s/100))
//   contrast c   → uCon = 1 + c/100 (URP grades contrast in log space; the viewer's pivot at 0.18 linear is the spec's "4-line grade")
//   colorFilter × white balance → uTint (white balance is an APPROXIMATION: ±10 % red/blue per 100 temperature, −8 % green per 100 tint)
//   vignetteIntensity → uVig · postExposure → renderer exposure 2^EV · tonemapper → renderer tone mapping
//   bloomThreshold → the bloom pass threshold; bloom STRENGTH stays the viewer's (spec §D OUT: bloom intensity matching)
//   hueShift is not drawn (named in the notes). postOn false = the walk drew NO grade → identity grade, no bloom, no tone mapping.
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function gradeFromBlock(tx) {
  const g = tx && tx.grade;
  if (!g || g.present !== true) return null;
  const notes = [];
  if (g.postOn === false) {
    return { postOn: false, toneMapping: 'none', exposure: 1, threshold: null, ev: 0,
             grade: { tint: [1, 1, 1], sat: 1, con: 1, vig: 0, lift: 0, bloom: 0 }, notes: ['the walk camera rendered no post'] };
  }
  const sat = Math.max(0, 1 + num(g.saturation, 0) / 100);
  const con = Math.max(0, 1 + num(g.contrast, 0) / 100);
  const cf = Array.isArray(g.colorFilter) && g.colorFilter.length >= 3 ? g.colorFilter.slice(0, 3).map(x => Math.max(0, num(x, 1))) : [1, 1, 1];
  const T = clamp(num(g.temperature, 0) / 100, -1, 1), Ti = clamp(num(g.tint, 0) / 100, -1, 1);
  const wb = [1 + 0.10 * T, 1 - 0.08 * Ti, 1 - 0.10 * T];
  if (T !== 0 || Ti !== 0) notes.push('white balance approximated');
  const tint = [cf[0] * wb[0], cf[1] * wb[1], cf[2] * wb[2]];
  const vig = clamp(num(g.vignetteIntensity, 0), 0, 1);
  const ev = num(g.postExposure, 0);
  const exposure = clamp(Math.pow(2, ev), 0.3, 2.5);
  const tm = String(g.tonemapper || '').toLowerCase();
  const toneMapping = tm === 'aces' ? 'aces' : tm === 'neutral' ? 'neutral' : tm === 'none' ? 'none' : 'aces';
  if (!['aces', 'neutral', 'none'].includes(tm)) notes.push(`unknown tonemapper '${g.tonemapper}' - ACES`);
  const threshold = num(g.bloomThreshold, 0) > 0 ? g.bloomThreshold : null;
  if (Math.abs(num(g.hueShift, 0)) > 0.01) notes.push(`hue shift ${num(g.hueShift, 0).toFixed(1)} deg not drawn`);
  return { postOn: true, toneMapping, exposure, ev, threshold, grade: { tint, sat, con, vig, lift: 0 }, notes };
}

export function describeGrade(fg, why) {
  if (!fg) return `[grade] A15440 ${why || 'no grade in the file'} - the viewer's per-tone table`;
  const g = fg.grade;
  return `[grade] A15440 the walk's grade: tonemap ${fg.toneMapping} · exposure ${fg.exposure.toFixed(2)} (EV ${fg.ev.toFixed(2)}) · sat ${g.sat.toFixed(2)} · con ${g.con.toFixed(2)} · ` +
         `vig ${g.vig.toFixed(2)} · tint (${g.tint.map(x => x.toFixed(2)).join(',')}) · bloom threshold ${fg.threshold == null ? 'viewer' : fg.threshold.toFixed(2)}` +
         (fg.notes.length ? ' · ' + fg.notes.join(' · ') : '');
}
