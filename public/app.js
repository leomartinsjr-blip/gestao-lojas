// ── Config ─────────────────────────────────────────────────────────────────
const BOARDS = {
  escritorio: { label: 'Escritório',  color: '#8B949E' },
  delrey:     { label: 'Del Rey',     color: '#58A6FF' },
  minas:      { label: 'Minas',       color: '#3FB950' },
  contagem:   { label: 'Contagem',    color: '#D29922' },
  estacao:    { label: 'Estação',     color: '#F85149' },
  tommy:      { label: 'Tommy',       color: '#22D3EE' },
  lez:        { label: 'Lez a Lez',   color: '#F472B6' },
};

const SECTIONS = {
  performance:   { label: 'Performance',        icon: '📈', type: 'notes' },
  estoque_marca: { label: 'Estoque por Marca',  icon: '🏷️', type: 'notes' },
  estoque_grupo: { label: 'Estoque por Grupo',  icon: '📦', type: 'notes' },
  pauta:         { label: 'Pauta de Reunião',   icon: '📋', type: 'pauta' },
  pendencias:    { label: 'Pendências',         icon: '⚡', type: 'pendencias' },
};

const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── State ──────────────────────────────────────────────────────────────────
const S = { year: 2026, month: 5, data: null, user: null };

let saveTimeout = null;

// ── API ────────────────────────────────────────────────────────────────────
const base = (y, m, b, s) => `/api/${y}/${m}/${b}/${s}`;

async function apiFetch(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function uploadFile(y, m, b, s, file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`/api/attachments/${y}/${m}/${b}/${s}`, { method: 'POST', body: fd });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  return JSON.parse(text);
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showSaving() { document.getElementById('saveIndicator').classList.remove('hidden'); }
function hideSaving()  { document.getElementById('saveIndicator').classList.add('hidden'); }

// ── Auth ───────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('topbar').classList.add('hidden');
  document.getElementById('boardContainer').innerHTML = '';
  document.getElementById('loginUser').focus();
}

function hideLogin() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('topbar').classList.remove('hidden');
}

async function checkAuth() {
  try {
    S.user = await apiFetch('GET', '/api/me');
    hideLogin();
    document.getElementById('userChip').textContent = S.user.label || S.user.username;
    const now = new Date();
    S.year  = now.getFullYear();
    S.month = now.getMonth() + 1;
    updateLabel();
    loadData();
  } catch {
    showLogin();
  }
}

function initLoginForm() {
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    if (!username || !password) return;

    btn.disabled = true;
    btn.textContent = 'Entrando…';
    errEl.classList.add('hidden');

    try {
      S.user = await apiFetch('POST', '/api/login', { username, password });
      document.getElementById('loginPass').value = '';
      document.getElementById('userChip').textContent = S.user.label || S.user.username;
      hideLogin();
      const now = new Date();
      S.year  = now.getFullYear();
      S.month = now.getMonth() + 1;
      updateLabel();
      loadData();
    } catch (err) {
      let msg = 'Usuário ou senha incorretos';
      try { msg = JSON.parse(err.message).error || msg; } catch {}
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      document.getElementById('loginPass').value = '';
      document.getElementById('loginPass').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
}

async function logout() {
  try { await apiFetch('POST', '/api/logout'); } catch {}
  S.user = null;
  showLogin();
}

// ── Month navigation ───────────────────────────────────────────────────────
function updateLabel() {
  document.getElementById('currentMonthLabel').textContent =
    `${MONTHS_PT[S.month - 1]} ${S.year}`;
}

function navigate(delta) {
  S.month += delta;
  if (S.month > 12) { S.month = 1; S.year++; }
  if (S.month < 1)  { S.month = 12; S.year--; }
  updateLabel();
  loadData();
}

// ── Load data ──────────────────────────────────────────────────────────────
async function loadData() {
  document.getElementById('boardContainer').innerHTML =
    '<div class="loading"><div class="spinner"></div> Carregando…</div>';
  try {
    S.data = await apiFetch('GET', `/api/data/${S.year}/${S.month}`);
    renderBoards();
    refreshPicker();
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('autenticado')) { showLogin(); return; }
    document.getElementById('boardContainer').innerHTML =
      `<div class="loading">Erro ao carregar. Servidor está rodando em localhost:3000?</div>`;
    toast('Erro: ' + e.message, true);
  }
}

// ── Render all boards ──────────────────────────────────────────────────────
function visibleBoards() {
  if (!S.user?.board) return Object.entries(BOARDS);
  return Object.entries(BOARDS).filter(([k]) => k === S.user.board);
}

function renderBoards() {
  const c = document.getElementById('boardContainer');
  c.innerHTML = '';
  for (const [bk, bc] of visibleBoards())
    c.appendChild(makeColumn(bk, bc, S.data?.[bk] ?? {}));
}

function makeColumn(bk, bc, bData) {
  const isSolo = !!S.user?.board;
  const pending = countPending(bData);
  const col = el('div', { class: 'column' + (isSolo ? ' solo' : '') });
  col.innerHTML = `
    <div class="col-header">
      <div class="col-dot" style="background:${bc.color}"></div>
      <div class="col-title">${bc.label}</div>
      ${pending ? `<div class="col-badge" id="badge-${bk}">${pending} pendente${pending > 1 ? 's' : ''}</div>` : `<div id="badge-${bk}"></div>`}
    </div>`;
  const body = el('div', { class: 'col-body' + (isSolo ? ' wide' : '') });
  for (const [sk, sc] of Object.entries(SECTIONS))
    body.appendChild(makeSection(bk, sk, sc, bData[sk] ?? { id: null, content: '', items: [], attachments: [] }));
  col.appendChild(body);
  return col;
}

function countPending(bData) {
  return Object.values(bData).reduce((n, sec) =>
    n + (sec.items || []).filter(i => !i.done).length, 0);
}

// ── Section card ───────────────────────────────────────────────────────────
function makeSection(bk, sk, sc, sData) {
  const itemN = (sData.items || []).length;
  const attN  = (sData.attachments || []).length;
  const total = itemN + attN;

  const card = el('div', { class: 'section-card', id: `sec-${bk}-${sk}` });
  const head = el('div', { class: 'sec-header' });
  head.innerHTML = `
    <span class="sec-icon">${sc.icon}</span>
    <span class="sec-title">${sc.label}</span>
    ${total ? `<span class="sec-count" id="cnt-${bk}-${sk}">${total}</span>` : `<span id="cnt-${bk}-${sk}"></span>`}
    <span class="sec-toggle">▾</span>`;
  head.addEventListener('click', () => card.classList.toggle('collapsed'));

  const body = el('div', { class: 'sec-body' });
  if (sc.type === 'pauta') {
    body.appendChild(makePauta(bk, sk, sData));
  } else if (sc.type === 'pendencias') {
    body.appendChild(makePendencias(bk, sk, sData));
  } else {
    body.appendChild(makeNotes(bk, sk, sData));
  }
  body.appendChild(makeAttachments(bk, sk, sData));

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

// ── Notes textarea ─────────────────────────────────────────────────────────
function makeNotes(bk, sk, sData) {
  const ta = el('textarea', { class: 'notes-area', placeholder: 'Anotações, observações…' });
  ta.value = sData.content || '';
  ta.addEventListener('input', () => {
    showSaving();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try { await apiFetch('PUT', `/api/cards/${S.year}/${S.month}/${bk}/${sk}`, { content: ta.value }); }
      catch (e) { toast('Erro ao salvar: ' + e.message, true); }
      hideSaving();
    }, 800);
  });
  return ta;
}

