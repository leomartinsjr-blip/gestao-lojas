'use strict';
// Aba 13º Salário da folha — usa BOARDS_INFO, r2, brl, apiFetch e toast de
// folha.js. Os valores não entram na folha do mês: é lançamento à parte.
const D13 = { ano: 0, parcela: new Date().getMonth() === 11 ? 'p2' : 'p1', board: '',
              pessoas: [], entries: {}, encerradas: {}, ed: {}, dirty: false, ativo: false };
const D13_NOME = { p1: '1ª parcela', p2: '2ª parcela' };
const D13_MES  = { p1: 'Novembro', p2: 'Dezembro' };
const _p1De    = id => D13.entries[id]?.p1;
const d13Enc   = () => !!D13.encerradas[D13.board]?.[D13.parcela];
const d13Total = (l, id) => D13.parcela === 'p1' ? r2(l.valor)
  : r2(r2(l.bruto) - r2(_p1De(id)?.valor) - r2(l.inss) - r2(l.irrf) - r2(l.outros));
const d13BoardDe = e => D13.entries[e.id]?.[D13.parcela]?.board || e.board;
const d13Pessoas = (board = D13.board) => D13.pessoas.filter(e => d13BoardDe(e) === board
  // Desligado só fica nas parcelas que já tinha lançadas
  && (!(e.desligamento && e.desligamento <= `${D13.ano}-12-31`) || D13.entries[e.id]?.[D13.parcela]));

