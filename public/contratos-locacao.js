// Tela de Contratos de Locação. A faixa de urgência de cada contrato vem pronta
// do servidor (services/contratosLocacao.js): aqui só se desenha e se edita.

const GRUPOS = [
  { id: 'atraso', titulo: 'Vencidos ou prazo perdido', resumo: 'Vencidos ou prazo perdido', cls: 'f-atraso', faixas: ['vencido', 'prazo'] },
  { id: 'm3',     titulo: 'Até 3 meses',               resumo: 'Até 3 meses',               cls: 'f-m3',     faixas: ['m3'] },
  { id: 'm6',     titulo: 'Até 6 meses',               resumo: 'Até 6 meses',               cls: 'f-m6',     faixas: ['m6'] },
  { id: 'ok',     titulo: 'Em dia',                    resumo: 'Em dia',                    cls: 'f-ok',     faixas: ['ok'] },
];
const SITUACAO_LABEL = { em_negociacao: 'Em negociação', nao_renovar: 'Não vamos renovar' };

let lojas = {};
let contratos = [];
let filtro = null;
let busca = '';
let editId = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtData = iso => iso ? iso.split('-').reverse().join('/') : '—';
const fmtValor = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const nomeLoja = c => lojas[c.loja] || c.loja;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

async function carregar() {
  try {
    const r = await api('GET', '/api/contratos-locacao');
    lojas = r.lojas;
    contratos = r.contratos;
    render();
  } catch (e) {
    $('clLista').innerHTML = `<div class="cl-vazio">Não foi possível carregar: ${esc(e.message)}</div>`;
  }
}

function tempo(dias) {
  if (dias === 1) return '1 dia';
  if (dias <= 60) return `${dias} dias`;
  return `${Math.round(dias / 30.44)} meses`;
}

function selo(c) {
  const atraso = tempo(Math.abs(c.dias));
  if (c.faixa === 'vencido') return `Vencido há ${atraso}`;
  if (c.faixa === 'prazo')   return `Prazo de negociar passou há ${atraso}`;
  const oQue = c.marco === 'prazo' ? 'Negociar' : 'Vence';
  return c.dias === 0 ? `${oQue} hoje` : `${oQue} em ${tempo(c.dias)}`;
}

function filtrados() {
  const q = busca.toLowerCase();
  return contratos.filter(c => !q ||
    [nomeLoja(c), c.shopping, c.condicoes, c.obs].some(t => (t || '').toLowerCase().includes(q)));
}

function cartao(c, grupo) {
  const cor = `var(--col-${c.loja}, var(--muted))`;
  const quem = c.atualizadoPor
    ? `Atualizado por ${esc(c.atualizadoPor)} em ${new Date(c.atualizadoEm).toLocaleDateString('pt-BR')}`
    : `Cadastrado por ${esc(c.criadoPor)} em ${new Date(c.criadoEm).toLocaleDateString('pt-BR')}`;
  return `<div class="cl-card ${grupo.cls}">
    <div>
      <div class="cl-nome">
        <span class="cl-tarja" style="background:${cor}"></span>
        <span class="cl-loja">${esc(nomeLoja(c))}</span>
        <span class="cl-shop">${esc(c.shopping)}</span>
        ${SITUACAO_LABEL[c.situacao] ? `<span class="cl-chip">${SITUACAO_LABEL[c.situacao]}</span>` : ''}
      </div>
      <div class="cl-datas">
        <span class="cl-dado">Início<b>${fmtData(c.inicio)}</b></span>
        <span class="cl-dado">Fim<b>${fmtData(c.fim)}</b></span>
        <span class="cl-dado">Negociar até<b>${fmtData(c.prazoNegociacao)}</b></span>
        ${c.aluguel != null ? `<span class="cl-dado">Aluguel<b>${fmtValor(c.aluguel)}</b></span>` : ''}
      </div>
      ${c.condicoes ? `<div class="cl-nota">${esc(c.condicoes)}</div>` : ''}
      ${c.obs ? `<div class="cl-nota">${esc(c.obs)}</div>` : ''}
      <div class="cl-audit">${quem}</div>
    </div>
    <div class="cl-lado">
      <span class="cl-badge">${selo(c)}</span>
      <span class="cl-acoes">
        <button class="cl-btn mini" data-editar="${esc(c.id)}">Editar</button>
        <button class="cl-btn mini" data-remover="${esc(c.id)}">Remover</button>
      </span>
    </div>
  </div>`;
}

