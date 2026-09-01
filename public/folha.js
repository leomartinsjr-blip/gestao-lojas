'use strict';

const BOARDS_INFO = {
  delrey:     { label: 'DEL REY',    color: '#58A6FF' },
  minas:      { label: 'MINAS',      color: '#3FB950' },
  contagem:   { label: 'CONTAGEM',   color: '#D29922' },
  estacao:    { label: 'ESTAÇÃO',    color: '#F85149' },
  tommy:      { label: 'TOMMY',      color: '#22D3EE' },
  lez:        { label: 'LEZ A LEZ',  color: '#F472B6' },
  site:       { label: 'SITE',       color: '#A78BFA' },
  escritorio: { label: 'ESCRITÓRIO', color: '#64748B' },
};
const STORE_BOARDS = Object.keys(BOARDS_INFO);

// Lojas que não pagam pelo próprio caixa — mapeia loja → loja que efetivamente
// paga. Usado no rateio do supervisor/sócio: as lojas de um mesmo pagador são
// somadas e os descontos abatem do total do grupo, não de uma loja só.
// Loja ausente daqui paga por si mesma.
// A Estação paga tudo o que é dela; Contagem e escritório saem da Minas.
const BOARD_PAGADOR = {
  contagem: 'minas',
  site:     'minas',
};
function pagadorDe(board) { return BOARD_PAGADOR[board] || board; }

// Lojas que pagam o prêmio semanal de meta pelo próprio caixa, na semana em que
// a meta é batida. O dinheiro já chegou na mão do funcionário, então o prêmio
// não entra em proventos nem na base de INSS/VT — a folha só mostra o valor,
// pra loja conferir. Vale só para o prêmio semanal: o prêmio de loja/balanço
// (premiacaoBalanco) continua sendo pago pela folha normalmente.
// Sem a chave gravada no config da loja, vale este padrão.
const PREMIACAO_NA_LOJA_PADRAO = ['estacao'];
function premiacaoPagaNaLoja(board) {
  const cfg = FP.folhaConfig[board] || {};
  return cfg.premiacaoPagaNaLoja != null
    ? !!cfg.premiacaoPagaNaLoja
    : PREMIACAO_NA_LOJA_PADRAO.includes(board);
}

// ── Encerramento ───────────────────────────────────────────────────────────
// Duas travas independentes:
//   • a folha da loja inteira  → FP.folha[board].encerrada
//   • a de um colaborador só   → entry.encerrada
// A individual existe para rescisão: o acerto de quem foi demitido é fechado
// antes da folha do resto da loja, e a partir daí nada mais o reescreve — nem
// "Gerar Folha", nem mudança de config, nem o remendo automático da premiação.
function folhaEncerrada(board = FP.board) {
  return !!FP.folha[board]?.encerrada;
}
function entryEncerrada(empId, board = FP.board) {
  return !!FP.folha[board]?.entries?.[empId]?.encerrada;
}
// Congelado = não recalcula, não reescreve, não aceita edição.
function empCongelado(empId, board = FP.board) {
  return folhaEncerrada(board) || entryEncerrada(empId, board);
}

const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function cargoTipo(cargo) {
  const c = (cargo || '').toLowerCase().trim();
  if (/caixa|opcx/.test(c))                    return 'caixa';
  if (/^sub.*gerente|sub[\s-]gerente/.test(c)) return 'sub';
  if (/g\.?\s*vend|gerente\s+vend/.test(c))    return 'gvend';
  if (/gerente/.test(c))                       return 'gerente';
  if (/sócio|socio/.test(c))                   return 'socio';
  if (/supervisor/.test(c))                    return 'supervisor';
  return 'vendedor';
}

// ── Pagamento por fora ────────────────────────────────────────────────────
// Linhas que o funcionário recebe mas que NÃO são declaradas na contabilidade.
// Cada linha abate de um componente declarado (comissão, fixo ou "outros"),
// para que a planilha de contabilidade continue batendo coluna a coluna.
// temFixo: vendedor no regime fixo + comissão também pode ter parte do
// salário fixo paga por fora — comissionista puro não tem fixo a abater.
function foraOrigemOpts(tipo, temFixo = false) {
  if (tipo === 'caixa')    return { fixo: 'Salário fixo', outros: 'Outros' };
  if (tipo === 'socio')    return { comissao: 'Comissão', fixo: 'Pró-labore', outros: 'Outros' };
  if (tipo === 'vendedor') return temFixo
    ? { comissao: 'Comissão', fixo: 'Salário fixo', outros: 'Outros' }
    : { comissao: 'Comissão', outros: 'Outros' };
  return { comissao: 'Comissão', fixo: 'Salário fixo', outros: 'Outros' };
}
function foraOrigemDefault(tipo) { return tipo === 'caixa' ? 'fixo' : 'comissao'; }

// Recebe comissão sobre o total da loja? O sub-gerente pode ter faixas próprias
// (comissaoVRSemMeta/Meta2/Super) mesmo com comissaoVR — meta 1 — zerada.
function temComissaoLoja(tipo, ecfg) {
  return (ecfg.comissaoVR || 0) > 0 ||
    (tipo === 'sub' && !!(ecfg.comissaoVRSemMeta || ecfg.comissaoVRMeta2 || ecfg.comissaoVRSuper));
}

// Prêmio de loja do supervisor/sócio, quebrado por loja supervisionada.
// O detalhe semanal vem do servidor já marcado com o board de origem.
function premiacaoLojaPorBoard(empId, boards) {
  const det = FP.premiacaoSemanalGerDetalhe[empId] || [];
  return boards.map(b => {
    const semanas = det.filter(d => d.board === b);
    return { board: b, valor: r2(semanas.reduce((s, d) => s + r2(d.valor), 0)), semanas };
  });
}

// Empresas que pagam ajuda de custo: as lojas supervisionadas + o escritório
// (board "site"), que não é loja supervisionada mas paga a sua parte.
const AJUDA_BOARDS_EXTRA = ['site'];
const AJUDA_BOARD_LABEL  = { site: 'ESCRITÓRIO' };
function ajudaCustoBoards(emp) {
  const sb = emp?.supervisedBoards || [];
  return [...sb, ...AJUDA_BOARDS_EXTRA.filter(b => !sb.includes(b))];
}

// Ajuda de custo do supervisor/sócio, uma linha por empresa.
// É valor manual — nunca calculado —, então é lido da entry já gravada e
// sobrevive ao Gerar, como o "por fora". Mês sem nada lançado herda o valor do
// mês anterior (é verba fixa): a herança só vale enquanto a folha do mês nunca
// gravou ajuda — depois disso o que está na tela manda, inclusive zerado.
function ajudaCustoPorBoard(empId, boards, prev) {
  const entry = prev || FP.folha[FP.board]?.entries?.[empId] || {};
  const doMes = entry.ajudaCustoLojas;
  const herda = !doMes;
  const salvo = doMes || FP.prevAjudaCusto[empId] || [];
  return boards.map(b => {
    const src   = salvo.find(l => l.board === b);
    const valor = r2(src?.valor || 0);
    // _prev marca "veio do mês anterior, ainda não conferido" — some assim que
    // a entry é gravada pelo formulário
    return valor !== 0 && (herda || src?._prev)
      ? { board: b, valor, _prev: true }
      : { board: b, valor };
  });
}
function somaAjuda(lojas) { return r2((lojas || []).reduce((s, l) => s + r2(l.valor || 0), 0)); }

// ── Rateio do supervisor/sócio entre as lojas supervisionadas ─────────────
// Bruto por loja: 1/N do salário fixo (ou pró-labore) + a comissão e a
// premiação geradas por ela. Feriado e extras ficam na loja-base (onde o
// colaborador é lotado), assim como a sobra de centavos da divisão do fixo.
function calcRateioLojas(emp, tipo, v) {
  const boards = emp?.supervisedBoards || [];
  if (!boards.length) return [];
  const baseBoard = boards.includes(emp.board) ? emp.board : boards[0];
  const fixoTotal = r2(v.fixo || 0);
  const fixoUn    = r2(fixoTotal / boards.length);

  const rows = boards.map(b => {
    const comissao  = r2((v.lojaComissoes   || []).find(l => l.board === b)?.comissao || 0);
    const premiacao = r2((v.premiacaoLojas  || []).find(l => l.board === b)?.valor    || 0);
    const ajuda     = r2((v.ajudaCustoLojas || []).find(l => l.board === b)?.valor    || 0);
    const isBase    = b === baseBoard;
    const outros    = isBase ? r2(v.outros || 0) : 0;
    return { board: b, base: isBase, pagador: pagadorDe(b),
             fixo: fixoUn, comissao, premiacao, ajuda, outros,
             bruto: r2(fixoUn + comissao + premiacao + ajuda + outros) };
  });

  // Sobra da divisão do fixo (ex.: 2388,34 / 3) vai para a loja-base
  const dif = r2(fixoTotal - r2(rows.reduce((s, r) => s + r.fixo, 0)));
  if (dif !== 0) {
    const rb = rows.find(r => r.base) || rows[0];
    rb.fixo = r2(rb.fixo + dif); rb.bruto = r2(rb.bruto + dif);
  }

  // Empresa que só paga ajuda de custo (escritório) entra como linha própria —
  // não divide o salário fixo, que é rateado só entre as lojas supervisionadas.
  (v.ajudaCustoLojas || []).forEach(l => {
    const ajuda = r2(l.valor || 0);
    if (!ajuda || boards.includes(l.board)) return;
    rows.push({ board: l.board, base: false, pagador: pagadorDe(l.board),
                fixo: 0, comissao: 0, premiacao: 0, ajuda, outros: 0, bruto: ajuda });
  });
  return rows;
}

// Agrupa as lojas por quem efetivamente paga. Os descontos são do colaborador,
// não da loja: abatem inteiros do grupo que paga a loja-base — daí o vale
// compras sair do total Minas + Contagem, e não só da Minas.
function calcRateioPagadores(emp, rows, descontos) {
  if (!rows.length) return [];
  const baseRow     = rows.find(r => r.base) || rows[0];
  const basePagador = baseRow.pagador;
  const grupos      = [];
  rows.forEach(r => {
    let g = grupos.find(x => x.pagador === r.pagador);
    if (!g) { g = { pagador: r.pagador, boards: [], bruto: 0, descontos: 0, pagar: 0 }; grupos.push(g); }
    g.boards.push(r.board);
    g.bruto = r2(g.bruto + r.bruto);
  });
  grupos.forEach(g => {
    g.descontos = g.pagador === basePagador ? r2(descontos || 0) : 0;
    g.pagar     = r2(g.bruto - g.descontos);
  });
  return grupos;
}

function rateioSrcFromEntry(emp, e, tipo) {
  const lojaComissoes  = e.lojaComissoes  || [];
  const premiacaoLojas = e.premiacaoLojas || premiacaoLojaPorBoard(emp.id, emp.supervisedBoards || []);
  // Folhas antigas podem ter só os totais gravados, sem a quebra por loja. O que
  // não bater com o total vai para "Outros" na loja-base, para o rateio nunca
  // fechar diferente dos proventos.
  const sobraCom  = r2(r2(e.comissaoTotal     || 0) - r2(lojaComissoes.reduce((s, l) => s + r2(l.comissao || 0), 0)));
  const sobraPrem = r2(r2(e.premiacaoBalanco  || 0) - r2(premiacaoLojas.reduce((s, l) => s + r2(l.valor    || 0), 0)));
  const ajudaCustoLojas = e.ajudaCustoLojas || [];
  return {
    fixo: tipo === 'socio' ? r2((e.proLabore || 0) + (e.complemento || 0)) : r2(e.fixo || 0),
    lojaComissoes, premiacaoLojas, ajudaCustoLojas,
    outros:    r2((e.feriado || 0) + (e.extras || []).reduce((s, ex) => s + r2(ex.valor), 0)
                  + sobraCom + sobraPrem),
    descontos: r2(e.totalDescontos || 0),
  };
}

function rateioSrcFromDom(emp, tipo) {
  const g = id => { const el = document.getElementById(id); return el ? r2(parseFloat(el.value) || 0) : 0; };
  const id     = emp.id;
  const boards = emp.supervisedBoards || [];
  const entry  = FP.folha[FP.board]?.entries?.[id] || {};
  return {
    fixo: tipo === 'socio' ? r2(g(`fp-proLabore-${id}`) + g(`fp-complemento-${id}`)) : g(`fp-fixo-${id}`),
    lojaComissoes:   boards.map(b => ({ board: b, comissao: g(`fp-supCom-${id}-${b}`)   })),
    premiacaoLojas:  boards.map(b => ({ board: b, valor:    g(`fp-premLoja-${id}-${b}`) })),
    ajudaCustoLojas: ajudaCustoBoards(emp).map(b => ({ board: b, valor: g(`fp-ajuda-${id}-${b}`) })),
    outros:    r2(g(`fp-feriado-${id}`) + (entry.extras || []).reduce((s, ex) => s + r2(ex.valor), 0)),
    descontos: r2(g(`fp-valeCompras-${id}`) + g(`fp-adiantamento-${id}`) + g(`fp-inss-${id}`) +
                  g(`fp-irpf-${id}`) + g(`fp-vt-${id}`) + g(`fp-arred-${id}`) + g(`fp-faltasValor-${id}`) +
                  (entry.extrasDesc || []).reduce((s, ex) => s + r2(ex.valor), 0)),
  };
}

const _biOf = b => {
  const bi = BOARDS_INFO[b] || { label: b.toUpperCase(), color: '#8b949e' };
  return AJUDA_BOARD_LABEL[b] ? { ...bi, label: AJUDA_BOARD_LABEL[b] } : bi;
};

// Tabela 1 — quanto cada loja gerou (bruto, sem descontos)
function buildRateioLojasTbl(rows) {
  const temPrem   = rows.some(r => r.premiacao !== 0);
  const temAjuda  = rows.some(r => (r.ajuda || 0) !== 0);
  const temOutros = rows.some(r => r.outros    !== 0);
  const cell = (v, cls = '') => `<td class="fp-rateio-num ${cls}">${v === 0 ? '—' : brl(v)}</td>`;

  let html = `<tr>
    <th style="text-align:left">Loja</th>
    <th>Fixo</th><th>Comissão</th>
    ${temPrem   ? '<th>Premiação</th>'     : ''}
    ${temAjuda  ? '<th>Ajuda de custo</th>' : ''}
    ${temOutros ? '<th>Outros</th>'        : ''}
    <th>Bruto</th>
  </tr>`;

  rows.forEach(r => {
    const bi = _biOf(r.board);
    html += `<tr>
      <td class="fp-rateio-loja" style="color:${bi.color}">${bi.label}${r.base ? ' <span class="fp-rateio-base">base</span>' : ''}</td>
      ${cell(r.fixo)}${cell(r.comissao)}
      ${temPrem   ? cell(r.premiacao)   : ''}
      ${temAjuda  ? cell(r.ajuda || 0)  : ''}
      ${temOutros ? cell(r.outros)      : ''}
      <td class="fp-rateio-num fp-rateio-pagar">${brl(r.bruto)}</td>
    </tr>`;
  });

  const sum = k => r2(rows.reduce((s, r) => s + (r[k] || 0), 0));
  html += `<tr class="fp-rateio-tot">
    <td style="text-align:left">TOTAL</td>
    ${cell(sum('fixo'))}${cell(sum('comissao'))}
    ${temPrem   ? cell(sum('premiacao')) : ''}
    ${temAjuda  ? cell(sum('ajuda'))     : ''}
    ${temOutros ? cell(sum('outros'))    : ''}
    <td class="fp-rateio-num fp-rateio-pagar">${brl(sum('bruto'))}</td>
  </tr>`;
  return `<table class="fp-rateio-tbl">${html}</table>`;
}

// Tabela 2 — quem efetivamente paga, já com os descontos abatidos do grupo
function buildRateioPagadoresTbl(grupos) {
  const temDesc = grupos.some(g => g.descontos !== 0);
  const cell = (v, cls = '') => `<td class="fp-rateio-num ${cls}">${v === 0 ? '—' : brl(v)}</td>`;

  let html = `<tr>
    <th style="text-align:left">Quem paga</th>
    <th>Bruto</th>
    ${temDesc ? '<th>Descontos</th>' : ''}
    <th>A pagar</th>
  </tr>`;

  grupos.forEach(g => {
    const bi = _biOf(g.pagador);
    const cobre = g.boards.length > 1
      ? ` <span class="fp-rateio-cobre">${g.boards.map(b => _biOf(b).label).join(' + ')}</span>` : '';
    html += `<tr>
      <td class="fp-rateio-loja" style="color:${bi.color}">${bi.label}${cobre}</td>
      ${cell(g.bruto)}
      ${temDesc ? cell(g.descontos, 'fp-rateio-desc') : ''}
      <td class="fp-rateio-num fp-rateio-pagar">${brl(g.pagar)}</td>
    </tr>`;
  });

  const sum = k => r2(grupos.reduce((s, g) => s + g[k], 0));
  html += `<tr class="fp-rateio-tot">
    <td style="text-align:left">TOTAL</td>
    ${cell(sum('bruto'))}
    ${temDesc ? cell(sum('descontos'), 'fp-rateio-desc') : ''}
    <td class="fp-rateio-num fp-rateio-pagar">${brl(sum('pagar'))}</td>
  </tr>`;
  return `<table class="fp-rateio-tbl">${html}</table>`;
}

function buildRateioInner(rows, grupos) {
  return buildRateioLojasTbl(rows) +
    `<div class="fp-rateio-sub">Quem paga</div>` +
    buildRateioPagadoresTbl(grupos);
}

function buildRateioBox(emp, e, tipo) {
  if (tipo !== 'supervisor' && tipo !== 'socio') return '';
  const src  = rateioSrcFromEntry(emp, e, tipo);
  const rows = calcRateioLojas(emp, tipo, src);
  if (rows.length < 2) return '';
  const grupos = calcRateioPagadores(emp, rows, src.descontos);
  const nLojas = (emp.supervisedBoards || []).length || rows.length;
  const nota = `1/${nLojas} do ${tipo === 'socio' ? 'pró-labore' : 'salário fixo'} + comissão, premiação` +
    (rows.some(r => (r.ajuda || 0) !== 0) ? ' e ajuda de custo' : '') + ' de cada loja';
  return `
    <div class="fp-rateio-box">
      <div class="fp-rateio-head">
        <span class="fp-rateio-title">Rateio por loja</span>
        <span class="fp-rateio-note">${nota}</span>
        <span class="fp-rateio-total" id="val-rateio-${emp.id}"
              title="Soma do que cada grupo paga, já com os descontos abatidos">${brl(r2(grupos.reduce((s, g) => s + g.pagar, 0)))}</span>
      </div>
      <div id="rateio-rows-${emp.id}">${buildRateioInner(rows, grupos)}</div>
    </div>`;
}

function updateRateio(empId) {
  const body = document.getElementById(`rateio-rows-${empId}`);
  if (!body) return;
  const emp    = FP.employees.find(x => x.id === empId);
  const tipo   = cargoTipo(emp?.cargo);
  const src    = rateioSrcFromDom(emp, tipo);
  const rows   = calcRateioLojas(emp, tipo, src);
  const grupos = calcRateioPagadores(emp, rows, src.descontos);
  body.innerHTML = buildRateioInner(rows, grupos);
  const tot = document.getElementById(`val-rateio-${empId}`);
  if (tot) tot.textContent = brl(r2(grupos.reduce((s, g) => s + g.pagar, 0)));
}

// Premiação semanal calculada pelo servidor. Serve de referência para detectar
// quando o valor gravado foi ajustado à mão — nesse caso a entry ganha a flag
// premiacaoManual e deixa de ser sobrescrita ao trocar de aba.
function premiacaoCalculada(emp) {
  if (!emp) return { premiacao: 0, premiacaoBalanco: 0, premiacaoNaLoja: 0 };
  const t    = cargoTipo(emp.cargo);
  const ecfg = getEmpCfg(emp);
  const ger  = r2(FP.premiacaoSemanalGer[emp.id] || 0);
  const sem  = t === 'gerente' ? ger : r2(FP.premiacaoSemanal[emp.id] || 0);
  // Loja que paga o prêmio na semana: o valor sai da folha e vira só memória.
  // Folha encerrada é histórico — o que foi pago naquele mês não se mexe.
  // Sócio, supervisor e caixa não têm prêmio semanal na entry: não há o que tirar.
  const temSemanal = !['socio', 'supervisor', 'caixa'].includes(t);
  const naLoja = (temSemanal && premiacaoPagaNaLoja(emp.board)
                  && !empCongelado(emp.id, emp.board)) ? sem : 0;
  return {
    premiacao:        r2(sem - naLoja),
    premiacaoBalanco: (t === 'gvend' || ecfg.recebePremiaoLoja) ? ger : 0,
    premiacaoNaLoja:  naLoja,
  };
}

// Base da divisão para contabilidade (comissão contab + DSR + prêmio).
// Sub-gerente é vendedor com comissionamento sobre a loja: a comissão da loja
// entra na mesma divisão da comissão própria e portanto também gera DSR.
function baseDivisaoContab(tipo, comissao, comissaoLoja) {
  return r2(comissao + (tipo === 'sub' ? r2(comissaoLoja || 0) : 0));
}

function foraBreakdown(entry, tipo) {
  const opts = foraOrigemOpts(tipo, r2(entry?.fixo || 0) > 0);
  let com = 0, fixo = 0, outros = 0;
  for (const f of (entry?.fora || [])) {
    const v = r2(f.valor);
    if (!v) continue;
    const org = opts[f.origem] ? f.origem : foraOrigemDefault(tipo);
    if      (org === 'fixo')   fixo   += v;
    else if (org === 'outros') outros += v;
    else                       com    += v;
  }
  return { com: r2(com), fixo: r2(fixo), outros: r2(outros), total: r2(com + fixo + outros) };
}

