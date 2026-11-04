/* ---------- questions and answer key (CSV upload, invigilator only) ---------- */
const Q_COLS = ['level', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer'];
const Q_LETTERS = 'ABCD';   // each question has 2 to 4 choices
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
    const opts = ['a','b','c','d'].map(x => get('option_' + x));
    // older files may still have option_e / option_f columns: refuse filled ones rather than drop them silently
    const extra = ['option_e', 'option_f'].filter(c => head.indexOf(c) >= 0 && String(r[head.indexOf(c)] || '').trim());
    const last = opts.reduce((m, o, i) => o ? i : m, -1), o = opts.slice(0, last + 1);
    const ans = get('answer').toUpperCase(), ai = Q_LETTERS.indexOf(ans);
    const bad = [];
    if (!level) bad.push('level must be Easy, Medium or Hard');
    if (!q) bad.push('question is empty');
    if (o.length < 2) bad.push('needs at least options A and B');
    else if (o.some(x => !x)) bad.push('options must be filled in order with no gaps (option ' + Q_LETTERS[o.indexOf('')] + ' is empty)');
    if (extra.length) bad.push('only choices A to D are allowed; move or remove what is in ' + extra.join(' and '));
    if (ans.length !== 1 || ai < 0) bad.push('answer must be one letter A to D');
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
  $('qFile').disabled = eff() === 'live';
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
// saves the whole question list and its correct answers (same order) for this assessment
async function saveSet(qs, answers){
  await db.doc('questions/' + TR).set({qs, updatedAt: Date.now()});
  await db.doc(T.key).set({answers});
  key = keys[TR] = {answers}; setQs(TR, qs); paintAdmin(); paintQs(); qRepaint();
  if (exam.status === 'open') await db.doc(T.state).set(Object.assign({}, exam, {count: qs.length}));   // staff see the count while waiting
}
$('qSave').onclick = async () => {
  if (!qPending) return;
  if (eff() === 'live'){ $('qErrT').textContent = 'End the exam before changing its questions.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; return; }
  const b = $('qSave'), r = qPending; b.disabled = true; b.textContent = 'Saving…';
  try {
    await saveSet(r.qs, r.answers); qReset();
    msg(r.qs.length + ' questions saved for the ' + T.name + '.');
  } catch(e){ $('qErrT').textContent = 'Could not save the questions: ' + errText(e) + '. Try again.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; }
  b.disabled = false; b.textContent = 'Save questions';
};
async function qDownload(filename, rows){
  try {
    await loadLib(LIB_XLSX);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [10, 60, 24, 24, 24, 24, 8].map(w => ({wch: w}));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    const d = await claude.use('downloads'); await d.save({filename, data: XLSX.write(wb, {type: 'array', bookType: 'xlsx'})});
  } catch(e){ msg(e && e.message === 'load' ? 'Could not prepare the file. Check your internet connection and try again.' : 'The download is not available in this view.'); }
}
$('qTpl').onclick = () => qDownload('questions_template.xlsx', [Q_COLS,
  ['Easy', 'Example: which of these is a fruit?', 'Carrot', 'Apple', 'Potato', 'Onion', 'B'],
  ['Medium', 'Example: how many minutes are in 2 hours?', '60', '90', '120', '150', 'C'],
  ['Hard', 'Example: a question with a comma, "quotes" and only three options?', 'First option', 'Second option', 'Third option', '', 'A']]);
// question viewer and editor: every question with its choices and the correct one marked;
// invigilators can add, edit and delete questions here (not while an exam is running)
let qLvF = '', qOpen = false, qEditing = null, qDelAsk = -1, qBusy = false;   // qEditing: index being edited, 'new', or null
const Q_MAX_Q = 1000, Q_MAX_O = 300;
const qLocked = () => eff() === 'live';
function qForm(q, ans){
  const opts = Q_LETTERS.split('').map((L, j) => '<div class="qopt"><b>' + L + '</b><input class="input" data-o="' + j + '" maxlength="' + Q_MAX_O + '" value="' + esc(q.o[j] || '') + '" placeholder="' + (j < 2 ? 'Choice ' + L + ' (needed)' : 'Choice ' + L + ' (optional)') + '" aria-label="Choice ' + L + '">'
    + '<label class="qok"><input type="radio" name="qAns" value="' + j + '"' + (ans === j ? ' checked' : '') + '> Correct</label></div>').join('');
  return '<li class="qform" data-form>'
    + '<div class="field"><label for="qfLv">Level</label><select class="input" id="qfLv">' + LV.map(l => '<option' + (q.l === l ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>'
    + '<div class="field"><label for="qfQ">Question</label><textarea class="input" id="qfQ" maxlength="' + Q_MAX_Q + '">' + esc(q.q || '') + '</textarea></div>'
    + '<div class="field"><span class="small">Choices: fill them in order and tick the correct one</span>' + opts + '</div>'
    + '<div class="row"><button class="btn" type="button" data-save>Save question</button><button class="btn btn-ghost" type="button" data-cancel>Cancel</button></div></li>';
}
function paintQList(){
  if (!qOpen) return;
  const k = key && key.answers, s = $('qSearch').value.trim().toLowerCase(), lock = qLocked();
  if (lock) qEditing = null;
  const shown = QS.map((q, i) => ({q, i})).filter(({q, i}) => i === qEditing || ((!qLvF || q.l === qLvF) && (!s || (q.q + ' ' + q.o.join(' ')).toLowerCase().includes(s))));
  $('qDlgT').textContent = 'Questions · ' + T.name;
  $('qLock').hidden = !lock; $('qAdd').disabled = lock || qEditing !== null;
  $('qListNote').textContent = !N ? 'No questions yet. Press Add question, or upload an Excel file on the dashboard.' : 'Showing ' + shown.length + ' of ' + N + ' questions.' + (k ? '' : ' The correct answers are not saved, so none are marked.');
  const card = ({q, i}) => i === qEditing ? qForm(q, k ? k[i] : -1)
    : '<li><div class="qh"><span class="qn">' + (i + 1) + '.</span><span class="qt">' + esc(q.q) + '</span><span class="lv">' + esc(q.l) + '</span>'
      + (lock || qEditing !== null ? '' : '<span class="qact"><button class="btn btn-sm btn-ghost" type="button" data-edit="' + i + '">Edit</button><button class="btn btn-sm btn-quiet" type="button" data-del="' + i + '">Delete</button></span>') + '</div><ul>'
      + q.o.map((o, j) => '<li' + (k && k[i] === j ? ' class="ok"' : '') + '><b>' + Q_LETTERS[j] + '</b><span>' + esc(o) + '</span></li>').join('') + '</ul>'
      + (qDelAsk === i ? '<div class="qconf"><span>Delete question ' + (i + 1) + '?' + (qHasResults() ? ' Saved results will be marked against the changed list.' : '') + '</span><button class="btn btn-sm btn-danger" type="button" data-del-yes="' + i + '">Delete</button><button class="btn btn-sm btn-ghost" type="button" data-del-no>Keep it</button></div>' : '') + '</li>';
  $('qItems').innerHTML = (qEditing === 'new' ? qForm({l: 'Easy', q: '', o: []}, -1) : '') + shown.map(card).join('');
}
// repaint from outside the editor (data updates) without wiping a form someone is typing in
function qRepaint(){ if (qEditing === null) paintQList(); }
const qHasResults = () => results.some(r => (r.track || 'pharmacist') === TR);
function qSay(ok, err){ $('qEdMsg').textContent = ok || ''; $('qEdMsg').hidden = !ok; $('qEdErr').textContent = err || ''; }
// reads the open form; returns {q, ans} or {err}
function qReadForm(){
  const l = $('qfLv').value, text = $('qfQ').value.trim().replace(/\s+\n/g, '\n');
  const all = [...document.querySelectorAll('#qItems [data-o]')].map(x => x.value.trim());
  const last = all.reduce((m, o, i) => o ? i : m, -1), o = all.slice(0, last + 1);
  const pick = document.querySelector('#qItems input[name=qAns]:checked'), ans = pick ? +pick.value : -1;
  if (!text) return {err: 'Type the question.', focus: 'qfQ'};
  if (o.length < 2) return {err: 'Fill in at least choices A and B.'};
  if (o.some(x => !x)) return {err: 'Fill the choices in order with no gaps: choice ' + Q_LETTERS[o.indexOf('')] + ' is empty.'};
  if (new Set(o.map(x => x.toLowerCase())).size !== o.length) return {err: 'Two choices are the same. Make each choice different.'};
  if (ans < 0) return {err: 'Tick the correct choice.'};
  if (ans >= o.length) return {err: 'The choice ticked as correct is empty.'};
  return {q: {l, q: text, o}, ans};
}
async function qCommit(qs, answers, done){
  if (qLocked()){ qSay('', 'An exam is running, so questions can\'t be changed until it ends.'); return false; }
  qBusy = true; document.querySelectorAll('#qDlg button').forEach(b => b.disabled = true);
  try { await saveSet(qs, answers); qSay(done); return true; }
  catch(e){ qSay('', 'Could not save: ' + errText(e) + '. Nothing was changed; try again.'); return false; }
  finally { qBusy = false; document.querySelectorAll('#qDlg button').forEach(b => b.disabled = false); paintQList(); }
}
// current answers, padded so every question has a slot (-1 = not set)
const qAnswers = () => QS.map((_, i) => key && Array.isArray(key.answers) && key.answers[i] >= 0 ? key.answers[i] : -1);
$('qItems').addEventListener('click', async ev => {
  const t = ev.target.closest('button'); if (!t || qBusy) return;
  if (t.dataset.edit){ qSay(); qDelAsk = -1; qEditing = +t.dataset.edit; paintQList(); $('qfQ').focus(); return; }
  if (t.dataset.del){ qSay(); qDelAsk = +t.dataset.del; paintQList(); return; }
  if ('delNo' in t.dataset){ qDelAsk = -1; paintQList(); return; }
  if ('cancel' in t.dataset){ qEditing = null; qSay(); paintQList(); return; }
  if (t.dataset.delYes){
    const i = +t.dataset.delYes, qs = QS.slice(), a = qAnswers(); qs.splice(i, 1); a.splice(i, 1); qDelAsk = -1;
    await qCommit(qs, a, 'Question ' + (i + 1) + ' deleted. ' + qs.length + ' questions left.'); return;
  }
  if ('save' in t.dataset){
    const r = qReadForm(); if (r.err){ qSay('', r.err); if (r.focus) $(r.focus).focus(); return; }
    const qs = QS.slice(), a = qAnswers(), isNew = qEditing === 'new';
    if (isNew){ qs.push(r.q); a.push(r.ans); } else { qs[qEditing] = r.q; a[qEditing] = r.ans; }
    const n = isNew ? qs.length : qEditing + 1;
    if (await qCommit(qs, a, isNew ? 'Question ' + n + ' added.' : 'Question ' + n + ' saved.')) qEditing = null;
    paintQList();
  }
});
$('qAdd').onclick = () => { if (qLocked()) return; qSay(); qDelAsk = -1; qEditing = 'new'; paintQList(); $('qfQ').focus(); };
function qOpenDlg(){ qOpen = true; qEditing = null; qDelAsk = -1; qSay(); paintQList(); document.body.classList.add('dlg-open'); $('qDlg').showModal(); $('qSearch').focus(); }
$('qView').onclick = qOpenDlg;
$('qClose').onclick = () => $('qDlg').close();
$('qDlg').addEventListener('cancel', ev => { if (qEditing !== null){ ev.preventDefault(); qEditing = null; qSay(); paintQList(); } });   // Esc first leaves the form
$('qDlg').addEventListener('close', () => { qOpen = false; qEditing = null; document.body.classList.remove('dlg-open'); $('qView').focus(); });
$('qDlg').addEventListener('click', ev => { if (ev.target === $('qDlg') && qEditing === null) $('qDlg').close(); });   // click outside closes it (not while editing)
$('qSearch').oninput = paintQList;
document.querySelectorAll('#qLv button').forEach(b => b.onclick = () => { qLvF = b.dataset.lv; document.querySelectorAll('#qLv button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paintQList(); });
setInterval(paintQs, 1000);
