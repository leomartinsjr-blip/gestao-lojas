require('dotenv').config();
const express    = require('express');
const compress   = require('compression');
const session    = require('express-session');
const { MongoStore } = require('connect-mongo');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const ExcelJS    = require('exceljs');
const { MongoClient } = require('mongodb');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
// Mesma tabela que o navegador carrega em <script src="/perf-hist.js">
const { PERF_HIST } = require('./public/perf-hist.js');
const crypto     = require('crypto');
const { runSync, runSyncHoje, runSync30Dias, runSyncRetroativo, getStatus, setLastSync } = require('./services/microvixSync');
const { syncCustomers, sendWhatsApp: zapiSend, applyTemplate: crmTemplate, runScheduledCampaigns } = require('./services/crmSync');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage paths ──────────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const DATA_FILE   = path.join(DATA_DIR,  'data.json');
const USERS_FILE  = path.join(DATA_DIR,  'users.json');
const UPLOADS_DIR = path.join(DATA_DIR,  'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed users/data from bundle if not present
const SEED_USERS = path.join(__dirname, 'users.json');
const SEED_DATA  = path.join(__dirname, 'data.json');
if (!fs.existsSync(USERS_FILE) && fs.existsSync(SEED_USERS))
  fs.copyFileSync(SEED_USERS, USERS_FILE);
if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_DATA))
  fs.copyFileSync(SEED_DATA, DATA_FILE);

// ── MongoDB ────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoDb = null;

async function initMongo() {
  if (!MONGODB_URI) return;
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,  // tempo para encontrar primário no Atlas (cold start pode ser lento)
    tls: true,
    tlsAllowInvalidCertificates: false,
    maxPoolSize: 20,        // M0 suporta 500 conexões totais; o salvamento do catálogo em chunks
                            // (services/_saveCatalogMongo) usa várias conexões em paralelo — 10 era
                            // pouco e deixava outras operações (ex: conferência) na fila por dezenas
                            // de segundos até o gateway do Render cortar com 502
    minPoolSize: 1,
    maxIdleTimeMS: 30000,   // fecha conexões ociosas após 30s
    connectTimeoutMS: 30000,
  });
  await client.connect();
  mongoDb = client.db('gestao_lojas');

  // one-time migration from data.json if MongoDB collection is empty
  const existing = await mongoDb.collection('store').findOne({ _id: 'main' });
  if (!existing && fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      await mongoDb.collection('store').insertOne({ _id: 'main', ...data });
      console.log('✅  Dados migrados de data.json para MongoDB');
    } catch (e) { console.warn('Migração data.json falhou:', e.message); }
  }

  // Migração única: move fotos dos funcionários para documento separado
  // Isso reduz o documento principal de ~10MB para ~2MB
  try {
    const photosDoc = await mongoDb.collection('store').findOne({ _id: 'photos' });
    if (!photosDoc) {
      const mainDoc = await mongoDb.collection('store').findOne({ _id: 'main' });
      const emps = mainDoc?.employees || [];
      const photoData = {};
      for (const emp of emps) {
        if (emp.foto) photoData[String(emp.id)] = emp.foto;
      }
      await mongoDb.collection('store').insertOne({ _id: 'photos', data: photoData });
      if (Object.keys(photoData).length > 0) {
        // Remove fotos do documento principal
        await mongoDb.collection('store').updateOne(
          { _id: 'main' },
          { $set: { employees: emps.map(({ foto, ...e }) => e) } }
        );
        _photoCache = photoData;
        console.log(`✅  ${Object.keys(photoData).length} fotos migradas para documento separado`);
      } else {
        _photoCache = {};
      }
    } else {
      _photoCache = photosDoc.data || {};
    }
  } catch (e) { console.warn('Migração de fotos falhou:', e.message); _photoCache = {}; }

  // Migração única: users.json → MongoDB (senhas sobrevivem a redeploys)
  const usersDoc = await mongoDb.collection('users').findOne({ _id: 'main' });
  if (!usersDoc) {
    try {
      const f = fs.existsSync(USERS_FILE) ? USERS_FILE : SEED_USERS;
      const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
      await mongoDb.collection('users').insertOne({ _id: 'main', ...seed });
      _usersCache = seed;
      console.log('✅  Usuários migrados de users.json para MongoDB');
    } catch (e) { console.warn('Migração users.json falhou:', e.message); }
  } else {
    const { _id, ...users } = usersDoc;
    _usersCache = users;
    console.log(`✅  Usuários carregados do MongoDB (${Object.keys(users).length})`);
    // Patch: copia emails do users.json para o MongoDB se estiverem faltando
    try {
      const seedFile = fs.existsSync(SEED_USERS) ? SEED_USERS : null;
      if (seedFile) {
        const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        let updated = false;
        for (const [k, v] of Object.entries(seed)) {
          if (v.email && users[k] && !users[k].email) {
            users[k].email = v.email;
            updated = true;
          }
        }
        if (updated) {
          await mongoDb.collection('users').replaceOne({ _id: 'main' }, { _id: 'main', ...users });
          _usersCache = users;
          console.log('✅  Emails sincronizados do users.json para MongoDB');
        }
      }
    } catch (e) { console.warn('Patch de emails falhou:', e.message); }
  }

  console.log('✅  MongoDB conectado');
}

// ── DB helpers (async) ─────────────────────────────────────────────────────
// Cache de leitura: evita round-trips ao MongoDB quando não houve escrita.
// writeDB() invalida o cache para garantir dados frescos na próxima leitura.
let _dbCache      = null;
let _dbCacheDirty = false;

// Fotos armazenadas em documento separado { _id:'photos', data:{ empId: base64 } }
// Isso mantém o documento principal pequeno (<2MB) para leitura rápida
let _photoCache = null; // { empId: foto }

async function readPhotos() {
  if (_photoCache) return _photoCache;
  if (mongoDb) {
    const doc = await mongoDb.collection('store').findOne({ _id: 'photos' });
    _photoCache = doc?.data || {};
  } else {
    _photoCache = {};
  }
  return _photoCache;
}

async function writePhoto(empId, foto) {
  if (!_photoCache) await readPhotos();
  const key = String(empId);
  if (foto) _photoCache[key] = foto;
  else delete _photoCache[key];
  if (mongoDb) {
    await mongoDb.collection('store').replaceOne(
      { _id: 'photos' },
      { _id: 'photos', data: _photoCache },
      { upsert: true }
    );
  }
}

async function readDB() {
  if (_dbCache && !_dbCacheDirty) return _dbCache;
  if (mongoDb) {
    const doc = await mongoDb.collection('store').findOne({ _id: 'main' });
    if (!doc) { _dbCache = { nextId: 1, months: {}, cards: {} }; _dbCacheDirty = false; return _dbCache; }
    const { _id, contasPagar: _cp, ...data } = doc; // exclui contasPagar (migrado para cpFaturas)
    _dbCache = data;
    _dbCacheDirty = false;
    return _dbCache;
  }
  if (!fs.existsSync(DATA_FILE)) { _dbCache = { nextId: 1, months: {}, cards: {} }; return _dbCache; }
  try { _dbCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); _dbCacheDirty = false; return _dbCache; }
  catch { _dbCache = { nextId: 1, months: {}, cards: {} }; return _dbCache; }
}

async function writeDB(data) {
  _dbCache = data;
  _dbCacheDirty = false; // já temos o dado atualizado em cache
  if (mongoDb) {
    await mongoDb.collection('store').replaceOne(
      { _id: 'main' },
      { _id: 'main', ...data },
      { upsert: true }
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Cada fatura = documento individual em cpFaturas; meta em cpMeta.
// Isso evita acumular tudo em memória e mantém o store principal leve.
async function readContasPagar(dtIni, dtFin) {
  if (mongoDb) {
    const query = {};
    if (dtIni || dtFin) {
      query.vencimento = {};
      if (dtIni) query.vencimento.$gte = dtIni;
      if (dtFin) query.vencimento.$lte = dtFin;
    }
    const [rows, meta] = await Promise.all([
      mongoDb.collection('cpFaturas').find(query).toArray(),
      mongoDb.collection('cpMeta').findOne({ _id: 'main' }),
    ]);
    const { _id, ...m } = meta || {};
    return { rows, syncedAt: m.syncedAt || null, dtIni: m.dtIni, dtFin: m.dtFin, errors: m.errors || [] };
  }
  const db = await readDB();
  const cp = db.contasPagar || { rows: [], syncedAt: null };
  const rows = (cp.rows || []).filter(r => {
    if (!dtIni && !dtFin) return true;
    if (!r.vencimento) return true;
    if (dtIni && r.vencimento < dtIni) return false;
    if (dtFin && r.vencimento > dtFin) return false;
    return true;
  });
  return { ...cp, rows };
}

async function writeContasPagarBoard(board, rows) {
  if (mongoDb) {
    await mongoDb.collection('cpFaturas').deleteMany({ board });
    if (rows.length) await mongoDb.collection('cpFaturas').insertMany(rows);
    return;
  }
  // sem MongoDB: acumula no chamador para write único no JSON
}

async function writeContasPagarMeta(meta) {
  if (mongoDb) {
    await mongoDb.collection('cpMeta').replaceOne(
      { _id: 'main' },
      { _id: 'main', ...meta },
      { upsert: true }
    );
    return;
  }
  const db = await readDB();
  db.contasPagar = { ...(db.contasPagar || {}), ...meta };
  await writeDB(db);
}

function nextId(db) {
  const id = db.nextId;
  db.nextId = (db.nextId || 1) + 1;
  return id;
}

let _usersCache = null;

function readUsers() {
  if (_usersCache) return _usersCache;
  const f = fs.existsSync(USERS_FILE) ? USERS_FILE : SEED_USERS;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return {}; }
}

function writeUsers(users) {
  _usersCache = users;
  // Persiste no MongoDB — sobrevive a redeploys
  if (mongoDb) {
    mongoDb.collection('users').replaceOne(
      { _id: 'main' }, { _id: 'main', ...users }, { upsert: true }
    ).catch(e => console.warn('[Users] MongoDB write failed:', e.message));
  }
  // Fallback local (sem garantia em redeploy)
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (_) {}
}

const BOARDS   = ['admin','escritorio','delrey','minas','contagem','estacao','tommy','lez'];
const BOARDS_LABEL = {
  delrey:'DEL REY', minas:'MINAS', contagem:'CONTAGEM',
  estacao:'ESTAÇÃO', tommy:'TOMMY', lez:'LEZ A LEZ',
  escritorio:'ESCRITÓRIO', site:'SITE',
};
const SECTIONS = ['performance','estoque_marca','estoque_grupo','pauta','pendencias'];

// CFOPs de saída sem venda real (bonificação/doação de mercadoria) — não representam
// dinheiro recebido nem venda; excluídos do Fechamento e da Conferência de Caixa.
const CFOP_SEM_RECEITA = new Set(['5910', '6910']);

// ── Embalagens: catálogo, mínimos e contagem quinzenal ──────────────────────
// Fonte única do que cada loja conta e pede. A loja conta em PEÇAS (é o que ela
// enxerga na prateleira); o pedido sai em MÓDULOS (caixa fechada do fornecedor),
// arredondado pra cima. O mínimo e o tamanho do módulo são por loja, cadastrados
// pelo admin — o catálogo abaixo é só o ponto de partida.
const EMBAL_STORE_BOARDS = BOARDS.filter(b => b !== 'admin' && b !== 'escritorio');
const EMBAL_DIAS_CONTAGEM = 15;

// O pedido não sai loja a loja: as Surfers compram num pedido só, e Tommy e
// Lez têm fornecedor próprio. O consolidado soma a falta das lojas do grupo.
const EMBAL_GRUPOS = [
  { key: 'surfers', label: 'Surfers',   boards: ['delrey', 'minas', 'contagem', 'estacao'] },
  { key: 'tommy',   label: 'Tommy',     boards: ['tommy'] },
  { key: 'lez',     label: 'Lez a Lez', boards: ['lez'] },
];

// porTicket = quantas unidades do item saem por VENDA. Não é fatia de um bolo:
// cada item tem o seu, e somar 1 não significa nada. Seda é o caso que deixa
// isso claro — ela sai por PEÇA, então o padrão dela é o PA da loja.
const EMBALAGENS_BASE = [
  { key: 'sacola-papel-p',   nome: 'Sacola de Papel P',            porTicket: 0.455 },
  { key: 'sacola-papel-m',   nome: 'Sacola de Papel M',            porTicket: 0.455 },
  { key: 'sacola-papel-g',   nome: 'Sacola de Papel G',            porTicket: 0.09  },
  { key: 'sacola-plastico',  nome: 'Sacola de Plástico',           porTicket: 0     },
  { key: 'seda',             nome: 'Seda',                         porPeca:   1     },
  { key: 'adesivo-presente', nome: 'Etiqueta Adesivo de Presente', porTicket: 0     },
];

// Itens que não estão no catálogo base, por loja.
const EMBALAGENS_EXTRA = {
  // A Lez a Lez vende envelope institucional na mesma loja das sacolas.
  lez: [
    { key: 'envelope-papel-m', nome: 'Envelope M Institucional', porTicket: 0 },
  ],
  // Catálogo Antilhas
  tommy: [
    { key: 'caixa-p',          nome: 'Caixa P (215x175x80)',          porTicket: 0 },
    { key: 'caixa-m',          nome: 'Caixa M (340x285x80)',          porTicket: 0 },
    { key: 'caixa-tf-g',       nome: 'CX Tampa/Fundo G (445x315x95)', porTicket: 0 },
    { key: 'envelope-papel-m', nome: 'Envelope Papel M (300x70x400)', porTicket: 0 },
  ],
};

// Consumo por venda que difere do padrão do catálogo, por loja.
// Na Surfers a seda só vai em compra de presente, então está longe do PA —
// o 0,15 abaixo é chute conservador e some assim que duas contagens seguidas
// derem o número real. Na Tommy a seda vale o PA: cada peça é embrulhada.
const EMBALAGENS_CONSUMO_LOJA = {
  delrey:   { seda: 0.15 },
  minas:    { seda: 0.15 },
  contagem: { seda: 0.15 },
  estacao:  { seda: 0.15 },
  lez:      { seda: 0.15 },
  // Tommy quase não usa a P — o padrão do catálogo (0,455) veio do pedido da
  // Surfers e não vale aqui. O peso foi para M e G. Estes três são chute com
  // formato, não medição: somam 0,90 por venda, deixando 10% para caixa e
  // envelope de presente. A medição das contagens substitui em dois ciclos.
  tommy:    { 'sacola-papel-p': 0.05, 'sacola-papel-m': 0.60, 'sacola-papel-g': 0.25 },
};

// Sacola da Surfers (Embalagens & Cia). Não há código de catálogo — o pedido
// vai pelo nome do item. A G tem lote menor que as outras duas: ela sai bem
// menos, e fechar 100 nela seria quase um ano de estoque parado.
const EMBAL_LOTE_SURFERS = {
  'sacola-papel-p': { modulo: 100 },
  'sacola-papel-m': { modulo: 100 },
  'sacola-papel-g': { modulo:  50 },
};

// Códigos e peças/módulo do fornecedor, por loja. Só a Tommy tem código de
// catálogo (Antilhas). O admin pode sobrescrever o módulo item a item na tela
// de mínimos; isto aqui é só o padrão do fornecedor.
const EMBALAGENS_FORNECEDOR = {
  delrey:   EMBAL_LOTE_SURFERS,
  minas:    EMBAL_LOTE_SURFERS,
  contagem: EMBAL_LOTE_SURFERS,
  estacao:  EMBAL_LOTE_SURFERS,
  // Lez a Lez tem loja própria de material institucional. O módulo é a
  // quantidade mínima do site, que varia bastante de item para item.
  lez: {
    'sacola-papel-p':   { modulo: 50   },
    'sacola-papel-m':   { modulo: 50   },
    'sacola-papel-g':   { modulo: 50   },
    'envelope-papel-m': { modulo: 30   },
    'seda':             { modulo: 500  },
    'adesivo-presente': { modulo: 1000 },
  },
  tommy: {
    'sacola-papel-p':   { cod: 'IF00031', modulo: 25  },
    'sacola-papel-m':   { cod: 'IF00228', modulo: 25  },
    'sacola-papel-g':   { cod: 'IF00342', modulo: 25  },
    'seda':             { cod: 'IF00344', modulo: 200 },
    'adesivo-presente': { cod: 'IF00345', modulo: 1   },
    'caixa-p':          { cod: 'IF00688', modulo: 50  },
    'caixa-m':          { cod: 'IF00689', modulo: 25  },
    'caixa-tf-g':       { cod: 'IF00690', modulo: 20  },
    'envelope-papel-m': { cod: 'IF00343', modulo: 100 },
  },
};

// ── Dimensionamento do pedido ───────────────────────────────────────────────
// A conta é a que a operação usa:
//
//     pedido = consumo previsto dos próximos N meses + piso − estoque atual
//
// O horizonte anda pelo CALENDÁRIO, então atravessar dezembro puxa o volume de
// dezembro junto. É isso que faz o pedido do fim do ano ficar grande sozinho,
// sem ninguém lembrar de inflar.
const EMBAL_HORIZONTE_PADRAO = 3;  // meses de cobertura do pedido
const EMBAL_PISO_MESES_PADRAO = 2; // meses de estoque que a loja tem de ter na mão
const EMBAL_JANELA_NIVEL = 120;    // dias de histórico usados para medir o nível

// Meses de cobertura do pedido. Number(undefined) é NaN e NaN passa direto pelo
// ??, então o fallback precisa ser por isFinite.
function embalHorizonteMeses(db) {
  const v = Number(db?.embalagemParams?.horizonteMeses);
  return Number.isFinite(v) && v > 0 ? v : EMBAL_HORIZONTE_PADRAO;
}

// Meses de estoque que a loja precisa ter na mão. É o piso.
function embalPisoMeses(db) {
  const v = Number(db?.embalagemParams?.pisoMeses);
  return Number.isFinite(v) && v > 0 ? v : EMBAL_PISO_MESES_PADRAO;
}

// Quanto cada mês pesa contra o dia médio do ano, do histórico real de vendas.
// Cacheado: PERF_HIST é constante em runtime.
const _sazonalCache = {};

// Curva crua de uma loja e quantos anos completos ela tem.
function _curvaSazonal(board) {
  const DIAS_MES = [31,28,31,30,31,30,31,31,30,31,30,31];
  const soma = Array(12).fill(0), n = Array(12).fill(0);
  let anos = 0;
  for (const ano of [2023, 2024, 2025]) {
    const v = PERF_HIST[board]?.[ano];
    if (!v || v.some(x => x == null || x === 0)) continue;
    const mediaDia = v.reduce((s, x, i) => s + x / DIAS_MES[i], 0) / 12;
    if (!mediaDia) continue;
    anos++;
    v.forEach((x, i) => { soma[i] += (x / DIAS_MES[i]) / mediaDia; n[i]++; });
  }
  return { curva: soma.map((s, i) => (n[i] ? s / n[i] : 1)), anos };
}

// Um ano sozinho não é sazonalidade, é o que aconteceu naquele ano. A Tommy,
// por exemplo, só tem 2024 completo, e ali setembro deu 0,43 contra dezembro
// 3,83 — distorção de loja nova, não estação. Com menos de dois anos a curva
// entra pela média com a da rede, que tem três anos e o mesmo Natal.
function indiceSazonal(board) {
  if (_sazonalCache[board]) return _sazonalCache[board];
  const propria = _curvaSazonal(board);
  let idx;
  if (propria.anos >= 2) {
    idx = propria.curva;
  } else {
    const rede = _curvaSazonal('surfers').curva;
    idx = propria.anos === 1
      ? propria.curva.map((v, i) => (v + rede[i]) / 2)
      : rede;
  }
  _sazonalCache[board] = idx;
  return idx;
}

// Tickets/dia da loja, normalizados pela sazonalidade dos dias observados.
// Cada ticket é uma sacola. Devolve null quando não há histórico suficiente.
function nivelTickets(db, board, ateDateStr) {
  const idx = indiceSazonal(board);
  const fim = new Date(`${ateDateStr}T12:00:00`);
  const ini = new Date(fim); ini.setDate(ini.getDate() - EMBAL_JANELA_NIVEL);
  const iniStr = ini.toISOString().slice(0, 10);
  const porDia = {};
  for (const [key, vs] of Object.entries(db.vsales || {})) {
    // key = YYYY-MM-board-empId
    const partes = key.split('-');
    if (partes.slice(2, -1).join('-') !== board) continue;
    for (const [ds, en] of Object.entries(vs.entries || {})) {
      if (ds < iniStr || ds > ateDateStr) continue;
      if (!porDia[ds]) porDia[ds] = { tickets: 0, pecas: 0 };
      porDia[ds].tickets += en.atendimentos || 0;
      porDia[ds].pecas   += en.pecas || 0;
    }
  }
  const dias = Object.keys(porDia);
  if (dias.length < 20) return null;   // pouco histórico → cai no piso manual
  let tickets = 0, pecas = 0, pesoIdx = 0;
  for (const ds of dias) {
    tickets += porDia[ds].tickets;
    pecas   += porDia[ds].pecas;
    pesoIdx += idx[parseInt(ds.slice(5, 7)) - 1];
  }
  if (!(pesoIdx > 0) || !tickets) return null;
  return { nivel: tickets / pesoIdx, pa: pecas / tickets };
}

// Tickets previstos nos próximos N dias, andando pelo calendário.
function ticketsPrevistos(nivel, board, deDateStr, dias) {
  const DIAS_MES = [31,28,31,30,31,30,31,31,30,31,30,31];
  const idx = indiceSazonal(board);
  const d0 = new Date(`${deDateStr}T12:00:00`);
  let m = d0.getMonth(), dia = d0.getDate(), restam = dias, total = 0;
  while (restam > 0) {
    const disp = DIAS_MES[m] - dia + 1;
    const usa  = Math.min(disp, restam);
    total += nivel * idx[m] * usa;
    restam -= usa; dia = 1; m = (m + 1) % 12;
  }
  return total;
}

// Mesma coisa, mas em meses de calendário — 3 meses a partir de 15/out vai até
// 14/jan, não 90 dias corridos. É assim que o pedido é pensado.
function ticketsPrevistosMeses(nivel, board, deDateStr, meses) {
  const d0 = new Date(`${deDateStr}T12:00:00`);
  const fim = new Date(d0);
  fim.setMonth(fim.getMonth() + Math.floor(meses));
  const resto = meses - Math.floor(meses);
  if (resto > 0) fim.setDate(fim.getDate() + Math.round(resto * 30));
  return ticketsPrevistos(nivel, board, deDateStr, Math.round((fim - d0) / 86400000));
}

// Mede o consumo real entre a contagem anterior e a de agora:
//   consumo = tinha antes + recebeu no meio − tem agora
// dividido pelos tickets do período, dá o consumo por venda de verdade.
// Só substitui o padrão quando o período tem tamanho suficiente para significar
// algo, e entra suavizado — um ciclo atípico não deve virar a régua sozinho.
function medirConsumo(db, board, atual, anterior) {
  if (!anterior || !anterior.data || anterior.data >= atual.data) return null;
  const dias = Math.round((new Date(`${atual.data}T12:00:00`) - new Date(`${anterior.data}T12:00:00`)) / 86400000);
  if (dias < 5 || dias > 90) return null;

  // O que chegou na loja entre as duas contagens. Vale o recebimento lançado
  // pelo admin — quantidade e data reais, que é o que existe de fato quando a
  // entrega vem parcelada. Sem lançamento nenhum, cai no atalho antigo: a
  // requisição inteira, na data em que ela virou "recebido".
  const recebido = {};
  const porNome = Object.fromEntries(embalagensDaLoja(db, board, atual.data).map(i => [i.nome, i.key]));
  const somar = (qtds) => {
    for (const [nome, qtd] of Object.entries(qtds || {})) {
      const k = porNome[nome];
      if (k) recebido[k] = (recebido[k] || 0) + (Number(qtd) || 0);
    }
  };
  // Entrega lançada direto na tela de embalagens: é o caminho normal do
  // pedido único das Surfers, que chega parcelado na sala 505 e é rateado
  // entre as lojas sem passar por requisição nenhuma. Guarda a chave do item,
  // não o nome.
  for (const e of (db.entregasEmbalagem || [])) {
    if (e.board !== board) continue;
    if (!(e.data > anterior.data && e.data <= atual.data)) continue;
    for (const [k, q] of Object.entries(e.itens || {})) {
      recebido[k] = (recebido[k] || 0) + (Number(q) || 0);
    }
  }
  for (const r of (db.requisicoes || [])) {
    if (r.board !== board) continue;
    if (r.recebimentos?.length) {
      for (const rc of r.recebimentos) {
        if (rc.data > anterior.data && rc.data <= atual.data) somar(rc.qtd);
      }
      continue;
    }
    if (r.status !== 'recebido') continue;
    const quando = (r.updatedAt || r.createdAt || '').slice(0, 10);
    if (quando <= anterior.data || quando > atual.data) continue;
    somar(r.embalagens);
  }

  // Tickets do período
  let tickets = 0;
  for (const [key, vs] of Object.entries(db.vsales || {})) {
    if (key.split('-').slice(2, -1).join('-') !== board) continue;
    for (const [ds, en] of Object.entries(vs.entries || {})) {
      if (ds > anterior.data && ds <= atual.data) tickets += en.atendimentos || 0;
    }
  }
  if (tickets < 20) return null;

  const out = {};
  for (const it of [...EMBALAGENS_BASE, ...(EMBALAGENS_EXTRA[board] || [])]) {
    const antes = anterior.contagem?.[it.key];
    const agora = atual.contagem?.[it.key];
    if (antes == null || agora == null) continue;
    const consumo = antes + (recebido[it.key] || 0) - agora;
    // Negativo significa entrada não registrada; não dá para medir nesse ciclo.
    if (consumo < 0) continue;
    out[it.key] = consumo / tickets;
  }
  return Object.keys(out).length ? out : null;
}

// Guarda a medição suavizada contra a anterior (média móvel simples de 2).
function gravarConsumoMedido(db, board, medido) {
  if (!medido) return;
  if (!db.embalagemMix) db.embalagemMix = {};
  const at = db.embalagemMix[board] || {};
  for (const [k, v] of Object.entries(medido)) {
    at[k] = at[k] != null ? (at[k] + v) / 2 : v;
  }
  db.embalagemMix[board] = at;
}

// Consumo por venda de cada item. Vale o medido das contagens quando houver;
// senão o que o admin cadastrou; senão o padrão de fábrica do catálogo — que já
// vem preenchido para o sistema funcionar sem ninguém digitar nada.
function fatorConsumo(db, board, pa) {
  const cfg    = (db.embalagemConfig || {})[board] || {};
  const medido = (db.embalagemMix || {})[board];
  const out = {};
  const daLoja = EMBALAGENS_CONSUMO_LOJA[board] || {};
  for (const it of [...EMBALAGENS_BASE, ...(EMBALAGENS_EXTRA[board] || [])]) {
    const padrao = daLoja[it.key] != null ? daLoja[it.key]
                 : it.porPeca != null ? it.porPeca * (pa || 0)
                 : (it.porTicket || 0);
    const doAdmin = Number(cfg[it.key]?.porTicket);
    out[it.key] = medido?.[it.key] != null ? medido[it.key]
                : Number.isFinite(doAdmin) && doAdmin > 0 ? doAdmin
                : padrao;
  }
  return out;
}

// Duas coisas diferentes, de propósito:
//
//   min       — piso FIXO da loja, cadastrado pelo admin. É o alarme: abaixo
//               disso a loja precisa ser avisada. Número estável, que a equipe
//               da loja consegue guardar de cabeça.
//   cobertura — quanto o item vai consumir até a próxima entrega chegar, já
//               com a sazonalidade do calendário. É o que DIMENSIONA O PEDIDO.
//
// Separar os dois resolve o caso de novembro: a loja pode estar acima do piso
// e mesmo assim precisar de um pedido grande, porque dezembro está chegando.
// Peças por módulo. O que o admin cadastrou vence — mas só quando é de fato um
// lote (>1). A tela de mínimos sempre gravou 1 nas lojas que ainda não tinham
// catálogo do fornecedor, e esse 1 antigo ficaria por cima do lote quando o
// catálogo chegasse: a loja com piso já cadastrado continuaria pedindo em peça
// avulsa, e a que nunca foi salva pediria em caixa fechada. Mesmo item, mesmo
// fornecedor, número diferente conforme alguém tivesse clicado em Salvar.
function moduloEmbalagem(doAdmin, doFornecedor) {
  const m = Math.round(Number(doAdmin) || 0);
  if (m > 1) return m;
  return Math.max(1, Math.round(Number(doFornecedor) || 0));
}

function embalagensDaLoja(db, board, hoje, mesesOverride) {
  const cfg   = (db.embalagemConfig || {})[board] || {};
  const pad   = EMBALAGENS_FORNECEDOR[board] || {};
  const ref   = hoje || todayBRT();
  const meses = mesesOverride || embalHorizonteMeses(db);
  const ciclo = EMBAL_DIAS_CONTAGEM;
  const nv    = nivelTickets(db, board, ref);
  const fator = fatorConsumo(db, board, nv?.pa);
  const prev  = nv ? ticketsPrevistosMeses(nv.nivel, board, ref, meses) : null;
  // Piso = os meses de estoque que a loja tem de ter na mão, medidos sobre o
  // consumo PREVISTO desses meses, não sobre um mês médio. Assim ele já sobe
  // antes de dezembro: 2 meses de dezembro é muito mais sacola que 2 meses de
  // janeiro, e um piso de mês médio cobriria só 6 dias no pico.
  const pisoM = embalPisoMeses(db);
  const plano = nv ? ticketsPrevistosMeses(nv.nivel, board, ref, pisoM) : null;

  return [...EMBALAGENS_BASE, ...(EMBALAGENS_EXTRA[board] || [])].map(it => {
    const f = fator[it.key];
    const ativo = prev != null && f > 0;
    const manual = Math.max(0, Number(cfg[it.key]?.min) || 0);
    const sugerido = ativo ? Math.ceil(plano * f) : null;
    return {
      key:    it.key,
      nome:   it.nome,
      cod:    pad[it.key]?.cod || null,
      // Sem piso cadastrado vale o sugerido — assim o alarme já funciona sem
      // ninguém digitar, e acompanha a venda. Cadastrar fixa o número.
      min:    manual > 0 ? manual : (sugerido || 0),
      minAuto: !(manual > 0),
      minSugerido: sugerido,
      // só o gasto previsto no horizonte
      consumo:     ativo ? Math.ceil(prev * f) : null,
      pisoMeses:   pisoM,
      // alvo = gastar os próximos N meses e AINDA terminar com o piso na mão
      cobertura:   ativo ? Math.ceil(prev * f) + (manual > 0 ? manual : (sugerido || 0)) : null,
      meses,
      porTicket:   f,
      modulo: moduloEmbalagem(cfg[it.key]?.modulo, pad[it.key]?.modulo),
    };
  });
}

// Alvo do pedido: cobrir o consumo previsto, não só voltar ao piso. Quando não
// há histórico para projetar, cai no piso fixo — comportamento antigo.
function alvoPedido(item) {
  return item.cobertura != null ? Math.max(item.cobertura, item.min) : item.min;
}

// Consumo projetado mês a mês, para o ano inteiro. É o que faz o pedido do fim
// do ano ser grande sozinho: dezembro vende ~3,2x janeiro no histórico, então o
// horizonte que atravessa dezembro puxa esse volume junto.
function projecaoAnual(db, board, hoje) {
  const DIAS_MES = [31,28,31,30,31,30,31,31,30,31,30,31];
  const ref = hoje || todayBRT();
  const nv  = nivelTickets(db, board, ref);
  if (!nv) return null;
  const idx   = indiceSazonal(board);
  const meses = idx.map((v, i) => Math.round(nv.nivel * v * DIAS_MES[i]));
  const total = meses.reduce((a, b) => a + b, 0);
  const pico  = meses.indexOf(Math.max(...meses));
  return { meses, total, pico, base100: meses.map(m => Math.round(m / meses[0] * 100)) };
}

// Cobertura prevista da loja: quantas sacolas ela vai gastar no horizonte e
// como isso se compara com o mês corrente. Usado para explicar o número na tela.
function coberturaLoja(db, board, hoje) {
  const ref   = hoje || todayBRT();
  const meses = embalHorizonteMeses(db);
  const nv = nivelTickets(db, board, ref);
  if (!nv) return { nivel: null, pa: null, meses, previsto: null, indice: null };
  const mesIdx = parseInt(ref.slice(5, 7)) - 1;
  return {
    nivel: nv.nivel,
    pa:    nv.pa,
    meses,
    previsto:  ticketsPrevistosMeses(nv.nivel, board, ref, meses),
    indice:    indiceSazonal(board)[mesIdx],
  };
}

// Falta em peças → módulos a pedir, sempre arredondando pra cima (caixa fechada).
// A falta é medida contra o ALVO (consumo previsto), não contra o piso: em
// novembro a loja pode estar acima do piso e ainda assim precisar pedir.
// `abaixoDoPiso` é o que dispara o alerta na tela da loja.
function sugestaoEmbalagem(item, contado) {
  const tem   = Math.max(0, Number(contado) || 0);
  const alvo  = alvoPedido(item);
  const falta = Math.max(0, alvo - tem);
  const modulos = falta > 0 ? Math.ceil(falta / item.modulo) : 0;
  return { alvo, falta, modulos, pecas: modulos * item.modulo, abaixoDoPiso: item.min > 0 && tem < item.min };
}

// Estoque de hoje não é o que a loja contou: entre a contagem e agora pode ter
// chegado entrega. Somar isso é o que impede o pedido de comprar de novo o que
// acabou de descer do caminhão — e o piso de acusar falta em loja abastecida.
//
// A contagem crua fica intacta no registro: medirConsumo() depende dela para
// fechar `antes + recebido − agora`, e somar aqui também zeraria a conta.
//
// Entrega na data da própria contagem conta como já contada — mesma convenção
// da janela de medirConsumo(), onde o dia da contagem anterior fica de fora.
function entreguesDesde(db, board, dataCorte) {
  const out = {};
  for (const e of (db.entregasEmbalagem || [])) {
    if (e.board !== board || !(e.data > dataCorte)) continue;
    for (const [k, q] of Object.entries(e.itens || {})) out[k] = (out[k] || 0) + (Number(q) || 0);
  }
  return out;
}

function addDias(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Itens da última contagem que estão abaixo do piso da loja. É o que acende o
// aviso no painel, e é uma pergunta diferente da contagem atrasada: a loja pode
// estar em dia com o prazo e mesmo assim já ter furado o mínimo. Reaproveita o
// abaixoDoPiso da tela da loja para o painel nunca discordar da linha vermelha
// que o gerente vê na contagem.
function itensAbaixoDoPiso(db, board, itens) {
  const ultima = (db.contagensEmbalagem || [])
    .filter(c => c.board === board)
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''))[0];
  if (!ultima) return null;
  const entregue = entreguesDesde(db, board, ultima.data);
  const abaixo = [];
  for (const it of (itens || embalagensDaLoja(db, board))) {
    const contado = ultima.contagem?.[it.key];
    if (contado == null) continue;
    const ent = entregue[it.key] || 0;
    const s = sugestaoEmbalagem(it, contado + ent);
    if (s.abaixoDoPiso) abaixo.push({ key: it.key, nome: it.nome, contado: contado + ent, entregue: ent, min: it.min, falta: s.falta });
  }
  return { data: ultima.data, itens: abaixo };
}

// Status da contagem quinzenal de uma loja: quando foi a última, quando vence a
// próxima e há quantos dias está atrasada (nunca contou → atrasada desde já).
function statusContagem(db, board) {
  const ultima = (db.contagensEmbalagem || [])
    .filter(c => c.board === board)
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''))[0] || null;
  const hoje = todayBRT();
  const proxima = ultima ? addDias(ultima.data, EMBAL_DIAS_CONTAGEM) : hoje;
  const diasAtraso = Math.max(0, Math.round(
    (new Date(`${hoje}T12:00:00`) - new Date(`${proxima}T12:00:00`)) / 86400000));
  return {
    board,
    ultimaData: ultima?.data || null,
    ultimaPor:  ultima?.createdBy || null,
    proxima,
    atrasada: !ultima || hoje >= proxima,
    diasAtraso,
  };
}

function monthKey(y, m) { return `${y}-${String(m).padStart(2,'0')}`; }
function cardKey(y, m, board, section) { return `${monthKey(y,m)}-${board}-${section}`; }

function ensureCard(db, y, m, board, section) {
  const mk = monthKey(y, m);
  if (!db.months[mk]) db.months[mk] = { id: nextId(db), year: y, month: m };
  const ck = cardKey(y, m, board, section);
  if (!db.cards[ck]) db.cards[ck] = { id: nextId(db), content: '', items: [], attachments: [] };
  return db.cards[ck];
}

// ── Multer ─────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Session ────────────────────────────────────────────────────────────────
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'gestao-lojas-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
};
if (MONGODB_URI) {
  sessionOpts.store = MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'gestao_lojas', ttl: 8 * 3600 });
}

// ── Email (recuperação de senha) ───────────────────────────────────────────
const emailTransporter = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
  : null;

// Reset tokens: token → { username, expires }
const resetTokens = new Map();

app.use(compress());
app.use(express.json({ limit: '50mb' }));
app.use(session(sessionOpts));
// Serve JS/CSS sem cache para garantir que deploys chegam ao navegador
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  const users = readUsers();
  const u = users[req.session.user.username];
  if (u && u.passwordChangedAt) {
    if (!req.session.user.passwordChangedAt) {
      // Sessão antiga (criada antes do controle de senha) — sincroniza sem bloquear
      req.session.user.passwordChangedAt = u.passwordChangedAt;
    } else if (u.passwordChangedAt !== req.session.user.passwordChangedAt) {
      // Senha trocada por outra sessão — invalida
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Sessão expirada — senha alterada. Faça login novamente.' });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  const u = req.session.user;
  if (u.board || (u.lojas && u.lojas.length))
    return res.status(403).json({ error: 'Acesso restrito' });
  next();
}

// ── POST /api/login ────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const key   = (username || '').toLowerCase();
  const user  = users[key];
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  req.session.user = { username: key, board: user.board, lojas: user.lojas || null, label: user.label, passwordChangedAt: user.passwordChangedAt || null, mustChangePassword: !!user.mustChangePassword };
  res.json({ username: key, board: user.board, lojas: user.lojas || null, label: user.label, mustChangePassword: !!user.mustChangePassword });
});

// ── POST /api/logout ───────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── POST /api/change-password  (próprio usuário) ───────────────────────────
app.post('/api/change-password', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Senha muito curta (mínimo 4 caracteres)' });
  const users = readUsers();
  const key = req.session.user.username;
  const ts = Date.now().toString();
  users[key].password = password;
  users[key].passwordChangedAt = ts;
  users[key].mustChangePassword = false;
  writeUsers(users);
  req.session.user.passwordChangedAt = ts;
  req.session.user.mustChangePassword = false;
  req.session.save(() => res.json({ ok: true }));
});

// ── POST /api/forgot-password (sem autenticação) ───────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body || {};
  const users = readUsers();
  const key = (username || '').toLowerCase().trim();
  const user = users[key];
  if (!user || !user.email || !emailTransporter)
    return res.json({ ok: true }); // sempre sucede — não revela se usuário existe

  // Remove tokens anteriores do mesmo usuário e tokens expirados
  for (const [t, v] of resetTokens)
    if (v.username === key || v.expires < Date.now()) resetTokens.delete(t);

  const token = crypto.randomBytes(32).toString('hex');
  resetTokens.set(token, { username: key, expires: Date.now() + 60 * 60 * 1000 });

  const appUrl = process.env.APP_URL || 'https://gestao-lojas.onrender.com';
  const link = `${appUrl}/?reset=${token}`;

  try {
    await emailTransporter.sendMail({
      from: `"Gestão Operacional" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Redefinição de senha — Gestão Operacional',
      html: `<div style="font-family:sans-serif;max-width:480px;color:#1e2433">
        <h2 style="color:#3b82f6">Redefinição de senha</h2>
        <p>Olá, <strong>${user.label || key}</strong>!</p>
        <p>Clique no botão abaixo para redefinir sua senha. O link é válido por <strong>1 hora</strong>.</p>
        <p><a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;margin:8px 0">Redefinir senha</a></p>
        <p style="color:#64748b;font-size:.85rem">Se não foi você quem solicitou, ignore este email.</p>
      </div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao enviar email de reset:', e.message);
    res.status(500).json({ error: 'Erro ao enviar email. Contate o administrador.' });
  }
});

// ── POST /api/reset-password (sem autenticação) ────────────────────────────
app.post('/api/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 4)
    return res.status(400).json({ error: 'Senha inválida (mínimo 4 caracteres)' });
  const entry = resetTokens.get(token);
  if (!entry || entry.expires < Date.now()) {
    resetTokens.delete(token);
    return res.status(400).json({ error: 'Link expirado ou inválido. Solicite uma nova redefinição.' });
  }
  const users = readUsers();
  const { username } = entry;
  if (!users[username]) return res.status(400).json({ error: 'Usuário não encontrado' });
  const ts = Date.now().toString();
  users[username].password = password;
  users[username].passwordChangedAt = ts;
  users[username].mustChangePassword = false;
  writeUsers(users);
  resetTokens.delete(token);
  res.json({ ok: true });
});

// ── GET /api/users  (admin) ────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = readUsers();
  const list = Object.entries(users).map(([username, u]) => ({
    username, label: u.label || username, board: u.board || null, lojas: u.lojas || null, email: u.email || null
  }));
  res.json(list);
});

// ── POST /api/users  (admin) ───────────────────────────────────────────────
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, label, board, lojas } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  const key = username.toLowerCase().trim();
  const users = readUsers();
  if (users[key]) return res.status(409).json({ error: 'Usuário já existe' });
  users[key] = { password, label: label || key, board: board || null, lojas: (lojas && lojas.length) ? lojas : null, mustChangePassword: true };
  writeUsers(users);
  res.json({ ok: true, username: key });
});

// ── PUT /api/users/:username  (admin) ─────────────────────────────────────
app.put('/api/users/:username', requireAdmin, (req, res) => {
  const key = req.params.username.toLowerCase();
  const users = readUsers();
  if (!users[key]) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { password, label, board, email, lojas } = req.body || {};
  if (password) {
    const ts = Date.now().toString();
    users[key].password = password;
    users[key].passwordChangedAt = ts;
    if (key === req.session.user.username) {
      // Admin alterando a própria senha: atualiza sessão para não invalidar
      req.session.user.passwordChangedAt = ts;
      users[key].mustChangePassword = false;
    } else {
      users[key].mustChangePassword = true;
    }
  }
  if (label !== undefined) users[key].label = label;
  if (board !== undefined) users[key].board = board;
  if (email !== undefined) users[key].email = email || null;
  if (lojas !== undefined) users[key].lojas = (lojas && lojas.length) ? lojas : null;
  writeUsers(users);
  if (password && key === req.session.user.username) {
    return req.session.save(() => res.json({ ok: true }));
  }
  res.json({ ok: true });
});

// ── DELETE /api/users/:username  (admin) ──────────────────────────────────
app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const key = req.params.username.toLowerCase();
  if (key === req.session.user.username) return res.status(400).json({ error: 'Não pode excluir seu próprio usuário' });
  const users = readUsers();
  if (!users[key]) return res.status(404).json({ error: 'Usuário não encontrado' });
  delete users[key];
  writeUsers(users);
  res.json({ ok: true });
});

// ── GET /api/version — retorna commit hash atual (útil para verificar deploy) ──
app.get('/api/version', (req, res) => {
  const { execSync } = require('child_process');
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
  res.json({ commit, deployedAt: new Date().toISOString() });
});

// ── GET /api/backup  (admin — exporta dump completo do banco) ─────────────
app.get('/api/backup', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="gestao-lojas-backup-${ts}.json"`);
    res.send(JSON.stringify(db, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/restore  (admin — restaura dump completo) ───────────────────
app.post('/api/restore', requireAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'JSON inválido' });
    await writeDB(data);
    res.json({ ok: true, msg: 'Banco restaurado com sucesso' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/me ────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json(req.session.user);
});

// ── GET /api/months ────────────────────────────────────────────────────────
app.get('/api/months', requireAuth, async (req, res) => {
  try {
    const db   = await readDB();
    const list = Object.values(db.months || {}).sort((a, b) =>
      b.year !== a.year ? b.year - a.year : b.month - a.month);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/data/:year/:month ─────────────────────────────────────────────
app.get('/api/data/:year/:month', requireAuth, async (req, res) => {
  try {
    const y = parseInt(req.params.year);
    const m = parseInt(req.params.month);
    if (isNaN(y) || isNaN(m)) return res.status(400).json({ error: 'Invalid params' });
    const db = await readDB();
    for (const board of BOARDS)
      for (const section of SECTIONS)
        ensureCard(db, y, m, board, section);
    await writeDB(db);
    const result = {};
    for (const board of BOARDS) {
      result[board] = {};
      for (const section of SECTIONS) {
        const card = db.cards[cardKey(y, m, board, section)];
        result[board][section] = { ...card };
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/cards/:year/:month/:board/:section ────────────────────────────
app.put('/api/cards/:year/:month/:board/:section', requireAuth, async (req, res) => {
  try {
    const { year, month, board, section } = req.params;
    const db = await readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (!db.cards[ck]) return res.status(404).json({ error: 'Card not found' });
    db.cards[ck].content = req.body.content ?? '';
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/items/:year/:month/:board/:section ───────────────────────────
app.post('/api/items/:year/:month/:board/:section', requireAuth, async (req, res) => {
  try {
    const { year, month, board, section } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });
    const db = await readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (!db.cards[ck]) return res.status(404).json({ error: 'Card not found' });
    const item = { id: nextId(db), text: text.trim(), done: false, createdAt: new Date().toISOString() };
    db.cards[ck].items.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/items/:year/:month/:board/:section/:itemId ────────────────────
app.put('/api/items/:year/:month/:board/:section/:itemId', requireAuth, async (req, res) => {
  try {
    const { year, month, board, section, itemId } = req.params;
    const db   = await readDB();
    const ck   = cardKey(parseInt(year), parseInt(month), board, section);
    const item = db.cards[ck]?.items.find(i => i.id === parseInt(itemId));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.body.text !== undefined) item.text = req.body.text;
    if (req.body.done !== undefined) item.done = Boolean(req.body.done);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/items/:year/:month/:board/:section/:itemId ─────────────────
app.delete('/api/items/:year/:month/:board/:section/:itemId', requireAuth, async (req, res) => {
  try {
    const { year, month, board, section, itemId } = req.params;
    const db = await readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (db.cards[ck]) db.cards[ck].items = db.cards[ck].items.filter(i => i.id !== parseInt(itemId));
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/attachments/:year/:month/:board/:section ─────────────────────
app.post('/api/attachments/:year/:month/:board/:section', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { year, month, board, section } = req.params;
    const db = await readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (!db.cards[ck]) return res.status(404).json({ error: 'Card not found' });
    const att = {
      id: nextId(db),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      createdAt: new Date().toISOString(),
    };
    db.cards[ck].attachments.push(att);
    await writeDB(db);
    res.json(att);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/attachments/:year/:month/:board/:section/:attId ────────────
app.delete('/api/attachments/:year/:month/:board/:section/:attId', requireAuth, async (req, res) => {
  try {
    const { year, month, board, section, attId } = req.params;
    const db = await readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (db.cards[ck]) {
      const att = db.cards[ck].attachments.find(a => a.id === parseInt(attId));
      if (att) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
        db.cards[ck].attachments = db.cards[ck].attachments.filter(a => a.id !== parseInt(attId));
      }
    }
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/init — carregamento inicial em 1 chamada ────────────────────────
// Substitui ~50 chamadas individuais por 1 única leitura do MongoDB
app.get('/api/init', requireAuth, async (req, res) => {
  try {
    const { year: yStr, month: mStr } = req.query;
    const year  = parseInt(yStr)  || new Date().getFullYear();
    const month = parseInt(mStr)  || (new Date().getMonth() + 1);
    const mk    = monthKey(year, month);
    const prefix = `${mk}-`;

    const db = await readDB();
    const { board, lojas: userLojas } = req.session.user;
    const isSupervisor = !board && !!(userLojas && userLojas.length);
    const isAdminOrEscritorio = !board && !isSupervisor || board === 'escritorio';

    // Employees — sem foto para reduzir tamanho da resposta (fotos carregam em background)
    const allEmps = db.employees || [];
    const stripFoto = e => { const { foto, ...rest } = e; return rest; };
    const employees = isSupervisor
      ? allEmps.filter(e => userLojas.includes(e.board)).map(stripFoto)
      : (isAdminOrEscritorio ? allEmps : allEmps.filter(e => e.board === board)).map(stripFoto);

    // VSales for all employees this month
    const vsalesAll = db.vsales || {};
    const vsales = {};
    for (const emp of allEmps) {
      const key = `${mk}-${emp.board}-${emp.id}`;
      vsales[emp.id] = vsalesAll[key] || { meta: { mensal: 0 }, entries: {} };
    }

    // StoreFluxo for all boards
    const sfAll = db.storeFluxo || {};
    const storeFluxo = {};
    for (const [k, v] of Object.entries(sfAll)) {
      if (k.startsWith(prefix)) storeFluxo[k.slice(prefix.length)] = v;
    }

    // Campaigns filtered by board
    const allCamps = db.campaigns || [];
    const campaigns = isSupervisor
      ? allCamps.filter(c => c.scope === 'rede' || userLojas.some(l => c.stores.includes(l)))
      : board ? allCamps.filter(c => c.scope === 'rede' || c.stores.includes(board)) : allCamps;

    // Meeting items filtered by board
    const allMeeting = db.meetingItems || [];
    const meetingItems = allMeeting.filter(x =>
      isAdminOrEscritorio || (isSupervisor && userLojas.includes(x.board) && x.visibility === 'loja') || (x.board === board && x.visibility === 'loja')
    );

    // Requisições filtered by board
    const allReq = db.requisicoes || [];
    const requisicoes = allReq
      .filter(x => isAdminOrEscritorio || (isSupervisor ? userLojas.includes(x.board) : x.board === board))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Retiradas filtered by board
    const retiradas = (db.retiradas || [])
      .filter(x => isAdminOrEscritorio || (isSupervisor ? userLojas.includes(x.board) : x.board === board))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Adiantamentos filtered by board
    const adiantamentos = (db.adiantamentos || [])
      .filter(x => isAdminOrEscritorio || x.board === board)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Pendências — admin/escritorio only
    const pendencias = isAdminOrEscritorio ? (db.pendencias || []) : [];

    // Embalagens: catálogo da loja + status da contagem quinzenal.
    // Vem no init para o badge e o card de aviso não precisarem de outra chamada.
    const embalBoards = isAdminOrEscritorio
      ? EMBAL_STORE_BOARDS
      : EMBAL_STORE_BOARDS.filter(b => isSupervisor ? userLojas.includes(b) : b === board);
    const embalagens = { itens: {}, status: {}, projecao: {}, piso: {}, diasContagem: EMBAL_DIAS_CONTAGEM, horizonteMeses: embalHorizonteMeses(db), pisoMeses: embalPisoMeses(db) };
    for (const b of embalBoards) {
      embalagens.itens[b]    = embalagensDaLoja(db, b);
      embalagens.status[b]   = statusContagem(db, b);
      embalagens.projecao[b] = projecaoAnual(db, b);
      embalagens.piso[b]     = itensAbaixoDoPiso(db, b, embalagens.itens[b]);
    }

    // Indeva stats for this month
    const indevaResult = {};
    const today = todayBRT();
    for (const brd of INDEVA_STORES) {
      const store = db.indeva?.[brd];
      if (!store) continue;
      const daily = {};
      for (const [date, dayData] of Object.entries(store.historico || {})) {
        if (!date.startsWith(prefix)) continue;
        if (!daily[date]) daily[date] = {};
        for (const a of (dayData.atendimentos || [])) {
          const key = String(a.empId);
          if (!daily[date][key]) daily[date][key] = { total: 0, conv: 0 };
          daily[date][key].total++;
          if (a.vendeu) daily[date][key].conv++;
        }
      }
      if (store.date?.startsWith(prefix)) {
        if (!daily[store.date]) daily[store.date] = {};
        for (const a of (store.atendimentos || [])) {
          const key = String(a.empId);
          if (!daily[store.date][key]) daily[store.date][key] = { total: 0, conv: 0 };
          daily[store.date][key].total++;
          if (a.vendeu) daily[store.date][key].conv++;
        }
      }
      const monthly = {};
      for (const dayStats of Object.values(daily)) {
        for (const [key, s] of Object.entries(dayStats)) {
          if (!monthly[key]) monthly[key] = { total: 0, conv: 0 };
          monthly[key].total += s.total;
          monthly[key].conv  += s.conv;
        }
      }
      indevaResult[brd] = { daily, monthly };
    }

    res.json({
      employees,
      weights:      (db.globalWeights || {})[mk] || {},
      vsales,
      weeklyMetas:  (db.weeklyMetas   || {})[mk] || {},
      folgas:       (db.folgas || []).filter(f => f.date.startsWith(prefix)),
      storeFluxo,
      campaigns,
      nfItems:      db.nfItems      || [],
      boletas:      db.boletas      || [],
      meetingItems,
      pendencias,
      embalagens,
      requisicoes,
      retiradas,
      adiantamentos,
      indevaStats:  indevaResult,
      dailySalesMeta: Object.fromEntries(
        BOARDS.filter(b => b !== 'admin' && b !== 'escritorio').map(b => [
          b, db.dailySales?.[`${mk}-${b}`]?.meta?.mensal || 0
        ])
      ),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/dailysales-meta/:year/:month ──────────────────────────────────
app.get('/api/dailysales-meta/:year/:month', requireAuth, async (req, res) => {
  try {
    const mk = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db = await readDB();
    const result = Object.fromEntries(
      BOARDS.filter(b => b !== 'admin' && b !== 'escritorio').map(b => [
        b, db.dailySales?.[`${mk}-${b}`]?.meta?.mensal || 0
      ])
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees ─────────────────────────────────────────────────────
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const db     = await readDB();
    const photos = await readPhotos();
    const emps   = (db.employees || []).map(e => photos[e.id] ? { ...e, foto: photos[e.id] } : e);
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    res.json(isAdminOrEscritorio ? emps : emps.filter(e => e.board === board));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/photos — só id+foto para lazy-load após init ────────
app.get('/api/employees/photos', requireAuth, async (req, res) => {
  try {
    const photos = await readPhotos();
    res.json(Object.entries(photos).map(([id, foto]) => ({ id: parseInt(id), foto })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees ────────────────────────────────────────────────────
app.post('/api/employees', requireAuth, async (req, res) => {
  try {
    const { name, board, cpf, nascimento, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, omniChannel, inativo, desligamento, apelido, microvixCod, supervisedBoards } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    if (!nascimento) return res.status(400).json({ error: 'Data de nascimento obrigatória' });
    const db = await readDB();
    if (!db.employees) db.employees = [];
    const emp = {
      id: nextId(db), name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod ? String(microvixCod).trim() : '',
      cpf: cpf || '', nascimento: nascimento || '', admissao: admissao || '',
      contrato1: parseInt(contrato1) || 0, contrato2: parseInt(contrato2) || 0,
      cargo: cargo || '',
      salario: parseFloat(salario) || 0,
      comissaoSemMeta: parseFloat(comissaoSemMeta) || 0, comissao: parseFloat(comissao) || 0,
      comissaoMeta2: parseFloat(comissaoMeta2) || 0, comissaoSuper: parseFloat(comissaoSuper) || 0,
      comissaoVR: parseFloat(comissaoVR) || 0, aberturaLoja: parseFloat(aberturaLoja) || 0,
      comissaoGerente: parseFloat(comissaoGerente) || 0,
      inssRate: parseFloat(inssRate) || 0, vtRate: parseFloat(vtRate) || 0,
      salarioFixo: parseFloat(salarioFixo) || 0, quebraCaixa: parseFloat(quebraCaixa) || 0,
      banco: banco || '', conta: conta || '',
      isVendedor: isVendedor !== false,
      omniChannel: omniChannel === true || omniChannel === 'true',
      inativo: inativo === true || inativo === 'true',
      desligamento: desligamento || '',
      supervisedBoards: Array.isArray(supervisedBoards) ? supervisedBoards : [],
    };
    db.employees.push(emp);
    await writeDB(db);
    res.json(emp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/employees/:id ─────────────────────────────────────────────────
app.put('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, board, cpf, nascimento, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, omniChannel, inativo, desligamento, apelido, microvixCod, foto, supervisedBoards } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    if (!nascimento) return res.status(400).json({ error: 'Data de nascimento obrigatória' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    // Se foto === '' → remover; se foto !== undefined → atualizar; se undefined → não mudar
    if (foto === '') await writePhoto(id, null);
    db.employees[idx] = {
      ...db.employees[idx], name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod !== undefined ? String(microvixCod).trim() : (db.employees[idx].microvixCod || ''),
      cpf: cpf || '', nascimento: nascimento || '', admissao: admissao || '',
      contrato1: parseInt(contrato1) || 0, contrato2: parseInt(contrato2) || 0,
      cargo: cargo || '',
      salario: parseFloat(salario) || 0,
      comissaoSemMeta: parseFloat(comissaoSemMeta) || 0, comissao: parseFloat(comissao) || 0,
      comissaoMeta2: parseFloat(comissaoMeta2) || 0, comissaoSuper: parseFloat(comissaoSuper) || 0,
      comissaoVR: parseFloat(comissaoVR) || 0, aberturaLoja: parseFloat(aberturaLoja) || 0,
      comissaoGerente: parseFloat(comissaoGerente) || 0,
      inssRate: parseFloat(inssRate) || 0, vtRate: parseFloat(vtRate) || 0,
      salarioFixo: parseFloat(salarioFixo) || 0, quebraCaixa: parseFloat(quebraCaixa) || 0,
      banco: banco || '', conta: conta || '',
      isVendedor: isVendedor !== false,
      omniChannel: omniChannel === true || omniChannel === 'true',
      inativo: inativo === true || inativo === 'true',
      desligamento: desligamento || '',
      supervisedBoards: Array.isArray(supervisedBoards) ? supervisedBoards : (db.employees[idx].supervisedBoards || []),
    };
    await writeDB(db);
    res.json(db.employees[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/:id ──────────────────────────────────────────────
// Exclusão definitiva do cadastro (apaga histórico ligado ao id) — só admin.
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.employees = (db.employees || []).filter(e => e.id !== id);
    db.folgas    = (db.folgas    || []).filter(f => f.employeeId !== id);
    await writePhoto(id, null); // remove foto do documento separado
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/photo ──────────────────────────────────────────
// Armazena foto no documento separado 'photos' (não polui o documento principal)
app.post('/api/employees/:id/photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    let fileData;
    if (req.file.path) {
      fileData = fs.readFileSync(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch {}
    } else {
      fileData = req.file.buffer;
    }
    const mime = req.file.mimetype || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${fileData.toString('base64')}`;

    await writePhoto(id, dataUrl);
    res.json({ url: dataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/folgas/:year/:month ───────────────────────────────────────────
app.get('/api/folgas/:year/:month', requireAuth, async (req, res) => {
  try {
    const prefix = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db = await readDB();
    res.json((db.folgas || []).filter(f => f.date.startsWith(prefix)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/folgas ───────────────────────────────────────────────────────
app.post('/api/folgas', requireAuth, async (req, res) => {
  try {
    const { employeeId, date } = req.body;
    if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date required' });
    const db = await readDB();
    if (!db.folgas) db.folgas = [];
    const exists = db.folgas.find(f => f.employeeId === employeeId && f.date === date);
    if (exists) return res.json(exists);
    const folga = { id: nextId(db), employeeId, date };
    db.folgas.push(folga);
    await writeDB(db);
    res.json(folga);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/folgas/:id ─────────────────────────────────────────────────
app.delete('/api/folgas/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.folgas = (db.folgas || []).filter(f => f.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ausencias ────────────────────────────────────────────────────
app.get('/api/ausencias', requireAuth, async (req, res) => {
  try {
    const db  = await readDB();
    const { board } = req.session.user;
    const isAdm = !board || board === 'escritorio';
    const { tipo } = req.query;
    let items = (db.ausencias || []).filter(x => isAdm || x.board === board);
    if (tipo) items = items.filter(x => x.tipo === tipo);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ausencias ───────────────────────────────────────────────────
app.post('/api/ausencias', requireAuth, async (req, res) => {
  try {
    const sessionBoard = req.session.user.board;
    const isAdm = !sessionBoard || sessionBoard === 'escritorio';
    const board = isAdm ? (req.body.board || '') : sessionBoard;
    if (!board) return res.status(400).json({ error: 'Informe a loja' });
    const { tipo, colaborador, dataInicio, dataFim, observacao } = req.body;
    if (!['atestado', 'ferias'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!colaborador?.trim()) return res.status(400).json({ error: 'Colaborador obrigatório' });
    if (!dataInicio) return res.status(400).json({ error: 'Data início obrigatória' });
    if (!dataFim)    return res.status(400).json({ error: 'Data fim obrigatória' });
    const db = await readDB();
    if (!db.ausencias) db.ausencias = [];
    const item = {
      id: nextId(db), tipo, board,
      colaborador: colaborador.trim(),
      dataInicio, dataFim,
      observacao: (observacao || '').trim(),
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.label || req.session.user.username,
    };
    db.ausencias.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/ausencias/:id ─────────────────────────────────────────────
app.delete('/api/ausencias/:id', requireAuth, async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const db  = await readDB();
    const item = (db.ausencias || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Não encontrado' });
    const { board } = req.session.user;
    const isAdm = !board || board === 'escritorio';
    if (!isAdm && item.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    db.ausencias = db.ausencias.filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/dados-folha/:year/:month/:board ──────────────────────────────
app.get('/api/dados-folha/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const user = req.session.user;
    const isAdmin = !user.board || user.board === 'escritorio';
    if (!isAdmin && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    res.json((db.dadosFolha || {})[key] || { feriados: [], extensoes: [], faltas: [], vr: '', abertura: '', instagram: '', obs: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/dados-folha/:year/:month/:board ─────────────────────────────
app.post('/api/dados-folha/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const user = req.session.user;
    const isAdmin = !user.board || user.board === 'escritorio';
    if (!isAdmin && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const db  = await readDB();
    if (!db.dadosFolha) db.dadosFolha = {};
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    db.dadosFolha[key] = req.body;
    await writeDB(db);
    res.json(db.dadosFolha[key]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/dailysales/:year/:month/:board ────────────────────────────────
app.get('/api/dailysales/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    let data  = db.dailySales?.[key] || { meta: { mensal: 0, weights: {} }, entries: {} };
    if (typeof data.meta !== 'object') data = { meta: { mensal: data.meta || 0, weights: {} }, entries: data.entries || {} };
    if (!data.meta.weights) data.meta.weights = {};
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/dailysales/:year/:month/:board/meta ──────────────────────────
app.post('/api/dailysales/:year/:month/:board/meta', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.dailySales) db.dailySales = {};
    if (!db.dailySales[key]) db.dailySales[key] = { meta: { mensal: 0, weights: {} }, entries: {} };
    const rec = db.dailySales[key];
    if (typeof rec.meta !== 'object') rec.meta = { mensal: rec.meta || 0, weights: {} };
    if (!rec.meta.weights) rec.meta.weights = {};
    if (req.body.mensal  !== undefined) rec.meta.mensal  = parseFloat(req.body.mensal) || 0;
    if (req.body.weights !== undefined) rec.meta.weights = req.body.weights;
    await writeDB(db);
    res.json({ ok: true, meta: rec.meta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/dailysales/:year/:month/:board/:date ──────────────────────────
app.put('/api/dailysales/:year/:month/:board/:date', requireAuth, async (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.dailySales) db.dailySales = {};
    if (!db.dailySales[key]) db.dailySales[key] = { meta: 0, entries: {} };
    db.dailySales[key].entries[date] = {
      value: parseFloat(req.body.value) || 0,
      pecas: parseInt(req.body.pecas)   || 0,
      fluxo: parseInt(req.body.fluxo)   || 0,
    };
    await writeDB(db);
    res.json(db.dailySales[key].entries[date]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/dailysales/:year/:month/:board/:date ───────────────────────
app.delete('/api/dailysales/:year/:month/:board/:date', requireAuth, async (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (db.dailySales?.[key]?.entries?.[date]) delete db.dailySales[key].entries[date];
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/weights/:year/:month ──────────────────────────────────────────
app.get('/api/weights/:year/:month', requireAuth, async (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = await readDB();
    res.json((db.globalWeights || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/weights/:year/:month ─────────────────────────────────────────
app.post('/api/weights/:year/:month', requireAuth, async (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = await readDB();
    if (!db.globalWeights) db.globalWeights = {};
    db.globalWeights[key] = req.body.weights || {};
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/board-settings ───────────────────────────────────────────────
app.get('/api/board-settings', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.boardSettings || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/board-settings/:board ────────────────────────────────────────
app.put('/api/board-settings/:board', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const db = await readDB();
    if (!db.boardSettings) db.boardSettings = {};
    db.boardSettings[board] = { ...(db.boardSettings[board] || {}), ...req.body };
    await writeDB(db);
    res.json({ ok: true, settings: db.boardSettings[board] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DADOS DAS LOJAS (CNPJ / IE / IM / endereços) ──────────────────────────
// Texto livre: blocos separados por linha em branco, um por empresa/filial.
// Serve de conteúdo inicial enquanto ninguém salvou nada.
const DADOS_LOJAS_SEED = `Razão Social: LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 28.519.094/0001-29
IE: 003032074.00-48
IM: 1.044.066/001-4
Av. Presidente Carlos Luz, 3001, Loja 3051 - Bairro: Caiçara - Cep: 31250-010 - Belo Horizonte/MG
Tel.: (31) 3415 8692 – (31) 9 7181 8026
Insta: @SurfersConceptStore

Razão Social: LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 28.519.094/0002-00
IE: 003032074.01-29
IM: 1.044.066/002-2
Av. Del Rey, 111, sala 505 - Bloco A - Bairro: Caiçara - Cep: 30775-240 - Belo Horizonte/MG
Tel.: (31) 3317 8692
Insta: @lojasurfers

Razão Social: LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 28.519.094/0003-90
IE: 003032074.02-00
IM: 72097281-0
Av. Severino Ballesteros Rodrigues, 850, Loja 2112 - Bairro: Cabral - Cep: 32.146-025 - Contagem/MG
Tel.: (31) 2557-5415 – (31) 9 8586-5615
Insta: @surfers.contagem

Razão Social: JDG COMERCIO DE ARTIGOS DO VESTUARIO EIRELI
CNPJ: 32.473.768/0001-79
IE: 003355950.00-44
IM: 1.125.819/001-4
Av. Cristiano Machado, 4000, Loja 148 - Bairro: União - Cep: 31.160-900 - Belo Horizonte/MG
Tel.: (31) 3789-8692 – (31) 9 8423-6975
Insta: @surfers_minas

Razão Social: JDG COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 32.473.768/0002-50
IE: 0033559500125
IM: 11258190022
Av. Del Rey, 111, sala 505 - Bloco A - Bairro: Caiçara - Cep: 30775-240 - Belo Horizonte/MG
Insta: @lojasurfers

Razão Social: PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 35.041.602/0001-71
IE: 0035581630097
IM: 72107199-0
Av. Severino Ballesteros Rodrigues, 850, Loja 2028 - Bairro: Cabral - Cep: 32.146-025 - Contagem/MG
Tel.: (31) 2557-5415
Insta: @surfers.contagem

Razão Social: PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 35.041.602/0002-52
IE: 0035581630178
IM: 11819990014
Av. Del Rey, 111, sala 505 - Bloco A - Bairro: Caiçara - Cep: 30775-240 - Belo Horizonte/MG
Tel.: (31) 3317 8692
Insta: @lojasurfers

Razão Social: PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP
CNPJ: 35.041.602/0003-33
IE: 0035581630259
IM: 11819990014
Av. Presidente Carlos Luz, 3001, Loja 3051 - Bairro: Caiçara - Cep: 31250-010 - Belo Horizonte/MG
Tel.: (31) 3415 8392 – (31) 9 7181 8026
Insta: @SurfersConceptStore

Razão Social: TTS COMÉRCIO DE ARTIGOS DO VESTUÁRIO LTDA FILIAL
Nome Fantasia: SURFER'S BEACHCULTURE
CNPJ: 11.106.478/0002-06
IE: 0013781050181
IM: 2454760023
Av. Cristiano Machado, 11833, Loja 2076 - Bairro: Vila Clóris - Cep: 31.744-007 - Belo Horizonte/MG
Tel.: (31) 3118 9638 – (31) 9369-7984
Insta: @Surfersestacaobh

Razão Social: TRIBE COMÉRCIO DE ARTIGOS DO VESTUÁRIO LTDA
Nome Fantasia: TRIBE CONCEPT STORE
CNPJ: 10.209.859/0001-69
IE: 0010813080088
IM: 227702/001-4
Av. Presidente Carlos Luz, 3001, Loja 3111, Piso 3 - Bairro: Caiçara - Cep: 31250-010 - Belo Horizonte/MG
Tel.: (31) 3415-7284

Razão Social: TRIBE COMÉRCIO DE ARTIGOS DO VESTUÁRIO LTDA FILIAL
Nome Fantasia: TRIBE
CNPJ: 10.209.859/0002-40
Av. Otacilio Campelo Ribeiro, 2801, Loja 288 - Bairro: Eldorado - Cep: 35702-153 - Sete Lagoas/MG
Tel.: (31) 3773-5547

Razão Social: TRIBE COMERCIO DE ARTIGOS DO VESTUARIO LTDA - ME
CNPJ: 10.209.859/0003-20
IE: 001081308.02-40
Av. Del Rey, 111 - Bloco A - Sala 505 - Bairro: Caiçara - Cep: 30775-240 - Belo Horizonte/MG
Tel.: (31) 3889-8560

Razão Social: LF COMÉRCIO DE ARTIGOS DO VESTUÁRIO
Nome Fantasia: LEZ A LEZ
CNPJ: 44.602.345/0001-90
IE: 44559930023
IM: 13556500018
Av. Presidente Carlos Luz, 3001, Loja 3111, Piso 3 - Bairro: Caiçara - Cep: 31250-010 - Belo Horizonte/MG
Tel.: (31) 3656-6388

Razão Social: 3L COMÉRCIO DE ARTIGOS DO VESTUÁRIO
Nome Fantasia: TOMMY HILFIGER
CNPJ: 60.509.746/0001-57
IE: 51800000073
IM: 16563040013
Av. Presidente Carlos Luz, 3001, Loja 2026, Piso 2 - Bairro: Caiçara - Cep: 31250-010 - Belo Horizonte/MG
Tel.: (31) 3568-0061`;

// ── GET /api/dados-lojas ──────────────────────────────────────────────────
app.get('/api/dados-lojas', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const d  = db.dadosLojas;
    if (!d || !String(d.text || '').trim())
      return res.json({ text: DADOS_LOJAS_SEED, updatedAt: null, updatedBy: null, seed: true });
    res.json({ text: d.text, updatedAt: d.updatedAt || null, updatedBy: d.updatedBy || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/dados-lojas ──────────────────────────────────────────────────
app.put('/api/dados-lojas', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text ?? '');
    const db = await readDB();
    db.dadosLojas = {
      text,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user.username,
    };
    await writeDB(db);
    res.json({ ok: true, ...db.dadosLojas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/vsales/:year/:month/:board/:empId ─────────────────────────────
app.get('/api/vsales/:year/:month/:board/:empId', requireAuth, async (req, res) => {
  try {
    const { year, month, board, empId } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = await readDB();
    res.json((db.vsales || {})[key] || { meta: { mensal: 0 }, entries: {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vsales/:year/:month/:board/:empId/meta ───────────────────────
app.post('/api/vsales/:year/:month/:board/:empId/meta', requireAuth, async (req, res) => {
  try {
    const { year, month, board, empId } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = await readDB();
    if (!db.vsales) db.vsales = {};
    if (!db.vsales[key]) db.vsales[key] = { meta: { mensal: 0 }, entries: {} };
    if (req.body.mensal !== undefined)
      db.vsales[key].meta.mensal = parseFloat(req.body.mensal) || 0;
    if (req.body.vacationDays !== undefined)
      db.vsales[key].meta.vacationDays = req.body.vacationDays;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/vsales/:year/:month/:board/:empId/:date ───────────────────────
app.put('/api/vsales/:year/:month/:board/:empId/:date', requireAuth, async (req, res) => {
  try {
    const { year, month, board, empId, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = await readDB();
    if (!db.vsales) db.vsales = {};
    if (!db.vsales[key]) db.vsales[key] = { meta: { mensal: 0 }, entries: {} };
    db.vsales[key].entries[date] = {
      value:        parseFloat(req.body.value)      || 0,
      pecas:        parseInt(req.body.pecas)        || 0,
      atendimentos: parseInt(req.body.atendimentos) || 0,
    };
    await writeDB(db);
    res.json(db.vsales[key].entries[date]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/vsales/:year/:month/:board/:empId/:date ────────────────────
app.delete('/api/vsales/:year/:month/:board/:empId/:date', requireAuth, async (req, res) => {
  try {
    const { year, month, board, empId, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = await readDB();
    if (db.vsales?.[key]?.entries?.[date]) delete db.vsales[key].entries[date];
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/perf-monthly-total/:board/:year/:month ─────────────────────────
app.get('/api/perf-monthly-total/:board/:year/:month', requireAuth, async (req, res) => {
  try {
    const { board, year, month } = req.params;
    const y = parseInt(year), m = parseInt(month);
    const mk = y + '-' + String(m).padStart(2, '0');
    const db  = await readDB();
    const boards = board === 'surfers' ? ['delrey','minas','contagem','estacao','site'] : [board];
    const emps  = (db.employees || []).filter(e => boards.includes(e.board) && e.isVendedor !== false);
    let total = 0;
    for (const emp of emps) {
      const key = mk + '-' + emp.board + '-' + emp.id;
      const vsData = db.vsales?.[key];
      if (!vsData?.entries) continue;
      for (const v of Object.values(vsData.entries)) total += (v.value || 0);
    }
    res.json({ board, year: y, month: m, total: Math.round(total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/excel/:year/:month/:board — download fechamento ──────────────
app.get('/api/excel/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const y = parseInt(year), m = parseInt(month);
    const db  = await readDB();
    const pad = n => String(n).padStart(2, '0');
    const N   = new Date(y, m, 0).getDate();
    const DAY_PT    = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const BOARD_NAMES  = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem',
                           estacao:'Estação', tommy:'Tommy', lez:'Lez' };
    const BOARD_COLORS = { delrey:'FF4F8B5A', minas:'FF3A7BD5', contagem:'FFE8833A',
                           estacao:'FF9B59B6', tommy:'FFE74C3C', lez:'FF1ABC9C' };
    const storeColor = BOARD_COLORS[board] || 'FF4F8B5A';
    const storeName  = BOARD_NAMES[board]  || board;

    const isVendedor = e => e.isVendedor !== false;
    const emps     = (db.employees || []).filter(e => e.board === board && isVendedor(e));
    const mkKey    = `${y}-${pad(m)}`;
    const dsKey    = `${y}-${pad(m)}-${board}`;
    const metaLoja = db.dailySales?.[dsKey]?.meta?.mensal || 0;
    const gWeights = (db.globalWeights || {})[mkKey] || {};
    const defW     = 100 / N;

    const vsMap = {};
    for (const emp of emps) {
      vsMap[emp.id] = db.vsales?.[`${y}-${pad(m)}-${board}-${emp.id}`] || { meta: { mensal: 0 }, entries: {} };
    }

    function sellerDayGoal(empId, ds) {
      // Canal Omni: soma no total da loja, mas não recebe fatia da meta nem participa da divisão
      if (emps.find(e => e.id === empId)?.omniChannel) return 0;
      const vac = vsMap[empId]?.meta?.vacationDays || [];
      if (metaLoja > 0) {
        if (vac.includes(ds)) return 0;
        const w = gWeights[ds] ?? defW;
        const nActive = emps.filter(e => !e.omniChannel && !(vsMap[e.id]?.meta?.vacationDays || []).includes(ds)).length;
        return nActive > 0 ? (metaLoja * w / 100) / nActive : 0;
      }
      return (vsMap[empId]?.meta?.mensal || 0) * (gWeights[ds] ?? defW) / 100;
    }

    function sellerMensal(empId) {
      if (metaLoja > 0) {
        let s = 0;
        for (let d = 1; d <= N; d++) s += sellerDayGoal(empId, `${y}-${pad(m)}-${pad(d)}`);
        return s;
      }
      return vsMap[empId]?.meta?.mensal || 0;
    }

    const C = {
      HDR_BG:   { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1C2333' } },
      HDR_FG:   { bold:true, color:{ argb:'FFFFFFFF' }, size:10, name:'Calibri' },
      TITLE_BG: (argb) => ({ type:'pattern', pattern:'solid', fgColor:{ argb } }),
      TITLE_FG: { bold:true, color:{ argb:'FFFFFFFF' }, size:11, name:'Calibri' },
      CALC_BG:  { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4FA' } },
      EDIT_BG:  { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFFFFF' } },
      WE_BG:    { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F5F5' } },
      TOT_BG:   { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1C2333' } },
      TOT_FG:   { bold:true, color:{ argb:'FFFFFFFF' }, size:10, name:'Calibri' },
      POS_FG:   { bold:true, color:{ argb:'FF276749' } },
      NEG_FG:   { bold:true, color:{ argb:'FF9B2335' } },
      BORDER:   { style:'thin', color:{ argb:'FFD0D7DE' } },
    };
    const thinBorder = { top:C.BORDER, left:C.BORDER, bottom:C.BORDER, right:C.BORDER };
    const fmtBRL = '#,##0.00', fmtPct = '0.00"%"', fmtDec = '0.00', fmtInt = '0';

    async function buildSheet(wb, sheetName, empId) {
      const ws = wb.addWorksheet(sheetName, { views:[{ state:'frozen', ySplit:3 }] });
      ws.columns = [
        { key:'data',  width:12 }, { key:'dia',   width:6  },
        { key:'metad', width:15 }, { key:'metaa', width:16 },
        { key:'pct',   width:10 }, { key:'dev',   width:14 },
        { key:'real',  width:16 }, { key:'proj',  width:14 },
        { key:'ppct',  width:10 },
        { key:'pcs',   width:7  }, { key:'atd',   width:8  },
        { key:'pa',    width:7  },
      ];
      const isTotal = empId === 'total';
      const empSheetNames = isTotal ? emps.map(e => (e.apelido || e.name).slice(0, 31)) : [];
      const crossSum = (col, row) => {
        if (!empSheetNames.length) return null;
        const refs = empSheetNames.map(n => `'${n.replace(/'/g, "''")}'!${col}${row}`);
        return refs.length === 1 ? refs[0] : `SUM(${refs.join(',')})`;
      };
      const mensal  = isTotal
        ? emps.reduce((s,e) => s + sellerMensal(e.id), 0)
        : sellerMensal(empId);

      ws.mergeCells('A1:L1');
      const titleCell = ws.getCell('A1');
      const empObj    = emps.find(e => e.id === empId);
      const subtitle  = isTotal ? 'TOTAL DA LOJA' : (empObj ? (empObj.apelido || empObj.name) : sheetName);
      titleCell.value = `${storeName.toUpperCase()} — ${MONTHS_PT[m-1].toUpperCase()} ${y} — ${subtitle.toUpperCase()}`;
      titleCell.fill  = C.TITLE_BG(storeColor);
      titleCell.font  = C.TITLE_FG;
      titleCell.alignment = { horizontal:'center', vertical:'middle' };
      ws.getRow(1).height = 22;

      ws.mergeCells('A2:L2');
      const subCell = ws.getCell('A2');
      subCell.value = `Meta Mensal: R$ ${mensal.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
      subCell.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF252E3D' } };
      subCell.font  = { bold:true, color:{ argb:'FFADBAC7' }, size:9, name:'Calibri' };
      subCell.alignment = { horizontal:'center', vertical:'middle' };
      ws.getRow(2).height = 16;

      const HEADS = ['DATA','DIA','META DIÁRIA','META ACUMULADA','% ATING','DESVIO','VALOR REALIZADO','PROJEÇÃO','% PROJ','PÇ','ATEND','PA'];
      const hrow = ws.getRow(3);
      hrow.height = 18;
      HEADS.forEach((h, i) => {
        const cell = hrow.getCell(i + 1);
        cell.value = h; cell.fill = C.HDR_BG; cell.font = C.HDR_FG;
        cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
        cell.border = thinBorder;
      });

      const weightAcumByDay = {};
      let wRunning = 0;
      for (let d = 1; d <= N; d++) {
        const ds = `${y}-${pad(m)}-${pad(d)}`;
        wRunning += (gWeights[ds] ?? defW) / 100;
        weightAcumByDay[d] = +wRunning.toFixed(8);
      }

      // Pré-calcula valores por dia para gravar result junto com a fórmula
      const dayData = [];
      for (let d = 1; d <= N; d++) {
        const ds = `${y}-${pad(m)}-${pad(d)}`;
        let metaDia = 0, valor = 0, pecas = 0, atend = 0;
        if (isTotal) {
          for (const e of emps) {
            metaDia += sellerDayGoal(e.id, ds);
            const en = vsMap[e.id]?.entries?.[ds] || {};
            valor += en.value||0; pecas += en.pecas||0; atend += en.atendimentos||0;
          }
        } else {
          metaDia = sellerDayGoal(empId, ds);
          const en = vsMap[empId]?.entries?.[ds] || {};
          valor = en.value||0; pecas = en.pecas||0; atend = en.atendimentos||0;
        }
        dayData.push({ ds, metaDia, valor, pecas, atend });
      }

      // Totais acumulados
      let metaAcum = 0, valorAcum = 0;

      for (let d = 1; d <= N; d++) {
        const { ds, metaDia, valor, pecas, atend } = dayData[d - 1];
        metaAcum  += metaDia;
        valorAcum += valor;

        const dow  = new Date(y, m - 1, d).getDay();
        const isWE = dow === 0 || dow === 6;
        const rowN = d + 3;
        const row  = ws.getRow(rowN);
        row.height = 16;
        const cRow = rowN;
        const wAcum = weightAcumByDay[d];

        const pctAting = metaAcum > 0 ? valorAcum / metaAcum * 100 : null;
        const desvio   = metaAcum > 0 ? valorAcum - metaAcum : null;
        const proj     = wAcum > 0 && valorAcum > 0 ? valorAcum / wAcum : null;
        const pa       = atend > 0 ? pecas / atend : null;

        // Aba TOTAL: totalmente bloqueada (sem edição manual); demais: G, J, K editáveis
        const EDITABLE = isTotal ? new Set() : new Set([7, 10, 11]);
        const set = (col, val, fmt, bg, fg) => {
          const cell = row.getCell(col);
          cell.value = val;
          if (fmt && fmt !== '@') cell.numFmt = fmt;
          cell.fill   = bg || (isWE ? C.WE_BG : C.EDIT_BG);
          if (fg) cell.font = fg;
          cell.border = thinBorder;
          cell.alignment = { horizontal: col <= 2 ? 'center' : 'right', vertical:'middle' };
          cell.protection = { locked: !EDITABLE.has(col) };
        };

        const projPct = mensal > 0 && proj != null ? proj / mensal * 100 : null;

        set(1, `${pad(d)}/${pad(m)}`, '@');
        set(2, DAY_PT[dow], '@');
        set(3, metaDia > 0 ? +metaDia.toFixed(4) : null, fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(4, { formula: d===1 ? `C${cRow}` : `D${cRow-1}+C${cRow}`, result: +metaAcum.toFixed(2) },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(5, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})/D${cRow}*100,"")`, result: pctAting ?? '' },
            fmtPct, isWE ? C.WE_BG : C.CALC_BG);
        set(6, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})-D${cRow},"")`, result: desvio ?? '' },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        if (isTotal) {
          const fG = crossSum('G', cRow), fJ = crossSum('J', cRow), fK = crossSum('K', cRow);
          set(7,  { formula: fG, result: valor > 0 ? +valor.toFixed(2) : 0 }, fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
          set(10, { formula: fJ, result: pecas  || 0 }, fmtInt, isWE ? C.WE_BG : C.CALC_BG);
          set(11, { formula: fK, result: atend  || 0 }, fmtInt, isWE ? C.WE_BG : C.CALC_BG);
        } else {
          set(7,  valor > 0 ? +valor.toFixed(2) : null, fmtBRL);
          set(10, pecas > 0 ? pecas : null, fmtInt);
          set(11, atend > 0 ? atend : null, fmtInt);
        }
        set(8, { formula:`IF(SUM(G4:G${cRow})>0,SUM(G4:G${cRow})/${wAcum},"")`, result: proj ?? '' },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(9, { formula:`IF(H${cRow}>0,H${cRow}/${mensal}*100,"")`, result: projPct ?? '' },
            fmtPct, isWE ? C.WE_BG : C.CALC_BG);
        set(12, { formula:`IF(K${cRow}>0,J${cRow}/K${cRow},"")`, result: pa ?? '' },
            fmtDec, isWE ? C.WE_BG : C.CALC_BG);
      }

      const totRow = ws.getRow(N + 4);
      totRow.height = 18;
      const d1 = 4, dLast = N + 3;
      const tR = N + 4;
      [
        ['TOTAL', '@'],
        ['', '@'],
        [{ formula:`SUM(C${d1}:C${dLast})` }, fmtBRL],
        [{ formula:`D${dLast}` },              fmtBRL],
        [{ formula:`IF(D${tR}>0,G${tR}/D${tR}*100,"")` },   fmtPct],
        [{ formula:`IF(D${tR}>0,G${tR}-D${tR},"")` },       fmtBRL],
        [{ formula:`SUM(G${d1}:G${dLast})` }, fmtBRL],
        [{ formula:`IF(G${tR}>0,G${tR}/${weightAcumByDay[N]},"")` }, fmtBRL],
        [{ formula:`IF(H${tR}>0,H${tR}/${mensal}*100,"")` }, fmtPct],
        [{ formula:`SUM(J${d1}:J${dLast})` }, fmtInt],
        [{ formula:`SUM(K${d1}:K${dLast})` }, fmtInt],
        [{ formula:`IF(K${tR}>0,J${tR}/K${tR},"")` }, fmtDec],
      ].forEach(([val, fmt], i) => {
        const cell = totRow.getCell(i + 1);
        cell.value = val; if (fmt && fmt !== '@') cell.numFmt = fmt;
        cell.fill = C.TOT_BG; cell.font = C.TOT_FG;
        cell.border = thinBorder;
        cell.alignment = { horizontal: i < 2 ? 'center' : 'right', vertical:'middle' };
        cell.protection = { locked: true };
      });

      // Formatação condicional: % PROJ (coluna I) — verde ≥100%, amarelo ≥80%, vermelho <80%
      const cfRef = `I4:I${N + 4}`;
      ws.addConditionalFormatting({
        ref: cfRef,
        rules: [
          { type:'cellIs', operator:'greaterThanOrEqual', formulae:[100], priority:1,
            style:{ fill:{ type:'pattern', pattern:'solid', bgColor:{ argb:'C6EFCE' } },
                    font:{ color:{ argb:'276749' }, bold:true } } },
          { type:'cellIs', operator:'greaterThanOrEqual', formulae:[80],  priority:2,
            style:{ fill:{ type:'pattern', pattern:'solid', bgColor:{ argb:'FFEB9C' } },
                    font:{ color:{ argb:'9C5700' }, bold:true } } },
          { type:'cellIs', operator:'lessThan',           formulae:[80],  priority:3,
            style:{ fill:{ type:'pattern', pattern:'solid', bgColor:{ argb:'FFC7CE' } },
                    font:{ color:{ argb:'9B2335' }, bold:true } } },
        ],
      });

      for (let r = 1; r <= 3; r++)
        ws.getRow(r).eachCell(cell => { cell.protection = { locked: true }; });

      await ws.protect('', {
        selectLockedCells: true, selectUnlockedCells: true,
        formatCells: false, formatColumns: false, formatRows: false,
        insertRows: false, deleteRows: false, sort: false, autoFilter: false,
      });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas'; wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };
    await buildSheet(wb, 'TOTAL', 'total');
    for (const emp of emps)
      await buildSheet(wb, (emp.apelido || emp.name).slice(0, 31), emp.id);

    res.setHeader('Content-Disposition', `attachment; filename="fechamento-${board}-${pad(m)}-${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/excel-vendedor/:year/:month/:board — Fechamento Vendedor p/ impressão ──
// Uma aba por vendedor, no layout de controle manual (DATA/T/META/VENDA/ITENS/
// TICKETS/P.A/P.M/%/AT CLIENTES/CADASTROS), com META diária já calculada pela
// mesma fonte única do sistema (metaLoja/pesos/férias) e total semanal (sáb–sex).
app.get('/api/excel-vendedor/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const user = req.session.user;
    const isAdminOrEscritorio = !user.board || user.board === 'escritorio';
    if (!isAdminOrEscritorio && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });

    const y = parseInt(year), m = parseInt(month);
    const db  = await readDB();
    const pad = n => String(n).padStart(2, '0');
    const DAY_PT    = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const BOARD_NAMES = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem',
                          estacao:'Estação', tommy:'Tommy', lez:'Lez' };
    const storeName = BOARD_NAMES[board] || board;

    const isVendedor = e => e.isVendedor !== false;
    const firstOfMonth = `${y}-${pad(m)}-01`;
    const emps = (db.employees || []).filter(e => e.board === board && isVendedor(e) &&
      (!e.desligamento || e.desligamento >= firstOfMonth));

    // Config (metaLoja/pesos) por mês, com cache — dias de semanas incompletas
    // no início/fim do mês (sáb–sex) usam a config do mês a que realmente pertencem.
    const cfgCache = {};
    function monthCfg(yy, mm) {
      const k = `${yy}-${pad(mm)}`;
      if (cfgCache[k]) return cfgCache[k];
      const dsKey   = `${yy}-${pad(mm)}-${board}`;
      const metaLoja = db.dailySales?.[dsKey]?.meta?.mensal || 0;
      const gWeights = (db.globalWeights || {})[k] || {};
      const N = new Date(yy, mm, 0).getDate();
      cfgCache[k] = { metaLoja, gWeights, defW: 100 / N };
      return cfgCache[k];
    }

    function sellerDayGoal(empId, dateObj) {
      const yy = dateObj.getFullYear(), mm = dateObj.getMonth() + 1, dd = dateObj.getDate();
      const ds = `${yy}-${pad(mm)}-${pad(dd)}`;
      const emp = emps.find(e => e.id === empId);
      if (emp?.omniChannel) return 0;
      const vsKeyFor = eid => `${yy}-${pad(mm)}-${board}-${eid}`;
      const vac = db.vsales?.[vsKeyFor(empId)]?.meta?.vacationDays || [];
      if (vac.includes(ds)) return 0;
      const { metaLoja, gWeights, defW } = monthCfg(yy, mm);
      const w = gWeights[ds] ?? defW;
      if (metaLoja > 0) {
        const nActive = emps.filter(e => !e.omniChannel &&
          !(db.vsales?.[vsKeyFor(e.id)]?.meta?.vacationDays || []).includes(ds)).length;
        return nActive > 0 ? (metaLoja * w / 100) / nActive : 0;
      }
      return (db.vsales?.[vsKeyFor(empId)]?.meta?.mensal || 0) * w / 100;
    }

    // Intervalo dom→sáb que cobre o mês inteiro em semanas completas
    // (mesma convenção de semana — Domingo a Sábado — usada em getWeekForDate/Meta Semanal)
    const rangeStart = new Date(y, m - 1, 1);
    while (rangeStart.getDay() !== 0) rangeStart.setDate(rangeStart.getDate() - 1);
    const rangeEnd = new Date(y, m, 0);
    while (rangeEnd.getDay() !== 6) rangeEnd.setDate(rangeEnd.getDate() + 1);
    const days = [];
    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));

    const HEADS = ['DATA','T','META','VENDA','ITENS','TICKETS','P.A','P.M','%','AT CLIENTES','CADASTROS'];
    const fmtBRL = '#,##0.00';
    const titleFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1C2333' } };
    const titleFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:11, name:'Calibri' };
    const hdrFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8EAED' } };
    const hdrFont   = { bold:true, size:10, name:'Calibri' };
    const totFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4FA' } };
    const totFont   = { bold:true, size:10, name:'Calibri' };
    const thinBorder = { top:{style:'thin',color:{argb:'FFD0D7DE'}}, left:{style:'thin',color:{argb:'FFD0D7DE'}},
                          bottom:{style:'thin',color:{argb:'FFD0D7DE'}}, right:{style:'thin',color:{argb:'FFD0D7DE'}} };

    function buildSheet(wb, sheetName, empId) {
      const ws = wb.addWorksheet(sheetName, { views:[{ state:'frozen', ySplit:2 }] });
      ws.columns = [
        { key:'data', width:11 }, { key:'t', width:6 }, { key:'meta', width:13 },
        { key:'venda', width:13 }, { key:'itens', width:9 }, { key:'tickets', width:10 },
        { key:'pa', width:8 }, { key:'pm', width:8 }, { key:'pct', width:9 },
        { key:'atcli', width:12 }, { key:'cad', width:11 },
      ];
      ws.pageSetup = {
        orientation: 'portrait', paperSize: 9, // A4
        fitToPage: true, fitToWidth: 1, fitToHeight: 1,
        horizontalCentered: true, verticalCentered: true,
        margins: { left:0.25, right:0.25, top:0.3, bottom:0.3, header:0.15, footer:0.15 },
        printTitlesRow: '1:2',
      };
      const numWeeks = days.length / 7;
      const lastRow  = 2 + days.length + numWeeks; // 2 header rows + dias + linhas de total semana
      ws.pageSetup.printArea = `A1:K${lastRow}`;

      ws.mergeCells('A1:K1');
      const title = ws.getCell('A1');
      title.value = `LOJA ${storeName.toUpperCase()} — ${MONTHS_PT[m-1].toUpperCase()}/${y}`;
      title.fill = titleFill; title.font = titleFont;
      title.alignment = { horizontal:'center', vertical:'middle' };
      ws.getRow(1).height = 20;

      const hrow = ws.getRow(2);
      hrow.height = 18;
      HEADS.forEach((h, i) => {
        const cell = hrow.getCell(i + 1);
        cell.value = h; cell.fill = hdrFill; cell.font = hdrFont;
        cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
        cell.border = thinBorder;
      });

      let r = 3, weekStartRow = 3;
      days.forEach(d => {
        const row = ws.getRow(r);
        row.getCell(1).value = `${pad(d.getDate())}/${pad(d.getMonth()+1)}`;
        row.getCell(2).value = DAY_PT[d.getDay()];
        const meta = sellerDayGoal(empId, d);
        const mc = row.getCell(3);
        mc.value = meta > 0 ? +meta.toFixed(2) : null;
        mc.numFmt = fmtBRL;
        for (let c = 1; c <= 11; c++) row.getCell(c).border = thinBorder;
        r++;
        if (d.getDay() === 6) { // sábado = fecha a semana (dom-sáb)
          const wr = ws.getRow(r);
          wr.getCell(1).value = 'TOTAL SEMANA';
          const tc = wr.getCell(3);
          tc.value = { formula: `SUM(C${weekStartRow}:C${r-1})` };
          tc.numFmt = fmtBRL;
          for (let c = 1; c <= 11; c++) {
            wr.getCell(c).fill = totFill; wr.getCell(c).font = totFont;
            wr.getCell(c).border = thinBorder;
          }
          r++;
          weekStartRow = r;
        }
      });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas'; wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };
    for (const emp of emps)
      buildSheet(wb, (emp.apelido || emp.name).slice(0, 31), emp.id);
    if (!emps.length) wb.addWorksheet('Sem vendedores');

    res.setHeader('Content-Disposition', `attachment; filename="fechamento-vendedor-${board}-${pad(m)}-${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/excel/:year/:month/:board — upload fechamento ───────────────
app.post('/api/excel/:year/:month/:board', requireAuth, excelUpload.single('file'), async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const y = parseInt(year), m = parseInt(month);
    const pad = n => String(n).padStart(2, '0');
    const db = await readDB();
    if (!db.vsales) db.vsales = {};

    const emps = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false);
    const empByName = {};
    for (const e of emps) {
      const key = (e.apelido || e.name).slice(0, 31).toLowerCase();
      empByName[key] = e;
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: false, cellNF: false });
    let updated = 0;
    const dateRe = /^(\d{1,2})\/(\d{1,2})/;

    for (const sheetName of wb.SheetNames) {
      if (sheetName.toUpperCase() === 'TOTAL') continue;
      const emp = empByName[sheetName.toLowerCase()];
      if (!emp) continue;
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
      const vsKey = `${y}-${pad(m)}-${board}-${emp.id}`;
      if (!db.vsales[vsKey]) db.vsales[vsKey] = { meta: { mensal: 0 }, entries: {} };

      for (const row of rows) {
        const cell0 = String(row[0] ?? '').trim();
        const match = dateRe.exec(cell0);
        if (!match) continue;
        const dd = match[1].padStart(2, '0');
        const mm = match[2].padStart(2, '0');
        if (mm !== pad(m)) continue;
        const ds = `${y}-${mm}-${dd}`;
        const toNum = v => parseFloat(String(v ?? '').replace(',', '.')) || 0;
        const toInt = v => parseInt(v) || 0;
        const val = toNum(row[6]), pec = toInt(row[8]), atd = toInt(row[9]);
        if (val === 0 && pec === 0 && atd === 0) continue;
        db.vsales[vsKey].entries[ds] = { value: val, pecas: pec, atendimentos: atd };
        updated++;
      }
    }

    await writeDB(db);
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/storefluxo/:year/:month/:board ────────────────────────────────
app.get('/api/storefluxo/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}`;
    const db  = await readDB();
    res.json((db.storeFluxo || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/storefluxo/:year/:month/:board/:date ──────────────────────────
app.put('/api/storefluxo/:year/:month/:board/:date', requireAuth, async (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}`;
    const db  = await readDB();
    if (!db.storeFluxo) db.storeFluxo = {};
    if (!db.storeFluxo[key]) db.storeFluxo[key] = {};
    const val = parseInt(req.body.value) || 0;
    if (val === 0) delete db.storeFluxo[key][date];
    else db.storeFluxo[key][date] = val;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/weekly-metas/:year/:month ────────────────────────────────────
app.get('/api/weekly-metas/:year/:month', requireAuth, async (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = await readDB();
    res.json((db.weeklyMetas || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/weekly-metas/:year/:month/:weekStart/:empId ──────────────────
app.put('/api/weekly-metas/:year/:month/:weekStart/:empId', requireAuth, async (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const { weekStart, empId } = req.params;
    const { meta } = req.body;
    const db = await readDB();
    if (!db.weeklyMetas) db.weeklyMetas = {};
    if (!db.weeklyMetas[key]) db.weeklyMetas[key] = {};
    if (!db.weeklyMetas[key][weekStart]) db.weeklyMetas[key][weekStart] = {};
    db.weeklyMetas[key][weekStart][empId] = { meta: parseFloat(meta) || 0 };
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/campaigns ────────────────────────────────────────────────────
app.get('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const db  = await readDB();
    const all = db.campaigns || [];
    const { board } = req.session.user;
    res.json(board ? all.filter(c => c.scope === 'rede' || c.stores.includes(board)) : all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/campaigns ───────────────────────────────────────────────────
app.post('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const { board } = req.session.user;
    if (board) return res.status(403).json({ error: 'Sem permissão' });
    const { name, kpi, startDate, endDate, stores, scope } = req.body;
    if (!name?.trim() || !kpi || !startDate || !endDate || !Array.isArray(stores) || !stores.length)
      return res.status(400).json({ error: 'Campos obrigatórios: name, kpi, startDate, endDate, stores' });
    const db = await readDB();
    if (!db.campaigns) db.campaigns = [];
    const campaign = {
      id: nextId(db), name: name.trim(), kpi, startDate, endDate, stores,
      scope: scope === 'rede' ? 'rede' : 'loja',
      createdAt: new Date().toISOString(),
    };
    db.campaigns.push(campaign);
    await writeDB(db);
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/campaigns/:id ────────────────────────────────────────────────
app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { board } = req.session.user;
    if (board) return res.status(403).json({ error: 'Sem permissão' });
    const id = parseInt(req.params.id);
    const { name, kpi, startDate, endDate, stores, scope } = req.body;
    if (!name?.trim() || !kpi || !startDate || !endDate || !Array.isArray(stores) || !stores.length)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    const db  = await readDB();
    const idx = (db.campaigns || []).findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Campanha não encontrada' });
    db.campaigns[idx] = {
      ...db.campaigns[idx], name: name.trim(), kpi, startDate, endDate, stores,
      scope: scope === 'rede' ? 'rede' : 'loja',
    };
    await writeDB(db);
    res.json(db.campaigns[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/campaigns/:id ─────────────────────────────────────────────
app.delete('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { board } = req.session.user;
    if (board) return res.status(403).json({ error: 'Sem permissão' });
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.campaigns = (db.campaigns || []).filter(c => c.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/campaigns/:id/ranking-lojas ──────────────────────────────────
// Ranking de campanha cujo KPI é da loja (% desconto, CMV+taxa), calculado a
// partir do Microvix no período. Os dados vêm da Conferência, mas aqui o acesso
// é de qualquer usuário autenticado que participe da campanha — por isso a rota
// devolve só os números da campanha, nunca o dashboard inteiro.
// usaTaxa: só nesses o volume de cartão importa — num ranking de desconto puro
// avisar "sem dados de cartão" seria ruído.
const CAMPAIGN_KPIS_LOJA = {
  desconto_pct: { calc: l => l.percDesconto || 0,                            usaTaxa: false },
  cmv_taxa_pct: { calc: l => (l.cmvPerc || 0) + (l.taxaPercLiquido || 0),    usaTaxa: true  },
};
app.get('/api/campaigns/:id/ranking-lojas', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    const camp = (db.campaigns || []).find(c => c.id === id);
    if (!camp) return res.status(404).json({ error: 'Campanha não encontrada' });

    const kpiDef = CAMPAIGN_KPIS_LOJA[camp.kpi];
    if (!kpiDef) return res.status(400).json({ error: 'KPI da campanha não é por loja' });

    // Usuário de loja só vê campanha da qual participa
    const board = req.session.user.board;
    if (board && camp.scope !== 'rede' && !(camp.stores || []).includes(board)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }

    const { porLoja } = await computeConferenciaDashboard(camp.startDate, camp.endDate);
    const participa = b => camp.scope === 'rede' || (camp.stores || []).includes(b);

    const ranking = porLoja
      .filter(l => !l.erro && participa(l.board) && l.vlrLiquido > 0)
      .map(l => ({
        board:      l.board,
        kpiValue:   kpiDef.calc(l),
        vlrLiquido: l.vlrLiquido,
        // só quando a taxa entra no KPI: sem cartão ela não somou e o valor fica otimista
        semCartao:  kpiDef.usaTaxa && (l.vlrCartao || 0) === 0,
      }));

    // Nestes KPIs menor é melhor
    ranking.sort((a, b) => a.kpiValue - b.kpiValue);
    res.json({ kpi: camp.kpi, menorMelhor: true, ranking });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/nf-items ─────────────────────────────────────────────────────
app.get('/api/nf-items', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.nfItems || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/nf-items ────────────────────────────────────────────────────
app.post('/api/nf-items', requireAuth, async (req, res) => {
  try {
    const { text, board } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });
    if (!board || !BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const db = await readDB();
    if (!db.nfItems) db.nfItems = [];
    const item = {
      id: nextId(db), text: text.trim(), board, checked: false,
      addedBy: req.session.user.label || req.session.user.username,
      addedAt: new Date().toISOString(),
      status: 'pendente',
    };
    db.nfItems.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/nf-items/:id ───────────────────────────────────────────────
app.patch('/api/nf-items/:id', requireAuth, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.nfItems || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    if ('checked' in req.body) {
      item.checked = !!req.body.checked;
      if (item.checked && !item.archived) {
        item.archived = true;
        item.archivedAt = new Date().toISOString();
        item.archivedBy = req.session.user.label || req.session.user.username;
      }
    }
    if ('text' in req.body && req.body.text?.trim()) item.text = req.body.text.trim();
    if ('status' in req.body && ['autorizado','não receber','pendente'].includes(req.body.status)) {
      if (req.session.user.board) return res.status(403).json({ error: 'Apenas admin pode alterar status' });
      item.status = req.body.status;
      item.statusBy = req.session.user.label || req.session.user.username;
      item.statusAt = new Date().toISOString();
    }
    if (req.body.archived === true && !item.archived) {
      const isAdmin = !req.session.user.board || req.session.user.board === 'escritorio';
      const currentUser = req.session.user.label || req.session.user.username;
      if (!isAdmin && item.addedBy !== currentUser)
        return res.status(403).json({ error: 'Apenas quem criou o item pode excluí-lo' });
      item.archived = true;
      item.archivedAt = new Date().toISOString();
      item.archivedBy = currentUser;
    }
    if (req.body.archived === false && item.archived) {
      const isAdmin = !req.session.user.board || req.session.user.board === 'escritorio';
      const currentUser = req.session.user.label || req.session.user.username;
      if (!isAdmin && item.addedBy !== currentUser)
        return res.status(403).json({ error: 'Apenas quem criou o item pode restaurá-lo' });
      item.archived   = false;
      item.archivedAt = null;
      item.archivedBy = null;
      item.checked    = false;
    }
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/nf-items/:id ──────────────────────────────────────────────
app.delete('/api/nf-items/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.nfItems = (db.nfItems || []).filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/meeting-items ───────────────────────────────────────────────
app.get('/api/meeting-items', requireAuth, async (req, res) => {
  try {
    const db      = await readDB();
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    const items = (db.meetingItems || []).filter(x =>
      isAdminOrEscritorio || (x.board === board && x.visibility === 'loja')
    );
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/meeting-items ──────────────────────────────────────────────
app.post('/api/meeting-items', requireAuth, async (req, res) => {
  try {
    const { text, board, year, month, visibility } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });
    const { board: userBoard } = req.session.user;
    const isAdminOrEscritorio = !userBoard || userBoard === 'escritorio';
    const effectiveBoard = isAdminOrEscritorio ? board : userBoard;
    if (!effectiveBoard || !BOARDS.includes(effectiveBoard)) return res.status(400).json({ error: 'Loja inválida' });
    const db = await readDB();
    if (!db.meetingItems) db.meetingItems = [];
    const item = {
      id: nextId(db), text: text.trim(), board: effectiveBoard,
      year: parseInt(year) || new Date().getFullYear(),
      month: parseInt(month) || (new Date().getMonth() + 1),
      visibility: isAdminOrEscritorio ? (visibility === 'loja' ? 'loja' : 'admin') : 'loja',
      origin: isAdminOrEscritorio ? 'admin' : 'loja',
      checked: false,
      addedBy: req.session.user.label || req.session.user.username,
      addedAt: new Date().toISOString(),
    };
    db.meetingItems.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/meeting-items/:id ─────────────────────────────────────────
app.patch('/api/meeting-items/:id', requireAuth, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.meetingItems || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    const isAdmin = !req.session.user.board;
    if ('visibility' in req.body && isAdmin) item.visibility = req.body.visibility === 'loja' ? 'loja' : 'admin';
    if ('checked' in req.body) {
      item.checked = !!req.body.checked;
      if (item.checked && !item.archived) {
        item.archived = true;
        item.archivedAt = new Date().toISOString();
        item.archivedBy = req.session.user.label || req.session.user.username;
      }
    }
    if (req.body.archived === true && !item.archived) {
      item.archived = true;
      item.archivedAt = new Date().toISOString();
      item.archivedBy = req.session.user.label || req.session.user.username;
    }
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/meeting-items/:id ────────────────────────────────────────
app.delete('/api/meeting-items/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.meetingItems = (db.meetingItems || []).filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/pendencias ────────────────────────────────────────────────────
app.get('/api/pendencias', requireAuth, async (req, res) => {
  try {
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    if (!isAdminOrEscritorio) return res.status(403).json({ error: 'Acesso restrito' });
    const db = await readDB();
    res.json(db.pendencias || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pendencias ───────────────────────────────────────────────────
app.post('/api/pendencias', requireAuth, async (req, res) => {
  if (req.session.user.board && req.session.user.board !== 'escritorio')
    return res.status(403).json({ error: 'Acesso restrito' });
  try {
    const { text, assignedTo, recorrencia } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });
    const rawAt = assignedTo;
    const assignedToArr = Array.isArray(rawAt) ? rawAt : (rawAt ? [rawAt] : ['leonardo','ingrid','escritorio']);
    const validRec = ['daily','weekly','quinzenal','monthly'];
    const db = await readDB();
    if (!db.pendencias) db.pendencias = [];
    const item = {
      id: nextId(db),
      text: text.trim(),
      assignedTo: assignedToArr,
      createdBy: req.session.user.username,
      createdByLabel: req.session.user.label,
      createdAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolvedBy: null,
      recorrencia: validRec.includes(recorrencia) ? recorrencia : null,
    };
    db.pendencias.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/pendencias/:id ──────────────────────────────────────────────
app.patch('/api/pendencias/:id', requireAuth, async (req, res) => {
  if (req.session.user.board && req.session.user.board !== 'escritorio')
    return res.status(403).json({ error: 'Acesso restrito' });
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.pendencias || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Pendência não encontrada' });
    let nextItem = null;
    if ('resolved' in req.body) {
      item.resolved = !!req.body.resolved;
      item.resolvedAt = item.resolved ? new Date().toISOString() : null;
      item.resolvedBy = item.resolved ? (req.session.user.label || req.session.user.username) : null;
      if (item.resolved && item.recorrencia) {
        nextItem = {
          id: nextId(db),
          text: item.text,
          assignedTo: [...item.assignedTo],
          createdBy: item.createdBy,
          createdByLabel: item.createdByLabel,
          createdAt: new Date().toISOString(),
          resolved: false,
          resolvedAt: null,
          resolvedBy: null,
          recorrencia: item.recorrencia,
        };
        db.pendencias.push(nextItem);
      }
    }
    if ('text' in req.body && req.body.text?.trim()) item.text = req.body.text.trim();
    if ('assignedTo' in req.body) {
      const raw = req.body.assignedTo;
      item.assignedTo = Array.isArray(raw) ? raw : [raw];
    }
    await writeDB(db);
    res.json(nextItem ? { ...item, _next: nextItem } : item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/pendencias/:id ─────────────────────────────────────────────
app.delete('/api/pendencias/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.pendencias = (db.pendencias || []).filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/requisicoes ───────────────────────────────────────────────────
app.get('/api/requisicoes', requireAuth, async (req, res) => {
  try {
    const db      = await readDB();
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    const items   = (db.requisicoes || []).filter(x =>
      isAdminOrEscritorio || x.board === board
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/requisicoes ──────────────────────────────────────────────────
app.post('/api/requisicoes', requireAuth, async (req, res) => {
  try {
    const board = req.session.user.board;
    if (!board) return res.status(400).json({ error: 'Apenas lojas podem criar requisições' });
    const { embalagens, materiais, observacao, contagemId } = req.body;
    const db = await readDB();
    if (!db.requisicoes) db.requisicoes = [];
    // Embalagem só entra por contagem. Sem isso ela ficaria invisível para o
    // pedido consolidado, que é montado a partir das contagens.
    if (Object.keys(embalagens || {}).length) {
      const c = (db.contagensEmbalagem || []).find(x => x.id === Number(contagemId) && x.board === board);
      if (!c) return res.status(400).json({ error: 'Requisição de embalagem exige uma contagem — use a aba Contagem Embalagens' });
    }
    // embalagens continua sendo { nome: peças } (formato antigo, usado no histórico).
    // embalagensModulos guarda o pedido em caixa fechada, quando veio de uma contagem.
    const itensLoja = new Map(embalagensDaLoja(db, board).map(i => [i.nome, i]));
    const embalagensModulos = {};
    for (const [nome, pecas] of Object.entries(embalagens || {})) {
      const it = itensLoja.get(nome);
      if (!it || it.modulo <= 1) continue;
      embalagensModulos[nome] = { modulos: Math.ceil(pecas / it.modulo), modulo: it.modulo, cod: it.cod };
    }
    const item = {
      id: nextId(db), board,
      embalagens: embalagens || {},
      embalagensModulos,
      contagemId: Number(contagemId) || null,
      materiais:  materiais  || [],
      observacao: (observacao || '').trim(),
      status:    'pendente',
      createdAt:  new Date().toISOString(),
      createdBy:  req.session.user.label || req.session.user.username,
      updatedAt:  null,
      updatedBy:  null,
    };
    db.requisicoes.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/requisicoes/:id ────────────────────────────────────────────
app.patch('/api/requisicoes/:id', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.requisicoes || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (req.body.status) item.status = req.body.status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Soma de tudo que já foi lançado como recebido nesta requisição, por item.
function totalRecebido(item) {
  const t = {};
  for (const rc of (item.recebimentos || []))
    for (const [nome, q] of Object.entries(rc.qtd || {}))
      t[nome] = (t[nome] || 0) + (Number(q) || 0);
  return t;
}

// Já chegou tudo o que foi pedido?
function requisicaoCompleta(item) {
  const total = totalRecebido(item);
  const pedido = Object.entries(item.embalagens || {});
  return pedido.length > 0 && pedido.every(([nome, ped]) => (total[nome] || 0) >= (Number(ped) || 0));
}

// ── POST /api/requisicoes/:id/recebimento ─────────────────────────────────
// A entrega de embalagem vem parcelada e nem sempre bate com o que foi pedido
// (o fornecedor tem 15% de tolerância). Marcar a requisição inteira como
// "recebido" jogaria a quantidade PEDIDA na medição de consumo, na data do
// clique. Aqui o admin lança o que chegou de verdade e quando chegou — é isso
// que medirConsumo() usa para fechar o ciclo.
app.post('/api/requisicoes/:id/recebimento', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.requisicoes || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Requisição não encontrada' });

    const data = String(req.body.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida' });
    if (data > todayBRT()) return res.status(400).json({ error: 'Data de recebimento não pode ser futura' });
    // Não trava quem lança atrasado — a entrega parcelada às vezes só é
    // registrada dias depois. Barra só o erro de digitação de ano.
    const limite = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    if (data < limite) return res.status(400).json({ error: 'Recebimento com mais de 180 dias — confira a data' });

    // Só itens da própria requisição — o recebimento confere uma entrega, não
    // inventa item novo. Pode passar do pedido: a tolerância é de 15%.
    const qtd = {};
    for (const [nome, v] of Object.entries(req.body.qtd || {})) {
      if (!(nome in (item.embalagens || {}))) continue;
      const n = Math.round(Number(v) || 0);
      if (n > 0) qtd[nome] = n;
    }
    if (!Object.keys(qtd).length) return res.status(400).json({ error: 'Informe ao menos um item recebido' });

    if (!item.recebimentos) item.recebimentos = [];
    item.recebimentos.push({
      data, qtd,
      por: req.session.user.label || req.session.user.username,
      em:  new Date().toISOString(),
    });

    // Fecha sozinha quando tudo que foi pedido já chegou; faltando parcela, a
    // requisição continua aberta para receber o resto.
    const completa = requisicaoCompleta(item);
    if (completa) item.status = 'recebido';
    item.updatedAt = new Date().toISOString();
    item.updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);

    // A medição de consumo roda no instante em que a loja lança a contagem. Se
    // já existe contagem nessa data ou depois, aquele ciclo fechou sem esta
    // entrada e não é refeito — o admin precisa saber, senão o consumo medido
    // fica errado em silêncio.
    const jaContado = (db.contagensEmbalagem || [])
      .some(c => c.board === item.board && (c.data || '') >= data);
    res.json({
      item, completa,
      aviso: jaContado
        ? 'Já existe contagem desta loja nessa data ou depois. O consumo daquele ciclo foi medido sem este recebimento e não será refeito — lance o recebimento antes da contagem.'
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/requisicoes/:id/recebimento/:idx ──────────────────────────
// Lançamento manual erra; sem desfazer, o erro vira consumo medido errado.
app.delete('/api/requisicoes/:id/recebimento/:idx', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const idx  = parseInt(req.params.idx);
    const db   = await readDB();
    const item = (db.requisicoes || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!Array.isArray(item.recebimentos) || !item.recebimentos[idx])
      return res.status(404).json({ error: 'Recebimento não encontrado' });
    item.recebimentos.splice(idx, 1);
    const completa = requisicaoCompleta(item);
    if (!completa && item.status === 'recebido') item.status = 'enviado';
    item.updatedAt = new Date().toISOString();
    item.updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);
    res.json({ item, completa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/requisicoes/:id ───────────────────────────────────────────
app.delete('/api/requisicoes/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.requisicoes = (db.requisicoes || []).filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/embalagens ───────────────────────────────────────────────────
// Loja: só o próprio catálogo + status. Admin/escritório: todas as lojas.
app.get('/api/embalagens', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    const boards = isAdminOrEscritorio
      ? EMBAL_STORE_BOARDS
      : EMBAL_STORE_BOARDS.filter(b => b === board);
    const itens = {}, status = {}, projecao = {};
    for (const b of boards) {
      itens[b]    = embalagensDaLoja(db, b);
      status[b]   = statusContagem(db, b);
      projecao[b] = projecaoAnual(db, b);
    }
    res.json({ itens, status, projecao, diasContagem: EMBAL_DIAS_CONTAGEM, horizonteMeses: embalHorizonteMeses(db), pisoMeses: embalPisoMeses(db) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/embalagens/config/:board ────────────────────────────────────
// Só o admin define mínimo e peças por módulo de cada item da loja.
app.post('/api/embalagens/config/:board', requireAdmin, async (req, res) => {
  try {
    const board = req.params.board;
    if (!EMBAL_STORE_BOARDS.includes(board))
      return res.status(400).json({ error: 'Loja inválida' });
    const db = await readDB();
    if (!db.embalagemConfig) db.embalagemConfig = {};
    const validKeys = new Set([...EMBALAGENS_BASE, ...(EMBALAGENS_EXTRA[board] || [])].map(i => i.key));
    const cfg = {};
    for (const [key, v] of Object.entries(req.body.config || {})) {
      if (!validKeys.has(key)) continue;
      cfg[key] = {
        // min = trava manual; 0 devolve o item para o cálculo automático
        min:    Math.max(0, Math.round(Number(v?.min)    || 0)),
        modulo: Math.max(1, Math.round(Number(v?.modulo) || 1)),
        porTicket: Math.max(0, Number(v?.porTicket) || 0),
      };
    }
    db.embalagemConfig[board] = cfg;
    // Lead time é da rede, não da loja — chega junto para não exigir outra tela
    if (req.body.pisoMeses !== undefined) {
      const v = Number(req.body.pisoMeses);
      if (!Number.isFinite(v) || v <= 0 || v > 24)
        return res.status(400).json({ error: 'Piso deve ser de 1 a 24 meses' });
      db.embalagemParams = { ...(db.embalagemParams || {}), pisoMeses: v };
    }
    if (req.body.horizonteMeses !== undefined) {
      const v = Number(req.body.horizonteMeses);
      if (!Number.isFinite(v) || v <= 0 || v > 24)
        return res.status(400).json({ error: 'Cobertura deve ser de 1 a 24 meses' });
      db.embalagemParams = { ...(db.embalagemParams || {}), horizonteMeses: v };
    }
    await writeDB(db);
    res.json({ ok: true, itens: embalagensDaLoja(db, board), cobertura: coberturaLoja(db, board), projecao: projecaoAnual(db, board) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/embalagens/contagem ─────────────────────────────────────────
// A loja lança o que tem em peças; devolve a sugestão de pedido em módulos.
// Não cria requisição — a loja revisa a sugestão e envia pelo fluxo normal.
app.post('/api/embalagens/contagem', requireAuth, async (req, res) => {
  try {
    const board = req.session.user.board;
    if (!board || !EMBAL_STORE_BOARDS.includes(board))
      return res.status(400).json({ error: 'Apenas lojas podem lançar contagem' });
    const db = await readDB();
    if (!db.contagensEmbalagem) db.contagensEmbalagem = [];
    const itens = embalagensDaLoja(db, board);
    const contagem = {};
    for (const it of itens) {
      const v = req.body.contagem?.[it.key];
      contagem[it.key] = Math.max(0, Math.round(Number(v) || 0));
    }
    const anterior = (db.contagensEmbalagem || [])
      .filter(c => c.board === board)
      .sort((a, b) => (b.data || '').localeCompare(a.data || ''))[0] || null;
    const item = {
      id: nextId(db), board,
      data:      todayBRT(),
      contagem,
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.label || req.session.user.username,
    };
    db.contagensEmbalagem.push(item);
    // Fecha o ciclo: com duas contagens dá para medir o consumo real e parar
    // de depender do padrão do catálogo.
    gravarConsumoMedido(db, board, medirConsumo(db, board, item, anterior));
    await writeDB(db);
    res.json({
      contagem: item,
      status:   statusContagem(db, board),
      sugestao: itens.map(it => ({ ...it, contado: contagem[it.key], ...sugestaoEmbalagem(it, contagem[it.key]) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Divide o pedido já fechado entre as lojas, em módulos inteiros. Não dá para
// entregar 97 peças de um item que vem em pacote de 100: a coluna da loja tem
// de ser múltiplo do módulo, e as colunas precisam somar EXATAMENTE o total
// comprado — senão o pedido não bate na hora de conferir a entrega.
//
// Método do maior resto: cada loja leva os módulos inteiros da sua necessidade
// e os que sobram vão para quem ficou com a maior fração. Como o total foi
// arredondado uma vez só, sobre a soma do grupo, pode não haver módulo para
// todo mundo receber a necessidade cheia — é o preço de não inflar o pedido
// arredondando loja a loja. Quem fica curto aparece na sugestão de
// remanejamento, logo abaixo no mesmo relatório.
function distribuirModulos(faltaPorLoja, modulo, totalModulos) {
  const boards = Object.keys(faltaPorLoja);
  const base = {}, restos = [];
  let usados = 0;
  for (const b of boards) {
    const falta   = Math.max(0, faltaPorLoja[b] || 0);
    const exato   = falta / modulo;
    const inteiro = Math.floor(exato);
    base[b] = inteiro;
    usados += inteiro;
    restos.push({ b, resto: exato - inteiro, falta });
  }
  restos.sort((x, y) => y.resto - x.resto || y.falta - x.falta);
  let sobrando = totalModulos - usados;
  for (const r of restos) {
    if (sobrando <= 0) break;
    if (r.falta <= 0) continue;  // loja que não precisa de nada não recebe caixa
    base[r.b]++; sobrando--;
  }
  // Rede de segurança: se ainda sobrar módulo, vai inteiro para a maior
  // necessidade. Pela conta do maior resto isso não acontece, mas o total não
  // pode ficar diferente da soma das colunas em nenhuma hipótese.
  if (sobrando > 0) {
    const maior = restos.slice().sort((x, y) => y.falta - x.falta)[0];
    if (maior) base[maior.b] += sobrando;
  }
  return Object.fromEntries(boards.map(b => [b, base[b] * modulo]));
}

// Monta o pedido consolidado a partir da última contagem de cada loja.
// Usada pela tela e pelo Excel — o arquivo nunca diverge do que está em tela.
function montarPedido(db) {
  const ultimaPorLoja = {};
      for (const c of (db.contagensEmbalagem || [])) {
        const at = ultimaPorLoja[c.board];
        if (!at || (c.data || '') > (at.data || '')) ultimaPorLoja[c.board] = c;
      }
      return EMBAL_GRUPOS.map(g => {
        const linhas = {};
        for (const board of g.boards) {
          const cont = ultimaPorLoja[board];
          const entregue = cont ? entreguesDesde(db, board, cont.data) : {};
          for (const it of embalagensDaLoja(db, board)) {
            const contado = cont?.contagem?.[it.key] ?? null;
            const ent     = entregue[it.key] || 0;
            // O que a loja tem HOJE: o que contou mais o que chegou depois.
            const estoque = contado != null ? contado + ent : null;
            const s = cont ? sugestaoEmbalagem(it, estoque) : { falta: 0, modulos: 0, pecas: 0 };
            if (!linhas[it.key]) linhas[it.key] = { key: it.key, nome: it.nome, cod: it.cod, modulo: it.modulo, porLoja: {}, pecas: 0 };
            linhas[it.key].porLoja[board] = { contado, entregue: ent, estoque, min: it.min, ...s };
            // Soma a falta CRUA, em peças. Somar a quantidade já arredondada de
            // cada loja arredondaria uma vez por loja e inflaria o pedido.
            linhas[it.key].pecas += s.falta;
          }
        }
        // Fecha o módulo UMA vez, sobre a necessidade somada do grupo.
        // pecas = necessidade crua · pedido = o que efetivamente será comprado.
        const todos = Object.values(linhas).map(l => {
          const modulos = l.modulo > 1 ? Math.ceil(l.pecas / l.modulo) : l.pecas;
          const pedido  = l.modulo > 1 ? modulos * l.modulo : l.pecas;
          const mod     = l.modulo > 1 ? l.modulo : 1;
          const falta   = Object.fromEntries(g.boards.map(b => [b, l.porLoja[b]?.falta || 0]));
          return { ...l, modulos, pedido, sobra: pedido - l.pecas,
                   entrega: distribuirModulos(falta, mod, pedido / mod) };
        });
  
        // Antes de comprar, olhar o que já está na rede: loja com sobra acima do
        // próprio alvo pode abastecer a que está faltando. Não guardamos estoque
        // no escritório, então a transferência é sempre de loja para loja.
        const transferencias = [];
        for (const l of todos) {
          const sobra = [], falta = [];
          for (const b of g.boards) {
            const p = l.porLoja[b];
            if (!p || p.estoque == null) continue;
            const dif = p.estoque - p.alvo;
            if (dif > 0) sobra.push({ board: b, qtd: dif });
            else if (p.falta > 0) falta.push({ board: b, qtd: p.falta });
          }
          sobra.sort((a, b) => b.qtd - a.qtd);
          falta.sort((a, b) => b.qtd - a.qtd);
          let i = 0, j = 0;
          while (i < sobra.length && j < falta.length) {
            const qtd = Math.min(sobra[i].qtd, falta[j].qtd);
            if (qtd > 0) {
              transferencias.push({ key: l.key, nome: l.nome, de: sobra[i].board, para: falta[j].board, qtd });
              sobra[i].qtd -= qtd; falta[j].qtd -= qtd;
            }
            if (sobra[i].qtd <= 0) i++;
            if (falta[j].qtd <= 0) j++;
          }
        }
  
        // Entregas já lançadas, agrupadas pelo lote em que foram registradas —
        // um lote é uma chegada só, rateada entre as lojas do grupo.
        const lotes = {};
        for (const e of (db.entregasEmbalagem || [])) {
          if (!g.boards.includes(e.board)) continue;
          const k = e.lote || `av-${e.id}`;
          if (!lotes[k]) lotes[k] = { lote: k, data: e.data, obs: e.obs || '', por: e.createdBy || '', porLoja: {} };
          if (e.data < lotes[k].data) lotes[k].data = e.data;
          lotes[k].porLoja[e.board] = e.itens || {};
        }
        const entregas = Object.values(lotes)
          .sort((a, b) => b.data.localeCompare(a.data))
          .slice(0, 12);

        return {
          key: g.key, label: g.label, boards: g.boards,
          // A tabela é a lista de compras, então item em dia sai da frente. Mas
          // o que acabou de ser entregue FICA, mesmo zerando a falta: quem
          // lançou a entrega precisa ver o efeito dela, e some sozinho na
          // próxima contagem — quando `entregue` volta a zero porque a contagem
          // nova já inclui a mercadoria.
          itens: todos.filter(l => l.pecas > 0 || g.boards.some(b => l.porLoja[b]?.entregue > 0)),
          // `itens` é a lista de compras — só o que falta. `todos` é o catálogo
          // cheio com o estoque de cada loja: alimenta o painel de estoque e o
          // formulário de entrega, que pode trazer item sem falta nenhuma.
          todos,
          entregas,
          // O "mínimo do centro" é só a soma do que as lojas precisam ter.
          centro: Object.fromEntries(Object.values(linhas).map(l => [l.key, {
            nome: l.nome,
            piso:  g.boards.reduce((s, b) => s + (l.porLoja[b]?.min  || 0), 0),
            alvo:  g.boards.reduce((s, b) => s + (l.porLoja[b]?.alvo || 0), 0),
          }])),
          transferencias,
          semContagem: g.boards.filter(b => !ultimaPorLoja[b]),
          contagens: Object.fromEntries(g.boards.map(b => [b, ultimaPorLoja[b]?.data || null])),
        };
      });
}

// ── POST /api/embalagens/entrega ──────────────────────────────────────────
// A entrega das Surfers não nasce de requisição: é o pedido anual chegando
// parcelado na sala 505 e sendo rateado entre as lojas. Lançar aqui é o que
// fecha a conta de medirConsumo() — sem isso a contagem seguinte dá consumo
// negativo e o ciclo é descartado.
app.post('/api/embalagens/entrega', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();

    const data = String(req.body.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida' });
    if (data > todayBRT()) return res.status(400).json({ error: 'Data de entrega não pode ser futura' });
    const limite = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    if (data < limite) return res.status(400).json({ error: 'Entrega com mais de 180 dias — confira a data' });

    // Um lote = uma chegada. Guarda um registro por loja para a medição de
    // consumo ser por loja, mas dá para desfazer a chegada inteira de uma vez.
    const lote = `L${Date.now()}`;
    const criados = [];
    if (!db.entregasEmbalagem) db.entregasEmbalagem = [];
    for (const [board, itens] of Object.entries(req.body.porLoja || {})) {
      if (!EMBAL_STORE_BOARDS.includes(board)) continue;
      const validas = new Set(embalagensDaLoja(db, board, data).map(i => i.key));
      const limpo = {};
      for (const [k, v] of Object.entries(itens || {})) {
        if (!validas.has(k)) continue;
        const n = Math.round(Number(v) || 0);
        if (n > 0) limpo[k] = n;
      }
      if (!Object.keys(limpo).length) continue;
      const item = {
        id: nextId(db), lote, board, data, itens: limpo,
        obs: String(req.body.obs || '').trim().slice(0, 300),
        createdAt: new Date().toISOString(),
        createdBy: req.session.user.label || req.session.user.username,
      };
      db.entregasEmbalagem.push(item);
      criados.push(item);
    }
    if (!criados.length) return res.status(400).json({ error: 'Informe o que chegou em ao menos uma loja' });
    await writeDB(db);

    // A medição roda no instante da contagem e não é refeita: se a loja já
    // contou nessa data ou depois, aquele ciclo fechou sem esta entrega.
    const tarde = criados
      .filter(c => (db.contagensEmbalagem || []).some(x => x.board === c.board && (x.data || '') >= data))
      .map(c => c.board);
    res.json({
      lote, criados, grupos: montarPedido(db),
      aviso: tarde.length
        ? `Estas lojas já contaram nessa data ou depois: ${tarde.join(', ')}. O consumo daquele ciclo foi medido sem esta entrega e não será refeito — lance a entrega antes da contagem.`
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/embalagens/entrega/:lote ──────────────────────────────────
// Desfaz a chegada inteira: o lançamento é manual e o erro de digitação vira
// consumo medido errado.
app.delete('/api/embalagens/entrega/:lote', requireAdmin, async (req, res) => {
  try {
    const lote = String(req.params.lote);
    const db = await readDB();
    const antes = (db.entregasEmbalagem || []).length;
    db.entregasEmbalagem = (db.entregasEmbalagem || []).filter(e => (e.lote || `av-${e.id}`) !== lote);
    if (db.entregasEmbalagem.length === antes) return res.status(404).json({ error: 'Entrega não encontrada' });
    await writeDB(db);
    res.json({ ok: true, grupos: montarPedido(db) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/embalagens/pedido ────────────────────────────────────────────
// Pedido consolidado por grupo de compra. Só admin — é quem fecha com o fornecedor.
app.get('/api/embalagens/pedido', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.json({ grupos: montarPedido(db) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/embalagens/pedido/export ─────────────────────────────────────
// Excel do pedido: uma aba por grupo de compra. A parte de cima é o que vai
// para o fornecedor (código, item, módulos); as colunas de loja à direita são
// a distribuição interna quando a mercadoria chegar.
app.get('/api/embalagens/pedido/export', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    // A tela mantém à vista o item que acabou de ser entregue mesmo com falta
    // zero; o arquivo do fornecedor, não — linha de 0 módulo não se pede.
    const grupos = montarPedido(db)
      .map(g => ({ ...g, itens: g.itens.filter(i => i.pecas > 0) }))
      .filter(g => g.itens.length);
    if (!grupos.length) return res.status(400).json({ error: 'Nenhum item a pedir — faça as contagens primeiro.' });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas';
    wb.created = new Date();
    const hoje = new Date().toLocaleDateString('pt-BR');

    const C_TITULO   = 'FF111827';
    const C_HEADER   = 'FF1F2937';
    const C_BRANCO   = 'FFFFFFFF';
    const C_ZEBRA    = 'FFF3F4F6';
    const C_BORDA    = 'FFD1D5DB';
    const C_PEDIR    = 'FF1D4ED8';
    const C_ALERTA   = 'FFB45309';
    const C_SOBRA_BG = 'FFFEF3C7';

    for (const g of grupos) {
      const lojas = g.boards;
      const defs = [
        { header: 'Cód. Forn.', width: 12 },
        { header: 'Item',       width: 34 },
        { header: 'Pç/Módulo',  width: 11 },
        { header: 'Módulos',    width:  9 },
        { header: 'Total pç',   width: 10 },
        ...lojas.map(b => ({ header: (BOARDS_LABEL[b] || b).toUpperCase(), width: 12 })),
        { header: 'Sobra',      width:  9 },
      ];
      const nCols = defs.length;

      const ws = wb.addWorksheet(g.label.slice(0, 31), {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                     margins: { left: .4, right: .4, top: .5, bottom: .5, header: .2, footer: .2 } },
        headerFooter: { oddHeader: `&L&BPEDIDO DE EMBALAGEM — ${g.label.toUpperCase()}&R&BData: ${hoje}` },
      });
      ws.columns = defs.map(d => ({ width: d.width }));

      // Linha 1 — título
      const t = ws.getRow(1);
      t.getCell(1).value = `PEDIDO DE EMBALAGEM — ${g.label.toUpperCase()}   |   Data: ${hoje}`;
      t.getCell(1).font = { bold: true, size: 13, color: { argb: C_BRANCO } };
      t.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_TITULO } };
      t.getCell(1).alignment = { vertical: 'middle' };
      t.height = 24;
      ws.mergeCells(1, 1, 1, nCols);

      // Linha 2 — procedência dos números
      const datas = lojas.map(b => `${BOARDS_LABEL[b] || b} ${g.contagens[b] ? g.contagens[b].split('-').reverse().join('/') : 'sem contagem'}`).join('  ·  ');
      const s2 = ws.getRow(2);
      s2.getCell(1).value = `Baseado na última contagem de cada loja: ${datas}`;
      s2.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };
      s2.height = 15;
      ws.mergeCells(2, 1, 2, nCols);

      let linha = 3;
      if (g.semContagem.length) {
        const av = ws.getRow(linha);
        av.getCell(1).value = `ATENÇÃO: ${g.semContagem.map(b => BOARDS_LABEL[b] || b).join(', ')} ainda não contou — o pedido pode estar subdimensionado.`;
        av.getCell(1).font = { bold: true, size: 9, color: { argb: C_ALERTA } };
        av.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SOBRA_BG } };
        av.height = 15;
        ws.mergeCells(linha, 1, linha, nCols);
        linha++;
      }
      linha++; // respiro

      // Cabeçalho
      const hdrNum = linha;
      const hdr = ws.getRow(hdrNum);
      defs.forEach((d, i) => {
        const c = hdr.getCell(i + 1);
        c.value = d.header;
        c.font  = { bold: true, size: 10, color: { argb: C_BRANCO } };
        c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
        c.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center', wrapText: true };
        c.border = { bottom: { style: 'medium', color: { argb: C_BORDA } } };
      });
      hdr.height = 20;
      ws.views = [{ state: 'frozen', ySplit: hdrNum }];

      // Itens
      const somaLoja = Object.fromEntries(lojas.map(b => [b, 0]));
      let totModulos = 0, totPecas = 0, totSobra = 0;

      g.itens.forEach((it, idx) => {
        const r = ws.getRow(hdrNum + 1 + idx);
        // A coluna da loja é o que ENTREGAR nela, em caixa fechada — por isso
        // as colunas somam o Total pç. A necessidade crua de cada uma fica no
        // comentário da célula, para conferir de onde saiu o número.
        const qtdLoja = lojas.map(b => it.entrega?.[b] ?? (it.porLoja[b]?.falta || 0));
        const necessidade = it.pecas;      // soma crua das lojas
        const pedido = it.pedido;          // já fechado em caixa fechada
        const sobra  = it.sobra;
        qtdLoja.forEach((q, i) => { somaLoja[lojas[i]] += q; });
        totModulos += it.modulos; totPecas += pedido; totSobra += sobra;

        const vals = [
          it.cod || '—', it.nome, it.modulo > 1 ? it.modulo : '—',
          it.modulo > 1 ? it.modulos : '—', pedido, ...qtdLoja, sobra || '',
        ];
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.font  = { size: 9 };
          c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 ? C_ZEBRA : C_BRANCO } };
          c.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center' };
          c.border = {
            top:    { style: 'thin', color: { argb: C_BORDA } },
            bottom: { style: 'thin', color: { argb: C_BORDA } },
            left:   { style: 'thin', color: { argb: C_BORDA } },
            right:  { style: 'thin', color: { argb: C_BORDA } },
          };
          if (i === 3 || i === 4) c.font = { bold: true, size: 9, color: { argb: C_PEDIR } };
          if (i >= 5 && i < 5 + lojas.length) {
            if (v > 0) c.font = { bold: true, size: 9 };
            const bl  = lojas[i - 5];
            const cru = it.porLoja[bl]?.falta || 0;
            c.note = `${BOARDS_LABEL[bl] || bl} · necessidade ${cru} pç · entregar ${v} pç`;
          }
          if (i === vals.length - 1 && v) c.font = { size: 9, color: { argb: C_ALERTA } };
        });
        r.height = 15;
      });

      // Total
      const totR = ws.getRow(hdrNum + 1 + g.itens.length);
      const totVals = ['', 'TOTAL', '', totModulos, totPecas,
                       ...lojas.map(b => somaLoja[b]), totSobra || ''];
      totVals.forEach((v, i) => {
        const c = totR.getCell(i + 1);
        c.value = v;
        c.font  = { bold: true, size: 10, color: { argb: C_BRANCO } };
        c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
        c.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center' };
        c.border = { top: { style: 'medium', color: { argb: 'FF000000' } } };
      });
      totR.height = 18;

      // Rodapé explicando a sobra e o remanejamento
      let pe = hdrNum + g.itens.length + 3;
      const nota = ws.getRow(pe);
      nota.getCell(1).value = 'As colunas de loja são o que entregar em cada uma, já em caixa fechada — elas somam exatamente o Total pç. "Sobra" é o quanto o pedido inteiro passa da necessidade do grupo por causa desse fechamento. Passe o mouse na célula da loja para ver a necessidade crua dela.';
      nota.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };
      ws.mergeCells(pe, 1, pe, nCols);
      pe++;

      if (g.transferencias.length) {
        pe++;
        const th = ws.getRow(pe);
        th.getCell(1).value = 'ANTES DE COMPRAR — dá para remanejar entre lojas:';
        th.getCell(1).font = { bold: true, size: 10, color: { argb: C_PEDIR } };
        ws.mergeCells(pe, 1, pe, nCols);
        pe++;
        for (const tr of g.transferencias) {
          const r = ws.getRow(pe);
          r.getCell(1).value = `${tr.qtd} pç`;
          r.getCell(2).value = `${tr.nome}:  ${BOARDS_LABEL[tr.de] || tr.de}  →  ${BOARDS_LABEL[tr.para] || tr.para}`;
          r.getCell(1).font = { bold: true, size: 9 };
          r.getCell(2).font = { size: 9 };
          r.getCell(1).alignment = { horizontal: 'center' };
          pe++;
        }
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pedido-embalagem-${hoje.replace(/\//g, '-')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[export/embalagens]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/embalagens/contagens ─────────────────────────────────────────
app.get('/api/embalagens/contagens', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';
    const items = (db.contagensEmbalagem || [])
      .filter(x => isAdminOrEscritorio || x.board === board)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 200);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/retiradas ────────────────────────────────────────────────────
app.get('/api/retiradas', requireAuth, async (req, res) => {
  try {
    const db  = await readDB();
    const { board } = req.session.user;
    const isAdm = !board || board === 'escritorio';
    const items = (db.retiradas || [])
      .filter(x => isAdm || x.board === board)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/retiradas ───────────────────────────────────────────────────
app.post('/api/retiradas', requireAuth, async (req, res) => {
  try {
    const board = req.session.user.board;
    if (!board) return res.status(400).json({ error: 'Apenas lojas podem criar solicitações' });
    const { colaborador, grupo, marca, referencia, cor, tamanho, quantidade, precoCheio, observacao } = req.body;
    if (!colaborador || !colaborador.trim()) return res.status(400).json({ error: 'Colaborador obrigatório' });
    const pc = parseFloat(precoCheio);
    if (!pc || pc <= 0) return res.status(400).json({ error: 'Preço cheio inválido' });
    const qt  = parseInt(quantidade, 10) || 1;
    const valorComDesconto = parseFloat((pc * 0.70 * qt).toFixed(2));
    const db = await readDB();
    if (!db.retiradas) db.retiradas = [];
    const item = {
      id:          nextId(db),
      board,
      colaborador: colaborador.trim(),
      grupo:       (grupo || '').trim(),
      marca:       (marca || '').trim(),
      referencia:  (referencia || '').trim(),
      cor:         (cor || '').trim(),
      tamanho:     (tamanho || '').trim(),
      quantidade:  qt,
      precoCheio:  pc,
      valor:       valorComDesconto,
      observacao:  (observacao || '').trim(),
      status:      'pendente',
      createdAt:   new Date().toISOString(),
      createdBy:   req.session.user.label || req.session.user.username,
      updatedAt:   null,
      updatedBy:   null,
    };
    db.retiradas.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/retiradas/:id/status ──────────────────────────────────────
app.patch('/api/retiradas/:id/status', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.retiradas || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Solicitação não encontrada' });
    const VALID = ['aprovada','recusada','retirada'];
    if (!VALID.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido' });
    item.status    = req.body.status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Adiantamentos × folha ─────────────────────────────────────────────────
// Solicitações antigas foram gravadas só com o nome do colaborador. Para não
// perder o vínculo, compara nome normalizado contra apelido e nome completo.
function _adiNorm(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function _adiNomeIgual(emp, nome) {
  const n = _adiNorm(nome);
  return !!n && (_adiNorm(emp.apelido) === n || _adiNorm(emp.name) === n);
}

// Adiantamentos de um mês agrupados por colaborador.
// Entram os aprovados e os já pagos, pela data da solicitação (mês cheio).
function adiantamentosDoMes(db, year, month) {
  const mk       = `${year}-${String(month).padStart(2, '0')}`;
  const CONTAM   = ['aprovado', 'pago'];
  const porEmp   = {};
  const semVinculo = [];
  for (const a of (db.adiantamentos || [])) {
    if (!CONTAM.includes(a.status)) continue;
    if (!String(a.createdAt || '').startsWith(mk)) continue;
    const emp = a.empId
      ? (db.employees || []).find(e => e.id === a.empId)
      : (db.employees || []).find(e => e.board === a.board && _adiNomeIgual(e, a.colaborador));
    if (!emp) { semVinculo.push({ id: a.id, board: a.board, colaborador: a.colaborador, valor: a.valor }); continue; }
    if (!porEmp[emp.id]) porEmp[emp.id] = { total: 0, itens: [] };
    porEmp[emp.id].total = Math.round((porEmp[emp.id].total + (a.valor || 0)) * 100) / 100;
    porEmp[emp.id].itens.push({
      id: a.id, valor: a.valor, status: a.status,
      data: String(a.createdAt).slice(0, 10), observacao: a.observacao || '',
    });
  }
  return { porEmp, semVinculo };
}

// Faltas que o gerente lançou em Loja em Ação → Dados p/ Folha, agrupadas por
// colaborador. O lançamento guarda só o nome, então o vínculo é pelo nome
// normalizado dentro da própria loja — mesma regra do adiantamento.
function faltasDoMes(db, year, month) {
  const mk         = `${year}-${String(month).padStart(2, '0')}`;
  const porEmp     = {};
  const semVinculo = [];
  for (const [key, dados] of Object.entries(db.dadosFolha || {})) {
    if (!key.startsWith(`${mk}-`)) continue;
    const board = key.slice(mk.length + 1);
    for (const f of (dados.faltas || [])) {
      if (!f.date || !f.colaborador) continue;
      const emp = (db.employees || []).find(e => e.board === board && _adiNomeIgual(e, f.colaborador));
      if (!emp) { semVinculo.push({ board, colaborador: f.colaborador, date: f.date }); continue; }
      if (!porEmp[emp.id]) porEmp[emp.id] = { dias: [] };
      if (!porEmp[emp.id].dias.includes(f.date)) porEmp[emp.id].dias.push(f.date);
    }
  }
  for (const v of Object.values(porEmp)) v.dias.sort();
  return { porEmp, semVinculo };
}

// ── GET /api/adiantamentos ────────────────────────────────────────────────
app.get('/api/adiantamentos', requireAuth, async (req, res) => {
  try {
    const db  = await readDB();
    const { board } = req.session.user;
    const isAdm = !board || board === 'escritorio';
    const items = (db.adiantamentos || [])
      .filter(x => isAdm || x.board === board)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/adiantamentos ───────────────────────────────────────────────
app.post('/api/adiantamentos', requireAuth, async (req, res) => {
  try {
    const sessionBoard = req.session.user.board;
    const isAdm = !sessionBoard || sessionBoard === 'escritorio';
    const board = isAdm ? (req.body.board || '') : sessionBoard;
    if (!board) return res.status(400).json({ error: 'Informe a loja' });
    const { colaborador, valor, observacao } = req.body;
    if (!colaborador || !colaborador.trim()) return res.status(400).json({ error: 'Colaborador obrigatório' });
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ error: 'Valor inválido' });
    const db = await readDB();
    if (!db.adiantamentos) db.adiantamentos = [];
    // Vínculo com o colaborador: a folha usa o empId; o nome fica só como rótulo
    const empId = parseInt(req.body.empId) ||
      (db.employees || []).find(e => e.board === board && !e.inativo &&
        _adiNomeIgual(e, colaborador))?.id || null;
    const item = {
      id:          nextId(db),
      board, empId,
      colaborador: colaborador.trim(),
      valor:       parseFloat(v.toFixed(2)),
      observacao:  (observacao || '').trim(),
      status:      'pendente',
      createdAt:   new Date().toISOString(),
      createdBy:   req.session.user.label || req.session.user.username,
      updatedAt:   null,
      updatedBy:   null,
    };
    db.adiantamentos.push(item);
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/adiantamentos/:id/status ──────────────────────────────────
app.patch('/api/adiantamentos/:id/status', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const db   = await readDB();
    const item = (db.adiantamentos || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Adiantamento não encontrado' });
    const VALID = ['aprovado', 'recusado', 'pago'];
    if (!VALID.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido' });
    item.status    = req.body.status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/caixa/:year/:month/:board ───────────────────────────────────
app.get('/api/caixa/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const user    = req.session.user;
    const isAdminOrEscritorio = !user.board || user.board === 'escritorio';
    if (!isAdminOrEscritorio && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    res.json((db.caixa || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/caixa-sangrias/:year/:month — todas as sangrias do mês (admin) ─
app.get('/api/caixa-sangrias/:year/:month', requireAdmin, async (req, res) => {
  try {
    const { year, month } = req.params;
    const y = parseInt(year), m = parseInt(month);
    const dtIni   = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const dtFin   = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const { fetchSangrias, parseBrNum } = require('./services/microvix');

    const BOARD_LABELS = { delrey:'Del Rey', minas:'Minas', contagem:'Contagem', estacao:'Estação', tommy:'Tommy', lez:'Lez' };

    function extractDay(s) {
      const str = String(s || '').trim();
      const m1 = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m1) return { day: parseInt(m1[1]), fmt: `${m1[1]}/${m1[2]}/${m1[3]}` };
      const m2 = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m2) return { day: parseInt(m2[3]), fmt: `${m2[3]}/${m2[2]}/${m2[1]}` };
      return { day: 0, fmt: s };
    }

    const all = [];
    for (const [board, cnpj] of Object.entries(lojas)) {
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      const cnpjClean = cnpj.replace(/\D/g, '');
      try {
        const rows = await fetchSangrias(cnpj, dtIni, dtFin, chave);
        for (const r of rows) {
          if (r.cancelado === 'S' || r.cancelado === '1') continue;
          const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
          if (rowCnpj && rowCnpj !== cnpjClean) continue;
          const { day, fmt } = extractDay(r.data || '');
          if (!day) continue;
          all.push({
            board,
            loja:  BOARD_LABELS[board] || board,
            data:  fmt,
            day,
            desc:  r.desc_historico || r.obs || '',
            valor: Math.abs(parseBrNum(r.valor || '0')),
          });
        }
      } catch (e) {
        console.warn(`[caixa-sangrias/${board}] ${e.message}`);
      }
    }

    all.sort((a, b) => a.day - b.day || a.loja.localeCompare(b.loja));
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/caixa/:year/:month/:board — zera todos os dados do mês ────
app.delete('/api/caixa/:year/:month/:board', requireAdmin, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (db.caixa) delete db.caixa[key];
    await writeDB(db);
    res.json({ ok: true, deleted: key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/caixa/:year/:month/:board/:day ───────────────────────────────
app.put('/api/caixa/:year/:month/:board/:day', requireAuth, async (req, res) => {
  try {
    const { year, month, board, day } = req.params;
    const user    = req.session.user;
    const isAdminOrEscritorio = !user.board || user.board === 'escritorio';
    if (!isAdminOrEscritorio && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const { caixa, sangria, deposito } = req.body;
    const db  = await readDB();
    if (!db.caixa) db.caixa = {};
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.caixa[key]) db.caixa[key] = {};
    const d = parseInt(day);
    db.caixa[key][d] = {
      caixa:    caixa    !== undefined ? Number(caixa)    : (db.caixa[key][d]?.caixa    ?? 0),
      sangria:  sangria  !== undefined ? Number(sangria)  : (db.caixa[key][d]?.sangria  ?? 0),
      deposito: deposito !== undefined ? Number(deposito) : (db.caixa[key][d]?.deposito ?? 0),
      updatedAt: new Date().toISOString(),
      updatedBy: user.label || user.username,
    };
    await writeDB(db);
    res.json(db.caixa[key][d]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── syncCaixaBoard — lógica compartilhada entre endpoint e cron ────────────
// Sincroniza dinheiro + sangria de um board para year/month.
// Nunca inclui o dia de hoje — cap em d-1.
// dayOnly: se fornecido, restringe busca e persistência a esse dia específico.
async function syncCaixaBoard(board, year, month, dayOnly = null) {
  const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const cnpj  = lojas[board];
  if (!cnpj) throw new Error(`Board "${board}" não mapeado em MICROVIX_LOJAS`);
  const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

  const y = parseInt(year), m = parseInt(month);
  const lastDay = new Date(y, m, 0).getDate();

  const today  = new Date();
  const todayY = today.getFullYear(), todayM = today.getMonth() + 1, todayD = today.getDate();
  if (y > todayY || (y === todayY && m > todayM)) return { skipped: 'mês futuro', caixaByDay: {}, sangriaByDay: {} };
  let capDay = lastDay;
  if (y === todayY && m === todayM) {
    capDay = Math.min(lastDay, todayD - 1);
    if (capDay < 1) return { skipped: 'sem dias anteriores', caixaByDay: {}, sangriaByDay: {} };
  }

  // dayOnly: sincroniza apenas esse dia; deve estar dentro do intervalo válido
  const startDay = dayOnly ?? 1;
  const endDay   = dayOnly ?? capDay;
  if (dayOnly && (dayOnly < 1 || dayOnly > capDay)) {
    return { skipped: `dia ${dayOnly} fora do intervalo válido (1–${capDay})`, caixaByDay: {}, sangriaByDay: {} };
  }

  const pad2 = n => String(n).padStart(2, '0');
  const dtIni = `${y}-${pad2(m)}-${pad2(startDay)}`;
  const dtFin = `${y}-${pad2(m)}-${pad2(endDay)}`;

  const { fetchMovimento, fetchSangrias, parseBrNum } = require('./services/microvix');

  function extractDay(s) {
    const str = String(s || '').trim();
    const m1 = str.match(/^(\d{2})\/\d{2}\/\d{4}/);
    if (m1) return parseInt(m1[1]);
    const m2 = str.match(/^\d{4}-\d{2}-(\d{2})/);
    if (m2) return parseInt(m2[1]);
    return null;
  }

  const caixaByDay   = {};
  const sangriaByDay = {};
  const errors       = {};
  const cnpjClean    = cnpj.replace(/\D/g, '');

  // Cash sales via LinxMovimento (deduplicado por documento)
  try {
    const movRows  = await fetchMovimento(cnpj, dtIni, dtFin, chave);
    const seenDocs = new Set();
    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      if (r.operacao !== 'S' && r.operacao !== 'DS') continue;
      if ((r.soma_relatorio || 'S').toUpperCase() === 'N') continue;
      const serie = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      if (serie === '999') continue;
      if (serie === '4' && r.operacao !== 'DS') continue;
      if (CFOP_SEM_RECEITA.has(String(r.id_cfop || '').trim())) continue;
      const doc = String(r.documento || '').trim();
      if (!doc || seenDocs.has(doc)) continue;
      seenDocs.add(doc);
      const day = extractDay(r.data_documento || r.data_emissao || '');
      if (!day) continue;
      const val = parseBrNum(r.total_dinheiro || '0');
      if (val === 0) continue;
      const sign = r.operacao === 'DS' ? -1 : 1;
      caixaByDay[day] = (caixaByDay[day] || 0) + sign * val;
    }
  } catch (e) {
    errors.movimento = e.message;
    console.warn(`[caixa-microvix/${board}] Movimento: ${e.message}`);
  }

  // Sangrias via LinxSangriaSuprimentos
  try {
    const sgRows = await fetchSangrias(cnpj, dtIni, dtFin, chave);
    for (const r of sgRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      const day = extractDay(r.data || '');
      if (!day) continue;
      const val = Math.abs(parseBrNum(r.valor || '0'));
      if (val <= 0) continue;
      sangriaByDay[day] = (sangriaByDay[day] || 0) + val;
    }
  } catch (e) {
    errors.sangrias = e.message;
    console.warn(`[caixa-microvix/${board}] Sangrias: ${e.message}`);
  }

  // Persist — preserva depósito existente; toca apenas dias no intervalo sincronizado
  const db = await readDB();
  if (!db.caixa) db.caixa = {};
  const key = `${year}-${pad2(m)}-${board}`;
  if (!db.caixa[key]) db.caixa[key] = {};
  for (let d = startDay; d <= endDay; d++) {
    const prev = db.caixa[key][d] || {};
    db.caixa[key][d] = {
      ...prev,
      caixa:    caixaByDay[d]   ?? 0,
      sangria:  sangriaByDay[d] ?? 0,
      syncedAt: new Date().toISOString(),
    };
  }
  await writeDB(db);

  return { synced: true, caixaByDay, sangriaByDay, errors: Object.keys(errors).length ? errors : undefined };
}

// ── POST /api/caixa-microvix/:board/:year/:month ──────────────────────────
// Admin: sincroniza o mês inteiro (útil para reprocessamento).
// Loja: sincroniza apenas d-1 — não toca em dados já persistidos.
app.post('/api/caixa-microvix/:board/:year/:month', requireAuth, async (req, res) => {
  try {
    const { board, year, month } = req.params;
    const userBoard   = req.session.user.board;
    const isAdminUser = !userBoard;
    if (!isAdminUser && userBoard !== board) {
      return res.status(403).json({ error: 'Acesso restrito ao seu próprio painel' });
    }
    // Lojas só sincronizam d-1 para não sobrescrever dados já corretos
    let dayOnly = null;
    if (!isAdminUser) {
      const todayD = new Date().getDate();
      if (todayD <= 1) return res.json({ skipped: 'primeiro dia do mês, sem d-1 disponível', caixaByDay: {}, sangriaByDay: {} });
      dayOnly = todayD - 1;
    }
    const result = await syncCaixaBoard(board, year, month, dayOnly);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/conferencia-caixa?board=delrey&date=2026-06-03 ──────────────
// Retorna formas de pagamento, total por vendedor e sangrias do dia
app.get('/api/conferencia-caixa', requireAuth, async (req, res) => {
  try {
    const user  = req.session.user;
    const board = req.query.board || user.board;
    if (!board) return res.status(400).json({ error: 'board obrigatório' });
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Loja "${board}" não configurada` });
    const chave    = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');

    const today = new Date().toISOString().slice(0, 10);
    const date  = req.query.date || today;

    const { fetchMovimento, fetchMovimentoPlanos, fetchMovimentoCartoes, fetchLinxPlanos, fetchLinxPlanosBandeiras, fetchSangrias, fetchVendedores, parseBrNum } = require('./services/microvix');

    const [movRows, sangriaRows, planosCatalog, bandeirasCatalog, cartoesRows, vendedoresRows] = await Promise.all([
      fetchMovimento(cnpj, date, date, chave),
      fetchSangrias(cnpj, date, date, chave),
      fetchLinxPlanos(cnpj, chave).catch(() => []),
      fetchLinxPlanosBandeiras(cnpj, chave).catch(() => []),
      fetchMovimentoCartoes(cnpj, date, date, chave).catch(() => []),
      fetchVendedores(cnpj, chave).catch(() => []),
    ]);

    // Catálogo cod_vendedor → nome
    const vendNomeCache = {};
    for (const v of vendedoresRows) {
      const cod  = String(v.cod_vendedor || v.codigo || '').trim();
      const nome = (v.nome_vendedor || v.nome || '').trim();
      if (cod && nome) vendNomeCache[cod] = nome;
    }

    // Catálogo cod_plano → nome
    const planoNomeMap = {};
    for (const p of planosCatalog) {
      const cod  = String(p.cod_plano || p.codigo || p.id || '').trim();
      const nome = (p.descricao || p.desc_plano || p.nome || '').trim();
      if (cod && nome) planoNomeMap[cod] = nome;
    }
    // Catálogo cod_bandeira → nome
    const bandeiraNomeMap = {};
    for (const b of bandeirasCatalog) {
      const codB  = String(b.cod_bandeira || b.id_bandeira || b.cod || b.codigo || '').trim();
      const nomeB = (b.desc_bandeira || b.nome_bandeira || b.bandeira || b.nome || b.descricao || '').trim();
      if (codB && nomeB) bandeiraNomeMap[codB] = nomeB;
    }

    // Helper: extrai bandeira do desc_plano (ex: "MASTER 2X" → "Mastercard")
    function extractBandeira(descPlano) {
      const d = (descPlano || '').toUpperCase();
      if (/MAESTRO/.test(d))             return 'Maestro';
      if (/MASTER/.test(d))              return 'Mastercard';
      if (/VISA/.test(d))                return 'Visa';
      if (/\bELO\b/.test(d))             return 'Elo';
      if (/AMEX|AMERICAN EXPRESS/.test(d)) return 'Amex';
      if (/HIPERCARD|HIPER/.test(d))     return 'Hipercard';
      if (/DINERS/.test(d))              return 'Diners';
      if (/SOROCRED/.test(d))            return 'Sorocred';
      if (/CABAL/.test(d))               return 'Cabal';
      if (/BANESCARD/.test(d))           return 'Banescard';
      if (/AURA/.test(d))                return 'Aura';
      if (/TICKET/.test(d))              return 'Ticket';
      if (/ALELO/.test(d))               return 'Alelo';
      if (/SODEXO/.test(d))              return 'Sodexo';
      if (/VR\b|VALE REFEIC/.test(d))    return 'VR';
      return '';
    }

    // Helper: forma de pagamento normalizada a partir de forma_pgto + tipo_transacao
    function buildForma(formaPgto, tipoTransacao, descPlano) {
      const f = (formaPgto || '').trim();
      const t = (tipoTransacao || '').trim().toUpperCase();
      const d = (descPlano  || '').toUpperCase();
      // PIX deve ser checado antes de tipo_transacao (Microvix marca PIX como tipo "D")
      if (/pix/i.test(f) || /\bpix\b/.test(d)) return 'PIX';
      if (t === 'C') return 'Cartão Crédito';
      if (t === 'D') return 'Cartão Débito';
      if (/cart[aã]o/i.test(f)) return 'Cartão Crédito';
      if (/d[eé]bito/i.test(f))  return 'Cartão Débito';
      if (/cr[eé]dito/i.test(f)) return 'Cartão Crédito';
      return f || 'Outros';
    }

    // -- Processar LinxMovimento: deduplicar por documento, acumular totais --
    const seenDocs = new Set();
    const docMap   = {};    // doc → { doc, valor, vendedorCod, vendedorNome, hora, codPlano }
    const identMap = {};    // identificador (UUID) → doc  (para linkar com LinxMovimentoPlanos)
    const vendMap  = {};    // cod → { cod, nome, total, qtd, vendas[] }
    let totalVendas = 0;

    const parseBrDate = s => {
      const str = String(s || '').trim();
      const m1  = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
      const m2  = str.match(/^(\d{4}-\d{2}-\d{2})/);
      return m2 ? m2[1] : null;
    };

    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      const operacao = (r.operacao || '').trim().toUpperCase();
      if (operacao !== 'S' && operacao !== 'DS') continue;
      if ((r.soma_relatorio || 'S').toUpperCase() === 'N') continue;
      // tipo_transacao 'J' sem documento = ajuste de balanço/estoque (Tommy: FALTA BALANÇO)
      if ((r.tipo_transacao || '').trim().toUpperCase() === 'J' && String(r.documento || '').trim() === '0') continue;
      const serie = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      if (serie === '999') continue;
      if (serie === '4' && operacao !== 'DS') continue;
      // CFOPs de saída sem venda real (bonificação/doação) — não conta como venda
      if (CFOP_SEM_RECEITA.has(String(r.id_cfop || '').trim())) continue;
      const doc = String(r.documento || '').trim();
      if (!doc || seenDocs.has(doc)) continue;
      seenDocs.add(doc);

      const sign  = operacao === 'DS' ? -1 : 1;
      // total_* campos repetem o valor TOTAL do documento em cada linha de item
      // valor_total é por-item e subestima documentos com múltiplos itens
      const valor = ['total_cartao','total_dinheiro','total_pix','total_cheque',
                     'total_crediario','total_convenio','total_cheque_prazo','total_deposito_bancario']
        .reduce((s, k) => s + parseBrNum(r[k] || '0'), 0)
        || parseBrNum(r.valor_total || r.total_liquido || '0');
      const hora  = String(r.hora || r.hora_documento || r.hora_emissao || '').trim().slice(0, 5) || '';
      const cod   = String(r.cod_vendedor || '').trim();
      const obsNome = (r.obs || '').match(/Nome do Vendedor:\s*(.+?)(?:\s*\|.*)?$/i);
      const nome  = (vendNomeCache[cod] || r.nome_vendedor || (obsNome && obsNome[1]) || '').trim();
      const codP  = String(r.cod_plano || r.plano || '').trim();
      const ident = String(r.identificador || '').trim();
      const desconto = parseBrNum(r.valor_desconto || r.desconto || r.vl_desconto || '0');

      totalVendas += sign * valor;
      docMap[doc] = { doc, valor: sign * valor, vendedorCod: cod, vendedorNome: nome, hora, codPlano: codP, desconto };
      if (ident) identMap[ident] = doc;

      if (cod) {
        if (!vendMap[cod]) vendMap[cod] = { cod, nome, total: 0, qtd: 0, vendas: [] };
        vendMap[cod].total += sign * valor;
        vendMap[cod].qtd   += sign > 0 ? 1 : -1;
        if (!vendMap[cod].nome && nome) vendMap[cod].nome = nome;
      }
    }

    // -- Formas de pagamento com drill-down --
    // docFormaMap[doc] = [{ forma, bandeira, valor }]
    const docFormaMap = {};

    // Estratégia 1: LinxMovimentoPlanos
    // Campos: identificador (UUID), plano (cod_plano), desc_plano, forma_pgto, tipo_transacao, total
    try {
      const planoRows = await fetchMovimentoPlanos(cnpj, date, date, chave);
      for (const r of planoRows) {
        const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
        if (rowCnpj && rowCnpj !== cnpjClean) continue;

        // Linkar via identificador (UUID) → doc, com fallback para documento numérico
        const ident = String(r.identificador || '').trim();
        const doc   = (ident && identMap[ident]) || String(r.documento || r.num_pedido || '').trim();
        if (!doc || !docMap[doc]) continue;

        const sign     = docMap[doc].valor < 0 ? -1 : 1;
        const descP    = (r.desc_plano || '').trim();
        const formaPgto = (r.forma_pgto || '').trim();
        const tipoTrans = (r.tipo_transacao || '').trim().toUpperCase();

        // Deriva forma normalizada (Cartão Crédito / Cartão Débito / Dinheiro / PIX...)
        const forma = buildForma(formaPgto, tipoTrans, descP) || descP || 'Outros';

        // Bandeira: extrai do desc_plano (ex: "MASTER 2X" → "Mastercard")
        const isPix  = forma === 'PIX';
        const isCard = !isPix && (tipoTrans === 'C' || tipoTrans === 'D'
          || /cart[aã]o|d[eé]bito|cr[eé]dito/i.test(formaPgto));
        const bandeira = isCard ? extractBandeira(descP) : '';

        const valor = parseBrNum(r.total || r.valor || r.valor_plano || '0');
        if (valor === 0) continue;

        if (!docFormaMap[doc]) docFormaMap[doc] = [];
        docFormaMap[doc].push({ forma, bandeira, valor: sign * valor });

        // Detecta parcelamento pelo desc_plano (ex: "MASTER 2X", "VISA 3X")
        const parcelaMatch = descP.match(/\b(\d+)\s*[Xx]\b/);
        if (parcelaMatch && parseInt(parcelaMatch[1]) > 1 && docMap[doc]) {
          docMap[doc].parcelado = true;
          docMap[doc].descParcela = descP;
          docMap[doc].numParcelas = parseInt(parcelaMatch[1]);
        }
      }
      const hasData = Object.keys(docFormaMap).length > 0;
      if (hasData) console.log(`[conferencia-caixa] docFormaMap via LinxMovimentoPlanos: ${Object.keys(docFormaMap).length} docs`);
    } catch (e) {
      console.warn('[conferencia-caixa] LinxMovimentoPlanos falhou:', e.message);
    }

    // Estratégia 2: cod_plano do LinxMovimento + LinxPlanos
    if (!Object.keys(docFormaMap).length && Object.keys(planoNomeMap).length) {
      for (const [doc, d] of Object.entries(docMap)) {
        if (!d.codPlano) continue;
        const forma = planoNomeMap[d.codPlano] || d.codPlano;
        docFormaMap[doc] = [{ forma, bandeira: '', valor: d.valor }];
      }
      if (Object.keys(docFormaMap).length) console.log(`[conferencia-caixa] docFormaMap via cod_plano+LinxPlanos`);
    }

    // Estratégia 3: campos total_* do LinxMovimento
    if (!Object.keys(docFormaMap).length) {
      const CAMPOS = [
        { field: 'total_dinheiro',  label: 'Dinheiro' },
        { field: 'total_cheque',    label: 'Cheque' },
        { field: 'total_cartao',    label: 'Cartão' },
        { field: 'total_credito',   label: 'Crédito' },
        { field: 'total_debito',    label: 'Débito' },
        { field: 'total_crediario', label: 'Crediário' },
        { field: 'total_pix',       label: 'PIX' },
        { field: 'total_vale',      label: 'Vale' },
        { field: 'total_boleto',    label: 'Boleto' },
        { field: 'total_outros',    label: 'Outros' },
      ];
      for (const r of movRows) {
        const doc = String(r.documento || '').trim();
        if (!doc || !docMap[doc]) continue;
        const sign = docMap[doc].valor < 0 ? -1 : 1;
        const formas = [];
        for (const { field, label } of CAMPOS) {
          const val = parseBrNum(r[field] || '0');
          if (val !== 0) formas.push({ forma: label, bandeira: '', valor: sign * val });
        }
        if (formas.length) docFormaMap[doc] = formas;
      }
      if (Object.keys(docFormaMap).length) console.log(`[conferencia-caixa] docFormaMap via campos total_*`);
    }

    // -- Estratégia 4: LinxMovimentoCartoes (fonte autoritativa de bandeiras de cartão) --
    // Sobrescreve entradas "Cartão" de estratégias anteriores com dados reais de bandeira
    if (cartoesRows.length) {
      // cartoesByDoc[doc] = [{ forma, bandeira, valor }]
      const cartoesByDoc = {};
      for (const r of cartoesRows) {
        const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
        if (rowCnpj && rowCnpj !== cnpjClean) continue;
        const doc = String(r.cupomfiscal || r.documento || '').trim();
        if (!doc || !docMap[doc]) continue;
        const cd       = String(r.credito_debito || '').trim().toUpperCase();
        const forma    = cd === 'D' ? 'Cartão Débito' : 'Cartão Crédito';
        // Normaliza a bandeira para o nome canônico (ex.: portal Tommy manda
        // "VISA ELECTRON"/"MAESTRO" → "Visa"/"Maestro") para casar com o extrato Rede.
        const bandeiraRaw = (r.descricao_bandeira || r.bandeira || '').trim();
        const bandeira    = extractBandeira(bandeiraRaw) || bandeiraRaw;
        const valor    = parseBrNum(r.valor || '0');
        if (valor === 0) continue;
        const sign     = docMap[doc].valor < 0 ? -1 : 1;
        if (!cartoesByDoc[doc]) cartoesByDoc[doc] = [];
        cartoesByDoc[doc].push({ forma, bandeira, valor: sign * valor });
      }
      if (Object.keys(cartoesByDoc).length) {
        console.log(`[conferencia-caixa] LinxMovimentoCartoes: ${Object.keys(cartoesByDoc).length} docs com cartão`);
        for (const [doc, cartoesEntries] of Object.entries(cartoesByDoc)) {
          const existing = docFormaMap[doc] || [];
          // Remove entradas "cartão" genéricas das estratégias anteriores; mantém não-cartão (Dinheiro, PIX etc.)
          const nonCard = existing.filter(f => !/cart[aã]o/i.test(f.forma));
          docFormaMap[doc] = [...nonCard, ...cartoesEntries];
        }
      }
    }

    // -- Estratégia 5: Fallback per-doc para docs sem forma após Estratégias 1-4 --
    // Garante que nenhum documento fique fora do formasPagamento (zerando a diferença "vs líquido")
    {
      let filled = 0;
      for (const r of movRows) {
        const doc = String(r.documento || '').trim();
        if (!doc || !docMap[doc] || docFormaMap[doc]) continue;
        const sign = docMap[doc].valor < 0 ? -1 : 1;
        const FAL = [
          { field: 'total_dinheiro',          label: 'Dinheiro' },
          { field: 'total_cartao',             label: 'Cartão' },
          { field: 'total_pix',                label: 'PIX' },
          { field: 'total_cheque',             label: 'Cheque' },
          { field: 'total_crediario',          label: 'Crediário' },
          { field: 'total_convenio',           label: 'Convênio' },
          { field: 'total_cheque_prazo',       label: 'Cheque Prazo' },
          { field: 'total_deposito_bancario',  label: 'Depósito Bancário' },
        ];
        const formas = [];
        for (const { field, label } of FAL) {
          const val = parseBrNum(r[field] || '0');
          if (val !== 0) formas.push({ forma: label, bandeira: '', valor: sign * val });
        }
        if (!formas.length) formas.push({ forma: 'Outros', bandeira: '', valor: docMap[doc].valor });
        docFormaMap[doc] = formas;
        filled++;
      }
      if (filled) console.log(`[conferencia-caixa] Estrategia5 fallback: ${filled} doc(s) sem forma preenchidos via total_*`);
    }

    // -- Agregar formasPagamento: forma → bandeiras → docs --
    const formasAgg = {}; // forma → { forma, total, bandeiras: { bKey → { bandeira, total, vendas[] } } }
    for (const [doc, formas] of Object.entries(docFormaMap)) {
      const d       = docMap[doc] || {};
      const vendNome = d.vendedorCod ? (vendNomeCache[d.vendedorCod] || vendMap[d.vendedorCod]?.nome || d.vendedorNome || d.vendedorCod) : '—';
      for (const { forma, bandeira, valor } of formas) {
        if (!formasAgg[forma]) formasAgg[forma] = { forma, total: 0, bandeiras: {} };
        formasAgg[forma].total += valor;
        const bKey = bandeira || '';
        if (!formasAgg[forma].bandeiras[bKey])
          formasAgg[forma].bandeiras[bKey] = { bandeira: bandeira || '', total: 0, vendas: [] };
        formasAgg[forma].bandeiras[bKey].total += valor;
        formasAgg[forma].bandeiras[bKey].vendas.push({ doc, valor, vendedor: vendNome, hora: d.hora || '' });
      }
    }
    const formasPagamento = Object.values(formasAgg)
      .filter(f => f.total > 0)
      .sort((a, b) => b.total - a.total)
      .map(f => ({
        forma: f.forma,
        total: f.total,
        bandeiras: Object.values(f.bandeiras)
          .filter(b => b.total > 0)
          .sort((a, b) => b.total - a.total)
          .map(b => ({ ...b, vendas: b.vendas.sort((x, y) => (x.hora || '').localeCompare(y.hora || '')) })),
      }));

    // -- Agregar vendedores com drill-down --
    for (const [doc, d] of Object.entries(docMap)) {
      const cod = d.vendedorCod;
      if (!cod || !vendMap[cod]) continue;
      const formasDoc = (docFormaMap[doc] || []).map(f => f.bandeira ? `${f.forma} / ${f.bandeira}` : f.forma).join(', ') || '—';
      vendMap[cod].vendas.push({ doc, valor: d.valor, forma: formasDoc, hora: d.hora || '' });
    }
    const vendedores = Object.values(vendMap)
      .filter(v => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .map(v => ({ ...v, vendas: v.vendas.sort((a, b) => (a.hora || '').localeCompare(b.hora || '')) }));

    // -- Sangrias --
    let totalSangria = 0;
    for (const r of sangriaRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      totalSangria += Math.abs(parseBrNum(r.valor || '0'));
    }

    // -- Vendas com alerta (desconto ou parcelamento) --
    const vendasAlerta = Object.values(docMap)
      .filter(d => d.valor > 0 && (d.desconto > 0 || d.parcelado))
      .map(d => ({
        doc: d.doc,
        hora: d.hora,
        valor: d.valor,
        desconto: d.desconto || 0,
        parcelado: d.parcelado || false,
        numParcelas: d.numParcelas || null,
        descParcela: d.descParcela || null,
        vendedorCod: d.vendedorCod,
        vendedorNome: d.vendedorNome,
      }))
      .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

    res.json({ board, date, totalVendas, vendedores, formasPagamento, totalSangria, vendasAlerta });
  } catch (e) {
    console.error('[conferencia-caixa]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/caixa-status?board=X&date=Y ─────────────────────────────────
app.get('/api/caixa-status', requireAuth, async (req, res) => {
  const { board, date } = req.query;
  if (!board || !date) return res.status(400).json({ error: 'board e date obrigatórios' });
  const db = await readDB();
  const key = `${board}:${date}`;
  res.json((db.caixaStatus || {})[key] || { alertasTicked: [], vendasOk: false, cartoesOk: false, vendedoresOk: false, fechado: false });
});

// ── POST /api/caixa-status ────────────────────────────────────────────────
// body: { board, date, action, doc?, ok? }
app.post('/api/caixa-status', requireAuth, async (req, res) => {
  const user = req.session.user;
  const isAdmin = !user.board || user.board === 'escritorio';
  if (!isAdmin) return res.status(403).json({ error: 'Sem permissão' });
  const { board, date, action, doc, ok } = req.body;
  if (!board || !date || !action) return res.status(400).json({ error: 'Parâmetros inválidos' });
  const db = await readDB();
  if (!db.caixaStatus) db.caixaStatus = {};
  const key = `${board}:${date}`;
  if (!db.caixaStatus[key]) db.caixaStatus[key] = { alertasTicked: [], vendasOk: false, cartoesOk: false, vendedoresOk: false, fechado: false };
  const entry = db.caixaStatus[key];
  if (!Array.isArray(entry.alertasTicked)) entry.alertasTicked = [];

  if (action === 'tickAlerta' && doc) {
    if (!entry.alertasTicked.includes(doc)) entry.alertasTicked.push(doc);
  } else if (action === 'untickAlerta' && doc) {
    entry.alertasTicked = entry.alertasTicked.filter(d => d !== doc);
  } else if (action === 'setVendasOk') {
    entry.vendasOk = !!ok;
    if (entry.vendasOk) { entry.vendasOkBy = user.name || user.login; entry.vendasOkTs = new Date().toISOString(); }
    else { delete entry.vendasOkBy; delete entry.vendasOkTs; if (entry.fechado) { entry.fechado = false; delete entry.fechadoBy; delete entry.fechadoTs; } }
  } else if (action === 'setCartoesOk') {
    entry.cartoesOk = !!ok;
    if (entry.cartoesOk) { entry.cartoesOkBy = user.name || user.login; entry.cartoesOkTs = new Date().toISOString(); }
    else { delete entry.cartoesOkBy; delete entry.cartoesOkTs; if (entry.fechado) { entry.fechado = false; delete entry.fechadoBy; delete entry.fechadoTs; } }
  } else if (action === 'setVendedoresOk') {
    entry.vendedoresOk = !!ok;
    if (entry.vendedoresOk) { entry.vendedoresOkBy = user.name || user.login; entry.vendedoresOkTs = new Date().toISOString(); }
    else { delete entry.vendedoresOkBy; delete entry.vendedoresOkTs; if (entry.fechado) { entry.fechado = false; delete entry.fechadoBy; delete entry.fechadoTs; } }
  } else if (action === 'setFormasOk') {
    // legado — mantém compatibilidade
    entry.formasOk = !!ok;
  }
  await writeDB(db);
  res.json({ ok: true, status: entry });
});

// ── POST /api/caixa-fechar ────────────────────────────────────────────────
app.post('/api/caixa-fechar', requireAuth, async (req, res) => {
  const user = req.session.user;
  const isAdmin = !user.board || user.board === 'escritorio';
  if (!isAdmin) return res.status(403).json({ error: 'Sem permissão' });
  const { board, date, totalAlertas } = req.body;
  if (!board || !date) return res.status(400).json({ error: 'Parâmetros inválidos' });
  const db = await readDB();
  if (!db.caixaStatus) db.caixaStatus = {};
  const key = `${board}:${date}`;
  if (!db.caixaStatus[key]) db.caixaStatus[key] = { alertasTicked: [], vendasOk: false, cartoesOk: false, vendedoresOk: false, fechado: false };
  const entry = db.caixaStatus[key];
  const semVendas = req.body.qtdVendas === 0;
  if (!entry.vendasOk || (!entry.cartoesOk && !semVendas))
    return res.status(400).json({ error: 'Conclua os passos da rotina (Vendas, Cartões) antes de fechar.' });
  entry.fechado = true;
  entry.fechadoBy = user.name || user.login;
  entry.fechadoTs = new Date().toISOString();
  await writeDB(db);
  res.json({ ok: true, status: entry });
});

// ── GET /api/caixa-mes?board=X&month=YYYY-MM ─────────────────────────────
// Retorna status de cada dia do mês para uma loja
app.get('/api/caixa-mes', requireAuth, async (req, res) => {
  const { board, month } = req.query;
  if (!board || !month) return res.status(400).json({ error: 'board e month obrigatórios' });
  const db = await readDB();
  const allStatus = db.caixaStatus || {};
  const days = {};
  for (const [key, entry] of Object.entries(allStatus)) {
    if (!key.startsWith(board + ':')) continue;
    const date = key.split(':')[1];
    if (!date || !date.startsWith(month)) continue;
    days[date] = {
      fechado:            entry.fechado       || false,
      vendasOk:           entry.vendasOk      || false,
      cartoesOk:          entry.cartoesOk     || false,
      vendedoresOk:       entry.vendedoresOk  || false,
      alertasTickedCount: (entry.alertasTicked || []).length,
    };
  }
  res.json({ board, month, days });
});

// ── GET /api/caixa-resumo?month=YYYY-MM ──────────────────────────────────
// Retorna por loja: quantos dias do mês têm caixa fechado vs abertos
app.get('/api/caixa-resumo', requireAuth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const db = await readDB();
  const allStatus = db.caixaStatus || {};
  const storeKeys = ['delrey','minas','contagem','estacao','tommy','lez'];

  // Calcula quantos dias já se passaram no mês (até hoje, horário BRT)
  const nowBRT = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const todayStr = nowBRT.toISOString().slice(0, 10); // YYYY-MM-DD
  const [yr, mo] = month.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const currentMonth = `${nowBRT.getUTCFullYear()}-${String(nowBRT.getUTCMonth()+1).padStart(2,'0')}`;
  // d-1: só conta até ontem — hoje ainda não pode ter caixa fechado
  const daysSoFar = month === currentMonth
    ? Math.max(0, Math.min(nowBRT.getUTCDate() - 1, daysInMonth))
    : (month < currentMonth ? daysInMonth : 0);

  const result = {};
  for (const board of storeKeys) {
    let fechados = 0;
    for (const [key, entry] of Object.entries(allStatus)) {
      if (!key.startsWith(board + ':')) continue;
      const date = key.split(':')[1];
      if (!date || !date.startsWith(month)) continue;
      if (entry.fechado) fechados++;
    }
    const abertos = Math.max(0, daysSoFar - fechados);
    result[board] = { fechados, abertos };
  }
  res.json({ month, stores: result });
});

// ── GET /api/microvix/cartoes-debug?board=delrey&date=2026-06-03 ──────────
// Retorna amostra bruta do LinxMovimentoCartoes para diagnóstico
app.get('/api/microvix/cartoes-debug', requireAdmin, async (req, res) => {
  try {
    const board = req.query.board || 'delrey';
    const date  = req.query.date || new Date().toISOString().slice(0, 10);
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

    const { fetchMovimento, fetchMovimentoPlanos, parseBrNum } = require('./services/microvix');

    const [movRows, planoRows] = await Promise.all([
      fetchMovimento(cnpj, date, date, chave).catch(() => []),
      fetchMovimentoPlanos(cnpj, date, date, chave).catch(() => []),
    ]);

    // Constrói identMap com MESMO filtro do endpoint principal
    const cnpjClean2 = cnpj.replace(/\D/g, '');
    const identMap2 = {};
    const docMap2 = {};
    const droppedDocs = [];
    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean2) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      const op = (r.operacao || '').trim().toUpperCase();
      if (op !== 'S' && op !== 'DS') continue;
      const serie = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      const doc   = String(r.documento || '').trim();
      const ident = String(r.identificador || '').trim();
      if (serie === '999' || (serie === '4' && op !== 'DS')) {
        droppedDocs.push({ doc, serie, op, ident: ident.slice(0, 8) + '...', razao: serie === '999' ? 'serie999' : 'serie4' });
        continue;
      }
      if (doc) {
        docMap2[doc] = { serie, op };
        if (ident) identMap2[ident] = doc;
      }
    }

    // Verifica cada linha de plano: linka ou não
    const linkReport = planoRows.map(r => {
      const ident  = String(r.identificador || '').trim();
      const doc    = (ident && identMap2[ident]) || '';
      const linked = !!(doc && docMap2[doc]);
      return {
        desc_plano: r.desc_plano,
        forma_pgto: r.forma_pgto,
        tipo_transacao: r.tipo_transacao,
        identificador: ident.slice(0, 8) + '...',
        doc_encontrado: doc || '—',
        linked,
      };
    });

    res.json({
      movRows: movRows.length,
      identMapSize: Object.keys(identMap2).length,
      planoRows: planoRows.length,
      droppedBySerie: droppedDocs,
      linkReport,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/microvix/caixa-debug?board=contagem&date=2026-05-02 ─────────
// Mostra exatamente o que seria somado para dinheiro e sangria em um dia específico
app.get('/api/microvix/caixa-debug', requireAdmin, async (req, res) => {
  try {
    const board = req.query.board || 'delrey';
    const date  = req.query.date || new Date().toISOString().slice(0, 10);
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave    = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');
    const { fetchMovimento, fetchSangrias, parseBrNum } = require('./services/microvix');

    function extractDay(s) {
      const str = String(s || '').trim();
      const m1 = str.match(/^(\d{2})\/\d{2}\/\d{4}/);
      if (m1) return parseInt(m1[1]);
      const m2 = str.match(/^\d{4}-\d{2}-(\d{2})/);
      if (m2) return parseInt(m2[1]);
      return null;
    }
    const targetDay = parseInt(date.slice(8, 10));
    const dtIni = date.slice(0, 8) + '01';
    const dtFin = date;

    // --- Dinheiro ---
    const movRows   = await fetchMovimento(cnpj, dtIni, dtFin, chave);
    const seenDocs  = new Set();
    const dinheiroRows = [];
    let totalDinheiro = 0;
    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      const day     = extractDay(r.data_documento || r.data_emissao || '');
      if (day !== targetDay) continue;
      const doc     = String(r.documento || '').trim();
      const serie   = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      const isCancelled = r.cancelado === 'S' || r.cancelado === '1';
      const isDev   = r.operacao === 'DS';
      const isWrongOp  = r.operacao !== 'S' && r.operacao !== 'DS';
      const isSerie999 = serie === '999';
      const isSerie4S  = serie === '4' && !isDev;
      const isNotSummed = (r.soma_relatorio || 'S').toUpperCase() === 'N';
      const isDup   = seenDocs.has(doc);
      const val     = parseBrNum(r.total_dinheiro || '0');
      const sign    = isDev ? -1 : 1;
      const cnpjMatch = !rowCnpj || rowCnpj === cnpjClean;
      const counted = cnpjMatch && !isCancelled && !isWrongOp && !isSerie999 && !isSerie4S && !isNotSummed && !isDup && val !== 0;
      dinheiroRows.push({ doc, serie, data_documento: r.data_documento, cnpj_emp: r.cnpj_emp, cancelado: r.cancelado, operacao: r.operacao, total_dinheiro: r.total_dinheiro, soma_relatorio: r.soma_relatorio, _cnpjMatch: cnpjMatch, _isDup: isDup, _isCancelled: isCancelled, _isDev: isDev, _isSerie999: isSerie999, _isSerie4S: isSerie4S, _isNotSummed: isNotSummed, _counted: counted });
      if (counted) { seenDocs.add(doc); totalDinheiro += sign * val; }
      else if (!isDup) seenDocs.add(doc);
    }

    // --- Sangrias ---
    const sgRows = await fetchSangrias(cnpj, dtIni, dtFin, chave);
    const sangriaRows = [];
    let totalSangria = 0;
    for (const r of sgRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      const day     = extractDay(r.data || '');
      if (day !== targetDay) continue;
      const isCancelled = r.cancelado === 'S' || r.cancelado === '1';
      const val     = parseBrNum(r.valor || '0');
      const cnpjMatch = !rowCnpj || rowCnpj === cnpjClean;
      sangriaRows.push({ data: r.data, cnpj_emp: r.cnpj_emp, valor: r.valor, cancelado: r.cancelado, desc_historico: r.desc_historico, _cnpjMatch: cnpjMatch, _isCancelled: isCancelled, _counted: cnpjMatch && !isCancelled && val > 0 });
      if (cnpjMatch && !isCancelled && val > 0) totalSangria += val;
    }

    res.json({ board, cnpjClean, date, targetDay, totalDinheiro, totalSangria, dinheiroRows: dinheiroRows.filter(r => r.data_documento), sangriaRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/microvix/caixa-probe?board=delrey&ini=YYYY-MM-DD&fin=YYYY-MM-DD ──
// Testa múltiplos nomes de comando para descobrir os corretos de pagamentos/sangrias
app.get('/api/microvix/caixa-probe', requireAdmin, async (req, res) => {
  try {
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const today = new Date().toISOString().slice(0, 10);
    const ini   = req.query.ini || new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
    const fin   = req.query.fin || today;

    const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
    const extraParams = [{ id: 'data_inicial', valor: ini }, { id: 'data_fim', valor: fin }];

    async function tryCmd(cmd) {
      const raw = await postRequest(buildRequest(cmd, cnpj, extraParams, chave), 15_000);
      if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
        const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'erro';
        return { ok: false, msg };
      }
      const rows = parseCsv(raw);
      return { ok: true, rows: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 3) };
    }

    const pagCandidates = [
      'LinxMovimentoPlanos', 'LinxFormasPagamentos', 'LinxFormaPagamento',
      'LinxMovimentoFormasPagamentos', 'LinxPagamentos', 'LinxMovimentoPagto',
    ];
    const sangriaCandidates = [
      'LinxSangriaSuprimentos', 'LinxSangrias', 'LinxSangria',
      'LinxMovimentoSangria', 'LinxSangriasCaixa',
    ];
    const cartoesCandidates = [
      'LinxMovimentoCartoes', 'LinxMovimentoCartao', 'LinxCartoes', 'LinxCartao',
      'LinxMovimentoBandeiras', 'LinxBandeiras', 'LinxMovimentoCartoesBandeiras',
      'LinxPagamentosCartoes', 'LinxNFCartoes',
    ];

    const result = { pagamentos: {}, sangrias: {}, cartoes: {} };
    for (const cmd of pagCandidates) {
      result.pagamentos[cmd] = await tryCmd(cmd).catch(e => ({ ok: false, msg: e.message }));
    }
    for (const cmd of sangriaCandidates) {
      result.sangrias[cmd] = await tryCmd(cmd).catch(e => ({ ok: false, msg: e.message }));
    }
    for (const cmd of cartoesCandidates) {
      result.cartoes[cmd] = await tryCmd(cmd).catch(e => ({ ok: false, msg: e.message }));
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/boletas ─────────────────────────────────────────────────────
app.get('/api/boletas', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.boletas || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/boletas ─────────────────────────────────────────────────────
app.post('/api/boletas', requireAuth, async (req, res) => {
  try {
    const { board } = req.body;
    if (!board || !BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const origemVal = req.body.origem === 'loja' ? 'loja' : 'cliente';
    if (origemVal === 'cliente' && !req.body.nome?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    const db = await readDB();
    if (!db.boletas)   db.boletas   = [];
    if (!db.boletaSeq) db.boletaSeq = {};
    if (!db.boletaSeq[board]) db.boletaSeq[board] = 0;
    db.boletaSeq[board]++;
    const fields = ['origem','nome','cpf','endereco','numeroEnd','compl','bairro','cep','cidade','tel','email',
                    'produto','tamanho','ref','codigo','cor','fabricante','doc','dataCompra','defeito','dataEntregue'];
    const boleta = { id: nextId(db), numero: db.boletaSeq[board], board, status: 'pendente',
                     createdAt: new Date().toISOString(),
                     createdBy: req.session.user.label || req.session.user.username };
    fields.forEach(f => { boleta[f] = (req.body[f] || '').toString().trim() || null; });
    db.boletas.push(boleta);
    await writeDB(db);
    res.json(boleta);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/boletas/:id ────────────────────────────────────────────────
app.patch('/api/boletas/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    const b  = (db.boletas || []).find(x => x.id === id);
    if (!b) return res.status(404).json({ error: 'Boleta não encontrada' });
    const fields = ['origem','nome','cpf','endereco','numeroEnd','compl','bairro','cep','cidade','tel','email',
                    'produto','tamanho','ref','codigo','cor','fabricante','doc','dataCompra','defeito','dataEntregue'];
    fields.forEach(f => { if (f in req.body) b[f] = req.body[f] || null; });
    if (req.body.status) {
      b.status = req.body.status;
      if (req.body.status === 'resolvido' && !b.resolvedAt) {
        b.resolvedAt = new Date().toISOString();
        b.resolvedBy = req.session.user.label || req.session.user.username;
      } else if (req.body.status === 'pendente') {
        b.resolvedAt = null;
        b.resolvedBy = null;
      }
    }
    // Pipeline de devolução
    const by = req.session.user.label || req.session.user.username;
    if (req.body.etapa === 'ressarcimento') {
      if (!req.body.data) return res.status(400).json({ error: 'Data obrigatória' });
      b.ressarcimento = { data: req.body.data, tipo: req.body.tipo || '', obs: req.body.obs || '', by, at: new Date().toISOString() };
    } else if (req.body.etapa === 'envioFabrica') {
      if (!req.body.data) return res.status(400).json({ error: 'Data obrigatória' });
      b.envioFabrica = { data: req.body.data, obs: req.body.obs || '', by, at: new Date().toISOString() };
    } else if (req.body.etapa === 'creditoFornecedor') {
      if (!req.body.data) return res.status(400).json({ error: 'Data obrigatória' });
      b.creditoFornecedor = { data: req.body.data, valor: parseFloat(req.body.valor) || 0, obs: req.body.obs || '', by, at: new Date().toISOString() };
    }
    await writeDB(db);
    res.json(b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/boletas/:id ───────────────────────────────────────────────
app.delete('/api/boletas/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = await readDB();
    db.boletas = (db.boletas || []).filter(x => x.id !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/layout ───────────────────────────────────────────────────────
app.get('/api/layout', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { username } = req.session.user;
    res.json((db.layouts || {})[username] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/layout ────────────────────────────────────────────────────────
app.put('/api/layout', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { username } = req.session.user;
    if (!db.layouts) db.layouts = {};
    db.layouts[username] = req.body.layout;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/historico ─────────────────────────────────────────────────────
app.get('/api/historico', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.historico || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Microvix sync routes ───────────────────────────────────────────────────
const MX_INTERVAL_MS    = parseInt(process.env.MICROVIX_INTERVAL_MIN    || '5')  * 60 * 1000;
// O sync de d-1 não precisa da mesma cadência do dia corrente: o dia anterior
// já fechou e a conferência de 30 dias roda 1× por dia por cima dele.
const MX_INTERVAL_D1_MS = parseInt(process.env.MICROVIX_INTERVAL_D1_MIN || '60') * 60 * 1000;
const MX_INTERVAL_30D_MS = 24 * 60 * 60 * 1000; // conferência 30d: 1× por dia

// GET  /api/microvix/status  → last sync info
app.get('/api/microvix/status', requireAuth, async (req, res) => {
  const db = await readDB();
  res.json(getStatus(db));
});

// ── Consumo da WebAPI: contador que sobrevive a restart ────────────────────
// A instância reinicia várias vezes ao dia, então o contador em memória sozinho
// nunca fecharia o total do dia. O serviço acumula deltas; aqui eles viram $inc
// numa doc por dia — vários restarts somam em vez de sobrescrever.
const MX_USO_COL = 'microvixUso';
const _mxCampoOk = s => String(s).replace(/[^A-Za-z0-9_]/g, '_');

async function _flushUsoMicrovix() {
  if (!mongoDb) return;
  const deltas = require('./services/microvix').coletarDeltas();
  for (const d of deltas) {
    const inc = {
      requisicoes: d.requisicoes, cacheHits: d.cacheHits,
      dedupe: d.dedupe, erros: d.erros,
    };
    for (const [cmd, v] of Object.entries(d.porComando)) {
      const c = _mxCampoOk(cmd);
      inc[`porComando.${c}.req`]    = v.req;
      inc[`porComando.${c}.cache`]  = v.cache;
      inc[`porComando.${c}.dedupe`] = v.dedupe;
    }
    for (const [h, n] of Object.entries(d.porHora)) inc[`porHora.${h}`] = n;
    await mongoDb.collection(MX_USO_COL).updateOne(
      { _id: d.dia },
      { $inc: inc, $set: { at: new Date() } },
      { upsert: true },
    );
  }
}

// GET /api/microvix/uso → consumo do dia na WebAPI (plano tem limite diário)
app.get('/api/microvix/uso', requireAdmin, async (req, res) => {
  const { getUso } = require('./services/microvix');
  const memoria = getUso();
  const limite  = parseInt(process.env.MICROVIX_LIMITE_DIA || '15000');
  const intervalos = { hojeMin: MX_INTERVAL_MS / 60000, d1Min: MX_INTERVAL_D1_MS / 60000 };

  // Sem MongoDB não há como somar os restarts — devolve só o processo atual
  if (!mongoDb) {
    return res.json({ ...memoria, persistido: false, limite,
      usoPct: limite ? Math.round(memoria.requisicoes / limite * 100) : null, intervalos });
  }

  try {
    await _flushUsoMicrovix();   // grava o que ainda está em memória antes de ler
    const dia  = memoria.dia;
    const col  = mongoDb.collection(MX_USO_COL);
    const doc  = await col.findOne({ _id: dia }) || {};
    const hist = await col.find({}, { projection: { requisicoes: 1, cacheHits: 1, dedupe: 1 } })
      .sort({ _id: -1 }).limit(8).toArray();

    const req_ = doc.requisicoes || 0, ch = doc.cacheHits || 0, dd = doc.dedupe || 0;
    const economizadas = ch + dd;
    const brutas       = req_ + economizadas;
    const porComando = Object.entries(doc.porComando || {})
      .map(([comando, v]) => ({ comando, req: v.req || 0, cache: v.cache || 0, dedupe: v.dedupe || 0 }))
      .sort((a, b) => b.req - a.req);

    res.json({
      dia, persistido: true,
      requisicoes: req_,               // total do dia, somando todos os restarts
      cacheHits: ch, dedupe: dd, erros: doc.erros || 0,
      economizadas, semOtimizacao: brutas,
      reducaoPct: brutas ? Math.round(economizadas / brutas * 100) : 0,
      limite, usoPct: limite ? Math.round(req_ / limite * 100) : null,
      porComando, porHora: doc.porHora || {},
      cacheEntradas: memoria.cacheEntradas, cacheMB: memoria.cacheMB,
      desdeUltimoRestart: memoria.requisicoes,
      historico: hist.map(h => ({ dia: h._id, requisicoes: h.requisicoes || 0,
                                  economizadas: (h.cacheHits || 0) + (h.dedupe || 0) })),
      intervalos,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/microvix/cache/limpar → descarta o cache de respostas
app.post('/api/microvix/cache/limpar', requireAdmin, (req, res) => {
  const { limparCache } = require('./services/microvix');
  res.json(limparCache());
});

// POST /api/microvix/sync    → manual trigger
app.post('/api/microvix/sync', requireAuth, async (req, res) => {
  try {
    // Sync manual é "quero ver agora": descarta o cache de respostas antes
    require('./services/microvix').limparCache();
    const result = await runSync(readDB, writeDB);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/microvix/sync-retroativo  { de, ate, boards? }
app.post('/api/microvix/sync-retroativo', requireAuth, async (req, res) => {
  try {
    const { de, ate, boards } = req.body || {};
    if (!de || !ate) return res.status(400).json({ error: 'Informe de e ate (YYYY-MM-DD)' });
    // Retroativo costuma ser "corrigi algo no Microvix, roda de novo" — sem
    // limpar o cache o período fechado voltaria da resposta guardada
    require('./services/microvix').limparCache();
    const result = await runSyncRetroativo(readDB, writeDB, de, ate, boards);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/microvix/wsdl     → fetch raw WSDL from Microvix (debug)
app.get('/api/microvix/wsdl', requireAuth, async (req, res) => {
  const https = require('https');
  https.get('https://webapi.microvix.com.br/1.0/api/integracao?wsdl', r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => res.type('text/plain').send(data.slice(0, 5000)));
  }).on('error', e => res.status(500).send(e.message));
});

// helper: first CNPJ from MICROVIX_LOJAS
function firstCnpj() {
  try { return Object.values(JSON.parse(process.env.MICROVIX_LOJAS || '{}'))[0] || ''; }
  catch { return ''; }
}

// GET /api/microvix/funcionarios-raw → diagnóstico: campos e primeiras linhas do LinxFuncionarios
app.get('/api/microvix/funcionarios-raw', requireAdmin, async (req, res) => {
  try {
    const { fetchFuncionarios } = require('./services/microvix');
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const result = {};
    for (const [board, cnpj] of Object.entries(lojas)) {
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      try {
        const rows = await fetchFuncionarios(cnpj.replace(/\D/g, ''), chave);
        result[board] = { count: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 3) };
      } catch (e) {
        result[board] = { error: e.message };
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/microvix/raw     → returns raw rows for debugging field names
app.post('/api/microvix/raw', requireAuth, async (req, res) => {
  try {
    const { fetchMovimento } = require('./services/microvix');
    const cnpj = req.body?.cnpj || firstCnpj();
    if (!cnpj) return res.status(400).json({ error: 'MICROVIX_LOJAS não configurado' });
    const today = new Date().toISOString().slice(0, 10);
    const rows  = await fetchMovimento(cnpj, today, today);
    res.json({ date: today, count: rows.length, sample: rows.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/microvix/raw      → TEMP debug (sem auth, remove depois)
app.get('/api/microvix/raw', requireAdmin, async (req, res) => {
  try {
    const { fetchMovimento } = require('./services/microvix');
    const cnpj = req.query.cnpj || firstCnpj();
    if (!cnpj) return res.status(400).json({ error: 'MICROVIX_LOJAS não configurado' });
    const today = new Date().toISOString().slice(0, 10);
    const ini = req.query.ini || today;
    const fin = req.query.fin || today;
    const vend = req.query.vend || null;
    let rows = await fetchMovimento(cnpj, ini, fin);
    if (vend) rows = rows.filter(r => String(r.cod_vendedor || '').trim() === vend);
    res.json({ ini, fin, count: rows.length, sample: rows.slice(0, 10), fields: rows[0] ? Object.keys(rows[0]) : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/microvix/lojas    → TEMP: testa LinxLojas (só chave, sem CNPJ)
app.get('/api/microvix/lojas', requireAdmin, async (req, res) => {
  const https = require('https');
  const chave = process.env.MICROVIX_CHAVE;
  const cnpj  = (process.env.MICROVIX_CNPJ || '').replace(/\D/g, '');
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<LinxMicrovix>
  <Authentication user="linx_export" password="linx_export" />
  <ResponseFormat>csv</ResponseFormat>
  <Command>
    <Name>LinxLojas</Name>
    <Parameters>
      <Parameter id="chave">${chave}</Parameter>
      <Parameter id="cnpjEmp">${cnpj}</Parameter>
    </Parameters>
  </Command>
</LinxMicrovix>`;
  console.log('[Microvix/lojas] XML:\n', xml);
  const buf = Buffer.from(xml, 'utf-8');
  const req2 = https.request({ hostname: 'webapi.microvix.com.br', path: '/1.0/api/integracao', method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': buf.length } }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      console.log('[Microvix/lojas] Resposta:\n', body.slice(0, 2000));
      res.type('text/plain').send(body);
    });
  });
  req2.on('error', e => res.status(500).send(e.message));
  req2.write(buf);
  req2.end();
});

// GET /api/microvix/teste → TEMP: envia XML customizável via query string
// ?cmd=LinxMovimento&params=chave,cnpjEmp,dt_ini,dt_fin&ini=01/05/2026&fin=20/05/2026
app.get('/api/microvix/teste', requireAdmin, async (req, res) => {
  const https = require('https');
  const chave  = process.env.MICROVIX_CHAVE;
  const cnpj   = (req.query.cnpj || firstCnpj() || '').replace(/\D/g, '');
  const cmd    = req.query.cmd  || 'LinxMovimento';
  const ini    = req.query.ini  || '01/05/2026';
  const fin    = req.query.fin  || '20/05/2026';
  const portal = req.query.portal || '9425';

  // Build params based on ?p= list e.g. ?p=chave,cnpjEmp,dt_ini,dt_fin
  const pList  = (req.query.p || 'chave,cnpjEmp,dt_ini,dt_fin').split(',');
  const pMap   = { chave, cnpjEmp: cnpj, portal, dt_ini: ini, dt_fin: fin, data_inicial: ini, data_fim: fin, empresa: '1' };
  const pXml   = pList.map(k => `      <Parameter id="${k}">${pMap[k] ?? ''}</Parameter>`).join('\n');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<LinxMicrovix>
  <Authentication user="linx_export" password="linx_export" />
  <ResponseFormat>csv</ResponseFormat>
  <Command>
    <Name>${cmd}</Name>
    <Parameters>
${pXml}
    </Parameters>
  </Command>
</LinxMicrovix>`;
  console.log('[Microvix/teste] XML:\n', xml);
  const buf = Buffer.from(xml, 'utf-8');
  const req2 = https.request({ hostname: 'webapi.microvix.com.br', path: '/1.0/api/integracao', method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': buf.length } }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      console.log('[Microvix/teste] Resposta:\n', body.slice(0, 3000));
      res.type('text/plain').send(body);
    });
  });
  req2.on('error', e => res.status(500).send(e.message));
  req2.write(buf);
  req2.end();
});

// GET /api/microvix/lojas-emp → TEMP: analisa empresa/deposito nos movimentos
app.get('/api/microvix/lojas-emp', requireAdmin, async (req, res) => {
  try {
    const { fetchMovimento } = require('./services/microvix');
    const cnpj = process.env.MICROVIX_CNPJ;
    const rows = await fetchMovimento(cnpj, '2026-05-01', '2026-05-19');
    const combos = {};
    for (const r of rows) {
      const k = `empresa=${r.empresa} deposito=${r.deposito}`;
      if (!combos[k]) combos[k] = { empresa: r.empresa, deposito: r.deposito, count: 0 };
      combos[k].count++;
    }
    res.json({ total: rows.length, groups: Object.values(combos).sort((a,b) => b.count - a.count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/microvix/conferencia?de=2026-05-01&ate=2026-05-20&board=delrey
app.get('/api/microvix/conferencia', requireAdmin, async (req, res) => {
  try {
    const { fetchMovimento, fetchVendedores, parseBrNum } = require('./services/microvix');
    const board  = req.query.board || 'delrey';
    const dtIni  = req.query.de    || '2026-05-01';
    const dtFin  = req.query.ate   || new Date().toISOString().slice(0, 10);

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado em MICROVIX_LOJAS` });

    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

    // 1. Vendor map from Microvix
    const vendRows = await fetchVendedores(cnpj, chave);
    const vendMap  = {}; // cod → nome
    for (const v of vendRows) vendMap[String(v.cod_vendedor).trim()] = v.nome_vendedor;

    // 2. Movements from Microvix
    const rows = await fetchMovimento(cnpj, dtIni, dtFin, chave);
    const mxAgg = {}; // "date|cod" → { date, cod, nome, value, pecas, docs }
    for (const row of rows) {
      if (row.cancelado === 'S' || row.cancelado === '1') continue;
      const cod  = String(row.cod_vendedor || '').trim();
      const date = (() => { const p=(row.data_documento||'').slice(0,10); const [d,m,y]=p.split('/'); return y?`${y}-${m}-${d}`:null; })();
      if (!date || !cod) continue;
      const key = `${date}|${cod}`;
      if (!mxAgg[key]) mxAgg[key] = { date, cod, nome: vendMap[cod]||cod, value: 0, pecas: 0, docs: new Set() };
      mxAgg[key].value += parseBrNum(row.valor_total);
      mxAgg[key].pecas += parseInt(row.quantidade||0)||0;
      mxAgg[key].docs.add(row.documento);
    }

    // 3. System data (vsales)
    const db = await readDB();
    const employees = (db.employees||[]).filter(e => e.board === board && !e.inativo);
    const vsales = db.vsales || {};
    // Build sys map: "date|microvixCod" → { value, pecas }
    const sysAgg = {};
    for (const emp of employees) {
      if (!emp.microvixCod) continue;
      // find all vsales keys for this employee in the date range
      const prefix = `2026-05-${board}-${emp.id}`;
      for (const [vsKey, vsd] of Object.entries(vsales)) {
        if (!vsKey.includes(`-${board}-${emp.id}`)) continue;
        for (const [date, entry] of Object.entries(vsd.entries || {})) {
          if (date < dtIni || date > dtFin) continue;
          const key = `${date}|${emp.microvixCod}`;
          sysAgg[key] = { date, cod: emp.microvixCod, nome: emp.name, value: entry.value||0, pecas: entry.pecas||0 };
        }
      }
    }

    // 4. Build comparison
    const allKeys = new Set([...Object.keys(mxAgg), ...Object.keys(sysAgg)]);
    const rows2 = [];
    for (const key of [...allKeys].sort()) {
      const mx  = mxAgg[key];
      const sys = sysAgg[key];
      const mxVal  = mx  ? parseFloat(mx.value.toFixed(2))  : 0;
      const sysVal = sys ? parseFloat(sys.value||0)          : 0;
      const diff   = parseFloat((sysVal - mxVal).toFixed(2));
      rows2.push({
        date:    mx?.date || sys?.date,
        cod:     mx?.cod  || sys?.cod,
        nome:    mx?.nome || sys?.nome,
        mx_valor:  mxVal,
        mx_pecas:  mx?.pecas || 0,
        sys_valor: sysVal,
        sys_pecas: sys?.pecas || 0,
        diff,
        ok: Math.abs(diff) < 0.1,
      });
    }

    res.json({ de: dtIni, ate: dtFin, board, total: rows2.length, rows: rows2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/microvix/import-vendedores ──────────────────────────────────
// Cria funcionários no sistema para vendedores ativos do Microvix que ainda não existem.
app.post('/api/microvix/import-vendedores', requireAdmin, async (req, res) => {
  const { fetchVendedores } = require('./services/microvix');

  function toTitleCase(str) {
    const preps = new Set(['de','da','do','dos','das','e','a','o','os','as','em','no','na','nos','nas','por','para','com','sem']);
    return str.toLowerCase().split(' ').map((w, i) =>
      (i > 0 && preps.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }
  function normName(s) {
    return (s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const { board: boardFilter } = req.body || {};
    const targets = boardFilter
      ? (lojas[boardFilter] ? { [boardFilter]: lojas[boardFilter] } : {})
      : lojas;
    if (!Object.keys(targets).length)
      return res.status(400).json({ error: 'Board não encontrado em MICROVIX_LOJAS' });

    const db = await readDB();
    if (!db.employees) db.employees = [];
    const result = { created: [], updated: [], skipped: [], errors: [] };

    for (const [board, cnpj] of Object.entries(targets)) {
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      let rows;
      try { rows = await fetchVendedores(cnpj.replace(/\D/g, ''), chave); }
      catch (e) { result.errors.push(`[${board}] ${e.message}`); continue; }

      for (const v of rows) {
        const ativoRaw = String(v.ativo ?? '1').trim().toLowerCase();
        if (['0','n','false','inativo'].includes(ativoRaw)) continue;

        const cod  = String(v.cod_vendedor || '').trim();
        const nome = (v.nome_vendedor || '').trim();
        if (!cod || !nome) continue;

        const byCod  = db.employees.find(e => e.board === board && e.microvixCod && String(e.microvixCod) === cod);
        const byName = db.employees.find(e => e.board === board && normName(e.name) === normName(nome));
        const existing = byCod || byName;

        if (existing) {
          if (!existing.microvixCod) {
            existing.microvixCod = cod;
            result.updated.push({ board, cod, nome: existing.name });
          } else {
            result.skipped.push({ board, cod, nome: existing.name });
          }
          continue;
        }

        const emp = {
          id: nextId(db),
          name: nome.toUpperCase(),
          apelido: '',
          board,
          microvixCod: cod,
          cpf: '', admissao: '', cargo: 'Vendedor',
          salario: 0, comissaoSemMeta: 0, comissao: 0, comissaoMeta2: 0, comissaoSuper: 0,
          isVendedor: true, inativo: false, desligamento: '',
        };
        db.employees.push(emp);
        result.created.push({ board, cod, nome: emp.name, id: emp.id });
      }
    }

    await writeDB(db);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/microvix/sync-photos ────────────────────────────────────────
// Downloads vendor photos from Microvix (LinxFuncionarios) and saves them locally.
app.post('/api/microvix/sync-photos', requireAdmin, async (req, res) => {
  const { fetchFuncionarios } = require('./services/microvix');
  const https2 = require('https');
  const http2  = require('http');

  function normName(s) {
    return (s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Download a URL to a local file path, following up to 5 redirects
  function downloadUrl(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const getter = url.startsWith('https') ? https2 : http2;
      getter.get(url, { timeout: 20000 }, res2 => {
        if (res2.statusCode === 301 || res2.statusCode === 302 || res2.statusCode === 307) {
          res2.resume();
          const loc = res2.headers.location;
          if (!loc) return reject(new Error('Redirect sem Location'));
          const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
          return downloadUrl(next, dest, redirects + 1).then(resolve).catch(reject);
        }
        if (res2.statusCode !== 200) {
          res2.resume();
          return reject(new Error(`HTTP ${res2.statusCode} ao baixar foto`));
        }
        const file = fs.createWriteStream(dest);
        res2.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { try { fs.unlinkSync(dest); } catch {} reject(err); });
      }).on('error', err => { try { fs.unlinkSync(dest); } catch {} reject(err); });
    });
  }

  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    if (!Object.keys(lojas).length) return res.status(400).json({ error: 'MICROVIX_LOJAS não configurado' });

    const { boards: boardFilter } = req.body || {};
    const db        = await readDB();
    const employees = db.employees || [];
    const result    = { updated: 0, skipped: 0, errors: [], fields: null };

    for (const [board, cnpj] of Object.entries(lojas)) {
      if (boardFilter?.length && !boardFilter.includes(board)) continue;
      const cnpjClean = cnpj.replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

      let rows;
      try {
        rows = await fetchFuncionarios(cnpjClean, chave);
      } catch (e) {
        result.errors.push(`[${board}] ${e.message}`);
        continue;
      }

      if (!rows.length) continue;
      if (!result.fields) result.fields = Object.keys(rows[0]);
      console.log(`[Microvix/${board}] LinxFuncionarios: ${rows.length} linhas, campos:`, Object.keys(rows[0]).join(', '));

      for (const row of rows) {
        // Detect field names dynamically — Microvix uses different names per version
        const cod      = String(row.cod_vendedor || row.cod_funcionario || row.CodVendedor || row.CodFuncionario || '').trim();
        const nomeRaw  = row.nome_vendedor || row.nome_funcionario || row.NomeVendedor || row.NomeFuncionario || '';
        const fotoUrl  = (row.foto || row.url_foto || row.foto_url || row.FotoUrl || row.Foto || '').trim();

        if (!fotoUrl) { result.skipped++; continue; }
        // Only handle HTTP(S) URLs — skip empty paths or file system paths
        if (!fotoUrl.startsWith('http')) { result.skipped++; continue; }

        // Match employee: prefer microvixCod, fall back to normalized name
        const emp = employees.find(e => e.board === board && !e.inativo && e.microvixCod && String(e.microvixCod) === cod)
          || employees.find(e => e.board === board && !e.inativo && normName(e.name) === normName(nomeRaw));

        if (!emp) {
          console.log(`[Microvix/${board}] Funcionário sem match: cod=${cod} nome="${nomeRaw}"`);
          result.skipped++;
          continue;
        }

        const tmpFile  = path.join(UPLOADS_DIR, `emp-mx-${emp.id}-tmp.jpg`);

        try {
          await downloadUrl(fotoUrl, tmpFile);
          const fileData = fs.readFileSync(tmpFile);
          try { fs.unlinkSync(tmpFile); } catch {}
          const dataUrl = `data:image/jpeg;base64,${fileData.toString('base64')}`;
          await writePhoto(emp.id, dataUrl);
          result.updated++;
          console.log(`[Microvix/${board}] Foto salva: ${emp.name}`);
        } catch (e) {
          result.errors.push(`${emp.name}: ${e.message}`);
          console.error(`[Microvix/${board}] Erro ao baixar foto de ${emp.name}:`, e.message);
        }
      }
    }

    if (result.updated > 0) await writeDB(db);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/export-data ────────────────────────────────────────────
app.get('/api/admin/export-data', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.setHeader('Content-Disposition', 'attachment; filename="gestao-data.json"');
    res.json(db);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/import-data ───────────────────────────────────────────
// Mescla vsales (meta.mensal) e months do payload sem sobrescrever employees/users
app.post('/api/admin/import-data', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object')
      return res.status(400).json({ error: 'Payload inválido' });

    const db = await readDB();

    // Mescla vsales: preserva entries locais, importa meta.mensal
    if (incoming.vsales) {
      if (!db.vsales) db.vsales = {};
      for (const [empId, vs] of Object.entries(incoming.vsales)) {
        if (!db.vsales[empId]) db.vsales[empId] = {};
        if (vs.meta) db.vsales[empId].meta = vs.meta;
        if (vs.entries) {
          if (!db.vsales[empId].entries) db.vsales[empId].entries = {};
          Object.assign(db.vsales[empId].entries, vs.entries);
        }
      }
    }

    // Mescla months (pesos diários, metas semanais, etc.)
    if (incoming.months) {
      if (!db.months) db.months = {};
      for (const [mk, mv] of Object.entries(incoming.months)) {
        if (!db.months[mk]) db.months[mk] = mv;
        else db.months[mk] = { ...mv, ...db.months[mk] };
      }
    }

    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Transferências entre lojas ─────────────────────────────────────────────

// GET /api/microvix/estoque-probe?board=delrey → descobre empresa e testa comandos de estoque
app.get('/api/microvix/estoque-probe', requireAdmin, async (req, res) => {
  try {
    const { buildRequest, postRequest, fetchMovimento, parseCsv } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

    // 1. Descobre o código de empresa a partir de um movimento recente
    const today = new Date().toISOString().slice(0, 10);
    const dtIni = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    let empresa = null, deposito = null;
    try {
      const movRows = await fetchMovimento(cnpj, dtIni, today, chave);
      if (movRows.length) {
        empresa  = movRows[0].empresa  || null;
        deposito = movRows[0].deposito || null;
      }
    } catch {}

    // 2. Testa cada candidato — sem parâmetros extras e com empresa/deposito
    const stockCmds = [
      'LinxEstoque', 'LinxSaldoEstoque', 'LinxEstoqueDepositos',
      'LinxEstoqueProdutos', 'LinxProdutosEstoque', 'LinxEstoqueAtual',
      'LinxMovimentoEstoque', 'LinxSaldoEstoqueProduto', 'LinxProdutos',
    ];

    async function tryCmd(cmd, extraParams) {
      const raw = await postRequest(buildRequest(cmd, cnpj, extraParams, chave));
      if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
        const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'erro';
        return { ok: false, msg };
      }
      const lines = raw.trim().split(/\r?\n/).filter(l => l && !l.startsWith('sep='));
      return { ok: true, rows: lines.length - 1, fields: lines[0] || '' };
    }

    const results = { empresa, deposito, commands: {} };
    for (const cmd of stockCmds) {
      // Tenta sem parâmetros extras
      const r0 = await tryCmd(cmd, []).catch(e => ({ ok: false, msg: e.message }));
      results.commands[cmd] = { noParams: r0 };

      // Tenta com empresa (se descoberta)
      if (empresa) {
        const params = [{ id: 'empresa', valor: empresa }];
        if (deposito) params.push({ id: 'deposito', valor: deposito });
        const r1 = await tryCmd(cmd, params).catch(e => ({ ok: false, msg: e.message }));
        results.commands[cmd].withEmpresa = r1;
      }
    }

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/microvix/estoque-raw?board=delrey  → debug: campos e primeiras linhas
app.get('/api/microvix/estoque-raw', requireAdmin, async (req, res) => {
  try {
    const { fetchEstoque } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado em MICROVIX_LOJAS` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const today = new Date().toISOString().slice(0, 10);
    const rows  = await fetchEstoque(cnpj, chave, today);
    res.json({ total: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/microvix/promocoes-raw?board=delrey  → debug: campos e amostra do LinxProdutosPromocoes
app.get('/api/microvix/promocoes-raw', requireAdmin, async (req, res) => {
  try {
    const { fetchProdutosPromocoes } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = (lojas[board] || '').replace(/\D/g, '');
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const hoje  = new Date().toISOString().slice(0, 10);
    const rows  = await fetchProdutosPromocoes(cnpj, hoje, hoje, chave);
    res.json({ total: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/microvix/produtos-raw?board=delrey  → debug: campos do catálogo LinxProdutos
app.get('/api/microvix/produtos-raw', requireAdmin, async (req, res) => {
  try {
    const { fetchProdutos } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado em MICROVIX_LOJAS` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const rows  = await fetchProdutos(cnpj, chave, 0);
    res.json({ total: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 3) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/debug/tommy-catalog → diagnóstico completo do catálogo Tommy
app.get('/api/debug/tommy-catalog', requireAdmin, async (req, res) => {
  try {
    const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpjRaw = lojas['tommy'];
    const cnpj    = (cnpjRaw || '').replace(/\D/g, '');
    const chave   = process.env.MICROVIX_CHAVE_TOMMY || process.env.MICROVIX_CHAVE || '';
    const chaveSource = process.env.MICROVIX_CHAVE_TOMMY ? 'MICROVIX_CHAVE_TOMMY' : 'MICROVIX_CHAVE (fallback)';

    const result = {
      env: {
        MICROVIX_LOJAS_tommy: cnpjRaw || '(não mapeado)',
        cnpj_limpo: cnpj || '(vazio)',
        chave_usada: chave ? chave.slice(0, 8) + '...' : '(não definida)',
        chave_source: chaveSource,
        MICROVIX_CHAVE_TOMMY_definida: !!process.env.MICROVIX_CHAVE_TOMMY,
      },
    };

    if (!cnpj) {
      return res.json({ ...result, status: 'ERRO', erro: 'Tommy não mapeado em MICROVIX_LOJAS' });
    }
    if (!chave) {
      return res.json({ ...result, status: 'ERRO', erro: 'Nenhuma chave Microvix disponível' });
    }

    const { fetchProdutos } = require('./services/microvix');
    const rows = await fetchProdutos(cnpj, chave, 0);

    result.status = rows.length > 0 ? 'OK' : 'VAZIO';
    result.total_rows = rows.length;
    result.fields = rows[0] ? Object.keys(rows[0]) : [];
    result.sample = rows.slice(0, 3);

    // Verifica se setor/marca estão presentes
    const comSetor = rows.filter(r => r.desc_setor).length;
    const comMarca = rows.filter(r => r.desc_marca).length;
    result.stats = { com_setor: comSetor, com_marca: comMarca, sem_setor: rows.length - comSetor };

    // Verifica se o catálogo em memória tem dados Tommy
    const catalogSize = _catalogCache ? Object.keys(_catalogCache).length : 0;
    result.catalog_cache = { total_entradas: catalogSize, cache_ativo: !!_catalogCache };

    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'ERRO', erro: e.message, stack: e.stack?.split('\n').slice(0,5) });
  }
});

// GET /api/debug/cmv-campos?board=delrey&dtIni=2026-06-01&dtFin=2026-06-01
// Mostra todos os campos de custo disponíveis no LinxMovimento e LinxMovimentoItens
app.get('/api/debug/cmv-campos', requireAdmin, async (req, res) => {
  try {
    const board  = req.query.board  || 'delrey';
    const dtIni  = req.query.dtIni  || new Date().toISOString().slice(0,10);
    const dtFin  = req.query.dtFin  || dtIni;
    const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj   = (lojas[board] || '').replace(/\D/g,'');
    const chave  = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });

    const { fetchMovimento, fetchMovimentoItens } = require('./services/microvix');
    const [mov, itens] = await Promise.all([
      fetchMovimento(cnpj, dtIni, dtFin, chave).catch(e => ({ error: e.message })),
      fetchMovimentoItens(cnpj, dtIni, dtFin, chave).catch(e => ({ error: e.message })),
    ]);

    const custoCampos = /custo|preco_custo|preco_tabela|preco_unit|valor_unit/i;

    const movSample   = Array.isArray(mov)   ? mov.find(r => r.operacao === 'S') || mov[0] : mov;
    const itensSample = Array.isArray(itens) ? itens[0] : itens;

    const movCustoFields   = movSample   && !movSample.error   ? Object.entries(movSample).filter(([k]) => custoCampos.test(k))   : [];
    const itensCustoFields = itensSample && !itensSample.error ? Object.entries(itensSample).filter(([k]) => custoCampos.test(k)) : [];

    res.json({
      board, dtIni, dtFin,
      LinxMovimento: {
        total_rows: Array.isArray(mov) ? mov.length : 0,
        todos_campos: Array.isArray(mov) && mov[0] ? Object.keys(mov[0]) : [],
        campos_custo: Object.fromEntries(movCustoFields),
        sample_s: movSample && !movSample.error ? movSample : null,
      },
      LinxMovimentoItens: {
        total_rows: Array.isArray(itens) ? itens.length : 0,
        todos_campos: Array.isArray(itens) && itens[0] ? Object.keys(itens[0]) : [],
        campos_custo: Object.fromEntries(itensCustoFields),
        sample: itensSample && !itensSample.error ? itensSample : null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/debug/desconto-vendedor?board=contagem&dtIni=2026-06-01&dtFin=2026-06-11&cod=88
// Mostra o cálculo de desconto item a item para um vendedor específico
app.get('/api/debug/desconto-vendedor', requireAdmin, async (req, res) => {
  try {
    const { board = 'contagem', dtIni, dtFin, cod } = req.query;
    if (!dtIni || !dtFin || !cod) return res.status(400).json({ error: 'board, dtIni, dtFin, cod obrigatórios' });
    const lojas     = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj      = (lojas[board] || '').replace(/\D/g,'');
    const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const parseBR   = s => { const t = String(s||'').trim(); return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };
    const { fetchMovimento } = require('./services/microvix');
    const rows = await fetchMovimento(cnpj, dtIni, dtFin, chave);

    let totalBruto = 0, totalDesc = 0, docsSeen = new Set();
    const itens = [];
    for (const r of rows) {
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      if ((r.operacao||'').trim().toUpperCase() !== 'S') continue;
      if (String(r.cod_vendedor||'').trim() !== String(cod).trim()) continue;
      const qty       = parseBR(r.quantidade||'1');
      const vlrUnit   = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
      const descItem  = parseBR(r.desconto_item||'0');
      const descTotal = parseBR(r.desconto_total_item||'0');
      const vlrDesc   = parseBR(r.desconto_item||r.desconto_total_item||'0');
      totalBruto += vlrUnit * qty;
      totalDesc  += vlrDesc * qty;
      itens.push({
        doc: r.documento, qty, vlrUnit,
        desconto_item: descItem, desconto_total_item: descTotal,
        vlrDesc_usado: vlrDesc,
        bruto_linha: vlrUnit * qty,
        desc_linha: vlrDesc * qty,
        isNewDoc: !docsSeen.has(r.documento),
      });
      docsSeen.add(r.documento);
    }
    res.json({
      board, cod, dtIni, dtFin,
      totalBruto: totalBruto.toFixed(2),
      totalDesc: totalDesc.toFixed(2),
      pctDesc: totalBruto > 0 ? (totalDesc/totalBruto*100).toFixed(1)+'%' : '0%',
      totalDocs: docsSeen.size,
      totalItens: itens.length,
      itens: itens.slice(0, 30),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/microvix/produtos-xml?board=delrey  → retorna resposta RAW do Microvix para diagnóstico
app.get('/api/microvix/produtos-xml', requireAdmin, async (req, res) => {
  try {
    const { buildRequest, postRequest } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = (lojas[board] || '').replace(/\D/g, '');
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const today = new Date().toISOString().slice(0, 10);

    // Testa variações de params para descobrir o formato aceito
    const variant = req.query.v || '1';
    let params;
    if (variant === '1') params = [{ id: 'timestamp', valor: '0' }, { id: 'dt_update_fim', valor: today }];
    else if (variant === '2') params = [{ id: 'timestamp', valor: '1' }, { id: 'dt_update_fim', valor: today }];
    else if (variant === '3') params = [{ id: 'dt_update_fim', valor: today }];
    else if (variant === '4') params = [{ id: 'timestamp', valor: '0' }, { id: 'dt_update_fim', valor: `${today}T23:59:59` }];
    else if (variant === '5') params = [{ id: 'timestamp', valor: '0' }];

    const body = buildRequest('LinxProdutos', cnpj, params, chave);
    const raw  = await postRequest(body, 30_000);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(raw.slice(0, 2000)); // primeiros 2000 chars
  } catch (e) { res.status(500).send(e.message); }
});

// GET /api/microvix/movimento-raw?board=delrey  → debug: campos de LinxMovimento
app.get('/api/microvix/movimento-raw', requireAdmin, async (req, res) => {
  try {
    const { fetchMovimento } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado em MICROVIX_LOJAS` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const today = new Date().toISOString().slice(0, 10);
    const dtIni = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const rows  = await fetchMovimento(cnpj, dtIni, today, chave);
    res.json({ total: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 3) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/mx-probe — descobre colunas de qualquer comando Microvix ────────
// ?command=LinxMovimentoItens&board=delrey&dtIni=2026-05-01&dtFin=2026-05-26
app.get('/api/mx-probe', requireAdmin, async (req, res) => {
  try {
    const { command, board, dtIni, dtFin } = req.query;
    if (!command) return res.status(400).json({ error: 'Parâmetro "command" obrigatório' });
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const targetBoard = board || Object.keys(lojas)[0];
    const cnpj = (lojas[targetBoard] || '').replace(/\D/g, '');
    if (!cnpj) return res.status(400).json({ error: `Board "${targetBoard}" não mapeado em MICROVIX_LOJAS` });
    const chave = process.env[`MICROVIX_CHAVE_${targetBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
    const extra = [];
    if (dtIni) extra.push({ id: 'data_inicial', valor: dtIni });
    extra.push({ id: 'data_fim', valor: dtFin || dtIni || new Date().toISOString().slice(0,10) });
    const body = buildRequest(command, cnpj, extra, chave);
    const raw  = await postRequest(body, 120_000);
    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
      const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro';
      return res.status(400).json({ error: msg, rawHead: raw.slice(0, 500) });
    }
    const rows = parseCsv(raw);
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ command, board: targetBoard, headers, sample: rows.slice(0, 5), total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/catalog-status — diagnóstico do cache de catálogo ───────────
app.get('/api/catalog-status', requireAdmin, async (req, res) => {
  const size   = _catalogCache ? Object.keys(_catalogCache).length : 0;
  const ageMin = _catalogCacheAt ? Math.round((Date.now() - _catalogCacheAt) / 60000) : null;
  const entries = _catalogCache ? Object.entries(_catalogCache) : [];
  const withMarca    = entries.filter(([,v]) => v.marca).length;
  const withSetor    = entries.filter(([,v]) => v.setor).length;
  const sampleWith   = entries.filter(([,v]) => v.marca).slice(0, 2).map(([k,v]) => ({ key: k, ...v }));
  const sampleWithout= entries.filter(([,v]) => !v.marca).slice(0, 2).map(([k,v]) => ({ key: k, ...v }));
  // Amostras de keys para verificar formato (curtas vs longas)
  const allKeys = entries.map(([k]) => k);
  const keysSample = {
    short: allKeys.filter(k => k.length <= 3).slice(0, 5),
    mid:   allKeys.filter(k => k.length >= 4 && k.length <= 7).slice(0, 5),
    long:  allKeys.filter(k => k.length >= 8).slice(0, 5),
  };
  const portais = [...new Set(entries.map(([,v]) => v.portal).filter(Boolean))];
  const buildingFor = _catalogWarmPromise ? Math.round((Date.now() - _catalogWarmStartAt) / 1000) : null;
  res.json({ cached: !!_catalogCache, size, ageMin, withMarca, withSetor,
             pctMarca: size ? ((withMarca/size)*100).toFixed(1)+'%' : '0%',
             portais_no_cache: portais,
             building: !!_catalogWarmPromise, buildingForSec: buildingFor,
             rawFields: _catalogRawFields, rawSample: _catalogRawSample,
             keysSample, sampleWith, sampleWithout });
});

// ── GET /api/microvix/promo-lookup?board=delrey&cod=727526 — checa se produto está em promoção ──
app.get('/api/microvix/promo-lookup', requireAdmin, async (req, res) => {
  try {
    const { fetchProdutosPromocoes } = require('./services/microvix');
    const board = req.query.board || 'delrey';
    const cod   = String(req.query.cod || '').trim();
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = (lojas[board] || '').replace(/\D/g, '');
    if (!cnpj) return res.status(400).json({ error: `Board "${board}" não mapeado` });
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const hoje  = new Date().toISOString().slice(0, 10);
    const rows  = await fetchProdutosPromocoes(cnpj, hoje, hoje, chave);
    const parseBRDt = s => { const m = String(s||'').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], +m[2]-1, +m[1]) : null; };
    const agora = new Date();
    const vigentes = rows.filter(p => {
      const ini = parseBRDt(p.data_inicio_promocao);
      const fim = parseBRDt(p.data_termino_promocao);
      return !ini || !fim || (agora >= ini && agora <= fim);
    });
    const hit = cod ? vigentes.filter(p => String(p.cod_produto||'').trim() === cod) : [];
    res.json({ total_promo: rows.length, vigentes: vigentes.length, cod_buscado: cod, encontrado: hit.length > 0, registros: hit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/catalog-lookup?codes=880204,884901 — checa códigos no catálogo ──
app.get('/api/catalog-lookup', requireAdmin, (req, res) => {
  const codes = String(req.query.codes || '').split(',').map(c => c.replace(/\.0+$/, '').trim()).filter(Boolean);
  const result = {};
  for (const code of codes) {
    result[code] = _catalogCache ? (_catalogCache[code] || null) : 'cache_vazio';
  }
  res.json({ cacheSize: _catalogCache ? Object.keys(_catalogCache).length : 0, result });
});

// ── GET /api/catalog-warm — dispara rebuild em background e responde imediatamente ────
// Acesse /api/catalog-status para checar quando terminar
// Aceita também ?token=CATALOG_WARM_SECRET para uso em tarefas agendadas (sem sessão)
app.get('/api/catalog-warm', (req, res, next) => {
  const secret = process.env.CATALOG_WARM_SECRET;
  if (secret && req.query.token === secret) return next();
  return requireAdmin(req, res, next);
}, async (req, res) => {
  _catalogCache = null; _catalogCacheAt = 0; _catalogWarmPromise = null;
  const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  // Dispara build em background (sem await — o build leva 60-120s)
  _catalogWarmStartAt = Date.now();
  _catalogWarmPromise = _buildCatalog(lojas)
    .then(cat => { console.log(`[Catalog] rebuild manual concluído: ${Object.keys(cat).length} entradas`); })
    .catch(e  => { console.warn('[Catalog] rebuild manual erro:', e.message); })
    .finally(() => { _catalogWarmPromise = null; });
  res.json({
    ok: true,
    message: 'Rebuild iniciado em background. Acesse /api/catalog-status em ~2 minutos para verificar.',
    dica: 'portais_incluidos aparecerá em /api/catalog-status quando concluir',
  });
});

// ── GET /api/promo-cache-clear — limpa cache de promoções para forçar rebusca ──
app.get('/api/promo-cache-clear', (req, res, next) => {
  const secret = process.env.CATALOG_WARM_SECRET;
  if (secret && req.query.token === secret) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const keys = Object.keys(_promoCache);
  keys.forEach(k => delete _promoCache[k]);
  res.json({ ok: true, cleared: keys.length, msg: 'Cache de promoções limpo — próxima conferência rebusca tudo.' });
});

// ── Cache de resultados de marcas (vendas + estoque) ─────────────────────────
// Key: "boards|dtIni|dtFin"  — TTL: 5 min se inclui hoje, 60 min se período passado
const _marcasCache        = {};
const _estoqueMarcasCache = {};
function _marcasCacheKey(targetBoards, dtIni, dtFin) {
  return [...targetBoards].sort().join(',') + '|' + dtIni + '|' + dtFin;
}
function _marcasTTL(dtFin) {
  const today = new Date().toISOString().slice(0, 10);
  return dtFin >= today ? 5 * 60 * 1000 : 60 * 60 * 1000;
}

// ── GET /api/relatorio-marcas ─────────────────────────────────────────────
// ?dtIni=2026-05-01&dtFin=2026-05-26&board=delrey  ou  &boards=delrey,minas,contagem,estacao
// Grupo especial: &boards=surfers → delrey,minas,contagem,estacao
app.get('/api/relatorio-marcas', requireAuth, async (req, res) => {
  try {
    const { dtIni, dtFin, board, boards } = req.query;
    if (!dtIni || !dtFin) return res.status(400).json({ error: 'dtIni e dtFin obrigatórios (YYYY-MM-DD)' });
    const { board: userBoard } = req.session.user;
    const isAdm = !userBoard || userBoard === 'escritorio';

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const SURFERS = ['delrey', 'minas', 'contagem', 'estacao'];
    const targetBoards = !isAdm ? [userBoard]
      : boards === 'surfers'         ? SURFERS.filter(b => lojas[b])
      : boards                       ? boards.split(',').map(b => b.trim()).filter(b => lojas[b])
      : board                        ? [board]
      : Object.keys(lojas);

    // Cache hit
    const cKey = _marcasCacheKey(targetBoards, dtIni, dtFin);
    const cached = _marcasCache[cKey];
    if (cached && Date.now() - cached.at < _marcasTTL(dtFin)) {
      console.log(`[relatorioMarcas] cache HIT (${cKey})`);
      return res.json(cached.data);
    }

    const { fetchMovimento, parseBrNum } = require('./services/microvix');

    // Aguarda catálogo — se já em cache retorna imediato; se não, constrói agora
    const catalog = await _getCatalog(lojas).catch(() => ({}));

    const byMarca = {};

    const boardResults = await Promise.all(
      targetBoards.map(async b => {
        const cnpj = (lojas[b] || '').replace(/\D/g, '');
        if (!cnpj) return [];
        const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        try {
          const rows = await fetchMovimento(cnpj, dtIni, dtFin, chave);
          console.log(`[relatorioMarcas/${b}] ${rows.length} linhas`);
          return rows;
        } catch (e) {
          console.error(`[relatorioMarcas/${b}] ${e.message}`);
          return [];
        }
      })
    );

    let _diagTotal = 0, _diagMiss = 0, _diagLogged = false;
    for (const rows of boardResults) {
      for (const row of rows) {
        if (row.cancelado === 'S' || row.cancelado === '1') continue;
        if (row.excluido  === 'S') continue;
        if (row.soma_relatorio === 'N') continue;
        const op    = (row.operacao || '').toUpperCase();
        const serie = String(row.serie || row.serie_documento || row.num_serie || '').trim();
        if (op !== 'S' && op !== 'DS') continue;
        if (serie === '999') continue;
        if (serie === '4' && op !== 'DS') continue;
        if (serie === 'J') continue;
        const sign = op === 'DS' ? -1 : 1;

        const cod      = String(row.cod_produto || '').replace(/\.0+$/, '').trim();
        const barra    = String(row.cod_barra   || '').replace(/\.0+$/, '').trim();
        if (!cod) continue;
        const prodInfo = catalog[cod] || catalog[barra] || {};
        _diagTotal++;
        if (!prodInfo.marca) {
          _diagMiss++;
          if (!_diagLogged) { console.log(`[relatorioMarcas] miss sample — cod:${cod} barra:${barra} row_marca:${row.desc_marca||''}`); _diagLogged = true; }
        }

        const marca = ((prodInfo.marca || row.desc_marca || row.marca || '').trim()) || '(sem marca)';
        const setor = ((prodInfo.setor || row.desc_setor || row.setor || '').trim()) || '(sem setor)';
        const nome  = (prodInfo.nomeBase || row.nome_produto || row.nome || row.descricao || cod).trim();
        const qtd   = sign * parseBrNum(row.quantidade  || '0');
        const valor = sign * parseBrNum(row.valor_total || '0');

        const mKey = marca.toUpperCase();
        if (!byMarca[mKey]) byMarca[mKey] = { marca, qtd: 0, valor: 0, setores: {} };
        byMarca[mKey].qtd   += qtd;
        byMarca[mKey].valor += valor;

        const sKey = setor.toUpperCase();
        if (!byMarca[mKey].setores[sKey]) byMarca[mKey].setores[sKey] = { setor, qtd: 0, valor: 0, produtos: {} };
        byMarca[mKey].setores[sKey].qtd   += qtd;
        byMarca[mKey].setores[sKey].valor += valor;

        const rKey = (prodInfo.referencia || cod).toUpperCase();
        const cor  = prodInfo.desc_cor || '';
        const produtos = byMarca[mKey].setores[sKey].produtos;
        if (!produtos[rKey])
          produtos[rKey] = { ref: prodInfo.referencia || cod, nome: prodInfo.nomeBase || nome, qtd: 0, valor: 0, cores: {} };
        produtos[rKey].qtd   += qtd;
        produtos[rKey].valor += valor;
        const cKey = cor.toUpperCase() || '__SEM_COR__';
        if (!produtos[rKey].cores[cKey])
          produtos[rKey].cores[cKey] = { cor: cor || '—', qtd: 0, valor: 0 };
        produtos[rKey].cores[cKey].qtd   += qtd;
        produtos[rKey].cores[cKey].valor += valor;
      }
    }

    const result = Object.values(byMarca)
      .map(m => ({
        marca:  m.marca,
        qtd:    m.qtd,
        valor:  parseFloat(m.valor.toFixed(2)),
        setores: Object.values(m.setores)
          .map(s => ({
            setor:   s.setor,
            qtd:     s.qtd,
            valor:   parseFloat(s.valor.toFixed(2)),
            produtos: Object.values(s.produtos)
              .sort((a, b) => b.valor - a.valor)
              .map(p => ({
                ref: p.ref, nome: p.nome, qtd: p.qtd, valor: parseFloat(p.valor.toFixed(2)),
                cores: Object.values(p.cores).sort((a, b) => b.valor - a.valor)
                  .map(c => ({ ...c, valor: parseFloat(c.valor.toFixed(2)) })),
              })),
          }))
          .sort((a, b) => b.valor - a.valor),
      }))
      .sort((a, b) => b.valor - a.valor);

    console.log(`[relatorioMarcas] linhas:${_diagTotal} sem_marca:${_diagMiss} (${_diagTotal ? ((_diagMiss/_diagTotal)*100).toFixed(1) : 0}%) catalogSize:${Object.keys(catalog).length}`);
    const payload = { dtIni, dtFin, boards: targetBoards, total: result.length, marcas: result };
    _marcasCache[cKey] = { data: payload, at: Date.now() };
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/estoque-marcas ───────────────────────────────────────────────
// Estoque atual por marca/setor/loja com valor em preço de venda.
// Usa LinxProdutosInventario + catálogo (preco_venda).
// Aceita os mesmos parâmetros de board que /api/relatorio-marcas.
app.get('/api/estoque-marcas', requireAuth, async (req, res) => {
  try {
    const { board, boards } = req.query;
    const { board: userBoard } = req.session.user;
    const isAdm = !userBoard || userBoard === 'escritorio';
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const SURFERS = ['delrey', 'minas', 'contagem', 'estacao'];

    const targetBoards = !isAdm ? [userBoard]
      : boards === 'surfers'   ? SURFERS.filter(b => lojas[b])
      : boards                 ? boards.split(',').map(b => b.trim()).filter(b => lojas[b])
      : board                  ? [board]
      : Object.keys(lojas);

    const today = new Date().toISOString().slice(0, 10);

    // Cache hit (estoque tem TTL de 5 min — sempre "hoje")
    const eCacheKey = _marcasCacheKey(targetBoards, today, today);
    const eCached = _estoqueMarcasCache[eCacheKey];
    if (eCached && Date.now() - eCached.at < 5 * 60 * 1000) {
      console.log(`[estoqueMarcas] cache HIT`);
      return res.json(eCached.data);
    }

    const { fetchEstoque, parseBrNum } = require('./services/microvix');
    const catalog = await _getCatalog(lojas).catch(() => ({}));

    const stockByBoard = {};
    await Promise.all(targetBoards.map(async b => {
      const cnpj  = (lojas[b] || '').replace(/\D/g, '');
      if (!cnpj) return;
      const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      try {
        stockByBoard[b] = await fetchEstoque(cnpj, chave, today);
      } catch (e) {
        console.warn(`[estoqueMarcas/${b}] ${e.message}`);
        stockByBoard[b] = [];
      }
    }));

    const STORE_LABELS = { delrey: 'DEL REY', minas: 'MINAS', contagem: 'CONTAGEM', estacao: 'ESTAÇÃO', tommy: 'TOMMY', lez: 'LEZ A LEZ' };
    const STORE_COLORS = { delrey: '#58A6FF', minas: '#3FB950', contagem: '#D29922', estacao: '#F85149', tommy: '#22D3EE', lez: '#F472B6' };

    const byMarca = {};

    for (const b of targetBoards) {
      for (const r of (stockByBoard[b] || [])) {
        const cod   = String(r.cod_produto || r.codproduto || '').replace(/\.0+$/, '').trim();
        const barra = String(r.cod_barra   || r.codbarra   || '').replace(/\.0+$/, '').trim();
        if (!cod) continue;

        const qty = parseBrNum(r.quantidade || '0');
        if (qty <= 0) continue;

        const prodInfo  = catalog[cod] || catalog[barra] || {};
        const marca     = (prodInfo.marca || '(sem marca)').trim();
        const setor     = (prodInfo.setor || '(sem setor)').trim();
        const preco     = parseBrNum(r.preco_venda || r.preco || '0') || (prodInfo.preco_venda || 0);
        const valor     = qty * preco;

        const mKey = marca.toUpperCase();
        if (!byMarca[mKey]) byMarca[mKey] = { marca, totalQtd: 0, totalValor: 0, lojas: {}, setores: {} };
        byMarca[mKey].totalQtd   += qty;
        byMarca[mKey].totalValor += valor;
        if (!byMarca[mKey].lojas[b]) byMarca[mKey].lojas[b] = { qtd: 0, valor: 0 };
        byMarca[mKey].lojas[b].qtd   += qty;
        byMarca[mKey].lojas[b].valor += valor;

        const sKey = setor.toUpperCase();
        if (!byMarca[mKey].setores[sKey]) byMarca[mKey].setores[sKey] = { setor, lojas: {}, refs: {} };
        if (!byMarca[mKey].setores[sKey].lojas[b]) byMarca[mKey].setores[sKey].lojas[b] = { qtd: 0, valor: 0 };
        byMarca[mKey].setores[sKey].lojas[b].qtd   += qty;
        byMarca[mKey].setores[sKey].lojas[b].valor += valor;

        const rKey = (prodInfo.referencia || cod).toUpperCase();
        const ref  = prodInfo.referencia || cod;
        const nome = prodInfo.nomeBase || '';
        if (!byMarca[mKey].setores[sKey].refs[rKey])
          byMarca[mKey].setores[sKey].refs[rKey] = { ref, nome, lojas: {} };
        if (!byMarca[mKey].setores[sKey].refs[rKey].lojas[b])
          byMarca[mKey].setores[sKey].refs[rKey].lojas[b] = { qtd: 0 };
        byMarca[mKey].setores[sKey].refs[rKey].lojas[b].qtd += qty;
      }
    }

    function lojasList(lojasMap) {
      return targetBoards
        .filter(b => lojasMap[b])
        .map(b => ({
          board: b,
          label: STORE_LABELS[b] || b.toUpperCase(),
          color: STORE_COLORS[b] || '#8b949e',
          qtd:   lojasMap[b].qtd,
          valor: parseFloat(lojasMap[b].valor.toFixed(2)),
        }));
    }
    function lojasQtd(lojasMap) {
      return targetBoards.filter(b => lojasMap[b]).map(b => ({ board: b, qtd: lojasMap[b].qtd }));
    }

    const result = Object.values(byMarca)
      .map(m => ({
        marca:      m.marca,
        totalQtd:   m.totalQtd,
        totalValor: parseFloat(m.totalValor.toFixed(2)),
        lojas:      lojasList(m.lojas),
        setores:    Object.values(m.setores)
          .map(s => ({
            setor:      s.setor,
            totalQtd:   targetBoards.reduce((sum, b) => sum + (s.lojas[b]?.qtd   || 0), 0),
            totalValor: parseFloat(targetBoards.reduce((sum, b) => sum + (s.lojas[b]?.valor || 0), 0).toFixed(2)),
            lojas:      lojasList(s.lojas),
            refs:       Object.values(s.refs)
              .map(r => ({
                ref:      r.ref,
                nome:     r.nome,
                totalQtd: targetBoards.reduce((sum, b) => sum + (r.lojas[b]?.qtd || 0), 0),
                lojas:    lojasQtd(r.lojas),
              }))
              .sort((a, b) => b.totalQtd - a.totalQtd)
              .slice(0, 60),
          }))
          .sort((a, b) => b.totalValor - a.totalValor),
      }))
      .sort((a, b) => b.totalValor - a.totalValor);

    const ePayload = { boards: targetBoards, estoque: result };
    _estoqueMarcasCache[eCacheKey] = { data: ePayload, at: Date.now() };
    res.json(ePayload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Transferências: cache de resultado (TTL 30min) ─────────────────────────
let _transResultCache = {};
let _transWarmRunning = {};
const TRANS_RESULT_TTL = 30 * 60 * 1000;

// Cache do catálogo de produtos (LinxProdutos) — válido por 6 horas
let _catalogCache = null;
let _catalogCacheAt = 0;
let _catalogWarmPromise = null;  // Promise compartilhada — callers concorrentes aguardam a mesma
let _catalogWarmStartAt = 0;    // Timestamp de início do build atual
let _catalogRawFields = [];      // campos brutos do LinxProdutos (para diagnóstico)
let _catalogRawSample = null;    // amostra bruta (1 produto)
const CATALOG_TTL = 24 * 60 * 60 * 1000; // 24h — rebuild automático às 9h pelo cron

// Cache de promoções — válido até meia-noite do dia atual
const _promoCache = {};  // key: cnpj → { rows, date }
function _promoCacheKey(cnpj) { return String(cnpj).replace(/\D/g, ''); }
function _promoIsValid(cnpj) {
  const c = _promoCache[_promoCacheKey(cnpj)];
  return c && c.date === new Date().toISOString().slice(0, 10);
}
function _promoGet(cnpj) { return _promoCache[_promoCacheKey(cnpj)]?.rows || []; }
function _promoSet(cnpj, rows) {
  _promoCache[_promoCacheKey(cnpj)] = { rows, date: new Date().toISOString().slice(0, 10) };
}

// Cache de planos/bandeiras/vendedores — dados estáticos, TTL 1h por CNPJ
const _staticMicrovixCache = {}; // key: `${tipo}:${cnpj}` → { rows, at }
const _STATIC_TTL = 60 * 60 * 1000; // 1h
function _staticGet(tipo, cnpj) {
  const k = `${tipo}:${String(cnpj).replace(/\D/g,'')}`;
  const c = _staticMicrovixCache[k];
  return (c && Date.now() - c.at < _STATIC_TTL) ? c.rows : null;
}
function _staticSet(tipo, cnpj, rows) {
  _staticMicrovixCache[`${tipo}:${String(cnpj).replace(/\D/g,'')}`] = { rows, at: Date.now() };
}
async function _cachedFetch(tipo, cnpj, fn) {
  const cached = _staticGet(tipo, cnpj);
  if (cached) return cached;
  const rows = await fn();
  _staticSet(tipo, cnpj, rows);
  return rows;
}

// ── Índice compacto ref→cores (para /api/cadastro-produto/check) ────────────
// Persiste no MongoDB → sobrevive a restarts; muito menor que o catálogo completo
let _refColorIndex    = null;   // { "REF123": ["AZUL","PRETO"], ... }
let _refColorIdxAt    = 0;
let _refColorIdxPromise = null;
const REFCOLOR_TTL = 6 * 60 * 60 * 1000;

async function _getRefColorIndex() {
  if (_refColorIndex && Date.now() - _refColorIdxAt < REFCOLOR_TTL) return _refColorIndex;

  // Cold start: o MongoDB vem ANTES de disparar o rebuild — reiniciar o serviço
  // não pode custar uma varredura do catálogo na WebAPI quando já existe cópia
  // recente gravada (o plano da Microvix é limitado por requisições/dia).
  if (!_refColorIndex && mongoDb) {
    try {
      const doc = await mongoDb.collection('catalog').findOne({ _id: 'refColor' });
      if (doc?.data && Object.keys(doc.data).length > 0) {
        _refColorIndex = doc.data;
        _refColorIdxAt = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
        console.log(`[RefColor] Carregado do MongoDB: ${Object.keys(_refColorIndex).length} refs`);
        if (Date.now() - _refColorIdxAt < REFCOLOR_TTL) return _refColorIndex;
      }
    } catch(e) { console.warn('[RefColor] MongoDB load:', e.message); }
  }

  if (!_refColorIdxPromise)
    _refColorIdxPromise = _buildRefColorIndex().finally(() => { _refColorIdxPromise = null; });

  // Cópia velha serve enquanto o rebuild roda em background
  if (_refColorIndex) return _refColorIndex;

  return _refColorIdxPromise;
}

async function _buildRefColorIndex() {
  const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
  const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const boards = Object.keys(lojas).filter(b => b !== 'site' && b !== 'tommy');
  if (!boards.length) return {};

  const board = boards[0]; // catálogo é único para todas as lojas Surfers
  const cnpj  = (lojas[board] || '').replace(/\D/g, '');
  const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  if (!cnpj) return {};

  const normStr   = s => (s || '').toString().replace(/\.0+$/, '').trim().toUpperCase();
  const refColMap = {};  // ref → Set<cor>
  const today     = new Date().toISOString().slice(0, 10);
  const dtIni     = new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let ts = 0, total = 0;
  console.log(`[RefColor] Build iniciado via ${board}…`);
  for (let page = 0; page < 40; page++) {
    const body = buildRequest('LinxProdutos', cnpj, [
      { id: 'timestamp',        valor: String(ts) },
      { id: 'dt_update_inicio', valor: dtIni },
      { id: 'dt_update_fim',    valor: today },
    ], chave);
    let raw;
    try { raw = await postRequest(body, 60_000); } catch(e) { console.warn(`[RefColor] pág ${page}:`, e.message); break; }
    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) break;
    const rows = parseCsv(raw);
    for (const r of rows) {
      const ref = normStr(r.referencia || r.cod_produto || '');
      if (!ref) continue;
      const cor = normStr(r.desc_cor || '');
      if (!refColMap[ref]) refColMap[ref] = new Set();
      if (cor) refColMap[ref].add(cor);
    }
    total += rows.length;
    if (rows.length < 5000) break;
    const maxTs = Math.max(...rows.map(r => parseInt(r.timestamp) || 0));
    if (maxTs <= ts) break;
    ts = maxTs;
  }

  const data = {};
  for (const [ref, cors] of Object.entries(refColMap)) data[ref] = [...cors].sort();
  console.log(`[RefColor] ${total} SKUs → ${Object.keys(data).length} refs únicas`);

  if (mongoDb && Object.keys(data).length > 0) {
    try {
      await mongoDb.collection('catalog').replaceOne(
        { _id: 'refColor' },
        { _id: 'refColor', data, updatedAt: new Date() },
        { upsert: true }
      );
      console.log('[RefColor] Índice salvo no MongoDB');
    } catch(e) { console.warn('[RefColor] Erro ao salvar:', e.message); }
  }

  _refColorIndex = data;
  _refColorIdxAt = Date.now();
  return data;
}

const CATALOG_CHUNK_SIZE = 20000; // ~3-4 MB por chunk, bem abaixo do limite de 16 MB

async function _saveCatalogMongo(map) {
  const entries  = Object.entries(map);
  const total    = entries.length;
  const updatedAt = new Date();
  const numChunks = Math.ceil(total / CATALOG_CHUNK_SIZE);
  const col = mongoDb.collection('catalog');

  // Salva os chunks com concorrência limitada — disparar tudo de uma vez (32+ writes de
  // 3-4MB em paralelo) monopolizava o pool de conexões do Mongo e deixava outras operações
  // do app (ex: conferência de caixa) na fila por dezenas de segundos.
  const CONCURRENCY = 4;
  for (let i = 0; i < numChunks; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, numChunks); j++) {
      const chunk = Object.fromEntries(entries.slice(j * CATALOG_CHUNK_SIZE, (j + 1) * CATALOG_CHUNK_SIZE));
      batch.push(col.replaceOne(
        { _id: `fullCatalog_${j}` },
        { _id: `fullCatalog_${j}`, data: chunk, updatedAt },
        { upsert: true }
      ));
    }
    await Promise.all(batch);
  }
  // Remove chunks antigos que não existem mais (se o catálogo encolheu)
  await col.deleteMany({ _id: { $regex: /^fullCatalog_/, $gt: `fullCatalog_${numChunks - 1}` } });
  // Salva metadado com número de chunks
  await col.replaceOne(
    { _id: 'fullCatalog_meta' },
    { _id: 'fullCatalog_meta', numChunks, total, updatedAt },
    { upsert: true }
  );
  console.log(`[Catalog] Salvo no MongoDB: ${total} entradas em ${numChunks} chunks`);
}

async function _loadCatalogMongo() {
  const col  = mongoDb.collection('catalog');
  const meta = await col.findOne({ _id: 'fullCatalog_meta' });
  if (!meta || !meta.numChunks) return null;

  const chunks = await Promise.all(
    Array.from({ length: meta.numChunks }, (_, i) => col.findOne({ _id: `fullCatalog_${i}` }))
  );
  if (chunks.some(c => !c?.data)) return null; // algum chunk sumiu

  const map = Object.assign({}, ...chunks.map(c => c.data));
  console.log(`[Catalog] Carregado do MongoDB: ${Object.keys(map).length} entradas (${meta.numChunks} chunks)`);
  return { map, updatedAt: meta.updatedAt };
}

async function _getCatalog(lojas) {
  if (_catalogCache && Date.now() - _catalogCacheAt < CATALOG_TTL) return _catalogCache;

  // Cold start: o MongoDB vem ANTES de disparar o rebuild. Um catálogo inteiro
  // custa dezenas de requisições por loja na WebAPI (plano limitado por dia);
  // se a cópia gravada ainda está dentro do TTL, reiniciar não custa nada.
  let doMongo = null;
  if (!_catalogCache && mongoDb) {
    try {
      const loaded = await _loadCatalogMongo();
      if (loaded && Object.keys(loaded.map).length > 0) {
        doMongo         = loaded.map;
        _catalogCache   = doMongo;
        _catalogCacheAt = loaded.updatedAt ? new Date(loaded.updatedAt).getTime() : 0;
        if (Date.now() - _catalogCacheAt < CATALOG_TTL) return doMongo;
      }
    } catch (e) { console.warn('[Catalog] MongoDB load:', e.message); }
  }

  // Inicia rebuild em background se ainda não está rodando (ou se travou há mais de 10min)
  const warmStuck = _catalogWarmPromise && (Date.now() - _catalogWarmStartAt > 600_000);
  if (warmStuck) {
    console.warn('[Catalog] build travado há >10min — descartando e retornando cache vazio');
    _catalogWarmPromise = null;
  }
  if (!_catalogWarmPromise) {
    _catalogWarmStartAt = Date.now();
    _catalogWarmPromise = _buildCatalog(lojas).finally(() => { _catalogWarmPromise = null; });
  }
  // Snapshot local: _catalogWarmPromise pode ser zerado pelo .finally() acima durante os
  // awaits abaixo (ex: build termina rápido enquanto aguardamos o Mongo). Sem isso, o
  // Promise.race no final racearia contra `null` e resolveria para null em vez do catálogo.
  const buildPromise = _catalogWarmPromise;

  // Cópia expirada (memória ou Mongo) serve enquanto o rebuild roda em background
  if (_catalogCache) return _catalogCache;
  if (doMongo)       return doMongo;

  // Sem MongoDB e sem cache: aguarda o build com timeout de 10min para não bloquear
  const result = await Promise.race([
    buildPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('catalog build timeout')), 600_000)),
  ]).catch(() => ({}));
  return result || {};
}

async function _buildCatalog(lojas) {
  const { fetchServicos, buildRequest, postRequest, parseCsv, parseBrNum } = require('./services/microvix');
  // Inclui Tommy — tem CNPJ próprio, então seenSources vai buscá-lo como catálogo separado
  const boards = Object.keys(lojas).filter(b => b !== 'site');
  if (!boards.length) return {};
  const mainBoard = boards[0];  // todas as lojas compartilham o mesmo catálogo
  // Descarta cache antigo ANTES de construir — sem referência _prevCache para não manter o objeto
  // vivo durante o build (evita pico duplo de ~254 MB → só ~127 MB durante a construção)
  _catalogCache = null;
  try {
    const map = {};
    const today = new Date().toISOString().slice(0, 10);
    // 3 anos: cobre produtos com cadastro estável (sem modificação recente) mas ainda ativos.
    // Não usar '2000-01-01': traz 150k+ por loja em ordem ASC truncando os recentes no limite de 20 páginas.
    const dtIniCatalog = new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    async function fetchBoard(board) {
      const cnpj  = (lojas[board] || '').replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      if (!cnpj) return 0;
      let ts = 0, boardCount = 0;
      for (let page = 0; page < 40; page++) {
        const body = buildRequest('LinxProdutos', cnpj, [
          { id: 'timestamp',        valor: String(ts) },
          { id: 'dt_update_inicio', valor: dtIniCatalog },
          { id: 'dt_update_fim',    valor: today },
        ], chave);
        let raw;
        try { raw = await postRequest(body, 30_000); } catch (e) { console.warn(`[Catalog/${board}] pág`, page, e.message); break; }
        if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) break;
        const rows = parseCsv(raw);
        if (!_catalogRawFields.length && rows.length) {
          _catalogRawFields = Object.keys(rows[0]);
          _catalogRawSample = rows[0];
        }
        for (const r of rows) {
          const cod   = String(r.cod_produto || '').replace(/\.0+$/, '').trim();
          const ref   = String(r.referencia  || '').replace(/\.0+$/, '').trim();
          const barra = String(r.cod_barra   || '').replace(/\.0+$/, '').trim();
          if (!cod && !ref) continue;
          const nomeBase = (r.descricao_basica || r.nome || '').trim();
          const entry = {
            nomeBase,
            referencia:  ref,
            setor:       (r.desc_setor    || '').trim(),
            marca:       (r.desc_marca    || '').trim(),
            linha:       (r.desc_colecao  || '').trim(),
            desc_cor:    (r.desc_cor      || '').trim(),
            ncm:         (r.cod_ncm || r.ncm || '').toString().replace(/\.0+$/, '').trim(),
            preco_venda: parseBrNum(r.preco_venda || r.preco || r.preco_cheio || '0'),
            portal:      (r.portal        || '').toString().trim(),
          };
          const mergeEntry = (key) => {
            if (!map[key]) { map[key] = entry; return; }
            if (!map[key].marca       && entry.marca)       map[key].marca       = entry.marca;
            if (!map[key].setor       && entry.setor)       map[key].setor       = entry.setor;
            if (!map[key].linha       && entry.linha)       map[key].linha       = entry.linha;
            if (!map[key].nomeBase    && entry.nomeBase)    map[key].nomeBase    = entry.nomeBase;
            if (!map[key].ncm         && entry.ncm)         map[key].ncm         = entry.ncm;
            if (!map[key].preco_venda && entry.preco_venda) map[key].preco_venda = entry.preco_venda;
          };
          if (cod)                                      mergeEntry(cod);
          if (ref   && ref   !== cod)                   mergeEntry(ref);
          if (barra && barra !== cod && barra !== ref)  mergeEntry(barra);
        }
        boardCount += rows.length;
        if (rows.length < 5000) break;
        const maxTs = Math.max(...rows.map(r => parseInt(r.timestamp) || 0));
        if (maxTs <= ts) break;
        ts = maxTs;
      }
      const svcRows = await fetchServicos(cnpj, chave, 0).catch(e => { console.warn(`[Catalog/${board}] servicos:`, e.message); return []; });
      for (const r of svcRows) {
        const cod = String(r.cod_servico || '').replace(/\.0+$/, '').trim();
        if (!cod || map[cod]) continue;
        map[cod] = { tipo: 'servico', nome: (r.nome || '').trim(), setor: (r.desc_setor || '').trim(), marca: (r.desc_marca || '').trim(), linha: (r.desc_linha || '').trim(), desc_cor: '', desc_tam: '', preco_cheio: 0, preco_promo: 0 };
      }
      console.log(`[Catalog/${board}] ${boardCount} produtos`);
      return boardCount;
    }

    // Agrupa boards por (chave + CNPJ) — busca um representante por catálogo distinto.
    // O catálogo Microvix (LinxProdutos) é por empresa/CNPJ sob uma chave; lojas que
    // compartilham os dois compartilham o mesmo catálogo. Tommy é outra empresa (CNPJ
    // próprio) mesmo usando a chave padrão, então precisa ser buscado à parte — não basta
    // distinguir pela chave.
    const defaultChave = process.env.MICROVIX_CHAVE || '';
    const seenSources = new Set();
    const representantes = [];
    for (const b of boards) {
      const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || defaultChave;
      const cnpj  = (lojas[b] || '').replace(/\D/g, '');
      if (!cnpj) continue;
      const source = `${chave}|${cnpj}`;
      if (!seenSources.has(source)) { seenSources.add(source); representantes.push(b); }
    }
    const counts = await Promise.all(
      representantes.map(b => fetchBoard(b).catch(e => { console.warn(`[Catalog/${b}] erro:`, e.message); return 0; }))
    );
    const totalProd = counts.reduce((s, n) => s + n, 0);

    console.log(`[Catalog] ${totalProd} produtos → ${Object.keys(map).length} entradas (via ${representantes.join(',')})`);
    _catalogCache   = map;
    _catalogCacheAt = Date.now();

    if (mongoDb && Object.keys(map).length > 0) {
      _saveCatalogMongo(map).catch(e => console.warn('[Catalog] Erro ao salvar:', e.message));
    }

    return map;
  } catch (e) {
    console.warn('[Catalog] Erro:', e.message);
    return {};
  }
}

// Calcula transferências proporcionais ao giro de cada loja.
// Retorna { transfers, workStocks, ideal } ou null se não há movimento.
//   - ideal[b]: estoque ideal calculado pelo giro
//   - donors: lojas com excesso (stock > ideal), ordenadas por maior excesso
//   - receivers: lojas com déficit (stock < ideal), ordenadas por maior déficit
//   - A doadora cede apenas seu excesso → seu giro é respeitado
// periodDays: duração do período do giro (ex: 90 dias para Microvix, ~510 para Excel de 17 meses)
function _parseDateBR(d) {
  if (!d) return NaN;
  const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : Date.parse(d);
}

function _calcTransfersProporcional(boards, stocks, giro, periodDays = 90, lastCompra = {}) {
  const totalGiro  = boards.reduce((s, b) => s + (giro[b] || 0), 0);
  const totalStock = boards.reduce((s, b) => s + (stocks[b] || 0), 0);
  if (totalGiro === 0 || totalStock === 0) return null;

  // Estoque ideal proporcional ao giro (floor + distribuição de resto)
  const parts = boards.map(b => {
    const exact = totalStock * (giro[b] || 0) / totalGiro;
    return { b, floor: Math.floor(exact), rem: exact % 1 };
  });
  let assigned = parts.reduce((s, x) => s + x.floor, 0);
  parts.sort((a, c) => c.rem - a.rem);
  for (let i = 0; i < totalStock - assigned; i++) parts[i].floor++;
  const ideal = {};
  for (const { b, floor } of parts) ideal[b] = floor;

  const delta = {};
  for (const b of boards) delta[b] = (stocks[b] || 0) - ideal[b];

  // Regra 1: doadora só envia se tiver estoque > 1 (mantém ao menos 1 peça)
  const donors = boards
    .filter(b => (stocks[b] || 0) > 1 && delta[b] > 0)
    .sort((a, b) => delta[b] - delta[a]);

  // Regra 2: receptora recebe se tem déficit em relação ao ideal, tem histórico de vendas
  // E cobertura atual < MIN_COB_RECEIVER meses (evita transferir para loja já bem abastecida)
  const MIN_COB_RECEIVER = 1.5;
  const receivers = boards
    .filter(b => {
      if (delta[b] >= 0 || (giro[b] || 0) <= 0) return false;
      const giroMensal = (giro[b] / periodDays) * 30;
      const cobertura  = giroMensal > 0 ? (stocks[b] || 0) / giroMensal : Infinity;
      return cobertura < MIN_COB_RECEIVER;
    })
    .sort((a, b) => delta[a] - delta[b]);

  if (!donors.length || !receivers.length) return null;

  const workStocks = { ...stocks };
  const workDelta  = { ...delta };
  const transfers  = [];

  // Proteção por tempo de exposição: loja que recebeu o produto há menos de 45 dias
  // só pode ceder uma fração do seu excesso (rampa linear com ceil)
  const PROTECTION_DAYS = 90;
  const todayMs = Date.now();
  const maxDonation = {};
  for (const don of donors) {
    const compraDate = lastCompra[don];
    let maxCanDonate = delta[don];
    if (compraDate) {
      const diasDesdeCompra = Math.floor((todayMs - _parseDateBR(compraDate)) / 86400_000);
      if (diasDesdeCompra < PROTECTION_DAYS) {
        maxCanDonate = Math.ceil(delta[don] * (diasDesdeCompra / PROTECTION_DAYS));
      }
    }
    maxDonation[don] = Math.min(maxCanDonate, (stocks[don] || 0) - 1);
  }
  const donated = {};
  for (const don of donors) donated[don] = 0;

  // Regra 4: receptora não pode ficar com mais de MAX_COB_AFTER meses de cobertura pós-transferência
  const MAX_COB_AFTER = 3;
  const maxReceive = {};
  for (const rec of receivers) {
    const giroMensal = ((giro[rec] || 0) / periodDays) * 30;
    const maxStock   = Math.ceil(giroMensal * MAX_COB_AFTER);
    maxReceive[rec]  = Math.max(0, maxStock - (stocks[rec] || 0));
  }
  const received = {};
  for (const rec of receivers) received[rec] = 0;

  for (const rec of receivers) {
    let needed = Math.min(-workDelta[rec], maxReceive[rec] - received[rec]);
    if (needed <= 0) continue;
    for (const don of donors) {
      if (workDelta[don] <= 0) continue;
      const remaining = maxDonation[don] - donated[don];
      if (remaining <= 0) continue;
      const qty = Math.min(needed, remaining);
      if (qty <= 0) continue;
      transfers.push({ de: don, para: rec, qty });
      workStocks[don] -= qty;
      workStocks[rec] += qty;
      workDelta[don]  -= qty;
      workDelta[rec]  += qty;
      donated[don]    += qty;
      received[rec]   += qty;
      needed          -= qty;
      if (needed <= 0) break;
    }
  }

  if (!transfers.length) return null;
  return { transfers, workStocks, ideal };
}

// Computa sugestões: estoque + movimento (N dias) por loja — sem fetches extras
async function _buildTransResult(boards, lojas, dias) {
  const { fetchEstoque, fetchMovimento } = require('./services/microvix');
  const todayUTC = new Date();
  const today = todayUTC.toISOString().slice(0, 10);
  const dtIni = new Date(todayUTC - dias * 86400_000).toISOString().slice(0, 10);

  const estoqueByBoard    = {};
  const giroByBoard       = {};
  const catalogMov        = {};   // fallback info vinda dos movRows (campos limitados)
  const ultVendaMap       = {};   // última venda por cod_produto (cross-board)
  const ultCompraMap      = {};   // última entrada por cod_produto (cross-board)
  const ultCompraPerBoard = {};   // última entrada por cod_produto por loja { board: { cod: iso } }

  // Busca catálogo (setor, marca) em paralelo com estoque/movimento
  const [catalog] = await Promise.all([
    Promise.race([_getCatalog(lojas), new Promise(r => setTimeout(() => r({}), 20_000))]).catch(() => ({})),
    Promise.all(boards.map(async board => {
    const cnpj  = lojas[board].replace(/\D/g, '');
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    // Busca estoque e movimentos do período em paralelo
    // Entradas são extraídas do próprio movRows filtrando tipo_movimentacao='E' em código
    const [estRows, movRows] = await Promise.all([
      fetchEstoque(cnpj, chave, today),
      fetchMovimento(cnpj, dtIni, today, chave),
    ]);

    estoqueByBoard[board] = {};
    for (const r of estRows) {
      const cod = String(r.cod_produto || r.codproduto || '').trim();
      const qty = parseFloat((r.quantidade || '0').replace(',', '.')) || 0;
      if (!cod || qty <= 0) continue;
      if (!estoqueByBoard[board][cod])
        estoqueByBoard[board][cod] = { qty: 0, cod_barra: (r.cod_barra || r.codbarra || '').trim() };
      estoqueByBoard[board][cod].qty += qty;
    }

    giroByBoard[board] = {};
    for (const r of movRows) {
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      const cod = String(r.cod_produto || r.codproduto || '').trim();
      if (!cod) continue;

      const tipoMov = (r.tipo_movimentacao || '').trim().toUpperCase();
      const operacao = (r.operacao || '').trim().toUpperCase();
      const isEntrada = tipoMov === 'E' || ['EC','ET','EE','EN','ENT','NF','NFS'].includes(operacao);

      // Captura data de última entrada a partir dos próprios movRows
      if (isEntrada) {
        const raw = (r.data_documento || r.data_lancamento || '').slice(0, 10);
        const iso = raw && raw.includes('/')
          ? (() => { const [d,m,y] = raw.split('/'); return `${y}-${m}-${d}`; })()
          : raw;
        if (iso) {
          if (!ultCompraMap[cod] || iso > ultCompraMap[cod]) ultCompraMap[cod] = iso;
          if (!ultCompraPerBoard[board]) ultCompraPerBoard[board] = {};
          if (!ultCompraPerBoard[board][cod] || iso > ultCompraPerBoard[board][cod])
            ultCompraPerBoard[board][cod] = iso;
        }
        continue; // entradas não contam para o giro de saídas
      }

      // Pula devoluções
      if (operacao === 'DS') continue;

      const raw = (r.data_documento || r.data_lancamento || '').slice(0, 10);
      const iso = raw && raw.includes('/')
        ? (() => { const [d,m,y] = raw.split('/'); return `${y}-${m}-${d}`; })()
        : raw;

      giroByBoard[board][cod] = (giroByBoard[board][cod] || 0) + (parseInt(r.quantidade || 0) || 1);
      if (iso && (!ultVendaMap[cod] || iso > ultVendaMap[cod])) ultVendaMap[cod] = iso;
      if (!catalogMov[cod]) catalogMov[cod] = {
        descricao:    (r.descricao    || r.des_produto || '').trim(),
        desc_cor:     (r.desc_cor     || '').trim(),
        desc_tamanho: (r.desc_tamanho || '').trim(),
        setor:        (r.setor        || r.grupo       || '').trim(),
      };
    }
  })),
  ]);

  const allCods = new Set();
  for (const board of boards)
    for (const cod of Object.keys(estoqueByBoard[board])) allCods.add(cod);

  const sugestoes = [];

  for (const cod of allCods) {
    const stocks = {};
    let cod_barra = '';
    for (const board of boards) {
      const e = estoqueByBoard[board][cod];
      stocks[board] = e ? Math.floor(e.qty) : 0;
      if (e?.cod_barra && !cod_barra) cod_barra = e.cod_barra;
    }
    const giro = {};
    for (const board of boards) giro[board] = giroByBoard[board][cod] || 0;

    const lastCompraByBoard = {};
    for (const board of boards)
      lastCompraByBoard[board] = (ultCompraPerBoard[board] || {})[cod] || null;

    const calc = _calcTransfersProporcional(boards, stocks, giro, dias, lastCompraByBoard);
    if (!calc) continue;
    const { transfers, workStocks, ideal } = calc;

    const cat = catalog[cod] || {};
    const mov = catalogMov[cod] || {};
    sugestoes.push({
      cod_produto:  cod,
      cod_barra,
      referencia:   cat.referencia || '—',
      descricao:    cat.nomeBase  || mov.descricao    || '—',
      desc_cor:     cat.desc_cor  || mov.desc_cor     || '—',
      desc_tamanho: mov.desc_tamanho || '—',
      setor:        cat.setor     || mov.setor        || '—',
      marca:        cat.marca     || '—',
      linha:        '—',
      stocks,
      ideal,
      giro,
      transfers,
      stocksAfter:  workStocks,
      ultimaVenda:  ultVendaMap[cod]  || null,
      ultimaCompra: ultCompraMap[cod] || null,
    });
  }

  sugestoes.sort((a, b) => {
    const ss = (a.setor || '').localeCompare(b.setor || '', 'pt-BR');
    if (ss !== 0) return ss;
    const sm = (a.marca || '').localeCompare(b.marca || '', 'pt-BR');
    if (sm !== 0) return sm;
    return String(a.cod_produto).localeCompare(String(b.cod_produto), 'pt-BR', { numeric: true });
  });

  return { boards, dias, total: sugestoes.length, sugestoes };
}

// Aquece cache em background
async function _warmAllTrans(boards, lojas, dias) {
  const key = String(dias);
  if (_transWarmRunning[key]) return;
  const cached = _transResultCache[key];
  if (cached && Date.now() - cached.at < TRANS_RESULT_TTL) return;
  _transWarmRunning[key] = true;
  try {
    const result = await _buildTransResult(boards, lojas, dias);
    _transResultCache[key] = { result, at: Date.now() };
    console.log(`[Trans] Cacheado (${dias}d): ${result.total} sugestões`);
  } catch (e) {
    console.warn(`[Trans] warmAllTrans(${dias}d) falhou:`, e.message);
  } finally {
    _transWarmRunning[key] = false;
  }
}

// Helper para extrair firstBoard/firstCnpj/firstChave e boards válidos
function _transBoards(reqLojas) {
  const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const boards = (reqLojas
    ? reqLojas.split(',')
    : Object.keys(lojas)
  ).filter(b => lojas[b]);
  const firstBoard = boards[0];
  const firstCnpj  = firstBoard ? lojas[firstBoard].replace(/\D/g, '') : null;
  const firstChave = firstBoard
    ? (process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE)
    : null;
  return { boards, lojas, firstCnpj, firstChave };
}

// GET /api/catalog — retorna apenas status; NÃO serializa o catálogo completo (OOM).
// Para buscar entradas específicas use POST /api/catalog-codes.
// ?debug=1 → amostra bruta de LinxProdutos para diagnosticar campos de preço.
app.get('/api/catalog', requireAdmin, async (req, res) => {
  try {
    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    if (req.query.debug === '1') {
      const { fetchProdutos } = require('./services/microvix');
      const firstBoard = Object.keys(lojas)[0];
      if (!firstBoard) return res.json({ error: 'Nenhuma loja configurada' });
      const cnpj  = lojas[firstBoard].replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      const rows  = await fetchProdutos(cnpj, chave, 0);
      const sample = rows.slice(0, 3);
      return res.json({ total: rows.length, fields: sample[0] ? Object.keys(sample[0]) : [], sample });
    }
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    const size = Object.keys(catalog).length;
    // Nunca serializar o catálogo completo — pode ter 600k+ entradas e causa OOM.
    res.json({ _info: 'Use POST /api/catalog-codes com array de códigos', size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/catalog-codes — lookup pontual: aceita array de códigos, devolve só essas entradas
app.post('/api/catalog-codes', requireAdmin, async (req, res) => {
  try {
    const codes = req.body?.codes;
    if (!Array.isArray(codes) || !codes.length) return res.json({});
    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    const result = {};
    for (const c of codes) {
      const k = String(c).replace(/\.0+$/, '').trim();
      if (k && catalog[k]) result[k] = catalog[k];
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/equalizacao-dados — equalização com dados pré-extraídos pelo browser (JSON)
app.post('/api/equalizacao-dados', requireAdmin, async (req, res) => {
  try {
    const { boards, products } = req.body || {};
    if (!Array.isArray(boards) || !Array.isArray(products) || !products.length)
      return res.status(400).json({ error: 'Dados inválidos' });

    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    const catalog = await _getCatalog(lojas).catch(() => ({}));

    const sugestoes = [];
    for (const p of products) {
      const calc = _calcTransfersProporcional(boards, p.stocks || {}, p.giro || {});
      if (!calc) continue;
      const { transfers, workStocks, ideal } = calc;
      const cat = catalog[String(p.cod)] || {};
      sugestoes.push({
        cod_produto:  p.cod,
        descricao:    cat.nomeBase || p.descricao || '—',
        desc_cor:     cat.desc_cor || '—',
        desc_tamanho: cat.desc_tam || '—',
        setor:        cat.setor    || p.setor || '—',
        marca:        cat.marca    || '—',
        linha:        cat.linha    || '—',
        stocks:       p.stocks,
        ideal,
        giro:         p.giro,
        transfers,
        stocksAfter:  workStocks,
        ultimaVenda:  null,
        ultimaCompra: p.ultimaCompra || null,
      });
    }

    sugestoes.sort((a, b) => {
      const ss = (a.setor || '').localeCompare(b.setor || '', 'pt-BR');
      if (ss !== 0) return ss;
      const sm = (a.marca || '').localeCompare(b.marca || '', 'pt-BR');
      if (sm !== 0) return sm;
      return String(a.cod_produto).localeCompare(String(b.cod_produto), 'pt-BR', { numeric: true });
    });

    res.json({ boards, dias: null, total: sugestoes.length, sugestoes, source: 'excel' });
  } catch (e) {
    console.error('[Equalizacao Dados]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/equalizacao-excel — equalização via Excel importado
const _equalizacaoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/equalizacao-excel', requireAdmin, _equalizacaoUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Mapeamento de nome de empresa no Excel → board key
    function detectBoard(name) {
      const n = name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (n.includes('CONTAGEM'))           return 'contagem';
      if (n.includes('MINAS'))              return 'minas';
      if (n.includes('ESTAC') || n.includes('ESTAÇÃO') || n.match(/LJ\s*4\b/)) return 'estacao';
      if (n.includes('TOMMY'))              return 'tommy';
      if (n.includes('LEZ'))               return 'lez';
      if (n.includes('CONCEPT') || n.includes('DEL') || n.match(/LJ\s*1\b/)) return 'delrey';
      return null;
    }

    // Localiza aba com header das colunas (tem "Código" e "Descrição")
    let companies   = [];   // [{ board, vendaCol, saldoCol }]
    let headerSheetIdx = -1;
    let headerRowIdx   = -1;  // linha do header dentro da aba
    let allSheetRows   = {};  // cache das rows por aba

    console.log('[Excel] Abas encontradas:', wb.SheetNames);

    for (let i = 0; i < wb.SheetNames.length; i++) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 });
      allSheetRows[i] = rows;
      // Aceita 'Código' com ou sem acento, e 'Codigo'
      const colRowIdx = rows.findIndex(r => Array.isArray(r) &&
        r.some(c => typeof c === 'string' && c.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase() === 'codigo'));
      console.log(`[Excel] Aba ${i} "${wb.SheetNames[i]}": colRowIdx=${colRowIdx}, totalRows=${rows.length}`);
      if (colRowIdx === -1) continue;
      headerSheetIdx = i;
      headerRowIdx   = colRowIdx;
      const headerRow  = rows[colRowIdx];
      const companyRow = colRowIdx > 0 ? rows[colRowIdx - 1] : [];
      console.log('[Excel] headerRow[0..15]:', headerRow.slice(0, 15));
      console.log('[Excel] companyRow[0..15]:', companyRow.slice(0, 15));
      // Detecta índice real onde começam os pares de colunas das lojas
      const startCol = headerRow.findIndex((h, idx) =>
        idx >= 2 && typeof companyRow[idx] === 'string' && detectBoard(companyRow[idx])
      );
      const colStep = 2; // cada empresa tem 2 colunas: Vendas e Saldo
      const loopStart = startCol !== -1 ? startCol : 9;
      for (let c = loopStart; c < headerRow.length; c += colStep) {
        const raw = String(companyRow[c] || '').trim();
        if (!raw) continue;
        const board = detectBoard(raw);
        if (board) companies.push({ board, vendaCol: c, saldoCol: c + 1, label: raw });
      }
      console.log('[Excel] Lojas detectadas:', companies.map(c => `${c.label}→${c.board}(col ${c.vendaCol},${c.saldoCol})`));
      break;
    }

    if (!companies.length || headerSheetIdx === -1)
      return res.status(400).json({ error: 'Formato de Excel não reconhecido — não encontrei colunas de lojas. Veja o log do servidor.' });

    const boards = companies.map(c => c.board);

    // Lê dados: começa na mesma aba do header (logo após a linha de header),
    // e continua nas abas seguintes se houver mais de uma.
    const stocksMap  = {};  // cod → { board: qty }
    const giroMap    = {};  // cod → { board: qty }
    const catalogMap = {};  // cod → { descricao, setor, ultimaCompra }

    // Monta lista de abas e linha inicial de cada uma
    const sheetsToRead = [
      { idx: headerSheetIdx, startRow: headerRowIdx + 1 },
      ...Array.from({ length: wb.SheetNames.length - headerSheetIdx - 1 }, (_, k) => ({
        idx: headerSheetIdx + 1 + k, startRow: 0,
      })),
    ];

    let currentSetor = '';
    for (const { idx, startRow } of sheetsToRead) {
      const rows = allSheetRows[idx] ||
        XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[idx]], { header: 1 });
      for (let ri = startRow; ri < rows.length; ri++) {
        const r = rows[ri];
        if (!r || !r.length) continue;
        if (typeof r[0] === 'string' && r[0].includes('Setor')) {
          // "SetorSetor: BERMUDAS (9)" → "BERMUDAS"
          currentSetor = r[0].replace(/^SetorSetor:\s*/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
          continue;
        }
        // Ignora linha de totalização (espaços no primeiro campo)
        if (typeof r[0] !== 'number') continue;

        const cod = String(r[0]);
        if (!stocksMap[cod]) { stocksMap[cod] = {}; giroMap[cod] = {}; }

        for (const c of companies) {
          const venda = parseInt(r[c.vendaCol]) || 0;
          const saldo = parseInt(r[c.saldoCol]) || 0;
          stocksMap[cod][c.board] = (stocksMap[cod][c.board] || 0) + saldo;
          giroMap[cod][c.board]   = (giroMap[cod][c.board]   || 0) + venda;
        }

        if (!catalogMap[cod]) {
          // Col 8 = "Data Última compra" — pode vir como serial numérico do Excel,
          // string DD/MM/YYYY, ou string YYYY-MM-DD
          const rawDate = r[8];
          let ultimaCompra = null;
          if (typeof rawDate === 'number' && rawDate > 1000) {
            // Serial numérico do Excel → converte para ISO (sistema de datas 1900)
            const jsDate = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
            if (!isNaN(jsDate)) {
              ultimaCompra = jsDate.toISOString().slice(0, 10);
            }
          } else if (rawDate instanceof Date) {
            ultimaCompra = rawDate.toISOString().slice(0, 10);
          } else {
            const s = String(rawDate || '').trim();
            if (s && s !== '-') {
              // DD/MM/YYYY
              const mBR = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
              if (mBR) ultimaCompra = `${mBR[3]}-${mBR[2]}-${mBR[1]}`;
              // YYYY-MM-DD
              else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ultimaCompra = s;
            }
          }
          catalogMap[cod] = { descricao: String(r[1] || '').trim(), setor: currentSetor, ultimaCompra };
        }
      }
    }

    console.log(`[Excel] Produtos lidos da planilha: ${Object.keys(stocksMap).length}`);

    // Enriquece com catálogo Microvix (setor, marca) e aplica lógica proporcional
    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    const catalog = await _getCatalog(lojas).catch(() => ({}));

    const sugestoes = [];

    for (const [cod, stocks] of Object.entries(stocksMap)) {
      const giro = giroMap[cod] || {};
      const info = catalogMap[cod] || {};
      // Monta lastCompra por loja: usa a mesma data para todas as lojas,
      // pois a planilha só tem uma data de última compra por produto (cross-loja)
      const lastCompra = {};
      if (info.ultimaCompra) boards.forEach(b => { lastCompra[b] = info.ultimaCompra; });
      const calc = _calcTransfersProporcional(boards, stocks, giro, 90, lastCompra);
      if (!calc) continue;
      const { transfers, workStocks, ideal } = calc;

      const cat = catalog[cod] || {};
      sugestoes.push({
        cod_produto:  cod,
        descricao:    cat.nomeBase || info.descricao || '—',
        desc_cor:     cat.desc_cor || '—',
        desc_tamanho: cat.desc_tam || '—',
        setor:        cat.setor    || info.setor || '—',
        marca:        cat.marca    || '—',
        linha:        cat.linha    || '—',
        stocks,
        ideal,
        giro,
        transfers,
        stocksAfter:  workStocks,
        ultimaVenda:  null,
        ultimaCompra: info.ultimaCompra || null,
      });
    }

    sugestoes.sort((a, b) => {
      const ss = (a.setor || '').localeCompare(b.setor || '', 'pt-BR');
      if (ss !== 0) return ss;
      const sm = (a.marca || '').localeCompare(b.marca || '', 'pt-BR');
      if (sm !== 0) return sm;
      return String(a.cod_produto).localeCompare(String(b.cod_produto), 'pt-BR', { numeric: true });
    });

    const totalAnalisados = Object.keys(stocksMap).length;
    console.log(`[Excel] ${totalAnalisados} produtos analisados → ${sugestoes.length} com sugestão`);
    res.json({ boards, dias: null, total: sugestoes.length, totalAnalisados, sugestoes, source: 'excel' });
  } catch (e) {
    console.error('[Equalizacao Excel]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/transferencias/filtros — setores e marcas dos produtos com saldo no estoque atual
// Busca fetchEstoque de todas as lojas, cruza com catálogo para obter setor/marca
app.get('/api/transferencias/filtros', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const boards = Object.keys(lojas).filter(b => b !== 'site');
    if (!boards.length) return res.json({ setores: [], marcas: [] });

    const { fetchEstoque } = require('./services/microvix');
    const today = new Date().toISOString().slice(0, 10);

    // Busca saldo de todas as lojas em paralelo
    const stockRows = await Promise.all(boards.map(async b => {
      const cnpj  = (lojas[b] || '').replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      if (!cnpj) return [];
      return fetchEstoque(cnpj, chave, today).catch(() => []);
    }));

    // Coleta cod_produtos com saldo > 0
    const codsComSaldo = new Set();
    for (const rows of stockRows) {
      for (const r of rows) {
        const cod = String(r.cod_produto || r.codproduto || '').replace(/\.0+$/, '').trim();
        const qty = parseFloat((r.quantidade || '0').replace(',', '.')) || 0;
        if (cod && qty > 0) codsComSaldo.add(cod);
      }
    }

    // Cruza com catálogo para obter setor e marca
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    const setores = new Set();
    const marcas  = new Set();
    for (const cod of codsComSaldo) {
      const entry = catalog[cod] || {};
      const s = (entry.setor || '').trim();
      const m = (entry.marca || '').trim();
      if (s && s !== '—') setores.add(s);
      if (m && m !== '—') marcas.add(m);
    }

    console.log(`[Trans/filtros] ${codsComSaldo.size} produtos com saldo → ${setores.size} setores, ${marcas.size} marcas`);
    res.json({
      setores: [...setores].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      marcas:  [...marcas ].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    });
  } catch (e) {
    console.warn('[Trans/filtros]', e.message);
    res.json({ setores: [], marcas: [] });
  }
});

// GET /api/transferencias/preload — dispara aquecimento, responde imediatamente
app.get('/api/transferencias/preload', requireAdmin, (req, res) => {
  const { boards, lojas, firstCnpj, firstChave } = _transBoards(null);
  if (!boards.length) return res.json({ ok: false, error: 'Sem lojas configuradas' });
  _warmAllTrans(boards, lojas, 30, firstCnpj, firstChave);
  res.json({ ok: true, msg: 'Aquecimento iniciado em background' });
});

// GET /api/transferencias?dias=30&lojas=delrey,minas,contagem,estacao&setor=SURF
// Nunca faz chamadas Microvix — apenas lê cache ou retorna cacheLoading:true
app.get('/api/transferencias', requireAdmin, (req, res) => {
  try {
    const dias  = Math.max(1, parseInt(req.query.dias || '30'));
    const setor = (req.query.setor || '').trim();
    const marca = (req.query.marca || '').trim();
    const { boards, lojas, firstCnpj, firstChave } = _transBoards(req.query.lojas || null);
    if (!boards.length) return res.status(400).json({ error: 'Nenhuma loja configurada em MICROVIX_LOJAS' });
    _warmAllTrans(boards, lojas, dias, firstCnpj, firstChave).catch(e =>
      console.warn('[Trans] warm bg error:', e.message)
    );
    const cached = _transResultCache[String(dias)];
    if (cached && Date.now() - cached.at < TRANS_RESULT_TTL) {
      if (!setor && !marca) return res.json(cached.result);
      const setorLow = setor.toLowerCase();
      const marcaLow = marca.toLowerCase();
      const filtered = cached.result.sugestoes.filter(s => {
        const setorOk = !setor || (s.setor || '').toLowerCase().includes(setorLow);
        const marcaOk = !marca || (s.marca || '').toLowerCase().includes(marcaLow);
        return setorOk && marcaOk;
      });
      return res.json({ ...cached.result, sugestoes: filtered, total: filtered.length });
    }
    return res.json({ cacheLoading: true, msg: 'Preparando dados… tente novamente em alguns segundos.' });
  } catch (e) {
    console.error('[Trans] endpoint error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/transferencias/export — gera Excel formatado para impressão (ExcelJS)
app.post('/api/transferencias/export', requireAdmin, async (req, res) => {
  try {
    const { sugestoes = [], boards = [] } = req.body || {};
    if (!sugestoes.length) return res.status(400).json({ error: 'Sem sugestões' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas';
    wb.created = new Date();

    const today = new Date().toLocaleDateString('pt-BR');
    const BOARDS_LABEL = (() => { try { const l = JSON.parse(process.env.MICROVIX_LOJAS || '{}'); return Object.fromEntries(Object.keys(l).map(k => [k, k.charAt(0).toUpperCase() + k.slice(1)])); } catch { return {}; } })();
    const boardLabel = k => BOARDS_LABEL[k] || k;

    // cores
    const COR_HEADER_BG  = 'FF1F2937'; // cinza escuro
    const COR_HEADER_FG  = 'FFFFFFFF';
    const COR_TITLE_BG   = 'FF111827';
    const COR_ZEBRA      = 'FFF3F4F6'; // cinza claro para linhas pares
    const COR_BORDER     = 'FFD1D5DB';

    const donors = [...new Set(sugestoes.flatMap(s => s.transfers.map(t => t.de)))].sort();

    for (const donor of donors) {
      const donorLabel = boardLabel(donor);
      const destinos = [...new Set(
        sugestoes.flatMap(s => s.transfers.filter(t => t.de === donor).map(t => t.para))
      )].sort();

      const itens = sugestoes
        .map(s => { const ts = s.transfers.filter(t => t.de === donor); return ts.length ? { ...s, transfers: ts } : null; })
        .filter(Boolean);

      const ws = wb.addWorksheet(donorLabel.slice(0, 31), {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                     margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        headerFooter: { oddHeader: `&L&B${donorLabel.toUpperCase()}&R&BData: ${today}` },
      });

      const fixedDefs = [
        { header: 'Código',  key: 'cod',   width: 10 },
        { header: 'Marca',   key: 'marca',  width: 14 },
        { header: 'Ref.',    key: 'ref',    width: 12 },
        { header: 'Produto', key: 'prod',   width: 32 },
        { header: 'Cor',     key: 'cor',    width:  7 },
        { header: 'Tam.',    key: 'tam',    width:  6 },
      ];
      const destDefs = destinos.map(d => ({ header: `→ ${boardLabel(d)}`, key: d, width: 10 }));
      const totalDef = { header: 'Total', key: 'total', width: 7 };
      const allDefs  = [...fixedDefs, ...destDefs, totalDef];

      ws.columns = allDefs;

      // Linha 1: título mesclado
      ws.spliceRows(1, 0, []);
      const titleRow = ws.getRow(1);
      titleRow.getCell(1).value = `SEPARAÇÃO: ${donorLabel.toUpperCase()}  |  Data: ${today}`;
      titleRow.getCell(1).font  = { bold: true, size: 13, color: { argb: COR_HEADER_FG } };
      titleRow.getCell(1).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_TITLE_BG } };
      titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      titleRow.height = 24;
      ws.mergeCells(1, 1, 1, allDefs.length);

      // Linha 2: cabeçalho
      const hdrRow = ws.getRow(2);
      allDefs.forEach((d, i) => {
        const cell = hdrRow.getCell(i + 1);
        cell.value = d.header;
        cell.font  = { bold: true, color: { argb: COR_HEADER_FG }, size: 10 };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_HEADER_BG } };
        cell.alignment = { vertical: 'middle', horizontal: i >= fixedDefs.length ? 'center' : 'left' };
        cell.border = { bottom: { style: 'medium', color: { argb: COR_BORDER } } };
      });
      hdrRow.height = 18;

      // Congela até linha 2
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 2 }];

      // Dados
      itens.forEach((s, idx) => {
        const rowNum = idx + 3;
        const isEven = idx % 2 === 1;
        const bgColor = isEven ? COR_ZEBRA : 'FFFFFFFF';
        let total = 0;
        const qtds = destinos.map(d => { const t = s.transfers.find(t => t.para === d); return t ? t.qty : 0; });
        qtds.forEach(q => { total += q; });

        const values = [
          s.cod_produto,
          s.marca        !== '—' ? s.marca        : '',
          s.referencia   !== '—' ? s.referencia   : '',
          s.descricao    !== '—' ? s.descricao    : '',
          s.desc_cor     !== '—' ? s.desc_cor     : '',
          s.desc_tamanho !== '—' ? s.desc_tamanho : '',
          ...qtds,
          total,
        ];

        const row = ws.getRow(rowNum);
        values.forEach((v, i) => {
          const cell = row.getCell(i + 1);
          cell.value = v;
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
          cell.font  = { size: 9 };
          cell.alignment = { vertical: 'middle', horizontal: i >= fixedDefs.length ? 'center' : 'left' };
          cell.border = {
            top:    { style: 'thin', color: { argb: COR_BORDER } },
            bottom: { style: 'thin', color: { argb: COR_BORDER } },
            left:   { style: 'thin', color: { argb: COR_BORDER } },
            right:  { style: 'thin', color: { argb: COR_BORDER } },
          };
          // destaca qtd > 0 nas colunas de destino
          if (i >= fixedDefs.length && i < fixedDefs.length + destinos.length && v > 0) {
            cell.font = { bold: true, size: 9, color: { argb: 'FF1D4ED8' } };
          }
          // destaca total
          if (i === values.length - 1) {
            cell.font = { bold: true, size: 9 };
          }
        });
        row.height = 15;
      });

      // Linha de totais
      const totalRowNum = itens.length + 3;
      const totRow = ws.getRow(totalRowNum);
      const COR_TOTAL_BG = 'FF1F2937';

      // Soma por destino e grand total
      const destTotals = destinos.map(d =>
        itens.reduce((sum, s) => { const t = s.transfers.find(t => t.para === d); return sum + (t ? t.qty : 0); }, 0)
      );
      const grandTotal = destTotals.reduce((a, b) => a + b, 0);

      const totalValues = ['', '', '', 'TOTAL', '', '', ...destTotals, grandTotal];
      totalValues.forEach((v, i) => {
        const cell = totRow.getCell(i + 1);
        cell.value = v;
        cell.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_TOTAL_BG } };
        cell.alignment = { vertical: 'middle', horizontal: i >= fixedDefs.length ? 'center' : (i === 3 ? 'right' : 'left') };
        cell.border = { top: { style: 'medium', color: { argb: 'FF000000' } } };
      });
      totRow.height = 18;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="transferencias-${today.replace(/\//g,'-')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[export/trans]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/perf/export — gera Excel de Performance Mensal (uma aba por loja) (ExcelJS)
app.post('/api/perf/export', requireAdmin, async (req, res) => {
  try {
    const { stores = [] } = req.body || {};
    if (!stores.length) return res.status(400).json({ error: 'Sem dados' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas';
    wb.created = new Date();

    const today = new Date().toLocaleDateString('pt-BR');
    const hex2argb = hex => 'FF' + (hex || '#8B949E').replace('#', '').toUpperCase();

    const COR_HEADER_BG = 'FF1F2937';
    const COR_HEADER_FG = 'FFFFFFFF';
    const COR_TITLE_BG  = 'FF111827';
    const COR_ZEBRA     = 'FFF3F4F6';
    const COR_TOTAL_BG  = 'FFE5E7EB';
    const COR_BORDER    = 'FFD1D5DB';
    const COR_KPI_BG    = 'FFF9FAFB';
    const COR_POS       = 'FF15803D'; // verde
    const COR_NEG       = 'FFB91C1C'; // vermelho
    const COR_NEUTRAL   = 'FF9CA3AF';
    const COR_PROJ      = 'FFB45309'; // âmbar

    const histYears = [2022, 2023, 2024, 2025];
    const headers = ['Mês', '2022', 'Δ', '2023', 'Δ', '2024', 'Δ', '2025 (ref)', 'Δ', '2026', 'Δ 26/25', 'Δ 26/24', 'Δ 26/23', 'Δ 26/22'];
    const colWidths = [13, 11, 8, 11, 8, 11, 8, 12, 8, 12, 10, 10, 10, 10];

    const pctCell = (cell, v, bold = false) => {
      cell.value = v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
      cell.font = { size: bold ? 9 : 8, bold, color: { argb: v == null ? COR_NEUTRAL : (v >= 0 ? COR_POS : COR_NEG) } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    };

    for (const store of stores) {
      const sheetName = (store.label || store.key).slice(0, 31);
      const ws = wb.addWorksheet(sheetName, {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                     margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        headerFooter: { oddHeader: `&L&B${sheetName.toUpperCase()}&R&BData: ${today}` },
      });
      ws.properties.tabColor = { argb: hex2argb(store.color) };
      ws.columns = colWidths.map(w => ({ width: w }));

      let r = 1;

      // Título
      ws.mergeCells(r, 1, r, headers.length);
      const titleCell = ws.getCell(r, 1);
      titleCell.value = `PERFORMANCE MENSAL — ${sheetName.toUpperCase()}  |  Data: ${today}`;
      titleCell.font = { bold: true, size: 13, color: { argb: COR_HEADER_FG } };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_TITLE_BG } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
      ws.getRow(r).height = 24;
      r++;

      // KPIs
      const kpis = store.kpis || {};
      const fmtBRLs = n => n == null ? '—' : 'R$ ' + Math.round(n).toLocaleString('pt-BR');
      const fmtPcts = n => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
      const kpiRows = [
        ['Total 2025 (referência)', fmtBRLs(kpis.total25)],
        [`Acumulado ${kpis.acumuladoLabel || ''}`, fmtBRLs(kpis.acumulado)],
        ['Média últimos 3 meses', `${fmtPcts(kpis.mediaUltimos3)}${kpis.mediaDetalhe ? `  (${kpis.mediaDetalhe})` : ''}`],
        ['Projeção 2026 (ano)', `${fmtBRLs(kpis.projecaoAno)}  (${fmtPcts(kpis.pProj)} vs 2025)`],
      ];
      kpiRows.forEach(([label, value]) => {
        ws.mergeCells(r, 1, r, 4);
        ws.mergeCells(r, 5, r, headers.length);
        const lc = ws.getCell(r, 1);
        lc.value = label;
        lc.font = { bold: true, size: 9, color: { argb: 'FF374151' } };
        lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_KPI_BG } };
        lc.alignment = { vertical: 'middle' };
        const vc = ws.getCell(r, 5);
        vc.value = value;
        vc.font = { size: 9 };
        vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_KPI_BG } };
        vc.alignment = { vertical: 'middle' };
        ws.getRow(r).height = 16;
        r++;
      });
      r++; // linha em branco

      // Cabeçalho da tabela
      const headerRowNum = r;
      headers.forEach((h, i) => {
        const cell = ws.getCell(headerRowNum, i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 9, color: { argb: COR_HEADER_FG } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_HEADER_BG } };
        cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' };
        cell.border = { bottom: { style: 'medium', color: { argb: COR_BORDER } } };
      });
      ws.getRow(headerRowNum).height = 18;
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRowNum }];
      r++;

      // Linhas mensais
      (store.rows || []).forEach((row, idx) => {
        const rowNum = r;
        const bg = idx % 2 === 1 ? COR_ZEBRA : 'FFFFFFFF';
        let c = 1;

        const mesCell = ws.getCell(rowNum, c++);
        mesCell.value = row.isProj ? `${row.mes} (proj)` : row.mes;
        mesCell.font = { size: 9, italic: !!row.isProj, color: { argb: row.isProj ? COR_PROJ : 'FF111827' } };
        mesCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        mesCell.alignment = { vertical: 'middle' };

        histYears.forEach((y, j) => {
          const vCell = ws.getCell(rowNum, c++);
          vCell.value = row.h[j] == null ? '—' : Math.round(row.h[j]);
          if (row.h[j] != null) vCell.numFmt = '#,##0';
          vCell.font = { size: 9 };
          vCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
          vCell.alignment = { horizontal: 'right', vertical: 'middle' };
          const dCell = ws.getCell(rowNum, c++);
          pctCell(dCell, row.deltas[j]);
          dCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        });

        const v26Cell = ws.getCell(rowNum, c++);
        v26Cell.value = row.v26 == null ? '—' : Math.round(row.v26);
        if (row.v26 != null) v26Cell.numFmt = '#,##0';
        v26Cell.font = { size: 9, bold: true, color: { argb: row.isProj ? COR_PROJ : 'FF111827' } };
        v26Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        v26Cell.alignment = { horizontal: 'right', vertical: 'middle' };

        [row.d2625, row.d2624, row.d2623, row.d2622].forEach(d => {
          const dCell = ws.getCell(rowNum, c++);
          pctCell(dCell, d);
          dCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        });

        ws.getRow(rowNum).height = 15;
        ws.getRow(rowNum).eachCell(cell => {
          cell.border = { left: { style: 'thin', color: { argb: COR_BORDER } }, right: { style: 'thin', color: { argb: COR_BORDER } } };
        });
        r++;
      });

      // Linha de totais
      const totRowNum = r;
      const tot = store.totals || {};
      let c = 1;
      const totMesCell = ws.getCell(totRowNum, c++);
      totMesCell.value = 'TOTAL';
      histYears.forEach((y, j) => {
        const vCell = ws.getCell(totRowNum, c++);
        vCell.value = Math.round(tot[y] || 0);
        vCell.numFmt = '#,##0';
        vCell.alignment = { horizontal: 'right', vertical: 'middle' };
        const dCell = ws.getCell(totRowNum, c++);
        pctCell(dCell, (tot.totDeltas || [])[j], true);
      });
      const v26TotCell = ws.getCell(totRowNum, c++);
      v26TotCell.value = Math.round(tot.v26 || 0);
      v26TotCell.numFmt = '#,##0';
      v26TotCell.alignment = { horizontal: 'right', vertical: 'middle' };
      [tot.tot2625, tot.tot2624, tot.tot2623, tot.tot2622].forEach(d => {
        const dCell = ws.getCell(totRowNum, c++);
        pctCell(dCell, d, true);
      });
      ws.getRow(totRowNum).eachCell(cell => {
        cell.font = cell.font ? { ...cell.font, bold: true } : { bold: true, size: 9 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_TOTAL_BG } };
        cell.border = { top: { style: 'medium', color: { argb: 'FF000000' } } };
      });
      ws.getRow(totRowNum).getCell(1).font = { bold: true, size: 9, color: { argb: 'FF111827' } };
      ws.getRow(totRowNum).height = 18;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="performance-surfers-${today.replace(/\//g,'-')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[export/perf]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CADASTRO DE PRODUTO ─────────────────────────────────────────────────

// Marcas extraídas do catálogo de produtos (LinxProdutos, já funciona)
app.get('/api/cadastro-produto/marcas-microvix', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    const seen = new Set();
    const list = [];
    for (const entry of Object.values(catalog)) {
      const m = (entry.marca || '').trim();
      if (m && !seen.has(m)) { seen.add(m); list.push({ cod: m, nome: m }); }
    }
    list.sort((a, b) => a.nome.localeCompare(b.nome));
    res.json(list);
  } catch (e) {
    console.warn('[CadastroProduto/marcas-microvix]', e.message);
    res.json([]);
  }
});

// Fornecedores: tenta LinxFornecedor → LinxFornecedores → fallback MongoDB
app.get('/api/cadastro-produto/fornecedores-microvix', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = Object.values(lojas)[0] || '';
    const chave = process.env.MICROVIX_CHAVE;
    if (cnpj) {
      const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
      const isBadResponse = raw => raw.includes('<ResponseSuccess>False') || raw.includes('Ocorreu um erro') || raw.trim().startsWith('<');
      for (const cmd of ['LinxFornecedor', 'LinxFornecedores']) {
        try {
          const raw = await postRequest(buildRequest(cmd, cnpj, [], chave), 20_000);
          if (isBadResponse(raw)) continue;
          const rows = parseCsv(raw);
          if (!rows.length) continue;
          console.log(`[CadastroProduto/fornecedores] cmd=${cmd} campos:`, Object.keys(rows[0]));
          const vals = Object.values(rows[0]);
          const list = rows.map(r => {
            const keys = Object.keys(r);
            const cod  = ['cod_fornecedor','id_fornecedor','codigo','cod','id'].map(k => (r[k]||'').trim()).find(v=>v) || (vals[0]||'').trim();
            const nome = ['razao_social','nome_fornecedor','fantasia','nome','descricao'].map(k => (r[k]||'').trim()).find(v=>v) || (Object.values(r)[1]||'').trim();
            return { cod, nome };
          }).filter(f => f.cod && f.nome);
          if (list.length) return res.json(list);
        } catch { continue; }
      }
    }
    // Fallback: perfis de fornecedor cadastrados no MongoDB
    const docs = await mongoDb.collection('supplier_profiles').find({}).sort({ name: 1 }).toArray();
    res.json(docs.map(d => ({ cod: String(d._id), nome: d.name })));
  } catch (e) {
    console.warn('[CadastroProduto/fornecedores-microvix]', e.message);
    res.json([]);
  }
});

// Coleções: não há comando confiável no Microvix — retorna [] e o front usa texto livre
app.get('/api/cadastro-produto/colecoes-microvix', requireAdmin, async (req, res) => {
  res.json([]);
});

app.get('/api/cadastro-produto/debug-mx', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = Object.values(lojas)[0] || '';
    const chave = process.env.MICROVIX_CHAVE;
    if (!cnpj) return res.json({ error: 'MICROVIX_LOJAS não configurado' });
    const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
    const cmd = req.query.cmd || 'LinxFornecedores';
    const body = buildRequest(cmd, cnpj, [], chave);
    const raw  = await postRequest(body, 30_000);
    const rows = parseCsv(raw);
    res.json({ cmd, rawHead: raw.slice(0, 500), fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 5) });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/cadastro-produto/fornecedores', requireAdmin, async (req, res) => {
  try { res.json(await mongoDb.collection('supplier_profiles').find({}).sort({ name: 1 }).toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cadastro-produto/fornecedores', requireAdmin, async (req, res) => {
  try {
    const { _id, name, mapping, defaults } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const col = mongoDb.collection('supplier_profiles');
    if (_id) {
      const { ObjectId } = require('mongodb');
      const oid = new ObjectId(_id);
      await col.updateOne({ _id: oid }, { $set: { name, mapping: mapping || {}, defaults: defaults || {}, updatedAt: new Date() } });
      res.json(await col.findOne({ _id: oid }));
    } else {
      const doc = { name, mapping: mapping || {}, defaults: defaults || {}, createdAt: new Date() };
      const r = await col.insertOne(doc);
      res.json({ ...doc, _id: r.insertedId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cadastro-produto/fornecedores/:id', requireAdmin, async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    await mongoDb.collection('supplier_profiles').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const _cadPdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/cadastro-produto/parse-pdf', requireAdmin, _cadPdfUpload.single('file'), async (req, res) => {
  try {
    let pdfParse;
    try { pdfParse = require('pdf-parse'); }
    catch { return res.status(500).json({ error: 'Módulo pdf-parse não instalado. Use planilha Excel por enquanto.' }); }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const data  = await pdfParse(req.file.buffer);
    const lines = data.text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 300);
    res.json({ headers: ['texto_original'], rows: lines.map(l => [l]), pages: data.numpages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista de setores e cores únicos do catálogo Microvix (para popular dropdowns no frontend)
app.get('/api/cadastro-produto/catalogo-opts', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const [catalog, idx] = await Promise.all([
      Promise.race([_getCatalog(lojas), new Promise(r => setTimeout(() => r({}), 10_000))]).catch(() => ({})),
      Promise.race([_getRefColorIndex(), new Promise(r => setTimeout(() => r(null), 10_000))]).catch(() => null),
    ]);
    const setores = [...new Set(Object.values(catalog).map(e => e.setor).filter(Boolean))].sort();
    const cores   = idx ? [...new Set(Object.values(idx).flat())].sort() : [];
    res.json({ setores, cores });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cadastro-produto/check', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows deve ser array' });

    // Carrega índice ref→cores e catálogo completo (para fallback de cores por ref)
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const [idx, catalog] = await Promise.all([
      Promise.race([_getRefColorIndex(), new Promise(r => setTimeout(() => r(null), 15_000))]).catch(() => null),
      Promise.race([_getCatalog(lojas),  new Promise(r => setTimeout(() => r({}),  15_000))]).catch(() => ({})),
    ]);

    if (!idx || !Object.keys(idx).length) {
      return res.json({
        result: rows.map(r => ({ ...r, _status: 'new' })),
        newCount: rows.length, existingCount: 0, needsMappingCount: 0,
        _catalogNotReady: true,
      });
    }

    const norm = s => (s || '').toString().replace(/\.0+$/, '').trim().toUpperCase();

    // Fallback: coleta cores registradas no catálogo completo para uma dada ref
    const coresDosCatalogo = (refNorm) => {
      const cors = new Set();
      for (const e of Object.values(catalog)) {
        if (norm(e.referencia || '') === refNorm && e.desc_cor) cors.add(norm(e.desc_cor));
      }
      return [...cors].sort();
    };

    // Retorna a cor conhecida mais longa que seja prefixo do candidato.
    // Strip de separadores iniciais: "-014" → "014"; "28CASA" → match "28".
    const matchColor = (candidate, corsDisponiveis) => {
      if (!candidate || !corsDisponiveis.length) return null;
      const c = candidate.replace(/^[-_\s\.\/]+/, '');
      if (!c) return null;
      if (corsDisponiveis.includes(c)) return c;
      const byLen = [...corsDisponiveis].sort((a, b) => b.length - a.length);
      for (const col of byLen) {
        if (col.length >= 2 && c.startsWith(col)) return col;
      }
      return null;
    };

    // Encontra ref+cor num código combinado.
    // 1. Tenta corte no separador explícito: "911545-014" → ref="911545", cor="014"
    // 2. Prefixo sem separador: "VN00066XY28CASA" → ref="VN00066XY", cor="28CASA"
    const parseCombined = (fullStr) => {
      const sepPositions = [...fullStr.matchAll(/[-_\/\s]/g)].map(m => m.index);
      for (const pos of sepPositions) {
        const refPart = fullStr.slice(0, pos);
        if (refPart.length >= 3 && idx[refPart])
          return { ref: refPart, extractedCor: fullStr.slice(pos + 1) };
      }
      for (let len = fullStr.length - 1; len >= 3; len--) {
        const candidate = fullStr.slice(0, len);
        if (idx[candidate]) return { ref: candidate, extractedCor: fullStr.slice(len) };
      }
      return null;
    };

    const result = rows.map(r => {
      const ref = norm(r.referencia || '');
      const cor = norm(r.desc_cor   || '');

      // Lookup direto de ref
      if (ref && idx[ref]) {
        let corsDisponiveis = idx[ref];
        // Fallback: se o índice tem a ref mas sem cores, busca no catálogo completo
        if (!corsDisponiveis.length) corsDisponiveis = coresDosCatalogo(ref);
        if (!cor) return { ...r, _status: 'existing', _corsDisponiveis: corsDisponiveis, _corMatch: null };
        const corMatch = matchColor(cor, corsDisponiveis);
        return { ...r, _status: corMatch ? 'existing' : 'needs_cor', _corsDisponiveis: corsDisponiveis, _corMatch: corMatch };
      }

      // Ref não encontrada diretamente → tenta split por prefixo
      // (ex: "VN00066XY28CASA" → ref="VN00066XY", cor candidata="28CASA")
      // (ex: "911545-014" com cor="014" → ref="911545", usa cor da coluna separada)
      if (ref) {
        const parsed = parseCombined(ref);
        if (parsed) {
          const corsDisponiveis = idx[parsed.ref];
          const corToMatch = cor || parsed.extractedCor;
          const corMatch = matchColor(corToMatch, corsDisponiveis);
          return {
            ...r,
            _status:          corMatch ? 'existing' : 'needs_cor',
            _corsDisponiveis: corsDisponiveis,
            _corMatch:        corMatch,
            _parsedRef:       parsed.ref,
            _parsedCor:       parsed.extractedCor,
          };
        }
      }

      return { ...r, _status: 'new' };
    });

    res.json({
      result,
      newCount:          result.filter(r => r._status === 'new').length,
      existingCount:     result.filter(r => r._status === 'existing').length,
      needsMappingCount: result.filter(r => r._status === 'needs_cor').length,
      _idxRefs:          Object.keys(idx).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI fuzzy match de referências do fornecedor contra catálogo Microvix ──────
app.post('/api/cadastro-produto/ai-match', requireAdmin, async (req, res) => {
  try {
    const { refs } = req.body;
    if (!Array.isArray(refs) || !refs.length) return res.status(400).json({ error: 'refs deve ser array não vazio' });
    // Aceita tanto strings simples quanto objetos { ref, desc }
    const refItems = refs.map(r => typeof r === 'string' ? { ref: r, desc: '' } : r);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');

    const [idx, catalog] = await Promise.all([
      Promise.race([_getRefColorIndex(), new Promise(r => setTimeout(() => r(null), 15_000))]).catch(() => null),
      Promise.race([_getCatalog(lojas),  new Promise(r => setTimeout(() => r({}),  15_000))]).catch(() => ({})),
    ]);

    if (!idx || !Object.keys(idx).length) {
      return res.json({ matches: refItems.map(r => ({ supplierRef: r.ref, suggestedRef: null, error: 'catálogo não disponível' })) });
    }

    const catalogRefs = Object.keys(idx);
    const norm = s => (s || '').toString().replace(/\.0+$/, '').trim().toUpperCase();

    // String similarity: Jaro-Winkler simplificado + bonus de prefixo
    function similarity(a, b) {
      a = norm(a); b = norm(b);
      if (!a || !b) return 0;
      if (a === b) return 1;
      const maxDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
      if (maxDist < 0) return 0;
      const aMatches = new Array(a.length).fill(false);
      const bMatches = new Array(b.length).fill(false);
      let matches = 0, transpositions = 0;
      for (let i = 0; i < a.length; i++) {
        const start = Math.max(0, i - maxDist);
        const end   = Math.min(i + maxDist + 1, b.length);
        for (let j = start; j < end; j++) {
          if (bMatches[j] || a[i] !== b[j]) continue;
          aMatches[i] = bMatches[j] = true;
          matches++;
          break;
        }
      }
      if (!matches) return 0;
      let k = 0;
      for (let i = 0; i < a.length; i++) {
        if (!aMatches[i]) continue;
        while (!bMatches[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
      }
      const jaro = (matches/a.length + matches/b.length + (matches - transpositions/2)/matches) / 3;
      // Winkler prefix bonus
      let prefix = 0;
      for (let i = 0; i < Math.min(4, a.length, b.length); i++) { if (a[i] === b[i]) prefix++; else break; }
      return jaro + prefix * 0.1 * (1 - jaro);
    }

    // Para cada ref do fornecedor, seleciona os top 15 candidatos do catálogo
    function topCandidates(supplierRef, n = 15) {
      const sn = norm(supplierRef);
      return catalogRefs
        .map(r => ({ r, s: similarity(sn, r) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, n)
        .filter(x => x.s > 0.3)
        .map(x => x.r);
    }

    // Processa em batches de 20 refs por chamada Claude
    const BATCH = 20;
    const results = [];

    for (let i = 0; i < refItems.length; i += BATCH) {
      const batch = refItems.slice(i, i + BATCH);
      const batchData = batch.map(item => {
        const refNorm  = norm(item.ref);
        const descNorm = norm(item.desc || '');
        // Candidatos da ref + candidatos da descrição (para casos como Converse onde a ref vem na desc)
        const candFromRef  = topCandidates(refNorm);
        const candFromDesc = descNorm ? topCandidates(descNorm) : [];
        const candidates   = [...new Set([...candFromRef, ...candFromDesc])].slice(0, 20);
        return { ref: refNorm, desc: descNorm || undefined, candidates };
      });

      // Log para debug
      console.log('[AI Match] batchData:', JSON.stringify(batchData.map(b => ({ ref: b.ref, desc: b.desc, nCandidates: b.candidates.length, topCand: b.candidates.slice(0,3) })), null, 2));

      // Numera os itens para matching por índice (robusto contra variações de string)
      const numberedData = batchData.map((item, idx) => ({ idx, ...item }));

      // Setores disponíveis para sugestão
      const setoresDisp = [...new Set(Object.values(catalog).map(e => e.setor).filter(Boolean))].sort();

      const prompt = `Você recebe uma lista numerada de produtos de fornecedor, cada um com campo "ref" e/ou "desc", e uma lista de candidatos do catálogo Microvix.
A referência pode estar em "ref" ou embutida em "desc" (ex: pedidos Converse onde a ref fica na descrição).
A referência pode também estar combinada com a cor no mesmo campo (ex: "VN0A5KQZBA2" onde "VN0A5KQZ" é a ref e "BA2" é a cor).
Identifique o candidato que melhor corresponde a cada produto.

Além do match de referência, sugira o SETOR baseado na descrição do produto.
Setores disponíveis no catálogo: ${setoresDisp.join(', ') || 'Calçados, Vestuário, Acessórios'}

Responda SOMENTE com um array JSON, um objeto por produto, NA MESMA ORDEM da entrada, sem texto adicional:
[{"idx":0,"match":"REF_CATALOGO_OU_NULL","source":"ref","setor":"Calçados"},{"idx":1,"match":null,"source":"ref","setor":"Vestuário"},...]

Regras:
- "match": código exato do catálogo que melhor corresponde, ou null se nenhum serve
- "source": "ref" se achou pela ref, "desc" se achou pela descrição
- "setor": setor mais adequado para o produto baseado na descrição; use um dos setores da lista acima ou null se não conseguir determinar
- Mantenha a ordem e quantidade exata dos itens de entrada

Dados:
${JSON.stringify(numberedData, null, 2)}`;

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '';
      console.log('[AI Match] resposta Claude completa:', text);

      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('sem JSON array na resposta: ' + text.slice(0, 200));
        const parsed = JSON.parse(jsonMatch[0]);
        for (const m of parsed) {
          const bd = batchData[m.idx ?? parsed.indexOf(m)];
          results.push({ supplierRef: bd?.ref ?? '', suggestedRef: m.match || null, source: m.source || 'ref', aiSetor: m.setor || null });
        }
      } catch (parseErr) {
        console.warn('[AI Match] parse error:', parseErr.message, '| texto:', text.slice(0, 300));
        for (const bd of batchData) {
          results.push({ supplierRef: bd.ref, suggestedRef: null, error: 'parse error' });
        }
      }
    }

    // Enriquece com setor e cores do catálogo para a ref sugerida
    const normCat = s => (s || '').toString().replace(/\.0+$/, '').trim().toUpperCase();

    // Índice case-insensitive ref → {setor, ncm} para cobrir diferenças de casing entre
    // _buildCatalog (sem toUpperCase) e _buildRefColorIndex (com toUpperCase)
    const refMeta = {};
    for (const [key, entry] of Object.entries(catalog)) {
      const k = normCat(key);
      if (!refMeta[k]) refMeta[k] = { setor: entry.setor || '', ncm: entry.ncm || '' };
      // também indexa pelo campo referencia dentro do entry (para entries keyed by cod)
      if (entry.referencia) {
        const kr = normCat(entry.referencia);
        if (!refMeta[kr]) refMeta[kr] = { setor: entry.setor || '', ncm: entry.ncm || '' };
        else {
          if (!refMeta[kr].setor && entry.setor) refMeta[kr].setor = entry.setor;
          if (!refMeta[kr].ncm   && entry.ncm)   refMeta[kr].ncm   = entry.ncm;
        }
      }
    }

    const ordered = refItems.map((item, i) => {
      const r = results[i] || { supplierRef: item.ref, suggestedRef: null };
      if (r.suggestedRef) {
        const meta = refMeta[normCat(r.suggestedRef)] || {};
        r.catalogSetor = meta.setor || r.aiSetor || null;
        r.catalogNcm   = meta.ncm   || null;
        r.catalogCores = idx[r.suggestedRef] || idx[normCat(r.suggestedRef)] || [];
      } else if (r.aiSetor) {
        r.catalogSetor = r.aiSetor;
      }
      return r;
    });

    res.json({ matches: ordered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Força rebuild do índice ref→cores
app.post('/api/catalog/rebuild-refcolor', requireAdmin, async (req, res) => {
  _refColorIndex = null; _refColorIdxAt = 0; _refColorIdxPromise = null;
  _buildRefColorIndex().catch(e => console.warn('[RefColor rebuild]', e.message));
  res.json({ ok: true, message: 'Rebuild iniciado em background' });
});

app.post('/api/cadastro-produto/ai-suggest', requireAdmin, (req, res, next) => {
  _cadPdfUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: `Upload error: ${err.message}` });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const { default: Anthropic } = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    let rawContent = '';

    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      rawContent = data.text;
    } else {
      const XLSX = require('xlsx');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      rawContent = rows.slice(0, 200).map(r => r.join('\t')).join('\n');
    }

    if (rawContent.length > 24000) rawContent = rawContent.slice(0, 24000) + '\n[... truncado ...]';

    const systemPrompt = `Você é um assistente especializado em cadastro de produtos para o sistema Microvix de uma loja de surf/streetwear.
Analise o arquivo do fornecedor e extraia TODOS os produtos/SKUs.

REGRAS DE SETOR (aplicar sempre):
- Camiseta, T-Shirt, Tshirt, Camiseta Regular, Camiseta Oversized → "TS Basica"
- Regata → "Regata"
- Calçados, Tênis, Tenis, Sandália, Bota, Sneaker → "Calçados"
- Boné, Bone, Cap → "Acessórios"
- Short, Shorts → "Shorts"
- Calça, Jeans, Denim → "Calças"
- Moletom, Agasalho → "Moletom"
- Cinto → "Acessórios"
- Outros → "Moda"

REGRAS POR FORNECEDOR:

VANS (Excel - colunas: Categoria, Descrição do modelo, Codigo Global/Sku, CodProduto, PDV, CUSTO, Grade):
- Referência: campo CodProduto
- O campo "Codigo Global/Sku" contém ref+cor+sufixo concatenados: ex "VN00066XY28CASA" → ref=VN00066X, cor=Y28, CASA=descartar (sempre 4 letras maiúsculas no fim)
- Nome: Descrição do modelo
- Tamanho: Grade — "AA03" vira "U"; "1/39;2/40;2/41;1/42" = gerar 1 SKU por tamanho (separados por ;, formato qtd/tam)
- Custo: coluna CUSTO (número direto, ex: 90.9)
- Preço venda: coluna PDV

OAKLEY (Excel - colunas: MATERIAL, PRODUTO, COR, TAM BR, DESC COR, PDV, CUSTO NF, CATEGORIA, NCM, EAN):
- Referência: MATERIAL
- Nome: PRODUTO
- Cor código: COR; Cor nome: DESC COR
- Tamanho: TAM BR (número BR)
- Custo: CUSTO NF (já com impostos)
- Preço venda: PDV (remover "R$" se necessário)
- Setor: CATEGORIA
- NCM: NCM; EAN: EAN

NEW ERA (Excel - colunas: Produto, Cor, Nome Cor, Descrição, Tamanho, custo, Preço de Varejo, Classif. Fiscal (NCM), Código de Barra):
- Referência: Produto
- Nome: Descrição
- Cor código: Cor; Cor nome: Nome Cor
- Tamanho: Tamanho (U, 7 1/4, 7 3/8...)
- Custo: custo (arredondar para 2 casas — pode vir como float sujo tipo 107.66000000000001)
- Preço venda: Preço de Varejo
- NCM: Classif. Fiscal (NCM); EAN: Código de Barra

MCD / OUTSIDE CO (PDF - Proposta de Venda da Outside Co):
- Produto: linha com formato "CÓDIGO - NOME" (ex: "12722844X - CAMISETA OVERSIZED MCD DOURADO")
- Cor: linha seguinte "Cor: BBB - BRANCO" (código - nome)
- Grade: colunas G1/G2/G3 (oversized), P/M/G/GG (regular), 38/40/42... (calças) — gerar 1 SKU por tamanho
- Custo: coluna Unitário *** APLICAR DESCONTO 13%: custo_real = unitario × 0.87 ***
- Preço venda: não disponível — retornar null

CONVERSE (PDF - Pedido de Venda Converse/Cooper Shoes):
- Linha de produto: "CÓDIGO NOME_COM_COR" (ex: "CT00010002 CHUCK TAYLOR ALL STAR PRETO/CRU/PRETO")
- A cor está embutida no nome (última parte após o modelo base)
- Grade de tamanhos: linha "33|34|35|36|37|38" com quantidades na linha seguinte — gerar 1 SKU por tamanho
- Custo: campo GRADE PREÇO ou PREÇO (ex: R$ 126,80)
- Preço venda: campo PREÇO SUGERIDO
- Setor: Calçados

FORMATO DE SAÍDA — retorne APENAS JSON válido, sem texto extra:
{
  "fornecedor": "nome do fornecedor detectado",
  "produtos": [
    {
      "referencia": "código",
      "nome": "descrição sem cor",
      "cor": "nome da cor em PT (ex: PRETO, MARINHO)",
      "cod_cor": "código se houver (ex: 01K)",
      "tamanho": "tamanho (ex: 38, M, U, 7 1/4)",
      "setor": "setor normalizado",
      "custo": 0.00,
      "preco_venda": 0.00,
      "ncm": "NCM ou null",
      "ean": "EAN ou null"
    }
  ]
}`;

    // Envia apenas cabeçalhos + 5 amostras para a IA mapear colunas (rápido)
    const headers = rawContent.split('\n')[0].split('\t');
    const sampleRows = rawContent.split('\n').slice(1, 6);
    const tablePreview = [headers.join(' | '), ...sampleRows.map(r => r.split('\t').join(' | '))].join('\n');

    const mapPrompt = `Você recebe os cabeçalhos e amostras de uma planilha de pedido de fornecedor.
Mapeie cada coluna para o campo Microvix correto.

Cabeçalhos: ${JSON.stringify(headers)}

Amostra:
${tablePreview}

Campos Microvix:
- "referencia": código de referência/SKU do produto
- "nome": nome ou descrição do produto
- "cod_barra": código de barras EAN
- "desc_marca": marca
- "desc_setor": setor/departamento/categoria
- "desc_cor": cor (nome)
- "cod_cor": código da cor
- "desc_tamanho": tamanho/grade
- "preco_custo": preço de custo
- "preco_venda": preço de venda

Responda SOMENTE com JSON, sem texto extra. Use null se não houver coluna correspondente:
{"referencia":"nome_exato_coluna","nome":"nome_exato_coluna","cod_barra":null,...}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: mapPrompt }],
    });

    let txt = response.content[0]?.text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) txt = m[0];

    let rawMap;
    try { rawMap = JSON.parse(txt.trim()); }
    catch (e) { return res.status(500).json({ error: `IA retornou JSON inválido: ${e.message}` }); }

    // Filtra apenas colunas que existem de fato na planilha
    const mapping = {};
    for (const [key, col] of Object.entries(rawMap)) {
      if (col && headers.includes(col)) mapping[key] = col;
    }

    res.json({ mapping, headers, totalRows: rawContent.split('\n').length - 1 });
  } catch (e) {
    console.error('[AI Suggest]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cadastro-produto/export', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Nenhum produto para exportar' });
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Produtos');

    // Colunas na ordem exata do template de importação do Microvix
    const COLS = [
      { header: 'Código',                                   key: 'codigo',         width: 12 },
      { header: 'Descrição',                                key: 'descricao',      width: 50 },
      { header: 'Referência',                               key: 'referencia',     width: 22 },
      { header: 'Cód. Auxiliar',                            key: 'cod_auxiliar',   width: 18 },
      { header: 'Fornecedor',                               key: 'fornecedor',     width: 22 },
      { header: 'Fornecedor exclusivo',                     key: 'forn_excl',      width: 20 },
      { header: 'Comprador',                                key: 'comprador',      width: 16 },
      { header: 'Empresa',                                  key: 'empresa',        width: 16 },
      { header: 'Contabiliza saldo em estoque',             key: 'contabiliza',    width: 28 },
      { header: 'Indisponível para venda',                  key: 'indisponivel',   width: 24 },
      { header: 'Setor',                                    key: 'setor',          width: 22 },
      { header: 'Linha',                                    key: 'linha',          width: 14 },
      { header: 'Marca',                                    key: 'marca',          width: 18 },
      { header: 'Coleção',                                  key: 'colecao',        width: 14 },
      { header: 'Espessura',                                key: 'espessura',      width: 12 },
      { header: 'Classificação',                            key: 'classificacao',  width: 16 },
      { header: 'Tamanho',                                  key: 'tamanho',        width: 14 },
      { header: 'Cores',                                    key: 'cores',          width: 18 },
      { header: 'Unidade de venda',                         key: 'unidade',        width: 16 },
      { header: 'Múltiplo de venda',                        key: 'multiplo',       width: 16 },
      { header: 'Moeda',                                    key: 'moeda',          width: 10 },
      { header: 'Custo com ICMS (R$)',                      key: 'custo_icms',     width: 18 },
      { header: 'Desconto (%)',                             key: 'desconto',       width: 14 },
      { header: 'Acréscimo (%)',                            key: 'acrescimo',      width: 14 },
      { header: 'IPI (%)',                                  key: 'ipi',            width: 10 },
      { header: 'Frete (R$)',                               key: 'frete',          width: 12 },
      { header: 'Despesas acessórias (R$)',                 key: 'desp_acess',     width: 22 },
      { header: 'Substituição tributária (R$)',             key: 'subst_trib',     width: 24 },
      { header: 'Diferencial ICMS (R$)',                    key: 'dif_icms',       width: 20 },
      { header: 'Mark-up (%)',                              key: 'markup',         width: 12 },
      { header: 'Preço de venda R$',                        key: 'preco_venda',    width: 16 },
      { header: 'Permite desconto',                         key: 'perm_desc',      width: 16 },
      { header: 'Comissão %',                               key: 'comissao',       width: 12 },
      { header: 'Configuração tributária',                  key: 'conf_trib',      width: 22 },
      { header: 'NCM',                                      key: 'ncm',            width: 14 },
      { header: 'CEST',                                     key: 'cest',           width: 10 },
      { header: 'Produto supérfluo',                        key: 'superfluo',      width: 18 },
      { header: 'Tipo de item',                             key: 'tipo_item',      width: 26 },
      { header: 'Origem da mercadoria',                     key: 'origem',         width: 20 },
      { header: 'Regime de Incidência PIS e COFINS',        key: 'pis_cofins',     width: 32 },
      { header: 'Produto é brinde',                         key: 'brinde',         width: 16 },
      { header: 'Produto de catálogo',                      key: 'catalogo',       width: 18 },
      { header: 'Descrição de catálogo',                    key: 'desc_catalogo',  width: 22 },
      { header: 'Disponível na loja virtual',               key: 'loja_virtual',   width: 24 },
      { header: 'Exige controle',                           key: 'exige_ctrl',     width: 16 },
      { header: 'Tipo de controle',                         key: 'tipo_ctrl',      width: 22 },
      { header: 'Tamanho controle',                         key: 'tam_ctrl',       width: 18 },
      { header: 'Peso bruto (kg)',                          key: 'peso_bruto',     width: 14 },
      { header: 'Peso líquido (kg)',                        key: 'peso_liq',       width: 14 },
      { header: 'Descrição complementar?',                  key: 'desc_compl',     width: 22 },
      { header: 'Altura (frete)',                           key: 'alt_frete',      width: 14 },
      { header: 'Largura (frete)',                          key: 'larg_frete',     width: 14 },
      { header: 'Comprimento (frete)',                      key: 'comp_frete',     width: 18 },
      { header: 'Altura',                                   key: 'altura',         width: 10 },
      { header: 'Largura',                                  key: 'largura',        width: 10 },
      { header: 'Comprimento',                              key: 'comprimento',    width: 14 },
      { header: 'Importado por balança',                    key: 'balanca_imp',    width: 20 },
      { header: 'Produto vendido por (balança)',            key: 'balanca_vnd',    width: 26 },
      { header: 'Quantidade mínima',                        key: 'qtd_min',        width: 16 },
      { header: 'Quantidade máxima',                        key: 'qtd_max',        width: 16 },
      { header: 'Quantidade compra',                        key: 'qtd_compra',     width: 16 },
      { header: 'Localização',                              key: 'localizacao',    width: 14 },
      { header: 'Observação',                               key: 'observacao',     width: 16 },
      { header: 'Código de barras',                         key: 'cod_barra',      width: 22 },
      { header: 'Características',                          key: 'caracterist',    width: 18 },
      { header: 'Status',                                   key: 'status',         width: 10 },
      { header: 'Descricao Completa (B2C)',                 key: 'b2c_desc',       width: 22 },
      { header: 'Descricao Garantia (B2C)',                 key: 'b2c_garantia',   width: 22 },
      { header: 'Tags (B2C)',                               key: 'b2c_tags',       width: 14 },
      { header: 'Flags (B2C)',                              key: 'b2c_flags',      width: 14 },
      { header: 'Palavras Chave (B2C)',                     key: 'b2c_kw',         width: 18 },
      { header: 'Canais (B2C)',                             key: 'b2c_canais',     width: 14 },
      { header: 'Url Vídeo (B2C)',                          key: 'b2c_video',      width: 16 },
      { header: 'Código Integracao OMS',                    key: 'oms',            width: 22 },
      { header: 'Produto Desativado',                       key: 'desativado',     width: 18 },
      { header: 'Bloqueia atualização de preço franqueadora', key: 'bloqueia_preco', width: 36 },
    ];

    ws.columns = COLS;
    ws.getRow(1).eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(1).height = 30;

    rows.forEach(r => {
      ws.addRow({
        codigo:        '',
        descricao:     r.nome        || '',
        referencia:    r.referencia  || '',
        cod_auxiliar:  '',
        fornecedor:    r.fornecedor  || '',
        forn_excl:     '',
        comprador:     '',
        empresa:       '',
        contabiliza:   'Não',
        indisponivel:  'Não',
        setor:         r.desc_setor  || '',
        linha:         r.linha       || '',
        marca:         '',
        colecao:       r.colecao     || '',
        espessura:     '',
        classificacao: '',
        tamanho:       r.desc_tamanho || '',
        cores:         r.desc_cor    || '',
        unidade:       'UN',
        multiplo:      '1',
        moeda:         '',
        custo_icms:    (() => { const s = String(r.preco_custo||'').trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g,'').replace(',','.') : s); return isNaN(v) || v === 0 ? '' : v.toFixed(2).replace('.',','); })(),
        desconto:      '',
        acrescimo:     '',
        ipi:           '',
        frete:         '',
        desp_acess:    '',
        subst_trib:    '',
        dif_icms:      '',
        markup:        r.markup      || '',
        preco_venda:   (() => { const s = String(r.preco_venda||'').trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g,'').replace(',','.') : s); return isNaN(v) || v === 0 ? '' : v.toFixed(2).replace('.',','); })(),
        perm_desc:     'Sim',
        comissao:      '',
        conf_trib:     '',
        ncm:           r.ncm         || '',
        cest:          '',
        superfluo:     'Não',
        tipo_item:     'Mercadoria para Revenda',
        origem:        '',
        pis_cofins:    '',
        brinde:        'Não',
        catalogo:      '',
        desc_catalogo: '',
        loja_virtual:  '',
        exige_ctrl:    '',
        tipo_ctrl:     '',
        tam_ctrl:      '',
        peso_bruto:    '',
        peso_liq:      '',
        desc_compl:    '',
        alt_frete:     '',
        larg_frete:    '',
        comp_frete:    '',
        altura:        '',
        largura:       '',
        comprimento:   '',
        balanca_imp:   '',
        balanca_vnd:   '',
        qtd_min:       '',
        qtd_max:       '',
        qtd_compra:    '',
        localizacao:   '',
        observacao:    '',
        cod_barra:     '',
        caracterist:   '',
        status:        0,
        b2c_desc:      '',
        b2c_garantia:  '',
        b2c_tags:      '',
        b2c_flags:     '',
        b2c_kw:        '',
        b2c_canais:    '',
        b2c_video:     '',
        oms:           '',
        desativado:    '',
        bloqueia_preco: '',
      });
    });

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=cadastro_microvix_${date}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[CadastroProduto/export]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Diferencial de alíquota de ICMS (compras interestaduais) ──────────────
// Duas entradas: o "Relatório de Notas de Compra" do Microvix, que diz o que
// deu entrada no sistema, e os XMLs da tela ENTRADA NF-E, que trazem a base de
// cálculo por alíquota. Só o que consta no relatório vira imposto.
// Folgado de propósito: dá para subir o ano inteiro de uma vez e depois só
// trocar a competência, já que o corte é pela data de lançamento.
const _icmsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024, files: 40 },
});

app.get('/api/icms/empresas', requireEscritorioOrAdmin, (req, res) => {
  const { EMPRESAS, formatarCnpj } = require('./services/empresas');
  res.json(EMPRESAS.map(e => ({
    cnpj: e.cnpj,
    cnpjFormatado: formatarCnpj(e.cnpj),
    apelido: e.apelido,
    razaoSocial: e.razaoSocial,
    aba: e.aba,
    ativa: e.ativa,
  })));
});

app.post('/api/icms/apurar', requireEscritorioOrAdmin,
  _icmsUpload.fields([
    { name: 'relatorio', maxCount: 12 },
    { name: 'xmls', maxCount: 28 },
    { name: 'contabilidade', maxCount: 4 },
  ]),
  async (req, res) => {
    try {
      const { parseRelatorio } = require('./services/notasCompraReport');
      const { calcularPorEmpresa } = require('./services/difal');
      const { cnpjsDoGrupo } = require('./services/empresas');
      const { lerXmlsDoZip } = require('./services/zipReader');

      const relatorios = (req.files && req.files.relatorio) || [];
      const pacotes = (req.files && req.files.xmls) || [];
      if (!relatorios.length) return res.status(400).json({ error: 'Envie o Relatório de Notas de Compra' });
      if (!pacotes.length) return res.status(400).json({ error: 'Envie o zip com os XMLs' });

      const lancamentos = [];
      const periodos = [];
      for (const f of relatorios) {
        const r = parseRelatorio(f.buffer.toString('utf8'));
        lancamentos.push(...r.notas);
        if (r.periodo) periodos.push(r.periodo);
      }

      const notas = [];
      for (const f of pacotes) {
        if (/\.xml$/i.test(f.originalname)) notas.push({ xml: f.buffer.toString('utf8') });
        else notas.push(...lerXmlsDoZip(f.buffer));
      }

      // Notas de competências anteriores que tinham XML mas ainda não tinham
      // lançamento. O XML delas não pode mais ser baixado (a extração do
      // Microvix só vai a 30 dias), então elas voltam daqui já calculadas.
      const transitoSvc = require('./services/icmsTransito');
      const transito = await transitoSvc.buscar(mongoDb, { cnpjs: cnpjsDoGrupo() });
      // Notas já conferidas e marcadas como recusadas: não voltam para a fila
      // nem cobram conferência de novo, mesmo com o XML ainda no lote.
      const recusadas = await transitoSvc.chavesRecusadas(mongoDb);
      // Notas empurradas à mão para outra competência: chave → mês de destino.
      const adiadas = await transitoSvc.adiamentos(mongoDb);

      const resultado = calcularPorEmpresa(notas, {
        lancamentos,
        transito,
        recusadas,
        adiadas,
        cnpjsProprios: cnpjsDoGrupo(),
        competencia: req.body.competencia || null,
      });

      // Nota já apurada antes não pode entrar de novo — senão o imposto é pago
      // duas vezes. Vem desmarcada e sinalizada com a competência anterior.
      const { buscarApuradas } = require('./services/icmsHistorico');
      const chaves = resultado.empresas.flatMap(e => e.linhas.map(l => l.chave)).filter(Boolean);
      const apuradas = await buscarApuradas(mongoDb, chaves);

      const competencia = req.body.competencia || null;

      // Ajustes manuais entram antes da marcação de duplicidade, para que uma
      // nota incluída à mão também seja travada contra reapuração.
      if (competencia) {
        const ajustesSvc = require('./services/icmsAjustes');
        const { recalcularLinha, recalcularTotais } = require('./services/difal');
        const ajustes = await ajustesSvc.listar(mongoDb, { competencia });
        if (ajustes.length) {
          ajustesSvc.aplicar(resultado, ajustes, l => recalcularLinha(l));
          recalcularTotais(resultado);
        }
      }

      let duplicadas = 0;
      for (const emp of resultado.empresas) {
        for (const l of emp.linhas) {
          const anterior = l.chave && apuradas[l.chave];
          if (!anterior) { l.selecionada = l.incluida; continue; }

          // Reapurar o mesmo mês depois de finalizar não é duplicidade: é a
          // mesma apuração sendo revista. A nota continua marcada, para o
          // resultado poder ser conferido e exportado de novo.
          const mesmaCompetencia = !!competencia && anterior.competencia === competencia;
          l.jaApurada = {
            competencia: anterior.competencia,
            em: anterior.apuradaEm,
            mesmaCompetencia,
          };
          l.selecionada = mesmaCompetencia ? l.incluida : false;
          if (l.incluida && !mesmaCompetencia) duplicadas++;
        }
      }

      // Confronto com a planilha da contabilidade, se ela veio no upload.
      let conferencia = null;
      const arqContabilidade = (req.files && req.files.contabilidade) || [];
      if (arqContabilidade.length) {
        const { parseRecomposicao, conferir } = require('./services/recomposicaoContabilidade');
        const notasContabilidade = { competencias: [], notas: [] };
        for (const f of arqContabilidade) {
          const lido = parseRecomposicao(f.buffer);
          notasContabilidade.competencias.push(...lido.competencias);
          notasContabilidade.notas.push(...lido.notas);
        }
        conferencia = conferir(resultado, notasContabilidade, { competencia });
        conferencia.competenciasNoArquivo = [...new Set(notasContabilidade.competencias)];
      }

      // Guarda as notas que apareceram no XML mas ainda não têm entrada. É o
      // que permite baixar cada XML uma vez só, no mês da emissão: quando o
      // lançamento chegar na competência seguinte, a nota volta calculada.
      const { linhasEmTransito } = require('./services/difal');
      const emTransito = linhasEmTransito(resultado);
      let guardadas = 0;
      if (emTransito.length) {
        try {
          const r = await transitoSvc.guardar(mongoDb, {
            competencia,
            linhas: emTransito,
            usuario: req.session.user?.name || req.session.user?.login || null,
          });
          guardadas = r.guardadas;
        } catch (e) {
          // Não guardar o trânsito não invalida a apuração que está na tela.
          console.error('[icms/apurar] falha ao guardar trânsito:', e.message);
        }
      }

      // As pendências são montadas depois da marcação de duplicidade, para o
      // "já computada em" entrar junto.
      const { montarPendencias } = require('./services/difal');

      res.json({
        conferencia,
        transito: {
          guardadas,
          emTransito: emTransito.length,
          recuperadas: resultado.empresas
            .reduce((s, e) => s + e.linhas.filter(l => l.doTransito).length, 0),
        },
        competencia: req.body.competencia || null,
        periodos,
        duplicadas,
        pendencias: montarPendencias(resultado),
        lidos: { relatorios: relatorios.length, xmls: notas.length, lancamentos: lancamentos.length },
        ...resultado,
      });
    } catch (e) {
      console.error('[icms/apurar]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

app.post('/api/icms/exportar', requireEscritorioOrAdmin, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { gerarXlsx } = require('./services/difalExport');
    const { resultado, competencia } = req.body || {};
    if (!resultado || !resultado.empresas) return res.status(400).json({ error: 'Nada para exportar' });

    const buf = await gerarXlsx(resultado, { competencia });
    const nome = `ICMS-diferencial-${(competencia || '').replace('/', '-') || 'apuracao'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[icms/exportar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Refaz a planilha de uma competência já finalizada, a partir do que ficou
// gravado. É a conferência tardia: meses depois, sem os arquivos de origem.
// O que o histórico não guarda — itens com ST, notas que ficaram de fora, as
// marcações de conferir — não volta, e a planilha diz isso em vez de sair com
// as seções vazias como se não tivesse havido nenhuma.
app.get('/api/icms/exportar-historico', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { notasDaCompetencia } = require('./services/icmsHistorico');
    const { recalcularLinha, recalcularTotais } = require('./services/difal');
    const { gerarXlsx } = require('./services/difalExport');
    const { buscarEmpresa } = require('./services/empresas');

    const { cnpj, competencia } = req.query;
    const docs = await notasDaCompetencia(mongoDb, { cnpj, competencia });
    if (!docs.length) return res.status(404).json({ error: 'Nenhuma nota gravada nessa competência' });

    const cadastro = buscarEmpresa(cnpj);
    const empresa = cadastro ? cadastro.razaoSocial : cnpj;

    const linhas = docs.map(d => recalcularLinha({
      chave: d._id,
      doc: d.doc,
      nNF: d.nNF,
      serie: d.serie,
      dhEmi: d.dhEmi,
      dtLancamento: d.dtLancamento,
      natOp: d.natOp || '',
      fornecedor: d.fornecedor,
      ufOrigem: d.ufOrigem,
      cnpjEmpresa: d.cnpj,
      empresa,
      vlrTotal: d.vlrTotal || 0,
      base4: d.base4 || 0,
      base12: d.base12 || 0,
      incluida: true,
      motivo: '',
      itensST: [],
      itensFora: [],
      revisar: [],
      atencao: [],
    }));

    const resultado = recalcularTotais({
      empresas: [{ cnpj, empresa, linhas, itensST: [] }],
      totalGeral: 0,
    });

    const buf = await gerarXlsx(resultado, {
      competencia: `${competencia.slice(5)}/${competencia.slice(0, 4)}`,
      origem: 'historico',
    });
    const nome = `ICMS-diferencial-${competencia}-${cadastro ? cadastro.apelido : cnpj}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome.replace(/[^\w.-]/g, '_')}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[icms/exportar-historico]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Finaliza a competência: grava as notas selecionadas no histórico. A partir
// daí elas ficam travadas contra reapuração em qualquer outro período.
app.post('/api/icms/finalizar', requireEscritorioOrAdmin, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { finalizar } = require('./services/icmsHistorico');
    const { competencia, cnpj, empresa, linhas } = req.body || {};
    if (!competencia || !cnpj) return res.status(400).json({ error: 'Informe a competência e o CNPJ' });
    if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma nota selecionada' });

    const semChave = linhas.filter(l => !l.chave);
    if (semChave.length) {
      return res.status(400).json({
        error: `${semChave.length} nota(s) sem chave de NF-e. Sem a chave não dá para travar contra duplicidade.`,
      });
    }

    const r = await finalizar(mongoDb, {
      competencia, cnpj, empresa, linhas,
      usuario: req.session.user?.name || req.session.user?.login || null,
    });

    // Nota que entrou numa apuração não está mais em trânsito.
    try {
      await require('./services/icmsTransito').consumir(mongoDb, linhas.map(l => l.chave));
    } catch (e) {
      console.error('[icms/finalizar] falha ao limpar trânsito:', e.message);
    }

    res.json(r);
  } catch (e) {
    console.error('[icms/finalizar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Trânsito entre competências ───────────────────────────────────────────
// Nota recusada e devolvida ao fornecedor nunca vai ter lançamento. Marcar
// isso a tira da fila sem apagar o registro — apagar faria ela voltar na
// próxima vez que o mês da emissão fosse reapurado.
app.post('/api/icms/transito/recusar', requireEscritorioOrAdmin, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { recusar } = require('./services/icmsTransito');
    const { chave, linha, motivo } = req.body || {};
    const r = await recusar(mongoDb, {
      chave,
      linha,
      motivo,
      usuario: req.session.user?.name || req.session.user?.login || null,
    });
    res.json(r);
  } catch (e) {
    console.error('[icms/transito/recusar]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/icms/transito/reativar', requireEscritorioOrAdmin, express.json(), async (req, res) => {
  try {
    const { reativar } = require('./services/icmsTransito');
    const r = await reativar(mongoDb, (req.body || {}).chave);
    res.json(r);
  } catch (e) {
    console.error('[icms/transito/reativar]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Empurra uma nota já lançada para a competência seguinte. Existe para quando a
// contabilidade lançou em outro mês e não vai corrigir — desmarcar a nota na
// tela não guardaria nada, e o imposto dela sumiria dos dois meses.
app.post('/api/icms/transito/adiar', requireEscritorioOrAdmin, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { adiar } = require('./services/icmsTransito');
    const { chave, linha, competencia, motivo } = req.body || {};
    if (!linha || linha.incluida === false) {
      return res.status(400).json({ error: 'Só dá para adiar nota que está entrando na conta desta competência' });
    }
    const r = await adiar(mongoDb, {
      chave, linha, competencia, motivo,
      usuario: req.session.user?.name || req.session.user?.login || null,
    });
    res.json(r);
  } catch (e) {
    console.error('[icms/transito/adiar]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/icms/transito/cancelar-adiamento', requireEscritorioOrAdmin, express.json(), async (req, res) => {
  try {
    const { cancelarAdiamento } = require('./services/icmsTransito');
    res.json(await cancelarAdiamento(mongoDb, (req.body || {}).chave));
  } catch (e) {
    console.error('[icms/transito/cancelar-adiamento]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/icms/transito', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { listar } = require('./services/icmsTransito');
    res.json(await listar(mongoDb, { cnpj: req.query.cnpj || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Ajustes manuais ───────────────────────────────────────────────────────
// Editar a base de uma nota, incluir nota sem XML, ou tirar nota da conta.
// Cada ajuste guarda o valor anterior e quem fez.
app.get('/api/icms/ajustes', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { listar } = require('./services/icmsAjustes');
    res.json(await listar(mongoDb, { cnpj: req.query.cnpj || null, competencia: req.query.competencia || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/icms/ajustes', requireEscritorioOrAdmin, express.json(), async (req, res) => {
  try {
    const { salvar } = require('./services/icmsAjustes');
    const r = await salvar(mongoDb, {
      ...req.body,
      por: req.session.user?.name || req.session.user?.login || null,
    });
    res.json(r);
  } catch (e) {
    console.error('[icms/ajustes]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/icms/ajustes/:id', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { remover } = require('./services/icmsAjustes');
    res.json(await remover(mongoDb, req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estorno: libera as notas de uma competência para reapuração.
app.post('/api/icms/estornar', requireEscritorioOrAdmin, express.json(), async (req, res) => {
  try {
    const { estornar } = require('./services/icmsHistorico');
    const { competencia, cnpj } = req.body || {};
    if (!competencia || !cnpj) return res.status(400).json({ error: 'Informe a competência e o CNPJ' });
    res.json(await estornar(mongoDb, { competencia, cnpj }));
  } catch (e) {
    console.error('[icms/estornar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resumo consolidado por CNPJ num intervalo de datas livre, com participação
// por alíquota e alíquota efetiva sobre a base comprada.
app.get('/api/icms/resumo', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { resumo } = require('./services/icmsHistorico');
    const { buscarEmpresa, formatarCnpj } = require('./services/empresas');
    const r = await resumo(mongoDb, {
      de: req.query.de || null,
      ate: req.query.ate || null,
      cnpj: req.query.cnpj || null,
    });
    r.empresas = r.empresas.map(e => {
      const cad = buscarEmpresa(e.cnpj);
      return { ...e, apelido: cad ? cad.apelido : e.cnpj, cnpjFormatado: formatarCnpj(e.cnpj) };
    });
    res.json(r);
  } catch (e) {
    console.error('[icms/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/icms/apuracoes', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { listarApuracoes } = require('./services/icmsHistorico');
    res.json(await listarApuracoes(mongoDb, { cnpj: req.query.cnpj || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Global error handler (captura erros de multer e outros middlewares) ────
app.use((err, req, res, next) => {
  const msg = err?.message || String(err) || 'Erro interno';
  console.error('[Express Error]', req.method, req.path, err?.code || '', msg);
  if (res.headersSent) return next(err);
  res.status(err?.status || err?.statusCode || 500).json({ error: msg });
});

// ── Lista da Vez (Indeva) ─────────────────────────────────────────────────
const INDEVA_STORES = ['delrey','minas','contagem','estacao','tommy'];

function todayBRT() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function getIndevaStore(db, board) {
  if (!db.indeva) db.indeva = {};
  const today = todayBRT();
  if (!db.indeva[board]) {
    db.indeva[board] = { fila: [], atendendo: [], atendimentos: [], multiAtend: {}, date: today, historico: {} };
  } else if (db.indeva[board].date !== today) {
    const s = db.indeva[board];
    if (!s.historico) s.historico = {};
    if (s.atendimentos?.length > 0) {
      s.historico[s.date] = { date: s.date, atendimentos: s.atendimentos };
    }
    s.fila = [];
    s.atendendo = [];
    s.atendimentos = [];
    s.multiAtend = {};
    s.date = today;
  }
  const s = db.indeva[board];
  if (!Array.isArray(s.atendendo)) s.atendendo = s.atendendo != null ? [s.atendendo] : [];
  if (!s.historico) s.historico = {};
  if (!s.multiAtend) s.multiAtend = {};
  return s;
}

app.get('/api/indeva/:board', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/indeva/:board/entrar', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const { empId } = req.body;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const id = parseInt(empId);
    if (!store.fila.includes(id)) store.fila.push(id);
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/indeva/:board/sair', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const { empId } = req.body;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const rid = parseInt(empId);
    store.fila = store.fila.filter(x => x !== rid);
    store.atendendo = store.atendendo.filter(x => x !== rid);
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/indeva/:board/historico', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    await writeDB(db);
    res.json(store.historico || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/indeva/:board/atender', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const { empId } = req.body;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const id = parseInt(empId);
    if (!store.atendendo.includes(id)) store.atendendo.push(id);
    store.fila = store.fila.filter(x => x !== id);
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/indeva/:board/mais-um', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const { empId } = req.body;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const id = parseInt(empId);
    if (!store.atendendo.includes(id)) return res.status(400).json({ error: 'Vendedor não está em atendimento' });
    store.multiAtend[id] = (store.multiAtend[id] || 1) + 1;
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/indeva/:board/atendimento', requireAuth, async (req, res) => {
  try {
    const { board } = req.params;
    const { empId, vendeu, motivo } = req.body;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const id = parseInt(empId);
    const emp = (db.employees || []).find(e => e.id === id);
    const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    store.atendimentos.push({
      id: nextId(db),
      empId: id,
      nome: emp?.apelido || emp?.name || '—',
      hora,
      vendeu: !!vendeu,
      motivo: vendeu ? null : (motivo || null)
    });
    const multiCur = store.multiAtend[id] || 1;
    if (multiCur > 1) {
      store.multiAtend[id] = multiCur - 1;
    } else {
      delete store.multiAtend[id];
      store.atendendo = store.atendendo.filter(x => x !== id);
      store.fila = store.fila.filter(x => x !== id);
      store.fila.push(id);
    }
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/indeva-stats/:year/:month', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.params;
    const prefix = `${year}-${String(month).padStart(2,'0')}-`;
    const db = await readDB();
    const result = {};
    const today = todayBRT();

    for (const board of INDEVA_STORES) {
      const store = db.indeva?.[board];
      if (!store) continue;
      const daily = {};

      // Historical days in this month
      for (const [date, dayData] of Object.entries(store.historico || {})) {
        if (!date.startsWith(prefix)) continue;
        if (!daily[date]) daily[date] = {};
        for (const a of (dayData.atendimentos || [])) {
          const key = String(a.empId);
          if (!daily[date][key]) daily[date][key] = { total: 0, conv: 0 };
          daily[date][key].total++;
          if (a.vendeu) daily[date][key].conv++;
        }
      }

      // Today (if in this month)
      if (store.date?.startsWith(prefix)) {
        if (!daily[store.date]) daily[store.date] = {};
        for (const a of (store.atendimentos || [])) {
          const key = String(a.empId);
          if (!daily[store.date][key]) daily[store.date][key] = { total: 0, conv: 0 };
          daily[store.date][key].total++;
          if (a.vendeu) daily[store.date][key].conv++;
        }
      }

      // Aggregate monthly
      const monthly = {};
      for (const dayStats of Object.values(daily)) {
        for (const [key, s] of Object.entries(dayStats)) {
          if (!monthly[key]) monthly[key] = { total: 0, conv: 0 };
          monthly[key].total += s.total;
          monthly[key].conv  += s.conv;
        }
      }

      result[board] = { daily, monthly };
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/indeva/:board/atendimento/:id', requireAuth, async (req, res) => {
  try {
    const { board, id } = req.params;
    if (!INDEVA_STORES.includes(board)) return res.status(400).json({ error: 'Loja inválida' });
    const user = req.session.user;
    if (user.board && user.board !== 'escritorio' && user.board !== board)
      return res.status(403).json({ error: 'Sem acesso' });
    const db = await readDB();
    const store = getIndevaStore(db, board);
    const atId = parseInt(id);
    const before = store.atendimentos.length;
    store.atendimentos = store.atendimentos.filter(a => a.id !== atId);
    if (store.atendimentos.length === before) return res.status(404).json({ error: 'Atendimento não encontrado' });
    await writeDB(db);
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/indeva', (req, res) => res.sendFile(path.join(__dirname, 'public/indeva.html')));

// ── Contas a Pagar — LinxFaturas ──────────────────────────────────────────

// Busca todas as faturas de uma loja via LinxFaturas com paginação por timestamp
// Busca faturas do LinxFaturas normalizando página a página para não acumular linhas brutas.
// onRow(rawRow) é chamado por cada linha — permite filtrar antes de acumular.
async function _fetchFaturas(cnpj, chave, dtIni, dtFin, onRow) {
  const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
  const useCallback = typeof onRow === 'function';
  const all = useCallback ? null : [];
  let ts = 0;
  for (let page = 0; page < 20; page++) {
    const params = [
      { id: 'data_inicial', valor: dtIni },
      { id: 'data_fim',     valor: dtFin },
      { id: 'timestamp',    valor: String(ts) },
    ];
    const body = buildRequest('LinxFaturas', cnpj, params, chave);
    const raw  = await postRequest(body, 60_000);
    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
      const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro Microvix';
      throw new Error(msg);
    }
    if (raw.trim().startsWith('<')) throw new Error('Resposta XML inesperada: ' + raw.slice(0, 200));
    const rows = parseCsv(raw);
    if (!rows.length) break;
    let maxTs = 0;
    for (const r of rows) {
      const rts = parseInt(r.timestamp) || 0;
      if (rts > maxTs) maxTs = rts;
      if (useCallback) onRow(r);
      else all.push(r);
    }
    if (rows.length < 5000) break;
    if (maxTs <= ts) break;
    ts = maxTs;
    // rows sai de escopo aqui — GC pode coletar as linhas brutas desta página
  }
  return all; // null quando useCallback=true
}

// Normaliza linha do LinxFaturas para formato interno
function _normalizeFatura(r, loja, board, hoje) {
  const get = k => String(r[k] ?? '').trim();

  if (get('excluido') === '1' || get('cancelado') === '1') return null;

  const receber_pagar = get('receber_pagar').toUpperCase();
  const isPagar       = receber_pagar === 'P';

  const vencimento = _parseMxDate(get('data_vencimento'));
  const emissao    = _parseMxDate(get('data_emissao'));
  const baixa      = _parseMxDate(get('data_baixa'));

  const parseBRL = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  const valorFatura    = parseBRL(get('valor_fatura'));
  const valorPago      = parseBRL(get('valor_pago'));
  const valorDesconto  = parseBRL(get('valor_desconto'));
  const valorJuros     = parseBRL(get('valor_juros'));
  const valorAbatimento= parseBRL(get('valor_abatimento'));
  const valorMulta     = parseBRL(get('valor_multa'));
  const valorLiquido   = Math.max(0, valorFatura - valorDesconto - valorAbatimento + valorJuros + valorMulta);

  let status = 'aberto';
  if (baixa) status = 'pago';
  else if (valorPago > 0 && valorPago >= valorFatura) status = 'pago';
  else if (vencimento && vencimento < hoje) status = 'vencido';

  const ordemParcela = get('ordem_parcela');
  const qtdeParcelas = get('qtde_parcelas');
  const parcela      = ordemParcela && qtdeParcelas ? `${ordemParcela}/${qtdeParcelas}` : (ordemParcela || '');

  return {
    board, loja,
    fornecedor:    get('nome_cliente'),
    codigo_fatura: get('codigo_fatura'),
    documento:     get('documento'),
    serie:         get('serie'),
    nosso_numero:  get('nsu_host') || get('banco_autorizacao_garantidora') || get('NSU'),
    parcela,
    historico:     get('observacao'),
    emissao,
    vencimento,
    baixa,
    valor:         valorFatura,
    valorLiquido,
    valorPago,
    valorDesconto,
    valorJuros,
    valorAbatimento,
    valorMulta,
    status,
    isPagar,
    forma_pgto:    get('forma_pgto'),
    centrocusto:   get('centrocusto'),
  };
}

function _parseMxDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  // DD/MM/YYYY (com ou sem horário: "28/05/2026 00:00:00")
  let m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // YYYY-MM-DD (com ou sem horário ISO)
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

// ── GET /api/contas-pagar — serve dados do cache ──────────────────────────
app.get('/api/contas-pagar', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dtIni = req.query.de  || today;
    const dtFin = req.query.ate || today;
    const cp    = await readContasPagar(dtIni, dtFin);
    const items = (cp.rows || []).sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''));
    res.json({ items, errors: [], dtIni, dtFin, syncedAt: cp.syncedAt || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contas-pagar/raw — diagnóstico LinxFaturas (mostra campos retornados)
app.get('/api/contas-pagar/raw', requireAdmin, async (req, res) => {
  try {
    const { board, de, ate } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board] || Object.values(lojas)[0];
    const chave = process.env[`MICROVIX_CHAVE_${(board||'').toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const dtIni = de  || today.slice(0, 7) + '-01';
    const dtFin = ate || today;

    try {
      const rows = await _fetchFaturas(cnpj, chave, dtIni, dtFin);
      const pagar   = rows.filter(r => String(r.receber_pagar || '').toUpperCase() === 'P');
      const receber = rows.filter(r => String(r.receber_pagar || '').toUpperCase() === 'R');
      const fields  = rows[0] ? Object.keys(rows[0]) : [];
      const sample  = rows.slice(0, 2);
      res.json({
        board: board || Object.keys(lojas)[0],
        cnpj: cnpj?.replace(/\d(?=\d{3})/g, '*'),
        dtIni, dtFin,
        results: [{
          label: 'LinxFaturas',
          rowCount: rows.length,
          pagarCount: pagar.length,
          receberCount: receber.length,
          fields,
          sample,
          isErr: false,
        }],
      });
    } catch (e) {
      res.json({
        board: board || Object.keys(lojas)[0],
        cnpj: cnpj?.replace(/\d(?=\d{3})/g, '*'),
        dtIni, dtFin,
        results: [{ label: 'LinxFaturas', isErr: true, errMsg: e.message, rawSnippet: e.message, rowCount: 0, fields: [] }],
      });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/contas-pagar', (req, res) => res.sendFile(path.join(__dirname, 'public/contas-pagar.html')));

// ── POST /api/contas-pagar/sync — busca faturas via LinxFaturas ───────────
app.post('/api/contas-pagar/sync', requireAdmin, async (req, res) => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const dtIni  = '2020-01-01'; // cobre parcelamentos longos (ex: Simples Nacional 111x)
    const dtFin  = req.body?.ate || today;
    const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const boards = Object.entries(lojas);
    const errors = [];
    let   total  = 0;
    const fallbackRows = []; // usado só sem MongoDB

    for (const [board, cnpj] of boards) {
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      try {
        const rows = [];
        // Callback normaliza na hora — linhas brutas nunca acumulam em memória
        await _fetchFaturas(cnpj, chave, dtIni, dtFin, r => {
          const fat = _normalizeFatura(r, board, board, today);
          if (fat && fat.isPagar) rows.push(fat);
        });
        total += rows.length;
        if (mongoDb) {
          await writeContasPagarBoard(board, rows);
        } else {
          fallbackRows.push(...rows);
        }
        console.log(`[contasPagar/sync] ${board}: ${rows.length} faturas`);
      } catch (e) {
        errors.push({ board, error: e.message });
        console.warn(`[contasPagar/sync] ${board}: ${e.message}`);
      }
    }

    const syncedAt = new Date().toISOString();
    await writeContasPagarMeta({ syncedAt, dtIni, dtFin, errors });

    if (!mongoDb) {
      const db = await readDB();
      db.contasPagar = { rows: fallbackRows, syncedAt, dtIni, dtFin, errors };
      await writeDB(db);
    }

    res.json({ ok: true, count: total, syncedAt, errors });
  } catch (e) {
    console.error('[contasPagar/sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/contas-pagar/status ──────────────────────────────────────────
app.get('/api/contas-pagar/status', requireAdmin, async (req, res) => {
  try {
    if (mongoDb) {
      const [meta, count] = await Promise.all([
        mongoDb.collection('cpMeta').findOne({ _id: 'main' }),
        mongoDb.collection('cpFaturas').countDocuments(),
      ]);
      const { _id, ...m } = meta || {};
      res.json({ syncedAt: m.syncedAt || null, count, dtIni: m.dtIni, dtFin: m.dtFin, errors: m.errors || [] });
    } else {
      const cp = await readContasPagar();
      res.json({ syncedAt: cp.syncedAt || null, count: (cp.rows || []).length, dtIni: cp.dtIni, dtFin: cp.dtFin, errors: cp.errors || [] });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Folha de Pagamento ─────────────────────────────────────────────────────

app.get('/folha',  (req, res) => res.sendFile(path.join(__dirname, 'public/folha.html')));
app.get('/marcas', (req, res) => res.sendFile(path.join(__dirname, 'public/marcas.html')));
app.get('/icms',   requireEscritorioOrAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public/icms.html')));

// GET /api/folha/config — configurações por loja (faixas de meta, GM, DSR, prêmios)
app.get('/api/folha/config', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.folhaConfig || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/folha/config — salva configurações por loja
app.post('/api/folha/config', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    db.folhaConfig = req.body;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/folha/empconfig — configuração individual por funcionário (comissões, fixo, descontos)
app.get('/api/folha/empconfig', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.folhaEmpConfig || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/folha/debug-premiacao/:year/:month — diagnóstico de premiação semanal
app.get('/api/folha/debug-premiacao/:year/:month', requireAdmin, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const db    = await readDB();
    const weeklyMetasMonth = (db.weeklyMetas || {})[mk] || {};
    const employees = (db.employees || []).filter(e => !e.inativo);
    const vsalesAll = db.vsales || {};
    const todayStr   = new Date().toISOString().slice(0, 10);
    const lastDay    = new Date(year, month, 0);
    const padD       = n => String(n).padStart(2,'0');
    const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
    const lastDayStr = `${year}-${padD(month)}-${padD(lastDay.getDate())}`;

    // Generate allWeekStarts (same logic as folha endpoint)
    const allWeekStarts = new Set();
    const msDate = new Date(monthStart + 'T12:00:00');
    const firstSunday = new Date(msDate);
    firstSunday.setDate(msDate.getDate() - msDate.getDay());
    for (let d = new Date(firstSunday); ; d.setDate(d.getDate() + 7)) {
      const ws = `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
      if (ws > lastDayStr) break;
      const weEndD2 = new Date(d); weEndD2.setDate(weEndD2.getDate() + 6);
      const weEnd2 = `${weEndD2.getFullYear()}-${padD(weEndD2.getMonth()+1)}-${padD(weEndD2.getDate())}`;
      if (weEnd2 >= monthStart && weEnd2 <= lastDayStr) allWeekStarts.add(ws);
    }

    const semanas = [];
    for (const weekStart of allWeekStarts) {
      const wsDate = new Date(weekStart + 'T12:00:00');
      const weDate = new Date(wsDate); weDate.setDate(weDate.getDate() + 6);
      const weStr = `${weDate.getFullYear()}-${padD(weDate.getMonth()+1)}-${padD(weDate.getDate())}`;
      const skipped = weStr > lastDayStr || weStr >= todayStr;
      const hasMeta = weeklyMetasMonth[weekStart] && Object.keys(weeklyMetasMonth[weekStart]).length > 0;
      const weekData = weeklyMetasMonth[weekStart] || {};

      // Build ausencia days map for debug
      const ausenciasAll = db.ausencias || [];
      const _normNameDbg = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
      const ausenciaDiasMapDbg = {};
      for (const emp of employees) {
        const empNorm = _normNameDbg(emp.apelido || emp.name);
        const empAus  = ausenciasAll.filter(a =>
          ['ferias','atestado'].includes(a.tipo) &&
          _normNameDbg(a.colaborador) === empNorm &&
          a.dataFim >= monthStart && a.dataInicio <= lastDayStr
        );
        if (!empAus.length) continue;
        const days = new Set();
        for (const a of empAus) {
          const cur = new Date(a.dataInicio + 'T12:00:00');
          const fim = new Date(a.dataFim    + 'T12:00:00');
          while (cur <= fim) {
            const ds = cur.toISOString().slice(0,10);
            if (ds >= monthStart && ds <= lastDayStr) days.add(ds);
            cur.setDate(cur.getDate() + 1);
          }
        }
        if (days.size > 0) ausenciaDiasMapDbg[emp.id] = [...days].sort();
      }

      const empsDetalhes = employees.map(emp => {
        const vsEmp = vsalesAll[`${mk}-${emp.board}-${emp.id}`] || {};
        const vacSet = new Set(vsEmp.meta?.vacationDays || []);
        const ausenciaDias = new Set(ausenciaDiasMapDbg[emp.id] || []);
        let effectiveAdmissao = emp.admissao || null;
        if (!effectiveAdmissao) {
          const allEntryDates = Object.keys(vsEmp.entries || {})
            .filter(d => d >= monthStart && d <= lastDayStr).sort();
          if (allEntryDates.length > 0) effectiveAdmissao = allEntryDates[0];
        }
        const diasAvaliados = [];
        const d = new Date(weekStart + 'T12:00:00');
        const end = new Date(weStr + 'T12:00:00');
        let trabInteira = true;
        let motivoFalha = null;
        while (d <= end) {
          const ds = `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
          if (ds >= monthStart && ds <= lastDayStr) {
            let bloqueio = null;
            if (vacSet.has(ds)) bloqueio = 'férias (Part%)';
            else if (ausenciaDias.has(ds)) bloqueio = 'férias/atestado (calendário)';
            else if (effectiveAdmissao && ds < effectiveAdmissao) bloqueio = `antes admissão (${effectiveAdmissao})`;
            else if (emp.desligamento && ds > emp.desligamento) bloqueio = `após desligamento (${emp.desligamento})`;
            if (bloqueio && trabInteira) { trabInteira = false; motivoFalha = `${ds}: ${bloqueio}`; }
            diasAvaliados.push({ ds, bloqueio });
          }
          d.setDate(d.getDate() + 1);
        }
        const we2 = Object.entries(vsEmp.entries||{}).filter(([d]) => d>=weekStart && d<=weStr);
        const empSales = we2.reduce((s,[,e]) => s+(e.value||0), 0);
        const mMeta = weekData[emp.id]?.meta || 0;
        const mMensal = vsEmp.meta?.mensal || 0;
        return {
          id: emp.id, name: emp.name, cargo: emp.cargo, board: emp.board,
          admissao: emp.admissao || null,
          effectiveAdmissao,
          vacationDays: [...vacSet],
          ausenciaDias: ausenciaDiasMapDbg[emp.id] || [],
          trabalhouSemanaInteira: trabInteira,
          motivoFalha,
          empSales,
          mMeta, mMensal,
          diasAvaliados,
        };
      });

      semanas.push({
        weekStart, weStr, skipped, hasMeta,
        empMetas: Object.keys(weekData).length,
        emps: empsDetalhes,
      });
    }
    res.json({
      mk, todayStr, monthStart, lastDayStr,
      allWeekStarts: [...allWeekStarts],
      semanas,
      employees: employees.map(e => ({ id: e.id, name: e.name, board: e.board, admissao: e.admissao || null, cargo: e.cargo })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/folha/empconfig/:empId — salva configuração individual do funcionário
app.post('/api/folha/empconfig/:empId', requireAuth, async (req, res) => {
  try {
    const empId = parseInt(req.params.empId);
    const db = await readDB();
    if (!db.folhaEmpConfig) db.folhaEmpConfig = {};
    if (Object.keys(req.body).length === 0) {
      delete db.folhaEmpConfig[empId];
    } else {
      db.folhaEmpConfig[empId] = req.body;
    }
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/folha/:year/:month — retorna dados completos para a folha do mês
app.get('/api/folha/:year/:month', requireAuth, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const db    = await readDB();

    // Inclui funcionários inativos que têm folha salva OU vsales registradas neste mês
    const savedFolha  = (db.folhas || {})[mk] || {};
    const vsalesAll   = db.vsales || {};
    const savedEmpIds = new Set();
    for (const boardData of Object.values(savedFolha))
      for (const id of Object.keys(boardData.entries || {})) savedEmpIds.add(parseInt(id));
    // Garante que inativos com vendas no mês nunca desaparecem do histórico
    for (const [key, vs] of Object.entries(vsalesAll)) {
      if (!key.startsWith(mk + '-')) continue;
      const hasEntries = Object.keys(vs.entries || {}).some(d => d.startsWith(mk));
      if (!hasEntries) continue;
      const empId = parseInt(key.split('-').at(-1));
      if (empId) savedEmpIds.add(empId);
    }
    const mesIni     = `${mk}-01`;
    const monthEnd   = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;
    // Quem entrou ou saiu no meio do mês trabalhou dias que têm de ser pagos —
    // e "inativo" é a foto de hoje, não do mês. Quem decide é o vínculo:
    // admitido até o fim do mês e desligado a partir do começo dele entra.
    // Sem data de desligamento não dá para saber a janela: aí continua valendo
    // só o histórico (folha salva ou venda lançada no mês).
    const vinculoNoMes = e => (!e.admissao     || e.admissao     <= monthEnd)
                           && (!e.desligamento || e.desligamento >= mesIni);
    const employees = (db.employees || []).filter(e => {
      if (savedEmpIds.has(e.id)) return true;
      if (e.inativo && !e.desligamento) return false;
      return vinculoNoMes(e);
    });

    const isVend = e => e.isVendedor !== false;

    const boards = [...new Set(employees.map(e => e.board))];
    const lojaMetaMap  = {}; // board → soma das metas dos vendedores
    const lojaVendaMap = {}; // board → total vendas loja (mês)

    for (const board of boards) {
      const bEmps = employees.filter(e => e.board === board);
      const bVend = bEmps.filter(isVend); // somente vendedores

      // Meta loja = soma das metas individuais dos vendedores
      lojaMetaMap[board] = bVend.reduce((s, e) => {
        return s + ((vsalesAll[`${mk}-${board}-${e.id}`]?.meta?.mensal) || 0);
      }, 0);

      // Total vendas loja (todos os funcionários da loja)
      lojaVendaMap[board] = bEmps.reduce((s, e) => {
        const vs = vsalesAll[`${mk}-${board}-${e.id}`] || {};
        return s + Object.entries(vs.entries || {})
          .filter(([d]) => d.startsWith(mk))
          .reduce((a,[,en]) => a + (en.value||0), 0);
      }, 0);
    }

    // Monta vsales — cada funcionário usa sua própria meta individual
    const vsales = {};
    for (const emp of employees) {
      const key = `${mk}-${emp.board}-${emp.id}`;
      vsales[emp.id] = vsalesAll[key] || { meta: { mensal: 0 }, entries: {} };
    }

    // ── Premiação semanal — calcula para semanas cujo último dia está dentro do mês ──
    const PREMIO_VEND_W = 80, PREMIO_GER_W = 250, PREMIO_PA_W = 50, PA_THR = 1.80;
    const todayStr   = new Date().toISOString().slice(0, 10);
    const lastDay    = new Date(year, month, 0);
    const padD       = n => String(n).padStart(2,'0');
    const lastDayStr = `${year}-${padD(month)}-${padD(lastDay.getDate())}`;
    const monthStart = `${year}-${padD(month)}-01`;
    // A primeira semana do mês pode começar até 6 dias antes (domingo do mês anterior)
    const rangeStart = (() => {
      const d = new Date(monthStart + 'T12:00:00'); d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
    })();

    // ── Ausências (férias/atestados) → mapa de dias bloqueados por funcionário ──
    // Usado para excluir funcionários que não trabalharam a semana inteira da premiação semanal
    const ausencias = db.ausencias || [];
    // Normaliza nome para comparação case-insensitive sem acento
    const _normName = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
    // Para cada funcionário, expande o range de férias/atestado em dias individuais
    const ausenciaDiasMap = {}; // empId → Set<'YYYY-MM-DD'>
    for (const emp of employees) {
      const empNorm = _normName(emp.apelido || emp.name);
      const empAus  = ausencias.filter(a =>
        ['ferias','atestado'].includes(a.tipo) &&
        _normName(a.colaborador) === empNorm &&
        a.dataFim >= rangeStart && a.dataInicio <= lastDayStr
      );
      if (!empAus.length) continue;
      const days = new Set();
      for (const a of empAus) {
        const cur = new Date(a.dataInicio + 'T12:00:00');
        const fim = new Date(a.dataFim    + 'T12:00:00');
        while (cur <= fim) {
          const ds = cur.toISOString().slice(0,10);
          if (ds >= rangeStart && ds <= lastDayStr) days.add(ds);
          cur.setDate(cur.getDate() + 1);
        }
      }
      if (days.size > 0) ausenciaDiasMap[emp.id] = days;
    }
    const premiacaoSemanal           = {};
    const premiacaoSemanalDetalhe    = {};
    const premiacaoSemanalGer        = {};
    const premiacaoSemanalGerDetalhe = {};
    for (const emp of employees) {
      premiacaoSemanal[emp.id]           = 0;
      premiacaoSemanalDetalhe[emp.id]    = [];
      premiacaoSemanalGer[emp.id]        = 0;
      premiacaoSemanalGerDetalhe[emp.id] = [];
    }

    const folhaEmpCfgMap = db.folhaEmpConfig || {};

    const boardEmpsMap = {};
    for (const emp of employees) {
      if (!boardEmpsMap[emp.board]) boardEmpsMap[emp.board] = [];
      boardEmpsMap[emp.board].push(emp);
    }

    // Supervisor/sócio recebe o prêmio de CADA loja que supervisiona, não só o da
    // loja onde está cadastrado — por isso não sai de boardEmpsMap (que agrupa por
    // emp.board), e sim de supervisedBoards.
    const isSupervisorLike = emp => /supervisor|sócio|socio/i.test(emp.cargo || '');
    const supervisoresPorLoja = {};
    for (const emp of employees) {
      if (!isSupervisorLike(emp)) continue;
      if (!(folhaEmpCfgMap[emp.id] || {}).recebePremiaoLoja) continue;
      for (const b of (emp.supervisedBoards || [])) {
        if (!supervisoresPorLoja[b]) supervisoresPorLoja[b] = [];
        supervisoresPorLoja[b].push(emp);
      }
    }

    // ── Semanas que cruzam dois meses ─────────────────────────────────────────
    // A semana domingo-sábado pode começar no mês anterior (ex.: 28/06 – 04/07).
    // Vendas, PA e meta têm que ser avaliados sobre a semana INTEIRA, como a tela
    // Meta Semanal faz. Antes só os dias do mês corrente entravam: a meta caía
    // proporcionalmente e a loja "batia meta" numa semana em que não bateu.
    const mkOf     = ds  => ds.slice(0, 7);
    const daysInMk = mkX => { const [y2, m2] = mkX.split('-').map(Number); return new Date(y2, m2, 0).getDate(); };
    const dayWeight = ds => {
      const w = (db.globalWeights || {})[mkOf(ds)] || {};
      return w[ds] !== undefined ? w[ds] : 100 / daysInMk(mkOf(ds));
    };
    const weekDays = (ws, we) => {
      const out = [];
      const d = new Date(ws + 'T12:00:00'), end = new Date(we + 'T12:00:00');
      while (d <= end) {
        out.push(`${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`);
        d.setDate(d.getDate() + 1);
      }
      return out;
    };
    // Meta manual da semana pode estar gravada sob o mês do início OU o do fim
    const manualWeekMeta = (ws, we, empId) => {
      const metas = db.weeklyMetas || {};
      for (const mkX of new Set([mkOf(ws), mkOf(we)])) {
        const v = metas[mkX]?.[ws]?.[empId]?.meta || 0;
        if (v > 0) return v;
      }
      return 0;
    };
    // Vendas/peças/atendimentos da semana, buscando cada dia no vsales do seu mês
    const empWeekAgg = (empId, board, dias) => {
      let value = 0, pecas = 0, atend = 0;
      for (const ds of dias) {
        const e = vsalesAll[`${mkOf(ds)}-${board}-${empId}`]?.entries?.[ds];
        if (e) { value += e.value || 0; pecas += e.pecas || 0; atend += e.atendimentos || 0; }
      }
      return { value, pecas, atend };
    };
    // ── Meta do dia de um vendedor — porta server-side de sellerDayGoal (public/app.js) ──
    // A meta semanal TEM que sair da meta da loja dividida pelos vendedores ativos NAQUELE
    // dia, igual à tela Meta Semanal. Antes daqui saía `vsales.meta.mensal * peso do dia`,
    // e esse `meta.mensal` é só um snapshot gravado quando alguém salva a meta da loja —
    // já vem proporcional aos dias do vendedor no mês. Para quem entrou/saiu no meio do mês
    // (ou teve férias), o snapshot encolhido era espalhado por TODAS as semanas, derrubando
    // a meta das semanas que ele trabalhou inteiras e gerando prêmio indevido — individual
    // e de loja, porque a meta da loja aqui é a soma das metas dos vendedores.
    const metaLojaOf = (mkX, board) => db.dailySales?.[`${mkX}-${board}`]?.meta?.mensal || 0;
    // Roster completo por loja, SEM filtro de inativo: o divisor precisa contar quem estava
    // ativo naquele dia, não quem está ativo hoje (mesma razão do S.allEmployees no cliente).
    const allVendByBoard = {};
    for (const emp of (db.employees || [])) {
      if (!isVend(emp)) continue;
      if (!allVendByBoard[emp.board]) allVendByBoard[emp.board] = [];
      allVendByBoard[emp.board].push(emp);
    }
    const vacDaysMk    = (empId, board, mkX) => vsalesAll[`${mkX}-${board}-${empId}`]?.meta?.vacationDays || [];
    const ativoNoDia   = (emp, ds) => (!emp.admissao     || emp.admissao     <= ds)
                                   && (!emp.desligamento || emp.desligamento >= ds);
    const sellerDayGoal = (emp, board, ds) => {
      if (emp.omniChannel) return 0;                    // canal Omni não divide meta
      if (!ativoNoDia(emp, ds)) return 0;               // fora da janela admissão/desligamento
      const mkX = mkOf(ds);
      if (vacDaysMk(emp.id, board, mkX).includes(ds)) return 0;  // férias (Part%)
      const w = dayWeight(ds);
      const metaLoja = metaLojaOf(mkX, board);
      if (metaLoja > 0) {
        const nActive = Math.max(1, (allVendByBoard[board] || []).filter(e =>
          !e.omniChannel && ativoNoDia(e, ds) && !vacDaysMk(e.id, board, mkX).includes(ds)
        ).length);
        return metaLoja * w / 100 / nActive;
      }
      // Mês sem meta da loja: mesmo fallback do cliente — meta individual gravada
      return (vsalesAll[`${mkX}-${board}-${emp.id}`]?.meta?.mensal || 0) * w / 100;
    };
    // Meta automática da semana: soma das metas diárias, cada dia com o peso do SEU mês
    const empWeekMetaAuto = (emp, board, dias) =>
      dias.reduce((s, ds) => s + sellerDayGoal(emp, board, ds), 0);
    const empWeekMeta = (emp, board, ws, we, dias) => {
      const manual = manualWeekMeta(ws, we, emp.id);
      return manual > 0 ? manual : empWeekMetaAuto(emp, board, dias);
    };
    // Dias de férias marcados via Part%, unindo os meses tocados pela semana
    const vacDaysOf = (empId, board, dias) => {
      const set = new Set();
      for (const mkX of new Set(dias.map(mkOf))) {
        for (const d of (vsalesAll[`${mkX}-${board}-${empId}`]?.meta?.vacationDays || [])) set.add(d);
      }
      return set;
    };

    // Generate all Sunday-based weeks overlapping the month + any manual-meta weeks
    // Somente semanas domingo-a-sábado, igual à view Meta Semanal
    const allWeekStarts = new Set();
    const msDate = new Date(monthStart + 'T12:00:00');
    const firstSunday = new Date(msDate);
    firstSunday.setDate(msDate.getDate() - msDate.getDay()); // rewind to Sunday
    for (let d = new Date(firstSunday); ; d.setDate(d.getDate() + 7)) {
      const ws = `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
      if (ws > lastDayStr) break;
      const weEndD = new Date(d); weEndD.setDate(weEndD.getDate() + 6);
      const weEnd = `${weEndD.getFullYear()}-${padD(weEndD.getMonth()+1)}-${padD(weEndD.getDate())}`;
      // Inclui semana se o FIM cair dentro do mês — garante que semanas cross-month
      // (ex.: Dom 31/05–Sáb 06/06) sempre sejam avaliadas para o mês de junho,
      // permitindo que férias/admissão da semana parcial sejam verificados corretamente.
      if (weEnd >= monthStart && weEnd <= lastDayStr) allWeekStarts.add(ws);
    }

    for (const weekStart of allWeekStarts) {
      const wsDate = new Date(weekStart + 'T12:00:00');
      const weDate = new Date(wsDate); weDate.setDate(weDate.getDate() + 6);
      const weStr   = `${weDate.getFullYear()}-${padD(weDate.getMonth()+1)}-${padD(weDate.getDate())}`;
      const semLabel = `${padD(wsDate.getDate())}/${padD(wsDate.getMonth()+1)} – ${padD(weDate.getDate())}/${padD(weDate.getMonth()+1)}`;
      // inclui semana apenas se o último dia está dentro do mês e a semana já terminou
      if (weStr > lastDayStr || weStr >= todayStr) continue;

      const dias = weekDays(weekStart, weStr);

      for (const board of Object.keys(boardEmpsMap)) {
        const bEmps = boardEmpsMap[board];
        let storeSales = 0, storePecas = 0, storeAtend = 0, storeMeta = 0;
        for (const emp of bEmps) {
          if (!isVend(emp)) continue;
          const agg = empWeekAgg(emp.id, board, dias);
          storeSales += agg.value;
          storePecas += agg.pecas;
          storeAtend += agg.atend;
          storeMeta  += empWeekMeta(emp, board, weekStart, weStr, dias);
        }
        const storeHitMeta = storeMeta > 0 && storeSales >= storeMeta;
        const storeHitPA   = storeAtend > 0 && (storePecas/storeAtend) >= PA_THR;

        for (const emp of bEmps) {
          const tipo  = (emp.cargo||'').toLowerCase();
          const isGer    = /gerente/.test(tipo) && !/^sub/.test(tipo) && !/g\.?\s*vend/.test(tipo) && !/gerente\s+vend/.test(tipo);
          const isGVend  = (/g\.?\s*vend/.test(tipo) || /gerente\s+vend/.test(tipo)) && !/^sub/.test(tipo);
          const isSubGer = /^sub/.test(tipo) && /gerente/.test(tipo);
          const empCfg   = folhaEmpCfgMap[emp.id] || {};
          // Sub-gerente NÃO recebe prêmio de loja por padrão — é vendedor com
          // comissionamento sobre a loja. Só recebe se marcar a flag no config.
          // Supervisor/sócio sai do laço dedicado abaixo (uma linha por loja supervisionada).
          const useStorePremio = !isSupervisorLike(emp) &&
            (isGer || isGVend || empCfg.recebePremiaoLoja);
          const storePremioVal = empCfg.premioLojaValor > 0 ? empCfg.premioLojaValor : PREMIO_GER_W;

          // Verifica se o funcionário trabalhou todos os dias da semana
          // Regra: % diário zerado (férias, admissão no meio, desligamento) = não trabalhou = sem prêmio
          const vacSet = vacDaysOf(emp.id, board, dias);

          // Se admissão não estiver cadastrada, usa a primeira entrada de vsales
          // da semana como fallback (detecta quem começou no meio do mês sem data)
          let effectiveAdmissao = emp.admissao || null;
          if (!effectiveAdmissao) {
            const allEntryDates = [...new Set(dias.map(mkOf))]
              .flatMap(mkX => Object.keys(vsalesAll[`${mkX}-${board}-${emp.id}`]?.entries || {}))
              .sort();
            if (allEntryDates.length > 0) effectiveAdmissao = allEntryDates[0];
          }

          const ausenciaDias = ausenciaDiasMap[emp.id] || new Set();
          const trabalhouSemanaInteira = dias.every(ds => {
            if (vacSet.has(ds))       return false; // férias via toggle Part%
            if (ausenciaDias.has(ds)) return false; // férias/atestado via calendário
            if (effectiveAdmissao && ds < effectiveAdmissao) return false;
            if (emp.desligamento  && ds > emp.desligamento)  return false;
            return true;
          });

          // Prêmio de loja para gerente, gerente vendedor e funcionários com flag no config
          if (useStorePremio && trabalhouSemanaInteira) {
            let val = 0;
            if (storeHitMeta) val += storePremioVal;
            if (storeHitMeta && storeHitPA) val += PREMIO_PA_W;
            if (val > 0) {
              premiacaoSemanalGer[emp.id] += val;
              premiacaoSemanalGerDetalhe[emp.id].push({ label: semLabel, valor: val, board });
            }
          }

          // Prêmio individual para vendedor, gerente vendedor e sub-gerente
          if (isGVend || isSubGer || (!isGer && isVend(emp))) {
            if (!trabalhouSemanaInteira) continue;
            const { value: empSales, pecas: empPecas, atend: empAtend } =
              empWeekAgg(emp.id, board, dias);
            const empMeta = empWeekMeta(emp, board, weekStart, weStr, dias);
            if (empMeta > 0 && empSales >= empMeta) {
              let val = PREMIO_VEND_W;
              if (empAtend > 0 && (empPecas/empAtend) >= PA_THR) val += PREMIO_PA_W;
              premiacaoSemanal[emp.id] += val;
              premiacaoSemanalDetalhe[emp.id].push({ label: semLabel, valor: val });
            }
          }
        }

        // Prêmio de loja do supervisor/sócio: uma linha por loja supervisionada
        // que bateu a meta na semana. Sem adicional de PA (regra do gerente).
        if (storeHitMeta) {
          for (const sup of (supervisoresPorLoja[board] || [])) {
            const ausSup = ausenciaDiasMap[sup.id] || new Set();
            const vacSup = vacDaysOf(sup.id, sup.board, dias);
            const trabalhou = dias.every(ds =>
              !vacSup.has(ds) && !ausSup.has(ds) &&
              !(sup.admissao     && ds < sup.admissao) &&
              !(sup.desligamento && ds > sup.desligamento));
            if (!trabalhou) continue;
            const supCfg = folhaEmpCfgMap[sup.id] || {};
            const val = supCfg.premioLojaValor > 0 ? supCfg.premioLojaValor : PREMIO_GER_W;
            premiacaoSemanalGer[sup.id] += val;
            premiacaoSemanalGerDetalhe[sup.id].push({ label: semLabel, valor: val, board });
          }
        }
      }
    }

    // Extras do mês anterior como sugestão para novos lançamentos
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    const prevMk    = `${prevYear}-${String(prevMonth).padStart(2,'0')}`;
    const prevFolha = (db.folhas || {})[prevMk] || {};
    const prevExtras = {};
    // Ajuda de custo é valor fixo mensal — repete do mês anterior
    const prevAjudaCusto = {};
    for (const boardData of Object.values(prevFolha)) {
      for (const [empId, entry] of Object.entries(boardData.entries || {})) {
        const extras     = (entry.extras     || []).filter(x => x.nome && x.valor);
        const extrasDesc = (entry.extrasDesc || []).filter(x => x.nome && x.valor);
        if (extras.length || extrasDesc.length)
          prevExtras[empId] = { extras, extrasDesc };
        const ajuda = (entry.ajudaCustoLojas || []).filter(x => x.board && x.valor);
        if (ajuda.length)
          prevAjudaCusto[empId] = ajuda.map(x => ({ board: x.board, valor: x.valor }));
      }
    }

    // Vendas e meta totais para supervisores (soma das lojas supervisionadas)
    const supervisorVendaMap = {};
    const supervisorMetaMap  = {};
    for (const emp of employees) {
      if (!/supervisor|sócio|socio/i.test(emp.cargo || '')) continue;
      const sBoards = emp.supervisedBoards || [];
      supervisorVendaMap[emp.id] = sBoards.reduce((s, b) => s + (lojaVendaMap[b] || 0), 0);
      supervisorMetaMap[emp.id]  = sBoards.reduce((s, b) => s + (lojaMetaMap[b]  || 0), 0);
    }

    res.json({
      folha:             (db.folhas || {})[mk] || {},
      employees,
      vsales,
      folhaConfig:       db.folhaConfig    || {},
      empConfig:         db.folhaEmpConfig || {},
      folhaMensal:       (db.folhaConfigMensal || {})[mk] || {},
      lojaMetaMap,
      lojaVendaMap,
      supervisorVendaMap,
      supervisorMetaMap,
      premiacaoSemanal,
      premiacaoSemanalDetalhe,
      premiacaoSemanalGer,
      premiacaoSemanalGerDetalhe,
      prevExtras,
      prevAjudaCusto,
      ...(() => {
        const { porEmp, semVinculo } = adiantamentosDoMes(db, year, month);
        return { adiantamentos: porEmp, adiantamentosSemVinculo: semVinculo };
      })(),
      ...(() => {
        const { porEmp, semVinculo } = faltasDoMes(db, year, month);
        return { faltasLoja: porEmp, faltasSemVinculo: semVinculo };
      })(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/folha/:year/:month/mensal — salva config mensal (dias úteis, dom/feriados)
app.post('/api/folha/:year/:month/mensal', requireAuth, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const db    = await readDB();
    if (!db.folhaConfigMensal) db.folhaConfigMensal = {};
    db.folhaConfigMensal[mk] = {
      diasUteis:        parseInt(req.body.diasUteis)        || 22,
      domingosFeriados: parseInt(req.body.domingosFeriados) || 4,
    };
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/folha/:year/:month — salva dados da folha do mês
app.post('/api/folha/:year/:month', requireAuth, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const db    = await readDB();
    if (!db.folhas) db.folhas = {};
    if (!db.folhas[mk]) db.folhas[mk] = {};
    const bloqueadas = [];
    const entriesBloqueadas = [];
    for (const [board, boardData] of Object.entries(req.body || {})) {
      if (!boardData) continue;
      if (!db.folhas[mk][board]) db.folhas[mk][board] = {};
      // Folha encerrada é histórico: nenhuma entry pode ser reescrita enquanto
      // ela estiver fechada. A única gravação aceita é a própria reabertura
      // (encerrada: false), que precisa vir explícita no mesmo payload.
      const estaEncerrada = db.folhas[mk][board].encerrada === true;
      const reabrindo     = boardData.encerrada === false;
      if (boardData.entries && estaEncerrada && !reabrindo) {
        bloqueadas.push(board);
      } else if (boardData.entries) {
        if (!db.folhas[mk][board].entries) db.folhas[mk][board].entries = {};
        const alvo = db.folhas[mk][board].entries;
        for (const [empId, entry] of Object.entries(boardData.entries)) {
          // Mesma regra, um nível abaixo: colaborador com folha individual
          // encerrada (rescisão fechada antes da folha do resto da loja) é
          // histórico. Só passa a própria reabertura, explícita no payload.
          if (alvo[empId]?.encerrada === true && entry?.encerrada !== false) {
            entriesBloqueadas.push(`${board}/${empId}`);
            continue;
          }
          alvo[empId] = entry;
        }
      }
      if ('encerrada' in boardData) db.folhas[mk][board].encerrada = boardData.encerrada;
    }
    await writeDB(db);
    if (bloqueadas.length)
      console.warn(`[folha ${mk}] gravação recusada — folha encerrada: ${bloqueadas.join(', ')}`);
    if (entriesBloqueadas.length)
      console.warn(`[folha ${mk}] entry recusada — folha individual encerrada: ${entriesBloqueadas.join(', ')}`);
    res.json({ ok: true, bloqueadas, entriesBloqueadas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/folha/:year/:month/export — gera Excel da folha
app.get('/api/folha/:year/:month/export', requireAuth, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const board = req.query.board; // loja específica ou todas
    const db    = await readDB();
    const folha = (db.folhas || {})[mk] || {};
    const savedFolhaEmpIds = new Set(
      Object.values(folha).flatMap(bd => Object.keys(bd.entries || {}).map(Number))
    );
    const employees = (db.employees || []).filter(e => !e.inativo || savedFolhaEmpIds.has(e.id));

    const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesLabel = `${MONTHS_PT[month-1]} ${year}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas';

    const bFmt = v => {
      if (!v && v !== 0) return '';
      return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    // Determina quais lojas exportar
    const boardsToExport = board ? [board] : Object.keys(folha);

    for (const bk of boardsToExport) {
      const lojaData = folha[bk];
      if (!lojaData?.entries) continue;

      const lojaEmps = employees.filter(e => e.board === bk);

      // Sheet TOTAL para a loja
      const totalSheet = wb.addWorksheet(`TOTAL-${bk.toUpperCase()}`);
      totalSheet.addRow(['FUNCIONÁRIO', 'BANCO', 'AG', 'CONTA', 'INSS', 'TOTAL LÍQUIDO', 'PROVENTOS', 'POR FORA', 'TOTAL GERAL']);
      let totalLiq = 0, totalProv = 0, totalFora = 0;

      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;
        const fora = Number(entry.totalFora) || 0;
        totalSheet.addRow([
          emp.apelido || emp.name,
          emp.banco || '',
          '',
          emp.conta || '',
          bFmt(entry.inss),
          bFmt(entry.liquido),
          bFmt(entry.proventos),
          fora ? bFmt(fora) : '',
          bFmt((entry.liquido || 0) + fora),
        ]);
        totalLiq  += (entry.liquido  || 0);
        totalProv += (entry.proventos || 0);
        totalFora += fora;
      }
      totalSheet.addRow(['TOTAL', '', '', '', '', bFmt(totalLiq), bFmt(totalProv),
                         bFmt(totalFora), bFmt(totalLiq + totalFora)]);

      // Sheet por funcionário
      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;

        const sheetName = (emp.apelido || emp.name).substring(0, 31).replace(/[:\\\/\?\*\[\]]/g, '');
        const ws = wb.addWorksheet(sheetName);

        ws.addRow([emp.name]);
        ws.addRow(['MÊS', mesLabel, 'CARGO', emp.cargo]);
        ws.addRow([]);

        ws.addRow(['PROVENTOS', '', 'VALOR']);
        const addProv = (label, value) => {
          if (!value && value !== 0) return;
          if (value === 0 && !['TOTAL PROVENTOS'].includes(label)) return;
          ws.addRow([label, '', bFmt(value)]);
        };

        const isCaixa = /caixa|opcx/i.test(emp.cargo || '');
        if (isCaixa) {
          addProv('FIXO', entry.fixo);
          addProv('QUEBRA CAIXA', entry.quebra);
        } else {
          addProv('VENDAS', entry.vendas);
          addProv(`COMISSÃO CONTAB (${(entry.comissaoPct||0).toFixed(2)}%)`, entry.comissaoContab);
          addProv('DSR', entry.dsr);
          addProv('PRÊMIO', entry.premio);
          if (entry.fixo) addProv('SALÁRIO FIXO', entry.fixo);
          // No sub-gerente a comissão da loja já está dentro de COMISSÃO CONTAB + DSR + PRÊMIO
          if (entry.comissaoLoja && entry.tipo !== 'sub') addProv('COMISSÃO LOJA', entry.comissaoLoja);
          if (entry.gmComplement) addProv('GARANTIA SURFERS', entry.gmComplement);
        }
        if (entry.feriado) addProv('FERIADO', entry.feriado);
        // Ajuda de custo do supervisor/sócio — uma linha por empresa
        const AJUDA_LABEL = { site: 'ESCRITÓRIO', estacao: 'ESTAÇÃO', delrey: 'DEL REY', lez: 'LEZ A LEZ' };
        for (const aj of (entry.ajudaCustoLojas || [])) {
          if (aj.valor) addProv(`AJUDA DE CUSTO ${AJUDA_LABEL[aj.board] || (aj.board || '').toUpperCase()}`, aj.valor);
        }
        for (const ex of (entry.extras || [])) {
          if (ex.nome && ex.valor) addProv(ex.nome, ex.valor);
        }
        ws.addRow(['PROVENTOS', '', bFmt(entry.proventos)]);

        ws.addRow([]);
        ws.addRow(['DESCONTOS', '', 'VALOR']);
        const addDesc = (label, value) => {
          if (!value) return;
          ws.addRow([label, '', bFmt(value)]);
        };
        addDesc('VALE COMPRAS', entry.valeCompras);
        addDesc('ADIANTAMENTO', entry.adiantamento);
        addDesc(entry.faltas ? `FALTAS (${entry.faltas})` : 'FALTAS', entry.faltasValor);
        addDesc('INSS', entry.inss);
        addDesc('IR FP', entry.irpf);
        addDesc('VALE TRANSPORTE', entry.vt);
        if (entry.arredondamento) ws.addRow(['ARRED.', '', bFmt(entry.arredondamento)]);
        for (const ex of (entry.extrasDesc || [])) {
          if (ex.nome && ex.valor) addDesc(ex.nome, ex.valor);
        }
        ws.addRow(['TOTAL DESCONTOS', '', bFmt(entry.totalDescontos)]);

        ws.addRow([]);
        ws.addRow(['LÍQUIDO', '', bFmt(entry.liquido)]);

        // Pagamento por fora — só na planilha interna, nunca na contabilidade
        const foraRows = (entry.fora || []).filter(f => Number(f.valor));
        if (foraRows.length) {
          ws.addRow([]);
          ws.addRow(['POR FORA (não declarado)', '', 'VALOR']);
          for (const f of foraRows) ws.addRow([f.nome || 'COMPLEMENTO', '', bFmt(f.valor)]);
          ws.addRow(['TOTAL POR FORA', '', bFmt(entry.totalFora)]);
          ws.addRow([]);
          ws.addRow(['TOTAL GERAL', '', bFmt((entry.liquido || 0) + (Number(entry.totalFora) || 0))]);
        }
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="folha-${mk}${board?'-'+board:''}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/folha/:year/:month/contabilidade — planilha contabilidade (1 sheet por loja)
app.get('/api/folha/:year/:month/contabilidade', requireAuth, async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const mk    = `${year}-${String(month).padStart(2,'0')}`;
    const board = req.query.board;
    const db    = await readDB();
    const folha = (db.folhas || {})[mk] || {};
    const savedFolhaEmpIds2 = new Set(
      Object.values(folha).flatMap(bd => Object.keys(bd.entries || {}).map(Number))
    );
    const employees = (db.employees || []).filter(e => !e.inativo || savedFolhaEmpIds2.has(e.id));

    const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesLabel = `${MONTHS_PT[month-1]} ${year}`;

    const BOARDS_LABEL = {
      delrey:'DEL REY', minas:'MINAS', contagem:'CONTAGEM',
      estacao:'ESTAÇÃO', tommy:'TOMMY', lez:'LEZ A LEZ',
      escritorio:'ESCRITÓRIO',
    };

    const r2 = v => Math.round((parseFloat(v)||0)*100)/100;
    const n2 = v => r2(v) || null;  // número real (null = célula em branco)

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gestão Lojas';

    const boardsToExport = board ? [board] : Object.keys(BOARDS_LABEL);

    for (const bk of boardsToExport) {
      const lojaData = folha[bk];
      if (!lojaData?.entries) continue;

      const lojaEmps = employees.filter(e => e.board === bk);
      const shName = (BOARDS_LABEL[bk] || bk.toUpperCase()).substring(0,31);
      const ws = wb.addWorksheet(shName);

      // Title
      ws.addRow([`CONTABILIDADE — ${BOARDS_LABEL[bk]||bk.toUpperCase()} — ${mesLabel}`]);
      ws.getRow(1).font = { bold: true, size: 12 };
      ws.addRow([]);

      // Header — cada desconto na sua coluna. A antiga DESC. mandava o total,
      // repetindo o que AD e VALE já diziam; saiu. OUTROS DESC. é o resto:
      // INSS, IR, arredondamento, falta e lançamento avulso sem coluna própria.
      // A    B      C     D     E    F          G    H       I   J        K      L       M            N   O   P     Q       R       S               T             U
      // NOME CARGO  FIXO  Q.CX  S.F  COMISSÕES  DSR  PRÊMIO  GM  FERIADO  PREM.  T+PREM  VERIFICAÇÃO  OK  AD  VALE  MAX.VT  FALTAS  PLANO DE SAÚDE  OUTROS DESC.  OBS
      const headers = ['NOME','CARGO','FIXO','Q.CX','S.F','COMISSÕES','DSR','PRÊMIO','GM','FERIADO','PREM.','T+PREM','VERIFICAÇÃO','OK','AD','VALE','MAX. VT','FALTAS','PLANO DE SAÚDE','OUTROS DESC.','OBSERVAÇÕES'];
      ws.addRow(headers);
      const hRow = ws.getRow(3);
      hRow.font = { bold: true, color: { argb: 'FFE6EDF3' } };
      hRow.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF21262D'} };
      hRow.eachCell(c => { c.border = { bottom:{style:'thin',color:{argb:'FF30363D'}} }; });

      // Widths: text cols = 5(S.F) 14(OK) 18(FALTAS) 21(OBS)
      ws.getColumn(1).width = 22;
      ws.getColumn(2).width = 14;
      ws.getColumn(5).width = 5;
      ws.getColumn(14).width = 5;
      ws.getColumn(18).width = 18;
      ws.getColumn(21).width = 22;
      const numCols = [3,4,6,7,8,9,10,11,12,13,15,16,17,19,20];
      numCols.forEach(i => { ws.getColumn(i).width = 12; ws.getColumn(i).numFmt = '#,##0.00'; });
      ws.getColumn(19).width = 16;  // "PLANO DE SAÚDE" e "OUTROS DESC." não
      ws.getColumn(20).width = 14;  // cabem em 12

      const folhaEmpCfg = db.folhaEmpConfig || {};

      let sumFixo=0, sumQcx=0, sumCom=0, sumDsr=0, sumPremio=0,
          sumGm=0, sumFer=0, sumPrem=0, sumTotal=0,
          sumAd=0, sumVc=0, sumPs=0, sumOut=0, sumVt=0;

      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;

        // Valores DECLARADOS: o que é pago por fora já foi abatido do componente
        // de origem (fixoDeclarado / comissaoContab) e de entry.proventos.
        const fixo      = r2(entry.fixoDeclarado != null ? entry.fixoDeclarado : (entry.fixo || 0));
        const qcx       = r2(entry.quebra         || 0);
        const comissoes = r2(entry.comissaoContab || 0);
        const dsr       = r2(entry.dsr            || 0);
        const premio    = r2(entry.premio         || 0);
        const gm        = r2(entry.gmComplement   || 0);
        const feriado   = r2(entry.feriado        || 0);
        const tTotal    = r2(entry.proventos      || 0);
        // PREM. = tudo além das colunas fixas (premiação semanal + comissão loja + extras)
        const prem      = r2(tTotal - fixo - qcx - comissoes - dsr - premio - gm - feriado);
        const verif     = r2(fixo + qcx + comissoes + dsr + premio + gm + feriado + prem);
        const ok        = Math.abs(tTotal - verif) < 0.02 ? 'OK' : '⚠';
        const sf        = gm > 0 ? 'GM' : '';
        const fc        = folhaEmpCfg[emp.id] || {};

        const ad        = r2(entry.adiantamento || 0);
        const vale      = r2(entry.valeCompras  || 0);
        const vtVal     = r2(fc.maxVT           || 0);

        // Plano de saúde é linha de desconto solta na folha, com nome livre.
        // Sai pelo nome, como as faltas, e ganha coluna própria na planilha.
        const _norm = s => String(s || '').trim().toUpperCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
        const ehPlanoSaude = nome => {
          const n = _norm(nome);
          return (n.includes('PLANO') && n.includes('SAUDE')) || /^P\.?\s*S\.?$/.test(n);
        };
        const planoSaude = r2((entry.extrasDesc || [])
          .filter(x => ehPlanoSaude(x.nome))
          .reduce((s, x) => s + (parseFloat(x.valor) || 0), 0));

        // Sobra: INSS, IR, arredondamento, falta e avulso sem coluna própria.
        // Nada de desconto some da planilha, e nada aparece em duas colunas.
        const outros = r2((entry.totalDescontos || 0)
          - r2(entry.vt || 0) - ad - vale - planoSaude);

        // Férias do mês vão para OBSERVAÇÕES: explicam por que fixo e comissão
        // de loja saíram proporcionais, sem virar verba nenhuma na planilha.
        const fer = entry.ferias;
        const dm  = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}` : '';
        const obs = (fer?.ativo && fer.ini && fer.fim)
          ? `Férias ${dm(fer.ini)} a ${dm(fer.fim)}` : '';

        // FALTAS é coluna de texto: leva as datas do campo da folha e também as
        // linhas de desconto escritas como "FALTA 27/08", que era como se
        // anotava antes do campo existir. O valor descontado vai junto, como
        // nota — a coluna é de texto, o dinheiro fica na folha.
        const faltasExtras = (entry.extrasDesc || [])
          .map(x => String(x.nome || ''))
          .filter(nome => /^\s*faltas?\b/i.test(nome))
          .map(nome => nome.replace(/^\s*faltas?\s*[:\-–]?\s*/i, '').trim() || nome.trim())
          .filter(Boolean);
        const faltasTxt = [String(entry.faltas || '').trim(), ...faltasExtras]
          .filter(Boolean).join(' · ');
        const faltasVal = r2(entry.faltasValor || 0);
        const faltas = [
          faltasTxt,
          faltasVal ? `R$ ${faltasVal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '',
        ].filter(Boolean).join(' — ') || null;

        const empRow = ws.addRow([
          emp.apelido || emp.name, emp.cargo,
          n2(fixo), n2(qcx), sf||null,
          n2(comissoes), n2(dsr), n2(premio),
          n2(gm)||null, n2(feriado)||null, n2(prem)||null,
          n2(tTotal), n2(verif), ok,
          n2(ad)||null, n2(vale)||null, n2(vtVal)||null,
          faltas, n2(planoSaude)||null, n2(outros)||null, obs,
        ]);
        empRow.getCell(14).font = { bold: true, color: { argb: ok==='OK'?'FF3FB950':'FFF85149' } };
        if (sf) empRow.getCell(5).font = { bold: true, color: { argb: 'FFD29922' } };

        sumFixo+=fixo; sumQcx+=qcx; sumCom+=comissoes; sumDsr+=dsr;
        sumPremio+=premio; sumGm+=gm; sumFer+=feriado; sumPrem+=prem;
        sumTotal+=tTotal; sumAd+=ad; sumVc+=vale;
        sumPs+=planoSaude; sumOut+=outros; sumVt+=vtVal;
      }

      // Totals row
      const totRow = ws.addRow([
        'TOTAL','',
        r2(sumFixo), r2(sumQcx), '',
        r2(sumCom), r2(sumDsr), r2(sumPremio),
        r2(sumGm)||null, r2(sumFer)||null, r2(sumPrem)||null,
        r2(sumTotal), r2(sumTotal), '',
        r2(sumAd)||null, r2(sumVc)||null, r2(sumVt)||null,
        null, r2(sumPs)||null, r2(sumOut)||null, '',
      ]);
      totRow.font = { bold: true };
      totRow.eachCell(c => { c.border = { top:{style:'thin',color:{argb:'FF30363D'}} }; });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="contabilidade-${mk}${board?'-'+board:''}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── CRM ────────────────────────────────────────────────────────────────────
const { ObjectId } = require('mongodb');

app.get('/crm', requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'crm.html')));

// Probe — testa todos os possíveis comandos de clientes no Microvix
app.get('/api/crm/clientes-raw', requireAdmin, async (req, res) => {
  const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
  const [board, cnpj] = Object.entries(lojas)[0] || [];
  if (!board) return res.status(400).json({ error: 'MICROVIX_LOJAS não configurado' });
  const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
  const cnpjClean = cnpj.replace(/\D/g, '');
  const today = new Date().toISOString().slice(0, 10);
  const commands = ['LinxClientesFornec','LinxClientes','LinxPessoas','LinxClientesPortal'];
  const results = [];
  for (const cmd of commands) {
    const params = cmd === 'LinxClientesFornec'
      ? [{ id: 'data_inicial', valor: '2020-01-01' }, { id: 'data_fim', valor: today }, { id: 'timestamp', valor: '0' }]
      : [];
    const body = buildRequest(cmd, cnpjClean, params, chave);
    const raw  = await postRequest(body, 20_000).catch(e => `ERRO: ${e.message}`);
    const isXml = typeof raw === 'string' && (raw.trim().startsWith('<') || raw.startsWith('﻿<'));
    const rows  = isXml ? [] : (() => { try { return parseCsv(raw); } catch { return []; } })();
    const notFound = raw.includes('não foi possível encontrar o comando') || raw.includes('comando especificado');
    results.push({
      comando:   cmd,
      status:    isXml ? (notFound ? 'não disponível' : 'xml/erro') : `${rows.length} linhas`,
      campos:    rows[0] ? Object.keys(rows[0]) : [],
      exemplo:   rows[0] || null,
      raw_inicio: (raw || '').slice(0, 300),
    });
    if (rows.length > 0) break;
  }
  res.json(results);
});

// Sync customers from Microvix
app.post('/api/crm/sync', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  try {
    const total = await syncCustomers(mongoDb);
    res.json({ ok: true, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import customers from CSV/Excel upload
app.post('/api/crm/import', requireAdmin, excelUpload.single('file'), async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const { parseBirthDay } = require('./services/crmSync');

  let rows = [];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Arquivo inválido: ' + e.message }); }

  // Normaliza nomes de coluna para lowercase sem acento
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
  const findField = (row, candidates) => {
    const keys = Object.keys(row);
    for (const c of candidates) {
      const found = keys.find(k => norm(k) === c || norm(k).includes(c));
      if (found) return String(row[found] || '').trim();
    }
    return '';
  };

  const col = mongoDb.collection('crm_customers');
  let imported = 0, skipped = 0;

  for (const row of rows) {
    const nome   = findField(row, ['nome','name','cliente','nome_cliente']);
    const phone  = findField(row, ['celular','telefone','fone','phone','whatsapp']).replace(/\D/g,'');
    const cpf    = findField(row, ['cpf']).replace(/\D/g,'');
    const email  = findField(row, ['email','e-mail','e_mail']);
    const dtRaw  = findField(row, ['nascimento','aniversario','dt_nasc','data_nasc','birthday']);
    const dtNasc = parseBirthDay(dtRaw);
    const loja   = findField(row, ['loja','store','board']);
    const id     = cpf || phone;
    if (!id || !nome) { skipped++; continue; }

    await col.updateOne(
      { _id: id },
      {
        $set: { nome, celular: phone, email, dtNasc, dtNascFull: dtRaw, cpf, syncedAt: new Date() },
        $addToSet: { lojas: loja || 'importado' },
        $setOnInsert: { criadoEm: new Date(), ultimaCompra: null, reengagementSentAt: null },
      },
      { upsert: true }
    );
    imported++;
  }
  res.json({ ok: true, imported, skipped, total: rows.length });
});

// Stats for dashboard
app.get('/api/crm/stats', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const birthdayDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(brt.getTime() + i * 86400_000);
    return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  });
  const todayDDMM = birthdayDates[0];
  const [total, upcoming, atRisk, sentToday, sentMonth] = await Promise.all([
    mongoDb.collection('crm_customers').countDocuments(),
    mongoDb.collection('crm_customers').find({ dtNasc: { $in: birthdayDates } }).sort({ dtNasc: 1 }).toArray(),
    mongoDb.collection('crm_customers').countDocuments({ ultimaCompra: { $lt: new Date(Date.now() - 60*86400_000), $ne: null } }),
    mongoDb.collection('crm_messages').countDocuments({ enviadoEm: { $gte: new Date(brt.toISOString().slice(0,10)) } }),
    mongoDb.collection('crm_messages').countDocuments({ enviadoEm: { $gte: new Date(brt.getUTCFullYear(), brt.getUTCMonth(), 1) } }),
  ]);
  res.json({ total, upcoming, atRisk, sentToday, sentMonth, todayDDMM });
});

// Customer list
app.get('/api/crm/customers', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const { q, loja, page = '1' } = req.query;
  const lim = 60, skip = (parseInt(page) - 1) * lim;
  const filter = {};
  if (q) filter.$or = [{ nome: { $regex: q, $options: 'i' } }, { celular: { $regex: q } }, { cpf: { $regex: q } }];
  if (loja) filter.lojas = loja;
  const [customers, count] = await Promise.all([
    mongoDb.collection('crm_customers').find(filter).sort({ nome: 1 }).skip(skip).limit(lim).toArray(),
    mongoDb.collection('crm_customers').countDocuments(filter),
  ]);
  res.json({ customers, total: count, page: parseInt(page), pages: Math.ceil(count / lim) });
});

// Update customer (e.g. add/fix phone)
app.patch('/api/crm/customers/:id', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const { celular, email } = req.body || {};
  const upd = {};
  if (celular !== undefined) upd.celular = celular.replace(/\D/g, '');
  if (email   !== undefined) upd.email   = email;
  await mongoDb.collection('crm_customers').updateOne({ _id: req.params.id }, { $set: upd });
  res.json({ ok: true });
});

// Campaign CRUD
app.get('/api/crm/campaigns', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  res.json(await mongoDb.collection('crm_campaigns').find().sort({ criadoEm: -1 }).toArray());
});

app.post('/api/crm/campaigns', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const { nome, tipo, template, config } = req.body || {};
  if (!nome || !tipo || !template) return res.status(400).json({ error: 'Informe nome, tipo e template' });
  const r = await mongoDb.collection('crm_campaigns').insertOne({ nome, tipo, template, config: config || {}, ativo: true, criadoEm: new Date() });
  res.json({ ok: true, id: r.insertedId });
});

app.put('/api/crm/campaigns/:id', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const { nome, tipo, template, config, ativo } = req.body || {};
  const upd = {};
  if (nome !== undefined) upd.nome = nome;
  if (tipo !== undefined) upd.tipo = tipo;
  if (template !== undefined) upd.template = template;
  if (config   !== undefined) upd.config   = config;
  if (ativo    !== undefined) upd.ativo    = ativo;
  await mongoDb.collection('crm_campaigns').updateOne({ _id: new ObjectId(req.params.id) }, { $set: upd });
  res.json({ ok: true });
});

app.delete('/api/crm/campaigns/:id', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  await mongoDb.collection('crm_campaigns').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

// Run campaign manually
app.post('/api/crm/campaigns/:id/run', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const campaign = await mongoDb.collection('crm_campaigns').findOne({ _id: new ObjectId(req.params.id) });
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

  const { loja, limite = 100 } = req.body || {};
  const filter = { celular: { $nin: ['', null] } };
  if (loja) filter.lojas = loja;

  const customers = await mongoDb.collection('crm_customers').find(filter).limit(parseInt(limite)).toArray();
  let sent = 0, failed = 0;

  for (const c of customers) {
    const firstName = c.nome.split(' ')[0];
    const msg = crmTemplate(campaign.template, { nome: firstName, nomeCompleto: c.nome, loja: c.lojas?.[0] || '', dias: '' });
    try {
      await zapiSend(c.celular, msg);
      await mongoDb.collection('crm_messages').insertOne({ customerId: c._id, customerNome: c.nome, celular: c.celular, campaignId: String(campaign._id), campaignNome: campaign.nome, mensagem: msg, status: 'sent', erro: '', enviadoEm: new Date() });
      sent++;
    } catch (e) {
      await mongoDb.collection('crm_messages').insertOne({ customerId: c._id, customerNome: c.nome, celular: c.celular, campaignId: String(campaign._id), campaignNome: campaign.nome, mensagem: msg, status: 'failed', erro: e.message, enviadoEm: new Date() });
      failed++;
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  res.json({ ok: true, sent, failed });
});

// Test send
app.post('/api/crm/send-test', requireAdmin, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ error: 'Informe phone e message' });
  try { await zapiSend(phone, message); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Message log
app.get('/api/crm/messages', requireAdmin, async (req, res) => {
  if (!mongoDb) return res.status(503).json({ error: 'MongoDB não disponível' });
  const { page = '1', status } = req.query;
  const filter = {};
  if (status) filter.status = status;
  const lim = 50, skip = (parseInt(page) - 1) * lim;
  const [messages, total] = await Promise.all([
    mongoDb.collection('crm_messages').find(filter).sort({ enviadoEm: -1 }).skip(skip).limit(lim).toArray(),
    mongoDb.collection('crm_messages').countDocuments(filter),
  ]);
  res.json({ messages, total, pages: Math.ceil(total / lim) });
});

// ══════════════════════════════════════════════════════════════════════════
// MÓDULO: CONFERÊNCIA DE CAIXA — ESCRITÓRIO
// ══════════════════════════════════════════════════════════════════════════

// Middleware: permite escritório e admin
function requireEscritorioOrAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  const b = req.session.user.board;
  if (b && b !== 'escritorio') return res.status(403).json({ error: 'Acesso restrito ao escritório' });
  next();
}

// GET /conferencia — serve a página
app.get('/conferencia', requireEscritorioOrAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'conferencia.html')));

// GET /api/conferencia/regras — retorna regras por loja
app.get('/api/conferencia/regras', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.confRegras || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/conferencia/regras — salva regras por loja
// body: { delrey: { parcelaMin: 50, descontoMaxItem: 10, descontoMaxVenda: 15 }, ... }
app.put('/api/conferencia/regras', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    db.confRegras = req.body;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/taxas — retorna tabela de taxas de cartão por bandeira/parcelas
app.get('/api/conferencia/taxas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.confTaxas || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/conferencia/taxas — salva tabela de taxas
app.put('/api/conferencia/taxas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    db.confTaxas = req.body;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Consolida todas as lojas no período: desconto e CMV por loja e por vendedor,
// mais a taxa de maquineta. Usado pelo dashboard da Conferência e pelo ranking
// de campanhas por loja.
async function computeConferenciaDashboard(dtIni, dtFin) {
  { // bloco só preserva a indentação de quando isto era o try da rota
    const lojas   = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const BOARDS  = ['delrey','minas','contagem','estacao','tommy','surfers'];
    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    const { fetchMovimento, fetchVendedores, fetchMovimentoPlanos, fetchMovimentoCartoes } = require('./services/microvix');

    // ── Taxas de maquineta cadastradas na aba Taxas ──────────────────────────
    // São a taxa TOTAL descontada pela adquirente (MDR + recebimento automático),
    // não só o MDR — logo vlrTaxa já é o desconto real da maquineta.
    // db.confTaxas = { mastercard: { debito: 0.72, '1': 2.76, '2': 3.62, ... }, pix: { pix: 0 } }
    const confTaxas = (await readDB()).confTaxas || {};

    const MAX_PARCELAS = 12; // contrato Rede vai até 12x

    // Bandeira canônica → id usado na aba Taxas
    const BAND_ID = {
      'Mastercard': 'mastercard', 'Visa': 'visa', 'Elo': 'elo', 'Amex': 'amex',
      'Maestro': 'maestro', 'Visa Electron': 'visa_elec', 'Hipercard': 'hipercard',
      'Diners': 'diners', 'Cabal': 'cabal', 'Sicredi': 'sicredi', 'Sorocred': 'sorocred',
      'Banescard': 'banescard', 'JCB': 'jcb', 'Credz': 'credz', 'Cup': 'cup',
    };
    // Compatibilidade: antes o débito de Visa/Master só podia ser cadastrado nas
    // linhas Visa Electron/Maestro. Só entra quando a linha própria está em branco.
    const BAND_DEBITO_ALIAS = { visa: 'visa_elec', mastercard: 'maestro' };

    // Mesma normalização usada na aba Vendas (desc_plano → bandeira canônica)
    function extractBandeira(descPlano) {
      const d = (descPlano || '').toUpperCase();
      if (/MAESTRO/.test(d))               return 'Maestro';
      if (/MASTER/.test(d))                return 'Mastercard';
      if (/VISA/.test(d))                  return 'Visa';
      if (/\bELO\b/.test(d))               return 'Elo';
      if (/AMEX|AMERICAN EXPRESS/.test(d)) return 'Amex';
      if (/HIPERCARD|HIPER/.test(d))       return 'Hipercard';
      if (/DINERS/.test(d))                return 'Diners';
      if (/CABAL/.test(d))                 return 'Cabal';
      if (/SICREDI/.test(d))               return 'Sicredi';
      if (/SOROCRED/.test(d))              return 'Sorocred';
      if (/BANESCARD/.test(d))             return 'Banescard';
      if (/\bJCB\b/.test(d))               return 'JCB';
      if (/CREDZ/.test(d))                 return 'Credz';
      if (/\bCUP\b|UNION\s*PAY/.test(d))   return 'Cup';
      if (/ALELO/.test(d))                 return 'Alelo';
      if (/SODEXO/.test(d))                return 'Sodexo';
      if (/\bVR\b/.test(d))                return 'VR';
      return '';
    }

    const num = v => (v !== undefined && v !== null && v !== '' && Number.isFinite(+v)) ? +v : null;

    // Retorna { taxa, label, mod, teto } — taxa null quando não há cadastro.
    // teto = tarifa máxima por transação em R$ (o PIX da Rede é % até um limite).
    function resolveTaxa({ isPix, debito, bandeira, parcelas }) {
      if (isPix) {
        const pix = confTaxas.pix || {};
        return { taxa: num(pix.pix), label: 'PIX', mod: 'PIX', teto: num(pix.max) };
      }
      const bandId = BAND_ID[bandeira] || '';
      const label  = bandeira || 'Sem bandeira';
      if (!bandId) return { taxa: null, label, mod: debito ? 'Débito' : 'Crédito', teto: null };
      if (debito) {
        const ids = [bandId, BAND_DEBITO_ALIAS[bandId]].filter(Boolean);
        for (const id of ids) {
          const t = num(confTaxas[id] && confTaxas[id].debito);
          if (t !== null) return { taxa: t, label, mod: 'Débito', teto: null };
        }
        return { taxa: null, label, mod: 'Débito', teto: null };
      }
      const p = Math.min(Math.max(parseInt(parcelas) || 1, 1), MAX_PARCELAS);
      return {
        taxa: num(confTaxas[bandId] && confTaxas[bandId][String(p)]),
        label, mod: `Crédito ${p}x`, teto: null,
      };
    }

    // Busca todas as lojas em paralelo (movimento + vendedores + formas de pagamento)
    const resultados = await Promise.all(BOARDS.map(async board => {
      const cnpj = lojas[board];
      if (!cnpj) return { board, erro: 'não configurada' };
      const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      const cnpjClean = cnpj.replace(/\D/g,'');
      try {
        const [rows, vendRows, planoRows, cartoesRows] = await Promise.all([
          fetchMovimento(cnpj, dtIni, dtFin, chave),
          fetchVendedores(cnpjClean, chave).catch(() => []),
          fetchMovimentoPlanos(cnpj, dtIni, dtFin, chave).catch(() => []),
          fetchMovimentoCartoes(cnpj, dtIni, dtFin, chave).catch(() => []),
        ]);
        const vendNomes = {};
        for (const v of (Array.isArray(vendRows) ? vendRows : [])) {
          const cod = String(v.cod_vendedor || '').trim();
          const nom = (v.nome_vendedor || v.nome || '').trim();
          if (cod && nom) vendNomes[cod] = nom;
        }
        return {
          board, cnpjClean,
          rows:        Array.isArray(rows)        ? rows        : [],
          planoRows:   Array.isArray(planoRows)   ? planoRows   : [],
          cartoesRows: Array.isArray(cartoesRows) ? cartoesRows : [],
          vendNomes,
        };
      } catch (e) {
        return { board, erro: e.message, rows: [], planoRows: [], cartoesRows: [], vendNomes: {} };
      }
    }));

    const porLoja      = {};
    const porVendedor  = {};
    const taxaGlobal   = {}; // `${label}::${mod}` → { bandeira, mod, taxa, valor, vlrTaxa, semTaxa }

    for (const { board, cnpjClean, rows, planoRows, cartoesRows, erro, vendNomes } of resultados) {
      if (erro) { porLoja[board] = { board, erro }; continue; }

      const loja = { board, vlrLiquido:0, vlrBruto:0, vlrDesconto:0, vlrCusto:0, qtdItens:0,
                     vlrCartao:0, vlrTaxa:0, vlrCartaoSemTaxa:0 };
      const seenDocs = new Set();
      const docSign  = {}; // documento válido da loja → sinal (+1 venda, -1 devolução)
      const identMap = {}; // identificador → documento (LinxMovimentoPlanos usa identificador)

      for (const r of rows) {
        const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
        if (!rowCnpj || rowCnpj !== cnpjClean) continue;
        if (r.cancelado === 'S' || r.cancelado === '1') continue;
        if ((r.soma_relatorio||'S').toUpperCase() === 'N') continue;
        const op    = (r.operacao||'').trim().toUpperCase();
        if (op !== 'S' && op !== 'DS') continue;
        const serie = String(r.serie||r.serie_documento||'').trim();
        if (serie === '999') continue;
        if (serie === '4' && op !== 'DS') continue;
        if (serie === 'J') continue;

        const sign     = op === 'DS' ? -1 : 1;

        // Registra os documentos válidos da loja para cruzar com as formas de pagamento
        {
          const d0 = String(r.documento||'').trim();
          const i0 = String(r.identificador||'').trim();
          if (d0) {
            docSign[d0] = sign;
            if (i0 && !identMap[i0]) identMap[i0] = d0;
          }
        }

        const qty      = parseBR(r.quantidade||'1');
        const vlrUnit  = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
        const vlrDesc  = parseBR(r.desconto_item||r.desconto_total_item||'0');
        const vlrCusto = parseBR(r.custo_medio_epoca||r.preco_custo||'0');

        // Bruto, desconto e custo: por item (campos granulares por linha)
        loja.vlrBruto    += sign * vlrUnit * qty;
        loja.vlrDesconto += sign * vlrDesc * qty;
        loja.vlrCusto    += sign * vlrCusto * qty;
        loja.qtdItens    += sign;

        // Vendedor — bruto/desconto/qtd por item (antes do seenDocs)
        const cod  = String(r.cod_vendedor||'').trim();
        if (cod) {
          const obsNome = (r.obs||'').match(/Nome do Vendedor:\s*(.+?)(?:\s*\|.*)?$/i);
          const nome    = (vendNomes[cod] || r.nome_vendedor || (obsNome && obsNome[1]) || cod).trim();
          const vkey    = `${board}::${cod}`;
          if (!porVendedor[vkey]) porVendedor[vkey] = { board, cod, nome, vlrLiquido:0, vlrBruto:0, vlrDesconto:0, qtdItens:0 };
          porVendedor[vkey].vlrBruto    += sign * vlrUnit * qty;
          porVendedor[vkey].vlrDesconto += sign * vlrDesc * qty;
          porVendedor[vkey].qtdItens    += sign;
        }

        // Venda líquida: por documento (igual ao sync de Performance Mensal)
        // total_* repete o valor total do doc em cada item — deduplica com seenDocs
        const doc = String(r.documento||'').trim();
        if (!doc || seenDocs.has(doc)) continue;
        seenDocs.add(doc);
        const vlrLiq = ['total_cartao','total_dinheiro','total_pix','total_cheque',
                        'total_crediario','total_convenio','total_cheque_prazo','total_deposito_bancario']
          .reduce((s, k) => s + parseBR(r[k]||'0'), 0)
          || parseBR(r.valor_total||r.total_liquido||'0');
        loja.vlrLiquido += sign * vlrLiq;

        // vlrLiquido do vendedor: por documento (após seenDocs)
        if (cod && porVendedor[`${board}::${cod}`]) {
          porVendedor[`${board}::${cod}`].vlrLiquido += sign * vlrLiq;
        }
      }

      // ── Taxas de maquineta ──────────────────────────────────────────────
      // Fonte primária: LinxMovimentoPlanos (traz desc_plano + qtde_parcelas).
      // LinxMovimentoCartoes entra só como fallback nos docs sem cartão nos planos,
      // pois não informa parcelamento (seria tratado como 1x e subestimaria a taxa).
      const pagamentos  = [];
      const docsComCard = new Set();
      const docsComPix  = new Set();

      for (const r of planoRows) {
        const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
        if (rowCnpj && rowCnpj !== cnpjClean) continue;
        const ident = String(r.identificador||'').trim();
        const doc   = (ident && identMap[ident]) || String(r.documento||'').trim();
        if (!doc || docSign[doc] === undefined) continue;

        const descP = (r.desc_plano||'').trim();
        const tipoT = (r.tipo_transacao||'').trim().toUpperCase();
        const forma = (r.forma_pgto||'').trim();
        const isPix = /pix/i.test(forma) || /\bPIX\b/.test(descP.toUpperCase());
        const isCard= !isPix && (tipoT === 'C' || tipoT === 'D');
        if (!isPix && !isCard) continue;

        const valor = parseBR(r.total || r.valor || r.valor_plano || '0');
        if (valor === 0) continue;

        const parcelas = parseInt(r.qtde_parcelas || '') || (() => {
          const m = descP.toUpperCase().match(/\b(\d+)\s*X\b/);
          return m ? parseInt(m[1]) : 1;
        })();

        if (isCard) docsComCard.add(doc);
        if (isPix)  docsComPix.add(doc);
        pagamentos.push({
          isPix, debito: tipoT === 'D',
          bandeira: isCard ? extractBandeira(descP) : '',
          parcelas, valor: docSign[doc] * valor,
        });
      }

      // Fallback PIX: LinxMovimentoPlanos nem sempre devolve a entrada de PIX
      // separada — lê total_pix do LinxMovimento (total_* repete por item, dedup por doc)
      const pixPorDoc = {};
      for (const r of rows) {
        const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
        if (!rowCnpj || rowCnpj !== cnpjClean) continue;
        const doc = String(r.documento||'').trim();
        if (!doc || docSign[doc] === undefined || docsComPix.has(doc)) continue;
        if (pixPorDoc[doc] !== undefined) continue;
        const vlrPix = parseBR(r.total_pix||'0');
        if (vlrPix !== 0) pixPorDoc[doc] = vlrPix;
      }
      for (const [doc, vlrPix] of Object.entries(pixPorDoc)) {
        pagamentos.push({ isPix: true, debito: false, bandeira: '', parcelas: 1, valor: docSign[doc] * vlrPix });
      }

      for (const r of cartoesRows) {
        const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
        if (rowCnpj && rowCnpj !== cnpjClean) continue;
        const doc = String(r.cupomfiscal || r.documento || '').trim();
        if (!doc || docSign[doc] === undefined || docsComCard.has(doc)) continue;
        const valor = parseBR(r.valor || r.valor_total || '0');
        if (valor === 0) continue;
        const cd          = String(r.credito_debito||'').trim().toUpperCase();
        const bandeiraRaw = (r.descricao_bandeira || r.bandeira || r.desc_bandeira || '').trim();
        pagamentos.push({
          isPix: false, debito: cd === 'D',
          bandeira: extractBandeira(bandeiraRaw) || bandeiraRaw,
          parcelas: 1, valor: docSign[doc] * valor,
        });
      }

      for (const p of pagamentos) {
        const { taxa, label, mod, teto } = resolveTaxa(p);
        let vlrTaxa = taxa === null ? 0 : p.valor * (taxa / 100);
        // Tarifa com teto por transação (PIX): limita o módulo, preservando o sinal
        if (taxa !== null && teto !== null && Math.abs(vlrTaxa) > teto) {
          vlrTaxa = (vlrTaxa < 0 ? -1 : 1) * teto;
        }
        loja.vlrCartao += p.valor;
        loja.vlrTaxa   += vlrTaxa;
        if (taxa === null) loja.vlrCartaoSemTaxa += p.valor;

        const gk = `${label}::${mod}`;
        if (!taxaGlobal[gk]) taxaGlobal[gk] = { bandeira: label, mod, taxa, valor: 0, vlrTaxa: 0, semTaxa: taxa === null };
        taxaGlobal[gk].valor   += p.valor;
        taxaGlobal[gk].vlrTaxa += vlrTaxa;
      }

      loja.percDesconto = loja.vlrBruto > 0 ? (loja.vlrDesconto / loja.vlrBruto) * 100 : 0;
      loja.cmvPerc      = loja.vlrLiquido > 0 ? (loja.vlrCusto / loja.vlrLiquido) * 100 : 0;
      // % efetivo da taxa sobre o que passou na maquineta e sobre a venda líquida
      loja.taxaPercCartao  = loja.vlrCartao  > 0 ? (loja.vlrTaxa / loja.vlrCartao)  * 100 : 0;
      loja.taxaPercLiquido = loja.vlrLiquido > 0 ? (loja.vlrTaxa / loja.vlrLiquido) * 100 : 0;
      porLoja[board] = loja;
    }

    // Calcula % desconto por vendedor
    const vendedores = Object.values(porVendedor).map(v => ({
      ...v,
      percDesconto: v.vlrBruto > 0 ? (v.vlrDesconto / v.vlrBruto) * 100 : 0,
    }));

    // Consolidado de taxas por bandeira/modalidade (todas as lojas)
    const porTaxa = Object.values(taxaGlobal)
      .filter(t => Math.abs(t.valor) > 0.005)
      .map(t => ({
        bandeira: t.bandeira,
        mod:      t.mod,
        taxa:     t.taxa,
        valor:    +t.valor.toFixed(2),
        vlrTaxa:  +t.vlrTaxa.toFixed(2),
        semTaxa:  t.semTaxa,
      }))
      .sort((a,b) => b.valor - a.valor);

    return {
      dtIni, dtFin,
      porLoja:     Object.values(porLoja),
      porVendedor: vendedores.sort((a,b) => b.percDesconto - a.percDesconto).slice(0, 20),
      porTaxa,
      taxasCadastradas: Object.keys(confTaxas).length > 0,
    };
  }
}

// GET /api/conferencia/dashboard?dtIni=2026-06-01&dtFin=2026-06-08
app.get('/api/conferencia/dashboard', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { dtIni, dtFin } = req.query;
    if (!dtIni || !dtFin) return res.status(400).json({ error: 'dtIni e dtFin obrigatórios' });
    res.json(await computeConferenciaDashboard(dtIni, dtFin));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Extrato Rede (mensal) ─────────────────────────────────────────────────────
let _redeExtratoColReady = false;
async function getRedeExtratoCol() {
  if (!mongoDb) throw new Error('MongoDB não conectado');
  const col = mongoDb.collection('confRedeExtrato');
  if (!_redeExtratoColReady) {
    _redeExtratoColReady = true;
    col.createIndex({ board: 1, date: 1 }, { unique: true, background: true }).catch(() => {});
  }
  return col;
}

// POST /api/conferencia/rede-extrato — salva extrato mensal agrupado por dia
// body: { board, data: { "2026-06-01": [{ mod, bandeira, valor }], ... } }
app.post('/api/conferencia/rede-extrato', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { board, data } = req.body;
    if (!board || !data) return res.status(400).json({ error: 'board e data obrigatórios' });
    const col = await getRedeExtratoCol();
    const ops = Object.entries(data).map(([date, rows]) => ({
      updateOne: {
        filter: { board, date },
        update: { $set: { board, date, rows, uploadedBy: user.name || user.login, uploadedAt: new Date() } },
        upsert: true,
      },
    }));
    if (ops.length) await col.bulkWrite(ops);
    res.json({ ok: true, dias: ops.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/rede-extrato?board=X&date=Y
app.get('/api/conferencia/rede-extrato', requireAuth, async (req, res) => {
  try {
    const { board, date } = req.query;
    if (!board || !date) return res.status(400).json({ error: 'board e date obrigatórios' });
    const col = await getRedeExtratoCol();
    const entry = await col.findOne({ board, date });
    res.json(entry ? { rows: entry.rows, uploadedBy: entry.uploadedBy, uploadedAt: entry.uploadedAt } : { rows: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Conferência Revisão helpers ──────────────────────────────────────────────
let _conferenciaRevisoesColReady = false;
async function getConferenciaRevisoesCol() {
  if (!mongoDb) throw new Error('MongoDB não conectado');
  const col = mongoDb.collection('confRevisoes');
  // Cria índices apenas uma vez por ciclo de vida do servidor, sem bloquear a requisição:
  // se a coleção já tiver muitos documentos acumulados, o createIndex(unique) pode demorar
  // dezenas de segundos (scan completo p/ validar unicidade) e o gateway do Render mata a
  // conexão com 502 antes do Mongo responder. Marca ready de imediato e deixa o índice
  // terminar de construir em background — não precisamos dele pronto para servir leituras.
  if (!_conferenciaRevisoesColReady) {
    _conferenciaRevisoesColReady = true;
    col.createIndex({ doc: 1, board: 1 }, { unique: true, background: true }).catch(() => {});
    col.createIndex({ data: 1, board: 1 }, { background: true }).catch(() => {});
  }
  return col;
}

// GET /api/conferencia/revisoes?board=X&dtIni=Y&dtFin=Z
app.get('/api/conferencia/revisoes', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!dtIni || !dtFin) return res.status(400).json({ error: 'dtIni e dtFin obrigatórios' });
    const col = await getConferenciaRevisoesCol();
    const query = { data: { $gte: dtIni, $lte: dtFin } };
    if (board && board !== 'all') query.board = board;
    const revisoes = await col.find(query).toArray();
    res.json(revisoes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conferencia/revisao
app.post('/api/conferencia/revisao', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { doc, board, data, dtIni, dtFin, vendedorCod, vendedorNome, valorTotal, valorCobrar, status, obs, alertas } = req.body;
    if (!doc || !board || !status) return res.status(400).json({ error: 'doc, board e status obrigatórios' });
    if (status === 'reprovada' && !obs) return res.status(400).json({ error: 'Observação obrigatória para reprovação' });
    if (!['conferida', 'reprovada'].includes(status)) return res.status(400).json({ error: 'status inválido' });
    const col = await getConferenciaRevisoesCol();
    const existing = await col.findOne({ doc, board });
    const updatedBy = req.session?.user?.username || 'desconhecido';
    const updatedAt = new Date();
    const docSave = { doc, board, data, dtIni, dtFin, vendedorCod, vendedorNome, valorTotal, valorCobrar: valorCobrar || 0, status, obs: obs || '', alertas: alertas || [], updatedBy, updatedAt };
    // Preserva o histórico de pedido/resposta de justificativa ao confirmar/reprovar depois dele
    if (existing?.justificativa) docSave.justificativa = existing.justificativa;
    await col.replaceOne({ doc, board }, docSave, { upsert: true });
    res.json(docSave);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conferencia/solicitar-justificativa — escritório pede que a gerente da loja
// justifique o desconto de uma venda; tira a venda da fila normal (status aguardando_justificativa)
app.post('/api/conferencia/solicitar-justificativa', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { doc, board, data, dtIni, dtFin, vendedorCod, vendedorNome, valorTotal, alertas, pergunta, itens, formas } = req.body;
    if (!doc || !board) return res.status(400).json({ error: 'doc e board obrigatórios' });
    const col = await getConferenciaRevisoesCol();
    const updatedBy = req.session?.user?.username || 'desconhecido';
    const updatedAt = new Date();
    const docSave = {
      doc, board, data, dtIni, dtFin, vendedorCod, vendedorNome, valorTotal, valorCobrar: 0,
      status: 'aguardando_justificativa', obs: '', alertas: alertas || [], itens: itens || [], formas: formas || [],
      updatedBy, updatedAt,
      justificativa: { pergunta: pergunta || '', perguntaPor: updatedBy, perguntaEm: updatedAt, resposta: null, respostaEm: null },
    };
    await col.replaceOne({ doc, board }, docSave, { upsert: true });
    res.json(docSave);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/justificativas-pendentes?board=X — vendas aguardando resposta da gerente da loja
app.get('/api/conferencia/justificativas-pendentes', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const isEscritorio = !user.board || user.board === 'escritorio';
    const board = isEscritorio ? req.query.board : user.board;
    if (!board) return res.status(400).json({ error: 'board obrigatório' });
    if (!isEscritorio && req.query.board && req.query.board !== user.board) return res.status(403).json({ error: 'Sem acesso' });
    const col = await getConferenciaRevisoesCol();
    const pendentes = await col.find({ board, status: 'aguardando_justificativa' }).toArray();
    res.json(pendentes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conferencia/justificativa-resposta — gerente responde o pedido; some da fila dela
// e volta destacada para o escritório revisar (status justificativa_respondida)
app.post('/api/conferencia/justificativa-resposta', requireAuth, async (req, res) => {
  try {
    const { doc, board, resposta } = req.body;
    if (!doc || !board || !String(resposta || '').trim()) return res.status(400).json({ error: 'doc, board e resposta obrigatórios' });
    const user = req.session.user;
    const isEscritorio = !user.board || user.board === 'escritorio';
    if (!isEscritorio && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const col = await getConferenciaRevisoesCol();
    const existing = await col.findOne({ doc, board });
    if (!existing || existing.status !== 'aguardando_justificativa') return res.status(404).json({ error: 'Pedido de justificativa não encontrado' });
    await col.updateOne({ doc, board }, { $set: {
      status: 'justificativa_respondida',
      'justificativa.resposta': resposta.trim(),
      'justificativa.respostaEm': new Date(),
      'justificativa.respondidoPor': user.username,
    } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/conferencia/revisao?doc=X&board=Y — remove revisão, volta para pendentes
app.delete('/api/conferencia/revisao', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { doc, board } = req.query;
    if (!doc || !board) return res.status(400).json({ error: 'doc e board obrigatórios' });
    const col = await getConferenciaRevisoesCol();
    await col.deleteOne({ doc, board });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/reprovadas?dtIni=Y&dtFin=Z[&board=delrey]
app.get('/api/conferencia/reprovadas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { dtIni, dtFin, board } = req.query;
    if (!dtIni || !dtFin) return res.status(400).json({ error: 'dtIni e dtFin obrigatórios' });
    const col = await getConferenciaRevisoesCol();
    const query = { data: { $gte: dtIni, $lte: dtFin }, status: 'reprovada' };
    if (board) query.board = board;
    const reprovadas = await col.find(query).toArray();
    // Agrupa por vendedor
    const byVend = {};
    for (const r of reprovadas) {
      const key = `${r.board}::${r.vendedorCod}`;
      if (!byVend[key]) byVend[key] = { vendedorNome: r.vendedorNome, vendedorCod: r.vendedorCod, board: r.board, count: 0, valorTotal: 0, valorCobrar: 0, vendas: [] };
      byVend[key].count++;
      byVend[key].valorTotal  += r.valorTotal  || 0;
      byVend[key].valorCobrar += r.valorCobrar || 0;
      byVend[key].vendas.push(r);
    }
    res.json(Object.values(byVend).sort((a, b) => b.valorCobrar - a.valorCobrar));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Saldo Reserva (cobrança antecipada não lançada no Microvix) ──────────────
let _saldoReservaColReady = false;
async function getSaldoReservaCol() {
  if (!mongoDb) throw new Error('MongoDB não conectado');
  const col = mongoDb.collection('confSaldoReserva');
  if (!_saldoReservaColReady) {
    _saldoReservaColReady = true;
    col.createIndex({ board: 1, mod: 1, bandeira: 1 }, { unique: true, background: true }).catch(() => {});
  }
  return col;
}

// GET /api/conferencia/saldo-reserva?board=X
app.get('/api/conferencia/saldo-reserva', requireAuth, async (req, res) => {
  try {
    const { board } = req.query;
    if (!board) return res.status(400).json({ error: 'board obrigatório' });
    const col   = await getSaldoReservaCol();
    const docs  = await col.find({ board }).toArray();
    // retorna map: { 'crédito::visa': { valor, obs, updatedBy, updatedAt } }
    const map = {};
    for (const d of docs) map[d.mod + '::' + d.bandeira] = { valor: d.valor, obs: d.obs || '', updatedBy: d.updatedBy, updatedAt: d.updatedAt };
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conferencia/saldo-reserva
app.post('/api/conferencia/saldo-reserva', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, mod, bandeira, valor, obs } = req.body;
    if (!board || !mod) return res.status(400).json({ error: 'board e mod obrigatórios' });
    const col = await getSaldoReservaCol();
    const updatedBy = req.session?.user?.username || 'sistema';
    const v = parseFloat(valor) || 0;
    if (v <= 0) {
      await col.deleteOne({ board, mod, bandeira: bandeira || '' });
    } else {
      await col.updateOne(
        { board, mod, bandeira: bandeira || '' },
        { $set: { board, mod, bandeira: bandeira || '', valor: v, obs: obs || '', updatedBy, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/debug-doc?board=X&date=Y&doc=Z  — diagnóstico de formas de um doc específico
app.get('/api/conferencia/debug-doc', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, date, doc } = req.query;
    if (!board || !date) return res.status(400).json({ error: 'board e date obrigatórios' });
    const result = await _buildConferenciaVendas(board, date, date);
    const vendas = result.vendas || [];
    if (doc) {
      const venda = vendas.find(v => String(v.doc) === String(doc));
      if (!venda) return res.json({ error: `doc ${doc} não encontrado`, totalVendas: result.totalVendas, qtd: vendas.length });
      const sumFormas = venda.formas.reduce((s, f) => s + f.valor, 0);
      return res.json({
        doc:        venda.doc,
        valorTotal: +venda.valorTotal.toFixed(2),
        sumFormas:  +sumFormas.toFixed(2),
        gap:        +(venda.valorTotal - sumFormas).toFixed(2),
        formas:     venda.formas.map(f => ({ forma: f.forma, bandeira: f.bandeira||'—', valor: +f.valor.toFixed(2) })),
        desconto:   venda.desconto,
        itens:      venda.itens.map(i => ({ cod: i.cod_produto, desc: i.descricao, vlrBruto: +i.vlrBruto.toFixed(2), vlrLiquido: +i.vlrLiquido.toFixed(2), vlrDesconto: +i.vlrDesconto.toFixed(2) })),
      });
    }
    // Sem doc: retorna sumário por forma e docsComGap
    return res.json({
      totalVendas: +result.totalVendas.toFixed(2),
      qtdVendas:   result.qtdVendas,
      porForma:    result.porForma.map(f => ({ forma: f.forma, bandeira: f.bandeira||'—', total: +f.total.toFixed(2) })),
      docsComGap:  result.docsComGap || [],
    });
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// ── Confirmações Manuais (PIX direto, Cielo, etc.) ──────────────────────────
let _confirmacoesManualColReady = false;
async function getConfirmacoesManualCol() {
  if (!mongoDb) throw new Error('MongoDB não conectado');
  const col = mongoDb.collection('confConfirmacoesManual');
  if (!_confirmacoesManualColReady) {
    _confirmacoesManualColReady = true;
    col.createIndex({ board: 1, date: 1 }, { unique: true, background: true }).catch(() => {});
  }
  return col;
}

// GET /api/conferencia/confirmacoes-manuais?board=X&date=Y
app.get('/api/conferencia/confirmacoes-manuais', requireAuth, async (req, res) => {
  try {
    const { board, date } = req.query;
    if (!board || !date) return res.status(400).json({ error: 'board e date obrigatórios' });
    const col = await getConfirmacoesManualCol();
    const doc = await col.findOne({ board, date });
    res.json(doc ? { entries: doc.entries || {}, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt } : { entries: {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conferencia/confirmacoes-manuais
app.post('/api/conferencia/confirmacoes-manuais', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, date, entries } = req.body;
    if (!board || !date) return res.status(400).json({ error: 'board e date obrigatórios' });
    const col  = await getConfirmacoesManualCol();
    const updatedBy = req.session?.user?.username || 'sistema';
    await col.updateOne(
      { board, date },
      { $set: { board, date, entries: entries || {}, updatedBy, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campanhas promocionais da conferência ─────────────────────────────────
// Uma campanha autoriza, para os itens que casam com o filtro, o desconto que
// os alertas normalmente acusariam. Ex.: "compra 1 leve 2" libera 50% nas
// t-shirts até a coleção WINTER 25; "chinelo Mizuno a 200" libera a marca que
// não aceita desconto desde que o preço unitário fique em pelo menos R$ 200.
function _campNorm(s) {
  return String(s || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Lista vazia não restringe. Aceita curinga "*" (ex.: "WINTER*").
function _campMatchLista(lista, valor) {
  if (!Array.isArray(lista) || !lista.length) return true;
  const v = _campNorm(valor);
  if (!v) return false;
  return lista.some(p => {
    const pn = _campNorm(p);
    if (!pn) return false;
    if (!pn.includes('*')) return pn === v;
    const re = new RegExp('^' + pn.split('*')
      .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(v);
  });
}

// "até WINTER 25" usa a ordem cadastrada em db.confColecoes (mais antiga →
// mais nova). Coleção fora da lista não é liberada — na dúvida, alerta.
function _campColecaoOk(filtro, colecaoItem, ordem) {
  if (Array.isArray(filtro.colecoes) && filtro.colecoes.length)
    return _campMatchLista(filtro.colecoes, colecaoItem);
  if (!filtro.colecaoAte) return true;
  const lista   = Array.isArray(ordem) ? ordem : [];
  const idxAte  = lista.findIndex(c => _campNorm(c) === _campNorm(filtro.colecaoAte));
  const idxItem = lista.findIndex(c => _campNorm(c) === _campNorm(colecaoItem));
  if (idxAte < 0 || idxItem < 0) return false;
  return idxItem <= idxAte;
}

// Primeira campanha vigente que cobre o item (ou null)
function _campanhaDoItem(campanhas, ordem, ctx) {
  if (!Array.isArray(campanhas) || !campanhas.length) return null;
  return campanhas.find(c => {
    if (c.ativa === false) return false;
    if (c.inicio && ctx.data && ctx.data < c.inicio) return false;
    if (c.fim    && ctx.data && ctx.data > c.fim)    return false;
    if (Array.isArray(c.lojas) && c.lojas.length && !c.lojas.includes(ctx.board)) return false;
    const f = c.filtro || {};
    if (!_campMatchLista(f.marcas,  ctx.marca)) return false;
    if (!_campMatchLista(f.setores, ctx.setor)) return false;
    if (Array.isArray(f.refs) && f.refs.length &&
        !_campMatchLista(f.refs, ctx.referencia) && !_campMatchLista(f.refs, ctx.cod)) return false;
    if (f.descContem && !_campNorm(ctx.descricao).includes(_campNorm(f.descContem))) return false;
    if (!_campColecaoOk(f, ctx.colecao, ordem)) return false;
    return true;
  }) || null;
}

// A campanha cobre o item, mas o preço praticado atende ao que ela permite?
// Condições preenchidas são cumulativas; campanha sem condição libera o item.
function _campanhaLibera(camp, { precoUnit, percDesc }) {
  const p = camp?.permite || {};
  let ok = true;
  if (p.precoMinimo != null && p.precoMinimo !== '' && +p.precoMinimo > 0)
    ok = ok && precoUnit >= +p.precoMinimo - 0.005;
  if (p.descontoMaxItem != null && p.descontoMaxItem !== '')
    ok = ok && percDesc <= +p.descontoMaxItem + 0.05;
  return ok;
}

// GET /api/conferencia/colecoes — ordem cronológica das coleções
app.get('/api/conferencia/colecoes', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.confColecoes || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/conferencia/colecoes — body: ["WINTER 23","SUMMER 24",...] (antiga → nova)
app.put('/api/conferencia/colecoes', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const lista = Array.isArray(req.body) ? req.body : (req.body?.colecoes || []);
    const db = await readDB();
    db.confColecoes = lista.map(c => String(c).trim()).filter(Boolean);
    await writeDB(db);
    res.json({ ok: true, colecoes: db.confColecoes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/campanhas
app.get('/api/conferencia/campanhas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.confCampanhas || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/conferencia/campanhas — body: [ {nome, ativa, inicio, fim, lojas[], filtro{}, permite{}}, ... ]
app.put('/api/conferencia/campanhas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : (req.body?.campanhas || []);
    const db  = await readDB();
    const norm = s => String(s || '').trim();
    const tags = v => (Array.isArray(v) ? v : String(v || '').split(','))
      .map(x => String(x).trim()).filter(Boolean);
    const numOrNull = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
    db.confCampanhas = arr.map(c => ({
      id:     c.id || nextId(db),
      nome:   norm(c.nome) || 'Campanha',
      ativa:  c.ativa !== false,
      inicio: norm(c.inicio), fim: norm(c.fim),
      lojas:  tags(c.lojas),
      filtro: {
        marcas:     tags(c.filtro?.marcas),
        setores:    tags(c.filtro?.setores),
        refs:       tags(c.filtro?.refs),
        colecoes:   tags(c.filtro?.colecoes),
        colecaoAte: norm(c.filtro?.colecaoAte),
        descContem: norm(c.filtro?.descContem),
      },
      permite: {
        descontoMaxItem: numOrNull(c.permite?.descontoMaxItem),
        precoMinimo:     numOrNull(c.permite?.precoMinimo),
      },
      updatedBy: req.session.user.username,
      updatedAt: new Date().toISOString(),
    }));
    await writeDB(db);
    res.json({ ok: true, campanhas: db.confCampanhas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Função extraída para reuso no board=all
async function _buildConferenciaVendas(board, dtIni, dtFin) {
  const db    = await readDB();
  const regra = (db.confRegras || {})[board] || {};
  const parcelaMin           = parseFloat(regra.parcelaMin      || 0);
  const descontoMaxItem      = parseFloat(regra.descontoMaxItem || 100);
  const descontoMaxVenda     = parseFloat(regra.descontoMaxVenda|| 100);
  const descontoSomenteAVista= regra.descontoSomenteAVista === true || regra.descontoSomenteAVista === 'true';
  const marcasSemDesconto    = Array.isArray(regra.marcasSemDesconto) ? regra.marcasSemDesconto.map(m => m.trim().toUpperCase()) : [];

  const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const cnpj  = lojas[board];
  if (!cnpj) throw new Error(`Loja "${board}" não configurada`);

  // Campanhas promocionais: liberam itens dos alertas de desconto
  const promoCfg = { campanhas: db.confCampanhas || [], colecoes: db.confColecoes || [] };

  // Reutiliza todo o código do handler movendo req/res para fora
  // Chama o handler interno via _buildConferenciaVendasCore
  return _buildConferenciaVendasCore(board, dtIni, dtFin, regra, parcelaMin, descontoMaxItem, descontoMaxVenda, descontoSomenteAVista, marcasSemDesconto, cnpj, promoCfg);
}

// GET /api/conferencia/vendas?board=delrey&dtIni=2026-06-01&dtFin=2026-06-08
// board=all: busca todas as lojas em paralelo, retorna apenas vendas com alertas
// Retorna TODAS as vendas do período com formas de pagamento, vendedor e alertas de regra
app.get('/api/conferencia/vendas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!board || !dtIni || !dtFin) return res.status(400).json({ error: 'board, dtIni e dtFin obrigatórios' });

    // ── board=all: busca todas as lojas em paralelo ──────────────────────────
    if (board === 'all') {
      const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
      const boards = Object.keys(lojas);
      if (!boards.length) return res.status(400).json({ error: 'Nenhuma loja configurada em MICROVIX_LOJAS' });
      const results = await Promise.allSettled(boards.map(b => _buildConferenciaVendas(b, dtIni, dtFin)));
      const allVendas = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value?.vendas)) {
          for (const v of r.value.vendas) {
            if (v.alertas?.length > 0) allVendas.push(v);
          }
        }
      }
      allVendas.sort((a, b) => (a.board + a.data + a.hora).localeCompare(b.board + b.data + b.hora));
      const totalVendas = allVendas.reduce((s, v) => s + v.valorTotal, 0);
      return res.json({
        board: 'all', dtIni, dtFin, regra: {},
        totalVendas, totalAlertas: allVendas.length, qtdVendas: allVendas.length,
        vendas: allVendas,
        porForma: [], porVendedor: [],
      });
    }

    if (board === 'surfers') {
      const surferBoards = ['delrey','minas','contagem','estacao','site'];
      const results = await Promise.allSettled(surferBoards.map(b => _buildConferenciaVendas(b, dtIni, dtFin)));
      const allVendas = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value?.vendas)) allVendas.push(...r.value.vendas);
      }
      allVendas.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
      const totalVendas = allVendas.reduce((s, v) => s + v.valorTotal, 0);
      return res.json({ board: 'surfers', dtIni, dtFin, totalVendas, qtdVendas: allVendas.length, vendas: allVendas, porForma: [], porVendedor: [] });
    }

    const result = await _buildConferenciaVendas(board, dtIni, dtFin);
    return res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function _buildConferenciaVendasCore(board, dtIni, dtFin, regra, parcelaMin, descontoMaxItem, descontoMaxVenda, descontoSomenteAVista, marcasSemDesconto, cnpj, promoCfg = {}) {
    const campanhas    = Array.isArray(promoCfg.campanhas) ? promoCfg.campanhas : [];
    const colecaoOrdem = Array.isArray(promoCfg.colecoes)  ? promoCfg.colecoes  : [];
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');

    const { fetchMovimento, fetchMovimentoPlanos, fetchMovimentoCartoes,
            fetchLinxPlanos, fetchLinxPlanosBandeiras, fetchVendedores,
            fetchProdutosPromocoes, parseBrNum } = require('./services/microvix');

    const promoPromise = _promoIsValid(cnpj)
      ? Promise.resolve(_promoGet(cnpj))
      : fetchProdutosPromocoes(cnpj, dtIni, dtFin, chave).then(rows => { _promoSet(cnpj, rows); return rows; }).catch(() => []);

    const [movRows, planoRows, cartoesRows, planosCatalog, bandeirasCatalog, vendedoresRows, promoRows, catalog] = await Promise.all([
      fetchMovimento(cnpj, dtIni, dtFin, chave).catch(e => { throw e; }), // propaga erro mas com timeout já garantido no postRequest
      fetchMovimentoPlanos(cnpj, dtIni, dtFin, chave).catch(() => []),
      fetchMovimentoCartoes(cnpj, dtIni, dtFin, chave).catch(() => []),
      _cachedFetch('planos', cnpj, () => fetchLinxPlanos(cnpj, chave)).catch(() => []),
      _cachedFetch('bandeiras', cnpj, () => fetchLinxPlanosBandeiras(cnpj, chave)).catch(() => []),
      _cachedFetch('vendedores', cnpj, () => fetchVendedores(cnpj, chave)).catch(() => []),
      promoPromise,
      Promise.race([_getCatalog(lojas), new Promise(r => setTimeout(() => r({}), 20_000))]).catch(() => ({})),
    ]);

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    // Mapa de preços promocionais: cod_produto → preco_promocao
    // Filtra apenas promoções vigentes hoje (API retorna range amplo)
    // Datas da API vêm em DD/MM/YYYY HH:MM:SS — parser manual para evitar interpretação MM/DD
    // O Microvix pode retornar o campo de preco com diferentes nomes dependendo da versão
    const parseBRDt = s => { const m = String(s||'').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], +m[2]-1, +m[1]) : null; };
    const agora = new Date();
    const promoMap = {};
    for (const p of (Array.isArray(promoRows) ? promoRows : [])) {
      const cod   = String(p.cod_produto || p.codigo_produto || p.codigo || '').trim();
      const preco = parseBR(
        p.preco_promocao || p.preco_venda_promocao || p.preco_promo ||
        p.preco_venda_promo || p.preco_venda || p.valor || '0'
      );
      if (!cod || preco <= 0) continue;
      const inicio = parseBRDt(p.data_inicio_promocao);
      const fim2   = parseBRDt(p.data_termino_promocao);
      if (inicio && fim2 && (agora < inicio || agora > fim2)) continue;
      promoMap[cod] = preco;
    }

    // Catálogos
    const vendNomeCache = {};
    for (const v of vendedoresRows) {
      const cod = String(v.cod_vendedor || v.codigo || '').trim();
      const nome = (v.nome_vendedor || v.nome || '').trim();
      if (cod && nome) vendNomeCache[cod] = nome;
    }
    const planoNomeMap = {};
    for (const p of planosCatalog) {
      const cod  = String(p.cod_plano || p.codigo || p.id || '').trim();
      const nome = (p.descricao || p.desc_plano || p.nome || '').trim();
      if (cod && nome) planoNomeMap[cod] = nome;
    }
    const bandeiraNomeMap = {};
    for (const b of bandeirasCatalog) {
      const cod  = String(b.cod_bandeira || b.id_bandeira || b.cod || '').trim();
      const nome = (b.desc_bandeira || b.nome_bandeira || b.bandeira || b.nome || '').trim();
      if (cod && nome) bandeiraNomeMap[cod] = nome;
    }

    function extractBandeira(descPlano) {
      const d = (descPlano || '').toUpperCase();
      if (/MAESTRO/.test(d))              return 'Maestro';
      if (/MASTER/.test(d))               return 'Mastercard';
      if (/VISA/.test(d))                 return 'Visa';
      if (/\bELO\b/.test(d))              return 'Elo';
      if (/AMEX|AMERICAN EXPRESS/.test(d))return 'Amex';
      if (/HIPERCARD|HIPER/.test(d))      return 'Hipercard';
      if (/DINERS/.test(d))               return 'Diners';
      if (/ALELO/.test(d))                return 'Alelo';
      if (/SODEXO/.test(d))               return 'Sodexo';
      if (/\bVR\b/.test(d))               return 'VR';
      return '';
    }
    function buildForma(formaPgto, tipoTransacao, descPlano) {
      const f = (formaPgto || '').trim();
      const t = (tipoTransacao || '').trim().toUpperCase();
      const d = (descPlano   || '').toUpperCase();
      if (/pix/i.test(f) || /\bpix\b/.test(d)) return 'PIX';
      if (t === 'C') return 'Cartão Crédito';
      if (t === 'D') return 'Cartão Débito';
      if (/cart[aã]o/i.test(f)) return 'Cartão Crédito';
      if (/d[eé]bito/i.test(f)) return 'Cartão Débito';
      if (/cr[eé]dito/i.test(f))return 'Cartão Crédito';
      return f || 'Outros';
    }

    // ── Processar LinxMovimento ─────────────────────────────────────────────
    // LinxMovimento retorna UMA LINHA POR ITEM — agrupamos por documento
    const identMap = {};
    const docMap   = {}; // doc → { doc, data, hora, valorTotal, vendedorCod, vendedorNome, formas[], alertas[], itens[] }

    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (!rowCnpj || rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      // soma_relatorio='N' indica lançamento interno/ajuste que não deve aparecer em relatórios
      if ((r.soma_relatorio || 'S').toUpperCase() === 'N') continue;
      const op    = (r.operacao || '').trim().toUpperCase();
      if (op !== 'S' && op !== 'DS') continue;
      // tipo_transacao 'J' sem documento = ajuste de balanço/estoque (Tommy: FALTA BALANÇO)
      if ((r.tipo_transacao || '').trim().toUpperCase() === 'J' && String(r.documento || '').trim() === '0') continue;
      const serie = String(r.serie || r.serie_documento || '').trim();
      if (serie === '999') continue;
      // Série 4: processa normalmente — pós-filtro vai remover os de total positivo (transferências internas)
      const doc   = String(r.documento || '').trim();
      const ident = String(r.identificador || '').trim();
      if (!doc) continue;
      if (ident && !identMap[ident]) identMap[ident] = doc;

      const sign = op === 'DS' ? -1 : 1;

      // Cria entrada do documento na primeira linha encontrada
      if (!docMap[doc]) {
        const cod  = String(r.cod_vendedor || '').trim();
        // nome_vendedor não existe no LinxMovimento; extrai do campo obs como fallback
        const obsNome = (r.obs || '').match(/Nome do Vendedor:\s*(.+?)(?:\s*\|.*)?$/i);
        const nome = (r.nome_vendedor || (obsNome && obsNome[1]) || '').trim();
        // data_documento vem como "DD/MM/YYYY" no Microvix
        const rawDate = String(r.data_documento || r.data_emissao || r.data || '').trim();
        const mD = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        const dataISO = mD ? `${mD[3]}-${mD[2]}-${mD[1]}` : rawDate.slice(0, 10);
        docMap[doc] = {
          doc,
          board,
          serie,
          data:         dataISO,
          hora:         String(r.hora_lancamento || r.hora_documento || r.hora_emissao || '').trim().slice(0, 5),
          valorTotal:   0, // acumulado abaixo a partir de valor_liquido de cada item
          vendedorCod:  cod,
          vendedorNome: vendNomeCache[cod] || nome || cod,
          formas:  [],
          alertas: [],
          itens:   [],
          codPlano: String(r.cod_plano || r.plano || '').trim(),
          sign,
        };
      }

      // Cada linha do LinxMovimento é um item da venda
      const qty       = parseBR(r.quantidade || '1');
      const vlrUnit   = parseBR(r.preco_tabela_epoca || r.preco_unitario || '0'); // preço bruto de tabela
      const vlrLiq    = parseBR(r.preco_unitario || r.valor_liquido || '0');      // preço vendido (já com desconto)
      const vlrDesc   = parseBR(r.desconto_item || r.desconto_total_item || '0'); // desconto por item
      const vlrBruto  = vlrUnit * qty;
      const vlrLiqTot = vlrLiq * qty;
      const percItem  = vlrBruto > 0 && vlrDesc > 0 ? (vlrDesc / vlrBruto) * 100 : 0;

      // Acumula o total da venda somando preco_unitario × quantidade
      docMap[doc].valorTotal += docMap[doc].sign * vlrLiqTot;

      if (vlrUnit > 0 || vlrLiq > 0) {
        const codProd      = String(r.cod_produto || '').trim();
        const precoPromo   = promoMap[codProd] || null;
        const emPromocao   = !!precoPromo;

        const catInfo = catalog[codProd] || {};

        // Campanha promocional que cobre este item, se houver
        const _descItem = (catInfo.nome || catInfo.nomeBase || r.descricao || r.nome_produto || '').trim();
        const _percItem = vlrBruto > 0 && vlrDesc > 0 ? (vlrDesc / vlrBruto) * 100 : 0;
        const camp = _campanhaDoItem(campanhas, colecaoOrdem, {
          board, data: docMap[doc].data,
          marca:      (catInfo.marca  || '').trim(),
          setor:      (catInfo.setor  || r.desc_setor || '').trim(),
          colecao:    (catInfo.linha  || '').trim(),
          referencia: (catInfo.referencia || r.referencia || '').trim(),
          cod:        codProd,
          descricao:  _descItem,
        });
        const campOk = camp ? _campanhaLibera(camp, { precoUnit: vlrLiq, percDesc: _percItem }) : false;

        docMap[doc].itens.push({
          cod_produto:  codProd,
          referencia:   (catInfo.referencia || r.referencia || '').trim(),
          descricao:    (r.descricao || r.nome_produto || r.referencia || codProd || '—').trim(),
          nome:         (catInfo.nome || catInfo.nomeBase || '').trim(),
          colecao:      (catInfo.linha || '').trim(),
          marca:        (catInfo.marca || '').trim(),
          setor:        (catInfo.setor || r.desc_setor || '').trim(),
          quantidade:   qty,
          vlrUnitario:  +vlrUnit.toFixed(2),
          vlrBruto:     +vlrBruto.toFixed(2),
          vlrLiquido:   +vlrLiqTot.toFixed(2),
          vlrDesconto:  +vlrDesc.toFixed(2),
          percDesconto: +percItem.toFixed(1),
          emPromocao,
          precoPromocao: precoPromo,
          campanha:     camp ? camp.nome : null,
          campanhaOk:   campOk,
        });

        // Se tem preço promo: desconto é relativo ao preço promo, não ao de tabela
        // Vendeu >= promo → ok. Vendeu < promo → alerta com diferença.
        const vlrLiqUnit   = vlrLiq; // preço unitário vendido
        const baseDesconto = emPromocao ? precoPromo : vlrUnit; // base para cálculo de desconto
        const abaixoPromo  = emPromocao && vlrLiqUnit < precoPromo && vlrLiqUnit > 0;
        const descAjustado = emPromocao ? Math.max(0, (precoPromo - vlrLiqUnit) * qty) : vlrDesc * qty;
        const percAjustado = baseDesconto > 0 && descAjustado > 0 ? (descAjustado / (baseDesconto * qty)) * 100 : 0;

        // campOk = campanha vigente cobre o item e o preço praticado respeita o
        // que ela permite → o desconto foi autorizado, não vira alerta.
        if (abaixoPromo && !campOk) {
          docMap[doc].alertas.push({
            tipo: 'desconto_item',
            msg:  `"${(r.descricao || r.referencia || codProd || '').trim()}" vendido abaixo do preço promo (R$${vlrLiqUnit.toFixed(2)} < R$${precoPromo.toFixed(2)})`,
          });
        } else if (!emPromocao && !campOk && descontoMaxItem < 100 && percItem > descontoMaxItem && vlrDesc > 0) {
          docMap[doc].alertas.push({
            tipo: 'desconto_item',
            msg:  `"${(r.descricao || r.referencia || codProd || '').trim()}" ${percItem.toFixed(1)}% desc (máx ${descontoMaxItem}%)`,
          });
        }
        // Alerta: marca sem desconto — não dispara se tem promo e vendeu >= promo
        const marcaItem    = (catInfo.marca || '').trim().toUpperCase();
        const cobertoPelaPromo = (emPromocao && !abaixoPromo) || campOk;
        if (marcasSemDesconto.length && marcaItem && marcasSemDesconto.includes(marcaItem) && vlrDesc > 0 && !cobertoPelaPromo) {
          docMap[doc].alertas.push({
            tipo: 'marca_sem_desconto',
            msg:  `"${(r.descricao || r.referencia || codProd || '').trim()}" (${catInfo.marca}) não permite desconto`,
          });
        }
      }
    }

    // Alertas de desconto por venda e totais de desconto
    for (const d of Object.values(docMap)) {
      const totalBruto   = d.itens.reduce((s, i) => s + i.vlrBruto, 0);
      const totalDesc    = d.itens.reduce((s, i) => s + i.vlrDesconto, 0);
      const totalLiquido = d.itens.reduce((s, i) => s + i.vlrLiquido, 0);
      // Vendas com líquido > bruto (ex: acréscimo de parcelamento) não geram alertas de desconto
      const liquidoAcimaBruto = totalLiquido > totalBruto + 0.01;
      if (totalDesc > 0 || totalBruto > 0) {
        d.desconto = {
          valor: +totalDesc.toFixed(2),
          perc:  totalBruto > 0 ? +((totalDesc / totalBruto) * 100).toFixed(1) : 0,
        };
        // O % da venda ignora os itens liberados por campanha — senão um
        // "compra 1 leve 2" estouraria o limite da venda inteira.
        const livres     = d.itens.filter(i => !i.campanhaOk);
        const brutoLivre = livres.reduce((s, i) => s + i.vlrBruto,    0);
        const descLivre  = livres.reduce((s, i) => s + i.vlrDesconto, 0);
        if (!liquidoAcimaBruto && descontoMaxVenda < 100 && brutoLivre > 0 && descLivre > 0) {
          const percV = (descLivre / brutoLivre) * 100;
          if (percV > descontoMaxVenda) {
            const nota = livres.length < d.itens.length ? ' — fora os itens em campanha' : '';
            d.alertas.push({
              tipo: 'desconto_venda',
              msg:  `Desconto total ${percV.toFixed(1)}% na venda (máx ${descontoMaxVenda}%)${nota}`,
            });
          }
        }
        // Remove alertas de item gerados anteriormente se líquido > bruto
        if (liquidoAcimaBruto) {
          d.alertas = d.alertas.filter(a => a.tipo !== 'desconto_item' && a.tipo !== 'marca_sem_desconto');
        }
      }
    }

    // ── Formas de pagamento via LinxMovimentoPlanos ─────────────────────────
    const docFormaMap = {};
    for (const r of planoRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (!rowCnpj || rowCnpj !== cnpjClean) continue;
      const ident = String(r.identificador || '').trim();
      const doc   = (ident && identMap[ident]) || String(r.documento || '').trim();
      if (!doc || !docMap[doc]) continue;
      const sign    = docMap[doc].valorTotal < 0 ? -1 : 1;
      const descP   = (r.desc_plano || '').trim();
      const forma   = buildForma(r.forma_pgto, r.tipo_transacao, descP);
      const isPix   = forma === 'PIX';
      const isCard  = !isPix && /(C|D)/.test((r.tipo_transacao || '').toUpperCase());
      const bandeira= isCard ? extractBandeira(descP) : '';
      const valor   = parseBR(r.total || r.valor || r.valor_plano || '0');
      if (valor === 0) continue;
      // parcelas: usa qtde_parcelas diretamente ou extrai do desc_plano (ex: "MASTER 3X")
      const parcelas = parseInt(r.qtde_parcelas || '') || (() => {
        const m = descP.toUpperCase().match(/\b(\d+)\s*X\b/);
        return m ? parseInt(m[1]) : 1;
      })();
      if (!docFormaMap[doc]) docFormaMap[doc] = [];
      docFormaMap[doc].push({ forma, bandeira, descPlano: descP, valor: sign * valor, tipoTrans: (r.tipo_transacao || '').toUpperCase(), parcelas });
    }

    // Fallback: LinxMovimentoCartoes (sobrescreve bandeiras de cartão)
    for (const r of cartoesRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (!rowCnpj || rowCnpj !== cnpjClean) continue;
      const doc = String(r.cupomfiscal || r.documento || '').trim();
      if (!doc || !docMap[doc]) continue;
      const cd       = String(r.credito_debito || '').trim().toUpperCase();
      const forma    = cd === 'D' ? 'Cartão Débito' : 'Cartão Crédito';
      // Normaliza a bandeira para o nome canônico (portal Tommy manda nomes verbosos
      // como "VISA ELECTRON"/"MAESTRO") para casar com o extrato Rede.
      const bandeiraRaw = (r.descricao_bandeira || r.bandeira || '').trim();
      const bandeira    = extractBandeira(bandeiraRaw) || bandeiraRaw;
      const valor    = parseBR(r.valor || '0');
      if (valor === 0) continue;
      const sign = docMap[doc].valorTotal < 0 ? -1 : 1;
      const existing = (docFormaMap[doc] || []).filter(f => !/cart[aã]o/i.test(f.forma));
      if (!docFormaMap[doc]) docFormaMap[doc] = [...existing];
      else docFormaMap[doc] = existing;
      docFormaMap[doc].push({ forma, bandeira, descPlano: bandeira, valor: sign * valor, tipoTrans: cd });
    }

    // Popula formas em cada doc
    for (const [doc, formas] of Object.entries(docFormaMap)) {
      if (docMap[doc]) docMap[doc].formas = formas;
    }
    // Docs sem formas: usa cod_plano como fallback
    for (const d of Object.values(docMap)) {
      if (d.formas.length === 0 && d.codPlano && planoNomeMap[d.codPlano]) {
        const nome = planoNomeMap[d.codPlano];
        d.formas = [{ forma: nome, bandeira: '', descPlano: nome, valor: d.valorTotal, tipoTrans: '' }];
      }
    }

    // Fallback PIX: lê total_pix diretamente do LinxMovimento (mesmo método usado no botão Caixa)
    // Garante que PIX apareça mesmo quando LinxMovimentoPlanos não retorna a entrada separada
    for (const r of movRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (!rowCnpj || rowCnpj !== cnpjClean) continue;
      const doc = String(r.documento || '').trim();
      if (!doc || !docMap[doc]) continue;
      const vlrPix = parseBR(r.total_pix || '0');
      if (vlrPix === 0) continue;
      // Só adiciona se o doc ainda não tem PIX nas formas
      const jaTemPix = (docFormaMap[doc] || []).some(f => /pix/i.test(f.forma));
      if (jaTemPix) continue;
      const sign = docMap[doc].valorTotal < 0 ? -1 : 1;
      if (!docFormaMap[doc]) docFormaMap[doc] = [];
      docFormaMap[doc].push({ forma: 'PIX', bandeira: '', descPlano: 'PIX', valor: sign * vlrPix, tipoTrans: '' });
      docMap[doc].formas = docFormaMap[doc];
      // Quando LinxMovimentoPlanos reporta Dinheiro com o valor cheio (inclui o PIX),
      // o fallback PIX duplica o valor. Detecta e corrige deduzindo o PIX do Dinheiro.
      const sumComPix = docFormaMap[doc].reduce((s, f) => s + f.valor, 0);
      const excesso   = +(sumComPix - docMap[doc].valorTotal).toFixed(2);
      if (excesso > 0.02) {
        let restante = excesso;
        for (const f of docFormaMap[doc]) {
          if (/dinheiro|esp[eé]cie/i.test(f.forma) && f.valor > 0) {
            const deduz = Math.min(f.valor, restante);
            f.valor    = +(f.valor - deduz).toFixed(2);
            restante   = +(restante - deduz).toFixed(2);
            if (restante <= 0.01) break;
          }
        }
        // Remove formas zeradas
        docMap[doc].formas = docFormaMap[doc].filter(f => Math.abs(f.valor) > 0.01);
        docFormaMap[doc]   = docMap[doc].formas;
      }
    }

    // ── Desconto no total da venda: redistribui proporcionalmente nos itens ──
    for (const d of Object.values(docMap)) {
      if (!d.formas.length || d.itens.length === 0) continue;
      const sumFormas = +d.formas.reduce((s, f) => s + f.valor, 0).toFixed(2);
      // Em docs negativos (troca/devolução) o "desconto" aparece invertido: o valor calculado
      // pelos itens (preço cheio) é mais negativo que as formas de pagamento (valor líquido
      // realmente pago/devolvido). Multiplica pelo sinal do doc para tratar os dois casos
      // com a mesma lógica de distribuição abaixo.
      const signDoc   = d.valorTotal < 0 ? -1 : 1;
      const descTotal = +(signDoc * (d.valorTotal - sumFormas)).toFixed(2);
      if (descTotal <= 0.02) continue;
      const totalBruto = d.itens.reduce((s, i) => s + i.vlrBruto, 0);
      if (totalBruto > 0) {
        let distribuido = 0;
        for (let i = 0; i < d.itens.length; i++) {
          const it = d.itens[i];
          const descItem = i < d.itens.length - 1
            ? +(descTotal * (it.vlrBruto / totalBruto)).toFixed(2)
            : +(descTotal - distribuido).toFixed(2);
          it.vlrDesconto = +(it.vlrDesconto + descItem).toFixed(2);
          it.vlrLiquido  = +(it.vlrLiquido  - descItem).toFixed(2);
          distribuido += descItem;
        }
      }
      d.valorTotal = sumFormas;
      const totalDescItens = d.itens.reduce((s, i) => s + i.vlrDesconto, 0);
      d.desconto = {
        valor: +totalDescItens.toFixed(2),
        perc:  totalBruto > 0 ? +((totalDescItens / totalBruto) * 100).toFixed(1) : 0,
      };
    }

    // ── Alertas: parcela mínima ─────────────────────────────────────────────
    if (parcelaMin > 0) {
      for (const r of planoRows) {
        const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
        if (!rowCnpj || rowCnpj !== cnpjClean) continue;
        const ident = String(r.identificador || '').trim();
        const doc   = (ident && identMap[ident]) || String(r.documento || '').trim();
        if (!doc || !docMap[doc]) continue;
        if ((r.tipo_transacao || '').toUpperCase() !== 'C') continue;
        // qtde_parcelas é campo direto no LinxMovimentoPlanos
        const nP = parseInt(r.qtde_parcelas || '') || (() => {
          const mP = (r.desc_plano || '').toUpperCase().match(/\b(\d+)\s*X\b/);
          return mP ? parseInt(mP[1]) : 1;
        })();
        if (nP <= 1) continue;
        const vlrLiqVenda = Math.abs(docMap[doc].valorTotal || 0);
        const vlrParc     = vlrLiqVenda > 0 ? vlrLiqVenda / nP : parseBR(r.total || r.valor || r.valor_plano || '0') / nP;
        if (vlrParc < parcelaMin && vlrParc > 0) {
          docMap[doc].alertas.push({
            tipo: 'parcela_minima',
            msg:  `Parcela de R$ ${vlrParc.toFixed(2)} abaixo do mínimo (${nP}x em ${r.desc_plano})`,
          });
        }
      }
    }


    // ── Alerta: desconto somente à vista ───────────────────────────────────
    // Débito, PIX, dinheiro e crédito 1x = à vista. Crédito 2x+ = parcelado.
    if (descontoSomenteAVista) {
      for (const d of Object.values(docMap)) {
        if (!d.desconto || d.desconto.valor <= 0) continue;
        const temParcelado = d.formas.some(f =>
          f.tipoTrans === 'C' && (f.parcelas || 1) > 1
        );
        if (!temParcelado) continue;
        // Não alerta se todos os itens com desconto estão cobertos por promoção
        // (vendido >= preço promo → promoção se aplica também em parcelado)
        const itensCobertos = d.itens.every(it =>
          it.vlrDesconto <= 0 || it.campanhaOk ||
          (it.emPromocao && it.precoPromocao && it.vlrLiquido / it.quantidade >= it.precoPromocao)
        );
        if (itensCobertos) continue;
        const parcInfo = d.formas
          .filter(f => f.tipoTrans === 'C' && (f.parcelas || 1) > 1)
          .map(f => `${f.bandeira || f.forma} ${f.parcelas}x`)
          .join(', ');
        d.alertas.push({
          tipo: 'desconto_parcelado',
          msg:  `Desconto de R$ ${d.desconto.valor.toFixed(2).replace('.',',')} concedido em venda parcelada (${parcInfo})`,
        });
      }
    }

    // ── Montar lista e agrupamentos ─────────────────────────────────────────
    const vendas = Object.values(docMap)
      // Exclui docs com total zero
      // Série 4 com total positivo = transferência interna / lançamento especial → exclui
      // Qualquer série com total negativo = devolução/troca → mantém para subtrair do total
      .filter(v => {
        if (v.valorTotal === 0) return false;
        if (v.serie === '4' && v.valorTotal > 0) return false;
        return true;
      })
      .sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora))
      .map(v => ({
        doc:          v.doc,
        board:        v.board,
        data:         v.data,
        hora:         v.hora,
        vendedor:     v.vendedorNome || v.vendedorCod || '—',
        vendedorCod:  v.vendedorCod,
        vendedorNome: v.vendedorNome,
        valorTotal:   v.valorTotal,
        formas:       v.formas,
        desconto:     v.desconto || null,
        alertas:      v.alertas,
        itens:        v.itens,
      }));

    // Agrupamento por forma de pagamento
    const porForma = {};
    for (const v of vendas) {
      const formasDoc = v.formas.length ? v.formas : [{ forma: 'Sem informação', bandeira: '', valor: v.valorTotal }];
      for (const f of formasDoc) {
        const key = f.bandeira ? `${f.forma} / ${f.bandeira}` : f.forma;
        if (!porForma[key]) porForma[key] = { label: key, forma: f.forma, bandeira: f.bandeira, total: 0, qtd: 0, vendas: [] };
        porForma[key].total += f.valor;
        porForma[key].qtd   += 1;
        if (!porForma[key].vendas.find(x => x.doc === v.doc)) porForma[key].vendas.push(v);
      }
    }

    // Agrupamento por vendedor
    const porVendedor = {};
    for (const v of vendas) {
      const key = v.vendedor || '—';
      if (!porVendedor[key]) porVendedor[key] = { label: key, total: 0, qtd: 0, vendas: [] };
      porVendedor[key].total += v.valorTotal;
      porVendedor[key].qtd   += 1;
      porVendedor[key].vendas.push(v);
    }

    // Diagnóstico: docs onde sum(formas.valor) ≠ valorTotal
    const docsComGap = vendas
      .map(v => {
        const sumF = +v.formas.reduce((s, f) => s + f.valor, 0).toFixed(2);
        const gap  = +(v.valorTotal - sumF).toFixed(2);
        if (Math.abs(gap) < 0.02) return null;
        return {
          doc:        v.doc,
          hora:       v.hora,
          vendedor:   v.vendedor,
          valorTotal: +v.valorTotal.toFixed(2),
          sumFormas:  sumF,
          gap,
          formas: v.formas.map(f => ({ forma: f.forma, bandeira: f.bandeira, valor: +f.valor.toFixed(2) })),
        };
      })
      .filter(Boolean);

    if (docsComGap.length) {
      console.log(`[conferencia/vendas] ${board} ${dtIni}: ${docsComGap.length} doc(s) com gap forma×total →`,
        docsComGap.map(g => `doc ${g.doc}: total=${g.valorTotal} formas=${g.sumFormas} gap=${g.gap} formas=[${g.formas.map(f=>`${f.forma}/${f.bandeira}:${f.valor}`).join(',')}]`).join(' | ')
      );
    }

    return {
      board, dtIni, dtFin, regra,
      totalVendas: vendas.reduce((s, v) => s + v.valorTotal, 0),
      totalAlertas: vendas.filter(v => v.alertas.length > 0).length,
      qtdVendas: vendas.length,
      vendas,
      porForma:    Object.values(porForma).sort((a, b) => b.total - a.total),
      porVendedor: Object.values(porVendedor).sort((a, b) => b.total - a.total),
      docsComGap,
    };
}

// GET /api/conferencia/debug?board=delrey&dtIni=2026-06-01&dtFin=2026-06-01
// Retorna amostras brutas das tabelas Microvix para conferir campos
app.get('/api/conferencia/debug', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!board || !dtIni || !dtFin) return res.status(400).json({ error: 'board, dtIni, dtFin obrigatórios' });
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Loja "${board}" não configurada` });
    const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');
    const { fetchMovimento, fetchMovimentoPlanos, fetchAcoesPromocionais, fetchMovimentoAcoesPromocionais, fetchProdutos, fetchProdutosPromocoes } = require('./services/microvix');
    const [movRows, planoRows, acoesRowsDbg, movAcoesRowsDbg, produtosPromoDbg] = await Promise.all([
      fetchMovimento(cnpj, dtIni, dtFin, chave).catch(e => []),
      fetchMovimentoPlanos(cnpj, dtIni, dtFin, chave).catch(e => []),
      fetchAcoesPromocionais(cnpj, chave).catch(e => ({ error: e.message })),
      fetchMovimentoAcoesPromocionais(cnpj, dtIni, dtFin, chave).catch(e => ({ error: e.message })),
      fetchProdutosPromocoes(cnpj, dtIni, dtFin, chave).catch(e => ({ error: e.message })),
    ]);

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    // Agrupa linhas por documento e calcula valores como o endpoint real faz
    const docsRaw = {}; // doc → { linhas_mov[], linhas_plano[] }
    for (const r of (Array.isArray(movRows) ? movRows : [])) {
      const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      if (r.cancelado === 'N' || !r.cancelado) {
        const op = (r.operacao||'').toUpperCase();
        if (op === 'S' || op === 'DS') {
          const doc = String(r.documento||'').trim();
          if (doc) {
            if (!docsRaw[doc]) docsRaw[doc] = { linhas_mov: [], linhas_plano: [] };
            docsRaw[doc].linhas_mov.push(r);
          }
        }
      }
    }
    for (const r of (Array.isArray(planoRows) ? planoRows : [])) {
      const ident = String(r.identificador||'').trim();
      // encontra doc pelo identificador
      const doc = Object.keys(docsRaw).find(d =>
        docsRaw[d].linhas_mov.some(m => String(m.identificador||'').trim() === ident)
      );
      if (doc) docsRaw[doc].linhas_plano.push(r);
    }

    // Para cada doc, mostra campos-chave e o que seria calculado
    const docsSample = Object.entries(docsRaw).slice(0, 5).map(([doc, d]) => {
      const computed_itens = d.linhas_mov.map(r => {
        const qty      = parseBR(r.quantidade||'1');
        const vlrUnit  = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
        const vlrLiq   = parseBR(r.preco_unitario||r.valor_liquido||'0');
        const vlrDesc  = parseBR(r.desconto_item||r.desconto_total_item||'0');
        const vlrCusto = parseBR(r.custo_medio_epoca||r.preco_custo||'0');
        const cmvItem  = vlrLiq > 0 ? (vlrCusto / vlrLiq * 100).toFixed(1) : '—';
        return {
          cod_produto:          r.cod_produto,
          quantidade:           r.quantidade,
          preco_tabela_epoca:   r.preco_tabela_epoca,
          preco_unitario:       r.preco_unitario,
          preco_custo:          r.preco_custo,
          custo_medio_epoca:    r.custo_medio_epoca,
          desconto_item:        r.desconto_item,
          '→ vlrUnitBruto':     vlrUnit.toFixed(2),
          '→ vlrLiq(unit)':     vlrLiq.toFixed(2),
          '→ vlrLiq(×qtd)':     (vlrLiq*qty).toFixed(2),
          '→ vlrCusto(unit)':   vlrCusto.toFixed(2),
          '→ vlrCusto(×qtd)':   (vlrCusto*qty).toFixed(2),
          '→ CMV_item(%)':      cmvItem + '%  [custo_medio_epoca÷preco_unitario]',
        };
      });
      const totalCalc = computed_itens.reduce((s,i) => s + parseFloat(i['→ vlrLiq(×qtd)']), 0);
      const formas = d.linhas_plano.map(r => ({
        desc_plano:    r.desc_plano,
        tipo_transacao:r.tipo_transacao,
        total:         r.total,
        qtde_parcelas: r.qtde_parcelas,
      }));
      return { doc, '→ totalVendaCalculado': totalCalc.toFixed(2), itens: computed_itens, formas };
    });

    // Filtra linhas do produto 701464 para diagnóstico
    const mov701464 = (Array.isArray(movRows) ? movRows : []).filter(r => String(r.cod_produto||'').trim() === '701464');
    const transacoes701464 = mov701464.map(r => String(r.transacao||'').trim()).filter(Boolean);
    const movAcoes701464 = (Array.isArray(movAcoesRowsDbg) ? movAcoesRowsDbg : []).filter(r =>
      transacoes701464.includes(String(r.transacao||'').trim())
    );

    res.json({
      movimento:        { total: Array.isArray(movRows)?movRows.length:'erro', amostra: (Array.isArray(movRows)?movRows:[]).slice(0,3) },
      movimentoPlanos:  { total: Array.isArray(planoRows)?planoRows.length:'erro', amostra: (Array.isArray(planoRows)?planoRows:[]).slice(0,3) },
      acoesPromocionais:{ total: Array.isArray(acoesRowsDbg)?acoesRowsDbg.length:'erro', erro: Array.isArray(acoesRowsDbg)?null:acoesRowsDbg?.error, amostra: Array.isArray(acoesRowsDbg)?acoesRowsDbg.slice(0,5):[] },
      movimentoAcoes:   { total: Array.isArray(movAcoesRowsDbg)?movAcoesRowsDbg.length:'erro', erro: Array.isArray(movAcoesRowsDbg)?null:movAcoesRowsDbg?.error, amostra: Array.isArray(movAcoesRowsDbg)?movAcoesRowsDbg.slice(0,5):[] },
      produtosPromocoes:{ total: Array.isArray(produtosPromoDbg)?produtosPromoDbg.length:'erro', erro: Array.isArray(produtosPromoDbg)?null:produtosPromoDbg?.error, campos: Array.isArray(produtosPromoDbg)&&produtosPromoDbg[0]?Object.keys(produtosPromoDbg[0]):[], amostra: Array.isArray(produtosPromoDbg)?produtosPromoDbg.slice(0,3):[] },
      diagnostico_701464: {
        linhas_movimento: mov701464,
        transacoes: transacoes701464,
        acoes_encontradas: movAcoes701464,
      },
      vendas_calculadas: docsSample,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/cmv-itens?board=minas&dtIni=DD/MM/YYYY&dtFin=DD/MM/YYYY
// Retorna custo por produto (da API Microvix) para comparar com relatório Microvix portal
app.get('/api/conferencia/cmv-itens', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!board || !dtIni || !dtFin) return res.status(400).json({ error: 'board, dtIni e dtFin obrigatórios' });

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const SURFERS_BOARDS = ['delrey','minas','contagem','estacao','site'];
    const targetBoards   = board === 'surfers' ? SURFERS_BOARDS : [board];

    // Valida que todos os boards existem
    for (const b of targetBoards) {
      if (!lojas[b]) return res.status(400).json({ error: `Loja "${b}" não configurada` });
    }

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    const { fetchMovimento, fetchEstoque } = require('./services/microvix');
    const today = new Date().toISOString().slice(0, 10);
    const [allRowsNested, allEstoqueNested, catalog] = await Promise.all([
      Promise.all(targetBoards.map(b => {
        const c = lojas[b];
        const k = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        return fetchMovimento(c, dtIni, dtFin, k).then(r => Array.isArray(r) ? r : []);
      })),
      Promise.all(targetBoards.map(b => {
        const c = lojas[b];
        const k = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        return fetchEstoque(c, k, today).catch(() => []);
      })),
      _getCatalog(lojas).catch(() => ({})),
    ]);
    const rows = allRowsNested.flat();

    // Conjunto de CNPJs válidos para filtrar linhas
    const validCnpjs = new Set(targetBoards.map(b => lojas[b].replace(/\D/g,'')));

    const itens = {};
    let totalCusto = 0, totalVenda = 0;

    for (const r of rows) {
      const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
      if (!rowCnpj || !validCnpjs.has(rowCnpj)) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      if ((r.soma_relatorio||'S').toUpperCase() === 'N') continue;
      const op = (r.operacao||'').trim().toUpperCase();
      if (op !== 'S' && op !== 'DS') continue;
      const serie = String(r.serie||r.serie_documento||'').trim();
      if (serie === '999') continue;
      if (serie === '4' && op !== 'DS') continue;
      if (serie === 'J') continue;

      const sign    = op === 'DS' ? -1 : 1;
      const qty     = parseBR(r.quantidade||'1');
      const custo   = parseBR(r.custo_medio_epoca||r.preco_custo||'0');
      const vlrUnit = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
      const vlrDesc = parseBR(r.desconto_item||r.desconto_total_item||'0');
      const vlrLiq  = Math.max(0, vlrUnit - vlrDesc);

      const cod  = String(r.cod_produto||'').trim();
      const desc = String(r.descricao||r.descricao_produto||'').trim();
      const key  = cod || desc;
      if (!key) continue;

      if (!itens[key]) {
        const cat   = catalog[cod] || {};
        const marca = (cat.marca || cat.desc_marca || r.desc_marca || '').trim() || '(sem marca)';
        const setor = (cat.setor || cat.desc_setor || r.desc_setor || '').trim() || '(sem setor)';
        itens[key] = { cod, desc, marca, setor, qty: 0, custoTotal: 0, vendaTotal: 0, custo_unit_api: custo, series: new Set() };
      }
      itens[key].qty        += sign * qty;
      itens[key].custoTotal += sign * custo * qty;
      itens[key].vendaTotal += sign * vlrLiq * qty;
      itens[key].series.add(serie);

      totalCusto += sign * custo * qty;
      totalVenda += sign * vlrLiq * qty;
    }

    const lista = Object.values(itens)
      .filter(i => i.qty !== 0)
      .map(i => ({
        cod:          i.cod,
        desc:         i.desc,
        marca:        i.marca,
        setor:        i.setor,
        qty:          +i.qty.toFixed(0),
        custo_unit:   +i.custo_unit_api.toFixed(2),
        custo_total:  +i.custoTotal.toFixed(2),
        venda_total:  +i.vendaTotal.toFixed(2),
        cmv_pct:      i.vendaTotal > 0 ? +(i.custoTotal / i.vendaTotal * 100).toFixed(2) : null,
        series:       [...i.series].join(','),
      }))
      .sort((a, b) => b.custo_total - a.custo_total);

    // Estoque atual por cod_produto (soma todas as lojas)
    const estoqueQty = {};
    for (const row of allEstoqueNested.flat()) {
      const cod = String(row.cod_produto || '').trim();
      if (!cod) continue;
      const qty = parseBR(row.quantidade || row.saldo || row.qtd || '0');
      estoqueQty[cod] = (estoqueQty[cod] || 0) + qty;
    }

    // Nº de meses do período consultado (mínimo 1)
    const msToDate = s => { const p = String(s).trim(); if (p.includes('-')) return new Date(p); const [d,m,y] = p.split('/'); return new Date(`${y}-${m}-${d}`); };
    const d1 = msToDate(dtIni), d2 = msToDate(dtFin);
    const mesesPeriodo = Math.max(1, (d2 - d1) / (1000 * 60 * 60 * 24 * 30.44));

    // Agrupamento sintético por marca → setor
    const porMarca = {};
    for (const i of lista) {
      const m = i.marca || '(sem marca)';
      const s = i.setor || '(sem setor)';
      if (!porMarca[m]) porMarca[m] = { marca: m, qtd_itens: 0, custo_total: 0, venda_total: 0, qty_vendida: 0, qty_estoque: 0, setores: {} };
      const absQty = Math.abs(i.qty);
      porMarca[m].qtd_itens   += absQty;
      porMarca[m].custo_total += i.custo_total;
      porMarca[m].venda_total += i.venda_total;
      porMarca[m].qty_vendida += absQty;
      porMarca[m].qty_estoque += (estoqueQty[i.cod] || 0);
      if (!porMarca[m].setores[s]) porMarca[m].setores[s] = { setor: s, qtd_itens: 0, custo_total: 0, venda_total: 0 };
      porMarca[m].setores[s].qtd_itens   += absQty;
      porMarca[m].setores[s].custo_total += i.custo_total;
      porMarca[m].setores[s].venda_total += i.venda_total;
    }
    const marcas = Object.values(porMarca)
      .map(m => {
        const mediaVendaMensal = m.qty_vendida / mesesPeriodo;
        const estoque_meses    = mediaVendaMensal > 0 ? +(m.qty_estoque / mediaVendaMensal).toFixed(1) : null;
        return {
          marca:          m.marca,
          qtd_itens:      m.qtd_itens,
          custo_total:    +m.custo_total.toFixed(2),
          venda_total:    +m.venda_total.toFixed(2),
          cmv_pct:        m.venda_total > 0 ? +(m.custo_total / m.venda_total * 100).toFixed(2) : null,
          qty_estoque:    +m.qty_estoque.toFixed(0),
          estoque_meses,
          setores:        Object.values(m.setores)
            .map(s => ({ ...s, custo_total: +s.custo_total.toFixed(2), venda_total: +s.venda_total.toFixed(2), cmv_pct: s.venda_total > 0 ? +(s.custo_total / s.venda_total * 100).toFixed(2) : null }))
            .sort((a, b) => (a.cmv_pct ?? 999) - (b.cmv_pct ?? 999)),
        };
      })
      .sort((a, b) => (a.cmv_pct ?? 999) - (b.cmv_pct ?? 999));

    res.json({
      board, dtIni, dtFin,
      total_custo:  +totalCusto.toFixed(2),
      total_venda:  +totalVenda.toFixed(2),
      cmv_pct:      totalVenda > 0 ? +(totalCusto / totalVenda * 100).toFixed(2) : null,
      qtd_itens:    lista.length,
      marcas,
      itens:        lista,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/conferencia/vendas-vendedor?board=surfers&dtIni=YYYY-MM-DD&dtFin=YYYY-MM-DD
// Retorna itens vendidos agrupados por loja → vendedor → marca → item
app.get('/api/conferencia/vendas-vendedor', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!board || !dtIni || !dtFin) return res.status(400).json({ error: 'board, dtIni e dtFin obrigatórios' });

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const SURFERS_BOARDS = ['delrey','minas','contagem','estacao','site'];
    const targetBoards   = board === 'surfers' ? SURFERS_BOARDS : [board];

    for (const b of targetBoards) {
      if (!lojas[b]) return res.status(400).json({ error: `Loja "${b}" não configurada` });
    }

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };
    const BOARD_LABEL = { minas:'Minas', estacao:'Estação', contagem:'Contagem', delrey:'Del Rey', tommy:'Tommy', surfers:'Surfers', site:'Site' };

    const { fetchMovimento, fetchVendedores } = require('./services/microvix');

    // Busca movimentos, catálogo e vendedores em paralelo
    const [allRowsNested, allVendNested, catalog] = await Promise.all([
      Promise.all(targetBoards.map(b => {
        const cnpj  = lojas[b];
        const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        return fetchMovimento(cnpj, dtIni, dtFin, chave).then(r => Array.isArray(r) ? r.map(row => ({ ...row, _board: b })) : []);
      })),
      Promise.all(targetBoards.map(b => {
        const cnpj  = lojas[b];
        const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        return fetchVendedores(cnpj, chave).catch(() => []);
      })),
      _getCatalog(lojas).catch(() => ({})),
    ]);
    const rows = allRowsNested.flat();

    // Monta cache cod_vendedor → nome (todos os boards)
    const vendNomeCache = {};
    for (const vRows of allVendNested) {
      for (const v of vRows) {
        const cod  = String(v.cod_vendedor || v.codigo || '').trim();
        const nome = (v.nome_vendedor || v.nome || '').trim();
        if (cod && nome) vendNomeCache[cod] = nome;
      }
    }

    const validCnpjs = new Set(targetBoards.map(b => lojas[b].replace(/\D/g,'')));

    // loja → vendedor → marca → item_key
    const tree = {};

    for (const r of rows) {
      const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
      if (!rowCnpj || !validCnpjs.has(rowCnpj)) continue;
      if (r.cancelado === 'S' || r.cancelado === '1') continue;
      if ((r.soma_relatorio||'S').toUpperCase() === 'N') continue;
      const op = (r.operacao||'').trim().toUpperCase();
      if (op !== 'S' && op !== 'DS') continue;
      const serie = String(r.serie||r.serie_documento||'').trim();
      if (serie === '999') continue;
      if (serie === '4' && op !== 'DS') continue;
      if (serie === 'J') continue;

      const sign    = op === 'DS' ? -1 : 1;
      const qty     = parseBR(r.quantidade||'1');
      const vlrUnit = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
      const vlrDesc = parseBR(r.desconto_item||r.desconto_total_item||'0');
      const vlrLiq  = Math.max(0, vlrUnit - vlrDesc);

      const lojaBoard  = r._board || targetBoards[0];
      const lojaLabel  = BOARD_LABEL[lojaBoard] || lojaBoard;
      const vendCod    = String(r.cod_vendedor||'').trim();
      const vendNome   = vendNomeCache[vendCod] || (r.nome_vendedor||r.vendedor||'').trim() || `Vendedor ${vendCod||'?'}`;
      const cod        = String(r.cod_produto||'').trim();
      const cat        = catalog[cod] || {};
      const marca      = (cat.marca || r.desc_marca || r.marca || '(sem marca)').trim();
      const desc       = (cat.nomeBase || r.descricao || r.descricao_produto || '').trim();
      const itemKey    = cod || desc;
      if (!itemKey) continue;

      if (!tree[lojaBoard]) tree[lojaBoard] = { label: lojaLabel, vendedores: {} };
      const T = tree[lojaBoard];
      if (!T.vendedores[vendCod]) T.vendedores[vendCod] = { cod: vendCod, nome: vendNome, marcas: {} };
      const V = T.vendedores[vendCod];
      if (!V.marcas[marca]) V.marcas[marca] = { marca, itens: {} };
      const M = V.marcas[marca];
      if (!M.itens[itemKey]) M.itens[itemKey] = { cod, desc, marca, qty: 0, venda_total: 0 };
      M.itens[itemKey].qty        += sign * qty;
      M.itens[itemKey].venda_total += sign * vlrLiq * qty;
    }

    // Serializa para lista plana ordenada: loja / vendedor / marca / item
    const resultado = [];
    for (const [, loja] of Object.entries(tree).sort((a,b) => a[0].localeCompare(b[0]))) {
      for (const [, vend] of Object.entries(loja.vendedores).sort((a,b) => a[1].nome.localeCompare(b[1].nome))) {
        for (const [, marc] of Object.entries(vend.marcas).sort((a,b) => a[0].localeCompare(b[0]))) {
          const itens = Object.values(marc.itens)
            .filter(i => i.qty !== 0)
            .sort((a,b) => b.venda_total - a.venda_total);
          for (const it of itens) {
            resultado.push({
              loja:        loja.label,
              vendedor:    vend.nome,
              marca:       marc.marca,
              cod:         it.cod,
              desc:        it.desc,
              qty:         +it.qty.toFixed(0),
              venda_total: +it.venda_total.toFixed(2),
            });
          }
        }
      }
    }

    res.json({ board, dtIni, dtFin, total: resultado.length, rows: resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/conferencia/conciliacao-rede
// Recebe arquivo da Rede (Excel/CSV) e cruza com LinxMovimentoCartoes do Microvix
app.post('/api/conferencia/conciliacao-rede', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin, linhas } = req.body;
    // linhas: [{ nsu, bandeira, valor, data }] — parseado no frontend
    if (!board || !dtIni || !dtFin || !Array.isArray(linhas)) {
      return res.status(400).json({ error: 'board, dtIni, dtFin e linhas obrigatórios' });
    }

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Loja "${board}" não configurada` });
    const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');

    const { fetchMovimentoCartoes } = require('./services/microvix');
    const cartoesRows = await fetchMovimentoCartoes(cnpj, dtIni, dtFin, chave).catch(() => []);

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    // Monta mapa Microvix por NSU normalizado
    const mxMap = {};
    for (const r of cartoesRows) {
      const rowCnpj = (r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (rowCnpj && rowCnpj !== cnpjClean) continue;
      const nsu = String(r.nsu || r.nsu_host || r.autorizacao || r.cod_autorizacao || '').trim().replace(/^0+/, '');
      if (!nsu) continue;
      mxMap[nsu] = {
        nsu,
        bandeira: (r.bandeira || r.desc_bandeira || '').trim(),
        valor:    parseBR(r.valor || r.valor_total || '0'),
        data:     String(r.data || r.data_movimento || '').trim().slice(0, 10),
        doc:      String(r.documento || '').trim(),
      };
    }

    // Monta mapa Rede por NSU normalizado
    const redeMap = {};
    for (const l of linhas) {
      const nsu = String(l.nsu || '').trim().replace(/^0+/, '');
      if (!nsu) continue;
      redeMap[nsu] = { nsu, bandeira: l.bandeira || '', valor: parseFloat(l.valor) || 0, data: l.data || '' };
    }

    const allNsus = new Set([...Object.keys(mxMap), ...Object.keys(redeMap)]);
    const resultado = [];
    for (const nsu of allNsus) {
      const mx   = mxMap[nsu];
      const rede = redeMap[nsu];
      if (mx && rede) {
        const difValor = +(rede.valor - mx.valor).toFixed(2);
        resultado.push({ nsu, status: Math.abs(difValor) > 0.01 ? 'divergencia_valor' : 'ok', mx, rede, difValor });
      } else if (mx && !rede) {
        resultado.push({ nsu, status: 'somente_microvix', mx, rede: null, difValor: null });
      } else {
        resultado.push({ nsu, status: 'somente_rede', mx: null, rede, difValor: null });
      }
    }

    resultado.sort((a, b) => {
      const ordem = { divergencia_valor: 0, somente_rede: 1, somente_microvix: 2, ok: 3 };
      return (ordem[a.status] ?? 9) - (ordem[b.status] ?? 9);
    });

    res.json({
      board, dtIni, dtFin,
      totalMx: Object.keys(mxMap).length,
      totalRede: Object.keys(redeMap).length,
      ok: resultado.filter(r => r.status === 'ok').length,
      divergencias: resultado.filter(r => r.status !== 'ok').length,
      resultado,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// CERTIFICADOS DIGITAIS
// ════════════════════════════════════════════════════════════════════════════

let _certColReady = false;
async function getCertCol() {
  const col = mongoDb.collection('certificados');
  if (!_certColReady) {
    _certColReady = true;
    col.createIndex({ id: 1 }, { unique: true, background: true }).catch(() => {});
  }
  return col;
}

// GET /certificados — serve a página
app.get('/certificados', requireEscritorioOrAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'certificados.html')));

// GET /api/certificados
app.get('/api/certificados', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const col = await getCertCol();
    const docs = await col.find({}).sort({ validade: 1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/certificados
app.post('/api/certificados', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { loja, tipo, validade, obs } = req.body;
    if (!loja || !validade) return res.status(400).json({ error: 'loja e validade são obrigatórios' });
    const col = await getCertCol();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const doc = {
      id, loja, tipo: tipo || 'e-CNPJ A1', validade, obs: obs || '',
      criadoPor: req.session?.user?.username || '?',
      criadoEm: new Date().toISOString(),
      atualizadoPor: null, atualizadoEm: null,
    };
    await col.insertOne(doc);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/certificados/:id
app.put('/api/certificados/:id', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { loja, tipo, validade, obs } = req.body;
    const col = await getCertCol();
    const upd = {
      ...(loja     !== undefined && { loja }),
      ...(tipo     !== undefined && { tipo }),
      ...(validade !== undefined && { validade }),
      ...(obs      !== undefined && { obs }),
      atualizadoPor: req.session?.user?.username || '?',
      atualizadoEm: new Date().toISOString(),
    };
    const r = await col.findOneAndUpdate({ id: req.params.id }, { $set: upd }, { returnDocument: 'after' });
    if (!r) return res.status(404).json({ error: 'não encontrado' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/certificados/:id
app.delete('/api/certificados/:id', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const col = await getCertCol();
    await col.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/certificados/alertas — retorna certs vencidos ou próximos (para notif no login)
app.get('/api/certificados/alertas', requireAuth, async (req, res) => {
  try {
    const col = await getCertCol();
    const dias = parseInt(req.query.dias) || 30;
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const limite = new Date(hoje); limite.setDate(limite.getDate() + dias);
    const docs = await col.find({ validade: { $lte: limite.toISOString().slice(0,10) } }).sort({ validade: 1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// SEGUROS
// ════════════════════════════════════════════════════════════════════════════

let _seguroColReady = false;
async function getSeguroCol() {
  const col = mongoDb.collection('seguros');
  if (!_seguroColReady) {
    _seguroColReady = true;
    col.createIndex({ id: 1 }, { unique: true, background: true }).catch(() => {});
  }
  return col;
}

// GET /api/seguros
app.get('/api/seguros', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const col = await getSeguroCol();
    const docs = await col.find({}).sort({ validade: 1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/seguros
app.post('/api/seguros', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { loja, tipo, seguradora, apolice, validade, obs } = req.body;
    if (!loja || !validade) return res.status(400).json({ error: 'loja e validade são obrigatórios' });
    const col = await getSeguroCol();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const doc = {
      id, loja, tipo: tipo || 'Seguro Empresarial', seguradora: seguradora || '', apolice: apolice || '',
      validade, obs: obs || '',
      criadoPor: req.session?.user?.username || '?',
      criadoEm: new Date().toISOString(),
      atualizadoPor: null, atualizadoEm: null,
    };
    await col.insertOne(doc);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/seguros/:id
app.put('/api/seguros/:id', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { loja, tipo, seguradora, apolice, validade, obs } = req.body;
    const col = await getSeguroCol();
    const upd = {
      ...(loja       !== undefined && { loja }),
      ...(tipo       !== undefined && { tipo }),
      ...(seguradora !== undefined && { seguradora }),
      ...(apolice    !== undefined && { apolice }),
      ...(validade   !== undefined && { validade }),
      ...(obs        !== undefined && { obs }),
      atualizadoPor: req.session?.user?.username || '?',
      atualizadoEm: new Date().toISOString(),
    };
    const r = await col.findOneAndUpdate({ id: req.params.id }, { $set: upd }, { returnDocument: 'after' });
    if (!r) return res.status(404).json({ error: 'não encontrado' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/seguros/:id
app.delete('/api/seguros/:id', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const col = await getSeguroCol();
    await col.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/seguros/alertas — retorna seguros vencidos ou próximos (para notif no login)
app.get('/api/seguros/alertas', requireAuth, async (req, res) => {
  try {
    const col = await getSeguroCol();
    const dias = parseInt(req.query.dias) || 30;
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const limite = new Date(hoje); limite.setDate(limite.getDate() + dias);
    const docs = await col.find({ validade: { $lte: limite.toISOString().slice(0,10) } }).sort({ validade: 1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────
// ── DRE ─────────────────────────────────────────────────────────────────────

app.get('/api/dre/config/:loja', requireAdmin, async (req, res) => {
  try {
    const cfg = await mongoDb.collection('dre_config').findOne({ loja: req.params.loja });
    res.json(cfg || { loja: req.params.loja });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dre/config/:loja', requireAdmin, async (req, res) => {
  try {
    const doc = { ...req.body, loja: req.params.loja, updatedAt: new Date() };
    delete doc._id;
    await mongoDb.collection('dre_config').replaceOne({ loja: req.params.loja }, doc, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dre/historico/:loja', requireAdmin, async (req, res) => {
  try {
    const docs = await mongoDb.collection('dre_monthly')
      .find({ loja: req.params.loja })
      .sort({ ano: -1, mes: -1 })
      .limit(24)
      .toArray();
    res.json(docs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dre/:ano/:mes/:loja', requireAdmin, async (req, res) => {
  try {
    const { ano, mes, loja } = req.params;
    const y = parseInt(ano), m = parseInt(mes);
    const pad = n => String(n).padStart(2, '0');

    const [monthly, config] = await Promise.all([
      mongoDb.collection('dre_monthly').findOne({ loja, ano: y, mes: m }),
      mongoDb.collection('dre_config').findOne({ loja }),
    ]);

    // Fetch receita + CMV from conferência (Microvix) for the full month
    let receita_microvix = null, cmv_microvix = null;
    try {
      const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
      const cnpj   = lojas[loja];
      if (cnpj) {
        const chave  = process.env[`MICROVIX_CHAVE_${loja.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
        const dtIni  = `${y}-${pad(m)}-01`;
        const lastDay = new Date(y, m, 0).getDate();
        const dtFin  = `${y}-${pad(m)}-${String(lastDay).padStart(2,'0')}`;
        const { fetchMovimento } = require('./services/microvix');
        const rows = await fetchMovimento(cnpj, dtIni, dtFin, chave);
        const cnpjClean = cnpj.replace(/\D/g, '');
        const parseBR = s => { const t = String(s||'').trim(); return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };
        const seenDocs = new Set();
        let vlrLiquido = 0, vlrCusto = 0;
        for (const r of (Array.isArray(rows) ? rows : [])) {
          if ((r.cnpj_emp||r.cnpj||'').replace(/\D/g,'') !== cnpjClean) continue;
          if (r.cancelado === 'S' || r.cancelado === '1') continue;
          if ((r.soma_relatorio||'S').toUpperCase() === 'N') continue;
          const op = (r.operacao||'').trim().toUpperCase();
          if (op !== 'S' && op !== 'DS') continue;
          const serie = String(r.serie||r.serie_documento||'').trim();
          if (serie === '999') continue;
          if (serie === '4' && op !== 'DS') continue;
          if (serie === 'J') continue;
          const sign = op === 'DS' ? -1 : 1;
          const qty  = parseBR(r.quantidade||'1');
          vlrCusto  += sign * parseBR(r.custo_medio_epoca||r.preco_custo||'0') * qty;
          const doc = String(r.documento||'').trim();
          if (!doc || seenDocs.has(doc)) continue;
          seenDocs.add(doc);
          const vlrLiq = ['total_cartao','total_dinheiro','total_pix','total_cheque',
                          'total_crediario','total_convenio','total_cheque_prazo','total_deposito_bancario']
            .reduce((s, k) => s + parseBR(r[k]||'0'), 0)
            || parseBR(r.valor_total||r.total_liquido||'0');
          vlrLiquido += sign * vlrLiq;
        }
        receita_microvix = Math.round(vlrLiquido * 100) / 100;
        cmv_microvix     = Math.round(vlrCusto   * 100) / 100;
      }
    } catch(e) { console.warn('[DRE/microvix]', e.message); }

    res.json({ monthly: monthly || { loja, ano: y, mes: m }, config: config || { loja }, receita_microvix, cmv_microvix });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dre/:ano/:mes/:loja', requireAdmin, async (req, res) => {
  try {
    const { ano, mes, loja } = req.params;
    const y = parseInt(ano), m = parseInt(mes);
    const doc = { ...req.body, loja, ano: y, mes: m, updatedAt: new Date() };
    delete doc._id;
    await mongoDb.collection('dre_monthly').replaceOne({ loja, ano: y, mes: m }, doc, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PAUTA DE REUNIÃO MENSAL — uma por loja, por mês
// ════════════════════════════════════════════════════════════════════════════
// A reunião roda na última semana do mês, loja a loja. Nada de número digitado:
// performance, RH e pendências saem do que o sistema já tem. O que se escreve
// aqui é o que a conversa produziu — comentário, demanda e ação combinada.
// Ao fechar, cada ação vira item de pauta (meetingItems) da loja, que é onde a
// cobrança do mês seguinte já acontece hoje.

const PAUTA_BOARDS = BOARDS.filter(b => b !== 'admin' && b !== 'escritorio');

function pautaKey(y, m, board) { return `${monthKey(y, m)}-${board}`; }

function pautaMesAnterior(y, m) { return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; }

// Datas ancoradas ao meio-dia UTC: imune a fuso e horário de verão.
function pautaAddDias(dateStr, dias) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function pautaAddMeses(dateStr, meses) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString().slice(0, 10);
}

function pautaDiasEntre(de, ate) {
  return Math.round((Date.parse(ate + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 86400000);
}

// Contrato de experiência: o dia da admissão conta como 1º dia do prazo.
function pautaVencContrato(admissao, dias) {
  if (!admissao || !dias) return null;
  return pautaAddDias(admissao, dias - 1);
}

const pautaNorm = s => (s || '').toString().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

// Ausência guarda o colaborador como texto livre; funcionário tem nome e apelido.
// Casa por igualdade do nome completo, do apelido, ou por primeiro+último nome.
function pautaMesmaPessoa(colaborador, emp) {
  const c = pautaNorm(colaborador);
  if (!c) return false;
  const nome    = pautaNorm(emp.name);
  const apelido = pautaNorm(emp.apelido);
  if (c === nome || (apelido && c === apelido)) return true;
  const p = nome.split(' ');
  if (p.length > 1 && c === `${p[0]} ${p[p.length - 1]}`) return true;
  return false;
}

// dailySales antigo guardava meta como número solto
function pautaMetaLoja(rec) {
  if (!rec) return 0;
  return typeof rec.meta === 'object' ? (rec.meta?.mensal || 0) : (rec.meta || 0);
}

// Conversão da Lista da Vez (indeva): atendimento marcado como "vendeu"
function pautaAtendimentosIndeva(db, y, m, board) {
  const store = db.indeva?.[board];
  if (!store) return [];
  const prefix = monthKey(y, m) + '-';
  const dias   = { ...(store.historico || {}) };
  if (store.date && store.atendimentos?.length) dias[store.date] = { atendimentos: store.atendimentos };
  const out = [];
  for (const [date, d] of Object.entries(dias)) {
    if (!date.startsWith(prefix)) continue;
    for (const a of (d.atendimentos || [])) out.push(a);
  }
  return out;
}

function pautaConversao(db, y, m, board) {
  const ats = pautaAtendimentosIndeva(db, y, m, board);
  if (!ats.length) return null;
  const conv = ats.filter(a => a.vendeu).length;
  return { total: ats.length, conv, pct: (conv / ats.length) * 100 };
}

function pautaConversaoPorVendedor(db, y, m, board) {
  const out = {};
  for (const a of pautaAtendimentosIndeva(db, y, m, board)) {
    const k = String(a.empId);
    if (!out[k]) out[k] = { total: 0, conv: 0 };
    out[k].total++;
    if (a.vendeu) out[k].conv++;
  }
  return out;
}

// Peso do dia no mês: quanto aquele dia vale do total (a soma do mês é 100).
// Sem peso cadastrado, o mês é linear. Mesma regra da Planilha do Mês.
function pautaPesoDoDia(db, y, m) {
  const w = (db.globalWeights || {})[monthKey(y, m)] || {};
  const padrao = 100 / new Date(y, m, 0).getDate();
  return ds => (w[ds] ?? padrao);
}

// A reunião acontece com o mês ainda em curso, então o corte é D-1: o dia de
// hoje ainda está sendo vendido e entraria no cálculo pela metade.
function pautaCorte(y, m, hoje) {
  const mk       = monthKey(y, m);
  const primeiro = `${mk}-01`;
  const ultimo   = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const ontem    = pautaAddDias(hoje, -1);
  if (ontem >= ultimo)  return { corte: ultimo, fechado: true };
  if (ontem < primeiro) return { corte: null,   fechado: false };
  return { corte: ontem, fechado: false };
}

// Quando a meta da loja não está lançada na Planilha do Mês, ela é a soma das
// metas individuais — é assim que a loja é cobrada.
function pautaMetaVendedores(db, y, m, board) {
  const mk = monthKey(y, m);
  let meta = 0;
  for (const emp of (db.employees || [])) {
    if (emp.board !== board || emp.inativo) continue;
    meta += db.vsales?.[`${mk}-${board}-${emp.id}`]?.meta?.mensal || 0;
  }
  return meta;
}

// Projeção pelo ritmo: o que já foi vendido dividido pelo peso que já correu.
// Mês fechado não se projeta — o realizado é o número.
function pautaProjetar(valor, pesoAcum, fechado) {
  if (fechado) return valor || null;
  if (!(pesoAcum > 0) || !(valor > 0)) return null;
  return valor * 100 / pesoAcum;
}

function pautaTotaisLoja(db, y, m, board) {
  const mk = monthKey(y, m);
  const { corte, fechado } = pautaCorte(y, m, todayBRT());
  const noCorte = ds => corte ? ds <= corte : false; // mês futuro não tem nada a contar

  // O faturamento da loja é a soma dos vendedores — é o lançamento que existe
  // todo dia. A Planilha do Mês só entra quando não há vsales no período.
  let venda = 0, pecas = 0, atend = 0;
  const porDia = {};
  for (const emp of (db.employees || [])) {
    if (emp.board !== board) continue;
    const vs = db.vsales?.[`${mk}-${board}-${emp.id}`];
    for (const [ds, e] of Object.entries(vs?.entries || {})) {
      if (!noCorte(ds)) continue;
      venda += e.value || 0;
      pecas += e.pecas || 0;
      atend += e.atendimentos || 0;
      porDia[ds] = (porDia[ds] || 0) + (e.value || 0);
    }
  }
  let diasComVenda = Object.values(porDia).filter(v => v > 0).length;
  let fonte = 'vendedores';

  const rec = db.dailySales?.[`${mk}-${board}`];
  let fluxo = 0;
  for (const [ds, e] of Object.entries(rec?.entries || {})) {
    if (noCorte(ds)) fluxo += e.fluxo || 0;
  }
  if (venda === 0) {
    // Sem lançamento por vendedor no período: cai na Planilha do Mês
    let dsVenda = 0, dsPecas = 0, dsDias = 0;
    for (const [ds, e] of Object.entries(rec?.entries || {})) {
      if (!noCorte(ds)) continue;
      dsVenda += e.value || 0;
      dsPecas += e.pecas || 0;
      if ((e.value || 0) > 0) dsDias++;
    }
    if (dsVenda > 0) { venda = dsVenda; pecas = dsPecas; diasComVenda = dsDias; fonte = 'planilha do mês'; }
  }

  // storeFluxo é a contagem de porta feita pela loja — quando existe, manda nela
  const sf = db.storeFluxo?.[`${mk}-${board}`] || {};
  const fluxoPorta = Object.entries(sf)
    .filter(([ds]) => noCorte(ds))
    .reduce((s, [, v]) => s + (Number(v) || 0), 0);
  if (fluxoPorta > 0) fluxo = fluxoPorta;

  const peso = pautaPesoDoDia(db, y, m);
  let pesoAcum = 0;
  const totalDias = new Date(y, m, 0).getDate();
  for (let d = 1; d <= totalDias; d++) {
    const ds = `${mk}-${String(d).padStart(2, '0')}`;
    if (!noCorte(ds)) break;
    pesoAcum += peso(ds);
  }

  const projecao  = pautaProjetar(venda, pesoAcum, fechado);
  const projPecas = fechado ? (pecas || null) : (pautaProjetar(pecas, pesoAcum, false) ? Math.round(pautaProjetar(pecas, pesoAcum, false)) : null);
  const meta = pautaMetaLoja(rec) || pautaMetaVendedores(db, y, m, board);
  const conv = pautaConversao(db, y, m, board);

  return {
    meta, venda, pecas, fluxo, atend, diasComVenda, fonte,
    corte, fechado, pesoAcum: Math.round(pesoAcum * 10) / 10,
    projecao, projPecas,
    pct:     meta > 0 && venda > 0 ? (venda / meta) * 100 : null,
    pctProj: meta > 0 && projecao  ? (projecao / meta) * 100 : null,
    pa:   atend > 0 ? pecas / atend : null,
    tm:   atend > 0 ? venda / atend : null,
    conv: conv ? conv.pct : (fluxo > 0 && atend > 0 ? (atend / fluxo) * 100 : null),
    convFonte: conv ? 'lista da vez' : (fluxo > 0 && atend > 0 ? 'atendimentos / fluxo' : null),
  };
}

function pautaVendedores(db, y, m, board, pctLoja) {
  const mk   = monthKey(y, m);
  const conv = pautaConversaoPorVendedor(db, y, m, board);
  const { corte, fechado } = pautaCorte(y, m, todayBRT());
  const noCorte = ds => corte ? ds <= corte : false; // mês futuro não tem nada a contar

  const peso = pautaPesoDoDia(db, y, m);
  let pesoAcum = 0;
  const totalDias = new Date(y, m, 0).getDate();
  for (let d = 1; d <= totalDias; d++) {
    const ds = `${mk}-${String(d).padStart(2, '0')}`;
    if (!noCorte(ds)) break;
    pesoAcum += peso(ds);
  }

  return (db.employees || [])
    .filter(e => e.board === board && !e.inativo)
    .map(e => {
      const vs = db.vsales?.[`${mk}-${board}-${e.id}`] || {};
      let venda = 0, pecas = 0, atend = 0, dias = 0;
      for (const [ds, en] of Object.entries(vs.entries || {})) {
        if (!noCorte(ds)) continue;
        venda += en.value || 0; pecas += en.pecas || 0; atend += en.atendimentos || 0;
        if ((en.value || 0) > 0) dias++;
      }
      const meta = vs.meta?.mensal || 0;
      const c    = conv[String(e.id)];
      // Quem esteve de férias no mês vendeu menos por acordo, não por ritmo:
      // a projeção linear puniria duas vezes. Fica registrado para a leitura.
      const projecao = pautaProjetar(venda, pesoAcum, fechado);
      return {
        id: e.id, nome: e.apelido || e.name, nomeCompleto: e.name,
        cargo: e.cargo || '', gerente: e.isVendedor === false,
        meta, venda, pecas, atend, dias, projecao,
        pct:     meta > 0 && venda > 0 ? (venda / meta) * 100 : null,
        pctProj: meta > 0 && projecao  ? (projecao / meta) * 100 : null,
        // Acima do % da loja é quem puxou o mês; abaixo é quem foi carregado
        delta: (meta > 0 && projecao && pctLoja != null) ? ((projecao / meta) * 100) - pctLoja : null,
        pa:   atend > 0 ? pecas / atend : null,
        tm:   atend > 0 ? venda / atend : null,
        conv: c && c.total > 0 ? (c.conv / c.total) * 100 : null,
        diasFerias: (vs.meta?.vacationDays || []).length,
        admissao: e.admissao || '',
      };
    })
    .sort((a, b) => b.venda - a.venda);
}

// Histórico dos meses fechados. O que interessa não é só o % do vendedor, é o
// quanto ele ficou acima ou abaixo do % da loja naquele mês: vender 95% num mês
// em que a loja fez 85% é puxar o resultado, e o número absoluto esconde isso.
function pautaHistorico(db, y, m, board, meses) {
  const emps = (db.employees || []).filter(e => e.board === board);
  const out  = [];
  let cy = y, cm = m;

  for (let i = 0; i < meses; i++) {
    ({ y: cy, m: cm } = pautaMesAnterior(cy, cm));
    const mk   = monthKey(cy, cm);
    const loja = pautaTotaisLoja(db, cy, cm, board);
    if (!loja.venda) continue; // mês sem lançamento nenhum não entra na conversa

    const vendedores = [];
    for (const e of emps) {
      const vs = db.vsales?.[`${mk}-${board}-${e.id}`];
      if (!vs) continue;
      let venda = 0;
      for (const en of Object.values(vs.entries || {})) venda += en.value || 0;
      const meta = vs.meta?.mensal || 0;
      if (!venda && !meta) continue; // não estava na loja nesse mês
      const pct = meta > 0 && venda > 0 ? (venda / meta) * 100 : null;
      vendedores.push({
        id: e.id, nome: e.apelido || e.name, gerente: e.isVendedor === false,
        meta, venda, pct,
        // Diferença em pontos percentuais para o % da loja no mesmo mês
        delta: pct != null && loja.pct != null ? pct - loja.pct : null,
        diasFerias: (vs.meta?.vacationDays || []).length,
      });
    }
    vendedores.sort((a, b) => b.venda - a.venda);
    out.push({
      year: cy, month: cm,
      loja: { meta: loja.meta, venda: loja.venda, pct: loja.pct, pecas: loja.pecas, fonte: loja.fonte },
      vendedores,
    });
  }
  return out.reverse(); // do mais antigo para o mais novo
}

// Faturamento de referência: o do próprio sistema quando existe; senão o
// histórico consolidado em perf-hist.js (fonte única, não duplicar números).
function pautaFaturamento(db, y, m, board) {
  const t = pautaTotaisLoja(db, y, m, board);
  if (t.venda > 0) return { venda: t.venda, meta: t.meta, pecas: t.pecas, fonte: 'sistema' };
  const h = PERF_HIST[board]?.[y]?.[m - 1];
  return h ? { venda: h, meta: 0, pecas: 0, fonte: 'histórico' } : { venda: 0, meta: 0, pecas: 0, fonte: null };
}

function pautaRH(db, board, y, m, hoje) {
  const mk     = monthKey(y, m);
  const iniMes = `${mk}-01`;
  const fimMes = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const emps   = (db.employees || []).filter(e => e.board === board);
  const ativos = emps.filter(e => !e.inativo);

  const admissoes = emps
    .filter(e => (e.admissao || '').startsWith(mk))
    .map(e => ({ nome: e.apelido || e.name, cargo: e.cargo || '', data: e.admissao }));

  const desligamentos = emps
    .filter(e => (e.desligamento || '').startsWith(mk))
    .map(e => ({ nome: e.apelido || e.name, cargo: e.cargo || '', data: e.desligamento }));

  // Contrato de experiência: o que vence nos próximos 60 dias ou venceu nos últimos 30
  const contratos = [];
  for (const e of ativos) {
    if (!e.admissao || !(e.contrato1 || e.contrato2)) continue;
    const venc1 = pautaVencContrato(e.admissao, e.contrato1);
    const venc2 = (e.contrato1 && e.contrato2) ? pautaVencContrato(e.admissao, e.contrato1 + e.contrato2) : null;
    const d1 = venc1 ? pautaDiasEntre(hoje, venc1) : null;
    const d2 = venc2 ? pautaDiasEntre(hoje, venc2) : null;
    if (![d1, d2].some(d => d !== null && d >= -30 && d <= 60)) continue;
    contratos.push({
      nome: e.apelido || e.name, cargo: e.cargo || '', admissao: e.admissao,
      venc1, venc2, dias1: d1, dias2: d2,
      // 1º prazo já venceu e o 2º ainda corre: é a hora de decidir a efetivação
      decisao: d1 !== null && d1 < 0 && d2 !== null && d2 >= 0,
      // sem 2º contrato cadastrado e o 1º vencendo: prorrogar ou desligar
      semSegundo: !venc2,
    });
  }
  contratos.sort((a, b) => {
    const ka = [a.dias1, a.dias2].filter(d => d !== null && d >= 0);
    const kb = [b.dias1, b.dias2].filter(d => d !== null && d >= 0);
    return (ka.length ? Math.min(...ka) : 999) - (kb.length ? Math.min(...kb) : 999);
  });

  // Férias: período aquisitivo de 12 meses a contar da admissão (ou do fim das
  // últimas férias gozadas); o gozo tem de acontecer nos 12 meses seguintes.
  const feriasAus = (db.ausencias || []).filter(a => a.board === board && a.tipo === 'ferias');
  const ferias = [];
  for (const e of ativos) {
    if (!e.admissao) continue;
    const gozos    = feriasAus.filter(a => pautaMesmaPessoa(a.colaborador, e));
    const passadas = gozos.filter(a => a.dataFim <= hoje).sort((a, b) => a.dataFim.localeCompare(b.dataFim));
    const futuras  = gozos.filter(a => a.dataFim >  hoje).sort((a, b) => a.dataInicio.localeCompare(b.dataInicio));
    const ultimo   = passadas.length ? passadas[passadas.length - 1].dataFim : null;
    const aquisitivoFim = pautaAddMeses(ultimo || e.admissao, 12);
    const limiteGozo    = pautaAddMeses(aquisitivoFim, 12);
    const diasAquis     = pautaDiasEntre(hoje, aquisitivoFim);
    const diasLimite    = pautaDiasEntre(hoje, limiteGozo);
    let status = null;
    if (diasLimite < 0)       status = 'vencida';
    else if (diasAquis <= 0)  status = 'direito adquirido';
    else if (diasAquis <= 90) status = 'a vencer';
    if (!status && !futuras.length) continue;
    ferias.push({
      nome: e.apelido || e.name, admissao: e.admissao,
      ultimoGozo: ultimo, aquisitivoFim, limiteGozo,
      diasParaLimite: diasLimite, status: status || 'agendada',
      agendada: futuras.length ? { inicio: futuras[0].dataInicio, fim: futuras[0].dataFim } : null,
    });
  }
  ferias.sort((a, b) => a.diasParaLimite - b.diasParaLimite);

  // Atestados e férias que tocam o mês da reunião
  const ausenciasMes = (db.ausencias || [])
    .filter(a => a.board === board && a.dataInicio <= fimMes && a.dataFim >= iniMes)
    .map(a => ({ tipo: a.tipo, colaborador: a.colaborador, dataInicio: a.dataInicio, dataFim: a.dataFim, observacao: a.observacao || '' }))
    .sort((a, b) => a.dataInicio.localeCompare(b.dataInicio));

  return {
    ativos: ativos.length,
    vendedores: ativos.filter(e => e.isVendedor !== false).length,
    admissoes, desligamentos, contratos, ferias, ausenciasMes,
  };
}

function pautaPendencias(db, board) {
  return (db.meetingItems || [])
    .filter(x => x.board === board && !x.archived)
    .map(x => ({
      id: x.id, text: x.text, year: x.year, month: x.month,
      origin: x.origin || 'admin', visibility: x.visibility || 'admin',
      addedBy: x.addedBy || '', addedAt: x.addedAt || '',
    }))
    .sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.id - b.id));
}

function pautaVazia(y, m, board) {
  return {
    year: y, month: m, board,
    status: 'rascunho',
    realizadaEm: '', participantes: '',
    comentarios: { performance: '', vendedores: '', rh: '', produtos: '' },
    vendedorNotas: {},
    rhItens: [], demandas: [], acoes: [],
    estoqueManual: { custo: 0, venda: 0, data: '', obs: '' },
    produtosResumo: null, roteiro: null, snapshot: null,
    createdAt: null, updatedAt: null, updatedBy: '',
  };
}

function pautaDaLoja(db, y, m, board) {
  const p = db.pautas?.[pautaKey(y, m, board)];
  return p ? { ...pautaVazia(y, m, board), ...p } : pautaVazia(y, m, board);
}

// Ações combinadas no mês anterior, com o status atual do item de pauta gerado
function pautaAcoesAnteriores(db, y, m, board) {
  const { y: py, m: pm } = pautaMesAnterior(y, m);
  const anterior = db.pautas?.[pautaKey(py, pm, board)];
  if (!anterior?.acoes?.length) return [];
  const itens = db.meetingItems || [];
  return anterior.acoes.map(a => {
    const item = a.meetingItemId ? itens.find(x => x.id === a.meetingItemId) : null;
    return {
      texto: a.texto, responsavel: a.responsavel || '', prazo: a.prazo || '',
      year: py, month: pm,
      feito: item ? !!(item.checked || item.archived) : false,
      naPauta: !!item,
    };
  });
}

// GET /pauta — serve a página
app.get('/pauta', requireEscritorioOrAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pauta.html')));

// GET /api/pautas/:year/:month — status de cada loja no mês (para o seletor)
app.get('/api/pautas/:year/:month', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const db = await readDB();
    res.json(PAUTA_BOARDS.map(board => {
      const p = db.pautas?.[pautaKey(y, m, board)];
      return {
        board, label: BOARDS_LABEL[board] || board,
        status: p?.status || 'nova',
        realizadaEm: p?.realizadaEm || '',
        acoes: (p?.acoes || []).length,
        pendencias: pautaPendencias(db, board).length,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pauta/:year/:month/:board — pauta salva + tudo que o sistema já sabe
app.get('/api/pauta/:year/:month/:board', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const board = req.params.board;
    if (!PAUTA_BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });

    const db   = await readDB();
    const hoje = todayBRT();
    const { y: py, m: pm } = pautaMesAnterior(y, m);

    const loja     = pautaTotaisLoja(db, y, m, board);
    const anterior = pautaFaturamento(db, py, pm, board);
    const anoAnt   = pautaFaturamento(db, y - 1, m, board);
    // Comparar o parcial do mês em curso com um mês fechado dá sempre queda:
    // a base da comparação é a projeção de fechamento.
    const base     = loja.projecao ?? loja.venda;

    res.json({
      pauta: pautaDaLoja(db, y, m, board),
      label: BOARDS_LABEL[board] || board,
      dados: {
        loja: {
          ...loja,
          anterior:    { ...anterior, year: py,    month: pm },
          anoAnterior: { ...anoAnt,   year: y - 1, month: m  },
          base,
          varAnterior:    anterior.venda > 0 && base ? ((base - anterior.venda) / anterior.venda) * 100 : null,
          varAnoAnterior: anoAnt.venda   > 0 && base ? ((base - anoAnt.venda)   / anoAnt.venda)   * 100 : null,
        },
        vendedores:      pautaVendedores(db, y, m, board, loja.fechado ? loja.pct : loja.pctProj),
        historico:       pautaHistorico(db, y, m, board, 6),
        rh:              pautaRH(db, board, y, m, hoje),
        pendencias:      pautaPendencias(db, board),
        acoesAnteriores: pautaAcoesAnteriores(db, y, m, board),
        hoje,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/pauta/:year/:month/:board — salva o que foi escrito (autosave)
app.put('/api/pauta/:year/:month/:board', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const board = req.params.board;
    if (!PAUTA_BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });

    const db = await readDB();
    if (!db.pautas) db.pautas = {};
    const key = pautaKey(y, m, board);
    const p   = { ...pautaVazia(y, m, board), ...(db.pautas[key] || {}) };

    const campos = ['participantes', 'realizadaEm', 'comentarios', 'vendedorNotas',
                    'rhItens', 'demandas', 'acoes', 'estoqueManual', 'produtosResumo', 'roteiro'];
    for (const c of campos) if (c in req.body) p[c] = req.body[c];

    if (!p.createdAt) p.createdAt = new Date().toISOString();
    p.updatedAt = new Date().toISOString();
    p.updatedBy = req.session.user.label || req.session.user.username;
    db.pautas[key] = p;
    await writeDB(db);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pauta/:year/:month/:board/fechar — congela os números e joga as
// ações na pauta da loja, que é onde a cobrança já acontece
app.post('/api/pauta/:year/:month/:board/fechar', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const board = req.params.board;
    if (!PAUTA_BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });

    const db = await readDB();
    if (!db.pautas) db.pautas = {};
    if (!db.meetingItems) db.meetingItems = [];
    const key = pautaKey(y, m, board);
    const p   = { ...pautaVazia(y, m, board), ...(db.pautas[key] || {}) };

    const criados = [];
    for (const acao of p.acoes || []) {
      if (!acao.texto?.trim() || acao.meetingItemId) continue;
      const partes = [acao.texto.trim()];
      if (acao.responsavel) partes.push(`(${acao.responsavel})`);
      if (acao.prazo)       partes.push(`— até ${acao.prazo.split('-').reverse().join('/')}`);
      const item = {
        id: nextId(db),
        text: partes.join(' ').slice(0, 200),
        board, year: y, month: m,
        visibility: 'loja',
        origin: 'pauta',
        autoTag: `pauta-${monthKey(y, m)}`,
        checked: false, archived: false,
        addedBy: req.session.user.label || req.session.user.username,
        addedAt: new Date().toISOString(),
      };
      db.meetingItems.push(item);
      acao.meetingItemId = item.id;
      criados.push(item);
    }

    p.status      = 'realizada';
    p.realizadaEm = p.realizadaEm || todayBRT();
    const snapLoja = pautaTotaisLoja(db, y, m, board);
    p.snapshot    = {
      loja:        snapLoja,
      vendedores:  pautaVendedores(db, y, m, board, snapLoja.fechado ? snapLoja.pct : snapLoja.pctProj),
      rh:          pautaRH(db, board, y, m, todayBRT()),
      produtos:    p.produtosResumo || null,
      estoque:     p.estoqueManual  || null,
      historico:   pautaHistorico(db, y, m, board, 6),
      congeladoEm: new Date().toISOString(),
    };
    p.updatedAt = new Date().toISOString();
    p.updatedBy = req.session.user.label || req.session.user.username;
    db.pautas[key] = p;
    await writeDB(db);
    res.json({ pauta: p, criados: criados.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pauta/:year/:month/:board/reabrir — volta para rascunho.
// Os itens de pauta já criados ficam: quem foi cobrado foi cobrado.
app.post('/api/pauta/:year/:month/:board/reabrir', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const board = req.params.board;
    const db  = await readDB();
    const key = pautaKey(y, m, board);
    if (!db.pautas?.[key]) return res.status(404).json({ error: 'Pauta não encontrada' });
    db.pautas[key].status    = 'rascunho';
    db.pautas[key].updatedAt = new Date().toISOString();
    db.pautas[key].updatedBy = req.session.user.label || req.session.user.username;
    await writeDB(db);
    res.json(db.pautas[key]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pauta/:year/:month/:board/roteiro — a IA lê os números e devolve
// por onde conduzir a conversa. Não decide nada: levanta pergunta e sugestão.
app.post('/api/pauta/:year/:month/:board/roteiro', requireEscritorioOrAdmin, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor' });

    const y = parseInt(req.params.year), m = parseInt(req.params.month);
    const board = req.params.board;
    if (!PAUTA_BOARDS.includes(board)) return res.status(400).json({ error: 'Loja inválida' });

    const db   = await readDB();
    const hoje = todayBRT();
    const p    = pautaDaLoja(db, y, m, board);
    const { y: py, m: pm } = pautaMesAnterior(y, m);
    const loja  = pautaTotaisLoja(db, y, m, board);
    const ant   = pautaFaturamento(db, py, pm, board);
    const anoA  = pautaFaturamento(db, y - 1, m, board);
    const vends = pautaVendedores(db, y, m, board, loja.fechado ? loja.pct : loja.pctProj);
    const rh    = pautaRH(db, board, y, m, hoje);

    const n = v => v == null ? null : Math.round(v * 100) / 100;
    const contexto = {
      loja: BOARDS_LABEL[board] || board,
      mes: `${String(m).padStart(2, '0')}/${y}`,
      performance: {
        mesFechado: loja.fechado,
        dadosAte: loja.corte,
        pesoDoMesJaCorrido: loja.pesoAcum,
        projecaoFechamento: n(loja.projecao),
        pctMetaProjetado: n(loja.pctProj),
        meta: loja.meta, faturado: n(loja.venda), pctMeta: n(loja.pct),
        pecas: loja.pecas, atendimentos: loja.atend, fluxoPorta: loja.fluxo,
        pa: n(loja.pa), ticketMedio: n(loja.tm), conversaoPct: n(loja.conv),
        mesAnterior:        { mes: `${String(pm).padStart(2, '0')}/${py}`,    faturado: n(ant.venda)  },
        mesmoMesAnoPassado: { mes: `${String(m).padStart(2, '0')}/${y - 1}`, faturado: n(anoA.venda) },
        obs: loja.fechado
          ? 'Mês fechado: o faturado é o número final.'
          : 'Mês em curso. Compare SEMPRE pela projeção de fechamento, nunca pelo faturado parcial — o mês anterior e o ano passado são meses inteiros.',
      },
      vendedores: vends.map(v => ({
        nome: v.nome, gerente: v.gerente, meta: v.meta, faturado: n(v.venda),
        projecaoFechamento: n(v.projecao), pctMetaProjetado: n(v.pctProj),
        pontosVsLoja: n(v.delta),
        pctMeta: n(v.pct), pa: n(v.pa), ticketMedio: n(v.tm), conversaoPct: n(v.conv),
        pecas: v.pecas, atendimentos: v.atend, diasFerias: v.diasFerias,
      })),
      rh: {
        colaboradoresAtivos: rh.ativos,
        admissoesNoMes: rh.admissoes,
        desligamentosNoMes: rh.desligamentos,
        contratosExperiencia: rh.contratos.map(c => ({
          nome: c.nome, venc1: c.venc1, venc2: c.venc2,
          diasParaVenc1: c.dias1, diasParaVenc2: c.dias2,
          precisaDecidirEfetivacao: c.decisao, semSegundoContrato: c.semSegundo,
        })),
        ferias: rh.ferias,
        ausenciasNoMes: rh.ausenciasMes,
        pendenciasAnotadas: p.rhItens || [],
      },
      historicoMesesFechados: pautaHistorico(db, y, m, board, 6).map(h => ({
        mes: `${String(h.month).padStart(2, '0')}/${h.year}`,
        lojaPctMeta: n(h.loja.pct), lojaFaturado: n(h.loja.venda),
        vendedores: h.vendedores.map(v => ({ nome: v.nome, pctMeta: n(v.pct), pontosVsLoja: n(v.delta) })),
      })),
      produtosXEstoque: req.body?.produtos || p.produtosResumo || null,
      estoqueDeclarado: (p.estoqueManual && (p.estoqueManual.custo || p.estoqueManual.venda)) ? p.estoqueManual : null,
      pendenciasAbertas: pautaPendencias(db, board).map(x => x.text),
      acoesDoMesAnterior: pautaAcoesAnteriores(db, y, m, board),
      demandasAnotadas: p.demandas || [],
      comentariosDoGestor: p.comentarios || {},
    };

    const systemPrompt = `Você prepara a reunião mensal de resultado de uma rede de lojas de surf/streetwear em Belo Horizonte. A reunião é individual com cada loja, na última semana do mês, entre o dono/administração e a gerente da loja.

Você recebe os números fechados do mês e a situação de RH e de estoque. Sua função é dar ao dono o roteiro da conversa: o que reconhecer, o que cobrar, que pergunta fazer para a gerente e que ação combinar.

Regras:
- Português do Brasil, direto, sem jargão de consultoria e sem elogio vazio.
- Toda observação cita o número que a sustenta (ex: "PA 1,42 contra 1,68 no mês passado").
- Dado zerado ou ausente não vira conclusão: aponte como dado que falta.
- PA = peças por atendimento. Ticket médio = faturado por atendimento. Conversão = atendimentos que viraram venda.
- A reunião é na última semana, com o mês ainda aberto. Avalie o mês pela projeção de fechamento (faturado ÷ peso do mês já corrido), e diga "projeção" quando citar esse número. O faturado parcial só serve para dizer até onde os dados vão.
- Quem esteve de férias no mês tem a projeção linear distorcida para baixo: não cobre ritmo de quem faltou por acordo.
- O que separa vendedor bom de ruim é "pontosVsLoja": quanto o % da meta dele ficou acima (bom) ou abaixo (ruim) do % da loja no mesmo mês. Num mês fraco da loja, 85% do vendedor pode ser um bom resultado; num mês forte, 100% pode ser fraco. Use o histórico para dizer se é oscilação de um mês ou tendência.
- Pergunta boa é aberta e sobre causa ("o que aconteceu com...?"), não sobre culpa.
- Ação combinada tem verbo, dono e prazo. No máximo 5.
- Quem está marcado como gerente não é cobrado por meta individual do mesmo jeito que vendedor.
- Contrato de experiência vencendo é decisão que não pode ficar para depois da reunião.

Responda SOMENTE com JSON válido, sem texto fora dele, neste formato:
{
  "resumo": "2 a 3 frases sobre como o mês foi",
  "pontosFortes": ["..."],
  "pontosAtencao": [{"tema":"...","evidencia":"...","pergunta":"..."}],
  "vendedores": [{"nome":"...","leitura":"...","pergunta":"..."}],
  "rh": [{"tema":"...","evidencia":"...","encaminhamento":"..."}],
  "produtos": [{"tema":"...","evidencia":"...","pergunta":"..."}],
  "acoesSugeridas": [{"texto":"...","responsavel":"...","prazoSugerido":"..."}]
}`;

    const { default: Anthropic } = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const pedir = model => client.messages.create({
      model, max_tokens: 3000, system: systemPrompt,
      messages: [{ role: 'user', content: `Dados da reunião:\n${JSON.stringify(contexto, null, 1)}` }],
    });

    let response;
    try { response = await pedir('claude-sonnet-5'); }
    catch (e) {
      console.warn('[Pauta IA] sonnet indisponível, caindo para haiku:', e.message);
      response = await pedir('claude-haiku-4-5-20251001');
    }

    let txt = response.content?.[0]?.text || '';
    const match = txt.match(/\{[\s\S]*\}/);
    if (match) txt = match[0];
    let roteiro;
    try { roteiro = JSON.parse(txt.trim()); }
    catch (e) { return res.status(500).json({ error: `IA devolveu JSON inválido: ${e.message}` }); }

    roteiro.geradoEm  = new Date().toISOString();
    roteiro.geradoPor = req.session.user.label || req.session.user.username;

    const dbw = await readDB();
    if (!dbw.pautas) dbw.pautas = {};
    const key = pautaKey(y, m, board);
    dbw.pautas[key] = { ...pautaVazia(y, m, board), ...(dbw.pautas[key] || {}), roteiro, updatedAt: new Date().toISOString() };
    await writeDB(dbw);

    res.json({ roteiro });
  } catch (e) {
    console.error('[Pauta IA]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/seed-weights-tmp (TEMPORÁRIO — remover após uso) ────────────────
// Exemplo: POST /api/seed-weights-tmp?secret=GL2026SEED  body: { year, month, weights }
app.post('/api/seed-weights-tmp', async (req, res) => {
  if (req.query.secret !== 'GL2026SEED') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { year, month, weights } = req.body;
    if (!year || !month || !weights) return res.status(400).json({ error: 'year, month e weights obrigatórios' });
    const key = monthKey(parseInt(year), parseInt(month));
    const db  = await readDB();
    if (!db.globalWeights) db.globalWeights = {};
    db.globalWeights[key] = weights;
    await writeDB(db);
    res.json({ ok: true, key, qtd: Object.keys(weights).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Porta abre imediatamente — MongoDB conecta em background para não bloquear o health check do Render
const _server = app.listen(PORT, () => {
  console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
});
// Timeout global: qualquer request que demore mais de 55s recebe erro
// (Microvix tem 45s max, então 55s cobre o pior caso + overhead)
_server.timeout      = 55_000;
_server.keepAliveTimeout = 65_000;

initMongo()
  .then(() => {

    // ── Cron: fechamento de caixa — diário 08:00 Brasília, sincroniza d-1 ──
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      cron.schedule('0 8 * * *', async () => {
        // Computa ontem em horário de Brasília via offset fixo UTC-3
        const now  = new Date();
        const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const yesterday = new Date(brt);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const syncYear  = yesterday.getUTCFullYear();
        const syncMonth = yesterday.getUTCMonth() + 1;
        const syncDay   = yesterday.getUTCDate();

        const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
        const boards = Object.keys(lojas);
        const pad2   = n => String(n).padStart(2, '0');
        console.log(`[caixa-cron] Sync d-1 (${syncDay}/${pad2(syncMonth)}/${syncYear}) para ${boards.length} loja(s)`);
        for (const board of boards) {
          try {
            const r = await syncCaixaBoard(board, syncYear, syncMonth, syncDay);
            console.log(`[caixa-cron] ${board}: ${r.skipped || `dia ${syncDay} sincronizado`}`);
          } catch (e) {
            console.error(`[caixa-cron] ${board}: ${e.message}`);
          }
        }
        console.log('[caixa-cron] Concluído');
      }, { timezone: 'America/Sao_Paulo' });
      console.log('[caixa-cron] Agendado para 08:00 America/Sao_Paulo');
    }

    // Remove contasPagar do documento store (migrado para coleção cpFaturas)
    if (mongoDb) {
      mongoDb.collection('store').updateOne(
        { _id: 'main', contasPagar: { $exists: true } },
        { $unset: { contasPagar: '' } }
      ).then(r => { if (r.modifiedCount) console.log('[migrate] contasPagar removido do store'); }).catch(() => {});
    }

    // Restaura lastSync do banco para o botão mostrar verde imediatamente após deploy
    readDB().then(db => { if (db.microvixLastSync) setLastSync(db.microvixLastSync); }).catch(() => {});

    // Warm-up do catálogo a partir do MongoDB (evita build pesado durante o primeiro auto-sync)
    if (mongoDb && process.env.MICROVIX_LOJAS) {
      _loadCatalogMongo().then(loaded => {
        if (loaded && Object.keys(loaded.map).length > 0) {
          _catalogCache   = loaded.map;
          _catalogCacheAt = loaded.updatedAt ? new Date(loaded.updatedAt).getTime() : Date.now();
          console.log(`[Catalog] Warm-up do MongoDB: ${Object.keys(_catalogCache).length} entradas`);
        } else {
          console.log('[Catalog] MongoDB vazio — catálogo será construído na primeira requisição');
        }
      }).catch(e => console.warn('[Catalog] Warm-up falhou:', e.message));
    }

    // Pré-aquece cache de marcas em background (startup + cron diário)
    async function _prewarmMarcasCache() {
      if (!process.env.MICROVIX_CHAVE || !process.env.MICROVIX_LOJAS) return;
      const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
      const SURFERS = ['delrey', 'minas', 'contagem', 'estacao'];
      const targetBoards = SURFERS.filter(b => lojas[b]);
      if (!targetBoards.length) return;
      const today = new Date().toISOString().slice(0, 10);
      // Mês atual: 1º dia até hoje
      const mesIni = today.slice(0, 8) + '01';
      // Últimos 90 dias
      const d90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const ini90 = d90.toISOString().slice(0, 10);

      // Verifica se já está em cache antes de disparar
      const cKeyHoje = _marcasCacheKey(targetBoards, today, today);
      const cKeyMes  = _marcasCacheKey(targetBoards, mesIni, today);
      const cKey90   = _marcasCacheKey(targetBoards, ini90, today);
      const { fetchMovimento, parseBrNum } = require('./services/microvix');
      const catalog = await _getCatalog(lojas).catch(() => ({}));

      async function _buildMarcasPayload(dtIni, dtFin) {
        const boardResults = await Promise.all(
          targetBoards.map(async b => {
            const cnpj  = (lojas[b] || '').replace(/\D/g, '');
            if (!cnpj) return [];
            const chave = process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
            try { return await fetchMovimento(cnpj, dtIni, dtFin, chave); }
            catch (e) { console.warn(`[prewarm/${b}] ${e.message}`); return []; }
          })
        );
        const byMarca = {};
        for (const rows of boardResults) {
          for (const row of rows) {
            if (row.cancelado === 'S' || row.cancelado === '1') continue;
            if (row.excluido  === 'S') continue;
            if (row.soma_relatorio === 'N') continue;
            const op = (row.operacao || '').toUpperCase();
            if (op !== 'S' && op !== 'DS') continue;
            const sign = op === 'DS' ? -1 : 1;
            const cod  = String(row.cod_produto || '').replace(/\.0+$/, '').trim();
            const barra = String(row.cod_barra || '').replace(/\.0+$/, '').trim();
            if (!cod) continue;
            const prodInfo = catalog[cod] || catalog[barra] || {};
            const marca = ((prodInfo.marca || row.desc_marca || row.marca || '').trim()) || '(sem marca)';
            const setor = ((prodInfo.setor || row.desc_setor || row.setor || '').trim()) || '(sem setor)';
            const nome  = (prodInfo.nomeBase || row.nome_produto || row.nome || row.descricao || cod).trim();
            const qtd   = sign * parseBrNum(row.quantidade  || '0');
            const valor = sign * parseBrNum(row.valor_total || '0');
            const mKey  = marca.toUpperCase();
            if (!byMarca[mKey]) byMarca[mKey] = { marca, qtd: 0, valor: 0, setores: {} };
            byMarca[mKey].qtd   += qtd;
            byMarca[mKey].valor += valor;
            const sKey = setor.toUpperCase();
            if (!byMarca[mKey].setores[sKey]) byMarca[mKey].setores[sKey] = { setor, qtd: 0, valor: 0, produtos: {} };
            byMarca[mKey].setores[sKey].qtd   += qtd;
            byMarca[mKey].setores[sKey].valor += valor;
            const rKey = (prodInfo.referencia || cod).toUpperCase();
            const cor  = prodInfo.desc_cor || '';
            const produtos = byMarca[mKey].setores[sKey].produtos;
            if (!produtos[rKey]) produtos[rKey] = { ref: prodInfo.referencia || cod, nome: prodInfo.nomeBase || nome, qtd: 0, valor: 0, cores: {} };
            produtos[rKey].qtd   += qtd;
            produtos[rKey].valor += valor;
            const cKey2 = cor.toUpperCase() || '__SEM_COR__';
            if (!produtos[rKey].cores[cKey2]) produtos[rKey].cores[cKey2] = { cor: cor || '—', qtd: 0, valor: 0 };
            produtos[rKey].cores[cKey2].qtd   += qtd;
            produtos[rKey].cores[cKey2].valor += valor;
          }
        }
        const result = Object.values(byMarca)
          .map(m => ({
            marca: m.marca, qtd: m.qtd, valor: parseFloat(m.valor.toFixed(2)),
            setores: Object.values(m.setores).map(s => ({
              setor: s.setor, qtd: s.qtd, valor: parseFloat(s.valor.toFixed(2)),
              produtos: Object.values(s.produtos).sort((a, b) => b.valor - a.valor).map(p => ({
                ref: p.ref, nome: p.nome, qtd: p.qtd, valor: parseFloat(p.valor.toFixed(2)),
                cores: Object.values(p.cores).sort((a, b) => b.valor - a.valor).map(c => ({ ...c, valor: parseFloat(c.valor.toFixed(2)) })),
              })),
            })).sort((a, b) => b.valor - a.valor),
          })).sort((a, b) => b.valor - a.valor);
        return { dtIni, dtFin, boards: targetBoards, total: result.length, marcas: result };
      }

      // Hoje
      if (!_marcasCache[cKeyHoje] || Date.now() - _marcasCache[cKeyHoje].at > 5 * 60 * 1000) {
        console.log('[prewarm] Pré-aquecendo cache de marcas — hoje');
        _buildMarcasPayload(today, today).then(p => {
          _marcasCache[cKeyHoje] = { data: p, at: Date.now() };
          console.log(`[prewarm] Cache de hoje pronto (${p.total} marcas)`);
        }).catch(e => console.warn('[prewarm/hoje]', e.message));
      }
      // Mês atual (lançado 5s depois para não disputar a API ao mesmo tempo)
      setTimeout(() => {
        if (!_marcasCache[cKeyMes] || Date.now() - _marcasCache[cKeyMes].at > 30 * 60 * 1000) {
          console.log('[prewarm] Pré-aquecendo cache de marcas — mês atual');
          _buildMarcasPayload(mesIni, today).then(p => {
            _marcasCache[cKeyMes] = { data: p, at: Date.now() };
            console.log(`[prewarm] Cache do mês pronto (${p.total} marcas)`);
          }).catch(e => console.warn('[prewarm/mes]', e.message));
        }
      }, 5000);
      // Últimos 90 dias (lançado 10s depois)
      setTimeout(() => {
        if (!_marcasCache[cKey90] || Date.now() - _marcasCache[cKey90].at > 60 * 60 * 1000) {
          console.log('[prewarm] Pré-aquecendo cache de marcas — últimos 90 dias');
          _buildMarcasPayload(ini90, today).then(p => {
            _marcasCache[cKey90] = { data: p, at: Date.now() };
            console.log(`[prewarm] Cache 90 dias pronto (${p.total} marcas)`);
          }).catch(e => console.warn('[prewarm/90d]', e.message));
        }
      }, 10_000);
    }

    // Dispara prewarm 10s após startup (catálogo precisa estar carregado primeiro)
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      setTimeout(() => _prewarmMarcasCache().catch(e => console.warn('[prewarm]', e.message)), 10_000);
      // Cron: re-aquece às 08:15 todo dia (após cron de fechamento às 08:00)
      cron.schedule('15 8 * * *', () => {
        console.log('[prewarm] Cron 08:15 — re-aquecendo cache de marcas');
        _prewarmMarcasCache().catch(e => console.warn('[prewarm cron]', e.message));
      }, { timezone: 'America/Sao_Paulo' });
      // Cron: rebuild do catálogo de produtos às 09:00 (TTL=24h, só uma vez por dia)
      cron.schedule('0 9 * * *', () => {
        console.log('[Catalog] Cron 09:00 — forçando rebuild do catálogo');
        const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
        _catalogCache = null; _catalogCacheAt = 0; // invalida cache
        _getCatalog(lojas).catch(e => console.warn('[Catalog cron]', e.message));
      }, { timezone: 'America/Sao_Paulo' });
    }

    // Auto-sync Microvix if credentials are set
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      console.log(`[Microvix] Auto-sync: dia corrente a cada ${MX_INTERVAL_MS / 60000} min, d-1 a cada ${MX_INTERVAL_D1_MS / 60000} min`);

      const doSync    = () => runSync(readDB, writeDB).catch(e => console.error('[Microvix]', e.message));
      const doHoje    = () => runSyncHoje(readDB, writeDB).catch(e => console.error('[Microvix/hoje]', e.message));
      const do30d     = () => runSync30Dias(readDB, writeDB).catch(e => console.error('[Microvix/30d]', e.message));

      setTimeout(do30d, MX_INTERVAL_30D_MS);
      console.log('[Microvix/30d] Conferência 30 dias agendada — 1× por dia');

      // Consumo do dia gravado a cada 2 min (e no shutdown) — sem isso o
      // contador zeraria a cada restart e nunca fecharia o total do dia
      setInterval(() => _flushUsoMicrovix().catch(e => console.warn('[Microvix/uso]', e.message)), 120_000);
      for (const sinal of ['SIGTERM', 'SIGINT']) {
        process.on(sinal, () => {
          _flushUsoMicrovix()
            .catch(e => console.warn('[Microvix/uso] flush final:', e.message))
            .finally(() => process.exit(0));
        });
      }

      setInterval(doSync, MX_INTERVAL_D1_MS);
      // doHoje defasado por metade do intervalo para nunca colidir com doSync
      setTimeout(() => setInterval(doHoje, MX_INTERVAL_MS), Math.floor(MX_INTERVAL_MS / 2));
      setInterval(do30d,  MX_INTERVAL_30D_MS);       // 30d: 1× por dia
    } else {
      console.log('[Microvix] Credenciais não configuradas — sync desativado');
    }

    // ── Cron: CRM — campanhas automáticas 08:30 Brasília ─────────────────
    if (mongoDb) {
      cron.schedule('30 8 * * *', async () => {
        console.log('[CRM] Executando campanhas agendadas…');
        runScheduledCampaigns(mongoDb).catch(e => console.error('[CRM cron]', e.message));
      }, { timezone: 'America/Sao_Paulo' });
      // Sync de clientes Microvix — todo dia 06:00
      if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
        cron.schedule('0 6 * * *', async () => {
          console.log('[CRM] Sync de clientes Microvix…');
          syncCustomers(mongoDb).catch(e => console.error('[CRM sync]', e.message));
        }, { timezone: 'America/Sao_Paulo' });
      }
      console.log('[CRM] Cron de campanhas agendado para 08:30 America/Sao_Paulo');
    }

    // ── Cron: contas a pagar — LinxFaturas diário 07:00 Brasília ─────────
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      cron.schedule('0 7 * * *', async () => {
        const today  = new Date().toISOString().slice(0, 10);
        const dtIni  = '2020-01-01';
        const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
        const boards = Object.entries(lojas);
        console.log(`[ContasPagar] Sync diário ${dtIni} → ${today} (${boards.length} loja(s))`);
        let total = 0;
        const errors = [];
        for (const [board, cnpj] of boards) {
          const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
          try {
            const rows = [];
            await _fetchFaturas(cnpj, chave, dtIni, today, r => {
              const fat = _normalizeFatura(r, board, board, today);
              if (fat && fat.isPagar) rows.push(fat);
            });
            await writeContasPagarBoard(board, rows);
            total += rows.length;
            console.log(`[ContasPagar] ${board}: ${rows.length} faturas`);
          } catch (e) {
            errors.push({ board, error: e.message });
            console.error(`[ContasPagar] ${board}:`, e.message);
          }
        }
        await writeContasPagarMeta({ syncedAt: new Date().toISOString(), dtIni, dtFin: today, errors });
        console.log(`[ContasPagar] Sync OK — ${total} faturas a pagar`);
      }, { timezone: 'America/Sao_Paulo' });
      console.log('[ContasPagar] Cron agendado para 07:00 America/Sao_Paulo');
    }

    // ── Cron: pendência de adiantamento — todo dia 17 às 08:00 Brasília ──
    {
      const ADI_STORES = ['delrey', 'estacao', 'contagem', 'minas', 'tommy'];
      const ADI_TAG    = 'adiantamento-mensal';
      const ADI_TEXT   = 'Adiantamento de funcionários';

      async function ensureAdiantamentoReminders() {
        const brt   = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const year  = brt.getUTCFullYear();
        const month = brt.getUTCMonth() + 1;
        const day   = brt.getUTCDate();
        if (day < 17) return;
        const db = await readDB();
        if (!db.meetingItems) db.meetingItems = [];
        let changed = false;
        for (const board of ADI_STORES) {
          const exists = db.meetingItems.some(x =>
            x.board === board && x.year === year && x.month === month && x.autoTag === ADI_TAG
          );
          if (!exists) {
            db.meetingItems.push({
              id:         nextId(db),
              text:       ADI_TEXT,
              board,
              year,
              month,
              visibility: 'loja',
              origin:     'auto',
              autoTag:    ADI_TAG,
              checked:    false,
              archived:   false,
              addedBy:    'Sistema',
              addedAt:    new Date().toISOString(),
            });
            changed = true;
          }
        }
        if (changed) await writeDB(db);
      }

      cron.schedule('0 8 17 * *', () => {
        ensureAdiantamentoReminders().catch(e => console.error('[adi-cron]', e.message));
      }, { timezone: 'America/Sao_Paulo' });
      console.log('[adi-cron] Agendado para dia 17 de cada mês às 08:00 America/Sao_Paulo');

      // Garante criação ao iniciar (para meses onde o server reiniciou após o dia 17)
      ensureAdiantamentoReminders().catch(e => console.error('[adi-startup]', e.message));
    }
  })
  .catch(err => {
    console.error('Falha ao conectar MongoDB:', err.message);
    // Não encerra o processo — servidor já está ouvindo na porta
  });
