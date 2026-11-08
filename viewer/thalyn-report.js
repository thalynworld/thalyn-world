// Thalyn® World Viewer — "Report this world" for an ordinary shared world (A14134).
// A world report is READ BY A PERSON (it never takes a public world down by itself), so the reply says "we'll review it".
// Sent only when the visitor presses Send; nothing about the visitor is attached unless they type it.
const REASONS = [['harassment', 'Harassment or bullying'], ['hate', 'Hate'], ['sexual', 'Sexual content'], ['violence', 'Violence or threats'],
  ['privacy', 'Private information'], ['spam', 'Spam or a scam'], ['copyright', 'Copyright'], ['illegal', 'Something illegal'], ['other', 'Something else']];
const CSS = `
#wr-dlg { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 72; width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow-y: auto;
  display: none; flex-direction: column; gap: 8px; padding: 16px; border-radius: 14px; background: rgba(13,20,17,0.97); border: 1px solid rgba(232,198,106,0.45);
  color: #cfe0d7; font-size: 13px; box-sizing: border-box; }
#wr-dlg.show { display: flex; }
@media (max-width: 600px), (max-height: 560px) { #wr-dlg { top: max(12px, env(safe-area-inset-top)); transform: translateX(-50%); } }
#wr-dlg h2 { margin: 0; font: 600 16px Georgia, serif; color: #E8C66A; }
#wr-dlg select, #wr-dlg textarea, #wr-dlg input { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid rgba(232,198,106,0.3); background: rgba(255,255,255,0.05); color: #e8efe9; padding: 7px 8px; font-size: 13px; }
#wr-dlg textarea { height: 80px; resize: vertical; }
#wr-dlg .st { min-height: 18px; color: #E8C66A; }
#wr-dlg .row { display: flex; gap: 8px; } #wr-dlg .row button { flex: 1; padding: 9px; border-radius: 8px; cursor: pointer; background: rgba(232,198,106,0.16); color: #E8C66A; border: 1px solid rgba(232,198,106,0.45); }
#wr-dlg button:disabled { opacity: 0.5; }
`;
function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (parent) parent.appendChild(e);
  return e;
}
/** deps: { api, modelURL() → the loaded world's address (no fragment), cleanText(s, n) } → { open() } */
export function makeWorldReport(deps) {
  el('style', { text: CSS }, document.head);
  const dlg = el('div', { id: 'wr-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report this world' }, document.body);
  el('h2', { text: 'Report this world' }, dlg);
  el('div', { text: 'Tell us what is wrong and a person at Thalyn will review it.' }, dlg);
  const reason = el('select', { 'aria-label': 'What is wrong' }, dlg);
  for (const [v, t] of REASONS) el('option', { value: v, text: t }, reason);
  const note = el('textarea', { maxlength: '1000', placeholder: 'Anything else we should know (optional)', 'aria-label': 'Details' }, dlg);
  const contact = el('input', { type: 'text', maxlength: '200', placeholder: 'How to reach you, if you want a reply (optional)', 'aria-label': 'Contact (optional)' }, dlg);
  const st = el('div', { cls: 'st', role: 'status', 'aria-live': 'polite' }, dlg);
  const row = el('div', { cls: 'row' }, dlg);
  const send = el('button', { type: 'button', text: 'Send report' }, row), close = el('button', { type: 'button', text: 'Close' }, row);
  close.onclick = () => dlg.classList.remove('show');
  dlg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') dlg.classList.remove('show'); });
  dlg.addEventListener('keyup', e => e.stopPropagation());
  send.onclick = async () => {
    const url = deps.modelURL(); if (!url) return;
    const body = { url: url.split('#')[0], reason: reason.value };
    const d = deps.cleanText(note.value, 1000); if (d) body.details = d;
    const c = deps.cleanText(contact.value, 200); if (c) body.contact = c;
    send.disabled = true; st.textContent = 'Sending…';
    try {
      const r = await fetch(deps.api + '/api/share/report', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      console.info('[thalyn-report] A14134 world report -> ' + r.status);
      if (r.ok) { st.textContent = "Thank you. We'll review it."; note.value = ''; contact.value = ''; return; }
      st.textContent = r.status === 429 ? 'Too many reports from here just now. Please try again later.' : "We couldn't send that (" + r.status + '). Please try again.';
    } catch (e) { st.textContent = "We couldn't reach Thalyn. Please try again."; console.warn('[thalyn-report] failed', e); }
    send.disabled = false;
  };
  return { open() { st.textContent = ''; send.disabled = false; dlg.classList.add('show'); reason.focus(); } };
}
