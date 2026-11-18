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
const NOME_EMPRESA = { LMJ: 'LMJ (Del Rey)', JDG: 'JDG (Minas)', PV: 'PV (Contagem)', TTS: 'TTS (Estação)', '3L': '3L (Tommy)', LF: 'LF (Lez)' };

const q = nome => `'${String(nome).replace(/'/g, "''")}'`;
const nomeAba = (nome, usados) => {
  let n = String(nome).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Loja';
  while (usados.has(n)) n = n.slice(0, 28) + ' ' + (usados.size + 1);
  usados.add(n); return n;
};
// Amarela = pode mexer (a planilha é protegida; o resto fica travado)
const entrada = c => { c.fill = preenche(AMARELO); c.font = { ...(c.font || {}), color: { argb: TINTA } }; c.protection = { locked: false }; };
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
    // Com quadro por cargo, salário fixo e comissão só mudam por ele (travados na loja)
    const temQuadro = (l.quadro || []).length > 0;
    const peloQuadro = k => temQuadro && ['comissoes', 'encVar', 'salFixos'].includes(k);
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
      fmt: PCT, obs: 'Vem da aba Simples. Simulado: venda simulada × 12 (o Site usa a alíquota da Del Rey).' });
    for (const [k, rot] of VARIAVEIS) linha('v_' + k, rot, { b: l.variaveis?.[k] || 0, c: igual, fmt: PCT, edB: !peloQuadro(k), edC: !peloQuadro(k) });
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
    for (const [k, rot] of OUTRAS) linha('o_' + k, rot, { b: l.fixas?.[k] || 0, c: igual, edB: !peloQuadro(k), edC: !peloQuadro(k) });
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

    // Quadro por cargo (média dos meses usados): quantidade, salário fixo por pessoa,
    // comissão em % da venda e garantia mínima (se fixo + comissão ficar abaixo, a loja
    // paga o complemento). Encargos só no total. As colunas amarelas do Simulado mudam
    // Salários fixos, Comissões e Encargos sobre comissões do Simulado.
    const nMeses = l.mesesKeys?.length || 1;
    const gm = l.garantiaMinima || {};
    // Mesma regra da folha: gerente e sub têm garantia própria; vendedor com fixo não tem
    const garantiaDe = p => (p.tipo === 'vendedor' && p.comFixo ? 0
      : p.tipo === 'gerente' ? gm.gerente || 0
      : (p.tipo === 'sub' || p.tipo === 'gvend') ? gm.sub || 0
      : p.tipo === 'supervisor' ? 0 : gm.geral || 0);
    const cargos = {};
    for (const p of l.quadro || []) {
      let nome = String(p.cargo || 'Sem cargo').trim() || 'Sem cargo';
      if (p.tipo === 'vendedor') nome += p.comFixo ? ' (fixo + comissão)' : ' (comissionado)';
      const c = (cargos[nome] ||= { nome, qtd: 0, fixo: 0, garantia: 0, comissao: 0, premiacao: 0, ajuda: 0, gm: garantiaDe(p) });
      c.qtd += (p.meses || nMeses) / nMeses;
      for (const k of ['fixo', 'garantia', 'comissao', 'premiacao', 'ajuda']) c[k] += p[k] || 0;
    }
    const lista = Object.values(cargos).sort((a, b) => (b.fixo + b.garantia) / (b.qtd || 1) - (a.fixo + a.garantia) / (a.qtd || 1));
    if (lista.length) {
      const V = `$B$${rows.venda}`, VS = `$C$${rows.venda}`;
      r += 2;
      const t = ws.getCell(r, 1);
      t.value = 'Quadro por cargo (bruto por mês, média dos meses usados)';
      t.font = { bold: true, size: 11, color: { argb: AZUL } };
      r++;
      // A–K atual, L–P simulado
      cabecalho(ws.getRow(r), ['Cargo', 'Quantidade', 'Salário fixo por pessoa', 'Total fixo', 'Comissão (% da venda)', 'Comissão (R$)',
        'Garantia mínima por pessoa', 'Complemento de garantia pago', 'Premiações', 'V.T. e ajuda', 'Total bruto',
        'Quantidade simulada', 'Salário simulado por pessoa', 'Comissão simulada (%)', 'Complemento de garantia simulado', 'Total fixo simulado', 'Complemento pela média (atual)']);
      ws.getRow(r).height = 44;
      for (let k = 6; k <= 17; k++) ws.getColumn(k).width = 15;
      const ini = r + 1;
      const linhasCargo = [...lista, ...Array.from({ length: 3 }, () => ({ nome: '', novo: true }))];
      for (const c of linhasCargo) {
        r++;
        const row = ws.getRow(r);
        row.getCell(1).value = c.novo ? null : c.nome;
        if (!c.novo) {
          row.getCell(2).value = Math.round(c.qtd * 100) / 100;
          row.getCell(4).value = c.fixo;
          row.getCell(6).value = c.comissao;
          row.getCell(8).value = c.garantia;
          row.getCell(9).value = c.premiacao;
          row.getCell(10).value = c.ajuda;
          row.getCell(12).value = { formula: `B${r}` };
          row.getCell(13).value = { formula: `C${r}` };
          row.getCell(14).value = { formula: `E${r}` };
        }
        row.getCell(7).value = c.novo ? null : c.gm || 0;
        row.getCell(3).value = { formula: `IF(N(B${r})=0,0,D${r}/B${r})` };
        row.getCell(5).value = { formula: `IFERROR(F${r}/${V},0)` };
        row.getCell(11).value = { formula: `D${r}+F${r}+H${r}+I${r}+J${r}` };
        // Por pessoa: se fixo + comissão (na venda simulada) ficar abaixo da garantia, paga a diferença
        row.getCell(15).value = { formula: `IF(OR(N(L${r})=0,N(G${r})=0),0,MAX(0,G${r}-(N(M${r})+N(N${r})*${VS}/L${r}))*L${r})` };
        row.getCell(16).value = { formula: `N(L${r})*N(M${r})` };
        // A mesma conta com os números atuais: o Simulado soma só a diferença entre as duas
        row.getCell(17).value = { formula: `IF(OR(N(B${r})=0,N(G${r})=0),0,MAX(0,G${r}-(N(C${r})+N(E${r})*${V}/B${r}))*B${r})` };
        row.getCell(2).numFmt = '0.0#'; row.getCell(12).numFmt = '0.0#';
        for (const k of [3, 4, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17]) row.getCell(k).numFmt = NUM;
        row.getCell(5).numFmt = PCT; row.getCell(14).numFmt = PCT;
        for (const k of [7, 12, 13, 14]) entrada(row.getCell(k));
        if (c.novo) { entrada(row.getCell(1)); row.getCell(1).note = 'Novo cargo: preencha o nome, a garantia mínima, a quantidade, o salário e a comissão no Simulado.'; }
        for (let k = 1; k <= 17; k++) row.getCell(k).border = borda;
      }
      const fim = r;
      r++;
      const tot = ws.getRow(r);
      tot.getCell(1).value = 'Total';
      for (const k of [2, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17]) {
        const L = ws.getColumn(k).letter;
        tot.getCell(k).value = { formula: `SUM(${L}${ini}:${L}${fim})` };
        tot.getCell(k).numFmt = [5, 14].includes(k) ? PCT : [2, 12].includes(k) ? '0.0#' : NUM;
      }
      tot.getCell(3).value = { formula: `IF(B${r}=0,0,D${r}/B${r})` }; tot.getCell(3).numFmt = NUM;
      tot.getCell(13).value = { formula: `IF(L${r}=0,0,P${r}/L${r})` }; tot.getCell(13).numFmt = NUM;
      for (let k = 1; k <= 17; k++) { const c = tot.getCell(k); c.font = { bold: true }; c.fill = preenche(CINZA); c.border = borda; }
      const totR = r;
      r++;
      const enc = ws.getRow(r);
      enc.getCell(1).value = { formula: `"Encargos ("&ROUND(${ENC}*100,1)&"% sobre fixo, garantia e comissões)"`, result: 'Encargos sobre fixo, garantia e comissões' };
      enc.getCell(11).value = { formula: `(D${totR}+H${totR}+F${totR})*${ENC}` };
      enc.getCell(16).value = { formula: `(P${totR}+O${totR}+N${totR}*${VS})*${ENC}` };
      enc.getCell(11).numFmt = NUM; enc.getCell(16).numFmt = NUM;
      r++;
      const ce = ws.getRow(r);
      ce.getCell(1).value = 'Total com encargos';
      ce.getCell(11).value = { formula: `K${totR}+K${r - 1}` }; ce.getCell(11).numFmt = NUM;
      ce.getCell(16).value = { formula: `P${totR}+O${totR}+N${totR}*${VS}+I${totR}+J${totR}+P${r - 1}` }; ce.getCell(16).numFmt = NUM;
      for (const k of [1, 11, 16]) ce.getCell(k).font = { bold: true };
      r++;
      const nota = ws.getCell(r, 1);
      nota.value = 'Garantia mínima: se o fixo + a comissão de cada pessoa ficar abaixo, a loja paga o complemento (vem da configuração da folha; vendedor com fixo não tem). '
        + 'Simulado: mude a quantidade, o salário por pessoa, a comissão ou a garantia de cada cargo (ou preencha um cargo novo). O complemento simulado usa a venda simulada.';
      nota.font = { size: 9, color: { argb: 'FF636C76' } };
      // Simulado = atual + diferença do quadro: fixo e garantia (com encargos) e comissão em % da venda
      const liga = (id, formula, texto) => {
        ws.getCell(rows[id], 3).value = { formula };
        ws.getCell(rows[id], 5).value = texto;
        ws.getCell(rows[id], 5).font = { size: 9, color: { argb: 'FF636C76' } };
      };
      liga('o_salFixos', `B${rows.o_salFixos}+(P${totR}-D${totR}+O${totR}-Q${totR})*(1+${ENC})`, 'Simulado muda pelo quadro por cargo (fixo + garantia mínima).');
      liga('v_comissoes', `B${rows.v_comissoes}+(N${totR}-E${totR})`, 'Simulado muda pela comissão dos cargos.');
      liga('v_encVar', `B${rows.v_encVar}+(N${totR}-E${totR})*${ENC}`, '');
      rows.qtd = totR;
    }
    pos[i] = rows;
  });

  // Simples: faixas do Anexo I e a alíquota efetiva de cada empresa
  const sp = wb.addWorksheet('Simples', { views: [{ showGridLines: false }] });
  [26, 30, 18, 18, 18, 18, 18, 16, 16, 30].forEach((w, i) => { sp.getColumn(i + 1).width = w; });
  sp.getCell('A1').value = 'Simples Nacional · alíquota efetiva pela receita dos últimos 12 meses (RBT12)';
  sp.getCell('A1').font = { bold: true, size: 13, color: { argb: AZUL } };
  sp.getCell('A2').value = 'Alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12. Atual: RBT12 real. Simulado: venda simulada do mês × 12 (como se vendesse assim o ano todo). A Del Rey é simulada sem o Site.';
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
    'Diferença no ano', 'Alíquota efetiva atual', 'Alíquota efetiva simulada', 'Situação no simulado']);
  const aliq = R => `IF(N(${R})<=0,0,(${R}*VLOOKUP(${R},${tab},3,TRUE)-VLOOKUP(${R},${tab},4,TRUE))/${R})`;
  for (const e of empresas) {
    const rr = linhaEmpresa[e], row = sp.getRow(rr);
    const todas = lojas.map((l, i) => (l.empresa === e ? i : -1)).filter(i => i >= 0);
    // Decisão do Leonardo: Del Rey simulada sozinha; o Site só usa a alíquota da LMJ
    const idx = todas.length > 1 ? todas.filter(i => lojas[i].board !== 'site') : todas;
    row.getCell(1).value = NOME_EMPRESA[e] || e;
    row.getCell(2).value = idx.map(i => lojas[i].nome).join(', ') + (idx.length < todas.length ? ' (o Site usa esta alíquota)' : '');
    const rbt = row.getCell(3); rbt.value = rbt12[e] || 0; rbt.numFmt = NUM; entrada(rbt);
    row.getCell(4).value = { formula: idx.map(i => `${q(abas[i])}!B${pos[i].venda}`).join('+') };
    row.getCell(5).value = { formula: idx.map(i => `${q(abas[i])}!C${pos[i].venda}`).join('+') };
    row.getCell(6).value = { formula: `E${rr}*12` };
    row.getCell(7).value = { formula: `F${rr}-C${rr}` };
    row.getCell(8).value = { formula: aliq(`C${rr}`) };
    row.getCell(9).value = { formula: aliq(`F${rr}`) };
    // Acima de 3,6 mi o ICMS sai do DAS (a alíquota da tabela cai, mas a carga sobe); acima de 4,8 mi sai do Simples
    row.getCell(10).value = { formula: `IF(F${rr}>4800000,"Sai do Simples",IF(F${rr}>3600000,"ICMS fora do DAS: carga maior",""))` };
    for (const k of [4, 5, 6, 7]) row.getCell(k).numFmt = NUM;
    row.getCell(8).numFmt = PCT; row.getCell(9).numFmt = PCT;
    for (let k = 1; k <= 10; k++) row.getCell(k).border = borda;
    row.getCell(9).font = { bold: true };
  }
  const ultimaE = 13 + empresas.length;
  if (empresas.length) sp.addConditionalFormatting({ ref: `F14:J${ultimaE}`, rules: [
    { type: 'expression', priority: 1, formulae: ['$F14>3600000'], style: { font: { color: { argb: 'FF9C0006' }, bold: true }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF8D7DA' } } } },
  ] });
  const nota = sp.getRow(14 + empresas.length + 1).getCell(1);
  nota.value = 'O RBT12 atual vem dos 12 meses antes do último mês usado na média (extrato do Simples ou tabela de faturamento). Pode digitar outro valor. Acima de R$ 3,6 milhões o ICMS é pago fora do DAS: a alíquota da tabela não mostra esse custo.';
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

  // Protege sem senha: só as células amarelas aceitam digitação
  for (const ws of wb.worksheets) await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true });
  return wb.xlsx.writeBuffer();
}

module.exports = { gerarSimulacao };
