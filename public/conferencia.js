(() => {
  const LOJAS = ['delrey','minas','contagem','estacao','tommy','surfers'];
  const LOJA_LABEL = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação', tommy:'Tommy', surfers:'Surfers' };

  const $ = id => document.getElementById(id);
  const fmtR  = v => 'R$ ' + (+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtD  = s => s ? s.split('-').reverse().join('/') : '—';
  const esc   = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error||r.statusText); }
    return r.json();
  }

  fetch('/api/me').then(r=>r.json()).then(u => { $('userLabel').textContent = u.label||u.username||''; }).catch(()=>{});

  // ── Tabs ─────────────────────────────────────────────────────────────────
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
  let _data = null, _grupo = 'lista';

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
    $('vStats').innerHTML=''; $('vResult').innerHTML='';
    try {
      _data = await api('GET', `/api/conferencia/vendas?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      render(_data);
    } catch(e) {
      $('vResult').innerHTML=`<div class="cf-empty" style="color:#ef4444">⚠ ${esc(e.message)}</div>`;
    } finally {
      btn.disabled=false;
      btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Buscar';
    }
  }

  function render(data) {
    const { vendas, porForma, porVendedor, totalVendas, totalAlertas, qtdVendas } = data;

    // ── Stats ────────────────────────────────────────────────────────────
    const totalDesc = vendas.reduce((s,v) => s + (v.desconto?.valor||0), 0);
    const comDesc   = vendas.filter(v => v.desconto?.valor > 0).length;
    $('vStats').innerHTML = `
      <div class="cf-stats">
        <div class="stat-card">
          <div class="stat-icon green">🛍</div>
          <div><div class="stat-val">${qtdVendas}</div><div class="stat-lbl">Vendas</div></div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue">💰</div>
          <div><div class="stat-val" style="font-size:16px">${fmtR(totalVendas)}</div><div class="stat-lbl">Total Líquido</div></div>
        </div>
        <div class="stat-card">
          <div class="stat-icon amber">🏷</div>
          <div><div class="stat-val" style="font-size:16px;color:var(--amber)">${fmtR(totalDesc)}</div><div class="stat-lbl">Total Descontos (${comDesc} vendas)</div></div>
        </div>
        ${totalAlertas ? `
        <div class="stat-card">
          <div class="stat-icon red">⚠</div>
          <div><div class="stat-val" style="color:var(--red)">${totalAlertas}</div><div class="stat-lbl">Com Alertas</div></div>
        </div>` : ''}
        ${data.regra?.parcelaMin ? `
        <div class="stat-card">
          <div class="stat-icon purple">💳</div>
          <div><div class="stat-val" style="font-size:14px">${fmtR(data.regra.parcelaMin)}</div><div class="stat-lbl">Parcela Mín.</div></div>
        </div>` : ''}
      </div>`;

    const el = $('vResult');
    if (!qtdVendas) { el.innerHTML='<div class="cf-empty">Nenhuma venda encontrada no período.</div>'; return; }

    if (_grupo==='forma')    { el.innerHTML = renderGrupos(porForma,    totalVendas, 'blue');   bindDrills(el); return; }
    if (_grupo==='vendedor') { el.innerHTML = renderGrupos(porVendedor, totalVendas, 'purple'); bindDrills(el); return; }

    el.innerHTML = `
      <div class="sales-card">
        <div class="sales-card-hdr">${qtdVendas} vendas encontradas</div>
        ${tabelaVendas(vendas)}
      </div>`;
    bindDrills(el);
  }

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
    if (!formas?.length) return '<span style="color:var(--muted);font-size:11px">—</span>';
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
    if (counts.parcela_minima)    parts.push(`<span class="badge badge-parc" title="${alertas.filter(a=>a.tipo==='parcela_minima').map(a=>esc(a.msg)).join('\n')}">💳 Parcela</span>`);
    if (counts.desconto_item)     parts.push(`<span class="badge badge-di"   title="${alertas.filter(a=>a.tipo==='desconto_item').map(a=>esc(a.msg)).join('\n')}">🏷 Item×${counts.desconto_item}</span>`);
    if (counts.desconto_venda)    parts.push(`<span class="badge badge-dv"   title="${alertas.filter(a=>a.tipo==='desconto_venda').map(a=>esc(a.msg)).join('\n')}">📉 Venda</span>`);
    if (counts.desconto_parcelado)       parts.push(`<span class="badge badge-dv"   title="${alertas.filter(a=>a.tipo==='desconto_parcelado').map(a=>esc(a.msg)).join('\n')}">🚫 Desc.Parcelado</span>`);
    if (counts.preco_promocao_divergente)parts.push(`<span class="badge badge-rede" title="${alertas.filter(a=>a.tipo==='preco_promocao_divergente').map(a=>esc(a.msg)).join('\n')}">🏷 Preço Promo</span>`);
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
          <th style="width:4px;padding:0"></th>
          <th>Data</th><th>Hora</th><th>Doc</th>
          <th>Vendedor</th><th>Forma de Pagamento</th>
          <th class="num">Desc. Produto</th>
          <th class="num">Total Venda</th>
          <th>Alertas</th>
          <th style="width:20px"></th>
        </tr></thead>
        <tbody>
          ${vendas.map((v,i) => {
            const did   = `dr-${i}-${Math.random().toString(36).slice(2,7)}`;
            const acc   = accentClass(v);
            const hasIt = v.itens?.length > 0;
            return `
            <tr class="sale-row ${acc==='alert'?'':''}${hasIt?`" data-drill="${did}`:''}" >
              <td class="accent-cell"><div class="accent-bar ${acc}"></div></td>
              <td style="font-weight:600">${fmtD(v.data)}</td>
              <td class="muted">${v.hora||'—'}</td>
              <td class="mono">${esc(v.doc)}</td>
              <td>${esc(v.vendedor||'—')}</td>
              <td><div class="pay-chips">${formaChips(v.formas)}</div></td>
              <td class="num">${v.desconto?.valor>0
                ? `<span style="color:var(--amber);font-weight:700">${fmtR(v.desconto.valor)}</span><span style="font-size:10px;color:var(--amber);margin-left:4px">${v.desconto.perc}%</span>`
                : '<span style="color:var(--muted)">—</span>'}</td>
              <td class="num" style="font-weight:700">${fmtR(v.valorTotal)}</td>
              <td>${alertBadges(v.alertas)}</td>
              <td style="color:var(--muted)">
                ${hasIt?`<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`:''}
              </td>
            </tr>
            ${hasIt?`<tr class="drill-row hidden" id="${did}"><td colspan="10" style="padding:0">${drillItens(v)}</td></tr>`:''}`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // ── Drill-down de itens ───────────────────────────────────────────────
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
            <th class="num">Qtd</th>
            <th class="num">Preço Tabela</th>
            <th class="num">Total Bruto</th>
            <th class="num">Desc. Produto</th>
            <th class="num">%</th>
            <th class="num">Total Líquido</th>
          </tr></thead>
          <tbody>
            ${itens.map(it => {
              const temDesc = it.vlrDesconto > 0;
              const liq = it.vlrLiquido ?? (it.vlrBruto - it.vlrDesconto);
              const promoTag = it.emPromocao
                ? `<span style="background:var(--teal-bg);color:var(--teal);font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:4px">PROMO ${it.precoPromocao?fmtR(it.precoPromocao):''}</span>`
                : '';
              return `<tr class="${temDesc?'has-disc':''}">
                <td>${esc(it.descricao)}${promoTag}</td>
                <td class="num">${it.quantidade}x</td>
                <td class="num">${fmtR(it.vlrUnitario)}</td>
                <td class="num">${fmtR(it.vlrBruto)}</td>
                <td class="num ${temDesc?'disc-val':'disc-zero'}">${temDesc?fmtR(it.vlrDesconto):'—'}</td>
                <td class="num">${temDesc?`<span class="disc-pct">${it.percDesconto}%</span>`:'—'}</td>
                <td class="num" style="font-weight:600">${fmtR(liq)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="3" style="font-size:11px;color:var(--muted)">Total</td>
              <td class="num">${fmtR(totalBruto)}</td>
              <td class="num" style="color:var(--amber)">${totalDesc>0?fmtR(totalDesc):'—'}</td>
              <td class="num" style="color:var(--amber)">${totalDesc>0&&totalBruto>0?`<span class="disc-pct">${((totalDesc/totalBruto)*100).toFixed(1)}%</span>`:'—'}</td>
              <td class="num" style="font-weight:700">${fmtR(itens.reduce((s,i)=>s+(i.vlrLiquido??(i.vlrBruto-i.vlrDesconto)),0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  // ── Grupos ────────────────────────────────────────────────────────────
  const GRUPO_COLORS = ['#3b82f6','#a855f7','#22c55e','#f59e0b','#14b8a6','#ef4444','#8b5cf6','#f97316'];

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
              ${alertas?`<span class="badge badge-di">⚠ ${alertas}</span>`:''}
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

  // ── Binding de cliques ────────────────────────────────────────────────
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
  // DASHBOARD
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
      $('dResult').innerHTML=`<div class="cf-empty" style="color:var(--red)">⚠ ${esc(e.message)}</div>`;
    } finally {
      btn.disabled=false;
      btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Buscar todas as lojas';
    }
  }

  const LOJA_COLORS = { delrey:'#3b82f6', minas:'#a855f7', contagem:'#22c55e', estacao:'#f59e0b', tommy:'#14b8a6', surfers:'#ef4444' };

  function renderDashboard({ porLoja, porVendedor }) {
    const lojas = porLoja.filter(l => !l.erro);

    // totais para normalizar barras
    const maxDesc  = Math.max(...lojas.map(l => l.percDesconto), 0.01);
    const maxCmv   = Math.max(...lojas.map(l => l.cmvPerc),      0.01);
    const maxVDesc = Math.max(...(porVendedor||[]).map(v => v.percDesconto), 0.01);

    const rankingCard = (title, icon, rows) => `
      <div class="sales-card" style="flex:1;min-width:280px">
        <div class="sales-card-hdr">${icon} ${title}</div>
        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
          ${rows}
        </div>
      </div>`;

    const barRow = (label, sublabel, pct, maxPct, color, valueLabel, extra='') => {
      const barW = Math.round((pct / maxPct) * 100);
      const alertColor = pct > maxPct * 0.7 ? 'var(--red)' : pct > maxPct * 0.4 ? 'var(--amber)' : 'var(--green)';
      return `
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
            <span style="font-weight:700;font-size:12px">${esc(label)}</span>
            <span style="font-size:13px;font-weight:800;color:${alertColor}">${valueLabel}</span>
          </div>
          ${sublabel ? `<div style="font-size:10px;color:var(--muted);margin-bottom:4px">${esc(sublabel)}</div>` : ''}
          <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${barW}%;background:${color};border-radius:3px;transition:width .4s"></div>
          </div>
          ${extra}
        </div>`;
    };

    // ── Ranking desconto por loja ──
    const lojasDesc = [...lojas].sort((a,b) => b.percDesconto - a.percDesconto);
    const rowsDescLoja = lojasDesc.map(l =>
      barRow(
        LOJA_LABEL[l.board] || l.board,
        `${fmtR(l.vlrDesconto)} de desconto em ${fmtR(l.vlrBruto)} bruto`,
        l.percDesconto, maxDesc,
        LOJA_COLORS[l.board] || 'var(--blue)',
        l.percDesconto.toFixed(1) + '%',
      )
    ).join('');

    // ── CMV por loja ──
    const lojasCmv = [...lojas].sort((a,b) => b.cmvPerc - a.cmvPerc);
    const rowsCmv = lojasCmv.map(l => {
      const cmvColor = l.cmvPerc > 60 ? 'var(--red)' : l.cmvPerc > 45 ? 'var(--amber)' : 'var(--green)';
      return barRow(
        LOJA_LABEL[l.board] || l.board,
        `Custo ${fmtR(l.vlrCusto)} / Venda Líq. ${fmtR(l.vlrLiquido)}`,
        l.cmvPerc, maxCmv,
        LOJA_COLORS[l.board] || 'var(--blue)',
        `<span style="color:${cmvColor}">${l.cmvPerc.toFixed(1)}%</span>`,
      );
    }).join('');

    // ── Resumo total por loja ──
    const totalLojas = lojas.reduce((s,l) => ({ vlrLiquido: s.vlrLiquido+l.vlrLiquido, vlrDesconto: s.vlrDesconto+l.vlrDesconto, vlrCusto: s.vlrCusto+l.vlrCusto }), { vlrLiquido:0, vlrDesconto:0, vlrCusto:0 });
    const totalCmv  = totalLojas.vlrLiquido > 0 ? (totalLojas.vlrCusto / totalLojas.vlrLiquido * 100) : 0;

    const statsHtml = `
      <div class="cf-stats" style="margin-bottom:18px">
        <div class="stat-card"><div class="stat-icon blue">💰</div>
          <div><div class="stat-val" style="font-size:15px">${fmtR(totalLojas.vlrLiquido)}</div><div class="stat-lbl">Venda Líquida Total</div></div></div>
        <div class="stat-card"><div class="stat-icon amber">🏷</div>
          <div><div class="stat-val" style="font-size:15px;color:var(--amber)">${fmtR(totalLojas.vlrDesconto)}</div><div class="stat-lbl">Desconto Total</div></div></div>
        <div class="stat-card"><div class="stat-icon ${totalCmv>60?'red':totalCmv>45?'amber':'green'}">📦</div>
          <div><div class="stat-val" style="color:${totalCmv>60?'var(--red)':totalCmv>45?'var(--amber)':'var(--green)'}">${totalCmv.toFixed(1)}%</div><div class="stat-lbl">CMV Geral</div></div></div>
      </div>`;

    // ── Top vendedores com mais desconto ──
    const topVend = (porVendedor||[]).slice(0, 15);
    const rowsVend = topVend.map(v =>
      barRow(
        v.nome,
        `${LOJA_LABEL[v.board]||v.board} · ${fmtR(v.vlrDesconto)} desc em ${fmtR(v.vlrBruto)} bruto`,
        v.percDesconto, maxVDesc,
        'var(--purple)',
        v.percDesconto.toFixed(1) + '%',
      )
    ).join('');

    $('dResult').innerHTML = `
      ${statsHtml}
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
        ${rankingCard('Desconto por Loja', '🏷', rowsDescLoja)}
        ${rankingCard('CMV por Loja', '📦', rowsCmv)}
      </div>
      <div style="margin-top:14px">
        ${rankingCard('Top Vendedores com Mais Desconto', '👤', rowsVend || '<div style="color:var(--muted);font-size:12px;padding:8px">Nenhum vendedor encontrado.</div>')}
      </div>`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // CONCILIAÇÃO REDE
  // ════════════════════════════════════════════════════════════════════════
  const fileDrop=$('fileDrop'), fileInput=$('redeFile');
  fileDrop.addEventListener('click', ()=>fileInput.click());
  fileDrop.addEventListener('dragover', e=>{e.preventDefault();fileDrop.style.borderColor='var(--blue)';});
  fileDrop.addEventListener('dragleave', ()=>fileDrop.style.borderColor='');
  fileDrop.addEventListener('drop', e=>{e.preventDefault();fileDrop.style.borderColor='';processRede(e.dataTransfer.files[0]);});
  fileInput.addEventListener('change', ()=>fileInput.files[0]&&processRede(fileInput.files[0]));

  async function processRede(file) {
    const board=$('cBoard').value, dtIni=$('cDtIni').value, dtFin=$('cDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Preencha loja e período antes de enviar o arquivo.');
    $('cResult').innerHTML='<div class="cf-empty"><span class="spinner"></span> Processando…</div>';
    try {
      const linhas = await parseRedeFile(file);
      if (!linhas.length) { $('cResult').innerHTML='<div class="cf-empty" style="color:#ef4444">Nenhuma transação encontrada no arquivo.</div>'; return; }
      $('cResult').innerHTML=`<div style="padding:8px 0;color:var(--muted);font-size:11px">${linhas.length} transações lidas. Cruzando com Microvix…</div>`;
      const data = await api('POST','/api/conferencia/conciliacao-rede',{board,dtIni,dtFin,linhas});
      renderConciliacao(data);
    } catch(e) { $('cResult').innerHTML=`<div class="cf-empty" style="color:#ef4444">⚠ ${esc(e.message)}</div>`; }
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
      <div class="cf-stats">
        <div class="stat-card"><div class="stat-icon purple">🔄</div><div><div class="stat-val">${totalRede}</div><div class="stat-lbl">Transações Rede</div></div></div>
        <div class="stat-card"><div class="stat-icon blue">📊</div><div><div class="stat-val">${totalMx}</div><div class="stat-lbl">Transações Microvix</div></div></div>
        <div class="stat-card"><div class="stat-icon green">✅</div><div><div class="stat-val" style="color:var(--green)">${ok}</div><div class="stat-lbl">Conciliadas</div></div></div>
        <div class="stat-card"><div class="stat-icon red">❌</div><div><div class="stat-val" style="color:var(--red)">${divergencias}</div><div class="stat-lbl">Divergências</div></div></div>
      </div>
      <div class="sales-card">
        <table class="cf-tbl">
          <thead><tr><th>Status</th><th>NSU</th><th>Bandeira</th><th class="num">Rede</th><th class="num">Microvix</th><th class="num">Diferença</th><th>Data</th></tr></thead>
          <tbody>
            ${resultado.map(r=>`<tr>
              <td>${statusBadge(r.status)}</td>
              <td class="mono">${esc(r.nsu)}</td>
              <td>${esc(r.rede?.bandeira||r.mx?.bandeira||'—')}</td>
              <td class="num">${r.rede?fmtR(r.rede.valor):'—'}</td>
              <td class="num">${r.mx?fmtR(r.mx.valor):'—'}</td>
              <td class="num">${r.difValor!=null?`<span style="color:${Math.abs(r.difValor)>.01?'var(--red)':'var(--green)'}">${fmtR(r.difValor)}</span>`:'—'}</td>
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
    catch(e){ alert('Erro ao carregar regras: '+e.message); }
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
            style="width:15px;height:15px;accent-color:var(--blue);cursor:pointer;flex-shrink:0"/>
          <label for="chk-${board}-ava" style="font-size:11px;cursor:pointer;text-transform:none;letter-spacing:0;color:var(--text)">
            Desconto somente à vista<br>
            <span style="font-size:10px;color:var(--muted)">(alerta se houver desc. em crédito parcelado)</span>
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
      setTimeout(()=>{btn.innerHTML='💾 Salvar';btn.disabled=false;},1500);
    } catch(e){ alert('Erro: '+e.message); btn.innerHTML='💾 Salvar'; btn.disabled=false; }
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
            out += `│     preco_custo         = ${it.preco_custo}  → custo usado\n`;
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
      status.textContent = `✓ ${data.movimento.total} mov · ${data.movimentoPlanos.total} planos · ${data.promocoes?.total??0} promoções · ${(data.vendas_calculadas||[]).length} vendas analisadas`;
    } catch(e) {
      status.textContent = '⚠ ' + e.message;
    } finally { btn.disabled=false; }
  });
})();
