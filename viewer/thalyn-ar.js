// Thalyn® World Viewer — "View on your table" (phone AR, A13550–A13553).
//
// A phone can stand a shared world on a real table. The AR camera never gets the full world: it gets Table.glb
// (the small diorama an export may put beside World_web.glb) or, when there is none, the loaded file itself if it is
// small enough (a card's cropped world). Anything bigger and the button is simply not offered.
//
// <model-viewer> (Google, Apache-2.0, one pinned version from the same CDN host as three.js) is loaded only when the
// visitor taps the button: a preview opens, and its own "Place on your table" button starts the AR session —
// Android Chrome = WebXR (it decodes the meshopt + KTX2 the web exports use; Scene Viewer cannot), iPhone =
// Quick Look (built from the glb on the device; unverified on KTX2 worlds). The AR world is STILL: snow and shake
// live in the viewer's own globe. The world is fitted to ~40 cm across at fixed scale (no pinch-zoom).
const MV_URL = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.1.0/dist/model-viewer.min.js';
export const AR = { maxSelfBytes: 40 * 1024 * 1024, tableM: 0.4 };
const CSS = `
#ar-btn { position: fixed; right: 14px; top: 64px; z-index: 15; height: 44px; padding: 0 14px; display: none; align-items: center; gap: 8px; cursor: pointer;
  background: rgba(13,20,17,0.82); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); border-radius: 12px; backdrop-filter: blur(8px); font-size: 14px; }
#ar-btn.show { display: flex; }
body.walking #ar-btn, body.card-cover-on #ar-btn { display: none !important; }
body.card-on #ar-btn { top: 114px; }   /* under the card's mute (and the Walk button) */
#ar-pane { position: fixed; inset: 0; z-index: 80; display: none; flex-direction: column; background: #0d1411; }
#ar-pane.show { display: flex; }
#ar-pane model-viewer { flex: 1; width: 100%; background: radial-gradient(ellipse at 50% 40%, #2a2420, #0d1411); --poster-color: transparent; }
#ar-pane .bar { display: flex; gap: 10px; padding: 12px 14px max(12px, env(safe-area-inset-bottom)); justify-content: center; align-items: center; flex-wrap: wrap; }
#ar-pane button { padding: 11px 16px; border-radius: 12px; cursor: pointer; font-size: 15px; background: rgba(232,198,106,0.2); color: #E8C66A; border: 1px solid rgba(232,198,106,0.55); }
#ar-pane .st { width: 100%; text-align: center; font-size: 13px; color: #cfe0d7; min-height: 18px; }
#ar-pane .hint { position: absolute; top: max(14px, env(safe-area-inset-top)); left: 0; right: 0; text-align: center; color: #cfe0d7; font-size: 13px; text-shadow: 0 1px 6px #000; pointer-events: none; z-index: 1; }
`;
function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (parent) parent.appendChild(e);
  return e;
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Can this device put a model on a real surface? (WebXR immersive-ar, or iOS Quick Look) */
export async function arCapable() {
  if (isIOS()) { const a = document.createElement('a'); return !!(a.relList && a.relList.supports && a.relList.supports('ar')); }
  try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch (e) { return false; }
}
/** The file to stand on the table, or null: Table.glb beside the world, else the world itself when small. */
export async function pickTableFile(modelUrl) {
  if (!modelUrl || !/^https?:/i.test(modelUrl)) return null;
  const table = modelUrl.replace(/World_web(_lite)?\.glb(\?.*)?$/i, 'Table.glb');
  if (table !== modelUrl) { try { const r = await fetch(table, { method: 'HEAD' }); if (r.ok) return { url: table, why: 'Table.glb' }; } catch (e) {} }
  try {
    const r = await fetch(modelUrl, { method: 'HEAD' }); const n = +r.headers.get('content-length');
    if (r.ok && n > 0 && n <= AR.maxSelfBytes) return { url: modelUrl, why: 'the world itself (' + (n / 1048576).toFixed(1) + ' MB)' };
  } catch (e) {}
  return null;
}

