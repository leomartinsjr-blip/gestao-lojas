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
  const c = (cargo || '').toLowerCase();
  if (/caixa|opcx/.test(c))             return 'caixa';
  if (/sub[\s-]gerente|sub gerente/.test(c)) return 'sub';
  if (/gerente/.test(c))                return 'gerente';
  return 'vendedor';
}

// ── State ──────────────────────────────────────────────────────────────────
let FP = {
  year: 0, month: 0, board: '',
  employees: [], vsales: {},
  folha: {}, folhaConfig: {},
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
    FP.employees = d.employees || [];
    FP.vsales    = d.vsales    || {};
    FP.folha     = d.folha     || {};
    FP.folhaConfig = d.folhaConfig || {};
    renderStoreButtons('');
    document.getElementById('fpPanel').innerHTML =
      '<div class="fp-empty">Selecione uma loja para ver a folha.</div>';
  } catch(e) {
    document.getElementById('fpPanel').innerHTML =
      `<div class="fp-empty" style="color:#f85149">${e.message}</div>`;
  }
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
  const cfg = FP.folhaConfig[board] || {};
  const f2  = v => (parseFloat(v)||0).toFixed(2);
  document.getElementById('fpConfigModal').classList.add('open');
  document.getElementById('fpConfigModal').dataset.board = board;
  document.getElementById('fpConfigTabs').textContent =
    `Configuração — ${BOARDS_INFO[board].label}`;
  document.getElementById('fpConfigContents').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
      <div class="fp-cfg-field"><label>Comissão Vendedores (%)</label>
        <input type="number" step="0.01" id="cfg-comPct" value="${f2(cfg.comissaoPct??4.5)}">
      </div>
      <div class="fp-cfg-field"><label>Garantia Mínima (R$)</label>
        <input type="number" step="0.01" id="cfg-gm" value="${f2(cfg.garantiaMinima)}">
      </div>
      <div class="fp-cfg-field"><label>Salário Fixo Caixa (R$)</label>
        <input type="number" step="0.01" id="cfg-fixoCaixa" value="${f2(cfg.salarioFixoCaixa)}">
      </div>
      <div class="fp-cfg-field"><label>Quebra de Caixa (R$)</label>
        <input type="number" step="0.01" id="cfg-quebraCaixa" value="${f2(cfg.quebraCaixa)}">
      </div>
      <div class="fp-cfg-field"><label>Comissão Gerente (% loja)</label>
        <input type="number" step="0.01" id="cfg-comGerente" value="${f2(cfg.comissaoGerente??1)}">
      </div>
      <div class="fp-cfg-field"><label>Comissão VR (% loja)</label>
        <input type="number" step="0.01" id="cfg-comVR" value="${f2(cfg.comissaoVR??0.75)}">
      </div>
      <div class="fp-cfg-field"><label>Dias Úteis</label>
        <input type="number" id="cfg-diasUteis" value="${cfg.diasUteis||24}">
      </div>
      <div class="fp-cfg-field"><label>Domingos / Feriados</label>
        <input type="number" id="cfg-domingosFeriados" value="${cfg.domingosFeriados||5}">
      </div>
      <div class="fp-cfg-field"><label>Prêmio Vendedor (R$)</label>
        <input type="number" step="0.01" id="cfg-premioVendedor" value="${f2(cfg.premioVendedor)}">
      </div>
      <div class="fp-cfg-field"><label>Prêmio Gerente (R$)</label>
        <input type="number" step="0.01" id="cfg-premioGerente" value="${f2(cfg.premioGerente)}">
      </div>
    </div>`;
}

function fpCloseConfig() {
  document.getElementById('fpConfigModal').classList.remove('open');
}

async function fpSaveConfig() {
  const g  = id => parseFloat(document.getElementById(id)?.value) || 0;
  const board = document.getElementById('fpConfigModal').dataset.board;
  if (!board) return;
  FP.folhaConfig[board] = {
    comissaoPct:      g('cfg-comPct'),
    garantiaMinima:   g('cfg-gm'),
    salarioFixoCaixa: g('cfg-fixoCaixa'),
    quebraCaixa:      g('cfg-quebraCaixa'),
    comissaoGerente:  g('cfg-comGerente'),
    comissaoVR:       g('cfg-comVR'),
    diasUteis:        g('cfg-diasUteis'),
    domingosFeriados: g('cfg-domingosFeriados'),
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
function defaultEntry(emp) {
  const cfg  = FP.folhaConfig[FP.board] || {};
  const tipo = cargoTipo(emp.cargo);
  const du   = cfg.diasUteis        || 24;
  const df   = cfg.domingosFeriados || 5;
  const tot  = du + df;

  // Vendas do mês via Microvix (vsales.entries[].value)
  const vs     = FP.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
  const vendas = r2(Object.values(vs.entries||{}).reduce((s,e)=>s+(e.value||0),0));
  const meta   = vs.meta?.mensal || 0;

  // Vendas totais da loja (para comissão gerente/VR)
  const vendaLoja = r2(boardEmps(FP.board).reduce((s, e2) => {
    const v2 = FP.vsales[e2.id] || {};
    return s + Object.values(v2.entries||{}).reduce((a,en)=>a+(en.value||0),0);
  }, 0));

  if (tipo === 'caixa') {
    const fixo   = r2(cfg.salarioFixoCaixa || emp.salarioFixo || 0);
    const quebra = r2(cfg.quebraCaixa      || emp.quebraCaixa  || 0);
    const prov   = r2(fixo + quebra);
    const inss   = r2(prov * (emp.inssRate || 0) / 100);
    const vt     = r2(prov * (emp.vtRate   || 0) / 100);
    return {
      tipo, fixo, quebra, feriado: 0, extras: [],
      proventos: prov,
      valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
      arredondamento: 0, extrasDesc: [],
      totalDescontos: r2(inss+vt), liquido: r2(prov-inss-vt),
    };
  }

  // Vendedor / Gerente / Sub
  const comissaoPct  = r2(cfg.comissaoPct || emp.comissao || 4.5);
  const comissaoTotal = r2(vendas * comissaoPct / 100); // Total = Vendas × %

  // Split para contabilidade: Total = comissaoContab + DSR + Prêmio
  const premio      = r2(/gerente/.test(tipo) ? (cfg.premioGerente||0) : (cfg.premioVendedor||0));
  const dsr         = tot > 0 ? r2(comissaoTotal * df / tot) : 0;
  const comissaoContab = r2(comissaoTotal - dsr - premio); // resto para contabilidade

  // GM: se o total não atingiu a garantia mínima
  const gm          = r2(cfg.garantiaMinima || 0);
  const gmComplement = r2(Math.max(0, gm - comissaoTotal));

  // Comissão loja (gerente % sobre vendas totais / sub VR)
  let comissaoLoja = 0;
  if (tipo === 'gerente') comissaoLoja = r2(vendaLoja * (cfg.comissaoGerente||0) / 100);
  else if (tipo === 'sub') comissaoLoja = r2(vendaLoja * (cfg.comissaoVR||0) / 100);

  // Fixo para gerentes com salário fixo cadastrado
  const fixo = (tipo === 'gerente' && emp.salarioFixo) ? r2(emp.salarioFixo) : 0;

  // PROVENTOS: total_comissao + loja + gm + feriado + extras
  // (comissaoContab + DSR + premio já estão dentro de comissaoTotal)
  const proventos = r2(fixo + comissaoTotal + comissaoLoja + gmComplement);

  const inss = r2(proventos * (emp.inssRate || 0) / 100);
  const vt   = r2(proventos * (emp.vtRate   || 0) / 100);

  return {
    tipo, vendas, meta, comissaoPct,
    comissaoTotal, comissaoContab, dsr, premio, // split contabilidade
    comissaoLoja, fixo, gm, gmComplement,
    feriado: 0, extras: [],
    proventos,
    valeCompras: 0, adiantamento: 0, inss, irpf: 0, vt,
    arredondamento: 0, extrasDesc: [],
    totalDescontos: r2(inss+vt), liquido: r2(proventos-inss-vt),
  };
}

// ── Build form ─────────────────────────────────────────────────────────────
function buildEmpForm(emp, entry) {
  const e   = entry;
  const tipo = e.tipo || cargoTipo(emp.cargo);
  const cfg = FP.folhaConfig[FP.board] || {};

  // Input helper — sempre 2 casas decimais
  const inp = (id, v, extra='') =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" ${extra} onchange="onFieldChange(${emp.id})">`;
  const inpRO = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" readonly class="fp-readonly" tabindex="-1">`;

  let provRows = '';

  if (tipo === 'caixa') {
    provRows = `
      <div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>
      <div class="fp-field"><label>Quebra de Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}</div>`;
  } else {
    const pctMeta = (e.meta||0) > 0 ? ((e.vendas||0)/e.meta*100).toFixed(1)+'%' : '—';

    if (tipo==='gerente' && (e.fixo||0) > 0) {
      provRows += `<div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}</div>`;
    }

    // Vendas × %  → total
    provRows += `
      <div class="fp-field fp-field-inline">
        <label>Vendas (R$)</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
        <span class="fp-times">×</span>
        <input type="number" step="0.01" id="fp-comPct-${emp.id}" value="${r2(e.comissaoPct).toFixed(2)}" style="width:72px" onchange="onFieldChange(${emp.id})">
        <span class="fp-label-pct">%</span>
        <span class="fp-equals">=</span>
        <span class="fp-total-inline" id="fp-totalCom-${emp.id}">${brl(e.comissaoTotal)}</span>
        <span style="font-size:.72rem;color:#8b949e;margin-left:.3rem">${pctMeta} meta</span>
      </div>
      <div class="fp-split-box">
        <div class="fp-split-title">↳ divisão para contabilidade (soma = total acima)</div>
        <div class="fp-field fp-split-row">
          <label>Comissão (contab)</label>
          ${inpRO(`fp-comissao-${emp.id}`, e.comissaoContab)}
          <span class="fp-split-hint">= Total − DSR − Prêmio</span>
        </div>
        <div class="fp-field fp-split-row">
          <label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}
          <span class="fp-split-hint">auto: Total × ${cfg.domingosFeriados||5}/${(cfg.diasUteis||24)+(cfg.domingosFeriados||5)}</span>
        </div>
        <div class="fp-field fp-split-row">
          <label>Prêmio (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}
        </div>
        <div class="fp-split-check" id="fp-splitCheck-${emp.id}"></div>
      </div>`;

    if (tipo==='gerente' || tipo==='sub') {
      const lbl = tipo==='gerente'
        ? `Comissão Loja (${r2(cfg.comissaoGerente||0).toFixed(2)}% vendas loja)`
        : `Comissão VR (${r2(cfg.comissaoVR||0).toFixed(2)}% vendas loja)`;
      provRows += `<div class="fp-field"><label>${lbl}</label>${inp(`fp-comLoja-${emp.id}`, e.comissaoLoja)}</div>`;
    }

    if ((e.gm||0) > 0) {
      provRows += `<div class="fp-field"><label>GM Surfers (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}
        <span style="font-size:.72rem;color:#8b949e">GM: ${brl(e.gm)}</span></div>`;
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
      ${emp.inssRate ? ` · INSS ${emp.inssRate}%` : ''}${emp.vtRate ? ` · VT ${emp.vtRate}%` : ''}
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
  </div>`;
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
  const g    = id => { const el=document.getElementById(id); return el?r2(parseFloat(el.value)||0):0; };
  const emp  = FP.employees.find(e=>e.id===empId);
  const tipo = cargoTipo(emp?.cargo);
  const cfg  = FP.folhaConfig[FP.board] || {};
  const entry = FP.folha[FP.board]?.entries?.[empId] || {};
  const du   = cfg.diasUteis        || 24;
  const df   = cfg.domingosFeriados || 5;
  const tot  = du + df;

  let proventos = 0;

  if (tipo === 'caixa') {
    proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`);
  } else {
    const vendas    = g(`fp-vendas-${empId}`);
    const comPct    = g(`fp-comPct-${empId}`);
    const comTotal  = r2(vendas * comPct / 100);

    // Update total display
    const totEl = document.getElementById(`fp-totalCom-${empId}`);
    if (totEl) totEl.textContent = brl(comTotal);

    // DSR and Premio (user can edit; comissaoContab = total - dsr - premio)
    const dsrVal    = g(`fp-dsr-${empId}`);
    const premioVal = g(`fp-premio-${empId}`);
    const comContab = r2(comTotal - dsrVal - premioVal);

    // Update readonly comissao field
    const comEl = document.getElementById(`fp-comissao-${empId}`);
    if (comEl) comEl.value = comContab.toFixed(2);

    // Split check indicator
    const checkEl = document.getElementById(`fp-splitCheck-${empId}`);
    if (checkEl) {
      const soma = r2(comContab + dsrVal + premioVal);
      const ok   = Math.abs(soma - comTotal) < 0.01;
      checkEl.innerHTML = ok
        ? `<span style="color:#3fb950">✓ ${brl(comContab)} + ${brl(dsrVal)} + ${brl(premioVal)} = ${brl(comTotal)}</span>`
        : `<span style="color:#f85149">⚠ soma ${brl(soma)} ≠ ${brl(comTotal)}</span>`;
    }

    const fixo      = g(`fp-fixo-${empId}`);
    const comLoja   = g(`fp-comLoja-${empId}`);
    const gmComp    = g(`fp-gm-${empId}`);
    proventos = r2(fixo + comTotal + comLoja + gmComp);
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
  const cfg  = FP.folhaConfig[FP.board] || {};
  const du   = cfg.diasUteis        || 24;
  const df   = cfg.domingosFeriados || 5;
  const tot  = du + df;

  if (!FP.folha[FP.board]) FP.folha[FP.board] = { entries:{} };
  if (!FP.folha[FP.board].entries) FP.folha[FP.board].entries = {};
  const prev = FP.folha[FP.board].entries[empId] || {};

  const extProv = (prev.extras||[]).reduce((s,ex)=>s+r2(ex.valor),0);
  const extDesc = (prev.extrasDesc||[]).reduce((s,ex)=>s+r2(ex.valor),0);

  let proventos = 0, comissaoTotal=0, comissaoContab=0, dsr=0, premio=0;

  if (tipo === 'caixa') {
    proventos = r2(g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`)
      + g(`fp-feriado-${empId}`) + extProv);
  } else {
    const vendas  = g(`fp-vendas-${empId}`);
    const comPct  = g(`fp-comPct-${empId}`);
    comissaoTotal = r2(vendas * comPct / 100);
    dsr           = g(`fp-dsr-${empId}`);
    premio        = g(`fp-premio-${empId}`);
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
    fixo:          g(`fp-fixo-${empId}`),
    quebra:        g(`fp-quebra-${empId}`),
    vendas:        g(`fp-vendas-${empId}`),
    comissaoPct:   g(`fp-comPct-${empId}`),
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja:  g(`fp-comLoja-${empId}`),
    gmComplement:  g(`fp-gm-${empId}`),
    feriado:       g(`fp-feriado-${empId}`),
    proventos,
    valeCompras:   g(`fp-valeCompras-${empId}`),
    adiantamento:  g(`fp-adiantamento-${empId}`),
    inss:          g(`fp-inss-${empId}`),
    irpf:          g(`fp-irpf-${empId}`),
    vt:            g(`fp-vt-${empId}`),
    arredondamento:g(`fp-arred-${empId}`),
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
  const cfg   = FP.folhaConfig[board] || {};
  if (!FP.folha[board]) FP.folha[board] = {};
  FP.folha[board].diasUteis        = cfg.diasUteis        || 24;
  FP.folha[board].domingosFeriados = cfg.domingosFeriados || 5;
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
