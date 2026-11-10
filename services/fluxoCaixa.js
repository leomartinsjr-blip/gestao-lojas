'use strict';
// Fluxo de caixa previsto por loja: entradas = venda projetada (mesma regra do
// Dash de Performance) recebida em D+1 já sem a taxa de cartão; saídas = faturas
// a pagar em aberto do LinxFaturas (cpFaturas). Datas em dia útil (sáb/dom/feriado → próximo dia útil).

const { PERF_HIST, PERF_2026 } = require('../public/perf-hist.js');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDias = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const hojeBRT = () => ymd(new Date(Date.now() - 3 * 3600e3));

// Feriados bancários: nacionais, os móveis (Carnaval seg/ter, Sexta-feira Santa,
// Corpus Christi) e os de Belo Horizonte (15/08 e 08/12). Neles o banco e a Rede
// não liquidam: conta e recebimento passam para o próximo dia útil.
const FIXOS = ['01-01', '04-21', '05-01', '08-15', '09-07', '10-12', '11-02', '11-15', '11-20', '12-08', '12-25'];
function pascoa(y) { // algoritmo de Meeus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(mes)}-${pad(dia)}`;
}
const _feriados = {};
function feriadosDoAno(y) {
  if (!_feriados[y]) {
    const p = pascoa(y);
    _feriados[y] = new Set([...FIXOS.map(md => `${y}-${md}`), addDias(p, -48), addDias(p, -47), addDias(p, -2), addDias(p, 60)]);
  }
  return _feriados[y];
}
const ehFeriado = s => feriadosDoAno(+s.slice(0, 4)).has(s);
const ehDiaUtil = s => ![0, 6].includes(new Date(s + 'T12:00:00Z').getUTCDay()) && !ehFeriado(s);

// Sábado, domingo e feriado caem no próximo dia útil.
function diaUtil(s) {
  while (!ehDiaUtil(s)) s = addDias(s, 1);
  return s;
}

// Faturas antes disso sem baixa no Microvix são tratadas como pagas (lixo de 2020–2025).
const DIAS_ATRASO_CONSIDERADO = 90;

// Empresa (CNPJ) de cada loja — os blocos da planilha de fluxo do usuário. Ver services/empresas.js.
const EMPRESA = { delrey: 'LMJ', minas: 'JDG', contagem: 'PV', estacao: 'TTS', tommy: '3L', site: 'SITE' };

// Categorias resumidas das despesas, pelo nome do fornecedor (o LinxFaturas não tem
// plano de contas). Mapa da planilha FECHAMENTO CAIXA; a ordem importa (1º que casar).
// O que não casar vai para "A classificar" e o usuário escolhe na tela (fluxoCategorias).
const CATEGORIAS = [
  ['Empréstimos e juros', ['EMPRESTIMO', 'EMPRÉSTIMO', 'PRONAMPE', 'FINANCIAMENTO', 'JUROS', 'IOF']],
  ['Impostos', ['SIMPLES NACIONAL', 'ICMS', 'DIFAL', 'DARF', 'DAS ', 'IMPOSTO', 'RECEITA FEDERAL', 'SEFAZ']],
  ['Folha e encargos', ['FOLHA', 'ADIANTAMENTO', 'TRCT', 'RESCIS', 'FERIAS', 'FÉRIAS', 'INSS', 'FGTS', 'UNIMED', 'VALE TRANSPORTE', 'TRANSFACIL', 'PRO LABORE', 'PRÓ LABORE', 'PROLABORE']],
  ['Aluguel e shopping', ['ALUGUEL', 'CONDOMINIO', 'CONDOMÍNIO', 'IPTU', 'FUNDO DE PROMO', 'SHOPPING']],
  ['Sistemas e serviços', ['MICROVIX', 'GIVER', 'VIVO', 'TELEFONE', 'INTERNET', 'CONTABILIDADE', 'CEMIG', 'ENERGIA', 'COPASA']],
  ['Mercadoria', ['AREZZO', 'LUXOTTICA', 'COOPERSHOES', 'OUTSIDE', 'DASS', 'TESS', 'NEW BRASIL', 'VULCANOR', 'NEW ERA', 'MOZART', 'LOTUS', 'CASIO', 'PVH', 'TOMMY', 'HURLEY', 'OAKLEY', 'BILLABONG', 'QUIKSILVER', 'VANS', 'RIP CURL', 'OSKLEN']],
  ['Diversos', ['CARTAO DE CREDITO', 'CARTÃO DE CREDITO', 'CARTÃO DE CRÉDITO', 'MDIAS', 'ESTACIONAMENTO', 'EXTINFRAN', 'TARIFA', 'EMBALAGEN']],
];
const SEM_CATEGORIA = 'A classificar';
const NOMES_CATEGORIAS = [...CATEGORIAS.map(c => c[0]), SEM_CATEGORIA];
const normForn = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
function categoria(fornecedor, manual = {}) {
  const n = normForn(fornecedor);
  if (manual[n]) return manual[n];
  for (const [cat, chaves] of CATEGORIAS) if (chaves.some(k => n.includes(k))) return cat;
  return SEM_CATEGORIA;
}

