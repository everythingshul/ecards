// Shared frontend helpers: auth/session, api() fetch wrapper, toast, sidebar, modal.
const API_BASE = '/api';

const Auth = {
  token() { return localStorage.getItem('ec_token'); },
  user() { try { return JSON.parse(localStorage.getItem('ec_user') || 'null'); } catch { return null; } },
  set(token, user) { localStorage.setItem('ec_token', token); localStorage.setItem('ec_user', JSON.stringify(user)); },
  logout() { localStorage.removeItem('ec_token'); localStorage.removeItem('ec_user'); location.href = '/login.html'; },
  requireAuth() { if (!this.token()) location.href = '/login.html'; },
  // Bounces away immediately if the signed-in role isn't one of `roles` —
  // e.g. a shul-portal login typing /admin/dashboard.html into the address
  // bar. This is a UX guard only: the role read here comes from localStorage
  // and every real data endpoint independently re-checks the actual role
  // server-side from the JWT on every request (see middleware/auth.js), so
  // there's nothing to gain by tampering with it client-side.
  requireRole(...roles) {
    this.requireAuth();
    if (!this.token()) return;
    const user = this.user();
    if (!user) return this.logout();
    if (!roles.includes(user.role)) {
      if (user.role === 'shul') location.href = '/shul-portal/dashboard.html';
      else if (user.role === 'store') location.href = '/store-portal/dashboard.html';
      else location.href = '/admin/dashboard.html';
    }
  },
  requireAdmin() { this.requireRole('staff', 'org_admin', 'super_admin'); },
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
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; throw err; }
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
  { href: '/admin/updates.html', label: 'Updates', icon: '&#9670;', resource: 'updates' },
  { href: '/admin/users.html', label: 'Users & Permissions', icon: '&#9670;', resource: 'users' },
  { href: '/admin/settings.html', label: 'Settings', icon: '&#9670;', resource: 'settings' },
  { href: '/admin/audit.html', label: 'Recent Actions', icon: '&#9670;', resource: 'audit', roles: ['super_admin'] },
];
const SHUL_NAV = [
  { href: '/shul-portal/dashboard.html', label: 'My Applicants' },
  { href: '/shul-portal/upload.html', label: 'Bulk Upload' },
  { href: '/shul-portal/updates.html', label: 'Updates' },
];
const STORE_NAV = [
  { href: '/store-portal/dashboard.html', label: 'Overview' },
  { href: '/store-portal/billing.html', label: 'Billing' },
  { href: '/store-portal/updates.html', label: 'Updates' },
];

function renderShell(activeHref, contentHtml) {
  const user = Auth.user();
  const role = user?.role;
  let items = NAV_ITEMS.filter(i => !i.roles || i.roles.includes(role));
  if (role === 'shul') items = SHUL_NAV;
  else if (role === 'store') items = STORE_NAV;
  const navHtml = items.map(i => `<a href="${i.href}" class="${activeHref === i.href ? 'active' : ''}" title="${esc(i.label)}" data-href="${i.href}"><span class="nav-label">${esc(i.label)}</span></a>`).join('');
  document.body.innerHTML = `
    <div class="app-shell">
      <header class="app-header" id="app-header">
        <div class="brand"><img src="/img/org-logo.png" alt="Organization logo"><div class="brand-name">Kipas Hair BP<span>Platform</span></div></div>
        <button class="header-menu-btn" id="header-menu-btn" aria-label="Toggle menu">&#9776;</button>
        <nav id="header-nav">${navHtml}<div class="nav-more" id="nav-more"><button class="nav-more-btn" id="nav-more-btn" type="button">More &#9662;</button><div class="nav-more-dropdown" id="nav-more-dropdown"></div></div></nav>
        <div class="header-user">
          <span class="header-user-email">${esc(user?.email || '')}</span>
          <button onclick="Auth.logout()">Sign out</button>
        </div>
      </header>
      <div class="content" id="content">${contentHtml}</div>
    </div>`;
  qs('#header-menu-btn').addEventListener('click', () => qs('#header-nav').classList.toggle('open'));
  qs('#nav-more-btn').addEventListener('click', (e) => { e.stopPropagation(); qs('#nav-more-dropdown').classList.toggle('open'); });
  document.addEventListener('click', (e) => { const dd = qs('#nav-more-dropdown'); if (dd && dd.classList.contains('open') && !qs('#nav-more').contains(e.target)) dd.classList.remove('open'); });
  layoutNavOverflow();
  window.addEventListener('resize', debounce(layoutNavOverflow, 150));
  if (role === 'shul' || role === 'store') {
    api('/updates/inbox/unread-count').then(({ count }) => {
      if (!count) return;
      const link = document.querySelector('nav a[data-href$="/updates.html"]');
      if (link) link.querySelector('.nav-label').innerHTML += ` ${badge(String(count), 'active')}`;
      layoutNavOverflow();
    }).catch(() => {});
  }
}

