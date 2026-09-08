/* ══════════════════════════════════════════════════════════════════════════
   IMPORTA A PLANILHA DO VALE-TRANSPORTE PARA O MÓDULO
   Lê o "VALE TRANSPORTE <ano>.xlsx" e sobe o que ele tem: as empresas
   pagadoras (com operadora e acesso ao portal), TODOS os cartões — inclusive
   os que estão parados na gaveta, que na planilha eram só um número solto numa
   linha vazia — e, se pedido, os saldos do mês.

   O vínculo com o colaborador não vem daqui: a planilha escreve o nome à mão e
   em três formatos ("BRUNO (LMJ)", "TOMMY - KARLA", "TATIANE - 3L"), o que dá
   27 nomes distintos para umas 20 pessoas. Cada cartão chega com o nome da
   planilha ao lado para você ligar na tela, uma vez só.

   Uso:
     node scripts/importar-vt.js <arquivo.xlsx> <aba> <usuario> <senha> [--host localhost:3000] [--mes 2026-09] [--gravar]

   Sem --gravar ele só mostra o que faria.
   ══════════════════════════════════════════════════════════════════════════ */

const XLSX  = require('xlsx');
const http  = require('http');
const https = require('https');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt  = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };
const soltos = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && ['--host', '--mes'].includes(args[i - 1])));

const [arquivo, aba, usuario, senha] = soltos;
const HOST    = opt('--host', 'gestao-lojas.onrender.com');
const GRAVAR  = flag('--gravar');
const MES     = opt('--mes', '');   // "2026-09" leva também os saldos daquele mês

if (require.main === module && (!arquivo || !aba)) {
  console.error('Uso: node scripts/importar-vt.js <arquivo.xlsx> <aba> <usuario> <senha> [--host h] [--mes 2026-09] [--gravar]');
  process.exit(1);
}

// ── Leitura da planilha ────────────────────────────────────────────────────
// Um bloco começa na linha que tem login/senha escritos; dali até o próximo
// bloco, toda linha com número na coluna do cartão é um cartão.
function lePlanilha(caminho, nomeAba) {
  const wb = XLSX.readFile(caminho, { cellFormula: false });
  const nome = wb.SheetNames.find(n => n.trim() === String(nomeAba).trim()) || nomeAba;
  const ws = wb.Sheets[nome];
  if (!ws) throw new Error(`Aba "${nomeAba}" não existe. Abas: ${wb.SheetNames.join(', ')}`);
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const num = v => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const txt = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

  const blocos = [];
  let atual = null;

  for (const l0 of linhas) {
    const l = l0 || [];
    const juntas = [l[1], l[2], l[3], l[4], l[5]].map(txt).filter(Boolean).join(' ');
    const ehCabecalho = /login|senha/i.test(juntas);

    if (ehCabecalho) {
      const operadora = /otimo|ótimo/i.test(juntas) || /otimo|ótimo/i.test(txt(l[6])) ? 'OTIMO'
        : (/bhbus/i.test(juntas) || /bhbus/i.test(txt(l[6])) ? 'BHBUS' : 'BHBUS');
      const cnpj  = (juntas.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/) || [])[1] || '';
      const login = (juntas.match(/login:?\s*([\w./-]+)/i) || [])[1] || '';
      const senhaP = (juntas.match(/senha:?\s*([\w./-]+)/i) || [])[1] || '';
      // O nome é o que vem antes do "Login"/"Senha"; se sobrar vazio, usa a sigla.
      let nomeEmp = juntas.split(/[-–]?\s*login/i)[0].split(/[-–]?\s*senha/i)[0].trim();
      nomeEmp = nomeEmp.replace(/[-–\s]+$/, '').trim() || txt(l[1]) || 'Sem nome';
      atual = { nome: nomeEmp, cnpj, operadora, login, senha: senhaP, cartoes: [] };
      blocos.push(atual);
      continue;
    }

    const numero = txt(l[2]);
    if (!atual || !numero) continue;
    if (/cart[ãa]o/i.test(numero)) continue;            // linha de cabeçalho da tabela

    atual.cartoes.push({
      numero,
      nomePlanilha: txt(l[5]),
      valorDia:     num(l[6]),
      passagensDia: num(l[4]) || 2,
      saldo:        num(l[10]),
    });
  }

  return blocos.filter(b => b.cartoes.length || b.login || b.senha);
}

// ── Conversa com o servidor ────────────────────────────────────────────────
let cookie = '';
function req(method, caminho, body) {
  const mod = HOST.startsWith('localhost') || HOST.startsWith('127.') ? http : https;
  const [hostname, porta] = HOST.split(':');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = mod.request({
      hostname, port: porta || undefined, path: caminho, method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const sc = res.headers['set-cookie'];
      if (sc) { const s = sc.find(c => c.startsWith('connect.sid')); if (s) cookie = s.split(';')[0]; }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(ch).toString();
        let json = null; try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Principal ──────────────────────────────────────────────────────────────
// Exportado para o teste poder ler a planilha sem subir nada.
module.exports = { lePlanilha };

if (require.main === module) (async () => {
  const blocos = lePlanilha(arquivo, aba);

  console.log(`\nAba "${aba}" — ${blocos.length} empresas, ` +
              `${blocos.reduce((s, b) => s + b.cartoes.length, 0)} cartões\n`);
  for (const b of blocos) {
    const comDono = b.cartoes.filter(c => c.nomePlanilha).length;
    console.log(`  ${b.operadora.padEnd(5)} ${b.nome}`);
    console.log(`        cnpj: ${b.cnpj || '—'}  login: ${b.login || '—'}  senha: ${b.senha ? '•'.repeat(b.senha.length) : '—'}`);
    console.log(`        ${b.cartoes.length} cartões (${comDono} com nome na planilha, ${b.cartoes.length - comDono} na gaveta)`);
    for (const c of b.cartoes.filter(x => x.nomePlanilha))
      console.log(`          ${c.numero.padEnd(20)} ${String(c.nomePlanilha).padEnd(18)} dia ${c.valorDia ?? '—'}  saldo ${c.saldo ?? '—'}`);
  }

  if (!GRAVAR) {
    console.log('\n(prévia — nada foi gravado; rode de novo com --gravar)\n');
    return;
  }
  if (!usuario || !senha) { console.error('\nPara gravar informe usuário e senha.\n'); process.exit(1); }

  const login = await req('POST', '/api/login', { username: usuario, password: senha });
  if (login.status !== 200) { console.error('Login falhou:', login.json || login.raw); process.exit(1); }
  console.log(`\nLogado em ${HOST} como ${usuario}.`);

  const [ano, mes] = MES ? MES.split('-') : [null, null];
  const r = await req('POST', '/api/vt/importar', { blocos, ano, mes });
  if (r.status !== 200) { console.error('Importação falhou:', r.json || r.raw); process.exit(1); }
  console.log('\n' + JSON.stringify(r.json, null, 2) + '\n');
})().catch(e => { console.error('\nErro:', e.message, '\n'); process.exit(1); });
