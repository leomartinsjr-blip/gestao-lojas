'use strict';
// Excel da DRE/Resultados com cara de relatório. A tela manda as tabelas já montadas:
// abas: [{ nome, titulo, subtitulo, colunas: [rótulo], linhas: [{ tipo, rotulo, valores: [{ v, p }] }] }]
// tipo: total (subtotal em destaque), item ou sub (detalhe aberto na tela).

const ExcelJS = require('exceljs');

const AZUL = 'FF1F3A5F', CINZA = 'FFE4EAF2', FAIXA = 'FFF8FAFC', BORDA = 'FFD0D7DE';
const NUM = '#,##0.00;[Red]-#,##0.00;"-"', PCT = '0.00%;[Red]-0.00%;"-"';
const preenche = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function montarAba(wb, aba) {
  const ws = wb.addWorksheet(String(aba.nome || 'Aba').slice(0, 31), {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
  });
  const colunas = aba.colunas || [];
  const comPct = colunas.map((_, i) => (aba.linhas || []).some(l => l.valores?.[i]?.p != null));
  const posicao = [];
  let c = 2;
  for (let i = 0; i < colunas.length; i++) { posicao.push(c); c += comPct[i] ? 2 : 1; }
  const ultima = c - 1;

  ws.getColumn(1).width = 34;
  ws.getCell('A1').value = aba.titulo || aba.nome;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
  ws.getCell('A2').value = aba.subtitulo || '';
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF636C76' } };

  const cab = ws.getRow(4);
  cab.height = 20;
  cab.getCell(1).value = 'Linha';
  colunas.forEach((nome, i) => {
    const col = posicao[i];
    ws.getColumn(col).width = 14;
    cab.getCell(col).value = nome;
    if (comPct[i]) {
      ws.getColumn(col + 1).width = 8;
      cab.getCell(col + 1).value = '%';
    }
  });
  for (let k = 1; k <= ultima; k++) {
    const cel = cab.getCell(k);
    cel.fill = preenche(AZUL);
    cel.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cel.alignment = { horizontal: k === 1 ? 'left' : 'right', vertical: 'middle' };
  }

  (aba.linhas || []).forEach((l, n) => {
    const row = ws.getRow(5 + n);
    const total = l.tipo === 'total', sub = l.tipo === 'sub', grupo = l.tipo === 'grupo';
    row.getCell(1).value = l.rotulo;
    row.getCell(1).alignment = { indent: sub ? 3 : total || grupo ? 0 : 1 };
    (l.valores || []).forEach((x, i) => {
      const cel = row.getCell(posicao[i]);
      if (x.v === 'falta') {
        cel.value = 'falta';
        cel.alignment = { horizontal: 'right' };
        cel.font = { italic: true, color: { argb: 'FF9A6700' } };
      } else if (typeof x.v === 'number') {
        cel.value = x.v;
        cel.numFmt = NUM;
      }
      if (comPct[i] && x.p != null) {
        const p = row.getCell(posicao[i] + 1);
        p.value = x.p / 100;
        p.numFmt = PCT;
      }
    });
    for (let k = 1; k <= ultima; k++) {
      const cel = row.getCell(k);
      if (grupo) {
        cel.fill = preenche('FFDDF4FF');
        cel.font = { ...(cel.font || {}), bold: true, color: { argb: AZUL } };
      } else if (total) {
        cel.fill = preenche(CINZA);
        cel.font = { ...(cel.font || {}), bold: true };
        cel.border = { top: { style: 'thin', color: { argb: 'FF8C959F' } } };
      } else {
        if (n % 2) cel.fill = preenche(FAIXA);
        cel.border = { bottom: { style: 'hair', color: { argb: BORDA } } };
        if (sub) cel.font = { ...(cel.font || {}), size: 9, color: { argb: 'FF636C76' } };
      }
    }
  });
  ws.pageSetup.printTitlesRow = '4:4';
}

async function gerarExcel(abas) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gestão';
  for (const aba of abas) montarAba(wb, aba);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { gerarExcel };
