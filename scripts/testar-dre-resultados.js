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

// Manual: Lez importada e taxa digitada saem das pendências
const m = montar({ mes: '2026-10', conferencia, caixa, faturas, manual: {
  lez: { vendas: { receita: 68930.63, cmv: 23531.85, em: 'x' }, faturas: { totais: { juros: 4033.86 }, aClassificar: {}, em: 'x' }, taxa: 2916 },
  site: { taxa: 696, publicidade: 1178 },
} });
assert.strictEqual(m.lojas.lez.receita, 68930.63);
assert.strictEqual(m.lojas.lez.juros, 4033.86);
assert.strictEqual(m.lojas.lez.emprestimos, 0);
assert.strictEqual(m.lojas.lez.taxa, 2916);
assert.strictEqual(m.lojas.site.taxa, 696);
assert.strictEqual(m.pendencias.length, 0);

// Arquivos reais, quando informados em DRE_ARQUIVOS (não vão para o repositório)
const fs = require('fs');
const { lerRelatorio, mesDoFiltro } = require('../services/dreImportar');
assert.strictEqual(mesDoFiltro('>= 30/09/2026, 21:00:00 e <= 31/10/2026, 20:59:59'), '2026-10');
const pasta = process.env.DRE_ARQUIVOS;
if (pasta) {
  const v = lerRelatorio(fs.readFileSync(pasta + '/VResumoVendas_Sku (23).xlsx'));
  assert.strictEqual(v.mes, '2026-10'); assert.strictEqual(v.receita, 68930.63); assert.strictEqual(v.cmv, 23531.85);
  const s9 = lerRelatorio(fs.readFileSync(pasta + '/VResumoVendas_Sku (24).xlsx'));
  assert.strictEqual(s9.mes, '2026-09'); assert.strictEqual(s9.receita, 81584.42);
  const f = lerRelatorio(fs.readFileSync(pasta + '/FinPagarAnalitico (10).xlsx'));
  console.log(f);
  assert.strictEqual(f.totais.juros, 4033.86); assert.strictEqual(f.totais.publicidade, 5736.71);
  assert.strictEqual(f.totais.sistema, 1163.26); assert.strictEqual(f.totais.plano, 2706.23);
  assert.deepStrictEqual(f.aClassificar, {});
}

// Fechamento de Caixa: distribuição da skill, só o pago. Contagem, outubro/2026.
const { linhaCaixa, montarCaixa } = require('../services/dreCaixa');
for (const [f, l] of [['PARCELAMENTO SIMPLES NACIONAL', 'parcelamento'], ['SIMPLES NACIONAL', 'simples'], ['FGTS / MULTA RESCISORIA', 'fgts'],
  ['ICMS DIFERENÇA DE AL', 'difal'], ['MDIAS REFRIGERAÇOES LTDA', 'diversos'], ['MIDIAS SOCIAIS E IMPULSIONAMENTOS', 'marketing'],
  ['ALOSHOPPING - ASSOCIAÇÃO DOS LOJISTAS', 'diversos'], ['CONDOMINIO SHOPPING', 'shopping'], ['OTIMO DE BILHETAGEM ELETRONICA', 'vt'],
  ['SOUTH CENTRAL COMERCIO DE ROUPAS LTDA', 'fornecedor'], ['FORNECEDOR NOVO', 'classificar']])
  assert.strictEqual(linhaCaixa(f), l, f);
const cx = montarCaixa({ lojas: ['contagem'], recebimentos: { contagem: 100 }, extras: { taxa: { contagem: 10 } }, pagos: [
  { b: 'contagem', f: 'ALUGUEL SHOPPING', v: 6747.05 }, { b: 'contagem', f: 'CONDOMINIO SHOPPING', v: 7615.79 }, { b: 'contagem', f: 'X', v: 0 },
] });
assert.strictEqual(cx.linhas.find(l => l.id === 'shopping').lojas.contagem, 14362.84);
assert.strictEqual(cx.soma.contagem, 14372.84);
assert.strictEqual(cx.resultado.contagem, -14272.84);
assert.strictEqual(r2det(), 2);
function r2det() { return montar({ mes: '2026-10', caixa, faturas, conferencia }).detalhe.juros.length; }

// DRE completa: folha de Contagem de outubro, com supervisor rateado por Minas, Contagem e Estação
const { montarCompleta } = require('../services/dreResultados');
const L = require('../services/dreLinhas');
const folhaMes = {
  contagem: { entries: { 1: { tipo: 'caixa', fixo: 3400, gmComplement: 567.17, quebra: 247.3, comissaoTotal: 3832.83, proventos: 9177.3 } } },
  minas: { entries: { 9: { tipo: 'supervisor', fixo: 2388.34, comissaoTotal: 1881.59, proventos: 5669.93, ajudaCustoTotal: 1200,
    lojaComissoes: [{ board: 'minas', comissao: 580.23 }, { board: 'contagem', comissao: 638.8 }, { board: 'estacao', comissao: 662.56 }] } } },
  site: { entries: { 2: { tipo: 'socio', proventos: 3674.66 }, 3: { tipo: 'socio', proventos: 18000 } } },
};
const employees = [{ id: 9, supervisedBoards: ['minas', 'contagem', 'estacao'] }, { id: 2, name: 'INGRID MUNIZ' }, { id: 3, name: 'LEONARDO MARTINS JUNIOR' }];
const fp = L.folhaPorLoja(folhaMes, employees);
assert.strictEqual(fp.contagem.fixos, 5010.58);
assert.strictEqual(fp.contagem.comissoes, 4471.63);
assert.strictEqual(fp.contagem.premiacoes, 1130);
assert.strictEqual(fp.minas.ajuda, 1200);
assert.strictEqual(Math.round(L.aliquotaSimples('delrey', '2026-10') * 10000), 1019);
assert.strictEqual(L.linhaDre('MAGNUM LUIZ - TECNICO', 'tommy'), 'magnum');
assert.strictEqual(L.linhaDre('FOLHA DE PAGAMENTO', 'delrey'), null);
assert.strictEqual(L.linhaDre('CONDOMINIO SHOPPING', 'delrey'), null);
assert.strictEqual(L.linhaDre('CONDOMINIO SHOPPING', 'site'), 'sala');
const dc = montarCompleta(montar({ mes: '2026-10', conferencia, caixa, faturas }), { mes: '2026-10', manual: { contagem: { ponto: 16226.63 } }, faturas,
  apuracoes: [{ competencia: '2026-09', empresa: 'PV COMERCIO', difal: 10.55, base4: 100, base12: 0 }], embalagem: { pago: { contagem: 45 }, venda: { contagem: 10000 } },
  folhaMes, employees, freteTommy: 485.91, faturamentoExtra: {} });
assert.strictEqual(dc.lojas.contagem.ponto, 16226.63);
assert.strictEqual(dc.lojas.contagem.encargos, 2749.84);
assert.strictEqual(dc.lojas.tommy.frete, 485.91);
assert.ok(dc.lojas.lez.faltam.includes('receita'));
assert.ok(dc.estrutura.length > 25);
console.log('ok: DRE/Resultados confere com outubro/2026');
