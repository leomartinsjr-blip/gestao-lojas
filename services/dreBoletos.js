'use strict';
// Leitura dos boletos de shopping para a DRE/Resultados. Del Rey, Lez, Tommy e
// Contagem vêm com texto no PDF; Minas vem como imagem e passa pela IA. Nos dois
// casos a soma dos itens precisa bater com o valor da linha digitável.

const r2 = v => Math.round(v * 100) / 100;
const num = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));

const LOJA_POR_CNPJ = { 28519094: 'delrey', 32473768: 'minas', 35041602: 'contagem', 11106478: 'estacao', 60509746: 'tommy', 44602345: 'lez' };

function linhaDoItem(descricao) {
  const n = String(descricao).toUpperCase();
  if (/ALUGUEL M|DESCONTO/.test(n)) return 'aluguel';
  if (/FUNDO (DE )?PROMO|FPP/.test(n)) return 'fpp';
  if (/AR CONDICIONADO/.test(n)) return 'ar';
  if (/I\.?P\.?T\.?U/.test(n)) return 'iptu';
  if (/ENERGIA/.test(n)) return 'energia';
  return 'condominio'; // encargos comuns, fundo de reserva, seguros, dedetização
}

function itensDoTexto(texto) {
  const itens = [];
  for (const bruta of texto.split(/\r?\n/)) {
    const m = bruta.trim().match(/^(.*?)[\s-]*(\d{2}\/\d{4})(-?[\d.]+,\d{2})([\d.]+,\d{2})?$/);
    if (m) itens.push({ descricao: m[1].trim(), competencia: m[2], valor: num(m[4] || m[3]) });
  }
  return itens;
}

function dadosDoTexto(texto) {
  const cnpjs = [...texto.matchAll(/(\d{2})\.(\d{3})\.(\d{3})\/\d{4}-\d{2}/g)].map(m => +(m[1] + m[2] + m[3]));
  const linha = texto.match(/\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{4}(\d{10})/);
  const emissao = texto.match(/(\d{2})\.(\d{2})\.(\d{4})/) || texto.match(/Data do Documento\s*(\d{2})\/(\d{2})\/(\d{4})/);
  return {
    loja: LOJA_POR_CNPJ[cnpjs.find(c => LOJA_POR_CNPJ[c])] || null,
    total: linha ? +linha[1] / 100 : null,
    chave: linha ? linha[0].replace(/\D/g, '') : null,
    mesEmissao: emissao ? `${emissao[3]}-${emissao[2]}` : null,
    itens: itensDoTexto(texto),
  };
}

// dados: { loja, total, chave, mesEmissao, itens } do texto ou da IA
function fecharBoleto(dados) {
  const { loja, total, itens } = dados;
  if (!loja) throw new Error('Não reconheci a loja pelo CNPJ do boleto');
  if (!total) throw new Error('Não encontrei o valor do boleto');
  const valores = { aluguel: 0, condominio: 0, fpp: 0, ar: 0, iptu: 0, energia: 0 };
  if (!itens.length) valores.iptu = total; // boleto avulso da Del Rey, sem discriminação
  for (const i of itens) valores[linhaDoItem(i.descricao)] += i.valor;
  for (const k of Object.keys(valores)) valores[k] = r2(valores[k]);
  const soma = r2(Object.values(valores).reduce((s, v) => s + v, 0));
  if (Math.abs(soma - total) > 0.02) throw new Error(`A soma dos itens (${soma}) não bate com o boleto (${total})`);
  const aluguel = itens.find(i => /ALUGUEL M/i.test(i.descricao));
  const mes = aluguel ? aluguel.competencia.split('/').reverse().join('-') : dados.mesEmissao;
  if (!mes) throw new Error('Não encontrei o mês do boleto');
  return { tipo: 'boleto', loja, mes, total, valores, chave: dados.chave || `${loja}${mes}${total}`.replace(/\D/g, '') };
}

// Boleto escaneado: a IA devolve os mesmos campos que o texto daria.
async function lerPorIa(buffer) {
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'Este é um boleto de shopping. Responda só com JSON: {"cnpjPagador":"","valorTotal":0,"linhaDigitavel":"","itens":[{"descricao":"","competencia":"MM/AAAA","valor":0}]}. Liste cada item da descrição das despesas, sem subtotais. Valores em número com ponto decimal.' },
    ] }],
  });
  const texto = msg.content.find(b => b.type === 'text')?.text || '';
  const json = texto.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('Não consegui ler o boleto escaneado');
  const d = JSON.parse(json[0]);
  const raiz = +String(d.cnpjPagador).replace(/\D/g, '').slice(0, 8);
  return { loja: LOJA_POR_CNPJ[raiz] || null, total: Number(d.valorTotal), chave: String(d.linhaDigitavel || '').replace(/\D/g, '') || null,
    mesEmissao: null, itens: (d.itens || []).map(i => ({ descricao: i.descricao, competencia: i.competencia, valor: Number(i.valor) })) };
}

async function lerBoleto(buffer) {
  const { text } = await require('pdf-parse')(buffer);
  const dados = text.trim().length > 40 ? dadosDoTexto(text) : await lerPorIa(buffer);
  return fecharBoleto(dados);
}

module.exports = { lerBoleto, dadosDoTexto, fecharBoleto, linhaDoItem };
