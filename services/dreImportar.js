'use strict';
// Leitura dos relatórios da Lez a Lez para a DRE/Resultados. Ela não tem Microvix:
// o sistema dela exporta VResumoVendas_Sku (venda e CMV) e FinPagarAnalitico (contas).
// Guarda só os totais do mês, nunca o arquivo.

const XLSX = require('xlsx');

const r2 = v => Math.round(v * 100) / 100;
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const rotulo = s => String(s || '').trim();

function linhas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
}

// O filtro da linha 1 traz o período em UTC ("30/09/2026, 21:00:00" é 01/10 no
// Brasil), então o mês do relatório sai da data final.
function mesDoFiltro(texto) {
  const datas = [...String(texto).matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
  if (!datas.length) return null;
  const chaves = datas.map(d => `${d[3]}-${d[2]}-${d[1]}`).sort();
  return chaves[chaves.length - 1].slice(0, 7);
}

function coluna(cabecalho, nome) {
  const i = cabecalho.findIndex(c => rotulo(c).toLowerCase() === nome.toLowerCase());
  if (i < 0) throw new Error(`Coluna "${nome}" não encontrada no relatório`);
  return i;
}

function lerVendas(rows) {
  const cab = rows[1];
  const iRec = coluna(cab, 'Valor Líq. - Dev.'), iCmv = coluna(cab, 'CMV Devolução');
  let receita = 0, cmv = 0, itens = 0;
  for (const r of rows.slice(2)) {
    if (!rotulo(r[0])) continue;
    receita += Number(r[iRec]) || 0;
    cmv += Number(r[iCmv]) || 0;
    itens++;
  }
  return { tipo: 'vendas', mes: mesDoFiltro(rows[0][1]), receita: r2(receita), cmv: r2(cmv), itens };
}

// Fornecedor da Lez → linha da DRE. "ignorar" é o que sai de outra fonte: mercadoria
// vem no CMV; salários e encargos, da folha; Simples, da alíquota.
const MAPA_LEZ = [
  [/LUNELLI/, 'ignorar'],
  [/SALÁRIOS A PAGAR|SALARIOS A PAGAR|ADIANTAMENTO|^INSS|^FGTS|SIMPLES NACIONAL/, 'ignorar'],
  [/LINX/, 'sistema'],
  [/COLINI/, 'contabilidade'],
  [/AMIL|UNIMED/, 'plano'],
  [/NET CLARO|VIVO|TELEFONE/, 'telefone'],
  [/SEGURO/, 'seguro'],
  [/MARKETING|CLARA SENRA|JONATHAN DE CASTRO/, 'publicidade'],
  [/JUROS|\bIOF\b/, 'juros'],
  [/EMPRESTIMO|EMPRÉSTIMO/, 'emprestimos'],
  [/AJUDA DE CUSTO|VALE TRANSPORTE/, 'vt'],
  [/ACHEI BRINDES|SINDICATO|DEO COLONIA|CORREIOS|MANUTENÇÃO AR|MANUTENCAO AR|FUNDO DE CAIXA/, 'diversos'],
];

function linhaLez(fornecedor) {
  const n = norm(fornecedor);
  for (const [re, linha] of MAPA_LEZ) if (re.test(n)) return linha;
  return null;
}

function dataSerial(n) {
  const d = XLSX.SSF.parse_date_code(n);
  return d ? `${d.y}-${String(d.m).padStart(2, '0')}` : null;
}

// Vale a data de competência; pago ou em aberto, como nas outras lojas.
function lerFaturas(rows) {
  const cab = rows[1];
  const iForn = coluna(cab, 'Nome Fornecedor'), iValor = coluna(cab, 'Valor Líquido');
  const iComp = coluna(cab, 'Data de Competencia');
  const iBaixado = coluna(cab, 'Valor Baixado'), iAberto = coluna(cab, 'Valor Em Aberto');
  const mes = mesDoFiltro(rows[0][1]);
  const totais = {}, aClassificar = {}, fornecedores = {};
  let documentos = 0, foraDoMes = 0;
  for (const r of rows.slice(2)) {
    const fornecedor = rotulo(r[iForn]);
    if (!fornecedor) continue;
    if (dataSerial(r[iComp]) !== mes) { foraDoMes++; continue; }
    documentos++;
    const valor = Number(r[iValor]) || 0;
    const nome = norm(fornecedor);
    const f = (fornecedores[nome] ||= { pago: 0, aberto: 0 });
    f.pago = r2(f.pago + (Number(r[iBaixado]) || 0));
    f.aberto = r2(f.aberto + (Number(r[iAberto]) || 0));
    const linha = linhaLez(fornecedor);
    if (linha === 'ignorar') continue;
    if (linha) totais[linha] = r2((totais[linha] || 0) + valor);
    else aClassificar[norm(fornecedor)] = r2((aClassificar[norm(fornecedor)] || 0) + valor);
  }
  return { tipo: 'faturas', mes, totais, aClassificar, fornecedores, documentos, foraDoMes };
}

function lerRelatorio(buffer) {
  const rows = linhas(buffer);
  const cab = (rows[1] || []).map(c => rotulo(c).toLowerCase());
  const relatorio = cab.includes('cmv devolução') ? lerVendas(rows)
    : cab.includes('nome fornecedor') ? lerFaturas(rows) : null;
  if (!relatorio) throw new Error('Arquivo não reconhecido: envie VResumoVendas_Sku ou FinPagarAnalitico');
  if (!relatorio.mes) throw new Error('Não encontrei o período no filtro da primeira linha');
  return relatorio;
}

module.exports = { lerRelatorio, linhaLez, mesDoFiltro };
