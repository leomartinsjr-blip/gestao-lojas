// ── Config ─────────────────────────────────────────────────────────────────
const BOARDS = {
  admin:      { label: 'ADMIN',        color: '#8B949E' },
  escritorio: { label: 'ESCRITÓRIO',   color: '#64748B' },
  delrey:     { label: 'DEL REY',      color: '#58A6FF' },
  minas:      { label: 'MINAS',        color: '#3FB950' },
  contagem:   { label: 'CONTAGEM',     color: '#D29922' },
  estacao:    { label: 'ESTAÇÃO',      color: '#F85149' },
  tommy:      { label: 'TOMMY',        color: '#22D3EE' },
  lez:        { label: 'LEZ A LEZ',    color: '#F472B6' },
};


const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── State ──────────────────────────────────────────────────────────────────
const S = { year: 2026, month: 5, user: null, employees: [], weights: {}, vsales: {}, weeklyMetas: {}, folgas: [], campaigns: [], nfItems: [], meetingItems: [], pendencias: [], requisicoes: [] };

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
  if (r.status === 401) {
    // Sessão expirada ou senha trocada — volta para login
    showLogin();
    throw new Error('Sessão expirada');
  }
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
    const isAdmin = !S.user.board;
    document.getElementById('funcBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('campanhasBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('usersBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('perfBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('transBtn').style.display = isAdmin ? '' : 'none';
    const now = new Date();
    S.year  = now.getFullYear();
    S.month = now.getMonth() + 1;
    S._loginJustHappened = true;
    updateLabel();
    loadData();
    initMicrovixSync();
    if (S.user.mustChangePassword) showChangePasswordModal();
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
      const isAdmin = !S.user.board;
      document.getElementById('funcBtn').style.display = isAdmin ? '' : 'none';
      document.getElementById('campanhasBtn').style.display = isAdmin ? '' : 'none';
      hideLogin();
      const now = new Date();
      S.year  = now.getFullYear();
      S.month = now.getMonth() + 1;
      S._loginJustHappened = true;
      updateLabel();
      loadData();
      if (S.user.mustChangePassword) showChangePasswordModal();
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

function showChangePasswordModal() {
  const existing = document.getElementById('changePwdModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'changePwdModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';

  overlay.innerHTML = `
    <div style="background:#1e2433;border:1px solid #2d3654;border-radius:12px;padding:28px 32px;width:340px;max-width:95vw;box-shadow:0 8px 32px #0008">
      <div style="font-size:1.15rem;font-weight:700;color:#e2e8f0;margin-bottom:6px">Altere sua senha</div>
      <div style="font-size:.85rem;color:#94a3b8;margin-bottom:20px">Por segurança, crie uma senha pessoal antes de continuar.</div>
      <div style="margin-bottom:12px">
        <label style="font-size:.8rem;color:#94a3b8;display:block;margin-bottom:4px">Nova senha</label>
        <input id="cpNewPass" type="password" autocomplete="new-password" placeholder="Nova senha"
          style="width:100%;box-sizing:border-box;background:#0f1623;border:1px solid #2d3654;border-radius:7px;padding:9px 12px;color:#e2e8f0;font-size:.95rem;outline:none">
      </div>
      <div style="margin-bottom:20px">
        <label style="font-size:.8rem;color:#94a3b8;display:block;margin-bottom:4px">Confirmar nova senha</label>
        <input id="cpConfPass" type="password" autocomplete="new-password" placeholder="Confirmar senha"
          style="width:100%;box-sizing:border-box;background:#0f1623;border:1px solid #2d3654;border-radius:7px;padding:9px 12px;color:#e2e8f0;font-size:.95rem;outline:none">
      </div>
      <div id="cpErr" style="font-size:.8rem;color:#f87171;margin-bottom:12px;display:none"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="cpSkip" style="background:none;border:1px solid #2d3654;border-radius:7px;padding:8px 16px;color:#94a3b8;cursor:pointer;font-size:.9rem">Agora não</button>
        <button id="cpSubmit" style="background:#3b82f6;border:none;border-radius:7px;padding:8px 18px;color:#fff;cursor:pointer;font-size:.9rem;font-weight:600">Alterar</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('cpSkip').onclick = () => overlay.remove();
  document.getElementById('cpNewPass').focus();

  document.getElementById('cpSubmit').onclick = async () => {
    const pwd  = document.getElementById('cpNewPass').value;
    const conf = document.getElementById('cpConfPass').value;
    const errEl = document.getElementById('cpErr');
    errEl.style.display = 'none';
    if (!pwd) { errEl.textContent = 'Informe a nova senha'; errEl.style.display = ''; return; }
    if (pwd !== conf) { errEl.textContent = 'As senhas não coincidem'; errEl.style.display = ''; return; }
    const btn = document.getElementById('cpSubmit');
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      await apiFetch('POST', '/api/change-password', { password: pwd });
      S.user.mustChangePassword = false;
      overlay.remove();
    } catch (e) {
      let msg = 'Erro ao salvar';
      try { msg = JSON.parse(e.message).error || msg; } catch {}
      errEl.textContent = msg; errEl.style.display = '';
      btn.disabled = false; btn.textContent = 'Alterar';
    }
  };
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
    return all.filter(([k]) => DASH_BOARD_FILTER.has(k));
  }
  if (S.user.board === 'escritorio') {
    return Object.entries(BOARDS).filter(([k]) => k !== 'admin' && k !== 'escritorio');
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

    const [campaigns, nfItems, boletas, meetingItems, pendencias, requisicoes] = await Promise.all([
      apiFetch('GET', '/api/campaigns').catch(() => []),
      apiFetch('GET', '/api/nf-items').catch(() => []),
      apiFetch('GET', '/api/boletas').catch(() => []),
      apiFetch('GET', '/api/meeting-items').catch(() => []),
      apiFetch('GET', '/api/pendencias').catch(() => []),
      apiFetch('GET', '/api/requisicoes').catch(() => []),
    ]);
    S.campaigns    = campaigns    || [];
    S.nfItems      = nfItems      || [];
    S.boletas      = boletas      || [];
    S.meetingItems = meetingItems || [];
    S.pendencias   = pendencias   || [];
    S.requisicoes  = requisicoes  || [];
    _updateCampanhasBtn();
    _updateLojaAcaoBadge();

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
  if (!visible.some(([bk]) => (byBoard[bk] || []).length > 0) && S.user?.board !== 'escritorio') {
    c.innerHTML = '<div class="loading">Nenhum vendedor cadastrado. Acesse Funcionários para adicionar.</div>';
    return;
  }

  const isAdmin = !S.user?.board;

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
  const isCurrentMonth = S.year === today.getFullYear() && S.month === today.getMonth() + 1;
  const cutoff = isCurrentMonth ? todayStr : (lastFilledDay || todayStr);

  // Performance Mensal usa D-1 (dados sempre completos)
  const _yBRT = new Date(Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const yesterdayStr = `${_yBRT.getUTCFullYear()}-${pad(_yBRT.getUTCMonth()+1)}-${pad(_yBRT.getUTCDate())}`;
  const perfCutoff = isCurrentMonth ? yesterdayStr : (lastFilledDay || yesterdayStr);
  const perfCutoffLabel = `dados até ${perfCutoff.slice(8)}/${perfCutoff.slice(5,7)}`;

  let weightAccum = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
    if (ds > cutoff) break;
    weightAccum += (S.weights[ds] ?? defW);
  }

  let perfWeightAccum = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
    if (ds > perfCutoff) break;
    perfWeightAccum += (S.weights[ds] ?? defW);
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
    const storeBoards = Object.entries(BOARDS).filter(([k]) => k !== 'admin' && k !== 'escritorio');
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
      <span class="main-card-sub">${['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][S.month-1]} ${S.year}<span class="main-card-sync-date">${perfCutoffLabel}</span></span>
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

  // Pre-compute rowData and aggregates for all boards (needed for store-group sorting)
  const _boardRowData = {};
  const _boardAgg = {};
  for (const [bk] of visible) {
    const emps = byBoard[bk] || [];
    if (emps.length === 0) continue;
    const rowData = emps.map(emp => {
      const vsale  = S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
      const mensal = vsale.meta?.mensal || 0;
      const entries= vsale.entries || {};
      let valor=0, pecas=0, atend=0;
      for (let d=1; d<=daysInMonth; d++) {
        const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
        if (ds > perfCutoff) break;
        const e = entries[ds];
        if (e) { valor += e.value||0; pecas += e.pecas||0; atend += e.atendimentos||0; }
      }
      const metaAccum = mensal * perfWeightAccum / 100;
      const pctMeta   = (metaAccum > 0 && valor > 0) ? valor/metaAccum*100 : null;
      const projecao  = (valor > 0 && metaAccum > 0) ? valor/metaAccum*mensal : null;
      const pa        = (pecas > 0 && atend > 0) ? pecas/atend : null;
      const tm        = (valor > 0 && atend > 0) ? valor/atend : null;
      return { emp, valor, pecas, atend, mensal, pctMeta, projecao, pa, tm };
    });
    _boardRowData[bk] = rowData;
    let totV=0, totP=0, totA=0, totM=0;
    for (const d of rowData) { totV+=d.valor; totP+=d.pecas; totA+=d.atend; totM+=d.mensal; }
    const ma = totM * perfWeightAccum / 100;
    _boardAgg[bk] = {
      valor: totV, mensal: totM,
      pctMeta:  (ma>0 && totV>0) ? totV/ma*100 : null,
      projecao: (totV>0 && ma>0) ? totV/ma*totM : null,
      pa: (totP>0 && totA>0) ? totP/totA : null,
      tm: (totV>0 && totA>0) ? totV/totA : null,
    };
  }

  // Sort store groups by aggregate KPI when sort is active
  let sortedVisible = [...visible];
  if (DASH_SORT.col) {
    sortedVisible.sort(([bkA, bcA], [bkB, bcB]) => {
      const ka = DASH_SORT.col === 'name' ? bcA.label : (_boardAgg[bkA]?.[DASH_SORT.col] ?? null);
      const kb = DASH_SORT.col === 'name' ? bcB.label : (_boardAgg[bkB]?.[DASH_SORT.col] ?? null);
      if (ka == null && kb == null) return 0;
      if (ka == null) return 1;
      if (kb == null) return -1;
      if (typeof ka === 'string') return DASH_SORT.dir * ka.localeCompare(kb, 'pt-BR');
      return DASH_SORT.dir * (ka - kb);
    });
  }

  let grandValor=0, grandPecas=0, grandAtend=0, grandMeta=0;

  for (const [bk, bc] of sortedVisible) {
    const emps = byBoard[bk] || [];
    if (emps.length === 0) continue;

    const rowData = _boardRowData[bk];

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

    // Compute totals before rendering (needed for collapsed header)
    let totValor=0, totPecas=0, totAtend=0, totMeta=0;
    for (const d of rowData) { totValor += d.valor; totPecas += d.pecas; totAtend += d.atend; totMeta += d.mensal; }
    const totMetaAccum = totMeta * perfWeightAccum / 100;
    const totPct  = (totMetaAccum > 0 && totValor > 0) ? totValor/totMetaAccum*100 : null;
    const totProj = (totValor > 0 && totMetaAccum > 0) ? totValor/totMetaAccum*totMeta : null;
    const totPa   = (totPecas > 0 && totAtend > 0) ? totPecas/totAtend : null;
    const totTm   = (totValor > 0 && totAtend > 0) ? totValor/totAtend : null;
    const tpCls   = totPct  == null ? '' : totPct  >= 100 ? 'kpi-pos' : totPct  >= 80 ? 'kpi-warn' : 'kpi-neg';
    const tprCls  = totProj == null ? '' : totProj >= totMeta ? 'kpi-pos' : totProj >= totMeta*0.9 ? 'kpi-warn' : 'kpi-neg';

    grandValor += totValor; grandPecas += totPecas; grandAtend += totAtend; grandMeta += totMeta;

    const metaKey = `${bk}-${S.year}-${S.month}`;
    if (totProj != null && totMeta > 0 && totProj >= totMeta && !META_ACHIEVED.has(metaKey)) {
      META_ACHIEVED.add(metaKey);
      setTimeout(() => triggerMetaCelebration(bc.label, bc.color), 350);
    }

    const isExp = isAdmin ? _perfExpanded.has(bk) : true;

    // Store header row
    const storeRow = document.createElement('tr');
    if (isAdmin) {
      storeRow.className = 'dash-store-hdr dash-store-collapse';
      if (isExp) {
        storeRow.innerHTML = `<td colspan="7" class="dash-store-hdr-td" style="border-left:3px solid ${bc.color};">
          <span class="dia-chevron">▾</span>
          <span class="dash-store-dot" style="background:${bc.color}"></span><strong>${bc.label}</strong>
        </td>`;
      } else {
        storeRow.innerHTML = `
          <td class="dash-td dash-store-hdr-td" style="border-left:3px solid ${bc.color};">
            <span class="dia-chevron">▸</span>
            <span class="dash-store-dot" style="background:${bc.color}"></span><strong>${bc.label}</strong>
          </td>
          <td class="dash-td dash-td-num">${fBRL(totMeta||null)}</td>
          <td class="dash-td dash-td-num">${fBRL(totValor||null)}</td>
          <td class="dash-td dash-td-num ${tpCls}">${fPct(totPct)}</td>
          <td class="dash-td dash-td-num ${tprCls}">${fBRL(totProj)}</td>
          <td class="dash-td dash-td-num${totPa!=null?(totPa>=1.8?' pa-ok':' pa-low'):''}">${totPa!=null?totPa.toFixed(2):'—'}</td>
          <td class="dash-td dash-td-num">${fBRL(totTm)}</td>`;
      }
      storeRow.style.cursor = 'pointer';
      storeRow.addEventListener('click', () => {
        if (_perfExpanded.has(bk)) _perfExpanded.delete(bk); else _perfExpanded.add(bk);
        renderDashboard();
      });
    } else {
      storeRow.className = 'dash-store-hdr';
      storeRow.innerHTML = `<td colspan="7" class="dash-store-hdr-td" style="border-left:3px solid ${bc.color};">
        <span class="dash-store-dot" style="background:${bc.color}"></span><strong>${bc.label}</strong>
      </td>`;
    }
    tbody.appendChild(storeRow);

    // Vendor rows + total (only when expanded or non-admin)
    if (!isAdmin || isExp) {
      for (const { emp, valor, pecas, atend, mensal, pctMeta, projecao, pa, tm } of rowData) {
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
  }

  if (isAdmin && [...visible].length > 1 && grandValor > 0) {
    const gMetaAccum = grandMeta * perfWeightAccum / 100;
    const gPct  = (gMetaAccum > 0 && grandValor > 0) ? grandValor / gMetaAccum * 100 : null;
    const gProj = (grandValor > 0 && gMetaAccum > 0) ? grandValor / gMetaAccum * grandMeta : null;
    const gPa   = (grandPecas > 0 && grandAtend > 0) ? grandPecas / grandAtend : null;
    const gTm   = (grandValor > 0 && grandAtend > 0) ? grandValor / grandAtend : null;
    const gPCls = gPct  == null ? '' : gPct  >= 100 ? 'kpi-pos' : gPct  >= 80 ? 'kpi-warn' : 'kpi-neg';
    const gPrCls = gProj == null ? '' : gProj >= grandMeta ? 'kpi-pos' : gProj >= grandMeta * 0.9 ? 'kpi-warn' : 'kpi-neg';
    const grandRow = document.createElement('tr');
    grandRow.className = 'dash-grand-total';
    grandRow.innerHTML = `
      <td class="dash-td"><strong>Total Geral</strong></td>
      <td class="dash-td dash-td-num">${fBRL(grandMeta || null)}</td>
      <td class="dash-td dash-td-num">${fBRL(grandValor || null)}</td>
      <td class="dash-td dash-td-num ${gPCls}">${fPct(gPct)}</td>
      <td class="dash-td dash-td-num ${gPrCls}">${fBRL(gProj)}</td>
      <td class="dash-td dash-td-num${gPa != null ? (gPa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${gPa != null ? gPa.toFixed(2) : '—'}</td>
      <td class="dash-td dash-td-num">${fBRL(gTm)}</td>
    `;
    tbody.appendChild(grandRow);
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

  if (S.user?.board === 'escritorio') leftCol.remove();

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

  // ── CARD: Pendências ─────────────────────────────────────────────────────
  renderPendenciasCard(midCol);

  // ── CARD: Reunião Mensal ──────────────────────────────────────────────────
  renderMeetingCard(midCol);

  // ── CARD: Recebimento de NF Autorizado ───────────────────────────────────
  renderNFCard(midCol);

  // ── CARD: Boletas de Defeito ─────────────────────────────────────────────
  renderBoletasCard(midCol);

  // ── CARD: Fechamento de Caixa ─────────────────────────────────────────────
  renderCaixaCard(rightCol);

  // ── CARD: Contratos de Experiência ───────────────────────────────────────
  renderContratoCard(rightCol);

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
  const fV = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  let grandVal = 0, grandMeta = 0, grandPecas = 0, grandAtend = 0;

  for (const [bk, bc] of visibleBoards()) {
    const emps = (byBoard[bk] || []).filter(e => {
      const vsale = S.vsales[e.id] || {};
      return (vsale.meta?.mensal || 0) > 0 || (vsale.entries?.[dateStr]?.value || 0) > 0;
    });
    if (!emps.length) continue;

    anyData = true;
    let storeTotalVal = 0, storeTotalMeta = 0, storeTotalPecas = 0, storeTotalAtend = 0;
    const vendorRowsHtml = [];

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
      vendorRowsHtml.push(`
        <div class="dia-row dia-vendor-row">
          <span class="dia-name">${emp.apelido || emp.name.split(' ')[0]}</span>
          <span class="dia-val">${valor > 0 ? fV(valor) : '—'}</span>
          <span class="dia-meta">${metaDia > 0 ? fV(metaDia) : '—'}</span>
          <span class="dia-pa">${pa != null ? pa.toFixed(2) : '—'}</span>
          <span class="dia-pct ${pctCls}">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>
        </div>`);
    }

    grandVal   += storeTotalVal;
    grandMeta  += storeTotalMeta;
    grandPecas += storeTotalPecas;
    grandAtend += storeTotalAtend;

    const storePa  = storeTotalAtend > 0 ? storeTotalPecas / storeTotalAtend : null;
    const storePct = storeTotalMeta > 0 ? storeTotalVal / storeTotalMeta * 100 : null;
    const sPctCls  = storePct == null ? '' : storePct >= 100 ? 'dia-pct-ok' : storePct >= 70 ? 'dia-pct-warn' : 'dia-pct-bad';
    const isAdmin  = !S.user?.board;
    const isExp    = !isAdmin || _dayCardExpanded.has(bk);

    // Store row (always visible) — shows totals + chevron, click to expand (admin only)
    const storeRow = document.createElement('div');
    storeRow.className = 'dia-row dia-store-row' + (isExp ? ' dia-store-expanded' : '');
    storeRow.innerHTML = `
      <span class="dia-name dia-store-label">
        ${isAdmin ? `<span class="dia-chevron">${isExp ? '▾' : '▸'}</span>` : ''}
        <span class="dash-store-dot" style="background:${bc.color}"></span>
        ${bc.label}
      </span>
      <span class="dia-val">${storeTotalVal > 0 ? fV(storeTotalVal) : '—'}</span>
      <span class="dia-meta">${storeTotalMeta > 0 ? fV(storeTotalMeta) : '—'}</span>
      <span class="dia-pa">${storePa != null ? storePa.toFixed(2) : '—'}</span>
      <span class="dia-pct ${sPctCls}">${storePct != null ? storePct.toFixed(1) + '%' : '—'}</span>`;
    if (isAdmin) {
      storeRow.style.cursor = 'pointer';
      storeRow.addEventListener('click', () => {
        if (_dayCardExpanded.has(bk)) _dayCardExpanded.delete(bk);
        else _dayCardExpanded.add(bk);
        _renderDayCardBody(body, dateStr);
      });
    }
    body.appendChild(storeRow);

    // Vendor rows (always visible for store users, toggle for admin)
    if (isExp) {
      const wrap = document.createElement('div');
      wrap.innerHTML = vendorRowsHtml.join('');
      while (wrap.firstChild) body.appendChild(wrap.firstChild);
    }
  }

  if (!anyData) {
    body.insertAdjacentHTML('beforeend',
      '<div style="padding:.85rem 1rem;font-size:.78rem;color:var(--muted)">Sem lançamentos para este dia.</div>');
  } else {
    const grandPa  = grandAtend > 0 ? grandPecas / grandAtend : null;
    const grandPct = grandMeta  > 0 ? grandVal   / grandMeta  * 100 : null;
    const gPctCls  = grandPct == null ? '' : grandPct >= 100 ? 'dia-pct-ok' : grandPct >= 70 ? 'dia-pct-warn' : 'dia-pct-bad';
    body.insertAdjacentHTML('beforeend', `
      <div class="dia-row dia-grand-total">
        <span class="dia-name">TOTAL GERAL</span>
        <span class="dia-val">${grandVal > 0 ? fV(grandVal) : '—'}</span>
        <span class="dia-meta">${grandMeta > 0 ? fV(grandMeta) : '—'}</span>
        <span class="dia-pa">${grandPa != null ? grandPa.toFixed(2) : '—'}</span>
        <span class="dia-pct ${gPctCls}">${grandPct != null ? grandPct.toFixed(1) + '%' : '—'}</span>
      </div>`);
  }
}

function _renderDashWeekBody(body, week, extraData) {
  const fBRL = v => v == null || v === 0 ? '—' : new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const fPct = v => v == null ? '—' : v.toFixed(1)+'%';
  const fDec = v => v == null ? '—' : v.toFixed(2);

  const isAdmin = !S.user?.board;
  const vendedores = S.employees.filter(e => e.isVendedor !== false);
  const byBoard = {};
  for (const emp of vendedores) {
    if (!byBoard[emp.board]) byBoard[emp.board] = [];
    byBoard[emp.board].push(emp);
  }
  const visible = visibleBoards();

  // Admin: single table with one header row + one collapsible row per store
  if (isAdmin) {
    const table = document.createElement('table');
    table.className = 'dw-table';
    table.innerHTML = `<thead><tr class="dw-thead-tr">
      <th class="dw-th">Loja</th>
      <th class="dw-th dw-th-r">Meta Sem.</th>
      <th class="dw-th dw-th-r">Realizado</th>
      <th class="dw-th dw-th-r">% Meta</th>
      <th class="dw-th dw-th-r">Projeção</th>
      <th class="dw-th dw-th-r">% Projeção</th>
      <th class="dw-th dw-th-r">PA</th>
      <th class="dw-th dw-th-r">Prêmio</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    let grandTotValor=0, grandTotMeta=0, grandTotPecas=0, grandTotAtend=0, grandTotPremio=0, grandTotProjecao=0, grandHasProj=false;

    for (const [bk, bc] of visible) {
      const emps = byBoard[bk] || [];
      if (emps.length === 0) continue;

      let totValor=0, totPecas=0, totAtend=0, totMeta=0, totPremio=0, totProjecao=0, hasProj=false;
      const vendorRows = [];

      for (const emp of emps) {
        const k = calcWeekKpis(emp, week, extraData);
        totValor += k.valor; totPecas += k.pecas; totAtend += k.atend; totMeta += k.wMeta;
        if (k.pTotal != null) totPremio += k.pTotal;
        if (k.projecao != null) { totProjecao += k.projecao; hasProj = true; }

        const pctCls     = k.pctMeta  == null ? '' : k.pctMeta  >= 100 ? 'kpi-pos' : k.pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
        const pctProjCls = k.pctProj  == null ? '' : k.pctProj  >= 100 ? 'kpi-pos' : k.pctProj  >= 80 ? 'kpi-warn' : 'kpi-neg';
        const projCls    = k.projecao == null ? '' : k.projecao >= k.wMeta ? 'kpi-pos' : 'kpi-neg';
        const paEarned = k.hitMeta && k.hitPA;
        const premioHtml = k.isFuture
          ? '<span class="dw-p-pending">—</span>'
          : `<span class="dw-p ${k.hitMeta?'dw-p-ok':'dw-p-warn'}">${fBRL(PREMIO_VENDAS)}${k.hitMeta?' ✓':''}</span>
             <span class="dw-p ${paEarned?'dw-p-ok':k.hitPA&&!k.hitMeta?'dw-p-no':'dw-p-warn'}" title="${k.hitPA&&!k.hitMeta?'PA atingido mas meta venda não':''}">+${fBRL(PREMIO_PA)}${paEarned?' ✓':k.hitPA&&!k.hitMeta?' ✗':''}</span>`;

        vendorRows.push(`<tr class="dw-row">
          <td class="dw-td dw-td-name" style="padding-left:1.4rem">${emp.apelido || emp.name}</td>
          <td class="dw-td dw-td-num">${fBRL(k.wMeta||null)}</td>
          <td class="dw-td dw-td-num">${fBRL(k.valor||null)}</td>
          <td class="dw-td dw-td-num ${pctCls}">${fPct(k.pctMeta)}</td>
          <td class="dw-td dw-td-num ${projCls}">${fBRL(k.projecao)}</td>
          <td class="dw-td dw-td-num ${pctProjCls}">${fPct(k.pctProj)}</td>
          <td class="dw-td dw-td-num${k.pa!=null?(k.pa>=1.8?' pa-ok':' pa-low'):''}">${fDec(k.pa)}</td>
          <td class="dw-td dw-premio">${premioHtml}</td>
        </tr>`);
      }

      const totPct     = (totMeta>0&&totValor>0) ? totValor/totMeta*100 : null;
      const totPctProj = (totMeta>0&&hasProj) ? totProjecao/totMeta*100 : null;
      const totPa      = (totPecas>0&&totAtend>0) ? totPecas/totAtend : null;
      const tpCls      = totPct==null?'': totPct>=100?'kpi-pos': totPct>=80?'kpi-warn':'kpi-neg';
      const tpProjCls  = totPctProj==null?'': totPctProj>=100?'kpi-pos': totPctProj>=80?'kpi-warn':'kpi-neg';
      const tprojCls   = !hasProj?'': totProjecao>=totMeta?'kpi-pos':'kpi-neg';
      const isExp     = _weekExpanded.has(bk);

      // Store summary row (always visible, clickable)
      const storeRow = document.createElement('tr');
      storeRow.className = 'dw-store-collapse-row';
      storeRow.innerHTML = `
        <td class="dw-td dw-td-name" style="border-left:3px solid ${bc.color}">
          <span class="dia-chevron">${isExp?'▾':'▸'}</span>
          <span class="dw-store-dot" style="background:${bc.color}"></span>
          <strong>${bc.label}</strong>
        </td>
        <td class="dw-td dw-td-num">${fBRL(totMeta||null)}</td>
        <td class="dw-td dw-td-num">${fBRL(totValor||null)}</td>
        <td class="dw-td dw-td-num ${tpCls}">${fPct(totPct)}</td>
        <td class="dw-td dw-td-num ${tprojCls}">${hasProj?fBRL(totProjecao):'—'}</td>
        <td class="dw-td dw-td-num ${tpProjCls}">${fPct(totPctProj)}</td>
        <td class="dw-td dw-td-num${totPa!=null?(totPa>=1.8?' pa-ok':' pa-low'):''}">${totPa!=null?totPa.toFixed(2):'—'}</td>
        <td class="dw-td dw-td-num">R$ ${totPremio.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>`;
      storeRow.style.cursor = 'pointer';
      storeRow.addEventListener('click', () => {
        if (_weekExpanded.has(bk)) _weekExpanded.delete(bk); else _weekExpanded.add(bk);
        _refreshDashWeek();
      });
      tbody.appendChild(storeRow);

      // Vendor rows + total (only when expanded)
      if (isExp) {
        const wrap = document.createElement('tbody');
        wrap.innerHTML = vendorRows.join('') + `<tr class="dw-total-row">
          <td class="dw-td">Total</td>
          <td class="dw-td dw-td-num">${fBRL(totMeta||null)}</td>
          <td class="dw-td dw-td-num">${fBRL(totValor||null)}</td>
          <td class="dw-td dw-td-num ${tpCls}">${fPct(totPct)}</td>
          <td class="dw-td dw-td-num ${tprojCls}">${hasProj?fBRL(totProjecao):'—'}</td>
          <td class="dw-td dw-td-num ${tpProjCls}">${fPct(totPctProj)}</td>
          <td class="dw-td dw-td-num${totPa!=null?(totPa>=1.8?' pa-ok':' pa-low'):''}">${totPa!=null?totPa.toFixed(2):'—'}</td>
          <td class="dw-td dw-td-num">R$ ${totPremio.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        </tr>`;
        while (wrap.firstChild) tbody.appendChild(wrap.firstChild);
      }

      grandTotValor += totValor; grandTotMeta += totMeta;
      grandTotPecas += totPecas; grandTotAtend += totAtend;
      grandTotPremio += totPremio;
      if (hasProj) { grandTotProjecao += totProjecao; grandHasProj = true; }
    }

    table.appendChild(tbody);

    if (grandTotValor > 0) {
      const gPct     = grandTotMeta>0 ? grandTotValor/grandTotMeta*100 : null;
      const gPctProj = (grandTotMeta>0 && grandHasProj) ? grandTotProjecao/grandTotMeta*100 : null;
      const gPa      = (grandTotPecas>0 && grandTotAtend>0) ? grandTotPecas/grandTotAtend : null;
      const gpCls    = gPct==null?'': gPct>=100?'kpi-pos': gPct>=80?'kpi-warn':'kpi-neg';
      const gpProjCls= gPctProj==null?'': gPctProj>=100?'kpi-pos': gPctProj>=80?'kpi-warn':'kpi-neg';
      const gprojCls = !grandHasProj?'': grandTotProjecao>=grandTotMeta?'kpi-pos':'kpi-neg';
      const gTfoot   = document.createElement('tfoot');
      gTfoot.innerHTML = `<tr class="dw-total-row">
        <td class="dw-td">Total Geral</td>
        <td class="dw-td dw-td-num">${fBRL(grandTotMeta||null)}</td>
        <td class="dw-td dw-td-num">${fBRL(grandTotValor||null)}</td>
        <td class="dw-td dw-td-num ${gpCls}">${fPct(gPct)}</td>
        <td class="dw-td dw-td-num ${gprojCls}">${grandHasProj?fBRL(grandTotProjecao):'—'}</td>
        <td class="dw-td dw-td-num ${gpProjCls}">${fPct(gPctProj)}</td>
        <td class="dw-td dw-td-num${gPa!=null?(gPa>=1.8?' pa-ok':' pa-low'):''}">${gPa!=null?gPa.toFixed(2):'—'}</td>
        <td class="dw-td dw-td-num">R$ ${grandTotPremio.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
      </tr>`;
      table.appendChild(gTfoot);
    }

    body.appendChild(table);
    return;
  }

  // Non-admin: per-store section with its own table (unchanged)
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

    const totPct   = (totMeta>0&&totValor>0) ? totValor/totMeta*100 : null;
    const totPa    = (totPecas>0&&totAtend>0) ? totPecas/totAtend : null;
    const tpCls    = totPct==null?'': totPct>=100?'kpi-pos': totPct>=80?'kpi-warn':'kpi-neg';
    const tprojCls = !hasProj?'': totProjecao>=totMeta?'kpi-pos':'kpi-neg';

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
  const ALL_STORE_KEYS = ['delrey', 'minas', 'contagem', 'estacao', 'tommy', 'lez'];
  const isAdmin = !S.user?.board;
  const STORE_KEYS = isAdmin ? ALL_STORE_KEYS : ALL_STORE_KEYS.filter(k => k === S.user.board);
  const mi = S.month - 1;

  // D-1 BRT (igual ao Performance Mensal)
  const _todayBRT = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const _yestBRT  = new Date(Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const todayBRTStr = `${_todayBRT.getUTCFullYear()}-${pad(_todayBRT.getUTCMonth()+1)}-${pad(_todayBRT.getUTCDate())}`;
  const yesterdayBRTStr = `${_yestBRT.getUTCFullYear()}-${pad(_yestBRT.getUTCMonth()+1)}-${pad(_yestBRT.getUTCDate())}`;
  const isCurrentMonth = S.year === _todayBRT.getUTCFullYear() && S.month === _todayBRT.getUTCMonth() + 1;

  let lastDay = null;
  for (const emp of S.employees) {
    for (const date of Object.keys((S.vsales[emp.id] || {}).entries || {})) {
      if (date.startsWith(prefix) && (lastDay === null || date > lastDay)) lastDay = date;
    }
  }
  // Mês atual: usa D-1 BRT como cutoff (igual ao Performance Mensal)
  const cutoff = isCurrentMonth ? yesterdayBRTStr : lastDay;

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

  // Atualiza subtítulo com base no cutoff (D-1 para mês atual)
  const subEl = document.getElementById('compCardSub');
  if (subEl && cutoff) {
    const [,, dd] = cutoff.split('-');
    subEl.textContent = `dados até ${parseInt(dd)}/${pad(S.month)}`;
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
const PERF_AVAIL  = new Set(['delrey','minas','contagem','estacao','tommy','lez']);
const PERF_CUR    = 4;         // Mai = em andamento
const PERF_LAST3  = [PERF_CUR-2, PERF_CUR-1, PERF_CUR];  // Mar, Abr, Mai

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
  tommy: {
    2022:[null,null,null,null,null,null,null,null,null,null,null,null],
    2023:[null,null,null,null,null,null,null,null,null,null,null,null],
    2024:[ 70281, 67887, 71552, 96715, 94302,119344, 90020,124841, 54636, 75209,186100,503194],
    2025:[  null,  null,  null,  null,  null,196540,133765,129143, 83279,106346,112430,251056],
  },
  lez: {
    2022:[null,null,null,null,null,null,null,null,null,null,null,null],
    2023:[null,null,null,null,null,null,null,null,null,null,null,null],
    2024:[null,null,null,null,null,null,null,null,null,null,null,null],
    2025:[null,null,null,null,null,null,null,77550,68753,83603,123697,207733],
  },
};
const PERF_2026 = {
  delrey:   [134642,119759,128296,128061,null,null,null,null,null,null,null,null],
  minas:    [ 90962, 65116, 90731, 68912,null,null,null,null,null,null,null,null],
  contagem: [ 79523, 81210, 93198,110985,null,null,null,null,null,null,null,null],
  estacao:  [ 72779, 77070, 95819, 78318,null,null,null,null,null,null,null,null],
  tommy:    [ 52889, 64108, 77176, 83443,null,null,null,null,null,null,null,null],
  lez:      [112699, 57373, 49583, 81151,null,null,null,null,null,null,null,null],
};

function fmtBRL(n)  { if (n === null || n === undefined) return '—'; return 'R$ ' + Math.round(n).toLocaleString('pt-BR'); }
function fmtBRLk(n) {
  if (n >= 1e6) return 'R$ ' + (n/1e6).toFixed(1).replace('.',',') + 'M';
  if (n >= 1e3) return 'R$ ' + (n/1e3).toFixed(0) + 'k';
  return fmtBRL(n);
}

// Computa projeção real do mês atual (D-1 BRT) a partir dos vsales do board
// Usa S (estado principal do dashboard) que já está carregado
function computeCurMonthProj(board) {
  const pad = n => String(n).padStart(2, '0');
  const todayBRT = new Date(Date.now() - 3 * 60 * 60 * 1000);
  if (S.year !== todayBRT.getUTCFullYear() || S.month !== todayBRT.getUTCMonth() + 1) return null;
  const yestBRT = new Date(Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const perfCutoff = `${yestBRT.getUTCFullYear()}-${pad(yestBRT.getUTCMonth()+1)}-${pad(yestBRT.getUTCDate())}`;
  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const defW = 100 / daysInMonth;
  let wAccum = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
    if (ds > perfCutoff) break;
    wAccum += (S.weights[ds] ?? defW);
  }
  if (wAccum === 0) return null;
  let realized = 0;
  for (const emp of S.employees) {
    if (emp.board !== board || emp.isVendedor === false) continue;
    const entries = (S.vsales[emp.id] || {}).entries || {};
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${S.year}-${pad(S.month)}-${pad(d)}`;
      if (ds > perfCutoff) break;
      realized += entries[ds]?.value || 0;
    }
  }
  return realized > 0 ? Math.round(realized * 100 / wAccum) : null;
}

function calcPerfMetrics(k, curMonthOverride = null) {
  const d25 = PERF_HIST[k][2025];
  const d26 = PERF_2026[k].slice(); // cópia para não mutar o original
  if (curMonthOverride !== null) d26[PERF_CUR] = curMonthOverride;
  const yoyReal = d26.map((v,i) => v !== null && d25[i] !== null && d25[i] !== 0 ? (v - d25[i]) / d25[i] * 100 : null);
  const last3      = PERF_LAST3.map(i => yoyReal[i]);
  const last3valid = last3.filter(v => v !== null);
  const avgD       = last3valid.length > 0 ? last3valid.reduce((a,b) => a+b, 0) / last3valid.length : 0;
  const proj    = PERF_MONTHS.map((_,i) => {
    if (d26[i] !== null) return d26[i];
    if (d25[i] === null) return null;
    return Math.round(d25[i] * (1 + avgD/100));
  });
  const yoyFull = proj.map((v,i) => v !== null && d25[i] !== null && d25[i] !== 0 ? (v - d25[i]) / d25[i] * 100 : null);
  const realAcum = d26.slice(0, PERF_CUR).reduce((a,v) => a+(v||0), 0);
  const projRest = proj.slice(PERF_CUR).reduce((a,v) => a+(v||0), 0);
  const projTotal = realAcum + projRest;
  const total25 = d25.reduce((a,b) => a+(b||0), 0);
  return { d25, d26, yoyReal, yoyFull, last3, avgD, proj, realAcum, projTotal, total25, curMonthOverride };
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
  const defaultStore = S.user?.board ? S.user.board : 'delrey';
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

// ── Transferências view ────────────────────────────────────────────────────
const TRANS_BOARDS = ['delrey','minas','contagem','estacao'];
let _transDias      = 30;
let _transCompraFrom = '';  // ISO "YYYY-MM-DD"
let _transLojaFilter = '';  // board key
let _transTipoFilter = '';  // 'enviar' | 'receber' | ''
let _transTab       = 'microvix'; // 'microvix' | 'excel'

function openTransModal() {
  document.getElementById('transOverlay').classList.remove('hidden');
  fetch('/api/transferencias/preload').catch(() => {});
  renderTransView();
}
function closeTransModal() {
  document.getElementById('transOverlay').classList.add('hidden');
}

function renderTransView() {
  const body = document.getElementById('transBody');
  body.innerHTML = `<div id="transTabContent"></div>`;
  renderTransExcelTab(body.querySelector('#transTabContent'));
}

function renderTransTabContent(container) {
  if (true) {
    renderTransExcelTab(container);
    return;
  }
  container.innerHTML = `
    <div class="trans-toolbar">
      <label class="trans-label">Período para giro:</label>
      <div class="trans-dias-group">
        ${[30,60,90].map(d => `<button class="trans-dias-btn${d===_transDias?' active':''}" data-dias="${d}">${d} dias</button>`).join('')}
      </div>
      <div class="trans-compra-filter">
        <label class="trans-label">Última entrada desde:</label>
        <input type="date" id="transCompraFrom" class="trans-date-input" value="${_transCompraFrom}">
      </div>
      <button class="trans-calc-btn" id="transCalcBtn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Calcular sugestões
      </button>
    </div>
    <div id="transResult" style="padding:.5rem 0"></div>`;

  container.querySelectorAll('.trans-dias-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _transDias = parseInt(btn.dataset.dias);
      container.querySelectorAll('.trans-dias-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  container.querySelector('#transCompraFrom').addEventListener('change', e => {
    _transCompraFrom = e.target.value;
    const result = container.querySelector('#transResult');
    if (result.querySelector('#transDataTable')) applyTransCompraFilter(result);
  });

  container.querySelector('#transCalcBtn').addEventListener('click', () => loadTransSugestoes(container.querySelector('#transResult')));
}

function renderTransExcelTab(container) {
  container.innerHTML = `
    <div class="trans-toolbar">
      <label class="trans-label">Importar Excel (CompraVendasSaldoPorEmpresa):</label>
      <label class="trans-excel-upload-btn" id="transExcelLabel">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span id="transExcelFileName">Escolher arquivo .xls / .xlsx</span>
        <input type="file" id="transExcelInput" accept=".xls,.xlsx" style="display:none">
      </label>
      <label class="trans-compra-filter-label">
        <span>Última entrada a partir de:</span>
        <input type="date" id="transExcelCompraFrom" class="trans-compra-date-input">
      </label>
      <button class="trans-calc-btn" id="transExcelCalcBtn" disabled>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Calcular sugestões
      </button>
    </div>
    <div id="transExcelResult" style="padding:.5rem 0"></div>`;

  const input     = container.querySelector('#transExcelInput');
  const nameEl    = container.querySelector('#transExcelFileName');
  const calcBtn   = container.querySelector('#transExcelCalcBtn');
  const dateInput = container.querySelector('#transExcelCompraFrom');
  const result    = container.querySelector('#transExcelResult');

  const updateCalcBtn = () => {
    calcBtn.disabled = !(input.files[0] && dateInput.value);
  };

  input.addEventListener('change', () => {
    if (input.files[0]) nameEl.textContent = input.files[0].name;
    updateCalcBtn();
  });

  dateInput.addEventListener('change', updateCalcBtn);

  calcBtn.addEventListener('click', async () => {
    if (!input.files[0] || !dateInput.value) return;
    calcBtn.disabled = true;
    const compraMinDate = dateInput.value; // formato YYYY-MM-DD
    try {
      // Passo 1: lê e parseia o Excel no browser (evita upload de arquivo grande)
      result.innerHTML = '<div class="trans-loading">Lendo arquivo…</div>';
      const buffer = await input.files[0].arrayBuffer();
      const XLSX_LOCAL = window.XLSX;
      if (!XLSX_LOCAL) throw new Error('Biblioteca de leitura de Excel não carregada. Recarregue a página.');

      const wb = XLSX_LOCAL.read(buffer, { type: 'array' });

      // Extrai período do Excel (Sheet1: "Período:" → "01/01/2025 à 31/05/2026")
      let periodDays = 365;
      try {
        const s1 = XLSX_LOCAL.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
        const periodStr = String(s1[0]?.[1] || '');
        const [startStr, endStr] = periodStr.split(' à ');
        if (startStr && endStr) {
          const [sd, sm, sy] = startStr.trim().split('/');
          const [ed, em, ey] = endStr.trim().split('/');
          const diff = new Date(+ey, +em-1, +ed) - new Date(+sy, +sm-1, +sd);
          if (diff > 0) periodDays = Math.round(diff / 86400000);
        }
      } catch {}

      function detectBoard(name) {
        const n = name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (n.includes('CONTAGEM')) return 'contagem';
        if (n.includes('MINAS'))    return 'minas';
        if (n.includes('ESTAC'))    return 'estacao';
        if (n.includes('TOMMY'))    return 'tommy';
        if (n.includes('LEZ'))      return 'lez';
        if (n.includes('CONCEPT') || n.includes('DEL')) return 'delrey';
        return null;
      }

      // Localiza aba com header de colunas
      let companies = [], headerSheetIdx = -1;
      for (let i = 0; i < wb.SheetNames.length; i++) {
        const rows = XLSX_LOCAL.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 });
        const colRowIdx = rows.findIndex(r => Array.isArray(r) &&
          r.some(c => typeof c === 'string' && c.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase() === 'codigo'));
        if (colRowIdx === -1) continue;
        headerSheetIdx = i;
        const headerRow  = rows[colRowIdx];
        const companyRow = colRowIdx > 0 ? rows[colRowIdx - 1] : [];
        const startCol = headerRow.findIndex((h, idx) => idx >= 2 && typeof companyRow[idx] === 'string' && detectBoard(companyRow[idx]));
        for (let c = (startCol !== -1 ? startCol : 9); c < headerRow.length; c += 2) {
          const raw = String(companyRow[c] || '').trim();
          if (!raw) continue;
          const board = detectBoard(raw);
          if (board) companies.push({ board, vendaCol: c, saldoCol: c + 1 });
        }
        break;
      }
      if (!companies.length) throw new Error('Formato não reconhecido — não encontrei colunas de lojas no Excel.');

      // Passo 2: extrai dados de todas as abas
      result.innerHTML = '<div class="trans-loading">Extraindo produtos…</div>';
      const products = {};
      let currentSetor = '';
      for (let i = headerSheetIdx + 1; i < wb.SheetNames.length; i++) {
        const rows = XLSX_LOCAL.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 });
        for (const r of rows) {
          if (!r || !r.length) continue;
          if (typeof r[0] === 'string' && r[0].includes('Setor')) {
            currentSetor = r[0].replace(/^SetorSetor:\s*/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
            continue;
          }
          if (typeof r[0] !== 'number') continue;
          const cod = String(r[0]);
          if (!products[cod]) {
            const rawDate = String(r[8] || '').trim();
            let ultimaCompra = null;
            if (rawDate && rawDate !== '-' && rawDate.includes('/')) {
              const [d, m, y] = rawDate.split('/');
              ultimaCompra = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
            }
            const rawRef = String(r[2] || '').trim().replace(/^="(.+)"$/, '$1');
            products[cod] = { cod, descricao: String(r[1] || '').trim(), referencia: rawRef, setor: currentSetor, ultimaCompra, stocks: {}, giro: {} };
          }
          for (const c of companies) {
            products[cod].stocks[c.board] = (products[cod].stocks[c.board] || 0) + (parseInt(r[c.saldoCol]) || 0);
            products[cod].giro[c.board]   = (products[cod].giro[c.board]   || 0) + (parseInt(r[c.vendaCol]) || 0);
          }
        }
      }

      // Passo 3: filtra produtos sem entrada recente (obrigatório)
      const totalBruto = Object.keys(products).length;
      for (const cod of Object.keys(products)) {
        const p = products[cod];
        if (!p.ultimaCompra || p.ultimaCompra < compraMinDate) delete products[cod];
      }
      const excluidos = totalBruto - Object.keys(products).length;

      // Passo 4: busca catálogo (GET pequeno) e calcula tudo no browser
      result.innerHTML = '<div class="trans-loading">Buscando catálogo Microvix…</div>';
      const catalog = await apiFetch('GET', '/api/catalog').catch(() => ({}));

      result.innerHTML = '<div class="trans-loading">Calculando sugestões…</div>';
      const boards = companies.map(c => c.board);

      function calcProporcional(boards, stocks, giro) {
        const totalGiro  = boards.reduce((s, b) => s + (giro[b]   || 0), 0);
        const totalStock = boards.reduce((s, b) => s + (stocks[b] || 0), 0);
        if (!totalGiro || !totalStock) return null;
        const parts = boards.map(b => {
          const exact = totalStock * (giro[b] || 0) / totalGiro;
          return { b, floor: Math.floor(exact), rem: exact % 1 };
        });
        let assigned = parts.reduce((s, x) => s + x.floor, 0);
        parts.sort((a, c) => c.rem - a.rem);
        for (let i = 0; i < totalStock - assigned; i++) parts[i].floor++;
        const ideal = {};
        for (const { b, floor } of parts) ideal[b] = floor;
        const delta = {};
        for (const b of boards) delta[b] = (stocks[b] || 0) - ideal[b];
        // Regra 1: doadora só envia se estoque > 1
        const donors = boards
          .filter(b => (stocks[b] || 0) > 1 && delta[b] > 0)
          .sort((a, b) => delta[b] - delta[a]);
        // Regra 2: receptora só recebe se estoque = 0 e tem vendas históricas
        const receivers = boards
          .filter(b => (stocks[b] || 0) === 0 && (giro[b] || 0) > 0)
          .sort((a, b) => delta[a] - delta[b]);
        if (!donors.length || !receivers.length) return null;
        const workStocks = { ...stocks };
        const workDelta  = { ...delta };
        const transfers  = [];
        for (const rec of receivers) {
          let needed = -workDelta[rec];
          for (const don of donors) {
            if (workDelta[don] <= 0) continue;
            // Garante que doadora mantém ao menos 1 peça
            const maxSend = (workStocks[don] || 0) - 1;
            if (maxSend <= 0) continue;
            const qty = Math.min(needed, workDelta[don], maxSend);
            if (qty <= 0) continue;
            transfers.push({ de: don, para: rec, qty });
            workStocks[don] -= qty; workStocks[rec] += qty;
            workDelta[don]  -= qty; workDelta[rec]  += qty;
            needed -= qty;
            if (needed <= 0) break;
          }
        }
        if (!transfers.length) return null;
        return { transfers, workStocks, ideal };
      }

      const sugestoes = [];
      for (const p of Object.values(products)) {
        const calc = calcProporcional(boards, p.stocks, p.giro);
        if (!calc) continue;
        const { transfers, workStocks, ideal } = calc;
        const cat = catalog[p.cod] || {};
        sugestoes.push({
          cod_produto:  p.cod,
          descricao:    cat.nome     || p.descricao || '—',
          setor:        cat.setor    || p.setor || '—',
          referencia:   p.referencia || '—',
          stocks:       p.stocks,
          ideal,
          giro:         p.giro,
          transfers,
          stocksAfter:  workStocks,
          ultimaCompra: p.ultimaCompra || null,
        });
      }
      sugestoes.sort((a, b) => {
        const ss = (a.setor || '').localeCompare(b.setor || '', 'pt-BR');
        if (ss !== 0) return ss;
        const sm = (a.marca || '').localeCompare(b.marca || '', 'pt-BR');
        if (sm !== 0) return sm;
        return String(a.cod_produto).localeCompare(String(b.cod_produto), 'pt-BR', { numeric: true });
      });

      renderTransTable(result, { boards, dias: null, total: sugestoes.length, sugestoes, source: 'excel', excluidos, compraMinDate });
    } catch (e) {
      let msg = e.message || e.toString() || 'Erro desconhecido';
      try { const j = JSON.parse(msg); msg = j.error || msg; } catch {}
      msg = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      console.error('[Excel]', e);
      result.innerHTML = `<div class="trans-error">Erro: ${msg}</div>`;
    } finally {
      calcBtn.disabled = false;
    }
  });
}

async function loadTransSugestoes(container) {
  container.innerHTML = '<div class="trans-loading">Buscando estoque e vendas no Microvix…</div>';
  try {
    const lojas = TRANS_BOARDS.join(',');
    const r = await fetch(`/api/transferencias?dias=${_transDias}&lojas=${lojas}`);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}${txt ? ': ' + txt.slice(0, 120) : ''}`);
    }
    const data = await r.json();
    if (data.cacheLoading) {
      let secs = 20;
      container.innerHTML = `<div class="trans-loading">Preparando dados… aguarde <span id="transCountdown">${secs}</span>s</div>`;
      const iv = setInterval(() => {
        const el = document.getElementById('transCountdown');
        if (el) el.textContent = --secs;
      }, 1000);
      setTimeout(() => { clearInterval(iv); loadTransSugestoes(container); }, 20000);
      return;
    }
    renderTransTable(container, data);
  } catch (e) {
    container.innerHTML = `<div class="trans-error">Erro: ${e.message}</div>`;
  }
}

function renderTransTable(container, data) {
  const { boards, dias, total, sugestoes, excluidos, compraMinDate } = data;
  if (!total) {
    container.innerHTML = `<div class="trans-empty">Nenhuma sugestão de transferência encontrada para os últimos ${dias} dias.<br><span style="color:var(--muted);font-size:.78rem">Todas as lojas já têm estoque mínimo de 1 peça por SKU.</span></div>`;
    return;
  }

  const fN = v => v != null ? v : 0;
  const boardLabel = k => BOARDS[k]?.label || k;
  const boardColor = k => BOARDS[k]?.color || '#8B949E';
  const fmtDate    = iso => iso ? iso.slice(0,10).split('-').reverse().join('/') : '—';

  // Resumo por par De→Para
  const pairCount = {};
  for (const s of sugestoes)
    for (const t of s.transfers) {
      const pk = `${t.de}→${t.para}`;
      pairCount[pk] = (pairCount[pk] || 0) + 1;
    }
  const pairSummary = Object.entries(pairCount).sort((a,b) => b[1]-a[1]).map(([pk,n]) => {
    const [de, para] = pk.split('→');
    return `<span class="trans-pair-chip">
      <span style="color:${boardColor(de)}">${boardLabel(de)}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      <span style="color:${boardColor(para)}">${boardLabel(para)}</span>
      <strong>${n} SKU${n>1?'s':''}</strong>
    </span>`;
  }).join('');

  // Montar linhas
  const buildRows = list => list.map(s => {
    const senders   = [...new Set(s.transfers.map(t => t.de))];
    const receivers = [...new Set(s.transfers.map(t => t.para))];
    const compraIso = s.ultimaCompra || '';

    const enviarHtml = s.transfers.map(t =>
      `<span class="trans-sc trans-sc-send" data-de="${t.de}" data-para="${t.para}">
        <span class="trans-sc-name">${boardLabel(t.para)}</span>
        <span class="trans-sc-qty">${t.qty}</span>
      </span>`
    ).join('');

    const receberHtml = s.transfers.map(t =>
      `<span class="trans-sc trans-sc-recv" data-de="${t.de}" data-para="${t.para}">
        <span class="trans-sc-name">${boardLabel(t.de)}</span>
        <span class="trans-sc-qty">${t.qty}</span>
      </span>`
    ).join('');

    return `<tr class="trans-row"
        data-enviar="${senders.join(',')}"
        data-receber="${receivers.join(',')}"
        data-ultima-compra="${compraIso}"
        data-setor="${s.setor || ''}">
      <td class="trans-td trans-cod">${s.cod_produto}</td>
      <td class="trans-td trans-setor">${s.setor || '—'}</td>
      <td class="trans-td trans-ref">${s.referencia || '—'}</td>
      <td class="trans-td">${s.descricao || '—'}</td>
      <td class="trans-td trans-td-c trans-date">${fmtDate(compraIso)}</td>
      <td class="trans-td trans-td-chips trans-col-send">${enviarHtml}</td>
      <td class="trans-td trans-td-chips trans-col-recv">${receberHtml}</td>
    </tr>`;
  }).join('');

  const lojasBtns = boards.map(b =>
    `<button class="trans-filter-btn trans-loja-btn${_transLojaFilter===b?' active':''}" data-loja="${b}" style="--fc:${boardColor(b)}">${boardLabel(b)}</button>`
  ).join('');

  const html = `
    <div class="trans-summary">
      <span class="trans-total"><strong>${total}</strong> SKU${total>1?'s':''} com sugestão${dias ? ` · últimos ${dias} dias` : ''}${compraMinDate ? ` · entrada ≥ ${compraMinDate.split('-').reverse().join('/')}` : ''}${excluidos ? ` <span class="trans-excluidos">(${excluidos} excluídos por data)</span>` : ''}</span>
      <button id="transExportBtn" class="trans-export-btn">↓ Exportar Excel</button>
      <div class="trans-pairs">${pairSummary}</div>
    </div>
    <div class="trans-filter-bar">
      <div class="trans-filter-row">
        <span class="trans-filter-label">Loja:</span>
        <button class="trans-filter-btn trans-loja-btn${!_transLojaFilter?' active':''}" data-loja="">Todas</button>
        ${lojasBtns}
      </div>
      <div class="trans-filter-row">
        <span class="trans-filter-label">Tipo:</span>
        <button class="trans-tipo-btn${!_transTipoFilter?' active':''}" data-tipo="">Todas</button>
        <button class="trans-tipo-btn trans-tipo-send${_transTipoFilter==='enviar'?' active':''}" data-tipo="enviar">↑ Enviar</button>
        <button class="trans-tipo-btn trans-tipo-recv${_transTipoFilter==='receber'?' active':''}" data-tipo="receber">↓ Receber</button>
      </div>
    </div>
    <div style="overflow-x:auto">
    <table class="trans-table" id="transDataTable">
      <thead><tr>
        <th class="trans-th">Código</th>
        <th class="trans-th">Setor</th>
        <th class="trans-th">Ref.</th>
        <th class="trans-th">Produto</th>
        <th class="trans-th trans-th-c">Últ. Entrada</th>
        <th class="trans-th trans-th-send trans-col-send">↑ Enviar</th>
        <th class="trans-th trans-th-recv trans-col-recv">↓ Receber</th>
      </tr></thead>
      <tbody id="transTableBody">${buildRows(sugestoes)}</tbody>
    </table></div>`;

  container.innerHTML = html;
  applyTransFilter(container);

  const exportBtn = container.querySelector('#transExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => _exportTransExcel(sugestoes));

  // Filtro loja
  container.querySelectorAll('.trans-loja-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _transLojaFilter = btn.dataset.loja;
      container.querySelectorAll('.trans-loja-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyTransFilter(container);
    });
  });

  // Filtro tipo
  container.querySelectorAll('.trans-tipo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _transTipoFilter = btn.dataset.tipo;
      container.querySelectorAll('.trans-tipo-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyTransFilter(container);
    });
  });
}

