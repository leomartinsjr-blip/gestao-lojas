'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const BOARDS_INFO = {
  delrey:   { label: 'DEL REY',   color: '#58A6FF' },
  minas:    { label: 'MINAS',     color: '#3FB950' },
  contagem: { label: 'CONTAGEM',  color: '#D29922' },
  estacao:  { label: 'ESTAÇÃO',   color: '#F85149' },
  tommy:    { label: 'TOMMY',     color: '#22D3EE' },
  lez:      { label: 'LEZ A LEZ', color: '#F472B6' },
};
const STORE_BOARDS = Object.keys(BOARDS_INFO);

const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const DEFAULT_FAIXAS = [
  { nome: 'S/META',   minPct: 0    },
  { nome: '1ª META',  minPct: 0.9  },
  { nome: '2ª META',  minPct: 1.0  },
  { nome: 'SUPER',    minPct: 1.2  },
];

// ── State ──────────────────────────────────────────────────────────────────
let FP = {
  year: 0, month: 0,
  board: '',
  employees: [],
  vsales: {},
  folha: {},       // db.folhas[mk], keyed by board → { diasUteis, domingosFeriados, entries: { empId: {...} } }
  folhaConfig: {}, // db.folhaConfig, keyed by board
  activeEmpId: null,
  dirty: false,
};

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  const now = new Date();
  // Default: mês anterior
  let y = now.getFullYear(), m = now.getMonth(); // getMonth() = 0-based, then -1 becomes previous
  if (m === 0) { m = 12; y--; } // janeiro → dezembro do ano anterior

  const mSel = document.getElementById('fpMonth');
  const ySel = document.getElementById('fpYear');

  for (let i = 0; i < 12; i++) {
    const opt = document.createElement('option');
    opt.value = i + 1;
    opt.textContent = MONTHS_PT[i];
    if (i + 1 === m) opt.selected = true;
    mSel.appendChild(opt);
  }
  for (let i = y - 1; i <= y + 1; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i;
    if (i === y) opt.selected = true;
    ySel.appendChild(opt);
  }

  mSel.addEventListener('change', () => loadPeriod());
  ySel.addEventListener('change', () => loadPeriod());

  renderStoreButtons('');
  await loadPeriod();
})();

async function loadPeriod() {
  FP.year  = parseInt(document.getElementById('fpYear').value);
  FP.month = parseInt(document.getElementById('fpMonth').value);
  FP.board = '';
  FP.dirty = false;
  document.getElementById('fpPanel').innerHTML = '<div class="fp-empty">Carregando…</div>';
  try {
    const data = await apiFetch(`/api/folha/${FP.year}/${FP.month}`);
    FP.employees   = data.employees   || [];
    FP.vsales      = data.vsales      || {};
    FP.folha       = data.folha       || {};
    FP.folhaConfig = data.folhaConfig || {};
    renderStoreButtons('');
    document.getElementById('fpPanel').innerHTML = '<div class="fp-empty">Selecione uma loja para ver a folha.</div>';
  } catch (e) {
    document.getElementById('fpPanel').innerHTML = `<div class="fp-empty" style="color:#f85149">${e.message}</div>`;
  }
}

function renderStoreButtons(activeBoard) {
  const container = document.getElementById('fpStores');
  const storesWithEmps = STORE_BOARDS.filter(b => FP.employees.some(e => e.board === b));

  container.innerHTML = storesWithEmps.map(b => {
    const info  = BOARDS_INFO[b];
    const saved = !!(FP.folha[b]?.entries && Object.keys(FP.folha[b].entries).length);
    return `<button class="fp-store-btn${b === activeBoard ? ' active' : ''}"
      style="--c:${info.color}"
      onclick="selectBoard('${b}')">
      ${info.label}${saved ? ' ✓' : ''}
    </button>`;
  }).join('');
}

async function selectBoard(board) {
  if (FP.dirty) {
    if (!confirm('Há alterações não salvas. Deseja descartar?')) return;
    FP.dirty = false;
  }
  FP.board = board;
  FP.activeEmpId = null;
  renderStoreButtons(board);
  renderPanel();
}

