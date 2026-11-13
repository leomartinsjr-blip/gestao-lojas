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
    return comCache(`v2|${b}|${dtIni}|${dtFin}`, 3 * 3600e3, async () => {
      const [rows, cat] = await Promise.all([microvix.fetchMovimento(cnpjDe(b), dtIni, dtFin, chaveDe(b)), getCatalog()]);
      const out = {};
      let custo = 0, valor = 0;
      for (const row of rows) {
        if (row.cancelado === 'S' || row.cancelado === '1' || row.excluido === 'S' || row.soma_relatorio === 'N') continue;
        const op = String(row.operacao || '').toUpperCase(), serie = String(row.serie || row.serie_documento || row.num_serie || '').trim();
        if (op !== 'S' && op !== 'DS') continue;
        if (serie === '999' || serie === 'J' || (serie === '4' && op !== 'DS')) continue;
        const cod = String(row.cod_produto || '').replace(/\.0+$/, '').trim();
        if (!cod) continue;
        const [m, s] = chaveMS(infoDe(cat, cod, String(row.cod_barra || '').replace(/\.0+$/, '').trim()));
        const sinal = op === 'DS' ? -1 : 1, v = sinal * num(row.valor_total);
        ((out[m] ||= {})[s] = (out[m][s] || 0) + v);
        // CMV como na Conferência: custo médio da época × quantidade
        const q = num(row.quantidade || '1'), cu = num(row.custo_medio_epoca || row.preco_custo);
        if (cu > 0) { custo += sinal * cu * q; valor += v; }
      }
      return { porMS: out, cmv: valor > 0 ? Math.round(custo / valor * 1000) / 10 : null };
    }, forcar);
  }

  // Estoque a custo médio por marca/setor
  async function estoque(b, hoje, forcar) {
    return comCache(`e2|${b}|${hoje}`, 3600e3, async () => {
      const cat = await getCatalog();
      const out = {}, pv = {};
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
          const cu = num(r.custo_medio || r.preco_custo);
          ((out[m] ||= {})[s] = (out[m][s] || 0) + q * cu);
          // Markup cheio: só o que tem custo e preço (preço de venda de tabela ÷ custo médio)
          const p = num(r.preco_venda);
          if (cu > 0 && p > 0) { const x = ((pv[m] ||= {})[s] ||= { c: 0, v: 0 }); x.c += q * cu; x.v += q * p; }
        }
        const mx = Math.max(...rows.map(r => +r.timestamp || 0));
        if (mx <= ts) break;
        ts = mx;
      }
      return { porMS: out, precos: pv };
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
// precos: { MARCA: { SETOR: { c: custo, v: venda de tabela } } } do estoque atual → markup a preço cheio
// transf: { MARCA: { SETOR: valor } } — estoque de loja que fecha: + na que recebe, − na que fecha
function montarLoja({ vendas, estoque, itens, prem, pct = {}, ajustes = {}, precos = {}, transf = {} }) {
  const mk = x => x && x.c > 0 ? Math.round(x.v / x.c * 100) / 100 : null;
  const somaPv = o => Object.values(o || {}).reduce((a, x) => ({ c: a.c + x.c, v: a.v + x.v }), { c: 0, v: 0 });
  const marcas = new Set([...Object.keys(vendas), ...Object.keys(estoque), ...itens.map(i => i.marca), ...Object.keys(pct), ...Object.keys(ajustes), ...Object.keys(transf)]);
  const soma = o => Object.values(o || {}).reduce((s, v) => s + v, 0);
  const vendaTotal = Object.values(vendas).reduce((s, o) => s + Math.max(0, soma(o)), 0);
  const markup = 100 / (prem.cmv || PADRAO.cmv);
  const cotaTotal = (prem.previsao || 0) * (prem.cmv || PADRAO.cmv) / 100;
  const minimoTotal = (prem.vendaMedia || 0) / markup * (prem.cobertura || 0);
  const mediaMensal = prem.meses ? (prem.previsao || 0) / prem.meses : 0;

  const base = [...marcas].map(m => {
    const setores = new Set([...Object.keys(vendas[m] || {}), ...Object.keys(estoque[m] || {}), ...itens.filter(i => i.marca === m).map(i => i.setor), ...Object.keys(transf[m] || {})]);
    const doSetor = s => {
      const its = itens.filter(i => i.marca === m && i.setor === s);
      return { setor: s, markup: mk(precos[m]?.[s]), venda: r2(vendas[m]?.[s] || 0), estoque: r2(estoque[m]?.[s] || 0), transf: r2(transf[m]?.[s] || 0),
        realizado: r2(its.reduce((t, i) => t + i.valor, 0)), pendente: r2(its.reduce((t, i) => t + i.pendente, 0)) };
    };
    const ss = [...setores].map(doSetor).sort((a, b) => b.venda - a.venda || b.estoque - a.estoque);
    const venda = r2(ss.reduce((t, s) => t + s.venda, 0));
    const aj = ajustes[m] || {};
    return { marca: m, markup: mk(somaPv(precos[m])), setores: ss, venda, pctVenda: vendaTotal > 0 ? Math.max(0, venda) / vendaTotal : 0,
      pctDigitado: pct[m] != null ? pct[m] : null,
      estoque: r2(ss.reduce((t, s) => t + s.estoque, 0)), transf: r2(ss.reduce((t, s) => t + s.transf, 0)),
      realizadoMx: r2(ss.reduce((t, s) => t + s.realizado, 0)), pendenteMx: r2(ss.reduce((t, s) => t + s.pendente, 0)),
      ajRealizado: num(aj.realizado), ajPendente: num(aj.pendente) };
  });
  for (const x of base) x.pct = x.pctDigitado != null ? x.pctDigitado : x.pctVenda;
  const somaPct = base.reduce((t, x) => t + x.pct, 0) || 1;

  const linhas = base.map(x => {
    const peso = x.pct / somaPct;
    const realizado = r2(x.realizadoMx + x.ajRealizado), pendente = r2(x.pendenteMx + x.ajPendente);
    const cota = cotaTotal * peso, minimo = minimoTotal * peso, fat = mediaMensal * x.pct / markup;
    // O que chega de loja que fecha conta como estoque na necessidade; o que sai zera a sobra
    const entra = Math.max(0, x.transf);
    const necessidade = cota + minimo - x.estoque - entra;
    const l = { ...x, realizado, pendente, cota: r2(cota), minimo: r2(minimo), necessidade: r2(necessidade),
      saldoComprar: r2(necessidade - pendente), entregue: realizado > 0 ? (realizado - pendente) / realizado : null,
      fatMensal: r2(fat), cobertura: fat > 0 ? (x.estoque - minimo) / fat : null,
      coberturaPend: fat > 0 ? (pendente + x.estoque + entra - minimo) / fat : null,
      sobra: r2(pendente + x.estoque + x.transf - fat * (prem.meses || 0)) };
    // Setores: mesmas contas, com o peso do setor na venda da marca (ou no estoque, sem venda)
    const totV = x.setores.reduce((t, s) => t + Math.max(0, s.venda), 0), totE = x.setores.reduce((t, s) => t + s.estoque, 0);
    // O ajuste manual da marca (realizado/pendente) é repartido entre os setores pelo mesmo
    // peso: senão o pendente digitado sumia da sobra que passa para a coleção seguinte
    const setoresBase = x.setores.length ? x.setores : [{ setor: '(SEM SETOR)', venda: 0, estoque: 0, transf: 0, realizado: 0, pendente: 0 }];
    const nS = setoresBase.length;
    l.setores = setoresBase.map(s0 => {
      const ps = totV > 0 ? Math.max(0, s0.venda) / totV : totE > 0 ? s0.estoque / totE : 1 / nS;
      const s = { ...s0, realizado: r2(s0.realizado + x.ajRealizado * ps), pendente: r2(s0.pendente + x.ajPendente * ps) };
      const se = Math.max(0, s.transf || 0);
      const sc = cota * ps, sm = minimo * ps, sf = fat * ps, sn = sc + sm - s.estoque - se;
      return { ...s, pct: x.pct * ps, cota: r2(sc), minimo: r2(sm), necessidade: r2(sn), saldoComprar: r2(sn - s.pendente),
        fatMensal: r2(sf), cobertura: sf > 0 ? (s.estoque - sm) / sf : null, coberturaPend: sf > 0 ? (s.pendente + s.estoque + se - sm) / sf : null,
        sobra: r2(s.pendente + s.estoque + (s.transf || 0) - sf * (prem.meses || 0)) };
    });
    return l;
  // Marca sem venda aparece se tiver % digitado (marca nova) ou pedido/ajuste na coleção
  }).filter(l => l.pctVenda >= 0.0005 || l.pctDigitado != null || l.realizado > 0.5 || l.pendente > 0.5 || Math.abs(l.transf) > 0.5)
    .sort((a, b) => b.pct - a.pct || b.estoque - a.estoque);

  // Curva ABC pela venda: A até 80% acumulado, B até 95%, C o resto (sem venda = C)
  let acum = 0;
  for (const l of [...linhas].sort((a, b) => b.pctVenda - a.pctVenda)) {
    const antes = acum; acum += l.pctVenda;
    l.curva = l.pctVenda <= 0 ? 'C' : antes < 0.80 ? 'A' : antes < 0.95 ? 'B' : 'C';
  }
  const tot = k => r2(linhas.reduce((t, l) => t + (l[k] || 0), 0));
  const total = { pct: linhas.reduce((t, l) => t + l.pct, 0), venda: tot('venda'), cota: tot('cota'), realizado: tot('realizado'), pendente: tot('pendente'),
    estoque: tot('estoque'), transf: tot('transf'), minimo: tot('minimo'), necessidade: tot('necessidade'), saldoComprar: tot('saldoComprar'), fatMensal: tot('fatMensal'), sobra: tot('sobra') };
  total.entregue = total.realizado > 0 ? (total.realizado - total.pendente) / total.realizado : null;
  const alertas = {
    pendMaior: linhas.filter(l => l.pendente > l.realizado + 0.5).map(l => l.marca),
    semEstoque: linhas.filter(l => l.pct > 0 && l.estoque < 0.5).map(l => l.marca),
  };
  const pvLoja = somaPv(Object.fromEntries(Object.entries(precos).map(([m, o]) => [m, somaPv(o)])));
  total.markup = mk(pvLoja);
  return { linhas, total, calc: { markupCheio: mk(pvLoja), markup, cotaTotal: r2(cotaTotal), minimoTotal: r2(minimoTotal), mediaMensal: r2(mediaMensal), vendaTotal: r2(vendaTotal) }, alertas };
}

// Loja que fecha (regra do Leonardo, 13/11/2026): a previsão de sobra dela, marca e setor,
// vai para as lojas de destino pela necessidade (saldo p/ comprar positivo). Se a sobra passa
// do que elas precisam, o excesso vai pela venda da marca/setor em cada uma (sem venda, pela
// venda da marca; sem nenhuma, pelo tamanho da loja, a cota).
// fonte: montarLoja da loja que fecha · destinos: { b: montarLoja } (sem a transferência)
// → { sai: { MARCA: { SETOR: v } }, entra: { b: { MARCA: { SETOR: v } } }, porDestino: { b: total } }
function dividirSobra(fonte, destinos) {
  const bs = Object.keys(destinos);
  const idx = Object.fromEntries(bs.map(b => [b, Object.fromEntries(destinos[b].linhas.map(l => [l.marca, l]))]));
  const sai = {}, entra = Object.fromEntries(bs.map(b => [b, {}])), porDestino = Object.fromEntries(bs.map(b => [b, 0]));
  for (const l of fonte.linhas) for (const s of l.setores) {
    const S = s.sobra;
    if (!(S > 0.5)) continue;
    const linha = b => idx[b][l.marca], setor = b => linha(b)?.setores.find(x => x.setor === s.setor);
    const need = Object.fromEntries(bs.map(b => [b, Math.max(0, setor(b)?.saldoComprar || 0)]));
    const somaN = bs.reduce((t, b) => t + need[b], 0);
    const parte = {};
    if (somaN >= S) for (const b of bs) parte[b] = S * need[b] / somaN;
    else {
      let w = Object.fromEntries(bs.map(b => [b, Math.max(0, setor(b)?.venda || 0)]));
      if (!bs.some(b => w[b] > 0)) w = Object.fromEntries(bs.map(b => [b, Math.max(0, linha(b)?.venda || 0)]));
      if (!bs.some(b => w[b] > 0)) w = Object.fromEntries(bs.map(b => [b, destinos[b].calc.cotaTotal || 1]));
      const somaW = bs.reduce((t, b) => t + w[b], 0) || 1;
      for (const b of bs) parte[b] = need[b] + (S - somaN) * w[b] / somaW;
    }
    ((sai[l.marca] ||= {})[s.setor] = -r2(S));
    for (const b of bs) if (parte[b] > 0.005) {
      ((entra[b][l.marca] ||= {})[s.setor] = r2(parte[b]));
      porDestino[b] += parte[b];
    }
  }
  for (const b of bs) porDestino[b] = r2(porDestino[b]);
  return { sai, entra, porDestino };
}

// Coleção do item do pedido: a do cadastro do produto ("WINTER 27"), como no NEXO; sem ela,
// pela entrega. A previsão de entrega sozinha engana: pedidos de Winter 27 estão com entrega
// 01/01/2027, dentro da Summer 27 (12/11/2026).
function colecaoDoItem(i) {
  if (i.colecaoNexo) return i.colecaoNexo;
  const m = String(i.colecao || '').toUpperCase().match(/(SUMMER|WINTER)\s*(\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  return colecaoDe(i.entrega || i.data || new Date().toISOString().slice(0, 10));
}

// ── Pedidos e parcelas (funções puras) ───────────────────────────────────
// Prazo do plano do Microvix: "COMPRA 3X" → 30/60/90 dias da entrega
function diasDoPlano(plano) {
  const n = +((String(plano || '').match(/(\d+)\s*X/i) || [])[1] || 3);
  return Array.from({ length: Math.min(Math.max(n, 1), 12) }, (_, i) => 30 * (i + 1)).join('/');
}
const lerDias = s => String(s || '').split(/[\/;,\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 720);

// itens: do Microvix (já com marca/setor) · ajustes: { 'b|pedido': { entrega, dias, ignorar } }
// manuais: [{ _id, loja, marca, setor, valor, entrega, dias, obs, recebido }]
// Devolve os pedidos da loja, cada item com a entrega efetiva (a digitada vence a do Microvix).
// Pedido com entrega há mais de 60 dias e ainda pendente é, quase sempre, saldo que não foi
// encerrado no Microvix (12/11/2026: R$ 866 mil assim, a maioria de 2025): fica fora do
// fluxo, como a fatura vencida há mais de 90 dias. Religa-se pedido a pedido.
const DIAS_ATRASO_PEDIDO = 60;
function juntarPedidos(b, itens, ajustes = {}, manuais = [], hoje = new Date().toISOString().slice(0, 10)) {
  const ped = new Map();
  for (const i of itens) {
    const k = `${b}|${i.pedido}`, aj = ajustes[k] || {};
    const p = ped.get(k) || { b, pedido: i.pedido, data: i.data, fornecedor: i.fornecedor, plano: i.plano, itens: [], manual: false,
      entregaDig: aj.entrega || null, diasDig: aj.dias || null, ignorarDig: aj.ignorar ?? null, pendenteDig: aj.pendente ?? null, valorDig: aj.valor ?? null,
      nexo: i.nexo || null, aLancar: !!i.aLancar };
    p.itens.push({ ...i, entrega: aj.entrega || i.entrega || i.data, pendenteMx: i.pendente });
    ped.set(k, p);
  }
  // Valor digitado: escala os itens (o pendente acompanha na mesma proporção)
  for (const p of ped.values()) {
    if (p.valorDig == null) continue;
    const tot = p.itens.reduce((t, i) => t + i.valor, 0);
    const f = tot > 0 ? p.valorDig / tot : 0;
    for (const i of p.itens) { i.valorMx = i.valor; i.valor = r2(i.valor * f); i.pendente = r2(i.pendente * f); i.pendenteMx = i.pendente; }
  }
  // Pendente digitado: reparte entre os itens na proporção do pendente do Microvix
  // (sem pendente lá, na proporção do valor)
  for (const p of ped.values()) {
    if (p.pendenteDig == null) continue;
    const base = p.itens.reduce((t, i) => t + i.pendenteMx, 0), porValor = base < 0.5;
    const tot = porValor ? p.itens.reduce((t, i) => t + i.valor, 0) : base;
    for (const i of p.itens) i.pendente = tot > 0 ? r2(p.pendenteDig * (porValor ? i.valor : i.pendenteMx) / tot) : 0;
  }
  for (const m of manuais.filter(x => x.loja === b)) {
    const valor = Number(m.valor) || 0;
    ped.set(`${b}|M-${m._id}`, { b, pedido: `M-${m._id}`, id: String(m._id), data: m.criado || m.entrega, fornecedor: '', plano: '', manual: true, obs: m.obs || '', setor: String(m.setor || '').toUpperCase(),
      entregaDig: m.entrega, diasDig: m.dias || null, ignorarDig: false, recebido: !!m.recebido,
      itens: [{ pedido: `M-${m._id}`, marca: String(m.marca || '').toUpperCase(), setor: String(m.setor || '(sem setor)').toUpperCase(), entrega: m.entrega,
        valor, entregue: m.recebido ? valor : 0, pendente: m.recebido ? 0 : valor }] });
  }
  return [...ped.values()].map(p => {
    const soma = k => r2(p.itens.reduce((t, i) => t + (i[k] || 0), 0));
    const entregas = [...new Set(p.itens.map(i => i.entrega).filter(Boolean))].sort();
    const marcas = [...new Set(p.itens.map(i => i.marca))];
    const atrasado = !p.manual && soma('pendente') > 0.5 && entregas.length && entregas[entregas.length - 1] < addDias(hoje, -DIAS_ATRASO_PEDIDO);
    const pendenteMx = r2(p.itens.reduce((t, i) => t + (i.pendenteMx ?? i.pendente), 0));
    const valorMx = r2(p.itens.reduce((t, i) => t + (i.valorMx ?? i.valor), 0));
    return { ...p, pendenteMx, valorMx, atrasado, ignorar: p.ignorarDig != null ? p.ignorarDig : !!atrasado, valor: soma('valor'), entregue: soma('entregue'), pendente: soma('pendente'), entrega: entregas[0] || p.data,
      entregas, marcas, diasPadrao: p.manual ? '30' : diasDoPlano(p.plano), dias: p.diasDig || (p.manual ? '30' : diasDoPlano(p.plano)) };
  });
}

// Parcelas do que falta entregar: cada entrega pendente dividida pelos dias do prazo.
// Entrega que já passou e segue pendente conta a partir de hoje.
// dist: { COLECAO: { MARCA: { 'YYYY-MM': % } } } — a marca que compra a coleção inteira
// e recebe ao longo do semestre: cada mês é uma NF, e o prazo conta de cada uma. A data
// digitada no pedido vence a distribuição (entrega de uma vez).
function entregasDoItem(i, p, dist, hoje) {
  const d = !p.entregaDig && dist[colecaoDoItem(i)]?.[i.marca];
  const meses = d ? Object.entries(d).filter(([, v]) => v > 0) : [];
  const soma = meses.reduce((t, [, v]) => t + v, 0);
  if (!soma) return [[i.entrega || hoje, i.pendente]];
  const dia = String(i.entrega || '').slice(8, 10) || '01';
  return meses.map(([mk, v]) => {
    const ult = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)).getUTCDate();
    return [`${mk}-${String(Math.min(+dia, ult)).padStart(2, '0')}`, i.pendente * v / soma];
  });
}
function parcelasDoPedido(p, hoje, dist = {}) {
  if (p.ignorar || p.pendente < 0.5) return [];
  const dias = lerDias(p.dias);
  if (!dias.length) return [];
  const porEntrega = {};
  for (const i of p.itens) if (i.pendente > 0) for (const [ent, v] of entregasDoItem(i, p, dist, hoje)) porEntrega[ent] = (porEntrega[ent] || 0) + v;
  const out = [];
  for (const [ent, v] of Object.entries(porEntrega)) {
    const base = ent < hoje ? hoje : ent;
    const parte = r2(v / dias.length);
    dias.forEach((d, i) => out.push({ d: addDias(base, d), valor: i === dias.length - 1 ? r2(v - parte * (dias.length - 1)) : parte }));
  }
  const porDia = {};
  for (const x of out) porDia[x.d] = r2((porDia[x.d] || 0) + x.valor);
  return Object.entries(porDia).map(([d, valor]) => ({ d, valor })).sort((a, c) => a.d.localeCompare(c.d));
}

// ── Rotas ────────────────────────────────────────────────────────────────
function register(app, { getDb, getNexoDb = () => null, readDB, requireAdmin, microvix, getCatalog, criarProjecao, hojeBRT, boardsLabel = {} }) {
  const lojasEnv = () => JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const ler = criarLeitura({ microvix, getCatalog, lojasEnv });
  let memoria = {};
  const lerPlano = async id => { const db = getDb(); return (db ? await db.collection('comprasPlano').findOne({ _id: id }) : memoria[id]) || {}; };
  const gravarPlano = async (id, set) => {
    const db = getDb();
    if (db) await db.collection('comprasPlano').updateOne({ _id: id }, { $set: { ...set, em: new Date() } }, { upsert: true });
    else memoria[id] = { ...(memoria[id] || {}), ...set };
  };

  // Lojas que fecham: { b: { data: 'YYYY-MM-DD', destinos: [b] } }. Sem nada gravado, o Minas
  // fecha em 31/12/2026 e o estoque vai para Del Rey e Contagem (Leonardo, 13/11/2026).
  const FECHAMENTO_PADRAO = { minas: { data: '2026-12-31', destinos: ['delrey', 'contagem'] } };
  const lerFechamento = async () => { const d = await lerPlano('FECHAMENTO'); return d.lojas || FECHAMENTO_PADRAO; };
  app.put('/api/compras-plano/fechamento', requireAdmin, async (req, res) => {
    try {
      const { loja, data: dt, destinos } = req.body || {};
      if (!LOJAS.includes(loja)) return res.status(400).json({ error: 'loja inválida' });
      if (dt && !/^\d{4}-\d{2}-\d{2}$/.test(dt)) return res.status(400).json({ error: 'data inválida' });
      const atual = { ...(await lerFechamento()) };
      if (!dt) delete atual[loja];
      else atual[loja] = { data: dt, destinos: (Array.isArray(destinos) ? destinos : atual[loja]?.destinos || []).filter(b => LOJAS.includes(b) && b !== loja) };
      await gravarPlano('FECHAMENTO', { lojas: atual });
      res.json({ ok: true, lojas: atual });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const col = nome => { const db = getDb(); return db ? db.collection(nome) : null; };
  memoria.pedAjustes ||= {}; memoria.manuais ||= [];
  async function ajustesPedidos() {
    const c = col('comprasPedidos');
    if (!c) return memoria.pedAjustes;
    return Object.fromEntries((await c.find().toArray()).map(x => [x._id, x]));
  }
  async function manuaisLista() { const c = col('comprasManuais'); return c ? c.find().toArray() : memoria.manuais; }
  // Pedidos computados no NEXO (aba Compras): coleção, marca, custo por loja e o nº do
  // pedido de compra no Microvix (quando já lançado). É por eles que a coleção é montada.
  let nexoCache = null;
  async function pedidosNexo() {
    if (nexoCache && Date.now() - nexoCache.em < 120e3) return nexoCache.v;
    const ndb = getNexoDb();
    if (!ndb) return [];
    const docs = await ndb.collection('compras_pedidos').find({ computado: { $exists: true } },
      { projection: { computado: 1, feitos: 1, 'linhas.custo': 1, 'linhas.setor': 1, 'linhas.porLoja': 1 } }).toArray();
    const v = [];
    for (const d of docs) {
      const cp = d.computado || {};
      for (const [b, x] of Object.entries(cp.porLoja || {})) {
        if (!(x.custo > 0)) continue;
        const setores = {};
        for (const l of d.linhas || []) { const q = Number(l.porLoja?.[b]) || 0; if (q > 0) { const s = String(l.setor || '(sem setor)').trim().toUpperCase(); setores[s] = (setores[s] || 0) + q * (Number(l.custo) || 0); } }
        const somaS = Object.values(setores).reduce((t, y) => t + y, 0);
        if (somaS > 0) for (const s of Object.keys(setores)) setores[s] = r2(setores[s] * x.custo / somaS); else setores['(SEM SETOR)'] = x.custo;
        const num = String((d.feitos || {})['compra:' + b]?.numero || '').trim();
        v.push({ b, id: String(d._id), colecao: String(cp.colecao || '').toUpperCase(), marca: String(cp.marca || '').toUpperCase(), numero: num || null,
          valor: r2(x.custo), setores, em: cp.em ? new Date(cp.em).toISOString().slice(0, 10) : null });
      }
    }
    nexoCache = { em: Date.now(), v };
    return v;
  }
  // Pedidos da loja: os do Microvix (com a coleção do NEXO quando o nº está lá), os do NEXO
  // ainda sem nº no Microvix ("a lançar", todo pendente) e os manuais
  async function pedidosLoja(b, hoje, forcar, aj, man) {
    const [itensMx, nexo] = await Promise.all([ler.pedidos(b, hoje, forcar), pedidosNexo().catch(() => [])]);
    const daLoja = nexo.filter(n => n.b === b);
    const porNumero = new Map(daLoja.filter(n => n.numero).map(n => [n.numero, n]));
    const itens = itensMx.map(i => { const n = porNumero.get(String(i.pedido)); return n ? { ...i, colecaoNexo: n.colecao, nexo: { id: n.id, marca: n.marca, colecao: n.colecao } } : i; });
    const lancados = new Set(itensMx.map(i => String(i.pedido)));
    for (const n of daLoja) {
      if (n.numero && lancados.has(n.numero)) continue;   // já veio do Microvix
      const per = periodo(n.colecao);
      for (const [s, valor] of Object.entries(n.setores)) itens.push({ pedido: `N-${n.id.slice(-6)}`, data: n.em || hoje, entrega: per ? per.ini : hoje, fornecedor: '',
        marca: n.marca, setor: s, colecao: n.colecao, colecaoNexo: n.colecao, plano: '', valor, entregue: 0, pendente: valor, aLancar: true,
        nexo: { id: n.id, marca: n.marca, colecao: n.colecao, numero: n.numero } });
    }
    return juntarPedidos(b, itens, aj || await ajustesPedidos(), man || await manuaisLista(), hoje);
  }
  // Distribuição da entrega por marca e mês, uma por coleção (vale para todas as lojas)
  async function distribuicoes() {
    const c = col('comprasPlano');
    const docs = c ? await c.find({ _id: { $regex: '\\|entrega$' } }).toArray() : Object.entries(memoria).filter(([k]) => k.endsWith('|entrega')).map(([k, v]) => ({ _id: k, ...v }));
    return Object.fromEntries(docs.map(d => [d._id.split('|')[0], d.dist || {}]));
  }

  // Parcelas pendentes de todas as lojas, gravadas para o Fluxo de Caixa ler sem ir ao Microvix
  let gravando = null;
  async function atualizarParcelas(forcar) {
    if (gravando) return gravando;
    gravando = (async () => {
      const hoje = hojeBRT(), [aj, man, dist] = await Promise.all([ajustesPedidos(), manuaisLista(), distribuicoes()]);
      const lista = [];
      for (const b of LOJAS.filter(x => lojasEnv()[x])) {
        for (const p of await pedidosLoja(b, hoje, forcar, aj, man))
          for (const x of parcelasDoPedido(p, hoje, dist))
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
  // Coleção em andamento: no mês atual entra só o que falta vender (projeção − vendido até ontem)
  function previsaoPadrao(dbJson, b, meses, hoje) {
    const pj = criarProjecao(dbJson, b, hoje);
    const [hy, hm] = hoje.split('-').map(Number);
    return Math.round(meses.reduce((t, [y, m]) => t + (y === hy && m === hm ? Math.max(0, (pj.projMes(y, m) || 0) - (pj.realAteOntem || 0)) : (pj.projMes(y, m) || 0)), 0));
  }
  // Base do estoque mínimo (pedido do Leonardo, 13/11/2026): média dos 12 últimos meses
  // fechados do Dash, para o fim de ano (venda esporádica) não inflar o mínimo.
  // Mês sem dado não entra na média; sem nenhum, volta para a venda dos últimos dias.
  function vendaMediaAnual(dbJson, b, hoje) {
    const pj = criarProjecao(dbJson, b, hoje);
    let [y, m] = hoje.split('-').map(Number);
    const vals = [];
    for (let k = 0; k < 12; k++) {
      [y, m] = m === 1 ? [y - 1, 12] : [y, m - 1];
      const v = pj.base(y, m);
      if (v > 0) vals.push(v);
    }
    return vals.length ? { valor: Math.round(vals.reduce((a, c) => a + c, 0) / vals.length), meses: vals.length } : null;
  }
  // Meses que faltam, em fração: dias de hoje (ou do início) até o fim da coleção ÷ 30,4
  const mesesFaltantes = (pr, hoje) => {
    const de = pr.ini > hoje ? pr.ini : hoje;
    if (de > pr.fim) return 0;
    const dias = (Date.parse(pr.fim + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 864e5 + 1;
    return Math.round(dias / (365 / 12) * 10) / 10;
  };

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
      const anual = Object.fromEntries(lojas.map(b => [b, vendaMediaAnual(dbJson, b, hoje)]));

      const porLoja = {}, erros = [];
      const [ajPed, man] = await Promise.all([ajustesPedidos(), manuaisLista()]);
      const erro = (b, o) => err => { const m = `${b} ${o}: ${err.message}`; if (!erros.includes(m)) erros.push(m); };
      // Dados que não dependem da coleção: lidos uma vez por loja
      const base = {};
      const dadosLoja = b => base[b] ||= Promise.all([
        ler.vendas(b, dtIni, dtFin, forcar).catch(erro(b, 'venda')).then(x => x || { porMS: {}, cmv: null }),
        ler.estoque(b, hoje, forcar).catch(erro(b, 'estoque')).then(x => x || { porMS: {}, precos: {} }),
        pedidosLoja(b, hoje, forcar, ajPed, man).catch(erro(b, 'pedidos')).then(x => x || []),
      ]);
      // Uma coleção de uma loja. A que ainda não começou parte da previsão de sobra
      // da anterior (por marca e setor, sem negativo); a anterior, da dela, e assim por diante.
      // Loja que fecha: vende até o dia do fechamento (sem estoque mínimo) e a sobra vai para os
      // destinos (dividirSobra). Da coleção seguinte em diante ela aparece fechada e zerada.
      const fech = await lerFechamento();
      const fechaDe = b => fech[b]?.data || null;
      const memo = {}, memoB = {}, memoT = {};
      // A transferência entra na coleção SEGUINTE à do fechamento (Leonardo, 13/11/2026: o estoque
      // do Minas, que fecha em 31/12, conta na Winter 27 das outras e não mexe na Summer 27 delas).
      const colApos = d => colecaoDe(addDias(periodo(colecaoDe(d)).fim, 1));
      const calcLoja = (col, b, nivel = 0) => memo[col + b] ||= (async () => {
        const B = await calcBruto(col, b, nivel);
        // Loja que fecha: mostra para onde vai a sobra (calculada na coleção seguinte)
        const f = B.res.fecha?.data || B.res.fechada?.data;
        if (f) { const Tn = await transfDe(colApos(f)); return Tn.info[b] ? { ...B.res, transfInfo: Tn.info[b] } : B.res; }
        if (!B.args) return B.res;
        const T = await transfDe(col);
        if (!T.mapas[b]) return B.res;
        return { ...B.res, ...montarLoja({ ...B.args, transf: T.mapas[b] }), transfInfo: T.info[b] };
      })();
      const transfDe = col => memoT[col] ||= (async () => {
        const mapas = {}, info = {};
        for (const [f, cfg] of Object.entries(fech)) {
          if (!lojas.includes(f) || !cfg.data || colApos(cfg.data) !== col) continue;
          const dest = (cfg.destinos || []).filter(b => lojas.includes(b) && b !== f && !(fechaDe(b) && fechaDe(b) <= cfg.data));
          if (!dest.length) continue;
          // Sobra da loja que fecha na coleção do fechamento × necessidade das outras nesta
          const F = (await calcBruto(colecaoDe(cfg.data), f)).res;
          const D = Object.fromEntries(await Promise.all(dest.map(async b => [b, (await calcBruto(col, b)).res])));
          const r = dividirSobra(F, D);
          const juntar = (b, mapa) => { const o = (mapas[b] ||= {}); for (const [m, ss] of Object.entries(mapa)) for (const [s, v] of Object.entries(ss)) { (o[m] ||= {})[s] = r2((o[m][s] || 0) + v); } };
          info[f] = { data: cfg.data, colecao: col, envia: r.porDestino, recebe: {} };
          for (const b of dest) { juntar(b, r.entra[b]); ((info[b] ||= { recebe: {}, envia: {} }).recebe[f] = { valor: r.porDestino[b], data: cfg.data }); }
        }
        return { mapas, info };
      })();
      const calcBruto = (col, b, nivel = 0) => memoB[col + b] ||= (async () => {
        const pr0 = periodo(col), fecha = fechaDe(b);
        if (fecha && fecha < pr0.ini) {
          const prem = { previsao: 0, meses: 0, cmv: PADRAO.cmv, cobertura: 0, vendaMedia: 0 };
          return { args: null, res: { ...montarLoja({ vendas: {}, estoque: {}, itens: [], prem }), premissas: prem, padrao: prem, digitado: {}, pedidos: 0,
            estoqueDe: null, mediaAnualMeses: 0, fechada: { data: fecha, destinos: fech[b].destinos || [] } } };
        }
        // Coleção em que a loja fecha: o período dela termina no fechamento
        const fechaAqui = fecha && fecha <= pr0.fim ? fecha : null;
        const pr = fechaAqui ? { ...pr0, fim: fechaAqui } : pr0;
        const ms = mesesRestantes(pr, hoje);
        const [vr, eAtual, p] = await dadosLoja(b);
        const v = vr.porMS || {};
        const plano = await lerPlano(`${col}|${b}`);
        let estoque = eAtual.porMS || {}, estoqueDe = null;
        if (pr.ini > hoje && nivel < 6) {
          const ant = colecaoDe(addDias(pr.ini, -1));
          const r = await calcLoja(ant, b, nivel + 1);
          estoque = {};
          for (const l of r.linhas) for (const s of l.setores) if (s.sobra > 0.5) (estoque[l.marca] ||= {})[s.setor] = s.sobra;
          estoqueDe = ant;
        }
        // Pedido entra na coleção pela previsão de entrega (sem previsão, pela data do pedido)
        // A coleção é montada pelos pedidos do NEXO (pelo nº) e pelos manuais
        const itens = p.filter(x => x.nexo || x.manual).flatMap(x => x.itens).filter(i => colecaoDoItem(i) === col);
        const vendaPeriodo = Object.values(v).reduce((t, o) => t + Object.values(o).reduce((s, x) => s + x, 0), 0);
        // Fechamento no meio do mês: o último mês entra proporcional aos dias
        let previsao = ms.length ? previsaoPadrao(dbJson, b, ms, hoje) : 0;
        if (fechaAqui && ms.length) {
          const [fy, fm, fd] = fechaAqui.split('-').map(Number), ud = ultimoDia(fy, fm);
          if (fd < ud) { const antes = ms.length > 1 ? previsaoPadrao(dbJson, b, ms.slice(0, -1), hoje) : 0; previsao = Math.round(antes + (previsao - antes) * fd / ud); }
        }
        const padrao = {
          previsao, meses: mesesFaltantes(pr, hoje),
          cmv: vr.cmv || PADRAO.cmv, cobertura: fechaAqui ? 0 : PADRAO.cobertura, vendaMedia: anual[b]?.valor ?? Math.round(vendaPeriodo / (dias / 30)),
        };
        const digit = plano.premissas || {};
        const prem = Object.fromEntries(Object.keys(padrao).map(k => [k, digit[k] != null ? digit[k] : padrao[k]]));
        if (fechaAqui) { prem.cobertura = 0; if (digit.meses == null) prem.meses = padrao.meses; }
        const args = { vendas: v, estoque, itens, prem, pct: plano.pct || {}, ajustes: plano.ajustes || {}, precos: eAtual.precos || {} };
        return { args, res: { ...montarLoja(args), premissas: prem, padrao, digitado: digit, pedidos: itens.length, estoqueDe, mediaAnualMeses: anual[b]?.meses || 0,
          fecha: fechaAqui ? { data: fechaAqui, destinos: fech[b].destinos || [] } : null } };
      })();
      await Promise.all(lojas.map(async b => { porLoja[b] = await calcLoja(colecao, b); }));
      res.json({ colecao, colecoes: lista, periodo: per, meses: meses.map(([y, m]) => `${y}-${pad(m)}`), dias, hoje, venda: { dtIni, dtFin },
        lojas, labels: Object.fromEntries(lojas.map(b => [b, boardsLabel[b] || b])), porLoja, erros, fechamento: fech });
      if (!erros.length) atualizarParcelas().catch(e => console.error('[compras] parcelas:', e.message));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pedidos de todas as lojas: abertos (com pendente) ou todos com entrega na coleção
  app.get('/api/compras-plano/pedidos', requireAdmin, async (req, res) => {
    try {
      const hoje = hojeBRT(), forcar = req.query.atualizar === '1';
      const per = req.query.colecao ? periodo(req.query.colecao) : null;
      const [aj, man, dist] = await Promise.all([ajustesPedidos(), manuaisLista(), distribuicoes()]);
      const lojas = LOJAS.filter(b => lojasEnv()[b]), erros = [], lista = [];
      await Promise.all(lojas.map(async b => {
        try {
          for (const p of await pedidosLoja(b, hoje, forcar, aj, man)) {
            const naColecao = per ? p.itens.some(i => colecaoDoItem(i) === String(req.query.colecao).toUpperCase()) : true;
            if (!(per ? naColecao : p.pendente > 0.5 || p.manual)) continue;
            const { itens, ...resto } = p;
            lista.push({ ...resto, colecao: [...new Set(itens.map(colecaoDoItem))].join(' / '), parcelas: parcelasDoPedido(p, hoje, dist),
              distribuida: !p.entregaDig && itens.some(i => dist[colecaoDoItem(i)]?.[i.marca]),
              porMarca: Object.entries(itens.reduce((o, i) => { const x = (o[i.marca] ||= { valor: 0, pendente: 0 }); x.valor += i.valor; x.pendente += i.pendente; return o; }, {}))
                .map(([marca, x]) => ({ marca, valor: r2(x.valor), pendente: r2(x.pendente) })).sort((a, c) => c.valor - a.valor) });
          }
        } catch (e) { erros.push(`${b}: ${e.message}`); }
      }));
      lista.sort((a, c) => (a.entrega || '').localeCompare(c.entrega || '') || a.b.localeCompare(c.b));
      // Marcas da coleção (pedidos do NEXO e manuais) para a grade de distribuição
      const colSel = req.query.colecao ? String(req.query.colecao).toUpperCase() : null;
      const marcasCol = colSel ? [...new Set(lista.filter(p => p.nexo || p.manual).flatMap(p => p.marcas))].sort() : [];
      res.json({ hoje, lojas, labels: Object.fromEntries(lojas.map(b => [b, boardsLabel[b] || b])), lista, erros,
        distribuicao: colSel ? { colecao: colSel, meses: periodo(colSel) ? mesesRestantes(periodo(colSel), '2000-01-01').map(([y, m]) => `${y}-${pad(m)}`) : [],
          marcas: marcasCol, dist: dist[colSel] || {} } : null });
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
      if ('ignorar' in req.body) set.ignorar = !!req.body.ignorar; // explícito: vence a regra do atraso
      if ('valor' in req.body) { const v = req.body.valor; if (v === null || v === '') unset.valor = 1; else if (Number.isFinite(+v) && +v >= 0) set.valor = +v; }
      if ('pendente' in req.body) { const v = req.body.pendente; if (v === null || v === '') unset.pendente = 1; else if (Number.isFinite(+v) && +v >= 0) set.pendente = +v; }
      const c = col('comprasPedidos');
      if (c) await c.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: { ...set, em: new Date() } } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
      else { const x = { ...(memoria.pedAjustes[id] || {}), ...set }; for (const k of Object.keys(unset)) delete x[k]; memoria.pedAjustes[id] = x; }
      await atualizarParcelas();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT { colecao, marca, mes: 'YYYY-MM', pct } — % da entrega da marca naquele mês
  app.put('/api/compras-plano/entrega', requireAdmin, async (req, res) => {
    try {
      const colecao = String(req.body?.colecao || '').toUpperCase(), marca = String(req.body?.marca || '').toUpperCase(), mes = req.body?.mes;
      if (!periodo(colecao) || !marca || !/^\d{4}-\d{2}$/.test(mes || '')) return res.status(400).json({ error: 'coleção, marca e mês obrigatórios' });
      const id = `${colecao}|entrega`, campo = `dist.${marca.replace(/\./g, '')}.${mes}`;
      const v = req.body.pct === null || req.body.pct === '' ? null : +req.body.pct;
      const c = col('comprasPlano');
      if (c) await c.updateOne({ _id: id }, v ? { $set: { [campo]: v, em: new Date() } } : { $unset: { [campo]: 1 } }, { upsert: true });
      else { const d = (memoria[id] ||= { dist: {} }).dist; (d[marca] ||= {}); if (v) d[marca][mes] = v; else delete d[marca][mes]; }
      await atualizarParcelas();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST { colecao } — pendente digitado = 0 em todos os pedidos do Microvix com entrega na
  // coleção (o Leonardo zera e atualiza pedido a pedido). { colecao, desfazer: true } volta ao Microvix.
  app.post('/api/compras-plano/zerar-pendentes', requireAdmin, async (req, res) => {
    try {
      const per = periodo(req.body?.colecao);
      if (!per) return res.status(400).json({ error: 'coleção inválida' });
      const hoje = hojeBRT(), [aj, man] = await Promise.all([ajustesPedidos(), manuaisLista()]);
      let n = 0;
      for (const b of LOJAS.filter(x => lojasEnv()[x])) {
        for (const p of await pedidosLoja(b, hoje, false, aj, man)) {
          if (p.manual || !p.itens.some(i => colecaoDoItem(i) === String(req.body.colecao).toUpperCase())) continue;
          const id = `${b}|${p.pedido}`, c = col('comprasPedidos');
          const op = req.body.desfazer ? { $unset: { pendente: 1 } } : { $set: { pendente: 0, em: new Date() } };
          if (c) await c.updateOne({ _id: id }, op, { upsert: true });
          else { memoria.pedAjustes[id] ||= {}; if (req.body.desfazer) delete memoria.pedAjustes[id].pendente; else memoria.pedAjustes[id].pendente = 0; }
          n++;
        }
      }
      await atualizarParcelas();
      res.json({ ok: true, pedidos: n });
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

module.exports = { dividirSobra, entregasDoItem, colecaoDoItem, register, juntarPedidos, parcelasDoPedido, diasDoPlano, montarLoja, periodo, colecaoDe, colecoesPerto, mesesRestantes, LOJAS };
