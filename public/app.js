// ── Config ─────────────────────────────────────────────────────────────────
const BOARDS = {
  escritorio: { label: 'ESCRITÓRIO',  color: '#8B949E' },
  delrey:     { label: 'DEL REY',     color: '#58A6FF' },
  minas:      { label: 'MINAS',       color: '#3FB950' },
  contagem:   { label: 'CONTAGEM',    color: '#D29922' },
  estacao:    { label: 'ESTAÇÃO',     color: '#F85149' },
  tommy:      { label: 'TOMMY',       color: '#22D3EE' },
  lez:        { label: 'LEZ A LEZ',   color: '#F472B6' },
};


const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── State ──────────────────────────────────────────────────────────────────
const S = { year: 2026, month: 5, user: null, employees: [], weights: {}, vsales: {}, weeklyMetas: {}, folgas: [], campaigns: [], nfItems: [], meetingItems: [] };

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
function toast(msg, isErr = false, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr === true ? ' error' : isErr === 'warn' ? ' warn' : '');
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
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
    const isAdmin = !S.user.board || S.user.board === 'escritorio';
    document.getElementById('funcBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('campanhasBtn').style.display = isAdmin ? '' : 'none';
    const now = new Date();
    S.year  = now.getFullYear();
    S.month = now.getMonth() + 1;
    S._loginJustHappened = true;
    updateLabel();
    loadData();
    initMicrovixSync();
  } catch {
    showLogin();
  }
}

// ── Microvix sync button ───────────────────────────────────────────────────
function initMicrovixSync() {
  const btn   = document.getElementById('mxSyncBtn');
  const label = document.getElementById('mxSyncLabel');
  if (!btn) return;

  async function pollStatus() {
    try {
      const s = await apiFetch('GET', '/api/microvix/status');
      if (s.lastSync) {
        const t = new Date(s.lastSync.at);
        const hm = t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        label.textContent = `Microvix ${hm}`;
        btn.title = `Última sync: ${hm} — ${s.lastSync.updated} vendedores`;
        btn.classList.remove('err');
        btn.classList.add('ok');
      }
      if (s.lastError) {
        label.textContent = 'Microvix ✗';
        btn.title = s.lastError;
        btn.classList.remove('ok');
        btn.classList.add('err');
      }
    } catch {}
  }

  btn.addEventListener('click', async () => {
    btn.classList.add('syncing');
    label.textContent = 'Sincronizando…';
    try {
      const r = await apiFetch('POST', '/api/microvix/sync');
      const hm = new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      label.textContent = `Microvix ${hm}`;
      btn.title = `Sync OK: ${r.updated} vendedores atualizados`;
      btn.classList.remove('syncing', 'err');
      btn.classList.add('ok');
      loadData(); // refresh dashboard
    } catch (e) {
      label.textContent = 'Microvix ✗';
      btn.title = e.message || 'Erro ao sincronizar';
      btn.classList.remove('syncing', 'ok');
      btn.classList.add('err');
    }
  });

  pollStatus();
  setInterval(pollStatus, 60_000);
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
      const isAdmin = !S.user.board || S.user.board === 'escritorio';
      document.getElementById('funcBtn').style.display = isAdmin ? '' : 'none';
      document.getElementById('campanhasBtn').style.display = isAdmin ? '' : 'none';
      hideLogin();
      const now = new Date();
      S.year  = now.getFullYear();
      S.month = now.getMonth() + 1;
      S._loginJustHappened = true;
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
function visibleBoards() {
  if (!S.user?.board) {
    const all = Object.entries(BOARDS);
    if (DASH_BOARD_FILTER.size === 0) return all;
    return all.filter(([k]) => k === 'escritorio' || DASH_BOARD_FILTER.has(k));
  }
  return Object.entries(BOARDS).filter(([k]) => k === S.user.board);
}

async function loadData() {
  const c = document.getElementById('boardContainer');
  c.innerHTML = '<div class="loading"><div class="spinner"></div> Carregando…</div>';
  try {
    const [emps, weights] = await Promise.all([
      apiFetch('GET', '/api/employees'),
      apiFetch('GET', `/api/weights/${S.year}/${S.month}`),
    ]);
    S.employees = emps.filter(e => !e.inativo);
    S.weights   = weights || {};

    const [vsalesArr, weeklyMetas, folgas] = await Promise.all([
      Promise.all(emps.map(emp =>
        apiFetch('GET', `/api/vsales/${S.year}/${S.month}/${emp.board}/${emp.id}`)
          .then(d => [emp.id, d])
          .catch(() => [emp.id, { meta: { mensal: 0 }, entries: {} }])
      )),
      apiFetch('GET', `/api/weekly-metas/${S.year}/${S.month}`).catch(() => ({})),
      apiFetch('GET', `/api/folgas/${S.year}/${S.month}`).catch(() => []),
    ]);
    S.vsales      = Object.fromEntries(vsalesArr);
    S.weeklyMetas = weeklyMetas || {};
    S.folgas      = folgas || [];

    const [campaigns, nfItems, boletas, meetingItems] = await Promise.all([
      apiFetch('GET', '/api/campaigns').catch(() => []),
      apiFetch('GET', '/api/nf-items').catch(() => []),
      apiFetch('GET', '/api/boletas').catch(() => []),
      apiFetch('GET', '/api/meeting-items').catch(() => []),
    ]);
    S.campaigns    = campaigns    || [];
    S.nfItems      = nfItems      || [];
    S.boletas      = boletas      || [];
    S.meetingItems = meetingItems || [];
    _updateCampanhasBtn();

    renderDashboard();

    if (S._loginJustHappened) {
      S._loginJustHappened = false;
      const now = new Date();
      const _pad = n => String(n).padStart(2,'0');
      const curMonthKey = `${now.getFullYear()}-${_pad(now.getMonth()+1)}`;

      const userBoard = S.user?.board || null; // null = admin (Leonardo, Escritório, etc.)

      // Filtra funcionários pelo board do usuário logado
      const warnEmps = userBoard
        ? S.employees.filter(e => e.board === userBoard)
        : S.employees;

      // Aviso folgas — admin vê todos, loja vê só os seus
      const warnEmpIds = new Set(warnEmps.map(e => e.id));
      const hasFolgasCurMonth = S.folgas.some(f =>
        f.date.startsWith(curMonthKey) && warnEmpIds.has(f.employeeId)
      );
      if (!hasFolgasCurMonth) {
        setTimeout(() => document.getElementById('folgasWarnOverlay').classList.remove('hidden'), 800);
      }

      // Aviso vendas: último dia preenchido ≠ ontem (filtrado por board)
      const yest = new Date(now); yest.setDate(yest.getDate() - 1);
      const yestStr = `${yest.getFullYear()}-${_pad(yest.getMonth()+1)}-${_pad(yest.getDate())}`;
      const prefix = `${now.getFullYear()}-${_pad(now.getMonth()+1)}-`;
      let lastVenda = null;
      for (const emp of warnEmps) {
        for (const date of Object.keys((S.vsales[emp.id] || {}).entries || {})) {
          if (date.startsWith(prefix) && (lastVenda === null || date > lastVenda)) lastVenda = date;
        }
      }
      if (lastVenda && lastVenda < yestStr) {
        const [y, m, d] = lastVenda.split('-');
        document.getElementById('vendasWarnDate').textContent = `${d}/${m}/${y}`;
        setTimeout(() => document.getElementById('vendasWarnOverlay').classList.remove('hidden'),
          hasFolgasCurMonth ? 800 : 1400);
      }
    }
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('autenticado')) { showLogin(); return; }
    c.innerHTML = '<div class="loading">Erro ao carregar. Servidor está rodando em localhost:3000?</div>';
    toast('Erro: ' + e.message, true);
  }
}

