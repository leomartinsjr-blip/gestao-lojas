const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, 'public', 'app.js');
const cssPath = path.join(__dirname, 'public', 'style.css');

let app = fs.readFileSync(appPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');

const newFuncs = fs.readFileSync(path.join(__dirname, 'patch4-func.txt'), 'utf8');

let ok = true;
const check = (name, idx) => { if (idx < 0) { console.error('NOT FOUND: ' + name); ok = false; } };

// ── 1. Replace renderFuncionariosTable through saveFuncionario ────────────
const fnStart = 'function renderFuncionariosTable()';
const fnEnd   = '\nasync function deleteFuncionario';
const fnS = app.indexOf(fnStart);
const fnE = app.indexOf(fnEnd);
check('renderFuncionariosTable start', fnS);
check('deleteFuncionario anchor', fnE);
if (ok) {
  app = app.slice(0, fnS) + newFuncs + app.slice(fnE + 1); // +1 to skip leading \n
  console.log('Replaced employee form functions');
}

// ── 2. Wire funcInativo checkbox and funcFotoBtn/Input in initFuncionariosModal ──
const wireOld = "  document.getElementById('funcBoardFilter').addEventListener('change', renderFuncionariosTable);\n  document.getElementById('funcNewBtn').addEventListener('click', () => openFuncForm(null));\n  document.getElementById('funcCancelBtn').addEventListener('click', hideFuncForm);\n  document.getElementById('funcSaveBtn').addEventListener('click', saveFuncionario);";
const wireNew = `  document.getElementById('funcBoardFilter').addEventListener('change', renderFuncionariosTable);
  document.getElementById('funcShowInativo').addEventListener('change', renderFuncionariosTable);
  document.getElementById('funcNewBtn').addEventListener('click', () => openFuncForm(null));
  document.getElementById('funcCancelBtn').addEventListener('click', hideFuncForm);
  document.getElementById('funcSaveBtn').addEventListener('click', saveFuncionario);
  document.getElementById('funcFotoBtn').addEventListener('click', () => document.getElementById('funcFotoInput').click());
  document.getElementById('funcFotoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    FE.newPhotoFile = file;
    _updateFotoPreview(null);
  });
  document.getElementById('funcFotoRemove').addEventListener('click', () => {
    FE.newPhotoFile = null;
    FE.currentPhotoUrl = null;
    document.getElementById('funcFotoInput').value = '';
    _updateFotoPreview(null);
  });
  document.getElementById('funcInativo').addEventListener('change', e => {
    document.getElementById('funcDesligamentoWrap').style.display = e.target.checked ? '' : 'none';
    _updateFotoPreview(null);
  });`;
check('wire anchor', app.indexOf(wireOld));
if (ok) {
  app = app.replace(wireOld, wireNew);
  console.log('Wired new form event listeners');
}

// ── 3. PA prize rule: only if hitMeta too ─────────────────────────────────
const paOld = '  const pPA     = isComplete ? (hitPA   ? PREMIO_PA    : 0) : null;';
const paNew = '  const pPA     = isComplete ? (hitMeta && hitPA ? PREMIO_PA : 0) : null;';
check('pPA line', app.indexOf(paOld));
if (ok) {
  app = app.replace(paOld, paNew);
  console.log('Updated PA prize rule');
}

if (!ok) { console.error('Patch FAILED'); process.exit(1); }

fs.writeFileSync(appPath, app, 'utf8');
console.log('app.js patched OK');

// ── 4. Append CSS ─────────────────────────────────────────────────────────
const newCss = `
/* ── Func avatar ───────────────────────────────────────────────────────── */
.func-avatar-img { border-radius: 50%; object-fit: cover; display: block; }
.func-avatar-ini { border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.func-td-avatar { padding: .3rem .5rem; }

/* ── Func photo picker ─────────────────────────────────────────────────── */
.func-field-photo-row { grid-column: 1 / -1; display: flex; align-items: center; gap: 1rem; padding: .5rem 0 .75rem; border-bottom: 1px solid var(--border); margin-bottom: .25rem; }
.func-photo-preview { width: 72px; height: 72px; border-radius: 50%; border: 2px solid var(--border); background: var(--surface2); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.func-photo-preview img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.func-photo-preview .func-avatar-ini { width: 72px; height: 72px; font-size: 1.4rem; border-radius: 50%; }
.func-photo-info { display: flex; flex-direction: column; gap: .35rem; }
.func-photo-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: .4rem; padding: .3rem .75rem; font-size: .78rem; cursor: pointer; transition: background .15s; }
.func-photo-btn:hover { background: #1e2430; border-color: #58A6FF; color: #fff; }
.func-photo-remove { background: transparent; border: 1px solid rgba(248,113,113,.4); color: #f87171; border-radius: .4rem; padding: .25rem .6rem; font-size: .74rem; cursor: pointer; }
.func-photo-remove:hover { background: rgba(248,113,113,.12); }
.func-photo-hint { font-size: .68rem; color: var(--text2); }

/* ── Func status badges ─────────────────────────────────────────────────── */
.func-badge-ativo   { background: rgba(59,185,80,.18); color: #3FB950; border: 1px solid rgba(59,185,80,.35); }
.func-badge-inativo { background: rgba(139,148,158,.12); color: #8B949E; border: 1px solid rgba(139,148,158,.3); }
.func-row-inativo td { opacity: .6; }

/* ── Func toolbar extras ────────────────────────────────────────────────── */
.func-inativo-toggle { display: flex; align-items: center; gap: .35rem; font-size: .78rem; color: var(--text2); cursor: pointer; user-select: none; }
.func-inativo-toggle input { cursor: pointer; }
`;
if (!css.includes('.func-avatar-img')) {
  fs.writeFileSync(cssPath, css + newCss, 'utf8');
  console.log('style.css patched OK');
} else {
  console.log('CSS already present');
}
