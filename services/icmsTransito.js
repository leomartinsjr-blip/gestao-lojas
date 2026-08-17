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

  // Nota já marcada como recusada não volta para a fila. Sem isto, reapurar o
  // mês da emissão a ressuscitaria toda vez: o XML dela continua no lote e o
  // lançamento nunca vai existir. O filtro é feito antes do upsert de
  // propósito — filtrar por status dentro dele daria erro de chave duplicada,
  // porque o upsert tentaria inserir um _id que já existe.
  const chaves = linhas.map(l => l.chave).filter(Boolean);
  const recusadas = new Set(
    (await col.find({ _id: { $in: chaves }, status: 'recusada' }, { projection: { _id: 1 } }).toArray())
      .map(d => d._id),
  );

  const ops = linhas.filter(l => l.chave && !recusadas.has(l.chave)).map(l => ({
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
        $setOnInsert: { guardadaEm: agora, status: 'aguardando' },
      },
      upsert: true,
    },
  }));
  if (!ops.length) return { guardadas: 0, ignoradasRecusadas: recusadas.size };

  const r = await col.bulkWrite(ops, { ordered: false });
  return {
    guardadas: (r.upsertedCount || 0) + (r.modifiedCount || 0),
    ignoradasRecusadas: recusadas.size,
  };
}

/**
 * As notas guardadas que ainda esperam lançamento.
 * Devolve no formato que o cálculo espera: [{ doc, competenciaOrigem, linha }].
 */
async function buscar(db, { cnpjs } = {}) {
  if (!db) return [];
  const col = await _col(db);
  const filtro = { status: { $ne: 'recusada' } };
  if (cnpjs && cnpjs.length) filtro.cnpj = { $in: cnpjs };
  const docs = await col.find(filtro).toArray();
  return docs.map(d => ({
    doc: d.doc,
    chave: d._id,
    status: d.status || 'aguardando',
    competenciaOrigem: d.competenciaOrigem,
    // Só as adiadas têm destino. Elas não esperam lançamento nenhum: entram
    // direto na competência marcada.
    competenciaDestino: d.competenciaDestino || null,
    guardadaEm: d.guardadaEm,
    linha: d.linha,
  }));
}

/**
 * Marca a nota como recusada e devolvida ao fornecedor. Ela sai da fila do
 * trânsito e para de cobrar conferência, mas o registro fica: é o que impede
 * ela de voltar quando o mês da emissão for reapurado, e o que permite
 * desfazer se a marcação tiver sido engano.
 */
async function recusar(db, { chave, motivo, usuario } = {}) {
  if (!db) throw new Error('Banco indisponível');
  if (!chave) throw new Error('Informe a chave da nota');
  const col = await _col(db);
  const r = await col.updateOne(
    { _id: chave },
    { $set: { status: 'recusada', motivoRecusa: motivo || null, recusadaEm: new Date(), recusadaPor: usuario || null } },
  );
  if (!r.matchedCount) throw new Error('Nota não está no trânsito');
  return { chave, status: 'recusada' };
}

/** Desfaz a marcação de recusada — a nota volta a esperar o lançamento. */
async function reativar(db, chave) {
  if (!db) throw new Error('Banco indisponível');
  const col = await _col(db);
  const r = await col.updateOne(
    { _id: chave },
    { $set: { status: 'aguardando' }, $unset: { motivoRecusa: '', recusadaEm: '', recusadaPor: '' } },
  );
  if (!r.matchedCount) throw new Error('Nota não está no trânsito');
  return { chave, status: 'aguardando' };
}

// "2026-02" → "2026-03"
function proximaCompetencia(competencia) {
  const [ano, mes] = String(competencia).split('-').map(Number);
  if (!ano || !mes) throw new Error('Competência inválida');
  return mes === 12 ? `${ano + 1}-01` : `${ano}-${String(mes + 1).padStart(2, '0')}`;
}

/**
 * Empurra uma nota já lançada para a competência seguinte.
 *
 * O caminho normal é o corte pela data de entrada, e é ele que vale. Isto aqui
 * existe para o caso em que a contabilidade lançou a nota em outro mês e não vai
 * corrigir: sem uma saída, a nota teria de ser desmarcada — e desmarcar não
 * guarda nada, o imposto dela simplesmente sumiria dos dois meses.
 *
 * A nota vai para o trânsito com destino marcado e volta sozinha lá, calculada
 * do mesmo jeito que estava aqui.
 */
async function adiar(db, { chave, linha, competencia, motivo, usuario } = {}) {
  if (!db) throw new Error('Banco indisponível');
  if (!chave) throw new Error('Informe a chave da nota');
  if (!competencia) throw new Error('Informe a competência');
  if (!linha) throw new Error('Nota sem dados para guardar');

  const destino = proximaCompetencia(competencia);
  const col = await _col(db);
  const agora = new Date();

  await col.updateOne(
    { _id: chave },
    {
      $set: {
        cnpj: linha.cnpjEmpresa,
        empresa: linha.empresa,
        doc: `${String(linha.nNF).replace(/\D/g, '').replace(/^0+/, '')}/${String(linha.serie).replace(/\D/g, '').replace(/^0+/, '') || '0'}`,
        nNF: linha.nNF,
        serie: linha.serie,
        dhEmi: linha.dhEmi || null,
        fornecedor: linha.fornecedor,
        vlrTotal: linha.vlrTotal || 0,
        status: 'adiada',
        competenciaOrigem: competencia,
        competenciaDestino: destino,
        motivoAdiamento: motivo || null,
        linha,
        adiadaEm: agora,
        adiadaPor: usuario || null,
      },
      $setOnInsert: { guardadaEm: agora },
    },
    { upsert: true },
  );
  return { chave, competenciaDestino: destino };
}

/** Desfaz o adiamento: a nota volta a pertencer à competência do lançamento. */
async function cancelarAdiamento(db, chave) {
  if (!db) throw new Error('Banco indisponível');
  const col = await _col(db);
  const r = await col.deleteOne({ _id: chave, status: 'adiada' });
  if (!r.deletedCount) throw new Error('Nota não está adiada');
  return { chave, removida: true };
}

/** Chave → competência de destino, das notas adiadas. */
async function adiamentos(db) {
  if (!db) return {};
  const col = await _col(db);
  const docs = await col.find({ status: 'adiada' }).toArray();
  const mapa = {};
  for (const d of docs) mapa[d._id] = d.competenciaDestino;
  return mapa;
}

/** As chaves marcadas como recusadas — o cálculo usa para não alarmar de novo. */
async function chavesRecusadas(db) {
  if (!db) return [];
  const col = await _col(db);
  const docs = await col.find({ status: 'recusada' }, { projection: { _id: 1 } }).toArray();
  return docs.map(d => d._id);
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

module.exports = {
  guardar, buscar, consumir, listar,
  recusar, reativar, chavesRecusadas,
  adiar, cancelarAdiamento, adiamentos, proximaCompetencia,
  COL,
};
