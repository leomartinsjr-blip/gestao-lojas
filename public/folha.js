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

// Cargo → tipo para folha
function cargoTipo(cargo) {
  const c = (cargo || '').toLowerCase();
  if (/caixa|opcx/.test(c))        return 'caixa';
  if (/sub.gerente|sub gerente/.test(c)) return 'sub';
  if (/gerente/.test(c))            return 'gerente';
  return 'vendedor';
}

// ── State ──────────────────────────────────────────────────────────────────
let FP = {
  year: 0, month: 0,
  board: '',
  employees: [],
  vsales: {},
  folha: {},       // keyed by board → { diasUteis, domingosFeriados, entries }
  folhaConfig: {}, // keyed by board → { comissaoPct, garantiaMinima, ... }
  activeEmpId: null,
  dirty: false,
};

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth(); // 0-based; this gives previous month
  if (m === 0) { m = 12; y--; }

  const mSel = document.getElementById('fpMonth');
  const ySel = document.getElementById('fpYear');
  for (let i = 0; i < 12; i++) {
    const o = document.createElement('option');
    o.value = i + 1; o.textContent = MONTHS_PT[i];
    if (i + 1 === m) o.selected = true;
    mSel.appendChild(o);
  }
  for (let i = y - 1; i <= y + 1; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = i;
    if (i === y) o.selected = true;
    ySel.appendChild(o);
  }
  mSel.addEventListener('change', loadPeriod);
  ySel.addEventListener('change', loadPeriod);
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
    document.getElementById('fpPanel').innerHTML =
      '<div class="fp-empty">Selecione uma loja para ver a folha.</div>';
  } catch (e) {
    document.getElementById('fpPanel').innerHTML =
      `<div class="fp-empty" style="color:#f85149">${e.message}</div>`;
  }
}

function renderStoreButtons(activeBoard) {
  const c = document.getElementById('fpStores');
  c.innerHTML = STORE_BOARDS
    .filter(b => FP.employees.some(e => e.board === b))
    .map(b => {
      const saved = !!(FP.folha[b]?.entries && Object.keys(FP.folha[b].entries).length);
      return `<button class="fp-store-btn${b===activeBoard?' active':''}"
        style="--c:${BOARDS_INFO[b].color}" onclick="selectBoard('${b}')">
        ${BOARDS_INFO[b].label}${saved?' ✓':''}
      </button>`;
    }).join('');
}

async function selectBoard(board) {
  if (FP.dirty && !confirm('Há alterações não salvas. Descartar?')) return;
  FP.board = board;
  FP.activeEmpId = null;
  FP.dirty = false;
  renderStoreButtons(board);
  renderPanel();
}

// ── Panel ──────────────────────────────────────────────────────────────────
function renderPanel() {
  const board = FP.board;
  const info  = BOARDS_INFO[board];
  document.getElementById('fpPanel').innerHTML = `
    <div class="fp-panel">
      <div class="fp-panel-header">
        <span class="fp-panel-title" style="color:${info.color}">${info.label}</span>
        <div style="font-size:.75rem;color:#8b949e;margin-left:.5rem">Vendas: Microvix sync diário</div>
        <div class="fp-panel-actions">
          <button class="fp-btn" onclick="fpOpenCfg('${board}')">Configurar Loja</button>
          <button class="fp-btn" onclick="fpGerar()">Gerar Folha</button>
          <button class="fp-btn warning" onclick="fpSalvar()">Salvar</button>
          <button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
        </div>
      </div>
      <div class="fp-emp-tabs" id="fpEmpTabs"></div>
      <div id="fpEmpForms"></div>
    </div>`;

  const emps = boardEmps(board);
  renderEmpTabs(emps);
  if (emps.length > 0) selectEmp(emps[0].id);
}

function boardEmps(board) {
  return FP.employees.filter(e => e.board === board);
}

