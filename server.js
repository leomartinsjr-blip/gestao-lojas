const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage paths ──────────────────────────────────────────────────────────
// DATA_DIR permite apontar para um volume persistente (ex: Railway /data)
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const DATA_FILE    = path.join(DATA_DIR,  'data.json');
const USERS_FILE   = path.join(DATA_DIR,  'users.json');
const UPLOADS_DIR  = path.join(DATA_DIR,  'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed: copia users.json e data.json do bundle se não existirem no volume
const SEED_USERS = path.join(__dirname, 'users.json');
const SEED_DATA  = path.join(__dirname, 'data.json');
if (!fs.existsSync(USERS_FILE) && fs.existsSync(SEED_USERS))
  fs.copyFileSync(SEED_USERS, USERS_FILE);
if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_DATA))
  fs.copyFileSync(SEED_DATA, DATA_FILE);

// ── JSON DB helpers ────────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DATA_FILE)) return { nextId: 1, months: {}, cards: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { nextId: 1, months: {}, cards: {} }; }
}

function writeDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function nextId(db) {
  const id = db.nextId;
  db.nextId = (db.nextId || 1) + 1;
  return id;
}

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
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

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: 'gestao-lojas-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 horas
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado' });
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
app.get('/api/months', requireAuth, (req, res) => {
  const db = readDB();
  const list = Object.values(db.months).sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month);
  res.json(list);
});

