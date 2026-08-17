// Ajustes manuais da apuração do diferencial de alíquota.
//
// Existem porque o XML nem sempre é a última palavra: a contabilidade pode
// apontar divergência na base, uma nota lançada pode não ter XML nenhum, e às
// vezes é preciso tirar uma nota da conta por decisão de quem apura.
//
// Todo ajuste guarda o valor original ao lado do novo e quem fez — sem isso o
// número perde rastreabilidade, que é justamente o que a ferramenta veio
// resolver. O ajuste é sempre por competência: mudar a base num mês não
// contamina os outros.
//
// Tipos:
//   edicao    troca a base 4% / 12% de uma nota que veio no lote
//   manual    inclui uma nota que não tem XML, com a base digitada
//   exclusao  tira da conta uma nota que entraria

const COL = 'icmsAjustes';

let _indicesProntos = false;

async function _col(db) {
  const col = db.collection(COL);
  if (!_indicesProntos) {
    await col.createIndex({ cnpj: 1, competencia: 1 });
    _indicesProntos = true;
  }
  return col;
}

function idDe({ cnpj, competencia, doc }) {
  return `${cnpj}|${competencia}|${doc}`;
}

async function listar(db, { cnpj, competencia } = {}) {
  if (!db) return [];
  const col = await _col(db);
  const filtro = {};
  if (cnpj) filtro.cnpj = cnpj;
  if (competencia) filtro.competencia = competencia;
  return col.find(filtro).toArray();
}

async function salvar(db, ajuste) {
  if (!db) throw new Error('Banco indisponível');
  const { cnpj, competencia, doc, tipo } = ajuste;
  if (!cnpj || !competencia || !doc) throw new Error('Informe empresa, competência e nota');
  if (!['edicao', 'manual', 'exclusao'].includes(tipo)) throw new Error(`Tipo de ajuste inválido: ${tipo}`);
  if (tipo !== 'exclusao' && !ajuste.motivo) throw new Error('Descreva o motivo do ajuste');

  const col = await _col(db);
  const _id = idDe(ajuste);
  await col.updateOne(
    { _id },
    { $set: { ...ajuste, _id, em: new Date() } },
    { upsert: true },
  );
  return { _id };
}

async function remover(db, _id) {
  if (!db) throw new Error('Banco indisponível');
  const col = await _col(db);
  const r = await col.deleteOne({ _id });
  return { removidos: r.deletedCount };
}

/**
 * Aplica os ajustes sobre o resultado de calcularPorEmpresa.
 * Recebe `recalcular(linha)` para refazer os passos e o difal da linha depois
 * de mexer nas bases — a fórmula mora no difal.js e não se repete aqui.
 */
function aplicar(resultado, ajustes, recalcular) {
  if (!ajustes || !ajustes.length) return resultado;

  const porEmpresa = new Map(resultado.empresas.map(e => [e.cnpj, e]));

  for (const aj of ajustes) {
    const emp = porEmpresa.get(aj.cnpj);
    if (!emp) {
      // Ajuste de empresa que não veio neste lote: ignora, mas não em silêncio.
      (resultado.ajustesOrfaos = resultado.ajustesOrfaos || []).push(aj);
      continue;
    }

    const linha = emp.linhas.find(l => l.doc.replace(/\s/g, '') === String(aj.doc).replace(/\s/g, ''));

    if (aj.tipo === 'exclusao') {
      if (linha) {
        linha.incluida = false;
        linha.motivo = `excluída manualmente${aj.motivo ? ` — ${aj.motivo}` : ''}`;
        linha.ajuste = { ...aj };
        linha.base4 = 0;
        linha.base12 = 0;
        recalcular(linha);
      }
      continue;
    }

    if (aj.tipo === 'edicao') {
      if (!linha) {
        (resultado.ajustesOrfaos = resultado.ajustesOrfaos || []).push(aj);
        continue;
      }
      linha.ajuste = {
        ...aj,
        base4Original: linha.base4,
        base12Original: linha.base12,
      };
      linha.base4 = Number(aj.base4) || 0;
      linha.base12 = Number(aj.base12) || 0;
      linha.incluida = linha.base4 > 0 || linha.base12 > 0;
      if (linha.incluida) linha.motivo = '';
      recalcular(linha);
      continue;
    }

    if (aj.tipo === 'manual') {
      if (linha) {
        // Já existe no lote — vira edição, para não duplicar a nota.
        linha.ajuste = { ...aj, base4Original: linha.base4, base12Original: linha.base12 };
        linha.base4 = Number(aj.base4) || 0;
        linha.base12 = Number(aj.base12) || 0;
        linha.incluida = linha.base4 > 0 || linha.base12 > 0;
        recalcular(linha);
        continue;
      }
      const nova = {
        chave: aj.chave || `manual:${idDe(aj)}`,
        doc: aj.doc,
        nNF: aj.nNF || String(aj.doc).split('/')[0],
        serie: aj.serie || String(aj.doc).split('/')[1] || '',
        dhEmi: aj.dhEmi || null,
        dtLancamento: aj.dtLancamento || null,
        natOp: aj.natOp || '',
        fornecedor: aj.fornecedor || 'informado manualmente',
        cnpjFornecedor: '',
        ufOrigem: aj.ufOrigem || '',
        cnpjEmpresa: aj.cnpj,
        empresa: emp.empresa,
        vlrTotal: Number(aj.vlrTotal) || (Number(aj.base4) || 0) + (Number(aj.base12) || 0),
        base4: Number(aj.base4) || 0,
        base12: Number(aj.base12) || 0,
        difal4: 0, difal12: 0, difal: 0,
        incluida: true,
        motivo: '',
        itensFora: [], itensST: [], revisar: [], atencao: [],
        selecionada: true,
        ajuste: { ...aj, base4Original: 0, base12Original: 0 },
      };
      recalcular(nova);
      emp.linhas.push(nova);
    }
  }

  return resultado;
}

module.exports = { listar, salvar, remover, aplicar, idDe };
