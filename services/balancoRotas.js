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
  processar, criarCadastro, resumo, txtCorrigido, statusItem, sugerirTrocas,
} = require('./balanco');
const { pdfListaCriticas, excelRecontagem, lerPlanilhaRecontagem } = require('./balancoArquivos');

const NOMES_LOJA = {
  delrey: 'Surfers Del Rey', minas: 'Surfers Minas', contagem: 'Surfers Contagem',
  estacao: 'Surfers Estação', tommy: 'Tommy Hilfiger Del Rey', lez: 'Lez a Lez',
};

function register(app, { getDb, getNexoDb, requireAuth, requireEscritorioOrAdmin, boardsLabel }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const cadastro = criarCadastro(getNexoDb);
  const lojas = () => JSON.parse(process.env.MICROVIX_LOJAS || '{}');
  const chaveDe = b => process.env[`MICROVIX_CHAVE_${b.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
  const label = b => boardsLabel[b] || String(b || '').toUpperCase();

  // O multer entrega o nome do arquivo em latin1 ("BALANÃO" no lugar de "BALANÇO")
  const nomeArquivo = f => Buffer.from(f.originalname, 'latin1').toString('utf8');

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

  // Uma vez, no boot: a primeira versão gravava uma cópia do cadastro de
  // produtos (balanco_produtos) e só a da Tommy levou o Atlas gratuito ao
  // alerta de espaço. Antes de apagar, usa a cópia para reagrupar pela linha
  // o balanço processado com tudo em TOMMY HILFIGER (sem mexer na recontagem).
  const limpeza = setInterval(async () => {
    const db = getDb();
    if (!db) return;
    clearInterval(limpeza);
    try {
      const prod = db.collection('balanco_produtos');
      if (!(await prod.estimatedDocumentCount())) return;
      const lista = await col().find({ agrupar: { $ne: 'linha' }, origem: { $ne: 'planilha' }, portal: { $exists: true } }).toArray();
      for (const bal of lista) {
        if (new Set((bal.itens || []).filter(it => it.c).map(it => it.g)).size > 1) continue;
        const docs = await prod.find({ portal: bal.portal, cod: { $in: bal.itens.map(it => it.c).filter(Boolean) } },
          { projection: { cod: 1, linha: 1 } }).toArray();
        const linha = new Map(docs.map(d => [d.cod, d.linha]));
        let n = 0;
        for (const it of bal.itens) { const l = linha.get(it.c); if (l) { it.g = l; n++; } }
        if (!n) continue;
        await col().updateOne({ id: bal.id }, { $set: { itens: bal.itens, agrupar: 'linha', gruposFora: [] } });
        await gerarPdf({ ...bal, agrupar: 'linha', gruposFora: [] });
        console.log(`[balanco] ${bal.id} reagrupado pela linha (${n} itens)`);
      }
      await prod.drop();
      await db.collection('balanco_meta').deleteMany({ _id: /^prod:/ });
      console.log('[balanco] cópia do cadastro de produtos apagada');
    } catch (e) { console.warn('[balanco] limpeza do cadastro:', e.message); }
  }, 5000);

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
    await salvar(bal.id, { temPdf: true });
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
          if (old) { it.rc = old.rc; it.ob = old.ob; it.rp = old.rp; it.rt = old.rt; if (old.st) it.st = old.st; }
        }
      }
      const set = {
        status: 'recontagem', etapa: null, erro: null, itens: r.itens, portal: r.portal,
        origem: null, // importado de planilha com o TXT: agora é um balanço completo
        agrupar: r.agrupar, ...(r.agrupar !== bal.agrupar ? { gruposFora: [] } : {}),
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
        arquivoNome: nomeArquivo(req.file), leituraTexto,
        status: 'processando', etapa: 'Na fila…',
        criadoPor: quem(req), criadoEm: new Date().toISOString(),
      };
      const c = col();
      if (c) await c.insertOne({ ...doc }); else local.gravar(doc);
      rodar(id);
      res.json({ id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Arquivar balanço feito fora do gestão (planilha de recontagem) ───────
  // Para o histórico dos meses de antes e para o balanço que já estava em
  // recontagem na planilha. O PDF da Lista de Críticas e o TXT são opcionais;
  // com o TXT dá para reprocessar depois e gerar o TXT corrigido.
  const uploadArquivar = upload.fields([{ name: 'arquivo', maxCount: 1 }, { name: 'pdf', maxCount: 1 }, { name: 'txt', maxCount: 1 }]);
  app.post('/api/balancos/arquivar', requireEscritorioOrAdmin, uploadArquivar, async (req, res) => {
    try {
      const { board, mes, obs, situacao } = req.body;
      const planilha = req.files?.arquivo?.[0];
      if (!board || !lojas()[board]) return res.status(400).json({ error: 'Escolha a loja.' });
      if (!planilha) return res.status(400).json({ error: 'Envie a planilha de recontagem (.xlsx).' });
      const lida = await lerPlanilhaRecontagem(planilha.buffer);
      if (!lida.completa) return res.status(400).json({ error: 'A aba RECONTAGEM precisa das colunas Estoque, Balanço e Preço Unit.' });
      if (!lida.linhas.length) return res.status(400).json({ error: 'Nenhum item na aba RECONTAGEM.' });
      // A "Data:" da planilha é =HOJE(): mostra quando foi salva, não a contagem
      const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : null;
      if (!data) return res.status(400).json({ error: 'Informe a data da contagem.' });
      const agora = new Date().toISOString();
      const itens = lida.linhas.map(l => {
        const extra = l.extra ? `${l.extraNome.replace(/\?$/, '')}: ${l.extra}` : '';
        return {
          c: l.cod, b: '', d: l.desc, r: l.ref, g: l.setor || '(SEM SETOR)',
          e: l.e || 0, l: l.l || 0, lido: (l.l || 0) > 0, o: null, p: l.p || 0, v: l.v || 0, t: l.t || 0,
          rc: l.rc, ob: [l.ob, extra].filter(Boolean).join(' · '),
          rp: l.rc !== null ? 'planilha' : undefined, rt: l.rc !== null ? agora : undefined,
        };
      });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const txt = req.files?.txt?.[0];
      const doc = {
        id, board, data, hora: null, origem: 'planilha',
        mes: /^\d{4}-\d{2}$/.test(mes || '') ? mes : data.slice(0, 7),
        agrupar: board === 'tommy' ? 'linha' : 'setor', diasTransito: 7,
        incluirNaoLidos: true, gruposFora: [], obs: String(obs || '').slice(0, 500),
        arquivoNome: nomeArquivo(planilha), leituraTexto: txt ? txt.buffer.toString('latin1') : null,
        itens, leitura: null, janelaTransito: null, duplicadasRemovidas: lida.duplicadas,
        status: situacao === 'recontagem' ? 'recontagem' : 'finalizado',
        criadoPor: quem(req), criadoEm: agora, processadoEm: agora,
      };
      if (doc.status === 'finalizado') {
        const r = resumo(doc);
        Object.assign(doc, { finalizadoPor: quem(req), finalizadoEm: agora,
          resumoFinal: { total: r.total, grupos: r.grupos, pecasLidas: r.pecasLidas, pecasEstoque: r.pecasEstoque } });
      }
      const c = col();
      if (c) await c.insertOne({ ...doc }); else local.gravar(doc);
      // O PDF impresso do Microvix passa fácil de 15 MB: não cabe num documento
      // do Mongo e come o espaço do plano gratuito
      const pdf = req.files?.pdf?.[0];
      let aviso = null;
      if (pdf && pdf.size > 8 * 1024 * 1024) aviso = `O PDF tem ${(pdf.size / 1048576).toFixed(1)} MB (limite 8 MB) e não foi guardado.`;
      else if (pdf) { await guardarArquivo(id, 'pdf', pdf.buffer); await salvar(id, { temPdf: true }); }
      res.json({ id, itens: itens.length, duplicadas: lida.duplicadas, recontados: itens.filter(i => i.rc !== null).length, aviso });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Um balanço ───────────────────────────────────────────────────────────
  app.get('/api/balancos/:id', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const { leituraTexto, ...resto } = bal;
      res.json({ ...resto, temLeitura: !!leituraTexto, temPdf: bal.temPdf || bal.origem !== 'planilha',
        lojaLabel: label(bal.board), escritorio: ehEscritorio(req),
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
      if (typeof b.ajustadoMicrovix === 'boolean')
        set.ajustadoMicrovix = b.ajustadoMicrovix ? { por: quem(req), em: new Date().toISOString() } : null;
      if (b.status === 'finalizado' && bal.status === 'recontagem') {
        if (!(set.ajustadoMicrovix ?? bal.ajustadoMicrovix))
          return res.status(409).json({ error: 'Marque o balanço como ajustado no Microvix antes de finalizar.' });
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

  // Status manual do item (escritório). st vazio volta ao automático.
  const STATUS_MANUAL = ['OK', 'DIVERGENTE', 'VER VENDA', 'VER TRÂNSITO', 'A RECONTAR', 'TROCA', 'AJUSTAR'];
  app.patch('/api/balancos/:id/status-item', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const k = String(req.body?.k || ''), st = req.body?.st || null;
      if (st && !STATUS_MANUAL.includes(st)) return res.status(400).json({ error: 'status inválido' });
      const i = (bal.itens || []).findIndex(it => String(it.c || it.b) === k);
      if (i < 0) return res.status(404).json({ error: 'item não encontrado' });
      bal.itens[i].st = st;
      if (col()) await salvar(bal.id, { [`itens.${i}.st`]: st, atualizadoEm: new Date().toISOString() });
      else await salvar(bal.id, { itens: bal.itens });
      res.json({ ok: true, resumo: resumo(bal) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Trocas: o escritório gera a sugestão (rascunho) e envia para a loja; a loja marca as feitas.
  app.post('/api/balancos/:id/trocas', requireEscritorioOrAdmin, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const agora = new Date().toISOString();
      if (req.body?.enviar) {
        if (!bal.trocas?.itens?.length) return res.status(409).json({ error: 'Gere as trocas antes de enviar.' });
        const trocas = { ...bal.trocas, enviadaEm: agora, enviadaPor: quem(req) };
        await salvar(bal.id, { trocas });
        return res.json({ ok: true, trocas });
      }
      // Gerar de novo mantém as que a loja já marcou como feitas
      const feitas = (bal.trocas?.itens || []).filter(t => t.feita);
      const chave = t => `${t.entra.c}>${t.sai.c}`;
      const jaFeitas = new Set(feitas.map(chave));
      const novas = sugerirTrocas(bal).filter(t => !jaFeitas.has(chave(t)))
        .map((t, i) => ({ id: `${Date.now().toString(36)}${i}`, ...t, feita: false }));
      const trocas = { itens: [...feitas, ...novas], geradaEm: agora, geradaPor: quem(req), enviadaEm: null, enviadaPor: null };
      await salvar(bal.id, { trocas });
      res.json({ ok: true, trocas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.patch('/api/balancos/:id/trocas/:tid', requireAuth, async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      const i = (bal.trocas?.itens || []).findIndex(t => t.id === req.params.tid);
      if (i < 0 || (!bal.trocas.enviadaEm && !ehEscritorio(req))) return res.status(404).json({ error: 'troca não encontrada' });
      const feita = !!req.body?.feita;
      const campos = { feita, feitaPor: feita ? quem(req) : null, feitaEm: feita ? new Date().toISOString() : null };
      Object.assign(bal.trocas.itens[i], campos);
      const set = Object.fromEntries(Object.entries(campos).map(([c, v]) => [`trocas.itens.${i}.${c}`, v]));
      // Troca feita: os dois códigos passam a TROCA na recontagem. Desmarcar só volta ao automático
      // o que ainda está como TROCA e não faz parte de outra troca feita.
      const t = bal.trocas.itens[i];
      const emOutraFeita = c => bal.trocas.itens.some(o => o.feita && o.id !== t.id && (o.entra.c === c || o.sai.c === c));
      const sts = {};
      [t.entra.c, t.sai.c].forEach(c => {
        const j = (bal.itens || []).findIndex(it => String(it.c || it.b) === String(c));
        if (j < 0) return;
        const it = bal.itens[j];
        const st = feita ? 'TROCA' : (it.st === 'TROCA' && !emOutraFeita(c) ? null : it.st || null);
        if ((it.st || null) === st) return;
        it.st = st; set[`itens.${j}.st`] = st; sts[it.c || it.b] = st;
      });
      if (col()) await salvar(bal.id, set);
      else await salvar(bal.id, { trocas: bal.trocas, itens: bal.itens });
      res.json({ ok: true, sts, resumo: resumo(bal) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/balancos/:id/importar', requireAuth, upload.single('arquivo'), async (req, res) => {
    try {
      const bal = await carregar(req, res); if (!bal) return;
      if (bal.status !== 'recontagem') return res.status(409).json({ error: 'Este balanço não está aberto para recontagem.' });
      if (!req.file) return res.status(400).json({ error: 'Envie a planilha.' });
      const { linhas } = await lerPlanilhaRecontagem(req.file.buffer);
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
      if (!bal.leituraTexto) return res.status(409).json({ error: 'Balanço importado de planilha sem o TXT da leitura: não dá para reprocessar.' });
      if (bal.status === 'finalizado') return res.status(409).json({ error: 'Reabra o balanço antes de reprocessar.' });
      const set = { status: 'processando', etapa: 'Na fila…', erro: null };
      const b = req.body || {};
      if (b.hora !== undefined) set.hora = /^\d{2}:\d{2}$/.test(b.hora) ? b.hora : null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.data || '')) set.data = b.data;
      if (b.agrupar === 'setor' || b.agrupar === 'linha') { set.agrupar = b.agrupar; set.gruposFora = []; }
      if (b.diasTransito !== undefined) set.diasTransito = Math.min(60, Math.max(0, parseInt(b.diasTransito) || 0));
      const antigas = new Map((bal.itens || []).filter(it => it.rc !== null || it.ob || it.st).map(it => [it.c || it.b, it]));
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
      // Importado de planilha só tem os divergentes: a Lista de Críticas sairia pela metade
      if (!buf && bal.itens && bal.origem !== 'planilha') { await gerarPdf(bal); buf = await lerArquivo(bal.id, 'pdf'); }
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
      if (!bal.leituraTexto) return res.status(409).json({ error: 'Este balanço veio de planilha, sem o TXT da leitura.' });
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
