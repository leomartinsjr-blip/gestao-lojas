// Cálculo do diferencial de alíquota de ICMS sobre notas de entrada.
//
// A conta reproduz a planilha manual de Y:\ADMINISTRATIVO\≠ ICMS:
//   DIFAL = base_origem_4% × 0,1707 + base_origem_12% × 0,0732
//
// Os fatores saem da recomposição da base ("base dupla") com alíquota interna
// de MG a 18%:  fator = (1 − alq_origem) / (1 − 0,18) × 0,18 − alq_origem
// Só existem 4% e 12% porque, para um destinatário em MG, 7% nunca se aplica:
// 4% é mercadoria importada, 12% é todo o resto interestadual.

const ALIQ_INTERNA_PADRAO = 0.18;

// A planilha de recomposição (09-2025) calcula passo a passo e chega no fator
// sem arredondar, então é esse o padrão:
//   exclusão do ICMS interestadual → base × (1 − alq_origem)
//   inclusão do ICMS interno       → ÷ (1 − alq_interna)
//   débito − crédito               → × alq_interna − base × alq_origem
// FATORES_ARREDONDADOS reproduz as abas antigas (até 08-2025), que usavam
// 0,1707 e 0,0732 digitados na mão — útil para reconferir o histórico.
const FATORES_ARREDONDADOS = { 4: 0.1707, 12: 0.0732 };

function fatorExato(aliqOrigem, aliqInterna = ALIQ_INTERNA_PADRAO) {
  const a = aliqOrigem / 100;
  return (1 - a) / (1 - aliqInterna) * aliqInterna - a;
}

// ── CFOPs ────────────────────────────────────────────────────────────────────
// O CFOP vem na ótica de quem emitiu a nota (o fornecedor). Compra para revenda
// chega como venda dele.
const CFOP_COMPRA = new Set([
  '6101', '6102', '6103', '6104', '6105', '6106', '6107', '6108', '6109', '6110',
  '6113', '6114', '6115', '6116', '6117', '6118', '6119', '6120', '6122', '6123',
  // Material promocional entra: chega de outro estado para uso da empresa,
  // que é o caso clássico do diferencial.
  '5949', '6949',
]);

// CFOPs que entram no cálculo mas são genéricos demais para confiar no código
// sozinho — a linha sai calculada e marcada para conferência.
const CFOP_ATENCAO = {
  '5949': 'outra saída — confira a natureza da operação',
  '6949': 'outra saída — confira a natureza da operação',
};

// Fora do cálculo: devolução, bonificação/brinde, remessa, transferência,
// e venda com ST já retida pelo fornecedor.
const CFOP_EXCLUIDO = {
  '1202': 'devolução de venda',
  '2202': 'devolução de venda',
  '1201': 'devolução de venda',
  '2201': 'devolução de venda',
  '1411': 'devolução de venda com ST',
  '2411': 'devolução de venda com ST',
  '5910': 'bonificação / brinde',
  '6910': 'bonificação / brinde',
  '5911': 'amostra grátis',
  '6911': 'amostra grátis',
  '5912': 'remessa para demonstração',
  '6912': 'remessa para demonstração',
  '5915': 'remessa para conserto',
  '6915': 'remessa para conserto',
  '5152': 'transferência',
  '6152': 'transferência',
  '5151': 'transferência',
  '6151': 'transferência',
  '5409': 'transferência com ST',
  '6409': 'transferência com ST',
  '5403': 'venda com ST retida',
  '6403': 'venda com ST retida',
  '5405': 'venda com ST retida',
  '6404': 'venda com ST retida',
};

// CST/CSOSN em que o ICMS já foi retido por substituição tributária.
const CST_ST = new Set(['10', '30', '60', '70', '90']);
const CSOSN_ST = new Set(['201', '202', '203', '500']);

// ── Leitura do XML ───────────────────────────────────────────────────────────
// A NF-e tem estrutura fixa e previsível; um leitor por escopo de tag resolve
// sem trazer dependência nova para o projeto.

