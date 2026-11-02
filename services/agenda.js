'use strict';
// Agenda bancária: o extrato diário de cada empresa (planilha AGENDA 2026 do
// Leonardo). Cada empresa tem a conta corrente (CC), a conta garantida (CG,
// saldo negativo = limite usado) e, em algumas, contas extras (FLMJ, SITE…).
// Todo dia a sobra/falta da CC vai para a CG: a linha "C/G" mexe nas duas.
//
// Lançamento: { id, emp, data, seq, conta, desc, valor, espelho, abertura }
//   espelho  = linha "C/G": valor na CC e −valor na CG
//   abertura = saldo de partida da planilha (entra no saldo, não é movimento)

const XLSX = require('xlsx');

const EMPRESAS = ['LMJ', 'JDG', 'PV', '3L', 'LF'];
// Conta → loja do gestão (para o saldo do fluxo). LF (Lez a Lez) não tem Microvix.
const BOARD = {
  LMJ: { CC: 'delrey', CG: 'delrey', FLMJ: 'delrey', SITE: 'site' },
  JDG: { CC: 'minas', CG: 'minas', FJDG: 'minas' },
  PV:  { CC: 'contagem', CG: 'contagem', FPV: 'contagem' },
  '3L': { CC: 'tommy', CG: 'tommy' },
  LF:  {},
};
const boardDe = (emp, conta) => BOARD[emp]?.[conta] || null;
const EMP_DO_BOARD = { delrey: 'LMJ', minas: 'JDG', contagem: 'PV', tommy: '3L', site: 'LMJ', estacao: 'TTS' };

const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const r2 = v => Math.round(v * 100) / 100;
const serialParaData = n => {
  const d = XLSX.SSF.parse_date_code(n);
  return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
};

// Lê a planilha e devolve os lançamentos, as contas de cada empresa, os limites
// do PAINEL e a conferência (saldo calculado × saldo da última linha da planilha).
function lerPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const lancs = [], contas = {}, conferencia = {}, limites = {};
  for (const emp of EMPRESAS) {
    const ws = wb.Sheets[emp];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    // Contas extras: grupo de 3 colunas (descrição, movimento, saldo) com nome na linha 1
    const extras = [];
    for (let c = 6; c < (rows[0] || []).length; c += 3) {
      const nome = String(rows[0][c] || '').trim().toUpperCase();
      if (nome) extras.push({ nome, c });
    }
    contas[emp] = ['CC', 'CG', ...extras.map(e => e.nome)];
    let ultima = 2;
    rows.forEach((r, i) => {
      if (i < 2) return;
      if (String(r[1] || '').trim() || num(r[2]) || num(r[4]) || extras.some(e => String(r[e.c] || '').trim() || num(r[e.c + 1]))) ultima = i;
    });
    let data = null, seq = 0;
    const saldo = { CC: 0, CG: 0 };
    extras.forEach(e => { saldo[e.nome] = 0; });
    const add = (conta, desc, valor, extra = {}) => {
      if (!valor || Math.abs(valor) < 0.005) return;
      lancs.push({ emp, data, seq: seq++, conta, desc: String(desc || '').trim().toUpperCase() || (conta === 'CG' ? 'C/G' : '—'), valor: r2(valor), ...extra });
      saldo[conta] = r2((saldo[conta] || 0) + valor);
      if (extra.espelho) saldo.CG = r2(saldo.CG - valor);
    };
    for (let i = 2; i <= ultima; i++) {
      const r = rows[i];
      if (num(r[0]) && r[0] > 40000) { data = serialParaData(r[0]); }
      if (!data) continue;
      if (i === 2) {
        // Primeira linha: saldos de partida (saldo − movimento da própria linha)
        add('CC', 'SALDO INICIAL', (num(r[3]) || 0) - (num(r[2]) || 0), { abertura: true });
        add('CG', 'SALDO INICIAL', (num(r[5]) || 0) - (num(r[4]) || 0), { abertura: true });
        for (const e of extras) add(e.nome, 'SALDO INICIAL', (num(r[e.c + 2]) || 0) - (num(r[e.c + 1]) || 0), { abertura: true });
      }
      const desc = String(r[1] || '').trim();
      const cc = num(r[2]), cg = num(r[4]);
      if (cc && cg && Math.abs(cc + cg) < 0.01) add('CC', desc || 'C/G', cc, { espelho: true });
      else { if (cc) add('CC', desc, cc); if (cg) add('CG', desc, cg); }
      for (const e of extras) { const v = num(r[e.c + 1]); if (v) add(e.nome, r[e.c], v); }
    }
    // Conferência com a última linha da planilha
    const fim = rows[ultima] || [];
    conferencia[emp] = { CC: { calc: saldo.CC, planilha: r2(num(fim[3]) || 0) }, CG: { calc: saldo.CG, planilha: r2(num(fim[5]) || 0) } };
    for (const e of extras) conferencia[emp][e.nome] = { calc: saldo[e.nome], planilha: r2(num(fim[e.c + 2]) || 0) };
  }
  const painel = wb.Sheets.PAINEL ? XLSX.utils.sheet_to_json(wb.Sheets.PAINEL, { header: 1, defval: '', raw: true }) : [];
  for (const r of painel) if (EMPRESAS.includes(String(r[0]).trim()) && num(r[4])) limites[String(r[0]).trim()] = num(r[4]);
  return { lancs, contas, conferencia, limites };
}

// Saldo por conta até uma data (inclusive).
function saldos(lancs, ate = '9999-12-31') {
  const out = {};
  for (const l of lancs) {
    if (l.data > ate) continue;
    const e = (out[l.emp] ||= {});
    e[l.conta] = r2((e[l.conta] || 0) + l.valor);
    if (l.espelho) e.CG = r2((e.CG || 0) - l.valor);
  }
  return out;
}

// Saldo por loja do gestão (soma das contas ligadas a ela).
function saldoPorBoard(lancs, ate) {
  const s = saldos(lancs, ate), out = {};
  for (const [emp, cs] of Object.entries(s)) for (const [conta, v] of Object.entries(cs)) {
    const b = boardDe(emp, conta);
    if (b) out[b] = r2((out[b] || 0) + v);
  }
  return out;
}

module.exports = { lerPlanilha, saldos, saldoPorBoard, boardDe, EMPRESAS, BOARD, EMP_DO_BOARD };
