'use strict';

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

function cargoTipo(cargo) {
  const c = (cargo || '').toLowerCase().trim();
  if (/caixa|opcx/.test(c))                              return 'caixa';
  if (/^sub.*gerente|sub[\s-]gerente/.test(c))            return 'sub';
  if (/gerente|g\.?\s*vend/.test(c) && !/^sub/.test(c))  return 'gerente';
  return 'vendedor';
}

// ── Config efetiva do funcionário (folha prevalece sobre cadastro) ─────────
function getEmpCfg(emp) {
  const fc = FP.empConfig[emp.id] || {};
  const v  = (a, b) => a != null ? a : b;
  return {
    comissaoSemMeta: v(fc.comissaoSemMeta, emp.comissaoSemMeta || 0),
    comissao:        v(fc.comissao,        emp.comissao        || 0),
    comissaoMeta2:   v(fc.comissaoMeta2,   emp.comissaoMeta2   || 0),
    comissaoSuper:   v(fc.comissaoSuper,   emp.comissaoSuper   || 0),
    comissaoGerente: v(fc.comissaoGerente, emp.comissaoGerente || 0),
    comissaoVR:      v(fc.comissaoVR,      emp.comissaoVR      || 0),
    salarioFixo:     v(fc.salarioFixo,     emp.salarioFixo     || 0),
    quebraCaixa:     v(fc.quebraCaixa,     emp.quebraCaixa     || 0),
    inssRate:        v(fc.inssRate,        emp.inssRate        || 0),
    vtRate:          v(fc.vtRate,          emp.vtRate          || 0),
  };
}

// ── Faixa por vendas vs metas do funcionário ───────────────────────────────
// Thresholds idênticos ao fechamento diário: meta1=meta, meta2=meta×1.10, super=meta×1.10×1.20
function calcFaixa(ecfg, vendas, meta) {
  const meta1  = r2(meta);
  const meta2  = r2(meta * 1.10);
  const super_ = r2(meta * 1.10 * 1.20);

  if (meta > 0 && vendas >= super_)
    return { label: 'SUPER META', comPct: r2(ecfg.comissaoSuper || ecfg.comissao || 0), meta1, meta2, super: super_ };
  if (meta > 0 && vendas >= meta2)
    return { label: 'META 2',     comPct: r2(ecfg.comissaoMeta2 || ecfg.comissao || 0), meta1, meta2, super: super_ };
  if (meta > 0 && vendas >= meta1)
    return { label: 'META 1',     comPct: r2(ecfg.comissao      || 0),                meta1, meta2, super: super_ };
  return       { label: meta > 0 ? 'SEM META' : '—',
                 comPct: r2(ecfg.comissaoSemMeta || ecfg.comissao || 0),                meta1, meta2, super: super_ };
}

// ── State ──────────────────────────────────────────────────────────────────
let FP = {
  year: 0, month: 0, board: '',
  employees: [], vsales: {},
  folha: {}, folhaConfig: {}, empConfig: {},
  mensal: { diasUteis: 22, domingosFeriados: 4 },
  lojaMetaMap: {}, lojaVendaMap: {},
  activeEmpId: null, dirty: false,
};

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (m === 0) { m = 12; y--; }
  const mSel = document.getElementById('fpMonth');
  const ySel = document.getElementById('fpYear');
  for (let i = 0; i < 12; i++) {
    const o = document.createElement('option');
    o.value = i+1; o.textContent = MONTHS_PT[i];
    if (i+1 === m) o.selected = true;
    mSel.appendChild(o);
  }
  for (let i = y-1; i <= y+1; i++) {
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
  FP.board = ''; FP.dirty = false;
  document.getElementById('fpPanel').innerHTML = '<div class="fp-empty">Carregando…</div>';
  try {
    const d = await apiFetch(`/api/folha/${FP.year}/${FP.month}`);
    FP.employees    = d.employees    || [];
    FP.vsales       = d.vsales       || {};
    FP.folha        = d.folha        || {};
    FP.folhaConfig  = d.folhaConfig  || {};
    FP.empConfig    = d.empConfig    || {};
    FP.lojaMetaMap  = d.lojaMetaMap  || {};
    FP.lojaVendaMap = d.lojaVendaMap || {};
    FP.mensal = {
      diasUteis:        d.folhaMensal?.diasUteis        || 22,
      domingosFeriados: d.folhaMensal?.domingosFeriados || 4,
    };
    renderMensalBar();
    renderStoreButtons('');
    document.getElementById('fpPanel').innerHTML =
      '<div class="fp-empty">Selecione uma loja para ver a folha.</div>';
  } catch(e) {
    document.getElementById('fpPanel').innerHTML =
      `<div class="fp-empty" style="color:#f85149">${e.message}</div>`;
  }
}