function _exportTransExcel(sugestoes) {
  const XL = window.XLSX;
  if (!XL) { alert('Biblioteca SheetJS não carregada. Recarregue a página.'); return; }
  const header = ['Código', 'Setor', 'Referência', 'Produto', 'Últ. Entrada', 'Enviar (destino: qtd)', 'Receber (origem: qtd)'];
  const rows = sugestoes.map(s => {
    const enviar  = s.transfers.map(t => `${BOARDS[t.para]?.label || t.para}: ${t.qty}`).join(', ');
    const receber = s.transfers.map(t => `${BOARDS[t.de]?.label  || t.de }: ${t.qty}`).join(', ');
    const compra  = s.ultimaCompra ? s.ultimaCompra.slice(0,10).split('-').reverse().join('/') : '—';
    return [s.cod_produto, s.setor || '—', s.referencia || '—', s.descricao || '—', compra, enviar, receber];
  });
  const ws = XL.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch:10 }, { wch:22 }, { wch:14 }, { wch:42 }, { wch:12 }, { wch:30 }, { wch:30 }];
  ws['!pageSetup'] = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape', paperSize: 9 };
  ws['!print'] = { area: `A1:G${rows.length + 1}` };
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'Transferências');
  XL.writeFile(wb, 'transferencias.xlsx');
}

