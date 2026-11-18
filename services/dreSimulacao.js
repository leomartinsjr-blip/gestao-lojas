'use strict';
// Planilha de simulação do Ponto de equilíbrio. A tela manda a média de cada loja e a
// planilha sai com fórmulas: Resumo, uma aba por loja (Atual × Simulado, metragem e
// custo do shopping por m²) e Simples (alíquota pela faixa, acompanhando a venda).
// Células amarelas são para mexer; o resto recalcula.
// lojas: [{ nome, empresa, meses, venda, variaveis: { chave: fração }, cto: { aluguel, condominio, fpp, ar, iptu, energia },
//           fixas: { salFixos, escritorio, vt, administrativo, publicidade, tarifa }, operacional }]
// rbt12: { empresa: R$ dos 12 meses antes do último mês usado }

const ExcelJS = require('exceljs');
const { FAIXAS } = require('./dreLinhas');

const AZUL = 'FF1F3A5F', CINZA = 'FFE4EAF2', AMARELO = 'FFFFF4CC', BORDA = 'FFD0D7DE', VERDE = 'FFE6F4EA', TINTA = 'FF0B5394';
const NUM = '#,##0.00;[Red]-#,##0.00;"-"', PCT = '0.00%;[Red]-0.00%;"-"', M2 = '#,##0.0';
const preenche = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const borda = { top: { style: 'thin', color: { argb: BORDA } }, bottom: { style: 'thin', color: { argb: BORDA } } };

const VARIAVEIS = [['icms', 'ICMS de entrada'], ['cmv', 'CMV'], ['perdas', 'Perdas de balanço'], ['subsidio', 'Subsídio'],
  ['embalagens', 'Embalagens'], ['frete', 'Frete'], ['comissoes', 'Comissões'], ['encVar', 'Encargos sobre comissões'], ['premiacoes', 'Premiações'], ['taxa', 'Descontos de cartão']];
// Cobrados pela área: no Simulado mudam na proporção da metragem
const SHOPPING = [['aluguel', 'Aluguel mínimo', true], ['condominio', 'Condomínio', true], ['fpp', 'FPP', true], ['ar', 'Ar condicionado', true],
  ['iptu', 'IPTU', true], ['energia', 'Energia elétrica', false]];
const OUTRAS = [['salFixos', 'Salários fixos e encargos'], ['escritorio', 'Escritório'], ['vt', 'V.T. e ajuda de custo'],
  ['administrativo', 'Administrativo'], ['publicidade', 'Marketing'], ['tarifa', 'Tarifa bancária']];
const NOME_EMPRESA = { LMJ: 'LMJ (Del Rey + Site)', JDG: 'JDG (Minas)', PV: 'PV (Contagem)', TTS: 'TTS (Estação)', '3L': '3L (Tommy)', LF: 'LF (Lez)' };

const q = nome => `'${String(nome).replace(/'/g, "''")}'`;
const nomeAba = (nome, usados) => {
  let n = String(nome).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Loja';
  while (usados.has(n)) n = n.slice(0, 28) + ' ' + (usados.size + 1);
  usados.add(n); return n;
};
const entrada = c => { c.fill = preenche(AMARELO); c.font = { ...(c.font || {}), color: { argb: TINTA } }; };
const cabecalho = (row, textos) => {
  textos.forEach((t, i) => { row.getCell(i + 1).value = t; });
  row.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = preenche(AZUL); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  row.height = 30;
};

