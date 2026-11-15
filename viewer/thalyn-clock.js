// ★ WORLD AS DATA · PHASE 2 · THE CLOCK (client 2, 2026-11-15; Mike: "lamps at night, the day curve"). Design §3.2 thalyn-clock.js · §6 phase 2.
// PURE: numbers and [r,g,b] arrays only, no three.js - node tests it (node viewer/thalyn-clock.test.mjs).
//
// The app's day is TimeOfDayModifier.Evaluate (Atmosphere/TimeOfDayModifier.cs:109): four keyframes - Night t 0, Dawn 0.25, Day 0.5, Dusk 0.75 -
// lerped in quarters; the light rides SunArc.Apply (Atmosphere/SunArc.cs:76): a great circle east → the emotion's peak due south → west, the moon on
// the same path at night, elevation floored at horizonPitch, the light faded to 0 over dipWindow round each handover. The client exports exactly
// those numbers (extras.thalyn.dayCurve, Unity Export/GltfInteractExtras.cs), so the viewer moves the clock the way the app does.
//
// The world's file is baked AT ONE HOUR (dayCurve.exportT): its sky / sun / fog numbers already include that hour's modifier. So the clock is
// applied RELATIVE to the export hour (divide the export hour's modifier out, multiply the new hour's in): at t = exportT the state is the file's
// own, byte for byte. ⚠ A baked sky DOME stays the export hour's picture (the viewer has no other); the lights, fog, exposure, stars and lamps move.
//
// Lamps: a `night` lamp burns on LanternGlow.NightLit (Widgets/LanternGlow.cs:373) - max(n, smoothstep(invlerp(onset, full, n))), n = 1 − clamp01(ambientMul);
// an `always` lamp (a real room lamp / attached lamp the app keeps lit) burns at full strength at every hour.

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = v => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const rep01 = t => ((t % 1) + 1) % 1;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const smooth01 = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };   // MoonDisc.Smooth01 / Mathf.SmoothStep(0, 1, ·)

// The app's own keyframes (TimeOfDayModifier.cs :32-107) - used only when a file has no dayCurve block but the viewer still wants a clock.
export const APP_KEYS = Object.freeze([
  { t: 0, sunPitch: 35, exposure: 0.15, intensityMul: 0.025, tempShiftK: -2000, ambientMul: 0.05, fogDensityMul: 1, shadowMul: 0, fogColorShift: [0.15, 0.20, 0.35] },
  { t: 0.25, sunPitch: 8, exposure: 0.7, intensityMul: 0.6, tempShiftK: 500, ambientMul: 0.8, fogDensityMul: 1, shadowMul: 0, fogColorShift: [1.0, 0.80, 0.60] },
  { t: 0.5, sunPitch: 50, exposure: 1.0, intensityMul: 1.0, tempShiftK: 0, ambientMul: 1.0, fogDensityMul: 1, shadowMul: 0, fogColorShift: [1, 1, 1] },
  { t: 0.75, sunPitch: 12, exposure: 0.6, intensityMul: 0.5, tempShiftK: 800, ambientMul: 0.7, fogDensityMul: 1, shadowMul: 0, fogColorShift: [1.0, 0.65, 0.40] },
]);
const FIELDS = ['sunPitch', 'exposure', 'intensityMul', 'tempShiftK', 'ambientMul', 'fogDensityMul', 'shadowMul'];
const rgb3 = a => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(finite) ? a.slice(0, 3).map(clamp01) : null);

