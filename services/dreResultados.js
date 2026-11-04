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
const { montarCaixa } = require('./dreCaixa');
const { lerBoleto } = require('./dreBoletos');
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
function montar({ mes, conferencia = [], caixa = {}, faturas = [], manual = {} }) {
  const conf = Object.fromEntries(conferencia.map(l => [l.board, l]));
  const fin = {};
  const detalhe = { juros: {}, emprestimos: {}, caixinha: {} };
  const somarDetalhe = (linha, nome, b, v) => {
    if (!v) return;
    const alvo = (detalhe[linha][nome] ||= {});
    alvo[b] = r2((alvo[b] || 0) + v);
  };
  for (const g of faturas) {
    const linha = linhaFinanceira(g.f);
    if (!linha) continue;
    const alvo = (fin[g.b] ||= { juros: 0, emprestimos: 0 });
    const v = (g.vp || 0) + Math.max(0, g.va || 0);
    alvo[linha] += v;
    somarDetalhe(linha, normForn(g.f) + (g.va > 0 ? ' (em aberto)' : ''), g.b, v);
  }
  for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {})) {
    const linha = linhaFinanceira(nome);
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
    if (b === 'site') item(b, 'publicidade', 'Google Ads (relatório)', 'numero', m.publicidade);
  }
  const pendencias = manuais.filter(i => !i.feito);
  const lista = l => Object.entries(detalhe[l]).map(([nome, valores]) => ({ nome, lojas: valores }))
    .sort((a, c) => a.nome.localeCompare(c.nome, 'pt-BR'));
  return { mes, lojas, manuais, pendencias, planilha: PLANILHA[mes] || null,
    detalhe: { juros: lista('juros'), emprestimos: lista('emprestimos'), caixinha: lista('caixinha') } };
}

const CAMPOS_MANUAIS = { lez: ['taxa'], site: ['taxa', 'publicidade'] };

// A DRE inteira de um mês. base: resultado de montar(); ctx: dados já lidos.
function montarCompleta(base, { mes, manual, faturas, apuracoes, embalagem, folhaMes, employees, freteTommy, faturamentoExtra }) {
  const lanc = faturas.map(g => ({ b: g.b, f: g.f, v: (g.vp || 0) + Math.max(0, g.va || 0) }));
  for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {}))
    lanc.push({ b: 'lez', f: nome, v: (f.pago || 0) + (f.aberto || 0) });
  const { totais, detalhe } = L.somarFaturas(lanc);
  const folha = L.folhaPorLoja(folhaMes, employees);
  const site = folhaMes?.site?.entries || {};
  const nomes = Object.fromEntries(employees.map(e => [String(e.id), e.name || '']));
  const pessoal = Object.entries(site).reduce((s, [id, e]) =>
    (e.tipo === 'socio' && !/LEONARDO MARTINS|LEILA FERNANDES/i.test(nomes[id] || '') ? s + (e.proventos || 0) : s), 0);
  const magnum = Object.values(totais).reduce((s, t) => s + (t.magnum || 0), 0);
  const esc = L.escritorio({ pessoal, sala: totais.site?.sala || 0, magnum });
  const embPct = L.percentuaisEmbalagem(embalagem.pago, embalagem.venda);
  const lojas = {}, percentuais = {};
  for (const b of LOJAS) {
    const d = base.lojas[b], t = totais[b] || {}, f = folha?.[b];
    const aliq = L.aliquotaSimples(b, mes, faturamentoExtra), icms = L.percentualIcms(b, mes, apuracoes), emb = embPct[b];
    const temFaturas = b !== 'lez' || !!manual.lez?.faturas;
    const fat = k => (temFaturas ? t[k] || 0 : null);
    const semFolha = b === 'site' ? 0 : null;
    const fixos = f ? f.fixos : semFolha, comissoes = f ? f.comissoes : semFolha;
    lojas[b] = L.fechar({
      receita: d.receita, cmv: d.cmv, taxa: d.taxa, caixinha: d.caixinha, juros: d.juros, emprestimos: d.emprestimos,
      simples: d.receita != null && aliq != null ? r2(d.receita * aliq) : null,
      icms: d.cmv != null && icms != null ? r2(d.cmv * icms) : null,
      embalagens: d.receita != null && emb != null ? r2(d.receita * emb) : null,
      frete: b === 'tommy' ? freteTommy ?? null : 0,
      fixos, comissoes,
      encargos: fixos != null ? r2((fixos + comissoes) * L.TAXA_ENCARGOS) : null,
      premiacoes: f ? f.premiacoes : semFolha,
      escritorio: esc[b],
      vt: temFaturas ? r2((t.vt || 0) + (f?.ajuda || 0)) : null,
      ...(b === 'site' ? { ponto: 0, aluguel: 0, aluguelPct: 0, condominio: 0, fpp: 0, ar: 0, iptu: 0, energia: 0 } : L.pontoComercial(manual[b]?.boletos, d.receita)),
      sistema: fat('sistema'), contabilidade: fat('contabilidade'), seguro: fat('seguro'), plano: fat('plano'),
      diversos: fat('diversos'), telefone: fat('telefone'), tarifa: fat('tarifa'), acordos: fat('acordos'),
      publicidade: b === 'site' ? manual.site?.publicidade ?? null : fat('publicidade'),
    });
    percentuais[b] = { simples: aliq, icms, embalagens: emb };
  }
  const manuais = base.manuais.slice();
  for (const b of LOJAS) {
    if (b === 'site') continue;
    const bs = Object.values(manual[b]?.boletos || {});
    const total = r2(bs.reduce((s, x) => s + x.total, 0));
    manuais.push({ loja: b, id: 'boleto', rotulo: bs.length ? `Boleto do shopping: ${bs.length} arquivo(s), total ${total}` : 'Boleto do shopping (PDF)', tipo: 'arquivo', feito: bs.length > 0 });
  }
  const lista = o => Object.entries(o || {}).map(([nome, valores]) => ({ nome, lojas: valores })).sort((a, c) => a.nome.localeCompare(c.nome, 'pt-BR'));
  const det = { ...base.detalhe };
  for (const k of ['sistema', 'contabilidade', 'seguro', 'plano', 'diversos', 'telefone', 'publicidade', 'tarifa', 'vt', 'acordos']) det[k] = lista(detalhe[k]);
  const ref = L.REF.planilha[mes];
  return { ...base, lojas, percentuais, detalhe: det, manuais, pendencias: manuais.filter(i => !i.feito), estrutura: L.ESTRUTURA,
    planilha: ref ? Object.fromEntries(Object.entries(ref).map(([b, p]) => [b, { ...p, sobra: p.liquido, liquido: undefined }])) : null,
    folhaFechada: Object.fromEntries(LOJAS.map(b => [b, !!folhaMes?.[b]?.encerrada])) };
}

