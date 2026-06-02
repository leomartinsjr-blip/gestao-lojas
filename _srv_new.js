// ── CADASTRO DE PRODUTO ─────────────────────────────────────────────────

app.get('/api/cadastro-produto/fornecedores-microvix', requireAdmin, async (req, res) => {
  try {
    const lojas = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const cnpj  = Object.values(lojas)[0] || '';
    const chave = process.env.MICROVIX_CHAVE;
    if (!cnpj) return res.json([]);
    const { buildRequest, postRequest, parseCsv } = require('./services/microvix');
    const body = buildRequest('LinxFornecedores', cnpj, [], chave);
    const raw  = await postRequest(body, 30_000);
    if (raw.includes('<ResponseSuccess>False</ResponseSuccess>')) return res.json([]);
    const rows = parseCsv(raw);
    const list = rows.map(r => ({
      cod:  String(r.cod_fornecedor || r.codigo || r.cod || '').trim(),
      nome: String(r.nome_fornecedor || r.nome || r.razao_social || r.fantasia || '').trim(),
    })).filter(f => f.cod && f.nome);
    res.json(list);
  } catch (e) {
    console.warn('[CadastroProduto/fornecedores-microvix]', e.message);
    res.json([]);
  }
});

app.get('/api/cadastro-produto/fornecedores', requireAdmin, async (req, res) => {
  try { res.json(await mongoDb.collection('supplier_profiles').find({}).sort({ name: 1 }).toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cadastro-produto/fornecedores', requireAdmin, async (req, res) => {
  try {
    const { _id, name, mapping, defaults } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const col = mongoDb.collection('supplier_profiles');
    if (_id) {
      const { ObjectId } = require('mongodb');
      const oid = new ObjectId(_id);
      await col.updateOne({ _id: oid }, { $set: { name, mapping: mapping || {}, defaults: defaults || {}, updatedAt: new Date() } });
      res.json(await col.findOne({ _id: oid }));
    } else {
      const doc = { name, mapping: mapping || {}, defaults: defaults || {}, createdAt: new Date() };
      const r = await col.insertOne(doc);
      res.json({ ...doc, _id: r.insertedId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cadastro-produto/fornecedores/:id', requireAdmin, async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    await mongoDb.collection('supplier_profiles').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const _cadPdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/cadastro-produto/parse-pdf', requireAdmin, _cadPdfUpload.single('file'), async (req, res) => {
  try {
    let pdfParse;
    try { pdfParse = require('pdf-parse'); }
    catch { return res.status(500).json({ error: 'Módulo pdf-parse não instalado. Use planilha Excel por enquanto.' }); }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const data  = await pdfParse(req.file.buffer);
    const lines = data.text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 300);
    res.json({ headers: ['texto_original'], rows: lines.map(l => [l]), pages: data.numpages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cadastro-produto/check', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows deve ser array' });
    const lojas   = JSON.parse(process.env.MICROVIX_LOJAS || '{}');
    const catalog = await _getCatalog(lojas).catch(() => ({}));
    const result  = rows.map(r => {
      const ref   = (r.referencia || '').trim().toUpperCase();
      const barra = (r.cod_barra  || '').trim();
      const found = catalog[ref] || catalog[r.referencia] || (barra ? catalog[barra] : null);
      return { ...r, _status: found ? 'existing' : 'new' };
    });
    res.json({ result, newCount: result.filter(r => r._status === 'new').length, existingCount: result.filter(r => r._status === 'existing').length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cadastro-produto/export', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Nenhum produto para exportar' });
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Produtos');
    ws.columns = [
      { header: 'Descrição',                    key: 'descricao',   width: 45 },
      { header: 'Referência',                   key: 'referencia',  width: 20 },
      { header: 'Fornecedor',                   key: 'fornecedor',  width: 30 },
      { header: 'Contabiliza saldo em estoque', key: 'contabiliza', width: 28 },
      { header: 'Setor',                        key: 'setor',       width: 20 },
      { header: 'Linha',                        key: 'linha',       width: 12 },
      { header: 'Marca',                        key: 'marca',       width: 20 },
      { header: 'Coleção',                      key: 'colecao',     width: 18 },
      { header: 'Tamanho',                      key: 'tamanho',     width: 12 },
      { header: 'Cores',                        key: 'cores',       width: 15 },
      { header: 'Unidade de venda',             key: 'unidade',     width: 15 },
      { header: 'Custo com ICMS (R$)',           key: 'custo_icms',  width: 18 },
      { header: 'Mark-up (%)',                  key: 'markup',      width: 12 },
      { header: 'Preço de venda R$',            key: 'preco_venda', width: 16 },
      { header: 'NCM',                          key: 'ncm',         width: 14 },
      { header: 'Tipo de item',                 key: 'tipo_item',   width: 25 },
      { header: 'Código de barras',             key: 'cod_barra',   width: 20 },
    ];
    ws.getRow(1).eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1117' } };
      cell.font      = { bold: true, color: { argb: 'FF58A6FF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FF58A6FF' } } };
    });
    ws.getRow(1).height = 30;
    rows.forEach(r => ws.addRow({
      descricao:   r.nome         || '',
      referencia:  r.referencia   || '',
      fornecedor:  r.fornecedor   || '',
      contabiliza: 'Sim',
      setor:       r.desc_setor   || '',
      linha:       'Unisex',
      marca:       r.desc_marca   || '',
      colecao:     r.colecao      || '',
      tamanho:     r.desc_tamanho || '',
      cores:       r.desc_cor     || '',
      unidade:     'UN',
      custo_icms:  r.preco_custo  || '',
      markup:      r.markup       || '',
      preco_venda: r.preco_venda  || '',
      ncm:         r.ncm          || '',
      tipo_item:   'Mercadoria para Revenda',
      cod_barra:   r.cod_barra    || '',
    }));
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=cadastro_microvix_${date}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[CadastroProduto/export]', e.message);
    res.status(500).json({ error: e.message });
  }
});

