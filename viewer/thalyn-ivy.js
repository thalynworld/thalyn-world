// ★ A5389 · THE IVY, IN THE BROWSER (glTF web budget phase 3 — "only what the game thins may thin", 2026-10-08).
//
// The game's ivy (Overgrowth, ThalynOvergrowth.shader) is one static mesh per spatial cell with a DISTANCE LOD in the
// vertex shader: past _LodNear a card collapses onto its anchor once its per-card random key is below the distance
// fraction, stems lose their twigs first (trunks keep to the far line), leaf MATS never thin; and a whole cell is
// switched off past the tier's sleep distance (Overgrowth.ApplyVisibility). gltfpack merges every same-material mesh
// into one, so World_web.glb arrives as ONE ivy mesh with neither the cells nor the anchors. This module puts both back:
//
//   · the key — the export writes it per vertex (OvergrowthMeshBuilder.LodKey → TEXCOORD_1 → COLOR_0.a of the web copy,
//     GlbMerger.KeyOvergrowthLod); every corner of a card shares it. COLOR_0.a is NOT a colour here (the patch ignores it);
//   · the anchor — each connected piece (a card, a stem strand) collapses onto its own centroid, so a card is never cut
//     in two (the game's petiole and the card centre are centimetres apart; distance-wise the same);
//   · the cells — pieces are binned into CELL m cells by centroid; each cell is its own draw over SHARED vertex buffers
//     (one upload), so frustum culling and the tier's distance cull drop whole cells, as in the game.
//
// Numbers are the game's: ivy thins 60 → 130 m, cobweb 30 → 79.5 m (Overgrowth.cs MaterialFor: SleepBeyondM 150 ×
// 0.40/0.867, ×0.20/0.53). Per tier (TIERS in thalyn-atmos.js): ivyCull = 150 × TierReachMul (1 / 0.85 / 0.6) and
// ivyKeep = 1 − TierTriMul (0 / 0.4 / 0.65 — Medium and Low build 60 % and 35 % of the cards; the key is a uniform
// random, so keeping key ≥ ivyKeep keeps that share, with trunks and mats untouched as the game's even stride keeps them).
// A file exported before A5388 has alpha 1 everywhere: no thinning, cells + the cull only — it never looks worse.
import * as THREE from 'three';

const IVY_MAT = /^Thalyn_Overgrowth_/;
const CELL = 16;   // metres (object frame). The game: clamp(host height / 4, 8, 24).
const LOD = { Cobweb: [30, 79.5], default: [60, 130] };

const VERT_HEAD = 'attribute vec3 aIvyAnchor;\nuniform float uIvyNear;\nuniform float uIvyFar;\nuniform float uIvyKeepMin;\n';
// ThalynReveal's distance LOD, verbatim, plus the tier floor: keep = step(lodT, key) · step(keepMin, key).
const vertBody = keyExpr => `
  {
    vec3 _ivyA = (modelMatrix * vec4(aIvyAnchor, 1.0)).xyz;
    float _ivyT = clamp((distance(cameraPosition, _ivyA) - uIvyNear) / max(1.0, uIvyFar - uIvyNear), 0.0, 1.0);
    float _ivyK = ${keyExpr};
    float _ivyKeep = step(_ivyT, _ivyK) * step(uIvyKeepMin, _ivyK);
    transformed = aIvyAnchor + (transformed - aIvyAnchor) * _ivyKeep;
  }`;

function hash01(n) { n = Math.imul(n ^ 61 ^ (n >>> 16), 9); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; }

