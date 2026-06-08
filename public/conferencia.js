(() => {
  const LOJAS = ['delrey','minas','contagem','estacao','tommy','surfers'];
  const LOJA_LABEL = {
    delrey:'Del Rey', minas:'Minas', contagem:'Contagem',
    estacao:'Estação', tommy:'Tommy', surfers:'Surfers',
  };

  const $ = id => document.getElementById(id);
  const fmt = v => 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  async function apiFetch(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.conf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.conf-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.conf-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ── Selects de loja ───────────────────────────────────────────────────────
  function populateSelect(sel) {
    LOJAS.forEach(b => {
      const o = document.createElement('option');
      o.value = b; o.textContent = LOJA_LABEL[b] || b;
      sel.appendChild(o);
    });
  }
  populateSelect($('alertaBoard'));
  populateSelect($('concBoard'));

  // Datas padrão: mês corrente
  const hoje = new Date().toISOString().slice(0, 10);
  const ini  = hoje.slice(0, 8) + '01';
  $('alertaDtIni').value = ini; $('alertaDtFin').value = hoje;
  $('concDtIni').value   = ini; $('concDtFin').value   = hoje;

  // Auth
  fetch('/api/me').then(r => r.json()).then(u => {
    $('userLabel').textContent = u.label || u.username || '';
  }).catch(() => {});

  // ════════════════════════════════════════════════════════════════════════
  // PAINEL: REGRAS
  // ════════════════════════════════════════════════════════════════════════
  let regrasData = {};

  function renderRegras() {
    const grid = $('regrasGrid');
    grid.innerHTML = '';
    LOJAS.forEach(board => {
      const r = regrasData[board] || {};
      const card = document.createElement('div');
      card.className = 'regra-card';
      card.innerHTML = `
        <h3>${LOJA_LABEL[board] || board}</h3>
        <div class="regra-field">
          <label>Parcela mínima (R$)</label>
          <input type="number" min="0" step="0.01" data-board="${board}" data-field="parcelaMin"
            value="${r.parcelaMin || 0}" placeholder="0 = desativado"/>
        </div>
        <div class="regra-field">
          <label>Desconto máximo por item (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxItem"
            value="${r.descontoMaxItem || 0}" placeholder="0 = desativado"/>
        </div>
        <div class="regra-field">
          <label>Desconto máximo por venda (%)</label>
          <input type="number" min="0" max="100" step="0.1" data-board="${board}" data-field="descontoMaxVenda"
            value="${r.descontoMaxVenda || 0}" placeholder="0 = desativado"/>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  async function loadRegras() {
    try {
      regrasData = await apiFetch('GET', '/api/conferencia/regras');
      renderRegras();
    } catch (e) { alert('Erro ao carregar regras: ' + e.message); }
  }

  $('salvarRegrasBtn').addEventListener('click', async () => {
    document.querySelectorAll('#regrasGrid input').forEach(inp => {
      const { board, field } = inp.dataset;
      if (!regrasData[board]) regrasData[board] = {};
      regrasData[board][field] = parseFloat(inp.value) || 0;
    });
    try {
      $('salvarRegrasBtn').disabled = true;
      $('salvarRegrasBtn').textContent = 'Salvando…';
      await apiFetch('PUT', '/api/conferencia/regras', regrasData);
      $('salvarRegrasBtn').textContent = '✓ Salvo';
      setTimeout(() => { $('salvarRegrasBtn').textContent = 'Salvar Regras'; $('salvarRegrasBtn').disabled = false; }, 1500);
    } catch (e) {
      alert('Erro ao salvar: ' + e.message);
      $('salvarRegrasBtn').textContent = 'Salvar Regras';
      $('salvarRegrasBtn').disabled = false;
    }
  });

  loadRegras();

  // ════════════════════════════════════════════════════════════════════════
  // PAINEL: VENDAS (todas, com agrupamento e alertas)
  // ════════════════════════════════════════════════════════════════════════
  let _vendaData = null;
  let _agrupamento = 'lista'; // 'lista' | 'forma' | 'vendedor'

  $('buscarAlertasBtn').addEventListener('click', buscarVendas);
  document.querySelectorAll('.grupo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grupo-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _agrupamento = btn.dataset.grupo;
      if (_vendaData) renderVendas(_vendaData);
    });
  });

  async function buscarVendas() {
    const board = $('alertaBoard').value;
    const dtIni = $('alertaDtIni').value;
    const dtFin = $('alertaDtFin').value;
    if (!board || !dtIni || !dtFin) return alert('Preencha loja e período.');

    const btn = $('buscarAlertasBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    $('alertasResult').innerHTML = '';

    try {
      _vendaData = await apiFetch('GET', `/api/conferencia/vendas?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      renderVendas(_vendaData);
    } catch (e) {
      $('alertasResult').innerHTML = `<div style="color:#ef4444;padding:16px">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buscar';
    }
  }

  function alertaBadges(alertas) {
    if (!alertas || !alertas.length) return '';
    return alertas.map(a => {
      const cls = a.tipo === 'parcela_minima' ? 'badge-parcela' : a.tipo === 'desconto_item' ? 'badge-desc-item' : 'badge-desc-venda';
      const lbl = a.tipo === 'parcela_minima' ? 'Parcela' : a.tipo === 'desconto_item' ? 'Desc.Item' : 'Desc.Venda';
      return `<span class="alert-badge ${cls}" title="${esc(a.msg)}">${lbl}</span>`;
    }).join(' ');
  }

  function formasLabel(formas) {
    if (!formas || !formas.length) return '—';
    const uniq = [...new Set(formas.map(f => f.bandeira ? `${f.forma} / ${f.bandeira}` : f.forma))];
    return uniq.join(', ');
  }

  function renderVendas(data) {
    const el = $('alertasResult');
    const { vendas, porForma, porVendedor, totalVendas, totalAlertas, qtdVendas, board } = data;

    const summaryHtml = `
      <div class="summary-bar">
        <div class="summary-chip"><strong>${qtdVendas}</strong>Vendas</div>
        <div class="summary-chip"><strong>${fmt(totalVendas)}</strong>Total</div>
        ${totalAlertas ? `<div class="summary-chip"><strong style="color:#f59e0b">${totalAlertas}</strong>Com alerta</div>` : ''}
      </div>`;

    if (_agrupamento === 'forma') {
      el.innerHTML = summaryHtml + renderGrupo(porForma, 'forma', board);
    } else if (_agrupamento === 'vendedor') {
      el.innerHTML = summaryHtml + renderGrupo(porVendedor, 'vendedor', board);
    } else {
      el.innerHTML = summaryHtml + renderTabela(vendas);
    }

    // Drill-down toggle
    el.querySelectorAll('.grupo-row').forEach(row => {
      row.addEventListener('click', () => {
        const drill = el.querySelector('#' + row.dataset.target);
        if (!drill) return;
        const open = !drill.classList.contains('hidden');
        drill.classList.toggle('hidden', open);
        row.querySelector('.chevron')?.classList.toggle('open', !open);
      });
    });
  }

  function renderTabela(vendas) {
    if (!vendas.length) return '<div style="padding:32px;text-align:center;color:var(--muted)">Nenhuma venda encontrada.</div>';
    return `<table>
      <thead><tr>
        <th>Data</th><th>Hora</th><th>Doc</th><th>Vendedor</th>
        <th>Forma de Pagamento</th><th style="text-align:right">Desconto</th>
        <th style="text-align:right">Total</th><th>Alertas</th>
      </tr></thead>
      <tbody>
        ${vendas.map(v => `<tr class="${v.alertas.length ? 'row-alerta' : ''}">
          <td>${v.data || '—'}</td>
          <td>${v.hora || '—'}</td>
          <td style="font-family:monospace;font-size:11px">${v.doc}</td>
          <td>${esc(v.vendedor)}</td>
          <td style="font-size:11px">${esc(formasLabel(v.formas))}</td>
          <td style="text-align:right;font-size:11px;color:${v.desconto ? '#f59e0b' : 'var(--muted)'}">
            ${v.desconto ? fmt(v.desconto.valor) + ` (${v.desconto.perc}%)` : '—'}
          </td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${fmt(v.valorTotal)}</td>
          <td>${alertaBadges(v.alertas)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  let _drillIdx = 0;
  function renderGrupo(grupos, tipo, board) {
    if (!grupos.length) return '<div style="padding:32px;text-align:center;color:var(--muted)">Sem dados.</div>';
    const totalGeral = grupos.reduce((s, g) => s + g.total, 0);

    return `<table>
      <thead><tr>
        <th>${tipo === 'forma' ? 'Forma de Pagamento' : 'Vendedor'}</th>
        <th style="text-align:right">Qtd</th>
        <th style="text-align:right">%</th>
        <th style="text-align:right">Total</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${grupos.map(g => {
          const id = 'drill-' + (_drillIdx++);
          const pct = totalGeral > 0 ? (g.total / totalGeral * 100).toFixed(1) : '0';
          const alertasGrupo = (g.vendas || []).filter(v => v.alertas.length).length;
          return `
            <tr class="grupo-row" data-target="${id}" style="cursor:pointer">
              <td>
                <strong>${esc(g.label)}</strong>
                ${alertasGrupo ? `<span class="alert-badge badge-desc-item" style="margin-left:6px">${alertasGrupo} alertas</span>` : ''}
              </td>
              <td style="text-align:right">${g.qtd}</td>
              <td style="text-align:right;color:var(--muted)">${pct}%</td>
              <td style="text-align:right;font-weight:600">${fmt(g.total)}</td>
              <td style="width:24px"><svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></td>
            </tr>
            <tr><td colspan="5" style="padding:0">
              <div class="hidden" id="${id}" style="padding:0 8px 8px">
                ${renderTabelaCompacta(g.vendas || [], tipo)}
              </div>
            </td></tr>`;
        }).join('')}
        <tr style="border-top:2px solid var(--border)">
          <td><strong>Total</strong></td>
          <td style="text-align:right"><strong>${grupos.reduce((s,g)=>s+g.qtd,0)}</strong></td>
          <td></td>
          <td style="text-align:right"><strong>${fmt(totalGeral)}</strong></td>
          <td></td>
        </tr>
      </tbody>
    </table>`;
  }

  function renderTabelaCompacta(vendas, tipo) {
    if (!vendas.length) return '<div style="padding:8px;color:var(--muted);font-size:12px">Sem vendas.</div>';
    return `<table style="font-size:11px;margin:0">
      <thead><tr>
        <th>Data</th><th>Hora</th><th>Doc</th>
        <th>${tipo === 'forma' ? 'Vendedor' : 'Forma'}</th>
        <th style="text-align:right">Desconto</th>
        <th style="text-align:right">Total</th>
        <th>Alertas</th>
      </tr></thead>
      <tbody>
        ${vendas.map(v => `<tr class="${v.alertas.length ? 'row-alerta' : ''}">
          <td>${v.data||'—'}</td>
          <td>${v.hora||'—'}</td>
          <td style="font-family:monospace">${v.doc}</td>
          <td>${tipo === 'forma' ? esc(v.vendedor) : esc(formasLabel(v.formas))}</td>
          <td style="text-align:right;color:${v.desconto?'#f59e0b':'var(--muted)'}">
            ${v.desconto ? `${v.desconto.perc}%` : '—'}
          </td>
          <td style="text-align:right">${fmt(v.valorTotal)}</td>
          <td>${alertaBadges(v.alertas)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PAINEL: CONCILIAÇÃO REDE
  // ════════════════════════════════════════════════════════════════════════
  const fileDrop = $('fileDrop');
  const fileInput = $('redeFile');

  fileDrop.addEventListener('click', () => fileInput.click());
  fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.style.borderColor = 'var(--accent,#3b82f6)'; });
  fileDrop.addEventListener('dragleave', () => fileDrop.style.borderColor = '');
  fileDrop.addEventListener('drop', e => { e.preventDefault(); fileDrop.style.borderColor = ''; processRedeFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => fileInput.files[0] && processRedeFile(fileInput.files[0]));

  async function processRedeFile(file) {
    if (!file) return;
    const board = $('concBoard').value;
    const dtIni = $('concDtIni').value;
    const dtFin = $('concDtFin').value;
    if (!board || !dtIni || !dtFin) return alert('Preencha loja e período antes de enviar o arquivo.');

    $('concResult').innerHTML = '<div style="padding:16px;color:var(--muted)"><span class="spinner"></span> Processando arquivo…</div>';
    try {
      const linhas = await parseRedeFile(file);
      if (!linhas.length) {
        $('concResult').innerHTML = '<div style="padding:16px;color:#ef4444">Nenhuma linha encontrada no arquivo.</div>';
        return;
      }
      $('concResult').innerHTML = `<div style="padding:8px 0;color:var(--muted);font-size:12px">${linhas.length} transações lidas. Cruzando com Microvix…</div>`;
      const data = await apiFetch('POST', '/api/conferencia/conciliacao-rede', { board, dtIni, dtFin, linhas });
      renderConciliacao(data);
    } catch (e) {
      $('concResult').innerHTML = `<div style="padding:16px;color:#ef4444">Erro: ${esc(e.message)}</div>`;
    }
  }

  async function parseRedeFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          const get  = (r, ...names) => {
            for (const n of names) {
              const k = Object.keys(r).find(k => k.toString().toLowerCase().includes(n));
              if (k && r[k] !== '') return String(r[k]).trim();
            }
            return '';
          };
          const linhas = rows.map(r => ({
            nsu:      get(r,'nsu','autorizacao','autorização','cod_aut','numero'),
            bandeira: get(r,'bandeira','brand','rede','cartao','cartão'),
            valor:    parseFloat(String(get(r,'valor','value','total','vlr')).replace(/[R$\s.]/g,'').replace(',','.')) || 0,
            data:     get(r,'data','date','dt','vencimento'),
          })).filter(l => l.nsu && l.valor > 0);
          resolve(linhas);
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function renderConciliacao(data) {
    const el = $('concResult');
    const { resultado, totalMx, totalRede, ok, divergencias } = data;
    el.innerHTML = `
      <div class="summary-bar">
        <div class="summary-chip"><strong>${totalRede}</strong>Transações Rede</div>
        <div class="summary-chip"><strong>${totalMx}</strong>Transações Microvix</div>
        <div class="summary-chip"><strong style="color:#22c55e">${ok}</strong>Conciliadas</div>
        <div class="summary-chip"><strong style="color:#ef4444">${divergencias}</strong>Divergências</div>
      </div>
      <table>
        <thead><tr>
          <th>Status</th><th>NSU</th><th>Bandeira</th>
          <th style="text-align:right">Valor Rede</th>
          <th style="text-align:right">Valor Microvix</th>
          <th style="text-align:right">Diferença</th>
          <th>Data</th>
        </tr></thead>
        <tbody>
          ${resultado.map(r => `<tr>
            <td>${statusBadge(r.status)}</td>
            <td style="font-family:monospace;font-size:11px">${r.nsu}</td>
            <td>${esc(r.rede?.bandeira || r.mx?.bandeira || '—')}</td>
            <td style="text-align:right">${r.rede ? fmt(r.rede.valor) : '—'}</td>
            <td style="text-align:right">${r.mx  ? fmt(r.mx.valor)   : '—'}</td>
            <td style="text-align:right">${r.difValor != null
              ? `<span style="color:${Math.abs(r.difValor)>0.01?'#ef4444':'#22c55e'}">${fmt(r.difValor)}</span>`
              : '—'}</td>
            <td style="font-size:11px">${esc(r.rede?.data || r.mx?.data || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function statusBadge(status) {
    return {
      ok:                '<span class="alert-badge badge-ok">✓ OK</span>',
      divergencia_valor: '<span class="alert-badge badge-desc-item">Valor diferente</span>',
      somente_microvix:  '<span class="alert-badge badge-parcela">Só Microvix</span>',
      somente_rede:      '<span class="alert-badge" style="background:#8b5cf622;color:#8b5cf6">Só Rede</span>',
    }[status] || status;
  }

})();