async function gerarSimulacao({ lojas = [], lucros = [8, 12, 15], aluguelPct = 5, encargos = 0.29, rbt12 = {}, titulo = 'Simulação do ponto de equilíbrio' }) {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const resumo = wb.addWorksheet('Resumo', { views: [{ showGridLines: false }] });
  const usados = new Set(['Resumo', 'Simples']);
  const abas = lojas.map(l => nomeAba(l.nome, usados));

  // Simples: faixas nas linhas 5–10 e as empresas a partir da 14
  const empresas = [...new Set(lojas.map(l => l.empresa).filter(Boolean))];
  const linhaEmpresa = Object.fromEntries(empresas.map((e, i) => [e, 14 + i]));

  // Parâmetros comuns no Resumo
  resumo.getColumn(1).width = 30;
  resumo.getCell('A1').value = titulo;
  resumo.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
  resumo.getCell('A2').value = `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Células amarelas podem ser alteradas; o resto recalcula. Só o resultado operacional (sem juros e dívidas).`;
  resumo.getCell('A2').font = { size: 9, color: { argb: 'FF636C76' } };
  resumo.getCell('A4').value = 'Metas de lucro operacional';
  resumo.getCell('A4').font = { bold: true };
  const metas = lucros.map((x, i) => {
    const c = resumo.getCell(4, i + 2);
    c.value = x / 100; c.numFmt = '0.0%'; entrada(c); c.font = { bold: true, color: { argb: TINTA } };
    return `Resumo!$${resumo.getColumn(i + 2).letter}$4`;
  });
  resumo.getCell('A5').value = 'Aluguel percentual do shopping';
  resumo.getCell('A5').font = { bold: true };
  const pctCel = resumo.getCell('B5');
  pctCel.value = aluguelPct / 100; pctCel.numFmt = '0.0%'; entrada(pctCel); pctCel.font = { bold: true, color: { argb: TINTA } };
  const P = 'Resumo!$B$5';
  resumo.getCell('A6').value = 'Encargos sobre fixo + comissões';
  resumo.getCell('A6').font = { bold: true };
  const encCel = resumo.getCell('B6');
  encCel.value = encargos; encCel.numFmt = '0.0%'; entrada(encCel); encCel.font = { bold: true, color: { argb: TINTA } };
  const ENC = 'Resumo!$B$6';

  // Uma aba por loja: B = atual (média real), C = simulado
  const pos = {};
  lojas.forEach((l, i) => {
    const ws = wb.addWorksheet(abas[i], { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
      pageSetup: { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    [44, 16, 16, 16, 16].forEach((w, k) => { ws.getColumn(k + 1).width = w; });
    ws.getCell('A1').value = `${l.nome} · simulação`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
    ws.getCell('A2').value = `Atual = média de ${l.meses || '—'}. Simulado começa igual ao atual: mude a metragem, a venda ou qualquer célula amarela.`;
    ws.getCell('A2').font = { size: 9, color: { argb: 'FF636C76' } };
    cabecalho(ws.getRow(4), ['Indicador', 'Atual', 'Simulado', 'Diferença', 'Observação']);
    let r = 4;
    const rows = {};
    const secao = texto => { r++; const c = ws.getCell(r, 1); c.value = texto; c.font = { bold: true, size: 11, color: { argb: AZUL } }; };
    // b/c: valor, fórmula (texto) ou função (linha → fórmula); edB/edC: célula amarela
    const linha = (id, rotulo, { b, c, fmt = NUM, edB = false, edC = false, tipo = 'item', obs = '', dif = true } = {}) => {
      r++;
      rows[id] = r;
      const row = ws.getRow(r);
      row.getCell(1).value = rotulo;
      const pb = row.getCell(2), pc = row.getCell(3);
      const val = v => (typeof v === 'function' ? { formula: v(r) } : typeof v === 'string' ? { formula: v } : v);
      if (b !== undefined) pb.value = val(b);
      if (c !== undefined) pc.value = val(c);
      pb.numFmt = fmt; pc.numFmt = fmt;
      if (dif && b !== undefined && c !== undefined) { const d = row.getCell(4); d.value = { formula: `IFERROR(C${r}-B${r},"")` }; d.numFmt = fmt; d.font = { color: { argb: 'FF636C76' } }; }
      if (edB) entrada(pb);
      if (edC) entrada(pc);
      if (obs) { row.getCell(5).value = obs; row.getCell(5).font = { size: 9, color: { argb: 'FF636C76' } }; }
      for (let k = 1; k <= 4; k++) {
        const cel = row.getCell(k);
        cel.border = borda;
        if (tipo === 'total') { cel.font = { ...(cel.font || {}), bold: true }; if (k > 1 && !(k <= 3 && (k === 2 ? edB : edC))) cel.fill = preenche(CINZA); }
        if (tipo === 'meta') { cel.font = { ...(cel.font || {}), bold: true }; if (k > 1) cel.fill = preenche(VERDE); }
      }
      if (tipo === 'item') row.getCell(1).alignment = { indent: 1 };
      return r;
    };
    const B = id => `B${rows[id]}`, C = id => `C${rows[id]}`;
    const igual = rr => `B${rr}`;

    secao('Parâmetros');
    linha('venda', 'Venda do mês', { b: l.venda, c: igual, edB: true, edC: true, tipo: 'total', obs: 'No simulado, a venda continua a mesma até você mudar.' });
    linha('m2', 'Metragem da loja (m²)', { b: l.m2 || null, c: rr => `IF(B${rr}="","",B${rr})`, fmt: M2, edB: true, edC: true, obs: 'Digite a área atual em Atual e a nova área em Simulado.' });
    linha('fator', 'Proporção da área', { b: 1, c: `IF(AND(N(B${rows.m2})>0,N(C${rows.m2})>0),C${rows.m2}/B${rows.m2},1)`, fmt: '0.00%', dif: false,
      obs: 'Aluguel, condomínio, FPP, ar e IPTU mudam nessa proporção.' });

    secao('Custos variáveis (% da venda)');
    const ls = linhaEmpresa[l.empresa];
    linha('simples', 'Simples (pela faixa da empresa)', { b: ls ? `Simples!H${ls}` : (l.variaveis?.simples || 0), c: ls ? `Simples!I${ls}` : (l.variaveis?.simples || 0),
      fmt: PCT, obs: 'Vem da aba Simples: acompanha a venda de todas as lojas da empresa.' });
    for (const [k, rot] of VARIAVEIS) linha('v_' + k, rot, { b: l.variaveis?.[k] || 0, c: igual, fmt: PCT, edB: true, edC: true });
    linha('var', 'Total dos custos variáveis', { b: `SUM(B${rows.simples}:B${r})`, c: `SUM(C${rows.simples}:C${r})`, fmt: PCT, tipo: 'total' });
    linha('mc', 'Margem de contribuição', { b: `1-${B('var')}`, c: `1-${C('var')}`, fmt: PCT, tipo: 'total' });

    secao('Custo do shopping (R$ por mês)');
    const primeiraS = r + 1;
    for (const [k, rot, area] of SHOPPING)
      linha('s_' + k, rot, { b: l.cto?.[k] || 0, c: area ? rr => `B${rr}*C${rows.fator}` : igual, edB: true, edC: true, obs: area ? '' : 'Não muda com a área (mude se quiser).' });
    linha('shop', 'Total do shopping (sem o aluguel percentual)', { b: `SUM(B${primeiraS}:B${r})`, c: `SUM(C${primeiraS}:C${r})`, tipo: 'total' });
    linha('alugPct', 'Aluguel percentual acima do mínimo', { b: `MAX(0,${B('venda')}*${P}-${B('s_aluguel')})`, c: `MAX(0,${C('venda')}*${P}-${C('s_aluguel')})`,
      obs: 'Quando o % sobre a venda passa do mínimo, o shopping cobra a diferença.' });

    secao('Por m²');
    const porM2 = (id, rot, v) => linha(id, rot, { b: `IF(N(B${rows.m2})>0,${v('B')}/B${rows.m2},"")`, c: `IF(N(C${rows.m2})>0,${v('C')}/C${rows.m2},"")` });
    porM2('vendaM2', 'Venda por m²', c => `${c}${rows.venda}`);
    porM2('alugM2', 'Aluguel por m² (mínimo + percentual)', c => `(${c}${rows.s_aluguel}+${c}${rows.alugPct})`);
    porM2('condM2', 'Condomínio por m²', c => `${c}${rows.s_condominio}`);
    porM2('shopM2', 'Custo total do shopping por m²', c => `(${c}${rows.shop}+${c}${rows.alugPct})`);
    linha('shopPct', 'Custo do shopping (% da venda)', { b: `IFERROR((${B('shop')}+${B('alugPct')})/${B('venda')},"")`, c: `IFERROR((${C('shop')}+${C('alugPct')})/${C('venda')},"")`, fmt: PCT });

    secao('Outras despesas fixas (R$ por mês)');
    const primeiraO = r + 1;
    for (const [k, rot] of OUTRAS) linha('o_' + k, rot, { b: l.fixas?.[k] || 0, c: igual, edB: true, edC: true });
    linha('outras', 'Total das outras despesas fixas', { b: `SUM(B${primeiraO}:B${r})`, c: `SUM(C${primeiraO}:C${r})`, tipo: 'total' });
    linha('fixo', 'Despesas fixas (shopping + outras)', { b: `${B('shop')}+${B('outras')}`, c: `${C('shop')}+${C('outras')}`, tipo: 'total' });

    secao('Resultado operacional');
    linha('mcR', 'Margem de contribuição (R$)', { b: `${B('venda')}*${B('mc')}`, c: `${C('venda')}*${C('mc')}` });
    linha('res', 'Resultado operacional', { b: `${B('mcR')}-${B('fixo')}-${B('alugPct')}`, c: `${C('mcR')}-${C('fixo')}-${C('alugPct')}`, tipo: 'total' });
    linha('resPct', 'Resultado operacional (% da venda)', { b: `IFERROR(${B('res')}/${B('venda')},0)`, c: `IFERROR(${C('res')}/${C('venda')},0)`, fmt: PCT, tipo: 'total' });

    // Venda para lucro x: fixas ÷ (margem − x); se aí o % do aluguel passa do mínimo,
    // o aluguel mínimo sai do fixo e o % entra no variável. O Simples fica o da coluna.
    const vendaPara = (col, x) => {
      const F = `${col}${rows.fixo}`, A = `${col}${rows.s_aluguel}`, M = `${col}${rows.mc}`;
      const r1 = `${F}/(${M}-${x})`, r2 = `(${F}-${A})/(${M}-${P}-${x})`;
      return `IF(${M}-${x}<=0,"não fecha",IF(${r1}*${P}<=${A},${r1},IF(${M}-${P}-${x}<=0,"não fecha",${r2})))`;
    };
    secao('Ponto de equilíbrio e metas (venda por mês)');
    linha('pe', 'Ponto de equilíbrio', { b: vendaPara('B', 0), c: vendaPara('C', 0), tipo: 'meta', obs: 'Usa o % do Simples da própria coluna.' });
    linha('peDia', 'Por dia (30 dias)', { b: `IFERROR(${B('pe')}/30,"")`, c: `IFERROR(${C('pe')}/30,"")` });
    lucros.forEach((x, j) => {
      const id = 'meta' + j;
      linha(id, `Venda para ${x}% de lucro`, { b: vendaPara('B', metas[j]), c: vendaPara('C', metas[j]), tipo: 'meta' });
      ws.getCell(rows[id], 1).value = { formula: `"Venda para "&ROUND(${metas[j]}*100,1)&"% de lucro"`, result: `Venda para ${x}% de lucro` };
      linha(id + 'd', 'Por dia (30 dias)', { b: `IFERROR(${B(id)}/30,"")`, c: `IFERROR(${C(id)}/30,"")` });
      linha(id + 'p', 'Acima da venda da coluna', { b: `IFERROR(${B(id)}/${B('venda')}-1,"")`, c: `IFERROR(${C(id)}/${C('venda')}-1,"")`, fmt: PCT, dif: false });
    });
    secao('Conferência');
    linha('opReal', 'Resultado operacional médio da DRE', { b: l.operacional ?? null, dif: false, obs: 'Valor real dos meses usados. O Atual pode diferir um pouco: o Simples aqui sai da faixa.' });
    linha('simplesReal', 'Simples médio da DRE (% da venda)', { b: l.variaveis?.simples ?? null, fmt: PCT, dif: false });

    // Quadro de funcionários: bruto de cada um (média dos meses); encargos só no total.
    // A coluna Fixo simulado (amarela) muda o salário fixo do Simulado.
    const quadro = l.quadro || [];
    if (quadro.length) {
      r += 2;
      const t = ws.getCell(r, 1);
      t.value = 'Quadro de funcionários (bruto por mês, média dos meses usados)';
      t.font = { bold: true, size: 11, color: { argb: AZUL } };
      r++;
      cabecalho(ws.getRow(r), ['Nome', 'Função', 'Salário fixo', 'Comissões', 'Premiações', 'V.T. e ajuda', 'Total bruto', 'Fixo simulado']);
      ws.getColumn(6).width = 14; ws.getColumn(7).width = 14; ws.getColumn(8).width = 14;
      const ini = r + 1;
      const pessoas = [...quadro, ...Array.from({ length: 3 }, () => ({ nome: '', cargo: 'Nova contratação', novo: true }))];
      for (const p of pessoas) {
        r++;
        const row = ws.getRow(r);
        row.getCell(1).value = p.nome || null;
        row.getCell(2).value = p.cargo + (p.meses && l.mesesKeys?.length && p.meses < l.mesesKeys.length ? ` (${p.meses} de ${l.mesesKeys.length} meses)` : '');
        [p.fixo, p.comissao, p.premiacao, p.ajuda].forEach((v, k) => { const c = row.getCell(k + 3); c.value = p.novo ? null : v || 0; c.numFmt = NUM; });
        row.getCell(7).value = { formula: `SUM(C${r}:F${r})` };
        row.getCell(8).value = p.novo ? null : { formula: `C${r}` };
        row.getCell(7).numFmt = NUM; row.getCell(8).numFmt = NUM;
        entrada(row.getCell(8));
        if (p.novo) { entrada(row.getCell(1)); row.getCell(2).font = { italic: true, color: { argb: 'FF636C76' } }; }
        for (let k = 1; k <= 8; k++) row.getCell(k).border = borda;
      }
      const fim = r;
      r++;
      const tot = ws.getRow(r);
      tot.getCell(1).value = { formula: `"Total · "&COUNTIF(C${ini}:C${fim},">0")&" pessoas"`, result: `Total · ${quadro.length} pessoas` };
      for (let k = 3; k <= 8; k++) { const L = ws.getColumn(k).letter; tot.getCell(k).value = { formula: `SUM(${L}${ini}:${L}${fim})` }; tot.getCell(k).numFmt = NUM; }
      for (let k = 1; k <= 8; k++) { const c = tot.getCell(k); c.font = { bold: true }; c.fill = preenche(CINZA); c.border = borda; }
      const totR = r;
      r++;
      const enc = ws.getRow(r);
      enc.getCell(1).value = { formula: `"Encargos ("&ROUND(${ENC}*100,1)&"% sobre fixo + comissões)"`, result: 'Encargos sobre fixo + comissões' };
      enc.getCell(7).value = { formula: `(C${totR}+D${totR})*${ENC}` };
      enc.getCell(8).value = { formula: `H${totR}*${ENC}` };
      enc.getCell(7).numFmt = NUM; enc.getCell(8).numFmt = NUM;
      r++;
      const ce = ws.getRow(r);
      ce.getCell(1).value = 'Total com encargos';
      ce.getCell(7).value = { formula: `G${totR}+G${r - 1}` }; ce.getCell(7).numFmt = NUM;
      ce.getCell(1).font = { bold: true }; ce.getCell(7).font = { bold: true };
      r++;
      const qs = ws.getRow(r);
      qs.getCell(1).value = 'Pessoas no simulado';
      qs.getCell(8).value = { formula: `COUNTIF(H${ini}:H${fim},">0")` };
      r++;
      const nota = ws.getCell(r, 1);
      nota.value = 'Fixo simulado: zere para tirar alguém, mude o salário ou preencha uma nova contratação. A diferença (com encargos) entra no Salários fixos do Simulado. Comissão e premiação seguem como % da venda.';
      nota.font = { size: 9, color: { argb: 'FF636C76' } };
      // Simulado = atual + diferença dos fixos do quadro, com encargos
      const sal = ws.getCell(rows.o_salFixos, 3);
      sal.value = { formula: `B${rows.o_salFixos}+(H${totR}-C${totR})*(1+${ENC})` };
      ws.getCell(rows.o_salFixos, 5).value = 'Simulado muda pelo quadro de funcionários (coluna Fixo simulado).';
      ws.getCell(rows.o_salFixos, 5).font = { size: 9, color: { argb: 'FF636C76' } };
      rows.qtd = totR; rows.qtdSim = r - 1;
    }
    pos[i] = rows;
  });

  // Simples: faixas do Anexo I e a alíquota efetiva de cada empresa
  const sp = wb.addWorksheet('Simples', { views: [{ showGridLines: false }] });
  [26, 30, 18, 18, 18, 18, 18, 16, 16].forEach((w, i) => { sp.getColumn(i + 1).width = w; });
  sp.getCell('A1').value = 'Simples Nacional · alíquota efetiva pela receita dos últimos 12 meses (RBT12)';
  sp.getCell('A1').font = { bold: true, size: 13, color: { argb: AZUL } };
  sp.getCell('A2').value = 'Alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12. O RBT12 simulado muda na mesma proporção da venda simulada das lojas da empresa.';
  sp.getCell('A2').font = { size: 9, color: { argb: 'FF636C76' } };
  cabecalho(sp.getRow(4), ['Faixa', 'Receita de (R$)', 'Receita até (R$)', 'Alíquota nominal', 'Parcela a deduzir']);
  FAIXAS.forEach(([ate, aliq, ded], i) => {
    const row = sp.getRow(5 + i), de = i ? FAIXAS[i - 1][0] + 0.01 : 0;
    row.getCell(1).value = `${i + 1}ª faixa`;
    row.getCell(2).value = de; row.getCell(3).value = ate; row.getCell(4).value = aliq; row.getCell(5).value = ded;
    row.getCell(2).numFmt = NUM; row.getCell(3).numFmt = NUM; row.getCell(4).numFmt = PCT; row.getCell(5).numFmt = NUM;
    for (let k = 2; k <= 5; k++) entrada(row.getCell(k));
  });
  const tab = `$B$5:$E$${4 + FAIXAS.length}`;
  cabecalho(sp.getRow(13), ['Empresa', 'Lojas', 'RBT12 (últimos 12 meses)', 'Venda atual das lojas (mês)', 'Venda simulada das lojas (mês)', 'RBT12 simulado',
    'Diferença no ano', 'Alíquota efetiva atual', 'Alíquota efetiva simulada']);
  const aliq = R => `IF(N(${R})<=0,0,(${R}*VLOOKUP(${R},${tab},3,TRUE)-VLOOKUP(${R},${tab},4,TRUE))/${R})`;
  for (const e of empresas) {
    const rr = linhaEmpresa[e], row = sp.getRow(rr);
    const idx = lojas.map((l, i) => (l.empresa === e ? i : -1)).filter(i => i >= 0);
    row.getCell(1).value = NOME_EMPRESA[e] || e;
    row.getCell(2).value = idx.map(i => lojas[i].nome).join(', ');
    const rbt = row.getCell(3); rbt.value = rbt12[e] || 0; rbt.numFmt = NUM; entrada(rbt);
    row.getCell(4).value = { formula: idx.map(i => `${q(abas[i])}!B${pos[i].venda}`).join('+') };
    row.getCell(5).value = { formula: idx.map(i => `${q(abas[i])}!C${pos[i].venda}`).join('+') };
    row.getCell(6).value = { formula: `IF(D${rr}=0,C${rr},C${rr}*E${rr}/D${rr})` };
    row.getCell(7).value = { formula: `F${rr}-C${rr}` };
    row.getCell(8).value = { formula: aliq(`C${rr}`) };
    row.getCell(9).value = { formula: aliq(`F${rr}`) };
    for (const k of [4, 5, 6, 7]) row.getCell(k).numFmt = NUM;
    row.getCell(8).numFmt = PCT; row.getCell(9).numFmt = PCT;
    for (let k = 1; k <= 9; k++) row.getCell(k).border = borda;
    row.getCell(9).font = { bold: true };
  }
  const nota = sp.getRow(14 + empresas.length + 1).getCell(1);
  nota.value = 'O RBT12 vem dos 12 meses antes do último mês usado na média (extrato do Simples ou tabela de faturamento). Pode digitar outro valor.';
  nota.font = { size: 9, color: { argb: 'FF636C76' } };

  // Resumo: os números principais de cada loja, lidos das abas
  const linhaR = 8;
  cabecalho(resumo.getRow(linhaR), ['Loja', 'Venda atual', 'Venda simulada', 'Resultado atual', 'Resultado simulado', '% simulado', 'Equilíbrio simulado',
    ...lucros.map(x => `Meta ${x}% (simulado)`), 'Área atual (m²)', 'Área simulada (m²)']);
  [16, 16, 16, 16, 12, 18, ...lucros.map(() => 18), 14, 14].forEach((w, i) => { resumo.getColumn(i + 2).width = w; });
  lojas.forEach((l, i) => {
    const row = resumo.getRow(linhaR + 1 + i), a = q(abas[i]), p = pos[i];
    row.getCell(1).value = { text: l.nome, hyperlink: `#${a}!A1` };
    row.getCell(1).font = { color: { argb: TINTA }, underline: true };
    const cels = [`B${p.venda}`, `C${p.venda}`, `B${p.res}`, `C${p.res}`, `C${p.resPct}`, `C${p.pe}`, ...lucros.map((_, j) => `C${p['meta' + j]}`), `B${p.m2}`, `C${p.m2}`];
    cels.forEach((ref, k) => {
      const c = row.getCell(k + 2);
      c.value = { formula: `${a}!${ref}` };
      c.numFmt = k === 4 ? PCT : k >= cels.length - 2 ? M2 : NUM;
      c.border = borda;
    });
    row.getCell(1).border = borda;
  });
  const tot = resumo.getRow(linhaR + 1 + lojas.length);
  tot.getCell(1).value = 'Total';
  for (const k of [2, 3, 4, 5]) {
    const L = resumo.getColumn(k).letter;
    tot.getCell(k).value = { formula: `SUM(${L}${linhaR + 1}:${L}${linhaR + lojas.length})` };
    tot.getCell(k).numFmt = NUM;
  }
  tot.getCell(6).value = { formula: `IFERROR(E${tot.number}/C${tot.number},0)` }; tot.getCell(6).numFmt = PCT;
  tot.eachCell(c => { c.font = { bold: true }; c.fill = preenche(CINZA); c.border = borda; });
  const n2 = resumo.getRow(tot.number + 2).getCell(1);
  n2.value = 'Clique no nome da loja para abrir a aba dela. Metragem, venda e custos se mudam lá; as metas e o % do aluguel, aqui.';
  n2.font = { size: 9, color: { argb: 'FF636C76' } };

  return wb.xlsx.writeBuffer();
}

module.exports = { gerarSimulacao };
