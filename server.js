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
const { runSync, runSyncHoje, runSync30Dias, runSyncRetroativo, getStatus, setLastSync } = require('./services/microvixSync');

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
    serverSelectionTimeoutMS: 10000,
    tls: true,
    tlsAllowInvalidCertificates: false,
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
    const { _id, ...data } = doc;
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

function nextId(db) {
  const id = db.nextId;
  db.nextId = (db.nextId || 1) + 1;
  return id;
}

function readUsers() {
  const f = fs.existsSync(USERS_FILE) ? USERS_FILE : SEED_USERS;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return {}; }
}

function writeUsers(users) {
  const data = JSON.stringify(users, null, 2);
  fs.writeFileSync(USERS_FILE, data);
  // Mantém seed em sincronia para sobreviver a redeploys
  if (USERS_FILE !== SEED_USERS) {
    try { fs.writeFileSync(SEED_USERS, data); } catch (_) {}
  }
}

const BOARDS   = ['admin','escritorio','delrey','minas','contagem','estacao','tommy','lez'];
const SECTIONS = ['performance','estoque_marca','estoque_grupo','pauta','pendencias'];

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
  if (req.session.user.board)
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
  req.session.user = { username: key, board: user.board, label: user.label, passwordChangedAt: user.passwordChangedAt || null, mustChangePassword: !!user.mustChangePassword };
  res.json({ username: key, board: user.board, label: user.label, mustChangePassword: !!user.mustChangePassword });
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

// ── GET /api/users  (admin) ────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = readUsers();
  const list = Object.entries(users).map(([username, u]) => ({
    username, label: u.label || username, board: u.board || null
  }));
  res.json(list);
});

// ── POST /api/users  (admin) ───────────────────────────────────────────────
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, label, board } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  const key = username.toLowerCase().trim();
  const users = readUsers();
  if (users[key]) return res.status(409).json({ error: 'Usuário já existe' });
  users[key] = { password, label: label || key, board: board || null, mustChangePassword: true };
  writeUsers(users);
  res.json({ ok: true, username: key });
});

