const SEC = 33, CIRC = 2 * Math.PI * 27;
/* ---------- server clock ----------
   Phones and laptops can be minutes off. Every timing decision (question timer, time left, exam end, code age,
   the start and end times the invigilator writes) uses now() = this device's clock + an offset measured against
   the hosting server's clock (HTTP Date header, re-measured every 10 minutes and when the connection returns).
   Local testing only: ?skew=<ms> on localhost pretends this device's clock is off by that much. */
const SKEW = /^(localhost|127\.0\.0\.\d+)$/.test(location.hostname) ? (Number(new URLSearchParams(location.search).get('skew')) || 0) : 0;
let clockOff = 0, clockOk = false;
const deviceNow = () => Date.now() + SKEW;
const now = () => deviceNow() + clockOff;
async function syncClock(){
  try {
    const t0 = deviceNow(), r = await fetch(location.pathname + '?clock=' + t0, {method: 'HEAD', cache: 'no-store'}), t1 = deviceNow();
    const d = Date.parse(r.headers.get('Date') || '');
    if (d && t1 - t0 < 10000){ clockOff = Math.round(d + 500 - (t0 + t1) / 2); clockOk = true; }   // the header is to the second: +500 ms on average
  } catch(e){}
}
setInterval(syncClock, 600000); window.addEventListener('online', syncClock);
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
async function loadQs(){ await Promise.all(Object.keys(TRACKS).map(tr => db.doc('questions/' + tr).get().then(s => { if (s.exists && Array.isArray(s.data().qs)){ setQs(tr, s.data().qs); TRACKS[tr].qMeta = {at: s.data().updatedAt, by: s.data().updatedBy}; } }).catch(() => {}))); }
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
  if (document.visibilityState === 'hidden'){ sess.away = (sess.away || 0) + 1; sess.awayNote = true; lsSet(sess); write('in_progress'); }
  else { keepAwake(); paintAway(); }
});
function paintAway(){
  const n = (sess && sess.away) || 0, el = $('awayBanner');
  el.hidden = !(n && sess.awayNote);
  el.firstElementChild.textContent = 'You left the test ' + (n === 1 ? 'once' : n + ' times') + '. The invigilator can see this.';
}
$('awayX').onclick = () => { if (sess){ sess.awayNote = false; lsSet(sess); } paintAway(); };
['copy','cut','contextmenu','selectstart','dragstart'].forEach(t => document.addEventListener(t, ev => { if (inTest() && !ev.target.closest('input,select,textarea')) ev.preventDefault(); }));
window.addEventListener('beforeunload', ev => { if (!preview && sess && sess.started && !(sess.done && sess.saved)){ ev.preventDefault(); ev.returnValue = ''; } });
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I, so the code is easy to read out
function newCode(){ const r = new Uint32Array(6); crypto.getRandomValues(r); return Array.from(r, x => CODE_ABC.charAt(x % CODE_ABC.length)).join(''); }
async function hashCode(code, salt){ const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + String(code).toUpperCase())); return Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2,'0')).join(''); }
// the code is checked on the server (firestore.rules) when the waiting record is written. A person's code is
// good for this exam and this code: making a new code sends anyone still waiting back to the code box.
const codeTag = () => String(exam.startedAt) + ':' + (exam.codeAt || 0);
const codeOk = () => preview ? (!exam.codeHash || !!(sess && sess.codeOk === String(exam.startedAt))) : !!(sess && sess.codeOk === codeTag());
const denied = e => !!e && (e.code === 'permission-denied' || /insufficient permissions/i.test(e.message || ''));
const MAX_TRIES = 5;
// version of the privacy notice on the join form (its date). Change it whenever the wording changes; the rules
// accept privacy-YYYY-MM-DD. Stored with each waiting record and attempt, with the server time it was agreed.
const CONSENT_VER = 'privacy-2026-11-05';
let secCode = null, lockedOut = false, lockUnsub = null;
const TICK = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

const show = id => { ['sLogin','sCode','sReady','sQuiz','sDone','sHome','sAdmin'].forEach(s => $(s).hidden = s !== id); try { window.scrollTo(0, 0); } catch(e){} };
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS)); } catch(e){ return null; } };
const lsSet = v => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch(e){} };
// exam stages: idle → open (created with its security code; staff can join and wait) → live (answering) → ended
const canJoin = s => s === 'open' || s === 'live';
// the exam whose marks the dashboard shows: while the next exam waits to start, keep showing the last one's
const marksId = st => st.status === 'open' ? (st.lastId || '') : st.startedAt ? String(st.startedAt) : '';
const eff = () => exam.status === 'live' ? (now() < exam.endsAt ? 'live' : 'ended') : exam.status;
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
let preview = false, offlineState = false;
// re-send the latest state (answers or the final submit) after the connection comes back
function retrySave(){ if (!preview && sess && sess.started && !(sess.done && sess.saved)) write(sess.done ? 'submitted' : 'in_progress'); }
window.addEventListener('online', () => setTimeout(retrySave, 1500));
function whoLine(){ $('who').textContent = sess ? sess.name + ' · ' + sess.phone : ''; }

/* ---------- sign in ---------- */
function fieldErr(id, msg){
  const f = $(id), e = $(id + 'Err');
  e.textContent = msg || ''; e.hidden = !msg;
  f.setAttribute('aria-invalid', msg ? 'true' : 'false');
  f.closest('.field').classList.toggle('bad', !!msg);
}
$('fConsent').addEventListener('change', () => fieldErr('fConsent', ''));
['fName','fPhone','fClinic','fPos'].forEach(id => $(id).addEventListener(id === 'fPos' ? 'change' : 'input', () => fieldErr(id, '')));
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
  const name = $('fName').value.trim().replace(/\s+/g,' '), clinic = $('fClinic').value.trim().replace(/\s+/g,' '), phone = $('fPhone').value.replace(/[^\d]/g,''), pos = $('fPos').value;
  const errs = {};
  if (name.length < 3) errs.fName = name ? 'Enter your full name, at least 3 letters.' : 'Enter your full name.';
  if (phone.length !== 10) errs.fPhone = !phone ? 'Enter your mobile number.' : 'Enter all 10 digits of your mobile number.';
  if (clinic.length < 2) errs.fClinic = 'Enter the clinic you work at.';
  if (!pos) errs.fPos = 'Select your position.';
  if (!$('fConsent').checked) errs.fConsent = 'Tick the box to agree before you continue.';
  let first = null;
  ['fName','fPhone','fClinic','fPos','fConsent'].forEach(id => { fieldErr(id, errs[id]); if (errs[id] && !first) first = id; });
  if (first){ $(first).focus(); $(first).scrollIntoView({block:'center'}); return; }
  sess = {name, phone: phone.slice(-10), clinic, pos, consentVer: CONSENT_VER, started:false};
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
  const locked = lockedOut && !preview;
  $('fCode').disabled = !live || locked; $('codeBtn').disabled = !live || locked;
  if (locked) fieldErr('fCode', 'You have tried ' + MAX_TRIES + ' times. Ask the invigilator to let you try again. This box unlocks by itself when they do.');
  const hadCode = sess && sess.codeOk && String(sess.codeOk).split(':')[0] === String(exam.startedAt);
  $('fCodeHelp').textContent = !db ? 'Can\'t connect right now. Check your internet.'
    : preview ? 'Preview: type the practice code ' + $('pvCode').textContent + ' (shown in the purple bar at the top).'
    : locked ? ''
    : exam.hold ? 'The invigilator cancelled this exam. Wait for a new link or code.'
    : live && hadCode ? 'The invigilator made a new code. Ask for it and type it here.'
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
  if (lockedOut && !preview){ refreshCode(); return; }
  const v = $('fCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 6) { fieldErr('fCode', v ? 'The code has 6 characters. You typed ' + v.length + '.' : 'Enter the 6-character code from the invigilator.'); $('fCode').focus(); return; }
  $('codeBtn').disabled = true; $('codeBtn').textContent = 'Checking…';
  let ok = false, offline = false;
  if (preview){ try { ok = (await hashCode(v, String(exam.startedAt))) === exam.codeHash; } catch(e){} }
  else {
    // joining the waiting list is the check: the server accepts the record only with the right code
    const w = {track:TR, examId:String(exam.startedAt), code:v, codeAt:exam.codeAt || 0, name:sess.name, clinic:sess.clinic || '', phone:sess.phone, position:sess.pos, joinedAt:firebase.firestore.FieldValue.serverTimestamp(), consentVer:sess.consentVer || CONSENT_VER, consentAt:firebase.firestore.FieldValue.serverTimestamp()};
    try { await Promise.race([db.doc('waiting/' + uid + '_' + TR).set(w), new Promise((_, no) => setTimeout(() => no({code:'timeout'}), 12000))]); ok = true; }
    catch(e){ offline = !denied(e); }
  }
  $('codeBtn').disabled = false; $('codeBtn').textContent = 'Continue';
  if (offline){ fieldErr('fCode', 'Could not check the code: the internet connection dropped. Check it and press Continue again.'); return; }
  if (!ok) {
    sess.tries = (sess.tries || 0) + 1; lsSet(sess);
    const left = MAX_TRIES - sess.tries;
    if (left <= 0){
      sess.tries = 0; lsSet(sess);
      if (preview) fieldErr('fCode', 'That code is not right. In a real exam you would now be locked out until the invigilator lets you try again.');
      else {
        lockedOut = true;
        db.doc('lockouts/' + uid + '_' + TR).set({track:TR, examId:String(exam.startedAt), name:sess.name, clinic:sess.clinic || '', phone:sess.phone, at:firebase.firestore.FieldValue.serverTimestamp()}).catch(() => {});
        refreshCode(); return;
      }
    }
    else fieldErr('fCode', 'That code is not right. Check it with the invigilator. ' + left + ' tr' + (left === 1 ? 'y' : 'ies') + ' left.');
    $('fCode').focus(); $('fCode').select(); return;
  }
  if (!preview){ try { const c = (await withTimeout(db.doc('waiting/' + uid + '_' + TR).get())).data().consentAt; sess.consentAt = {s: c.seconds, ns: c.nanoseconds}; sess.consentVer = sess.consentVer || CONSENT_VER; } catch(e){} }
  sess.tries = 0; sess.codeOk = preview ? String(exam.startedAt) : codeTag(); lsSet(sess);
  $('fCode').value = ''; fieldErr('fCode', ''); say('Code accepted'); goReady();
});
$('codeBack').onclick = () => {
  if (sess){ $('fName').value = sess.name; $('fPhone').value = sess.phone; $('fClinic').value = sess.clinic || ''; $('fPos').value = sess.pos; }
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
  const s = eff(), left = (exam.endsAt || 0) - now();
  statusChip($('rChip'));
  $('rN').textContent = (qsReady() && N) || exam.count || '–';
  if (db && s === 'live' && sess && !sess.started && qsReady()) return beginTest();
  // a test already under way whose questions have just arrived (after a reload or a failed first load)
  if (db && s === 'live' && sess && sess.started && !sess.done && firstState && qsReady()) return showQ();
  if (db && s === 'live' && !qsReady() && !qsErr && !qsLoading) loadLiveQs();
  $('rRetry').hidden = !(s === 'live' && qsErr);
  $('rWin').textContent = s === 'live' ? mmss(left) : '–';
  $('rLate').hidden = !(s === 'live' && left < N * SEC * 1000);
  const w = $('rWait'), bad = s === 'live' && qsErr;
  w.className = 'notice ' + (bad ? 'bad' : exam.hold ? 'warn' : 'info'); w.setAttribute('role', bad || exam.hold ? 'alert' : 'status');
  w.textContent = sess && sess.started && !sess.done && !firstState ? 'Reconnecting to your test. Keep this page open: your answers so far are saved.'
    : !db ? 'Can\'t connect right now. Check your internet.'
    : bad ? 'The questions didn\'t load. Check your internet, then press Try again.'
    : s === 'live' ? 'The exam has started. Loading your first question…'
    : exam.hold ? 'The invigilator cancelled this exam. Wait for a new link or code.'
    : s === 'ended' ? 'This exam has ended. Ask the invigilator what to do next.'
    : s === 'open' ? 'You\'re in. Keep this page open: your test starts by itself as soon as the invigilator starts the exam.'
    : 'Keep this page open. Your test starts by itself when the invigilator starts the exam.';
}
$('backBtn').onclick = () => {
  if (sess){ $('fName').value = sess.name; $('fPhone').value = sess.phone; $('fClinic').value = sess.clinic || ''; $('fPos').value = sess.pos; }
  sess = null; lsSet(null); whoLine(); show('sLogin'); $('fName').focus();
};
// the test starts by itself for everyone waiting as soon as the invigilator starts the exam
// (and straight away for anyone who joins while it is already running)
function beginTest(){
  if (!sess || sess.started || eff() !== 'live' || !qsReady() || $('sReady').hidden) return;
  if (!codeOk()) return goCode();
  sess = Object.assign(sess, {started:true, done:false, saved:false, made:false, endsAt:exam.endsAt || 0, examId:String(exam.startedAt), pid:'', i:0, answers:Array(N).fill(-1), sel:-1, away:0, order:makeOrder(), opt:QS.map(q => shuf(q.o.map((_,k) => k))), qStart:now(), t0:now()});
  sess.pid = uid + '_' + TR + '_' + sess.examId;   // one attempt record per person per exam (firestore.rules)
  lsSet(sess); saveFailed = false; write('in_progress'); showQ();
};

