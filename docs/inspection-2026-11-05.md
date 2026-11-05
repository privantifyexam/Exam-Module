# Pre-deploy inspection: SugarCARE Exam Module

**Date:** 5 Nov 2026
**Scope:** invigilator and staff flows, Firestore rules, and code in `src/`
**Build:** working tree on `main` (uncommitted changes: redesign + question lock / Cancel this exam)
**Test bed:** local Firebase emulator (Firestore + Auth). Test accounts and made-up names only. No live data was touched.

**Verdict: not ready to deploy.** Four severity-4 issues are confirmed in the emulator, and two more come from code review. The worst: anyone who opens the staff link can:

- put a fake 50/50 result on the mark list and in the downloads;
- run their own script inside the invigilator's page.

**Skills used:**

- sugarcare-ux-checks: main method
- sugarcare-design
- design:design-critique
- design:accessibility-review
- design:ux-copy
- dmpro-build-safety: written for DM Pro's Postgres/Neon stack, so only its sections 4 (roles and access) and 5 (tests, independent review) apply here; sections 2–3 (migrations, transactions) don't.

An independent review agent, which didn't write the code, read `src/` and the rules. Its findings are marked *(code review)*. Findings I reproduced are marked *(confirmed)*.

Severity scale: 4 = wrong marks, data seen by the wrong role, or lost results; 3 = major, fix before deploy; 2 = minor; 1 = cosmetic.

---

## Issues, most severe first

### Data and rules

- **[4]** Mark list › score: a staff login can write its own score field `sc` into its result, and the dashboard and all three downloads show it instead of the real score (B15, C5) → build rows as `Object.assign({}, attempt, {extra, sc})` and refuse `sc` in the rules. *(confirmed)*
- **[4]** Rules › `results/{uid}`:
  - The only checks are "own uid" and "≤ 20 fields". There's no schema and no "exam is live" or "before `endsAt`" check, and answers can be changed after submitting.
  - So staff can add rows to **past** exams under any name, write after the end, or hide someone else's real attempt with a fake attempt using that person's phone and `startedAt: 0`.
  - Fix: allowed keys and types; `examId == string(exam.startedAt)`; `request.time <= endsAt` plus a short grace period; must have `waiting/<uid>_<track>` with the same name and phone; no change once `status == 'submitted'`.
  - *(confirmed: GAP-1, GAP-2, GAP-5)*
- **[3]** Rules › `questions/{track}` read: during a live exam, any anonymous visitor can read the questions without entering the code (rules:54) → also require the person's own `waiting/<uid>_<track>` record. *(code review; rule read line by line)*
- **[3]** Rules › results size:
  - The answers array has no length limit: a 100,000-element array was accepted *(confirmed, GAP-3)*.
  - Each person's doc has a 20-attempt cap that never resets, so a shared clinic phone eventually can't save *(code review)*.
  - Fix: one doc per attempt (`results/<uid>_<examId>`) and an answers size limit.
- **[3]** Invigilator › two tabs at once (B7):
  - Both tabs set up the next exam with unguarded read-then-write.
  - Seen in the emulator: two exams were created and the tabs showed different codes for a few seconds before settling. Anyone typing the shown code in that window is refused, and each refusal counts toward the 5-try lockout.
  - Fix: set up the exam inside a transaction that checks status and `startedAt`, writing code and state together. *(confirmed, transient)*
