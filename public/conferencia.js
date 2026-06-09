(() => {
  const LOJAS = ['delrey','minas','contagem','estacao','tommy','surfers'];
  const LOJA_LABEL = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação', tommy:'Tommy', surfers:'Surfers' };
  const LOJA_COLORS = { delrey:'#4AA3FF', minas:'#a78bfa', contagem:'#34d399', estacao:'#FF9A4A', tommy:'#2dd4bf', surfers:'#FF6161' };

  const $ = id => document.getElementById(id);
  const fmtR = v => 'R$ ' + (+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtD = s => s ? s.split('-').reverse().join('/') : '—';
  const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const P    = v => `var(--cf-${v})`;

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error||r.statusText); }
    return r.json();
  }

  fetch('/api/me').then(r=>r.json()).then(u => { $('userLabel').textContent = u.label||u.username||''; }).catch(()=>{});

  // ── Tabs ──────────────────────────────────────────────────────────────────
  document.querySelectorAll('.cf-tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.cf-tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.cf-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-'+btn.dataset.tab).classList.add('active');
  }));

  // ── Selects ───────────────────────────────────────────────────────────────
  ['vBoard','cBoard'].forEach(id => LOJAS.forEach(b => {
    const o = document.createElement('option');
    o.value = b; o.textContent = LOJA_LABEL[b];
    $(id).appendChild(o);
  }));

  const hoje = new Date().toISOString().slice(0,10);
  const ini  = hoje.slice(0,8)+'01';
  $('vDtIni').value = ini; $('vDtFin').value = hoje;
  $('cDtIni').value = ini; $('cDtFin').value = hoje;

  // ════════════════════════════════════════════════════════════════════════
  // VENDAS
  // ════════════════════════════════════════════════════════════════════════
  let _data = null, _grupo = 'lista', _filtroAlerta = false;

  $('vBuscarBtn').addEventListener('click', buscarVendas);
  document.querySelectorAll('.btn-grp').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-grp').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _grupo = btn.dataset.grupo;
    if (_data) render(_data);
  }));

  async function buscarVendas() {
    const board=$('vBoard').value, dtIni=$('vDtIni').value, dtFin=$('vDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Preencha loja e período.');
    const btn=$('vBuscarBtn');
    btn.disabled=true;
    btn.innerHTML='<span class="spinner"></span> Buscando…';
    const kpiRow = $('vKpiRow');
    kpiRow.style.display = 'none'; kpiRow.innerHTML = '';
    $('vResult').innerHTML = '';
    try {
      _data = await api('GET', `/api/conferencia/vendas?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      render(_data);
    } catch(e) {
      $('vResult').innerHTML = `<div class="cf-empty" style="color:${P('alert')}">⚠ ${esc(e.message)}</div>`;
    } finally {
      btn.disabled=false;
      btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Buscar';
    }
  }

  function render(data) {
    const { vendas, porForma, porVendedor, totalVendas, totalAlertas, qtdVendas } = data;

    // ── KPI cards ──────────────────────────────────────────────────────────
    const totalDesc = vendas.reduce((s,v) => s + (v.desconto?.valor||0), 0);
    const comDesc   = vendas.filter(v => v.desconto?.valor > 0).length;
    const percDesc  = totalVendas > 0 ? ((totalDesc / (totalVendas + totalDesc)) * 100).toFixed(1) : '0.0';

    const kpiRow = $('vKpiRow');
    kpiRow.innerHTML = `
      ${kpiCard('green', svgStore(), qtdVendas, 'Vendas no Período', comDesc + ' com desconto', '')}
      ${kpiCard('blue',  svgMoney(), fmtR(totalVendas), 'Total Líquido', '', '')}
      ${kpiCard('amber', svgTag(), fmtR(totalDesc), 'Total Descontos', percDesc + '% sobre bruto', 'desc', comDesc + ' vendas')}
      ${totalAlertas
        ? kpiCard('red', svgAlert(), totalAlertas, 'Com Alertas', 'Clique para filtrar', 'alerta', _filtroAlerta ? '● ativo' : '')
        : kpiCard('muted', svgCheck(), qtdVendas - (vendas.filter(v=>v.alertas?.length).length), 'Sem Alertas', '100% em conformidade', '')}`;
    kpiRow.style.display = 'grid';

    if (totalAlertas) {
      const cardAlerta = kpiRow.querySelector('.kpi-alerta');
      if (cardAlerta) {
        if (_filtroAlerta) cardAlerta.classList.add('active-filter');
        cardAlerta.classList.add('clickable');
        cardAlerta.addEventListener('click', () => { _filtroAlerta = !_filtroAlerta; render(_data); });
      }
    }

    const el = $('vResult');
    if (!qtdVendas) { el.innerHTML = '<div class="cf-empty">Nenhuma venda encontrada no período.</div>'; return; }

    if (_grupo === 'forma')    { el.innerHTML = renderGrupos(porForma,    totalVendas, 'blue');   bindDrills(el); return; }
    if (_grupo === 'vendedor') { el.innerHTML = renderGrupos(porVendedor, totalVendas, 'purple'); bindDrills(el); return; }

    const vendasFiltradas = _filtroAlerta ? vendas.filter(v => v.alertas && v.alertas.length > 0) : vendas;
    const hdr = _filtroAlerta
      ? `${vendasFiltradas.length} venda(s) com alerta <span style="color:${P('muted')};font-weight:400">de ${qtdVendas} total</span>`
      : `${qtdVendas} vendas encontradas`;
    el.innerHTML = `
      <div class="sales-card">
        <div class="sales-card-hdr">${hdr}</div>
        ${tabelaVendas(vendasFiltradas)}
      </div>`;
    bindDrills(el);
  }

  function kpiCard(color, iconSvg, value, label, sub, extraClass, badge) {
    const cls = extraClass ? `kpi-card kpi-${extraClass}` : 'kpi-card';
    return `
      <div class="${cls}">
        <div class="kpi-top">
          <div class="kpi-icon ${color}">${iconSvg}</div>
          ${badge ? `<span class="kpi-badge">${esc(badge)}</span>` : ''}
        </div>
        <div>
          <div class="kpi-val">${value}</div>
          <div class="kpi-meta" style="margin-top:6px">
            <span class="kpi-lbl">${label}</span>
            ${sub ? `<span class="kpi-sub" style="font-size:10px;color:${P('muted')}">${sub}</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  // SVG icons
  function svgStore()  { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`; }
  function svgMoney()  { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`; }
  function svgTag()    { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`; }
  function svgAlert()  { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`; }
  function svgCheck()  { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`; }
  function svgBox()    { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`; }
  function svgUser()   { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`; }
  function svgPct()    { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`; }

  // ── Helpers visuais ───────────────────────────────────────────────────
  function payChip(forma, bandeira, parcelas) {
    const f = (forma||'').toLowerCase();
    const cls = /créd|cred|crédito/i.test(f) ? 'credito'
              : /déb|deb|débito/i.test(f)    ? 'debito'
              : /pix/i.test(f)               ? 'pix'
              : /dinheiro|espécie/i.test(f)  ? 'dinheiro'
              :                                'outros';
    const parts = [];
    if (bandeira) parts.push(bandeira); else parts.push(forma);
    if (parcelas > 1) parts.push(`${parcelas}x`);
    return `<span class="pay-chip ${cls}">${esc(parts.join(' · '))}</span>`;
  }

  function formaChips(formas) {
    if (!formas?.length) return `<span style="color:${P('muted')};font-size:11px">—</span>`;
    const seen = new Set();
    return formas.map(f => {
      const key = (f.forma||'')+(f.bandeira||'')+(f.parcelas||1);
      if (seen.has(key)) return '';
      seen.add(key);
      return payChip(f.forma, f.bandeira, f.parcelas);
    }).join('');
  }

  function alertBadges(alertas) {
    if (!alertas?.length) return '';
    const counts = {};
    alertas.forEach(a => counts[a.tipo] = (counts[a.tipo]||0)+1);
    const parts = [];
    if (counts.parcela_minima)           parts.push(`<span class="badge badge-parc" title="${alertas.filter(a=>a.tipo==='parcela_minima').map(a=>esc(a.msg)).join('\n')}">💳 Parcela</span>`);
    if (counts.desconto_item)            parts.push(`<span class="badge badge-di"   title="${alertas.filter(a=>a.tipo==='desconto_item').map(a=>esc(a.msg)).join('\n')}">🏷 Item×${counts.desconto_item}</span>`);
    if (counts.desconto_venda)           parts.push(`<span class="badge badge-dv"   title="${alertas.filter(a=>a.tipo==='desconto_venda').map(a=>esc(a.msg)).join('\n')}">📉 Venda</span>`);
    if (counts.desconto_parcelado)       parts.push(`<span class="badge badge-dv"   title="${alertas.filter(a=>a.tipo==='desconto_parcelado').map(a=>esc(a.msg)).join('\n')}">🚫 Parcelado</span>`);
    if (counts.preco_promocao_divergente)parts.push(`<span class="badge badge-rede" title="${alertas.filter(a=>a.tipo==='preco_promocao_divergente').map(a=>esc(a.msg)).join('\n')}">🏷 Promo</span>`);
    return parts.join(' ');
  }

  function accentClass(v) {
    if (v.alertas?.length) return 'alert';
    if (v.desconto?.valor > 0) return 'disc';
    return 'ok';
  }

  // ── Tabela de vendas ──────────────────────────────────────────────────
  function tabelaVendas(vendas) {
    return `
      <table class="cf-tbl">
        <thead><tr>
          <th style="width:3px;padding:0"></th>
          <th>Data</th><th>Hora</th><th>Doc</th>
          <th>Vendedor</th><th>Pagamento</th>
          <th class="num">Desconto</th>
          <th class="num">Total</th>
          <th>Alertas</th>
          <th style="width:20px"></th>
        </tr></thead>
        <tbody>
          ${vendas.map((v,i) => {
            const did   = `dr-${i}-${Math.random().toString(36).slice(2,7)}`;
            const acc   = accentClass(v);
            const hasIt = v.itens?.length > 0;
            return `
            <tr class="sale-row"${hasIt ? ` data-drill="${did}"` : ''}>
              <td class="accent-cell"><div class="accent-bar ${acc}"></div></td>
              <td style="font-weight:700">${fmtD(v.data)}</td>
              <td class="muted">${v.hora||'—'}</td>
              <td class="mono">${esc(v.doc)}</td>
              <td>${esc(v.vendedor||'—')}</td>
              <td><div class="pay-chips">${formaChips(v.formas)}</div></td>
              <td class="num">${v.desconto?.valor>0
                ? `<span style="color:${P('accent')};font-weight:700">${fmtR(v.desconto.valor)}</span><span style="font-size:10px;color:${P('accent')};margin-left:4px">${v.desconto.perc}%</span>`
                : `<span style="color:${P('muted')}">—</span>`}</td>
              <td class="num" style="font-weight:800">${fmtR(v.valorTotal)}</td>
              <td>${alertBadges(v.alertas)}</td>
              <td style="color:${P('muted')}">
                ${hasIt ? `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>` : ''}
              </td>
            </tr>
            ${hasIt ? `<tr class="drill-row hidden" id="${did}"><td colspan="10" style="padding:0">${drillItens(v)}</td></tr>` : ''}`;
          }).join('')}
        </tbody>
      </table>`;
  }

  function drillItens(v) {
    const itens = v.itens || [];
    const totalBruto = itens.reduce((s,i)=>s+i.vlrBruto,0);
    const totalDesc  = itens.reduce((s,i)=>s+i.vlrDesconto,0);
    return `
      <div class="drill-wrap">
        <div class="drill-hdr">🧾 Itens da venda ${esc(v.doc)}</div>
        <table class="drill-tbl">
          <thead><tr>
            <th>Produto</th>
            <th class="num">Qtd</th><th class="num">Preço Tabela</th>
            <th class="num">Preço Promo</th>
            <th class="num">Total Bruto</th><th class="num">Desc.</th>
            <th class="num">%</th><th class="num">Total Líquido</th>
          </tr></thead>
          <tbody>
            ${itens.map(it => {
              const temDesc = it.vlrDesconto > 0;
              const liq = it.vlrLiquido ?? (it.vlrBruto - it.vlrDesconto);
              const subInfo = [it.nome, it.colecao].filter(Boolean).join(' · ');
              const promoCell = it.emPromocao && it.precoPromocao
                ? `<span style="color:#2dd4bf;font-weight:700">${fmtR(it.precoPromocao)}</span>`
                : '—';
              // % desconto: se em promoção, calcula sobre preço promo; senão sobre preço tabela
              const vlrLiqUnit = it.quantidade > 0 ? liq / it.quantidade : liq;
              const baseDescPct = it.emPromocao && it.precoPromocao ? it.precoPromocao : it.vlrUnitario;
              const percDesc = baseDescPct > 0 ? ((baseDescPct - vlrLiqUnit) / baseDescPct * 100) : 0;
              const temDescPct = percDesc > 0.05;
              return `<tr class="${temDesc?'has-disc':''}">
                <td>${esc(it.descricao)}${subInfo ? `<br><span style="font-size:10px;color:var(--cf-muted);font-weight:400">${esc(subInfo)}</span>` : ''}</td>
                <td class="num">${it.quantidade}x</td>
                <td class="num">${fmtR(it.vlrUnitario)}</td>
                <td class="num">${promoCell}</td>
                <td class="num">${fmtR(it.vlrBruto)}</td>
                <td class="num ${temDesc?'disc-val':'disc-zero'}">${temDesc?fmtR(it.vlrDesconto):'—'}</td>
                <td class="num">${temDescPct?`<span class="disc-pct">${percDesc.toFixed(1)}%</span>`:'—'}</td>
                <td class="num" style="font-weight:700">${fmtR(liq)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="4" style="font-size:11px;color:${P('muted')}">Total</td>
              <td class="num">${fmtR(totalBruto)}</td>
              <td class="num" style="color:${P('accent')}">${totalDesc>0?fmtR(totalDesc):'—'}</td>
              <td class="num" style="color:${P('accent')}">${totalDesc>0&&totalBruto>0?`<span class="disc-pct">${((totalDesc/totalBruto)*100).toFixed(1)}%</span>`:'—'}</td>
              <td class="num" style="font-weight:800">${fmtR(itens.reduce((s,i)=>s+(i.vlrLiquido??(i.vlrBruto-i.vlrDesconto)),0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  // ── Grupos ────────────────────────────────────────────────────────────
  const GRUPO_COLORS = ['#4AA3FF','#a78bfa','#34d399','#FF9A4A','#2dd4bf','#FF6161','#f97316','#8b5cf6'];

  function renderGrupos(grupos, totalGeral, colorTheme) {
    return grupos.map((g,gi) => {
      const cor    = GRUPO_COLORS[gi % GRUPO_COLORS.length];
      const pct    = totalGeral>0 ? (g.total/totalGeral*100).toFixed(1) : '0';
      const barW   = Math.max(4, Math.round(parseFloat(pct)*0.6));
      const alertas= (g.vendas||[]).filter(v=>v.alertas?.length).length;
      const bodyId = `gb-${gi}`;
      return `
        <div class="grupo-card">
          <div class="grupo-hdr" data-body="${bodyId}">
            <div class="grupo-color" style="background:${cor}"></div>
            <span class="grupo-title">${esc(g.label)}</span>
            <span class="grupo-meta">
              <span>${g.qtd} venda${g.qtd!==1?'s':''}</span>
              <span style="color:${cor}">${pct}%<span class="grupo-pct-bar" style="width:${barW}px;background:${cor}"></span></span>
              ${alertas ? `<span class="badge badge-di">⚠ ${alertas}</span>` : ''}
            </span>
            <span class="grupo-total">${fmtR(g.total)}</span>
            <svg class="grupo-chev chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="grupo-body" id="${bodyId}">
            <div class="sales-card-hdr" style="border-top:none">${g.qtd} vendas · ${fmtR(g.total)}</div>
            ${tabelaVendas(g.vendas||[])}
          </div>
        </div>`;
    }).join('');
  }

  function bindDrills(container) {
    container.querySelectorAll('.grupo-hdr:not([data-bound])').forEach(hdr => {
      hdr.dataset.bound = '1';
      hdr.addEventListener('click', () => {
        const body = document.getElementById(hdr.dataset.body);
        if (!body) return;
        const open = body.classList.toggle('open');
        hdr.querySelector('.chevron')?.classList.toggle('open', open);
        if (open) bindDrills(body);
      });
    });
    container.querySelectorAll('tr[data-drill]:not([data-bound])').forEach(row => {
      row.dataset.bound = '1';
      row.addEventListener('click', () => {
        const drill = document.getElementById(row.dataset.drill);
        if (!drill) return;
        const open = drill.classList.toggle('hidden');
        row.querySelector('.chevron')?.classList.toggle('open', !open);
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // DASHBOARD — exec_dark layout
  // ════════════════════════════════════════════════════════════════════════
  $('dDtIni').value = ini; $('dDtFin').value = hoje;
  $('dBuscarBtn').addEventListener('click', buscarDashboard);

  async function buscarDashboard() {
    const dtIni=$('dDtIni').value, dtFin=$('dDtFin').value;
    if (!dtIni||!dtFin) return alert('Preencha o período.');
    const btn=$('dBuscarBtn');
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Buscando…';
    $('dResult').innerHTML='<div class="cf-empty"><span class="spinner"></span> Consultando todas as lojas…</div>';
    try {
      const data = await api('GET', `/api/conferencia/dashboard?dtIni=${dtIni}&dtFin=${dtFin}`);
      renderDashboard(data);
    } catch(e) {
      $('dResult').innerHTML=`<div class="cf-empty" style="color:${P('alert')}">⚠ ${esc(e.message)}</div>`;
    } finally {
      btn.disabled=false;
      btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Buscar todas as lojas';
    }
  }

  function renderDashboard({ porLoja, porVendedor }) {
    const lojas = porLoja.filter(l => !l.erro);

    // Totais consolidados
    const tot = lojas.reduce((s,l) => ({
      vlrLiquido:  s.vlrLiquido  + l.vlrLiquido,
      vlrBruto:    s.vlrBruto    + l.vlrBruto,
      vlrDesconto: s.vlrDesconto + l.vlrDesconto,
      vlrCusto:    s.vlrCusto    + l.vlrCusto,
    }), { vlrLiquido:0, vlrBruto:0, vlrDesconto:0, vlrCusto:0 });

    const cmvGeral    = tot.vlrLiquido > 0 ? (tot.vlrCusto / tot.vlrLiquido * 100) : 0;
    const percDescGeral = tot.vlrBruto > 0 ? (tot.vlrDesconto / tot.vlrBruto * 100) : 0;
    const cmvColor    = cmvGeral > 60 ? 'alert' : cmvGeral > 45 ? 'amber' : 'green';
    const descColor   = percDescGeral > 8 ? 'alert' : percDescGeral > 4 ? 'amber' : 'green';

    // ── KPI row ──────────────────────────────────────────────────────────
    const kpiHtml = `
      <div class="kpi-row" style="margin-bottom:20px">
        ${kpiCard('blue',   svgMoney(), fmtR(tot.vlrLiquido),  'Vendas Líquidas',  lojas.length + ' lojas', '')}
        ${kpiCard(descColor,svgTag(),   fmtR(tot.vlrDesconto), 'Desconto Total',   percDescGeral.toFixed(1) + '% sobre bruto', '')}
        ${kpiCard(cmvColor, svgBox(),   cmvGeral.toFixed(1) + '%', 'CMV Geral', fmtR(tot.vlrCusto) + ' de custo', '')}
        ${kpiCard('purple', svgUser(),  (porVendedor||[]).length, 'Vendedores Ativos', 'com desconto registrado', '')}
      </div>`;

    // ── Horizontal bar helper ─────────────────────────────────────────────
    const maxDesc = Math.max(...lojas.map(l=>l.percDesconto), 0.01);
    const maxCmv  = Math.max(...lojas.map(l=>l.cmvPerc),      0.01);
    const maxVD   = Math.max(...(porVendedor||[]).map(v=>v.percDesconto), 0.01);

    function hbar(label, sublabel, pct, maxPct, color, valueStr) {
      const w = Math.max(2, Math.round((pct / maxPct) * 100));
      const alertCol = pct > maxPct * 0.75 ? P('alert') : pct > maxPct * 0.4 ? P('accent') : P('green');
      return `
        <div class="hbar-row">
          <div class="hbar-top">
            <span class="hbar-label">${esc(label)}</span>
            <span class="hbar-value" style="color:${alertCol}">${valueStr}</span>
          </div>
          ${sublabel ? `<div class="hbar-sub">${esc(sublabel)}</div>` : ''}
          <div class="hbar-track">
            <div class="hbar-fill" style="width:${w}%;background:${color}"></div>
          </div>
        </div>`;
    }

    // ── Desconto por loja ─────────────────────────────────────────────────
    const lojasDesc = [...lojas].sort((a,b)=>b.percDesconto-a.percDesconto);
    const descLojaRows = lojasDesc.map(l =>
      hbar(LOJA_LABEL[l.board]||l.board,
           `${fmtR(l.vlrDesconto)} em ${fmtR(l.vlrBruto)} bruto`,
           l.percDesconto, maxDesc,
           LOJA_COLORS[l.board]||P('primary'),
           l.percDesconto.toFixed(1)+'%')
    ).join('');

    // ── CMV por loja ──────────────────────────────────────────────────────
    const lojasCmv = [...lojas].sort((a,b)=>b.cmvPerc-a.cmvPerc);
    const cmvLojaRows = lojasCmv.map(l =>
      hbar(LOJA_LABEL[l.board]||l.board,
           `Custo ${fmtR(l.vlrCusto)} / Venda ${fmtR(l.vlrLiquido)}`,
           l.cmvPerc, maxCmv,
           LOJA_COLORS[l.board]||P('primary'),
           l.cmvPerc.toFixed(1)+'%')
    ).join('');

    // ── Top vendedores ────────────────────────────────────────────────────
    const topVend = (porVendedor||[]).slice(0,15);
    const vendRows = topVend.map((v,i) => `
      <tr>
        <td style="width:28px;color:${P('muted')};font-size:11px;font-weight:700">${i+1}</td>
        <td style="font-weight:600">${esc(v.nome)}</td>
        <td><span style="background:${LOJA_COLORS[v.board]||P('primary')}18;color:${LOJA_COLORS[v.board]||P('primary')};font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">${LOJA_LABEL[v.board]||v.board}</span></td>
        <td class="num" style="font-weight:700;color:${P('accent')}">${fmtR(v.vlrDesconto)}</td>
        <td class="num">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <div style="width:60px;height:5px;background:${P('card2')};border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${Math.round((v.percDesconto/maxVD)*100)}%;background:${P('purple')};border-radius:3px"></div>
            </div>
            <span style="font-weight:800;color:${v.percDesconto>maxVD*.7?P('alert'):v.percDesconto>maxVD*.4?P('accent'):P('green')}">${v.percDesconto.toFixed(1)}%</span>
          </div>
        </td>
      </tr>`).join('');

    // ── Lojas com erro ────────────────────────────────────────────────────
    const erros = porLoja.filter(l=>l.erro);
    const errosHtml = erros.length ? `
      <div style="margin-top:12px;padding:10px 14px;background:${P('card2')};border-radius:8px;border-left:3px solid ${P('muted')}">
        <span style="font-size:10px;color:${P('muted')};font-weight:700;text-transform:uppercase;letter-spacing:.5px">Lojas sem dados</span>
        ${erros.map(l=>`<span style="margin-left:8px;font-size:11px;color:${P('muted')}">${LOJA_LABEL[l.board]||l.board}</span>`).join('')}
      </div>` : '';

    $('dResult').innerHTML = `
      ${kpiHtml}
      <div class="cf-grid2 wide-left">
        <div class="col-stack">
          <div class="panel-card">
            <div class="panel-card-hdr">
              <span class="panel-card-title">Desconto por Loja</span>
              <span class="panel-card-meta">% sobre bruto</span>
            </div>
            <div class="panel-card-body">${descLojaRows}</div>
          </div>
          <div class="panel-card">
            <div class="panel-card-hdr">
              <span class="panel-card-title">CMV por Loja</span>
              <span class="panel-card-meta">custo ÷ venda líquida</span>
            </div>
            <div class="panel-card-body">${cmvLojaRows}</div>
          </div>
        </div>
        <div class="panel-card">
          <div class="panel-card-hdr">
            <span class="panel-card-title">Top Vendedores</span>
            <span class="panel-card-meta">por % desconto</span>
          </div>
          <table class="cf-tbl">
            <thead><tr>
              <th style="width:28px">#</th>
              <th>Vendedor</th><th>Loja</th>
              <th class="num">Desc.</th>
              <th class="num">% Desc.</th>
            </tr></thead>
            <tbody>${vendRows || `<tr><td colspan="5" style="text-align:center;color:${P('muted')};padding:24px;font-size:12px">Nenhum vendedor encontrado</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      ${errosHtml}`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // CONCILIAÇÃO REDE
  // ════════════════════════════════════════════════════════════════════════
  const fileDrop=$('fileDrop'), fileInput=$('redeFile');
  fileDrop.addEventListener('click', ()=>fileInput.click());
  fileDrop.addEventListener('dragover', e=>{e.preventDefault();fileDrop.style.borderColor=P('primary');});
  fileDrop.addEventListener('dragleave', ()=>fileDrop.style.borderColor='');
  fileDrop.addEventListener('drop', e=>{e.preventDefault();fileDrop.style.borderColor='';processRede(e.dataTransfer.files[0]);});
  fileInput.addEventListener('change', ()=>fileInput.files[0]&&processRede(fileInput.files[0]));

  async function processRede(file) {
    const board=$('cBoard').value, dtIni=$('cDtIni').value, dtFin=$('cDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Preencha loja e período antes de enviar o arquivo.');
    $('cResult').innerHTML=`<div class="cf-empty"><span class="spinner"></span> Processando…</div>`;
    try {
      const linhas = await parseRedeFile(file);
      if (!linhas.length) { $('cResult').innerHTML=`<div class="cf-empty" style="color:${P('alert')}">Nenhuma transação encontrada no arquivo.</div>`; return; }
      $('cResult').innerHTML=`<div style="padding:8px 0;color:${P('muted')};font-size:11px">${linhas.length} transações lidas. Cruzando com Microvix…</div>`;
      const data = await api('POST','/api/conferencia/conciliacao-rede',{board,dtIni,dtFin,linhas});
      renderConciliacao(data);
    } catch(e) { $('cResult').innerHTML=`<div class="cf-empty" style="color:${P('alert')}">⚠ ${esc(e.message)}</div>`; }
  }

  async function parseRedeFile(file) {
    return new Promise((resolve,reject) => {
      const reader=new FileReader();
      reader.onload=e=>{
        try {
          const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});
          const ws=wb.Sheets[wb.SheetNames[0]];
          const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
          const get=(r,...ns)=>{for(const n of ns){const k=Object.keys(r).find(k=>k.toString().toLowerCase().includes(n));if(k&&r[k]!=='')return String(r[k]).trim();}return '';};
          resolve(rows.map(r=>({
            nsu:      get(r,'nsu','autorizacao','autorização','cod_aut','numero'),
            bandeira: get(r,'bandeira','brand','cartao','cartão'),
            valor:    parseFloat(String(get(r,'valor','value','total','vlr')).replace(/[R$\s.]/g,'').replace(',','.')) || 0,
            data:     get(r,'data','date','dt'),
          })).filter(l=>l.nsu&&l.valor>0));
        } catch(err){reject(err);}
      };
      reader.onerror=reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function renderConciliacao(data) {
    const {resultado,totalMx,totalRede,ok,divergencias}=data;
    $('cResult').innerHTML=`
      <div class="kpi-row" style="margin-bottom:18px">
        ${kpiCard('purple', svgStore(), totalRede,    'Transações Rede', '', '')}
        ${kpiCard('blue',   svgBox(),   totalMx,      'Transações Microvix', '', '')}
        ${kpiCard('green',  svgCheck(), ok,            'Conciliadas', '', '')}
        ${kpiCard('red',    svgAlert(), divergencias,  'Divergências', '', '')}
      </div>
      <div class="panel-card">
        <table class="cf-tbl">
          <thead><tr><th>Status</th><th>NSU</th><th>Bandeira</th><th class="num">Rede</th><th class="num">Microvix</th><th class="num">Diferença</th><th>Data</th></tr></thead>
          <tbody>
            ${resultado.map(r=>`<tr>
              <td>${statusBadge(r.status)}</td>
              <td class="mono">${esc(r.nsu)}</td>
              <td>${esc(r.rede?.bandeira||r.mx?.bandeira||'—')}</td>
              <td class="num">${r.rede?fmtR(r.rede.valor):'—'}</td>
              <td class="num">${r.mx?fmtR(r.mx.valor):'—'}</td>
              <td class="num">${r.difValor!=null?`<span style="color:${Math.abs(r.difValor)>.01?P('alert'):P('green')}">${fmtR(r.difValor)}</span>`:'—'}</td>
              <td class="muted">${esc(r.rede?.data||r.mx?.data||'—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function statusBadge(s) {
    return ({
      ok:                '<span class="badge badge-ok">✓ OK</span>',
      divergencia_valor: '<span class="badge badge-di">Valor diferente</span>',
      somente_microvix:  '<span class="badge badge-parc">Só Microvix</span>',
      somente_rede:      '<span class="badge badge-rede">Só Rede</span>',
    })[s]||s;
  }

  // ════════════════════════════════════════════════════════════════════════
  // REGRAS
  // ════════════════════════════════════════════════════════════════════════
  let regrasData = {};

  async function loadRegras() {
    try { regrasData=await api('GET','/api/conferencia/regras'); renderRegras(); }
    catch(e){ console.warn('Erro ao carregar regras:', e.message); }
  }

  function renderRegras() {
    const grid=$('regrasGrid');
    grid.innerHTML='';
    LOJAS.forEach(board => {
      const r=regrasData[board]||{};
      const card=document.createElement('div');
      card.className='regra-card';
      card.innerHTML=`
        <h3>${LOJA_LABEL[board]}</h3>
        <div class="rf"><label>Parcela mínima (R$)</label>
          <input type="number" min="0" step="0.01" data-board="${board}" data-field="parcelaMin" value="${r.parcelaMin||0}"/></div>
        <div class="rf"><label>Desc. máx. por item (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxItem" value="${r.descontoMaxItem||0}"/></div>
        <div class="rf"><label>Desc. máx. por venda (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxVenda" value="${r.descontoMaxVenda||0}"/></div>
        <div class="rf" style="flex-direction:row;align-items:center;gap:8px;margin-top:4px">
          <input type="checkbox" id="chk-${board}-ava" data-board="${board}" data-field="descontoSomenteAVista" data-type="bool" ${r.descontoSomenteAVista?'checked':''}
            style="width:15px;height:15px;accent-color:${P('primary')};cursor:pointer;flex-shrink:0"/>
          <label for="chk-${board}-ava" style="font-size:11px;cursor:pointer;text-transform:none;letter-spacing:0;color:${P('text')}">
            Desconto somente à vista<br>
            <span style="font-size:10px;color:${P('muted')}">(alerta se houver desc. em crédito parcelado)</span>
          </label>
        </div>`;
      grid.appendChild(card);
    });
  }

  $('salvarRegrasBtn').addEventListener('click', async () => {
    document.querySelectorAll('#regrasGrid input').forEach(inp => {
      const {board,field,type}=inp.dataset;
      if (!regrasData[board]) regrasData[board]={};
      if (type === 'bool') regrasData[board][field] = inp.checked;
      else regrasData[board][field] = parseFloat(inp.value)||0;
    });
    const btn=$('salvarRegrasBtn');
    btn.disabled=true; btn.textContent='Salvando…';
    try {
      await api('PUT','/api/conferencia/regras',regrasData);
      btn.innerHTML='✅ Salvo';
      setTimeout(()=>{btn.innerHTML='💾 Salvar Regras';btn.disabled=false;},1500);
    } catch(e){ alert('Erro: '+e.message); btn.innerHTML='💾 Salvar Regras'; btn.disabled=false; }
  });

  loadRegras();

  // ════════════════════════════════════════════════════════════════════════
  // DEBUG
  // ════════════════════════════════════════════════════════════════════════
  $('debugBtn').addEventListener('click', async () => {
    const board=$('vBoard').value, dtIni=$('vDtIni').value, dtFin=$('vDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Selecione loja e período primeiro.');
    const btn=$('debugBtn'), status=$('debugStatus'), panel=$('debugPanel'), content=$('debugContent');
    btn.disabled=true; status.textContent='Carregando…';
    try {
      const data = await api('GET', `/api/conferencia/debug?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      const fmtRows = (label, obj) => {
        const rows = obj.amostra || [];
        const keys = rows.length ? Object.keys(rows[0]) : [];
        let out = `══ ${label} (${obj.total} linhas) — primeiras ${rows.length} ══\n`;
        rows.forEach((r,i) => {
          out += `\n--- Linha ${i+1} ---\n`;
          keys.forEach(k => { out += `  ${k.padEnd(30)} ${JSON.stringify(r[k])}\n`; });
        });
        return out + '\n';
      };
      const fmtVendas = vendas => {
        let out = `══ VENDAS CALCULADAS (primeiras ${vendas.length}) ══\n`;
        vendas.forEach(v => {
          out += `\n┌── Doc ${v.doc}  →  Total calculado: R$ ${v['→ totalVendaCalculado']}\n`;
          out += `│   Formas: ${v.formas.map(f=>`${f.desc_plano} ${f.qtde_parcelas}x = ${f.total}`).join(' | ')}\n`;
          v.itens.forEach((it,i) => {
            out += `│   Item ${i+1}: cod=${it.cod_produto} qty=${it.quantidade}\n`;
            out += `│     preco_tabela_epoca  = ${it.preco_tabela_epoca}  → bruto unit\n`;
            out += `│     preco_unitario      = ${it.preco_unitario}  → líquido unit\n`;
            out += `│     preco_custo         = ${it.preco_custo}\n`;
            out += `│     custo_medio_epoca   = ${it.custo_medio_epoca}\n`;
            out += `│     desconto_item       = ${it.desconto_item}\n`;
            out += `│     → liq (×qtd)       = R$ ${it['→ vlrLiq(×qtd)']}\n`;
            out += `│     → custo (×qtd)     = R$ ${it['→ vlrCusto(×qtd)']}\n`;
            out += `│     → CMV item         = ${it['→ CMV_item(%)']}\n`;
          });
          out += `└──\n`;
        });
        return out;
      };
      content.textContent = fmtRows('LinxMovimento', data.movimento)
                          + fmtRows('LinxMovimentoPlanos', data.movimentoPlanos)
                          + fmtRows('LinxProdutosPromocoes', data.promocoes)
                          + fmtVendas(data.vendas_calculadas || []);
      panel.classList.remove('hidden');
      const promoInfo = data.promocoes?.erro ? `⚠ promoções: ${data.promocoes.erro}` : `${data.promocoes?.total??0} promoções`;
      status.textContent = `✓ ${data.movimento.total} mov · ${data.movimentoPlanos.total} planos · ${promoInfo} · ${(data.vendas_calculadas||[]).length} vendas`;
    } catch(e) {
      status.textContent = '⚠ ' + e.message;
    } finally { btn.disabled=false; }
  });
})();
