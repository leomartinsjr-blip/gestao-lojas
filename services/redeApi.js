'use strict';
// API Gestão de Vendas da Rede (portal Rede Developers). Só leitura.
//
// Credenciais: REDE_CLIENT_ID e REDE_CLIENT_SECRET (client_credentials). O token dura
// 24 min e fica em memória. Cada estabelecimento (PV) precisa ter aprovado o acesso ao
// extrato no portal da Rede (Minha Rede → PV → Conciliação → Compartilhar); sem isso a
// Rede responde 403 "Partner not allowed for this company number".

const BASE = 'https://api.userede.com.br/redelabs';

// Loja do gestão → estabelecimento Rede (PV)
const PV_DA_LOJA = {
  delrey: '74674250', minas: '95934715', contagem: '95938443',
  estacao: '40081257', tommy: '101306423', lez: '102362092',
};

const BANDEIRA = {
  1: 'Mastercard', 2: 'Visa', 3: 'Diners', 4: 'Cabal', 5: 'Sicredi', 6: 'Sorocred', 7: 'Hipercard', 8: 'Cup',
  13: 'Amex', 14: 'Elo', 15: 'Hiper', 74: 'Banescard', 76: 'JCB', 77: 'Credz',
};

const configurada = () => !!(process.env.REDE_CLIENT_ID && process.env.REDE_CLIENT_SECRET);

let _token = null; // { valor, ate }
async function token() {
  if (_token && Date.now() < _token.ate) return _token.valor;
  if (!configurada()) throw new Error('API da Rede não configurada (REDE_CLIENT_ID / REDE_CLIENT_SECRET)');
  const basic = Buffer.from(`${process.env.REDE_CLIENT_ID}:${process.env.REDE_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Rede recusou o login (HTTP ${r.status})`);
  _token = { valor: j.access_token, ate: Date.now() + Math.max(60, (j.expires_in || 1440) - 120) * 1000 };
  return _token.valor;
}

const addDias = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Vendas do PV no período (a Rede aceita até 62 dias por consulta; aqui vai em blocos de 31).
// Devolve as transações como a Rede manda, com `bandeira` (nome) acrescentado.
async function vendas(pv, dtIni, dtFin) {
  const out = [];
  for (let ini = dtIni; ini <= dtFin; ini = addDias(ini, 31)) {
    const fim = addDias(ini, 30) < dtFin ? addDias(ini, 30) : dtFin;
    let pageKey = '', paginas = 0;
    do {
      const q = new URLSearchParams({ parentCompanyNumber: pv, subsidiaries: pv, startDate: ini, endDate: fim, size: '100', ...(pageKey ? { pageKey } : {}) });
      const r = await fetch(`${BASE}/merchant-statement/v1/sales?${q}`, { headers: { Authorization: `Bearer ${await token()}` } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error(`a Rede ainda não liberou o estabelecimento ${pv} (aprove o compartilhamento em Minha Rede → Conciliação)`);
      if (!r.ok) throw new Error(`Rede respondeu HTTP ${r.status}${j.message ? ': ' + j.message : ''}`);
      for (const t of j.content?.transactions || []) out.push({ ...t, bandeira: BANDEIRA[t.brandCode] || `Bandeira ${t.brandCode}` });
      pageKey = j.cursor?.hasNextKey ? j.cursor.nextKey : '';
      if (++paginas > 200) throw new Error('Rede: paginação não terminou');
    } while (pageKey);
  }
  return out;
}

module.exports = { configurada, vendas, PV_DA_LOJA, BANDEIRA };
