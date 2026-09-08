/* ══════════════════════════════════════════════════════════════════════════
   VALE-TRANSPORTE — a tela
   O trabalho do mês é um só: ler o saldo de cada cartão no portal da operadora
   e digitar aqui. O resto — dias, valor da recarga, total por CNPJ — o servidor
   devolve calculado, e é ele a fonte única da conta; a tela nunca recalcula por
   conta própria, que foi como a planilha acabou com linha de fórmula e linha de
   número fixo lado a lado.
   ══════════════════════════════════════════════════════════════════════════ */

const S = {
  ano: new Date().getFullYear(),
  mes: new Date().getMonth() + 1,
  dados: null,
  base: null,
};

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const BOARD_COR = {
  escritorio: 'var(--col-escritorio)', delrey: 'var(--col-delrey)', minas: 'var(--col-minas)',
  contagem: 'var(--col-contagem)', estacao: 'var(--col-estacao)', tommy: 'var(--col-tommy)',
  lez: 'var(--col-lez)', site: 'var(--col-site)',
};
const BOARD_NOME = {
  escritorio: 'Escritório', delrey: 'Del Rey', minas: 'Minas', contagem: 'Contagem',
  estacao: 'Estação', tommy: 'Tommy', lez: 'Lez a Lez', site: 'Site',
};
const ESTADO_NOME = {
  gaveta: 'Na gaveta', perdido: 'Perdido', bloqueado: 'Bloqueado',
  substituido: 'Substituído', uso: 'Em uso',
};

const $  = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fData = iso => iso ? new Date(iso).toLocaleDateString('pt-BR') : '';