function foraDe(empId) {
  const emp = FP.employees.find(e => e.id === empId);
  return foraBreakdown(FP.folha[FP.board]?.entries?.[empId], cargoTipo(emp?.cargo));
}

// defaultEntry não conhece o "por fora" (é decisão manual, não valor calculado).
// Depois de recalcular uma entry, reaplica o abatimento: proventos e líquido
// passam a ser os valores DECLARADOS e totalGeral é o que o funcionário recebe.
function applyFora(entry, emp, fora) {
  if (!fora?.length) return entry;
  const tipo = entry.tipo || cargoTipo(emp.cargo);
  const ecfg = getEmpCfg(emp);
  entry.fora = fora;
  const fb = foraBreakdown(entry, tipo);

  entry.proventosBruto = r2(entry.proventos);
  entry.proventos      = r2(entry.proventosBruto - fb.total);
  entry.foraComissao = fb.com;    entry.foraFixo  = fb.fixo;
  entry.foraOutros   = fb.outros; entry.totalFora = fb.total;
  entry.comissaoDeclarada = r2((entry.comissaoTotal || 0) - fb.com);
  entry.fixoDeclarado     = r2((tipo === 'socio' ? (entry.proLabore || 0) : (entry.fixo || 0)) - fb.fixo);

  if (entry.comissaoContab != null) {
    const du = FP.mensal.diasUteis || 22, df = FP.mensal.domingosFeriados || 4;
    const base = baseDivisaoContab(tipo, entry.comissaoDeclarada, entry.comissaoLoja);
    entry.dsr            = (du + df) > 0 ? r2(base * df / (du + df)) : 0;
    entry.comissaoContab = r2(base - entry.dsr - (entry.premio || 0));
  }

  // Ajuda de custo é verba indenizatória — fora da base de INSS/VT
  const baseEnc = r2(entry.proventos - (entry.ajudaCustoTotal || 0));
  entry.inss = r2(baseEnc * (ecfg.inssRate || 0) / 100);
  entry.vt   = r2(baseEnc * (ecfg.vtRate   || 0) / 100);
  entry.totalDescontos = r2((entry.valeCompras || 0) + (entry.adiantamento || 0)
    + entry.inss + (entry.irpf || 0) + entry.vt + (entry.arredondamento || 0)
    + (entry.faltasValor || 0)
    + (entry.extrasDesc || []).reduce((s, x) => s + r2(x.valor), 0));
  entry.liquido    = r2(entry.proventos - entry.totalDescontos);
  entry.totalGeral = r2(entry.liquido + fb.total);
  return entry;
}

// ── Config efetiva do funcionário (folha prevalece sobre cadastro) ─────────
function getEmpCfg(emp) {
  const fc = FP.empConfig[emp.id] || {};
  const v  = (a, b) => a != null ? a : b;
  return {
    comissaoSemMeta: v(fc.comissaoSemMeta, emp.comissaoSemMeta || 0),
    comissao:        v(fc.comissao,        emp.comissao        || 0),
    comissaoMeta2:   v(fc.comissaoMeta2,   emp.comissaoMeta2   || 0),
    comissaoSuper:   v(fc.comissaoSuper,   emp.comissaoSuper   || 0),
    comissaoGerente: v(fc.comissaoGerente, emp.comissaoGerente || 0),
    comissaoVR:      v(fc.comissaoVR,      emp.comissaoVR      || 0),
    salarioFixo:     v(fc.salarioFixo,     emp.salarioFixo     || 0),
    quebraCaixa:     v(fc.quebraCaixa,     emp.quebraCaixa     || 0),
    inssRate:           v(fc.inssRate,           emp.inssRate           || 0),
    vtRate:             v(fc.vtRate,             emp.vtRate             || 0),
    maxVT:              v(fc.maxVT,              emp.maxVT              || 0),
    recebePremiaoLoja:   fc.recebePremiaoLoja  || false,
    // Vendedor no regime fixo + comissão: ganha salário fixo e não recebe
    // complemento de garantia mínima — o fixo já é o piso dele.
    vendedorComFixo:     fc.vendedorComFixo != null ? !!fc.vendedorComFixo : !!emp.vendedorComFixo,
    premioLojaValor:     v(fc.premioLojaValor,     0),
    comissaoVRSemMeta:   v(fc.comissaoVRSemMeta,   0),
    comissaoVRMeta2:     v(fc.comissaoVRMeta2,     0),
    comissaoVRSuper:     v(fc.comissaoVRSuper,     0),
  };
}

// ── Faixa por vendas vs metas do funcionário ───────────────────────────────
// Thresholds idênticos ao fechamento diário: meta1=meta, meta2=meta×1.10, super=meta×1.10×1.20
function calcFaixa(ecfg, vendas, meta) {
  const meta1  = r2(meta);
  const meta2  = r2(meta * 1.10);
  const super_ = r2(meta * 1.10 * 1.20);

  if (meta > 0 && vendas >= super_)
    return { label: 'SUPER META', comPct: r2(ecfg.comissaoSuper || ecfg.comissao || 0), meta1, meta2, super: super_ };
  if (meta > 0 && vendas >= meta2)
    return { label: 'META 2',     comPct: r2(ecfg.comissaoMeta2 || ecfg.comissao || 0), meta1, meta2, super: super_ };
  if (meta > 0 && vendas >= meta1)
    return { label: 'META 1',     comPct: r2(ecfg.comissao      || 0),                meta1, meta2, super: super_ };
  return       { label: meta > 0 ? 'SEM META' : '—',
                 comPct: r2(ecfg.comissaoSemMeta || ecfg.comissao || 0),                meta1, meta2, super: super_ };
}

// ── State ──────────────────────────────────────────────────────────────────
let FP = {
  year: 0, month: 0, board: '',
  employees: [], vsales: {},
  folha: {}, folhaConfig: {}, empConfig: {},
  mensal: { diasUteis: 22, domingosFeriados: 4 },
  lojaMetaMap: {}, lojaVendaMap: {},
  supervisorVendaMap: {}, supervisorMetaMap: {},
  premiacaoSemanal: {}, premiacaoSemanalDetalhe: {},
  premiacaoSemanalGer: {}, premiacaoSemanalGerDetalhe: {}, prevExtras: {},
  prevAjudaCusto: {},
  adiantamentos: {}, adiantamentosSemVinculo: [],
  faltasLoja: {}, faltasSemVinculo: [],
  activeEmpId: null, dirty: false,
};

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (m === 0) { m = 12; y--; }
  const mSel = document.getElementById('fpMonth');
  const ySel = document.getElementById('fpYear');
  for (let i = 0; i < 12; i++) {
    const o = document.createElement('option');
    o.value = i+1; o.textContent = MONTHS_PT[i];
    if (i+1 === m) o.selected = true;
    mSel.appendChild(o);
  }
  for (let i = y-1; i <= y+1; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = i;
    if (i === y) o.selected = true;
    ySel.appendChild(o);
  }
  mSel.addEventListener('change', loadPeriod);
  ySel.addEventListener('change', loadPeriod);
  renderStoreButtons('');
  await loadPeriod();
})();

async function loadPeriod() {
  FP.year  = parseInt(document.getElementById('fpYear').value);
  FP.month = parseInt(document.getElementById('fpMonth').value);
  FP.board = ''; FP.dirty = false;
  document.getElementById('fpPanel').innerHTML = '<div class="fp-empty">Carregando…</div>';
  try {
    const d = await apiFetch(`/api/folha/${FP.year}/${FP.month}`);
    FP.employees    = d.employees    || [];
    FP.vsales       = d.vsales       || {};
    FP.folha        = d.folha        || {};
    FP.folhaConfig  = d.folhaConfig  || {};
    FP.empConfig    = d.empConfig    || {};
    FP.lojaMetaMap        = d.lojaMetaMap        || {};
    FP.lojaVendaMap       = d.lojaVendaMap       || {};
    FP.supervisorVendaMap = d.supervisorVendaMap || {};
    FP.supervisorMetaMap  = d.supervisorMetaMap  || {};
    FP.premiacaoSemanal           = d.premiacaoSemanal           || {};
    FP.premiacaoSemanalDetalhe    = d.premiacaoSemanalDetalhe    || {};
    FP.premiacaoSemanalGer        = d.premiacaoSemanalGer        || {};
    FP.premiacaoSemanalGerDetalhe = d.premiacaoSemanalGerDetalhe || {};
    FP.prevExtras              = d.prevExtras              || {};
    FP.prevAjudaCusto          = d.prevAjudaCusto          || {};
    FP.adiantamentos           = d.adiantamentos           || {};
    FP.adiantamentosSemVinculo = d.adiantamentosSemVinculo || [];
    FP.faltasLoja              = d.faltasLoja              || {};
    FP.faltasSemVinculo        = d.faltasSemVinculo        || [];
    FP.mensal = {
      diasUteis:        d.folhaMensal?.diasUteis        || 22,
      domingosFeriados: d.folhaMensal?.domingosFeriados || 4,
    };
    renderMensalBar();
    renderStoreButtons('');
    document.getElementById('fpPanel').innerHTML =
      '<div class="fp-empty">Selecione uma loja para ver a folha.</div>';
  } catch(e) {
    document.getElementById('fpPanel').innerHTML =
      `<div class="fp-empty" style="color:#f85149">${e.message}</div>`;
  }
}

// ── Barra de config mensal ─────────────────────────────────────────────────
function renderMensalBar() {
  document.getElementById('fpMensalBar').innerHTML = `
    <span style="font-size:.8rem;color:#8b949e">Dias úteis:</span>
    <input type="number" id="fpDiasUteis" value="${FP.mensal.diasUteis}" min="1" max="31"
      style="width:52px;background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:.25rem .4rem;border-radius:5px;font-size:.85rem;text-align:center"
      onchange="saveMensal()">
    <span style="font-size:.8rem;color:#8b949e;margin-left:.75rem">Dom./Feriados:</span>
    <input type="number" id="fpDomingosFeriados" value="${FP.mensal.domingosFeriados}" min="0" max="15"
      style="width:52px;background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:.25rem .4rem;border-radius:5px;font-size:.85rem;text-align:center"
      onchange="saveMensal()">
    <span style="font-size:.72rem;color:#484f58;margin-left:.5rem">aplica a todas as lojas do mês</span>`;
}

let _mensalTimer;
function saveMensal() {
  const du = parseInt(document.getElementById('fpDiasUteis')?.value)          || 22;
  const df = parseInt(document.getElementById('fpDomingosFeriados')?.value)   || 4;
  FP.mensal = { diasUteis: du, domingosFeriados: df };
  clearTimeout(_mensalTimer);
  _mensalTimer = setTimeout(async () => {
    try {
      await apiFetch(`/api/folha/${FP.year}/${FP.month}/mensal`, 'POST', FP.mensal);
      toast('Config mensal salva.');
    } catch(e) { toast('Erro: '+e.message, true); }
  }, 800);
}

function renderStoreButtons(active) {
  document.getElementById('fpStores').innerHTML = STORE_BOARDS
    .filter(b => FP.employees.some(e => e.board === b))
    .map(b => {
      const saved = !!(FP.folha[b]?.entries && Object.keys(FP.folha[b].entries).length);
      const enc   = !!(FP.folha[b]?.encerrada);
      return `<button class="fp-store-btn${b===active?' active':''}"
        style="--c:${BOARDS_INFO[b].color}" onclick="selectBoard('${b}')">
        ${BOARDS_INFO[b].label}${enc?' ⊠':saved?' ✓':''}
      </button>`;
    }).join('');
}

async function selectBoard(board) {
  if (FP.dirty && !confirm('Alterações não salvas. Descartar?')) return;
  FP.board = board; FP.activeEmpId = null; FP.dirty = false;
  renderStoreButtons(board);
  renderPanel();
}

// ── Panel ──────────────────────────────────────────────────────────────────
function renderPanel() {
  const board = FP.board;
  const info  = BOARDS_INFO[board];
  const enc   = !!(FP.folha[board]?.encerrada);

  const actionBtns = enc
    ? `<button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
       <button class="fp-btn" onclick="fpExportarContabilidade()">Contabilidade</button>
       <button class="fp-btn reabrir" onclick="fpEncerrar()">Reabrir Folha</button>
       <button class="fp-btn" onclick="fpImprimirRecibos()">Recibos</button>`
    : `<button class="fp-btn" onclick="fpOpenCfg('${board}')">Configurar</button>
       <button class="fp-btn" onclick="fpGerar()">Gerar Folha</button>
       <button class="fp-btn warning" onclick="fpSalvar()">Salvar</button>
       <button class="fp-btn success" onclick="fpExportar()">Exportar Excel</button>
       <button class="fp-btn" onclick="fpExportarContabilidade()">Contabilidade</button>
       <button class="fp-btn encerrar" onclick="fpEncerrar()">Encerrar Folha</button>
       <button class="fp-btn" disabled style="opacity:.35;cursor:not-allowed" title="Encerre a folha para imprimir recibos">Recibos</button>`;

  document.getElementById('fpPanel').innerHTML = `
    <div class="fp-panel${enc ? ' fp-panel-encerrada' : ''}">
      <div class="fp-panel-header">
        <span class="fp-panel-title" style="color:${info.color}">${info.label}</span>
        ${enc ? '<span style="font-size:.72rem;color:#3fb950;margin-left:.5rem">● Encerrada</span>' : '<div style="font-size:.72rem;color:#8b949e;margin-left:.4rem">vendas: Microvix</div>'}
        <div class="fp-panel-actions">${actionBtns}</div>
      </div>
      <div class="fp-emp-tabs" id="fpEmpTabs"></div>
      <div id="fpEmpForms"></div>
    </div>`;
  const emps = boardEmps(board);
  renderEmpTabs(emps);
  selectTotal();
}

function boardEmps(board) {
  return FP.employees.filter(e => e.board === board);
}