function applyTransFilter(container) {
  const table = container.querySelector('#transDataTable');
  const focusSend = _transTipoFilter === 'enviar'  && !!_transLojaFilter;
  const focusRecv = _transTipoFilter === 'receber' && !!_transLojaFilter;

  // Oculta coluna oposta quando loja + tipo estão selecionados
  if (table) {
    table.classList.toggle('trans-hide-recv', focusSend);
    table.classList.toggle('trans-hide-send', focusRecv);
  }

  container.querySelectorAll('#transTableBody .trans-row').forEach(row => {
    const enviar  = (row.dataset.enviar  || '').split(',');
    const receber = (row.dataset.receber || '').split(',');
    const compra  = row.dataset.ultimaCompra || '';

    let lojaOk = true;
    if (_transLojaFilter) {
      if (_transTipoFilter === 'enviar')   lojaOk = enviar.includes(_transLojaFilter);
      else if (_transTipoFilter === 'receber') lojaOk = receber.includes(_transLojaFilter);
      else lojaOk = enviar.includes(_transLojaFilter) || receber.includes(_transLojaFilter);
    } else if (_transTipoFilter === 'enviar') {
      lojaOk = enviar.length > 0;
    } else if (_transTipoFilter === 'receber') {
      lojaOk = receber.length > 0;
    }

    const compraOk = !_transCompraFrom || compra >= _transCompraFrom;
    const visible  = lojaOk && compraOk;
    row.style.display = visible ? '' : 'none';

    if (!visible) return;

    // Filtra chips individuais quando loja+tipo selecionados
    row.querySelectorAll('.trans-sc-send').forEach(chip => {
      chip.style.display = focusSend ? (chip.dataset.de === _transLojaFilter ? '' : 'none') : '';
    });
    row.querySelectorAll('.trans-sc-recv').forEach(chip => {
      chip.style.display = focusRecv ? (chip.dataset.para === _transLojaFilter ? '' : 'none') : '';
    });
  });
}

