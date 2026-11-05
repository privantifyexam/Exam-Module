// Firestore rules check against the local emulator (no real project is touched).
// Run: start the Firestore emulator on 127.0.0.1:8080 with firestore.rules, then: node tests/rules.test.mjs
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const P = env.FIREBASE_PROJECT_ID, ADMIN = env.INVIGILATOR_EMAILS.split(',')[0].trim().toLowerCase();
const BASE = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// unsigned test tokens: the emulator accepts them, production never does
const tok = (uid, provider, email) => b64({alg: 'none', typ: 'JWT'}) + '.' + b64({sub: uid, user_id: uid, aud: P, iss: 'https://securetoken.google.com/' + P, iat: 1, exp: 9999999999, auth_time: 1, email, email_verified: !!email, firebase: {sign_in_provider: provider}}) + '.';
const who = {owner: 'owner', staffA: tok('staffA', 'anonymous'), staffB: tok('staffB', 'anonymous'), staffL: tok('staffL', 'anonymous'), staffX: tok('staffX', 'anonymous'),
  admin: tok('adm1', 'password', ADMIN), outsider: tok('out1', 'password', 'someone@example.com')};
const val = v => v === null ? {nullValue: null} : v && v.__ts ? {timestampValue: v.__ts} : Array.isArray(v) ? {arrayValue: {values: v.map(val)}} : typeof v === 'number' ? (Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v})
  : typeof v === 'string' ? {stringValue: v} : typeof v === 'boolean' ? {booleanValue: v} : {mapValue: {fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)]))}};
const fields = o => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, val(x)]));
const req = (as, method, path, body) => fetch(BASE + path, {method, headers: {Authorization: 'Bearer ' + who[as], 'Content-Type': 'application/json'}, body: body && JSON.stringify(body)});
const get = (as, p) => req(as, 'GET', '/' + p);
const list = (as, c) => req(as, 'GET', '/' + c);
const set = (as, p, o) => req(as, 'PATCH', '/' + p, {fields: fields(o)});
const del = (as, p) => req(as, 'DELETE', '/' + p);
const commit = (as, writes) => fetch(BASE.replace('/documents', '/documents:commit'), {method: 'POST', headers: {Authorization: 'Bearer ' + who[as], 'Content-Type': 'application/json'},
  body: JSON.stringify({writes: writes.map(([p, o]) => ({update: {name: `projects/${P}/databases/(default)/documents/${p}`, fields: fields(o)}}))})});
// put: one write through :commit, so server times (request.time) can be set like the app does with serverTimestamp().
// ts = fields set to the server time; mask = update only these fields (like update()); the rest replace the doc (like set()).
const put = (as, p, o, {ts = [], mask = null} = {}) => fetch(BASE.replace('/documents', '/documents:commit'), {method: 'POST', headers: {Authorization: 'Bearer ' + who[as], 'Content-Type': 'application/json'},
  body: JSON.stringify({writes: [Object.assign({update: {name: `projects/${P}/databases/(default)/documents/${p}`, fields: fields(o)},
    updateTransforms: ts.map(f => ({fieldPath: f, setToServerValue: 'REQUEST_TIME'}))}, mask ? {updateMask: {fieldPaths: mask.concat([])}} : {})]})});