// ── Panel ──────────────────────────────────────────────────────────────────
function renderPanel() {
  const board = FP.board;
  if (!board) return;
  const info = BOARDS_INFO[board];
  const emps = boardEmps(board);
  const lojaData = FP.folha[board] || {};

  document.getElementById('fpPanel').innerHTML = `
    <div class="fp-panel">
      <div class="fp-panel-header">
        <span class="fp-panel-title" style="color:${info.color}">${info.label}</span>
        <div class="fp-panel-actions">
          <button class="fp-btn" onclick="fpGerar()">Gerar Folha</button>
          <button class="fp-btn warning" onclick="fpSalvar()">Salvar</button>
          <button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
        </div>
      </div>
      <div class="fp-emp-tabs" id="fpEmpTabs"></div>
      <div id="fpEmpForms"></div>
    </div>`;

  renderEmpTabs(emps, lojaData);
  if (emps.length > 0) selectEmp(emps[0].id);
}

function boardEmps(board) {
  return FP.employees.filter(e => e.board === board);
}

function renderEmpTabs(emps, lojaData) {
  const tabs = document.getElementById('fpEmpTabs');
  tabs.innerHTML = emps.map(e => {
    const hasData = !!(lojaData.entries?.[e.id]);
    return `<button
      id="tab-${e.id}"
      class="fp-emp-tab${hasData?' has-data':''}${e.id===FP.activeEmpId?' active':''}"
      onclick="selectEmp(${e.id})">
      ${e.apelido || e.name.split(' ')[0]}
    </button>`;
  }).join('');
}

function selectEmp(empId) {
  FP.activeEmpId = empId;
  const board   = FP.board;
  const emps    = boardEmps(board);
  const lojaData = FP.folha[board] || {};

  // Update tab highlight
  emps.forEach(e => {
    const t = document.getElementById(`tab-${e.id}`);
    if (t) t.classList.toggle('active', e.id === empId);
  });

  const forms = document.getElementById('fpEmpForms');
  const emp   = emps.find(e => e.id === empId);
  if (!emp) { forms.innerHTML = ''; return; }

  const entry = lojaData.entries?.[empId] || null;
  forms.innerHTML = buildEmpForm(emp, entry, lojaData);
  attachFormListeners(empId);
  recalc(empId);
}

