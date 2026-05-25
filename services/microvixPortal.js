// Puppeteer scraper — portal Linx Microvix → Faturas a Pagar
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const path      = require('path');
const fs        = require('fs');

const PORTAL_URL = 'https://linx.microvix.com.br/v4/home/index.asp';
const DEBUG_DIR  = path.join(require('os').tmpdir(), 'mx-portal-debug');

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-zygote', '--single-process', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

let _log = [];
function log(msg) { _log.push(`[${new Date().toISOString().slice(11,19)}] ${msg}`); console.log('[MxPortal]', msg); }

async function screenshot(page, name) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true });
    log(`Screenshot salvo: ${name}.png`);
  } catch (_) {}
}

// Pega o frame certo — portais ASP antigos usam frameset
async function getWorkFrame(page) {
  await new Promise(r => setTimeout(r, 800));
  const frames = page.frames();
  log(`Frames encontrados: ${frames.length} — ${frames.map(f => f.name() || f.url().split('/').pop()).join(', ')}`);
  // Prioriza frame com "main", "conteudo", "principal" no nome/url
  const priority = ['main', 'conteudo', 'principal', 'centro', 'content', 'corpo'];
  for (const p of priority) {
    const f = frames.find(f => f.name().toLowerCase().includes(p) || f.url().toLowerCase().includes(p));
    if (f) return f;
  }
  return frames[frames.length - 1] || page.mainFrame();
}

