const express    = require('express');
const session    = require('express-session');
const { MongoStore } = require('connect-mongo');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const ExcelJS    = require('exceljs');
const { MongoClient } = require('mongodb');

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

app.use(express.json());
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
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = await readDB();
    if (!db.employees) db.employees = [];
    const emp = {
      id: nextId(db), name: name.trim(), board,
      apelido: apelido || '',
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
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db  = await readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    db.employees[idx] = {
      ...db.employees[idx], name: name.trim(), board,
      apelido: apelido || '',
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

    const emps     = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false && !e.inativo);
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
      const subtitle  = isTotal ? 'TOTAL DA LOJA' : (emps.find(e=>e.id===empId)?.name || sheetName);
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

      for (let d = 1; d <= N; d++) {
        const ds  = `${y}-${pad(m)}-${pad(d)}`;
        const dow = new Date(y, m - 1, d).getDay();
        const isWE = dow === 0 || dow === 6;
        const rowN = d + 3;
        const row  = ws.getRow(rowN);
        row.height = 16;

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

        const cRow = rowN;
        const wAcum = weightAcumByDay[d];
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
        set(4, d === 1 ? { formula:`C${cRow}` } : { formula:`D${cRow-1}+C${cRow}` }, fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(5, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})/D${cRow}*100,"")` }, fmtPct, isWE ? C.WE_BG : C.CALC_BG);
        set(6, { formula:`IF(D${cRow}>0,SUM(G4:G${cRow})-D${cRow},"")` }, fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(7, valor > 0 ? +valor.toFixed(2) : null, fmtBRL);
        set(8, wAcum > 0 ? { formula:`IF(SUM(G4:G${cRow})>0,SUM(G4:G${cRow})/${wAcum},"")` } : null,
            fmtBRL, isWE ? C.WE_BG : C.CALC_BG);
        set(9,  pecas > 0 ? pecas : null, fmtInt);
        set(10, atend > 0 ? atend : null, fmtInt);
        set(11, { formula:`IF(J${cRow}>0,I${cRow}/J${cRow},"")` }, fmtDec, isWE ? C.WE_BG : C.CALC_BG);
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

    const emps = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false && !e.inativo);
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

// ── Start ──────────────────────────────────────────────────────────────────
initMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('Falha ao conectar MongoDB:', err.message);
    process.exit(1);
  });