// ── Barra de config mensal ─────────────────────────────────────────────────
function renderMensalBar() {
  document.getElementById('fpMensalBar').innerHTML = `
    <span style="font-size:.8rem;color:#8b949e">Dias úteis:</span>
    <input type="number" id="fpDiasUteis" value="${FP.mensal.diasUteis}" min="1" max="31"
      style="width:52px;background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:.25rem .4rem;border-radius:5px;font-size:.85rem;text-align:center"
      onchange="saveMensal()">
    <span style="font-size:.8rem;color:#8b949e;margin-left:.75rem">Dom./Feriados:</span>
    <input type="number" id="fpDomingosFeriados" value="${FP.mensal.domingosFeriados}" min="0" max="15"
      style="width:52px;background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:.25rem .4rem;border-radius:5px;font-size:.85rem;text-align:center"
      onchange="saveMensal()">
    <span style="font-size:.72rem;color:#484f58;margin-left:.5rem">aplica a todas as lojas do mês</span>`;
}

let _mensalTimer;
function saveMensal() {
  const du = parseInt(document.getElementById('fpDiasUteis')?.value)          || 22;
  const df = parseInt(document.getElementById('fpDomingosFeriados')?.value)   || 4;
  FP.mensal = { diasUteis: du, domingosFeriados: df };
  clearTimeout(_mensalTimer);
  _mensalTimer = setTimeout(async () => {
    try {
      await apiFetch(`/api/folha/${FP.year}/${FP.month}/mensal`, 'POST', FP.mensal);
      toast('Config mensal salva.');
    } catch(e) { toast('Erro: '+e.message, true); }
  }, 800);
}

function renderStoreButtons(active) {
  document.getElementById('fpStores').innerHTML = STORE_BOARDS
    .filter(b => FP.employees.some(e => e.board === b))
    .map(b => {
      const saved = !!(FP.folha[b]?.entries && Object.keys(FP.folha[b].entries).length);
      return `<button class="fp-store-btn${b===active?' active':''}"
        style="--c:${BOARDS_INFO[b].color}" onclick="selectBoard('${b}')">
        ${BOARDS_INFO[b].label}${saved?' ✓':''}
      </button>`;
    }).join('');
}

async function selectBoard(board) {
  if (FP.dirty && !confirm('Alterações não salvas. Descartar?')) return;
  FP.board = board; FP.activeEmpId = null; FP.dirty = false;
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
        <div style="font-size:.72rem;color:#8b949e;margin-left:.4rem">vendas: Microvix</div>
        <div class="fp-panel-actions">
          <button class="fp-btn" onclick="fpOpenCfg('${board}')">Configurar</button>
          <button class="fp-btn" onclick="fpGerar()">Gerar Folha</button>
          <button class="fp-btn warning" onclick="fpSalvar()">Salvar</button>
          <button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
          <button class="fp-btn" onclick="fpExportarContabilidade()">Contabilidade</button>
        </div>
      </div>
      <div class="fp-emp-tabs" id="fpEmpTabs"></div>
      <div id="fpEmpForms"></div>
    </div>`;
  const emps = boardEmps(board);
  renderEmpTabs(emps);
  if (emps.length) selectEmp(emps[0].id);
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
      <span style="font-size:.68rem;opacity:.6;margin-left:.2rem">${e.cargo}</span>
    </button>`;
  }).join('');
}

function selectEmp(empId) {
  FP.activeEmpId = empId;
  boardEmps(FP.board).forEach(e => {
    document.getElementById(`tab-${e.id}`)?.classList.toggle('active', e.id === empId);
  });
  const emp   = FP.employees.find(e => e.id === empId);
  const entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
  document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
  attachFormListeners(empId);
  recalc(empId);
}