// ── Dashboard — weekly tracking ────────────────────────────────────────────
function renderDashboard() {
  if (_dayCardTimer) { clearInterval(_dayCardTimer); _dayCardTimer = null; }
  const c = document.getElementById('boardContainer');
  c.innerHTML = '';

  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

  const fBRL = v => v == null || v === 0 ? '—' : new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const fPct = v => v == null ? '—' : v.toFixed(1)+'%';
  const fDec = v => v == null ? '—' : v.toFixed(2);

  const vendedores = S.employees.filter(e => e.isVendedor !== false);
  const byBoard = {};
  for (const emp of vendedores) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }

  const visible = visibleBoards();
  if (!visible.some(([bk]) => (byBoard[bk] || []).length > 0)) {
    c.innerHTML = '<div class="loading">Nenhum vendedor cadastrado. Acesse Funcionários para adicionar.</div>';
    return;
  }

  const isAdmin = !S.user?.board || S.user.board === 'escritorio';

  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const defW = +(100 / daysInMonth).toFixed(6);

  // Último dia com lançamento no mês (mesma base do Comparativo por Loja)
  const prefix = `${S.year}-${pad(S.month)}-`;
  let lastFilledDay = null;
  for (const emp of S.employees) {
    for (const date of Object.keys((S.vsales[emp.id] || {}).entries || {})) {
      if (date.startsWith(prefix) && (lastFilledDay === null || date > lastFilledDay)) lastFilledDay = date;
    }
  }
  const cutoff = lastFilledDay || todayStr;

  let weightAccum = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
    if (ds > cutoff) break;
    weightAccum += (S.weights[ds] ?? defW);
  }


  // ── Layout: left column (half width) + right free ───────────────────────
  const grid = document.createElement('div');
  grid.className = 'main-grid';
  c.appendChild(grid);

  const leftCol = document.createElement('div');
  leftCol.className = 'main-left-col';
  grid.appendChild(leftCol);

  // ── FILTRO DE LOJAS ──────────────────────────────────────────────────────
  if (isAdmin) {
    const storeBoards = Object.entries(BOARDS).filter(([k]) => k !== 'escritorio');
    const filterBar = document.createElement('div');
    filterBar.className = 'dash-store-filter';
    const allOn = DASH_BOARD_FILTER.size === 0;
    filterBar.innerHTML =
      `<button class="dash-store-chip" data-board="" style="${allOn ? 'color:var(--text);border-color:var(--border);background:var(--surface2,#2a2a2a)' : 'color:var(--muted)'}">Todas</button>` +
      storeBoards.map(([k, bc]) => {
        const on = allOn || DASH_BOARD_FILTER.has(k);
        return `<button class="dash-store-chip" data-board="${k}" style="${on ? `color:${bc.color};border-color:${bc.color}55;background:${bc.color}18` : 'color:var(--muted)'}">
          ${bc.label}
        </button>`;
      }).join('');

    filterBar.querySelectorAll('.dash-store-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const board = btn.dataset.board;
        if (!board) {
          DASH_BOARD_FILTER.clear();
        } else {
          if (DASH_BOARD_FILTER.has(board)) DASH_BOARD_FILTER.delete(board);
          else DASH_BOARD_FILTER.add(board);
          if (DASH_BOARD_FILTER.size === storeBoards.length) DASH_BOARD_FILTER.clear();
        }
        renderDashboard();
      });
    });
    leftCol.appendChild(filterBar);
  }

  // ── CARD: Faturamento Diário ─────────────────────────────────────────────
  {
    if (!DASH_DAY.refDate || DASH_DAY.refDate > cutoff) DASH_DAY.refDate = cutoff;
    const pad2 = n => String(n).padStart(2, '0');
    const monthStart = `${S.year}-${pad2(S.month)}-01`;

    const dayCard = document.createElement('div');
    dayCard.className = 'main-card';
    dayCard.dataset.cardId = 'card-dia';
    dayCard.innerHTML = `
      <div class="main-card-hdr">
        <span class="main-card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          Faturamento Diário
        </span>
        <div class="dash-wk-nav">
          <button class="dash-wk-btn" id="dayCardPrev" title="Dia anterior">&#8592;</button>
          <span class="dash-wk-label" id="dayCardLabel"></span>
          <button class="dash-wk-btn" id="dayCardNext" title="Próximo dia">&#8594;</button>
        </div>
      </div>
      <div class="main-card-body" id="dayCardBody"></div>
    `;
    leftCol.appendChild(dayCard);

    function _updateDayCard() {
      const d = DASH_DAY.refDate;
      const lbl = d === todayStr ? `Hoje · ${d.slice(8)}/${d.slice(5,7)}` : `${d.slice(8)}/${d.slice(5,7)}`;
      document.getElementById('dayCardLabel').textContent = lbl;
      document.getElementById('dayCardPrev').disabled = d <= monthStart;
      document.getElementById('dayCardNext').disabled = d >= cutoff;
      _renderDayCardBody(document.getElementById('dayCardBody'), d);
    }

    document.getElementById('dayCardPrev').addEventListener('click', () => {
      const d = new Date(DASH_DAY.refDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      DASH_DAY.refDate = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
      if (DASH_DAY.refDate < monthStart) DASH_DAY.refDate = monthStart;
      _updateDayCard();
    });
    document.getElementById('dayCardNext').addEventListener('click', () => {
      const d = new Date(DASH_DAY.refDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      DASH_DAY.refDate = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
      if (DASH_DAY.refDate > cutoff) DASH_DAY.refDate = cutoff;
      _updateDayCard();
    });

    _updateDayCard();
    _startDayCardAutoRefresh();
  }

  // ── CARD: Performance Mensal ────────────────────────────────────────────
  const leftCard = document.createElement('div');
  leftCard.className = 'main-card';
  // Data mais recente com syncedAt no mês atual
  let lastSyncedDate = '';
  for (const vs of Object.values(S.vsales || {})) {
    for (const [date, entry] of Object.entries(vs.entries || {})) {
      if (entry.syncedAt && date > lastSyncedDate) lastSyncedDate = date;
    }
  }
  const syncDateLabel = lastSyncedDate
    ? ` · dados de ${lastSyncedDate.slice(8)}/${lastSyncedDate.slice(5,7)}`
    : '';

  leftCard.dataset.cardId = 'card-perf';
  leftCard.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        Performance Mensal
      </span>
      <span class="main-card-sub">${['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][S.month-1]} ${S.year}<span class="main-card-sync-date">${syncDateLabel}</span></span>
    </div>
    <div class="main-card-body"></div>
  `;
  leftCol.appendChild(leftCard);
  const leftBody = leftCard.querySelector('.main-card-body');

  // Monthly table
  const DASH_COLS = [
    { key:'name',     label:'Vendedor',  cls:'' },
    { key:'mensal',   label:'Meta Mês',  cls:'dash-th-r' },
    { key:'valor',    label:'Realizado', cls:'dash-th-r' },
    { key:'pctMeta',  label:'% Meta',    cls:'dash-th-r' },
    { key:'projecao', label:'Projeção', cls:'dash-th-r' },
    { key:'pa',       label:'PA',        cls:'dash-th-r' },
    { key:'tm',       label:'TM',        cls:'dash-th-r' },
  ];
  const headHtml = DASH_COLS.map(c => {
    const active = DASH_SORT.col === c.key;
    const arr = active ? (DASH_SORT.dir > 0 ? '↑' : '↓') : '⇅';
    return `<th class="dash-th ${c.cls} dash-th-sort" data-col="${c.key}">${c.label}<span class="sort-arr${active?' sort-arr-on':''}">${arr}</span></th>`;
  }).join('');

  const table = document.createElement('table');
  table.className = 'dash-table';
  table.innerHTML = `<thead><tr class="dash-thead-tr">${headHtml}</tr></thead>`;
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  for (const [bk, bc] of visible) {
    const emps = byBoard[bk] || [];
    if (emps.length === 0) continue;

    const storeRow = document.createElement('tr');
    storeRow.className = 'dash-store-hdr';
    storeRow.innerHTML = `<td colspan="7" class="dash-store-hdr-td" style="border-left:3px solid ${bc.color};">
      <span class="dash-store-dot" style="background:${bc.color}"></span><strong>${bc.label}</strong>
    </td>`;
    tbody.appendChild(storeRow);

    // Pre-compute KPIs for sorting
    const rowData = emps.map(emp => {
      const vsale  = S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
      const mensal = vsale.meta?.mensal || 0;
      const entries= vsale.entries || {};
      let valor=0, pecas=0, atend=0;
      for (let d=1; d<=daysInMonth; d++) {
        const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
        if (ds > cutoff) break;
        const e = entries[ds];
        if (e) { valor += e.value||0; pecas += e.pecas||0; atend += e.atendimentos||0; }
      }
      const metaAccum = mensal * weightAccum / 100;
      const pctMeta   = (metaAccum > 0 && valor > 0) ? valor/metaAccum*100 : null;
      const projecao  = (valor > 0 && metaAccum > 0) ? valor/metaAccum*mensal : null;
      const pa        = (pecas > 0 && atend > 0) ? pecas/atend : null;
      const tm        = (valor > 0 && atend > 0) ? valor/atend : null;
      return { emp, valor, pecas, atend, mensal, pctMeta, projecao, pa, tm };
    });

    if (DASH_SORT.col) {
      rowData.sort((a, b) => {
        const ka = DASH_SORT.col === 'name' ? a.emp.name : a[DASH_SORT.col];
        const kb = DASH_SORT.col === 'name' ? b.emp.name : b[DASH_SORT.col];
        if (ka == null && kb == null) return 0;
        if (ka == null) return 1;
        if (kb == null) return -1;
        if (typeof ka === 'string') return DASH_SORT.dir * ka.localeCompare(kb, 'pt-BR');
        return DASH_SORT.dir * (ka - kb);
      });
    }

    let totValor=0, totPecas=0, totAtend=0, totMeta=0;
    for (const { emp, valor, pecas, atend, mensal, pctMeta, projecao, pa, tm } of rowData) {
      totValor += valor; totPecas += pecas; totAtend += atend; totMeta += mensal;
      const pctCls  = pctMeta  == null ? '' : pctMeta  >= 100 ? 'kpi-pos' : pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
      const projCls = projecao == null ? '' : projecao >= mensal ? 'kpi-pos' : projecao >= mensal*0.9 ? 'kpi-warn' : 'kpi-neg';
      const row = document.createElement('tr');
      row.className = 'dash-row';
      row.innerHTML = `
        <td class="dash-td dash-td-name">${emp.apelido || emp.name}</td>
        <td class="dash-td dash-td-num">${fBRL(mensal || null)}</td>
        <td class="dash-td dash-td-num">${fBRL(valor || null)}</td>
        <td class="dash-td dash-td-num ${pctCls}">${fPct(pctMeta)}</td>
        <td class="dash-td dash-td-num ${projCls}">${fBRL(projecao)}</td>
        <td class="dash-td dash-td-num${pa != null ? (pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${fDec(pa)}</td>
        <td class="dash-td dash-td-num">${fBRL(tm)}</td>
      `;
      tbody.appendChild(row);
    }

    const totMetaAccum = totMeta * weightAccum / 100;
    const totPct  = (totMetaAccum > 0 && totValor > 0) ? totValor/totMetaAccum*100 : null;
    const totProj = (totValor > 0 && totMetaAccum > 0) ? totValor/totMetaAccum*totMeta : null;
    const totPa   = (totPecas > 0 && totAtend > 0) ? totPecas/totAtend : null;
    const totTm   = (totValor > 0 && totAtend > 0) ? totValor/totAtend : null;
    const tpCls   = totPct  == null ? '' : totPct  >= 100 ? 'kpi-pos' : totPct  >= 80 ? 'kpi-warn' : 'kpi-neg';
    const tprCls  = totProj == null ? '' : totProj >= totMeta ? 'kpi-pos' : totProj >= totMeta*0.9 ? 'kpi-warn' : 'kpi-neg';

    const metaKey = `${bk}-${S.year}-${S.month}`;
    if (totProj != null && totMeta > 0 && totProj >= totMeta && !META_ACHIEVED.has(metaKey)) {
      META_ACHIEVED.add(metaKey);
      setTimeout(() => triggerMetaCelebration(bc.label, bc.color), 350);
    }

    const totalRow = document.createElement('tr');
    totalRow.className = 'dash-total-row';
    totalRow.innerHTML = `
      <td class="dash-td">Total <strong>${bc.label}</strong></td>
      <td class="dash-td dash-td-num">${fBRL(totMeta || null)}</td>
      <td class="dash-td dash-td-num">${fBRL(totValor || null)}</td>
      <td class="dash-td dash-td-num ${tpCls}">${fPct(totPct)}</td>
      <td class="dash-td dash-td-num ${tprCls}">${fBRL(totProj)}</td>
      <td class="dash-td dash-td-num${totPa != null ? (totPa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${totPa != null ? totPa.toFixed(2) : '—'}</td>
      <td class="dash-td dash-td-num">${fBRL(totTm)}</td>
    `;
    tbody.appendChild(totalRow);
  }

  leftBody.appendChild(table);

  // Wire sort clicks
  table.querySelectorAll('.dash-th-sort').forEach(th =>
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (DASH_SORT.col === col) DASH_SORT.dir *= -1;
      else { DASH_SORT.col = col; DASH_SORT.dir = 1; }
      renderDashboard();
    })
  );

  // ── CARD: Semana (with nav arrows) ──────────────────────────────────────
  if (!DASH_WEEK.refDate) DASH_WEEK.refDate = todayStr;
  const week = getWeekForDate(DASH_WEEK.refDate);
  const isCurrentWeek = week.startStr <= todayStr && todayStr <= week.endStr;

  const rightCard = document.createElement('div');
  rightCard.className = 'main-card';
  rightCard.id = 'dashWeekCard';
  rightCard.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        Meta Semanal
      </span>
      <div class="dash-wk-nav">
        <button class="dash-wk-btn" id="dashWkPrev" title="Semana anterior">&#8592;</button>
        <span id="dashWkLabel" class="dash-wk-label">${week.label}${isCurrentWeek ? ' <span class="main-card-badge">Atual</span>' : ''}</span>
        <button class="dash-wk-btn" id="dashWkNext" title="Próxima semana">&#8594;</button>
      </div>
    </div>
    <div class="main-card-body" id="dashWeekBody"></div>
  `;
  leftCol.insertBefore(rightCard, leftCard);
  _renderDashWeekBody(rightCard.querySelector('#dashWeekBody'), week);

  document.getElementById('dashWkPrev').addEventListener('click', () => {
    const _p = n => String(n).padStart(2,'0');
    const d = new Date(DASH_WEEK.refDate + 'T00:00:00');
    d.setDate(d.getDate() - 7);
    DASH_WEEK.refDate = `${d.getFullYear()}-${_p(d.getMonth()+1)}-${_p(d.getDate())}`;
    _refreshDashWeek();
  });
  document.getElementById('dashWkNext').addEventListener('click', () => {
    const _p = n => String(n).padStart(2,'0');
    const d = new Date(DASH_WEEK.refDate + 'T00:00:00');
    d.setDate(d.getDate() + 7);
    DASH_WEEK.refDate = `${d.getFullYear()}-${_p(d.getMonth()+1)}-${_p(d.getDate())}`;
    _refreshDashWeek();
  });

  const midCol = document.createElement('div');
  midCol.className = 'main-mid-col';
  grid.appendChild(midCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'main-right-col';
  grid.appendChild(rightCol);

  // ── CARD: Campanha Ativa (mini ranking top 5) — na coluna do meio ────────
  const userBoard = S.user?.board || null;
  const activeCampaigns = (S.campaigns || []).filter(c =>
    c.startDate <= todayStr && c.endDate >= todayStr &&
    (!userBoard || c.scope === 'rede' || c.stores.includes(userBoard))
  );
  let campDashCard = null;
  if (activeCampaigns.length > 0) {
    const camp = activeCampaigns[0];
    const campEmps = S.employees.filter(e =>
      e.isVendedor !== false && !e.inativo &&
      (camp.scope === 'rede' || camp.stores.includes(e.board))
    );
    const campRanking = campEmps.map(emp => {
      const entries = (S.vsales[emp.id] || {}).entries || {};
      let totalVendas = 0, totalPecas = 0, totalAtend = 0;
      for (const [date, entry] of Object.entries(entries)) {
        if (date >= camp.startDate && date <= camp.endDate) {
          totalVendas += entry.value || 0;
          totalPecas  += entry.pecas || 0;
          totalAtend  += entry.atendimentos || 0;
        }
      }
      let kpiValue = 0;
      switch (camp.kpi) {
        case 'vendas': kpiValue = totalVendas; break;
        case 'pecas':  kpiValue = totalPecas;  break;
        case 'atendimentos': kpiValue = totalAtend; break;
        case 'pa': kpiValue = totalAtend > 0 ? totalPecas / totalAtend : 0; break;
      }
      return { emp, kpiValue };
    }).sort((a, b) => b.kpiValue - a.kpiValue).slice(0, 5);

    const campMaxVal = campRanking.length ? Math.max(...campRanking.map(r => r.kpiValue), 0.001) : 0.001;
    const campMedals = ['🥇','🥈','🥉'];
    const campFmt = d => d.split('-').reverse().join('/');

    const campRowsHtml = campRanking.map((r, i) => {
      const pct   = campMaxVal > 0 ? (r.kpiValue / campMaxVal * 100) : 0;
      const medal = i < 3 ? campMedals[i] : `#${i+1}`;
      const color = BOARDS[r.emp.board]?.color || '#8B949E';
      const name  = r.emp.apelido || r.emp.name.split(' ')[0];
      return `
        <div class="camp-dash-row">
          <span class="camp-dash-pos">${medal}</span>
          <span class="camp-dash-name">${name}</span>
          <div class="camp-dash-bar-wrap"><div class="camp-dash-bar" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
          <span class="camp-dash-val">${formatKpiValue(camp.kpi, r.kpiValue)}</span>
        </div>`;
    }).join('');

    campDashCard = document.createElement('div');
    campDashCard.className = 'main-card camp-dash-card';
    campDashCard.innerHTML = `
      <div class="main-card-hdr">
        <span class="main-card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
            <path d="M4 22h16"/>
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
          </svg>
          ${camp.name}
        </span>
        <span class="main-card-sub">${campFmt(camp.startDate)} → ${campFmt(camp.endDate)}</span>
      </div>
      <div class="main-card-body">
        <div class="camp-dash-kpi-lbl">${KPI_LABELS[camp.kpi] || camp.kpi}</div>
        ${campRowsHtml || '<div style="color:var(--muted);font-size:.8rem;padding:.5rem 0">Sem dados no período</div>'}
      </div>
    `;
    campDashCard.addEventListener('click', () => {
      openCampanhasModal();
      setTimeout(() => renderCampaignRanking(camp), 60);
    });
    campDashCard.dataset.cardId = 'card-camp';
  }

  // ── CARD: Folgas → coluna direita ────────────────────────────────────────
  const folgasCard = document.createElement('div');
  folgasCard.className = 'main-card';
  folgasCard.dataset.cardId = 'card-folgas';
  folgasCard.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        Folgas
      </span>
      <span class="main-card-sub">${MONTHS_PT[S.month-1]} ${S.year}</span>
    </div>
    <div class="main-card-body" id="dashFolgasBody"></div>
  `;
  rightCol.appendChild(folgasCard);
  _renderDashFolgas(folgasCard.querySelector('#dashFolgasBody'));

  // Campanhas abaixo de Folgas (coluna direita)
  if (campDashCard) rightCol.appendChild(campDashCard);

  // ── CARD: Comparativo por Loja → coluna esquerda (abaixo da performance) ─
  const compCard = document.createElement('div');
  compCard.className = 'main-card';
  compCard.dataset.cardId = 'card-comp';
  compCard.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        Comparativo por Loja
      </span>
      <span class="main-card-sub" id="compCardSub">${MONTHS_PT[S.month-1]} ${S.year}</span>
    </div>
    <div class="main-card-body" id="compCardBody">
      <div style="padding:.85rem;text-align:center;font-size:.78rem;color:var(--muted)">Carregando...</div>
    </div>
  `;
  leftCol.appendChild(compCard);
  _loadCompCard(compCard.querySelector('#compCardBody')).catch(e => console.error(e));

  // ── CARD: Boletas de Defeito ─────────────────────────────────────────────
  renderBoletasCard(midCol);

  // ── CARD: Recebimento de NF Autorizado ───────────────────────────────────
  renderNFCard(midCol);

  // ── CARD: Reunião Mensal ──────────────────────────────────────────────────
  renderMeetingCard(midCol);

  // ── CARD: Fechamento de Caixa ─────────────────────────────────────────────
  renderCaixaCard(rightCol);

}


function _renderDashFolgas(body) {
  const pad = n => String(n).padStart(2,'0');
  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const DAY_SHORT = ['D','S','T','Q','Q','S','S'];

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

  // Build per-employee folga set for this month
  const empFolgas = {};
  for (const f of S.folgas) {
    if (!f.date.startsWith(`${S.year}-${pad(S.month)}`)) continue;
    const day = parseInt(f.date.split('-')[2]);
    if (!empFolgas[f.employeeId]) empFolgas[f.employeeId] = new Set();
    empFolgas[f.employeeId].add(day);
  }

  const empsWithFolga = S.employees.filter(e => empFolgas[e.id]);
  if (empsWithFolga.length === 0) {
    body.innerHTML = '<div class="folga-mini-empty">Sem folgas programadas</div>';
    return;
  }

  // Group by board in visible order
  const byBoard = {};
  for (const emp of empsWithFolga) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }

  // Header row
  let html = '<div class="folga-mini-wrap"><table class="folga-mini-tbl"><thead><tr><th class="folga-mini-name-h"></th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(S.year, S.month - 1, d).getDay();
    const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
    const isWE = dow === 0 || dow === 6;
    const isToday = ds === todayStr;
    let cls = 'folga-mini-day-h';
    if (isWE) cls += ' folga-mini-we';
    if (isToday) cls += ' folga-mini-today-col';
    html += `<th class="${cls}">${d}<span class="folga-mini-dow">${DAY_SHORT[dow]}</span></th>`;
  }
  html += '</tr></thead><tbody>';

  const totalCols = 1 + daysInMonth;
  for (const [bk, emps] of Object.entries(byBoard)) {
    const bc = BOARDS[bk] || { label: bk, color: '#64748b' };
    html += `<tr class="folga-mini-store-row">
      <td colspan="${totalCols}" class="folga-mini-store-td" style="background:${bc.color}22;border-left:3px solid ${bc.color}">
        <strong>${bc.label}</strong>
      </td></tr>`;
    for (const emp of emps) {
      const color = bc.color;
      const fDays = empFolgas[emp.id];
      html += `<tr><td class="folga-mini-name-td">${emp.apelido || emp.name.split(' ')[0]}</td>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(S.year, S.month - 1, d).getDay();
        const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
        const isWE = dow === 0 || dow === 6;
        const isToday = ds === todayStr;
        const has = fDays.has(d);
        let cls = 'folga-mini-cell';
        if (isWE) cls += ' folga-mini-we';
        if (isToday) cls += ' folga-mini-today-cell';
        html += `<td class="${cls}"${has ? ` style="background:${color}28;"` : ''}>${has ? `<span class="folga-mini-mark" style="background:${color}"></span>` : ''}</td>`;
      }
      html += '</tr>';
    }
  }
  html += '</tbody></table></div>';
  body.innerHTML = html;
}

function _renderDayCardBody(body, dateStr) {
  const pad = n => String(n).padStart(2, '0');
  const fV  = v => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const defW = +(100 / daysInMonth).toFixed(6);
  const dayWeight = S.weights[dateStr] ?? defW;

  const vendedores = S.employees.filter(e => e.isVendedor !== false && !e.inativo);
  const byBoard = {};
  for (const emp of vendedores) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }

  body.innerHTML = `
    <div class="dia-col-hdr">
      <span></span>
      <span>Realizado</span>
      <span>Meta Dia</span>
      <span>PA</span>
      <span>%</span>
    </div>`;

  let anyData = false;

  for (const [bk, bc] of visibleBoards()) {
    const emps = (byBoard[bk] || []).filter(e => {
      const vsale = S.vsales[e.id] || {};
      return (vsale.meta?.mensal || 0) > 0 || (vsale.entries?.[dateStr]?.value || 0) > 0;
    });
    if (!emps.length) continue;

    anyData = true;
    let storeTotalVal = 0, storeTotalMeta = 0, storeTotalPecas = 0, storeTotalAtend = 0;
    let rowsHtml = '';

    for (const emp of emps) {
      const vsale   = S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
      const entry   = vsale.entries?.[dateStr] || {};
      const valor   = entry.value || 0;
      const pecas   = entry.pecas || 0;
      const atend   = entry.atendimentos || 0;
      const metaDia = (vsale.meta?.mensal || 0) * dayWeight / 100;
      const pa      = atend > 0 ? pecas / atend : null;
      const pct     = metaDia > 0 ? valor / metaDia * 100 : null;

      storeTotalVal   += valor;
      storeTotalMeta  += metaDia;
      storeTotalPecas += pecas;
      storeTotalAtend += atend;

      const pctCls = pct == null ? '' : pct >= 100 ? 'dia-pct-ok' : pct >= 70 ? 'dia-pct-warn' : 'dia-pct-bad';
      rowsHtml += `
        <div class="dia-row">
          <span class="dia-name">${emp.apelido || emp.name.split(' ')[0]}</span>
          <span class="dia-val">${valor > 0 ? fV(valor) : '—'}</span>
          <span class="dia-meta">${metaDia > 0 ? fV(metaDia) : '—'}</span>
          <span class="dia-pa">${pa != null ? pa.toFixed(2) : '—'}</span>
          <span class="dia-pct ${pctCls}">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>
        </div>`;
    }

    const storePa  = storeTotalAtend > 0 ? storeTotalPecas / storeTotalAtend : null;
    const storePct = storeTotalMeta > 0 ? storeTotalVal / storeTotalMeta * 100 : null;
    const sPctCls  = storePct == null ? '' : storePct >= 100 ? 'dia-pct-ok' : storePct >= 70 ? 'dia-pct-warn' : 'dia-pct-bad';

    body.insertAdjacentHTML('beforeend', `
      <div class="dia-store-hdr">
        <span class="dash-store-dot" style="background:${bc.color}"></span>
        <strong>${bc.label}</strong>
      </div>
      ${rowsHtml}
      <div class="dia-row dia-total-row">
        <span class="dia-name">Total</span>
        <span class="dia-val">${storeTotalVal > 0 ? fV(storeTotalVal) : '—'}</span>
        <span class="dia-meta">${storeTotalMeta > 0 ? fV(storeTotalMeta) : '—'}</span>
        <span class="dia-pa">${storePa != null ? storePa.toFixed(2) : '—'}</span>
        <span class="dia-pct ${sPctCls}">${storePct != null ? storePct.toFixed(1) + '%' : '—'}</span>
      </div>`);
  }

  if (!anyData) {
    body.insertAdjacentHTML('beforeend',
      '<div style="padding:.85rem 1rem;font-size:.78rem;color:var(--muted)">Sem lançamentos para este dia.</div>');
  }
}

function _renderDashWeekBody(body, week, extraData) {
  const pad = n => String(n).padStart(2,'0');
  const fBRL = v => v == null || v === 0 ? '—' : new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const fPct = v => v == null ? '—' : v.toFixed(1)+'%';
  const fDec = v => v == null ? '—' : v.toFixed(2);

  const vendedores = S.employees.filter(e => e.isVendedor !== false);
  const byBoard = {};
  for (const emp of vendedores) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }
  const visible = visibleBoards();

  for (const [bk, bc] of visible) {
    const emps = byBoard[bk] || [];
    if (emps.length === 0) continue;

    let totValor=0, totPecas=0, totAtend=0, totMeta=0, totPremio=0, totProjecao=0, hasProj=false;

    const rows = emps.map(emp => {
      const k = calcWeekKpis(emp, week, extraData);
      totValor += k.valor; totPecas += k.pecas; totAtend += k.atend; totMeta += k.wMeta;
      if (k.pTotal != null) totPremio += k.pTotal;
      if (k.projecao != null) { totProjecao += k.projecao; hasProj = true; }

      const pctCls  = k.pctMeta  == null ? '' : k.pctMeta  >= 100 ? 'kpi-pos' : k.pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
      const projCls = k.projecao == null ? '' : k.projecao >= k.wMeta ? 'kpi-pos' : 'kpi-neg';

      const paEarned = k.hitMeta && k.hitPA;
      const premioHtml = k.isFuture
        ? '<span class="dw-p-pending">—</span>'
        : `<span class="dw-p ${k.hitMeta?'dw-p-ok':'dw-p-warn'}">${fBRL(PREMIO_VENDAS)}${k.hitMeta?' ✓':''}</span>
           <span class="dw-p ${paEarned?'dw-p-ok':k.hitPA&&!k.hitMeta?'dw-p-no':'dw-p-warn'}" title="${k.hitPA&&!k.hitMeta?'PA atingido mas meta venda não':''}">+${fBRL(PREMIO_PA)}${paEarned?' ✓':k.hitPA&&!k.hitMeta?' ✗':''}</span>`;

      return `<tr class="dw-row">
        <td class="dw-td dw-td-name">${emp.apelido || emp.name}</td>
        <td class="dw-td dw-td-num">${fBRL(k.wMeta||null)}</td>
        <td class="dw-td dw-td-num">${fBRL(k.valor||null)}</td>
        <td class="dw-td dw-td-num ${pctCls}">${fPct(k.pctMeta)}</td>
        <td class="dw-td dw-td-num ${projCls}">${fBRL(k.projecao)}</td>
        <td class="dw-td dw-td-num${k.pa != null ? (k.pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${fDec(k.pa)}</td>
        <td class="dw-td dw-premio">${premioHtml}</td>
      </tr>`;
    }).join('');

    const totPct = (totMeta>0&&totValor>0) ? totValor/totMeta*100 : null;
    const totPa  = (totPecas>0&&totAtend>0) ? totPecas/totAtend : null;
    const tpCls  = totPct==null?'': totPct>=100?'kpi-pos': totPct>=80?'kpi-warn':'kpi-neg';
    const tprojCls = !hasProj ? '' : totProjecao >= totMeta ? 'kpi-pos' : 'kpi-neg';

    const sec = document.createElement('div');
    sec.innerHTML = `
      <div class="dw-store-hdr">
        <span class="dw-store-dot" style="background:${bc.color}"></span><strong>${bc.label}</strong>
      </div>
      <table class="dw-table">
        <thead><tr class="dw-thead-tr">
          <th class="dw-th">Vendedor</th>
          <th class="dw-th dw-th-r">Meta Sem.</th>
          <th class="dw-th dw-th-r">Realizado</th>
          <th class="dw-th dw-th-r">% Meta</th>
          <th class="dw-th dw-th-r">Projeção</th>
          <th class="dw-th dw-th-r">PA</th>
          <th class="dw-th dw-th-r">Prêmio</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="dw-total-row">
          <td class="dw-td">Total</td>
          <td class="dw-td dw-td-num">${fBRL(totMeta||null)}</td>
          <td class="dw-td dw-td-num">${fBRL(totValor||null)}</td>
          <td class="dw-td dw-td-num ${tpCls}">${fPct(totPct)}</td>
          <td class="dw-td dw-td-num ${tprojCls}">${hasProj ? fBRL(totProjecao) : '—'}</td>
          <td class="dw-td dw-td-num${totPa!=null?(totPa>=1.8?' pa-ok':' pa-low'):''}">${totPa!=null?totPa.toFixed(2):'—'}</td>
          <td class="dw-td dw-td-num">R$ ${totPremio.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        </tr></tfoot>
      </table>`;
    body.appendChild(sec);
  }
}

async function _refreshDashWeek() {
  const pad = n => String(n).padStart(2,'0');
  const t = new Date();
  const todayStr = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
  const week = getWeekForDate(DASH_WEEK.refDate || todayStr);
  const isCurrentWeek = week.startStr <= todayStr && todayStr <= week.endStr;

  const labelEl = document.getElementById('dashWkLabel');
  if (labelEl) {
    labelEl.innerHTML = week.label + (isCurrentWeek ? ' <span class="main-card-badge">Atual</span>' : '');
  }

  const curKey = `${S.year}-${pad(S.month)}`;
  const extraData = {};
  const startDate = new Date(week.startStr + 'T00:00:00');
  const toLoad = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate); d.setDate(d.getDate() + i);
    const mk = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    if (mk !== curKey) toLoad.add(mk);
  }
  for (const mk of toLoad) {
    const [y, m] = mk.split('-').map(Number);
    extraData[mk] = await loadMonthData(y, m);
  }

  const body = document.getElementById('dashWeekBody');
  if (!body) return;
  body.innerHTML = '';
  _renderDashWeekBody(body, week, Object.keys(extraData).length ? extraData : undefined);
}

function _getCompMonths() {
  let m1y = S.year, m1m = S.month - 1;
  if (m1m === 0) { m1y--; m1m = 12; }
  let m2y = S.year, m2m = S.month - 2;
  if (m2m <= 0) { m2y--; m2m += 12; }
  const lyY = S.year - 1, lyM = S.month;
  return {
    m1: { year: m1y, month: m1m, label: MONTHS_PT[m1m-1].slice(0,3)+'/'+String(m1y).slice(2) },
    m2: { year: m2y, month: m2m, label: MONTHS_PT[m2m-1].slice(0,3)+'/'+String(m2y).slice(2) },
    ly: { year: lyY, month: lyM, label: MONTHS_PT[lyM-1].slice(0,3)+'/'+String(lyY).slice(2) },
  };
}

async function _loadCompCard(body) {
  const pad = n => String(n).padStart(2,'0');
  const fV  = v => !v ? '—' : new Intl.NumberFormat('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0}).format(Math.round(v));
  const fPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

  const daysInCur = new Date(S.year, S.month, 0).getDate();
  const prefix    = `${S.year}-${pad(S.month)}-`;

  // Lojas visíveis: login individual vê só a sua
  const ALL_STORE_KEYS = ['delrey', 'minas', 'contagem', 'estacao'];
  const isAdmin = !S.user?.board || S.user.board === 'escritorio';
  const STORE_KEYS = isAdmin ? ALL_STORE_KEYS : ALL_STORE_KEYS.filter(k => k === S.user.board);
  const mi = S.month - 1;

  let lastDay = null;
  for (const emp of S.employees) {
    for (const date of Object.keys((S.vsales[emp.id] || {}).entries || {})) {
      if (date.startsWith(prefix) && (lastDay === null || date > lastDay)) lastDay = date;
    }
  }
  const cutoff = lastDay; // null = sem dados

  const defW = +(100 / daysInCur).toFixed(6);
  let wAccum = 0;
  if (cutoff) {
    for (let d = 1; d <= daysInCur; d++) {
      const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
      if (ds > cutoff) break;
      wAccum += (S.weights[ds] ?? defW);
    }
  }

  // Realizado por loja até o último dia preenchido
  const realized = Object.fromEntries(STORE_KEYS.map(k => [k, 0]));
  for (const emp of S.employees.filter(e => e.isVendedor !== false)) {
    if (!STORE_KEYS.includes(emp.board)) continue;
    const entries = (S.vsales[emp.id] || {}).entries || {};
    for (let d = 1; d <= daysInCur; d++) {
      const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
      if (cutoff && ds > cutoff) break;
      const e = entries[ds];
      if (e) realized[emp.board] += e.value || 0;
    }
  }

  // Atualiza subtítulo com base no último dia preenchido
  const subEl = document.getElementById('compCardSub');
  if (subEl && cutoff) {
    const [,, dd] = cutoff.split('-');
    subEl.textContent = `até dia ${parseInt(dd)}/${pad(S.month)}`;
  }

  const mesLabel = MONTHS_PT[mi].slice(0,3) + '/' + String(S.year).slice(2);
  const lyLabel  = MONTHS_PT[mi].slice(0,3) + '/' + String(S.year - 1).slice(2);

  let html = `<table class="comp-table">
    <thead><tr class="comp-thead-tr">
      <th class="comp-th">Loja</th>
      <th class="comp-th comp-th-r">${mesLabel} proj.</th>
      <th class="comp-th comp-th-r">${lyLabel}</th>
      <th class="comp-th comp-th-r">Δ% a.a.</th>
    </tr></thead><tbody>`;

  let sumProj = 0, sumLY = 0;

  for (const k of STORE_KEYS) {
    const bc      = BOARDS[k];
    const real    = realized[k];
    const proj    = wAccum > 0 && real > 0 ? real / wAccum * 100 : (real || null);
    const lyVal   = PERF_HIST[k]?.[S.year - 1]?.[mi] || null;
    const delta   = proj && lyVal ? (proj - lyVal) / lyVal * 100 : null;
    const dCls    = delta == null ? '' : delta >= 0 ? 'kpi-pos' : 'kpi-neg';

    if (proj)  sumProj += proj;
    if (lyVal) sumLY   += lyVal;

    html += `<tr class="comp-row">
      <td class="comp-td comp-td-name" style="border-left:3px solid ${bc.color};padding-left:.5rem"><strong>${bc.label}</strong></td>
      <td class="comp-td comp-td-num comp-val-cur">${fV(proj)}</td>
      <td class="comp-td comp-td-num">${fV(lyVal)}</td>
      <td class="comp-td comp-td-num ${dCls}">${fPct(delta)}</td>
    </tr>`;
  }

  const totDelta = sumProj && sumLY ? (sumProj - sumLY) / sumLY * 100 : null;
  const totDCls  = totDelta == null ? '' : totDelta >= 0 ? 'kpi-pos' : 'kpi-neg';
  html += `<tr class="comp-row comp-row-cur">
    <td class="comp-td comp-td-name"><strong>TOTAL</strong></td>
    <td class="comp-td comp-td-num comp-val-cur">${fV(sumProj || null)}</td>
    <td class="comp-td comp-td-num">${fV(sumLY || null)}</td>
    <td class="comp-td comp-td-num ${totDCls}">${fPct(totDelta)}</td>
  </tr></tbody></table>`;

  body.innerHTML = html;
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
const PD = {
  board: null, year: null, month: null, data: null, metaLoja: 0,
  activeEmpId: null, employees: [], allVsales: {}, weights: {}, fluxo: {},
  container: null, boardSettings: {},
};

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
          <th>2026</th><th class="d26-sep">Δ 26/25</th><th class="d26">Δ 26/24</th><th class="d26">Δ 26/23</th><th class="d26">Δ 26/22</th>
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
    const d2624  = v26 !== null ? (v26 - h[2]) / h[2] * 100 : null;
    const d2623  = v26 !== null ? (v26 - h[1]) / h[1] * 100 : null;
    const d2622  = v26 !== null ? (v26 - h[0]) / h[0] * 100 : null;
    const dCell  = (d, extra='') => d !== null
      ? `<td class="${cls(d)} ${extra}" style="font-size:.72rem;white-space:nowrap">${sign(d)+d.toFixed(1)}%</td>`
      : `<td class="${extra}" style="font-size:.72rem;color:var(--muted)">—</td>`;
    const projTag = isProj ? ' <span style="color:#D29922;font-size:.62rem">proj</span>' : '';
    tableHtml += `<tr>
      <td style="white-space:nowrap">${mn}${projTag}</td>
      ${h.map((v, j) => `
        <td>${fmtBRL(v)}</td>
        <td class="${deltas[j] !== null ? cls(deltas[j]) : ''}" style="font-size:.72rem;white-space:nowrap">
          ${deltas[j] !== null ? sign(deltas[j])+deltas[j].toFixed(1)+'%' : '—'}
        </td>`).join('')}
      <td style="color:${isProj?'#D29922':'inherit'}">${v26 !== null ? fmtBRL(v26) : '—'}</td>
      ${dCell(d2625,'d26-sep')}${dCell(d2624,'d26')}${dCell(d2623,'d26')}${dCell(d2622,'d26')}
    </tr>`;
  });
  // Totals row
  const totDeltas = histYears.map((y,j) => j === 0 ? null : (colTotals[y]-colTotals[histYears[j-1]])/colTotals[histYears[j-1]]*100);
  const tot2625 = (colTotals.v26 - colTotals[2025]) / colTotals[2025] * 100;
  const tot2624 = (colTotals.v26 - colTotals[2024]) / colTotals[2024] * 100;
  const tot2623 = (colTotals.v26 - colTotals[2023]) / colTotals[2023] * 100;
  const tot2622 = (colTotals.v26 - colTotals[2022]) / colTotals[2022] * 100;
  const totDCell = (d, extra='') => `<td class="${cls(d)} ${extra}" style="font-size:.72rem">${sign(d)+d.toFixed(1)}%</td>`;
  tableHtml += `</tbody><tfoot><tr class="total-row">
    <td>TOTAL</td>
    ${histYears.map((y,j) => `
      <td>${fmtBRL(colTotals[y])}</td>
      <td class="${totDeltas[j]!==null?cls(totDeltas[j]):''}" style="font-size:.72rem">${totDeltas[j]!==null?sign(totDeltas[j])+totDeltas[j].toFixed(1)+'%':'—'}</td>
    `).join('')}
    <td>${fmtBRL(colTotals.v26)}</td>
    ${totDCell(tot2625,'d26-sep')}${totDCell(tot2624,'d26')}${totDCell(tot2623,'d26')}${totDCell(tot2622,'d26')}
  </tr></tfoot></table></div></div>`;

  body.innerHTML = kpiHtml + tableHtml + `
    <div class="perf-chart-box">
      <div class="perf-chart-title">${BOARDS[k]?.label} — Histórico Anual (2022–2026 proj.)</div>
      <div class="perf-chart-sub">Barras: total anual · Linha: variação % vs ano anterior</div>
      <div class="perf-chart-wrap" style="height:220px"><canvas id="perfAnnualCanvas"></canvas></div>
    </div>
    <div class="perf-chart-box">
      <div class="perf-chart-title">${BOARDS[k]?.label} — 2026 vs 2025 (mensal)</div>
      <div class="perf-chart-sub">Barras: faturamento real (Jan–Abr) e projetado (Mai–Dez) · Linha: variação % vs 2025 · Pontos âmbar = base da projeção</div>
      <div class="perf-chart-wrap"><canvas id="perfChartCanvas"></canvas></div>
    </div>`;

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
}

// ── Daily modal ────────────────────────────────────────────────────────────
function openDailyModal() {
  document.getElementById('dailyOverlay').classList.remove('hidden');
  const defaultStore = S.user?.board && S.user.board !== 'escritorio' ? S.user.board : 'delrey';
  PD.container = document.getElementById('dailyBody');
  PD.year      = S.year;
  PD.month     = S.month;
  buildDailyStoreTabs(defaultStore);
  loadAndRenderDaily(defaultStore);
}

function closeDailyModal() {
  document.getElementById('dailyOverlay').classList.add('hidden');
}

function buildDailyStoreTabs(activeBoard) {
  const tabs = document.getElementById('dailyStoreTabs');
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
    const color = BOARDS[k]?.color || '#8B949E';
    if (k === activeBoard) { btn.style.background = color; btn.style.color = '#0D1117'; }
    btn.addEventListener('click', () => {
      document.querySelectorAll('#dailyStoreTabs .perf-tab-btn').forEach(b => {
        const c = BOARDS[b.dataset.store]?.color || '#8B949E';
        b.style.background = b.dataset.store === k ? c : 'transparent';
        b.style.color      = b.dataset.store === k ? '#0D1117' : c;
      });
      PD.activeEmpId = null;
      loadAndRenderDaily(k);
    });
    tabs.appendChild(btn);
  });
}

function initDailyModal() {
  document.getElementById('dailyBtn').addEventListener('click', openDailyModal);
  document.getElementById('dailyClose').addEventListener('click', closeDailyModal);
  document.getElementById('dailyOverlay').addEventListener('click', e => {
    if (e.target.id === 'dailyOverlay') closeDailyModal();
  });
}

// ── Daily closing sheet ────────────────────────────────────────────────────
async function loadAndRenderDaily(board) {
  if (!board) board = PD.board || 'delrey';
  PD.board = board;
  if (perfChart)       { perfChart.destroy();       perfChart = null; }
  if (perfAnnualChart) { perfAnnualChart.destroy();  perfAnnualChart = null; }
  const body = PD.container;
  body.innerHTML = '<div style="text-align:center;padding:2.5rem;color:var(--muted)">Carregando…</div>';
  try {
    const allEmps = await apiFetch('GET', '/api/employees');
    PD.employees  = allEmps.filter(e => e.board === board && e.isVendedor !== false);
    PD.weights       = await apiFetch('GET', `/api/weights/${PD.year}/${PD.month}`);
    PD.fluxo         = await apiFetch('GET', `/api/storefluxo/${PD.year}/${PD.month}/${board}`);
    PD.boardSettings = await apiFetch('GET', '/api/board-settings');
    PD.allVsales  = {};
    const dsData  = await apiFetch('GET', `/api/dailysales/${PD.year}/${PD.month}/${board}`);
    PD.metaLoja   = dsData.meta?.mensal || 0;
    await Promise.all(PD.employees.map(async emp => {
      PD.allVsales[emp.id] = await apiFetch('GET', `/api/vsales/${PD.year}/${PD.month}/${board}/${emp.id}`);
    }));
    if (!PD.activeEmpId || !PD.employees.find(e => e.id === PD.activeEmpId))
      PD.activeEmpId = PD.employees.length ? PD.employees[0].id : 'total';
    renderVendedorSheet();
  } catch(e) {
    PD.container.innerHTML = `<div class="perf-no-data">Erro ao carregar: ${e.message}</div>`;
  }
}

function renderVendedorSheet() {
  const body    = PD.container;
  const isAdmin = !S.user?.board || S.user.board === 'escritorio';
  const emps    = PD.employees;
  const color   = BOARDS[PD.board]?.color || '#8B949E';

  let tabs = '';
  for (const emp of emps) {
    const active = PD.activeEmpId === emp.id;
    tabs += `<button class="ds-vtab${active ? ' ds-vtab-active' : ''}" data-empid="${emp.id}"
      style="${active ? `background:${color};border-color:${color};color:#0D1117` : `border-color:${color};color:${color}`}"
    >${emp.apelido || emp.name}</button>`;
  }
  const totActive = PD.activeEmpId === 'total';
  tabs += `<button class="ds-vtab ds-vtab-total${totActive ? ' ds-vtab-active' : ''}" data-empid="total">TOTAL</button>`;
  const syncActive = PD.boardSettings?.[PD.board]?.microvixSync === true;
  const adminBar = isAdmin
    ? `<div class="ds-admin-bar">
        <button class="ds-weights-btn" id="dsWeightsBtn">⚖ Pesos Diários %</button>
        <button class="ds-sync-toggle ${syncActive ? 'ds-sync-on' : 'ds-sync-off'}" id="dsSyncToggle" title="${syncActive ? 'Desativar sync Microvix (ativar preenchimento manual)' : 'Ativar sync Microvix'}">
          ${syncActive ? '⚡ Microvix' : '✏ Manual'}
        </button>
        <div class="ds-excel-btns">
          <a class="ds-excel-btn ds-excel-down" id="dsExcelDown" href="/api/excel/${PD.year}/${PD.month}/${PD.board}" download>⬇ Baixar Excel</a>
          <label class="ds-excel-btn ds-excel-up" id="dsExcelUpLabel">⬆ Upload Excel<input type="file" id="dsExcelUpInput" accept=".xlsx,.xls" style="display:none"></label>
        </div>
       </div>`
    : '';

  body.innerHTML = `<div class="ds-wrap">
    <div class="ds-vtabs-row">${tabs}</div>
    ${adminBar}
    <div id="dsSheetContent"></div>
  </div>`;

  if (isAdmin) {
    body.querySelector('#dsWeightsBtn')?.addEventListener('click', openWeightsModal);

    body.querySelector('#dsSyncToggle')?.addEventListener('click', async () => {
      const current = PD.boardSettings?.[PD.board]?.microvixSync === true;
      const next = !current;
      try {
        await apiFetch('PUT', `/api/board-settings/${PD.board}`, { microvixSync: next });
        if (!PD.boardSettings[PD.board]) PD.boardSettings[PD.board] = {};
        PD.boardSettings[PD.board].microvixSync = next;
        renderVendedorSheet();
        toast(next ? '⚡ Microvix sync ativado para esta loja' : '✏ Modo manual ativado');
      } catch (e) { toast('Erro: ' + e.message, true); }
    });

    const upInput = body.querySelector('#dsExcelUpInput');
    upInput?.addEventListener('change', async () => {
      const file = upInput.files[0];
      if (!file) return;
      const label = body.querySelector('#dsExcelUpLabel');
      label.textContent = '⏳ Enviando…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/excel/${PD.year}/${PD.month}/${PD.board}`, {
          method: 'POST', body: fd, credentials: 'same-origin'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro no upload');
        toast(`✓ ${data.updated} registros atualizados`);
        await loadAndRenderDaily(PD.board);
      } catch (e) {
        toast('Erro no upload: ' + e.message, true);
        label.innerHTML = '⬆ Upload Excel<input type="file" id="dsExcelUpInput" accept=".xlsx,.xls" style="display:none">';
      }
      upInput.value = '';
    });
  }

  body.querySelectorAll('.ds-vtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.empid;
      PD.activeEmpId = raw === 'total' ? 'total' : parseInt(raw);
      renderVendedorSheet();
    });
  });

  const content = document.getElementById('dsSheetContent');
  if (PD.activeEmpId === 'total') {
    content.appendChild(buildTotalSheet(isAdmin));
  } else {
    const emp = emps.find(e => e.id === PD.activeEmpId);
    if (emp) content.appendChild(buildVendedorSheet(emp, isAdmin));
  }
}

