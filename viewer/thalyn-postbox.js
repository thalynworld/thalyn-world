// Thalyn® World Viewer — the postbox (A13830–A13832, idea I4).
//
// A shared world's maker can open a postbox: a visitor leaves a short note that only the maker reads. This page
// sends a note ONLY when the visitor presses Send, after the consent line; nothing is sent, stored or shown
// otherwise. The postbox shows nothing at all unless the status check answers {open: true} (a closed postbox,
// a switched-off server or a network error all look the same: no button). A sent note is never shown on the page
// and never kept in the browser.
const CONSENT = "Your note and first name go to Thalyn and to this world's maker only. Please don't include personal details or links.";
const LIMITS = { name: 24, body: 280 };
const LINES = {
  204: "Delivered to the maker's postbox.",
  note_has_link: "Notes can't include links.",
  note_has_contact: 'Please leave out phone numbers and emails.',
  note_refused: "That note can't be sent.",
  postbox_closed: 'This postbox is closed.',
  postbox_blocked: "This postbox isn't taking notes from you.",
  postbox_cap: "That's enough notes for today. Thank you!",
  other: "Couldn't send just now.",
};
const CSS = `
#pb-btn { position: fixed; left: 14px; bottom: 14px; z-index: 16; height: 44px; padding: 0 14px; display: none; align-items: center; gap: 8px; cursor: pointer;
  background: rgba(13,20,17,0.82); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); border-radius: 12px; backdrop-filter: blur(8px); font-size: 14px; }
#pb-btn.show { display: flex; } #pb-btn svg { width: 20px; height: 20px; }
body.clean:not(.card-globe) #pb-btn { opacity: 0.85; }
body.walking #pb-btn { opacity: 0.2; pointer-events: none; }
body.card-cover-on #pb-btn { display: none !important; }
@media (max-width: 600px) { body:not(.clean) #pb-btn { left: 66px; } }
#pb-dlg { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 72; width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow-y: auto;
  display: none; flex-direction: column; gap: 8px; padding: 16px; border-radius: 14px; background: rgba(13,20,17,0.97); border: 1px solid rgba(232,198,106,0.45);
  color: #cfe0d7; font-size: 13px; box-sizing: border-box; }
#pb-dlg.show { display: flex; }
@media (max-width: 600px), (max-height: 560px) { #pb-dlg { top: max(12px, env(safe-area-inset-top)); transform: translateX(-50%); } }   /* the keyboard rises from below: keep Send above it */
#pb-dlg h2 { margin: 0; font: 600 16px Georgia, serif; color: #E8C66A; }
#pb-dlg label { display: flex; flex-direction: column; gap: 4px; }
#pb-dlg input, #pb-dlg textarea { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid rgba(232,198,106,0.3); background: rgba(255,255,255,0.05); color: #e8efe9; padding: 7px 8px; font: 14px ui-sans-serif, system-ui, sans-serif; }
#pb-dlg textarea { height: 96px; resize: vertical; }
#pb-dlg .count { align-self: flex-end; font-size: 11px; color: #9DBCAC; }
#pb-dlg .consent { font-size: 12px; color: #E8C66A; }
#pb-dlg .st { min-height: 18px; color: #E8C66A; }
#pb-dlg .row { display: flex; gap: 8px; } #pb-dlg .row button { flex: 1; padding: 9px; border-radius: 8px; cursor: pointer; font-size: 14px;
  background: rgba(232,198,106,0.16); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); }
#pb-dlg .row button:disabled { opacity: 0.5; cursor: default; }
#pb-btn:focus-visible, #pb-dlg button:focus-visible { outline: 2px solid #E8C66A; outline-offset: 2px; }
`;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 8l9 6 9-6"/></svg>';

function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (parent) parent.appendChild(e);
  return e;
}

