'use strict';
// Planilha de simulação do Ponto de equilíbrio: a tela manda a média de cada loja e
// a planilha sai com fórmulas. Células amarelas são para mexer; o resto recalcula.
// lojas: [{ nome, meses, venda, variaveis: { chave: fração }, fixas: { chave: R$ }, aluguelMin }]

const ExcelJS = require('exceljs');

const AZUL = 'FF1F3A5F', CINZA = 'FFE4EAF2', AMARELO = 'FFFFF4CC', BORDA = 'FFD0D7DE', VERDE = 'FFE6F4EA';
const NUM = '#,##0.00;[Red]-#,##0.00;"-"', PCT = '0.00%;[Red]-0.00%;"-"';
const preenche = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const borda = { top: { style: 'thin', color: { argb: BORDA } }, bottom: { style: 'thin', color: { argb: BORDA } } };

const VARIAVEIS = [['simples', 'Simples'], ['icms', 'ICMS de entrada'], ['cmv', 'CMV'], ['perdas', 'Perdas de balanço'], ['subsidio', 'Subsídio'],
  ['embalagens', 'Embalagens'], ['frete', 'Frete'], ['comissoes', 'Comissões'], ['encVar', 'Encargos sobre comissões'], ['premiacoes', 'Premiações'], ['taxa', 'Descontos de cartão']];
const FIXAS = [['salFixos', 'Salários fixos e encargos'], ['escritorio', 'Escritório'], ['vt', 'V.T. e ajuda de custo'],
  ['ocupacao', 'CTO sem o aluguel (condomínio, FPP, ar, IPTU, energia)'], ['administrativo', 'Administrativo'], ['publicidade', 'Marketing'], ['tarifa', 'Tarifa bancária']];