function buildTotalForm(emps) {
  if (!emps.length) return '<div style="padding:2rem;color:#8b949e;text-align:center">Nenhum funcionário nesta loja.</div>';
  let totalProv = 0, totalDesc = 0, totalLiq = 0, totalFora = 0;

  // ── Acumuladores para o resumo de custos ──────────────────────────────────
  // fixoAll  = salário fixo + quebra de caixa + pró-labore + complemento (sócio)
  // comVend  = comissão sobre vendas individuais (todos os cargos)
  // comLoja  = comissão sobre total da loja (comissaoVR — caixa, gerência, sub)
  // gmTotal  = complemento de garantia mínima (todos)
  // prem*    = premiações, extras, feriado (todos)
  // Invariante: fixoAll + comVend + comLoja + gmTotal + totalPremiacoes = totalProv
  let fixoAll = 0, fixoSubRows = [];
  let comVend = 0, vendasVend = 0;
  let comSup = 0;
  let comLoja = 0;
  let gmTotal = 0;
  let premiacaoTotal = 0, premiacaoLojaTotal = 0;
  let extrasTotal = 0, feriadoTotal = 0;
  let ajudaCustoAll = 0;
  // Prêmio já pago pelo caixa da loja: fica fora do invariante acima de
  // propósito — é memória de conferência, não custo da folha.
  let premiacaoNaLojaAll = 0;

  const rows = emps.map(emp => {
    let entry = FP.folha[FP.board]?.entries?.[emp.id] || defaultEntry(emp);
    const _ct = cargoTipo(emp.cargo);
    // Linha congelada é o que foi pago: o resumo mostra o gravado, sem remendar.
    if (!empCongelado(emp.id)) {
      const _calc = premiacaoCalculada(emp);
      if (!entry.premiacaoManual &&
          (_calc.premiacao !== r2(entry.premiacao || 0)
           || _calc.premiacaoBalanco !== r2(entry.premiacaoBalanco || 0)
           || _calc.premiacaoNaLoja !== r2(entry.premiacaoNaLoja || 0))) {
        entry = applyFora(defaultEntry(emp), emp, entry.fora);
      }
    }
    const _fb = foraBreakdown(entry, _ct);
    totalProv += entry.proventos      || 0;
    totalDesc += entry.totalDescontos || 0;
    totalLiq  += entry.liquido        || 0;
    totalFora += _fb.total;

    // fixo — componente varia por cargo
    let empFixo = 0;
    if (_ct === 'caixa') {
      empFixo = r2((entry.fixo || 0) + (entry.quebra || 0));
    } else if (_ct === 'socio') {
      empFixo = r2((entry.proLabore || 0) + (entry.complemento || 0));
    } else if (_ct === 'gerente' || _ct === 'gvend' || _ct === 'sub' || _ct === 'supervisor') {
      empFixo = r2(entry.fixo || 0);
    }
    if (empFixo > 0) {
      fixoAll += empFixo;
      fixoSubRows.push({ nome: emp.apelido || emp.name.split(' ')[0], cargo: emp.cargo, valor: empFixo });
    }

    // comissão individual: só quem vende por conta própria
    // gerente/socio/supervisor têm comissaoTotal calculado sobre total da loja → vai para comLoja
    if (_ct === 'gerente' || _ct === 'socio') {
      comLoja += entry.comissaoTotal || 0;
    } else if (_ct === 'supervisor') {
      comSup += entry.comissaoTotal || 0;
    } else {
      // vendedor, sub, gvend
      comVend    += entry.comissaoTotal || 0;
      vendasVend += entry.vendas        || 0;
    }
    // comissaoLoja (comissaoVR) → sempre sobre total da loja
    comLoja    += entry.comissaoLoja  || 0;
    // demais
    gmTotal          += entry.gmComplement      || 0;
    premiacaoTotal   += entry.premiacao         || 0;
    premiacaoLojaTotal += entry.premiacaoBalanco || 0;
    extrasTotal      += (entry.extras || []).reduce((s, ex) => s + r2(ex.valor), 0);
    feriadoTotal     += entry.feriado           || 0;
    ajudaCustoAll    += entry.ajudaCustoTotal   || 0;
    premiacaoNaLojaAll += entry.premiacaoNaLoja || 0;

    const _fer = feriasDe(emp);
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:.4rem .5rem;color:#e6edf3">${emp.apelido || emp.name.split(' ')[0]}${
        _fer ? ` <span class="fp-ferias-badge">🌴 férias ${fmtDiaMes(_fer.ini)}–${fmtDiaMes(_fer.fim)}</span>` : ''}</td>
      <td style="padding:.4rem .5rem;color:#8b949e;font-size:.78rem">${emp.cargo}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#e6edf3">${brl(entry.proventos||0)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#f85149">${brl(entry.totalDescontos||0)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#3fb950;font-weight:600">${brl(entry.liquido||0)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:${_fb.total>0?'#d29922':'#484f58'}">${brl(_fb.total)}</td>
      <td style="padding:.4rem .5rem;text-align:right;color:#e6edf3;font-weight:600">${brl(r2((entry.liquido||0)+_fb.total))}</td>
    </tr>`;
  }).join('');

  // ── Cálculos do resumo ────────────────────────────────────────────────────
  const vendaLoja      = r2(FP.lojaVendaMap[FP.board] || 0);
  fixoAll              = r2(fixoAll);
  comVend              = r2(comVend);
  comLoja              = r2(comLoja);
  gmTotal              = r2(gmTotal);
  premiacaoTotal       = r2(premiacaoTotal);
  premiacaoLojaTotal   = r2(premiacaoLojaTotal);
  extrasTotal          = r2(extrasTotal);
  feriadoTotal         = r2(feriadoTotal);
  comSup                 = r2(comSup);
  totalFora              = r2(totalFora);
  ajudaCustoAll          = r2(ajudaCustoAll);
  const totalPremiacoes  = r2(premiacaoTotal + premiacaoLojaTotal + extrasTotal + feriadoTotal);
  const totalBruto       = r2(fixoAll + comVend + comSup + comLoja + gmTotal + totalPremiacoes + ajudaCustoAll);
  const totalResumo      = r2(totalBruto - totalFora);
  const totalProvR       = r2(totalProv);
  const diff             = r2(totalProvR - totalResumo);
  const confOk           = Math.abs(diff) < 0.02;

  const pct = (v) => vendaLoja > 0 ? ` <span style="color:#8b949e;font-size:.75rem">(${(v/vendaLoja*100).toFixed(1)}%)</span>` : '';

  const custRow = (label, valor, color='#e6edf3') =>
    `<tr style="border-bottom:1px solid #1a1f26">
      <td style="padding:.35rem .5rem;color:${color};font-size:.82rem">${label}</td>
      <td style="padding:.35rem .5rem;text-align:right;color:${color};white-space:nowrap">${brl(valor)}${pct(valor)}</td>
      <td></td>
    </tr>`;

  const subRow = (label, valor) =>
    `<div style="display:flex;justify-content:space-between;font-size:.72rem;color:#8b949e;padding:.1rem .4rem .1rem 1rem"><span>${label}</span><span>${brl(valor)}</span></div>`;

  const fixoSubHtml = fixoSubRows.map(r => subRow(`${r.nome} (${r.cargo})`, r.valor)).join('');

  const premSubHtml = [
    premiacaoTotal     > 0 ? subRow('Meta semanal', premiacaoTotal) : '',
    premiacaoLojaTotal > 0 ? subRow('Prêmio loja/balanço', premiacaoLojaTotal) : '',
    extrasTotal        > 0 ? subRow('Extras (Instagram, dobra, abertura…)', extrasTotal) : '',
    feriadoTotal       > 0 ? subRow('Feriados', feriadoTotal) : '',
  ].filter(Boolean).join('');

  const resumo = `
  <div style="margin-top:1.25rem;border:1px solid #30363d;border-radius:.5rem;overflow:hidden">
    <div style="background:#161b22;padding:.5rem .75rem;font-size:.72rem;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between;align-items:center">
      <span>Custo da Folha — Composição</span>
      ${vendaLoja > 0 ? `<span style="font-weight:400;color:#484f58">Vendas loja: ${brl(vendaLoja)}</span>` : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:.83rem">
      <tbody>
        ${fixoAll > 0 ? `
        <tr style="border-bottom:${fixoSubHtml ? '0' : '1px solid #1a1f26'}">
          <td style="padding:.35rem .5rem;font-size:.82rem;color:#e6edf3">Fixos (salário, pró-labore, quebra caixa)</td>
          <td style="padding:.35rem .5rem;text-align:right;white-space:nowrap;color:#e6edf3">${brl(fixoAll)}${pct(fixoAll)}</td>
          <td></td>
        </tr>
        ${fixoSubHtml ? `<tr><td colspan="3" style="padding:0 0 .3rem">${fixoSubHtml}</td></tr>` : ''}` : ''}
        ${comVend > 0 ? custRow('Comissão Vendedores (individual)', comVend) : ''}
        ${comSup  > 0 ? custRow('Comissão Supervisor', comSup) : ''}
        ${comLoja > 0 ? custRow('Comissão sobre total da loja (gerência/caixa)', comLoja) : ''}
        ${gmTotal > 0 ? custRow('Complemento Garantia Mínima', gmTotal, '#f59e0b') : ''}
        ${totalPremiacoes > 0 ? `
        <tr style="border-bottom:${premSubHtml ? '0' : '1px solid #1a1f26'}">
          <td style="padding:.35rem .5rem;font-size:.82rem;color:#e6edf3">Premiações</td>
          <td style="padding:.35rem .5rem;text-align:right;white-space:nowrap;color:#e6edf3">${brl(totalPremiacoes)}${pct(totalPremiacoes)}</td>
          <td></td>
        </tr>
        ${premSubHtml ? `<tr><td colspan="3" style="padding:0 0 .3rem">${premSubHtml}</td></tr>` : ''}` : ''}
        ${ajudaCustoAll > 0 ? custRow('Ajuda de custo', ajudaCustoAll) : ''}
        ${totalFora > 0 ? `
        <tr style="border-bottom:1px solid #1a1f26">
          <td style="padding:.35rem .5rem;color:#d29922;font-size:.82rem">(−) Pago por fora (não declarado)</td>
          <td style="padding:.35rem .5rem;text-align:right;color:#d29922;white-space:nowrap">− ${brl(totalFora)}</td>
          <td></td>
        </tr>` : ''}
        <tr style="border-top:2px solid #30363d;background:#0d1117">
          <td style="padding:.5rem .5rem;color:#58a6ff;font-weight:700;font-size:.85rem">TOTAL PROVENTOS${totalFora > 0 ? ' (contabilidade)' : ''}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#58a6ff;font-weight:700;font-size:.9rem;white-space:nowrap">${brl(totalResumo)}${pct(totalResumo)}</td>
          <td style="padding:.5rem .5rem;font-size:.75rem;white-space:nowrap">
            ${confOk
              ? `<span style="color:#3fb950">✓ confere com proventos</span>`
              : `<span style="color:#f85149" title="Diferença: ${brl(diff)}">⚠ diferença ${brl(diff)}</span>`}
          </td>
        </tr>
        ${totalFora > 0 ? `
        <tr style="background:#0d1117">
          <td style="padding:.5rem .5rem;color:#d29922;font-weight:700;font-size:.85rem">TOTAL GERAL (contab. + por fora)</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#d29922;font-weight:700;font-size:.9rem;white-space:nowrap">${brl(totalBruto)}${pct(totalBruto)}</td>
          <td></td>
        </tr>` : ''}
      </tbody>
    </table>
    ${premiacaoNaLojaAll > 0 ? `
    <div style="border-top:1px solid #30363d;background:#12151b;padding:.5rem .75rem;display:flex;justify-content:space-between;align-items:center;gap:.75rem">
      <span style="font-size:.78rem;color:#d29922">Premiação semanal paga pelo caixa da loja <span style="color:#484f58">— já quitada, fora dos proventos acima</span></span>
      <span style="font-size:.83rem;color:#d29922;font-weight:600;white-space:nowrap">${brl(r2(premiacaoNaLojaAll))}</span>
    </div>` : ''}
  </div>`;

  return `
  <div class="fp-emp-form active" id="empform-total" style="padding:.75rem 0">
    <table style="width:100%;border-collapse:collapse;font-size:.85rem">
      <thead>
        <tr style="border-bottom:2px solid #30363d">
          <th style="text-align:left;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Funcionário</th>
          <th style="text-align:left;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Cargo</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Proventos</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Descontos</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Líquido</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#d29922;font-size:.73rem;text-transform:uppercase;font-weight:600">Por Fora</th>
          <th style="text-align:right;padding:.35rem .5rem;color:#8b949e;font-size:.73rem;text-transform:uppercase;font-weight:600">Total Geral</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #30363d">
          <td colspan="2" style="padding:.5rem .5rem;color:#8b949e;font-size:.75rem;text-transform:uppercase;font-weight:700">TOTAL DA LOJA</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#e6edf3;font-weight:700">${brl(r2(totalProv))}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#f85149;font-weight:700">${brl(r2(totalDesc))}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#3fb950;font-weight:700">${brl(r2(totalLiq))}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#d29922;font-weight:700">${brl(totalFora)}</td>
          <td style="padding:.5rem .5rem;text-align:right;color:#e6edf3;font-weight:700">${brl(r2(totalLiq + totalFora))}</td>
        </tr>
      </tfoot>
    </table>
    ${resumo}
  </div>`;
}

function renderEmpTabs(emps) {
  const lojaData = FP.folha[FP.board] || {};
  const totalBtn = `<button id="tab-total" class="fp-emp-tab" onclick="selectTotal()">
    TOTAL <span style="font-size:.68rem;opacity:.6;margin-left:.2rem">loja</span>
  </button>`;
  document.getElementById('fpEmpTabs').innerHTML = totalBtn + emps.map(e => {
    const has = !!(lojaData.entries?.[e.id]);
    const enc = !!(lojaData.entries?.[e.id]?.encerrada);
    return `<button id="tab-${e.id}"
      class="fp-emp-tab${has?' has-data':''}${enc?' enc':''}${e.id===FP.activeEmpId?' active':''}"
      onclick="selectEmp(${e.id})"${enc?' title="Folha individual encerrada"':''}>
      ${enc?'⊠ ':''}${e.apelido || e.name.split(' ')[0]}
      <span style="font-size:.68rem;opacity:.6;margin-left:.2rem">${e.cargo}</span>
    </button>`;
  }).join('');
}

function selectTotal() {
  FP.activeEmpId = null;
  boardEmps(FP.board).forEach(e => document.getElementById(`tab-${e.id}`)?.classList.remove('active'));
  document.getElementById('tab-total')?.classList.add('active');
  document.getElementById('fpEmpForms').innerHTML = buildTotalForm(boardEmps(FP.board));
}

function selectEmp(empId) {
  FP.activeEmpId = empId;
  document.getElementById('tab-total')?.classList.remove('active');
  boardEmps(FP.board).forEach(e => {
    document.getElementById(`tab-${e.id}`)?.classList.toggle('active', e.id === empId);
  });
  const emp   = FP.employees.find(e => e.id === empId);
  let entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
  // Aplica o valor calculado pelo servidor para premiação semanal — exceto se o
  // valor gravado foi ajustado à mão (premiacaoManual), que tem prioridade.
  const _calc = premiacaoCalculada(emp);
  const calcPrem     = entry.premiacaoManual ? r2(entry.premiacao || 0)        : _calc.premiacao;
  const calcPremGer2 = entry.premiacaoManual ? r2(entry.premiacaoBalanco || 0) : _calc.premiacaoBalanco;
  // Em folha encerrada — da loja ou só deste colaborador — o que está gravado é
  // o que foi pago: a premiação recalculada pelo servidor não substitui histórico.
  const encerrada = empCongelado(empId);
  if (!encerrada && calcPrem !== r2(entry.premiacao || 0)) {
    entry = { ...entry, premiacao: calcPrem };
  }
  if (!encerrada && calcPremGer2 !== r2(entry.premiacaoBalanco || 0)) {
    entry = { ...entry, premiacaoBalanco: calcPremGer2 };
  }
  // premiacaoNaLoja não é remendado aqui de propósito: enquanto a entry gravada
  // não tiver o campo, o resumo da loja continua detectando a defasagem e
  // recalculando os proventos por defaultEntry. Quem grava é saveEntryFromForm.
  document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
  attachFormListeners(empId);
  recalc(empId);
}

// ── Config ─────────────────────────────────────────────────────────────────
function fpOpenCfg(board) {
  const cfg  = FP.folhaConfig[board] || {};
  const f2   = v => (parseFloat(v)||0).toFixed(2);
  const emps = boardEmps(board);

  // Tabela de metas por funcionário (somente leitura, para conferência)
  const metaLoja  = r2(FP.lojaMetaMap[board]  || 0);
  const vendaLoja = r2(FP.lojaVendaMap[board] || 0);

  const metaRows = emps.map(emp => {
    const tipo   = cargoTipo(emp.cargo);
    const ecfg   = getEmpCfg(emp);
    const vs     = FP.vsales[emp.id] || {};
    const meta   = tipo === 'gerente' ? metaLoja : r2(vs.meta?.mensal || 0);
    const meta2  = r2(meta * 1.10);
    const super_ = r2(meta * 1.10 * 1.20);
    const vendas = tipo === 'gerente' ? vendaLoja : sumVendas(emp.id);
    const faixa  = calcFaixa(ecfg, vendas, meta);
    const faixaColor = {'SEM META':'#8b949e','META 1':'#d29922','META 2':'#3fb950','SUPER META':'#22d3ee','—':'#484f58'};
    const fc = faixaColor[faixa.label] || '#8b949e';
    return `<tr>
      <td style="padding:.3rem .5rem;color:#e6edf3">${emp.apelido || emp.name.split(' ')[0]}</td>
      <td style="padding:.3rem .5rem;color:#8b949e;font-size:.78rem">${emp.cargo}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#e6edf3">${brl(meta)}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#d29922">${meta > 0 ? brl(meta2) : '—'}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#22d3ee">${meta > 0 ? brl(super_) : '—'}</td>
      <td style="padding:.3rem .5rem;text-align:right;color:#58a6ff">${brl(vendas)}</td>
      <td style="padding:.3rem .4rem;text-align:center">
        <span style="font-size:.72rem;padding:.1rem .35rem;border-radius:4px;background:${fc}22;color:${fc};border:1px solid ${fc}44">${faixa.label}</span>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('fpConfigModal').classList.add('open');
  document.getElementById('fpConfigModal').dataset.board = board;
  document.getElementById('fpConfigTabs').textContent = `Configuração — ${BOARDS_INFO[board].label}`;

  document.getElementById('fpConfigContents').innerHTML = `
    <div class="fp-modal-tabs" id="fpCfgTabBtns">
      <button class="fp-modal-tab active" onclick="fpCfgTabSwitch('geral')">Geral</button>
      <button class="fp-modal-tab" onclick="fpCfgTabSwitch('metas')">Metas / Faixas</button>
    </div>

    <div class="fp-modal-content active" id="cfg-tab-geral">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.5rem">
        <div class="fp-cfg-field"><label>Salário Fixo Caixa (R$)</label>
          <input type="number" step="0.01" id="cfg-fixoCaixa" value="${f2(cfg.salarioFixoCaixa)}">
        </div>
        <div class="fp-cfg-field"><label>Quebra de Caixa (R$)</label>
          <input type="number" step="0.01" id="cfg-quebraCaixa" value="${f2(cfg.quebraCaixa)}">
        </div>
        <div class="fp-cfg-field"><label>Prêmio Vendedor (R$)</label>
          <input type="number" step="0.01" id="cfg-premioVendedor" value="${f2(cfg.premioVendedor)}">
        </div>
        <div class="fp-cfg-field"><label>Prêmio Gerente (R$)</label>
          <input type="number" step="0.01" id="cfg-premioGerente" value="${f2(cfg.premioGerente)}">
        </div>
        <div style="grid-column:1/-1;margin-top:.4rem;padding-top:.7rem;border-top:1px solid #30363d">
          <div style="font-size:.75rem;color:#8b949e;font-weight:600;margin-bottom:.55rem">Vendedor no regime fixo + comissão</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
            <div class="fp-cfg-field" style="margin-bottom:0"><label>Salário Fixo (R$)</label>
              <input type="number" step="0.01" id="cfg-salarioFixoVendedor" value="${f2(cfg.salarioFixoVendedor)}">
            </div>
            <div class="fp-cfg-field" style="margin-bottom:0"><label>Prêmio (R$)</label>
              <input type="number" step="0.01" id="cfg-premioVendedorMisto" value="${f2(cfg.premioVendedorMisto)}">
            </div>
          </div>
          <span style="font-size:.72rem;color:#484f58;display:block;margin-top:.4rem">aplicado a quem está com "Fixo + comissão?" marcado · valor preenchido no colaborador tem prioridade</span>
        </div>
        <div style="grid-column:1/-1;margin-top:.4rem;padding-top:.7rem;border-top:1px solid #30363d">
          <label style="display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:#e6edf3;cursor:pointer">
            <input type="checkbox" id="cfg-premiacaoPagaNaLoja"${premiacaoPagaNaLoja(board) ? ' checked' : ''}>
            Premiação semanal paga pelo caixa da loja
          </label>
          <span style="font-size:.72rem;color:#484f58;display:block;margin-top:.4rem">a loja quita o prêmio de meta na própria semana · o valor sai dos proventos, do INSS/VT e do líquido, e a folha passa a exibir só para conferência · não afeta o prêmio de loja/balanço nem folha já encerrada</span>
        </div>
      </div>
      <div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid #30363d;display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem">
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Vendedor (R$)</label>
          <input type="number" step="0.01" id="cfg-gm" value="${f2(cfg.garantiaMinima)}">
        </div>
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Gerente (R$)</label>
          <input type="number" step="0.01" id="cfg-gmGerente" value="${f2(cfg.garantiaMinimaGerente)}">
        </div>
        <div class="fp-cfg-field" style="margin-bottom:0">
          <label>GM Sub / G.Vend (R$)</label>
          <input type="number" step="0.01" id="cfg-gmSub" value="${f2(cfg.garantiaMinimaSubGerente)}">
        </div>
        <span style="font-size:.72rem;color:#484f58;grid-column:1/-1">fixo + comissão ≥ garantia mínima</span>
      </div>
    </div>

    <div class="fp-modal-content" id="cfg-tab-metas">
      <div style="margin:.6rem 0 .4rem;display:flex;gap:1.5rem;flex-wrap:wrap">
        <span style="font-size:.8rem;color:#8b949e">Meta loja: <strong style="color:#e6edf3">${brl(metaLoja)}</strong></span>
        <span style="font-size:.8rem;color:#8b949e">Vendas loja: <strong style="color:#58a6ff">${brl(vendaLoja)}</strong></span>
        <span style="font-size:.75rem;color:#484f58">META 2 = meta × 1,10 · SUPER META = meta × 1,10 × 1,20</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="border-bottom:1px solid #30363d">
          <th style="text-align:left;padding:.3rem .5rem;color:#8b949e">Funcionário</th>
          <th style="text-align:left;padding:.3rem .5rem;color:#8b949e">Cargo</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#8b949e">META 1</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#d29922">META 2</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#22d3ee">SUPER META</th>
          <th style="text-align:right;padding:.3rem .5rem;color:#58a6ff">Vendas</th>
          <th style="text-align:center;padding:.3rem .5rem;color:#8b949e">Faixa</th>
        </tr></thead>
        <tbody>${metaRows}</tbody>
      </table>
    </div>`;
}

function fpCfgTabSwitch(tab) {
  document.querySelectorAll('#fpConfigContents .fp-modal-content')
    .forEach(el => el.classList.remove('active'));
  document.getElementById(`cfg-tab-${tab}`)?.classList.add('active');
  document.querySelectorAll('#fpCfgTabBtns .fp-modal-tab')
    .forEach(btn => btn.classList.toggle('active',
      btn.getAttribute('onclick')?.includes(`'${tab}'`)));
}

function fpCloseConfig() {
  document.getElementById('fpConfigModal').classList.remove('open');
}

async function fpSaveConfig() {
  const g     = id => parseFloat(document.getElementById(id)?.value) || 0;
  const board = document.getElementById('fpConfigModal').dataset.board;
  if (!board) return;
  FP.folhaConfig[board] = {
    garantiaMinima:           g('cfg-gm'),
    garantiaMinimaGerente:    g('cfg-gmGerente'),
    garantiaMinimaSubGerente: g('cfg-gmSub'),
    salarioFixoCaixa:         g('cfg-fixoCaixa'),
    quebraCaixa:              g('cfg-quebraCaixa'),
    premioVendedor:           g('cfg-premioVendedor'),
    salarioFixoVendedor:      g('cfg-salarioFixoVendedor'),
    premioVendedorMisto:      g('cfg-premioVendedorMisto'),
    premioGerente:            g('cfg-premioGerente'),
    premiacaoPagaNaLoja:      !!document.getElementById('cfg-premiacaoPagaNaLoja')?.checked,
  };
  try {
    await apiFetch('/api/folha/config', 'POST', FP.folhaConfig);
    fpCloseConfig();
    // Redesenha a aba aberta pra mudança de config aparecer na hora — trocar a
    // premiação de "paga na folha" para "paga na loja" mexe no líquido.
    if (board === FP.board) {
      if (FP.activeEmpId) selectEmp(FP.activeEmpId); else selectTotal();
    }
    toast('Configuração salva.');
  } catch(e) { toast('Erro: '+e.message, true); }
}

// ── Default entry ──────────────────────────────────────────────────────────
function monthKey() {
  return `${FP.year}-${String(FP.month).padStart(2,'0')}`;
}

function sumVendas(empId) {
  const mk = monthKey();
  const vs = FP.vsales[empId] || {};
  return r2(Object.entries(vs.entries||{})
    .filter(([d]) => d.startsWith(mk))
    .reduce((s,[,e]) => s + (e.value||0), 0));
}

// Férias do mês. Ficam gravadas na entry e por isso sobrevivem ao Gerar, como
// o "por fora" — defaultEntry lê daqui para se recalcular sozinho.
function feriasRaw(emp) {
  return FP.folha[emp.board]?.entries?.[emp.id]?.ferias || null;
}
// Só conta para o cálculo quando está marcado e com período válido — desmarcar
// preserva as datas digitadas, para poder religar sem redigitar.
function feriasDe(emp) {
  const f = feriasRaw(emp);
  if (!f?.ativo || !f.ini || !f.fim || f.ini > f.fim) return null;
  return f;
}

// '2026-09-05' → '05/09'
function fmtDiaMes(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// Aceita 'YYYY-MM-DD' e ISO completo (o carimbo do encerramento individual)
function fmtDataBR(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d ? `${d}/${m}/${y}` : '';
}

const _diasEntre = (a, b) =>
  Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000) + 1;

// Fração do mês em que o funcionário esteve presente na loja: recorta o mês
// pela admissão/desligamento e desconta os dias de férias que caem dentro dessa
// janela. Vale para o que é valor cheio do mês — salário fixo, quebra de caixa,
// garantia mínima — e para a comissão sobre o total da loja, que a loja gerou
// mesmo com a pessoa fora. A comissão sobre venda própria não usa isto: quem
// não estava na loja não vendeu, então as vendas dele já vêm menores.
function proporcaoMes(emp) {
  const mk         = monthKey();
  const monthStart = `${mk}-01`;
  const lastDay    = new Date(FP.year, FP.month, 0).getDate();
  const monthEnd   = `${mk}-${String(lastDay).padStart(2,'0')}`;
  const ini = (emp.admissao    && emp.admissao    > monthStart) ? emp.admissao    : monthStart;
  const fim = (emp.desligamento && emp.desligamento < monthEnd)  ? emp.desligamento : monthEnd;
  if (ini > fim) return { fator: 0, dias: 0, totalDias: lastDay, diasFerias: 0, ferias: null };

  const diasAtivos = _diasEntre(ini, fim);
  // Férias recortadas contra a janela do vínculo: dia fora dela não desconta duas vezes
  const fer = feriasDe(emp);
  let diasFerias = 0;
  if (fer) {
    const fIni = fer.ini > ini ? fer.ini : ini;
    const fFim = fer.fim < fim ? fer.fim : fim;
    if (fIni <= fFim) diasFerias = _diasEntre(fIni, fFim);
  }
  const dias = Math.max(0, diasAtivos - diasFerias);
  return { fator: Math.max(0, Math.min(1, dias / lastDay)), dias, totalDias: lastDay,
           diasFerias, ferias: fer };
}
function fatorProporcionalMes(emp) { return proporcaoMes(emp).fator; }

// Bloco de férias do card. Vale para qualquer loja e qualquer cargo, e o
// período é sempre dentro do mês da folha — férias que atravessa a virada é
// lançada em cada mês com a sua parte.
function buildFeriasBox(emp, e) {
  const fer  = e.ferias || {};
  const on   = !!fer.ativo;
  const prop = proporcaoMes(emp);
  const mk   = monthKey();
  const last = new Date(FP.year, FP.month, 0).getDate();
  const min  = `${mk}-01`;
  const max  = `${mk}-${String(last).padStart(2, '0')}`;
  const dInp = (id, v) =>
    `<input type="date" id="${id}" value="${v || ''}" min="${min}" max="${max}"
      onchange="onFeriasChange(${emp.id})" class="fp-ferias-date">`;

  const invalido = on && fer.ini && fer.fim && fer.ini > fer.fim;
  const resumo = on && prop.diasFerias > 0
    ? `${prop.diasFerias} ${prop.diasFerias === 1 ? 'dia' : 'dias'} de férias · presente ${prop.dias}/${prop.totalDias} dias — fixo e comissão de loja a ${(prop.fator * 100).toFixed(0)}%`
    : invalido ? '<span style="color:#f85149">início depois do fim — período ignorado</span>'
    : on ? 'informe o período para descontar os dias'
    : '';

  return `
    <div class="fp-ferias-box${on ? ' fp-ferias-on' : ''}">
      <label class="fp-ferias-chk">
        <input type="checkbox" id="fp-ferias-ativo-${emp.id}"${on ? ' checked' : ''}
          onchange="onFeriasChange(${emp.id})">
        <span>De férias neste mês</span>
      </label>
      ${on ? `
      <span class="fp-ferias-periodo">
        de ${dInp(`fp-ferias-ini-${emp.id}`, fer.ini)}
        até ${dInp(`fp-ferias-fim-${emp.id}`, fer.fim)}
      </span>` : ''}
      ${resumo ? `<span class="fp-ferias-note">${resumo}</span>` : ''}
    </div>`;
}

// Mudar férias altera o fixo, a garantia mínima e a comissão de loja — refaz a
// entry inteira em vez de só recalcular a tela, senão os inputs ficam com os
// valores antigos. Folha encerrada é histórico e não se recalcula.
function onFeriasChange(empId) {
  const emp = FP.employees.find(e => e.id === empId);
  if (!emp) return;
  if (empCongelado(empId)) {
    toast('Folha encerrada — reabra antes de alterar férias.', true, 5000);
    return;
  }
  saveEntryFromForm(empId);
  const g = id => document.getElementById(id);
  const ferias = {
    ativo: !!g(`fp-ferias-ativo-${empId}`)?.checked,
    ini:   g(`fp-ferias-ini-${empId}`)?.value || null,
    fim:   g(`fp-ferias-fim-${empId}`)?.value || null,
  };
  const prev = FP.folha[FP.board].entries[empId] || {};
  FP.folha[FP.board].entries[empId] = { ...prev, ferias };
  const entry = applyFora(defaultEntry(emp), emp, prev.fora);
  FP.folha[FP.board].entries[empId] = entry;
  FP.dirty = true;
  document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
  attachFormListeners(empId);
  recalc(empId);
}

// Comissão da linha de vendas do card. No gerente ela incide sobre o total da
// loja, então é comissão de loja e entra proporcional à presença; nos demais é
// venda própria e vai cheia. defaultEntry, recalc e saveEntryFromForm refazem
// essa conta cada um por si — todos passam por aqui para não divergirem.
function comissaoDaLinhaVendas(emp, tipo, vendas, pct) {
  const bruta = r2(vendas * pct / 100);
  return tipo === 'gerente' ? r2(bruta * fatorProporcionalMes(emp)) : bruta;
}

// Adiantamentos solicitados no Loja em Ação e já aprovados/pagos no mês.
// Vêm do servidor agrupados por colaborador; ao gerar a folha viram o desconto.
function adiantamentoDoMes(emp) {
  return r2(FP.adiantamentos?.[emp.id]?.total || 0);
}
function adiantamentoItens(emp) {
  return FP.adiantamentos?.[emp.id]?.itens || [];
}

// Rastro do valor: mostra de qual solicitação do Loja em Ação ele veio, e
// avisa quando o valor da folha foi editado à mão e não bate mais.
function adiNota(emp) {
  const itens = adiantamentoItens(emp);
  if (!itens.length) return '';
  const total = adiantamentoDoMes(emp);
  const det   = itens.map(i => {
    const [, m, d] = i.data.split('-');
    return `${d}/${m} ${brl(i.valor)}${i.status === 'aprovado' ? ' (aprovado)' : ''}`;
  }).join(' · ');
  const atual = r2(FP.folha[FP.board]?.entries?.[emp.id]?.adiantamento ?? total);
  const dif   = Math.abs(atual - total) > 0.005
    ? `<br><span style="color:#d29922">⚠ folha com ${brl(atual)} — editado à mão</span>` : '';
  return `<span style="font-size:.7rem;color:#484f58">Loja em Ação: ${det}${dif}</span>`;
}

// Faltas lançadas pelo gerente no Loja em Ação → Dados p/ Folha. Vêm do
// servidor agrupadas por colaborador; na folha viram as datas do campo Faltas.
function faltasDaLoja(emp) {
  return FP.faltasLoja?.[emp.id]?.dias || [];
}
function faltasTexto(dias) {
  return dias.map(d => `${d.slice(8,10)}/${d.slice(5,7)}`).join(' · ');
}

// Rastro das datas: mostra o que o gerente lançou, mesmo depois de o campo da
// folha ser reescrito à mão — a nota é a fonte, o campo é o que vai na planilha.
function faltasNota(emp) {
  const dias = faltasDaLoja(emp);
  if (!dias.length) return '';
  return `<span class="fp-field-hint">Loja em Ação: ${faltasTexto(dias)}</span>`;
}

// O valor da falta é sempre manual — como a ajuda de custo, o cálculo não tem
// como redescobri-lo, então volta por cima do calculado e sobrevive a todo
// caminho que recria a entry: Gerar, férias, config. As datas seguem o
// adiantamento: quem manda é o Loja em Ação, e o Gerar traz de lá.
function defaultEntry(emp) {
  const entry = calcEntry(emp);
  const ant   = FP.folha[FP.board]?.entries?.[emp.id] || {};
  const valor = r2(ant.faltasValor || 0);
  const dias  = faltasDaLoja(emp);
  entry.faltas      = dias.length ? faltasTexto(dias) : (ant.faltas || '');
  entry.faltasValor = valor;
  if (valor) {
    entry.totalDescontos = r2((entry.totalDescontos || 0) + valor);
    entry.liquido        = r2((entry.proventos || 0) - entry.totalDescontos);
  }
  return entry;
}

function calcEntry(emp) {
  const cfg  = FP.folhaConfig[FP.board] || {};
  const ecfg = getEmpCfg(emp);
  const tipo = cargoTipo(emp.cargo);
  // Adiantamento do Loja em Ação já aprovado/pago no mês — desconto automático
  const adi  = adiantamentoDoMes(emp);
  const du   = FP.mensal.diasUteis        || 22;
  const df   = FP.mensal.domingosFeriados || 4;

  const vs     = FP.vsales[emp.id] || {};

  // ── Sócio — pró-labore + complemento + comissão por loja ──
  if (tipo === 'socio') {
    const fatorPresenca = fatorProporcionalMes(emp);
    const proLabore   = r2((ecfg.salarioFixo || 0) * fatorPresenca);
    const complemento = 0;
    const sBoards     = emp.supervisedBoards || [];
    const totalVendas = r2(FP.supervisorVendaMap[emp.id] || 0);
    const totalMeta   = r2(FP.supervisorMetaMap[emp.id]  || 0);
    // Faixa sai das vendas cheias: a loja bateu ou não bateu a meta independente
    // de quem estava presente. Férias corta o pagamento, não o percentual.
    const faixa       = calcFaixa(ecfg, totalVendas, totalMeta);
    const lojaComissoes = sBoards.map(b => {
      const venda = r2(FP.lojaVendaMap[b] || 0);
      return { board: b, vendas: venda, comissaoPct: faixa.comPct,
               comissao: r2(venda * faixa.comPct / 100 * fatorPresenca) };
    });
    const comissaoTotal = r2(lojaComissoes.reduce((s, l) => s + l.comissao, 0));
    const premiacaoLojas    = ecfg.recebePremiaoLoja ? premiacaoLojaPorBoard(emp.id, sBoards) : [];
    const premiacaoBalanco  = r2(premiacaoLojas.reduce((s, l) => s + l.valor, 0));
    // Ajuda de custo é lançamento manual — sobrevive ao Gerar
    const ajudaCustoLojas   = ajudaCustoPorBoard(emp.id, ajudaCustoBoards(emp));
    const ajudaCustoTotal   = somaAjuda(ajudaCustoLojas);
    const baseEncargos = r2(proLabore + complemento + comissaoTotal + premiacaoBalanco);
    const proventos = r2(baseEncargos + ajudaCustoTotal);
    const inss = r2(baseEncargos * (ecfg.inssRate || 0) / 100);
    const vt   = r2(baseEncargos * (ecfg.vtRate   || 0) / 100);
    return {
      tipo, proLabore, complemento, lojaComissoes, premiacaoLojas, premiacaoBalanco,
      ferias: feriasRaw(emp),
      ajudaCustoLojas, ajudaCustoTotal,
      vendas: totalVendas, meta: totalMeta,
      pctMeta: totalMeta > 0 ? r2(totalVendas / totalMeta * 100) : 0,
      faixaLabel: faixa.label, comissaoPct: faixa.comPct,
      comissaoTotal, feriado: 0,
      extras:     (FP.prevExtras[emp.id]?.extras     || []).map(x => ({ ...x, _prev: true })),
      proventos,
      valeCompras: 0, adiantamento: adi, inss, irpf: 0, vt,
      arredondamento: 0,
      extrasDesc: (FP.prevExtras[emp.id]?.extrasDesc || []).map(x => ({ ...x, _prev: true })),
      totalDescontos: r2(inss + vt + adi), liquido: r2(proventos - inss - vt - adi),
    };
  }

  // ── Supervisor — cálculo por loja ──
  if (tipo === 'supervisor') {
    const fatorPresenca = fatorProporcionalMes(emp);
    const fixo      = r2((ecfg.salarioFixo || 0) * fatorPresenca);
    const sBoards   = emp.supervisedBoards || [];
    const totalVendas = r2(FP.supervisorVendaMap[emp.id] || 0);
    const totalMeta   = r2(FP.supervisorMetaMap[emp.id]  || 0);
    const faixa       = calcFaixa(ecfg, totalVendas, totalMeta);
    const pctMeta     = totalMeta > 0 ? r2(totalVendas / totalMeta * 100) : 0;
    const lojaComissoes = sBoards.map(b => {
      const venda = r2(FP.lojaVendaMap[b] || 0);
      return { board: b, vendas: venda, comissaoPct: faixa.comPct,
               comissao: r2(venda * faixa.comPct / 100 * fatorPresenca) };
    });
    const comissaoTotal = r2(lojaComissoes.reduce((s, l) => s + l.comissao, 0));
    const premiacaoLojas    = ecfg.recebePremiaoLoja ? premiacaoLojaPorBoard(emp.id, sBoards) : [];
    const premiacaoBalanco  = r2(premiacaoLojas.reduce((s, l) => s + l.valor, 0));
    // Ajuda de custo é lançamento manual — sobrevive ao Gerar
    const ajudaCustoLojas   = ajudaCustoPorBoard(emp.id, ajudaCustoBoards(emp));
    const ajudaCustoTotal   = somaAjuda(ajudaCustoLojas);
    const baseEncargos = r2(fixo + comissaoTotal + premiacaoBalanco);
    const proventos = r2(baseEncargos + ajudaCustoTotal);
    const inss = r2(baseEncargos * (ecfg.inssRate || 0) / 100);
    const vt   = r2(baseEncargos * (ecfg.vtRate   || 0) / 100);
    return {
      tipo, fixo, lojaComissoes, premiacaoLojas, premiacaoBalanco,
      ferias: feriasRaw(emp),
      ajudaCustoLojas, ajudaCustoTotal,
      vendas: totalVendas, meta: totalMeta, pctMeta,
      faixaLabel: faixa.label, comissaoPct: faixa.comPct,
      comissaoTotal, feriado: 0,
      extras:     (FP.prevExtras[emp.id]?.extras     || []).map(x => ({ ...x, _prev: true })),
      proventos,
      valeCompras: 0, adiantamento: adi, inss, irpf: 0, vt,
      arredondamento: 0,
      extrasDesc: (FP.prevExtras[emp.id]?.extrasDesc || []).map(x => ({ ...x, _prev: true })),
      totalDescontos: r2(inss + vt + adi), liquido: r2(proventos - inss - vt - adi),
    };
  }

  const vendas = tipo === 'gerente'
    ? r2(FP.lojaVendaMap[FP.board] || 0)
    : sumVendas(emp.id);
  const meta = tipo === 'gerente'
    ? r2(FP.lojaMetaMap[FP.board] || 0)
    : r2(vs.meta?.mensal || 0);

  // ── Caixa ──
  if (tipo === 'caixa') {
    const fator     = fatorProporcionalMes(emp);
    const fixo      = r2((cfg.salarioFixoCaixa || ecfg.salarioFixo || 0) * fator);
    const quebra    = r2((cfg.quebraCaixa      || ecfg.quebraCaixa  || 0) * fator);
    const vendaLoja = r2(FP.lojaVendaMap[FP.board] || 0);
    // Comissão sobre o total da loja também é proporcional à presença
    const comissaoLoja = ecfg.comissaoVR > 0 ? r2(vendaLoja * ecfg.comissaoVR / 100 * fator) : 0;
    const prov   = r2(fixo + quebra + comissaoLoja);
    const inss   = r2(prov * (ecfg.inssRate || 0) / 100);
    const vt     = r2(prov * (ecfg.vtRate   || 0) / 100);
    return {
      tipo, fixo, quebra, comissaoLoja, vendaLoja, feriado: 0, extras: [],
      ferias: feriasRaw(emp),
      proventos: prov,
      valeCompras: 0, adiantamento: adi, inss, irpf: 0, vt,
      arredondamento: 0, extrasDesc: [],
      totalDescontos: r2(inss+vt+adi), liquido: r2(prov-inss-vt-adi),
    };
  }

  const faixa       = calcFaixa(ecfg, vendas, meta);
  const faixaLabel  = faixa.label;
  const comissaoPct = faixa.comPct;
  const pctMeta     = meta > 0 ? r2(vendas / meta * 100) : 0;

  const fatorMes = fatorProporcionalMes(emp);

  const comissaoTotal = comissaoDaLinhaVendas(emp, tipo, vendas, comissaoPct);

  const vendComFixo = tipo === 'vendedor' && ecfg.vendedorComFixo;

  // Vendedor misto: o fixo padrão vem da loja; valor no colaborador tem prioridade
  const fixo = (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend')
    ? r2((ecfg.salarioFixo || 0) * fatorMes)
    : vendComFixo
      ? r2((ecfg.salarioFixo || cfg.salarioFixoVendedor || 0) * fatorMes)
      : 0;

  // Vendedor no regime fixo + comissão não tem garantia mínima: o fixo é o piso
  const gm = vendComFixo ? 0
    : tipo === 'gerente'
      ? r2((cfg.garantiaMinimaGerente    || cfg.garantiaMinima || 0) * fatorMes)
      : (tipo === 'sub' || tipo === 'gvend')
        ? r2((cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0) * fatorMes)
        : r2((cfg.garantiaMinima || 0) * fatorMes);
  const vendaLoja = r2(FP.lojaVendaMap[FP.board] || 0);
  let comissaoLoja = 0;
  if (temComissaoLoja(tipo, ecfg)) {
    if (tipo === 'sub') {
      const lojaEcfg = {
        comissaoSemMeta: ecfg.comissaoVRSemMeta || ecfg.comissaoVR || 0,
        comissao:        ecfg.comissaoVR        || 0,
        comissaoMeta2:   ecfg.comissaoVRMeta2   || ecfg.comissaoVR || 0,
        comissaoSuper:   ecfg.comissaoVRSuper   || ecfg.comissaoVR || 0,
      };
      const metaLoja = r2(FP.lojaMetaMap[FP.board] || 0);
      const lojaFaixa = calcFaixa(lojaEcfg, vendaLoja, metaLoja);
      // Comissão sobre o total da loja: proporcional aos dias de presença
      comissaoLoja = r2(vendaLoja * lojaFaixa.comPct / 100 * fatorMes);
    } else {
      comissaoLoja = r2(vendaLoja * ecfg.comissaoVR / 100 * fatorMes);
    }
  }

  // DSR = (comissaoContab + prêmio) / du × df  →  equivale a base × df / (du + df)
  const baseContab = baseDivisaoContab(tipo, comissaoTotal, comissaoLoja);
  // Comissionista misto (fixo + comissão) tem prêmio próprio, diferente do puro
  const premio = r2((tipo === 'gerente' || tipo === 'gvend')
    ? (cfg.premioGerente || 0)
    : vendComFixo ? (cfg.premioVendedorMisto || 0)
    : (cfg.premioVendedor || 0));
  const dsr = (du + df) > 0 ? r2(baseContab * df / (du + df)) : 0;
  const comissaoContab = r2(baseContab - dsr - premio);

  const baseGm = fixo + comissaoTotal;
  const gmComplement = r2(Math.max(0, gm - baseGm));

  // premiacaoNaLoja é o prêmio semanal que a loja já pagou pelo caixa: fica de
  // fora dos proventos (e portanto de INSS/VT e do líquido), só como memória.
  const { premiacao, premiacaoBalanco, premiacaoNaLoja } = premiacaoCalculada(emp);

  const proventos = r2(fixo + comissaoTotal + comissaoLoja + gmComplement + premiacao + premiacaoBalanco);
  const inss = r2(proventos * (ecfg.inssRate || 0) / 100);
  const vt   = r2(proventos * (ecfg.vtRate   || 0) / 100);

  return {
    tipo, vendas, meta, pctMeta, faixaLabel, comissaoPct,
    ferias: feriasRaw(emp),
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja, vendaLoja, fixo, gm, gmComplement,
    premiacao, premiacaoBalanco, premiacaoNaLoja,
    feriado: 0,
    extras:     (FP.prevExtras[emp.id]?.extras     || []).map(x => ({ ...x, _prev: true })),
    proventos,
    valeCompras: 0, adiantamento: adi, inss, irpf: 0, vt,
    arredondamento: 0,
    extrasDesc: (FP.prevExtras[emp.id]?.extrasDesc || []).map(x => ({ ...x, _prev: true })),
    totalDescontos: r2(inss+vt+adi), liquido: r2(proventos-inss-vt-adi),
  };
}

// ── Build form ─────────────────────────────────────────────────────────────
function buildEmpForm(emp, entry) {
  const e    = entry;
  const tipo = e.tipo || cargoTipo(emp.cargo);
  const cfg  = FP.folhaConfig[FP.board] || {};
  const ecfg = getEmpCfg(emp);
  const du   = FP.mensal.diasUteis        || 22;
  const df   = FP.mensal.domingosFeriados || 4;

  const propMes   = proporcaoMes(emp);
  const fatorNota = propMes.fator < 0.999
    ? ` <span style="font-size:.7rem;color:#d29922">· proporcional: ${propMes.dias}/${propMes.totalDias} dias (${(propMes.fator*100).toFixed(0)}%)</span>`
    : '';

  const inp = (id, v, extra='') =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" ${extra} onchange="onFieldChange(${emp.id})">`;
  const inpRO = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}" readonly class="fp-readonly" tabindex="-1">`;
  // Campo de texto: anotação que vai para a contabilidade, não entra em conta
  // nenhuma (faltas). onchange também grava, senão sai da tela sem salvar.
  const inpTxt = (id, v, ph='') =>
    `<input type="text" class="fp-txt" id="${id}" placeholder="${ph}"
       value="${String(v || '').replace(/"/g, '&quot;')}"
       oninput="onFieldChange(${emp.id})" onchange="onFieldChange(${emp.id})">`;

  // Campo do prêmio semanal. Na loja que paga pelo caixa vira texto, não input:
  // sem o elemento fp-premiacao-*, recalc e saveEntryFromForm leem zero e o
  // prêmio fica naturalmente fora dos proventos, do INSS/VT e do líquido.
  const premNaLoja = premiacaoPagaNaLoja(emp.board) && !empCongelado(emp.id);
  const premField = (label, hint) => premNaLoja
    ? `<div class="fp-field"><label>${label}</label>
         <div class="fp-prem-loja">
           <span class="fp-prem-loja-val">${brl(e.premiacaoNaLoja ?? premiacaoCalculada(emp).premiacaoNaLoja)}</span>
           <span class="fp-prem-loja-tag">pago na loja</span>
         </div>
         <span style="font-size:.7rem;color:#484f58">${hint}</span></div>`
    : `<div class="fp-field"><label>${label}</label>${inp(`fp-premiacao-${emp.id}`, e.premiacao || 0)}
         <span style="font-size:.7rem;color:#484f58">${hint}</span></div>`;

  const faixaColor = {'SEM META':'#8b949e','META 1':'#d29922','META 2':'#3fb950','SUPER META':'#22d3ee','—':'#484f58'};
  const faixaBadge = label => {
    const c = faixaColor[label] || '#8b949e';
    return `<span style="font-size:.7rem;padding:.1rem .4rem;border-radius:4px;background:${c}22;color:${c};border:1px solid ${c}44;white-space:nowrap">${label}</span>`;
  };

  const _comLojaRow = () => {
    const pctVR    = r2(ecfg.comissaoVR);
    const vLoja    = r2(e.vendaLoja || FP.lojaVendaMap[FP.board] || 0);
    const mLoja    = r2(FP.lojaMetaMap[FP.board] || 0);
    const lojaEcfgForFaixa = tipo === 'sub' ? {
      comissaoSemMeta: ecfg.comissaoVRSemMeta || ecfg.comissaoVR || 0,
      comissao:        ecfg.comissaoVR        || 0,
      comissaoMeta2:   ecfg.comissaoVRMeta2   || ecfg.comissaoVR || 0,
      comissaoSuper:   ecfg.comissaoVRSuper   || ecfg.comissaoVR || 0,
    } : { comissao: ecfg.comissaoVR || 0, comissaoSemMeta: ecfg.comissaoVR || 0 };
    const storeFaixa = calcFaixa(lojaEcfgForFaixa, vLoja, mLoja);
    const pctStr   = mLoja > 0 ? `${(vLoja / mLoja * 100).toFixed(1)}% da meta da loja` : 'sem meta da loja';
    return `<div class="fp-field fp-field-inline">
      <label>Comissão Loja</label>
      ${inpRO(`fp-vendaLoja-${emp.id}`, vLoja)}
      <span class="fp-times">×</span>
      <span style="font-size:.85rem;color:#8b949e;padding:.15rem .2rem">${storeFaixa.comPct.toFixed(2)}%</span>
      ${faixaBadge(storeFaixa.label)}
      <span class="fp-equals">=</span>
      ${inp(`fp-comLoja-${emp.id}`, e.comissaoLoja || 0)}
      <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctStr}</span>
    </div>`;
  };

  // Prêmio de loja do supervisor/sócio: uma linha por loja supervisionada
  const _premLojaRows = () => {
    if (!ecfg.recebePremiaoLoja) return '';
    const sBoards = emp.supervisedBoards || [];
    const lojas = e.premiacaoLojas || premiacaoLojaPorBoard(emp.id, sBoards);
    if (!lojas.length) return '';
    const total = r2(lojas.reduce((s, l) => s + r2(l.valor), 0));
    let html = `<div class="fp-field" style="border-top:1px solid #30363d;padding-top:.5rem;margin-top:.25rem">
      <label style="font-weight:600">Premiação da Loja</label></div>`;
    lojas.forEach(lj => {
      const bi   = BOARDS_INFO[lj.board] || { label: lj.board.toUpperCase(), color: '#8b949e' };
      const hint = (lj.semanas || []).length
        ? (lj.semanas || []).map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : 'nenhuma semana com meta batida';
      html += `<div class="fp-field">
        <label style="color:${bi.color}">${bi.label} (R$)</label>${inp(`fp-premLoja-${emp.id}-${lj.board}`, lj.valor)}
        <span style="font-size:.7rem;color:#484f58">${hint}</span></div>`;
    });
    html += `<div class="fp-field fp-field-inline">
      <label style="font-weight:600">Total Premiação</label>
      <span></span><span></span><span></span><span></span>
      <span class="fp-total-inline" id="fp-premLojaTotal-${emp.id}">${brl(total)}</span>
    </div>`;
    return html;
  };

  // Ajuda de custo do supervisor/sócio: valor manual, uma linha por empresa
  const _ajudaCustoRows = () => {
    const sBoards = emp.supervisedBoards || [];
    if (!sBoards.length) return '';
    const lojas = ajudaCustoPorBoard(emp.id, ajudaCustoBoards(emp), e);
    const total = somaAjuda(lojas);
    let html = `<div class="fp-field" style="border-top:1px solid #30363d;padding-top:.5rem;margin-top:.25rem">
      <label style="font-weight:600">Ajuda de Custo</label>
      <span style="font-size:.7rem;color:#484f58">valor fixo por empresa — repete todo mês</span></div>`;
    lojas.forEach(lj => {
      const bi = _biOf(lj.board);
      html += `<div class="fp-field">
        <label style="color:${bi.color}">${bi.label} (R$)</label>${inp(`fp-ajuda-${emp.id}-${lj.board}`, lj.valor)}
        ${lj._prev ? '<span style="font-size:.7rem;color:#d29922">repetido do mês anterior</span>' : ''}</div>`;
    });
    html += `<div class="fp-field fp-field-inline">
      <label style="font-weight:600">Total Ajuda de Custo</label>
      <span></span><span></span><span></span><span></span>
      <span class="fp-total-inline" id="fp-ajudaTotal-${emp.id}">${brl(total)}</span>
    </div>`;
    return html;
  };

  let provRows = '';

  if (tipo === 'caixa') {
    provRows = `
      <div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}${fatorNota}</div>
      <div class="fp-field"><label>Quebra de Caixa (R$)</label>${inp(`fp-quebra-${emp.id}`, e.quebra)}${fatorNota}</div>`;
    if ((ecfg.comissaoVR || 0) > 0) provRows += _comLojaRow();
    if (ecfg.recebePremiaoLoja) {
      const semGerDetC  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
      const semGerCalcC = r2(FP.premiacaoSemanalGer[emp.id] || 0);
      const semGerHintC = semGerDetC.length
        ? semGerDetC.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semGerCalcC > 0 ? `calculado: ${brl(semGerCalcC)}` : 'nenhuma meta semanal encontrada';
      provRows += `<div class="fp-field"><label>Premiação da Loja (R$)</label>${inp(`fp-premiacaoBalanco-${emp.id}`, e.premiacaoBalanco || 0)}
        <span style="font-size:.7rem;color:#484f58">${semGerHintC}</span></div>`;
    }
  } else if (tipo === 'socio') {
    const lojaComissoes = e.lojaComissoes || (emp.supervisedBoards || []).map(b => ({
      board: b, vendas: r2(FP.lojaVendaMap[b]||0), comissaoPct: e.comissaoPct||0, comissao: 0,
    }));
    const totalVendas = r2(FP.supervisorVendaMap[emp.id] || 0);
    const totalMeta   = r2(FP.supervisorMetaMap[emp.id]  || 0);
    const pctTotal    = totalMeta > 0 ? `${r2(totalVendas/totalMeta*100).toFixed(1)}% da meta total` : 'sem meta';
    provRows += `
      <div class="fp-field"><label>Pró-Labore (R$)</label>${inp(`fp-proLabore-${emp.id}`, e.proLabore || 0)}${fatorNota}</div>
      <div class="fp-field"><label>Complemento (R$)</label>${inp(`fp-complemento-${emp.id}`, e.complemento || 0)}</div>`;
    lojaComissoes.forEach(lj => {
      const bi = BOARDS_INFO[lj.board] || { label: lj.board.toUpperCase(), color: '#8b949e' };
      provRows += `<div class="fp-field fp-field-inline">
        <label style="color:${bi.color};min-width:90px">${bi.label}</label>
        ${inpRO(`fp-supVendas-${emp.id}-${lj.board}`, lj.vendas)}
        <span class="fp-times">×</span>
        <span style="font-size:.85rem;color:#8b949e;padding:.15rem .2rem">${r2(lj.comissaoPct).toFixed(2)}%</span>
        ${faixaBadge(e.faixaLabel || '—')}
        <span class="fp-equals">=</span>
        ${inp(`fp-supCom-${emp.id}-${lj.board}`, lj.comissao)}
      </div>`;
    });
    provRows += `<div class="fp-field fp-field-inline" style="border-top:1px solid #30363d;padding-top:.5rem;margin-top:.25rem">
      <label style="font-weight:600">Total Comissão</label>
      <span></span><span></span><span></span><span></span>
      <span class="fp-total-inline" id="fp-supComTotal-${emp.id}">${brl(e.comissaoTotal||0)}</span>
      <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctTotal}</span>
    </div>`;
    provRows += _premLojaRows();
    provRows += _ajudaCustoRows();
  } else if (tipo === 'supervisor') {
    const lojaComissoes = e.lojaComissoes || (emp.supervisedBoards || []).map(b => ({
      board: b, vendas: r2(FP.lojaVendaMap[b]||0), comissaoPct: e.comissaoPct||0, comissao: 0,
    }));
    const totalVendas = r2(FP.supervisorVendaMap[emp.id] || 0);
    const totalMeta   = r2(FP.supervisorMetaMap[emp.id]  || 0);
    const pctTotal    = totalMeta > 0 ? `${r2(totalVendas/totalMeta*100).toFixed(1)}% da meta total` : 'sem meta';
    provRows += `<div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}${fatorNota}</div>`;
    lojaComissoes.forEach(lj => {
      const bi = BOARDS_INFO[lj.board] || { label: lj.board.toUpperCase(), color: '#8b949e' };
      provRows += `<div class="fp-field fp-field-inline">
        <label style="color:${bi.color};min-width:90px">${bi.label}</label>
        ${inpRO(`fp-supVendas-${emp.id}-${lj.board}`, lj.vendas)}
        <span class="fp-times">×</span>
        <span style="font-size:.85rem;color:#8b949e;padding:.15rem .2rem">${r2(lj.comissaoPct).toFixed(2)}%</span>
        ${faixaBadge(e.faixaLabel || '—')}
        <span class="fp-equals">=</span>
        ${inp(`fp-supCom-${emp.id}-${lj.board}`, lj.comissao)}
      </div>`;
    });
    provRows += `<div class="fp-field fp-field-inline" style="border-top:1px solid #30363d;padding-top:.5rem;margin-top:.25rem">
      <label style="font-weight:600">Total Comissão</label>
      <span></span><span></span><span></span><span></span>
      <span class="fp-total-inline" id="fp-supComTotal-${emp.id}">${brl(e.comissaoTotal||0)}</span>
      <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctTotal}</span>
    </div>`;
    provRows += _premLojaRows();
    provRows += _ajudaCustoRows();
  } else {
    const pctDisplay = e.pctMeta > 0 ? `${r2(e.pctMeta).toFixed(1)}% da meta` : 'sem meta';
    // Sub-gerente divide comissão própria + comissão da loja; demais, só a própria
    const baseLabel = tipo === 'sub' ? 'comissão própria + loja' : 'total';

    // A linha aparece pela config atual OU porque a entry salva já tem valor —
    // assim uma folha antiga nunca perde de vista o que foi pago nela.
    const vendComFixo = tipo === 'vendedor' && (ecfg.vendedorComFixo || r2(e.fixo || 0) > 0);

    if (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend' || vendComFixo)
      provRows += `<div class="fp-field"><label>Salário Fixo (R$)</label>${inp(`fp-fixo-${emp.id}`, e.fixo)}${fatorNota}</div>`;

    provRows += `
      <div class="fp-field fp-field-inline">
        <label>${tipo === 'gerente' ? 'Vendas Loja (R$)' : (tipo === 'gvend' || tipo === 'sub') ? 'Vendas Próprias (R$)' : 'Vendas (R$)'}</label>${inp(`fp-vendas-${emp.id}`, e.vendas)}
        <span class="fp-times">×</span>
        <input type="number" step="0.01" id="fp-comPct-${emp.id}" value="${r2(e.comissaoPct).toFixed(2)}"
          style="width:72px" onchange="onFieldChange(${emp.id})">
        <span class="fp-label-pct">%</span>
        ${faixaBadge(e.faixaLabel || '—')}
        <span class="fp-equals">=</span>
        <span class="fp-total-inline" id="fp-totalCom-${emp.id}">${brl(e.comissaoTotal)}</span>
        <span style="font-size:.7rem;color:#8b949e;margin-left:.3rem">${pctDisplay}</span>
      </div>
      <div id="fp-declHint-${emp.id}" style="font-size:.72rem;color:#d29922;padding:0 0 .25rem .2rem"></div>
      <div class="fp-split-box">
        <div class="fp-split-title" style="cursor:pointer;user-select:none"
          onclick="(function(el){const c=el.nextElementSibling;const open=c.style.display!=='none';c.style.display=open?'none':'block';el.querySelector('.fp-split-arrow').textContent=open?'▶':'▼';})(this)">
          <span class="fp-split-arrow">▶</span> divisão para contabilidade${tipo === 'sub' ? ` <span style="font-weight:400;color:#8b949e">(${baseLabel})</span>` : ''}
        </div>
        <div style="display:none">
          <div class="fp-field fp-split-row">
            <label>Comissão (contab)</label>${inpRO(`fp-comissao-${emp.id}`, e.comissaoContab)}
            <span class="fp-split-hint">= ${baseLabel} − DSR − Prêmio</span>
          </div>
          <div class="fp-field fp-split-row">
            <label>DSR (R$)</label>${inp(`fp-dsr-${emp.id}`, e.dsr)}
            <span class="fp-split-hint">= ${baseLabel} × ${df} ÷ ${du + df}</span>
          </div>
          <div class="fp-field fp-split-row">
            <label>Prêmio (R$)</label>${inp(`fp-premio-${emp.id}`, e.premio)}
          </div>
          <div class="fp-split-check" id="fp-splitCheck-${emp.id}"></div>
        </div>
      </div>`;

    if (temComissaoLoja(tipo, ecfg)) provRows += _comLojaRow();

    // Vendedor com fixo não tem GM — o salário fixo já é o piso
    const gmMin = vendComFixo ? 0
      : tipo === 'gerente'
        ? (cfg.garantiaMinimaGerente    || cfg.garantiaMinima || 0)
        : (tipo === 'sub' || tipo === 'gvend')
          ? (cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0)
          : (cfg.garantiaMinima || 0);
    // GM salva na entry mantém a linha visível mesmo que a regra atual não a
    // gere mais — do contrário o valor sumiria da tela e do próximo save.
    const gmSalva = r2(e.gmComplement || 0);
    if (gmMin <= 0 && gmSalva > 0) {
      provRows += `<div class="fp-field"><label>GM (R$)</label>${inp(`fp-gm-${emp.id}`, gmSalva)}
        <span style="font-size:.72rem;color:#d29922">valor da folha — a regra atual não gera GM para este cargo</span></div>`;
    }
    if (gmMin > 0) {
      const gmMinEfetiva = r2(gmMin * propMes.fator);
      const gmBase = (tipo === 'gvend' || tipo === 'sub')
        ? `mín: ${brl(gmMinEfetiva)} (fixo + comissão própria)`
        : `mín: ${brl(gmMinEfetiva)}`;
      const gmNote = propMes.fator < 0.999
        ? `${gmBase} <span style="color:#d29922">(proporcional: ${propMes.dias}/${propMes.totalDias} dias de ${brl(gmMin)})</span>`
        : gmBase;
      provRows += `<div class="fp-field"><label>GM (R$)</label>${inp(`fp-gm-${emp.id}`, e.gmComplement)}
        <span style="font-size:.72rem;color:#8b949e">${gmNote}</span></div>`;
    }

    if (tipo === 'gerente') {
      const semGerDet  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
      const semGerCalc = r2(FP.premiacaoSemanalGer[emp.id] || 0);
      const semGerHint = semGerDet.length
        ? semGerDet.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semGerCalc > 0 ? `calculado: ${brl(semGerCalc)}` : 'nenhuma meta semanal encontrada';
      provRows += premField('Premiação Gerente (R$)', semGerHint);
    } else if (tipo === 'gvend' || tipo === 'sub' || ecfg.recebePremiaoLoja) {
      const semVendDet  = FP.premiacaoSemanalDetalhe[emp.id] || [];
      const semVendCalc = r2(FP.premiacaoSemanal[emp.id] || 0);
      const semVendHint = semVendDet.length
        ? semVendDet.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semVendCalc > 0 ? `calculado: ${brl(semVendCalc)}` : 'nenhuma meta semanal encontrada';
      if (tipo !== 'caixa') {
        provRows += premField('Premiação Vendedor (R$)', semVendHint);
      }
      // Sub-gerente não recebe prêmio de loja por padrão — só com a flag no config
      if (tipo === 'gvend' || ecfg.recebePremiaoLoja) {
        const semGerDet2  = FP.premiacaoSemanalGerDetalhe[emp.id] || [];
        const semGerCalc2 = r2(FP.premiacaoSemanalGer[emp.id] || 0);
        const semGerHint2 = semGerDet2.length
          ? semGerDet2.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
          : semGerCalc2 > 0 ? `calculado: ${brl(semGerCalc2)}` : 'nenhuma meta semanal encontrada';
        provRows += `<div class="fp-field"><label>Premiação da Loja (R$)</label>${inp(`fp-premiacaoBalanco-${emp.id}`, e.premiacaoBalanco || 0)}
          <span style="font-size:.7rem;color:#484f58">${semGerHint2}</span></div>`;
      }
    } else {
      const semDetalhe = FP.premiacaoSemanalDetalhe[emp.id] || [];
      const semCalc    = r2(FP.premiacaoSemanal[emp.id] || 0);
      const semHint = semDetalhe.length
        ? semDetalhe.map(s => `sem. ${s.label}: ${brl(s.valor)}`).join(' · ')
        : semCalc > 0 ? `calculado: ${brl(semCalc)}` : 'nenhuma meta semanal encontrada';
      provRows += premField('Premiação (R$)', semHint);
    }
  }

  provRows += `
    <div class="fp-field"><label>Feriado (R$)</label>${inp(`fp-feriado-${emp.id}`, e.feriado)}</div>
    <div class="fp-extras" id="extras-prov-${emp.id}">${buildExtraRows(emp.id, e.extras||[], 'prov')}</div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'prov')">+ Adicionar linha</button>`;

  const descRows = `
    <div class="fp-field"><label>Vale Compras (R$)</label>${inp(`fp-valeCompras-${emp.id}`, e.valeCompras)}</div>
    <div class="fp-field"><label>Adiantamento (R$)</label>${inp(`fp-adiantamento-${emp.id}`, e.adiantamento)}${adiNota(emp)}</div>
    <div class="fp-field"><label>INSS (R$)</label>${inp(`fp-inss-${emp.id}`, e.inss)}</div>
    <div class="fp-field"><label>IR FP (R$)</label>${inp(`fp-irpf-${emp.id}`, e.irpf)}</div>
    <div class="fp-field"><label>Vale Transporte (R$)</label>${inp(`fp-vt-${emp.id}`, e.vt)}</div>
    <div class="fp-field"><label>Arredondamento (R$)</label>${inp(`fp-arred-${emp.id}`, e.arredondamento)}</div>
    <div class="fp-field fp-field-faltas"><label>Faltas (R$)</label>${inp(`fp-faltasValor-${emp.id}`, e.faltasValor || 0)}
      ${inpTxt(`fp-faltas-${emp.id}`, e.faltas, 'datas — ex.: 27/08')}${faltasNota(emp)}</div>
    <div class="fp-extras" id="extras-desc-${emp.id}">${buildExtraRows(emp.id, e.extrasDesc||[], 'desc')}</div>
    <button class="fp-add-extra" onclick="addExtra(${emp.id},'desc')">+ Adicionar desconto</button>`;

  // Encerramento individual — pensado para rescisão: fecha o acerto deste
  // colaborador antes da folha do resto da loja. Quando a folha da loja inteira
  // já está encerrada o controle é o do painel, não este.
  const encEmp  = entryEncerrada(emp.id);
  const encLoja = folhaEncerrada(FP.board);
  const bSt     = 'padding:.2rem .6rem;font-size:.72rem';
  const headBtns = encLoja
    ? ''
    : encEmp
      ? `<span class="fp-emp-enc-tag" style="margin-left:auto">⊠ Encerrada${e.encerradaEm ? ' em ' + fmtDataBR(e.encerradaEm) : ''}</span>
         <button class="fp-btn" style="${bSt}" onclick="fpImprimirRecibos(${emp.id})"
           title="Imprimir o recibo só deste colaborador">Recibo</button>
         <button class="fp-btn reabrir" style="${bSt}" onclick="fpEncerrarEmp(${emp.id})"
           title="Reabrir a folha deste colaborador para poder editar de novo">Reabrir</button>`
      : `<button class="fp-btn" style="${bSt};margin-left:auto" onclick="fpGerarEmp(${emp.id})" title="Recalcular só este colaborador">↺ Gerar</button>
         <button class="fp-btn encerrar" style="${bSt}" onclick="fpEncerrarEmp(${emp.id})"
           title="Fecha a folha só deste colaborador (rescisão). Gerar Folha e mudança de config deixam de mexer nele.">Encerrar</button>`;

  return `
  <div class="fp-emp-form active${encEmp ? ' fp-emp-encerrada' : ''}" id="empform-${emp.id}">
    <div style="font-size:.75rem;color:#8b949e;margin-bottom:.75rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
      <span>${emp.name} · ${emp.cargo}${ecfg.inssRate ? ` · INSS ${ecfg.inssRate}%` : ''}${ecfg.vtRate ? ` · VT ${ecfg.vtRate}%` : ''}${emp.banco ? ` · Banco ${emp.banco} / Cta ${emp.conta||'—'}` : ''}</span>
      ${headBtns}
    </div>
    ${buildFeriasBox(emp, e)}
    <div class="fp-form-grid">
      <div class="fp-section">
        <div class="fp-section-title">Proventos</div>
        ${provRows}
        <div class="fp-total-row">
          <label>PROVENTOS</label>
          <span class="fp-total-val" id="val-proventos-${emp.id}">${brl(e.proventos)}</span>
        </div>
      </div>
      <div class="fp-section">
        <div class="fp-section-title">Descontos</div>
        ${descRows}
        <div class="fp-total-row">
          <label>TOTAL DESCONTOS</label>
          <span class="fp-total-val" style="color:#f85149" id="val-desc-${emp.id}">${brl(e.totalDescontos)}</span>
        </div>
      </div>
    </div>
    <div class="fp-fora-box">
      <div class="fp-fora-head">
        <span class="fp-fora-title">Pagamento por fora</span>
        <span class="fp-fora-note">não entra na exportação para a contabilidade</span>
        <span class="fp-fora-total" id="val-fora-${emp.id}">${brl(foraBreakdown(e, tipo).total)}</span>
      </div>
      <div id="fora-rows-${emp.id}">${buildForaRows(emp.id, e.fora || [], tipo, r2(e.fixo || 0) > 0)}</div>
      <button class="fp-add-extra" onclick="addFora(${emp.id})">+ Adicionar linha por fora</button>
      <div class="fp-fora-hint" id="fora-hint-${emp.id}"></div>
    </div>
    <div class="fp-liquido-bar">
      <div>
        <div class="fp-liquido-label">LÍQUIDO A RECEBER</div>
        <div style="font-size:.72rem;color:#8b949e" id="liquido-note-${emp.id}"></div>
        ${emp.banco?`<div style="font-size:.72rem;color:#8b949e">Banco ${emp.banco} · Cta ${emp.conta||'—'}</div>`:''}
      </div>
      <span class="fp-liquido-val" id="val-liquido-${emp.id}">${brl(e.liquido)}</span>
    </div>
    <div class="fp-geral-bar" id="geral-bar-${emp.id}" style="display:none">
      <div>
        <div class="fp-geral-label">TOTAL GERAL A RECEBER</div>
        <div style="font-size:.72rem;color:#484f58" id="geral-detail-${emp.id}"></div>
      </div>
      <span class="fp-geral-val" id="val-totalgeral-${emp.id}">${brl(e.liquido)}</span>
    </div>
    ${buildRateioBox(emp, e, tipo)}
    ${buildEmpCfgSection(emp, ecfg, tipo)}
  </div>`;
}

function buildEmpCfgSection(emp, ecfg, tipo) {
  const hasFolha = Object.keys(FP.empConfig[emp.id] || {}).length > 0;
  const src = hasFolha
    ? '<span style="color:#3fb950">● valores da folha</span>'
    : '<span style="color:#484f58">valores do cadastro</span>';

  const inp = (id, v) =>
    `<input type="number" step="0.01" id="${id}" value="${r2(v).toFixed(2)}"
      style="width:88px;background:#21262d;border:1px solid #30363d;color:#e6edf3;
             padding:.2rem .4rem;border-radius:5px;font-size:.82rem;text-align:right">`;

  const row = (lbl, id, v) =>
    `<div class="fp-emp-cfg-row"><label>${lbl}</label>${inp(id, v)}</div>`;

  let fields = '';
  if (tipo === 'caixa') {
    fields =
      row('Salário Fixo (R$)',  `ec-salarioFixo-${emp.id}`,  ecfg.salarioFixo) +
      row('Quebra Caixa (R$)',  `ec-quebraCaixa-${emp.id}`,  ecfg.quebraCaixa) +
      row('Comissão Loja (%)',  `ec-comissaoVR-${emp.id}`,   ecfg.comissaoVR) +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,     ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,       ecfg.vtRate) +
      row('MAX. VT (R$)',       `ec-maxVT-${emp.id}`,        ecfg.maxVT);
  } else if (tipo === 'gerente') {
    fields =
      row('Com. Sem Meta (%)',   `ec-comissaoSemMeta-${emp.id}`, ecfg.comissaoSemMeta) +
      row('Com. Meta 1 (%)',     `ec-comissao-${emp.id}`,        ecfg.comissao) +
      row('Com. Meta 2 (%)',     `ec-comissaoMeta2-${emp.id}`,   ecfg.comissaoMeta2) +
      row('Com. Super Meta (%)', `ec-comissaoSuper-${emp.id}`,   ecfg.comissaoSuper) +
      row('Comissão Loja (%)',   `ec-comissaoVR-${emp.id}`,      ecfg.comissaoVR) +
      row('Salário Fixo (R$)',   `ec-salarioFixo-${emp.id}`,     ecfg.salarioFixo) +
      row('INSS (%)',            `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',              `ec-vtRate-${emp.id}`,          ecfg.vtRate) +
      row('MAX. VT (R$)',        `ec-maxVT-${emp.id}`,           ecfg.maxVT);
  } else {
    fields =
      row('Com. Sem Meta (%)',  `ec-comissaoSemMeta-${emp.id}`, ecfg.comissaoSemMeta) +
      row('Com. Meta 1 (%)',    `ec-comissao-${emp.id}`,        ecfg.comissao) +
      row('Com. Meta 2 (%)',    `ec-comissaoMeta2-${emp.id}`,   ecfg.comissaoMeta2) +
      row('Com. Super Meta (%)',`ec-comissaoSuper-${emp.id}`,   ecfg.comissaoSuper) +
      row('Com. Loja Meta 1 (%)', `ec-comissaoVR-${emp.id}`,          ecfg.comissaoVR) +
      (tipo === 'sub' ?
        row('Com. Loja S/Meta (%)', `ec-comissaoVRSemMeta-${emp.id}`, ecfg.comissaoVRSemMeta) +
        row('Com. Loja Meta 2 (%)', `ec-comissaoVRMeta2-${emp.id}`,   ecfg.comissaoVRMeta2) +
        row('Com. Loja S.Meta (%)', `ec-comissaoVRSuper-${emp.id}`,   ecfg.comissaoVRSuper)
      : '') +
      (tipo === 'sub' || tipo === 'gvend'
        ? row('Salário Fixo (R$)', `ec-salarioFixo-${emp.id}`, ecfg.salarioFixo) : '') +
      (tipo === 'vendedor'
        ? `<div class="fp-emp-cfg-row" title="Deixe 0 para usar o Salário Fixo cadastrado na loja (Configurar → Vendedor no regime fixo + comissão)">
             <label>Salário Fixo (R$) <span style="color:#484f58;font-weight:400">0 = usa o da loja</span></label>
             ${inp(`ec-salarioFixo-${emp.id}`, ecfg.salarioFixo)}
           </div>` : '') +
      row('INSS (%)',           `ec-inssRate-${emp.id}`,        ecfg.inssRate) +
      row('VT (%)',             `ec-vtRate-${emp.id}`,          ecfg.vtRate) +
      row('MAX. VT (R$)',       `ec-maxVT-${emp.id}`,           ecfg.maxVT);
  }

  const chkPremiaoLoja = `<div class="fp-emp-cfg-row fp-emp-cfg-row--check">
    <label>Prêmio da loja?</label>
    <input type="checkbox" id="ec-recebePremiaoLoja-${emp.id}"${ecfg.recebePremiaoLoja ? ' checked' : ''}
      style="width:16px;height:16px;accent-color:#3fb950;cursor:pointer">
  </div>` + row('Valor prêm. loja/sem. (R$)', `ec-premioLojaValor-${emp.id}`, ecfg.premioLojaValor);

  // Vendedor pode ser comissionista puro (com garantia mínima) ou fixo + comissão
  const chkVendFixo = tipo === 'vendedor'
    ? `<div class="fp-emp-cfg-row fp-emp-cfg-row--check" title="Paga salário fixo + comissão. Sem complemento de garantia mínima.">
        <label>Fixo + comissão?</label>
        <input type="checkbox" id="ec-vendedorComFixo-${emp.id}"${ecfg.vendedorComFixo ? ' checked' : ''}
          style="width:16px;height:16px;accent-color:#3fb950;cursor:pointer">
      </div>`
    : '';

  return `
  <div class="fp-emp-cfg-wrap">
    <div class="fp-emp-cfg-toggle" onclick="fpToggleEmpCfg(${emp.id})">
      <span>⚙ Configuração</span>
      <span style="font-size:.72rem;font-weight:400">${src}</span>
      <span id="empCfgArrow-${emp.id}" style="margin-left:auto;font-size:.75rem">▼</span>
    </div>
    <div class="fp-emp-cfg" id="empCfg-${emp.id}">
      <div class="fp-emp-cfg-grid">${fields}${chkVendFixo}${chkPremiaoLoja}</div>
      <div class="fp-emp-cfg-actions">
        <button class="fp-btn primary" onclick="fpSaveEmpCfg(${emp.id})">Salvar</button>
        ${hasFolha ? `<button class="fp-btn" onclick="fpClearEmpCfg(${emp.id})">Resetar para cadastro</button>` : ''}
      </div>
    </div>
  </div>`;
}

function fpToggleEmpCfg(empId) {
  const el    = document.getElementById(`empCfg-${empId}`);
  const arrow = document.getElementById(`empCfgArrow-${empId}`);
  const wrap  = el?.closest('.fp-emp-cfg-wrap');
  const open  = wrap?.classList.toggle('open');
  if (arrow) arrow.textContent = open ? '▲' : '▼';
}

async function fpSaveEmpCfg(empId) {
  const g   = id => { const el = document.getElementById(id); return el != null ? r2(parseFloat(el.value)||0) : null; };
  const emp = FP.employees.find(e => e.id === empId);
  if (!emp) return;
  const tipo = cargoTipo(emp.cargo);

  let cfg = { inssRate: g(`ec-inssRate-${empId}`), vtRate: g(`ec-vtRate-${empId}`), maxVT: g(`ec-maxVT-${empId}`) };
  if (tipo === 'caixa') {
    cfg.salarioFixo = g(`ec-salarioFixo-${empId}`);
    cfg.quebraCaixa = g(`ec-quebraCaixa-${empId}`);
    cfg.comissaoVR  = g(`ec-comissaoVR-${empId}`);
  } else if (tipo === 'gerente') {
    cfg.comissaoSemMeta = g(`ec-comissaoSemMeta-${empId}`);
    cfg.comissao        = g(`ec-comissao-${empId}`);
    cfg.comissaoMeta2   = g(`ec-comissaoMeta2-${empId}`);
    cfg.comissaoSuper   = g(`ec-comissaoSuper-${empId}`);
    cfg.comissaoVR      = g(`ec-comissaoVR-${empId}`);
    cfg.salarioFixo     = g(`ec-salarioFixo-${empId}`);
  } else {
    cfg.comissaoSemMeta = g(`ec-comissaoSemMeta-${empId}`);
    cfg.comissao        = g(`ec-comissao-${empId}`);
    cfg.comissaoMeta2   = g(`ec-comissaoMeta2-${empId}`);
    cfg.comissaoSuper   = g(`ec-comissaoSuper-${empId}`);
    cfg.comissaoVR      = g(`ec-comissaoVR-${empId}`);
    if (tipo === 'sub') {
      cfg.comissaoVRSemMeta = g(`ec-comissaoVRSemMeta-${empId}`);
      cfg.comissaoVRMeta2   = g(`ec-comissaoVRMeta2-${empId}`);
      cfg.comissaoVRSuper   = g(`ec-comissaoVRSuper-${empId}`);
    }
    if (tipo === 'sub' || tipo === 'gvend' || tipo === 'vendedor')
      cfg.salarioFixo = g(`ec-salarioFixo-${empId}`);
    if (tipo === 'vendedor')
      cfg.vendedorComFixo = document.getElementById(`ec-vendedorComFixo-${empId}`)?.checked || false;
  }
  cfg.recebePremiaoLoja = document.getElementById(`ec-recebePremiaoLoja-${empId}`)?.checked || false;
  cfg.premioLojaValor   = g(`ec-premioLojaValor-${empId}`);

  try {
    await apiFetch(`/api/folha/empconfig/${empId}`, 'POST', cfg);
    FP.empConfig[empId] = cfg;
    // Folha encerrada é histórico: a config passa a valer para os próximos
    // meses, mas a entry fechada não é recalculada nem reescrita. Vale tanto
    // para a folha da loja inteira quanto para o encerramento individual.
    if (empCongelado(empId)) {
      selectEmp(empId);
      toast('Configuração salva ✓ — folha encerrada, valores deste mês mantidos.', 'warn', 6000);
      return;
    }
    // Sempre recalcula via defaultEntry após mudança de config — garante
    // que premiacaoBalanco, comissão e demais derivados reflitam o novo config
    const entry = applyFora(defaultEntry(emp), emp, FP.folha[FP.board]?.entries?.[empId]?.fora);
    if (FP.folha[FP.board]?.entries?.[empId]) FP.folha[FP.board].entries[empId] = entry;
    document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
    attachFormListeners(empId);
    toast('Configuração salva ✓');
  } catch (e) { toast('Erro: ' + e.message, true); }
}

async function fpClearEmpCfg(empId) {
  try {
    await apiFetch(`/api/folha/empconfig/${empId}`, 'POST', {});
    delete FP.empConfig[empId];
    const emp   = FP.employees.find(e => e.id === empId);
    const entry = FP.folha[FP.board]?.entries?.[empId] || defaultEntry(emp);
    document.getElementById('fpEmpForms').innerHTML = buildEmpForm(emp, entry);
    attachFormListeners(empId);
    toast('Resetado para valores do cadastro.');
  } catch (e) { toast('Erro: ' + e.message, true); }
}

function buildExtraRows(empId, extras, type) {
  return extras.map((ex,i) => {
    const isPrev = !!ex._prev;
    const rowStyle = isPrev ? 'border-left:2px solid #d29922;padding-left:.4rem;' : '';
    const hint = isPrev
      ? `<span title="Sugestão do mês anterior" style="font-size:.68rem;color:#d29922;white-space:nowrap">↩ mês ant.</span>`
      : '';
    return `<div class="fp-extra-row" style="${rowStyle}">
      ${hint}
      <input type="text" placeholder="Descrição" value="${ex.nome||''}"
        onchange="onExtraChange(${empId},'${type}',${i},'nome',this.value)">
      <input type="number" step="0.01" placeholder="0.00" value="${r2(ex.valor).toFixed(2)}"
        onchange="onExtraChange(${empId},'${type}',${i},'valor',this.value);onFieldChange(${empId})">
      <button class="fp-extra-btn" onclick="removeExtra(${empId},'${type}',${i})">×</button>
    </div>`;
  }).join('');
}

function buildForaRows(empId, fora, tipo, temFixo = false) {
  if (!fora.length)
    return `<div class="fp-fora-empty">Nenhum valor por fora — tudo vai para a contabilidade.</div>`;
  const opts = foraOrigemOpts(tipo, temFixo);
  return fora.map((f, i) => {
    const org = opts[f.origem] ? f.origem : foraOrigemDefault(tipo);
    return `<div class="fp-fora-row">
      <input type="text" placeholder="Descrição (ex.: complemento comissão)" value="${f.nome||''}"
        onchange="onForaField(${empId},${i},'nome',this.value)">
      <span style="font-size:.7rem;color:#8b949e">abate de</span>
      <select onchange="onForaField(${empId},${i},'origem',this.value);onForaChange(${empId})">
        ${Object.entries(opts).map(([k,l]) =>
          `<option value="${k}"${k===org?' selected':''}>${l}</option>`).join('')}
      </select>
      <input type="number" step="0.01" placeholder="0.00" value="${r2(f.valor).toFixed(2)}"
        onchange="onForaField(${empId},${i},'valor',this.value);onForaChange(${empId})">
      <button class="fp-extra-btn" onclick="removeFora(${empId},${i})">×</button>
    </div>`;
  }).join('');
}

// Todas as mutações de extras/por-fora passam por aqui ou pelos handlers abaixo.
// Com a entry congelada os botões somem da tela via CSS, mas a trava fica no
// código também: valor de rescisão fechada não muda por acidente.
function ensureEntry(empId) {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { entries: {} };
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  if (!FP.folha[board].entries[empId])
    FP.folha[board].entries[empId] = defaultEntry(FP.employees.find(e => e.id === empId));
  return FP.folha[board].entries[empId];
}

function addFora(empId) {
  if (empCongelado(empId)) return;
  const emp   = FP.employees.find(e => e.id === empId);
  const tipo  = cargoTipo(emp?.cargo);
  const entry = ensureEntry(empId);
  if (!entry.fora) entry.fora = [];
  entry.fora.push({ nome: '', valor: 0, origem: foraOrigemDefault(tipo) });
  FP.dirty = true;
  refreshFora(empId);
}

function removeFora(empId, idx) {
  if (empCongelado(empId)) return;
  FP.folha[FP.board]?.entries?.[empId]?.fora?.splice(idx, 1);
  FP.dirty = true;
  refreshFora(empId);
  onForaChange(empId);
}

function onForaField(empId, idx, field, value) {
  if (empCongelado(empId)) return;
  const arr = FP.folha[FP.board]?.entries?.[empId]?.fora;
  if (arr?.[idx]) arr[idx][field] = field === 'valor' ? r2(parseFloat(value)||0) : value;
  FP.dirty = true;
}

function refreshFora(empId) {
  const emp = FP.employees.find(e => e.id === empId);
  const arr = FP.folha[FP.board]?.entries?.[empId]?.fora || [];
  const c   = document.getElementById(`fora-rows-${empId}`);
  const fixoAtual = r2(FP.folha[FP.board]?.entries?.[empId]?.fixo || 0);
  if (c) c.innerHTML = buildForaRows(empId, arr, cargoTipo(emp?.cargo), fixoAtual > 0);
  recalc(empId);
}

// Ao mudar o "por fora" da comissão, o DSR declarado precisa acompanhar a
// comissão declarada (mesma fórmula de defaultEntry, sobre a base menor).
function onForaChange(empId) {
  const emp   = FP.employees.find(e => e.id === empId);
  const tipo  = cargoTipo(emp?.cargo);
  const dsrEl = document.getElementById(`fp-dsr-${empId}`);
  if (dsrEl && tipo !== 'caixa' && tipo !== 'socio' && tipo !== 'supervisor') {
    const g  = id => { const el = document.getElementById(id); return el ? r2(parseFloat(el.value)||0) : 0; };
    const du = FP.mensal.diasUteis || 22, df = FP.mensal.domingosFeriados || 4;
    const comDecl = r2(g(`fp-vendas-${empId}`) * g(`fp-comPct-${empId}`) / 100 - foraDe(empId).com);
    const base    = baseDivisaoContab(tipo, comDecl, g(`fp-comLoja-${empId}`));
    dsrEl.value = ((du + df) > 0 ? r2(base * df / (du + df)) : 0).toFixed(2);
  }
  onFieldChange(empId);
}

// ── Recalc ─────────────────────────────────────────────────────────────────
function recalc(empId) {
  const g     = id => { const el=document.getElementById(id); return el?r2(parseFloat(el.value)||0):0; };
  const emp   = FP.employees.find(e=>e.id===empId);
  const tipo  = cargoTipo(emp?.cargo);
  const entry = FP.folha[FP.board]?.entries?.[empId] || {};
  const du    = FP.mensal.diasUteis        || 22;
  const df    = FP.mensal.domingosFeriados || 4;
  const fb    = foraBreakdown(entry, tipo);

  let proventos = 0;

  if (tipo === 'socio' || tipo === 'supervisor') {
    const sBoards = emp?.supervisedBoards || [];
    const comTotal = r2(sBoards.reduce((s, b) => s + g(`fp-supCom-${empId}-${b}`), 0));
    const totEl = document.getElementById(`fp-supComTotal-${empId}`);
    if (totEl) totEl.textContent = brl(comTotal);
    const premTotal = r2(sBoards.reduce((s, b) => s + g(`fp-premLoja-${empId}-${b}`), 0));
    const premEl = document.getElementById(`fp-premLojaTotal-${empId}`);
    if (premEl) premEl.textContent = brl(premTotal);
    const ajudaTotal = r2(ajudaCustoBoards(emp).reduce((s, b) => s + g(`fp-ajuda-${empId}-${b}`), 0));
    const ajudaEl = document.getElementById(`fp-ajudaTotal-${empId}`);
    if (ajudaEl) ajudaEl.textContent = brl(ajudaTotal);
    const base = tipo === 'socio'
      ? r2(g(`fp-proLabore-${empId}`) + g(`fp-complemento-${empId}`))
      : g(`fp-fixo-${empId}`);
    proventos = r2(base + comTotal + premTotal + ajudaTotal);
  } else if (tipo === 'caixa') {
    proventos = g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`) + g(`fp-comLoja-${empId}`) + g(`fp-premiacaoBalanco-${empId}`);
  } else {
    const vendas   = g(`fp-vendas-${empId}`);
    const comPct   = g(`fp-comPct-${empId}`);
    const comTotal = comissaoDaLinhaVendas(emp, tipo, vendas, comPct);

    const totEl = document.getElementById(`fp-totalCom-${empId}`);
    if (totEl) totEl.textContent = brl(comTotal);

    const comLoja   = g(`fp-comLoja-${empId}`);
    const dsrVal    = g(`fp-dsr-${empId}`);
    const premioVal = g(`fp-premio-${empId}`);
    // Comissão declarada = total − parcela paga por fora
    const comDecl   = r2(comTotal - fb.com);
    // Base da divisão contábil (no sub-gerente inclui a comissão da loja)
    const baseContab = baseDivisaoContab(tipo, comDecl, comLoja);
    const comContab = r2(baseContab - dsrVal - premioVal);

    const comEl = document.getElementById(`fp-comissao-${empId}`);
    if (comEl) comEl.value = comContab.toFixed(2);

    const declEl = document.getElementById(`fp-declHint-${empId}`);
    if (declEl) {
      declEl.innerHTML = fb.com > 0
        ? `↳ contabilidade: <strong>${brl(comDecl)}</strong> · por fora: <strong>${brl(fb.com)}</strong>` +
          (comDecl < 0 ? ` <span style="color:#f85149">⚠ por fora maior que a comissão</span>` : '')
        : '';
    }

    const checkEl = document.getElementById(`fp-splitCheck-${empId}`);
    if (checkEl) {
      const soma = r2(comContab + dsrVal + premioVal);
      const ok   = Math.abs(soma - baseContab) < 0.02;
      checkEl.innerHTML = ok
        ? `<span style="color:#3fb950;font-size:.75rem">✓ ${brl(comContab)} + ${brl(dsrVal)} + ${brl(premioVal)} = ${brl(baseContab)}</span>`
        : `<span style="color:#f85149;font-size:.75rem">⚠ soma ${brl(soma)} ≠ ${brl(baseContab)}</span>`;
    }

    proventos = r2(g(`fp-fixo-${empId}`) + comTotal + comLoja + g(`fp-gm-${empId}`)
      + g(`fp-premiacao-${empId}`) + g(`fp-premiacaoBalanco-${empId}`));
  }

  proventos = r2(proventos + g(`fp-feriado-${empId}`)
    + (entry.extras||[]).reduce((s,ex)=>s+r2(ex.valor),0));

  // Proventos declarados = bruto − tudo que é pago por fora
  const proventosDecl = r2(proventos - fb.total);

  const descontos = r2(
    g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`) +
    g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`) +
    g(`fp-faltasValor-${empId}`) +
    (entry.extrasDesc||[]).reduce((s,ex)=>s+r2(ex.valor),0)
  );

  const liquido = r2(proventosDecl - descontos);
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=brl(v); };
  set(`val-proventos-${empId}`, proventosDecl);
  set(`val-desc-${empId}`, descontos);
  set(`val-liquido-${empId}`, liquido);
  set(`val-fora-${empId}`, fb.total);
  set(`val-totalgeral-${empId}`, r2(liquido + fb.total));

  const noteEl = document.getElementById(`liquido-note-${empId}`);
  if (noteEl) noteEl.textContent = fb.total > 0 ? 'valor declarado na contabilidade' : '';

  const barEl = document.getElementById(`geral-bar-${empId}`);
  if (barEl) barEl.style.display = fb.total > 0 ? 'flex' : 'none';
  const detEl = document.getElementById(`geral-detail-${empId}`);
  if (detEl) detEl.textContent = fb.total > 0
    ? `${brl(liquido)} contabilidade + ${brl(fb.total)} por fora` : '';

  updateRateio(empId);

  const hintEl = document.getElementById(`fora-hint-${empId}`);
  if (hintEl) {
    const parts = [];
    if (fb.com    > 0) parts.push(`Comissão: ${brl(fb.com)} fora da contabilidade`);
    if (fb.fixo   > 0) parts.push(`${tipo==='socio'?'Pró-labore':'Salário fixo'}: ${brl(fb.fixo)} fora da contabilidade`);
    if (fb.outros > 0) parts.push(`Outros: ${brl(fb.outros)} fora da contabilidade`);
    hintEl.innerHTML = parts.length
      ? `${parts.join(' · ')}<br>Proventos bruto ${brl(proventos)} → declarado ${brl(proventosDecl)}`
      : '';
  }
}

