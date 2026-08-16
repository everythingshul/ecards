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
  const hadToken = !!Auth.token();
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, { method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined) });
  let data = {};
  try { data = await res.json(); } catch {}
  // A 401 with no token attached (e.g. a failed /auth/login) is a real
  // credentials/permission error, not a stale session — surface the actual
  // server message instead of forcing a confusing "session expired" logout.
  if (res.status === 401) {
    if (hadToken) { Auth.logout(); throw new Error('Session expired'); }
    throw new Error(data.error || 'Not authenticated');
  }
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
function fmtDate(d) { if (!d) return ''; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateTime(d) { if (!d) return ''; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
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
  { href: '/admin/emails.html', label: 'Email Center', icon: '&#9670;', resource: 'emails' },
  { href: '/admin/sms.html', label: 'SMS Center', icon: '&#9670;', resource: 'sms' },
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
  const navHtml = items.map(i => `<a href="${i.href}" class="${activeHref === i.href ? 'active' : ''}" title="${esc(i.label)}">${i.icon ? `<span class="nav-icon">${i.icon}</span>` : ''}<span class="nav-label">${esc(i.label)}</span></a>`).join('');
  const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
  document.body.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar${collapsed ? ' collapsed' : ''}" id="sidebar">
        <button class="sidebar-collapse-btn" id="sidebar-collapse-btn" title="Toggle sidebar" aria-label="Toggle sidebar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/><line x1="9" y1="4" x2="9" y2="20" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <div class="brand"><img src="/img/org-logo.png" alt="Organization logo" style="height:36px;width:auto"><div class="brand-name">Kipas Hair BP<br><span style="font-size:11px;color:var(--sidebar-muted);">Platform</span></div></div>
        <nav>${navHtml}</nav>
        <div class="user-box">
          <div class="user-box-detail">${esc(user?.first_name || '')} ${esc(user?.last_name || '')}<br><span style="text-transform:capitalize">${esc((role || '').replace('_', ' '))}</span></div>
          <button onclick="Auth.logout()">Sign out</button>
        </div>
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
  qs('#sidebar-collapse-btn').addEventListener('click', () => {
    const isCollapsed = qs('#sidebar').classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
  });
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

// Google Places address autocomplete — built on the new Places API's
// AutocompleteSuggestion/Place classes (google.maps.places.Autocomplete, the
// old widget, needs the legacy "Places API" enabled in addition to "Places
// API (New)"; this path only needs the latter). Implemented as a plain
// fetch-and-render dropdown rather than Google's PlaceAutocompleteElement
// custom element so the existing <input> stays a normal form field (name
// attribute, FormData collection, styling) instead of being replaced by a
// web component. Degrades gracefully — the input remains fully usable for
// manual entry if Places isn't available.
async function attachPlacesAutocomplete(inputId, fields) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.google?.maps?.places?.AutocompleteSuggestion) { console.warn(`[places] Skipping autocomplete for #${inputId} — Google Places was not loaded (see earlier [places] warning for why).`); return; }
  const { AutocompleteSuggestion, AutocompleteSessionToken } = google.maps.places;
  let sessionToken = new AutocompleteSessionToken();
  let dropdown = null, debounceTimer = null, requestId = 0;

  // Wrap the input in a dedicated, tightly-fitting positioning context so
  // the dropdown always anchors directly under it — existing markup doesn't
  // consistently wrap inputs in their own div, so relying on some ancestor
  // element (e.g. the whole <form>) would misplace the dropdown.
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  function closeDropdown() { dropdown?.remove(); dropdown = null; }

  function renderDropdown(suggestions) {
    closeDropdown();
    if (!suggestions.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'places-dropdown';
    for (const s of suggestions) {
      const pred = s.placePrediction;
      if (!pred) continue;
      const item = document.createElement('div');
      item.className = 'places-dropdown-item';
      item.textContent = pred.text?.text || '';
      item.addEventListener('mousedown', (e) => { e.preventDefault(); selectPrediction(pred); });
      dropdown.appendChild(item);
    }
    wrap.appendChild(dropdown);
  }

  async function selectPrediction(pred) {
    closeDropdown();
    input.value = pred.text?.text || input.value;
    try {
      const place = pred.toPlace();
      await place.fetchFields({ fields: ['addressComponents', 'location', 'id'] });
      const comps = place.addressComponents || [];
      const get = (type) => comps.find(c => c.types.includes(type))?.longText || '';
      const getShort = (type) => comps.find(c => c.types.includes(type))?.shortText || '';
      const streetNum = get('street_number'), route = get('route');
      if (fields.address) document.getElementById(fields.address).value = [streetNum, route].filter(Boolean).join(' ') || input.value;
      if (fields.city) document.getElementById(fields.city).value = get('locality') || get('sublocality') || get('postal_town');
      if (fields.state) document.getElementById(fields.state).value = getShort('administrative_area_level_1');
      if (fields.zip) document.getElementById(fields.zip).value = get('postal_code');
      if (fields.placeId) document.getElementById(fields.placeId).value = place.id || '';
      if (fields.lat) document.getElementById(fields.lat).value = place.location?.lat() ?? '';
      if (fields.lng) document.getElementById(fields.lng).value = place.location?.lng() ?? '';
    } catch (e) {
      console.error('[places] Could not fetch place details:', e.message);
    }
    sessionToken = new AutocompleteSessionToken(); // billing session ends at a completed selection
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (!query) { closeDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      const thisRequest = ++requestId;
      try {
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: query, sessionToken });
        if (thisRequest !== requestId) return; // a newer keystroke already superseded this request
        renderDropdown(suggestions || []);
      } catch (e) { console.error('[places] suggestion fetch failed:', e.message); }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
  input.setAttribute('autocomplete', 'off');
}

async function loadGoogleMaps() {
  if (window.google?.maps) return;
  try {
    const { googleMapsApiKey } = await api('/config');
    if (!googleMapsApiKey) {
      // Silent by design for end users (the form stays fully usable without
      // autofill), but this is the #1 thing to check when someone reports
      // "address autocomplete isn't working": GOOGLE_MAPS_API_KEY is not set
      // as an env var on the server.
      console.warn('[places] Address autocomplete disabled: GOOGLE_MAPS_API_KEY is not set on the server.');
      return;
    }
    // Surfaces Google's own runtime errors (bad key, required APIs not
    // enabled, billing not enabled, referrer restrictions blocking this
    // domain) instead of failing silently.
    window.gm_authFailure = () => console.error('[places] Google Maps authentication failed — check that the API key is valid, unrestricted for this domain, and that "Places API (New)" is enabled with billing active in Google Cloud Console.');
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google Maps script failed to load (network error or invalid key)'));
      document.head.appendChild(s);
    });
    if (!window.google?.maps?.places) console.error('[places] Google Maps script loaded but google.maps.places is unavailable — the Places API may not be enabled for this key.');
  } catch (e) {
    console.error('[places] Address autocomplete unavailable:', e.message, '— forms remain fully usable manually.');
  }
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
    return `<tr><td class="small-muted" style="white-space:nowrap">${esc(label)}</td><td style="${cellStyle}">${esc(av ?? '')}</td><td style="${cellStyle}">${esc(bv ?? '')}</td></tr>`;
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

