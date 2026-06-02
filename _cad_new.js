// ── CADASTRO DE PRODUTO ─────────────────────────────────────────────────

const CAMPOS_MX = [
  { key: 'referencia',   label: 'Referência',     required: true },
  { key: 'nome',         label: 'Nome/Descrição',  required: true },
  { key: 'cod_barra',    label: 'Cód. de Barras' },
  { key: 'desc_marca',   label: 'Marca' },
  { key: 'desc_setor',   label: 'Setor' },
  { key: 'desc_cor',     label: 'Cor' },
  { key: 'desc_tamanho', label: 'Tamanho' },
  { key: 'preco_custo',  label: 'Custo c/ICMS' },
  { key: 'preco_venda',  label: 'Preço Venda' },
];

const CORES_CAD = ['PRETO','BRANCO','AZUL','VERMELHO','VERDE','AMARELO','LARANJA','ROSA',
  'ROXO','CINZA','MARROM','BEGE','NUDE','KHAKI','BORDO','NAVY','CARAMELO','AREIA',
  'MENTA','CORAL','TURQUESA','VINHO','DOURADO','PRATA','OFF WHITE','NATURAL',
  'BLACK','WHITE','BLUE','RED','GREEN','YELLOW','ORANGE','PINK','PURPLE','GREY','GRAY','BROWN','BEIGE'];
const TAMS_LETRA = ['GGG','GG','XS/S','S/M','M/L','L/XL','PP','XS','S','M','L','XL','XXL','XXXL','P','G','U'];
const TAMS_NUM   = ['33','34','35','36','37','38','39','40','41','42','43','44','45','46'];

const _cad = {
  file: null, headers: [], rawRows: [], mapping: {},
  fornecedoresMx: [], fornecedor: null,
  colecao: '', setor: '', modeloRef: '{REF}', modeloDesc: '{NOME}',
  priceMode: 'markup', markup: 100, manualPrice: '',
  ncm: '', products: [], checkResult: [],
};

function _cadExtractCor(text) {
  const up = text.toUpperCase();
  return CORES_CAD.find(c => c.split(' ').every(p => new RegExp('\\b' + p + '\\b').test(up))) || '';
}

function _cadExtractTam(text) {
  const up = text.toUpperCase().replace(/[^A-Z0-9\/]/g, ' ');
  for (const sz of TAMS_LETRA) {
    if (new RegExp('(^|\\s)' + sz.replace('/', '\\/') + '(\\s|$)').test(up)) return sz;
  }
  const m = up.match(/\b(3[3-9]|4[0-6])\b/);
  return m ? m[0] : '';
}

function _cadSuggestSetor(texts) {
  const t = texts.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/feminino|fem\b|woman|blusa|saia|vestido/.test(t)) return 'Moda Feminina';
  if (/masculino|masc\b|\bman\b/.test(t)) return 'Moda Masculina';
  if (/infantil|kids|bebe|crianca/.test(t)) return 'Infantil';
  if (/calcado|tenis|sandalia|sapato|bota|chinelo/.test(t)) return 'Calçados';
  if (/acessorio|bolsa|mochila|bone|oculos|relogio/.test(t)) return 'Acessórios';
  return 'Moda';
}

function _cadSuggestNcm(setor, textos) {
  const t = (setor + ' ' + textos.join(' ')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/calcado|tenis|sandalia|sapato|bota|chinelo/.test(t)) return '6402.99.90';
  if (/camiseta|t-shirt|regata/.test(t)) return '6109.10.00';
  if (/camisa(?!eta)/.test(t)) return '6205.20.00';
  if (/calca|short/.test(t)) return '6103.41.00';
  if (/vestido/.test(t)) return '6104.43.00';
  if (/blusa/.test(t)) return '6106.10.00';
  if (/moletom|agasalho/.test(t)) return '6110.20.10';
  if (/jaqueta|casaco/.test(t)) return '6201.92.00';
  if (/saia/.test(t)) return '6104.53.00';
  if (/bone|cap|viseira/.test(t)) return '6505.00.29';
  if (/bolsa|mochila/.test(t)) return '4202.12.20';
  return '6211.33.00';
}