async function gerarSimulacao({ lojas = [], lucros = [8, 12, 15], aluguelPct = 5, titulo = 'Simulação do ponto de equilíbrio' }) {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet('Simulação', { views: [{ state: 'frozen', xSplit: 1, ySplit: 9, showGridLines: false }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const n = lojas.length, col = i => ws.getColumn(i + 2).letter;
  ws.getColumn(1).width = 46;
  for (let i = 0; i < n; i++) ws.getColumn(i + 2).width = 16;

  ws.getCell('A1').value = titulo;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
  ws.getCell('A2').value = `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Células amarelas podem ser alteradas; o resto recalcula. Só o resultado operacional (sem juros e dívidas).`;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF636C76' } };

  // Metas de lucro, comuns a todas as lojas
  const metaCel = [];
  ws.getCell('A4').value = 'Metas de lucro operacional (% da venda)';
  ws.getCell('A4').font = { bold: true };
  lucros.forEach((x, i) => {
    const c = ws.getCell(5, i + 2);
    ws.getCell(5, 1).value = 'Metas (mude à vontade)';
    c.value = x / 100; c.numFmt = '0.0%'; c.fill = preenche(AMARELO); c.font = { bold: true, color: { argb: 'FF0B5394' } };
    metaCel.push(`$${col(i)}$5`);
  });
  ws.getCell('A6').value = 'Aluguel percentual do shopping (sobre a venda)';
  const alugCel = ws.getCell('B6');
  alugCel.value = aluguelPct / 100; alugCel.numFmt = '0.0%'; alugCel.fill = preenche(AMARELO); alugCel.font = { bold: true, color: { argb: 'FF0B5394' } };

  let r = 9;
  const cab = ws.getRow(r);
  cab.getCell(1).value = 'Indicador';
  lojas.forEach((l, i) => { cab.getCell(i + 2).value = l.nome; });
  cab.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = preenche(AZUL); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  cab.height = 22;

  const linhas = {};
  const linha = (id, rotulo, { tipo = 'item', fmt = NUM, valor, formula, entrada = false } = {}) => {
    r++;
    const row = ws.getRow(r);
    row.getCell(1).value = rotulo;
    for (let i = 0; i < n; i++) {
      const c = row.getCell(i + 2);
      if (formula) c.value = { formula: formula(col(i), lojas[i]) };
      else if (valor) c.value = valor(lojas[i]);
      c.numFmt = fmt;
      if (entrada) { c.fill = preenche(AMARELO); c.font = { color: { argb: 'FF0B5394' } }; }
    }
    row.eachCell({ includeEmpty: true }, (c, k) => {
      if (k > n + 1) return;
      c.border = borda;
      if (tipo === 'total') { c.font = { ...(c.font || {}), bold: true }; if (!entrada) c.fill = preenche(CINZA); }
      if (tipo === 'grupo') c.font = { ...(c.font || {}), bold: true, color: { argb: AZUL } };
      if (tipo === 'meta' && k > 1) { c.font = { ...(c.font || {}), bold: true }; c.fill = preenche(VERDE); }
      if (tipo === 'meta' && k === 1) c.font = { bold: true };
    });
    if (tipo === 'item') row.getCell(1).alignment = { indent: 1 };
    linhas[id] = r;
    return r;
  };
  const ref = (id, c) => `${c}${linhas[id]}`;
  const titulo2 = texto => { r++; ws.getRow(r).getCell(1).value = texto; ws.getRow(r).getCell(1).font = { bold: true, size: 11, color: { argb: AZUL } }; };

  linha('meses', 'Meses da média', { fmt: '@', valor: l => l.meses || '' });
  linha('venda', 'Venda do mês (simular)', { tipo: 'total', valor: l => l.venda, entrada: true });

  titulo2('Custos variáveis (% da venda)');
  for (const [k, rot] of VARIAVEIS) linha('v_' + k, rot, { fmt: PCT, valor: l => l.variaveis?.[k] || 0, entrada: true });
  const primeiraV = linhas['v_' + VARIAVEIS[0][0]], ultimaV = linhas['v_' + VARIAVEIS[VARIAVEIS.length - 1][0]];
  linha('var', 'Total dos custos variáveis', { tipo: 'total', fmt: PCT, formula: c => `SUM(${c}${primeiraV}:${c}${ultimaV})` });
  linha('mc', 'Margem de contribuição', { tipo: 'total', fmt: PCT, formula: c => `1-${ref('var', c)}` });

  titulo2('Despesas fixas por mês (R$)');
  for (const [k, rot] of FIXAS) linha('f_' + k, rot, { valor: l => l.fixas?.[k] || 0, entrada: true });
  linha('alugMin', 'Aluguel mínimo', { valor: l => l.aluguelMin || 0, entrada: true });
  const primeiraF = linhas['f_' + FIXAS[0][0]];
  linha('fixo', 'Total das despesas fixas (com aluguel mínimo)', { tipo: 'total', formula: c => `SUM(${c}${primeiraF}:${c}${linhas.alugMin})` });

  titulo2('Resultado na venda simulada');
  linha('mcR', 'Margem de contribuição (R$)', { formula: c => `${ref('venda', c)}*${ref('mc', c)}` });
  linha('alugPago', 'Aluguel percentual acima do mínimo', { formula: c => `MAX(0,${ref('venda', c)}*$B$6-${ref('alugMin', c)})` });
  linha('res', 'Resultado operacional', { tipo: 'total', formula: c => `${ref('mcR', c)}-${ref('fixo', c)}-${ref('alugPago', c)}` });
  linha('resPct', 'Resultado operacional (% da venda)', { tipo: 'total', fmt: PCT, formula: c => `IF(${ref('venda', c)}=0,0,${ref('res', c)}/${ref('venda', c)})` });

  // Venda para lucro x: fixas ÷ (margem − x); se aí o aluguel % passa do mínimo,
  // o aluguel sai do fixo e os 5% entram no variável.
  const vendaPara = (c, x) => {
    const F = ref('fixo', c), A = ref('alugMin', c), M = ref('mc', c);
    const r1 = `${F}/(${M}-${x})`, r2 = `(${F}-${A})/(${M}-$B$6-${x})`;
    return `IF(${M}-${x}<=0,"não fecha",IF(${r1}*$B$6<=${A},${r1},IF(${M}-$B$6-${x}<=0,"não fecha",${r2})))`;
  };
  titulo2('Ponto de equilíbrio e metas');
  linha('pe', 'Ponto de equilíbrio (venda por mês)', { tipo: 'meta', formula: c => vendaPara(c, 0) });
  linha('peDia', 'Por dia (30 dias)', { formula: c => `IFERROR(${ref('pe', c)}/30,"–")` });
  linha('peFolga', 'Venda simulada − equilíbrio', { formula: c => `IFERROR(${ref('venda', c)}-${ref('pe', c)},"–")` });
  lucros.forEach((x, i) => {
    const m = metaCel[i];
    const id = 'meta' + i;
    linha(id, `Venda para a meta ${i + 1} de lucro (por mês)`, { tipo: 'meta', formula: c => vendaPara(c, m) });
    ws.getCell(linhas[id], 1).value = { formula: `"Venda para "&ROUND(${m}*100,1)&"% de lucro (por mês)"`, result: `Venda para ${x}% de lucro (por mês)` };
    linha(id + 'd', 'Por dia (30 dias)', { formula: c => `IFERROR(${ref(id, c)}/30,"–")` });
    linha(id + 'l', 'Lucro operacional nessa venda (R$)', { formula: c => `IFERROR(${ref(id, c)}*${m},"–")` });
    linha(id + 'p', '% acima da venda simulada', { fmt: PCT, formula: c => `IFERROR(${ref(id, c)}/${ref('venda', c)}-1,"–")` });
  });

  // Base: a média real de cada loja, para comparar depois de mexer
  const base = wb.addWorksheet('Média real', { views: [{ showGridLines: false }] });
  base.getColumn(1).width = 46;
  base.getCell('A1').value = 'Média real dos meses finalizados (não muda com a simulação)';
  base.getCell('A1').font = { bold: true, size: 12, color: { argb: AZUL } };
  const bcab = base.getRow(3);
  bcab.getCell(1).value = 'Indicador';
  lojas.forEach((l, i) => { bcab.getCell(i + 2).value = l.nome; base.getColumn(i + 2).width = 16; });
  bcab.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = preenche(AZUL); });
  let br = 3;
  const bl = (rot, get, fmt = NUM) => { br++; const row = base.getRow(br); row.getCell(1).value = rot; lojas.forEach((l, i) => { const c = row.getCell(i + 2); c.value = get(l); c.numFmt = fmt; }); };
  bl('Meses', l => l.meses || '', '@');
  bl('Venda média', l => l.venda);
  for (const [k, rot] of VARIAVEIS) bl(rot, l => l.variaveis?.[k] || 0, PCT);
  for (const [k, rot] of FIXAS) bl(rot, l => l.fixas?.[k] || 0);
  bl('Aluguel mínimo', l => l.aluguelMin || 0);
  bl('Resultado operacional médio', l => l.operacional ?? null);

  return wb.xlsx.writeBuffer();
}

module.exports = { gerarSimulacao };
