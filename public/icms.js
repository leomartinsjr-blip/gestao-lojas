// ── Diferencial de alíquota de ICMS ─────────────────────────────────────────
// O relatório do Microvix diz o que deu entrada; o XML diz a base de cálculo.
// A tela junta os dois, deixa marcar nota a nota e, ao finalizar, trava as
// notas contra reapuração — é o que impede pagar o mesmo imposto duas vezes.

const $ = id => document.getElementById(id);

const ALIQ_INTERNA = 0.18;

const fBRL = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Base e imposto em duas casas, como qualquer valor em real. As quatro casas
// eram resíduo da planilha feita à mão, não precisão de verdade.
const f4 = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fPct = v => (Number(v || 0) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
const fData = s => s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Mesma conta do servidor, para o total responder na hora ao desmarcar uma nota.
function passos(base, aliqOrigem) {
  const excl = base * (1 - aliqOrigem);
  const incl = excl / (1 - ALIQ_INTERNA);
  const deb = incl * ALIQ_INTERNA;
  const cred = base * aliqOrigem;
  return { base, exclusaoInterestadual: excl, inclusaoInterno: incl, debito: deb, credito: cred, aPagar: deb - cred };
}

let arquivosRel = [];
let arquivosXml = [];
let arquivosCont = [];
let resultado = null;
const selecao = new Set();      // chaves marcadas

// ── Abas ─────────────────────────────────────────────────────────────────────
function mostrarAba(qual) {
  ['apurar', 'resumo', 'historico'].forEach(a => {
    $('view' + a[0].toUpperCase() + a.slice(1)).style.display = qual === a ? 'block' : 'none';
    $('tab' + a[0].toUpperCase() + a.slice(1)).style.background = qual === a ? '#1f6feb' : 'transparent';
  });
  ['competencia', 'btnApurar', 'btnExportar', 'btnFinalizar'].forEach(id =>
    $(id).style.display = qual === 'apurar' ? '' : 'none');
}
$('tabApurar').addEventListener('click', () => mostrarAba('apurar'));
$('tabResumo').addEventListener('click', () => { mostrarAba('resumo'); carregarResumo(); });
$('tabHistorico').addEventListener('click', () => { mostrarAba('historico'); carregarHistorico(); });

// ── Upload ───────────────────────────────────────────────────────────────────
function ligarDrop(idDrop, idInput, idLista, guardar) {
  const drop = $(idDrop);
  const input = $(idInput);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => aceitar([...input.files]));
  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => aceitar([...e.dataTransfer.files]));

  function aceitar(files) {
    if (!files.length) return;
    guardar(files);
    $(idLista).textContent = files.map(f => f.name).join(', ');
    drop.classList.add('ok');
    $('btnApurar').disabled = !(arquivosRel.length && arquivosXml.length);
  }
}
ligarDrop('dropRel', 'inpRel', 'relFiles', f => { arquivosRel = f; });
ligarDrop('dropXml', 'inpXml', 'xmlFiles', f => { arquivosXml = f; });
ligarDrop('dropCont', 'inpCont', 'contFiles', f => { arquivosCont = f; });

function erro(msg) {
  const b = $('errorBox');
  if (!msg) { b.style.display = 'none'; return; }
  b.innerHTML = esc(msg);
  b.style.display = 'block';
}

