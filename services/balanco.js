// ════════════════════════════════════════════════════════════════════════════
// BALANÇO DE LOJA — leitura do coletor × estoque do Microvix
// ════════════════════════════════════════════════════════════════════════════
// Faz no gestão o que hoje é "Enviar arquivo + Processar balanço" no Microvix
// só para conferir: a loja lê os códigos de barras, o TXT sobe aqui, o estoque
// da data vem da WebAPI e sai a Lista de Críticas (PDF), a planilha de
// recontagem no modelo do escritório e, no fim, o TXT corrigido que vai para o
// Microvix uma vez só, já com as recontagens.
//
// Estoque "na hora": o LinxProdutosInventario devolve o saldo do fim do dia.
// Se o balanço tem hora, os movimentos daquele dia depois da hora são
// desfeitos (venda volta ao estoque, entrada sai) — é o saldo que o Microvix
// mostraria se o relatório fosse processado naquele horário.

const {
  fetchEstoque, fetchMovimento, buildRequest, postRequest, parseCsv, parseBrNum,
} = require('./microvix');

const normBarra = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
const num = v => parseBrNum(String(v ?? '0'));
const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

// "70-FLIP FLOPS" / "B4-JACKETS" → "FLIP FLOPS" / "JACKETS": é como o grupo
// aparece na coluna Setor da planilha
const grupoCurto = g => String(g || '').replace(/^\s*[A-Z0-9]{1,4}\s*-\s*/i, '').trim() || '(SEM GRUPO)';

// ── Leitura do coletor ─────────────────────────────────────────────────────
// Aceita "codigo,qtde" (o formato do Microvix), ";" ou tab como separador, e
// linha só com o código (conta 1). O mesmo código repetido soma.
function parseLeitura(texto) {
  const porBarra = new Map();
  const invalidas = [];
  String(texto || '').split(/\r?\n/).forEach((linha, i) => {
    const t = linha.trim();
    if (!t) return;
    const [codRaw, qRaw] = t.split(/[,;\t ]+/);
    const barra = String(codRaw || '').replace(/\D/g, '');
    const q = qRaw === undefined || qRaw === '' ? 1 : Number(String(qRaw).replace(',', '.'));
    if (!barra || !Number.isFinite(q)) { invalidas.push({ linha: i + 1, texto: t.slice(0, 60) }); return; }
    const k = normBarra(barra);
    const cur = porBarra.get(k);
    if (cur) cur.q += q; else porBarra.set(k, { barra, q, ordem: porBarra.size });
  });
  let pecas = 0;
  for (const v of porBarra.values()) pecas += v.q;
  return { porBarra, pecas, codigos: porBarra.size, invalidas };
}

// ── Chamada genérica à WebAPI ──────────────────────────────────────────────
async function linx(cmd, cnpj, chave, params, timeout = 90_000) {
  const raw = await postRequest(buildRequest(cmd, cnpj, params, chave), timeout);
  if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) {
    const msg = (raw.match(/<Message>([^<]+)<\/Message>/) || [])[1] || 'Erro desconhecido';
    throw new Error(`Microvix API (${cmd}): ${msg}`);
  }
  return parseCsv(raw);
}