function _conteudo(xml, tag) {
  const abre = xml.indexOf(`<${tag}>`);
  if (abre === -1) return '';
  const fecha = xml.indexOf(`</${tag}>`, abre);
  if (fecha === -1) return '';
  return xml.slice(abre + tag.length + 2, fecha);
}

function _texto(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : '';
}

function _num(xml, tag) {
  const v = _texto(xml, tag);
  return v ? parseFloat(v) || 0 : 0;
}

function parseNFe(xmlString) {
  const inf = xmlString.slice(xmlString.indexOf('<infNFe'));
  const chave = (xmlString.match(/Id="NFe(\d{44})"/) || [])[1] || '';

  const ide = _conteudo(inf, 'ide');
  const emit = _conteudo(inf, 'emit');
  const dest = _conteudo(inf, 'dest');
  const icmsTot = _conteudo(inf, 'ICMSTot');

  const itens = [];
  const partes = inf.split('<det ').slice(1);
  for (const parte of partes) {
    const det = parte.slice(0, parte.indexOf('</det>'));
    const nItem = (parte.match(/^nItem="(\d+)"/) || [])[1] || '';
    const prod = _conteudo(det, 'prod');
    const imposto = _conteudo(det, 'imposto');
    const icms = _conteudo(imposto, 'ICMS');
    const ipi = _conteudo(imposto, 'IPI');

    // O grupo do ICMS (ICMS00, ICMS10, ICMSSN102, …) define o regime do item.
    const grupo = (icms.match(/<(ICMS(?:SN)?\d+|ICMSPart|ICMSST)>/) || [])[1] || '';

    itens.push({
      nItem,
      cProd: _texto(prod, 'cProd'),
      xProd: _texto(prod, 'xProd'),
      ncm: _texto(prod, 'NCM'),
      cfop: _texto(prod, 'CFOP'),
      vProd: _num(prod, 'vProd'),
      grupo,
      orig: _texto(icms, 'orig'),
      cst: _texto(icms, 'CST'),
      csosn: _texto(icms, 'CSOSN'),
      vBC: _num(icms, 'vBC'),
      pICMS: _num(icms, 'pICMS'),
      vICMS: _num(icms, 'vICMS'),
      vBCST: _num(icms, 'vBCST'),
      vICMSST: _num(icms, 'vICMSST'),
      vBCSTRet: _num(icms, 'vBCSTRet'),
      vICMSSTRet: _num(icms, 'vICMSSTRet'),
      vIPI: _num(ipi, 'vIPI'),
    });
  }

  return {
    chave,
    nNF: _texto(ide, 'nNF'),
    serie: _texto(ide, 'serie'),
    dhEmi: (_texto(ide, 'dhEmi') || _texto(ide, 'dEmi')).slice(0, 10),
    natOp: _texto(ide, 'natOp'),
    tpNF: _texto(ide, 'tpNF'),
    emit: {
      cnpj: _texto(emit, 'CNPJ'),
      nome: _texto(emit, 'xNome'),
      uf: _texto(_conteudo(emit, 'enderEmit'), 'UF'),
      crt: _texto(emit, 'CRT'),
    },
    dest: {
      cnpj: _texto(dest, 'CNPJ'),
      nome: _texto(dest, 'xNome'),
      uf: _texto(_conteudo(dest, 'enderDest'), 'UF'),
    },
    total: {
      vProd: _num(icmsTot, 'vProd'),
      vNF: _num(icmsTot, 'vNF'),
      vBC: _num(icmsTot, 'vBC'),
      vICMS: _num(icmsTot, 'vICMS'),
      vST: _num(icmsTot, 'vST'),
      vIPI: _num(icmsTot, 'vIPI'),
    },
    itens,
  };
}

// ── Classificação e cálculo ──────────────────────────────────────────────────