function applyTransCompraFilter(container) {
  applyTransFilter(container);
}

function buildPerfTabs() {
  const tabs = document.getElementById('perfStoreTabs');
  tabs.innerHTML = '';
  const show = !S.user?.board ? ALL_STORES : [S.user.board];
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

  const curProj = computeCurMonthProj(k);
  const m = calcPerfMetrics(k, curProj);
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
        <div class="perf-kpi-sub">${PERF_LAST3.map((idx,j) => m.last3[j] !== null ? `${PERF_MONTHS[idx]} ${m.last3[j].toFixed(1)}%` : null).filter(Boolean).join(' · ')}</div>
      </div>
      <div class="perf-kpi" style="border-color:#D2992255">
        <div class="perf-kpi-label">Projeção 2026 (ano)</div>
        <div class="perf-kpi-value">${fmtBRLk(m.projTotal)}</div>
        <div class="perf-kpi-sub ${cls(pProj)}">${sign(pProj)}${pProj.toFixed(1)}% vs 2025</div>
      </div>
    </div>`;

  // ── Annual history ────────────────────────────────────────────────────────
  const HIST_YEARS = [2022, 2023, 2024, 2025];
  const annualTotals = HIST_YEARS.map(y => PERF_HIST[k][y].reduce((a,b) => a+(b||0), 0));
  const annualYoY    = annualTotals.map((v,i) => i === 0 || annualTotals[i-1] === 0 ? null : (v - annualTotals[i-1]) / annualTotals[i-1] * 100);

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
    const isProj = (real === null || i === PERF_CUR) && v26 !== null;
    histYears.forEach(y => { colTotals[y] += PERF_HIST[k][y][i] || 0; });
    if (v26 !== null) colTotals.v26 += v26;
    const deltas = histYears.map((y,j) => j === 0 || h[j] === null || h[j-1] === null || h[j-1] === 0 ? null : (h[j] - h[j-1]) / h[j-1] * 100);
    const d2625  = v26 !== null && h[3] !== null ? (v26 - h[3]) / h[3] * 100 : null;
    const d2624  = v26 !== null && h[2] !== null ? (v26 - h[2]) / h[2] * 100 : null;
    const d2623  = v26 !== null && h[1] !== null ? (v26 - h[1]) / h[1] * 100 : null;
    const d2622  = v26 !== null && h[0] !== null ? (v26 - h[0]) / h[0] * 100 : null;
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
  const totDeltas = histYears.map((y,j) => j === 0 || colTotals[histYears[j-1]] === 0 ? null : (colTotals[y]-colTotals[histYears[j-1]])/colTotals[histYears[j-1]]*100);
  const tot2625 = colTotals[2025] !== 0 ? (colTotals.v26 - colTotals[2025]) / colTotals[2025] * 100 : null;
  const tot2624 = colTotals[2024] !== 0 ? (colTotals.v26 - colTotals[2024]) / colTotals[2024] * 100 : null;
  const tot2623 = colTotals[2023] !== 0 ? (colTotals.v26 - colTotals[2023]) / colTotals[2023] * 100 : null;
  const tot2622 = colTotals[2022] !== 0 ? (colTotals.v26 - colTotals[2022]) / colTotals[2022] * 100 : null;
  const totDCell = (d, extra='') => d !== null
    ? `<td class="${cls(d)} ${extra}" style="font-size:.72rem">${sign(d)+d.toFixed(1)}%</td>`
    : `<td class="${extra}" style="font-size:.72rem;color:var(--muted)">—</td>`;
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
  document.getElementById('transBtn').addEventListener('click', openTransModal);
  document.getElementById('transClose').addEventListener('click', closeTransModal);
  document.getElementById('transOverlay').addEventListener('click', e => {
    if (e.target.id === 'transOverlay') closeTransModal();
  });
}

// ── Daily modal ────────────────────────────────────────────────────────────
function openDailyModal() {
  document.getElementById('dailyOverlay').classList.remove('hidden');
  const defaultStore = S.user?.board ? S.user.board : 'delrey';
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
  const show = !S.user?.board ? ALL_STORES : [S.user.board];
  if (show.length <= 1) return;
  show.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'perf-tab-btn';
    btn.dataset.store = k;
    btn.textContent = BOARDS[k]?.label || k;
    const color = BOARDS[k]?.color || '#8B949E';
    btn.style.borderColor = color;
    btn.style.background  = k === activeBoard ? color : '#0D1117';
    btn.style.color       = k === activeBoard ? '#0D1117' : '#fff';
    btn.addEventListener('click', () => {
      document.querySelectorAll('#dailyStoreTabs .perf-tab-btn').forEach(b => {
        const c = BOARDS[b.dataset.store]?.color || '#8B949E';
        b.style.background = b.dataset.store === k ? c : '#0D1117';
        b.style.color      = b.dataset.store === k ? '#0D1117' : '#fff';
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
  const isAdmin = !S.user?.board;
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
    const emps = S.employees.filter(e => e.board === bk && (e.isVendedor !== false || e.cargo?.toLowerCase().includes('gerente')) && !e.inativo);
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
const PREMIO_VENDAS         = 80;
const PREMIO_GERENTE_VENDAS = 250;
const PREMIO_PA             = 50;
const PA_THRESHOLD          = 1.80;

let WK = { refDate: null, cache: {} };
let DASH_WEEK = { refDate: null };
let DASH_DAY  = { refDate: null };
let _dayCardTimer = null;
const _dayCardExpanded  = new Set(); // lojas expandidas no card diário
const _perfExpanded     = new Set(); // lojas expandidas em Performance Mensal (admin)
const _weekExpanded     = new Set(); // lojas expandidas em Meta Semanal (admin)
let DASH_BOARD_FILTER = new Set(); // empty = todas as lojas

function _startDayCardAutoRefresh() {
  if (_dayCardTimer) clearInterval(_dayCardTimer);
  const now = new Date();
  const isCurrentMonth = S.year === now.getFullYear() && S.month === now.getMonth() + 1;
  if (!isCurrentMonth) return; // sem refresh em meses passados
  const INTERVAL = 1 * 60 * 1000; // 1 min — alinhado ao sync do servidor
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
      const isCurrentMo = S.year === now.getFullYear() && S.month === now.getMonth() + 1;
      const cutoff = isCurrentMo ? todayStr : (lastFilled || todayStr);
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
  let wMeta        = (manualMeta > 0) ? manualMeta : autoMeta;

  // D-1 BRT cutoff for projection (same logic as Performance Mensal)
  const yestBRT = new Date(Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const yesterdayBRTStr = `${yestBRT.getUTCFullYear()}-${pad(yestBRT.getUTCMonth()+1)}-${pad(yestBRT.getUTCDate())}`;
  const projCutoff = week.endStr < yesterdayBRTStr ? week.endStr : yesterdayBRTStr;

  let valor = 0, pecas = 0, atend = 0, daysElapsed = 0;
  let valorForProj = 0, weekWeightAccum = 0;

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

  // Accumulate weight and sales up to D-1 BRT for projection
  for (const ds of dates) {
    if (ds > projCutoff) break;
    const monthKey = ds.slice(0, 7);
    if (monthKey === curKey) {
      const daysInMonth = new Date(S.year, S.month, 0).getDate();
      weekWeightAccum += (S.weights[ds] ?? +(100 / daysInMonth).toFixed(6));
    } else if (extraData?.[monthKey]?.weights) {
      const [y2, m2] = monthKey.split('-').map(Number);
      weekWeightAccum += (extraData[monthKey].weights[ds] ?? +(100 / new Date(y2, m2, 0).getDate()).toFixed(6));
    }
    let projEntry;
    if (monthKey === curKey) {
      projEntry = vsale.entries?.[ds];
    } else if (extraData?.[monthKey]?.vsales?.[emp.id]) {
      projEntry = extraData[monthKey].vsales[emp.id].entries?.[ds];
    }
    if (projEntry) valorForProj += projEntry.value || 0;
  }

  let pa = (pecas > 0 && atend > 0) ? pecas / atend : null;
  let pctMeta = (wMeta > 0 && valor > 0) ? valor / wMeta * 100 : null;

  const isComplete = week.endStr < todayStr ||
    (week.endStr === todayStr && daysElapsed === 7);
  const isFuture   = week.startStr > todayStr;

  let projecao = null;
  if (!isFuture && wMeta > 0 && weekWeightAccum > 0 && valorForProj > 0) {
    projecao = valorForProj * weekWeightSum / weekWeightAccum;
  }
  if (isComplete) projecao = valor;

  const isGerente = !!emp.cargo?.toLowerCase().includes('gerente');

  const hitMeta = wMeta > 0 && valor >= wMeta;
  const hitPA   = pa != null && pa > PA_THRESHOLD;
  const pVendas = isComplete ? (hitMeta ? PREMIO_VENDAS : 0) : null;
  const pPA     = isComplete ? (hitMeta && hitPA ? PREMIO_PA : 0) : null;
  const pTotal  = pVendas != null ? pVendas + (pPA||0) : null;

  const pctProj = (wMeta > 0 && projecao != null) ? projecao / wMeta * 100 : null;

  return { wMeta, valor, pa, pecas, atend, pctMeta, pctProj, projecao,
           hitMeta, hitPA, pVendas, pPA, pTotal, isGerente,
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
  const isAdmin = !S.user?.board;

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
    const emps = S.employees.filter(e => e.board === bk && (e.isVendedor !== false || e.cargo?.toLowerCase().includes('gerente')) && !e.inativo);
    if (emps.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'wk-section';

    // Passo 1: calcular KPIs e acumular totais da loja
    let totValor=0, totPecas=0, totAtend=0, totMeta=0, totPremio=0, totProjecao2=0, hasProj2=false, hasProj3=false;
    const kpiCache = new Map();
    const xData = Object.keys(extraData).length ? extraData : null;
    for (const emp of emps) {
      const k = calcWeekKpis(emp, week, xData);
      kpiCache.set(emp.id, k);
      totValor += k.valor; totPecas += k.pecas; totAtend += k.atend; totMeta += k.wMeta;
      if (k.projecao != null) { totProjecao2 += k.projecao; hasProj2 = true; hasProj3 = true; }
    }
    // Totais da loja para calcular prêmio do gerente
    const storeHitMeta = totMeta > 0 && totValor >= totMeta;
    const storePaVal   = (totPecas > 0 && totAtend > 0) ? totPecas / totAtend : null;
    const storeHitPA   = storePaVal != null && storePaVal > PA_THRESHOLD;

    // Passo 2: montar linhas com prêmio corrigido para gerentes
    const rows = emps.map(emp => {
      const k = kpiCache.get(emp.id);

      // Gerente: prêmio baseado no total da loja, não nos dados individuais
      const hitMeta   = k.isGerente ? storeHitMeta : k.hitMeta;
      const hitPA     = k.isGerente ? storeHitPA   : k.hitPA;
      const premioAmt = k.isGerente ? PREMIO_GERENTE_VENDAS : PREMIO_VENDAS;
      const pVendas   = k.isComplete ? (hitMeta ? premioAmt : 0) : null;
      const pPA       = k.isComplete ? (hitMeta && hitPA ? PREMIO_PA : 0) : null;
      const pTotal    = pVendas != null ? pVendas + (pPA || 0) : null;
      if (pTotal != null) totPremio += pTotal;

      if (isCurrent && hitMeta && (k.wMeta > 0 || k.isGerente)) {
        const empKey = `wk-emp-${emp.id}-${week.startStr}`;
        if (!META_ACHIEVED.has(empKey)) {
          META_ACHIEVED.add(empKey);
          pendingCelebrations.push({ label: emp.apelido || emp.name, color: bc.color });
        }
      }

      const pctCls     = k.pctMeta  == null ? '' : k.pctMeta  >= 100 ? 'kpi-pos' : k.pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
      const projCls    = k.projecao == null ? '' : k.projecao >= k.wMeta ? 'kpi-pos' : 'kpi-neg';
      const pctProjCls = k.pctProj  == null ? '' : k.pctProj  >= 100 ? 'kpi-pos' : k.pctProj  >= 80 ? 'kpi-warn' : 'kpi-neg';

      const paEarned2 = hitMeta && hitPA;
      const premioHtml = k.isComplete
        ? `<span class="wk-p ${pVendas>0?'wk-p-ok':'wk-p-no'}" title="Meta de vendas">${fBRL(premioAmt)} ${hitMeta?'✓':'✗'}</span>
           <span class="wk-p ${paEarned2?'wk-p-ok':'wk-p-no'}" title="${hitPA&&!hitMeta?'PA atingido mas meta venda não':'PA > '+PA_THRESHOLD}">+${fBRL(PREMIO_PA)} ${paEarned2?'✓':'✗'}</span>`
        : k.isFuture ? '<span class="wk-p-pending">—</span>'
        : `<span class="wk-p ${hitMeta?'wk-p-ok':'wk-p-pend'}" title="Meta">${fBRL(premioAmt)}${hitMeta?' ✓':''}</span>
           <span class="wk-p ${paEarned2?'wk-p-ok':hitPA&&!hitMeta?'wk-p-no':'wk-p-pend'}" title="${hitPA&&!hitMeta?'PA atingido mas meta venda não':'PA > '+PA_THRESHOLD}">+${fBRL(PREMIO_PA)}${paEarned2?' ✓':hitPA&&!hitMeta?' ✗':''}</span>`;

      const metaCell = isAdmin
        ? `<td class="wk-td wk-td-edit" data-empid="${emp.id}" data-week="${week.startStr}">${fBRL(k.wMeta||null)}</td>`
        : `<td class="wk-td wk-td-num">${fBRL(k.wMeta||null)}</td>`;

      return `<tr class="wk-row">
        <td class="wk-td wk-td-name">${emp.apelido || emp.name}</td>
        ${metaCell}
        <td class="wk-td wk-td-num">${fBRL(k.valor||null)}</td>
        <td class="wk-td wk-td-num ${pctCls}">${fPct(k.pctMeta)}</td>
        <td class="wk-td wk-td-num ${projCls}">${fBRL(k.projecao)}</td>
        <td class="wk-td wk-td-num ${pctProjCls}">${fPct(k.pctProj)}</td>
        <td class="wk-td wk-td-num${k.pa != null ? (k.pa >= 1.8 ? ' pa-ok' : ' pa-low') : ''}">${fDec(k.pa)}</td>
        <td class="wk-td wk-premio">${premioHtml}</td>
      </tr>`;
    }).join('');

    const totPa      = (totPecas>0&&totAtend>0) ? totPecas/totAtend : null;
    const totPct     = (totMeta>0&&totValor>0) ? totValor/totMeta*100 : null;
    const tpCls      = totPct == null ? '' : totPct>=100?'kpi-pos':totPct>=80?'kpi-warn':'kpi-neg';
    const tprojCls2  = !hasProj2 ? '' : totProjecao2 >= totMeta ? 'kpi-pos' : 'kpi-neg';
    const totPctProj = (hasProj3 && totMeta > 0) ? totProjecao2 / totMeta * 100 : null;
    const tpProjCls  = totPctProj == null ? '' : totPctProj>=100?'kpi-pos':totPctProj>=80?'kpi-warn':'kpi-neg';

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
          <th class="wk-th wk-th-r">% Projeção</th>
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
          <td class="wk-td wk-td-num ${tpProjCls}">${fPct(totPctProj)}</td>
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
  document.getElementById('funcContrato1').value = emp?.contrato1 || '';
  document.getElementById('funcContrato2').value = emp?.contrato2 || '';
  document.getElementById('funcCargo').value     = emp?.cargo     || '';
  document.getElementById('funcSalario').value   = emp?.salario   || '';
  document.getElementById('funcComissaoSemMeta').value  = emp?.comissaoSemMeta  || '';
  document.getElementById('funcComissao').value         = emp?.comissao         || '';
  document.getElementById('funcComissaoMeta2').value    = emp?.comissaoMeta2    || '';
  document.getElementById('funcComissaoSuper').value    = emp?.comissaoSuper    || '';
  document.getElementById('funcComissaoVR').value       = emp?.comissaoVR       || '';
  document.getElementById('funcAberturaLoja').value     = emp?.aberturaLoja     || '';
  document.getElementById('funcComissaoGerente').value  = emp?.comissaoGerente  || '';
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
  const contrato1 = parseInt(document.getElementById('funcContrato1').value) || 0;
  const contrato2 = parseInt(document.getElementById('funcContrato2').value) || 0;
  const cargo     = document.getElementById('funcCargo').value;
  const salario   = parseFloat(document.getElementById('funcSalario').value) || 0;
  const comissaoSemMeta  = parseFloat(document.getElementById('funcComissaoSemMeta').value)  || 0;
  const comissao         = parseFloat(document.getElementById('funcComissao').value)          || 0;
  const comissaoMeta2    = parseFloat(document.getElementById('funcComissaoMeta2').value)     || 0;
  const comissaoSuper    = parseFloat(document.getElementById('funcComissaoSuper').value)     || 0;
  const comissaoVR       = parseFloat(document.getElementById('funcComissaoVR').value)        || 0;
  const aberturaLoja     = parseFloat(document.getElementById('funcAberturaLoja').value)      || 0;
  const comissaoGerente  = parseFloat(document.getElementById('funcComissaoGerente').value)   || 0;
  const isVendedor = ['Vendedor', 'Gerente Vendedor'].includes(cargo);
  const inativo   = document.getElementById('funcInativo').checked;
  const desligamento = document.getElementById('funcDesligamento').value;
  const fotoRemoved  = !FE.newPhotoFile && !FE.currentPhotoUrl && !!FE.editingId;

  if (!name || !board) { toast('Nome e loja são obrigatórios', true); return; }
  if (!cargo) { toast('Cargo é obrigatório', true); return; }
  if (!admissao) { toast('Data de admissão é obrigatória', true); return; }
  if (!contrato1) { toast('1º Contrato Experiência é obrigatório', true); return; }

  const btn = document.getElementById('funcSaveBtn');
  btn.disabled = true;
  try {
    const body = { name, apelido, board, cpf, microvixCod, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, isVendedor, inativo, desligamento };
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
  const isAdmin = () => !S.user?.board;

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
  const isAdmin = !S.user?.board;
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
  const ALL_STORE_KEYS = Object.keys(BOARDS).filter(k => k !== 'admin');

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
  const isAdmin  = !S.user?.board;
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

// ── Pendências ────────────────────────────────────────────────────────────

const PENDENCIA_USERS = [
  { key: 'leonardo',   label: 'Leonardo',   color: '#58A6FF' },
  { key: 'ingrid',     label: 'Ingrid',     color: '#F78166' },
  { key: 'escritorio', label: 'Escritório', color: '#3FB950' },
];

function _pendenciaChips(assignedTo) {
  // handle legacy string and new array format
  const arr = Array.isArray(assignedTo) ? assignedTo : (assignedTo === 'todos' ? ['leonardo','ingrid','escritorio'] : [assignedTo]);
  if (arr.length >= PENDENCIA_USERS.length) {
    return `<span class="pend-chip" style="background:#8B949E22;color:#8B949E;border:1px solid #8B949E44">Todos</span>`;
  }
  return arr.map(key => {
    const u = PENDENCIA_USERS.find(x => x.key === key);
    if (!u) return '';
    return `<span class="pend-chip" style="background:${u.color}22;color:${u.color};border:1px solid ${u.color}44">${u.label}</span>`;
  }).join('');
}

function _pendMatchesMine(item, myUsername) {
  const arr = Array.isArray(item.assignedTo) ? item.assignedTo : (item.assignedTo === 'todos' ? ['leonardo','ingrid','escritorio'] : [item.assignedTo]);
  return arr.includes(myUsername) || arr.length >= PENDENCIA_USERS.length;
}

function _renderPendenciasActive(body, filter, myUsername, refresh) {
  let items = (S.pendencias || []).filter(x => !x.resolved);
  if (filter === 'mine') items = items.filter(x => _pendMatchesMine(x, myUsername));
  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Nenhuma pendência</div>';
    return;
  }
  body.innerHTML = items.map(item => `
    <div class="nf-item" data-id="${item.id}">
      <label class="nf-chk-label">
        <input type="checkbox" class="nf-chk pend-chk" data-id="${item.id}">
        <span class="nf-item-text">${_escHtml(item.text)}</span>
      </label>
      <span class="nf-item-meta" style="display:flex;align-items:center;gap:.35rem">
        ${_pendenciaChips(item.assignedTo)}
        <span class="nf-date-tag">${_escHtml(item.createdByLabel || item.createdBy)} ${_fmtNFDate(item.createdAt)}</span>
      </span>
      <button class="nf-del-btn pend-del" data-id="${item.id}" title="Excluir">&times;</button>
    </div>`).join('');

  body.querySelectorAll('.pend-chk').forEach(chk => {
    chk.addEventListener('change', async () => {
      if (!chk.checked) return;
      const id = parseInt(chk.dataset.id);
      chk.disabled = true;
      const updated = await apiFetch('PATCH', `/api/pendencias/${id}`, { resolved: true }).catch(() => null);
      const item = S.pendencias.find(x => x.id === id);
      if (item && updated) Object.assign(item, updated);
      _renderPendenciasActive(body, filter, myUsername, refresh);
      refresh();
    });
  });

  body.querySelectorAll('.pend-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      if (!confirm('Excluir esta pendência?')) return;
      await apiFetch('DELETE', `/api/pendencias/${id}`).catch(() => {});
      S.pendencias = S.pendencias.filter(x => x.id !== id);
      _renderPendenciasActive(body, filter, myUsername, refresh);
      refresh();
    });
  });
}

function _renderPendenciasHistory(body, refresh) {
  const items = (S.pendencias || [])
    .filter(x => x.resolved)
    .sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));

  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Histórico vazio</div>';
    return;
  }
  body.innerHTML = `
    <div class="nf-hist-header"><button class="nf-clear-btn" id="pendClearAll">Limpar tudo</button></div>
    ${items.map(item => `
      <div class="nf-item nf-checked nf-hist-item" data-id="${item.id}">
        <div class="nf-hist-item-main">
          <span class="nf-item-text">${_escHtml(item.text)}</span>
          <div class="nf-hist-dates">
            ${_pendenciaChips(item.assignedTo)}
            <span class="nf-date-tag">por ${_escHtml(item.createdByLabel || item.createdBy)}</span>
            <span class="nf-date-sep">·</span>
            <span class="nf-date-tag nf-date-archived">✓ ${_fmtNFDate(item.resolvedAt)} por ${_escHtml(item.resolvedBy || '—')}</span>
          </div>
        </div>
        <button class="nf-del-btn pend-hist-del" data-id="${item.id}" title="Excluir">&times;</button>
      </div>`).join('')}`;

  body.querySelectorAll('.pend-hist-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      await apiFetch('DELETE', `/api/pendencias/${id}`).catch(() => {});
      S.pendencias = S.pendencias.filter(x => x.id !== id);
      _renderPendenciasHistory(body, refresh);
      refresh();
    });
  });

  body.querySelector('#pendClearAll')?.addEventListener('click', async () => {
    const toDelete = (S.pendencias || []).filter(x => x.resolved);
    await Promise.all(toDelete.map(x => apiFetch('DELETE', `/api/pendencias/${x.id}`).catch(() => {})));
    S.pendencias = S.pendencias.filter(x => !x.resolved);
    _renderPendenciasHistory(body, refresh);
    refresh();
  });
}

function renderPendenciasCard(container) {
  const isAdmin = !S.user?.board;
  if (!isAdmin) return;

  const myUsername = S.user?.username;
  let filter = 'mine';
  let showHistory = false;
  let selectedRecipients = [myUsername]; // default: só o usuário logado

  const card = document.createElement('div');
  card.className = 'main-card';

  card.innerHTML = `
    <div class="main-card-hdr">
      <span class="main-card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        Pendências
      </span>
      <div style="display:flex;align-items:center;gap:.4rem">
        <button class="pend-tab active" data-filter="mine">Para mim</button>
        <button class="pend-tab" data-filter="all">Todas</button>
        <button class="nf-hist-btn" id="pendHistBtn" style="display:none">Histórico</button>
      </div>
    </div>
    <div class="main-card-body nf-card-body" id="pendCardBody"></div>
    <div class="nf-add-row pend-add-row" id="pendAddRow">
      <input type="text" class="nf-input" id="pendInput" placeholder="Nova pendência…" maxlength="200">
      <button class="nf-add-btn" id="pendAddBtn">+</button>
      <div class="pend-recipients">
        <span class="pend-rec-lbl">Para:</span>
        ${PENDENCIA_USERS.map(u => `<button class="pend-rec-btn${u.key === myUsername ? ' active' : ''}" data-key="${u.key}" style="--prc:${u.color}">${u.label}</button>`).join('')}
      </div>
    </div>`;

  container.appendChild(card);

  const body    = card.querySelector('#pendCardBody');
  const histBtn = card.querySelector('#pendHistBtn');
  const addRow  = card.querySelector('#pendAddRow');
  const input   = card.querySelector('#pendInput');
  const addBtn  = card.querySelector('#pendAddBtn');

  // Toggle recipient buttons
  card.querySelectorAll('.pend-rec-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (selectedRecipients.includes(key)) {
        if (selectedRecipients.length > 1) {
          selectedRecipients = selectedRecipients.filter(k => k !== key);
          btn.classList.remove('active');
        }
      } else {
        selectedRecipients.push(key);
        btn.classList.add('active');
      }
    });
  });

  function refresh() {
    const resolved = (S.pendencias || []).filter(x => x.resolved);
    if (resolved.length > 0) {
      histBtn.style.display = '';
      histBtn.textContent = showHistory ? '← Voltar' : `Histórico (${resolved.length})`;
    } else {
      histBtn.style.display = 'none';
      if (showHistory) showHistory = false;
    }
    if (showHistory) {
      _renderPendenciasHistory(body, refresh);
      addRow.style.display = 'none';
    } else {
      _renderPendenciasActive(body, filter, myUsername, refresh);
      addRow.style.display = '';
    }
  }

  refresh();

  histBtn.addEventListener('click', () => { showHistory = !showHistory; refresh(); });

  card.querySelectorAll('.pend-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('.pend-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.filter;
      refresh();
    });
  });

  async function addPendencia() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const item = await apiFetch('POST', '/api/pendencias', { text, assignedTo: selectedRecipients });
      S.pendencias = [...S.pendencias, item];
      refresh();
    } catch (e) { toast('Erro ao adicionar pendência', true); }
  }

  addBtn.addEventListener('click', addPendencia);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addPendencia(); });
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
  const isAdmin = !S.user?.board;
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

function _nfStatusChip(status) {
  if (status === 'autorizado') return '<span class="nf-status-chip nf-status-ok">✓ Autorizado</span>';
  if (status === 'recusado')   return '<span class="nf-status-chip nf-status-no">✗ Recusado</span>';
  return '<span class="nf-status-chip nf-status-pend">⏳ Pendente</span>';
}

function _renderNFActive(body, board, refresh) {
  const isAdmin = !S.user?.board;
  const isEscritorio = board === 'escritorio';
  const items = (S.nfItems || []).filter(x => x.board === board && !x.archived);
  if (!items.length) {
    body.innerHTML = '<div style="padding:.75rem 0;color:var(--muted);font-size:.8rem;text-align:center">Nenhum item ativo</div>';
    return;
  }
  body.innerHTML = items.map(item => {
    const statusChip = isEscritorio ? _nfStatusChip(item.status) : '';
    const adminActions = isAdmin && isEscritorio && item.status === 'pendente' ? `
      <button class="nf-auth-btn" data-id="${item.id}" data-action="autorizado" title="Autorizar">✓</button>
      <button class="nf-recus-btn" data-id="${item.id}" data-action="recusado" title="Recusar">✗</button>
    ` : '';
    const showChk = !isEscritorio || (isAdmin && item.status === 'autorizado');
    return `
    <div class="nf-item${isEscritorio ? ' nf-item-escritorio' : ''}" data-id="${item.id}">
      <label class="nf-chk-label" style="${!showChk ? 'pointer-events:none;opacity:.5' : ''}">
        ${showChk ? `<input type="checkbox" class="nf-chk" data-id="${item.id}">` : '<span style="width:16px;display:inline-block"></span>'}
        <span class="nf-item-text">${_escHtml(item.text)}</span>
      </label>
      <div class="nf-item-footer">
        ${statusChip}
        <span class="nf-item-meta">${_escHtml(item.addedBy)} · <span class="nf-date-tag">Criado ${_fmtNFDate(item.addedAt)}</span>${item.statusBy ? ` · ${_escHtml(item.statusBy)} ${_fmtNFDate(item.statusAt)}` : ''}</span>
      </div>
      ${adminActions}
      ${(!isEscritorio || isAdmin) ? `<button class="nf-del-btn" data-id="${item.id}" title="Arquivar">&times;</button>` : ''}
    </div>
  `}).join('');

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

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const action = btn.dataset.action;
      btn.disabled = true;
      const updated = await apiFetch('PATCH', `/api/nf-items/${id}`, { status: action }).catch(() => null);
      const item = S.nfItems.find(x => x.id === id);
      if (item && updated) Object.assign(item, updated);
      _renderNFActive(body, board, refresh);
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
  const isAdmin = !S.user?.board;
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
function renderContratoCard(container) {
  const isAdmin   = !S.user?.board;
  const userBoard = S.user?.board;
  const pad = n => String(n).padStart(2, '0');

  function calcVenc(admissao, dias) {
    if (!admissao || !dias) return null;
    const d = new Date(admissao + 'T00:00:00');
    d.setDate(d.getDate() + dias);
    return d;
  }

  function diasRestantes(venc) {
    if (!venc) return null;
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    return Math.round((venc - hoje) / 86400000);
  }

  function statusChip(dias) {
    if (dias === null) return '';
    if (dias < 0)  return `<span class="contrato-chip contrato-vencido">Vencido há ${Math.abs(dias)} dia${Math.abs(dias)!==1?'s':''}</span>`;
    if (dias === 0) return `<span class="contrato-chip contrato-hoje">Vence hoje!</span>`;
    if (dias <= 7)  return `<span class="contrato-chip contrato-urgente">${dias} dia${dias!==1?'s':''}</span>`;
    if (dias <= 15) return `<span class="contrato-chip contrato-alerta">${dias} dias</span>`;
    if (dias <= 30) return `<span class="contrato-chip contrato-atencao">${dias} dias</span>`;
    return `<span class="contrato-chip contrato-ok">${dias} dias</span>`;
  }

  function fmtDate(d) {
    return d ? `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}` : '—';
  }

  function buildRows(board) {
    const emps = S.employees.filter(e =>
      e.board === board && !e.inativo && e.admissao && (e.contrato1 || e.contrato2)
    );
    if (!emps.length) return '<div class="contrato-empty">Nenhum contrato cadastrado.</div>';

    return `<table class="contrato-table">
      <thead><tr>
        <th>Funcionário</th>
        <th>Admissão</th>
        <th>1º Contrato</th>
        <th></th>
        <th>2º Contrato</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${emps.map(e => {
          const venc1 = calcVenc(e.admissao, e.contrato1);
          const venc2 = e.contrato1 && e.contrato2 ? calcVenc(e.admissao, (e.contrato1 || 0) + (e.contrato2 || 0)) : null;
          const d1 = diasRestantes(venc1);
          const d2 = diasRestantes(venc2);
          return `<tr>
            <td class="contrato-nome">${e.apelido || e.name}</td>
            <td class="contrato-data">${e.admissao.split('-').reverse().join('/')}</td>
            <td class="contrato-data">${venc1 ? fmtDate(venc1) : '—'}</td>
            <td>${statusChip(d1)}</td>
            <td class="contrato-data">${venc2 ? fmtDate(venc2) : '—'}</td>
            <td>${statusChip(d2)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  const boardsComContrato = NF_STORES.filter(b =>
    S.employees.some(e => e.board === b && !e.inativo && e.admissao && (e.contrato1 || e.contrato2))
  );

  let activeBoard = isAdmin ? (boardsComContrato[0] || NF_STORES[0]) : userBoard;

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
          <line x1="9" y1="13" x2="15" y2="13"/>
          <line x1="9" y1="17" x2="13" y2="17"/>
        </svg>
        Contratos de Experiência
      </span>
      ${!isAdmin ? `<span class="main-card-sub" style="color:${BOARDS[userBoard]?.color}">${BOARDS[userBoard]?.label || ''}</span>` : ''}
    </div>
    ${tabsHtml}
    <div class="contrato-card-body" id="contratoCardBody"></div>
  `;
  container.appendChild(card);

  const body = card.querySelector('#contratoCardBody');

  function render() {
    body.innerHTML = buildRows(activeBoard);
  }

  render();

  if (isAdmin) {
    card.querySelectorAll('.nf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeBoard = tab.dataset.board;
        card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
        render();
      });
    });
  }
}

