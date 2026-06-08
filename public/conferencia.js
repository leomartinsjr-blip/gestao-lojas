(() => {
  const LOJAS = ['delrey','minas','contagem','estacao','tommy','surfers'];
  const LOJA_LABEL = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação', tommy:'Tommy', surfers:'Surfers' };

  const $ = id => document.getElementById(id);
  const fmtR = v => 'R$ ' + (+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtD = s => s ? s.split('-').reverse().join('/') : '—';
  const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error||r.statusText); }
    return r.json();
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
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

  // Datas padrão: mês corrente
  const hoje = new Date().toISOString().slice(0,10);
  const ini  = hoje.slice(0,8)+'01';
  $('vDtIni').value = ini; $('vDtFin').value = hoje;
  $('cDtIni').value = ini; $('cDtFin').value = hoje;

  // ════════════════════════════════════════════════════════════════════════
  // VENDAS
  // ════════════════════════════════════════════════════════════════════════
  let _data = null;
  let _grupo = 'lista';

  $('vBuscarBtn').addEventListener('click', buscarVendas);
  document.querySelectorAll('.btn-seg').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-seg').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _grupo = btn.dataset.grupo;
    if (_data) render(_data);
  }));

  async function buscarVendas() {
    const board = $('vBoard').value, dtIni = $('vDtIni').value, dtFin = $('vDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Preencha loja e período.');
    const btn = $('vBuscarBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    $('vSummary').innerHTML = ''; $('vResult').innerHTML = '';
    try {
      _data = await api('GET', `/api/conferencia/vendas?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      render(_data);
    } catch(e) {
      $('vResult').innerHTML = `<div class="cf-empty" style="color:#ef4444">${esc(e.message)}</div>`;
    } finally { btn.disabled=false; btn.textContent='Buscar'; }
  }

  function render(data) {
    const { vendas, porForma, porVendedor, totalVendas, totalAlertas, qtdVendas } = data;

    // Summary
    $('vSummary').innerHTML = `
      <div class="cf-summary">
        <div class="cf-chip"><div class="cf-chip-val">${qtdVendas}</div><div class="cf-chip-lbl">Vendas</div></div>
        <div class="cf-chip"><div class="cf-chip-val">${fmtR(totalVendas)}</div><div class="cf-chip-lbl">Total</div></div>
        ${totalAlertas ? `<div class="cf-chip"><div class="cf-chip-val" style="color:#f59e0b">${totalAlertas}</div><div class="cf-chip-lbl">Com alerta</div></div>` : ''}
        ${data.regra?.parcelaMin ? `<div class="cf-chip"><div class="cf-chip-val" style="font-size:13px">${fmtR(data.regra.parcelaMin)}</div><div class="cf-chip-lbl">Parcela mín.</div></div>` : ''}
        ${data.regra?.descontoMaxVenda ? `<div class="cf-chip"><div class="cf-chip-val" style="font-size:13px">${data.regra.descontoMaxVenda}%</div><div class="cf-chip-lbl">Desc. máx. venda</div></div>` : ''}
      </div>`;

    const el = $('vResult');
    if (!qtdVendas) { el.innerHTML = '<div class="cf-empty">Nenhuma venda encontrada.</div>'; return; }

    if (_grupo === 'forma')    { el.innerHTML = renderGrupos(porForma,    totalVendas, 'Forma de Pagamento', v => esc(v.vendedor)); return; }
    if (_grupo === 'vendedor') { el.innerHTML = renderGrupos(porVendedor, totalVendas, 'Vendedor', v => esc(formasLabel(v.formas))); return; }

    // Lista simples
    el.innerHTML = `
      <div class="cf-card">
        <div class="cf-card-body open">
          ${tabelaVendas(vendas, v => esc(v.vendedor), v => esc(formasLabel(v.formas)))}
        </div>
      </div>`;
    bindDrills(el);
  }

  function formasLabel(formas) {
    if (!formas?.length) return '—';
    return [...new Set(formas.map(f => f.bandeira ? `${f.forma} / ${f.bandeira}` : f.forma))].join(' · ');
  }

  function badges(alertas) {
    if (!alertas?.length) return '';
    return alertas.map(a => {
      const [cls,lbl] = a.tipo==='parcela_minima' ? ['badge-parc','Parcela']
                      : a.tipo==='desconto_item'   ? ['badge-di','Desc.Item']
                      :                              ['badge-dv','Desc.Venda'];
      return `<span class="badge ${cls}" title="${esc(a.msg)}">${lbl}</span>`;
    }).join(' ');
  }

  function tabelaVendas(vendas, colA, colB) {
    return `<table class="cf-tbl">
      <thead><tr>
        <th>Data</th><th>Hora</th><th>Doc</th>
        <th>Vendedor</th><th>Forma Pgto</th>
        <th class="num">Desconto</th><th class="num">Total</th><th>Alertas</th><th></th>
      </tr></thead>
      <tbody>
        ${vendas.map((v,i) => {
          const drillId = `dr-${i}-${Math.random().toString(36).slice(2,6)}`;
          const hasItens = v.itens?.length > 0;
          return `
          <tr class="${v.alertas?.length?'row-alert':''}" ${hasItens?`data-drill="${drillId}" style="cursor:pointer"`:''}">
            <td>${fmtD(v.data)}</td>
            <td class="muted">${v.hora||'—'}</td>
            <td class="mono">${v.doc}</td>
            <td>${colA(v)}</td>
            <td style="font-size:11px;color:var(--muted)">${colB(v)}</td>
            <td class="num" style="color:${v.desconto?.valor?'#f59e0b':'var(--muted)'}">
              ${v.desconto?.valor ? fmtR(v.desconto.valor)+` <span style="font-size:10px">(${v.desconto.perc}%)</span>` : '—'}
            </td>
            <td class="num">${fmtR(v.valorTotal)}</td>
            <td>${badges(v.alertas)}</td>
            <td style="width:16px;color:var(--muted)">
              ${hasItens ? `<svg class="cf-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>` : ''}
            </td>
          </tr>
          ${hasItens ? `<tr id="${drillId}" class="hidden"><td colspan="9" style="padding:0">${drillItens(v.itens)}</td></tr>` : ''}`;
        }).join('')}
      </tbody>
    </table>`;
  }

  function drillItens(itens) {
    return `<div class="cf-drill">
      <table class="cf-drill-tbl">
        <thead><tr><th>Produto</th><th>Qtd</th><th class="num">Unitário</th><th class="num">Bruto</th><th class="num">Desconto</th><th class="num">%</th></tr></thead>
        <tbody>
          ${itens.map(it => `<tr>
            <td>${esc(it.descricao)}</td>
            <td>${it.quantidade}</td>
            <td class="num">${fmtR(it.vlrUnitario)}</td>
            <td class="num">${fmtR(it.vlrBruto)}</td>
            <td class="num ${it.vlrDesconto>0?'alert-col':''}">${it.vlrDesconto>0?fmtR(it.vlrDesconto):'—'}</td>
            <td class="num ${parseFloat(it.percDesconto)>0?'alert-col':''}">${parseFloat(it.percDesconto)>0?it.percDesconto+'%':'—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function renderGrupos(grupos, totalGeral, tituloCol, subLabel) {
    return grupos.map((g,gi) => {
      const pct    = totalGeral>0 ? (g.total/totalGeral*100).toFixed(1) : '0';
      const alertas= (g.vendas||[]).filter(v=>v.alertas?.length).length;
      const barW   = Math.round(parseFloat(pct)*0.8); // max ~80px
      const cardId = `gc-${gi}`;
      const bodyId = `gb-${gi}`;
      return `
        <div class="cf-card">
          <div class="cf-card-hdr" data-card="${cardId}" data-body="${bodyId}">
            <span class="cf-card-title">${esc(g.label)}</span>
            <span class="cf-card-meta">
              <span>${g.qtd} venda${g.qtd!==1?'s':''}</span>
              <span>${pct}%<span class="perc-bar" style="width:${barW}px"></span></span>
              ${alertas ? `<span class="badge badge-di">${alertas} alertas</span>` : ''}
            </span>
            <span class="cf-card-total">${fmtR(g.total)}</span>
            <svg class="cf-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="cf-card-body" id="${bodyId}">
            ${tabelaVendas(g.vendas||[], v=>esc(v.vendedor), v=>esc(formasLabel(v.formas)))}
          </div>
        </div>`;
    }).join('');
  }

  function bindDrills(container) {
    // Card headers
    container.querySelectorAll('.cf-card-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const body = container.querySelector('#'+hdr.dataset.body);
        if (!body) return;
        const open = body.classList.toggle('open');
        hdr.querySelector('.cf-chevron')?.classList.toggle('open', open);
      });
    });
    // Row drills (itens da venda)
    container.querySelectorAll('tr[data-drill]').forEach(row => {
      row.addEventListener('click', () => {
        const drill = container.querySelector('#'+row.dataset.drill);
        if (!drill) return;
        const open = drill.classList.toggle('hidden');
        row.querySelector('.cf-chevron')?.classList.toggle('open', !open);
      });
    });
  }

  // Bind para lista (sem grupos)
  const vResult = $('vResult');
  const observer = new MutationObserver(() => bindDrills(vResult));
  observer.observe(vResult, { childList:true });

  // Bind para grupos
  const vResultObs = new MutationObserver(() => {
    vResult.querySelectorAll('.cf-card-hdr').forEach(hdr => {
      if (hdr._bound) return; hdr._bound = true;
      hdr.addEventListener('click', () => {
        const body = document.getElementById(hdr.dataset.body);
        if (!body) return;
        const open = body.classList.toggle('open');
        hdr.querySelector('.cf-chevron')?.classList.toggle('open', open);
        bindDrills(body);
      });
    });
  });
  vResultObs.observe(vResult, { childList:true, subtree:true });

  // ════════════════════════════════════════════════════════════════════════
  // CONCILIAÇÃO REDE
  // ════════════════════════════════════════════════════════════════════════
  const fileDrop = $('fileDrop'), fileInput = $('redeFile');
  fileDrop.addEventListener('click', ()=>fileInput.click());
  fileDrop.addEventListener('dragover', e=>{e.preventDefault();fileDrop.style.borderColor='var(--accent,#3b82f6)';});
  fileDrop.addEventListener('dragleave', ()=>fileDrop.style.borderColor='');
  fileDrop.addEventListener('drop', e=>{e.preventDefault();fileDrop.style.borderColor='';processRede(e.dataTransfer.files[0]);});
  fileInput.addEventListener('change', ()=>fileInput.files[0]&&processRede(fileInput.files[0]));

  async function processRede(file) {
    const board=$('cBoard').value, dtIni=$('cDtIni').value, dtFin=$('cDtFin').value;
    if (!board||!dtIni||!dtFin) return alert('Preencha loja e período antes de enviar o arquivo.');
    $('cResult').innerHTML = '<div class="cf-empty"><span class="spinner"></span> Processando…</div>';
    try {
      const linhas = await parseRedeFile(file);
      if (!linhas.length) { $('cResult').innerHTML='<div class="cf-empty" style="color:#ef4444">Nenhuma transação encontrada no arquivo.</div>'; return; }
      $('cResult').innerHTML = `<div style="padding:8px 0;color:var(--muted);font-size:11px">${linhas.length} transações lidas. Cruzando com Microvix…</div>`;
      const data = await api('POST', '/api/conferencia/conciliacao-rede', { board, dtIni, dtFin, linhas });
      renderConciliacao(data);
    } catch(e) { $('cResult').innerHTML=`<div class="cf-empty" style="color:#ef4444">${esc(e.message)}</div>`; }
  }

  async function parseRedeFile(file) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb   = XLSX.read(new Uint8Array(e.target.result), {type:'array'});
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
          const get  = (r,...names) => { for (const n of names) { const k=Object.keys(r).find(k=>k.toString().toLowerCase().includes(n)); if (k&&r[k]!=='') return String(r[k]).trim(); } return ''; };
          resolve(rows.map(r=>({
            nsu:      get(r,'nsu','autorizacao','autorização','cod_aut','numero'),
            bandeira: get(r,'bandeira','brand','cartao','cartão'),
            valor:    parseFloat(String(get(r,'valor','value','total','vlr')).replace(/[R$\s.]/g,'').replace(',','.')) || 0,
            data:     get(r,'data','date','dt'),
          })).filter(l=>l.nsu&&l.valor>0));
        } catch(err){reject(err);}
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function renderConciliacao(data) {
    const { resultado, totalMx, totalRede, ok, divergencias } = data;
    $('cResult').innerHTML = `
      <div class="cf-summary">
        <div class="cf-chip"><div class="cf-chip-val">${totalRede}</div><div class="cf-chip-lbl">Transações Rede</div></div>
        <div class="cf-chip"><div class="cf-chip-val">${totalMx}</div><div class="cf-chip-lbl">Transações Microvix</div></div>
        <div class="cf-chip"><div class="cf-chip-val" style="color:#22c55e">${ok}</div><div class="cf-chip-lbl">Conciliadas</div></div>
        <div class="cf-chip"><div class="cf-chip-val" style="color:#ef4444">${divergencias}</div><div class="cf-chip-lbl">Divergências</div></div>
      </div>
      <div class="cf-card">
        <div class="cf-card-body open">
          <table class="cf-tbl">
            <thead><tr>
              <th>Status</th><th>NSU</th><th>Bandeira</th>
              <th class="num">Rede</th><th class="num">Microvix</th><th class="num">Diferença</th><th>Data</th>
            </tr></thead>
            <tbody>
              ${resultado.map(r=>`<tr>
                <td>${statusBadge(r.status)}</td>
                <td class="mono">${r.nsu}</td>
                <td>${esc(r.rede?.bandeira||r.mx?.bandeira||'—')}</td>
                <td class="num">${r.rede?fmtR(r.rede.valor):'—'}</td>
                <td class="num">${r.mx?fmtR(r.mx.valor):'—'}</td>
                <td class="num">${r.difValor!=null?`<span style="color:${Math.abs(r.difValor)>.01?'#ef4444':'#22c55e'}">${fmtR(r.difValor)}</span>`:'—'}</td>
                <td class="muted">${esc(r.rede?.data||r.mx?.data||'—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
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
    try { regrasData = await api('GET','/api/conferencia/regras'); renderRegras(); }
    catch(e) { alert('Erro ao carregar regras: '+e.message); }
  }

  function renderRegras() {
    const grid = $('regrasGrid');
    grid.innerHTML = '';
    LOJAS.forEach(board => {
      const r = regrasData[board]||{};
      const card = document.createElement('div');
      card.className = 'regra-card';
      card.innerHTML = `
        <h3>${LOJA_LABEL[board]}</h3>
        <div class="rf"><label>Parcela mínima (R$)</label>
          <input type="number" min="0" step="0.01" data-board="${board}" data-field="parcelaMin" value="${r.parcelaMin||0}"/></div>
        <div class="rf"><label>Desconto máximo por item (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxItem" value="${r.descontoMaxItem||0}"/></div>
        <div class="rf"><label>Desconto máximo por venda (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxVenda" value="${r.descontoMaxVenda||0}"/></div>`;
      grid.appendChild(card);
    });
  }

  $('salvarRegrasBtn').addEventListener('click', async () => {
    document.querySelectorAll('#regrasGrid input').forEach(inp => {
      const {board,field} = inp.dataset;
      if (!regrasData[board]) regrasData[board]={};
      regrasData[board][field] = parseFloat(inp.value)||0;
    });
    const btn = $('salvarRegrasBtn');
    btn.disabled=true; btn.textContent='Salvando…';
    try {
      await api('PUT','/api/conferencia/regras',regrasData);
      btn.textContent='✓ Salvo';
      setTimeout(()=>{btn.textContent='Salvar';btn.disabled=false;},1500);
    } catch(e) { alert('Erro: '+e.message); btn.textContent='Salvar'; btn.disabled=false; }
  });

  loadRegras();
})();
