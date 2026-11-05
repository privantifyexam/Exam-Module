// Firestore rules check against the local emulator (no real project is touched).
// Run: start the Firestore emulator on 127.0.0.1:8080 with firestore.rules, then: node tests/rules.test.mjs
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const P = env.FIREBASE_PROJECT_ID, ADMIN = env.INVIGILATOR_EMAILS.split(',')[0].trim().toLowerCase();
const BASE = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// unsigned test tokens: the emulator accepts them, production never does
const tok = (uid, provider, email) => b64({alg: 'none', typ: 'JWT'}) + '.' + b64({sub: uid, user_id: uid, aud: P, iss: 'https://securetoken.google.com/' + P, iat: 1, exp: 9999999999, auth_time: 1, email, email_verified: !!email, firebase: {sign_in_provider: provider}}) + '.';
const who = {owner: 'owner', staffA: tok('staffA', 'anonymous'), staffB: tok('staffB', 'anonymous'), staffL: tok('staffL', 'anonymous'),
  admin: tok('adm1', 'password', ADMIN), outsider: tok('out1', 'password', 'someone@example.com')};
const val = v => v === null ? {nullValue: null} : Array.isArray(v) ? {arrayValue: {values: v.map(val)}} : typeof v === 'number' ? (Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v})
  : typeof v === 'string' ? {stringValue: v} : typeof v === 'boolean' ? {booleanValue: v} : {mapValue: {fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)]))}};
const fields = o => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, val(x)]));
const req = (as, method, path, body) => fetch(BASE + path, {method, headers: {Authorization: 'Bearer ' + who[as], 'Content-Type': 'application/json'}, body: body && JSON.stringify(body)});
const get = (as, p) => req(as, 'GET', '/' + p);
const list = (as, c) => req(as, 'GET', '/' + c);
const set = (as, p, o) => req(as, 'PATCH', '/' + p, {fields: fields(o)});
const del = (as, p) => req(as, 'DELETE', '/' + p);
const commit = (as, writes) => fetch(BASE.replace('/documents', '/documents:commit'), {method: 'POST', headers: {Authorization: 'Bearer ' + who[as], 'Content-Type': 'application/json'},
  body: JSON.stringify({writes: writes.map(([p, o]) => ({update: {name: `projects/${P}/databases/(default)/documents/${p}`, fields: fields(o)}}))})});
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
const W = (over = {}) => Object.assign({track: 'pharmacist', examId: '1000', code: 'ABC234', codeAt: 500, name: 'Anitha M', clinic: 'Edappal', phone: '9847011001', position: 'Pharmacist', joinedAt: Date.now()}, over);

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
console.log('--- waiting list: the server checks the code');
await check('staff joins with a wrong code', false, set('staffA', 'waiting/staffA_pharmacist', W({code: 'ZZZ999'})));
await check('staff joins with an old code (stale code time)', false, set('staffA', 'waiting/staffA_pharmacist', W({codeAt: 400})));
await check('staff joins with the right code', true, set('staffA', 'waiting/staffA_pharmacist', W()));
await check('staff writes a waiting record for someone else', false, set('staffA', 'waiting/staffB_pharmacist', W()));
await check('locked-out staff joins with the right code', false, set('staffL', 'waiting/staffL_pharmacist', W()));
await check('staff deletes a waiting record', false, del('staffA', 'waiting/staffA_pharmacist'));
await check('staff reads their own waiting record', true, get('staffA', 'waiting/staffA_pharmacist'));
await check('staff reads someone else\'s waiting record', false, get('staffB', 'waiting/staffA_pharmacist'));
console.log('--- lockouts');
await check('staff records their own lockout', true, set('staffB', 'lockouts/staffB_pharmacist', {track: 'pharmacist', examId: '1000', name: 'B', clinic: 'C', phone: '9000000002', at: 1}));
await check('staff changes their lockout', false, set('staffB', 'lockouts/staffB_pharmacist', {track: 'pharmacist', examId: '1000', name: 'B', clinic: 'C', phone: '9000000002', at: 2}));
await check('staff lifts their own lockout', false, del('staffB', 'lockouts/staffB_pharmacist'));
await check('invigilator lifts a lockout ("Let them try again")', true, del('admin', 'lockouts/staffB_pharmacist'));
console.log('--- staff writes');
await check('staff changes the exam state', false, set('staffA', 'exam/state', {status: 'live', startedAt: 1000, endsAt: 9e12}));
await check('staff writes their own results', true, set('staffA', 'results/staffA', {a_y: {examId: '1000', status: 'in-progress'}}));
await check('staff writes someone else\'s results', false, set('staffA', 'results/staffB', {a_y: {examId: '1000'}}));
await check('staff writes saved marks', false, set('staffA', 'marks/pharmacist_1000', {a_y: {t: 50}}));
console.log('--- invigilator');
await check('invigilator reads the code', true, get('admin', 'key/code'));
await check('invigilator lists the waiting list', true, list('admin', 'waiting'));
await check('non-invigilator password account reads the code', false, get('outsider', 'key/code'));
await check('exam goes live WITHOUT its frozen copy', false, set('admin', 'exam/state', {status: 'live', startedAt: 1000, liveAt: 2000, endsAt: Date.now() + 3600e3}));
await check('exam goes live together with its frozen copy (one batch)', true, commit('admin', [['exams/pharmacist_1000', {track: 'pharmacist', examId: '1000', qs, answers: [1]}], ['exam/state', {status: 'live', startedAt: 1000, liveAt: 2000, endsAt: Date.now() + 3600e3, codeAt: 500}]]));
await check('staff reads questions while the exam is live', true, get('staffA', 'questions/pharmacist'));
await check('invigilator uploads questions while the exam is live', false, set('admin', 'questions/pharmacist', {qs}));
await check('staff joins while live with the right code', true, set('staffB', 'waiting/staffB_pharmacist', W({phone: '9000000002'})));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