// On the wide (non-hamburger) header layout, the nav row hides links that
// don't fit and collects them into a "More" dropdown instead of letting the
// nav scroll horizontally. Below the mobile breakpoint (see theme.css) the
// whole nav becomes a full-width vertical dropdown behind the hamburger
// button instead, so this is a no-op there — reset to "everything visible,
// no More button" so a resize back up to desktop width starts clean.
function layoutNavOverflow() {
  const nav = qs('#header-nav'); const moreWrap = qs('#nav-more'); const moreBtn = qs('#nav-more-btn'); const moreDropdown = qs('#nav-more-dropdown');
  if (!nav || !moreWrap) return;
  const links = qsa('#header-nav > a');
  links.forEach(a => { a.style.display = ''; });
  moreDropdown.classList.remove('open');
  moreDropdown.innerHTML = '';
  if (window.innerWidth <= 780) { moreWrap.style.display = 'none'; return; }
  moreWrap.style.display = 'inline-flex';
  const available = nav.clientWidth;
  const moreWidth = moreWrap.getBoundingClientRect().width;
  let usedWidth = 0;
  const overflowLinks = [];
  for (const a of links) {
    const w = a.getBoundingClientRect().width;
    if (usedWidth + w > available - moreWidth) overflowLinks.push(a);
    else usedWidth += w;
  }
  if (!overflowLinks.length) { moreWrap.style.display = 'none'; return; }
  moreDropdown.innerHTML = overflowLinks.map(a => a.outerHTML).join('');
  overflowLinks.forEach(a => { a.style.display = 'none'; });
  moreBtn.classList.toggle('active', overflowLinks.some(a => a.classList.contains('active')));
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

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

// Minimal dependency-free rich text editor for composing HTML email/update
// bodies — a toolbar of execCommand actions over a contenteditable div, so
// admins don't have to hand-write HTML tags. Renders into `#${containerId}`
// and returns { getHtml, setHtml }. Images are inlined as base64 data URIs
// (no separate upload step needed for something this small).
function createRichTextEditor(containerId, initialHtml = '') {
  const container = document.getElementById(containerId);
  const editorId = containerId + '-surface';
  container.innerHTML = `
    <div class="rte-toolbar">
      <button type="button" data-cmd="bold" title="Bold"><strong>B</strong></button>
      <button type="button" data-cmd="italic" title="Italic"><em>I</em></button>
      <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" data-cmd="formatBlock" data-arg="H3" title="Heading">H</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; List</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-cmd="createLink" title="Link">Link</button>
      <button type="button" data-action="image" title="Insert image">Image</button>
      <button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button>
      <input type="file" accept="image/*" class="rte-file-input" style="display:none">
    </div>
    <div id="${editorId}" class="rte-surface" contenteditable="true">${initialHtml || ''}</div>
  `;
  const surface = document.getElementById(editorId);
  container.querySelectorAll('.rte-toolbar button[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      surface.focus();
      const cmd = btn.dataset.cmd;
      if (cmd === 'createLink') {
        const url = prompt('Link URL:', 'https://');
        if (url) document.execCommand(cmd, false, url);
      } else {
        document.execCommand(cmd, false, btn.dataset.arg || null);
      }
    });
  });
  const fileInput = container.querySelector('.rte-file-input');
  container.querySelector('button[data-action="image"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { surface.focus(); document.execCommand('insertImage', false, reader.result); };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });
  return {
    getHtml: () => surface.innerHTML,
    setHtml: (html) => { surface.innerHTML = html || ''; },
  };
}

