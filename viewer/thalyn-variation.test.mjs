// ★ A17140 / A17150 / A17160 bench: node viewer/thalyn-variation.test.mjs → ALL PASS. Pure: thalyn-variation.js + thalyn-liquid.js only.
import { hueJitterAt, yiqRotate, gradeWithJitter, jitterTexel, hash3, definesFor, describeVariation, applyFoliageVariation, MODES,
  VARIATION_FRAGMENT_HEAD, VARIATION_FRAGMENT_ALBEDO, VARIATION_FRAGMENT_RIM } from './thalyn-variation.js';
import { ICE_SOLID_AT, isFrozen, openLiquids, describeIce, foamOf, foamBodies, foamWind, foamEnvelope, FOAM_DEFAULTS, FOAM_MAX_BODIES } from './thalyn-liquid.js';
import { readFileSync } from 'node:fs';
const CLIENT_ROOTS = ['../../../Unity%20Projects/Tools/Thalyn%20Final/', '../../../Thalyn%20Final/'];   // a D: worktree, or Website/thalyn-world beside the client
const clientFile = rel => { let last; for (const r of CLIENT_ROOTS) { try { return readFileSync(new URL(rel, new URL(r, import.meta.url)), 'utf8'); } catch (e) { last = e; } } throw last; };