function register(app, { getDb, readDB, readContasPagar, requireAuth, souDono, computeConferenciaDashboard, hojeBRT, boardsLabel, folhaDoMesComFaltas }) {
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
    Object.assign((doc.lojas[loja] ||= {}), campos);
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

  app.get('/api/dre-resultados', requireAuth, soDono, async (req, res) => {
    try {
      const hoje = hojeBRT();
      const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hoje.slice(0, 7);
      const [foto, faturas, db, manual, hist] = await Promise.all([
        conferenciaDoMes(mes, req.query.recalcular === '1', hoje),
        faturasDoMes(mes),
        readDB(),
        lerManual(mes),
        dadosDoHistorico(mes),
      ]);
      const parcial = montar({ mes, conferencia: foto.lojas, caixa: db.caixa || {}, faturas, manual });
      const dre = montarCompleta(parcial, { mes, manual, faturas, apuracoes: hist.apuracoes,
        embalagem: { pago: hist.pago, venda: vendaDe12Meses(mes, hist.faturamentoExtra) }, folhaMes: folhaDoMes(db, mes),
        employees: db.employees || [], freteTommy: foto.freteTommy, faturamentoExtra: hist.faturamentoExtra });
      const pagos = faturas.map(g => ({ b: g.b, f: g.f, v: g.vp || 0 }));
      for (const [nome, f] of Object.entries(manual.lez?.faturas?.fornecedores || {}))
        pagos.push({ b: 'lez', f: nome, v: f.pago || 0 });
      const coluna = k => Object.fromEntries(LOJAS.map(b => [b, dre.lojas[b][k] || 0]));
      res.json({
        ...dre,
        caixa: montarCaixa({ lojas: LOJAS, pagos, recebimentos: coluna('receita'),
          extras: { taxa: coluna('taxa'), caixinha: coluna('caixinha') } }),
        conferenciaEm: foto.em,
        labels: Object.fromEntries(LOJAS.map(b => [b, boardsLabel[b] || b])),
        ordem: LOJAS,
      });
    } catch (e) { console.error('[dreResultados]', e); res.status(500).json({ error: e.message }); }
  });

  // POST /api/dre-resultados/importar — relatório da Lez; o mês vem do próprio arquivo
  app.post('/api/dre-resultados/importar', requireAuth, soDono, upload.single('arquivo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Envie o arquivo' });
      if (/\.pdf$/i.test(req.file.originalname)) {
        const bol = await lerBoleto(req.file.buffer);
        await gravarManual(bol.mes, bol.loja, { [`boletos.${bol.chave}`]: { total: bol.total, valores: bol.valores } });
        return res.json(bol);
      }
      const rel = lerRelatorio(req.file.buffer);
      const em = new Date().toISOString();
      if (rel.tipo === 'vendas') await gravarManual(rel.mes, 'lez', { vendas: { receita: rel.receita, cmv: rel.cmv, em } });
      else await gravarManual(rel.mes, 'lez', { faturas: { totais: rel.totais, aClassificar: rel.aClassificar, fornecedores: rel.fornecedores, em } });
      res.json(rel);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PUT /api/dre-resultados/manual { mes, loja, campo, valor } — valor vazio limpa
  app.put('/api/dre-resultados/manual', requireAuth, soDono, async (req, res) => {
    try {
      const { mes, loja, campo } = req.body || {};
      const valor = req.body?.valor === '' || req.body?.valor == null ? null : Number(req.body.valor);
      if (!/^\d{4}-\d{2}$/.test(mes || '') || !CAMPOS_MANUAIS[loja]?.includes(campo) || Number.isNaN(valor))
        return res.status(400).json({ error: 'Campo ou valor inválido' });
      await gravarManual(mes, loja, { [campo]: valor });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register, montar, montarCompleta, linhaFinanceira, somarSangria, LOJAS, PLANILHA };
