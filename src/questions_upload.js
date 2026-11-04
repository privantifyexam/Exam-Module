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
const csvCell = v => /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
// returns {qs, answers, errs}; questions keep the CSV order (the exam shuffles within each level)
function readQuestions(text){
  const rows = parseCsv(text), errs = [];
  if (!rows.length) return {errs: ['The file is empty.']};
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const at = {}; Q_COLS.forEach(c => at[c] = head.indexOf(c));
  const missing = ['level', 'question', 'option_a', 'option_b', 'answer'].filter(c => at[c] < 0);
  if (missing.length) return {errs: ['The first row must be the header. Missing column' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '. Use the Sample CSV as a template.']};
  const qs = [], answers = [];
  rows.slice(1).forEach((r, k) => {
    const line = k + 2, get = c => at[c] >= 0 ? String(r[at[c]] || '').trim() : '';
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
  if (!errs.length && !qs.length) errs.push('The file has a header but no questions.');
  return {qs, answers, errs};
}
let qPending = null;
function paintQs(){
  if (!isAdmin) return;
  const lc = lvCount();
  $('qCount').textContent = N ? '· ' + N + ' (Easy ' + lc.e + ', Medium ' + lc.m + ', Hard ' + lc.h + ')' + (key ? '' : ' · no key') : '· none yet';
  $('qFile').disabled = eff() === 'live';
}
function qReset(){ qPending = null; $('qFile').value = ''; $('qErrBox').hidden = true; $('qOkBox').hidden = true; }
$('qFile').onchange = async () => {
  const f = $('qFile').files[0]; $('qErrBox').hidden = true; $('qOkBox').hidden = true; qPending = null;
  if (!f) return;
  if (!/\.csv$/i.test(f.name)){ $('qErrT').textContent = 'Choose a .csv file.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; return; }
  const r = readQuestions(await f.text());
  if (r.errs.length){
    $('qErrT').textContent = 'Nothing was saved. Fix ' + (r.errs.length === 1 ? 'this problem' : 'these ' + r.errs.length + ' problems') + ' and upload again:';
    $('qErrs').innerHTML = r.errs.slice(0, 15).map(e => '<li>' + esc(e) + '</li>').join('') + (r.errs.length > 15 ? '<li>…and ' + (r.errs.length - 15) + ' more.</li>' : '');
    $('qErrBox').hidden = false; return;
  }
  qPending = r;
  const c = l => r.qs.filter(q => q.l === l).length;
  const old = results.filter(x => (x.track || 'pharmacist') === TR).length;
  $('qOkT').textContent = f.name + ': ' + r.qs.length + ' questions (Easy ' + c('Easy') + ', Medium ' + c('Medium') + ', Hard ' + c('Hard') + '), each with an answer. Saving replaces the current ' + (N || 'no') + ' questions and the answer key.'
    + (old ? ' ' + old + ' stored attempt' + (old > 1 ? 's' : '') + ' will be marked against the new key; clear results first if this is a new question set.' : '');
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
    setQs(TR, r.qs); qReset(); paintAdmin(); paintQs();
    msg(r.qs.length + ' questions and their answer key saved for the ' + T.name + '.');
  } catch(e){ $('qErrT').textContent = 'Could not save: ' + errText(e) + '. Try again.'; $('qErrs').innerHTML = ''; $('qErrBox').hidden = false; }
  b.disabled = false; b.textContent = 'Save questions and key';
};
async function qDownload(filename, rows){
  try { const d = await claude.use('downloads'); await d.save({filename, data: new TextEncoder().encode('﻿' + toCsv(rows)).buffer}); }
  catch(e){ msg('The download is not available in this view.'); }
}
$('qSample').onclick = () => qDownload('questions_sample.csv', [Q_COLS,
  ['Easy', 'Metformin belongs to which drug class?', 'Sulfonylurea', 'Biguanide', 'Thiazolidinedione', 'DPP-4 inhibitor', '', '', 'B'],
  ['Medium', 'Which test best reflects average blood glucose over the last 2–3 months?', 'Fasting glucose', 'Random glucose', 'HbA1c', 'Fructosamine', '', '', 'C'],
  ['Hard', 'A question with a comma, "quotes" and only three options?', 'First option', 'Second option', 'Third option', '', '', '', 'A']]);
$('qExport').onclick = () => {
  if (!N){ msg('There are no questions to download yet.'); return; }
  const k = key && key.answers;
  qDownload(TR + '_questions.csv', [Q_COLS].concat(QS.map((q, i) => [q.l, q.q].concat([0,1,2,3,4,5].map(j => q.o[j] || ''), [k && k[i] >= 0 ? Q_LETTERS[k[i]] : '']))));
};
setInterval(paintQs, 1000);