// ── Config ─────────────────────────────────────────────────────────────────
function fpOpenCfg(board) {
  const cfg  = FP.folhaConfig[board] || {};
  const f2   = v => (parseFloat(v)||0).toFixed(2);
  const emps = boardEmps(board);

  // Tabela de metas por funcionário (somente leitura, para conferência)
  const metaLoja  = r2(FP.lojaMetaMap[board]  || 0);
  const vendaLoja = r2(FP.lojaVendaMap[board] || 0);

  const metaRows = emps.map(emp => {
    const vs     = FP.vsales[emp.id] || {};
    const meta   = r2(vs.meta?.mensal || 0);
    const meta2  = r2(meta * 1.10);
    const super_ = r2(meta * 1.10 * 1.20);
    const vendas = sumVendas(emp.id);
    const faixa  = calcFaixa(emp, vendas, meta);
    const faixaColor = {'SEM META':'#8b949e','META 1':'#d29922','META 2':'#3fb950','SUPER META':'#22d3ee','—':'#484f58'};
    const fc = faixaColor[faixa.label] || '#8b949e';
    return `<tr>
      <td style="padding:.3rem .5rem;color:#e6edf3">${emp.apelido || emp.name.split(' ')[0]}</td>
      <td style="padding:.3rem .5rem;color:#8b949e;font-size:.78rem">${emp.cargo}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#e6edf3">${brl(meta)}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#d29922">${meta > 0 ? brl(meta2) : '—'}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#22d3ee">${meta > 0 ? brl(super_) : '—'}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#58a6ff">${brl(vendas)}</td>
      <td style="padding:.3rem .4rem;text-align:center">
        <span style="font-size:.72rem;padding:.1rem .35rem;border-radius:4px;background:${fc}22;color:${fc};border:1px solid ${fc}44">${faixa.label}</span>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('fpConfigModal').classList.add('open');
  document.getElementById('fpConfigModal').dataset.board = board;
  document.getElementById('fpConfigTabs').textContent = `Configuração — ${BOARDS_INFO[board].label}`;

  document.getElementById('fpConfigContents').innerHTML = `
    <div class="fp-modal-tabs" id="fpCfgTabBtns">
      <button class="fp-modal-tab active" onclick="fpCfgTabSwitch('geral')">Geral</button>
      <button class="fp-modal-tab" onclick="fpCfgTabSwitch('metas')">Metas / Faixas</button>
    </div>

    <div class="fp-modal-content active" id="cfg-tab-geral">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.5rem">
        <div class="fp-cfg-field"><label>Salário Fixo Caixa (R$)</label>
          <input type="number" step="0.01" id="cfg-fixoCaixa" value="${f2(cfg.salarioFixoCaixa)}">
        </div>
        <div class="fp-cfg-field"><label>Quebra de Caixa (R$)</label>
          <input type="number" step="0.01" id="cfg-quebraCaixa" value="${f2(cfg.quebraCaixa)}">
        </div>
        <div class="fp-cfg-field"><label>Prêmio Vendedor (R$)</label>
          <input type="number" step="0.01" id="cfg-premioVendedor" value="${f2(cfg.premioVendedor)}">
        </div>
        <div class="fp-cfg-field"><label>Prêmio Gerente (R$)</label>
          <input type="number" step="0.01" id="cfg-premioGerente" value="${f2(cfg.premioGerente)}">
        </div>
      </div>
      <div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid #30363d;display:flex;align-items:center;gap:.75rem">
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>Garantia Mínima (R$)</label>
          <input type="number" step="0.01" id="cfg-gm" value="${f2(cfg.garantiaMinima)}">
        </div>
        <span style="font-size:.72rem;color:#484f58">fixo + comissão ≥ garantia</span>
      </div>
    </div>

    <div class="fp-modal-content" id="cfg-tab-metas">
      <div style="margin:.6rem 0 .4rem;display:flex;gap:1.5rem;flex-wrap:wrap">
        <span style="font-size:.8rem;color:#8b949e">Meta loja: <strong style="color:#e6edf3">${brl(metaLoja)}</strong></span>
        <span style="font-size:.8rem;color:#8b949e">Vendas loja: <strong style="color:#58a6ff">${brl(vendaLoja)}</strong></span>
        <span style="font-size:.75rem;color:#484f58">META 2 = meta × 1,10 · SUPER META = meta × 1,10 × 1,20</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="border-bottom:1px solid #30363d">
          <th style="text-align:left;padding:.3rem .5rem;color:#8b949e">Funcionário</th>
          <th style="text-align:left;padding:.3rem .5rem;color:#8b949e">Cargo</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#8b949e">META 1</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#d29922">META 2</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#22d3ee">SUPER META</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#58a6ff">Vendas</th>
          <th style="text-align:center;padding:.3rem .5rem;color:#8b949e">Faixa</th>
        </tr></thead>
        <tbody>${metaRows}</tbody>
      </table>
    </div>`;
}

function fpCfgTabSwitch(tab) {
  document.querySelectorAll('#fpConfigContents .fp-modal-content')
    .forEach(el => el.classList.remove('active'));
  document.getElementById(`cfg-tab-${tab}`)?.classList.add('active');
  document.querySelectorAll('#fpCfgTabBtns .fp-modal-tab')
    .forEach(btn => btn.classList.toggle('active',
      btn.getAttribute('onclick')?.includes(`'${tab}'`)));
}

function fpCloseConfig() {
  document.getElementById('fpConfigModal').classList.remove('open');
}

async function fpSaveConfig() {
  const g     = id => parseFloat(document.getElementById(id)?.value) || 0;
  const board = document.getElementById('fpConfigModal').dataset.board;
  if (!board) return;
  FP.folhaConfig[board] = {
    garantiaMinima:   g('cfg-gm'),
    salarioFixoCaixa: g('cfg-fixoCaixa'),
    quebraCaixa:      g('cfg-quebraCaixa'),
    premioVendedor:   g('cfg-premioVendedor'),
    premioGerente:    g('cfg-premioGerente'),
  };
  try {
    await apiFetch('/api/folha/config', 'POST', FP.folhaConfig);
    fpCloseConfig();
    toast('Configuração salva.');
  } catch(e) { toast('Erro: '+e.message, true); }
}

// ── Default entry ──────────────────────────────────────────────────────────
function monthKey() {
  return `${FP.year}-${String(FP.month).padStart(2,'0')}`;
}

function sumVendas(empId) {
  const mk = monthKey();
  const vs = FP.vsales[empId] || {};
  return r2(Object.entries(vs.entries||{})
    .filter(([d]) => d.startsWith(mk))
    .reduce((s,[,e]) => s + (e.value||0), 0));
}

function defaultEntry(emp) {
  const cfg  = FP.folhaConfig[FP.board] || {};
  const ecfg = getEmpCfg(emp);
  const tipo = cargoTipo(emp.cargo);
  const du   = FP.mensal.diasUteis        || 22;
  const df   = FP.mensal.domingosFeriados || 4;

  const vendas = sumVendas(emp.id);
  const vs     = FP.vsales[emp.id] || {};
  const meta   = r2(vs.meta?.mensal || 0);

  // ── Caixa ──
  if (tipo === 'caixa') {
    const fixo   = r2(cfg.salarioFixoCaixa || ecfg.salarioFixo || 0);
    const quebra = r2(cfg.quebraCaixa      || ecfg.quebraCaixa  || 0);
    const prov   = r2(fixo + quebra);
    const inss   = r2(prov * (ecfg.inssRate || 0) / 100);
    const vt     = r2(prov * (ecfg.vtRate   || 0) / 100);
    return {
      tipo, fixo, quebra, feriado: 0, extras: [],
      proventos: prov,
      valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
      arredondamento: 0, extrasDesc: [],
      totalDescontos: r2(inss+vt), liquido: r2(prov-inss-vt),
    };
  }

  const faixa       = calcFaixa(ecfg, vendas, meta);
  const faixaLabel  = faixa.label;
  const comissaoPct = faixa.comPct;
  const pctMeta     = meta > 0 ? r2(vendas / meta * 100) : 0;

  const comissaoTotal = r2(vendas * comissaoPct / 100);

  // DSR calculado sobre a comissão contábil (base):
  //   comissaoContab = (comissaoTotal - prêmio) × du / (du + df)
  //   DSR            = comissaoContab × df / du
  const premio = r2((tipo === 'gerente' || tipo === 'sub')
    ? (cfg.premioGerente || 0) : (cfg.premioVendedor || 0));
  const comissaoContab = (du + df) > 0
    ? r2((comissaoTotal - premio) * du / (du + df))
    : r2(comissaoTotal - premio);
  const dsr = du > 0 ? r2(comissaoContab * df / du) : 0;

  const fixo = (tipo === 'gerente' || tipo === 'sub')
    ? r2(ecfg.salarioFixo || 0)
    : 0;

  const gm = r2(cfg.garantiaMinima || 0);
  const gmComplement = r2(Math.max(0, gm - (fixo + comissaoTotal)));

  const vendaLoja = r2(FP.lojaVendaMap[FP.board] || 0);
  let comissaoLoja = 0;
  if (tipo === 'gerente') comissaoLoja = r2(vendaLoja * (ecfg.comissaoGerente || 0) / 100);
  else if (tipo === 'sub') comissaoLoja = r2(vendaLoja * (ecfg.comissaoVR || 0) / 100);

  const proventos = r2(fixo + comissaoTotal + comissaoLoja + gmComplement);
  const inss = r2(proventos * (ecfg.inssRate || 0) / 100);
  const vt   = r2(proventos * (ecfg.vtRate   || 0) / 100);

  return {
    tipo, vendas, meta, pctMeta, faixaLabel, comissaoPct,
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja, vendaLoja, fixo, gm, gmComplement,
    feriado: 0, extras: [],
    proventos,
    valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
    arredondamento: 0, extrasDesc: [],
    totalDescontos: r2(inss+vt), liquido: r2(proventos-inss-vt),
  };
}

// ── Build form ─────────────────────────────────────────────────────────────
function buildEmpForm(emp, entry) {
  const e    = entry;
  const tipo = e.tipo || cargoTipo(emp.cargo);
  const cfg  = FP.folhaConfig[FP.board] || {};
  const ecfg = getEmpCfg(emp);
  const du   = FP.mensal.diasUteis        || 22;
  const df   = FP.mensal.domingosFeriados || 4;

  const inp = (id, v, extra='') =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" ${extra} onchange="onFieldChange(${emp.id})">`;
  const inpRO = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" readonly class="fp-readonly" tabindex="-1">`;

  const faixaColor = {'SEM META':'#8b949e','META 1':'#d29922','META 2':'#3fb950','SUPER META':'#22d3ee','—':'#484f58'};
  const faixaBadge = label => {
    const c = faixaColor[label] || '#8b949e';
    return `<span style="font-size:.7rem;padding:.1rem .4rem;border-radius:4px;background:${c}22;color:${c};border:1px solid ${c}44;white-space:nowrap">${label}</span>`;
  };

  let provRows = '';

  if (tipo === 'caixa') {
    provRows = `
      <div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>
      <div class="fp-field"><label>Quebra de Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}</div>`;
  } else {
    const pctDisplay = e.pctMeta > 0 ? `${r2(e.pctMeta).toFixed(1)}% da meta` : 'sem meta';

    if (tipo === 'gerente' || tipo === 'sub')
      provRows += `<div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>`;

    provRows += `
      <div class="fp-field fp-field-inline">
        <label>Vendas (R$)</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
        <span class="fp-times">×</span>
        <input type="number" step="0.01" id="fp-comPct-${emp.id}" value="${r2(e.comissaoPct).toFixed(2)}"
          style="width:72px" onchange="onFieldChange(${emp.id})">
        <span class="fp-label-pct">%</span>
        ${faixaBadge(e.faixaLabel || '—')}
        <span class="fp-equals">=</span>
        <span class="fp-total-inline" id="fp-totalCom-${emp.id}">${brl(e.comissaoTotal)}</span>
        <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctDisplay}</span>
      </div>
      <div class="fp-split-box">
        <div class="fp-split-title">divisão para contabilidade — soma deve = total acima</div>
        <div class="fp-field fp-split-row">
          <label>Comissão (contab)</label>${inpRO(`fp-comissao-${emp.id}`, e.comissaoContab)}
          <span class="fp-split-hint">= Total − DSR − Prêmio</span>
        </div>
        <div class="fp-field fp-split-row">
          <label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}
          <span class="fp-split-hint">= contab × ${df} ÷ ${du}</span>
        </div>
        <div class="fp-field fp-split-row">
          <label>Prêmio (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}
        </div>
        <div class="fp-split-check" id="fp-splitCheck-${emp.id}"></div>
      </div>`;

    if (tipo === 'gerente' || tipo === 'sub') {
      const pctVR  = tipo === 'gerente' ? (ecfg.comissaoGerente||0) : (ecfg.comissaoVR||0);
      const lbl    = tipo === 'gerente'
        ? `Comissão Loja (${r2(pctVR).toFixed(2)}% vendas loja)`
        : `Comissão VR (${r2(pctVR).toFixed(2)}% vendas loja)`;
      provRows += `<div class="fp-field"><label>${lbl}</label>${inp(`fp-comLoja-${emp.id}`, e.comissaoLoja)}</div>`;
    }

    if ((cfg.garantiaMinima||0) > 0)
      provRows += `<div class="fp-field"><label>GM (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}
        <span style="font-size:.72rem;color:#8b949e">mín: ${brl(cfg.garantiaMinima||0)}</span></div>`;
  }

  provRows += `
    <div class="fp-field"><label>Feriado (R$)</label>${inp(`fp-feriado-${emp.id}`, e.feriado)}</div>
    <div class="fp-extras" id="extras-prov-${emp.id}">${buildExtraRows(emp.id, e.extras||[], 'prov')}</div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'prov')">+ Adicionar linha</button>`;

  const descRows = `
    <div class="fp-field"><label>Vale Compras (R$)</label>${inp(`fp-valeCompras-${emp.id}`, e.valeCompras)}</div>
    <div class="fp-field"><label>Adiantamento (R$)</label>${inp(`fp-adiantamento-${emp.id}`, e.adiantamento)}</div>
    <div class="fp-field"><label>INSS (R$)</label>${inp(`fp-inss-${emp.id}`, e.inss)}</div>
    <div class="fp-field"><label>IR FP (R$)</label>${inp(`fp-irpf-${emp.id}`, e.irpf)}</div>
    <div class="fp-field"><label>Vale Transporte (R$)</label>${inp(`fp-vt-${emp.id}`, e.vt)}</div>
    <div class="fp-field"><label>Arredondamento (R$)</label>${inp(`fp-arred-${emp.id}`, e.arredondamento)}</div>
    <div class="fp-extras" id="extras-desc-${emp.id}">${buildExtraRows(emp.id, e.extrasDesc||[], 'desc')}</div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'desc')">+ Adicionar desconto</button>`;

  return `
  <div class="fp-emp-form active" id="empform-${emp.id}">
    <div style="font-size:.75rem;color:#8b949e;margin-bottom:.75rem">
      ${emp.name} · ${emp.cargo}
      ${ecfg.inssRate ? ` · INSS ${ecfg.inssRate}%` : ''}${ecfg.vtRate ? ` · VT ${ecfg.vtRate}%` : ''}
      ${emp.banco ? ` · Banco ${emp.banco} / Cta ${emp.conta||'—'}` : ''}
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
        ${emp.banco?`<div style="font-size:.72rem;color:#8b949e">Banco ${emp.banco} · Cta ${emp.conta||'—'}</div>`:''}
      </div>
      <span class="fp-liquido-val" id="val-liquido-${emp.id}">${brl(e.liquido)}</span>
    </div>
    ${buildEmpCfgSection(emp, ecfg, tipo)}
  </div>`;
}

function buildEmpCfgSection(emp, ecfg, tipo) {
  const hasFolha = Object.keys(FP.empConfig[emp.id] || {}).length > 0;
  const src = hasFolha
    ? '<span style="color:#3fb950">● valores da folha</span>'
    : '<span style="color:#484f58">valores do cadastro</span>';

  const inp = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}"
      style="width:88px;background:#21262d;border:1px solid #30363d;color:#e6edf3;
             padding:.2rem .4rem;border-radius:5px;font-size:.82rem;text-align:right">`;

  const row = (lbl, id, v) =>
    `<div class="fp-emp-cfg-row"><label>${lbl}</label>${inp(id, v)}</div>`;

  let fields = '';
  if (tipo === 'caixa') {
    fields =
      row('Salário Fixo (R$)',  `ec-salarioFixo-${emp.id}`,  ecfg.salarioFixo) +
      row('Quebra Caixa (R$)',  `ec-quebraCaixa-${emp.id}`,  ecfg.quebraCaixa) +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,     ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,       ecfg.vtRate);
  } else if (tipo === 'gerente') {
    fields =
      row('Comissão Loja (%)',  `ec-comissaoGerente-${emp.id}`, ecfg.comissaoGerente) +
      row('Salário Fixo (R$)',  `ec-salarioFixo-${emp.id}`,     ecfg.salarioFixo) +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,          ecfg.vtRate);
  } else {
    fields =
      row('Com. Sem Meta (%)',  `ec-comissaoSemMeta-${emp.id}`, ecfg.comissaoSemMeta) +
      row('Com. Meta 1 (%)',    `ec-comissao-${emp.id}`,        ecfg.comissao) +
      row('Com. Meta 2 (%)',    `ec-comissaoMeta2-${emp.id}`,   ecfg.comissaoMeta2) +
      row('Com. Super Meta (%)',`ec-comissaoSuper-${emp.id}`,   ecfg.comissaoSuper) +
      (tipo === 'sub' ? row('Comissão VR (%)',   `ec-comissaoVR-${emp.id}`,    ecfg.comissaoVR)    : '') +
      (tipo === 'sub' ? row('Salário Fixo (R$)', `ec-salarioFixo-${emp.id}`,  ecfg.salarioFixo)  : '') +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,          ecfg.vtRate);
  }

  return `
  <div class="fp-emp-cfg-wrap">
    <div class="fp-emp-cfg-toggle" onclick="fpToggleEmpCfg(${emp.id})">
      <span>⚙ Configuração</span>
      <span style="font-size:.72rem;font-weight:400">${src}</span>
      <span id="empCfgArrow-${emp.id}" style="margin-left:auto;font-size:.75rem">▼</span>
    </div>
    <div class="fp-emp-cfg" id="empCfg-${emp.id}">
      <div class="fp-emp-cfg-grid">${fields}</div>
      <div class="fp-emp-cfg-actions">
        <button class="fp-btn primary" onclick="fpSaveEmpCfg(${emp.id})">Salvar</button>
        ${hasFolha ? `<button class="fp-btn" onclick="fpClearEmpCfg(${emp.id})">Resetar para cadastro</button>` : ''}
      </div>
    </div>
  </div>`;
}

