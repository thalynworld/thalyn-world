// ★ WORLD AS DATA · PHASE 1 (client 2, 2026-11-15): the quality-tier table, MOVED out of thalyn-atmos.js unchanged (design §3.2: the 1,774-line
// atmos file sheds the walk and the tiers). PURE (no imports). thalyn-atmos.js re-exports TIERS / guessTier / makeTier, so every import keeps working.

// ── Quality tiers: ONE table every effect budgets against ───────────────────
// The scar this honours: individually cheap effects, added one at a time, are what sank a Cosy world's
// frame rate in the app. Here nothing sizes itself — every effect registers with makeTier and reads
// its numbers from the row below; a new effect adds a column, never a private constant.
// ★ A5386 grass (thalyn-grass.js): radius × density × the distance past which a tuft drops to its 4-triangle far form.
// Desktop = the app's own field (SpeciesCoordinator grassCullDistance 60 m, the High density cap).
// ★ A5389 ivy (thalyn-ivy.js): ivyCull = the game's cell sleep distance, Overgrowth SleepBeyondM 150 m × TierReachMul
// (1 / 0.85 / 0.6); ivyKeep = 1 − TierTriMul (0 / 0.4 / 0.65): Medium/Low build 60 % / 35 % of the cards. The 60 → 130 m
// thinning itself is the game's on every tier.
// ★ A5396 (perf P1, spec B1/B3): shadowHalf 150 → 120 / 100 → 80 (same map, sharper texel, fewer casters);
// shadowMinHeight = the casters law — a mesh whose world AABB is shorter than this casts no sun shadow (ground cover,
// strokes, small props; ivy cards and the terrain never cast). interiorFirst* = the first interior load waits until
// the frame EMA is under EmaMs for CalmS seconds (or CapS at most) so it never lands on the landing frames;
// worldCompileCapS = the longest the world stays hidden while compileAsync builds its shader programs (never fatal).
// ★ A5397 (perf P2, spec B2/B4/§C): maxBufferW = the drawing buffer's widest (px): pixel ratio = min(dpr, pixelRatio,
// maxBufferW / innerWidth) at boot, on tier apply and on resize (2560 desktop; laptop/phone never above today's).
// bandBelowM/bandAboveM = the storey band (thalyn-interiors.js planBand: a shown building draws the meshes meeting
// [camY − below, camY + above] + its storey ± 1); bandCapTris = §C's per-building cap (INFORMATIONAL — the band log flags it).
// bvhSliceMs … chestM = INDOORS I1's walk knobs (thalyn-indoors.js reads them via interiors.knobs; INDOOR_DEFAULTS = fallback).
// ★ A13681 globeFlakes = the snow globe's flake count (thalyn-globe.js; card spec §3.1.3: 6000 / 3000 / 1200; the phone raised to 2400 on the founder's walk, A14420).
// ★ A17150 shoreFoam = the shore-foam ring's segment budget (thalyn-water.js; merged from viewer/variation-foam-ice-nov15).
// ★ A5398 splitBinM = the storey split's bin height when a building row carries no storey count (thalyn-interiors.js splitByStorey).
export const TIERS = {
  high:   { label: 'Desktop', pixelRatio: 2.0, shadows: true,  shadowMap: 2048, shadowHalf: 120, shadowMinHeight: 1.5, msaa: 4, bloom: true,  shafts: true,  weather: 1.0,  sprayPerFall: 220, fallsMax: 24, sheetRows: 28, foam: true,  shoreFoam: 1024, voices: 12, canopies: 6, wisps: 8, fireLights: 48, lanternLights: 16, creatures: 48, birdRoutes: 6, perched: 24, grassRadius: 60, grassDensity: 1.0,  grassLod: 15, ivyCull: 150, ivyKeep: 0, interiorFirstEmaMs: 20, interiorFirstCalmS: 1, interiorFirstCapS: 6, worldCompileCapS: 4, maxBufferW: 2560, bandBelowM: 7, bandAboveM: 12, bandCapTris: 350000, splitBinM: 4, bvhSliceMs: 8, stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2, globeFlakes: 6000 },
  laptop: { label: 'Laptop',  pixelRatio: 1.5, shadows: true,  shadowMap: 1024, shadowHalf: 80,  shadowMinHeight: 1.5, msaa: 2, bloom: true,  shafts: false, weather: 0.55, sprayPerFall: 90,  fallsMax: 12, sheetRows: 20, foam: true,  shoreFoam: 512, voices: 8,  canopies: 4, wisps: 8, fireLights: 20, lanternLights: 8,  creatures: 16, birdRoutes: 4, perched: 12, grassRadius: 40, grassDensity: 0.6,  grassLod: 10, ivyCull: 127.5, ivyKeep: 0.4, interiorFirstEmaMs: 20, interiorFirstCalmS: 1, interiorFirstCapS: 6, worldCompileCapS: 5, maxBufferW: 2160, bandBelowM: 7, bandAboveM: 12, bandCapTris: 250000, splitBinM: 4, bvhSliceMs: 8, stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2, globeFlakes: 3000 },
  lite:   { label: 'Phone',   pixelRatio: 1.0, shadows: false, shadowMap: 512,  shadowHalf: 0,   shadowMinHeight: 1.5, msaa: 0, bloom: false, shafts: false, weather: 0.30, sprayPerFall: 36,  fallsMax: 6,  sheetRows: 12, foam: false, shoreFoam: 0, voices: 5,  canopies: 3, wisps: 8, fireLights: 6,  lanternLights: 3,  creatures: 6,  birdRoutes: 2, perched: 6,  grassRadius: 25, grassDensity: 0.35, grassLod: 6, ivyCull: 90, ivyKeep: 0.65, interiorFirstEmaMs: 20, interiorFirstCalmS: 1, interiorFirstCapS: 6, worldCompileCapS: 8, maxBufferW: 1440, bandBelowM: 7, bandAboveM: 12, bandCapTris: 150000, splitBinM: 4, bvhSliceMs: 16, stepUpM: 0.6, fallGuardM: 3, wallRayM: 0.45, wallSpreadDeg: 35, wallRadiusM: 0.25, chestM: 1.2, globeFlakes: 2400 },
};
// ★ A13560 Quest (WebXR in the Meta Quest browser, spec §3.4): the Phone row's budgets (every module that keys a
// table by tier name is handed `as` = 'lite') plus the headset's own columns: xrScale = framebuffer scale, foveation =
// fixed foveation 0..1, teleport = default locomotion, smoothMps = the opt-in smooth walk's speed.
TIERS.quest = Object.assign({}, TIERS.lite, { label: 'Quest', as: 'lite', xrScale: 0.9, foveation: 1, teleport: true, smoothMps: 2.0 });

