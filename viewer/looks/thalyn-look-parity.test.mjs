// ★ LOOK PARITY bench (2026-11-11) — node viewer/looks/thalyn-look-parity.test.mjs → ALL PASS.
// Three hand-written extras.thalyn blocks (no look tag · a demo look · a baked look) through the look modules' PURE functions, plus the
// demo looks against the palette table. No browser, no pixels: this proves the DECISIONS (which row, which layer, which water), never how
// anything looks. The 'three' import of thalyn-lookrender.js is stubbed (decide() never touches THREE).
// Optional: THALYN_CLIENT_PALETTES=<path to the client's Assets/Thalyn/Resources/LookPalettes.json> also fails when the viewer's copy differs.
import { register } from 'node:module';
import fs from 'fs';
const stub = 'export default {}; export class ShaderPass {} export class BokehPass {} export const Vector2 = class {}, Vector3 = class {}, Vector4 = class {}, Matrix4 = class {};';
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s === 'three' || s.startsWith('three/')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true }; return next(s, c); }`));
const TL = await import('../thalyn-look.js');
const TLR = await import('../thalyn-lookrender.js');

let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };
const raw = fs.readFileSync(new URL('./LookPalettes.json', import.meta.url), 'utf8');
const j = JSON.parse(raw);
const canon = s => (s ? String(s) : 'natural').replace(/[_ ]/g, '').toLowerCase();
const table = new Map(j.looks.map(l => [canon(l.styleId), l]));   // the same keying as TL.palettes()
const water = () => ({ present: true, deep: [0.1, 0.3, 0.4], shallow: [0.3, 0.6, 0.6], clarity: 1, style: { hue: -1, strength: 0, effect: 'none', rainbow: false } });

// ── 1 · NO TAG: a natural world (LookExport.Build == null → nothing written) ─────────────────────────────────────────────
const plain = { tone: 'Serene', water: water() };
ok(TL.readLook(plain) === null, 'no tag: readLook → null (index.html then runs no look code: no palette fetch, no pass inserted)');
ok(TL.rowFor(TL.readLook(plain), table) === null, 'no tag: no row');
ok(TLR.decide(null, 'high').enqueue === false, 'no tag: the render pass decides nothing (never inserted into the composer)');

// ── 2 · A DEMO LOOK (v2 tag as LookExport.Build + StampV2 write it today) ─────────────────────────────────────────────────
const demo = (row) => ({ tone: 'Joyful', water: water(), look: { version: 2, sceneRecipeId: row, sceneVersion: 1, renderRow: row,
  byZone: [{ zone: 0, recipeId: row, version: 1, surface: row, form: '', formChoice: '', render: row, source: 'scene', exportFallback: 'surface' }],
  baked: false, bakedLook: '', label: 'x', recipeHash: 'sha256:' + '0'.repeat(64), lookId: '', body: '', remixOf: '' } });
const expect = {   // what the render row says, read from the table by hand
  saturdaycartoon: { grade: true, outline: true, toon: true, water: true, path: true, snow: true },
  pastelclay: { grade: true, outline: true, toon: true, water: true, path: true, snow: true },
  goldenstorybook: { grade: true, outline: true, toon: true, water: true, path: true, snow: true },
};
for (const [id, e] of Object.entries(expect)) {
  const tx = demo(id), look = TL.readLook(tx), row = TL.rowFor(look, table);
  ok(look && row && row.styleId === id, `${id}: tag read, row found`);
  const d = TLR.decide(row.render, 'high');
  ok(d.enqueue && d.grade === e.grade && d.outline === e.outline && d.toon === e.toon, `${id}: render layer at 'high' = grade ${d.grade} · outline ${d.outline} · toon ${d.toon}`);
  const dl = TLR.decide(row.render, 'lite');
  ok(dl.grade && !dl.outline && !dl.toon, `${id}: phone tier ('lite') = grade only (the game's LOW law)`);
  const w = TL.lookWater(tx.water, row);
  ok(w !== tx.water && w.deep.some((v, i) => Math.abs(v - tx.water.deep[i]) > 1e-6), `${id}: water graded by the LOOK row (gap 6): deep ${w.deep.map(x => x.toFixed(3))}`);
  ok(!!row.path === e.path && !!row.snow === e.snow, `${id}: the table HAS path ${!!row.path} / snow ${!!row.snow} colours (the viewer does not use them: see the handover)`);
}
// Natural: a tag that names natural (a zone look only) → identity everywhere
const nat = demo('natural'); nat.look.renderRow = '';
ok(TL.rowFor(TL.readLook(nat), table) === null, 'natural / empty render row: identity (no layer, no water grade)');
// a tag spelled the client way (LookIds.Norm may keep the underscore) still finds the row
ok(TL.rowFor({ renderRow: 'sugar_snow' }, table) && TL.rowFor({ renderRow: 'Sugar Snow' }, table), 'sugar_snow found under either spelling');

// ── 3 · A BAKED LOOK (GltfExportAdapter.CaptureLookTag: WillBakeRecipe → baked = true, bakedLook = 'sugar_snow') ──────────
const baked = demo('sugar_snow'); baked.look.baked = true; baked.look.bakedLook = 'sugar_snow';
const bl = TL.readLook(baked), brow = TL.rowFor(bl, table);
ok(bl.baked === true && brow && brow.styleId === 'sugar_snow', 'baked: tag read, sugar_snow row found');
ok(!brow.render, 'sugar_snow has no render block: nothing to draw even before the baked rule');
ok(TL.lookWater(baked.water, brow) === baked.water, 'baked sugar_snow: the water block is the SAME object (water exactly as main)');
ok(brow.freezeWater === true, 'sugar_snow says freezeWater (the viewer does NOT draw ice yet: see the handover)');
// The guarantee for EVERY look the game can bake (WillBakeLookingGlass: an ink row with handTint · WillBakeRecipe: a materialRecipe):
// none carries a water row, so the one live step a baked file still runs (lookWater) returns its input untouched. If the client ever adds
// a water row to such a look, this fails and the baked = main promise must be re-read (index.html: the look.baked branch).
const bakeable = j.looks.filter(l => (l.render && String(l.render.mode).toLowerCase() === 'ink' && l.render.ink && l.render.ink.handTint) || l.materialRecipe);
ok(bakeable.length >= 5, `bakeable looks: ${bakeable.map(l => l.styleId).join(', ')}`);
ok(bakeable.every(l => !l.water), 'no bakeable look carries a water row → a baked file\'s water = main');

// ── the copy is the client's, byte for byte (when given the client path) ────────────────────────────────────────────────
const cp = process.env.THALYN_CLIENT_PALETTES;
if (cp) ok(fs.readFileSync(cp, 'utf8') === raw, `viewer copy == client ${cp}`);
else console.log('  (skip) THALYN_CLIENT_PALETTES not set - copy-vs-client check not run');

console.log(fail ? `${fail} FAIL of ${n}` : `ALL PASS (${n})`); process.exit(fail ? 1 : 0);