// Lançamento manual { board, data, tipo: entrada|saida|transf, valor, desc, para } vira
// movimentos com sinal. Transferência sai de board e entra em para; a linha de cada lado
// leva o nome da outra empresa, como na planilha ("3L" na LMJ, "LMJ" na 3L).
function movimentosManuais(lancamentos) {
  const out = [];
  for (const l of lancamentos || []) {
    const v = Math.abs(Number(l.valor) || 0);
    if (!v || !l.board || !l.data) continue;
    const base = { d: l.data, id: l.id, desc: l.desc || '' };
    if (l.tipo === 'transf' && l.para) {
      out.push({ ...base, b: l.board, v: -v, rot: EMPRESA[l.para] || l.para.toUpperCase(), transf: true });
      out.push({ ...base, b: l.para, v, rot: EMPRESA[l.board] || l.board.toUpperCase(), transf: true });
    } else {
      out.push({ ...base, b: l.board, v: l.tipo === 'saida' ? -v : v, rot: (l.desc || (l.tipo === 'saida' ? 'Saída' : 'Entrada')).toUpperCase() });
    }
  }
  return out;
}

// ── Projeção de venda (mesma regra de calcPerfMetrics/computeCurMonthProj) ──
function criarProjecao(db, board, hoje) {
  const emps = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false);
  const vendaDia = {}; // 'YYYY-MM-DD' → valor, só meses do vsales
  const cacheMes = {};
  function lerMes(y, m) {
    const mk = `${y}-${pad(m)}`;
    if (cacheMes[mk] != null) return cacheMes[mk];
    let tot = 0;
    for (const e of emps) {
      const ent = db.vsales?.[`${mk}-${board}-${e.id}`]?.entries;
      if (!ent) continue;
      for (const [d, v] of Object.entries(ent)) {
        const val = v?.value || 0;
        tot += val;
        vendaDia[d] = (vendaDia[d] || 0) + val;
      }
    }
    return (cacheMes[mk] = tot);
  }
  // Realizado do mês: tabela à mão (jan–abr/2026), senão o lançamento diário.
  function realizado(y, m) {
    const fixo = y === 2026 ? PERF_2026[board]?.[m - 1] : null;
    return fixo != null ? fixo : lerMes(y, m);
  }
  function base(y, m) {
    const h = PERF_HIST[board]?.[y]?.[m - 1];
    if (h != null) return h;
    return y >= 2026 ? (realizado(y, m) || null) : null;
  }
  const yoy = (y, m) => {
    const r = realizado(y, m), b = base(y - 1, m);
    return r > 0 && b > 0 ? r / b - 1 : null;
  };
  const mesAnt = (y, m, k) => { const t = y * 12 + (m - 1) - k; return [Math.floor(t / 12), t % 12 + 1]; };

  const [hy, hm, hd] = hoje.split('-').map(Number);
  const ontem = addDias(hoje, -1);
  const pesos = mk => (db.globalWeights || {})[mk] || {};
  lerMes(hy, hm);

  // Peso corrido até ontem e realizado até ontem no mês atual.
  const dim = diasNoMes(hy, hm);
  const pCur = pesos(`${hy}-${pad(hm)}`);
  let wAccum = 0, realAteOntem = 0;
  for (let d = 1; d <= dim; d++) {
    const ds = `${hy}-${pad(hm)}-${pad(d)}`;
    if (ds > ontem) break;
    wAccum += pCur[ds] ?? 100 / dim;
    realAteOntem += vendaDia[ds] || 0;
  }

  // Até o dia 15: média do crescimento dos 3 meses fechados.
  // Depois: 2 meses fechados + ritmo do mês atual.
  let ritmo = null;
  if (hd > 15 && wAccum > 0 && realAteOntem > 0) ritmo = Math.round(realAteOntem * 100 / wAccum);
  const cres = [];
  for (const k of ritmo != null ? [2, 1] : [3, 2, 1]) cres.push(yoy(...mesAnt(hy, hm, k)));
  if (ritmo != null) { const b = base(hy - 1, hm); cres.push(b > 0 ? ritmo / b - 1 : null); }
  const validos = cres.filter(v => v != null);
  const avgD = validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : 0;

  function projMes(y, m) {
    if (y === hy && m === hm && ritmo != null) return ritmo;
    const b = base(y - 1, m);
    return b > 0 ? Math.round(b * (1 + avgD)) : 0;
  }

  // Venda prevista por dia a partir de hoje. No mês atual distribui o que falta
  // (projeção − realizado até ontem) pelos pesos dos dias que restam.
  function vendaPrevistaPorDia(ate) {
    const out = {};
    let [y, m] = [hy, hm];
    while (`${y}-${pad(m)}-01` <= ate) {
      const mk = `${y}-${pad(m)}`;
      const n = diasNoMes(y, m), p = pesos(mk);
      const dias = [];
      for (let d = 1; d <= n; d++) {
        const ds = `${mk}-${pad(d)}`;
        if (ds >= hoje) dias.push([ds, p[ds] ?? 100 / n]);
      }
      const total = y === hy && m === hm ? Math.max(0, projMes(y, m) - realAteOntem) : projMes(y, m);
      const somaW = dias.reduce((s, [, w]) => s + w, 0);
      for (const [ds, w] of dias) if (ds <= ate && somaW > 0) out[ds] = total * w / somaW;
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
    return out;
  }

  return {
    avgD, ritmo, realAteOntem, vendaOntem: vendaDia[ontem] || 0, metodo: ritmo != null ? 'ritmo' : '3meses',
    projMes, realizado, base, vendaPrevistaPorDia,
    vendaDoDia: d => { lerMes(+d.slice(0, 4), +d.slice(5, 7)); return vendaDia[d] || 0; },
    crescimentos: cres,
  };
}

