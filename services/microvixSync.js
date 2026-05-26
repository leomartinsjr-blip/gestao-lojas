// ── Microvix sync orchestrator ─────────────────────────────────────────────
const { fetchMovimento, fetchVendedores, parseBrNum } = require('./microvix');

// MICROVIX_LOJAS = JSON { board → cnpj (digits only) }
// e.g. {"delrey":"28519094000129","minas":"32473768000179"}
function getLojas() {
  try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); }
  catch { return {}; }
}

let lastSync      = null;
let lastError     = null;
let running       = false;
let runningHoje   = false;
let running30d    = false;
let lastSync30d   = null;

function anyRunning() { return running || runningHoje || running30d; }

function pad(n) { return String(n).padStart(2, '0'); }

function todayBRT() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())}`;
}

function daysAgoBRT(n) {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000 - n * 24 * 60 * 60 * 1000);
  return `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())}`;
}

function normName(s) {
  return (s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "DD/MM/YYYY HH:MM:SS" → "YYYY-MM-DD"
function parseDate(s) {
  const part = (s || '').slice(0, 10);
  const [d, m, y] = part.split('/');
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

async function syncStore(board, cnpj, dtIni, dtFin, employees, db) {
  const cnpjClean = cnpj.replace(/\D/g, '');
  // Allow per-board chave: MICROVIX_CHAVE_DELREY, MICROVIX_CHAVE_MINAS, etc.
  const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;

  // 1. Vendor map: cod_vendedor → normalized name
  const vendRows = await fetchVendedores(cnpjClean, chave);
  const vendMap  = {};
  for (const v of vendRows) {
    vendMap[String(v.cod_vendedor).trim()] = normName(v.nome_vendedor);
  }
  console.log(`[Microvix/${board}] ${vendRows.length} vendedores`);

  // 2. Movements for date range
  const rows = await fetchMovimento(cnpjClean, dtIni, dtFin, chave);
  console.log(`[Microvix/${board}] ${rows.length} linhas de movimento (${dtIni} → ${dtFin})`);

  if (!rows.length) return 0;

  // 3. Aggregate by vendor + date (skip cancelled)
  const agg = {};
  for (const row of rows) {
    if (row.cancelado === 'S' || row.cancelado === '1') continue;

    const codVend  = String(row.cod_vendedor || '').trim();
    const vendNorm = vendMap[codVend];
    if (!vendNorm) continue;

    const dateStr = parseDate(row.data_documento);
    if (!dateStr) continue;

    const sign = row.operacao === 'DS' ? -1 : 1; // devoluções reduzem o total
    const key = `${codVend}||${dateStr}`;
    if (!agg[key]) agg[key] = { codVend, vendNorm, date: dateStr, value: 0, pecas: 0, docs: new Set(), retDocs: new Set() };
    agg[key].value += sign * parseBrNum(row.valor_total);
    agg[key].pecas += sign * (parseInt(row.quantidade || 0, 10) || 0);
    if (sign > 0) agg[key].docs.add(row.documento);
    else agg[key].retDocs.add(row.documento);
  }

  // 4. Match employees and write
  if (!db.vsales) db.vsales = {};
  let updated = 0;

  for (const entry of Object.values(agg)) {
    const { codVend, vendNorm, date, value, pecas, docs, retDocs } = entry;
    const year  = parseInt(date.slice(0, 4));
    const month = parseInt(date.slice(5, 7));

    // Match by microvixCod (preferred) or normalized name (fallback)
    const emp = employees.find(e =>
      e.board === board && !e.inativo && e.microvixCod && String(e.microvixCod) === codVend
    ) || employees.find(e =>
      e.board === board && !e.inativo && normName(e.name) === vendNorm
    );
    if (!emp) {
      console.warn(`[Microvix/${board}] Vendedor não encontrado: cod=${codVend} nome="${vendNorm}"`);
      continue;
    }

    const vsKey = `${year}-${pad(month)}-${board}-${emp.id}`;
    if (!db.vsales[vsKey]) db.vsales[vsKey] = { meta: { mensal: 0 }, entries: {} };
    db.vsales[vsKey].entries[date] = {
      value:        parseFloat(value.toFixed(2)),
      pecas,
      atendimentos: docs.size - retDocs.size,
      syncedAt:     new Date().toISOString(),
    };
    updated++;
  }

  return updated;
}

// Retorna a data a sincronizar: hoje se já passou das 22h BRT, senão ontem
function syncTargetDate() {
  const now = new Date();
  const brtHour = new Date(now.getTime() - 3 * 60 * 60 * 1000).getUTCHours();
  const target = brtHour >= 22 ? now : new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return target.toISOString().slice(0, 10);
}

async function runSync(readDB, writeDB) {
  if (running) return { skipped: true };
  running = true;
  try {
    const lojas = getLojas();
    if (!Object.keys(lojas).length) throw new Error('MICROVIX_LOJAS não configurado.');

    const date      = syncTargetDate();
    const db        = await readDB();
    const employees = db.employees || [];
    let totalUpdated = 0;

    for (const [board, cnpj] of Object.entries(lojas)) {
      if (db.boardSettings?.[board]?.microvixSync === false) {
        console.log(`[Microvix/${board}] Auto-sync desabilitado, pulando.`);
        continue;
      }
      try {
        const updated = await syncStore(board, cnpj, date, date, employees, db);
        totalUpdated += updated;
      } catch (err) {
        console.error(`[Microvix/${board}] Erro:`, err.message);
      }
    }

    lastSync  = { at: new Date().toISOString(), updated: totalUpdated, date };
    lastError = null;
    db.microvixLastSync = lastSync;
    await writeDB(db);
    console.log(`[Microvix] Sync OK — ${totalUpdated} vendedores atualizados`);
    return lastSync;

  } catch (err) {
    lastError = err.message;
    console.error('[Microvix] Sync erro:', err.message);
    throw err;
  } finally {
    running = false;
  }
}

async function runSyncRetroativo(readDB, writeDB, dtIni, dtFin, boards) {
  if (running) throw new Error('Sync já em andamento, aguarde.');
  running = true;
  try {
    const lojas = getLojas();
    const targets = boards?.length
      ? Object.fromEntries(Object.entries(lojas).filter(([b]) => boards.includes(b)))
      : lojas;
    if (!Object.keys(targets).length) throw new Error('Nenhuma loja válida encontrada.');

    const db        = await readDB();
    const employees = db.employees || [];
    let totalUpdated = 0;

    for (const [board, cnpj] of Object.entries(targets)) {
      try {
        const updated = await syncStore(board, cnpj, dtIni, dtFin, employees, db);
        totalUpdated += updated;
        console.log(`[Microvix] Retroativo ${board}: ${updated} entradas atualizadas`);
      } catch (err) {
        console.error(`[Microvix/${board}] Erro retroativo:`, err.message);
      }
    }

    await writeDB(db);
    const result = { at: new Date().toISOString(), updated: totalUpdated, dtIni, dtFin, boards: Object.keys(targets) };
    lastSync  = result;
    lastError = null;
    console.log(`[Microvix] Sync retroativo OK — ${totalUpdated} entradas atualizadas`);
    return result;

  } catch (err) {
    lastError = err.message;
    throw err;
  } finally {
    running = false;
  }
}

// Sync only today (BRT), always — used for the intraday faturamento card
async function runSyncHoje(readDB, writeDB) {
  if (anyRunning()) return { skipped: true };
  runningHoje = true;
  try {
    const lojas = getLojas();
    if (!Object.keys(lojas).length) throw new Error('MICROVIX_LOJAS não configurado.');

    const date      = todayBRT();
    const db        = await readDB();
    const employees = db.employees || [];
    let totalUpdated = 0;

    for (const [board, cnpj] of Object.entries(lojas)) {
      if (db.boardSettings?.[board]?.microvixSync === false) {
        continue;
      }
      try {
        const updated = await syncStore(board, cnpj, date, date, employees, db);
        totalUpdated += updated;
      } catch (err) {
        console.error(`[Microvix/hoje/${board}] Erro:`, err.message);
      }
    }

    await writeDB(db);
    console.log(`[Microvix/hoje] OK — ${totalUpdated} entradas em ${date}`);
    return { at: new Date().toISOString(), updated: totalUpdated, date };
  } catch (err) {
    console.error('[Microvix/hoje] Erro:', err.message);
    throw err;
  } finally {
    runningHoje = false;
  }
}

// Daily retroactive sync for last 30 days — catches cancellations, reversals, salesperson changes
async function runSync30Dias(readDB, writeDB) {
  if (anyRunning()) return { skipped: true };
  running30d = true;
  try {
    const lojas = getLojas();
    if (!Object.keys(lojas).length) throw new Error('MICROVIX_LOJAS não configurado.');

    const dtIni = daysAgoBRT(30);
    const dtFin = todayBRT();
    const db        = await readDB();
    const employees = db.employees || [];
    let totalUpdated = 0;

    for (const [board, cnpj] of Object.entries(lojas)) {
      if (db.boardSettings?.[board]?.microvixSync === false) {
        console.log(`[Microvix/30d/${board}] Auto-sync desabilitado, pulando.`);
        continue;
      }
      try {
        const updated = await syncStore(board, cnpj, dtIni, dtFin, employees, db);
        totalUpdated += updated;
        console.log(`[Microvix/30d/${board}] ${updated} entradas atualizadas`);
      } catch (err) {
        console.error(`[Microvix/30d/${board}] Erro:`, err.message);
      }
    }

    await writeDB(db);
    lastSync30d = { at: new Date().toISOString(), updated: totalUpdated, dtIni, dtFin };
    console.log(`[Microvix/30d] OK — ${totalUpdated} entradas, ${dtIni} → ${dtFin}`);
    return lastSync30d;
  } catch (err) {
    console.error('[Microvix/30d] Erro:', err.message);
    throw err;
  } finally {
    running30d = false;
  }
}

function getStatus() {
  return { lastSync, lastError, running, lastSync30d, runningHoje, running30d };
}

function setLastSync(val) {
  if (val && val.at) lastSync = val;
}

module.exports = { runSync, runSyncHoje, runSync30Dias, runSyncRetroativo, getStatus, setLastSync };
