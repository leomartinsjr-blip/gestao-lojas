'use strict';

// ── Auth check ──────────────────────────────────────────────────────────────
(async () => {
  try {
    const r = await fetch('/api/me');
    if (!r.ok || (await r.json()).board) { window.location.href = '/'; }
  } catch { window.location.href = '/'; }
})();

// ── State ───────────────────────────────────────────────────────────────────
const S = { clientesPage: 1, clientesTotal: 0, clientesPages: 1, msgPage: 1, msgPages: 1 };

// ── Helpers ─────────────────────────────────────────────────────────────────
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) { let msg = text; try { msg = JSON.parse(text).error || msg; } catch {} throw new Error(msg); }
  try { return JSON.parse(text); } catch { return text; }
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtPhone(p) {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return p;
}

const TIPO_LABELS = { birthday: '🎂 Aniversário', reengagement: '💤 Reengajamento', manual: '📣 Manual' };
const TIPO_BADGES = { birthday: 'badge-blue', reengagement: 'badge-yellow', manual: 'badge-green' };

// ── Navigation ───────────────────────────────────────────────────────────────
const TITLES = { dashboard: 'Dashboard', clientes: 'Clientes', campanhas: 'Campanhas', historico: 'Histórico', config: 'Configurações' };

document.querySelectorAll('.crm-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab;
    document.querySelectorAll('.crm-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById('crmTitle').textContent = TITLES[tab] || '';
    document.getElementById('crmHeaderActions').innerHTML = '';
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'clientes')  loadClientes();
    if (tab === 'campanhas') loadCampaigns();
    if (tab === 'historico') loadMessages();
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const s = await api('GET', '/api/crm/stats');
    document.getElementById('statTotal').textContent  = s.total.toLocaleString('pt-BR');
    document.getElementById('statToday').textContent  = s.sentToday;
    document.getElementById('statMonth').textContent  = s.sentMonth;
    document.getElementById('statRisk').textContent   = s.atRisk.toLocaleString('pt-BR');

    // Birthdays
    const bl = document.getElementById('birthdayList');
    if (!s.upcoming?.length) {
      bl.innerHTML = '<p style="color:var(--muted);font-size:.82rem;padding:12px 0">Nenhum aniversariante nos próximos 7 dias.</p>';
    } else {
      bl.innerHTML = s.upcoming.map(c => {
        const isToday = c.dtNasc === s.todayDDMM;
        return `<div class="birthday-item">
          <span class="birthday-date ${isToday ? 'birthday-today' : ''}">${c.dtNasc || '??'}</span>
          <span style="flex:1;font-weight:${isToday ? '600' : '400'}">${c.nome}${isToday ? ' 🎂' : ''}</span>
          <span style="font-size:.75rem;color:var(--muted)">${fmtPhone(c.celular)}</span>
        </div>`;
      }).join('');
    }

    // Recent messages
    const msgs = await api('GET', '/api/crm/messages?page=1');
    const tbody = document.getElementById('recentMsgBody');
    if (!msgs.messages?.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="crm-empty">Nenhuma mensagem enviada ainda.</td></tr>';
    } else {
      tbody.innerHTML = msgs.messages.slice(0, 8).map(m => `
        <tr>
          <td>${m.customerNome || '—'}</td>
          <td style="color:var(--muted);font-size:.8rem">${m.campaignNome || '—'}</td>
          <td><span class="badge ${m.status === 'sent' ? 'badge-green' : 'badge-red'}">${m.status === 'sent' ? 'Enviado' : 'Erro'}</span></td>
        </tr>`).join('');
    }
  } catch (e) { toast(e.message, true); }
}

// ── Clientes ─────────────────────────────────────────────────────────────────
let searchDebounce = null;
function debounceSearchClientes() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { S.clientesPage = 1; loadClientes(); }, 350);
}