// ── Build employee form ────────────────────────────────────────────────────
function buildEmpForm(emp, entry, lojaData) {
  const isCaixa = /caixa|opcx/i.test(emp.cargo || '');
  const e = entry || defaultEntry(emp, lojaData);

  const fmtVal = v => (v || 0) === 0 ? '' : v;
  const inp = (id, v, readOnly) =>
    `<input type="number" step="0.01" id="${id}" value="${fmtVal(v)}" ${readOnly?'readonly style="opacity:.5"':''} onchange="onFieldChange(${emp.id})">`;

  // Proventos section
  let provHtml = '';
  if (isCaixa) {
    provHtml = `
      <div class="fp-field"><label>Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>
      <div class="fp-field"><label>Quebra Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}</div>`;
  } else {
    const pctMeta = (FP.vsales[emp.id]?.meta?.mensal || 0) > 0
      ? ((e.vendas || 0) / (FP.vsales[emp.id]?.meta?.mensal || 1) * 100).toFixed(1)
      : '—';
    const faixaNome = e.faixaNome || '—';
    provHtml = `
      <div class="fp-field">
        <label>Vendas (R$)</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
        <span class="fp-badge pct">${pctMeta}% meta</span>
        <span class="fp-badge faixa">${faixaNome}</span>
      </div>
      <div class="fp-field"><label>Comissão % aplicado</label>${inp(`fp-comPct-${emp.id}`, e.comissaoPct)}</div>
      <div class="fp-field"><label>Comissão (R$)</label>${inp(`fp-comissao-${emp.id}`, e.comissao)}</div>`;
    if (emp.comissaoGerente || emp.comissaoVR) {
      provHtml += `<div class="fp-field"><label>Comissão Loja (R$)</label>${inp(`fp-comExtra-${emp.id}`, e.comissaoExtra)}</div>`;
    }
    provHtml += `
      <div class="fp-field"><label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}</div>`;
    if ((e.gmComplement || 0) > 0 || (lojaData.garantiaMinima || 0) > 0) {
      provHtml += `<div class="fp-field"><label>Garantia Surfers (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}</div>`;
    }
    if (!emp.salarioFixo) {} // no fixo for vendedor
    if (emp.salarioFixo) {
      provHtml = `<div class="fp-field"><label>Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>` + provHtml;
    }
  }

  provHtml += `<div class="fp-field"><label>Premiação (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}</div>`;
  provHtml += `<div class="fp-field"><label>Feriado (R$)</label>${inp(`fp-feriado-${emp.id}`, e.feriado)}</div>`;
  provHtml += buildExtras(emp.id, e.extras || [], 'prov');

  // Descontos section
  const descHtml = `
    <div class="fp-field"><label>Vale Compras (R$)</label>${inp(`fp-valeCompras-${emp.id}`, e.valeCompras)}</div>
    <div class="fp-field"><label>Adiantamento (R$)</label>${inp(`fp-adiantamento-${emp.id}`, e.adiantamento)}</div>
    <div class="fp-field"><label>INSS (R$)</label>${inp(`fp-inss-${emp.id}`, e.inss)}</div>
    <div class="fp-field"><label>IR FP (R$)</label>${inp(`fp-irpf-${emp.id}`, e.irpf)}</div>
    <div class="fp-field"><label>Vale Transporte (R$)</label>${inp(`fp-vt-${emp.id}`, e.vt)}</div>
    <div class="fp-field"><label>Arredondamento (R$)</label>${inp(`fp-arred-${emp.id}`, e.arredondamento)}</div>
    ${buildExtras(emp.id, e.extrasDesc || [], 'desc')}`;

  return `
  <div class="fp-emp-form active" id="empform-${emp.id}">
    <div style="font-size:.78rem;color:#8b949e;margin-bottom:.75rem">${emp.name} · ${emp.cargo} · INSS ${emp.inssRate||0}% · VT ${emp.vtRate||0}%</div>
    <div class="fp-form-grid">
      <div class="fp-section">
        <div class="fp-section-title">Proventos <span class="fp-section-total" id="total-prov-${emp.id}"></span></div>
        ${provHtml}
        <div class="fp-total-row"><label>PROVENTOS</label><span class="fp-total-val" id="val-proventos-${emp.id}">R$ 0,00</span></div>
      </div>
      <div class="fp-section">
        <div class="fp-section-title">Descontos <span class="fp-section-total" id="total-desc-${emp.id}"></span></div>
        ${descHtml}
        <div class="fp-total-row"><label>TOTAL DESCONTOS</label><span class="fp-total-val" style="color:#f85149" id="val-desc-${emp.id}">R$ 0,00</span></div>
      </div>
    </div>
    <div class="fp-liquido-bar">
      <div>
        <div class="fp-liquido-label">LÍQUIDO A RECEBER</div>
        ${emp.banco ? `<div style="font-size:.75rem;color:#8b949e">Banco ${emp.banco} · Conta ${emp.conta||'—'}</div>` : ''}
      </div>
      <span class="fp-liquido-val" id="val-liquido-${emp.id}">R$ 0,00</span>
    </div>
  </div>`;
}

function buildExtras(empId, extras, type) {
  const rows = extras.map((ex, i) =>
    `<div class="fp-extra-row" id="extra-${type}-${empId}-${i}">
      <input type="text" placeholder="Descrição" value="${ex.nome||''}" onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="Valor" value="${ex.valor||''}" onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`
  ).join('');
  return `<div class="fp-extras" id="extras-${type}-${empId}">${rows}</div>
  <button class="fp-add-extra" onclick="addExtra(${empId},'${type}')">+ Adicionar linha</button>`;
}

