// Testes da tela do ICMS: roda o public/icms.js de verdade sobre um DOM e um
// fetch simulados.
//
//   node scripts/testar-icms-tela.js
//
// Existe por causa de dois defeitos que só apareceram em produção: marcar uma
// nota reenviava os zips inteiros, o que parecia travamento, e o erro do
// servidor deixava o botão morto. Os dois são de estado de tela, não de
// cálculo, então o testar-icms.js não tinha como pegar.
const fs = require('fs');
const vm = require('vm');

let passou = 0, falhou = 0;
const ok = (nome, cond, det = '') => {
  if (cond) { passou++; console.log(`  ok    ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}${det ? '  → ' + det : ''}`); }
};

function elemento() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, value: '2026-04', textContent: '', innerHTML: '', disabled: false, files: [],
    addEventListener() {}, click() {}, closest: () => null, querySelectorAll: () => [],
    parentElement: null,
  };
}

const els = {};
let chamadas = [];
let respostas = {};

const contexto = {
  console,
  document: {
    getElementById: id => (els[id] = els[id] || elemento()),
    querySelectorAll: () => [],
    createElement: () => elemento(),
  },
  window: { location: { href: '' } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  FormData: class { append() {} },
  confirm: () => true,
  alert: msg => { chamadas.push(['alert', msg]); },
  setTimeout,
  fetch: async (url, opt) => {
    chamadas.push(['fetch', url, opt && opt.body ? JSON.parse(opt.body) : null]);
    const r = respostas[url] || respostas[String(url).split('?')[0]];
    if (!r) return { ok: true, json: async () => ({}) };
    return { ok: r.ok !== false, json: async () => r.body, blob: async () => ({}) };
  },
};
contexto.globalThis = contexto;

const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'icms.js'), 'utf8')
  // Seam de teste: `resultado` é `let`, então não vaza do escopo do script.
  + '\nglobalThis.__estado = () => resultado;'
  + '\nglobalThis.__setEstado = r => { resultado = r; };'
  + '\nglobalThis.__selecao = () => selecao;';

vm.createContext(contexto);

const APURACAO = {
  empresas: [{
    cnpj: '28519094000129', empresa: 'LMJ', linhas: [
      { chave: 'K1', doc: '8923 /1', nNF: '8923', serie: '1', fornecedor: 'OUTSIDE CO', dhEmi: '2026-04-02',
        vlrTotal: 2904.43, base4: 0, base12: 2904.43, difal4: 0, difal12: 212.52, difal: 212.52,
        incluida: false, semLancamento: true, motivo: 'não consta no relatório de lançamentos do período',
        itensST: [], revisar: [], atencao: [] },
      { chave: 'K2', doc: '9000 /1', nNF: '9000', serie: '1', fornecedor: 'AZZAS', dhEmi: '2026-04-10',
        vlrTotal: 1000, base4: 0, base12: 1000, difal4: 0, difal12: 73.17, difal: 73.17,
        incluida: true, selecionada: true, motivo: '', itensST: [], revisar: [], atencao: [] },
    ],
    incluidas: [], excluidas: [], revisar: [], atencao: [], itensST: [],
    totais: { base4: 0, base12: 1000, passos: {}, difal: 73.17 },
  }],
  pendencias: [{
    tipo: 'sem-lancamento', titulo: 'Têm XML, mas não têm entrada no Microvix',
    acao: 'Confira no Microvix', gravidade: 'grave', qtd: 1,
    notas: [{ doc: '8923 /1', chave: 'K1', fornecedor: 'OUTSIDE CO', valor: 2904.43, detalhe: 'emitida em 02/04/2026' }],
    acaoNota: { tipo: 'recusar', rotulo: 'Recusada', confirmar: 'Marcar como recusada?' },
  }],
  avisos: [], competencia: '2026-04', semXml: [], conferencia: null,
};
APURACAO.empresas[0].incluidas = APURACAO.empresas[0].linhas.filter(l => l.incluida);
APURACAO.empresas[0].excluidas = APURACAO.empresas[0].linhas.filter(l => !l.incluida);