export function makeIvy() {
  const U = { near: { value: 60 }, far: { value: 130 }, keepMin: { value: 0 } };
  const UWeb = { near: { value: 30 }, far: { value: 79.5 }, keepMin: { value: 0 } };
  let cells = [];             // { mesh, c: Vector3 (world), r, tris }
  let keyHist = null;         // Float64Array(256): vertices per key byte (for the "kept" share)
  let keyed = false, totalTris = 0, totalVerts = 0, srcMeshes = 0;
  let cull = 150, tierName = '', drawn = 0, drawnTris = 0, tierKeep = 0;
  let liteSrc = false;        // World_web_lite.glb: gltfpack -si 0.35 already cut the ivy to the Low share — never thin twice
  const _v = new THREE.Vector3();

  function patchMaterial(src, Uni, hasAlpha) {
    const m = src.clone();
    m.name = src.name;
    m.onBeforeCompile = sh => {
      sh.uniforms.uIvyNear = Uni.near; sh.uniforms.uIvyFar = Uni.far; sh.uniforms.uIvyKeepMin = Uni.keepMin;
      sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>' + vertBody(hasAlpha ? '\n#ifdef USE_COLOR_ALPHA\n color.a\n#else\n 1.0\n#endif\n' : '1.0'));
      // COLOR_0.a carries the LOD key, not an opacity: colour the rgb only (the MASK cut stays the texture's).
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
        '#if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )\n diffuseColor.rgb *= vColor.rgb;\n#endif');
    };
    m.customProgramCacheKey = () => 'thalyn-ivy-v1-' + (hasAlpha ? 'k' : 'n');
    m.needsUpdate = true;
    // The game runs the rule in EVERY pass ("shadows and depth thin with the look") — the shadow pass too.
    const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: m.map || null, alphaTest: m.alphaTest > 0 ? m.alphaTest : 0, side: m.side });
    d.onBeforeCompile = sh => {
      sh.uniforms.uIvyNear = Uni.near; sh.uniforms.uIvyFar = Uni.far; sh.uniforms.uIvyKeepMin = Uni.keepMin;
      sh.vertexShader = VERT_HEAD + (hasAlpha ? 'attribute vec4 color;\n' : '') +
        sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>' + vertBody(hasAlpha ? 'color.a' : '1.0'));
    };
    d.customProgramCacheKey = () => 'thalyn-ivy-depth-v1-' + (hasAlpha ? 'k' : 'n');
    return { m, d };
  }

  // Split one merged ivy mesh into cells over shared buffers. Returns the number of cells made.
  function splitMesh(mesh, opts) {
    const g = mesh.geometry, pos = g.attributes.position, col = g.attributes.color;
    if (!g.index || !pos) return 0;
    const n = pos.count, idx = g.index.array, triN = idx.length / 3;
    // ── connected pieces (union-find over the index) ──
    const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
    const find = x => { let r = x; while (par[r] !== r) r = par[r]; while (par[x] !== r) { const nx = par[x]; par[x] = r; x = nx; } return r; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]);
      if (b !== a) par[b] = a;
      if (c !== a && c !== b) par[c] = a;
    }
    const sum = new Float32Array(n * 3), cnt = new Uint32Array(n), root = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const r = find(i); root[i] = r; cnt[r]++;
      sum[r * 3] += pos.getX(i); sum[r * 3 + 1] += pos.getY(i); sum[r * 3 + 2] += pos.getZ(i);
    }
    const anchor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = root[i], k = 1 / cnt[r]; anchor[i * 3] = sum[r * 3] * k; anchor[i * 3 + 1] = sum[r * 3 + 1] * k; anchor[i * 3 + 2] = sum[r * 3 + 2] * k; }
    const aAttr = new THREE.BufferAttribute(anchor, 3);

    // ── the key: present when COLOR_0.a is not 1 everywhere (an A5388+ export) ──
    let hasAlpha = !!(col && col.itemSize === 4), isKeyed = false;
    if (hasAlpha) {
      for (let i = 0; i < n; i++) if (col.getW(i) < 0.995) { isKeyed = true; break; }
      if (!isKeyed && opts.fakeKeys) {   // ?ivytest=1 on an older file: a per-piece random key, to SEE the thinning (not the game's keys)
        for (let i = 0; i < n; i++) col.setW(i, hash01(root[i] + 7));
        col.needsUpdate = true; isKeyed = true;
        console.info('[thalyn-ivy] ivytest: fake per-piece keys on an unkeyed file — a test aid, not parity');
      }
      if (isKeyed) for (let i = 0; i < n; i++) keyHist[Math.min(255, Math.round(col.getW(i) * 255))]++;
    }
    keyed = keyed || isKeyed;

    // ── cells by piece centroid ──
    const cellOf = new Map(); const triCell = new Int32Array(triN); const counts = [];
    for (let t = 0; t < triN; t++) {
      const r = root[idx[t * 3]];
      const key = Math.floor(anchor[r * 3] / CELL) + ',' + Math.floor(anchor[r * 3 + 1] / CELL) + ',' + Math.floor(anchor[r * 3 + 2] / CELL);
      let c = cellOf.get(key);
      if (c === undefined) { c = counts.length; cellOf.set(key, c); counts.push(0); }
      triCell[t] = c; counts[c]++;
    }
    const big = n > 65535;
    const lists = counts.map(k => big ? new Uint32Array(k * 3) : new Uint16Array(k * 3)), fill = new Int32Array(counts.length);
    for (let t = 0; t < triN; t++) { const c = triCell[t], o = fill[c]; const L = lists[c]; L[o] = idx[t * 3]; L[o + 1] = idx[t * 3 + 1]; L[o + 2] = idx[t * 3 + 2]; fill[c] = o + 3; }

    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    const src = mats[0];
    const web = /Cobweb/i.test(src.name || '');
    const { m, d } = patchMaterial(src, web ? UWeb : U, hasAlpha);
    const parent = mesh.parent;
    mesh.updateMatrixWorld(true);
    const sx = mesh.matrixWorld.getMaxScaleOnAxis();
    for (let c = 0; c < lists.length; c++) {
      const cg = new THREE.BufferGeometry();
      for (const name in g.attributes) cg.setAttribute(name, g.attributes[name]);
      cg.setAttribute('aIvyAnchor', aAttr);
      cg.setIndex(new THREE.BufferAttribute(lists[c], 1));
      // bounding sphere of this cell's vertices
      const L = lists[c]; const box = new THREE.Box3();
      for (let i = 0; i < L.length; i++) { _v.fromBufferAttribute(pos, L[i]); box.expandByPoint(_v); }
      const sph = new THREE.Sphere(); box.getCenter(sph.center);
      let r2 = 0; for (let i = 0; i < L.length; i++) { _v.fromBufferAttribute(pos, L[i]); r2 = Math.max(r2, _v.distanceToSquared(sph.center)); }
      sph.radius = Math.sqrt(r2); cg.boundingSphere = sph; cg.boundingBox = box;
      const cm = new THREE.Mesh(cg, m);
      cm.name = (mesh.name || 'Ivy') + '_cell' + c;
      cm.position.copy(mesh.position); cm.quaternion.copy(mesh.quaternion); cm.scale.copy(mesh.scale);
      cm.castShadow = mesh.castShadow; cm.receiveShadow = mesh.receiveShadow;
      cm.customDepthMaterial = d;
      cm.userData.__ivy = true;
      parent.add(cm);
      cm.updateMatrixWorld(true);
      cells.push({ mesh: cm, c: sph.center.clone().applyMatrix4(cm.matrixWorld), r: sph.radius * sx, tris: L.length / 3 });
    }
    parent.remove(mesh);   // never dispose its geometry: the cells share its attribute buffers
    totalTris += triN; totalVerts += n; srcMeshes++;
    return lists.length;
  }

  // Additive: a multi-file load adopts each file's ivy in turn; clear() forgets them all (a new world).
  function adopt(root, opts = {}) {
    if (!keyHist) keyHist = new Float64Array(256);
    if (opts.lite) liteSrc = true;
    const found = [];
    root.traverse(o => {
      if (!o.isMesh || o.userData.__ivy || !o.geometry) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length === 1 && mats[0] && IVY_MAT.test(mats[0].name || '')) found.push(o);
    });
    const t0 = performance.now();
    for (const o of found) { try { splitMesh(o, opts); } catch (e) { console.warn('[thalyn-ivy] split failed for', o.name, e); } }
    if (found.length) { const k = liteSrc ? 0 : tierKeep; U.keepMin.value = k; UWeb.keepMin.value = k; }
    if (found.length) report('adopted ' + found.length + ' ivy mesh(es) → ' + cells.length + ' cells in ' + (performance.now() - t0).toFixed(0) + ' ms');
    return cells.length;
  }

  function keptShare() {
    if (!keyed || !keyHist) return 1;
    let all = 0, kept = 0; const kb = Math.round(U.keepMin.value * 255);
    for (let i = 0; i < 256; i++) { all += keyHist[i]; if (i >= kb) kept += keyHist[i]; }
    return all ? kept / all : 1;
  }

  function report(why) {
    if (!cells.length) return;
    console.info(`[thalyn-ivy] tier=${tierName || '?'} far=${U.far.value} m (thins from ${U.near.value} m) cull=${cull} m ` +
      `kept=${(keptShare() * 100).toFixed(0)} % of ${keyed ? 'keyed' : 'UNKEYED (pre-A5388 export: no thinning, cells + cull only)'} vertices · ` +
      `${cells.length} cells · ${(totalTris / 1e6).toFixed(2)} M tris · ${why}`);
  }

  function setBudget(t, name) {
    tierName = name || tierName;
    cull = (t && t.ivyCull) || 150;
    tierKeep = (t && t.ivyKeep) || 0;
    const k = liteSrc ? 0 : tierKeep;
    U.keepMin.value = k; UWeb.keepMin.value = k;
    report('budget' + (liteSrc && tierKeep > 0 ? ' (lite copy: its simplifier already kept ~35 % — the tier floor is not applied twice)' : ''));
  }

  let frame = 0;
  function tick(camera) {
    if (!cells.length) return;
    if ((frame++ & 3) !== 0) return;   // the game housekeeps on a timer too; four frames is plenty
    const p = camera.position; drawn = 0; drawnTris = 0;
    for (const e of cells) {
      const on = p.distanceTo(e.c) - e.r < cull;
      if (e.mesh.visible !== on) e.mesh.visible = on;
      if (on) { drawn++; drawnTris += e.tris; }
    }
  }

  function clear() {
    cells = []; keyed = false; keyHist = null; liteSrc = false; totalTris = 0; totalVerts = 0; srcMeshes = 0; drawn = 0; drawnTris = 0;
  }

  return {
    adopt, setBudget, tick, clear,
    get count() { return cells.length; },
    get drawn() { return drawn; },
    get text() {
      if (!cells.length) return 'none';
      return `${drawn}/${cells.length} cells detailed · ${(drawnTris / 1e6).toFixed(2)}/${(totalTris / 1e6).toFixed(2)} M tris · keep ${(keptShare() * 100).toFixed(0)} %${keyed ? '' : ' (unkeyed)'}`;
    },
  };
}
