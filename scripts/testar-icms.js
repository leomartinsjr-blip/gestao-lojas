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
  if (it.csosn) return `<ICMSSN102><orig>0</orig><CSOSN>${it.csosn}</CSOSN></ICMSSN102>`;
  if (it.cst === '60') {
    return `<ICMS60><orig>0</orig><CST>60</CST><vBCSTRet>${it.vBC}</vBCSTRet>` +
      `<vICMSSTRet>${(it.vBC * 0.18).toFixed(2)}</vICMSSTRet></ICMS60>`;
  }
  return `<ICMS00><orig>${it.orig || 0}</orig><CST>00</CST><vBC>${it.vBC}</vBC>` +
    `<pICMS>${it.pICMS}</pICMS><vICMS>${(it.vBC * it.pICMS / 100).toFixed(2)}</vICMS></ICMS00>`;
}

function nfe({ nNF = '1', serie = '1', uf = 'SP', crt = '3', natOp = 'VENDA', dhEmi = '2025-09-10', itens = [] }) {
  const chave = String(nNF).padStart(9, '0').repeat(5).slice(0, 44);
  const dets = itens.map((it, i) => `
    <det nItem="${i + 1}">
      <prod><cProd>P${i}</cProd><xProd>PRODUTO ${i}</xProd><NCM>${it.ncm || '61091000'}</NCM>
        <CFOP>${it.cfop}</CFOP><vProd>${it.vBC}</vProd></prod>
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