// ── Conversa com o servidor ────────────────────────────────────────────────
async function api(url, opts) {
  const r = await fetch(url, {
    ...opts,
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }
  if (!r.ok) throw new Error(json?.error || `Erro ${r.status}`);
  return json;
}

function mostraErro(msg) {
  const box = $('erroBox');
  if (!msg) { box.classList.add('hidden'); return; }
  box.textContent = msg;
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Carga ──────────────────────────────────────────────────────────────────
async function carregar() {
  try {
    mostraErro('');
    const [dados, base] = await Promise.all([
      api(`/api/vt/${S.ano}/${S.mes}`),
      S.base ? Promise.resolve(S.base) : api('/api/vt/base'),
    ]);
    S.dados = dados;
    S.base  = base;
    $('carregando').classList.add('hidden');
    render();
  } catch (e) {
    $('carregando').classList.add('hidden');
    mostraErro(e.message === 'Erro 401'
      ? 'Sessão expirada — entre de novo no painel.'
      : e.message);
  }
}

async function recarregaBase() { S.base = await api('/api/vt/base'); }

// ── Desenho ────────────────────────────────────────────────────────────────
function render() {
  const d = S.dados;
  if (!d) return;
  $('mesLabel').textContent = `${MESES[S.mes - 1]} ${S.ano}`;
  renderResumo(d);
  renderAvisos(d);
  renderEmpresas(d);
  renderGaveta(d);
}

function renderResumo(d) {
  const t = d.totais;
  const falta = Math.round(((t.recarga - t.pago) + (t.ajuda - t.ajudaPaga)) * 100) / 100;
  $('resumo').innerHTML = `
    <div class="vt-kpi">
      <span class="vt-kpi-rot">Total do mês</span>
      <span class="vt-kpi-val"><small>R$</small>${fBRL(t.recarga + t.ajuda)}</span>
      <span class="vt-kpi-sub">R$ ${fBRL(t.recarga)} em recarga${t.ajuda ? ` · R$ ${fBRL(t.ajuda)} em ajuda` : ''}</span>
    </div>
    <div class="vt-kpi">
      <span class="vt-kpi-rot">Já pago</span>
      <span class="vt-kpi-val"><small>R$</small>${fBRL(t.pago + t.ajudaPaga)}</span>
      <span class="vt-kpi-sub">${falta > 0 ? 'faltam R$ ' + fBRL(falta) : 'tudo feito'}</span>
    </div>
    <div class="vt-kpi">
      <span class="vt-kpi-rot">Saldo não lido</span>
      <span class="vt-kpi-val ${t.semSaldo ? 'alerta' : ''}">${t.semSaldo}</span>
      <span class="vt-kpi-sub">${t.pessoas} no cartão${t.naAjuda ? ` · ${t.naAjuda} na ajuda` : ''}</span>
    </div>
    <div class="vt-kpi">
      <span class="vt-kpi-rot">Escala do mês</span>
      <span class="vt-kpi-val ${d.escala.completa ? '' : 'alerta'}">${
        d.escala.usando ? (d.escala.completa ? 'ok' : d.escala.pendentes.length) : '—'}</span>
      <span class="vt-kpi-sub">${
        !d.escala.usando ? 'usando dias fixos'
        : d.escala.completa ? 'todo mundo com escala feita'
        : 'sem escala — recarga estimada'}</span>
    </div>
    <div class="vt-kpi">
      <span class="vt-kpi-rot">Saldo preso</span>
      <span class="vt-kpi-val ${d.saldoPreso.valor > 0 ? 'alerta' : ''}"><small>R$</small>${fBRL(d.saldoPreso.valor)}</span>
      <span class="vt-kpi-sub">${t.perdidos} cartão${t.perdidos === 1 ? '' : 'ões'} perdido${t.perdidos === 1 ? '' : 's'} · ${t.naGaveta} na gaveta</span>
    </div>`;
}

const DIA_BR = iso => iso ? iso.split('-').reverse().join('/') : '';

function renderAvisos(d) {
  const av = [];

  // O prazo: a recarga é na primeira terça, e a escala tem que estar pronta
  // antes — é dela que sai o número de dias de cada um.
  const r = d.recarga;
  if (d.totais.pessoas > 0 && (r.hoje || (r.diasAte <= 6 && r.diasAte >= 0) || (r.passou && d.totais.recarga > d.totais.pago))) {
    const falta = Math.round((d.totais.recarga - d.totais.pago) * 100) / 100;
    av.push(`<div class="vt-aviso ${r.passou && falta > 0 ? 'erro' : ''}">
      <div>
        <b>${r.hoje ? 'Hoje é dia de recarregar.'
            : r.passou ? `A recarga era ${DIA_BR(r.dia)} e ainda faltam R$ ${fBRL(falta)}.`
            : `Recarga em ${DIA_BR(r.dia)}${r.diasAte === 1 ? ' — amanhã' : `, daqui a ${r.diasAte} dias`}.`}</b>
        Primeira terça do mês. ${d.escala.completa
          ? 'A escala do mês está fechada, então os dias de cada um saem dela.'
          : 'Feche a escala antes: é dela que saem os dias de trabalho de cada um.'}
      </div>
    </div>`);
  }

  // Escala por fazer: a conta cai no número fixo e vira estimativa.
  if (d.escala.usando && d.escala.pendentes.length) {
    const nomes = d.escala.pendentes.slice(0, 8).map(x => esc(x.nome)).join(', ');
    const resto = d.escala.pendentes.length - 8;
    av.push(`<div class="vt-aviso">
      <div>
        <b>Escala do mês não preenchida para ${d.escala.pendentes.length}
        ${d.escala.pendentes.length === 1 ? 'pessoa' : 'pessoas'}.</b>
        Enquanto não estiver, a recarga dessas linhas usa os
        ${d.config.diasMes} dias do padrão em vez dos dias da escala — dá para
        pagar, mas é estimativa. Faltam: ${nomes}${resto > 0 ? ` e mais ${resto}` : ''}.
      </div>
      <div class="vt-aviso-acoes">
        <a class="vt-btn mini" href="/#folgas" target="_blank">Abrir Folgas</a>
      </div>
    </div>`);
  }

  if (d.saldoPreso.valor > 0) {
    av.push(`<div class="vt-aviso erro">
      <div>
        <b>R$ ${fBRL(d.saldoPreso.valor)} parados em cartão perdido.</b>
        Esse dinheiro só volta se alguém pedir a transferência na operadora —
        ${d.saldoPreso.cartoes.map(c => esc(c.numero)).join(', ')}.
        Feito o procedimento, marque aqui e o valor entra como saldo do cartão novo.
      </div>
      <div class="vt-aviso-acoes">
        <button class="vt-btn mini" onclick="document.getElementById('gaveta').scrollIntoView({behavior:'smooth'})">Ver cartões</button>
      </div>
    </div>`);
  }

  if (d.totais.semSaldo > 0) {
    av.push(`<div class="vt-aviso">
      <div>
        <b>${d.totais.semSaldo} cartão${d.totais.semSaldo === 1 ? '' : 'ões'} sem saldo lido.</b>
        Enquanto o saldo não for digitado a recarga sai cheia, como se o cartão
        estivesse zerado. Entre no portal da operadora, consulte e preencha.
      </div>
    </div>`);
  }

  if (!d.grupos.length) {
    av.push(`<div class="vt-aviso">
      <div>
        <b>Nenhuma empresa pagadora cadastrada ainda.</b>
        Comece por <b>Cartões → Empresas</b>: cada CNPJ que paga vale-transporte
        vira um bloco aqui, com a operadora e o acesso ao portal.
      </div>
    </div>`);
  }

  $('avisos').innerHTML = av.join('');
}

function renderEmpresas(d) {
  $('empresas').innerHTML = d.grupos.map(g => {
    const e = g.empresa;
    const linhas = g.linhas.length
      ? `<div class="vt-scroll"><table class="vt-t">
          <thead><tr>
            <th>Colaborador</th><th>Cartão</th><th>Valor dia</th>
            <th>Saldo no portal</th><th>Dias trab.</th><th>Dias</th><th>Recarga</th><th></th>
          </tr></thead>
          <tbody>${g.linhas.map(l => linhaHtml(l)).join('')}</tbody>
        </table></div>`
      : `<div class="vt-vazio">Nenhum cartão vinculado a esta empresa. Vincule em <b>Cartões</b>.</div>`;

    const ajuda = g.ajudas.length ? `
      <div class="vt-sub-hdr">
        <span>Ajuda de custo — em dinheiro, no lugar do cartão</span>
        <span class="vt-sub-tot">R$ ${fBRL(g.totalAjuda)}</span>
      </div>
      <div class="vt-scroll"><table class="vt-t">
        <thead><tr>
          <th>Colaborador</th><th>Km</th><th>Faixa</th><th>Valor</th><th></th>
        </tr></thead>
        <tbody>${g.ajudas.map(a => ajudaHtml(a)).join('')}</tbody>
      </table></div>` : '';

    return `<div class="vt-emp">
      <div class="vt-emp-hdr">
        <span class="vt-emp-nome">${esc(e.nome)}</span>
        ${e.cnpj ? `<span class="vt-emp-cnpj">${esc(e.cnpj)}</span>` : ''}
        <span class="vt-oper">${esc(e.operadora)}</span>
        ${e.temSenha ? `<button class="vt-ico" onclick="verAcesso(${e.id})">🔑 acesso</button>` : ''}
        <span class="vt-emp-tot">
          <span class="vt-emp-tot-rot">${g.totalAjuda ? 'Recarga' : 'Total do mês'}</span>
          <span class="vt-emp-tot-val">R$ ${fBRL(g.total)}</span>
        </span>
        <div class="vt-acesso hidden" id="acesso-${e.id}"></div>
      </div>
      ${linhas}
      ${ajuda}
    </div>`;
  }).join('');
}

function linhaHtml(l) {
  const cor = BOARD_COR[l.board] || 'var(--border2)';
  const marcas = [
    l.pago   ? '<span class="vt-chip pago">recarregado</span>' : '',
    l.pular  ? `<span class="vt-chip pular" title="${esc(l.motivo)}">sem recarga</span>` : '',
    l.manual ? '<span class="vt-chip manual">valor à mão</span>' : '',
    l.semCadastro ? '<span class="vt-chip sem-cadastro">sem vínculo</span>' : '',
    l.substituiDe ? '<span class="vt-chip substituido">2ª via</span>' : '',
  ].filter(Boolean).join(' ');

  return `<tr class="${l.pular ? 'vt-linha-pular' : ''}">
    <td>
      <span class="vt-nome">
        <i class="vt-tarja" style="background:${cor}" title="${esc(BOARD_NOME[l.board] || '')}"></i>
        ${esc(l.nome)} ${marcas}
      </span>
    </td>
    <td><span class="vt-cartao">${esc(l.numero)}</span></td>
    <td class="vt-num" title="${l.linha
        ? `${esc(l.linha)}: ${l.passagensDia} × R$ ${fBRL(l.tarifa)}`
        : 'Valor digitado no cartão, sem linha cadastrada'}">
      ${fBRL(l.valorDia)}${l.linha ? `<span class="vt-linha-tag">${esc(l.linha)}</span>` : ''}
    </td>
    <td>
      <input class="vt-inp-saldo ${l.temSaldo ? '' : 'vazio'}" type="text" inputmode="decimal"
             value="${l.temSaldo ? fBRL(l.saldo) : ''}" placeholder="—"
             data-cartao="${l.cartaoId}" onchange="salvaSaldo(this)"
             ${l.pular ? 'disabled' : ''}>
    </td>
    <td class="vt-num" title="${l.escalaOk
        ? `${l.folgasNoMes} folgas na escala do mês`
        : 'Escala do mês não preenchida — usando o padrão'}">
      ${l.diasTrabalho}${l.escalaOk ? '' : '<span class="vt-chip sem-cadastro" style="margin-left:.25rem">estimado</span>'}
    </td>
    <td class="vt-num">${l.dias || '—'}</td>
    <td class="vt-num vt-recarga ${l.recarga ? '' : 'zero'}">${l.recarga ? 'R$ ' + fBRL(l.recarga) : '—'}</td>
    <td>
      <div class="vt-acoes">
        <button class="vt-ico" onclick="menuLinha(${l.cartaoId})" title="Ações">⋯</button>
      </div>
    </td>
  </tr>`;
}

function ajudaHtml(a) {
  const cor = BOARD_COR[a.board] || 'var(--border2)';
  const marcas = [
    a.pago   ? '<span class="vt-chip pago">pago</span>' : '',
    a.pular  ? `<span class="vt-chip pular" title="${esc(a.motivo)}">sem pagamento</span>` : '',
    a.manual ? '<span class="vt-chip manual">valor à mão</span>' : '',
    a.faixaFixada ? '<span class="vt-chip substituido">faixa fixada</span>' : '',
  ].filter(Boolean).join(' ');

  return `<tr class="${a.pular ? 'vt-linha-pular' : ''}">
    <td>
      <span class="vt-nome">
        <i class="vt-tarja" style="background:${cor}" title="${esc(BOARD_NOME[a.board] || '')}"></i>
        ${esc(a.nome)} ${marcas}
      </span>
    </td>
    <td class="vt-num">${a.km ? a.km + ' km' : '—'}</td>
    <td class="vt-num">${esc(a.faixa)}</td>
    <td class="vt-num vt-recarga ${a.valor ? '' : 'zero'}">${a.valor ? 'R$ ' + fBRL(a.valor) : '—'}</td>
    <td>
      <div class="vt-acoes">
        <button class="vt-ico" onclick="menuAjuda(${a.ajudaId})" title="Ações">⋯</button>
      </div>
    </td>
  </tr>`;
}

function achaAjuda(ajudaId) {
  for (const g of S.dados.grupos) {
    const a = g.ajudas.find(x => x.ajudaId === ajudaId);
    if (a) return { ajuda: a, empresa: g.empresa };
  }
  return null;
}

function menuAjuda(ajudaId) {
  const r = achaAjuda(ajudaId);
  if (!r) return;
  const a = r.ajuda;
  abreModal(a.nome, `
    <div class="vt-campo">
      <span class="dica">
        Ajuda de custo em dinheiro, ${esc(r.empresa.nome)} · ${a.km} km ·
        ${esc(a.faixa)} (R$ ${fBRL(a.valorFaixa)}).
        ${a.pular ? `<br><b>Sem pagamento este mês</b>${a.motivo ? ' — ' + esc(a.motivo) : ''}.` : ''}
        ${a.manual ? `<br>Valor ajustado à mão: R$ ${fBRL(a.valor)} (a faixa daria R$ ${fBRL(a.valorFaixa)}).` : ''}
      </span>
    </div>
    <div class="vt-campo">
      <label>Valor deste mês</label>
      <div class="vt-dupla">
        <input id="aValor" type="text" inputmode="decimal"
               value="${a.manual ? fBRL(a.valorManual) : ''}" placeholder="da faixa: ${fBRL(a.valorFaixa)}">
        <button class="vt-btn" onclick="salvaAjudaMes(${ajudaId}, { valorManual: paraNumero(val('aValor')) })">Ajustar valor</button>
      </div>
      <span class="dica">Em branco volta para o valor da faixa.</span>
    </div>
    <div class="vt-campo">
      <label>Não pagar este mês</label>
      <input id="aMotivo" type="text" maxlength="120" value="${esc(a.motivo)}"
             placeholder="férias, afastamento, desligamento…">
    </div>
    <div class="vt-modal-pe">
      ${a.pular
        ? `<button class="vt-btn" onclick="salvaAjudaMes(${ajudaId}, { pular: false })">Voltar a pagar</button>`
        : `<button class="vt-btn" onclick="salvaAjudaMes(${ajudaId}, { pular: true, motivo: val('aMotivo') })">Não pagar</button>`}
      <button class="vt-btn" onclick="salvaAjudaMes(${ajudaId}, { pago: ${a.pago ? 'false' : 'true'} })">
        ${a.pago ? 'Desmarcar pagamento' : 'Marcar como pago'}
      </button>
    </div>
    <div class="vt-sec-titulo"><h2 style="font-size:.95rem">Cadastro</h2><span class="vt-sec-rule"></span></div>
    <div class="vt-modal-pe" style="justify-content:flex-start">
      <button class="vt-btn" onclick="modalAjuda(${ajudaId})">Editar a ajuda</button>
    </div>`);
}

async function salvaAjudaMes(ajudaId, campos) {
  try {
    S.dados = await api(`/api/vt/${S.ano}/${S.mes}/ajuda`, {
      method: 'POST', body: JSON.stringify({ ajudaId, ...campos }),
    });
    fechaModal();
    render();
  } catch (e) { erroModal(e.message); }
}

function renderGaveta(d) {
  $('gavetaCont').textContent = `${d.gaveta.length} cartão${d.gaveta.length === 1 ? '' : 'ões'}`;
  if (!d.gaveta.length) {
    $('gaveta').innerHTML = `<div class="vt-vazio">Todos os cartões cadastrados estão com alguém.</div>`;
    return;
  }
  const empNome = id => (S.base?.empresas || []).find(e => e.id === id)?.nome || '—';

  $('gaveta').innerHTML = `<div class="vt-scroll"><table class="vt-t">
    <thead><tr>
      <th>Cartão</th><th>Empresa</th><th>Situação</th><th>Saldo parado</th><th></th>
    </tr></thead>
    <tbody>${d.gaveta.map(c => {
      const est = c.estado || 'gaveta';
      const preso = est === 'perdido' && !c.saldoRecuperado && Number(c.saldoNaPerda) > 0;
      return `<tr>
        <td><span class="vt-cartao">${esc(c.numero)}</span>${c.nomePlanilha ? ` <span class="vt-kpi-sub">(${esc(c.nomePlanilha)})</span>` : ''}</td>
        <td>${esc(empNome(c.empresaId))}</td>
        <td><span class="vt-chip ${est}">${ESTADO_NOME[est] || est}</span>
            ${c.perdidoEm ? `<span class="vt-kpi-sub"> ${fData(c.perdidoEm)}</span>` : ''}
            ${est === 'perdido' && c.saldoRecuperado ? ' <span class="vt-chip pago">saldo recuperado</span>' : ''}</td>
        <td class="vt-num">${preso ? 'R$ ' + fBRL(c.saldoNaPerda) : '—'}</td>
        <td>
          <div class="vt-acoes">
            ${est === 'gaveta' ? `<button class="vt-ico" onclick="modalEntregar(${c.id})">entregar</button>` : ''}
            ${preso ? `<button class="vt-ico" onclick="modalRecuperar(${c.id})">saldo voltou</button>` : ''}
            ${['perdido','gaveta','bloqueado'].includes(est) && !c.substituidoPor
              ? `<button class="vt-ico" onclick="modalSubstituir(${c.id})">substituir</button>` : ''}
            <button class="vt-ico" onclick="modalCartao(${c.id})">editar</button>
          </div>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ── Saldo ──────────────────────────────────────────────────────────────────
// Digitado em pt-BR ("153,55" ou "153.55"), guardado como número.
function paraNumero(txt) {
  const s = String(txt).trim();
  if (!s) return null;
  const limpo = s.replace(/[^\d,.-]/g, '');
  // 1.234,56 → 1234.56 | 1234.56 fica como está
  const n = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

async function salvaSaldo(inp) {
  const cartaoId = parseInt(inp.dataset.cartao);
  const valor = inp.value.trim() === '' ? '' : paraNumero(inp.value);
  if (valor !== '' && valor === null) { inp.classList.add('vazio'); return; }
  inp.classList.add('salvando');
  try {
    S.dados = await api(`/api/vt/${S.ano}/${S.mes}/linha`, {
      method: 'POST', body: JSON.stringify({ cartaoId, saldo: valor }),
    });
    render();
  } catch (e) { mostraErro(e.message); inp.classList.remove('salvando'); }
}

async function salvaLinha(cartaoId, campos) {
  try {
    S.dados = await api(`/api/vt/${S.ano}/${S.mes}/linha`, {
      method: 'POST', body: JSON.stringify({ cartaoId, ...campos }),
    });
    fechaModal();
    render();
  } catch (e) { erroModal(e.message); }
}

// ── Acesso ao portal ───────────────────────────────────────────────────────
// Uma senha por vez, e só quando pedida. Ao sair da tela, some.
async function verAcesso(empresaId) {
  const box = $('acesso-' + empresaId);
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  try {
    const r = await api(`/api/vt/empresa/${empresaId}/senha`);
    box.innerHTML = `
      <span>login</span> <b>${esc(r.login || '—')}</b>
      <span>senha</span> <b>${esc(r.senha || '—')}</b>
      <button class="vt-ico" onclick="navigator.clipboard.writeText(${JSON.stringify(r.senha || '')})">copiar senha</button>
      <button class="vt-ico" onclick="verAcesso(${empresaId})">esconder</button>`;
    box.classList.remove('hidden');
  } catch (e) { mostraErro(e.message); }
}

// ── Modal ──────────────────────────────────────────────────────────────────
function abreModal(titulo, html) {
  $('modalTitulo').textContent = titulo;
  $('modalBody').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function fechaModal() { $('overlay').classList.add('hidden'); $('modalBody').innerHTML = ''; }
function erroModal(msg) {
  const b = $('modalBody');
  const atual = b.querySelector('.vt-erro');
  if (atual) atual.textContent = msg;
  else b.insertAdjacentHTML('afterbegin', `<div class="vt-erro">${esc(msg)}</div>`);
}
const val = id => ($(id)?.value ?? '').trim();

function achaLinha(cartaoId) {
  for (const g of S.dados.grupos) {
    const l = g.linhas.find(x => x.cartaoId === cartaoId);
    if (l) return { linha: l, empresa: g.empresa };
  }
  return null;
}
const achaCartao = id => (S.base?.cartoes || []).find(c => c.id === id);

// ── Ações da linha ─────────────────────────────────────────────────────────
function menuLinha(cartaoId) {
  const r = achaLinha(cartaoId);
  if (!r) return;
  const l = r.linha;
  abreModal(l.nome, `
    <div class="vt-campo">
      <span class="dica">
        Cartão <b>${esc(l.numero)}</b> · ${esc(r.empresa.nome)} ·
        valor do dia R$ ${fBRL(l.valorDia)} (${l.passagensDia} passagens).
        ${l.pular ? `<br><b>Sem recarga este mês</b>${l.motivo ? ' — ' + esc(l.motivo) : ''}.` : ''}
        ${l.manual ? `<br>Valor ajustado à mão: R$ ${fBRL(l.recarga)} (a conta daria R$ ${fBRL(l.calculado)}).` : ''}
      </span>
    </div>
    <div class="vt-campo">
      <label>Recarga deste mês</label>
      <div class="vt-dupla">
        <input id="mRecarga" type="text" inputmode="decimal"
               value="${l.manual ? fBRL(l.recargaManual) : ''}" placeholder="calculada: ${fBRL(l.calculado)}">
        <button class="vt-btn" onclick="salvaLinha(${cartaoId}, { recargaManual: paraNumero(val('mRecarga')) })">Ajustar valor</button>
      </div>
      <span class="dica">Em branco volta para o valor calculado.</span>
    </div>
    <div class="vt-campo">
      <label>Não recarregar este mês</label>
      <input id="mMotivo" type="text" maxlength="120" value="${esc(l.motivo)}"
             placeholder="férias, afastamento, faltas…">
      <span class="dica">Faltas, férias e afastamento continuam sendo conta de gente: marque aqui e a linha sai do total.</span>
    </div>
    <div class="vt-modal-pe">
      ${l.pular
        ? `<button class="vt-btn" onclick="salvaLinha(${cartaoId}, { pular: false })">Voltar a recarregar</button>`
        : `<button class="vt-btn" onclick="salvaLinha(${cartaoId}, { pular: true, motivo: val('mMotivo') })">Não recarregar</button>`}
      <button class="vt-btn" onclick="salvaLinha(${cartaoId}, { pago: ${l.pago ? 'false' : 'true'} })">
        ${l.pago ? 'Desmarcar recarga feita' : 'Marcar como recarregado'}
      </button>
    </div>
    <div class="vt-sec-titulo"><h2 style="font-size:.95rem">Cartão</h2><span class="vt-sec-rule"></span></div>
    <div class="vt-modal-pe" style="justify-content:flex-start">
      <button class="vt-btn" onclick="modalPerda(${cartaoId})">Perdi o cartão</button>
      <button class="vt-btn" onclick="modalCartao(${cartaoId})">Editar cartão</button>
    </div>`);
}

// ── Perda ──────────────────────────────────────────────────────────────────
function modalPerda(cartaoId) {
  const r = achaLinha(cartaoId);
  const c = achaCartao(cartaoId);
  const nome = r ? r.linha.nome : '';
  const saldoAtual = r?.linha?.temSaldo ? fBRL(r.linha.saldo) : '';
  abreModal('Perda de cartão', `
    <div class="vt-campo">
      <span class="dica">
        Cartão <b>${esc(c?.numero || r?.linha.numero || '')}</b>${nome ? ' — ' + esc(nome) : ''}.
        Marcar a perda tira o cartão de uso e desvincula o colaborador.
      </span>
    </div>
    <div class="vt-campo">
      <label>Saldo que estava no cartão</label>
      <input id="pSaldo" type="text" inputmode="decimal" value="${saldoAtual}" placeholder="0,00">
      <span class="dica">
        Esse valor <b>não volta sozinho</b>: fica marcado como dinheiro preso até
        alguém pedir a transferência na operadora. Quando voltar, você marca aqui
        e o saldo entra no cartão que ficou no lugar.
      </span>
    </div>
    <div class="vt-campo">
      <label>Observação</label>
      <input id="pObs" type="text" maxlength="120" placeholder="onde/quando se perdeu">
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="fechaModal()">Cancelar</button>
      <button class="vt-btn solido" onclick="confirmaPerda(${cartaoId})">Registrar perda</button>
    </div>`);
}

async function confirmaPerda(cartaoId) {
  try {
    await api('/api/vt/cartao/perda', {
      method: 'POST',
      body: JSON.stringify({ cartaoId, saldo: paraNumero(val('pSaldo')) || 0, obs: val('pObs') }),
    });
    await recarregaBase();
    fechaModal();
    await carregar();
    // Perdeu, o próximo passo é dar outro cartão — já abre a substituição.
    modalSubstituir(cartaoId);
  } catch (e) { erroModal(e.message); }
}

// ── Substituição ───────────────────────────────────────────────────────────
function modalSubstituir(cartaoId) {
  const c = achaCartao(cartaoId);
  if (!c) return;
  const livres = (S.base.cartoes || []).filter(x =>
    !x.empId && x.id !== cartaoId && (x.estado || 'gaveta') === 'gaveta');
  const colabs = S.base.colaboradores || [];
  const donoAnterior = c.empId || null;

  abreModal('Substituir cartão', `
    <div class="vt-campo">
      <span class="dica">
        Saindo: <b>${esc(c.numero)}</b> (${ESTADO_NOME[c.estado] || c.estado}).
        O colaborador passa para o cartão novo e os dois ficam ligados no
        histórico — é o que permite cobrar o saldo depois.
      </span>
    </div>
    <div class="vt-campo">
      <label>De quem é o cartão novo</label>
      <select id="sEmp">
        <option value="">— escolha o colaborador —</option>
        ${colabs.map(e => `<option value="${e.id}" ${e.id === donoAnterior ? 'selected' : ''}>${esc(e.nome)}${e.board ? ' · ' + esc(BOARD_NOME[e.board] || e.board) : ''}</option>`).join('')}
      </select>
    </div>
    <div class="vt-campo">
      <label>Cartão que entra</label>
      <select id="sCartao" onchange="document.getElementById('sNovoNum').disabled = !!this.value">
        <option value="">— cadastrar um número novo —</option>
        ${livres.map(x => `<option value="${x.id}">${esc(x.numero)}</option>`).join('')}
      </select>
      <span class="dica">Escolha um da gaveta ou digite o número do cartão novo abaixo.</span>
    </div>
    <div class="vt-campo">
      <label>Número do cartão novo</label>
      <input id="sNovoNum" type="text" placeholder="número impresso no cartão">
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Empresa pagadora</label>
        <select id="sEmpresa">
          ${(S.base.empresas || []).map(e => `<option value="${e.id}" ${e.id === c.empresaId ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}
        </select>
      </div>
      <div class="vt-campo">
        <label>Valor do dia</label>
        <input id="sValorDia" type="text" inputmode="decimal" value="${fBRL(c.valorDia)}">
      </div>
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="fechaModal()">Agora não</button>
      <button class="vt-btn solido" onclick="confirmaSubstituir(${cartaoId})">Substituir</button>
    </div>`);
}

async function confirmaSubstituir(cartaoId) {
  try {
    const empId = val('sEmp');
    if (!empId) return erroModal('Diga de quem é o cartão novo.');
    await api('/api/vt/cartao/substituir', {
      method: 'POST',
      body: JSON.stringify({
        cartaoId, empId,
        novoCartaoId: val('sCartao') || null,
        novoNumero:   val('sNovoNum') || null,
        empresaId:    val('sEmpresa'),
        valorDia:     paraNumero(val('sValorDia')),
      }),
    });
    await recarregaBase();
    fechaModal();
    await carregar();
  } catch (e) { erroModal(e.message); }
}

// ── Recuperação do saldo ───────────────────────────────────────────────────
function modalRecuperar(cartaoId) {
  const c = achaCartao(cartaoId);
  if (!c) return;
  const novo = c.substituidoPor ? achaCartao(c.substituidoPor) : null;
  abreModal('Saldo recuperado', `
    <div class="vt-campo">
      <span class="dica">
        Cartão <b>${esc(c.numero)}</b>, perdido em ${fData(c.perdidoEm)} com
        R$ ${fBRL(c.saldoNaPerda)}. Marque aqui só depois que a operadora
        confirmar a transferência — é isso que faz o dinheiro voltar a contar.
      </span>
    </div>
    <div class="vt-campo">
      <label>Valor que voltou</label>
      <input id="rValor" type="text" inputmode="decimal" value="${fBRL(c.saldoNaPerda)}">
    </div>
    <div class="vt-campo">
      <label>Creditar no cartão</label>
      <select id="rDestino">
        <option value="">— não creditar, só marcar como resolvido —</option>
        ${(S.base.cartoes || []).filter(x => x.empId).map(x =>
          `<option value="${x.id}" ${novo && x.id === novo.id ? 'selected' : ''}>${esc(x.numero)}</option>`).join('')}
      </select>
      <span class="dica">
        O valor entra como saldo de ${MESES[S.mes - 1]} nesse cartão, e a recarga
        do mês já sai descontada.
      </span>
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="fechaModal()">Cancelar</button>
      <button class="vt-btn solido" onclick="confirmaRecuperar(${cartaoId})">Confirmar</button>
    </div>`);
}

async function confirmaRecuperar(cartaoId) {
  try {
    const r = await api('/api/vt/cartao/recuperar', {
      method: 'POST',
      body: JSON.stringify({
        cartaoId, valor: paraNumero(val('rValor')),
        creditarEm: val('rDestino') || null, ano: S.ano, mes: S.mes,
      }),
    });
    await recarregaBase();
    fechaModal();
    if (r?.grupos) { S.dados = r; render(); } else await carregar();
  } catch (e) { erroModal(e.message); }
}

// ── Entregar um cartão da gaveta ───────────────────────────────────────────
function modalEntregar(cartaoId) {
  const c = achaCartao(cartaoId);
  if (!c) return;
  abreModal('Entregar cartão', `
    <div class="vt-campo">
      <span class="dica">Cartão <b>${esc(c.numero)}</b> sai da gaveta e passa a ser recarregado todo mês.</span>
    </div>
    <div class="vt-campo">
      <label>Colaborador</label>
      <select id="eEmp">
        <option value="">— escolha —</option>
        ${(S.base.colaboradores || []).map(e =>
          `<option value="${e.id}">${esc(e.nome)}${e.board ? ' · ' + esc(BOARD_NOME[e.board] || e.board) : ''}</option>`).join('')}
      </select>
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Empresa pagadora</label>
        <select id="eEmpresa">
          ${(S.base.empresas || []).map(e => `<option value="${e.id}" ${e.id === c.empresaId ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}
        </select>
      </div>
      <div class="vt-campo">
        <label>Valor do dia</label>
        <input id="eValorDia" type="text" inputmode="decimal" value="${c.valorDia ? fBRL(c.valorDia) : ''}" placeholder="ida e volta">
      </div>
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="fechaModal()">Cancelar</button>
      <button class="vt-btn solido" onclick="confirmaEntregar(${cartaoId})">Entregar</button>
    </div>`);
}

async function confirmaEntregar(cartaoId) {
  const c = achaCartao(cartaoId);
  try {
    if (!val('eEmp')) return erroModal('Escolha o colaborador.');
    await api('/api/vt/cartao', {
      method: 'POST',
      body: JSON.stringify({
        id: cartaoId, numero: c.numero, empresaId: val('eEmpresa'),
        empId: val('eEmp'), valorDia: paraNumero(val('eValorDia')),
        passagensDia: c.passagensDia, obs: c.obs,
      }),
    });
    await recarregaBase();
    fechaModal();
    await carregar();
  } catch (e) { erroModal(e.message); }
}

// ── Cadastro de cartão ─────────────────────────────────────────────────────
function modalCartao(cartaoId) {
  const c = cartaoId ? achaCartao(cartaoId) : null;
  const emps = S.base.empresas || [];
  if (!emps.length) return abreModal('Cartões', `<div class="vt-erro">Cadastre primeiro uma empresa pagadora.</div>`);

  abreModal(c ? 'Editar cartão' : 'Novo cartão', `
    <div class="vt-campo">
      <label>Número do cartão</label>
      <input id="cNumero" type="text" value="${esc(c?.numero || '')}" placeholder="como está impresso">
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Empresa pagadora</label>
        <select id="cEmpresa">
          ${emps.map(e => `<option value="${e.id}" ${c && e.id === c.empresaId ? 'selected' : ''}>${esc(e.nome)} · ${esc(e.operadora)}</option>`).join('')}
        </select>
      </div>
      <div class="vt-campo">
        <label>Colaborador</label>
        <select id="cEmp" ${c && ['perdido','substituido'].includes(c.estado) ? 'disabled' : ''}>
          <option value="">— na gaveta, sem dono —</option>
          ${(S.base.colaboradores || []).map(e =>
            `<option value="${e.id}" ${c && e.id === c.empId ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Linha</label>
        <select id="cLinha" onchange="previewValorDia()">
          <option value="">— sem linha, valor digitado —</option>
          ${(S.base.config.linhas || []).map(x =>
            `<option value="${x.id}" ${c && c.linhaId === x.id ? 'selected' : ''}>${esc(x.nome)} · R$ ${fBRL(x.tarifaAtual)}</option>`).join('')}
        </select>
      </div>
      <div class="vt-campo">
        <label>Passagens por dia</label>
        <input id="cPassagens" type="number" min="1" max="8" value="${c?.passagensDia || 2}" onchange="previewValorDia()">
      </div>
    </div>
    <div class="vt-campo">
      <label>Valor do dia</label>
      <input id="cValorDia" type="text" inputmode="decimal" value="${c?.valorDia ? fBRL(c.valorDia) : ''}" placeholder="ida e volta">
      <span class="dica" id="cValorDica">Com linha escolhida, o valor é calculado — tarifa × passagens.</span>
    </div>
    <div class="vt-campo">
      <label>Situação</label>
      <select id="cEstado">
        ${['gaveta','bloqueado','perdido','substituido'].map(s =>
          `<option value="${s}" ${c && c.estado === s ? 'selected' : ''}>${ESTADO_NOME[s]}</option>`).join('')}
      </select>
      <span class="dica">Só vale quando o cartão está sem dono. Com colaborador escolhido ele fica em uso.</span>
    </div>
    <div class="vt-campo">
      <label>Observação</label>
      <input id="cObs" type="text" maxlength="120" value="${esc(c?.obs || '')}">
    </div>
    <div class="vt-modal-pe">
      ${c ? `<button class="vt-btn" onclick="removeCartao(${c.id})">Apagar</button>` : ''}
      <button class="vt-btn" onclick="painelCartoes()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaCartao(${c ? c.id : 'null'})">Salvar</button>
    </div>`);
  previewValorDia();
}

// Com linha escolhida o campo digitado sai de cena e vira só a conta à vista.
function previewValorDia() {
  const sel = $('cLinha'), inp = $('cValorDia'), dica = $('cValorDica');
  if (!sel || !inp) return;
  const linha = (S.base.config.linhas || []).find(x => x.id === parseInt(sel.value));
  if (!linha) {
    inp.disabled = false;
    dica.textContent = 'Sem linha, o valor é o que você digitar aqui.';
    return;
  }
  const pass = Math.max(1, parseInt(val('cPassagens')) || 2);
  inp.disabled = true;
  inp.value = fBRL(linha.tarifaAtual * pass);
  dica.textContent = `${esc(linha.nome)}: ${pass} × R$ ${fBRL(linha.tarifaAtual)}. Muda sozinho quando a tarifa subir.`;
}

async function salvaCartao(id) {
  try {
    await api('/api/vt/cartao', {
      method: 'POST',
      body: JSON.stringify({
        id, numero: val('cNumero'), empresaId: val('cEmpresa'),
        empId: val('cEmp') || null, valorDia: paraNumero(val('cValorDia')),
        linhaId: val('cLinha') || null,
        passagensDia: val('cPassagens'), estado: val('cEstado'), obs: val('cObs'),
      }),
    });
    await recarregaBase();
    await carregar();
    painelCartoes();
  } catch (e) { erroModal(e.message); }
}

async function removeCartao(id) {
  if (!confirm('Apagar este cartão do cadastro?')) return;
  try {
    await api('/api/vt/cartao', { method: 'POST', body: JSON.stringify({ remover: id }) });
    await recarregaBase();
    await carregar();
    painelCartoes();
  } catch (e) { erroModal(e.message); }
}

// ── Painel de cartões e empresas ───────────────────────────────────────────
function painelCartoes() {
  const cartoes = [...(S.base.cartoes || [])].sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR'));
  const nomeEmp = id => (S.base.empresas || []).find(e => e.id === id)?.nome || '—';
  const nomeCol = id => (S.base.colaboradores || []).find(e => e.id === id)?.nome || '—';

  abreModal('Cartões e empresas', `
    <div class="vt-modal-pe" style="justify-content:flex-start;margin:0 0 .8rem">
      <button class="vt-btn solido" onclick="modalCartao(null)">Novo cartão</button>
      <button class="vt-btn" onclick="painelLinhas()">Linhas e tarifas</button>
      <button class="vt-btn" onclick="painelAjudas()">Ajuda de custo</button>
      <button class="vt-btn" onclick="painelEmpresas()">Empresas e acessos</button>
      <button class="vt-btn" onclick="painelParametros()">Regra do cálculo</button>
    </div>
    <div class="vt-scroll"><table class="vt-t">
      <thead><tr><th>Cartão</th><th>Com quem</th><th>Empresa</th><th>Valor dia</th><th></th></tr></thead>
      <tbody>${cartoes.map(c => `<tr>
        <td><span class="vt-cartao">${esc(c.numero)}</span></td>
        <td>${c.empId ? esc(nomeCol(c.empId)) : `<span class="vt-chip ${c.estado}">${ESTADO_NOME[c.estado] || c.estado}</span>`}</td>
        <td>${esc(nomeEmp(c.empresaId))}</td>
        <td class="vt-num">${c.valorDia ? fBRL(c.valorDia) : '—'}</td>
        <td><button class="vt-ico" onclick="modalCartao(${c.id})">editar</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${cartoes.length ? '' : '<div class="vt-vazio">Nenhum cartão cadastrado. Cadastre todos os que a casa tem, mesmo os que estão parados na gaveta.</div>'}`);
}

// ── Ajuda de custo ─────────────────────────────────────────────────────────
// Quem não quer o vale recebe em dinheiro. É alternativa ao cartão, não um
// extra: o servidor recusa as duas coisas na mesma pessoa.
function painelAjudas() {
  const ajudas = (S.base.ajudas || []).filter(a => a.ativo);
  const nomeCol = id => (S.base.colaboradores || []).find(e => e.id === id)?.nome || '—';
  const nomeEmp = id => (S.base.empresas || []).find(e => e.id === id)?.nome || '—';
  const faixaDe = a => {
    const fx = S.base.config.faixas || [];
    if (a.faixaId) return fx.find(f => f.id === a.faixaId);
    const ord = [...fx].sort((x, y) => (x.ateKm ?? 1e9) - (y.ateKm ?? 1e9));
    return ord.find(f => f.ateKm != null && a.km <= f.ateKm) || ord.find(f => f.ateKm == null);
  };

  abreModal('Ajuda de custo', `
    <div class="vt-campo"><span class="dica">
      Pagamento em dinheiro para quem não quer vale-transporte. O valor é o da
      faixa de distância — não tem cartão, não tem saldo para ler e não depende
      da escala do mês.
    </span></div>
    ${ajudas.length ? `<div class="vt-scroll"><table class="vt-t">
      <thead><tr><th>Colaborador</th><th>Empresa</th><th>Km</th><th>Faixa</th><th>Valor</th><th></th></tr></thead>
      <tbody>${ajudas.map(a => {
        const f = faixaDe(a);
        return `<tr>
          <td>${esc(nomeCol(a.empId))}</td>
          <td>${esc(nomeEmp(a.empresaId))}</td>
          <td class="vt-num">${a.km} km</td>
          <td class="vt-num">${esc(f?.nome || '—')}${a.faixaId ? ' <span class="vt-chip substituido">fixada</span>' : ''}</td>
          <td class="vt-num">${f ? 'R$ ' + fBRL(f.valor) : '—'}</td>
          <td><button class="vt-ico" onclick="modalAjuda(${a.id})">editar</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : '<div class="vt-vazio">Ninguém na ajuda de custo — todo mundo está no cartão.</div>'}
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelCartoes()">Voltar</button>
      <button class="vt-btn" onclick="painelFaixas()">Faixas e valores</button>
      <button class="vt-btn solido" onclick="modalAjuda(null)">Nova ajuda</button>
    </div>`);
}

function modalAjuda(id) {
  // O id pode vir da tabela do mês (ajudaId) ou do cadastro — é o mesmo id.
  const a = id ? (S.base.ajudas || []).find(x => x.id === id) : null;
  const fx = S.base.config.faixas || [];

  abreModal(a ? 'Editar ajuda de custo' : 'Nova ajuda de custo', `
    <div class="vt-campo">
      <label>Colaborador</label>
      <select id="jEmp" ${a ? 'disabled' : ''}>
        <option value="">— escolha —</option>
        ${(S.base.colaboradores || []).map(e =>
          `<option value="${e.id}" ${a && a.empId === e.id ? 'selected' : ''}>${esc(e.nome)}${e.board ? ' · ' + esc(BOARD_NOME[e.board] || e.board) : ''}</option>`).join('')}
      </select>
      ${a ? '<span class="dica">Para trocar de pessoa, encerre esta e crie outra.</span>'
           : '<span class="dica">Quem estiver com cartão precisa devolvê-lo antes.</span>'}
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Empresa pagadora</label>
        <select id="jEmpresa">
          ${(S.base.empresas || []).map(e =>
            `<option value="${e.id}" ${a && a.empresaId === e.id ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}
        </select>
      </div>
      <div class="vt-campo">
        <label>Km</label>
        <input id="jKm" type="number" min="0" step="1" value="${a?.km || ''}" onchange="previewFaixa()">
        <span class="dica" id="jFaixaDica">A faixa sai daqui.</span>
      </div>
    </div>
    <div class="vt-campo">
      <label>Faixa</label>
      <select id="jFaixa" onchange="previewFaixa()">
        <option value="">— pela distância —</option>
        ${fx.map(f => `<option value="${f.id}" ${a && a.faixaId === f.id ? 'selected' : ''}>${esc(f.nome)} · R$ ${fBRL(f.valor)}${f.ateKm ? ' · até ' + f.ateKm + ' km' : ' · acima'}</option>`).join('')}
      </select>
      <span class="dica">Fixe a faixa só quando o caso fugir da tabela.</span>
    </div>
    <div class="vt-campo">
      <label>Observação</label>
      <input id="jObs" type="text" maxlength="120" value="${esc(a?.obs || '')}">
    </div>
    <div class="vt-modal-pe">
      ${a ? `<button class="vt-btn" onclick="encerraAjuda(${a.id})">Encerrar</button>` : ''}
      <button class="vt-btn" onclick="painelAjudas()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaAjuda(${a ? a.id : 'null'})">Salvar</button>
    </div>`);
  previewFaixa();
}

// Mostra qual faixa o km cai, antes de salvar — o valor não é digitado, então
// esse é o único jeito de conferir se o km está certo.
function previewFaixa() {
  const dica = $('jFaixaDica');
  if (!dica) return;
  const fixada = parseInt(val('jFaixa'));
  const fx = S.base.config.faixas || [];
  if (fixada) {
    const f = fx.find(x => x.id === fixada);
    dica.textContent = f ? `Faixa fixada: ${f.nome}, R$ ${fBRL(f.valor)}.` : '';
    return;
  }
  const km = Number(val('jKm')) || 0;
  const ord = [...fx].sort((x, y) => (x.ateKm ?? 1e9) - (y.ateKm ?? 1e9));
  const f = ord.find(x => x.ateKm != null && km <= x.ateKm) || ord.find(x => x.ateKm == null);
  dica.textContent = f ? `${km} km cai na ${f.nome}: R$ ${fBRL(f.valor)}.` : 'Nenhuma faixa cobre esse km.';
}

async function salvaAjuda(id) {
  try {
    if (!id && !val('jEmp')) return erroModal('Escolha o colaborador.');
    await api('/api/vt/ajuda', {
      method: 'POST',
      body: JSON.stringify({
        id, empId: val('jEmp'), empresaId: val('jEmpresa'),
        km: val('jKm'), faixaId: val('jFaixa') || null, obs: val('jObs'),
      }),
    });
    await recarregaBase();
    await carregar();
    painelAjudas();
  } catch (e) { erroModal(e.message); }
}

async function encerraAjuda(id) {
  if (!confirm('Encerrar a ajuda de custo desta pessoa? Ela sai do mês a partir de agora.')) return;
  try {
    await api('/api/vt/ajuda', { method: 'POST', body: JSON.stringify({ id, ativo: false }) });
    await recarregaBase();
    await carregar();
    painelAjudas();
  } catch (e) { erroModal(e.message); }
}

function painelFaixas() {
  const fx = S.base.config.faixas || [];
  abreModal('Faixas da ajuda de custo', `
    <div class="vt-campo"><span class="dica">
      Cada faixa é um teto de distância e um valor. A faixa sem teto é a de
      cima — pega quem mora mais longe que todas as outras.
    </span></div>
    <div class="vt-scroll"><table class="vt-t">
      <thead><tr><th>Faixa</th><th>Até</th><th>Valor</th><th></th></tr></thead>
      <tbody>${fx.map(f => `<tr>
        <td>${esc(f.nome)}</td>
        <td class="vt-num">${f.ateKm ? f.ateKm + ' km' : 'acima'}</td>
        <td class="vt-num">R$ ${fBRL(f.valor)}</td>
        <td><button class="vt-ico" onclick="modalFaixa(${f.id})">editar</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelAjudas()">Voltar</button>
      <button class="vt-btn solido" onclick="modalFaixa(null)">Nova faixa</button>
    </div>`);
}

function modalFaixa(id) {
  const f = id ? (S.base.config.faixas || []).find(x => x.id === id) : null;
  abreModal(f ? 'Editar ' + f.nome : 'Nova faixa', `
    <div class="vt-campo">
      <label>Nome</label>
      <input id="fNome" type="text" value="${esc(f?.nome || '')}" placeholder="Faixa 5">
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Até quantos km</label>
        <input id="fKm" type="number" min="1" value="${f?.ateKm ?? ''}" placeholder="em branco = acima de todas">
      </div>
      <div class="vt-campo">
        <label>Valor no mês</label>
        <input id="fValor" type="text" inputmode="decimal" value="${f?.valor ? fBRL(f.valor) : ''}">
      </div>
    </div>
    <div class="vt-modal-pe">
      ${f ? `<button class="vt-btn" onclick="salvaFaixa(null, { remover: ${f.id} })">Apagar</button>` : ''}
      <button class="vt-btn" onclick="painelFaixas()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaFaixa(${f ? f.id : 'null'}, {
        nome: val('fNome'), ateKm: val('fKm'), valor: paraNumero(val('fValor')),
      })">Salvar</button>
    </div>`);
}

async function salvaFaixa(id, campos) {
  try {
    await api('/api/vt/faixa', { method: 'POST', body: JSON.stringify({ id, ...campos }) });
    await recarregaBase();
    await carregar();
    painelFaixas();
  } catch (e) { erroModal(e.message); }
}

// ── Linhas e tarifas ───────────────────────────────────────────────────────
// A tarifa fica num lugar só. Quando ela sobe, você acrescenta a vigência nova
// e os meses já fechados continuam com o valor que tinham — nenhuma recarga
// antiga muda de número por causa do aumento.
function painelLinhas() {
  const linhas = S.base.config.linhas || [];
  const usos = id => (S.base.cartoes || []).filter(c => c.linhaId === id).length;
  const semLinha = (S.base.cartoes || []).filter(c => c.empId && !c.linhaId);

  abreModal('Linhas e tarifas', `
    <div class="vt-campo"><span class="dica">
      O valor do dia de cada cartão passa a ser <b>tarifa da linha × passagens
      por dia</b>. Cadastre a linha uma vez; na alta, acrescente a tarifa nova
      com o mês em que passa a valer.
    </span></div>
    ${linhas.length ? `<div class="vt-scroll"><table class="vt-t">
      <thead><tr><th>Linha</th><th>Tarifa hoje</th><th>Vigências</th><th>Cartões</th><th></th></tr></thead>
      <tbody>${linhas.map(l => `<tr>
        <td>${esc(l.nome)}${l.obs ? ` <span class="vt-kpi-sub">${esc(l.obs)}</span>` : ''}</td>
        <td class="vt-num">${l.tarifaAtual ? 'R$ ' + fBRL(l.tarifaAtual) : '—'}</td>
        <td class="vt-num">${l.tarifas.length}</td>
        <td class="vt-num">${usos(l.id)}</td>
        <td><button class="vt-ico" onclick="modalLinha(${l.id})">editar</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="vt-vazio">Nenhuma linha cadastrada ainda.</div>'}
    ${semLinha.length ? `<div class="vt-aviso" style="margin:.8rem 0 0">
      <div><b>${semLinha.length} cartão${semLinha.length === 1 ? '' : 'ões'} em uso ainda sem linha.</b>
      Continuam com o valor digitado à mão, que funciona — só não acompanha a
      alta de tarifa sozinho.</div>
    </div>` : ''}
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelCartoes()">Voltar</button>
      <button class="vt-btn solido" onclick="modalLinha(null)">Nova linha</button>
    </div>`);
}

function modalLinha(id) {
  const l = id ? (S.base.config.linhas || []).find(x => x.id === id) : null;
  const mesAtual = `${S.ano}-${String(S.mes).padStart(2, '0')}`;
  const usos = l ? (S.base.cartoes || []).filter(c => c.linhaId === l.id).length : 0;

  abreModal(l ? 'Linha ' + l.nome : 'Nova linha', `
    <div class="vt-campo">
      <label>Nome da linha</label>
      <input id="lNome" type="text" value="${esc(l?.nome || '')}" placeholder="BHBUS comum, Ótimo metropolitano…">
    </div>
    <div class="vt-campo">
      <label>Observação</label>
      <input id="lObs" type="text" maxlength="120" value="${esc(l?.obs || '')}" placeholder="quem usa, trajeto…">
    </div>
    ${l ? `<div class="vt-sec-titulo"><h2 style="font-size:.95rem">Tarifas</h2><span class="vt-sec-rule"></span></div>
      ${l.tarifas.length ? `<div class="vt-scroll"><table class="vt-t">
        <thead><tr><th>Desde</th><th>Tarifa</th><th></th></tr></thead>
        <tbody>${l.tarifas.map(t => `<tr>
          <td>${t.desde === '2000-01' ? 'sempre' : t.desde.split('-').reverse().join('/')}</td>
          <td class="vt-num">R$ ${fBRL(t.valor)}</td>
          <td>${l.tarifas.length > 1
            ? `<button class="vt-ico perigo" onclick="salvaLinha(${l.id}, { removerTarifa: '${t.desde}' })">remover</button>`
            : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="vt-vazio">Nenhuma tarifa ainda.</div>'}` : ''}
    <div class="vt-dupla" style="margin-top:.7rem">
      <div class="vt-campo">
        <label>${l && l.tarifas.length ? 'Nova tarifa' : 'Tarifa'}</label>
        <input id="lTarifa" type="text" inputmode="decimal" placeholder="valor de uma passagem">
      </div>
      <div class="vt-campo">
        <label>Passa a valer em</label>
        <input id="lDesde" type="month" value="${l && l.tarifas.length ? mesAtual : ''}">
        <span class="dica">${l && l.tarifas.length
          ? 'Meses anteriores ficam com a tarifa antiga.'
          : 'Em branco vale para todos os meses, inclusive os que já estão no sistema.'}</span>
      </div>
    </div>
    ${usos ? `<div class="vt-campo"><span class="dica">${usos} cartão${usos === 1 ? '' : 'ões'} usando esta linha.</span></div>` : ''}
    <div class="vt-modal-pe">
      ${l && !usos ? `<button class="vt-btn" onclick="salvaLinha(${l.id}, { remover: ${l.id} })">Apagar</button>` : ''}
      <button class="vt-btn" onclick="painelLinhas()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaLinha(${l ? l.id : 'null'}, {
        nome: val('lNome'), obs: val('lObs'),
        tarifa: val('lTarifa') ? paraNumero(val('lTarifa')) : null, desde: val('lDesde'),
      })">Salvar</button>
    </div>`);
}

async function salvaLinha(id, campos) {
  try {
    await api('/api/vt/linha', { method: 'POST', body: JSON.stringify({ id, ...campos }) });
    await recarregaBase();
    await carregar();
    if (campos.remover) painelLinhas(); else if (id) modalLinha(id); else painelLinhas();
  } catch (e) { erroModal(e.message); }
}

function painelEmpresas() {
  abreModal('Empresas pagadoras', `
    <div class="vt-campo"><span class="dica">
      Um bloco por CNPJ que paga vale-transporte — é assim que a operadora cobra.
      A senha fica guardada aqui e só aparece quando alguém pede, uma de cada vez.
    </span></div>
    <div class="vt-scroll"><table class="vt-t">
      <thead><tr><th>Empresa</th><th>CNPJ</th><th>Operadora</th><th>Acesso</th><th></th></tr></thead>
      <tbody>${(S.base.empresas || []).map(e => `<tr>
        <td>${esc(e.nome)}</td>
        <td class="vt-cartao">${esc(e.cnpj || '—')}</td>
        <td><span class="vt-oper">${esc(e.operadora)}</span></td>
        <td>${e.temSenha ? '<span class="vt-chip pago">guardado</span>' : '<span class="vt-chip gaveta">sem senha</span>'}</td>
        <td><button class="vt-ico" onclick="modalEmpresa(${e.id})">editar</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelCartoes()">Voltar</button>
      <button class="vt-btn solido" onclick="modalEmpresa(null)">Nova empresa</button>
    </div>`);
}

function modalEmpresa(id) {
  const e = id ? (S.base.empresas || []).find(x => x.id === id) : null;
  abreModal(e ? 'Editar empresa' : 'Nova empresa', `
    <div class="vt-campo">
      <label>Nome</label>
      <input id="nEmpNome" type="text" value="${esc(e?.nome || '')}" placeholder="LMJ Matriz, JDG Comércio…">
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>CNPJ</label>
        <input id="nEmpCnpj" type="text" value="${esc(e?.cnpj || '')}" placeholder="00.000.000/0000-00">
      </div>
      <div class="vt-campo">
        <label>Operadora</label>
        <select id="nEmpOper">
          ${(S.base.operadoras || ['BHBUS', 'OTIMO']).map(o =>
            `<option value="${o}" ${e && e.operadora === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Login do portal</label>
        <input id="nEmpLogin" type="text" value="${esc(e?.login || '')}">
      </div>
      <div class="vt-campo">
        <label>Senha do portal</label>
        <input id="nEmpSenha" type="password" autocomplete="new-password"
               placeholder="${e?.temSenha ? 'guardada — deixe em branco para manter' : ''}">
      </div>
    </div>
    <div class="vt-campo">
      <label>Observação</label>
      <input id="nEmpObs" type="text" maxlength="120" value="${esc(e?.obs || '')}">
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelEmpresas()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaEmpresa(${e ? e.id : 'null'})">Salvar</button>
    </div>`);
}

async function salvaEmpresa(id) {
  try {
    await api('/api/vt/config', {
      method: 'POST',
      body: JSON.stringify({
        empresa: {
          id, nome: val('nEmpNome'), cnpj: val('nEmpCnpj'), operadora: val('nEmpOper'),
          login: val('nEmpLogin'), senha: val('nEmpSenha'), obs: val('nEmpObs'),
        },
      }),
    });
    await recarregaBase();
    await carregar();
    painelEmpresas();
  } catch (e) { erroModal(e.message); }
}

function painelParametros() {
  const c = S.base.config;
  abreModal('Regra do cálculo', `
    <div class="vt-campo"><span class="dica">
      A conta é a da planilha: compra-se em dias inteiros até o cartão cobrir os
      dias de trabalho do mês mais a reserva.<br>
      <b>recarga = arredonda pra cima de (dias de trabalho + reserva − saldo ÷ valor do dia) × valor do dia</b>
    </span></div>
    <div class="vt-campo">
      <label>De onde vêm os dias de trabalho</label>
      <select id="pEscala">
        <option value="1" ${c.usarEscala ? 'selected' : ''}>Da escala do mês (dias do mês menos as folgas de cada um)</option>
        <option value="0" ${c.usarEscala ? '' : 'selected'}>Número fixo, igual para todo mundo</option>
      </select>
      <span class="dica">
        Pela escala, cada um recebe conforme os dias que vai trabalhar de fato.
        Quem ainda estiver sem escala no mês cai no número fixo, e a linha avisa.
      </span>
    </div>
    <div class="vt-dupla">
      <div class="vt-campo">
        <label>Dias fixos (quando não há escala)</label>
        <input id="pDias" type="number" min="1" max="31" value="${c.diasMes}">
        <span class="dica">26 — o mês menos as quatro folgas.</span>
      </div>
      <div class="vt-campo">
        <label>Dias de reserva</label>
        <input id="pReserva" type="number" min="0" max="15" value="${c.diasReserva}">
        <span class="dica">O colchão para o cartão não zerar antes da próxima recarga.</span>
      </div>
    </div>
    <div class="vt-campo">
      <label>Folgas mínimas para considerar a escala pronta</label>
      <input id="pMinFolgas" type="number" min="1" max="15" value="${c.minFolgas}">
      <span class="dica">
        Ninguém trabalha o mês inteiro: quem está com menos folgas que isso é
        escala por fazer, não gente que folgou pouco.
      </span>
    </div>
    <div class="vt-modal-pe">
      <button class="vt-btn" onclick="painelCartoes()">Voltar</button>
      <button class="vt-btn solido" onclick="salvaParametros()">Salvar</button>
    </div>`);
}

async function salvaParametros() {
  try {
    await api('/api/vt/config', {
      method: 'POST',
      body: JSON.stringify({
        diasMes: val('pDias'), diasReserva: val('pReserva'),
        usarEscala: val('pEscala') === '1', minFolgas: val('pMinFolgas'),
      }),
    });
    await recarregaBase();
    fechaModal();
    await carregar();
  } catch (e) { erroModal(e.message); }
}

// ── Navegação ──────────────────────────────────────────────────────────────
function mudaMes(delta) {
  let m = S.mes + delta, y = S.ano;
  if (m < 1)  { m = 12; y--; }
  if (m > 12) { m = 1;  y++; }
  S.mes = m; S.ano = y;
  carregar();
}

$('mesAnt').addEventListener('click', () => mudaMes(-1));
$('mesProx').addEventListener('click', () => mudaMes(1));
$('btnCartoes').addEventListener('click', () => painelCartoes());
$('btnExportar').addEventListener('click', () => {
  window.location.href = `/api/vt/${S.ano}/${S.mes}/export`;
});
$('modalFechar').addEventListener('click', fechaModal);
$('overlay').addEventListener('click', e => { if (e.target === $('overlay')) fechaModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') fechaModal(); });

carregar();
