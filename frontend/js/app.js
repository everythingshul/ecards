// Shared frontend helpers: auth/session, api() fetch wrapper, toast, sidebar, modal.
const API_BASE = '/api';

const Auth = {
  token() { return localStorage.getItem('ec_token'); },
  user() { try { return JSON.parse(localStorage.getItem('ec_user') || 'null'); } catch { return null; } },
  set(token, user) { localStorage.setItem('ec_token', token); localStorage.setItem('ec_user', JSON.stringify(user)); },
  logout() { localStorage.removeItem('ec_token'); localStorage.removeItem('ec_user'); location.href = '/login.html'; },
  requireAuth() { if (!this.token()) location.href = '/login.html'; },
  can(resource, action = 'can_view') {
    const u = this.user();
    if (!u) return false;
    if (u.role === 'super_admin') return true;
    // Real enforcement happens server-side; this only toggles UI affordances.
    return true;
  },
};

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, { method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { Auth.logout(); throw new Error('Session expired'); }
  if (res.status === 423) { toast(data.error || 'Account paused', true); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Authenticated file download — plain `location.href = '/api/...'` never
// sends the Authorization header (this app has no cookie session), so every
// protected download (CSV/XLSX exports, import templates) must go through
// this instead: fetch with the auth header, then save the blob.
async function downloadAuthed(path, fallbackFilename) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) { let msg = `Download failed (${res.status})`; try { msg = (await res.json()).error || msg; } catch {} toast(msg, true); return; }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function fmtDate(d) { if (!d) return '—'; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateTime(d) { if (!d) return '—'; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function badge(text, cls) { return `<span class="badge badge-${esc(cls || text)}">${esc((text || '').replace(/_/g, ' '))}</span>`; }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

const NAV_ITEMS = [
  { href: '/admin/dashboard.html', label: 'Dashboard', icon: '&#9670;', resource: 'dashboard' },
  { href: '/admin/shuls.html', label: 'Shuls', icon: '&#9670;', resource: 'shuls' },
  { href: '/admin/applicants.html', label: 'Applicants', icon: '&#9670;', resource: 'applicants' },
  { href: '/admin/cards.html', label: 'Cards & Transactions', icon: '&#9670;', resource: 'cards' },
  { href: '/admin/stores.html', label: 'Stores', icon: '&#9670;', resource: 'stores' },
  { href: '/admin/tasks.html', label: 'Tasks', icon: '&#9670;', resource: 'tasks' },
  { href: '/admin/forms.html', label: 'Form Builder', icon: '&#9670;', resource: 'forms' },
  { href: '/admin/users.html', label: 'Users & Permissions', icon: '&#9670;', resource: 'users' },
  { href: '/admin/settings.html', label: 'Settings', icon: '&#9670;', resource: 'settings' },
];
const SHUL_NAV = [
  { href: '/shul-portal/dashboard.html', label: 'My Applicants' },
  { href: '/shul-portal/upload.html', label: 'Bulk Upload' },
  { href: '/shul-portal/contract.html', label: 'Contract' },
];
const STORE_NAV = [
  { href: '/store-portal/dashboard.html', label: 'Overview' },
  { href: '/store-portal/billing.html', label: 'Billing' },
];

function renderShell(activeHref, contentHtml) {
  const user = Auth.user();
  const role = user?.role;
  let items = NAV_ITEMS;
  if (role === 'shul') items = SHUL_NAV;
  else if (role === 'store') items = STORE_NAV;
  const navHtml = items.map(i => `<a href="${i.href}" class="${activeHref === i.href ? 'active' : ''}">${i.icon ? `<span>${i.icon}</span>` : ''}${esc(i.label)}</a>`).join('');
  document.body.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><div class="dot"></div><div class="brand-name">everythingshul<br><span style="font-size:11px;color:#b8a688;">e-cards admin</span></div></div>
        <nav>${navHtml}</nav>
        <div class="user-box">${esc(user?.first_name || '')} ${esc(user?.last_name || '')}<br><span style="text-transform:capitalize">${esc((role || '').replace('_', ' '))}</span><br><button onclick="Auth.logout()">Sign out</button></div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="btn btn-outline btn-sm" style="display:none" id="hamburger" onclick="document.getElementById('sidebar').classList.toggle('open')">☰</button>
          <div></div>
          <div class="small-muted">${esc(user?.email || '')}</div>
        </div>
        <div class="content" id="content">${contentHtml}</div>
      </div>
    </div>`;
}

function openModal(title, bodyHtml, footerHtml = '') {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'ec-modal';
  el.innerHTML = `<div class="modal">
    <div class="modal-header"><h3 style="margin:0">${esc(title)}</h3><button onclick="closeModal()">&times;</button></div>
    <div class="modal-body">${bodyHtml}</div>
    ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
  </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });
  document.body.appendChild(el);
}
function closeModal() { document.getElementById('ec-modal')?.remove(); }

// Google Places autocomplete helper — degrades gracefully if no API key configured.
async function attachPlacesAutocomplete(inputId, fields) {
  const input = document.getElementById(inputId);
  if (!input || !window.google?.maps?.places) return;
  const ac = new google.maps.places.Autocomplete(input, { types: ['address'] });
  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    if (!place.address_components) return;
    const get = (type) => place.address_components.find(c => c.types.includes(type))?.long_name || '';
    const getShort = (type) => place.address_components.find(c => c.types.includes(type))?.short_name || '';
    const streetNum = get('street_number'), route = get('route');
    if (fields.address) document.getElementById(fields.address).value = [streetNum, route].filter(Boolean).join(' ') || input.value;
    if (fields.city) document.getElementById(fields.city).value = get('locality') || get('sublocality') || get('postal_town');
    if (fields.state) document.getElementById(fields.state).value = getShort('administrative_area_level_1');
    if (fields.zip) document.getElementById(fields.zip).value = get('postal_code');
    if (fields.placeId) document.getElementById(fields.placeId).value = place.place_id || '';
    if (fields.lat) document.getElementById(fields.lat).value = place.geometry?.location?.lat() ?? '';
    if (fields.lng) document.getElementById(fields.lng).value = place.geometry?.location?.lng() ?? '';
  });
}

