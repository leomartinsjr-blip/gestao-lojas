const fs = require('fs');
const db = JSON.parse(fs.readFileSync('data.json', 'utf8'));

const key = '2026-05-delrey-253';
if (!db.vsales) db.vsales = {};
if (!db.vsales[key]) db.vsales[key] = { meta: { mensal: 0 }, entries: {} };

const entries = {
  '2026-05-01': { value: 5293.80, pecas: 17, atendimentos: 11 },
  '2026-05-02': { value: 1757.80, pecas:  4, atendimentos:  3 },
  '2026-05-03': { value: 2059.40, pecas:  8, atendimentos:  6 },
  '2026-05-05': { value: 1632.50, pecas:  7, atendimentos:  4 },
  '2026-05-06': { value:  559.80, pecas:  2, atendimentos:  2 },
  '2026-05-07': { value: 2147.30, pecas:  8, atendimentos:  6 },
  '2026-05-08': { value: 2694.10, pecas: 11, atendimentos: 10 },
  '2026-05-09': { value: 6028.30, pecas: 21, atendimentos: 13 },
  '2026-05-10': { value: 2254.10, pecas: 11, atendimentos:  7 },
  '2026-05-11': { value: 1719.70, pecas:  5, atendimentos:  3 },
  '2026-05-13': { value:  299.90, pecas:  1, atendimentos:  1 },
  '2026-05-14': { value: 1879.20, pecas: 10, atendimentos:  6 },
  '2026-05-15': { value:  689.70, pecas:  3, atendimentos:  2 },
  '2026-05-16': { value: 3496.00, pecas: 11, atendimentos:  8 },
  '2026-05-18': { value:  739.50, pecas:  4, atendimentos:  4 },
};

db.vsales[key].entries = { ...db.vsales[key].entries, ...entries };
fs.writeFileSync('data.json', JSON.stringify(db, null, 2), 'utf8');

const total = Object.values(entries).reduce((s, e) => s + e.value, 0);
console.log(`Saved ${Object.keys(entries).length} entries for Bruno`);
console.log(`Total valor: R$ ${total.toFixed(2)}`);
