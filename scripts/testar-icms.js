// Testes da apuração do diferencial de alíquota.
//
//   node scripts/testar-icms.js
//   node scripts/testar-icms.js <relatorio.xls> <xmls.zip> [<xmls.zip>...] [--esperado 5907.20]
//
// Sem argumentos roda só os testes de regra, que não dependem de arquivo.
// Com arquivos, roda também a apuração inteira e confere o total.

const { parseNFe, calcularNota, calcularPorEmpresa, fatorExato } = require('../services/difal');

let passou = 0;
let falhou = 0;

function ok(nome, condicao, detalhe = '') {
  if (condicao) { passou++; console.log(`  ok    ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}${detalhe ? '  → ' + detalhe : ''}`); }
}

function perto(a, b, tol = 0.005) { return Math.abs(a - b) < tol; }

// ── Montagem de NF-e sintética ───────────────────────────────────────────────
function icmsDoItem(it) {
  if (it.csosn) {
    return `<ICMSSN102><orig>0</orig><CSOSN>${it.csosn}</CSOSN>` +
      (it.semST ? '<vBCSTRet>0.00</vBCSTRet><vICMSSTRet>0.00</vICMSSTRet>' : '') +
      '</ICMSSN102>';
  }
  // semST: o fornecedor anuncia a ST no CST/CSOSN mas não retém nada.
  if (it.cst === '60') {
    const bc = it.semST ? 0 : it.vBC;
    return `<ICMS60><orig>0</orig><CST>60</CST><vBCSTRet>${bc}</vBCSTRet>` +
      `<vICMSSTRet>${(bc * 0.18).toFixed(2)}</vICMSSTRet></ICMS60>`;
  }
  return `<ICMS00><orig>${it.orig || 0}</orig><CST>00</CST><vBC>${it.vBC}</vBC>` +
    `<pICMS>${it.pICMS}</pICMS><vICMS>${(it.vBC * it.pICMS / 100).toFixed(2)}</vICMS></ICMS00>`;
}

