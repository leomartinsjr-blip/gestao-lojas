// Balanço de Loja — tela. Regras de status iguais às de services/balanco.js
// (e às fórmulas da planilha de recontagem).

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fInt = n => { const v = Math.round(Number(n) || 0); const s = Math.abs(v).toLocaleString('pt-BR'); return v < 0 ? `(${s})` : s; };
const fRS = n => { const v = Number(n) || 0; return (v < 0 ? '-' : '') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const cls = n => (Number(n) || 0) < 0 ? 'neg' : (Number(n) || 0) > 0 ? 'pos' : '';
const dBR = iso => String(iso || '').split('-').reverse().join('/');
const mesBR = m => { const [a, b] = String(m || '').split('-'); return b ? `${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+b - 1]}/${a}` : ''; };
const grupoCurto = g => String(g || '').replace(/^\s*[A-Z0-9]{1,4}\s*-\s*/i, '').trim() || '(SEM GRUPO)';
const vazio = v => v === null || v === undefined || v === '';

// Mesma conta do servidor (abatimentos): o que cada origem explica da diferença
function abat(it) {
  const contado = vazio(it.rc) ? it.l : Number(it.rc);
  const dif = contado - it.e;
  const falta = dif < 0 ? -dif : 0, sobra = dif > 0 ? dif : 0;
  const tPend = (it.tn || []).filter(n => n.pend).reduce((a, n) => a + n.q, 0);
  // Nota pendente: as peças não estão na loja — o esperado é estoque − nota (abate inteira se há falta)
  const trNota = falta > 0 ? tPend : 0;
  const trOutros = Math.min(Math.max(0, falta - tPend), Math.max(0, (it.t || 0) - tPend));
  const venda = Math.min(sobra, it.v || 0);
  // Trânsito explica a diferença toda quando, abatido, não sobra nem falta nada
  const explicaTransito = dif < 0 && dif + trNota + trOutros === 0;
  return { dif, trNota, trOutros, tr: trNota + trOutros, venda, explicaTransito, liquida: dif + trNota + trOutros - venda };
}
const transitoSoPorNota = it => { const a = abat(it); return a.explicaTransito && !a.trOutros; };
function causa(it) {
  const dif = it.l - it.e;
  if (dif < 0 && abat(it).explicaTransito) return 'VER TRÂNSITO';
  if (it.v > 0 && Math.abs(dif) === it.v) return 'VER VENDA';
  if (it.v > 0) return 'VENDA PARCIAL';
  return 'A RECONTAR';
}
// Foto obrigatória (balanço com exigeFoto): recontagem da loja sem foto não vale
// Contou 0: não há peça para fotografar — vai sem foto, mas o escritório confere
const contouZero = it => !vazio(it.rc) && Number(it.rc) === 0;
const semFoto = it => !!S.bal?.exigeFoto && !it.st && !it.re && !(it.fotos || []).length && !vazio(it.rc) && !contouZero(it);
// Quantidade + foto da loja só vale depois de o escritório conferir
const aConferir = it => !!S.bal?.exigeFoto && !it.st && !it.re && !vazio(it.rc) && ((it.fotos || []).length > 0 || contouZero(it)) && !it.cf;
const recusadoIt = it => !!S.bal?.exigeFoto && !it.st && !it.re && !!it.cf && it.cf.ok === false;
function statusAuto(it) {
  if (vazio(it.rc)) return causa(it);
  if (semFoto(it)) return 'SEM FOTO';
  if (aConferir(it)) return 'A CONFERIR';
  if (recusadoIt(it)) return 'RECUSADO';
  const rc = Number(it.rc);
  if (rc === it.e) return 'OK';
  if (rc < it.e && abat(it).explicaTransito) return 'VER TRÂNSITO';
  return 'DIVERGENTE';
}
const status = it => S.bal?.cega ? it.sl : (it.st || statusAuto(it));
// Diferença depois da recontagem: OK/troca/venda/trânsito dado pelo escritório (ou trânsito
// automático já recontado) não conta. null = pendente. Igual ao difFinal do servidor.
const EXPLICADO = ['OK', 'TROCA', 'VER VENDA', 'VER TRÂNSITO'];
const difFinal = it => semFoto(it) || aConferir(it) || recusadoIt(it) ? null : EXPLICADO.includes(status(it)) && (it.st || !vazio(it.rc) || status(it) === 'VER VENDA' || (status(it) === 'VER TRÂNSITO' && transitoSoPorNota(it))) ? 0 : vazio(it.rc) ? null : Number(it.rc) - it.e + abat(it).trNota;
const fDifF = it => difFinal(it) === null ? '' : fInt(difFinal(it));
const STATUS_MANUAL = ['OK', 'DIVERGENTE', 'VER VENDA', 'VER TRÂNSITO', 'A RECONTAR', 'TROCA', 'AJUSTAR'];
// NFs de entrada que explicam o trânsito
const nfsTxt = it => (it.tn || []).map(n => { const tipo = n.tp === 'T' ? 'Transf.' : n.pend ? 'NF pendente' : 'NF';
  return `<span class="nf" title="${n.tp === 'T' ? 'Transferência de outra loja' : 'Entrada'} em ${esc(n.d)}: ${fInt(n.q)} peça(s)">${tipo} ${esc(n.n)} · ${esc(n.d)} · ${fInt(n.q)} pç</span>`; }).join('');
const stCls = s => 'st st-' + s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ /g, '-');
const STATUS_LBL = { recontagem: 'Em recontagem', finalizado: 'Finalizado', processando: 'Processando', erro: 'Erro' };

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/'; throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}

const S = { tab: 'mes', escritorio: false, lojas: [], lojaLbl: {}, bal: null, sub: 'recont', poll: null,
  filtro: { g: '', st: '', q: '', pend: false } };