function renderEmpTabs(emps) {
  const lojaData = FP.folha[FP.board] || {};
  document.getElementById('fpEmpTabs').innerHTML = emps.map(e => {
    const has = !!(lojaData.entries?.[e.id]);
    return `<button id="tab-${e.id}"
      class="fp-emp-tab${has?' has-data':''}${e.id===FP.activeEmpId?' active':''}"
      onclick="selectEmp(${e.id})">
      ${e.apelido || e.name.split(' ')[0]}
      <span style="font-size:.7rem;color:#8b949e;margin-left:.2rem">(${e.cargo})</span>
    </button>`;
  }).join('');
}

function selectEmp(empId) {
  FP.activeEmpId = empId;
  const emps = boardEmps(FP.board);
  emps.forEach(e => {
    const t = document.getElementById(`tab-${e.id}`);
    if (t) t.classList.toggle('active', e.id === empId);
  });
  const emp   = emps.find(e => e.id === empId);
  const entry = FP.folha[FP.board]?.entries?.[empId] || null;
  const forms = document.getElementById('fpEmpForms');
  if (!emp) { forms.innerHTML = ''; return; }
  forms.innerHTML = buildEmpForm(emp, entry || defaultEntry(emp));
  attachFormListeners(empId);
  recalc(empId);
}

