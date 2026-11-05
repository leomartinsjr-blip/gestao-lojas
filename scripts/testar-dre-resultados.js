// Confere a montagem da DRE/Resultados contra outubro/2026 das planilhas.
// Os números de entrada foram lidos do gestão em produção em 04/11/2026.
const assert = require('assert');
const { linhaCaixa, montarCaixa } = require('../services/dreCaixa');
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
const comExtras = L.folhaPorLoja({ delrey: { entries: { 7: { tipo: 'vendedor', proventos: 4000, fixo: 1000, extras: [
  { nome: '13o Salário Proporcional 8/12 avos', valor: 1416.72 }, { nome: 'Terço Constitucional de Férias', valor: 472.24 },
  { nome: 'Salário Família', valor: 135.08 }, { nome: 'Instagram da loja', valor: 600 }, { nome: 'DIFERENÇA DE FÉRIAS', valor: 100 }] } } } }, []);
assert.strictEqual(comExtras.delrey.premiacoes, 875.96, 'só o que é prêmio fica em Premiações');
assert.strictEqual(comExtras.delrey.fixos, 1100, 'diferença de férias vai para salário');
assert.strictEqual(Math.round(L.aliquotaSimples('delrey', '2026-10') * 10000), 1019);
assert.strictEqual(L.linhaDre('MAGNUM LUIZ - TECNICO', 'tommy'), 'magnum');
assert.strictEqual(L.linhaDre('FOLHA DE PAGAMENTO', 'delrey'), null);
assert.strictEqual(L.linhaDre('CONDOMINIO SHOPPING', 'delrey'), null);
assert.strictEqual(L.linhaDre('CONDOMINIO SHOPPING', 'site'), 'sala');
const dc = montarCompleta(montar({ mes: '2026-10', conferencia, caixa, faturas }), { mes: '2026-10', manual: { contagem: { boletos: { a: { total: 16226.63, valores: { aluguel: 8433.68, condominio: 4993.42, fpp: 1686.74, ar: 244.69, iptu: 261.58, energia: 606.52 } } } } }, faturas,
  apuracoes: [{ competencia: '2026-09', empresa: 'PV COMERCIO', difal: 10.55, base4: 100, base12: 0 }], embalagem: { pago: { contagem: 45 }, venda: { contagem: 10000 } },
  folhaMes, employees, freteTommy: 485.91, faturamentoExtra: {} });
assert.strictEqual(dc.lojas.contagem.ponto, 16226.63);
// Valor digitado vence o calculado e recalcula o resultado
const manualAj = { contagem: { ajustes: { simples: 1000, energia: 700 }, boletos: { a: { total: 16226.63, valores: { aluguel: 8433.68, condominio: 4993.42, fpp: 1686.74, ar: 244.69, iptu: 261.58, energia: 606.52 } } } } };
const ctxAj = { mes: '2026-10', manual: manualAj, faturas, apuracoes: [], embalagem: { pago: {}, venda: {} }, folhaMes, employees, freteTommy: 0, faturamentoExtra: {} };
const dj = montarCompleta(montar({ mes: '2026-10', conferencia, caixa, faturas }), ctxAj);
assert.strictEqual(dj.lojas.contagem.simples, 1000);
assert.strictEqual(dj.lojas.contagem.ponto, 16320.11, 'ponto soma o item editado');
assert.ok(dj.lojas.contagem.ajustado.simples > 7000, 'guarda o calculado');
const cxAj = montarCaixa({ lojas: ['contagem'], pagos: [{ b: 'contagem', f: 'ALUGUEL SHOPPING', v: 100 }], ajustes: { contagem: { shopping: 250 } } });
assert.strictEqual(cxAj.soma.contagem, 250);
assert.strictEqual(cxAj.linhas[0].ajustado.contagem, 100);
// Conferência antes de finalizar
const { conferirLoja } = require('../services/dreResultados');
const conf1 = conferirLoja({ loja: 'lez', manual: {}, folhaFechada: false, dados: { lojas: { lez: { faltam: ['ponto'], ajustado: {} } }, caixa: { linhas: [] } } });
assert.ok(conf1.find(i => i.id === 'linhas').bloqueia && !conf1.find(i => i.id === 'linhas').ok);
assert.strictEqual(conf1.find(i => i.id === 'folha').ok, false);
const conf2 = conferirLoja({ loja: 'site', manual: { site: { conferidos: { simples: 1 } } }, folhaFechada: false, dados: { lojas: { site: { faltam: [], ajustado: { taxa: 1 } } }, caixa: { linhas: [{ id: 'classificar', lojas: { site: 10 } }] } } });
assert.ok(!conf2.some(i => i.id === 'folha'), 'Site não tem folha para conferir');
assert.strictEqual(conf2.find(i => i.id === 'fornecedores').ok, false);
assert.strictEqual(conf2.find(i => i.id === 'simples').ok, false, 'sem extrato fica pendente');
const conf3 = conferirLoja({ loja: 'minas', manual: {}, folhaFechada: true, dados: { lojas: { minas: { faltam: [], ajustado: {} } }, caixa: { linhas: [] } },
  extratos: { JDG: { pa: '2026-09', rpa: 48251.5, das: 4326.21, rbtMes: 1246101.73 } } });