function _dsHelpers() {
  const fBRL = v => v != null ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v) : '—';
  const fPct = v => v != null ? `${v.toFixed(1)}%` : '—';
  const fNum = v => (v != null && v > 0) ? v.toLocaleString('pt-BR') : '—';
  const fDec = v => (v != null && v > 0) ? v.toFixed(2).replace('.', ',') : '—';
  return { fBRL, fPct, fNum, fDec };
}

function computeSellerDayGoals(empId) {
  const { year, month } = PD;
  if (!PD.metaLoja) return null;
  const days   = new Date(year, month, 0).getDate();
  const defW   = +(100 / days).toFixed(6);
  const vacSet = new Set(PD.allVsales[empId]?.meta?.vacationDays || []);
  const goals  = {};
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (vacSet.has(dateStr)) { goals[dateStr] = { goal: 0, nActive: 0, isVacation: true }; continue; }
    const W           = PD.weights[dateStr] ?? defW;
    const storeDayGoal = PD.metaLoja * W / 100;
    const nActive     = Math.max(1, PD.employees.filter(e =>
      !(PD.allVsales[e.id]?.meta?.vacationDays || []).includes(dateStr)
    ).length);
    goals[dateStr] = { goal: storeDayGoal / nActive, nActive, isVacation: false };
  }
  return goals;
}

function computeSellerMensal(empId) {
  const goals = computeSellerDayGoals(empId);
  if (!goals) return PD.allVsales[empId]?.meta?.mensal || 0;
  return Object.values(goals).reduce((s, v) => s + v.goal, 0);
}

function _dsRows(mensal, entries, weights, year, month, dayGoals) {
  const days    = new Date(year, month, 0).getDate();
  const defW    = +(100 / days).toFixed(6);
  const DAY_S   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const today   = new Date();
  const todayStr= `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let rows = [], metaAccum = 0, realAccum = 0;
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow     = new Date(year, month - 1, d).getDay();
    const w       = weights[dateStr] ?? defW;
    const dg      = dayGoals?.[dateStr];
    const metaDia = dg !== undefined ? dg.goal : mensal * w / 100;
    metaAccum    += metaDia;
    const entry   = entries[dateStr] || null;
    const valor   = entry?.value || 0;
    const pecas   = entry?.pecas || 0;
    const atend   = entry?.atendimentos || 0;
    if (entry) realAccum += valor;
    const pctAting = (metaDia > 0 && entry) ? valor / metaDia * 100 : null;
    const desvio   = (metaDia > 0 && entry) ? valor - metaDia : null;
    const projecao = (metaAccum > 0 && realAccum > 0) ? realAccum / metaAccum * mensal : null;
    const pa  = (pecas > 0 && atend > 0) ? pecas / atend : null;
    const pm  = (pecas > 0 && entry)     ? valor / pecas : null;
    const tm  = (atend > 0 && entry)     ? valor / atend : null;
    rows.push({ d, dateStr, dow, w, metaDia, metaAccum, entry, valor, pecas, atend,
                realAccum, pctAting, desvio, projecao, pa, pm, tm,
                dayInfo: dg || null, isToday: dateStr === todayStr, DAY_S });
  }
  return rows;
}

function _dsGroupHeader(extraCols) {
  const mn = MONTHS_PT[PD.month - 1].toUpperCase();
  return `<tr>
    <th colspan="4" class="ds-group-th">${mn}</th>
    <th colspan="2" class="ds-group-th">DESVIOS</th>
    <th colspan="3" class="ds-group-th">REALIZADO</th>
    <th colspan="${extraCols}" class="ds-group-th">KPIs</th>
  </tr>`;
}

function buildVendedorSheet(emp, isAdmin) {
  const { year, month } = PD;
  const syncActive = PD.boardSettings?.[PD.board]?.microvixSync === true;
  const vsale    = PD.allVsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
  const dayGoals = computeSellerDayGoals(emp.id);
  const mensal   = computeSellerMensal(emp.id);
  const { fBRL, fPct, fNum, fDec } = _dsHelpers();
  const rows     = _dsRows(mensal, vsale.entries || {}, PD.weights, year, month, dayGoals);

  const fmtTier      = v => v > 0 ? v.toFixed(2).replace('.',',') : '—';
  const metaInputVal = mensal > 0 ? mensal.toFixed(2).replace('.',',') : '';
  const meta2Val     = fmtTier(mensal * 1.10);
  const superMetaVal = fmtTier(mensal * 1.10 * 1.20);
  const vacDays      = vsale.meta?.vacationDays || [];

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="ds-top-bar">
      <div class="ds-meta-name"><strong>${emp.apelido || emp.name}</strong></div>
      <div class="ds-meta-bar">
        <div class="ds-meta-seg ds-meta-seg-1">
          <span class="ds-meta-seg-lbl">META 1${emp.comissao ? ` <span class="ds-meta-com-badge">${emp.comissao}%</span>` : ''}</span>
          <div class="ds-meta-seg-val-wrap">
            <span class="ds-meta-input ds-meta-input-hl" style="cursor:default;user-select:none">${metaInputVal || '—'}</span>
          </div>
        </div>
        <div class="ds-meta-seg ds-meta-seg-2">
          <span class="ds-meta-seg-lbl">META 2 <span class="ds-meta-seg-badge">+10%</span>${emp.comissaoMeta2 ? ` <span class="ds-meta-com-badge">${emp.comissaoMeta2}%</span>` : ''}</span>
          <span class="ds-meta-seg-val" id="dsMeta2Val">${meta2Val}</span>
        </div>
        <div class="ds-meta-seg ds-meta-seg-3">
          <span class="ds-meta-seg-lbl">SUPER META <span class="ds-meta-seg-badge">+20%</span>${emp.comissaoSuper ? ` <span class="ds-meta-com-badge ds-meta-com-badge-gold">${emp.comissaoSuper}%</span>` : ''}</span>
          <span class="ds-meta-seg-val" id="dsMetaSuperVal">${superMetaVal}</span>
        </div>
      </div>
      ${isAdmin && PD.metaLoja > 0 ? `<div class="ds-weight-hint-row"><span class="ds-weight-hint">· Clique em <strong>Part%</strong> para marcar/desmarcar férias do dia${vacDays.length > 0 ? ` · <span style="color:var(--down)">${vacDays.length} dia(s) de férias</span>` : ''}</span></div>` : ''}
      ${isAdmin && !PD.metaLoja ? `<div class="ds-weight-hint-row"><span class="ds-weight-hint">· Configure a <strong>Meta da Loja</strong> na aba TOTAL para calcular metas automaticamente</span></div>` : ''}
    </div>
    <div class="ds-table-wrap"><table class="ds-table">
      <thead>
        ${_dsGroupHeader(5)}
        <tr>
          <th class="ds-th-dia">Data</th>
          <th class="ds-th-meta">Meta Diária</th><th class="ds-th-meta">Meta Acum</th>
          <th title="Participação % do vendedor neste dia (0% = férias)">Part%</th>
          <th>% Ating</th><th>Desvio R$</th>
          <th class="ds-th-fillable">Valor</th><th>Acumulado</th><th>Projeção</th>
          <th class="ds-th-fillable">Pç</th><th class="ds-th-fillable" title="Atendimentos">Atend</th>
          <th>PA</th><th>PM</th><th>TM</th>
        </tr>
      </thead>
      <tbody></tbody><tfoot></tfoot>
    </table></div>`;

  const tbody = wrap.querySelector('tbody');
  const tfoot = wrap.querySelector('tfoot');

  for (const r of rows) {
    const isVac  = r.dayInfo?.isVacation || false;
    const isWE   = r.dow === 0 || r.dow === 6;
    const trCls  = [isWE ? 'ds-we' : '', r.isToday ? 'ds-today' : '', isVac ? 'ds-vac-day' : ''].filter(Boolean).join(' ');
    const pCls   = r.pctAting != null ? (r.pctAting >= 100 ? 'pf-pos' : r.pctAting >= 80 ? 'ds-warn' : 'pf-neg') : '';
    const dCls   = r.desvio != null ? (r.desvio >= 0 ? 'pf-pos' : 'pf-neg') : '';
    const partPct = r.dayInfo
      ? (isVac ? '0.00%' : `${(100 / r.dayInfo.nActive).toFixed(2)}%`)
      : r.w.toFixed(2) + '%';
    const tr = document.createElement('tr');
    tr.className = trCls; tr.dataset.date = r.dateStr;
    tr.innerHTML = `
      <td class="ds-td-dia">${r.d}<small class="ds-dow">${r.DAY_S[r.dow]}</small></td>
      <td class="ds-td-meta">${mensal > 0 ? fBRL(r.metaDia)    : '—'}</td>
      <td class="ds-td-meta">${mensal > 0 ? fBRL(r.metaAccum)  : '—'}</td>
      <td class="ds-td-peso${isAdmin && PD.metaLoja > 0 ? ' ds-editable' : ''}" data-date="${r.dateStr}" style="${isVac ? 'color:var(--down)' : ''}">${partPct}</td>
      <td class="ds-td-pct ${pCls}">${r.pctAting != null ? fPct(r.pctAting) : '—'}</td>
      <td class="${dCls}">${r.desvio != null ? fBRL(r.desvio) : '—'}</td>
      <td class="ds-td-edit ds-td-fillable${r.entry ? ' ds-has-val' : ''}${syncActive ? ' ds-sync-cell' : ''}" data-field="value"        data-date="${r.dateStr}">${r.entry ? fBRL(r.valor) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-calc">${r.entry ? fBRL(r.realAccum) : '—'}</td>
      <td class="ds-td-calc${r.projecao != null ? (r.projecao >= mensal ? ' pf-pos' : ' pf-neg') : ''}">${r.projecao != null ? fBRL(r.projecao) : '—'}</td>
      <td class="ds-td-edit ds-td-fillable${r.entry && r.pecas > 0 ? ' ds-has-val' : ''}${syncActive ? ' ds-sync-cell' : ''}" data-field="pecas"        data-date="${r.dateStr}">${r.entry && r.pecas > 0 ? fNum(r.pecas) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-edit ds-td-fillable${r.entry && r.atend > 0 ? ' ds-has-val' : ''}${syncActive ? ' ds-sync-cell' : ''}" data-field="atendimentos" data-date="${r.dateStr}">${r.entry && r.atend > 0 ? fNum(r.atend) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-calc${r.pa != null ? (r.pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${r.pa != null ? fDec(r.pa) : '—'}</td>
      <td class="ds-td-calc">${r.pm != null ? fBRL(r.pm) : '—'}</td>
      <td class="ds-td-calc">${r.tm != null ? fBRL(r.tm) : '—'}</td>`;
    tbody.appendChild(tr);
  }

  const sumReal  = rows.reduce((s,r) => s + (r.entry ? r.valor : 0), 0);
  const sumPecas = rows.reduce((s,r) => s + (r.entry ? r.pecas : 0), 0);
  const sumAtend = rows.reduce((s,r) => s + (r.entry ? r.atend : 0), 0);
  const totalW   = rows.reduce((s,r) => s + r.w, 0);
  const pctTot   = mensal > 0 && sumReal > 0 ? sumReal / mensal * 100 : null;
  const lastProj = [...rows].reverse().find(r => r.projecao != null)?.projecao ?? null;
  const totPA    = sumAtend > 0 ? sumPecas / sumAtend : null;
  const totPM    = sumPecas > 0 ? sumReal  / sumPecas : null;
  const totTM    = sumAtend > 0 ? sumReal  / sumAtend : null;
  const totPCls  = pctTot != null ? (pctTot >= 100 ? 'pf-pos' : pctTot >= 80 ? 'ds-warn' : 'pf-neg') : '';
  const tftr = document.createElement('tr');
  tftr.className = 'ds-total-row';
  tftr.innerHTML = `
    <td>TOTAL</td>
    <td>—</td><td class="ds-td-meta ds-td-meta-total">${mensal > 0 ? fBRL(mensal) : '—'}</td>
    <td>${totalW.toFixed(1)}%</td>
    <td class="${totPCls}">${pctTot != null ? fPct(pctTot) : '—'}</td>
    <td>—</td>
    <td>${sumReal > 0 ? fBRL(sumReal) : '—'}</td><td>—</td>
    <td class="${lastProj != null ? (lastProj >= mensal ? 'pf-pos' : 'pf-neg') : ''}">${lastProj != null ? fBRL(lastProj) : '—'}</td>
    <td>${fNum(sumPecas)}</td><td>${fNum(sumAtend)}</td>
    <td class="${totPA != null ? (totPA >= 1.8 ? 'pa-ok' : 'pa-low') : ''}">${totPA != null ? fDec(totPA) : '—'}</td>
    <td>${totPM != null ? fBRL(totPM) : '—'}</td>
    <td>${totTM != null ? fBRL(totTM) : '—'}</td>`;
  tfoot.appendChild(tftr);

  if (isAdmin && PD.metaLoja > 0) {
    wrap.querySelectorAll('.ds-td-peso.ds-editable').forEach(td =>
      td.addEventListener('click', () => toggleVacationDay(emp.id, td.dataset.date)));
  }
  wrap.querySelectorAll('.ds-td-edit').forEach(td =>
    td.addEventListener('click', () => startVendCellEdit(td, emp.id)));

  return wrap;
}