// ── Cálculo do fluxo ──────────────────────────────────────────────────────
// taxas: { board: fração descontada da venda (ex.: 0.025) }
// saldos: { board: { valor, data } }
// emAberto: Set de chaveEmAberto — contas que o usuário deixou em aberto: aparecem na
// lista, mas não saem do saldo.
const chaveEmAberto = f => `${f.board}|${f.codigo_fatura}`;
function calcular({ db, faturas, taxas, saldos, boards, lancamentos = [], hoje = hojeBRT(), dias = 90, emAberto = new Set() }) {
  const ate = addDias(hoje, dias - 1);
  const corteAtraso = addDias(hoje, -DIAS_ATRASO_CONSIDERADO);
  const porDia = {}; // data → board → { vendas, recebe, paga, atraso }
  const slot = (d, b) => ((porDia[d] ||= {})[b] ||= { vendas: 0, recebe: 0, paga: 0, atraso: 0 });
  const projecao = {};
  const contas = [];

  for (const b of boards) {
    const pj = criarProjecao(db, b, hoje);
    const liq = 1 - (taxas[b] ?? 0.025);
    // Venda já feita que ainda não caiu no saldo. Com a data do saldo (último lançamento
    // da agenda): toda venda desde esse dia cujo D+1 é depois dele — o que já devia ter
    // caído e não está lançado entra hoje. Sem data: só a venda de ontem, que cai hoje.
    const sd = saldos?.[b]?.data;
    if (sd && sd < hoje) {
      for (let d = sd; d < hoje; d = addDias(d, 1)) {
        const v = pj.vendaDoDia(d), cai = diaUtil(addDias(d, 1));
        if (v > 0 && cai > sd) slot(cai < hoje ? diaUtil(hoje) : cai, b).recebe += v * liq;
      }
    } else if (!sd && pj.vendaOntem > 0) slot(diaUtil(hoje), b).recebe += pj.vendaOntem * liq;
    const prev = pj.vendaPrevistaPorDia(ate);
    for (const [d, v] of Object.entries(prev)) {
      slot(d, b).vendas += v;
      const cai = diaUtil(addDias(d, 1));
      if (cai <= ate) slot(cai, b).recebe += v * liq;
    }
    const [hy, hm] = hoje.split('-').map(Number);
    const meses = [];
    for (let k = 0, y = hy, m = hm; `${y}-${pad(m)}-01` <= ate; k++, [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1]) {
      meses.push({ mes: `${y}-${pad(m)}`, projecao: pj.projMes(y, m), base: pj.base(y - 1, m),
        realizado: y === hy && m === hm ? pj.realAteOntem : null });
    }
    projecao[b] = { metodo: pj.metodo, crescimento: pj.avgD, crescimentos: pj.crescimentos,
      taxa: 1 - liq, meses };
  }

  // Mesma regra do Mensal (mesAtualPelaAgenda): saldo com lançamento de hoje na agenda
  // já tem os pagamentos de hoje, então o que vence hoje e está sem baixa conta como vencida.
  const desde = b => (saldos?.[b]?.data >= hoje ? addDias(hoje, 1) : hoje);

  for (const f of faturas) {
    if (!boards.includes(f.board) || !f.isPagar || f.baixa || f.previsao === 'S') continue;
    // Valor líquido = fatura − desconto − abatimento + juros + multa (o que de fato vai sair).
    const resta = (f.valorLiquido ?? f.valor ?? 0) - (f.valorPago || 0);
    if (resta <= 0.009 || !f.vencimento || f.vencimento < corteAtraso || f.vencimento > ate) continue;
    const atrasada = f.vencimento < desde(f.board);
    const d = diaUtil(atrasada ? hoje : f.vencimento);
    if (d > ate) continue;
    const base = { d, venc: f.vencimento, b: f.board, forn: f.fornecedor, doc: f.documento,
      parc: f.parcela, v: Math.round(resta * 100) / 100, atraso: atrasada, codigo: f.codigo_fatura || null };
    if (emAberto.has(chaveEmAberto(f))) { contas.push({ ...base, emAberto: true }); continue; }
    const s = slot(d, f.board);
    s.paga += resta;
    if (atrasada) s.atraso += resta;
    contas.push(base);
  }

  for (const m of movimentosManuais(lancamentos)) {
    if (!boards.includes(m.b) || m.d < desde(m.b)) continue;
    const d = diaUtil(m.d);
    if (d > ate) continue;
    if (m.v > 0) slot(d, m.b).recebe += m.v; else slot(d, m.b).paga -= m.v;
    contas.push({ d, venc: m.d, b: m.b, forn: m.rot + (m.desc && m.desc.toUpperCase() !== m.rot ? ' · ' + m.desc : ''),
      doc: '', parc: '', v: Math.abs(m.v), manual: true, entrada: m.v > 0 });
  }

  const linhas = [];
  for (let d = hoje; d <= ate; d = addDias(d, 1)) {
    const pb = porDia[d] || {};
    const r = {};
    for (const b of boards) if (pb[b]) {
      const x = pb[b];
      r[b] = { vendas: Math.round(x.vendas), recebe: Math.round(x.recebe * 100) / 100,
        paga: Math.round(x.paga * 100) / 100, atraso: Math.round(x.atraso * 100) / 100 };
    }
    linhas.push({ d, b: r });
  }
  contas.sort((a, b) => a.d.localeCompare(b.d) || b.v - a.v);
  return { hoje, ate, boards, saldos, projecao, linhas, contas, diasAtraso: DIAS_ATRASO_CONSIDERADO };
}

