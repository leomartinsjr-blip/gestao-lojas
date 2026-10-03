'use strict';
// ── Medidor de tráfego de saída ────────────────────────────────────────────
// O Render cobra a banda "service-initiated" (o que o servidor troca com o
// Mongo Atlas, a Microvix etc.) acima de 5 GB/mês. Para saber quem gasta,
// conta bytes enviados e recebidos por origem — operação do Mongo por coleção
// e comando da Microvix — e grava o acumulado do dia em `trafego` a cada
// 10 min. GET /api/admin/trafego mostra.
const { BSON } = require('mongodb');

let pendente = {};   // categoria → { ops, env, rec }
const porRequisicao = new Map();   // requestId do Mongo → categoria

function contar(cat, enviados = 0, recebidos = 0) {
  const c = pendente[cat] || (pendente[cat] = { ops: 0, env: 0, rec: 0 });
  c.ops++;
  c.env += enviados;
  c.rec += recebidos;
}

const tamanho = obj => { try { return BSON.calculateObjectSize(obj); } catch { return 0; } };

// Coleção alvo do comando (insert/update/find/aggregate/... levam o nome nele)
function categoriaMongo(ev) {
  const nome = ev.commandName;
  const col = typeof ev.command?.[nome] === 'string' ? ev.command[nome] : '';
  return `mongo:${nome}${col ? ':' + col : ''}`;
}

const IGNORAR = new Set(['hello', 'isMaster', 'ismaster', 'ping', 'saslStart', 'saslContinue', 'endSessions', 'buildInfo']);

function monitorarMongo(client) {
  client.on('commandStarted', ev => {
    if (IGNORAR.has(ev.commandName)) return;
    const cat = categoriaMongo(ev);
    porRequisicao.set(ev.requestId, cat);
    contar(cat, tamanho(ev.command), 0);
  });
  const fim = (ev, ok) => {
    const cat = porRequisicao.get(ev.requestId);
    if (!cat) return;
    porRequisicao.delete(ev.requestId);
    if (ok) pendente[cat].rec += tamanho(ev.reply);
  };
  client.on('commandSucceeded', ev => fim(ev, true));
  client.on('commandFailed', ev => fim(ev, false));
}

const pad = n => String(n).padStart(2, '0');
function agoraBRT() {
  const d = new Date(Date.now() - 3 * 3600_000);
  return { dia: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hora: pad(d.getUTCHours()) };
}

// Chave de campo do Mongo não pode ter "." nem começar com "$"
const campo = s => s.replace(/\./g, '_').replace(/^\$/, '_');

async function gravar(mongoDb) {
  if (!mongoDb) return;
  const lote = pendente;
  pendente = {};
  const cats = Object.entries(lote);
  if (!cats.length) return;
  const { dia, hora } = agoraBRT();
  const inc = {};
  for (const [cat, v] of cats) {
    const k = campo(cat);
    inc[`cat.${k}.ops`] = v.ops;
    inc[`cat.${k}.env`] = v.env;
    inc[`cat.${k}.rec`] = v.rec;
    inc[`hora.${hora}.env`] = (inc[`hora.${hora}.env`] || 0) + v.env;
    inc[`hora.${hora}.rec`] = (inc[`hora.${hora}.rec`] || 0) + v.rec;
  }
  await mongoDb.collection('trafego').updateOne({ _id: dia }, { $inc: inc, $set: { at: new Date() } }, { upsert: true });
}

module.exports = { contar, monitorarMongo, gravar, tamanho };