- **[3]** Questions › save: the questions and the answer key are written as two separate writes (questions_upload.js:111-113). If one fails, or two tabs overlap, you get a key of the right length that doesn't match → marks are wrong → one batch write. *(code review)*
- **[3]** Mark list › old exams: `freezeOld` freezes any exam ID found in results using **today's** questions (app.js:399-409). With the results hole above, a staff-written exam ID also creates junk `exams/` records → limit it to known exam IDs and run it from a one-off button. *(code review; junk record seen during the injection test)*
- **[2]** Rules › lockouts: staff can write any exam ID, name, or `at` time into their own lockout (GAP-6). Names are escaped on screen, so there's no injection → validate the fields. *(confirmed)*
- **[2]** Rules › waiting: `joinedAt` is set by the phone, so a future time was accepted (GAP-7) → use `request.time`. *(confirmed)*
- **[2]** Rules › sign-in: `email_verified` is never checked. If a main address in `INVIGILATOR_EMAILS` has no Firebase account yet, someone else could register it. There is 1 main address today and it already has an account → require `email_verified`. *(code review)*
- **[2]** Rules › admins: any added invigilator can add or remove other non-main invigilators, and `addedBy`/`addedAt` aren't checked → check `addedBy == myEmail()` and `addedAt == request.time`. *(code review)*

### Staff flow