// ── Default entry ──────────────────────────────────────────────────────────
function defaultEntry(emp, lojaData) {
  const isCaixa = /caixa|opcx/i.test(emp.cargo || '');
  const vs      = FP.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
  const vendas  = Object.values(vs.entries || {}).reduce((s, e) => s + (e.vendas || 0), 0);
  const meta    = vs.meta?.mensal || emp.vendaMeta || 0;
  const cfg     = FP.folhaConfig[FP.board] || {};
  const diasUteis       = lojaData.diasUteis       || cfg.diasUteis       || 24;
  const domingosFeriados = lojaData.domingosFeriados || cfg.domingosFeriados || 5;

  const entry = { extras: [], extrasDesc: [] };

  if (isCaixa) {
    entry.fixo   = emp.salarioFixo  || 0;
    entry.quebra = emp.quebraCaixa  || 0;
    entry.feriado = 0;
    entry.premio  = 0;
    const proventos = (entry.fixo || 0) + (entry.quebra || 0);
    const inss = Math.round(proventos * (emp.inssRate || 0) * 100) / 100;
    const vt   = Math.round(proventos * (emp.vtRate   || 0) * 100) / 100;
    Object.assign(entry, {
      proventos, inss, vt,
      irpf: 0, valeCompras: 0, adiantamento: 0, arredondamento: 0,
      totalDescontos: inss + vt,
      liquido: proventos - inss - vt,
    });
    return entry;
  }

  // Vendedores / Gerentes
  const pctMeta = meta > 0 ? vendas / meta : 0;
  const faixas = cfg.metaFaixas || DEFAULT_FAIXAS;
  let faixaIdx = 0;
  for (let i = faixas.length - 1; i >= 0; i--) {
    if (pctMeta >= (faixas[i].minPct || 0)) { faixaIdx = i; break; }
  }
  const faixaNome  = faixas[faixaIdx]?.nome || 'S/META';
  const pctArr     = [emp.comissaoSemMeta || 0, emp.comissao || 0, emp.comissaoMeta2 || 0, emp.comissaoSuper || 0];
  const comissaoPct = (pctArr[faixaIdx] || pctArr[0] || 0) / 100;

  const fixo         = emp.salarioFixo || 0;
  const comissao     = Math.round(vendas * comissaoPct * 100) / 100;
  const vendaLoja    = STORE_BOARDS.includes(FP.board)
    ? Object.values(FP.vsales)
        .filter((_, i) => FP.employees[i]?.board === FP.board)
        .reduce((s, v) => s + Object.values(v.entries || {}).reduce((a, e) => a + (e.vendas || 0), 0), 0)
    : 0;
  // Better: sum all vendas for this board
  const vendaLojaTotal = boardEmps(FP.board).reduce((s, e2) => {
    const v2 = FP.vsales[e2.id] || {};
    return s + Object.values(v2.entries || {}).reduce((a, en) => a + (en.vendas || 0), 0);
  }, 0);

  const comissaoExtraPct = (emp.comissaoGerente || 0) / 100;
  const comissaoVrPct    = (emp.comissaoVR      || 0) / 100;
  const comissaoExtra = Math.round(vendaLojaTotal * (comissaoExtraPct + comissaoVrPct) * 100) / 100;

  const cfg2     = FP.folhaConfig[FP.board] || {};
  const premioBase = /gerente/i.test(emp.cargo || '') ? (cfg2.premioGerente || 0) : (cfg2.premioVendedor || 0);
  const premio   = premioBase;

  const dsr = diasUteis > 0
    ? Math.round((comissao + comissaoExtra + premio) / diasUteis * domingosFeriados * 100) / 100
    : 0;

  const gm = cfg2.garantiaMinima || 0;
  const gmComplement = Math.max(0, gm - comissao - comissaoExtra - dsr);

  const proventos = fixo + comissao + comissaoExtra + dsr + gmComplement + premio;
  const inss = Math.round(proventos * (emp.inssRate || 0) * 100) / 100;
  const vt   = Math.round(proventos * (emp.vtRate   || 0) * 100) / 100;

  Object.assign(entry, {
    vendas, meta, pctMeta, faixaNome, comissaoPct,
    fixo, comissao, comissaoExtra, dsr, gm, gmComplement, premio, feriado: 0,
    proventos,
    inss, irpf: 0, vt, valeCompras: 0, adiantamento: 0, arredondamento: 0,
    totalDescontos: inss + vt,
    liquido: proventos - inss - vt,
  });
  return entry;
}