async function loadClientes() {
  const q    = document.getElementById('clienteSearch').value.trim();
  const loja = document.getElementById('clienteLoja').value;
  const params = new URLSearchParams({ page: S.clientesPage });
  if (q) params.set('q', q);
  if (loja) params.set('loja', loja);
  const tbody = document.getElementById('clientesBody');
  tbody.innerHTML = '<tr><td colspan="5" class="crm-empty">Carregando…</td></tr>';
  try {
    const d = await api('GET', `/api/crm/customers?${params}`);
    S.clientesTotal = d.total; S.clientesPages = d.pages;
    document.getElementById('clientesPagInfo').textContent = `${d.total.toLocaleString('pt-BR')} clientes`;
    document.getElementById('btnClientesPrev').disabled = S.clientesPage <= 1;
    document.getElementById('btnClientesNext').disabled = S.clientesPage >= d.pages;
    if (!d.customers?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="crm-empty">Nenhum cliente encontrado.</td></tr>'; return;
    }
    tbody.innerHTML = d.customers.map(c => `
      <tr>
        <td><strong>${c.nome}</strong>${c.email ? `<br><span style="font-size:.75rem;color:var(--muted)">${c.email}</span>` : ''}</td>
        <td>${fmtPhone(c.celular)}</td>
        <td>${c.dtNasc || '—'}</td>
        <td style="font-size:.78rem">${(c.lojas||[]).join(', ') || '—'}</td>
        <td style="font-size:.8rem;color:var(--muted)">${fmtDate(c.ultimaCompra)}</td>
      </tr>`).join('');
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5" class="crm-empty" style="color:#F85149">${e.message}</td></tr>`; }
}

function navigateClientes(delta) {
  S.clientesPage = Math.max(1, Math.min(S.clientesPages, S.clientesPage + delta));
  loadClientes();
}

async function crmSyncCustomers() {
  const btn = document.querySelector('[onclick="crmSyncCustomers()"]');
  btn.disabled = true; btn.textContent = 'Sincronizando…';
  try {
    const r = await api('POST', '/api/crm/sync');
    toast(`Sincronizado! ${r.total.toLocaleString('pt-BR')} clientes importados.`);
    loadClientes();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Sincronizar';
  }
}

// ── Campanhas ─────────────────────────────────────────────────────────────────
async function loadCampaigns() {
  const list = document.getElementById('campaignsList');
  const empty = document.getElementById('campaignsEmpty');
  list.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:8px 0">Carregando…</div>';
  try {
    const campaigns = await api('GET', '/api/crm/campaigns');
    if (!campaigns.length) { list.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    list.innerHTML = campaigns.map(c => `
      <div class="campaign-card" id="camp-${c._id}">
        <div class="campaign-card-header">
          <div>
            <span class="campaign-card-name">${c.nome}</span>
            <span class="badge ${TIPO_BADGES[c.tipo] || 'badge-gray'}" style="margin-left:8px">${TIPO_LABELS[c.tipo] || c.tipo}</span>
            <span class="badge ${c.ativo ? 'badge-green' : 'badge-gray'}" style="margin-left:6px">${c.ativo ? 'Ativa' : 'Inativa'}</span>
          </div>
          <div class="campaign-card-actions">
            ${c.tipo === 'manual' ? `<button class="btn btn-green btn-sm" onclick="runCampaign('${c._id}','${c.nome}')">▶ Disparar</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="editCampaign(${JSON.stringify(c).replace(/"/g,'&quot;')})">Editar</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleCampaign('${c._id}',${!c.ativo})">${c.ativo ? 'Pausar' : 'Ativar'}</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCampaign('${c._id}')">Excluir</button>
          </div>
        </div>
        ${c.config?.diasSemCompra ? `<div style="font-size:.78rem;color:var(--muted);margin-bottom:6px">Clientes sem compra há ${c.config.diasSemCompra} dias</div>` : ''}
        <div class="campaign-template">${c.template}</div>
      </div>`).join('');
  } catch (e) { list.innerHTML = `<div style="color:#F85149;font-size:.85rem">${e.message}</div>`; }
}

function updateConfigFields() {
  const tipo = document.getElementById('cfTipo').value;
  document.getElementById('cfReengagementConfig').style.display = tipo === 'reengagement' ? '' : 'none';
}

function resetCampaignForm() {
  document.getElementById('editCampaignId').value = '';
  document.getElementById('cfNome').value = '';
  document.getElementById('cfTipo').value = 'birthday';
  document.getElementById('cfTemplate').value = '';
  document.getElementById('cfDias').value = '60';
  document.getElementById('formTitle').textContent = 'Nova campanha';
  document.getElementById('cfErr').style.display = 'none';
  updateConfigFields();
}

function editCampaign(c) {
  document.getElementById('editCampaignId').value = c._id;
  document.getElementById('cfNome').value = c.nome;
  document.getElementById('cfTipo').value = c.tipo;
  document.getElementById('cfTemplate').value = c.template;
  document.getElementById('cfDias').value = c.config?.diasSemCompra || 60;
  document.getElementById('formTitle').textContent = 'Editar campanha';
  updateConfigFields();
  document.getElementById('cfNome').focus();
}

async function saveCampaign() {
  const id       = document.getElementById('editCampaignId').value;
  const nome     = document.getElementById('cfNome').value.trim();
  const tipo     = document.getElementById('cfTipo').value;
  const template = document.getElementById('cfTemplate').value.trim();
  const dias     = parseInt(document.getElementById('cfDias').value) || 60;
  const errEl    = document.getElementById('cfErr');

  errEl.style.display = 'none';
  if (!nome || !template) { errEl.textContent = 'Preencha nome e mensagem.'; errEl.style.display = ''; return; }

  const body = { nome, tipo, template, config: tipo === 'reengagement' ? { diasSemCompra: dias } : {} };
  try {
    if (id) await api('PUT', `/api/crm/campaigns/${id}`, body);
    else    await api('POST', '/api/crm/campaigns', body);
    toast(id ? 'Campanha atualizada!' : 'Campanha criada!');
    resetCampaignForm();
    loadCampaigns();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = ''; }
}

async function toggleCampaign(id, ativo) {
  try { await api('PUT', `/api/crm/campaigns/${id}`, { ativo }); loadCampaigns(); }
  catch (e) { toast(e.message, true); }
}

async function deleteCampaign(id) {
  if (!confirm('Excluir esta campanha?')) return;
  try { await api('DELETE', `/api/crm/campaigns/${id}`); toast('Campanha excluída.'); loadCampaigns(); }
  catch (e) { toast(e.message, true); }
}

async function runCampaign(id, nome) {
  if (!confirm(`Disparar a campanha "${nome}" agora? Isso enviará mensagens para os clientes filtrados.`)) return;
  try {
    const r = await api('POST', `/api/crm/campaigns/${id}/run`, {});
    toast(`Disparo concluído: ${r.sent} enviados, ${r.failed} com erro.`);
    loadCampaigns();
  } catch (e) { toast(e.message, true); }
}

// ── Histórico ─────────────────────────────────────────────────────────────────
async function loadMessages() {
  const status = document.getElementById('msgStatusFilter').value;
  const params = new URLSearchParams({ page: S.msgPage });
  if (status) params.set('status', status);
  const tbody = document.getElementById('messagesBody');
  tbody.innerHTML = '<tr><td colspan="5" class="crm-empty">Carregando…</td></tr>';
  try {
    const d = await api('GET', `/api/crm/messages?${params}`);
    S.msgPages = d.pages;
    document.getElementById('msgPagInfo').textContent = `${d.total.toLocaleString('pt-BR')} mensagens`;
    document.getElementById('btnMsgPrev').disabled = S.msgPage <= 1;
    document.getElementById('btnMsgNext').disabled = S.msgPage >= d.pages;
    if (!d.messages?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="crm-empty">Nenhuma mensagem no histórico.</td></tr>'; return;
    }
    tbody.innerHTML = d.messages.map(m => `
      <tr>
        <td>${m.customerNome || '—'}</td>
        <td style="color:var(--muted)">${fmtPhone(m.celular)}</td>
        <td style="font-size:.8rem">${m.campaignNome || '—'}</td>
        <td><span class="badge ${m.status === 'sent' ? 'badge-green' : 'badge-red'}" title="${m.erro || ''}">${m.status === 'sent' ? 'Enviado' : 'Erro'}</span></td>
        <td style="color:var(--muted);font-size:.8rem">${fmtDateTime(m.enviadoEm)}</td>
      </tr>`).join('');
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5" class="crm-empty" style="color:#F85149">${e.message}</td></tr>`; }
}

