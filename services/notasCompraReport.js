// Leitor do "Relatório de Notas de Compra" exportado pelo Microvix.
//
// O arquivo tem extensão .xls mas é HTML puro, com números no formato brasileiro
// (1.234,56). Bibliotecas de planilha leem esse HTML e estragam os valores —
// "4.273,33" vira 4.27333 — então a leitura é feita direto na marcação.
//
// A lista que sai daqui é o filtro do cálculo do diferencial: só entra no
// imposto a nota que consta como lançada aqui. Nota recusada e devolvida ao
// fornecedor nunca aparece neste relatório.

const CABECALHOS = ['Emissão', 'Lçto', 'Ações', 'Doc/Série', 'Natureza de Operação',
  'Fornecedor', 'Itens', 'Pçs', 'Vlr.Total', 'Emp'];

// A marcação vem indentada, então há quebras de linha literais dentro das
// células que não significam nada. Só o <br> separa de verdade — ele vira um
// marcador que sobrevive à normalização dos espaços.
const QUEBRA = '';

function _semTags(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, QUEBRA)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(` ?${QUEBRA} ?`, 'g'), QUEBRA)
    .trim();
}

// "1.234,56" → 1234.56
function _numBr(s) {
  const t = String(s || '').replace(/[^\d,.-]/g, '');
  if (!t) return 0;
  return parseFloat(t.replace(/\./g, '').replace(',', '.')) || 0;
}

// "04/09/25" → "2025-09-04"
function _data(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return null;
  const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${ano}-${m[2]}-${m[1]}`;
}

/**
 * Lê o relatório e devolve { periodo, empresas, natureza, notas: [...] }.
 * Cada nota: { nNF, serie, doc, dtEmissao, dtLancamento, natOp, fornecedor,
 *              codFornecedor, itens, pecas, vlrTotal, emp }
 */
function parseRelatorio(html) {
  const texto = String(html);

  const filtro = rotulo => {
    const i = texto.indexOf(rotulo);
    if (i === -1) return '';
    return _semTags(texto.slice(i + rotulo.length, i + rotulo.length + 300).split('</tr>')[0]);
  };

  const linhas = [];
  const partes = texto.split(/<tr[^>]*>/i).slice(1);

  for (const parte of partes) {
    const corpo = parte.split(/<\/tr>/i)[0];
    const celulas = corpo.split(/<td[^>]*>/i).slice(1).map(c => _semTags(c.split(/<\/td>/i)[0]));
    if (celulas.length < CABECALHOS.length) continue;
    if (celulas[0] === 'Emissão') continue;

    // Doc/Série vem como "4590 /1" com "Chave NF-e" na linha de baixo.
    const docBruto = celulas[3].split(QUEBRA)[0].trim();
    const m = docBruto.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) continue;

    // Fornecedor vem como "72340-OUTSIDE CO LTDA" (código interno + nome).
    const forn = celulas[5].trim();
    const mf = forn.match(/^(\d+)\s*-\s*(.+)$/);

    linhas.push({
      nNF: m[1],
      serie: m[2],
      doc: `${m[1]}/${m[2]}`,
      dtEmissao: _data(celulas[0]),
      dtLancamento: _data(celulas[1]),
      natOp: celulas[4].replace(/^\[.\]\s*/, '').trim(),
      codFornecedor: mf ? mf[1] : '',
      fornecedor: mf ? mf[2] : forn,
      itens: _numBr(celulas[6]),
      pecas: _numBr(celulas[7]),
      vlrTotal: _numBr(celulas[8]),
      emp: celulas[9].trim(),
    });
  }

  return {
    periodo: filtro('Período:'),
    fornecedorFiltro: filtro('Fornecedor:'),
    natureza: filtro('Natureza de Operação:'),
    empresas: filtro('Empresas:'),
    notas: linhas,
  };
}

module.exports = { parseRelatorio };
