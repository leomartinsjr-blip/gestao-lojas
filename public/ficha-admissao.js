/* ══════════════════════════════════════════════════════════════════════════
   FICHA DE ADMISSÃO — a tela
   Uma página para os dois lados. O escritório cria a ficha e manda para a
   loja; a loja imprime, o candidato preenche à mão, a gerente digita aqui e
   devolve. O mesmo formulário serve para os dois — o que muda é quais botões
   aparecem embaixo. A folha impressa é montada a partir do que está digitado:
   ficha recém-enviada sai em branco, ficha preenchida sai pronta para assinar.
   ══════════════════════════════════════════════════════════════════════════ */

const S = {
  base: null,       // resposta de /api/fichas-admissao (papel, lojas, empresas, fichas)
  atual: null,      // ficha aberta
  sujo: false,      // digitou algo desde o último salvamento
  timer: null,      // debounce do autosave
  salvando: false,
};

const $  = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fDataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fData = iso => iso ? new Date(iso).toLocaleDateString('pt-BR') : '';
// Data digitada (AAAA-MM-DD) → papel (DD/MM/AAAA). Texto livre passa como está.
const fDataCampo = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v.split('-').reverse().join('/') : (v || '');

const BOARD_COR = {
  delrey: 'var(--col-delrey)', minas: 'var(--col-minas)', contagem: 'var(--col-contagem)',
  estacao: 'var(--col-estacao)', tommy: 'var(--col-tommy)', lez: 'var(--col-lez)',
};
const STATUS_NOME = { enviada: 'Na loja', preenchida: 'Preenchida', recebida: 'Recebida' };

// ── Os campos, na ordem do papel ───────────────────────────────────────────
// `lista` vira datalist (sugere, mas aceita o que for digitado); `opcoes` vira
// select fechado, porque no papel é marcação com X.
const SECOES = [
  { titulo: 'Dados pessoais', campos: [
    { k: 'nome', l: 'Nome completo', w: 'full', auto: 'name' },
    { k: 'rg', l: 'RG' },
    { k: 'cpf', l: 'CPF', inputmode: 'numeric' },
    { k: 'nascimento', l: 'Data de nascimento', tipo: 'date' },
    { k: 'cidadeNascimento', l: 'Cidade de nascimento', w: 'w3' },
    { k: 'pai', l: 'Nome do pai', w: 'w3' },
    { k: 'mae', l: 'Nome da mãe', w: 'full' },
    { k: 'celular', l: 'Celular', tipo: 'tel' },
    { k: 'email', l: 'E-mail', tipo: 'email', w: 'wide' },
    { k: 'grauInstrucao', l: 'Grau de instrução', lista: ['Fundamental incompleto', 'Fundamental completo', 'Médio incompleto', 'Médio completo', 'Superior incompleto', 'Superior completo'] },
    { k: 'estadoCivil', l: 'Estado civil', lista: ['Solteiro(a)', 'Casado(a)', 'Divorciado(a)', 'Viúvo(a)', 'União estável'] },
    { k: 'racaCor', l: 'Raça / cor', lista: ['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena'] },
    { k: 'deficiencia', l: 'Pessoa com deficiência', opcoes: ['', 'Não', 'Auditiva', 'Física', 'Mental', 'Múltipla', 'Visual'], w: 'w3' },
    { k: 'reabilitado', l: 'Reabilitado', opcoes: ['', 'Não', 'Sim'], w: 'w3' },
  ]},
  { titulo: 'Endereço', campos: [
    { k: 'rua', l: 'Rua / avenida', w: 'wide' },
    { k: 'numero', l: 'Número' },
    { k: 'cep', l: 'CEP', inputmode: 'numeric' },
    { k: 'bairro', l: 'Bairro' },
    { k: 'cidade', l: 'Cidade' },
  ]},
  { titulo: 'Dados profissionais', campos: [
    { k: 'dataAdmissao', l: 'Data de admissão', tipo: 'date' },
    { k: 'funcao', l: 'Função', w: 'wide' },
    { k: 'salario', l: 'Salário (R$)', inputmode: 'decimal' },
    { k: 'adiantamentoPct', l: 'Adiantamento (%)', inputmode: 'numeric' },
    { k: 'contratoExp', l: 'Contrato de experiência', opcoes: ['', '30', '45', '90'], sufixo: 'dias' },
    { k: 'valeTransporte', l: 'Vale-transporte', opcoes: ['', 'Sim', 'Não'] },
    { k: 'vtValor', l: 'VT — valor (R$)', inputmode: 'decimal' },
    { k: 'vtQuant', l: 'VT — quantidade', inputmode: 'numeric' },
    { k: 'horarioInicio', l: 'Horário — entrada', tipo: 'time', w: 'narrow' },
    { k: 'horarioFim', l: 'Horário — saída', tipo: 'time', w: 'narrow' },
  ]},
];
const DEP_MAX = 4;

