'use strict';
// ── Feed do CRM ────────────────────────────────────────────────────────────
// O CRM (app separado, crm-lojas) não consulta o Microvix: a cota diária é uma
// só e o gestão já baixa o movimento. Este módulo guarda, de carona nesse sync,
// as vendas com o cliente de cada uma (crm_vendas) e mantém o cadastro de
// clientes (crm_clientes) por timestamp incremental. O CRM lê os dois pela API
// interna /api/internal/crm/*, em ordem de atualizadoEm.
//
// Nada é apagado: venda que some do Microvix (cancelada/estornada) fica com
// cancelado=true e atualizadoEm novo — senão quem lê por delta nunca saberia.
const crypto = require('crypto');
const { fetchClientes, fetchMovimento, fetchVendedores, parseBrNum } = require('./microvix');

function getLojas() {
  try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; }
}

function chaveDoBoard(board) {
  return process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
}

function normName(s) {
  return (s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "DD/MM/YYYY HH:MM:SS" → "YYYY-MM-DD"
function parseDate(s) {
  const [d, m, y] = String(s || '').slice(0, 10).split('/');
  return y && m && d ? `${y}-${m}-${d}` : null;
}

const digits = s => String(s || '').replace(/\D/g, '');
const hashOf = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

// ── Vendas ─────────────────────────────────────────────────────────────────
// Mesmas regras de venda do services/microvixSync.js (o que não soma no
// faturamento não gera giftback nem conta como compra do cliente).
function ehLinhaDeVenda(row) {
  if (row.cancelado === 'S' || row.cancelado === '1') return false;
  const op = (row.operacao || '').trim().toUpperCase();
  if (op !== 'S' && op !== 'DS') return false;
  if ((row.serie || '').trim().toUpperCase() === 'J' || !parseInt(row.documento || '0')) return false;
  if ((row.serie || '').trim() === '999') return false;
  return true;
}

function montarVendas(board, rows, vendMap, employees) {
  const vendas = {};
  for (const row of rows) {
    if (!ehLinhaDeVenda(row)) continue;
    const codVend = String(row.cod_vendedor || '').trim();
    const vendNorm = vendMap[codVend] || '';
    if (/^\W*loja\W*$/.test(vendNorm)) continue;
    const data = parseDate(row.data_documento);
    if (!data) continue;

    const op    = row.operacao.trim().toUpperCase();
    const ident = (row.identificador || '').trim() || `${row.serie}:${row.documento}:${op}`;
    const id    = `${board}:${ident}`;
    let v = vendas[id];
    if (!v) {
      const portal = String(row.portal || '').trim();
      const codCli = String(row.codigo_cliente || '').trim();
      const emp = employees.find(e => e.board === board && e.microvixCod && String(e.microvixCod) === codVend)
               || employees.find(e => e.board === board && vendNorm && normName(e.name) === vendNorm);
      v = vendas[id] = {
        _id: id, board, portal, data,
        hora: (row.hora_lancamento || '').trim().slice(0, 5),
        documento: String(row.documento).trim(), serie: String(row.serie || '').trim(),
        operacao: op,
        cliente: parseInt(codCli) ? `${portal}:${codCli}` : null,
        codVendedor: codVend, empId: emp ? emp.id : null,
        valor: 0, pecas: 0, desconto: 0,
      };
    }
    v.valor    += parseBrNum(row.valor_total);
    v.pecas    += parseInt(row.quantidade || 0, 10) || 0;
    v.desconto += parseBrNum(row.desconto_total_item || row.desconto);
  }
  for (const v of Object.values(vendas)) {
    v.valor = +v.valor.toFixed(2);
    v.desconto = +v.desconto.toFixed(2);
  }
  return Object.values(vendas);
}

async function salvarVendas(mongoDb, board, dtIni, dtFin, rows, vendMap, employees) {
  if (!mongoDb || board === 'site') return { gravadas: 0, canceladas: 0 };
  const col   = mongoDb.collection('crm_vendas');
  const novas = montarVendas(board, rows, vendMap, employees);
  const atuais = await col.find(
    { board, data: { $gte: dtIni, $lte: dtFin } },
    { projection: { hash: 1, cancelado: 1 } }
  ).toArray();
  const porId = new Map(atuais.map(d => [d._id, d]));
  const agora = new Date();
  const ops = [];

  for (const v of novas) {
    const hash = hashOf(v);
    const ant  = porId.get(v._id);
    porId.delete(v._id);
    if (ant && ant.hash === hash && !ant.cancelado) continue;
    ops.push({ replaceOne: { filter: { _id: v._id }, upsert: true,
      replacement: { ...v, hash, cancelado: false, atualizadoEm: agora } } });
  }
  let canceladas = 0;
  for (const ant of porId.values()) {
    if (ant.cancelado) continue;
    canceladas++;
    ops.push({ updateOne: { filter: { _id: ant._id }, update: { $set: { cancelado: true, atualizadoEm: agora } } } });
  }
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  return { gravadas: ops.length - canceladas, canceladas };
}

// Histórico para o CRM, mês a mês. Separado do runSyncRetroativo de propósito:
// aquele regrava as vendas por vendedor do gestão, e meses antigos têm gente
// que já saiu — aqui só o crm_vendas é tocado.
let backfill = null;   // { at, boards, feito, total, erro }

function mesesEntre(dtIni, dtFin) {
  const out = [];
  let d = new Date(dtIni.slice(0, 7) + '-01T00:00:00Z');
  const fim = new Date(dtFin + 'T00:00:00Z');
  while (d <= fim) {
    const ini = d.toISOString().slice(0, 10);
    const ult = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push([ini < dtIni ? dtIni : ini, ult > dtFin ? dtFin : ult]);
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

async function backfillVendas(mongoDb, employees, dtIni, dtFin, boards) {
  if (backfill && !backfill.fimEm) throw new Error('Backfill já em andamento');
  const lojas = Object.entries(getLojas()).filter(([b]) => b !== 'site' && (!boards?.length || boards.includes(b)));
  const meses = mesesEntre(dtIni, dtFin);
  backfill = { at: new Date().toISOString(), dtIni, dtFin, boards: lojas.map(l => l[0]), feito: 0, total: lojas.length * meses.length, vendas: 0, erros: [] };
  (async () => {
    for (const [board, cnpj] of lojas) {
      const chave = chaveDoBoard(board);
      try {
        const vendRows = await fetchVendedores(digits(cnpj), chave);
        const vendMap = Object.fromEntries(vendRows.map(v => [String(v.cod_vendedor).trim(), normName(v.nome_vendedor)]));
        for (const [ini, fin] of meses) {
          try {
            const rows = await fetchMovimento(digits(cnpj), ini, fin, chave);
            const r = await salvarVendas(mongoDb, board, ini, fin, rows, vendMap, employees);
            backfill.vendas += r.gravadas;
          } catch (e) { backfill.erros.push(`${board} ${ini}: ${e.message}`); }
          backfill.feito++;
        }
      } catch (e) { backfill.erros.push(`${board}: ${e.message}`); backfill.feito += meses.length; }
    }
    backfill.fimEm = new Date().toISOString();
    console.log(`[CRM feed] backfill ${dtIni}→${dtFin}: ${backfill.vendas} vendas, ${backfill.erros.length} erros`);
  })();
  return backfill;
}

const statusBackfill = () => backfill;

// ── Clientes ───────────────────────────────────────────────────────────────
// Um cadastro por portal Microvix: as Surfers dividem a chave padrão, a Tommy
// tem a dela. Agrupa as lojas pela chave e lê uma vez por grupo.
function gruposDeCadastro() {
  const grupos = new Map();
  for (const [board, cnpj] of Object.entries(getLojas())) {
    if (board === 'site') continue;
    const chave = chaveDoBoard(board);
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, { id: board, cnpj: digits(cnpj), chave, boards: [] });
    grupos.get(chave).boards.push(board);
  }
  return [...grupos.values()];
}

function montarCliente(r) {
  const portal = String(r.portal || '').trim();
  const cod    = String(r.cod_cliente || '').trim();
  const cel    = digits(r.cel_cliente);
  const fone   = digits(r.fone_cliente);
  return {
    _id: `${portal}:${cod}`, portal, cod,
    nome: (r.nome_cliente || r.razao_cliente || '').trim(),
    tipo: (r.tipo_cliente || '').trim(),          // F física / J jurídica
    cpf: digits(r.doc_cliente),
    celular: cel || (fone.length >= 10 && fone[2] === '9' ? fone : ''),
    fone, email: (r.email_cliente || '').trim().toLowerCase(),
    nascimento: parseDate(r.data_nascimento),
    sexo: ['M', 'F'].includes(r.sexo) ? r.sexo : '',
    cidade: (r.cidade_cliente || '').trim(), uf: (r.uf_cliente || '').trim(),
    bairro: (r.bairro_cliente || '').trim(),
    dataCadastro: parseDate(r.data_cadastro),
    empresaCadastro: String(r.empresa_cadastro || '').trim(),
    ativo: r.ativo !== 'N',
    anonimo: String(r.cliente_anonimo).toLowerCase() === 'true',
    recebeNewsletter: r.recebe_newsletter === '1',
    timestamp: parseInt(r.timestamp || '0', 10) || 0,
  };
}

let clientesRodando = false;

async function syncClientes(mongoDb) {
  if (!mongoDb) throw new Error('MongoDB não configurado');
  if (clientesRodando) return { skipped: true };
  clientesRodando = true;
  try {
    const col    = mongoDb.collection('crm_clientes');
    const estado = mongoDb.collection('crm_feed_estado');
    const result = {};
    for (const g of gruposDeCadastro()) {
      const est = await estado.findOne({ _id: `clientes:${g.id}` });
      const ts0 = est?.timestamp || 0;
      const rows = await fetchClientes(g.cnpj, g.chave, '2000-01-01', null, ts0);
      const agora = new Date();
      let maxTs = ts0, n = 0;
      const ops = [];
      for (const r of rows) {
        if ((r.tipo_cadastro || 'C') === 'F') continue;   // só fornecedor
        const c = montarCliente(r);
        if (c.timestamp > maxTs) maxTs = c.timestamp;
        if (!c.cod || c.cod === '0' || !c.nome) continue;
        ops.push({ replaceOne: { filter: { _id: c._id }, upsert: true,
          replacement: { ...c, grupo: g.id, boards: g.boards, atualizadoEm: agora } } });
        n++;
        if (ops.length >= 1000) await col.bulkWrite(ops.splice(0), { ordered: false });
      }
      if (ops.length) await col.bulkWrite(ops, { ordered: false });
      await estado.updateOne({ _id: `clientes:${g.id}` },
        { $set: { timestamp: maxTs, at: agora, ultimos: n } }, { upsert: true });
      result[g.id] = n;
      console.log(`[CRM feed] clientes ${g.id}: ${n} gravados (timestamp ${ts0} → ${maxTs})`);
    }
    return result;
  } finally {
    clientesRodando = false;
  }
}

// O feed é buffer, não arquivo: o histórico mora no banco do CRM, e o Mongo do
// gestão (Atlas M0, 512 MB) não comporta anos de vendas por cliente. Venda com
// data e atualização velhas sai — o sync de 30 dias nunca mais vai tocá-la.
async function podarFeed(mongoDb) {
  // Vendas ficam além da janela do sync de 30 dias (senão seriam regravadas e
  // reenviadas ao CRM a cada rodada); cliente só precisa durar até o CRM ler.
  const dias  = parseInt(process.env.CRM_FEED_RETENCAO_DIAS || '45', 10);
  const diasCli = parseInt(process.env.CRM_FEED_RETENCAO_CLIENTES_DIAS || '10', 10);
  const corte = new Date(Date.now() - dias * 86400_000);
  const corteData = corte.toISOString().slice(0, 10);
  const [v, c] = await Promise.all([
    mongoDb.collection('crm_vendas').deleteMany({ data: { $lt: corteData }, atualizadoEm: { $lt: corte } }),
    mongoDb.collection('crm_clientes').deleteMany({ atualizadoEm: { $lt: new Date(Date.now() - diasCli * 86400_000) } }),
  ]);
  console.log(`[CRM feed] poda: ${v.deletedCount} vendas (+${dias}d), ${c.deletedCount} clientes (+${diasCli}d)`);
}

// Recomeça o cadastro do zero (CRM novo ou banco do CRM perdido)
async function zerarCursorClientes(mongoDb) {
  await mongoDb.collection('crm_feed_estado').deleteMany({ _id: /^clientes:/ });
}

async function ensureIndexes(mongoDb) {
  await Promise.all([
    mongoDb.collection('crm_vendas').createIndex({ atualizadoEm: 1, _id: 1 }),
    mongoDb.collection('crm_vendas').createIndex({ board: 1, data: 1 }),
    mongoDb.collection('crm_clientes').createIndex({ atualizadoEm: 1, _id: 1 }),
  ]);
}

// Leitura por delta: tudo com (atualizadoEm, _id) depois do cursor, em ordem.
// O cursor é "ISO|_id" do último item recebido; vazio começa do início.
async function lerDelta(mongoDb, colName, cursor, limite) {
  const [iso, lastId] = String(cursor || '').split('|');
  const desde = iso ? new Date(iso) : null;
  const filtro = desde && !isNaN(desde)
    ? { $or: [{ atualizadoEm: { $gt: desde } }, { atualizadoEm: desde, _id: { $gt: lastId || '' } }] }
    : {};
  const itens = await mongoDb.collection(colName).find(filtro, { projection: { hash: 0 } })
    .sort({ atualizadoEm: 1, _id: 1 }).limit(limite).toArray();
  const ult = itens[itens.length - 1];
  return {
    itens,
    cursor: ult ? `${ult.atualizadoEm.toISOString()}|${ult._id}` : (cursor || ''),
    fim: itens.length < limite,
  };
}

module.exports = { montarVendas, salvarVendas, backfillVendas, statusBackfill, syncClientes, podarFeed, zerarCursorClientes, ensureIndexes, lerDelta, gruposDeCadastro };
