const SEC = 33, CIRC = 2 * Math.PI * 27;
const BASE_URL = location.origin + location.pathname;
const TRACKS = {
  pharmacist: {name:'Pharmacist assessment', one:'pharmacist', many:'pharmacists', qs:[], state:'exam/state', key:'key/main', code:'key/code', ls:'sugarcare_session_v1',
    positions:['Pharmacist','Senior Pharmacist','Pharmacy Assistant','Pharmacy Technician','Store In-charge','Intern / Trainee','Other']},
  dietitian: {name:'Dietitian assessment', one:'dietitian', many:'dietitians', qs:[], state:'exam/dietitian', key:'key/dietitian', code:'key/dietitian-code', ls:'sugarcare_session_dietitian',
    positions:['Dietitian','Senior Dietitian','Nutritionist','Diabetes Educator','Intern / Trainee','Other']}
};
let TR = 'pharmacist', T = TRACKS.pharmacist, QS = T.qs, N = QS.length, LS = T.ls;
const states = {}, keys = {}, codes = {}, rawDocs = {};
const LV = ['Easy','Medium','Hard'];
const lvCount = () => ({e: QS.filter(q => q.l === 'Easy').length, m: QS.filter(q => q.l === 'Medium').length, h: QS.filter(q => q.l === 'Hard').length});
const needMin = () => Math.ceil(N * SEC / 60);
// questions saved from the dashboard (questions/<track>) replace the ones built into the page
function setQs(tr, qs){ TRACKS[tr].qs = qs; TRACKS[tr].uploaded = true; if (tr === TR){ QS = qs; N = qs.length; applyTrackText(); } }
async function loadQs(){ await Promise.all(Object.keys(TRACKS).map(tr => db.doc('questions/' + tr).get().then(s => { if (s.exists && Array.isArray(s.data().qs)) setQs(tr, s.data().qs); }).catch(() => {}))); }
function useTrack(tr){ TR = tr; T = TRACKS[tr]; QS = T.qs; N = QS.length; LS = T.ls; exam = states[tr] || {status:'idle'}; key = keys[tr] || null; secCode = codes[tr] || null; }
const $ = id => document.getElementById(id);
let db = null, user = null, isAdmin = false;
let exam = {status:'idle'}, sess = null, results = [], key = null;
let uid = null, created = false, resDocs = [], booted = false, ticker = null, firstState = false, writeQ = Promise.resolve(), saveFailed = false, finalSaved = null, lastSaved = 0;
let qShownAt = 0, warned10 = false, fSt = 'all', fTxt = '', endArmed = false;
const shuf = arr => { const x = arr.slice(); for (let i = x.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
// keep easy → medium → hard, shuffle inside each level
function makeOrder(){ return [].concat(...LV.map(l => shuf(QS.map((q,k) => q.l === l ? k : -1).filter(k => k >= 0)))); }
function ensureOrder(){
  if (!sess.order) sess.order = Array.from({length:N}, (_,k) => k);
  if (!sess.opt) sess.opt = QS.map(q => q.o.map((_,k) => k));
}
const qAt = i => sess.order[i];
function record(){ const qi = qAt(sess.i); sess.answers[qi] = sess.sel >= 0 ? sess.opt[qi][sess.sel] : -1; }
const inTest = () => !!(sess && sess.started && !sess.done && !$('sQuiz').hidden);
let wake = null;
async function keepAwake(){ try { if (!wake && navigator.wakeLock && document.visibilityState === 'visible') { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch(e){ wake = null; } }
function letSleep(){ try { if (wake) wake.release(); } catch(e){} wake = null; }
document.addEventListener('visibilitychange', () => {
  if (!sess || !sess.started || sess.done) return;
  if (document.visibilityState === 'hidden'){ sess.away = (sess.away || 0) + 1; sess.awayNote = true; lsSet(sess); write('in-progress'); }
  else { keepAwake(); paintAway(); }
});
function paintAway(){
  const n = (sess && sess.away) || 0, el = $('awayBanner');
  el.hidden = !(n && sess.awayNote);
  el.firstElementChild.textContent = 'You left the test ' + (n === 1 ? 'once' : n + ' times') + '. The invigilator can see this.';
}
$('awayX').onclick = () => { if (sess){ sess.awayNote = false; lsSet(sess); } paintAway(); };
['copy','cut','contextmenu','selectstart','dragstart'].forEach(t => document.addEventListener(t, ev => { if (inTest() && !ev.target.closest('input,select,textarea')) ev.preventDefault(); }));
window.addEventListener('beforeunload', ev => { if (!preview && sess && sess.started && !sess.done){ ev.preventDefault(); ev.returnValue = ''; } });
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I, so the code is easy to read out
function newCode(){ const r = new Uint32Array(6); crypto.getRandomValues(r); return Array.from(r, x => CODE_ABC.charAt(x % CODE_ABC.length)).join(''); }
async function hashCode(code, salt){ const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + String(code).toUpperCase())); return Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2,'0')).join(''); }
const codeOk = () => !exam.codeHash || !!(sess && sess.codeOk === String(exam.startedAt));
let codeTries = 0, codeLockUntil = 0, secCode = null;
const TICK = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

