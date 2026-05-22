// Script: criar IAGO no Render e definir metas mensais
// Uso: node scripts/criar-iago-render.js <usuario> <senha>
// Exemplo: node scripts/criar-iago-render.js admin minhasenha

const https = require('https');

const BASE = 'gestao-lojas.onrender.com';
const [,, usuario, senha] = process.argv;

if (!usuario || !senha) {
  console.error('Uso: node scripts/criar-iago-render.js <usuario> <senha>');
  process.exit(1);
}

let sessionCookie = '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    };
    const req = https.request({ hostname: BASE, path, method, headers }, res => {
      // Captura cookie de sessão no login
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const sid = setCookie.find(c => c.startsWith('connect.sid'));
        if (sid) sessionCookie = sid.split(';')[0];
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // 1. Login
  console.log('Fazendo login...');
  const login = await request('POST', '/api/login', { username: usuario, password: senha });
  if (login.status !== 200) {
    console.error('Login falhou:', login.body);
    process.exit(1);
  }
  console.log('Login OK:', login.body.username, '/', login.body.board);

  // 2. Verificar se IAGO já existe
  const emps = await request('GET', '/api/employees');
  const jaExiste = (emps.body || []).find(e =>
    e.board === 'minas' && (e.microvixCod === '169' || (e.name || '').toUpperCase().includes('IAGO'))
  );
  let iagoId;

  if (jaExiste) {
    iagoId = jaExiste.id;
    console.log(`IAGO já existe no Render (id=${iagoId}), pulando criação.`);
    // Garante microvixCod correto
    if (jaExiste.microvixCod !== '169') {
      await request('PUT', `/api/employees/${iagoId}`, {
        ...jaExiste, microvixCod: '169',
      });
      console.log('microvixCod atualizado para 169.');
    }
  } else {
    // 3. Criar IAGO
    console.log('Criando IAGO no Render...');
    const criado = await request('POST', '/api/employees', {
      name:             'IAGO NICOLAS NASCIMENTO SILVA',
      apelido:          'IAGO',
      board:            'minas',
      cargo:            'Vendedor',
      microvixCod:      '169',
      isVendedor:       true,
      inativo:          false,
      salario:          0,
      comissaoSemMeta:  4.5,
      comissao:         5,
      comissaoMeta2:    5.5,
      comissaoSuper:    6,
    });
    if (criado.status !== 200) {
      console.error('Erro ao criar IAGO:', criado.body);
      process.exit(1);
    }
    iagoId = criado.body.id;
    console.log(`IAGO criado com sucesso (id=${iagoId})`);
  }

  // 4. Definir meta mensal para maio e abril de 2026
  const MENSAL = 46666.67;
  const meses = [{ year: 2026, month: 5 }, { year: 2026, month: 4 }];

  for (const { year, month } of meses) {
    const r = await request('POST', `/api/vsales/${year}/${month}/minas/${iagoId}/meta`, {
      mensal: MENSAL,
    });
    if (r.status === 200) {
      console.log(`Meta ${year}-${String(month).padStart(2,'0')}: R$ ${MENSAL.toLocaleString('pt-BR')} ✓`);
    } else {
      console.error(`Erro ao definir meta ${year}-${month}:`, r.body);
    }
  }

  console.log('\nPronto! Rode o sync retroativo no Render para importar as vendas do IAGO:');
  console.log('fetch("/api/microvix/sync-retroativo", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({dtIni:"2026-04-01", dtFin:"2026-05-21", boards:["minas"]})})');
}

main().catch(err => { console.error(err); process.exit(1); });