// ── Config modal ───────────────────────────────────────────────────────────
function fpOpenCfg(board) {
  const cfg = FP.folhaConfig[board] || {};
  document.getElementById('fpConfigModal').classList.add('open');
  document.getElementById('fpConfigContents').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
      <div class="fp-cfg-field"><label>Comissão Vendedores (%)</label>
        <input type="number" step="0.01" id="cfg-comPct" value="${cfg.comissaoPct??4.5}" placeholder="4.5">
      </div>
      <div class="fp-cfg-field"><label>Garantia Mínima (R$)</label>
        <input type="number" step="0.01" id="cfg-gm" value="${cfg.garantiaMinima??0}" placeholder="1980">
      </div>
      <div class="fp-cfg-field"><label>Salário Fixo Caixa (R$)</label>
        <input type="number" step="0.01" id="cfg-fixoCaixa" value="${cfg.salarioFixoCaixa??0}" placeholder="1850">
      </div>
      <div class="fp-cfg-field"><label>Quebra de Caixa (R$)</label>
        <input type="number" step="0.01" id="cfg-quebraCaixa" value="${cfg.quebraCaixa??0}" placeholder="190.46">
      </div>
      <div class="fp-cfg-field"><label>Comissão Gerente (%)</label>
        <input type="number" step="0.01" id="cfg-comGerente" value="${cfg.comissaoGerente??1}" placeholder="1.0">
      </div>
      <div class="fp-cfg-field"><label>Comissão VR (%)</label>
        <input type="number" step="0.01" id="cfg-comVR" value="${cfg.comissaoVR??0.75}" placeholder="0.75">
      </div>
      <div class="fp-cfg-field"><label>Dias Úteis</label>
        <input type="number" id="cfg-diasUteis" value="${cfg.diasUteis??24}" placeholder="24">
      </div>
      <div class="fp-cfg-field"><label>Domingos/Feriados</label>
        <input type="number" id="cfg-domingosFeriados" value="${cfg.domingosFeriados??5}" placeholder="5">
      </div>
      <div class="fp-cfg-field"><label>Prêmio Vendedor (R$)</label>
        <input type="number" step="0.01" id="cfg-premioVendedor" value="${cfg.premioVendedor??0}" placeholder="256.43">
      </div>
      <div class="fp-cfg-field"><label>Prêmio Gerente (R$)</label>
        <input type="number" step="0.01" id="cfg-premioGerente" value="${cfg.premioGerente??0}" placeholder="129.36">
      </div>
    </div>`;
  document.getElementById('fpConfigModal').dataset.board = board;
  document.getElementById('fpConfigTabs').innerHTML =
    `<span style="font-size:.9rem;font-weight:600;color:${BOARDS_INFO[board].color}">${BOARDS_INFO[board].label}</span>`;
}

function fpCloseConfig() {
  document.getElementById('fpConfigModal').classList.remove('open');
}

async function fpSaveConfig() {
  const g  = id => parseFloat(document.getElementById(id)?.value) || 0;
  const board = document.getElementById('fpConfigModal').dataset.board;
  if (!board) return;
  const cfg = {
    comissaoPct:       g('cfg-comPct'),
    garantiaMinima:    g('cfg-gm'),
    salarioFixoCaixa:  g('cfg-fixoCaixa'),
    quebraCaixa:       g('cfg-quebraCaixa'),
    comissaoGerente:   g('cfg-comGerente'),
    comissaoVR:        g('cfg-comVR'),
    diasUteis:         g('cfg-diasUteis'),
    domingosFeriados:  g('cfg-domingosFeriados'),
    premioVendedor:    g('cfg-premioVendedor'),
    premioGerente:     g('cfg-premioGerente'),
  };
  if (!FP.folhaConfig) FP.folhaConfig = {};
  FP.folhaConfig[board] = cfg;
  try {
    await apiFetch('/api/folha/config', 'POST', FP.folhaConfig);
    fpCloseConfig();
    toast('Configuração salva.');
  } catch (e) { toast('Erro: ' + e.message, true); }
}

// ── Default entry (auto-calc from vsales + config) ─────────────────────────
function defaultEntry(emp) {
  const cfg  = FP.folhaConfig[FP.board] || {};
  const tipo = cargoTipo(emp.cargo);

  const diasUteis        = cfg.diasUteis        || 24;
  const domingosFeriados = cfg.domingosFeriados  || 5;
  const totalDias        = diasUteis + domingosFeriados;

  // Vendas do funcionário no mês (do Microvix via vsales)
  const vs     = FP.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
  const vendas = Object.values(vs.entries || {}).reduce((s, e) => s + (e.value || 0), 0);
  const meta   = vs.meta?.mensal || 0;

  // Total de vendas da loja (para comissão gerente/VR)
  const vendaLoja = boardEmps(FP.board).reduce((s, e2) => {
    const v2 = FP.vsales[e2.id] || {};
    return s + Object.values(v2.entries || {}).reduce((a, en) => a + (en.value || 0), 0);
  }, 0);

  const entry = { extras: [], extrasDesc: [], tipo };

  if (tipo === 'caixa') {
    const fixo   = cfg.salarioFixoCaixa || emp.salarioFixo || 0;
    const quebra = cfg.quebraCaixa      || emp.quebraCaixa  || 0;
    const proventos = fixo + quebra;
    const inss = round2(proventos * (emp.inssRate || 0) / 100);
    const vt   = round2(proventos * (emp.vtRate   || 0) / 100);
    return { ...entry, fixo, quebra, feriado: 0, extras: [],
      proventos, valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
      arredondamento: 0, extrasDesc: [], totalDescontos: inss + vt, liquido: proventos - inss - vt };
  }

  // Vendedor / Sub-gerente / Gerente
  const comissaoPct = cfg.comissaoPct || emp.comissao || 4.5; // em %
  const comissao = round2(vendas * comissaoPct / 100);

  // DSR = comissão × domingos / totalDias (fórmula CLT)
  const premio = /gerente/.test(tipo) ? (cfg.premioGerente || 0) : (cfg.premioVendedor || 0);
  const dsr    = totalDias > 0 ? round2(comissao * domingosFeriados / totalDias) : 0;

  // Garantia mínima: se comissão < GM → paga a diferença
  const gm           = cfg.garantiaMinima || 0;
  const gmComplement = comissao > 0 ? Math.max(0, gm - comissao) : 0;

  // Comissão gerente / VR sobre total loja
  let comissaoLoja = 0;
  if (tipo === 'gerente') {
    comissaoLoja = round2(vendaLoja * (cfg.comissaoGerente || 0) / 100);
  } else if (tipo === 'sub') {
    comissaoLoja = round2(vendaLoja * (cfg.comissaoVR || 0) / 100);
  }

  // Fixo para gerentes que têm salário fixo
  const fixo = (tipo === 'gerente' && emp.salarioFixo) ? emp.salarioFixo : 0;

  const proventos = round2(fixo + comissao + comissaoLoja + dsr + gmComplement + premio);
  const inss = round2(proventos * (emp.inssRate || 0) / 100);
  const vt   = round2(proventos * (emp.vtRate   || 0) / 100);

  return {
    ...entry,
    vendas, meta, comissaoPct, comissao, comissaoLoja, dsr, gm, gmComplement,
    fixo, premio, feriado: 0,
    proventos,
    valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt, arredondamento: 0,
    totalDescontos: inss + vt, liquido: proventos - inss - vt,
  };
}

// ── Build form HTML ────────────────────────────────────────────────────────
function buildEmpForm(emp, entry) {
  const tipo = cargoTipo(emp.cargo);
  const e    = entry;
  const cfg  = FP.folhaConfig[FP.board] || {};

  const brl = v => v ? `R$ ${Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2})}` : 'R$ 0,00';
  const inp = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${v||''}" onchange="onFieldChange(${emp.id})">`;

  // ── Proventos ──
  let provRows = '';
  if (tipo === 'caixa') {
    provRows = `
      <div class="fp-field"><label>Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>
      <div class="fp-field"><label>Quebra Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}</div>`;
  } else {
    const pctMeta = (e.meta || 0) > 0 ? ((e.vendas || 0) / e.meta * 100).toFixed(1) + '%' : '—';
    if (tipo === 'gerente' && emp.salarioFixo) {
      provRows += `<div class="fp-field"><label>Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>`;
    }
    provRows += `
      <div class="fp-field">
        <label>Vendas Individuais (R$)</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
        <span class="fp-badge">${pctMeta} meta</span>
      </div>
      <div class="fp-field">
        <label>Comissão (${e.comissaoPct||cfg.comissaoPct||0}%)</label>
        ${inp(`fp-comissao-${emp.id}`, e.comissao)}
      </div>`;
    if (tipo === 'gerente' || tipo === 'sub') {
      const lbl = tipo === 'gerente'
        ? `Comissão Loja (${cfg.comissaoGerente||0}%)`
        : `Comissão VR (${cfg.comissaoVR||0}%)`;
      provRows += `<div class="fp-field"><label>${lbl}</label>${inp(`fp-comLoja-${emp.id}`, e.comissaoLoja)}</div>`;
    }
    provRows += `<div class="fp-field"><label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}</div>`;
    if ((e.gm || 0) > 0) {
      provRows += `<div class="fp-field"><label>GM Surfers (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}</div>`;
    }
  }
  provRows += `
    <div class="fp-field"><label>Premiação (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}</div>
    <div class="fp-field"><label>Feriado (R$)</label>${inp(`fp-feriado-${emp.id}`, e.feriado)}</div>
    <div class="fp-extras" id="extras-prov-${emp.id}">
      ${buildExtraRows(emp.id, e.extras || [], 'prov')}
    </div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'prov')">+ Adicionar linha</button>`;

  // ── Descontos ──
  const descRows = `
    <div class="fp-field"><label>Vale Compras (R$)</label>${inp(`fp-valeCompras-${emp.id}`, e.valeCompras)}</div>
    <div class="fp-field"><label>Adiantamento (R$)</label>${inp(`fp-adiantamento-${emp.id}`, e.adiantamento)}</div>
    <div class="fp-field"><label>INSS (R$)</label>${inp(`fp-inss-${emp.id}`, e.inss)}</div>
    <div class="fp-field"><label>IR FP (R$)</label>${inp(`fp-irpf-${emp.id}`, e.irpf)}</div>
    <div class="fp-field"><label>Vale Transporte (R$)</label>${inp(`fp-vt-${emp.id}`, e.vt)}</div>
    <div class="fp-field"><label>Arredondamento (R$)</label>${inp(`fp-arred-${emp.id}`, e.arredondamento)}</div>
    <div class="fp-extras" id="extras-desc-${emp.id}">
      ${buildExtraRows(emp.id, e.extrasDesc || [], 'desc')}
    </div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'desc')">+ Adicionar desconto</button>`;

  return `
  <div class="fp-emp-form active" id="empform-${emp.id}">
    <div style="font-size:.78rem;color:#8b949e;margin-bottom:.75rem">
      ${emp.name} · ${emp.cargo}
      ${emp.inssRate ? ` · INSS ${emp.inssRate}%` : ''}
      ${emp.vtRate   ? ` · VT ${emp.vtRate}%`     : ''}
      ${emp.banco    ? ` · Banco ${emp.banco} / Cta ${emp.conta||'—'}` : ''}
    </div>
    <div class="fp-form-grid">
      <div class="fp-section">
        <div class="fp-section-title">Proventos</div>
        ${provRows}
        <div class="fp-total-row">
          <label>PROVENTOS</label>
          <span class="fp-total-val" id="val-proventos-${emp.id}">${brl(e.proventos)}</span>
        </div>
      </div>
      <div class="fp-section">
        <div class="fp-section-title">Descontos</div>
        ${descRows}
        <div class="fp-total-row">
          <label>TOTAL DESCONTOS</label>
          <span class="fp-total-val" style="color:#f85149" id="val-desc-${emp.id}">${brl(e.totalDescontos)}</span>
        </div>
      </div>
    </div>
    <div class="fp-liquido-bar">
      <div>
        <div class="fp-liquido-label">LÍQUIDO A RECEBER</div>
        ${emp.banco ? `<div style="font-size:.72rem;color:#8b949e">Banco ${emp.banco} · Conta ${emp.conta||'—'}</div>` : ''}
      </div>
      <span class="fp-liquido-val" id="val-liquido-${emp.id}">${brl(e.liquido)}</span>
    </div>
  </div>`;
}