function attachFormListeners(empId) {
  document.getElementById(`empform-${empId}`)
    ?.querySelectorAll('input[type=number]:not(.fp-readonly)')
    .forEach(inp => inp.addEventListener('input', ()=>onFieldChange(empId)));
}

function onFieldChange(empId) {
  FP.dirty = true;
  saveEntryFromForm(empId);
  recalc(empId);
}

function saveEntryFromForm(empId) {
  // Entry congelada é o que foi pago: nem o formulário a reescreve. Sem esta
  // trava, só passar pela aba do colaborador já regravaria os valores.
  if (empCongelado(empId)) return;
  const emp  = FP.employees.find(e=>e.id===empId);
  const tipo = cargoTipo(emp?.cargo);

  if (!FP.folha[FP.board]) FP.folha[FP.board] = { entries:{} };
  if (!FP.folha[FP.board].entries) FP.folha[FP.board].entries = {};
  const prev = FP.folha[FP.board].entries[empId] || {};

  // Vários campos só existem no formulário sob condição (GM, salário fixo,
  // premiação, comissão de loja…). Se a linha não está na tela, o valor já
  // gravado é preservado — campo ausente nunca pode zerar histórico.
  const CAMPO_ENTRY = {
    fixo: 'fixo', quebra: 'quebra', vendas: 'vendas', comPct: 'comissaoPct',
    comLoja: 'comissaoLoja', gm: 'gmComplement', premiacao: 'premiacao',
    premiacaoBalanco: 'premiacaoBalanco', feriado: 'feriado', dsr: 'dsr',
    premio: 'premio', proLabore: 'proLabore', complemento: 'complemento',
    valeCompras: 'valeCompras', adiantamento: 'adiantamento', inss: 'inss',
    irpf: 'irpf', vt: 'vt', arred: 'arredondamento', faltasValor: 'faltasValor',
  };
  const g = id => {
    const el = document.getElementById(id);
    if (el) return r2(parseFloat(el.value) || 0);
    const campo = CAMPO_ENTRY[String(id).replace(/^fp-/, '').replace(new RegExp(`-${empId}$`), '')];
    return campo ? r2(prev[campo] || 0) : 0;
  };

  // Faltas: as datas viram texto na coluna FALTAS da contabilidade e o valor
  // é desconto como qualquer outro — entra no total e no líquido.
  const faltasEl = document.getElementById(`fp-faltas-${empId}`);
  const faltas   = faltasEl ? faltasEl.value.trim() : (prev.faltas || '');

  const extProv = (prev.extras||[]).reduce((s,ex)=>s+r2(ex.valor),0);
  const extDesc = (prev.extrasDesc||[]).reduce((s,ex)=>s+r2(ex.valor),0);
  const fb      = foraBreakdown(prev, tipo);
  // Campos do "por fora" gravados junto da entry — proventos/líquido são
  // sempre os valores DECLARADOS; totalGeral é o que o funcionário recebe.
  const foraFields = (declaradoBase, comissaoTotal) => ({
    fora: prev.fora || [],
    foraComissao: fb.com, foraFixo: fb.fixo, foraOutros: fb.outros, totalFora: fb.total,
    fixoDeclarado:     r2(declaradoBase - fb.fixo),
    comissaoDeclarada: r2((comissaoTotal || 0) - fb.com),
  });

  if (tipo === 'socio' || tipo === 'supervisor') {
    const sBoards = emp?.supervisedBoards || [];
    const lojaComissoes = sBoards.map(b => ({
      board: b,
      vendas:      r2(FP.lojaVendaMap[b] || 0),
      comissaoPct: prev.comissaoPct || 0,
      comissao:    g(`fp-supCom-${empId}-${b}`),
    }));
    const comissaoTotal = r2(lojaComissoes.reduce((s, l) => s + l.comissao, 0));
    const premiacaoLojas = sBoards
      .map(b => ({ board: b, valor: g(`fp-premLoja-${empId}-${b}`),
                   semanas: (prev.premiacaoLojas || []).find(l => l.board === b)?.semanas || [] }))
      .filter(l => l.valor !== 0 || (prev.premiacaoLojas || []).some(p => p.board === l.board));
    const premiacaoBalanco = r2(premiacaoLojas.reduce((s, l) => s + l.valor, 0));
    // Ajuda de custo: campo manual por loja. Sem o form na tela, o valor já
    // gravado é preservado — campo ausente nunca pode zerar o que foi lançado.
    const ajudaBoards = ajudaCustoBoards(emp);
    const ajudaPrev = ajudaCustoPorBoard(empId, ajudaBoards, prev);
    const ajudaCustoLojas = ajudaBoards.map((b, i) => ({
      board: b,
      valor: document.getElementById(`fp-ajuda-${empId}-${b}`)
        ? g(`fp-ajuda-${empId}-${b}`) : ajudaPrev[i].valor,
    }));
    const ajudaCustoTotal = somaAjuda(ajudaCustoLojas);
    const proLabore   = tipo === 'socio' ? g(`fp-proLabore-${empId}`)   : 0;
    const complemento = tipo === 'socio' ? g(`fp-complemento-${empId}`) : 0;
    const fixo    = tipo === 'supervisor' ? g(`fp-fixo-${empId}`) : 0;
    const feriado = g(`fp-feriado-${empId}`);
    const proventosBruto = r2((tipo === 'socio' ? proLabore + complemento : fixo)
      + comissaoTotal + premiacaoBalanco + ajudaCustoTotal + feriado + extProv);
    const proventos = r2(proventosBruto - fb.total);
    const totalDesc = r2(g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`) +
      g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`) + g(`fp-arred-${empId}`) +
      g(`fp-faltasValor-${empId}`) + extDesc);
    const liquido = r2(proventos - totalDesc);
    FP.folha[FP.board].entries[empId] = {
      ...prev, tipo, proLabore, complemento, fixo, lojaComissoes, comissaoTotal,
      premiacaoLojas, premiacaoBalanco, ajudaCustoLojas, ajudaCustoTotal,
      premiacaoManual: premiacaoBalanco !== premiacaoCalculada(emp).premiacaoBalanco,
      vendas: prev.vendas, meta: prev.meta, pctMeta: prev.pctMeta,
      faixaLabel: prev.faixaLabel, comissaoPct: prev.comissaoPct,
      feriado, proventos, proventosBruto,
      ...foraFields(tipo === 'socio' ? proLabore : fixo, comissaoTotal),
      valeCompras: g(`fp-valeCompras-${empId}`), adiantamento: g(`fp-adiantamento-${empId}`),
      inss: g(`fp-inss-${empId}`), irpf: g(`fp-irpf-${empId}`),
      vt: g(`fp-vt-${empId}`), arredondamento: g(`fp-arred-${empId}`),
      faltas, faltasValor: g(`fp-faltasValor-${empId}`),
      totalDescontos: totalDesc, liquido, totalGeral: r2(liquido + fb.total),
    };
    return;
  }

  let proventosBruto=0, comissaoTotal=0, comissaoContab=0, dsr=0, premio=0;

  if (tipo === 'caixa') {
    proventosBruto = r2(g(`fp-fixo-${empId}`) + g(`fp-quebra-${empId}`)
      + g(`fp-comLoja-${empId}`) + g(`fp-premiacaoBalanco-${empId}`) + g(`fp-feriado-${empId}`) + extProv);
  } else {
    const vendas  = g(`fp-vendas-${empId}`);
    const comPct  = g(`fp-comPct-${empId}`);
    comissaoTotal  = comissaoDaLinhaVendas(emp, tipo, vendas, comPct);
    dsr            = g(`fp-dsr-${empId}`);
    premio         = g(`fp-premio-${empId}`);
    comissaoContab = r2(baseDivisaoContab(tipo, r2(comissaoTotal - fb.com), g(`fp-comLoja-${empId}`)) - dsr - premio);
    proventosBruto = r2(g(`fp-fixo-${empId}`) + comissaoTotal
      + g(`fp-comLoja-${empId}`) + g(`fp-gm-${empId}`)
      + g(`fp-premiacao-${empId}`) + g(`fp-premiacaoBalanco-${empId}`)
      + g(`fp-feriado-${empId}`) + extProv);
  }
  const proventos = r2(proventosBruto - fb.total);

  // Ajuste manual da premiação tem prioridade sobre o valor calculado pelo servidor
  const premiacao        = g(`fp-premiacao-${empId}`);
  const premiacaoBalanco = g(`fp-premiacaoBalanco-${empId}`);
  const _calc            = premiacaoCalculada(emp);
  const premiacaoManual  = premiacao !== _calc.premiacao
    || premiacaoBalanco !== _calc.premiacaoBalanco;

  const totalDesc = r2(g(`fp-valeCompras-${empId}`) + g(`fp-adiantamento-${empId}`)
    + g(`fp-inss-${empId}`) + g(`fp-irpf-${empId}`) + g(`fp-vt-${empId}`)
    + g(`fp-arred-${empId}`) + g(`fp-faltasValor-${empId}`) + extDesc);

  FP.folha[FP.board].entries[empId] = {
    ...prev, tipo,
    fixo:           g(`fp-fixo-${empId}`),
    quebra:         g(`fp-quebra-${empId}`),
    vendas:         g(`fp-vendas-${empId}`),
    comissaoPct:    g(`fp-comPct-${empId}`),
    faixaLabel:     prev.faixaLabel,
    comissaoTotal, comissaoContab, dsr, premio,
    comissaoLoja:      g(`fp-comLoja-${empId}`),
    gmComplement:      g(`fp-gm-${empId}`),
    premiacao, premiacaoBalanco, premiacaoManual,
    premiacaoNaLoja:   _calc.premiacaoNaLoja,
    feriado:           g(`fp-feriado-${empId}`),
    proventos, proventosBruto,
    ...foraFields(g(`fp-fixo-${empId}`), comissaoTotal),
    valeCompras:    g(`fp-valeCompras-${empId}`),
    adiantamento:   g(`fp-adiantamento-${empId}`),
    inss:           g(`fp-inss-${empId}`),
    irpf:           g(`fp-irpf-${empId}`),
    vt:             g(`fp-vt-${empId}`),
    arredondamento: g(`fp-arred-${empId}`),
    faltas, faltasValor: g(`fp-faltasValor-${empId}`),
    totalDescontos: totalDesc,
    liquido: r2(proventos - totalDesc),
    totalGeral: r2(proventos - totalDesc + fb.total),
  };
}