respostas['/api/me'] = { ok: true, body: { nome: 'teste' } };
respostas['/api/icms/empresas'] = { ok: true, body: [] };

vm.runInContext(src, contexto);

(async () => {
  console.log('\nMarcar como recusada');
  contexto.__setEstado(JSON.parse(JSON.stringify(APURACAO)));
  contexto.__selecao().add('K2');

  respostas['/api/icms/transito/recusar'] = { ok: true, body: { chave: 'K1', status: 'recusada' } };
  chamadas = [];
  const botao = elemento(); botao.textContent = 'Recusada';
  await contexto.marcarTransito('recusar', 'K1', 'Marcar como recusada?', botao);

  const posts = chamadas.filter(c => c[0] === 'fetch');
  ok('não reapura (não reenvia os zips)', !posts.some(c => String(c[1]).includes('/apurar')),
    posts.map(c => c[1]).join(', '));
  ok('manda a linha junto, para o servidor criar o registro',
    posts[0] && posts[0][2] && posts[0][2].linha && posts[0][2].linha.doc === '8923 /1');

  let est = contexto.__estado();
  ok('a nota sai da pendência', !est.pendencias.some(g => g.notas.some(n => n.chave === 'K1')));
  ok('grupo vazio some da lista', !est.pendencias.some(g => g.tipo === 'sem-lancamento'));
  ok('a linha fica marcada como recusada',
    est.empresas[0].linhas.find(l => l.chave === 'K1').recusada === true);
  ok('a nota que estava na conta não é afetada',
    est.empresas[0].linhas.find(l => l.chave === 'K2').incluida === true);

  console.log('\nErro do servidor não deixa a tela pendurada');
  contexto.__setEstado(JSON.parse(JSON.stringify(APURACAO)));
  respostas['/api/icms/transito/recusar'] = { ok: false, body: { error: 'Nota não está no trânsito' } };
  const b2 = elemento(); b2.textContent = 'Recusada';
  await contexto.marcarTransito('recusar', 'K1', null, b2);
  ok('mostra o erro na tela', /trânsito/.test(els.errorBox.innerHTML || ''), els.errorBox.innerHTML);
  ok('botão volta a funcionar', b2.disabled === false && b2.textContent === 'Recusada');
  ok('a pendência continua lá', contexto.__estado().pendencias[0].notas.length === 1);

  console.log('\nAdiar e desfazer');
  contexto.__setEstado(JSON.parse(JSON.stringify(APURACAO)));
  contexto.__selecao().clear();
  contexto.__selecao().add('K2');
  els.competencia.value = '2026-04';
  respostas['/api/icms/transito/adiar'] = { ok: true, body: { chave: 'K2', competenciaDestino: '2026-05' } };
  await contexto.adiarNota('K2', '9000 /1');

  est = contexto.__estado();
  let k2 = est.empresas[0].linhas.find(l => l.chave === 'K2');
  ok('adiada sai da conta', k2.incluida === false && k2.base12 === 0);
  ok('adiada guarda o estado anterior para o desfazer', k2._antesDoAdiamento.base12 === 1000);
  ok('adiada sai da seleção', !contexto.__selecao().has('K2'));
  ok('empresa recomputada', est.empresas[0].incluidas.length === 0);
  ok('desfazer aparece na hora',
    est.pendencias.find(g => g.tipo === 'adiadas')?.acaoNota?.tipo === 'cancelar-adiamento');

  respostas['/api/icms/transito/cancelar-adiamento'] = { ok: true, body: { chave: 'K2', removida: true } };
  await contexto.marcarTransito('cancelar-adiamento', 'K2', null, elemento());
  est = contexto.__estado();
  k2 = est.empresas[0].linhas.find(l => l.chave === 'K2');
  ok('desfazer devolve a nota à conta', k2.incluida === true && k2.base12 === 1000);
  ok('desfazer devolve a marcação', contexto.__selecao().has('K2'));
  ok('grupo de adiadas some', !est.pendencias.some(g => g.tipo === 'adiadas'));

  console.log(`\n${passou} passaram, ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('ERRO:', e); process.exit(1); });
