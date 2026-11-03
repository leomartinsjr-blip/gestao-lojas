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

function causa(it) {
  const dif = it.l - it.e;
  if (it.t && dif < 0 && -dif <= it.t) return 'VER TRÂNSITO';
  if (it.v > 0 && Math.abs(dif) === it.v) return 'VER VENDA';
  if (it.v > 0) return 'VENDA PARCIAL';
  return 'A RECONTAR';
}
function statusAuto(it) {
  if (vazio(it.rc)) return causa(it);
  const rc = Number(it.rc);
  if (rc === it.e) return 'OK';
  if (it.t && rc < it.e && it.e - rc <= it.t) return 'VER TRÂNSITO';
  return 'DIVERGENTE';
}
const status = it => it.st || statusAuto(it);
const STATUS_MANUAL = ['OK', 'DIVERGENTE', 'VER VENDA', 'VER TRÂNSITO', 'A RECONTAR', 'TROCA', 'AJUSTAR'];
// NFs de entrada que explicam o trânsito
const nfsTxt = it => (it.tn || []).map(n => `<span class="nf" title="Entrada em ${esc(n.d)}: ${fInt(n.q)} peça(s)">NF ${esc(n.n)} · ${esc(n.d)} · ${fInt(n.q)}</span>`).join('');
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
      : r ? `<div class="bcard-nums">
          <div>Lido × estoque<b>${fInt(r.pecasLidas)} × ${fInt(r.pecasEstoque)}</b></div>
          <div>Recontados<b>${r.recontados} de ${r.itens}</b></div>
          <div>Impacto sistema<b class="${cls(r.impactoSistema)}">${fRS(r.impactoSistema)}</b></div>
          <div>Confirmado<b class="${cls(r.impactoConfirmado)}">${fRS(r.impactoConfirmado)}</b></div>
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

function desenharHistorico(lista) {
  if (!lista.length) { $('lista').innerHTML = '<div class="empty">Nenhum balanço ainda.</div>'; return; }
  const linhas = lista.map(b => {
    const r = b.resumo || {};
    const final = (r.impactoConfirmado || 0) + (r.impactoApurar || 0);
    return `<tr class="clic" data-id="${b.id}">
      <td>${esc(mesBR(b.mes))}</td><td>${esc(b.lojaLabel)}</td><td>${dBR(b.data)}${b.hora ? ' ' + b.hora : ''}</td>
      <td class="n">${b.resumo ? fInt(r.pecasLidas) : ''}</td><td class="n">${b.resumo ? fInt(r.pecasEstoque) : ''}</td>
      <td class="n">${b.resumo ? r.itens : ''}</td><td class="n">${b.resumo ? r.recontados : ''}</td>
      <td class="n ${cls(r.pecasDif)}">${b.resumo ? fInt(r.pecasDif) : ''}</td>
      <td class="n ${cls(r.pecasDifFinal)}">${b.resumo ? fInt(r.pecasDifFinal) : ''}</td>
      <td class="n ${cls(r.impactoSistema)}">${b.resumo ? fRS(r.impactoSistema) : ''}</td>
      <td class="n ${cls(final)}">${b.resumo ? fRS(final) : ''}</td>
      <td><span class="badge ${b.status}">${STATUS_LBL[b.status] || b.status}</span></td></tr>`;
  }).join('');
  $('lista').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr>
    <th>Mês</th><th>Loja</th><th>Contagem</th><th class="n">Peças lidas</th><th class="n">Estoque</th><th class="n">Itens divergentes</th><th class="n">Recontados</th>
    <th class="n">Dif. peças (sistema)</th><th class="n">Dif. peças (final)</th><th class="n">Impacto sistema</th><th class="n">Impacto final</th><th>Status</th>
    </tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="hint" style="margin-top:6px">Impacto final = confirmado na recontagem + o que ainda está a apurar.</div>`;
  document.querySelectorAll('tr.clic').forEach(el => el.onclick = () => abrir(el.dataset.id));
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

function itensRecontagem(b) {
  const fora = new Set(b.gruposFora || []);
  return (b.itens || []).filter(it => !fora.has(it.g) && it.l !== it.e && (it.lido || b.incluirNaoLidos));
}

