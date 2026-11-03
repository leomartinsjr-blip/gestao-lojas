// Testes das regras dos contratos de locação (faixas e validação).
//
//   node scripts/testar-contratos-locacao.js
const { somarMeses, classificar, classificarTodos, normalizar } = require('../services/contratosLocacao');

let passou = 0, falhou = 0;
const ok = (nome, obtido, esperado) => {
  if (obtido === esperado) { passou++; console.log(`  ok    ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}  → ${obtido} (esperado ${esperado})`); }
};

const HOJE = '2026-11-03';
const faixa = (fim, prazoNegociacao = '', situacao = 'nao_iniciada') =>
  classificar({ fim, prazoNegociacao, situacao }, HOJE).faixa;

console.log('Meses de calendário');
ok('31/05 menos 3 meses cai em 28/02', somarMeses('2027-05-31', -3), '2027-02-28');
ok('31/08 mais 6 meses cai em 28/02', somarMeses('2026-08-31', 6), '2027-02-28');
ok('virada de ano', somarMeses('2026-11-03', 3), '2027-02-03');

console.log('Faixas pelo fim do contrato');
ok('venceu ontem', faixa('2026-11-02'), 'vencido');
ok('vence hoje ainda não venceu', faixa('2026-11-03'), 'm3');
ok('exatos 3 meses', faixa('2027-02-03'), 'm3');
ok('3 meses e 1 dia', faixa('2027-02-04'), 'm6');
ok('exatos 6 meses', faixa('2027-05-03'), 'm6');
ok('6 meses e 1 dia', faixa('2027-05-04'), 'ok');

console.log('A data limite de negociar manda na urgência');
ok('fim longe, limite em 2 meses', faixa('2028-12-31', '2027-01-03'), 'm3');
ok('fim longe, limite em 5 meses', faixa('2028-12-31', '2027-04-03'), 'm6');
ok('limite passou, contrato vigente', faixa('2028-12-31', '2026-10-01'), 'prazo');
ok('limite passou e contrato venceu', faixa('2026-10-31', '2026-05-01'), 'vencido');
ok('limite hoje ainda não passou', faixa('2028-12-31', '2026-11-03'), 'm3');

console.log('Não vamos renovar conta só do fim');
ok('limite passado não acusa', faixa('2028-12-31', '2026-10-01', 'nao_renovar'), 'ok');
ok('fim perto continua avisando', faixa('2027-01-31', '2026-10-01', 'nao_renovar'), 'm3');

console.log('Dias e ordem');
const c = classificar({ fim: '2028-12-31', prazoNegociacao: '2026-11-13', situacao: 'nao_iniciada' }, HOJE);
ok('conta os dias até a data limite', c.dias, 10);
ok('marco é a data limite', c.marco, 'prazo');
ok('vencido dá dias negativos', classificar({ fim: '2026-11-01', prazoNegociacao: '' }, HOJE).dias, -2);
const ordem = classificarTodos([{ id: 'a', fim: '2030-01-01' }, { id: 'b', fim: '2026-01-01' }, { id: 'c', fim: '2029-01-01', prazoNegociacao: '2026-12-01' }], HOJE);
ok('mais urgente primeiro', ordem.map(x => x.id).join(''), 'bca');
ok('sem contratos cadastrados', classificarTodos(undefined, HOJE).length, 0);

console.log('Validação');
const base = { loja: 'delrey', shopping: 'Shopping X', fim: '2028-01-31' };
const erro = extra => normalizar({ ...base, ...extra }).erro || '';
ok('mínimo passa', erro({}), '');
ok('situação padrão', normalizar(base).dados.situacao, 'nao_iniciada');
ok('aluguel vazio vira nulo', normalizar({ ...base, aluguel: '' }).dados.aluguel, null);
ok('aluguel como texto numérico', normalizar({ ...base, aluguel: '12500.50' }).dados.aluguel, 12500.5);
ok('aluguel zero é valor', normalizar({ ...base, aluguel: 0 }).dados.aluguel, 0);
ok('loja desconhecida', erro({ loja: 'outra' }), 'Selecione a loja.');
ok('sem shopping', erro({ shopping: '  ' }), 'Informe o shopping.');
ok('sem fim', erro({ fim: '' }), 'Informe o fim do contrato.');
ok('data impossível', erro({ fim: '2027-02-30' }), 'Informe o fim do contrato.');
ok('início depois do fim', erro({ inicio: '2028-02-01' }), 'O início precisa ser antes do fim do contrato.');
ok('limite depois do fim', erro({ prazoNegociacao: '2028-02-01' }), 'A data limite de negociar não pode ser depois do fim do contrato.');
ok('aluguel negativo', erro({ aluguel: -1 }), 'Valor do aluguel inválido.');
ok('aluguel com vírgula', erro({ aluguel: '12,50' }), 'Valor do aluguel inválido.');
ok('situação inválida', erro({ situacao: 'x' }), 'Situação inválida.');

console.log(`\n${passou} ok, ${falhou} falha(s)`);
process.exit(falhou ? 1 : 0);