assert.strictEqual(conf3.find(i => i.id === 'simples').ok, true);
assert.strictEqual(conf3.find(i => i.id === 'extrato-receita').ok, false, 'setembro difere da planilha');
assert.ok(conf2.some(i => i.id === 'editados'));
const H = require('../services/dreHistorico.json');
assert.strictEqual(H['2026-06'].lojas.delrey.receita, 157161, 'junho corrigido pela Conferência');
assert.strictEqual(H['2026-09'].lojas.lez.operacional, null, 'o resultado de setembro da Lez era outubro');
assert.ok(!H['2026-10'], 'outubro em diante vem do módulo');
// Escritório de outubro pelos cadastros padrão: mesmo número combinado
const C = require('../services/dreCadastros');
const lancE = [{ b: 'site', f: 'ALUGUEL - ED MONTEREY OFFICE', v: 1912.3 }, { b: 'site', f: 'CEMIG', v: 307.09 }, { b: 'site', f: 'CONDOMINIO SHOPPING', v: 853.12 },
  { b: 'delrey', f: 'CONDOMINIO SHOPPING', v: 17559.15 }, { b: 'minas', f: 'MAGNUM CONSULTORIA', v: 157.5 }, { b: 'contagem', f: 'MAGNUM CONSULTORIA', v: 157.5 }, { b: 'site', f: 'MAGNUM CONSULTORIA', v: 157.5 }, { b: 'tommy', f: 'MAGNUM LUIZ - TECNICO', v: 125 }];
const ce = C.calcularEscritorio({ itens: C.PADRAO.escritorio, lancamentos: lancE, pessoas: [{ nome: 'INGRID MUNIZ', valor: 3674.66 }, { nome: 'LAURA FARIA DE MATOS', valor: 2000 }, { nome: 'LEONARDO', valor: 18000 }] });
assert.strictEqual(ce.porLoja.delrey, 2379.77);
assert.strictEqual(ce.porLoja.estacao, 1810.43);
assert.ok(!ce.usados.has(lancE[3]), 'condomínio da loja não vai para o rateio');
// Mapa de fornecedores: a escolha vence o mapa padrão, na DRE e no caixa
const esc2 = C.escolhidosDe({ fornecedores: [{ nome: 'GRAFICA JR DIGITAL LTDA', linha: 'marketing' }, { nome: 'NOVO S.A', linha: 'fornecedor' }] });
assert.strictEqual(linhaCaixa('Grafica JR Digital Ltda', esc2), 'marketing');
assert.strictEqual(L.linhaDre('GRAFICA JR DIGITAL LTDA', 'site', esc2), 'publicidade');
assert.strictEqual(L.linhaDre('NOVO S.A', 'site', esc2), null, 'mercadoria não entra em despesa');
assert.strictEqual(montar({ mes: '2026-10', faturas: [{ b: 'delrey', f: 'JUROS X', vp: 10 }], escolhidos: { 'JUROS X': 'diversos' } }).lojas.delrey.juros, 0);
assert.strictEqual(C.comPadrao({ escritorio: [{ id: 'ingrid', nome: 'Ingrid', encargos: true }] }).escritorio[0].encargosPct, 19.44);
assert.strictEqual(C.validar({ escritorio: [{ nome: '', origem: 'fixo', lojas: ['lez'] }] }), 'Todo custo precisa de nome');
assert.strictEqual(dc.lojas.contagem.encargos, 2749.84);
assert.strictEqual(dc.lojas.tommy.frete, 485.91);
assert.ok(dc.lojas.lez.faltam.includes('receita'));
assert.ok(dc.estrutura.length > 25);
assert.strictEqual(dc.lojas.contagem.salarios, r2t(dc.lojas.contagem.fixos + dc.lojas.contagem.comissoes + dc.lojas.contagem.encargos + dc.lojas.contagem.escritorio + dc.lojas.contagem.premiacoes + dc.lojas.contagem.vt));
assert.strictEqual(dc.lojas.contagem.operacional, r2t(dc.lojas.contagem.lucroBruto - dc.lojas.contagem.salarios - dc.lojas.contagem.ponto - dc.lojas.contagem.administrativo - dc.lojas.contagem.marketing - dc.lojas.contagem.taxas));
function r2t(v) { return Math.round(v * 100) / 100; }

