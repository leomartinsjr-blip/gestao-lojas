const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage paths ──────────────────────────────────────────────────────────
const DATA_FILE    = path.join(__dirname, 'data.json');
const USERS_FILE   = path.join(__dirname, 'users.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

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
    const { name, board } = req.body;
    if (!name?.trim() || !board) return res.status(400).json({ error: 'name and board required' });
    const db = readDB();
    if (!db.employees) db.employees = [];
    const emp = { id: nextId(db), name: name.trim(), board };
    db.employees.push(emp);
    writeDB(db);
    res.json(emp);
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

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Gestão de Lojas → http://localhost:${PORT}\n`);
});
