require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const { MongoStore } = require('connect-mongo');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const ExcelJS    = require('exceljs');
const { MongoClient } = require('mongodb');
const { runSync, runSyncHoje, runSync30Dias, runSyncRetroativo, getStatus } = require('./services/microvixSync');

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
  console.log('✅  MongoDB conectado');
}

// ── DB helpers (async) ─────────────────────────────────────────────────────
async function readDB() {
  if (mongoDb) {
    const doc = await mongoDb.collection('store').findOne({ _id: 'main' });
    if (!doc) return { nextId: 1, months: {}, cards: {} };
    const { _id, ...data } = doc;
    return data;
  }
  if (!fs.existsSync(DATA_FILE)) return { nextId: 1, months: {}, cards: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { nextId: 1, months: {}, cards: {} }; }
}

async function writeDB(data) {
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
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const BOARDS   = ['escritorio','delrey','minas','contagem','estacao','tommy','lez'];
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

app.use(express.json({ limit: '10mb' }));
app.use(session(sessionOpts));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  if (req.session.user.board && req.session.user.board !== 'escritorio')
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
  req.session.user = { username: key, board: user.board, label: user.label };
  res.json({ username: key, board: user.board, label: user.label });
});

// ── POST /api/logout ───────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── GET /api/users  (admin) ────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = readUsers();
  const list = Object.entries(users).map(([username, u]) => ({
    username, label: u.label || username, board: u.board || 'escritorio'
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
  users[key] = { password, label: label || key, board: board || 'escritorio' };
  writeUsers(users);
  res.json({ ok: true, username: key });
});

// ── PUT /api/users/:username  (admin) ─────────────────────────────────────
app.put('/api/users/:username', requireAdmin, (req, res) => {
  const key = req.params.username.toLowerCase();
  const users = readUsers();
  if (!users[key]) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { password, label, board } = req.body || {};
  if (password) users[key].password = password;
  if (label !== undefined) users[key].label = label;
  if (board !== undefined) users[key].board = board;
  writeUsers(users);
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

// ── GET /api/employees ─────────────────────────────────────────────────────
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const db   = await readDB();
    const emps = db.employees || [];
    const { board } = req.session.user;
    res.json(board ? emps.filter(e => e.board === board) : emps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees ────────────────────────────────────────────────────
app.post('/api/employees', requireAuth, async (req, res) => {
  try {
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido, microvixCod } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = await readDB();
    if (!db.employees) db.employees = [];
    const emp = {
      id: nextId(db), name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod ? String(microvixCod).trim() : '',
      cpf: cpf || '', admissao: admissao || '', cargo: cargo || '',
      salario: salario || 0, comissaoSemMeta: comissaoSemMeta || 0, comissao: comissao || 0,
      comissaoMeta2: comissaoMeta2 || 0, comissaoSuper: comissaoSuper || 0,
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
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido, microvixCod } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    db.employees[idx] = {
      ...db.employees[idx], name: name.trim(), board,
      apelido: apelido || '',
      microvixCod: microvixCod !== undefined ? String(microvixCod).trim() : (db.employees[idx].microvixCod || ''),
      cpf: cpf || '', admissao: admissao || '', cargo: cargo || '',
      salario: salario || 0, comissaoSemMeta: comissaoSemMeta || 0, comissao: comissao || 0,
      comissaoMeta2: comissaoMeta2 || 0, comissaoSuper: comissaoSuper || 0,
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
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/photo ──────────────────────────────────────────
app.post('/api/employees/:id/photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const old = db.employees[idx].foto;
    if (old) try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch {}
    const url = '/uploads/' + req.file.filename;
    db.employees[idx].foto = url;
    await writeDB(db);
    res.json({ url });
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

    const emps     = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false);
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
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
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
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
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
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
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
    const isAdmin = !req.session.user.board || req.session.user.board === 'escritorio';
    const items   = (db.meetingItems || []).filter(x =>
      isAdmin || (x.board === req.session.user.board && x.visibility === 'loja')
    );
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/meeting-items ──────────────────────────────────────────────
app.post('/api/meeting-items', requireAuth, async (req, res) => {
  try {
    const { text, board, year, month, visibility } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });
    const isAdmin = !req.session.user.board || req.session.user.board === 'escritorio';
    const effectiveBoard = isAdmin ? board : req.session.user.board;
    if (!effectiveBoard || !BOARDS.includes(effectiveBoard)) return res.status(400).json({ error: 'Loja inválida' });
    const db = await readDB();
    if (!db.meetingItems) db.meetingItems = [];
    const item = {
      id: nextId(db), text: text.trim(), board: effectiveBoard,
      year: parseInt(year) || new Date().getFullYear(),
      month: parseInt(month) || (new Date().getMonth() + 1),
      visibility: isAdmin ? (visibility === 'loja' ? 'loja' : 'admin') : 'loja',
      origin: isAdmin ? 'admin' : 'loja',
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
    const isAdmin = !req.session.user.board || req.session.user.board === 'escritorio';
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

// ── GET /api/caixa/:year/:month/:board ───────────────────────────────────
app.get('/api/caixa/:year/:month/:board', requireAuth, async (req, res) => {
  try {
    const { year, month, board } = req.params;
    const user    = req.session.user;
    const isAdmin = !user.board || user.board === 'escritorio';
    if (!isAdmin && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const db  = await readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    res.json((db.caixa || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/caixa/:year/:month/:board/:day ───────────────────────────────
app.put('/api/caixa/:year/:month/:board/:day', requireAuth, async (req, res) => {
  try {
    const { year, month, board, day } = req.params;
    const user    = req.session.user;
    const isAdmin = !user.board || user.board === 'escritorio';
    if (!isAdmin && user.board !== board) return res.status(403).json({ error: 'Sem acesso' });
    const { caixa, sangria } = req.body;
    const db  = await readDB();
    if (!db.caixa) db.caixa = {};
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.caixa[key]) db.caixa[key] = {};
    const d = parseInt(day);
    db.caixa[key][d] = {
      caixa:   caixa   !== undefined ? Number(caixa)   : (db.caixa[key][d]?.caixa   ?? 0),
      sangria: sangria !== undefined ? Number(sangria) : (db.caixa[key][d]?.sangria ?? 0),
      updatedAt: new Date().toISOString(),
      updatedBy: user.label || user.username,
    };
    await writeDB(db);
    res.json(db.caixa[key][d]);
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

        const filename = `emp-mx-${emp.id}.jpg`;
        const dest     = path.join(UPLOADS_DIR, filename);

        try {
          await downloadUrl(fotoUrl, dest);
          // Remove old photo file if it was a different file
          const old = emp.foto;
          if (old && path.basename(old) !== filename) {
            try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch {}
          }
          emp.foto = `/uploads/${filename}`;
          result.updated++;
          console.log(`[Microvix/${board}] Foto salva: ${emp.name} → ${filename}`);
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

// GET /api/transferencias?dias=30&lojas=delrey,minas,contagem,estacao,tommy,lez
app.get('/api/transferencias', requireAdmin, async (req, res) => {
  try {
    const { fetchEstoque, fetchProdutos, fetchMovimento } = require('./services/microvix');

    const dias   = Math.max(1, parseInt(req.query.dias || '30'));
    const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const boards = (req.query.lojas
      ? req.query.lojas.split(',')
      : Object.keys(lojas)
    ).filter(b => lojas[b]);

    if (!boards.length) return res.status(400).json({ error: 'Nenhuma loja configurada em MICROVIX_LOJAS' });

    const todayUTC = new Date();
    const today = todayUTC.toISOString().slice(0, 10);
    const dtIni = new Date(todayUTC - dias * 86400_000).toISOString().slice(0, 10);

    // ── Catálogo de produtos (uma loja basta — catálogo é compartilhado) ──
    const firstBoard = boards[0];
    const firstCnpj  = lojas[firstBoard].replace(/\D/g, '');
    const firstChave = process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

    const catalog = {}; // cod_barra → { descricao, desc_cor, desc_tamanho, referencia }
    try {
      const prodRows = await fetchProdutos(firstCnpj, firstChave, 0);
      for (const r of prodRows) {
        const barcode = (r.cod_barra || r.codbarra || '').trim();
        if (!barcode) continue;
        catalog[barcode] = {
          descricao:    (r.descricao    || r.nome || '').trim(),
          desc_cor:     (r.desc_cor     || r.cor  || '').trim(),
          desc_tamanho: (r.desc_tamanho || r.tamanho || '').trim(),
          referencia:   (r.referencia   || r.cod_produto || '').trim(),
        };
      }
    } catch (e) {
      console.warn('[Transferencias] Catálogo falhou, continuando sem descrições:', e.message);
    }

    const estoqueByBoard = {}; // board → cod_produto → { qty, cod_barra }
    const giroByBoard    = {}; // board → cod_produto → qtdVendida
    const catalogMov     = {}; // cod_produto → { descricao, desc_cor, desc_tamanho, setor }

    for (const board of boards) {
      const cnpj  = lojas[board].replace(/\D/g, '');
      const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

      // ── Inventário: LinxProdutosInventario com data de hoje ──
      const estRows = await fetchEstoque(cnpj, chave, today);
      estoqueByBoard[board] = {};
      for (const r of estRows) {
        const cod = String(r.cod_produto || r.codproduto || '').trim();
        const qty = parseFloat((r.quantidade || '0').replace(',', '.')) || 0;
        if (!cod || qty <= 0) continue;
        if (!estoqueByBoard[board][cod]) {
          estoqueByBoard[board][cod] = { qty: 0, cod_barra: (r.cod_barra || r.codbarra || '').trim() };
        }
        estoqueByBoard[board][cod].qty += qty;
      }

      // ── Giro + catálogo de descrições via LinxMovimento ──
      const movRows = await fetchMovimento(cnpj, dtIni, today, chave);
      giroByBoard[board] = {};
      for (const r of movRows) {
        if (r.cancelado === 'S' || r.cancelado === '1') continue;
        if (r.operacao === 'DS') continue;
        const cod = String(r.cod_produto || r.codproduto || '').trim();
        if (!cod) continue;
        giroByBoard[board][cod] = (giroByBoard[board][cod] || 0) + (parseInt(r.quantidade || 0) || 1);
        // Captura descrição/cor/tamanho/setor da primeira ocorrência
        if (!catalogMov[cod]) {
          catalogMov[cod] = {
            descricao:    (r.descricao    || r.des_produto || r.nome || '').trim(),
            desc_cor:     (r.desc_cor     || r.cor         || '').trim(),
            desc_tamanho: (r.desc_tamanho || r.tamanho     || '').trim(),
            setor:        (r.setor        || r.grupo       || r.departamento || '').trim(),
          };
        }
      }
    }

    // ── Todos os cod_produto com estoque em qualquer loja ──
    const allCods = new Set();
    for (const board of boards) {
      for (const cod of Object.keys(estoqueByBoard[board])) allCods.add(cod);
    }

    const sugestoes = [];

    for (const cod of allCods) {
      const stocks = {};
      let cod_barra = '';
      let invInfo = null; // descrição do próprio inventário
      for (const board of boards) {
        const e = estoqueByBoard[board][cod];
        stocks[board] = e ? Math.floor(e.qty) : 0;
        if (e?.cod_barra && !cod_barra) cod_barra = e.cod_barra;
        if (e && !invInfo && (e.descricao || e.desc_cor || e.desc_tamanho)) invInfo = e;
      }

      const giro = {};
      for (const board of boards) giro[board] = giroByBoard[board][cod] || 0;

      // Doadoras: estoque ≥ 2 | Receptoras: estoque = 0
      const donors    = boards.filter(b => stocks[b] >= 2).sort((a, b) => stocks[b] - stocks[a]);
      const receivers = boards.filter(b => stocks[b] === 0).sort((a, b) => giro[b] - giro[a]);

      if (!donors.length || !receivers.length) continue;

      const workStocks = { ...stocks };
      const transfers  = [];

      for (const rec of receivers) {
        for (const don of donors) {
          if (workStocks[don] < 2) continue;
          transfers.push({ de: don, para: rec, qty: 1 });
          workStocks[don] -= 1;
          break;
        }
      }

      if (!transfers.length) continue;

      // Prioridade: LinxMovimento (tem descrição) → catálogo LinxProdutos
      const mov = catalogMov[cod] || {};
      const cat = catalog[cod_barra] || catalog[cod] || {};
      sugestoes.push({
        cod_produto:  cod,
        cod_barra,
        descricao:    mov.descricao    || cat.descricao    || '—',
        desc_cor:     mov.desc_cor     || cat.desc_cor     || '—',
        desc_tamanho: mov.desc_tamanho || cat.desc_tamanho || '—',
        setor:        mov.setor        || '—',
        stocks,
        giro,
        transfers,
        stocksAfter: workStocks,
      });
    }

    sugestoes.sort((a, b) => {
      const sc = (a.setor || '').localeCompare(b.setor || '', 'pt-BR');
      if (sc !== 0) return sc;
      return String(a.cod_produto).localeCompare(String(b.cod_produto), 'pt-BR', { numeric: true });
    });

    res.json({ boards, dias, total: sugestoes.length, sugestoes });
  } catch (e) {
    console.error('[Transferencias]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
initMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
    });

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
      setInterval(doHoje, MX_INTERVAL_MS);           // hoje: mesma cadência (5 min)
      setInterval(do30d,  MX_INTERVAL_30D_MS);       // 30d: 1× por dia
    } else {
      console.log('[Microvix] Credenciais não configuradas — sync desativado');
    }
  })
  .catch(err => {
    console.error('Falha ao conectar MongoDB:', err.message);
    process.exit(1);
  });