// ── Cadastro de produtos (nome, referência, setor, linha) ──────────────────
// O catálogo geral do gestão não guarda código nem descrição completa (com
// tamanho), que a Lista de Críticas precisa. Aqui fica uma cópia enxuta por
// portal, sincronizada pelo timestamp do LinxProdutos: a primeira vez baixa
// tudo, depois só o que mudou.
function criarCadastro(getDb, getNexoDb) {
  const mem = {};       // portal → { ts, porCod: Map, porBarra: Map } (sem Mongo)
  const syncs = {};     // portal → Promise em andamento

  const enxuto = r => ({
    cod:   String(r.cod_produto || '').trim(),
    barra: String(r.cod_barra || '').trim(),
    nome:  String(r.nome || '').replace(/\s+/g, ' ').trim(),
    ref:   String(r.referencia || '').trim(),
    setor: String(r.desc_setor || '').trim(),
    linha: String(r.desc_linha || '').trim(),
  });

  async function sync(portal, cnpj, chave, onProgress) {
    if (syncs[portal]) return syncs[portal];
    syncs[portal] = (async () => {
      const db = getDb();
      const metaCol = db?.collection('balanco_meta');
      const prodCol = db?.collection('balanco_produtos');
      if (prodCol) {
        prodCol.createIndex({ portal: 1, cod: 1 }, { background: true }).catch(() => {});
        prodCol.createIndex({ portal: 1, barraN: 1 }, { background: true }).catch(() => {});
      }
      const m = mem[portal] || (mem[portal] = { ts: 0, porCod: new Map(), porBarra: new Map() });
      let ts = prodCol ? Number((await metaCol.findOne({ _id: 'prod:' + portal }))?.ts || 0) : m.ts;
      const fim = hojeISO();
      let total = 0;
      for (let page = 0; page < 200; page++) {
        const rows = await linx('LinxProdutos', cnpj, chave, [
          { id: 'timestamp', valor: String(ts) },
          { id: 'dt_update_inicio', valor: '2000-01-01' },
          { id: 'dt_update_fim', valor: fim },
        ], 120_000);
        if (!rows.length) break;
        const docs = rows.map(enxuto).filter(p => p.cod);
        if (prodCol) {
          await prodCol.bulkWrite(docs.map(p => ({
            replaceOne: {
              filter: { _id: portal + ':' + p.cod },
              replacement: { _id: portal + ':' + p.cod, portal, ...p, barraN: normBarra(p.barra) },
              upsert: true,
            },
          })), { ordered: false });
        } else {
          for (const p of docs) { m.porCod.set(p.cod, p); m.porBarra.set(normBarra(p.barra), p); }
        }
        total += rows.length;
        const maxTs = Math.max(...rows.map(r => parseInt(r.timestamp) || 0));
        if (maxTs <= ts) break;
        ts = maxTs;
        if (prodCol) await metaCol.updateOne({ _id: 'prod:' + portal }, { $set: { ts, em: new Date() } }, { upsert: true });
        else m.ts = ts;
        onProgress?.(total);
        if (rows.length < 5000) break;
      }
      return total;
    })().finally(() => { delete syncs[portal]; });
    return syncs[portal];
  }

  async function buscar(portal, { cods = [], barrasN = [] }) {
    const db = getDb();
    const out = { porCod: new Map(), porBarra: new Map() };
    if (db) {
      const col = db.collection('balanco_produtos');
      const docs = await col.find({ portal, $or: [{ cod: { $in: cods } }, { barraN: { $in: barrasN } }] },
        { projection: { _id: 0, portal: 0 } }).toArray();
      for (const p of docs) { out.porCod.set(p.cod, p); out.porBarra.set(p.barraN, p); }
    } else {
      const m = mem[portal];
      if (m) {
        for (const c of cods) if (m.porCod.has(c)) out.porCod.set(c, m.porCod.get(c));
        for (const b of barrasN) if (m.porBarra.has(b)) { const p = m.porBarra.get(b); out.porBarra.set(b, p); out.porCod.set(p.cod, p); }
      }
    }
    return out;
  }

  // Um produto avulso (fora da sincronização) — vira cadastro também
  async function buscarUm(portal, cnpj, chave, cod) {
    const rows = await linx('LinxProdutos', cnpj, chave, [
      { id: 'timestamp', valor: '0' },
      { id: 'dt_update_inicio', valor: '2000-01-01' },
      { id: 'dt_update_fim', valor: hojeISO() },
      { id: 'cod_produto', valor: String(cod) },
    ]);
    if (!rows[0]) return null;
    const p = enxuto(rows[0]);
    const db = getDb();
    if (db) {
      await db.collection('balanco_produtos').replaceOne({ _id: portal + ':' + p.cod },
        { _id: portal + ':' + p.cod, portal, ...p, barraN: normBarra(p.barra) }, { upsert: true });
    } else if (mem[portal]) {
      mem[portal].porCod.set(p.cod, p); mem[portal].porBarra.set(normBarra(p.barra), p);
    }
    return p;
  }

  async function sincronizado(portal) {
    const db = getDb();
    if (db) return !!(await db.collection('balanco_meta').findOne({ _id: 'prod:' + portal }))?.ts;
    return !!mem[portal]?.ts;
  }

  // Cadastro do NEXO: ele já mantém o portal das Surfers inteiro (coleção
  // produtos, _id = cod_produto). Se estiver no mesmo Mongo e for o mesmo
  // portal (a amostra do estoque bate código e código de barras), usa ele em
  // vez de guardar uma segunda cópia. A Tommy é outro portal e cai na própria.
  async function nexoServe(amostra) {
    const ndb = getNexoDb?.();
    if (!ndb || !amostra.length) return null;
    try {
      const col = ndb.collection('produtos');
      const docs = await col.find({ _id: { $in: amostra.map(a => a.cod) } }, { projection: { cod_barra: 1 } }).toArray();
      const porCod = new Map(docs.map(d => [String(d._id), normBarra(d.cod_barra)]));
      const batem = amostra.filter(a => porCod.get(a.cod) === normBarra(a.barra)).length;
      if (batem < amostra.length * 0.9) return null;
      const doNexo = d => ({ cod: String(d._id), barra: String(d.cod_barra || ''), nome: String(d.nome || '').replace(/\s+/g, ' ').trim(),
        ref: String(d.referencia || '').trim(), setor: String(d.setor || '').trim(), linha: String(d.linha || '').trim() });
      return async function buscarNexo({ cods = [], barrasN = [] }) {
        const variantes = barrasN.flatMap(b => [b, b.padStart(8, '0'), b.padStart(13, '0')]);
        const ds = await col.find({ $or: [{ _id: { $in: [...cods, ...barrasN] } }, { cod_barra: { $in: variantes } }] },
          { projection: { cod_barra: 1, nome: 1, referencia: 1, setor: 1, linha: 1 } }).toArray();
        const out = { porCod: new Map(), porBarra: new Map() };
        for (const d of ds) {
          const p = doNexo(d);
          out.porCod.set(p.cod, p);
          out.porBarra.set(normBarra(p.barra), p);
          if (barrasN.includes(p.cod)) out.porBarra.set(p.cod, p); // código gerencial lido no lugar do de barras
        }
        return out;
      };
    } catch (e) { console.warn('[balanco] cadastro do NEXO indisponível:', e.message); return null; }
  }

  return { sync, buscar, buscarUm, sincronizado, nexoServe };
}

