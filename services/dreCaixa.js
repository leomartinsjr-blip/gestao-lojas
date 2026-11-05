'use strict';
// Fechamento de Caixa da DRE/Resultados: a mesma distribuição da skill
// preencher-fechamento-caixa-2026, só com o que foi pago. É diferente da DRE,
// que olha a despesa do mês mesmo sem pagamento.

const LINHAS = [
  ['fornecedor', 'Fornecedor'], ['sistema', 'Sistema Microvix'], ['plano', 'Plano de saúde'], ['inss', 'INSS'],
  ['telefone', 'Telefone/Internet'], ['fgts', 'FGTS'], ['contabilidade', 'Contabilidade'], ['simples', 'Simples Nacional'],
  ['parcelamento', 'Parcelamento SN'], ['emprestimo', 'Empréstimo'], ['shopping', 'Shopping'], ['difal', 'ICMS DIFAL'],
  ['vt', 'V.T. / Ajuda de custo'], ['salario', 'Salário / Funcionário'], ['seguros', 'Seguros'], ['diversos', 'Diversos'],
  ['embalagens', 'Embalagens'], ['marketing', 'Marketing'], ['correios', 'Correios'], ['juros', 'Juros'],
  ['taxa', 'Taxa Rede'], ['caixinha', 'Caixinha'], ['classificar', 'A classificar'],
];

// A ordem importa: o primeiro que casar vale.
const MAPA = [
  [/PARCELAMENTO SIMPLES/, 'parcelamento'],
  [/SIMPLES NACIONAL/, 'simples'],
  [/ICMS/, 'difal'],
  [/\bJUROS\b|\bIOF\b/, 'juros'],
  [/EMPRESTIMO|EMPRÉSTIMO|PRONAMPE|FINANCIAMENTO/, 'emprestimo'],
  [/FGTS/, 'fgts'],
  [/\bINSS\b/, 'inss'],
  [/UNIMED|\bAMIL\b/, 'plano'],
  [/MICROVIX|\bLINX\b|GIVER/, 'sistema'],
  [/COLINI|CONTABILIDADE/, 'contabilidade'],
  [/\bVIVO\b|TELEFONE|NET CLARO|^NET$|BLINK/, 'telefone'],
  [/ALOSHOPPING/, 'diversos'],
  [/ALUGUEL|CONDOMINIO|CONDOMÍNIO|\bIPTU\b/, 'shopping'],
  [/VALE TRANSPORTE|TRANSFACIL|OTIMO DE BILHETAGEM|BHBUS|AJUDA DE CUSTO/, 'vt'],
  [/FOLHA DE PAGAMENTO|ADIANTAMENTO|TRCT|13º|FERIAS|FÉRIAS|SALÁRIOS A PAGAR|SALARIOS A PAGAR/, 'salario'],
  [/SEGURO|ALLIANZ/, 'seguros'],
  [/EMBALAGEN/, 'embalagens'],
  [/MIDIAS SOCIAIS|INSTAGRAM|MARKETING|CLARA SENRA|JONATHAN DE CASTRO/, 'marketing'],
  [/CORREIOS/, 'correios'],
  [/AREZZO|LUXOTTICA|COOPERSHOES|OUTSIDE|\bDASS\b|\bTESS\b|NEW BRASIL|VULCANOR|NEW ERA|MOZART|LOTUS|CASIO|\bPVH\b|TOMMY|HURLEY|OAKLEY|BILLABONG|QUIKSILVER|\bVANS\b|RIP CURL|OSKLEN|SURF CO|GET ONE|JP IND|SOUTH CENTRAL|LUNELLI/, 'fornecedor'],
  [/CARTÃO DE CREDITO|CARTAO DE CREDITO|MDIAS|M\. DIAS|ESTACIONAMENTO|EXTINFRAN|TARIFA|MAGNUM|MN ADVOGADOS|SINDICATO|TAXA FISC|PROTEGE|PRIME CERT|CARTORIO|CARTÓRIO|GRCSU|ADESIVOS|ESTRUTURAG|TECLAMUSIC|DESPESAS? DIVERSAS|ACHEI BRINDES|DEO COLONIA|MANUTENÇÃO|FUNDO DE CAIXA|CEMIG|FRANCIELE|APPMAX|GRAFICA/, 'diversos'],
];

const r2 = v => Math.round(v * 100) / 100;
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// escolhidos: { FORNECEDOR: linha } do Mapa de fornecedores, que vence o mapa padrão
function linhaCaixa(fornecedor, escolhidos = {}) {
  const n = norm(fornecedor);
  if (escolhidos[n]) return escolhidos[n];
  for (const [re, linha] of MAPA) if (re.test(n)) return linha;
  return 'classificar';
}

// pagos: [{ b, f, v }] · extras: { taxa: { loja: valor }, caixinha: {...} } · recebimentos: { loja: valor }
// ajustes: { loja: { linha: valor } } digitados na tela, que substituem o calculado
function montarCaixa({ lojas, pagos, extras = {}, recebimentos = {}, escolhidos = {}, ajustes = {} }) {
  const porLinha = Object.fromEntries(LINHAS.map(([id]) => [id, {}]));
  for (const { b, f, v } of pagos) {
    if (!v) continue;
    const nome = norm(f) || '(sem nome)';
    const alvo = (porLinha[linhaCaixa(nome, escolhidos)][nome] ||= {});
    alvo[b] = r2((alvo[b] || 0) + v);
  }
  const soma = Object.fromEntries(lojas.map(b => [b, 0]));
  const linhas = LINHAS.map(([id, nome]) => {
    const total = {}, ajustado = {};
    for (const b of lojas) {
      const fat = Object.values(porLinha[id]).reduce((s, x) => s + (x[b] || 0), 0);
      const calculado = r2(fat + (extras[id]?.[b] || 0));
      total[b] = ajustes[b]?.[id] ?? calculado;
      if (ajustes[b]?.[id] != null) ajustado[b] = calculado;
      soma[b] = r2(soma[b] + total[b]);
    }
    const detalhe = Object.entries(porLinha[id])
      .map(([n, valores]) => ({ nome: n, lojas: valores }))
      .sort((a, c) => a.nome.localeCompare(c.nome, 'pt-BR'));
    return { id, nome, lojas: total, detalhe, ajustado };
  }).filter(l => Object.values(l.lojas).some(Boolean));
  const resultado = Object.fromEntries(lojas.map(b => [b, r2((recebimentos[b] || 0) - soma[b])]));
  return { linhas, soma, recebimentos, resultado };
}

module.exports = { linhaCaixa, montarCaixa, LINHAS, norm };
