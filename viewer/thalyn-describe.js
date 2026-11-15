// ★ WORLD AS DATA · PHASE 0 (client 2, 2026-11-15) · the World Description READER.
// Design: client repo Core Designs/WORLD_AS_DATA_WEB_RECREATION_DESIGN_NOV15_2026.md §2-§3; schema: Core Designs/WORLD_DESCRIPTION_SCHEMA_V1.schema.json;
// key-by-key mapping of today's block: Core Designs/WORLD_DESCRIPTION_INVENTORY_NOV15_2026.md.
// PURE (no three.js, no DOM, no fetch), so node tests it: node viewer/thalyn-describe.test.mjs.
//
// describeWorld(input) takes EITHER a World Description document (has an integer `schema`) OR today's glb root extras.thalyn (flat, version "1")
// and returns ONE normalised object in the new shape + `notes` (one line per thing skipped, clamped or refused). It never throws on bad data.
// Nothing in the viewer reads it yet: phase 0 is the contract; later phases switch modules over one at a time.
//
// The rules it enforces (design §7 "Security"): data only · closed `type` / `role` lists (anything else refused) · every number finite and clamped ·
// text cleaned (control characters out, length capped) · file names relative and plain (no folder, no '..', no scheme) and an interactable / kit /
// cell may name only a file listed in `files` · a section it does not know, or whose `version` is above what it understands, is skipped with a note.

export const SCHEMA = 1;

/** Section versions this reader understands (a higher one is skipped, not guessed at). */
export const KNOWN_VERSIONS = { grass: 1, zones: 1, interiors: 1, doorsWeb: 1, floatsWeb: 1, song: 1, grade: 1, skyDome: 1, water: 1, interact: 1, dayCurve: 1, kit: 1, instances: 1, stream: 1 };

/** The document's top-level sections (schema v1). Anything else is kept out and named in a note. */
export const SECTIONS = ['schema', 'world', 'files', 'atmosphere', 'look', 'kit', 'instances', 'water', 'paths', 'lights', 'living', 'interact', 'audio', 'rules',
  'stream', 'grass', 'anchors', 'card', 'stats', 'substrate'];

export const INTERACT_TYPES = ['door', 'zip', 'rope', 'seat', 'lamp', 'boat', 'balloon', 'swing', 'cinema'];
export const FILE_ROLES = ['world', 'lite', 'interior', 'doors', 'floats', 'kit', 'chunk', 'audio'];
export const KIT_CLASSES = ['tree', 'rock', 'shrub', 'flower', 'deadwood', 'prop'];
export const ON_AT = ['always', 'night', 'switch'];

/** Today's viewer numbers (thalyn-atmos.js makeWalk); jump + gravity are PROPOSED (phase 1 adds the body - there is no jump today). */
// ★ phase 2 (11-15, Mike: zip wire, seats, rope, lamps, BOATS; NO balloon, NO world views): the ride types join doors + the cinema. 'balloon' / 'swing' stay out.
export const DEFAULT_RULES = Object.freeze({ walkMps: 5, runMps: 12, jumpM: 1.1, gravity: 9.81, eyeM: 1.7, stepUpM: 0.6, swim: true, fly: false, allowed: ['door', 'cinema', 'zip', 'seat', 'rope', 'boat', 'lamp'], edit: false });
const RULE_RANGE = { walkMps: [0.5, 20], runMps: [1, 40], jumpM: [0, 5], gravity: [0, 30], eyeM: [0.3, 3], stepUpM: [0, 1.5] };

// ── small pure helpers ──
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export function cleanText(s, max = 80) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp('[\u0000-\u001f\u007f\u2028\u2029]', 'g'), '').trim().slice(0, max);
}
export function safeFileName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes('..') ? s : null;
}
const vec3 = v => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(finite) ? v.slice(0, 3) : null;
const rgb = v => { const c = vec3(v); return c ? c.map(x => clamp(x, 0, 64)) : null; };
const num = (v, lo, hi, d) => finite(v) ? clamp(v, lo, hi) : d;
const versionOf = b => isObj(b) ? (finite(b.version) ? b.version : (typeof b.version === 'string' && /^\d+$/.test(b.version) ? +b.version : 1)) : 1;

