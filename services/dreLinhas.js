'use strict';
// Cálculo das linhas da DRE/Resultados, com as regras combinadas com o Leonardo em
// 04/11/2026. Só funções puras: quem lê banco e Microvix é services/dreResultados.js.

const { linhaCaixa } = require('./dreCaixa');
const REF = require('./dreReferencia.json');

const r2 = v => Math.round(v * 100) / 100;
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

const EMPRESA = { delrey: 'LMJ', site: 'LMJ', minas: 'JDG', contagem: 'PV', estacao: 'TTS', tommy: '3L', lez: 'LF' };
const ICMS_CADASTRADO = { site: 0.0931, lez: 0.0898 }; // sem apuração própria no módulo
const EMBALAGEM_CADASTRADA = { lez: 0.014 };
const GRUPO_SURFERS = ['delrey', 'minas', 'contagem', 'estacao', 'site'];
const TAXA_ENCARGOS = 0.29; // até haver 12 meses de folha no gestão
const PLANO_SOCIOS = 2249.16; // Leonardo e Leila, dividido por 5 (fora Estação e Site)
const MANTUANO_MES = 1401.08; // 6 empresas, 2 meses cada
const COTA_RATEIO = ['delrey', 'minas', 'contagem', 'tommy', 'lez'];
const FAIXAS = [[180000, 0.04, 0], [360000, 0.073, 5940], [720000, 0.095, 13860], [1800000, 0.107, 22500], [3600000, 0.143, 87300], [4800000, 0.19, 378000]];