// ── Extras ─────────────────────────────────────────────────────────────────
function addExtra(empId, type) {
  if (empCongelado(empId)) return;
  const board = FP.board;
  if (!FP.folha[board]?.entries?.[empId]) {
    if (!FP.folha[board]) FP.folha[board] = {entries:{}};
    if (!FP.folha[board].entries) FP.folha[board].entries = {};
    FP.folha[board].entries[empId] = defaultEntry(FP.employees.find(e=>e.id===empId));
  }
  const key = type==='prov'?'extras':'extrasDesc';
  if (!FP.folha[board].entries[empId][key]) FP.folha[board].entries[empId][key] = [];
  FP.folha[board].entries[empId][key].push({nome:'',valor:0});
  FP.dirty = true;
  refreshExtras(empId, type);
}

function removeExtra(empId, type, idx) {
  if (empCongelado(empId)) return;
  const key = type==='prov'?'extras':'extrasDesc';
  FP.folha[FP.board]?.entries?.[empId]?.[key]?.splice(idx,1);
  FP.dirty = true;
  refreshExtras(empId, type);
  onFieldChange(empId);
}

function onExtraChange(empId, type, idx, field, value) {
  if (empCongelado(empId)) return;
  const key = type==='prov'?'extras':'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key];
  if (arr?.[idx]) {
    arr[idx][field] = field==='valor'?r2(parseFloat(value)||0):value;
    delete arr[idx]._prev; // user edited it — no longer a suggestion
  }
  FP.dirty = true;
}

