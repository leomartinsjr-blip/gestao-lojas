// Confere a montagem da DRE/Resultados contra outubro/2026 das planilhas.
// Os números de entrada foram lidos do gestão em produção em 04/11/2026.
const assert = require('assert');
const { montar, linhaFinanceira, PLANILHA } = require('../services/dreResultados');

const conferencia = [
  { board: 'delrey',   vlrLiquido: 142521.4, vlrCusto: 62730.45, vlrTaxa: 4221.25 },
  { board: 'minas',    vlrLiquido: 77364.63, vlrCusto: 40281.12, vlrTaxa: 2216.53 },
  { board: 'contagem', vlrLiquido: 85173.9,  vlrCusto: 38093.55, vlrTaxa: 1806.8 },
  { board: 'estacao',  vlrLiquido: 88341.83, vlrCusto: 40842.03, vlrTaxa: 2212.04 },
  { board: 'tommy',    vlrLiquido: 80190.2,  vlrCusto: 33556,    vlrTaxa: 2308.96 },
  { board: 'site',     vlrLiquido: 8695.69,  vlrCusto: 3985.59,  vlrTaxa: 118.05 },
];
const caixa = {
  '2026-10-delrey': { 1: { sangria: 2677.15 } },
  '2026-10-minas': { 1: { sangria: 1000 }, 2: { sangria: 230.33 } },
  '2026-10-tommy': { 1: { sangria: 1458.58 } },
};
const faturas = [
  { b: 'delrey', f: 'JUROS / IOF', vp: 5056.09, va: 0 },
  { b: 'delrey', f: 'EMPRESTIMO', vp: 6395.52, va: 0 },
  { b: 'delrey', f: 'ALUGUEL SHOPPING', vp: 8961.42, va: 0 },
  { b: 'minas', f: 'Juros', vp: 0, va: 12671.42 },
];

const r = montar({ mes: '2026-10', conferencia, caixa, faturas });
const ref = PLANILHA['2026-10'];

assert.strictEqual(r.lojas.delrey.receita, 142521.4);
assert.strictEqual(r.lojas.delrey.juros, ref.delrey.juros);
assert.strictEqual(r.lojas.delrey.emprestimos, ref.delrey.emprestimos);
assert.strictEqual(r.lojas.minas.juros, ref.minas.juros, 'fatura em aberto entra');
assert.strictEqual(r.lojas.minas.caixinha, 1230.33);
assert.strictEqual(r.lojas.site.taxa, null, 'taxa do Site é digitada');
assert.strictEqual(r.lojas.site.caixinha, 0, 'Site não tem caixinha');
assert.strictEqual(r.lojas.lez.juros, null, 'juros da Lez vêm do relatório');
assert.strictEqual(r.lojas.lez.receita, null, 'Lez vem de importação');
assert.ok(r.pendencias.some(p => p.loja === 'lez'));
assert.ok(r.pendencias.some(p => p.loja === 'site'));
for (const b of ['delrey', 'minas', 'contagem', 'tommy']) {
  assert.ok(Math.abs(r.lojas[b].receita - ref[b].receita) <= 1, `receita ${b}`);
  assert.ok(Math.abs(r.lojas[b].cmv - ref[b].cmv) <= 40, `cmv ${b}`);
  assert.ok(Math.abs(r.lojas[b].taxa - ref[b].taxa) <= 4, `taxa ${b}`);
}
assert.strictEqual(linhaFinanceira('ALUGUEL SHOPPING'), null);
assert.strictEqual(linhaFinanceira('PARCELAMENTO SIMPLES NACIONAL'), null);
assert.strictEqual(linhaFinanceira('IOF'), 'juros');
console.log('ok: DRE/Resultados confere com outubro/2026');
