'use strict';
// DRE/Resultados: tela só do dono, que substitui aos poucos as planilhas NOVA
// ANALISE VIABILIDADE e FECHAMENTO RESULTADO. Esta primeira parte traz as linhas
// sem regra pendente: receita, CMV e taxa (Conferência), caixinha (sangria do
// caixa), juros e empréstimos (faturas pelo vencimento, pagas ou em aberto).
//
// Regras combinadas com o Leonardo em 04/11/2026:
//  - a Receita é o líquido da Conferência, não a venda por vendedor nem o Fluxo;
//  - parcela de empréstimo não é despesa: fica abaixo do Resultado Líquido;
//  - o que depende de digitação fica em destaque antes de finalizar o mês.

const multer = require('multer');
const { lerRelatorio } = require('./dreImportar');
const { montarCaixa, linhaCaixa, nomesFuncionarios, LINHAS: LINHAS_CAIXA, norm: normCaixa } = require('./dreCaixa');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { lerBoleto } = require('./dreBoletos');
const { gerarExcel } = require('./dreExportar');
const extratoSimples = require('./dreExtrato');
const agenda = require('./agenda');
const { montarBalancete, EMPRESAS: EMPRESAS_BAL, LINHAS: LINHAS_BAL } = require('./dreBalancete');
const C = require('./dreCadastros');
const L = require('./dreLinhas');

const LOJAS = ['delrey', 'minas', 'contagem', 'estacao', 'tommy', 'lez', 'site'];

// A Lez não tem Microvix; o Site troca de gateway e tem a taxa digitada.
const SEM_CONFERENCIA = new Set(['lez']);
const TAXA_MANUAL = new Set(['site', 'lez']);
const SEM_CAIXINHA = new Set(['site']);

// DRE de outubro/2026 nas planilhas, para conferir o módulo linha a linha.
const PLANILHA = {
  '2026-10': {
    delrey:   { receita: 142521, cmv: 62709.24, taxa: 4218.62, caixinha: 2677, juros: 5056.09,  emprestimos: 6395.52 },
    minas:    { receita: 77364,  cmv: 40306.64, taxa: 2220.35, caixinha: 1230, juros: 12671.42, emprestimos: 4373.72 },
    contagem: { receita: 85173,  cmv: 38072.33, taxa: 1805.67, caixinha: 2547, juros: 2094.11,  emprestimos: 3549.33 },
    tommy:    { receita: 80190,  cmv: 33519.42, taxa: 2309.47, caixinha: 1458, juros: 3275.90,  emprestimos: 0 },
    lez:      { receita: 68930,  cmv: 23532.70, taxa: 2916,    caixinha: 2490, juros: 4033.86,  emprestimos: 0 },
    site:     { receita: 8695,   cmv: 3982.31,  taxa: 695.60,  caixinha: null, juros: 0,        emprestimos: 0 },
  },
};

const r2 = v => Math.round(v * 100) / 100;
const normForn = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Mesma classificação da skill preencher-fechamento-caixa-2026.
function linhaFinanceira(fornecedor) {
  const n = normForn(fornecedor);
  if (/\bJUROS\b|\bIOF\b/.test(n)) return 'juros';
  if (/EMPRESTIMO|EMPRÉSTIMO|PRONAMPE|FINANCIAMENTO/.test(n)) return 'emprestimos';
  return null;
}

const ehMesFechado = (mes, hoje) => mes < hoje.slice(0, 7);

function somarSangria(caixaMes) {
  return r2(Object.values(caixaMes || {}).reduce((s, d) => s + (Number(d?.sangria) || 0), 0));
}

// conferencia: porLoja do Dashboard · caixa: db.caixa · faturas: { b, f, vp, va }
function montar({ mes, conferencia = [], caixa = {}, faturas = [], manual = {}, escolhidos = {} }) {
  const linhaDe = nome => {
    const e = escolhidos[normForn(nome)];
    return e ? { juros: 'juros', emprestimo: 'emprestimos' }[e] || null : linhaFinanceira(nome);
  };
  const conf = Object.fromEntries(conferencia.map(l => [l.board, l]));
  const fin = {};
  const detalhe = { juros: {}, emprestimos: {}, caixinha: {} };
  const somarDetalhe = (linha, nome, b, v) => {
    if (!v) return;
    const alvo = (detalhe[linha][nome] ||= {});
    alvo[b] = r2((alvo[b] || 0) + v);
  };
  for (const g of faturas) {
    const linha = linhaDe(g.f);
    if (!linha) continue;
    const alvo = (fin[g.b] ||= { juros: 0, emprestimos: 0 });
    const v = (g.vp || 0) + Math.max(0, g.va || 0);
    alvo[linha] += v;
    somarDetalhe(linha, normForn(g.f) + (g.va > 0 ? ' (em aberto)' : ''), g.b, v);
  }
  for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {})) {
    const linha = linhaDe(nome);
    if (linha) somarDetalhe(linha, nome, 'lez', (f.pago || 0) + (f.aberto || 0));
  }
  for (const b of LOJAS) {
    for (const [dia, d] of Object.entries(caixa[`${mes}-${b}`] || {}))
      somarDetalhe('caixinha', `Dia ${String(dia).padStart(2, '0')}`, b, Number(d?.sangria) || 0);
  }

  const lojas = {};
  const manuais = [];
  const item = (loja, id, rotulo, tipo, valor) =>
    manuais.push({ loja, id, rotulo, tipo, valor: valor ?? null, feito: valor != null });
  for (const b of LOJAS) {
    const m = manual[b] || {};
    const c = conf[b];
    const temConf = c && !SEM_CONFERENCIA.has(b);
    const receita = temConf ? r2(c.vlrLiquido || 0) : m.vendas?.receita ?? null;
    const cmv = temConf ? r2(c.vlrCusto || 0) : m.vendas?.cmv ?? null;
    const taxa = TAXA_MANUAL.has(b) ? m.taxa ?? null : temConf ? r2(c.vlrTaxa || 0) : null;
    const caixinha = SEM_CAIXINHA.has(b) ? 0 : somarSangria(caixa[`${mes}-${b}`]);
    // A Lez não tem faturas no Microvix: juros e dívida vêm do relatório dela
    const semFaturas = SEM_CONFERENCIA.has(b);
    const juros = semFaturas ? (m.faturas ? m.faturas.totais.juros || 0 : null) : r2(fin[b]?.juros || 0);
    const emprestimos = semFaturas ? (m.faturas ? m.faturas.totais.emprestimos || 0 : null) : r2(fin[b]?.emprestimos || 0);
    lojas[b] = { receita, cmv, taxa, caixinha, juros, emprestimos };

    if (semFaturas) {
      item(b, 'vendas', 'Relatório de vendas e CMV (VResumoVendas)', 'arquivo', m.vendas?.em);
      item(b, 'faturas', 'Relatório de faturas (FinPagarAnalitico)', 'arquivo', m.faturas?.em);
      for (const [nome, valor] of Object.entries(m.faturas?.aClassificar || {}))
        manuais.push({ loja: b, id: 'classificar', rotulo: `Fornecedor sem linha: ${nome} (${valor})`, tipo: 'aviso', feito: false });
    }
    if (TAXA_MANUAL.has(b)) item(b, 'taxa', 'Taxa de cartão (total do mês)', 'numero', m.taxa);
    if (b === 'lez') item(b, 'subsidio', 'Subsídio recebido no mês (0 se não teve)', 'numero', m.subsidio);
  }
  const pendencias = manuais.filter(i => !i.feito);
  const lista = l => Object.entries(detalhe[l]).map(([nome, valores]) => ({ nome, lojas: valores }))
    .sort((a, c) => a.nome.localeCompare(c.nome, 'pt-BR'));
  return { mes, lojas, manuais, pendencias, planilha: PLANILHA[mes] || null,
    detalhe: { juros: lista('juros'), emprestimos: lista('emprestimos'), caixinha: lista('caixinha') } };
}