function buildTotalSheet(isAdmin) {
  const { year, month } = PD;
  const emps        = PD.employees;
  const { fBRL, fPct, fNum, fDec } = _dsHelpers();
  const totalMensal = PD.metaLoja > 0
    ? emps.reduce((s,e) => s + computeSellerMensal(e.id), 0)
    : emps.reduce((s,e) => s + (PD.allVsales[e.id]?.meta?.mensal || 0), 0);

  // Build merged entries per date
  const days    = new Date(year, month, 0).getDate();
  const defW    = +(100 / days).toFixed(6);
  const DAY_S   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const today   = new Date();
  const todayStr= `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  let rows = [], metaAccum = 0, realAccum = 0;
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow     = new Date(year, month - 1, d).getDay();
    const w       = PD.weights[dateStr] ?? defW;
    const metaDia = totalMensal * w / 100;
    metaAccum    += metaDia;
    let valor = 0, pecas = 0, atend = 0, hasEntry = false;
    for (const emp of emps) {
      const e = PD.allVsales[emp.id]?.entries?.[dateStr];
      if (e) { valor += e.value || 0; pecas += e.pecas || 0; atend += e.atendimentos || 0; hasEntry = true; }
    }
    if (hasEntry) realAccum += valor;
    const fluxoDia = PD.fluxo[dateStr] || 0;
    const pctAting = (metaDia > 0 && hasEntry) ? valor / metaDia * 100 : null;
    const desvio   = (metaDia > 0 && hasEntry) ? valor - metaDia : null;
    const projecao = (metaAccum > 0 && realAccum > 0) ? realAccum / metaAccum * totalMensal : null;
    const txConv   = (fluxoDia > 0 && atend > 0) ? atend / fluxoDia * 100 : null;
    const pa  = (pecas > 0 && atend > 0) ? pecas / atend : null;
    const pm  = (pecas > 0 && hasEntry)  ? valor / pecas : null;
    const tm  = (atend > 0 && hasEntry)  ? valor / atend : null;
    rows.push({ d, dateStr, dow, w, metaDia, metaAccum, hasEntry, valor, pecas, atend,
                fluxoDia, realAccum, pctAting, desvio, projecao, txConv, pa, pm, tm,
                isToday: dateStr === todayStr, DAY_S });
  }

  const fmtTier = v => v > 0 ? v.toFixed(2).replace('.',',') : '—';
  const meta2Total     = fmtTier(totalMensal * 1.10);
  const superMetaTotal = fmtTier(totalMensal * 1.10 * 1.20);
  const metaLojaFmt    = PD.metaLoja > 0 ? PD.metaLoja.toFixed(2).replace('.',',') : '';

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="ds-top-bar">
      <div class="ds-meta-bar">
        <div class="ds-meta-seg ds-meta-seg-1">
          <span class="ds-meta-seg-lbl">META DA LOJA</span>
          ${isAdmin
            ? `<div class="ds-meta-seg-val-wrap">
                 <input type="text" class="ds-meta-input ds-meta-input-hl" id="dsMetaLojaInput" value="${metaLojaFmt}" placeholder="0,00">
                 <button class="ds-meta-save-btn" id="dsMetaLojaSaveBtn">✓</button>
               </div>`
            : `<span class="ds-meta-seg-val">${metaLojaFmt || '—'}</span>`}
        </div>
        <div class="ds-meta-seg ds-meta-seg-2">
          <span class="ds-meta-seg-lbl">META 2 <span class="ds-meta-seg-badge">+10%</span></span>
          <span class="ds-meta-seg-val" id="dsTotalMeta2Val">${meta2Total}</span>
        </div>
        <div class="ds-meta-seg ds-meta-seg-3">
          <span class="ds-meta-seg-lbl">SUPER META <span class="ds-meta-seg-badge">+20%</span></span>
          <span class="ds-meta-seg-val" id="dsTotalSuperVal">${superMetaTotal}</span>
        </div>
      </div>
      ${isAdmin ? `<div class="ds-weight-hint-row"><span class="ds-weight-hint">· Clique em <strong>Peso%</strong> para ajustar (global — vale p/ todas as lojas)</span></div>` : ''}
    </div>
    <div class="ds-table-wrap"><table class="ds-table">
      <thead>
        ${_dsGroupHeader(7)}
        <tr>
          <th class="ds-th-dia">Data</th>
          <th class="ds-th-meta">Meta Diária</th><th class="ds-th-meta">Meta Acum</th>
          <th title="Peso % do dia">Peso%</th>
          <th>% Ating</th><th>Desvio R$</th>
          <th class="ds-th-fillable">Valor</th><th>Acumulado</th><th>Projeção</th>
          <th class="ds-th-fillable">Pç</th><th class="ds-th-fillable" title="Atendimentos">Atend</th>
          <th>Fluxo</th><th>Tx Conv</th>
          <th>PA</th><th>PM</th><th>TM</th>
        </tr>
      </thead>
      <tbody></tbody><tfoot></tfoot>
    </table></div>`;

  const tbody = wrap.querySelector('tbody');
  const tfoot = wrap.querySelector('tfoot');

  for (const r of rows) {
    const isWE  = r.dow === 0 || r.dow === 6;
    const trCls = [isWE ? 'ds-we' : '', r.isToday ? 'ds-today' : ''].filter(Boolean).join(' ');
    const pCls  = r.pctAting != null ? (r.pctAting >= 100 ? 'pf-pos' : r.pctAting >= 80 ? 'ds-warn' : 'pf-neg') : '';
    const dCls  = r.desvio != null ? (r.desvio >= 0 ? 'pf-pos' : 'pf-neg') : '';
    const tr = document.createElement('tr');
    tr.className = trCls; tr.dataset.date = r.dateStr;
    tr.innerHTML = `
      <td class="ds-td-dia">${r.d}<small class="ds-dow">${r.DAY_S[r.dow]}</small></td>
      <td class="ds-td-meta">${totalMensal > 0 ? fBRL(r.metaDia)   : '—'}</td>
      <td class="ds-td-meta">${totalMensal > 0 ? fBRL(r.metaAccum) : '—'}</td>
      <td class="ds-td-peso${isAdmin ? ' ds-editable' : ''}" data-date="${r.dateStr}">${r.w.toFixed(2)}%</td>
      <td class="ds-td-pct ${pCls}">${r.pctAting != null ? fPct(r.pctAting) : '—'}</td>
      <td class="${dCls}">${r.desvio != null ? fBRL(r.desvio) : '—'}</td>
      <td class="ds-td-calc ds-td-fillable${r.hasEntry ? ' ds-has-val' : ''}">${r.hasEntry ? fBRL(r.valor) : '—'}</td>
      <td class="ds-td-calc">${r.hasEntry ? fBRL(r.realAccum) : '—'}</td>
      <td class="ds-td-calc${r.projecao != null ? (r.projecao >= totalMensal ? ' pf-pos' : ' pf-neg') : ''}">${r.projecao != null ? fBRL(r.projecao) : '—'}</td>
      <td class="ds-td-calc ds-td-fillable">${r.hasEntry ? fNum(r.pecas) : '—'}</td>
      <td class="ds-td-calc ds-td-fillable">${r.hasEntry ? fNum(r.atend) : '—'}</td>
      <td class="ds-td-edit${r.fluxoDia > 0 ? ' ds-has-val' : ''}" data-field="fluxo" data-date="${r.dateStr}">${r.fluxoDia > 0 ? fNum(r.fluxoDia) : '<span class="ds-empty">—</span>'}</td>
      <td class="ds-td-calc">${r.txConv != null ? fPct(r.txConv) : '—'}</td>
      <td class="ds-td-calc${r.pa != null ? (r.pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${r.pa != null ? fDec(r.pa) : '—'}</td>
      <td class="ds-td-calc">${r.pm != null ? fBRL(r.pm) : '—'}</td>
      <td class="ds-td-calc">${r.tm != null ? fBRL(r.tm) : '—'}</td>`;
    tbody.appendChild(tr);
  }

  const sumReal  = rows.reduce((s,r) => s + (r.hasEntry ? r.valor : 0), 0);
  const sumPecas = rows.reduce((s,r) => s + (r.hasEntry ? r.pecas : 0), 0);
  const sumAtend = rows.reduce((s,r) => s + (r.hasEntry ? r.atend : 0), 0);
  const sumFluxo = rows.reduce((s,r) => s + r.fluxoDia, 0);
  const totalW   = rows.reduce((s,r) => s + r.w, 0);
  const pctTot   = totalMensal > 0 && sumReal > 0 ? sumReal / totalMensal * 100 : null;
  const lastProj = [...rows].reverse().find(r => r.projecao != null)?.projecao ?? null;
  const totTxConv= sumFluxo > 0 && sumAtend > 0 ? sumAtend / sumFluxo * 100 : null;
  const totPA    = sumAtend > 0 ? sumPecas / sumAtend : null;
  const totPM    = sumPecas > 0 ? sumReal  / sumPecas : null;
  const totTM    = sumAtend > 0 ? sumReal  / sumAtend : null;
  const totPCls  = pctTot != null ? (pctTot >= 100 ? 'pf-pos' : pctTot >= 80 ? 'ds-warn' : 'pf-neg') : '';
  const tftr = document.createElement('tr');
  tftr.className = 'ds-total-row';
  tftr.innerHTML = `
    <td>TOTAL</td>
    <td>—</td><td class="ds-td-meta ds-td-meta-total">${totalMensal > 0 ? fBRL(totalMensal) : '—'}</td>
    <td>${totalW.toFixed(1)}%</td>
    <td class="${totPCls}">${pctTot != null ? fPct(pctTot) : '—'}</td>
    <td>—</td>
    <td>${sumReal > 0 ? fBRL(sumReal) : '—'}</td><td>—</td>
    <td class="${lastProj != null ? (lastProj >= totalMensal ? 'pf-pos' : 'pf-neg') : ''}">${lastProj != null ? fBRL(lastProj) : '—'}</td>
    <td>${fNum(sumPecas)}</td><td>${fNum(sumAtend)}</td>
    <td>${fNum(sumFluxo)}</td>
    <td>${totTxConv != null ? fPct(totTxConv) : '—'}</td>
    <td class="${totPA != null ? (totPA >= 1.8 ? 'pa-ok' : 'pa-low') : ''}">${totPA != null ? fDec(totPA) : '—'}</td>
    <td>${totPM != null ? fBRL(totPM) : '—'}</td>
    <td>${totTM != null ? fBRL(totTM) : '—'}</td>`;
  tfoot.appendChild(tftr);

  if (isAdmin) {
    wrap.querySelector('#dsMetaLojaSaveBtn')?.addEventListener('click', () => {
      const raw = wrap.querySelector('#dsMetaLojaInput').value.replace(/[^\d,\.]/g,'').replace(',','.');
      saveMetaLoja(parseFloat(raw) || 0);
    });
    wrap.querySelectorAll('.ds-td-peso.ds-editable').forEach(td =>
      td.addEventListener('click', () => startGlobalWeightEdit(td)));
  }
  wrap.querySelectorAll('.ds-td-edit').forEach(td =>
    td.addEventListener('click', () => startFluxoCellEdit(td)));

  return wrap;
}

function _syncPDToS() {
  if (PD.year !== S.year || PD.month !== S.month) return;
  for (const [empId, data] of Object.entries(PD.allVsales)) S.vsales[empId] = data;
  if (PD.weights && Object.keys(PD.weights).length) Object.assign(S.weights, PD.weights);
  renderDashboard();
  _checkWeeklyCelebrations();
}

function _checkWeeklyCelebrations() {
  const today = new Date();
  const pad = n => String(n).padStart(2,'0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const week = getWeekForDate(todayStr);
  if (week.startStr > todayStr || week.endStr < todayStr) return;

  const pending = [];

  for (const [bk, bc] of visibleBoards()) {
    const emps = S.employees.filter(e => e.board === bk && e.isVendedor !== false);
    if (!emps.length) continue;
    let totValor = 0, totMeta = 0;

    for (const emp of emps) {
      const k = calcWeekKpis(emp, week, null);
      totValor += k.valor;
      totMeta  += k.wMeta;

      if (k.hitMeta && k.wMeta > 0) {
        const empKey = `wk-emp-${emp.id}-${week.startStr}`;
        if (!META_ACHIEVED.has(empKey)) {
          META_ACHIEVED.add(empKey);
          pending.push({ label: emp.apelido || emp.name, color: bc.color });
        }
      }
    }

    if (totMeta > 0 && totValor >= totMeta) {
      const storeKey = `wk-store-${bk}-${week.startStr}`;
      if (!META_ACHIEVED.has(storeKey)) {
        META_ACHIEVED.add(storeKey);
        pending.push({ label: bc.label, color: bc.color });
      }
    }
  }

  pending.forEach((cel, i) => {
    setTimeout(() => triggerMetaCelebration(cel.label, cel.color), 350 + i * 1800);
  });
}

async function saveVendedorMeta(empId, mensal) {
  try {
    await apiFetch('POST', `/api/vsales/${PD.year}/${PD.month}/${PD.board}/${empId}/meta`, { mensal });
    if (!PD.allVsales[empId]) PD.allVsales[empId] = { meta: { mensal: 0 }, entries: {} };
    PD.allVsales[empId].meta.mensal = mensal;
    toast('Meta salva ✓');
    renderVendedorSheet();
    _syncPDToS();
  } catch(e) { toast('Erro ao salvar meta: ' + e.message, true); }
}

async function saveMetaLoja(metaLoja) {
  try {
    await apiFetch('POST', `/api/dailysales/${PD.year}/${PD.month}/${PD.board}/meta`, { mensal: metaLoja });
    PD.metaLoja = metaLoja;
    await _saveAllSellerMensals();
    toast('Meta da loja distribuída ✓');
    renderVendedorSheet();
    _syncPDToS();
  } catch(e) { toast('Erro ao salvar meta da loja: ' + e.message, true); }
}

async function _saveAllSellerMensals() {
  await Promise.all(PD.employees.map(async emp => {
    const mensal = computeSellerMensal(emp.id);
    await apiFetch('POST', `/api/vsales/${PD.year}/${PD.month}/${PD.board}/${emp.id}/meta`, { mensal });
    if (!PD.allVsales[emp.id]) PD.allVsales[emp.id] = { meta: { mensal: 0 }, entries: {} };
    PD.allVsales[emp.id].meta.mensal = mensal;
  }));
}

function toggleVacationDay(empId, dateStr) {
  if (!PD.allVsales[empId]) PD.allVsales[empId] = { meta: { mensal: 0 }, entries: {} };
  if (!PD.allVsales[empId].meta.vacationDays) PD.allVsales[empId].meta.vacationDays = [];
  const vd  = PD.allVsales[empId].meta.vacationDays;
  const idx = vd.indexOf(dateStr);
  if (idx >= 0) vd.splice(idx, 1); else vd.push(dateStr);
  saveSellerVacationDays(empId);
}

async function saveSellerVacationDays(empId) {
  const scrollTop = document.querySelector('#dailyBody .ds-table-wrap')?.scrollTop || 0;
  try {
    const vacationDays = PD.allVsales[empId]?.meta?.vacationDays || [];
    await apiFetch('POST', `/api/vsales/${PD.year}/${PD.month}/${PD.board}/${empId}/meta`, { vacationDays });
    await _saveAllSellerMensals();
    toast('Férias atualizadas ✓');
    renderVendedorSheet();
    const tw = document.querySelector('#dailyBody .ds-table-wrap');
    if (tw) tw.scrollTop = scrollTop;
    _syncPDToS();
  } catch(e) { toast('Erro ao salvar férias: ' + e.message, true); }
}

function startVendCellEdit(td, empId) {
  if (PD.boardSettings?.[PD.board]?.microvixSync === true) {
    toast('Sync Microvix ativo — clique em "Manual" para editar manualmente.', true);
    return;
  }
  const field   = td.dataset.field;
  const dateStr = td.dataset.date;
  if (!PD.allVsales[empId]) PD.allVsales[empId] = { meta: { mensal: 0 }, entries: {} };
  const existing = PD.allVsales[empId].entries[dateStr] || {};
  const isValue  = field === 'value';
  const cur      = existing[field] || 0;

  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'ds-cell-input';
  inp.placeholder = isValue ? '0,00' : '0';
  inp.value = cur > 0 ? (isValue ? cur.toFixed(2).replace('.',',') : cur) : '';
  td.innerHTML = ''; td.appendChild(inp);
  inp.focus(); inp.select();

  const commit = async () => {
    let val = isValue
      ? parseFloat(inp.value.replace(/\./g,'').replace(',','.')) || 0
      : parseInt(inp.value.replace(/\D/g,'')) || 0;
    const merged = { value: existing.value||0, pecas: existing.pecas||0, atendimentos: existing.atendimentos||0 };
    merged[field] = val;
    try {
      if (!merged.value && !merged.pecas && !merged.atendimentos) {
        await apiFetch('DELETE', `/api/vsales/${PD.year}/${PD.month}/${PD.board}/${empId}/${dateStr}`);
        delete PD.allVsales[empId].entries[dateStr];
      } else {
        await apiFetch('PUT', `/api/vsales/${PD.year}/${PD.month}/${PD.board}/${empId}/${dateStr}`, merged);
        PD.allVsales[empId].entries[dateStr] = merged;
      }
    } catch(e) { toast('Erro: ' + e.message, true); }
    _renderKeepScroll();
    _syncPDToS();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => { if (e.key==='Enter') inp.blur(); if (e.key==='Escape') _renderKeepScroll(); });
}

function _renderKeepScroll() {
  const tw = document.querySelector('#dailyBody .ds-table-wrap');
  const scrollTop = tw?.scrollTop || 0;
  renderVendedorSheet();
  const tw2 = document.querySelector('#dailyBody .ds-table-wrap');
  if (tw2) tw2.scrollTop = scrollTop;
}

function startFluxoCellEdit(td) {
  const dateStr = td.dataset.date;
  const cur = PD.fluxo[dateStr] || 0;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'ds-cell-input';
  inp.placeholder = '0'; inp.value = cur > 0 ? cur : '';
  td.innerHTML = ''; td.appendChild(inp);
  inp.focus(); inp.select();

  const commit = async () => {
    const val = parseInt(inp.value.replace(/\D/g,'')) || 0;
    try {
      await apiFetch('PUT', `/api/storefluxo/${PD.year}/${PD.month}/${PD.board}/${dateStr}`, { value: val });
      if (val === 0) delete PD.fluxo[dateStr]; else PD.fluxo[dateStr] = val;
    } catch(e) { toast('Erro: ' + e.message, true); }
    _renderKeepScroll();
    _syncPDToS();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => { if (e.key==='Enter') inp.blur(); if (e.key==='Escape') _renderKeepScroll(); });
}

function startGlobalWeightEdit(td) {
  const dateStr = td.dataset.date;
  const days    = new Date(PD.year, PD.month, 0).getDate();
  const defW    = +(100 / days).toFixed(6);
  const cur     = PD.weights[dateStr] ?? defW;
  const inp = document.createElement('input');
  inp.type = 'number'; inp.className = 'ds-cell-input';
  inp.value = cur.toFixed(2); inp.step = '0.01'; inp.min = '0'; inp.max = '100';
  inp.style.width = '65px';
  td.innerHTML = ''; td.appendChild(inp);
  inp.focus(); inp.select();

  const commit = async () => {
    const val = parseFloat(inp.value) || defW;
    PD.weights[dateStr] = val;
    try {
      await apiFetch('POST', `/api/weights/${PD.year}/${PD.month}`, { weights: PD.weights });
    } catch(e) { toast('Erro ao salvar peso: ' + e.message, true); }
    renderVendedorSheet();
    _syncPDToS();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => { if (e.key==='Enter') inp.blur(); if (e.key==='Escape') renderVendedorSheet(); });
}

// ── Weights modal ──────────────────────────────────────────────────────────
function openWeightsModal() {
  const { year, month } = PD;
  const days   = new Date(year, month, 0).getDate();
  const defW   = +(100 / days).toFixed(6);
  const DAY_S  = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  document.getElementById('weightsMonthLbl').textContent = `${MONTHS_PT[month-1]} ${year}`;

  let html = '<div class="weights-grid">';
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow     = new Date(year, month - 1, d).getDay();
    const isWE    = dow === 0 || dow === 6;
    const val     = (PD.weights[dateStr] ?? defW).toFixed(2);
    html += `<div class="wg-row${isWE ? ' wg-we' : ''}">
      <span class="wg-day">${String(d).padStart(2,'0')}</span>
      <span class="wg-dow">${DAY_S[dow]}</span>
      <input type="number" class="wg-input" data-date="${dateStr}" value="${val}" min="0" max="100" step="0.01">
      <span class="wg-pct">%</span>
    </div>`;
  }
  html += '</div>';
  document.getElementById('weightsBody').innerHTML = html;
  document.getElementById('weightsModal').classList.remove('hidden');
  updateWeightsTotal();

  document.querySelectorAll('.wg-input').forEach(inp =>
    inp.addEventListener('input', updateWeightsTotal));
}

function updateWeightsTotal() {
  const inputs = document.querySelectorAll('.wg-input');
  let total = 0;
  inputs.forEach(inp => { total += parseFloat(inp.value) || 0; });
  const el  = document.getElementById('weightsTotalVal');
  el.textContent = total.toFixed(2) + '%';
  const diff = Math.abs(total - 100);
  el.style.color = diff < 0.01 ? 'var(--up)' : diff < 1 ? 'var(--warn)' : 'var(--down)';
}

function closeWeightsModal() {
  document.getElementById('weightsModal').classList.add('hidden');
}

async function saveWeights() {
  const inputs  = document.querySelectorAll('.wg-input');
  const weights = {};
  inputs.forEach(inp => { weights[inp.dataset.date] = parseFloat(inp.value) || 0; });
  try {
    await apiFetch('POST', `/api/weights/${PD.year}/${PD.month}`, { weights });
    PD.weights = weights;
    toast('Pesos salvos ✓');
    closeWeightsModal();
    renderVendedorSheet();
  } catch(e) { toast('Erro ao salvar pesos: ' + e.message, true); }
}

