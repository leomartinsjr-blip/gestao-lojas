// ── Vendas por Marca / Setor ─────────────────────────────────────────────────
const STORE_BOARDS = {
  delrey:   { label: 'DEL REY',   color: '#58A6FF' },
  minas:    { label: 'MINAS',     color: '#3FB950' },
  contagem: { label: 'CONTAGEM',  color: '#D29922' },
  estacao:  { label: 'ESTAÇÃO',   color: '#F85149' },
  tommy:    { label: 'TOMMY',     color: '#22D3EE' },
  lez:      { label: 'LEZ A LEZ', color: '#F472B6' },
};

const fBRL = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fNum = v => Number(v).toLocaleString('pt-BR');
const fDate = s => s ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : '';
const pad = n => String(n).padStart(2, '0');

let me = null;
let apiData = null;
let stockData = null;
let stockMap = {};   // marca.toUpperCase() → estoque entry
let viewMode = 'marca'; // 'marca' | 'setor'
const expanded = new Set();

async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }
  me = await r.json();

  const isAdmin = !me.board || me.board === 'escritorio';
  const boardSel = document.getElementById('boardSel');
  if (isAdmin) {
    boardSel.style.display = '';
    boardSel.innerHTML =
      '<option value="surfers">Total Surfers</option>' +
      Object.entries(STORE_BOARDS).map(([k,v]) =>
        `<option value="${k}">${v.label}</option>`).join('');
  }

  setShortcut('mes');

  document.querySelectorAll('[data-s]').forEach(btn =>
    btn.addEventListener('click', () => setShortcut(btn.dataset.s)));

  document.getElementById('searchBtn').addEventListener('click', fetchData);

  document.querySelectorAll('.mx-inp').forEach(inp =>
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') fetchData(); }));

  // Toggle Por Marca / Por Setor
  document.querySelectorAll('.mx-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll('.mx-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewMode));
      expanded.clear();
      if (apiData) render();
    });
  });
}

function setShortcut(s) {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
  let ini, fin;
  if (s === 'mes') {
    ini = `${y}-${pad(m)}-01`;
    fin = `${y}-${pad(m)}-${pad(d)}`;
  } else if (s === 'mesant') {
    const lm = m === 1 ? 12 : m - 1;
    const ly = m === 1 ? y - 1 : y;
    const lastDay = new Date(ly, lm, 0).getDate();
    ini = `${ly}-${pad(lm)}-01`;
    fin = `${ly}-${pad(lm)}-${pad(lastDay)}`;
  } else if (s === '30d') {
    const d30 = new Date(today); d30.setDate(d30.getDate() - 30);
    ini = d30.toISOString().slice(0, 10);
    fin = today.toISOString().slice(0, 10);
  } else if (s === '3m') {
    const d3m = new Date(today); d3m.setMonth(d3m.getMonth() - 3);
    ini = d3m.toISOString().slice(0, 10);
    fin = today.toISOString().slice(0, 10);
  }
  document.getElementById('dtIni').value = ini;
  document.getElementById('dtFin').value = fin;
}