/** A section too new for this reader: skipped (null) with a note. Absent or not an object: null, quietly. */
function versioned(name, block, notes) {
  if (!isObj(block)) return null;
  const known = KNOWN_VERSIONS[name];
  if (known != null && versionOf(block) > known) { notes.push(`[describe] skipped ${name} v${versionOf(block)} (this viewer reads up to v${known})`); return null; }
  return block;
}

// ── normalise one shape into the document ──
function fromExtras(tx, notes) {
  // today's flat glb block (GltfAtmosphereExtras.Block flattened by GlbMerger.ExtractLivingLayerExtras + interiors / doors / doorsWeb / floatsWeb / card)
  const sub = isObj(tx.substrate) ? tx.substrate : {};
  const stats = isObj(tx.stats) ? tx.stats : {};
  const living = isObj(tx.living) ? tx.living : null;
  const fauna = living && isObj(living.fauna) ? living.fauna : null;
  const doc = {
    schema: SCHEMA,
    world: {
      worldId: cleanText(sub.worldId, 64), seed: Number.isInteger(tx.seed) ? tx.seed : (Number.isInteger(sub.seed) ? sub.seed : 0),
      tone: cleanText(tx.tone, 32), sizeTier: cleanText(stats.sizeTier, 32), worldName: cleanText(tx.worldName, 80), sceneName: cleanText(tx.sceneName, 80),
      creator: cleanText(tx.creator, 40), postcard: cleanText(tx.postcard, 64), exportedAt: cleanText(tx.exportedAt, 40),
      timeOfDay: num(tx.timeOfDay, -1, 1, -1), clock: cleanText(tx.clock, 8), weather: cleanText(tx.weather, 32),
      bounds: isObj(tx.bounds) && tx.bounds.present !== false ? { center: vec3(tx.bounds.center), radius: num(tx.bounds.radius, 0, 1e6, 0), minY: num(tx.bounds.minY, -1e5, 1e5, 0), maxY: num(tx.bounds.maxY, -1e5, 1e5, 0) } : null,
      camera: isObj(tx.camera) && tx.camera.present !== false ? tx.camera : null,
      // ★ phase 1: the client's A16040 extras.thalyn.spawn (the app's own GAP-7 landing, glTF frame) - absent / present:false on older exports
      spawn: isObj(tx.spawn) && tx.spawn.present === true && vec3(tx.spawn.pos) ? { pos: vec3(tx.spawn.pos), yawDeg: num(tx.spawn.yawDeg, -720, 720, 0) } : null,
    },
    files: [],
    atmosphere: { sky: isObj(tx.sky) ? tx.sky : null, fog: isObj(tx.fog) ? tx.fog : null, nightSky: isObj(tx.nightSky) ? tx.nightSky : null,
      skyDome: versioned('skyDome', tx.skyDome, notes), grade: versioned('grade', tx.grade, notes), zones: versioned('zones', tx.zones, notes),
      water: versioned('water', tx.water, notes), wind: isObj(tx.atmosphere) ? tx.atmosphere : null,
      // ★ phase 2: the client's extras.thalyn.dayCurve (TimeOfDayModifier keyframes + SunArc + the lamp ramp; thalyn-clock.js readDayCurve cleans it)
      dayCurve: isObj(tx.dayCurve) && tx.dayCurve.present === true ? versioned('dayCurve', tx.dayCurve, notes) : null },
    look: isObj(tx.look) ? tx.look : null,
    kit: [], instances: [],
    water: { liquids: Array.isArray(tx.liquids) ? tx.liquids.filter(isObj) : [], tone: isObj(tx.water) ? tx.water : null, bodies: [] },
    paths: fauna && Array.isArray(fauna.paths) ? fauna.paths : [],
    lights: living && Array.isArray(living.lights) ? living.lights : [],
    living,
    interact: [],
    audio: { song: versioned('song', tx.song, notes), beds: [] },
    rules: null,
    stream: null,
    grass: versioned('grass', tx.grass, notes),
    anchors: Array.isArray(tx.anchors) ? tx.anchors.filter(isObj) : [],
    card: isObj(tx.card) ? tx.card : null,
    stats: isObj(tx.stats) ? tx.stats : null,
    substrate: isObj(tx.substrate) ? tx.substrate : null,
  };
  // files: the side glbs today's block already names (interiors, doors, floats)
  const interiors = versioned('interiors', tx.interiors, notes);
  if (interiors && Array.isArray(interiors.buildings))
    for (const b of interiors.buildings) if (isObj(b)) doc.files.push({ role: 'interior', file: b.file, bytes: b.bytes, tris: b.tris, building: b.building });
  const doorsWeb = versioned('doorsWeb', tx.doorsWeb, notes);
  if (doorsWeb && doorsWeb.file) doc.files.push({ role: 'doors', file: doorsWeb.file, bytes: doorsWeb.bytes });
  const floatsWeb = versioned('floatsWeb', tx.floatsWeb, notes);
  if (floatsWeb && floatsWeb.file && !doc.files.some(f => f.file === floatsWeb.file)) doc.files.push({ role: 'floats', file: floatsWeb.file, bytes: floatsWeb.bytes });
  // interact: doors and the cinema by COPY (their rows stay where they are for old readers)
  if (Array.isArray(tx.doors))
    tx.doors.forEach((d, i) => { if (isObj(d)) doc.interact.push({ id: `door:${i}`, type: 'door', node: d.glbNode || d.node, file: doorsWeb ? doorsWeb.file : undefined, anchor: d.center || d.hinge, params: d, sync: 'shared' }); });
  // ★ phase 2: the client's extras.thalyn.interact typed rows (Unity GltfInteractExtras.cs) -> interact[] items. Anchors: the zip's high post, the seat,
  // the rope foot, the boat's root. `sync`: boats shared (visit-together host wins), the rest local (design §4).
  const ix = isObj(tx.interact) && tx.interact.present === true ? versioned('interact', tx.interact, notes) : null;
  if (ix) {
    const rows = (k, type, anchor, reach, prompt, sync) => { for (const r of Array.isArray(ix[k]) ? ix[k] : []) if (isObj(r)) doc.interact.push({ id: r.id, type, anchor: r[anchor], reachM: r[reach], prompt, params: r, sync }); };
    rows('zips', 'zip', 'highBase', 'highRangeM', 'ride the zip wire', 'local');
    rows('seats', 'seat', 'seat', 'reachM', 'sit', 'local');
    rows('ropes', 'rope', 'foot', 'rangeM', 'climb the rope', 'local');
    rows('boats', 'boat', 'pos', 'boardRangeM', 'board the rowboat', 'shared');
  }
  if (isObj(tx.cinema) && tx.cinema.present === true)
    doc.interact.push({ id: 'cinema:0', type: 'cinema', anchor: tx.cinema.position, params: { facing: tx.cinema.facing, yawDeg: tx.cinema.yawDeg, pitchDeg: tx.cinema.pitchDeg, width: tx.cinema.width, height: tx.cinema.height, floating: tx.cinema.floating }, sync: 'shared' });
  return doc;
}