function mesesAntes(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 2 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

// Alíquota efetiva do Simples: 12 meses anteriores da empresa. faturamentoExtra
// cobre os meses depois da tabela da planilha (fotos da Conferência e Lez importada).
function aliquotaSimples(board, mes, faturamentoExtra = {}) {
  const emp = EMPRESA[board];
  const rbt = mesesAntes(mes, 12).reduce((s, mk) => s + (REF.faturamento[mk]?.[emp] ?? faturamentoExtra[mk]?.[emp] ?? 0), 0);
  if (!rbt) return null;
  const [, aliq, deduzir] = FAIXAS.find(f => rbt <= f[0]) || FAIXAS[FAIXAS.length - 1];
  return (rbt * aliq - deduzir) / rbt;
}

// DIFAL ÷ base das notas, nas apurações dos últimos 12 meses da empresa.
function percentualIcms(board, mes, apuracoes = []) {
  if (ICMS_CADASTRADO[board] != null) return ICMS_CADASTRADO[board];
  const janela = new Set([mes, ...mesesAntes(mes, 11)]);
  let difal = 0, base = 0;
  for (const a of apuracoes) {
    if (!janela.has(a.competencia) || !String(a.empresa || '').trim().startsWith(EMPRESA[board])) continue;
    difal += a.difal || 0;
    base += (a.base4 || 0) + (a.base12 || 0);
  }
  return base ? difal / base : null;
}

// Pago em embalagens ÷ venda, nos últimos 12 meses. As Surfers e o Site formam um grupo.
function percentuaisEmbalagem(pagoPorLoja, vendaPorLoja) {
  const soma = (obj, lojas) => lojas.reduce((s, b) => s + (obj[b] || 0), 0);
  const out = { ...EMBALAGEM_CADASTRADA };
  const venda = soma(vendaPorLoja, GRUPO_SURFERS);
  const grupo = venda ? soma(pagoPorLoja, GRUPO_SURFERS) / venda : null;
  for (const b of GRUPO_SURFERS) out[b] = grupo;
  out.tommy = vendaPorLoja.tommy ? (pagoPorLoja.tommy || 0) / vendaPorLoja.tommy : null;
  return out;
}

// Folha do mês: fixos, comissões, premiações e ajuda por loja. O supervisor é
// rateado como na própria folha; sócio é pró-labore e não entra na loja.
function folhaPorLoja(folhaMes, employees = []) {
  if (!folhaMes) return null;
  const empPorId = Object.fromEntries(employees.map(e => [String(e.id), e]));
  const out = {};
  const loja = b => (out[b] ||= { fixos: 0, comissoes: 0, premiacoes: 0, ajuda: 0 });
  for (const [board, dados] of Object.entries(folhaMes)) {
    if (!dados?.entries) continue;
    loja(board);
    for (const [id, e] of Object.entries(dados.entries)) {
      if (e.tipo === 'socio') continue;
      const proventos = e.proventosBruto ?? e.proventos ?? 0;
      const fixo = e.fixo || 0, compl = e.gmComplement || 0, quebra = e.quebra || 0;
      const comissao = (e.comissaoTotal || 0) + (e.comissaoLoja || 0), ajuda = e.ajudaCustoTotal || 0;
      const resto = r2(proventos - fixo - compl - quebra - comissao - ajuda);
      const lojas = empPorId[id]?.supervisedBoards || [];
      if (e.tipo === 'supervisor' && lojas.length) {
        for (const b of lojas) {
          loja(b).fixos += fixo / lojas.length;
          loja(b).comissoes += (e.lojaComissoes || []).find(l => l.board === b)?.comissao || 0;
        }
        loja(board).fixos += compl + quebra;
        loja(board).premiacoes += resto;
        loja(board).ajuda += ajuda;
      } else {
        const l = loja(board);
        l.fixos += fixo + compl + quebra;
        l.comissoes += comissao;
        l.premiacoes += resto;
        l.ajuda += ajuda;
      }
    }
  }
  for (const l of Object.values(out)) for (const k of Object.keys(l)) l[k] = r2(l[k]);
  return out;
}

// Fornecedor → linha da DRE. null: sai de outra fonte (CMV, folha, Simples, ICMS,
// boleto) ou vai para o Escritório.
function linhaDre(fornecedor, board) {
  const n = norm(fornecedor);
  if (/PRO INDIVISO/.test(n)) return 'acordos';
  if (/TARIFA/.test(n)) return 'tarifa';
  if (/MAGNUM/.test(n)) return 'magnum';
  if (/MN ADVOGADOS/.test(n)) return 'mantuano';
  if (/APPMAX/.test(n)) return null;
  if (board === 'site' && /MONTEREY|CEMIG|CONDOMINIO/.test(n)) return 'sala';
  const mapa = { sistema: 'sistema', plano: 'plano', telefone: 'telefone', contabilidade: 'contabilidade', seguros: 'seguro',
    diversos: 'diversos', marketing: 'publicidade', correios: 'diversos', vt: 'vt', classificar: 'diversos' };
  return mapa[linhaCaixa(n)] || null;
}

function somarFaturas(lancamentos) {
  const totais = {}, detalhe = {};
  for (const { b, f, v } of lancamentos) {
    const linha = linhaDre(f, b);
    if (!linha || !v) continue;
    const t = (totais[b] ||= {});
    t[linha] = r2((t[linha] || 0) + v);
    const d = ((detalhe[linha] ||= {})[norm(f)] ||= {});
    d[b] = r2((d[b] || 0) + v);
  }
  return { totais, detalhe };
}

// Escritório: pessoal com encargos e sala por 6; plano e Magnum sem a Estação;
// Mantuano nas 6 empresas. O Site não recebe rateio.
function escritorio({ pessoal, sala, magnum }) {
  const base = (pessoal * (1 + TAXA_ENCARGOS) + sala) / 6 + MANTUANO_MES / 6;
  const out = { estacao: r2(base), site: 0 };
  for (const b of COTA_RATEIO) out[b] = r2(base + PLANO_SOCIOS / 5 + magnum / 5);
  return out;
}

const ESTRUTURA = [
  ['receita', 'Venda de produtos', 'total'],
  ['simples', 'Simples', 'item'], ['icms', 'ICMS de entrada', 'item'],
  ['receitaLiquida', 'Receita líquida', 'total'],
  ['cmv', 'CMV', 'item'], ['embalagens', 'Embalagens', 'item'], ['frete', 'Frete', 'item'],
  ['lucroBruto', 'Lucro bruto', 'total'],
  ['fixos', 'Salários fixos', 'item'], ['comissoes', 'Comissões', 'item'], ['encargos', 'Encargos', 'item'],
  ['escritorio', 'Escritório', 'item'], ['premiacoes', 'Premiações', 'item'], ['vt', 'V.T. e ajuda de custo', 'item'],
  ['ponto', 'Ponto comercial', 'item'],
  ['caixinha', 'Despesas caixinha', 'item'], ['sistema', 'Sistema ERP', 'item'], ['contabilidade', 'Contabilidade', 'item'],
  ['seguro', 'Seguro', 'item'], ['plano', 'Plano de saúde', 'item'], ['diversos', 'Despesas diversas', 'item'],
  ['telefone', 'Telefone/Internet', 'item'], ['publicidade', 'Publicidade', 'item'],
  ['taxa', 'Descontos de cartão', 'item'], ['tarifa', 'Tarifa', 'item'],
  ['operacional', 'Resultado operacional', 'total'],
  ['juros', 'Juros', 'item'],
  ['liquido', 'Resultado líquido', 'total'],
  ['emprestimos', 'Empréstimos', 'item'], ['acordos', 'Acordos de dívida', 'item'],
  ['sobra', 'Sobra depois das dívidas', 'total'],
];

// Lojas sem dado numa linha ficam null, e o resultado sai como parcial.
function fechar(l) {
  const v = k => l[k] || 0;
  const despesas = ['fixos', 'comissoes', 'encargos', 'escritorio', 'premiacoes', 'vt', 'ponto', 'caixinha', 'sistema', 'contabilidade',
    'seguro', 'plano', 'diversos', 'telefone', 'publicidade', 'taxa', 'tarifa'];
  const obrigatorias = ['receita', 'simples', 'icms', 'cmv', 'embalagens', ...despesas, 'juros'];
  const out = { ...l };
  out.receitaLiquida = r2(v('receita') - v('simples') - v('icms'));
  out.lucroBruto = r2(out.receitaLiquida - v('cmv') - v('embalagens') - v('frete'));
  out.operacional = r2(out.lucroBruto - despesas.reduce((s, k) => s + v(k), 0));
  out.liquido = r2(out.operacional - v('juros'));
  out.sobra = r2(out.liquido - v('emprestimos') - v('acordos'));
  out.faltam = obrigatorias.filter(k => l[k] == null);
  return out;
}

module.exports = { aliquotaSimples, percentualIcms, percentuaisEmbalagem, folhaPorLoja, linhaDre, somarFaturas, escritorio, fechar,
  mesesAntes, ESTRUTURA, EMPRESA, TAXA_ENCARGOS, REF };