// ── Pauta ──────────────────────────────────────────────────────────────────
function makePauta(bk, sk, sData) {
  const wrap = el('div');
  const list = el('div', { class: 'item-list', id: `list-${bk}-${sk}` });
  (sData.items || []).forEach(item => list.appendChild(makePautaRow(bk, sk, item)));

  const addRow = el('div', { class: 'add-item-row' });
  const inp = el('input', { class: 'add-item-input', type: 'text', placeholder: 'Adicionar pauta (Enter)…' });
  const btn = el('button', { class: 'add-item-btn' });
  btn.textContent = '+';

  const doAdd = async () => {
    const t = inp.value.trim(); if (!t) return;
    try {
      const item = await apiFetch('POST', `/api/items/${S.year}/${S.month}/${bk}/${sk}`, { text: t });
      list.appendChild(makePautaRow(bk, sk, item));
      inp.value = '';
      refreshCounts(bk, sk);
    } catch (e) { toast('Erro: ' + e.message, true); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  btn.addEventListener('click', doAdd);
  addRow.appendChild(inp); addRow.appendChild(btn);
  wrap.appendChild(list); wrap.appendChild(addRow);
  return wrap;
}

function makePautaRow(bk, sk, item) {
  const row = el('div', { class: 'item-row pauta-item' + (item.done ? ' done' : ''), 'data-id': item.id });
  const cb = el('input', { type: 'checkbox', class: 'item-check' });
  if (item.done) cb.checked = true;

  const ta = el('textarea', { class: 'item-text', rows: 1 });
  ta.value = item.text;
  autoResize(ta);
  ta.addEventListener('input', () => autoResize(ta));
  ta.addEventListener('blur', () =>
    apiFetch('PUT', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`, { text: ta.value })
      .catch(e => toast('Erro: ' + e.message, true)));

  cb.addEventListener('change', async () => {
    row.classList.toggle('done', cb.checked);
    try { await apiFetch('PUT', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`, { done: cb.checked }); }
    catch (e) { toast('Erro: ' + e.message, true); cb.checked = !cb.checked; row.classList.toggle('done', cb.checked); }
    refreshCounts(bk, sk);
  });

  const del = el('button', { class: 'item-del', title: 'Remover' });
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    try { await apiFetch('DELETE', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`); row.remove(); refreshCounts(bk, sk); }
    catch (e) { toast('Erro: ' + e.message, true); }
  });
  row.appendChild(cb); row.appendChild(ta); row.appendChild(del);
  return row;
}

// ── Pendências ─────────────────────────────────────────────────────────────
function makePendencias(bk, sk, sData) {
  const wrap = el('div');
  const items = sData.items || [];

  const bar = el('div', { class: 'pend-bar', id: `pbar-${bk}-${sk}` });
  const prog = el('div', { class: 'pend-progress' });
  const fill = el('div', { class: 'pend-fill' });
  const lbl = el('span', { id: `plbl-${bk}-${sk}` });
  prog.appendChild(fill);
  bar.appendChild(prog); bar.appendChild(lbl);
  updatePendBar(bk, sk, items);

  const list = el('div', { class: 'item-list', id: `list-${bk}-${sk}` });
  items.forEach(item => list.appendChild(makePendRow(bk, sk, item)));

  const addRow = el('div', { class: 'add-item-row' });
  const inp = el('input', { class: 'add-item-input', type: 'text', placeholder: 'Nova pendência (Enter)…' });
  const btn = el('button', { class: 'add-item-btn' });
  btn.textContent = '+';

  const doAdd = async () => {
    const t = inp.value.trim(); if (!t) return;
    try {
      const item = await apiFetch('POST', `/api/items/${S.year}/${S.month}/${bk}/${sk}`, { text: t });
      list.appendChild(makePendRow(bk, sk, item));
      inp.value = '';
      refreshPendBar(bk, sk);
      refreshCounts(bk, sk);
      refreshBadge(bk);
    } catch (e) { toast('Erro: ' + e.message, true); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  btn.addEventListener('click', doAdd);
  addRow.appendChild(inp); addRow.appendChild(btn);

  wrap.appendChild(bar); wrap.appendChild(list); wrap.appendChild(addRow);
  return wrap;
}

function makePendRow(bk, sk, item) {
  const row = el('div', { class: 'item-row' + (item.done ? ' done' : ''), 'data-id': item.id });
  const cb = el('input', { type: 'checkbox', class: 'item-check' });
  if (item.done) cb.checked = true;
  const ta = el('textarea', { class: 'item-text', rows: 1 });
  ta.value = item.text;
  autoResize(ta);
  ta.addEventListener('input', () => autoResize(ta));
  ta.addEventListener('blur', () =>
    apiFetch('PUT', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`, { text: ta.value })
      .catch(e => toast('Erro: ' + e.message, true)));

  cb.addEventListener('change', async () => {
    row.classList.toggle('done', cb.checked);
    try { await apiFetch('PUT', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`, { done: cb.checked }); }
    catch (e) { toast('Erro: ' + e.message, true); cb.checked = !cb.checked; row.classList.toggle('done', cb.checked); }
    refreshPendBar(bk, sk);
    refreshBadge(bk);
  });

  const del = el('button', { class: 'item-del', title: 'Remover' });
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    try { await apiFetch('DELETE', `/api/items/${S.year}/${S.month}/${bk}/${sk}/${item.id}`); row.remove(); refreshPendBar(bk, sk); refreshCounts(bk, sk); refreshBadge(bk); }
    catch (e) { toast('Erro: ' + e.message, true); }
  });
  row.appendChild(cb); row.appendChild(ta); row.appendChild(del);
  return row;
}

// ── Attachments ────────────────────────────────────────────────────────────
function makeAttachments(bk, sk, sData) {
  const wrap = el('div', { class: 'attach-section', id: `atw-${bk}-${sk}` });
  const list = el('div', { class: 'attach-list', id: `atl-${bk}-${sk}` });

  if ((sData.attachments || []).length > 0) {
    const lbl = el('div', { class: 'attach-label' }); lbl.textContent = 'Anexos';
    wrap.appendChild(lbl);
  }
  (sData.attachments || []).forEach(att => list.appendChild(makeAttItem(bk, sk, att)));

  const zone = el('div', { class: 'dropzone' });
  const fi = el('input', { type: 'file', multiple: true });
  const span = el('span'); span.textContent = '📎 Clique ou arraste arquivos aqui';
  zone.appendChild(fi); zone.appendChild(span);

  zone.addEventListener('click', () => fi.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); doUpload(bk, sk, e.dataTransfer.files, list, wrap); });
  fi.addEventListener('change', () => { doUpload(bk, sk, fi.files, list, wrap); fi.value = ''; });

  wrap.appendChild(list);
  wrap.appendChild(zone);
  return wrap;
}

function makeAttItem(bk, sk, att) {
  const row = el('div', { class: 'attach-item', 'data-id': att.id });
  const url = `/uploads/${att.filename}`;
  const isImg = att.mimetype?.startsWith('image/');

  let iconEl;
  if (isImg) {
    iconEl = el('img', { class: 'attach-thumb', src: url, alt: att.originalName || att.original_name });
    iconEl.addEventListener('click', e => { e.stopPropagation(); openImg(url); });
  } else {
    iconEl = el('span', { class: 'attach-icon' });
    iconEl.textContent = fileIcon(att.mimetype, att.originalName || att.original_name || '');
  }

  const info = el('div', { class: 'attach-info' });
  const nm = el('span', { class: 'attach-name' });
  const a = el('a', { href: url, target: '_blank', download: att.originalName || att.original_name || 'file' });
  a.textContent = att.originalName || att.original_name || 'arquivo';
  nm.appendChild(a);
  const sz = el('span', { class: 'attach-size' });
  sz.textContent = fmtSize(att.size);
  info.appendChild(nm); info.appendChild(sz);

  const del = el('button', { class: 'attach-del', title: 'Remover' });
  del.textContent = '✕';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Remover "${att.originalName || att.original_name}"?`)) return;
    try { await apiFetch('DELETE', `/api/attachments/${S.year}/${S.month}/${bk}/${sk}/${att.id}`); row.remove(); refreshCounts(bk, sk); }
    catch (e) { toast('Erro: ' + e.message, true); }
  });

  row.appendChild(iconEl); row.appendChild(info); row.appendChild(del);
  return row;
}

