// ── Vendas por Marca ────────────────────────────────────────────────────────
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
const expanded = new Set();

async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }
  me = await r.json();

  // Store selector — only for admin/escritorio
  const isAdmin = !me.board || me.board === 'escritorio';
  const boardSel = document.getElementById('boardSel');
  if (isAdmin) {
    boardSel.style.display = '';
    boardSel.innerHTML =
      '<option value="">Todas as lojas</option>' +
      Object.entries(STORE_BOARDS).map(([k,v]) =>
        `<option value="${k}">${v.label}</option>`).join('');
  }

  // Default date: this month
  setShortcut('mes');

  // Shortcut buttons
  document.querySelectorAll('[data-s]').forEach(btn =>
    btn.addEventListener('click', () => setShortcut(btn.dataset.s)));

  // Search
  document.getElementById('searchBtn').addEventListener('click', fetchData);

  // Tipo filter → re-render without new fetch
  document.querySelectorAll('[name="tipo"]').forEach(r =>
    r.addEventListener('change', () => { if (apiData) render(); }));

  // Enter key on date inputs
  document.querySelectorAll('.mx-inp').forEach(inp =>
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') fetchData(); }));
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
    if (board) params.set('board', board);
    const res = await fetch('/api/relatorio-marcas?' + params);
    if (!res.ok) { showError((await res.json()).error || 'Erro na API'); return; }
    apiData = await res.json();
    render();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

function getTipoFilter() {
  return document.querySelector('[name="tipo"]:checked')?.value || 'todos';
}

function applyTipoFilter(marcas, tipo) {
  if (tipo === 'todos') return marcas;
  return marcas
    .map(m => ({
      ...m,
      produtos: m.produtos.filter(p => p.tipo === tipo || (!p.tipo && tipo === 'produto')),
    }))
    .filter(m => m.produtos.length > 0)
    .map(m => ({
      ...m,
      qtd:   m.produtos.reduce((s, p) => s + p.qtd,   0),
      valor: parseFloat(m.produtos.reduce((s, p) => s + p.valor, 0).toFixed(2)),
    }));
}

function render() {
  const tipo   = getTipoFilter();
  const marcas = applyTipoFilter(apiData.marcas || [], tipo)
    .sort((a, b) => b.valor - a.valor);

  const totalValor = marcas.reduce((s, m) => s + m.valor, 0);
  const totalPecas = marcas.reduce((s, m) => s + m.qtd,   0);
  const maxValor   = marcas.length ? marcas[0].valor : 1;

  // Summary strip
  document.getElementById('sumValor').textContent   = fBRL(totalValor);
  document.getElementById('sumPecas').textContent   = fNum(totalPecas) + ' pcs';
  document.getElementById('sumMarcas').textContent  = marcas.length;
  document.getElementById('sumPeriodo').textContent = fDate(apiData.dtIni) + ' → ' + fDate(apiData.dtFin);
  document.getElementById('summaryStrip').style.display = '';

  // State box
  const state = document.getElementById('stateBox');
  if (!marcas.length) {
    state.innerHTML = 'Nenhuma venda encontrada para o período.';
    state.style.display = '';
    document.getElementById('brandList').innerHTML = '';
    return;
  }
  state.style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  // Brand cards
  const list = document.getElementById('brandList');
  list.innerHTML = marcas.map((m, i) => {
    const pct    = totalValor > 0 ? ((m.valor / totalValor) * 100).toFixed(1) : '0.0';
    const barPct = totalValor > 0 ? ((m.valor / maxValor)   * 100).toFixed(1) : '0';
    const isOpen = expanded.has(m.marca);
    return `
      <div class="mx-brand-card${isOpen ? ' open' : ''}" data-marca="${_esc(m.marca)}">
        <div class="mx-brand-hdr">
          <span class="mx-brand-rank">#${i + 1}</span>
          <span class="mx-brand-name" title="${_esc(m.marca)}">${_esc(m.marca)}</span>
          <div class="mx-brand-right">
            <span class="mx-brand-val">${fBRL(m.valor)}</span>
            <span class="mx-brand-pecas">${fNum(m.qtd)} pcs</span>
            <span class="mx-brand-chevron">▼</span>
          </div>
        </div>
        <div class="mx-bar-wrap">
          <div class="mx-bar-row">
            <div class="mx-bar-track"><div class="mx-bar-fill" style="width:${barPct}%"></div></div>
            <span class="mx-bar-pct">${pct}%</span>
          </div>
        </div>
        <div class="mx-prod-wrap">
          <table class="mx-prod-tbl">
            <thead><tr>
              <th>Código</th><th>Nome</th><th>Tipo</th><th>Peças</th><th>R$ Valor</th>
            </tr></thead>
            <tbody>
              ${m.produtos.map(p => `
                <tr>
                  <td style="color:#8b949e">${_esc(p.cod)}</td>
                  <td>${_esc(p.nome)}</td>
                  <td><span class="mx-tipo-badge ${p.tipo === 'servico' ? 'svc' : 'prod'}">${p.tipo === 'servico' ? 'Serviço' : 'Produto'}</span></td>
                  <td>${fNum(p.qtd)}</td>
                  <td>${fBRL(p.valor)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  // Wire expand/collapse
  list.querySelectorAll('.mx-brand-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const card  = hdr.closest('.mx-brand-card');
      const marca = card.dataset.marca;
      if (expanded.has(marca)) { expanded.delete(marca); card.classList.remove('open'); }
      else                     { expanded.add(marca);    card.classList.add('open'); }
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
