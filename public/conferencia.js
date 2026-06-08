(() => {
  const LOJAS = ['delrey','minas','contagem','estacao','tommy','surfers'];
  const LOJA_LABEL = {
    delrey:'Del Rey', minas:'Minas', contagem:'Contagem',
    estacao:'Estação', tommy:'Tommy', surfers:'Surfers',
  };

  // ── Utilitários ──────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmt = v => 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });

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

  // ── Auth ─────────────────────────────────────────────────────────────────
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
    // Coleta valores dos inputs
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
  // PAINEL: ALERTAS
  // ════════════════════════════════════════════════════════════════════════
  $('buscarAlertasBtn').addEventListener('click', buscarAlertas);

  async function buscarAlertas() {
    const board = $('alertaBoard').value;
    const dtIni = $('alertaDtIni').value;
    const dtFin = $('alertaDtFin').value;
    if (!board || !dtIni || !dtFin) return alert('Preencha loja e período.');

    const btn = $('buscarAlertasBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    $('alertasResult').innerHTML = '';

    try {
      const data = await apiFetch('GET', `/api/conferencia/alertas?board=${board}&dtIni=${dtIni}&dtFin=${dtFin}`);
      renderAlertas(data);
    } catch (e) {
      $('alertasResult').innerHTML = `<div style="color:#ef4444;padding:16px">${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buscar';
    }
  }

  function renderAlertas(data) {
    const el = $('alertasResult');
    const { vendas, total, regra, dtIni, dtFin, board } = data;

    const parcAlertas  = vendas.filter(v => v.alertas.some(a => a.tipo === 'parcela_minima')).length;
    const descIAlertas = vendas.filter(v => v.alertas.some(a => a.tipo === 'desconto_item')).length;
    const descVAlertas = vendas.filter(v => v.alertas.some(a => a.tipo === 'desconto_venda')).length;

    if (total === 0) {
      el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.5" style="display:block;margin:0 auto 8px">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        Nenhum alerta encontrado para ${LOJA_LABEL[board]} entre ${dtIni} e ${dtFin}.
      </div>`;
      return;
    }

    el.innerHTML = `
      <div class="summary-bar">
        <div class="summary-chip"><strong>${total}</strong>Vendas com alerta</div>
        ${parcAlertas  ? `<div class="summary-chip"><strong style="color:#f59e0b">${parcAlertas}</strong>Parcela abaixo do mínimo</div>` : ''}
        ${descIAlertas ? `<div class="summary-chip"><strong style="color:#ef4444">${descIAlertas}</strong>Desconto abusivo (item)</div>` : ''}
        ${descVAlertas ? `<div class="summary-chip"><strong style="color:#dc2626">${descVAlertas}</strong>Desconto abusivo (venda)</div>` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th>Data</th><th>Hora</th><th>Doc</th><th>Vendedor</th>
            <th style="text-align:right">Valor</th><th>Alertas</th>
          </tr>
        </thead>
        <tbody>
          ${vendas.map(v => `
            <tr>
              <td>${v.data || '—'}</td>
              <td>${v.hora || '—'}</td>
              <td style="font-family:monospace;font-size:11px">${v.doc}</td>
              <td>${v.vendedor || '—'}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${fmt(v.valorTotal)}</td>
              <td>
                <div class="alerta-list">
                  ${v.alertas.map(a => `
                    <span class="alert-badge ${badgeClass(a.tipo)}">${badgeLabel(a.tipo)}</span>
                    <span class="alerta-msg">${a.msg}</span>
                  `).join('')}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function badgeClass(tipo) {
    if (tipo === 'parcela_minima')  return 'badge-parcela';
    if (tipo === 'desconto_item')   return 'badge-desc-item';
    if (tipo === 'desconto_venda')  return 'badge-desc-venda';
    return '';
  }
  function badgeLabel(tipo) {
    if (tipo === 'parcela_minima')  return 'Parcela';
    if (tipo === 'desconto_item')   return 'Desc. Item';
    if (tipo === 'desconto_venda')  return 'Desc. Venda';
    return tipo;
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
        $('concResult').innerHTML = '<div style="padding:16px;color:#ef4444">Nenhuma linha encontrada no arquivo. Verifique o formato.</div>';
        return;
      }

      $('concResult').innerHTML = `<div style="padding:8px 0;color:var(--muted);font-size:12px">${linhas.length} transações lidas do arquivo. Cruzando com Microvix…</div>`;

      const data = await apiFetch('POST', '/api/conferencia/conciliacao-rede', { board, dtIni, dtFin, linhas });
      renderConciliacao(data);
    } catch (e) {
      $('concResult').innerHTML = `<div style="padding:16px;color:#ef4444">Erro: ${e.message}</div>`;
    }
  }

  async function parseRedeFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb   = XLSX.read(data, { type: 'array' });
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

          // Tenta mapear colunas comuns do extrato da Rede
          const linhas = rows.map(r => {
            const keys = Object.keys(r).map(k => k.toString().toLowerCase().trim());
            const get  = (...names) => {
              for (const n of names) {
                const k = Object.keys(r).find(k => k.toString().toLowerCase().includes(n));
                if (k && r[k] !== '') return String(r[k]).trim();
              }
              return '';
            };
            const nsu      = get('nsu','autorizacao','autorização','cod_aut','cod aut','numero');
            const bandeira = get('bandeira','brand','rede','cartao','cartão');
            const valorRaw = get('valor','value','total','vlr');
            const data_    = get('data','date','dt','vencimento');
            const valor    = parseFloat(String(valorRaw).replace(/[R$\s.]/g,'').replace(',','.')) || 0;
            return { nsu, bandeira, valor, data: data_ };
          }).filter(l => l.nsu && l.valor > 0);

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
        <thead>
          <tr>
            <th>Status</th><th>NSU</th><th>Bandeira</th>
            <th style="text-align:right">Valor Rede</th>
            <th style="text-align:right">Valor Microvix</th>
            <th style="text-align:right">Diferença</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          ${resultado.map(r => `
            <tr>
              <td>${statusBadge(r.status)}</td>
              <td style="font-family:monospace;font-size:11px">${r.nsu}</td>
              <td>${r.rede?.bandeira || r.mx?.bandeira || '—'}</td>
              <td style="text-align:right">${r.rede ? fmt(r.rede.valor) : '—'}</td>
              <td style="text-align:right">${r.mx  ? fmt(r.mx.valor)   : '—'}</td>
              <td style="text-align:right">${r.difValor != null
                ? `<span class="${Math.abs(r.difValor) > 0.01 ? 'status-div' : 'status-ok'}">${fmt(r.difValor)}</span>`
                : '—'}</td>
              <td style="font-size:11px">${r.rede?.data || r.mx?.data || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function statusBadge(status) {
    const map = {
      ok:                '<span class="alert-badge badge-ok">✓ OK</span>',
      divergencia_valor: '<span class="alert-badge badge-desc-item">Valor diferente</span>',
      somente_microvix:  '<span class="alert-badge badge-parcela">Só Microvix</span>',
      somente_rede:      '<span class="alert-badge" style="background:#8b5cf622;color:#8b5cf6">Só Rede</span>',
    };
    return map[status] || status;
  }

})();