async function doUpload(bk, sk, files, listEl, wrapEl) {
  showSaving();
  for (const file of files) {
    try {
      const att = await uploadFile(S.year, S.month, bk, sk, file);
      if (!wrapEl.querySelector('.attach-label')) {
        const lbl = el('div', { class: 'attach-label' }); lbl.textContent = 'Anexos';
        wrapEl.insertBefore(lbl, listEl);
      }
      listEl.appendChild(makeAttItem(bk, sk, att));
      refreshCounts(bk, sk);
      toast(`"${file.name}" enviado ✓`);
    } catch (err) { toast(`Erro ao enviar "${file.name}": ${err.message}`, true); }
  }
  hideSaving();
}

// ── UI refresh helpers ─────────────────────────────────────────────────────
function updatePendBar(bk, sk, items) {
  const total = items.length;
  const done  = items.filter(i => i.done).length;
  const pct   = total ? (done / total * 100).toFixed(0) : 0;
  const fill  = document.querySelector(`#pbar-${bk}-${sk} .pend-fill`);
  const lbl   = document.getElementById(`plbl-${bk}-${sk}`);
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent = `${done}/${total} resolvida${done !== 1 ? 's' : ''}`;
}

function refreshPendBar(bk, sk) {
  const list = document.getElementById(`list-${bk}-${sk}`);
  if (!list) return;
  const rows = [...list.querySelectorAll('.item-row')];
  updatePendBar(bk, sk, rows.map(r => ({ done: r.classList.contains('done') })));
}

function refreshBadge(bk) {
  let n = 0;
  document.querySelectorAll(`#list-${bk}-pendencias .item-row:not(.done)`).forEach(() => n++);
  const b = document.getElementById(`badge-${bk}`);
  if (!b) return;
  b.textContent = n ? `${n} pendente${n > 1 ? 's' : ''}` : '';
  b.className = n ? 'col-badge' : '';
}

function refreshCounts(bk, sk) {
  const card = document.getElementById(`sec-${bk}-${sk}`);
  if (!card) return;
  const n = card.querySelectorAll('.item-row').length + card.querySelectorAll('.attach-item').length;
  const cnt = document.getElementById(`cnt-${bk}-${sk}`);
  if (!cnt) return;
  cnt.textContent = n || '';
  cnt.className = n ? 'sec-count' : '';
}

// ── Month picker dropdown ──────────────────────────────────────────────────
async function refreshPicker() {
  try {
    const months = await apiFetch('GET', '/api/months');
    const sel = document.getElementById('monthPicker');
    sel.innerHTML = '<option value="">Histórico</option>' +
      months.map(m => {
        const v = `${m.year}-${String(m.month).padStart(2,'0')}`;
        const cur = S.year === m.year && S.month === m.month;
        return `<option value="${v}" ${cur ? 'selected' : ''}>${MONTHS_PT[m.month-1]} ${m.year}</option>`;
      }).join('');
  } catch {}
}