function desenharDetalhe() {
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
    if (b.naoCadastrados) avisos.push(`<div class="aviso">${b.naoCadastrados} código(s) lido(s) não existem no cadastro do Microvix — estão no grupo (NÃO CADASTRADO).</div>`);
    if (b.leitura?.invalidas?.length) avisos.push(`<div class="aviso">${b.leitura.invalidas.length} linha(s) do arquivo não foram entendidas (ex.: linha ${b.leitura.invalidas[0].linha}: "${esc(b.leitura.invalidas[0].texto)}").</div>`);
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
    && (!f.pend || vazio(it.rc)) && (!q || (it.d + ' ' + it.c + ' ' + it.b + ' ' + it.r).toUpperCase().includes(q)));
  const sts = ['A RECONTAR', 'VENDA PARCIAL', 'VER VENDA', 'VER TRÂNSITO', 'OK', 'DIVERGENTE', 'TROCA', 'AJUSTAR'];
  const tot = lista.reduce((a, it) => { a.e += it.e; a.l += it.l; a.i += (it.l - it.e) * it.p; return a; }, { e: 0, l: 0, i: 0 });
  $('sub').innerHTML = `
    <div class="toolbar noprint">
      <select class="sel" id="rG"><option value="">Todos os setores</option>${grupos.map(g => `<option ${g === f.g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <select class="sel" id="rSt"><option value="">Todos os status</option>${sts.map(s => `<option ${s === f.st ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <input class="inp grow" id="rQ" placeholder="Buscar descrição, código, referência…" value="${esc(f.q)}"/>
      <label class="muted" style="display:flex;gap:5px;align-items:center"><input type="checkbox" id="rPend" ${f.pend ? 'checked' : ''}/> só pendentes</label>
      <span class="muted">${lista.length} de ${todos.length} itens</span>
    </div>
    ${matchMedia('(max-width: 640px)').matches
      ? `<div class="mcards">${lista.map(cartaoRecont(aberto)).join('') || '<div class="empty">Nada com esse filtro.</div>'}</div>`
      : `<div class="tbl-wrap"><table class="tbl fit"><colgroup><col style="width:78px"><col style="width:62px"><col><col style="width:108px">
      <col style="width:52px"><col style="width:56px"><col style="width:40px"><col style="width:82px"><col style="width:88px"><col style="width:66px">
      <col style="width:46px"><col style="width:128px"><col style="width:140px"></colgroup><thead><tr>
      <th>Setor</th><th>Código</th><th>Descrição</th><th>Referência</th><th class="n">Estoque</th><th class="n">Balanço</th><th class="n">Dif.</th>
      <th class="n">Preço</th><th class="n">Impacto</th><th class="c">Recontada</th><th class="n">Dif. final</th><th>Status</th><th>Observação</th>
    </tr></thead><tbody>${lista.map(linhaRecont(aberto)).join('') || '<tr><td colspan="13" class="empty">Nada com esse filtro.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4">Total do filtro</td><td class="n">${fInt(tot.e)}</td><td class="n">${fInt(tot.l)}</td><td class="n">${fInt(tot.l - tot.e)}</td><td></td>
      <td class="n ${cls(tot.i)}">${fRS(tot.i)}</td><td colspan="4"></td></tr></tfoot></table></div>`}`;
  $('rG').onchange = e => { f.g = e.target.value; desenharRecontagem(); };
  $('rSt').onchange = e => { f.st = e.target.value; desenharRecontagem(); };
  $('rPend').onchange = e => { f.pend = e.target.checked; desenharRecontagem(); };
  let tq; $('rQ').oninput = e => { clearTimeout(tq); tq = setTimeout(() => { f.q = e.target.value; desenharRecontagem(); const el = $('rQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 300); };
  document.querySelectorAll('#sub input.rc, #sub input.ob').forEach(el => el.onchange = () => salvarItem(el));
  document.querySelectorAll('#sub select.stsel').forEach(el => el.onchange = () => salvarStatus(el));
  // Enter no campo da recontagem pula para o próximo item
  document.querySelectorAll('#sub input.rc').forEach((el, i, arr) => el.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); arr[i + 1]?.focus(); arr[i + 1]?.select(); }
  });
}

const linhaRecont = aberto => it => {
  const k = esc(it.c || it.b);
  const s = status(it);
  const dif = it.l - it.e;
  const difF = vazio(it.rc) ? '' : fInt(Number(it.rc) - it.e);
  const quem = it.rp ? ` title="Lançado por ${esc(it.rp)} em ${new Date(it.rt).toLocaleString('pt-BR')}"` : '';
  return `<tr class="linha-item" data-k="${k}">
    <td>${esc(grupoCurto(it.g))}</td><td>${esc(it.c || it.b)}</td><td class="desc">${esc(it.d)}${it.lido ? '' : ' <span class="badge">não lido</span>'}${nfsTxt(it)}</td><td>${esc(it.r)}</td>
    <td class="n">${fInt(it.e)}</td><td class="n">${fInt(it.l)}</td><td class="n ${cls(dif)}">${fInt(dif)}</td>
    <td class="n">${fRS(it.p)}</td><td class="n ${cls(dif * it.p)}">${fRS(dif * it.p)}</td>
    <td class="c">${aberto ? `<input class="inp rc" inputmode="numeric" data-k="${k}" value="${vazio(it.rc) ? '' : it.rc}"${quem}/>` : (vazio(it.rc) ? '' : `<b${quem}>${it.rc}</b>`)}</td>
    <td class="n dif-f">${difF}</td><td class="stc">${celStatus(it, aberto)}</td>
    <td>${aberto ? `<input class="inp ob" data-k="${k}" value="${esc(it.ob || '')}" maxlength="300"/>` : esc(it.ob || '')}</td></tr>`;
};

// Celular: um cartão por item, com a recontagem à mão (a tabela pede rolagem lateral)
const cartaoRecont = aberto => it => {
  const k = esc(it.c || it.b);
  const s = status(it);
  const dif = it.l - it.e;
  return `<div class="linha-item mcard" data-k="${k}">
    <div class="mcard-top"><span class="muted">${esc(grupoCurto(it.g))} · ${esc(it.c || it.b)}</span><span class="stc"><span class="${stCls(s)}">${s}</span></span></div>
    <div class="mcard-desc">${esc(it.d)}${it.lido ? '' : ' <span class="badge">não lido</span>'}${nfsTxt(it)}</div>
    <div class="mcard-nums"><span>Estoque <b>${fInt(it.e)}</b></span><span>Lido <b>${fInt(it.l)}</b></span><span>Dif. <b class="${cls(dif)}">${fInt(dif)}</b></span><span>Final <b class="dif-f">${vazio(it.rc) ? '' : fInt(Number(it.rc) - it.e)}</b></span></div>
    ${aberto ? `<div class="mcard-inp"><input class="inp rc" inputmode="numeric" placeholder="Contei" data-k="${k}" value="${vazio(it.rc) ? '' : it.rc}"/>
      <input class="inp ob" placeholder="Observação" data-k="${k}" value="${esc(it.ob || '')}" maxlength="300"/></div>`
      : (vazio(it.rc) ? '' : `<div class="mcard-desc">Recontado: <b>${it.rc}</b> ${esc(it.ob || '')}</div>`)}
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
    el.closest('.stc').innerHTML = celStatus(it, true);
    document.querySelector(`.stc select[data-k="${CSS.escape(k)}"]`)?.addEventListener('change', e => salvarStatus(e.target));
    atualizarKpis();
  } catch (e) { alert(e.message); }
}

async function salvarItem(el) {
  const k = el.dataset.k;
  const tr = el.closest('.linha-item');
  const rcEl = tr.querySelector('input.rc'), obEl = tr.querySelector('input.ob');
  const rcTxt = rcEl.value.trim();
  if (rcTxt !== '' && !/^\d+$/.test(rcTxt)) { rcEl.classList.add('falhou'); rcEl.title = 'Só número inteiro'; return; }
  const body = { itens: [{ k, rc: rcTxt === '' ? null : Number(rcTxt), ob: obEl.value }] };
  [rcEl, obEl].forEach(x => x.classList.remove('salvo', 'falhou'));
  try {
    const j = await api(`/api/balancos/${S.bal.id}/itens`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const it = S.bal.itens.find(x => (x.c || x.b) === k);
    if (it) { it.rc = body.itens[0].rc; it.ob = body.itens[0].ob; }
    S.bal.resumo = j.resumo;
    el.classList.add('salvo');
    // Atualiza a linha e os indicadores sem redesenhar a tabela (não perde o foco)
    const s = status(it);
    tr.querySelector('.dif-f').textContent = vazio(it.rc) ? '' : fInt(Number(it.rc) - it.e);
    tr.querySelector('.stc').innerHTML = celStatus(it, S.bal.status === 'recontagem');
    atualizarKpis();
  } catch (e) { el.classList.add('falhou'); el.title = e.message; }
}

function atualizarKpis() {
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
  const maiores = itensRecontagem(b).map(it => ({ it, imp: (vazio(it.rc) ? it.l - it.e : Number(it.rc) - it.e) * it.p }))
    .filter(x => x.imp).sort((a, c) => Math.abs(c.imp) - Math.abs(a.imp)).slice(0, 15);
  const jan = b.janelaTransito || {};
  $('sub').innerHTML = `
    <div class="toolbar noprint"><span class="muted">Vendas do dia da contagem · entradas de ${dBR(jan.ini)} a ${dBR(jan.fim)} contam como trânsito.</span><span class="grow"></span><button class="btn" onclick="window.print()">Imprimir</button></div>
    <div class="box" style="margin-bottom:12px"><b>${esc(b.lojaLabel)} — balanço de ${dBR(b.data)}${b.hora ? ' ' + b.hora : ''}</b> · mês ${esc(mesBR(b.mes))}<br/>
      <span class="muted">Leitura de ${fInt(r.pecasLidas)} peças contra ${fInt(r.pecasEstoque)} no sistema. ${t.itens} itens com diferença
      (${fInt(t.pecasDif)} peças, ${fRS(t.impactoSistema)}). Depois da recontagem: ${fInt(t.pecasDifFinal)} peças —
      ${fRS(t.impactoConfirmado)} confirmado e ${fRS(t.impactoApurar)} ainda a apurar (${t.pendentes} itens sem recontagem).</span></div>
    <div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead><tr>
      <th>Setor</th><th class="n">Itens</th><th class="n">Recontados</th><th class="n">OK</th><th class="n">Divergentes</th><th class="n">Pendentes</th>
      <th class="n">Dif. peças</th><th class="n">Dif. final</th><th class="n">Impacto sistema</th><th class="n">Confirmado</th><th class="n">A apurar</th>
      <th class="n">Expl. venda</th><th class="n">Vendas</th><th class="n">Expl. trânsito</th><th class="n">Trânsito</th>
    </tr></thead><tbody>${r.grupos.map(linha).join('')}</tbody><tfoot>${linha(t)}</tfoot></table></div>
    <h4 style="margin:0 0 8px">Maiores impactos (recontado quando houver)</h4>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Setor</th><th>Código</th><th>Descrição</th><th class="n">Estoque</th><th class="n">Balanço</th><th class="n">Recontada</th><th class="n">Impacto</th><th>Status</th><th>Observação</th></tr></thead>
    <tbody>${maiores.map(({ it, imp }) => `<tr><td>${esc(grupoCurto(it.g))}</td><td>${esc(it.c || it.b)}</td><td class="desc">${esc(it.d)}</td><td class="n">${fInt(it.e)}</td><td class="n">${fInt(it.l)}</td><td class="n">${vazio(it.rc) ? '' : it.rc}</td><td class="n ${cls(imp)}">${fRS(imp)}</td><td><span class="${stCls(status(it))}">${status(it)}</span></td><td>${esc(it.ob || '')}</td></tr>`).join('')}</tbody></table></div>`;
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
    ${itens.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>Setor</th><th>Entra (sobrou)</th><th>Sai (faltou)</th><th class="n">Qtd</th><th class="n">Valor</th><th>Por</th><th class="c">Feita</th>
    </tr></thead><tbody>${itens.map(t => `<tr class="${t.feita ? 'feita' : ''}">
      <td>${esc(t.setor)}</td>
      <td><span class="troca-ent">${esc(t.entra.c)}</span> ${esc(t.entra.d)}<div class="muted" style="font-size:11px">${esc(t.entra.r)}</div></td>
      <td><span class="troca-sai">${esc(t.sai.c)}</span> ${esc(t.sai.d)}<div class="muted" style="font-size:11px">${esc(t.sai.r)}</div></td>
      <td class="n">${fInt(t.q)}</td><td class="n">${fRS(t.q * t.p)}</td><td>${t.criterio === 'referência' ? 'mesma referência' : 'mesmo setor'}</td>
      <td class="c"><input type="checkbox" class="tFeita" data-id="${t.id}" ${t.feita ? 'checked' : ''} title="${t.feita ? `Feita por ${esc(t.feitaPor)} em ${new Date(t.feitaEm).toLocaleString('pt-BR')}` : 'Marcar como feita'}"/></td></tr>`).join('')}</tbody></table></div>`
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
      await api(`/api/balancos/${b.id}/trocas/${el.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feita: el.checked }) });
      const t = itens.find(x => x.id === el.dataset.id); Object.assign(t, { feita: el.checked, feitaPor: 'você', feitaEm: new Date().toISOString() });
      el.closest('tr').classList.toggle('feita', el.checked);
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
      <div class="fld"><label>Mês do balanço</label><input type="month" id="cMes" class="inp" value="${esc(b.mes)}"/></div>
      <div class="fld"><label>Observação</label><input type="text" id="cObs" class="inp" value="${esc(b.obs || '')}" maxlength="500"/></div>
      <button class="btn primary" id="cSalvar">Salvar</button>
    </div>
    ${b.temLeitura ? `<div class="box"><h4>Reprocessar</h4>
      <div class="hint" style="margin:-4px 0 8px">Busca de novo estoque, vendas e preços no Microvix. As recontagens já lançadas são mantidas.</div>
      <div class="row2"><div class="fld"><label>Data</label><input type="date" id="pData" class="inp" value="${esc(b.data)}"/></div>
        <div class="fld"><label>Hora</label><input type="time" id="pHora" class="inp" value="${esc(b.hora || '')}"/></div></div>
      <div class="row2"><div class="fld"><label>Agrupar por</label><select id="pAgr" class="sel"><option value="setor" ${b.agrupar === 'setor' ? 'selected' : ''}>Setor</option><option value="linha" ${b.agrupar === 'linha' ? 'selected' : ''}>Linha</option></select></div>
        <div class="fld"><label>Trânsito (dias)</label><input type="number" id="pDias" class="inp" min="0" max="60" value="${b.diasTransito ?? 7}"/></div></div>
      <div class="toolbar"><button class="btn primary" id="pRodar">Reprocessar</button><a class="btn" href="/api/balancos/${b.id}/leitura">TXT original</a></div>
      <div class="hint">Processado em ${b.processadoEm ? new Date(b.processadoEm).toLocaleString('pt-BR') : '—'} · criado por ${esc(b.criadoPor)}${b.movDepoisDaHora ? ` · ${b.movDepoisDaHora} movimentos depois da hora desfeitos` : ''}</div>
    </div>` : ''}
    <div class="box"><h4>Excluir</h4><div class="hint" style="margin-bottom:10px">Apaga o balanço, o PDF e as recontagens. Não tem volta.</div>
      <button class="btn danger" id="cExcluir">Excluir balanço</button></div>
  </div>`;
  $('cTodos').onclick = () => document.querySelectorAll('.cg').forEach(c => c.checked = true);
  $('cNenhum').onclick = () => document.querySelectorAll('.cg').forEach(c => c.checked = false);
  $('cSalvarG').onclick = () => patchBal({ gruposFora: [...document.querySelectorAll('.cg')].filter(c => !c.checked).map(c => c.value) });
  $('cSalvar').onclick = () => patchBal({ incluirNaoLidos: $('cNaoLidos').checked, mes: $('cMes').value, obs: $('cObs').value });
  if ($('pRodar')) $('pRodar').onclick = () => reprocessar({ data: $('pData').value, hora: $('pHora').value, agrupar: $('pAgr').value, diasTransito: $('pDias').value });
  $('cExcluir').onclick = excluir;
}

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
  fd.append('board', $('nLoja').value); fd.append('mes', $('nMes').value); fd.append('data', $('nData').value);
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