// ── Conversa com o servidor ────────────────────────────────────────────────
async function api(url, opts) {
  const r = await fetch(url, { ...opts, headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined });
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

async function carregar() {
  try {
    mostraErro('');
    S.base = await api('/api/fichas-admissao');
    $('carregando').classList.add('hidden');
    $('kicker').textContent = S.base.escritorio ? 'Torre de Controle' : `Loja ${nomeLoja(S.base.board)}`;
    rotear();
  } catch (e) {
    $('carregando').classList.add('hidden');
    mostraErro(e.message === 'Erro 401' ? 'Sessão expirada — entre de novo no painel.' : e.message);
  }
}

function nomeLoja(board) { return (S.base?.lojas || []).find(l => l.board === board)?.nome || board || ''; }

// ── Rota: #f=ID abre a ficha; sem hash, a lista ────────────────────────────
function rotear() {
  const m = location.hash.match(/^#f=(\d+)$/);
  const f = m && (S.base.fichas || []).find(x => x.id === parseInt(m[1]));
  if (f) abrirFicha(f);
  else renderLista();
}
window.addEventListener('hashchange', () => {
  // Trocar de ficha com texto não salvo: grava antes de sair.
  if (S.sujo) salvar();
  rotear();
});

// ══════════════════════════════════════════════════════════════════════════
// LISTA
// ══════════════════════════════════════════════════════════════════════════
function renderLista() {
  S.atual = null;
  $('ficha').classList.add('hidden');
  $('acoesBar').classList.add('hidden');
  $('lista').classList.remove('hidden');
  $('voltarRotulo').textContent = 'Painel';
  $('btnVoltar').onclick = () => { location.href = '/'; };

  const esc_ = S.base.escritorio;
  $('topAcoes').innerHTML = esc_
    ? `<button class="fa-btn solido" id="btnNova">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
         <span>Enviar ficha para uma loja</span></button>`
    : '';
  if (esc_) $('btnNova').onclick = modalNova;

  const fichas = S.base.fichas || [];
  const grupos = esc_
    ? [
        { st: 'preenchida', titulo: 'Preenchidas — conferir e dar baixa' },
        { st: 'enviada',    titulo: 'Aguardando a loja' },
        { st: 'recebida',   titulo: 'Recebidas' },
      ]
    : [
        { st: 'enviada',    titulo: 'Para imprimir e preencher' },
        { st: 'preenchida', titulo: 'Enviadas ao escritório' },
        { st: 'recebida',   titulo: 'Concluídas' },
      ];

  if (!fichas.length) {
    $('lista').innerHTML = `<div class="fa-estado">${esc_
      ? 'Nenhuma ficha ainda. Clique em <b>Enviar ficha para uma loja</b> quando houver uma contratação.'
      : 'Nenhuma ficha de admissão para esta loja. Quando o escritório enviar uma, ela aparece aqui e no aviso do painel.'}</div>`;
    return;
  }

  $('lista').innerHTML = grupos.map(g => {
    const itens = fichas.filter(f => f.status === g.st);
    if (!itens.length && g.st === 'recebida') return '';
    return `
      <div class="fa-sec-titulo"><h2>${g.titulo}</h2><span class="fa-sec-rule"></span><span class="fa-sec-cont">${itens.length}</span></div>
      <div class="fa-card">${itens.length ? `
        <div class="fa-scroll"><table class="fa-t">
          <thead><tr>
            <th>Candidato</th>${esc_ ? '<th>Loja</th>' : ''}<th class="oculta-cel">Empresa</th><th class="oculta-cel">Função</th><th>Situação</th><th class="oculta-cel">${g.st === 'enviada' ? 'Enviada em' : g.st === 'preenchida' ? 'Preenchida em' : 'Recebida em'}</th><th></th>
          </tr></thead>
          <tbody>${itens.map(f => linhaLista(f, g.st, esc_)).join('')}</tbody>
        </table></div>` : `<div class="fa-vazio">Nenhuma.</div>`}
      </div>`;
  }).join('');

  $('lista').querySelectorAll('tr.clicavel').forEach(tr => {
    tr.onclick = () => { location.hash = `#f=${tr.dataset.id}`; };
  });
}

function linhaLista(f, st, esc_) {
  const nome = f.dados?.nome;
  const quando = st === 'enviada' ? f.criadoEm : st === 'preenchida' ? f.preenchidaEm : f.recebidaEm;
  return `<tr class="clicavel" data-id="${f.id}">
    <td><span class="fa-nome${nome ? '' : ' sem'}">${nome ? esc(nome) : 'sem nome ainda'}</span>
        ${f.devolucao && st === 'enviada' ? '<span class="fa-chip enviada" style="margin-left:.4rem">devolvida</span>' : ''}</td>
    ${esc_ ? `<td><span class="fa-loja"><span class="fa-tarja" style="background:${BOARD_COR[f.board] || 'var(--muted)'}"></span>${esc(f.loja)}</span></td>` : ''}
    <td class="oculta-cel"><span class="fa-mono">${esc(f.empresa.apelido)}</span></td>
    <td class="oculta-cel">${esc(f.dados?.funcao || '') || '<span class="fa-mono">—</span>'}</td>
    <td><span class="fa-chip ${f.status}">${STATUS_NOME[f.status]}</span></td>
    <td class="oculta-cel"><span class="fa-mono">${fDataHora(quando)}</span></td>
    <td class="fa-seta">›</td>
  </tr>`;
}

// ══════════════════════════════════════════════════════════════════════════
// A FICHA ABERTA
// ══════════════════════════════════════════════════════════════════════════
function abrirFicha(f) {
  S.atual = f;
  S.sujo = false;
  $('lista').classList.add('hidden');
  $('ficha').classList.remove('hidden');
  $('voltarRotulo').textContent = 'Fichas';
  $('btnVoltar').onclick = () => { location.hash = ''; };
  $('topAcoes').innerHTML = `
    <button class="fa-btn" id="btnImprimir" title="Imprimir a ficha — em branco se ainda não foi digitada">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
      <span class="fa-rotulo">Imprimir</span>
    </button>`;
  $('btnImprimir').onclick = imprimir;

  const editavel = f.status !== 'recebida';
  const esc_ = S.base.escritorio;
  const d = f.dados || {};

  const avisos = [];
  if (f.devolucao && f.status === 'enviada')
    avisos.push(`<div class="fa-aviso critico">↩ <div><b>Devolvida pelo escritório em ${fDataHora(f.devolucao.em)}:</b> ${esc(f.devolucao.motivo)}</div></div>`);
  if (f.status === 'recebida')
    avisos.push(`<div class="fa-aviso">✓ <div><b>Recebida pelo escritório em ${fDataHora(f.recebidaEm)}.</b> A ficha está fechada${esc_ ? ' — reabra para alterar' : ''}.</div></div>`);
  else if (f.status === 'preenchida' && !esc_)
    avisos.push(`<div class="fa-aviso">📤 <div><b>Enviada ao escritório em ${fDataHora(f.preenchidaEm)}.</b> Ainda dá para corrigir algo: o que você alterar aqui já vale.</div></div>`);
  else if (f.status === 'enviada' && !esc_ && !f.devolucao)
    avisos.push(`<div class="fa-aviso">🖨 <div><b>Imprima</b> para o candidato preencher à mão, <b>digite</b> aqui o que ele escreveu e depois clique em <b>Enviar ao escritório</b>. O que você digita é salvo sozinho.</div></div>`);

  $('ficha').innerHTML = `
    <div class="fa-card">
      <div class="fa-cab">
        <div class="fa-cab-emp">
          <b>${esc(f.empresa.razaoSocial || f.empresa.apelido)}</b>
          <span class="fa-mono">CNPJ ${esc(f.empresa.cnpjFmt)}${f.empresa.nomeFantasia ? ` · ${esc(f.empresa.nomeFantasia)}` : ''}</span>
        </div>
        <div class="fa-cab-meta">
          <span class="fa-loja"><span class="fa-tarja" style="background:${BOARD_COR[f.board] || 'var(--muted)'}"></span>${esc(f.loja)} <span class="fa-chip ${f.status}" style="margin-left:.3rem">${STATUS_NOME[f.status]}</span></span>
          <span>Ficha nº ${f.id} · enviada por ${esc(f.criadoPor)} em ${fDataHora(f.criadoEm)}</span>
        </div>
      </div>
      ${avisos.join('')}
      ${f.observacao ? `<div class="fa-obs"><b>Recado do escritório</b>${esc(f.observacao)}</div>` : ''}

      ${SECOES.map(sec => `
        <div class="fa-form-sec">
          <h3>${sec.titulo}</h3>
          <div class="fa-grid">${sec.campos.map(c => campoHtml(c, d[c.k] || '', editavel)).join('')}</div>
        </div>`).join('')}

      <div class="fa-form-sec">
        <h3>Dependentes <span class="fa-mono" style="font-family:inherit;text-transform:none;letter-spacing:0">— filhos, para salário-família e IRRF</span></h3>
        <table class="fa-dep">
          <thead><tr><th>Nome do filho</th><th>CPF</th><th>Data de nascimento</th></tr></thead>
          <tbody>${Array.from({ length: DEP_MAX }, (_, i) => {
            const dp = (d.dependentes || [])[i] || {};
            return `<tr>
              <td><input data-dep="${i}" data-k="nome" value="${esc(dp.nome || '')}" ${editavel ? '' : 'disabled'}></td>
              <td><input data-dep="${i}" data-k="cpf" inputmode="numeric" value="${esc(dp.cpf || '')}" ${editavel ? '' : 'disabled'}></td>
              <td><input data-dep="${i}" data-k="nascimento" type="date" value="${esc(dp.nascimento || '')}" ${editavel ? '' : 'disabled'}></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>

      ${(f.historico || []).length ? `<div class="fa-hist">${f.historico.map(h =>
        `<div><b>${fDataHora(h.em)}</b> · ${esc(h.por)} — ${esc(h.evento)}</div>`).join('')}</div>` : ''}
    </div>`;

  // Cada tecla marca a ficha como suja; o salvamento vem na pausa.
  $('ficha').querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', marcaSujo);
    el.addEventListener('change', marcaSujo);
  });

  renderAcoes();
  window.scrollTo(0, 0);
}

function campoHtml(c, v, editavel) {
  const dis = editavel ? '' : 'disabled';
  let ctl;
  if (c.opcoes) {
    ctl = `<select id="c-${c.k}" data-k="${c.k}" ${dis}>${c.opcoes.map(o =>
      `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${o === '' ? '—' : esc(o) + (c.sufixo ? ' ' + c.sufixo : '')}</option>`).join('')}</select>`;
  } else {
    const lista = c.lista ? `list="dl-${c.k}"` : '';
    ctl = `<input id="c-${c.k}" data-k="${c.k}" type="${c.tipo || 'text'}" ${c.inputmode ? `inputmode="${c.inputmode}"` : ''} ${c.auto ? `autocomplete="${c.auto}"` : 'autocomplete="off"'} ${lista} value="${esc(v)}" ${dis}>` +
      (c.lista ? `<datalist id="dl-${c.k}">${c.lista.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : '');
  }
  return `<div class="fa-campo ${c.w || ''}"><label for="c-${c.k}">${c.l}</label>${ctl}</div>`;
}

// O que está na tela agora, no formato que o servidor guarda.
function lerFormulario() {
  const dados = {};
  $('ficha').querySelectorAll('[data-k]:not([data-dep])').forEach(el => { dados[el.dataset.k] = el.value; });
  const deps = [];
  $('ficha').querySelectorAll('[data-dep]').forEach(el => {
    const i = parseInt(el.dataset.dep);
    deps[i] = deps[i] || { nome: '', cpf: '', nascimento: '' };
    deps[i][el.dataset.k] = el.value;
  });
  dados.dependentes = deps.filter(Boolean);
  return dados;
}

function renderAcoes() {
  const f = S.atual;
  const esc_ = S.base.escritorio;
  const bar = $('acoesBar');
  const botoes = [];
  if (f.status === 'enviada' && !esc_)
    botoes.push(`<button class="fa-btn solido" id="acEnviar">Enviar ao escritório</button>`);
  if (esc_) {
    if (f.status !== 'recebida') botoes.push(`<button class="fa-btn solido" id="acReceber">Marcar como recebida</button>`);
    if (f.status === 'preenchida') botoes.push(`<button class="fa-btn" id="acDevolver">Devolver à loja</button>`);
    if (f.status === 'recebida') botoes.push(`<button class="fa-btn" id="acReabrir">Reabrir</button>`);
    if (f.status !== 'recebida') botoes.push(`<button class="fa-btn perigo" id="acExcluir">Excluir</button>`);
  }
  bar.innerHTML = `<span class="fa-salvo" id="salvoLbl">${f.status === 'recebida' ? 'Fechada' : f.atualizadoEm ? `Salva ${fDataHora(f.atualizadoEm)}` : 'Nada digitado ainda'}</span>${botoes.join('')}`;
  bar.classList.remove('hidden');

  $('acEnviar')  && ($('acEnviar').onclick  = () => transicao('enviar'));
  $('acReceber') && ($('acReceber').onclick = () => transicao('receber'));
  $('acReabrir') && ($('acReabrir').onclick = () => transicao('reabrir'));
  $('acDevolver') && ($('acDevolver').onclick = modalDevolver);
  $('acExcluir') && ($('acExcluir').onclick = excluir);
}

// ── Autosave ───────────────────────────────────────────────────────────────
function marcaSujo() {
  if (!S.atual || S.atual.status === 'recebida') return;
  S.sujo = true;
  const lbl = $('salvoLbl');
  if (lbl) { lbl.textContent = 'Salvando…'; lbl.className = 'fa-salvo salvando'; }
  clearTimeout(S.timer);
  S.timer = setTimeout(salvar, 900);
}

async function salvar() {
  clearTimeout(S.timer);
  if (!S.atual || !S.sujo || S.salvando) return;
  S.salvando = true;
  const f = S.atual;
  const dados = lerFormulario();
  let falhou = false;
  try {
    const r = await api(`/api/fichas-admissao/${f.id}`, { method: 'PUT', body: JSON.stringify({ dados }) });
    f.dados = dados; f.atualizadoEm = r.atualizadoEm; f.atualizadoPor = r.atualizadoPor;
    // Se digitou mais enquanto salvava, a ficha continua suja e o finally cuida.
    if (JSON.stringify(dados) === JSON.stringify(lerFormularioSeguro(f))) S.sujo = false;
    const lbl = $('salvoLbl');
    if (lbl && S.atual === f && !S.sujo) { lbl.textContent = `Salva ${fDataHora(r.atualizadoEm)}`; lbl.className = 'fa-salvo'; }
  } catch (e) {
    falhou = true;
    const lbl = $('salvoLbl');
    if (lbl) { lbl.textContent = `Não salvou: ${e.message}`; lbl.className = 'fa-salvo erro'; }
  } finally {
    S.salvando = false;
    // Erro espera mais antes de insistir; digitação nova volta ao ritmo normal.
    if (S.sujo) S.timer = setTimeout(salvar, falhou ? 4000 : 900);
  }
}
// O formulário só existe enquanto a ficha está aberta; se o usuário já saiu
// dela, o que foi salvo é o que valia.
function lerFormularioSeguro(f) {
  return S.atual === f && !$('ficha').classList.contains('hidden') ? lerFormulario() : f.dados;
}
window.addEventListener('beforeunload', e => {
  if (S.sujo) { e.preventDefault(); e.returnValue = ''; }
});

// ── Transições ─────────────────────────────────────────────────────────────
async function transicao(acao, extra) {
  const f = S.atual;
  if (S.sujo) await salvar();
  if (S.sujo) { mostraErro('Não foi possível salvar o que foi digitado — tente de novo.'); return; }
  const confirma = {
    enviar:  'Enviar a ficha para o escritório? Você ainda pode corrigir depois, até eles darem baixa.',
    receber: 'Marcar como recebida? A ficha fica fechada para a loja.',
    reabrir: 'Reabrir a ficha para alteração?',
  }[acao];
  if (confirma && !confirm(confirma)) return;
  try {
    mostraErro('');
    const nova = await api(`/api/fichas-admissao/${f.id}/status`, { method: 'POST', body: JSON.stringify({ acao, ...extra }) });
    const i = S.base.fichas.findIndex(x => x.id === nova.id);
    if (i >= 0) S.base.fichas[i] = nova;
    if (acao === 'enviar' || acao === 'receber') location.hash = '';
    else abrirFicha(nova);
  } catch (e) { mostraErro(e.message); }
}

async function excluir() {
  const f = S.atual;
  if (!confirm(`Excluir a ficha nº ${f.id}${f.dados?.nome ? ` (${f.dados.nome})` : ''}? A loja deixa de vê-la.`)) return;
  try {
    await api(`/api/fichas-admissao/${f.id}`, { method: 'DELETE' });
    S.base.fichas = S.base.fichas.filter(x => x.id !== f.id);
    S.sujo = false;
    location.hash = '';
  } catch (e) { mostraErro(e.message); }
}

// ── Modais ─────────────────────────────────────────────────────────────────
function abreModal(titulo, html) {
  $('modalTitulo').textContent = titulo;
  $('modalBody').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function fechaModal() { $('overlay').classList.add('hidden'); }
$('modalFechar').onclick = fechaModal;
$('overlay').addEventListener('click', e => { if (e.target === $('overlay')) fechaModal(); });

function modalNova() {
  const lojas = S.base.lojas;
  abreModal('Enviar ficha para uma loja', `
    <div class="fa-grid">
      <div class="fa-campo"><label>Loja</label>
        <select id="nvLoja">${lojas.map(l => `<option value="${l.board}">${esc(l.nome)}</option>`).join('')}</select></div>
      <div class="fa-campo"><label>Empresa que vai registrar</label>
        <select id="nvEmpresa">${S.base.empresas.map(e => `<option value="${e.cnpj}">${esc(e.apelido)} · ${esc(e.cnpjFmt)}</option>`).join('')}</select>
        <span class="dica">Muda sozinha conforme a loja; troque só se o registro for em outro CNPJ.</span></div>
      <div class="fa-campo"><label>Função (opcional)</label><input id="nvFuncao" placeholder="Vendedor(a), caixa, estoquista…"></div>
      <div class="fa-campo"><label>Recado para a loja (opcional)</label><input id="nvObs" maxlength="300" placeholder="Ex.: começa dia 22; pedir cópia da CTPS digital"></div>
    </div>
    <div class="fa-modal-pe">
      <button class="fa-btn" id="nvCancelar">Cancelar</button>
      <button class="fa-btn solido" id="nvOk">Enviar</button>
    </div>`);
  const sincronizaEmpresa = () => {
    const l = lojas.find(x => x.board === $('nvLoja').value);
    if (l?.cnpj) $('nvEmpresa').value = l.cnpj;
  };
  sincronizaEmpresa();
  $('nvLoja').onchange = sincronizaEmpresa;
  $('nvCancelar').onclick = fechaModal;
  $('nvOk').onclick = async () => {
    try {
      $('nvOk').disabled = true;
      const nova = await api('/api/fichas-admissao', { method: 'POST', body: JSON.stringify({
        board: $('nvLoja').value, cnpj: $('nvEmpresa').value,
        funcao: $('nvFuncao').value, observacao: $('nvObs').value,
      }) });
      S.base.fichas.unshift(nova);
      fechaModal();
      location.hash = `#f=${nova.id}`;
    } catch (e) { $('nvOk').disabled = false; alert(e.message); }
  };
}

function modalDevolver() {
  abreModal('Devolver à loja', `
    <div class="fa-grid">
      <div class="fa-campo"><label>O que precisa corrigir</label>
        <textarea id="dvMotivo" rows="3" maxlength="300" placeholder="Ex.: CPF com 10 dígitos; faltou a data de nascimento do dependente"></textarea>
        <span class="dica">A gerente lê isto no topo da ficha.</span></div>
    </div>
    <div class="fa-modal-pe">
      <button class="fa-btn" id="dvCancelar">Cancelar</button>
      <button class="fa-btn solido" id="dvOk">Devolver</button>
    </div>`);
  $('dvMotivo').focus();
  $('dvCancelar').onclick = fechaModal;
  $('dvOk').onclick = () => {
    const motivo = $('dvMotivo').value.trim();
    if (!motivo) { $('dvMotivo').focus(); return; }
    fechaModal();
    transicao('devolver', { motivo });
  };
}

// ══════════════════════════════════════════════════════════════════════════
// O PAPEL
// ══════════════════════════════════════════════════════════════════════════
function imprimir() {
  const f = S.atual;
  const d = S.atual.status === 'recebida' ? (f.dados || {}) : lerFormulario();
  $('papel').innerHTML = papelHtml(f, d);
  window.print();
}

function papelHtml(f, d) {
  const v  = k => esc(d[k] || '');
  const dt = k => esc(fDataCampo(d[k]));
  const campo = (rot, k, cls = '') => `<span class="p-f ${cls}"><span class="p-l">${rot}</span><span class="p-v">${v(k)}</span></span>`;
  const data  = (rot, k, cls = '') => `<span class="p-f fixo ${cls}"><span class="p-l">${rot}</span><span class="p-v data">${dt(k) || '&nbsp;&nbsp;&nbsp;&nbsp;/&nbsp;&nbsp;&nbsp;&nbsp;/'}</span></span>`;
  const hora  = (rot, k) => `<span class="p-f fixo"><span class="p-l">${rot}</span><span class="p-v hora">${v(k) || ':'}</span></span>`;
  const marca = (rot, ligado) => `<span class="p-marca">(<b>${ligado ? 'X' : '&nbsp;'}</b>) ${rot}</span>`;
  const deps = Array.from({ length: DEP_MAX }, (_, i) => (d.dependentes || [])[i] || {});
  const def = d.deficiencia || '';

  return `
    <div class="p-cab"><h1>Ficha de Registro</h1><small>${esc(f.loja)} · ficha nº ${f.id}</small></div>
    <div class="p-r">
      <span class="p-f"><span class="p-l">Empregador:</span><span class="p-v">${esc(f.empresa.razaoSocial || f.empresa.apelido)}</span></span>
      <span class="p-f fixo" style="flex-basis:190pt"><span class="p-l">CNPJ:</span><span class="p-v">${esc(f.empresa.cnpjFmt)}</span></span>
    </div>

    <div class="p-sec">Dados pessoais</div>
    <div class="p-r">${campo('Nome:', 'nome')}</div>
    <div class="p-r">${campo('RG:', 'rg')}${campo('CPF:', 'cpf')}</div>
    <div class="p-r">${data('Data de nascimento', 'nascimento')}${campo('Cidade de nascimento', 'cidadeNascimento')}</div>
    <div class="p-r">${campo('Nome do pai:', 'pai')}</div>
    <div class="p-r">${campo('Nome da mãe:', 'mae')}</div>
    <div class="p-r">${campo('Cel', 'celular', 'medio')}${campo('E-mail:', 'email')}</div>
    <div class="p-r">${campo('Grau de inst.', 'grauInstrucao')}${campo('Est. civil:', 'estadoCivil')}${campo('Raça/cor:', 'racaCor')}</div>
    <div class="p-r" style="flex-wrap:wrap;gap:4pt 0">
      <span class="p-l" style="margin-right:6pt">Pessoa com deficiência:</span>
      ${marca('Auditiva', def === 'Auditiva')}${marca('Física', def === 'Física')}${marca('Mental', def === 'Mental')}${marca('Múltipla', def === 'Múltipla')}${marca('Visual', def === 'Visual')}
      ${marca('Não portador', def === 'Não')}
      <span style="white-space:nowrap"><span class="p-l" style="margin:0 6pt 0 10pt">Reabilitado:</span>${marca('Sim', d.reabilitado === 'Sim')}${marca('Não', d.reabilitado === 'Não')}</span>
    </div>

    <div class="p-sec">Endereço</div>
    <div class="p-r">${campo('Rua, av.:', 'rua')}${campo('Nº', 'numero', 'curto')}</div>
    <div class="p-r">${campo('CEP:', 'cep', 'medio')}${campo('Bairro', 'bairro')}${campo('Cidade', 'cidade')}</div>

    <div class="p-sec">Dados profissionais <small>(sem estes dados a contabilidade não consegue dar continuidade ao registro)</small></div>
    <div class="p-r">${data('Data de admissão', 'dataAdmissao')}${campo('Função:', 'funcao')}</div>
    <div class="p-r">${campo('Salário R$', 'salario')}${campo('Adiantamento (%)', 'adiantamentoPct', 'medio')}</div>
    <div class="p-r">
      <span class="p-f fixo"><span class="p-l" style="margin-right:6pt">Vale-transporte:</span>${marca('Sim', d.valeTransporte === 'Sim')}${marca('Não', d.valeTransporte === 'Não')}</span>
      ${campo('Valor R$', 'vtValor')}${campo('Quant.', 'vtQuant', 'curto')}
    </div>
    <div class="p-r">
      <span class="p-f fixo"><span class="p-l" style="margin-right:6pt">Contrato de experiência:</span>${marca('30', d.contratoExp === '30')}${marca('45', d.contratoExp === '45')}${marca('90', d.contratoExp === '90')}<span class="p-l" style="font-weight:400;text-transform:none">dias</span></span>
      <span class="p-f"></span>
      ${hora('Horário de trabalho', 'horarioInicio')}${hora('às', 'horarioFim')}
    </div>

    <div class="p-sec">Dependentes <small>(filhos — salário-família e IRRF)</small></div>
    <table class="p-dep">
      <thead><tr><th style="width:52%">Nome do filho</th><th style="width:26%">CPF</th><th style="width:22%">Data de nascimento</th></tr></thead>
      <tbody>${deps.map(dp => `<tr><td>${esc(dp.nome || '')}</td><td>${esc(dp.cpf || '')}</td><td class="c">${esc(fDataCampo(dp.nascimento)) || '&nbsp;&nbsp;&nbsp;&nbsp;/&nbsp;&nbsp;&nbsp;&nbsp;/'}</td></tr>`).join('')}</tbody>
    </table>

    <div class="p-ass">
      <span class="p-f"><span class="p-l">Data</span><span class="p-v data">&nbsp;&nbsp;&nbsp;&nbsp;/&nbsp;&nbsp;&nbsp;&nbsp;/</span></span>
      <span class="p-f"><span class="p-l">Assinatura do empregado</span><span class="p-v"></span></span>
    </div>
    <div class="p-rod">Todas as informações serão enviadas ao eSocial / Receita Federal — preencha com letra legível e confira os documentos.</div>`;
}

// ── Início ─────────────────────────────────────────────────────────────────
carregar();