function _cadApplyTemplate(tmpl, p) {
  return (tmpl || '')
    .replace(/\{REF\}/g,   p.referencia    || '')
    .replace(/\{NOME\}/g,  p.nome          || '')
    .replace(/\{COR\}/g,   p.desc_cor      || '')
    .replace(/\{TAM\}/g,   p.desc_tamanho  || '')
    .replace(/\{MARCA\}/g, p.desc_marca    || '')
    .replace(/\{SETOR\}/g, p.desc_setor    || '')
    .trim();
}

function _cadCalcPreco(custo) {
  if (_cad.priceMode === 'markup') {
    const c = parseFloat(String(custo).replace(',', '.')) || 0;
    return c > 0 ? (c * (1 + parseFloat(_cad.markup) / 100)).toFixed(2).replace('.', ',') : '';
  }
  if (_cad.priceMode === 'manual') return String(_cad.manualPrice);
  return '';
}

function _cadAutoMatch(headers) {
  const n = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const al = {
    referencia:   ['ref','referencia','codigo','cod','sku','codprod'],
    nome:         ['nome','descricao','produto','item','descbasica','desc'],
    cod_barra:    ['codbarra','ean','barra','barcode','gtin'],
    desc_marca:   ['marca','brand','fabricante'],
    desc_setor:   ['setor','departamento','categoria','grupo'],
    desc_cor:     ['cor','color','colour'],
    desc_tamanho: ['tamanho','tam','size','grade'],
    preco_custo:  ['precocusto','custo','pcusto','fob','custoproduto','precofob'],
    preco_venda:  ['precovenda','preco','pvenda','price','vlvenda'],
  };
  const map = {};
  for (const [f, words] of Object.entries(al)) {
    for (const h of headers) {
      const hn = n(h);
      if (words.some(w => hn === w || hn.includes(w))) { if (!map[f]) map[f] = h; break; }
    }
  }
  return map;
}

function _cadBuildProducts() {
  return _cad.rawRows.map(row => {
    const p = {};
    for (const [mxField, supCol] of Object.entries(_cad.mapping)) {
      const idx = _cad.headers.indexOf(supCol);
      if (idx >= 0) p[mxField] = String(row[idx] ?? '').trim();
    }
    if (!p.referencia && !p.nome) return null;
    const txt = (p.referencia || '') + ' ' + (p.nome || '');
    const cor = p.desc_cor || _cadExtractCor(txt);
    const tam = p.desc_tamanho || _cadExtractTam(txt);
    const custo = p.preco_custo || '';
    const precoAuto = (p.preco_venda && _cad.priceMode === 'auto') ? p.preco_venda : _cadCalcPreco(custo);
    return {
      ...p, desc_cor: cor, desc_tamanho: tam,
      _ref_final:  _cadApplyTemplate(_cad.modeloRef,  { ...p, desc_cor: cor, desc_tamanho: tam }),
      _desc_final: _cadApplyTemplate(_cad.modeloDesc, { ...p, desc_cor: cor, desc_tamanho: tam }),
      _custo: custo, _preco: precoAuto, _ncm: _cad.ncm,
    };
  }).filter(Boolean);
}

async function renderCadastroProdView() {
  _gestaoShowBack(true);
  _gestaoSetTitle(
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    'Cadastro de Produto'
  );
  const body = document.getElementById('transBody');
  apiFetch('GET', '/api/cadastro-produto/fornecedores-microvix')
    .then(list => {
      _cad.fornecedoresMx = list || [];
      const sel = body.querySelector('#cadFornSelect');
      if (sel) _cadPopulateFornSel(sel);
    }).catch(() => { _cad.fornecedoresMx = []; });
  _cadRenderUpload(body);
}

