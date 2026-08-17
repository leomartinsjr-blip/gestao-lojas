// Leitor e comparador da planilha de recomposição que a contabilidade envia.
//
// O arquivo tem uma aba por competência ("05-2026"), com dois blocos — um por
// alíquota de origem — e as colunas:
//   NOTA FISCAL | VALOR PRODUTO | EXCLUSÃO ICMS INTEREST. | INCLUSÃO ICMS
//   INTERNO | DEBITO TRIBUTARIO | CRED TRIBUTÁRIO | ICMS A PAGAR
//
// O confronto é por número de nota. A planilha da contabilidade não traz série
// nem CNPJ, então a comparação é feita dentro da competência e o que ficar
// ambíguo é sinalizado em vez de casado no chute.

const XLSX = require('xlsx');

const TOLERANCIA = 0.05;   // centavos de arredondamento não são divergência

function _num(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  return parseFloat(s) || 0;
}

// "05-2026 " → "2026-05";  "09-2025" → "2025-09"
function _competenciaDaAba(nome) {
  const m = String(nome).trim().match(/(\d{2})[-/](\d{4})/);
  if (m) return `${m[2]}-${m[1]}`;
  const m2 = String(nome).trim().match(/(\d{4})[-/](\d{2})/);
  return m2 ? `${m2[1]}-${m2[2]}` : null;
}

/**
 * Lê o arquivo e devolve as notas informadas pela contabilidade.
 * [{ competencia, aliquota, nNF, base, aPagar }]
 */
function parseRecomposicao(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const notas = [];
  const competencias = [];

  for (const aba of wb.SheetNames) {
    const competencia = _competenciaDaAba(aba);
    if (competencia) competencias.push(competencia);
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '' });

    let aliquota = null;
    for (const linha of linhas) {
      const texto = linha.map(c => String(c).toUpperCase()).join(' ');

      if (/AL[ÍI]QUOTA\s+INTERESTADUAL\s*12/.test(texto)) { aliquota = 12; continue; }
      if (/AL[ÍI]QUOTA\s+INTERESTADUAL\s*4/.test(texto)) { aliquota = 4; continue; }
      if (/NOTA\s+FIC?AL/.test(texto)) continue;          // cabeçalho ("NOTA FICAL" no original)
      if (/TOTAL\s+GERAL/.test(texto)) { aliquota = null; continue; }
      if (!aliquota) continue;

      const nNF = String(linha[0] || '').trim();
      const base = _num(linha[1]);
      if (!nNF || !base) continue;

      notas.push({
        competencia,
        aliquota,
        nNF: nNF.replace(/\D/g, '').replace(/^0+/, ''),
        nNFOriginal: nNF,
        base,
        aPagar: _num(linha[6]),
      });
    }
  }

  return { competencias: [...new Set(competencias)], notas };
}

/**
 * Confronta o que a contabilidade mandou com o que a ferramenta apurou.
 *
 * O casamento é pelo número da nota. Uma nota pode aparecer nos dois blocos da
 * contabilidade (parte a 4%, parte a 12%), então os valores são somados por
 * número antes de comparar.
 */
function conferir(resultado, contabilidade, { competencia } = {}) {
  const daContabilidade = new Map();
  for (const n of contabilidade.notas) {
    if (competencia && n.competencia && n.competencia !== competencia) continue;
    if (!daContabilidade.has(n.nNF)) {
      daContabilidade.set(n.nNF, { nNF: n.nNF, nNFOriginal: n.nNFOriginal, base4: 0, base12: 0, aPagar: 0 });
    }
    const alvo = daContabilidade.get(n.nNF);
    if (n.aliquota === 4) alvo.base4 += n.base; else alvo.base12 += n.base;
    alvo.aPagar += n.aPagar;
  }

  const nossas = new Map();
  for (const emp of resultado.empresas) {
    for (const l of emp.linhas) {
      if (!l.incluida) continue;
      const k = String(l.nNF || '').replace(/\D/g, '').replace(/^0+/, '');
      if (!nossas.has(k)) {
        nossas.set(k, { nNF: k, doc: l.doc, fornecedor: l.fornecedor, empresa: emp.empresa, cnpj: emp.cnpj, base4: 0, base12: 0, difal: 0 });
      }
      const alvo = nossas.get(k);
      alvo.base4 += l.base4;
      alvo.base12 += l.base12;
      alvo.difal += l.difal;
    }
  }

  const conferem = [];
  const divergentes = [];
  const soNossas = [];
  const soDeles = [];

  for (const [k, nossa] of nossas) {
    const deles = daContabilidade.get(k);
    if (!deles) { soNossas.push(nossa); continue; }
    daContabilidade.delete(k);

    const dif = {
      base4: nossa.base4 - deles.base4,
      base12: nossa.base12 - deles.base12,
      aPagar: nossa.difal - deles.aPagar,
    };
    const bate = Math.abs(dif.base4) < TOLERANCIA
      && Math.abs(dif.base12) < TOLERANCIA
      && Math.abs(dif.aPagar) < TOLERANCIA;

    const registro = { ...nossa, deles, diferenca: dif };
    if (bate) conferem.push(registro);
    else divergentes.push(registro);
  }

  for (const [, deles] of daContabilidade) soDeles.push(deles);

  const somaNossa = [...nossas.values()].reduce((s, n) => s + n.difal, 0);
  const somaDeles = contabilidade.notas
    .filter(n => !competencia || !n.competencia || n.competencia === competencia)
    .reduce((s, n) => s + n.aPagar, 0);

  return {
    competencia: competencia || null,
    conferem,
    divergentes,
    soNossas,
    soDeles,
    totais: {
      nosso: somaNossa,
      contabilidade: somaDeles,
      diferenca: somaNossa - somaDeles,
      bate: Math.abs(somaNossa - somaDeles) < TOLERANCIA,
    },
  };
}

module.exports = { parseRecomposicao, conferir, TOLERANCIA };