function refreshExtras(empId, type) {
  const key = type==='prov'?'extras':'extrasDesc';
  const arr = FP.folha[FP.board]?.entries?.[empId]?.[key]||[];
  const c   = document.getElementById(`extras-${type}-${empId}`);
  if (c) c.innerHTML = buildExtraRows(empId, arr, type);
}

// ── Gerar ──────────────────────────────────────────────────────────────────
function fpGerar() {
  const board = FP.board;
  if (FP.folha[board]?.encerrada) {
    toast('Folha encerrada — reabra antes de gerar. O histórico não é recalculado.', true, 6000);
    return;
  }
  if (!FP.folha[board]) FP.folha[board] = {};
  if (!FP.folha[board].entries) FP.folha[board].entries = {};
  // Colaborador com folha individual encerrada (rescisão já fechada) fica de
  // fora — é exatamente para isso que o encerramento individual existe.
  const congelados = [];
  for (const emp of boardEmps(board)) {
    if (entryEncerrada(emp.id, board)) {
      congelados.push(emp.apelido || emp.name.split(' ')[0]);
      continue;
    }
    // "por fora" é decisão manual, não valor calculado — sobrevive ao Gerar
    const fora = FP.folha[board].entries[emp.id]?.fora;
    FP.folha[board].entries[emp.id] = applyFora(defaultEntry(emp), emp, fora);
  }
  FP.dirty = true;
  renderPanel();

  if (congelados.length) {
    toast(`Folha gerada. ${congelados.join(', ')} não ${congelados.length > 1 ? 'foram recalculados' : 'foi recalculado'} — folha individual encerrada.`, 'warn', 7000);
    return;
  }

  // Lançamento cujo colaborador não bate com ninguém do cadastro não entra em
  // entry nenhuma — avisa para não sumir em silêncio da folha.
  const avisos = [];
  const orfaos = (FP.adiantamentosSemVinculo || []).filter(a => a.board === board);
  if (orfaos.length)
    avisos.push(`Adiantamento sem colaborador no cadastro: ${orfaos.map(a => `${a.colaborador} (${brl(a.valor)})`).join(', ')}`);
  const faltasOrfas = (FP.faltasSemVinculo || []).filter(f => f.board === board);
  if (faltasOrfas.length)
    avisos.push(`Falta sem colaborador no cadastro: ${faltasOrfas.map(f => `${f.colaborador} (${f.date.slice(8,10)}/${f.date.slice(5,7)})`).join(', ')}`);

  if (avisos.length) toast(`Folha gerada. ⚠ ${avisos.join(' · ')} — lance à mão.`, 'warn', 9000);
  else toast('Folha gerada.');
}