// Boletos reais de outubro, com o total que a DRE da planilha usava
const { lerBoleto, fecharBoleto } = require('../services/dreBoletos');
const minas = fecharBoleto({ loja: 'minas', total: 25089.61, chave: '1', itens: [
  ['Aluguel Minimo', '10/2026', 15284.95], ['Cota Condominial Comum', '11/2026', 4504.77], ['Energia(For+Infr)', '09/2026', 667.37], ['Ar Condicionado', '10/2026', 634.31],
  ['IPTU', '11/2026', 802.93], ['Fundo de reserva', '10/2026', 450.48], ['Seguros', '10/2026', 33.25], ['Dedetização/Desratização', '10/2026', 14.21], ['Cota Ordinária Lojista FPP', '10/2026', 2697.34],
].map(([descricao, competencia, valor]) => ({ descricao, competencia, valor })) });
assert.strictEqual(minas.valores.condominio, 5002.71);
assert.strictEqual(minas.mes, '2026-10');
assert.throws(() => fecharBoleto({ loja: 'minas', total: 100, itens: [{ descricao: 'Aluguel Minimo', competencia: '10/2026', valor: 90 }] }), /não bate/);
(async () => {
  if (pasta) {
    const esperado = { 'boleto (83).pdf': ['delrey', 27933.42, 8961.11, 12566.26, 3360.42], 'boleto (81).pdf': ['lez', 19495.46, 5184, 9928.43, 2592],
      'boleto (80).pdf': ['tommy', 24671.65, 5200, 14895.35, 1560], 'SCO02028SURFERS202610000234.PDF': ['contagem', 16226.63, 8433.68, 4993.42, 1686.74] };
    for (const [arq, [loja, total, aluguel, cond, fpp]] of Object.entries(esperado)) {
      const b = await lerBoleto(fs.readFileSync(pasta + '/' + arq));
      assert.deepStrictEqual([b.loja, b.mes, b.total, b.valores.aluguel, b.valores.condominio, b.valores.fpp], [loja, '2026-10', total, aluguel, cond, fpp], arq);
    }
    const iptu = await lerBoleto(fs.readFileSync(pasta + '/boleto (82).pdf'));
    assert.deepStrictEqual([iptu.loja, iptu.mes, iptu.valores.iptu], ['delrey', '2026-10', 114.24]);
  }
  if (pasta) {
    const pdf = require('pdf-parse');
    const { lerTexto } = require('../services/dreExtrato');
    const esperado = { '07202628881034296': ['LMJ', 143198.14, 14608.68, 2126375.81], '07202628885737682': ['JDG', 48251.5, 4326.21, 1246101.73], '07202628691719158': ['PV', 81146, 7494.12, 1517547.39],
      '07202628889910281': ['TTS', 81038.99, 7383.76, 1392389.53], '07202628802703149': ['3L', 95971, 8660.3, 1355080.06], '07202628733231417': ['LF', 81951.99, 7099.11, 1117400.85] };
    for (const [n, [emp, rpa, das, rbt]] of Object.entries(esperado)) {
      const e = lerTexto((await pdf(fs.readFileSync(`${pasta}/PGDASD-EXTRATO-${n}.pdf`))).text);
      assert.deepStrictEqual([e.empresa, e.pa, e.mes, e.rpa, e.das], [emp, '2026-09', '2026-10', rpa, das], n);
      const soma = L.mesesAntes('2026-10', 12).reduce((s, mk) => s + (e.faturamento[mk] || 0), 0);
      assert.ok(Math.abs(soma - rbt) < 0.01, emp);
      assert.ok(Math.abs(L.aliquotaSimples({ LMJ: 'delrey', JDG: 'minas', PV: 'contagem', TTS: 'estacao', '3L': 'tommy', LF: 'lez' }[emp], '2026-10', {}, e) - L.aliquotaSimples({ LMJ: 'delrey', JDG: 'minas', PV: 'contagem', TTS: 'estacao', '3L': 'tommy', LF: 'lez' }[emp], '2026-10')) < 0.0001, emp);
    }
  }
  console.log('ok: DRE/Resultados confere com outubro/2026');
})().catch(e => { console.error(e); process.exit(1); });