// ── Resumo do dia (card do painel) ──────────────────────────────────────────
// Próximo dia útil (no fim de semana já é a segunda). Paga o que vence desde o
// dia seguinte ao último dia útil até ele (segunda = sáb + dom + seg; depois de feriado junta o feriado) e recebe a
// venda dos dias desde o último dia útil (segunda = sex + sáb + dom).
function janelaDoDia(hoje = hojeBRT()) {
  const alvo = diaUtil(hoje);
  let ant = addDias(alvo, -1);
  while (!ehDiaUtil(ant)) ant = addDias(ant, -1);
  const pagar = [], venda = [];
  for (let d = addDias(ant, 1); d <= alvo; d = addDias(d, 1)) pagar.push(d);
  for (let d = ant; d < alvo; d = addDias(d, 1)) venda.push(d);
  return { alvo, pagar, venda };
}

function vendaNosDias(db, board, dias) {
  const emps = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false);
  const out = {};
  for (const d of dias) {
    let v = 0;
    for (const e of emps) v += db.vsales?.[`${d.slice(0, 7)}-${board}-${e.id}`]?.entries?.[d]?.value || 0;
    out[d] = Math.round(v * 100) / 100;
  }
  return out;
}

function resumoDoDia({ db, faturas, taxas, boards, hoje = hojeBRT() }) {
  const j = janelaDoDia(hoje);
  const empresas = {};
  for (const b of boards) {
    const vendas = vendaNosDias(db, b, j.venda);
    const venda = Object.values(vendas).reduce((s, v) => s + v, 0);
    const taxa = taxas[b] ?? 0.025;
    empresas[b] = { empresa: EMPRESA[b] || b.toUpperCase(), vendas, venda, taxa, entra: Math.round(venda * (1 - taxa) * 100) / 100, paga: 0, contas: [] };
  }
  for (const f of faturas) {
    const e = empresas[f.board];
    if (!e || !f.isPagar || f.baixa || f.previsao === 'S' || !j.pagar.includes(f.vencimento)) continue;
    const resta = (f.valorLiquido ?? f.valor ?? 0) - (f.valorPago || 0);
    if (resta <= 0.009) continue;
    e.paga += resta;
    e.contas.push({ venc: f.vencimento, forn: f.fornecedor, doc: f.documento, parc: f.parcela, v: Math.round(resta * 100) / 100 });
  }
  for (const e of Object.values(empresas)) { e.paga = Math.round(e.paga * 100) / 100; e.contas.sort((a, b) => b.v - a.v); }
  return { hoje, ...j, boards, empresas };
}

