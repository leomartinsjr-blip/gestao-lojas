// Gera o xlsx da apuração no layout da planilha de recomposição que o
// escritório já usa: um bloco por alíquota de origem, com os passos visíveis,
// mais as seções de itens com ST e de notas que ficaram fora.
//
// Uma aba por CNPJ, porque cada empresa apura e recolhe separado.

const ExcelJS = require('exceljs');
const { buscarEmpresa, formatarCnpj } = require('./empresas');

const CINZA = 'FFE8E8E8';
const AMARELO = 'FFFFF2CC';

function _titulo(ws, linha, texto, colunas = 7) {
  ws.mergeCells(linha, 1, linha, colunas);
  const c = ws.getCell(linha, 1);
  c.value = texto;
  c.font = { bold: true, size: 11 };
  c.alignment = { horizontal: 'center' };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CINZA } };
}

function _cabecalho(ws, linha, colunas) {
  colunas.forEach((t, i) => {
    const c = ws.getCell(linha, i + 1);
    c.value = t;
    c.font = { bold: true, size: 10 };
    c.alignment = { horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin' } };
  });
}

// Base e imposto saem com duas casas, como qualquer valor em real. As quatro
// casas vinham da planilha manual, onde eram só o resíduo da conta feita à mão.
function _num(cell) {
  cell.numFmt = '#,##0.00';
  cell.alignment = { horizontal: 'right' };
}

function _moeda(cell) {
  cell.numFmt = 'R$ #,##0.00';
  cell.alignment = { horizontal: 'right' };
}

// Data em célula de data de verdade, para o Excel poder ordenar e filtrar.
function _data(cell, iso) {
  if (!iso) return;
  cell.value = new Date(`${iso}T00:00:00Z`);
  cell.numFmt = 'dd/mm/yyyy';
  cell.alignment = { horizontal: 'center' };
}

const COLUNAS_NOTA = ['DOC/SÉRIE', 'EMISSÃO', 'LÇTO', 'FORNECEDOR', 'UF', 'VLR.TOTAL',
  'BASE 4%', 'BASE 12%', 'DIFAL 4%', 'DIFAL 12%', 'TOTAL'];

// Uma linha por nota, com as duas alíquotas lado a lado — o formato das
// planilhas antigas de Y:\ADMINISTRATIVO\≠ ICMS.
function _tabelaNotas(ws, linha, notas, totais) {
  _cabecalho(ws, linha, COLUNAS_NOTA);
  linha++;

  for (const n of notas) {
    const d4 = n.passos[4].aPagar;
    const d12 = n.passos[12].aPagar;
    ws.getCell(linha, 1).value = n.doc;
    _data(ws.getCell(linha, 2), n.dhEmi);
    _data(ws.getCell(linha, 3), n.dtLancamento);
    ws.getCell(linha, 4).value = n.fornecedor;
    ws.getCell(linha, 5).value = n.ufOrigem;
    [n.vlrTotal, n.base4 || null, n.base12 || null, d4 || null, d12 || null, d4 + d12]
      .forEach((v, i) => { const c = ws.getCell(linha, i + 6); if (v != null) { c.value = v; _num(c); } });
    linha++;
  }

  const c1 = ws.getCell(linha, 1);
  c1.value = 'TOTAL';
  c1.font = { bold: true };
  [null, null, null, null,
    totais.base4 + totais.base12, totais.base4, totais.base12,
    totais.passos[4].aPagar, totais.passos[12].aPagar, totais.difal]
    .forEach((v, i) => {
      if (v == null) return;
      const c = ws.getCell(linha, i + 2);
      c.value = v;
      c.font = { bold: true };
      _num(c);
    });
  return linha + 2;
}

// O caminho da recomposição fica num quadro de resumo, em vez de repetir os
// cinco passos em cada linha de nota.
function _quadroRecomposicao(ws, linha, totais) {
  _titulo(ws, linha, 'RECOMPOSIÇÃO DA BASE', 7);
  linha++;
  _cabecalho(ws, linha, ['ALÍQ. ORIGEM', 'BASE', 'EXCLUSÃO ICMS INTEREST.',
    'INCLUSÃO ICMS INTERNO', 'DÉBITO TRIBUTÁRIO', 'CRÉDITO TRIBUTÁRIO', 'ICMS A PAGAR']);
  linha++;

  for (const aliq of [4, 12]) {
    const p = totais.passos[aliq];
    if (!p.base) continue;
    ws.getCell(linha, 1).value = `${aliq}%`;
    [p.base, p.exclusaoInterestadual, p.inclusaoInterno, p.debito, p.credito, p.aPagar]
      .forEach((v, i) => { const c = ws.getCell(linha, i + 2); c.value = v; _num(c); });
    linha++;
  }
  return linha + 1;
}

/**
 * resultado: saída de calcularPorEmpresa
 * meta: { competencia: '09/2025' }
 */
async function gerarXlsx(resultado, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'gestao-lojas';
  wb.created = new Date();

  for (const emp of resultado.empresas) {
    const cadastro = buscarEmpresa(emp.cnpj);
    const nomeAba = (cadastro ? cadastro.aba || cadastro.apelido : emp.cnpj).slice(0, 31);
    const ws = wb.addWorksheet(nomeAba);
    // A coluna 5 é UF na tabela de notas, mas é "DÉBITO TRIBUTÁRIO" no quadro
    // de recomposição logo abaixo — por isso ela é larga apesar de caber "SP".
    ws.columns = [
      { width: 15 }, { width: 12 }, { width: 12 }, { width: 34 }, { width: 16 },
      { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 },
    ];

    let linha = 1;
    ws.getCell(linha, 1).value = cadastro ? cadastro.razaoSocial : emp.empresa;
    ws.getCell(linha, 1).font = { bold: true, size: 12 };
    linha++;
    ws.getCell(linha, 1).value = `CNPJ ${formatarCnpj(emp.cnpj)}` +
      (cadastro && cadastro.ie ? `   IE ${cadastro.ie}` : '') +
      (meta.competencia ? `   —   competência ${meta.competencia}` : '');
    linha += 2;

    ws.getCell(linha, 1).value = 'Base de cálculo lida do XML de cada nota. Só entram notas com lançamento no Microvix.';
    ws.getCell(linha, 1).font = { italic: true, size: 9 };
    linha += 2;

    // Ordem de lançamento, como na planilha manual.
    const porLancamento = (a, b) =>
      String(a.dtLancamento || a.dhEmi).localeCompare(String(b.dtLancamento || b.dhEmi)) ||
      String(a.nNF).localeCompare(String(b.nNF));

    const notas = emp.incluidas
      .filter(n => n.base4 > 0 || n.base12 > 0)
      .sort(porLancamento);

    linha = _tabelaNotas(ws, linha, notas, emp.totais);
    linha = _quadroRecomposicao(ws, linha, emp.totais);

    // Total da empresa
    ws.mergeCells(linha, 1, linha, 9);
    const ct = ws.getCell(linha, 1);
    ct.value = 'VALOR TOTAL A PAGAR';
    ct.font = { bold: true, size: 11 };
    ct.alignment = { horizontal: 'right' };
    const cv = ws.getCell(linha, 11);
    cv.value = emp.totais.difal;
    cv.font = { bold: true, size: 11 };
    cv.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMARELO } };
    _moeda(cv);
    linha += 3;

    // ── Itens com ST ─────────────────────────────────────────────────────────
    _titulo(ws, linha, 'ITENS COM ST EM MINAS GERAIS');
    linha++;
    _cabecalho(ws, linha, ['NOTA FISCAL', 'NCM', 'BASE ICMS NORMAL',
      'ICMS INTERESTADUAL', 'IPI', 'BASE ICMS ST', 'VALOR ST']);
    linha++;
    if (emp.itensST.length) {
      for (const it of emp.itensST) {
        ws.getCell(linha, 1).value = it.doc;
        ws.getCell(linha, 2).value = it.ncm;
        [it.baseIcmsNormal, it.icmsInterestadual, it.ipi, it.baseIcmsST, it.valorST]
          .forEach((v, i) => { const c = ws.getCell(linha, i + 3); c.value = v; _moeda(c); });
        linha++;
      }
    } else {
      ws.getCell(linha, 1).value = 'nenhum';
      ws.getCell(linha, 1).font = { italic: true, size: 9 };
      linha++;
    }
    linha += 2;

    // ── Notas fora do cálculo ────────────────────────────────────────────────
    _titulo(ws, linha, 'NOTAS QUE NÃO ENTRARAM NO CÁLCULO');
    linha++;
    _cabecalho(ws, linha, ['NOTA FISCAL', 'FORNECEDOR', 'UF', 'NATUREZA DE OPERAÇÃO',
      'VALOR', 'MOTIVO', '']);
    linha++;
    for (const n of [...emp.excluidas].sort((a, b) => a.motivo.localeCompare(b.motivo) || String(a.nNF).localeCompare(String(b.nNF)))) {
      ws.getCell(linha, 1).value = n.doc;
      ws.getCell(linha, 2).value = n.fornecedor;
      ws.getCell(linha, 3).value = n.ufOrigem;
      ws.getCell(linha, 4).value = n.natOp;
      const cv2 = ws.getCell(linha, 5);
      cv2.value = n.vlrTotal;
      _num(cv2);
      ws.getCell(linha, 6).value = n.motivo;
      linha++;
    }
    linha += 2;

    // ── Conferir ─────────────────────────────────────────────────────────────
    const paraConferir = [
      ...emp.atencao.flatMap(l => l.atencao.map(a => ({ doc: l.doc, texto: a.motivo, cfop: a.cfop }))),
      ...emp.revisar.flatMap(l => l.revisar.map(a => ({ doc: l.doc, texto: a.motivo, cfop: a.cfop }))),
    ];
    if (paraConferir.length) {
      _titulo(ws, linha, 'CONFERIR');
      linha++;
      _cabecalho(ws, linha, ['NOTA FISCAL', 'CFOP', 'OBSERVAÇÃO', '', '', '', '']);
      linha++;
      for (const c of paraConferir) {
        ws.getCell(linha, 1).value = c.doc;
        ws.getCell(linha, 2).value = c.cfop;
        ws.getCell(linha, 3).value = c.texto;
        linha++;
      }
    }
  }

  // ── Aba de alertas, se houver ──────────────────────────────────────────────
  const alertas = (resultado.semXml || []).filter(x => x.relevante);
  if (alertas.length) {
    const ws = wb.addWorksheet('Sem XML');
    ws.columns = [{ width: 16 }, { width: 14 }, { width: 40 }, { width: 14 }, { width: 40 }];
    _cabecalho(ws, 1, ['NOTA FISCAL', 'LANÇAMENTO', 'FORNECEDOR', 'VALOR', 'OBSERVAÇÃO']);
    alertas.forEach((a, i) => {
      const l = i + 2;
      ws.getCell(l, 1).value = a.doc;
      _data(ws.getCell(l, 2), a.dtLancamento);
      ws.getCell(l, 3).value = a.fornecedor;
      const c = ws.getCell(l, 4);
      c.value = a.vlrTotal;
      _num(c);
      ws.getCell(l, 5).value = a.observacao;
    });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { gerarXlsx };