function buildExtraRows(empId, extras, type) {
  return extras.map((ex, i) =>
    `<div class="fp-extra-row">
      <input type="text" placeholder="Descrição" value="${ex.nome||''}"
        onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="Valor" value="${ex.valor||''}"
        onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`
  ).join('');
}

// ── Recalc ─────────────────────────────────────────────────────────────────
function recalc(empId) {
  const g = id => { const el = document.getElementById(id); return el ? (parseFloat(el.value)||0) : 0; };
  const emp  = FP.employees.find(e => e.id === empId);
  const tipo = cargoTipo(emp?.cargo);
  const entry = FP.folha[FP.board]?.entries?.[empId] || {};

  let proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`)
    + g(`fp-comissao-${empId}`) + g(`fp-comLoja-${empId}`)
    + g(`fp-dsr-${empId}`) + g(`fp-gm-${empId}`)
    + g(`fp-premio-${empId}`) + g(`fp-feriado-${empId}`);
  proventos += (entry.extras||[]).reduce((s,ex)=>s+(parseFloat(ex.valor)||0),0);

  const descontos = g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`);
  const totalDesc = descontos + (entry.extrasDesc||[]).reduce((s,ex)=>s+(parseFloat(ex.valor)||0),0);

  const liquido = proventos - totalDesc;
  const brl = v => 'R$ '+v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const set = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=brl(v); };
  set(`val-proventos-${empId}`, proventos);
  set(`val-desc-${empId}`, totalDesc);
  set(`val-liquido-${empId}`, liquido);
}