// ── PUT /api/users/:username  (admin) ─────────────────────────────────────
app.put('/api/users/:username', requireAdmin, (req, res) => {
  const key = req.params.username.toLowerCase();
  const users = readUsers();
  if (!users[key]) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { password, label, board } = req.body || {};
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
    const { board } = req.session.user;
    const isAdminOrEscritorio = !board || board === 'escritorio';

    // Employees — sem foto para reduzir tamanho da resposta (fotos carregam em background)
    const allEmps = db.employees || [];
    const stripFoto = e => { const { foto, ...rest } = e; return rest; };
    const employees = (isAdminOrEscritorio ? allEmps : allEmps.filter(e => e.board === board)).map(stripFoto);

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
    const campaigns = board ? allCamps.filter(c => c.scope === 'rede' || c.stores.includes(board)) : allCamps;

    // Meeting items filtered by board
    const allMeeting = db.meetingItems || [];
    const meetingItems = allMeeting.filter(x =>
      isAdminOrEscritorio || (x.board === board && x.visibility === 'loja')
    );

    // Requisições filtered by board
    const allReq = db.requisicoes || [];
    const requisicoes = allReq
      .filter(x => isAdminOrEscritorio || x.board === board)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Pendências — admin/escritorio only
    const pendencias = isAdminOrEscritorio ? (db.pendencias || []) : [];

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
      requisicoes,
      indevaStats:  indevaResult,
    });
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
    const { name, board, cpf, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, inativo, desligamento, apelido, microvixCod } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = await readDB();
    if (!db.employees) db.employees = [];
    const emp = {
      id: nextId(db), name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod ? String(microvixCod).trim() : '',
      cpf: cpf || '', admissao: admissao || '',
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
      inativo: inativo === true || inativo === 'true',
      desligamento: desligamento || '',
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
    const { name, board, cpf, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, inativo, desligamento, apelido, microvixCod, foto } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    // Se foto === '' → remover; se foto !== undefined → atualizar; se undefined → não mudar
    if (foto === '') await writePhoto(id, null);
    db.employees[idx] = {
      ...db.employees[idx], name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod !== undefined ? String(microvixCod).trim() : (db.employees[idx].microvixCod || ''),
      cpf: cpf || '', admissao: admissao || '',
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
      inativo: inativo === true || inativo === 'true',
      desligamento: desligamento || '',
    };
    await writeDB(db);
    res.json(db.employees[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/:id ──────────────────────────────────────────────
app.delete('/api/employees/:id', requireAuth, async (req, res) => {
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
      const vac = vsMap[empId]?.meta?.vacationDays || [];
      if (metaLoja > 0) {
        if (vac.includes(ds)) return 0;
        const w = gWeights[ds] ?? defW;
        const nActive = emps.filter(e => !(vsMap[e.id]?.meta?.vacationDays || []).includes(ds)).length;
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
        { key:'pcs',   width:7  }, { key:'atd',   width:8  },
        { key:'pa',    width:7  },
      ];
      const isTotal = empId === 'total';
      const mensal  = isTotal
        ? emps.reduce((s,e) => s + sellerMensal(e.id), 0)
        : sellerMensal(empId);

      ws.mergeCells('A1:K1');
      const titleCell = ws.getCell('A1');
      const empObj    = emps.find(e => e.id === empId);
      const subtitle  = isTotal ? 'TOTAL DA LOJA' : (empObj ? (empObj.apelido || empObj.name) : sheetName);
      titleCell.value = `${storeName.toUpperCase()} — ${MONTHS_PT[m-1].toUpperCase()} ${y} — ${subtitle.toUpperCase()}`;
      titleCell.fill  = C.TITLE_BG(storeColor);
      titleCell.font  = C.TITLE_FG;
      titleCell.alignment = { horizontal:'center', vertical:'middle' };
      ws.getRow(1).height = 22;

      ws.mergeCells('A2:K2');
      const subCell = ws.getCell('A2');
      subCell.value = `Meta Mensal: R$ ${mensal.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
      subCell.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF252E3D' } };
      subCell.font  = { bold:true, color:{ argb:'FFADBAC7' }, size:9, name:'Calibri' };
      subCell.alignment = { horizontal:'center', vertical:'middle' };
      ws.getRow(2).height = 16;

      const HEADS = ['DATA','DIA','META DIÁRIA','META ACUMULADA','% ATING','DESVIO','VALOR REALIZADO','PROJEÇÃO','PÇ','ATEND','PA'];
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

        const EDITABLE = new Set([7, 9, 10]);
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

        set(1, `${pad(d)}/${pad(m)}`, '@');
        set(2, DAY_PT[dow], '@');
        set(3, metaDia > 0 ? +metaDia.toFixed(4) : null, fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(4, { formula: d===1 ? `C${cRow}` : `D${cRow-1}+C${cRow}`, result: +metaAcum.toFixed(2) },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(5, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})/D${cRow}*100,"")`, result: pctAting ?? '' },
            fmtPct, isWE ? C.WE_BG : C.CALC_BG);
        set(6, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})-D${cRow},"")`, result: desvio ?? '' },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(7, valor > 0 ? +valor.toFixed(2) : null, fmtBRL);
        set(8, { formula:`IF(SUM(G4:G${cRow})>0,SUM(G4:G${cRow})/${wAcum},"")`, result: proj ?? '' },
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(9,  pecas > 0 ? pecas : null, fmtInt);
        set(10, atend > 0 ? atend : null, fmtInt);
        set(11, { formula:`IF(J${cRow}>0,I${cRow}/J${cRow},"")`, result: pa ?? '' },
            fmtDec, isWE ? C.WE_BG : C.CALC_BG);
      }

      const totRow = ws.getRow(N + 4);
      totRow.height = 18;
      const d1 = 4, dLast = N + 3;
      [
        ['TOTAL', '@'],
        ['', '@'],
        [{ formula:`SUM(C${d1}:C${dLast})` }, fmtBRL],
        [{ formula:`D${dLast}` },              fmtBRL],
        [{ formula:`IF(D${N+4}>0,G${N+4}/D${N+4}*100,"")` }, fmtPct],
        [{ formula:`IF(D${N+4}>0,G${N+4}-D${N+4},"")` },     fmtBRL],
        [{ formula:`SUM(G${d1}:G${dLast})` }, fmtBRL],
        [{ formula:`IF(G${N+4}>0,G${N+4}/${weightAcumByDay[N]},"")` }, fmtBRL],
        [{ formula:`SUM(I${d1}:I${dLast})` }, fmtInt],
        [{ formula:`SUM(J${d1}:J${dLast})` }, fmtInt],
        [{ formula:`IF(J${N+4}>0,I${N+4}/J${N+4},"")` }, fmtDec],
      ].forEach(([val, fmt], i) => {
        const cell = totRow.getCell(i + 1);
        cell.value = val; if (fmt && fmt !== '@') cell.numFmt = fmt;
        cell.fill = C.TOT_BG; cell.font = C.TOT_FG;
        cell.border = thinBorder;
        cell.alignment = { horizontal: i < 2 ? 'center' : 'right', vertical:'middle' };
        cell.protection = { locked: true };
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
    for (const emp of emps)
      await buildSheet(wb, (emp.apelido || emp.name).slice(0, 31), emp.id);
    await buildSheet(wb, 'TOTAL', 'total');

    res.setHeader('Content-Disposition', `attachment; filename="fechamento-${board}-${pad(m)}-${y}.xlsx"`);
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
      item.archived = true;
      item.archivedAt = new Date().toISOString();
      item.archivedBy = req.session.user.label || req.session.user.username;
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
    const { embalagens, materiais, observacao } = req.body;
    const db = await readDB();
    if (!db.requisicoes) db.requisicoes = [];
    const item = {
      id: nextId(db), board,
      embalagens: embalagens || {},
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
      const serie = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      if (serie === '999') continue;
      if (serie === '4' && r.operacao !== 'DS') continue;
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
    if (caixaByDay[d] !== undefined || sangriaByDay[d] !== undefined) {
      db.caixa[key][d] = {
        ...prev,
        caixa:    caixaByDay[d]   !== undefined ? caixaByDay[d]   : (prev.caixa   ?? 0),
        sangria:  sangriaByDay[d] !== undefined ? sangriaByDay[d] : (prev.sangria ?? 0),
        syncedAt: new Date().toISOString(),
      };
    }
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
      const isDup   = seenDocs.has(doc);
      const val     = parseBrNum(r.total_dinheiro || '0');
      const sign    = isDev ? -1 : 1;
      const cnpjMatch = !rowCnpj || rowCnpj === cnpjClean;
      const counted = cnpjMatch && !isCancelled && !isWrongOp && !isSerie999 && !isSerie4S && !isDup && val !== 0;
      dinheiroRows.push({ doc, serie, data_documento: r.data_documento, cnpj_emp: r.cnpj_emp, cancelado: r.cancelado, operacao: r.operacao, total_dinheiro: r.total_dinheiro, _cnpjMatch: cnpjMatch, _isDup: isDup, _isCancelled: isCancelled, _isDev: isDev, _isSerie999: isSerie999, _isSerie4S: isSerie4S, _counted: counted });
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

    const result = { pagamentos: {}, sangrias: {} };
    for (const cmd of pagCandidates) {
      result.pagamentos[cmd] = await tryCmd(cmd).catch(e => ({ ok: false, msg: e.message }));
    }
    for (const cmd of sangriaCandidates) {
      result.sangrias[cmd] = await tryCmd(cmd).catch(e => ({ ok: false, msg: e.message }));
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
    if (!req.body.nome?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    const db = await readDB();
    if (!db.boletas)   db.boletas   = [];
    if (!db.boletaSeq) db.boletaSeq = {};
    if (!db.boletaSeq[board]) db.boletaSeq[board] = 0;
    db.boletaSeq[board]++;
    const fields = ['nome','cpf','endereco','numeroEnd','compl','bairro','cep','cidade','tel','email',
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
    const fields = ['nome','cpf','endereco','numeroEnd','compl','bairro','cep','cidade','tel','email',
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
const MX_INTERVAL_30D_MS = 24 * 60 * 60 * 1000; // conferência 30d: 1× por dia

// GET  /api/microvix/status  → last sync info
app.get('/api/microvix/status', requireAuth, (req, res) => {
  res.json(getStatus());
});

// POST /api/microvix/sync    → manual trigger
app.post('/api/microvix/sync', requireAuth, async (req, res) => {
  try {
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
app.get('/api/microvix/raw', async (req, res) => {
  try {
    const { fetchMovimento } = require('./services/microvix');
    const cnpj = req.query.cnpj || firstCnpj();
    if (!cnpj) return res.status(400).json({ error: 'MICROVIX_LOJAS não configurado' });
    const today = new Date().toISOString().slice(0, 10);
    const rows  = await fetchMovimento(cnpj, today, today);
    res.json({ date: today, count: rows.length, sample: rows.slice(0, 5), fields: rows[0] ? Object.keys(rows[0]) : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/microvix/lojas    → TEMP: testa LinxLojas (só chave, sem CNPJ)
app.get('/api/microvix/lojas', async (req, res) => {
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
app.get('/api/microvix/teste', async (req, res) => {
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
app.get('/api/microvix/lojas-emp', async (req, res) => {
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
app.get('/api/microvix/conferencia', async (req, res) => {
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

// ── Transferências: cache de resultado (TTL 30min) ─────────────────────────
let _transResultCache = {};
let _transWarmRunning = {};
const TRANS_RESULT_TTL = 30 * 60 * 1000;

// Cache do catálogo de produtos (LinxProdutos) — válido por 6 horas
let _catalogCache = null;
let _catalogCacheAt = 0;
const CATALOG_TTL = 6 * 60 * 60 * 1000;

async function _getCatalog(lojas) {
  if (_catalogCache && Date.now() - _catalogCacheAt < CATALOG_TTL) return _catalogCache;
  const { fetchProdutos } = require('./services/microvix');
  const firstBoard = Object.keys(lojas)[0];
  if (!firstBoard) return {};
  const cnpj  = lojas[firstBoard].replace(/\D/g, '');
  const chave = process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  try {
    const rows = await fetchProdutos(cnpj, chave, 0);
    if (rows.length > 0) {
      // Log de diagnóstico — mostra campos disponíveis no primeiro registro
      const allKeys = Object.keys(rows[0]);
      const priceKeys = allKeys.filter(k => /preco|price|valor|vlr/i.test(k));
      console.log('[Catalog] Campos do LinxProdutos:', allKeys.join(', '));
      console.log('[Catalog] Campos de preço:', priceKeys.join(', ') || '(nenhum)');
    }
    // Busca case-insensitive para campos de preço — nomes variam por conta Microvix
    const findField = (r, ...terms) => {
      const keys = Object.keys(r);
      for (const term of terms) {
        const k = keys.find(k => k.toLowerCase().replace(/_/g,'') === term.toLowerCase().replace(/_/g,''));
        if (k && r[k] && r[k] !== '0' && r[k] !== '') return r[k];
      }
      return '0';
    };
    const map  = {};
    for (const r of rows) {
      const cod = String(r.cod_produto || '').trim();
      if (!cod) continue;
      map[cod] = {
        nome:        (r.nome         || '').trim(),
        setor:       (r.desc_setor   || '').trim(),
        marca:       (r.desc_marca   || '').trim(),
        linha:       (r.desc_linha   || '').trim(),
        desc_cor:    (r.desc_cor     || '').trim(),
        desc_tam:    (r.desc_tamanho || '').trim(),
        preco_cheio: parseBrNum(findField(r, 'preco_venda', 'precovenda', 'vlr_venda', 'vlrvenda', 'preco', 'valor_venda')),
        preco_promo: parseBrNum(findField(r, 'preco_promocional', 'precopromocional', 'vlr_promo', 'vlrpromo', 'preco_promo', 'precopromocao')),
      };
    }
    _catalogCache   = map;
    _catalogCacheAt = Date.now();
    return map;
  } catch (e) {
    console.warn('[Catalog] Erro ao buscar LinxProdutos:', e.message);
    return _catalogCache || {};
  }
}

// Calcula transferências proporcionais ao giro de cada loja.
// Retorna { transfers, workStocks, ideal } ou null se não há movimento.
//   - ideal[b]: estoque ideal calculado pelo giro
//   - donors: lojas com excesso (stock > ideal), ordenadas por maior excesso
//   - receivers: lojas com déficit (stock < ideal), ordenadas por maior déficit
//   - A doadora cede apenas seu excesso → seu giro é respeitado
// periodDays: duração do período do giro (ex: 90 dias para Microvix, ~510 para Excel de 17 meses)
function _calcTransfersProporcional(boards, stocks, giro, periodDays = 90) {
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

  // Regra 2: receptora só recebe se estoque = 0 e tem histórico de vendas
  // (cobertura com stock=0 é sempre 0 meses, portanto regra de cobertura satisfeita automaticamente)
  const receivers = boards
    .filter(b => (stocks[b] || 0) === 0 && (giro[b] || 0) > 0)
    .sort((a, b) => delta[a] - delta[b]);

  if (!donors.length || !receivers.length) return null;

  const workStocks = { ...stocks };
  const workDelta  = { ...delta };
  const transfers  = [];

  for (const rec of receivers) {
    let needed = -workDelta[rec];
    for (const don of donors) {
      if (workDelta[don] <= 0) continue;
      // Garante que a doadora não fique com menos de 1 peça
      const maxSend = (workStocks[don] || 0) - 1;
      if (maxSend <= 0) continue;
      const qty = Math.min(needed, workDelta[don], maxSend);
      if (qty <= 0) continue;
      transfers.push({ de: don, para: rec, qty });
      workStocks[don] -= qty;
      workStocks[rec] += qty;
      workDelta[don]  -= qty;
      workDelta[rec]  += qty;
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

  const estoqueByBoard = {};
  const giroByBoard    = {};
  const catalogMov     = {};   // fallback info vinda dos movRows (campos limitados)
  const ultVendaMap    = {};   // última venda por cod_produto (cross-board)
  const ultCompraMap   = {};   // última entrada por cod_produto (cross-board)

  // Busca catálogo (setor, marca) em paralelo com estoque/movimento
  const [catalog] = await Promise.all([
    _getCatalog(lojas),
    Promise.all(boards.map(async board => {
    const cnpj  = lojas[board].replace(/\D/g, '');
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
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

      const raw = (r.data_documento || r.data_lancamento || '').slice(0, 10);
      const iso = raw && raw.includes('/')
        ? (() => { const [d,m,y] = raw.split('/'); return `${y}-${m}-${d}`; })()
        : raw;

      if (isEntrada) {
        if (iso && (!ultCompraMap[cod] || iso > ultCompraMap[cod])) ultCompraMap[cod] = iso;
        continue;
      }
      if (operacao === 'DS') continue;

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

    const calc = _calcTransfersProporcional(boards, stocks, giro, dias);
    if (!calc) continue;
    const { transfers, workStocks, ideal } = calc;

    const cat = catalog[cod] || {};
    const mov = catalogMov[cod] || {};
    sugestoes.push({
      cod_produto:  cod,
      cod_barra,
      descricao:    cat.nome      || mov.descricao    || '—',
      desc_cor:     cat.desc_cor  || mov.desc_cor     || '—',
      desc_tamanho: cat.desc_tam  || mov.desc_tamanho || '—',
      setor:        cat.setor     || mov.setor        || '—',
      marca:        cat.marca     || '—',
      linha:        cat.linha     || '—',
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

// GET /api/catalog — catálogo de produtos do Microvix (para cálculo client-side)
// ?debug=1 → retorna amostra com campos brutos para diagnóstico de preços
app.get('/api/catalog', requireAdmin, async (req, res) => {
  try {
    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    // Debug: mostra campos brutos do LinxProdutos para diagnosticar nomes de campos de preço
    if (req.query.debug === '1') {
      const { fetchProdutos } = require('./services/microvix');
      const firstBoard = Object.keys(lojas)[0];
      if (!firstBoard) return res.json({ error: 'Nenhuma loja configurada' });
      const cnpj  = lojas[firstBoard].replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      const rows  = await fetchProdutos(cnpj, chave, 0);
      const sample = rows.slice(0, 3);
      const priceFields = sample.length > 0
        ? Object.keys(sample[0]).filter(k => /preco|price|valor|vlr/i.test(k))
        : [];
      return res.json({ total: rows.length, fields: sample[0] ? Object.keys(sample[0]) : [], priceFields, sample });
    }
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    res.json(catalog);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
        descricao:    cat.nome     || p.descricao || '—',
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
    let companies = [];   // [{ board, vendaCol, saldoCol }]
    let headerSheetIdx = -1;

    console.log('[Excel] Abas encontradas:', wb.SheetNames);

    for (let i = 0; i < wb.SheetNames.length; i++) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 });
      // Aceita 'Código' com ou sem acento, e 'Codigo'
      const colRowIdx = rows.findIndex(r => Array.isArray(r) &&
        r.some(c => typeof c === 'string' && c.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase() === 'codigo'));
      console.log(`[Excel] Aba ${i} "${wb.SheetNames[i]}": colRowIdx=${colRowIdx}, totalRows=${rows.length}`);
      if (colRowIdx === -1) continue;
      headerSheetIdx = i;
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

    // Lê todas as abas de dados (após o header)
    const stocksMap  = {};  // cod → { board: qty }
    const giroMap    = {};  // cod → { board: qty }
    const catalogMap = {};  // cod → { descricao, setor, ultimaCompra }

    // setor persiste entre abas: uma aba tem o label, a(s) seguinte(s) têm os dados
    let currentSetor = '';
    for (let i = headerSheetIdx + 1; i < wb.SheetNames.length; i++) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 });
      for (const r of rows) {
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
          // Col 8 = "Data Última compra" em formato DD/MM/YYYY
          const rawDate = String(r[8] || '').trim();
          let ultimaCompra = null;
          if (rawDate && rawDate !== '-' && rawDate.includes('/')) {
            const [d, m, y] = rawDate.split('/');
            ultimaCompra = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
          }
          catalogMap[cod] = { descricao: String(r[1] || '').trim(), setor: currentSetor, ultimaCompra };
        }
      }
    }

    // Enriquece com catálogo Microvix (setor, marca) e aplica lógica proporcional
    const lojas = (() => { try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; } })();
    const catalog = await _getCatalog(lojas).catch(() => ({}));

    const sugestoes = [];

    for (const [cod, stocks] of Object.entries(stocksMap)) {
      const giro = giroMap[cod] || {};
      const calc = _calcTransfersProporcional(boards, stocks, giro);
      if (!calc) continue;
      const { transfers, workStocks, ideal } = calc;

      const cat  = catalog[cod]  || {};
      const info = catalogMap[cod] || {};
      sugestoes.push({
        cod_produto:  cod,
        descricao:    cat.nome     || info.descricao || '—',
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

    res.json({ boards, dias: null, total: sugestoes.length, sugestoes, source: 'excel' });
  } catch (e) {
    console.error('[Equalizacao Excel]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/transferencias/preload — dispara aquecimento, responde imediatamente
app.get('/api/transferencias/preload', requireAdmin, (req, res) => {
  const { boards, lojas, firstCnpj, firstChave } = _transBoards(null);
  if (!boards.length) return res.json({ ok: false, error: 'Sem lojas configuradas' });
  _warmAllTrans(boards, lojas, 30, firstCnpj, firstChave);
  res.json({ ok: true, msg: 'Aquecimento iniciado em background' });
});

// GET /api/transferencias?dias=30&lojas=delrey,minas,contagem,estacao
// Nunca faz chamadas Microvix — apenas lê cache ou retorna cacheLoading:true
app.get('/api/transferencias', requireAdmin, (req, res) => {
  try {
    const dias = Math.max(1, parseInt(req.query.dias || '30'));
    const { boards, lojas, firstCnpj, firstChave } = _transBoards(req.query.lojas || null);
    if (!boards.length) return res.status(400).json({ error: 'Nenhuma loja configurada em MICROVIX_LOJAS' });
    _warmAllTrans(boards, lojas, dias, firstCnpj, firstChave).catch(e =>
      console.warn('[Trans] warm bg error:', e.message)
    );
    const cached = _transResultCache[String(dias)];
    if (cached && Date.now() - cached.at < TRANS_RESULT_TTL)
      return res.json(cached.result);
    return res.json({ cacheLoading: true, msg: 'Preparando dados… tente novamente em alguns segundos.' });
  } catch (e) {
    console.error('[Trans] endpoint error:', e.message);
    return res.status(500).json({ error: e.message });
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
    db.indeva[board] = { fila: [], atendendo: [], atendimentos: [], date: today, historico: {} };
  } else if (db.indeva[board].date !== today) {
    const s = db.indeva[board];
    if (!s.historico) s.historico = {};
    if (s.atendimentos?.length > 0) {
      s.historico[s.date] = { date: s.date, atendimentos: s.atendimentos };
    }
    s.fila = [];
    s.atendendo = [];
    s.atendimentos = [];
    s.date = today;
  }
  const s = db.indeva[board];
  if (!Array.isArray(s.atendendo)) s.atendendo = s.atendendo != null ? [s.atendendo] : [];
  if (!s.historico) s.historico = {};
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
    store.atendendo = store.atendendo.filter(x => x !== id);
    store.fila = store.fila.filter(x => x !== id);
    store.fila.push(id);
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

// ── GET /api/contas-pagar — serve dados do cache (portal scraping) ────────
app.get('/api/contas-pagar', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const cp    = db.contasPagar || {};
  const rows  = cp.rows || [];

  const dtIni = req.query.de  || cp.dtIni || today.slice(0, 7) + '-01';
  const dtFin = req.query.ate || cp.dtFin || today;

  // Filtra por período solicitado
  const items = rows.filter(r => {
    if (!r.vencimento) return true;
    return r.vencimento >= dtIni && r.vencimento <= dtFin;
  });

  items.sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''));
  res.json({ items, errors: [], dtIni, dtFin, syncedAt: cp.syncedAt || null, totalCached: rows.length });
});

// GET /api/contas-pagar/raw — testa múltiplas combinações de comando/parâmetros
app.get('/api/contas-pagar/raw', requireAdmin, async (req, res) => {
  try {
    const { board, de, ate } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board] || Object.values(lojas)[0];
    const chave = process.env[`MICROVIX_CHAVE_${(board||'').toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
    const dtIni = de  || today.slice(0,7)+'-01';
    const dtFin = ate || today;

    // Converte YYYY-MM-DD → DD/MM/YYYY
    const toBR = s => s.split('-').reverse().join('/');

    const CANDIDATES = [
      { label:'LinxContasPagar + data_inicial YYYY',    cmd:'LinxContasPagar',  params:[{id:'data_inicial',valor:dtIni},{id:'data_fim',valor:dtFin}] },
      { label:'LinxContasPagar + data_inicial DD/MM',   cmd:'LinxContasPagar',  params:[{id:'data_inicial',valor:toBR(dtIni)},{id:'data_fim',valor:toBR(dtFin)}] },
      { label:'LinxContasPagar sem datas',              cmd:'LinxContasPagar',  params:[] },
      { label:'LinxContasAPagar + data_inicial YYYY',   cmd:'LinxContasAPagar', params:[{id:'data_inicial',valor:dtIni},{id:'data_fim',valor:dtFin}] },
      { label:'LinxContasAPagar sem datas',             cmd:'LinxContasAPagar', params:[] },
      { label:'LinxTitulosPagar + data_inicial YYYY',   cmd:'LinxTitulosPagar', params:[{id:'data_inicial',valor:dtIni},{id:'data_fim',valor:dtFin}] },
      { label:'LinxTitulosPagar sem datas',             cmd:'LinxTitulosPagar', params:[] },
    ];

    const results = [];
    for (const c of CANDIDATES) {
      try {
        const body = buildRequest(c.cmd, cnpj, c.params, chave);
        const raw  = await postRequest(body, 20_000);
        const isXml = raw.trim().startsWith('<');
        const isErr = raw.includes('<ResponseSuccess>False</ResponseSuccess>');
        const errMsg = isErr ? (raw.match(/<Message>([^<]+)<\/Message>/)||[])[1] : null;
        const rows = (!isXml && !isErr) ? parseCsv(raw) : [];
        results.push({ label:c.label, isErr, errMsg, rowCount:rows.length, fields:rows[0]?Object.keys(rows[0]):[], rawSnippet:raw.slice(0,300) });
        if (!isErr && !isXml && rows.length > 0) break;
      } catch (e) {
        results.push({ label: c.label, error: e.message });
      }
    }
    res.json({ board: board || Object.keys(lojas)[0], cnpj: cnpj?.replace(/\d(?=\d{3})/g,'*'), dtIni, dtFin, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/contas-pagar', (req, res) => res.sendFile(path.join(__dirname, 'public/contas-pagar.html')));

// ── POST /api/contas-pagar/sync — dispara scraping manual (admin) ─────────
app.post('/api/contas-pagar/sync', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dtIni = req.body?.de  || today.slice(0, 7) + '-01';
    const dtFin = req.body?.ate || today;

    res.writeHead(200, { 'Content-Type': 'application/json' });

    const { scrapeContasPagar } = require('./services/microvixPortal');
    const result = await scrapeContasPagar(dtIni, dtFin);

    if (!db.contasPagar) db.contasPagar = {};
    db.contasPagar.rows      = result.rows || [];
    db.contasPagar.dtIni     = dtIni;
    db.contasPagar.dtFin     = dtFin;
    db.contasPagar.syncedAt  = new Date().toISOString();
    db.contasPagar.logs      = result.logs || [];
    await writeDB(db);

    res.end(JSON.stringify({ ok: true, count: result.rows.length, syncedAt: db.contasPagar.syncedAt, logs: result.logs, warning: result.warning }));
  } catch (e) {
    console.error('[contasPagar/sync]', e.message);
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

// ── GET /api/contas-pagar/status — última sincronização (admin) ───────────
app.get('/api/contas-pagar/status', requireAdmin, (req, res) => {
  const cp = db.contasPagar || {};
  res.json({ syncedAt: cp.syncedAt || null, count: (cp.rows || []).length, dtIni: cp.dtIni, dtFin: cp.dtFin, logs: cp.logs || [] });
});

// ── GET /api/contas-pagar/debug/:file — serve screenshots de debug ────────
app.get('/api/contas-pagar/debug/:file', requireAdmin, (req, res) => {
  const { getDebugScreenshots } = require('./services/microvixPortal');
  const shots = getDebugScreenshots();
  const shot  = shots.find(s => s.name === req.params.file);
  if (!shot) return res.status(404).send('não encontrado');
  res.sendFile(shot.path);
});

// ── Folha de Pagamento ─────────────────────────────────────────────────────

app.get('/folha', (req, res) => res.sendFile(path.join(__dirname, 'public/folha.html')));

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
    const lastDayStr = `${year}-${padD(month)}-${padD(lastDay.getDate())}`;

    const semanas = [];
    for (const [weekStart, weekData] of Object.entries(weeklyMetasMonth)) {
      const ws = new Date(weekStart + 'T12:00:00');
      const we = new Date(ws); we.setDate(we.getDate() + 6);
      const weStr = `${we.getFullYear()}-${padD(we.getMonth()+1)}-${padD(we.getDate())}`;
      const skipped = weStr > lastDayStr || weStr >= todayStr;
      semanas.push({
        weekStart, weStr, skipped,
        empMetas: Object.keys(weekData).length,
        empIds: Object.keys(weekData),
      });
    }
    res.json({
      mk, todayStr, lastDayStr,
      semanasComMeta: semanas.length,
      semanas,
      empIds: employees.map(e => ({ id: e.id, name: e.name, board: e.board })),
      vsalesKeys: Object.keys(vsalesAll).filter(k => k.startsWith(mk)),
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

    // Inclui funcionários inativos que têm folha salva neste mês
    const savedFolha  = (db.folhas || {})[mk] || {};
    const savedEmpIds = new Set();
    for (const boardData of Object.values(savedFolha))
      for (const id of Object.keys(boardData.entries || {})) savedEmpIds.add(parseInt(id));
    const employees = (db.employees || []).filter(e => !e.inativo || savedEmpIds.has(e.id));

    const vsalesAll = db.vsales || {};

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
    const weeklyMetasMonth = (db.weeklyMetas || {})[mk] || {};
    const globalWeights    = (db.globalWeights || {})[mk] || {};
    const daysInMonth      = new Date(year, month, 0).getDate();
    const todayStr   = new Date().toISOString().slice(0, 10);
    const lastDay    = new Date(year, month, 0);
    const padD       = n => String(n).padStart(2,'0');
    const lastDayStr = `${year}-${padD(month)}-${padD(lastDay.getDate())}`;
    const monthStart = `${year}-${padD(month)}-01`;
    const premiacaoSemanal        = {};
    const premiacaoSemanalDetalhe = {};
    for (const emp of employees) {
      premiacaoSemanal[emp.id]        = 0;
      premiacaoSemanalDetalhe[emp.id] = [];
    }

    const boardEmpsMap = {};
    for (const emp of employees) {
      if (!boardEmpsMap[emp.board]) boardEmpsMap[emp.board] = [];
      boardEmpsMap[emp.board].push(emp);
    }

    // Sum of day-weights for a week interval (only days within the month)
    const calcWeekWeightSum = (ws, we) => {
      const defaultW = 100 / daysInMonth;
      let sum = 0;
      const d = new Date(ws + 'T12:00:00');
      const end = new Date(we + 'T12:00:00');
      while (d <= end) {
        const ds = `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
        if (ds >= monthStart && ds <= lastDayStr)
          sum += globalWeights[ds] !== undefined ? globalWeights[ds] : defaultW;
        d.setDate(d.getDate() + 1);
      }
      return sum;
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
      if (ws >= monthStart) allWeekStarts.add(ws); // ignora semanas que começam antes do mês
    }

    for (const weekStart of allWeekStarts) {
      const wsDate = new Date(weekStart + 'T12:00:00');
      const weDate = new Date(wsDate); weDate.setDate(weDate.getDate() + 6);
      const weStr   = `${weDate.getFullYear()}-${padD(weDate.getMonth()+1)}-${padD(weDate.getDate())}`;
      const semLabel = `${padD(wsDate.getDate())}/${padD(wsDate.getMonth()+1)} – ${padD(weDate.getDate())}/${padD(weDate.getMonth()+1)}`;
      // inclui semana apenas se o último dia está dentro do mês e a semana já terminou
      if (weStr > lastDayStr || weStr >= todayStr) continue;

      const weekData = weeklyMetasMonth[weekStart] || {};
      const wws = calcWeekWeightSum(weekStart, weStr);

      for (const board of Object.keys(boardEmpsMap)) {
        const bEmps = boardEmpsMap[board];
        let storeSales = 0, storePecas = 0, storeAtend = 0, storeMeta = 0;
        for (const emp of bEmps) {
          if (!isVend(emp)) continue;
          const vs = vsalesAll[`${mk}-${board}-${emp.id}`] || {};
          const we2 = Object.entries(vs.entries||{}).filter(([d]) => d>=weekStart && d<=weStr);
          storeSales += we2.reduce((s,[,e]) => s+(e.value||0), 0);
          storePecas += we2.reduce((s,[,e]) => s+(e.pecas||0), 0);
          storeAtend += we2.reduce((s,[,e]) => s+(e.atendimentos||0), 0);
          const mMeta = weekData[emp.id]?.meta || 0;
          const mMensal = vs.meta?.mensal || 0;
          storeMeta += mMeta > 0 ? mMeta : (wws > 0 ? mMensal * wws / 100 : 0);
        }
        const storeHitMeta = storeMeta > 0 && storeSales >= storeMeta;
        const storeHitPA   = storeAtend > 0 && (storePecas/storeAtend) >= PA_THR;

        for (const emp of bEmps) {
          const tipo = (emp.cargo||'').toLowerCase();
          const isGer = (/gerente/.test(tipo) || /g\.?\s*vend/.test(tipo) || /gerente\s+vend/.test(tipo)) && !/^sub/.test(tipo);
          if (isGer) {
            let val = 0;
            if (storeHitMeta) val += PREMIO_GER_W;
            if (storeHitMeta && storeHitPA) val += PREMIO_PA_W;
            if (val > 0) {
              premiacaoSemanal[emp.id] += val;
              premiacaoSemanalDetalhe[emp.id].push({ label: semLabel, valor: val });
            }
          } else if (isVend(emp)) {
            const vs = vsalesAll[`${mk}-${board}-${emp.id}`] || {};
            const we2 = Object.entries(vs.entries||{}).filter(([d]) => d>=weekStart && d<=weStr);
            const empSales = we2.reduce((s,[,e]) => s+(e.value||0), 0);
            const empPecas = we2.reduce((s,[,e]) => s+(e.pecas||0), 0);
            const empAtend = we2.reduce((s,[,e]) => s+(e.atendimentos||0), 0);
            const mMeta   = weekData[emp.id]?.meta || 0;
            const mMensal = vs.meta?.mensal || 0;
            const empMeta = mMeta > 0 ? mMeta : (wws > 0 ? mMensal * wws / 100 : 0);
            if (empMeta > 0 && empSales >= empMeta) {
              let val = PREMIO_VEND_W;
              if (empAtend > 0 && (empPecas/empAtend) >= PA_THR) val += PREMIO_PA_W;
              premiacaoSemanal[emp.id] += val;
              premiacaoSemanalDetalhe[emp.id].push({ label: semLabel, valor: val });
            }
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
    for (const boardData of Object.values(prevFolha)) {
      for (const [empId, entry] of Object.entries(boardData.entries || {})) {
        const extras     = (entry.extras     || []).filter(x => x.nome && x.valor);
        const extrasDesc = (entry.extrasDesc || []).filter(x => x.nome && x.valor);
        if (extras.length || extrasDesc.length)
          prevExtras[empId] = { extras, extrasDesc };
      }
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
      premiacaoSemanal,
      premiacaoSemanalDetalhe,
      prevExtras,
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
    for (const [board, boardData] of Object.entries(req.body || {})) {
      if (!boardData) continue;
      if (!db.folhas[mk][board]) db.folhas[mk][board] = {};
      if (boardData.entries) {
        if (!db.folhas[mk][board].entries) db.folhas[mk][board].entries = {};
        Object.assign(db.folhas[mk][board].entries, boardData.entries);
      }
      if ('encerrada' in boardData) db.folhas[mk][board].encerrada = boardData.encerrada;
    }
    await writeDB(db);
    res.json({ ok: true });
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
    const employees = (db.employees || []).filter(e => !e.inativo);

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
      totalSheet.addRow(['FUNCIONÁRIO', 'BANCO', 'AG', 'CONTA', 'INSS', 'TOTAL LÍQUIDO', 'PROVENTOS']);
      let totalLiq = 0, totalProv = 0;

      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;
        totalSheet.addRow([
          emp.apelido || emp.name,
          emp.banco || '',
          '',
          emp.conta || '',
          bFmt(entry.inss),
          bFmt(entry.liquido),
          bFmt(entry.proventos),
        ]);
        totalLiq  += (entry.liquido  || 0);
        totalProv += (entry.proventos || 0);
      }
      totalSheet.addRow(['TOTAL', '', '', '', '', bFmt(totalLiq), bFmt(totalProv)]);

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
          if (entry.comissaoLoja) addProv('COMISSÃO LOJA', entry.comissaoLoja);
          if (entry.gmComplement) addProv('GARANTIA SURFERS', entry.gmComplement);
        }
        if (entry.feriado) addProv('FERIADO', entry.feriado);
        if (entry.feriado) addProv('FERIADO', entry.feriado);
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
    const employees = (db.employees || []).filter(e => !e.inativo);

    const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesLabel = `${MONTHS_PT[month-1]} ${year}`;

    const BOARDS_LABEL = {
      delrey:'DEL REY', minas:'MINAS', contagem:'CONTAGEM',
      estacao:'ESTAÇÃO', tommy:'TOMMY', lez:'LEZ A LEZ',
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

      // Header
      // Cols: NOME CARGO FIXO Q.CX COMISSÃO DSR PRÊMIO PREM.SEM COM.LOJA GM FERIADO EXTRAS TOTAL VERIF. OK AD V.COMPRAS VT OBS
      const headers = ['NOME','CARGO','FIXO','Q.CX','COMISSÃO','DSR','PRÊMIO','PREM.SEM.','COM.LOJA','GM','FERIADO','EXTRAS','TOTAL','VERIF.','OK','AD','V.COMPRAS','VT','OBSERVAÇÕES'];
      ws.addRow(headers);
      const hRow = ws.getRow(3);
      hRow.font = { bold: true, color: { argb: 'FFE6EDF3' } };
      hRow.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF21262D'} };
      hRow.eachCell(c => { c.border = { bottom:{style:'thin',color:{argb:'FF30363D'}} }; });

      // Column widths — text cols: 15(OK), 16(AD), 17(V.COMPRAS), 18(VT)
      ws.getColumn(1).width = 22;
      ws.getColumn(2).width = 16;
      [15,16,17,18].forEach(i => { ws.getColumn(i).width = 9; });
      const numCols = [3,4,5,6,7,8,9,10,11,12,13,14];
      numCols.forEach(i => { ws.getColumn(i).width = 12; ws.getColumn(i).numFmt = '#,##0.00'; });

      const folhaEmpCfg = db.folhaEmpConfig || {};

      let sumFixo=0, sumQcx=0, sumCom=0, sumDsr=0, sumPremio=0, sumPremSem=0,
          sumComLoja=0, sumGm=0, sumFer=0, sumExtras=0, sumTotal=0;

      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;

        const fixo      = r2(entry.fixo          || 0);
        const qcx       = r2(entry.quebra         || 0);
        const comissoes = r2(entry.comissaoContab || 0);
        const dsr       = r2(entry.dsr            || 0);
        const premio    = r2(entry.premio         || 0);
        const premSem   = r2(entry.premiacao      || 0);
        const comLoja   = r2(entry.comissaoLoja   || 0);
        const gm        = r2(entry.gmComplement   || 0);
        const feriado   = r2(entry.feriado        || 0);
        const extrasArr = (entry.extras||[]).filter(ex => r2(ex.valor) > 0);
        const extrasSum = r2(extrasArr.reduce((s,ex)=>s+r2(ex.valor),0));
        const tTotal    = r2(entry.proventos      || 0);
        const verif     = r2(fixo+qcx+comissoes+dsr+premio+premSem+comLoja+gm+feriado+extrasSum);
        const ok        = Math.abs(tTotal - verif) < 0.02 ? 'OK' : '⚠';
        const fc        = folhaEmpCfg[emp.id] || {};
        const vtRate    = fc.vtRate != null ? r2(fc.vtRate) : r2(emp.vtRate || 0);

        const adSimNao  = r2(entry.adiantamento || 0) > 0 ? 'SIM' : 'NÃO';
        const vcSimNao  = r2(entry.valeCompras  || 0) > 0 ? 'SIM' : 'NÃO';
        const vtSimNao  = vtRate > 0 ? 'SIM' : 'NÃO';

        const empRow = ws.addRow([
          emp.apelido || emp.name, emp.cargo,
          n2(fixo), n2(qcx), n2(comissoes), n2(dsr), n2(premio),
          n2(premSem)||null, n2(comLoja)||null,
          n2(gm)||null, n2(feriado)||null, n2(extrasSum)||null,
          n2(tTotal), n2(verif), ok,
          adSimNao, vcSimNao, vtSimNao, '',
        ]);
        empRow.getCell(15).font = { bold: true, color: { argb: ok==='OK'?'FF3FB950':'FFF85149' } };

        // Sub-linhas para cada provento extra com valor > 0
        for (const ex of extrasArr) {
          const subRow = ws.addRow([
            `  ↳ ${ex.nome}`, '', '', '', '', '', '', '', '', '', '', n2(ex.valor),
            '', '', '', '', '', '', '',
          ]);
          subRow.getCell(1).font  = { italic: true, color: { argb: 'FF8B949E' } };
          subRow.getCell(12).font = { color: { argb: 'FF8B949E' } };
        }

        sumFixo+=fixo; sumQcx+=qcx; sumCom+=comissoes; sumDsr+=dsr;
        sumPremio+=premio; sumPremSem+=premSem; sumComLoja+=comLoja;
        sumGm+=gm; sumFer+=feriado; sumExtras+=extrasSum; sumTotal+=tTotal;
      }

      // Totals row
      const totRow = ws.addRow([
        'TOTAL','',
        r2(sumFixo), r2(sumQcx), r2(sumCom), r2(sumDsr), r2(sumPremio),
        r2(sumPremSem)||null, r2(sumComLoja)||null,
        r2(sumGm)||null, r2(sumFer)||null, r2(sumExtras)||null,
        r2(sumTotal), r2(sumTotal), '',
        '', '', '', '',
      ]);
      totRow.font = { bold: true };
      totRow.eachCell(c => { c.border = { top:{style:'thin',color:{argb:'FF30363D'}} }; });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="contabilidade-${mk}${board?'-'+board:''}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────
initMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
    });

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

    // Restaura lastSync do banco para o botão mostrar verde imediatamente após deploy
    readDB().then(db => { if (db.microvixLastSync) setLastSync(db.microvixLastSync); }).catch(() => {});

    // Auto-sync Microvix if credentials are set
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      console.log(`[Microvix] Auto-sync a cada ${MX_INTERVAL_MS / 60000} min`);

      const doSync    = () => runSync(readDB, writeDB).catch(e => console.error('[Microvix]', e.message));
      const doHoje    = () => runSyncHoje(readDB, writeDB).catch(e => console.error('[Microvix/hoje]', e.message));
      const do30d     = () => runSync30Dias(readDB, writeDB).catch(e => console.error('[Microvix/30d]', e.message));

      // Startup: encadeia para evitar conflito de flags
      doSync().finally(() => doHoje());              // hoje logo após o sync de fechamento
      setTimeout(do30d, MX_INTERVAL_30D_MS);          // 30d: só roda depois de 1 dia completo
      console.log('[Microvix/30d] Conferência 30 dias agendada — 1× por dia');

      setInterval(doSync, MX_INTERVAL_MS);
      // doHoje defasado por metade do intervalo para nunca colidir com doSync
      setTimeout(() => setInterval(doHoje, MX_INTERVAL_MS), Math.floor(MX_INTERVAL_MS / 2));
      setInterval(do30d,  MX_INTERVAL_30D_MS);       // 30d: 1× por dia
    } else {
      console.log('[Microvix] Credenciais não configuradas — sync desativado');
    }

    // ── Cron: contas a pagar — scraping diário 07:00 Brasília ─────────────
    if (process.env.MICROVIX_PORTAL_USER && process.env.MICROVIX_PORTAL_PASS) {
      cron.schedule('0 7 * * *', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const dtIni = today.slice(0, 7) + '-01';
        console.log(`[ContasPagar] Sync diário ${dtIni} → ${today}`);
        try {
          const { scrapeContasPagar } = require('./services/microvixPortal');
          const result = await scrapeContasPagar(dtIni, today);
          if (!db.contasPagar) db.contasPagar = {};
          db.contasPagar.rows     = result.rows || [];
          db.contasPagar.dtIni    = dtIni;
          db.contasPagar.dtFin    = today;
          db.contasPagar.syncedAt = new Date().toISOString();
          db.contasPagar.logs     = result.logs || [];
          await writeDB(db);
          console.log(`[ContasPagar] Sync OK — ${result.rows.length} faturas`);
        } catch (e) {
          console.error('[ContasPagar] Sync erro:', e.message);
        }
      }, { timezone: 'America/Sao_Paulo' });
      console.log('[ContasPagar] Cron agendado para 07:00 America/Sao_Paulo');
    }
  })
  .catch(err => {
    console.error('Falha ao conectar MongoDB:', err.message);
    process.exit(1);
  });