// ── Apuração ─────────────────────────────────────────────────────────────────
async function apurar() {
  erro(null);
  $('alertBox').style.display = 'none';
  $('avisos').innerHTML = '';
  $('empresas').innerHTML = '';
  $('summaryStrip').style.display = 'none';
  $('stateBox').style.display = 'block';
  $('stateBox').innerHTML = '<div class="mx-spinner"></div><div>Lendo os arquivos e apurando…</div>';
  $('btnApurar').disabled = true;

  const fd = new FormData();
  arquivosRel.forEach(f => fd.append('relatorio', f));
  arquivosXml.forEach(f => fd.append('xmls', f));
  arquivosCont.forEach(f => fd.append('contabilidade', f));
  const comp = $('competencia').value;
  if (comp) fd.append('competencia', comp);

  try {
    const r = await fetch('/api/icms/apurar', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Falha na apuração');
    resultado = data;
    selecao.clear();
    data.empresas.forEach(e => e.linhas.forEach(l => { if (l.selecionada && l.chave) selecao.add(l.chave); }));
    render();
  } catch (e) {
    erro(e.message);
    $('stateBox').textContent = 'Não foi possível apurar.';
  } finally {
    $('btnApurar').disabled = !(arquivosRel.length && arquivosXml.length);
  }
}
$('btnApurar').addEventListener('click', apurar);

// ── Totais a partir da seleção ───────────────────────────────────────────────
function totaisDe(emp) {
  const sel = emp.linhas.filter(l => l.incluida && l.chave && selecao.has(l.chave));
  const base4 = sel.reduce((s, l) => s + l.base4, 0);
  const base12 = sel.reduce((s, l) => s + l.base12, 0);
  const p4 = passos(base4, 0.04);
  const p12 = passos(base12, 0.12);
  return { sel, base4, base12, p4, p12, difal: p4.aPagar + p12.aPagar };
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const d = resultado;
  const totais = d.empresas.map(totaisDe);
  const total = totais.reduce((s, t) => s + t.difal, 0);
  const notas = totais.reduce((s, t) => s + t.sel.length, 0);
  const fora = d.empresas.reduce((s, e) => s + e.excluidas.length, 0);
  const conferir = d.empresas.reduce((s, e) => s + e.atencao.length + e.revisar.length, 0);

  $('sumTotal').textContent = fBRL(total);
  $('sumNotas').textContent = notas;
  $('sumFora').textContent = fora;
  $('sumConferir').textContent = conferir;
  $('summaryStrip').style.display = 'grid';
  $('stateBox').style.display = 'none';
  $('btnExportar').disabled = notas === 0;
  $('btnFinalizar').disabled = notas === 0;

  $('avisos').innerHTML = renderAvisos(d.avisos || []);
  $('conferencia').innerHTML = renderConferencia(d.conferencia);
  $('pendencias').innerHTML = renderPendencias(d.pendencias || []);
  document.querySelectorAll('.mx-pend-hdr').forEach(h =>
    h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
  document.querySelectorAll('button[data-transito]').forEach(b =>
    b.addEventListener('click', () => marcarTransito(b.dataset.transito, b.dataset.chave, b.dataset.confirmar)));

  $('empresas').innerHTML = d.empresas.map((e, i) => cardEmpresa(e, totais[i], i)).join('');

  document.querySelectorAll('.mx-emp-hdr').forEach(h =>
    h.addEventListener('click', ev => {
      if (ev.target.closest('input,button')) return;
      h.parentElement.classList.toggle('open');
    }));

  document.querySelectorAll('input[data-chave]').forEach(cb =>
    cb.addEventListener('change', () => {
      const k = cb.dataset.chave;
      if (cb.checked) selecao.add(k); else selecao.delete(k);
      const abertas = [...document.querySelectorAll('.mx-emp.open')].map(el => el.dataset.i);
      render();
      abertas.forEach(i => document.querySelector(`.mx-emp[data-i="${i}"]`)?.classList.add('open'));
    }));

  document.querySelectorAll('button[data-todas]').forEach(b =>
    b.addEventListener('click', () => {
      const emp = d.empresas[Number(b.dataset.todas)];
      const marcar = b.dataset.acao === 'marcar';
      emp.linhas.filter(l => l.incluida && l.chave && !l.jaApurada).forEach(l => {
        if (marcar) selecao.add(l.chave); else selecao.delete(l.chave);
      });
      const abertas = [...document.querySelectorAll('.mx-emp.open')].map(el => el.dataset.i);
      render();
      abertas.forEach(i => document.querySelector(`.mx-emp[data-i="${i}"]`)?.classList.add('open'));
    }));

  document.querySelectorAll('button[data-finalizar]').forEach(b =>
    b.addEventListener('click', () => finalizarEmpresa(Number(b.dataset.finalizar))));

  document.querySelectorAll('button[data-editar]').forEach(b =>
    b.addEventListener('click', () => abrirEdicao(b.dataset.cnpj, b.dataset.editar)));
  document.querySelectorAll('button[data-incluir]').forEach(b =>
    b.addEventListener('click', () => abrirEdicao(b.dataset.incluir, null)));
  document.querySelectorAll('button[data-desfazer]').forEach(b =>
    b.addEventListener('click', () => desfazerAjuste(b.dataset.desfazer)));
  document.querySelectorAll('button[data-adiar]').forEach(b =>
    b.addEventListener('click', () => adiarNota(b.dataset.adiar, b.dataset.doc)));
}

// Empurra a nota para a competência seguinte. Só existe para o caso em que a
// contabilidade lançou a nota em outro mês e não vai corrigir — o corte normal
// é pela data de entrada, e é ele que vale.
async function adiarNota(chave, doc) {
  const comp = $('competencia').value;
  if (!comp) return erro('Escolha a competência antes de adiar.');

  const linha = resultado.empresas
    .flatMap(e => e.linhas)
    .find(l => l.chave === chave);
  if (!linha) return erro('Nota não encontrada no resultado.');

  const [ano, mes] = comp.split('-').map(Number);
  const destino = mes === 12 ? `01/${ano + 1}` : `${String(mes + 1).padStart(2, '0')}/${ano}`;
  if (!confirm(
    `Adiar a nota ${doc} para ${destino}?\n\n` +
    'Ela sai da conta deste mês e volta sozinha na próxima apuração, já calculada. ' +
    'Use isso só quando a contabilidade lançou a nota em outro mês e não vai corrigir.',
  )) return;

  erro(null);
  try {
    const r = await fetch('/api/icms/transito/adiar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave, linha, competencia: comp }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Não foi possível adiar');
    await apurar();
  } catch (e) {
    erro(e.message);
  }
}

// ── Recusar / reativar nota do trânsito ──────────────────────────────────────
// Depois de marcar, reapura em vez de mexer no resultado que está na tela: a
// nota some de um grupo e aparece em outro, e quem sabe montar isso é o
// servidor. Os arquivos já estão em memória, então é só refazer a chamada.
async function marcarTransito(tipo, chave, confirmar) {
  if (confirmar && !confirm(confirmar)) return;
  erro(null);
  try {
    const r = await fetch(`/api/icms/transito/${tipo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Não foi possível marcar a nota');
    await apurar();
  } catch (e) {
    erro(e.message);
  }
}

// ── Avisos sobre o lote ──────────────────────────────────────────────────────
// Falam do que foi enviado, não de nota específica — por isso ficam acima da
// conferência: é o que explica a diferença antes de ela aparecer no total.
function renderAvisos(avisos) {
  return avisos.map(a => `
    <div class="mx-pend ${a.gravidade || 'aviso'}">
      <div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem .2rem">
        <span class="mx-pend-ico">${ICONE[a.gravidade] || '•'}</span>
        <span class="mx-pend-tit">${esc(a.titulo)}</span>
      </div>
      <div style="font-size:.78rem;color:#8b949e;line-height:1.55;padding:0 .9rem .7rem 2.5rem">
        ${esc(a.detalhe)}
      </div>
    </div>`).join('');
}

// ── Confronto com a contabilidade ────────────────────────────────────────────
function renderConferencia(c) {
  if (!c) return '';

  const linhas = (titulo, itens, colunas) => itens.length ? `
    <div class="mx-sec">${titulo} (${itens.length})</div>
    <div class="mx-scroll"><table class="mx-t">${colunas}</table></div>` : '';

  return `
  <div class="mx-conf">
    <div class="mx-conf-topo">
      <div>
        <div class="mx-sum-label">Nosso cálculo</div>
        <div class="mx-conf-num">${fBRL(c.totais.nosso)}</div>
      </div>
      <div>
        <div class="mx-sum-label">Contabilidade</div>
        <div class="mx-conf-num">${fBRL(c.totais.contabilidade)}</div>
      </div>
      <div>
        <div class="mx-sum-label">Diferença</div>
        <div class="mx-conf-num ${c.totais.bate ? 'mx-conf-ok' : 'mx-conf-dif'}">
          ${c.totais.bate ? 'fecha' : fBRL(c.totais.diferenca)}
        </div>
      </div>
      <div style="margin-left:auto;display:flex;gap:.4rem;flex-wrap:wrap">
        <span class="mx-chip ok">${c.conferem.length} conferem</span>
        ${c.divergentes.length ? `<span class="mx-chip dif">${c.divergentes.length} divergem</span>` : ''}
        ${c.soNossas.length ? `<span class="mx-chip">${c.soNossas.length} só nossas</span>` : ''}
        ${c.soDeles.length ? `<span class="mx-chip">${c.soDeles.length} só deles</span>` : ''}
      </div>
    </div>

    ${linhas('Divergem', c.divergentes, `
      <tr><th>Nota</th><th>Fornecedor</th><th>Base 4% nossa</th><th>Base 4% deles</th>
        <th>Base 12% nossa</th><th>Base 12% deles</th><th>Nosso</th><th>Deles</th><th>Diferença</th></tr>
      ${c.divergentes.map(d => `<tr>
        <td>${esc(d.doc)}</td><td style="text-align:left">${esc((d.fornecedor || '').slice(0, 24))}</td>
        <td>${f4(d.base4)}</td><td>${f4(d.deles.base4)}</td>
        <td>${f4(d.base12)}</td><td>${f4(d.deles.base12)}</td>
        <td>${f4(d.difal)}</td><td>${f4(d.deles.aPagar)}</td>
        <td style="color:#f85149;font-weight:700">${f4(d.diferenca.aPagar)}</td>
      </tr>`).join('')}`)}

    ${linhas('Só no nosso cálculo — a contabilidade não tem', c.soNossas, `
      <tr><th>Nota</th><th>Fornecedor</th><th>Base 4%</th><th>Base 12%</th><th>Valor</th></tr>
      ${c.soNossas.map(d => `<tr>
        <td>${esc(d.doc)}</td><td style="text-align:left">${esc((d.fornecedor || '').slice(0, 30))}</td>
        <td>${f4(d.base4)}</td><td>${f4(d.base12)}</td><td>${f4(d.difal)}</td>
      </tr>`).join('')}`)}

    ${linhas('Só na contabilidade — não temos', c.soDeles, `
      <tr><th>Nota</th><th>Base 4%</th><th>Base 12%</th><th>Valor</th></tr>
      ${c.soDeles.map(d => `<tr>
        <td>${esc(d.nNFOriginal || d.nNF)}</td>
        <td>${f4(d.base4)}</td><td>${f4(d.base12)}</td><td>${f4(d.aPagar)}</td>
      </tr>`).join('')}`)}
  </div>`;
}

// ── Pendências ───────────────────────────────────────────────────────────────
const ICONE = { grave: '⚠', aviso: '•', ok: '✓' };

function renderPendencias(grupos) {
  if (!grupos.length) return '';
  // Os que exigem ação primeiro, e já abertos.
  const ordenados = [...grupos].sort((a, b) =>
    (b.acao ? 1 : 0) - (a.acao ? 1 : 0) ||
    (b.gravidade === 'grave' ? 1 : 0) - (a.gravidade === 'grave' ? 1 : 0));

  return ordenados.map(g => `
    <div class="mx-pend ${g.gravidade} ${g.acao ? 'open' : ''}">
      <div class="mx-pend-hdr">
        <span class="mx-pend-ico">${ICONE[g.gravidade] || '•'}</span>
        <span class="mx-pend-tit">${esc(g.titulo)}</span>
        <span class="mx-pend-qtd">${g.qtd}</span>
        <span class="mx-emp-chev">▾</span>
      </div>
      <div class="mx-pend-body">
        ${g.acao ? `<div class="mx-pend-acao">O que fazer: ${esc(g.acao)}</div>` : ''}
        <div class="mx-scroll"><table class="mx-t">
          <tr><th>Nota</th><th>Fornecedor</th><th>Lçto</th><th>Valor</th><th>Situação</th>
            ${g.acaoNota ? '<th></th>' : ''}</tr>
          ${g.notas.map(n => `<tr>
            <td>${esc(n.doc)}</td>
            <td style="text-align:left">${esc(n.fornecedor || '—')}</td>
            <td>${fData(n.dtLancamento)}</td>
            <td>${n.valor ? fBRL(n.valor) : '—'}</td>
            <td style="text-align:left">${esc(n.detalhe || '')}</td>
            ${g.acaoNota ? `<td>${n.chave
              ? `<button class="mx-btn ghost" style="font-size:.72rem;padding:.15rem .5rem" data-transito="${esc(g.acaoNota.tipo)}" data-chave="${esc(n.chave)}"
                   data-confirmar="${esc(g.acaoNota.confirmar || '')}">${esc(g.acaoNota.rotulo)}</button>`
              : ''}</td>` : ''}
          </tr>`).join('')}
        </table></div>
      </div>
    </div>`).join('');
}

// Uma linha por nota, com as duas alíquotas lado a lado — o formato das
// planilhas antigas. Nota que tem base nas duas aparece uma vez só.
function tabelaNotas(emp, t) {
  const notas = emp.linhas
    .filter(n => n.incluida && (n.base4 > 0 || n.base12 > 0))
    .sort((a, b) => String(a.dtLancamento || a.dhEmi || '').localeCompare(String(b.dtLancamento || b.dhEmi || '')));
  if (!notas.length) return '<div class="mx-state">Nenhuma nota entrou no cálculo.</div>';

  const cel = (v) => v > 0 ? f4(v) : '<span style="color:#484f58">—</span>';

  return `
  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th class="sel"></th><th>Nota fiscal</th><th>Emissão</th><th>Lçto</th>
      <th>Fornecedor</th><th>UF</th><th>Vlr. total</th>
      <th>Base 4%</th><th>Base 12%</th><th>DIFAL 4%</th><th>DIFAL 12%</th><th>Total</th><th></th>
    </tr>
    ${notas.map(n => {
      const marcada = n.chave && selecao.has(n.chave);
      const d4 = passos(n.base4, 0.04).aPagar;
      const d12 = passos(n.base12, 0.12).aPagar;
      const dup = n.jaApurada && !n.jaApurada.mesmaCompetencia;
      return `<tr class="${marcada ? '' : 'off'} ${dup ? 'dup' : ''}">
        <td class="sel"><input type="checkbox" data-chave="${esc(n.chave)}" ${marcada ? 'checked' : ''} ${n.chave ? '' : 'disabled'}></td>
        <td>${esc(n.doc)}${dup ? `<span class="mx-badge-dup">já apurada em ${esc(n.jaApurada.competencia)}</span>` : ''}</td>
        <td>${fData(n.dhEmi)}</td>
        <td>${fData(n.dtLancamento)}</td>
        <td style="text-align:left">${esc((n.fornecedor || '').slice(0, 28))}</td>
        <td>${esc(n.ufOrigem)}</td>
        <td>${f4(n.vlrTotal)}</td>
        <td>${cel(n.base4)}</td>
        <td>${cel(n.base12)}</td>
        <td>${cel(d4)}</td>
        <td>${cel(d12)}</td>
        <td><b>${f4(d4 + d12)}</b></td>
        <td style="white-space:nowrap">
          <button class="mx-link" data-editar="${esc(n.doc)}" data-cnpj="${esc(emp.cnpj)}">conferir</button>
          ${n.chave ? `<button class="mx-link" data-adiar="${esc(n.chave)}" data-doc="${esc(n.doc)}"
            style="margin-left:.5rem;color:#d29922">adiar</button>` : ''}
        </td>
      </tr>
      ${n.ajuste ? `<tr class="${marcada ? '' : 'off'}"><td></td><td colspan="12" style="text-align:left;font-size:.72rem;color:#79c0ff">
        base ajustada à mão — original 4% ${f4(n.ajuste.base4Original)} / 12% ${f4(n.ajuste.base12Original)}
        ${n.ajuste.motivo ? ` — ${esc(n.ajuste.motivo)}` : ''}
        ${n.ajuste.por ? ` (${esc(n.ajuste.por)})` : ''}
        <button class="mx-link" data-desfazer="${esc(n.ajuste._id || '')}" style="color:#f85149;margin-left:.5rem">desfazer</button>
      </td></tr>` : ''}`;
    }).join('')}
    <tr class="tot">
      <td class="sel"></td><td>Total marcado</td><td></td><td></td><td></td><td></td><td></td>
      <td>${f4(t.base4)}</td><td>${f4(t.base12)}</td>
      <td>${f4(t.p4.aPagar)}</td><td>${f4(t.p12.aPagar)}</td><td>${f4(t.difal)}</td><td></td>
    </tr>
  </table></div>
  <div style="margin-top:.5rem">
    <button class="mx-link" data-incluir="${esc(emp.cnpj)}">+ incluir nota que não veio no lote</button>
  </div>

  <div class="mx-sec">Recomposição da base</div>
  <div class="mx-scroll"><table class="mx-t">
    <tr><th>Alíquota de origem</th><th>Base</th><th>Exclusão interest.</th>
      <th>Inclusão interno</th><th>Débito</th><th>Crédito</th><th>ICMS a pagar</th></tr>
    ${[[4, t.p4], [12, t.p12]].filter(([, p]) => p.base > 0).map(([a, p]) => `<tr>
      <td>${a}%</td><td>${f4(p.base)}</td><td>${f4(p.exclusaoInterestadual)}</td>
      <td>${f4(p.inclusaoInterno)}</td><td>${f4(p.debito)}</td><td>${f4(p.credito)}</td><td>${f4(p.aPagar)}</td>
    </tr>`).join('')}
    <tr class="tot"><td>Total</td><td>${f4(t.base4 + t.base12)}</td><td></td><td></td>
      <td>${f4(t.p4.debito + t.p12.debito)}</td><td>${f4(t.p4.credito + t.p12.credito)}</td>
      <td>${f4(t.difal)}</td></tr>
  </table></div>`;
}

function cardEmpresa(emp, t, i) {
  const conferir = [
    ...emp.atencao.flatMap(l => l.atencao.map(a => ({ doc: l.doc, ...a }))),
    ...emp.revisar.flatMap(l => l.revisar.map(a => ({ doc: l.doc, ...a }))),
  ];

  return `
  <div class="mx-emp" data-i="${i}">
    <div class="mx-emp-hdr">
      <div class="mx-emp-nome">${esc(emp.empresa)}<span class="mx-emp-cnpj">${esc(emp.cnpj)}</span></div>
      <div class="mx-emp-val">${fBRL(t.difal)}</div>
      <div class="mx-emp-chev">▾</div>
    </div>
    <div class="mx-emp-body">
      <div class="mx-selbar">
        <span>${t.sel.length} de ${emp.incluidas.length} notas marcadas</span>
        <button class="mx-link" data-todas="${i}" data-acao="marcar">marcar todas</button>
        <button class="mx-link" data-todas="${i}" data-acao="desmarcar">desmarcar todas</button>
        <button class="mx-btn" data-finalizar="${i}" style="margin-left:auto;background:#238636;border-color:#2ea043"
          ${t.sel.length ? '' : 'disabled'}>Finalizar esta empresa</button>
      </div>
      ${tabelaNotas(emp, t)}

      ${emp.itensST.length ? `
      <div class="mx-sec">Itens com ST em Minas Gerais</div>
      <div class="mx-scroll"><table class="mx-t">
        <tr><th>Nota</th><th>NCM</th><th>Base ICMS normal</th><th>ICMS interest.</th><th>IPI</th><th>Base ST</th><th>Valor ST</th></tr>
        ${emp.itensST.map(it => `<tr>
          <td>${esc(it.doc)}</td><td>${esc(it.ncm)}</td>
          <td>${f4(it.baseIcmsNormal)}</td><td>${f4(it.icmsInterestadual)}</td>
          <td>${f4(it.ipi)}</td><td>${f4(it.baseIcmsST)}</td><td>${f4(it.valorST)}</td>
        </tr>`).join('')}
      </table></div>` : ''}

      ${conferir.length ? `
      <div class="mx-sec">Conferir</div>
      <div class="mx-scroll"><table class="mx-t">
        <tr><th>Nota</th><th>Observação</th><th>CFOP</th><th>Valor</th></tr>
        ${conferir.map(c => `<tr>
          <td>${esc(c.doc)}</td><td style="text-align:left">${esc(c.motivo)}</td>
          <td><span class="mx-tag warn">${esc(c.cfop)}</span></td><td>${f4(c.valor)}</td>
        </tr>`).join('')}
      </table></div>` : ''}

      <div class="mx-sec">Notas que não entraram (${emp.excluidas.length})</div>
      <div class="mx-scroll"><table class="mx-t">
        <tr><th>Nota</th><th>Fornecedor</th><th>UF</th><th>Valor</th><th>Motivo</th></tr>
        ${emp.excluidas.map(n => `<tr>
          <td>${esc(n.doc)}</td><td>${esc(n.fornecedor)}</td><td>${esc(n.ufOrigem)}</td>
          <td>${f4(n.vlrTotal)}</td><td style="text-align:left">${esc(n.motivo)}</td>
        </tr>`).join('')}
      </table></div>
    </div>
  </div>`;
}

// ── Ajuste manual da base ────────────────────────────────────────────────────
// O XML nem sempre é a última palavra: a contabilidade pode apontar divergência,
// e nota lançada sem XML precisa entrar com a base digitada.
function abrirEdicao(cnpj, doc) {
  const comp = $('competencia').value;
  if (!comp) return erro('Escolha a competência antes de ajustar uma nota.');

  const emp = resultado.empresas.find(e => e.cnpj === cnpj);
  const linha = doc ? emp.linhas.find(l => l.doc === doc) : null;
  const novo = !linha;

  const b4 = prompt(
    `${novo ? 'Nova nota' : 'Nota ' + doc}\n\n` +
    'Base de cálculo IMPORTADO (origem 4%).\n' +
    'Deixe 0 se não houver.',
    linha ? String(linha.base4 || 0) : '0',
  );
  if (b4 === null) return;

  const b12 = prompt('Base de cálculo NACIONAL (origem 12%).\nDeixe 0 se não houver.',
    linha ? String(linha.base12 || 0) : '0');
  if (b12 === null) return;

  let docFinal = doc;
  let fornecedor = linha ? linha.fornecedor : '';
  if (novo) {
    docFinal = prompt('Número/série da nota (ex: 12345/1)');
    if (!docFinal) return;
    fornecedor = prompt('Fornecedor') || 'informado manualmente';
  }

  const motivo = prompt('Motivo do ajuste (fica registrado junto com o valor)');
  if (!motivo) return erro('O ajuste precisa de um motivo — é o que permite auditar depois.');

  const num = v => Number(String(v).replace(/\./g, '').replace(',', '.')) || 0;

  salvarAjuste({
    cnpj,
    competencia: comp,
    doc: docFinal,
    tipo: novo ? 'manual' : 'edicao',
    base4: num(b4),
    base12: num(b12),
    fornecedor,
    ufOrigem: linha ? linha.ufOrigem : '',
    dtLancamento: linha ? linha.dtLancamento : null,
    motivo,
  });
}

async function salvarAjuste(ajuste) {
  try {
    const r = await fetch('/api/icms/ajustes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ajuste),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao salvar o ajuste');
    await apurar();
  } catch (e) {
    erro(e.message);
  }
}

async function desfazerAjuste(id) {
  if (!id) return;
  if (!confirm('Desfazer este ajuste e voltar ao valor lido do XML?')) return;
  try {
    const r = await fetch('/api/icms/ajustes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || 'Falha ao desfazer');
    await apurar();
  } catch (e) {
    erro(e.message);
  }
}

// ── Recorte do resultado com só o que está marcado ───────────────────────────
function resultadoMarcado() {
  const empresas = resultado.empresas.map((e, i) => {
    const t = totaisDe(e);
    return {
      ...e,
      incluidas: t.sel,
      linhas: e.linhas,
      totais: { base4: t.base4, base12: t.base12, difal: t.difal, passos: { 4: t.p4, 12: t.p12 } },
    };
  });
  return { ...resultado, empresas, totalGeral: empresas.reduce((s, e) => s + e.totais.difal, 0) };
}

// ── Export ───────────────────────────────────────────────────────────────────
$('btnExportar').addEventListener('click', async () => {
  if (!resultado) return;
  $('btnExportar').disabled = true;
  try {
    const comp = $('competencia').value;
    const r = await fetch('/api/icms/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resultado: resultadoMarcado(),
        competencia: comp ? comp.slice(5) + '/' + comp.slice(0, 4) : null,
      }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Falha ao exportar');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ICMS-diferencial-${comp || 'apuracao'}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    erro(e.message);
  } finally {
    $('btnExportar').disabled = false;
  }
});

// ── Finalizar ────────────────────────────────────────────────────────────────
async function finalizarEmpresa(i) {
  const emp = resultado.empresas[i];
  const t = totaisDe(emp);
  const comp = $('competencia').value;
  if (!comp) return erro('Escolha a competência antes de finalizar.');
  if (!t.sel.length) return erro('Nenhuma nota marcada nesta empresa.');

  const ok = confirm(
    `Finalizar ${emp.empresa}\n` +
    `Competência ${comp}\n` +
    `${t.sel.length} notas — ${fBRL(t.difal)}\n\n` +
    'As notas ficam travadas contra reapuração em outros períodos. ' +
    'Para desfazer é preciso estornar a competência.',
  );
  if (!ok) return;

  try {
    const r = await fetch('/api/icms/finalizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competencia: comp, cnpj: emp.cnpj, empresa: emp.empresa, linhas: t.sel }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Falha ao finalizar');

    let msg = `${data.registradas} nota(s) registradas.`;
    if (data.duplicadas?.length) {
      msg += ` ${data.duplicadas.length} já constavam e foram ignoradas: ` +
        data.duplicadas.map(x => `${x.doc} (${x.competenciaAnterior})`).join(', ');
    }
    alert(msg);
    await apurar();
  } catch (e) {
    erro(e.message);
  }
}

$('btnFinalizar').addEventListener('click', () => {
  if (!resultado) return;
  if (resultado.empresas.length === 1) return finalizarEmpresa(0);
  erro('Há mais de uma empresa no lote. Use o botão "Finalizar esta empresa" dentro de cada uma.');
});

// ── Resumo ───────────────────────────────────────────────────────────────────
async function carregarResumo() {
  const box = $('resumoBox');
  box.innerHTML = '<div class="mx-state"><div class="mx-spinner"></div><div>Consultando…</div></div>';
  const q = new URLSearchParams();
  if ($('resDe').value) q.set('de', $('resDe').value);
  if ($('resAte').value) q.set('ate', $('resAte').value);
  if ($('resCnpj').value) q.set('cnpj', $('resCnpj').value);

  try {
    const r = await fetch('/api/icms/resumo?' + q);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao consultar');
    box.innerHTML = renderResumo(d);
  } catch (e) {
    box.innerHTML = `<div class="mx-error">${esc(e.message)}</div>`;
  }
}
$('btnResumo').addEventListener('click', carregarResumo);

function barra(p4, p12) {
  return `<div class="mx-barra">
    <i style="width:${(p4 * 100).toFixed(1)}%;background:#a371f7"></i>
    <i style="width:${(p12 * 100).toFixed(1)}%;background:#1f6feb"></i>
  </div>
  <div class="mx-leg">
    <span><span class="mx-dot" style="background:#a371f7"></span>origem 4% — <b>${fPct(p4)}</b></span>
    <span><span class="mx-dot" style="background:#1f6feb"></span>origem 12% — <b>${fPct(p12)}</b></span>
  </div>`;
}

function renderResumo(d) {
  if (!d.empresas.length) {
    return '<div class="mx-state">Nada finalizado nesse período ainda.</div>';
  }
  const t = d.total;

  return `
  <div class="mx-summary" style="grid-template-columns:repeat(4,1fr)">
    <div class="mx-sum-card"><div class="mx-sum-label">Total do diferencial</div><div class="mx-sum-val blue">${fBRL(t.difal)}</div></div>
    <div class="mx-sum-card"><div class="mx-sum-label">Base comprada</div><div class="mx-sum-val">${fBRL(t.baseTotal)}</div></div>
    <div class="mx-sum-card"><div class="mx-sum-label">Alíquota efetiva</div><div class="mx-sum-val" style="color:#3fb950">${fPct(t.aliquotaEfetiva)}</div></div>
    <div class="mx-sum-card"><div class="mx-sum-label">Notas</div><div class="mx-sum-val">${t.qtdNotas}</div></div>
  </div>

  <div class="mx-emp" style="padding:.9rem">
    <div class="mx-sec" style="margin-top:0">Participação por alíquota de origem — no imposto</div>
    ${barra(t.participacao4, t.participacao12)}
    <div class="mx-leg" style="margin-top:.5rem">
      <span>4%: <b>${fBRL(t.difal4)}</b></span>
      <span>12%: <b>${fBRL(t.difal12)}</b></span>
    </div>
    <div class="mx-sec">Participação por alíquota de origem — na base comprada</div>
    ${barra(t.participacaoBase4, t.participacaoBase12)}
    <div class="mx-leg" style="margin-top:.5rem">
      <span>4%: <b>${fBRL(t.base4)}</b></span>
      <span>12%: <b>${fBRL(t.base12)}</b></span>
    </div>
  </div>

  <div class="mx-sec">Por empresa</div>
  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th>Empresa</th><th>Competências</th><th>Notas</th>
      <th>Base 4%</th><th>Base 12%</th><th>Base total</th>
      <th>DIFAL 4%</th><th>DIFAL 12%</th><th>Total</th><th>% do grupo</th><th>Alíq. efetiva</th>
    </tr>
    ${d.empresas.map(e => `<tr>
      <td>${esc(e.apelido)}<div style="font-size:.68rem;color:#8b949e">${esc(e.cnpjFormatado)}</div></td>
      <td style="text-align:left;font-size:.7rem">${e.competencias.map(esc).join(', ')}</td>
      <td>${e.qtdNotas}</td>
      <td>${fBRL(e.base4)}</td><td>${fBRL(e.base12)}</td><td>${fBRL(e.baseTotal)}</td>
      <td>${fBRL(e.difal4)}</td><td>${fBRL(e.difal12)}</td>
      <td><b>${fBRL(e.difal)}</b></td>
      <td>${fPct(t.difal ? e.difal / t.difal : 0)}</td>
      <td style="color:#3fb950;font-weight:700">${fPct(e.aliquotaEfetiva)}</td>
    </tr>`).join('')}
    <tr class="tot">
      <td>Total</td><td></td><td>${t.qtdNotas}</td>
      <td>${fBRL(t.base4)}</td><td>${fBRL(t.base12)}</td><td>${fBRL(t.baseTotal)}</td>
      <td>${fBRL(t.difal4)}</td><td>${fBRL(t.difal12)}</td><td>${fBRL(t.difal)}</td>
      <td>100,00%</td><td style="color:#3fb950">${fPct(t.aliquotaEfetiva)}</td>
    </tr>
  </table></div>`;
}

// ── Histórico: competência × loja ────────────────────────────────────────────
let empresasCad = [];

async function carregarHistorico() {
  const box = $('historicoBox');
  box.innerHTML = '<div class="mx-state"><div class="mx-spinner"></div><div>Carregando…</div></div>';
  try {
    const r = await fetch('/api/icms/apuracoes');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao carregar');
    box.innerHTML = renderHistorico(d);
    document.querySelectorAll('button[data-estorno]').forEach(b =>
      b.addEventListener('click', () => estornar(b.dataset.estorno, b.dataset.comp, b.dataset.nome)));
    document.querySelectorAll('button[data-exportar]').forEach(b =>
      b.addEventListener('click', () => exportarHistorico(b.dataset.exportar, b.dataset.comp)));
  } catch (e) {
    box.innerHTML = `<div class="mx-error">${esc(e.message)}</div>`;
  }
}
$('btnHistorico').addEventListener('click', carregarHistorico);

function apelidoDe(cnpj, fallback) {
  const c = empresasCad.find(e => e.cnpj === cnpj);
  return c ? c.apelido : (fallback || cnpj);
}

function renderHistorico(lista) {
  if (!lista.length) {
    return '<div class="mx-state">Nada finalizado ainda.<br>' +
      'O histórico começa a existir quando você finalizar a primeira competência.</div>';
  }

  // Matriz competência × empresa
  const comps = [...new Set(lista.map(a => a.competencia))].sort().reverse();
  const cnpjs = [...new Set(lista.map(a => a.cnpj))];
  const celula = {};
  lista.forEach(a => { celula[a.competencia + '|' + a.cnpj] = a; });

  const totalPorCnpj = cnpjs.map(c => lista.filter(a => a.cnpj === c).reduce((s, a) => s + a.difal, 0));
  const totalGeral = lista.reduce((s, a) => s + a.difal, 0);

  return `
  <div class="mx-summary" style="grid-template-columns:repeat(3,1fr)">
    <div class="mx-sum-card"><div class="mx-sum-label">Total já apurado</div><div class="mx-sum-val blue">${fBRL(totalGeral)}</div></div>
    <div class="mx-sum-card"><div class="mx-sum-label">Competências</div><div class="mx-sum-val">${comps.length}</div></div>
    <div class="mx-sum-card"><div class="mx-sum-label">Notas</div><div class="mx-sum-val">${lista.reduce((s, a) => s + (a.qtdNotas || 0), 0)}</div></div>
  </div>

  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th>Competência</th>
      ${cnpjs.map(c => `<th>${esc(apelidoDe(c, celula[comps[0] + '|' + c]?.empresa))}</th>`).join('')}
      <th>Total do mês</th>
    </tr>
    ${comps.map(comp => {
      const doMes = cnpjs.map(c => celula[comp + '|' + c]);
      const tot = doMes.reduce((s, a) => s + (a ? a.difal : 0), 0);
      return `<tr>
        <td><b>${esc(comp)}</b></td>
        ${doMes.map(a => a
          ? `<td title="${a.qtdNotas} notas — finalizada por ${esc(a.finalizadaPor || '—')}">${fBRL(a.difal)}</td>`
          : '<td style="color:#484f58">—</td>').join('')}
        <td><b>${fBRL(tot)}</b></td>
      </tr>`;
    }).join('')}
    <tr class="tot">
      <td>Total</td>
      ${totalPorCnpj.map(v => `<td>${fBRL(v)}</td>`).join('')}
      <td>${fBRL(totalGeral)}</td>
    </tr>
  </table></div>

  <div class="mx-sec">Detalhe das competências finalizadas</div>
  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th>Competência</th><th>Empresa</th><th>Notas</th>
      <th>Base 4%</th><th>Base 12%</th><th>DIFAL 4%</th><th>DIFAL 12%</th><th>Total</th>
      <th>Alíq. efetiva</th><th>Finalizada</th><th></th>
    </tr>
    ${lista.map(a => {
      const base = (a.base4 || 0) + (a.base12 || 0);
      return `<tr>
        <td>${esc(a.competencia)}</td>
        <td style="text-align:left">${esc(apelidoDe(a.cnpj, a.empresa))}</td>
        <td>${a.qtdNotas}</td>
        <td>${fBRL(a.base4)}</td><td>${fBRL(a.base12)}</td>
        <td>${fBRL(a.difal4)}</td><td>${fBRL(a.difal12)}</td>
        <td><b>${fBRL(a.difal)}</b></td>
        <td style="color:#3fb950">${fPct(base ? a.difal / base : 0)}</td>
        <td style="font-size:.7rem">${esc(a.finalizadaPor || '—')}<br>${a.finalizadaEm ? fData(String(a.finalizadaEm).slice(0, 10)) : ''}</td>
        <td style="white-space:nowrap">
          <button class="mx-link" data-exportar="${esc(a.cnpj)}" data-comp="${esc(a.competencia)}">exportar</button>
          <button class="mx-link" data-estorno="${esc(a.cnpj)}" data-comp="${esc(a.competencia)}"
              data-nome="${esc(apelidoDe(a.cnpj, a.empresa))}" style="color:#f85149;margin-left:.5rem">estornar</button>
        </td>
      </tr>`;
    }).join('')}
  </table></div>`;
}

// Refaz a planilha de um mês já fechado, direto do que foi gravado — sem
// precisar dos arquivos de origem, que a essa altura já foram embora.
async function exportarHistorico(cnpj, competencia) {
  try {
    const r = await fetch(`/api/icms/exportar-historico?cnpj=${encodeURIComponent(cnpj)}&competencia=${encodeURIComponent(competencia)}`);
    if (!r.ok) throw new Error((await r.json()).error || 'Falha ao exportar');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ICMS-diferencial-${competencia}-${apelidoDe(cnpj, cnpj)}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(e.message);
  }
}

async function estornar(cnpj, competencia, nome) {
  const ok = confirm(
    `Estornar ${nome} — competência ${competencia}?\n\n` +
    'As notas voltam a ficar disponíveis para reapuração. Faça isso só se a ' +
    'apuração estiver errada e for refeita — se o imposto já foi recolhido, ' +
    'estornar aqui não desfaz o pagamento.',
  );
  if (!ok) return;
  try {
    const r = await fetch('/api/icms/estornar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnpj, competencia }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao estornar');
    alert(`${d.removidas} nota(s) liberadas para reapuração.`);
    carregarHistorico();
  } catch (e) {
    alert(e.message);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }

  const hoje = new Date();
  hoje.setMonth(hoje.getMonth() - 1);
  $('competencia').value = hoje.toISOString().slice(0, 7);
  $('resDe').value = hoje.getFullYear() + '-01-01';
  $('resAte').value = new Date().toISOString().slice(0, 10);

  try {
    empresasCad = await (await fetch('/api/icms/empresas')).json();
    $('resCnpj').innerHTML = '<option value="">Todas as empresas</option>' +
      empresasCad.filter(e => e.ativa).map(e => `<option value="${esc(e.cnpj)}">${esc(e.apelido)}</option>`).join('');
  } catch { /* o seletor fica só com "todas" */ }

  mostrarAba('apurar');
})();