function distribuirIgualmente() {
  const inputs = document.querySelectorAll('.wg-input');
  const w = (100 / inputs.length).toFixed(2);
  inputs.forEach(inp => { inp.value = w; });
  updateWeightsTotal();
}

function initWeightsModal() {
  document.getElementById('weightsClose').addEventListener('click', closeWeightsModal);
  document.getElementById('weightsEqBtn').addEventListener('click', distribuirIgualmente);
  document.getElementById('weightsSaveBtn').addEventListener('click', saveWeights);
  document.getElementById('weightsModal').addEventListener('click', e => {
    if (e.target.id === 'weightsModal') closeWeightsModal();
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

// ── Metas Semanais ─────────────────────────────────────────────────────────
const PREMIO_VENDAS = 80;
const PREMIO_PA    = 50;
const PA_THRESHOLD = 1.80;

let WK = { refDate: null, cache: {} };
let DASH_WEEK = { refDate: null };
let DASH_DAY  = { refDate: null };
let _dayCardTimer = null;
let DASH_BOARD_FILTER = new Set(); // empty = todas as lojas

function _startDayCardAutoRefresh() {
  if (_dayCardTimer) clearInterval(_dayCardTimer);
  const now = new Date();
  const isCurrentMonth = S.year === now.getFullYear() && S.month === now.getMonth() + 1;
  if (!isCurrentMonth) return; // sem refresh em meses passados
  const INTERVAL = 5 * 60 * 1000; // 5 min — alinhado ao sync do servidor
  _dayCardTimer = setInterval(async () => {
    try {
      const pad = n => String(n).padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
      // Re-busca vsales de todos os funcionários do mês atual
      const vsalesArr = await Promise.all(
        S.employees.map(emp =>
          apiFetch('GET', `/api/vsales/${S.year}/${S.month}/${emp.board}/${emp.id}`)
            .then(d => [emp.id, d])
            .catch(() => [emp.id, S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} }])
        )
      );
      S.vsales = Object.fromEntries(vsalesArr);
      // Atualiza o cutoff (último dia com dados)
      const prefix = `${S.year}-${pad(S.month)}-`;
      let lastFilled = null;
      for (const emp of S.employees) {
        for (const date of Object.keys((S.vsales[emp.id] || {}).entries || {})) {
          if (date.startsWith(prefix) && (lastFilled === null || date > lastFilled)) lastFilled = date;
        }
      }
      const cutoff = lastFilled || todayStr;
      if (DASH_DAY.refDate > cutoff) DASH_DAY.refDate = cutoff;
      // Re-renderiza só o body do card diário
      const body = document.getElementById('dayCardBody');
      const lbl  = document.getElementById('dayCardLabel');
      const btnN = document.getElementById('dayCardNext');
      if (!body) return;
      _renderDayCardBody(body, DASH_DAY.refDate);
      if (lbl) {
        const d = DASH_DAY.refDate;
        lbl.textContent = d === todayStr ? `Hoje · ${d.slice(8)}/${d.slice(5,7)}` : `${d.slice(8)}/${d.slice(5,7)}`;
      }
      if (btnN) btnN.disabled = DASH_DAY.refDate >= cutoff;
    } catch (e) {
      console.warn('[DayCard] Refresh error:', e.message);
    }
  }, INTERVAL);
}
let DASH_SORT = { col: null, dir: 1 };
const META_ACHIEVED = new Set();

// Returns { startStr, endStr, label } for the Sun–Sat week containing dateStr
function getWeekForDate(dateStr) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  const sun = new Date(d);
  const sat = new Date(d); sat.setDate(sat.getDate() + 6);
  const startStr = `${sun.getFullYear()}-${pad(sun.getMonth()+1)}-${pad(sun.getDate())}`;
  const endStr   = `${sat.getFullYear()}-${pad(sat.getMonth()+1)}-${pad(sat.getDate())}`;
  const label    = `${pad(sun.getDate())}/${pad(sun.getMonth()+1)} – ${pad(sat.getDate())}/${pad(sat.getMonth()+1)}`;
  return { startStr, endStr, label };
}

// Always returns 7-day (Sun–Sat) weeks that cover the given month
function getWeeksInMonth(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const weeks = [];
  const lastDay = new Date(year, month, 0);
  const firstDay = new Date(year, month - 1, 1);
  // Sunday on or before the 1st
  const cur = new Date(firstDay);
  cur.setDate(cur.getDate() - cur.getDay());
  let num = 1;
  while (cur <= lastDay) {
    const wEnd = new Date(cur); wEnd.setDate(wEnd.getDate() + 6);
    const startStr = `${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`;
    const endStr   = `${wEnd.getFullYear()}-${pad(wEnd.getMonth()+1)}-${pad(wEnd.getDate())}`;
    const label    = `${pad(cur.getDate())}/${pad(cur.getMonth()+1)} – ${pad(wEnd.getDate())}/${pad(wEnd.getMonth()+1)}`;
    weeks.push({ num, startStr, endStr, label });
    cur.setDate(cur.getDate() + 7);
    num++;
  }
  return weeks;
}

// Load vsales+weights for a month key "YYYY-MM", using WK.cache
async function loadMonthData(year, month) {
  const key = `${year}-${String(month).padStart(2,'0')}`;
  if (WK.cache[key]) return WK.cache[key];
  const [emps, weights, weeklyMetas] = await Promise.all([
    Promise.resolve(S.employees),
    apiFetch('GET', `/api/weights/${year}/${month}`).catch(() => ({})),
    apiFetch('GET', `/api/weekly-metas/${year}/${month}`).catch(() => ({})),
  ]);
  const vsalesArr = await Promise.all(emps.map(emp =>
    apiFetch('GET', `/api/vsales/${year}/${month}/${emp.board}/${emp.id}`)
      .then(d => [emp.id, d])
      .catch(() => [emp.id, { meta: { mensal: 0 }, entries: {} }])
  ));
  const data = {
    vsales: Object.fromEntries(vsalesArr),
    weights: weights || {},
    weeklyMetas: weeklyMetas || {},
  };
  WK.cache[key] = data;
  return data;
}

function calcWeekKpis(emp, week, extraData) {
  const curKey = `${S.year}-${String(S.month).padStart(2,'0')}`;
  const vsale  = S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
  const mensal = vsale.meta?.mensal || 0;

  const today = new Date();
  const pad = n => String(n).padStart(2,'0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

  // Último dia com lançamento no mês atual (mesma base dos outros cards)
  const curPrefix = `${S.year}-${pad(S.month)}-`;
  let lastFilled = null;
  for (const emp2 of S.employees) {
    for (const date of Object.keys((S.vsales[emp2.id] || {}).entries || {})) {
      if (date.startsWith(curPrefix) && (lastFilled === null || date > lastFilled)) lastFilled = date;
    }
  }
  const cutoff = lastFilled || todayStr;

  // Build 7 dates for the week
  const startDate = new Date(week.startStr + 'T00:00:00');
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate); d.setDate(d.getDate() + i);
    dates.push(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
  }

  // Weight sum for the week (uses current month weights + extraData for other months)
  let weekWeightSum = 0;
  for (const ds of dates) {
    const monthKey = ds.slice(0, 7);
    if (monthKey === curKey) {
      const daysInMonth = new Date(S.year, S.month, 0).getDate();
      weekWeightSum += (S.weights[ds] ?? +(100 / daysInMonth).toFixed(6));
    } else if (extraData?.[monthKey]?.weights) {
      const [y, m] = monthKey.split('-').map(Number);
      const dim = new Date(y, m, 0).getDate();
      weekWeightSum += (extraData[monthKey].weights[ds] ?? +(100 / dim).toFixed(6));
    }
  }

  const autoMeta   = mensal * weekWeightSum / 100;
  // check manual meta override from current AND extra months
  const wkMetasForWeek = S.weeklyMetas[week.startStr] ||
    (extraData && Object.values(extraData).find(d => d.weeklyMetas?.[week.startStr])?.weeklyMetas?.[week.startStr]) || {};
  const manualMeta = wkMetasForWeek[emp.id]?.meta;
  const wMeta      = (manualMeta > 0) ? manualMeta : autoMeta;

  let valor = 0, pecas = 0, atend = 0, daysElapsed = 0;

  for (const ds of dates) {
    if (ds > cutoff) break;
    daysElapsed++;
    const monthKey = ds.slice(0, 7);
    let entry;
    if (monthKey === curKey) {
      entry = vsale.entries?.[ds];
    } else if (extraData?.[monthKey]?.vsales?.[emp.id]) {
      entry = extraData[monthKey].vsales[emp.id].entries?.[ds];
    }
    if (entry) { valor += entry.value||0; pecas += entry.pecas||0; atend += entry.atendimentos||0; }
  }

  const pa = (pecas > 0 && atend > 0) ? pecas / atend : null;
  const pctMeta = (wMeta > 0 && valor > 0) ? valor / wMeta * 100 : null;

  const isComplete = week.endStr < todayStr ||
    (week.endStr === todayStr && daysElapsed === 7);
  const isFuture   = week.startStr > todayStr;

  let projecao = null;
  if (!isFuture && wMeta > 0 && daysElapsed > 0 && valor > 0) {
    projecao = valor / (wMeta * daysElapsed / 7) * wMeta;
  }
  if (isComplete) projecao = valor;

  const hitMeta = wMeta > 0 && valor >= wMeta;
  const hitPA   = pa != null && pa > PA_THRESHOLD;
  const pVendas = isComplete ? (hitMeta ? PREMIO_VENDAS : 0) : null;
  const pPA     = isComplete ? (hitMeta && hitPA ? PREMIO_PA : 0) : null;
  const pTotal  = pVendas != null ? pVendas + (pPA||0) : null;

  return { wMeta, valor, pa, pecas, atend, pctMeta, projecao,
           hitMeta, hitPA, pVendas, pPA, pTotal,
           isComplete, isFuture, daysElapsed, totalDays: 7 };
}

