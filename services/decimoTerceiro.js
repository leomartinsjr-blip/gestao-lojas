'use strict';
// 13º salário — contas puras, sem banco. A 1ª parcela sai em novembro (metade,
// sem desconto) e a 2ª em dezembro (o total menos a 1ª e os descontos).
// Gravação em db.decimoTerceiro[ano]:
//   { entries: { [empId]: { p1: {...}, p2: {...} } },
//     encerradas: { [board]: { p1: bool, p2: bool } } }
// Cada parcela guarda a loja que pagou (board): transferência no meio do caminho
// não muda o que já foi lançado.

const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const PARCELAS = ['p1', 'p2'];
const MES_PARCELA = { p1: 11, p2: 12 };
const CAMPOS = {
  p1: ['base', 'avos', 'valor'],
  p2: ['base', 'avos', 'bruto', 'inss', 'irrf', 'outros'],
};
const pad = n => String(n).padStart(2, '0');

// Meses do ano com 15 dias ou mais de vínculo, até o mês da parcela. Quem já
// era da casa em janeiro leva os 12 avos desde a 1ª parcela (metade do 13º).
function avosDe(emp, ano, parcela) {
  const adm = emp.admissaoContrato || emp.admissao || '';
  if (!adm || adm <= `${ano}-01-17`) return 12;
  if (adm > `${ano}-12-31`) return 0;
  const [, m, d] = adm.split('-').map(Number);
  const ate = MES_PARCELA[parcela];
  if (m > ate) return 0;
  const diasNoMes = new Date(ano, m, 0).getDate() - d + 1;
  return ate - m + (diasNoMes >= 15 ? 1 : 0);
}

// Média dos proventos declarados das folhas do ano anteriores ao mês da parcela.
// Fica de fora o mês partido (admissão no meio, férias) e a ajuda de custo, que é
// verba indenizatória. "Por fora" já não está em entry.proventos.
function mediaProventos(folhas, emp, ano, parcela) {
  const adm = emp.admissao || '';
  let soma = 0, meses = 0;
  for (let m = 1; m < MES_PARCELA[parcela]; m++) {
    const mk = `${ano}-${pad(m)}`;
    if (adm > `${mk}-01`) continue;
    let total = 0, pulou = false;
    for (const loja of Object.values((folhas || {})[mk] || {})) {
      const e = loja?.entries?.[emp.id];
      if (!e) continue;
      if (e.ferias?.ativo) pulou = true;
      total += r2(e.proventos) - r2(e.ajudaCustoTotal);
    }
    if (pulou || total <= 0) continue;
    soma += total; meses++;
  }
  return { valor: meses ? r2(soma / meses) : 0, meses };
}

// Quem foi desligado no ano recebe o 13º na rescisão: só aparece se já tinha
// parcela lançada.
function colaboradores(db, ano) {
  const salvos = ((db.decimoTerceiro || {})[ano] || {}).entries || {};
  const fim = `${ano}-12-31`;
  return (db.employees || []).filter(e => {
    if (salvos[e.id]) return true;
    if (e.inativo && !e.desligamento) return false;
    if (e.desligamento && e.desligamento <= fim) return false;
    return !(e.admissao && e.admissao > fim);
  });
}

function totalParcela(parcela, e, p1) {
  return parcela === 'p1'
    ? r2(e?.valor)
    : r2(r2(e?.bruto) - r2(p1?.valor) - r2(e?.inss) - r2(e?.irrf) - r2(e?.outros));
}

function limparParcela(parcela, bruto, board) {
  const out = { board };
  for (const k of CAMPOS[parcela]) {
    const n = r2(bruto?.[k]);
    if (n < 0 || n > 1000000) return { erro: `Valor inválido: ${k}` };
    out[k] = n;
  }
  if (!Number.isInteger(out.avos) || out.avos > 12) return { erro: 'Avos deve ser de 0 a 12' };
  if (bruto?.pagoEm && !/^\d{4}-\d{2}-\d{2}$/.test(bruto.pagoEm)) return { erro: 'Data de pagamento inválida' };
  out.pagoEm = bruto?.pagoEm || '';
  return { dados: out };
}

module.exports = { r2, PARCELAS, MES_PARCELA, avosDe, mediaProventos, colaboradores, totalParcela, limparParcela };