// ── Utilities ──────────────────────────────────────────────────────────────
function el(tag, attrs = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  return e;
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function fileIcon(mime, name) {
  if (!mime && !name) return '📎';
  if (mime?.includes('pdf')) return '📄';
  if (mime?.includes('sheet') || mime?.includes('excel') || /\.xlsx?$/i.test(name)) return '📊';
  if (mime?.includes('word') || /\.docx?$/i.test(name)) return '📝';
  if (mime?.startsWith('image/')) return '🖼️';
  if (mime?.includes('zip') || /\.rar$/i.test(name)) return '🗜️';
  if (mime?.includes('presentation') || /\.pptx?$/i.test(name)) return '📊';
  return '📎';
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function openImg(url) {
  document.getElementById('imgModalSrc').src = url;
  document.getElementById('imgModal').classList.remove('hidden');
}

// ── Performance dashboard data ─────────────────────────────────────────────
const PERF_MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const PERF_AVAIL  = new Set(['delrey','minas','contagem','estacao']);
const PERF_LAST3  = [1,2,3];  // Fev, Mar, Abr
const PERF_CUR    = 4;         // Mai = em andamento

const PERF_HIST = {
  delrey: {
    2022:[165385,168003,234286,266401,302791,322301,283809,281544,270658,273128,233726,702491],
    2023:[231820,192965,260198,234835,267007,302000,278639,221782,254105,234534,241181,652603],
    2024:[174910,178876,191244,173915,220048,274312,220773,233149,207684,236554,241121,593236],
    2025:[150997,158402,162633,184631,213998,209802,173548,175903,143292,154790,187029,464571],
  },
  minas: {
    2022:[101449,129106,130745,166964,198381,220050,201689,198955,191943,200837,180878,514329],
    2023:[118853,105532,144239,181543,152731,215775,205750,168377,164027,167674,197156,505851],
    2024:[135127,117994,127568,127094,227156,257343,193379,178546,157503,160880,175101,447639],
    2025:[ 98983, 91461,105495,115230,150991,147786,126240,115365, 99045,118324,133660,302529],
  },
  contagem: {
    2022:[ 75351,120411,103442,117390,127365,170520,144453,150177,159697,176077,141331,421069],
    2023:[ 92988,100147,137226,154869,141846,243307,145699,145539,156978,185615,184176,507843],
    2024:[105428,130652,165039,154035,168401,226380,184509,165067,139761,170188,183280,440048],
    2025:[ 75089, 93885,121349,122032,134839,164378,109811,113459, 99929,115189,140320,375454],
  },
  estacao: {
    2022:[ 71131,124643,124185,159666,204231,238665,186935,178579,198684,206929,174409,496569],
    2023:[122651,122411,149445,196218,144786,288928,167382,157945,183392,197120,203826,594567],
    2024:[109284,122665,133511,143844,188523,180783,158848,160592,130708,146317,155069,381802],
    2025:[116994, 92631, 95410,132345,134779,146808,116226,110715,104962,121011,117370,302912],
  },
};
const PERF_2026 = {
  delrey:   [134642,119759,128296,128061,null,null,null,null,null,null,null,null],
  minas:    [ 90962, 65116, 90731, 68912,null,null,null,null,null,null,null,null],
  contagem: [ 79523, 81210, 93198,110985,null,null,null,null,null,null,null,null],
  estacao:  [ 72779, 77070, 95819, 78318,null,null,null,null,null,null,null,null],
};

function fmtBRL(n)  { return 'R$ ' + Math.round(n).toLocaleString('pt-BR'); }
function fmtBRLk(n) {
  if (n >= 1e6) return 'R$ ' + (n/1e6).toFixed(1).replace('.',',') + 'M';
  if (n >= 1e3) return 'R$ ' + (n/1e3).toFixed(0) + 'k';
  return fmtBRL(n);
}

function calcPerfMetrics(k) {
  const d25 = PERF_HIST[k][2025];
  const d26 = PERF_2026[k];
  const yoyReal = d26.map((v,i) => v !== null ? (v - d25[i]) / d25[i] * 100 : null);
  const last3   = PERF_LAST3.map(i => yoyReal[i]);
  const avgD    = last3.reduce((a,b) => a+b, 0) / 3;
  const proj    = PERF_MONTHS.map((_,i) => {
    if (d26[i] !== null) return d26[i];
    return Math.round(d25[i] * (1 + avgD/100));
  });
  const yoyFull = proj.map((v,i) => v !== null ? (v - d25[i]) / d25[i] * 100 : null);
  const realAcum = d26.slice(0, PERF_CUR).reduce((a,v) => a+(v||0), 0);
  const projRest = proj.slice(PERF_CUR).reduce((a,v) => a+(v||0), 0);
  const projTotal = realAcum + projRest;
  const total25 = d25.reduce((a,b) => a+b, 0);
  return { d25, d26, yoyReal, yoyFull, last3, avgD, proj, realAcum, projTotal, total25 };
}

let perfChart = null, perfAnnualChart = null;

const ALL_STORES = ['delrey','minas','contagem','estacao','tommy','lez'];
const PD = { board: null, year: null, month: null, data: null };

function _perfActiveView() {
  return document.querySelector('.perf-view-tab.active')?.dataset.view || 'analise';
}

function openPerfModal() {
  document.getElementById('perfOverlay').classList.remove('hidden');
  const defaultStore = S.user?.board && S.user.board !== 'escritorio' ? S.user.board : 'delrey';
  PD.board = defaultStore;
  PD.year  = S.year;
  PD.month = S.month;
  buildPerfTabs();
  document.querySelectorAll('.perf-view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === 'analise'));
  renderPerfStore(defaultStore);
}

function closePerfModal() {
  document.getElementById('perfOverlay').classList.add('hidden');
  if (perfChart) { perfChart.destroy(); perfChart = null; }
  if (perfAnnualChart) { perfAnnualChart.destroy(); perfAnnualChart = null; }
}

function buildPerfTabs() {
  const tabs = document.getElementById('perfStoreTabs');
  tabs.innerHTML = '';
  const show = !S.user?.board || S.user.board === 'escritorio' ? ALL_STORES : [S.user.board];
  if (show.length <= 1) return;
  show.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'perf-tab-btn';
    btn.dataset.store = k;
    btn.textContent = BOARDS[k]?.label || k;
    btn.style.borderColor = BOARDS[k]?.color || '#8B949E';
    btn.style.color = BOARDS[k]?.color || '#8B949E';
    btn.addEventListener('click', () => {
      PD.board = k;
      document.querySelectorAll('.perf-view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === 'analise'));
      renderPerfStore(k);
    });
    tabs.appendChild(btn);
  });
}

function renderPerfStore(k) {
  PD.board = k;
  // Update tab active state
  const color = BOARDS[k]?.color || '#8B949E';
  document.querySelectorAll('.perf-tab-btn').forEach(btn => {
    const active = btn.dataset.store === k;
    btn.classList.toggle('active', active);
    btn.style.background = active ? color : 'transparent';
    btn.style.color = active ? '#0D1117' : (BOARDS[btn.dataset.store]?.color || '#8B949E');
  });

  const body = document.getElementById('perfBody');

  if (!PERF_AVAIL.has(k)) {
    body.innerHTML = `<div class="perf-no-data">Dados de performance não disponíveis para esta loja.<br>O dashboard cobre: Del Rey, Minas, Contagem e Estação.</div>`;
    return;
  }

  const m = calcPerfMetrics(k);
  const pProj = (m.projTotal - m.total25) / m.total25 * 100;
  const sign  = n => n > 0 ? '+' : '';
  const cls   = n => n >= 0 ? 'pf-pos' : 'pf-neg';

  // ── KPI badges ──────────────────────────────────────────────────────────
  const kpiHtml = `
    <div class="perf-kpis">
      <div class="perf-kpi">
        <div class="perf-kpi-label">Total 2025</div>
        <div class="perf-kpi-value">${fmtBRLk(m.total25)}</div>
        <div class="perf-kpi-sub">referência</div>
      </div>
      <div class="perf-kpi">
        <div class="perf-kpi-label">Acumulado Jan–Abr/26</div>
        <div class="perf-kpi-value">${fmtBRLk(m.realAcum)}</div>
        <div class="perf-kpi-sub">dados reais</div>
      </div>
      <div class="perf-kpi" style="border-color:${m.avgD < -10 ? '#F85149' : 'var(--border)'}">
        <div class="perf-kpi-label">Média últimos 3 meses</div>
        <div class="perf-kpi-value ${cls(m.avgD)}">${sign(m.avgD)}${m.avgD.toFixed(1)}%</div>
        <div class="perf-kpi-sub">Fev ${m.last3[0].toFixed(1)}% · Mar ${m.last3[1].toFixed(1)}% · Abr ${m.last3[2].toFixed(1)}%</div>
      </div>
      <div class="perf-kpi" style="border-color:#D2992255">
        <div class="perf-kpi-label">Projeção 2026 (ano)</div>
        <div class="perf-kpi-value">${fmtBRLk(m.projTotal)}</div>
        <div class="perf-kpi-sub ${cls(pProj)}">${sign(pProj)}${pProj.toFixed(1)}% vs 2025</div>
      </div>
    </div>`;

  // ── Annual history ────────────────────────────────────────────────────────
  const HIST_YEARS = [2022, 2023, 2024, 2025];
  const annualTotals = HIST_YEARS.map(y => PERF_HIST[k][y].reduce((a,b) => a+b, 0));
  const annualYoY    = annualTotals.map((v,i) => i === 0 ? null : (v - annualTotals[i-1]) / annualTotals[i-1] * 100);

  // ── Projection table ─────────────────────────────────────────────────────
  let tableHtml = `
    <div class="perf-chart-box">
      <div class="perf-chart-title">Histórico Mensal — 2022 a 2026</div>
      <div style="overflow-x:auto">
      <table class="perf-proj-table">
        <thead><tr>
          <th>Mês</th>
          <th>2022</th><th>Δ</th>
          <th>2023</th><th>Δ</th>
          <th>2024</th><th>Δ</th>
          <th>2025 (ref)</th><th>Δ</th>
          <th>2026</th><th>Δ 26/25</th>
        </tr></thead><tbody>`;
  const histYears = [2022, 2023, 2024, 2025];
  let colTotals = { 2022:0, 2023:0, 2024:0, 2025:0, v26:0 };
  PERF_MONTHS.forEach((mn, i) => {
    const h = histYears.map(y => PERF_HIST[k][y][i]);
    const real = m.d26[i];
    const proj = m.proj[i];
    const v26  = real !== null ? real : proj;
    const isProj = real === null && v26 !== null;
    histYears.forEach(y => { colTotals[y] += PERF_HIST[k][y][i]; });
    if (v26 !== null) colTotals.v26 += v26;
    const deltas = histYears.map((y,j) => j === 0 ? null : (h[j] - h[j-1]) / h[j-1] * 100);
    const d2625  = v26 !== null ? (v26 - h[3]) / h[3] * 100 : null;
    const projTag = isProj ? ' <span style="color:#D29922;font-size:.62rem">proj</span>' : '';
    tableHtml += `<tr>
      <td style="white-space:nowrap">${mn}${projTag}</td>
      ${h.map((v, j) => `
        <td>${fmtBRL(v)}</td>
        <td class="${deltas[j] !== null ? cls(deltas[j]) : ''}" style="font-size:.72rem;white-space:nowrap">
          ${deltas[j] !== null ? sign(deltas[j])+deltas[j].toFixed(1)+'%' : '—'}
        </td>`).join('')}
      <td style="color:${isProj?'#D29922':'inherit'}">${v26 !== null ? fmtBRL(v26) : '—'}</td>
      <td class="${d2625 !== null ? cls(d2625) : ''}" style="font-size:.72rem;white-space:nowrap">
        ${d2625 !== null ? sign(d2625)+d2625.toFixed(1)+'%' : '—'}
      </td>
    </tr>`;
  });
  // Totals row
  const totDeltas = histYears.map((y,j) => j === 0 ? null : (colTotals[y]-colTotals[histYears[j-1]])/colTotals[histYears[j-1]]*100);
  const tot2625   = (colTotals.v26 - colTotals[2025]) / colTotals[2025] * 100;
  tableHtml += `</tbody><tfoot><tr class="total-row">
    <td>TOTAL</td>
    ${histYears.map((y,j) => `
      <td>${fmtBRL(colTotals[y])}</td>
      <td class="${totDeltas[j]!==null?cls(totDeltas[j]):''}" style="font-size:.72rem">${totDeltas[j]!==null?sign(totDeltas[j])+totDeltas[j].toFixed(1)+'%':'—'}</td>
    `).join('')}
    <td>${fmtBRL(colTotals.v26)}</td>
    <td class="${cls(tot2625)}" style="font-size:.72rem">${sign(tot2625)+tot2625.toFixed(1)+'%'}</td>
  </tr></tfoot></table></div></div>`;

  body.innerHTML = kpiHtml + `
    <div class="perf-chart-box">
      <div class="perf-chart-title">${BOARDS[k]?.label} — Histórico Anual (2022–2026 proj.)</div>
      <div class="perf-chart-sub">Barras: total anual · Linha: variação % vs ano anterior</div>
      <div class="perf-chart-wrap" style="height:220px"><canvas id="perfAnnualCanvas"></canvas></div>
    </div>
    <div class="perf-chart-box">
      <div class="perf-chart-title">${BOARDS[k]?.label} — 2026 vs 2025 (mensal)</div>
      <div class="perf-chart-sub">Barras: faturamento real (Jan–Abr) e projetado (Mai–Dez) · Linha: variação % vs 2025 · Pontos âmbar = base da projeção</div>
      <div class="perf-chart-wrap"><canvas id="perfChartCanvas"></canvas></div>
    </div>` + tableHtml;

  if (perfChart)       { perfChart.destroy();       perfChart = null; }
  if (perfAnnualChart) { perfAnnualChart.destroy(); perfAnnualChart = null; }

  // ── Annual chart ───────────────────────────────────────────────────────
  const annualLabels = [...HIST_YEARS.map(String), '2026 proj'];
  const annualValues = [...annualTotals, m.projTotal];
  const annualColors = ['#484F58','#484F58','#484F58',color+'99',`${color}55`];
  const annualBorders= ['#484F58','#484F58','#484F58',color,color];
  const annualYoYFull= annualValues.map((v,i) => i===0?null:(v-annualValues[i-1])/annualValues[i-1]*100);

  perfAnnualChart = new Chart(document.getElementById('perfAnnualCanvas'), {
    type: 'bar',
    data: {
      labels: annualLabels,
      datasets: [
        { type:'bar', label:'Receita anual', data: annualValues,
          backgroundColor: annualColors, borderColor: annualBorders,
          borderWidth: 1, borderRadius: 4, yAxisID:'y', order:2 },
        { type:'line', label:'Δ% vs ano ant.', data: annualYoYFull,
          borderColor:'#8B949E', fill:false, yAxisID:'y2',
          pointRadius:5, pointBackgroundColor: annualYoYFull.map(v=>v===null?'transparent':v>=0?'#3FB950':'#F85149'),
          pointBorderColor: annualYoYFull.map(v=>v===null?'transparent':v>=0?'#3FB950':'#F85149'),
          tension:.3, borderWidth:1.5, spanGaps:false, order:1 },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{labels:{color:'#8B949E',boxWidth:10,boxHeight:10,font:{size:11}}},
        tooltip:{callbacks:{label:ctx=>{
          if(ctx.dataset.yAxisID==='y2') return ctx.parsed.y!=null?` ${ctx.dataset.label}: ${ctx.parsed.y>0?'+':''}${ctx.parsed.y.toFixed(1)}%`:null;
          return ` ${ctx.dataset.label}: ${fmtBRL(ctx.parsed.y)}`;
        }}}
      },
      scales:{
        x:{grid:{color:'rgba(48,54,61,.6)'},ticks:{color:'#8B949E',maxRotation:0}},
        y:{position:'left',grid:{color:'rgba(48,54,61,.6)'},ticks:{color:'#8B949E',maxRotation:0,callback:v=>fmtBRLk(v)}},
        y2:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#8B949E',maxRotation:0,callback:v=>`${v>0?'+':''}${v.toFixed(0)}%`}},
      }
    }
  });

  // ── Monthly chart ──────────────────────────────────────────────────────
  const barReal = PERF_MONTHS.map((_,i) => i < PERF_CUR ? m.d26[i] : null);
  const barProj = PERF_MONTHS.map((_,i) => i >= PERF_CUR ? m.proj[i] : null);
  const lineReal = PERF_MONTHS.map((_,i) => i < PERF_CUR ? m.yoyReal[i] : null);
  const lineProj = PERF_MONTHS.map((_,i) => i >= PERF_CUR ? m.yoyFull[i] : null);
  const ptColor  = PERF_MONTHS.map((_,i) => PERF_LAST3.includes(i) ? '#D29922' : (m.yoyReal[i]>=0?'#3FB950':'#F85149'));
  const ptSize   = PERF_MONTHS.map((_,i) => PERF_LAST3.includes(i) ? 7 : 3);

  const gridC = 'rgba(48,54,61,.6)';
  const tickC = { color: '#8B949E', maxRotation: 0 };

  perfChart = new Chart(document.getElementById('perfChartCanvas'), {
    type: 'bar',
    data: {
      labels: PERF_MONTHS,
      datasets: [
        { type:'line', label:'2025 (ref.)', data: m.d25,
          borderColor:'#484F58', borderDash:[5,3], borderWidth:1.5,
          fill:false, yAxisID:'y', pointRadius:0, tension:.3, order:0 },
        { type:'bar', label:'2026 Real', data: barReal,
          backgroundColor: color+'CC', borderColor: color,
          borderWidth:1, borderRadius:4, yAxisID:'y', order:2 },
        { type:'bar', label:'2026 Proj.', data: barProj,
          backgroundColor:'rgba(210,153,34,.25)', borderColor:'#D29922',
          borderWidth:2, borderRadius:4, yAxisID:'y', order:3 },
        { type:'line', label:'% real', data: lineReal,
          borderColor:'#F85149', fill:false, yAxisID:'y2',
          pointRadius: ptSize, pointBackgroundColor: ptColor,
          pointBorderColor: ptColor, tension:.35, borderWidth:2, spanGaps:false, order:1 },
        { type:'line', label:'% projetado', data: lineProj,
          borderColor:'#D29922', borderDash:[4,3], fill:false, yAxisID:'y2',
          pointRadius:3, pointBackgroundColor:'#D29922',
          tension:.35, borderWidth:1.5, spanGaps:false, order:1 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { labels: { color:'#8B949E', boxWidth:10, boxHeight:10, font:{size:11} } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.yAxisID === 'y2')
                return ctx.parsed.y != null ? ` ${ctx.dataset.label}: ${ctx.parsed.y>0?'+':''}${ctx.parsed.y.toFixed(1)}%` : null;
              return ctx.parsed.y != null ? ` ${ctx.dataset.label}: ${fmtBRL(ctx.parsed.y)}` : null;
            }
          }
        }
      },
      scales: {
        x: { grid:{color:gridC}, ticks: tickC },
        y: { position:'left', grid:{color:gridC}, ticks:{...tickC, callback:v=>fmtBRLk(v)} },
        y2: { position:'right', grid:{drawOnChartArea:false},
              ticks:{...tickC, callback:v=>`${v>0?'+':''}${v.toFixed(0)}%`} }
      }
    }
  });
}