// Clica em elemento pelo texto (verifica page + todos os frames)
async function clickByText(page, text, timeout = 5000) {
  const escaped = text.replace(/'/g, "\\'");
  const xpath   = `//*[contains(normalize-space(text()), '${escaped}') or contains(@title, '${escaped}') or contains(@value, '${escaped}')]`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const ctx of [page, ...page.frames()]) {
      try {
        const [el] = await ctx.$x(xpath);
        if (el) {
          await el.click();
          log(`Clicou: "${text}"`);
          await new Promise(r => setTimeout(r, 600));
          return true;
        }
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }
  log(`AVISO: não encontrou "${text}" para clicar`);
  return false;
}

// Preenche campo por name/id/placeholder em qualquer frame
async function fillField(page, selector, value) {
  for (const ctx of [page, ...page.frames()]) {
    try {
      const el = await ctx.$(selector);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(String(value), { delay: 30 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Extrai tabela HTML de qualquer frame
async function extractTable(page) {
  for (const ctx of [page, ...page.frames()]) {
    try {
      const rows = await ctx.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return null;
        const headers = [...tbl.querySelectorAll('th, tr:first-child td')].map(c => c.innerText.trim());
        const data = [...tbl.querySelectorAll('tr')].slice(1).map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.innerText.trim())
        ).filter(r => r.some(c => c));
        return { headers, data };
      });
      if (rows && rows.data && rows.data.length > 0) {
        log(`Tabela encontrada no frame "${ctx.name()}" — ${rows.data.length} linhas`);
        return rows;
      }
    } catch (_) {}
  }
  return null;
}

// Converte tabela bruta em array de objetos normalizados
function normalizeRows(table, dtIni, dtFin, hoje) {
  if (!table) return [];
  const { headers, data } = table;

  // Mapeia colunas por nome aproximado
  const idx = name => headers.findIndex(h => h.toLowerCase().includes(name));
  const iForn  = idx('fornec') >= 0 ? idx('fornec') : idx('emitente') >= 0 ? idx('emitente') : idx('nome');
  const iDoc   = idx('document') >= 0 ? idx('document') : idx('nf') >= 0 ? idx('nf') : idx('nota') >= 0 ? idx('nota') : idx('numero');
  const iVenc  = idx('vencim');
  const iEmis  = idx('emiss');
  const iVal   = idx('valor');
  const iPago  = idx('pago') >= 0 ? idx('pago') : idx('baixado');

  return data.map(r => {
    const vencStr = parsePortalDate(r[iVenc] ?? '');
    const paid    = (r[iPago] ?? '').replace(/\D/g,'') > 0 || String(r[iVal+1] ?? '').trim() === '0,00';
    const status  = paid ? 'pago' : (vencStr && vencStr < hoje ? 'vencido' : 'aberto');
    return {
      fornecedor: r[iForn] ?? '',
      documento:  r[iDoc]  ?? '',
      emissao:    parsePortalDate(r[iEmis] ?? ''),
      vencimento: vencStr,
      valor:      parseBRL(r[iVal] ?? '0'),
      status,
      _raw: r,
    };
  }).filter(r => r.valor > 0 || r.documento);
}

function parsePortalDate(s) {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function parseBRL(s) {
  return parseFloat(String(s).replace(/\./g,'').replace(',','.')) || 0;
}

// ── Função principal ───────────────────────────────────────────────────────
async function scrapeContasPagar(dtIni, dtFin) {
  _log = [];
  const user = process.env.MICROVIX_PORTAL_USER;
  const pass = process.env.MICROVIX_PORTAL_PASS;
  if (!user || !pass) throw new Error('Variáveis MICROVIX_PORTAL_USER e MICROVIX_PORTAL_PASS não configuradas no Render');

  const today = new Date().toISOString().slice(0, 10);
  chromium.setGraphicsMode = false;
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    headless: chromium.headless,
    executablePath: execPath,
    args: [...chromium.args, ...LAUNCH_ARGS],
    timeout: 60000,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 900 });

    // ── 1. Login ───────────────────────────────────────────────────────────
    log('Abrindo portal…');
    // Ignora timeout de navegação — portais ASP ficam em polling e nunca "terminam"
    page.goto(PORTAL_URL).catch(() => {});
    // Aguarda campo de login aparecer (até 45s)
    const userSel = 'input[name="login"], input[name="usuario"], input[name="username"], input[type="text"]:not([type="hidden"])';
    const passSel = 'input[name="senha"], input[name="password"], input[type="password"]';
    try {
      await page.waitForSelector(userSel, { timeout: 45000 });
    } catch (e) {
      await screenshot(page, '01-timeout');
      throw new Error(`Portal não carregou campo de login em 45s. URL atual: ${page.url()}`);
    }
    await screenshot(page, '01-login-page');

    await fillField(page, userSel, user);
    await fillField(page, passSel, pass);
    log('Credenciais preenchidas, fazendo login…');

    page.keyboard.press('Enter').catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    await screenshot(page, '02-after-login');

    // ── 2. Navegar até Faturas a Pagar ─────────────────────────────────────
    log('Navegando para Financeiro…');
    await clickByText(page, 'Financeiro', 8000);
    await screenshot(page, '03-financeiro');

    await clickByText(page, 'Contas a Pagar', 8000);
    await screenshot(page, '04-contas-pagar');

    await clickByText(page, 'Relatórios', 6000);
    await screenshot(page, '05-relatorios');

    await clickByText(page, 'Faturas a Pagar', 6000);
    await new Promise(r => setTimeout(r, 1500));
    await screenshot(page, '06-faturas-pagar');

    // ── 3. Preencher filtros de data ───────────────────────────────────────
    const dIni = dtIni.split('-').reverse().join('/');
    const dFin = dtFin.split('-').reverse().join('/');

    const dateSelectors = [
      'input[name="dtInicio"]', 'input[name="dtIni"]', 'input[name="dataInicial"]',
      'input[name="data_ini"]', 'input[id*="Ini"]', 'input[id*="ini"]',
    ];
    const dateFimSelectors = [
      'input[name="dtFim"]', 'input[name="dtFin"]', 'input[name="dataFinal"]',
      'input[name="data_fim"]', 'input[id*="Fim"]', 'input[id*="fim"]',
    ];

    for (const s of dateSelectors) { if (await fillField(page, s, dIni)) { log(`Data início: ${dIni}`); break; } }
    for (const s of dateFimSelectors) { if (await fillField(page, s, dFin)) { log(`Data fim: ${dFin}`); break; } }

    // Clicar em pesquisar/consultar/filtrar
    const searched = await clickByText(page, 'Pesquisar') ||
                     await clickByText(page, 'Consultar') ||
                     await clickByText(page, 'Filtrar')   ||
                     await clickByText(page, 'Buscar');
    if (searched) await new Promise(r => setTimeout(r, 2000));
    await screenshot(page, '07-resultado');

    // ── 4. Extrair dados ───────────────────────────────────────────────────
    log('Extraindo tabela…');
    const table = await extractTable(page);

    if (!table) {
      await screenshot(page, '08-no-table');
      log('Tabela não encontrada na página.');
      return { rows: [], logs: _log, warning: 'Tabela não localizada — verifique screenshots em /api/contas-pagar/debug' };
    }

    log(`Headers: ${table.headers.join(' | ')}`);
    const rows = normalizeRows(table, dtIni, dtFin, today);
    log(`Total extraído: ${rows.length} faturas`);

    return { rows, logs: _log };

  } finally {
    await browser.close().catch(() => {});
  }
}

// Retorna path dos screenshots de debug
function getDebugScreenshots() {
  if (!fs.existsSync(DEBUG_DIR)) return [];
  return fs.readdirSync(DEBUG_DIR).filter(f => f.endsWith('.png')).sort().map(f => ({
    name: f,
    path: path.join(DEBUG_DIR, f),
    mtime: fs.statSync(path.join(DEBUG_DIR, f)).mtime,
  }));
}

module.exports = { scrapeContasPagar, getDebugScreenshots };