let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { ok ? passes++ : fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const near3 = (a, b, e) => a.every((v, i) => near(v, b[i], e));
const deg = Math.PI / 180;

// ── 1 · the hue jitter (ThalynPalette.hlsl:148) ─────────────────────────────────────────────────────────────────────────────────────────
const peak = 4 * deg;   // AtmosphereRenderer.HueJitterDegrees
check('jitter 0 when the peak is 0 (identity, as the shader)', hueJitterAt(12.3, 45.6, 0) === 0);
let lo = Infinity, hi = -Infinity, sum = 0; const N = 20000;
for (let i = 0; i < N; i++) { const j = hueJitterAt(i * 3.17 - 900, (i % 97) * 11.3 + 40, peak); lo = Math.min(lo, j); hi = Math.max(hi, j); sum += j; }
check('jitter stays inside ±peak', lo >= -peak - 1e-12 && hi <= peak + 1e-12, `[${(lo / deg).toFixed(2)}°, ${(hi / deg).toFixed(2)}°]`);
check('jitter spreads across the range (not one colour)', hi - lo > 1.8 * peak);
check('jitter mean ~0 (no tint drift)', Math.abs(sum / N) < 0.05 * peak, `${(sum / N / deg).toFixed(3)}°`);
check('jitter is stable for one instance', hueJitterAt(101.5, -33.25, peak) === hueJitterAt(101.5, -33.25, peak));
check('neighbouring trees differ', hueJitterAt(100, 50, peak) !== hueJitterAt(104, 50, peak));

// ── 2 · YIQ rotation: identity, composition, luma ───────────────────────────────────────────────────────────────────────────────────────
const leaf = [0.18, 0.32, 0.09];
check('rotation 0 = identity', near3(yiqRotate(leaf, 0), leaf, 0));
check('rot(a)·rot(b) = rot(a+b) (so the walk\'s Rot(hue + j) = Rot(j)·Rot(hue))', near3(yiqRotate(yiqRotate(leaf, 0.07), 0.05), yiqRotate(leaf, 0.12), 2e-3));

// ── 3 · THE RECONSTRUCTION: the viewer's jitter on a graded texel = the walk's grade with the jitter ─────────────────────────────────────
const grades = [
  { name: 'serene day', sat: 0.82, val: 0.96, hueShift: 0.03, tint: [0.36, 0.48, 0.28, 0.35] },
  { name: 'strong pull', sat: 0.7, val: 1.0, hueShift: -0.05, tint: [0.5, 0.42, 0.25, 0.8] },
  { name: 'no pull', sat: 0.9, val: 1.02, hueShift: 0.0, tint: [0, 0, 0, 0] },
];
const texels = [[0.18, 0.32, 0.09], [0.05, 0.12, 0.03], [0.4, 0.55, 0.2], [0.6, 0.5, 0.3], [0.02, 0.02, 0.02]];
for (const g of grades) {
  let worst = 0;
  for (const s of texels) for (const j of [-peak, -peak / 3, peak / 2, peak]) {
    const walk = gradeWithJitter(s, g, j);                         // what the walk draws for this instance
    const viewer = jitterTexel(gradeWithJitter(s, g, 0), g.tint, j, true);   // what the export bakes (no jitter) + the viewer's step
    worst = Math.max(worst, ...walk.map((v, i) => Math.abs(v - viewer[i])));
  }
  check(`graded reconstruction = the walk (${g.name})`, worst < 2e-3, `max |Δ| ${worst.toExponential(2)}`);
}
check('disarmed grade (sat 0) = identity, as the shader early-return', near3(gradeWithJitter(leaf, { sat: 0, val: 1, hueShift: 0.1, tint: [1, 0, 0, 1] }, peak), leaf, 0));
check('ungraded row = plain rotation', near3(jitterTexel(leaf, [0.3, 0.4, 0.2, 0.5], 0.05, false), yiqRotate(leaf, 0.05), 1e-12));

// ── 4 · per-material switches ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const blk = { present: true, armed: true, hueJitter: peak, tint: [0.36, 0.48, 0.28, 0.35] };
check('armed + jitter row → TV_JITTER (+graded)', JSON.stringify(definesFor({ jitter: true, graded: true, mode: '' }, blk)) === JSON.stringify({ TV_JITTER: '', TV_GRADED: '' }));
check('disarmed block → no jitter (a look is worn)', definesFor({ jitter: true, graded: true }, { ...blk, armed: false }).TV_JITTER === undefined);
check('pattern mode → TV_MODE number', definesFor({ jitter: false, mode: 'eerie' }, blk).TV_MODE === MODES.eerie);
check('no pattern props → no TV_MODE', definesFor({ jitter: true, mode: '' }, blk).TV_MODE === undefined);

// ── 5 · the cell hash (TreeLeafCluster_URP.shader:287) is in [0,1) and per 1 m cell ──────────────────────────────────────────────────────
let hOk = true; for (let i = 0; i < 2000; i++) { const h = hash3([i * 1.3 - 400, 12 + (i % 7), -i * 0.7]); if (!(h >= 0 && h < 1)) hOk = false; }
check('cell hash in [0,1)', hOk);
check('cell hash constant inside one cell', hash3([Math.floor(3.2), Math.floor(7.9), Math.floor(-1.1)]) === hash3([3, 7, -2]));

// ── 6 · drift guard: the GLSL carries the app's own constants ───────────────────────────────────────────────────────────────────────────
const glsl = VARIATION_FRAGMENT_HEAD + VARIATION_FRAGMENT_ALBEDO + VARIATION_FRAGMENT_RIM;
for (const k of ['127.1, 311.7', '43758.5453', '0.3183099', '0.299 + 0.701 * cosA + 0.168 * sinA', '0.114 + 0.886 * cosA - 0.203 * sinA',
  'vec3(0.8, 0.3, 0.2)', 'vec3(0.5, 0.55, 0.9)', 'vec3(0.2, 0.3, 0.1)', '1.0 - tvEdge * 0.4', 'tvRim * tvRim * tvEdge * 0.25', 'vec2(-vTvOrigin.x, vTvOrigin.y)'])
  check(`GLSL carries ${k}`, glsl.includes(k));
// and the client shaders still say what this port copied (fails if the walk's chain changes under it)
try {
  const pal = clientFile('Assets/Thalyn/Shaders/Include/ThalynPalette.hlsl');
  check('client hlsl: jitter hash unchanged', pal.includes('frac(sin(dot(worldXZ, float2(127.1, 311.7))) * 43758.5453)'));
  check('client hlsl: jitter folded before the pull', pal.includes('float hueTotal = _ThalynPaletteHueShift + hueJitterRadians;'));
  const leafSh = clientFile('Assets/WorldStandard/VX_TreeSystem/Shaders/TreeLeafCluster_URP.shader');
  check('client leaf: rim unchanged', leafSh.includes('rimFactor = pow(rimFactor, 2.0) * leafEdge * 0.25;'));
  check('client leaf: cell variation unchanged', leafSh.includes('float colorVariation = hash(floor(input.positionWS)) * 2.0 - 1.0;'));
} catch (e) { console.log('SKIP  client shader drift guard (the client repo is not beside this one: ' + e.message + ')'); }

// ── 7 · applyFoliageVariation on a fake scene graph (no three.js) ───────────────────────────────────────────────────────────────────────
const matA = { name: 'Oak_Leaves_gltfFoliage', userData: {}, map: {}, emissiveMap: null }, matB = { name: 'Rock_Mat', userData: {} };
matA.emissiveMap = matA.map;
const mk = (mat, inst) => ({ isMesh: true, isInstancedMesh: !!inst, material: mat });
const meshes = [mk(matA, true), mk(matA, false), mk(matB, false)];
const fakeRoot = { traverse: fn => meshes.forEach(fn) };
const block = { present: true, armed: true, hueJitter: peak, hueShift: 0.03, tint: [0.36, 0.48, 0.28, 0.35],
  materials: [{ name: 'Oak_Leaves_gltfFoliage', jitter: true, graded: true, mode: 'serene', pattern: 0.3, patternScale: 1, cellVar: 0.02, glow: 0 },
              { name: 'Missing_gltfFoliage', jitter: true, graded: false, mode: '' }] };
const r = applyFoliageVariation(block, fakeRoot, { value: 0 });
check('one material patched once (shared by 2 meshes)', r.materials === 1 && r.meshes === 2 && r.instanced === 1);
check('defines set', matA.defines && matA.defines.TV_JITTER === '' && matA.defines.TV_GRADED === '' && matA.defines.TV_MODE === 1 && matA.defines.TV_EMISSIVE_ALBEDO === '');
check('unmatched row counted', r.unmatched === 1);
check('a rock is untouched', !matB.defines && !matB.onBeforeCompile);
const shader = { uniforms: {}, vertexShader: 'void main(){\n#include <project_vertex>\n}', fragmentShader: 'void main(){\n#include <alphamap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n}' };
matA.onBeforeCompile(shader, null);
check('inject: vertex origin + world', shader.vertexShader.includes('vTvOrigin =') && shader.vertexShader.includes('vTvWorld = tvW.xyz'));
check('inject: albedo after alphamap, rim after normal, emissive follows', shader.fragmentShader.indexOf('tvBefore') > shader.fragmentShader.indexOf('#include <alphamap_fragment>')
  && shader.fragmentShader.indexOf('tvRim') > shader.fragmentShader.indexOf('#include <normal_fragment_maps>') && shader.fragmentShader.includes('totalEmissiveRadiance *='));
check('inject: uniforms bound', ['uTvTint', 'uTvJitter', 'uTvPat', 'uTvTime'].every(k => shader.uniforms[k]));
check('second apply is a no-op', applyFoliageVariation(block, fakeRoot, { value: 0 }).materials === 0);
check('no block → nothing', applyFoliageVariation(null, fakeRoot).materials === 0);
check('describe: absent block said plainly', describeVariation(null, null, false).includes('no extras.thalyn.foliage'));
check('describe: counts', describeVariation(block, r, false).includes('1 of 2 material(s)') && describeVariation(block, r, false).includes('±4.0°'));

// ── 8 · A17160 ICE: a frozen lake is not swum ───────────────────────────────────────────────────────────────────────────────────────────
const lake = (ice, extra = {}) => ({ type: 'water', name: 'ThalynWater_Lake', surfaceY: 10, centerXZ: [5, 5], sizeXZ: [20, 20], ice, ...extra });
check('ice threshold = IceSheets.FrozenSolid 0.55', ICE_SOLID_AT === 0.55);
check('open water (ice 0) swims', !isFrozen(lake(0)));
check('part-frozen (0.4) is still water, as the game', !isFrozen(lake(0.4)));
check('frozen solid (0.55) is walkable ice', isFrozen(lake(0.55)));
check('frozen (1.0) is walkable ice', isFrozen(lake(1)));
check('an older export (no ice field) swims', !isFrozen({ type: 'water', surfaceY: 1 }));
check('lava is never "frozen"', !isFrozen({ type: 'lava', ice: 1 }));
const liq = [lake(1), lake(0, { name: 'ThalynWater_Pond', sizeXZ: [4, 4] }), { type: 'lava', name: 'ThalynLava', centerXZ: [0, 0], sizeXZ: [3, 3], surfaceY: 2 }];
check('openLiquids drops only the frozen row', openLiquids(liq).length === 2 && !openLiquids(liq).some(isFrozen));
check('describeIce says it', /1 frozen body\(ies\) walkable/.test(describeIce(liq) || ''));
check('describeIce silent on an unfrozen world', describeIce([lake(0)]) === null);
// the swim probe's decision (thalyn-atmos makeWaterProbe keeps rows where !isFrozen; walker swims when water - ground > 1.2)
const probeRows = liq.filter(l => l.type === 'water' && !isFrozen(l));
check('swim probe: no rectangle over the frozen lake', !probeRows.some(l => l.name === 'ThalynWater_Lake'));

// ── 9 · A17150 FOAM numbers ────────────────────────────────────────────────────────────────────────────────────────────────────────────
check('an older row takes the shader defaults', foamOf({ type: 'water' }).width === FOAM_DEFAULTS.width && foamOf({}).intensity === FOAM_DEFAULTS.intensity && !foamOf({}).own);
check('a row\'s own numbers win', (f => f.width === 2.2 && f.intensity === 0.5 && f.color[0] === 0.8 && f.own)(foamOf({ foamWidth: 2.2, foamIntensity: 0.5, foamColor: [0.8, 0.9, 1] })));
check('own intensity 0 is honoured (no foam on that body)', foamOf({ foamWidth: 1.5, foamIntensity: 0 }).intensity === 0);
const fb = foamBodies([lake(0, { foamWidth: 1.5, foamIntensity: 0.7 }), lake(1), lake(0, { name: 'Sea', sizeXZ: [900, 900], foamWidth: 3, foamIntensity: 0.9 })]);
check('foam bodies: frozen dropped, smallest first, APP X negated', fb.total === 2 && fb.bodies[0].hx === 10 && fb.bodies[0].cx === -5 && fb.world.width === 3);
check('foam bodies capped at the shader loop', foamBodies(Array.from({ length: 12 }, (_, i) => lake(0, { sizeXZ: [i + 1, i + 1] }))).bodies.length === FOAM_MAX_BODIES);
check('wind: calm = ×1', (w => w.boost === 1 && w.widthMul === 1 && w.scroll === 1)(foamWind(0, 0)));
check('wind: storm clamps at 6 (the shader min(...,6))', (w => near(w.boost, 4.3) && near(w.widthMul, 3.7) && near(w.scroll, 5.2))(foamWind(9, 9)));
check('band: full at the waterline', near(foamEnvelope(0, 1.5, 0.7), 0.45));
check('band: gone past 2.5× width', foamEnvelope(1.5 * 2.5 + 0.01, 1.5, 0.7) === 0);
check('band: out of water = 0', foamEnvelope(-0.2, 1.5, 0.7) === 0);
check('band: decreasing with depth', foamEnvelope(0.3, 1.5, 0.7) > foamEnvelope(1.0, 1.5, 0.7));
check('band: intensity 0 = none', foamEnvelope(0.1, 1.5, 0) === 0);
// the client shader still says what the port copied
try {
  const ws = clientFile('Assets/Thalyn/Shaders/ThalynWater.shader');
  check('client water: foam width default 1.5', ws.includes('_FoamWidth ("Foam Width (meters)", Float) = 1.5'));
  check('client water: band cap 0.45', ws.includes('foam = min(max(foam, foam2), 0.45);'));
  check('client water: wind width lever', ws.includes('_FoamWidth * (1.0 + min(_WEATHER_WindStrength, 6.0) * 0.45)'));
} catch (e) { console.log('SKIP  client water drift guard (' + e.message + ')'); }

console.log(`\n${fails ? 'FAILED' : 'ALL PASS'} (${passes} pass, ${fails} fail)`);
process.exit(fails ? 1 : 0);