// ── Lista ──────────────────────────────────────────────────────────────────
async function carregarLista() {
  const p = new URLSearchParams();
  if (S.tab === 'mes' && $('fMes').value) p.set('mes', $('fMes').value);
  if ($('fLoja').value) p.set('board', $('fLoja').value);
  $('lista').innerHTML = '<div class="empty">Carregando…</div>';
  try {
    const j = await api('/api/balancos?' + p);
    S.escritorio = j.escritorio;
    if (!S.lojas.length) {
      S.lojas = j.lojas;
      $('fLoja').innerHTML = '<option value="">Todas as lojas</option>' + j.lojas.map(b => `<option value="${b}">${b.toUpperCase()}</option>`).join('');
      if (j.lojas.length === 1) $('fLoja').classList.add('hidden');
    }
    $('btnNovo').classList.toggle('hidden', !S.escritorio);
    $('btnArquivar').classList.toggle('hidden', !S.escritorio);
    for (const b of j.balancos) S.lojaLbl[b.board] = b.lojaLabel;
    S.tab === 'mes' ? desenharCards(j.balancos) : desenharHistorico(j.balancos);
    if (j.balancos.some(b => b.status === 'processando')) setTimeout(() => { if (!S.bal) carregarLista(); }, 4000);
  } catch (e) { $('lista').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function desenharCards(lista) {
  if (!lista.length) { $('lista').innerHTML = `<div class="empty">Nenhum balanço em ${esc(mesBR($('fMes').value))}.</div>`; return; }
  $('lista').innerHTML = '<div class="cards">' + lista.map(b => {
    const r = b.resumo;
    const corpo = b.status === 'processando' ? `<div class="bcard-meta"><span class="spin" style="display:inline-block;width:12px;height:12px;vertical-align:-2px"></span> ${esc(b.etapa || 'Processando…')}</div>`
      : b.status === 'erro' ? `<div class="bcard-meta neg">${esc(b.erro || '')}</div>`
      : r && !S.escritorio && r.impactoConfirmado === undefined ? `<div class="bcard-conf">Recontados<b>${fInt(r.recontados)} de ${fInt(r.itens)}</b></div>`
      : r ? `<div class="bcard-conf">Impacto confirmado<b class="${cls(r.impactoConfirmado)}">${fRS(r.impactoConfirmado)}</b></div>
        <div class="bcard-nums">
          <div>Lido × estoque<b>${r.pecasLidas == null ? '—' : fInt(r.pecasLidas) + ' × ' + fInt(r.pecasEstoque)}</b></div>
          <div>Recontados<b>${r.recontados} de ${r.itens}</b></div>
          <div>A apurar<b class="${cls(r.impactoApurar)}">${fRS(r.impactoApurar)}</b></div>
          <div>Peças (final)<b class="${cls(r.pecasDifFinal)}">${fInt(r.pecasDifFinal)}</b></div>
        </div>` : '';
    return `<div class="bcard st-${b.status}" data-id="${b.id}">
      <div class="bcard-top"><span class="bcard-loja">${esc(b.lojaLabel)}</span><span class="badge ${b.status}">${STATUS_LBL[b.status] || b.status}</span></div>
      <div class="bcard-meta">Contagem ${dBR(b.data)}${b.hora ? ' ' + b.hora : ''} · ${esc(b.arquivoNome || '')}${b.obs ? ' · ' + esc(b.obs) : ''}</div>
      ${corpo}</div>`;
  }).join('') + '</div>';
  document.querySelectorAll('.bcard').forEach(el => el.onclick = () => abrir(el.dataset.id));
}

// Resultado de cada loja nos últimos 12 meses: impacto final, somando os balanços do mês
function resumoLojas(lista) {
  const hoje = new Date();
  const meses = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const lojas = new Map();
  for (const b of lista) {
    if (!b.resumo || !meses.includes(b.mes)) continue;
    if (!lojas.has(b.board)) lojas.set(b.board, { nome: b.lojaLabel, mes: {} });
    const l = lojas.get(b.board);
    l.mes[b.mes] = (l.mes[b.mes] || 0) + (b.resumo.impactoConfirmado || 0) + (b.resumo.impactoApurar || 0);
  }
  if (!lojas.size) return '';
  const soma = o => Object.values(o).reduce((a, v) => a + v, 0);
  const linhas = [...lojas.values()].map(l => ({ ...l, tot: soma(l.mes) })).sort((a, b) => a.nome.localeCompare(b.nome));
  const totMes = {};
  for (const l of linhas) for (const [m, v] of Object.entries(l.mes)) totMes[m] = (totMes[m] || 0) + v;
  // Só os meses que tiveram balanço: os vazios só empurravam o total para fora da tela
  const comBal = meses.filter(m => totMes[m] !== undefined);
  const total = soma(totMes);
  const nBal = lista.filter(b => b.resumo && meses.includes(b.mes)).length;
  const porRes = [...linhas].sort((a, b) => a.tot - b.tot);
  const pior = porRes[0], melhor = porRes[porRes.length - 1];
  // Célula sem "R$" e sem centavos (o valor exato fica no title), com fundo pela intensidade
  const maxAbs = Math.max(1, ...linhas.flatMap(l => Object.values(l.mes).map(Math.abs)));
  const fCurto = v => (v < 0 ? '−' : v > 0 ? '+' : '') + Math.abs(Math.round(v)).toLocaleString('pt-BR');
  const cel = v => {
    if (v === undefined) return '<td class="n vazio">·</td>';
    const a = Math.min(.38, .06 + .32 * Math.sqrt(Math.abs(v) / maxAbs));
    const bg = v < 0 ? `rgba(var(--down-rgb),${a.toFixed(2)})` : v > 0 ? `rgba(var(--up-rgb),${a.toFixed(2)})` : 'transparent';
    return `<td class="n heat ${cls(v)}" style="background:${bg}" title="${fRS(v)}">${fCurto(v)}</td>`;
  };
  const tot = v => `<td class="n tot ${cls(v)}">${fRS(v)}</td>`;
  const curto = m => mesBR(m).replace(/\/20(\d\d)$/, '/$1');
  const kpi = (lb, vl, sb, c = '') => `<div class="kpi"><div class="lb">${lb}</div><div class="vl ${c}">${vl}</div><div class="sb">${sb}</div></div>`;
  return `<div class="res-lojas">
    <div class="kpis res-kpis">
      ${kpi('Resultado · 12 meses', fRS(total), `${linhas.length} loja(s) · ${comBal.length} mês(es) com balanço`, cls(total))}
      ${kpi('Maior perda', esc(pior.nome), fRS(pior.tot), cls(pior.tot))}
      ${kpi(melhor.tot < 0 ? 'Menor perda' : 'Melhor resultado', esc(melhor.nome), fRS(melhor.tot), cls(melhor.tot))}
      ${kpi('Balanços no período', String(nBal), `de ${curto(meses[0])} a ${curto(meses[11])}`)}
    </div>
    <div class="res-tit">Resultado por loja e mês <span class="hint">· passe o mouse para ver o valor exato</span></div>
    <div class="tbl-wrap"><table class="tbl res"><thead><tr><th class="fix">Loja</th>${comBal.map(m => `<th class="n">${curto(m)}</th>`).join('')}<th class="n tot">12 meses</th></tr></thead>
    <tbody>${linhas.map(l => `<tr><td class="fix">${esc(l.nome)}</td>${comBal.map(m => cel(l.mes[m])).join('')}${tot(l.tot)}</tr>`).join('')}</tbody>
    <tfoot><tr><td class="fix">Total</td>${comBal.map(m => `<td class="n ${cls(totMes[m])}" title="${fRS(totMes[m])}">${fCurto(totMes[m])}</td>`).join('')}${tot(total)}</tr></tfoot>
    </table></div></div>`;
}

function desenharHistorico(lista) {
  if (!lista.length) { $('lista').innerHTML = '<div class="empty">Nenhum balanço ainda.</div>'; return; }
  const finalDe = b => (b.resumo?.impactoConfirmado || 0) + (b.resumo?.impactoApurar || 0);
  const linha = b => {
    const r = b.resumo || {};
    const final = finalDe(b);
    const lido = r.pecasLidas != null ? `${fInt(r.pecasLidas)} × ${fInt(r.pecasEstoque)}` : '<span class="vazio">—</span>';
    return `<tr class="clic" data-id="${b.id}">
      <td class="loja">${esc(b.lojaLabel)}</td>
      <td>${dBR(b.data)}${b.hora ? ' ' + b.hora : ''}${b.origem === 'planilha' ? ' <span class="orig">planilha</span>' : ''}</td>
      <td class="n">${lido}</td>
      <td class="n">${b.resumo ? `${r.recontados} de ${r.itens}` : ''}</td>
      <td class="n ${cls(r.pecasDif)}">${b.resumo ? fInt(r.pecasDif) : ''}</td>
      <td class="n ${cls(r.pecasDifFinal)}">${b.resumo ? fInt(r.pecasDifFinal) : ''}</td>
      <td class="n destaque ${cls(final)}">${b.resumo ? fRS(final) : ''}</td>
      <td><span class="badge ${b.status}">${STATUS_LBL[b.status] || b.status}</span></td></tr>`;
  };
  // Agrupado por mês, do mais recente: cabeçalho do mês com o total
  const porMes = new Map();
  for (const b of [...lista].sort((a, b) => (b.mes + b.data).localeCompare(a.mes + a.data))) {
    if (!porMes.has(b.mes)) porMes.set(b.mes, []);
    porMes.get(b.mes).push(b);
  }
  const corpo = [...porMes].map(([m, bs]) => {
    const t = bs.reduce((a, b) => a + finalDe(b), 0);
    return `<tr class="grp"><td colspan="6">${esc(mesBR(m))} <span class="hint">· ${bs.length} balanço${bs.length > 1 ? 's' : ''}</span></td>
      <td class="n ${cls(t)}">${fRS(t)}</td><td></td></tr>${bs.map(linha).join('')}`;
  }).join('');
  $('lista').innerHTML = resumoLojas(lista) + `<div class="res-tit" style="margin-top:6px">Balanços</div>
    <div class="tbl-wrap"><table class="tbl hist"><thead><tr>
    <th>Loja</th><th>Contagem</th><th class="n">Lido × estoque</th><th class="n">Recontados</th>
    <th class="n">Dif. peças (sistema)</th><th class="n">Dif. peças (final)</th><th class="n destaque">Impacto final</th><th>Status</th>
    </tr></thead><tbody>${corpo}</tbody></table></div>
    <div class="hint" style="margin-top:6px">Impacto final = confirmado na recontagem + o que ainda está a apurar. "planilha" = balanço antigo importado, só com as diferenças.</div>`;
  document.querySelectorAll('tr.clic').forEach(el => el.onclick = () => abrir(el.dataset.id));
  // Tela estreita: o resumo abre nos meses mais recentes
  const rw = document.querySelector('.res-lojas .tbl-wrap');
  if (rw) rw.scrollLeft = rw.scrollWidth;
}

// ── Um balanço ─────────────────────────────────────────────────────────────
async function abrir(id, manterSub) {
  clearTimeout(S.poll);
  if (!manterSub) S.sub = 'recont';
  history.replaceState(null, '', '/balanco?id=' + id);
  $('vLista').classList.add('hidden');
  $('vDet').classList.remove('hidden');
  try {
    S.bal = await api('/api/balancos/' + id);
    S.escritorio = S.bal.escritorio;
    desenharDetalhe();
    if (S.bal.status === 'processando') S.poll = setTimeout(() => abrir(id, true), 3000);
  } catch (e) { $('vDet').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function voltar() {
  clearTimeout(S.poll);
  S.bal = null;
  history.replaceState(null, '', '/balanco');
  $('vDet').classList.add('hidden');
  $('vLista').classList.remove('hidden');
  carregarLista();
}

// Igual ao servidor: no balanço importado e finalizado, o que não foi recontado
// mas tem observação ou é explicado por venda/trânsito fica fora
const obsPlanilha = it => String(it.ob || '').replace(/(^|\s·\s)(AJUSTADO|REGULARIZADO): .*$/, '').trim();
const SUPERFLUO = /SUP[EÉ]RF(LU|UL)O|AJUSTE ERRADO|\bTROCA|TIRAR (DO )?ESTOQUE|DEVOLVID|DEFEITO/i;
const resolvidoNaPlanilha = (b, it) => b.origem === 'planilha' && b.status === 'finalizado'
  && (SUPERFLUO.test(obsPlanilha(it)) || (vazio(it.rc) && it.st !== 'DIVERGENTE' && it.st !== 'A RECONTAR'
    && (!!obsPlanilha(it) || ['VER VENDA', 'VER TRÂNSITO'].includes(status(it)))));
// Código que não existe no Microvix fica fora da recontagem: lista à parte
const NAO_CADASTRADO = '(NÃO CADASTRADO)';
const naoCadastrados = b => (b.itens || []).filter(it => it.g === NAO_CADASTRADO).sort((x, y) => (x.o ?? 0) - (y.o ?? 0));
function itensRecontagem(b) {
  // Recontagem cega: o servidor já manda só os itens a recontar (sem estoque nem leitura)
  if (b.cega) return (b.itens || []).filter(it => it.g !== NAO_CADASTRADO);
  const fora = new Set(b.gruposFora || []);
  return (b.itens || []).filter(it => it.g !== NAO_CADASTRADO && !fora.has(it.g) && it.l !== it.e && (it.lido || b.incluirNaoLidos)
    && !resolvidoNaPlanilha(b, it));
}

// ── Tela da loja: recontagem cega ─────────────────────────────────────────
// A loja não vê estoque, leitura, diferença nem valores: conta, digita e manda a
// foto. O status não diz se o número bateu (ENVIADO até o escritório conferir).
const PEND_LOJA = ['RECONTAR', 'FALTA FOTO', 'RECONTAR DE NOVO'];
function desenharLoja() {
  const b = S.bal, aberto = b.status === 'recontagem';
  const cab = `<div class="det-head"><button class="btn" id="dVoltar">← Voltar</button>
    <span class="det-title">${esc(b.lojaLabel)} · ${dBR(b.data)}</span><span class="badge ${b.status}">${STATUS_LBL[b.status] || b.status}</span></div>`;
  if (b.status === 'processando' || !b.itens) {
    $('vDet').innerHTML = cab + `<div class="proc"><span class="spin"></span><div><b>Processando…</b><div class="muted">O balanço ainda está sendo preparado.</div></div></div>`;
    $('dVoltar').onclick = voltar; return;
  }
  const temTrocas = !!b.trocas?.enviadaEm;
  $('vDet').innerHTML = cab + `<div id="progLoja"></div>
    <div class="aviso">Para cada item: conte, digite a quantidade em <b>Contei</b> e tire a foto mostrando as peças com o <b>código</b> da etiqueta aparecendo. Sem a foto a recontagem não vale. Não achou nenhuma peça? Digite <b>0</b>: não precisa de foto. O escritório confere cada item.</div>
    ${temTrocas ? `<div class="tabs noprint"><button class="tab ${S.sub !== 'trocas' ? 'active' : ''}" data-sub="recont">Recontagem</button><button class="tab ${S.sub === 'trocas' ? 'active' : ''}" data-sub="trocas">Trocas</button></div>` : ''}
    <div id="sub"></div>`;
  $('dVoltar').onclick = voltar;
  document.querySelectorAll('[data-sub]').forEach(el => el.onclick = () => { S.sub = el.dataset.sub; desenharLoja(); });
  progressoLoja();
  if (temTrocas && S.sub === 'trocas') return desenharTrocas();
  desenharRecontagemLoja(aberto);
}
function progressoLoja() {
  const itens = itensRecontagem(S.bal), c = {};
  for (const it of itens) c[it.sl] = (c[it.sl] || 0) + 1;
  const p = s => c[s] || 0;
  if ($('progLoja')) $('progLoja').innerHTML = `<div class="prog-loja">
    <span><b>${p('RECONTAR') + p('RECONTAR DE NOVO')}</b>para recontar</span>
    <span><b>${p('FALTA FOTO')}</b>faltando foto</span>
    <span><b>${p('ENVIADO')}</b>enviados</span>
    <span><b>${p('CONFERIDO')}</b>conferidos</span>
    ${p('RECONTAR DE NOVO') ? `<span style="border-color:var(--down)"><b>${p('RECONTAR DE NOVO')}</b>recusados — recontar de novo</span>` : ''}</div>`;
}
function desenharRecontagemLoja(aberto) {
  const b = S.bal, f = S.filtro;
  const todos = itensRecontagem(b).filter(it => it.sl !== 'EXPLICADO')
    .sort((x, y) => (PEND_LOJA.includes(y.sl) - PEND_LOJA.includes(x.sl)) || grupoCurto(x.g).localeCompare(grupoCurto(y.g)) || x.d.localeCompare(y.d));
  const q = f.q.trim().toUpperCase();
  const lista = todos.filter(it => (!f.pend || PEND_LOJA.includes(it.sl)) && (!q || (it.d + ' ' + it.c + ' ' + it.b + ' ' + it.r).toUpperCase().includes(q)));
  carregarFotosSite();
  $('sub').innerHTML = `
    <div class="toolbar noprint">
      <input class="inp grow" id="rQ" placeholder="Buscar código, descrição, referência…" value="${esc(f.q)}"/>
      <label class="muted" style="display:flex;gap:5px;align-items:center"><input type="checkbox" id="rPend" ${f.pend ? 'checked' : ''}/> só pendentes</label>
      <span class="muted">${lista.length} de ${todos.length} itens</span>
      <span id="hBarra"></span>
    </div>
    <div class="mcards">${lista.map(cartaoLoja(aberto)).join('') || '<div class="empty">Nada com esse filtro.</div>'}</div>`;
  const nc = naoCadastrados(b);
  if (nc.length) $('sub').insertAdjacentHTML('beforeend', `
    <h4 style="margin:16px 0 4px">Códigos não cadastrados (${nc.length})</h4>
    <div class="hint" style="margin-bottom:8px">Lidos, mas não existem no Microvix: etiqueta errada ou leitura errada. Ache a peça pelo código e leia a etiqueta da loja.</div>
    <div class="tbl-wrap" style="max-width:420px"><table class="tbl"><thead><tr><th>Código lido</th><th class="n">Peças</th></tr></thead>
    <tbody>${nc.map(it => `<tr><td style="user-select:all">${esc(it.b)}</td><td class="n">${fInt(it.l)}</td></tr>`).join('')}</tbody></table></div>`);
  iniciarHistorico();
  $('rPend').onchange = e => { f.pend = e.target.checked; desenharRecontagemLoja(aberto); };
  let tq; $('rQ').oninput = e => { clearTimeout(tq); tq = setTimeout(() => { f.q = e.target.value; desenharRecontagemLoja(aberto); const el = $('rQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 300); };
  document.querySelectorAll('#sub input.rc, #sub input.ob, #sub textarea.ob').forEach(el => el.onchange = () => salvarItem(el));
}
const textoLoja = it => contouZero(it) && !(it.fotos || []).length && S.bal?.exigeFoto && ({
  'ENVIADO': 'Enviado com 0 peças, sem foto. O escritório vai conferir.',
  'RECONTAR DE NOVO': 'O escritório recusou o 0. Procure de novo: se achar, corrija a quantidade e tire a foto; se não achar, escreva na observação onde procurou.',
}[it.sl]) || ({
  'FALTA FOTO': 'Falta a foto das peças com o código aparente — sem ela a recontagem não vale.',
  'RECONTAR DE NOVO': 'O escritório recusou a foto. Reconte, corrija a quantidade se precisar e tire uma foto nova.',
  'ENVIADO': 'Enviado. O escritório vai conferir a foto.',
}[it.sl] || '');
const cartaoLoja = aberto => it => {
  const k = esc(it.c || it.b);
  const podeMexer = aberto && it.sl !== 'CONFERIDO';
  return `<div class="linha-item mcard" data-k="${k}">
    <div class="mcard-top"><span class="mcard-cod">${esc(it.c || it.b)}</span><span class="stc"><span class="${stCls(it.sl)}">${it.sl}</span></span></div>
    <div class="mcard-grupo muted">${esc(grupoCurto(it.g))}</div>
    <div class="mcard-prod">${exemploProduto(it)}<div class="mcard-desc">${esc(it.d)}${it.r ? `<div class="mcard-ref">Ref. ${esc(it.r)}</div>` : ''}${histBt(it)}</div></div>
    <div class="mcard-nums"><span>Estoque <b>${fInt(it.e)}</b></span><span>Lido <b>${fInt(it.l)}</b></span>${it.np ? `<span>Em trânsito <b>${fInt(it.np)}</b></span><span>Deve ter na loja <b style="color:var(--accent)">${fInt(Math.max(0, it.e - it.np))}</b></span>` : ''}</div>
    ${it.tf ? `<div class="mcard-grupo muted">${fInt(it.tf)} peça(s) chegaram por transferência/nota nos últimos dias — confira se estão na loja.</div>` : ''}
    ${it.cf && it.cf.ok === false && it.cf.motivo ? `<div class="motivo">Recusado: ${esc(it.cf.motivo)}</div>` : ''}
    ${podeMexer ? `<div class="mcard-inp"><input class="inp rc" inputmode="numeric" placeholder="Contei" data-k="${k}" value="${vazio(it.rc) ? '' : it.rc}"/>
      <input class="inp ob" placeholder="Observação" data-k="${k}" value="${esc(it.ob || '')}" maxlength="300"/></div>`
      : (vazio(it.rc) ? '' : `<div class="mcard-desc">Contei: <b>${it.rc}</b> ${esc(it.ob || '')}</div>`)}
    <div class="mcard-fotos">${botaoFotos(it, podeMexer, true)}${(it.fotos || []).map(f => `<img class="mini" loading="lazy" src="${urlFoto(f)}" data-galeria="${k}" alt="foto"/>`).join('')}</div>
    <div class="falta-foto">${textoLoja(it)}</div>
  </div>`;
};
// Depois de salvar/enviar foto na tela da loja: troca o card pelo novo, mantendo o foco
function atualizarCartaoLoja(it) {
  const tr = document.querySelector(`.linha-item[data-k="${CSS.escape(it.c || it.b)}"]`);
  if (!tr) return;
  tr.querySelector('.stc').innerHTML = `<span class="${stCls(it.sl)}">${it.sl}</span>`;
  const box = tr.querySelector('.mcard-fotos');
  const podeMexer = S.bal.status === 'recontagem' && it.sl !== 'CONFERIDO';
  if (box) box.innerHTML = botaoFotos(it, podeMexer, true) + (it.fotos || []).map(f => `<img class="mini" loading="lazy" src="${urlFoto(f)}" data-galeria="${esc(it.c || it.b)}" alt="foto"/>`).join('');
  const ff = tr.querySelector('.falta-foto'); if (ff) ff.textContent = textoLoja(it);
  progressoLoja();
}

// ── Escritório: conferência na tela da foto ──────────────────────────────
// Números do item + "Quantidade conferida" (já com o que a loja contou). Aprovar
// com outro número grava o do escritório; aprovar com o mesmo só confirma a foto.
function blocoConferencia(it) {
  const dif = vazio(it.rc) ? null : Number(it.rc) - it.e;
  return `<div class="c-bloco">
    <div style="font-size:24px;font-weight:800;color:#fff">${esc(it.c || it.b)}</div>
    <div style="color:#ddd">${esc(it.d)}${it.r ? ' · Ref. ' + esc(it.r) : ''}</div>
    <div class="c-num" style="margin:6px 0"><span>Estoque <b>${fInt(it.e)}</b></span><span>Lido <b>${fInt(it.l)}</b></span>
      <span>Loja contou <b>${vazio(it.rc) ? '—' : it.rc}</b></span>
      ${dif === null ? '' : `<span>Diferença <b style="color:${dif ? '#f88' : '#8f8'}">${fInt(dif)}</b></span>`}
      <span>Status <b style="font-size:14px">${esc(status(it))}</b></span></div>
    ${it.ob ? `<div style="color:#ccc;margin-bottom:6px">Obs.: ${esc(it.ob)}</div>` : ''}
    ${S.bal.status === 'recontagem' ? `<div class="c-acoes" style="align-items:center;flex-wrap:wrap">
      <label style="color:#ddd;display:flex;gap:8px;align-items:center">Quantidade conferida
        <input class="inp" id="cQtd" inputmode="numeric" value="${vazio(it.rc) ? '' : it.rc}" style="width:90px;font-size:20px;font-weight:800;text-align:center"/></label>
      <button class="btn primary" data-c="ok">✓ Aprovar</button><button class="btn danger" data-c="nao">✗ Recusar</button>
      ${'{PULAR}'}</div>` : ''}
  </div>`;
}
// Grava a decisão. Devolve false se o usuário desistiu (cancelou o motivo).
async function aplicarConferencia(it, acao, qtdTxt) {
  const k = it.c || it.b;
  let motivo = '';
  if (acao === 'ok') {
    const t = String(qtdTxt ?? '').trim();
    if (!/^\d+$/.test(t)) throw new Error('Digite a quantidade conferida (número inteiro).');
    const q = Number(t);
    if (vazio(it.rc) || q !== Number(it.rc)) {
      const j = await api(`/api/balancos/${S.bal.id}/itens`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: [{ k, rc: q, ob: it.ob || '' }] }) });
      it.rc = q; it.re = true; S.bal.resumo = j.resumo;
    }
  } else {
    motivo = prompt('Motivo da recusa (a loja vê):', contouZero(it) && !(it.fotos || []).length ? 'Procure de novo' : 'Código não aparece na foto');
    if (motivo === null) return false;
  }
  const j = await api(`/api/balancos/${S.bal.id}/conferir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, ok: acao === 'ok', motivo }) });
  it.cf = j.cf; S.bal.resumo = j.resumo;
  return true;
}

// ── Escritório: fila de fotos a conferir ─────────────────────────────────
function conferirFotos(chaves, i = 0) {
  document.querySelectorAll('#galeria').forEach(x => x.remove());
  if (i >= chaves.length) { desenharDetalhe(); return; }
  const it = S.bal.itens.find(x => (x.c || x.b) === chaves[i]);
  if (!it) return conferirFotos(chaves, i + 1);
  const g = document.createElement('div');
  g.id = 'galeria'; g.setAttribute('data-conf', '1');
  const box = document.createElement('div'); box.id = 'conf';
  g.innerHTML = `<div class="g-top"><b>Conferir foto ${i + 1} de ${chaves.length}</b><button class="btn" data-fechar>Fechar</button></div>`;
  box.innerHTML = `<div class="g-fotos">
      <div style="width:100%">${blocoConferencia(it).replace('{PULAR}', '<button class="btn" data-c="pular">Pular</button>')}</div>
      ${(it.fotos || []).length ? '' : '<div style="color:#ddd">Sem foto: a loja contou 0 (não achou o produto).</div>'}
      ${(it.fotos || []).map(f => `<figure><img src="${urlFoto(f)}" alt="foto"/><figcaption>${esc(f.por)} · ${new Date(f.tirada || f.em).toLocaleString('pt-BR')}</figcaption></figure>`).join('')}
    </div>`;
  g.appendChild(box);
  g.onclick = async e => {
    if (e.target === g || e.target.dataset.fechar !== undefined) { g.remove(); desenharDetalhe(); return; }
    const acao = e.target.dataset.c;
    if (!acao) return;
    if (acao === 'pular') return conferirFotos(chaves, i + 1);
    e.target.disabled = true;
    try {
      if (await aplicarConferencia(it, acao, g.querySelector('#cQtd')?.value)) conferirFotos(chaves, i + 1);
      else e.target.disabled = false;
    } catch (err) { alert(err.message); e.target.disabled = false; }
  };
  document.body.appendChild(g);
}

function desenharDetalhe() {
  if (S.bal?.cega) return desenharLoja();
  const b = S.bal, r = b.resumo, esc_ = S.escritorio;
  const aberto = b.status === 'recontagem';
  const pronto = !!b.itens && b.status !== 'processando';
  const base = '/api/balancos/' + b.id;
  const botoes = [
    `<button class="btn" id="dVoltar">← Voltar</button>`,
    `<span class="det-title">${esc(b.lojaLabel)} · ${dBR(b.data)}${b.hora ? ' ' + b.hora : ''}</span>`,
    `<span class="badge ${b.status}">${STATUS_LBL[b.status] || b.status}</span>`,
    `<span class="grow"></span>`,
    pronto && b.temPdf ? `<a class="btn" href="${base}/pdf" target="_blank">Lista de Críticas (PDF)</a>` : '',
    pronto ? `<a class="btn" href="${base}/planilha">Planilha de recontagem</a>` : '',
    pronto && aberto ? `<button class="btn" id="dImportar">Importar planilha</button>` : '',
    pronto && esc_ && b.temLeitura ? `<a class="btn" href="${base}/txt">TXT corrigido</a>` : '',
    esc_ && aberto ? `<button class="btn ${b.ajustadoMicrovix ? 'ok' : ''}" id="dAjustado" title="${b.ajustadoMicrovix ? `Marcado por ${esc(b.ajustadoMicrovix.por)} em ${new Date(b.ajustadoMicrovix.em).toLocaleString('pt-BR')} — clique para desmarcar` : 'Marque depois de lançar o ajuste de estoque no Microvix'}">${b.ajustadoMicrovix ? '✓ Ajustado no Microvix' : 'Marcar ajustado no Microvix'}</button>` : '',
    esc_ && aberto ? `<button class="btn primary" id="dFinalizar" ${b.ajustadoMicrovix ? '' : 'disabled title="Marque como ajustado no Microvix antes de finalizar"'}>Finalizar</button>` : '',
    esc_ && b.status === 'finalizado' ? `<button class="btn" id="dReabrir">Reabrir</button>` : '',
  ].join('');

  let corpo = '';
  if (b.status === 'processando') {
    corpo = `<div class="proc"><span class="spin"></span><div><b>Processando…</b><div class="muted">${esc(b.etapa || '')}</div></div></div>`;
  } else if (b.status === 'erro' && !b.itens) {
    corpo = `<div class="aviso erro">${esc(b.erro || 'Erro')}</div>` + (esc_ ? `<button class="btn primary" id="dReproc2">Reprocessar</button>` : '');
  } else {
    const t = r.total;
    const avisos = [];
    if (b.status === 'erro') avisos.push(`<div class="aviso erro">${esc(b.erro)}</div>`);
    if (b.origem === 'planilha') avisos.push(`<div class="aviso">Importado da planilha <b>${esc(b.arquivoNome)}</b>: só os itens com diferença${b.duplicadasRemovidas ? ` (${b.duplicadasRemovidas} linhas repetidas do export foram ignoradas)` : ''}.${b.temLeitura ? '' : ' Sem o TXT da leitura, não há reprocessamento nem TXT corrigido.'}</div>`);
    if (naoCadastrados(b).length) avisos.push(`<div class="aviso">${naoCadastrados(b).length} código(s) lido(s) não existem no Microvix — ficam fora da recontagem, na lista <b>Códigos não cadastrados</b> no fim da aba Recontagem.</div>`);
    if (b.leitura?.invalidas?.length) avisos.push(`<div class="aviso">${b.leitura.invalidas.length} linha(s) do arquivo não foram entendidas (ex.: linha ${b.leitura.invalidas[0].linha}: "${esc(b.leitura.invalidas[0].texto)}").</div>`);
    const entregues = situacaoNotas(b).filter(n => n.sit === 'entregue' && !n.baixa && !n.excluida);
    if (entregues.length) avisos.push(`<div class="aviso">🧾 ${entregues.length === 1 ? 'A nota' : 'As notas'} ${entregues.map(n => '<b>' + esc(n.numero) + '</b>').join(', ')}
      ${entregues.length === 1 ? 'está' : 'estão'} pendente${entregues.length === 1 ? '' : 's'} no Recebimento de NF, mas os produtos foram contados sem falta: sinal de que já ${entregues.length === 1 ? 'foi entregue' : 'foram entregues'}.
      Veja em <b>Resumo das diferenças</b>.</div>`);
    if (b.status === 'finalizado') avisos.push(`<div class="aviso" style="border-left-color:var(--up)">Finalizado por ${esc(b.finalizadoPor)} em ${new Date(b.finalizadoEm).toLocaleString('pt-BR')}. Para lançar mais recontagens, reabra.</div>`);
    corpo = avisos.join('') + `
      <div class="kpis">
        ${b.origem === 'planilha' ? '' : `<div class="kpi"><div class="lb">Peças lidas</div><div class="vl">${fInt(r.pecasLidas)}</div><div class="sb">${fInt(b.leitura?.codigos)} códigos no arquivo</div></div>
        <div class="kpi"><div class="lb">Estoque no sistema</div><div class="vl">${fInt(r.pecasEstoque)}</div><div class="sb">${fInt(r.naoLidos)} itens com saldo não lidos</div></div>`}
        <div class="kpi"><div class="lb">Diferença (peças)</div><div class="vl ${cls(t.pecasDif)}">${fInt(t.pecasDif)}</div><div class="sb">após recontagem: ${fInt(t.pecasDifFinal)}</div></div>
        <div class="kpi"><div class="lb">Impacto sistema</div><div class="vl ${cls(t.impactoSistema)}">${fRS(t.impactoSistema)}</div><div class="sb">${t.itens} itens divergentes</div></div>
        <div class="kpi"><div class="lb">Impacto confirmado</div><div class="vl ${cls(t.impactoConfirmado)}">${fRS(t.impactoConfirmado)}</div><div class="sb">${t.recontados} recontados (${t.ok} OK · ${t.divergentes} div.)</div></div>
        <div class="kpi"><div class="lb">A apurar</div><div class="vl ${cls(t.impactoApurar)}">${fRS(t.impactoApurar)}</div><div class="sb">${t.pendentes} pendentes · ${t.explicadoVenda} venda · ${t.explicadoTransito} trânsito</div></div>
      </div>
      <div class="tabs noprint">
        <button class="tab ${S.sub === 'recont' ? 'active' : ''}" data-sub="recont">Recontagem</button>
        <button class="tab ${S.sub === 'resumo' ? 'active' : ''}" data-sub="resumo">Resumo das diferenças</button>
        ${esc_ || b.trocas?.enviadaEm ? `<button class="tab ${S.sub === 'trocas' ? 'active' : ''}" data-sub="trocas">Trocas${b.trocas?.itens?.length ? ` (${b.trocas.itens.filter(t => !t.feita).length})` : ''}</button>` : ''}
        ${esc_ ? `<button class="tab ${S.sub === 'cfg' ? 'active' : ''}" data-sub="cfg">Configurar</button>` : ''}
      </div>
      <div id="sub"></div>`;
  }
  $('vDet').innerHTML = `<div class="det-head">${botoes}</div>${corpo}`;
  $('dVoltar').onclick = voltar;
  $('dImportar') && ($('dImportar').onclick = () => $('impArq').click());
  $('dFinalizar') && ($('dFinalizar').onclick = finalizar);
  $('dAjustado') && ($('dAjustado').onclick = () => {
    const marcar = !b.ajustadoMicrovix;
    if (marcar && !confirm('O ajuste de estoque já foi lançado no Microvix?')) return;
    patchBal({ ajustadoMicrovix: marcar });
  });
  $('dReabrir') && ($('dReabrir').onclick = () => patchBal({ status: 'recontagem' }));
  $('dReproc2') && ($('dReproc2').onclick = () => reprocessar({}));
  document.querySelectorAll('[data-sub]').forEach(el => el.onclick = () => { S.sub = el.dataset.sub; desenharDetalhe(); });
  if ($('sub')) ({ recont: desenharRecontagem, resumo: desenharResumo, cfg: desenharConfig, trocas: desenharTrocas })[S.sub]();
}

// ── Aba Recontagem ─────────────────────────────────────────────────────────
function desenharRecontagem() {
  const b = S.bal, f = S.filtro;
  const aberto = b.status === 'recontagem';
  const todos = itensRecontagem(b).sort((x, y) => grupoCurto(x.g).localeCompare(grupoCurto(y.g)) || x.d.localeCompare(y.d));
  const grupos = [...new Set(todos.map(it => grupoCurto(it.g)))];
  const q = f.q.trim().toUpperCase();
  const lista = todos.filter(it => (!f.g || grupoCurto(it.g) === f.g) && (!f.st || status(it) === f.st)
    && (!f.pend || difFinal(it) === null) && (!q || (it.d + ' ' + it.c + ' ' + it.b + ' ' + it.r).toUpperCase().includes(q)));
  const sts = ['A RECONTAR', 'SEM FOTO', 'A CONFERIR', 'RECUSADO', 'VENDA PARCIAL', 'VER VENDA', 'VER TRÂNSITO', 'OK', 'DIVERGENTE', 'TROCA', 'AJUSTAR'];
  const tot = lista.reduce((a, it) => { const x = abat(it); a.e += it.e; a.l += it.l; a.i += (it.l - it.e) * it.p; a.tr += x.tr; a.vd += x.venda; a.lq += x.liquida; return a; }, { e: 0, l: 0, i: 0, tr: 0, vd: 0, lq: 0 });
  $('sub').innerHTML = `
    <div class="toolbar noprint">
      <select class="sel" id="rG"><option value="">Todos os setores</option>${grupos.map(g => `<option ${g === f.g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <select class="sel" id="rSt"><option value="">Todos os status</option>${sts.map(s => `<option ${s === f.st ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <input class="inp grow" id="rQ" placeholder="Buscar descrição, código, referência…" value="${esc(f.q)}"/>
      <label class="muted" style="display:flex;gap:5px;align-items:center"><input type="checkbox" id="rPend" ${f.pend ? 'checked' : ''}/> só pendentes</label>
      <span class="muted">${lista.length} de ${todos.length} itens</span>
      ${S.escritorio ? '<span id="hBarra" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap"></span>' : ''}
      ${S.escritorio && aberto && todos.some(aConferir) ? `<button class="btn primary" id="rConferir">Conferir fotos (${todos.filter(aConferir).length})</button>` : ''}
    </div>
    ${matchMedia('(max-width: 640px)').matches && carregarFotosSite()
      ? `<div class="mcards">${lista.map(cartaoRecont(aberto)).join('') || '<div class="empty">Nada com esse filtro.</div>'}</div>`
      : `<div class="tbl-wrap"><table class="tbl fit"><colgroup><col style="width:5.5%"><col style="width:6%"><col><col style="width:7%">
      <col style="width:3.5%"><col style="width:3.5%"><col style="width:3%"><col style="width:3.6%"><col style="width:3.4%"><col style="width:3.6%">
      <col style="width:5%"><col style="width:5.5%"><col style="width:4.5%">
      <col style="width:3.2%"><col style="width:9%"><col style="width:16%"></colgroup><thead><tr>
      <th>Setor</th><th>Código</th><th>Descrição</th><th>Referência</th><th class="n">Estoque</th><th class="n">Balanço</th><th class="n">Dif.</th>
      <th class="n" title="Peças em trânsito que explicam a falta: nota pendente no Recebimento de NF (confiável) ou transferência/nota recente (a loja confirma)">Trânsito</th>
      <th class="n" title="Peças vendidas no período da contagem que explicam a sobra">Venda</th>
      <th class="n" title="Diferença depois de abater trânsito e venda: o que ainda falta explicar">Dif. líquida</th>
      <th class="n">Preço</th><th class="n">Impacto</th><th class="c">Recontada</th><th class="n">Dif. final</th><th>Status</th><th>Observação</th>
    </tr></thead><tbody>${lista.map(linhaRecont(aberto)).join('') || '<tr><td colspan="16" class="empty">Nada com esse filtro.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4">Total do filtro</td><td class="n">${fInt(tot.e)}</td><td class="n">${fInt(tot.l)}</td><td class="n">${fInt(tot.l - tot.e)}</td><td class="n">${fInt(tot.tr)}</td><td class="n">${fInt(tot.vd)}</td><td class="n ${cls(tot.lq)}"><b>${fInt(tot.lq)}</b></td><td></td>
      <td class="n ${cls(tot.i)}">${fRS(tot.i)}</td><td colspan="4"></td></tr></tfoot></table></div>`}`;
  const nc = naoCadastrados(b);
  if (nc.length) $('sub').insertAdjacentHTML('beforeend', `
    <h4 style="margin:16px 0 4px">Códigos não cadastrados (${nc.length})</h4>
    <div class="hint" style="margin-bottom:8px">Lidos, mas não existem no Microvix: etiqueta errada ou leitura errada. Ficam fora da comparação — achar a peça pelo código e ler a etiqueta da loja.</div>
    <div class="tbl-wrap" style="max-width:420px"><table class="tbl"><thead><tr><th>Código lido</th><th class="n">Peças</th></tr></thead>
    <tbody>${nc.map(it => `<tr><td style="user-select:all">${esc(it.b)}</td><td class="n">${fInt(it.l)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="n">${fInt(nc.reduce((a, it) => a + it.l, 0))}</td></tr></tfoot></table></div>`);
  iniciarHistorico();
  if ($('rConferir')) $('rConferir').onclick = () => conferirFotos(todos.filter(aConferir).map(it => it.c || it.b));
  $('rG').onchange = e => { f.g = e.target.value; desenharRecontagem(); };
  $('rSt').onchange = e => { f.st = e.target.value; desenharRecontagem(); };
  $('rPend').onchange = e => { f.pend = e.target.checked; desenharRecontagem(); };
  let tq; $('rQ').oninput = e => { clearTimeout(tq); tq = setTimeout(() => { f.q = e.target.value; desenharRecontagem(); const el = $('rQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 300); };
  document.querySelectorAll('#sub input.rc, #sub input.ob, #sub textarea.ob').forEach(el => el.onchange = () => salvarItem(el));
  document.querySelectorAll('#sub select.stsel').forEach(el => el.onchange = () => salvarStatus(el));
  // Enter no campo da recontagem pula para o próximo item
  document.querySelectorAll('#sub input.rc').forEach((el, i, arr) => el.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); arr[i + 1]?.focus(); arr[i + 1]?.select(); }
  });
}

// ── Histórico de movimento (a loja vê sem os valores) ────────────────────────────────────
// Pintado direto no DOM: chega depois da tabela e não pode tirar o foco de quem digita.
const histBt = it => it.c ? ` <button type="button" class="hbt hidden" data-h="${esc(it.c)}"></button>` : '';
const H = { chave: '', d: null, etapa: '', erro: '', rodando: false, abertos: new Set(), todos: false, timer: null };
function iniciarHistorico() {
  const chave = S.bal.id + '|' + (S.bal.processadoEm || '');
  if (H.chave !== chave) {
    clearTimeout(H.timer);
    Object.assign(H, { chave, d: null, etapa: '', erro: '', rodando: true, abertos: new Set(), todos: false });
    carregarHistorico();
  }
  pintarHistorico();
}
async function carregarHistorico() {
  const chave = H.chave, id = chave.split('|')[0];
  clearTimeout(H.timer);
  let j;
  try { j = await api(`/api/balancos/${id}/historico`); } catch (e) { j = { erro: e.message }; }
  if (H.chave !== chave) return;
  H.rodando = !!j.rodando; H.etapa = j.etapa || ''; H.erro = j.erro || '';
  if (j.historico) H.d = j.historico;
  if (H.rodando && S.bal?.id === id) H.timer = setTimeout(carregarHistorico, 4000);
  else if (H.rodando) H.chave = ''; // saiu do balanço: recomeça quando voltar
  pintarHistorico();
}
async function pedirHistorico(meses) {
  try {
    await api(`/api/balancos/${S.bal.id}/historico`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meses }) });
    H.rodando = true; H.etapa = 'Histórico: na fila…';
    pintarHistorico();
    carregarHistorico();
  } catch (e) { alert(e.message); }
}
function tabelaHistorico(cod) {
  const x = H.d.itens[cod];
  const v = n => n === null || n === undefined ? '–' : fInt(n);
  // Mais novo em cima: é o que explica a diferença
  const ls = x.l.slice().reverse();
  return `<div class="hist"><table><thead><tr><th>Lançamento</th><th>Emissão</th><th>Doc./Série</th><th>Tipo</th><th>Cliente/Fornec.</th><th class="n">Qtd.</th><th class="n">Saldo</th>${S.escritorio ? '<th class="n">Valor unit.</th>' : ''}<th>CFOP</th></tr></thead><tbody>
    ${ls.map(m => `<tr class="${m.la > S.bal.data ? 'depois' : ''}"><td>${dBR(m.la)} ${esc(m.h)}</td><td>${dBR(m.em)}</td><td>${esc(m.doc)}/${esc(m.se)}</td><td>${esc(m.tp)}</td>
      <td>${m.cc ? esc([m.cc, H.d.nomes[m.cc]].filter(Boolean).join('-')) : ''}</td><td class="n ${cls(m.q)}">${m.q > 0 ? '+' : '−'}${fInt(Math.abs(m.q))}</td><td class="n"><b>${v(m.s)}</b></td>${S.escritorio ? `<td class="n">${fRS(m.vu)}</td>` : ''}<td>${esc(m.cf)}</td></tr>`).join('')
      || '<tr><td colspan="9" class="muted">Sem movimento no período.</td></tr>'}
    </tbody></table><div class="muted">Saldo antes de ${dBR(H.d.ini)}: ${v(x.a)}${ls.some(m => m.la > S.bal.data) ? ' · em itálico, depois da data do balanço' : ''}</div></div>`;
}
function pintarHistorico() {
  const barra = $('hBarra');
  if (!barra || !S.bal || !H.chave.startsWith(S.bal.id + '|')) return;
  const d = H.d;
  const erro = H.erro ? `<span class="neg">${esc(H.erro)}</span>` : '';
  barra.innerHTML = H.rodando ? `<span class="muted">${esc(H.etapa || 'Carregando histórico…')}</span>`
    : !S.escritorio ? (d ? `<button class="btn" id="hTodos">${H.todos ? 'Ocultar históricos' : 'Mostrar históricos'}</button>` : '')
    : !d ? `<button class="btn" id="hBuscar">Buscar histórico</button>${erro}`
    : `<button class="btn" id="hTodos">${H.todos ? 'Ocultar históricos' : 'Mostrar históricos'}</button>
      <button class="btn" id="hAtual" title="Busca de novo no Microvix. Última busca: ${new Date(d.em).toLocaleString('pt-BR')}, desde ${dBR(d.ini)}">↻</button>
      ${d.meses < 84 ? '<button class="btn" id="hMais" title="Busca 7 anos no Microvix: demora alguns minutos">Histórico completo</button>' : ''}
      ${d.falhas.length ? `<span class="neg" title="${d.falhas.map(f => f.map(dBR).join(' a ')).join(', ')}">${d.falhas.length} período(s) sem resposta</span>` : ''}${erro}`;
  if ($('hBuscar')) $('hBuscar').onclick = () => pedirHistorico(24);
  if ($('hAtual')) $('hAtual').onclick = () => pedirHistorico(d.meses);
  if ($('hMais')) $('hMais').onclick = () => pedirHistorico(84);
  if ($('hTodos')) $('hTodos').onclick = () => { H.todos = !H.todos; H.abertos.clear(); pintarHistorico(); };
  document.querySelectorAll('#sub .hist-linha').forEach(el => el.remove());
  document.querySelectorAll('#sub .hbt').forEach(bt => {
    const cod = bt.dataset.h, x = d?.itens[cod];
    bt.classList.toggle('hidden', !x);
    if (!x) return;
    const aberto = H.todos !== H.abertos.has(cod); // abertos = exceções ao "todos"
    bt.textContent = `${aberto ? '▾' : '▸'} Histórico (${x.l.length})`;
    bt.onclick = () => { if (!H.abertos.delete(cod)) H.abertos.add(cod); pintarHistorico(); };
    if (!aberto) return;
    const linha = bt.closest('.linha-item');
    if (linha.tagName === 'TR') linha.insertAdjacentHTML('afterend', `<tr class="hist-linha"><td colspan="16">${tabelaHistorico(cod)}</td></tr>`);
    else linha.insertAdjacentHTML('beforeend', `<div class="hist-linha">${tabelaHistorico(cod)}</div>`);
  });
}

// Trânsito (nota pendente em negrito; transferência/nota recente em itálico, a confirmar), venda e o que sobra
function celAbat(it) {
  const a = abat(it);
  const tr = a.tr ? `<span title="${a.trNota ? a.trNota + ' por nota pendente' : ''}${a.trNota && a.trOutros ? ' · ' : ''}${a.trOutros ? a.trOutros + ' por transferência/nota recente (a loja confirma)' : ''}"
    style="${a.trOutros && !a.trNota ? 'font-style:italic' : 'font-weight:700'}">${fInt(a.tr)}${a.trOutros ? '?' : ''}</span>` : '';
  return `<td class="n">${tr}</td><td class="n">${a.venda ? fInt(a.venda) : ''}</td>
    <td class="n dif-l ${cls(a.liquida)}" style="font-weight:700">${a.liquida ? fInt(a.liquida) : '0'}</td>`;
}
const linhaRecont = aberto => it => {
  const k = esc(it.c || it.b);
  const s = status(it);
  const dif = it.l - it.e;
  const difF = fDifF(it);
  const quem = it.rp ? ` title="Lançado por ${esc(it.rp)} em ${new Date(it.rt).toLocaleString('pt-BR')}"` : '';
  return `<tr class="linha-item" data-k="${k}">
    <td>${esc(grupoCurto(it.g))}</td><td>${esc(it.c || it.b)}</td><td class="desc">${esc(it.d)}${it.lido ? '' : ' <span class="badge">não lido</span>'}${nfsTxt(it)}${histBt(it)}</td><td>${esc(it.r)}</td>
    <td class="n">${fInt(it.e)}</td><td class="n">${fInt(it.l)}</td><td class="n ${cls(dif)}">${fInt(dif)}</td>
    ${celAbat(it)}
    <td class="n">${fRS(it.p)}</td><td class="n ${cls(dif * it.p)}">${fRS(dif * it.p)}</td>
    <td class="c">${aberto ? `<input class="inp rc" inputmode="numeric" data-k="${k}" value="${vazio(it.rc) ? '' : it.rc}"${quem}/>` : (vazio(it.rc) ? '' : `<b${quem}>${it.rc}</b>`)}</td>
    <td class="n dif-f">${difF}</td><td class="stc">${celStatus(it, aberto)}</td>
    <td><div class="cel-ob">${aberto ? `<textarea class="inp ob" data-k="${k}" rows="1" maxlength="300">${esc(it.ob || '')}</textarea>` : `<span class="ob-txt">${esc(it.ob || '')}</span>`}${botaoFotos(it, aberto, false)}</div></td></tr>`;
};

// Celular: um cartão por item, com a recontagem à mão (a tabela pede rolagem lateral)
const cartaoRecont = aberto => it => {
  const k = esc(it.c || it.b);
  const s = status(it);
  const dif = it.l - it.e;
  return `<div class="linha-item mcard" data-k="${k}">
    <div class="mcard-top"><span class="mcard-cod">${esc(it.c || it.b)}</span><span class="stc"><span class="${stCls(s)}">${s}</span></span></div>
    <div class="mcard-grupo muted">${esc(grupoCurto(it.g))}</div>
    <div class="mcard-prod">${exemploProduto(it)}<div class="mcard-desc">${esc(it.d)}${it.lido ? '' : ' <span class="badge">não lido</span>'}
      ${it.r ? `<div class="mcard-ref">Ref. ${esc(it.r)}</div>` : ''}${nfsTxt(it)}${histBt(it)}</div></div>
    <div class="mcard-nums"><span>Estoque <b>${fInt(it.e)}</b></span><span>Lido <b>${fInt(it.l)}</b></span><span>Dif. <b class="${cls(dif)}">${fInt(dif)}</b></span><span>Final <b class="dif-f">${fDifF(it)}</b></span></div>
    ${aberto ? `<div class="mcard-inp"><input class="inp rc" inputmode="numeric" placeholder="Contei" data-k="${k}" value="${vazio(it.rc) ? '' : it.rc}"/>
      <input class="inp ob" placeholder="Observação" data-k="${k}" value="${esc(it.ob || '')}" maxlength="300"/></div>`
      : (vazio(it.rc) ? '' : `<div class="mcard-desc">Recontado: <b>${it.rc}</b> ${esc(it.ob || '')}</div>`)}
    <div class="mcard-fotos">${botaoFotos(it, aberto, true)}${(it.fotos || []).map(f => `<img class="mini" loading="lazy" src="${urlFoto(f)}" data-galeria="${k}" alt="foto"/>`).join('')}</div>
    <div class="falta-foto">${semFoto(it) ? 'Falta a foto da quantidade com o código aparente — sem ela a divergência continua.' : ''}</div>
  </div>`;
};

// Escritório troca o status na mão; "automático" volta à regra
function celStatus(it, aberto) {
  const s = status(it);
  if (!S.escritorio || !aberto) return `<span class="${stCls(s)}" ${it.st ? 'title="definido à mão"' : ''}>${s}</span>`;
  const auto = statusAuto(it);
  return `<select class="stsel ${stCls(s)}" data-k="${esc(it.c || it.b)}" title="${it.st ? 'Definido à mão' : 'Automático'}">
    <option value="" ${it.st ? '' : 'selected'}>${auto} (auto)</option>
    ${STATUS_MANUAL.map(x => `<option ${it.st === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
}
async function salvarStatus(el) {
  const k = el.dataset.k, st = el.value || null;
  try {
    const j = await api(`/api/balancos/${S.bal.id}/status-item`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, st }) });
    const it = S.bal.itens.find(x => (x.c || x.b) === k);
    if (it) it.st = st;
    S.bal.resumo = j.resumo;
    el.closest('.linha-item')?.querySelector('.dif-f')?.replaceChildren(fDifF(it));
    el.closest('.stc').innerHTML = celStatus(it, true);
    document.querySelector(`.stc select[data-k="${CSS.escape(k)}"]`)?.addEventListener('change', e => salvarStatus(e.target));
    atualizarKpis();
  } catch (e) { alert(e.message); }
}

// ── Foto de exemplo (site) ou busca no Google ────────────────────────────
// Só para a loja reconhecer a peça: vem do feed do site pelo código ou pela
// referência. Sem foto no site, um atalho para o Google Imagens.
const fotosSite = { id: null, mapa: {} };
function carregarFotosSite() {
  if (fotosSite.id !== S.bal.id) {
    fotosSite.id = S.bal.id; fotosSite.mapa = {};
    api(`/api/balancos/${S.bal.id}/fotos-site`).then(m => {
      fotosSite.mapa = m || {};
      document.querySelectorAll('.mcard .ex-google[data-c]').forEach(a => {
        const url = fotosSite.mapa[a.dataset.c];
        if (url) a.outerHTML = `<img class="ex-site" loading="lazy" src="${esc(url)}" data-ampliar="${esc(url)}" alt="foto do site"/>`;
      });
    }).catch(() => {});
  }
  return true;
}
function exemploProduto(it) {
  const url = fotosSite.mapa[it.c];
  if (url) return `<img class="ex-site" loading="lazy" src="${esc(url)}" data-ampliar="${esc(url)}" alt="foto do site"/>`;
  if (!it.c) return '';
  const q = encodeURIComponent([it.d.replace(/\s+(PP|P|M|G|GG|XG|U|\d{2})$/i, ''), it.r].filter(Boolean).join(' '));
  return `<a class="ex-google" data-c="${esc(it.c)}" href="https://www.google.com/search?tbm=isch&q=${q}" target="_blank" rel="noopener">sem foto no site<br/>ver no Google</a>`;
}
document.addEventListener('click', e => {
  const url = e.target?.dataset?.ampliar;
  if (!url) return;
  document.getElementById('galeria')?.remove();
  const g = document.createElement('div');
  g.id = 'galeria';
  g.innerHTML = `<div class="g-top"><b>Foto do site (exemplo)</b><button class="btn" data-fechar>Fechar</button></div>
    <div class="g-fotos"><img src="${esc(url.replace('/300x300/', '/800x800/'))}" alt="foto do site" style="background:#fff"/></div>`;
  g.onclick = ev => { if (ev.target === g || ev.target.dataset.fechar !== undefined) g.remove(); };
  document.body.appendChild(g);
});

// ── Fotos da recontagem ───────────────────────────────────────────────────
const urlFoto = f => `/api/balancos/${S.bal.id}/fotos/${f.id}`;
function botaoFotos(it, aberto, celular) {
  const k = esc(it.c || it.b), n = (it.fotos || []).length;
  const cls = n ? 'tem' : semFoto(it) ? 'falta' : '';
  const ver = n ? `<button type="button" class="foto-btn ${cls}" data-galeria="${k}" title="Ver fotos">📷 ${n}</button>` : '';
  if (!aberto) return celular ? '' : ver;
  const tirar = `<button type="button" class="foto-btn ${n ? '' : cls}" data-foto="${k}" title="Tirar foto da quantidade com o código aparente">${celular ? '📷 Tirar foto' : '📷+'}</button>`;
  return celular ? tirar : tirar + ver;
}
function atualizarFotosItem(tr, it) {
  if (S.bal.cega) return atualizarCartaoLoja(it);
  if (!tr) return;
  const aberto = S.bal.status === 'recontagem';
  const box = tr.querySelector('.mcard-fotos');
  if (box) {
    const k = esc(it.c || it.b);
    box.innerHTML = botaoFotos(it, aberto, true) + (it.fotos || []).map(f => `<img class="mini" loading="lazy" src="${urlFoto(f)}" data-galeria="${k}" alt="foto"/>`).join('');
    tr.querySelector('.falta-foto').textContent = semFoto(it) ? 'Falta a foto da quantidade com o código aparente — sem ela a divergência continua.' : '';
  } else {
    const cel = tr.querySelector('.cel-ob');
    cel?.querySelectorAll('.foto-btn').forEach(b => b.remove());
    cel?.insertAdjacentHTML('beforeend', botaoFotos(it, aberto, false));
  }
  tr.querySelector('.stc').innerHTML = celStatus(it, aberto);
  tr.querySelector('.dif-f').textContent = fDifF(it);
}
// Reduz no celular antes de subir: lado maior 1600 px, JPEG — a foto do celular tem 3–5 MB
async function reduzir(arquivo) {
  const img = await new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => erro(new Error('o celular não abriu essa imagem. Tire a foto pela câmera, em JPEG.')); i.src = URL.createObjectURL(arquivo); });
  const esc_ = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * esc_); cv.height = Math.round(img.naturalHeight * esc_);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(img.src);
  return new Promise(ok => cv.toBlob(b => ok(b || arquivo), 'image/jpeg', 0.75));
}
const inputFoto = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
inputFoto.setAttribute('capture', 'environment');
// no DOM (oculto): alguns navegadores de celular ignoram o clique num input solto
inputFoto.hidden = true; inputFoto.id = 'inputFoto';
document.body.appendChild(inputFoto);
let fotoDoItem = null;
inputFoto.onchange = async () => {
  const arq = inputFoto.files[0], k = fotoDoItem;
  inputFoto.value = '';
  if (!arq || !k) return;
  const it = S.bal.itens.find(x => (x.c || x.b) === k);
  // Foto da galeria, tirada antes de a contagem começar, não vale
  const inicioContagem = new Date(`${S.bal.inicio || S.bal.data}T00:00:00-03:00`).getTime();
  if (arq.lastModified && arq.lastModified < inicioContagem) { alert('Essa foto é de antes da contagem. Tire uma foto nova, na hora.'); return; }
  // O código é o que importa: a gerente confirma que a etiqueta da foto é deste item
  if (!confirm(`Conferiu na etiqueta o código ${k}?\n\n${it?.d || ''}\n\nOK envia a foto. Cancelar descarta para tirar de novo.`)) return;
  const tr = document.querySelector(`.linha-item[data-k="${CSS.escape(k)}"]`);
  const btn = tr?.querySelector(`[data-foto="${CSS.escape(k)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const fd = new FormData();
    fd.append('k', k);
    fd.append('foto', await reduzir(arq), 'foto.jpg');
    if (arq.lastModified) fd.append('tirada', String(arq.lastModified));
    const j = await api(`/api/balancos/${S.bal.id}/fotos`, { method: 'POST', body: fd });
    it.fotos = j.fotos;
    if (j.item) Object.assign(it, j.item); else S.bal.resumo = j.resumo;
    atualizarFotosItem(tr, it); atualizarKpis();
  } catch (e) { alert('Não foi possível enviar a foto: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = '📷 Tentar de novo'; } }
};
function abrirGaleria(k) {
  const it = S.bal.itens.find(x => (x.c || x.b) === k);
  if (!it || !(it.fotos || []).length) return;
  const aberto = S.bal.status === 'recontagem';
  document.getElementById('galeria')?.remove();
  const g = document.createElement('div');
  g.id = 'galeria';
  g.innerHTML = `<div class="g-top"><b>${S.escritorio ? 'Foto da recontagem' : `${esc(it.c || it.b)} · ${esc(it.d)}`}</b>
      <button class="btn" data-fechar>Fechar</button></div>
    ${S.escritorio ? `<div id="conf" style="width:100%;max-width:1000px">${blocoConferencia(it).replace('{PULAR}', '')}</div>` : ''}
    <div class="g-fotos">${it.fotos.map(f => `<figure><img src="${urlFoto(f)}" alt="foto"/><figcaption>${esc(f.por)} · ${new Date(f.em).toLocaleString('pt-BR')}
      ${aberto ? ` · <a href="#" data-apagar="${f.id}" style="color:#f88">apagar</a>` : ''}</figcaption></figure>`).join('')}</div>`;
  g.onclick = async e => {
    if (e.target === g || e.target.dataset.fechar !== undefined) { g.remove(); return; }
    const acao = e.target.dataset.c;
    if (acao) {
      e.target.disabled = true;
      try {
        if (await aplicarConferencia(it, acao, g.querySelector('#cQtd')?.value)) { g.remove(); desenharDetalhe(); }
        else e.target.disabled = false;
      } catch (err) { alert(err.message); e.target.disabled = false; }
      return;
    }
    const fid = e.target.dataset.apagar;
    if (!fid) return;
    e.preventDefault();
    if (!confirm('Apagar esta foto?')) return;
    try {
      const j = await api(`/api/balancos/${S.bal.id}/fotos/${fid}`, { method: 'DELETE' });
      it.fotos = j.fotos;
      if (j.item) Object.assign(it, j.item); else S.bal.resumo = j.resumo;
      atualizarFotosItem(document.querySelector(`.linha-item[data-k="${CSS.escape(k)}"]`), it); atualizarKpis();
      g.remove(); if (it.fotos.length) abrirGaleria(k);
    } catch (err) { alert(err.message); }
  };
  document.body.appendChild(g);
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('galeria')?.remove();
  if (e.key === 'Enter' && e.target?.id === 'cQtd') { e.preventDefault(); document.querySelector('#galeria [data-c="ok"]')?.click(); }
});
document.addEventListener('click', e => {
  const t = e.target.closest?.('[data-foto],[data-galeria]');
  if (!t || t.closest('#galeria')) return;
  if (t.dataset.foto) { fotoDoItem = t.dataset.foto; inputFoto.click(); }
  else abrirGaleria(t.dataset.galeria);
});

async function salvarItem(el) {
  const k = el.dataset.k;
  const tr = el.closest('.linha-item');
  const rcEl = tr.querySelector('input.rc'), obEl = tr.querySelector('input.ob, textarea.ob');
  const rcTxt = rcEl.value.trim();
  if (rcTxt !== '' && !/^\d+$/.test(rcTxt)) { rcEl.classList.add('falhou'); rcEl.title = 'Só número inteiro'; avisoItem(tr, 'Não salvou: a quantidade é só número inteiro.'); return; }
  const body = { itens: [{ k, rc: rcTxt === '' ? null : Number(rcTxt), ob: obEl.value }] };
  [rcEl, obEl].forEach(x => x.classList.remove('salvo', 'falhou'));
  try {
    const j = await api(`/api/balancos/${S.bal.id}/itens`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const it = S.bal.itens.find(x => (x.c || x.b) === k);
    avisoItem(tr, '');
    if (it) { it.rc = body.itens[0].rc; it.ob = body.itens[0].ob; it.re = !!S.escritorio; }
    el.classList.add('salvo');
    if (S.bal.cega) { const n = (j.itens || []).find(x => (x.c || x.b) === k); if (n && it) Object.assign(it, n); atualizarCartaoLoja(it); return; }
    S.bal.resumo = j.resumo;
    // Atualiza a linha e os indicadores sem redesenhar a tabela (não perde o foco)
    { const dl = tr.querySelector('.dif-l'); if (dl && it) { const a = abat(it); dl.textContent = a.liquida ? fInt(a.liquida) : '0'; dl.className = 'n dif-l ' + cls(a.liquida); } }
    const s = status(it);
    tr.querySelector('.dif-f').textContent = fDifF(it);
    tr.querySelector('.stc').innerHTML = celStatus(it, S.bal.status === 'recontagem');
    atualizarFotosItem(tr, it);
    atualizarKpis();
  } catch (e) {
    el.classList.add('falhou'); el.title = e.message;
    // No celular não há "title": sem aviso a loja acha que salvou
    avisoItem(tr, 'Não salvou' + (e.message === 'Failed to fetch' || e.message === 'Load failed' ? ' (sem internet)' : ': ' + e.message) + '.', () => salvarItem(el));
  }
}
function avisoItem(tr, msg, repetir) {
  tr.querySelector('.nao-salvou')?.remove();
  const inp = msg && tr.querySelector('.mcard-inp');
  if (!inp) return;
  inp.insertAdjacentHTML('afterend', `<div class="motivo nao-salvou"><b>${esc(msg)}</b>${repetir ? ' <button type="button" class="btn">Salvar de novo</button>' : ''}</div>`);
  const b = tr.querySelector('.nao-salvou .btn'); if (b) b.onclick = repetir;
}

function atualizarKpis() {
  if (S.bal.cega || !S.bal.resumo) return;
  const t = S.bal.resumo.total;
  const kp = document.querySelectorAll('.kpi');
  if (kp.length < 6) return;
  const set = (i, vl, sb, c) => { kp[i].querySelector('.vl').textContent = vl; kp[i].querySelector('.vl').className = 'vl ' + (c || ''); kp[i].querySelector('.sb').textContent = sb; };
  set(2, fInt(t.pecasDif), `após recontagem: ${fInt(t.pecasDifFinal)}`, cls(t.pecasDif));
  set(4, fRS(t.impactoConfirmado), `${t.recontados} recontados (${t.ok} OK · ${t.divergentes} div.)`, cls(t.impactoConfirmado));
  set(5, fRS(t.impactoApurar), `${t.pendentes} pendentes · ${t.explicadoVenda} venda · ${t.explicadoTransito} trânsito`, cls(t.impactoApurar));
}

// ── Aba Resumo ─────────────────────────────────────────────────────────────
function desenharResumo() {
  const b = S.bal, r = b.resumo, t = r.total;
  const linha = g => `<tr><td>${esc(g.grupo)}</td><td class="n">${g.itens}</td><td class="n">${g.recontados}</td><td class="n">${g.ok}</td><td class="n">${g.divergentes}</td><td class="n">${g.pendentes}</td>
    <td class="n ${cls(g.pecasDif)}">${fInt(g.pecasDif)}</td><td class="n ${cls(g.pecasDifFinal)}">${fInt(g.pecasDifFinal)}</td>
    <td class="n ${cls(g.impactoSistema)}">${fRS(g.impactoSistema)}</td><td class="n ${cls(g.impactoConfirmado)}">${fRS(g.impactoConfirmado)}</td><td class="n ${cls(g.impactoApurar)}">${fRS(g.impactoApurar)}</td>
    <td class="n">${g.explicadoVenda}</td><td class="n">${fInt(g.vendas)}</td><td class="n">${g.explicadoTransito}</td><td class="n">${fInt(g.transito)}</td></tr>`;
  const divergencias = itensRecontagem(b).map(it => { const q = difFinal(it) ?? it.l - it.e; return { it, q, imp: q * it.p }; })
    .filter(x => x.q).sort((a, c) => grupoCurto(a.it.g).localeCompare(grupoCurto(c.it.g)) || Math.abs(c.imp) - Math.abs(a.imp));
  const totQ = divergencias.reduce((a, x) => a + x.q, 0), totImp = divergencias.reduce((a, x) => a + x.imp, 0);
  const jan = b.janelaTransito || {};
  $('sub').innerHTML = `
    <div class="toolbar noprint"><span class="muted">${b.janelaVendas && b.janelaVendas.ini !== b.janelaVendas.fim ? `Vendas de ${dBR(b.janelaVendas.ini)} a ${dBR(b.janelaVendas.fim)}` : 'Vendas do dia da contagem'} · entradas de ${dBR(jan.ini)} a ${dBR(jan.fim)} e das notas pendentes contam como trânsito.</span><span class="grow"></span><button class="btn" onclick="window.print()">Imprimir</button></div>
    <div class="box" style="margin-bottom:12px"><b>${esc(b.lojaLabel)} — balanço de ${dBR(b.data)}${b.hora ? ' ' + b.hora : ''}</b> · mês ${esc(mesBR(b.mes))}<br/>
      <span class="muted">Leitura de ${fInt(r.pecasLidas)} peças contra ${fInt(r.pecasEstoque)} no sistema. ${t.itens} itens com diferença
      (${fInt(t.pecasDif)} peças, ${fRS(t.impactoSistema)}). Depois da recontagem: ${fInt(t.pecasDifFinal)} peças —
      ${fRS(t.impactoConfirmado)} confirmado e ${fRS(t.impactoApurar)} ainda a apurar (${t.pendentes} itens sem recontagem).</span>
      ${t.abNota || t.abTransito || t.abVenda ? `<div style="margin-top:6px">Abatido da diferença: <b>${fInt(t.abNota)}</b> peça(s) por nota pendente no Recebimento de NF,
        <b>${fInt(t.abTransito)}</b> por transferência/nota recente (a loja confirma) e <b>${fInt(t.abVenda)}</b> por venda no período.
        Diferença líquida: <b class="${cls(t.difLiquida)}">${fInt(t.difLiquida)}</b> peças.</div>` : ''}</div>
    <div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead><tr>
      <th>Setor</th><th class="n">Itens</th><th class="n">Recontados</th><th class="n">OK</th><th class="n">Divergentes</th><th class="n">Pendentes</th>
      <th class="n">Dif. peças</th><th class="n">Dif. final</th><th class="n">Impacto sistema</th><th class="n">Confirmado</th><th class="n">A apurar</th>
      <th class="n">Expl. venda</th><th class="n">Vendas</th><th class="n">Expl. trânsito</th><th class="n">Trânsito</th>
    </tr></thead><tbody>${r.grupos.map(linha).join('')}</tbody><tfoot>${linha(t)}</tfoot></table></div>
    ${quadroNotas(b)}
    <h4 style="margin:0 0 8px">Divergências (${divergencias.length} ${divergencias.length === 1 ? 'item' : 'itens'}, recontado quando houver)</h4>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Setor</th><th>Código</th><th>Descrição</th><th class="n">Estoque</th><th class="n">Balanço</th><th class="n">Recontada</th><th class="n">Diferença</th><th class="n">Impacto</th><th>Status</th><th>Observação</th></tr></thead>
    <tbody>${divergencias.map(({ it, q, imp }) => `<tr><td>${esc(grupoCurto(it.g))}</td><td>${esc(it.c || it.b)}</td><td class="desc">${esc(it.d)}</td><td class="n">${fInt(it.e)}</td><td class="n">${fInt(it.l)}</td><td class="n">${vazio(it.rc) ? '' : it.rc}</td><td class="n ${cls(q)}">${fInt(q)}</td><td class="n ${cls(imp)}">${fRS(imp)}</td><td><span class="${stCls(status(it))}">${status(it)}</span></td><td>${esc(it.ob || '')}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">Nenhuma divergência.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="6">Total</td><td class="n ${cls(totQ)}">${fInt(totQ)}</td><td class="n ${cls(totImp)}">${fRS(totImp)}</td><td colspan="2"></td></tr></tfoot></table></div>`;
}

// ── Aba Trocas ─────────────────────────────────────────────────────────────
// Sobra × falta do mesmo valor: mesma referência primeiro, depois o mesmo setor.
// Na loja: entra (devolução) o código que sobrou e sai o que faltou.
function desenharTrocas() {
  const b = S.bal, T = b.trocas, esc_ = S.escritorio;
  const itens = T?.itens || [];
  const feitas = itens.filter(t => t.feita).length;
  const total = itens.reduce((a, t) => a + t.q * t.p, 0);
  const sit = !T ? 'Nenhuma sugestão gerada ainda.'
    : `${itens.length} troca(s) · ${feitas} feita(s) · ${fRS(total)} · gerada por ${esc(T.geradaPor)} em ${new Date(T.geradaEm).toLocaleString('pt-BR')}`
      + (T.enviadaEm ? ` · <b>enviada para a loja</b> em ${new Date(T.enviadaEm).toLocaleString('pt-BR')}` : ' · <b>ainda não enviada para a loja</b>');
  $('sub').innerHTML = `
    <div class="toolbar noprint">
      ${esc_ ? `<button class="btn" id="tGerar">${T ? 'Gerar de novo' : 'Sugerir trocas'}</button>` : ''}
      ${esc_ && itens.length && !T.enviadaEm ? '<button class="btn primary" id="tEnviar">Enviar para a loja</button>' : ''}
      <span class="muted">${sit}</span><span class="grow"></span>
      ${itens.length ? '<button class="btn" onclick="window.print()">Imprimir</button>' : ''}
    </div>
    <div class="hint" style="margin-bottom:8px">Pega o que sobrou e o que faltou depois da recontagem (itens explicados por venda ou trânsito ficam fora). Casa primeiro pela mesma referência e mesmo preço; depois pelo mesmo setor e mesmo preço. Setores diferentes não trocam.
      Na loja, faça a troca no Microvix: <span class="troca-ent">entra</span> (devolução) o código que sobrou e <span class="troca-sai">sai</span> o que faltou.</div>
    ${itens.length ? `<div class="tbl-wrap"><table class="tbl tbl-trocas"><thead><tr>
      <th>Setor</th><th>Entra (sobrou)</th><th>Sai (faltou)</th><th class="n">Qtd</th><th class="n">Valor</th><th>Por</th><th class="c">Feita</th>
    </tr></thead><tbody>${itens.map(t => `<tr class="${t.feita ? 'feita' : ''}">
      <td data-l="Setor">${esc(t.setor)}</td>
      <td data-l="Entra"><span class="troca-ent">${esc(t.entra.c)}</span> ${esc(t.entra.d)}<div class="muted" style="font-size:11px">${esc(t.entra.r)}</div></td>
      <td data-l="Sai"><span class="troca-sai">${esc(t.sai.c)}</span> ${esc(t.sai.d)}<div class="muted" style="font-size:11px">${esc(t.sai.r)}</div></td>
      <td class="n" data-l="Qtd">${fInt(t.q)}</td><td class="n" data-l="Valor">${fRS(t.q * t.p)}</td><td data-l="Por">${t.criterio === 'referência' ? 'mesma referência' : 'mesmo setor'}</td>
      <td class="c" data-l="Feita"><input type="checkbox" class="tFeita" data-id="${t.id}" ${t.feita ? 'checked' : ''} title="${t.feita ? `Feita por ${esc(t.feitaPor)} em ${new Date(t.feitaEm).toLocaleString('pt-BR')}` : 'Marcar como feita'}"/></td></tr>`).join('')}</tbody></table></div>`
      : (T ? '<div class="empty">Nenhuma troca possível: não há sobra e falta do mesmo valor no mesmo setor.</div>' : '')}`;
  if ($('tGerar')) $('tGerar').onclick = async () => {
    if (T?.enviadaEm && !confirm('Gerar de novo? A lista enviada para a loja é substituída (as já feitas ficam).')) return;
    try { await api(`/api/balancos/${b.id}/trocas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); abrir(b.id, true); } catch (e) { alert(e.message); }
  };
  if ($('tEnviar')) $('tEnviar').onclick = async () => {
    if (!confirm(`Enviar ${itens.length} troca(s) para a loja?`)) return;
    try { await api(`/api/balancos/${b.id}/trocas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enviar: true }) }); abrir(b.id, true); } catch (e) { alert(e.message); }
  };
  document.querySelectorAll('.tFeita').forEach(el => el.onchange = async () => {
    try {
      const j = await api(`/api/balancos/${b.id}/trocas/${el.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feita: el.checked }) });
      const t = itens.find(x => x.id === el.dataset.id); Object.assign(t, { feita: el.checked, feitaPor: 'você', feitaEm: new Date().toISOString() });
      el.closest('tr').classList.toggle('feita', el.checked);
      // Os dois itens da troca mudam de status na recontagem
      Object.entries(j.sts || {}).forEach(([k, st]) => { const it = b.itens.find(x => (x.c || x.b) === k); if (it) it.st = st; });
      if (j.resumo) { b.resumo = j.resumo; atualizarKpis(); }
    } catch (e) { alert(e.message); el.checked = !el.checked; }
  });
}

// ── Aba Configurar (escritório) ────────────────────────────────────────────
function desenharConfig() {
  const b = S.bal;
  const fora = new Set(b.gruposFora || []);
  const grupos = [...new Set((b.itens || []).map(it => it.g))].sort();
  const pecas = g => (b.itens || []).filter(it => it.g === g).reduce((a, it) => a + it.l, 0);
  $('sub').innerHTML = `<div class="cfg">
    <div class="box"><h4>Grupos considerados</h4>
      <div class="hint" style="margin:-4px 0 8px">Como o filtro de setor do Processar balanço: grupo desmarcado sai da conferência, do PDF e do TXT.</div>
      <div class="toolbar" style="margin-bottom:8px"><button class="btn" id="cTodos">Marcar todos</button><button class="btn" id="cNenhum">Desmarcar todos</button></div>
      <div class="grupos">${grupos.map(g => `<label><input type="checkbox" class="cg" value="${esc(g)}" ${fora.has(g) ? '' : 'checked'}/> ${esc(g)} <span class="muted">(${fInt(pecas(g))} lidas)</span></label>`).join('')}</div>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn primary" id="cSalvarG">Salvar grupos</button></div>
    </div>
    <div class="box"><h4>Recontagem</h4>
      <label style="display:flex;gap:6px;align-items:center;margin-bottom:12px"><input type="checkbox" id="cNaoLidos" ${b.incluirNaoLidos ? 'checked' : ''}/> Incluir itens com saldo que não foram lidos</label>
      <label style="display:flex;gap:6px;align-items:center;margin-bottom:12px"><input type="checkbox" id="cFoto" ${b.exigeFoto ? 'checked' : ''}/> Foto obrigatória na recontagem da loja (sem foto, a divergência continua)</label>
      <div class="fld"><label>Mês do balanço</label><input type="month" id="cMes" class="inp" value="${esc(b.mes)}"/></div>
      <div class="fld"><label>Observação</label><input type="text" id="cObs" class="inp" value="${esc(b.obs || '')}" maxlength="500"/></div>
      <button class="btn primary" id="cSalvar">Salvar</button>
    </div>
    ${b.temLeitura ? `<div class="box"><h4>Reprocessar</h4>
      <div class="hint" style="margin:-4px 0 8px">Busca de novo estoque, vendas e preços no Microvix. As recontagens já lançadas são mantidas.</div>
      <div class="row2"><div class="fld"><label>Início da contagem</label><input type="date" id="pInicio" class="inp" required value="${esc(b.inicio || b.data)}"/></div>
        <div class="fld"><label>Fim da contagem</label><input type="date" id="pData" class="inp" value="${esc(b.data)}"/></div></div>
      <div class="row2"><div class="fld"><label>Hora</label><input type="time" id="pHora" class="inp" value="${esc(b.hora || '')}"/></div><div class="fld"></div></div>
      <div class="row2"><div class="fld"><label>Agrupar por</label><select id="pAgr" class="sel"><option value="setor" ${b.agrupar === 'setor' ? 'selected' : ''}>Setor</option><option value="linha" ${b.agrupar === 'linha' ? 'selected' : ''}>Linha</option></select></div>
        <div class="fld"><label>Trânsito (dias)</label><input type="number" id="pDias" class="inp" min="0" max="60" value="${b.diasTransito ?? 7}"/></div></div>
      <div class="toolbar"><button class="btn primary" id="pRodar">Reprocessar</button><a class="btn" href="/api/balancos/${b.id}/leitura">TXT original</a></div>
      <div class="hint">Processado em ${b.processadoEm ? new Date(b.processadoEm).toLocaleString('pt-BR') : '—'} · criado por ${esc(b.criadoPor)}${b.movDepoisDaHora ? ` · ${b.movDepoisDaHora} movimentos depois da hora desfeitos` : ''}${b.ajustesDepois?.itens ? ` · ${b.ajustesDepois.itens} item(ns) com ajuste de estoque lançado depois da data aplicado` : ''}</div>
    </div>` : ''}
    <div class="box"><h4>Excluir</h4><div class="hint" style="margin-bottom:10px">Apaga o balanço, o PDF e as recontagens. Não tem volta.</div>
      <button class="btn danger" id="cExcluir">Excluir balanço</button></div>
  </div>`;
  $('cTodos').onclick = () => document.querySelectorAll('.cg').forEach(c => c.checked = true);
  $('cNenhum').onclick = () => document.querySelectorAll('.cg').forEach(c => c.checked = false);
  $('cSalvarG').onclick = () => patchBal({ gruposFora: [...document.querySelectorAll('.cg')].filter(c => !c.checked).map(c => c.value) });
  $('cSalvar').onclick = () => patchBal({ incluirNaoLidos: $('cNaoLidos').checked, exigeFoto: $('cFoto').checked, mes: $('cMes').value, obs: $('cObs').value });
  if ($('pRodar')) $('pRodar').onclick = () => reprocessar({ inicio: $('pInicio').value, data: $('pData').value, hora: $('pHora').value, agrupar: $('pAgr').value, diasTransito: $('pDias').value });
  $('cExcluir').onclick = excluir;
}

// ── Notas pendentes do Recebimento de NF ──────────────────────────────────
// Para cada nota autorizada e não armazenada: quantas peças dela faltaram na
// contagem (recontagem quando houver). Nenhuma falta = a mercadoria já está na loja.
function situacaoNotas(b) {
  const fora = new Set(b.gruposFora || []);
  const porCod = new Map((b.itens || []).map(it => [it.c, it]));
  return (b.notasPendentes || []).map(n => {
    let pecas = 0, falta = 0, conferidos = 0;
    for (const x of n.itens || []) {
      pecas += x.q;
      const it = porCod.get(x.c);
      if (!it || fora.has(it.g)) continue; // sem saldo e sem leitura, ou setor fora do balanço
      conferidos++;
      const contado = vazio(it.rc) ? it.l : Number(it.rc);
      falta += Math.min(x.q, Math.max(0, it.e - contado));
    }
    const sit = !n.lancada ? 'nao-lancada' : !conferidos ? 'sem-saldo' : falta === 0 ? 'entregue' : falta >= pecas ? 'transito' : 'parcial';
    return { ...n, pecas, falta, sit };
  });
}
function quadroNotas(b) {
  const notas = situacaoNotas(b);
  if (!notas.length) return '';
  const SIT = {
    entregue: ['<span class="st st-OK">PARECE ENTREGUE</span>', 'Nenhuma peça da nota faltou: dar baixa no Recebimento de NF.'],
    transito: ['<span class="st st-VER-TRANSITO">EM TRÂNSITO</span>', 'Todas as peças da nota faltaram: a mercadoria não chegou.'],
    parcial: ['<span class="st st-VENDA-PARCIAL">PARCIAL</span>', 'Parte das peças faltou: conferir a nota com a loja.'],
    'sem-saldo': ['<span class="st">SEM SALDO</span>', 'Os produtos da nota não têm saldo nem foram lidos (ou estão em setor fora do balanço).'],
    'nao-lancada': ['<span class="st">SEM ENTRADA</span>', 'Nota não lançada no Microvix: não mexe no estoque.'],
  };
  const linha = n => {
    const [chip, txt] = SIT[n.sit];
    const baixa = n.baixa ? `<span class="muted">baixa em ${new Date(n.baixa.em).toLocaleDateString('pt-BR')} por ${esc(n.baixa.por || '—')}</span>`
      : n.excluida ? '<span class="muted">nota excluída do card</span>'
      : S.escritorio && n.sit === 'entregue' ? `<button class="btn" data-baixa="${n.id}">Dar baixa</button>` : '';
    return `<tr><td>${esc(n.texto || n.numero)}</td><td>${n.addedAt ? new Date(n.addedAt).toLocaleDateString('pt-BR') : ''}</td>
      <td class="n">${fInt(n.pecas)}</td><td class="n ${n.falta ? 'neg' : ''}">${fInt(n.falta)}</td><td>${chip}</td><td class="muted">${txt}</td><td>${baixa}</td></tr>`;
  };
  return `<h4 style="margin:0 0 8px">Notas pendentes no Recebimento de NF (${notas.length})</h4>
    <div class="hint" style="margin:-4px 0 8px">Notas autorizadas e ainda não armazenadas pela loja quando o balanço foi processado. As entradas delas explicam falta mesmo antes da janela de trânsito.</div>
    <div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead><tr><th>Nota</th><th>No card desde</th><th class="n">Peças</th><th class="n">Faltaram</th><th>Situação</th><th></th><th></th></tr></thead>
    <tbody>${notas.map(linha).join('')}</tbody></table></div>`;
}
document.addEventListener('click', async e => {
  const id = e.target?.dataset?.baixa;
  if (!id) return;
  if (!confirm('Dar baixa nesta nota no Recebimento de NF (armazenada pela loja)?')) return;
  e.target.disabled = true;
  try {
    await api(`/api/nf-items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked: true }) });
    abrir(S.bal.id, true);
  } catch (err) { alert(err.message); e.target.disabled = false; }
});

async function patchBal(body) {
  try {
    await api('/api/balancos/' + S.bal.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    abrir(S.bal.id, true);
  } catch (e) { alert(e.message); }
}
async function reprocessar(body) {
  try {
    await api(`/api/balancos/${S.bal.id}/reprocessar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    abrir(S.bal.id, true);
  } catch (e) { alert(e.message); }
}
async function finalizar() {
  const t = S.bal.resumo.total;
  const msg = t.pendentes ? `Ainda há ${t.pendentes} itens sem recontagem (${fRS(t.impactoApurar)} a apurar). Finalizar assim mesmo?` : 'Finalizar o balanço? A recontagem fica travada.';
  if (confirm(msg)) patchBal({ status: 'finalizado' });
}
async function excluir() {
  if (!confirm(`Excluir o balanço ${S.bal.lojaLabel} de ${dBR(S.bal.data)}? Não tem volta.`)) return;
  try { await api('/api/balancos/' + S.bal.id, { method: 'DELETE' }); voltar(); } catch (e) { alert(e.message); }
}

$('impArq').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !S.bal) return;
  const fd = new FormData(); fd.append('arquivo', f);
  try {
    const j = await api(`/api/balancos/${S.bal.id}/importar`, { method: 'POST', body: fd });
    alert(`${j.reconhecidas} de ${j.linhas} linhas reconhecidas · ${j.alterados} recontagens atualizadas.`);
    abrir(S.bal.id, true);
  } catch (err) { alert(err.message); }
};

// ── Novo balanço ───────────────────────────────────────────────────────────
function abrirNovo() {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString();
  $('nLoja').innerHTML = S.lojas.map(b => `<option value="${b}">${b.toUpperCase()}</option>`).join('');
  if ($('fLoja').value) $('nLoja').value = $('fLoja').value;
  $('nMes').value = $('fMes').value || hoje.slice(0, 7);
  $('nData').value = hoje.slice(0, 10);
  $('nErr').textContent = '';
  $('modal').classList.remove('hidden');
}
$('btnNovo').onclick = abrirNovo;
$('nCancelar').onclick = () => $('modal').classList.add('hidden');
$('fNovo').onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('board', $('nLoja').value); fd.append('mes', $('nMes').value); fd.append('data', $('nData').value); fd.append('inicio', $('nInicio').value);
  fd.append('hora', $('nHora').value); fd.append('agrupar', $('nAgrupar').value); fd.append('diasTransito', $('nDias').value);
  fd.append('obs', $('nObs').value); fd.append('arquivo', $('nArq').files[0]);
  $('nEnviar').disabled = true; $('nErr').textContent = '';
  try {
    const j = await api('/api/balancos', { method: 'POST', body: fd });
    $('modal').classList.add('hidden'); $('fNovo').reset();
    abrir(j.id);
  } catch (err) { $('nErr').textContent = err.message; }
  finally { $('nEnviar').disabled = false; }
};

// ── Importar balanço antigo (planilha) ────────────────────────────────────
// A loja sai do nome do arquivo quando dá ("DIFERENÇAS DEL REY.xlsx")
const LOJA_NO_NOME = [['delrey', /DEL\s*REY/], ['minas', /MINAS/], ['contagem', /CONTAGEM/], ['estacao', /ESTA[CÇ][AÃ]O/], ['tommy', /TOMMY/], ['lez', /LEZ/]];
$('btnArquivar').onclick = () => {
  $('aLoja').innerHTML = '<option value="">Escolha…</option>' + S.lojas.map(b => `<option value="${b}">${b.toUpperCase()}</option>`).join('');
  if ($('fLoja').value) $('aLoja').value = $('fLoja').value;
  $('aErr').textContent = '';
  $('modalArq').classList.remove('hidden');
};
$('aPlan').onchange = () => {
  const nome = ($('aPlan').files[0]?.name || '').toUpperCase();
  const achou = LOJA_NO_NOME.find(([b, re]) => re.test(nome) && S.lojas.includes(b));
  if (achou) $('aLoja').value = achou[0];
  const m = nome.match(/(\d{2})(20\d{2})/);
  if (m && +m[1] >= 1 && +m[1] <= 12) $('aMes').value = `${m[2]}-${m[1]}`;
};
$('aCancelar').onclick = () => $('modalArq').classList.add('hidden');
$('fArq').onsubmit = async e => {
  e.preventDefault();
  if (!$('aLoja').value) { $('aErr').textContent = 'Escolha a loja.'; return; }
  const fd = new FormData();
  fd.append('arquivo', $('aPlan').files[0]); fd.append('board', $('aLoja').value);
  fd.append('mes', $('aMes').value); fd.append('data', $('aData').value); fd.append('situacao', $('aSit').value); fd.append('obs', $('aObs').value);
  if ($('aPdf').files[0]) fd.append('pdf', $('aPdf').files[0]);
  if ($('aTxt').files[0]) fd.append('txt', $('aTxt').files[0]);
  $('aEnviar').disabled = true; $('aErr').textContent = '';
  try {
    const j = await api('/api/balancos/arquivar', { method: 'POST', body: fd });
    $('modalArq').classList.add('hidden'); $('fArq').reset();
    if (j.aviso) alert(j.aviso);
    abrir(j.id);
  } catch (err) { $('aErr').textContent = err.message; }
  finally { $('aEnviar').disabled = false; }
};

// ── Início ─────────────────────────────────────────────────────────────────
document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => {
  S.tab = el.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === el));
  $('fMes').classList.toggle('hidden', S.tab !== 'mes');
  carregarLista();
});
$('fMes').onchange = carregarLista;
$('fLoja').onchange = carregarLista;
$('fMes').value = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
fetch('/api/me').then(r => r.ok ? r.json() : null).then(u => {
  if (!u) { location.href = '/'; return; }
  $('userLabel').textContent = u.label || u.username || '';
});
const idUrl = new URLSearchParams(location.search).get('id');
carregarLista().then(() => { if (idUrl) abrir(idUrl); });