function openWeeklyModal() {
  const today = new Date();
  const pad = n => String(n).padStart(2,'0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const w = getWeekForDate(todayStr);
  WK.refDate = w.startStr;
  document.getElementById('weeklyOverlay').classList.remove('hidden');
  renderWeeklyModal();
}

function closeWeeklyModal() {
  document.getElementById('weeklyOverlay').classList.add('hidden');
}

async function renderWeeklyModal() {
  const week    = getWeekForDate(WK.refDate);
  const isAdmin = !S.user?.board || S.user.board === 'escritorio';

  // Determine which months this week touches
  const startMonth = WK.refDate.slice(0, 7);
  const endMonth   = week.endStr.slice(0, 7);
  const curKey     = `${S.year}-${String(S.month).padStart(2,'0')}`;

  // Load any extra month data needed
  const extraData = {};
  for (const mk of [startMonth, endMonth]) {
    if (mk !== curKey) {
      const [y, m] = mk.split('-').map(Number);
      extraData[mk] = await loadMonthData(y, m);
    }
  }

  // Update navigation bar
  const nav = document.getElementById('weeklyTabs');
  const today = new Date();
  const pad = n => String(n).padStart(2,'0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const isCurrent = week.startStr <= todayStr && week.endStr >= todayStr;
  nav.innerHTML = `
    <button class="wk-nav-btn" id="wkPrev" title="Semana anterior">&#8592;</button>
    <span class="wk-nav-label">
      ${week.label}
      ${isCurrent ? '<span class="wk-nav-badge">Semana atual</span>' : ''}
    </span>
    <button class="wk-nav-btn" id="wkNext" title="Próxima semana">&#8594;</button>
  `;
  document.getElementById('wkPrev').addEventListener('click', () => {
    const d = new Date(WK.refDate + 'T00:00:00');
    d.setDate(d.getDate() - 7);
    WK.refDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    renderWeeklyModal();
  });
  document.getElementById('wkNext').addEventListener('click', () => {
    const d = new Date(WK.refDate + 'T00:00:00');
    d.setDate(d.getDate() + 7);
    WK.refDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    renderWeeklyModal();
  });

  // Build body
  const body = document.getElementById('weeklyBody');
  body.innerHTML = '';

  const byBoard = {};
  for (const emp of S.employees) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }

  const fBRL = v => v == null ? '—' : new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const fPct = v => v == null ? '—' : v.toFixed(1)+'%';
  const fDec = v => v == null ? '—' : v.toFixed(2);

  const pendingCelebrations = [];

  for (const [bk, bc] of visibleBoards()) {
    const emps = (byBoard[bk] || []).filter(e => e.isVendedor !== false);
    if (emps.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'wk-section';

    let totValor=0, totPecas=0, totAtend=0, totMeta=0, totPremio=0, totProjecao2=0, hasProj2=false;

    const rows = emps.map(emp => {
      const k = calcWeekKpis(emp, week, Object.keys(extraData).length ? extraData : null);
      totValor += k.valor; totPecas += k.pecas; totAtend += k.atend; totMeta += k.wMeta;
      if (k.pTotal != null) totPremio += k.pTotal;
      if (k.projecao != null) { totProjecao2 += k.projecao; hasProj2 = true; }

      if (isCurrent && k.hitMeta && k.wMeta > 0) {
        const empKey = `wk-emp-${emp.id}-${week.startStr}`;
        if (!META_ACHIEVED.has(empKey)) {
          META_ACHIEVED.add(empKey);
          pendingCelebrations.push({ label: emp.apelido || emp.name, color: bc.color });
        }
      }

      const pctCls  = k.pctMeta  == null ? '' : k.pctMeta  >= 100 ? 'kpi-pos' : k.pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
      const projCls = k.projecao == null ? '' : k.projecao >= k.wMeta ? 'kpi-pos' : 'kpi-neg';

      const paEarned2 = k.hitMeta && k.hitPA;
      const premioHtml = k.isComplete
        ? `<span class="wk-p ${k.pVendas>0?'wk-p-ok':'wk-p-no'}" title="Meta de vendas">${fBRL(PREMIO_VENDAS)} ${k.hitMeta?'✓':'✗'}</span>
           <span class="wk-p ${paEarned2?'wk-p-ok':'wk-p-no'}" title="${k.hitPA&&!k.hitMeta?'PA atingido mas meta venda não':'PA > '+PA_THRESHOLD}">+${fBRL(PREMIO_PA)} ${paEarned2?'✓':'✗'}</span>`
        : k.isFuture ? '<span class="wk-p-pending">—</span>'
        : `<span class="wk-p ${k.hitMeta?'wk-p-ok':'wk-p-pend'}" title="Meta">${fBRL(PREMIO_VENDAS)}${k.hitMeta?' ✓':''}</span>
           <span class="wk-p ${paEarned2?'wk-p-ok':k.hitPA&&!k.hitMeta?'wk-p-no':'wk-p-pend'}" title="${k.hitPA&&!k.hitMeta?'PA atingido mas meta venda não':'PA > '+PA_THRESHOLD}">+${fBRL(PREMIO_PA)}${paEarned2?' ✓':k.hitPA&&!k.hitMeta?' ✗':''}</span>`;

      const metaCell = isAdmin
        ? `<td class="wk-td wk-td-edit" data-empid="${emp.id}" data-week="${week.startStr}">${fBRL(k.wMeta||null)}</td>`
        : `<td class="wk-td wk-td-num">${fBRL(k.wMeta||null)}</td>`;

      return `<tr class="wk-row">
        <td class="wk-td wk-td-name">${emp.apelido || emp.name}</td>
        ${metaCell}
        <td class="wk-td wk-td-num">${fBRL(k.valor||null)}</td>
        <td class="wk-td wk-td-num ${pctCls}">${fPct(k.pctMeta)}</td>
        <td class="wk-td wk-td-num ${projCls}">${fBRL(k.projecao)}</td>
        <td class="wk-td wk-td-num${k.pa != null ? (k.pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${fDec(k.pa)}</td>
        <td class="wk-td wk-premio">${premioHtml}</td>
      </tr>`;
    }).join('');

    const totPa  = (totPecas>0&&totAtend>0) ? totPecas/totAtend : null;
    const totPct = (totMeta>0&&totValor>0) ? totValor/totMeta*100 : null;
    const tpCls  = totPct == null ? '' : totPct>=100?'kpi-pos':totPct>=80?'kpi-warn':'kpi-neg';
    const tprojCls2 = !hasProj2 ? '' : totProjecao2 >= totMeta ? 'kpi-pos' : 'kpi-neg';

    if (isCurrent && totMeta > 0 && totValor >= totMeta) {
      const storeKey = `wk-store-${bk}-${week.startStr}`;
      if (!META_ACHIEVED.has(storeKey)) {
        META_ACHIEVED.add(storeKey);
        pendingCelebrations.push({ label: bc.label, color: bc.color });
      }
    }

    section.innerHTML = `
      <div class="wk-store-hdr">
        <span class="wk-store-dot" style="background:${bc.color}"></span>${bc.label}
      </div>
      <table class="wk-table">
        <thead><tr class="wk-thead-tr">
          <th class="wk-th">Vendedor</th>
          <th class="wk-th wk-th-r">Meta Semana ${isAdmin?'<span class="wk-edit-hint">(clique p/ editar)</span>':''}</th>
          <th class="wk-th wk-th-r">Realizado</th>
          <th class="wk-th wk-th-r">% Meta</th>
          <th class="wk-th wk-th-r">Projeção</th>
          <th class="wk-th wk-th-r">PA</th>
          <th class="wk-th wk-th-r">Prêmio</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="wk-total-row">
          <td class="wk-td">Total</td>
          <td class="wk-td wk-td-num">${fBRL(totMeta||null)}</td>
          <td class="wk-td wk-td-num">${fBRL(totValor||null)}</td>
          <td class="wk-td wk-td-num ${tpCls}">${fPct(totPct)}</td>
          <td class="wk-td wk-td-num ${tprojCls2}">${hasProj2 ? fBRL(totProjecao2) : '—'}</td>
          <td class="wk-td wk-td-num${totPa!=null?(totPa>=1.8?' pa-ok':' pa-low'):''}">${totPa!=null?totPa.toFixed(2):'—'}</td>
          <td class="wk-td wk-td-num">R$ ${totPremio.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        </tr></tfoot>
      </table>`;
    body.appendChild(section);

    if (isAdmin) {
      section.querySelectorAll('.wk-td-edit').forEach(td => {
        td.addEventListener('click', () => startWeekMetaEdit(td));
      });
    }
  }

  pendingCelebrations.forEach((cel, i) => {
    setTimeout(() => triggerMetaCelebration(cel.label, cel.color), 350 + i * 1800);
  });
}

function startWeekMetaEdit(td) {
  if (td.querySelector('input')) return;
  const empId    = td.dataset.empid;
  const weekStart= td.dataset.week;
  const cur = S.weeklyMetas[weekStart]?.[empId]?.meta || 0;

  const inp = document.createElement('input');
  inp.type  = 'number'; inp.className = 'wk-meta-input';
  inp.value = cur || ''; inp.placeholder = '0,00';
  td.innerHTML = ''; td.appendChild(inp);
  inp.focus(); inp.select();

  const save = async () => {
    const val = parseFloat(inp.value) || 0;
    try {
      await apiFetch('PUT', `/api/weekly-metas/${S.year}/${S.month}/${weekStart}/${empId}`, { meta: val });
      if (!S.weeklyMetas[weekStart]) S.weeklyMetas[weekStart] = {};
      if (!S.weeklyMetas[weekStart][empId]) S.weeklyMetas[weekStart][empId] = {};
      S.weeklyMetas[weekStart][empId].meta = val;
      renderWeeklyModal();
    } catch(e) { toast('Erro: '+e.message, true); renderWeeklyModal(); }
  };
  inp.addEventListener('blur',  save);
  inp.addEventListener('keydown', e => {
    if (e.key==='Enter') { e.preventDefault(); inp.blur(); }
    if (e.key==='Escape') renderWeeklyModal();
  });
}

function initWeeklyModal() {
  document.getElementById('weeklyBtn').addEventListener('click', openWeeklyModal);
  document.getElementById('weeklyClose').addEventListener('click', closeWeeklyModal);
  document.getElementById('weeklyOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('weeklyOverlay')) closeWeeklyModal();
  });
}

// ── Funcionários Modal ─────────────────────────────────────────────────────
let FE = { employees: [], editingId: null, newPhotoFile: null, currentPhotoUrl: null };

function openFuncionariosModal() {
  document.getElementById('funcOverlay').classList.remove('hidden');
  loadFuncionarios();
}
function closeFuncionariosModal() {
  document.getElementById('funcOverlay').classList.add('hidden');
  hideFuncForm();
}

async function loadFuncionarios() {
  try {
    FE.employees = await apiFetch('GET', '/api/employees');
    renderFuncionariosTable();
  } catch(e) { toast('Erro: ' + e.message, true); }
}

function empAvatarHtml(emp, size) {
  size = size || 36;
  if (emp.foto) {
    return `<img src="${emp.foto}" class="func-avatar-img" style="width:${size}px;height:${size}px;" alt="">`;
  }
  const initials = emp.name.split(' ').filter(Boolean).map(w => w[0]).slice(0,2).join('').toUpperCase();
  const color = BOARDS[emp.board]?.color || '#64748b';
  return `<span class="func-avatar-ini" style="width:${size}px;height:${size}px;background:${color}22;color:${color};font-size:${Math.round(size*0.36)}px;">${initials}</span>`;
}

function renderFuncionariosTable() {
  const filter      = document.getElementById('funcBoardFilter').value;
  const showInativo = document.getElementById('funcShowInativo')?.checked;
  const search      = (document.getElementById('funcSearch')?.value || '').toLowerCase().trim();
  const list = FE.employees
    .filter(e => !filter || e.board === filter)
    .filter(e => showInativo || !e.inativo)
    .filter(e => !search || e.name.toLowerCase().includes(search) || (e.apelido||'').toLowerCase().includes(search));

  const tbody = document.getElementById('funcTableBody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--muted)">Nenhum funcionário encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(e => {
    const board   = BOARDS[e.board];
    const lojaColor = board?.color || '#8B949E';
    const lojaLabel = board?.label || e.board;
    const inativo   = !!e.inativo;
    const comissao  = e.comissao ? `${e.comissao}%` : e.comissaoSemMeta ? `${e.comissaoSemMeta}%` : '—';
    const statusBadge = inativo
      ? `<span class="func-badge func-badge-inativo">Inativo</span>${e.desligamento ? `<div class="func-desl-date">${e.desligamento.split('-').reverse().join('/')}</div>` : ''}`
      : `<span class="func-badge func-badge-ativo">Ativo</span>`;
    const nameHtml = e.apelido
      ? `<div class="func-name-main">${e.apelido}</div><div class="func-name-sub">${e.name}</div>`
      : `<div class="func-name-main">${e.name}</div>`;
    return `<tr class="${inativo ? 'func-row-inativo' : ''}">
      <td class="func-td-avatar">${empAvatarHtml(e, 36)}</td>
      <td class="func-td-name">${nameHtml}</td>
      <td><span class="func-loja-badge" style="border-color:${lojaColor};color:${lojaColor}">${lojaLabel}</span></td>
      <td class="func-td-muted">${e.cargo || '—'}</td>
      <td class="func-td-muted">${e.admissao ? e.admissao.split('-').reverse().join('/') : '—'}</td>
      <td class="func-td-muted">${comissao}</td>
      <td>${statusBadge}</td>
      <td class="func-actions">
        <button class="func-edit-btn" data-id="${e.id}" title="Editar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Editar
        </button>
        <button class="func-del-btn" data-id="${e.id}" title="Excluir">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.func-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openFuncForm(parseInt(btn.dataset.id))));
  tbody.querySelectorAll('.func-del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteFuncionario(parseInt(btn.dataset.id))));
}

function openFuncForm(id) {
  FE.editingId = id || null;
  FE.newPhotoFile = null;
  const emp = id ? FE.employees.find(e => e.id === id) : null;
  document.getElementById('funcBody').classList.add('func-body--open');
  document.getElementById('funcFormTitle').textContent = emp ? (emp.apelido || emp.name) : 'Novo Funcionário';
  const sub = document.getElementById('funcFormSubtitle');
  if (emp) {
    const b = BOARDS[emp.board];
    sub.innerHTML = `<span class="func-loja-badge" style="color:${b?.color || '#888'};border-color:${b?.color || '#888'}40">${b?.label || emp.board}</span>${emp.cargo ? ' · ' + emp.cargo : ''}`;
  } else {
    sub.textContent = '';
  }

  const boardSel = document.getElementById('funcBoard');
  boardSel.innerHTML = Object.entries(BOARDS)
    .filter(([k]) => k !== 'escritorio')
    .map(([k,v]) => `<option value="${k}" ${emp?.board === k ? 'selected' : ''}>${v.label}</option>`).join('');
  if (S.user?.board) { boardSel.value = S.user.board; boardSel.disabled = true; }

  document.getElementById('funcNome').value      = emp?.name      || '';
  document.getElementById('funcApelido').value   = emp?.apelido   || '';
  document.getElementById('funcCPF').value         = emp?.cpf         || '';
  document.getElementById('funcMicrovixCod').value = emp?.microvixCod || '';
  document.getElementById('funcAdmissao').value  = emp?.admissao  || '';
  document.getElementById('funcCargo').value     = emp?.cargo     || '';
  document.getElementById('funcSalario').value   = emp?.salario   || '';
  document.getElementById('funcComissaoSemMeta').value = emp?.comissaoSemMeta || '';
  document.getElementById('funcComissao').value        = emp?.comissao        || '';
  document.getElementById('funcComissaoMeta2').value   = emp?.comissaoMeta2   || '';
  document.getElementById('funcComissaoSuper').value   = emp?.comissaoSuper   || '';
  document.getElementById('funcIsVend').checked  = emp ? emp.isVendedor !== false : true;
  document.getElementById('funcInativo').checked = !!emp?.inativo;
  document.getElementById('funcDesligamento').value = emp?.desligamento || '';
  document.getElementById('funcDesligamentoWrap').style.display = emp?.inativo ? '' : 'none';

  // Photo preview
  FE.currentPhotoUrl = emp?.foto || null;
  _updateFotoPreview(emp);

  document.getElementById('funcNome').focus();
}

function _updateFotoPreview(emp) {
  const img      = document.getElementById('funcFotoImg');
  const initials = document.getElementById('funcFotoInitials');
  const removeBtn= document.getElementById('funcFotoRemove');
  const preview  = document.getElementById('funcFotoPreview');

  if (FE.newPhotoFile) {
    const url = URL.createObjectURL(FE.newPhotoFile);
    img.src = url; img.style.display = ''; initials.style.display = 'none';
    removeBtn.style.display = '';
  } else if (FE.currentPhotoUrl) {
    img.src = FE.currentPhotoUrl; img.style.display = ''; initials.style.display = 'none';
    removeBtn.style.display = '';
  } else {
    img.src = ''; img.style.display = 'none';
    const name = document.getElementById('funcNome').value || (emp?.name) || '?';
    const ini  = name.split(' ').filter(Boolean).map(w => w[0]).slice(0,2).join('').toUpperCase() || '?';
    const boardVal = document.getElementById('funcBoard')?.value;
    const color = BOARDS[boardVal]?.color || '#64748b';
    initials.textContent = ini;
    initials.style.color = color;
    initials.style.display = '';
    removeBtn.style.display = 'none';
  }
}

function hideFuncForm() {
  document.getElementById('funcBody').classList.remove('func-body--open');
  document.getElementById('funcFotoInput').value = '';
  FE.editingId = null;
  FE.newPhotoFile = null;
  FE.currentPhotoUrl = null;
}

async function saveFuncionario() {
  const name      = document.getElementById('funcNome').value.trim();
  const board     = document.getElementById('funcBoard').value;
  const apelido   = document.getElementById('funcApelido').value.trim();
  const cpf          = document.getElementById('funcCPF').value.trim();
  const microvixCod  = document.getElementById('funcMicrovixCod').value.trim();
  const admissao  = document.getElementById('funcAdmissao').value;
  const cargo     = document.getElementById('funcCargo').value.trim();
  const salario   = parseFloat(document.getElementById('funcSalario').value) || 0;
  const comissaoSemMeta = parseFloat(document.getElementById('funcComissaoSemMeta').value) || 0;
  const comissao       = parseFloat(document.getElementById('funcComissao').value)       || 0;
  const comissaoMeta2  = parseFloat(document.getElementById('funcComissaoMeta2').value)  || 0;
  const comissaoSuper  = parseFloat(document.getElementById('funcComissaoSuper').value)  || 0;
  const isVendedor= document.getElementById('funcIsVend').checked;
  const inativo   = document.getElementById('funcInativo').checked;
  const desligamento = document.getElementById('funcDesligamento').value;
  const fotoRemoved  = !FE.newPhotoFile && !FE.currentPhotoUrl && !!FE.editingId;

  if (!name || !board) { toast('Nome e loja são obrigatórios', true); return; }

  const btn = document.getElementById('funcSaveBtn');
  btn.disabled = true;
  try {
    const body = { name, apelido, board, cpf, microvixCod, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento };
    if (fotoRemoved) body.foto = '';
    let emp;
    if (FE.editingId) {
      emp = await apiFetch('PUT', `/api/employees/${FE.editingId}`, body);
      const idx = FE.employees.findIndex(e => e.id === FE.editingId);
      if (idx !== -1) FE.employees[idx] = emp;
    } else {
      emp = await apiFetch('POST', '/api/employees', body);
      FE.employees.push(emp);
    }
    // Upload new photo if selected
    if (FE.newPhotoFile) {
      const fd = new FormData();
      fd.append('photo', FE.newPhotoFile);
      const r = await fetch(`/api/employees/${emp.id}/photo`, { method: 'POST', body: fd });
      const pd = await r.json();
      emp.foto = pd.url;
      const idx = FE.employees.findIndex(e => e.id === emp.id);
      if (idx !== -1) FE.employees[idx].foto = pd.url;
    }
    renderFuncionariosTable();
    hideFuncForm();
    toast(`"${name}" salvo ✓`);
    loadData();
  } catch(e) { toast('Erro: ' + e.message, true); }
  finally { btn.disabled = false; }
}

async function deleteFuncionario(id) {
  const emp = FE.employees.find(e => e.id === id);
  if (!emp) return;
  if (!confirm(`Excluir "${emp.name}"? Isso remove também todos os dados de venda.`)) return;
  try {
    await apiFetch('DELETE', `/api/employees/${id}`);
    FE.employees = FE.employees.filter(e => e.id !== id);
    renderFuncionariosTable();
    toast('Funcionário excluído');
    loadData();
  } catch(e) { toast('Erro: ' + e.message, true); }
}

function initFuncionariosModal() {
  const isAdmin = () => !S.user?.board || S.user.board === 'escritorio';

  document.getElementById('funcBtn').addEventListener('click', () => {
    if (!isAdmin()) return;
    openFuncionariosModal();
  });
  document.getElementById('funcClose').addEventListener('click', closeFuncionariosModal);
  document.getElementById('funcOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('funcOverlay')) closeFuncionariosModal();
  });
  document.getElementById('funcBoardFilter').innerHTML =
    '<option value="">Todas as lojas</option>' +
    Object.entries(BOARDS).filter(([k]) => k !== 'escritorio')
      .map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  document.getElementById('funcBoardFilter').addEventListener('change', renderFuncionariosTable);
  document.getElementById('funcShowInativo').addEventListener('change', renderFuncionariosTable);
  document.getElementById('funcSearch').addEventListener('input', renderFuncionariosTable);
  document.getElementById('funcNewBtn').addEventListener('click', () => openFuncForm(null));
  document.getElementById('funcCancelBtn').addEventListener('click', hideFuncForm);
  document.getElementById('funcCancelBtn2').addEventListener('click', hideFuncForm);
  document.getElementById('funcSaveBtn').addEventListener('click', saveFuncionario);
  document.getElementById('funcNome').addEventListener('input', () => {
    if (!FE.editingId) {
      const val = document.getElementById('funcNome').value.trim();
      document.getElementById('funcFormTitle').textContent = val || 'Novo Funcionário';
    }
    _updateFotoPreview(null);
  });
  document.getElementById('funcFotoBtn').addEventListener('click', () => document.getElementById('funcFotoInput').click());
  document.getElementById('funcFotoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    FE.newPhotoFile = file;
    _updateFotoPreview(null);
  });
  document.getElementById('funcFotoRemove').addEventListener('click', () => {
    FE.newPhotoFile = null;
    FE.currentPhotoUrl = null;
    document.getElementById('funcFotoInput').value = '';
    _updateFotoPreview(null);
  });
  document.getElementById('funcInativo').addEventListener('change', e => {
    document.getElementById('funcDesligamentoWrap').style.display = e.target.checked ? '' : 'none';
    _updateFotoPreview(null);
  });

  // Show "Fotos Microvix" button only for admins
  if (isAdmin()) {
    const mxBtn = document.getElementById('funcMxPhotosBtn');
    mxBtn.classList.remove('hidden');
    mxBtn.addEventListener('click', async () => {
      mxBtn.disabled = true;
      const orig = mxBtn.innerHTML;
      mxBtn.innerHTML = '<span style="opacity:.6">Buscando…</span>';
      try {
        const r = await apiFetch('POST', '/api/microvix/sync-photos', {});
        if (r.fields) console.log('[Microvix/fotos] campos disponíveis:', r.fields.join(', '));
        const msg = r.updated
          ? `${r.updated} foto${r.updated > 1 ? 's' : ''} atualizada${r.updated > 1 ? 's' : ''} ✓`
          : `Nenhuma foto nova${r.skipped ? ` (${r.skipped} sem URL)` : ''}`;
        toast(msg, r.updated === 0);
        if (r.errors?.length) console.warn('[Microvix/fotos] Erros:', r.errors);
        if (r.updated) { await loadFuncionarios(); }
      } catch (e) {
        toast('Erro ao buscar fotos: ' + e.message, true);
      } finally {
        mxBtn.innerHTML = orig;
        mxBtn.disabled = false;
      }
    });

    const impBtn = document.getElementById('funcMxImportBtn');
    impBtn.classList.remove('hidden');
    impBtn.addEventListener('click', async () => {
      const boardSel = document.getElementById('funcBoardFilter');
      const board = boardSel?.value || '';
      const label = board || 'todas as lojas';
      if (!confirm(`Importar vendedores ativos do Microvix para ${label}?`)) return;
      impBtn.disabled = true;
      const orig = impBtn.innerHTML;
      impBtn.innerHTML = '<span style="opacity:.6">Importando…</span>';
      try {
        const r = await apiFetch('POST', '/api/microvix/import-vendedores', { board: board || undefined });
        const parts = [];
        if (r.created) parts.push(`${r.created} criado${r.created > 1 ? 's' : ''}`);
        if (r.updated) parts.push(`${r.updated} atualizado${r.updated > 1 ? 's' : ''}`);
        if (r.skipped) parts.push(`${r.skipped} já existente${r.skipped > 1 ? 's' : ''}`);
        const msg = parts.length ? parts.join(', ') + ' ✓' : 'Nenhum vendedor novo encontrado';
        toast(msg, !r.created && !r.updated);
        if (r.errors?.length) console.warn('[Microvix/import] Erros:', r.errors);
        if (r.created || r.updated) await loadFuncionarios();
      } catch (e) {
        toast('Erro ao importar: ' + e.message, true);
      } finally {
        impBtn.innerHTML = orig;
        impBtn.disabled = false;
      }
    });
  }
}

// ── Campanhas ─────────────────────────────────────────────────────────────
const KPI_LABELS = {
  vendas:       'Vendas (R$)',
  pa:           'PA (peças/ticket)',
  atendimentos: 'Atendimentos',
  pecas:        'Peças',
};

function formatKpiValue(kpi, val) {
  if (val === null || val === undefined) return '—';
  if (kpi === 'vendas') return 'R$ ' + val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (kpi === 'pa')     return val.toFixed(2);
  return Math.round(val).toLocaleString('pt-BR');
}

function _campMonthsInRange(startDate, endDate) {
  const months = [];
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate   + 'T00:00:00');
  let cur = new Date(s.getFullYear(), s.getMonth(), 1);
  while (cur <= e) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth() + 1 });
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

async function calcCampaignRanking(campaign) {
  const emps = S.employees.filter(e =>
    e.isVendedor !== false &&
    (campaign.scope === 'rede' || campaign.stores.includes(e.board))
  );
  const months = _campMonthsInRange(campaign.startDate, campaign.endDate);

  const empVsales = {};
  await Promise.all(emps.map(async emp => {
    empVsales[emp.id] = {};
    await Promise.all(months.map(async ({ year, month }) => {
      const data = await apiFetch('GET', `/api/vsales/${year}/${month}/${emp.board}/${emp.id}`)
        .catch(() => ({ entries: {} }));
      Object.assign(empVsales[emp.id], data.entries || {});
    }));
  }));

  return emps.map(emp => {
    const entries = empVsales[emp.id] || {};
    let totalVendas = 0, totalPecas = 0, totalAtend = 0;
    for (const [date, entry] of Object.entries(entries)) {
      if (date >= campaign.startDate && date <= campaign.endDate) {
        totalVendas += entry.value || 0;
        totalPecas  += entry.pecas || 0;
        totalAtend  += entry.atendimentos || 0;
      }
    }
    let kpiValue = 0;
    switch (campaign.kpi) {
      case 'vendas':       kpiValue = totalVendas; break;
      case 'pecas':        kpiValue = totalPecas; break;
      case 'atendimentos': kpiValue = totalAtend; break;
      case 'pa': kpiValue = totalAtend > 0 ? totalPecas / totalAtend : 0; break;
    }
    return { emp, kpiValue };
  }).sort((a, b) => b.kpiValue - a.kpiValue);
}

function renderCampanhasPanel() {
  const isAdmin = !S.user?.board || S.user.board === 'escritorio';
  const body = document.getElementById('campanhasBody');
  const today = new Date().toISOString().slice(0, 10);
  const fmt = d => d.split('-').reverse().join('/');

  const visible = isAdmin
    ? (S.campaigns || [])
    : (S.campaigns || []).filter(c => c.scope === 'rede' || c.stores.includes(S.user.board));

  const listHtml = visible.map(c => {
    const isActive = c.startDate <= today && c.endDate >= today;
    const isPast   = c.endDate < today;
    const statusCls   = isPast ? 'camp-status-past' : isActive ? 'camp-status-active' : 'camp-status-future';
    const statusLabel = isPast ? 'Encerrada' : isActive ? 'Em andamento' : 'Futura';
    const scopeLabel  = c.scope === 'rede' ? 'Toda a Rede' : c.stores.map(s => BOARDS[s]?.label || s).join(', ');
    const scopeBadge  = c.scope === 'rede'
      ? '<span class="camp-scope-badge camp-scope-rede">Rede</span>'
      : '<span class="camp-scope-badge camp-scope-loja">Loja</span>';
    return `
      <div class="camp-card">
        <div class="camp-card-main">
          <div class="camp-card-title">${c.name} ${scopeBadge}</div>
          <div class="camp-card-meta">
            <span class="${statusCls}">${statusLabel}</span>
            <span class="camp-meta-pill">${KPI_LABELS[c.kpi] || c.kpi}</span>
            <span class="camp-meta-pill">${fmt(c.startDate)} → ${fmt(c.endDate)}</span>
            <span class="camp-meta-pill">${scopeLabel}</span>
          </div>
        </div>
        <div class="camp-card-actions">
          <button class="camp-view-btn" data-id="${c.id}">Ver Ranking</button>
          ${isAdmin ? `<button class="camp-edit-btn" data-id="${c.id}">Editar</button><button class="camp-del-btn" data-id="${c.id}">Excluir</button>` : ''}
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="camp-toolbar">
      ${isAdmin ? '<button class="add-item-btn camp-new-btn" id="campNewBtn">+ Nova Campanha</button>' : ''}
    </div>
    <div class="camp-list">${listHtml || '<div class="camp-empty">Nenhuma campanha cadastrada.</div>'}</div>
  `;

  if (isAdmin) {
    document.getElementById('campNewBtn').addEventListener('click', () => renderCampaignForm(null));
    body.querySelectorAll('.camp-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = (S.campaigns || []).find(x => x.id === parseInt(btn.dataset.id));
        if (c) renderCampaignForm(c);
      });
    });
    body.querySelectorAll('.camp-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const c = (S.campaigns || []).find(x => x.id === parseInt(btn.dataset.id));
        if (!c || !confirm(`Excluir campanha "${c.name}"?`)) return;
        try {
          await apiFetch('DELETE', `/api/campaigns/${c.id}`);
          S.campaigns = S.campaigns.filter(x => x.id !== c.id);
          renderCampanhasPanel();
          toast('Campanha excluída');
        } catch (e) { toast('Erro: ' + e.message, true); }
      });
    });
  }

  body.querySelectorAll('.camp-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = (S.campaigns || []).find(x => x.id === parseInt(btn.dataset.id));
      if (c) renderCampaignRanking(c);
    });
  });
}

async function renderCampaignRanking(campaign) {
  const body = document.getElementById('campanhasBody');
  const today = new Date().toISOString().slice(0, 10);
  const fmt = d => d.split('-').reverse().join('/');
  const isActive = campaign.startDate <= today && campaign.endDate >= today;
  const isPast   = campaign.endDate < today;
  const statusCls   = isPast ? 'camp-status-past' : isActive ? 'camp-status-active' : 'camp-status-future';
  const statusLabel = isPast ? 'Encerrada' : isActive ? 'Em andamento' : 'Futura';
  const storeLabels = campaign.scope === 'rede'
    ? 'Toda a Rede'
    : campaign.stores.map(s => BOARDS[s]?.label || s).join(', ');
  const scopeBadge = campaign.scope === 'rede'
    ? '<span class="camp-scope-badge camp-scope-rede">Rede</span>'
    : '<span class="camp-scope-badge camp-scope-loja">Loja</span>';

  body.innerHTML = `
    <div class="camp-rank-hdr">
      <button class="camp-back-btn" id="campBackBtn">← Voltar</button>
      <div class="camp-rank-title">${campaign.name} ${scopeBadge}</div>
      <div class="camp-rank-meta">
        <span class="camp-meta-pill">${KPI_LABELS[campaign.kpi] || campaign.kpi}</span>
        <span class="camp-meta-pill">${fmt(campaign.startDate)} → ${fmt(campaign.endDate)}</span>
        <span class="camp-meta-pill">${storeLabels}</span>
        <span class="${statusCls}">${statusLabel}</span>
      </div>
    </div>
    <div class="camp-rank-list"><div class="camp-empty">Calculando ranking…</div></div>
  `;
  document.getElementById('campBackBtn').addEventListener('click', renderCampanhasPanel);

  const ranking = await calcCampaignRanking(campaign);
  const maxVal = ranking.length ? Math.max(...ranking.map(r => r.kpiValue), 0.001) : 0.001;
  const medals = ['🥇','🥈','🥉'];

  const rowsHtml = ranking.map((r, i) => {
    const pct   = maxVal > 0 ? (r.kpiValue / maxVal * 100) : 0;
    const medal = i < 3 ? medals[i] : `#${i + 1}`;
    const color = BOARDS[r.emp.board]?.color || '#8B949E';
    const store = BOARDS[r.emp.board]?.label || r.emp.board;
    const name  = r.emp.apelido || r.emp.name.split(' ')[0];
    return `
      <div class="camp-rank-row">
        <div class="camp-rank-pos">${medal}</div>
        <div class="camp-rank-info">
          <div class="camp-rank-name">${name}</div>
          <div class="camp-rank-store" style="color:${color}">${store}</div>
        </div>
        <div class="camp-rank-bar-wrap">
          <div class="camp-rank-bar" style="width:${pct.toFixed(1)}%;background:${color}"></div>
        </div>
        <div class="camp-rank-val">${formatKpiValue(campaign.kpi, r.kpiValue)}</div>
      </div>`;
  }).join('');

  body.querySelector('.camp-rank-list').innerHTML =
    rowsHtml || '<div class="camp-empty">Sem dados no período.</div>';
}