/** A clean curve from extras.thalyn.dayCurve (or null when absent / unusable). Keys sorted by t, every number clamped. */
export function readDayCurve(dc) {
  if (!dc || typeof dc !== 'object' || dc.present !== true || !Array.isArray(dc.keys)) return null;
  const keys = [];
  for (const k of dc.keys) {
    if (!k || !finite(k.t)) continue;
    const o = { t: rep01(k.t), fogColorShift: rgb3(k.fogColorShift) || [1, 1, 1] };
    for (const f of FIELDS) o[f] = finite(k[f]) ? k[f] : (f === 'fogDensityMul' || f === 'exposure' || f === 'intensityMul' || f === 'ambientMul' ? 1 : 0);
    o.exposure = clamp(o.exposure, 0, 4); o.intensityMul = clamp(o.intensityMul, 0, 4); o.ambientMul = clamp(o.ambientMul, 0, 4);
    o.fogDensityMul = clamp(o.fogDensityMul, 0, 10); o.tempShiftK = clamp(o.tempShiftK, -10000, 10000); o.sunPitch = clamp(o.sunPitch, -90, 90);
    keys.push(o);
  }
  if (keys.length < 2) return null;
  keys.sort((a, b) => a.t - b.t);
  const num = (v, lo, hi, d) => (finite(v) ? clamp(v, lo, hi) : d);
  return {
    keys,
    exportT: finite(dc.exportT) && dc.exportT >= 0 ? rep01(dc.exportT) : -1,
    peakDeg: num(dc.peakDeg, 5, 90, 50), horizonPitch: num(dc.horizonPitch, 0, 30, 3), dipWindow: num(dc.dipWindow, 0.001, 0.25, 0.03),
    moonDimMul: num(dc.moonDimMul, 0, 1, 0.025), nightOnset: num(dc.nightOnset, 0, 1, 0.12), nightFull: num(dc.nightFull, 0.001, 1, 0.42),
  };
}

/** TimeOfDayModifier.Evaluate generalised to any sorted cyclic key list: the modifier at hour t (0..1). */
export function evalCurve(curve, t) {
  const ks = curve.keys; t = rep01(t);
  let i = ks.length - 1;
  for (let j = 0; j < ks.length; j++) if (ks[j].t <= t) i = j;
  const a = ks[i], b = ks[(i + 1) % ks.length];
  const span = (b.t - a.t + 1) % 1 || 1, u = ((t - a.t + 1) % 1) / span;
  const o = { fogColorShift: [0, 1, 2].map(c => lerp(a.fogColorShift[c], b.fogColorShift[c], u)) };
  for (const f of FIELDS) o[f] = lerp(a[f], b[f], u);
  return o;
}

export const isSun = t => { t = rep01(t); return t >= 0.25 && t < 0.75; };

/**
 * SunArc.Apply: the body's direction (unit, glTF frame: east = −X, south = −Z, up = +Y) and the light factor k at hour t.
 * hourIntensityMul = evalCurve(t).intensityMul (the moon stays moon-dim: k ×= min(1, moonDimMul / hourIntensityMul) at night).
 */
export function sunArc(curve, t, hourIntensityMul) {
  t = rep01(t);
  const d1 = Math.abs(t - 0.25), d2 = Math.abs(t - 0.75);
  const edge = Math.min(Math.min(d1, 1 - d1), Math.min(d2, 1 - d2));
  const f = isSun(t) ? (t - 0.25) / 0.5 : rep01(t - 0.75) / 0.5;
  // ArcDirection (Unity frame): right·cos(a) + top·sin(a), top = (0, sin p, −cos p)
  const a = Math.PI * clamp01(f), p = curve.peakDeg * D2R;
  let ux = Math.cos(a), uy = Math.sin(p) * Math.sin(a), uz = -Math.cos(p) * Math.sin(a);
  const l = Math.hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
  const pitch = Math.max(curve.horizonPitch, Math.asin(clamp(uy, -1, 1)) * R2D);   // the light's elevation is floored at the horizon pitch
  const az = Math.atan2(ux, uz);
  const ce = Math.cos(pitch * D2R);
  const dir = [-(Math.sin(az) * ce), Math.sin(pitch * D2R), Math.cos(az) * ce];      // X negated into the glTF frame
  let k = smooth01(0, curve.dipWindow, edge);
  if (!isSun(t) && hourIntensityMul > 1e-4) k *= Math.min(1, curve.moonDimMul / hourIntensityMul);
  return { dir, k, sun: isSun(t), pitch };
}

