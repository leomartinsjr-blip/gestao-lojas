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

// ── Pedidos e parcelas (funções puras) ───────────────────────────────────
// Prazo do plano do Microvix: "COMPRA 3X" → 30/60/90 dias da entrega
function diasDoPlano(plano) {
  const n = +((String(plano || '').match(/(\d+)\s*X/i) || [])[1] || 1);
  return Array.from({ length: Math.min(Math.max(n, 1), 12) }, (_, i) => 30 * (i + 1)).join('/');
}
const lerDias = s => String(s || '').split(/[\/;,\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 720);

// itens: do Microvix (já com marca/setor) · ajustes: { 'b|pedido': { entrega, dias, ignorar } }
// manuais: [{ _id, loja, marca, setor, valor, entrega, dias, obs, recebido }]
// Devolve os pedidos da loja, cada item com a entrega efetiva (a digitada vence a do Microvix).
function juntarPedidos(b, itens, ajustes = {}, manuais = []) {
  const ped = new Map();
  for (const i of itens) {
    const k = `${b}|${i.pedido}`, aj = ajustes[k] || {};
    const p = ped.get(k) || { b, pedido: i.pedido, data: i.data, fornecedor: i.fornecedor, plano: i.plano, itens: [], manual: false,
      entregaDig: aj.entrega || null, diasDig: aj.dias || null, ignorar: !!aj.ignorar };
    p.itens.push({ ...i, entrega: aj.entrega || i.entrega || i.data });
    ped.set(k, p);
  }
  for (const m of manuais.filter(x => x.loja === b)) {
    const valor = Number(m.valor) || 0;
    ped.set(`${b}|M-${m._id}`, { b, pedido: `M-${m._id}`, id: String(m._id), data: m.criado || m.entrega, fornecedor: '', plano: '', manual: true, obs: m.obs || '', setor: String(m.setor || '').toUpperCase(),
      entregaDig: m.entrega, diasDig: m.dias || null, ignorar: false, recebido: !!m.recebido,
      itens: [{ pedido: `M-${m._id}`, marca: String(m.marca || '').toUpperCase(), setor: String(m.setor || '(sem setor)').toUpperCase(), entrega: m.entrega,
        valor, entregue: m.recebido ? valor : 0, pendente: m.recebido ? 0 : valor }] });
  }
  return [...ped.values()].map(p => {
    const soma = k => r2(p.itens.reduce((t, i) => t + (i[k] || 0), 0));
    const entregas = [...new Set(p.itens.map(i => i.entrega).filter(Boolean))].sort();
    const marcas = [...new Set(p.itens.map(i => i.marca))];
    return { ...p, valor: soma('valor'), entregue: soma('entregue'), pendente: soma('pendente'), entrega: entregas[0] || p.data,
      entregas, marcas, diasPadrao: p.manual ? '30' : diasDoPlano(p.plano), dias: p.diasDig || (p.manual ? '30' : diasDoPlano(p.plano)) };
  });
}

// Parcelas do que falta entregar: cada entrega pendente dividida pelos dias do prazo.
// Entrega que já passou e segue pendente conta a partir de hoje.
function parcelasDoPedido(p, hoje) {
  if (p.ignorar || p.pendente < 0.5) return [];
  const dias = lerDias(p.dias);
  if (!dias.length) return [];
  const porEntrega = {};
  for (const i of p.itens) if (i.pendente > 0) porEntrega[i.entrega || hoje] = (porEntrega[i.entrega || hoje] || 0) + i.pendente;
  const out = [];
  for (const [ent, v] of Object.entries(porEntrega)) {
    const base = ent < hoje ? hoje : ent;
    const parte = r2(v / dias.length);
    dias.forEach((d, i) => out.push({ d: addDias(base, d), valor: i === dias.length - 1 ? r2(v - parte * (dias.length - 1)) : parte }));
  }
  return out.sort((a, c) => a.d.localeCompare(c.d));
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

  const col = nome => { const db = getDb(); return db ? db.collection(nome) : null; };
  memoria.pedAjustes ||= {}; memoria.manuais ||= [];
  async function ajustesPedidos() {
    const c = col('comprasPedidos');
    if (!c) return memoria.pedAjustes;
    return Object.fromEntries((await c.find().toArray()).map(x => [x._id, x]));
  }
  async function manuaisLista() { const c = col('comprasManuais'); return c ? c.find().toArray() : memoria.manuais; }
  // Pedidos da loja (Microvix + manuais) com entrega e prazo efetivos
  async function pedidosLoja(b, hoje, forcar, aj, man) {
    const itens = await ler.pedidos(b, hoje, forcar);
    return juntarPedidos(b, itens, aj || await ajustesPedidos(), man || await manuaisLista());
  }
  // Parcelas pendentes de todas as lojas, gravadas para o Fluxo de Caixa ler sem ir ao Microvix
  let gravando = null;
  async function atualizarParcelas(forcar) {
    if (gravando) return gravando;
    gravando = (async () => {
      const hoje = hojeBRT(), [aj, man] = await Promise.all([ajustesPedidos(), manuaisLista()]);
      const lista = [];
      for (const b of LOJAS.filter(x => lojasEnv()[x])) {
        for (const p of await pedidosLoja(b, hoje, forcar, aj, man))
          for (const x of parcelasDoPedido(p, hoje))
            lista.push({ b, d: x.d, valor: x.valor, pedido: p.pedido, marca: p.marcas.slice(0, 3).join('/') || '(sem marca)' });
      }
      const doc = { _id: 'atual', em: new Date(), lista };
      const c = col('comprasParcelas');
      if (c) await c.replaceOne({ _id: 'atual' }, doc, { upsert: true }); else memoria.parcelas = doc;
      return doc;
    })().finally(() => { gravando = null; });
    return gravando;
  }
  // Para o Fluxo: lê o gravado; se tiver mais de 12 h, recalcula em segundo plano
  async function parcelasPrevistas() {
    const c = col('comprasParcelas');
    const doc = c ? await c.findOne({ _id: 'atual' }) : memoria.parcelas;
    if (!doc || Date.now() - new Date(doc.em) > 12 * 3600e3) atualizarParcelas().catch(e => console.error('[compras] parcelas:', e.message));
    return (doc && doc.lista) || [];
  }

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
      const [ajPed, man] = await Promise.all([ajustesPedidos(), manuaisLista()]);
      await Promise.all(lojas.map(async b => {
        const [v, e, p, plano] = await Promise.all([
          ler.vendas(b, dtIni, dtFin, forcar).catch(err => { erros.push(`${b} venda: ${err.message}`); return {}; }),
          ler.estoque(b, hoje, forcar).catch(err => { erros.push(`${b} estoque: ${err.message}`); return {}; }),
          pedidosLoja(b, hoje, forcar, ajPed, man).catch(err => { erros.push(`${b} pedidos: ${err.message}`); return []; }),
          lerPlano(`${colecao}|${b}`),
        ]);
        // Pedido entra na coleção pela previsão de entrega (sem previsão, pela data do pedido)
        const itens = p.flatMap(x => x.itens).filter(i => { const d = i.entrega || i.data; return d >= per.ini && d <= per.fim; });
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
      if (!erros.length) atualizarParcelas().catch(e => console.error('[compras] parcelas:', e.message));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pedidos de todas as lojas: abertos (com pendente) ou todos com entrega na coleção
  app.get('/api/compras-plano/pedidos', requireAdmin, async (req, res) => {
    try {
      const hoje = hojeBRT(), forcar = req.query.atualizar === '1';
      const per = req.query.colecao ? periodo(req.query.colecao) : null;
      const [aj, man] = await Promise.all([ajustesPedidos(), manuaisLista()]);
      const lojas = LOJAS.filter(b => lojasEnv()[b]), erros = [], lista = [];
      await Promise.all(lojas.map(async b => {
        try {
          for (const p of await pedidosLoja(b, hoje, forcar, aj, man)) {
            const naColecao = per ? p.itens.some(i => (i.entrega || i.data) >= per.ini && (i.entrega || i.data) <= per.fim) : true;
            if (!(per ? naColecao : p.pendente > 0.5 || p.manual)) continue;
            const { itens, ...resto } = p;
            lista.push({ ...resto, colecao: colecaoDe(p.entrega || p.data), parcelas: parcelasDoPedido(p, hoje),
              porMarca: Object.entries(itens.reduce((o, i) => { const x = (o[i.marca] ||= { valor: 0, pendente: 0 }); x.valor += i.valor; x.pendente += i.pendente; return o; }, {}))
                .map(([marca, x]) => ({ marca, valor: r2(x.valor), pendente: r2(x.pendente) })).sort((a, c) => c.valor - a.valor) });
          }
        } catch (e) { erros.push(`${b}: ${e.message}`); }
      }));
      lista.sort((a, c) => (a.entrega || '').localeCompare(c.entrega || '') || a.b.localeCompare(c.b));
      res.json({ hoje, lojas, labels: Object.fromEntries(lojas.map(b => [b, boardsLabel[b] || b])), lista, erros });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT { b, pedido, entrega: 'YYYY-MM-DD'|null, dias: '30/60/90'|null, ignorar: bool }
  app.put('/api/compras-plano/pedido', requireAdmin, async (req, res) => {
    try {
      const { b, pedido } = req.body || {};
      if (!LOJAS.includes(b) || !pedido) return res.status(400).json({ error: 'loja e pedido obrigatórios' });
      const id = `${b}|${pedido}`, set = {}, unset = {};
      if ('entrega' in req.body) { if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.entrega || '')) set.entrega = req.body.entrega; else unset.entrega = 1; }
      if ('dias' in req.body) { const d = lerDias(req.body.dias); if (d.length) set.dias = d.join('/'); else unset.dias = 1; }
      if ('ignorar' in req.body) { if (req.body.ignorar) set.ignorar = true; else unset.ignorar = 1; }
      const c = col('comprasPedidos');
      if (c) await c.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: { ...set, em: new Date() } } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
      else { const x = { ...(memoria.pedAjustes[id] || {}), ...set }; for (const k of Object.keys(unset)) delete x[k]; memoria.pedAjustes[id] = x; }
      await atualizarParcelas();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pedido manual (o que não está no Microvix): POST cria, PUT altera, DELETE apaga
  const lerManual = body => {
    const m = { loja: body.loja, marca: String(body.marca || '').trim().toUpperCase(), setor: String(body.setor || '').trim().toUpperCase() || '(SEM SETOR)',
      valor: num(body.valor), entrega: body.entrega, dias: lerDias(body.dias).join('/') || '30', obs: String(body.obs || '').slice(0, 200), recebido: !!body.recebido };
    if (!LOJAS.includes(m.loja) || !m.marca || !(m.valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(m.entrega || '')) return null;
    return m;
  };
  app.post('/api/compras-plano/manual', requireAdmin, async (req, res) => {
    try {
      const m = lerManual(req.body || {});
      if (!m) return res.status(400).json({ error: 'loja, marca, valor e entrega obrigatórios' });
      const doc = { _id: require('crypto').randomUUID().slice(0, 8), ...m, criado: hojeBRT(), por: req.session?.user?.name || '' };
      const c = col('comprasManuais'); if (c) await c.insertOne(doc); else memoria.manuais.push(doc);
      await atualizarParcelas();
      res.json({ ok: true, id: doc._id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/compras-plano/manual/:id', requireAdmin, async (req, res) => {
    try {
      const m = lerManual(req.body || {});
      if (!m) return res.status(400).json({ error: 'loja, marca, valor e entrega obrigatórios' });
      const c = col('comprasManuais');
      if (c) await c.updateOne({ _id: req.params.id }, { $set: m }); else Object.assign(memoria.manuais.find(x => x._id === req.params.id) || {}, m);
      await atualizarParcelas();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/compras-plano/manual/:id', requireAdmin, async (req, res) => {
    try {
      const c = col('comprasManuais');
      if (c) await c.deleteOne({ _id: req.params.id }); else memoria.manuais = memoria.manuais.filter(x => x._id !== req.params.id);
      await atualizarParcelas();
      res.json({ ok: true });
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
  return { parcelasPrevistas, atualizarParcelas };
}

module.exports = { register, juntarPedidos, parcelasDoPedido, diasDoPlano, montarLoja, periodo, colecaoDe, colecoesPerto, mesesRestantes, LOJAS };
