const fs = require('fs');
const path = require('path');

const base = __dirname;
const appPath  = path.join(base, 'public', 'app.js');
const cssPath  = path.join(base, 'public', 'style.css');

let app = fs.readFileSync(appPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');

const weekCard  = fs.readFileSync(path.join(base, 'patch3-weekcard.txt'),  'utf8');
const functions = fs.readFileSync(path.join(base, 'patch3-functions.txt'), 'utf8');
const rightCol  = fs.readFileSync(path.join(base, 'patch3-rightcol.txt'),  'utf8');
const styles    = fs.readFileSync(path.join(base, 'patch3-styles.txt'),    'utf8');

let ok = true;
const check = (name, idx) => { if (idx < 0) { console.error('NOT FOUND: ' + name); ok = false; } };

// ── 1. Add DASH_WEEK state ────────────────────────────────────────────────
if (!app.includes('let DASH_WEEK')) {
  app = app.replace(
    'let WK = { refDate: null, cache: {} };',
    'let WK = { refDate: null, cache: {} };\nlet DASH_WEEK = { refDate: null };'
  );
  console.log('Added DASH_WEEK');
} else {
  console.log('DASH_WEEK already present');
}

// ── 2. Remove standalone `const week` from renderDashboard ───────────────
const rmWeek = '\n  const week = getWeekForDate(todayStr);\n';
if (app.includes(rmWeek)) {
  app = app.replace(rmWeek, '\n');
  console.log('Removed standalone week computation');
}

// ── 3. Replace weekly card section ───────────────────────────────────────
// anchor: right after `leftBody.appendChild(table);`
// to just before: `  const rightCol = document.createElement`
const wkStartA = 'leftBody.appendChild(table);';
const wkEndA   = "\n  const rightCol = document.createElement('div');";
const wkS = app.indexOf(wkStartA);
const wkE = app.indexOf(wkEndA);
check('weekCard start anchor', wkS);
check('weekCard end anchor', wkE);
if (ok) {
  app = app.slice(0, wkS + wkStartA.length) + '\n\n' + weekCard + app.slice(wkE);
  console.log('Replaced weekly card section');
}

// ── 4. Add comparison card to right column ────────────────────────────────
const rcOld = "  rightCol.appendChild(folgasCard);\n  _renderDashFolgas(folgasCard.querySelector('#dashFolgasBody'));\n}";
check('rightCol end', app.indexOf(rcOld));
if (ok) {
  app = app.replace(rcOld, rightCol);
  console.log('Added comparison card to right column');
}

// ── 5. Replace _renderDashFolgas + add new functions ─────────────────────
const fnStart = 'function _renderDashFolgas(body) {';
const fnEnd   = 'async function refreshPicker()';
const fnS = app.indexOf(fnStart);
const fnE = app.indexOf(fnEnd);
check('_renderDashFolgas start', fnS);
check('refreshPicker anchor', fnE);
if (ok) {
  app = app.slice(0, fnS) + functions + '\n\n' + app.slice(fnE);
  console.log('Replaced _renderDashFolgas + added new functions');
}

if (!ok) {
  console.error('\nPatch FAILED — see errors above. No files written.');
  process.exit(1);
}

fs.writeFileSync(appPath, app, 'utf8');
console.log('\napp.js patched OK');

// ── 6. Append CSS ─────────────────────────────────────────────────────────
if (!css.includes('.dash-wk-nav')) {
  fs.writeFileSync(cssPath, css + '\n' + styles, 'utf8');
  console.log('style.css patched OK');
} else {
  console.log('CSS already present, skipping');
}
