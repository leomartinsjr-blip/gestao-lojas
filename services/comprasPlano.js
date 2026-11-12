'use strict';
// Planejamento de compras por coleção — o mesmo quadro das planilhas
// "PEDIDOS S27/W27 NOVO (PLANEJAMENTO)" do Leonardo, montado com dados do Microvix.
//
// Por loja, uma linha por marca (abre nos setores):
//   % venda         venda da marca nos últimos N dias (30/60/90) ÷ venda da loja (ou digitado)
//   cota compra     previsão de venda × CMV, rateada pelo % (÷ Σ%)
//   realizado       itens dos pedidos de compra (LinxPedidosCompra) com entrega no período
//                   da coleção, sem cancelados, a custo (+ ajuste digitado)
//   pendente        pedido − entregue (o Microvix baixa ao receber); encerrado = 0 (+ ajuste)
//   estoque         saldo × custo médio (LinxProdutosDetalhes)
//   estoque mínimo  venda média ÷ markup × cobertura (Nx), rateado pelo %
//   necessidade     cota + mínimo − estoque
//   saldo p/ comprar necessidade − pendente
//   fat. mensal     (previsão ÷ meses) × % ÷ markup  (a custo)
//   cobertura       (estoque − mínimo) ÷ fat. mensal; c/ pendente soma o pendente
//   previsão sobra  pendente + estoque − fat. mensal × meses
//
// Período da coleção (regra do Leonardo, 12/11/2026), para venda e pedidos:
//   WINTER AA = fev a jul de 20AA · SUMMER AA = ago de 20AA-1 a jan de 20AA