function fpToggleEmpCfg(empId) {
  const el    = document.getElementById(`empCfg-${empId}`);
  const arrow = document.getElementById(`empCfgArrow-${empId}`);
  const wrap  = el?.closest('.fp-emp-cfg-wrap');
  const open  = wrap?.classList.toggle('open');
  if (arrow) arrow.textContent = open ? '▲' : '▼';
}

async function fpSaveEmpCfg(empId) {
  const g   = id => { const el = document.getElementById(id); return el != null ? r2(parseFloat(el.value)||0) : null; };
  const emp = FP.employees.find(e => e.id === empId);
  if (!emp) return;
  const tipo = cargoTipo(emp.cargo);

  let cfg = { inssRate: g(`ec-inssRate-${empId}`), vtRate: g(`ec-vtRate-${empId}`) };
  if (tipo === 'caixa') {
    cfg.salarioFixo = g(`ec-salarioFixo-${empId}`);
    cfg.quebraCaixa = g(`ec-quebraCaixa-${empId}`);
  } else if (tipo === 'gerente') {
    cfg.comissaoGerente = g(`ec-comissaoGerente-${empId}`);
    cfg.salarioFixo     = g(`ec-salarioFixo-${empId}`);
  } else {
    cfg.comissaoSemMeta = g(`ec-comissaoSemMeta-${empId}`);
    cfg.comissao        = g(`ec-comissao-${empId}`);
    cfg.comissaoMeta2   = g(`ec-comissaoMeta2-${empId}`);
    cfg.comissaoSuper   = g(`ec-comissaoSuper-${empId}`);
    if (tipo === 'sub') cfg.comissaoVR    = g(`ec-comissaoVR-${empId}`);
    if (tipo === 'sub') cfg.salarioFixo  = g(`ec-salarioFixo-${empId}`);
  }

  try {
    await apiFetch(`/api/folha/empconfig/${empId}`, 'POST', cfg);
    FP.empConfig[empId] = cfg;
    const entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
    document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
    attachFormListeners(empId);
    toast('Configuração salva ✓');
  } catch (e) { toast('Erro: ' + e.message, true); }
}