// ── GET /api/data/:year/:month ─────────────────────────────────────────────
app.get('/api/data/:year/:month', requireAuth, (req, res) => {
  try {
    const y = parseInt(req.params.year);
    const m = parseInt(req.params.month);
    if (isNaN(y) || isNaN(m)) return res.status(400).json({ error: 'Invalid params' });
    const db = readDB();
    for (const board of BOARDS)
      for (const section of SECTIONS)
        ensureCard(db, y, m, board, section);
    writeDB(db);
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
app.put('/api/cards/:year/:month/:board/:section', requireAuth, (req, res) => {
  try {
    const { year, month, board, section } = req.params;
    const db = readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (!db.cards[ck]) return res.status(404).json({ error: 'Card not found' });
    db.cards[ck].content = req.body.content ?? '';
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/items/:year/:month/:board/:section ───────────────────────────
app.post('/api/items/:year/:month/:board/:section', requireAuth, (req, res) => {
  try {
    const { year, month, board, section } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });
    const db = readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (!db.cards[ck]) return res.status(404).json({ error: 'Card not found' });
    const item = { id: nextId(db), text: text.trim(), done: false, createdAt: new Date().toISOString() };
    db.cards[ck].items.push(item);
    writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/items/:year/:month/:board/:section/:itemId ────────────────────
app.put('/api/items/:year/:month/:board/:section/:itemId', requireAuth, (req, res) => {
  try {
    const { year, month, board, section, itemId } = req.params;
    const db = readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    const item = db.cards[ck]?.items.find(i => i.id === parseInt(itemId));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.body.text !== undefined) item.text = req.body.text;
    if (req.body.done !== undefined) item.done = Boolean(req.body.done);
    writeDB(db);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/items/:year/:month/:board/:section/:itemId ─────────────────
app.delete('/api/items/:year/:month/:board/:section/:itemId', requireAuth, (req, res) => {
  try {
    const { year, month, board, section, itemId } = req.params;
    const db = readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (db.cards[ck]) db.cards[ck].items = db.cards[ck].items.filter(i => i.id !== parseInt(itemId));
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/attachments/:year/:month/:board/:section ─────────────────────
app.post('/api/attachments/:year/:month/:board/:section', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { year, month, board, section } = req.params;
    const db = readDB();
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
    writeDB(db);
    res.json(att);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/attachments/:year/:month/:board/:section/:attId ────────────
app.delete('/api/attachments/:year/:month/:board/:section/:attId', requireAuth, (req, res) => {
  try {
    const { year, month, board, section, attId } = req.params;
    const db = readDB();
    const ck = cardKey(parseInt(year), parseInt(month), board, section);
    if (db.cards[ck]) {
      const att = db.cards[ck].attachments.find(a => a.id === parseInt(attId));
      if (att) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
        db.cards[ck].attachments = db.cards[ck].attachments.filter(a => a.id !== parseInt(attId));
      }
    }
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees ─────────────────────────────────────────────────────
app.get('/api/employees', requireAuth, (req, res) => {
  const db   = readDB();
  const emps = db.employees || [];
  const { board } = req.session.user;
  res.json(board ? emps.filter(e => e.board === board) : emps);
});

// ── POST /api/employees ────────────────────────────────────────────────────
app.post('/api/employees', requireAuth, (req, res) => {
  try {
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = readDB();
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
    writeDB(db);
    res.json(emp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/employees/:id ─────────────────────────────────────────────────
app.put('/api/employees/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, board, cpf, admissao, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, isVendedor, inativo, desligamento, apelido } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = readDB();
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
    writeDB(db);
    res.json(db.employees[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/:id ──────────────────────────────────────────────
app.delete('/api/employees/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = readDB();
    db.employees = (db.employees || []).filter(e => e.id !== id);
    db.folgas    = (db.folgas    || []).filter(f => f.employeeId !== id);
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/photo ─────────────────────────────────────────
app.post('/api/employees/:id/photo', requireAuth, upload.single('photo'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const db  = readDB();
    const idx = (db.employees || []).findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const old = db.employees[idx].foto;
    if (old) try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch {}
    const url = '/uploads/' + req.file.filename;
    db.employees[idx].foto = url;
    writeDB(db);
    res.json({ url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/folgas/:year/:month ───────────────────────────────────────────
app.get('/api/folgas/:year/:month', requireAuth, (req, res) => {
  try {
    const prefix = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db = readDB();
    res.json((db.folgas || []).filter(f => f.date.startsWith(prefix)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/folgas ───────────────────────────────────────────────────────
app.post('/api/folgas', requireAuth, (req, res) => {
  try {
    const { employeeId, date } = req.body;
    if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date required' });
    const db = readDB();
    if (!db.folgas) db.folgas = [];
    const exists = db.folgas.find(f => f.employeeId === employeeId && f.date === date);
    if (exists) return res.json(exists);
    const folga = { id: nextId(db), employeeId, date };
    db.folgas.push(folga);
    writeDB(db);
    res.json(folga);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/folgas/:id ─────────────────────────────────────────────────
app.delete('/api/folgas/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = readDB();
    db.folgas = (db.folgas || []).filter(f => f.id !== id);
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/dailysales/:year/:month/:board ────────────────────────────────
app.get('/api/dailysales/:year/:month/:board', requireAuth, (req, res) => {
  try {
    const { year, month, board } = req.params;
    const db  = readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    let data  = db.dailySales?.[key] || { meta: { mensal: 0, weights: {} }, entries: {} };
    // normalise legacy format where meta was a plain number
    if (typeof data.meta !== 'object') data = { meta: { mensal: data.meta || 0, weights: {} }, entries: data.entries || {} };
    if (!data.meta.weights) data.meta.weights = {};
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/dailysales/:year/:month/:board/meta ──────────────────────────
app.post('/api/dailysales/:year/:month/:board/meta', requireAuth, (req, res) => {
  try {
    const { year, month, board } = req.params;
    const db  = readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.dailySales) db.dailySales = {};
    if (!db.dailySales[key]) db.dailySales[key] = { meta: { mensal: 0, weights: {} }, entries: {} };
    const rec = db.dailySales[key];
    if (typeof rec.meta !== 'object') rec.meta = { mensal: rec.meta || 0, weights: {} };
    if (!rec.meta.weights) rec.meta.weights = {};
    if (req.body.mensal  !== undefined) rec.meta.mensal  = parseFloat(req.body.mensal) || 0;
    if (req.body.weights !== undefined) rec.meta.weights = req.body.weights;
    writeDB(db);
    res.json({ ok: true, meta: rec.meta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/dailysales/:year/:month/:board/:date ──────────────────────────
app.put('/api/dailysales/:year/:month/:board/:date', requireAuth, (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const db  = readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (!db.dailySales) db.dailySales = {};
    if (!db.dailySales[key]) db.dailySales[key] = { meta: 0, entries: {} };
    db.dailySales[key].entries[date] = {
      value: parseFloat(req.body.value) || 0,
      pecas: parseInt(req.body.pecas)   || 0,
      fluxo: parseInt(req.body.fluxo)   || 0,
    };
    writeDB(db);
    res.json(db.dailySales[key].entries[date]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/dailysales/:year/:month/:board/:date ───────────────────────
app.delete('/api/dailysales/:year/:month/:board/:date', requireAuth, (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const db  = readDB();
    const key = `${year}-${String(month).padStart(2,'0')}-${board}`;
    if (db.dailySales?.[key]?.entries?.[date])
      delete db.dailySales[key].entries[date];
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/weights/:year/:month ──────────────────────────────────────────
app.get('/api/weights/:year/:month', requireAuth, (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = readDB();
    res.json((db.globalWeights || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/weights/:year/:month ─────────────────────────────────────────
app.post('/api/weights/:year/:month', requireAuth, (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = readDB();
    if (!db.globalWeights) db.globalWeights = {};
    db.globalWeights[key] = req.body.weights || {};
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/vsales/:year/:month/:board/:empId ─────────────────────────────
app.get('/api/vsales/:year/:month/:board/:empId', requireAuth, (req, res) => {
  try {
    const { year, month, board, empId } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = readDB();
    res.json((db.vsales || {})[key] || { meta: { mensal: 0 }, entries: {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vsales/:year/:month/:board/:empId/meta ───────────────────────
app.post('/api/vsales/:year/:month/:board/:empId/meta', requireAuth, (req, res) => {
  try {
    const { year, month, board, empId } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = readDB();
    if (!db.vsales) db.vsales = {};
    if (!db.vsales[key]) db.vsales[key] = { meta: { mensal: 0 }, entries: {} };
    db.vsales[key].meta.mensal = parseFloat(req.body.mensal) || 0;
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/vsales/:year/:month/:board/:empId/:date ───────────────────────
app.put('/api/vsales/:year/:month/:board/:empId/:date', requireAuth, (req, res) => {
  try {
    const { year, month, board, empId, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = readDB();
    if (!db.vsales) db.vsales = {};
    if (!db.vsales[key]) db.vsales[key] = { meta: { mensal: 0 }, entries: {} };
    db.vsales[key].entries[date] = {
      value:        parseFloat(req.body.value)      || 0,
      pecas:        parseInt(req.body.pecas)        || 0,
      atendimentos: parseInt(req.body.atendimentos) || 0,
    };
    writeDB(db);
    res.json(db.vsales[key].entries[date]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/vsales/:year/:month/:board/:empId/:date ────────────────────
app.delete('/api/vsales/:year/:month/:board/:empId/:date', requireAuth, (req, res) => {
  try {
    const { year, month, board, empId, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}-${empId}`;
    const db  = readDB();
    if (db.vsales?.[key]?.entries?.[date]) delete db.vsales[key].entries[date];
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/storefluxo/:year/:month/:board ────────────────────────────────
app.get('/api/storefluxo/:year/:month/:board', requireAuth, (req, res) => {
  try {
    const { year, month, board } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}`;
    const db  = readDB();
    res.json((db.storeFluxo || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/storefluxo/:year/:month/:board/:date ──────────────────────────
app.put('/api/storefluxo/:year/:month/:board/:date', requireAuth, (req, res) => {
  try {
    const { year, month, board, date } = req.params;
    const key = `${monthKey(parseInt(year), parseInt(month))}-${board}`;
    const db  = readDB();
    if (!db.storeFluxo) db.storeFluxo = {};
    if (!db.storeFluxo[key]) db.storeFluxo[key] = {};
    const val = parseInt(req.body.value) || 0;
    if (val === 0) delete db.storeFluxo[key][date];
    else db.storeFluxo[key][date] = val;
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/weekly-metas/:year/:month ────────────────────────────────────
app.get('/api/weekly-metas/:year/:month', requireAuth, (req, res) => {
  try {
    const key = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const db  = readDB();
    res.json((db.weeklyMetas || {})[key] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/weekly-metas/:year/:month/:weekStart/:empId ──────────────────
app.put('/api/weekly-metas/:year/:month/:weekStart/:empId', requireAuth, (req, res) => {
  try {
    const key      = monthKey(parseInt(req.params.year), parseInt(req.params.month));
    const { weekStart, empId } = req.params;
    const { meta } = req.body;
    const db = readDB();
    if (!db.weeklyMetas)          db.weeklyMetas = {};
    if (!db.weeklyMetas[key])     db.weeklyMetas[key] = {};
    if (!db.weeklyMetas[key][weekStart]) db.weeklyMetas[key][weekStart] = {};
    db.weeklyMetas[key][weekStart][empId] = { meta: parseFloat(meta) || 0 };
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/campaigns ────────────────────────────────────────────────────
app.get('/api/campaigns', requireAuth, (req, res) => {
  const db   = readDB();
  const all  = db.campaigns || [];
  const { board } = req.session.user;
  res.json(board ? all.filter(c => c.stores.includes(board)) : all);
});

// ── POST /api/campaigns ───────────────────────────────────────────────────
app.post('/api/campaigns', requireAuth, (req, res) => {
  try {
    const { board } = req.session.user;
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
    const { name, kpi, startDate, endDate, stores } = req.body;
    if (!name?.trim() || !kpi || !startDate || !endDate || !Array.isArray(stores) || !stores.length)
      return res.status(400).json({ error: 'Campos obrigatórios: name, kpi, startDate, endDate, stores' });
    const db = readDB();
    if (!db.campaigns) db.campaigns = [];
    const campaign = {
      id: nextId(db),
      name: name.trim(), kpi, startDate, endDate, stores,
      createdAt: new Date().toISOString(),
    };
    db.campaigns.push(campaign);
    writeDB(db);
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/campaigns/:id ────────────────────────────────────────────────
app.put('/api/campaigns/:id', requireAuth, (req, res) => {
  try {
    const { board } = req.session.user;
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
    const id = parseInt(req.params.id);
    const { name, kpi, startDate, endDate, stores } = req.body;
    if (!name?.trim() || !kpi || !startDate || !endDate || !Array.isArray(stores) || !stores.length)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    const db = readDB();
    const idx = (db.campaigns || []).findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Campanha não encontrada' });
    db.campaigns[idx] = { ...db.campaigns[idx], name: name.trim(), kpi, startDate, endDate, stores };
    writeDB(db);
    res.json(db.campaigns[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/campaigns/:id ─────────────────────────────────────────────
app.delete('/api/campaigns/:id', requireAuth, (req, res) => {
  try {
    const { board } = req.session.user;
    if (board && board !== 'escritorio') return res.status(403).json({ error: 'Sem permissão' });
    const id = parseInt(req.params.id);
    const db = readDB();
    db.campaigns = (db.campaigns || []).filter(c => c.id !== id);
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/historico ─────────────────────────────────────────────────────
app.get('/api/historico', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.historico || {});
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
});