function initPerfModal() {
  document.getElementById('perfBtn').addEventListener('click', openPerfModal);
  document.getElementById('perfClose').addEventListener('click', closePerfModal);
  document.getElementById('perfOverlay').addEventListener('click', e => {
    if (e.target.id === 'perfOverlay') closePerfModal();
  });
  document.querySelectorAll('.perf-view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.perf-view-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.view === 'analise') renderPerfStore(PD.board);
      else loadAndRenderDaily(PD.board);
    });
  });
}

// ── Daily closing sheet ────────────────────────────────────────────────────
async function loadAndRenderDaily(board) {
  if (!board) board = PD.board || 'delrey';
  PD.board = board;
  const body = document.getElementById('perfBody');
  if (perfChart)       { perfChart.destroy();       perfChart = null; }
  if (perfAnnualChart) { perfAnnualChart.destroy();  perfAnnualChart = null; }
  body.innerHTML = '<div style="text-align:center;padding:2.5rem;color:var(--muted)">Carregando…</div>';
  try {
    const data = await apiFetch('GET', `/api/dailysales/${PD.year}/${PD.month}/${board}`);
    if (typeof data.meta !== 'object') data.meta = { mensal: data.meta || 0, weights: {} };
    if (!data.meta.weights) data.meta.weights = {};
    if (!data.entries)      data.entries = {};
    PD.data = data;
    renderDailySheet(board);
  } catch(e) {
    body.innerHTML = `<div class="perf-no-data">Erro ao carregar: ${e.message}</div>`;
  }
}

