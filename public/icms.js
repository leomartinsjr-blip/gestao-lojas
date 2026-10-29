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
    $('tab' + a[0].toUpperCase() + a.slice(1)).classList.toggle('on', qual === a);
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
    b.addEventListener('click', () => marcarTransito(b.dataset.transito, b.dataset.chave, b.dataset.confirmar, b)));

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
  document.querySelectorAll('button[data-incluir-cont]').forEach(b =>
    b.addEventListener('click', () => incluirDaContabilidade(b.dataset.incluirCont)));
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

    // Igual à marcação de recusada: atualiza o que está na tela em vez de
    // reenviar os zips. Aqui o total muda, então a empresa é recomputada.
    // Guardado para o "Desfazer" conseguir devolver a nota ao estado anterior
    // sem precisar reapurar.
    linha._antesDoAdiamento = {
      base4: linha.base4, base12: linha.base12,
      difal4: linha.difal4, difal12: linha.difal12, difal: linha.difal,
      motivo: linha.motivo,
    };
    linha.incluida = false;
    linha.adiadaPara = d.competenciaDestino;
    linha.motivo = `adiada para ${destino}`;
    linha.base4 = 0; linha.base12 = 0;
    linha.difal4 = 0; linha.difal12 = 0; linha.difal = 0;
    selecao.delete(chave);
    resultado.empresas.forEach(recomputarEmpresa);
    tirarDasPendencias(chave);
    porNasPendencias({
      tipo: 'adiadas',
      titulo: 'Empurradas para a competência seguinte',
      gravidade: 'ok',
      acaoNota: {
        tipo: 'cancelar-adiamento',
        rotulo: 'Desfazer',
        confirmar: 'Desfazer o adiamento? A nota volta para a competência do lançamento.',
      },
    }, {
      doc: linha.doc,
      chave,
      fornecedor: linha.fornecedor,
      valor: linha.vlrTotal,
      dtLancamento: linha.dtLancamento,
      detalhe: `sai deste mês e entra em ${d.competenciaDestino} — já está guardada calculada`,
    });
    render();
  } catch (e) {
    erro(e.message);
  }
}