// Fornecedor do Simples não destaca ICMS: vem CSOSN e sem pICMS. Nesses casos a
// base entra como se a operação tivesse chegado a 12%.
function _isSimples(nfe, item) {
  return !!item.csosn || nfe.emit.crt === '1' || nfe.emit.crt === '2';
}

// Reproduz as colunas da planilha de recomposição para uma base e uma alíquota
// de origem. O ICMS a pagar é o mesmo que base × fator; o que muda é ver o
// caminho.
function _passos(base, aliqOrigem, aliqInterna) {
  const semInterestadual = base * (1 - aliqOrigem);
  const comInterno = semInterestadual / (1 - aliqInterna);
  const debito = comInterno * aliqInterna;
  const credito = base * aliqOrigem;
  return {
    base,
    exclusaoInterestadual: semInterestadual,
    inclusaoInterno: comInterno,
    debito,
    credito,
    aPagar: debito - credito,
  };
}

function _itemTemST(item) {
  if (item.vICMSST > 0 || item.vICMSSTRet > 0) return true;
  if (item.cst && CST_ST.has(item.cst)) return true;
  if (item.csosn && CSOSN_ST.has(item.csosn)) return true;
  return false;
}

/**
 * Calcula o diferencial de uma nota.
 * cfg: { ufDestino, aliqInterna, fatores, exatos }
 * Devolve as bases por alíquota de origem, o diferencial e o motivo de cada
 * item que ficou de fora — nada é descartado em silêncio.
 */
function calcularNota(nfe, cfg = {}) {
  const ufDestino = cfg.ufDestino || 'MG';
  const aliqInterna = cfg.aliqInterna != null ? cfg.aliqInterna : ALIQ_INTERNA_PADRAO;
  const fatores = cfg.fatores || {
    4: fatorExato(4, aliqInterna),
    12: fatorExato(12, aliqInterna),
  };

  const r = {
    chave: nfe.chave,
    nNF: nfe.nNF,
    serie: nfe.serie,
    doc: `${nfe.nNF} /${nfe.serie}`,
    dhEmi: nfe.dhEmi,
    natOp: nfe.natOp,
    fornecedor: nfe.emit.nome,
    cnpjFornecedor: nfe.emit.cnpj,
    ufOrigem: nfe.emit.uf,
    // Cada CNPJ é contribuinte próprio e apura o diferencial separado.
    cnpjEmpresa: nfe.dest.cnpj,
    empresa: nfe.dest.nome,
    vlrTotal: nfe.total.vNF,
    base4: 0,
    base12: 0,
    difal4: 0,
    difal12: 0,
    difal: 0,
    incluida: true,
    motivo: '',
    itensFora: [],
    itensST: [],
    revisar: [],
    atencao: [],
  };

  // Operação interna não gera diferencial.
  if (nfe.emit.uf === ufDestino) {
    r.incluida = false;
    r.motivo = `operação interna (${ufDestino} → ${ufDestino})`;
    return r;
  }

  for (const item of nfe.itens) {
    const ref = `item ${item.nItem} (${item.xProd.slice(0, 30)})`;

    if (CFOP_EXCLUIDO[item.cfop]) {
      r.itensFora.push({ ref, cfop: item.cfop, motivo: CFOP_EXCLUIDO[item.cfop], valor: item.vProd });
      continue;
    }
    if (_itemTemST(item)) {
      // Guarda os campos da seção "ITENS COM ST EM MINAS GERAIS" da planilha.
      r.itensST.push({
        ref,
        cfop: item.cfop,
        ncm: item.ncm,
        baseIcmsNormal: item.vBC,
        icmsInterestadual: item.vICMS,
        ipi: item.vIPI,
        baseIcmsST: item.vBCST || item.vBCSTRet,
        valorST: item.vICMSST || item.vICMSSTRet,
        valor: item.vProd,
      });
      r.itensFora.push({ ref, cfop: item.cfop, motivo: 'ICMS-ST retido pelo fornecedor', valor: item.vProd });
      continue;
    }
    if (!CFOP_COMPRA.has(item.cfop)) {
      // CFOP que não conheço: entra na lista de revisão em vez de virar número.
      r.revisar.push({ ref, cfop: item.cfop, motivo: 'CFOP não classificado', valor: item.vProd });
      continue;
    }

    if (CFOP_ATENCAO[item.cfop]) {
      r.atencao.push({ ref, cfop: item.cfop, motivo: CFOP_ATENCAO[item.cfop], valor: item.vProd });
    }

    if (_isSimples(nfe, item)) {
      // Sem ICMS destacado: usa o valor do produto como base, a 12%.
      r.base12 += item.vBC || item.vProd;
      continue;
    }

    const aliq = Math.round(item.pICMS);
    if (aliq === 4) r.base4 += item.vBC;
    else if (aliq === 12) r.base12 += item.vBC;
    else if (aliq === 0 && item.vBC === 0) {
      r.itensFora.push({ ref, cfop: item.cfop, motivo: 'sem ICMS destacado', valor: item.vProd });
    } else {
      r.revisar.push({ ref, cfop: item.cfop, motivo: `alíquota de origem inesperada (${item.pICMS}%)`, valor: item.vProd });
    }
  }

  // Passos intermediários no formato da planilha de recomposição, para o
  // resultado poder ser conferido linha a linha contra ela.
  r.passos = {
    4: _passos(r.base4, 0.04, aliqInterna),
    12: _passos(r.base12, 0.12, aliqInterna),
  };
  r.difal4 = r.base4 * fatores[4];
  r.difal12 = r.base12 * fatores[12];
  r.difal = r.difal4 + r.difal12;

  if (r.base4 === 0 && r.base12 === 0) {
    r.incluida = false;
    r.motivo = r.itensFora.length
      ? [...new Set(r.itensFora.map(i => i.motivo))].join('; ')
      : 'nenhum item tributável';
  }

  return r;
}

