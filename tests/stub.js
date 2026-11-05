(() => {
  const store = {}, subs = [];
  const fire = () => subs.forEach(f => f());
  const now = Date.now();
  store['exam/state'] = {status:'live', startedAt: now - 120000, endsAt: now + 33*60000, windowMin: 35};
  // 50 placeholder questions (35 easy, 10 medium, 5 hard); the real ones live only in Firestore
  store['questions/pharmacist'] = {qs: Array.from({length:50}, (_,i) => ({l: i < 35 ? 'Easy' : i < 45 ? 'Medium' : 'Hard', q: 'Sample question ' + (i+1) + '?', o: ['Option A','Option B','Option C','Option D']}))};
  if (window.__admin) {
    store['key/main'] = {answers: Array(50).fill(1)};
    const names = ['Anitha Menon','Rahul Nair','Fathima K','Joseph Thomas','Sreeja P','Arun Das'];
    names.forEach((n,j) => { const a = Array(50).fill(-1).map((_,i)=> i < (j===5?12:50) ? ((i*7+j)%3===0?0:1) : -1);
      store['results/u'+j] = {['a_x'+j]: {examId:String(now-120000), name:n, phone:'98470'+(10000+j*1111), position: j%2?'Pharmacist':'Senior Pharmacist', answers:a, i: j===5?12:50, status: j===5?'in-progress':'submitted', startedAt: now-100000+j, finishedAt: now - 5000 + j}}; });
  }
  const snap = p => ({exists: p in store, data: () => JSON.parse(JSON.stringify(store[p])), id: p.split('/').pop()});
  const doc = p => ({
    get: async () => snap(p), set: async (d, o) => { store[p] = o && o.merge ? Object.assign({}, store[p], d) : d; fire(); }, update: async d => { store[p] = Object.assign({}, store[p], d); fire(); }, delete: async () => { delete store[p]; fire(); },
    onSnapshot: cb => { const f = () => cb(snap(p)); subs.push(f); setTimeout(f, 50); return () => {}; }
  });
  const list = c => ({docs: Object.keys(store).filter(k => k.startsWith(c + '/')).map(snap)});
  const batch = () => { const ops = []; return {set: (r, d) => ops.push(() => r.set(d)), commit: async () => { for (const o of ops) await o(); }}; };
  const db = {doc, batch, collection: c => ({get: async () => list(c), onSnapshot: cb => { const f = () => cb(list(c)); subs.push(f); setTimeout(f, 50); }})};
  const user = {canEdit: async () => !!window.__admin, id: async () => 'u_me', email: async () => 'inv@example.com'};
  window.claude = {use: async n => n === 'db' ? db : n === 'user' ? user : n === 'downloads' ? {save: async () => {}} : null};
})();