// Shared body renderer for an Update record — used by the portal inbox
// detail modal and the admin "View" modal alike. Images render inline as
// their own paragraph; non-image attachments (PDFs etc.) stay as links.
function renderUpdateBody(u) {
  const images = (u.attachments || []).filter(a => a.mime_type.startsWith('image/'));
  const files = (u.attachments || []).filter(a => !a.mime_type.startsWith('image/'));
  return `
    <p style="white-space:pre-wrap">${esc(u.body)}</p>
    ${images.map(a => `<p><img src="/uploads/updates/${esc(a.path)}" alt="${esc(a.filename)}" style="max-width:100%;height:auto;"></p>`).join('')}
    ${files.length ? `<p><strong>Attachments:</strong></p><ul>${files.map(a => `<li><a href="/uploads/updates/${esc(a.path)}" target="_blank">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
  `;
}

// Shared "Updates" inbox renderer for the shul/store portal — both call this
// with their own container id. Unread updates are marked read as soon as
// they're opened in the detail modal.
async function loadUpdatesInbox(containerId) {
  const el = qs('#' + containerId);
  el.innerHTML = '<p class="small-muted">Loading…</p>';
  try {
    const { updates } = await api('/updates/inbox/mine');
    el.innerHTML = updates.length ? updates.map(u => `<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openInboxUpdate('${u.recipient_id}')">
        <div class="flex-between"><strong>${esc(u.title)}</strong>${u.read_at ? '' : badge('new','active')}</div>
        <p class="small-muted">${fmtDateTime(u.created_at)}</p>
      </div>`).join('') : '<p class="small-muted">No updates yet.</p>';
    window._inboxUpdates = updates;
  } catch (err) { el.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}
window.openInboxUpdate = async (recipientId) => {
  const u = (window._inboxUpdates || []).find(x => x.recipient_id === recipientId);
  if (!u) return;
  openModal(u.title, renderUpdateBody(u));
  if (!u.read_at) { try { await api(`/updates/inbox/${recipientId}/read`, { method: 'POST' }); } catch {} }
};

// Fills a <select id="selectId"> with every season plus an "All Seasons"
// option, selects the currently active season by default, and returns its
// id (or '' if there is no active season yet) so the caller can seed its
// list-page filter state before the first load().
async function populateSeasonFilter(selectId) {
  try {
    const [{ seasons }, { season: active }] = await Promise.all([api('/seasons'), api('/seasons/active')]);
    const el = qs('#' + selectId);
    if (!el) return active?.id || '';
    el.innerHTML = `<option value="">All Seasons</option>` + seasons.map(s => `<option value="${s.id}" ${active && s.id === active.id ? 'selected' : ''}>${esc(s.name)}${active && s.id === active.id ? ' (active)' : ''}</option>`).join('');
    return active?.id || '';
  } catch { return ''; }
}

// Shared "View Other Seasons" popup for shul/applicant/store detail views.
// Shuls and applicants get a fresh record each season, so `endpoint` returns
// likely matches in other seasons by identifying field; stores are one
// persistent record, so their endpoint returns real per-season activity
// instead. Either shape renders fine here since both return a small array.
async function showOtherSeasons(entityLabel, endpoint, reopen) {
  try {
    const data = await api(endpoint);
    const rows = data.matches || data.seasons || [];
    const body = rows.length ? `<table><thead><tr><th>Season</th><th>${data.matches ? 'Status' : 'Activity'}</th><th></th></tr></thead><tbody>
      ${rows.map(r => data.matches
        ? `<tr><td>${esc(r.season_name || 'Unknown season')}</td><td>${badge(r.status || r.approval_status || '', r.status || r.approval_status || '')}</td>
             <td><button class="btn btn-sm btn-outline" onclick="closeModal(); ${reopen}('${r.id}')">Open</button></td></tr>`
        : `<tr><td>${esc(r.season_name || 'Unknown season')}</td><td>${r.txn_count} transaction(s), $${(+r.total_purchases).toFixed(2)} in purchases</td><td></td></tr>`
      ).join('')}</tbody></table>` : `<p class="small-muted">No other seasons found for this ${entityLabel} yet.</p>`;
    openModal(`${entityLabel}: Other Seasons`, body, `<button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button>`);
  } catch (err) { toast(err.message, true); }
}

// Searchable dropdown for picking a shul by name instead of pasting a raw
// ID. `inputId` is the visible text input; `hiddenId` is a hidden input
// that ends up holding the selected shul's id (what actually gets
// submitted). Reuses the Places-autocomplete dropdown styling. Debounced,
// searches via the admin shuls list endpoint so every shul (any status) is
// reachable, not just approved/public ones.
function attachShulSearchSelect(inputId, hiddenId, initialLabel = '') {
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(hiddenId);
  if (!input || !hidden) return;
  if (initialLabel) input.value = initialLabel;
  input.parentElement.style.position = input.parentElement.style.position || 'relative';
  let dropdown = null;
  let debounceTimer = null;
  function closeDropdown() { if (dropdown) { dropdown.remove(); dropdown = null; } }
  input.addEventListener('input', () => {
    hidden.value = '';
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { closeDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const { shuls } = await api('/shuls?search=' + encodeURIComponent(q) + '&pageSize=10');
        closeDropdown();
        if (!shuls.length) return;
        dropdown = document.createElement('div');
        dropdown.className = 'places-dropdown';
        dropdown.innerHTML = shuls.map(s => `<div class="places-dropdown-item" data-id="${s.id}" data-label="${esc(s.name_en)}">${esc(s.name_en)}${s.city ? ` <span class="small-muted">(${esc(s.city)}, ${esc(s.state||'')})</span>` : ''}</div>`).join('');
        input.parentElement.appendChild(dropdown);
        dropdown.querySelectorAll('.places-dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            input.value = item.dataset.label;
            hidden.value = item.dataset.id;
            closeDropdown();
          });
        });
      } catch { /* leave the field editable even if search fails */ }
    }, 300);
  });
  document.addEventListener('click', (e) => { if (dropdown && !input.parentElement.contains(e.target)) closeDropdown(); });
}

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
      ${d.status === 'signed' ? `<button class="btn btn-sm btn-outline" onclick="retractDocumentSignature('${d.id}','${entityType}','${entityId}','${containerId}','${safeEmail}')">Retract Signature</button>` : ''}
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
window.retractDocumentSignature = async (docId, entityType, entityId, containerId, defaultEmail) => {
  if (!confirm('Retract this signature? The document will go back to unsigned and can be signed again.')) return;
  try { await api(`/documents/${docId}/retract`, { method: 'POST' }); toast('Signature retracted'); loadDocumentsTab(entityType, entityId, containerId, defaultEmail); } catch (err) { toast(err.message, true); }
};
window.viewDocumentPdf = (docId) => viewAuthed(`/documents/${docId}/pdf`);

