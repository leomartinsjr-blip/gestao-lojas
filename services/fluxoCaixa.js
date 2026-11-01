'use strict';
// Fluxo de caixa previsto por loja: entradas = venda projetada (mesma regra do
// Dash de Performance) recebida em D+1 já sem a taxa de cartão; saídas = faturas
// a pagar em aberto do LinxFaturas (cpFaturas). Datas em dia útil (sáb/dom → seg).

const { PERF_HIST, PERF_2026 } = require('../public/perf-hist.js');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDias = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const hojeBRT = () => ymd(new Date(Date.now() - 3 * 3600e3));

// Sábado e domingo caem na segunda (o banco e a Rede não liquidam no fim de semana).
function diaUtil(s) {
  const dow = new Date(s + 'T12:00:00Z').getUTCDay();
  return dow === 6 ? addDias(s, 2) : dow === 0 ? addDias(s, 1) : s;
}

// Faturas antes disso sem baixa no Microvix são tratadas como pagas (lixo de 2020–2025).
const DIAS_ATRASO_CONSIDERADO = 90;

// ── Projeção de venda (mesma regra de calcPerfMetrics/computeCurMonthProj) ──
function criarProjecao(db, board, hoje) {
  const emps = (db.employees || []).filter(e => e.board === board && e.isVendedor !== false);
  const vendaDia = {}; // 'YYYY-MM-DD' → valor, só meses do vsales
  const cacheMes = {};
  function lerMes(y, m) {
    const mk = `${y}-${pad(m)}`;
    if (cacheMes[mk] != null) return cacheMes[mk];
    let tot = 0;
    for (const e of emps) {
      const ent = db.vsales?.[`${mk}-${board}-${e.id}`]?.entries;
      if (!ent) continue;
      for (const [d, v] of Object.entries(ent)) {
        const val = v?.value || 0;
        tot += val;
        vendaDia[d] = (vendaDia[d] || 0) + val;
      }
    }
    return (cacheMes[mk] = tot);
  }
  // Realizado do mês: tabela à mão (jan–abr/2026), senão o lançamento diário.
  function realizado(y, m) {
    const fixo = y === 2026 ? PERF_2026[board]?.[m - 1] : null;
    return fixo != null ? fixo : lerMes(y, m);
  }
  function base(y, m) {
    const h = PERF_HIST[board]?.[y]?.[m - 1];
    if (h != null) return h;
    return y >= 2026 ? (realizado(y, m) || null) : null;
  }
  const yoy = (y, m) => {
    const r = realizado(y, m), b = base(y - 1, m);
    return r > 0 && b > 0 ? r / b - 1 : null;
  };
  const mesAnt = (y, m, k) => { const t = y * 12 + (m - 1) - k; return [Math.floor(t / 12), t % 12 + 1]; };

  const [hy, hm, hd] = hoje.split('-').map(Number);
  const ontem = addDias(hoje, -1);
  const pesos = mk => (db.globalWeights || {})[mk] || {};
  lerMes(hy, hm);

  // Peso corrido até ontem e realizado até ontem no mês atual.
  const dim = diasNoMes(hy, hm);
  const pCur = pesos(`${hy}-${pad(hm)}`);
  let wAccum = 0, realAteOntem = 0;
  for (let d = 1; d <= dim; d++) {
    const ds = `${hy}-${pad(hm)}-${pad(d)}`;
    if (ds > ontem) break;
    wAccum += pCur[ds] ?? 100 / dim;
    realAteOntem += vendaDia[ds] || 0;
  }

  // Até o dia 15: média do crescimento dos 3 meses fechados.
  // Depois: 2 meses fechados + ritmo do mês atual.
  let ritmo = null;
  if (hd > 15 && wAccum > 0 && realAteOntem > 0) ritmo = Math.round(realAteOntem * 100 / wAccum);
  const cres = [];
  for (const k of ritmo != null ? [2, 1] : [3, 2, 1]) cres.push(yoy(...mesAnt(hy, hm, k)));
  if (ritmo != null) { const b = base(hy - 1, hm); cres.push(b > 0 ? ritmo / b - 1 : null); }
  const validos = cres.filter(v => v != null);
  const avgD = validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : 0;

  function projMes(y, m) {
    if (y === hy && m === hm && ritmo != null) return ritmo;
    const b = base(y - 1, m);
    return b > 0 ? Math.round(b * (1 + avgD)) : 0;
  }

  // Venda prevista por dia a partir de hoje. No mês atual distribui o que falta
  // (projeção − realizado até ontem) pelos pesos dos dias que restam.
  function vendaPrevistaPorDia(ate) {
    const out = {};
    let [y, m] = [hy, hm];
    while (`${y}-${pad(m)}-01` <= ate) {
      const mk = `${y}-${pad(m)}`;
      const n = diasNoMes(y, m), p = pesos(mk);
      const dias = [];
      for (let d = 1; d <= n; d++) {
        const ds = `${mk}-${pad(d)}`;
        if (ds >= hoje) dias.push([ds, p[ds] ?? 100 / n]);
      }
      const total = y === hy && m === hm ? Math.max(0, projMes(y, m) - realAteOntem) : projMes(y, m);
      const somaW = dias.reduce((s, [, w]) => s + w, 0);
      for (const [ds, w] of dias) if (ds <= ate && somaW > 0) out[ds] = total * w / somaW;
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
    return out;
  }

  return {
    avgD, ritmo, realAteOntem, vendaOntem: vendaDia[ontem] || 0, metodo: ritmo != null ? 'ritmo' : '3meses',
    projMes, realizado, base, vendaPrevistaPorDia,
    crescimentos: cres,
  };
}

// ── Cálculo do fluxo ──────────────────────────────────────────────────────
// taxas: { board: fração descontada da venda (ex.: 0.025) }
// saldos: { board: { valor, data } }
function calcular({ db, faturas, taxas, saldos, boards, hoje = hojeBRT(), dias = 90 }) {
  const ate = addDias(hoje, dias - 1);
  const corteAtraso = addDias(hoje, -DIAS_ATRASO_CONSIDERADO);
  const porDia = {}; // data → board → { vendas, recebe, paga, atraso }
  const slot = (d, b) => ((porDia[d] ||= {})[b] ||= { vendas: 0, recebe: 0, paga: 0, atraso: 0 });
  const projecao = {};
  const contas = [];

  for (const b of boards) {
    const pj = criarProjecao(db, b, hoje);
    const liq = 1 - (taxas[b] ?? 0.025);
    // Venda de ontem cai hoje (ou na segunda).
    if (pj.vendaOntem > 0) slot(diaUtil(hoje), b).recebe += pj.vendaOntem * liq;
    const prev = pj.vendaPrevistaPorDia(ate);
    for (const [d, v] of Object.entries(prev)) {
      slot(d, b).vendas += v;
      const cai = diaUtil(addDias(d, 1));
      if (cai <= ate) slot(cai, b).recebe += v * liq;
    }
    const [hy, hm] = hoje.split('-').map(Number);
    const meses = [];
    for (let k = 0, y = hy, m = hm; `${y}-${pad(m)}-01` <= ate; k++, [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1]) {
      meses.push({ mes: `${y}-${pad(m)}`, projecao: pj.projMes(y, m), base: pj.base(y - 1, m),
        realizado: y === hy && m === hm ? pj.realAteOntem : null });
    }
    projecao[b] = { metodo: pj.metodo, crescimento: pj.avgD, crescimentos: pj.crescimentos,
      taxa: 1 - liq, meses };
  }

  for (const f of faturas) {
    if (!boards.includes(f.board) || !f.isPagar || f.baixa) continue;
    const resta = (f.valor || 0) - (f.valorPago || 0);
    if (resta <= 0.009 || !f.vencimento || f.vencimento < corteAtraso || f.vencimento > ate) continue;
    const atrasada = f.vencimento < hoje;
    const d = diaUtil(atrasada ? hoje : f.vencimento);
    if (d > ate) continue;
    const s = slot(d, f.board);
    s.paga += resta;
    if (atrasada) s.atraso += resta;
    contas.push({ d, venc: f.vencimento, b: f.board, forn: f.fornecedor, doc: f.documento,
      parc: f.parcela, v: Math.round(resta * 100) / 100, atraso: atrasada });
  }

  const linhas = [];
  for (let d = hoje; d <= ate; d = addDias(d, 1)) {
    const pb = porDia[d] || {};
    const r = {};
    for (const b of boards) if (pb[b]) {
      const x = pb[b];
      r[b] = { vendas: Math.round(x.vendas), recebe: Math.round(x.recebe * 100) / 100,
        paga: Math.round(x.paga * 100) / 100, atraso: Math.round(x.atraso * 100) / 100 };
    }
    linhas.push({ d, b: r });
  }
  contas.sort((a, b) => a.d.localeCompare(b.d) || b.v - a.v);
  return { hoje, ate, boards, saldos, projecao, linhas, contas, diasAtraso: DIAS_ATRASO_CONSIDERADO };
}

module.exports = { calcular, criarProjecao, diaUtil, hojeBRT, addDias };