// ── Processamento ──────────────────────────────────────────────────────────
// Devolve todos os itens do escopo (lidos + com saldo), já com grupo, preço,
// vendas e entradas do período para a causa provável.
async function processar({ cnpj, chave, data, hora, agrupar, diasTransito = 7, leituraTexto, cadastro, onEtapa }) {
  const etapa = onEtapa || (() => {});
  const leitura = parseLeitura(leituraTexto);
  if (!leitura.codigos) throw new Error('O arquivo não tem nenhum código de barras.');

  etapa('Buscando o estoque no Microvix…');
  const inv = await fetchEstoque(cnpj, chave, data);
  const portal = String(inv[0]?.portal || '').trim() || cnpj;

  const est = new Map();        // cod → saldo
  const barraDoCod = new Map(); // cod → código de barras
  const codDaBarra = new Map(); // barraN → cod
  for (const r of inv) {
    const cod = String(r.cod_produto || '').trim();
    if (!cod) continue;
    est.set(cod, (est.get(cod) || 0) + num(r.quantidade));
    if (r.cod_barra) { barraDoCod.set(cod, String(r.cod_barra).trim()); codDaBarra.set(normBarra(r.cod_barra), cod); }
  }

  // Movimento: janela do trânsito até o dia do balanço
  const dIni = new Date(data + 'T12:00:00Z');
  dIni.setUTCDate(dIni.getUTCDate() - Math.max(0, Number(diasTransito) || 0));
  const iniTransito = dIni.toISOString().slice(0, 10);
  etapa('Buscando vendas e entradas do período…');
  const mov = await fetchMovimento(cnpj, iniTransito, data, chave).catch(e => { console.warn('[balanco] movimento:', e.message); return []; });

  const dataBR = data.split('-').reverse().join('/');
  const vendas = new Map(), transito = new Map();
  let movDepoisDaHora = 0;
  for (const r of mov) {
    if (r.cancelado === 'S' || r.excluido === 'S') continue;
    const cod = String(r.cod_produto || '').trim();
    if (!cod) continue;
    const q = num(r.quantidade);
    const op = String(r.operacao || '').trim().toUpperCase();
    const tipo = String(r.tipo_transacao || '').trim().toUpperCase();
    const doDia = String(r.data_documento || '').startsWith(dataBR);
    const serie = String(r.serie || '').trim().toUpperCase();
    const ajuste = serie === 'J' || tipo === 'J' || !parseInt(r.documento || '0');

    // Saldo na hora do balanço: desfaz o que entrou/saiu depois
    if (hora && doDia && String(r.hora_lancamento || '') > hora) {
      if (op === 'S') est.set(cod, (est.get(cod) || 0) + q);
      else if (op === 'E' || op === 'DS') est.set(cod, (est.get(cod) || 0) - q);
      movDepoisDaHora++;
      continue;
    }
    if (ajuste) continue;
    if (op === 'S' && tipo === 'V' && doDia) vendas.set(cod, (vendas.get(cod) || 0) + q);
    if (op === 'E' && !/devolu/i.test(r.desc_cfop || '')) transito.set(cod, (transito.get(cod) || 0) + q);
  }

  // Código de barras lido → produto
  const lidoPorCod = new Map();
  const barrasSemCod = [];
  for (const [bn, v] of leitura.porBarra) {
    const cod = codDaBarra.get(bn);
    if (cod) lidoPorCod.set(cod, { ...v, q: (lidoPorCod.get(cod)?.q || 0) + v.q });
    else barrasSemCod.push(bn);
  }

  etapa('Conferindo o cadastro dos produtos…');
  const amostra = [...barraDoCod].slice(0, 40).map(([cod, barra]) => ({ cod, barra }));
  const buscarNexo = await cadastro.nexoServe(amostra);
  if (buscarNexo) {
    // cadastro vem do NEXO
  } else if (!(await cadastro.sincronizado(portal))) {
    etapa('Primeira vez neste portal: baixando o cadastro de produtos do Microvix (pode levar alguns minutos)…');
    await cadastro.sync(portal, cnpj, chave, n => etapa(`Baixando o cadastro de produtos… ${n.toLocaleString('pt-BR')} produtos`));
  } else {
    await cadastro.sync(portal, cnpj, chave).catch(e => console.warn('[balanco] sync cadastro:', e.message));
  }

  const codsEscopo = new Set([...lidoPorCod.keys()]);
  for (const [cod, q] of est) if (q !== 0) codsEscopo.add(cod);
  const consulta = { cods: [...codsEscopo], barrasN: barrasSemCod };
  let info = buscarNexo ? await buscarNexo(consulta) : await cadastro.buscar(portal, consulta);

  const naoCadastrados = [];
  for (const bn of barrasSemCod) {
    const p = info.porBarra.get(bn);
    const v = leitura.porBarra.get(bn);
    if (p) {
      lidoPorCod.set(p.cod, { ...v, q: (lidoPorCod.get(p.cod)?.q || 0) + v.q });
      codsEscopo.add(p.cod);
      if (!barraDoCod.has(p.cod)) barraDoCod.set(p.cod, p.barra);
    } else naoCadastrados.push(v);
  }

  // Produto com saldo que não veio na sincronização: busca um a um (raro)
  const faltam = [...codsEscopo].filter(c => !info.porCod.has(c)).slice(0, 150);
  for (const c of faltam) {
    try { const p = await cadastro.buscarUm(portal, cnpj, chave, c); if (p) info.porCod.set(c, p); }
    catch (e) { console.warn('[balanco] produto', c, e.message); }
  }

  etapa('Buscando os preços de venda…');
  const preco = new Map();
  const det = await linx('LinxProdutosDetalhes', cnpj, chave, [
    { id: 'data_mov_ini', valor: '2000-01-01' },
    { id: 'data_mov_fim', valor: hojeISO() },
    { id: 'timestamp', valor: '0' },
  ]).catch(e => { console.warn('[balanco] detalhes:', e.message); return []; });
  for (const r of det) preco.set(String(r.cod_produto).trim(), num(r.preco_venda));
  // Lido sem saldo não vem no detalhe geral — pergunta produto a produto
  const semPreco = [...codsEscopo].filter(c => !preco.has(c)).slice(0, 150);
  for (const c of semPreco) {
    try {
      const r = await linx('LinxProdutosDetalhes', cnpj, chave, [
        { id: 'data_mov_ini', valor: '2000-01-01' }, { id: 'data_mov_fim', valor: hojeISO() },
        { id: 'timestamp', valor: '0' }, { id: 'cod_produto', valor: c },
      ]);
      if (r[0]) preco.set(c, num(r[0].preco_venda));
    } catch (e) { console.warn('[balanco] preço', c, e.message); }
  }

  // Setor igual em tudo (na Tommy é sempre "TOMMY HILFIGER") não separa nada:
  // agrupa pela linha, como o Microvix faz lá
  if (agrupar !== 'linha') {
    const setores = new Set([...codsEscopo].map(c => info.porCod.get(c)?.setor).filter(Boolean));
    if (setores.size <= 1) agrupar = 'linha';
  }
  const itens = [];
  for (const cod of codsEscopo) {
    const p = info.porCod.get(cod) || {};
    const lido = lidoPorCod.get(cod);
    const grupo = (agrupar === 'linha' ? p.linha : p.setor) || '(SEM GRUPO)';
    itens.push({
      c: cod,
      b: lido?.barra || barraDoCod.get(cod) || p.barra || '',
      d: p.nome || '(sem cadastro)',
      r: p.ref || '',
      g: grupo,
      e: Math.round((est.get(cod) || 0) * 1000) / 1000,
      l: lido ? lido.q : 0,
      lido: !!lido,
      o: lido ? lido.ordem : null,
      p: preco.get(cod) || 0,
      v: vendas.get(cod) || 0,
      t: transito.get(cod) || 0,
      rc: null, ob: '',
    });
  }
  // Código lido que o Microvix não conhece: entra para não sumir da conferência
  for (const v of naoCadastrados) {
    itens.push({ c: '', b: v.barra, d: 'CÓDIGO NÃO CADASTRADO', r: '', g: '(NÃO CADASTRADO)',
      e: 0, l: v.q, lido: true, o: v.ordem, p: 0, v: 0, t: 0, rc: null, ob: '' });
  }
  itens.sort((a, b) => a.g.localeCompare(b.g) || a.r.localeCompare(b.r) || a.d.localeCompare(b.d));

  return {
    itens,
    portal,
    leitura: { codigos: leitura.codigos, pecas: leitura.pecas, invalidas: leitura.invalidas },
    janelaTransito: { ini: iniTransito, fim: data },
    movDepoisDaHora,
    naoCadastrados: naoCadastrados.length,
    agrupar,
  };
}