async function loadGoogleMaps() {
  if (window.google?.maps) return;
  try {
    const { googleMapsApiKey } = await api('/config');
    if (!googleMapsApiKey) return; // no key configured yet — address autofill silently disabled
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places`;
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  } catch { /* address autofill unavailable — forms remain fully usable manually */ }
}

// Quick "+ Add Task" flow usable from any detail modal (shul, applicant, ...).
// Linked to that record via entity_type/entity_id.
async function openQuickTaskModal(entityType, entityId, entityLabel) {
  let users = [];
  try { ({ users } = await api('/users')); } catch { /* non-admin viewers won't have access; button shouldn't be shown to them anyway */ }
  const options = `<option value="">Unassigned</option>` + users.filter(u => u.is_active).map(u => `<option value="${u.id}">${esc(u.first_name)} ${esc(u.last_name||'')}</option>`).join('');
  const body = `
    <p class="small-muted">Linked to ${esc(entityType)}: <strong>${esc(entityLabel)}</strong></p>
    <label>Title <span class="req">*</span></label><input id="qt-title">
    <label>Assign To</label><select id="qt-assigned_to">${options}</select>
    <label>Due Date</label><input type="date" id="qt-due_date" style="max-width:200px">`;
  openModal('Add Task', body, `<button class="btn btn-primary btn-sm" onclick="submitQuickTask('${entityType}','${entityId}')">Create Task</button>`);
}
window.openQuickTaskModal = openQuickTaskModal;
window.submitQuickTask = async (entityType, entityId) => {
  const title = document.getElementById('qt-title').value.trim();
  if (!title) return toast('Title is required', true);
  const body = { title, assigned_to: document.getElementById('qt-assigned_to').value || null, due_date: document.getElementById('qt-due_date').value || null, entity_type: entityType, entity_id: entityId };
  try { await api('/tasks', { method: 'POST', body }); toast('Task created'); closeModal(); } catch (err) { toast(err.message, true); }
};

// Side-by-side field comparison table for duplicate review (shuls & applicants).
// fields: [[key, label], ...]. Differing values get a highlighted background.
function renderCompareTable(fields, a, b) {
  const rows = fields.map(([key, label]) => {
    const av = a?.[key], bv = b?.[key];
    const differs = String(av ?? '') !== String(bv ?? '');
    const cellStyle = differs ? 'background:#f9efe0' : '';
    return `<tr><td class="small-muted" style="white-space:nowrap">${esc(label)}</td><td style="${cellStyle}">${esc(av ?? '—')}</td><td style="${cellStyle}">${esc(bv ?? '—')}</td></tr>`;
  }).join('');
  return `<div style="overflow-x:auto"><table>
    <thead><tr><th></th><th>Record A <span class="small-muted">(${fmtDate(a?.created_at)})</span></th><th>Record B <span class="small-muted">(${fmtDate(b?.created_at)})</span></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// Where to send a just-logged-in store user — onboarding wizard until they've
// completed all 3 steps, dashboard after.
async function storeLandingUrl(user) {
  try {
    const { store } = await api(`/stores/${user.store_id}`);
    return (store.onboarding_step || 0) >= 3 ? '/store-portal/dashboard.html' : '/store-portal/onboarding.html';
  } catch { return '/store-portal/dashboard.html'; }
}

// Authenticated PDF view (opens in a new tab instead of forcing a download) —
// same auth-header requirement as downloadAuthed above.
async function viewAuthed(path) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) { toast('Could not load PDF', true); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Generic per-entity Documents tab (applicants & stores) — list existing
// documents, generate new ones, and send a signing link either to the
// record's own email on file or to any other recipient (so a specific
// document can be routed to a specific person). The signee always gets an
// emailed link; see routes/documents.js.
async function loadDocumentsTab(entityType, entityId, containerId, defaultEmail) {
  const container = qs('#' + containerId);
  container.innerHTML = '<p class="small-muted">Loading…</p>';
  const safeEmail = esc(defaultEmail || '').replace(/'/g, "\\'");
  try {
    const { documents } = await api(`/documents?entity_type=${entityType}&entity_id=${entityId}`);
    container.innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px">
        <div style="flex:1;min-width:160px"><label style="margin-top:0">New Document Title</label><input id="doc-title-${entityType}-${entityId}" placeholder="e.g. Agreement"></div>
        <button class="btn btn-sm btn-primary" onclick="generateDocument('${entityType}','${entityId}','${containerId}','${safeEmail}')">Generate New Document</button>
      </div>
      ${documents.length ? documents.map(d => documentRowHtml(d, entityType, entityId, containerId, defaultEmail)).join('') : '<p class="small-muted">No documents yet.</p>'}
    `;
  } catch (err) { container.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}
function documentRowHtml(d, entityType, entityId, containerId, defaultEmail) {
  const inputId = `doc-email-${d.id}`;
  const safeEmail = esc(defaultEmail || '').replace(/'/g, "\\'");
  const canAct = d.status !== 'signed' && d.status !== 'void';
  return `<div class="card" style="margin-bottom:10px">
    <div class="flex-between"><strong>${esc(d.title || 'Agreement')}</strong>${badge(d.status, d.status)}</div>
    <p class="small-muted">Created ${fmtDateTime(d.created_at)}${d.sent_at ? ' · Sent ' + fmtDateTime(d.sent_at) : ''}${d.signed_at ? ' · Signed ' + fmtDateTime(d.signed_at) + ' by ' + esc(d.signer_name || '') : ''}</p>
    ${canAct ? `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
      <div style="flex:1;min-width:180px"><label style="margin-top:0">Send To</label><input id="${inputId}" value="${esc(defaultEmail || '')}" placeholder="email address"></div>
      <button class="btn btn-sm btn-primary" onclick="sendDocument('${d.id}','${inputId}','${entityType}','${entityId}','${containerId}','${safeEmail}')">${d.status === 'sent' ? 'Resend' : 'Send'}</button>
    </div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-sm btn-outline" onclick="viewDocumentPdf('${d.id}')">View PDF</button>
      ${canAct ? `<button class="btn btn-sm btn-outline" onclick="voidDocument('${d.id}','${entityType}','${entityId}','${containerId}','${safeEmail}')">Void</button>` : ''}
    </div>
  </div>`;
}
window.generateDocument = async (entityType, entityId, containerId, defaultEmail) => {
  const titleInput = qs(`#doc-title-${entityType}-${entityId}`);
  const title = titleInput ? titleInput.value.trim() : '';
  try {
    await api('/documents/generate', { method: 'POST', body: { entity_type: entityType, entity_id: entityId, title } });
    toast('Document generated');
    loadDocumentsTab(entityType, entityId, containerId, defaultEmail);
  } catch (err) { toast(err.message, true); }
};
window.sendDocument = async (docId, inputId, entityType, entityId, containerId, defaultEmail) => {
  const email = qs('#' + inputId).value.trim();
  try {
    const r = await api(`/documents/${docId}/send`, { method: 'POST', body: email ? { email } : {} });
    toast(r.emailError ? `Link created, but email failed: ${r.emailError}` : `Sent to ${email || 'their email on file'}`, !!r.emailError);
    loadDocumentsTab(entityType, entityId, containerId, defaultEmail);
  } catch (err) { toast(err.message, true); }
};
window.voidDocument = async (docId, entityType, entityId, containerId, defaultEmail) => {
  if (!confirm('Void this document?')) return;
  try { await api(`/documents/${docId}/void`, { method: 'POST' }); toast('Voided'); loadDocumentsTab(entityType, entityId, containerId, defaultEmail); } catch (err) { toast(err.message, true); }
};
window.viewDocumentPdf = (docId) => viewAuthed(`/documents/${docId}/pdf`);

// Shared footer for public-facing pages (login/apply/sign-*/form) — every
// page carries the "Powered by everythingshul" mark linking to
// everythingshul.com, matching the treatment on every outbound email.
function renderPublicFooter() {
  const el = document.createElement('footer');
  el.className = 'site-footer';
  el.innerHTML = `<div class="site-footer-inner">Powered by <a href="https://everythingshul.com" target="_blank" rel="noopener">everythingshul<span class="site-footer-mark">&#9670;</span></a></div>`;
  document.body.appendChild(el);
}

// Minimal signature pad (mouse + touch) writing to a canvas, exported as base64 PNG.
function initSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  function resize() { const ratio = window.devicePixelRatio || 1; canvas.width = canvas.clientWidth * ratio; canvas.height = canvas.clientHeight * ratio; ctx.scale(ratio, ratio); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#241a15'; }
  resize();
  let drawing = false, hasDrawn = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { drawing = true; hasDrawn = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => drawing = false;
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start); canvas.addEventListener('touchmove', move); window.addEventListener('touchend', end);
  return {
    isEmpty: () => !hasDrawn,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasDrawn = false; },
    toDataUrl: () => canvas.toDataURL('image/png'),
  };
}
