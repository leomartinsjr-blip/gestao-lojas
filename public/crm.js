'use strict';
// Dashboard do CRM dentro do gestão. Os números vêm do app crm-lojas via
// /api/crm/dashboard; o servidor já recorta as lojas que o usuário pode ver.

const META = 0.9, PISO = 0.8;   // cadastro nas vendas: meta 90%, vermelho abaixo de 80%
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = n => (n || 0).toLocaleString('pt-BR');
const brl0 = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pct = (n, d) => d ? (n / d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—';
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dataBR = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = m => `${MESES[+m.slice(5, 7) - 1]}/${m.slice(2, 4)}`;

// Status da meta: classe de cor + palavra (a cor nunca vem sozinha)
const status = x => x == null ? ['', ''] : x >= META ? ['ok', 'na meta'] : x >= PISO ? ['aten', 'abaixo da meta'] : ['ruim', 'bem abaixo da meta'];
const taxaCadastro = (vendas, sem) => vendas ? 1 - sem / vendas : null;

const PERIODOS = {
  mes:     ['Este mês',    () => { const h = new Date(); return [iso(h).slice(0, 8) + '01', iso(h)]; }],
  passado: ['Mês passado', () => { const d = new Date(); d.setDate(0); return [iso(d).slice(0, 8) + '01', iso(d)]; }],
  d90:     ['90 dias',     () => { const h = new Date(), d = new Date(); d.setDate(d.getDate() - 89); return [iso(d), iso(h)]; }],
  d365:    ['12 meses',    () => { const h = new Date(), d = new Date(); d.setDate(d.getDate() - 364); return [iso(d), iso(h)]; }],
};

const S = { per: 'mes', lojas: [], ord: 'vendas', dir: -1, dados: null, rotulos: {} };
try { const p = new URLSearchParams(location.search); if (PERIODOS[p.get('p')]) S.per = p.get('p'); if (p.get('loja')) S.lojas = p.get('loja').split(','); } catch (_) {}

const corLoja = b => `var(--col-${b}, var(--muted))`;
const nomeLoja = b => S.rotulos[b] || String(b || '—').toUpperCase();
const pontoLoja = b => `<span class="ponto" style="background:${corLoja(b)}"></span>`;

async function carregar() {
  const [de, ate] = PERIODOS[S.per][1]();
  const qs = new URLSearchParams({ de, ate, ...(S.lojas.length ? { loja: S.lojas.join(',') } : {}) });
  history.replaceState(null, '', '?' + new URLSearchParams({ p: S.per, ...(S.lojas.length ? { loja: S.lojas.join(',') } : {}) }));
  $('conteudo').classList.add('carregando');
  try {
    const r = await fetch('/api/crm/dashboard?' + qs);
    if (r.status === 401) return (location.href = '/');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao carregar');
    S.dados = d;
    for (const l of d.lojas || []) S.rotulos[l.board] = l.label;
    desenhar();
  } catch (e) {
    $('conteudo').innerHTML = `<div class="card vazio erro">${esc(e.message)}</div>`;
  } finally {
    $('conteudo').classList.remove('carregando');
  }
}

function filtros() {
  const d = S.dados;
  const perm = d?.permitidas || [];
  $('filtros').innerHTML = Object.entries(PERIODOS).map(([id, [nome]]) =>
    `<button class="chip ${S.per === id ? 'on' : ''}" data-p="${id}">${nome}</button>`).join('')
    + (perm.length > 1 ? `<span class="sep"></span><button class="chip ${!S.lojas.length ? 'on' : ''}" data-l="">Todas</button>`
      + perm.map(b => `<button class="chip ${S.lojas.includes(b) ? 'on' : ''}" data-l="${esc(b)}">${pontoLoja(b)}${esc(nomeLoja(b))}</button>`).join('') : '');
  $('filtros').querySelectorAll('[data-p]').forEach(b => b.onclick = () => { S.per = b.dataset.p; carregar(); });
  $('filtros').querySelectorAll('[data-l]').forEach(b => b.onclick = () => {
    const l = b.dataset.l;
    S.lojas = !l ? [] : S.lojas.includes(l) ? S.lojas.filter(x => x !== l) : [...S.lojas, l];
    if (S.lojas.length === perm.length) S.lojas = [];
    carregar();
  });
}

function desenhar() {
  const d = S.dados;
  filtros();
  if (d.semLojas) {
    $('conteudo').innerHTML = '<div class="card vazio">Sua loja não tem vendas no Microvix, então não há dados do CRM para mostrar.</div>';
    return;
  }
  const lojasVistas = d.lojas.map(l => l.board);
  $('sub').textContent = `${dataBR(d.de)} a ${dataBR(d.ate)} · ${lojasVistas.length === 1 ? nomeLoja(lojasVistas[0]) : lojasVistas.length === (d.permitidas || []).length ? 'todas as lojas' : lojasVistas.map(nomeLoja).join(', ')}`;

  const vs = d.vendedores;
  const soma = k => vs.reduce((a, v) => a + (v[k] || 0), 0);
  const vendas = soma('vendas'), sem = soma('semCadastro');
  const tx = taxaCadastro(vendas, sem);
  const [cls, palavra] = status(tx);
  const publico = soma('publico'), contatados = soma('contatados'), compraram = soma('compraram'), comMsg = soma('compraramContatados');
  const semMsg = publico - contatados;

  $('conteudo').innerHTML = `
    <div class="kpis">
      <div class="kpi" title="Vendas lançadas com o cliente cadastrado. O resto foi em consumidor final ou sem cliente.">
        <div class="rot">Cadastro nas vendas · meta 90%</div>
        <div class="val ${cls}">${tx == null ? '—' : pct(vendas - sem, vendas)}</div>
        <div class="det">${tx == null ? 'sem vendas no período' : `<b class="${cls}">${palavra}</b> · ${int(sem)} de ${int(vendas)} vendas sem cadastro`}</div></div>
      <div class="kpi" title="Clientes das campanhas que receberam mensagem do vendedor">
        <div class="rot">Contatos feitos nas campanhas</div>
        <div class="val">${pct(contatados, publico)}</div>
        <div class="det">${int(contatados)} de ${int(publico)} clientes</div></div>
      <div class="kpi" title="Aniversariantes e pós-venda: na fila hoje, e os que passaram do prazo sem contato no período">
        <div class="rot">Fila de aniversário e pós-venda</div>
        <div class="val">${int(soma('agora'))}</div>
        <div class="det">para chamar hoje · <b class="${soma('atrasados') ? 'ruim' : ''}">${int(soma('atrasados'))} passaram do prazo</b></div></div>
      <div class="kpi" title="Clientes das campanhas que compraram. Comparar com e sem mensagem mostra se o contato traz venda.">
        <div class="rot">Compraram depois da campanha</div>
        <div class="val">${int(compraram)}</div>
        <div class="det">com mensagem ${pct(comMsg, contatados)} × sem ${pct(compraram - comMsg, semMsg)} · ${brl0(soma('faturamentoCamp'))}</div></div>
      <div class="kpi" title="Faturamento das vendas com cliente cadastrado">
        <div class="rot">Faturamento identificado</div>
        <div class="val">${brl0(soma('faturamentoIdent'))}</div>
        <div class="det">de ${brl0(soma('faturamento'))} vendidos</div></div>
    </div>

    <div class="grade2">
      <div class="card">${blocoBarras()}</div>
      <div class="card">${blocoMapa()}</div>
    </div>

    <div class="card">
      <h2>Ranking de vendedores</h2>
      <p class="nota">Clique no título de uma coluna para ordenar. “Já eram clientes”: atendidos no período que já tinham comprado antes. “Atrasados”: aniversário ou pós-venda que passou do prazo sem contato.</p>
      <div class="tabela fixa" id="ranking"></div>
    </div>

    <div class="card">
      <h2>Campanhas do período</h2>
      <p class="nota">Nas automáticas, contam os clientes que entraram na lista no período.</p>
      ${blocoCampanhas()}
    </div>`;
  desenharRanking();
  // No celular o mapa não cabe: abre já nos meses mais recentes
  const mapa = document.querySelector('.mapa')?.parentElement;
  if (mapa) mapa.scrollLeft = mapa.scrollWidth;
}

// Cadastro por loja (ou por vendedor, quando é uma loja só), com a meta marcada
function blocoBarras() {
  const d = S.dados;
  const umaLoja = d.lojas.length === 1;
  const itens = umaLoja
    ? d.vendedores.filter(v => v.vendas).sort((a, b) => b.vendas - a.vendas).slice(0, 14).map(v => ({ nome: v.nome, board: v.board, vendas: v.vendas, sem: v.semCadastro }))
    : d.porLoja.slice().sort((a, b) => taxaCadastro(b.vendas, b.semCadastro) - taxaCadastro(a.vendas, a.semCadastro)).map(l => ({ nome: nomeLoja(l.board), board: l.board, vendas: l.vendas, sem: l.semCadastro }));
  if (!itens.length) return '<h2>Cadastro nas vendas</h2><div class="vazio">Sem vendas no período.</div>';
  return `<h2>Cadastro nas vendas ${umaLoja ? 'por vendedor' : 'por loja'}</h2>
    <p class="nota">% das vendas com o cliente cadastrado.</p>
    <div class="barras">${itens.map(i => {
      const x = taxaCadastro(i.vendas, i.sem);
      const [cls, palavra] = status(x);
      return `<div class="barra" title="${esc(i.nome)}: ${pct(i.vendas - i.sem, i.vendas)} (${palavra}) · ${int(i.sem)} de ${int(i.vendas)} vendas sem cadastro">
        <span class="nome">${umaLoja ? '' : pontoLoja(i.board)}${esc(i.nome)}</span>
        <div class="trilho"><div class="enche" style="width:${(x * 100).toFixed(1)}%;background:var(--${cls === 'ok' ? 'up' : cls === 'aten' ? 'warn' : 'down'})"></div><i class="meta"></i></div>
        <span class="v n ${cls}">${pct(i.vendas - i.sem, i.vendas)}</span></div>`;
    }).join('')}</div>
    <div class="legenda-meta"><i></i> meta 90% · <b class="ok">verde</b> na meta, <b class="aten">amarelo</b> de 80% a 90%, <b class="ruim">vermelho</b> abaixo de 80%</div>`;
}

// Mês × loja, 12 meses: cada célula com o % escrito
function blocoMapa() {
  const d = S.dados;
  const meses = [...new Set(d.porMes.map(m => m.mes))].sort();
  if (!meses.length) return '<h2>Cadastro mês a mês</h2><div class="vazio">Sem vendas nos últimos 12 meses.</div>';
  const por = {};
  for (const m of d.porMes) (por[m.board] ||= {})[m.mes] = m;
  const totalMes = Object.fromEntries(meses.map(mes => {
    const xs = d.porMes.filter(m => m.mes === mes);
    return [mes, { vendas: xs.reduce((a, m) => a + m.vendas, 0), semCadastro: xs.reduce((a, m) => a + m.semCadastro, 0) }];
  }));
  const cel = (m, rot) => {
    if (!m || !m.vendas) return '<td class="cel vazia">—</td>';
    const x = taxaCadastro(m.vendas, m.semCadastro);
    const [cls, palavra] = status(x);
    return `<td class="cel ${cls}" title="${esc(rot)}: ${pct(m.vendas - m.semCadastro, m.vendas)} (${palavra}) · ${int(m.semCadastro)} de ${int(m.vendas)} vendas sem cadastro">${Math.round(x * 100)}</td>`;
  };
  const lojas = d.lojas.map(l => l.board);
  return `<h2>Cadastro mês a mês</h2>
    <p class="nota">% das vendas com cliente cadastrado em cada mês. Passe o mouse para ver o detalhe.</p>
    <div class="tabela fixa"><table class="mapa">
      <thead><tr><th>Loja</th>${meses.map(m => `<th>${nomeMes(m)}</th>`).join('')}</tr></thead>
      <tbody>
        ${lojas.map(b => `<tr><td>${pontoLoja(b)} ${esc(nomeLoja(b))}</td>${meses.map(m => cel(por[b]?.[m], `${nomeLoja(b)} em ${nomeMes(m)}`)).join('')}</tr>`).join('')}
        ${lojas.length > 1 ? `<tr><td><b>Total</b></td>${meses.map(m => cel(totalMes[m], `Total em ${nomeMes(m)}`)).join('')}</tr>` : ''}
      </tbody></table></div>`;
}

function blocoCampanhas() {
  const cs = S.dados.campanhas;
  if (!cs.length) return '<div class="vazio">Nenhuma campanha no período.</div>';
  const SIT = { ativa: 'Ativa', agendada: 'Agendada', encerrada: 'Encerrada' };
  const ICONE = { aniversario: '🎂 ', posvenda: '🛍️ ' };
  return `<div class="tabela fixa"><table>
    <thead><tr><th>Campanha</th><th>Situação</th><th class="n">Recebeu</th><th class="n">Mandou mensagem</th><th class="n">Compraram</th><th class="n">Faturamento</th></tr></thead>
    <tbody>${cs.map(c => `<tr>
      <td><b>${ICONE[c.auto] || ''}${esc(c.nome)}</b>${c.auto ? ' <span class="tag">automática</span>' : ` <span class="tag">${dataBR(c.inicio)} a ${dataBR(c.fim)}</span>`}</td>
      <td>${SIT[c.situacao] || esc(c.situacao)}</td>
      <td class="n">${int(c.publico)}</td>
      <td class="n">${int(c.contatados)} <span class="tag">${pct(c.contatados, c.publico)}</span></td>
      <td class="n">${int(c.compraram)} <span class="tag">${pct(c.compraram, c.publico)}</span></td>
      <td class="n">${brl0(c.faturamento)}</td></tr>`).join('')}</tbody></table></div>`;
}

// Ranking: uma linha por vendedor, juntando cadastro, carteira e campanhas
const COLS = [
  { id: 'nome',      rot: 'Vendedor',          val: v => v.nome, txt: true },
  { id: 'board',     rot: 'Loja',              val: v => nomeLoja(v.board), txt: true },
  { id: 'vendas',    rot: 'Vendas',            val: v => v.vendas },
  { id: 'cadastro',  rot: 'Cadastro',          val: v => taxaCadastro(v.vendas, v.semCadastro) ?? -1 },
  { id: 'clientes',  rot: 'Clientes',          val: v => v.clientes },
  { id: 'recompra',  rot: 'Já eram clientes',  val: v => v.clientes ? v.recompra / v.clientes : -1 },
  { id: 'publico',   rot: 'Recebeu (camp.)',   val: v => v.publico },
  { id: 'contato',   rot: 'Contatou',          val: v => v.publico ? v.contatados / v.publico : -1 },
  { id: 'agora',     rot: 'Fila hoje',         val: v => v.agora },
  { id: 'atrasados', rot: 'Atrasados',         val: v => v.atrasados },
  { id: 'compraram', rot: 'Compraram (camp.)', val: v => v.compraram },
  { id: 'fat',       rot: 'Fat. identificado', val: v => v.faturamentoIdent },
];

function desenharRanking() {
  const col = COLS.find(c => c.id === S.ord) || COLS[2];
  const linhas = S.dados.vendedores.filter(v => v.vendas || v.publico || v.agora)
    .sort((a, b) => {
      if ((a.empId == null) !== (b.empId == null)) return a.empId == null ? 1 : -1;   // "Sem vendedor" no fim
      const x = col.val(a), y = col.val(b);
      return (col.txt ? String(x).localeCompare(String(y)) : x - y) * S.dir;
    });
  if (!linhas.length) { $('ranking').innerHTML = '<div class="vazio">Nenhum vendedor com vendas ou campanha no período.</div>'; return; }
  $('ranking').innerHTML = `<table>
    <thead><tr>${COLS.map(c => `<th data-ord="${c.id}" class="${c.txt ? '' : 'n'} ${c.id === col.id ? 'ordenado' : ''}">${c.rot}${c.id === col.id ? (S.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map(v => {
      const tx = taxaCadastro(v.vendas, v.semCadastro);
      const [cls, palavra] = status(tx);
      return `<tr class="${v.inativo ? 'inativo' : ''}">
        <td><b>${esc(v.nome)}</b>${v.inativo ? ' <span class="tag">saiu</span>' : ''}</td>
        <td>${pontoLoja(v.board)} ${esc(nomeLoja(v.board))}</td>
        <td class="n">${int(v.vendas)}</td>
        <td class="n" title="${tx == null ? '' : `${palavra} · ${int(v.semCadastro)} de ${int(v.vendas)} vendas sem cadastro`}"><b class="${cls}">${tx == null ? '—' : pct(v.vendas - v.semCadastro, v.vendas)}</b></td>
        <td class="n">${int(v.clientes)}</td>
        <td class="n">${pct(v.recompra, v.clientes)}</td>
        <td class="n">${int(v.publico)}</td>
        <td class="n">${v.publico ? `${int(v.contatados)} <span class="tag">${pct(v.contatados, v.publico)}</span>` : '—'}</td>
        <td class="n">${int(v.agora)}</td>
        <td class="n ${v.atrasados ? 'ruim' : ''}">${int(v.atrasados)}</td>
        <td class="n">${v.publico ? `${int(v.compraram)} <span class="tag">${pct(v.compraram, v.publico)}</span>` : '—'}</td>
        <td class="n">${brl0(v.faturamentoIdent)}</td></tr>`;
    }).join('')}</tbody></table>`;
  $('ranking').querySelectorAll('[data-ord]').forEach(th => th.onclick = () => {
    const id = th.dataset.ord;
    if (S.ord === id) S.dir = -S.dir;
    else { S.ord = id; S.dir = COLS.find(c => c.id === id).txt ? 1 : -1; }
    desenharRanking();
  });
}

carregar();