/** deps: { api (base URL), model (the ?model value as given), cleanText(s, n), toast(msg) } */
export function makePostbox(deps) {
  const { api, model, cleanText } = deps;
  if (!model || !api) return { get open() { return false; } };
  el('style', { text: CSS }, document.head);
  const btn = el('button', { id: 'pb-btn', type: 'button', title: "Leave a note for this world's maker" }, document.body);
  btn.innerHTML = ICON;   // static drawing
  el('span', { text: 'Leave a note' }, btn);
  const dlg = el('div', { id: 'pb-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Leave a note for the maker' }, document.body);
  el('h2', { text: "Leave a note for this world's maker" }, dlg);
  const nameL = el('label', {}, dlg); el('span', { text: 'Your first name (optional)' }, nameL);
  const name = el('input', { type: 'text', maxlength: String(LIMITS.name), autocomplete: 'given-name' }, nameL);
  const bodyL = el('label', {}, dlg); el('span', { text: 'Your note' }, bodyL);
  const body = el('textarea', { maxlength: String(LIMITS.body) }, bodyL);
  const count = el('div', { cls: 'count', 'aria-live': 'off' }, dlg);
  el('div', { cls: 'consent', text: CONSENT }, dlg);
  const st = el('div', { cls: 'st', role: 'status', 'aria-live': 'polite' }, dlg);
  const row = el('div', { cls: 'row' }, dlg);
  const send = el('button', { type: 'button', text: 'Send' }, row), cancel = el('button', { type: 'button', text: 'Cancel' }, row);

  let open = false, busy = false;
  const recount = () => { const n = Array.from(body.value).length; count.textContent = n + ' / ' + LIMITS.body; send.disabled = busy || !cleanText(body.value, LIMITS.body); };
  body.addEventListener('input', recount);
  // Keep Send in view when a phone keyboard shrinks the viewport.
  for (const f of [name, body]) f.addEventListener('focus', () => setTimeout(() => { try { send.scrollIntoView({ block: 'nearest' }); } catch (e) {} }, 300));
  function show() { st.textContent = ''; dlg.classList.add('show'); recount(); body.focus(); }
  function hide() { dlg.classList.remove('show'); }
  // The fields hold nothing once the dialog closes after a send (never kept, never shown back).
  function clear() { name.value = ''; body.value = ''; recount(); }
  btn.onclick = show;
  cancel.onclick = hide;
  dlg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') hide(); });   // the world's keys (V, H, WASD) stay out of the fields
  dlg.addEventListener('keyup', e => e.stopPropagation());

  send.onclick = async () => {
    if (busy) return;
    const note = cleanText(body.value, LIMITS.body), who = cleanText(name.value, LIMITS.name);
    if (!note) return;
    busy = true; send.disabled = true; st.textContent = 'Sending…';
    let status = 0, code = '';
    try {
      const r = await fetch(api + '/api/postbox/note', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, name: who, body: note }) });
      status = r.status;
      if (!r.ok) { try { const j = await r.json(); code = String(j.code || j.error || ''); } catch (e) {} }
    } catch (e) { status = 0; }
    console.info('[Postbox] A13831 sent -> ' + (status || 'network error') + (code ? ' ' + code : ''));
    busy = false;
    if (status >= 200 && status < 300) { clear(); hide(); deps.toast(LINES[204]); return; }
    if (status === 429) code = 'postbox_cap';
    st.textContent = LINES[code] || LINES.other;
    if (code === 'postbox_closed') { btn.classList.remove('show'); open = false; }
    recount();
  };

  // The status check: only {open: true} shows the button; anything else shows nothing and says nothing.
  (async () => {
    try {
      const r = await fetch(api + '/api/postbox/status?model=' + encodeURIComponent(model), { credentials: 'omit' });
      if (r.ok) { const j = await r.json(); open = j && j.open === true; }
    } catch (e) { open = false; }
    console.info('[Postbox] A13830 status open=' + open);
    btn.classList.toggle('show', open);
  })();
  return { get open() { return open; } };
}