// Conferência de uma loja antes de finalizar. bloqueia: sem isso o resultado não fecha.
const brl = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const LOJAS_DA_EMPRESA = { LMJ: ['delrey', 'site'], JDG: ['minas'], PV: ['contagem'], TTS: ['estacao'], '3L': ['tommy'], LF: ['lez'] };

// Receita do mês do extrato no gestão, somando as lojas da empresa
function receitaNoGestao(empresa, pa, faturamentoExtra = {}) {
  const h = HISTORICO[pa];
  if (h) return LOJAS_DA_EMPRESA[empresa].reduce((s, b) => s + (h.lojas[b]?.receita || 0), 0);
  return faturamentoExtra[pa]?.[empresa] ?? null;
}

function conferirLoja({ loja, dados, manual, folhaFechada, extratos = {}, faturamentoExtra = {} }) {
  const l = dados.lojas[loja];
  const itens = [];
  const add = (id, rotulo, ok, bloqueia = false) => itens.push({ id, rotulo, ok, bloqueia });
  add('linhas', l.faltam.length ? `Linhas sem dado: ${l.faltam.join(', ')}` : 'Todas as linhas têm dado', !l.faltam.length, true);
  if (loja !== 'site') add('folha', folhaFechada ? 'Folha do mês encerrada' : 'Folha do mês ainda aberta', folhaFechada);
  const semLinha = dados.caixa.linhas.find(x => x.id === 'classificar')?.lojas[loja] || 0;
  add('fornecedores', semLinha ? `Fornecedores sem linha: ${semLinha}` : 'Fornecedores classificados', !semLinha);
  const empresa = L.EMPRESA[loja], ex = extratos[empresa];
  if (!ex) add('simples', `Extrato do Simples de ${empresa} não enviado`, false);
  else {
    const [ano, mes] = ex.pa.split('-');
    add('simples', `Extrato ${mes}/${ano} de ${empresa}: DAS ${brl(ex.das)}, RBT12 usado ${brl(ex.rbtMes)}`, true);
    const gestao = receitaNoGestao(empresa, ex.pa, faturamentoExtra);
    if (gestao != null) add('extrato-receita', Math.abs(gestao - ex.rpa) <= 1 ? `Receita de ${mes}/${ano} bate com o extrato`
      : `Receita de ${mes}/${ano}: extrato ${brl(ex.rpa)}, gestão ${brl(gestao)}`, Math.abs(gestao - ex.rpa) <= 1);
  }
  const editados = Object.keys(l.ajustado || {}).length;
  if (editados) add('editados', `${editados} valor(es) editado(s) à mão`, true);
  return itens;
}

const HISTORICO = require('./dreHistorico.json');
const INICIO_MODULO = '2026-10';
const CAMPOS_MANUAIS = { lez: ['taxa', 'subsidio'], site: ['taxa', 'publicidade'] };