function renderCaixaCard(container) {
  const isAdmin  = !S.user?.board;
  const userBoard = S.user?.board;
  let activeBoard = isAdmin ? NF_STORES[0] : userBoard;

  const syncSvg   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
  const expandSvg  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  const sangriaSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;

  function tabsMarkup(activeB) {
    if (!isAdmin) return '';
    return `<div class="nf-tabs">${NF_STORES.map(b => `
      <button class="nf-tab${b === activeB ? ' active' : ''}" data-board="${b}"
        style="--nf-tab-color:${BOARDS[b]?.color || '#8B949E'}">${BOARDS[b]?.label || b}
      </button>`).join('')}</div>`;
  }

  // ── Mini card ──────────────────────────────────────────────────────────────
  const card = document.createElement('div');
  card.className = 'main-card';
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
      <div style="display:flex;gap:.3rem;margin-left:auto">
        <button class="caixa-sync-btn" id="caixaSyncBtn" title="Sincronizar com Microvix">${syncSvg} Microvix</button>
        ${isAdmin ? `<button class="caixa-sync-btn" id="caixaSangriaBtn" title="Ver todas as sangrias">${sangriaSvg} Sangrias</button>` : ''}
        <button class="caixa-expand-btn" id="caixaExpandBtn" title="Expandir">${expandSvg}</button>
      </div>
    </div>
    ${tabsMarkup(activeBoard)}
    <div class="main-card-body caixa-card-body" id="caixaCardBody"></div>`;
  container.appendChild(card);

  // ── Fullscreen overlay ─────────────────────────────────────────────────────
  const ovl = document.createElement('div');
  ovl.className = 'caixa-overlay';
  ovl.innerHTML = `
    <div class="caixa-overlay-panel">
      <div class="caixa-overlay-hdr">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
        <span class="caixa-overlay-title">Fechamento de Caixa${!isAdmin ? ` — ${BOARDS[userBoard]?.label || ''}` : ''}</span>
        <button class="caixa-sync-btn" id="caixaSyncBtnOvl" title="Sincronizar com Microvix">${syncSvg} Microvix</button>
        <button class="caixa-ovl-close" id="caixaOvlClose" title="Fechar">✕</button>
      </div>
      <div id="caixaOvlTabs"></div>
      <div class="caixa-ovl-body" id="caixaOvlBody"></div>
    </div>`;
  document.body.appendChild(ovl);

  // ── Sangrias overlay ──────────────────────────────────────────────────────
  const sgOvl = document.createElement('div');
  sgOvl.className = 'caixa-overlay';
  sgOvl.innerHTML = `
    <div class="caixa-overlay-panel">
      <div class="caixa-overlay-hdr">
        ${sangriaSvg.replace('width="12" height="12"','width="15" height="15"').replace('flex-shrink:0','')}
        <span class="caixa-overlay-title">Sangrias — <span id="sgOvlPeriodo"></span></span>
        <button class="caixa-ovl-close" id="sgOvlClose">✕</button>
      </div>
      <div class="caixa-ovl-body" id="sgOvlBody"></div>
    </div>`;
  document.body.appendChild(sgOvl);

  const body    = card.querySelector('#caixaCardBody');
  const ovlBody = ovl.querySelector('#caixaOvlBody');
  const ovlTabs = ovl.querySelector('#caixaOvlTabs');

  // ── Shared render ──────────────────────────────────────────────────────────
  async function fetchAndRender(targetBody, board, onRefresh) {
    targetBody.innerHTML = '<div style="padding:.75rem .85rem;color:var(--muted);font-size:.8rem">Carregando…</div>';
    let data = {};
    try {
      data = await apiFetch('GET', `/api/caixa/${S.year}/${S.month}/${board}`);
    } catch(e) { targetBody.innerHTML = '<div style="padding:.75rem;color:var(--down);font-size:.8rem">Erro ao carregar</div>'; return; }

    // Busca saldo de fechamento do mês anterior para carry-over
    const prevYear  = S.month === 1 ? S.year - 1 : S.year;
    const prevMonth = S.month === 1 ? 12 : S.month - 1;
    let saldoAcum = 0;
    try {
      const prevData  = await apiFetch('GET', `/api/caixa/${prevYear}/${prevMonth}/${board}`);
      const prevDays  = new Date(prevYear, prevMonth, 0).getDate();
      for (let d = 1; d <= prevDays; d++) {
        const e = prevData[d] || {};
        saldoAcum += (e.caixa ?? 0) - (e.sangria ?? 0) - (e.deposito ?? 0);
      }
    } catch(_) { /* sem carry-over */ }

    const daysInMonth = new Date(S.year, S.month, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === S.year && (today.getMonth()+1) === S.month;
    const todayDay = isCurrentMonth ? today.getDate() : -1;
    const DAY_NAMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const pad = n => String(n).padStart(2,'0');
    const fmtCur = v => (v === 0 || v === undefined || v === null) ? '—' : `R$ ${Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

    let totalCaixa = 0, totalSangria = 0, totalDeposito = 0;
    const rows = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dt    = new Date(S.year, S.month - 1, d);
      const entry = data[d] || {};
      const caixa    = entry.caixa    ?? 0;
      const sangria  = entry.sangria  ?? 0;
      const deposito = entry.deposito ?? 0;
      saldoAcum += caixa - sangria - deposito;
      totalCaixa += caixa; totalSangria += sangria; totalDeposito += deposito;
      rows.push({ d, dow: DAY_NAMES[dt.getDay()], caixa, sangria, deposito, saldo: saldoAcum });
    }
    const totalSaldo = saldoAcum; // saldo acumulado incluindo carry-over do mês anterior
    const sc = s => s > 0 ? 'pos' : s < 0 ? 'neg' : 'zero';
    const hasData = r => r.caixa > 0 || r.sangria > 0 || r.deposito > 0;
    const dash = `<span style="color:var(--muted)">—</span>`;

    targetBody.innerHTML = `
      <div class="caixa-table-wrap">
        <table class="caixa-table">
          <thead><tr><th>Data</th><th>Dinheiro</th><th>Sangria</th><th>Depósito</th><th>Saldo</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr class="${r.d === todayDay ? 'caixa-today' : ''}" data-day="${r.d}">
              <td class="caixa-td-date">${pad(r.d)}/${pad(S.month)} <span style="color:var(--muted);font-size:.72rem">${r.dow}</span></td>
              <td class="caixa-td-val">${r.caixa > 0 ? fmtCur(r.caixa) : dash}</td>
              <td class="caixa-td-val">${r.sangria > 0 ? fmtCur(r.sangria) : dash}</td>
              <td class="caixa-td-val caixa-deposito-cell" data-field="deposito" data-day="${r.d}" style="cursor:pointer">${r.deposito > 0 ? fmtCur(r.deposito) : dash}</td>
              <td class="caixa-td-saldo ${!hasData(r) ? 'zero' : sc(r.saldo)}">${!hasData(r) ? dash : fmtCur(r.saldo)}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr class="caixa-total-row">
            <td>Total</td>
            <td>${fmtCur(totalCaixa)}</td>
            <td>${fmtCur(totalSangria)}</td>
            <td>${fmtCur(totalDeposito)}</td>
            <td class="caixa-total-saldo ${sc(totalSaldo)}">${fmtCur(totalSaldo)}</td>
          </tr></tfoot>
        </table>
      </div>`;

    if (todayDay > 0) {
      const todayRow = targetBody.querySelector(`tr[data-day="${todayDay}"]`);
      if (todayRow) setTimeout(() => {
        const wrap = todayRow.closest('.caixa-table-wrap');
        if (wrap) wrap.scrollTop = todayRow.offsetTop - wrap.clientHeight / 2 + todayRow.clientHeight / 2;
      }, 50);
    }

    targetBody.querySelectorAll('.caixa-deposito-cell').forEach(cell => {
      cell.addEventListener('click', () => _caixaStartEdit(cell, data, board, onRefresh));
    });
  }

  async function _caixaStartEdit(cell, data, board, refreshFn) {
    if (cell.querySelector('input')) return;
    const field = cell.dataset.field;
    const day   = parseInt(cell.dataset.day);
    const cur   = (data[day] || {})[field] ?? 0;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'caixa-cell-input';
    inp.value = cur > 0 ? cur : ''; inp.placeholder = '0,00';
    cell.innerHTML = ''; cell.appendChild(inp);
    inp.focus(); inp.select();
    const commit = async () => {
      const val = parseFloat(inp.value.replace(',','.')) || 0;
      try { await apiFetch('PUT', `/api/caixa/${S.year}/${S.month}/${board}/${day}`, { [field]: val }); }
      catch(e) { toast('Erro: ' + e.message, true); }
      await refreshFn();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') refreshFn(); });
  }

  // ── Refresh functions ──────────────────────────────────────────────────────
  function refresh()    { return fetchAndRender(body,    activeBoard, refresh); }
  function refreshOvl() { return fetchAndRender(ovlBody, activeBoard, () => { refreshOvl(); refresh(); }); }

  // ── Sync helper ────────────────────────────────────────────────────────────
  async function doSync(btn, afterFn) {
    btn.disabled = true; btn.innerHTML = 'Sincronizando…';
    try {
      const result = await apiFetch('POST', `/api/caixa-microvix/${activeBoard}/${S.year}/${S.month}`);
      if (result.errors) {
        const errs = Object.entries(result.errors).map(([k,v]) => `${k}: ${v}`).join('; ');
        toast(`Sincronizado com erros — ${errs}`, true);
      } else { toast('Microvix sincronizado'); }
      await afterFn();
    } catch(e) { toast('Erro ao sincronizar: ' + e.message, true); }
    finally { btn.disabled = false; btn.innerHTML = `${syncSvg} Microvix`; }
  }

  // ── Card event handlers ────────────────────────────────────────────────────
  refresh();

  const syncBtn = card.querySelector('#caixaSyncBtn');
  if (syncBtn) syncBtn.addEventListener('click', () => doSync(syncBtn, refresh));

  if (isAdmin) {
    card.querySelectorAll('.nf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeBoard = tab.dataset.board;
        card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
        refresh();
      });
    });
  }

  // ── Expand / overlay handlers ──────────────────────────────────────────────
  card.querySelector('#caixaExpandBtn').addEventListener('click', () => {
    ovlTabs.innerHTML = tabsMarkup(activeBoard);
    ovl.classList.add('active');
    document.body.style.overflow = 'hidden';
    refreshOvl();

    const syncOvl = ovl.querySelector('#caixaSyncBtnOvl');
    if (syncOvl) syncOvl.addEventListener('click', () => doSync(syncOvl, () => { refreshOvl(); refresh(); }));

    if (isAdmin) {
      ovlTabs.querySelectorAll('.nf-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          activeBoard = tab.dataset.board;
          ovlTabs.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t === tab));
          card.querySelectorAll('.nf-tab').forEach(t => t.classList.toggle('active', t.dataset.board === activeBoard));
          refreshOvl();
        });
      });
    }
  });

  function closeOvl() { ovl.classList.remove('active'); document.body.style.overflow = ''; }
  ovl.querySelector('#caixaOvlClose').addEventListener('click', closeOvl);
  ovl.addEventListener('click', e => { if (e.target === ovl) closeOvl(); });

  // ── Sangrias button ────────────────────────────────────────────────────────
  if (isAdmin) {
    const sgBtn = card.querySelector('#caixaSangriaBtn');
    if (sgBtn) {
      sgBtn.addEventListener('click', async () => {
        const sgBody   = sgOvl.querySelector('#sgOvlBody');
        const sgPeriodo = sgOvl.querySelector('#sgOvlPeriodo');
        const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        sgPeriodo.textContent = `${meses[S.month-1]}/${S.year}`;
        sgBody.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:.85rem">Carregando…</div>';
        sgOvl.classList.add('active');
        document.body.style.overflow = 'hidden';

        try {
          const rows = await apiFetch('GET', `/api/caixa-sangrias/${S.year}/${S.month}`);
          if (!rows.length) {
            sgBody.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:.85rem">Nenhuma sangria no período.</div>';
            return;
          }
          const fmtCur = v => `R$ ${Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
          const total  = rows.reduce((s, r) => s + r.valor, 0);
          sgBody.innerHTML = `
            <div class="caixa-table-wrap" style="max-height:calc(92vh - 110px)">
              <table class="caixa-table">
                <thead><tr>
                  <th style="text-align:left">Loja</th>
                  <th style="text-align:left">Data</th>
                  <th style="text-align:left">Descrição</th>
                  <th>Valor</th>
                </tr></thead>
                <tbody>${rows.map(r => `
                  <tr>
                    <td style="padding:.38rem .6rem;font-size:.8rem;white-space:nowrap">
                      <span style="color:${BOARDS[r.board]?.color||'var(--muted)'};font-weight:600">${r.loja}</span>
                    </td>
                    <td style="padding:.38rem .6rem;font-size:.8rem;white-space:nowrap;color:var(--muted)">${r.data}</td>
                    <td style="padding:.38rem .6rem;font-size:.8rem">${r.desc || '—'}</td>
                    <td class="caixa-td-val" style="color:#F85149;font-weight:600">${fmtCur(r.valor)}</td>
                  </tr>`).join('')}
                </tbody>
                <tfoot><tr class="caixa-total-row">
                  <td colspan="3">Total</td>
                  <td style="text-align:right;color:#F85149">${fmtCur(total)}</td>
                </tr></tfoot>
              </table>
            </div>`;
        } catch(e) {
          sgBody.innerHTML = `<div style="padding:1rem;color:var(--down);font-size:.85rem">Erro: ${e.message}</div>`;
        }
      });
    }

    function closeSgOvl() { sgOvl.classList.remove('active'); document.body.style.overflow = ''; }
    sgOvl.querySelector('#sgOvlClose').addEventListener('click', closeSgOvl);
    sgOvl.addEventListener('click', e => { if (e.target === sgOvl) closeSgOvl(); });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (ovl.classList.contains('active'))   closeOvl();
      if (sgOvl.classList.contains('active')) { sgOvl.classList.remove('active'); document.body.style.overflow = ''; }
    }
  });
}

function renderNFCard(container) {
  const isAdmin = !S.user?.board;
  const userBoard = S.user?.board;
  let activeBoard = isAdmin ? NF_STORES[0] : userBoard;
  let showHistory = false;

  const card = document.createElement('div');
  card.className = 'main-card';

  const NF_ADMIN_TABS = [...NF_STORES, 'escritorio'];
  const tabsHtml = isAdmin ? `
    <div class="nf-tabs">
      ${NF_ADMIN_TABS.map(b => {
        const pending = b === 'escritorio' ? (S.nfItems || []).filter(x => x.board === 'escritorio' && !x.archived && x.status === 'pendente').length : 0;
        return `<button class="nf-tab${b === activeBoard ? ' active' : ''}" data-board="${b}"
          style="--nf-tab-color:${BOARDS[b]?.color || '#8B949E'}">
          ${BOARDS[b]?.label || b}${pending ? ` <span class="nf-tab-badge">${pending}</span>` : ''}
        </button>`;
      }).join('')}
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
        addRow.style.display = activeBoard === 'escritorio' ? 'none' : '';
        refresh();
      });
    });
    if (activeBoard === 'escritorio') addRow.style.display = 'none';
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
  const isAdmin   = !S.user?.board;
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
  const isAdmin  = !S.user?.board;
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

function _boletaCompraConstraints(dataEntregue) {
  if (!dataEntregue) return { min: '', max: '' };
  const ent = new Date(dataEntregue + 'T12:00:00');
  const min = new Date(ent); min.setDate(min.getDate() - 90);
  return { min: min.toISOString().slice(0, 10), max: dataEntregue };
}

function _boletaFormHtml(boleta, isAdmin, userBoard) {
  const v = (field) => boleta?.[field] || '';
  const board = boleta?.board || (isAdmin ? NF_STORES_BOL[0] : userBoard);
  const cc = _boletaCompraConstraints(v('dataEntregue'));
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
        <div class="bol-fg"><label>Data da Compra *</label><input type="date" name="dataCompra" class="bol-input" value="${v('dataCompra')}" min="${cc.min}" max="${cc.max}" required></div>
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

  const dataEntregueInput = body.querySelector('[name="dataEntregue"]');
  const dataCompraInput   = body.querySelector('[name="dataCompra"]');
  if (dataEntregueInput && dataCompraInput) {
    dataEntregueInput.addEventListener('change', () => {
      const cc = _boletaCompraConstraints(dataEntregueInput.value);
      dataCompraInput.min = cc.min;
      dataCompraInput.max = cc.max;
      if (dataCompraInput.value && cc.min && dataCompraInput.value < cc.min) dataCompraInput.value = '';
      if (dataCompraInput.value && cc.max && dataCompraInput.value > cc.max) dataCompraInput.value = '';
    });
  }

  body.querySelector('#bolFormSaveBtn').addEventListener('click', async () => {
    const data = {};
    body.querySelectorAll('[name]').forEach(el => { data[el.name] = el.value.trim(); });
    if (!data.nome) { toast('Nome é obrigatório', true); return; }
    if (!data.produto) { toast('Produto é obrigatório', true); return; }
    if (!data.dataCompra) { toast('Data da Compra é obrigatória', true); return; }
    if (!data.dataEntregue) { toast('Data entregue é obrigatória', true); return; }
    if (data.dataCompra && data.dataEntregue) {
      const diffDays = Math.round((new Date(data.dataEntregue + 'T12:00:00') - new Date(data.dataCompra + 'T12:00:00')) / 86400000);
      if (diffDays < 0) { toast('Data da compra não pode ser posterior à data de entrega', true); return; }
      if (diffDays > 90) { toast('Data da compra deve ser no máximo 90 dias antes da entrega ao cliente', true); return; }
    }
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

// ── Loja em Ação ──────────────────────────────────────────────────────────

const EMBALAGENS_ITEMS = [
  'Sacola de Papel P', 'Sacola de Papel M', 'Sacola de Papel G',
  'Sacola TNT', 'Sacola de Plástico',
  'Seda', 'Etiqueta Adesivo de Presente',
];
const MATERIAIS_ITEMS = [
  'Grampo', 'Grampeador', 'Cola', 'Fita larga (Durex)', 'Lápis', 'Caneta',
  'Bloco de vale', 'Bloco de recibo', 'Cartão de Visita', 'Borracha', 'Tesoura',
  'Extrator de grampo', 'Régua', 'Almofada de carimbo', 'Clips',
  'Bobinas imp. fiscal', 'Lista da vez', 'Fechamento diário', 'Envelope caixa',
  'Alarme', 'Carimbo CNPJ', 'Adesivo presente', 'Bloco de vendedor',
  'Bloco de trocas', 'Bloco de conserto', 'RIBOW (tinta de tag)',
  'Papel de cadastro', 'Bloco de reserva', 'Calculadora', 'Apontador',
  'Bobinas PagSeguro', 'Marca texto', 'Etiqueta para tag', 'Munição',
];
const REQ_STATUS = {
  'pendente':     { label: 'Pendente',     color: '#8B949E' },
  'em-separacao': { label: 'Em Separação', color: '#E3B341' },
  'enviado':      { label: 'Enviado',      color: '#58A6FF' },
  'recebido':     { label: 'Recebido',     color: '#3FB950' },
};

function _reqStatusBadge(status) {
  const s = REQ_STATUS[status] || REQ_STATUS['pendente'];
  return `<span class="req-status-badge" style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}44">${s.label}</span>`;
}

function _updateLojaAcaoBadge() {
  const btn = document.getElementById('lojaAcaoBtn');
  if (!btn || S.user?.board) return; // only for admin
  const count = (S.requisicoes || []).filter(x => x.status === 'pendente' || x.status === 'em-separacao').length;
  let badge = btn.querySelector('.req-badge');
  if (count > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'req-badge'; btn.appendChild(badge); }
    badge.textContent = count;
  } else if (badge) { badge.remove(); }
}

function openLojaAcaoModal() {
  document.getElementById('lojaAcaoOverlay').classList.remove('hidden');
  _renderLojaAcaoModal();
}
function closeLojaAcaoModal() {
  document.getElementById('lojaAcaoOverlay').classList.add('hidden');
}
function _renderLojaAcaoModal() {
  const body = document.getElementById('lojaAcaoBody');
  if (!S.user?.board) _renderReqAdminView(body);
  else _renderReqLojaView(body);
}

function _renderReqLojaView(body) {
  const board = S.user.board;
  let showForm = true;
  function render() {
    if (showForm) {
      body.innerHTML = _reqFormHtml(board);
      body.querySelector('#reqHistBtn').addEventListener('click', () => { showForm = false; render(); });
      _initReqForm(body, board, () => { showForm = false; render(); });
    } else {
      _renderReqLojaHistory(body, board, () => { showForm = true; render(); });
    }
  }
  render();
}

function _reqFormHtml(board) {
  return `<div class="req-form-wrap">
    <div class="req-form-top">
      <h3 class="req-form-title">Nova Requisição — ${BOARDS[board]?.label || board}</h3>
      <button class="req-link-btn" id="reqHistBtn">Ver histórico →</button>
    </div>
    <div class="req-section">
      <div class="req-sec-hdr">📦 Embalagens</div>
      <div class="req-embal-cards">
        ${EMBALAGENS_ITEMS.map(item => `
          <div class="req-embal-card">
            <span class="req-embal-nome">${_escHtml(item)}</span>
            <div class="req-embal-counter">
              <button type="button" class="req-cnt-btn req-cnt-minus" data-item="${_escHtml(item)}">−</button>
              <input type="number" class="req-qty" data-item="${_escHtml(item)}" min="0" max="9999" value="0">
              <button type="button" class="req-cnt-btn req-cnt-plus" data-item="${_escHtml(item)}">+</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div class="req-section">
      <div class="req-sec-hdr">🗂 Materiais — clique para selecionar o que precisa</div>
      <div class="req-mat-grid">
        ${MATERIAIS_ITEMS.map(item => `<button type="button" class="req-mat-btn" data-item="${_escHtml(item)}">${_escHtml(item)}</button>`).join('')}
      </div>
    </div>
    <div class="req-section">
      <div class="req-sec-hdr">Observação (opcional)</div>
      <textarea class="req-obs" id="reqObs" placeholder="Ex: urgente, falta desde semana passada…" maxlength="500" rows="3"></textarea>
    </div>
    <div class="req-form-actions">
      <button class="req-submit-btn" id="reqSubmitBtn">Enviar Requisição</button>
    </div>
  </div>`;
}

function _initReqForm(body, board, onSuccess) {
  body.querySelectorAll('.req-cnt-plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = body.querySelector(`.req-qty[data-item="${btn.dataset.item}"]`);
      input.value = (parseInt(input.value) || 0) + 1;
      input.closest('.req-embal-card').classList.toggle('req-embal-active', parseInt(input.value) > 0);
    });
  });
  body.querySelectorAll('.req-cnt-minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = body.querySelector(`.req-qty[data-item="${btn.dataset.item}"]`);
      const v = Math.max(0, (parseInt(input.value) || 0) - 1);
      input.value = v;
      input.closest('.req-embal-card').classList.toggle('req-embal-active', v > 0);
    });
  });
  body.querySelectorAll('.req-qty').forEach(input => {
    input.addEventListener('input', () => {
      input.closest('.req-embal-card').classList.toggle('req-embal-active', (parseInt(input.value) || 0) > 0);
    });
  });
  body.querySelectorAll('.req-mat-btn').forEach(btn =>
    btn.addEventListener('click', () => btn.classList.toggle('active'))
  );
  body.querySelector('#reqSubmitBtn').addEventListener('click', async () => {
    const embalagens = {};
    body.querySelectorAll('.req-qty').forEach(input => {
      const qty = parseInt(input.value) || 0;
      if (qty > 0) embalagens[input.dataset.item] = qty;
    });
    const materiais = [...body.querySelectorAll('.req-mat-btn.active')].map(b => b.dataset.item);
    if (!Object.keys(embalagens).length && !materiais.length) {
      toast('Selecione ao menos um item', true); return;
    }
    const observacao = body.querySelector('#reqObs').value.trim();
    const btn = body.querySelector('#reqSubmitBtn');
    btn.disabled = true;
    try {
      const req = await apiFetch('POST', '/api/requisicoes', { embalagens, materiais, observacao });
      S.requisicoes = [...(S.requisicoes || []), req];
      _updateLojaAcaoBadge();
      toast('Requisição enviada ✓');
      onSuccess();
    } catch(e) { toast('Erro: '+e.message, true); btn.disabled = false; }
  });
}

function _renderReqLojaHistory(body, board, onBack) {
  const items = (S.requisicoes || []).filter(x => x.board === board)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  body.innerHTML = `<div class="req-form-wrap">
    <div class="req-form-top">
      <h3 class="req-form-title">Histórico de Requisições</h3>
      <button class="req-link-btn" id="reqBackBtn">← Nova requisição</button>
    </div>
    ${!items.length
      ? '<div class="req-empty">Nenhuma requisição enviada ainda</div>'
      : items.map(req => `
        <div class="req-hist-card">
          <div class="req-hist-card-top">
            <span class="req-hist-date">${new Date(req.createdAt).toLocaleDateString('pt-BR')}</span>
            ${_reqStatusBadge(req.status)}
          </div>
          ${Object.keys(req.embalagens||{}).length ? `<div class="req-hist-row"><b>Embalagens:</b> ${Object.entries(req.embalagens).map(([k,v])=>`${k}: <b>${v}</b>`).join(', ')}</div>` : ''}
          ${(req.materiais||[]).length ? `<div class="req-hist-row"><b>Materiais:</b> ${req.materiais.join(', ')}</div>` : ''}
          ${req.observacao ? `<div class="req-hist-obs">"${_escHtml(req.observacao)}"</div>` : ''}
        </div>`).join('')}
  </div>`;
  body.querySelector('#reqBackBtn').addEventListener('click', onBack);
}

function _renderReqAdminView(body) {
  let filterStatus = 'pendente';
  let filterBoard  = '';
  const STORE_BOARDS = ['delrey','minas','contagem','estacao','tommy','lez'];
  const NEXT_STATUS = {
    'pendente':     [['em-separacao','Em Separação'],['enviado','Enviado']],
    'em-separacao': [['enviado','Enviado']],
    'enviado':      [['recebido','Recebido']],
    'recebido':     [],
  };

  function render() {
    let items = (S.requisicoes || []);
    if (filterStatus !== 'all') items = items.filter(x => x.status === filterStatus);
    if (filterBoard) items = items.filter(x => x.board === filterBoard);
    items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    body.innerHTML = `<div class="req-admin-wrap">
      <div class="req-admin-filters">
        <div class="req-status-tabs">
          ${[['pendente','Pendente'],['em-separacao','Em Separação'],['enviado','Enviado'],['recebido','Recebido'],['all','Todas']].map(([s,l]) =>
            `<button class="req-stab${filterStatus===s?' active':''}" data-s="${s}">${l}</button>`).join('')}
        </div>
        <div class="req-board-chips">
          <button class="req-board-chip${filterBoard===''?' active':''}" data-b="" style="--rbc:#8B949E">Todas</button>
          ${STORE_BOARDS.map(b => `<button class="req-board-chip${filterBoard===b?' active':''}" data-b="${b}" style="--rbc:${BOARDS[b]?.color||'#8B949E'}">${BOARDS[b]?.label||b}</button>`).join('')}
        </div>
      </div>
      <div class="req-admin-list">
        ${!items.length
          ? '<div class="req-empty">Nenhuma requisição encontrada</div>'
          : items.map(req => {
              const sc = BOARDS[req.board]?.color || '#8B949E';
              const sl = BOARDS[req.board]?.label  || req.board;
              const dt = new Date(req.createdAt).toLocaleDateString('pt-BR');
              const embalHtml = Object.entries(req.embalagens||{}).map(([k,v]) =>
                `<span class="req-embal-tag">${k}: <b>${v}</b></span>`).join('');
              const matHtml = (req.materiais||[]).map(m =>
                `<span class="req-mat-tag">${m}</span>`).join('');
              const actions = (NEXT_STATUS[req.status]||[]).map(([s,l]) =>
                `<button class="req-action-btn" data-id="${req.id}" data-status="${s}">${l}</button>`).join('');
              return `<div class="req-admin-item">
                <div class="req-admin-item-hdr">
                  <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
                    <span style="font-weight:700;color:${sc}">${sl}</span>
                    <span style="color:var(--muted);font-size:.78rem">${dt} · ${_escHtml(req.createdBy)}</span>
                    ${_reqStatusBadge(req.status)}
                  </div>
                  <div style="display:flex;gap:.4rem;align-items:center">
                    ${actions}
                    <button class="req-del-btn" data-id="${req.id}" title="Excluir">✕</button>
                  </div>
                </div>
                ${embalHtml ? `<div class="req-admin-tags">${embalHtml}</div>` : ''}
                ${matHtml   ? `<div class="req-admin-tags req-mat-wrap">${matHtml}</div>` : ''}
                ${req.observacao ? `<div class="req-admin-obs">"${_escHtml(req.observacao)}"</div>` : ''}
                ${req.updatedAt ? `<div class="req-admin-upd">Atualizado ${new Date(req.updatedAt).toLocaleDateString('pt-BR')} por ${_escHtml(req.updatedBy||'—')}</div>` : ''}
              </div>`;
            }).join('')}
      </div>
    </div>`;

    body.querySelectorAll('.req-stab').forEach(btn =>
      btn.addEventListener('click', () => { filterStatus = btn.dataset.s; render(); }));
    body.querySelectorAll('.req-board-chip').forEach(btn =>
      btn.addEventListener('click', () => { filterBoard = btn.dataset.b; render(); }));

    body.querySelectorAll('.req-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id); btn.disabled = true;
        try {
          const upd = await apiFetch('PATCH', `/api/requisicoes/${id}`, { status: btn.dataset.status });
          const i = S.requisicoes.findIndex(x => x.id === id);
          if (i >= 0) S.requisicoes[i] = upd;
          _updateLojaAcaoBadge(); render();
        } catch(e) { toast('Erro: '+e.message, true); btn.disabled = false; }
      });
    });
    body.querySelectorAll('.req-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Excluir esta requisição?')) return;
        const id = parseInt(btn.dataset.id);
        await apiFetch('DELETE', `/api/requisicoes/${id}`).catch(()=>{});
        S.requisicoes = S.requisicoes.filter(x => x.id !== id);
        _updateLojaAcaoBadge(); render();
      });
    });
  }
  render();
}

function initLojaAcaoModal() {
  document.getElementById('lojaAcaoBtn').addEventListener('click', openLojaAcaoModal);
  document.getElementById('lojaAcaoClose').addEventListener('click', closeLojaAcaoModal);
  document.getElementById('lojaAcaoOverlay').addEventListener('click', e => {
    if (e.target.id === 'lojaAcaoOverlay') closeLojaAcaoModal();
  });
}

function initBoletasModal() {
  document.getElementById('boletasBtn').addEventListener('click', () => openBoletasModal('list'));
  document.getElementById('boletasClose').addEventListener('click', closeBoletasModal);
  document.getElementById('boletasOverlay').addEventListener('click', e => {
    if (e.target.id === 'boletasOverlay') closeBoletasModal();
  });
}

// ── Users Management ───────────────────────────────────────────────────────
const BOARD_LABELS = {
  '': 'Admin', escritorio: 'Escritório', delrey: 'Del Rey', minas: 'Minas',
  contagem: 'Contagem', estacao: 'Estação', tommy: 'Tommy', lez: 'Lez a Lez'
};

async function _loadUsersList() {
  const list = document.getElementById('usersList');
  list.innerHTML = '<div class="users-loading">Carregando…</div>';
  try {
    const users = await apiFetch('GET', '/api/users');
    if (!users.length) { list.innerHTML = '<div class="users-loading">Nenhum usuário</div>'; return; }
    list.innerHTML = `
      <table class="users-table">
        <thead><tr>
          <th class="users-th">Usuário</th>
          <th class="users-th">Nome</th>
          <th class="users-th">Board</th>
          <th class="users-th">Nova Senha</th>
          <th class="users-th"></th>
        </tr></thead>
        <tbody>
        ${users.map(u => `
          <tr class="users-tr" data-user="${u.username}">
            <td class="users-td users-td-user">${u.username}</td>
            <td class="users-td"><input class="users-input users-inline-input" data-field="label" value="${u.label}" placeholder="Nome"></td>
            <td class="users-td">
              <select class="users-input users-select users-inline-input" data-field="board">
                ${Object.entries(BOARD_LABELS).map(([v,l]) => `<option value="${v}"${(u.board==null&&v==='')||u.board===v?' selected':''}>${l}</option>`).join('')}
              </select>
            </td>
            <td class="users-td"><input class="users-input users-inline-input" data-field="password" type="text" placeholder="••••••" autocomplete="off"></td>
            <td class="users-td users-td-actions">
              <button class="users-save-btn" data-user="${u.username}">Salvar</button>
              <button class="users-del-btn" data-user="${u.username}">Excluir</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    list.querySelectorAll('.users-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = list.querySelector(`tr[data-user="${btn.dataset.user}"]`);
        const body = {};
        row.querySelectorAll('[data-field]').forEach(el => {
          if (el.dataset.field === 'board') { body.board = el.value.trim() || null; }
          else if (el.value.trim()) body[el.dataset.field] = el.value.trim();
        });
        try {
          await apiFetch('PUT', `/api/users/${btn.dataset.user}`, body);
          btn.textContent = '✓';
          setTimeout(() => btn.textContent = 'Salvar', 1500);
        } catch (e) { alert('Erro: ' + e.message); }
      });
    });

    list.querySelectorAll('.users-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Excluir usuário "${btn.dataset.user}"?`)) return;
        try {
          await apiFetch('DELETE', `/api/users/${btn.dataset.user}`);
          _loadUsersList();
        } catch (e) { alert('Erro: ' + e.message); }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="users-loading">Erro: ${e.message}</div>`;
  }
}

function openUsersModal() {
  document.getElementById('usersOverlay').classList.remove('hidden');
  _loadUsersList();
  document.getElementById('newUsername').focus();
}

function closeUsersModal() {
  document.getElementById('usersOverlay').classList.add('hidden');
}

function initUsersModal() {
  document.getElementById('usersBtn').addEventListener('click', openUsersModal);
  document.getElementById('usersClose').addEventListener('click', closeUsersModal);
  document.getElementById('usersOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('usersOverlay')) closeUsersModal();
  });
  document.getElementById('addUserBtn').addEventListener('click', async () => {
    const username = document.getElementById('newUsername').value.trim();
    const label    = document.getElementById('newLabel').value.trim();
    const board    = document.getElementById('newBoard').value;
    const password = document.getElementById('newPassword').value.trim();
    const errEl    = document.getElementById('usersFormError');
    errEl.classList.add('hidden');
    if (!username || !password) { errEl.textContent = 'Usuário e senha são obrigatórios'; errEl.classList.remove('hidden'); return; }
    try {
      await apiFetch('POST', '/api/users', { username, label, board, password });
      document.getElementById('newUsername').value = '';
      document.getElementById('newLabel').value = '';
      document.getElementById('newPassword').value = '';
      _loadUsersList();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
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
  initLojaAcaoModal();
  initBoletasModal();
  initUsersModal();
  document.getElementById('logoutBtn').addEventListener('click', logout);


document.getElementById('btnPrev').addEventListener('click', () => navigate(-1));
  document.getElementById('btnNext').addEventListener('click', () => navigate(1));
  checkAuth();
}

init();
