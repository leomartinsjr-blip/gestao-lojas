'use strict';

const BOARDS_INFO = {
  delrey:   { label: 'DEL REY',   color: '#58A6FF' },
  minas:    { label: 'MINAS',     color: '#3FB950' },
  contagem: { label: 'CONTAGEM',  color: '#D29922' },
  estacao:  { label: 'ESTAÇÃO',   color: '#F85149' },
  tommy:    { label: 'TOMMY',     color: '#22D3EE' },
  lez:      { label: 'LEZ A LEZ', color: '#F472B6' },
  site:     { label: 'SITE',      color: '#A78BFA' },
};
const STORE_BOARDS = Object.keys(BOARDS_INFO);
const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function cargoTipo(cargo) {
  const c = (cargo || '').toLowerCase().trim();
  if (/caixa|opcx/.test(c))                    return 'caixa';
  if (/^sub.*gerente|sub[\s-]gerente/.test(c)) return 'sub';
  if (/g\.?\s*vend|gerente\s+vend/.test(c))    return 'gvend';
  if (/gerente/.test(c))                       return 'gerente';
  if (/supervisor|sócio|socio/.test(c))        return 'supervisor';
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
    inssRate:           v(fc.inssRate,           emp.inssRate           || 0),
    vtRate:             v(fc.vtRate,             emp.vtRate             || 0),
    maxVT:              v(fc.maxVT,              emp.maxVT              || 0),
    recebePremiaoLoja:   fc.recebePremiaoLoja  || false,
    premioLojaValor:     v(fc.premioLojaValor,     0),
    comissaoVRSemMeta:   v(fc.comissaoVRSemMeta,   0),
    comissaoVRMeta2:     v(fc.comissaoVRMeta2,     0),
    comissaoVRSuper:     v(fc.comissaoVRSuper,     0),
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
  supervisorVendaMap: {}, supervisorMetaMap: {},
  premiacaoSemanal: {}, premiacaoSemanalDetalhe: {},
  premiacaoSemanalGer: {}, premiacaoSemanalGerDetalhe: {}, prevExtras: {},
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
    FP.lojaMetaMap        = d.lojaMetaMap        || {};
    FP.lojaVendaMap       = d.lojaVendaMap       || {};
    FP.supervisorVendaMap = d.supervisorVendaMap || {};
    FP.supervisorMetaMap  = d.supervisorMetaMap  || {};
    FP.premiacaoSemanal           = d.premiacaoSemanal           || {};
    FP.premiacaoSemanalDetalhe    = d.premiacaoSemanalDetalhe    || {};
    FP.premiacaoSemanalGer        = d.premiacaoSemanalGer        || {};
    FP.premiacaoSemanalGerDetalhe = d.premiacaoSemanalGerDetalhe || {};
    FP.prevExtras              = d.prevExtras              || {};
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
      const enc   = !!(FP.folha[b]?.encerrada);
      return `<button class="fp-store-btn${b===active?' active':''}"
        style="--c:${BOARDS_INFO[b].color}" onclick="selectBoard('${b}')">
        ${BOARDS_INFO[b].label}${enc?' ⊠':saved?' ✓':''}
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
  const enc   = !!(FP.folha[board]?.encerrada);

  const actionBtns = enc
    ? `<button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
       <button class="fp-btn" onclick="fpExportarContabilidade()">Contabilidade</button>
       <button class="fp-btn reabrir" onclick="fpEncerrar()">Reabrir Folha</button>
       <button class="fp-btn" onclick="fpImprimirRecibos()">Recibos</button>`
    : `<button class="fp-btn" onclick="fpOpenCfg('${board}')">Configurar</button>
       <button class="fp-btn" onclick="fpGerar()">Gerar Folha</button>
       <button class="fp-btn warning" onclick="fpSalvar()">Salvar</button>
       <button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
       <button class="fp-btn" onclick="fpExportarContabilidade()">Contabilidade</button>
       <button class="fp-btn encerrar" onclick="fpEncerrar()">Encerrar Folha</button>
       <button class="fp-btn" disabled style="opacity:.35;cursor:not-allowed" title="Encerre a folha para imprimir recibos">Recibos</button>`;

  document.getElementById('fpPanel').innerHTML = `
    <div class="fp-panel${enc ? ' fp-panel-encerrada' : ''}">
      <div class="fp-panel-header">
        <span class="fp-panel-title" style="color:${info.color}">${info.label}</span>
        ${enc ? '<span style="font-size:.72rem;color:#3fb950;margin-left:.5rem">● Encerrada</span>' : '<div style="font-size:.72rem;color:#8b949e;margin-left:.4rem">vendas: Microvix</div>'}
        <div class="fp-panel-actions">${actionBtns}</div>
      </div>
      <div class="fp-emp-tabs" id="fpEmpTabs"></div>
      <div id="fpEmpForms"></div>
    </div>`;
  const emps = boardEmps(board);
  renderEmpTabs(emps);
  selectTotal();
}

function boardEmps(board) {
  return FP.employees.filter(e => e.board === board);
}

function buildTotalForm(emps) {
  if (!emps.length) return '<div style="padding:2rem;color:#8b949e;text-align:center">Nenhum funcionário nesta loja.</div>';
  let totalProv = 0, totalDesc = 0, totalLiq = 0;
  const rows = emps.map(emp => {
    let entry = FP.folha[FP.board]?.entries?.[emp.id] || defaultEntry(emp);
    const _ct = cargoTipo(emp.cargo);
    const _ecfg = getEmpCfg(emp);
    const calcPrem = _ct === 'gerente'
      ? r2(FP.premiacaoSemanalGer[emp.id] || 0)
      : r2(FP.premiacaoSemanal[emp.id] || 0);
    const calcPremGer = (_ct === 'gvend' || _ct === 'sub' || _ecfg.recebePremiaoLoja) ? r2(FP.premiacaoSemanalGer[emp.id] || 0) : 0;
    if (calcPrem !== r2(entry.premiacao || 0) || calcPremGer !== r2(entry.premiacaoBalanco || 0)) {
      entry = defaultEntry(emp);
    }
    totalProv += entry.proventos     || 0;
    totalDesc += entry.totalDescontos || 0;
    totalLiq  += entry.liquido        || 0;
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:.4rem .5rem;color:#e6edf3">${emp.apelido || emp.name.split(' ')[0]}</td>
      <td style="padding:.4rem .5rem;color:#8b949e;font-size:.78rem">${emp.cargo}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#e6edf3">${brl(entry.proventos||0)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#f85149">${brl(entry.totalDescontos||0)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#3fb950;font-weight:600">${brl(entry.liquido||0)}</td>
    </tr>`;
  }).join('');
  return `
  <div class="fp-emp-form active" id="empform-total" style="padding:.75rem 0">
    <table style="width:100%;border-collapse:collapse;font-size:.85rem">
      <thead>
        <tr style="border-bottom:2px solid #30363d">
          <th style="text-align:left;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Funcionário</th>
          <th style="text-align:left;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Cargo</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Proventos</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Descontos</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Líquido</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #30363d">
          <td colspan="2" style="padding:.5rem .5rem;color:#8b949e;font-size:.75rem;text-transform:uppercase;font-weight:700">TOTAL DA LOJA</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#e6edf3;font-weight:700">${brl(r2(totalProv))}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#f85149;font-weight:700">${brl(r2(totalDesc))}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#3fb950;font-weight:700">${brl(r2(totalLiq))}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function renderEmpTabs(emps) {
  const lojaData = FP.folha[FP.board] || {};
  const totalBtn = `<button id="tab-total" class="fp-emp-tab" onclick="selectTotal()">
    TOTAL <span style="font-size:.68rem;opacity:.6;margin-left:.2rem">loja</span>
  </button>`;
  document.getElementById('fpEmpTabs').innerHTML = totalBtn + emps.map(e => {
    const has = !!(lojaData.entries?.[e.id]);
    return `<button id="tab-${e.id}"
      class="fp-emp-tab${has?' has-data':''}${e.id===FP.activeEmpId?' active':''}"
      onclick="selectEmp(${e.id})">
      ${e.apelido || e.name.split(' ')[0]}
      <span style="font-size:.68rem;opacity:.6;margin-left:.2rem">${e.cargo}</span>
    </button>`;
  }).join('');
}

function selectTotal() {
  FP.activeEmpId = null;
  boardEmps(FP.board).forEach(e => document.getElementById(`tab-${e.id}`)?.classList.remove('active'));
  document.getElementById('tab-total')?.classList.add('active');
  document.getElementById('fpEmpForms').innerHTML = buildTotalForm(boardEmps(FP.board));
}

function selectEmp(empId) {
  FP.activeEmpId = empId;
  document.getElementById('tab-total')?.classList.remove('active');
  boardEmps(FP.board).forEach(e => {
    document.getElementById(`tab-${e.id}`)?.classList.toggle('active', e.id === empId);
  });
  const emp   = FP.employees.find(e => e.id === empId);
  let entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
  // Sempre aplica o valor calculado pelo servidor para premiação semanal
  const _ct2   = cargoTipo(emp.cargo);
  const _ecfg2 = getEmpCfg(emp);
  const calcPrem = _ct2 === 'gerente'
    ? r2(FP.premiacaoSemanalGer[empId] || 0)
    : r2(FP.premiacaoSemanal[empId] || 0);
  const calcPremGer2 = (_ct2 === 'gvend' || _ct2 === 'sub' || _ecfg2.recebePremiaoLoja) ? r2(FP.premiacaoSemanalGer[empId] || 0) : 0;
  if (calcPrem !== r2(entry.premiacao || 0)) {
    entry = { ...entry, premiacao: calcPrem };
  }
  if (calcPremGer2 !== r2(entry.premiacaoBalanco || 0)) {
    entry = { ...entry, premiacaoBalanco: calcPremGer2 };
  }
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
    const tipo   = cargoTipo(emp.cargo);
    const ecfg   = getEmpCfg(emp);
    const vs     = FP.vsales[emp.id] || {};
    const meta   = tipo === 'gerente' ? metaLoja : r2(vs.meta?.mensal || 0);
    const meta2  = r2(meta * 1.10);
    const super_ = r2(meta * 1.10 * 1.20);
    const vendas = tipo === 'gerente' ? vendaLoja : sumVendas(emp.id);
    const faixa  = calcFaixa(ecfg, vendas, meta);
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
      <div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid #30363d;display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem">
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Vendedor (R$)</label>
          <input type="number" step="0.01" id="cfg-gm" value="${f2(cfg.garantiaMinima)}">
        </div>
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Gerente (R$)</label>
          <input type="number" step="0.01" id="cfg-gmGerente" value="${f2(cfg.garantiaMinimaGerente)}">
        </div>
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Sub / G.Vend (R$)</label>
          <input type="number" step="0.01" id="cfg-gmSub" value="${f2(cfg.garantiaMinimaSubGerente)}">
        </div>
        <span style="font-size:.72rem;color:#484f58;grid-column:1/-1">fixo + comissão ≥ garantia mínima</span>
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
    garantiaMinima:           g('cfg-gm'),
    garantiaMinimaGerente:    g('cfg-gmGerente'),
    garantiaMinimaSubGerente: g('cfg-gmSub'),
    salarioFixoCaixa:         g('cfg-fixoCaixa'),
    quebraCaixa:              g('cfg-quebraCaixa'),
    premioVendedor:           g('cfg-premioVendedor'),
    premioGerente:            g('cfg-premioGerente'),
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

  const vs     = FP.vsales[emp.id] || {};
  const vendas = tipo === 'gerente'
    ? r2(FP.lojaVendaMap[FP.board] || 0)
    : tipo === 'supervisor'
      ? r2(FP.supervisorVendaMap[emp.id] || 0)
      : sumVendas(emp.id);
  const meta = tipo === 'gerente'
    ? r2(FP.lojaMetaMap[FP.board] || 0)
    : tipo === 'supervisor'
      ? r2(FP.supervisorMetaMap[emp.id] || 0)
      : r2(vs.meta?.mensal || 0);

  // ── Caixa ──
  if (tipo === 'caixa') {
    const fixo      = r2(cfg.salarioFixoCaixa || ecfg.salarioFixo || 0);
    const quebra    = r2(cfg.quebraCaixa      || ecfg.quebraCaixa  || 0);
    const vendaLoja = r2(FP.lojaVendaMap[FP.board] || 0);
    const comissaoLoja = ecfg.comissaoVR > 0 ? r2(vendaLoja * ecfg.comissaoVR / 100) : 0;
    const prov   = r2(fixo + quebra + comissaoLoja);
    const inss   = r2(prov * (ecfg.inssRate || 0) / 100);
    const vt     = r2(prov * (ecfg.vtRate   || 0) / 100);
    return {
      tipo, fixo, quebra, comissaoLoja, vendaLoja, feriado: 0, extras: [],
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

  // DSR = (comissaoContab + prêmio) / du × df  →  equivale a comissaoTotal × df / (du + df)
  const premio = r2((tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend' || tipo === 'supervisor')
    ? (cfg.premioGerente || 0) : (cfg.premioVendedor || 0));
  const dsr = (du + df) > 0 ? r2(comissaoTotal * df / (du + df)) : 0;
  const comissaoContab = r2(comissaoTotal - dsr - premio);

  const fixo = (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend' || tipo === 'supervisor')
    ? r2(ecfg.salarioFixo || 0)
    : 0;

  const gm = tipo === 'gerente'
    ? r2(cfg.garantiaMinimaGerente    || cfg.garantiaMinima || 0)
    : (tipo === 'sub' || tipo === 'gvend' || tipo === 'supervisor')
      ? r2(cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0)
      : r2(cfg.garantiaMinima || 0);
  const vendaLoja = r2(FP.lojaVendaMap[FP.board] || 0);
  let comissaoLoja = 0;
  if (ecfg.comissaoVR > 0 || (tipo === 'sub' && (ecfg.comissaoVRSemMeta || ecfg.comissaoVRMeta2 || ecfg.comissaoVRSuper))) {
    if (tipo === 'sub') {
      const lojaEcfg = {
        comissaoSemMeta: ecfg.comissaoVRSemMeta || ecfg.comissaoVR || 0,
        comissao:        ecfg.comissaoVR        || 0,
        comissaoMeta2:   ecfg.comissaoVRMeta2   || ecfg.comissaoVR || 0,
        comissaoSuper:   ecfg.comissaoVRSuper   || ecfg.comissaoVR || 0,
      };
      const metaLoja = r2(FP.lojaMetaMap[FP.board] || 0);
      const lojaFaixa = calcFaixa(lojaEcfg, vendaLoja, metaLoja);
      comissaoLoja = r2(vendaLoja * lojaFaixa.comPct / 100);
    } else {
      comissaoLoja = r2(vendaLoja * ecfg.comissaoVR / 100);
    }
  }

  const baseGm = fixo + comissaoTotal;
  const gmComplement = r2(Math.max(0, gm - baseGm));

  const _tipo = cargoTipo(emp.cargo);
  const premiacao = _tipo === 'gerente'
    ? r2(FP.premiacaoSemanalGer[emp.id] || 0)
    : r2(FP.premiacaoSemanal[emp.id] || 0);
  const premiacaoBalanco = (_tipo === 'gvend' || _tipo === 'sub' || ecfg.recebePremiaoLoja)
    ? r2(FP.premiacaoSemanalGer[emp.id] || 0)
    : 0;

  const proventos = r2(fixo + comissaoTotal + comissaoLoja + gmComplement + premiacao + premiacaoBalanco);
  const inss = r2(proventos * (ecfg.inssRate || 0) / 100);
  const vt   = r2(proventos * (ecfg.vtRate   || 0) / 100);

  return {
    tipo, vendas, meta, pctMeta, faixaLabel, comissaoPct,
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja, vendaLoja, fixo, gm, gmComplement,
    premiacao, premiacaoBalanco,
    feriado: 0,
    extras:     (FP.prevExtras[emp.id]?.extras     || []).map(x => ({ ...x, _prev: true })),
    proventos,
    valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
    arredondamento: 0,
    extrasDesc: (FP.prevExtras[emp.id]?.extrasDesc || []).map(x => ({ ...x, _prev: true })),
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

  const _comLojaRow = () => {
    const pctVR    = r2(ecfg.comissaoVR);
    const vLoja    = r2(e.vendaLoja || FP.lojaVendaMap[FP.board] || 0);
    const mLoja    = r2(FP.lojaMetaMap[FP.board] || 0);
    const lojaEcfgForFaixa = tipo === 'sub' ? {
      comissaoSemMeta: ecfg.comissaoVRSemMeta || ecfg.comissaoVR || 0,
      comissao:        ecfg.comissaoVR        || 0,
      comissaoMeta2:   ecfg.comissaoVRMeta2   || ecfg.comissaoVR || 0,
      comissaoSuper:   ecfg.comissaoVRSuper   || ecfg.comissaoVR || 0,
    } : { comissao: ecfg.comissaoVR || 0, comissaoSemMeta: ecfg.comissaoVR || 0 };
    const storeFaixa = calcFaixa(lojaEcfgForFaixa, vLoja, mLoja);
    const pctStr   = mLoja > 0 ? `${(vLoja / mLoja * 100).toFixed(1)}% da meta da loja` : 'sem meta da loja';
    return `<div class="fp-field fp-field-inline">
      <label>Comissão Loja</label>
      ${inpRO(`fp-vendaLoja-${emp.id}`, vLoja)}
      <span class="fp-times">×</span>
      <span style="font-size:.85rem;color:#8b949e;padding:.15rem .2rem">${storeFaixa.comPct.toFixed(2)}%</span>
      ${faixaBadge(storeFaixa.label)}
      <span class="fp-equals">=</span>
      ${inp(`fp-comLoja-${emp.id}`, e.comissaoLoja || 0)}
      <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctStr}</span>
    </div>`;
  };

  let provRows = '';

  if (tipo === 'caixa') {
    provRows = `
      <div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>
      <div class="fp-field"><label>Quebra de Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}</div>`;
    if ((ecfg.comissaoVR || 0) > 0) provRows += _comLojaRow();
    if (ecfg.recebePremiaoLoja) {
      const semGerDetC  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
      const semGerCalcC = r2(FP.premiacaoSemanalGer[emp.id] || 0);
      const semGerHintC = semGerDetC.length
        ? semGerDetC.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semGerCalcC > 0 ? `calculado: ${brl(semGerCalcC)}` : 'nenhuma meta semanal encontrada';
      provRows += `<div class="fp-field"><label>Premiação da Loja (R$)</label>${inp(`fp-premiacaoBalanco-${emp.id}`, e.premiacaoBalanco || 0)}
        <span style="font-size:.7rem;color:#484f58">${semGerHintC}</span></div>`;
    }
  } else {
    const pctDisplay = e.pctMeta > 0 ? `${r2(e.pctMeta).toFixed(1)}% da meta` : 'sem meta';

    if (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend')
      provRows += `<div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>`;

    provRows += `
      <div class="fp-field fp-field-inline">
        <label>${tipo === 'gerente' ? 'Vendas Loja (R$)' : (tipo === 'gvend' || tipo === 'sub') ? 'Vendas Próprias (R$)' : 'Vendas (R$)'}</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
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
        <div class="fp-split-title" style="cursor:pointer;user-select:none"
          onclick="(function(el){const c=el.nextElementSibling;const open=c.style.display!=='none';c.style.display=open?'none':'block';el.querySelector('.fp-split-arrow').textContent=open?'▶':'▼';})(this)">
          <span class="fp-split-arrow">▶</span> divisão para contabilidade
        </div>
        <div style="display:none">
          <div class="fp-field fp-split-row">
            <label>Comissão (contab)</label>${inpRO(`fp-comissao-${emp.id}`, e.comissaoContab)}
            <span class="fp-split-hint">= Total − DSR − Prêmio</span>
          </div>
          <div class="fp-field fp-split-row">
            <label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}
            <span class="fp-split-hint">= total × ${df} ÷ ${du + df}</span>
          </div>
          <div class="fp-field fp-split-row">
            <label>Prêmio (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}
          </div>
          <div class="fp-split-check" id="fp-splitCheck-${emp.id}"></div>
        </div>
      </div>`;

    if ((ecfg.comissaoVR || 0) > 0) provRows += _comLojaRow();

    const gmMin = tipo === 'gerente'
      ? (cfg.garantiaMinimaGerente    || cfg.garantiaMinima || 0)
      : (tipo === 'sub' || tipo === 'gvend')
        ? (cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0)
        : (cfg.garantiaMinima || 0);
    if (gmMin > 0) {
      const gmNote = (tipo === 'gvend' || tipo === 'sub')
        ? `mín: ${brl(gmMin)} (fixo + comissão própria)`
        : `mín: ${brl(gmMin)}`;
      provRows += `<div class="fp-field"><label>GM (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}
        <span style="font-size:.72rem;color:#8b949e">${gmNote}</span></div>`;
    }

    if (tipo === 'gerente') {
      const semGerDet  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
      const semGerCalc = r2(FP.premiacaoSemanalGer[emp.id] || 0);
      const semGerHint = semGerDet.length
        ? semGerDet.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semGerCalc > 0 ? `calculado: ${brl(semGerCalc)}` : 'nenhuma meta semanal encontrada';
      provRows += `<div class="fp-field"><label>Premiação Gerente (R$)</label>${inp(`fp-premiacao-${emp.id}`, e.premiacao || 0)}
        <span style="font-size:.7rem;color:#484f58">${semGerHint}</span></div>`;
    } else if (tipo === 'gvend' || tipo === 'sub' || ecfg.recebePremiaoLoja) {
      const semVendDet  = FP.premiacaoSemanalDetalhe[emp.id] || [];
      const semVendCalc = r2(FP.premiacaoSemanal[emp.id] || 0);
      const semVendHint = semVendDet.length
        ? semVendDet.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semVendCalc > 0 ? `calculado: ${brl(semVendCalc)}` : 'nenhuma meta semanal encontrada';
      if (tipo !== 'caixa') {
        provRows += `<div class="fp-field"><label>Premiação Vendedor (R$)</label>${inp(`fp-premiacao-${emp.id}`, e.premiacao || 0)}
          <span style="font-size:.7rem;color:#484f58">${semVendHint}</span></div>`;
      }
      const semGerDet2  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
      const semGerCalc2 = r2(FP.premiacaoSemanalGer[emp.id] || 0);
      const semGerHint2 = semGerDet2.length
        ? semGerDet2.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semGerCalc2 > 0 ? `calculado: ${brl(semGerCalc2)}` : 'nenhuma meta semanal encontrada';
      provRows += `<div class="fp-field"><label>Premiação da Loja (R$)</label>${inp(`fp-premiacaoBalanco-${emp.id}`, e.premiacaoBalanco || 0)}
        <span style="font-size:.7rem;color:#484f58">${semGerHint2}</span></div>`;
    } else {
      const semDetalhe = FP.premiacaoSemanalDetalhe[emp.id] || [];
      const semCalc    = r2(FP.premiacaoSemanal[emp.id] || 0);
      const semHint = semDetalhe.length
        ? semDetalhe.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semCalc > 0 ? `calculado: ${brl(semCalc)}` : 'nenhuma meta semanal encontrada';
      provRows += `<div class="fp-field"><label>Premiação (R$)</label>${inp(`fp-premiacao-${emp.id}`, e.premiacao || 0)}
        <span style="font-size:.7rem;color:#484f58">${semHint}</span></div>`;
    }
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
      row('Comissão Loja (%)',  `ec-comissaoVR-${emp.id}`,   ecfg.comissaoVR) +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,     ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,       ecfg.vtRate) +
      row('MAX. VT (R$)',       `ec-maxVT-${emp.id}`,        ecfg.maxVT);
  } else if (tipo === 'gerente') {
    fields =
      row('Com. Sem Meta (%)',   `ec-comissaoSemMeta-${emp.id}`, ecfg.comissaoSemMeta) +
      row('Com. Meta 1 (%)',     `ec-comissao-${emp.id}`,        ecfg.comissao) +
      row('Com. Meta 2 (%)',     `ec-comissaoMeta2-${emp.id}`,   ecfg.comissaoMeta2) +
      row('Com. Super Meta (%)', `ec-comissaoSuper-${emp.id}`,   ecfg.comissaoSuper) +
      row('Comissão Loja (%)',   `ec-comissaoVR-${emp.id}`,      ecfg.comissaoVR) +
      row('Salário Fixo (R$)',   `ec-salarioFixo-${emp.id}`,     ecfg.salarioFixo) +
      row('INSS (%)',            `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',              `ec-vtRate-${emp.id}`,          ecfg.vtRate) +
      row('MAX. VT (R$)',        `ec-maxVT-${emp.id}`,           ecfg.maxVT);
  } else {
    fields =
      row('Com. Sem Meta (%)',  `ec-comissaoSemMeta-${emp.id}`, ecfg.comissaoSemMeta) +
      row('Com. Meta 1 (%)',    `ec-comissao-${emp.id}`,        ecfg.comissao) +
      row('Com. Meta 2 (%)',    `ec-comissaoMeta2-${emp.id}`,   ecfg.comissaoMeta2) +
      row('Com. Super Meta (%)',`ec-comissaoSuper-${emp.id}`,   ecfg.comissaoSuper) +
      row('Com. Loja Meta 1 (%)', `ec-comissaoVR-${emp.id}`,          ecfg.comissaoVR) +
      (tipo === 'sub' ?
        row('Com. Loja S/Meta (%)', `ec-comissaoVRSemMeta-${emp.id}`, ecfg.comissaoVRSemMeta) +
        row('Com. Loja Meta 2 (%)', `ec-comissaoVRMeta2-${emp.id}`,   ecfg.comissaoVRMeta2) +
        row('Com. Loja S.Meta (%)', `ec-comissaoVRSuper-${emp.id}`,   ecfg.comissaoVRSuper)
      : '') +
      (tipo === 'sub' || tipo === 'gvend' ? row('Salário Fixo (R$)', `ec-salarioFixo-${emp.id}`, ecfg.salarioFixo) : '') +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,          ecfg.vtRate) +
      row('MAX. VT (R$)',       `ec-maxVT-${emp.id}`,           ecfg.maxVT);
  }

  const chkPremiaoLoja = `<div class="fp-emp-cfg-row fp-emp-cfg-row--check">
    <label>Prêmio da loja?</label>
    <input type="checkbox" id="ec-recebePremiaoLoja-${emp.id}"${ecfg.recebePremiaoLoja ? ' checked' : ''}
      style="width:16px;height:16px;accent-color:#3fb950;cursor:pointer">
  </div>` + row('Valor prêm. loja/sem. (R$)', `ec-premioLojaValor-${emp.id}`, ecfg.premioLojaValor);

  return `
  <div class="fp-emp-cfg-wrap">
    <div class="fp-emp-cfg-toggle" onclick="fpToggleEmpCfg(${emp.id})">
      <span>⚙ Configuração</span>
      <span style="font-size:.72rem;font-weight:400">${src}</span>
      <span id="empCfgArrow-${emp.id}" style="margin-left:auto;font-size:.75rem">▼</span>
    </div>
    <div class="fp-emp-cfg" id="empCfg-${emp.id}">
      <div class="fp-emp-cfg-grid">${fields}${chkPremiaoLoja}</div>
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

  let cfg = { inssRate: g(`ec-inssRate-${empId}`), vtRate: g(`ec-vtRate-${empId}`), maxVT: g(`ec-maxVT-${empId}`) };
  if (tipo === 'caixa') {
    cfg.salarioFixo = g(`ec-salarioFixo-${empId}`);
    cfg.quebraCaixa = g(`ec-quebraCaixa-${empId}`);
    cfg.comissaoVR  = g(`ec-comissaoVR-${empId}`);
  } else if (tipo === 'gerente') {
    cfg.comissaoSemMeta = g(`ec-comissaoSemMeta-${empId}`);
    cfg.comissao        = g(`ec-comissao-${empId}`);
    cfg.comissaoMeta2   = g(`ec-comissaoMeta2-${empId}`);
    cfg.comissaoSuper   = g(`ec-comissaoSuper-${empId}`);
    cfg.comissaoVR      = g(`ec-comissaoVR-${empId}`);
    cfg.salarioFixo     = g(`ec-salarioFixo-${empId}`);
  } else {
    cfg.comissaoSemMeta = g(`ec-comissaoSemMeta-${empId}`);
    cfg.comissao        = g(`ec-comissao-${empId}`);
    cfg.comissaoMeta2   = g(`ec-comissaoMeta2-${empId}`);
    cfg.comissaoSuper   = g(`ec-comissaoSuper-${empId}`);
    cfg.comissaoVR      = g(`ec-comissaoVR-${empId}`);
    if (tipo === 'sub') {
      cfg.comissaoVRSemMeta = g(`ec-comissaoVRSemMeta-${empId}`);
      cfg.comissaoVRMeta2   = g(`ec-comissaoVRMeta2-${empId}`);
      cfg.comissaoVRSuper   = g(`ec-comissaoVRSuper-${empId}`);
    }
    if (tipo === 'sub' || tipo === 'gvend') cfg.salarioFixo  = g(`ec-salarioFixo-${empId}`);
  }
  cfg.recebePremiaoLoja = document.getElementById(`ec-recebePremiaoLoja-${empId}`)?.checked || false;
  cfg.premioLojaValor   = g(`ec-premioLojaValor-${empId}`);

  try {
    await apiFetch(`/api/folha/empconfig/${empId}`, 'POST', cfg);
    FP.empConfig[empId] = cfg;
    // Sempre recalcula via defaultEntry após mudança de config — garante
    // que premiacaoBalanco, comissão e demais derivados reflitam o novo config
    const entry = defaultEntry(emp);
    if (FP.folha[FP.board]?.entries?.[empId]) FP.folha[FP.board].entries[empId] = entry;
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
  return extras.map((ex,i) => {
    const isPrev = !!ex._prev;
    const rowStyle = isPrev ? 'border-left:2px solid #d29922;padding-left:.4rem;' : '';
    const hint = isPrev
      ? `<span title="Sugestão do mês anterior" style="font-size:.68rem;color:#d29922;white-space:nowrap">↩ mês ant.</span>`
      : '';
    return `<div class="fp-extra-row" style="${rowStyle}">
      ${hint}
      <input type="text" placeholder="Descrição" value="${ex.nome||''}"
        onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="0.00" value="${r2(ex.valor).toFixed(2)}"
        onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`;
  }).join('');
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
    proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`) + g(`fp-comLoja-${empId}`) + g(`fp-premiacaoBalanco-${empId}`);
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

    proventos = r2(g(`fp-fixo-${empId}`) + comTotal + g(`fp-comLoja-${empId}`) + g(`fp-gm-${empId}`)
      + g(`fp-premiacao-${empId}`) + g(`fp-premiacaoBalanco-${empId}`));
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
      + g(`fp-comLoja-${empId}`) + g(`fp-premiacaoBalanco-${empId}`) + g(`fp-feriado-${empId}`) + extProv);
  } else {
    const vendas  = g(`fp-vendas-${empId}`);
    const comPct  = g(`fp-comPct-${empId}`);
    comissaoTotal  = r2(vendas * comPct / 100);
    dsr            = g(`fp-dsr-${empId}`);
    premio         = g(`fp-premio-${empId}`);
    comissaoContab = r2(comissaoTotal - dsr - premio);
    proventos = r2(g(`fp-fixo-${empId}`) + comissaoTotal
      + g(`fp-comLoja-${empId}`) + g(`fp-gm-${empId}`)
      + g(`fp-premiacao-${empId}`) + g(`fp-premiacaoBalanco-${empId}`)
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
    comissaoLoja:      g(`fp-comLoja-${empId}`),
    gmComplement:      g(`fp-gm-${empId}`),
    premiacao:         g(`fp-premiacao-${empId}`),
    premiacaoBalanco:  g(`fp-premiacaoBalanco-${empId}`),
    feriado:           g(`fp-feriado-${empId}`),
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
  if (arr?.[idx]) {
    arr[idx][field] = field==='valor'?r2(parseFloat(value)||0):value;
    delete arr[idx]._prev; // user edited it — no longer a suggestion
  }
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
  if (FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(FP.board);
    toast('Salvo.');
  } catch(e) { toast('Erro: '+e.message, true); }
}

async function fpEncerrar() {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { entries: {} };
  const enc = FP.folha[board].encerrada;
  if (!enc && FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  FP.folha[board].encerrada = !enc;
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(board);
    renderPanel();
    if (FP.activeEmpId) {
      const emp = FP.employees.find(e => e.id === FP.activeEmpId);
      if (emp) selectEmp(emp.id);
    }
    toast(enc ? 'Folha reaberta.' : 'Folha encerrada ✓');
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

async function fpLogout() {
  try { await apiFetch('/api/logout', 'POST'); } catch {}
  location.href = '/';
}

// ── Recibos (impressão) ────────────────────────────────────────────────────
function fpImprimirRecibos() {
  if (!FP.board) { toast('Selecione uma loja.', true); return; }
  if (FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  const emps = boardEmps(FP.board).filter(e => FP.folha[FP.board]?.entries?.[e.id]);
  if (!emps.length) { toast('Gere a folha antes de imprimir.', true); return; }
  const mes    = MONTHS_PT[FP.month - 1].substring(0, 3) + '/' + String(FP.year).substring(2);
  const origin = window.location.origin;
  const pages  = emps.map((e, i) =>
    buildRecibo(e, FP.folha[FP.board].entries[e.id], mes, origin) +
    (i < emps.length - 1 ? '<div style="page-break-after:always"></div>' : '')
  ).join('');
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) { toast('Permita popups para imprimir.', true); return; }
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8">
<title>Recibos — ${BOARDS_INFO[FP.board]?.label} — ${mes}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#000;background:#fff}
@media print{@page{size:A4 portrait;margin:8mm 10mm}}
@media screen{.recibo{max-width:720px;margin:20px auto;padding:12px;border:1px solid #ccc;border-radius:4px}}
</style>
</head><body>${pages}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch(_) {} }, 600);
}

function buildRecibo(emp, entry, mes, origin) {
  const ecfg = getEmpCfg(emp);
  const tipo = entry.tipo || cargoTipo(emp.cargo);
  const cfg  = FP.folhaConfig[emp.board] || {};
  const loja = BOARDS_INFO[emp.board]?.label || emp.board.toUpperCase();
  const adm  = emp.admissao ? `ADM. ${emp.admissao}` : '';

  const num   = v => Math.round((parseFloat(v)||0)*100)/100;
  const fmt   = v => num(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const money = v => { const n=num(v); return n===0 ? 'R$&nbsp;-' : `R$&nbsp;${fmt(n)}`; };

  const tr = (label, val, base='', pct='', bold=false, bg='') =>
    `<tr${bg ? ` style="background:${bg}"` : ''}>` +
    `<td style="padding:2px 5px;${bold?'font-weight:700;':''}">${label}</td>` +
    `<td style="padding:2px 5px;text-align:right">${base !== '' && num(base) !== 0 ? `<strong>${fmt(num(base))}</strong>` : ''}</td>` +
    `<td style="padding:2px 5px;text-align:center;font-size:9pt">${pct}</td>` +
    `<td style="padding:2px 5px;text-align:right;white-space:nowrap">${money(val)}</td>` +
    `</tr>`;

  const gap = `<tr><td colspan="4" style="height:5px"></td></tr>`;
  const cols = `<colgroup><col style="width:54%"><col style="width:16%"><col style="width:11%"><col style="width:19%"></colgroup>`;
  const tbl  = `border-collapse:collapse;width:100%;border:1px solid #000;font-size:10pt;`;

  // ── Proventos ──
  let prov = '';
  if (tipo === 'caixa') {
    prov += tr('SALÁRIO FIXO',    entry.fixo   || 0, entry.fixo);
    prov += tr('QUEBRA DE CAIXA', entry.quebra || 0, entry.quebra);
  } else {
    if (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend')
      prov += tr('SALÁRIO FIXO', entry.fixo || 0, entry.fixo);
    const faixaColors = {'SEM META':'#888','META 1':'#b8860b','META 2':'#2e7d32','SUPER META':'#00838f'};
    const faixaLbl   = entry.faixaLabel || '—';
    const faixaClr   = faixaColors[faixaLbl] || '#888';
    const pctMeta    = num(entry.pctMeta) ||
      (num(entry.meta) > 0 ? Math.round(num(entry.vendas) / num(entry.meta) * 10) / 10 : 0);
    const infoParts  = [
      entry.comissaoPct ? fmt(entry.comissaoPct) + '% comissão' : '',
      pctMeta > 0       ? fmt(pctMeta) + '% da meta'            : '',
      faixaLbl !== '—'  ? faixaLbl                               : '',
    ].filter(Boolean).join('  ·  ');
    if (infoParts)
      prov += `<tr><td colspan="4" style="padding:1px 5px 0;font-size:8pt;color:${faixaClr};font-style:italic">${infoParts}</td></tr>`;
    prov +=
      `<tr>` +
      `<td style="padding:1px 5px 2px">${tipo === 'gerente' ? 'VENDAS LOJA' : (tipo === 'gvend' || tipo === 'sub') ? 'VENDAS PRÓPRIAS' : 'VENDAS'}</td>` +
      `<td style="padding:1px 5px 2px;text-align:right">${num(entry.vendas) ? `<strong>${fmt(num(entry.vendas))}</strong>` : ''}</td>` +
      `<td></td>` +
      `<td style="padding:1px 5px 2px;text-align:right;white-space:nowrap">${money(entry.comissaoTotal)}</td>` +
      `</tr>`;
    const gm = tipo === 'gerente'
      ? r2(cfg.garantiaMinimaGerente || cfg.garantiaMinima || 0)
      : (tipo === 'sub' || tipo === 'gvend')
        ? r2(cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0)
        : r2(cfg.garantiaMinima || 0);
    if (num(entry.gmComplement) > 0)
      prov += tr('GARANTIA SURFERS', entry.gmComplement, gm, '', false, '#fef9c3');
    if (num(entry.comissaoLoja) > 0)
      prov += tr((tipo === 'gvend' || tipo === 'sub') ? 'VENDAS DA LOJA' : 'COMISSÃO LOJA', entry.comissaoLoja, entry.vendaLoja,
        ecfg.comissaoVR ? fmt(ecfg.comissaoVR) + '%' : '');
    // Premiação: vendedor usa detalhe individual; gerente usa detalhe gerente; gvend ambos
    const _pTipo = tipo;
    const semDetVend = (_pTipo !== 'gerente') ? (FP.premiacaoSemanalDetalhe[emp.id] || []) : [];
    const semDetGer  = (_pTipo === 'gerente' || _pTipo === 'gvend' || _pTipo === 'sub' || ecfg.recebePremiaoLoja) ? (FP.premiacaoSemanalGerDetalhe[emp.id] || []) : [];
    const premTotal = num(entry.premiacao);
    if (premTotal > 0) {
      const semSumVend = semDetVend.reduce((s, x) => s + num(x.valor), 0);
      const useDetVend = semDetVend.length && Math.abs(semSumVend - premTotal) < 0.02;
      if (useDetVend) {
        const label = _pTipo === 'gvend' ? 'PREM. VEND.' : 'PREM.';
        semDetVend.forEach(s => prov += tr(`${label} SEM. ${s.label}`, s.valor));
      } else {
        prov += tr(_pTipo === 'gerente' ? 'PREM. GERENTE' : _pTipo === 'gvend' ? 'PREM. VENDEDOR' : 'PREMIAÇÃO', entry.premiacao);
      }
    }
    if (num(entry.premiacaoBalanco) > 0) {
      const semSumGer = semDetGer.reduce((s, x) => s + num(x.valor), 0);
      const useDetGer = semDetGer.length && Math.abs(semSumGer - num(entry.premiacaoBalanco)) < 0.02;
      if (useDetGer) {
        semDetGer.forEach(s => prov += tr(`PREM. GER. SEM. ${s.label}`, s.valor));
      } else {
        prov += tr('PREM. GERENTE', entry.premiacaoBalanco);
      }
    }
  }
  if (num(entry.feriado) > 0)
    prov += tr('FERIADO', entry.feriado);
  (entry.extras || []).forEach(ex => {
    if (num(ex.valor) !== 0)
      prov += tr((ex.nome || 'OUTROS').toUpperCase(), ex.valor, ex.valor);
  });

  // ── Descontos ──
  let desc = '';
  desc += tr('VALE COMPRAS',  entry.valeCompras  || 0);
  desc += tr('ADIANTAMENTO',  entry.adiantamento || 0);
  (entry.extrasDesc || []).forEach(ex => {
    if (num(ex.valor) !== 0)
      desc += tr((ex.nome || 'DESCONTO').toUpperCase(), ex.valor);
  });
  desc += tr('INSS',           entry.inss  || 0, '', ecfg.inssRate ? fmt(ecfg.inssRate) + '%' : '');
  desc += tr('IR FP',          entry.irpf  || 0);
  desc += tr('VALE TRANSPORTE',entry.vt    || 0, '', ecfg.vtRate   ? fmt(ecfg.vtRate)   + '%' : '');
  if (num(entry.arredondamento) !== 0)
    desc += tr('arred.', entry.arredondamento);

  const totRow = (lbl, val, bg) =>
    `<tfoot><tr style="background:${bg};border-top:1px solid #000">` +
    `<td colspan="3" style="padding:3px 5px;font-weight:700">${lbl}</td>` +
    `<td style="padding:3px 5px;text-align:right;font-weight:700;white-space:nowrap">R$&nbsp;${fmt(num(val))}</td>` +
    `</tr></tfoot>`;

  return `
<div class="recibo">
<table style="${tbl}border-bottom:none">
  <tr>
    <td style="width:105px;padding:6px 8px;border-right:1px solid #000;vertical-align:middle">
      <img src="${origin}/logosurfers.webp" alt="Surfer's" style="height:36px;width:auto;display:block">
    </td>
    <td style="padding:5px 8px;border-right:1px solid #000;vertical-align:middle;text-align:center">
      <div style="display:inline-block;border:1px solid #000;padding:3px 12px;font-weight:700;font-size:11pt;letter-spacing:.4px">${emp.name.toUpperCase()}</div>
      <div style="margin-top:3px;font-size:9pt"><u>Mês</u>&nbsp;${mes}&nbsp;&nbsp;&nbsp;<u>${emp.cargo.toUpperCase()}</u></div>
    </td>
    <td style="width:105px;padding:5px 8px;text-align:center;vertical-align:middle">
      <div style="font-weight:700;font-size:10pt">${loja}</div>
      <div style="font-size:8pt;margin-top:2px;color:#444">${adm}</div>
    </td>
  </tr>
  <tr><td colspan="3" style="text-align:center;padding:5px;border-top:1px solid #000;font-style:italic;font-size:9pt">"Um time, um objetivo, uma conquista."</td></tr>
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>${gap}${prov}${gap}</tbody>
  ${totRow('PROVENTOS', entry.proventos, '#d3d3d3')}
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>${gap}${desc}${gap}</tbody>
  ${totRow('TOTAL DESCONTOS', entry.totalDescontos, '#d3d3d3')}
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>
    <tr style="background:#bdbdbd">
      <td colspan="3" style="padding:5px 5px;font-weight:700;font-size:11pt">LÍQUIDO</td>
      <td style="padding:5px;text-align:right;font-weight:700;font-size:11pt;white-space:nowrap">R$&nbsp;${fmt(num(entry.liquido))}</td>
    </tr>
  </tbody>
</table>

<table style="${tbl}border-top:none;margin-top:-1px">
  <tr>
    <td style="width:90px;padding:8px;border-right:1px solid #000;vertical-align:bottom;text-align:center">
      <img src="${origin}/logosurfers.webp" alt="" style="height:42px;width:auto;display:block;margin:0 auto">
    </td>
    <td style="padding:8px 14px;vertical-align:top">
      <p style="font-size:8pt;line-height:1.45;margin-bottom:14px">Recebi a importância líquida constante no presente recibo individual de pagamento, dando, por este, plena e geral quitação, para nada mais reclamar com relação a salários vencidos e outros proventos do trabalho, inclusive por serviço extraordinário, até a presente data.</p>
      <div style="text-align:center">
        <div style="border-bottom:1px solid #000;width:55%;margin:0 auto"></div>
        <div style="font-style:italic;font-size:9pt;margin-top:3px">Assinatura do colaborador</div>
        <div style="font-size:9pt">___/___/${FP.year}</div>
      </div>
    </td>
  </tr>
</table>
</div>`;
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