const show = id => { ['sLogin','sCode','sReady','sQuiz','sDone','sHome','sAdmin'].forEach(s => $(s).hidden = s !== id); try { window.scrollTo(0, 0); } catch(e){} };
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS)); } catch(e){ return null; } };
const lsSet = v => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch(e){} };
// exam stages: idle → open (created with its security code; staff can join and wait) → live (answering) → ended
const canJoin = s => s === 'open' || s === 'live';
// the exam whose marks the dashboard shows: while the next exam waits to start, keep showing the last one's
const marksId = st => st.status === 'open' ? (st.lastId || '') : st.startedAt ? String(st.startedAt) : '';
const eff = () => exam.status === 'live' ? (Date.now() < exam.endsAt ? 'live' : 'ended') : exam.status;
const mmss = ms => { ms = Math.max(0, Math.round(ms/1000)); return Math.floor(ms/60) + ':' + String(ms%60).padStart(2,'0'); };
const fmtT = t => t ? new Date(t).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : '–';
// error text for messages, without its own trailing full stop
const errText = e => String((e && (e.message || e.code)) || 'unknown error').trim().replace(/[.\s]+$/, '');
// spreadsheet apps run cells that start with = + - @ as formulas; a leading ' keeps typed text as text
const csvSafe = v => { const t = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?%?$/.test(t) ? "'" + t : t; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const say = t => { const r = $('sr'); r.textContent = ''; setTimeout(() => r.textContent = t, 30); };

function chip(el, st, text){ el.className = 'chip ' + st; el.lastElementChild.textContent = text; }
function statusChip(el){
  const s = eff();
  if (!db) return chip(el, 'idle', booted ? 'Not connected' : 'Connecting…');
  if (s === 'live') chip(el, 'live', 'Exam is live');
  else if (s === 'ended') chip(el, 'ended', 'Exam has ended');
  else if (s === 'open') chip(el, 'idle', 'Waiting for the exam to start');
  else chip(el, 'idle', 'Waiting for the invigilator');
}
let preview = false;
function whoLine(){ $('who').textContent = sess ? sess.name + ' · ' + sess.phone : ''; }

/* ---------- sign in ---------- */
function fieldErr(id, msg){
  const f = $(id), e = $(id + 'Err');
  e.textContent = msg || ''; e.hidden = !msg;
  f.setAttribute('aria-invalid', msg ? 'true' : 'false');
  f.closest('.field').classList.toggle('bad', !!msg);
}
['fName','fPhone','fPos'].forEach(id => $(id).addEventListener(id === 'fPos' ? 'change' : 'input', () => fieldErr(id, '')));
// mobile number: digits only, 10 at most. A pasted +91 / 0 prefix is dropped so the 10-digit number remains.
// after 3 tries at typing letters or symbols, a warning explains that only numbers go here
// it closes by itself after 6 seconds or with ×; three more tries bring it back
let phoneBadTries = 0, phoneWarnTimer = null;
const phoneWarnReset = () => { phoneBadTries = 0; clearTimeout(phoneWarnTimer); $('fPhoneWarn').hidden = true; };
const phoneWarnShow = () => { $('fPhoneWarn').hidden = false; clearTimeout(phoneWarnTimer); phoneWarnTimer = setTimeout(phoneWarnReset, 6000); };
$('fPhoneWarnX').onclick = () => { phoneWarnReset(); $('fPhone').focus(); };
$('fPhone').addEventListener('input', () => {
  const el = $('fPhone'); let d = el.value.replace(/\D/g, '');
  if (/[^\d\s+\-]/.test(el.value) && ++phoneBadTries >= 3) phoneWarnShow();   // spaces, + and - from a pasted number don't count
  if (!el.value) phoneWarnReset();
  if (d.length > 10 && /^(91|0)/.test(d) && /[+\s-]/.test(el.value)) d = d.replace(/^(91|0)/, '');
  d = d.slice(0, 10);
  if (el.value !== d) el.value = d;
});
$('loginForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const name = $('fName').value.trim().replace(/\s+/g,' '), phone = $('fPhone').value.replace(/[^\d]/g,''), pos = $('fPos').value;
  const errs = {};
  if (name.length < 3) errs.fName = name ? 'Enter your full name, at least 3 letters.' : 'Enter your full name.';
  if (phone.length !== 10) errs.fPhone = !phone ? 'Enter your mobile number.' : 'Enter all 10 digits of your mobile number.';
  if (!pos) errs.fPos = 'Select your position.';
  let first = null;
  ['fName','fPhone','fPos'].forEach(id => { fieldErr(id, errs[id]); if (errs[id] && !first) first = id; });
  if (first){ $(first).focus(); $(first).scrollIntoView({block:'center'}); return; }
  sess = {name, phone: phone.slice(-10), pos, started:false};
  lsSet(sess); goNext();
});