function renderCampaignForm(campaign) {
  const isEdit    = !!campaign;
  const body      = document.getElementById('campanhasBody');
  const today     = new Date().toISOString().slice(0, 10);
  const curScope  = campaign?.scope || 'loja';
  const ALL_STORE_KEYS = Object.keys(BOARDS).filter(k => k !== 'escritorio');

  const storeOpts = ALL_STORE_KEYS.map(k => {
    const v       = BOARDS[k];
    const checked = campaign?.stores?.includes(k) ? 'checked' : '';
    return `<label class="camp-store-check"><input type="checkbox" value="${k}" ${checked}><span style="color:${v.color}">${v.label}</span></label>`;
  }).join('');

  body.innerHTML = `
    <div class="camp-form">
      <button class="camp-back-btn" id="campFormBackBtn">← Voltar</button>
      <div class="camp-form-title">${isEdit ? 'Editar Campanha' : 'Nova Campanha'}</div>
      <div class="camp-form-grid">
        <div class="camp-form-field camp-field-wide">
          <label>Nome da Campanha</label>
          <input type="text" id="campName" class="camp-input" placeholder="Ex: Maior PA - Junho" value="${campaign?.name || ''}">
        </div>
        <div class="camp-form-field">
          <label>KPI</label>
          <select id="campKpi" class="camp-select">
            ${Object.entries(KPI_LABELS).map(([k, v]) =>
              `<option value="${k}" ${campaign?.kpi === k ? 'selected' : ''}>${v}</option>`
            ).join('')}
          </select>
        </div>
        <div class="camp-form-field camp-field-wide">
          <label>Abrangência</label>
          <div class="camp-scope-toggle">
            <label class="camp-scope-opt ${curScope === 'loja' ? 'active' : ''}">
              <input type="radio" name="campScope" value="loja" ${curScope === 'loja' ? 'checked' : ''}> Por Loja
            </label>
            <label class="camp-scope-opt ${curScope === 'rede' ? 'active' : ''}">
              <input type="radio" name="campScope" value="rede" ${curScope === 'rede' ? 'checked' : ''}> Por Rede
            </label>
          </div>
        </div>
        <div class="camp-form-field" style="grid-column:1/2">
          <label>Data Início</label>
          <input type="date" id="campStart" class="camp-input" value="${campaign?.startDate || today}">
        </div>
        <div class="camp-form-field">
          <label>Data Fim</label>
          <input type="date" id="campEnd" class="camp-input" value="${campaign?.endDate || today}">
        </div>
        <div class="camp-form-field camp-field-wide" id="campStoresField" ${curScope === 'rede' ? 'style="display:none"' : ''}>
          <label>Lojas participantes</label>
          <div class="camp-store-checks">${storeOpts}</div>
        </div>
      </div>
      <div class="camp-form-actions">
        <button class="folgas-cancel-btn" id="campFormCancelBtn">Cancelar</button>
        <button class="ds-meta-save-btn" id="campFormSaveBtn">${isEdit ? 'Salvar' : 'Criar Campanha'}</button>
      </div>
    </div>
  `;

  // Toggle store selector based on scope
  body.querySelectorAll('input[name="campScope"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isRede = radio.value === 'rede';
      document.getElementById('campStoresField').style.display = isRede ? 'none' : '';
      body.querySelectorAll('.camp-scope-opt').forEach(lbl => lbl.classList.remove('active'));
      radio.closest('.camp-scope-opt').classList.add('active');
    });
  });

  document.getElementById('campFormBackBtn').addEventListener('click', renderCampanhasPanel);
  document.getElementById('campFormCancelBtn').addEventListener('click', renderCampanhasPanel);
  document.getElementById('campFormSaveBtn').addEventListener('click', async () => {
    const name  = document.getElementById('campName').value.trim();
    const kpi   = document.getElementById('campKpi').value;
    const start = document.getElementById('campStart').value;
    const end   = document.getElementById('campEnd').value;
    const scope = body.querySelector('input[name="campScope"]:checked')?.value || 'loja';
    const stores = scope === 'rede'
      ? ALL_STORE_KEYS
      : [...document.querySelectorAll('.camp-store-checks input:checked')].map(x => x.value);

    if (!name)                       return toast('Informe o nome da campanha', 'warn');
    if (!start || !end)              return toast('Informe as datas', 'warn');
    if (end < start)                 return toast('Data fim deve ser após a data início', 'warn');
    if (scope === 'loja' && !stores.length) return toast('Selecione ao menos uma loja', 'warn');

    try {
      const payload = { name, kpi, startDate: start, endDate: end, stores, scope };
      if (isEdit) {
        const updated = await apiFetch('PUT', `/api/campaigns/${campaign.id}`, payload);
        const idx = (S.campaigns || []).findIndex(c => c.id === campaign.id);
        if (idx !== -1) S.campaigns[idx] = updated;
      } else {
        const created = await apiFetch('POST', '/api/campaigns', payload);
        if (!S.campaigns) S.campaigns = [];
        S.campaigns.push(created);
      }
      toast(isEdit ? 'Campanha atualizada!' : 'Campanha criada!');
      renderCampanhasPanel();
    } catch (e) { toast('Erro: ' + e.message, true); }
  });
}

function _updateCampanhasBtn() {
  const isAdmin  = !S.user?.board || S.user.board === 'escritorio';
  const board    = S.user?.board;
  const hasCamps = isAdmin || (S.campaigns || []).some(c =>
    c.scope === 'rede' || c.stores.includes(board)
  );
  document.getElementById('campanhasBtn').style.display = hasCamps ? '' : 'none';
}

function openCampanhasModal() {
  document.getElementById('campanhasOverlay').classList.remove('hidden');
  renderCampanhasPanel();
}

function closeCampanhasModal() {
  document.getElementById('campanhasOverlay').classList.add('hidden');
}

function initCampanhasModal() {
  document.getElementById('campanhasBtn').addEventListener('click', openCampanhasModal);
  document.getElementById('campanhasClose').addEventListener('click', closeCampanhasModal);
  document.getElementById('campanhasOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('campanhasOverlay')) closeCampanhasModal();
  });
}

// ── Recebimento de NF ─────────────────────────────────────────────────────
function _escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const NF_STORES = ['delrey','minas','contagem','estacao','tommy','lez'];

function _fmtNFDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Reunião Mensal ────────────────────────────────────────────────────────

function _renderMeetingActive(body, board, isAdmin, refresh) {
  const items = (S.meetingItems || []).filter(x =>
    x.board === board && x.year === S.year && x.month === S.month && !x.archived
  );
  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Nenhum item</div>';
    return;
  }
  body.innerHTML = items.map(item => {
    const isLoja = item.visibility === 'loja';
    const fromLoja = item.origin === 'loja';
    const originBadge = fromLoja
      ? `<span class="mtg-origin-loja">📌 Da loja</span>`
      : '';
    const visBtn = isAdmin && !fromLoja
      ? `<button class="mtg-vis-btn${isLoja ? ' mtg-vis-loja' : ' mtg-vis-adm'}" data-id="${item.id}" title="${isLoja ? 'Enviado para loja — clique para tornar privado' : 'Privado (só adm) — clique para enviar à loja'}">
           ${isLoja ? '👁 Loja' : '🔒 Adm'}
         </button>` : '';
    const canDelete = isAdmin || (item.origin === 'loja' && item.addedBy === (S.user?.label || S.user?.username));
    return `<div class="nf-item" data-id="${item.id}">
      <label class="nf-chk-label">
        <input type="checkbox" class="mtg-chk" data-id="${item.id}">
        <span class="nf-item-text">${_escHtml(item.text)}</span>
      </label>
      <span class="nf-item-meta" style="display:flex;align-items:center;gap:.35rem">
        ${originBadge}${visBtn}
        <span class="nf-date-tag">Criado ${_fmtNFDate(item.addedAt)}</span>
      </span>
      ${canDelete ? `<button class="nf-del-btn" data-id="${item.id}" title="Arquivar">&times;</button>` : ''}
    </div>`;
  }).join('');

  body.querySelectorAll('.mtg-chk').forEach(chk => {
    chk.addEventListener('change', async () => {
      if (!chk.checked) return;
      const id = parseInt(chk.dataset.id);
      chk.disabled = true;
      const updated = await apiFetch('PATCH', `/api/meeting-items/${id}`, { checked: true }).catch(() => null);
      const item = S.meetingItems.find(x => x.id === id);
      if (item && updated) Object.assign(item, updated);
      _renderMeetingActive(body, board, isAdmin, refresh);
      refresh();
    });
  });

  body.querySelectorAll('.mtg-vis-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const item = S.meetingItems.find(x => x.id === id);
      if (!item) return;
      const newVis = item.visibility === 'loja' ? 'admin' : 'loja';
      const updated = await apiFetch('PATCH', `/api/meeting-items/${id}`, { visibility: newVis }).catch(() => null);
      if (item && updated) Object.assign(item, updated);
      _renderMeetingActive(body, board, isAdmin, refresh);
    });
  });

  if (isAdmin) {
    body.querySelectorAll('.nf-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        const updated = await apiFetch('PATCH', `/api/meeting-items/${id}`, { archived: true }).catch(() => null);
        const item = S.meetingItems.find(x => x.id === id);
        if (item && updated) Object.assign(item, updated);
        _renderMeetingActive(body, board, isAdmin, refresh);
        refresh();
      });
    });
  }
}

function _renderMeetingHistory(body, board, isAdmin, refresh) {
  const items = (S.meetingItems || []).filter(x =>
    x.board === board && x.year === S.year && x.month === S.month && x.archived
  ).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));

  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Histórico vazio</div>';
    return;
  }

  body.innerHTML = `
    ${isAdmin ? `<div class="nf-hist-header"><button class="nf-clear-btn" id="mtgClearAll">Limpar tudo</button></div>` : ''}
    ${items.map(item => `
      <div class="nf-item nf-checked nf-hist-item" data-id="${item.id}">
        <div class="nf-hist-item-main">
          <span class="nf-item-text">${_escHtml(item.text)}</span>
          <div class="nf-hist-dates">
            <span class="nf-date-tag">Criado ${_fmtNFDate(item.addedAt)} por ${_escHtml(item.addedBy)}</span>
            <span class="nf-date-sep">·</span>
            <span class="nf-date-tag nf-date-archived">✓ Arquivado ${_fmtNFDate(item.archivedAt)} por ${_escHtml(item.archivedBy || item.addedBy)}</span>
          </div>
        </div>
        ${isAdmin ? `<button class="nf-del-btn" data-id="${item.id}" title="Excluir">&times;</button>` : ''}
      </div>
    `).join('')}
  `;

  if (isAdmin) {
    body.querySelectorAll('.nf-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        await apiFetch('DELETE', `/api/meeting-items/${id}`).catch(() => {});
        S.meetingItems = S.meetingItems.filter(x => x.id !== id);
        _renderMeetingHistory(body, board, isAdmin, refresh);
        refresh();
      });
    });

    const clearAll = body.querySelector('#mtgClearAll');
    if (clearAll) {
      clearAll.addEventListener('click', async () => {
        const toDelete = (S.meetingItems || []).filter(x =>
          x.board === board && x.year === S.year && x.month === S.month && x.archived
        );
        await Promise.all(toDelete.map(x => apiFetch('DELETE', `/api/meeting-items/${x.id}`).catch(() => {})));
        S.meetingItems = S.meetingItems.filter(x =>
          !(x.board === board && x.year === S.year && x.month === S.month && x.archived)
        );
        _renderMeetingHistory(body, board, isAdmin, refresh);
        refresh();
      });
    }
  }
}

function renderMeetingCard(container) {
  const isAdmin = !S.user?.board || S.user?.board === 'escritorio';
  const userBoard = S.user?.board;
  let activeBoard = isAdmin ? NF_STORES[0] : userBoard;
  let showHistory = false;

  const card = document.createElement('div');
  card.className = 'main-card';

  const tabsHtml = isAdmin ? `
    <div class="nf-tabs">
      ${NF_STORES.map(b => `
        <button class="nf-tab${b === activeBoard ? ' active' : ''}" data-board="${b}"
          style="--nf-tab-color:${BOARDS[b]?.color || '#8B949E'}">
          ${BOARDS[b]?.label || b}
        </button>`).join('')}
    </div>` : '';

  card.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Reunião Mensal
      </span>
      ${!isAdmin ? `<span class="main-card-sub" style="color:${BOARDS[userBoard]?.color}">${BOARDS[userBoard]?.label || ''}</span>` : ''}
      <button class="nf-hist-btn" id="mtgHistBtn" style="display:none">Histórico</button>
    </div>
    ${tabsHtml}
    <div class="main-card-body nf-card-body" id="mtgCardBody"></div>
    <div class="nf-add-row" id="mtgAddRow">
      <input type="text" class="nf-input" id="mtgInput" placeholder="${isAdmin ? 'Adicionar pauta…' : 'Enviar pendência para adm…'}" maxlength="200">
      <button class="nf-add-btn" id="mtgAddBtn">+</button>
    </div>
  `;
  container.appendChild(card);

  const body   = card.querySelector('#mtgCardBody');
  const histBtn = card.querySelector('#mtgHistBtn');
  const addRow  = card.querySelector('#mtgAddRow');
  const input   = card.querySelector('#mtgInput');
  const addBtn  = card.querySelector('#mtgAddBtn');

  function refresh() {
    const archived = (S.meetingItems || []).filter(x =>
      x.board === activeBoard && x.year === S.year && x.month === S.month && x.archived
    );
    if (archived.length > 0) {
      histBtn.style.display = '';
      histBtn.textContent = showHistory ? '← Voltar' : `Histórico (${archived.length})`;
    } else {
      histBtn.style.display = 'none';
      if (showHistory) showHistory = false;
    }
    if (showHistory) {
      _renderMeetingHistory(body, activeBoard, isAdmin, refresh);
      if (addRow) addRow.style.display = 'none';
    } else {
      _renderMeetingActive(body, activeBoard, isAdmin, refresh);
      if (addRow) addRow.style.display = '';
    }
  }

  refresh();

  histBtn.addEventListener('click', () => { showHistory = !showHistory; refresh(); });

  if (isAdmin) {
    card.querySelectorAll('.nf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeBoard = tab.dataset.board;
        showHistory = false;
        card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
        refresh();
      });
    });
  }

  async function addMeetingItem() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const item = await apiFetch('POST', '/api/meeting-items', {
        text, board: activeBoard, year: S.year, month: S.month,
        visibility: isAdmin ? 'admin' : 'loja'
      });
      S.meetingItems = [...S.meetingItems, item];
      refresh();
    } catch (e) { toast('Erro ao adicionar item', true); }
  }

  addBtn.addEventListener('click', addMeetingItem);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addMeetingItem(); });
}

function _renderNFActive(body, board, refresh) {
  const items = (S.nfItems || []).filter(x => x.board === board && !x.archived);
  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Nenhum item ativo</div>';
    return;
  }
  body.innerHTML = items.map(item => `
    <div class="nf-item" data-id="${item.id}">
      <label class="nf-chk-label">
        <input type="checkbox" class="nf-chk" data-id="${item.id}">
        <span class="nf-item-text">${_escHtml(item.text)}</span>
      </label>
      <span class="nf-item-meta">${_escHtml(item.addedBy)} · <span class="nf-date-tag">Criado ${_fmtNFDate(item.addedAt)}</span></span>
      <button class="nf-del-btn" data-id="${item.id}" title="Arquivar">&times;</button>
    </div>
  `).join('');

  body.querySelectorAll('.nf-chk').forEach(chk => {
    chk.addEventListener('change', async () => {
      if (!chk.checked) return;
      const id = parseInt(chk.dataset.id);
      chk.disabled = true;
      const updated = await apiFetch('PATCH', `/api/nf-items/${id}`, { checked: true }).catch(() => null);
      const item = S.nfItems.find(x => x.id === id);
      if (item && updated) Object.assign(item, updated);
      _renderNFActive(body, board, refresh);
      refresh();
    });
  });

  body.querySelectorAll('.nf-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const updated = await apiFetch('PATCH', `/api/nf-items/${id}`, { archived: true }).catch(() => null);
      const item = S.nfItems.find(x => x.id === id);
      if (item && updated) Object.assign(item, updated);
      _renderNFActive(body, board, refresh);
      refresh();
    });
  });
}

function _renderNFHistory(body, board, refresh) {
  const isAdmin = !S.user?.board || S.user?.board === 'escritorio';
  const items = (S.nfItems || []).filter(x => x.board === board && x.archived)
    .sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));

  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Histórico vazio</div>';
    return;
  }

  body.innerHTML = `
    ${isAdmin ? `<div class="nf-hist-header"><button class="nf-clear-btn" id="nfClearAll">Limpar tudo</button></div>` : ''}
    ${items.map(item => `
      <div class="nf-item nf-checked nf-hist-item" data-id="${item.id}">
        <div class="nf-hist-item-main">
          <span class="nf-item-text">${_escHtml(item.text)}</span>
          <div class="nf-hist-dates">
            <span class="nf-date-tag">Criado ${_fmtNFDate(item.addedAt)} por ${_escHtml(item.addedBy)}</span>
            <span class="nf-date-sep">·</span>
            <span class="nf-date-tag nf-date-archived">✓ Arquivado ${_fmtNFDate(item.archivedAt)} por ${_escHtml(item.archivedBy || item.addedBy)}</span>
          </div>
        </div>
        ${isAdmin ? `<button class="nf-del-btn" data-id="${item.id}" title="Excluir">&times;</button>` : ''}
      </div>
    `).join('')}
  `;

  body.querySelectorAll('.nf-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      await apiFetch('DELETE', `/api/nf-items/${id}`).catch(() => {});
      S.nfItems = S.nfItems.filter(x => x.id !== id);
      _renderNFHistory(body, board, refresh);
      refresh();
    });
  });

  const clearAll = body.querySelector('#nfClearAll');
  if (clearAll) {
    clearAll.addEventListener('click', async () => {
      const toDelete = (S.nfItems || []).filter(x => x.board === board && x.archived);
      await Promise.all(toDelete.map(x => apiFetch('DELETE', `/api/nf-items/${x.id}`).catch(() => {})));
      S.nfItems = S.nfItems.filter(x => !(x.board === board && x.archived));
      _renderNFHistory(body, board, refresh);
      refresh();
    });
  }
}

// ── Fechamento de Caixa ───────────────────────────────────────────────────
function renderCaixaCard(container) {
  const isAdmin  = !S.user?.board || S.user?.board === 'escritorio';
  const userBoard = S.user?.board;
  let activeBoard = isAdmin ? NF_STORES[0] : userBoard;

  const card = document.createElement('div');
  card.className = 'main-card';

  const tabsHtml = isAdmin ? `
    <div class="nf-tabs">
      ${NF_STORES.map(b => `
        <button class="nf-tab${b === activeBoard ? ' active' : ''}" data-board="${b}"
          style="--nf-tab-color:${BOARDS[b]?.color || '#8B949E'}">
          ${BOARDS[b]?.label || b}
        </button>`).join('')}
    </div>` : '';

  card.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <line x1="12" y1="12" x2="12" y2="16"/>
          <line x1="10" y1="14" x2="14" y2="14"/>
        </svg>
        Fechamento de Caixa
      </span>
      ${!isAdmin ? `<span class="main-card-sub" style="color:${BOARDS[userBoard]?.color}">${BOARDS[userBoard]?.label || ''}</span>` : ''}
    </div>
    ${tabsHtml}
    <div class="main-card-body caixa-card-body" id="caixaCardBody"></div>
  `;
  container.appendChild(card);

  const body = card.querySelector('#caixaCardBody');

  async function refresh() {
    body.innerHTML = '<div style="padding:.75rem .85rem;color:var(--muted);font-size:.8rem">Carregando…</div>';
    let data = {};
    try {
      data = await apiFetch('GET', `/api/caixa/${S.year}/${S.month}/${activeBoard}`);
    } catch(e) { body.innerHTML = '<div style="padding:.75rem;color:var(--down);font-size:.8rem">Erro ao carregar</div>'; return; }

    const daysInMonth = new Date(S.year, S.month, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === S.year && (today.getMonth()+1) === S.month;
    const todayDay = isCurrentMonth ? today.getDate() : -1;
    const DAY_NAMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const pad = n => String(n).padStart(2,'0');
    const fmtCur = v => (v === 0 || v === undefined || v === null) ? '—' : `R$ ${Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

    let totalCaixa = 0, totalSangria = 0;
    const rows = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dt   = new Date(S.year, S.month - 1, d);
      const dow  = DAY_NAMES[dt.getDay()];
      const entry = data[d] || {};
      const caixa   = entry.caixa   ?? 0;
      const sangria = entry.sangria ?? 0;
      const saldo   = caixa - sangria;
      totalCaixa   += caixa;
      totalSangria += sangria;
      rows.push({ d, dow, caixa, sangria, saldo });
    }
    const totalSaldo = totalCaixa - totalSangria;

    const saldoClass = s => s > 0 ? 'pos' : s < 0 ? 'neg' : 'zero';

    body.innerHTML = `
      <div class="caixa-table-wrap">
        <table class="caixa-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Valor em Caixa</th>
              <th>Sangria</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody id="caixaTbody">
            ${rows.map(r => `
              <tr class="${r.d === todayDay ? 'caixa-today' : ''}" data-day="${r.d}">
                <td class="caixa-td-date">${pad(r.d)}/${pad(S.month)} <span style="color:var(--muted);font-size:.72rem">${r.dow}</span></td>
                <td class="caixa-td-val caixa-caixa-cell" data-field="caixa" data-day="${r.d}">${r.caixa > 0 ? fmtCur(r.caixa) : '<span style="color:var(--muted)">—</span>'}</td>
                <td class="caixa-td-val caixa-sangria-cell" data-field="sangria" data-day="${r.d}">${r.sangria > 0 ? fmtCur(r.sangria) : '<span style="color:var(--muted)">—</span>'}</td>
                <td class="caixa-td-saldo ${r.caixa === 0 && r.sangria === 0 ? 'zero' : saldoClass(r.saldo)}">${r.caixa === 0 && r.sangria === 0 ? '<span style="color:var(--muted)">—</span>' : fmtCur(r.saldo)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="caixa-total-row">
              <td>Total</td>
              <td>${fmtCur(totalCaixa)}</td>
              <td>${fmtCur(totalSangria)}</td>
              <td class="caixa-total-saldo ${saldoClass(totalSaldo)}">${fmtCur(totalSaldo)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;

    // scroll to today
    if (todayDay > 0) {
      const todayRow = body.querySelector(`tr[data-day="${todayDay}"]`);
      if (todayRow) setTimeout(() => todayRow.scrollIntoView({ block: 'nearest' }), 50);
    }

    // cell editing — click on caixa or sangria cell
    body.querySelectorAll('.caixa-caixa-cell, .caixa-sangria-cell').forEach(cell => {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => _caixaStartEdit(cell, data, activeBoard, refresh));
    });
  }

  async function _caixaStartEdit(cell, data, board, refreshFn) {
    if (cell.querySelector('input')) return;
    const field = cell.dataset.field;
    const day   = parseInt(cell.dataset.day);
    const cur   = (data[day] || {})[field] ?? 0;

    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'caixa-cell-input';
    inp.value = cur > 0 ? cur : '';
    inp.placeholder = '0,00';
    cell.innerHTML = ''; cell.appendChild(inp);
    inp.focus(); inp.select();

    const commit = async () => {
      const raw = inp.value.replace(',','.');
      const val = parseFloat(raw) || 0;
      try {
        await apiFetch('PUT', `/api/caixa/${S.year}/${S.month}/${board}/${day}`, { [field]: val });
      } catch(e) { toast('Erro: ' + e.message, true); }
      await refreshFn();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') refreshFn(); });
  }

  refresh();

  if (isAdmin) {
    card.querySelectorAll('.nf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeBoard = tab.dataset.board;
        card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
        refresh();
      });
    });
  }
}

function renderNFCard(container) {
  const isAdmin = !S.user?.board || S.user?.board === 'escritorio';
  const userBoard = S.user?.board;
  let activeBoard = isAdmin ? NF_STORES[0] : userBoard;
  let showHistory = false;

  const card = document.createElement('div');
  card.className = 'main-card';

  const tabsHtml = isAdmin ? `
    <div class="nf-tabs">
      ${NF_STORES.map(b => `
        <button class="nf-tab${b === activeBoard ? ' active' : ''}" data-board="${b}"
          style="--nf-tab-color:${BOARDS[b]?.color || '#8B949E'}">
          ${BOARDS[b]?.label || b}
        </button>`).join('')}
    </div>` : '';

  card.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <polyline points="9 15 11 17 15 13"/>
        </svg>
        Recebimento de NF Autorizado
      </span>
      ${!isAdmin ? `<span class="main-card-sub" style="color:${BOARDS[userBoard]?.color}">${BOARDS[userBoard]?.label || ''}</span>` : ''}
      <button class="nf-hist-btn" id="nfHistBtn" style="display:none">Histórico</button>
    </div>
    ${tabsHtml}
    <div class="main-card-body nf-card-body" id="nfCardBody"></div>
    <div class="nf-add-row" id="nfAddRow">
      <input type="text" class="nf-input" id="nfInput" placeholder="Adicionar item…" maxlength="120">
      <button class="nf-add-btn" id="nfAddBtn">+</button>
    </div>
  `;
  container.appendChild(card);

  const body    = card.querySelector('#nfCardBody');
  const addRow  = card.querySelector('#nfAddRow');
  const histBtn = card.querySelector('#nfHistBtn');
  const input   = card.querySelector('#nfInput');
  const addBtn  = card.querySelector('#nfAddBtn');

  function refresh() {
    const archived = (S.nfItems || []).filter(x => x.board === activeBoard && x.archived);
    if (archived.length > 0) {
      histBtn.style.display = '';
      histBtn.textContent = showHistory ? '← Voltar' : `Histórico (${archived.length})`;
    } else {
      histBtn.style.display = 'none';
      if (showHistory) { showHistory = false; }
    }
    if (showHistory) {
      _renderNFHistory(body, activeBoard, refresh);
      addRow.style.display = 'none';
    } else {
      _renderNFActive(body, activeBoard, refresh);
      addRow.style.display = '';
    }
  }

  refresh();

  histBtn.addEventListener('click', () => {
    showHistory = !showHistory;
    refresh();
  });

  if (isAdmin) {
    card.querySelectorAll('.nf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeBoard = tab.dataset.board;
        showHistory = false;
        card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
        refresh();
      });
    });
  }

  async function addNFItem() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const item = await apiFetch('POST', '/api/nf-items', { text, board: activeBoard });
      S.nfItems = [...S.nfItems, item];
      refresh();
    } catch (e) {
      toast('Erro ao adicionar item', true);
    }
  }

  addBtn.addEventListener('click', addNFItem);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addNFItem(); });
}