function fpGerarEmp(empId) {
  const emp = FP.employees.find(e => e.id === empId);
  if (!emp) return;
  if (FP.folha[FP.board]?.encerrada) {
    toast('Folha encerrada — reabra antes de recalcular. O histórico não é alterado.', true, 6000);
    return;
  }
  if (entryEncerrada(empId)) {
    toast(`Folha de ${emp.apelido || emp.name.split(' ')[0]} encerrada — reabra antes de recalcular.`, true, 6000);
    return;
  }
  const hasData = !!(FP.folha[FP.board]?.entries?.[empId]);
  if (hasData && !confirm(`Recalcular a folha de ${emp.apelido || emp.name}? Os valores editados manualmente serão perdidos.`)) return;
  if (!FP.folha[FP.board]) FP.folha[FP.board] = {};
  if (!FP.folha[FP.board].entries) FP.folha[FP.board].entries = {};
  const fora = FP.folha[FP.board].entries[empId]?.fora;
  FP.folha[FP.board].entries[empId] = applyFora(defaultEntry(emp), emp, fora);
  FP.dirty = true;
  selectEmp(empId);
  toast(`Folha de ${emp.apelido || emp.name} recalculada.`);
}

// ── Salvar / Exportar ──────────────────────────────────────────────────────
async function fpSalvar() {
  if (!FP.board) return;
  if (FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(FP.board);
    toast('Salvo.');
  } catch(e) { toast('Erro: '+e.message, true); }
}

async function fpEncerrar() {
  const board = FP.board;
  if (!FP.folha[board]) FP.folha[board] = { entries: {} };
  const enc = FP.folha[board].encerrada;
  if (!enc && FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  FP.folha[board].encerrada = !enc;
  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(board);
    renderPanel();
    if (FP.activeEmpId) {
      const emp = FP.employees.find(e => e.id === FP.activeEmpId);
      if (emp) selectEmp(emp.id);
    }
    toast(enc ? 'Folha reaberta.' : 'Folha encerrada ✓');
  } catch(e) { toast('Erro: '+e.message, true); }
}

// Encerramento individual — o caso de uso é rescisão: fecha o acerto de quem
// saiu antes da folha do resto da loja e protege os valores dali em diante.
async function fpEncerrarEmp(empId) {
  const board = FP.board;
  const emp   = FP.employees.find(e => e.id === empId);
  if (!emp) return;
  if (folhaEncerrada(board)) {
    toast('A folha da loja inteira está encerrada — use Reabrir Folha.', true, 6000);
    return;
  }
  const nome = emp.apelido || emp.name.split(' ')[0];
  const enc  = entryEncerrada(empId, board);

  if (!enc) {
    // Grava o que está na tela ANTES de congelar — é esse valor que fica.
    if (FP.activeEmpId === empId) saveEntryFromForm(empId);
    if (!FP.folha[board]?.entries?.[empId]) {
      toast(`Gere a folha de ${nome} antes de encerrar.`, true, 5000);
      return;
    }
    if (!confirm(`Encerrar a folha de ${nome}?

Os valores ficam congelados: "Gerar Folha", mudança de config e recálculo de premiação deixam de mexer nele. Dá para reabrir depois.`)) return;
  }

  const prev = FP.folha[board].entries[empId];
  FP.folha[board].entries[empId] = enc
    ? { ...prev, encerrada: false, encerradaEm: null }
    : { ...prev, encerrada: true,  encerradaEm: new Date().toISOString() };

  try {
    await apiFetch(`/api/folha/${FP.year}/${FP.month}`, 'POST', FP.folha);
    FP.dirty = false;
    renderStoreButtons(board);
    renderEmpTabs(boardEmps(board));
    selectEmp(empId);
    toast(enc ? `Folha de ${nome} reaberta.` : `Folha de ${nome} encerrada ✓`);
  } catch (e) {
    FP.folha[board].entries[empId] = prev;   // desfaz se o servidor recusou
    toast('Erro: ' + e.message, true);
  }
}

async function fpExportar() {
  await fpSalvar();
  window.location.href = `/api/folha/${FP.year}/${FP.month}/export?board=${FP.board}`;
}

async function fpExportarContabilidade() {
  await fpSalvar();
  window.location.href = `/api/folha/${FP.year}/${FP.month}/contabilidade?board=${FP.board}`;
}

async function fpLogout() {
  try { await apiFetch('/api/logout', 'POST'); } catch {}
  location.href = '/';
}