function fromDocument(d, notes) {
  if (finite(d.schema) && d.schema > SCHEMA) notes.push(`[describe] document schema ${d.schema} is newer than this viewer (${SCHEMA}): known sections read, the rest skipped`);
  for (const k of Object.keys(d)) if (!SECTIONS.includes(k)) notes.push(`[describe] skipped unknown section '${cleanText(k, 40)}'`);
  const doc = { schema: SCHEMA };
  for (const k of SECTIONS) if (k !== 'schema') doc[k] = d[k];
  doc.world = isObj(d.world) ? { ...d.world, worldName: cleanText(d.world.worldName, 80), creator: cleanText(d.world.creator, 40), tone: cleanText(d.world.tone, 32),
    timeOfDay: num(d.world.timeOfDay, -1, 1, -1), spawn: isObj(d.world.spawn) ? { pos: vec3(d.world.spawn.pos), yawDeg: num(d.world.spawn.yawDeg, -720, 720, 0) } : null } : {};
  for (const k of ['grass', 'stream']) doc[k] = versioned(k, d[k], notes);
  if (isObj(doc.atmosphere)) for (const k of ['grade', 'zones', 'skyDome', 'water']) doc.atmosphere[k] = versioned(k, doc.atmosphere[k], notes);
  if (isObj(doc.audio)) doc.audio.song = versioned('song', doc.audio.song, notes);
  return doc;
}