function attachFormListeners(empId) {
  const form = document.getElementById(`empform-${empId}`);
  form?.querySelectorAll('input[type=number]').forEach(inp =>
    inp.addEventListener('input', () => onFieldChange(empId))
  );
}

function onFieldChange(empId) {
  FP.dirty = true;
  saveEntryFromForm(empId);
  recalc(empId);
}

function saveEntryFromForm(empId) {
  const g = id => { const el=document.getElementById(id); return el?(parseFloat(el.value)||0):0; };
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { entries: {} };
  if (!FP.folha[board].entries) FP.folha[board].entries = {};

  const prev = FP.folha[board].entries[empId] || {};
  const extrasProvTotal = (prev.extras||[]).reduce((s,ex)=>s+(parseFloat(ex.valor)||0),0);
  const extrasDescTotal = (prev.extrasDesc||[]).reduce((s,ex)=>s+(parseFloat(ex.valor)||0),0);

  const proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`)
    + g(`fp-comissao-${empId}`) + g(`fp-comLoja-${empId}`)
    + g(`fp-dsr-${empId}`) + g(`fp-gm-${empId}`)
    + g(`fp-premio-${empId}`) + g(`fp-feriado-${empId}`) + extrasProvTotal;

  const totalDesc = g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`)
    + extrasDescTotal;

  FP.folha[board].entries[empId] = {
    ...prev,
    fixo:          g(`fp-fixo-${empId}`),
    quebra:        g(`fp-quebra-${empId}`),
    vendas:        g(`fp-vendas-${empId}`),
    comissaoPct:   prev.comissaoPct,
    comissao:      g(`fp-comissao-${empId}`),
    comissaoLoja:  g(`fp-comLoja-${empId}`),
    dsr:           g(`fp-dsr-${empId}`),
    gmComplement:  g(`fp-gm-${empId}`),
    premio:        g(`fp-premio-${empId}`),
    feriado:       g(`fp-feriado-${empId}`),
    proventos,
    valeCompras:   g(`fp-valeCompras-${empId}`),
    adiantamento:  g(`fp-adiantamento-${empId}`),
    inss:          g(`fp-inss-${empId}`),
    irpf:          g(`fp-irpf-${empId}`),
    vt:            g(`fp-vt-${empId}`),
    arredondamento:g(`fp-arred-${empId}`),
    totalDescontos: totalDesc,
    liquido: proventos - totalDesc,
  };
}

