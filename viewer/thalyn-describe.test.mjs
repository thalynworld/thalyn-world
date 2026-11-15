// ★ WORLD AS DATA · PHASE 0 bench: node viewer/thalyn-describe.test.mjs → ALL PASS. Pure: thalyn-describe.js + fixtures only.
// Fixtures: three REAL exports' extras.thalyn (extras_oct9 / extras_verge2 / extras_boats: read from the glb JSON chunk only, big base64 trimmed,
// arrays capped at 48, creator / worldName / postcard / creatorId redacted) + one synthetic new-shape document with deliberately bad entries.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeWorld, summarize, safeFileName, cleanText, SECTIONS, INTERACT_TYPES, DEFAULT_RULES } from './thalyn-describe.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = n => JSON.parse(readFileSync(join(here, 'describe-fixtures', n), 'utf8'));
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { ok ? passes++ : fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

// ── nothing / junk never throws ──
check('null → no doc', describeWorld(null).doc === null);
check('array → no doc', describeWorld([1, 2]).doc === null);
check('empty object reads as old extras', describeWorld({}).source === 'extras' && describeWorld({}).doc.schema === 1);

// ── real export 1: oct9 (the full block: living, grass, interiors, song, cinema) ──
{
  const tx = fx('extras_oct9.json');
  const r = describeWorld(tx);
  console.log('      ' + summarize(r));
  check('oct9: read as extras', r.source === 'extras');
  check('oct9: schema 1', r.doc.schema === 1);
  check('oct9: tone carried', r.doc.world.tone === tx.tone);
  check('oct9: seed carried', r.doc.world.seed === tx.seed);
  check('oct9: sizeTier from stats', r.doc.world.sizeTier === (tx.stats.sizeTier || ''));
  check('oct9: bounds center vec3', Array.isArray(r.doc.world.bounds.center) && r.doc.world.bounds.center.length === 3);
  check('oct9: interiors became files (role interior)', r.doc.files.length === tx.interiors.buildings.length && r.doc.files.every(f => f.role === 'interior'));
  check('oct9: lights surfaced from living', r.doc.lights.length === tx.living.lights.length);
  check('oct9: paths promoted from living.fauna', r.doc.paths.length === (tx.living.fauna.paths || []).length);
  check('oct9: living kept by reference (old readers unchanged)', r.doc.living === tx.living);
  check('oct9: grass kept (frame unity)', r.doc.grass && r.doc.grass.frame === 'unity');
  check('oct9: wind = the root atmosphere block', r.doc.atmosphere.wind === tx.atmosphere);
  check('oct9: cinema copied into interact iff present', r.doc.interact.filter(i => i.type === 'cinema').length === (tx.cinema && tx.cinema.present ? 1 : 0));
  check('oct9: rules default to today\'s viewer', r.doc.rules.walkMps === 5 && r.doc.rules.runMps === 12 && r.doc.rules.fly === false && r.doc.rules.edit === false);
  check('oct9: no refusals on a real export', r.notes.length === 0, JSON.stringify(r.notes));
  check('oct9: input not mutated (keys same)', JSON.stringify(Object.keys(tx)) === JSON.stringify(Object.keys(fx('extras_oct9.json'))));
}

// ── real export 2: verge2 (Nov: grass verge, interiors) ──
{
  const tx = fx('extras_verge2.json');
  const r = describeWorld(tx);
  console.log('      ' + summarize(r));
  check('verge2: grass verge kept', r.doc.grass && 'verge' in r.doc.grass);
  check('verge2: files = interiors', r.doc.files.length === (tx.interiors ? tx.interiors.buildings.length : 0));
  check('verge2: every file name plain', r.doc.files.every(f => safeFileName(f.file) === f.file));
  check('verge2: anchors carried', r.doc.anchors.length === tx.anchors.length);
  check('verge2: song kept', !!r.doc.audio.song);
  check('verge2: no refusals', r.notes.length === 0, JSON.stringify(r.notes));
}

// ── real export 3: boats (a minimal block: floatsWeb + living.floats only) ──
{
  const tx = fx('extras_boats.json');
  const r = describeWorld(tx);
  console.log('      ' + summarize(r));
  check('boats: floats file listed (role floats)', r.doc.files.length === 1 && r.doc.files[0].role === 'floats' && r.doc.files[0].file === tx.floatsWeb.file);
  check('boats: living.floats kept', r.doc.living.floats.length === tx.living.floats.length);
  check('boats: missing sections are empty, not undefined', Array.isArray(r.doc.lights) && Array.isArray(r.doc.paths) && Array.isArray(r.doc.interact) && r.doc.grass === null);
  check('boats: no bounds → null', r.doc.world.bounds === null);
}

// ── a too-new section in an old block is skipped with a note ──
{
  const r = describeWorld({ version: '1', tone: 'Eerie', grass: { present: true, version: 7 }, interiors: { present: true, version: 2, buildings: [{ file: 'X.glb' }] } });
  check('old block: grass v7 skipped', r.doc.grass === null && r.notes.some(n => n.includes('skipped grass v7')));
  check('old block: interiors v2 skipped (no files)', r.doc.files.length === 0 && r.notes.some(n => n.includes('skipped interiors v2')));
}

// ── doors: a door row + doorsWeb become an interactable by COPY ──
{
  const tx = { version: '1', doors: [{ glbNode: 'Door_A', hinge: [1, 0, 2], openDeg: 95 }], doorsWeb: { version: 1, file: 'Doors_web.glb', bytes: 10 } };
  const r = describeWorld(tx);
  check('doors: one door interactable', r.doc.interact.length === 1 && r.doc.interact[0].type === 'door' && r.doc.interact[0].node === 'Door_A');
  check('doors: its file is the listed doors glb', r.doc.interact[0].file === 'Doors_web.glb' && r.doc.files.some(f => f.role === 'doors'));
  check('doors: the old row is untouched', tx.doors[0].openDeg === 95 && Object.keys(tx).length === 3);
}

// ── the synthetic new-shape document ──
{
  const r = describeWorld(fx('world.thalyn.synthetic.json'));
  console.log('      ' + summarize(r));
  for (const n of r.notes) console.log('        ' + n);
  const d = r.doc;
  check('doc: read as description', r.source === 'description');
  check('doc: spawn read', d.world.spawn && d.world.spawn.pos[2] === 3 && d.world.spawn.yawDeg === 90);
  check('doc: 3 good files kept', d.files.length === 3 && d.files.map(f => f.file).join() === 'World_web.glb,Interiors_001_web.glb,Kit_forest.glb');
  check('doc: ../ refused', r.notes.some(n => n.includes("refused file name '../escape.glb'")));
  check('doc: role script refused', r.notes.some(n => n.includes("refused file role 'script'")));
  check('doc: kit spaceship refused, oak kept', d.kit.length === 1 && d.kit[0].id === 'TMN-oak-01');
  check('doc: instances kept', d.instances.length === 1 && d.instances[0].count === 3);
  check('doc: light range clamped to 500', d.lights[0].range === 500);
  check('doc: light onAt disco dropped', d.lights[1].onAt === undefined && r.notes.some(n => n.includes("onAt 'disco'")));
  check('doc: zip kept (local)', d.interact.some(i => i.type === 'zip' && i.sync === 'local'));
  check('doc: door with a listed file kept', d.interact.some(i => i.type === 'door' && i.file === 'Interiors_001_web.glb'));
  check('doc: teleport refused (closed list)', !d.interact.some(i => i.id === 'bad:0') && r.notes.some(n => n.includes("type 'teleport'")));
  check('doc: seat naming an unlisted file refused', !d.interact.some(i => i.id === 'bad:1') && r.notes.some(n => n.includes('not in files')));
  check('doc: walkMps 99 clamped to 20', d.rules.walkMps === 20 && r.notes.some(n => n.includes('rules.walkMps 99 clamped to 20')));
  check('doc: jumpM carried', d.rules.jumpM === 1.2);
  check('doc: edit true refused', d.rules.edit === false && r.notes.some(n => n.includes('rules.edit true refused')));
  check('doc: allowed filtered to the closed list', d.rules.allowed.join() === 'zip,door');
  check('doc: grade v9 skipped', d.atmosphere.grade === null && r.notes.some(n => n.includes('skipped grade v9')));
  check('doc: stream cell keeps only listed plain files', d.stream.cells[0].files.join() === 'Kit_forest.glb');
  check('doc: unknown section named', r.notes.some(n => n.includes("unknown section 'futureThing'")) && !('futureThing' in d));
}

// ── phase 1: the client's spawn block (A16040) becomes world.spawn ──
{
  const r = describeWorld({ version: '1', spawn: { present: true, pos: [3, 4, 5], yawDeg: -90, source: 'server' } });
  check('spawn: read from extras', r.doc.world.spawn && r.doc.world.spawn.pos[1] === 4 && r.doc.world.spawn.yawDeg === -90);
  check('spawn: present false = null', describeWorld({ version: '1', spawn: { present: false, pos: [1, 2, 3] } }).doc.world.spawn === null);
  check('spawn: bad pos = null', describeWorld({ version: '1', spawn: { present: true, pos: [1, 'x', 3] } }).doc.world.spawn === null);
}

// ── a document from the future ──
{
  const r = describeWorld({ schema: 3, world: { tone: 'Joyful' } });
  check('schema 3: read, with a note', r.doc.world.tone === 'Joyful' && r.notes.some(n => n.includes('schema 3 is newer')));
}

// ── helpers ──
check('cleanText strips control chars + caps', cleanText('a\u0000b\nc' + 'x'.repeat(200), 10) === 'abcxxxxxxx');
check('safeFileName refuses folders, schemes, ..', [ 'a/b.glb', 'C:x.glb', '..glb', 'http://x', '' ].every(s => safeFileName(s) === null) && safeFileName('Ok_1.glb') === 'Ok_1.glb');
check('sections list starts with schema', SECTIONS[0] === 'schema' && SECTIONS.includes('interact'));
check('interact types closed list (9)', INTERACT_TYPES.length === 9);
check('default rules frozen', Object.isFrozen(DEFAULT_RULES));

console.log(fails === 0 ? `ALL PASS (${passes})` : `${fails} FAIL / ${passes} pass`);
process.exit(fails === 0 ? 0 : 1);
