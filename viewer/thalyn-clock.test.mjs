// node viewer/thalyn-clock.test.mjs - the day curve against the app (TimeOfDayModifier.cs, SunArc.cs, LanternGlow.cs). Pure.
import * as C from './thalyn-clock.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a, b, e, m) => ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b} (±${e})`);

// the exported block, exactly as GltfInteractExtras.CaptureDayCurve writes it (Serene)
const block = { present: true, version: 1, keys: C.APP_KEYS.map(k => ({ ...k })), exportT: 0.5, peakDeg: 85, horizonPitch: 3, dipWindow: 0.03, moonDimMul: 0.025, nightOnset: 0.12, nightFull: 0.42 };
const curve = C.readDayCurve(block);
ok(curve && curve.keys.length === 4, 'readDayCurve reads 4 keys');
ok(C.readDayCurve({ present: false, keys: block.keys }) === null, 'present:false = no curve');
ok(C.readDayCurve({ present: true, keys: [{ t: 0 }] }) === null, 'one key = no curve');
ok(C.readDayCurve(null) === null, 'null = no curve');

// Evaluate: the quarters
near(C.evalCurve(curve, 0.5).intensityMul, 1, 1e-9, 'noon = Day');
near(C.evalCurve(curve, 0).exposure, 0.15, 1e-9, 'midnight = Night');
near(C.evalCurve(curve, 0.375).intensityMul, 0.8, 1e-9, 't 0.375 = halfway Dawn→Day (0.6→1.0)');
near(C.evalCurve(curve, 0.875).ambientMul, (0.7 + 0.05) / 2, 1e-9, 't 0.875 = halfway Dusk→Night');
near(C.evalCurve(curve, 0.999).ambientMul, 0.05 + (0.7 - 0.05) * (0.001 / 0.25), 1e-6, 'wraps Dusk→Night toward t 1');
near(C.evalCurve(curve, 1.25).sunPitch, 8, 1e-9, 't 1.25 repeats to Dawn');
near(C.evalCurve(curve, 0.8125).fogColorShift[2], 0.40 + (0.35 - 0.40) * 0.25, 1e-9, 'fog shift lerps (a quarter of Dusk→Night blue)');

// SunArc: noon due south at the emotion's peak; east at dawn, west at dusk (glTF: east = −X)
{
  const noon = C.sunArc(curve, 0.5, 1);
  near(noon.pitch, 85, 1e-6, 'Serene noon peak 85°');
  ok(noon.dir[2] < 0 && Math.abs(noon.dir[0]) < 1e-6, 'noon: due south (−Z), no east-west');
  near(noon.k, 1, 1e-9, 'noon full light');
  const morn = C.sunArc(curve, 0.3, 0.7);
  ok(morn.dir[0] < 0, `morning sun in the east (glTF −X): ${morn.dir[0].toFixed(3)}`);
  const eve = C.sunArc(curve, 0.7, 0.6);
  ok(eve.dir[0] > 0, 'evening sun in the west (glTF +X)');
  const dawn = C.sunArc(curve, 0.25, 0.6);
  near(dawn.k, 0, 1e-9, 'the light is 0 at the handover');
  near(dawn.pitch, 3, 1e-9, 'elevation floored at horizonPitch 3°');
  near(C.sunArc(curve, 0.25 + 0.015, 0.6).k, 0.5, 1e-6, 'half way through the dip window = 0.5 (smoothstep)');
  const midnight = C.sunArc(curve, 0, 0.025);
  ok(!midnight.sun && midnight.pitch > 80, 'midnight: the moon at the peak');
  near(midnight.k, 1, 1e-9, 'the moon at full night intensity (k 1)');
  near(C.sunArc(curve, 0.9, 0.3).k, 0.025 / 0.3, 1e-9, 'the moon stays moon-dim (moonDimMul / hourIntensityMul)');
  const d = C.sunArc(curve, 0.4, 1).dir; near(Math.hypot(...d), 1, 1e-9, 'the direction is a unit vector');
  const ee = C.readDayCurve({ ...block, peakDeg: 25 });
  near(C.sunArc(ee, 0.5, 1).pitch, 25, 1e-6, 'Eerie peak 25° (low sun)');
}

