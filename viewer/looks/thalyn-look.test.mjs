// ★ LOOK ENGINE slice 2 bench — node viewer/looks/thalyn-look.test.mjs → ALL PASS. Proves thalyn-look.js grades water exactly as the game's
// LookPalette.Grade, under the game's WaterStyle.IsNone rule, and is identity when the file carries no look (natural / older exports).
import * as TL from '../thalyn-look.js';
import fs from 'fs';
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };
const j = JSON.parse(fs.readFileSync(new URL('./LookPalettes.json', import.meta.url), 'utf8'));
const table = new Map(j.looks.map(l => [l.styleId.toLowerCase(), l]));
const water = { present: true, deep: [0.1, 0.3, 0.4], shallow: [0.3, 0.6, 0.6], clarity: 1, style: { hue: -1, strength: 0, effect: 'none', rainbow: false } };
ok(TL.readLook({}) === null && TL.readLook({ look: { version: 1 } }) !== null, 'readLook: absent → null, present → block');
ok(TL.rowFor({ renderRow: '' }, table) === null && TL.rowFor({ renderRow: 'natural' }, table) === null, 'natural / empty row → identity');
ok(TL.rowFor({ renderRow: 'rainglass' }, table) === null, 'a row this copy lacks → identity');
const row = TL.rowFor({ renderRow: 'goldenstorybook' }, table);
ok(row && row.water, 'goldenstorybook row found with a water channel');
const w = TL.lookWater(water, row);
// C# LookPalette.Grade by hand for deep: sat 1.05 then × [1.04,1.0,0.9]
const l = 0.2126 * 0.1 + 0.7152 * 0.3 + 0.0722 * 0.4, s = 1.05;
const exp = [(l + (0.1 - l) * s) * 1.04, (l + (0.3 - l) * s) * 1.0, (l + (0.4 - l) * s) * 0.9];
ok(w !== water && w.deep.every((v, i) => Math.abs(v - exp[i]) < 1e-12), `deep graded = LookPalette.Grade: ${w.deep.map(x => x.toFixed(4))}`);
ok(water.deep[0] === 0.1, 'the block itself is not mutated');
ok(TL.lookWater(water, null) === water, 'no row → the same water object (viewer exactly as before)');
const styled = { ...water, style: { hue: 0.6, strength: 0.75, effect: 'none', rainbow: false } };
ok(TL.lookWater(styled, row) === styled, "a player water style wins (the game's IsNone rule)");
ok(TL.lookWater({ ...water, style: { hue: -1, effect: 'neon' } }, row).deep === water.deep, 'an effect is a style too → no look grade');
ok(JSON.stringify(TL.grade([0.5, 0.5, 0.5], null, 1)) === '[0.5,0.5,0.5]', 'identity grade returns the input');
console.log(TL.describe({ sceneRecipeId: '', renderRow: 'goldenstorybook', byZone: [{ zone: 0 }, { zone: 2, recipeId: 'goldenstorybook', surface: 'goldenstorybook', form: 'goldenstorybook' }] }, row, ['water 3 material(s)']));
console.log(fail ? `${fail} FAIL of ${n}` : `ALL PASS (${n})`); process.exit(fail ? 1 : 0);
