// Rotas do Balanço de Loja. O cálculo fica em ./balanco e os arquivos
// (PDF e planilha) em ./balancoArquivos.
//
// Quem faz o quê:
//   • escritório/admin — cria o balanço (sobe o TXT), reprocessa, escolhe os
//     grupos, exporta, finaliza e exclui;
//   • loja (e supervisor, nas lojas dele) — vê os balanços da loja e lança a
//     recontagem enquanto o balanço está aberto.
//
// Sem MongoDB (rodando local) os balanços ficam num JSON na pasta temporária.

const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const {
  processar, criarCadastro, resumo, txtCorrigido, statusItem,
} = require('./balanco');
const { pdfListaCriticas, excelRecontagem, lerPlanilhaRecontagem } = require('./balancoArquivos');

const NOMES_LOJA = {
  delrey: 'Surfers Del Rey', minas: 'Surfers Minas', contagem: 'Surfers Contagem',
  estacao: 'Surfers Estação', tommy: 'Tommy Hilfiger Del Rey', lez: 'Lez a Lez',
};

function register(app, { getDb, requireAuth, requireEscritorioOrAdmin, boardsLabel }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const cadastro = criarCadastro(getDb);
  const lojas = () => JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const chaveDe = b => process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  const label = b => boardsLabel[b] || String(b || '').toUpperCase();

  // ── Armazenamento ────────────────────────────────────────────────────────
  const LOCAL = path.join(os.tmpdir(), 'gestao-balancos');
  const local = {
    ler(id) { try { return JSON.parse(fs.readFileSync(path.join(LOCAL, id + '.json'), 'utf8')); } catch { return null; } },
    gravar(doc) { fs.mkdirSync(LOCAL, { recursive: true }); fs.writeFileSync(path.join(LOCAL, doc.id + '.json'), JSON.stringify(doc)); },
    todos() { try { return fs.readdirSync(LOCAL).filter(f => /^[a-z0-9]+\.json$/.test(f)).map(f => local.ler(f.slice(0, -5))).filter(Boolean); } catch { return []; } },
  };
  let indicesProntos = false;
  function col() {
    const db = getDb();
    if (!db) return null;
    const c = db.collection('balancos');
    if (!indicesProntos) {
      indicesProntos = true;
      c.createIndex({ id: 1 }, { unique: true, background: true }).catch(() => {});
      c.createIndex({ board: 1, mes: -1 }, { background: true }).catch(() => {});
    }
    return c;
  }
  async function ler(id) {
    const c = col();
    return c ? c.findOne({ id }, { projection: { _id: 0 } }) : local.ler(id);
  }
  async function salvar(id, set) {
    const c = col();
    if (c) { await c.updateOne({ id }, { $set: set }); return; }
    const doc = local.ler(id); if (doc) local.gravar({ ...doc, ...set });
  }
  async function guardarArquivo(id, tipo, buf) {
    const db = getDb();
    if (db) {
      await db.collection('balanco_arquivos').replaceOne({ _id: `${id}:${tipo}` },
        { _id: `${id}:${tipo}`, data: buf, em: new Date() }, { upsert: true });
    } else {
      fs.mkdirSync(LOCAL, { recursive: true });
      fs.writeFileSync(path.join(LOCAL, `${id}.${tipo}`), buf);
    }
  }
  async function lerArquivo(id, tipo) {
    const db = getDb();
    if (db) {
      const d = await db.collection('balanco_arquivos').findOne({ _id: `${id}:${tipo}` });
      return d ? Buffer.from(d.data.buffer || d.data) : null;
    }
    try { return fs.readFileSync(path.join(LOCAL, `${id}.${tipo}`)); } catch { return null; }
  }

  // ── Permissões ───────────────────────────────────────────────────────────
  const u = req => req.session.user || {};
  const ehEscritorio = req => { const x = u(req); return x.board ? x.board === 'escritorio' : !(x.lojas && x.lojas.length); };
  const lojasDoUsuario = req => {
    const x = u(req);
    if (ehEscritorio(req)) return null; // todas
    if (x.board) return [x.board];
    return x.lojas || [];
  };
  const podeVer = (req, bal) => { const l = lojasDoUsuario(req); return !l || l.includes(bal.board); };
  const quem = req => u(req).username || '?';

  async function carregar(req, res) {
    const bal = await ler(req.params.id);
    if (!bal || !podeVer(req, bal)) { res.status(404).json({ error: 'Balanço não encontrado' }); return null; }
    // Deploy/restart no meio do processamento: não fica "processando" para sempre
    if (bal.status === 'processando' && !rodando.has(bal.id)) {
      Object.assign(bal, { status: 'erro', etapa: null, erro: 'O processamento foi interrompido (o servidor reiniciou). Clique em Reprocessar.' });
      await salvar(bal.id, { status: bal.status, etapa: null, erro: bal.erro });
    }
    return bal;
  }

  // Resumo enxuto para a lista e o histórico
  function cabecalho(bal) {
    const { itens, leituraTexto, ...resto } = bal;
    const r = bal.status === 'processando' || bal.status === 'erro' || !itens ? null : resumo(bal);
    return {
      ...resto, lojaLabel: label(bal.board),
      resumo: r && {
        pecasLidas: r.pecasLidas, pecasEstoque: r.pecasEstoque,
        itens: r.total.itens, recontados: r.total.recontados, pendentes: r.total.pendentes,
        ok: r.total.ok, divergentes: r.total.divergentes,
        impactoSistema: r.total.impactoSistema, impactoConfirmado: r.total.impactoConfirmado,
        impactoApurar: r.total.impactoApurar, pecasDif: r.total.pecasDif, pecasDifFinal: r.total.pecasDifFinal,
      },
    };
  }

  async function gerarPdf(bal) {
    const buf = await pdfListaCriticas(bal, { lojaLabel: NOMES_LOJA[bal.board] || label(bal.board) });
    await guardarArquivo(bal.id, 'pdf', buf);
  }

  // Processa em segundo plano: a primeira vez num portal baixa o cadastro todo
  const rodando = new Set();
  async function rodar(id, recontagensAntigas) {
    rodando.add(id);
    const bal = await ler(id);
    const cnpj = String(lojas()[bal.board] || '').replace(/\D/g, '');
    try {
      if (!cnpj) throw new Error(`Loja ${label(bal.board)} sem CNPJ do Microvix configurado.`);
      let ultima = 0;
      const r = await processar({
        cnpj, chave: chaveDe(bal.board), data: bal.data, hora: bal.hora || null,
        agrupar: bal.agrupar, diasTransito: bal.diasTransito, leituraTexto: bal.leituraTexto, cadastro,
        onEtapa: msg => { if (Date.now() - ultima > 1500) { ultima = Date.now(); salvar(id, { etapa: msg }).catch(() => {}); } },
      });
      if (recontagensAntigas) {
        for (const it of r.itens) {
          const old = recontagensAntigas.get(it.c || it.b);
          if (old) { it.rc = old.rc; it.ob = old.ob; it.rp = old.rp; it.rt = old.rt; }
        }
      }
      const set = {
        status: 'recontagem', etapa: null, erro: null, itens: r.itens, portal: r.portal,
        leitura: r.leitura, janelaTransito: r.janelaTransito, movDepoisDaHora: r.movDepoisDaHora,
        naoCadastrados: r.naoCadastrados, processadoEm: new Date().toISOString(),
      };
      await salvar(id, set);
      await gerarPdf({ ...bal, ...set });
    } catch (e) {
      console.error('[balanco] processar', id, e);
      await salvar(id, { status: 'erro', etapa: null, erro: e.message });
    } finally { rodando.delete(id); }
  }

  // ── Página ───────────────────────────────────────────────────────────────
  app.get('/balanco', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'balanco.html')));

  // ── Lista (mês) e histórico ──────────────────────────────────────────────
  app.get('/api/balancos', requireAuth, async (req, res) => {
    try {
      const l = lojasDoUsuario(req);
      const filtro = {};
      if (req.query.mes) filtro.mes = String(req.query.mes);
      if (req.query.board) filtro.board = String(req.query.board);
      if (l) filtro.board = filtro.board && l.includes(filtro.board) ? filtro.board : { $in: l };
      const c = col();
      let docs;
      if (c) {
        docs = await c.find(filtro, { projection: { _id: 0, leituraTexto: 0 } }).sort({ mes: -1, data: -1 }).toArray();
      } else {
        docs = local.todos().filter(d => (!filtro.mes || d.mes === filtro.mes)
          && (!filtro.board || (filtro.board.$in ? filtro.board.$in.includes(d.board) : d.board === filtro.board)))
          .sort((a, b) => (b.mes + b.data).localeCompare(a.mes + a.data));
      }
      res.json({ balancos: docs.map(cabecalho), escritorio: ehEscritorio(req), lojas: l || Object.keys(lojas()) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Novo balanço ─────────────────────────────────────────────────────────
  app.post('/api/balancos', requireEscritorioOrAdmin, upload.single('arquivo'), async (req, res) => {
    try {
      const { board, data, hora, mes, agrupar, diasTransito, obs } = req.body;
      if (!board || !lojas()[board]) return res.status(400).json({ error: 'Escolha a loja.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return res.status(400).json({ error: 'Informe a data do balanço.' });
      if (hora && !/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ error: 'Hora no formato HH:MM.' });
      if (!req.file) return res.status(400).json({ error: 'Envie o arquivo TXT da leitura.' });
      const leituraTexto = req.file.buffer.toString('latin1');
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const doc = {
        id, board, data, hora: hora || null,
        mes: /^\d{4}-\d{2}$/.test(mes || '') ? mes : data.slice(0, 7),
        agrupar: agrupar === 'setor' ? 'setor' : agrupar === 'linha' ? 'linha' : (board === 'tommy' ? 'linha' : 'setor'),
        diasTransito: Math.min(60, Math.max(0, parseInt(diasTransito) || 7)),
        incluirNaoLidos: true, gruposFora: [],
        obs: String(obs || '').slice(0, 500),
        arquivoNome: req.file.originalname, leituraTexto,
        status: 'processando', etapa: 'Na fila…',
        criadoPor: quem(req), criadoEm: new Date().toISOString(),
      };
      const c = col();
      if (c) await c.insertOne({ ...doc }); else local.gravar(doc);
      rodar(id);
      res.json({ id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Um balanço ───────────────────────────────────────────────────────────
  app.get('/api/balancos/:id', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const { leituraTexto, ...resto } = bal;
      res.json({ ...resto, lojaLabel: label(bal.board), escritorio: ehEscritorio(req),
        resumo: bal.itens ? resumo(bal) : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ajustes do escritório: grupos fora, não lidos, mês, obs, finalizar/reabrir
  app.patch('/api/balancos/:id', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const set = {};
      const b = req.body || {};
      if (Array.isArray(b.gruposFora)) set.gruposFora = b.gruposFora.map(String);
      if (typeof b.incluirNaoLidos === 'boolean') set.incluirNaoLidos = b.incluirNaoLidos;
      if (/^\d{4}-\d{2}$/.test(b.mes || '')) set.mes = b.mes;
      if (typeof b.obs === 'string') set.obs = b.obs.slice(0, 500);
      if (b.status === 'finalizado' && bal.status === 'recontagem') {
        const r = resumo({ ...bal, ...set });
        Object.assign(set, { status: 'finalizado', finalizadoPor: quem(req), finalizadoEm: new Date().toISOString(),
          resumoFinal: { total: r.total, grupos: r.grupos, pecasLidas: r.pecasLidas, pecasEstoque: r.pecasEstoque } });
      }
      if (b.status === 'recontagem' && bal.status === 'finalizado') Object.assign(set, { status: 'recontagem', finalizadoPor: null, finalizadoEm: null });
      await salvar(bal.id, set);
      if (set.gruposFora) await gerarPdf({ ...bal, ...set });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Recontagem: loja e escritório. Chave do item = código (ou o código de
  // barras, para código lido que não tem cadastro).
  async function aplicarRecontagens(req, bal, lista) {
    const porChave = new Map(lista.map(x => [String(x.k ?? x.cod), x]));
    const agora = new Date().toISOString();
    // Só os campos do item que mudou: regravar a lista inteira a cada número
    // digitado pela loja é banda à toa (vide o sync do Microvix)
    const set = {};
    (bal.itens || []).forEach((it, i) => {
      const x = porChave.get(String(it.c || it.b));
      if (!x) return;
      const rc = x.rc === '' || x.rc === null || x.rc === undefined ? null : Number(x.rc);
      if (rc !== null && (!Number.isFinite(rc) || rc < 0)) return;
      const ob = x.ob === undefined ? it.ob : String(x.ob || '').slice(0, 300);
      if (rc === it.rc && ob === it.ob) return;
      Object.assign(it, { rc, ob, rp: quem(req), rt: agora });
      for (const k of ['rc', 'ob', 'rp', 'rt']) set[`itens.${i}.${k}`] = it[k];
    });
    const n = Object.keys(set).length / 4;
    if (n) {
      if (col()) await salvar(bal.id, { ...set, atualizadoEm: agora });
      else await salvar(bal.id, { itens: bal.itens, atualizadoEm: agora });
    }
    return n;
  }

  app.patch('/api/balancos/:id/itens', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (bal.status !== 'recontagem') return res.status(409).json({ error: 'Este balanço não está aberto para recontagem.' });
      const n = await aplicarRecontagens(req, bal, Array.isArray(req.body?.itens) ? req.body.itens : []);
      res.json({ ok: true, alterados: n, resumo: resumo(bal) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/balancos/:id/importar', requireAuth, upload.single('arquivo'), async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (bal.status !== 'recontagem') return res.status(409).json({ error: 'Este balanço não está aberto para recontagem.' });
      if (!req.file) return res.status(400).json({ error: 'Envie a planilha.' });
      const linhas = await lerPlanilhaRecontagem(req.file.buffer);
      const chaves = new Set((bal.itens || []).map(it => String(it.c || it.b)));
      const conhecidas = linhas.filter(l => chaves.has(String(l.cod)));
      // Célula vazia na planilha não apaga o que já foi lançado no gestão
      const comValor = conhecidas.filter(l => l.rc !== null || l.ob);
      const n = await aplicarRecontagens(req, bal, comValor.map(l => ({ k: l.cod, rc: l.rc, ob: l.ob || undefined })));
      res.json({ ok: true, linhas: linhas.length, reconhecidas: conhecidas.length, alterados: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/balancos/:id/reprocessar', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (rodando.has(bal.id)) return res.status(409).json({ error: 'Já está processando.' });
      if (bal.status === 'finalizado') return res.status(409).json({ error: 'Reabra o balanço antes de reprocessar.' });
      const set = { status: 'processando', etapa: 'Na fila…', erro: null };
      const b = req.body || {};
      if (b.hora !== undefined) set.hora = /^\d{2}:\d{2}$/.test(b.hora) ? b.hora : null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.data || '')) set.data = b.data;
      if (b.agrupar === 'setor' || b.agrupar === 'linha') { set.agrupar = b.agrupar; set.gruposFora = []; }
      if (b.diasTransito !== undefined) set.diasTransito = Math.min(60, Math.max(0, parseInt(b.diasTransito) || 0));
      const antigas = new Map((bal.itens || []).filter(it => it.rc !== null || it.ob).map(it => [it.c || it.b, it]));
      await salvar(bal.id, set);
      rodar(bal.id, antigas);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/balancos/:id', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const c = col();
      if (c) {
        await c.deleteOne({ id: bal.id });
        await getDb().collection('balanco_arquivos').deleteMany({ _id: { $regex: '^' + bal.id + ':' } });
      } else {
        for (const ext of ['json', 'pdf']) fs.rmSync(path.join(LOCAL, `${bal.id}.${ext}`), { force: true });
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Arquivos ─────────────────────────────────────────────────────────────
  const nomeBase = bal => `Balanço ${label(bal.board)} ${bal.data.split('-').reverse().join('-')}`;
  const anexo = (res, nome, tipo) => {
    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `attachment; filename="${nome.normalize('NFD').replace(/[^\x20-\x7e]/g, '')}"; filename*=UTF-8''${encodeURIComponent(nome)}`);
  };

  app.get('/api/balancos/:id/pdf', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      let buf = await lerArquivo(bal.id, 'pdf');
      if (!buf && bal.itens) { await gerarPdf(bal); buf = await lerArquivo(bal.id, 'pdf'); }
      if (!buf) return res.status(404).json({ error: 'PDF ainda não gerado.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent('Lista de Críticas — ' + nomeBase(bal) + '.pdf')}`);
      res.send(buf);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/balancos/:id/planilha', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (!bal.itens) return res.status(409).json({ error: 'Balanço ainda não processado.' });
      const buf = await excelRecontagem(bal);
      anexo(res, `Recontagem ${label(bal.board)} ${bal.data.split('-').reverse().join('-')}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(Buffer.from(buf));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/balancos/:id/txt', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (!bal.itens) return res.status(409).json({ error: 'Balanço ainda não processado.' });
      anexo(res, `${nomeBase(bal)} corrigido.txt`, 'text/plain; charset=utf-8');
      res.send(txtCorrigido(bal));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/balancos/:id/leitura', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      anexo(res, bal.arquivoNome || `${nomeBase(bal)}.txt`, 'text/plain; charset=latin1');
      res.send(Buffer.from(bal.leituraTexto || '', 'latin1'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { statusItem };
}

module.exports = { register };