/* ---------- saving ---------- */
// Saves the attempt as results/<uid>_<track>_<examId>. The server sets the times (request.time) and checks every
// field; the first save creates the record, later saves change only answers, position, away count and status.
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
function write(status){
  if (preview){ saveFailed = false; lastSaved = now(); if (status === 'submitted') finalSaved = true; paintSave(); return; }
  if (!db || !uid || !sess || !sess.pid) { if (db && !uid) { saveFailed = true; if (status === 'submitted') finalSaved = false; paintSave(); } return; }
  const snap = {answers:sess.answers.slice(), i:sess.i, away:sess.away || 0, status}, my = ++writeSeq;
  const attempt = async n => {
    if (my !== writeSeq) return;   // a newer save is queued and carries every answer: skip this older one
    try {
      const ref = db.doc('results/' + sess.pid);
      let made = sess.made;
      if (!made){ const sn = await withTimeout(ref.get()); made = sn.exists; if (made && sn.data().status === 'submitted'){ sess.made = true; sess.saved = true; lsSet(sess); finalSaved = true; saveFailed = false; paintSave(); return; } }
      const ch = Object.assign({}, snap, {updatedAt:TS()}); if (status === 'submitted') ch.finishedAt = TS();
      if (made) await withTimeout(ref.update(ch));
      else {   // the record is always created as in_progress; a submit that is also the first save follows straight after
        await withTimeout(ref.set(Object.assign({track:TR, examId:sess.examId, uid, name:sess.name, clinic:sess.clinic || '', phone:sess.phone, position:sess.pos, consentVer:sess.consentVer || CONSENT_VER, consentAt:sess.consentAt ? new firebase.firestore.Timestamp(sess.consentAt.s, sess.consentAt.ns) : null, startedAt:TS(), updatedAt:TS()}, snap, {status:'in_progress'})));
        if (status === 'submitted') await withTimeout(ref.update(ch));
      }
      sess.made = true; saveFailed = false; lastSaved = now();
      if (status === 'submitted'){ finalSaved = true; sess.saved = true; }
      lsSet(sess);
    } catch(e){
      // refused because an earlier (delayed) submit already reached the server: that is a success
      if (denied(e)){ try { const sn = await withTimeout(db.doc('results/' + sess.pid).get()); if (sn.exists && sn.data().status === 'submitted'){ sess.made = true; sess.saved = true; lsSet(sess); finalSaved = true; saveFailed = false; paintSave(); return; } } catch(x){} }
      // otherwise refused by the server = the exam has closed for this attempt; retrying won't help
      // no connection (timed out): say so now. The SDK keeps the write and sends it when back online; a newer save also retries.
      if (!denied(e) && e.code !== 'timeout' && n < 3) { await new Promise(r => setTimeout(r, 1500*n)); return attempt(n+1); }
      saveFailed = true; if (status === 'submitted') finalSaved = false;
      if (denied(e)) sess.refused = true;
    }
    paintSave();
  };
  writeQ = writeQ.then(() => attempt(1));
}
// a write that hangs (no connection) counts as failed after 15 s, so the screen can say so; the SDK still sends it later
let writeSeq = 0;
const withTimeout = p => Promise.race([p, new Promise((_, no) => setTimeout(() => no({code:'timeout'}), 15000))]);
function paintSave(){
  $('saveBanner').hidden = !saveFailed;
  $('qSaved').textContent = preview ? 'Preview: not saved' : !saveFailed && lastSaved ? 'Answers saved' : '';
  if ($('sDone').hidden) return;
  const el = $('dSave'), fs = finalSaved;
  el.className = 'savestate ' + (fs === true ? 'ok' : fs === false ? 'bad' : 'wait');
  el.textContent = preview ? 'Preview: nothing was saved.' : fs === true ? 'Your answers are saved. You can close this page.'
    : fs === false && sess && sess.refused ? 'The exam closed before your last answers reached the invigilator. The answers saved before that are kept. Show this screen to the invigilator.'
    : fs === false ? 'Your answers were not saved. Check your internet and try again. If it still fails, show this screen to the invigilator before you leave.'
    : 'Saving your answers…';
  $('dTick').className = 'bigtick' + (fs === true ? '' : ' wait');
  // refused by the server (exam closed) is final: no Try again, and Finish (nothing more can be saved)
  const refused = !!(sess && sess.refused);
  $('retryBtn').hidden = fs !== false || refused;
  $('doneBtn').disabled = fs === null;
  $('doneBtn').textContent = preview ? 'Back to dashboard' : fs === false && !refused ? 'Leave without saving' : 'Finish';
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
  warned10 = false; qShownAt = now();
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
  if (now() - qShownAt < 400) return;   // stops a double tap from skipping the next question
  ensureOrder(); record(); sess.i++; sess.sel = -1; sess.qStart = now();
  if (sess.i >= N) return finish();
  lsSet(sess); write('in_progress'); showQ();
}
function finish(closed){
  ensureOrder(); if (closed && sess.i < N) record();
  // closed by the clock = time up; closed while time was left = the invigilator ended the exam early
  sess.done = true; sess.closed = closed ? (now() < (sess.endsAt || 0) - 3000 ? 'ended' : 'timeup') : ''; letSleep(); lsSet(sess); finalSaved = null; write('submitted');
  if (!db) finalSaved = false;
  paintDone();
}
function paintDone(){
  const closed = sess.closed;
  show('sDone');
  const answered = sess.answers.filter(x => x >= 0).length;
  $('dTitle').textContent = closed === 'ended' ? 'Exam ended' : closed ? 'Time is up' : 'Test submitted';
  $('dMsg').textContent = (closed === 'ended' ? 'The invigilator ended the exam. Your answers so far were submitted. '
      : closed ? 'Time is up. Your answers so far were submitted. ' : 'Thank you. ')
    + 'You answered ' + answered + ' of ' + N + ' questions. The invigilator will share the results.';
  const pv = $('dScore'); pv.hidden = !preview;
  if (preview){ const sc = previewScore(sess.answers), lc = lvCount();
    pv.textContent = sc ? 'Your score in this preview: ' + sc.t + ' / ' + N + ' (' + Math.round(sc.t / N * 100) + '%) · Easy ' + sc.e + '/' + lc.e + ' · Medium ' + sc.m + '/' + lc.m + ' · Hard ' + sc.h + '/' + lc.h + '. Staff never see their score; it only shows here in the preview.' : 'The correct answers are not saved yet, so no score can be shown.'; }
  paintSave();
  say($('dTitle').textContent);
}
$('doneBtn').onclick = () => {
  if (preview) return exitPreview();
  $('fConsent').checked = false; fieldErr('fConsent', '');
  sess = null; lsSet(null); ['fName','fPhone','fClinic','fPos'].forEach(id => { $(id).value = ''; fieldErr(id, ''); }); phoneWarnReset();
  whoLine(); show('sLogin');
};