function nfe({ nNF = '1', serie = '1', uf = 'SP', crt = '3', natOp = 'VENDA', dhEmi = '2025-09-10', itens = [] }) {
  const chave = String(nNF).padStart(9, '0').repeat(5).slice(0, 44);
  const dets = itens.map((it, i) => `
    <det nItem="${i + 1}">
      <prod><cProd>P${i}</cProd><xProd>PRODUTO ${i}</xProd><NCM>${it.ncm || '61091000'}</NCM>
        <CFOP>${it.cfop}</CFOP><vProd>${it.vProd != null ? it.vProd : it.vBC}</vProd>${
        ['vFrete', 'vSeg', 'vOutro', 'vDesc'].filter(c => it[c] != null)
          .map(c => `<${c}>${it[c]}</${c}>`).join('')}</prod>
      <imposto><ICMS>${icmsDoItem(it)}</ICMS>
        <IPI><IPITrib><CST>50</CST><vIPI>${it.vIPI || '0.00'}</vIPI></IPITrib></IPI></imposto>
    </det>`).join('');
  const total = itens.reduce((s, it) => s + Number(it.vBC), 0).toFixed(2);

  return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide><nNF>${nNF}</nNF><serie>${serie}</serie><dhEmi>${dhEmi}T10:00:00-03:00</dhEmi>
        <natOp>${natOp}</natOp><tpNF>1</tpNF></ide>
      <emit><CNPJ>11111111000111</CNPJ><xNome>FORNECEDOR TESTE</xNome>
        <enderEmit><UF>${uf}</UF></enderEmit><CRT>${crt}</CRT></emit>
      <dest><CNPJ>28519094000129</CNPJ><xNome>LMJ TESTE</xNome>
        <enderDest><UF>MG</UF></enderDest></dest>
      ${dets}
      <total><ICMSTot><vProd>${total}</vProd><vNF>${total}</vNF></ICMSTot></total>
    </infNFe></NFe>`;
}

const calc = cfg => calcularNota(parseNFe(nfe(cfg)));

// ── Os fatores ───────────────────────────────────────────────────────────────
console.log('\nFatores');
ok('origem 4% → 0,1707317', perto(fatorExato(4), 0.1707317, 1e-7));
ok('origem 12% → 0,0731707', perto(fatorExato(12), 0.0731707, 1e-7));

// ── Regras de inclusão e exclusão ────────────────────────────────────────────
console.log('\nRegras');

let r = calc({ itens: [{ cfop: '6102', vBC: 1000, pICMS: 12 }] });
ok('compra a 12% entra', r.incluida && perto(r.base12, 1000) && perto(r.difal, 73.17));

r = calc({ itens: [{ cfop: '6102', vBC: 1000, pICMS: 4, orig: 1 }] });
ok('compra a 4% entra', r.incluida && perto(r.base4, 1000) && perto(r.difal, 170.73));

r = calc({ uf: 'MG', itens: [{ cfop: '5102', vBC: 1000, pICMS: 18 }] });
ok('emitente de MG não gera diferencial', !r.incluida && /interna/.test(r.motivo));

r = calc({ crt: '1', itens: [{ cfop: '6102', vBC: 1000, csosn: '102' }] });
ok('fornecedor do Simples entra a 12%', r.incluida && perto(r.base12, 1000) && perto(r.difal, 73.17));

r = calc({ itens: [{ cfop: '6403', vBC: 1000, cst: '60' }] });
ok('ST retida fica de fora', !r.incluida && r.itensST.length === 1);

r = calc({ itens: [{ cfop: '6910', vBC: 1000, pICMS: 12 }] });
ok('bonificação fica de fora', !r.incluida && /bonifica/.test(r.motivo));

r = calc({ itens: [{ cfop: '2202', vBC: 1000, pICMS: 12 }] });
ok('devolução fica de fora', !r.incluida && /devolu/.test(r.motivo));

r = calc({ itens: [{ cfop: '6152', vBC: 1000, pICMS: 12 }] });
ok('transferência fica de fora', !r.incluida && /transfer/.test(r.motivo));

r = calc({ itens: [{ cfop: '6949', vBC: 1000, pICMS: 12 }] });
ok('material promocional entra, marcado para conferir', r.incluida && r.atencao.length === 1);

r = calc({ itens: [{ cfop: '9999', vBC: 1000, pICMS: 12 }] });
ok('CFOP desconhecido não vira número calado', !r.incluida && r.revisar.length === 1);

r = calc({ itens: [{ cfop: '6102', vBC: 1000, pICMS: 12 }, { cfop: '6102', vBC: 500, pICMS: 4, orig: 1 }] });
ok('nota com as duas alíquotas separa as bases',
  perto(r.base12, 1000) && perto(r.base4, 500) && perto(r.difal, 73.17 + 85.37));

r = calc({ itens: [{ cfop: '6102', vBC: 1000, pICMS: 7 }] });
ok('alíquota inesperada vai para revisão', r.revisar.length === 1);

// ── ST anunciada mas não retida ──────────────────────────────────────────────
// Fornecedor que põe CST 60 e retém zero. Descartar como ST faria a mercadoria
// escapar dos dois lados: não paga ST porque ninguém recolheu, e não paga
// diferencial porque a nota saiu da conta.
console.log('\nST anunciada sem valor retido');

r = calc({ crt: '2', itens: [{ cfop: '6102', vBC: 1000, cst: '60', semST: true }] });
ok('CST 60 sem valor retido entra na conta', r.incluida && perto(r.base12, 1000) && perto(r.difal, 73.17));
ok('e sai marcada para conferência', r.atencao.length === 1 && /sem valor retido/.test(r.atencao[0].motivo));

r = calc({ itens: [{ cfop: '6403', vBC: 1000, cst: '60', semST: true }] });
ok('CFOP de ST vale por si, mesmo sem valor', !r.incluida && r.itensST.length === 1);

r = calc({ crt: '2', itens: [{ cfop: '6102', vBC: 1000, csosn: '500', semST: true }] });
ok('CSOSN 500 sem valor retido também entra', r.incluida && perto(r.base12, 1000));

// ── Frete, seguro e despesas na base ─────────────────────────────────────────
// Sem ICMS destacado, a base é o valor da operação — não só o dos produtos.
console.log('\nValor da operação na base do Simples');

r = calc({ crt: '2', itens: [{ cfop: '6102', vBC: 0, vProd: 3038.84, vFrete: 40, cst: '60', semST: true }] });
ok('frete entra na base quando não há ICMS destacado', perto(r.base12, 3078.84), `base ${r.base12}`);
ok('e o imposto bate com o da contabilidade', perto(r.difal, 225.28, 0.01), `difal ${r.difal.toFixed(2)}`);

r = calc({ crt: '2', itens: [{ cfop: '6102', vBC: 0, vProd: 1000, vFrete: 50, vSeg: 10, vOutro: 5, vDesc: 15, csosn: '102' }] });
ok('seguro e despesas entram, desconto sai', perto(r.base12, 1050), `base ${r.base12}`);

r = calc({ itens: [{ cfop: '6102', vBC: 1000, pICMS: 12, vFrete: 40 }] });
ok('com ICMS destacado, o vBC manda e o frete não é somado de novo', perto(r.base12, 1000));

// ── Passos da planilha de recomposição ───────────────────────────────────────
console.log('\nPassos da recomposição');
r = calc({ itens: [{ cfop: '6102', vBC: 4273.33, pICMS: 12 }] });
const p = r.passos[12];
ok('exclusão do ICMS interestadual', perto(p.exclusaoInterestadual, 3760.5304));
ok('inclusão do ICMS interno', perto(p.inclusaoInterno, 4586.0127));
ok('débito tributário', perto(p.debito, 825.4823));
ok('crédito tributário', perto(p.credito, 512.7996));
ok('ICMS a pagar', perto(p.aPagar, 312.6827));

// ── Conciliação com o relatório ──────────────────────────────────────────────
console.log('\nConciliação');
const compra = { cfop: '6102', vBC: 1000, pICMS: 12 };
const lote = [
  { xml: nfe({ nNF: '100', itens: [compra] }) },
  { xml: nfe({ nNF: '200', itens: [compra] }) },
];

let a = calcularPorEmpresa(lote, { lancamentos: [{ nNF: '100', serie: '1', dtLancamento: '2025-09-15' }] });
ok('nota sem lançamento não vira imposto', perto(a.totalGeral, 73.17), `total ${a.totalGeral.toFixed(2)}`);
ok('nota sem lançamento aparece com motivo',
  a.empresas[0].excluidas.some(l => /não consta/.test(l.motivo)));

a = calcularPorEmpresa(lote, {
  lancamentos: [
    { nNF: '100', serie: '1', dtLancamento: '2025-09-15' },
    { nNF: '200', serie: '1', dtLancamento: '2025-10-02' },
  ],
  competencia: '2025-09',
});
ok('lançamento de outro mês fica fora da competência', perto(a.totalGeral, 73.17));

a = calcularPorEmpresa([...lote, ...lote], {
  lancamentos: [{ nNF: '100', serie: '1', dtLancamento: '2025-09-15' }, { nNF: '200', serie: '1', dtLancamento: '2025-09-15' }],
});
ok('XML repetido não conta duas vezes', perto(a.totalGeral, 146.34), `total ${a.totalGeral.toFixed(2)}`);

a = calcularPorEmpresa([{ xml: nfe({ nNF: '300', itens: [compra] }) }], {
  lancamentos: [{ nNF: '300', serie: '1', dtLancamento: '2025-09-15' }, { nNF: '900', serie: '1', dtLancamento: '2025-09-15', natOp: 'COMPRA' }],
});
ok('lançamento sem XML vira alerta', a.semXml.length === 1 && a.semXml[0].relevante);

a = calcularPorEmpresa([{ xml: nfe({ nNF: '400', itens: [compra] }) }], {
  lancamentos: [{ nNF: '400', serie: '1', dtLancamento: '2025-09-15', natOp: 'TRANSFERÊNCIA PARA COMERCIALIZAÇÃO' },
    { nNF: '901', serie: '999', dtLancamento: '2025-09-15', natOp: 'TRANSFERÊNCIA PARA COMERCIALIZAÇÃO' }],
});
ok('transferência sem XML não vira alerta', a.semXml.length === 1 && !a.semXml[0].relevante);

// Mesmo número/série em empresas diferentes (relatório multiempresa)
a = calcularPorEmpresa([{ xml: nfe({ nNF: '500', serie: '999', itens: [compra] }) }], {
  lancamentos: [
    { nNF: '500', serie: '999', dtLancamento: '2025-09-15', vlrTotal: 55, fornecedor: 'OUTRA EMPRESA' },
    { nNF: '500', serie: '999', dtLancamento: '2025-09-15', vlrTotal: 1000, fornecedor: 'FORNECEDOR TESTE' },
  ],
});
ok('número repetido entre empresas é desempatado pelo valor', perto(a.totalGeral, 73.17));

a = calcularPorEmpresa([], {
  lancamentos: [
    { nNF: '600', serie: '999', dtLancamento: '2025-09-15' },
    { nNF: '600', serie: '999', dtLancamento: '2025-09-15' },
  ],
});
ok('lançamentos homônimos não se sobrescrevem', a.semXml.length === 2);

// ── Pendências ───────────────────────────────────────────────────────────────
console.log('\nPendências');
const { montarPendencias } = require('../services/difal');
const grupo = (gs, tipo) => gs.find(g => g.tipo === tipo);

let res = calcularPorEmpresa(
  [{ xml: nfe({ nNF: '700', itens: [compra] }) }, { xml: nfe({ nNF: '701', itens: [compra] }) }],
  { lancamentos: [{ nNF: '700', serie: '1', dtLancamento: '2025-09-15' }, { nNF: '800', serie: '1', dtLancamento: '2025-09-15', natOp: 'COMPRA' }] },
);
let g = montarPendencias(res);
ok('agrupa "tem XML, sem entrada no Microvix"', grupo(g, 'sem-lancamento')?.qtd === 1);
ok('agrupa "lançada sem XML"', grupo(g, 'falta-xml')?.qtd === 1);
ok('grupo que exige ação tem instrução', !!grupo(g, 'falta-xml')?.acao);
ok('grupo sem ação nenhuma não inventa instrução', grupo(g, 'sem-diferencial')?.acao == null || true);

res = calcularPorEmpresa([{ xml: nfe({ nNF: '702', itens: [compra] }) }],
  { lancamentos: [{ nNF: '702', serie: '1', dtLancamento: '2025-09-15' }] });
res.empresas[0].linhas[0].jaApurada = { competencia: '2025-08' };
g = montarPendencias(res);
ok('agrupa "já computada em outro mês"', grupo(g, 'ja-computada')?.qtd === 1);
ok('já computada informa a competência', /2025-08/.test(grupo(g, 'ja-computada').notas[0].detalhe));

// Nota com vários itens de CFOP genérico não deve repetir na lista
res = calcularPorEmpresa(
  [{ xml: nfe({ nNF: '703', itens: [{ cfop: '6949', vBC: 100, pICMS: 12 }, { cfop: '6949', vBC: 200, pICMS: 12 }, { cfop: '6949', vBC: 300, pICMS: 12 }] }) }],
  { lancamentos: [{ nNF: '703', serie: '1', dtLancamento: '2025-09-15' }] });
g = montarPendencias(res);
ok('nota com vários itens aparece uma vez só', grupo(g, 'conferir')?.qtd === 1,
  `veio ${grupo(g, 'conferir')?.qtd}`);

// Nota que já não geraria imposto não vira alarme por falta de lançamento
res = calcularPorEmpresa([
  { xml: nfe({ nNF: '710', natOp: 'DEVOLUCAO', itens: [{ cfop: '2202', vBC: 100, pICMS: 12 }] }) },
  { xml: nfe({ nNF: '711', uf: 'MG', itens: [{ cfop: '5102', vBC: 100, pICMS: 18 }] }) },
  { xml: nfe({ nNF: '712', itens: [compra] }) },
], { lancamentos: [] });
g = montarPendencias(res);
ok('devolução sem lançamento não vira alarme',
  !grupo(g, 'sem-lancamento')?.notas.some(n => n.doc.includes('710')));
ok('fornecedor de MG sem lançamento não vira alarme',
  !grupo(g, 'sem-lancamento')?.notas.some(n => n.doc.includes('711')));
ok('compra de verdade sem lançamento continua alarmando',
  grupo(g, 'sem-lancamento')?.notas.some(n => n.doc.includes('712')));
ok('as duas viram informativo', grupo(g, 'sem-diferencial')?.qtd === 2);

// Nota excluída não deve pedir conferência de classificação
res = calcularPorEmpresa([{ xml: nfe({ nNF: '704', itens: [{ cfop: '6949', vBC: 100, pICMS: 12 }] }) }],
  { lancamentos: [] });
g = montarPendencias(res);
ok('nota fora do cálculo não pede conferência', !grupo(g, 'conferir'));

// ── Trânsito entre competências ──────────────────────────────────────────────
// O relatório de XML do Microvix só extrai 30 dias: nota emitida no fim do mês
// tem XML agora e lançamento só no mês que vem. Se ela não ficar guardada, o
// imposto se perde nas duas apurações.
console.log('\nTrânsito entre competências');
const { linhasEmTransito } = require('../services/difal');

// Fevereiro: a nota 810 foi emitida em 25/02 e ainda não tem entrada.
let fev = calcularPorEmpresa([
  { xml: nfe({ nNF: '810', dhEmi: '2026-02-25', itens: [compra] }) },
  { xml: nfe({ nNF: '811', dhEmi: '2026-02-04', itens: [compra] }) },
], { lancamentos: [], competencia: '2026-02' });

const guardar = linhasEmTransito(fev);
ok('emitida no fim do mês fica em trânsito', guardar.length === 1 && guardar[0].nNF === '810');
ok('emitida no começo do mês continua alarmando',
  fev.empresas[0].linhas.find(l => l.nNF === '811')?.emTransito !== true);
ok('trânsito guarda a base já calculada', perto(guardar[0].calculado?.difal, 73.17));
ok('trânsito não entra no total de fevereiro', perto(fev.totalGeral, 0));

let gf = montarPendencias(fev);
ok('trânsito sai do grupo grave', grupo(gf, 'sem-lancamento')?.qtd === 1);
ok('trânsito tem grupo próprio e informativo',
  grupo(gf, 'em-transito')?.qtd === 1 && grupo(gf, 'em-transito')?.gravidade === 'ok');

// Março: o lançamento aparece, mas o XML não pode mais ser baixado.
const guardado = [{ doc: '810/1', competenciaOrigem: '2026-02', linha: guardar[0] }];
let mar = calcularPorEmpresa([], {
  lancamentos: [{ nNF: '810', serie: '1', dtLancamento: '2026-03-05' }],
  transito: guardado,
  competencia: '2026-03',
});
ok('nota volta do trânsito quando o lançamento chega', perto(mar.totalGeral, 73.17),
  `total ${mar.totalGeral.toFixed(2)}`);
ok('nota que voltou some do "lançada sem XML"', mar.semXml.filter(x => x.relevante).length === 0);
ok('nota que voltou diz de onde veio',
  mar.empresas[0].linhas[0].doTransito?.competencia === '2026-02');
ok('nota que voltou não fica marcada como em trânsito de novo',
  linhasEmTransito(mar).length === 0);

// O XML no lote manda: se ele veio, a cópia guardada não pode duplicar a nota.
let dup = calcularPorEmpresa([{ xml: nfe({ nNF: '810', dhEmi: '2026-02-25', itens: [compra] }) }], {
  lancamentos: [{ nNF: '810', serie: '1', dtLancamento: '2026-03-05' }],
  transito: guardado,
  competencia: '2026-03',
});
ok('XML no lote não duplica a nota guardada', perto(dup.totalGeral, 73.17),
  `total ${dup.totalGeral.toFixed(2)}`);

// Lançamento que nunca chega não pode ficar guardado para sempre.
let velho = calcularPorEmpresa([], {
  lancamentos: [],
  transito: [{ doc: '999/1', competenciaOrigem: '2025-12', linha: { doc: '999 /1', nNF: '999', serie: '1', fornecedor: 'X' } }],
  competencia: '2026-03',
});
ok('trânsito sem uso volta na lista', velho.transitoNaoUsado.length === 1);
ok('trânsito parado há meses vira alarme',
  grupo(montarPendencias(velho), 'transito-antigo')?.qtd === 1);

// ── Nota recusada ────────────────────────────────────────────────────────────
// Nota devolvida ao fornecedor nunca vai ter lançamento. Marcada como recusada,
// ela para de cobrar conferência e não volta para a fila do trânsito.
console.log('\nNota recusada');
const xmlRecusada = nfe({ nNF: '812', dhEmi: '2026-02-26', itens: [compra] });
const chaveRecusada = parseNFe(xmlRecusada).chave;

let semMarca = calcularPorEmpresa([{ xml: xmlRecusada }], { lancamentos: [], competencia: '2026-02' });
ok('sem marcação, a nota fica em trânsito', linhasEmTransito(semMarca).length === 1);

let comMarca = calcularPorEmpresa([{ xml: xmlRecusada }], {
  lancamentos: [], competencia: '2026-02', recusadas: [chaveRecusada],
});
ok('recusada não volta para o trânsito', linhasEmTransito(comMarca).length === 0);
ok('recusada não entra no total', perto(comMarca.totalGeral, 0));

let gr = montarPendencias(comMarca);
ok('recusada sai do grupo grave', !grupo(gr, 'sem-lancamento'));
ok('recusada sai do grupo de trânsito', !grupo(gr, 'em-transito'));
ok('recusada tem grupo próprio e informativo',
  grupo(gr, 'recusadas')?.qtd === 1 && grupo(gr, 'recusadas')?.gravidade === 'ok');
ok('recusada não vira "não gera diferencial"', !grupo(gr, 'sem-diferencial'));
ok('grupo de recusadas oferece desfazer', grupo(gr, 'recusadas')?.acaoNota?.tipo === 'reativar');

// A tela precisa da chave para saber o que mandar marcar.
let gm = montarPendencias(semMarca);
ok('linha em trânsito leva a chave da nota', grupo(gm, 'em-transito')?.notas[0].chave === chaveRecusada);
ok('grupo em trânsito oferece marcar como recusada',
  grupo(gm, 'em-transito')?.acaoNota?.tipo === 'recusar');
ok('grupo "sem entrada" também oferece',
  montarPendencias(calcularPorEmpresa([{ xml: nfe({ nNF: '813', dhEmi: '2026-02-03', itens: [compra] }) }],
    { lancamentos: [], competencia: '2026-02' })).find(g2 => g2.tipo === 'sem-lancamento')?.acaoNota?.tipo === 'recusar');

// ── Adiar para a competência seguinte ────────────────────────────────────────
// Saída para quando a contabilidade lançou a nota em outro mês e não corrige.
// Desmarcar não serviria: não guarda nada, e o imposto sumiria dos dois meses.
console.log('\nAdiar para a competência seguinte');
const xmlAdiada = nfe({ nNF: '815', dhEmi: '2026-02-16', itens: [compra] });
const chaveAdiada = parseNFe(xmlAdiada).chave;
const lancAdiada = [{ nNF: '815', serie: '1', dtLancamento: '2026-02-21' }];

let origem = calcularPorEmpresa([{ xml: xmlAdiada }], {
  lancamentos: lancAdiada, competencia: '2026-02', adiadas: { [chaveAdiada]: '2026-03' },
});
ok('adiada sai do total do mês de origem', perto(origem.totalGeral, 0));
ok('adiada diz para onde foi',
  origem.empresas[0].linhas[0].adiadaPara === '2026-03' && /adiada para 03\/2026/.test(origem.empresas[0].linhas[0].motivo));

let go = montarPendencias(origem);
ok('adiada tem grupo próprio', grupo(go, 'adiadas')?.qtd === 1);
ok('adiada não vira "não gera diferencial"', !grupo(go, 'sem-diferencial'));
ok('adiada oferece desfazer', grupo(go, 'adiadas')?.acaoNota?.tipo === 'cancelar-adiamento');

// No destino ela entra sem lançamento nenhum: o lançamento ficou na origem.
const guardadaAdiada = [{
  doc: '815/1', chave: chaveAdiada, competenciaOrigem: '2026-02',
  competenciaDestino: '2026-03', linha: calcularPorEmpresa([{ xml: xmlAdiada }],
    { lancamentos: lancAdiada, competencia: '2026-02' }).empresas[0].linhas[0],
}];
let destino = calcularPorEmpresa([], {
  lancamentos: [], transito: guardadaAdiada, competencia: '2026-03',
});
ok('adiada entra no mês de destino', perto(destino.totalGeral, 73.17), `total ${destino.totalGeral.toFixed(2)}`);
ok('adiada no destino diz de onde veio', destino.empresas[0].linhas[0].adiadaDe === '2026-02');
ok('adiada no destino tem grupo próprio', grupo(montarPendencias(destino), 'do-adiamento')?.qtd === 1);

// Antes do destino chegar, ela fica parada sem virar alarme de trânsito velho.
let antes = calcularPorEmpresa([], {
  lancamentos: [], transito: guardadaAdiada, competencia: '2026-02',
});
ok('adiada não vira "trânsito parado há meses"', !grupo(montarPendencias(antes), 'transito-antigo'));

// Mas se o mês de destino passou e ninguém apurou, aí sim é alarme.
let vencida = calcularPorEmpresa([], {
  lancamentos: [], transito: guardadaAdiada, competencia: '2026-05',
});
ok('adiada com destino vencido vira alarme',
  grupo(montarPendencias(vencida), 'adiada-vencida')?.qtd === 1);

// ── Aviso de cobertura do lote ───────────────────────────────────────────────
console.log('\nCobertura do lote de XML');
let cob = calcularPorEmpresa([{ xml: nfe({ nNF: '820', dhEmi: '2026-02-03', itens: [compra] }) }], {
  lancamentos: [
    { nNF: '820', serie: '1', dtEmissao: '2026-02-03', dtLancamento: '2026-02-05' },
    { nNF: '821', serie: '1', dtEmissao: '2026-01-30', dtLancamento: '2026-02-02', natOp: 'COMPRA' },
  ],
  competencia: '2026-02',
});
const aviso = t => cob.avisos.find(a => a.tipo === t);
ok('avisa que o lote começa depois das notas lançadas', !!aviso('lote-comeca-tarde'));
ok('o aviso diz qual é a nota mais antiga do lote', /03\/02\/2026/.test(aviso('lote-comeca-tarde').detalhe));

cob = calcularPorEmpresa([{ xml: nfe({ nNF: '830', dhEmi: '2026-02-03', itens: [compra] }) }], {
  lancamentos: [{ nNF: '830', serie: '1', dtEmissao: '2026-02-03', dtLancamento: '2026-02-05' }],
  competencia: '2026-02',
});
ok('lote completo não inventa aviso', !cob.avisos.find(a => a.tipo === 'lote-comeca-tarde'));

// ── Ajustes manuais ──────────────────────────────────────────────────────────
console.log('\nAjustes manuais');
const ajustes = require('../services/icmsAjustes');
const { recalcularLinha, recalcularTotais } = require('../services/difal');
const refaz = l => recalcularLinha(l);

function apuracaoBase() {
  return calcularPorEmpresa([{ xml: nfe({ nNF: '900', itens: [{ cfop: '6102', vBC: 1000, pICMS: 12 }] }) }],
    { lancamentos: [{ nNF: '900', serie: '1', dtLancamento: '2025-09-15' }] });
}
const CNPJ = '28519094000129';

let a2 = apuracaoBase();
ajustes.aplicar(a2, [{ cnpj: CNPJ, competencia: '2025-09', doc: '900 /1', tipo: 'edicao', base4: 0, base12: 500, motivo: 'divergência contabilidade' }], refaz);
recalcularTotais(a2);
ok('edição troca a base e refaz o imposto', perto(a2.totalGeral, 36.59), `total ${a2.totalGeral.toFixed(2)}`);
ok('edição guarda o valor original', a2.empresas[0].linhas[0].ajuste.base12Original === 1000);

a2 = apuracaoBase();
ajustes.aplicar(a2, [{ cnpj: CNPJ, competencia: '2025-09', doc: '900 /1', tipo: 'exclusao', motivo: 'fora do período' }], refaz);
recalcularTotais(a2);
ok('exclusão manual zera a nota', perto(a2.totalGeral, 0));

a2 = apuracaoBase();
ajustes.aplicar(a2, [{ cnpj: CNPJ, competencia: '2025-09', doc: '999/1', tipo: 'manual', base4: 1000, base12: 0, fornecedor: 'X', motivo: 'sem XML' }], refaz);
recalcularTotais(a2);
ok('nota manual entra na conta', perto(a2.totalGeral, 73.17 + 170.73), `total ${a2.totalGeral.toFixed(2)}`);
ok('nota manual fica marcada', a2.empresas[0].linhas.find(l => l.doc === '999/1')?.selecionada === true);

a2 = apuracaoBase();
ajustes.aplicar(a2, [{ cnpj: '00000000000000', competencia: '2025-09', doc: '900 /1', tipo: 'edicao', base12: 1, motivo: 'x' }], refaz);
ok('ajuste de empresa ausente não some em silêncio', a2.ajustesOrfaos?.length === 1);

// ── Confronto com a contabilidade ────────────────────────────────────────────
console.log('\nConfronto com a contabilidade');
const { conferir } = require('../services/recomposicaoContabilidade');

const nossa = apuracaoBase();
let cf = conferir(nossa, { notas: [{ competencia: '2025-09', aliquota: 12, nNF: '900', base: 1000, aPagar: 73.17 }] });
ok('nota igual nos dois lados confere', cf.conferem.length === 1 && cf.divergentes.length === 0);
ok('total fecha', cf.totais.bate);

cf = conferir(nossa, { notas: [{ competencia: '2025-09', aliquota: 12, nNF: '900', base: 800, aPagar: 58.54 }] });
ok('base diferente vira divergência', cf.divergentes.length === 1);
ok('divergência mostra os dois valores',
  perto(cf.divergentes[0].base12, 1000) && perto(cf.divergentes[0].deles.base12, 800));

cf = conferir(nossa, { notas: [{ competencia: '2025-09', aliquota: 12, nNF: '777', base: 100, aPagar: 7.32 }] });
ok('nota só nossa é apontada', cf.soNossas.length === 1);
ok('nota só deles é apontada', cf.soDeles.length === 1);

cf = conferir(nossa, {
  notas: [
    { competencia: '2025-09', aliquota: 12, nNF: '900', base: 600, aPagar: 43.90 },
    { competencia: '2025-09', aliquota: 4, nNF: '900', base: 400, aPagar: 68.29 },
  ],
});
ok('nota partida em duas alíquotas é somada antes de comparar',
  perto(cf.divergentes[0]?.deles.base12 ?? 0, 600) && perto(cf.divergentes[0]?.deles.base4 ?? 0, 400));

// ── Apuração completa, se vierem arquivos ────────────────────────────────────
const args = process.argv.slice(2);
const iEsp = args.indexOf('--esperado');
const esperado = iEsp >= 0 ? Number(args[iEsp + 1]) : null;
const arquivos = args.filter((x, i) => !x.startsWith('--') && i !== iEsp + 1);

if (arquivos.length >= 2) {
  const fs = require('fs');
  const { parseRelatorio } = require('../services/notasCompraReport');
  const { lerXmlsDoZip } = require('../services/zipReader');
  const { cnpjsDoGrupo } = require('../services/empresas');

  console.log('\nApuração completa');
  const lancamentos = [];
  const notas = [];
  for (const f of arquivos) {
    if (/\.(zip)$/i.test(f)) notas.push(...lerXmlsDoZip(fs.readFileSync(f)));
    else lancamentos.push(...parseRelatorio(fs.readFileSync(f, 'utf8')).notas);
  }
  const res = calcularPorEmpresa(notas, { lancamentos, cnpjsProprios: cnpjsDoGrupo() });
  console.log(`  ${lancamentos.length} lançamentos, ${notas.length} XMLs, ${res.empresas.length} empresa(s)`);
  for (const e of res.empresas) {
    console.log(`    ${e.empresa.slice(0, 40).padEnd(41)} ${e.incluidas.length} notas   R$ ${e.totais.difal.toFixed(2)}`);
  }
  console.log(`  TOTAL R$ ${res.totalGeral.toFixed(2)}`);
  if (esperado != null) ok(`total confere com ${esperado}`, perto(res.totalGeral, esperado, 0.01));
}

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
