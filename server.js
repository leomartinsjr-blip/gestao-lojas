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
    const { name, board, cpf, nascimento, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, inativo, desligamento, apelido, microvixCod, supervisedBoards } = req.body;
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
    const { name, board, cpf, nascimento, admissao, contrato1, contrato2, cargo, salario, comissaoSemMeta, comissao, comissaoMeta2, comissaoSuper, comissaoVR, aberturaLoja, comissaoGerente, inssRate, vtRate, salarioFixo, quebraCaixa, banco, conta, isVendedor, inativo, desligamento, apelido, microvixCod, foto, supervisedBoards } = req.body;
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
      inativo: inativo === true || inativo === 'true',
      desligamento: desligamento || '',
      supervisedBoards: Array.isArray(supervisedBoards) ? supervisedBoards : (db.employees[idx].supervisedBoards || []),
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
    res.json((db.dadosFolha || {})[key] || { feriados: [], extensoes: [], faltas: [], vr: '', abertura: '', instagram: '' });
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
    const item = {
      id:          nextId(db),
      board,
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
      const serie = String(r.serie || r.serie_documento || r.num_serie || '').trim();
      if (serie === '999') continue;
      if (serie === '4' && operacao !== 'DS') continue;
      const doc = String(r.documento || '').trim();
      if (!doc || seenDocs.has(doc)) continue;
      seenDocs.add(doc);

      const sign  = operacao === 'DS' ? -1 : 1;
      const valor = parseBrNum(r.valor_total || r.total_liquido || '0');
      const hora  = String(r.hora || r.hora_documento || r.hora_emissao || '').trim().slice(0, 5) || '';
      const cod   = String(r.cod_vendedor || '').trim();
      const nome  = (r.nome_vendedor || '').trim();
      const codP  = String(r.cod_plano || r.plano || '').trim();
      const ident = String(r.identificador || '').trim();

      totalVendas += sign * valor;
      docMap[doc] = { doc, valor: sign * valor, vendedorCod: cod, vendedorNome: nome, hora, codPlano: codP };
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
        const bandeira = (r.descricao_bandeira || r.bandeira || '').trim();
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

    res.json({ board, date, totalVendas, vendedores, formasPagamento, totalSangria });
  } catch (e) {
    console.error('[conferencia-caixa]', e.message);
    res.status(500).json({ error: e.message });
  }
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
  res.json({ cached: !!_catalogCache, size, ageMin, withMarca, withSetor,
             pctMarca: size ? ((withMarca/size)*100).toFixed(1)+'%' : '0%',
             rawFields: _catalogRawFields, rawSample: _catalogRawSample,
             keysSample, sampleWith, sampleWithout });
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

