/* Firebase backend: provides claude.use('db' | 'user' | 'downloads') on top of Firestore and Firebase Auth.
   Staff sign in anonymously. The invigilator opens the page with ?admin and signs in with email and password
   (Firebase Authentication). Who counts as an invigilator is decided by firestore.rules: the app checks it by
   trying to read key/code, which only invigilators may read. */
(() => {
  if (window.claude) return;   // tests (tests/stub.js) or the Claude artifact host already provide it
  const cfg = __FIREBASE_CONFIG__;   // filled in by build.py from .env
  const wantAdmin = new URLSearchParams(location.search).has('admin');
  const el = id => document.getElementById(id);
  const AUTH_MSG = {
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/missing-password': 'Enter your password.',
    'auth/invalid-credential': 'Email or password is wrong.',
    'auth/wrong-password': 'Email or password is wrong.',
    'auth/user-not-found': 'Email or password is wrong.',
    'auth/user-disabled': 'This account has been turned off.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No internet connection. Check it and try again.'
  };
  const authMsg = e => AUTH_MSG[e && e.code] || 'Could not sign in: ' + String((e && (e.message || e.code)) || 'unknown error').trim().replace(/[.\s]+$/, '') + '.';

  async function isInvigilator(fs){
    try { await fs.doc('key/code').get(); return true; } catch(e){ return false; }
  }
  // show the sign-in gate until an invigilator account signs in
  function gate(auth, fs){
    return new Promise(resolve => {
      const g = el('adminGate'), err = el('gErr'), btn = el('gBtn');
      const say = t => { err.textContent = t; err.hidden = !t; };
      g.hidden = false; el('gEmail').focus();
      const pwShow = on => { el('gPass').type = on ? 'text' : 'password'; el('gShow').textContent = on ? 'Hide' : 'Show'; el('gShow').setAttribute('aria-pressed', String(on)); el('gShow').setAttribute('aria-label', on ? 'Hide password' : 'Show password'); };
      pwShow(false);
      el('gShow').onclick = () => { pwShow(el('gPass').type === 'password'); el('gPass').focus(); };
      el('gForm').onsubmit = async ev => {
        ev.preventDefault(); say(''); btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);   // closing the browser signs the invigilator out
          const u = (await auth.signInWithEmailAndPassword(el('gEmail').value.trim(), el('gPass').value)).user;
          pwShow(false);   // never leave the password showing after a sign-in attempt
          if (await isInvigilator(fs)){ el('gPass').value = ''; g.hidden = true; resolve(u); return; }
          await auth.signOut(); say('This account is not an invigilator. Ask the exam owner to add it.');
        } catch(e){ say(authMsg(e)); }
        btn.disabled = false; btn.textContent = 'Sign in';
      };
      el('gReset').onclick = async () => {
        const email = el('gEmail').value.trim();
        if (!email){ say('Type your email first, then press Forgot password.'); el('gEmail').focus(); return; }
        try { await auth.sendPasswordResetEmail(email); say(''); err.hidden = false; err.textContent = 'If this email has an account, a reset link is on its way.'; }
        catch(e){ say(authMsg(e)); }
      };
    });
  }
  function addSignOut(auth){
    const who = el('who'); if (!who || el('signOut')) return;
    const b = document.createElement('button'); b.id = 'signOut'; b.type = 'button'; b.className = 'signout'; b.textContent = 'Sign out';
    b.onclick = async () => { await auth.signOut(); location.reload(); };
    who.insertAdjacentElement('afterend', b);
  }

  // invigilator accounts: made on a second Firebase app so the signed-in invigilator stays signed in.
  // The new account gets a random password and a reset email, so nobody else ever knows its password.
  const accounts = {create: async email => {
    const app2 = firebase.apps.find(a => a.name === 'accounts') || firebase.initializeApp(cfg, 'accounts');
    const pw = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('') + 'Aa1!';
    let created = true;
    try { await app2.auth().createUserWithEmailAndPassword(email, pw); }
    catch(e){ if (e.code === 'auth/email-already-in-use') created = false; else throw e; }
    finally { try { await app2.auth().signOut(); } catch(e){} }
    if (created) await firebase.auth().sendPasswordResetEmail(email);
    return {created};
  }};
  let ready = null;
  function start(){
    if (ready) return ready;
    ready = (async () => {
      if (!window.firebase) throw new Error('Firebase did not load');
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      const auth = app.auth(), fs = app.firestore();
      // local testing only: ?emu on localhost talks to the Firebase emulators instead of the real project
      if (/^(localhost|127\.0\.0\.\d+)$/.test(location.hostname) && new URLSearchParams(location.search).has('emu') && !start.emu){
        start.emu = true; auth.useEmulator('http://127.0.0.1:9099'); fs.useEmulator('127.0.0.1', 8080);
      }
      await new Promise(r => { const off = auth.onAuthStateChanged(() => { off(); r(); }); });
      let u = auth.currentUser, admin = false;
      if (u && !u.isAnonymous) admin = await isInvigilator(fs);
      if (wantAdmin && !admin){
        if (u && !u.isAnonymous) await auth.signOut();
        u = await gate(auth, fs); admin = true;
      } else if (!u || (!u.isAnonymous && !admin)){
        if (u) await auth.signOut();
        u = (await auth.signInAnonymously()).user;
      }
      if (admin) addSignOut(auth);
      return {fs, u, admin};
    })();
    return ready;
  }
  const downloads = {save: async f => {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([f.data]));
    a.href = url; a.download = f.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }};
  window.claude = {use: async n => {
    if (n === 'downloads') return downloads;
    const s = await start();
    if (n === 'db') return s.fs;
    if (n === 'user') return {canEdit: async () => s.admin, id: async () => s.u.uid, email: async () => (s.u.email || '').toLowerCase()};
    if (n === 'accounts') return s.admin ? accounts : null;
    return null;
  }};
})();