function renderDailySheet(board) {
  const isAdmin  = !S.user?.board || S.user.board === 'escritorio';
  const color    = BOARDS[board]?.color || '#8B949E';
  const year     = PD.year, month = PD.month;
  const meta     = PD.data.meta;
  const entries  = PD.data.entries || {};
  const days     = new Date(year, month, 0).getDate();
  const mensal   = meta.mensal || 0;
  const defW     = +(100 / days).toFixed(6);
  const DAY_S    = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  const today    = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const fBRL = v => v != null ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v) : '—';
  const fPct = v => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
  const fNum = v => (v != null && v > 0) ? v.toLocaleString('pt-BR') : '—';

  // Build rows
  let rows = [];
  let metaAccum = 0, realAccum = 0;
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow     = new Date(year, month - 1, d).getDay();
    const w       = meta.weights[dateStr] ?? defW;
    const metaDia = mensal * w / 100;
    metaAccum += metaDia;
    const entry     = entries[dateStr] || null;
    const realizado = entry?.value || 0;
    const pecas     = entry?.pecas  || 0;
    const fluxo     = entry?.fluxo  || 0;
    if (entry) realAccum += realizado;
    const pctMeta = (metaDia > 0 && entry) ? realizado / metaDia * 100 : null;
    const projecao = (metaAccum > 0 && realAccum > 0) ? realAccum / metaAccum * mensal : null;
    const tktMed  = (pecas > 0 && entry) ? realizado / pecas : null;
    rows.push({ d, dateStr, dow, w, metaDia, metaAccum, entry, realizado, pecas, fluxo, realAccum, pctMeta, projecao, tktMed, isToday: dateStr === todayStr });
  }

  const totalReal  = rows.reduce((s, r) => s + (r.entry ? r.realizado : 0), 0);
  const totalPecas = rows.reduce((s, r) => s + (r.entry ? r.pecas : 0), 0);
  const totalFluxo = rows.reduce((s, r) => s + (r.entry ? r.fluxo : 0), 0);
  const totalW     = rows.reduce((s, r) => s + r.w, 0);
  const tktTotal   = totalPecas > 0 ? totalReal / totalPecas : null;
  const pctTotal   = (mensal > 0 && totalReal > 0) ? totalReal / mensal * 100 : null;
  const lastProj   = [...rows].reverse().find(r => r.projecao != null)?.projecao ?? null;
  const metaInput  = mensal > 0 ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',minimumFractionDigits:2}).format(mensal) : '';

  let html = `<div class="ds-wrap">
    <div class="ds-top-bar">
      <div class="ds-meta-row">
        <span class="ds-meta-label">Meta do Mês</span>
        <input type="text" class="ds-meta-input" id="dsMetaInput" value="${metaInput}" placeholder="R$ 0,00" ${!isAdmin ? 'disabled' : ''}>
        ${isAdmin ? `<button class="ds-meta-save-btn" id="dsMetaSaveBtn">Salvar</button>` : ''}
        ${isAdmin ? `<span class="ds-weight-hint">· Clique em <strong>Peso%</strong> para ajustar distribuição diária</span>` : ''}
      </div>
      <span class="ds-month-label">${MONTHS_PT[month-1]} ${year} &mdash; ${BOARDS[board]?.label || board}</span>
    </div>
    <div class="ds-table-wrap"><table class="ds-table">
      <thead><tr>
        <th class="ds-th-dia">Dia</th>
        <th title="Peso % do mês neste dia">Peso%</th>
        <th>Meta Dia</th><th>Meta Acum</th>
        <th>Realizado</th><th>Acumulado</th>
        <th>% Meta</th><th>Projeção</th>
        <th>Peças</th><th>Tkt Méd</th><th>Fluxo</th>
      </tr></thead><tbody>`;

  for (const r of rows) {
    const isWE = r.dow === 0 || r.dow === 6;
    const trCls = [isWE ? 'ds-we' : '', r.isToday ? 'ds-today' : ''].filter(Boolean).join(' ');
    const pCls  = r.pctMeta != null ? (r.pctMeta >= 100 ? 'pf-pos' : r.pctMeta >= 80 ? 'ds-warn' : 'pf-neg') : '';

    html += `<tr class="${trCls}" data-date="${r.dateStr}">
      <td class="ds-td-dia">${r.d}<small class="ds-dow">${DAY_S[r.dow]}</small></td>
      <td class="ds-td-peso${isAdmin ? ' ds-editable' : ''}" data-field="weight" data-date="${r.dateStr}" data-day="${r.d}">${r.w.toFixed(2)}%</td>
      <td class="ds-td-calc">${mensal > 0 ? fBRL(r.metaDia) : '—'}</td>
      <td class="ds-td-calc">${mensal > 0 ? fBRL(r.metaAccum) : '—'}</td>
      <td class="ds-td-edit${r.entry ? ' ds-has-val' : ''}" data-field="value" data-date="${r.dateStr}">${r.entry ? fBRL(r.realizado) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-calc">${r.entry ? fBRL(r.realAccum) : '—'}</td>
      <td class="ds-td-pct ${pCls}">${r.pctMeta != null ? fPct(r.pctMeta) : '—'}</td>
      <td class="ds-td-calc">${r.projecao != null ? fBRL(r.projecao) : '—'}</td>
      <td class="ds-td-edit${r.entry && r.pecas > 0 ? ' ds-has-val' : ''}" data-field="pecas" data-date="${r.dateStr}">${r.entry && r.pecas > 0 ? fNum(r.pecas) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-calc">${r.tktMed != null ? fBRL(r.tktMed) : '—'}</td>
      <td class="ds-td-edit${r.entry && r.fluxo > 0 ? ' ds-has-val' : ''}" data-field="fluxo" data-date="${r.dateStr}">${r.entry && r.fluxo > 0 ? fNum(r.fluxo) : '<span class="ds-empty">—</span>'}</td>
    </tr>`;
  }

  const totPctCls = pctTotal != null ? (pctTotal >= 100 ? 'pf-pos' : pctTotal >= 80 ? 'ds-warn' : 'pf-neg') : '';
  html += `</tbody><tfoot><tr class="ds-total-row">
    <td>TOTAL</td>
    <td>${totalW.toFixed(1)}%</td>
    <td>${mensal > 0 ? fBRL(mensal) : '—'}</td><td>—</td>
    <td>${totalReal > 0 ? fBRL(totalReal) : '—'}</td><td>—</td>
    <td class="${totPctCls}">${pctTotal != null ? fPct(pctTotal) : '—'}</td>
    <td>${lastProj != null ? fBRL(lastProj) : '—'}</td>
    <td>${fNum(totalPecas)}</td>
    <td>${tktTotal != null ? fBRL(tktTotal) : '—'}</td>
    <td>${fNum(totalFluxo)}</td>
  </tr></tfoot></table></div></div>`;

  const body = document.getElementById('perfBody');
  body.innerHTML = html;

  if (isAdmin) {
    document.getElementById('dsMetaSaveBtn')?.addEventListener('click', () => saveDailyMeta(board));
  }
  body.querySelectorAll('.ds-td-edit').forEach(td => {
    td.addEventListener('click', () => startDailyCellEdit(td, board));
  });
  if (isAdmin) {
    body.querySelectorAll('.ds-td-peso.ds-editable').forEach(td => {
      td.addEventListener('click', () => startWeightEdit(td, board));
    });
  }
}

