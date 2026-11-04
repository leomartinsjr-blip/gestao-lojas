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
function montar({ mes, conferencia = [], caixa = {}, faturas = [] }) {
  const conf = Object.fromEntries(conferencia.map(l => [l.board, l]));
  const fin = {};
  for (const g of faturas) {
    const linha = linhaFinanceira(g.f);
    if (!linha) continue;
    const alvo = (fin[g.b] ||= { juros: 0, emprestimos: 0 });
    alvo[linha] += (g.vp || 0) + Math.max(0, g.va || 0);
  }

  const lojas = {};
  const pendencias = [];
  for (const b of LOJAS) {
    const c = conf[b];
    const temConf = c && !SEM_CONFERENCIA.has(b);
    const receita = temConf ? r2(c.vlrLiquido || 0) : null;
    const cmv = temConf ? r2(c.vlrCusto || 0) : null;
    const taxa = temConf && !TAXA_MANUAL.has(b) ? r2(c.vlrTaxa || 0) : null;
    const caixinha = SEM_CAIXINHA.has(b) ? 0 : somarSangria(caixa[`${mes}-${b}`]);
    // A Lez não tem faturas no Microvix: juros e dívida vêm do relatório dela
    const juros = SEM_CONFERENCIA.has(b) ? null : r2(fin[b]?.juros || 0);
    const emprestimos = SEM_CONFERENCIA.has(b) ? null : r2(fin[b]?.emprestimos || 0);
    lojas[b] = { receita, cmv, taxa, caixinha, juros, emprestimos };

    if (SEM_CONFERENCIA.has(b)) {
      pendencias.push({ loja: b, item: 'Relatório de vendas e CMV (VResumoVendas)' });
      pendencias.push({ loja: b, item: 'Relatório de faturas (FinPagarAnalitico)' });
    }
    if (TAXA_MANUAL.has(b)) pendencias.push({ loja: b, item: 'Taxa de cartão digitada' });
  }
  return { mes, lojas, pendencias, planilha: PLANILHA[mes] || null };
}

function register(app, { getDb, readDB, readContasPagar, requireAuth, souDono, computeConferenciaDashboard, hojeBRT, boardsLabel }) {
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
      const [foto, faturas, db] = await Promise.all([
        conferenciaDoMes(mes, req.query.recalcular === '1', hoje),
        faturasDoMes(mes),
        readDB(),
      ]);
      res.json({
        ...montar({ mes, conferencia: foto.lojas, caixa: db.caixa || {}, faturas }),
        conferenciaEm: foto.em,
        labels: Object.fromEntries(LOJAS.map(b => [b, boardsLabel[b] || b])),
        ordem: LOJAS,
      });
    } catch (e) { console.error('[dreResultados]', e); res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register, montar, linhaFinanceira, somarSangria, LOJAS, PLANILHA };