// ── shared validation of the NEW-shape fields (both inputs end here) ──
function validate(doc, notes) {
  // files: closed roles, plain names, no duplicates
  const files = [], seen = new Set();
  for (const f of Array.isArray(doc.files) ? doc.files : []) {
    if (!isObj(f)) continue;
    const name = safeFileName(f.file);
    if (!name) { notes.push(`[describe] refused file name '${cleanText(String(f.file), 60)}'`); continue; }
    if (!FILE_ROLES.includes(f.role)) { notes.push(`[describe] refused file role '${cleanText(String(f.role), 20)}' (${name})`); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    files.push({ role: f.role, file: name, bytes: num(f.bytes, 0, 4e9, 0), tris: num(f.tris, 0, 2e9, 0), ...(f.building ? { building: cleanText(f.building, 80) } : {}), ...(f.sha ? { sha: cleanText(f.sha, 80) } : {}) });
  }
  doc.files = files;
  const listed = name => name == null || seen.has(name);
  // interact: closed types, files only from `files`, numbers clamped, prompt cleaned
  const inter = [];
  for (const it of Array.isArray(doc.interact) ? doc.interact : []) {
    if (!isObj(it)) continue;
    if (!INTERACT_TYPES.includes(it.type)) { notes.push(`[describe] refused interactable type '${cleanText(String(it.type), 20)}'`); continue; }
    const file = it.file == null ? undefined : safeFileName(it.file);
    if (it.file != null && (!file || !listed(file))) { notes.push(`[describe] refused ${it.type} '${cleanText(String(it.id), 40)}': file '${cleanText(String(it.file), 60)}' is not in files`); continue; }
    inter.push({ id: cleanText(String(it.id ?? `${it.type}:${inter.length}`), 64), type: it.type, node: it.node != null ? cleanText(String(it.node), 128) : undefined, file,
      anchor: vec3(it.anchor), reachM: num(it.reachM, 0, 20, 2), prompt: cleanText(it.prompt, 60), params: isObj(it.params) ? it.params : {}, state: it.state,
      sync: it.sync === 'local' ? 'local' : 'shared' });
  }
  doc.interact = inter;
  // kit + instances: closed classes, listed files
  doc.kit = (Array.isArray(doc.kit) ? doc.kit : []).filter(k => {
    if (!isObj(k) || !cleanText(k.id, 64)) return false;
    if (!KIT_CLASSES.includes(k.class)) { notes.push(`[describe] refused kit class '${cleanText(String(k.class), 20)}' (${cleanText(k.id, 64)})`); return false; }
    if (k.file != null && !listed(safeFileName(k.file))) { notes.push(`[describe] refused kit '${cleanText(k.id, 64)}': file not in files`); return false; }
    return true;
  });
  doc.instances = (Array.isArray(doc.instances) ? doc.instances : []).filter(t => isObj(t) && cleanText(t.kit, 64) && ['base64-f32', 'base64-i16q'].includes(t.encoding))
    .map(t => ({ ...t, count: Math.trunc(num(t.count, 0, 2e6, 0)) }));
  // lights: new optional fields clamped / closed
  doc.lights = (Array.isArray(doc.lights) ? doc.lights : []).filter(isObj).map(l => {
    const o = { ...l };
    if (l.onAt === '') delete o.onAt;   // JsonUtility writes "" for an unstamped light (gate Thalyn_GltfDayCurve off): absent, not an error
    else if (l.onAt != null && !ON_AT.includes(l.onAt)) { delete o.onAt; notes.push(`[describe] light onAt '${cleanText(String(l.onAt), 20)}' ignored`); }
    if (l.range != null) o.range = num(l.range, 0, 500, 0);
    if (l.intensity != null) o.intensity = num(l.intensity, 0, 1e4, 0);
    if (l.color != null) o.color = rgb(l.color) || [1, 1, 1];
    return o;
  });
  // rules: defaults = today's viewer, every number clamped, edit always false, allowed ⊂ the closed list
  const r = isObj(doc.rules) ? doc.rules : {};
  const rules = { ...DEFAULT_RULES };
  for (const [k, [lo, hi]] of Object.entries(RULE_RANGE)) if (r[k] != null) { const v = num(r[k], lo, hi, DEFAULT_RULES[k]); if (finite(r[k]) && v !== r[k]) notes.push(`[describe] rules.${k} ${r[k]} clamped to ${v}`); rules[k] = v; }
  if (typeof r.swim === 'boolean') rules.swim = r.swim;
  if (typeof r.fly === 'boolean') rules.fly = r.fly;
  if (Array.isArray(r.allowed)) rules.allowed = r.allowed.filter(t => INTERACT_TYPES.includes(t));
  if (r.edit === true) notes.push('[describe] rules.edit true refused (a visitor never edits)');
  rules.edit = false;
  doc.rules = rules;
  // stream cells may name only listed files
  if (isObj(doc.stream) && Array.isArray(doc.stream.cells))
    doc.stream = { ...doc.stream, cells: doc.stream.cells.filter(c => isObj(c)).map(c => ({ ...c, files: (Array.isArray(c.files) ? c.files : []).map(safeFileName).filter(f => f && listed(f)) })) };
  for (const k of ['paths', 'anchors']) if (!Array.isArray(doc[k])) doc[k] = [];
  return doc;
}

/** THE entry point. Never throws. */
export function describeWorld(input) {
  const notes = [];
  if (!isObj(input)) return { doc: null, source: 'none', notes: ['[describe] nothing to read'] };
  let source, doc;
  try {
    if (Number.isInteger(input.schema)) { source = 'description'; doc = fromDocument(input, notes); }
    else { source = 'extras'; doc = fromExtras(input, notes); }
    doc = validate(doc, notes);
  } catch (e) {
    return { doc: null, source: 'error', notes: [`[describe] could not read the description (${cleanText(String(e && e.message), 120)})`] };
  }
  return { doc, source, notes };
}

/** One console line: what the description holds (for the ?debug read-out later). */
export function summarize(res) {
  if (!res || !res.doc) return '[describe] no description';
  const d = res.doc;
  const living = d.living || {};
  return `[describe] schema ${d.schema} from ${res.source}: ${d.files.length} file(s) · ${d.interact.length} interactable(s) (${[...new Set(d.interact.map(i => i.type))].join('/') || 'none'})`
    + ` · ${d.lights.length} light(s) · ${d.paths.length} path(s) · ${(living.waterfalls || []).length} fall(s) · grass ${d.grass && d.grass.present ? 'yes' : 'no'}`
    + ` · ${d.kit.length} kit / ${d.instances.length} instance table(s)${res.notes.length ? ` · ${res.notes.length} note(s)` : ''}`;
}