function navigateMessages(delta) {
  S.msgPage = Math.max(1, Math.min(S.msgPages, S.msgPage + delta));
  loadMessages();
}

// ── Config / Teste ─────────────────────────────────────────────────────────────
async function sendTest() {
  const phone   = document.getElementById('testPhone').value.trim();
  const message = document.getElementById('testMsg').value.trim();
  const resEl   = document.getElementById('testResult');
  if (!phone || !message) { resEl.style.color = '#F85149'; resEl.textContent = 'Preencha telefone e mensagem.'; resEl.style.display = ''; return; }
  resEl.style.display = 'none';
  try {
    await api('POST', '/api/crm/send-test', { phone, message });
    resEl.style.color = '#3FB950'; resEl.textContent = 'Mensagem enviada com sucesso!';
  } catch (e) {
    resEl.style.color = '#F85149'; resEl.textContent = e.message;
  }
  resEl.style.display = '';
}

async function probeClientes() {
  const el = document.getElementById('probeResult');
  el.style.display = ''; el.textContent = 'Consultando Microvix…';
  try {
    const results = await api('GET', '/api/crm/clientes-raw');
    el.textContent = results.map(r =>
      `[${r.tentativa}] → ${r.status}\n` +
      (r.campos?.length ? `Campos: ${r.campos.join(', ')}\n` : '') +
      (r.exemplo ? `Exemplo: ${JSON.stringify(r.exemplo, null, 2)}\n` : '') +
      (r.raw_inicio ? `Raw: ${r.raw_inicio}\n` : '')
    ).join('\n---\n');
  } catch (e) { el.textContent = 'Erro: ' + e.message; }
}

// ── Init ───────────────────────────────────────────────────────────────────
loadDashboard();
updateConfigFields();
