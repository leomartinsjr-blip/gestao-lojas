// ── Pauta de Reunião Mensal ──────────────────────────────────────────────────
// Uma pauta por loja, por mês. Os números não se digitam: vêm do sistema.
// O que se escreve aqui é o que a conversa produziu.

const PAUTA_LOJAS = {
  delrey:   'DEL REY',
  minas:    'MINAS',
  contagem: 'CONTAGEM',
  estacao:  'ESTAÇÃO',
  tommy:    'TOMMY',
  lez:      'LEZ A LEZ',
};

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

const fBRL  = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fBRL2 = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fNum  = v => Number(v || 0).toLocaleString('pt-BR');
const fDec  = (v, c = 2) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const fPct  = v => v == null ? '—' : v.toFixed(1) + '%';
const fData = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '—';
const fCurto = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  board: 'delrey',
  me: null,
  pauta: null,
  dados: null,
  label: '',
  produtos: null,
};

// ── Toast ────────────────────────────────────────────────────────────────────
let _toastT = null;
function toast(msg, erro) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'pa-toast on' + (erro ? ' err' : '');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { el.className = 'pa-toast' + (erro ? ' err' : ''); }, 2600);
}

function erro(msg) {
  const el = $('errBox');
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.style.display = '';
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { window.location.href = '/'; throw new Error('Não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}

// ── Autosave ─────────────────────────────────────────────────────────────────
let _saveT = null, _saving = false;
function queueSave() {
  clearTimeout(_saveT);
  _saveT = setTimeout(salvar, 700);
}

async function salvar() {
  if (!S.pauta || _saving) return;
  clearTimeout(_saveT); _saveT = null;
  _saving = true;
  $('saving').classList.add('on');
  try {
    const p = S.pauta;
    const salvo = await api('PUT', `/api/pauta/${S.year}/${S.month}/${S.board}`, {
      participantes: p.participantes,
      realizadaEm:   p.realizadaEm,
      comentarios:   p.comentarios,
      vendedorNotas: p.vendedorNotas,
      rhItens:       p.rhItens,
      demandas:      p.demandas,
      acoes:         p.acoes,
      estoqueManual: p.estoqueManual,
      produtosResumo: p.produtosResumo,
    });
    S.pauta.updatedAt = salvo.updatedAt;
    S.pauta.updatedBy = salvo.updatedBy;
    renderRodape();
  } catch (e) {
    toast('Não salvou: ' + e.message, true);
  } finally {
    _saving = false;
    $('saving').classList.remove('on');
  }
}

// ── Carga ────────────────────────────────────────────────────────────────────
async function carregar() {
  clearTimeout(_saveT); _saveT = null;
  erro('');
  $('loading').style.display = '';
  $('content').style.display = 'none';
  S.produtos = null;
  try {
    const r = await api('GET', `/api/pauta/${S.year}/${S.month}/${S.board}`);
    S.pauta = r.pauta;
    S.dados = r.dados;
    S.label = r.label;
    if (!S.pauta.comentarios) S.pauta.comentarios = { performance: '', vendedores: '', rh: '', produtos: '' };
    if (!S.pauta.vendedorNotas) S.pauta.vendedorNotas = {};
    if (!Array.isArray(S.pauta.rhItens))  S.pauta.rhItens  = [];
    if (!Array.isArray(S.pauta.demandas)) S.pauta.demandas = [];
    if (!Array.isArray(S.pauta.acoes))    S.pauta.acoes    = [];
    renderTudo();
    $('loading').style.display = 'none';
    $('content').style.display = '';
  } catch (e) {
    $('loading').style.display = 'none';
    erro(e.message);
  }
}

function renderTudo() {
  renderCabecalho();
  renderLoja();
  renderVendedores();
  renderHistorico();
  renderMedia3M();
  renderRH();
  renderPendencias();
  renderLista('demandas');
  renderLista('acoes');
  renderProdutos();
  renderEstoqueManual();
  renderRoteiro();
  renderRodape();
}

// ── Cabeçalho ────────────────────────────────────────────────────────────────
function renderCabecalho() {
  $('mesLabel').textContent = `${MESES[S.month - 1]}/${S.year}`;
  const st = S.pauta.status === 'realizada' ? 'realizada' : (S.pauta.createdAt ? 'rascunho' : 'nova');
  const badge = $('statusBadge');
  badge.className = 'pa-badge ' + st;
  badge.textContent = st === 'realizada' ? 'Realizada ' + fCurto(S.pauta.realizadaEm) : st === 'rascunho' ? 'Rascunho' : 'Não iniciada';
  const btn = $('btnFechar');
  if (S.pauta.status === 'realizada') {
    btn.textContent = 'Reabrir';
    btn.className = 'pa-btn ghost';
  } else {
    btn.textContent = 'Fechar reunião';
    btn.className = 'pa-btn ok';
  }
}

function renderRodape() {
  $('realizadaEm').value   = S.pauta.realizadaEm || '';
  $('participantes').value = S.pauta.participantes || '';
  $('updatedInfo').textContent = S.pauta.updatedAt
    ? `Última alteração ${new Date(S.pauta.updatedAt).toLocaleString('pt-BR')}${S.pauta.updatedBy ? ' por ' + S.pauta.updatedBy : ''}`
    : '';
}

// ── 1 · Performance da loja ──────────────────────────────────────────────────
function varHtml(v) {
  if (v == null) return '<span class="mut">—</span>';
  const cls = v >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

function renderLoja() {
  const d = S.dados.loja;
  const emCurso = !d.fechado;
  $('perfSub').textContent = `${S.label} · ${MESES[S.month - 1]}/${S.year}`
    + (emCurso ? ` · mês em curso, dados até ${fCurto(d.corte)}` : ' · mês fechado');

  const pctBase = emCurso ? d.pctProj : d.pct;
  const pctCls  = pctBase == null ? 'mut' : pctBase >= 100 ? 'pos' : pctBase >= 85 ? 'warn' : 'neg';
  const base    = d.base ?? d.projecao ?? d.venda;

  const kpis = [
    { l: 'Meta', v: d.meta ? fBRL(d.meta) : '—', s: d.meta ? '' : 'meta não lançada' },
    { l: emCurso ? `Realizado até ${fCurto(d.corte)}` : 'Faturado',
      v: fBRL(d.venda),
      s: `${d.diasComVenda} dia${d.diasComVenda === 1 ? '' : 's'} com venda · ${d.fonte}` },
    ...(emCurso ? [{
      l: 'Projeção do mês', c: 'blue',
      v: d.projecao == null ? '—' : fBRL(d.projecao),
      s: `no ritmo de ${fDec(d.pesoAcum, 0)}% do mês` }] : []),
    { l: emCurso ? '% da meta (proj.)' : '% da meta',
      v: fPct(pctBase), c: pctCls,
      s: d.meta && base ? fBRL(base - d.meta) + ' vs meta' : '' },
    { l: `vs ${MESES[d.anterior.month - 1]}/${String(d.anterior.year).slice(2)}`,
      v: varHtml(d.varAnterior), raw: true,
      s: d.anterior.venda ? fBRL(d.anterior.venda) : 'sem base' },
    { l: `vs ${MESES[S.month - 1]}/${String(d.anoAnterior.year).slice(2)}`,
      v: varHtml(d.varAnoAnterior), raw: true,
      s: d.anoAnterior.venda ? fBRL(d.anoAnterior.venda) : 'sem base' },
    { l: 'Peças', v: fNum(d.pecas), s: emCurso && d.projPecas ? `proj. ${fNum(d.projPecas)}` : '' },
    { l: 'Atendimentos', v: fNum(d.atend), s: d.atend ? '' : 'não lançados' },
    { l: 'PA', v: fDec(d.pa), s: 'peças / atendimento' },
    { l: 'Ticket médio', v: d.tm == null ? '—' : fBRL2(d.tm) },
    { l: 'Conversão', v: fPct(d.conv), s: d.convFonte || 'sem dado' },
    { l: 'Fluxo de porta', v: d.fluxo ? fNum(d.fluxo) : '—' },
  ];

  $('lojaKpis').innerHTML = kpis.map(k => `
    <div class="pa-kpi">
      <div class="pa-kpi-lbl">${esc(k.l)}</div>
      <div class="pa-kpi-val ${k.c || ''}">${k.raw ? k.v : esc(k.v)}</div>
      ${k.s ? `<div class="pa-kpi-sub">${esc(k.s)}</div>` : ''}
    </div>`).join('')
    + (emCurso ? `<div class="pa-legend" style="grid-column:1/-1;margin-top:.1rem">
        Projeção = realizado ÷ peso do mês já corrido. As comparações com o mês anterior e com o ano passado usam a projeção — meses fechados só se comparam com fechamento.
      </div>` : '');

  $('cmtPerformance').value = S.pauta.comentarios.performance || '';
}

// ── 2 · Vendedores ───────────────────────────────────────────────────────────
// Prêmio semanal já ganho no mês, por vendedor. O total vem do mesmo cálculo
// da folha; o title abre semana a semana para quando a gerente contestar.
function premioDe(id) {
  return (S.dados.premiacoes?.porEmp || {})[id] || { individual: 0, loja: 0, total: 0, semanas: 0, detalhe: [] };
}

function premioCell(id) {
  const pr = premioDe(id);
  if (!pr.total) return '<span class="mut">—</span>';
  const linhas = pr.detalhe.map(d => {
    const partes = [];
    if (d.individual) partes.push(`meta ${fBRL(d.individual)}`);
    if (d.loja)       partes.push(`loja ${fBRL(d.loja)}`);
    return `${d.label}: ${partes.join(' + ')}`;
  });
  return `<span class="pos" title="${esc(linhas.join(' · '))}">${fBRL(pr.total)}</span>`;
}

function renderVendedores() {
  const vs = S.dados.vendedores;
  const emCurso = !S.dados.loja.fechado;
  const premLoja = vs.reduce((a, v) => a + premioDe(v.id).total, 0);
  const semanas = S.dados.premiacoes?.semanas || 0;
  $('vendSub').textContent = `${vs.length} ativo${vs.length === 1 ? '' : 's'}`
    + (emCurso ? ` · % pela projeção` : '')
    + ` · ${fBRL(premLoja)} em prêmios semanais`
    + ` (${semanas} semana${semanas === 1 ? '' : 's'} encerrada${semanas === 1 ? '' : 's'})`;

  if (!vs.length) {
    $('vendTbl').innerHTML = '<tbody><tr><td class="pa-empty">Nenhum colaborador ativo nesta loja.</td></tr></tbody>';
  } else {
    const tot = vs.reduce((a, v) => ({
      meta:  a.meta  + v.meta,
      venda: a.venda + v.venda,
      proj:  a.proj  + (v.projecao || 0),
      pecas: a.pecas + v.pecas,
      atend: a.atend + v.atend,
    }), { meta: 0, venda: 0, proj: 0, pecas: 0, atend: 0 });

    $('vendTbl').innerHTML = `
      <thead><tr>
        <th>Vendedor</th><th class="num">Meta</th>
        <th class="num">${emCurso ? 'Realizado' : 'Faturado'}</th>
        ${emCurso ? '<th class="num">Projeção</th>' : ''}
        <th class="num">${emCurso ? '% proj.' : '%'}</th>
        <th class="num">vs loja</th>
        <th class="num">Peças</th><th class="num">Atend.</th><th class="num">PA</th><th class="num">Ticket</th><th class="num">Conv.</th>
        <th class="num">Prêmios</th>
        <th>Nota da reunião</th>
      </tr></thead>
      <tbody>${vs.map(v => {
        const pct = emCurso ? v.pctProj : v.pct;
        const cls = pct == null ? 'mut' : pct >= 100 ? 'pos' : pct >= 85 ? 'warn' : 'neg';
        return `<tr>
          <td>${esc(v.nome)}${v.gerente ? '<span class="pa-tag ger">gerente</span>' : ''}${v.diasFerias ? `<span class="pa-tag fer">${v.diasFerias}d férias</span>` : ''}</td>
          <td class="num">${v.meta ? fBRL(v.meta) : '—'}</td>
          <td class="num">${fBRL(v.venda)}</td>
          ${emCurso ? `<td class="num blue">${v.projecao == null ? '—' : fBRL(v.projecao)}</td>` : ''}
          <td class="num ${cls}">${fPct(pct)}</td>
          <td class="num ${v.delta == null ? 'mut' : v.delta >= 0 ? 'pos' : 'neg'}">${v.delta == null ? '—' : (v.delta >= 0 ? '+' : '') + v.delta.toFixed(0) + ' pp'}</td>
          <td class="num">${fNum(v.pecas)}</td>
          <td class="num">${fNum(v.atend)}</td>
          <td class="num">${fDec(v.pa)}</td>
          <td class="num">${v.tm == null ? '—' : fBRL(v.tm)}</td>
          <td class="num">${fPct(v.conv)}</td>
          <td class="num">${premioCell(v.id)}</td>
          <td><input class="pa-nota-inp" data-vend="${v.id}" value="${esc(S.pauta.vendedorNotas[v.id] || '')}" placeholder="—"></td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr>
        <td>Total</td>
        <td class="num">${tot.meta ? fBRL(tot.meta) : '—'}</td>
        <td class="num">${fBRL(tot.venda)}</td>
        ${emCurso ? `<td class="num blue">${tot.proj ? fBRL(tot.proj) : '—'}</td>` : ''}
        <td class="num">${tot.meta ? fPct((emCurso ? tot.proj : tot.venda) / tot.meta * 100) : '—'}</td>
        <td class="num">—</td>
        <td class="num">${fNum(tot.pecas)}</td>
        <td class="num">${fNum(tot.atend)}</td>
        <td class="num">${tot.atend ? fDec(tot.pecas / tot.atend) : '—'}</td>
        <td class="num">${tot.atend ? fBRL(tot.venda / tot.atend) : '—'}</td>
        <td class="num">—</td>
        <td class="num">${premLoja ? fBRL(premLoja) : '—'}</td><td></td>
      </tr></tfoot>`;

    $('vendTbl').querySelectorAll('[data-vend]').forEach(inp => {
      inp.addEventListener('input', () => {
        S.pauta.vendedorNotas[inp.dataset.vend] = inp.value;
        queueSave();
      });
    });
  }
  $('cmtVendedores').value = S.pauta.comentarios.vendedores || '';
}

// ── 3 · Histórico dos últimos meses ──────────────────────────────────────────
// A leitura que importa: o % do vendedor contra o % que a loja fez no mesmo
// mês. Acima da loja, puxou; abaixo, foi puxado.
function deltaCell(pct, delta) {
  if (pct == null) return '<td class="num mut">—</td>';
  if (delta == null) return `<td class="num">${fPct(pct)}</td>`;
  const cls = delta >= 0 ? 'pos' : 'neg';
  return `<td class="num">${fPct(pct)}<div class="hist-delta ${cls}">${delta >= 0 ? '+' : ''}${delta.toFixed(0)} pp</div></td>`;
}

function renderHistorico() {
  const hist = S.dados.historico || [];
  const d = S.dados.loja;
  const emCurso = !d.fechado;
  const pctAtual = emCurso ? d.pctProj : d.pct;

  const cols = [
    ...hist.map(h => ({ year: h.year, month: h.month, pct: h.loja.pct, atual: false })),
    { year: S.year, month: S.month, pct: pctAtual, atual: true },
  ];

  // Uma linha por vendedor que apareceu em qualquer um dos meses
  const linhas = new Map();
  for (const h of hist) {
    for (const v of h.vendedores) {
      if (!linhas.has(v.id)) linhas.set(v.id, { id: v.id, nome: v.nome, gerente: v.gerente, meses: {}, ordem: 0 });
      linhas.get(v.id).meses[`${h.year}-${h.month}`] = { pct: v.pct, delta: v.delta, ferias: v.diasFerias };
    }
  }
  for (const v of S.dados.vendedores) {
    if (!linhas.has(v.id)) linhas.set(v.id, { id: v.id, nome: v.nome, gerente: v.gerente, meses: {}, ordem: 0 });
    const l = linhas.get(v.id);
    l.nome = v.nome;
    l.ordem = v.venda;
    l.meses[`${S.year}-${S.month}`] = { pct: emCurso ? v.pctProj : v.pct, delta: v.delta, ferias: v.diasFerias };
  }

  if (!hist.length && !S.dados.vendedores.length) {
    $('histTbl').innerHTML = '<tbody><tr><td class="pa-empty">Sem meses lançados para comparar.</td></tr></tbody>';
    return;
  }

  $('histSub').textContent = hist.length
    ? `${hist.length} ${hist.length === 1 ? 'mês fechado' : 'meses fechados'} + o mês em curso`
    : 'só o mês em curso — ainda sem histórico lançado';

  const cab = c => `${MESES[c.month - 1]}/${String(c.year).slice(2)}${c.atual && emCurso ? '<div class="hist-delta mut">proj.</div>' : ''}`;
  const ordenadas = [...linhas.values()].sort((a, b) => b.ordem - a.ordem || a.nome.localeCompare(b.nome));

  $('histTbl').innerHTML = `
    <thead><tr>
      <th>Vendedor</th>
      ${cols.map(c => `<th class="num">${cab(c)}</th>`).join('')}
    </tr></thead>
    <tbody>
      <tr class="hist-loja">
        <td>LOJA — % da meta</td>
        ${cols.map(c => `<td class="num">${fPct(c.pct)}</td>`).join('')}
      </tr>
      ${ordenadas.map(l => `<tr>
        <td>${esc(l.nome)}${l.gerente ? '<span class="pa-tag ger">gerente</span>' : ''}</td>
        ${cols.map(c => {
          const cel = l.meses[`${c.year}-${c.month}`];
          if (!cel) return '<td class="num mut">—</td>';
          const td = deltaCell(cel.pct, cel.delta);
          return cel.ferias ? td.replace('</td>', '<div class="hist-delta mut">férias</div></td>') : td;
        }).join('')}
      </tr>`).join('')}
    </tbody>`;
}

// ── 3b · Média dos últimos meses fechados × mês em curso ─────────────────────
// Um mês isolado mente: o vendedor pega uma semana boa e parece outro. A média
// dos meses fechados é a régua; o que se discute na reunião é a distância entre
// ela e o mês que está correndo, indicador por indicador.
const sinal = (v, f) => (v >= 0 ? '+' : '-') + f(Math.abs(v));

// Se a diferença some no arredondamento, ela não é melhora nem piora: pintar de
// verde um +0,00 faz a reunião discutir ruído.
const semMovimento = txt => !/[1-9]/.test(txt);

function cmpCell(ind, fmt, fmtDelta) {
  if (!ind || ind.atual == null) return '<td class="num mut">—</td>';
  const topo = fmt(ind.atual);
  if (ind.media == null) return `<td class="num">${topo}<div class="hist-delta mut">sem base</div></td>`;
  const dTxt  = fmtDelta(ind.delta);
  const parou = semMovimento(dTxt);
  const cls   = parou ? 'mut' : ind.delta > 0 ? 'pos' : 'neg';
  const sub   = parou ? `igual à média (${fmt(ind.media)})` : `${dTxt} vs ${fmt(ind.media)}`;
  return `<td class="num">${topo}<div class="hist-delta ${cls}">${sub}</div></td>`;
}

function premioCmpCell(pr, emCurso) {
  if (!pr) return '<td class="num mut">—</td>';
  const topo = pr.atual ? fBRL(pr.atual) : '<span class="mut">R$ 0</span>';
  if (pr.media == null) return `<td class="num">${topo}</td>`;
  // Mês aberto tem semana por acontecer: comparar com a média de meses inteiros
  // pintaria de vermelho quem ainda vai ganhar. A média fica só como referência.
  if (emCurso) return `<td class="num">${topo}<div class="hist-delta mut">méd ${fBRL(pr.media)}/mês nos fechados</div></td>`;
  const delta = pr.atual - pr.media;
  const parou = Math.abs(delta) < 1;
  const cls   = parou ? 'mut' : delta > 0 ? 'pos' : 'neg';
  const sub   = parou ? `igual à média (${fBRL(pr.media)})` : `${sinal(delta, fBRL)} vs méd ${fBRL(pr.media)}`;
  return `<td class="num">${topo}<div class="hist-delta ${cls}">${sub}</div></td>`;
}

// Quantos dos quatro indicadores andaram para frente e quantos andaram para trás.
// É o resumo que a gerente leva da reunião — e mês parado aparece como parado,
// não como fracasso.
function placarCell(linha) {
  if (!linha.avaliados) return '<td class="num mut">—</td>';
  const { melhoraram: k, pioraram: pi = 0, avaliados: n } = linha;
  const cls = k > pi ? 'pos' : k < pi ? 'neg' : 'warn';
  const partes = [];
  if (k)  partes.push(`${k}↑`);
  if (pi) partes.push(`${pi}↓`);
  const sub = linha.mesesComparados != null && linha.mesesComparados < 3
    ? `base de ${linha.mesesComparados} ${linha.mesesComparados === 1 ? 'mês' : 'meses'}`
    : `de ${n} indicador${n === 1 ? '' : 'es'}`;
  return `<td class="num ${cls}">${partes.length ? partes.join(' ') : 'estável'}<div class="hist-delta mut">${sub}</div></td>`;
}

function renderMedia3M() {
  const md = S.dados.media3m;
  const hdr = $('mediaHdr'), tbl = $('mediaTbl'), leg = $('mediaLegend');
  if (!md || !md.meses.length) {
    hdr.textContent = 'Média dos últimos meses × mês em curso';
    tbl.innerHTML = '<tbody><tr><td class="pa-empty">Sem meses fechados suficientes para tirar média.</td></tr></tbody>';
    leg.textContent = '';
    return;
  }

  const rot = md.meses.map(x => `${MESES[x.month - 1]}/${String(x.year).slice(2)}`).join(', ');
  hdr.textContent = `Média de ${md.meses.length} ${md.meses.length === 1 ? 'mês fechado' : 'meses fechados'} (${rot}) × ${MESES[S.month - 1]}/${S.year}${md.emCurso ? ' em curso' : ''}`;

  const fmtPct  = v => fPct(v);
  const fmtPa   = v => fDec(v, 2);
  const fmtTm   = v => fBRL(v);
  const dPP     = v => sinal(v, x => x.toFixed(0) + ' pp');
  const dPa     = v => sinal(v, x => fDec(x, 2));
  const dTm     = v => sinal(v, fBRL);

  const linhaHtml = (l, nome, classe) => `<tr class="${classe || ''}">
      <td>${nome}</td>
      ${cmpCell(l.pct,  fmtPct, dPP)}
      ${cmpCell(l.pa,   fmtPa,  dPa)}
      ${cmpCell(l.tm,   fmtTm,  dTm)}
      ${cmpCell(l.conv, fmtPct, dPP)}
      ${premioCmpCell(l.premio, md.emCurso)}
      ${placarCell(l)}
    </tr>`;

  tbl.innerHTML = `
    <thead><tr>
      <th>Vendedor</th>
      <th class="num">% da meta</th><th class="num">PA</th><th class="num">Ticket</th><th class="num">Conversão</th>
      <th class="num">Prêmios/mês</th><th class="num">Evolução</th>
    </tr></thead>
    <tbody>
      ${linhaHtml(md.loja, 'LOJA', 'hist-loja')}
      ${md.vendedores.map(l => linhaHtml(l,
          esc(l.nome) + (l.gerente ? '<span class="pa-tag ger">gerente</span>' : ''))).join('')}
    </tbody>`;

  const sem = S.dados.premiacoes?.semanas || 0;
  leg.innerHTML = 'Em cima, o número do mês' + (md.emCurso ? ' em curso (o % da meta pela projeção de fechamento)' : '')
    + '; embaixo, quanto ele está acima ou abaixo da média dos meses fechados. Verde melhorou, vermelho piorou, cinza não saiu do lugar.'
    + ` Prêmios é o que a premiação semanal já pagou no mês — ${sem} semana${sem === 1 ? '' : 's'} encerrada${sem === 1 ? '' : 's'} até aqui`
    + (md.emCurso ? ', por isso o mês em curso aparece sem comparação: a média serve só de referência.' : '.')
    + ' Quem tem menos de três meses fechados aparece com a base reduzida: ainda é cedo para chamar de tendência.';
}
// ── Valor do estoque declarado à mão ─────────────────────────────────────────
// O Microvix dá o estoque a preço de venda pelo catálogo; o número que o
// contábil usa é outro. Aqui entra o que a loja/escritório apurou.
function parseValor(txt) {
  const limpo = String(txt || '').replace(/[^\d,.-]/g, '');
  if (!limpo) return 0;
  // 1.234,56 (brasileiro) vs 1234.56 — a vírgula decide
  const n = limpo.includes(',')
    ? parseFloat(limpo.replace(/\./g, '').replace(',', '.'))
    : parseFloat(limpo);
  return isNaN(n) ? 0 : n;
}

function renderEstoqueManual() {
  const e = S.pauta.estoqueManual || { custo: 0, venda: 0, data: '', obs: '' };
  S.pauta.estoqueManual = e;
  if (document.activeElement?.id !== 'estCusto') $('estCusto').value = e.custo ? fBRL2(e.custo) : '';
  if (document.activeElement?.id !== 'estVenda') $('estVenda').value = e.venda ? fBRL2(e.venda) : '';
  $('estData').value = e.data || '';
  if (document.activeElement?.id !== 'estObs') $('estObs').value = e.obs || '';

  const partes = [];
  if (e.custo > 0 && e.venda > 0) partes.push(`Markup ${fDec(e.venda / e.custo, 2)}× · margem embutida ${fDec((1 - e.custo / e.venda) * 100, 1)}%`);
  const ritmo = S.dados.loja.projecao ?? S.dados.loja.venda;
  if (e.venda > 0 && ritmo > 0) partes.push(`${fDec(e.venda / ritmo, 1)} meses de venda parados na loja, no ritmo deste mês`);
  $('estDeriv').innerHTML = partes.length ? partes.join(' · ') : '';
  renderEstoqueHistorico();
}

// Os doze meses de estoque declarado. O mês em curso sai do que está sendo
// digitado agora, não do que já foi salvo — senão a linha de baixo desmente o
// campo de cima enquanto o gestor digita.
function renderEstoqueHistorico() {
  const tbl = $('estHistTbl'), leg = $('estHistLegend');
  const hist = (S.dados.estoqueHistorico || []).map(x => {
    if (x.year !== S.year || x.month !== S.month) return x;
    const e = S.pauta.estoqueManual || {};
    const custo = e.custo || 0, venda = e.venda || 0;
    const ritmo = S.dados.loja.projecao ?? S.dados.loja.venda;
    return {
      ...x, custo, venda, data: e.data || '', obs: e.obs || '',
      markup:    custo > 0 && venda > 0 ? venda / custo : null,
      cobertura: venda > 0 && ritmo > 0 ? venda / ritmo : null,
      faturado:  ritmo || x.faturado,
      atual: true,
    };
  });

  // Antes da primeira apuração não há o que mostrar; depois dela, o mês vazio
  // é informação: alguém deixou de apurar.
  const primeiro = hist.findIndex(x => x.custo || x.venda || x.microvix);
  if (primeiro > 0) hist.splice(0, primeiro);

  if (primeiro < 0) {
    tbl.innerHTML = '<tbody><tr><td class="pa-empty">Nenhum mês com valor de estoque apurado ainda. O primeiro lançamento vira a base de comparação dos próximos.</td></tr></tbody>';
    leg.textContent = '';
    return;
  }

  const varCusto = (x, i) => {
    const ant = hist.slice(0, i).reverse().find(p => p.custo > 0);
    if (!x.custo || !ant) return '';
    const v = ((x.custo - ant.custo) / ant.custo) * 100;
    const cls = Math.abs(v) < 0.5 ? 'mut' : v > 0 ? 'warn' : 'pos';
    return `<div class="hist-delta ${cls}">${v >= 0 ? '+' : ''}${v.toFixed(0)}% vs ${MESES[ant.month - 1]}</div>`;
  };

  tbl.innerHTML = `
    <thead><tr>
      <th>Mês</th>
      <th class="num">A custo</th><th class="num">A preço de venda</th><th class="num">Markup</th>
      <th class="num">Meses parados</th><th class="num">Faturado no mês</th>
      <th class="num">Estoque Microvix</th><th>Apurado em</th>
    </tr></thead>
    <tbody>${hist.map((x, i) => `<tr>
      <td>${MESES[x.month - 1]}/${String(x.year).slice(2)}${x.atual ? '<span class="pa-tag fer">em curso</span>' : ''}</td>
      <td class="num">${x.custo ? fBRL(x.custo) : '<span class="mut">—</span>'}${varCusto(x, i)}</td>
      <td class="num">${x.venda ? fBRL(x.venda) : '<span class="mut">—</span>'}</td>
      <td class="num">${x.markup == null ? '<span class="mut">—</span>' : fDec(x.markup, 2) + '×'}</td>
      <td class="num">${x.cobertura == null ? '<span class="mut">—</span>' : cobHtml(x.cobertura)}</td>
      <td class="num">${x.faturado ? fBRL(x.faturado) : '<span class="mut">—</span>'}</td>
      <td class="num">${x.microvix && x.microvix.valor
          ? `${fBRL(x.microvix.valor)}<div class="hist-delta mut">${fNum(x.microvix.pecas)} peças</div>`
          : '<span class="mut">—</span>'}</td>
      <td>${x.data ? fData(x.data) : '<span class="mut">—</span>'}${x.obs ? `<div class="hist-delta mut">${esc(x.obs)}</div>` : ''}</td>
    </tr>`).join('')}</tbody>`;

  leg.innerHTML = 'A custo e a preço de venda é o que a loja apurou naquele mês — mês em branco é mês que ninguém apurou, não estoque zerado.'
    + ' Embaixo do valor a custo, quanto ele cresceu ou caiu contra o último mês apurado: estoque subindo com venda parada é dinheiro preso na arara.'
    + ' Meses parados = estoque a preço de venda dividido pelo faturamento do mês; verde até 3 meses, vermelho acima de 6.'
    + ' A coluna do Microvix é a foto do sistema no dia em que a pauta daquele mês foi montada.';
}
// ── 4 · RH ───────────────────────────────────────────────────────────────────
function alerta(nivel, titulo, meta, pill, pillCls) {
  return `<div class="pa-alert ${nivel}">
    <div class="pa-alert-txt">
      <div class="pa-alert-nome">${titulo}</div>
      ${meta ? `<div class="pa-alert-meta">${meta}</div>` : ''}
    </div>
    ${pill ? `<span class="pa-alert-pill ${pillCls}">${esc(pill)}</span>` : ''}
  </div>`;
}

function renderRH() {
  const rh = S.dados.rh;
  $('rhSub').textContent = `${rh.ativos} ativo${rh.ativos === 1 ? '' : 's'} · ${rh.vendedores} vendedor${rh.vendedores === 1 ? '' : 'es'}`;

  const blocos = [];

  // Contratos de experiência
  blocos.push('<div class="pa-sub-hdr">Contrato de experiência</div>');
  if (!rh.contratos.length) {
    blocos.push('<div class="pa-empty">Nenhum contrato vencendo nos próximos 60 dias.</div>');
  } else {
    blocos.push('<div class="pa-alertas">' + rh.contratos.map(c => {
      const prox = [c.dias1, c.dias2].filter(d => d !== null && d >= 0);
      const dias = prox.length ? Math.min(...prox) : null;
      const nivel = c.decisao ? 'crit' : dias === null ? 'info' : dias <= 15 ? 'crit' : dias <= 30 ? 'att' : 'info';
      const pillCls = nivel === 'crit' ? 'pill-crit' : nivel === 'att' ? 'pill-att' : 'pill-info';
      const pill = c.decisao ? 'efetivar?' : dias === null ? 'vencido' : dias === 0 ? 'vence hoje' : `${dias}d`;
      const partes = [];
      if (c.venc1) partes.push(`1º até ${fData(c.venc1)}`);
      if (c.venc2) partes.push(`2º até ${fData(c.venc2)}`);
      else partes.push('sem 2º contrato cadastrado — prorrogar ou desligar');
      partes.push(`admissão ${fData(c.admissao)}`);
      return alerta(nivel, esc(c.nome) + (c.cargo ? ` <span class="mut" style="font-weight:400">· ${esc(c.cargo)}</span>` : ''), partes.join(' · '), pill, pillCls);
    }).join('') + '</div>');
  }

  // Férias
  blocos.push('<div class="pa-sub-hdr">Férias</div>');
  if (!rh.ferias.length) {
    blocos.push('<div class="pa-empty">Ninguém com férias vencidas, a vencer ou agendadas.</div>');
  } else {
    blocos.push('<div class="pa-alertas">' + rh.ferias.map(f => {
      const nivel = f.status === 'vencida' ? 'crit' : f.status === 'direito adquirido' ? 'att' : f.status === 'agendada' ? 'ok' : 'info';
      const pillCls = nivel === 'crit' ? 'pill-crit' : nivel === 'att' ? 'pill-att' : nivel === 'ok' ? 'pill-ok' : 'pill-info';
      const meta = [
        f.agendada ? `agendada ${fData(f.agendada.inicio)} a ${fData(f.agendada.fim)}` : null,
        f.ultimoGozo ? `últimas férias até ${fData(f.ultimoGozo)}` : `admissão ${fData(f.admissao)} — sem férias registradas`,
        `limite para gozo ${fData(f.limiteGozo)}`,
      ].filter(Boolean).join(' · ');
      return alerta(nivel, esc(f.nome), meta, f.status, pillCls);
    }).join('') + '</div>');
  }

  // Movimentação do mês
  if (rh.admissoes.length || rh.desligamentos.length || rh.ausenciasMes.length) {
    blocos.push('<div class="pa-sub-hdr">Movimentação do mês</div><div class="pa-alertas">');
    for (const a of rh.admissoes)
      blocos.push(alerta('ok', esc(a.nome), `admitido em ${fData(a.data)}${a.cargo ? ' · ' + esc(a.cargo) : ''}`, 'admissão', 'pill-ok'));
    for (const d of rh.desligamentos)
      blocos.push(alerta('crit', esc(d.nome), `desligado em ${fData(d.data)}${d.cargo ? ' · ' + esc(d.cargo) : ''}`, 'desligamento', 'pill-crit'));
    for (const a of rh.ausenciasMes)
      blocos.push(alerta('info', esc(a.colaborador), `${fData(a.dataInicio)} a ${fData(a.dataFim)}${a.observacao ? ' · ' + esc(a.observacao) : ''}`, a.tipo, 'pill-info'));
    blocos.push('</div>');
  }

  $('rhAuto').innerHTML = blocos.join('');
  renderLista('rhItens');
  $('cmtRh').value = S.pauta.comentarios.rh || '';
}

// ── Listas editáveis: rhItens, demandas, acoes ───────────────────────────────
const RH_TIPOS = {
  ferias: 'Férias', contratacao: 'Contratação', demissao: 'Demissão',
  atestado: 'Atestado', advertencia: 'Advertência', treinamento: 'Treinamento', outro: 'Outro',
};

function renderLista(campo) {
  const el = $(campo);
  const arr = S.pauta[campo] || [];
  if (!arr.length) {
    const vazio = {
      rhItens:  'Nenhuma pendência de RH anotada.',
      demandas: 'Nenhuma demanda adicional.',
      acoes:    'Nenhuma ação combinada ainda.',
    }[campo];
    el.innerHTML = `<div class="pa-empty">${vazio}</div>`;
    return;
  }
  el.innerHTML = arr.map((it, i) => {
    if (campo === 'rhItens') {
      return `<div class="pa-linha">
        <span class="pa-alert-pill pill-info">${esc(RH_TIPOS[it.tipo] || it.tipo || 'Outro')}</span>
        ${it.colaborador ? `<strong style="font-size:.8rem">${esc(it.colaborador)}</strong>` : ''}
        <span class="grow" style="font-size:.8rem">${esc(it.descricao || '')}</span>
        ${it.prazo ? `<span class="pa-alert-meta">até ${fData(it.prazo)}</span>` : ''}
        <button class="pa-del" data-del="${campo}" data-i="${i}" title="Remover">✕</button>
      </div>`;
    }
    if (campo === 'demandas') {
      return `<div class="pa-linha">
        <strong style="font-size:.8rem">${esc(it.titulo || '')}</strong>
        <span class="grow" style="font-size:.8rem;color:#8b949e">${esc(it.detalhe || '')}</span>
        <button class="pa-del" data-del="${campo}" data-i="${i}" title="Remover">✕</button>
      </div>`;
    }
    return `<div class="pa-linha">
      <span class="grow" style="font-size:.8rem">${esc(it.texto || '')}</span>
      ${it.responsavel ? `<span class="pa-alert-pill pill-info">${esc(it.responsavel)}</span>` : ''}
      ${it.prazo ? `<span class="pa-alert-meta">até ${fData(it.prazo)}</span>` : ''}
      ${it.meetingItemId ? '<span class="pa-alert-pill pill-ok">na pauta da loja</span>' : ''}
      <button class="pa-del" data-del="${campo}" data-i="${i}" title="Remover">✕</button>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', () => {
      S.pauta[campo].splice(parseInt(b.dataset.i), 1);
      renderLista(campo);
      queueSave();
    });
  });
}

// ── 5 · Pendências e ações anteriores ────────────────────────────────────────
function renderPendencias() {
  const { pendencias, acoesAnteriores } = S.dados;
  $('pendSub').textContent = `${pendencias.length} aberta${pendencias.length === 1 ? '' : 's'}`;
  const html = [];

  html.push('<div class="pa-sub-hdr">Itens de pauta abertos</div>');
  if (!pendencias.length) {
    html.push('<div class="pa-empty">Nada em aberto para esta loja.</div>');
  } else {
    html.push(pendencias.map(p => `
      <div class="pa-pend">
        <span class="pa-pend-mes">${pad(p.month)}/${String(p.year).slice(2)}</span>
        <span class="pa-pend-txt">${esc(p.text)}</span>
        <span class="pa-pend-mes">${esc(p.origin === 'loja' ? 'loja' : p.origin === 'pauta' ? 'reunião' : p.origin === 'auto' ? 'sistema' : 'adm')}</span>
      </div>`).join(''));
  }

  html.push('<div class="pa-sub-hdr">Ações combinadas no mês anterior</div>');
  if (!acoesAnteriores.length) {
    html.push('<div class="pa-empty">Nenhuma ação registrada na reunião anterior.</div>');
  } else {
    html.push(acoesAnteriores.map(a => `
      <div class="pa-pend">
        <span class="${a.feito ? 'pa-check' : 'pa-uncheck'}">${a.feito ? '✔' : '✕'}</span>
        <span class="pa-pend-txt">${esc(a.texto)}${a.responsavel ? ` <span class="mut">· ${esc(a.responsavel)}</span>` : ''}${a.prazo ? ` <span class="mut">· até ${fData(a.prazo)}</span>` : ''}</span>
        <span class="pa-pend-mes">${a.feito ? 'resolvida' : a.naPauta ? 'em aberto' : 'não enviada'}</span>
      </div>`).join(''));
  }

  $('pendBody').innerHTML = html.join('');
}

// ── 4 · Produtos e serviços vendidos × estoque ───────────────────────────────
function periodoDoMes() {
  const hoje = S.dados?.hoje || new Date().toISOString().slice(0, 10);
  const ini = `${S.year}-${pad(S.month)}-01`;
  const ult = `${S.year}-${pad(S.month)}-${pad(new Date(S.year, S.month, 0).getDate())}`;
  return { dtIni: ini, dtFin: ult < hoje ? ult : hoje };
}

async function carregarProdutos() {
  const { dtIni, dtFin } = periodoDoMes();
  $('btnProd').disabled = true;
  $('prodStatus').textContent = 'Consultando o Microvix… pode levar até um minuto.';
  $('prodResult').innerHTML = '<div class="pa-state"><div class="pa-spin"></div><div>Vendas e estoque…</div></div>';
  try {
    const q = `board=${encodeURIComponent(S.board)}`;
    const [vendas, estoque] = await Promise.all([
      api('GET', `/api/relatorio-marcas?${q}&dtIni=${dtIni}&dtFin=${dtFin}`),
      api('GET', `/api/estoque-marcas?${q}`),
    ]);

    const mapa = {};
    for (const m of (vendas.marcas || [])) {
      const k = m.marca.toUpperCase();
      mapa[k] = { marca: m.marca, vQtd: m.qtd || 0, vValor: m.valor || 0, eQtd: 0, eValor: 0 };
    }
    for (const e of (estoque.estoque || [])) {
      const k = e.marca.toUpperCase();
      if (!mapa[k]) mapa[k] = { marca: e.marca, vQtd: 0, vValor: 0, eQtd: 0, eValor: 0 };
      mapa[k].eQtd   = e.totalQtd   || 0;
      mapa[k].eValor = e.totalValor || 0;
    }
    const linhas = Object.values(mapa).map(l => ({
      ...l,
      cobertura: l.vQtd > 0 ? l.eQtd / l.vQtd : null, // meses de estoque no ritmo do mês
    }));

    S.produtos = {
      periodo: { dtIni, dtFin },
      geradoEm: new Date().toISOString(),
      linhas: linhas.sort((a, b) => b.vValor - a.vValor),
    };
    // O que vai para o snapshot e para a IA: o topo do giro e o que está parado
    S.pauta.produtosResumo = {
      periodo: S.produtos.periodo,
      geradoEm: S.produtos.geradoEm,
      totalVendido: linhas.reduce((s, l) => s + l.vValor, 0),
      totalEstoque: linhas.reduce((s, l) => s + l.eValor, 0),
      pecasVendidas: linhas.reduce((s, l) => s + l.vQtd, 0),
      pecasEstoque: linhas.reduce((s, l) => s + l.eQtd, 0),
      topGiro: S.produtos.linhas.slice(0, 15).map(l => ({
        marca: l.marca, vendidoRS: Math.round(l.vValor), vendidoPcs: l.vQtd,
        estoquePcs: l.eQtd, estoqueRS: Math.round(l.eValor),
        coberturaMeses: l.cobertura == null ? null : Math.round(l.cobertura * 10) / 10,
      })),
      semGiro: linhas.filter(l => l.vQtd === 0 && l.eQtd > 0)
        .sort((a, b) => b.eValor - a.eValor).slice(0, 10)
        .map(l => ({ marca: l.marca, estoquePcs: l.eQtd, estoqueRS: Math.round(l.eValor) })),
      rupturaRisco: linhas.filter(l => l.cobertura != null && l.cobertura < 1 && l.vQtd >= 5)
        .sort((a, b) => a.cobertura - b.cobertura).slice(0, 10)
        .map(l => ({ marca: l.marca, vendidoPcs: l.vQtd, estoquePcs: l.eQtd, coberturaMeses: Math.round(l.cobertura * 10) / 10 })),
    };
    queueSave();
    renderProdutos();
    $('prodStatus').textContent = `Vendas de ${fData(dtIni)} a ${fData(dtFin)} contra o estoque de hoje.`;
  } catch (e) {
    $('prodResult').innerHTML = '';
    $('prodStatus').textContent = 'Falhou: ' + e.message;
    toast('Erro ao consultar o Microvix', true);
  } finally {
    $('btnProd').disabled = false;
  }
}

function cobHtml(c) {
  if (c == null) return '<span class="pa-cob mut">sem giro</span>';
  const cls = c < 1 ? 'neg' : c <= 3 ? 'pos' : c <= 6 ? 'warn' : 'neg';
  return `<span class="pa-cob ${cls}">${fDec(c, 1)}</span>`;
}

function renderProdutos() {
  $('cmtProdutos').value = S.pauta.comentarios.produtos || '';
  if (!S.produtos && S.pauta.produtosResumo) {
    // Reabriu a pauta: mostra o que ficou salvo, sem bater no Microvix de novo
    const p = S.pauta.produtosResumo;
    $('prodStatus').textContent = `Salvo em ${new Date(p.geradoEm).toLocaleString('pt-BR')} — clique para atualizar.`;
    $('prodResult').innerHTML = `
      <div class="pa-kpis" style="margin-bottom:.7rem">
        <div class="pa-kpi"><div class="pa-kpi-lbl">Vendido no mês</div><div class="pa-kpi-val blue">${fBRL(p.totalVendido)}</div><div class="pa-kpi-sub">${fNum(p.pecasVendidas)} peças</div></div>
        <div class="pa-kpi"><div class="pa-kpi-lbl">Estoque</div><div class="pa-kpi-val">${fBRL(p.totalEstoque)}</div><div class="pa-kpi-sub">${fNum(p.pecasEstoque)} peças</div></div>
      </div>
      <div class="pa-tbl-wrap"><table class="pa-tbl">
        <thead><tr><th>Marca</th><th class="num">Vendido</th><th class="num">Peças</th><th class="num">Estoque</th><th class="num">R$ estoque</th><th class="num">Cobertura</th></tr></thead>
        <tbody>${p.topGiro.map(l => `<tr>
          <td>${esc(l.marca)}</td><td class="num">${fBRL(l.vendidoRS)}</td><td class="num">${fNum(l.vendidoPcs)}</td>
          <td class="num">${fNum(l.estoquePcs)}</td><td class="num">${fBRL(l.estoqueRS)}</td>
          <td class="num">${cobHtml(l.coberturaMeses)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    return;
  }
  if (!S.produtos) { $('prodResult').innerHTML = ''; return; }

  const linhas = S.produtos.linhas;
  const totV = linhas.reduce((s, l) => s + l.vValor, 0);
  const totE = linhas.reduce((s, l) => s + l.eValor, 0);
  const semGiro = linhas.filter(l => l.vQtd === 0 && l.eQtd > 0).sort((a, b) => b.eValor - a.eValor).slice(0, 10);

  $('prodSub').textContent = `${linhas.length} marcas`;
  $('prodResult').innerHTML = `
    <div class="pa-kpis" style="margin-bottom:.7rem">
      <div class="pa-kpi"><div class="pa-kpi-lbl">Vendido no mês</div><div class="pa-kpi-val blue">${fBRL(totV)}</div><div class="pa-kpi-sub">${fNum(linhas.reduce((s, l) => s + l.vQtd, 0))} peças</div></div>
      <div class="pa-kpi"><div class="pa-kpi-lbl">Estoque hoje</div><div class="pa-kpi-val">${fBRL(totE)}</div><div class="pa-kpi-sub">${fNum(linhas.reduce((s, l) => s + l.eQtd, 0))} peças</div></div>
      <div class="pa-kpi"><div class="pa-kpi-lbl">Cobertura geral</div><div class="pa-kpi-val">${(() => {
        const vq = linhas.reduce((s, l) => s + l.vQtd, 0), eq = linhas.reduce((s, l) => s + l.eQtd, 0);
        return vq > 0 ? fDec(eq / vq, 1) + ' meses' : '—';
      })()}</div><div class="pa-kpi-sub">no ritmo do mês</div></div>
      <div class="pa-kpi"><div class="pa-kpi-lbl">Marcas sem giro</div><div class="pa-kpi-val ${semGiro.length ? 'warn' : ''}">${semGiro.length}</div><div class="pa-kpi-sub">com estoque, sem venda</div></div>
    </div>
    <div class="pa-tbl-wrap"><table class="pa-tbl">
      <thead><tr><th>Marca</th><th class="num">Vendido</th><th class="num">Peças</th><th class="num">Estoque (pçs)</th><th class="num">R$ estoque</th><th class="num">Cobertura</th></tr></thead>
      <tbody>${linhas.slice(0, 25).map(l => `<tr>
        <td>${esc(l.marca)}</td>
        <td class="num">${fBRL(l.vValor)}</td>
        <td class="num">${fNum(l.vQtd)}</td>
        <td class="num">${fNum(l.eQtd)}</td>
        <td class="num">${fBRL(l.eValor)}</td>
        <td class="num">${cobHtml(l.cobertura)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${semGiro.length ? `
      <div class="pa-sub-hdr">Estoque parado — sem nenhuma venda no mês</div>
      <div class="pa-alertas">${semGiro.map(l =>
        alerta('att', esc(l.marca), `${fNum(l.eQtd)} peças · ${fBRL(l.eValor)} em estoque`, 'sem giro', 'pill-att')).join('')}</div>` : ''}
    <div class="pa-legend">Cobertura = peças em estoque ÷ peças vendidas no mês, em meses de venda no ritmo atual.
    Abaixo de 1 é risco de ruptura; acima de 6, capital parado. Serviço não tem estoque e aparece como “sem giro”.</div>`;
}

// ── 8 · Roteiro da conversa (IA) ─────────────────────────────────────────────
async function gerarRoteiro() {
  $('btnIA').disabled = true;
  $('iaBody').innerHTML = '<div class="pa-state"><div class="pa-spin"></div><div>Lendo os números e montando o roteiro…</div></div>';
  try {
    const body = S.pauta.produtosResumo ? { produtos: S.pauta.produtosResumo } : {};
    const r = await api('POST', `/api/pauta/${S.year}/${S.month}/${S.board}/roteiro`, body);
    S.pauta.roteiro = r.roteiro;
    renderRoteiro();
    toast('Roteiro pronto');
  } catch (e) {
    $('iaBody').innerHTML = `<div class="pa-err">${esc(e.message)}</div>`;
  } finally {
    $('btnIA').disabled = false;
  }
}

function renderRoteiro() {
  const r = S.pauta.roteiro;
  if (!r) return;
  const bloco = (titulo, itens, campoPergunta) => {
    if (!itens?.length) return '';
    return `<div class="pa-sub-hdr">${titulo}</div>` + itens.map(i => `
      <div class="pa-ia-item">
        <div class="pa-ia-tema">${esc(i.tema || i.nome || '')}</div>
        <div class="pa-ia-ev">${esc(i.evidencia || i.leitura || '')}</div>
        ${i[campoPergunta] ? `<div class="pa-ia-perg">“${esc(i[campoPergunta])}”</div>` : ''}
      </div>`).join('');
  };

  $('iaBody').innerHTML = `
    <div class="pa-ia-box">
      ${r.resumo ? `<div class="pa-ia-resumo">${esc(r.resumo)}</div>` : ''}
      ${r.pontosFortes?.length ? `<div class="pa-sub-hdr">Para reconhecer</div>${r.pontosFortes.map(p => `<div class="pa-ia-forte">${esc(p)}</div>`).join('')}` : ''}
      ${bloco('Pontos de atenção', r.pontosAtencao, 'pergunta')}
      ${bloco('Vendedores', r.vendedores, 'pergunta')}
      ${bloco('RH', r.rh, 'encaminhamento')}
      ${bloco('Produto e estoque', r.produtos, 'pergunta')}
      ${r.acoesSugeridas?.length ? `<div class="pa-sub-hdr">Ações sugeridas</div>${r.acoesSugeridas.map((a, i) => `
        <div class="pa-ia-acao">
          <span class="pa-ia-acao-txt">${esc(a.texto)}${a.responsavel ? ` <span class="mut">· ${esc(a.responsavel)}</span>` : ''}${a.prazoSugerido ? ` <span class="mut">· ${esc(a.prazoSugerido)}</span>` : ''}</span>
          <button class="pa-ia-add" data-ia="${i}">+ ação</button>
        </div>`).join('')}` : ''}
      ${r.geradoEm ? `<div class="pa-legend">Gerado em ${new Date(r.geradoEm).toLocaleString('pt-BR')}${r.geradoPor ? ' por ' + esc(r.geradoPor) : ''}. É sugestão de conversa — a decisão é sua.</div>` : ''}
    </div>`;

  $('iaBody').querySelectorAll('[data-ia]').forEach(b => {
    b.addEventListener('click', () => {
      const a = r.acoesSugeridas[parseInt(b.dataset.ia)];
      S.pauta.acoes.push({ texto: a.texto, responsavel: a.responsavel || '', prazo: '' });
      renderLista('acoes');
      queueSave();
      b.disabled = true;
      b.textContent = 'adicionada';
      avisoSeFechada();
    });
  });
}

function avisoSeFechada() {
  if (S.pauta.status === 'realizada')
    toast('Reunião já fechada — reabra e feche de novo para mandar as novas ações à pauta da loja.');
}

// ── Fechar / reabrir ─────────────────────────────────────────────────────────
async function fecharOuReabrir() {
  const btn = $('btnFechar');
  btn.disabled = true;
  try {
    if (S.pauta.status === 'realizada') {
      if (!confirm('Reabrir a pauta para edição? Os itens já enviados à loja continuam lá.')) return;
      await api('POST', `/api/pauta/${S.year}/${S.month}/${S.board}/reabrir`);
      toast('Pauta reaberta');
    } else {
      const pend = (S.pauta.acoes || []).filter(a => !a.meetingItemId).length;
      if (!confirm(`Fechar a reunião de ${S.label}?\n\n${pend} ação(ões) vão virar item de pauta da loja e os números do mês ficam congelados.`)) return;
      await salvar();
      const r = await api('POST', `/api/pauta/${S.year}/${S.month}/${S.board}/fechar`);
      toast(`Reunião fechada — ${r.criados} ação(ões) na pauta da loja`);
    }
    await carregar();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function mudarMes(delta) {
  let m = S.month + delta, y = S.year;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  S.month = m; S.year = y;
  carregar();
}

async function init() {
  try { S.me = await api('GET', '/api/me'); }
  catch { return; }
  if (S.me.board && S.me.board !== 'escritorio') { window.location.href = '/'; return; }

  const sel = $('boardSel');
  sel.innerHTML = Object.entries(PAUTA_LOJAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  let salvo = null;
  try { salvo = localStorage.getItem('pauta:board'); } catch (_) {}
  if (salvo && PAUTA_LOJAS[salvo]) S.board = salvo;
  sel.value = S.board;

  sel.addEventListener('change', () => {
    S.board = sel.value;
    try { localStorage.setItem('pauta:board', S.board); } catch (_) {}
    carregar();
  });
  $('btnPrev').addEventListener('click', () => mudarMes(-1));
  $('btnNext').addEventListener('click', () => mudarMes(1));
  $('btnFechar').addEventListener('click', fecharOuReabrir);
  $('btnPrint').addEventListener('click', () => window.print());
  $('btnProd').addEventListener('click', carregarProdutos);
  $('btnIA').addEventListener('click', gerarRoteiro);

  for (const [id, campo] of [['cmtPerformance', 'performance'], ['cmtVendedores', 'vendedores'], ['cmtRh', 'rh'], ['cmtProdutos', 'produtos']]) {
    $(id).addEventListener('input', () => { S.pauta.comentarios[campo] = $(id).value; queueSave(); });
  }
  for (const id of ['estCusto', 'estVenda']) {
    $(id).addEventListener('input', () => {
      S.pauta.estoqueManual[id === 'estCusto' ? 'custo' : 'venda'] = parseValor($(id).value);
      renderEstoqueManual();
      queueSave();
    });
    $(id).addEventListener('blur', () => renderEstoqueManual());
  }
  $('estData').addEventListener('change', () => { S.pauta.estoqueManual.data = $('estData').value; queueSave(); });
  $('estObs').addEventListener('input', () => { S.pauta.estoqueManual.obs = $('estObs').value; queueSave(); });

  $('realizadaEm').addEventListener('change', () => { S.pauta.realizadaEm = $('realizadaEm').value; queueSave(); });
  $('participantes').addEventListener('input', () => { S.pauta.participantes = $('participantes').value; queueSave(); });

  $('rhAdd').addEventListener('click', () => {
    const desc = $('rhDesc').value.trim();
    const colab = $('rhColab').value.trim();
    if (!desc && !colab) { toast('Escreva a pendência', true); return; }
    S.pauta.rhItens.push({ tipo: $('rhTipo').value, colaborador: colab, descricao: desc, prazo: $('rhPrazo').value || '' });
    $('rhColab').value = ''; $('rhDesc').value = ''; $('rhPrazo').value = '';
    renderLista('rhItens');
    queueSave();
  });

  $('demAdd').addEventListener('click', () => {
    const t = $('demTitulo').value.trim(), d = $('demDetalhe').value.trim();
    if (!t && !d) { toast('Escreva a demanda', true); return; }
    S.pauta.demandas.push({ titulo: t, detalhe: d });
    $('demTitulo').value = ''; $('demDetalhe').value = '';
    renderLista('demandas');
    queueSave();
  });

  $('acaoAdd').addEventListener('click', () => {
    const t = $('acaoTexto').value.trim();
    if (!t) { toast('Escreva a ação', true); return; }
    S.pauta.acoes.push({ texto: t, responsavel: $('acaoResp').value.trim(), prazo: $('acaoPrazo').value || '' });
    $('acaoTexto').value = ''; $('acaoResp').value = ''; $('acaoPrazo').value = '';
    renderLista('acoes');
    queueSave();
    avisoSeFechada();
  });

  for (const [inp, btn] of [['rhDesc', 'rhAdd'], ['demDetalhe', 'demAdd'], ['acaoTexto', 'acaoAdd']]) {
    $(inp).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $(btn).click(); } });
  }

  window.addEventListener('beforeunload', () => { if (_saveT) salvar(); });

  carregar();
}

init();