// A DRE inteira de um mês. base: resultado de montar(); ctx: dados já lidos.
function montarCompleta(base, { mes, manual, faturas, apuracoes, embalagem, folhaMes, employees, freteTommy, faturamentoExtra, config, googleAds = null, extratos = {} }) {
  const cfg = C.comPadrao(config);
  const pct = cfg.percentuais;
  const lanc = faturas.map(g => ({ b: g.b, f: g.f, v: (g.vp || 0) + Math.max(0, g.va || 0) }));
  for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {}))
    lanc.push({ b: 'lez', f: nome, v: (f.pago || 0) + (f.aberto || 0) });
  const nomes = Object.fromEntries(employees.map(e => [String(e.id), e.name || '']));
  // Mesma regra da folha das lojas: verba de rescisão já está na taxa de encargos
  const pessoas = Object.entries(folhaMes?.site?.entries || {}).map(([id, e]) => ({ nome: nomes[id] || '', valor: r2((e.proventos || 0) - L.extrasFora(e)) }));
  const esc = C.calcularEscritorio({ itens: cfg.escritorio, pessoas, lancamentos: lanc });
  // O que foi para o rateio do escritório sai das linhas da loja que pagou
  const { totais, detalhe } = L.somarFaturas(lanc.filter(l => !esc.usados.has(l)), C.escolhidosDe(config), nomesFuncionarios(employees));
  const folha = L.folhaPorLoja(folhaMes, employees);
  const embPct = L.percentuaisEmbalagem(embalagem.pago, embalagem.venda, { lez: pct.embalagemLez / 100 });
  const icmsCadastrado = { site: pct.icmsSite / 100, lez: pct.icmsLez / 100 };
  const lojas = {}, percentuais = {};
  for (const b of LOJAS) {
    const d = base.lojas[b], t = totais[b] || {}, f = folha?.[b];
    const aliq = L.aliquotaSimples(b, mes, faturamentoExtra, extratos[L.EMPRESA[b]]), icms = L.percentualIcms(b, mes, apuracoes, icmsCadastrado), emb = embPct[b];
    const temFaturas = b !== 'lez' || !!manual.lez?.faturas;
    const fat = k => (temFaturas ? t[k] || 0 : null);
    const semFolha = b === 'site' ? 0 : null;
    const fixos = f ? f.fixos : semFolha, comissoes = f ? f.comissoes : semFolha;
    const calculado = {
      receita: d.receita, cmv: d.cmv, taxa: d.taxa, caixinha: d.caixinha, juros: d.juros, emprestimos: d.emprestimos,
      simples: d.receita != null && aliq != null ? r2(d.receita * aliq) : null,
      icms: d.cmv != null && icms != null ? r2(d.cmv * icms) : null,
      embalagens: d.receita != null && emb != null ? r2(d.receita * emb) : null,
      frete: b === 'tommy' ? freteTommy ?? null : 0,
      // Digitado positivo (valor recebido); na DRE entra negativo, abatendo o custo
      subsidio: b === 'lez' && manual.lez?.subsidio ? -manual.lez.subsidio : 0,
      fixos, comissoes,
      encargos: fixos != null ? r2((fixos + comissoes) * pct.encargos / 100) : null,
      premiacoes: f ? f.premiacoes : semFolha,
      escritorio: esc.porLoja[b] || 0,
      vt: temFaturas ? r2((t.vt || 0) + (f?.ajuda || 0)) : null,
      ...(b === 'site' ? { ponto: 0, aluguel: 0, aluguelPct: 0, condominio: 0, fpp: 0, ar: 0, iptu: 0, energia: 0 } : L.pontoComercial(manual[b]?.boletos, d.receita, pct.aluguelPct)),
      sistema: fat('sistema'), contabilidade: fat('contabilidade'), seguro: fat('seguro'), plano: fat('plano'),
      diversos: fat('diversos'), telefone: fat('telefone'), tarifa: fat('tarifa'), acordos: fat('acordos'),
      publicidade: b === 'site' ? googleAds ?? manual.site?.publicidade ?? null : fat('publicidade'),
    };
    // Valor digitado na tela vence o calculado; o original fica para mostrar
    const ajustes = Object.fromEntries(Object.entries(manual[b]?.ajustes || {}).filter(([, v]) => v != null));
    const final = { ...calculado, ...ajustes };
    if (final.aluguel != null) final.ponto = r2(['aluguel', 'aluguelPct', 'condominio', 'fpp', 'ar', 'iptu', 'energia'].reduce((s, k) => s + (final[k] || 0), 0));
    lojas[b] = { ...L.fechar(final), ajustado: Object.fromEntries(Object.keys(ajustes).map(k => [k, calculado[k] ?? null])) };
    percentuais[b] = { simples: aliq, icms, embalagens: emb };
  }
  const manuais = base.manuais.slice();
  if (googleAds == null) manuais.push({ loja: 'site', id: 'publicidade', rotulo: 'Google Ads: o NEXO não tem o gasto deste mês', tipo: 'numero', valor: manual.site?.publicidade ?? null, feito: manual.site?.publicidade != null });
  for (const b of LOJAS) {
    if (b === 'site') continue;
    const bs = Object.entries(manual[b]?.boletos || {}).map(([chave, x]) => ({ chave, ...x }));
    const total = r2(bs.reduce((s, x) => s + x.total, 0));
    manuais.push({ loja: b, id: 'boleto', rotulo: bs.length ? `Boleto do shopping: total ${total}` : 'Boleto do shopping (PDF)', tipo: 'arquivo', feito: bs.length > 0,
      arquivos: bs.map(x => ({ chave: x.chave, nome: x.arquivo || null, total: x.total })) });
  }
  for (const [empresa, [loja]] of Object.entries(LOJAS_DA_EMPRESA)) {
    const ex = extratos[empresa];
    const [a, m] = L.mesesAntes(mes, 1)[0].split('-');
    manuais.push({ loja, id: 'extrato', rotulo: `Extrato do Simples de ${m}/${a} (${empresa})`, tipo: 'arquivo', feito: !!ex,
      arquivos: ex ? [{ url: `/api/dre-resultados/extrato/${mes}/${empresa}`, nome: ex.arquivo }] : [] });
  }
  const lista = o => Object.entries(o || {}).map(([nome, valores]) => ({ nome, lojas: valores })).sort((a, c) => a.nome.localeCompare(c.nome, 'pt-BR'));
  const det = { ...base.detalhe, escritorio: esc.detalhe };
  for (const k of ['sistema', 'contabilidade', 'seguro', 'plano', 'diversos', 'telefone', 'publicidade', 'tarifa', 'vt', 'acordos']) det[k] = lista(detalhe[k]);
  const ref = L.REF.planilha[mes];
  return { ...base, lojas, percentuais, proLabore: pct.proLabore, detalhe: det, manuais, pendencias: manuais.filter(i => !i.feito), estrutura: L.ESTRUTURA,
    planilha: ref ? Object.fromEntries(Object.entries(ref).map(([b, p]) => [b, { ...p, ...L.somarGrupos(p), sobra: p.liquido, liquido: undefined }])) : null,
    folhaFechada: Object.fromEntries(LOJAS.map(b => [b, !!folhaMes?.[b]?.encerrada])) };
}

