/* ---------- invigilators (home screen) ----------
   One role: invigilator. Main accounts come from INVIGILATOR_EMAILS in .env and can't be removed here;
   the rest are stored as admins/<email>. Firestore rules enforce the same limits. */
const MAIN_EMAILS = __MAIN_EMAILS__;   // from INVIGILATOR_EMAILS in .env (build.py)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
let invs = [], myEmail = '', invRemove = '', invReady = false, invBlocked = '';
const RULES_HINT = 'This needs a settings update on the server. Ask the person who set up this system to publish the latest database rules, then reload this page.';
const isPerm = e => e && (e.code === 'permission-denied' || /insufficient permissions/i.test(e.message || ''));
function invSay(err, ok){ $('admErr').textContent = err || ''; $('admOk').textContent = ok || ''; }
// returns '' when the email can be added, otherwise the reason
function invCheck(email){
  if (!email) return 'Enter the invigilator\'s email.';
  if (!EMAIL_RE.test(email)) return 'Enter a valid email address, like name@example.com.';
  if (email === myEmail) return 'You are already an invigilator.';
  if (MAIN_EMAILS.includes(email) || invs.some(a => a.email === email)) return email + ' is already an invigilator.';
  if (invBlocked) return invBlocked;
  if (!invReady) return 'The invigilator list is still loading. Try again in a moment.';
  return '';
}
function paintInvs(){
  if (!isAdmin) return;
  const rows = MAIN_EMAILS.map(e => ({email: e, main: true})).concat(invs.filter(a => !MAIN_EMAILS.includes(a.email)).sort((x, y) => x.email.localeCompare(y.email)));
  $('admCount').textContent = '· ' + rows.length;
  $('admBlock').textContent = invBlocked; $('admBlock').hidden = !invBlocked;
  $('admAdd').disabled = !!invBlocked;
  $('admList').innerHTML = rows.map(a => {
    const me = a.email === myEmail, sure = invRemove === a.email;
    const right = me ? '<span class="tag">You</span>' : a.main ? '<span class="small muted">Main account</span>'
      : sure ? '<span class="small">Remove ' + esc(a.email) + '?</span><button class="btn btn-sm btn-danger" data-rm-yes="' + esc(a.email) + '" type="button">Remove</button><button class="btn btn-sm btn-ghost" data-rm-no type="button">Cancel</button>'
      : '<button class="btn btn-sm btn-quiet" data-rm="' + esc(a.email) + '" type="button">Remove</button>';
    return '<li><div class="am"><b>' + esc(a.name || a.email) + '</b>' + (a.name ? '<span>' + esc(a.email) + '</span>' : '')
      + (a.addedBy ? '<span>Added by ' + esc(a.addedBy) + (a.addedAt ? ' · ' + new Date(a.addedAt).toLocaleDateString() : '') + '</span>' : '') + '</div>' + right + '</li>';
  }).join('');
}
$('admEmail').oninput = () => { invSay(); $('admEmail').closest('.field').classList.remove('bad'); };
$('admList').onclick = async ev => {
  const t = ev.target;
  if (t.dataset.rm){ invSay(); invRemove = t.dataset.rm; paintInvs(); return; }
  if ('rmNo' in t.dataset){ invRemove = ''; paintInvs(); return; }
  if (t.dataset.rmYes){
    const e = t.dataset.rmYes; t.disabled = true; t.textContent = 'Removing…';
    try { await db.doc('admins/' + e).delete(); invRemove = ''; invSay('', e + ' is no longer an invigilator and can no longer open this page.'); }
    catch(err){ invRemove = ''; paintInvs(); invSay(isPerm(err) ? 'Could not remove ' + e + '. ' + RULES_HINT : 'Could not remove ' + e + ': ' + errText(err) + '. Try again.'); }
  }
};
$('admForm').onsubmit = async ev => {
  ev.preventDefault(); invSay();
  const email = $('admEmail').value.trim().toLowerCase(), name = $('admName').value.trim().replace(/\s+/g, ' ');
  const why = invCheck(email);
  if (why){ invSay(why); $('admEmail').closest('.field').classList.add('bad'); $('admEmail').focus(); return; }
  const b = $('admAdd'); b.disabled = true; b.textContent = 'Adding…';
  // save the list entry first: if the rules refuse it, no login is made and no email is sent
  try { await db.doc('admins/' + email).set({email, name, addedBy: myEmail, addedAt: Date.now()}); }
  catch(e){ invSay(isPerm(e) ? 'Could not add ' + email + '. ' + RULES_HINT : 'Could not add ' + email + ': ' + errText(e) + '. Try again.'); b.disabled = false; b.textContent = 'Add invigilator'; return; }
  try {
    const acc = await claude.use('accounts'), r = acc ? await acc.create(email) : {created: false};
    $('admEmail').value = ''; $('admName').value = '';
    invSay('', r.created ? email + ' added. They will get an email to choose their password. Then they can sign in on the invigilator page.'
      : email + ' added. They already have an account, so they can sign in on the invigilator page now.');
  } catch(e){
    try { await db.doc('admins/' + email).delete(); } catch(x){}
    invSay('Could not create an account for ' + email + ': ' + errText(e) + '. Nothing was added. Try again, or ask the person who set up this system to check email sign-in is turned on.');
  }
  b.disabled = false; b.textContent = 'Add invigilator';
};
async function startAdmins(){
  if (!isAdmin) return;
  try { myEmail = user && user.email ? await user.email() : ''; } catch(e){ myEmail = ''; }
  db.collection('admins').onSnapshot(s => { invReady = true; invBlocked = ''; invs = s.docs.map(d => Object.assign({email: d.id}, d.data())); paintInvs(); },
    e => { invReady = true; invBlocked = isPerm(e) ? 'Adding and removing invigilators is turned off. ' + RULES_HINT : 'Could not load the invigilator list: ' + errText(e) + '. Reload the page to try again.'; paintInvs(); });
  paintInvs();
}