// ── Recusar / reativar nota do trânsito ──────────────────────────────────────
// Depois de marcar, o resultado que já está na tela é atualizado no lugar —
// reapurar reenviaria os zips inteiros, o que leva minutos e parece
// travamento. A próxima apuração é que reorganiza os grupos de vez.
async function marcarTransito(tipo, chave, confirmar, botao) {
  if (confirmar && !confirm(confirmar)) return;
  erro(null);

  const linha = linhaPorChave(chave);
  const rotulo = botao ? botao.textContent : '';
  if (botao) { botao.disabled = true; botao.textContent = '…'; }

  try {
    const r = await fetch(`/api/icms/transito/${tipo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave, linha }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Não foi possível marcar a nota');

    if (linha) {
      if (tipo === 'recusar') { linha.recusada = true; linha.emTransito = false; }
      if (tipo === 'reativar') { linha.recusada = false; }
      if (tipo === 'cancelar-adiamento') {
        delete linha.adiadaPara;
        const antes = linha._antesDoAdiamento;
        if (antes) {
          Object.assign(linha, antes, { incluida: true });
          delete linha._antesDoAdiamento;
          if (linha.chave) selecao.add(linha.chave);
        } else {
          // Adiada numa sessão anterior: a base dela veio zerada do servidor e
          // só volta recalculada. Melhor dizer isso do que deixar a nota sumir.
          $('alertBox').textContent = `Adiamento da nota ${linha.doc} desfeito. `
            + 'Reapure para ela voltar a contar nesta competência.';
          $('alertBox').style.display = 'block';
        }
        resultado.empresas.forEach(recomputarEmpresa);
      }
    }
    tirarDasPendencias(chave);
    render();
  } catch (e) {
    erro(e.message);
    if (botao) { botao.disabled = false; botao.textContent = rotulo; }
  }
}

const linhaPorChave = chave => (resultado
  ? resultado.empresas.flatMap(e => e.linhas).find(l => l.chave === chave) || null
  : null);

// A nota sai da lista sem esperar a reapuração. Mexer no `resultado` em vez do
// DOM é o que faz ela continuar fora depois de qualquer novo render().
function tirarDasPendencias(chave) {
  if (!resultado || !resultado.pendencias) return;
  resultado.pendencias.forEach(g => {
    g.notas = g.notas.filter(n => n.chave !== chave);
    g.qtd = g.notas.length;
  });
  resultado.pendencias = resultado.pendencias.filter(g => g.qtd > 0);
}

// Refaz os agregados da empresa depois de uma nota mudar de estado na mão.
function recomputarEmpresa(emp) {
  emp.incluidas = emp.linhas.filter(l => l.incluida);
  emp.excluidas = emp.linhas.filter(l => !l.incluida);
}

// Coloca a nota num grupo de pendência na hora, sem esperar a reapuração.
// Serve para o adiamento não virar um caminho sem volta: o "Desfazer" precisa
// estar à mão logo depois do clique, não só na próxima apuração.
function porNasPendencias({ tipo, titulo, gravidade, acaoNota }, nota) {
  resultado.pendencias = resultado.pendencias || [];
  let g = resultado.pendencias.find(x => x.tipo === tipo);
  if (!g) {
    g = { tipo, titulo, acao: null, gravidade, qtd: 0, notas: [], acaoNota };
    resultado.pendencias.push(g);
  }
  g.notas.push(nota);
  g.qtd = g.notas.length;
}

// ── Avisos sobre o lote ──────────────────────────────────────────────────────
// Falam do que foi enviado, não de nota específica — por isso ficam acima da
// conferência: é o que explica a diferença antes de ela aparecer no total.
function renderAvisos(avisos) {
  return avisos.map(a => `
    <div class="mx-pend ${a.gravidade || 'aviso'}">
      <div class="mx-pend-hdr estatico">
        <span class="mx-pend-ico">${ICONE[a.gravidade] || '•'}</span>
        <span class="mx-pend-tit">${esc(a.titulo)}</span>
      </div>
      <div class="mx-pend-det">${esc(a.detalhe)}</div>
    </div>`).join('');
}

// ── Confronto com a contabilidade ────────────────────────────────────────────
// Mesma regra do services/recomposicaoContabilidade.js. Existe aqui para o
// confronto acompanhar uma inclusão manual na hora, sem reenviar os zips.
const TOLERANCIA = 0.05;
const _nNF = s => String(s || '').split('/')[0].replace(/\D/g, '').replace(/^0+/, '');

function reconferir() {
  const c = resultado && resultado.conferencia;
  if (!c || !c.notasContabilidade) return;

  const deles = new Map();
  for (const n of c.notasContabilidade) {
    if (!deles.has(n.nNF)) deles.set(n.nNF, { nNF: n.nNF, nNFOriginal: n.nNFOriginal, base4: 0, base12: 0, aPagar: 0 });
    const a = deles.get(n.nNF);
    if (n.aliquota === 4) a.base4 += n.base; else a.base12 += n.base;
    a.aPagar += n.aPagar;
  }

  const nossas = new Map();
  for (const emp of resultado.empresas) {
    for (const l of emp.linhas) {
      if (!l.incluida) continue;
      const k = _nNF(l.nNF || l.doc);
      if (!nossas.has(k)) nossas.set(k, { nNF: k, doc: l.doc, fornecedor: l.fornecedor, empresa: emp.empresa, cnpj: emp.cnpj, base4: 0, base12: 0, difal: 0 });
      const a = nossas.get(k);
      a.base4 += l.base4; a.base12 += l.base12; a.difal += l.difal;
    }
  }

  const conferem = [], divergentes = [], soNossas = [], soDeles = [];
  for (const [k, nossa] of nossas) {
    const d = deles.get(k);
    if (!d) { soNossas.push(nossa); continue; }
    deles.delete(k);
    const dif = { base4: nossa.base4 - d.base4, base12: nossa.base12 - d.base12, aPagar: nossa.difal - d.aPagar };
    const bate = Math.abs(dif.base4) < TOLERANCIA && Math.abs(dif.base12) < TOLERANCIA && Math.abs(dif.aPagar) < TOLERANCIA;
    (bate ? conferem : divergentes).push({ ...nossa, deles: d, diferenca: dif });
  }
  for (const [, d] of deles) soDeles.push(d);

  const nosso = [...nossas.values()].reduce((s, n) => s + n.difal, 0);
  const contabilidade = c.notasContabilidade.reduce((s, n) => s + n.aPagar, 0);
  Object.assign(c, {
    conferem, divergentes, soNossas, soDeles,
    totais: { nosso, contabilidade, diferenca: nosso - contabilidade, bate: Math.abs(nosso - contabilidade) < TOLERANCIA },
  });
}

// O topo diz quanto cada lado deu; embaixo, a diferença vem decomposta em
// motivos, e a soma deles é a diferença do topo. Assim fica claro de onde ela vem.
function renderConferencia(c) {
  if (!c) return '';
  const t = c.totais;
  const soma = (itens, f) => itens.reduce((s, x) => s + f(x), 0);
  const sinal = v => (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + fBRL(Math.abs(v));

  const vDiv = soma(c.divergentes, d => d.diferenca.aPagar);
  const vNossas = soma(c.soNossas, d => d.difal);
  const vDeles = -soma(c.soDeles, d => d.aPagar);
  const vConf = soma(c.conferem, d => d.diferenca.aPagar);

  const motivo = ({ cls, ico, titulo, sub, valor, aberto, tabela }) => `
    <details class="mx-mot ${cls}" ${aberto ? 'open' : ''}>
      <summary>
        <span class="mx-mot-ico">${ico}</span>
        <span class="mx-mot-tit">${titulo}<small>${sub}</small></span>
        <span class="mx-mot-val ${valor == null ? 'mut' : ''}">${valor == null ? '' : sinal(valor)}</span>
      </summary>
      ${tabela ? `<div class="mx-scroll"><table class="mx-t">${tabela}</table></div>` : ''}
    </details>`;

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  return `
  <div class="mx-conf">
    <div class="mx-conf-hdr">
      <h2>Conferência com a contabilidade</h2>
      <span class="mx-conf-sit ${t.bate ? 'ok' : 'dif'}">${t.bate ? 'Bate' : 'Não bate'}</span>
    </div>
    <div class="mx-conf-body">
      <div class="mx-conf-kpis">
        <div class="mx-conf-kpi">
          <div class="mx-sum-label">Nosso cálculo</div>
          <div class="mx-sum-val">${fBRL(t.nosso)}</div>
        </div>
        <div class="mx-conf-kpi">
          <div class="mx-sum-label">Planilha da contabilidade</div>
          <div class="mx-sum-val">${fBRL(t.contabilidade)}</div>
        </div>
        <div class="mx-conf-kpi">
          <div class="mx-sum-label">Diferença</div>
          <div class="mx-sum-val ${t.bate ? 'pos' : 'neg'}">${t.bate ? 'R$ 0,00' : sinal(t.diferenca)}</div>
          <div class="mx-sum-sub">${t.bate ? 'os dois lados fecham' : t.diferenca > 0 ? 'nós calculamos a mais' : 'nós calculamos a menos'}</div>
        </div>
      </div>

      <div class="mx-sec" style="margin-top:0">De onde vem a diferença</div>

      ${c.soDeles.length ? motivo({
        cls: 'dif', ico: '−', aberto: true, valor: vDeles,
        titulo: `${plural(c.soDeles.length, 'nota está', 'notas estão')} só na planilha da contabilidade`,
        sub: 'Não veio no nosso lote. Se a nota é deste mês, inclua aqui com os valores da planilha.',
        tabela: `
          <tr><th>Nota</th><th>Valor a 12%</th><th>Valor a 4%</th><th>Imposto</th><th></th></tr>
          ${c.soDeles.map(d => `<tr>
            <td>${esc(d.nNFOriginal || d.nNF)}</td>
            <td>${d.base12 ? f4(d.base12) : '<span class="vazio">—</span>'}</td>
            <td>${d.base4 ? f4(d.base4) : '<span class="vazio">—</span>'}</td>
            <td>${f4(d.aPagar)}</td>
            <td><button class="mx-btn mini" data-incluir-cont="${esc(d.nNF)}">Incluir</button></td>
          </tr>`).join('')}`,
      }) : ''}

      ${c.soNossas.length ? motivo({
        cls: 'aviso', ico: '+', aberto: true, valor: vNossas,
        titulo: `${plural(c.soNossas.length, 'nota está', 'notas estão')} só no nosso cálculo`,
        sub: 'A contabilidade não lançou. Confira se ela entra neste mês ou em outro.',
        tabela: `
          <tr><th>Nota</th><th class="txt">Fornecedor</th><th>Valor a 12%</th><th>Valor a 4%</th><th>Imposto</th></tr>
          ${c.soNossas.map(d => `<tr>
            <td>${esc(d.doc)}</td><td class="txt">${esc((d.fornecedor || '').slice(0, 30))}</td>
            <td>${d.base12 ? f4(d.base12) : '<span class="vazio">—</span>'}</td>
            <td>${d.base4 ? f4(d.base4) : '<span class="vazio">—</span>'}</td>
            <td>${f4(d.difal)}</td>
          </tr>`).join('')}`,
      }) : ''}

      ${c.divergentes.length ? motivo({
        cls: 'dif', ico: '≠', aberto: true, valor: vDiv,
        titulo: `${plural(c.divergentes.length, 'nota tem', 'notas têm')} valor diferente nos dois lados`,
        sub: 'A mesma nota, com base diferente. Use "ajustar" na nota se a contabilidade estiver certa.',
        tabela: `
          <tr><th>Nota</th><th class="txt">Fornecedor</th><th>12% nosso</th><th>12% deles</th>
            <th>4% nosso</th><th>4% deles</th><th>Imposto nosso</th><th>Imposto deles</th><th>Diferença</th></tr>
          ${c.divergentes.map(d => `<tr>
            <td>${esc(d.doc)}</td><td class="txt">${esc((d.fornecedor || '').slice(0, 24))}</td>
            <td>${f4(d.base12)}</td><td>${f4(d.deles.base12)}</td>
            <td>${f4(d.base4)}</td><td>${f4(d.deles.base4)}</td>
            <td>${f4(d.difal)}</td><td>${f4(d.deles.aPagar)}</td>
            <td class="neg"><b>${sinal(d.diferenca.aPagar)}</b></td>
          </tr>`).join('')}`,
      }) : ''}

      ${motivo({
        cls: 'ok', ico: '✓', aberto: false, valor: Math.abs(vConf) < 0.005 ? null : vConf,
        titulo: `${plural(c.conferem.length, 'nota bate', 'notas batem')} nos dois lados`,
        sub: 'Mesma nota, mesmo valor. Clique para ver a lista.',
        tabela: c.conferem.length ? `
          <tr><th>Nota</th><th class="txt">Fornecedor</th><th>Valor a 12%</th><th>Valor a 4%</th><th>Imposto</th></tr>
          ${c.conferem.map(d => `<tr>
            <td>${esc(d.doc)}</td><td class="txt">${esc((d.fornecedor || '').slice(0, 30))}</td>
            <td>${d.base12 ? f4(d.base12) : '<span class="vazio">—</span>'}</td>
            <td>${d.base4 ? f4(d.base4) : '<span class="vazio">—</span>'}</td>
            <td>${f4(d.difal)}</td>
          </tr>`).join('')}` : '',
      })}

      ${t.bate ? '' : `<div class="mx-conta">soma dos motivos = <b>${sinal(t.diferenca)}</b></div>`}
    </div>
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
          <tr><th>Nota</th><th class="txt">Fornecedor</th><th>Lçto</th><th>Valor</th><th class="txt">Situação</th>
            ${g.acaoNota ? '<th></th>' : ''}</tr>
          ${g.notas.map(n => `<tr>
            <td>${esc(n.doc)}</td>
            <td class="txt">${esc(n.fornecedor || '—')}</td>
            <td>${fData(n.dtLancamento)}</td>
            <td>${n.valor ? fBRL(n.valor) : '—'}</td>
            <td class="txt">${esc(n.detalhe || '')}</td>
            ${g.acaoNota ? `<td>${n.chave
              ? `<button class="mx-btn ghost mini" data-transito="${esc(g.acaoNota.tipo)}" data-chave="${esc(n.chave)}"
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

  const cel = (v) => v > 0 ? f4(v) : '<span class="vazio">—</span>';

  return `
  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th class="sel"></th><th class="txt">Nota fiscal</th><th>Emissão</th><th>Lçto</th>
      <th class="txt">Fornecedor</th><th>UF</th><th>Vlr. total</th>
      <th>Valor a 12%</th><th>Valor a 4%</th><th>Imposto 12%</th><th>Imposto 4%</th><th>Total</th><th></th>
    </tr>
    ${notas.map(n => {
      const marcada = n.chave && selecao.has(n.chave);
      const d4 = passos(n.base4, 0.04).aPagar;
      const d12 = passos(n.base12, 0.12).aPagar;
      const dup = n.jaApurada && !n.jaApurada.mesmaCompetencia;
      return `<tr class="${marcada ? '' : 'off'} ${dup ? 'dup' : ''}">
        <td class="sel"><input type="checkbox" data-chave="${esc(n.chave)}" ${marcada ? 'checked' : ''} ${n.chave ? '' : 'disabled'}></td>
        <td class="txt">${esc(n.doc)}${dup ? `<span class="mx-badge-dup">já apurada em ${esc(n.jaApurada.competencia)}</span>` : ''}${n.ajuste ? `<span class="mx-badge-ed">${n.ajuste.tipo === 'manual' && !n.ajuste.base4Original && !n.ajuste.base12Original ? 'incluída à mão' : 'ajustada'}</span>` : ''}</td>
        <td>${fData(n.dhEmi)}</td>
        <td>${fData(n.dtLancamento)}</td>
        <td class="txt">${esc((n.fornecedor || '').slice(0, 28))}</td>
        <td>${esc(n.ufOrigem)}</td>
        <td>${n.vlrTotal ? f4(n.vlrTotal) : '<span class="vazio">—</span>'}</td>
        <td>${cel(n.base12)}</td>
        <td>${cel(n.base4)}</td>
        <td>${cel(d12)}</td>
        <td>${cel(d4)}</td>
        <td><b>${f4(d4 + d12)}</b></td>
        <td class="txt">
          <button class="mx-link" data-editar="${esc(n.doc)}" data-cnpj="${esc(emp.cnpj)}">ajustar</button>
          ${n.chave ? `<button class="mx-link warn" data-adiar="${esc(n.chave)}" data-doc="${esc(n.doc)}"
            style="margin-left:.5rem">adiar</button>` : ''}
        </td>
      </tr>
      ${n.ajuste ? `<tr class="mx-ajuste ${marcada ? '' : 'off'}"><td></td><td colspan="12">
        ${n.ajuste.base4Original || n.ajuste.base12Original
          ? `valor ajustado à mão — antes 12% ${f4(n.ajuste.base12Original)} / 4% ${f4(n.ajuste.base4Original)}`
          : 'incluída à mão'}
        ${n.ajuste.motivo ? ` — ${esc(n.ajuste.motivo)}` : ''}
        ${n.ajuste.por ? ` (${esc(n.ajuste.por)})` : ''}
        <button class="mx-link neg" data-desfazer="${esc(n.ajuste._id || '')}" style="margin-left:.5rem">desfazer</button>
      </td></tr>` : ''}`;
    }).join('')}
    <tr class="tot">
      <td class="sel"></td><td class="txt">Total marcado</td><td></td><td></td><td></td><td></td><td></td>
      <td>${f4(t.base12)}</td><td>${f4(t.base4)}</td>
      <td>${f4(t.p12.aPagar)}</td><td>${f4(t.p4.aPagar)}</td><td>${f4(t.difal)}</td><td></td>
    </tr>
  </table></div>
  <div class="mx-incluir">
    <button class="mx-btn ghost" data-incluir="${esc(emp.cnpj)}">+ Incluir nota que não veio no lote</button>
  </div>

  <div class="mx-sec">Recomposição da base — mesma conta da planilha da contabilidade</div>
  <div class="mx-scroll"><table class="mx-t">
    <tr><th class="txt">Origem</th><th>Valor produto</th><th>Exclusão interest.</th>
      <th>Inclusão interno</th><th>Débito</th><th>Crédito</th><th>ICMS a pagar</th></tr>
    ${[[12, t.p12, 'nacional'], [4, t.p4, 'importado']].filter(([, p]) => p.base > 0).map(([a, p, nome]) => `<tr>
      <td class="txt"><span class="mx-dot o${a}"></span>${a}% <span class="mut">${nome}</span></td>
      <td>${f4(p.base)}</td><td>${f4(p.exclusaoInterestadual)}</td>
      <td>${f4(p.inclusaoInterno)}</td><td>${f4(p.debito)}</td><td>${f4(p.credito)}</td><td>${f4(p.aPagar)}</td>
    </tr>`).join('')}
    <tr class="tot"><td class="txt">Total</td><td>${f4(t.base4 + t.base12)}</td><td></td><td></td>
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
        <button class="mx-btn ok" data-finalizar="${i}" style="margin-left:auto"
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
        <tr><th>Nota</th><th class="txt">Observação</th><th>CFOP</th><th>Valor</th></tr>
        ${conferir.map(c => `<tr>
          <td>${esc(c.doc)}</td><td class="txt">${esc(c.motivo)}</td>
          <td><span class="mx-tag warn">${esc(c.cfop)}</span></td><td>${f4(c.valor)}</td>
        </tr>`).join('')}
      </table></div>` : ''}

      <div class="mx-sec">Notas que não entraram (${emp.excluidas.length})</div>
      <div class="mx-scroll"><table class="mx-t">
        <tr><th>Nota</th><th class="txt">Fornecedor</th><th>UF</th><th>Valor</th><th class="txt">Motivo</th></tr>
        ${emp.excluidas.map(n => `<tr>
          <td>${esc(n.doc)}</td><td class="txt">${esc(n.fornecedor)}</td><td>${esc(n.ufOrigem)}</td>
          <td>${f4(n.vlrTotal)}</td><td class="txt">${esc(n.motivo)}</td>
        </tr>`).join('')}
      </table></div>
    </div>
  </div>`;
}

// ── Inclusão manual e ajuste de nota ─────────────────────────────────────────
// O XML nem sempre é a última palavra: a contabilidade pode apontar divergência,
// e nota lançada sem XML precisa entrar com o valor digitado. A janela mostra o
// imposto enquanto se digita, para conferir com a planilha antes de confirmar.
let usuario = null;
let dlgCtx = null;   // { linha } da nota em edição; linha null quando é inclusão

// Aceita "2.072,04", "2072,04", "2072.04" e "R$ 2.072,04".
function lerValor(v) {
  const s = String(v || '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.')) || 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, '')) || 0;
  return Number(s) || 0;
}
const mostrarValor = v => v ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';

// Mesma regra do services/icmsAjustes.js: quem digita costuma pôr só o número
// ("13321577"), sem a série que o lote traz ("13321577 /0").
function linhaDoAjuste(emp, doc) {
  const d = String(doc).replace(/\s/g, '');
  const exata = emp.linhas.find(l => String(l.doc).replace(/\s/g, '') === d);
  if (exata || d.includes('/')) return exata || null;
  const mesmas = emp.linhas.filter(l => _nNF(l.nNF || l.doc) === _nNF(d));
  return mesmas.length === 1 ? mesmas[0] : null;
}

function abrirEdicao(cnpj, doc, preencher = {}) {
  const comp = $('competencia').value;
  if (!comp) return erro('Escolha a competência antes de incluir ou ajustar uma nota.');
  erro(null);

  const emp = resultado.empresas.find(e => e.cnpj === cnpj) || resultado.empresas[0];
  const linha = doc ? emp.linhas.find(l => l.doc === doc) : null;
  dlgCtx = { linha };

  $('dlgTitulo').textContent = linha ? `Ajustar nota ${linha.doc}` : 'Incluir nota';
  $('dlgSub').textContent = linha
    ? 'Troque o valor dos produtos de cada alíquota. O valor lido do XML fica guardado e dá para desfazer.'
    : 'Para nota que não veio no lote. Informe o valor dos produtos de cada alíquota; o imposto é calculado aqui.';
  $('dlgConfirmar').textContent = linha ? 'Confirmar ajuste' : 'Confirmar inclusão';

  $('dlgEmpresa').innerHTML = resultado.empresas.map(e =>
    `<option value="${esc(e.cnpj)}" ${e.cnpj === emp.cnpj ? 'selected' : ''}>${esc(e.empresa)}</option>`).join('');
  $('fldEmpresa').style.display = linha || resultado.empresas.length < 2 ? 'none' : '';

  $('dlgNumero').value = linha ? linha.doc : (preencher.numero || '');
  $('dlgNumero').readOnly = !!linha;
  $('dlgFornecedor').value = linha ? (linha.fornecedor || '') : (preencher.fornecedor || '');
  $('dlgFornecedor').readOnly = !!linha;
  $('dlgBase12').value = mostrarValor(linha ? linha.base12 : preencher.base12);
  $('dlgBase4').value = mostrarValor(linha ? linha.base4 : preencher.base4);
  $('dlgMotivo').value = preencher.motivo || '';

  atualizarDlg();
  $('dlgNota').showModal();
  (linha || preencher.numero ? $('dlgBase12') : $('dlgNumero')).focus();
}

function atualizarDlg() {
  const b12 = lerValor($('dlgBase12').value);
  const b4 = lerValor($('dlgBase4').value);
  const i12 = passos(b12, 0.12).aPagar;
  const i4 = passos(b4, 0.04).aPagar;
  $('dlgImp12').textContent = fBRL(i12);
  $('dlgImp4').textContent = fBRL(i4);
  $('dlgImpTot').textContent = fBRL(i12 + i4);

  // Nota digitada que já está no lote vira ajuste dela, não uma segunda nota.
  const aviso = $('dlgAviso');
  aviso.classList.remove('on');
  if (dlgCtx && !dlgCtx.linha && $('dlgNumero').value.trim()) {
    const emp = resultado.empresas.find(e => e.cnpj === $('dlgEmpresa').value);
    const existe = emp && linhaDoAjuste(emp, $('dlgNumero').value.trim());
    if (existe) {
      aviso.innerHTML = `A nota <b>${esc(existe.doc)}</b> já está no lote `
        + `(12% ${f4(existe.base12)} / 4% ${f4(existe.base4)}). Confirmar troca os valores dela, sem duplicar.`;
      aviso.classList.add('on');
    }
  }
  $('dlgConfirmar').disabled = !$('dlgNumero').value.trim()
    || (!(dlgCtx && dlgCtx.linha) && !(b12 > 0 || b4 > 0));
}
['dlgBase12', 'dlgBase4', 'dlgNumero'].forEach(id => $(id).addEventListener('input', atualizarDlg));
$('dlgEmpresa').addEventListener('change', atualizarDlg);
// Ao sair do campo, o valor volta formatado: "2072.04" vira "2.072,04".
['dlgBase12', 'dlgBase4'].forEach(id => $(id).addEventListener('blur', () => {
  $(id).value = mostrarValor(lerValor($(id).value));
}));
$('dlgCancelar').addEventListener('click', () => $('dlgNota').close());

$('frmNota').addEventListener('submit', async ev => {
  ev.preventDefault();
  const linha = dlgCtx && dlgCtx.linha;
  const cnpj = linha
    ? resultado.empresas.find(e => e.linhas.includes(linha)).cnpj
    : $('dlgEmpresa').value;
  const emp = resultado.empresas.find(e => e.cnpj === cnpj);
  const numero = $('dlgNumero').value.trim();
  const existente = linha || linhaDoAjuste(emp, numero);

  const ajuste = {
    cnpj,
    competencia: $('competencia').value,
    doc: existente ? existente.doc : numero,
    // Nota que já foi incluída à mão continua "manual": o ajuste tem o mesmo
    // id, e virar "edicao" faria ela sumir na próxima apuração (não há XML).
    tipo: existente && !String(existente.chave).startsWith('manual:') ? 'edicao' : 'manual',
    base12: lerValor($('dlgBase12').value),
    base4: lerValor($('dlgBase4').value),
    fornecedor: existente ? existente.fornecedor : ($('dlgFornecedor').value.trim() || 'informado manualmente'),
    ufOrigem: existente ? existente.ufOrigem : '',
    dtLancamento: existente ? existente.dtLancamento : null,
    motivo: $('dlgMotivo').value.trim() || (existente ? 'valor ajustado à mão' : 'incluída à mão, sem XML'),
  };

  $('dlgConfirmar').disabled = true;
  const ok = await salvarAjuste(ajuste);
  $('dlgConfirmar').disabled = false;
  if (ok) $('dlgNota').close();
});

// A nota que só a contabilidade tem abre a janela já preenchida com os valores
// da planilha: é só escolher a empresa (se houver mais de uma) e confirmar.
function incluirDaContabilidade(nNF) {
  const d = resultado.conferencia.soDeles.find(x => x.nNF === nNF);
  if (!d) return;
  abrirEdicao(resultado.empresas[0].cnpj, null, {
    numero: d.nNFOriginal || d.nNF,
    base12: d.base12,
    base4: d.base4,
    motivo: 'consta na planilha da contabilidade',
  });
}

// Salva no servidor e aplica na tela na hora. Reapurar reenviaria os zips
// inteiros, o que leva minutos; a próxima apuração lê o ajuste do banco igual.
async function salvarAjuste(ajuste) {
  try {
    const r = await fetch('/api/icms/ajustes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ajuste),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao salvar o ajuste');
    aplicarAjusteNaTela({ ...ajuste, _id: d._id, por: usuario });
    return true;
  } catch (e) {
    erro(e.message);
    $('dlgNota').close();
    return false;
  }
}

function recalcularNota(l) {
  l.difal4 = passos(l.base4, 0.04).aPagar;
  l.difal12 = passos(l.base12, 0.12).aPagar;
  l.difal = l.difal4 + l.difal12;
}

function aplicarAjusteNaTela(aj) {
  const emp = resultado.empresas.find(e => e.cnpj === aj.cnpj);
  let linha = linhaDoAjuste(emp, aj.doc);

  if (linha) {
    // O "antes" é sempre o valor do XML, mesmo depois de vários ajustes.
    const antes = linha.ajuste || { base4Original: linha.base4, base12Original: linha.base12 };
    linha.ajuste = { ...aj, base4Original: antes.base4Original, base12Original: antes.base12Original };
    linha.base4 = aj.base4;
    linha.base12 = aj.base12;
    linha.incluida = aj.base4 > 0 || aj.base12 > 0;
    if (linha.incluida) linha.motivo = '';
  } else {
    linha = {
      chave: `manual:${aj.cnpj}|${aj.competencia}|${aj.doc}`,
      doc: aj.doc,
      nNF: String(aj.doc).split('/')[0],
      dhEmi: null, dtLancamento: null,
      fornecedor: aj.fornecedor, ufOrigem: '',
      vlrTotal: aj.base4 + aj.base12,
      base4: aj.base4, base12: aj.base12,
      incluida: true, motivo: '',
      itensFora: [], itensST: [], revisar: [], atencao: [],
      ajuste: { ...aj, base4Original: 0, base12Original: 0 },
    };
    emp.linhas.push(linha);
  }
  recalcularNota(linha);
  if (linha.chave) { if (linha.incluida) selecao.add(linha.chave); else selecao.delete(linha.chave); }
  recomputarEmpresa(emp);
  reconferir();
  renderMantendoAbertas([resultado.empresas.indexOf(emp)]);
}

async function desfazerAjuste(id) {
  if (!id) return;
  const linha = resultado.empresas.flatMap(e => e.linhas).find(l => l.ajuste && l.ajuste._id === id);
  const incluida = !!linha && String(linha.chave).startsWith('manual:');
  if (!confirm(incluida
    ? 'Tirar esta nota incluída à mão?'
    : 'Desfazer o ajuste e voltar ao valor lido do XML?')) return;
  try {
    const r = await fetch('/api/icms/ajustes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || 'Falha ao desfazer');
    if (!linha) return apurar();

    const emp = resultado.empresas.find(e => e.linhas.includes(linha));
    if (incluida) {
      emp.linhas.splice(emp.linhas.indexOf(linha), 1);
      selecao.delete(linha.chave);
    } else {
      linha.base4 = linha.ajuste.base4Original;
      linha.base12 = linha.ajuste.base12Original;
      linha.incluida = linha.base4 > 0 || linha.base12 > 0;
      delete linha.ajuste;
      recalcularNota(linha);
      if (linha.chave && linha.incluida) selecao.add(linha.chave);
    }
    recomputarEmpresa(emp);
    reconferir();
    renderMantendoAbertas([resultado.empresas.indexOf(emp)]);
  } catch (e) {
    erro(e.message);
  }
}

// Redesenha sem fechar os cartões de empresa que estavam abertos.
function renderMantendoAbertas(abrirTambem = []) {
  const abertas = [...document.querySelectorAll('.mx-emp.open')].map(el => el.dataset.i);
  render();
  [...abertas, ...abrirTambem.map(String)].forEach(i =>
    document.querySelector(`.mx-emp[data-i="${i}"]`)?.classList.add('open'));
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

// "Alíquota efetiva" vira algo que se lê sem conta: quanto de imposto sai a
// cada R$ 100 comprados de fora.
const por100 = (imp, base) => fBRL(base ? imp / base * 100 : 0);
const fData2 = s => s ? fData(s) : '';

function renderResumo(d) {
  if (!d.empresas.length) {
    return '<div class="mx-state">Nada finalizado nesse período ainda.</div>';
  }
  const t = d.total;
  const p = d.periodo || {};
  const periodo = p.de || p.ate ? `de ${fData2(p.de) || 'início'} a ${fData2(p.ate) || 'hoje'}` : 'todo o período';

  const origem = (a, nome, base, imp, parte) => `
    <div class="mx-orig-c ${a === 4 ? 'i4' : ''}">
      <div class="mx-orig-n">Compras a ${a}% <small>— ${nome}</small></div>
      <div class="mx-orig-v big">${fBRL(imp)}</div>
      <div class="mx-orig-l"><span>de imposto, ${fPct(parte)} do total</span></div>
      <div class="mx-orig-l"><span>Valor comprado</span><b>${fBRL(base)}</b></div>
      <div class="mx-orig-l"><span>Imposto a cada R$ 100</span><b>${por100(imp, base)}</b></div>
    </div>`;

  const maior = Math.max(...d.empresas.map(e => e.difal), 0.01);

  return `
  <div class="mx-summary">
    <div class="mx-sum-card">
      <div class="mx-sum-label">Imposto do período</div>
      <div class="mx-sum-val blue">${fBRL(t.difal)}</div>
      <div class="mx-sum-sub">${esc(periodo)}</div>
    </div>
    <div class="mx-sum-card">
      <div class="mx-sum-label">Compras de outro estado</div>
      <div class="mx-sum-val">${fBRL(t.baseTotal)}</div>
      <div class="mx-sum-sub">valor dos produtos que pagam diferencial</div>
    </div>
    <div class="mx-sum-card">
      <div class="mx-sum-label">Imposto a cada R$ 100</div>
      <div class="mx-sum-val">${por100(t.difal, t.baseTotal)}</div>
      <div class="mx-sum-sub">quanto sai de imposto por R$ 100 comprados</div>
    </div>
    <div class="mx-sum-card">
      <div class="mx-sum-label">Notas</div>
      <div class="mx-sum-val">${t.qtdNotas}</div>
      <div class="mx-sum-sub">em ${d.empresas.length} ${d.empresas.length === 1 ? 'empresa' : 'empresas'}</div>
    </div>
  </div>

  <div class="mx-card">
    <div class="mx-card-t">De onde vem o imposto</div>
    <div class="mx-card-d">
      O produto importado (4%) paga bem mais por real comprado que o nacional (12%),
      porque o crédito que vem na nota é menor.
    </div>
    <div class="mx-orig">
      ${origem(12, 'nacional', t.base12, t.difal12, t.participacao12)}
      ${origem(4, 'importado', t.base4, t.difal4, t.participacao4)}
    </div>
    <div class="mx-barra" title="Divisão do imposto">
      <i style="width:${(t.participacao12 * 100).toFixed(1)}%;background:var(--o12)"></i>
      <i style="width:${(t.participacao4 * 100).toFixed(1)}%;background:var(--o4)"></i>
    </div>
    <div class="mx-leg">
      <span><span class="mx-dot o12"></span>12% nacional — <b>${fPct(t.participacao12)}</b> do imposto, ${fPct(t.participacaoBase12)} das compras</span>
      <span><span class="mx-dot o4"></span>4% importado — <b>${fPct(t.participacao4)}</b> do imposto, ${fPct(t.participacaoBase4)} das compras</span>
    </div>
  </div>

  <div class="mx-sec">Por empresa</div>
  <div class="mx-scroll"><table class="mx-t">
    <tr>
      <th class="txt">Empresa</th><th>Notas</th><th>Compras</th>
      <th>Imposto 12%</th><th>Imposto 4%</th><th>Imposto total</th><th class="txt">Parte do grupo</th><th>A cada R$ 100</th>
    </tr>
    ${d.empresas.map(e => `<tr>
      <td class="txt">${esc(e.apelido)}
        <span class="comp-l">${e.competencias.map(esc).join(', ')}</span></td>
      <td>${e.qtdNotas}</td>
      <td>${fBRL(e.baseTotal)}</td>
      <td>${fBRL(e.difal12)}</td><td>${fBRL(e.difal4)}</td>
      <td><b>${fBRL(e.difal)}</b></td>
      <td class="txt"><span class="mx-part" style="width:${Math.max(2, e.difal / maior * 60).toFixed(0)}px"></span>${fPct(t.difal ? e.difal / t.difal : 0)}</td>
      <td>${por100(e.difal, e.baseTotal)}</td>
    </tr>`).join('')}
    <tr class="tot">
      <td class="txt">Total</td><td>${t.qtdNotas}</td><td>${fBRL(t.baseTotal)}</td>
      <td>${fBRL(t.difal12)}</td><td>${fBRL(t.difal4)}</td><td>${fBRL(t.difal)}</td>
      <td class="txt">100,00%</td><td>${por100(t.difal, t.baseTotal)}</td>
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
          : '<td><span class="vazio">—</span></td>').join('')}
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
      <th>Valor a 12%</th><th>Valor a 4%</th><th>Imposto 12%</th><th>Imposto 4%</th><th>Total</th>
      <th>A cada R$ 100</th><th class="txt">Finalizada</th><th></th>
    </tr>
    ${lista.map(a => {
      const base = (a.base4 || 0) + (a.base12 || 0);
      return `<tr>
        <td>${esc(a.competencia)}</td>
        <td class="txt">${esc(apelidoDe(a.cnpj, a.empresa))}</td>
        <td>${a.qtdNotas}</td>
        <td>${fBRL(a.base12)}</td><td>${fBRL(a.base4)}</td>
        <td>${fBRL(a.difal12)}</td><td>${fBRL(a.difal4)}</td>
        <td><b>${fBRL(a.difal)}</b></td>
        <td>${por100(a.difal, base)}</td>
        <td class="txt" style="font-size:.7rem">${esc(a.finalizadaPor || '—')}<br>${a.finalizadaEm ? fData(String(a.finalizadaEm).slice(0, 10)) : ''}</td>
        <td class="txt">
          <button class="mx-link" data-exportar="${esc(a.cnpj)}" data-comp="${esc(a.competencia)}">exportar</button>
          <button class="mx-link neg" data-estorno="${esc(a.cnpj)}" data-comp="${esc(a.competencia)}"
              data-nome="${esc(apelidoDe(a.cnpj, a.empresa))}" style="margin-left:.5rem">estornar</button>
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
  try { const me = await r.json(); usuario = me.name || me.login || (me.user && (me.user.name || me.user.login)) || null; } catch { /* sem nome no ajuste */ }

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