let pass = 0, fail = 0;
async function check(name, expectOk, pr){
  const r = await pr, ok = r.ok || r.status === 404;   // 404 = allowed, the document just doesn't exist yet
  if (ok === expectOk){ pass++; console.log('PASS', name, '| expected', expectOk ? 'allowed' : 'refused', '| got', ok ? 'allowed' : 'refused'); }
  else { fail++; console.log('FAIL', name, '| expected', expectOk ? 'allowed' : 'refused', '| got', ok ? 'allowed' : 'refused', r.status, (await r.text()).slice(0, 200)); }
}
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`, {method: 'DELETE'});
const qs = [{l: 'Easy', q: 'Q1?', o: ['a', 'b']}];
await set('owner', 'exam/state', {status: 'open', startedAt: 1000, codeAt: 500, count: 1});
await set('owner', 'key/code', {code: 'ABC234', examId: '1000', madeAt: 500});
await set('owner', 'key/main', {answers: [1]});
await set('owner', 'questions/pharmacist', {qs});
await set('owner', 'exams/pharmacist_900', {track: 'pharmacist', examId: '900', qs, answers: [1]});
await set('owner', 'marks/pharmacist_900', {a_x: {t: 1}});
await set('owner', 'results/staffB', {a_x: {examId: '900', name: 'B', phone: '9000000002', answers: [1], status: 'submitted'}});
await set('owner', 'lockouts/staffL_pharmacist', {track: 'pharmacist', examId: '1000', name: 'L', clinic: 'C', phone: '9000000003', at: 1});
// a waiting record as the app writes it: joinedAt is the server time
const CV = 'privacy-2026-11-05';
const W = (over = {}) => Object.assign({track: 'pharmacist', examId: '1000', code: 'ABC234', codeAt: 500, name: 'Anitha M', clinic: 'Edappal', phone: '9847011001', position: 'Pharmacist', consentVer: CV}, over);
const join = (as, id, o, ts = ['joinedAt', 'consentAt']) => put(as, 'waiting/' + id, o, {ts});
// the consent time stored on a waiting record (server time), to copy onto the attempt as the app does
const consentAtOf = async id => ({__ts: (await (await get('owner', 'waiting/' + id)).json()).fields.consentAt.timestampValue});
const LOCK = o => Object.assign({track: 'pharmacist', examId: '1000', name: 'B', clinic: 'C', phone: '9000000002'}, o);

console.log('--- staff (anonymous) can never read secrets or other people\'s records');
await check('staff reads the answer key (key/main)', false, get('staffA', 'key/main'));
await check('staff reads the security code (key/code)', false, get('staffA', 'key/code'));
await check('staff reads a frozen exam copy (exams/…)', false, get('staffA', 'exams/pharmacist_900'));
await check('staff reads saved marks (marks/…)', false, get('staffA', 'marks/pharmacist_900'));
await check('staff lists the waiting list', false, list('staffA', 'waiting'));
await check('staff lists the lockout list', false, list('staffA', 'lockouts'));
await check('staff reads someone else\'s lockout', false, get('staffA', 'lockouts/staffL_pharmacist'));
await check('staff reads their own lockout status', true, get('staffA', 'lockouts/staffA_pharmacist'));
await check('staff reads someone else\'s results', false, get('staffA', 'results/staffB'));
await check('staff reads questions before the exam is live', false, get('staffA', 'questions/pharmacist'));
await check('staff reads the exam state', true, get('staffA', 'exam/state'));
{ const t = await (await get('staffA', 'exam/state')).json(); const leak = Object.keys(t.fields || {}).filter(k => /code/i.test(k) && k !== 'codeAt');
  if (leak.length){ fail++; console.log('FAIL exam state holds code fields:', leak); } else { pass++; console.log('PASS exam state readable by staff has no code or code hash | expected none | got none'); } }
console.log('--- question lock: refused while the exam is ready (code made) or live');
await check('invigilator uploads questions while the exam is ready (status open)', false, set('admin', 'questions/pharmacist', {qs}));
await check('invigilator edits the answer-free question list while ready (update)', false, req('admin', 'PATCH', '/questions/pharmacist?updateMask.fieldPaths=updatedAt', {fields: fields({updatedAt: 1})}));
await check('invigilator deletes the question bank while ready', false, del('admin', 'questions/pharmacist'));
console.log('--- "Cancel this exam" sets it back so questions can change');
await check('staff cancels the exam', false, set('staffA', 'exam/state', {status: 'idle', hold: true}));
await check('invigilator cancels the ready exam (status back to idle)', true, set('admin', 'exam/state', {status: 'idle', hold: true}));
await check('invigilator uploads questions after cancelling', true, set('admin', 'questions/pharmacist', {qs}));
await check('staff joins a cancelled exam with its old code', false, join('staffA', 'staffA_pharmacist', W()));
await check('invigilator sets the exam up again (status open, new code)', true, commit('admin', [['key/code', {code: 'ABC234', examId: '1000', madeAt: 500}], ['exam/state', {status: 'open', startedAt: 1000, codeAt: 500, count: 1}]]));
await check('invigilator uploads questions once it is ready again', false, set('admin', 'questions/pharmacist', {qs}));
console.log('--- waiting list: the server checks the code');
await check('staff joins with a wrong code', false, join('staffA', 'staffA_pharmacist', W({code: 'ZZZ999'})));
await check('staff joins with an old code (stale code time)', false, join('staffA', 'staffA_pharmacist', W({codeAt: 400})));
await check('staff joins with a join time set by the phone (not the server)', false, set('staffA', 'waiting/staffA_pharmacist', Object.assign(W(), {joinedAt: Date.now()})));
await check('staff joins with markup in the exam id (PWNED payload)', false, join('staffA', 'staffA_pharmacist', W({examId: '1"><img src=x onerror="document.title=\'PWNED\'">'})));
await check('staff joins without agreeing to the privacy notice (no consent fields)', false, join('staffA', 'staffA_pharmacist', (({consentVer, ...o}) => o)(W()), ['joinedAt']));
await check('staff joins with a made-up consent version', false, join('staffA', 'staffA_pharmacist', W({consentVer: 'yes'})));
await check('staff joins with a consent time set by the phone', false, put('staffA', 'waiting/staffA_pharmacist', W({consentAt: {__ts: '2020-01-01T00:00:00Z'}}), {ts: ['joinedAt']}));
await check('staff joins with the right code', true, join('staffA', 'staffA_pharmacist', W()));
await check('staff writes a waiting record for someone else', false, join('staffA', 'staffB_pharmacist', W()));
await check('locked-out staff joins with the right code', false, join('staffL', 'staffL_pharmacist', W()));
await check('staff deletes a waiting record', false, del('staffA', 'waiting/staffA_pharmacist'));
await check('staff reads their own waiting record', true, get('staffA', 'waiting/staffA_pharmacist'));
await check('staff reads someone else\'s waiting record', false, get('staffB', 'waiting/staffA_pharmacist'));
console.log('--- lockouts');
await check('staff records a lockout with a time set by the phone (not the server)', false, set('staffB', 'lockouts/staffB_pharmacist', LOCK({at: 1})));
await check('staff records a lockout with markup in the exam id', false, put('staffB', 'lockouts/staffB_pharmacist', LOCK({examId: '1"><img src=x onerror=alert(1)>'}), {ts: ['at']}));
await check('staff records their own lockout', true, put('staffB', 'lockouts/staffB_pharmacist', LOCK(), {ts: ['at']}));
await check('staff changes their lockout', false, put('staffB', 'lockouts/staffB_pharmacist', LOCK({name: 'X'}), {ts: ['at']}));
await check('staff lifts their own lockout', false, del('staffB', 'lockouts/staffB_pharmacist'));
await check('invigilator lifts a lockout ("Let them try again")', true, del('admin', 'lockouts/staffB_pharmacist'));
console.log('--- staff writes');
await check('staff changes the exam state', false, set('staffA', 'exam/state', {status: 'live', startedAt: 1000, endsAt: 9e12}));
await check('staff writes an old-style results map (results/<uid>)', false, set('staffA', 'results/staffA', {a_y: {examId: '1000', status: 'in-progress'}}));
await check('staff writes someone else\'s results', false, set('staffA', 'results/staffB', {a_y: {examId: '1000'}}));
await check('staff writes saved marks', false, set('staffA', 'marks/pharmacist_1000', {a_y: {t: 50}}));
console.log('--- invigilator');
await check('invigilator reads the code', true, get('admin', 'key/code'));
await check('invigilator lists the waiting list', true, list('admin', 'waiting'));
await check('non-invigilator password account reads the code', false, get('outsider', 'key/code'));
await check('exam goes live WITHOUT its frozen copy', false, set('admin', 'exam/state', {status: 'live', startedAt: 1000, liveAt: 2000, endsAt: Date.now() + 3600e3}));
await check('exam goes live together with its frozen copy (one batch)', true, commit('admin', [['exams/pharmacist_1000', {track: 'pharmacist', examId: '1000', qs, answers: [1], endsAt: Date.now() + 3600e3}], ['exam/state', {status: 'live', startedAt: 1000, liveAt: 2000, endsAt: Date.now() + 3600e3, codeAt: 500}]]));
await check('staff WITH a waiting record reads questions while the exam is live', true, get('staffA', 'questions/pharmacist'));
await check('staff with NO waiting record reads questions while live (never entered the code)', false, get('staffL', 'questions/pharmacist'));
await set('owner', 'waiting/staffX_pharmacist', {track: 'pharmacist', examId: '999', name: 'X', clinic: 'C', phone: '9000000009', position: 'P'});
await check('staff with a waiting record for ANOTHER exam reads questions while live', false, get('staffX', 'questions/pharmacist'));
await check('staff WITH a waiting record reads the frozen copy (holds the answer key)', false, get('staffA', 'exams/pharmacist_1000'));
await check('invigilator reads the questions while live', true, get('admin', 'questions/pharmacist'));
await check('invigilator uploads questions while the exam is live', false, set('admin', 'questions/pharmacist', {qs}));
await check('staff joins while live with the right code', true, join('staffB', 'staffB_pharmacist', W({name: 'Rahul N', phone: '9000000002'})));
console.log('--- attempts: one record per person per exam, checked field by field (results/<uid>_<track>_<examId>)');
const cA = await consentAtOf('staffA_pharmacist'), cB = await consentAtOf('staffB_pharmacist');
const A = (o = {}) => Object.assign({track: 'pharmacist', examId: '1000', uid: 'staffA', name: 'Anitha M', clinic: 'Edappal', phone: '9847011001', position: 'Pharmacist', consentVer: CV, consentAt: cA, answers: [-1], i: 0, away: 0, status: 'in_progress'}, o);
const mk = (as, id, o, extra = []) => put(as, 'results/' + id, o, {ts: ['startedAt', 'updatedAt'].concat(extra)});
const up = (as, id, o, extra = []) => put(as, 'results/' + id, o, {ts: ['updatedAt'].concat(extra), mask: Object.keys(o).concat(['updatedAt'], extra)});
await check('attempt with a score field ("sc": 50/50)', false, mk('staffA', 'staffA_pharmacist_1000', A({sc: {t: 50, pct: 100}})));
await check('attempt with a percent field', false, mk('staffA', 'staffA_pharmacist_1000', A({pct: 100})));
await check('attempt created already "submitted"', false, mk('staffA', 'staffA_pharmacist_1000', A({status: 'submitted'}), ['finishedAt']));
await check('attempt with start time set by the phone', false, put('staffA', 'results/staffA_pharmacist_1000', Object.assign(A(), {startedAt: 1}), {ts: ['updatedAt']}));
await check('attempt with the wrong number of answers (exam has 1 question)', false, mk('staffA', 'staffA_pharmacist_1000', A({answers: [-1, -1]})));
await check('attempt with an answer that is not -1 or 0-3', false, mk('staffA', 'staffA_pharmacist_1000', A({answers: [7]})));
await check('attempt with a 100,000-entry answers list', false, mk('staffA', 'staffA_pharmacist_1000', A({answers: Array(100000).fill(1)})));
await check('attempt under a different name than the waiting record (impersonation)', false, mk('staffA', 'staffA_pharmacist_1000', A({name: 'Someone Else'})));
await check('attempt using someone else\'s phone number', false, mk('staffA', 'staffA_pharmacist_1000', A({phone: '9000000002'})));
await check('attempt with no waiting record (never entered the code)', false, mk('staffL', 'staffL_pharmacist_1000', A({uid: 'staffL'})));
await check('attempt for a PAST exam (900)', false, mk('staffA', 'staffA_pharmacist_900', A({examId: '900'})));
await check('attempt under another person\'s uid', false, mk('staffA', 'staffB_pharmacist_1000', A({uid: 'staffB', name: 'Rahul N', phone: '9000000002', consentAt: cB})));
await check('attempt with markup in the exam id (PWNED payload)', false, mk('staffA', 'staffA_pharmacist_1"><img src=x>', A({examId: '1"><img src=x>'})));
await check('attempt with a different consent version than the waiting record', false, mk('staffA', 'staffA_pharmacist_1000', A({consentVer: 'privacy-2025-01-01'})));
await check('attempt with a consent time that is not the one on the waiting record', false, mk('staffA', 'staffA_pharmacist_1000', A({consentAt: {__ts: '2026-01-01T00:00:00Z'}})));
await check('attempt with an extra field', false, mk('staffA', 'staffA_pharmacist_1000', A({note: 'hi'})));
await check('valid attempt: live exam, waiting record, exact fields, server times', true, mk('staffA', 'staffA_pharmacist_1000', A()));
await check('a second attempt record for the same exam (create over the first)', false, mk('staffA', 'staffA_pharmacist_1000', A()));
await check('staff reads their own attempt', true, get('staffA', 'results/staffA_pharmacist_1000'));
await check('staff reads someone else\'s attempt', false, get('staffB', 'results/staffA_pharmacist_1000'));
await check('save progress: answers, question number, away count', true, up('staffA', 'staffA_pharmacist_1000', {answers: [1], i: 1, away: 1, status: 'in_progress'}));
await check('change the name on the attempt', false, up('staffA', 'staffA_pharmacist_1000', {name: 'Other'}));
await check('add a score to the attempt', false, up('staffA', 'staffA_pharmacist_1000', {sc: {t: 50}}));
await check('change the start time', false, up('staffA', 'staffA_pharmacist_1000', {startedAt: 1}));
await check('submit without a server finish time', false, up('staffA', 'staffA_pharmacist_1000', {status: 'submitted', finishedAt: 5}));
await check('submit (status in_progress -> submitted, server finish time)', true, up('staffA', 'staffA_pharmacist_1000', {status: 'submitted'}, ['finishedAt']));
await check('change answers after submitting', false, up('staffA', 'staffA_pharmacist_1000', {answers: [0]}));
await check('change answers after submitting, sending a fresh finish time', false, up('staffA', 'staffA_pharmacist_1000', {answers: [0], status: 'submitted'}, ['finishedAt']));
await check('set the attempt back to in_progress after submitting', false, up('staffA', 'staffA_pharmacist_1000', {status: 'in_progress'}));
await check('staff deletes their attempt', false, del('staffA', 'results/staffA_pharmacist_1000'));
await check('invigilator deletes an attempt (retention: delete old results)', true, del('admin', 'results/staffA_pharmacist_1000'));
await check('invigilator changes a new-style attempt', false, up('admin', 'staffA_pharmacist_1000', {answers: [1]}));
await check('invigilator rewrites an old-style results map (deleting one exam)', true, set('admin', 'results/staffB', {a_z: {examId: '900'}}));
await check('second staff starts an attempt', true, mk('staffB', 'staffB_pharmacist_1000', A({uid: 'staffB', name: 'Rahul N', phone: '9000000002', consentAt: cB})));
await set('owner', 'exams/pharmacist_1000', {track: 'pharmacist', examId: '1000', qs, answers: [1], endsAt: Date.now() - 31000});
await check('save progress more than 30 s after the exam ended', false, up('staffB', 'staffB_pharmacist_1000', {answers: [1], i: 1, away: 0, status: 'in_progress'}));
await set('owner', 'exams/pharmacist_1000', {track: 'pharmacist', examId: '1000', qs, answers: [1], endsAt: Date.now() - 10000});
await check('final submit within the 30 s grace after the end', true, up('staffB', 'staffB_pharmacist_1000', {answers: [0], i: 1, away: 0, status: 'submitted'}, ['finishedAt']));
console.log('--- after the exam ends, questions can change again');
await check('new attempt after the exam ended', false, (async () => { await set('owner', 'exam/state', {status: 'ended', startedAt: 1000, endsAt: Date.now() - 1000, codeAt: 500}); return mk('staffL', 'staffL_pharmacist_1000', A({uid: 'staffL'})); })());
await check('invigilator ends the live exam', true, set('admin', 'exam/state', {status: 'ended', startedAt: 1000, endedAt: Date.now(), codeAt: 500}));
await check('invigilator uploads questions after the exam ended', true, set('admin', 'questions/pharmacist', {qs}));
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`, {method: 'DELETE'});
await check('invigilator uploads questions when no exam was ever set up', true, set('admin', 'questions/pharmacist', {qs}));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
