// ── Vendas por Marca / Setor ─────────────────────────────────────────────────
const STORE_BOARDS = {
  delrey:   { label: 'DEL REY',   color: 'var(--col-delrey)' },
  minas:    { label: 'MINAS',     color: 'var(--col-minas)' },
  contagem: { label: 'CONTAGEM',  color: 'var(--col-contagem)' },
  estacao:  { label: 'ESTAÇÃO',   color: 'var(--col-estacao)' },
  tommy:    { label: 'TOMMY',     color: 'var(--col-tommy)' },
  lez:      { label: 'LEZ A LEZ', color: 'var(--col-lez)' },
  site:     { label: 'SITE',      color: 'var(--col-site)' },
};

const fBRL = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fNum = v => Number(v).toLocaleString('pt-BR');
const fDate = s => s ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : '';
const pad = n => String(n).padStart(2, '0');

let me = null;
let apiData = null;
let stockData = null;
let stockMap = {};
let viewMode = 'marca'; // 'marca' | 'setor' | 'vendedor' | 'ticket'
const expanded = new Set();
let _vvData = null;
let _tkData = null;

const $ = id => document.getElementById(id);

function _hideAltViews() {
  $('vvControls').style.display  = 'none';
  $('tkControls').style.display  = 'none';
  $('vvResult').style.display    = 'none';
  $('tkResult').style.display    = 'none';
  $('vvResult').innerHTML = '';
  $('tkResult').innerHTML = '';
}

// A caixa de estado ("Selecione o período…", carregando, vazio) e o erro são da
// visão de marca/setor: nas visões de vendedor e ticket ficavam em cima do resultado.
function _stateBoxNaVisao(outraVisao) {
  const box = $('stateBox'), err = $('errorBox');
  if (outraVisao) {
    if (!('antes' in box.dataset)) { box.dataset.antes = box.style.display; err.dataset.antes = err.style.display; }
    box.style.display = 'none'; err.style.display = 'none';
  } else if ('antes' in box.dataset) {
    box.style.display = box.dataset.antes; err.style.display = err.dataset.antes || 'none';
    delete box.dataset.antes; delete err.dataset.antes;
  }
}

function setVendedorView(active) {
  $('mxMainControls').style.display = active ? 'none' : 'contents';
  $('vvControls').style.display     = active ? 'flex' : 'none';
  $('tkControls').style.display     = 'none';
  $('summaryStrip').style.display   = active ? 'none' : ($('summaryStrip').dataset.wasVisible === '1' ? '' : 'none');
  $('brandList').style.display      = active ? 'none' : '';
  _stateBoxNaVisao(active);
  $('vvResult').style.display       = active ? ''     : 'none';
  $('tkResult').style.display       = 'none';
  if (!active) { $('vvResult').innerHTML = ''; }
}

function setTicketView(active) {
  $('mxMainControls').style.display = active ? 'none' : 'contents';
  $('tkControls').style.display     = active ? 'flex' : 'none';
  $('vvControls').style.display     = 'none';
  $('summaryStrip').style.display   = active ? 'none' : ($('summaryStrip').dataset.wasVisible === '1' ? '' : 'none');
  $('brandList').style.display      = active ? 'none' : '';
  _stateBoxNaVisao(active);
  $('tkResult').style.display       = active ? ''     : 'none';
  $('vvResult').style.display       = 'none';
  if (!active) { $('tkResult').innerHTML = ''; }
}