// Prazo legal: 30/11 e 20/12; em fim de semana, antecipa para a sexta
function d13Prazo() {
  const d = D13.parcela === 'p1' ? new Date(D13.ano, 10, 30) : new Date(D13.ano, 11, 20);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2, '0')}/${d.getMonth() + 1}`;
}
const d13PodeSair = () => !D13.dirty || confirm('13º: alterações não salvas. Descartar?');

async function fpTrocarAba(aba) {
  if (aba === 'mes' && D13.ativo && !d13PodeSair()) return;
  if (aba === 'decimo' && D13.ativo) return;
  D13.ativo = aba === 'decimo'; D13.dirty = false;
  document.getElementById('fpAbaMes').classList.toggle('active', !D13.ativo);
  document.getElementById('fpAbaDecimo').classList.toggle('active', D13.ativo);
  document.getElementById('fpViewMes').style.display    = D13.ativo ? 'none' : '';
  document.getElementById('fpViewDecimo').style.display = D13.ativo ? '' : 'none';
  document.getElementById('fpMonth').style.display      = D13.ativo ? 'none' : '';
  if (D13.ativo) await d13Carregar();
}

async function d13Carregar() {
  D13.ano = parseInt(document.getElementById('fpYear').value);
  const box = document.getElementById('fpViewDecimo');
  box.innerHTML = '<div class="fp-empty">Carregando…</div>';
  try {
    const d = await apiFetch(`/api/decimo/${D13.ano}`);
    D13.pessoas = d.pessoas; D13.entries = d.entries; D13.encerradas = d.encerradas;
    d13Abrir();
  } catch (e) { box.innerHTML = `<div class="fp-empty" style="color:var(--down)">${_esc(e.message)}</div>`; }
}

// Rascunho da tela = o que está gravado na loja/parcela aberta
function d13Abrir() {
  D13.dirty = false; D13.ed = {};
  for (const e of d13Pessoas()) {
    const s = D13.entries[e.id]?.[D13.parcela];
    if (s) D13.ed[e.id] = { ...s };
  }
  d13Render();
}
function d13Parcela(p) { if (p !== D13.parcela && d13PodeSair()) { D13.parcela = p; d13Abrir(); } }
function d13Board(b)   { if (b !== D13.board   && d13PodeSair()) { D13.board = b;   d13Abrir(); } }

function d13Render() {
  const lojas = STORE_BOARDS.filter(b => d13Pessoas(b).length);
  const tabs = ['p1', 'p2'].map(p => `<button class="fp-aba${p === D13.parcela ? ' active' : ''}" onclick="d13Parcela('${p}')">${D13_NOME[p]} · ${D13_MES[p]}</button>`).join('');
  const bots = lojas.map(b => {
    const lanc = d13Pessoas(b).some(e => D13.entries[e.id]?.[D13.parcela]);
    return `<button class="fp-store-btn${b === D13.board ? ' active' : ''}" style="--c:${BOARDS_INFO[b].color}" onclick="d13Board('${b}')">${BOARDS_INFO[b].label}${D13.encerradas[b]?.[D13.parcela] ? ' ⊠' : lanc ? ' ✓' : ''}</button>`;
  }).join('');
  document.getElementById('fpViewDecimo').innerHTML = `
    <div class="fp-abas fp-abas-sub">${tabs}<span class="fp-d13-prazo">pagar até ${d13Prazo()}</span></div>
    <div class="fp-stores">${bots}</div>
    ${D13.board ? d13Painel() : d13Resumo(lojas)}`;
  if (D13.board) d13Totais();
}

function d13Resumo(lojas) {
  let geral = 0;
  const linhas = lojas.map(b => {
    const ps = d13Pessoas(b).filter(e => D13.entries[e.id]?.[D13.parcela]);
    const t = r2(ps.reduce((s, e) => s + d13Total(D13.entries[e.id][D13.parcela], e.id), 0));
    geral = r2(geral + t);
    return `<tr><td style="color:${BOARDS_INFO[b].color};font-weight:600">${BOARDS_INFO[b].label}</td><td class="n">${ps.length} de ${d13Pessoas(b).length}</td><td class="n">${brl(t)}</td></tr>`;
  }).join('');
  return `<div class="fp-panel"><div class="fp-d13-scroll"><table class="fp-d13"><thead><tr><th>Loja</th><th class="n">Lançados</th><th class="n">A pagar em ${D13_MES[D13.parcela].toLowerCase()}</th></tr></thead>
    <tbody>${linhas}</tbody><tfoot><tr><td>TOTAL</td><td></td><td class="n">${brl(geral)}</td></tr></tfoot></table></div>
    <div class="fp-d13-nota">Selecione uma loja para lançar.</div></div>`;
}

const D13_COLS = {
  p1: [['base', 'Base'], ['avos', 'Avos'], ['valor', '1ª parcela']],
  p2: [['base', 'Base'], ['avos', 'Avos'], ['bruto', '13º bruto'], ['_p1', '1ª parcela'], ['inss', 'INSS'], ['irrf', 'IRRF'], ['outros', 'Outros desc.'], ['_liq', 'Líquido 2ª']],
};

function d13Painel() {
  const enc = d13Enc(), info = BOARDS_INFO[D13.board], dis = enc ? ' disabled' : '';
  const cols = D13_COLS[D13.parcela];
  const linhas = d13Pessoas().map(e => {
    const l = D13.ed[e.id] || {}, sug = e.sugestao[D13.parcela];
    const cel = cols.map(([k, rot]) => {
      if (k === '_p1')  return `<td class="n">${brl(_p1De(e.id)?.valor || 0)}</td>`;
      if (k === '_liq') return `<td class="n forte" id="d13-liq-${e.id}"></td>`;
      const v = l[k] == null ? '' : k === 'avos' ? l[k] : r2(l[k]).toFixed(2);
      const ph = k === 'base' && sug.media.valor ? sug.media.valor.toFixed(2) : k === 'avos' ? sug.avos : '';
      return `<td class="n"><input type="number" id="d13-${k}-${e.id}" value="${v}" placeholder="${ph}" min="0" step="${k === 'avos' ? 1 : 0.01}"${k === 'avos' ? ' max="12" class="curto"' : ''}${dis} aria-label="${rot} de ${_esc(e.apelido || e.name)}" oninput="d13Campo(${e.id},'${k}',this.value)"></td>`;
    }).join('');
    const adm = e.admissaoContrato || e.admissao;
    return `<tr><td><b>${_esc(e.apelido || e.name)}</b> ${naoRegistrado(e) ? TAG_NAO_REGISTRADO : ''}
        <small>${_esc(e.cargo)}${adm ? ' · adm. ' + fmtDataBR(adm) : ''}${sug.media.meses ? ` · média de ${sug.media.meses} ${sug.media.meses > 1 ? 'meses' : 'mês'}: ${brl(sug.media.valor)}` : ' · sem folha cheia no ano'}${e.desligamento ? ' · desligado ' + fmtDataBR(e.desligamento) : ''}</small></td>${cel}
      <td><input type="date" value="${l.pagoEm || ''}"${dis} aria-label="Pago em" onchange="d13Campo(${e.id},'pagoEm',this.value)"></td>
      <td>${enc ? '' : `<button class="fp-extra-btn" title="Limpar lançamento" onclick="d13Limpar(${e.id})">×</button>`}</td></tr>`;
  }).join('');
  return `<div class="fp-panel"><div class="fp-panel-header" style="flex-wrap:wrap">
      <span class="fp-panel-title" style="color:${info.color}">${info.label} — 13º ${D13.ano} · ${D13_NOME[D13.parcela]}</span>
      ${enc ? '<span style="font-size:.72rem;color:var(--up)">● Encerrada</span>' : ''}
      <div class="fp-panel-actions">
        ${enc ? '' : '<button class="fp-btn" onclick="d13Calcular()">Calcular</button><button class="fp-btn warning" onclick="d13Salvar()">Salvar</button>'}
        <button class="fp-btn success" onclick="d13Exportar()">Exportar Excel</button>
        <button class="fp-btn" onclick="d13Recibos()">Recibos</button>
        ${enc ? '<button class="fp-btn reabrir" onclick="d13Encerrar(false)">Reabrir</button>' : '<button class="fp-btn encerrar" onclick="d13Encerrar(true)">Encerrar parcela</button>'}
      </div></div>
    <div class="fp-d13-scroll"><table class="fp-d13"><thead><tr><th>Colaborador</th>${cols.map(c => `<th class="n">${c[1]}</th>`).join('')}<th>Pago em</th><th></th></tr></thead>
      <tbody>${linhas}</tbody>
      <tfoot><tr><td>TOTAL</td>${cols.map(([k]) => `<td class="n" id="d13-tot-${k}"></td>`).join('')}<td></td><td></td></tr></tfoot></table></div>
    <div class="fp-d13-nota">${D13.parcela === 'p1'
      ? 'Base × avos ÷ 12 ÷ 2, sem descontos.'
      : 'Base × avos ÷ 12, menos a 1ª parcela e os descontos. INSS pelo percentual da configuração do colaborador; IRRF é digitado.'}
      <b>Calcular</b> preenche só quem está em branco, com a média das folhas cheias do ano (sem ajuda de custo e sem por fora). Sócio e não registrado ficam de fora do Calcular, mas aceitam valor digitado. Confira com a contabilidade.</div></div>`;
}

function d13Recalc(e, l) {
  const cheio = r2(l.base) * (l.avos || 0) / 12;
  if (D13.parcela === 'p1') l.valor = r2(cheio / 2);
  else { l.bruto = r2(cheio); l.inss = r2(cheio * (e.inssRate || 0) / 100); }
}
function d13Campo(id, k, v) {
  const e = D13.pessoas.find(x => x.id === id);
  const l = D13.ed[id] || (D13.ed[id] = { avos: e.sugestao[D13.parcela].avos });
  l[k] = k === 'pagoEm' ? v : parseFloat(v) || 0;
  D13.dirty = true;
  if (k === 'base' || (k === 'avos' && l.base)) d13Recalc(e, l);
  for (const [c] of D13_COLS[D13.parcela]) {
    const el = document.getElementById(`d13-${c}-${id}`);
    if (c !== k && el && l[c] != null) el.value = c === 'avos' ? l[c] : r2(l[c]).toFixed(2);
  }
  d13Totais();
}
function d13Totais() {
  const ps = d13Pessoas().filter(e => D13.ed[e.id]);
  const val = (e, k) => k === '_p1' ? r2(_p1De(e.id)?.valor) : k === '_liq' ? d13Total(D13.ed[e.id], e.id) : r2(D13.ed[e.id][k]);
  for (const [k] of D13_COLS[D13.parcela]) {
    const el = document.getElementById(`d13-tot-${k}`);
    if (el && k !== 'avos' && k !== 'base') el.textContent = brl(ps.reduce((s, e) => s + val(e, k), 0));
  }
  if (D13.parcela === 'p2') d13Pessoas().forEach(e => {
    const el = document.getElementById(`d13-liq-${e.id}`);
    const t = D13.ed[e.id] ? d13Total(D13.ed[e.id], e.id) : 0;
    el.textContent = D13.ed[e.id] ? brl(t) : '—';
    el.style.color = t < 0 ? 'var(--down)' : '';
  });
}

function d13Calcular() {
  let n = 0; const fora = [];
  for (const e of d13Pessoas()) {
    if (D13.ed[e.id]) continue;
    const s = e.sugestao[D13.parcela];
    // Na 2ª, sem folha para a média vale a base que foi usada na 1ª
    const base = s.media.valor || r2(_p1De(e.id)?.base);
    if (naoRegistrado(e) || cargoTipo(e.cargo) === 'socio' || !base || !s.avos) { fora.push(e.apelido || e.name.split(' ')[0]); continue; }
    const l = { base, avos: s.avos, pagoEm: '' };
    if (D13.parcela === 'p2') { l.irrf = 0; l.outros = 0; }
    d13Recalc(e, l); D13.ed[e.id] = l; n++;
  }
  if (n) D13.dirty = true;
  d13Render();
  toast(`${n} calculado(s).${fora.length ? ` Em branco: ${fora.join(', ')}.` : ''}`, fora.length ? 'warn' : false, 6000);
}
function d13Limpar(id) {
  if (!D13.ed[id]) return;
  delete D13.ed[id]; D13.dirty = true; d13Render();
}

async function d13Gravar(encerrada) {
  const entries = {};
  for (const e of d13Pessoas()) entries[e.id] = D13.ed[e.id] || null;
  // Reabrir não manda valores: só destrava
  const corpo = encerrada === false ? { encerrada } : { entries, ...(encerrada ? { encerrada } : {}) };
  const r = await apiFetch(`/api/decimo/${D13.ano}/${D13.board}/${D13.parcela}`, 'POST', corpo);
  D13.entries = r.entries; D13.encerradas = r.encerradas;
  d13Abrir();
}
const d13Erro = e => { let m = e.message; try { m = JSON.parse(m).error || m; } catch {} toast('Erro: ' + m, true, 6000); };
async function d13Salvar() { try { await d13Gravar(); toast('13º salvo.'); } catch (e) { d13Erro(e); } }
async function d13Encerrar(fechar) {
  if (fechar && d13Pessoas().some(e => D13.ed[e.id] && d13Total(D13.ed[e.id], e.id) < 0)
      && !confirm('Há líquido negativo. Encerrar assim mesmo?')) return;
  try { await d13Gravar(fechar); toast(fechar ? 'Parcela encerrada ✓' : 'Parcela reaberta.'); } catch (e) { d13Erro(e); }
}
async function d13Exportar() {
  if (D13.dirty) { try { await d13Gravar(); } catch (e) { return d13Erro(e); } }
  location.href = `/api/decimo/${D13.ano}/${D13.parcela}/export?board=${D13.board}`;
}

function d13Recibos() {
  const ps = d13Pessoas().filter(e => D13.ed[e.id] && d13Total(D13.ed[e.id], e.id) > 0);
  if (!ps.length) return toast('Nenhum valor lançado nesta parcela.', true);
  const logo = D13.board === 'tommy' ? 'logotommy.svg' : 'logosurfers.webp';
  const paginas = ps.map(e => {
    const l = D13.ed[e.id], p2 = D13.parcela === 'p2';
    const lin = [[`13º salário — ${l.avos}/12 avos${p2 ? '' : ' (1ª parcela)'}`, p2 ? r2(l.bruto) : r2(l.valor)]];
    if (p2) [['(−) 1ª parcela', _p1De(e.id)?.valor], ['(−) INSS', l.inss], ['(−) IRRF', l.irrf], ['(−) Outros descontos', l.outros]]
      .forEach(([t, v]) => { if (r2(v)) lin.push([t, -r2(v)]); });
    return `<section><header><img src="${location.origin}/${logo}" alt=""><div><h1>Recibo de 13º salário — ${D13_NOME[D13.parcela]}</h1><p>${BOARDS_INFO[D13.board].label} · ${D13_MES[D13.parcela]}/${D13.ano}</p></div></header>
      <p><b>${_esc(e.name)}</b> · ${_esc(e.cargo)}${e.admissaoContrato || e.admissao ? ' · ADM. ' + fmtDataBR(e.admissaoContrato || e.admissao) : ''}</p>
      <table>${lin.map(([t, v]) => `<tr><td>${t}</td><td>${brl(v)}</td></tr>`).join('')}<tr class="t"><td>LÍQUIDO</td><td>${brl(d13Total(l, e.id))}</td></tr></table>
      <p>Recebi a importância líquida acima, referente à ${D13_NOME[D13.parcela]} do 13º salário de ${D13.ano}.</p>
      <div class="ass">Assinatura do colaborador<br>___/___/${D13.ano}</div></section>`;
  }).join('');
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return toast('Permita popups para imprimir.', true);
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Recibos 13º — ${BOARDS_INFO[D13.board].label}</title><style>
    *{box-sizing:border-box;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font:10.5pt Arial,sans-serif;color:#000;background:#fff}
    section{max-width:720px;margin:16px auto;padding:14px;border:1px solid #000;break-inside:avoid}header{display:flex;gap:14px;align-items:center;margin-bottom:12px}
    img{height:42px}h1{font-size:13pt}table{width:100%;border-collapse:collapse;margin:10px 0}td{border:1px solid #000;padding:4px 6px}td:last-child{text-align:right;white-space:nowrap;width:150px}
    .t td{font-weight:700;background:#ddd}.ass{width:55%;margin:34px auto 0;border-top:1px solid #000;padding-top:4px;text-align:center;font-size:9pt}
    @page{size:A4 portrait;margin:8mm 10mm}</style></head><body>${paginas}</body></html>`);
  win.document.close(); win.focus();
  setTimeout(() => { try { win.print(); } catch (_) {} }, 600);
}

window.addEventListener('beforeunload', ev => { if (D13.dirty) ev.preventDefault(); });