// Kept as a no-op call site for public-facing pages (login/apply/sign-*/form)
// that still call it — there is no footer mark to render anymore.
function renderPublicFooter() {}

// Polls a list endpoint's row count (for whatever filters/search/page the
// caller's own load() would currently use) and, if it changed, shows a
// small dismiss-to-refresh banner instead of silently rewriting the table.
// This is the whole point: another admin adding/removing a record must
// never yank anyone else's scroll position, open filters, or row selection
// out from under them — so nothing on screen changes until the viewer
// actually clicks the banner, which just calls their page's own load().
// Paused while the tab is hidden (nothing to disrupt if no one's looking).
function attachLiveRefresh(bannerContainerId, fetchTotal, loadFn, intervalMs = 15000) {
  let knownTotal = null;
  let bannerShown = false;
  async function check() {
    if (bannerShown || document.hidden) return;
    try {
      const total = await fetchTotal();
      if (knownTotal === null) { knownTotal = total; return; }
      if (total !== knownTotal) {
        bannerShown = true;
        const container = document.getElementById(bannerContainerId);
        if (!container) return;
        const banner = document.createElement('div');
        banner.className = 'card';
        banner.style.cssText = 'margin-bottom:14px;background:var(--brand-panel-2);cursor:pointer;text-align:center;padding:10px 16px;font-size:13px;';
        banner.textContent = 'New data is available — click to refresh this list';
        banner.onclick = () => { banner.remove(); bannerShown = false; knownTotal = null; loadFn(); };
        container.prepend(banner);
      }
    } catch { /* transient network hiccup — just try again next tick */ }
  }
  setInterval(check, intervalMs);
}