const LOJAS = ['delrey', 'minas', 'contagem', 'estacao'];
const PADRAO = { cmv: 42.9, cobertura: 4, dias: 90 };
const r2 = v => Math.round((v || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const num = s => { const t = String(s ?? '').trim(); if (!t) return 0; const v = parseFloat(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(v) ? v : 0; };
const data = s => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s || '').slice(0, 10); };
const addDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function periodo(colecao) {
  const m = String(colecao || '').toUpperCase().match(/(SUMMER|WINTER)\s*(\d{2})/);
  if (!m) return null;
  const ano = 2000 + +m[2];
  return m[1] === 'WINTER'
    ? { tipo: 'WINTER', ini: `${ano}-02-01`, fim: `${ano}-07-31` }
    : { tipo: 'SUMMER', ini: `${ano - 1}-08-01`, fim: `${ano}-01-31` };
}
// Coleção em que a data cai, e a lista para o seletor (2 antes, 2 depois)
function colecaoDe(d) {
  const [y, mo] = d.split('-').map(Number);
  if (mo >= 2 && mo <= 7) return `WINTER ${String(y % 100).padStart(2, '0')}`;
  return `SUMMER ${String((mo >= 8 ? y + 1 : y) % 100).padStart(2, '0')}`;
}
function colecoesPerto(hoje) {
  const atual = colecaoDe(hoje);
  let c = atual;
  for (let i = 0; i < 2; i++) c = colecaoDe(addDias(periodo(c).ini, -1));
  const lista = [];
  for (let i = 0; i < 5; i++) { lista.push(c); c = colecaoDe(addDias(periodo(c).fim, 1)); }
  return { atual, lista };
}
// Meses do período que ainda faltam (o mês atual conta inteiro)
function mesesRestantes(per, hoje) {
  const out = [];
  let [y, m] = per.ini.split('-').map(Number);
  const [fy, fm] = per.fim.split('-').map(Number);
  const [hy, hm] = hoje.split('-').map(Number);
  while (y * 12 + m <= fy * 12 + fm) {
    if (y * 12 + m >= hy * 12 + hm) out.push([y, m]);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// ── Leitura do Microvix (com cache em memória) ───────────────────────────
const cache = new Map();
async function comCache(chave, ttlMs, fn, forcar) {
  const c = cache.get(chave);
  if (!forcar && c && Date.now() - c.em < ttlMs) return c.v;
  const v = await fn();
  cache.set(chave, { em: Date.now(), v });
  return v;
}

function criarLeitura({ microvix, getCatalog, lojasEnv }) {
  const cnpjDe = b => String(lojasEnv()[b] || '').replace(/\D/g, '');
  const chaveDe = b => process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  const infoDe = (cat, cod, barra) => cat[cod] || cat[barra] || {};
  const chaveMS = info => [(info.marca || '(sem marca)').trim().toUpperCase(), (info.setor || '(sem setor)').trim().toUpperCase()];

  // Venda por marca/setor (mesmos filtros do Relatório de Marcas)
  async function vendas(b, dtIni, dtFin, forcar) {
    return comCache(`v|${b}|${dtIni}|${dtFin}`, 3 * 3600e3, async () => {
      const [rows, cat] = await Promise.all([microvix.fetchMovimento(cnpjDe(b), dtIni, dtFin, chaveDe(b)), getCatalog()]);
      const out = {};
      for (const row of rows) {
        if (row.cancelado === 'S' || row.cancelado === '1' || row.excluido === 'S' || row.soma_relatorio === 'N') continue;
        const op = String(row.operacao || '').toUpperCase(), serie = String(row.serie || row.serie_documento || row.num_serie || '').trim();
        if (op !== 'S' && op !== 'DS') continue;
        if (serie === '999' || serie === 'J' || (serie === '4' && op !== 'DS')) continue;
        const cod = String(row.cod_produto || '').replace(/\.0+$/, '').trim();
        if (!cod) continue;
        const [m, s] = chaveMS(infoDe(cat, cod, String(row.cod_barra || '').replace(/\.0+$/, '').trim()));
        const v = (op === 'DS' ? -1 : 1) * num(row.valor_total);
        ((out[m] ||= {})[s] = (out[m][s] || 0) + v);
      }
      return out;
    }, forcar);
  }

  // Estoque a custo médio por marca/setor
  async function estoque(b, hoje, forcar) {
    return comCache(`e|${b}|${hoje}`, 3600e3, async () => {
      const cat = await getCatalog();
      const out = {};
      let ts = 0;
      for (let p = 0; p < 80; p++) {
        const raw = await microvix.postRequest(microvix.buildRequest('LinxProdutosDetalhes', cnpjDe(b), [
          { id: 'timestamp', valor: String(ts) }, { id: 'data_mov_ini', valor: '2000-01-01' }, { id: 'data_mov_fim', valor: hoje },
        ], chaveDe(b)), 90_000);
        if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) throw new Error((raw.match(/<Message>([^<]+)/) || [])[1] || 'Microvix recusou LinxProdutosDetalhes');
        const rows = microvix.parseCsv(raw);
        if (!rows.length) break;
        for (const r of rows) {
          const q = num(r.quantidade);
          if (q <= 0) continue;
          const [m, s] = chaveMS(infoDe(cat, String(r.cod_produto || '').trim(), String(r.cod_barra || '').trim()));
          ((out[m] ||= {})[s] = (out[m][s] || 0) + q * num(r.custo_medio || r.preco_custo));
        }
        const mx = Math.max(...rows.map(r => +r.timestamp || 0));
        if (mx <= ts) break;
        ts = mx;
      }
      return out;
    }, forcar);
  }

  // Itens dos pedidos de compra com pedido nos últimos 14 meses
  async function pedidos(b, hoje, forcar) {
    return comCache(`p|${b}|${hoje}`, 1800e3, async () => {
      const cat = await getCatalog();
      const itens = [];
      let ts = 0;
      for (let p = 0; p < 80; p++) {
        const raw = await microvix.postRequest(microvix.buildRequest('LinxPedidosCompra', cnpjDe(b), [
          { id: 'timestamp', valor: String(ts) }, { id: 'data_inicial', valor: addDias(hoje, -430) }, { id: 'data_fim', valor: addDias(hoje, 1) },
        ], chaveDe(b)), 90_000);
        if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) throw new Error((raw.match(/<Message>([^<]+)/) || [])[1] || 'Microvix recusou LinxPedidosCompra');
        const rows = microvix.parseCsv(raw);
        if (!rows.length) break;
        for (const r of rows) {
          if (r.cancelado === 'S') continue;
          const cod = String(r.cod_produto || '').trim();
          const info = infoDe(cat, cod, '');
          const [m, s] = chaveMS(info);
          const q = num(r.quantidade), ent = Math.min(q, num(r.qtde_entregue)), u = num(r.valor_unitario);
          itens.push({ pedido: String(r.cod_pedido), data: data(r.data_pedido), entrega: data(r.previsao_entrega), fornecedor: String(r.codigo_fornecedor || ''),
            marca: m, setor: s, colecao: (info.linha || '').toUpperCase(), plano: String(r.plano_pagamento || '').replace(/\s+/g, ' ').trim(),
            valor: r2(q * u), entregue: r2(ent * u), pendente: r.encerrado === 'S' ? 0 : r2((q - ent) * u), encerrado: r.encerrado === 'S' });
        }
        const mx = Math.max(...rows.map(r => +r.timestamp || 0));
        if (rows.length < 1000 || mx <= ts) break;
        ts = mx;
      }
      return itens;
    }, forcar);
  }
  return { vendas, estoque, pedidos };
}

// ── O quadro (função pura) ───────────────────────────────────────────────
// vendas/estoque: { MARCA: { SETOR: valor } } · itens: pedidos já filtrados do período
// prem: { previsao, meses, cmv, cobertura, vendaMedia } · pct: { MARCA: 0..1 digitado }
// ajustes: { MARCA: { realizado, pendente } }
function montarLoja({ vendas, estoque, itens, prem, pct = {}, ajustes = {} }) {
  const marcas = new Set([...Object.keys(vendas), ...Object.keys(estoque), ...itens.map(i => i.marca), ...Object.keys(pct), ...Object.keys(ajustes)]);
  const soma = o => Object.values(o || {}).reduce((s, v) => s + v, 0);
  const vendaTotal = Object.values(vendas).reduce((s, o) => s + Math.max(0, soma(o)), 0);
  const markup = 100 / (prem.cmv || PADRAO.cmv);
  const cotaTotal = (prem.previsao || 0) * (prem.cmv || PADRAO.cmv) / 100;
  const minimoTotal = (prem.vendaMedia || 0) / markup * (prem.cobertura || 0);
  const mediaMensal = prem.meses ? (prem.previsao || 0) / prem.meses : 0;

  const base = [...marcas].map(m => {
    const setores = new Set([...Object.keys(vendas[m] || {}), ...Object.keys(estoque[m] || {}), ...itens.filter(i => i.marca === m).map(i => i.setor)]);
    const doSetor = s => {
      const its = itens.filter(i => i.marca === m && i.setor === s);
      return { setor: s, venda: r2(vendas[m]?.[s] || 0), estoque: r2(estoque[m]?.[s] || 0),
        realizado: r2(its.reduce((t, i) => t + i.valor, 0)), pendente: r2(its.reduce((t, i) => t + i.pendente, 0)) };
    };
    const ss = [...setores].map(doSetor).sort((a, b) => b.venda - a.venda || b.estoque - a.estoque);
    const venda = r2(ss.reduce((t, s) => t + s.venda, 0));
    const aj = ajustes[m] || {};
    return { marca: m, setores: ss, venda, pctVenda: vendaTotal > 0 ? Math.max(0, venda) / vendaTotal : 0,
      pctDigitado: pct[m] != null ? pct[m] : null,
      estoque: r2(ss.reduce((t, s) => t + s.estoque, 0)),
      realizadoMx: r2(ss.reduce((t, s) => t + s.realizado, 0)), pendenteMx: r2(ss.reduce((t, s) => t + s.pendente, 0)),
      ajRealizado: num(aj.realizado), ajPendente: num(aj.pendente) };
  });
  for (const x of base) x.pct = x.pctDigitado != null ? x.pctDigitado : x.pctVenda;
  const somaPct = base.reduce((t, x) => t + x.pct, 0) || 1;

  const linhas = base.map(x => {
    const peso = x.pct / somaPct;
    const realizado = r2(x.realizadoMx + x.ajRealizado), pendente = r2(x.pendenteMx + x.ajPendente);
    const cota = cotaTotal * peso, minimo = minimoTotal * peso, fat = mediaMensal * x.pct / markup;
    const necessidade = cota + minimo - x.estoque;
    const l = { ...x, realizado, pendente, cota: r2(cota), minimo: r2(minimo), necessidade: r2(necessidade),
      saldoComprar: r2(necessidade - pendente), entregue: realizado > 0 ? (realizado - pendente) / realizado : null,
      fatMensal: r2(fat), cobertura: fat > 0 ? (x.estoque - minimo) / fat : null,
      coberturaPend: fat > 0 ? (pendente + x.estoque - minimo) / fat : null,
      sobra: r2(pendente + x.estoque - fat * (prem.meses || 0)) };
    // Setores: mesmas contas, com o peso do setor na venda da marca (ou no estoque, sem venda)
    const totV = x.setores.reduce((t, s) => t + Math.max(0, s.venda), 0), totE = x.setores.reduce((t, s) => t + s.estoque, 0);
    l.setores = x.setores.map(s => {
      const ps = totV > 0 ? Math.max(0, s.venda) / totV : totE > 0 ? s.estoque / totE : 0;
      const sc = cota * ps, sm = minimo * ps, sf = fat * ps, sn = sc + sm - s.estoque;
      return { ...s, pct: x.pct * ps, cota: r2(sc), minimo: r2(sm), necessidade: r2(sn), saldoComprar: r2(sn - s.pendente),
        fatMensal: r2(sf), cobertura: sf > 0 ? (s.estoque - sm) / sf : null, coberturaPend: sf > 0 ? (s.pendente + s.estoque - sm) / sf : null,
        sobra: r2(s.pendente + s.estoque - sf * (prem.meses || 0)) };
    });
    return l;
  }).filter(l => l.pct > 0 || l.estoque > 0.5 || l.realizado > 0.5 || l.pendente > 0.5)
    .sort((a, b) => b.pct - a.pct || b.estoque - a.estoque);

  const tot = k => r2(linhas.reduce((t, l) => t + (l[k] || 0), 0));
  const total = { pct: linhas.reduce((t, l) => t + l.pct, 0), venda: tot('venda'), cota: tot('cota'), realizado: tot('realizado'), pendente: tot('pendente'),
    estoque: tot('estoque'), minimo: tot('minimo'), necessidade: tot('necessidade'), saldoComprar: tot('saldoComprar'), fatMensal: tot('fatMensal'), sobra: tot('sobra') };
  total.entregue = total.realizado > 0 ? (total.realizado - total.pendente) / total.realizado : null;
  const alertas = {
    pendMaior: linhas.filter(l => l.pendente > l.realizado + 0.5).map(l => l.marca),
    semEstoque: linhas.filter(l => l.pct > 0 && l.estoque < 0.5).map(l => l.marca),
  };
  return { linhas, total, calc: { markup, cotaTotal: r2(cotaTotal), minimoTotal: r2(minimoTotal), mediaMensal: r2(mediaMensal), vendaTotal: r2(vendaTotal) }, alertas };
}

// ── Rotas ────────────────────────────────────────────────────────────────
function register(app, { getDb, readDB, requireAdmin, microvix, getCatalog, criarProjecao, hojeBRT, boardsLabel = {} }) {
  const lojasEnv = () => JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const ler = criarLeitura({ microvix, getCatalog, lojasEnv });
  let memoria = {};
  const lerPlano = async id => { const db = getDb(); return (db ? await db.collection('comprasPlano').findOne({ _id: id }) : memoria[id]) || {}; };
  const gravarPlano = async (id, set) => {
    const db = getDb();
    if (db) await db.collection('comprasPlano').updateOne({ _id: id }, { $set: { ...set, em: new Date() } }, { upsert: true });
    else memoria[id] = { ...(memoria[id] || {}), ...set };
  };

  // Previsão padrão: projeção do Dash (a mesma do Fluxo) nos meses que faltam da coleção
  function previsaoPadrao(dbJson, b, meses, hoje) {
    const pj = criarProjecao(dbJson, b, hoje);
    return Math.round(meses.reduce((t, [y, m]) => t + (pj.projMes(y, m) || 0), 0));
  }

  app.get('/api/compras-plano', requireAdmin, async (req, res) => {
    try {
      const hoje = hojeBRT();
      const { atual, lista } = colecoesPerto(hoje);
      const colecao = String(req.query.colecao || atual).toUpperCase();
      const per = periodo(colecao);
      if (!per) return res.status(400).json({ error: 'coleção inválida (ex.: SUMMER 27)' });
      const dias = [30, 60, 90].includes(+req.query.dias) ? +req.query.dias : PADRAO.dias;
      const forcar = req.query.atualizar === '1';
      const lojas = LOJAS.filter(b => lojasEnv()[b]);
      const meses = mesesRestantes(per, hoje);
      const dtFin = addDias(hoje, -1), dtIni = addDias(hoje, -dias);
      const dbJson = await readDB();

      const porLoja = {}, erros = [];
      await Promise.all(lojas.map(async b => {
        const [v, e, p, plano] = await Promise.all([
          ler.vendas(b, dtIni, dtFin, forcar).catch(err => { erros.push(`${b} venda: ${err.message}`); return {}; }),
          ler.estoque(b, hoje, forcar).catch(err => { erros.push(`${b} estoque: ${err.message}`); return {}; }),
          ler.pedidos(b, hoje, forcar).catch(err => { erros.push(`${b} pedidos: ${err.message}`); return []; }),
          lerPlano(`${colecao}|${b}`),
        ]);
        // Pedido entra na coleção pela previsão de entrega (sem previsão, pela data do pedido)
        const itens = p.filter(i => { const d = i.entrega || i.data; return d >= per.ini && d <= per.fim; });
        const vendaPeriodo = Object.values(v).reduce((t, o) => t + Object.values(o).reduce((s, x) => s + x, 0), 0);
        const padrao = {
          previsao: meses.length ? previsaoPadrao(dbJson, b, meses, hoje) : 0, meses: meses.length,
          cmv: PADRAO.cmv, cobertura: PADRAO.cobertura, vendaMedia: Math.round(vendaPeriodo / (dias / 30)),
        };
        const digit = plano.premissas || {};
        const prem = Object.fromEntries(Object.keys(padrao).map(k => [k, digit[k] != null ? digit[k] : padrao[k]]));
        porLoja[b] = { ...montarLoja({ vendas: v, estoque: e, itens, prem, pct: plano.pct || {}, ajustes: plano.ajustes || {} }),
          premissas: prem, padrao, digitado: digit, pedidos: itens.length };
      }));
      res.json({ colecao, colecoes: lista, periodo: per, meses: meses.map(([y, m]) => `${y}-${pad(m)}`), dias, hoje, venda: { dtIni, dtFin },
        lojas, labels: Object.fromEntries(lojas.map(b => [b, boardsLabel[b] || b])), porLoja, erros });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT { colecao, loja, premissa: { campo: valor|null } } | { pct: { MARCA: 0..1|null } } | { ajuste: { MARCA: { realizado, pendente } } }
  app.put('/api/compras-plano', requireAdmin, async (req, res) => {
    try {
      const { colecao, loja } = req.body || {};
      if (!periodo(colecao) || !LOJAS.includes(loja)) return res.status(400).json({ error: 'coleção ou loja inválida' });
      const id = `${String(colecao).toUpperCase()}|${loja}`;
      const atual = await lerPlano(id);
      const set = {};
      if (req.body.premissa) {
        const p = { ...(atual.premissas || {}) };
        for (const [k, v] of Object.entries(req.body.premissa)) {
          if (!['previsao', 'meses', 'cmv', 'cobertura', 'vendaMedia'].includes(k)) continue;
          if (v === null || v === '') delete p[k]; else if (Number.isFinite(+v)) p[k] = +v;
        }
        set.premissas = p;
      }
      if (req.body.pct) {
        const p = { ...(atual.pct || {}) };
        for (const [k, v] of Object.entries(req.body.pct)) { if (v === null || v === '') delete p[k]; else if (Number.isFinite(+v)) p[k] = +v; }
        set.pct = p;
      }
      if (req.body.ajuste) {
        const a = { ...(atual.ajustes || {}) };
        for (const [k, v] of Object.entries(req.body.ajuste)) {
          const x = { realizado: num(v?.realizado), pendente: num(v?.pendente) };
          if (!x.realizado && !x.pendente) delete a[k]; else a[k] = x;
        }
        set.ajustes = a;
      }
      await gravarPlano(id, set);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register, montarLoja, periodo, colecaoDe, colecoesPerto, mesesRestantes, LOJAS };
