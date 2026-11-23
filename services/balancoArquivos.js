// Arquivos do balanço: Lista de Críticas (PDF, no layout do Microvix) e a
// planilha de recontagem no modelo do escritório (abas RECONTAGEM e
// RESUMO GERAL, com as mesmas fórmulas, cores e impressão).

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { itensRecontagem, naoCadastradosDe, NAO_CADASTRADO, grupoCurto, statusItem, abatimentos } = require('./balanco');

const fmtInt = n => {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('pt-BR');
  return v < 0 ? `(${s})` : s;
};
const fmtMoeda = n => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const dataBR = iso => String(iso || '').split('-').reverse().join('/');

// ── PDF: Lista de Críticas ─────────────────────────────────────────────────
function pdfListaCriticas(bal, { lojaLabel }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 28, bufferPages: true,
      info: { Title: `Lista de Críticas — ${lojaLabel} ${dataBR(bal.data)}` } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 28, W = 595.28 - 56;
    const cols = [
      { k: 'c', t: 'Código', w: 44 },
      { k: 'b', t: 'Cód. Barras', w: 50 },
      { k: 'd', t: 'Descrição', w: 186 },
      { k: 'r', t: 'Referência', w: 72 },
      { k: 'e', t: 'Qtde Estoque', w: 46, n: true },
      { k: 'l', t: 'Qtde Balanço', w: 46, n: true },
      { k: 'dif', t: 'Diferença', w: 44, n: true },
      { k: 'val', t: 'Pr.Venda $', w: 51, n: true },
    ];
    const X = []; cols.reduce((x, c) => { X.push(x); return x + c.w; }, L);
    const RH = 11, FIM = 841.89 - 40;
    const cinza = '#555', escuro = '#222';
    const quando = `${dataBR(bal.data)}${bal.hora ? ' ' + bal.hora + ' h' : ''}`;

    let y = 0;
    function cabecalhoPagina() {
      y = 24;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(escuro).text(lojaLabel.toUpperCase(), L, y, { width: 180 });
      doc.font('Helvetica').fillColor(cinza).text(`Usuário: ${bal.criadoPor || ''}`, L + 190, y, { width: 160 });
      doc.text(quando, L + 360, y, { width: 100 });
      doc.font('Helvetica-Bold').fillColor(escuro).text('Gestão de Lojas', L + W - 80, y, { width: 80, align: 'right' });
      y += 12;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#bbb').stroke();
      y += 6;
    }
    // Corta no tamanho da coluna — o lineBreak:false do pdfkit não corta sozinho
    function cabe(txt, w) {
      let t = String(txt ?? '');
      if (doc.widthOfString(t) <= w - 2) return t;
      while (t.length && doc.widthOfString(t + '…') > w - 2) t = t.slice(0, -1);
      return t + '…';
    }
    function cabecalhoColunas() {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(escuro);
      cols.forEach((c, i) => doc.text(c.t, X[i] + 2, y, { width: c.w - 4, align: c.n ? 'right' : 'left' }));
      y += RH * 2;
    }
    function garante(h, comColunas = true) {
      if (y + h <= FIM) return;
      doc.addPage(); cabecalhoPagina(); if (comColunas) cabecalhoColunas();
    }
    function linha(it) {
      garante(RH);
      const dif = it.l - it.e;
      const v = { c: it.c, b: it.b, d: it.d, r: it.r, e: fmtInt(it.e), l: fmtInt(it.l), dif: fmtInt(dif), val: fmtMoeda(dif * it.p) };
      doc.font('Helvetica').fontSize(7).fillColor(dif ? escuro : cinza);
      cols.forEach((c, i) => doc.text(cabe(v[c.k], c.w - 4), X[i] + 2, y + 1, { width: c.w - 4, align: c.n ? 'right' : 'left', lineBreak: false }));
      y += RH;
    }
    function totais(lista, rotulo) {
      garante(RH + 6);
      y += 3;
      const t = lista.reduce((a, it) => { a.e += it.e; a.l += it.l; a.val += (it.l - it.e) * it.p; return a; }, { e: 0, l: 0, val: 0 });
      doc.font('Helvetica-Bold').fontSize(7).fillColor(escuro);
      if (rotulo) doc.text(rotulo, X[2] + 2, y, { width: cols[2].w + cols[3].w - 4, lineBreak: false });
      [[4, fmtInt(t.e)], [5, fmtInt(t.l)], [6, fmtInt(t.l - t.e)], [7, fmtMoeda(t.val)]]
        .forEach(([i, s]) => doc.text(s, X[i] + 2, y, { width: cols[i].w - 4, align: 'right', lineBreak: false }));
      y += RH + 4;
    }

    cabecalhoPagina();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(escuro).text('Lista de Críticas', L, y); y += 14;
    const fora = new Set(bal.gruposFora || []);
    const filtro = [
      `Agrupado por: ${bal.agrupar === 'linha' ? 'Linha' : 'Setor'}`,
      `Grupos: ${fora.size ? 'todos menos ' + [...fora].map(grupoCurto).join(', ') : 'todos'}`,
      `Estoque em: ${quando}`,
      `Arquivo: ${bal.arquivoNome || ''}`,
    ].join('    ');
    doc.font('Helvetica').fontSize(7).fillColor(cinza).text(filtro, L, y, { width: W }); y += 12;
    cabecalhoColunas();

    const escopo = (bal.itens || []).filter(it => !fora.has(it.g));
    const lidos = escopo.filter(it => it.lido && it.g !== NAO_CADASTRADO);
    const grupos = [...new Set(lidos.map(it => it.g))].sort((a, b) => a.localeCompare(b));
    for (const g of grupos) {
      garante(RH * 3);
      doc.font('Helvetica').fontSize(7.5).fillColor(escuro).text('Grupo - ', L + 2, y + 2, { continued: true })
        .font('Helvetica-Bold').text(g);
      y += RH + 3;
      const doGrupo = lidos.filter(it => it.g === g).sort((a, b) => a.r.localeCompare(b.r) || a.d.localeCompare(b.d));
      doGrupo.forEach(linha);
      totais(doGrupo);
    }
    totais(lidos, 'Total do arquivo');
    doc.font('Helvetica').fontSize(7).fillColor(cinza)
      .text(`Total de ${lidos.length.toLocaleString('pt-BR')} registro(s) listado(s).`, L + 2, y); y += 18;

    const naoLidos = escopo.filter(it => !it.lido && it.e !== 0).sort((a, b) => a.r.localeCompare(b.r) || a.d.localeCompare(b.d));
    if (naoLidos.length) {
      garante(RH * 4, false);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#b00').text('* ', L, y, { continued: true })
        .fillColor(escuro).text('Produtos que satisfazem os filtros informados e que não constam no arquivo de balanço.');
      y += 12;
      cabecalhoColunas();
      naoLidos.forEach(linha);
      totais(naoLidos, 'Total não lido');
      doc.font('Helvetica').fontSize(7).fillColor(cinza)
        .text(`Total de ${naoLidos.length.toLocaleString('pt-BR')} registro(s) listado(s).`, L + 2, y);
      y += 18;
    }

    // Códigos lidos que não existem no Microvix: só a lista, fora da comparação
    const semCadastro = naoCadastradosDe(bal);
    if (semCadastro.length) {
      garante(RH * 4, false);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(escuro)
        .text(`Códigos não cadastrados no Microvix (${semCadastro.length})`, L, y);
      y += 11;
      doc.font('Helvetica').fontSize(7).fillColor(cinza)
        .text('Fora da comparação: etiqueta errada ou leitura errada. Achar a peça pelo código e ler a etiqueta da loja.', L, y, { width: W });
      y += 12;
      for (const it of semCadastro) {
        garante(RH, false);
        doc.font('Helvetica').fontSize(7.5).fillColor(escuro)
          .text(it.b, L + 2, y + 2, { width: 120, lineBreak: false })
          .text(`${it.l} peça(s)`, L + 130, y + 2, { width: 80, lineBreak: false });
        y += RH;
      }
      const pcs = semCadastro.reduce((a, it) => a + it.l, 0);
      doc.font('Helvetica-Bold').fontSize(7.5).text(`Total: ${pcs.toLocaleString('pt-BR')} peça(s)`, L + 2, y + 2);
      y += RH;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // senão o rodapé abaixo da margem abre página nova
      doc.font('Helvetica').fontSize(7).fillColor(cinza)
        .text(`Balanço ${lojaLabel} · ${dataBR(bal.data)}`, L, 841.89 - 26, { width: 300, lineBreak: false })
        .text(`${i + 1}/${range.count}`, L + W - 60, 841.89 - 26, { width: 60, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ── Planilha de recontagem (modelo do escritório) ──────────────────────────
const FMT_INT = '#,##0;(#,##0);-';
const FMT_RS = '"R$" #,##0.00;("R$" #,##0.00);-';
const BORDA = { left: { style: 'thin' }, right: { style: 'thin' }, top: { style: 'thin' }, bottom: { style: 'thin' } };
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const STATUS_CORES = [
  ['A RECONTAR', 'FFFFEB9C', 'FF9C6500'],
  ['VENDA PARCIAL', 'FFFFE0B2', 'FF7F4F00'],
  ['VER VENDA', 'FFDDEBF7', 'FF1F4E79'],
  ['VER TRÂNSITO', 'FFE2D0BB', 'FF7B3F00'],
  ['DIVERGENTE', 'FFFFC7CE', 'FF9C0006'],
  ['OK', 'FFC6EFCE', 'FF006100'],
];
const barra = (ref, prio) => ({ ref, rules: [{ type: 'dataBar', priority: prio, cfvo: [{ type: 'min' }, { type: 'max' }],
  color: { argb: 'FF63BE7B' }, gradient: true, minLength: 0, maxLength: 100 }] });

function ordemPlanilha(bal) {
  return itensRecontagem(bal).slice()
    .sort((a, b) => grupoCurto(a.g).localeCompare(grupoCurto(b.g)) || a.d.localeCompare(b.d));
}

async function excelRecontagem(bal, historico) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gestão de Lojas';
  const itens = ordemPlanilha(bal);
  const n = itens.length;
  const ini = 4, fim = Math.max(ini, ini + n - 1), tot = fim + 1;
  const jan = bal.janelaTransito || {};
  const periodoTransito = `${dataBR(jan.ini).slice(0, 5)}→${dataBR(jan.fim).slice(0, 5)}`;

  // RECONTAGEM
  // A–P: o que se lê e imprime (Trânsito, Venda e Dif. líquida logo depois da Diferença);
  // Q–V: auxiliares. Mesma regra da tela: com nota pendente o esperado é estoque − nota.
  //  A Setor  B Código  C Descrição  D Referência  E Estoque  F Balanço  G Diferença
  //  H Trânsito  I Venda  J Dif. líquida  K Preço  L Impacto  M Recontada  N Dif. Final
  //  O Status  P Observação | Q Imp. confirmado  R Imp. a apurar  S Vendas (aux)
  //  T Em trânsito (aux)  U Causa provável (aux)  V Nota pendente (aux)
  const ws = wb.addWorksheet('RECONTAGEM', { views: [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4' }] });
  [13.71, 11.43, 45, 16.43, 8.71, 8.71, 10.29, 9.5, 8, 10, 11.43, 13.29, 14.43, 10, 19.86, 40, 18.29, 18.29, 14, 16, 18.29, 12]
    .forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  ws.mergeCells('A1:P1');
  const t = ws.getCell('A1');
  t.value = 'INVENTÁRIO — RECONTAGEM DE DIVERGÊNCIAS (TODOS OS SETORES)';
  t.font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  t.fill = fill('FF1F3864');
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 26.1;

  const it2 = { name: 'Calibri', italic: true, size: 10, color: { argb: 'FF404040' } };
  ws.getCell('A2').value = 'Data:'; ws.getCell('A2').font = { ...it2, bold: true };
  ws.getCell('B2').value = new Date(bal.data + 'T12:00:00Z'); ws.getCell('B2').numFmt = 'dd/mm/yyyy';
  ws.getCell('B2').alignment = { horizontal: 'left' };
  ws.mergeCells('D2:E2'); ws.getCell('D2').value = 'Responsável:'; ws.getCell('D2').alignment = { horizontal: 'right' };
  ws.mergeCells('F2:I2');
  for (const c of 'BCDEFGHIJKLMNOP') ws.getCell(c + '2').font = it2;

  const cab = ['Setor', 'Código', 'Descrição', 'Referência', 'Estoque', 'Balanço', 'Diferença',
    'Trânsito', 'Venda', 'Dif. líquida', 'Preço Unit.', 'Impacto R$',
    'Qtde Recontada', 'Dif. Final', 'Status', 'Observação',
    'Impacto confirmado R$', 'Impacto a apurar R$', 'Vendas período (aux)', `Em trânsito ${periodoTransito} (aux)`, 'Causa provável (aux)', 'Nota pendente (aux)'];
  const NPRINC = 16;
  const r3 = ws.getRow(3); r3.height = 32.1;
  cab.forEach((h, i) => {
    const c = r3.getCell(i + 1);
    c.value = h;
    const aux = i >= NPRINC;
    const abat = i >= 7 && i <= 9;
    c.font = { name: 'Calibri', bold: true, size: aux ? 9 : 11, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(aux ? 'FF7F7F7F' : abat ? 'FF7B3F00' : 'FF2E75B6');
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    if (!aux) c.border = BORDA;
  });
  r3.getCell(8).note = 'Peças em trânsito que explicam a falta: a nota pendente no Recebimento de NF conta inteira (as peças não estão na loja); transferência/nota recente só até a falta.';
  r3.getCell(10).note = 'Diferença depois de abater trânsito e venda (usa a recontagem quando houver): o que ainda falta explicar.';

  const preto = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
  const auxF = { name: 'Calibri', size: 10, color: { argb: 'FF404040' } };
  const ESTATICO = ['SEM FOTO', 'A CONFERIR', 'RECUSADO'];
  itens.forEach((it, k) => {
    const r = ini + k;
    const row = ws.getRow(r); row.height = 15.95;
    const recont = it.rc === null || it.rc === undefined || it.rc === '' ? null : Number(it.rc);
    const a = abatimentos(it);
    const tPend = (it.tn || []).filter(n => n.pend).reduce((s, n) => s + n.q, 0);
    const st = statusItem(it, bal);
    // Contado = recontada quando houver, senão o balanço
    const cont = `IF($M${r}="",$F${r},$M${r})`;
    const falta = `MAX(0,$E${r}-${cont})`;
    const vals = [
      grupoCurto(it.g), it.c ? Number(it.c) : it.b, it.d, it.r, it.e, it.l,
      { formula: `F${r}-E${r}`, result: it.l - it.e },
      { formula: `IF(${falta}>0,N($V${r}),0)+MIN(MAX(0,${falta}-N($V${r})),MAX(0,N($T${r})-N($V${r})))`, result: a.trNota + a.trOutros },
      { formula: `MIN(MAX(0,${cont}-$E${r}),N($S${r}))`, result: a.venda },
      { formula: `${cont}-$E${r}+$H${r}-$I${r}`, result: a.liquida },
      it.p,
      { formula: `G${r}*K${r}`, result: (it.l - it.e) * it.p },
      recont,
      { formula: `IF($M${r}="","",IF(OR($O${r}="OK",$O${r}="VER TRÂNSITO",$O${r}="VER VENDA",$O${r}="TROCA"),0,$M${r}-$E${r}+IF($E${r}>$M${r},N($V${r}),0)))` },
      it.st || ESTATICO.includes(st) ? st
        : { formula: `IF($M${r}="",$U${r},IF($M${r}=$E${r},"OK",IF(AND($M${r}<$E${r},$M${r}-$E${r}+$H${r}=0),"VER TRÂNSITO","DIVERGENTE")))`, result: st },
      it.ob || null,
      { formula: `IF($M${r}="",0,N($N${r})*$K${r})` },
      { formula: `IF($M${r}="",$L${r},0)` },
      it.v || null,
      it.t || null,
      { formula: `IF(AND($G${r}<0,$G${r}+$H${r}=0),"VER TRÂNSITO",IF(AND(N($S${r})>0,ABS($G${r})=N($S${r})),"VER VENDA",IF(N($S${r})>0,"VENDA PARCIAL","A RECONTAR")))` },
      tPend || null,
    ];
    vals.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v;
      const col = i + 1;
      if (col <= NPRINC) { c.font = preto; c.border = BORDA; c.alignment = { horizontal: 'center', vertical: 'middle' }; }
      else c.font = auxF;
      if (col === 1 || col === 3) c.alignment = { horizontal: 'left', vertical: 'middle' };
      if (col === 11 || col === 12) c.alignment = { vertical: 'middle' };
      if ([5, 6, 7, 8, 9, 10, 13, 14, 19, 20, 22].includes(col)) c.numFmt = FMT_INT;
      if ([11, 12, 17, 18].includes(col)) c.numFmt = FMT_RS;
      if (col === 10) c.font = { ...preto, bold: true };
      if (col === 13) { c.font = { ...preto, bold: true, color: { argb: 'FF0000FF' } }; c.fill = fill('FFFFF2CC'); }
      if (col === 16) { c.font = { name: 'Calibri', size: 10, color: { argb: 'FF0000FF' } }; c.fill = fill('FFFFF2CC'); c.numFmt = '@'; c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }; }
      if (col >= 19) { c.fill = fill('FFFFFFFF'); c.alignment = { horizontal: 'center' }; }
    });
    // Observação longa: a linha cresce para ela aparecer inteira (~38 caracteres por linha na coluna P)
    const linhasOb = Math.ceil(String(it.ob || '').length / 38);
    if (linhasOb > 1) row.height = Math.min(15 * linhasOb, 90);
    row.getCell(13).dataValidation = {
      type: 'whole', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0],
      showInputMessage: true, promptTitle: 'Recontagem', prompt: 'Digite a quantidade física contada.',
      showErrorMessage: true, errorTitle: 'Quantidade inválida', error: 'Informe um número inteiro maior ou igual a zero.',
    };
  });

  const rt = ws.getRow(tot); rt.height = 15.95;
  const branco = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  const rng = c => `${c}${ini}:${c}${fim}`;
  const totVals = {
    B: 'TOTAL', E: { formula: `SUM(${rng('E')})` }, F: { formula: `SUM(${rng('F')})` }, G: { formula: `SUM(${rng('G')})` },
    H: { formula: `SUM(${rng('H')})` }, I: { formula: `SUM(${rng('I')})` }, J: { formula: `SUM(${rng('J')})` },
    L: { formula: `SUM(${rng('L')})` },
    M: { formula: `COUNT(${rng('M')})&" de "&COUNTA(${rng('B')})` },
    O: { formula: `COUNTIF(${rng('O')},"OK")&" OK / "&COUNTIF(${rng('O')},"DIVERGENTE")&" DIV. / "&COUNTIF(${rng('O')},"VER VENDA")&" venda / "&COUNTIF(${rng('O')},"VER TRÂNSITO")&" trânsito"` },
    Q: { formula: `SUM(${rng('Q')})` }, R: { formula: `SUM(${rng('R')})` },
    S: { formula: `SUM(${rng('S')})` }, T: { formula: `SUM(${rng('T')})` }, V: { formula: `SUM(${rng('V')})` },
  };
  for (const c of 'ABCDEFGHIJKLMNOP') {
    const cell = rt.getCell(c);
    cell.value = totVals[c] ?? null;
    cell.font = branco; cell.fill = fill('FF2E75B6'); cell.border = BORDA;
    if ('EFGHIJ'.includes(c)) cell.numFmt = FMT_INT;
    if ('KL'.includes(c)) cell.numFmt = FMT_RS;
    if ('MNO'.includes(c)) cell.alignment = { horizontal: 'center' };
  }
  for (const c of 'QR') { const cell = rt.getCell(c); cell.value = totVals[c]; cell.numFmt = FMT_RS; cell.font = { name: 'Calibri', bold: true, size: 11 }; }
  for (const c of 'STUV') {
    const cell = rt.getCell(c); cell.value = totVals[c] ?? null; cell.numFmt = FMT_INT;
    cell.font = { ...auxF, bold: true }; cell.fill = fill('FFFFFFFF'); cell.alignment = { horizontal: 'center' };
  }

  ws.autoFilter = `A3:P${tot}`;
  ws.addConditionalFormatting(barra(`L${ini}:L${fim}`, 1));
  ws.addConditionalFormatting({
    ref: `O${ini}:O${fim}`,
    rules: STATUS_CORES.map(([txt, bg, fg], i) => ({
      type: 'containsText', operator: 'containsText', text: txt, priority: 2 + i,
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: bg } }, font: { color: { argb: fg } } },
    })),
  });
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    blackAndWhite: true, horizontalCentered: true, printArea: `A1:P${tot}`, printTitlesRow: '1:3',
    margins: { left: 0.28, right: 0.28, top: 0.39, bottom: 0.39, header: 0.31, footer: 0.31 },
  };

  // RESUMO GERAL
  const rs = wb.addWorksheet('RESUMO GERAL', { views: [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4' }] });
  [24.71, 14.14, 14.14, 14.14, 14.14, 14.14, 22.14, 22.14, 22.14, 16.43, 16.43, 16.43, 16.43]
    .forEach((w, i) => { rs.getColumn(i + 1).width = w; });
  rs.mergeCells('A1:M1');
  const t2 = rs.getCell('A1');
  t2.value = 'RESUMO GERAL DA RECONTAGEM — POR SETOR';
  t2.font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  t2.fill = fill('FF1F3864'); t2.alignment = { horizontal: 'center', vertical: 'middle' };
  rs.getRow(1).height = 26.1;
  rs.getCell('A2').value = 'Calculado automaticamente a partir da aba RECONTAGEM — novos setores aparecem sozinhos.';
  rs.getCell('A2').font = { name: 'Calibri', italic: true, size: 9, color: { argb: 'FF808080' } };
  const cab2 = ['Setor', 'Itens', 'Recontados', 'OK', 'Divergentes', 'Pendentes', 'Impacto sistema R$', 'Impacto confirmado R$',
    'Impacto a apurar R$', 'Explicado por venda', 'Vendas período', 'Explicado por trânsito', `Em trânsito ${periodoTransito}`];
  const h3 = rs.getRow(3); h3.height = 33.95;
  cab2.forEach((h, i) => {
    const c = h3.getCell(i + 1);
    c.value = h;
    c.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(i >= 9 ? 'FF7B3F00' : 'FF2E75B6');
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = BORDA;
  });
  const nGrupos = new Set(itens.map(it => grupoCurto(it.g))).size;
  const linhasResumo = Math.max(27, nGrupos + 3);
  const rFim = 3 + linhasResumo, rTot = rFim + 1;
  const R = c => `RECONTAGEM!$${c}$4:$${c}$${Math.max(500, tot)}`;
  const temaF = { name: 'Calibri', size: 11 };
  for (let r = 4; r <= rFim; r++) {
    const row = rs.getRow(r); row.height = 18;
    const f = {
      A: `IFERROR(IF(INDEX(${R('A')},MATCH(0,INDEX(COUNTIF($A$3:A${r - 1},${R('A')}),0),0))=0,"",INDEX(${R('A')},MATCH(0,INDEX(COUNTIF($A$3:A${r - 1},${R('A')}),0),0))),"")`,
      B: `IF($A${r}="","",COUNTIF(${R('A')},$A${r}))`,
      C: `IF($A${r}="","",SUMPRODUCT((${R('A')}=$A${r})*ISNUMBER(${R('M')})))`,
      D: `IF($A${r}="","",COUNTIFS(${R('A')},$A${r},${R('O')},"OK"))`,
      E: `IF($A${r}="","",COUNTIFS(${R('A')},$A${r},${R('O')},"DIVERGENTE"))`,
      F: `IF($A${r}="","",$B${r}-$C${r})`,
      G: `IF($A${r}="","",SUMIF(${R('A')},$A${r},${R('L')}))`,
      H: `IF($A${r}="","",SUMIF(${R('A')},$A${r},${R('Q')}))`,
      I: `IF($A${r}="","",SUMIF(${R('A')},$A${r},${R('R')}))`,
      J: `IF($A${r}="","",COUNTIFS(${R('A')},$A${r},${R('O')},"VER VENDA"))`,
      K: `IF($A${r}="","",SUMIF(${R('A')},$A${r},${R('S')}))`,
      L: `IF($A${r}="","",COUNTIFS(${R('A')},$A${r},${R('O')},"VER TRÂNSITO"))`,
      M: `IF($A${r}="","",SUMIF(${R('A')},$A${r},${R('T')}))`,
    };
    for (const c of 'ABCDEFGHIJKLM') {
      const cell = row.getCell(c);
      cell.value = { formula: f[c] };
      cell.font = temaF; cell.border = BORDA;
      cell.alignment = { horizontal: c === 'A' ? undefined : 'GHI'.includes(c) ? 'right' : 'center', vertical: 'middle' };
      if (c !== 'A') cell.numFmt = 'GHI'.includes(c) ? FMT_RS : FMT_INT;
    }
  }
  const rowT = rs.getRow(rTot); rowT.height = 18;
  for (const c of 'ABCDEFGHIJKLM') {
    const cell = rowT.getCell(c);
    cell.value = c === 'A' ? 'TOTAL' : { formula: `SUM(${c}4:${c}${rFim})` };
    cell.font = branco; cell.fill = fill('FF2E75B6'); cell.border = BORDA;
    cell.alignment = { horizontal: c === 'A' ? undefined : 'GHI'.includes(c) ? 'right' : 'center', vertical: 'middle' };
    if (c !== 'A') cell.numFmt = 'GHI'.includes(c) ? FMT_RS : FMT_INT;
  }
  rs.addConditionalFormatting(barra(`I4:I${rFim}`, 1));
  rs.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    blackAndWhite: true, horizontalCentered: true, printArea: `A1:M${rTot}`, printTitlesRow: '1:3',
    margins: { left: 0.51, right: 0.51, top: 0.79, bottom: 0.79, header: 0.31, footer: 0.31 },
  };

  // HISTÓRICO: uma linha por movimento de cada item da recontagem
  if (historico) {
    const wh = wb.addWorksheet('HISTÓRICO', { views: [{ state: 'frozen', ySplit: 1 }] });
    [11, 45, 12, 12, 12, 8, 16, 38, 8, 8, 12, 8].forEach((w, i) => { wh.getColumn(i + 1).width = w; });
    wh.addRow(['Código', 'Descrição', 'Emissão', 'Lançamento', 'Documento', 'Série', 'Tipo', 'Cliente/Fornec.', 'Qtd.', 'Saldo', 'Valor Unit.', 'CFOP'])
      .eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF2E75B6'); c.border = BORDA; });
    for (const it of itens) {
      for (const m of historico.itens[it.c]?.l || []) {
        const row = wh.addRow([Number(it.c) || it.c, it.d, dataBR(m.em), dataBR(m.la), m.doc, m.se, m.tp,
          m.cc ? [m.cc, historico.nomes[m.cc]].filter(Boolean).join('-') : '', m.q, m.s, m.vu, m.cf]);
        row.getCell(11).numFmt = FMT_RS;
      }
    }
    wh.autoFilter = `A1:L${wh.rowCount}`;
    wh.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  }

  // Fórmulas recalculam ao abrir (o resumo depende delas)
  wb.calcProperties = { fullCalcOnLoad: true };
  // Códigos não cadastrados: aba à parte, sem comparação
  const nc = naoCadastradosDe(bal);
  if (nc.length) {
    const ws2 = wb.addWorksheet('NÃO CADASTRADOS');
    [22, 14, 50].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
    ws2.mergeCells('A1:C1');
    ws2.getCell('A1').value = 'CÓDIGOS LIDOS QUE NÃO EXISTEM NO MICROVIX';
    ws2.getCell('A1').font = { name: 'Calibri', bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    ws2.getCell('A1').fill = fill('FF1F3864');
    ws2.getCell('A1').alignment = { horizontal: 'center' };
    ws2.getCell('A2').value = 'Fora da comparação: etiqueta errada ou leitura errada. Achar a peça pelo código e ler a etiqueta da loja.';
    ws2.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF595959' } };
    const h = ws2.getRow(3);
    ['Código lido', 'Quantidade', 'Observação'].forEach((t, i) => {
      const c = h.getCell(i + 1); c.value = t; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF2F5597'); c.border = BORDA;
    });
    nc.forEach((it, i) => {
      const row = ws2.getRow(4 + i);
      row.getCell(1).value = it.b;
      row.getCell(2).value = it.l; row.getCell(2).numFmt = FMT_INT;
      row.getCell(3).value = it.ob || '';
      for (let k = 1; k <= 3; k++) row.getCell(k).border = BORDA;
    });
    const tr = ws2.getRow(4 + nc.length);
    tr.getCell(1).value = 'Total'; tr.getCell(1).font = { bold: true };
    tr.getCell(2).value = { formula: `SUM(B4:B${3 + nc.length})` }; tr.getCell(2).numFmt = FMT_INT; tr.getCell(2).font = { bold: true };
  }
  return wb.xlsx.writeBuffer();
}

// ── Planilha de recontagem → gestão ────────────────────────────────────────
// Lê a aba RECONTAGEM pelo nome das colunas: as planilhas antigas seguem o
// modelo mas mudam de lugar (coluna vazia antes do Status, AJUSTADO?,
// REGULARIZADO?, "1ª ocorrência?"…). Serve tanto para trazer a recontagem de
// volta quanto para arquivar um balanço feito fora do gestão.
const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const STATUS_PLANILHA = ['OK', 'DIVERGENTE', 'VER VENDA', 'VER TRÂNSITO', 'TROCA', 'A RECONTAR'];
async function lerPlanilhaRecontagem(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('RECONTAGEM') || wb.worksheets[0];
  if (!ws) throw new Error('Planilha vazia.');
  const val = c => {
    const v = c.value;
    if (v instanceof Date) return v;
    if (v && typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : null);
    return v;
  };
  const numero = v => {
    if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '-') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[R$\s.]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  // Cabeçalho: a primeira linha (até a 10ª) com uma coluna "Código"
  let hdr = 0;
  const nomes = {};
  for (let r = 1; r <= 10 && !hdr; r++) {
    const row = ws.getRow(r);
    row.eachCell((c, i) => { if (semAcento(val(c)) === 'codigo') hdr = r; });
    if (hdr) row.eachCell((c, i) => { nomes[i] = semAcento(val(c)); });
  }
  if (!hdr) throw new Error('Não achei o cabeçalho (coluna "Código") na aba RECONTAGEM.');
  const acha = re => { const e = Object.entries(nomes).find(([, n]) => re.test(n)); return e ? +e[0] : null; };
  const C = {
    setor: acha(/^setor/), cod: acha(/^codigo$/), desc: acha(/^descri/), ref: acha(/^refer/),
    e: acha(/^estoque$/), l: acha(/^balanco$/), p: acha(/^preco/), rc: acha(/^qtde recont/),
    ob: acha(/^observ/), st: acha(/^status$/), v: acha(/^vendas/), t: acha(/em transito|recebid/) ?? acha(/^transito/), extra: acha(/ajustado|regularizado/),
  };
  if (!C.rc) C.rc = 10;
  if (!C.ob) C.ob = 13;

  // Data do balanço: célula ao lado de "Data:" acima do cabeçalho
  let data = null;
  for (let r = 1; r < hdr && !data; r++) {
    ws.getRow(r).eachCell((c, i) => {
      if (data || !/^data/.test(semAcento(val(c)))) return;
      const d = val(ws.getRow(r).getCell(i + 1));
      if (d instanceof Date) data = d.toISOString().slice(0, 10);
      else if (typeof d === 'number' && d > 30000) data = new Date(Math.round((d - 25569) * 864e5)).toISOString().slice(0, 10);
    });
  }

  const linhas = [];
  const vistos = new Set();
  let duplicadas = 0;
  ws.eachRow((row, r) => {
    if (r <= hdr) return;
    const g = i => (i ? val(row.getCell(i)) : null);
    const cod = String(g(C.cod) ?? '').trim();
    if (!cod || /total/i.test(cod) || !/\d/.test(cod)) return;
    const l = {
      setor: String(g(C.setor) ?? '').trim(), cod, desc: String(g(C.desc) ?? '').replace(/\s+/g, ' ').trim(),
      ref: String(g(C.ref) ?? '').trim(), e: numero(g(C.e)), l: numero(g(C.l)), p: numero(g(C.p)),
      rc: numero(g(C.rc)), ob: String(g(C.ob) ?? '').trim(), v: numero(g(C.v)), t: numero(g(C.t)),
      extra: C.extra ? String(g(C.extra) ?? '').trim() : '', extraNome: C.extra ? nomes[C.extra].toUpperCase() : '',
      // O Status que aparece na planilha (digitado ou de fórmula) é a palavra final do escritório
      stTexto: C.st ? String(g(C.st) ?? '').trim() : '',
      st: (() => {
        const t = C.st ? String(g(C.st) ?? '').trim().toUpperCase().replace('TRANSITO', 'TRÂNSITO') : '';
        // Anotação própria no lugar do status (ACHADO BAL. ANTERIOR, SOBRA 1 / FALTAVA 2…):
        // o escritório tirou o item das divergências, então conta como OK
        return STATUS_PLANILHA.includes(t) ? t : t ? 'OK' : null;
      })(),
    };
    // O export às vezes repete um bloco de setor inteiro: a mesma linha duas vezes
    const chave = [l.cod, l.e, l.l].join('|');
    if (vistos.has(chave)) { duplicadas++; return; }
    vistos.add(chave);
    linhas.push(l);
  });
  return { data, linhas, duplicadas, completa: C.e !== null && C.l !== null && C.p !== null };
}

module.exports = { pdfListaCriticas, excelRecontagem, lerPlanilhaRecontagem };
