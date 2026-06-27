// ── Vendas por Marca / Setor ─────────────────────────────────────────────────
const STORE_BOARDS = {
  delrey:   { label: 'DEL REY',   color: '#58A6FF' },
  minas:    { label: 'MINAS',     color: '#3FB950' },
  contagem: { label: 'CONTAGEM',  color: '#D29922' },
  estacao:  { label: 'ESTAÇÃO',   color: '#F85149' },
  tommy:    { label: 'TOMMY',     color: '#22D3EE' },
  lez:      { label: 'LEZ A LEZ', color: '#F472B6' },
  site:     { label: 'SITE',      color: '#A78BFA' },
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

function setVendedorView(active) {
  $('mxMainControls').style.display = active ? 'none' : 'contents';
  $('vvControls').style.display     = active ? 'flex' : 'none';
  $('tkControls').style.display     = 'none';
  $('summaryStrip').style.display   = active ? 'none' : ($('summaryStrip').dataset.wasVisible === '1' ? '' : 'none');
  $('brandList').style.display      = active ? 'none' : '';
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
  const td = new Date().toISOString().slice(0, 10);
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
    $('vvResult').innerHTML = `<div class="mx-error">${e.message}</div>`;
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

  let html = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
    <thead><tr style="background:#0d1117">
      <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Loja</th>
      <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Vendedor</th>
      <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Marca</th>
      <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Código</th>
      <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Descrição</th>
      <th style="text-align:right;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d;width:45px">Qtd</th>
      <th style="text-align:right;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d;width:110px">Valor Líq.</th>
    </tr></thead><tbody>`;

  let prevLoja = null, prevVend = null;
  for (const row of data.rows) {
    const isNewLoja = row.loja !== prevLoja;
    const isNewVend = isNewLoja || row.vendedor !== prevVend;

    if (isNewLoja) {
      html += `<tr style="background:#161b22">
        <td colspan="7" style="padding:.55rem .7rem;font-weight:800;font-size:.78rem;color:#58a6ff;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #30363d">${row.loja}</td>
      </tr>`;
      prevLoja = row.loja; prevVend = null;
    }
    if (isNewVend) {
      html += `<tr style="background:#0f1419">
        <td></td>
        <td colspan="6" style="padding:.45rem .6rem;font-weight:700;color:#e6edf3;border-bottom:1px solid #1a1f26">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2" style="margin-right:5px;vertical-align:middle"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          ${row.vendedor}
        </td>
      </tr>`;
      prevVend = row.vendedor;
    }

    html += `<tr style="border-bottom:1px solid #1a1f26" onmouseover="this.style.background='#1c2128'" onmouseout="this.style.background=''">
      <td></td>
      <td></td>
      <td style="padding:.38rem .6rem;color:#8b949e;font-size:.78rem">${row.marca}</td>
      <td style="padding:.38rem .6rem;color:#8b949e;font-size:.78rem">${row.cod || '—'}</td>
      <td style="padding:.38rem .6rem;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${row.desc}">${row.desc}</td>
      <td style="padding:.38rem .6rem;text-align:right;font-variant-numeric:tabular-nums">${row.qty}</td>
      <td style="padding:.38rem .6rem;text-align:right;font-weight:700;color:#58a6ff;font-variant-numeric:tabular-nums">${fmtR(row.venda_total)}</td>
    </tr>`;
  }

  html += '</tbody></table>';
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
    $('tkResult').innerHTML = `<div class="mx-state" style="color:#ef4444">Erro: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

const LOJA_LABEL_MX = {
  delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação',
  tommy:'Tommy', lez:'Lez a Lez', site:'Site', surfers:'Total Surfers',
};

function renderTicket(data) {
  const fmtD = s => s ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : '—';
  const fmtR = v => 'R$ ' + (+v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const vendas = data.vendas || [];
  if (!vendas.length) {
    $('tkResult').innerHTML = '<div class="mx-state">Nenhuma venda encontrada no período.</div>';
    return;
  }

  const rows = vendas.map((v, idx) => {
    const formasChips = (v.formas||[]).map(f =>
      `<span style="background:#21262d;border:1px solid #30363d;border-radius:4px;padding:2px 7px;font-size:.73rem;white-space:nowrap">${esc(f.forma)}${f.bandeira?' · '+esc(f.bandeira):''}${f.parcelas>1?' · '+f.parcelas+'x':''} <strong>${fmtR(f.valor)}</strong></span>`
    ).join(' ');
    const lojaLabel = LOJA_LABEL_MX[v.board] || esc(v.board||'');
    const descVal = v.desconto?.valor||0;
    const itens = v.itens || [];
    const hasItens = itens.length > 0;
    const zebra = idx%2===1 ? 'background:#0d1117' : '';

    // Linha de detalhe (accordion)
    const formasBlock = (v.formas||[]).map(f =>
      `<span style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:4px 12px;font-size:.8rem">${esc(f.forma)}${f.bandeira?' · '+esc(f.bandeira):''}${f.parcelas>1?' · '+f.parcelas+'x':''} <strong>${fmtR(f.valor)}</strong></span>`
    ).join('');

    const itensBlock = !hasItens ? '<div style="color:#8b949e;font-size:.82rem;padding:.5rem 0">Sem itens detalhados.</div>' :
      `<table style="width:100%;border-collapse:collapse;font-size:.78rem;margin-top:.5rem">
        <thead><tr style="background:#060a0f">
          <th style="text-align:left;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d">Produto</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:40px">Qtd</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:88px">Tabela</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:88px">Promo</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:88px">Bruto</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:78px">Desc.</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:42px">%</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#6b7280;border-bottom:1px solid #21262d;width:90px">Líquido</th>
        </tr></thead>
        <tbody>${itens.map((it, i) => {
          const liq = it.vlrLiquido ?? (it.vlrBruto - it.vlrDesconto);
          const vlrLiqUnit = it.quantidade > 0 ? liq / it.quantidade : liq;
          const baseDesc = (it.emPromocao && it.precoPromocao) ? it.precoPromocao : it.vlrUnitario;
          const percDesc = baseDesc > 0 ? ((baseDesc - vlrLiqUnit) / baseDesc * 100) : 0;
          const nome = it.nome || it.descricao || it.cod_produto || '';
          const tags = [
            it.cod_produto ? `<span style="background:#1a1f28;border-radius:3px;padding:1px 5px;font-size:.67rem;color:#6b7280">${esc(it.cod_produto)}</span>` : '',
            it.referencia  ? `<span style="background:#1a1f28;border-radius:3px;padding:1px 5px;font-size:.67rem;color:#6b7280">Ref ${esc(it.referencia)}</span>` : '',
            it.marca       ? `<span style="background:#162032;border-radius:3px;padding:1px 5px;font-size:.67rem;color:#60a5fa">${esc(it.marca)}</span>` : '',
          ].filter(Boolean).join(' ');
          const zb = i%2===1 ? 'background:#060a0f' : '';
          const promoCell = it.emPromocao && it.precoPromocao
            ? `<span style="color:#2dd4bf;font-weight:700">${fmtR(it.precoPromocao)}</span>` : '—';
          return `<tr style="${zb}">
            <td style="padding:.3rem .5rem">
              <div style="font-weight:600;color:#e6edf3">${esc(nome)}</div>
              ${tags ? `<div style="margin-top:2px">${tags}</div>` : ''}
            </td>
            <td style="padding:.3rem .5rem;text-align:right">${it.quantidade}</td>
            <td style="padding:.3rem .5rem;text-align:right">${fmtR(it.vlrUnitario||0)}</td>
            <td style="padding:.3rem .5rem;text-align:right">${promoCell}</td>
            <td style="padding:.3rem .5rem;text-align:right">${fmtR(it.vlrBruto||0)}</td>
            <td style="padding:.3rem .5rem;text-align:right;color:#DC2626">${it.vlrDesconto>0?fmtR(it.vlrDesconto):'—'}</td>
            <td style="padding:.3rem .5rem;text-align:right;color:#DC2626;font-size:.71rem">${percDesc>0.05?percDesc.toFixed(1)+'%':'—'}</td>
            <td style="padding:.3rem .5rem;text-align:right;font-weight:700">${fmtR(liq)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;

    return `
    <tr class="tk-row" data-idx="${idx}" style="cursor:pointer;${zebra};border-top:1px solid #21262d">
      <td style="padding:.4rem .35rem;width:18px;color:#4b5563;font-size:.75rem">▶</td>
      <td style="padding:.4rem .6rem;font-weight:700;white-space:nowrap">${fmtD(v.data)}</td>
      <td style="padding:.4rem .6rem;color:#8b949e;white-space:nowrap">${esc(v.hora||'—')}</td>
      <td style="padding:.4rem .6rem;font-family:monospace;font-size:.78rem">${esc(v.doc)}</td>
      <td style="padding:.4rem .6rem;font-size:.8rem;color:#8b949e">${esc(lojaLabel)}</td>
      <td style="padding:.4rem .6rem">${esc(v.vendedor||'—')}</td>
      <td style="padding:.4rem .6rem"><div style="display:flex;gap:4px;flex-wrap:wrap">${formasChips}</div></td>
      <td style="padding:.4rem .6rem;text-align:right;color:#DC2626;font-weight:700">${descVal>0?fmtR(descVal):'<span style="color:#374151">—</span>'}</td>
      <td style="padding:.4rem .6rem;text-align:right;font-weight:800">${fmtR(v.valorTotal)}</td>
    </tr>
    <tr class="tk-detail" data-idx="${idx}" style="display:none">
      <td colspan="9" style="padding:.75rem 1rem 1rem 2.5rem;background:#0a0e14;border-bottom:2px solid #30363d">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Formas de Pagamento</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${formasBlock}</div>
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Itens</div>
        <div style="overflow-x:auto">${itensBlock}</div>
      </td>
    </tr>`;
  }).join('');

  const total = vendas.reduce((s,v)=>s+(v.valorTotal||0),0);
  const totalDesc = vendas.reduce((s,v)=>s+(v.desconto?.valor||0),0);

  $('tkResult').innerHTML = `
    <div style="font-size:.78rem;color:#8b949e;margin-bottom:.5rem;padding:.25rem 0">
      ${vendas.length} venda${vendas.length!==1?'s':''} · Total: <strong style="color:#e6edf3">${fmtR(total)}</strong>${totalDesc>0?' · Desc.: <strong style="color:#DC2626">'+fmtR(totalDesc)+'</strong>':''}
    </div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#0d1117">
        <th style="width:18px;padding:0"></th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Data</th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Hora</th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Doc</th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Loja</th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Vendedor</th>
        <th style="text-align:left;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d">Pagamento</th>
        <th style="text-align:right;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d;width:100px">Desconto</th>
        <th style="text-align:right;padding:.45rem .6rem;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d;width:110px">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  $('tkResult').querySelectorAll('.tk-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.dataset.idx;
      const detail = $('tkResult').querySelector(`.tk-detail[data-idx="${idx}"]`);
      if (!detail) return;
      const open = detail.style.display === '';
      detail.style.display = open ? 'none' : '';
      const chevron = row.querySelector('td:first-child');
      if (chevron) chevron.textContent = open ? '▶' : '▼';
      row.style.background = open ? (idx%2===1?'#0d1117':'') : '#111827';
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
        <div class="mx-st-lbl-row">${lojas.map(l => `<span class="mx-st-col" style="color:${l.color}">${abbr(l.label)}</span>`).join('')}<span class="mx-cob-lbl">cob</span></div>
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
        <div class="mx-st-lbl-row">${refLojas.map(l => `<span class="mx-st-col" style="color:${l.color}">${abbr(l.label)}</span>`).join('')}<span class="mx-cob-lbl">cob</span></div>
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
  return cob < 4 ? '#f85149' : cob < 6 ? '#f97316' : '#3fb950';
}
function cobBadge(cob) {
  const clr = cobColor(cob);
  if (!clr) return '';
  return `<span class="mx-cob" style="color:${clr}">${cob.toFixed(1)}m</span>`;
}

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
function prodTable(produtos, stockRefs, lojas, periodDias) {
  const refStockMap = {};
  if (stockRefs) stockRefs.forEach(r => {
    const m = {};
    (r.lojas || []).forEach(l => { m[l.board] = l.qtd; });
    refStockMap[r.ref.toUpperCase()] = { bMap: m, total: r.totalQtd || Object.values(m).reduce((a,b)=>a+b,0) };
  });
  const hasStock = lojas && lojas.length > 0;
  const stHdr = hasStock
    ? lojas.map(l => `<th class="mx-prod-tbl-st" style="color:${l.color}" title="${l.label}">${abbr(l.label)}</th>`).join('') + '<th class="mx-prod-tbl-st mx-cob-lbl">cob</th>'
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