// ── Quadro mensal por empresa (formato da planilha FLUXO CAIXA do usuário) ──
// Meses fechados = realizado; mês atual = o maior entre a projeção e o vendido até
// ontem; meses seguintes = projeção. Despesas = faturas a pagar pelo vencimento
// (com ou sem baixa: o Microvix não baixa boa parte do que já foi pago).
// faturasMes: [{ b, m: 'YYYY-MM', f: fornecedor, vp: pago, va: em aberto }]. Mês fechado conta só o
// pago (como o Fechamento de Caixa); vencido sem baixa ali não entra. Mês atual e seguintes: pago + aberto. · saldosAno: { board: valor em 01/jan }
// catManual: { FORNECEDOR: categoria } escolhida na tela
// Fim do mês atual a partir do saldo real da agenda. O que já aconteceu está no
// saldo, então só entra o que falta: a venda desde o último lançamento (a do dia
// anterior já caiu, em D+1) e as faturas abertas que ainda vão vencer. Vencida sem
// baixa fica fora: se foi paga já saiu do saldo, se não foi segue à parte como risco.
// Loja sem lançamento no mês não entra e o mês atual fica pela conta do Mensal.
function mesAtualPelaAgenda({ db, faturasAbertas = [], taxas, lancamentos = [], partida = {}, boards, hoje = hojeBRT(), emAberto = new Set() }) {
  const [hy, hm] = hoje.split('-').map(Number);
  const mk = `${hy}-${pad(hm)}`, fim = `${mk}-${pad(diasNoMes(hy, hm))}`;
  const corte = addDias(hoje, -DIAS_ATRASO_CONSIDERADO);
  const manuais = movimentosManuais(lancamentos);
  const r2 = v => Math.round(v * 100) / 100;
  const out = {};
  for (const b of boards) {
    const p = partida[b];
    if (!p?.ultimo?.startsWith(mk)) continue;
    // Lançamento de hoje na agenda: os pagamentos de hoje já estão no saldo.
    const desde = p.ultimo >= hoje ? addDias(hoje, 1) : hoje;
    const pj = criarProjecao(db, b, hoje);
    const prev = pj.vendaPrevistaPorDia(fim);
    let venda = 0, aPagar = 0, vencidas = 0;
    for (let d = p.ultimo; d <= fim; d = addDias(d, 1)) venda += d < hoje ? pj.vendaDoDia(d) : prev[d] || 0;
    for (const f of faturasAbertas) {
      if (f.board !== b || !f.isPagar || f.baixa || f.previsao === 'S' || !f.vencimento || emAberto.has(chaveEmAberto(f))) continue;
      const resta = (f.valorLiquido ?? f.valor ?? 0) - (f.valorPago || 0);
      if (resta <= 0.009 || f.vencimento > fim || f.vencimento < corte) continue;
      if (f.vencimento >= desde) aPagar += resta; else vencidas += resta;
    }
    const manual = manuais.filter(m => m.b === b && m.d >= desde && m.d <= fim).reduce((s, m) => s + m.v, 0);
    const taxa = venda * (taxas[b] ?? 0.025);
    out[b] = { saldo: p.valor, ultimo: p.ultimo, venda: r2(venda), taxa: r2(taxa), aPagar: r2(aPagar), manual: r2(manual),
      vencidas: r2(vencidas), fim: r2(p.valor + venda - taxa - aPagar + manual) };
  }
  return out;
}