// ── GET /api/catalog-warm — força construção do catálogo e reporta resultado ─
app.get('/api/catalog-warm', requireAdmin, async (req, res) => {
  _catalogCache = null; _catalogCacheAt = 0;
  const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const { fetchProdutos, fetchServicos, parseBrNum } = require('./services/microvix');
  const firstBoard = Object.keys(lojas)[0];
  if (!firstBoard) return res.status(400).json({ error: 'Nenhuma loja configurada' });
  const cnpj  = lojas[firstBoard].replace(/\D/g, '');
  const chave = process.env[`MICROVIX_CHAVE_${firstBoard.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  try {
    const t0 = Date.now();
    const [prodRows, svcRows] = await Promise.all([
      fetchProdutos(cnpj, chave, 0).catch(e => ({ error: e.message })),
      fetchServicos(cnpj, chave, 0).catch(e => ({ error: e.message })),
    ]);
    const prodError = Array.isArray(prodRows) ? null : prodRows.error;
    const svcError  = Array.isArray(svcRows)  ? null : svcRows.error;
    const prodCount = Array.isArray(prodRows) ? prodRows.length : 0;
    const svcCount  = Array.isArray(svcRows)  ? svcRows.length  : 0;
    const sampleProd = Array.isArray(prodRows) && prodRows[0] ? Object.keys(prodRows[0]) : [];
    const ms = Date.now() - t0;
    res.json({ ms, prodCount, svcCount, prodError, svcError, prodFields: sampleProd, sampleProd: (Array.isArray(prodRows) ? prodRows.slice(0,2) : []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        const op = (row.operacao || '').toUpperCase();
        if (op !== 'S' && op !== 'DS') continue;
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
let _catalogRawFields = [];      // campos brutos do LinxProdutos (para diagnóstico)
let _catalogRawSample = null;    // amostra bruta (1 produto)
const CATALOG_TTL = 6 * 60 * 60 * 1000;

// ── Índice compacto ref→cores (para /api/cadastro-produto/check) ────────────
// Persiste no MongoDB → sobrevive a restarts; muito menor que o catálogo completo
let _refColorIndex    = null;   // { "REF123": ["AZUL","PRETO"], ... }
let _refColorIdxAt    = 0;
let _refColorIdxPromise = null;
const REFCOLOR_TTL = 6 * 60 * 60 * 1000;

async function _getRefColorIndex() {
  if (_refColorIndex && Date.now() - _refColorIdxAt < REFCOLOR_TTL) return _refColorIndex;

  if (!_refColorIdxPromise)
    _refColorIdxPromise = _buildRefColorIndex().finally(() => { _refColorIdxPromise = null; });

  // Cache em memória existe mas expirou → devolve imediatamente (rebuild roda em background)
  if (_refColorIndex) return _refColorIndex;

  // Cold start: tenta carregar do MongoDB antes de aguardar o build
  if (mongoDb) {
    try {
      const doc = await mongoDb.collection('catalog').findOne({ _id: 'refColor' });
      if (doc?.data && Object.keys(doc.data).length > 0) {
        _refColorIndex = doc.data;
        _refColorIdxAt = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
        console.log(`[RefColor] Carregado do MongoDB: ${Object.keys(_refColorIndex).length} refs`);
        return _refColorIndex;
      }
    } catch(e) { console.warn('[RefColor] MongoDB load:', e.message); }
  }

  return _refColorIdxPromise;
}

async function _buildRefColorIndex() {
  const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
  const lojas  = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const boards = Object.keys(lojas).filter(b => b !== 'site');
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

  // Salva cada chunk em paralelo
  const ops = [];
  for (let i = 0; i < numChunks; i++) {
    const chunk = Object.fromEntries(entries.slice(i * CATALOG_CHUNK_SIZE, (i + 1) * CATALOG_CHUNK_SIZE));
    ops.push(col.replaceOne(
      { _id: `fullCatalog_${i}` },
      { _id: `fullCatalog_${i}`, data: chunk, updatedAt },
      { upsert: true }
    ));
  }
  // Remove chunks antigos que não existem mais (se o catálogo encolheu)
  ops.push(col.deleteMany({ _id: { $regex: /^fullCatalog_/, $gt: `fullCatalog_${numChunks - 1}` } }));
  // Salva metadado com número de chunks
  ops.push(col.replaceOne(
    { _id: 'fullCatalog_meta' },
    { _id: 'fullCatalog_meta', numChunks, total, updatedAt },
    { upsert: true }
  ));
  await Promise.all(ops);
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

  // Inicia rebuild em background se ainda não está rodando
  if (!_catalogWarmPromise) {
    _catalogWarmPromise = _buildCatalog(lojas).finally(() => { _catalogWarmPromise = null; });
  }

  // Cache expirado mas existe: devolve imediatamente sem bloquear (rebuild acontece em background)
  if (_catalogCache) return _catalogCache;

  // Cold start: tenta carregar do MongoDB antes de aguardar o build completo
  if (mongoDb) {
    try {
      const loaded = await _loadCatalogMongo();
      if (loaded && Object.keys(loaded.map).length > 0) {
        _catalogCache   = loaded.map;
        _catalogCacheAt = loaded.updatedAt ? new Date(loaded.updatedAt).getTime() : 0;
        return _catalogCache;
      }
    } catch (e) { console.warn('[Catalog] MongoDB load:', e.message); }
  }

  // Sem MongoDB e sem cache: aguarda o build
  return _catalogWarmPromise;
}

async function _buildCatalog(lojas) {
  const { fetchServicos, buildRequest, postRequest, parseCsv, parseBrNum } = require('./services/microvix');
  // Catálogo é único para todas as lojas Surfers — busca apenas de uma loja representativa
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
        try { raw = await postRequest(body, 60_000); } catch (e) { console.warn(`[Catalog/${board}] pág`, page, e.message); break; }
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
            setor:       (r.desc_setor  || '').trim(),
            marca:       (r.desc_marca  || '').trim(),
            desc_cor:    (r.desc_cor    || '').trim(),
            preco_venda: parseBrNum(r.preco_venda || r.preco || r.preco_cheio || '0'),
          };
          const mergeEntry = (key) => {
            if (!map[key]) { map[key] = entry; return; }
            if (!map[key].marca       && entry.marca)       map[key].marca       = entry.marca;
            if (!map[key].setor       && entry.setor)       map[key].setor       = entry.setor;
            if (!map[key].nomeBase    && entry.nomeBase)    map[key].nomeBase    = entry.nomeBase;
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

    // Catálogo compartilhado — busca apenas da loja principal
    const totalProd = await fetchBoard(mainBoard).catch(e => { console.warn(`[Catalog/${mainBoard}] erro:`, e.message); return 0; });

    console.log(`[Catalog] ${totalProd} produtos → ${Object.keys(map).length} entradas (via ${mainBoard})`);
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
    _getCatalog(lojas),
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

app.post('/api/cadastro-produto/check', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows deve ser array' });

    // Índice compacto ref→cores — carrega do MongoDB se disponível (instantâneo),
    // ou aguarda até 15s pelo build inicial
    const idx = await Promise.race([
      _getRefColorIndex(),
      new Promise(r => setTimeout(() => r(null), 15_000)),
    ]).catch(() => null);

    if (!idx || !Object.keys(idx).length) {
      return res.json({
        result: rows.map(r => ({ ...r, _status: 'new' })),
        newCount: rows.length, existingCount: 0, needsMappingCount: 0,
        _catalogNotReady: true,
      });
    }

    const norm = s => (s || '').toString().replace(/\.0+$/, '').trim().toUpperCase();

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
        const corsDisponiveis = idx[ref];
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

// Força rebuild do índice ref→cores
app.post('/api/catalog/rebuild-refcolor', requireAdmin, async (req, res) => {
  _refColorIndex = null; _refColorIdxAt = 0; _refColorIdxPromise = null;
  _buildRefColorIndex().catch(e => console.warn('[RefColor rebuild]', e.message));
  res.json({ ok: true, message: 'Rebuild iniciado em background' });
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
        contabiliza:   'Sim',
        indisponivel:  'Não',
        setor:         r.desc_setor  || '',
        linha:         r.linha       || '',
        marca:         r.desc_marca  || '',
        colecao:       r.colecao     || '',
        espessura:     '',
        classificacao: '',
        tamanho:       r.desc_tamanho || '',
        cores:         r.desc_cor    || '',
        unidade:       'UN',
        multiplo:      '1',
        moeda:         '',
        custo_icms:    r.preco_custo || '',
        desconto:      '',
        acrescimo:     '',
        ipi:           '',
        frete:         '',
        desp_acess:    '',
        subst_trib:    '',
        dif_icms:      '',
        markup:        r.markup      || '',
        preco_venda:   r.preco_venda || '',
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
        exige_ctrl:    'Sim',
        tipo_ctrl:     'Por Cor e Tamanho',
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
        cod_barra:     r.cod_barra   || '',
        caracterist:   '',
        status:        'Ativo',
        b2c_desc:      '',
        b2c_garantia:  '',
        b2c_tags:      '',
        b2c_flags:     '',
        b2c_kw:        '',
        b2c_canais:    '',
        b2c_video:     '',
        oms:           '',
        desativado:    '',
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
    const monthEnd = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;
    const employees = (db.employees || []).filter(e => {
      if (e.inativo && !savedEmpIds.has(e.id)) return false;
      if (e.admissao && e.admissao > monthEnd && !savedEmpIds.has(e.id)) return false;
      return true;
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
    const weeklyMetasMonth = (db.weeklyMetas || {})[mk] || {};
    const globalWeights    = (db.globalWeights || {})[mk] || {};
    const daysInMonth      = new Date(year, month, 0).getDate();
    const todayStr   = new Date().toISOString().slice(0, 10);
    const lastDay    = new Date(year, month, 0);
    const padD       = n => String(n).padStart(2,'0');
    const lastDayStr = `${year}-${padD(month)}-${padD(lastDay.getDate())}`;
    const monthStart = `${year}-${padD(month)}-01`;

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
          const tipo  = (emp.cargo||'').toLowerCase();
          const isGer    = /gerente/.test(tipo) && !/^sub/.test(tipo) && !/g\.?\s*vend/.test(tipo) && !/gerente\s+vend/.test(tipo);
          const isGVend  = (/g\.?\s*vend/.test(tipo) || /gerente\s+vend/.test(tipo)) && !/^sub/.test(tipo);
          const isSubGer = /^sub/.test(tipo) && /gerente/.test(tipo);
          const empCfg   = folhaEmpCfgMap[emp.id] || {};
          const useStorePremio = isGer || isGVend || isSubGer || empCfg.recebePremiaoLoja;
          const storePremioVal = empCfg.premioLojaValor > 0 ? empCfg.premioLojaValor : PREMIO_GER_W;

          // Verifica se o funcionário trabalhou todos os dias da semana
          // Regra: % diário zerado (férias, admissão no meio, desligamento) = não trabalhou = sem prêmio
          const vsEmp = vsalesAll[`${mk}-${board}-${emp.id}`] || {};
          const vacSet = new Set(vsEmp.meta?.vacationDays || []);

          // Se admissão não estiver cadastrada, usa primeira entrada de vsales do mês como fallback
          // (detecta funcionários que começaram no meio do mês sem data de admissão preenchida)
          let effectiveAdmissao = emp.admissao || null;
          if (!effectiveAdmissao) {
            const allEntryDates = Object.keys(vsEmp.entries || {})
              .filter(d => d >= monthStart && d <= lastDayStr)
              .sort();
            if (allEntryDates.length > 0) effectiveAdmissao = allEntryDates[0];
          }

          const ausenciaDias = ausenciaDiasMap[emp.id] || new Set();
          const trabalhouSemanaInteira = (() => {
            const d = new Date(weekStart + 'T12:00:00');
            const end = new Date(weStr + 'T12:00:00');
            while (d <= end) {
              const ds = `${d.getFullYear()}-${padD(d.getMonth()+1)}-${padD(d.getDate())}`;
              if (ds >= monthStart && ds <= lastDayStr) {
                if (vacSet.has(ds))        return false; // férias via toggle Part%
                if (ausenciaDias.has(ds))  return false; // férias/atestado via calendário
                if (effectiveAdmissao && ds < effectiveAdmissao) return false;
                if (emp.desligamento  && ds > emp.desligamento)  return false;
              }
              d.setDate(d.getDate() + 1);
            }
            return true;
          })();

          // Prêmio de loja para gerente, sub-gerente e funcionários com flag no config
          if (useStorePremio && trabalhouSemanaInteira) {
            let val = 0;
            if (storeHitMeta) val += storePremioVal;
            if (storeHitMeta && storeHitPA) val += PREMIO_PA_W;
            if (val > 0) {
              premiacaoSemanalGer[emp.id] += val;
              premiacaoSemanalGerDetalhe[emp.id].push({ label: semLabel, valor: val });
            }
          }

          // Prêmio individual para vendedor, gerente vendedor e sub-gerente
          if (isGVend || isSubGer || (!isGer && isVend(emp))) {
            if (!trabalhouSemanaInteira) continue;
            const we2 = Object.entries(vsEmp.entries||{}).filter(([d]) => d>=weekStart && d<=weStr);
            const empSales = we2.reduce((s,[,e]) => s+(e.value||0), 0);
            const empPecas = we2.reduce((s,[,e]) => s+(e.pecas||0), 0);
            const empAtend = we2.reduce((s,[,e]) => s+(e.atendimentos||0), 0);
            const mMeta   = weekData[emp.id]?.meta || 0;
            const mMensal = vsEmp.meta?.mensal || 0;
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

      // Header — estrutura idêntica à planilha de referência
      // A    B      C     D     E    F          G    H       I   J        K      L       M            N   O   P     Q      R        S       T     U
      // NOME CARGO  FIXO  Q.CX  S.F  COMISSÕES  DSR  PRÊMIO  GM  FERIADO  PREM.  T+PREM  VERIFICAÇÃO  OK  AD  VALE  DESC.  MAX.VT  FALTAS  P.S  OBS
      const headers = ['NOME','CARGO','FIXO','Q.CX','S.F','COMISSÕES','DSR','PRÊMIO','GM','FERIADO','PREM.','T+PREM','VERIFICAÇÃO','OK','AD','VALE','DESC.','MAX. VT','FALTAS','P.S','OBSERVAÇÕES'];
      ws.addRow(headers);
      const hRow = ws.getRow(3);
      hRow.font = { bold: true, color: { argb: 'FFE6EDF3' } };
      hRow.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF21262D'} };
      hRow.eachCell(c => { c.border = { bottom:{style:'thin',color:{argb:'FF30363D'}} }; });

      // Widths: text cols = 5(S.F) 14(OK) 19(FALTAS) 20(P.S) 21(OBS)
      ws.getColumn(1).width = 22;
      ws.getColumn(2).width = 14;
      ws.getColumn(5).width = 5;
      ws.getColumn(14).width = 5;
      ws.getColumn(21).width = 22;
      const numCols = [3,4,6,7,8,9,10,11,12,13,15,16,17,18];
      numCols.forEach(i => { ws.getColumn(i).width = 12; ws.getColumn(i).numFmt = '#,##0.00'; });

      const folhaEmpCfg = db.folhaEmpConfig || {};

      let sumFixo=0, sumQcx=0, sumCom=0, sumDsr=0, sumPremio=0,
          sumGm=0, sumFer=0, sumPrem=0, sumTotal=0,
          sumAd=0, sumVc=0, sumDesc=0, sumVt=0;

      for (const emp of lojaEmps) {
        const entry = lojaData.entries[emp.id];
        if (!entry) continue;

        const fixo      = r2(entry.fixo          || 0);
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
        const vtDesc    = r2(entry.vt           || 0);
        const desc      = r2((entry.totalDescontos || 0) - vtDesc);

        const empRow = ws.addRow([
          emp.apelido || emp.name, emp.cargo,
          n2(fixo), n2(qcx), sf||null,
          n2(comissoes), n2(dsr), n2(premio),
          n2(gm)||null, n2(feriado)||null, n2(prem)||null,
          n2(tTotal), n2(verif), ok,
          n2(ad)||null, n2(vale)||null, n2(desc)||null, n2(vtVal)||null,
          null, null, '',
        ]);
        empRow.getCell(14).font = { bold: true, color: { argb: ok==='OK'?'FF3FB950':'FFF85149' } };
        if (sf) empRow.getCell(5).font = { bold: true, color: { argb: 'FFD29922' } };

        sumFixo+=fixo; sumQcx+=qcx; sumCom+=comissoes; sumDsr+=dsr;
        sumPremio+=premio; sumGm+=gm; sumFer+=feriado; sumPrem+=prem;
        sumTotal+=tTotal; sumAd+=ad; sumVc+=vale; sumDesc+=desc; sumVt+=vtVal;
      }

      // Totals row
      const totRow = ws.addRow([
        'TOTAL','',
        r2(sumFixo), r2(sumQcx), '',
        r2(sumCom), r2(sumDsr), r2(sumPremio),
        r2(sumGm)||null, r2(sumFer)||null, r2(sumPrem)||null,
        r2(sumTotal), r2(sumTotal), '',
        r2(sumAd)||null, r2(sumVc)||null, r2(sumDesc)||null, r2(sumVt)||null,
        null, null, '',
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

// GET /api/conferencia/dashboard?dtIni=2026-06-01&dtFin=2026-06-08
// Consolida todas as lojas: ranking de desconto por loja, por vendedor e CMV
app.get('/api/conferencia/dashboard', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { dtIni, dtFin } = req.query;
    if (!dtIni || !dtFin) return res.status(400).json({ error: 'dtIni e dtFin obrigatórios' });

    const lojas   = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const BOARDS  = ['delrey','minas','contagem','estacao','tommy','surfers'];
    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    const { fetchMovimento } = require('./services/microvix');

    // Busca todas as lojas em paralelo
    const resultados = await Promise.all(BOARDS.map(async board => {
      const cnpj = lojas[board];
      if (!cnpj) return { board, erro: 'não configurada' };
      const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
      const cnpjClean = cnpj.replace(/\D/g,'');
      try {
        const rows = await fetchMovimento(cnpj, dtIni, dtFin, chave);
        return { board, cnpjClean, rows: Array.isArray(rows) ? rows : [] };
      } catch (e) {
        return { board, erro: e.message, rows: [] };
      }
    }));

    const porLoja     = {};
    const porVendedor = {};

    for (const { board, cnpjClean, rows, erro } of resultados) {
      if (erro) { porLoja[board] = { board, erro }; continue; }

      const loja = { board, vlrLiquido:0, vlrBruto:0, vlrDesconto:0, vlrCusto:0, qtdItens:0 };

      for (const r of rows) {
        const rowCnpj = (r.cnpj_emp||r.cnpj||'').replace(/\D/g,'');
        if (!rowCnpj || rowCnpj !== cnpjClean) continue;
        if (r.cancelado === 'S' || r.cancelado === '1') continue;
        if ((r.soma_relatorio||'S').toUpperCase() === 'N') continue;
        const op    = (r.operacao||'').trim().toUpperCase();
        if (op !== 'S') continue;
        const serie = String(r.serie||r.serie_documento||'').trim();
        if (serie === '999' || serie === '4') continue;

        const qty      = parseBR(r.quantidade||'1');
        const vlrUnit  = parseBR(r.preco_tabela_epoca||r.preco_unitario||'0');
        const vlrLiq   = parseBR(r.preco_unitario||r.valor_liquido||'0');
        const vlrDesc  = parseBR(r.desconto_item||r.desconto_total_item||'0');
        const vlrCusto = parseBR(r.custo_medio_epoca||r.preco_custo||'0');

        loja.vlrLiquido  += vlrLiq  * qty;
        loja.vlrBruto    += vlrUnit * qty;
        loja.vlrDesconto += vlrDesc * qty;
        loja.vlrCusto    += vlrCusto * qty;
        loja.qtdItens    += 1;

        // Vendedor
        const cod  = String(r.cod_vendedor||'').trim();
        if (cod) {
          const obsNome = (r.obs||'').match(/Nome do Vendedor:\s*(.+?)(?:\s*\|.*)?$/i);
          const nome    = (r.nome_vendedor || (obsNome && obsNome[1]) || cod).trim();
          const vkey    = `${board}::${cod}`;
          if (!porVendedor[vkey]) porVendedor[vkey] = { board, cod, nome, vlrLiquido:0, vlrBruto:0, vlrDesconto:0, qtdItens:0 };
          porVendedor[vkey].vlrLiquido  += vlrLiq  * qty;
          porVendedor[vkey].vlrBruto    += vlrUnit * qty;
          porVendedor[vkey].vlrDesconto += vlrDesc * qty;
          porVendedor[vkey].qtdItens    += 1;
        }
      }

      loja.percDesconto = loja.vlrBruto > 0 ? (loja.vlrDesconto / loja.vlrBruto) * 100 : 0;
      loja.cmvPerc      = loja.vlrLiquido > 0 ? (loja.vlrCusto / loja.vlrLiquido) * 100 : 0;
      porLoja[board] = loja;
    }

    // Calcula % desconto por vendedor
    const vendedores = Object.values(porVendedor).map(v => ({
      ...v,
      percDesconto: v.vlrBruto > 0 ? (v.vlrDesconto / v.vlrBruto) * 100 : 0,
    }));

    res.json({
      dtIni, dtFin,
      porLoja:     Object.values(porLoja),
      porVendedor: vendedores.sort((a,b) => b.percDesconto - a.percDesconto).slice(0, 20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conferencia/vendas?board=delrey&dtIni=2026-06-01&dtFin=2026-06-08
// Retorna TODAS as vendas do período com formas de pagamento, vendedor e alertas de regra
app.get('/api/conferencia/vendas', requireEscritorioOrAdmin, async (req, res) => {
  try {
    const { board, dtIni, dtFin } = req.query;
    if (!board || !dtIni || !dtFin) return res.status(400).json({ error: 'board, dtIni e dtFin obrigatórios' });

    const db    = await readDB();
    const regra = (db.confRegras || {})[board] || {};
    const parcelaMin           = parseFloat(regra.parcelaMin      || 0);
    const descontoMaxItem      = parseFloat(regra.descontoMaxItem || 100);
    const descontoMaxVenda     = parseFloat(regra.descontoMaxVenda|| 100);
    const descontoSomenteAVista= regra.descontoSomenteAVista === true || regra.descontoSomenteAVista === 'true';

    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = lojas[board];
    if (!cnpj) return res.status(400).json({ error: `Loja "${board}" não configurada` });
    const chave     = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    const cnpjClean = cnpj.replace(/\D/g, '');

    const { fetchMovimento, fetchMovimentoPlanos, fetchMovimentoCartoes,
            fetchLinxPlanos, fetchLinxPlanosBandeiras, fetchVendedores,
            fetchProdutosPromocoes, parseBrNum } = require('./services/microvix');

    const [movRows, planoRows, cartoesRows, planosCatalog, bandeirasCatalog, vendedoresRows, promoRows, catalog] = await Promise.all([
      fetchMovimento(cnpj, dtIni, dtFin, chave),
      fetchMovimentoPlanos(cnpj, dtIni, dtFin, chave).catch(() => []),
      fetchMovimentoCartoes(cnpj, dtIni, dtFin, chave).catch(() => []),
      fetchLinxPlanos(cnpj, chave).catch(() => []),
      fetchLinxPlanosBandeiras(cnpj, chave).catch(() => []),
      fetchVendedores(cnpj, chave).catch(() => []),
      fetchProdutosPromocoes(cnpj, dtIni, dtFin, chave).catch(() => []),
      _getCatalog(lojas).catch(() => ({})),
    ]);

    const parseBR = s => { const t = String(s||'').trim(); if (!t) return 0; return t.includes(',') ? parseFloat(t.replace(/\./g,'').replace(',','.')) || 0 : parseFloat(t) || 0; };

    // Mapa de preços promocionais: cod_produto → preco_promocao
    const promoMap = {};
    for (const p of (Array.isArray(promoRows) ? promoRows : [])) {
      const cod   = String(p.cod_produto || '').trim();
      const preco = parseBR(p.preco_promocao || '0');
      if (cod && preco > 0) promoMap[cod] = preco;
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
      const serie = String(r.serie || r.serie_documento || '').trim();
      if (serie === '999' || (serie === '4' && op !== 'DS')) continue;
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
        docMap[doc].itens.push({
          descricao:    (r.descricao || r.nome_produto || r.referencia || codProd || '—').trim(),
          nome:         (catInfo.nome || catInfo.nomeBase || '').trim(),
          colecao:      (catInfo.linha || '').trim(),
          marca:        (catInfo.marca || '').trim(),
          quantidade:   qty,
          vlrUnitario:  +vlrUnit.toFixed(2),
          vlrBruto:     +vlrBruto.toFixed(2),
          vlrLiquido:   +vlrLiqTot.toFixed(2),
          vlrDesconto:  +vlrDesc.toFixed(2),
          percDesconto: +percItem.toFixed(1),
          emPromocao,
          precoPromocao: precoPromo,
        });

        if (!emPromocao && descontoMaxItem < 100 && percItem > descontoMaxItem && vlrDesc > 0) {
          // Só alerta desconto excessivo se o produto NÃO está em promoção
          docMap[doc].alertas.push({
            tipo: 'desconto_item',
            msg:  `"${(r.descricao || r.referencia || codProd || '').trim()}" ${percItem.toFixed(1)}% desc (máx ${descontoMaxItem}%)`,
          });
        }
      }
    }

    // Alertas de desconto por venda e totais de desconto
    for (const d of Object.values(docMap)) {
      const totalBruto = d.itens.reduce((s, i) => s + i.vlrBruto, 0);
      const totalDesc  = d.itens.reduce((s, i) => s + i.vlrDesconto, 0);
      if (totalDesc > 0 || totalBruto > 0) {
        d.desconto = {
          valor: +totalDesc.toFixed(2),
          perc:  totalBruto > 0 ? +((totalDesc / totalBruto) * 100).toFixed(1) : 0,
        };
        if (descontoMaxVenda < 100 && totalBruto > 0 && totalDesc > 0) {
          const percV = (totalDesc / totalBruto) * 100;
          if (percV > descontoMaxVenda) {
            d.alertas.push({
              tipo: 'desconto_venda',
              msg:  `Desconto total ${percV.toFixed(1)}% na venda (máx ${descontoMaxVenda}%)`,
            });
          }
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
      const bandeira = (r.descricao_bandeira || r.bandeira || '').trim();
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
        const vlrPlano = parseBR(r.total || r.valor || r.valor_plano || '0');
        const vlrParc  = vlrPlano / nP;
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
        if (temParcelado) {
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
    }

    // ── Montar lista e agrupamentos ─────────────────────────────────────────
    const vendas = Object.values(docMap)
      .filter(v => v.valorTotal > 0)
      .sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora))
      .map(v => ({
        doc:         v.doc,
        data:        v.data,
        hora:        v.hora,
        vendedor:    v.vendedorNome || v.vendedorCod || '—',
        valorTotal:  v.valorTotal,
        formas:      v.formas,
        desconto:    v.desconto || null,
        alertas:     v.alertas,
        itens:       v.itens,
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

    res.json({
      board, dtIni, dtFin, regra,
      totalVendas: vendas.reduce((s, v) => s + v.valorTotal, 0),
      totalAlertas: vendas.filter(v => v.alertas.length > 0).length,
      qtdVendas: vendas.length,
      vendas,
      porForma:    Object.values(porForma).sort((a, b) => b.total - a.total),
      porVendedor: Object.values(porVendedor).sort((a, b) => b.total - a.total),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    }

    // Auto-sync Microvix if credentials are set
    if (process.env.MICROVIX_CHAVE && process.env.MICROVIX_LOJAS) {
      console.log(`[Microvix] Auto-sync a cada ${MX_INTERVAL_MS / 60000} min`);

      const doSync    = () => runSync(readDB, writeDB).catch(e => console.error('[Microvix]', e.message));
      const doHoje    = () => runSyncHoje(readDB, writeDB).catch(e => console.error('[Microvix/hoje]', e.message));
      const do30d     = () => runSync30Dias(readDB, writeDB).catch(e => console.error('[Microvix/30d]', e.message));

      setTimeout(do30d, MX_INTERVAL_30D_MS);
      console.log('[Microvix/30d] Conferência 30 dias agendada — 1× por dia');

      setInterval(doSync, MX_INTERVAL_MS);
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
    process.exit(1);
  });
