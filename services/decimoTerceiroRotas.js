'use strict';
const ExcelJS = require('exceljs');
const d13 = require('./decimoTerceiro');

exports.register = function (app, { requireAdmin, readDB, writeDB, boardsLabel }) {
  const anoDe = req => {
    const a = Number(req.params.year);
    return Number.isInteger(a) && a >= 2020 && a <= 2100 ? a : null;
  };
  const doAno = (db, ano) => (db.decimoTerceiro || {})[ano] || {};

  app.get('/api/decimo/:year', requireAdmin, async (req, res) => {
    try {
      const ano = anoDe(req);
      if (!ano) return res.status(400).json({ error: 'Ano inválido' });
      const db = await readDB();
      const pessoas = d13.colaboradores(db, ano).map(e => ({
        id: e.id, name: e.name, apelido: e.apelido || '', cargo: e.cargo || '', board: e.board,
        admissao: e.admissao || '', admissaoContrato: e.admissaoContrato || '', desligamento: e.desligamento || '',
        inssRate: Number(((db.folhaEmpConfig || {})[e.id] || {}).inssRate ?? e.inssRate) || 0,
        sugestao: Object.fromEntries(d13.PARCELAS.map(p => [p, {
          avos: d13.avosDe(e, ano, p), media: d13.mediaProventos(db.folhas, e, ano, p),
        }])),
      }));
      const { entries = {}, encerradas = {} } = doAno(db, ano);
      res.json({ ano, pessoas, entries, encerradas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Grava uma parcela de uma loja. Encerrada só aceita a reabertura explícita.
  // body: { entries: { [empId]: {...} | null }, encerrada?: bool }
  app.post('/api/decimo/:year/:board/:parcela', requireAdmin, async (req, res) => {
    try {
      const ano = anoDe(req);
      const { board, parcela } = req.params;
      if (!ano) return res.status(400).json({ error: 'Ano inválido' });
      if (!Object.hasOwn(boardsLabel, board)) return res.status(400).json({ error: 'Loja inválida' });
      if (!d13.PARCELAS.includes(parcela)) return res.status(400).json({ error: 'Parcela inválida' });
      const db = await readDB();
      const atual = doAno(db, ano);
      const entries = { ...(atual.entries || {}) };
      const enc = req.body?.encerrada;
      if (atual.encerradas?.[board]?.[parcela] && enc !== false)
        return res.status(409).json({ error: 'Parcela encerrada — reabra antes de alterar' });
      const validos = new Map(d13.colaboradores(db, ano).map(e => [String(e.id), e]));
      for (const [id, bruto] of Object.entries(req.body?.entries || {})) {
        const emp = validos.get(id);
        if (!emp) continue;
        if ((entries[id]?.[parcela]?.board || emp.board) !== board) continue;
        if (bruto === null) {
          const { [parcela]: _, ...resto } = entries[id] || {};
          if (Object.keys(resto).length) entries[id] = resto; else delete entries[id];
          continue;
        }
        const { erro, dados } = d13.limparParcela(parcela, bruto, board);
        if (erro) return res.status(400).json({ error: `${emp.apelido || emp.name}: ${erro}` });
        entries[id] = { ...entries[id], [parcela]: dados };
      }
      const encerradas = { ...(atual.encerradas || {}) };
      if (typeof enc === 'boolean') encerradas[board] = { ...encerradas[board], [parcela]: enc };
      db.decimoTerceiro = { ...(db.decimoTerceiro || {}), [ano]: {
        entries, encerradas, at: new Date().toISOString(), por: req.session.user?.username || '' } };
      await writeDB(db, { caminhos: new Set(['decimoTerceiro']) });
      res.json({ entries, encerradas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Planilha da parcela: uma aba por loja (ou só a pedida)
  app.get('/api/decimo/:year/:parcela/export', requireAdmin, async (req, res) => {
    try {
      const ano = anoDe(req);
      const { parcela } = req.params;
      if (!ano || !d13.PARCELAS.includes(parcela)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const board = req.query.board;
      if (board && !Object.hasOwn(boardsLabel, board)) return res.status(400).json({ error: 'Loja inválida' });
      const db = await readDB();
      const { entries = {} } = doAno(db, ano);
      const pessoas = d13.colaboradores(db, ano);
      const wb = new ExcelJS.Workbook();
      const br = s => s ? s.split('-').reverse().join('/') : '';
      for (const bk of board ? [board] : Object.keys(boardsLabel)) {
        const linhas = pessoas.filter(e => entries[e.id]?.[parcela]?.board === bk);
        if (!linhas.length && !board) continue;
        const ws = wb.addWorksheet((boardsLabel[bk] || bk).substring(0, 31));
        ws.addRow([`13º SALÁRIO ${ano} — ${parcela === 'p1' ? '1ª PARCELA (NOVEMBRO)' : '2ª PARCELA (DEZEMBRO)'} — ${boardsLabel[bk]}`]).font = { bold: true, size: 12 };
        ws.addRow([]);
        const cab = parcela === 'p1'
          ? ['FUNCIONÁRIO', 'CARGO', 'ADMISSÃO', 'BANCO', 'CONTA', 'BASE', 'AVOS', '1ª PARCELA', 'PAGO EM']
          : ['FUNCIONÁRIO', 'CARGO', 'ADMISSÃO', 'BANCO', 'CONTA', 'BASE', 'AVOS', '13º BRUTO', '1ª PARCELA', 'INSS', 'IRRF', 'OUTROS DESC.', 'LÍQUIDO 2ª', 'PAGO EM'];
        ws.addRow(cab).font = { bold: true };
        const ini = ws.rowCount + 1;
        for (const e of linhas) {
          const l = entries[e.id][parcela], p1 = entries[e.id].p1;
          const id = [e.name, e.cargo || '', br(e.admissaoContrato || e.admissao), e.banco || '', e.conta || '', d13.r2(l.base), l.avos];
          ws.addRow(parcela === 'p1'
            ? [...id, d13.r2(l.valor), br(l.pagoEm)]
            : [...id, d13.r2(l.bruto), d13.r2(p1?.valor), d13.r2(l.inss), d13.r2(l.irrf), d13.r2(l.outros), d13.totalParcela('p2', l, p1), br(l.pagoEm)]);
        }
        const fim = ws.rowCount;
        const cols = parcela === 'p1' ? [8] : [8, 9, 10, 11, 12, 13];
        if (linhas.length) {
          const tot = ws.addRow(['TOTAL']);
          tot.font = { bold: true };
          for (const c of cols) {
            const L = ws.getColumn(c).letter;
            let soma = 0;
            for (let i = ini; i <= fim; i++) soma += ws.getCell(i, c).value || 0;
            tot.getCell(c).value = { formula: `SUM(${L}${ini}:${L}${fim})`, result: d13.r2(soma) };
          }
        }
        cab.forEach((_, i) => { ws.getColumn(i + 1).width = i === 0 ? 34 : 15; });
        for (const c of [6, ...cols]) ws.getColumn(c).numFmt = '#,##0.00';
      }
      if (!wb.worksheets.length) wb.addWorksheet('Sem lançamentos');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="decimo-terceiro-${ano}-${parcela}${board ? '-' + board : ''}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