function calcularMensal({ db, faturasMes, catManual = {}, lancamentos = [], taxas, saldosAno = {}, boards, hoje = hojeBRT(), ano, atual = {} }) {
  const [hy, hm] = hoje.split('-').map(Number);
  const mesAtual = `${hy}-${pad(hm)}`;
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${pad(i + 1)}`);
  const status = meses.map(mk => mk < mesAtual ? 'real' : mk === mesAtual ? 'parcial' : 'prev');
  const manuais = movimentosManuais(lancamentos).filter(m => m.d.startsWith(`${ano}-`));
  // board → categoria → { total[12], forn: { nome: [12] } }
  const porCat = {};
  for (const g of faturasMes) {
    const i = +g.m.slice(5, 7) - 1;
    if (!(i >= 0 && i < 12)) continue;
    g.v = (g.vp || 0) + (status[i] === 'real' ? 0 : Math.max(0, g.va || 0));
    if (Math.abs(g.v) < 0.005) continue;
    const nome = normForn(g.f) || '(sem nome)';
    const c = ((porCat[g.b] ||= {})[categoria(nome, catManual)] ||= { total: Array(12).fill(0), forn: {} });
    c.total[i] += g.v || 0;
    (c.forn[nome] ||= Array(12).fill(0))[i] += g.v || 0;
  }
  const r2 = a => a.map(v => Math.round(v * 100) / 100);
  const empresas = {};
  for (const b of boards) {
    const pj = criarProjecao(db, b, hoje);
    const taxa = taxas[b] ?? 0.025;
    const vendas = meses.map((mk, i) => {
      const m = i + 1;
      if (status[i] === 'real') return Math.round(pj.base(ano, m) || 0);
      if (status[i] === 'parcial') return Math.round(Math.max(pj.projMes(ano, m), pj.realAteOntem));
      return Math.round(pj.projMes(ano, m));
    });
    // transf = parte das entradas/saídas que é transferência entre empresas
    // (some no consolidado, onde os dois lados se anulam).
    const entradas = {}, saidas = {}, transf = { entra: Array(12).fill(0), sai: Array(12).fill(0) };
    for (const m of manuais) if (m.b === b) {
      const i = +m.d.slice(5, 7) - 1;
      (((m.v > 0 ? entradas : saidas)[m.rot]) ||= Array(12).fill(0))[i] += Math.abs(m.v);
      if (m.transf) transf[m.v > 0 ? 'entra' : 'sai'][i] += Math.abs(m.v);
    }
    empresas[b] = {
      empresa: EMPRESA[b] || b.toUpperCase(), taxa, saldoIni: saldosAno[b] ?? null,
      vendas, taxaV: vendas.map(v => Math.round(v * taxa * 100) / 100),
      despesas: r2(Object.values(porCat[b] || {}).reduce((t, c) => t.map((v, i) => v + c.total[i]), Array(12).fill(0))),
      categorias: Object.fromEntries(NOMES_CATEGORIAS.filter(c => porCat[b]?.[c]).map(c => [c, {
        total: r2(porCat[b][c].total),
        forn: Object.fromEntries(Object.entries(porCat[b][c].forn).map(([n, a]) => [n, r2(a)])),
      }])),
      entradas, saidas, transf, atual: atual[b] || null,
    };
  }
  return { ano, hoje, meses, status, boards, empresas, nomesCategorias: NOMES_CATEGORIAS };
}

module.exports = { chaveEmAberto, calcular, calcularMensal, mesAtualPelaAgenda, resumoDoDia, janelaDoDia, criarProjecao, diaUtil, ehDiaUtil, ehFeriado, hojeBRT, addDias, EMPRESA, NOMES_CATEGORIAS, normForn };