// Lets an admin choose which columns show in a list view, and in what
// order, persisted to their own account (routes/preferences.js) — follows
// them across devices/browsers, not just this one. `columns` is the full
// available set [{key,label}]; `storageKey` picks which saved preference to
// load/save (e.g. 'columns_applicants'); `defaultOrder` is the fallback
// list of visible column keys when nothing's been saved yet. Wires a
// "Customize Columns" button (by id) to open the editor; `onChange(order)`
// is called with the new visible-column-keys array whenever it's saved.
// Returns a promise resolving to the currently-effective order, so the
// caller's first render can use it immediately rather than waiting on a
// separate callback.
async function attachColumnCustomizer(buttonId, storageKey, columns, defaultOrder, onChange) {
  let order = defaultOrder;
  try {
    const { value } = await api(`/preferences/${storageKey}`);
    if (Array.isArray(value) && value.length) order = value.filter(k => columns.some(c => c.key === k));
  } catch { /* use default */ }

  let draft = null;
  function renderList() {
    if (!draft) draft = [...order, ...columns.map(c => c.key).filter(k => !order.includes(k))];
    qs('#col-customizer-list').innerHTML = draft.map((key, i) => {
      const col = columns.find(c => c.key === key);
      const visible = order.includes(key);
      return `<div class="card" style="margin:6px 0;padding:8px 12px;display:flex;align-items:center;gap:10px">
        <label class="checkbox-row" style="flex:1;margin:0"><input type="checkbox" ${visible ? 'checked' : ''} onchange="window.__toggleCustomCol('${key}')"> ${esc(col.label)}</label>
        <button type="button" class="btn btn-sm btn-outline" onclick="window.__moveCustomCol('${key}',-1)" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="window.__moveCustomCol('${key}',1)" ${i === draft.length - 1 ? 'disabled' : ''}>&darr;</button>
      </div>`;
    }).join('');
  }
  window.__toggleCustomCol = (key) => {
    if (order.includes(key)) order = order.filter(k => k !== key);
    else { order.push(key); order = draft.filter(k => order.includes(k)); }
    renderList();
  };
  window.__moveCustomCol = (key, dir) => {
    const i = draft.indexOf(key), j = i + dir;
    if (j < 0 || j >= draft.length) return;
    [draft[i], draft[j]] = [draft[j], draft[i]];
    order = draft.filter(k => order.includes(k));
    renderList();
  };
  window.__saveCustomCols = async () => {
    try { await api(`/preferences/${storageKey}`, { method: 'PUT', body: { value: order } }); closeModal(); onChange(order); } catch (err) { toast(err.message, true); }
  };

  const btn = document.getElementById(buttonId);
  if (btn) btn.addEventListener('click', () => {
    draft = null;
    openModal('Customize Columns', `<p class="small-muted">Choose which columns to show, and use the arrows to reorder them.</p><div id="col-customizer-list"></div>`,
      `<button class="btn btn-primary btn-sm" onclick="window.__saveCustomCols()">Save</button>`);
    renderList();
  });
  return order;
}

// Checks a built-in public application form's schedule (opens_at/closes_at,
// is_active) before letting the caller show its form. Returns true if the
// form is open for submissions; on false, it has already hidden `formSelector`
// and rendered a "not open yet"/"closed" card in its place, so callers just
// need to bail out of their own init logic. Missing/unreachable config
// (network hiccup, pre-migration env) fails open — never block a real
// applicant because this one check couldn't be made.
async function guardFormWindow(slug, formSelector) {
  try {
    const { windowError } = await api(`/forms/public/${slug}`);
    if (!windowError) return true;
    const form = qs(formSelector);
    if (form) {
      const notice = document.createElement('div');
      notice.className = 'card';
      notice.style.textAlign = 'center';
      notice.innerHTML = `<h3>Not accepting submissions</h3><p class="small-muted">${esc(windowError)}</p>`;
      form.replaceWith(notice);
    }
    return false;
  } catch { return true; }
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