// ── Meta celebration ──────────────────────────────────────────────────────
function triggerMetaCelebration(label, color) {
  const COLORS = ['#FBBF24','#3FB950','#58A6FF','#FF7B72','#F0883E','#D2A8FF', color, '#ffffff'];

  const overlay = document.createElement('div');
  overlay.className = 'meta-cel-overlay';
  document.body.appendChild(overlay);

  for (let i = 0; i < 110; i++) {
    const p  = document.createElement('div');
    const sz = 6 + Math.random() * 11;
    const isCircle = Math.random() > 0.55;
    const dur  = 3.5 + Math.random() * 3.5;
    const del  = Math.random() * 2.5;
    const col  = COLORS[Math.floor(Math.random() * COLORS.length)];
    p.style.cssText = [
      `position:absolute`,
      `left:${Math.random() * 100}%`,
      `top:-${10 + Math.random() * 30}px`,
      `width:${sz}px`,
      `height:${isCircle ? sz : sz * (0.4 + Math.random() * 1.2)}px`,
      `background:${col}`,
      `border-radius:${isCircle ? '50%' : '2px'}`,
      `opacity:1`,
      `animation:confettiFall ${dur}s ${del}s linear forwards`,
    ].join(';');
    overlay.appendChild(p);
  }

  const banner = document.createElement('div');
  banner.className = 'meta-cel-banner';
  banner.innerHTML = `
    <div class="meta-cel-emoji">🎉🏆🎉</div>
    <div class="meta-cel-title" style="color:${color}">META ATINGIDA!</div>
    <div class="meta-cel-store">${label}</div>
    <div class="meta-cel-sub">Parabéns à toda equipe! 🥳</div>
  `;
  document.body.appendChild(banner);

  setTimeout(() => banner.classList.add('meta-cel-hide'), 6000);
  setTimeout(() => { overlay.remove(); banner.remove(); }, 7500);
}

// ── Boletas de Defeito ─────────────────────────────────────────────────────
const NF_STORES_BOL = ['delrey','minas','contagem','estacao','tommy','lez'];

function _boletaDaysLeft(b) {
  if (!b.dataEntregue) return null;
  const dead = new Date(b.dataEntregue);
  dead.setDate(dead.getDate() + 30);
  const today = new Date(); today.setHours(0,0,0,0); dead.setHours(0,0,0,0);
  return Math.ceil((dead - today) / 86400000);
}

function _boletaBadge(days) {
  if (days === null) return '';
  if (days < 0)  return `<span class="bol-badge bol-expired">VENCIDO ${Math.abs(days)}d</span>`;
  if (days === 0) return `<span class="bol-badge bol-expired">VENCE HOJE</span>`;
  if (days <= 7) return `<span class="bol-badge bol-urgent">${days}d restantes</span>`;
  if (days <= 15) return `<span class="bol-badge bol-warn">${days}d restantes</span>`;
  return `<span class="bol-badge bol-ok">${days}d restantes</span>`;
}

function renderBoletasCard(container) {
  const isAdmin   = !S.user?.board || S.user?.board === 'escritorio';
  const userBoard = S.user?.board;
  const pending   = (S.boletas || [])
    .filter(b => b.status === 'pendente' && (isAdmin || b.board === userBoard))
    .sort((a, b) => (_boletaDaysLeft(a) ?? 9999) - (_boletaDaysLeft(b) ?? 9999));

  const card = document.createElement('div');
  card.className = 'main-card'; card.id = 'boletasCard';

  const itemsHtml = pending.length === 0
    ? '<div class="nf-empty">Nenhuma boleta pendente</div>'
    : pending.map(b => {
        const days = _boletaDaysLeft(b);
        const storeTag = isAdmin ? ` <span style="color:${BOARDS[b.board]?.color || '#8B949E'}">${BOARDS[b.board]?.label || b.board}</span>` : '';
        const info = [b.produto, b.tamanho, b.cor].filter(Boolean).join(' · ');
        return `<div class="bol-item" data-id="${b.id}" style="cursor:pointer">
          <div class="bol-item-top">
            <span class="bol-num">#${String(b.numero).padStart(3,'0')}${storeTag}</span>
            ${_boletaBadge(days)}
          </div>
          <div class="bol-item-nome">${b.nome || '—'}</div>
          ${info ? `<div class="bol-item-info">${info}</div>` : ''}
          ${b.defeito ? `<div class="bol-item-defeito">${b.defeito}</div>` : ''}
        </div>`;
      }).join('');

  card.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        Defeitos
        ${pending.length > 0 ? `<span class="bol-count-badge">${pending.length}</span>` : ''}
      </span>
    </div>
    <div class="main-card-body bol-card-body">${itemsHtml}</div>
    <div class="nf-add-row">
      <input type="text" class="nf-input" id="boletasCardInput" placeholder="Adicionar defeito…" maxlength="120" readonly style="cursor:pointer">
      <button class="nf-add-btn" id="boletasNewCardBtn">+</button>
    </div>`;

  container.appendChild(card);
  card.querySelector('#boletasNewCardBtn').addEventListener('click', () => openBoletasModal('new'));
  card.querySelector('#boletasCardInput').addEventListener('click', () => openBoletasModal('new'));
  card.querySelectorAll('.bol-item').forEach(el =>
    el.addEventListener('click', () => openBoletasModal('view', parseInt(el.dataset.id))));
}

function openBoletasModal(view = 'list', boletaId = null) {
  document.getElementById('boletasOverlay').classList.remove('hidden');
  _renderBoletasModal(view, boletaId);
}

function closeBoletasModal() {
  document.getElementById('boletasOverlay').classList.add('hidden');
}

function _renderBoletasModal(view, boletaId) {
  const body     = document.getElementById('boletasBody');
  const isAdmin  = !S.user?.board || S.user?.board === 'escritorio';
  const userBoard = S.user?.board;

  if (view === 'new' || view === 'edit') {
    const boleta = boletaId ? (S.boletas||[]).find(b=>b.id===boletaId) : null;
    body.innerHTML = _boletaFormHtml(boleta, isAdmin, userBoard);
    _initBoletaForm(body, boleta, isAdmin, userBoard);
  } else if (view === 'view') {
    const boleta = (S.boletas||[]).find(b=>b.id===boletaId);
    if (!boleta) { _renderBoletasModal('list', null); return; }
    body.innerHTML = _boletaDetailHtml(boleta, isAdmin);
    _initBoletaDetail(body, boleta, isAdmin);
  } else {
    body.innerHTML = _boletasListHtml(isAdmin, userBoard);
    _initBoletasList(body, isAdmin, userBoard);
  }
}

function _boletasListHtml(isAdmin, userBoard) {
  return `<div class="bol-list-wrap">
    <div class="bol-list-header">
      <div class="bol-filter-tabs">
        <button class="bol-filter-tab active" data-filter="pendente">Pendentes</button>
        <button class="bol-filter-tab" data-filter="resolvido">Resolvidas</button>
        <button class="bol-filter-tab" data-filter="all">Todas</button>
      </div>
      <div style="display:flex;gap:.5rem;align-items:center">
        ${isAdmin ? `<select id="bolStoreFilter" class="bol-input" style="width:auto;padding:4px 8px">
          <option value="">Todas as lojas</option>
          ${NF_STORES_BOL.map(b=>`<option value="${b}">${BOARDS[b]?.label||b}</option>`).join('')}
        </select>` : ''}
        <button class="bol-btn-primary" id="bolNewBtn">+ Nova Boleta</button>
      </div>
    </div>
    <div id="bolListBody" class="bol-list-body"></div>
  </div>`;
}

function _initBoletasList(body, isAdmin, userBoard) {
  let filter = 'pendente';
  let storeFilter = isAdmin ? '' : userBoard;

  const listBody = body.querySelector('#bolListBody');

  function renderList() {
    const items = (S.boletas||[]).filter(b => {
      if (storeFilter && b.board !== storeFilter) return false;
      if (!isAdmin && b.board !== userBoard) return false;
      if (filter === 'pendente') return b.status === 'pendente';
      if (filter === 'resolvido') return b.status === 'resolvido';
      return true;
    }).sort((a, b) => {
      if (filter === 'pendente') return (_boletaDaysLeft(a)??9999) - (_boletaDaysLeft(b)??9999);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    if (!items.length) {
      listBody.innerHTML = '<div class="nf-empty" style="padding:2rem">Nenhuma boleta encontrada</div>';
      return;
    }

    listBody.innerHTML = items.map(b => {
      const days = _boletaDaysLeft(b);
      const storeTag = isAdmin ? `<span class="bol-list-store" style="color:${BOARDS[b.board]?.color||'#8B949E'}">${BOARDS[b.board]?.label||b.board}</span>` : '';
      const info = [b.produto, b.tamanho, b.cor].filter(Boolean).join(' · ');
      const resolvedInfo = b.status === 'resolvido' ? `<span class="bol-resolved-tag">✓ Resolvida${b.resolvedAt ? ' em '+new Date(b.resolvedAt).toLocaleDateString('pt-BR') : ''}</span>` : _boletaBadge(days);
      return `<div class="bol-list-item" data-id="${b.id}">
        <div class="bol-list-item-left">
          <div class="bol-list-item-top"><span class="bol-num">#${String(b.numero).padStart(3,'0')}</span>${storeTag}</div>
          <div class="bol-list-item-nome">${b.nome||'—'}</div>
          ${info ? `<div class="bol-item-info">${info}</div>` : ''}
          ${b.defeito ? `<div class="bol-item-defeito">${b.defeito}</div>` : ''}
        </div>
        <div class="bol-list-item-right">${resolvedInfo}</div>
      </div>`;
    }).join('');

    listBody.querySelectorAll('.bol-list-item').forEach(el =>
      el.addEventListener('click', () => _renderBoletasModal('view', parseInt(el.dataset.id))));
  }

  renderList();

  body.querySelectorAll('.bol-filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.bol-filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.filter;
      renderList();
    });
  });

  const storeSelect = body.querySelector('#bolStoreFilter');
  if (storeSelect) storeSelect.addEventListener('change', () => { storeFilter = storeSelect.value; renderList(); });

  body.querySelector('#bolNewBtn').addEventListener('click', () => _renderBoletasModal('new', null));
}

function _boletaDetailHtml(b, isAdmin) {
  const days = _boletaDaysLeft(b);
  const storeColor = BOARDS[b.board]?.color || '#8B949E';
  const fDate = d => d ? new Date(d+'T12:00:00').toLocaleDateString('pt-BR') : '—';
  const row = (label, val) => val ? `<div class="bol-detail-row"><span class="bol-detail-lbl">${label}</span><span class="bol-detail-val">${val}</span></div>` : '';

  return `<div class="bol-detail">
    <div class="bol-detail-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:.75rem">
          <span class="bol-num" style="font-size:1.1rem">#${String(b.numero).padStart(3,'0')}</span>
          <span style="color:${storeColor};font-weight:600">${BOARDS[b.board]?.label||b.board}</span>
          ${b.status==='resolvido' ? '<span class="bol-resolved-tag">✓ Resolvida</span>' : (days!==null?_boletaBadge(days):'')}
        </div>
        <div style="color:var(--muted);font-size:.8rem;margin-top:.25rem">Criada em ${fDate(b.createdAt?.slice(0,10))} por ${b.createdBy||'—'}</div>
      </div>
      <div style="display:flex;gap:.5rem">
        ${b.status==='pendente' ? `<button class="bol-btn-primary" id="bolResolveBtn">✓ Resolver</button>` : `<button class="bol-btn-reopen" id="bolReopenBtn">↩ Reabrir</button>`}
        ${isAdmin ? `<button class="bol-btn-edit" id="bolEditBtn">Editar</button>
        <button class="bol-btn-del" id="bolDelBtn">Excluir</button>` : ''}
        <button class="bol-btn-secondary" id="bolBackBtn">← Voltar</button>
      </div>
    </div>
    <div class="bol-detail-body">
      <div class="bol-detail-section">
        <div class="bol-detail-section-title">Cliente</div>
        ${row('Nome', b.nome)} ${row('CPF', b.cpf)} ${row('Tel', b.tel)} ${row('Email', b.email)}
        ${row('Endereço', [b.endereco, b.numeroEnd, b.compl].filter(Boolean).join(', '))}
        ${row('Bairro', b.bairro)} ${row('CEP', b.cep)} ${row('Cidade', b.cidade)}
      </div>
      <div class="bol-detail-section">
        <div class="bol-detail-section-title">Produto</div>
        ${row('Produto', b.produto)} ${row('Tamanho', b.tamanho)} ${row('Cor', b.cor)}
        ${row('Ref', b.ref)} ${row('Código', b.codigo)} ${row('Fabricante', b.fabricante)}
        ${row('Doc', b.doc)} ${row('Data da Compra', fDate(b.dataCompra))}
      </div>
      <div class="bol-detail-section">
        <div class="bol-detail-section-title">Defeito & Prazo</div>
        ${row('Defeito', b.defeito)}
        ${row('Data Entregue', fDate(b.dataEntregue))}
        ${row('Prazo', b.dataEntregue ? `30 dias → vence em ${fDate(new Date(new Date(b.dataEntregue).setDate(new Date(b.dataEntregue).getDate()+30)).toISOString().slice(0,10))}` : null)}
        ${b.status==='resolvido' ? row('Resolvida em', fDate(b.resolvedAt?.slice(0,10))+' por '+(b.resolvedBy||'—')) : ''}
      </div>
    </div>
  </div>`;
}

function _initBoletaDetail(body, boleta, isAdmin) {
  body.querySelector('#bolBackBtn').addEventListener('click', () => _renderBoletasModal('list', null));
  body.querySelector('#bolResolveBtn')?.addEventListener('click', async () => {
    try {
      const updated = await apiFetch('PATCH', `/api/boletas/${boleta.id}`, { status: 'resolvido' });
      const idx = S.boletas.findIndex(b => b.id === boleta.id);
      if (idx >= 0) S.boletas[idx] = updated;
      renderDashboard();
      _renderBoletasModal('view', boleta.id);
      toast('Boleta resolvida ✓');
    } catch(e) { toast('Erro: ' + e.message, true); }
  });
  body.querySelector('#bolReopenBtn')?.addEventListener('click', async () => {
    try {
      const updated = await apiFetch('PATCH', `/api/boletas/${boleta.id}`, { status: 'pendente', resolvedAt: null, resolvedBy: null });
      const idx = S.boletas.findIndex(b => b.id === boleta.id);
      if (idx >= 0) S.boletas[idx] = updated;
      renderDashboard();
      _renderBoletasModal('view', boleta.id);
      toast('Boleta reaberta');
    } catch(e) { toast('Erro: ' + e.message, true); }
  });
  body.querySelector('#bolEditBtn')?.addEventListener('click', () => _renderBoletasModal('edit', boleta.id));
  body.querySelector('#bolDelBtn')?.addEventListener('click', async () => {
    if (!confirm(`Excluir boleta #${String(boleta.numero).padStart(3,'0')}?`)) return;
    try {
      await apiFetch('DELETE', `/api/boletas/${boleta.id}`);
      S.boletas = S.boletas.filter(b => b.id !== boleta.id);
      renderDashboard();
      _renderBoletasModal('list', null);
      toast('Boleta excluída');
    } catch(e) { toast('Erro: ' + e.message, true); }
  });
}

function _boletaFormHtml(boleta, isAdmin, userBoard) {
  const v = (field) => boleta?.[field] || '';
  const board = boleta?.board || (isAdmin ? NF_STORES_BOL[0] : userBoard);
  return `<div class="bol-form">
    <div class="bol-form-section">
      <div class="bol-form-section-title">Cliente</div>
      <div class="bol-form-grid">
        <div class="bol-fg bol-span3"><label>Nome *</label><input type="text" name="nome" class="bol-input" value="${v('nome')}" required></div>
        <div class="bol-fg"><label>CPF</label><input type="text" name="cpf" class="bol-input" value="${v('cpf')}"></div>
        <div class="bol-fg bol-span2"><label>Endereço</label><input type="text" name="endereco" class="bol-input" value="${v('endereco')}"></div>
        <div class="bol-fg"><label>Nº</label><input type="text" name="numeroEnd" class="bol-input" value="${v('numeroEnd')}"></div>
        <div class="bol-fg"><label>Compl</label><input type="text" name="compl" class="bol-input" value="${v('compl')}"></div>
        <div class="bol-fg"><label>Bairro</label><input type="text" name="bairro" class="bol-input" value="${v('bairro')}"></div>
        <div class="bol-fg"><label>CEP</label><input type="text" name="cep" class="bol-input" value="${v('cep')}"></div>
        <div class="bol-fg bol-span2"><label>Cidade</label><input type="text" name="cidade" class="bol-input" value="${v('cidade')}"></div>
        <div class="bol-fg"><label>Tel</label><input type="text" name="tel" class="bol-input" value="${v('tel')}"></div>
        <div class="bol-fg bol-span2"><label>Email</label><input type="email" name="email" class="bol-input" value="${v('email')}"></div>
      </div>
    </div>
    <div class="bol-form-section">
      <div class="bol-form-section-title">Produto</div>
      <div class="bol-form-grid">
        <div class="bol-fg bol-span2"><label>Produto *</label><input type="text" name="produto" class="bol-input" value="${v('produto')}" required></div>
        <div class="bol-fg"><label>Tamanho</label><input type="text" name="tamanho" class="bol-input" value="${v('tamanho')}"></div>
        <div class="bol-fg"><label>Cor</label><input type="text" name="cor" class="bol-input" value="${v('cor')}"></div>
        <div class="bol-fg"><label>Ref</label><input type="text" name="ref" class="bol-input" value="${v('ref')}"></div>
        <div class="bol-fg"><label>Código</label><input type="text" name="codigo" class="bol-input" value="${v('codigo')}"></div>
        <div class="bol-fg"><label>Fabricante</label><input type="text" name="fabricante" class="bol-input" value="${v('fabricante')}"></div>
        <div class="bol-fg"><label>Doc</label><input type="text" name="doc" class="bol-input" value="${v('doc')}"></div>
        <div class="bol-fg"><label>Data da Compra *</label><input type="date" name="dataCompra" class="bol-input" value="${v('dataCompra')}" required></div>
      </div>
    </div>
    <div class="bol-form-section">
      <div class="bol-form-section-title">Defeito & Prazo</div>
      <div class="bol-form-grid">
        <div class="bol-fg bol-span4"><label>Defeito *</label><textarea name="defeito" class="bol-input" rows="3" required>${v('defeito')}</textarea></div>
        <div class="bol-fg bol-span2"><label>Data Entregue ao cliente * <small>(início do prazo de 30 dias)</small></label><input type="date" name="dataEntregue" class="bol-input" value="${v('dataEntregue')}" required></div>
        ${isAdmin ? `<div class="bol-fg bol-span2"><label>Loja *</label><select name="board" class="bol-input">
          ${NF_STORES_BOL.map(b=>`<option value="${b}"${b===board?' selected':''}>${BOARDS[b]?.label||b}</option>`).join('')}
        </select></div>` : `<input type="hidden" name="board" value="${userBoard}">`}
      </div>
    </div>
    <div class="bol-form-actions">
      <button class="bol-btn-secondary" id="bolFormCancelBtn">Cancelar</button>
      <button class="bol-btn-primary" id="bolFormSaveBtn">${boleta ? 'Salvar Alterações' : 'Criar Boleta'}</button>
    </div>
  </div>`;
}

function _initBoletaForm(body, boleta, isAdmin, userBoard) {
  body.querySelector('#bolFormCancelBtn').addEventListener('click', () =>
    boleta ? _renderBoletasModal('view', boleta.id) : _renderBoletasModal('list', null));

  body.querySelector('#bolFormSaveBtn').addEventListener('click', async () => {
    const data = {};
    body.querySelectorAll('[name]').forEach(el => { data[el.name] = el.value.trim(); });
    if (!data.nome) { toast('Nome é obrigatório', true); return; }
    if (!data.produto) { toast('Produto é obrigatório', true); return; }
    if (!data.dataCompra) { toast('Data da Compra é obrigatória', true); return; }
    if (!data.dataEntregue) { toast('Data entregue é obrigatória', true); return; }
    if (!data.board) data.board = userBoard;
    try {
      if (boleta) {
        const updated = await apiFetch('PATCH', `/api/boletas/${boleta.id}`, data);
        const idx = S.boletas.findIndex(b => b.id === boleta.id);
        if (idx >= 0) S.boletas[idx] = updated;
        renderDashboard();
        _renderBoletasModal('view', boleta.id);
      } else {
        const created = await apiFetch('POST', '/api/boletas', data);
        S.boletas.push(created);
        renderDashboard();
        _renderBoletasModal('view', created.id);
      }
      toast(boleta ? 'Boleta atualizada ✓' : 'Boleta criada ✓');
    } catch(e) { toast('Erro: ' + e.message, true); }
  });
}

function initBoletasModal() {
  document.getElementById('boletasBtn').addEventListener('click', () => openBoletasModal('list'));
  document.getElementById('boletasClose').addEventListener('click', closeBoletasModal);
  document.getElementById('boletasOverlay').addEventListener('click', e => {
    if (e.target.id === 'boletasOverlay') closeBoletasModal();
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  initLoginForm();
  initPerfModal();
  initDailyModal();
  initFolgasModal();
  initWeightsModal();
  initWeeklyModal();
  initFuncionariosModal();
  initCampanhasModal();
  initBoletasModal();
  document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('btnPrev').addEventListener('click', () => navigate(-1));
  document.getElementById('btnNext').addEventListener('click', () => navigate(1));
  checkAuth();
}

init();