/** deps: { modelURL(), coarse (bool), force (bool: ?ar=1 shows the button on any device for testing) } */
export function makeTableAR(deps) {
  el('style', { text: CSS }, document.head);
  const btn = el('button', { id: 'ar-btn', type: 'button', title: 'Stand this world on a real table through your camera' }, document.body);
  btn.textContent = 'View on your table';
  const pane = el('div', { id: 'ar-pane', role: 'dialog', 'aria-label': 'View on your table' }, document.body);
  const hint = el('div', { cls: 'hint', text: 'Turn it with a finger, then place it on your table' }, pane);
  const bar = el('div', { cls: 'bar' }, pane);
  const st = el('div', { cls: 'st', role: 'status', 'aria-live': 'polite' }, bar);
  const place = el('button', { type: 'button', text: 'Place on your table' }, bar);
  const close = el('button', { type: 'button', text: 'Back to the world' }, bar);
  let file = null, mv = null, mvLoaded = null;

  async function check() {
    file = null; btn.classList.remove('show');
    if (!deps.force && !deps.coarse) return;
    const capable = deps.force || await arCapable();
    if (!capable) { console.info('[thalyn] ar: this device has no AR (immersive-ar / Quick Look) — no table button'); return; }
    file = await pickTableFile(deps.modelURL());
    if (!file) { console.info('[thalyn] ar: no Table.glb and the world is too big for a phone camera — no table button'); return; }
    btn.classList.add('show');
    console.info('[thalyn] ar: table button ready — ' + file.why);
  }
  function loadMV() {
    if (!mvLoaded) mvLoaded = new Promise((res, rej) => { const s = document.createElement('script'); s.type = 'module'; s.src = MV_URL; s.onload = res; s.onerror = rej; document.head.appendChild(s); })
      .then(() => customElements.whenDefined('model-viewer'));
    return mvLoaded;
  }
  btn.onclick = async () => {
    if (!file) return;
    pane.classList.add('show'); st.textContent = 'Preparing the table model…'; place.disabled = true;
    try { await loadMV(); } catch (e) { st.textContent = "This phone couldn't load the table view."; console.warn('[thalyn] ar: model-viewer failed to load', e); return; }
    if (!mv) {
      mv = el('model-viewer', { 'camera-controls': '', 'touch-action': 'pan-y', ar: '', 'ar-modes': 'webxr quick-look', 'ar-scale': 'fixed', 'ar-placement': 'floor',
        'shadow-intensity': '1', exposure: '1', 'interaction-prompt': 'none', alt: 'This world, small enough for a table' });
      pane.insertBefore(mv, bar);
      mv.addEventListener('progress', e => { const p = e.detail && e.detail.totalProgress; if (p < 1) st.textContent = 'Preparing the table model… ' + Math.round(p * 100) + '%'; });
      mv.addEventListener('load', () => {
        // Fit the world to ~40 cm across, whatever its real size (fixed scale: no pinching it to room size).
        try { const d = mv.getDimensions(); const k = AR.tableM / Math.max(0.01, d.x, d.z); mv.scale = `${k} ${k} ${k}`; if (mv.updateFraming) mv.updateFraming(); console.info('[thalyn] ar: model ready ' + d.x.toFixed(1) + '×' + d.z.toFixed(1) + ' m → ×' + k.toPrecision(3) + ' (≈' + Math.round(AR.tableM * 100) + ' cm)'); } catch (e) {}
        st.textContent = mv.canActivateAR ? '' : "This phone can't place it in AR, but you can turn it here.";
        place.disabled = !mv.canActivateAR;
        console.info('[thalyn] ar: model-viewer ready, modes=' + mv.getAttribute('ar-modes') + ', canActivateAR=' + mv.canActivateAR);
      });
      mv.addEventListener('error', e => { st.textContent = "The table model couldn't load."; console.warn('[thalyn] ar: model error', e.detail); });
      mv.addEventListener('ar-status', e => console.info('[thalyn] ar: status ' + (e.detail && e.detail.status)));
    }
    if (mv.src !== file.url) mv.src = file.url;
    else { place.disabled = !mv.canActivateAR; st.textContent = ''; }
  };
  place.onclick = () => { if (mv && mv.canActivateAR) mv.activateAR(); };   // a tap: the gesture AR needs
  close.onclick = () => pane.classList.remove('show');
  return { check, get file() { return file; } };
}