function _cadRenderUpload(body) {
  const fname = _cad.file ? _escHtml(_cad.file.name) : 'Escolher .xls / .xlsx / .pdf';
  body.innerHTML = `
    <div class="cad-panel">
      <div class="cad-top-row">
        <div class="cad-field-group">
          <label class="cad-field-label">Fornecedor (Microvix)</label>
          <select id="cadFornSelect" class="cad-select" style="min-width:230px">
            <option value="">Carregando…</option>
          </select>
        </div>
        <div class="cad-field-group">
          <label class="cad-field-label">Arquivo do pedido (.xls, .xlsx, .pdf)</label>
          <label class="trans-excel-upload-btn" style="min-width:230px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span id="cadFileName">${fname}</span>
            <input type="file" id="cadFileInput" accept=".xls,.xlsx,.pdf" style="display:none">
          </label>
        </div>
        <button class="trans-calc-btn" id="cadAnalyzeBtn" ${_cad.file ? '' : 'disabled'}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Analisar
        </button>
      </div>
      <div id="cadContent" style="margin-top:1.25rem"></div>
    </div>`;

  const fornSel = body.querySelector('#cadFornSelect');
  _cadPopulateFornSel(fornSel);
  fornSel.addEventListener('change', () => {
    const cod = fornSel.value;
    _cad.fornecedor = _cad.fornecedoresMx.find(f => f.cod === cod) ||
      (cod ? { cod, nome: fornSel.options[fornSel.selectedIndex]?.text || cod } : null);
  });
  if (_cad.fornecedor) fornSel.value = _cad.fornecedor.cod;

  const fi = body.querySelector('#cadFileInput');
  fi.addEventListener('change', () => {
    _cad.file = fi.files[0] || null;
    body.querySelector('#cadFileName').textContent = _cad.file ? _cad.file.name : 'Escolher .xls / .xlsx / .pdf';
    body.querySelector('#cadAnalyzeBtn').disabled = !_cad.file;
  });
  body.querySelector('#cadAnalyzeBtn').addEventListener('click', () => _cadParseFile(body));
}

function _cadPopulateFornSel(sel) {
  if (!sel) return;
  const cur = _cad.fornecedor?.cod || '';
  if (!_cad.fornecedoresMx.length) {
    sel.innerHTML = `<option value="">Nenhum fornecedor no Microvix</option>`;
    return;
  }
  sel.innerHTML = `<option value="">— selecionar fornecedor —</option>` +
    _cad.fornecedoresMx.map(f => `<option value="${_escHtml(f.cod)}"${f.cod === cur ? ' selected' : ''}>${_escHtml(f.nome)}</option>`).join('');
}

async function _cadParseFile(body) {
  const content = body.querySelector('#cadContent');
  content.innerHTML = '<div class="trans-loading">Lendo arquivo…</div>';
  const file = _cad.file;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'pdf') {
      const fd = new FormData(); fd.append('file', file);
      const d = await fetch('/api/cadastro-produto/parse-pdf', { method: 'POST', body: fd }).then(r => r.json());
      if (d.error) throw new Error(d.error);
      _cad.headers = d.headers || []; _cad.rawRows = d.rows || [];
    } else {
      if (!window.XLSX) throw new Error('Biblioteca Excel não carregada. Recarregue a página.');
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const data = window.XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
      if (data.length < 2) throw new Error('Planilha vazia ou sem dados');
      _cad.headers = data[0].map(h => String(h ?? '').trim());
      _cad.rawRows = data.slice(1).filter(r => r.some(c => c != null && c !== ''));
    }
    if (!_cad.rawRows.length) throw new Error('Nenhuma linha de dados encontrada');
    _cadRenderConfigAndMapping(content);
  } catch (e) {
    content.innerHTML = `<div class="trans-error">Erro ao ler arquivo: ${_escHtml(e.message)}</div>`;
  }
}