function render() {
  const lista = filtrados();
  $('clResumo').innerHTML = GRUPOS.map(g => {
    const n = contratos.filter(c => g.faixas.includes(c.faixa)).length;
    return `<button class="cl-sum ${g.cls}" data-filtro="${g.id}" aria-pressed="${filtro === g.id}">
      <span class="cl-sum-n">${n}</span><span class="cl-sum-l">${g.resumo}</span>
    </button>`;
  }).join('');

  if (!contratos.length) {
    $('clLista').innerHTML = `<div class="cl-vazio">Nenhum contrato cadastrado ainda.<br><button class="cl-btn solido" data-novo>+ Cadastrar o primeiro</button></div>`;
    return;
  }
  const html = GRUPOS.filter(g => !filtro || g.id === filtro).map(g => {
    const doGrupo = lista.filter(c => g.faixas.includes(c.faixa));
    if (!doGrupo.length) return '';
    return `<h2 class="cl-grupo-t">${g.titulo} (${doGrupo.length})</h2>` + doGrupo.map(c => cartao(c, g)).join('');
  }).join('');
  $('clLista').innerHTML = html || '<div class="cl-vazio">Nenhum contrato encontrado.</div>';
}

// ── Modal ──────────────────────────────────────────────────────────────────
function abrirModal(c) {
  editId = c ? c.id : null;
  $('clModalT').textContent = c ? 'Editar contrato' : 'Novo contrato';
  $('fLoja').innerHTML = '<option value="">— selecione —</option>' +
    Object.entries(lojas).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  $('clShoppings').innerHTML = [...new Set(contratos.map(x => x.shopping))]
    .map(s => `<option value="${esc(s)}"></option>`).join('');
  $('fLoja').value      = c?.loja || '';
  $('fShopping').value  = c?.shopping || '';
  $('fInicio').value    = c?.inicio || '';
  $('fFim').value       = c?.fim || '';
  $('fPrazo').value     = c?.prazoNegociacao || '';
  $('fSituacao').value  = c?.situacao || 'nao_iniciada';
  $('fAluguel').value   = c?.aluguel ?? '';
  $('fCondicoes').value = c?.condicoes || '';
  $('fObs').value       = c?.obs || '';
  $('clErro').textContent = '';
  $('clOverlay').hidden = false;
  $('fLoja').focus();
}
function fecharModal() { $('clOverlay').hidden = true; }

// Mesma conta do servidor: 6 meses de calendário, sem estourar o fim do mês
function seisMesesAntes(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 7, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

async function salvar(ev) {
  ev.preventDefault();
  const body = {
    loja: $('fLoja').value, shopping: $('fShopping').value,
    inicio: $('fInicio').value, fim: $('fFim').value, prazoNegociacao: $('fPrazo').value,
    situacao: $('fSituacao').value, aluguel: $('fAluguel').value,
    condicoes: $('fCondicoes').value, obs: $('fObs').value,
  };
  const btn = $('clSalvar');
  btn.disabled = true;
  try {
    if (editId) await api('PUT', `/api/contratos-locacao/${editId}`, body);
    else await api('POST', '/api/contratos-locacao', body);
    fecharModal();
    await carregar();
  } catch (e) {
    $('clErro').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function remover(c) {
  if (!confirm(`Remover o contrato de ${nomeLoja(c)} (${c.shopping})?`)) return;
  try {
    await api('DELETE', `/api/contratos-locacao/${c.id}`);
    await carregar();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ── Eventos ────────────────────────────────────────────────────────────────
$('clResumo').addEventListener('click', e => {
  const b = e.target.closest('[data-filtro]');
  if (!b) return;
  filtro = filtro === b.dataset.filtro ? null : b.dataset.filtro;
  render();
});
$('clLista').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if ('novo' in t.dataset) return abrirModal();
  const c = contratos.find(x => x.id === (t.dataset.editar || t.dataset.remover));
  if (!c) return;
  if (t.dataset.editar) abrirModal(c); else remover(c);
});
$('clBusca').addEventListener('input', e => { busca = e.target.value; render(); });
$('clNovo').addEventListener('click', () => abrirModal());
$('clCancelar').addEventListener('click', fecharModal);
$('clForm').addEventListener('submit', salvar);
$('clOverlay').addEventListener('mousedown', e => { if (e.target === $('clOverlay')) fecharModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModal(); });
$('fPrazo6').addEventListener('click', () => {
  if (!$('fFim').value) { $('clErro').textContent = 'Preencha o fim do contrato primeiro.'; return; }
  $('clErro').textContent = '';
  $('fPrazo').value = seisMesesAntes($('fFim').value);
});

fetch('/api/me').then(r => r.json()).then(u => { $('clUser').textContent = u.label || u.username || ''; }).catch(() => {});
carregar();