function register(app, { getDb, readDB, readContasPagar, requireAuth, souDono, computeConferenciaDashboard, hojeBRT, boardsLabel, folhaDoMesComFaltas, dataDir, getNexoDb }) {
  // Boleto como foi enviado: no Mongo; sem Mongo (rodando local), em disco. Só a rota
  // do dono entrega, por isso nada vai para /uploads, que é público.
  const pastaBoletos = path.join(dataDir, 'dre-boletos');
  const caminhoBoleto = (mes, loja, chave) => path.join(pastaBoletos, mes, `${loja}-${chave}.pdf`);
  const idBoleto = (mes, loja, chave) => `${mes}-${loja}-${chave}`;
  async function guardarBoleto(mes, loja, chave, buffer) {
    const db = getDb();
    if (db) return db.collection('dreBoletosArquivos').replaceOne({ _id: idBoleto(mes, loja, chave) }, { mes, loja, dados: buffer }, { upsert: true });
    fs.mkdirSync(path.join(pastaBoletos, mes), { recursive: true });
    fs.writeFileSync(caminhoBoleto(mes, loja, chave), buffer);
  }
  async function lerBoletoGuardado(mes, loja, chave) {
    const db = getDb();
    if (db) {
      const doc = await db.collection('dreBoletosArquivos').findOne({ _id: idBoleto(mes, loja, chave) });
      return doc ? Buffer.from(doc.dados.buffer || doc.dados) : null;
    }
    const arq = caminhoBoleto(mes, loja, chave);
    return fs.existsSync(arq) ? fs.readFileSync(arq) : null;
  }
  async function apagarBoleto(mes, loja, chave) {
    const db = getDb();
    if (db) return db.collection('dreBoletosArquivos').deleteOne({ _id: idBoleto(mes, loja, chave) });
    fs.rmSync(caminhoBoleto(mes, loja, chave), { force: true });
  }
  const paramsOk = p => /^\d{4}-\d{2}$/.test(p.mes) && LOJAS.includes(p.loja) && /^\d+$/.test(p.chave);

  async function lerConfig() {
    const db = getDb();
    return db ? db.collection('dreConfig').findOne({ _id: 'main' }) : memoriaConfig;
  }
  let memoriaConfig = null;

  // Mesma folha que a tela de Folha mostra, para os valores baterem com ela
  const folhaDoMes = (db, mes) => {
    const [y, m] = mes.split('-').map(Number);
    return folhaDoMesComFaltas(db, y, m);
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const memoria = {}; // sem Mongo, a foto do mês fica só enquanto o servidor roda

  const soDono = (req, res, next) => {
    if (!souDono(req)) return res.status(403).json({ error: 'Só o dono vê a DRE/Resultados' });
    next();
  };

  // A Conferência faz cerca de 20 consultas ao Microvix por período. Mês fechado
  // vira uma foto de 7 linhas; o botão Recalcular refaz.
  async function conferenciaDoMes(mes, recalcular, hoje) {
    const db = getDb();
    if (!recalcular) {
      const foto = db ? await db.collection('dreFoto').findOne({ _id: mes }) : memoria[mes];
      if (foto && foto.freteTommy !== undefined) return { lojas: foto.lojas, em: foto.em, freteTommy: foto.freteTommy };
    }
    const [y, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const fim = ehMesFechado(mes, hoje) ? `${mes}-${String(ultimo).padStart(2, '0')}` : hoje;
    const [{ porLoja }, freteTommy] = await Promise.all([computeConferenciaDashboard(`${mes}-01`, fim), freteDaTommy(mes, fim)]);
    const lojas = porLoja.filter(l => l?.board).map(l => ({
      board: l.board, vlrLiquido: l.vlrLiquido, vlrCusto: l.vlrCusto, vlrTaxa: l.vlrTaxa,
    }));
    const em = new Date().toISOString();
    if (ehMesFechado(mes, hoje)) {
      if (db) await db.collection('dreFoto').replaceOne({ _id: mes }, { lojas, em, freteTommy }, { upsert: true });
      else memoria[mes] = { lojas, em, freteTommy };
    }
    return { lojas, em, freteTommy };
  }

  // Frete das notas de compra da Tommy no mês (campo frete do LinxMovimento)
  async function freteDaTommy(mes, fim) {
    const { fetchMovimento, parseBrNum } = require('./microvix');
    const cnpj = JSON.parse(process.env.MICROVIX_LOJAS || '{}').tommy;
    if (!cnpj) return null;
    const rows = await fetchMovimento(cnpj, `${mes}-01`, fim, process.env.MICROVIX_CHAVE_TOMMY || process.env.MICROVIX_CHAVE);
    return r2(rows.reduce((s, r) => ((r.operacao || '').trim().toUpperCase() === 'E' && r.cancelado !== 'S' && /Compra/i.test(r.desc_cfop || '')
      ? s + parseBrNum(r.frete || '0') : s), 0));
  }

  async function dadosDoHistorico(mes) {
    const db = getDb();
    const janela = L.mesesAntes(mes, 12);
    const faturamentoExtra = {};
    const out = { apuracoes: [], pago: {}, faturamentoExtra };
    if (!db) return out;
    const [fotos, manuais, apuracoes, emb] = await Promise.all([
      db.collection('dreFoto').find({ _id: { $in: janela } }).toArray(),
      db.collection('dreManual').find({ _id: { $in: janela } }).toArray(),
      db.collection('icmsApuracoes').find({}, { projection: { competencia: 1, empresa: 1, difal: 1, base4: 1, base12: 1 } }).toArray(),
      db.collection('cpFaturas').aggregate([
        { $match: { isPagar: true, previsao: { $ne: 'S' }, fornecedor: /EMBALAGEN/i, vencimento: { $gte: `${janela[11]}-01`, $lte: `${janela[0]}-31` } } },
        { $group: { _id: '$board', v: { $sum: { $ifNull: ['$valorPago', 0] } } } },
      ]).toArray(),
    ]);
    for (const f of fotos) {
      const alvo = (faturamentoExtra[f._id] ||= {});
      for (const l of f.lojas) if (L.EMPRESA[l.board]) alvo[L.EMPRESA[l.board]] = (alvo[L.EMPRESA[l.board]] || 0) + (l.vlrLiquido || 0);
    }
    for (const m of manuais) if (m.lojas?.lez?.vendas) (faturamentoExtra[m._id] ||= {}).LF = m.lojas.lez.vendas.receita;
    out.apuracoes = apuracoes;
    for (const e of emb) out.pago[e._id] = e.v;
    return out;
  }

  // Venda de 12 meses por empresa. A venda por vendedor só existe de maio/2026 em
  // diante; o arquivo do Simples tem o histórico. O Site já está dentro da LMJ.
  function vendaDe12Meses(mes, faturamentoExtra) {
    const venda = {};
    for (const b of ['delrey', 'minas', 'contagem', 'estacao', 'tommy']) {
      const emp = L.EMPRESA[b];
      venda[b] = L.mesesAntes(mes, 12).reduce((s, mk) => s + (L.REF.faturamento[mk]?.[emp] ?? faturamentoExtra[mk]?.[emp] ?? 0), 0);
    }
    return venda;
  }

  async function lerManual(mes) {
    const db = getDb();
    const doc = db ? await db.collection('dreManual').findOne({ _id: mes }) : memoria['manual-' + mes];
    return doc?.lojas || {};
  }
  async function gravarManual(mes, loja, campos) {
    const db = getDb();
    const set = Object.fromEntries(Object.entries(campos).map(([k, v]) => [`lojas.${loja}.${k}`, v]));
    if (db) return db.collection('dreManual').updateOne({ _id: mes }, { $set: set }, { upsert: true });
    const doc = (memoria['manual-' + mes] ||= { lojas: {} });
    for (const [k, v] of Object.entries(campos)) {
      const partes = k.split('.'), fim = partes.pop();
      let alvo = (doc.lojas[loja] ||= {});
      for (const p of partes) alvo = (alvo[p] ||= {});
      alvo[fim] = v;
    }
  }

  async function lerExtratos(mes) {
    const db = getDb();
    const doc = db ? await db.collection('dreManual').findOne({ _id: mes }) : memoria['extratos-' + mes];
    const out = {};
    for (const [emp, ex] of Object.entries(doc?.extratos || {}))
      out[emp] = { ...ex, rbtMes: r2(L.mesesAntes(mes, 12).reduce((s, mk) => s + (ex.faturamento?.[mk] || 0), 0)) };
    return out;
  }
  async function gravarExtrato(ex, nome, buffer) {
    const db = getDb();
    const dados = { pa: ex.pa, rpa: ex.rpa, rbt12: ex.rbt12, das: ex.das, faturamento: ex.faturamento, arquivo: nome };
    if (db) {
      await db.collection('dreManual').updateOne({ _id: ex.mes }, { $set: { [`extratos.${ex.empresa}`]: dados } }, { upsert: true });
      await db.collection('dreBoletosArquivos').replaceOne({ _id: `${ex.mes}-extrato-${ex.empresa}` }, { mes: ex.mes, empresa: ex.empresa, dados: buffer }, { upsert: true });
    } else ((memoria['extratos-' + ex.mes] ||= { extratos: {} }).extratos[ex.empresa] = dados);
  }

  async function faturasDoMes(mes) {
    const db = getDb();
    const de = `${mes}-01`, ate = `${mes}-31`;
    if (db) {
      return db.collection('cpFaturas').aggregate([
        { $match: { isPagar: true, previsao: { $ne: 'S' }, vencimento: { $gte: de, $lte: ate } } },
        { $group: { _id: { b: '$board', f: '$fornecedor' },
          vp: { $sum: { $cond: [{ $and: [{ $gt: ['$baixa', ''] }, { $gt: ['$valorPago', 0] }] }, '$valorPago', 0] } },
          va: { $sum: { $cond: [{ $gt: ['$baixa', ''] }, 0, { $subtract: [{ $ifNull: ['$valorLiquido', '$valor'] }, { $ifNull: ['$valorPago', 0] }] }] } } } },
        { $project: { _id: 0, b: '$_id.b', f: '$_id.f', vp: 1, va: 1 } },
      ]).toArray();
    }
    return (await readContasPagar(de, ate)).rows
      .filter(f => f.isPagar && f.previsao !== 'S')
      .map(f => ({ b: f.board, f: f.fornecedor, vp: f.baixa ? (f.valorPago || 0) : 0, va: f.baixa ? 0 : (f.valorLiquido ?? f.valor) - (f.valorPago || 0) }));
  }

  async function lerFechamentos(mes) {
    const db = getDb();
    const out = {};
    if (db) for (const f of await db.collection('dreFechamentos').find({ mes }).toArray()) out[f.loja] = f;
    else for (const f of Object.values(memoria.fechamentos || {})) if (f.mes === mes) out[f.loja] = f;
    return out;
  }
  const lojaFechada = async (mes, loja) => !!(await lerFechamentos(mes))[loja];

  // Coloca na resposta os números congelados das lojas finalizadas
  function aplicarFechamentos(dados, fechamentos) {
    for (const [b, f] of Object.entries(fechamentos)) {
      dados.lojas[b] = f.dre;
      for (const l of dados.caixa.linhas) { l.lojas[b] = f.caixa.linhas[l.id] || 0; delete l.ajustado[b]; }
      for (const [id, v] of Object.entries(f.caixa.linhas)) {
        if (dados.caixa.linhas.some(l => l.id === id)) continue;
        dados.caixa.linhas.push({ id, nome: f.caixa.nomes[id] || id, lojas: { [b]: v }, detalhe: [], ajustado: {} });
      }
      dados.caixa.soma[b] = f.caixa.soma;
      dados.caixa.recebimentos[b] = f.caixa.recebimentos;
      dados.caixa.resultado[b] = f.caixa.resultado;
    }
    dados.fechamentos = Object.fromEntries(Object.entries(fechamentos).map(([b, f]) => [b, { em: f.em }]));
    return dados;
  }

  // Gasto do Google Ads: o NEXO só guarda os últimos 34 dias, então o valor do mês
  // fechado fica salvo aqui, sempre o maior já visto.
  async function googleAdsDoMes(mes, manual, hoje) {
    const guardado = manual.site?.ads ?? null;
    let valor = 0;
    try {
      const doc = await getNexoDb()?.collection('anuncios').findOne({ _id: 'google' });
      valor = r2((doc?.dias || []).reduce((s, d) => s + (String(d.dia).startsWith(mes) ? Number(d.custo) || 0 : 0), 0));
    } catch (e) { console.warn('[dreResultados] Google Ads:', e.message); }
    if (valor > (guardado || 0) && ehMesFechado(mes, hoje)) await gravarManual(mes, 'site', { ads: valor });
    const melhor = Math.max(valor, guardado || 0);
    return melhor || null;
  }

  async function dadosDoMes(mes, recalcular) {
      const hoje = hojeBRT();
      const [foto, faturas, db, manual, hist, config, extratos] = await Promise.all([
        conferenciaDoMes(mes, recalcular, hoje),
        faturasDoMes(mes),
        readDB(),
        lerManual(mes),
        dadosDoHistorico(mes),
        lerConfig(),
        lerExtratos(mes),
      ]);
      const escolhidos = C.escolhidosDe(config);
      const googleAds = await googleAdsDoMes(mes, manual, hoje);
      const parcial = montar({ mes, conferencia: foto.lojas, caixa: db.caixa || {}, faturas, manual, escolhidos });
      const dre = montarCompleta(parcial, { mes, manual, faturas, apuracoes: hist.apuracoes,
        embalagem: { pago: hist.pago, venda: vendaDe12Meses(mes, hist.faturamentoExtra) }, folhaMes: folhaDoMes(db, mes),
        employees: db.employees || [], freteTommy: foto.freteTommy, faturamentoExtra: hist.faturamentoExtra, config, googleAds, extratos });
      const pagos = faturas.map(g => ({ b: g.b, f: g.f, v: g.vp || 0 }));
      for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {}))
        pagos.push({ b: 'lez', f: nome, v: f.pago || 0 });
      const coluna = k => Object.fromEntries(LOJAS.map(b => [b, dre.lojas[b][k] || 0]));
      const ajustesCaixa = Object.fromEntries(LOJAS.map(b => [b, Object.fromEntries(Object.entries(manual[b]?.ajustesCaixa || {}).filter(([, v]) => v != null))]));
      const dados = {
        ...dre,
        caixa: montarCaixa({ lojas: LOJAS, pagos, escolhidos, funcionarios: nomesFuncionarios(db.employees), ajustes: ajustesCaixa, recebimentos: coluna('receita'),
          extras: { taxa: coluna('taxa'), caixinha: coluna('caixinha') } }),
        conferenciaEm: foto.em,
        labels: Object.fromEntries(LOJAS.map(b => [b, boardsLabel[b] || b])),
        ordem: LOJAS,
      };
      dados.conferencia = Object.fromEntries(LOJAS.map(b => [b, conferirLoja({ loja: b, dados, manual, folhaFechada: !!dre.folhaFechada[b], extratos, faturamentoExtra: hist.faturamentoExtra })]));
      return dados;
  }

  app.get('/api/dre-resultados', requireAuth, soDono, async (req, res) => {
    try {
      const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hojeBRT().slice(0, 7);
      res.json(aplicarFechamentos(await dadosDoMes(mes, req.query.recalcular === '1'), await lerFechamentos(mes)));
    } catch (e) { console.error('[dreResultados]', e); res.status(500).json({ error: e.message }); }
  });

  // POST { mes, loja, forcar } — congela os números da loja no mês
  app.post('/api/dre-resultados/finalizar', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, loja, forcar } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(mes || '') || !LOJAS.includes(loja)) return res.status(400).json({ error: 'Mês ou loja inválidos' });
      if (await lojaFechada(mes, loja)) return res.status(400).json({ error: 'Esta loja já está finalizada' });
      const dados = await dadosDoMes(mes, false);
      const itens = dados.conferencia[loja];
      const bloqueio = itens.find(i => i.bloqueia && !i.ok);
      if (bloqueio) return res.status(400).json({ error: bloqueio.rotulo });
      if (itens.some(i => !i.ok) && !forcar) return res.status(409).json({ pendentes: itens.filter(i => !i.ok).map(i => i.rotulo) });
      const linhas = {}, nomes = {};
      for (const l of dados.caixa.linhas) if (l.lojas[loja]) { linhas[l.id] = l.lojas[loja]; nomes[l.id] = l.nome; }
      const doc = { mes, loja, em: new Date().toISOString(), dre: dados.lojas[loja], conferencia: itens,
        caixa: { linhas, nomes, soma: dados.caixa.soma[loja], recebimentos: dados.caixa.recebimentos[loja], resultado: dados.caixa.resultado[loja] } };
      const db = getDb();
      if (db) await db.collection('dreFechamentos').replaceOne({ _id: `${mes}-${loja}` }, doc, { upsert: true });
      else (memoria.fechamentos ||= {})[`${mes}-${loja}`] = doc;
      res.json({ ok: true });
    } catch (e) { console.error('[dreResultados finalizar]', e); res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/dre-resultados/finalizar/:mes/:loja', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, loja } = req.params;
      if (!/^\d{4}-\d{2}$/.test(mes) || !LOJAS.includes(loja)) return res.status(400).json({ error: 'Mês ou loja inválidos' });
      const db = getDb();
      if (db) await db.collection('dreFechamentos').deleteOne({ _id: `${mes}-${loja}` });
      else delete memoria.fechamentos?.[`${mes}-${loja}`];
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/dre-resultados/importar — relatório da Lez; o mês vem do próprio arquivo
  app.post('/api/dre-resultados/importar', requireAuth, soDono, upload.single('arquivo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Envie o arquivo' });
      if (/\.pdf$/i.test(req.file.originalname)) {
        const { text } = await require('pdf-parse')(req.file.buffer);
        if (/Extrato do Simples Nacional/i.test(text)) {
          const ex = extratoSimples.lerTexto(text);
          const fechadas = await lerFechamentos(ex.mes);
          if (LOJAS_DA_EMPRESA[ex.empresa].some(b => fechadas[b])) return res.status(400).json({ error: 'Loja finalizada neste mês: reabra para enviar o extrato' });
          await gravarExtrato(ex, req.file.originalname, req.file.buffer);
          return res.json({ tipo: 'extrato', mes: ex.mes, empresa: ex.empresa, das: ex.das });
        }
        const bol = await lerBoleto(req.file.buffer);
        if (await lojaFechada(bol.mes, bol.loja)) return res.status(400).json({ error: 'Esta loja está finalizada neste mês: reabra para enviar' });
        await guardarBoleto(bol.mes, bol.loja, bol.chave, req.file.buffer);
        await gravarManual(bol.mes, bol.loja, { [`boletos.${bol.chave}`]: { total: bol.total, valores: bol.valores, arquivo: req.file.originalname } });
        return res.json(bol);
      }
      const rel = lerRelatorio(req.file.buffer);
      if (await lojaFechada(rel.mes, 'lez')) return res.status(400).json({ error: 'A Lez está finalizada neste mês: reabra para enviar' });
      const em = new Date().toISOString();
      if (rel.tipo === 'vendas') await gravarManual(rel.mes, 'lez', { vendas: { receita: rel.receita, cmv: rel.cmv, em } });
      else await gravarManual(rel.mes, 'lez', { faturas: { totais: rel.totais, aClassificar: rel.aClassificar, fornecedores: rel.fornecedores, aVencer: rel.aVencer, em } });
      res.json(rel);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Boleto como foi enviado
  app.get('/api/dre-resultados/boleto/:mes/:loja/:chave', requireAuth, soDono, async (req, res) => {
    if (!paramsOk(req.params)) return res.status(400).json({ error: 'Boleto inválido' });
    const { mes, loja, chave } = req.params;
    const dados = await lerBoletoGuardado(mes, loja, chave);
    if (!dados) return res.status(404).json({ error: 'Arquivo não guardado: envie este boleto de novo' });
    const nome = (await lerManual(mes))[loja]?.boletos?.[chave]?.arquivo || 'boleto.pdf';
    res.attachment(nome).type('application/pdf').send(dados);
  });

  app.get('/api/dre-resultados/extrato/:mes/:empresa', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, empresa } = req.params;
      const db = getDb();
      const doc = db && /^\d{4}-\d{2}$/.test(mes) && LOJAS_DA_EMPRESA[empresa] ? await db.collection('dreBoletosArquivos').findOne({ _id: `${mes}-extrato-${empresa}` }) : null;
      if (!doc) return res.status(404).json({ error: 'Extrato não guardado' });
      const nome = (await lerExtratos(mes))[empresa]?.arquivo || 'extrato.pdf';
      res.attachment(nome).type('application/pdf').send(Buffer.from(doc.dados.buffer || doc.dados));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Todos os boletos do mês, ou do ano (?mes=2026), num zip por pasta de mês
  app.get('/api/dre-resultados/boletos.zip', requireAuth, soDono, async (req, res) => {
    try {
      const alvo = String(req.query.mes || '');
      if (!/^\d{4}(-\d{2})?$/.test(alvo)) return res.status(400).json({ error: 'Período inválido' });
      const meses = alvo.length === 7 ? [alvo] : Array.from({ length: 12 }, (_, i) => `${alvo}-${String(i + 1).padStart(2, '0')}`);
      const zip = new JSZip();
      let total = 0;
      for (const mes of meses) {
        const manual = await lerManual(mes);
        for (const [loja, m] of Object.entries(manual)) {
          for (const [chave, b] of Object.entries(m.boletos || {})) {
            const dados = await lerBoletoGuardado(mes, loja, chave);
            if (!dados) continue;
            zip.file(`${mes}/${boardsLabel[loja] || loja} - ${b.arquivo || chave + '.pdf'}`, dados);
            total++;
          }
        }
        const db = getDb();
        for (const [emp, ex] of Object.entries(await lerExtratos(mes))) {
          const doc = db && await db.collection('dreBoletosArquivos').findOne({ _id: `${mes}-extrato-${emp}` });
          if (!doc) continue;
          zip.file(`${mes}/Extrato Simples ${emp} - ${ex.arquivo || 'extrato.pdf'}`, Buffer.from(doc.dados.buffer || doc.dados));
          total++;
        }
      }
      if (!total) return res.status(404).json({ error: 'Nenhum boleto guardado neste período' });
      res.attachment(`boletos-${alvo}.zip`).type('application/zip').send(await zip.generateAsync({ type: 'nodebuffer' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/dre-resultados/exportar { nome, abas: [{ nome, linhas }] } — a tela
  // manda as tabelas como estão, e o Excel sai igual ao que se vê.
  app.post('/api/dre-resultados/exportar', requireAuth, soDono, async (req, res) => {
    try {
      const abas = req.body?.abas || [];
      if (!abas.length) return res.status(400).json({ error: 'Nada para exportar' });
      res.attachment(`${String(req.body.nome || 'dre-resultados').replace(/[^\w-]/g, '_')}.xlsx`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(await gerarExcel(abas));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/dre-resultados/boleto/:mes/:loja/:chave', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, loja, chave } = req.params;
      if (!paramsOk(req.params)) return res.status(400).json({ error: 'Boleto inválido' });
      if (await lojaFechada(mes, loja)) return res.status(400).json({ error: 'Esta loja está finalizada neste mês: reabra para alterar' });
      const db = getDb();
      if (db) await db.collection('dreManual').updateOne({ _id: mes }, { $unset: { [`lojas.${loja}.boletos.${chave}`]: '' } });
      else delete memoria['manual-' + mes]?.lojas?.[loja]?.boletos?.[chave];
      await apagarBoleto(mes, loja, chave);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/dre-resultados/cadastros', requireAuth, soDono, async (req, res) => {
    try { res.json({ ...C.comPadrao(await lerConfig()), lojas: C.SEIS, labels: boardsLabel }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/dre-resultados/cadastros', requireAuth, soDono, async (req, res) => {
    try {
      const erro = C.validar(req.body);
      if (erro) return res.status(400).json({ error: erro });
      const doc = { escritorio: req.body.escritorio, percentuais: req.body.percentuais, fornecedores: (await lerConfig())?.fornecedores || [] };
      const db = getDb();
      if (db) await db.collection('dreConfig').replaceOne({ _id: 'main' }, doc, { upsert: true });
      else memoriaConfig = doc;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lembrete do painel: do dia 2 em diante, enquanto o mês anterior tiver loja aberta
  app.get('/api/dre-resultados/pendencia', requireAuth, soDono, async (req, res) => {
    try {
      const hoje = hojeBRT();
      const mes = L.mesesAntes(hoje.slice(0, 7), 1)[0];
      if (+hoje.slice(8, 10) < 2 || mes < INICIO_MODULO) return res.json({ mes, abertas: [] });
      const fechadas = await lerFechamentos(mes);
      res.json({ mes, abertas: LOJAS.filter(b => !fechadas[b]).map(b => boardsLabel[b] || b) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Balancete: foto do último dia do mês
  app.get('/api/dre-resultados/balancete', requireAuth, soDono, async (req, res) => {
    try {
      const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hojeBRT().slice(0, 7);
      const [y, m] = mes.split('-').map(Number);
      const fim = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      const mongo = getDb();
      const [db, manual, config] = await Promise.all([readDB(), lerManual(mes), lerConfig()]);
      const lancs = mongo ? await mongo.collection('agendaLanc').find({ data: { $lte: fim } }, { projection: { _id: 0 } }).toArray() : [];
      const faturas = mongo ? await mongo.collection('cpFaturas').aggregate([
        { $match: { isPagar: true, previsao: { $ne: 'S' }, emissao: { $lte: fim }, vencimento: { $gt: fim }, $or: [{ baixa: { $in: ['', null] } }, { baixa: { $gt: fim } }] } },
        { $group: { _id: { b: '$board', f: '$fornecedor' }, v: { $sum: { $ifNull: ['$valorLiquido', '$valor'] } } } },
      ]).toArray() : [];
      const escolhidos = C.escolhidosDe(config);
      const fornecedores = {};
      for (const g of faturas) if (linhaCaixa(g._id.f, escolhidos) === 'fornecedor') fornecedores[g._id.b] = (fornecedores[g._id.b] || 0) + g.v;
      const estoque = {}, digitado = {};
      for (const { board } of EMPRESAS_BAL) {
        const custo = db.pautas?.[`${mes}-${board}`]?.estoqueManual?.custo;
        if (custo) estoque[board] = custo;
        if (manual[board]?.balancete) digitado[board] = manual[board].balancete;
      }
      // Lez: títulos a vencer da Lunelli, somando os relatórios já enviados
      if (mongo) {
        const docs = await mongo.collection('dreManual').find({ _id: { $lte: mes }, 'lojas.lez.faturas.aVencer': { $exists: true } }).toArray();
        const parcelas = docs.flatMap(d => d.lojas.lez.faturas.aVencer || []).filter(p => p.vencimento > fim);
        if (parcelas.length) fornecedores.lez = parcelas.reduce((s, p) => s + p.valor, 0);
      }
      const empresas = montarBalancete({ saldos: agenda.saldos(lancs, fim), estoque, fornecedores, digitado });
      res.json({ mes, fim, empresas, ordem: EMPRESAS_BAL, linhas: LINHAS_BAL, labels: Object.fromEntries(EMPRESAS_BAL.map(e => [e.id, boardsLabel[e.board] || e.board])) });
    } catch (e) { console.error('[dreResultados balancete]', e); res.status(500).json({ error: e.message }); }
  });

  // Antes de outubro/2026 o módulo não calcula: mostra o que as planilhas têm
  app.get('/api/dre-resultados/historico', requireAuth, soDono, (req, res) => {
    const ano = String(req.query.ano || '');
    const meses = {};
    for (const [mk, h] of Object.entries(HISTORICO)) {
      if (!mk.startsWith(ano + '-')) continue;
      const lojas = {}, recebimentos = {}, soma = {}, resultado = {};
      for (const b of LOJAS) {
        const l = h.lojas[b] || {};
        lojas[b] = { receita: l.receita ?? null, operacional: l.operacional ?? null, dividas: l.dividas ?? null,
          sobra: l.operacional != null ? r2(l.operacional - (l.dividas || 0)) : null };
        recebimentos[b] = l.receita || 0;
        soma[b] = r2(Object.values(h.caixa[b] || {}).reduce((s, v) => s + v, 0));
        resultado[b] = r2(recebimentos[b] - soma[b]);
      }
      const linhas = LINHAS_CAIXA.map(([id, nome]) => ({ id, nome, detalhe: [],
        lojas: Object.fromEntries(LOJAS.map(b => [b, h.caixa[b]?.[id] || 0])) })).filter(l => Object.values(l.lojas).some(Boolean));
      meses[mk] = { lojas, caixa: { linhas, soma, recebimentos, resultado }, historico: true, proLabore: h.proLabore,
        estrutura: L.ESTRUTURA, ordem: LOJAS, labels: Object.fromEntries(LOJAS.map(b => [b, boardsLabel[b] || b])) };
    }
    res.json({ meses, inicio: INICIO_MODULO });
  });

  // Mapa de fornecedores: todos os que têm fatura no ano, mais os da Lez importados
  app.get('/api/dre-resultados/fornecedores', requireAuth, soDono, async (req, res) => {
    try {
      const ano = /^\d{4}$/.test(req.query.ano || '') ? req.query.ano : hojeBRT().slice(0, 4);
      const db = getDb();
      const total = {};
      const somar = (nome, v) => { const n = normCaixa(nome); if (n) total[n] = r2((total[n] || 0) + (v || 0)); };
      if (db) {
        const grupos = await db.collection('cpFaturas').aggregate([
          { $match: { isPagar: true, previsao: { $ne: 'S' }, vencimento: { $gte: `${ano}-01-01`, $lte: `${ano}-12-31` } } },
          { $group: { _id: '$fornecedor', v: { $sum: { $ifNull: ['$valorLiquido', '$valor'] } } } },
        ]).toArray();
        for (const g of grupos) somar(g._id, g.v);
        for (const d of await db.collection('dreManual').find({ _id: { $regex: `^${ano}-` } }).toArray())
          for (const [nome, f] of Object.entries(d.lojas?.lez?.faturas?.fornecedores || {})) somar(nome, (f.pago || 0) + (f.aberto || 0));
      }
      const escolhidos = C.escolhidosDe(await lerConfig());
      const funcionarios = nomesFuncionarios((await readDB()).employees);
      const lista = Object.entries(total).map(([nome, valor]) => ({ nome, valor, linha: linhaCaixa(nome, escolhidos, funcionarios), escolhido: !!escolhidos[nome] }))
        .sort((a, c) => (a.linha === 'classificar' ? 0 : 1) - (c.linha === 'classificar' ? 0 : 1) || a.nome.localeCompare(c.nome, 'pt-BR'));
      res.json({ lista, linhas: LINHAS_CAIXA.filter(([id]) => !['taxa', 'caixinha'].includes(id)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT { nome, linha } — linha vazia volta para o mapa padrão
  app.put('/api/dre-resultados/fornecedores', requireAuth, soDono, async (req, res) => {
    try {
      const nome = normCaixa(req.body?.nome), linha = req.body?.linha || null;
      if (!nome || (linha && !LINHAS_CAIXA.some(([id]) => id === linha))) return res.status(400).json({ error: 'Fornecedor ou linha inválidos' });
      const atual = C.comPadrao(await lerConfig());
      const doc = { ...atual, fornecedores: [...atual.fornecedores.filter(f => f.nome !== nome), ...(linha ? [{ nome, linha }] : [])] };
      const db = getDb();
      if (db) await db.collection('dreConfig').replaceOne({ _id: 'main' }, doc, { upsert: true });
      else memoriaConfig = doc;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/dre-resultados/manual { mes, loja, campo, valor } — valor vazio limpa
  app.put('/api/dre-resultados/manual', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, loja, campo } = req.body || {};
      const valor = req.body?.valor === '' || req.body?.valor == null ? null : Number(req.body.valor);
      const [grupo, linha] = String(campo || '').split('.');
      if (grupo === 'balancete') {
        if (!/^\d{4}-\d{2}$/.test(mes || '') || !EMPRESAS_BAL.some(e => e.board === loja) || !['caixa', 'estoque', 'fornecedores', 'dividas'].includes(linha) || Number.isNaN(valor))
          return res.status(400).json({ error: 'Campo ou valor inválido' });
        await gravarManual(mes, loja, { [campo]: valor });
        return res.json({ ok: true });
      }
      const ajusteOk = LOJAS.includes(loja) && ((grupo === 'ajustes' && L.ESTRUTURA.some(([id, , tipo]) => id === linha && tipo === 'item'))
        || (grupo === 'ajustesCaixa' && LINHAS_CAIXA.some(([id]) => id === linha)) || campo === 'conferidos.simples');
      if (!/^\d{4}-\d{2}$/.test(mes || '') || !(CAMPOS_MANUAIS[loja]?.includes(campo) || ajusteOk) || Number.isNaN(valor))
        return res.status(400).json({ error: 'Campo ou valor inválido' });
      if (await lojaFechada(mes, loja)) return res.status(400).json({ error: 'Esta loja está finalizada neste mês: reabra para alterar' });
      await gravarManual(mes, loja, { [campo]: valor });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { receitaNoGestao, register, montar, montarCompleta, conferirLoja, linhaFinanceira, somarSangria, LOJAS, PLANILHA };