// Heuristic: what the device says about itself. Returns { name, why } so the HUD can show the reason.
export function guessTier(renderer) {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) && !/Chrome/.test(ua));
  let gpu = '';
  try { const gl = renderer.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info'); if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''; } catch (e) {}
  const g = gpu.toLowerCase();
  if (/OculusBrowser|Quest/i.test(ua)) return { name: 'quest', why: 'Quest browser' };
  if (mobile) return { name: 'lite', why: 'phone/tablet' };
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return { name: 'lite', why: 'software GPU' };
  if (/intel|iris|uhd|hd graphics|mali|adreno|apple gpu|apple m1|powervr/.test(g)) return { name: 'laptop', why: gpu.slice(0, 40) || 'integrated GPU' };
  if ((navigator.hardwareConcurrency || 8) <= 4) return { name: 'laptop', why: 'few cores' };
  return { name: 'high', why: gpu.slice(0, 40) || 'desktop' };
}
export function makeTier(renderer, forced) {
  const listeners = [];
  const guess = guessTier(renderer);
  let name = TIERS[forced] ? forced : guess.name, auto = !TIERS[forced];
  function set(n) {
    if (n === 'auto' || !n) { auto = true; n = guess.name; } else auto = false;
    if (!TIERS[n]) n = guess.name;
    name = n;
    for (const fn of listeners) { try { fn(TIERS[name], name); } catch (e) { console.warn('[tier]', e); } }
  }
  return {
    on(fn) { listeners.push(fn); try { fn(TIERS[name], name); } catch (e) { console.warn('[tier]', e); } },
    set, get name() { return name; }, get table() { return TIERS[name]; }, get auto() { return auto; }, get guess() { return guess; },
  };
}
