// thalyn-sharecard.js — ★ LOOK ENGINE boost · THE SHARE CARD × 4 LOOKS (2026-11-02). One picture, four looks: the world's own camera pose
// (extras.thalyn.camera — where the maker took the picture) re-shot under Natural · Saturday Cartoon · Toytown · Golden Storybook, through
// the live render layer (thalyn-lookrender.js — the game's laws), composed into ONE 2×2 PNG with the look names. Nothing about the world
// changes: the look the world wears and the camera are put back exactly afterwards.
// What travels per look is the RENDER layer (grade · flatten · toon · outline). The surfaces and the sculpted twins of a look live in the
// app's own export, so a natural export shows each look's render character over natural materials (the game's card will add the rest).

export const CARD_LOOKS = [
  { id: 'natural', name: 'Natural' },
  { id: 'saturdaycartoon', name: 'Saturday Cartoon' },
  { id: 'pastelclay', name: 'Toytown' },
  { id: 'goldenstorybook', name: 'Golden Storybook' },
];

const frame = () => new Promise(r => requestAnimationFrame(() => r()));

/**
 * Shoot the strip. ctx = { renderer, post, camera, controls, lookRender, table (Map from thalyn-look.palettes), tierName, pose, restoreLook() }.
 * pose = { position: Vector3, forward: Vector3, fov? } (null = the current view). Returns a PNG Blob.
 */
export async function shootLookStrip(ctx, cellW = 960, cellH = 540) {
  const { renderer, post, camera, controls, lookRender, table, tierName, pose } = ctx;
  const was = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
  const autoRotate = controls.autoRotate; controls.autoRotate = false;
  if (pose) {
    camera.position.copy(pose.position);
    controls.target.copy(pose.position).addScaledVector(pose.forward, 30);
    if (pose.fov) camera.fov = pose.fov;
    camera.updateProjectionMatrix(); controls.update();
  }
  const out = document.createElement('canvas');
  out.width = cellW * 2; out.height = cellH * 2;
  const g = out.getContext('2d');
  const src = renderer.domElement;
  try {
    for (let i = 0; i < CARD_LOOKS.length; i++) {
      const L = CARD_LOOKS[i];
      const row = L.id === 'natural' ? null : (table.get(L.id) || null);
      lookRender.set(row ? row.render : null, tierName, L.id);
      for (let k = 0; k < 3; k++) await frame();        // the loop renders with the new uniforms (depth attached, TAA-free)
      if (lookRender.enabled) lookRender.update(ctx.sunDir, post.composer.renderTarget1.width, post.composer.renderTarget1.height);
      post.render();                                       // our own render, read back at once (the drawing buffer is not preserved)
      // cover-fit the canvas into the cell
      const sw = src.width, sh = src.height, s = Math.max(cellW / sw, cellH / sh);
      const dw = sw * s, dh = sh * s, x = (i % 2) * cellW, y = Math.floor(i / 2) * cellH;
      g.save(); g.beginPath(); g.rect(x, y, cellW, cellH); g.clip();
      g.drawImage(src, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
      g.restore();
      // the label: a gilded word on a soft dark band
      g.fillStyle = 'rgba(14,12,9,0.55)'; g.fillRect(x, y + cellH - 54, cellW, 54);
      g.fillStyle = '#f2d99a'; g.font = '600 26px Georgia, "Times New Roman", serif'; g.textBaseline = 'middle';
      g.fillText(L.name, x + 22, y + cellH - 27);
    }
    g.strokeStyle = 'rgba(230,190,110,0.85)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cellW, 0); g.lineTo(cellW, cellH * 2); g.moveTo(0, cellH); g.lineTo(cellW * 2, cellH); g.stroke();
  } finally {
    ctx.restoreLook();                                     // the world's own look back
    camera.position.copy(was.pos); controls.target.copy(was.target); camera.fov = was.fov;
    camera.updateProjectionMatrix(); controls.autoRotate = autoRotate; controls.update();
  }
  const blob = await new Promise(r => out.toBlob(r, 'image/png'));
  console.log(`[sharecard] ${CARD_LOOKS.map(l => l.name).join(' · ')} — ${out.width}×${out.height} PNG, ${blob ? blob.size : 0} bytes${pose ? ' (from where the picture was taken)' : ' (from the current view)'}`);
  return blob;
}