/** LanternGlow.NightLit: how brightly a `night` lamp burns for a night factor n (0 day … 1 night). */
export function nightLit(n, onset = 0.12, full = 0.42) {
  n = clamp01(n);
  const u = clamp01((n - onset) / Math.max(1e-6, full - onset));
  return Math.max(n, u * u * (3 - 2 * u));
}
/** The night factor the lamps read (LanternGlow's _ThalynSky_Night = 1 − clamp01(ambientMul)). */
export const nightOf = m => 1 - clamp01(m.ambientMul);
/** A lamp's brightness 0..1 at night factor n: `always` = 1, `night` (or unstamped) = NightLit. */
export const lampLevel = (onAt, n, curve) => (onAt === 'always' ? 1 : nightLit(n, curve ? curve.nightOnset : 0.12, curve ? curve.nightFull : 0.42));

/** AtmosphereRenderer.ShiftColorTemperature (a linear approximation; ±3000 K = a strong wash). */
export function shiftTemp(c, kelvin) {
  const s = kelvin / 10000;
  return [clamp01(c[0] + s), clamp01(c[1] + s * 0.2), clamp01(c[2] - s * 0.8)];
}

/**
 * The lighting state at hour t, RELATIVE to the file's own (base = the state the viewer built from the export: plain numbers + [r,g,b]):
 *   base = { sunDir:[x,y,z], sunColor, sunIntensity, hemiIntensity, exposure, fogColor, fogDensity }.
 * Returns the same shape plus { night, sun (bool), k, t }. At t = curve.exportT it returns base's numbers (unless base was itself clamped).
 */
export function stateAt(curve, base, t) {
  const t0 = curve.exportT >= 0 ? curve.exportT : 0.5;
  const m0 = evalCurve(curve, t0), m = evalCurve(curve, t);
  const a0 = sunArc(curve, t0, m0.intensityMul), a = sunArc(curve, t, m.intensityMul);
  // the sun: the file's own daylight strength when it was exported in daylight, else the viewer's default day (2.2)
  const lit0 = m0.intensityMul * a0.k;
  const dayI = lit0 > 0.3 ? base.sunIntensity / lit0 : 2.2;
  const sunIntensity = clamp(dayI * m.intensityMul * a.k, 0, 4);
  const sunColor = shiftTemp(shiftTemp(base.sunColor, -m0.tempShiftK), m.tempShiftK);
  const hemiDay = clamp(base.hemiIntensity / Math.max(0.05, m0.ambientMul), 0.05, 2);
  const hemiIntensity = clamp(hemiDay * m.ambientMul, 0.03, 2);
  const exposure = clamp(base.exposure * Math.sqrt(Math.max(1e-3, m.exposure) / Math.max(1e-3, m0.exposure)), 0.3, 2.5);
  // fog: app colour = lerp(emotionFog, shift, 0.5) × clamp(ambientMul, 0.08, 1) - invert at the export hour, re-apply at t
  const s0 = clamp(m0.ambientMul, 0.08, 1), s1 = clamp(m.ambientMul, 0.08, 1);
  const emo = [0, 1, 2].map(c => clamp01(2 * (base.fogColor[c] / s0) - m0.fogColorShift[c]));
  const fogColor = [0, 1, 2].map(c => clamp01(lerp(emo[c], m.fogColorShift[c], 0.5) * s1));
  const fogDensity = base.fogDensity * (m.fogDensityMul / Math.max(1e-3, m0.fogDensityMul));
  return { t: rep01(t), sunDir: a.dir, sunColor, sunIntensity, hemiIntensity, exposure, fogColor, fogDensity, night: nightOf(m), sun: a.sun, k: a.k };
}

/** "hh:mm" of an hour 0..1. */
export function clockText(t) { const mins = Math.round(rep01(t) * 1440) % 1440; return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; }