// ── Recalculate totals from form fields ───────────────────────────────────
function recalc(empId) {
  const g = id => parseFloat(document.getElementById(id)?.value) || 0;
  const isCaixa = /caixa|opcx/i.test((FP.employees.find(e => e.id === empId)?.cargo) || '');
  const emp = FP.employees.find(e => e.id === empId);

  // Collect proventos
  let proventos = 0;
  if (isCaixa) {
    proventos += g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`);
  } else {
    if (document.getElementById(`fp-fixo-${empId}`)) proventos += g(`fp-fixo-${empId}`);
    proventos += g(`fp-comissao-${empId}`) + g(`fp-comExtra-${empId}`) + g(`fp-dsr-${empId}`) + g(`fp-gm-${empId}`);
  }
  proventos += g(`fp-premio-${empId}`) + g(`fp-feriado-${empId}`);

  // Extra proventos rows
  const lojaData = FP.folha[FP.board] || {};
  const entry = lojaData.entries?.[empId] || {};
  for (const ex of (entry.extras || [])) proventos += (parseFloat(ex.valor) || 0);

  const inss = Math.round(proventos * ((emp?.inssRate || 0) / 100) * 100) / 100;
  const vt   = Math.round(proventos * ((emp?.vtRate   || 0) / 100) * 100) / 100;

  const descontos = g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`);
  let totalDesc = descontos;
  for (const ex of (entry.extrasDesc || [])) totalDesc += (parseFloat(ex.valor) || 0);

  const liquido = proventos - totalDesc;

  const fmt = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set(`val-proventos-${empId}`, proventos);
  set(`val-desc-${empId}`, totalDesc);
  set(`val-liquido-${empId}`, liquido);
}

function attachFormListeners(empId) {
  // listen on all inputs in the form
  const form = document.getElementById(`empform-${empId}`);
  if (!form) return;
  form.querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => onFieldChange(empId));
  });
}

function onFieldChange(empId) {
  FP.dirty = true;
  saveEntryFromForm(empId);
  recalc(empId);
}

function saveEntryFromForm(empId) {
  const g = id => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
  const emp = FP.employees.find(e => e.id === empId);
  const isCaixa = /caixa|opcx/i.test(emp?.cargo || '');

  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { diasUteis: 24, domingosFeriados: 5, entries: {} };
  if (!FP.folha[board].entries) FP.folha[board].entries = {};

  const prev = FP.folha[board].entries[empId] || {};
  const proventos = isCaixa
    ? g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`) + g(`fp-premio-${empId}`) + g(`fp-feriado-${empId}`)
    : (document.getElementById(`fp-fixo-${empId}`) ? g(`fp-fixo-${empId}`) : 0)
      + g(`fp-comissao-${empId}`) + g(`fp-comExtra-${empId}`) + g(`fp-dsr-${empId}`)
      + g(`fp-gm-${empId}`) + g(`fp-premio-${empId}`) + g(`fp-feriado-${empId}`);
  const extrasProvTotal = (prev.extras || []).reduce((s, ex) => s + (parseFloat(ex.valor) || 0), 0);
  const totalProv = proventos + extrasProvTotal;

  const totalDesc = g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`)
    + (prev.extrasDesc || []).reduce((s, ex) => s + (parseFloat(ex.valor) || 0), 0);

  FP.folha[board].entries[empId] = {
    ...prev,
    fixo:         g(`fp-fixo-${empId}`),
    quebra:       g(`fp-quebra-${empId}`),
    vendas:       g(`fp-vendas-${empId}`),
    comissaoPct:  g(`fp-comPct-${empId}`),
    comissao:     g(`fp-comissao-${empId}`),
    comissaoExtra:g(`fp-comExtra-${empId}`),
    dsr:          g(`fp-dsr-${empId}`),
    gmComplement: g(`fp-gm-${empId}`),
    premio:       g(`fp-premio-${empId}`),
    feriado:      g(`fp-feriado-${empId}`),
    proventos:    totalProv,
    valeCompras:  g(`fp-valeCompras-${empId}`),
    adiantamento: g(`fp-adiantamento-${empId}`),
    inss:         g(`fp-inss-${empId}`),
    irpf:         g(`fp-irpf-${empId}`),
    vt:           g(`fp-vt-${empId}`),
    arredondamento: g(`fp-arred-${empId}`),
    totalDescontos: totalDesc,
    liquido:      totalProv - totalDesc,
  };
}

