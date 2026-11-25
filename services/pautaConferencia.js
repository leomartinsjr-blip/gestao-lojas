'use strict';
// Conferência da reunião: o que foi escrito na pauta do mês anterior volta como
// checklist. A marcação fica na pauta do mês em que se conferiu:
//   pauta.conferencia = [{ ch, estado: 'feito' | 'nao' }]
// O que foi marcado "não feito" segue voltando nos meses seguintes até ser feito.

const CAMPOS = ['performance', 'vendedores', 'crm', 'rh', 'produtos', 'balanco'];
const TIPOS = {
  ferias: 'Férias', contratacao: 'Contratação', demissao: 'Demissão',
  atestado: 'Atestado', advertencia: 'Advertência', treinamento: 'Treinamento', outro: 'Outro',
};
const MESES_ATRAS = 12;
const pad = n => String(n).padStart(2, '0');
const br = d => d ? d.split('-').reverse().join('/') : '';
const antes = (y, m) => m === 1 ? [y - 1, 12] : [y, m - 1];

// Cada linha do comentário vira um item; marcador de lista no começo sai.
const linhas = t => String(t || '').split(/\r?\n/)
  .map(l => l.replace(/^\s*(?:[-•*–]\s+|\d{1,2}[.)]\s+)/, '').trim()).filter(Boolean);

function itensDaPauta(p, y, m, itensLoja) {
  const out = [], vistos = new Set();
  const add = (campo, texto, feitoNaLoja = false) => {
    const ch = `${y}-${pad(m)}|${campo}|${texto}`;
    if (!texto || vistos.has(ch)) return;
    vistos.add(ch);
    out.push({ ch, campo, texto, year: y, month: m, feitoNaLoja });
  };
  for (const r of p.rhItens || []) {
    const t = [TIPOS[r.tipo] || r.tipo || 'Outro', r.colaborador, r.descricao].filter(Boolean).join(' · ');
    add('rh', t + (r.prazo ? ` — até ${br(r.prazo)}` : ''));
  }
  for (const c of CAMPOS) for (const l of linhas((p.comentarios || {})[c])) add(c, l);
  for (const a of p.acoes || []) {
    if (!a.texto) continue;
    const item = a.meetingItemId ? itensLoja.get(a.meetingItemId) : null;
    add('acoes', [a.texto, a.responsavel ? `(${a.responsavel})` : '', a.prazo ? `— até ${br(a.prazo)}` : ''].filter(Boolean).join(' '),
      !!(item && (item.checked || item.archived)));
  }
  return out;
}

// Itens a conferir na pauta de y/m: os do mês anterior e os mais antigos que,
// na última conferência, ficaram como não feitos.
function aConferir(db, y, m, board) {
  const itensLoja = new Map((db.meetingItems || []).map(x => [x.id, x]));
  const meses = [];
  let cy = y, cm = m;
  for (let i = 0; i < MESES_ATRAS; i++) { [cy, cm] = antes(cy, cm); meses.unshift([cy, cm]); }
  let lista = [];
  for (const [ay, am] of meses) {
    const p = (db.pautas || {})[`${ay}-${pad(am)}-${board}`];
    const est = new Map((p?.conferencia || []).map(x => [x.ch, x.estado]));
    lista = lista
      .map(i => ({ ...i, estado: est.get(i.ch) || i.estado }))
      .filter(i => i.estado === 'nao');
    if (p) lista.push(...itensDaPauta(p, ay, am, itensLoja));
  }
  return lista.map(({ estado, ...i }) => i);
}

function limpar(lista) {
  if (!Array.isArray(lista)) return [];
  const m = new Map();
  for (const x of lista.slice(0, 500))
    if (x && typeof x.ch === 'string' && ['feito', 'nao'].includes(x.estado)) m.set(x.ch, x.estado);
  return [...m].map(([ch, estado]) => ({ ch, estado }));
}

module.exports = { aConferir, limpar };