function _cadRenderConfigAndMapping(content) {
  const autoMap = _cadAutoMatch(_cad.headers);
  const descIdx = _cad.headers.findIndex(h => {
    const n = h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    return ['descricao','nome','produto','item','desc'].some(k => n.includes(k));
  });
  const sampleTexts = _cad.rawRows.slice(0, 30).map(r => String(r[descIdx] ?? '')).filter(Boolean);
  if (!_cad.setor)  _cad.setor = _cadSuggestSetor(sampleTexts);
  if (!_cad.ncm)    _cad.ncm   = _cadSuggestNcm(_cad.setor, sampleTexts);

  const tokBtns = target => ['REF','NOME','COR','TAM','MARCA']
    .map(t => `<button class="cad-token" data-token="{${t}}" data-target="${target}">{${t}}</button>`).join('');

  const pModes = [
    { val:'markup',  lbl:'Mark-up',   extra:`<input type="number" id="cadMarkup" class="cad-input-sm" value="${_cad.markup}" min="0" max="9999" style="width:60px;margin-left:.3rem"> %` },
    { val:'manual',  lbl:'Manual R$', extra:`<input type="text" id="cadManualPrice" class="cad-input-sm" value="${_escHtml(_cad.manualPrice)}" placeholder="0,00" style="width:70px;margin-left:.3rem">` },
    { val:'auto',    lbl:'Do pedido', extra:'' },
  ];

  content.innerHTML = `
    <div class="cad-config-grid">
      <div class="cad-config-left">
        <div class="cad-section-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          Mapeamento de Colunas
          <span class="cad-section-sub">${_cad.rawRows.length} linhas · ${_cad.headers.length} col.</span>
        </div>
        <table class="cad-map-table">
          <thead><tr><th>Campo Microvix</th><th>Coluna do pedido</th><th>Exemplo</th></tr></thead>
          <tbody>
            ${CAMPOS_MX.map(f => {
              const auto = autoMap[f.key] || '';
              const prev = auto ? String(_cad.rawRows[0]?.[_cad.headers.indexOf(auto)] ?? '').slice(0,35) : '';
              return `<tr>
                <td class="cad-map-field">${_escHtml(f.label)}${f.required ? '<span class="cad-required"> *</span>' : ''}</td>
                <td><select class="cad-map-select" data-mx="${f.key}">
                  <option value="">— não usar —</option>
                  ${_cad.headers.map(h => `<option value="${_escHtml(h)}"${h === auto ? ' selected' : ''}>${_escHtml(h)}</option>`).join('')}
                </select></td>
                <td class="cad-map-preview" id="cadPrev_${f.key}">${_escHtml(prev)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="cad-config-right">
        <div class="cad-section-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 1 0 4.93 19.07"/></svg>
          Configurações do Pedido
        </div>
        <div class="cad-config-form">
          <div class="cad-form-row">
            <div class="cad-form-field">
              <label class="cad-field-label">Coleção <span class="cad-required">*</span></label>
              <input type="text" id="cadColecao" class="cad-input" placeholder="Ex: Verão 2026" value="${_escHtml(_cad.colecao)}">
            </div>
            <div class="cad-form-field">
              <label class="cad-field-label">Setor (sugerido)</label>
              <input type="text" id="cadSetor" class="cad-input" value="${_escHtml(_cad.setor)}" placeholder="Ex: Moda Masculina">
            </div>
          </div>

          <div class="cad-form-row">
            <div class="cad-form-field cad-form-wide">
              <label class="cad-field-label">Modelo de Referência</label>
              <div class="cad-tmpl-row">
                <input type="text" id="cadModeloRef" class="cad-input" value="${_escHtml(_cad.modeloRef)}" placeholder="{REF}">
                <div class="cad-tokens">${tokBtns('cadModeloRef')}</div>
              </div>
              <div class="cad-prev-line">Prévia: <span id="cadRefPrev" class="cad-prev-val"></span></div>
            </div>
          </div>

          <div class="cad-form-row">
            <div class="cad-form-field cad-form-wide">
              <label class="cad-field-label">Modelo de Descrição</label>
              <div class="cad-tmpl-row">
                <input type="text" id="cadModeloDesc" class="cad-input" value="${_escHtml(_cad.modeloDesc)}" placeholder="{NOME} {COR} {TAM}">
                <div class="cad-tokens">${tokBtns('cadModeloDesc')}</div>
              </div>
              <div class="cad-prev-line">Prévia: <span id="cadDescPrev" class="cad-prev-val"></span></div>
            </div>
          </div>

          <div class="cad-form-row">
            <div class="cad-form-field cad-form-wide">
              <label class="cad-field-label">Preço de Venda</label>
              <div class="cad-price-modes">
                ${pModes.map(m => `<label class="cad-price-mode${_cad.priceMode === m.val ? ' active' : ''}">
                  <input type="radio" name="cadPriceMode" value="${m.val}"${_cad.priceMode === m.val ? ' checked' : ''}> ${m.lbl}${m.extra}
                </label>`).join('')}
              </div>
            </div>
          </div>

          <div class="cad-form-row">
            <div class="cad-form-field">
              <label class="cad-field-label">NCM (sugerido)</label>
              <input type="text" id="cadNcm" class="cad-input" value="${_escHtml(_cad.ncm)}" placeholder="0000.00.00">
            </div>
            <div class="cad-form-field">
              <label class="cad-field-label">Linha</label>
              <input class="cad-input cad-input-fixed" value="Unisex" disabled>
            </div>
            <div class="cad-form-field" style="flex:1.6">
              <label class="cad-field-label">Tipo de item</label>
              <input class="cad-input cad-input-fixed" value="Mercadoria para Revenda" disabled>
            </div>
          </div>

          <div class="cad-form-row" style="justify-content:flex-end;margin-top:.5rem">
            <button class="trans-calc-btn" id="cadGenerateBtn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Gerar tabela de produtos
            </button>
          </div>
        </div>
      </div>
    </div>
    <div id="cadProdSection" style="margin-top:1.5rem;display:none"></div>`;

  content.querySelectorAll('.cad-map-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = _cad.headers.indexOf(sel.value);
      const val = idx >= 0 ? String(_cad.rawRows[0]?.[idx] ?? '').slice(0,35) : '';
      const el = content.querySelector('#cadPrev_' + sel.dataset.mx);
      if (el) el.textContent = val;
      _cadRefreshPrev(content);
    });
  });

  content.querySelectorAll('.cad-token').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = content.querySelector('#' + btn.dataset.target);
      if (!inp) return;
      const s = inp.selectionStart, e2 = inp.selectionEnd;
      inp.value = inp.value.slice(0,s) + btn.dataset.token + inp.value.slice(e2);
      inp.focus(); _cadRefreshPrev(content);
    });
  });

  const binds = { cadColecao:'colecao', cadSetor:'setor', cadModeloRef:'modeloRef',
                  cadModeloDesc:'modeloDesc', cadNcm:'ncm', cadMarkup:'markup', cadManualPrice:'manualPrice' };
  Object.entries(binds).forEach(([id, key]) => {
    const el = content.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => { _cad[key] = el.value; _cadRefreshPrev(content); });
  });

  content.querySelectorAll('[name="cadPriceMode"]').forEach(r => {
    r.addEventListener('change', () => {
      _cad.priceMode = r.value;
      content.querySelectorAll('.cad-price-mode').forEach(l => l.classList.toggle('active', l.contains(r)));
      _cadRefreshPrev(content);
    });
  });

  content.querySelector('#cadGenerateBtn').addEventListener('click', () => {
    _cad.mapping = {};
    content.querySelectorAll('.cad-map-select').forEach(sel => { if (sel.value) _cad.mapping[sel.dataset.mx] = sel.value; });
    if (!_cad.mapping.referencia && !_cad.mapping.nome) { toast('Mapeie pelo menos Referência ou Nome', true); return; }
    if (!_cad.colecao.trim()) { toast('Campo Coleção é obrigatório', true); return; }
    _cad.products = _cadBuildProducts();
    if (!_cad.products.length) { toast('Nenhum produto encontrado com o mapeamento atual', true); return; }
    const sec = content.nextElementSibling;
    _cadRenderProdSection(sec);
    sec.style.display = '';
    sec.scrollIntoView({ behavior:'smooth', block:'start' });
  });

  _cadRefreshPrev(content);
}

function _cadRefreshPrev(content) {
  const map = {};
  content.querySelectorAll('.cad-map-select').forEach(sel => { if (sel.value) map[sel.dataset.mx] = sel.value; });
  const p = {};
  for (const [f, col] of Object.entries(map)) {
    const idx = _cad.headers.indexOf(col);
    if (idx >= 0) p[f] = String(_cad.rawRows[0]?.[idx] ?? '').trim();
  }
  const txt = (p.referencia||'') + ' ' + (p.nome||'');
  p.desc_cor = p.desc_cor || _cadExtractCor(txt);
  p.desc_tamanho = p.desc_tamanho || _cadExtractTam(txt);
  const mr = content.querySelector('#cadModeloRef')?.value  || _cad.modeloRef;
  const md = content.querySelector('#cadModeloDesc')?.value || _cad.modeloDesc;
  const rp = content.querySelector('#cadRefPrev');
  const dp = content.querySelector('#cadDescPrev');
  if (rp) rp.textContent = _cadApplyTemplate(mr, p) || '(aguardando mapeamento)';
  if (dp) dp.textContent = _cadApplyTemplate(md, p) || '(aguardando mapeamento)';
}

function _cadRenderProdSection(sec) {
  const prods = _cad.products;
  sec.innerHTML = `
    <div class="cad-section-header" style="margin-bottom:.75rem">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
      Produtos extraídos
      <span class="cad-section-sub">${prods.length} itens · Coleção: ${_escHtml(_cad.colecao)} · Setor: ${_escHtml(_cad.setor)}</span>
    </div>
    <div style="overflow-x:auto">
      <table class="trans-table">
        <thead><tr>
          <th class="trans-th" style="width:28px">#</th>
          <th class="trans-th">Referência</th>
          <th class="trans-th">Descrição (Microvix)</th>
          <th class="trans-th">Cor</th>
          <th class="trans-th">Tam.</th>
          <th class="trans-th">Custo c/ICMS</th>
          <th class="trans-th">Preço Venda</th>
          <th class="trans-th">NCM</th>
          <th class="trans-th" style="width:24px"></th>
        </tr></thead>
        <tbody>
          ${prods.map((p, i) => `<tr data-idx="${i}">
            <td class="trans-td" style="color:var(--muted);font-size:.7rem">${i+1}</td>
            <td class="trans-td"><input class="cad-ci" data-f="_ref_final"  data-i="${i}" value="${_escHtml(p._ref_final)}"></td>
            <td class="trans-td"><input class="cad-ci" data-f="_desc_final" data-i="${i}" value="${_escHtml(p._desc_final)}" style="min-width:180px"></td>
            <td class="trans-td"><input class="cad-ci cad-ci-sm" data-f="desc_cor"      data-i="${i}" value="${_escHtml(p.desc_cor)}"></td>
            <td class="trans-td"><input class="cad-ci cad-ci-sm" data-f="desc_tamanho" data-i="${i}" value="${_escHtml(p.desc_tamanho)}"></td>
            <td class="trans-td"><input class="cad-ci cad-ci-sm" data-f="_custo"        data-i="${i}" value="${_escHtml(p._custo)}"></td>
            <td class="trans-td"><input class="cad-ci cad-ci-sm" data-f="_preco"        data-i="${i}" value="${_escHtml(p._preco)}"></td>
            <td class="trans-td"><input class="cad-ci cad-ci-sm" data-f="_ncm"          data-i="${i}" value="${_escHtml(p._ncm)}"></td>
            <td class="trans-td"><button class="cad-del-btn" data-i="${i}" title="Remover">×</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="cad-prod-actions">
      <span class="cad-hint-sm">${prods.length} produtos · Linha: Unisex · UN · Mercadoria para Revenda · Contabiliza: Sim</span>
      <button class="trans-calc-btn" id="cadCheckBtn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Verificar no Microvix
      </button>
    </div>`;

  sec.querySelectorAll('.cad-ci').forEach(inp => {
    inp.addEventListener('change', () => { if (_cad.products[+inp.dataset.i]) _cad.products[+inp.dataset.i][inp.dataset.f] = inp.value; });
  });
  sec.querySelectorAll('.cad-del-btn').forEach(btn => {
    btn.addEventListener('click', () => { _cad.products.splice(+btn.dataset.i, 1); _cadRenderProdSection(sec); });
  });
  sec.querySelector('#cadCheckBtn').addEventListener('click', () => _cadCheckAndExport(sec));
}

async function _cadCheckAndExport(sec) {
  const btn = sec.querySelector('#cadCheckBtn');
  btn.disabled = true; btn.textContent = 'Verificando no Microvix…';
  sec.querySelectorAll('.cad-ci').forEach(inp => { if (_cad.products[+inp.dataset.i]) _cad.products[+inp.dataset.i][inp.dataset.f] = inp.value; });
  try {
    const rows = _cad.products.map(p => ({
      referencia:  p._ref_final  || p.referencia || '',
      nome:        p._desc_final || p.nome       || '',
      cod_barra:   p.cod_barra   || '',
      desc_marca:  p.desc_marca  || '',
      desc_setor:  _cad.setor,
      desc_cor:    p.desc_cor    || '',
      desc_tamanho: p.desc_tamanho || '',
      preco_custo:  p._custo     || '',
      preco_venda:  p._preco     || '',
      ncm:          p._ncm       || _cad.ncm,
      colecao:      _cad.colecao,
      fornecedor:   _cad.fornecedor?.nome || '',
      markup:       _cad.priceMode === 'markup' ? String(_cad.markup) : '',
    }));
    const { result, newCount, existingCount } = await apiFetch('POST', '/api/cadastro-produto/check', { rows });
    _cad.checkResult = result;

    sec.querySelectorAll('tbody tr').forEach((tr, i) => {
      const st = result[i]?._status || 'new';
      tr.style.opacity = st === 'existing' ? '.4' : '1';
      const td1 = tr.querySelector('td');
      if (td1) td1.innerHTML = `<span class="cad-badge cad-badge-${st}">${st === 'new' ? 'NOVO' : '✓'}</span>`;
    });

    const newRows = rows.filter((_, i) => result[i]?._status === 'new');
    const actEl = sec.querySelector('.cad-prod-actions');
    actEl.innerHTML = `
      <div class="cad-summary-row" style="margin:0;flex:1">
        <div class="cad-summary-card cad-summary-new" style="padding:.4rem .8rem;min-width:70px">
          <span class="cad-summary-num">${newCount}</span><span class="cad-summary-lbl">novos</span>
        </div>
        <div class="cad-summary-card cad-summary-exists" style="padding:.4rem .8rem;min-width:70px">
          <span class="cad-summary-num">${existingCount}</span><span class="cad-summary-lbl">já no Microvix</span>
        </div>
      </div>
      ${newCount > 0
        ? `<button class="trans-calc-btn" id="cadExportBtn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 16 12 21 17 16"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            Baixar cadastro Microvix (${newCount} produtos)
          </button>`
        : `<span style="color:#3FB950;font-size:.8rem">✓ Todos já estão no Microvix</span>`}`;

    const eb = actEl.querySelector('#cadExportBtn');
    if (eb) eb.addEventListener('click', () => _cadExport(eb, newRows));
  } catch (e) {
    toast('Erro: ' + e.message, true);
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Verificar no Microvix`;
  }
}

async function _cadExport(btn, rows) {
  btn.disabled = true; btn.textContent = 'Gerando…';
  try {
    const payload = rows.map(r => ({ ...r, colecao: _cad.colecao, fornecedor: _cad.fornecedor?.nome || r.fornecedor || '' }));
    const res = await fetch('/api/cadastro-produto/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: payload }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const date = new Date().toISOString().slice(0,10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `cadastro_microvix_${date}.xlsx`; a.click();
    URL.revokeObjectURL(a.href);
    toast(`Arquivo gerado com ${rows.length} produto(s)`);
  } catch (e) { toast('Erro: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = `Baixar cadastro Microvix (${rows.length} produtos)`; }
}

// ── fim CADASTRO DE PRODUTO ───────────────────────────────────────────────