async function saveDailyMeta(board) {
  const raw  = document.getElementById('dsMetaInput').value.replace(/[^\d,\.]/g,'').replace(',','.');
  const mensal = parseFloat(raw) || 0;
  try {
    await apiFetch('POST', `/api/dailysales/${PD.year}/${PD.month}/${board}/meta`, { mensal, weights: PD.data.meta.weights });
    PD.data.meta.mensal = mensal;
    toast('Meta salva ✓');
    renderDailySheet(board);
  } catch(e) { toast('Erro ao salvar meta: ' + e.message, true); }
}

function startDailyCellEdit(td, board) {
  const field   = td.dataset.field;
  const dateStr = td.dataset.date;
  const existing = PD.data.entries[dateStr] || {};
  const isValue  = field === 'value';
  const cur      = existing[field] || 0;

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'ds-cell-input';
  inp.placeholder = isValue ? '0,00' : '0';
  inp.value       = cur > 0 ? (isValue ? cur.toFixed(2).replace('.',',') : cur) : '';
  td.innerHTML = '';
  td.appendChild(inp);
  inp.focus(); inp.select();

  const commit = async () => {
    let val;
    if (isValue) {
      val = parseFloat(inp.value.replace(/\./g,'').replace(',','.')) || 0;
    } else {
      val = parseInt(inp.value.replace(/\D/g,'')) || 0;
    }
    const merged = { value: existing.value||0, pecas: existing.pecas||0, fluxo: existing.fluxo||0 };
    merged[field] = val;
    try {
      if (merged.value === 0 && merged.pecas === 0 && merged.fluxo === 0) {
        await apiFetch('DELETE', `/api/dailysales/${PD.year}/${PD.month}/${board}/${dateStr}`);
        delete PD.data.entries[dateStr];
      } else {
        await apiFetch('PUT', `/api/dailysales/${PD.year}/${PD.month}/${board}/${dateStr}`, merged);
        PD.data.entries[dateStr] = merged;
      }
    } catch(e) { toast('Erro: ' + e.message, true); }
    renderDailySheet(board);
  };

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') renderDailySheet(board);
  });
}

function startWeightEdit(td, board) {
  const dateStr = td.dataset.date;
  const days    = new Date(PD.year, PD.month, 0).getDate();
  const defW    = +(100 / days).toFixed(6);
  const cur     = PD.data.meta.weights[dateStr] ?? defW;

  const inp = document.createElement('input');
  inp.type      = 'number';
  inp.className = 'ds-cell-input';
  inp.value     = cur.toFixed(2);
  inp.step      = '0.01'; inp.min = '0'; inp.max = '100';
  inp.style.width = '65px';
  td.innerHTML = '';
  td.appendChild(inp);
  inp.focus(); inp.select();

  const commit = async () => {
    const val = parseFloat(inp.value) || defW;
    PD.data.meta.weights[dateStr] = val;
    try {
      await apiFetch('POST', `/api/dailysales/${PD.year}/${PD.month}/${board}/meta`, { mensal: PD.data.meta.mensal, weights: PD.data.meta.weights });
    } catch(e) { toast('Erro ao salvar peso: ' + e.message, true); }
    renderDailySheet(board);
  };

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') renderDailySheet(board);
  });
}

// ── Folgas calendar ────────────────────────────────────────────────────────
const FC = { year: null, month: null, employees: [], folgas: [], filterBoard: null };
const DAY_PT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

async function openFolgas() {
  if (!FC.year) { const n = new Date(); FC.year = n.getFullYear(); FC.month = n.getMonth() + 1; }
  document.getElementById('folgasOverlay').classList.remove('hidden');
  await loadFolgasData();
}

function closeFolgas() {
  document.getElementById('folgasOverlay').classList.add('hidden');
}

async function loadFolgasData() {
  try {
    const [emps, folgas] = await Promise.all([
      apiFetch('GET', '/api/employees'),
      apiFetch('GET', `/api/folgas/${FC.year}/${FC.month}`),
    ]);
    FC.employees = emps;
    FC.folgas    = folgas;
    updateFolgasLabel();
    updateFolgasFilterAndForm();
    renderFolgasTable();
  } catch (e) { toast('Erro ao carregar folgas: ' + e.message, true); }
}

function updateFolgasLabel() {
  document.getElementById('folgasMonthLbl').textContent = `${MONTHS_PT[FC.month - 1]} ${FC.year}`;
}

