// Backup do banco do Render → arquivo JSON local com timestamp
// Uso: node scripts/backup-render.js <usuario> <senha>
// Exemplo: node scripts/backup-render.js leonardo leo123

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE = 'gestao-lojas.onrender.com';
const [,, usuario, senha] = process.argv;

if (!usuario || !senha) {
  console.error('Uso: node scripts/backup-render.js <usuario> <senha>');
  process.exit(1);
}

let cookie = '';

function req(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    };
    const r = https.request({ hostname: BASE, path: reqPath, method, headers }, res => {
      const sc = res.headers['set-cookie'];
      if (sc) { const s = sc.find(c => c.startsWith('connect.sid')); if (s) cookie = s.split(';')[0]; }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(ch).toString() }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  // 1. Login
  console.log('Fazendo login no Render...');
  const login = await req('POST', '/api/login', { username: usuario, password: senha });
  const loginData = JSON.parse(login.raw);
  if (login.status !== 200) { console.error('Login falhou:', loginData); process.exit(1); }
  console.log(`Login OK: ${loginData.username}`);

  // 2. Baixar backup
  console.log('Baixando backup do banco...');
  const backup = await req('GET', '/api/backup');
  if (backup.status !== 200) { console.error('Erro no backup:', backup.raw.slice(0, 200)); process.exit(1); }

  // 3. Salvar arquivo local
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `backup-${ts}.json`);
  fs.writeFileSync(file, backup.raw, 'utf8');

  const sizekb = (Buffer.byteLength(backup.raw) / 1024).toFixed(1);
  console.log(`\nBackup salvo: ${file}`);
  console.log(`Tamanho: ${sizekb} KB`);

  // 4. Resumo do conteúdo
  try {
    const db = JSON.parse(backup.raw);
    console.log(`\nResumo:`);
    console.log(`  Funcionários: ${(db.employees || []).length}`);
    console.log(`  Registros vsales: ${Object.keys(db.vsales || {}).length}`);
    console.log(`  Meses com dados: ${Object.keys(db.months || {}).length}`);
  } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
