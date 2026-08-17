// Notas em trânsito entre uma competência e a seguinte.
//
// O relatório de XML do Microvix só extrai 30 dias. Uma nota emitida em 25/02 e
// lançada em 05/03 tem XML no lote de fevereiro e lançamento no relatório de
// março — nas duas apurações falta metade, e o imposto dela se perde. Guardar a
// nota já calculada quando o XML aparece resolve: o lançamento chegando no mês
// seguinte, ela volta inteira, sem precisar baixar o XML de novo.
//
// A chave da NF-e é o _id, então reapurar o mesmo mês atualiza o registro em vez
// de duplicá-lo. Nota que entra numa apuração finalizada sai daqui.
//
// As funções recebem o handle do Mongo porque quem o mantém é o server.js.

const COL = 'icmsNotasTransito';

let _indicesProntos = false;

async function _col(db) {
  const col = db.collection(COL);
  if (!_indicesProntos) {
    await col.createIndex({ cnpj: 1 });
    await col.createIndex({ doc: 1 });
    _indicesProntos = true;
  }
  return col;
}

/**
 * Guarda (ou atualiza) as notas que ficaram esperando o lançamento.
 * linhas: as linhas da apuração marcadas com `emTransito`.
 */
async function guardar(db, { competencia, linhas, usuario } = {}) {
  if (!db || !linhas || !linhas.length) return { guardadas: 0 };
  const col = await _col(db);
  const agora = new Date();

  const ops = linhas.filter(l => l.chave).map(l => ({
    updateOne: {
      filter: { _id: l.chave },
      update: {
        $set: {
          cnpj: l.cnpjEmpresa,
          empresa: l.empresa,
          doc: `${String(l.nNF).replace(/\D/g, '').replace(/^0+/, '')}/${String(l.serie).replace(/\D/g, '').replace(/^0+/, '') || '0'}`,
          nNF: l.nNF,
          serie: l.serie,
          dhEmi: l.dhEmi || null,
          fornecedor: l.fornecedor,
          vlrTotal: l.vlrTotal || 0,
          competenciaOrigem: competencia || null,
          linha: l,
          atualizadaEm: agora,
          atualizadaPor: usuario || null,
        },
        $setOnInsert: { guardadaEm: agora },
      },
      upsert: true,
    },
  }));
  if (!ops.length) return { guardadas: 0 };

  const r = await col.bulkWrite(ops, { ordered: false });
  return { guardadas: (r.upsertedCount || 0) + (r.modifiedCount || 0) };
}

/**
 * As notas guardadas que ainda esperam lançamento.
 * Devolve no formato que o cálculo espera: [{ doc, competenciaOrigem, linha }].
 */
async function buscar(db, { cnpjs } = {}) {
  if (!db) return [];
  const col = await _col(db);
  const filtro = cnpjs && cnpjs.length ? { cnpj: { $in: cnpjs } } : {};
  const docs = await col.find(filtro).toArray();
  return docs.map(d => ({
    doc: d.doc,
    chave: d._id,
    competenciaOrigem: d.competenciaOrigem,
    guardadaEm: d.guardadaEm,
    linha: d.linha,
  }));
}

/** Tira do trânsito as notas que já entraram numa apuração. */
async function consumir(db, chaves) {
  if (!db || !chaves || !chaves.length) return { removidas: 0 };
  const col = await _col(db);
  const r = await col.deleteMany({ _id: { $in: chaves.filter(Boolean) } });
  return { removidas: r.deletedCount };
}

/** Para a tela: o que está guardado, mais antigo primeiro. */
async function listar(db, { cnpj } = {}) {
  if (!db) return [];
  const col = await _col(db);
  return col.find(cnpj ? { cnpj } : {}).sort({ dhEmi: 1 }).toArray();
}

module.exports = { guardar, buscar, consumir, listar, COL };
