// Contratos de locação das lojas com os shoppings: validação do cadastro e a
// faixa de urgência de cada contrato. Fica separado do server.js para o
// scripts/testar-contratos-locacao.js rodar sem subir o servidor.

const LOJAS = {
  delrey: 'Del Rey', minas: 'Minas', contagem: 'Contagem',
  estacao: 'Estação', tommy: 'Tommy', lez: 'Lez a Lez',
};
const SITUACOES = ['nao_iniciada', 'em_negociacao', 'nao_renovar'];

function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;   // 2027-02-30 não passa
}

// Soma em meses de calendário, não em 30 dias: "3 meses antes" de 31/05 é 28/02.
function somarMeses(iso, meses) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

const diasEntre = (de, ate) => Math.round((Date.parse(ate) - Date.parse(de)) / 86400000);

// A urgência conta da data limite de negociar, quando ela existe: é ali que se
// perde a renovação, às vezes meses antes do fim do contrato. Quem decidiu não
// renovar não tem mais o que negociar, e passa a contar só do fim.
function classificar(c, hoje) {
  const prazo = c.situacao === 'nao_renovar' ? '' : c.prazoNegociacao;
  const marco = prazo && c.fim >= hoje ? 'prazo' : 'fim';
  const alvo  = marco === 'prazo' ? prazo : c.fim;
  const faixa = c.fim < hoje ? 'vencido'
              : alvo < hoje ? 'prazo'
              : alvo <= somarMeses(hoje, 3) ? 'm3'
              : alvo <= somarMeses(hoje, 6) ? 'm6'
              : 'ok';
  return { ...c, faixa, marco, alvo, dias: diasEntre(hoje, alvo) };
}

const classificarTodos = (lista, hoje) => (lista || [])
  .map(c => classificar(c, hoje))
  .sort((a, b) => a.alvo.localeCompare(b.alvo));

function normalizar(body) {
  const txt = v => String(v ?? '').trim();
  const dados = {
    loja: txt(body.loja), shopping: txt(body.shopping),
    inicio: txt(body.inicio), fim: txt(body.fim), prazoNegociacao: txt(body.prazoNegociacao),
    aluguel: null, condicoes: txt(body.condicoes),
    situacao: txt(body.situacao) || SITUACOES[0], obs: txt(body.obs),
  };
  if (!LOJAS[dados.loja]) return { erro: 'Selecione a loja.' };
  if (!dados.shopping) return { erro: 'Informe o shopping.' };
  if (!dataValida(dados.fim)) return { erro: 'Informe o fim do contrato.' };
  if (dados.inicio && !dataValida(dados.inicio)) return { erro: 'Data de início inválida.' };
  if (dados.prazoNegociacao && !dataValida(dados.prazoNegociacao)) return { erro: 'Data limite inválida.' };
  if (dados.inicio && dados.inicio >= dados.fim) return { erro: 'O início precisa ser antes do fim do contrato.' };
  if (dados.prazoNegociacao && dados.prazoNegociacao > dados.fim) return { erro: 'A data limite de negociar não pode ser depois do fim do contrato.' };
  if (!SITUACOES.includes(dados.situacao)) return { erro: 'Situação inválida.' };
  if (txt(body.aluguel) !== '') {
    const valor = Number(body.aluguel);
    if (!Number.isFinite(valor) || valor < 0) return { erro: 'Valor do aluguel inválido.' };
    dados.aluguel = valor;
  }
  return { dados };
}

module.exports = { LOJAS, SITUACOES, somarMeses, classificar, classificarTodos, normalizar };
