'use strict';
// Rotas da Agenda bancária (aba "Agenda" do /fluxo-caixa, só admin). O cálculo
// dos saldos e a leitura da planilha ficam em ./agenda.
//
// Coleções: agendaLanc (um doc por lançamento) e agendaConfig (_id = empresa:
// contas e limite da conta garantida). Sem MongoDB, tudo num JSON na pasta temporária.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const agenda = require('./agenda');

// Descrições padrão (aba LISTAS da planilha)
const DESCRICOES = ['3L', 'AJUDA DE CUSTO', 'AJUSTE', 'AJUSTE SALDO', 'APORTE JUNIOR', 'AREZZO', 'C/G', 'CARTÃO', 'CIELO', 'DEPOSITO',
  'DUPLI', 'DUPLI ATRASADA', 'FLMJ', 'IOF', 'IOF C/G', 'JDG', 'JUROS', 'LF', 'LMJ', 'PAGALI', 'PAGARME', 'PIX', 'PRONAMPE', 'PV', 'REDE',
  'RS', 'SALDO', 'SICOOB', 'SITE', 'STONE', 'TAR', 'TAR C/G', 'TAR MAQ', 'TAR PIX', 'TAR REN', 'TED', 'TTS', 'V.T'];

function register(app, { getDb, readDB, requireAdmin, fluxoCaixa, fluxoTaxas, boardsLabel }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const LOCAL = path.join(os.tmpdir(), 'gestao-agenda.json');
  const lerLocal = () => { try { return JSON.parse(fs.readFileSync(LOCAL, 'utf8')); } catch { return { lancs: [], config: {} }; } };
  const gravarLocal = d => fs.writeFileSync(LOCAL, JSON.stringify(d));
  const por = req => req.session?.user?.name || req.session?.user?.login || '';

  const store = {
    async lancs(filtro = {}) {
      const db = getDb();
      if (db) return db.collection('agendaLanc').find(filtro, { projection: { _id: 0 } }).toArray();
      return lerLocal().lancs.filter(l => Object.entries(filtro).every(([k, v]) => l[k] === v));
    },
    async config() {
      const db = getDb(), out = {};
      if (db) await db.collection('agendaConfig').find().forEach(c => { out[c._id] = c; });
      else Object.assign(out, lerLocal().config);
      return out;
    },
    async inserir(docs) {
      const db = getDb();
      if (db) { if (docs.length) await db.collection('agendaLanc').insertMany(docs.map(d => ({ ...d }))); return; }
      const d = lerLocal(); d.lancs.push(...docs); gravarLocal(d);
    },
    async atualizar(id, campos) {
      const db = getDb();
      if (db) return (await db.collection('agendaLanc').updateOne({ id }, { $set: campos })).matchedCount;
      const d = lerLocal(); const l = d.lancs.find(x => x.id === id); if (!l) return 0; Object.assign(l, campos); gravarLocal(d); return 1;
    },
    async apagar(id) {
      const db = getDb();
      if (db) return (await db.collection('agendaLanc').deleteOne({ id })).deletedCount;
      const d = lerLocal(); const n = d.lancs.length; d.lancs = d.lancs.filter(x => x.id !== id); gravarLocal(d); return n - d.lancs.length;
    },
    async salvarConfig(emp, campos) {
      const db = getDb();
      if (db) return db.collection('agendaConfig').updateOne({ _id: emp }, { $set: campos }, { upsert: true });
      const d = lerLocal(); d.config[emp] = { ...(d.config[emp] || {}), _id: emp, ...campos }; gravarLocal(d);
    },
    async substituirTudo(docs) {
      const db = getDb();
      if (db) { await db.collection('agendaLanc').deleteMany({}); if (docs.length) await db.collection('agendaLanc').insertMany(docs); return; }
      const d = lerLocal(); d.lancs = docs; gravarLocal(d);
    },
  };

  const ordem = (a, b) => a.data.localeCompare(b.data) || (a.seq ?? 0) - (b.seq ?? 0);
  const contasPadrao = emp => ['CC', 'CG', ...Object.keys(agenda.BOARD[emp] || {}).filter(c => c !== 'CC' && c !== 'CG')];

  // GET /api/agenda?emp=LMJ&data=YYYY-MM-DD — painel das empresas + o dia escolhido
  app.get('/api/agenda', requireAdmin, async (req, res) => {
    try {
      const [todos, cfg] = await Promise.all([store.lancs(), store.config()]);
      todos.sort(ordem);
      const saldos = agenda.saldos(todos);
      const ultimo = {};
      for (const l of todos) if (!ultimo[l.emp] || l.data > ultimo[l.emp]) ultimo[l.emp] = l.data;
      const empresas = agenda.EMPRESAS.map(emp => ({
        emp, contas: cfg[emp]?.contas || contasPadrao(emp), limite: cfg[emp]?.limite ?? null,
        saldos: saldos[emp] || {}, ultimo: ultimo[emp] || null,
      }));
      const emp = agenda.EMPRESAS.includes(req.query.emp) ? req.query.emp : 'LMJ';
      const doEmp = todos.filter(l => l.emp === emp);
      const datas = [...new Set(doEmp.map(l => l.data))];
      const data = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : (ultimo[emp] || fluxoCaixa.hojeBRT());
      const antes = agenda.saldos(doEmp.filter(l => l.data < data))[emp] || {};
      const usadas = new Set(DESCRICOES);
      for (const l of doEmp) if (l.desc && !l.abertura) usadas.add(l.desc);
      res.json({
        empresas, emp, data, hoje: fluxoCaixa.hojeBRT(), datas,
        antes, dia: doEmp.filter(l => l.data === data),
        descricoes: [...usadas].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      });
    } catch (e) { console.error('[agenda]', e); res.status(500).json({ error: e.message }); }
  });

  const validar = b => {
    const valor = Number(b.valor);
    if (!agenda.EMPRESAS.includes(b.emp)) return 'empresa inválida';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '')) return 'data inválida';
    if (!b.conta) return 'conta obrigatória';
    if (!Number.isFinite(valor) || !valor) return 'valor obrigatório (negativo = saída)';
    return null;
  };

  // POST /api/agenda/lanc { emp, data, conta, desc, valor, espelho }
  app.post('/api/agenda/lanc', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const erro = validar(b);
      if (erro) return res.status(400).json({ error: erro });
      const doDia = (await store.lancs({ emp: b.emp })).filter(l => l.data === b.data);
      const doc = { id: crypto.randomUUID(), emp: b.emp, data: b.data, seq: doDia.reduce((m, l) => Math.max(m, l.seq ?? 0), -1) + 1,
        conta: String(b.conta).toUpperCase(), desc: String(b.desc || '').trim().toUpperCase().slice(0, 60) || '—',
        valor: Math.round(Number(b.valor) * 100) / 100, espelho: !!b.espelho && b.conta === 'CC', por: por(req), em: new Date() };
      await store.inserir([doc]);
      res.json({ ok: true, lanc: doc });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/agenda/lanc/:id { desc, valor, conta, data }
  app.put('/api/agenda/lanc/:id', requireAdmin, async (req, res) => {
    try {
      const campos = {};
      if (req.body?.desc != null) campos.desc = String(req.body.desc).trim().toUpperCase().slice(0, 60) || '—';
      if (req.body?.valor != null) {
        const v = Number(req.body.valor);
        if (!Number.isFinite(v) || !v) return res.status(400).json({ error: 'valor inválido' });
        campos.valor = Math.round(v * 100) / 100;
      }
      if (req.body?.conta) campos.conta = String(req.body.conta).toUpperCase();
      if (req.body?.data != null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.data)) return res.status(400).json({ error: 'data inválida' });
        const [l] = await store.lancs({ id: req.params.id });
        if (!l) return res.status(404).json({ error: 'não encontrado' });
        if (l.data !== req.body.data) {
          // Muda de dia: entra no fim do dia novo
          const doDia = (await store.lancs({ emp: l.emp })).filter(x => x.data === req.body.data);
          campos.data = req.body.data;
          campos.seq = doDia.reduce((m, x) => Math.max(m, x.seq ?? 0), -1) + 1;
        }
      }
      campos.por = por(req); campos.em = new Date();
      if (!(await store.atualizar(req.params.id, campos))) return res.status(404).json({ error: 'não encontrado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/agenda/lanc/:id', requireAdmin, async (req, res) => {
    try {
      if (!(await store.apagar(req.params.id))) return res.status(404).json({ error: 'não encontrado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/agenda/limite { emp, limite } — limite da conta garantida
  app.put('/api/agenda/limite', requireAdmin, async (req, res) => {
    try {
      const { emp } = req.body || {};
      const limite = req.body?.limite === null ? null : Number(req.body?.limite);
      if (!agenda.EMPRESAS.includes(emp) || (limite !== null && !Number.isFinite(limite))) return res.status(400).json({ error: 'empresa e limite' });
      await store.salvarConfig(emp, { limite });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/agenda/importar (arquivo) — sem ?confirmar=1 só confere; com, substitui tudo
  app.post('/api/agenda/importar', requireAdmin, upload.single('arquivo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'envie a planilha AGENDA' });
      const r = agenda.lerPlanilha(req.file.buffer);
      if (!r.lancs.length) return res.status(400).json({ error: 'nenhum lançamento encontrado (abas LMJ, JDG, PV, 3L, LF)' });
      const datas = r.lancs.map(l => l.data).sort();
      const resumo = { lancamentos: r.lancs.length, de: datas[0], ate: datas[datas.length - 1], conferencia: r.conferencia, limites: r.limites };
      if (req.query.confirmar !== '1') return res.json({ ok: true, previa: true, ...resumo });
      const quem = por(req), agora = new Date();
      await store.substituirTudo(r.lancs.map(l => ({ id: crypto.randomUUID(), ...l, origem: 'planilha', por: quem, em: agora })));
      for (const [emp, contas] of Object.entries(r.contas)) await store.salvarConfig(emp, { contas, ...(r.limites[emp] != null ? { limite: r.limites[emp] } : {}) });
      res.json({ ok: true, importado: true, ...resumo });
    } catch (e) { console.error('[agenda importar]', e); res.status(500).json({ error: e.message }); }
  });

  // O que deve cair/sair no dia: REDE (venda do dia útil anterior sem a taxa; segunda = sex–dom)
  // e DUPLI (faturas que vencem; segunda = sáb–seg). Feriado acumula conta e recebimento para o
  // dia útil seguinte (fluxoCaixa.janelaDoDia). Fonte única do Previsto e do Resumo do dia.
  const boardsDe = emp => [...new Set(Object.entries(agenda.BOARD[emp] || {}).filter(([c]) => c !== 'CG').map(([, b]) => b))];
  const dataDe = q => /^\d{4}-\d{2}-\d{2}$/.test(q || '') ? q : fluxoCaixa.hojeBRT();
  async function previstoDoDia(boards, data) {
    const jan = fluxoCaixa.janelaDoDia(data);
    const [db, taxas] = await Promise.all([readDB(), fluxoTaxas(fluxoCaixa.hojeBRT())]);
    const mongo = getDb();
    const faturas = mongo
      ? await mongo.collection('cpFaturas').find({ isPagar: true, previsao: { $ne: 'S' }, board: { $in: boards }, vencimento: { $in: jan.pagar } },
          { projection: { _id: 0, board: 1, fornecedor: 1, parcela: 1, vencimento: 1, baixa: 1, valor: 1, valorLiquido: 1, valorPago: 1, previsao: 1 } }).toArray()
      : [];
    const r = fluxoCaixa.resumoDoDia({ db, faturas: [], taxas, boards, hoje: data });
    const itens = boards.map(b => {
      const conta = b === 'site' ? 'SITE' : 'CC';
      const fs_ = faturas.filter(f => f.board === b).map(f => ({
        forn: f.fornecedor, venc: f.vencimento, parc: f.parcela, pago: !!f.baixa, previsao: f.previsao,
        v: Math.round((f.baixa ? (f.valorPago || 0) : (f.valorLiquido ?? f.valor) - (f.valorPago || 0)) * 100) / 100,
      })).filter(f => f.v > 0.005).sort((a, b2) => b2.v - a.v);
      const e = r.empresas[b];
      return { board: b, label: boardsLabel[b] || b, conta, venda: e.venda, taxa: e.taxa, rede: e.entra,
        dupli: Math.round(fs_.reduce((s, f) => s + f.v, 0) * 100) / 100, faturas: fs_ };
    });
    return { data: jan.alvo, pagar: jan.pagar, venda: jan.venda, itens };
  }

  // GET /api/agenda/sugestoes?emp=&data= — previsto do dia de uma empresa
  app.get('/api/agenda/sugestoes', requireAdmin, async (req, res) => {
    try {
      const data = dataDe(req.query.data);
      const boards = boardsDe(req.query.emp);
      if (!boards.length) return res.json({ data, boards: [], itens: [] });
      res.json(await previstoDoDia(boards, data));
    } catch (e) { console.error('[agenda sugestoes]', e); res.status(500).json({ error: e.message }); }
  });

  // GET /api/agenda/resumo-dia?data= — o mesmo previsto, de todas as empresas da agenda
  app.get('/api/agenda/resumo-dia', requireAdmin, async (req, res) => {
    try {
      const p = await previstoDoDia([...new Set(agenda.EMPRESAS.flatMap(boardsDe))], dataDe(req.query.data));
      const soma = (its, f) => Math.round(its.reduce((s, i) => s + f(i), 0) * 100) / 100;
      const empresas = agenda.EMPRESAS.map(emp => {
        const bs = boardsDe(emp), its = p.itens.filter(i => bs.includes(i.board));
        const faturas = its.flatMap(i => i.faturas.map(f => ({ ...f, loja: i.label }))).sort((a, b) => b.v - a.v);
        return { emp, microvix: bs.length > 0, lojas: its.map(i => i.label), venda: soma(its, i => i.venda), rede: soma(its, i => i.rede),
          dupli: soma(its, i => i.dupli), baixado: soma(faturas, f => f.pago ? f.v : 0), faturas };
      });
      res.json({ hoje: fluxoCaixa.hojeBRT(), data: p.data, pagar: p.pagar, venda: p.venda, empresas });
    } catch (e) { console.error('[agenda resumo-dia]', e); res.status(500).json({ error: e.message }); }
  });

  // Planilha externa, sem sessão: o token vai no cabeçalho x-planilha-token, nunca
  // na URL. Sem PLANILHA_TOKEN configurado a rota fica fechada.
  const hash = s => crypto.createHash('sha256').update(s).digest();
  function requirePlanilhaToken(req, res, next) {
    const esperado = process.env.PLANILHA_TOKEN || '';
    const veio = String(req.get('x-planilha-token') || '');
    if (esperado.length < 24 || !crypto.timingSafeEqual(hash(veio), hash(esperado)))
      return res.status(401).json({ error: 'Token inválido' });
    next();
  }

  // GET /api/planilha/saldos?data=YYYY-MM-DD — uma linha por conta, só leitura.
  // Sem data, até hoje: lançamento futuro não entra no saldo.
  app.get('/api/planilha/saldos', requirePlanilhaToken, async (req, res) => {
    try {
      const data = dataDe(req.query.data);
      const [todos, cfg] = await Promise.all([store.lancs(), store.config()]);
      const ate = todos.filter(l => l.data <= data);
      const saldos = agenda.saldos(ate);
      const ultimo = {};
      for (const l of ate) if (!ultimo[l.emp] || l.data > ultimo[l.emp]) ultimo[l.emp] = l.data;
      res.json(agenda.EMPRESAS.flatMap(emp => {
        const contas = new Set([...(cfg[emp]?.contas || contasPadrao(emp)), ...Object.keys(saldos[emp] || {})]);
        return [...contas].map(conta => ({
          data, empresa: emp, conta, saldo: saldos[emp]?.[conta] ?? 0,
          limite: conta === 'CG' ? cfg[emp]?.limite ?? null : null,
          ultimoLancamento: ultimo[emp] || null,
        }));
      }));
    } catch (e) { console.error('[planilha saldos]', e); res.status(500).json({ error: 'Erro ao calcular os saldos' }); }
  });

  // Saldo da agenda por loja, para o fluxo: atual e no fim de cada mês.
  return {
    async saldosParaFluxo(ano) {
      const todos = await store.lancs();
      if (!todos.length) return null;
      const ult = todos.reduce((m, l) => l.data > m ? l.data : m, '');
      const atual = agenda.saldoPorBoard(todos);
      const fimMes = {};
      const mesAtual = fluxoCaixa.hojeBRT().slice(0, 7);
      for (let m = 1; m <= 12; m++) {
        const mk = `${ano}-${String(m).padStart(2, '0')}`;
        const fim = `${mk}-31`;
        // só mês que já virou e que a agenda alcançou
        if (mk >= mesAtual || `${mk}-01` > ult) break;
        for (const [b, v] of Object.entries(agenda.saldoPorBoard(todos, fim))) (fimMes[b] ||= {})[mk] = v;
      }
      // Saldo de partida do ano (lançamentos de abertura) por loja
      const abertura = {};
      for (const l of todos) if (l.abertura && l.data.startsWith(ano + '-')) {
        const b = agenda.boardDe(l.emp, l.conta); if (b) abertura[b] = Math.round(((abertura[b] || 0) + l.valor) * 100) / 100;
      }
      return { ultimo: ult, atual, fimMes, abertura };
    },
  };
}

module.exports = { register };
