const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, 'public', 'app.js');
const cssPath = path.join(__dirname, 'public', 'style.css');

let app = fs.readFileSync(appPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');

let ok = true;
const check = (name, idx) => { if (idx < 0) { console.error('NOT FOUND: ' + name); ok = false; } };

// ── 1. Replace monthly table section ─────────────────────────────────────────
const tableOld = `  // Monthly table
  const table = document.createElement('table');
  table.className = 'dash-table';
  table.innerHTML = \`<thead>
    <tr class="dash-thead-tr">
      <th class="dash-th">Vendedor</th>
      <th class="dash-th dash-th-r">Meta Mês</th>
      <th class="dash-th dash-th-r">Realizado</th>
      <th class="dash-th dash-th-r">% Meta</th>
      <th class="dash-th dash-th-r">Projeção</th>
      <th class="dash-th dash-th-r">PA</th>
      <th class="dash-th dash-th-r">TM</th>
    </tr>
  </thead>\`;
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  for (const [bk, bc] of visible) {
    const emps = byBoard[bk] || [];
    if (emps.length === 0) continue;

    const storeRow = document.createElement('tr');
    storeRow.className = 'dash-store-hdr';
    storeRow.innerHTML = \`<td colspan="7" class="dash-store-hdr-td">
      <span class="dash-store-dot" style="background:\${bc.color}"></span>\${bc.label}
    </td>\`;
    tbody.appendChild(storeRow);

    let totValor=0, totPecas=0, totAtend=0, totMeta=0;

    for (const emp of emps) {
      const vsale   = S.vsales[emp.id] || { meta: { mensal: 0 }, entries: {} };
      const mensal  = vsale.meta?.mensal || 0;
      const entries = vsale.entries || {};

      let valor = 0, pecas = 0, atend = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = \`\${S.year}-\${pad(S.month)}-\${pad(d)}\`;
        if (ds > yStr) break;
        const e = entries[ds];
        if (e) { valor += e.value||0; pecas += e.pecas||0; atend += e.atendimentos||0; }
      }

      const metaAccum = mensal * weightAccum / 100;
      const pctMeta   = (metaAccum > 0 && valor > 0) ? valor / metaAccum * 100 : null;
      const projecao  = (valor > 0 && metaAccum > 0) ? valor / metaAccum * mensal : null;
      const pa        = (pecas > 0 && atend > 0) ? pecas / atend : null;
      const tm        = (valor > 0 && atend > 0) ? valor / atend : null;

      totValor += valor; totPecas += pecas; totAtend += atend; totMeta += mensal;

      const pctCls  = pctMeta  == null ? '' : pctMeta  >= 100 ? 'kpi-pos' : pctMeta  >= 80 ? 'kpi-warn' : 'kpi-neg';
      const projCls = projecao == null ? '' : projecao >= mensal ? 'kpi-pos' : projecao >= mensal*0.9 ? 'kpi-warn' : 'kpi-neg';

      const row = document.createElement('tr');
      row.className = 'dash-row';
      row.innerHTML = \`
        <td class="dash-td dash-td-name">\${emp.name}</td>
        <td class="dash-td dash-td-num">\${fBRL(mensal || null)}</td>
        <td class="dash-td dash-td-num">\${fBRL(valor || null)}</td>
        <td class="dash-td dash-td-num \${pctCls}">\${fPct(pctMeta)}</td>
        <td class="dash-td dash-td-num \${projCls}">\${fBRL(projecao)}</td>
        <td class="dash-td dash-td-num">\${fDec(pa)}</td>
        <td class="dash-td dash-td-num">\${fBRL(tm)}</td>
      \`;
      tbody.appendChild(row);
    }

    const totMetaAccum = totMeta * weightAccum / 100;
    const totPct  = (totMetaAccum > 0 && totValor > 0) ? totValor / totMetaAccum * 100 : null;
    const totProj = (totValor > 0 && totMetaAccum > 0) ? totValor / totMetaAccum * totMeta : null;
    const totPa   = (totPecas > 0 && totAtend > 0) ? totPecas / totAtend : null;
    const totTm   = (totValor > 0 && totAtend > 0) ? totValor / totAtend : null;
    const tpCls   = totPct  == null ? '' : totPct  >= 100 ? 'kpi-pos' : totPct  >= 80 ? 'kpi-warn' : 'kpi-neg';
    const tprCls  = totProj == null ? '' : totProj >= totMeta ? 'kpi-pos' : totProj >= totMeta*0.9 ? 'kpi-warn' : 'kpi-neg';

    const totalRow = document.createElement('tr');
    totalRow.className = 'dash-total-row';
    totalRow.innerHTML = \`
      <td class="dash-td">Total \${bc.label}</td>
      <td class="dash-td dash-td-num">\${fBRL(totMeta || null)}</td>
      <td class="dash-td dash-td-num">\${fBRL(totValor || null)}</td>
      <td class="dash-td dash-td-num \${tpCls}">\${fPct(totPct)}</td>
      <td class="dash-td dash-td-num \${tprCls}">\${fBRL(totProj)}</td>
      <td class="dash-td dash-td-num">\${totPa != null ? totPa.toFixed(2) : '—'}</td>
      <td class="dash-td dash-td-num">\${fBRL(totTm)}</td>
    \`;
    tbody.appendChild(totalRow);
  }

  leftBody.appendChild(table);`;

const tableNew = fs.readFileSync(path.join(__dirname, 'patch5-table.txt'), 'utf8').trimEnd();

check('monthly table old block', app.indexOf(tableOld));
if (ok) {
  app = app.replace(tableOld, tableNew);
  console.log('Replaced monthly table with sortable version');
}

// ── 2. Replace _renderDashFolgas with compact list-style ─────────────────────
const folgasOld = `function _renderDashFolgas(body) {
  const pad = n => String(n).padStart(2,'0');
  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const firstDay = new Date(S.year, S.month - 1, 1).getDay();

  const fByDate = {};
  for (const f of S.folgas) {
    if (!fByDate[f.date]) fByDate[f.date] = [];
    fByDate[f.date].push(f.employeeId);
  }

  const empMap = {};
  for (const emp of S.employees) empMap[emp.id] = emp;

  const DAYS_SHORT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  let html = '<div class="folga-cal">';
  html += '<div class="folga-cal-row folga-cal-hdr">';
  for (const d of DAYS_SHORT) html += \`<div class="folga-cal-dname">\${d}</div>\`;
  html += '</div>';

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  for (let i = 0; i < cells.length; i += 7) {
    html += '<div class="folga-cal-row">';
    for (let j = 0; j < 7; j++) {
      const day = cells[i + j];
      if (!day) { html += '<div class="folga-cal-cell folga-cal-empty"></div>'; continue; }
      const ds = \`\${S.year}-\${pad(S.month)}-\${pad(day)}\`;
      const empIds = fByDate[ds] || [];
      const hasFolga = empIds.length > 0;
      const dots = empIds.map(id => {
        const emp = empMap[id];
        if (!emp) return '';
        const initials = emp.name.split(' ').map(w => w[0]).slice(0,2).join('');
        const color = BOARDS[emp.board]?.color || '#64748b';
        return \`<span class="folga-cal-dot" style="background:\${color}" title="\${emp.name}">\${initials}</span>\`;
      }).join('');
      html += \`<div class="folga-cal-cell\${hasFolga ? ' folga-cal-has-folga' : ''}"><span class="folga-cal-daynum">\${day}</span>\${hasFolga ? \`<div class="folga-cal-dots">\${dots}</div>\` : ''}</div>\`;
    }
    html += '</div>';
  }
  html += '</div>';
  body.innerHTML = html;
}`;

const folgasNew = `function _renderDashFolgas(body) {
  const pad = n => String(n).padStart(2,'0');
  const daysInMonth = new Date(S.year, S.month, 0).getDate();
  const DAY_SHORT = ['D','S','T','Q','Q','S','S'];

  const empMap = {};
  for (const emp of S.employees) empMap[emp.id] = emp;

  // Build per-employee folga set for this month
  const empFolgas = {};
  for (const f of S.folgas) {
    if (!f.date.startsWith(\`\${S.year}-\${pad(S.month)}\`)) continue;
    const day = parseInt(f.date.split('-')[2]);
    if (!empFolgas[f.employeeId]) empFolgas[f.employeeId] = new Set();
    empFolgas[f.employeeId].add(day);
  }

  const empsWithFolga = S.employees.filter(e => empFolgas[e.id]);
  if (empsWithFolga.length === 0) {
    body.innerHTML = '<div class="folga-mini-empty">Sem folgas programadas</div>';
    return;
  }

  // Table: employees as rows, days as columns
  let html = '<div class="folga-mini-wrap"><table class="folga-mini-tbl"><thead><tr><th class="folga-mini-name-h"></th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(S.year, S.month - 1, d).getDay();
    const isWE = dow === 0 || dow === 6;
    html += \`<th class="folga-mini-day-h\${isWE ? ' folga-mini-we' : ''}">\${d}<br><span class="folga-mini-dow">\${DAY_SHORT[dow]}</span></th>\`;
  }
  html += '</tr></thead><tbody>';

  for (const emp of empsWithFolga) {
    const color = BOARDS[emp.board]?.color || '#64748b';
    const fDays = empFolgas[emp.id];
    html += \`<tr><td class="folga-mini-name"><span class="folga-mini-dot" style="background:\${color}"></span>\${emp.apelido || emp.name.split(' ')[0]}</td>\`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(S.year, S.month - 1, d).getDay();
      const isWE = dow === 0 || dow === 6;
      const has = fDays.has(d);
      html += \`<td class="folga-mini-cell\${isWE ? ' folga-mini-we' : ''}\${has ? ' folga-mini-on' : ''}" \${has ? \`style="background:\${color}22;"\` : ''}>\${has ? \`<span class="folga-mini-mark" style="background:\${color}"></span>\` : ''}</td>\`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  body.innerHTML = html;
}`;

check('_renderDashFolgas old', app.indexOf(folgasOld));
if (ok) {
  app = app.replace(folgasOld, folgasNew);
  console.log('Replaced _renderDashFolgas with compact table version');
}

if (!ok) { console.error('Patch FAILED'); process.exit(1); }

fs.writeFileSync(appPath, app, 'utf8');
console.log('app.js patched OK');

// ── 3. Append CSS ─────────────────────────────────────────────────────────────
const newCss = `
/* ── Sort arrows (monthly table) ─────────────────────────────────────────── */
.dash-th-sort { cursor: pointer; user-select: none; }
.dash-th-sort:hover { background: rgba(255,255,255,.05); }
.sort-arr { font-size: .6rem; margin-left: .2rem; opacity: .35; }
.sort-arr-on { opacity: 1; color: #58A6FF; }

/* ── Folga mini table (dashboard card) ───────────────────────────────────── */
.folga-mini-wrap { overflow-x: auto; }
.folga-mini-tbl { border-collapse: collapse; font-size: .7rem; white-space: nowrap; width: 100%; }
.folga-mini-name-h { min-width: 80px; }
.folga-mini-day-h { text-align: center; padding: .1rem .15rem; font-weight: 600; color: var(--text2); min-width: 18px; line-height: 1.2; }
.folga-mini-dow { font-size: .55rem; font-weight: 400; }
.folga-mini-we { opacity: .5; }
.folga-mini-name { padding: .2rem .4rem .2rem .2rem; color: var(--text); white-space: nowrap; display: flex; align-items: center; gap: .3rem; }
.folga-mini-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.folga-mini-cell { text-align: center; padding: .1rem; border-radius: 2px; }
.folga-mini-on { }
.folga-mini-mark { display: block; width: 8px; height: 8px; border-radius: 50%; margin: 0 auto; }
.folga-mini-empty { color: var(--text2); font-size: .8rem; padding: .5rem 0; text-align: center; }
`;

if (!css.includes('.dash-th-sort')) {
  fs.writeFileSync(cssPath, css + newCss, 'utf8');
  console.log('style.css patched OK');
} else {
  console.log('CSS already present');
}