// ── Extras ────────────────────────────────────────────────────────────────
function addExtra(empId, type) {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { diasUteis: 24, domingosFeriados: 5, entries: {} };
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  if (!FP.folha[board].entries[empId]) FP.folha[board].entries[empId] = defaultEntry(FP.employees.find(e=>e.id===empId), FP.folha[board]);
  const key = type === 'prov' ? 'extras' : 'extrasDesc';
  if (!FP.folha[board].entries[empId][key]) FP.folha[board].entries[empId][key] = [];
  FP.folha[board].entries[empId][key].push({ nome: '', valor: 0 });
  FP.dirty = true;
  refreshExtras(empId, type);
}

function removeExtra(empId, type, idx) {
  const board = FP.board;
  const key = type === 'prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[board]?.entries?.[empId]?.[key];
  if (arr) arr.splice(idx, 1);
  FP.dirty = true;
  refreshExtras(empId, type);
  recalc(empId);
}

function onExtraChange(empId, type, idx, field, value) {
  const board = FP.board;
  const key = type === 'prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[board]?.entries?.[empId]?.[key];
  if (arr?.[idx]) arr[idx][field] = field === 'valor' ? (parseFloat(value) || 0) : value;
  FP.dirty = true;
}

function refreshExtras(empId, type) {
  const board = FP.board;
  const key = type === 'prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[board]?.entries?.[empId]?.[key] || [];
  const container = document.getElementById(`extras-${type}-${empId}`);
  if (!container) return;
  container.innerHTML = arr.map((ex, i) =>
    `<div class="fp-extra-row" id="extra-${type}-${empId}-${i}">
      <input type="text" placeholder="Descrição" value="${ex.nome||''}" onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="Valor" value="${ex.valor||''}" onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`
  ).join('');
}

// ── Gerar Folha ───────────────────────────────────────────────────────────
function fpGerar() {
  const board    = FP.board;
  const emps     = boardEmps(board);
  const cfg      = FP.folhaConfig[board] || {};
  const diasUteis       = cfg.diasUteis       || 24;
  const domingosFeriados = cfg.domingosFeriados || 5;

  if (!FP.folha[board]) FP.folha[board] = {};
  FP.folha[board].diasUteis        = diasUteis;
  FP.folha[board].domingosFeriados = domingosFeriados;
  if (!FP.folha[board].entries) FP.folha[board].entries = {};

  for (const emp of emps) {
    FP.folha[board].entries[emp.id] = defaultEntry(emp, FP.folha[board]);
  }

  FP.dirty = true;
  renderPanel();
  toast('Folha gerada com sucesso.');
}

// ── Salvar ────────────────────────────────────────────────────────────────
async function fpSalvar() {
  const board = FP.board;
  if (!board) { toast('Nenhuma loja selecionada.', true); return; }
  // Persist current form values
  const emps = boardEmps(board);
  for (const emp of emps) saveEntryFromForm(emp.id);
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(board);
    toast('Folha salva.');
  } catch (e) {
    toast('Erro ao salvar: ' + e.message, true);
  }
}

// ── Exportar ──────────────────────────────────────────────────────────────
async function fpExportar() {
  const board = FP.board;
  await fpSalvar();
  const url = `/api/folha/${FP.year}/${FP.month}/export${board ? `?board=${board}` : ''}`;
  window.location.href = url;
}