// ── Regras da recontagem (as mesmas fórmulas da planilha) ──────────────────
function causaProvavel(it) {
  const dif = it.l - it.e;
  if (it.t && dif < 0 && -dif === it.t) return 'VER TRÂNSITO';
  if (it.v > 0 && Math.abs(dif) === it.v) return 'VER VENDA';
  if (it.v > 0) return 'VENDA PARCIAL';
  return 'A RECONTAR';
}
function statusItem(it) {
  if (it.rc === null || it.rc === undefined || it.rc === '') return causaProvavel(it);
  return Number(it.rc) === it.e ? 'OK' : 'DIVERGENTE';
}
// Itens que vão para a recontagem: lidos com diferença (e, se o balanço pedir,
// os que têm saldo e não foram lidos)
function itensRecontagem(bal) {
  const fora = new Set(bal.gruposFora || []);
  return (bal.itens || []).filter(it => !fora.has(it.g) && it.l !== it.e && (it.lido || bal.incluirNaoLidos));
}

function resumo(bal) {
  const lista = itensRecontagem(bal);
  const porGrupo = new Map();
  const tot = { grupo: 'TOTAL', itens: 0, recontados: 0, ok: 0, divergentes: 0, pendentes: 0,
    impactoSistema: 0, impactoConfirmado: 0, impactoApurar: 0,
    explicadoVenda: 0, vendas: 0, explicadoTransito: 0, transito: 0, pecasDif: 0, pecasDifFinal: 0 };
  for (const it of lista) {
    const g = grupoCurto(it.g);
    if (!porGrupo.has(g)) porGrupo.set(g, { ...tot, grupo: g, itens: 0, recontados: 0, ok: 0, divergentes: 0, pendentes: 0,
      impactoSistema: 0, impactoConfirmado: 0, impactoApurar: 0, explicadoVenda: 0, vendas: 0, explicadoTransito: 0, transito: 0, pecasDif: 0, pecasDifFinal: 0 });
    const s = statusItem(it);
    const dif = it.l - it.e;
    const recontado = it.rc !== null && it.rc !== undefined && it.rc !== '';
    for (const o of [porGrupo.get(g), tot]) {
      o.itens++;
      if (recontado) o.recontados++; else o.pendentes++;
      if (s === 'OK') o.ok++;
      if (s === 'DIVERGENTE') o.divergentes++;
      if (s === 'VER VENDA') o.explicadoVenda++;
      if (s === 'VER TRÂNSITO') o.explicadoTransito++;
      o.impactoSistema += dif * it.p;
      if (recontado) o.impactoConfirmado += (Number(it.rc) - it.e) * it.p;
      else o.impactoApurar += dif * it.p;
      o.vendas += it.v || 0;
      o.transito += it.t || 0;
      o.pecasDif += dif;
      o.pecasDifFinal += recontado ? Number(it.rc) - it.e : dif;
    }
  }
  const fora = new Set(bal.gruposFora || []);
  const escopo = (bal.itens || []).filter(it => !fora.has(it.g));
  // Importado de planilha só traz os itens com diferença: total de peças não existe
  const daPlanilha = bal.origem === 'planilha';
  const pecasLidas = daPlanilha ? null : escopo.reduce((a, it) => a + it.l, 0);
  const pecasEstoque = daPlanilha ? null : escopo.reduce((a, it) => a + it.e, 0);
  return {
    grupos: [...porGrupo.values()].sort((a, b) => a.grupo.localeCompare(b.grupo)),
    total: tot,
    pecasLidas, pecasEstoque,
    naoLidos: escopo.filter(it => !it.lido && it.e !== 0).length,
    pecasNaoLidas: escopo.filter(it => !it.lido).reduce((a, it) => a + it.e, 0),
  };
}

// ── TXT corrigido: leitura + recontagens, no formato do Microvix ───────────
function txtCorrigido(bal) {
  const linhas = [];
  const fora = new Set(bal.gruposFora || []);
  const itens = (bal.itens || []).filter(it => it.b && !fora.has(it.g));
  const final = it => (it.rc !== null && it.rc !== undefined && it.rc !== '') ? Number(it.rc) : it.l;
  const lidos = itens.filter(it => it.lido).sort((a, b) => a.o - b.o);
  for (const it of lidos) linhas.push(`${it.b},${final(it)}`);
  // Não lido que a loja achou na recontagem
  for (const it of itens) if (!it.lido && final(it) > 0) linhas.push(`${it.b},${final(it)}`);
  return linhas.join('\r\n') + '\r\n';
}

module.exports = {
  parseLeitura, processar, criarCadastro, causaProvavel, statusItem,
  itensRecontagem, resumo, txtCorrigido, grupoCurto, normBarra,
};
