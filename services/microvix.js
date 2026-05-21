// ── Microvix WebAPI client ─────────────────────────────────────────────────
// Endpoint: POST https://webapi.microvix.com.br/1.0/api/integracao
// Format: XML body → CSV response
const https = require('https');

const MX_HOST = 'webapi.microvix.com.br';
const MX_PATH = '/1.0/api/integracao';

function buildRequest(command, cnpj, extraParams = [], chaveOverride) {
  const authUser = process.env.MICROVIX_AUTH_USER || 'linx_export';
  const authPass = process.env.MICROVIX_AUTH_PASS || 'linx_export';
  const chave    = chaveOverride || process.env.MICROVIX_CHAVE;
  const cnpjNum  = cnpj.replace(/\D/g, '');

  const params = [];
  params.push(`      <Parameter id="chave">${chave}</Parameter>`);
  params.push(`      <Parameter id="cnpjEmp">${cnpjNum}</Parameter>`);
  extraParams.forEach(p => params.push(`      <Parameter id="${p.id}">${p.valor}</Parameter>`));
  const paramXml = params.join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<LinxMicrovix>
  <Authentication user="${authUser}" password="${authPass}" />
  <ResponseFormat>csv</ResponseFormat>
  <Command>
    <Name>${command}</Name>
    <Parameters>
${paramXml}
    </Parameters>
  </Command>
</LinxMicrovix>`;
}

function postRequest(body, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf-8');
    const opts = {
      hostname: MX_HOST,
      path:     MX_PATH,
      method:   'POST',
      headers: {
        'Content-Type':   'text/xml; charset=utf-8',
        'Content-Length': buf.length,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Microvix timeout')); });
    req.write(buf);
    req.end();
  });
}

// Parse a single CSV line respecting quoted fields
function splitCsvLine(line, sep) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === sep) { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

// Parse CSV with header row → array of objects
function parseCsv(csv) {
  const lines = csv.trim().split(/\r?\n/).filter(l => l && !l.startsWith('sep='));
  if (lines.length < 2) return [];
  const sep = csv.startsWith('sep=,') ? ',' : ';';
  const headers = splitCsvLine(lines[0], sep);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line, sep);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
    return obj;
  });
}

// Parse BR decimal string "1.234,56" → number
function parseBrNum(s) {
  return parseFloat((s || '0').replace(/\./g, '').replace(',', '.')) || 0;
}

// Fetch LinxMovimento (daily sales) for a date range YYYY-MM-DD
async function fetchMovimento(cnpj, dtIni, dtFin, chave) {
  const body = buildRequest('LinxMovimento', cnpj, [
    { id: 'data_inicial', valor: dtIni },
    { id: 'data_fim',     valor: dtFin },
  ], chave);

  const raw = await postRequest(body);

  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API: ${msg}`);
  }

  return parseCsv(raw);
}

// Fetch LinxVendedores → array { cod_vendedor, nome_vendedor, ativo }
async function fetchVendedores(cnpj, chave) {
  const body = buildRequest('LinxVendedores', cnpj, [], chave);
  const raw  = await postRequest(body);

  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (vendedores): ${msg}`);
  }

  return parseCsv(raw);
}

// Fetch LinxFuncionarios → array { cod_funcionario, nome_funcionario, foto, ... }
async function fetchFuncionarios(cnpj, chave) {
  const body = buildRequest('LinxFuncionarios', cnpj, [], chave);
  const raw  = await postRequest(body);

  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (funcionarios): ${msg}`);
  }

  return parseCsv(raw);
}

// Fetch LinxProdutosInventario → stock per SKU (cod_barra/cod_produto + quantidade)
// data: 'YYYY-MM-DD' (required by Microvix)
async function fetchEstoque(cnpj, chave, data) {
  const dataInv = data || new Date().toISOString().slice(0, 10);
  const body = buildRequest('LinxProdutosInventario', cnpj, [
    { id: 'data_inventario', valor: dataInv },
  ], chave);
  const raw = await postRequest(body);

  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (inventario): ${msg}`);
  }

  return parseCsv(raw);
}

// Fetch LinxProdutos → product catalog with description, color, size per cod_barra
// Requires dt_update_ini + dt_update_fim; timestamp=0 returns all
async function fetchProdutos(cnpj, chave, timestamp = 0) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayBR = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()}`;
  const body = buildRequest('LinxProdutos', cnpj, [
    { id: 'timestamp',     valor: String(timestamp) },
    { id: 'dt_update_ini', valor: '01/01/2000' },
    { id: 'dt_update_fim', valor: todayBR },
  ], chave);
  const raw = await postRequest(body, 120_000); // catálogo pode ser grande

  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (produtos): ${msg}`);
  }

  return parseCsv(raw);
}

module.exports = { fetchMovimento, fetchVendedores, fetchFuncionarios, fetchEstoque, fetchProdutos, parseBrNum, buildRequest, postRequest, parseCsv };