// Kept as a no-op call site for public-facing pages (login/apply/sign-*/form)
// that still call it — there is no footer mark to render anymore.
function renderPublicFooter() {}

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

// Draggable/resizable signature-box editor (Settings > Documents). kind is
// 'shul' | 'applicant' | 'store'. Renders a page-proportioned mockup, not
// the live PDF content, since that's reliable across browsers and works
// the same whether the underlying doc is our generated Letter-size PDF or
// an admin-uploaded PDF of any size — the box is saved as fractions (0-1)
// of the page's actual width/height, top-left origin, and stampSignature()
// (services/pdf.js) converts to PDF points at sign time.
let sigBoxState = null;
window.openSignatureBoxEditor = async (kind, title) => {
  let data;
  try { data = await api(`/settings/signature-box/${kind}`); } catch (err) { return toast(err.message, true); }
  const pageSize = data.pageSize;
  const box = data.box || { x: 0.09, y: 0.62, width: 0.42, height: 0.22 };
  const mockW = 320;
  const mockH = Math.round(mockW * pageSize.height / pageSize.width);
  const bodyHtml = `
    <p class="small-muted">Drag the box to position where the signature is stamped on the last page, and drag its corner handle to resize it. This preview is scaled to your page's proportions (not the live document content), so it works reliably for any page size.</p>
    <div id="sigbox-page" style="position:relative;width:${mockW}px;height:${mockH}px;margin:16px auto;background:#fff;border:1px solid var(--border);box-shadow:var(--shadow)">
      <div id="sigbox-box" style="position:absolute;background:rgba(201,167,106,.35);border:2px solid var(--brand-gold-dark);cursor:move;box-sizing:border-box">
        <div id="sigbox-handle" style="position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;background:var(--brand-gold-dark);cursor:nwse-resize"></div>
      </div>
    </div>
    <p class="small-muted" style="text-align:center">Page size: ${Math.round(pageSize.width)} &times; ${Math.round(pageSize.height)} pt</p>
  `;
  openModal(title, bodyHtml, `<button class="btn btn-primary btn-sm" onclick="saveSignatureBox('${kind}')">Save Placement</button>`);

  const boxEl = qs('#sigbox-box'), handleEl = qs('#sigbox-handle');
  function render() {
    boxEl.style.left = (box.x * mockW) + 'px';
    boxEl.style.top = (box.y * mockH) + 'px';
    boxEl.style.width = (box.width * mockW) + 'px';
    boxEl.style.height = (box.height * mockH) + 'px';
  }
  render();

  let dragMode = null, startPx = { x: 0, y: 0 }, startBox = null;
  function onDown(mode) {
    return (e) => {
      e.preventDefault(); e.stopPropagation();
      dragMode = mode;
      startPx = { x: e.clientX, y: e.clientY };
      startBox = { ...box };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }
  function onMove(e) {
    if (!dragMode) return;
    const dx = (e.clientX - startPx.x) / mockW, dy = (e.clientY - startPx.y) / mockH;
    if (dragMode === 'move') {
      box.x = Math.min(1 - box.width, Math.max(0, startBox.x + dx));
      box.y = Math.min(1 - box.height, Math.max(0, startBox.y + dy));
    } else {
      box.width = Math.min(1 - box.x, Math.max(0.12, startBox.width + dx));
      box.height = Math.min(1 - box.y, Math.max(0.06, startBox.height + dy));
    }
    render();
  }
  function onUp() {
    dragMode = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }
  boxEl.addEventListener('pointerdown', onDown('move'));
  handleEl.addEventListener('pointerdown', onDown('resize'));
  sigBoxState = { kind, get: () => box };
};
window.saveSignatureBox = async (kind) => {
  const box = sigBoxState?.kind === kind ? sigBoxState.get() : null;
  if (!box) return;
  try {
    await api(`/settings/signature-box/${kind}`, { method: 'PUT', body: box });
    toast('Signature placement saved');
    closeModal();
  } catch (err) { toast(err.message, true); }
};