async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }
  me = await r.json();

  const isAdmin = !me.board || me.board === 'escritorio';
  const boardSel = $('boardSel');
  if (isAdmin) {
    boardSel.style.display = '';
    boardSel.innerHTML =
      '<option value="surfers">Total Surfers</option>' +
      Object.entries(STORE_BOARDS).map(([k,v]) =>
        `<option value="${k}">${v.label}</option>`).join('');
  }

  // Preenche vvBoard igual ao boardSel
  const vvBoard = $('vvBoard');
  if (isAdmin) {
    vvBoard.innerHTML =
      '<option value="surfers">Total Surfers</option>' +
      Object.entries(STORE_BOARDS).map(([k,v]) =>
        `<option value="${k}">${v.label}</option>`).join('');
  } else if (me.board) {
    vvBoard.innerHTML = `<option value="${me.board}">${me.board}</option>`;
  }

  // Data padrão = hoje para Por Vendedor e Por Ticket
  const _now = new Date();
  const td = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
  $('vvDtIni').value = td; $('vvDtFin').value = td;
  $('tkDtIni').value = td; $('tkDtFin').value = td;

  // Preenche tkBoard igual ao vvBoard
  const tkBoard = $('tkBoard');
  if (isAdmin) {
    tkBoard.innerHTML =
      '<option value="surfers">Total Surfers</option>' +
      Object.entries(STORE_BOARDS).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  } else if (me.board) {
    tkBoard.innerHTML = `<option value="${me.board}">${me.board}</option>`;
  }

  setShortcut('30d');

  document.querySelectorAll('[data-s]').forEach(btn =>
    btn.addEventListener('click', () => setShortcut(btn.dataset.s)));

  $('searchBtn').addEventListener('click', fetchData);

  document.querySelectorAll('.mx-inp').forEach(inp =>
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (viewMode === 'vendedor') fetchVendedor();
      else if (viewMode === 'ticket') fetchTicket();
      else fetchData();
    }));

  // Toggle Por Marca / Por Setor / Por Vendedor / Por Ticket
  document.querySelectorAll('.mx-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll('.mx-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewMode));
      expanded.clear();
      if (viewMode === 'vendedor') {
        setVendedorView(true);
      } else if (viewMode === 'ticket') {
        setTicketView(true);
      } else {
        setVendedorView(false);
        setTicketView(false);
        if (apiData) render();
      }
    });
  });

  // Por Vendedor — buscar / XLS
  $('vvSearchBtn').addEventListener('click', fetchVendedor);
  $('vvDtIni').addEventListener('keydown', e => { if (e.key === 'Enter') fetchVendedor(); });
  $('vvDtFin').addEventListener('keydown', e => { if (e.key === 'Enter') fetchVendedor(); });
  $('vvXlsBtn').addEventListener('click', () => {
    if (!_vvData) return;
    const lines = ['Loja\tVendedor\tMarca\tCódigo\tDescrição\tQtd\tValor Líq.'];
    for (const row of _vvData.rows) {
      lines.push([row.loja, row.vendedor, row.marca, row.cod, row.desc, row.qty,
        String(row.venda_total).replace('.', ',')].join('\t'));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `vendas-vendedor-${_vvData.board}-${_vvData.dtIni}.tsv`; a.click();
  });

  // Por Ticket — buscar / XLS
  $('tkSearchBtn').addEventListener('click', fetchTicket);
  $('tkDtIni').addEventListener('keydown', e => { if (e.key === 'Enter') fetchTicket(); });
  $('tkDtFin').addEventListener('keydown', e => { if (e.key === 'Enter') fetchTicket(); });
  $('tkXlsBtn').addEventListener('click', () => {
    if (!_tkData) return;
    const fmtD = s => s ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : '';
    const lines = ['Loja\tData\tHora\tDoc\tVendedor\tFormas\tDesconto\tTotal'];
    for (const v of _tkData.vendas) {
      const formas = (v.formas||[]).map(f => f.forma+(f.bandeira?' '+f.bandeira:'')+(f.parcelas>1?' '+f.parcelas+'x':'')).join(' / ');
      lines.push([v.board||'', fmtD(v.data), v.hora||'', v.doc, v.vendedor||'', formas,
        String(v.desconto?.valor||0).replace('.',','),
        String(v.valorTotal).replace('.',',')].join('\t'));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `vendas-ticket-${$('tkBoard').value}-${$('tkDtIni').value}.tsv`; a.click();
  });
}

async function fetchVendedor() {
  const board = $('vvBoard').value;
  const dtIni = $('vvDtIni').value;
  const dtFin = $('vvDtFin').value;
  if (!board || !dtIni || !dtFin) return;

  const btn = $('vvSearchBtn');
  btn.disabled = true;
  $('vvXlsBtn').style.display = 'none';
  $('vvResult').innerHTML = '<div class="mx-state"><div class="mx-spinner"></div><br>Buscando vendas…</div>';

  try {
    const data = await fetch(
      `/api/conferencia/vendas-vendedor?board=${board}&dtIni=${encodeURIComponent(dtIni)}&dtFin=${encodeURIComponent(dtFin)}`
    ).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || r.statusText); }); return r.json(); });

    _vvData = data;
    renderVendedor(data);
    $('vvXlsBtn').style.display = '';
  } catch (e) {
    $('vvResult').innerHTML = `<div class="mx-error">${_esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderVendedor(data) {
  const fmtR = v => 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!data.rows || !data.rows.length) {
    $('vvResult').innerHTML = '<div class="mx-state">Nenhuma venda encontrada no período.</div>';
    return;
  }

  let html = `<div class="mx-card"><div class="mx-scroll"><table class="mx-t">
    <thead><tr>
      <th>Loja</th><th>Vendedor</th><th>Marca</th><th>Código</th><th>Descrição</th>
      <th class="r" style="width:45px">Qtd</th><th class="r" style="width:120px">Valor líq.</th>
    </tr></thead><tbody>`;

  let prevLoja = null, prevVend = null;
  for (const row of data.rows) {
    const isNewLoja = row.loja !== prevLoja;
    const isNewVend = isNewLoja || row.vendedor !== prevVend;

    if (isNewLoja) {
      html += `<tr class="vv-loja"><td colspan="7">${_esc(row.loja)}</td></tr>`;
      prevLoja = row.loja; prevVend = null;
    }
    if (isNewVend) {
      html += `<tr class="vv-vend"><td></td><td colspan="6">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>${_esc(row.vendedor)}
        </td></tr>`;
      prevVend = row.vendedor;
    }

    html += `<tr class="vv-item">
      <td></td><td></td>
      <td>${_esc(row.marca)}</td>
      <td class="mx-num">${_esc(row.cod || '—')}</td>
      <td class="vv-desc" title="${_esc(row.desc)}">${_esc(row.desc)}</td>
      <td class="r mx-num">${row.qty}</td>
      <td class="r mx-num" style="font-weight:600;color:var(--text)">${fmtR(row.venda_total)}</td>
    </tr>`;
  }

  html += '</tbody></table></div></div>';
  $('vvResult').innerHTML = html;
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
    ini = `${d30.getFullYear()}-${pad(d30.getMonth()+1)}-${pad(d30.getDate())}`;
    fin = `${y}-${pad(m)}-${pad(d)}`;
  } else if (s === '3m') {
    const d3m = new Date(today); d3m.setMonth(d3m.getMonth() - 3);
    ini = `${d3m.getFullYear()}-${pad(d3m.getMonth()+1)}-${pad(d3m.getDate())}`;
    fin = `${y}-${pad(m)}-${pad(d)}`;
  }
  document.getElementById('dtIni').value = ini;
  document.getElementById('dtFin').value = fin;
}

// ── Por Ticket ──────────────────────────────────────────────────────────────

async function fetchTicket() {
  const board = $('tkBoard').value;
  const dtIni = $('tkDtIni').value;
  const dtFin = $('tkDtFin').value;
  if (!board || !dtIni || !dtFin) return;

  const btn = $('tkSearchBtn');
  btn.disabled = true;
  $('tkXlsBtn').style.display = 'none';
  $('tkResult').innerHTML = '<div class="mx-state">Buscando...</div>';

  try {
    const res = await fetch(`/api/conferencia/vendas?board=${encodeURIComponent(board)}&dtIni=${dtIni}&dtFin=${dtFin}`);
    if (!res.ok) throw new Error(await res.text());
    _tkData = await res.json();
    renderTicket(_tkData);
    if (_tkData.vendas?.length) $('tkXlsBtn').style.display = '';
  } catch (e) {
    $('tkResult').innerHTML = `<div class="mx-error">Erro: ${_esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

const LOJA_LABEL_MX = {
  delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação',
  tommy:'Tommy', lez:'Lez a Lez', site:'Site', surfers:'Total Surfers',
};

// Cor da loja = a mesma tarja do painel (tokens --col-* do style.css)
const LOJA_COR_MX = {
  delrey:'var(--col-delrey)', minas:'var(--col-minas)', contagem:'var(--col-contagem)', estacao:'var(--col-estacao)',
  tommy:'var(--col-tommy)', lez:'var(--col-lez)', site:'var(--col-site)', surfers:'var(--col-surfers)',
};

function renderTicket(data) {
  const fmtD = s => s ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : '—';
  const fmtR = v => 'R$ ' + (+v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const esc  = _esc;

  const vendas = data.vendas || [];
  if (!vendas.length) {
    $('tkResult').innerHTML = '<div class="mx-state">Nenhuma venda encontrada no período.</div>';
    return;
  }

  const forma = f => `${esc(f.forma)}${f.bandeira?' · '+esc(f.bandeira):''}${f.parcelas>1?' · '+f.parcelas+'x':''}`;

  const rows = vendas.map((v, idx) => {
    const formasChips = (v.formas||[]).map(f => `<span class="tk-forma">${forma(f)} <b>${fmtR(f.valor)}</b></span>`).join('');
    const lojaLabel = LOJA_LABEL_MX[v.board] || v.board || '';
    const descVal = v.desconto?.valor||0;
    const itens = v.itens || [];

    const itensBlock = !itens.length ? '<div class="tk-sem">Sem itens detalhados.</div>' :
      `<table class="tk-it">
        <thead><tr>
          <th>Produto</th><th style="width:40px">Qtd</th><th style="width:92px">Tabela</th><th style="width:92px">Promo</th>
          <th style="width:92px">Bruto</th><th style="width:82px">Desc.</th><th style="width:48px">%</th><th style="width:96px">Líquido</th>
        </tr></thead>
        <tbody>${itens.map(it => {
          const liq = it.vlrLiquido ?? (it.vlrBruto - it.vlrDesconto);
          const vlrLiqUnit = it.quantidade > 0 ? liq / it.quantidade : liq;
          const baseDesc = (it.emPromocao && it.precoPromocao) ? it.precoPromocao : it.vlrUnitario;
          const percDesc = baseDesc > 0 ? ((baseDesc - vlrLiqUnit) / baseDesc * 100) : 0;
          const nome = it.nome || it.descricao || it.cod_produto || '';
          const tags = [
            it.referencia  ? `<span class="tk-tag">Ref ${esc(it.referencia)}</span>` : '',
            it.cod_produto ? `<span class="tk-tag">${esc(it.cod_produto)}</span>` : '',
            it.marca       ? `<span class="tk-tag marca">${esc(it.marca)}</span>` : '',
            it.setor       ? `<span class="tk-tag setor">${esc(it.setor)}</span>` : '',
          ].filter(Boolean).join('');
          const promoCell = it.emPromocao && it.precoPromocao ? `<span class="tk-promo">${fmtR(it.precoPromocao)}</span>` : '<span class="mx-fraco">—</span>';
          return `<tr>
            <td>
              <div><span class="tk-prod">${esc(nome)}</span>${it.cor ? `<span class="tk-cor">${esc(it.cor)}</span>` : ''}</div>
              ${tags ? `<div class="tk-tags">${tags}</div>` : ''}
            </td>
            <td>${it.quantidade}</td>
            <td>${fmtR(it.vlrUnitario||0)}</td>
            <td>${promoCell}</td>
            <td>${fmtR(it.vlrBruto||0)}</td>
            <td class="${it.vlrDesconto>0?'mx-neg':'mx-fraco'}">${it.vlrDesconto>0?fmtR(it.vlrDesconto):'—'}</td>
            <td class="${percDesc>0.05?'mx-neg':'mx-fraco'}">${percDesc>0.05?percDesc.toFixed(1)+'%':'—'}</td>
            <td style="font-weight:600;color:var(--text)">${fmtR(liq)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;

    return `
    <tr class="tk-row" data-idx="${idx}">
      <td class="tk-chev"><span>▶</span></td>
      <td class="tk-data">${fmtD(v.data)}</td>
      <td class="tk-hora mx-num">${esc(v.hora||'—')}</td>
      <td class="tk-doc">${esc(v.doc)}</td>
      <td><span class="tk-loja"><span class="tk-tarja" style="background:${LOJA_COR_MX[v.board] || 'var(--muted)'}"></span>${esc(lojaLabel)}</span></td>
      <td class="tk-vend">${esc(v.vendedor||'—')}</td>
      <td><div class="tk-formas">${formasChips}</div></td>
      <td class="r mx-num ${descVal>0?'mx-neg':'mx-fraco'}">${descVal>0?fmtR(descVal):'—'}</td>
      <td class="r tk-total">${fmtR(v.valorTotal)}</td>
    </tr>
    <tr class="tk-detail" data-idx="${idx}" style="display:none">
      <td colspan="9"><div class="tk-itens mx-scroll">${itensBlock}</div></td>
    </tr>`;
  }).join('');

  const total = vendas.reduce((s,v)=>s+(v.valorTotal||0),0);
  const totalDesc = vendas.reduce((s,v)=>s+(v.desconto?.valor||0),0);
  const pecas = vendas.reduce((s,v)=>s+(v.itens||[]).reduce((a,it)=>a+(+it.quantidade||0),0),0);

  $('tkResult').innerHTML = `
    <div class="mx-summary">
      <div class="mx-sum-card"><div class="mx-sum-label">Vendas</div><div class="mx-sum-val">${vendas.length}</div></div>
      <div class="mx-sum-card"><div class="mx-sum-label">Total</div><div class="mx-sum-val blue">${fmtR(total)}</div></div>
      <div class="mx-sum-card"><div class="mx-sum-label">Ticket médio · ${fNum(pecas)} peça${pecas!==1?'s':''}</div><div class="mx-sum-val">${fmtR(total / vendas.length)}</div></div>
      <div class="mx-sum-card"><div class="mx-sum-label">Descontos</div><div class="mx-sum-val${totalDesc>0?' neg':''}">${totalDesc>0?fmtR(totalDesc):'—'}</div></div>
    </div>
    <div class="mx-card"><div class="mx-scroll">
    <table class="mx-t">
      <thead><tr>
        <th style="width:26px"></th><th>Data</th><th>Hora</th><th>Doc</th><th>Loja</th><th>Vendedor</th><th>Pagamento</th>
        <th class="r" style="width:100px">Desconto</th><th class="r" style="width:110px">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;

  $('tkResult').querySelectorAll('.tk-row').forEach(row => {
    row.addEventListener('click', () => {
      const detail = $('tkResult').querySelector(`.tk-detail[data-idx="${row.dataset.idx}"]`);
      if (!detail) return;
      const abrir = detail.style.display === 'none';
      detail.style.display = abrir ? '' : 'none';
      row.classList.toggle('aberto', abrir);
    });
  });
}

// ── Dados de Marcas/Setor ────────────────────────────────────────────────────

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

  const [y1,mo1,d1] = (apiData.dtIni||'').split('-').map(Number);
  const [y2,mo2,d2] = (apiData.dtFin||'').split('-').map(Number);
  const periodDias  = (y1&&y2) ? Math.max(1, Math.round((new Date(y2,mo2-1,d2)-new Date(y1,mo1-1,d1))/86400000)+1) : 30;
  if (viewMode === 'setor') renderPorSetor(marcas, totalValor, periodDias);
  else                      renderPorMarca(marcas, totalValor, periodDias);
}

// ── Render Por Marca ──────────────────────────────────────────────────────────
function renderPorMarca(marcas, totalValor, periodDias) {
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

    const stCols = (arr, clr) => {
      const m2 = {}; (arr || []).forEach(x => { m2[x.board] = x.qtd; });
      return lojas.map(l => `<span class="mx-st-col"${clr ? ` style="color:${clr}"` : ''}>${m2[l.board] != null ? fNum(m2[l.board]) : '—'}</span>`).join('');
    };

    const stockTotal = lojas.reduce((s2, l) => s2 + l.qtd, 0);
    const giro30m    = m.qtd * 30 / periodDias;
    const cobM       = giro30m > 0 ? stockTotal / giro30m : null;
    const cobClrM    = cobColor(cobM);

    const stBlock = n ? `
      <div class="mx-st-block">
        <div class="mx-st-lbl-row">${lojas.map(l => `<span class="mx-st-col" style="color:${LOJA_COR_MX[l.board] || l.color}">${abbr(l.label)}</span>`).join('')}<span class="mx-cob-lbl">cob</span></div>
        <div class="mx-st-tot-row">${lojas.map(l => `<span class="mx-st-col"${cobClrM ? ` style="color:${cobClrM}"` : ''}>${fNum(l.qtd)}</span>`).join('')}${cobBadge(cobM)}</div>
      </div>` : '';

    // Refs de estoque por setor
    const refsMap = {};
    if (se) (se.setores || []).forEach(ss => { refsMap[ss.setor.toUpperCase()] = ss.refs; });

    const setoresHtml = (m.setores || []).map(s => {
      const sKey        = m.marca + '\x00' + s.setor;
      const sOpen       = expanded.has(sKey);
      const pctMarca    = m.valor > 0 ? ((s.valor / m.valor) * 100).toFixed(1) : '0.0';
      const setorLojas  = ssMap[s.setor.toUpperCase()] || [];
      const stockS      = setorLojas.reduce((sum, sl) => sum + (sl.qtd || 0), 0);
      const giro30s     = s.qtd * 30 / periodDias;
      const cobS        = giro30s > 0 ? stockS / giro30s : null;
      const cobClrS     = cobColor(cobS);
      const stSetor     = n ? `<div class="mx-st-setor">${stCols(setorLojas, cobClrS)}${cobBadge(cobS)}</div>` : '';
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
          <div class="mx-setor-prods">${prodTable(s.produtos, refsMap[s.setor.toUpperCase()], lojas, periodDias)}</div>
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
function renderPorSetor(marcas, totalValor, periodDias) {
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
  const stCols  = (bMap, clr) => refLojas.map(l =>
    `<span class="mx-st-col"${clr ? ` style="color:${clr}"` : ''}>${bMap && bMap[l.board] != null ? fNum(bMap[l.board]) : '—'}</span>`
  ).join('');

  list.innerHTML = setores.map((s, i) => {
    const pct    = totalValor > 0 ? ((s.valor / totalValor) * 100).toFixed(1) : '0.0';
    const barPct = totalValor > 0 ? ((s.valor / maxValor)   * 100).toFixed(1) : '0';
    const isOpen = expanded.has(s.setor);
    const se     = setorStock[s.setor.toUpperCase()];

    const stockSTotal = se ? Object.values(se.totals).reduce((a, b) => a + b, 0) : 0;
    const giro30s     = s.qtd * 30 / periodDias;
    const cobS        = giro30s > 0 ? stockSTotal / giro30s : null;
    const cobClrS     = cobColor(cobS);

    const stBlock = n ? `
      <div class="mx-st-block">
        <div class="mx-st-lbl-row">${refLojas.map(l => `<span class="mx-st-col" style="color:${LOJA_COR_MX[l.board] || l.color}">${abbr(l.label)}</span>`).join('')}<span class="mx-cob-lbl">cob</span></div>
        <div class="mx-st-tot-row">${stCols(se?.totals, cobClrS)}${cobBadge(cobS)}</div>
      </div>` : '';

    const marcasHtml = s.marcas.map(m => {
      const mKey       = s.setor + '\x00' + m.marca;
      const mOpen      = expanded.has(mKey);
      const pctSetor   = s.valor > 0 ? ((m.valor / s.valor) * 100).toFixed(1) : '0.0';
      const bMap       = se?.byMarca[m.marca.toUpperCase()];
      const stockM     = bMap ? Object.values(bMap).reduce((a, b) => a + b, 0) : 0;
      const giro30m    = m.qtd * 30 / periodDias;
      const cobM       = giro30m > 0 ? stockM / giro30m : null;
      const cobClrM    = cobColor(cobM);
      const stSetor    = n ? `<div class="mx-st-setor">${stCols(bMap, cobClrM)}${cobBadge(cobM)}</div>` : '';
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
          <div class="mx-setor-prods">${prodTable(m.produtos, stockRefs, refLojas, periodDias)}</div>
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
function cobColor(cob) {
  if (cob === null || cob === undefined || !isFinite(cob) || cob < 0) return null;
  return cob < 4 ? 'var(--down)' : cob < 6 ? 'var(--warn)' : 'var(--up)';
}
function cobBadge(cob) {
  const clr = cobColor(cob);
  if (!clr) return '';
  return `<span class="mx-cob" style="color:${clr}">${cob.toFixed(1)}m</span>`;
}

function stockBoxHtml(marca) {
  const empty = '<div class="mx-stock-box" style="display:flex;align-items:center;justify-content:center;min-height:60px"><span style="color:var(--muted);font-size:.7rem">—</span></div>';
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

  const hdrCols   = lojas.map(l => `<span class="mx-sb-qty" style="color:${LOJA_COR_MX[l.board] || l.color}">${abbr(l.label)}</span>`).join('');
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
function prodTable(produtos, stockRefs, lojas, periodDias) {
  const refStockMap = {};
  if (stockRefs) stockRefs.forEach(r => {
    const m = {};
    (r.lojas || []).forEach(l => { m[l.board] = l.qtd; });
    refStockMap[r.ref.toUpperCase()] = { bMap: m, total: r.totalQtd || Object.values(m).reduce((a,b)=>a+b,0) };
  });
  const hasStock = lojas && lojas.length > 0;
  const stHdr = hasStock
    ? lojas.map(l => `<th class="mx-prod-tbl-st" style="color:${LOJA_COR_MX[l.board] || l.color}" title="${l.label}">${abbr(l.label)}</th>`).join('') + '<th class="mx-prod-tbl-st mx-cob-lbl">cob</th>'
    : '';

  const rows = (produtos || []).map((p, i) => {
    const rkey    = `r${i}`;
    const rs      = refStockMap[p.ref.toUpperCase()];
    const giro30r = periodDias ? p.qtd * 30 / periodDias : 0;
    const cobR    = (rs && giro30r > 0) ? rs.total / giro30r : null;
    const cobClrR = cobColor(cobR);

    const stCells = hasStock ? (
      lojas.map(l => {
        const qty = rs ? (rs.bMap[l.board] ?? null) : null;
        return `<td class="mx-prod-tbl-st"${cobClrR ? ` style="color:${cobClrR}"` : ''}>${qty != null ? fNum(qty) : '—'}</td>`;
      }).join('') + `<td class="mx-prod-tbl-st">${cobR !== null ? `<span style="color:${cobClrR};font-weight:700">${cobR.toFixed(1)}m</span>` : '—'}</td>`
    ) : '';

    const corRows = (p.cores || []).map(c => `
      <tr class="mx-cor-row" data-rkey="${rkey}">
        <td>${_esc(c.cor)}</td>
        <td></td>
        <td>${fNum(c.qtd)}</td>
        <td>${fBRL(c.valor)}</td>
        ${hasStock ? lojas.map(() => '<td class="mx-prod-tbl-st">—</td>').join('') + '<td class="mx-prod-tbl-st">—</td>' : ''}
      </tr>`).join('');
    const hasCores = p.cores && p.cores.length > 0;
    return `
      <tr class="mx-ref-row${hasCores ? '' : ' no-cores'}" data-rkey="${rkey}">
        <td><span class="mx-ref-chevron">${hasCores ? '▶' : ''}</span>${_esc(p.ref)}</td>
        <td>${_esc(p.nome)}</td>
        <td>${fNum(p.qtd)}</td>
        <td>${fBRL(p.valor)}</td>
        ${stCells}
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