function tick(){
  if (isAdmin && !preview){ paintAdminTimes(); document.querySelectorAll('[data-left]').forEach(el => { const st = states[el.dataset.left]; if (st && st.endsAt) el.textContent = mmss(st.endsAt - now()); }); return; }
  if (sess && sess.started && !sess.done){
    // nothing moves until the real exam state AND the questions have arrived: with no questions loaded (N = 0)
    // the catch-up below would otherwise think the test is over and submit it
    // questions loaded for THIS session's exam (not the current one: when the invigilator ends early the next exam
    // is set up at once, and the test must still close and submit)
    const mine = preview || (!!N && T.qsFor === sess.examId);
    if (!firstState || !mine || !sess.order || sess.order.length !== N){ refreshReady(); return; }
    if (eff() !== 'live'){ return finish(true); }
    let el = now() - sess.qStart, changed = false;
    ensureOrder();
    while (el >= SEC*1000 && sess.i < N){ record(); sess.i++; sess.sel = -1; sess.qStart += SEC*1000; el -= SEC*1000; changed = true; }
    if (changed){ if (sess.i >= N) return finish(); lsSet(sess); write('in_progress'); return showQ(); }
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
// Each exam keeps its own frozen copy of the questions and answer key (exams/<track>_<examId>, written in the
// same step that starts it) and its saved scores (marks/<track>_<examId>). Marks and downloads read only
// these, never the current question bank, so uploading new questions can't change past marks.
const exams = {};
let waits = [], locks = [], examsReady = false, lastUpd = 0;
const fzId = (tr, id) => tr + '_' + id;
const frozen = (id, tr = TR) => exams[fzId(tr, id)] || null;
const lvOf = qs => ({e: qs.filter(q => q.l === 'Easy').length, m: qs.filter(q => q.l === 'Medium').length, h: qs.filter(q => q.l === 'Hard').length});
function calcScore(answers, fz){
  const k = fz.answers || [], o = {t:0, e:0, m:0, h:0, n:0, of: fz.qs.length};
  for (let i = 0; i < fz.qs.length; i++){ const a = answers[i]; if (a >= 0) o.n++; if (a === k[i]){ o.t++; const l = fz.qs[i].l; if (l === 'Easy') o.e++; else if (l === 'Medium') o.m++; else o.h++; } }
  o.pct = o.of ? Math.round(o.t / o.of * 100) : 0; return o;
}
// The score is ALWAYS worked out here from the attempt's answers and that exam's frozen key. Nothing a staff
// page writes (any score, percent or level field) is ever read. Saved marks records are no longer used.
const scoreOf = r => { const fz = frozen(String(r.examId), r.track || 'pharmacist'); return fz ? calcScore(r.answers || [], fz) : null; };
// preview runs use the current questions (nothing is saved)
const previewScore = a => key && Array.isArray(key.answers) ? calcScore(a, {qs: QS, answers: key.answers}) : null;
// Every record staff can write is cleaned here before use: ids must be digits, numbers are numbers, text is plain
// text of a set length, times are numbers. Anything that doesn't fit is dropped.
const msOf = v => v && typeof v.toMillis === 'function' ? v.toMillis() : (Number.isFinite(+v) ? +v : 0);
const intOf = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0; };
const txt = (v, n) => String(v == null ? '' : v).slice(0, n);
const EXAM_ID = /^[0-9]{1,20}$/;
function normAttempt(o, key, doc){
  if (!o || typeof o !== 'object') return null;
  const examId = String(o.examId == null ? '' : o.examId); if (!EXAM_ID.test(examId)) return null;
  return {_id: key, _doc: doc, track: TRACKS[o.track] ? o.track : 'pharmacist', examId,
    name: txt(o.name, 60), clinic: txt(o.clinic, 60), phone: txt(o.phone, 15).replace(/\D/g, ''), position: txt(o.position, 60),
    answers: Array.isArray(o.answers) ? o.answers.slice(0, 1000).map(x => Number.isInteger(x) && x >= -1 && x <= 9 ? x : -1) : [],
    i: intOf(o.i, 1000), away: intOf(o.away, 1000), status: o.status === 'submitted' ? 'submitted' : 'in_progress',
    startedAt: msOf(o.startedAt) || now(), finishedAt: msOf(o.finishedAt)};
}
const normPerson = (o, id) => ({_id: txt(id, 200), track: TRACKS[o.track] ? o.track : '', examId: EXAM_ID.test(String(o.examId)) ? String(o.examId) : '',
  name: txt(o.name, 60), clinic: txt(o.clinic, 60), phone: txt(o.phone, 15).replace(/\D/g, ''), codeAt: msOf(o.codeAt), joinedAt: msOf(o.joinedAt) || msOf(o.at)});
// exams that ran before frozen copies existed: freeze them once with the questions in use at the time of this update
const freezing = new Set();
function freezeOld(){
  if (!isAdmin || !examsReady) return;
  results.forEach(r => {
    const tr = r.track || 'pharmacist', id = String(r.examId || ''), k = fzId(tr, id), t = TRACKS[tr];
    if (!id || exams[k] || freezing.has(k)) return;
    const ans = keys[tr] && keys[tr].answers;
    if (!t || !t.uploaded || !Array.isArray(ans) || ans.length !== t.qs.length) return;
    freezing.add(k);
    db.doc('exams/' + k).get().then(s => s.exists ? null : db.doc('exams/' + k).set({track: tr, examId: id, qs: t.qs, answers: ans, legacy: true, frozenAt: now()}))
      .catch(() => freezing.delete(k));
  });
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDay = t => { const d = new Date(+t); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };
const fmtD = t => t ? fmtDay(t) + ', ' + fmtT(t) : '–';
const curId = () => exam.startedAt ? String(exam.startedAt) : '';
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
// staff who entered the current code for the current exam and haven't started yet
function people(){
  const id = curId();
  const all = id && canJoin(exam.status) ? waits.filter(w => w.track === TR && w.examId === id) : [];
  const st = new Set(results.filter(r => (r.track || 'pharmacist') === TR && String(r.examId) === id).map(r => r.phone));
  return {all, waiting: all.filter(w => !st.has(w.phone) && w.codeAt === (exam.codeAt || 0)).sort((a, b) => a.joinedAt - b.joinedAt)};
}
const myLocks = () => locks.filter(l => l.track === TR);

/* mark list: which exams exist, newest first */
let selExam = '';
function examState(id){ if (id === curId()){ if (exam.status === 'open') return 'notstarted'; if (eff() === 'live') return 'live'; } return 'finished'; }
function examList(){
  const ids = new Set();
  results.forEach(r => { if ((r.track || 'pharmacist') === TR && r.examId) ids.add(String(r.examId)); });
  Object.values(exams).forEach(e => { if (e.track === TR && e.examId) ids.add(String(e.examId)); });
  if (curId() && exam.status !== 'idle') ids.add(curId());
  return [...ids].sort((a, b) => +b - +a).map(id => ({id, st: examState(id)}));
}
// the picker opens on the live exam if one is running, otherwise on the last finished one
const lastFinished = l => { const f = l.find(x => x.st === 'finished'); return f ? f.id : ''; };
function shownId(){
  const l = examList();
  if (selExam && l.some(x => x.id === selExam)) return selExam;
  const lv = l.find(x => x.st === 'live'); return lv ? lv.id : lastFinished(l) || (l[0] ? l[0].id : '');
}
const examTime = id => { const fz = frozen(id); return (fz && fz.liveAt) || +id; };
const examName = id => fmtD(examTime(id)) + ' exam';
function rowsForExam(id = shownId()){
  const cur = results.filter(r => id && (r.track || 'pharmacist') === TR && String(r.examId) === id);
  const byPhone = {};
  cur.sort((a,b) => (a.startedAt||0) - (b.startedAt||0)).forEach(r => { (byPhone[r.phone] = byPhone[r.phone] || []).push(r); });
  return Object.values(byPhone).map(list => Object.assign({}, list[0], {extra: list.length - 1, sc: scoreOf(list[0])}));
}
function rank(rows){ return rows.slice().sort((a,b) => ((b.sc?b.sc.t:-1)-(a.sc?a.sc.t:-1)) || ((a.finishedAt||9e15)-(b.finishedAt||9e15))); }
// questions and level counts of an exam: its frozen copy, or the current set for an exam not started yet
function examQs(id){ const fz = frozen(id); return fz ? fz.qs : QS; }

// popup message: problems stay until OK; other messages close after a few seconds
let msgTimer = null;
function msg(t, sticky){
  const el = $('aMsg'); clearTimeout(msgTimer);
  if (!t){ el.classList.remove('show'); msgTimer = setTimeout(() => { el.hidden = true; }, 200); return; }
  const bad = /^(could not|this exam is running|end the exam|there are no|choose the excel|nothing to download)/i.test(t);
  $('aMsgT').textContent = t; el.classList.toggle('bad', bad); el.classList.toggle('info', !bad); el.setAttribute('role', bad ? 'alert' : 'status');
  el.hidden = false; requestAnimationFrame(() => el.classList.add('show'));
  if (!bad && !sticky) msgTimer = setTimeout(() => msg(''), Math.min(12000, 4000 + t.length * 40));
}
$('aMsgX').onclick = () => msg('');
$('aMsg').addEventListener('mouseenter', () => clearTimeout(msgTimer));
$('aMsg').addEventListener('mouseleave', () => { if (!$('aMsg').classList.contains('bad') && !$('aMsg').hidden) msgTimer = setTimeout(() => msg(''), 3000); });

let startBusy = false, codeArmed = false, cancelArmed = false, oldCodeFixed = '';
function minsErr(){
  const raw = $('aMins').value.trim(), v = Number(raw);
  if (!raw) return 'Enter how many minutes the exam stays open.';
  if (!Number.isInteger(v) || v < 5 || v > 180) return 'Choose a whole number of minutes from 5 to 180.';
  return '';
}
function paintStart(){
  const m = minsErr(), v = +$('aMins').value, n = people().waiting.length;
  $('aMinsErr').textContent = m; $('aMinsErr').hidden = !m;
  $('aMins').closest('.field').classList.toggle('bad', !!m); $('aMins').setAttribute('aria-invalid', String(!!m));
  $('aMinsWarn').hidden = !!m || !(v < needMin());
  $('aStart').disabled = !!m || startBusy || !!startBlock() || !(exam.status === 'open' || exam.hold);
  $('aStart').textContent = startBusy ? 'Starting…' : n ? 'Start exam for ' + n + ' waiting' : 'Start exam';
}
$('aMins').addEventListener('input', paintStart);

function paintAdmin(){
  if (!isAdmin || $('sAdmin').hidden) return;
  const s = eff(), live = s === 'live', open = exam.status === 'open', cid = curId();
  if (!preview && !exam.hold && (exam.status === 'idle' || exam.status === 'ended')) prepareExam();
  // codes made before code times were saved get replaced once, so the server can check them
  if (!preview && open && secCode && secCode.examId === cid && !secCode.madeAt && oldCodeFixed !== cid){ oldCodeFixed = cid; makeCode().catch(() => {}); }
  const p = people();

  // stat tiles: the current exam
  const cur = rowsForExam(cid), sub = cur.filter(r => r.status === 'submitted'), sc = sub.map(r => r.sc).filter(Boolean);
  $('sWait').textContent = p.waiting.length;
  $('sStart').textContent = cur.length; $('sStartU').textContent = 'of ' + Math.max(p.all.length, cur.length) + ' waiting';
  $('sProg').textContent = cur.length - sub.length; $('sSub').textContent = sub.length;
  $('sAvg').textContent = sc.length ? (sc.reduce((x, o) => x + o.t, 0) / sc.length).toFixed(1) : '–';
  $('sAvgU').textContent = 'out of ' + examQs(cid).length;

  // step 2: the code
  const code = secCode && secCode.examId === cid && canJoin(exam.status) ? secCode.code : '';
  $('aCode').textContent = code || '------';
  $('aCode').setAttribute('aria-label', code ? 'Security code ' + code.split('').join(' ') : 'Security code not ready');
  $('aCodeCopy').disabled = !code; $('aCodeNew').disabled = !canJoin(exam.status) || preview;
  $('aCodeMeta').textContent = !code ? (canJoin(exam.status) ? 'No code is saved for this exam. Press Make a new code.' : startBlock() ? 'The code appears here once the questions are ready.' : 'Making the code…')
    : (secCode.madeAt ? 'Made ' + fmtD(secCode.madeAt) + '. ' : '') + (live ? 'Anyone who joins now needs this code.' : 'If you press Start more than 2 hours after this, a fresh code is made for you.');
  if (exam.hold && !live) $('aCodeMeta').textContent = 'No exam is set up, so the questions can be changed. When they are ready, press Set up exam to make the security code, or just press Start.';
  $('aSetupWrap').hidden = !(exam.hold && !live) || preview; $('aSetup').disabled = !!startBlock() || startBusy;
  if (exam.status !== 'open' || preview) cancelArmed = false;
  $('aCancelWrap').hidden = exam.status !== 'open' || preview || cancelArmed; $('aCancelBox').hidden = !cancelArmed;
  $('aCancelQ').innerHTML = '<b>Cancel this exam?</b> ' + (code ? 'The code ' + esc(code) + ' stops working' : 'The exam is taken down') + (p.waiting.length ? ' and the ' + esc(plural(p.waiting.length, 'person', 'people')) + ' waiting will need a new code later' : '') + '. Questions can then be changed. Nothing is deleted.';
  if (!code) codeArmed = false;
  $('aCodeBox').hidden = !codeArmed;
  $('aCodeQ').innerHTML = !code ? '<b>Make a code for this exam?</b> Staff need it to join.' : '<b>Make a new code?</b> ' + (p.waiting.length ? esc(plural(p.waiting.length, 'person is', 'people are')) + ' waiting with ' + esc(code) + '. They will need the new code to get in.' : 'Nobody is waiting with ' + esc(code) + ' right now.') + ' Anyone already answering carries on.';
  $('aCodeNo').textContent = 'Keep ' + (code || 'this code');

  // step 3: start / running
  $('aIdle').hidden = live; $('aLiveRow').hidden = !live;
  if (!live) endArmed = false;
  $('aEnd').hidden = endArmed; $('aEndBox').hidden = !endArmed;
  const nProg = cur.length - sub.length;
  $('aEndText').textContent = nProg ? 'End the exam now? ' + plural(nProg, T.one + ' is', T.many + ' are') + ' still taking the test. Their answers so far will be submitted.'
    : 'End the exam now? Nobody is taking the test at the moment. No one else will be able to start.';
  { const why = startBlock(); $('aNoQs').textContent = why ? 'Start exam is blocked. ' + why : ''; $('aNoQs').hidden = !why || live; }
  $('aTry').disabled = !N;
  paintStart();

  // who's in
  $('waitT').textContent = 'Waiting to start · ' + p.waiting.length;
  $('aPeople').innerHTML = p.waiting.length ? p.waiting.map(w => '<li><span><b>' + esc(w.name) + '</b> · ' + esc(w.clinic) + '</span><span class="t">joined ' + fmtT(w.joinedAt) + '</span></li>').join('')
    : '<li class="none">' + (live ? 'Everyone who entered the code has started.' : open ? 'No one yet.' : 'No exam is set up yet.') + '</li>';
  const lk = myLocks();
  $('aLocks').innerHTML = 'Staff appear here after they enter the security code.' + (lk.length ? ' Locked out after 5 wrong tries: '
    + lk.map(l => '<b>' + esc(l.name || 'Someone') + '</b>' + (l.clinic ? ' (' + esc(l.clinic) + ')' : '') + ' · <button class="link" type="button" data-unlock="' + esc(l._id) + '">Let them try again</button>').join('; ') : '');

  paintMarks();
  if (typeof paintQs === 'function') paintQs();
  paintAdminTimes();
}

function paintMarks(){
  const list = examList(), id = shownId(), st = id ? examState(id) : '', qs = examQs(id), lc = lvOf(qs), n = qs.length;
  // picker
  const sel = $('aExamSel');
  const html = list.length ? list.map(x => '<option value="' + esc(x.id) + '">' + esc(x.st === 'notstarted' ? fmtDay(+x.id) + ' · not started yet · ' + people().waiting.length + ' waiting'
    : fmtD(examTime(x.id)) + ' · ' + (x.st === 'live' ? 'live now' : 'finished') + ' · ' + plural(new Set(rowsForExam(x.id).map(r => r.phone)).size, T.one, T.many)) + '</option>').join('') : '<option value="">No exams yet</option>';
  if (sel.dataset.html !== html){ sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = id; sel.disabled = list.length < 2;
  $('mSub').innerHTML = !id ? 'No exams yet' : st === 'notstarted' ? 'Showing <b>' + esc(fmtDay(+id)) + '</b> · not started yet'
    : 'Showing <b>' + esc(examName(id)) + '</b> · ' + (st === 'live' ? 'live' : 'finished') + ' · <i class="live"></i>updates live' + (lastUpd ? ', last ' + fmtT(lastUpd) : '');
  $('thS').textContent = 'Score /' + n; $('thE').textContent = 'Easy /' + lc.e; $('thM').textContent = 'Medium /' + lc.m; $('thH').textContent = 'Hard /' + lc.h;

  const all = rank(rowsForExam(id)), done = all.filter(r => r.status === 'submitted').length;
  $('cAll').textContent = all.length; $('cRun').textContent = all.length - done; $('cSub').textContent = done;
  document.querySelectorAll('.seg button[data-f]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === fSt)));
  const q = fTxt.trim(), ql = q.toLowerCase(), qd = q.replace(/\D/g, '');
  const hit = r => !q || String(r.name).toLowerCase().includes(ql) || String(r.clinic || '').toLowerCase().includes(ql) || (qd.length >= 3 && String(r.phone).includes(qd));
  const rows = all.map((r, i) => ({r, i})).filter(({r}) => (fSt === 'all' || (fSt === 'sub' ? r.status === 'submitted' : r.status !== 'submitted')) && hit(r));
  const filtered = q || fSt !== 'all', res = $('aRes'), cols = 10;
  if (st === 'notstarted'){
    res.innerHTML = '';
    const lf = lastFinished(list), w = people().waiting.length;
    $('aBody').innerHTML = '<tr><td colspan="' + cols + '" class="empty"><b>This exam hasn\'t started yet</b><p>' + esc(plural(w, 'person is', 'people are')) + ' waiting. Their marks will appear here as they finish.'
      + (lf ? ' To see earlier marks, choose a finished exam above.</p><button class="btn btn-ghost" type="button" data-go="' + esc(lf) + '">Show ' + esc(examName(lf)) + '</button>' : '</p>') + '</td></tr>';
    return;
  }
  res.innerHTML = filtered && all.length ? 'Showing <b>' + rows.length + ' of ' + all.length + '</b> in the ' + esc(examName(id)) + (q ? ' matching “' + esc(q) + '”' : '')
    + (fSt !== 'all' ? ' · ' + (fSt === 'run' ? 'in progress' : 'submitted') + ' only' : '') + ' <button class="link" type="button" data-clear="1">Clear search and filter</button>' : '';
  if (!all.length){
    $('aBody').innerHTML = '<tr><td colspan="' + cols + '" class="empty"><b>' + (st === 'live' ? 'No one has started yet' : 'No results for this exam') + '</b><p>'
      + (st === 'live' ? 'Rows appear here as each ' + esc(T.one) + ' starts.' : 'Pick another exam above.') + '</p></td></tr>';
    return;
  }
  if (!rows.length){
    $('aBody').innerHTML = '<tr><td colspan="' + cols + '" class="empty"><b>No one matches “' + esc(q || (fSt === 'run' ? 'In progress' : 'Submitted')) + '”</b><p>Check the spelling, try part of the name, or search the last 4 digits of the phone number. Search looks only in the '
      + esc(examName(id)) + '.</p><button class="btn btn-ghost" type="button" data-clear="1">Clear search and filter</button></td></tr>';
    return;
  }
  const hl = t => { t = String(t == null ? '' : t); if (!ql) return esc(t); const i = t.toLowerCase().indexOf(ql); return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + ql.length)) + '</mark>' + esc(t.slice(i + ql.length)); };
  const hlPh = t => { t = String(t || ''); const i = qd.length >= 3 ? t.indexOf(qd) : -1; return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(qd) + '</mark>' + esc(t.slice(i + qd.length)); };
  $('aBody').innerHTML = rows.map(({r, i}) => {
    const sc = r.sc, p = sc ? sc.pct : null, cls = p === null ? '' : p >= 70 ? 'hi' : p >= 50 ? 'mid' : 'lo';
    const stt = r.status === 'submitted' ? '<span class="tag sub">Submitted</span>' : st === 'finished' ? '<span class="tag re" style="margin:0" title="The exam closed before this person submitted. The answers saved until then are marked.">Not submitted</span>' : '<span class="tag run">On Q' + Number(Math.min(n, (r.i||0)+1)) + ' of ' + Number(n) + '</span>';
    return '<tr><td><span class="rk">' + (i+1) + '</span><b>' + hl(r.name) + '</b>' + (r.extra ? '<span class="tag re" title="Only the first try counts">+' + Number(r.extra) + ' more tries</span>' : '') + '</td><td>' + (r.clinic ? hl(r.clinic) : '<span class="muted">–</span>') + '</td><td>' + hlPh(r.phone)
      + '</td><td class="num"><b>' + (sc ? Number(sc.t) : '–') + '</b></td><td class="num">' + (p === null ? '–' : '<span class="pct ' + cls + '">' + Number(p) + '%</span>') + '</td><td class="num">' + (sc ? Number(sc.e) : '–') + '</td><td class="num">' + (sc ? Number(sc.m) : '–') + '</td><td class="num">' + (sc ? Number(sc.h) : '–')
      + '</td><td class="num">' + (r.away ? '<span class="tag re" style="margin:0">' + Number(r.away) + '×</span>' : '0') + '</td><td>' + stt + '</td></tr>';
  }).join('');
}
function paintAdminTimes(){
  if (!isAdmin || $('sAdmin').hidden) return; const s = eff();
  if (s === 'live'){
    const left = mmss(exam.endsAt - now());
    chip($('aChip'), 'live', 'Exam is live · ' + left + ' left');
    $('aBig').textContent = left + ' left'; $('aTimes').textContent = 'Started at ' + fmtT(exam.liveAt || exam.startedAt) + ' · closes at ' + fmtT(exam.endsAt) + '.';
  }
  else if (preview) chip($('aChip'), 'idle', 'Preview');
  else if (exam.status === 'open') chip($('aChip'), 'idle', 'Ready · not started');
  else if (exam.hold) chip($('aChip'), 'idle', 'Not set up');
  else if (exam.startedAt) chip($('aChip'), 'ended', 'Exam has ended');
  else chip($('aChip'), 'idle', N ? 'Getting ready…' : 'No questions yet');
  if (exam.status === 'live' && s === 'ended' && !paintAdminTimes.closing){ paintAdminTimes.closing = true; examTx((t, cur) => { if (cur.status === 'live' && String(cur.startedAt) === curId() && now() >= cur.endsAt){ t.set(db.doc(T.state), Object.assign({}, cur, {status: 'ended', endedAt: cur.endsAt})); return true; } return false; }).then(ok => ok ? clearWaiting(TR) : null).catch(() => {}).finally(() => paintAdminTimes.closing = false); }
}
// why the exam can't start yet ('' when it can): needs uploaded questions and a matching answer key
function startBlock(){
  if (!T.uploaded || !N) return 'No questions have been uploaded for the ' + T.name + '. Add the questions in the Questions section below, then start the exam.';
  const a = key && key.answers;
  if (!Array.isArray(a) || !a.length) return 'The correct answers are missing. Add the questions again in the Questions section below, then start the exam.';
  if (a.length !== N || a.some((x, i) => !(x >= 0 && x < QS[i].o.length))) return 'The correct answers don\'t match the ' + N + ' questions. Add the questions again in the Questions section below, then start the exam.';
  return '';
}
// waiting list and lockouts of an assessment are cleared when its exam ends (or a new one is set up)
function clearWaiting(tr, keepId){
  const ws = waits.filter(w => w.track === tr && w.examId !== keepId), ls = keepId ? [] : locks.filter(l => l.track === tr);
  return Promise.all(ws.map(w => db.doc('waiting/' + w._id).delete()).concat(ls.map(l => db.doc('lockouts/' + l._id).delete()))).catch(() => {});
}
// a fresh security code for the current exam: the old one stops working at once
// Every change to an exam's state is one Firestore transaction: it reads the current state, checks it is still
// the exam this window acted on, and only then writes. A second invigilator window (or a double tap) that loses
// the race writes nothing and gets 'stale', then shows the latest state.
const STALE = 'This exam was changed in another window. The screen now shows the latest.';
function examTx(fn){
  return db.runTransaction(async t => { const sn = await t.get(db.doc(T.state)); return fn(t, sn.exists ? sn.data() : {status: 'idle'}); });
}
// a fresh security code for the current exam: the old one stops working at once
async function makeCode(){
  const id = curId();
  const r = await examTx((t, cur) => {
    if (String(cur.startedAt) !== id || !canJoin(cur.status)) return {stale: true};
    const code = newCode(), at = now(), e = Object.assign({}, cur, {codeAt: at}); delete e.codeHash;
    t.set(db.doc(T.code), {code, examId: id, madeAt: at}); t.set(db.doc(T.state), e);
    return {code, e, at};
  });
  if (r.stale) throw new Error(STALE);
  secCode = codes[TR] = {code: r.code, examId: id, madeAt: r.at}; exam = states[TR] = r.e;
  return r.code;
}
// set up the next exam with its security code as soon as questions are ready, so the code can be shared
// before the start; staff can join and wait, and only Start exam opens the questions
let preparing = null;
function prepareExam(force){
  if (preparing) return preparing;
  if (!force && (!isAdmin || startBlock() || exam.hold || !(exam.status === 'idle' || exam.status === 'ended'))) return Promise.resolve();
  let done; preparing = new Promise(r => done = r);   // claim the slot before any write, so a repaint can't start a second one
  examTx((t, cur) => {
    // another window (or person) already set one up: use theirs, never make a second exam or code
    if (cur.status === 'open' || cur.status === 'live') return null;
    if (cur.hold && !force) return null;
    const at = now(), code = newCode(), e = {status: 'open', startedAt: at, codeAt: at, count: N};
    if (cur.startedAt && cur.status !== 'open') e.lastId = String(cur.startedAt); else if (cur.lastId) e.lastId = cur.lastId;
    t.set(db.doc(T.code), {code, examId: String(at), madeAt: at}); t.set(db.doc(T.state), e);
    return {code, id: String(at), at, e};
  }).then(r => { if (r){ secCode = codes[TR] = {code: r.code, examId: r.id, madeAt: r.at}; exam = states[TR] = r.e; clearWaiting(TR, r.id); } done(); },
    e => { $('aErr').textContent = 'Could not set up the next exam: ' + errText(e) + '. Reload the page to try again.'; done(); }).finally(() => { preparing = null; });
  return preparing;
}
$('aStart').onclick = async () => {
  $('aErr').textContent = '';
  if (minsErr()){ paintStart(); $('aMins').focus(); return; }
  startBusy = true; paintStart();
  try {
    // check the saved copy too, in case questions or key changed in another window
    const [qs, k] = await Promise.all([db.doc('questions/' + TR).get(), db.doc(T.key).get()]);
    if (qs.exists && Array.isArray(qs.data().qs)) setQs(TR, qs.data().qs); else T.uploaded = false;
    key = keys[TR] = k.exists ? k.data() : null;
    const why = startBlock();
    if (why) throw new Error('Exam not started. ' + why);
    if (exam.status !== 'open' || !secCode || secCode.examId !== curId()) await prepareExam(true);
    let note = '';
    if (now() - ((secCode && secCode.madeAt) || 0) > 2 * 3600e3){
      const c = await makeCode();
      note = ' The security code was more than 2 hours old, so a fresh code was made: ' + c + '. Anyone who hasn\'t joined yet needs this new code.';
    }
    const n = people().waiting.length, m = +$('aMins').value, id = curId();
    // start + freeze this exam's questions and answers in one transaction, only if it is still this ready exam
    const e = await examTx((t, cur) => {
      if (cur.status !== 'open' || String(cur.startedAt) !== id) return null;
      const at = now(), e = Object.assign({}, cur, {status: 'live', liveAt: at, endsAt: at + m * 60000, windowMin: m, count: N}); delete e.lastId; delete e.codeHash;
      t.set(db.doc('exams/' + fzId(TR, id)), {track: TR, examId: id, qs: QS, answers: key.answers.slice(0, N), liveAt: at, endsAt: e.endsAt, windowMin: m, startedBy: (typeof myEmail === 'string' && myEmail) || '', frozenAt: at});
      t.set(db.doc(T.state), e);
      return e;
    });
    if (!e) throw new Error(STALE);
    fSt = 'all'; fTxt = ''; $('aSearch').value = ''; selExam = ''; codeArmed = false;
    msg('Exam started for ' + plural(n, 'person', 'people') + ' waiting. It closes at ' + fmtT(e.endsAt) + '.' + note, !!note);
  }
  catch(e){ $('aErr').textContent = /^Exam not started/.test(e.message || '') || e.message === STALE ? e.message : 'Could not start the exam: ' + errText(e) + '. Check your connection and press Start exam again.'; }
  startBusy = false; paintAdmin();
};
$('aEnd').onclick = () => { endArmed = true; paintAdmin(); $('aEndNo').focus(); };
$('aEndNo').onclick = () => { endArmed = false; paintAdmin(); $('aEnd').focus(); };
$('aEndYes').onclick = async () => {
  $('aEndYes').disabled = true;
  try {
    // one transaction: only if it is still this live exam. The frozen copy's end time is what the rules use for
    // staff's last saves (30 s grace), so it moves to now too.
    const id = curId();
    const at = await examTx((t, cur) => {
      if (cur.status !== 'live' || String(cur.startedAt) !== id) return null;
      const at = now();
      t.set(db.doc(T.state), Object.assign({}, cur, {status: 'ended', endedAt: at, endsAt: Math.min(cur.endsAt || at, at)}));
      t.update(db.doc('exams/' + fzId(TR, id)), {endsAt: at});
      return at;
    });
    if (!at) throw new Error(STALE);
    endArmed = false; clearWaiting(TR); msg('Exam ended at ' + fmtT(at) + '. Anyone still answering has had their answers saved as they were.'); }
  catch(e){ $('aErr').textContent = e.message === STALE ? STALE : 'Could not end the exam: ' + errText(e) + '. Try again.'; }
  $('aEndYes').disabled = false; paintAdmin();
};
// "Cancel this exam": takes a ready (not started) exam back to "not set up", so questions can be changed.
// The code is removed, the waiting list is cleared, and nothing sets up a new exam until Set up exam or Start.
$('aCancel').onclick = () => { cancelArmed = true; paintAdmin(); $('aCancelNo').focus(); };
$('aCancelNo').onclick = () => { cancelArmed = false; paintAdmin(); $('aCancel').focus(); };
$('aCancelYes').onclick = async () => {
  if (exam.status !== 'open'){ cancelArmed = false; paintAdmin(); return; }
  const b = $('aCancelYes'); b.disabled = true;
  try {
    const id = curId();
    const ok = await examTx((t, cur) => {
      if (cur.status !== 'open' || String(cur.startedAt) !== id) return false;
      const e = {status: 'idle', hold: true}; if (cur.lastId) e.lastId = cur.lastId;
      t.set(db.doc(T.state), e); t.delete(db.doc(T.code));
      return true;
    });
    if (!ok) throw new Error(STALE);
    secCode = codes[TR] = null; cancelArmed = false; codeArmed = false; clearWaiting(TR);
    msg('Exam cancelled. You can change the questions now. Press Set up exam (or Start) when you are ready.');
  } catch(e){ $('aErr').textContent = e.message === STALE ? STALE : 'Could not cancel the exam: ' + errText(e) + '. Try again.'; }
  b.disabled = false; paintAdmin();
};
$('aSetup').onclick = async () => {
  const b = $('aSetup'); b.disabled = true; $('aErr').textContent = '';
  await prepareExam(true); b.disabled = false;
  if (exam.status === 'open') msg('Exam set up. The security code is ready to share.');
};
// "Let them try again": lift a lockout
$('aLocks').addEventListener('click', async ev => {
  const b = ev.target.closest('[data-unlock]'); if (!b) return;
  const l = locks.find(x => x._id === b.dataset.unlock); b.disabled = true;
  try { await db.doc('lockouts/' + b.dataset.unlock).delete(); msg((l && l.name ? l.name : 'They') + ' can try the code again now.'); }
  catch(e){ b.disabled = false; msg('Could not unlock: ' + errText(e) + '. Try again.'); }
});

// results of the exam picked in "Show results for" (only these are deleted)
const inSel = r => (r.track || 'pharmacist') === TR && shownId() && String(r.examId) === shownId();
const clearRows = () => results.filter(inSel);
const menuOpen = on => { $('aMenu').hidden = !on; $('aMore').setAttribute('aria-expanded', String(on)); };
$('aMore').onclick = () => menuOpen($('aMenu').hidden);
document.addEventListener('click', ev => { if (!ev.target.closest('.more')) menuOpen(false); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('aMenu').hidden){ menuOpen(false); $('aMore').focus(); } });
$('aClear').onclick = () => {
  menuOpen(false);
  const id = shownId(), n = new Set(rowsForExam(id).map(r => r.phone)).size;
  if (!clearRows().length){ msg('There are no saved results for this exam.'); return; }
  if (eff() === 'live' && id === curId()){ msg('This exam is running. End it before deleting its results.'); return; }
  $('aClearText').innerHTML = '<b>Delete the results of the ' + esc(examName(id)) + '?</b> This removes ' + esc(plural(n, T.one + '\'s', T.many + '\'')) + ' marks and can\'t be undone. Download the Excel file first if you need them.';
  $('aClearYes').textContent = 'Delete ' + plural(n, 'result', 'results');
  $('aClearBox').hidden = false; $('aClearNo').focus();
};
$('aClearNo').onclick = () => { $('aClearBox').hidden = true; $('aMore').focus(); };
$('aClearYes').onclick = async () => {
  const id = shownId();
  if (eff() === 'live' && id === curId()){ $('aClearBox').hidden = true; msg('This exam is running. End it before deleting its results.'); return; }
  const n = new Set(rowsForExam(id).map(r => r.phone)).size, name = examName(id); $('aClearYes').disabled = true;
  try {
    await Promise.all(Object.keys(rawDocs).map(d => { const o = rawDocs[d];
      if ('examId' in o){ const r = normAttempt(o, d, d); return r && inSel(r) ? db.doc('results/' + d).delete() : null; }
      const keep = {}; let drop = 0;
      Object.keys(o).forEach(k => { const r = k.indexOf('a_') === 0 ? normAttempt(o[k], k, d) : null; if (r && inSel(r)) drop++; else keep[k] = o[k]; });
      if (!drop) return null; return Object.keys(keep).length ? db.doc('results/' + d).set(keep) : db.doc('results/' + d).delete(); }));
    $('aClearBox').hidden = true; selExam = ''; msg(plural(n, 'result', 'results') + ' of the ' + name + ' deleted. Other exams were not changed.');
  }
  catch(e){ msg('Could not delete the results: ' + errText(e) + '. Try again.'); }
  $('aClearYes').disabled = false; paintAdmin();
};
// Retention: delete attempts older than N months (default 12) from EVERY assessment, after a confirmation that
// names the count and the cut-off date. "Keep results" has the focus first.
const oldCut = m => { const d = new Date(now()); d.setMonth(d.getMonth() - m); return d.getTime(); };
const oldRows = m => { const cut = oldCut(m); return results.filter(r => r.startedAt && r.startedAt < cut); };
function oldErr(){ const raw = $('aOldMonths').value.trim(), m = Number(raw); return !raw ? 'Enter a number of months.' : !Number.isInteger(m) || m < 1 || m > 60 ? 'Choose a whole number of months from 1 to 60.' : ''; }
function paintOld(){
  const err = oldErr(), m = Number($('aOldMonths').value), n = err ? 0 : oldRows(m).length, cut = err ? 0 : oldCut(m);
  $('aOldErr').textContent = err; $('aOldErr').hidden = !err; $('aOldMonths').closest('.field').classList.toggle('bad', !!err); $('aOldMonths').setAttribute('aria-invalid', String(!!err));
  $('aOldQ').innerHTML = err ? '' : n ? '<b>Delete ' + esc(plural(n, 'result', 'results')) + ' from before ' + esc(fmtDay(cut)) + '?</b> This removes ' + (n === 1 ? 'it' : 'them') + ' from every assessment and can\'t be undone. Download the mark lists first if you need them.'
    : 'No results are older than ' + esc(plural(m, 'month', 'months')) + ' (before ' + esc(fmtDay(cut)) + '). Nothing to delete.';
  $('aOldYes').disabled = !n; $('aOldYes').textContent = n ? 'Delete ' + plural(n, 'result', 'results') : 'Delete results';
}
$('aOld').onclick = () => { menuOpen(false); $('aClearBox').hidden = true; $('aOldMonths').value = '12'; paintOld(); $('aOldBox').hidden = false; $('aOldNo').focus(); };
$('aOldMonths').addEventListener('input', paintOld);
$('aOldNo').onclick = () => { $('aOldBox').hidden = true; $('aMore').focus(); };
$('aOldYes').onclick = async () => {
  if (oldErr()) return paintOld();
  const m = Number($('aOldMonths').value), rows = oldRows(m), n = rows.length, cut = oldCut(m); if (!n) return;
  const ids = new Set(rows.map(r => r._doc + '|' + r._id)); $('aOldYes').disabled = true;
  try {
    await Promise.all(Object.keys(rawDocs).map(d => { const o = rawDocs[d];
      if ('examId' in o) return ids.has(d + '|' + d) ? db.doc('results/' + d).delete() : null;
      const keep = {}; let drop = 0; Object.keys(o).forEach(k => { if (ids.has(d + '|' + k)) drop++; else keep[k] = o[k]; });
      if (!drop) return null; return Object.keys(keep).length ? db.doc('results/' + d).set(keep) : db.doc('results/' + d).delete(); }));
    $('aOldBox').hidden = true; msg(plural(n, 'result', 'results') + ' from before ' + fmtDay(cut) + ' deleted.');
  } catch(e){ msg('Could not delete the old results: ' + errText(e) + '. Try again.'); }
  $('aOldYes').disabled = false; paintAdmin();
};
$('aExamSel').onchange = () => { selExam = $('aExamSel').value; fSt = 'all'; fTxt = ''; $('aSearch').value = ''; $('aClearBox').hidden = true; paintMarks(); };
document.querySelectorAll('.seg button[data-f]').forEach(b => b.onclick = () => { fSt = b.dataset.f; paintMarks(); });
$('aSearch').addEventListener('input', () => { fTxt = $('aSearch').value; paintMarks(); });
$('aSearch').addEventListener('keydown', ev => { if (ev.key === 'Escape'){ ev.preventDefault(); $('aSearch').value = ''; fTxt = ''; paintMarks(); } });
const clearSearch = () => { fSt = 'all'; fTxt = ''; $('aSearch').value = ''; paintMarks(); $('aSearch').focus(); };
$('aRes').addEventListener('click', ev => { if (ev.target.closest('[data-clear]')) clearSearch(); });
$('aBody').addEventListener('click', ev => {
  if (ev.target.closest('[data-clear]')) return clearSearch();
  const g = ev.target.closest('[data-go]'); if (g){ selExam = g.dataset.go; fSt = 'all'; fTxt = ''; $('aSearch').value = ''; paintMarks(); $('aExamSel').focus(); }
});
const libs = {};
function loadLib(src){ return libs[src] || (libs[src] = new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; if (LIB_SRI[src]){ s.integrity = LIB_SRI[src]; s.crossOrigin = 'anonymous'; } s.onload = ok; s.onerror = () => { delete libs[src]; no(new Error('load')); }; document.head.appendChild(s); })); }
// SheetJS 0.20.3 (0.18.x has known problems reading files); pinned by hash so a changed file is refused
const LIB_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const LIB_SRI = {[LIB_XLSX]: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT'};
const LIB_PDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const LIB_PDFT = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
// downloads use the picked exam's own frozen questions (never the current question bank)
function markData(){
  const id = shownId(), rows = rank(rowsForExam(id)), qs = examQs(id), n = qs.length, lc = lvOf(qs);
  const head = ['Rank','Name','Clinic','Phone','Position','Score','Out of','Percentage','Easy (' + lc.e + ')','Medium (' + lc.m + ')','Hard (' + lc.h + ')','Answered','Left the test (times)','Status','Started','Finished'];
  const body = rows.map((r,i) => { const s = r.sc || {}; return [i+1, r.name, r.clinic || '', r.phone, r.position, s.t == null ? '' : s.t, n, s.t == null ? '' : s.pct + '%', s.e == null ? '' : s.e, s.m == null ? '' : s.m, s.h == null ? '' : s.h, s.n == null ? '' : s.n, r.away || 0, r.status === 'submitted' ? 'Submitted' : 'In progress (Q' + Math.min(n,(r.i||0)+1) + ')', r.startedAt ? fmtD(r.startedAt) : '', r.finishedAt ? fmtD(r.finishedAt) : '']; });
  const d0 = new Date(examTime(id) || now());
  const stamp = d0.getFullYear() + '-' + String(d0.getMonth()+1).padStart(2,'0') + '-' + String(d0.getDate()).padStart(2,'0');
  return {rows, head, body, stamp, d0, n, lc, name: id ? examName(id) : ''};
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
    ws['!cols'] = [6,24,18,14,20,8,8,11,10,12,9,10,12,20,22,22].map(w => ({wch:w}));
    ws['!autofilter'] = {ref: 'A1:P' + (m.body.length + 1)};
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
  doc.text(m.name + '  |  ' + m.rows.length + ' ' + T.many + ', ' + done + ' submitted', W - 12, 21, {align:'right'});
  doc.setDrawColor(232,106,26); doc.setLineWidth(0.66); doc.line(12, 29, W - 12, 29);
  const cols = [0,1,2,3,5,7,8,9,10,12,13];
  doc.autoTable({
    startY: 33, margin:{left:12, right:12},
    head: [cols.map(c => m.head[c])], body: m.body.map(r => cols.map(c => r[c])),
    styles:{font:'helvetica', fontSize:8.5, textColor:[26,14,80], cellPadding:2.2, lineColor:[232,229,241], lineWidth:0.2},
    headStyles:{fillColor:[74,47,160], textColor:255, fontStyle:'bold', fontSize:7.5},
    alternateRowStyles:{fillColor:[248,247,251]},
    columnStyles:{0:{halign:'right', cellWidth:12}, 1:{fontStyle:'bold'}, 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'right'}, 8:{halign:'right'}, 9:{halign:'right'}},
    didDrawPage: () => { doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(110,102,140); doc.text('Only each person\'s first attempt is counted. Scores out of ' + m.n + ': Easy ' + m.lc.e + ', Medium ' + m.lc.m + ', Hard ' + m.lc.h + '.', 12, H - 8); doc.text('Page ' + doc.internal.getNumberOfPages(), W - 12, H - 8, {align:'right'}); }
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
// a new code needs a yes first: it says how many people are waiting with the old one
$('aCodeNew').onclick = () => { if (!canJoin(eff())) return; codeArmed = true; paintAdmin(); $('aCodeNo').focus(); };
$('aCodeNo').onclick = () => { codeArmed = false; paintAdmin(); $('aCodeNew').focus(); };
$('aCodeYes').onclick = async () => {
  const b = $('aCodeYes'), n = people().waiting.length; b.disabled = true;
  try { const code = await makeCode(); codeArmed = false; msg('New code ' + code + '. ' + (n ? 'Share it with the ' + plural(n, 'person', 'people') + ' who were waiting. ' : '') + 'The old code no longer works. Anyone already answering carries on.', true); }
  catch(e){ $('aErr').textContent = e.message === STALE ? STALE : 'Could not make a new code: ' + errText(e) + '. Try again.'; }
  b.disabled = false; paintAdmin();
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
  paintBlurb();
  $('rN').textContent = N || exam.count || '–';
  $('aNeed').textContent = N ? 'Each person needs about ' + needMin() + ' minutes for ' + N + ' questions (' + SEC + ' seconds each). Allow a few minutes more for late joiners.' : 'This assessment has no questions yet.';
  $('aMinsWarn').textContent = 'Under ' + needMin() + ' minutes: people who join late may not reach question ' + N + '.';
  const link = BASE_URL + '#' + TR;
  $('aLink').value = link;
  $('aWa').href = 'https://wa.me/?text=' + encodeURIComponent('SugarCARE ' + T.name + '. Open this link at exam time, keep the page open until you submit: ' + link);
}
// the line under "Join the assessment": what is happening right now, in staff words
function paintBlurb(){
  if (isAdmin && !preview) return;
  const n = (qsReady() && N) || exam.count || 0, s = eff(), el = $('lBlurb');
  el.textContent = exam.hold ? 'The invigilator cancelled this exam. Wait for a new link or code.'
    : s === 'live' ? 'The exam has started. Fill in your details, then type the security code from the invigilator to join.'
    : s === 'open' ? (n ? n + ' questions, ' + SEC + ' seconds each. ' : '') + 'Fill in your details, then type the security code the invigilator gives you.'
    : s === 'ended' ? 'The last exam has ended. You can fill in your details now; the invigilator will give you a code for the next one.'
    : 'This assessment isn\'t open yet. You can fill in your details now; the invigilator will give you a security code when it opens.';
}
function homeLine(tr){
  const st = states[tr] || {status:'idle'}, live = st.status === 'live' && now() < st.endsAt;
  const id = marksId(st), rs = results.filter(r => (r.track || 'pharmacist') === tr && id && r.examId === id);
  const ph = new Set(rs.map(r => r.phone)).size, sub = new Set(rs.filter(r => r.status === 'submitted').map(r => r.phone)).size;
  return {st, live, ph, sub};
}
function paintHome(){
  if (!isAdmin || $('sHome').hidden) return;
  $('hCards').innerHTML = Object.keys(TRACKS).map(tr => {
    const t = TRACKS[tr], h = homeLine(tr), n = t.qs.length;
    const open = h.st.status === 'open', chipC = h.live ? 'live' : open ? 'idle' : h.st.startedAt ? 'ended' : 'idle', chipT = h.live ? 'Exam is live' : open ? 'Ready to start' : h.st.startedAt ? 'Exam closed' : 'Not started';
    const when = open ? '<span>Code ready, waiting to start</span>' : h.live ? '<span><b data-left="' + tr + '">' + mmss(h.st.endsAt - now()) + '</b> left</span>' : h.st.startedAt ? '<span>Last exam ' + fmtT(h.st.startedAt) + '</span>' : '';
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
    useTrack(h); applyTrackText(); selExam = ''; fSt = 'all'; fTxt = ''; $('aSearch').value = ''; endArmed = false; codeArmed = false; $('aClearBox').hidden = true; menuOpen(false); msg(''); $('aErr').textContent = ''; if (typeof qRepaint === 'function') qRepaint();
    $('who').textContent = 'Invigilator · ' + T.name; document.body.classList.add('inv'); show('sAdmin'); paintAdmin(); $('aHome').focus();
  } else { $('who').textContent = 'Invigilator view'; $('topName').textContent = 'All assessments'; document.body.classList.remove('inv'); show('sHome'); paintHome(); }
}
window.addEventListener('hashchange', () => { if (preview) exitPreview(); else route(); });

/* ---------- test mode (invigilator only) ---------- */
async function startPreview(){
  if (!isAdmin || !N) return;
  preview = true; LS = T.ls + '_test'; lsSet(null);
  const t = now(), code = newCode();
  exam = {status:'live', startedAt:t, endsAt:t + (N * SEC + 600) * 1000, windowMin:Math.ceil(N * SEC / 60) + 10, codeHash: await hashCode(code, String(t))};
  $('pvCode').textContent = code; $('pvBar').hidden = false;
  sess = null; saveFailed = false; finalSaved = null; lastSaved = 0;
  $('fName').value = 'Test run'; $('fPhone').value = '9000000000'; $('fClinic').value = 'Head office'; $('fConsent').checked = true; $('fPos').selectedIndex = 1;
  ['fName','fPhone','fClinic','fPos','fCode'].forEach(id => fieldErr(id, '')); $('fCode').value = '';
  $('loginErr').hidden = true; $('loginBtn').disabled = false;
  document.body.classList.remove('inv'); whoLine(); show('sLogin'); statusChip($('stChip')); $('fName').focus();
}
function exitPreview(){
  preview = false; lsSet(null); LS = T.ls; letSleep(); sess = null;
  exam = states[TR] || {status:'idle'}; $('pvBar').hidden = true;
  ['fName','fPhone','fClinic','fPos','fCode'].forEach(id => { $(id).value = ''; fieldErr(id, ''); }); phoneWarnReset();
  route();
}
$('aTry').onclick = () => startPreview();
$('pvRestart').onclick = () => startPreview();
$('pvExit').onclick = () => exitPreview();

/* ---------- start-up ---------- */
// staff can read the questions only while the exam is live (firestore.rules), so fetch them when it opens
let qsLoading = null;
// Staff may read the questions only while the exam is live and only after entering the code (firestore.rules),
// so they are fetched then, for THAT exam. A tab left open from an earlier exam fetches the new exam's questions
// (T.qsFor) instead of using the old ones. A failed fetch shows an error with Try again (qsErr).
let qsErr = false;
const qsReady = () => !!N && (preview || isAdmin || T.qsFor === String(exam.startedAt));
function loadLiveQs(){
  if (isAdmin || preview || eff() !== 'live' || !sess || !codeOk() || qsReady()) return Promise.resolve();
  if (!qsLoading) qsLoading = db.doc('questions/' + TR).get().then(q => {
      if (!(q.exists && Array.isArray(q.data().qs) && q.data().qs.length)) throw new Error('empty');
      setQs(TR, q.data().qs); T.qsFor = String(exam.startedAt); qsErr = false;
    }).catch(() => { qsErr = true; }).finally(() => { qsLoading = null; refreshReady(); });
  return qsLoading;
}
$('rRetry').onclick = () => { qsErr = false; $('rRetry').hidden = true; refreshReady(); loadLiveQs(); };
async function onExam(snap){
  // When the server can't be reached, the SDK reports an offline snapshot that says "no exam". That is not a
  // real state: acting on it would end a running test. Wait for the server's answer instead.
  if (!snap.exists && snap.metadata && snap.metadata.fromCache){ offlineState = true; refreshReady(); return; }
  // back online (a server snapshot after an offline one): re-save at once so the "not saved" banner clears
  // The connection is confirmed again: the SDK sends the queued answers by itself, so the "not saved" banner goes
  // at once; a fresh save is sent too, and if that one fails the banner comes back.
  if ((offlineState || saveFailed) && !snap.metadata.fromCache){ saveFailed = false; paintSave(); retrySave(); }
  offlineState = !!(snap.metadata && snap.metadata.fromCache);
  exam = snap.exists ? snap.data() : {status:'idle'};
  paintBlurb();
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
    if (!qsReady()){ goReady(); return; }   // questions still loading or failed: the ready screen shows it and resumes after
    showQ(); return;
  }
  if (s.started && s.done){
    if (s.saved){ sess = null; lsSet(null); return; }
    whoLine(); finalSaved = null; paintDone(); write('submitted'); return;   // the last submit never reached the server: try again
  }
  goNext();
}
function applyResults(s){
  resDocs = s.docs.map(d => d.id); results = []; Object.keys(rawDocs).forEach(k => delete rawDocs[k]);
  s.docs.forEach(d => { const o = d.data(); rawDocs[d.id] = o;
    if ('examId' in o){ const r = normAttempt(o, d.id, d.id); if (r) results.push(r); }   // results/<uid>_<track>_<examId>
    else Object.keys(o).forEach(k => { if (k.indexOf('a_') === 0){ const r = normAttempt(o[k], k, d.id); if (r) results.push(r); } });   // older exams
  });
  lastUpd = now(); freezeOld(); paintAdmin(); paintHome();
}
// staff: their own lockout record (after 5 wrong codes). Deleting it ("Let them try again") unlocks the code box.
function watchLock(){
  if (!uid) return;
  if (lockUnsub) lockUnsub();
  lockUnsub = db.doc('lockouts/' + uid + '_' + TR).onSnapshot(s => {
    const was = lockedOut; lockedOut = s.exists;
    if (was && !lockedOut){ if (sess){ sess.tries = 0; lsSet(sess); } fieldErr('fCode', ''); say('You can try the code again'); }
    refreshCode();
  }, () => {});
}
async function boot(){
  await Promise.race([syncClock(), new Promise(r => setTimeout(r, 3000))]);   // server clock first (gives up after 3 s)
  { const h = (location.hash || '').slice(1); useTrack(TRACKS[h] ? h : 'pharmacist'); }
  applyTrackText(); show('sLogin'); statusChip($('stChip'));
  // a test in progress on this phone: show "Reconnecting" straight away (not the details form) while the
  // connection opens; resume() decides what happens only after the first real exam-state snapshot
  if (!new URLSearchParams(location.search).has('admin')){ const s = lsGet(); if (s && s.started && !s.done && s.name){ sess = s; goReady(); } }
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
    const all = (c, f) => db.collection(c).onSnapshot(f, () => {});
    Object.keys(TRACKS).forEach(tr => {
      db.doc(TRACKS[tr].state).onSnapshot(s => { states[tr] = s.exists ? s.data() : {status:'idle'}; if (tr === TR && !preview) exam = states[tr]; paintAdmin(); paintHome(); }, () => {});
      db.doc(TRACKS[tr].key).onSnapshot(s => { keys[tr] = s.exists ? s.data() : null; if (tr === TR) key = keys[tr]; freezeOld(); paintAdmin(); if (typeof qRepaint === 'function') qRepaint(); });
      db.doc(TRACKS[tr].code).onSnapshot(s => { codes[tr] = s.exists ? s.data() : null; if (tr === TR) secCode = codes[tr]; paintAdmin(); });
    });
    db.collection('results').onSnapshot(applyResults);
    all('exams', s => { Object.keys(exams).forEach(k => delete exams[k]); s.docs.forEach(d => { const e = d.data(); if (EXAM_ID.test(String(e.examId)) && Array.isArray(e.qs)) exams[d.id] = e; }); examsReady = true; freezeOld(); paintAdmin(); });
    all('waiting', s => { waits = s.docs.map(d => normPerson(d.data(), d.id)); paintAdmin(); });
    all('lockouts', s => { locks = s.docs.map(d => normPerson(d.data(), d.id)); paintAdmin(); });
    if (typeof startAdmins === 'function') startAdmins();
  } else { db.doc(T.state).onSnapshot({includeMetadataChanges: true}, onExam, () => { offlineState = true; refreshReady(); }); watchLock(); }
  // no timed fallback: resume() runs only after the first real exam-state snapshot (onExam), so a slow
  // connection can never submit a test that is still running.
}
boot();