async function fetchData() {
  const dtIni = document.getElementById('dtIni').value;
  const dtFin = document.getElementById('dtFin').value;
  const board = document.getElementById('boardSel').value;
  if (!dtIni || !dtFin) { showError('Selecione o período.'); return; }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  showLoading();

  try {
    const params = new URLSearchParams({ dtIni, dtFin });
    if (board === 'surfers') params.set('boards', 'surfers');
    else if (board) params.set('board', board);

    // Fetch vendas e estoque em paralelo
    const [salesRes, stockRes] = await Promise.all([
      fetch('/api/relatorio-marcas?' + params),
      fetch('/api/estoque-marcas?' + params),
    ]);

    if (!salesRes.ok) {
      let msg = `Erro ${salesRes.status}`;
      try { msg = (await salesRes.json()).error || msg; } catch {}
      showError(msg); return;
    }
    apiData    = await salesRes.json();
    stockData  = stockRes.ok ? await stockRes.json() : null;
    stockMap   = {};
    if (stockData && stockData.estoque) {
      for (const e of stockData.estoque) stockMap[e.marca.toUpperCase()] = e;
    }
    expanded.clear();
    render();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Inverte a hierarquia: setor → marcas → produtos ──────────────────────────
function buildSetorView(marcas) {
  const bySetor = {};
  for (const m of marcas) {
    for (const s of (m.setores || [])) {
      const sKey = s.setor.toUpperCase();
      if (!bySetor[sKey]) bySetor[sKey] = { setor: s.setor, qtd: 0, valor: 0, marcas: {} };
      bySetor[sKey].qtd   += s.qtd;
      bySetor[sKey].valor += s.valor;
      const mKey = m.marca.toUpperCase();
      if (!bySetor[sKey].marcas[mKey])
        bySetor[sKey].marcas[mKey] = { marca: m.marca, qtd: 0, valor: 0, produtos: [] };
      bySetor[sKey].marcas[mKey].qtd   += s.qtd;
      bySetor[sKey].marcas[mKey].valor += s.valor;
      bySetor[sKey].marcas[mKey].produtos.push(...s.produtos);
    }
  }
  return Object.values(bySetor)
    .map(s => ({
      ...s,
      valor: parseFloat(s.valor.toFixed(2)),
      marcas: Object.values(s.marcas)
        .map(m => ({ ...m, valor: parseFloat(m.valor.toFixed(2)) }))
        .sort((a, b) => b.valor - a.valor),
    }))
    .sort((a, b) => b.valor - a.valor);
}

function render() {
  const marcas = (apiData.marcas || []).sort((a, b) => b.valor - a.valor);
  const totalValor = marcas.reduce((s, m) => s + m.valor, 0);
  const totalPecas = marcas.reduce((s, m) => s + m.qtd,   0);

  const boardsLabel = apiData.boards && apiData.boards.length < 6
    ? (apiData.boards.length === 4 && apiData.boards.includes('delrey') ? 'Total Surfers' : apiData.boards.map(b => (STORE_BOARDS[b]||{label:b}).label).join(', '))
    : 'Todas as lojas';

  document.getElementById('sumValor').textContent   = fBRL(totalValor);
  document.getElementById('sumPecas').textContent   = fNum(totalPecas) + ' pcs';
  document.getElementById('sumMarcas').textContent  = viewMode === 'marca' ? marcas.length : buildSetorView(marcas).length;
  document.getElementById('sumMarcasLabel').textContent = viewMode === 'marca' ? 'Marcas' : 'Setores';
  document.getElementById('sumPeriodo').textContent = fDate(apiData.dtIni) + ' → ' + fDate(apiData.dtFin) + ' · ' + boardsLabel;
  document.getElementById('summaryStrip').style.display = '';

  const state = document.getElementById('stateBox');
  if (!marcas.length) {
    state.innerHTML = 'Nenhuma venda encontrada para o período.';
    state.style.display = '';
    document.getElementById('brandList').innerHTML = '';
    return;
  }
  state.style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  if (viewMode === 'setor') renderPorSetor(marcas, totalValor);
  else                      renderPorMarca(marcas, totalValor);
}

// ── Render Por Marca ──────────────────────────────────────────────────────────
function renderPorMarca(marcas, totalValor) {
  const maxValor = marcas.length ? marcas[0].valor : 1;
  const list = document.getElementById('brandList');

  list.innerHTML = marcas.map((m, i) => {
    const pct    = totalValor > 0 ? ((m.valor / totalValor) * 100).toFixed(1) : '0.0';
    const barPct = totalValor > 0 ? ((m.valor / maxValor)   * 100).toFixed(1) : '0';
    const isOpen = expanded.has(m.marca);

    // Dados de estoque desta marca
    const se      = stockData ? stockMap[m.marca.toUpperCase()] : null;
    const lojas   = se ? se.lojas : [];
    const ssMap   = {};
    if (se) (se.setores || []).forEach(x => { ssMap[x.setor.toUpperCase()] = x.lojas; });
    const n       = lojas.length;
    const colW    = n <= 3 ? 38 : n <= 4 ? 34 : n <= 5 ? 30 : 27;
    const colAttr = n ? ` style="--sb-col-w:${colW}px"` : '';

    const stCols = (arr) => {
      const m2 = {}; (arr || []).forEach(x => { m2[x.board] = x.qtd; });
      return lojas.map(l => `<span class="mx-st-col">${m2[l.board] != null ? fNum(m2[l.board]) : '—'}</span>`).join('');
    };

    const stBlock = n ? `
      <div class="mx-st-block">
        <div class="mx-st-lbl-row">${lojas.map(l => `<span class="mx-st-col" style="color:${l.color}">${abbr(l.label)}</span>`).join('')}</div>
        <div class="mx-st-tot-row">${lojas.map(l => `<span class="mx-st-col">${fNum(l.qtd)}</span>`).join('')}</div>
      </div>` : '';

    // Refs de estoque por setor
    const refsMap = {};
    if (se) (se.setores || []).forEach(ss => { refsMap[ss.setor.toUpperCase()] = ss.refs; });

    const setoresHtml = (m.setores || []).map(s => {
      const sKey     = m.marca + '\x00' + s.setor;
      const sOpen    = expanded.has(sKey);
      const pctMarca = m.valor > 0 ? ((s.valor / m.valor) * 100).toFixed(1) : '0.0';
      const stSetor  = n ? `<div class="mx-st-setor">${stCols(ssMap[s.setor.toUpperCase()])}</div>` : '';
      return `
        <div class="mx-setor-row${sOpen ? ' open' : ''}" data-skey="${_esc(sKey)}">
          <div class="mx-setor-hdr">
            <span class="mx-setor-chevron">▶</span>
            <span class="mx-setor-name">${_esc(s.setor)}</span>
            <span class="mx-setor-val">${fBRL(s.valor)}</span>
            <span class="mx-setor-pecas">${fNum(s.qtd)} pcs</span>
            <span class="mx-setor-pct" title="% da marca">${pctMarca}%</span>
            ${stSetor}
          </div>
          <div class="mx-setor-prods">${prodTable(s.produtos, refsMap[s.setor.toUpperCase()], lojas)}</div>
        </div>`;
    }).join('');

    return `
      <div class="mx-brand-card${isOpen ? ' open' : ''}" data-marca="${_esc(m.marca)}"${colAttr}>
        <div class="mx-brand-hdr">
          <span class="mx-brand-rank">#${i + 1}</span>
          <span class="mx-brand-name" title="${_esc(m.marca)}">${_esc(m.marca)}</span>
          <div class="mx-brand-right">
            <span class="mx-brand-val">${fBRL(m.valor)}</span>
            <span class="mx-brand-pecas">${fNum(m.qtd)} pcs</span>
            <span class="mx-brand-chevron">▼</span>
          </div>
          ${stBlock}
        </div>
        <div class="mx-bar-wrap">
          <div class="mx-bar-row">
            <div class="mx-bar-track"><div class="mx-bar-fill" style="width:${barPct}%"></div></div>
            <span class="mx-bar-pct">${pct}%</span>
          </div>
        </div>
        <div class="mx-prod-wrap">${setoresHtml}</div>
      </div>`;
  }).join('');

  wireEvents(list);
}

// ── Render Por Setor ──────────────────────────────────────────────────────────
function renderPorSetor(marcas, totalValor) {
  const setores  = buildSetorView(marcas);
  const maxValor = setores.length ? setores[0].valor : 1;
  const list     = document.getElementById('brandList');

  // Agrega estoque por setor × loja a partir do stockMap
  const refLojas = stockData ? (Object.values(stockMap)[0]?.lojas || []) : [];
  const setorStock = {};
  if (stockData) {
    Object.entries(stockMap).forEach(([marcaUp, entry]) => {
      (entry.setores || []).forEach(ss => {
        const sk = ss.setor.toUpperCase();
        if (!setorStock[sk]) setorStock[sk] = { totals: {}, byMarca: {} };
        const se = setorStock[sk];
        (ss.lojas || []).forEach(l => { se.totals[l.board] = (se.totals[l.board] || 0) + (l.qtd || 0); });
        const bMap = {};
        (ss.lojas || []).forEach(l => { bMap[l.board] = l.qtd; });
        se.byMarca[marcaUp] = bMap;
      });
    });
  }

  const n       = refLojas.length;
  const colW    = n <= 3 ? 38 : n <= 4 ? 34 : n <= 5 ? 30 : 27;
  const colAttr = n ? ` style="--sb-col-w:${colW}px"` : '';
  const stCols  = bMap => refLojas.map(l =>
    `<span class="mx-st-col">${bMap && bMap[l.board] != null ? fNum(bMap[l.board]) : '—'}</span>`
  ).join('');

  list.innerHTML = setores.map((s, i) => {
    const pct    = totalValor > 0 ? ((s.valor / totalValor) * 100).toFixed(1) : '0.0';
    const barPct = totalValor > 0 ? ((s.valor / maxValor)   * 100).toFixed(1) : '0';
    const isOpen = expanded.has(s.setor);
    const se     = setorStock[s.setor.toUpperCase()];

    const stBlock = n ? `
      <div class="mx-st-block">
        <div class="mx-st-lbl-row">${refLojas.map(l => `<span class="mx-st-col" style="color:${l.color}">${abbr(l.label)}</span>`).join('')}</div>
        <div class="mx-st-tot-row">${stCols(se?.totals)}</div>
      </div>` : '';

    const marcasHtml = s.marcas.map(m => {
      const mKey     = s.setor + '\x00' + m.marca;
      const mOpen    = expanded.has(mKey);
      const pctSetor = s.valor > 0 ? ((m.valor / s.valor) * 100).toFixed(1) : '0.0';
      const stSetor  = n ? `<div class="mx-st-setor">${stCols(se?.byMarca[m.marca.toUpperCase()])}</div>` : '';
      const marcaEntry = stockData ? stockMap[m.marca.toUpperCase()] : null;
      const setorEntry = marcaEntry ? (marcaEntry.setores || []).find(ss => ss.setor.toUpperCase() === s.setor.toUpperCase()) : null;
      const stockRefs  = setorEntry ? setorEntry.refs : null;
      return `
        <div class="mx-setor-row${mOpen ? ' open' : ''}" data-skey="${_esc(mKey)}">
          <div class="mx-setor-hdr">
            <span class="mx-setor-chevron">▶</span>
            <span class="mx-setor-name">${_esc(m.marca)}</span>
            <span class="mx-setor-val">${fBRL(m.valor)}</span>
            <span class="mx-setor-pecas">${fNum(m.qtd)} pcs</span>
            <span class="mx-setor-pct" title="% do setor">${pctSetor}%</span>
            ${stSetor}
          </div>
          <div class="mx-setor-prods">${prodTable(m.produtos, stockRefs, refLojas)}</div>
        </div>`;
    }).join('');

    return `
      <div class="mx-brand-card${isOpen ? ' open' : ''}" data-marca="${_esc(s.setor)}"${colAttr}>
        <div class="mx-brand-hdr">
          <span class="mx-brand-rank">#${i + 1}</span>
          <span class="mx-brand-name" title="${_esc(s.setor)}">${_esc(s.setor)}</span>
          <div class="mx-brand-right">
            <span class="mx-brand-val">${fBRL(s.valor)}</span>
            <span class="mx-brand-pecas">${fNum(s.qtd)} pcs</span>
            <span class="mx-brand-chevron">▼</span>
          </div>
          ${stBlock}
        </div>
        <div class="mx-bar-wrap">
          <div class="mx-bar-row">
            <div class="mx-bar-track"><div class="mx-bar-fill" style="width:${barPct}%"></div></div>
            <span class="mx-bar-pct">${pct}%</span>
          </div>
        </div>
        <div class="mx-prod-wrap">${marcasHtml}</div>
      </div>`;
  }).join('');

  wireEvents(list);
}

// ── Stock side box ────────────────────────────────────────────────────────────
function fK(v) {
  if (!v) return '—';
  if (v >= 1000) return 'R$ ' + (v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'k';
  return fBRL(v);
}
const STORE_ABBR = { 'DEL REY': 'DR', 'MINAS': 'MNS', 'CONTAGEM': 'CTG', 'ESTAÇÃO': 'EST', 'TOMMY': 'TMY', 'LEZ A LEZ': 'LEZ' };
function abbr(label) { return STORE_ABBR[label] || label.slice(0, 3).toUpperCase(); }

function stockBoxHtml(marca) {
  const empty = '<div class="mx-stock-box" style="display:flex;align-items:center;justify-content:center;min-height:60px"><span style="color:#21262d;font-size:.7rem">—</span></div>';
  if (!stockData) return empty;
  const e = stockMap[marca.toUpperCase()];
  if (!e || !e.lojas.length) return empty;

  const lojas    = e.lojas;
  const n        = lojas.length;
  const colW     = n <= 3 ? 38 : n <= 4 ? 34 : n <= 5 ? 30 : 27;
  const hasValor = e.totalValor > 0;

  const qtyCells = (arr) => {
    const m = {};
    (arr || []).forEach(l => { m[l.board] = l.qtd; });
    return lojas.map(l =>
      `<span class="mx-sb-qty">${m[l.board] != null ? fNum(m[l.board]) : '—'}</span>`
    ).join('');
  };

  const hdrCols   = lojas.map(l => `<span class="mx-sb-qty" style="color:${l.color}">${abbr(l.label)}</span>`).join('');
  const totalCols = lojas.map(l => `<span class="mx-sb-qty">${fNum(l.qtd)}</span>`).join('');
  const valRow    = hasValor ? `
    <div class="mx-sb-row mx-sb-val-row">
      <span class="mx-sb-name">R$ venda</span>
      ${lojas.map(l => `<span class="mx-sb-qty">${fK(l.valor)}</span>`).join('')}
    </div>` : '';

  const setorRows = (e.setores || []).map(s => `
    <div class="mx-sb-row mx-sb-setor-row">
      <span class="mx-sb-name">${_esc(s.setor)}</span>
      ${qtyCells(s.lojas)}
    </div>`).join('');

  return `<div class="mx-stock-box" style="--sb-col-w:${colW}px">
    <div class="mx-sb-row mx-sb-hdr-row">
      <span class="mx-sb-name">Estoque</span>${hdrCols}
    </div>
    <div class="mx-sb-row mx-sb-total-row">
      <span class="mx-sb-name">Total</span>${totalCols}
    </div>
    ${valRow}
    ${setorRows ? `<div class="mx-sb-setores">${setorRows}</div>` : ''}
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function prodTable(produtos, stockRefs, lojas) {
  // stockRefs: [{ref, lojas:[{board,qtd}]}] — estoque por ref por loja
  // lojas: [{board, label, color}] — colunas de loja a exibir
  const refStockMap = {};
  if (stockRefs) stockRefs.forEach(r => {
    const m = {};
    (r.lojas || []).forEach(l => { m[l.board] = l.qtd; });
    refStockMap[r.ref.toUpperCase()] = m;
  });
  const hasStock = lojas && lojas.length > 0;
  const stHdr = hasStock
    ? lojas.map(l => `<th class="mx-prod-tbl-st" style="color:${l.color}" title="${l.label}">${abbr(l.label)}</th>`).join('')
    : '';
  const stCells = (refKey) => {
    if (!hasStock) return '';
    const m = refStockMap[refKey] || {};
    return lojas.map(l => `<td class="mx-prod-tbl-st">${m[l.board] != null ? fNum(m[l.board]) : '—'}</td>`).join('');
  };

  const rows = (produtos || []).map((p, i) => {
    const rkey = `r${i}`;
    const corRows = (p.cores || []).map(c => `
      <tr class="mx-cor-row" data-rkey="${rkey}">
        <td>${_esc(c.cor)}</td>
        <td></td>
        <td>${fNum(c.qtd)}</td>
        <td>${fBRL(c.valor)}</td>
        ${hasStock ? lojas.map(() => '<td class="mx-prod-tbl-st">—</td>').join('') : ''}
      </tr>`).join('');
    const hasCores = p.cores && p.cores.length > 0;
    return `
      <tr class="mx-ref-row${hasCores ? '' : ' no-cores'}" data-rkey="${rkey}">
        <td><span class="mx-ref-chevron">${hasCores ? '▶' : ''}</span>${_esc(p.ref)}</td>
        <td>${_esc(p.nome)}</td>
        <td>${fNum(p.qtd)}</td>
        <td>${fBRL(p.valor)}</td>
        ${stCells(p.ref.toUpperCase())}
      </tr>${corRows}`;
  }).join('');
  return `<table class="mx-prod-tbl">
    <thead><tr><th>Referência</th><th>Nome</th><th>Peças</th><th>R$ Valor</th>${stHdr}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function wireEvents(list) {
  list.querySelectorAll('.mx-brand-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const card  = hdr.closest('.mx-brand-card');
      const key   = card.dataset.marca;
      if (expanded.has(key)) { expanded.delete(key); card.classList.remove('open'); }
      else                   { expanded.add(key);    card.classList.add('open'); }
    });
  });
  list.querySelectorAll('.mx-setor-hdr').forEach(hdr => {
    hdr.addEventListener('click', e => {
      e.stopPropagation();
      const row  = hdr.closest('.mx-setor-row');
      const sKey = row.dataset.skey;
      if (expanded.has(sKey)) { expanded.delete(sKey); row.classList.remove('open'); }
      else                    { expanded.add(sKey);    row.classList.add('open'); }
    });
  });
  list.querySelectorAll('.mx-ref-row').forEach(row => {
    if (row.classList.contains('no-cores')) return;
    row.querySelector('td').addEventListener('click', e => {
      e.stopPropagation();
      const rkey = row.dataset.rkey;
      const isOpen = row.classList.toggle('open');
      row.closest('table').querySelectorAll(`.mx-cor-row[data-rkey="${rkey}"]`)
        .forEach(r => r.style.display = isOpen ? 'table-row' : 'none');
    });
  });

}

function showLoading() {
  document.getElementById('errorBox').style.display = 'none';
  document.getElementById('summaryStrip').style.display = 'none';
  document.getElementById('brandList').innerHTML = '';
  document.getElementById('stateBox').innerHTML = '<div class="mx-spinner"></div><br>Buscando…';
  document.getElementById('stateBox').style.display = '';
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = 'Erro: ' + msg;
  box.style.display = '';
  document.getElementById('stateBox').style.display = 'none';
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
