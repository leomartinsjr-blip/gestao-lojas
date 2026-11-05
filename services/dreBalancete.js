'use strict';
// Balancete por empresa, na foto do último dia do mês. Caixa vem da Agenda, estoque
// a custo vem da pauta da reunião, fornecedores são as faturas de mercadoria em aberto
// na data. Dívidas ficam digitadas: o controle delas é uma planilha à parte.

const r2 = v => Math.round(v * 100) / 100;

const EMPRESAS = [
  { id: 'LMJ', board: 'delrey' }, { id: 'PV', board: 'contagem' }, { id: 'JDG', board: 'minas' },
  { id: 'TTS', board: 'estacao' }, { id: '3L', board: 'tommy' }, { id: 'LF', board: 'lez' },
];

const LINHAS = [
  ['caixa', 'Caixa', 'item'], ['estoque', 'Estoque a custo', 'item'], ['ativo', 'Total do ativo', 'total'],
  ['fornecedores', 'Fornecedores', 'item'], ['dividas', 'Dívidas', 'item'], ['passivo', 'Total do passivo', 'total'],
  ['liquido', 'Ativo menos passivo', 'total'], ['estoquePago', 'Estoque pago', 'item'], ['pctPago', '% do estoque pago', 'pct'],
];

const somaContas = contas => (contas ? r2(Object.values(contas).reduce((s, v) => s + (Number(v) || 0), 0)) : null);

// saldos: { LMJ: { CC, CG } } · estoque: { board: custo } · fornecedores: { board: valor }
// digitado: { board: { caixa, estoque, fornecedores, dividas } }, que vence o calculado
function montarBalancete({ saldos = {}, estoque = {}, fornecedores = {}, digitado = {} }) {
  const out = {};
  for (const { id, board } of EMPRESAS) {
    const d = digitado[board] || {};
    const l = {
      caixa: d.caixa ?? somaContas(saldos[id]),
      estoque: d.estoque ?? estoque[board] ?? null,
      // A Lez só tem fornecedores depois de enviar o relatório de faturas
      fornecedores: d.fornecedores ?? (board === 'lez' && fornecedores.lez == null ? null : r2(fornecedores[board] || 0)),
      dividas: d.dividas ?? null,
    };
    l.ativo = r2((l.caixa || 0) + (l.estoque || 0));
    l.passivo = r2((l.fornecedores || 0) + (l.dividas || 0));
    l.liquido = r2(l.ativo - l.passivo);
    l.estoquePago = l.estoque != null ? r2(l.estoque - (l.fornecedores || 0)) : null;
    l.pctPago = l.estoque ? r2(l.estoquePago / l.estoque * 100) : null;
    l.digitado = Object.keys(d).filter(k => d[k] != null);
    out[id] = l;
  }
  return out;
}

module.exports = { montarBalancete, EMPRESAS, LINHAS };