// ── Recibos (impressão) ────────────────────────────────────────────────────
function fpImprimirRecibos(soEmpId = null) {
  if (!FP.board) { toast('Selecione uma loja.', true); return; }
  if (FP.activeEmpId) saveEntryFromForm(FP.activeEmpId);
  const emps = boardEmps(FP.board).filter(e =>
    FP.folha[FP.board]?.entries?.[e.id] && (soEmpId == null || e.id === soEmpId));
  if (!emps.length) { toast('Gere a folha antes de imprimir.', true); return; }
  const mes    = MONTHS_PT[FP.month - 1].substring(0, 3) + '/' + String(FP.year).substring(2);
  const origin = window.location.origin;
  const pages  = emps.map((e, i) =>
    buildRecibo(e, FP.folha[FP.board].entries[e.id], mes, origin) +
    (i < emps.length - 1 ? '<div style="page-break-after:always"></div>' : '')
  ).join('');
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) { toast('Permita popups para imprimir.', true); return; }
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8">
<title>${soEmpId ? 'Recibo — ' + (emps[0].apelido || emps[0].name) : 'Recibos — ' + BOARDS_INFO[FP.board]?.label} — ${mes}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#000;background:#fff}
@media print{@page{size:A4 portrait;margin:8mm 10mm}}
@media screen{.recibo{max-width:720px;margin:20px auto;padding:12px;border:1px solid #ccc;border-radius:4px}}
</style>
</head><body>${pages}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch(_) {} }, 600);
}

function buildRecibo(emp, entry, mes, origin) {
  const ecfg = getEmpCfg(emp);
  const tipo = entry.tipo || cargoTipo(emp.cargo);
  const cfg  = FP.folhaConfig[emp.board] || {};
  const loja = BOARDS_INFO[emp.board]?.label || emp.board.toUpperCase();
  const adm  = emp.admissao ? `ADM. ${emp.admissao}` : '';

  // Configuração visual por loja
  const STORE_RECIBO = {
    tommy: {
      logoFile: 'logotommy.svg',
      logoAlt:  'Tommy Hilfiger',
      tagline:  'Somos do tamanho que nos permitimos ser... Lute, insista... Permita-se',
      garantia: 'GARANTIA TOMMY',
    },
  };
  const rc = STORE_RECIBO[emp.board] || {
    logoFile: 'logosurfers.webp',
    logoAlt:  "Surfer's",
    tagline:  'Um time, um objetivo, uma conquista.',
    garantia: 'GARANTIA SURFERS',
  };

  const num   = v => Math.round((parseFloat(v)||0)*100)/100;
  const fmt   = v => num(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const money = v => { const n=num(v); return n===0 ? 'R$&nbsp;-' : `R$&nbsp;${fmt(n)}`; };

  const tr = (label, val, base='', pct='', bold=false, bg='') =>
    `<tr${bg ? ` style="background:${bg}"` : ''}>` +
    `<td style="padding:2px 5px;${bold?'font-weight:700;':''}">${label}</td>` +
    `<td style="padding:2px 5px;text-align:right">${base !== '' && num(base) !== 0 ? `<strong>${fmt(num(base))}</strong>` : ''}</td>` +
    `<td style="padding:2px 5px;text-align:center;font-size:9pt">${pct}</td>` +
    `<td style="padding:2px 5px;text-align:right;white-space:nowrap">${money(val)}</td>` +
    `</tr>`;

  const gap = `<tr><td colspan="4" style="height:5px"></td></tr>`;
  const cols = `<colgroup><col style="width:54%"><col style="width:16%"><col style="width:11%"><col style="width:19%"></colgroup>`;
  const tbl  = `border-collapse:collapse;width:100%;border:1px solid #000;font-size:10pt;`;

  // ── Pagamento por fora ──
  // O complemento entra como linha destacada logo abaixo da linha que ele abate
  // (salário fixo / vendas próprias), para o colaborador conferir na hora:
  // declarado + complemento = valor cheio. PROVENTOS é o total cheio.
  const foraLinhas = (entry.fora || []).filter(f => num(f.valor));
  const totalFora  = num(foraLinhas.reduce((s, f) => s + num(f.valor), 0));
  const abateCom   = !(tipo === 'socio' || tipo === 'supervisor'); // comissão em linha única
  const fixoBase   = tipo === 'socio' ? entry.proLabore : entry.fixo;
  const fixoDecl   = num(entry.fixoDeclarado != null ? entry.fixoDeclarado : fixoBase);
  const comDecl    = num(abateCom && entry.comissaoDeclarada != null
    ? entry.comissaoDeclarada : entry.comissaoTotal);

  const foraOrgDe  = f => {
    const opts = foraOrigemOpts(tipo, num(entry.fixo) > 0);
    const o = opts[f.origem] ? f.origem : foraOrigemDefault(tipo);
    // sócio/supervisor: comissão é rateada entre lojas, não há linha única a abater
    return (o === 'comissao' && !abateCom) ? 'outros' : o;
  };
  // Complemento com linha de origem visível → soma nos proventos junto com ela
  const complRows = org => foraLinhas.filter(f => foraOrgDe(f) === org)
    .map(f => tr((f.nome || 'COMPLEMENTO').toUpperCase(), f.valor, '', '', false, '#fef9c3'))
    .join('');
  // Supervisor/sócio: proventos em blocos por empresa, com os valores cheios —
  // não há linha de complemento a somar, todo "por fora" vira nota de rodapé.
  const blocosPorLoja = tipo === 'supervisor' || tipo === 'socio';
  // Origem "Outros" já está embutida nas linhas cheias acima — vira nota de rodapé
  const foraMemo = blocosPorLoja ? foraLinhas : foraLinhas.filter(f => foraOrgDe(f) === 'outros');

  // ── Proventos ──
  let prov = '';
  if (tipo === 'caixa') {
    prov += tr('SALÁRIO FIXO',    fixoDecl, fixoDecl);
    prov += complRows('fixo');
    prov += tr('QUEBRA DE CAIXA', entry.quebra || 0, entry.quebra);
    if (num(entry.comissaoLoja) > 0)
      prov += tr('COMISSÃO LOJA', entry.comissaoLoja, entry.vendaLoja,
        ecfg.comissaoVR ? fmt(ecfg.comissaoVR) + '%' : '');
    if (num(entry.premiacaoBalanco) > 0) {
      const semDetGerC = (FP.premiacaoSemanalGerDetalhe[emp.id] || []);
      const semSumGerC = semDetGerC.reduce((s, x) => s + num(x.valor), 0);
      if (semDetGerC.length && Math.abs(semSumGerC - num(entry.premiacaoBalanco)) < 0.02) {
        semDetGerC.forEach(s => prov += tr(`PREM. LOJA SEM. ${s.label}`, s.valor));
      } else {
        prov += tr('PREM. META LOJA', entry.premiacaoBalanco);
      }
    }
  } else if (blocosPorLoja) {
    // Um bloco por empresa: a comissão que ela gerou, a parte do fixo, a
    // premiação e a ajuda de custo, fechando com o subtotal da empresa. Usa o
    // mesmo cálculo do rateio da tela, então os subtotais nunca divergem dos
    // proventos. Feriado, extras e o pró-labore-complemento saem soltos abaixo.
    const _src   = rateioSrcFromEntry(emp, entry, tipo);
    const _rows  = calcRateioLojas(emp, tipo, _src);
    const sup    = emp.supervisedBoards || [];
    // No sócio o rateio divide pró-labore + complemento juntos
    const fixoLbl = tipo === 'socio' ? 'PRÓ-LABORE' : 'FIXO';
    const subTr  = (label, val) =>
      `<tr style="background:#e8e8e8">` +
      `<td colspan="3" style="padding:2px 5px;text-align:right;font-weight:700">${label}</td>` +
      `<td style="padding:2px 5px;text-align:right;font-weight:700;white-space:nowrap">${money(val)}</td>` +
      `</tr>`;

    // Empresa que só paga ajuda de custo (escritório) — linha solta no topo
    _rows.filter(r => !sup.includes(r.board) && num(r.ajuda))
      .forEach(r => prov += tr(`AJC ${_biOf(r.board).label.toUpperCase()}`, r.ajuda));

    _rows.filter(r => sup.includes(r.board)).forEach(r => {
      const bi  = _biOf(r.board);
      const lj  = (entry.lojaComissoes || []).find(l => l.board === r.board) || {};
      const pjl = (entry.premiacaoLojas || []).find(l => l.board === r.board) || {};
      prov += gap;
      prov += tr(bi.label.toUpperCase(), r.comissao, lj.vendas || 0,
        num(lj.comissaoPct) ? fmt(lj.comissaoPct) + '%' : '', true, '#f0f0f0');
      if (num(r.fixo)) prov += tr(fixoLbl, r.fixo);
      if (num(r.premiacao)) {
        const sem    = pjl.semanas || [];
        const semSum = sem.reduce((s, x) => s + num(x.valor), 0);
        if (sem.length && Math.abs(semSum - num(r.premiacao)) < 0.02)
          sem.forEach(s => prov += tr(`PREMIAÇÃO SEM. ${s.label}`, s.valor));
        else
          prov += tr('PREMIAÇÃO', r.premiacao);
      }
      if (num(r.ajuda)) prov += tr('AJC', r.ajuda);
      prov += subTr(bi.label.toUpperCase(), r2(r.fixo + r.comissao + r.premiacao + r.ajuda));
    });
    prov += gap;

    // Sobra de folha antiga sem quebra por loja — mantém o recibo fechando
    const _outrosSolto = r2(num(entry.feriado) + (entry.extras || []).reduce((s, x) => s + num(x.valor), 0));
    const _sobra = r2(_src.outros - _outrosSolto);
    if (num(_sobra)) prov += tr('OUTROS', _sobra);
  } else {
    // Vendedor só entra aqui quando está no regime fixo + comissão
    if (tipo === 'gerente' || tipo === 'sub' || tipo === 'gvend' || num(entry.fixo) > 0) {
      prov += tr('SALÁRIO FIXO', fixoDecl, fixoDecl);
      prov += complRows('fixo');
    }
    const faixaColors = {'SEM META':'#888','META 1':'#b8860b','META 2':'#2e7d32','SUPER META':'#00838f'};
    const faixaLbl   = entry.faixaLabel || '—';
    const faixaClr   = faixaColors[faixaLbl] || '#888';
    const pctMeta    = num(entry.pctMeta) ||
      (num(entry.meta) > 0 ? Math.round(num(entry.vendas) / num(entry.meta) * 10) / 10 : 0);
    const infoParts  = [
      entry.comissaoPct ? fmt(entry.comissaoPct) + '% comissão' : '',
      pctMeta > 0       ? fmt(pctMeta) + '% da meta'            : '',
      faixaLbl !== '—'  ? faixaLbl                               : '',
    ].filter(Boolean).join('  ·  ');
    if (infoParts)
      prov += `<tr><td colspan="4" style="padding:1px 5px 0;font-size:8pt;color:${faixaClr};font-style:italic">${infoParts}</td></tr>`;
    prov +=
      `<tr>` +
      `<td style="padding:1px 5px 2px">${tipo === 'gerente' ? 'VENDAS LOJA' : (tipo === 'gvend' || tipo === 'sub') ? 'VENDAS PRÓPRIAS' : 'VENDAS'}</td>` +
      `<td style="padding:1px 5px 2px;text-align:right">${num(entry.vendas) ? `<strong>${fmt(num(entry.vendas))}</strong>` : ''}</td>` +
      `<td></td>` +
      `<td style="padding:1px 5px 2px;text-align:right;white-space:nowrap">${money(comDecl)}</td>` +
      `</tr>`;
    prov += complRows('comissao');
    const gm = tipo === 'gerente'
      ? r2(cfg.garantiaMinimaGerente || cfg.garantiaMinima || 0)
      : (tipo === 'sub' || tipo === 'gvend')
        ? r2(cfg.garantiaMinimaSubGerente || cfg.garantiaMinima || 0)
        : r2(cfg.garantiaMinima || 0);
    if (num(entry.gmComplement) > 0)
      prov += tr(rc.garantia, entry.gmComplement, gm, '', false, '#fef9c3');
    if (num(entry.comissaoLoja) > 0)
      prov += tr((tipo === 'gvend' || tipo === 'sub') ? 'VENDAS DA LOJA' : 'COMISSÃO LOJA', entry.comissaoLoja, entry.vendaLoja,
        ecfg.comissaoVR ? fmt(ecfg.comissaoVR) + '%' : '');
    // Premiação: vendedor usa detalhe individual; gerente usa detalhe gerente; gvend ambos
    const _pTipo = tipo;
    const semDetVend = (_pTipo !== 'gerente') ? (FP.premiacaoSemanalDetalhe[emp.id] || []) : [];
    const semDetGer  = (_pTipo === 'gerente' || _pTipo === 'gvend' || ecfg.recebePremiaoLoja) ? (FP.premiacaoSemanalGerDetalhe[emp.id] || []) : [];
    const premTotal = num(entry.premiacao);
    if (premTotal > 0) {
      const semSumVend = semDetVend.reduce((s, x) => s + num(x.valor), 0);
      const useDetVend = semDetVend.length && Math.abs(semSumVend - premTotal) < 0.02;
      if (useDetVend) {
        const label = _pTipo === 'gvend' ? 'PREM. VEND.' : 'PREM.';
        semDetVend.forEach(s => prov += tr(`${label} SEM. ${s.label}`, s.valor));
      } else {
        prov += tr(_pTipo === 'gerente' ? 'PREM. GERENTE' : _pTipo === 'gvend' ? 'PREM. VENDEDOR' : 'PREMIAÇÃO', entry.premiacao);
      }
    }
    // Prêmio que a loja já pagou pelo caixa: linha de memória, sem valor na
    // coluna de proventos — o recibo quita só o que passa pela folha.
    const premNaLojaRec = num(entry.premiacaoNaLoja);
    if (premNaLojaRec > 0) {
      // Gerente tem o semanal no detalhe de gerente; os demais, no de vendedor
      const semDetNaLoja = _pTipo === 'gerente' ? semDetGer : semDetVend;
      const semSumNaLoja = semDetNaLoja.reduce((s, x) => s + num(x.valor), 0);
      const detNaLoja = semDetNaLoja.length && Math.abs(semSumNaLoja - premNaLojaRec) < 0.02
        ? semDetNaLoja.map(s => `sem. ${s.label}: ${money(s.valor)}`).join('  ·  ')
        : '';
      prov += `<tr><td colspan="4" style="padding:2px 5px 0;font-size:8pt;font-style:italic;color:#555">` +
        `premiação de meta ${money(premNaLojaRec)} paga pela loja na semana — não entra neste recibo` +
        (detNaLoja ? `<br>${detNaLoja}` : '') +
        `</td></tr>`;
    }
    if (num(entry.premiacaoBalanco) > 0) {
      const semSumGer = semDetGer.reduce((s, x) => s + num(x.valor), 0);
      const useDetGer = semDetGer.length && Math.abs(semSumGer - num(entry.premiacaoBalanco)) < 0.02;
      if (useDetGer) {
        semDetGer.forEach(s => prov += tr(`PREM. GER. SEM. ${s.label}`, s.valor));
      } else {
        prov += tr('PREM. GERENTE', entry.premiacaoBalanco);
      }
    }
  }
  if (num(entry.feriado) > 0)
    prov += tr('FERIADO', entry.feriado);
  (entry.extras || []).forEach(ex => {
    if (num(ex.valor) !== 0)
      prov += tr((ex.nome || 'OUTROS').toUpperCase(), ex.valor, ex.valor);
  });
  if (foraMemo.length)
    prov += `<tr><td colspan="4" style="padding:2px 5px 0;font-size:8pt;font-style:italic;color:#555">` +
      foraMemo.map(f => `${f.nome || 'complemento'}: ${money(f.valor)} pago à parte (já incluso acima)`).join('  ·  ') +
      `</td></tr>`;

  // ── Descontos ──
  let desc = '';
  desc += tr('VALE COMPRAS',  entry.valeCompras  || 0);
  desc += tr('ADIANTAMENTO',  entry.adiantamento || 0);
  (entry.extrasDesc || []).forEach(ex => {
    if (num(ex.valor) !== 0)
      desc += tr((ex.nome || 'DESCONTO').toUpperCase(), ex.valor);
  });
  if (num(entry.faltasValor) !== 0)
    desc += tr(entry.faltas ? `FALTAS (${entry.faltas})` : 'FALTAS', entry.faltasValor);
  desc += tr('INSS',           entry.inss  || 0, '', ecfg.inssRate ? fmt(ecfg.inssRate) + '%' : '');
  desc += tr('IR FP',          entry.irpf  || 0);
  desc += tr('VALE TRANSPORTE',entry.vt    || 0, '', ecfg.vtRate   ? fmt(ecfg.vtRate)   + '%' : '');
  if (num(entry.arredondamento) !== 0)
    desc += tr('arred.', entry.arredondamento);

  const totRow = (lbl, val, bg) =>
    `<tfoot><tr style="background:${bg};border-top:1px solid #000">` +
    `<td colspan="3" style="padding:3px 5px;font-weight:700">${lbl}</td>` +
    `<td style="padding:3px 5px;text-align:right;font-weight:700;white-space:nowrap">R$&nbsp;${fmt(num(val))}</td>` +
    `</tr></tfoot>`;

  return `
<div class="recibo">
<table style="${tbl}border-bottom:none">
  <tr>
    <td style="width:105px;padding:6px 8px;border-right:1px solid #000;vertical-align:middle">
      <img src="${origin}/${rc.logoFile}" alt="${rc.logoAlt}" style="height:36px;width:auto;display:block">
    </td>
    <td style="padding:5px 8px;border-right:1px solid #000;vertical-align:middle;text-align:center">
      <div style="display:inline-block;border:1px solid #000;padding:3px 12px;font-weight:700;font-size:11pt;letter-spacing:.4px">${emp.name.toUpperCase()}</div>
      <div style="margin-top:3px;font-size:9pt"><u>Mês</u>&nbsp;${mes}&nbsp;&nbsp;&nbsp;<u>${emp.cargo.toUpperCase()}</u></div>
    </td>
    <td style="width:105px;padding:5px 8px;text-align:center;vertical-align:middle">
      <div style="font-weight:700;font-size:10pt">${loja}</div>
      <div style="font-size:8pt;margin-top:2px;color:#444">${adm}</div>
    </td>
  </tr>
  <tr><td colspan="3" style="text-align:center;padding:5px;border-top:1px solid #000;font-style:italic;font-size:9pt">"${rc.tagline}"</td></tr>
  ${entry.ferias?.ativo && entry.ferias.ini && entry.ferias.fim ? `
  <tr><td colspan="3" style="text-align:center;padding:4px;border-top:1px solid #000;font-size:9pt;font-weight:700">
    FÉRIAS DE ${fmtDiaMes(entry.ferias.ini)} A ${fmtDiaMes(entry.ferias.fim)} — valores proporcionais aos dias trabalhados
  </td></tr>` : ''}
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>${gap}${prov}${gap}</tbody>
  ${totRow('PROVENTOS', num(entry.proventos) + totalFora, '#d3d3d3')}
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>${gap}${desc}${gap}</tbody>
  ${totRow('TOTAL DESCONTOS', entry.totalDescontos, '#d3d3d3')}
</table>

<table style="${tbl}border-top:none;border-bottom:none;margin-top:-1px">
  ${cols}
  <tbody>
    ${totalFora > 0 ? `
    <tr style="background:#e8e8e8">
      <td colspan="3" style="padding:4px 5px;font-weight:700">LÍQUIDO CONTABILIDADE</td>
      <td style="padding:4px 5px;text-align:right;font-weight:700;white-space:nowrap">R$&nbsp;${fmt(num(entry.liquido))}</td>
    </tr>
    <tr style="background:#bdbdbd;border-top:1px solid #000">
      <td colspan="3" style="padding:5px 5px;font-weight:700;font-size:11pt">LÍQUIDO TOTAL</td>
      <td style="padding:5px;text-align:right;font-weight:700;font-size:11pt;white-space:nowrap">R$&nbsp;${fmt(num(entry.liquido) + totalFora)}</td>
    </tr>` : `
    <tr style="background:#bdbdbd">
      <td colspan="3" style="padding:5px 5px;font-weight:700;font-size:11pt">LÍQUIDO</td>
      <td style="padding:5px;text-align:right;font-weight:700;font-size:11pt;white-space:nowrap">R$&nbsp;${fmt(num(entry.liquido))}</td>
    </tr>`}
  </tbody>
</table>

<table style="${tbl}border-top:none;margin-top:-1px">
  <tr>
    <td style="width:90px;padding:8px;border-right:1px solid #000;vertical-align:bottom;text-align:center">
      <img src="${origin}/${rc.logoFile}" alt="" style="height:42px;width:auto;display:block;margin:0 auto">
    </td>
    <td style="padding:8px 14px;vertical-align:top">
      <p style="font-size:8pt;line-height:1.45;margin-bottom:14px">Recebi a importância líquida constante no presente recibo individual de pagamento, dando, por este, plena e geral quitação, para nada mais reclamar com relação a salários vencidos e outros proventos do trabalho, inclusive por serviço extraordinário, até a presente data.</p>
      <div style="text-align:center">
        <div style="border-bottom:1px solid #000;width:55%;margin:0 auto"></div>
        <div style="font-style:italic;font-size:9pt;margin-top:3px">Assinatura do colaborador</div>
        <div style="font-size:9pt">___/___/${FP.year}</div>
      </div>
    </td>
  </tr>
</table>
</div>`;
}

// ── Utils ──────────────────────────────────────────────────────────────────
function r2(v) { return Math.round((parseFloat(v)||0)*100)/100; }
function brl(v) { return 'R$ '+r2(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }

async function apiFetch(url, method='GET', body) {
  const opts = { method, headers:{} };
  if (body!==undefined) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) { if (res.status===401){location.href='/';return;} throw new Error(await res.text()||res.statusText); }
  return res.json();
}

let _toast;
function toast(msg, err, ms = 3000) {
  const el = document.getElementById('fpToast');
  el.textContent = msg; el.style.display = 'block';
  el.style.borderColor = err === 'warn' ? '#d29922' : err ? '#f85149' : '#3fb950';
  clearTimeout(_toast); _toast = setTimeout(()=>el.style.display='none', ms);
}
