// Histórico das apurações do diferencial de alíquota.
//
// Existe por um motivo só: uma nota não pode ser paga duas vezes. A chave da
// NF-e é o identificador natural e é usada como _id, então o próprio banco
// recusa o segundo registro da mesma nota — a trava não depende de a tela
// lembrar de conferir.
//
// As funções recebem o handle do Mongo porque quem o mantém é o server.js.

const COL_NOTAS = 'icmsNotasApuradas';
const COL_APURACOES = 'icmsApuracoes';

let _indicesProntos = false;

async function _notas(db) {
  const col = db.collection(COL_NOTAS);
  if (!_indicesProntos) {
    await col.createIndex({ cnpj: 1, competencia: 1 });
    await col.createIndex({ dtLancamento: 1 });
    _indicesProntos = true;
  }
  return col;
}

/** Quais dessas chaves já foram apuradas antes. Mapa chave → registro. */
async function buscarApuradas(db, chaves) {
  if (!db || !chaves || !chaves.length) return {};
  const col = await _notas(db);
  const docs = await col.find({ _id: { $in: chaves } }).toArray();
  const mapa = {};
  for (const d of docs) mapa[d._id] = d;
  return mapa;
}

/**
 * Registra a apuração de uma empresa numa competência.
 * Notas já registradas antes são recusadas e devolvidas em `duplicadas` —
 * nunca sobrescritas.
 */
async function finalizar(db, { competencia, cnpj, empresa, linhas, usuario }) {
  if (!db) throw new Error('Banco indisponível');
  if (!competencia || !cnpj) throw new Error('Competência e CNPJ são obrigatórios');

  const col = await _notas(db);
  const chaves = linhas.map(l => l.chave).filter(Boolean);
  const jaExistem = await buscarApuradas(db, chaves);

  const novas = linhas.filter(l => l.chave && !jaExistem[l.chave]);
  const duplicadas = linhas
    .filter(l => l.chave && jaExistem[l.chave])
    .map(l => ({ doc: l.doc, chave: l.chave, competenciaAnterior: jaExistem[l.chave].competencia }));

  const semChave = linhas.filter(l => !l.chave).map(l => l.doc);

  const agora = new Date();
  if (novas.length) {
    await col.insertMany(novas.map(l => ({
      _id: l.chave,
      cnpj,
      competencia,
      doc: l.doc,
      nNF: l.nNF,
      serie: l.serie,
      dtLancamento: l.dtLancamento || null,
      dhEmi: l.dhEmi || null,
      fornecedor: l.fornecedor,
      ufOrigem: l.ufOrigem,
      base4: l.base4 || 0,
      base12: l.base12 || 0,
      difal4: l.difal4 || 0,
      difal12: l.difal12 || 0,
      difal: l.difal || 0,
      apuradaEm: agora,
      apuradaPor: usuario || null,
    })), { ordered: false });
  }

  const soma = campo => novas.reduce((s, l) => s + (l[campo] || 0), 0);
  await db.collection(COL_APURACOES).updateOne(
    { _id: `${cnpj}-${competencia}` },
    {
      $set: {
        cnpj,
        empresa,
        competencia,
        qtdNotas: novas.length,
        base4: soma('base4'),
        base12: soma('base12'),
        difal4: soma('difal4'),
        difal12: soma('difal12'),
        difal: soma('difal'),
        finalizadaEm: agora,
        finalizadaPor: usuario || null,
      },
    },
    { upsert: true },
  );

  return { registradas: novas.length, duplicadas, semChave };
}

/** Desfaz a finalização de uma competência — libera as notas para reapuração. */
async function estornar(db, { competencia, cnpj }) {
  if (!db) throw new Error('Banco indisponível');
  const col = await _notas(db);
  const r = await col.deleteMany({ cnpj, competencia });
  await db.collection(COL_APURACOES).deleteOne({ _id: `${cnpj}-${competencia}` });
  return { removidas: r.deletedCount };
}

/**
 * Consolida o que já foi apurado num intervalo de datas, por CNPJ.
 * O corte é pela data de lançamento da nota, que é o critério da apuração.
 * Devolve valor e participação por alíquota, mais a alíquota efetiva —
 * quanto o diferencial representa sobre a base comprada.
 */
async function resumo(db, { de, ate, cnpj } = {}) {
  if (!db) throw new Error('Banco indisponível');
  const col = await _notas(db);

  const filtro = {};
  if (cnpj) filtro.cnpj = cnpj;
  if (de || ate) {
    filtro.dtLancamento = {};
    if (de) filtro.dtLancamento.$gte = de;
    if (ate) filtro.dtLancamento.$lte = ate;
  }

  const docs = await col.find(filtro).toArray();

  const porCnpj = new Map();
  for (const d of docs) {
    if (!porCnpj.has(d.cnpj)) {
      porCnpj.set(d.cnpj, {
        cnpj: d.cnpj, qtdNotas: 0,
        base4: 0, base12: 0, difal4: 0, difal12: 0, difal: 0,
        competencias: new Set(),
      });
    }
    const e = porCnpj.get(d.cnpj);
    e.qtdNotas++;
    e.base4 += d.base4 || 0;
    e.base12 += d.base12 || 0;
    e.difal4 += d.difal4 || 0;
    e.difal12 += d.difal12 || 0;
    e.difal += d.difal || 0;
    e.competencias.add(d.competencia);
  }

  const empresas = [...porCnpj.values()].map(e => {
    const base = e.base4 + e.base12;
    return {
      ...e,
      competencias: [...e.competencias].sort(),
      baseTotal: base,
      // Quanto do diferencial veio de cada alíquota de origem.
      participacao4: e.difal ? e.difal4 / e.difal : 0,
      participacao12: e.difal ? e.difal12 / e.difal : 0,
      // Peso de cada alíquota na base comprada.
      participacaoBase4: base ? e.base4 / base : 0,
      participacaoBase12: base ? e.base12 / base : 0,
      // O que o diferencial representa sobre tudo que foi comprado.
      aliquotaEfetiva: base ? e.difal / base : 0,
    };
  }).sort((a, b) => b.difal - a.difal);

  const tot = empresas.reduce((s, e) => ({
    base4: s.base4 + e.base4, base12: s.base12 + e.base12,
    difal4: s.difal4 + e.difal4, difal12: s.difal12 + e.difal12,
    difal: s.difal + e.difal, qtdNotas: s.qtdNotas + e.qtdNotas,
  }), { base4: 0, base12: 0, difal4: 0, difal12: 0, difal: 0, qtdNotas: 0 });

  const baseTot = tot.base4 + tot.base12;
  return {
    periodo: { de: de || null, ate: ate || null },
    empresas,
    total: {
      ...tot,
      baseTotal: baseTot,
      participacao4: tot.difal ? tot.difal4 / tot.difal : 0,
      participacao12: tot.difal ? tot.difal12 / tot.difal : 0,
      participacaoBase4: baseTot ? tot.base4 / baseTot : 0,
      participacaoBase12: baseTot ? tot.base12 / baseTot : 0,
      aliquotaEfetiva: baseTot ? tot.difal / baseTot : 0,
    },
  };
}

/** Competências já finalizadas, mais recentes primeiro. */
async function listarApuracoes(db, { cnpj } = {}) {
  if (!db) throw new Error('Banco indisponível');
  const filtro = cnpj ? { cnpj } : {};
  return db.collection(COL_APURACOES).find(filtro).sort({ competencia: -1 }).toArray();
}

module.exports = { buscarApuradas, finalizar, estornar, resumo, listarApuracoes };
