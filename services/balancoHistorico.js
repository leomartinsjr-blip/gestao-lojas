// Histórico de movimento dos itens a recontar — o "Histórico de Movimento do
// Produto" do Microvix, de todos os itens com diferença de uma vez.
//
// O LinxMovimento é lido da loja inteira, um mês por requisição, e só ficam as
// linhas dos itens com diferença. O saldo de cada linha sai de trás para a
// frente, a partir do estoque de hoje: assim não é preciso ler desde 2020.

const { fetchEstoque, buildRequest, postRequest, parseCsv, parseBrNum } = require('./microvix');

const num = v => parseBrNum(String(v ?? '0'));
const r3 = n => Math.round(n * 1000) / 1000;
const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const isoDe = s => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
};
const somaDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Meses de [ini, fim], do mais novo para o mais antigo
function periodos(ini, fim) {
  const out = [];
  for (let f = fim; f >= ini;) {
    const mes = f.slice(0, 8) + '01';
    const i = mes < ini ? ini : mes;
    out.push([i, f]);
    f = somaDias(i, -1);
  }
  return out;
}

// E/DS entram no estoque; S e DE (devolução de compra) saem
const SINAL = { E: 1, DS: 1, S: -1, DE: -1 };

function tipoDe(r, op) {
  const serie = String(r.serie || '').trim().toUpperCase();
  const tipo = String(r.tipo_transacao || '').trim().toUpperCase();
  const cfop = String(r.desc_cfop || '');
  const sai = SINAL[op] < 0;
  if (serie === 'J' || tipo === 'J' || !parseInt(r.documento || '0')) return sai ? 'Ajuste −' : 'Ajuste +';
  if (serie === '999' || tipo === 'T' || /transfer/i.test(cfop)) return sai ? 'Transf. saída' : 'Transf. entrada';
  if (op === 'DS' || (op === 'E' && /devolu/i.test(cfop))) return 'Devolução';
  if (op === 'DE' || (op === 'S' && /devolu/i.test(cfop))) return 'Dev. compra';
  return op === 'S' ? 'Venda' : 'Entrada';
}

async function buscarHistorico({ cnpj, chave, cods, meses = 24, onEtapa }) {
  const etapa = onEtapa || (() => {});
  const alvo = new Set(cods.map(String));
  const fim = hojeISO();
  const d = new Date(fim.slice(0, 8) + '01T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - meses);
  const ini = d.toISOString().slice(0, 10);
  const pede = async (cmd, params, timeout = 120_000) => {
    const raw = await postRequest(buildRequest(cmd, cnpj, params, chave), timeout, { ttlMs: 0 });
    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>'))
      throw new Error(`Microvix API (${cmd}): ${(raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido'}`);
    return parseCsv(raw);
  };

  const porCod = new Map();
  const falhas = [];
  let ordem = 0;
  function guarda(rows) {
    for (const r of rows) {
      const cod = String(r.cod_produto || '').trim();
      if (!alvo.has(cod)) continue;
      const emp = String(r.cnpj_emp || r.cnpj || '').replace(/\D/g, '');
      if (emp && emp !== cnpj) continue;
      if (['S', '1'].includes(r.cancelado) || ['S', '1'].includes(r.excluido)) continue;
      const op = String(r.operacao || '').trim().toUpperCase();
      if (!SINAL[op]) continue;
      const tp = tipoDe(r, op);
      const em = isoDe(r.data_documento);
      // Cliente de venda não interessa (e é dado pessoal); fornecedor e loja da transferência, sim
      const comNome = tp !== 'Venda' && tp !== 'Devolução' && !tp.startsWith('Ajuste');
      const cc = comNome ? String(r.codigo_cliente || '').trim() : '';
      const l = {
        em, la: isoDe(r.data_lancamento) || em, h: String(r.hora_lancamento || '').trim().slice(0, 5),
        doc: String(r.documento || '').trim(), se: String(r.serie || '').trim(), tp, q: SINAL[op] * num(r.quantidade),
        vu: r3(num(r.preco_unitario)), cf: String(r.id_cfop || '').trim(), n: ordem++, ...(cc ? { cc } : {}),
      };
      if (!porCod.has(cod)) porCod.set(cod, []);
      porCod.get(cod).push(l);
    }
  }
  async function lerPeriodo(a, b) {
    const params = [{ id: 'data_inicial', valor: a }, { id: 'data_fim', valor: b }];
    const rows = await pede('LinxMovimento', params).catch(() => pede('LinxMovimento', params));
    // Resposta no limite de 5.000 linhas pode ter sido cortada: divide o período
    if (rows.length >= 5000 && a < b) {
      const meio = somaDias(a, Math.floor((Date.parse(b) - Date.parse(a)) / 864e5 / 2));
      rows.length = 0;
      await lerPeriodo(a, meio);
      await lerPeriodo(somaDias(meio, 1), b);
      return;
    }
    guarda(rows);
  }
  const ps = periodos(ini, fim);
  for (let i = 0; i < ps.length; i++) {
    etapa(`Histórico: mês ${i + 1} de ${ps.length}`);
    try { await lerPeriodo(...ps[i]); }
    catch (e) { console.warn('[balanco] histórico', ps[i].join('→'), e.message); falhas.push(ps[i]); }
  }
  if (falhas.length === ps.length) throw new Error('O Microvix não respondeu nenhum mês do histórico. Tente de novo.');

  etapa('Histórico: calculando o saldo…');
  const est = new Map();
  let temSaldo = true;
  try {
    for (const r of await fetchEstoque(cnpj, chave, fim)) {
      const c = String(r.cod_produto || '').trim();
      if (alvo.has(c)) est.set(c, (est.get(c) || 0) + num(r.quantidade));
    }
  } catch (e) { temSaldo = false; console.warn('[balanco] histórico, estoque:', e.message); }

  // Nome do fornecedor / loja da transferência, um código por vez. Se a API
  // ignorar o filtro (volta a lista geral), desiste na primeira.
  const nomes = {};
  const codsCli = [...new Set([...porCod.values()].flat().map(l => l.cc).filter(Boolean))].slice(0, 60);
  for (const cc of codsCli) {
    try {
      const rows = await pede('LinxClientesFornec', [
        { id: 'data_inicial', valor: '2000-01-01' }, { id: 'data_fim', valor: fim },
        { id: 'timestamp', valor: '0' }, { id: 'cod_cliente', valor: cc },
      ], 60_000);
      const r = rows.find(x => String(x.cod_cliente || '').trim() === cc);
      if (r) nomes[cc] = String(r.nome_cliente || r.razao_cliente || '').replace(/\s+/g, ' ').trim();
      if (rows.length > 5) break;
    } catch (e) { console.warn('[balanco] histórico, nomes:', e.message); break; }
  }

  // Antes de um mês que falhou o saldo não fecha
  const furo = falhas.reduce((m, [, b]) => (b > m ? b : m), '');
  const itens = {};
  for (const cod of alvo) {
    const ls = (porCod.get(cod) || []).sort((a, b) => a.la.localeCompare(b.la) || a.h.localeCompare(b.h) || a.n - b.n);
    let saldo = est.get(cod) || 0;
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i];
      l.s = !temSaldo || (furo && l.la <= furo) ? null : r3(saldo);
      saldo -= l.q;
      delete l.n;
    }
    itens[cod] = { a: temSaldo && !furo ? r3(saldo) : null, l: ls };
  }
  return { ini, fim, meses, em: new Date().toISOString(), falhas, nomes, itens };
}

module.exports = { buscarHistorico, periodos };