- **[4]** Staff › reload on a slow phone (B9, B12): if the exam state takes more than 3 s to arrive, the fallback at app.js:977 runs `resume()` with no exam known, and app.js:929 submits the test as "Time is up" → resume only after a real exam-state snapshot; never auto-submit without a known state. *(code review; confirmed by reading the code, not reproduced on a throttled network)*
- **[4]** Staff › final submit while offline: after a submit that didn't save, a reload clears the session (app.js:932). The leave-page warning is off once the test is done, and there's no offline storage, so closing the tab loses the answers → keep the session until the server confirms the submit, keep the warning while saving, and retry on resume. *(code review; not reproduced)*
- **[3]** Staff › phone clock: the exam end compares the phone's clock (`Date.now()`) with `endsAt`, which came from the invigilator's clock.
  - A phone 5 minutes fast loses 5 minutes.
  - A slow phone keeps answering after the end, and the rules accept those writes.
  - Fix: work out a server-time offset once (from a server-timestamp write) and use it on both sides.
  - *(code review; the 33 s per-question timer is relative, so it isn't affected)*
- **[3]** Staff › a tab left open from an earlier exam: once loaded, the questions are never reloaded (app.js:913), so the next exam is answered against the old question order → wrong marks → store a question-set version in the exam state and reload when it changes. *(code review)*
- **[3]** Staff › questions fail to load: `loadLiveQs` swallows the error (app.js:914), then `showQ()` runs with no questions and throws every 250 ms. The screen freezes → check there are questions before showing one, and offer "Try again". *(code review)*
- **[3]** Staff › same person on two phones (B24, real answer: "my phone died, I'm continuing on my colleague's phone"): only the **first** attempt per phone counts, and the invigilator can't choose which → let the invigilator pick the attempt that counts, with a reason. *(confirmed by code: app.js:448)*
- **[2]** Staff › offline banner: back online, "Your answers aren't being saved right now" stays up until the next answer is saved (up to 33 s) → clear it when the connection returns. *(confirmed)*
- **[2]** Staff › exam ended early by the invigilator: staff see "Time is up", which isn't true (B15) → "The invigilator ended the exam. Your answers so far are saved." *(confirmed)*
- **[2]** Staff › exam cancelled while waiting: staff still read "Your test starts by itself when the invigilator starts the exam" and aren't told it was cancelled (B15) → "This exam was cancelled. Keep this page open; you'll be asked for a new code." *(confirmed)*
- **[2]** Staff › join page before the exam is live: it says "This assessment is not open yet." even when the code is ready, because staff can't count the questions until it's live → "Fill in your details, then enter the code from the invigilator." *(confirmed)*
- **[2]** Staff › clinic is free text (B24): "Edappal", "edappal clinic" and "SugarCARE Edappal" end up as three different clinics in search and downloads → a list of clinics plus "Other". The list must come from ops (G: never guess option lists). *(confirmed)*
- **[2]** Staff › typo in name or phone (B11): the invigilator can't correct a row → add "Edit name/phone" on the mark list. *(confirmed)*
- **[2]** Staff › lockout can be dodged with a new browser or private window (new anonymous user); the try counter also resets if the lockout write fails (app.js:179-183) → accept as a known limit, or tie lockouts to phone number in the rules. *(code review)*
- **[1]** Staff › long questions: with a 200-character question and choice, choices C and D sit below the fold on a 390 px phone. The Next button stays pinned and text wraps cleanly, with no sideways scroll. *(confirmed)*

### Invigilator flow

- **[4]** Invigilator page › script injection (stored XSS):
  - Staff-written values go into the page unescaped: the exam ID in `<option value>` (app.js:547) and `data-go` (app.js:566), plus `r.away`, `r.extra` and `sc.*` in the table (app.js:586-588).
  - Reproduced: a staff login wrote an exam ID containing `<img onerror>`, and when the invigilator opened the dashboard the script ran there; it changed the page title. A script running there acts as the invigilator: it can read answer keys and codes, or add invigilators.
  - Fix: escape every value, convert numbers with `Number()`, and validate `examId` in the rules.
  - *(confirmed)*
- **[2]** Invigilator › ready exam left overnight (B16): the next exam is set up automatically when one ends, so the question bank stays locked until someone presses Cancel this exam → add one line to the questions lock notice: "Exams are set up automatically after each one ends." *(confirmed)*
- **[2]** Invigilator › upload accepts duplicate choices (`same`/`same`; the editor refuses them), any number of questions (500 accepted, about 4.6 hours of test with a 180-minute maximum window), and any text length. Near 1,000 long questions the questions and frozen-exam records hit Firestore's 1 MB limit → match the editor's rules and cap at 200 questions. *(confirmed)*
- **[2]** Invigilator › upload error row numbers: blank rows are removed before numbering, so "Row N" can point at the wrong row; a stray `"` in an unquoted CSV cell swallows the rest of the file (questions_upload.js:10-11, 24/31). *(code review)*
- **[2]** Invigilator › silent failures: these Firestore calls swallow errors with no message:
  - `saveMarks`, `clearWaiting`, `freezeOld`, `loadQs`, `loadLiveQs`
  - the admin listeners for `exams`, `marks`, `waiting` and `lockouts`
  - the `results`, key and code listeners, which have no error callback
  - sign-out (app.js ~395, 407, 491, 603, 616, 914, 948-976; firebase.js sign-out)
  
  Fix: show a lasting notice, e.g. "Marks could not be saved. Reload the page."
  *(code review)*
- **[2]** Invigilator › PDF: jsPDF's built-in Helvetica can't draw non-Latin letters such as Greek (α) or Malayalam, so names in those scripts may not print correctly (not checked by eye) → embed a Unicode font (Noto Sans + Noto Sans Malayalam). *(code review)*
- **[1]** Invigilator › sign-in errors appear as one box at the top ("Enter a valid email address."), not next to the field, and no field is highlighted (B27, C9). *(confirmed)*

### Accessibility (WCAG 2.1 AA)

- **[2]** Upload error list (`.qerr`) is 13 px; error text must be at least 14 px (G, 1.4.4). *(style.css:182)*
- **[2]** Password Show/Hide button is 36 px tall; it needs 44 px on phones (2.5.5). *(style.css:207)*
- **[1]** Text at 11–13 px:
  - 11 px: level badge in the question list, admin tag, table headers at 901–1200 px, and the "Phone/Score…" card labels at 900 px and below
  - 13 px: the "Correct" label in the editor, the phone header name line, the answered/skipped line and "Answers saved"
  
  Eyebrow-style labels may be 12 px; table headers should be at least 12 px. *(style.css:188, 204, 217, 225, 235, 241, 272, 280)*
- **[1]** No "skip to content" link. The tab order is otherwise logical: 21 stops in screen order, from Sign out to the status filters. *(confirmed)*

### Copy

- **[2]** "Time is up" when the invigilator ends the exam early, and no message when an exam is cancelled (see Staff flow).
- **[2]** "This assessment is not open yet." on the join page while the code is ready (see Staff flow).
- **[1]** "Start exam for 0 people waiting…" in the start message → "Exam started. Nobody was waiting yet; staff who join now start straight away."
- **[1]** The not-started empty state reads "0 people are waiting." → "No one is waiting yet."
- **[1]** "Locked while this exam is set up (its code has been made)." → "Locked: this exam is ready to start."

### Design system

- **[1]** The logo asset uses #512480 / #F36F21, not the tokens #4A2FA0 / #E86A1A. This is a known open item in the design system: leave as is until a decision is made.
- Pass: gradients only on the invigilator screen (`body.inv`, `#sAdmin`); orange only on the logo and the 2.5 px rule; no emoji; Plus Jakarta Sans; one solid purple button (Start exam); tap targets at least 44 px on the invigilator screen; Sign out 14 px.

### Code

- **[1]** Dead code: `resDocs`, `qHasResults`, `ticker`, `lvCount` (duplicate of `lvOf`), leftover `codeHash` deletes, and an unreachable line at questions_upload.js:115. *(code review)*
- **[1]** The CSV BOM is an invisible character in the source (app.js:779) → write it as `'﻿'`. *(code review)*
- Bundle: `dist/index.html` is 189 KB (single file). SheetJS and jsPDF load from a CDN only when needed. No console errors were seen during the runs.

### Data and privacy (DPDP Act 2023)

- **[3]** Join form: no notice of what's collected, why, who sees it or how long it's kept, and no consent line. *(confirmed)*
- **[3]** Retention:
  - Results (name, phone, clinic, position, answers) are kept until an invigilator deletes them by hand.
  - The phone number is part of each attempt's field name (`a_<examId>_<phone>_…`).
  - Name and phone stay in the phone's local storage if Finish isn't pressed.
  - Anonymous accounts are never cleaned up.
  
  *(confirmed / code review)*
- Who sees it: only invigilators can read results, waiting records and lockouts (confirmed by the rules tests). Staff see only their own name and phone.
- Test data: all tests ran on the local emulator with made-up names. The `?emu` switch works only on localhost, so test data can't reach production.

---

## Steps to reproduce: severity 3 and 4

**[4] Forged score**
1. Open the staff link and join any exam. A session is enough; no code is needed for this step.
2. In the browser console, run: `firebase.firestore().doc('results/'+firebase.auth().currentUser.uid).update({a_x:{track:'pharmacist', examId:'<current exam id>', name:'Forged Topper', phone:'9000000099', answers:[], status:'submitted', sc:{t:50,e:35,m:10,h:5,n:50,of:50,pct:100}}})`
3. The invigilator's mark list shows "Forged Topper 50 100%", and the CSV, Excel and PDF include it.
- Files: `src/app.js:449`, `firestore.rules.template:104`

**[4] Results rule (past exams, late writes, hiding another person's attempt)**
- Run `node <scratch>/rules-gaps.mjs`. GAP-1, GAP-2 and GAP-5 are allowed.
- File: `firestore.rules.template:101-105`

**[4] Script injection on the invigilator page**
1. As staff, run: `…update({a_xss:{track:'pharmacist', examId:'1"><img src=x onerror="document.title=\'PWNED\'">', name:'X', phone:'9000000098', answers:[], status:'submitted'}})`
2. The invigilator opens the Pharmacist dashboard. The tab title becomes "PWNED".
- Files: `src/app.js:547`, `:566`, `:586-588`

**[4] Auto-submit on slow load**
1. Start a test as staff.
2. Throttle the network so the exam state takes more than 3 s to arrive, then reload.
3. The test is submitted as "Time is up" while the exam is still live.
- Files: `src/app.js:977`, `:929`

**[4] Lost final answers**
1. Go offline on the last question and submit. The page says the answers weren't saved.
2. Reload.
3. The session is cleared and the answers are never sent.
- Files: `src/app.js:932`, `:48`, `:238-249`

**[3] Questions readable without the code**
- An anonymous user with no waiting record can read `questions/pharmacist` while the exam is live.
- File: `firestore.rules.template:54`

**[3] Results size**
- GAP-3 in `rules-gaps.mjs` (100,000 answers accepted).
- File: `firestore.rules.template:104`

**[3] Two invigilator tabs**
1. Open the dashboard in two tabs.
2. End the exam, or let it time out.
3. Both tabs set up an exam: two `startedAt` values are written, and the tabs briefly show different codes.
- File: `src/app.js:630-642`

**[3] Questions and key saved separately**
- Read the code: two writes, `questions_upload.js:111-113`.

**[3] freezeOld**
- Write a result with a new exam ID as staff (see the injection test): an `exams/pharmacist_<that id>` record is created from today's questions.
- File: `src/app.js:399-409`

**[3] Phone clock**
- Set a staff phone clock 5 minutes ahead and join a live exam: the test ends 5 minutes early.
- Files: `src/app.js:63`, `:344`

**[3] Stale questions in an open tab**
1. Keep a staff tab open after an exam.
2. Upload new questions, then start the next exam.
3. That tab answers against the old question order.
- File: `src/app.js:913`

**[3] Questions fail to load**
- Block the `questions/` read (go offline at the moment the exam goes live) and reload: the quiz screen throws every tick.
- File: `src/app.js:914`, `:270`

**[3] Same person on two phones**
- Start on phone A, then continue on phone B with the same number: the mark list counts only phone A's first attempt.
- File: `src/app.js:448`

**[3] No privacy notice / no retention**
- See the join form (`src/body.html:72-88`). There is no clean-up job.

---

## Tests run: expected vs actual

| # | Test (check) | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Rules suite `tests/rules.test.mjs` | All pass | 48/48 | ✅ |
| 2 | Staff reads key, code, frozen copy, marks, other people's records, lockout list | Refused | Refused | ✅ |
| 3 | Questions locked while ready or live; editable after cancel or end | As described | As described | ✅ |
| 4 | Only an invigilator can start, end or cancel; staff writing `exam/state` | Refused | Refused (incl. `exam/dietitian`) | ✅ |
| 5 | Staff creates `admins/<email>` (privilege escalation) | Refused | Refused | ✅ |
| 6 | Staff writes another uid's result | Refused | Refused | ✅ |
| 7 | GAP-1: staff writes into a past exam | Refused | **Allowed** | ❌ |
| 8 | GAP-2: staff writes after the exam ended | Refused | **Allowed** | ❌ |
| 9 | GAP-3: 100,000-element answers | Refused | **Allowed** | ❌ |
| 10 | GAP-4: forged `sc` score | Refused / ignored | **Allowed and shown** | ❌ |
| 11 | GAP-5: change answers after submit | Refused | **Allowed** | ❌ |
| 12 | GAP-6/7: lockout and waiting fields forged | Refused | Allowed | ❌ (minor) |
| 13 | Script in a staff-written exam ID (XSS) | Shown as text | **Ran in the invigilator page** | ❌ |
| 14 | B27 invigilator sign-in: empty / wrong password | Field-level error | Top box: "Enter a valid email address." / "Email or password is wrong." | ⚠️ |
| 15 | B27 join form: all empty | 4 field errors | Name, phone, clinic, position errors shown, `aria-invalid` set | ✅ |
| 16 | B27 join form: fix one field | That error clears, text kept | Cleared, kept | ✅ |
| 17 | B27 short phone / short clinic | Specific message | "Enter all 10 digits…", "Enter the clinic you work at." | ✅ |
| 18 | B27 code: empty / 3 characters / lower case | Messages; lower case accepted | "Enter the 6-character code…", "You typed 3.", upper-cased and accepted | ✅ |
| 19 | B27 minutes field (blank / 0 / 300 / 20) | Errors, then amber note; Start off when invalid | As expected (earlier run, unchanged) | ✅ |
| 20 | Upload: wrong headers | Layout error + template | Shown, template offered | ✅ |
| 21 | Upload: missing answer | Row error | "Row 2: answer must be one letter A to D." | ✅ |
| 22 | Upload: answer letter not among the choices | Row error | "answer C points to an empty option" | ✅ |
| 23 | Upload: blank rows | Ignored | Ignored, 2 questions read | ✅ |
| 24 | Upload: 6 options | Refused | Refused with the reason | ✅ |
| 25 | Upload: quotes and commas (CSV) | Kept | Kept | ✅ |
| 26 | Upload: 0 rows | Error | "no questions under them" | ✅ |
| 27 | Upload: 500 rows | Limit or warning | Accepted (520 KB) | ⚠️ |
| 28 | Upload: duplicate choices | Refused (as in the editor) | Accepted | ❌ (minor) |
| 29 | Upload: lower-case level and answer | Accepted | Accepted | ✅ |
| 30 | Waiting list → Start → staff starts | Moves to Started | Works (earlier run + this run) | ✅ |
| 31 | 5 wrong codes → locked → Let them try again | Locks, then unlocks | Works (earlier run) | ✅ |
| 32 | Make a new code while waiting / while live | Old code refused; answering carries on | Works (earlier run) | ✅ |
| 33 | Keyboard: "2" picks B, Enter goes on | Works | Works | ✅ |
| 34 | Skip with nothing chosen | "Skip question", counted as skipped | "1 answered · 1 skipped · 48 left" | ✅ |
| 35 | 33 s timer with no answer | Moves on by itself | Q3 → Q4 after 34.5 s | ✅ |
| 36 | Switch away from the tab | Count shown | "You left the test once. The invigilator can see this." | ✅ |
| 37 | B12 refresh mid-test | Same question, clock continues | Q4, 23 s → 18 s after 5 s | ✅ |
| 38 | B9 offline mid-test, then online | Banner; answers saved later | Banner shown; saved after the next answer; banner lingers until then | ⚠️ |
| 39 | Invigilator ends the exam mid-test | Staff answers saved | Saved, but the title says "Time is up" | ⚠️ |
| 40 | Invigilator cancels while staff wait | Staff told | Not told | ❌ (minor) |
| 41 | Freeze: new questions after an exam | Old marks unchanged | Unchanged (earlier run) | ✅ |
| 42 | B7 two invigilator tabs | One exam, one code | Two exams set up; codes differed for a few seconds, then settled | ❌ |
| 43 | Dietitian, invigilator: no questions | Clear empty state; Start off | "Start exam is blocked. No questions have been uploaded…", Start off, Preview off | ✅ |
| 44 | Dietitian, staff (`#dietitian`) | Dietitian title and positions | "Dietitian assessment", Dietitian … Other | ✅ |
| 45 | Long name (60) / long clinic (60) / 200-character question at 390 px | Wraps, no sideways scroll | Wraps; header name cut off with … ; no sideways scroll | ✅ |
| 46 | Search: name / clinic / phone digits / 2 digits / no match / Esc | As designed | All as designed (earlier run) | ✅ |
| 47 | Picker, not-started state, delete confirmation | As designed | All as designed (earlier run) | ✅ |
| 48 | Downloads: CSV columns, BOM, "α –" | 16 columns, BOM, kept | All as expected | ✅ |
| 49 | Downloads: Excel | Opens, "α –" kept | 18.6 KB, cell B2 "Anitha α – Menon" | ✅ |
| 50 | Downloads: PDF | Builds | 316 KB built; non-Latin letters not checked by eye | ⚠️ |
| 51 | Contrast, light: help, labels, chips, %, buttons, table header | ≥ 4.5:1 | 5.30–17.18:1 | ✅ |
| 52 | Contrast, dark: same | ≥ 4.5:1 | 5.62–14.75:1 | ✅ |
| 53 | Keyboard order on the invigilator screen | Logical | 21 stops in screen order; focus ring 2 px | ✅ |
| 54 | Tap targets under 44 px on the invigilator screen | None | None | ✅ |
| 55 | Screen-reader names: timer, options, group | Named | `role=timer` "Seconds left for this question"; options `role=radio` with checked state; group labelled by the question | ✅ |
| 56 | Screens at 1440 and 390, light and dark | No sideways scroll | None (earlier run + this run) | ✅ |

## What passed

- **Scoring maths is right:** shuffled question and choice order maps back to the original positions, and marking uses the frozen answer key *(code review + the 40/50 test)*.
- **Staff can't read secrets:** the answer key, codes, frozen copies, marks, the waiting list, the lockout list and other people's records are all refused.
- **Codes and the question lock:** the code is checked on the server; a cancelled exam's code stops working; question changes are refused on the server while an exam is ready or live.
- **Frozen marks:** uploading new questions doesn't change past marks.
- **Staff test flow:** keyboard, skip, timer, refresh, leaving the tab and recovering after going offline all work.
- **Dietitian:** the empty state and the staff link are correct.
- **Downloads:** the three formats build, and spreadsheet formulas are blocked in CSV and Excel.
- **Design system:** contrast passes in both themes and tap targets are at least 44 px.

## Top 5 fixes

1. **Lock down `results` in the rules:**
   - allowed keys and types, and no `sc`
   - must be the current live exam, before `endsAt` plus a short grace period
   - must have a waiting record with the same name and phone
   - no changes after submit
   - one doc per attempt
   
   This closes forged scores, rows added to past exams, hiding someone else's attempt, and unlimited size.
2. **Escape everything on the invigilator page** (exam IDs, numbers) and build rows as `{...attempt, sc, extra}` so stored values can't override the computed ones.
3. **Never auto-submit without a known exam state,** and keep the session until the final submit is confirmed by the server (slow load, offline submit).
4. **Set up exams safely:** do set-up in a transaction (two invigilator tabs), save the questions and answer key in one batch, and require the waiting record to read questions.
5. **Add the join-form privacy notice and a retention rule** (needs sign-off below), and fix the staff messages for ended early, cancelled and not open yet.

## Needs sign-off

- **Dr. Rakesh (question and answer content):** the question bank and answer key, whether duplicate choices are ever intended, and the upper limit on questions per exam.
- **Nirmal (personal data and retention):**
  - the join-form notice text and consent line
  - how long results are kept
  - whether phone numbers may sit inside record IDs
  - who besides invigilators may download mark lists
  - the clinic list for the Clinic field

---

Checked: A walkthrough (invigilator, staff), B1, B3, B5, B6, B7, B9, B11, B12, B15, B16, B17, B24, B25 (n/a, see below), B26, B27, C1–C10, D (confirm, tables, forms, empty, messages, numbers), E, F, G (14 px, 44 px, amber, test data), step 7 second role (staff on a phone), WCAG 1.3.1, 1.4.3, 1.4.4, 2.1.1, 2.4.3, 2.4.7, 2.5.5, 3.3.1, 3.3.2, 4.1.2, design-system self-check 1–12 and 14, UX copy review, design critique, dmpro-build-safety §4 roles and access and §5 tests and independent review, rules line-by-line review, rules gap tests GAP-1 to GAP-14, upload validation (13 cases), downloads (3 formats + Unicode), contrast (light + dark), keyboard order, screen-reader names.

Skipped:

- **B25** (any date): the module asks for no dates.
- **B18–B23** (money, stock, approvals): don't apply.
- **dmpro-build-safety §1–3** (worktrees, Postgres migrations, transactions in SQL) and its `docs/shots/` screenshot commit: written for DM Pro's stack, and you asked for no file changes beyond this report.
- **A real throttled-network run (B9) and a real phone lock (B12):** the browser pane has no network throttling or device lock. I simulated offline with Firestore `disableNetwork` and leaving the tab with a visibility event. The two [4] slow-load and offline-submit issues come from code review, not reproduction.
- **Visually checking non-Latin letters in the PDF:** I can't open the PDF here.
- **A real screen reader (VoiceOver or NVDA):** names were read from the accessibility attributes only.
- **Zoom to 200%.**
- **Design-system check 13 (print):** the module has no print view.
- **Focus moving to the first error after Save:** the test tabs ran in the background, where the browser doesn't move focus, so this couldn't be confirmed.