/**
 * Calcula um lote de notas já casadas com o lançamento no Microvix.
 * notas: [{ xml, dtLancamento }]
 */
function calcularLote(notas, cfg = {}) {
  const linhas = notas.map(n => {
    const nfe = typeof n.xml === 'string' ? parseNFe(n.xml) : n.xml;
    const linha = calcularNota(nfe, cfg);
    linha.dtLancamento = n.dtLancamento || null;
    return linha;
  });

  const incluidas = linhas.filter(l => l.incluida);
  return {
    linhas,
    incluidas,
    excluidas: linhas.filter(l => !l.incluida),
    revisar: linhas.filter(l => l.revisar.length),
    atencao: linhas.filter(l => l.atencao.length),
    totais: {
      base4: incluidas.reduce((s, l) => s + l.base4, 0),
      base12: incluidas.reduce((s, l) => s + l.base12, 0),
      difal: incluidas.reduce((s, l) => s + l.difal, 0),
    },
  };
}

// "11683593 /0" e "11683593/0" e "011683593/00" são o mesmo documento.
function chaveDoc(nNF, serie) {
  const n = String(nNF).replace(/\D/g, '').replace(/^0+/, '');
  const s = String(serie).replace(/\D/g, '').replace(/^0+/, '') || '0';
  return `${n}/${s}`;
}

/**
 * Apura por empresa. Cada CNPJ é contribuinte próprio, então o resultado sai
 * separado por destinatário, com o total geral apenas como soma de conferência.
 *
 * notas: [{ xml, dtLancamento }] — pode misturar lotes de CNPJs diferentes.
 *
 * cfg.cnpjsProprios: se informado, notas endereçadas a outro CNPJ são
 *   ignoradas (protege contra XML de saída cair no meio do lote).
 *
 * cfg.lancamentos: a lista de notas que realmente deram entrada no sistema,
 *   vinda do Microvix — [{ nNF, serie, dtLancamento }]. É o filtro que separa
 *   o que foi lançado do que foi recusado e devolvido ao fornecedor. Sem ela,
 *   o XML sozinho não tem como saber a diferença, então todas entram.
 */