// ── Extras ────────────────────────────────────────────────────────────────
function addExtra(empId, type) {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { entries: {} };
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  if (!FP.folha[board].entries[empId])
    FP.folha[board].entries[empId] = defaultEntry(FP.employees.find(e=>e.id===empId));
  const key = type==='prov' ? 'extras' : 'extrasDesc';
  if (!FP.folha[board].entries[empId][key]) FP.folha[board].entries[empId][key] = [];
  FP.folha[board].entries[empId][key].push({ nome: '', valor: 0 });
  FP.dirty = true;
  refreshExtras(empId, type);
}

function removeExtra(empId, type, idx) {
  const key = type==='prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key];
  if (arr) arr.splice(idx, 1);
  FP.dirty = true;
  refreshExtras(empId, type);
  onFieldChange(empId);
}

function onExtraChange(empId, type, idx, field, value) {
  const key = type==='prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key];
  if (arr?.[idx]) arr[idx][field] = field==='valor' ? (parseFloat(value)||0) : value;
  FP.dirty = true;
}

function refreshExtras(empId, type) {
  const key = type==='prov' ? 'extras' : 'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key] || [];
  const c   = document.getElementById(`extras-${type}-${empId}`);
  if (c) c.innerHTML = buildExtraRows(empId, arr, type);
}

// ── Gerar ──────────────────────────────────────────────────────────────────
function fpGerar() {
  const board = FP.board;
  const cfg   = FP.folhaConfig[board] || {};
  if (!FP.folha[board]) FP.folha[board] = {};
  FP.folha[board].diasUteis        = cfg.diasUteis        || 24;
  FP.folha[board].domingosFeriados = cfg.domingosFeriados || 5;
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  for (const emp of boardEmps(board)) {
    FP.folha[board].entries[emp.id] = defaultEntry(emp);
  }
  FP.dirty = true;
  renderPanel();
  toast('Folha gerada.');
}

// ── Salvar ─────────────────────────────────────────────────────────────────
async function fpSalvar() {
  const board = FP.board;
  if (!board) return;
  for (const emp of boardEmps(board)) saveEntryFromForm(emp.id);
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(board);
    toast('Salvo.');
  } catch (e) { toast('Erro: '+e.message, true); }
}

// ── Exportar ───────────────────────────────────────────────────────────────
async function fpExportar() {
  await fpSalvar();
  window.location.href = `/api/folha/${FP.year}/${FP.month}/export?board=${FP.board}`;
}

// ── API ────────────────────────────────────────────────────────────────────
async function apiFetch(url, method='GET', body) {
  const opts = { method, headers:{} };
  if (body!==undefined) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) { if (r.status===401){location.href='/';return;} throw new Error(await r.text()||r.statusText); }
  return r.json();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function round2(v) { return Math.round((v||0)*100)/100; }

let _toast;
function toast(msg, err) {
  const el = document.getElementById('fpToast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.borderColor = err ? '#f85149' : '#3fb950';
  clearTimeout(_toast);
  _toast = setTimeout(()=>{ el.style.display='none'; }, 3000);
}
