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
// Also handles international format "87.5" (single dot = decimal, no comma)
function parseBrNum(s) {
  const str = (s || '0').trim();
  if (str.includes(',')) {
    // Brazilian: dot = thousands separator, comma = decimal
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
  }
  const dots = (str.match(/\./g) || []).length;
  if (dots <= 1) {
    // No comma + single dot (or no dot): dot is decimal separator
    return parseFloat(str) || 0;
  }
  // Multiple dots, no comma: dots are thousands separators (e.g. "1.234.567")
  return parseFloat(str.replace(/\./g, '')) || 0;
}

// Fetch LinxMovimento (daily sales) for a date range YYYY-MM-DD
async function fetchMovimento(cnpj, dtIni, dtFin, chave, tipoMov = null) {
  const extra = [
    { id: 'data_inicial', valor: dtIni },
    { id: 'data_fim',     valor: dtFin },
  ];
  if (tipoMov) extra.push({ id: 'tipo_movimentacao', valor: tipoMov });
  const body = buildRequest('LinxMovimento', cnpj, extra, chave);

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
// Pagina automaticamente em blocos de 5000 até esgotar o catálogo.
// dataMov: filtra apenas produtos com movimento desde essa data (ex: '2024-01-01')
async function fetchProdutos(cnpj, chave, timestamp = 0, dataMov = null) {
  const today = new Date().toISOString().slice(0, 10);
  const allRows = [];
  let ts = timestamp;
  const extraParams = [
    { id: 'dt_update_inicio', valor: '2000-01-01' },
    { id: 'dt_update_fim',    valor: today },
  ];
  if (dataMov) extraParams.push({ id: 'data_mov_ini', valor: dataMov });

  for (let page = 0; page < 20; page++) {
    const body = buildRequest('LinxProdutos', cnpj, [
      { id: 'timestamp', valor: String(ts) },
      ...extraParams,
    ], chave);
    const raw = await postRequest(body, 120_000);

    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
      const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
      throw new Error(`Microvix API (produtos): ${msg}`);
    }

    const rows = parseCsv(raw);
    allRows.push(...rows);
    if (rows.length < 5000) break;

    const maxTs = Math.max(...rows.map(r => parseInt(r.timestamp) || 0));
    if (maxTs <= ts) break;
    ts = maxTs;
  }

  return allRows;
}

// Fetch LinxFormasPagamentos → payment method breakdown per sale
// Fetch LinxMovimentoPlanos → one row per payment method per sale
async function fetchMovimentoPlanos(cnpj, dtIni, dtFin, chave) {
  const extra = [
    { id: 'data_inicial', valor: dtIni },
    { id: 'data_fim',     valor: dtFin },
  ];
  const body = buildRequest('LinxMovimentoPlanos', cnpj, extra, chave);
  const raw  = await postRequest(body);
  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (movimentoPlanos): ${msg}`);
  }
  return parseCsv(raw);
}

// Fetch LinxSangriaSuprimentos → sangrias e suprimentos de caixa
async function fetchSangrias(cnpj, dtIni, dtFin, chave) {
  const extra = [
    { id: 'data_inicial', valor: dtIni },
    { id: 'data_fim',     valor: dtFin },
  ];
  const body = buildRequest('LinxSangriaSuprimentos', cnpj, extra, chave);
  const raw  = await postRequest(body);
  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (sangrias): ${msg}`);
  }
  return parseCsv(raw);
}

module.exports = { fetchMovimento, fetchVendedores, fetchFuncionarios, fetchEstoque, fetchProdutos, fetchMovimentoPlanos, fetchSangrias, parseBrNum, buildRequest, postRequest, parseCsv };
