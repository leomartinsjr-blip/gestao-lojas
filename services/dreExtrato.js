'use strict';
// Extrato do Simples (PGDAS-D) da contabilidade. Para fechar um mês vale o extrato do
// mês anterior: o de setembro traz a receita até setembro, que é o RBT12 de outubro.

const r2 = v => Math.round(v * 100) / 100;
const num = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
const valores = linha => (String(linha).match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).map(num);

const EMPRESA_POR_CNPJ = { '28519094': 'LMJ', '32473768': 'JDG', '35041602': 'PV', '11106478': 'TTS', '60509746': '3L', '44602345': 'LF' };

function mesSeguinte(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lerTexto(texto) {
  const cnpj = (texto.match(/CNPJ Básico:\s*([\d.]+)/) || [])[1]?.replace(/\D/g, '');
  const empresa = EMPRESA_POR_CNPJ[cnpj];
  if (!empresa) throw new Error('Não reconheci a empresa do extrato');
  const pa = texto.match(/Período de Apuração \(PA\):\s*(\d{2})\/(\d{4})/);
  if (!pa) throw new Error('Não encontrei o período do extrato');
  const mes = `${pa[2]}-${pa[1]}`;
  const rpa = valores((texto.match(/Receita Bruta do PA \(RPA\)[^\n]*/) || [''])[0]).pop();
  const rbt12 = valores((texto.match(/\(RBT12\)\s*\n([^\n]*)/) || [])[1]).pop();
  const bloco = (texto.split('2.2.1) Mercado Interno')[1] || '').split('2.2.2)')[0];
  const faturamento = {};
  for (const m of bloco.matchAll(/(\d{2})\/(\d{4})(\d{1,3}(?:\.\d{3})*,\d{2})/g)) faturamento[`${m[2]}-${m[1]}`] = num(m[3]);
  const fim = texto.split('4) Total Geral da Empresa')[1] || '';
  const debito = (fim.match(/Total do Débito Declarado[\s\S]*?\n[^\n]*Total\n([^\n]*)/) || [])[1];
  const das = valores(debito || '').pop();
  if (rpa == null || rbt12 == null || das == null) throw new Error('Não consegui ler os valores do extrato');
  faturamento[mes] = rpa;
  return { tipo: 'extrato', empresa, pa: mes, mes: mesSeguinte(mes), rpa, rbt12, das: r2(das), faturamento };
}

module.exports = { lerTexto, mesSeguinte };
