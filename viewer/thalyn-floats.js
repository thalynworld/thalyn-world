// Thalyn® World Viewer — boats that float (A13570, client 3's A13225 export).
//
// A boat's hull is not in World_web: the export packs every floating hull into its own small file
// (extras.thalyn.floatsWeb.file, beside the world, nodes kept by name) in its REST pose, and lists the boats to draw.
// Each row in extras.thalyn.living.floats[] that names a node bobs and rocks gently on the water, out of step with
// the others (per-row phase); a listed node without a row is drawn still. Absent floatsWeb = an older export or no
// boats: World_web carries any hull static, exactly as before. Nothing glows.
import * as THREE from 'three';

const D2R = Math.PI / 180;

/** opts: { scene, getLoader(), prepare(group) } */
export function makeFloats(opts = {}) {
  const root = new THREE.Group(); root.name = 'Thalyn_Floats';
  if (opts.scene) opts.scene.add(root);
  let source = null, file = '', epoch = 0, boats = [], rollHz = 0.23, pitchHz = 0.37, frozen = false;
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();

  function setSource(s) { source = s || null; }
  function clear() {
    epoch++;
    root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && m.dispose && m.dispose()); });
    while (root.children.length) root.remove(root.children[0]);
    file = ''; boats = [];
  }
  function urlFor(name) {
    if (!source) return null;
    if (source.files) { const f = source.files.get(name); return f ? { url: URL.createObjectURL(f), blob: true } : null; }
    try { const m = new URL(source.url, location.href), r = new URL(name, m); r.search = m.search; return { url: r.href, blob: false }; } catch (e) { return null; }
  }
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /** tx = the world's extras.thalyn. Returns the number of hulls to draw (0 = nothing to load). */
  function adopt(tx) {
    clear();
    const fw = tx && tx.floatsWeb;
    if (!fw || typeof fw.file !== 'string' || !fw.file || !Array.isArray(fw.nodes) || !fw.nodes.length) return 0;
    file = fw.file; rollHz = num(fw.rollHz, 0.23); pitchHz = num(fw.pitchHz, 0.37);
    const want = new Set(fw.nodes.map(String));
    const rows = new Map();
    const lv = tx.living && Array.isArray(tx.living.floats) ? tx.living.floats : [];
    for (const r of lv) if (r && typeof r.node === 'string' && want.has(r.node))
      rows.set(r.node, { amp: num(r.amp, 0), freqA: num(r.freqA, 0.45), freqB: num(r.freqB, 0.31), tiltDeg: num(r.tiltDeg, 0), phase: num(r.phase, 0) });
    const src = urlFor(file);
    if (!src) { console.warn(`[thalyn-floats] ${file} ${source && source.files ? 'was not among the dropped files (drop the whole folder)' : 'has no address'} — the boats are missing`); return want.size; }
    const loader = opts.getLoader && opts.getLoader(); if (!loader) return want.size;
    const my = epoch;
    loader.loadAsync(src.url).then(g => {
      if (src.blob) URL.revokeObjectURL(src.url);
      if (my !== epoch) return;
      try { if (opts.prepare) opts.prepare(g.scene); } catch (e) {}
      // Draw exactly the listed FloatHull_ nodes (with their hull children); hide anything else in the file.
      let drawn = 0, still = 0;
      const found = new Map();
      g.scene.traverse(o => { if (want.has(o.name) && !found.has(o.name)) found.set(o.name, o); });
      for (const c of [...g.scene.children]) if (!want.has(c.name)) { let keep = false; c.traverse(o => { if (want.has(o.name)) keep = true; }); if (!keep) c.visible = false; }
      for (const [name, node] of found) {
        const row = rows.get(name);
        drawn++; if (!row) still++;
        if (row) boats.push({ node, row, restY: node.position.y, restQ: node.quaternion.clone() });
      }
      root.add(g.scene);
      console.info(`[thalyn-floats] A13570 ${drawn}/${want.size} boat hull(s) from ${file} · ${boats.length} bobbing, ${still} still` + (drawn < want.size ? ` · missing: ${[...want].filter(n => !found.has(n)).join(', ')}` : ''));
    }).catch(e => { if (src.blob) URL.revokeObjectURL(src.url); console.warn(`[thalyn-floats] ${file} could not be loaded — the boats are missing`, e); });
    return want.size;
  }

  /** t = seconds. Under "reduce motion" the boats rest still. */
  function tick(t) {
    if (!boats.length) return;
    for (const b of boats) {
      const r = b.row;
      if (frozen) { b.node.position.y = b.restY; b.node.quaternion.copy(b.restQ); continue; }
      const bob = (Math.sin(2 * Math.PI * r.freqA * t + r.phase) * 0.6 + Math.sin(2 * Math.PI * r.freqB * t + 1.7 * r.phase) * 0.4) * r.amp;
      const roll = Math.sin(2 * Math.PI * rollHz * t + 1.3 * r.phase) * r.tiltDeg;
      const pitch = Math.sin(2 * Math.PI * pitchHz * t + 0.7 * r.phase) * 0.6 * r.tiltDeg;
      b.node.position.y = b.restY + bob;
      // Unity tilts in the boat root's frame; the X mirror into glTF flips the roll's sign, pitch keeps its sign.
      b.node.quaternion.copy(b.restQ).multiply(_q.setFromEuler(_e.set(pitch * D2R, 0, -roll * D2R, 'YXZ')));
    }
  }
  function forEachMaterial(fn) { root.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && fn(m)); }); }
  return {
    root, adopt, setSource, clear, tick, forEachMaterial,
    setFrozen(on) { frozen = !!on; },
    get fileName() { return file; }, get count() { return boats.length; },
  };
}