// ── Config Modal ──────────────────────────────────────────────────────────
function fpOpenConfig() {
  const modal = document.getElementById('fpConfigModal');
  const tabs  = document.getElementById('fpConfigTabs');
  const contents = document.getElementById('fpConfigContents');

  const storesWithEmps = STORE_BOARDS.filter(b => FP.employees.some(e => e.board === b));
  tabs.innerHTML = storesWithEmps.map((b, i) =>
    `<button class="fp-modal-tab${i===0?' active':''}" onclick="fpConfigTab('${b}')" id="cfgtab-${b}">${BOARDS_INFO[b].label}</button>`
  ).join('');

  contents.innerHTML = storesWithEmps.map((b, i) => {
    const cfg = FP.folhaConfig[b] || {};
    const faixas = cfg.metaFaixas || DEFAULT_FAIXAS;
    return `
    <div class="fp-modal-content${i===0?' active':''}" id="cfgcontent-${b}">
      <div class="fp-cfg-faixas">
        <div style="font-size:.8rem;color:#8b949e;margin-bottom:.5rem">Faixas de Meta (para vendedores)</div>
        <table>
          <thead><tr><th>Nome</th><th>A partir de (%)</th></tr></thead>
          <tbody>
            ${faixas.map((f,i) => `
            <tr>
              <td><input type="text" value="${f.nome}" id="cfg-faixa-nome-${b}-${i}"></td>
              <td><input type="number" step="0.01" value="${(f.minPct*100).toFixed(0)}" id="cfg-faixa-pct-${b}-${i}"></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="fp-cfg-field"><label>Garantia Mínima Vendedor (R$)</label><input type="number" step="0.01" id="cfg-gm-${b}" value="${cfg.garantiaMinima||0}"></div>
      <div class="fp-cfg-field"><label>Dias Úteis (padrão)</label><input type="number" id="cfg-diasUteis-${b}" value="${cfg.diasUteis||24}"></div>
      <div class="fp-cfg-field"><label>Domingos/Feriados (padrão)</label><input type="number" id="cfg-domingosFeriados-${b}" value="${cfg.domingosFeriados||5}"></div>
      <div class="fp-cfg-field"><label>Prêmio Vendedor (R$)</label><input type="number" step="0.01" id="cfg-premioVendedor-${b}" value="${cfg.premioVendedor||0}"></div>
      <div class="fp-cfg-field"><label>Prêmio Gerente (R$)</label><input type="number" step="0.01" id="cfg-premioGerente-${b}" value="${cfg.premioGerente||0}"></div>
    </div>`;
  }).join('');

  modal.classList.add('open');
}

function fpConfigTab(board) {
  document.querySelectorAll('.fp-modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.fp-modal-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`cfgtab-${board}`)?.classList.add('active');
  document.getElementById(`cfgcontent-${board}`)?.classList.add('active');
}

function fpCloseConfig() {
  document.getElementById('fpConfigModal').classList.remove('open');
}

async function fpSaveConfig() {
  const storesWithEmps = STORE_BOARDS.filter(b => FP.employees.some(e => e.board === b));
  const config = {};
  for (const b of storesWithEmps) {
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    const gs = id => document.getElementById(id)?.value?.trim() || '';
    const faixas = DEFAULT_FAIXAS.map((_, i) => ({
      nome:   gs(`cfg-faixa-nome-${b}-${i}`),
      minPct: g(`cfg-faixa-pct-${b}-${i}`) / 100,
    })).filter(f => f.nome);
    config[b] = {
      metaFaixas:        faixas.length ? faixas : DEFAULT_FAIXAS,
      garantiaMinima:    g(`cfg-gm-${b}`),
      diasUteis:         g(`cfg-diasUteis-${b}`),
      domingosFeriados:  g(`cfg-domingosFeriados-${b}`),
      premioVendedor:    g(`cfg-premioVendedor-${b}`),
      premioGerente:     g(`cfg-premioGerente-${b}`),
    };
  }
  try {
    await apiFetch('/api/folha/config', 'POST', config);
    FP.folhaConfig = config;
    fpCloseConfig();
    toast('Configuração salva.');
  } catch (e) {
    toast('Erro: ' + e.message, true);
  }
}

// ── API helper ────────────────────────────────────────────────────────────
async function apiFetch(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    if (r.status === 401) { location.href = '/'; return; }
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, err) {
  const el = document.getElementById('fpToast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.borderColor = err ? '#f85149' : '#3fb950';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}
