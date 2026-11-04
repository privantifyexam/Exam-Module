# SugarCARE Exam Module

Timed online staff assessments for SugarCARE Clinics (HomoRx Healthtech). Today it runs as a Claude artifact page with Claude's built-in database; see `docs` in the technical plan for the move to our own domain.

## What it does
- **Assessments:** Pharmacist (50 questions, live) and Dietitian (no questions yet). Each has its own link (`#pharmacist`, `#dietitian`), timer, security code and mark list.
- **Staff flow:** details → 6-character security code → rules → 33 s per question → submit.
- **Security:** per-person shuffle of questions (within easy / medium / hard) and options, tab-leave count, screen wake lock, copy block, leave warning, hashed security code.
- **Invigilator:** home page of all assessments; per-exam dashboard with start/end, code, live count, mark list, CSV / Excel / PDF download, share link, and **test mode** (nothing saved).

## Layout
| Path | What |
| --- | --- |
| `src/body.html` | page markup |
| `src/style.css` | styles (SugarCARE design system) |
| `src/app.js` | all logic |
| `src/questions_pharmacist.js` | the 50 pharmacist questions (no answers) |
| `src/assets/` | design tokens and logo |
| `build.py` | builds the single-file page |
| `dist/index.html` | built page, as published |
| `tests/` | Playwright checks run against a stub database |

## Build
```
python3 build.py        # writes dist/index.html
```

## Data (Claude artifact database)
| Document | Holds | Read | Write |
| --- | --- | --- | --- |
| `exam/state`, `exam/dietitian` | status, start, end, window, code hash | invited staff | invigilator |
| `key/main`, `key/dietitian` | answer key | invigilator | invigilator |
| `key/code`, `key/dietitian-code` | plain security code | invigilator | invigilator |
| `results/<user>` | attempts (`a_<id>` fields, with `track`) | invigilator; owner for own | owner for own |

The answer key is never stored in this repository.

## Questions (CSV upload)
Invigilators upload questions on the assessment dashboard (**Questions and answer key** card). Uploading replaces all questions (`questions/<track>`) and the answer key (`key/main` or `key/dietitian`); it is blocked while an exam is live. **Sample CSV** downloads a template.

| Column | Required | Value |
| --- | --- | --- |
| `level` | yes | `Easy`, `Medium` or `Hard` |
| `question` | yes | question text |
| `option_a` … `option_d` | A and B yes | option text; fill in order |
| `option_e`, `option_f` | no | extra options |
| `answer` | yes | correct option letter, `A` to `F` |

Never commit a filled-in questions CSV: it contains the answer key.

## Tests
```
pip install playwright   # Chromium needed
python3 tests/t5.py      # e.g. test-mode run
```