function calcularPorEmpresa(notas, cfg = {}) {
  const proprios = cfg.cnpjsProprios
    ? new Set(cfg.cnpjsProprios.map(c => String(c).replace(/\D/g, '')))
    : null;

  // Um relatório com várias empresas pode trazer o mesmo número/série duas
  // vezes — acontece nas transferências internas, que cada empresa numera por
  // conta própria. Por isso o índice guarda uma lista, não um único registro.
  let lancados = null;
  if (cfg.lancamentos) {
    lancados = new Map();
    cfg.lancamentos.forEach((l, i) => {
      const k = chaveDoc(l.nNF, l.serie);
      if (!lancados.has(k)) lancados.set(k, []);
      lancados.get(k).push({ ...l, _i: i });
    });
  }
  const casados = new Set();   // índices já consumidos

  // Com mais de um candidato, o valor da nota desempata; o nome do fornecedor
  // é o segundo critério. Nada disso decide sozinho: o que sobrar ambíguo sai
  // sinalizado em vez de virar número calado.
  function escolherLancamento(candidatos, nfe) {
    const livres = candidatos.filter(c => !casados.has(c._i));
    const lista = livres.length ? livres : candidatos;
    if (lista.length === 1) return { lanc: lista[0], ambiguo: false };

    const porValor = lista.filter(c => Math.abs((c.vlrTotal || 0) - nfe.total.vNF) < 0.02);
    if (porValor.length === 1) return { lanc: porValor[0], ambiguo: false };

    const emit = (nfe.emit.nome || '').toUpperCase().slice(0, 12);
    const porNome = (porValor.length ? porValor : lista)
      .filter(c => (c.fornecedor || '').toUpperCase().startsWith(emit.slice(0, 8)));
    if (porNome.length === 1) return { lanc: porNome[0], ambiguo: false };

    return { lanc: (porValor[0] || lista[0]), ambiguo: true };
  }

  const vistas = new Set();
  const ignoradas = [];
  const porCnpj = new Map();

  for (const n of notas) {
    const nfe = typeof n.xml === 'string' ? parseNFe(n.xml) : n.xml;

    // O mesmo XML costuma vir repetido entre downloads; a chave desempata.
    if (nfe.chave && vistas.has(nfe.chave)) continue;
    if (nfe.chave) vistas.add(nfe.chave);

    const cnpj = nfe.dest.cnpj;
    if (proprios && !proprios.has(cnpj)) {
      ignoradas.push({ doc: `${nfe.nNF} /${nfe.serie}`, cnpjDest: cnpj, motivo: 'destinatário não é empresa do grupo' });
      continue;
    }

    if (!porCnpj.has(cnpj)) {
      porCnpj.set(cnpj, { cnpj, empresa: nfe.dest.nome, linhas: [] });
    }

    const doc = chaveDoc(nfe.nNF, nfe.serie);
    const candidatos = lancados ? lancados.get(doc) : null;
    const escolha = candidatos && candidatos.length ? escolherLancamento(candidatos, nfe) : null;
    const lanc = escolha ? escolha.lanc : null;

    const linha = calcularNota(nfe, cfg);
    linha.dtLancamento = (lanc && lanc.dtLancamento) || n.dtLancamento || null;

    // Nota sem lançamento correspondente não gera imposto: ou foi recusada e
    // devolvida ao fornecedor, ou ainda não foi importada.
    if (lancados && !lanc) {
      linha.incluida = false;
      // O que se sabe com certeza é só que a nota não está no relatório do
      // período. Pode ter sido recusada, pode ter sido lançada em outro mês.
      // Afirmar "recusada" seria ir além do dado.
      linha.motivo = cfg.competencia && linha.dhEmi && !linha.dhEmi.startsWith(cfg.competencia)
        ? `não consta no relatório do período (emitida em ${linha.dhEmi.slice(5, 7)}/${linha.dhEmi.slice(0, 4)})`
        : 'não consta no relatório de lançamentos do período';
      linha.base4 = 0;
      linha.base12 = 0;
      linha.difal4 = 0;
      linha.difal12 = 0;
      linha.difal = 0;
    } else if (lanc) {
      casados.add(lanc._i);
      if (escolha.ambiguo) {
        linha.revisar.push({
          ref: `nota ${linha.doc}`,
          cfop: '',
          motivo: 'mais de um lançamento com este número/série — confira a qual empresa pertence',
          valor: linha.vlrTotal,
        });
      }
      // Com relatórios de mais de um mês no lote, o lançamento é que define a
      // competência — não a presença da nota na lista.
      if (cfg.competencia && lanc.dtLancamento && !lanc.dtLancamento.startsWith(cfg.competencia)) {
        const [ano, mes] = lanc.dtLancamento.split('-');
        linha.incluida = false;
        linha.motivo = `lançada em ${mes}/${ano}, fora da competência`;
        linha.base4 = 0;
        linha.base12 = 0;
        linha.difal4 = 0;
        linha.difal12 = 0;
        linha.difal = 0;
      }
    }

    porCnpj.get(cnpj).linhas.push(linha);
  }

  // Lançado no Microvix mas sem XML no lote. Em geral é imposto que ninguém
  // calculou e precisa aparecer — mas transferência entre lojas do grupo é
  // operação interna de MG, não gera diferencial, e o XML nem passa pela tela
  // de entrada de NF-e. Sem essa distinção o alerta gritaria toda competência.
  const semXml = lancados
    ? [...lancados.values()].flat()
        .filter(l => !casados.has(l._i))
        .map(l => {
          const doc = chaveDoc(l.nNF, l.serie);
          const interna = /TRANSFER/i.test(l.natOp || '');
          return {
            doc,
            ...l,
            relevante: !interna,
            observacao: interna
              ? 'transferência entre empresas do grupo — não gera diferencial'
              : 'lançada no sistema mas sem XML no lote',
          };
        })
    : [];

  const empresas = [...porCnpj.values()].map(e => {
    const incluidas = e.linhas.filter(l => l.incluida);
    const base4 = incluidas.reduce((s, l) => s + l.base4, 0);
    const base12 = incluidas.reduce((s, l) => s + l.base12, 0);
    const aliqInterna = cfg.aliqInterna != null ? cfg.aliqInterna : ALIQ_INTERNA_PADRAO;
    return {
      ...e,
      incluidas,
      excluidas: e.linhas.filter(l => !l.incluida),
      revisar: e.linhas.filter(l => l.revisar.length),
      atencao: e.linhas.filter(l => l.atencao.length),
      itensST: e.linhas.flatMap(l => l.itensST.map(i => ({ ...i, doc: l.doc, fornecedor: l.fornecedor }))),
      totais: {
        base4,
        base12,
        passos: { 4: _passos(base4, 0.04, aliqInterna), 12: _passos(base12, 0.12, aliqInterna) },
        difal: incluidas.reduce((s, l) => s + l.difal, 0),
      },
    };
  }).sort((a, b) => a.empresa.localeCompare(b.empresa));

  return {
    empresas,
    ignoradas,
    semXml,
    totalGeral: empresas.reduce((s, e) => s + e.totais.difal, 0),
  };
}

module.exports = {
  parseNFe,
  calcularNota,
  calcularLote,
  calcularPorEmpresa,
  chaveDoc,
  fatorExato,
  FATORES_ARREDONDADOS,
  ALIQ_INTERNA_PADRAO,
  CFOP_COMPRA,
  CFOP_EXCLUIDO,
  CFOP_ATENCAO,
};
