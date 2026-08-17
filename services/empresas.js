// Cadastro das empresas do grupo, por CNPJ.
//
// Cada CNPJ é contribuinte próprio: apura e recolhe o diferencial de alíquota
// separado dos demais. Todas em MG, então a alíquota interna é 18% para todas —
// o campo fica explícito porque é ele que define o fator do cálculo.
//
// "aba" é o nome usado nas planilhas manuais de Y:\ADMINISTRATIVO\≠ ICMS,
// para o resultado poder ser conferido contra o histórico.
//
// "ativa" marca quem compra hoje e portanto entra na apuração mensal. As
// inativas ficam no cadastro porque ainda aparecem em notas antigas.
//
// "sistema" diz de onde saem o relatório de compras e os XMLs:
//   microvix-surfers  o Microvix das Surfers, portal das 5 empresas do grupo
//   microvix-tommy    a Tommy tem um Microvix próprio — mesmos formatos de
//                     arquivo, então é só exportar de lá e subir junto
//   outro             a Lez a Lez usa outro sistema; formato ainda não mapeado

const EMPRESAS = [
  // ── LMJ ────────────────────────────────────────────────────────────────────
  {
    cnpj: '28519094000129',
    ativa: true,
    sistema: 'microvix-surfers',
    razaoSocial: 'LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'LMJ — Del Rey',
    aba: 'LMJ',
    ie: '003032074.00-48',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Presidente Carlos Luz, 3001, Loja 3051 — Caiçara',
    instagram: '@SurfersConceptStore',
  },
  {
    cnpj: '28519094000200',
    ativa: true,
    sistema: 'microvix-surfers',
    razaoSocial: 'LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'LMJ — Del Rey 111 (filial)',
    aba: 'LMJ FL2',
    ie: '003032074.01-29',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Del Rey, 111, sala 505, Bloco A — Caiçara',
    instagram: '@lojasurfers',
  },
  {
    cnpj: '28519094000390',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'LMJ COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'LMJ — Contagem',
    aba: null,
    ie: '003032074.02-00',
    municipio: 'Contagem',
    uf: 'MG',
    endereco: 'Av. Severino Ballesteros Rodrigues, 850, loja 2112 — Cabral',
    instagram: '@surfers.contagem',
  },

  // ── JDG ────────────────────────────────────────────────────────────────────
  {
    cnpj: '32473768000179',
    ativa: true,
    sistema: 'microvix-surfers',
    razaoSocial: 'JDG COMERCIO DE ARTIGOS DO VESTUARIO EIRELI',
    apelido: 'JDG — Minas Shopping',
    aba: 'JDG',
    ie: '003355950.00-44',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Cristiano Machado, 4000, Loja 148 — União',
    instagram: '@surfers_minas',
  },
  {
    cnpj: '32473768000250',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'JDG COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'JDG — Del Rey 111 (filial)',
    aba: null,
    ie: '0033559500125',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Del Rey, 111, sala 505, Bloco A — Caiçara',
    instagram: '@lojasurfers',
  },

  // ── PV ─────────────────────────────────────────────────────────────────────
  {
    cnpj: '35041602000171',
    ativa: true,
    sistema: 'microvix-surfers',
    razaoSocial: 'PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'PV — Contagem',
    aba: 'PV',
    ie: '0035581630097',
    municipio: 'Contagem',
    uf: 'MG',
    endereco: 'Av. Severino Ballesteros Rodrigues, 850, loja 2028 — Cabral',
    instagram: '@surfers.contagem',
  },
  {
    cnpj: '35041602000252',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'PV — Del Rey 111 (filial)',
    aba: null,
    ie: '0035581630178',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Del Rey, 111, sala 505, Bloco A — Caiçara',
    instagram: '@lojasurfers',
  },
  {
    cnpj: '35041602000333',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'PV COMERCIO DE ARTIGOS DO VESTUARIO EIRELI - EPP',
    apelido: 'PV — Del Rey',
    aba: null,
    ie: '0035581630259',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Presidente Carlos Luz, 3001, Loja 3051 — Caiçara',
    instagram: '@SurfersConceptStore',
  },

  // ── TTS ────────────────────────────────────────────────────────────────────
  {
    cnpj: '11106478000206',
    ativa: true,
    sistema: 'microvix-surfers',
    razaoSocial: 'TTS COMERCIO DE ARTIGOS DO VESTUARIO LTDA FILIAL',
    nomeFantasia: "SURFER'S BEACHCULTURE",
    apelido: 'TTS — Estação BH',
    aba: 'TTS',
    ie: '0013781050181',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Cristiano Machado, 11833, Loja 2076 — Vila Clóris',
    instagram: '@Surfersestacaobh',
  },

  // ── TRIBE ──────────────────────────────────────────────────────────────────
  {
    cnpj: '10209859000169',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'TRIBE COMERCIO DE ARTIGOS DO VESTUARIO LTDA',
    nomeFantasia: 'TRIBE CONCEPT STORE',
    apelido: 'TRIBE — Del Rey',
    aba: null,
    ie: '0010813080088',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Presidente Carlos Luz, 3001, Loja 3111, Piso 3 — Caiçara',
  },
  {
    cnpj: '10209859000240',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'TRIBE COMERCIO DE ARTIGOS DO VESTUARIO LTDA FILIAL',
    nomeFantasia: 'TRIBE',
    apelido: 'TRIBE — Sete Lagoas',
    aba: null,
    ie: null,
    municipio: 'Sete Lagoas',
    uf: 'MG',
    endereco: 'Av. Otacilio Campelo Ribeiro, 2801, Loja 288 — Eldorado',
  },
  {
    cnpj: '10209859000320',
    ativa: false,
    sistema: 'microvix-surfers',
    razaoSocial: 'TRIBE COMERCIO DE ARTIGOS DO VESTUARIO LTDA - ME',
    apelido: 'TRIBE — Del Rey 111 (filial)',
    aba: null,
    ie: '001081308.02-40',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Del Rey, 111, Bloco A, Sala 505 — Caiçara',
  },

  // ── LF ─────────────────────────────────────────────────────────────────────
  {
    cnpj: '44602345000190',
    ativa: true,
    sistema: 'outro',
    razaoSocial: 'LF COMERCIO DE ARTIGOS DO VESTUARIO',
    nomeFantasia: 'LEZ A LEZ',
    apelido: 'LF — Lez a Lez',
    aba: 'LF',
    ie: '44559930023',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Presidente Carlos Luz, 3001, Loja 3111, Piso 3 — Caiçara',
  },

  // ── 3L ─────────────────────────────────────────────────────────────────────
  {
    cnpj: '60509746000157',
    ativa: true,
    sistema: 'microvix-tommy',
    razaoSocial: '3L COMERCIO DE ARTIGOS DO VESTUARIO',
    nomeFantasia: 'TOMMY HILFIGER',
    apelido: '3L — Tommy Hilfiger',
    aba: 'TOMMY',
    ie: '51800000073',
    municipio: 'Belo Horizonte',
    uf: 'MG',
    endereco: 'Av. Presidente Carlos Luz, 3001, Loja 2026, Piso 2 — Caiçara',
  },
];

