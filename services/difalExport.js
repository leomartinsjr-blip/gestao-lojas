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

function _moeda(cell) {
  cell.numFmt = '#,##0.0000';
  cell.alignment = { horizontal: 'right' };
}

function _blocoAliquota(ws, linha, titulo, notas, passosTotais, campoBase) {
  _titulo(ws, linha, titulo);
  linha++;

  _cabecalho(ws, linha, ['NOTA FISCAL', 'VALOR PRODUTO', 'EXCLUSÃO ICMS INTEREST.',
    'INCLUSÃO ICMS INTERNO', 'DÉBITO TRIBUTÁRIO', 'CRÉDITO TRIBUTÁRIO', 'ICMS A PAGAR']);
  linha++;

  for (const n of notas) {
    const p = n.passos[campoBase];
    ws.getCell(linha, 1).value = n.nNF;
    [p.base, p.exclusaoInterestadual, p.inclusaoInterno, p.debito, p.credito, p.aPagar]
      .forEach((v, i) => { const c = ws.getCell(linha, i + 2); c.value = v; _moeda(c); });
    linha++;
  }

  const c1 = ws.getCell(linha, 1);
  c1.value = 'TOTAL GERAL';
  c1.font = { bold: true };
  [passosTotais.base, passosTotais.exclusaoInterestadual, passosTotais.inclusaoInterno,
    passosTotais.debito, passosTotais.credito, passosTotais.aPagar]
    .forEach((v, i) => {
      const c = ws.getCell(linha, i + 2);
      c.value = v;
      c.font = { bold: true };
      _moeda(c);
    });
  return linha + 2;
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
    ws.columns = [
      { width: 16 }, { width: 15 }, { width: 16 }, { width: 16 },
      { width: 15 }, { width: 15 }, { width: 14 },
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

    const notas12 = emp.incluidas.filter(n => n.base12 > 0).sort(porLancamento);
    const notas4 = emp.incluidas.filter(n => n.base4 > 0).sort(porLancamento);

    if (notas12.length) {
      linha = _blocoAliquota(ws, linha, 'QUANDO ALÍQUOTA INTERESTADUAL 12%', notas12, emp.totais.passos[12], 12);
    }
    if (notas4.length) {
      linha = _blocoAliquota(ws, linha, 'QUANDO ALÍQUOTA INTERESTADUAL 4%', notas4, emp.totais.passos[4], 4);
    }

    // Total da empresa
    ws.mergeCells(linha, 1, linha, 5);
    const ct = ws.getCell(linha, 1);
    ct.value = 'VALOR TOTAL A PAGAR';
    ct.font = { bold: true, size: 11 };
    ct.alignment = { horizontal: 'right' };
    const cv = ws.getCell(linha, 7);
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
      _moeda(cv2);
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
      ws.getCell(l, 2).value = a.dtLancamento;
      ws.getCell(l, 3).value = a.fornecedor;
      const c = ws.getCell(l, 4);
      c.value = a.vlrTotal;
      _moeda(c);
      ws.getCell(l, 5).value = a.observacao;
    });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { gerarXlsx };