/* ---------- security code ---------- */
function goNext(){ (canJoin(eff()) && codeOk()) ? goReady() : goCode(); }
function goCode(){
  whoLine(); show('sCode'); refreshCode();
  if (!$('fCode').disabled) $('fCode').focus();
}
function refreshCode(){
  if ($('sCode').hidden) return;
  const s = eff(), live = !!db && canJoin(s);
  if (live && codeOk()) return goReady();
  statusChip($('cChip'));
  const wasOff = $('fCode').disabled;
  $('fCode').disabled = !live; $('codeBtn').disabled = !live;
  $('fCodeHelp').textContent = !db ? 'Can\'t connect right now. Check your internet.'
    : preview ? 'Preview: type the practice code ' + $('pvCode').textContent + ' (shown in the purple bar at the top).'
    : live ? 'Letters and numbers. Capitals or small letters both work.'
    : s === 'ended' ? 'This exam has ended. Ask the invigilator what to do next.'
    : 'Keep this page open. The code box unlocks when the invigilator sets up the exam.';
  if (live && wasOff) $('fCode').focus();
}
$('fCode').addEventListener('input', () => {
  const v = $('fCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if ($('fCode').value !== v) $('fCode').value = v;
  fieldErr('fCode', '');
});
$('codeForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!canJoin(eff()) || !sess) return;
  const wait = Math.ceil((codeLockUntil - Date.now()) / 1000);
  if (wait > 0) { fieldErr('fCode', 'Too many wrong tries. Wait ' + wait + ' seconds, then check the code with the invigilator.'); return; }
  const v = $('fCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 6) { fieldErr('fCode', v ? 'The code has 6 characters. You typed ' + v.length + '.' : 'Enter the 6-character code from the invigilator.'); $('fCode').focus(); return; }
  $('codeBtn').disabled = true;
  let h = '';
  try { h = await hashCode(v, String(exam.startedAt)); } catch(e){}
  $('codeBtn').disabled = false;
  let ok = h === exam.codeHash;
  if (!ok && preview){   // test mode also accepts the real exam's current code
    const real = states[TR];
    if (real && real.codeHash && real.startedAt){ try { ok = (await hashCode(v, String(real.startedAt))) === real.codeHash; } catch(e){} }
  }
  if (!ok) {
    codeTries++;
    if (codeTries >= 5) { codeTries = 0; codeLockUntil = Date.now() + 60000; fieldErr('fCode', 'That code is not right. Too many tries: wait 1 minute, then check the code with the invigilator.'); }
    else fieldErr('fCode', 'That code is not right. Check it with the invigilator. ' + (5 - codeTries) + ' tr' + (5 - codeTries === 1 ? 'y' : 'ies') + ' left.');
    $('fCode').focus(); $('fCode').select(); return;
  }
  codeTries = 0; sess.codeOk = String(exam.startedAt); lsSet(sess);
  $('fCode').value = ''; fieldErr('fCode', ''); say('Code accepted'); goReady();
});
$('codeBack').onclick = () => {
  if (sess){ $('fName').value = sess.name; $('fPhone').value = sess.phone; $('fPos').value = sess.pos; }
  sess = null; lsSet(null); whoLine(); show('sLogin'); $('fName').focus();
};

/* ---------- ready ---------- */
function goReady(){
  $('rHello').textContent = 'Hello, ' + sess.name.split(' ')[0];
  whoLine(); show('sReady'); refreshReady();
}
function refreshReady(){
  if ($('sReady').hidden) return;
  if (db && canJoin(eff()) && !codeOk()) return goCode();
  const s = eff(), left = (exam.endsAt || 0) - Date.now();
  statusChip($('rChip'));
  $('rN').textContent = N || exam.count || '–';
  if (db && s === 'live' && N) return beginTest();
  $('rWin').textContent = s === 'live' ? mmss(left) : '–';
  $('rLate').hidden = !(s === 'live' && left < N * SEC * 1000);
  $('rWait').textContent = !db ? 'Can\'t connect right now. Check your internet.'
    : s === 'live' ? 'The exam has started. Loading your first question…'
    : s === 'ended' ? 'This exam has ended. Ask the invigilator what to do next.'
    : s === 'open' ? 'You\'re in. Keep this page open: your test starts by itself as soon as the invigilator starts the exam.'
    : 'Keep this page open. Your test starts by itself when the invigilator starts the exam.';
}
$('backBtn').onclick = () => {
  if (sess){ $('fName').value = sess.name; $('fPhone').value = sess.phone; $('fPos').value = sess.pos; }
  sess = null; lsSet(null); whoLine(); show('sLogin'); $('fName').focus();
};
// the test starts by itself for everyone waiting as soon as the invigilator starts the exam
// (and straight away for anyone who joins while it is already running)
function beginTest(){
  if (!sess || sess.started || eff() !== 'live' || !N || $('sReady').hidden) return;
  if (!codeOk()) return goCode();
  sess = Object.assign(sess, {started:true, done:false, examId:String(exam.startedAt), pid:'', i:0, answers:Array(N).fill(-1), sel:-1, away:0, order:makeOrder(), opt:QS.map(q => shuf(q.o.map((_,k) => k))), qStart:Date.now(), t0:Date.now()});
  sess.pid = sess.examId + '_' + sess.phone + '_' + Math.random().toString(36).slice(2,6);
  lsSet(sess); saveFailed = false; write('in-progress'); showQ();
};

/* ---------- saving ---------- */
function write(status){
  if (preview){ saveFailed = false; lastSaved = Date.now(); if (status === 'submitted') finalSaved = true; paintSave(); return; }
  if (!db || !uid || !sess || !sess.pid) { if (db && !uid) { saveFailed = true; if (status === 'submitted') finalSaved = false; paintSave(); } return; }
  const d = {track:TR, examId:sess.examId, name:sess.name, phone:sess.phone, position:sess.pos, answers:sess.answers.slice(), i:sess.i, away:sess.away || 0, status, startedAt:sess.t0, updatedAt:Date.now()};
  if (status === 'submitted') d.finishedAt = Date.now();
  const attempt = async n => {
    try {
      const ref = db.doc('results/' + uid), f = {['a_' + sess.pid]: d};
      if (created) await ref.update(f); else { const sn = await ref.get(); if (sn.exists) await ref.update(f); else await ref.set(f); created = true; }
      saveFailed = false; lastSaved = Date.now(); if (status === 'submitted') finalSaved = true;
    } catch(e){
      if (n < 3) { await new Promise(r => setTimeout(r, 1500*n)); return attempt(n+1); }
      saveFailed = true; if (status === 'submitted') finalSaved = false;
    }
    paintSave();
  };
  writeQ = writeQ.then(() => attempt(1));
}
function paintSave(){
  $('saveBanner').hidden = !saveFailed;
  $('qSaved').textContent = preview ? 'Preview: not saved' : !saveFailed && lastSaved ? 'Answers saved' : '';
  if ($('sDone').hidden) return;
  const el = $('dSave'), fs = finalSaved;
  el.className = 'savestate ' + (fs === true ? 'ok' : fs === false ? 'bad' : 'wait');
  el.textContent = preview ? 'Preview: nothing was saved.' : fs === true ? 'Your answers are saved. You can close this page.'
    : fs === false ? 'Your answers were not saved. Check your internet and try again. If it still fails, show this screen to the invigilator before you leave.'
    : 'Saving your answers…';
  $('dTick').className = 'bigtick' + (fs === true ? '' : ' wait');
  $('retryBtn').hidden = fs !== false;
  $('doneBtn').disabled = fs === null;
  $('doneBtn').textContent = preview ? 'Back to dashboard' : fs === false ? 'Leave without saving' : 'Finish';
}
$('retryBtn').onclick = () => { finalSaved = null; paintSave(); write('submitted'); if (!db) { finalSaved = false; paintSave(); } };

/* ---------- questions ---------- */
function showQ(){
  show('sQuiz'); ensureOrder(); keepAwake(); paintAway();
  const qi = qAt(sess.i), q = QS[qi], om = sess.opt[qi];
  $('qNo').textContent = sess.i + 1; $('qOf').textContent = ' of ' + N;
  $('qText').textContent = q.q;
  $('qOpts').innerHTML = om.map((oi,k) => '<button type="button" class="opt" role="radio" aria-checked="false" tabindex="-1" data-k="'+k+'"><span class="k">'+'ABCD'[k]+'</span><span class="t">'+esc(q.o[oi])+'</span>'+TICK+'</button>').join('');
  const answered = sess.order.slice(0, sess.i).filter(x => sess.answers[x] >= 0).length;
  $('qSegs').style.gridTemplateColumns = 'repeat(' + N + ',1fr)';
  $('qSegs').innerHTML = QS.map((_,k) => '<i class="' + (k < sess.i ? (sess.answers[sess.order[k]] >= 0 ? 'a' : 's') : k === sess.i ? 'c' : '') + '"></i>').join('');
  $('qNote').textContent = answered + ' answered · ' + (sess.i - answered) + ' skipped · ' + (N - sess.i) + ' left';
  warned10 = false; qShownAt = Date.now();
  paintSel(); paintSave();
  $('qText').focus({preventScroll:true});
  tick();
}
function paintSel(){
  [...$('qOpts').children].forEach(b => {
    const on = +b.dataset.k === sess.sel;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on || (sess.sel < 0 && b.dataset.k === '0') ? 0 : -1;
  });
  const last = sess.i === N - 1, has = sess.sel >= 0, b = $('nextBtn');
  b.textContent = has ? (last ? 'Submit test' : 'Next question') : (last ? 'Submit without answering' : 'Skip question');
  b.className = 'btn btn-lg' + (has ? '' : ' btn-ghost');
}
function choose(k, focus){
  sess.sel = k; lsSet(sess); paintSel();
  if (focus) { const b = $('qOpts').children[k]; if (b) b.focus(); }
}
$('qOpts').addEventListener('click', ev => { const b = ev.target.closest('.opt'); if (b) choose(+b.dataset.k); });
$('nextBtn').onclick = () => advance();
document.addEventListener('keydown', ev => {
  if ($('sQuiz').hidden || !sess || sess.done || ev.target.closest('input,select,textarea')) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  ensureOrder(); const kk = ev.key, n = QS[qAt(sess.i)].o.length;
  let k = kk.length === 1 ? '1234'.indexOf(kk) : -1;
  if (k < 0 && kk.length === 1) k = 'abcd'.indexOf(kk.toLowerCase());
  if (k >= 0 && k < n) choose(k, ev.target.closest('.opt'));
  else if (kk === 'Enter') { ev.preventDefault(); if (!ev.repeat) advance(); }
  else if (/^Arrow(Up|Down|Left|Right)$/.test(kk) && ev.target.closest('#qOpts')) {
    ev.preventDefault();
    const d = (kk === 'ArrowDown' || kk === 'ArrowRight') ? 1 : -1, cur = sess.sel;
    choose(cur < 0 ? (d > 0 ? 0 : n - 1) : (cur + d + n) % n, true);
  }
});
function advance(){
  if (!sess || sess.done) return;
  if (Date.now() - qShownAt < 400) return;   // stops a double tap from skipping the next question
  ensureOrder(); record(); sess.i++; sess.sel = -1; sess.qStart = Date.now();
  if (sess.i >= N) return finish();
  lsSet(sess); write('in-progress'); showQ();
}
function finish(closed){
  ensureOrder(); if (closed && sess.i < N) record();
  sess.done = true; letSleep(); lsSet(sess); finalSaved = null; write('submitted');
  if (!db) finalSaved = false;
  show('sDone');
  const answered = sess.answers.filter(x => x >= 0).length;
  $('dTitle').textContent = closed ? 'Time is up' : 'Test submitted';
  $('dMsg').textContent = (closed ? 'Time is up, so the answers you gave have been saved. ' : 'Thank you. ')
    + 'You answered ' + answered + ' of ' + N + ' questions. The invigilator will share the results.';
  const pv = $('dScore'); pv.hidden = !preview;
  if (preview){ const sc = scoreOf({answers: sess.answers}), lc = lvCount();
    pv.textContent = sc ? 'Your score in this preview: ' + sc.t + ' / ' + N + ' (' + Math.round(sc.t / N * 100) + '%) · Easy ' + sc.e + '/' + lc.e + ' · Medium ' + sc.m + '/' + lc.m + ' · Hard ' + sc.h + '/' + lc.h + '. Staff never see their score; it only shows here in the preview.' : 'The correct answers are not saved yet, so no score can be shown.'; }
  paintSave();
  say($('dTitle').textContent);
}
$('doneBtn').onclick = () => {
  if (preview) return exitPreview();
  sess = null; lsSet(null); ['fName','fPhone','fPos'].forEach(id => { $(id).value = ''; fieldErr(id, ''); }); phoneWarnReset();
  whoLine(); show('sLogin');
};

function tick(){
  if (isAdmin && !preview){ paintAdminTimes(); document.querySelectorAll('[data-left]').forEach(el => { const st = states[el.dataset.left]; if (st && st.endsAt) el.textContent = mmss(st.endsAt - Date.now()); }); return; }
  if (sess && sess.started && !sess.done){
    if (eff() !== 'live' && firstState){ return finish(true); }
    let el = Date.now() - sess.qStart, changed = false;
    ensureOrder();
    while (el >= SEC*1000 && sess.i < N){ record(); sess.i++; sess.sel = -1; sess.qStart += SEC*1000; el -= SEC*1000; changed = true; }
    if (changed){ if (sess.i >= N) return finish(); lsSet(sess); write('in-progress'); return showQ(); }
    if (!$('sQuiz').hidden){
      const left = SEC - el/1000, cls = left <= 5 ? 'bad' : left <= 10 ? 'warn' : '';
      $('qClock').textContent = Math.max(0, Math.ceil(left));
      $('qRing').style.strokeDasharray = CIRC;
      $('qRing').style.strokeDashoffset = CIRC * (1 - Math.max(0, left/SEC));
      $('qTimer').className = 'timer ' + cls;
      if (left <= 10 && !warned10){ warned10 = true; say('10 seconds left'); }
    }
  } else { refreshReady(); refreshCode(); }
}

/* ---------- invigilator ---------- */
const scoreOf = r => {
  const a = r.answers || [], k = key ? key.answers : null, o = {t:0,e:0,m:0,h:0,n:0};
  if (!k) return null;
  for (let i=0;i<N;i++){ if (a[i] >= 0) o.n++; if (a[i] === k[i]){ o.t++; const l = QS[i].l; if (l === 'Easy') o.e++; else if (l === 'Medium') o.m++; else o.h++; } }
  return o;
};
let selExam = '';
const shownId = () => selExam || marksId(exam);
// every exam that has saved results for this assessment, newest first
function examIds(){
  const ids = new Set(results.filter(r => (r.track || 'pharmacist') === TR && r.examId).map(r => String(r.examId)));
  const now = marksId(exam); if (now) ids.add(now);
  return [...ids].sort((a, b) => +b - +a);
}
function rowsForExam(id = shownId()){
  const cur = results.filter(r => id && (r.track || 'pharmacist') === TR && r.examId === id);
  const byPhone = {};
  cur.sort((a,b) => (a.startedAt||0) - (b.startedAt||0)).forEach(r => { (byPhone[r.phone] = byPhone[r.phone] || []).push(r); });
  return Object.values(byPhone).map(list => Object.assign({extra:list.length-1, sc:scoreOf(list[0])}, list[0]));
}
function rank(rows){ return rows.slice().sort((a,b) => ((b.sc?b.sc.t:-1)-(a.sc?a.sc.t:-1)) || ((a.finishedAt||9e15)-(b.finishedAt||9e15))); }
// popup message: problems ("Could not…", "End it…") stay until OK; other messages close after a few seconds
let msgTimer = null;
function msg(t){
  const el = $('aMsg'); clearTimeout(msgTimer);
  if (!t){ el.classList.remove('show'); msgTimer = setTimeout(() => { el.hidden = true; }, 200); return; }
  const bad = /^(could not|this exam is running|end the exam|there are no|choose the excel)/i.test(t);
  $('aMsgT').textContent = t; el.classList.toggle('bad', bad); el.classList.toggle('info', !bad); el.setAttribute('role', bad ? 'alert' : 'status');
  el.hidden = false; requestAnimationFrame(() => el.classList.add('show'));
  if (!bad) msgTimer = setTimeout(() => msg(''), Math.min(12000, 4000 + t.length * 40));   // longer messages stay longer
}
$('aMsgX').onclick = () => msg('');
$('aMsg').addEventListener('mouseenter', () => clearTimeout(msgTimer));   // hovering keeps it open to read
$('aMsg').addEventListener('mouseleave', () => { if (!$('aMsg').classList.contains('bad') && !$('aMsg').hidden) msgTimer = setTimeout(() => msg(''), 3000); });

function paintAdmin(){
  if (!isAdmin || $('sAdmin').hidden) return;
  const s = eff(), live = s === 'live', all = rank(rowsForExam()), now = selExam ? rank(rowsForExam(marksId(exam))) : all;
  statusChip($('aChip'));
  $('aIdle').hidden = live; $('aLiveRow').hidden = !canJoin(s); $('aEndWrap').hidden = !live;
  if (!preview && (exam.status === 'idle' || exam.status === 'ended')) prepareExam();
  if (!live) endArmed = false;
  $('aEnd').hidden = endArmed; $('aEndBox').hidden = !endArmed;
  $('aStart').textContent = 'Start exam';
  $('aStart').disabled = false; { const why = startBlock(); $('aNoQs').textContent = why ? 'Start exam is blocked. ' + why : ''; $('aNoQs').hidden = !why || s === 'live'; } $('aTry').disabled = !N;
  const lc = lvCount(); $('thS').textContent = 'Score /' + N; $('thE').textContent = 'Easy /' + lc.e; $('thM').textContent = 'Medium /' + lc.m; $('thH').textContent = 'Hard /' + lc.h;
  const nDone = now.filter(r => r.status === 'submitted').length, nProg = now.length - nDone;
  const done = all.filter(r => r.status === 'submitted').length, prog = all.length - done;
  $('aEndText').textContent = nProg
    ? 'End the exam now? ' + nProg + ' ' + (nProg > 1 ? T.many + ' are' : T.one + ' is') + ' still taking the test. Their answers so far will be submitted.'
    : 'End the exam now? Nobody is taking the test at the moment. No one else will be able to start.';
  const scored = now.filter(r => r.sc && r.status === 'submitted'), avg = scored.length ? (scored.reduce((x,r)=>x+r.sc.t,0)/scored.length).toFixed(1) : '–';
  $('aStats').innerHTML = [['Started',now.length,T.many,''],['In progress',nProg,'taking the test','t-brand'],['Submitted',nDone,'finished','t-green'],['Average',avg,scored.length ? 'out of ' + N : 'no scores yet','']]
    .map(([l,v,u,c]) => '<div class="stat '+c+'"><span class="sl">'+l+'</span><b>'+v+'</b><span class="su">'+u+'</span></div>').join('');
  $('aKeyWarn').hidden = !!key || !N || !$('aNoQs').hidden;
  $('aKeyNote').textContent = key ? 'Marks are worked out automatically. Staff never see the correct answers or their marks.' : '';
  paintExamPicker();
  $('cAll').textContent = all.length; $('cRun').textContent = prog; $('cSub').textContent = done;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === fSt)));
  const q = fTxt.trim().toLowerCase(), qd = q.replace(/\D/g,'');
  const rows = all.map((r,i) => ({r, i})).filter(({r}) =>
    (fSt === 'all' || (fSt === 'sub' ? r.status === 'submitted' : r.status !== 'submitted')) &&
    (!q || String(r.name).toLowerCase().includes(q) || (qd && String(r.phone).includes(qd))));
  const filtered = q || fSt !== 'all';
  $('aCount').textContent = all.length ? (filtered ? rows.length + ' of ' + all.length : all.length + ' ' + (all.length > 1 ? T.many : T.one)) : '';
  if (!all.length && selExam){
    $('aBody').innerHTML = '<tr><td colspan="10" class="empty"><b>No results for this exam</b><p>Pick another exam above.</p></td></tr>';
  } else if (!all.length){
    $('aBody').innerHTML = '<tr><td colspan="10" class="empty"><b>No one has started the test yet</b><p>' + (live ? 'The exam is open. Share the exam link with the ' + T.many + '. Rows appear here as each one starts.' : 'Press Start exam, then share the exam link with the ' + T.many + '.') + '</p></td></tr>';
  } else if (!rows.length){
    $('aBody').innerHTML = '<tr><td colspan="10" class="empty"><b>No one matches</b><p>Nothing matches “' + esc(fTxt.trim() || '') + '” with this filter.</p><button class="btn btn-ghost" type="button" data-clear="1">Clear search and filter</button></td></tr>';
  } else {
    $('aBody').innerHTML = rows.map(({r, i}) => {
      const sc = r.sc, p = sc ? Math.round(sc.t/N*100) : null, cls = p === null ? '' : p >= 70 ? 'hi' : p >= 50 ? 'mid' : 'lo';
      const st = r.status === 'submitted' ? '<span class="tag sub">Submitted</span>' : '<span class="tag run">On Q' + Math.min(N, (r.i||0)+1) + ' of ' + N + '</span>';
      return '<tr><td><span class="rk">' + (i+1) + '</span><b>' + esc(r.name) + '</b>' + (r.extra ? '<span class="tag re" title="Only the first try counts">+' + r.extra + ' more tries</span>' : '') + '</td><td>' + esc(r.phone) + '</td><td>' + esc(r.position) + '</td><td class="num"><b>' + (sc ? sc.t : '–') + '</b></td><td class="num">' + (p === null ? '–' : '<span class="pct ' + cls + '">' + p + '%</span>') + '</td><td class="num">' + (sc ? sc.e : '–') + '</td><td class="num">' + (sc ? sc.m : '–') + '</td><td class="num">' + (sc ? sc.h : '–') + '</td><td class="num">' + (r.away ? '<span class="tag re" style="margin:0">' + r.away + '×</span>' : '0') + '</td><td>' + st + '</td></tr>';
    }).join('');
  }
  $('aCode').textContent = secCode && secCode.examId === String(exam.startedAt) ? secCode.code : '------';
  const nSel = clearRows().length, sid = shownId();
  $('aClearText').textContent = 'Delete the ' + nSel + ' saved result' + (nSel === 1 ? '' : 's') + ' of the exam on ' + (sid ? new Date(+sid).toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'}) + ', ' + fmtT(+sid) : '') + '? Results of other exams are kept. Download the mark list first if you need it. This cannot be undone.';
  paintAdminTimes();
}
function paintAdminTimes(){
  if (!isAdmin || $('sAdmin').hidden) return; const s = eff();
  if (s === 'live'){ $('aBig').textContent = mmss(exam.endsAt - Date.now()) + ' left'; $('aTimes').textContent = 'Started at ' + fmtT(exam.liveAt || exam.startedAt) + ' · closes at ' + fmtT(exam.endsAt); }
  else if (s === 'open'){ $('aBig').textContent = 'Ready to start'; $('aTimes').textContent = 'The security code is ready. Share the exam link and the code now: staff can join and wait. Press Start exam when everyone is in.' + (exam.lastId ? ' The marks below are from the last exam.' : ''); }
  else if (exam.startedAt){ $('aBig').textContent = 'Exam closed'; $('aTimes').textContent = 'Last exam opened at ' + fmtT(exam.startedAt) + ' and closed at ' + fmtT(exam.endedAt || exam.endsAt) + '. Its marks stay below until you start a new exam.'; }
  else { $('aBig').textContent = 'Not started'; $('aTimes').textContent = (N ? 'Choose how long the exam stays open and press Start exam. Staff with the exam link can begin straight away.' : 'Add questions to this assessment before starting an exam.'); }
  if (exam.status === 'live' && s === 'ended' && !paintAdminTimes.closing){ paintAdminTimes.closing = true; db.doc(T.state).set(Object.assign({}, exam, {status:'ended', endedAt: exam.endsAt})).finally(() => paintAdminTimes.closing = false); }
}
$('aMins').addEventListener('input', () => { const v = +$('aMins').value; $('aMinsWarn').hidden = !(v && v < needMin()); });
// why the exam can't start yet ('' when it can): needs uploaded questions and a matching answer key
function startBlock(){
  if (!T.uploaded || !N) return 'No questions have been uploaded for the ' + T.name + '. Add the questions in the Questions section below, then start the exam.';
  const a = key && key.answers;
  if (!Array.isArray(a) || !a.length) return 'The correct answers are missing. Add the questions again in the Questions section below, then start the exam.';
  if (a.length !== N || a.some((x, i) => !(x >= 0 && x < QS[i].o.length))) return 'The correct answers don\'t match the ' + N + ' questions. Add the questions again in the Questions section below, then start the exam.';
  return '';
}
// set up the next exam with its security code as soon as questions are ready, so the code can be shared
// before the start; staff can join and wait, and only Start exam opens the questions
let preparing = null;
function prepareExam(force){
  if (preparing) return preparing;
  if (!force && (!isAdmin || startBlock() || !(exam.status === 'idle' || exam.status === 'ended'))) return Promise.resolve();
  const prev = exam, t = Date.now(), code = newCode();
  let done; preparing = new Promise(r => done = r);   // claim the slot before any write, so a repaint can't start a second one
  (async () => {
    await db.doc(T.code).set({code, examId:String(t)});
    const e = {status:'open', startedAt:t, codeHash: await hashCode(code, String(t)), count:N};
    if (prev.startedAt && prev.status !== 'open') e.lastId = String(prev.startedAt);
    await db.doc(T.state).set(e);
    secCode = codes[TR] = {code, examId:String(t)};
  })().then(() => done(), e => { $('aErr').textContent = 'Could not set up the next exam: ' + errText(e) + '. Reload the page to try again.'; done(); }).finally(() => { preparing = null; });
  return preparing;
}
$('aStart').onclick = async () => {
  $('aErr').textContent = '';
  // check the saved copy too, in case questions or key changed in another window
  try {
    const [qs, k] = await Promise.all([db.doc('questions/' + TR).get(), db.doc(T.key).get()]);
    if (qs.exists && Array.isArray(qs.data().qs)) setQs(TR, qs.data().qs); else { T.uploaded = false; }
    key = keys[TR] = k.exists ? k.data() : null;
  } catch(e){ $('aErr').textContent = 'Could not check the questions: ' + errText(e) + '. Try again.'; return; }
  const why = startBlock();
  if (why){ $('aErr').textContent = 'Exam not started. ' + why; paintAdmin(); return; }
  const m = Math.min(180, Math.max(5, +$('aMins').value || 35)), t = Date.now();
  $('aMins').value = m; $('aErr').textContent = ''; $('aStart').disabled = true;
  try {
    if (exam.status !== 'open' || !exam.codeHash || !secCode || secCode.examId !== String(exam.startedAt)) await prepareExam(true);
    const e = Object.assign({}, exam, {status:'live', liveAt:t, endsAt:t+m*60000, windowMin:m, count:N}); delete e.lastId;
    await db.doc(T.state).set(e); fSt = 'all'; fTxt = ''; $('aSearch').value = '';
    msg('Exam started. It closes at ' + fmtT(t+m*60000) + '. Staff who are waiting can now begin answering. Security code: ' + (secCode ? secCode.code : '') + '.');
  }
  catch(e){ $('aErr').textContent = 'Could not start the exam: ' + errText(e) + '. Check your connection and press Start exam again.'; }
  $('aStart').disabled = false;
};
$('aEnd').onclick = () => { endArmed = true; paintAdmin(); $('aEndNo').focus(); };
$('aEndNo').onclick = () => { endArmed = false; paintAdmin(); $('aEnd').focus(); };
$('aEndYes').onclick = async () => {
  $('aEndYes').disabled = true;
  try { await db.doc(T.state).set(Object.assign({}, exam, {status:'ended', endedAt:Date.now()})); endArmed = false; msg('Exam ended at ' + fmtT(Date.now()) + '. Anyone still answering has had their answers saved as they were.'); }
  catch(e){ $('aErr').textContent = 'Could not end the exam: ' + errText(e) + '. Try again.'; }
  $('aEndYes').disabled = false; paintAdmin();
};
// results of the exam picked in "Show results for" (only these are cleared)
const inSel = r => (r.track || 'pharmacist') === TR && shownId() && String(r.examId) === shownId();
const clearRows = () => results.filter(inSel);
$('aClear').onclick = () => {
  if (!clearRows().length){ msg('There are no saved results for this exam.'); return; }
  if (eff() === 'live' && shownId() === marksId(exam)){ msg('This exam is running. End it before clearing its results.'); return; }
  $('aClearBox').hidden = false; paintAdmin(); $('aClearNo').focus();
};
$('aClearNo').onclick = () => { $('aClearBox').hidden = true; $('aClear').focus(); };
$('aClearYes').onclick = async () => {
  if (eff() === 'live' && shownId() === marksId(exam)){ $('aClearBox').hidden = true; msg('This exam is running. End it before clearing its results.'); return; }
  const n = clearRows().length; $('aClearYes').disabled = true;
  try { await Promise.all(Object.keys(rawDocs).map(id => { const o = rawDocs[id], keep = {}; let drop = 0;
      Object.keys(o).forEach(k => { if (k.indexOf('a_') === 0 && inSel(o[k])) drop++; else keep[k] = o[k]; });
      if (!drop) return null; return Object.keys(keep).length ? db.doc('results/' + id).set(keep) : db.doc('results/' + id).delete(); })); $('aClearBox').hidden = true; msg(n + ' result' + (n === 1 ? '' : 's') + ' of this exam deleted. Other exams were not changed.'); }
  catch(e){ msg('Could not delete the results: ' + errText(e) + '. Nothing was changed on your screen; try again.'); }
  $('aClearYes').disabled = false;
};
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { fSt = b.dataset.f; paintAdmin(); });
$('aSearch').addEventListener('input', () => { fTxt = $('aSearch').value; paintAdmin(); });
$('aBody').addEventListener('click', ev => { if (ev.target.closest('[data-clear]')){ fSt = 'all'; fTxt = ''; $('aSearch').value = ''; paintAdmin(); $('aSearch').focus(); } });
const libs = {};
function loadLib(src){ return libs[src] || (libs[src] = new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; if (LIB_SRI[src]){ s.integrity = LIB_SRI[src]; s.crossOrigin = 'anonymous'; } s.onload = ok; s.onerror = () => { delete libs[src]; no(new Error('load')); }; document.head.appendChild(s); })); }
// SheetJS 0.20.3 (0.18.x has known problems reading files); pinned by hash so a changed file is refused
const LIB_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const LIB_SRI = {[LIB_XLSX]: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT'};
const LIB_PDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const LIB_PDFT = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
function markData(){
  const rows = rank(rowsForExam());
  const lc = lvCount(), head = ['Rank','Name','Phone','Position','Score','Out of','Percentage','Easy (' + lc.e + ')','Medium (' + lc.m + ')','Hard (' + lc.h + ')','Answered','Left the test (times)','Status','Started','Finished'];
  const body = rows.map((r,i) => { const s = r.sc || {}; return [i+1, r.name, r.phone, r.position, s.t == null ? '' : s.t, N, s.t == null ? '' : Math.round(s.t/N*100) + '%', s.e == null ? '' : s.e, s.m == null ? '' : s.m, s.h == null ? '' : s.h, s.n == null ? '' : s.n, r.away || 0, r.status === 'submitted' ? 'Submitted' : 'In progress (Q' + Math.min(N,(r.i||0)+1) + ')', r.startedAt ? new Date(r.startedAt).toLocaleString() : '', r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '']; });
  const d0 = new Date(+shownId() || Date.now());
  const stamp = d0.getFullYear() + '-' + String(d0.getMonth()+1).padStart(2,'0') + '-' + String(d0.getDate()).padStart(2,'0');
  return {rows, head, body, stamp, d0};
}
async function logoPng(){
  const img = document.querySelector('.logo img'); const c = document.createElement('canvas');
  c.width = 1683/3; c.height = 406/3; const x = c.getContext('2d');
  if (!img.complete) await new Promise(r => img.onload = r);
  x.drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/png');
}
async function buildFile(kind, m){
  const base = 'SugarCARE_' + TR + '_marklist_' + m.stamp;
  if (kind === 'csv'){
    const q = v => '"' + csvSafe(v).replace(/"/g,'""') + '"';
    return {filename: base + '.csv', data: '﻿' + [m.head].concat(m.body).map(r => r.map(q).join(',')).join('\r\n')};
  }
  if (kind === 'xlsx'){
    await loadLib(LIB_XLSX);
    const ws = XLSX.utils.aoa_to_sheet([m.head].concat(m.body));
    ws['!cols'] = [6,24,14,20,8,8,11,10,12,9,10,12,20,22,22].map(w => ({wch:w}));
    ws['!autofilter'] = {ref: 'A1:O' + (m.body.length + 1)};
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Mark list');
    return {filename: base + '.xlsx', data: XLSX.write(wb, {bookType:'xlsx', type:'array'})};
  }
  await loadLib(LIB_PDF); await loadLib(LIB_PDFT);
  const doc = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  try { doc.addImage(await logoPng(), 'PNG', 12, 10, 46, 11.1); } catch(e){ doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.setTextColor(26,14,80); doc.text('Sugar', 12, 18); doc.setTextColor(232,106,26); doc.text('CARE', 12 + doc.getTextWidth('Sugar'), 18); }
  doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(110,102,140); doc.text('HOMORX HEALTHTECH PVT LTD - KERALA', 12, 25.5);
  doc.setFontSize(15); doc.setTextColor(26,14,80); doc.text(T.name + ' - mark list', W - 12, 15, {align:'right'});
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(92,84,120);
  const done = m.rows.filter(r => r.status === 'submitted').length;
  doc.text('Exam opened ' + m.d0.toLocaleString() + '  |  ' + m.rows.length + ' ' + T.many + ', ' + done + ' submitted', W - 12, 21, {align:'right'});
  doc.setDrawColor(232,106,26); doc.setLineWidth(0.66); doc.line(12, 29, W - 12, 29);
  const cols = [0,1,2,3,4,6,7,8,9,11,12];
  doc.autoTable({
    startY: 33, margin:{left:12, right:12},
    head: [cols.map(c => m.head[c])], body: m.body.map(r => cols.map(c => r[c])),
    styles:{font:'helvetica', fontSize:8.5, textColor:[26,14,80], cellPadding:2.2, lineColor:[232,229,241], lineWidth:0.2},
    headStyles:{fillColor:[74,47,160], textColor:255, fontStyle:'bold', fontSize:7.5},
    alternateRowStyles:{fillColor:[248,247,251]},
    columnStyles:{0:{halign:'right', cellWidth:12}, 1:{fontStyle:'bold'}, 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'right'}, 8:{halign:'right'}, 9:{halign:'right'}},
    didDrawPage: () => { doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(110,102,140); doc.text('Only each person\'s first attempt is counted. Scores out of ' + N + ': Easy ' + lvCount().e + ', Medium ' + lvCount().m + ', Hard ' + lvCount().h + '.', 12, H - 8); doc.text('Page ' + doc.internal.getNumberOfPages(), W - 12, H - 8, {align:'right'}); }
  });
  return {filename: base + '.pdf', data: doc.output('arraybuffer')};
}
document.querySelectorAll('[data-dl]').forEach(b => b.onclick = async () => {
  const kind = b.dataset.dl, label = {csv:'CSV', xlsx:'Excel', pdf:'PDF'}[kind], m = markData();
  if (!m.rows.length) { msg('Nothing to download yet. Rows appear once people start the test.'); return; }
  const btns = document.querySelectorAll('[data-dl]'); btns.forEach(x => x.disabled = true); const old = b.textContent; b.textContent = 'Preparing…';
  try {
    const f = await buildFile(kind, m);
    const d = await claude.use('downloads'); if (!d) throw {code:'unavailable'};
    await d.save(f); msg('Mark list saved as ' + f.filename + '.');
  } catch(e){
    msg(e && e.code === 'declined' ? 'Download cancelled.' : e && e.message === 'load' ? 'Could not prepare the ' + label + ' file. Check your internet connection and try again.' : 'The ' + label + ' download is not available in this view.');
  }
  btns.forEach(x => x.disabled = false); b.textContent = old;
});

$('aCodeCopy').onclick = async () => {
  const c = $('aCode').textContent, b = $('aCodeCopy');
  if (!/^[A-Z0-9]{6}$/.test(c)) return;
  try { await navigator.clipboard.writeText(c); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy code', 2000); }
  catch(e){ msg('Copying is blocked here. The security code is ' + c + '.'); }
};
$('aCodeNew').onclick = async () => {
  if (!canJoin(eff())) return;
  const b = $('aCodeNew'); b.disabled = true;
  try { const code = newCode(), id = String(exam.startedAt); await db.doc(T.code).set({code, examId:id}); await db.doc(T.state).set(Object.assign({}, exam, {codeHash: await hashCode(code, id)})); msg('New security code: ' + code + '. The old code no longer works. Anyone already taking the test carries on.'); }
  catch(e){ $('aErr').textContent = 'Could not make a new code: ' + errText(e) + '. Try again.'; }
  b.disabled = false;
};
$('aCopy').onclick = async () => {
  const b = $('aCopy');
  try { await navigator.clipboard.writeText($('aLink').value); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy link', 2000); }
  catch(e){ $('aLink').focus(); $('aLink').select(); msg('Copying is blocked here. The link is selected: press Ctrl+C (or long-press and copy on a phone).'); }
};
/* ---------- all assessments ---------- */
function applyTrackText(){
  $('topName').textContent = T.name; $('aTitle').textContent = T.name;
  $('fPos').innerHTML = '<option value="">Select your position</option>' + T.positions.map(p => '<option>' + esc(p) + '</option>').join('');
  $('lBlurb').textContent = N ? N + ' questions, ' + SEC + ' seconds each. Fill in your details to join. About ' + needMin() + ' minutes in all.' : 'This assessment is not open yet.';
  $('rN').textContent = N || exam.count || '–';
  $('aNeed').textContent = N ? 'Each person needs about ' + Math.ceil(N * SEC / 60) + ' minutes to answer all ' + N + ' questions (' + SEC + ' seconds each). Keep the exam open a few minutes longer so anyone who joins late can still finish.' : 'This assessment has no questions yet.';
  $('aMinsWarn').textContent = 'Under ' + needMin() + ' minutes, anyone who joins late will be cut off before the last question.';
  $('aMinsWarn').hidden = !(+$('aMins').value < needMin());
  const link = BASE_URL + '#' + TR;
  $('aLink').value = link; $('aShareT').textContent = 'Exam link for ' + T.many;
  $('aWa').href = 'https://wa.me/?text=' + encodeURIComponent('SugarCARE ' + T.name + '. Open this link at exam time, keep the page open until you submit: ' + link);
}
function homeLine(tr){
  const st = states[tr] || {status:'idle'}, live = st.status === 'live' && Date.now() < st.endsAt;
  const id = marksId(st), rs = results.filter(r => (r.track || 'pharmacist') === tr && id && r.examId === id);
  const ph = new Set(rs.map(r => r.phone)).size, sub = new Set(rs.filter(r => r.status === 'submitted').map(r => r.phone)).size;
  return {st, live, ph, sub};
}
function paintHome(){
  if (!isAdmin || $('sHome').hidden) return;
  $('hCards').innerHTML = Object.keys(TRACKS).map(tr => {
    const t = TRACKS[tr], h = homeLine(tr), n = t.qs.length;
    const open = h.st.status === 'open', chipC = h.live ? 'live' : open ? 'idle' : h.st.startedAt ? 'ended' : 'idle', chipT = h.live ? 'Exam is live' : open ? 'Ready to start' : h.st.startedAt ? 'Exam closed' : 'Not started';
    const when = open ? '<span>Code ready, waiting to start</span>' : h.live ? '<span><b data-left="' + tr + '">' + mmss(h.st.endsAt - Date.now()) + '</b> left</span>' : h.st.startedAt ? '<span>Last exam ' + fmtT(h.st.startedAt) + '</span>' : '';
    return '<div class="card hcard"><div class="row between"><h2>' + esc(t.name) + '</h2><span class="chip ' + chipC + '"><i class="dot"></i><span>' + chipT + '</span></span></div>'
      + '<div class="hmeta"><span>' + (n ? '<b>' + n + '</b> questions' : 'No questions yet') + '</span>' + when + (h.st.startedAt ? '<span><b>' + h.ph + '</b> started</span><span><b>' + h.sub + '</b> submitted</span>' : '') + '</div>'
      + '<div><button class="btn btn-lg" type="button" data-open="' + tr + '">Open ' + esc(t.one) + ' dashboard</button></div></div>';
  }).join('');
}
$('hCards').addEventListener('click', ev => { const b = ev.target.closest('[data-open]'); if (b) location.hash = b.dataset.open; });
$('aHome').onclick = () => { location.hash = 'all'; };
function route(){
  if (!isAdmin) return;
  const h = (location.hash || '').slice(1);
  if (TRACKS[h]){
    useTrack(h); applyTrackText(); selExam = ''; fSt = 'all'; fTxt = ''; $('aSearch').value = ''; endArmed = false; $('aClearBox').hidden = true; msg(''); $('aErr').textContent = ''; if (typeof qRepaint === 'function') qRepaint();
    $('who').textContent = 'Invigilator · ' + T.name; show('sAdmin'); paintAdmin(); $('aHome').focus();
  } else { $('who').textContent = 'Invigilator view'; $('topName').textContent = 'All assessments'; show('sHome'); paintHome(); }
}
window.addEventListener('hashchange', () => { if (preview) exitPreview(); else route(); });

/* ---------- test mode (invigilator only) ---------- */
async function startPreview(){
  if (!isAdmin || !N) return;
  preview = true; LS = T.ls + '_test'; lsSet(null);
  const t = Date.now(), code = newCode();
  exam = {status:'live', startedAt:t, endsAt:t + (N * SEC + 600) * 1000, windowMin:Math.ceil(N * SEC / 60) + 10, codeHash: await hashCode(code, String(t))};
  $('pvCode').textContent = code; $('pvBar').hidden = false;
  sess = null; saveFailed = false; finalSaved = null; lastSaved = 0; codeTries = 0; codeLockUntil = 0;
  $('fName').value = 'Test run'; $('fPhone').value = '9000000000'; $('fPos').selectedIndex = 1;
  ['fName','fPhone','fPos','fCode'].forEach(id => fieldErr(id, '')); $('fCode').value = '';
  $('loginErr').hidden = true; $('loginBtn').disabled = false;
  whoLine(); show('sLogin'); statusChip($('stChip')); $('fName').focus();
}
function exitPreview(){
  preview = false; lsSet(null); LS = T.ls; letSleep(); sess = null;
  exam = states[TR] || {status:'idle'}; $('pvBar').hidden = true;
  ['fName','fPhone','fPos','fCode'].forEach(id => { $(id).value = ''; fieldErr(id, ''); }); phoneWarnReset();
  route();
}
$('aTry').onclick = () => startPreview();
$('pvRestart').onclick = () => startPreview();
$('pvExit').onclick = () => exitPreview();

/* ---------- start-up ---------- */
// staff can read the questions only while the exam is live (firestore.rules), so fetch them when it opens
let qsLoading = null;
function loadLiveQs(){
  if (T.uploaded || eff() !== 'live') return Promise.resolve();
  if (!qsLoading) qsLoading = db.doc('questions/' + TR).get().then(q => { if (q.exists && Array.isArray(q.data().qs)) setQs(TR, q.data().qs); }).catch(() => {}).finally(() => { qsLoading = null; refreshReady(); });
  return qsLoading;
}
async function onExam(snap){
  exam = snap.exists ? snap.data() : {status:'idle'};
  const wait = loadLiveQs();
  statusChip($('stChip')); refreshReady(); refreshCode(); paintAdmin();
  if (!firstState){ firstState = true; await wait; resume(); }   // a reload mid-test needs the questions before resuming
}
function resume(){
  if (isAdmin) return;
  const s = lsGet(); if (!s || !s.name) return;
  sess = s;
  if (s.started && !s.done){
    whoLine();
    if (String(exam.startedAt) !== s.examId || eff() !== 'live'){ finish(true); return; }
    showQ(); return;
  }
  if (s.started && s.done){ sess = null; lsSet(null); return; }
  goNext();
}
function applyResults(s){
  resDocs = s.docs.map(d => d.id); results = []; Object.keys(rawDocs).forEach(k => delete rawDocs[k]);
  s.docs.forEach(d => { const o = d.data(); rawDocs[d.id] = o; Object.keys(o).forEach(k => { if (k.indexOf('a_') === 0) results.push(Object.assign({_id:k}, o[k])); }); });
  $('aUpdated').textContent = 'Updated ' + fmtT(Date.now()); paintAdmin(); paintHome();
}
function examLabel(id, first){
  const d = new Date(+id), n = new Set(results.filter(r => (r.track || 'pharmacist') === TR && String(r.examId) === id).map(r => r.phone)).size;
  return (first ? 'Latest exam · ' : '') + d.toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'}) + ', ' + fmtT(+id) + ' · ' + n + ' ' + (n === 1 ? T.one : T.many);
}
function paintExamPicker(){
  const ids = examIds(), sel = $('aExamSel');
  if (selExam && !ids.includes(selExam)) selExam = '';
  const html = ids.length ? ids.map((id, i) => '<option value="' + (i ? id : '') + '">' + esc(examLabel(id, !i)) + '</option>').join('') : '<option value="">No exams yet</option>';
  if (sel.dataset.html !== html){ sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = selExam; sel.disabled = ids.length < 2;
  $('aOldNote').hidden = !selExam;
}
$('aExamSel').onchange = () => { selExam = $('aExamSel').value; fSt = 'all'; fTxt = ''; $('aSearch').value = ''; paintAdmin(); };
$('aRefresh').onclick = async () => {
  const b = $('aRefresh'); b.disabled = true; b.textContent = 'Refreshing…';
  try { applyResults(await db.collection('results').get({source: 'server'})); msg('Mark list refreshed.'); }
  catch(e){ msg('Could not refresh the mark list: ' + errText(e) + '. Check your internet and try again.'); }
  b.disabled = false; b.textContent = 'Refresh';
};
async function boot(){
  { const h = (location.hash || '').slice(1); useTrack(TRACKS[h] ? h : 'pharmacist'); }
  applyTrackText(); show('sLogin'); statusChip($('stChip'));
  ticker = setInterval(tick, 250);
  try { db = await claude.use('db'); user = await claude.use('user'); isAdmin = user ? await user.canEdit() : false; uid = user ? await user.id() : null; } catch(e){ db = null; }
  if (db) await loadQs();
  booted = true;
  if (!db){
    statusChip($('stChip'));
    $('loginErr').textContent = 'Can\'t connect right now. Check your internet and open the link again. If it still doesn\'t work, tell the invigilator.';
    $('loginErr').hidden = false; $('loginBtn').disabled = true; return;
  }
  if (isAdmin){
    route();
    Object.keys(TRACKS).forEach(tr => {
      db.doc(TRACKS[tr].state).onSnapshot(s => { states[tr] = s.exists ? s.data() : {status:'idle'}; if (tr === TR && !preview) exam = states[tr]; paintAdmin(); paintHome(); }, () => {});
      db.doc(TRACKS[tr].key).onSnapshot(s => { keys[tr] = s.exists ? s.data() : null; if (tr === TR) key = keys[tr]; paintAdmin(); if (typeof qRepaint === 'function') qRepaint(); });
      db.doc(TRACKS[tr].code).onSnapshot(s => { codes[tr] = s.exists ? s.data() : null; if (tr === TR) secCode = codes[tr]; paintAdmin(); });
    });
    db.collection('results').onSnapshot(applyResults);
    if (typeof startAdmins === 'function') startAdmins();
  } else db.doc(T.state).onSnapshot(onExam, () => {});
  if (!isAdmin) setTimeout(() => { if (!firstState){ firstState = true; resume(); } }, 3000);
}
boot();