// Todas em MG: alíquota interna de 18% e nenhum diferencial em compra interna.
const ALIQ_INTERNA_MG = 0.18;

const _porCnpj = new Map(EMPRESAS.map(e => [e.cnpj, e]));

function limparCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function buscarEmpresa(cnpj) {
  return _porCnpj.get(limparCnpj(cnpj)) || null;
}

function cnpjsDoGrupo() {
  return EMPRESAS.map(e => e.cnpj);
}

// Agrupa os CNPJs por razão social — útil para conferir contra as abas das
// planilhas antigas, que juntavam matriz e filiais numa aba só.
function porRazaoSocial() {
  const grupos = new Map();
  for (const e of EMPRESAS) {
    const raiz = e.cnpj.slice(0, 8);
    if (!grupos.has(raiz)) grupos.set(raiz, { raiz, razaoSocial: e.razaoSocial, empresas: [] });
    grupos.get(raiz).empresas.push(e);
  }
  return [...grupos.values()];
}

// Formata 28519094000129 → 28.519.094/0001-29
function formatarCnpj(cnpj) {
  const c = limparCnpj(cnpj);
  if (c.length !== 14) return cnpj;
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

module.exports = {
  EMPRESAS,
  ALIQ_INTERNA_MG,
  buscarEmpresa,
  cnpjsDoGrupo,
  porRazaoSocial,
  limparCnpj,
  formatarCnpj,
};
