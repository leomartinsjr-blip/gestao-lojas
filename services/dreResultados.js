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

function register(app, { getDb, readDB, readContasPagar, requireAuth, souDono, computeConferenciaDashboard, hojeBRT, boardsLabel }) {
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
      if (foto) return { lojas: foto.lojas, em: foto.em };
    }
    const [y, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const fim = ehMesFechado(mes, hoje) ? `${mes}-${String(ultimo).padStart(2, '0')}` : hoje;
    const { porLoja } = await computeConferenciaDashboard(`${mes}-01`, fim);
    const lojas = porLoja.filter(l => l?.board).map(l => ({
      board: l.board, vlrLiquido: l.vlrLiquido, vlrCusto: l.vlrCusto, vlrTaxa: l.vlrTaxa,
    }));
    const em = new Date().toISOString();
    if (ehMesFechado(mes, hoje)) {
      if (db) await db.collection('dreFoto').replaceOne({ _id: mes }, { lojas, em }, { upsert: true });
      else memoria[mes] = { lojas, em };
    }
    return { lojas, em };
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
      const [foto, faturas, db, manual] = await Promise.all([
        conferenciaDoMes(mes, req.query.recalcular === '1', hoje),
        faturasDoMes(mes),
        readDB(),
        lerManual(mes),
      ]);
      const dre = montar({ mes, conferencia: foto.lojas, caixa: db.caixa || {}, faturas, manual });
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

module.exports = { register, montar, linhaFinanceira, somarSangria, LOJAS, PLANILHA };
