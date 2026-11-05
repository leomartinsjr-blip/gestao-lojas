'use strict';
// Cadastros da DRE/Resultados: custos do escritório e percentuais que antes ficavam
// em planilha. O que é editado aqui vale para todos os meses ainda não finalizados.

const r2 = v => Math.round(v * 100) / 100;
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

const SEIS = ['delrey', 'minas', 'contagem', 'estacao', 'tommy', 'lez'];
const CINCO = ['delrey', 'minas', 'contagem', 'tommy', 'lez'];

// origem: fixo (valor) · folha (pessoa na folha do board site) · faturas (fornecedor)
const PADRAO = {
  escritorio: [
    { id: 'ingrid', nome: 'Ingrid', origem: 'folha', termo: 'INGRID', encargos: true, lojas: SEIS },
    { id: 'laura', nome: 'Laura', origem: 'folha', termo: 'LAURA', encargos: true, lojas: SEIS },
    { id: 'sala-aluguel', nome: 'Sala: aluguel e IPTU', origem: 'faturas', termo: 'ED MONTEREY', empresa: 'site', lojas: SEIS },
    { id: 'sala-condominio', nome: 'Sala: condomínio', origem: 'faturas', termo: 'CONDOMINIO SHOPPING', empresa: 'site', lojas: SEIS },
    { id: 'sala-energia', nome: 'Sala: energia', origem: 'faturas', termo: 'CEMIG', empresa: 'site', lojas: SEIS },
    { id: 'plano', nome: 'Plano de saúde Leonardo e Leila', origem: 'fixo', valor: 2249.16, lojas: CINCO },
    { id: 'magnum', nome: 'Magnum (técnico de informática)', origem: 'faturas', termo: 'MAGNUM', lojas: CINCO },
    { id: 'mantuano', nome: 'Mantuano (MN Advogados)', origem: 'fixo', valor: 1401.08, lojas: SEIS },
  ],
  percentuais: { encargos: 29, aluguelPct: 5, icmsSite: 9.31, icmsLez: 8.98, embalagemLez: 1.4 },
};

function comPadrao(salvo) {
  return {
    escritorio: salvo?.escritorio?.length ? salvo.escritorio : PADRAO.escritorio,
    percentuais: { ...PADRAO.percentuais, ...(salvo?.percentuais || {}) },
  };
}

function validar(body) {
  const lista = Array.isArray(body?.escritorio) ? body.escritorio : null;
  if (!lista) return 'Lista de custos inválida';
  for (const i of lista) {
    if (!String(i.nome || '').trim()) return 'Todo custo precisa de nome';
    if (!['fixo', 'folha', 'faturas'].includes(i.origem)) return `Origem inválida em ${i.nome}`;
    if (i.origem === 'fixo' && !(Number(i.valor) >= 0)) return `Valor inválido em ${i.nome}`;
    if (i.origem !== 'fixo' && !String(i.termo || '').trim()) return `Informe a busca em ${i.nome}`;
    if (!Array.isArray(i.lojas) || !i.lojas.length || i.lojas.some(l => !SEIS.includes(l))) return `Escolha as lojas de ${i.nome}`;
  }
  for (const [k, v] of Object.entries(body.percentuais || {}))
    if (!(k in PADRAO.percentuais) || !(Number(v) >= 0)) return `Percentual inválido: ${k}`;
  return null;
}

// lancamentos: [{ b, f, v }] do mês · pessoas: [{ nome, valor }] da folha do escritório
function calcularEscritorio({ itens, encargos, pessoas, lancamentos }) {
  const porLoja = {}, detalhe = [], usados = new Set();
  for (const item of itens) {
    let valor = 0;
    const termo = norm(item.termo);
    if (item.origem === 'fixo') valor = Number(item.valor) || 0;
    if (item.origem === 'folha') valor = pessoas.filter(p => norm(p.nome).includes(termo)).reduce((s, p) => s + p.valor, 0);
    if (item.origem === 'faturas') {
      for (const l of lancamentos) {
        if (!norm(l.f).includes(termo) || (item.empresa && l.b !== item.empresa)) continue;
        valor += l.v;
        usados.add(l);
      }
    }
    if (item.encargos) valor *= 1 + encargos / 100;
    const cota = valor / item.lojas.length;
    const lojas = {};
    for (const b of item.lojas) { lojas[b] = r2(cota); porLoja[b] = (porLoja[b] || 0) + cota; }
    detalhe.push({ nome: `${item.nome}: ${r2(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} ÷ ${item.lojas.length}`, lojas });
  }
  for (const b of Object.keys(porLoja)) porLoja[b] = r2(porLoja[b]);
  return { porLoja, detalhe, usados };
}

module.exports = { PADRAO, comPadrao, validar, calcularEscritorio, SEIS };