async function fpClearEmpCfg(empId) {
  try {
    await apiFetch(`/api/folha/empconfig/${empId}`, 'POST', {});
    delete FP.empConfig[empId];
    const emp   = FP.employees.find(e => e.id === empId);
    const entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
    document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
    attachFormListeners(empId);
    toast('Resetado para valores do cadastro.');
  } catch (e) { toast('Erro: ' + e.message, true); }
}

function buildExtraRows(empId, extras, type) {
  return extras.map((ex,i) =>
    `<div class="fp-extra-row">
      <input type="text" placeholder="Descrição" value="${ex.nome||''}"
        onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="0.00" value="${r2(ex.valor).toFixed(2)}"
        onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`
  ).join('');
}

// ── Recalc ─────────────────────────────────────────────────────────────────
function recalc(empId) {
  const g     = id => { const el=document.getElementById(id); return el?r2(parseFloat(el.value)||0):0; };
  const emp   = FP.employees.find(e=>e.id===empId);
  const tipo  = cargoTipo(emp?.cargo);
  const entry = FP.folha[FP.board]?.entries?.[empId] || {};
  const du    = FP.mensal.diasUteis        || 22;
  const df    = FP.mensal.domingosFeriados || 4;

  let proventos = 0;

  if (tipo === 'caixa') {
    proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`);
  } else {
    const vendas   = g(`fp-vendas-${empId}`);
    const comPct   = g(`fp-comPct-${empId}`);
    const comTotal = r2(vendas * comPct / 100);

    const totEl = document.getElementById(`fp-totalCom-${empId}`);
    if (totEl) totEl.textContent = brl(comTotal);

    const dsrVal    = g(`fp-dsr-${empId}`);
    const premioVal = g(`fp-premio-${empId}`);
    const comContab = r2(comTotal - dsrVal - premioVal);

    const comEl = document.getElementById(`fp-comissao-${empId}`);
    if (comEl) comEl.value = comContab.toFixed(2);

    const checkEl = document.getElementById(`fp-splitCheck-${empId}`);
    if (checkEl) {
      const soma = r2(comContab + dsrVal + premioVal);
      const ok   = Math.abs(soma - comTotal) < 0.02;
      checkEl.innerHTML = ok
        ? `<span style="color:#3fb950;font-size:.75rem">✓ ${brl(comContab)} + ${brl(dsrVal)} + ${brl(premioVal)} = ${brl(comTotal)}</span>`
        : `<span style="color:#f85149;font-size:.75rem">⚠ soma ${brl(soma)} ≠ ${brl(comTotal)}</span>`;
    }

    proventos = r2(g(`fp-fixo-${empId}`) + comTotal + g(`fp-comLoja-${empId}`) + g(`fp-gm-${empId}`));
  }

  proventos = r2(proventos + g(`fp-feriado-${empId}`)
    + (entry.extras||[]).reduce((s,ex)=>s+r2(ex.valor),0));

  const descontos = r2(
    g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`) +
    g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`) +
    (entry.extrasDesc||[]).reduce((s,ex)=>s+r2(ex.valor),0)
  );

  const liquido = r2(proventos - descontos);
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=brl(v); };
  set(`val-proventos-${empId}`, proventos);
  set(`val-desc-${empId}`, descontos);
  set(`val-liquido-${empId}`, liquido);
}

function attachFormListeners(empId) {
  document.getElementById(`empform-${empId}`)
    ?.querySelectorAll('input[type=number]:not(.fp-readonly)')
    .forEach(inp => inp.addEventListener('input', ()=>onFieldChange(empId)));
}

function onFieldChange(empId) {
  FP.dirty = true;
  saveEntryFromForm(empId);
  recalc(empId);
}

function saveEntryFromForm(empId) {
  const g    = id => { const el=document.getElementById(id); return el?r2(parseFloat(el.value)||0):0; };
  const emp  = FP.employees.find(e=>e.id===empId);
  const tipo = cargoTipo(emp?.cargo);

  if (!FP.folha[FP.board]) FP.folha[FP.board] = { entries:{} };
  if (!FP.folha[FP.board].entries) FP.folha[FP.board].entries = {};
  const prev = FP.folha[FP.board].entries[empId] || {};

  const extProv = (prev.extras||[]).reduce((s,ex)=>s+r2(ex.valor),0);
  const extDesc = (prev.extrasDesc||[]).reduce((s,ex)=>s+r2(ex.valor),0);

  let proventos=0, comissaoTotal=0, comissaoContab=0, dsr=0, premio=0;

  if (tipo === 'caixa') {
    proventos = r2(g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`)
      + g(`fp-feriado-${empId}`) + extProv);
  } else {
    const vendas  = g(`fp-vendas-${empId}`);
    const comPct  = g(`fp-comPct-${empId}`);
    comissaoTotal  = r2(vendas * comPct / 100);
    dsr            = g(`fp-dsr-${empId}`);
    premio         = g(`fp-premio-${empId}`);
    comissaoContab = r2(comissaoTotal - dsr - premio);
    proventos = r2(g(`fp-fixo-${empId}`) + comissaoTotal
      + g(`fp-comLoja-${empId}`) + g(`fp-gm-${empId}`)
      + g(`fp-feriado-${empId}`) + extProv);
  }

  const totalDesc = r2(g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`)
    + g(`fp-arred-${empId}`) + extDesc);

  FP.folha[FP.board].entries[empId] = {
    ...prev, tipo,
    fixo:           g(`fp-fixo-${empId}`),
    quebra:         g(`fp-quebra-${empId}`),
    vendas:         g(`fp-vendas-${empId}`),
    comissaoPct:    g(`fp-comPct-${empId}`),
    faixaLabel:     prev.faixaLabel,
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja:   g(`fp-comLoja-${empId}`),
    gmComplement:   g(`fp-gm-${empId}`),
    feriado:        g(`fp-feriado-${empId}`),
    proventos,
    valeCompras:    g(`fp-valeCompras-${empId}`),
    adiantamento:   g(`fp-adiantamento-${empId}`),
    inss:           g(`fp-inss-${empId}`),
    irpf:           g(`fp-irpf-${empId}`),
    vt:             g(`fp-vt-${empId}`),
    arredondamento: g(`fp-arred-${empId}`),
    totalDescontos: totalDesc,
    liquido: r2(proventos - totalDesc),
  };
}

// ── Extras ─────────────────────────────────────────────────────────────────
function addExtra(empId, type) {
  const board = FP.board;
  if (!FP.folha[board]?.entries?.[empId]) {
    if (!FP.folha[board]) FP.folha[board] = {entries:{}};
    if (!FP.folha[board].entries) FP.folha[board].entries = {};
    FP.folha[board].entries[empId] = defaultEntry(FP.employees.find(e=>e.id===empId));
  }
  const key = type==='prov'?'extras':'extrasDesc';
  if (!FP.folha[board].entries[empId][key]) FP.folha[board].entries[empId][key] = [];
  FP.folha[board].entries[empId][key].push({nome:'',valor:0});
  FP.dirty = true;
  refreshExtras(empId, type);
}

function removeExtra(empId, type, idx) {
  const key = type==='prov'?'extras':'extrasDesc';
  FP.folha[FP.board]?.entries?.[empId]?.[key]?.splice(idx,1);
  FP.dirty = true;
  refreshExtras(empId, type);
  onFieldChange(empId);
}

function onExtraChange(empId, type, idx, field, value) {
  const key = type==='prov'?'extras':'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key];
  if (arr?.[idx]) arr[idx][field] = field==='valor'?r2(parseFloat(value)||0):value;
  FP.dirty = true;
}

function refreshExtras(empId, type) {
  const key = type==='prov'?'extras':'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key]||[];
  const c   = document.getElementById(`extras-${type}-${empId}`);
  if (c) c.innerHTML = buildExtraRows(empId, arr, type);
}

// ── Gerar ──────────────────────────────────────────────────────────────────
function fpGerar() {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = {};
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  for (const emp of boardEmps(board))
    FP.folha[board].entries[emp.id] = defaultEntry(emp);
  FP.dirty = true;
  renderPanel();
  toast('Folha gerada.');
}

// ── Salvar / Exportar ──────────────────────────────────────────────────────
async function fpSalvar() {
  if (!FP.board) return;
  for (const emp of boardEmps(FP.board)) saveEntryFromForm(emp.id);
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(FP.board);
    toast('Salvo.');
  } catch(e) { toast('Erro: '+e.message, true); }
}

async function fpExportar() {
  await fpSalvar();
  window.location.href = `/api/folha/${FP.year}/${FP.month}/export?board=${FP.board}`;
}

async function fpExportarContabilidade() {
  await fpSalvar();
  window.location.href = `/api/folha/${FP.year}/${FP.month}/contabilidade?board=${FP.board}`;
}

// ── Utils ──────────────────────────────────────────────────────────────────
function r2(v) { return Math.round((parseFloat(v)||0)*100)/100; }
function brl(v) { return 'R$ '+r2(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }

async function apiFetch(url, method='GET', body) {
  const opts = { method, headers:{} };
  if (body!==undefined) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) { if (res.status===401){location.href='/';return;} throw new Error(await res.text()||res.statusText); }
  return res.json();
}

let _toast;
function toast(msg, err) {
  const el = document.getElementById('fpToast');
  el.textContent = msg; el.style.display = 'block';
  el.style.borderColor = err?'#f85149':'#3fb950';
  clearTimeout(_toast); _toast = setTimeout(()=>el.style.display='none', 3000);
}