function updateFolgasFilterAndForm() {
  const filterSel = document.getElementById('folgasBoardFilter');
  const boardSel  = document.getElementById('folgasEmpBoard');
  const isAdmin   = !S.user?.board;

  if (isAdmin) {
    filterSel.style.display = '';
    filterSel.innerHTML = '<option value="">Todas as lojas</option>' +
      Object.entries(BOARDS).map(([k,v]) =>
        `<option value="${k}" ${FC.filterBoard===k?'selected':''}>${v.label}</option>`).join('');
    boardSel.style.display = '';
    boardSel.innerHTML = Object.entries(BOARDS)
      .map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  } else {
    filterSel.style.display = 'none';
    boardSel.style.display  = 'none';
  }
}

function renderFolgasTable() {
  const table = document.getElementById('folgasTable');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const daysInMonth = new Date(FC.year, FC.month, 0).getDate();
  const emps = FC.filterBoard
    ? FC.employees.filter(e => e.board === FC.filterBoard)
    : FC.employees;

  // Folga lookup: "empId-date" → folgaId
  const fMap = {};
  for (const f of FC.folgas) fMap[`${f.employeeId}-${f.date}`] = f.id;

  if (emps.length === 0) {
    table.innerHTML = `<tbody><tr class="folgas-empty-row"><td colspan="${daysInMonth+1}">
      Nenhum funcionário cadastrado.<br>Clique em <strong>+ Funcionário</strong> para adicionar.
    </td></tr></tbody>`;
    return;
  }

  // Header
  let html = '<thead><tr><th class="emp-h">Funcionário</th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${FC.year}-${String(FC.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow  = new Date(FC.year, FC.month - 1, d).getDay();
    const isWE = dow === 0 || dow === 6;
    const isToday = date === todayStr;
    html += `<th class="day-h${isWE?' weekend':''}${isToday?' today-col':''}">${d}<br><small>${DAY_PT[dow]}</small></th>`;
  }
  html += '</tr></thead><tbody>';

  // Rows
  for (const emp of emps) {
    const color = BOARDS[emp.board]?.color || '#8B949E';
    const storeLabel = BOARDS[emp.board]?.label || '';
    html += `<tr>
      <td class="emp-col-td">
        <div class="emp-col">
          <span class="emp-dot" style="background:${color}"></span>
          <span class="emp-name">${emp.name}</span>
          ${!S.user?.board ? `<span class="emp-store">${storeLabel}</span>` : ''}
          <button class="emp-del-btn" data-id="${emp.id}" title="Remover">✕</button>
        </div>
      </td>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${FC.year}-${String(FC.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow  = new Date(FC.year, FC.month - 1, d).getDay();
      const isWE = dow === 0 || dow === 6;
      const isToday = date === todayStr;
      const fid  = fMap[`${emp.id}-${date}`];
      const bg   = fid ? `background:${color}30` : '';
      html += `<td class="day-cell${isWE?' weekend':''}${isToday?' today-col':''}${fid?' folga':''}"
        data-emp="${emp.id}" data-date="${date}" data-fid="${fid||''}"
        style="${bg}">
        ${fid ? `<span style="color:${color}">●</span>` : ''}
      </td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // Cell click → toggle
  table.querySelectorAll('.day-cell').forEach(td => {
    td.addEventListener('click', () =>
      toggleFolga(parseInt(td.dataset.emp), td.dataset.date,
        td.dataset.fid ? parseInt(td.dataset.fid) : null, td));
  });

  // Delete employee
  table.querySelectorAll('.emp-del-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteEmployee(parseInt(btn.dataset.id)); });
  });
}

async function toggleFolga(empId, date, existingFid, cell) {
  const emp = FC.employees.find(e => e.id === empId);
  if (!emp) return;
  const color = BOARDS[emp.board]?.color || '#8B949E';
  try {
    if (existingFid) {
      await apiFetch('DELETE', `/api/folgas/${existingFid}`);
      FC.folgas = FC.folgas.filter(f => f.id !== existingFid);
      cell.classList.remove('folga');
      cell.style.background = '';
      cell.innerHTML = '';
      cell.dataset.fid = '';
    } else {
      const f = await apiFetch('POST', '/api/folgas', { employeeId: empId, date });
      FC.folgas.push(f);
      cell.classList.add('folga');
      cell.style.background = color + '30';
      cell.innerHTML = `<span style="color:${color}">●</span>`;
      cell.dataset.fid = f.id;
    }
  } catch (e) { toast('Erro: ' + e.message, true); }
}

async function deleteEmployee(id) {
  const emp = FC.employees.find(e => e.id === id);
  if (!emp) return;
  if (!confirm(`Remover funcionário "${emp.name}"?`)) return;
  try {
    await apiFetch('DELETE', `/api/employees/${id}`);
    FC.employees = FC.employees.filter(e => e.id !== id);
    FC.folgas    = FC.folgas.filter(f => f.employeeId !== id);
    renderFolgasTable();
  } catch (e) { toast('Erro: ' + e.message, true); }
}

function initFolgasModal() {
  document.getElementById('folgasBtn').addEventListener('click', openFolgas);
  document.getElementById('folgasClose').addEventListener('click', closeFolgas);
  document.getElementById('folgasOverlay').addEventListener('click', e => {
    if (e.target.id === 'folgasOverlay') closeFolgas();
  });
  document.getElementById('folgasPrev').addEventListener('click', async () => {
    FC.month--; if (FC.month < 1) { FC.month = 12; FC.year--; }
    await loadFolgasData();
  });
  document.getElementById('folgasNext').addEventListener('click', async () => {
    FC.month++; if (FC.month > 12) { FC.month = 1; FC.year++; }
    await loadFolgasData();
  });
  document.getElementById('folgasBoardFilter').addEventListener('change', e => {
    FC.filterBoard = e.target.value || null;
    renderFolgasTable();
  });

  // Add employee form
  const addBtn    = document.getElementById('folgasAddEmpBtn');
  const form      = document.getElementById('folgasAddForm');
  const nameInp   = document.getElementById('folgasEmpName');
  const confirmBtn= document.getElementById('folgasAddConfirm');
  const cancelBtn = document.getElementById('folgasAddCancel');

  addBtn.addEventListener('click', () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) nameInp.focus();
  });
  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden'); nameInp.value = '';
  });
  const doAddEmp = async () => {
    const name  = nameInp.value.trim();
    const board = S.user?.board || document.getElementById('folgasEmpBoard').value;
    if (!name || !board) return;
    confirmBtn.disabled = true;
    try {
      const emp = await apiFetch('POST', '/api/employees', { name, board });
      FC.employees.push(emp);
      renderFolgasTable();
      nameInp.value = '';
      form.classList.add('hidden');
      toast(`"${name}" adicionado ✓`);
    } catch (e) { toast('Erro: ' + e.message, true); }
    finally { confirmBtn.disabled = false; }
  };
  confirmBtn.addEventListener('click', doAddEmp);
  nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') doAddEmp(); });
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  initLoginForm();
  initPerfModal();
  initFolgasModal();
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('btnPrev').addEventListener('click', () => navigate(-1));
  document.getElementById('btnNext').addEventListener('click', () => navigate(1));
  document.getElementById('monthPicker').addEventListener('change', e => {
    if (!e.target.value) return;
    const [y, m] = e.target.value.split('-').map(Number);
    S.year = y; S.month = m; updateLabel(); loadData();
  });
  checkAuth();
}

init();
