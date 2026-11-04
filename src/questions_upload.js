/* ---------- questions and answer key (CSV upload, invigilator only) ---------- */
const Q_COLS = ['level', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f', 'answer'];
const Q_LETTERS = 'ABCDEF';
// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks
function parseCsv(text){
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){ if (c === '"'){ if (text[i+1] === '"'){ f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ','){ row.push(f); f = ''; }
    else if (c === '\n' || c === '\r'){ if (c === '\r' && text[i+1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
// rows: the sheet as arrays of cells, first row = column titles. Returns {qs, answers, errs, format};
// format is true when the problem is the file's layout (the template is offered then).
// Questions keep the file's order (the exam shuffles within each level).
function readQuestions(rows){
  const errs = [];
  rows = rows.map(r => r.map(c => c == null ? '' : String(c))).filter(r => r.some(x => x.trim() !== ''));
  if (!rows.length) return {errs: ['The file is empty.'], format: true};
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const at = {}; Q_COLS.forEach(c => at[c] = head.indexOf(c));
  const missing = ['level', 'question', 'option_a', 'option_b', 'answer'].filter(c => at[c] < 0);
  if (missing.length) return {format: true, errs: ['This file isn\'t in the right layout. The first row must have these column titles: ' + Q_COLS.join(', ') + '. Missing: ' + missing.join(', ') + '. Download the template below and copy your questions into it.']};
  const qs = [], answers = [];
  rows.slice(1).forEach((r, k) => {
    const line = k + 2, get = c => at[c] >= 0 ? String(r[at[c]] || '').trim().replace(/^'(?=[=+\-@])/, '') : '';
    const lv = get('level').toLowerCase(), level = LV.find(l => l.toLowerCase() === lv);
    const q = get('question');
    const opts = ['a','b','c','d','e','f'].map(x => get('option_' + x));
    const last = opts.reduce((m, o, i) => o ? i : m, -1), o = opts.slice(0, last + 1);
    const ans = get('answer').toUpperCase(), ai = Q_LETTERS.indexOf(ans);
    const bad = [];
    if (!level) bad.push('level must be Easy, Medium or Hard');
    if (!q) bad.push('question is empty');
    if (o.length < 2) bad.push('needs at least options A and B');
    else if (o.some(x => !x)) bad.push('options must be filled in order with no gaps (option ' + Q_LETTERS[o.indexOf('')] + ' is empty)');
    if (ans.length !== 1 || ai < 0) bad.push('answer must be one letter A to F');
    else if (ai >= o.length) bad.push('answer ' + ans + ' points to an empty option');
    if (bad.length) errs.push('Row ' + line + ': ' + bad.join('; ') + '.');
    else { qs.push({l: level, q, o}); answers.push(ai); }
  });
  if (!errs.length && !qs.length) return {format: true, errs: ['The file has column titles but no questions under them.']};
  return {qs, answers, errs};
}
let qPending = null;
function paintQs(){
  if (!isAdmin) return;
  const lc = lvCount();
  $('qCount').textContent = N ? '· ' + N + ' (Easy ' + lc.e + ', Medium ' + lc.m + ', Hard ' + lc.h + ')' + (key ? '' : ' · no key') : '· none yet';
  $('qFile').disabled = $('qClear').disabled = eff() === 'live';
}
function qReset(){ $('qTpl').hidden = true; qPending = null; $('qFile').value = ''; $('qErrBox').hidden = true; $('qOkBox').hidden = true; }
$('qFile').onchange = async () => {
  const f = $('qFile').files[0]; $('qErrBox').hidden = true; $('qOkBox').hidden = true; qPending = null;
  if (!f) return;
  const fail = (title, format) => { $('qErrT').textContent = title; $('qErrs').innerHTML = ''; $('qTpl').hidden = !format; $('qErrBox').hidden = false; };
  if (!/\.(xlsx|xls|csv)$/i.test(f.name)) return fail('Choose an Excel file (.xlsx). The file you picked isn\'t a spreadsheet. Download the template below and fill it in.', true);
  let rows;
  try {
    if (/\.csv$/i.test(f.name)) rows = parseCsv(await f.text());
    else {
      await loadLib(LIB_XLSX);
      const wb = XLSX.read(await f.arrayBuffer(), {type: 'array'});
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: false, defval: '', blankrows: false});
    }
  } catch(e){ return fail(e && e.message === 'load' ? 'Could not open the file reader. Check your internet connection and choose the file again.' : 'This file could not be opened. Save it again in Excel as .xlsx, or download the template below and copy your questions into it.', !(e && e.message === 'load')); }
  const r = readQuestions(rows);
  if (r.errs.length){
    $('qTpl').hidden = !r.format;
    $('qErrT').textContent = 'Nothing was saved. Fix ' + (r.errs.length === 1 ? 'this problem' : 'these ' + r.errs.length + ' problems') + ' and upload again:';
    $('qErrs').innerHTML = r.errs.slice(0, 15).map(e => '<li>' + esc(e) + '</li>').join('') + (r.errs.length > 15 ? '<li>…and ' + (r.errs.length - 15) + ' more.</li>' : '');
    $('qErrBox').hidden = false; return;
  }
  qPending = r;
  const c = l => r.qs.filter(q => q.l === l).length;
  const old = results.filter(x => (x.track || 'pharmacist') === TR).length;
  $('qOkT').textContent = f.name + ': ' + r.qs.length + ' questions (Easy ' + c('Easy') + ', Medium ' + c('Medium') + ', Hard ' + c('Hard') + '), each with a correct answer. Saving replaces the current ' + (N || 'no') + ' questions.'
    + (old ? ' ' + old + ' saved result' + (old > 1 ? 's' : '') + ' will be re-marked with these new answers. If this is a completely new set of questions, clear the old results first.' : '');
  $('qOkBox').hidden = false; $('qSave').focus();
};
$('qCancel').onclick = qReset;
$('qSave').onclick = async () => {
  if (!qPending) return;
  if (eff() === 'live'){ $('qErrT').textContent = 'End the exam before changing its questions.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; return; }
  const b = $('qSave'), r = qPending; b.disabled = true; b.textContent = 'Saving…';
  try {
    await db.doc('questions/' + TR).set({qs: r.qs, updatedAt: Date.now()});
    await db.doc(T.key).set({answers: r.answers});
    setQs(TR, r.qs); qReset(); paintAdmin(); paintQs(); paintQList();
    msg(r.qs.length + ' questions saved for the ' + T.name + '.');
  } catch(e){ $('qErrT').textContent = 'Could not save the questions: ' + errText(e) + '. Try again.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; }
  b.disabled = false; b.textContent = 'Save questions';
};
async function qDownload(filename, rows){
  try {
    await loadLib(LIB_XLSX);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [10, 60, 24, 24, 24, 24, 18, 18, 8].map(w => ({wch: w}));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    const d = await claude.use('downloads'); await d.save({filename, data: XLSX.write(wb, {type: 'array', bookType: 'xlsx'})});
  } catch(e){ msg(e && e.message === 'load' ? 'Could not prepare the file. Check your internet connection and try again.' : 'The download is not available in this view.'); }
}
$('qTpl').onclick = () => qDownload('questions_template.xlsx', [Q_COLS,
  ['Easy', 'Example: which of these is a fruit?', 'Carrot', 'Apple', 'Potato', 'Onion', '', '', 'B'],
  ['Medium', 'Example: how many minutes are in 2 hours?', '60', '90', '120', '150', '', '', 'C'],
  ['Hard', 'Example: a question with a comma, "quotes" and only three options?', 'First option', 'Second option', 'Third option', '', '', '', 'A']]);
$('qExport').onclick = () => {
  if (!N){ msg('There are no questions to download yet.'); return; }
  const k = key && key.answers;
  qDownload(TR + '_questions.xlsx', [Q_COLS].concat(QS.map((q, i) => [q.l, q.q].concat([0,1,2,3,4,5].map(j => q.o[j] || ''), [k && k[i] >= 0 ? Q_LETTERS[k[i]] : '']))));
};
// question viewer: every question with its options, the correct one marked from the stored key
let qLvF = '', qOpen = false;
function paintQList(){
  if (!qOpen) return;
  const k = key && key.answers, s = $('qSearch').value.trim().toLowerCase();
  const shown = QS.map((q, i) => ({q, i})).filter(({q}) => (!qLvF || q.l === qLvF) && (!s || (q.q + ' ' + q.o.join(' ')).toLowerCase().includes(s)));
  $('qDlgT').textContent = 'Questions and answers · ' + T.name;
  $('qListNote').textContent = !N ? 'No questions yet. Add them using the template.' : 'Showing ' + shown.length + ' of ' + N + ' questions in upload order.' + (k ? '' : ' The correct answers are not saved, so none are marked.');
  $('qItems').innerHTML = shown.map(({q, i}) => '<li><div class="qh"><span class="qn">' + (i + 1) + '.</span><span class="qt">' + esc(q.q) + '</span><span class="lv">' + esc(q.l) + '</span></div><ul>'
    + q.o.map((o, j) => '<li' + (k && k[i] === j ? ' class="ok"' : '') + '><b>' + Q_LETTERS[j] + '</b><span>' + esc(o) + '</span></li>').join('') + '</ul></li>').join('');
}
function qOpenDlg(){ qOpen = true; paintQList(); document.body.classList.add('dlg-open'); $('qDlg').showModal(); $('qSearch').focus(); }
$('qView').onclick = qOpenDlg;
$('qClose').onclick = () => $('qDlg').close();
$('qDlg').addEventListener('close', () => { qOpen = false; document.body.classList.remove('dlg-open'); $('qView').focus(); });
$('qDlg').addEventListener('click', ev => { if (ev.target === $('qDlg')) $('qDlg').close(); });   // click outside the box closes it
$('qSearch').oninput = paintQList;
document.querySelectorAll('#qLv button').forEach(b => b.onclick = () => { qLvF = b.dataset.lv; document.querySelectorAll('#qLv button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paintQList(); });
// clear the question set: two steps (confirm, then type CLEAR). Saves an empty set so the built-in questions don't come back.
let qClrStep = 0;
function qClrPaint(){
  $('qClrBox').hidden = !qClrStep; $('qClr2').hidden = qClrStep !== 2;
  $('qClrT').textContent = qClrStep === 1 ? 'Clear all ' + N + ' questions and their correct answers for the ' + T.name + '? Staff won\'t be able to take this test until you add new questions. Press Download questions first if you want a copy.'
    : 'Second check: this cannot be undone. Type CLEAR and press Clear permanently.';
  $('qClrYes').textContent = qClrStep === 2 ? 'Clear permanently' : 'Yes, clear them';
  $('qClrYes').disabled = qClrStep === 2 && $('qClrIn').value.trim().toUpperCase() !== 'CLEAR';
}
$('qClear').onclick = () => {
  if (eff() === 'live'){ msg('End the exam before clearing its questions.'); return; }
  if (!N && !key){ msg('There are no questions to clear.'); return; }
  qReset(); $('qClrIn').value = ''; qClrStep = 1; qClrPaint(); $('qClrNo').focus();
};
$('qClrNo').onclick = () => { qClrStep = 0; qClrPaint(); $('qClear').focus(); };
$('qClrIn').oninput = qClrPaint;
$('qClrYes').onclick = async () => {
  if (qClrStep === 1){ qClrStep = 2; qClrPaint(); $('qClrIn').focus(); return; }
  if ($('qClrIn').value.trim().toUpperCase() !== 'CLEAR') return;
  if (eff() === 'live'){ qClrStep = 0; qClrPaint(); msg('End the exam before clearing its questions.'); return; }
  const b = $('qClrYes'); b.disabled = true; b.textContent = 'Clearing…';
  try {
    await db.doc('questions/' + TR).set({qs: [], clearedAt: Date.now()});
    await db.doc(T.key).delete();
    key = keys[TR] = null; setQs(TR, []); qClrStep = 0; qClrPaint(); paintAdmin(); paintQs(); paintQList();
    msg('Questions cleared for the ' + T.name + '. Add new questions before starting an exam.');
  } catch(e){ qClrStep = 0; qClrPaint(); msg('Could not clear the questions: ' + errText(e) + '. Nothing was changed; try again.'); }
};
setInterval(paintQs, 1000);