// NightLit (LanternGlow.cs:373)
near(C.nightLit(0), 0, 1e-9, 'no night = unlit');
near(C.nightLit(0.12), 0.12, 1e-9, 'at the onset = its own input');
near(C.nightLit(0.27), 0.5, 1e-9, 'half way onset→full = 0.5 (above n 0.27)');
near(C.nightLit(0.42), 1, 1e-9, 'full from 0.42');
near(C.nightLit(0.9), 1, 1e-9, 'deep night full');
near(C.nightOf(C.evalCurve(curve, 0.5)), 0, 1e-9, 'noon: night 0');
near(C.nightOf(C.evalCurve(curve, 0)), 0.95, 1e-9, 'midnight: night 0.95');
near(C.lampLevel('night', C.nightOf(C.evalCurve(curve, 0.5)), curve), 0, 1e-9, 'a night lamp is out at noon');
near(C.lampLevel('night', C.nightOf(C.evalCurve(curve, 0.75)), curve), C.nightLit(0.3), 1e-9, 'a night lamp at dusk (night 0.3) is coming on');
ok(C.lampLevel('night', 0.3, curve) > 0.6 && C.lampLevel('night', 0.3, curve) < 0.8, 'dusk lamp ~0.7');
near(C.lampLevel('always', 0, curve), 1, 1e-9, 'an always lamp burns at noon');
near(C.lampLevel(undefined, 0.95, null), 1, 1e-9, 'an unstamped lamp follows the night (old exports)');

// ShiftColorTemperature
{
  const c = C.shiftTemp([0.5, 0.5, 0.5], 1000);
  near(c[0], 0.6, 1e-9, '+1000 K: red +0.1'); near(c[1], 0.52, 1e-9, 'green +0.02'); near(c[2], 0.42, 1e-9, 'blue −0.08');
  near(C.shiftTemp([1, 1, 0], 3000)[0], 1, 1e-9, 'clamped at 1');
}

// stateAt: relative to the export hour
{
  const base = { sunDir: [0, 1, 0], sunColor: [1, 0.95, 0.9], sunIntensity: 2.4, hemiIntensity: 0.6, exposure: 1.1, fogColor: [0.7, 0.75, 0.8], fogDensity: 0.004 };
  const s0 = C.stateAt(curve, base, 0.5);
  near(s0.sunIntensity, 2.4, 1e-9, 'at the export hour: the file\'s own sun');
  near(s0.hemiIntensity, 0.6, 1e-9, '… its own ambient'); near(s0.exposure, 1.1, 1e-9, '… its own exposure');
  ok(s0.fogColor.every((v, i) => Math.abs(v - base.fogColor[i]) < 1e-9), '… its own fog colour');
  ok(s0.sunColor.every((v, i) => Math.abs(v - base.sunColor[i]) < 1e-9), '… its own sun colour');
  near(s0.night, 0, 1e-9, 'noon: no night');
  const s9 = C.stateAt(curve, base, 0.875);
  ok(s9.sunIntensity < 0.1 && s9.night > 0.5, `at 21:00 the sun is down (${s9.sunIntensity.toFixed(3)}) and night is ${s9.night.toFixed(2)}`);
  ok(s9.exposure < 1.1 && s9.exposure >= 0.3, 'exposure drops at night, floored at 0.3');
  ok(s9.fogColor[0] < base.fogColor[0], 'night fog is darker');
  const sDusk = C.stateAt(curve, base, 0.72);
  ok(sDusk.sunColor[0] >= sDusk.sunColor[2], 'dusk light is warm (red ≥ blue)');
  // exported at night: the day sun falls back to 2.2
  const nb = C.readDayCurve({ ...block, exportT: 0 });
  const sn = C.stateAt(nb, { ...base, sunIntensity: 0.12 }, 0.5);
  near(sn.sunIntensity, 2.2, 1e-9, 'a file exported at night: noon gets the viewer\'s default day sun (2.2)');
  near(C.stateAt(nb, { ...base, sunIntensity: 0.12 }, 0).sunIntensity, 2.2 * 0.025 * C.sunArc(nb, 0, 0.025).k, 1e-9, '… and its own hour stays moonlit');
}
ok(C.clockText(0.5) === '12:00' && C.clockText(0.75) === '18:00' && C.clockText(0) === '00:00' && C.clockText(0.999) === '23:59', 'clock text');

console.log(fail ? `FAILED ${fail} (passed ${pass})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
