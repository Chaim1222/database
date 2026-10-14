# סקירת ענפים ישנים - 14.10.2026

בדיקה לקריאה בלבד של כל הענפים בשני הריפואים מול main. **שום ענף לא נמחק ושום דבר לא הוחל.** ההחלטות של חיים ("תשמור לתכנית, אחליט בהמשך").
המזהה (SHA) של ה-commit האחרון בכל ענף נשמר כאן, כדי שאפשר יהיה לשחזר ענף אחרי מחיקה: `git push origin <sha>:refs/heads/<branch>`.

## ממתין להחלטה

### א. החלטה שאבדה (database, `claude/wizardly-darwin-01dkju`)
ב-29.9 חיים אישר ("כן, תאשר את שניהם") שני ביטויים מותרים, וה-commit לא הגיע ל-main (כנראה אבד בארגון מחדש של הריפו):
- **a047** - "לאונס" כשם (Léonce): ב-main עדיין `suggested`.
- **a048** - "חשופה/חשופים ל..." במובן "נתון ל" (לאש, לסכנה): לא קיים ב-main.
החזרה: מה-commit `9c43a31`, עם `node --test word-filter/tests/*.test.js`, `evaluate.js report --lost`, `build-site.js`, ושורת הכרעה ב-NOTES.

### ב. תיקוני אמינות ל-V2 שלא נכנסו (`fix/audit-repair-plan-20261006`, `fix/review-reliability`)
- `collector/mw.py`: `paged()` מתייחס לתשובה בלי `query` כרשימה ריקה, ו-`categories()` לא בודק שכל דף חזר - דף שלא חזר נחשב "בלי קטגוריות" (סיווג שגוי אפשרי בסנכרון). בענף: `query_field`.
- `ops/apply_migrations.sh`: מיגרציה רשומה במסד שאינה בריפו - רק אזהרה; בענף: יציאה בשגיאה.
- `queue: max` ב-concurrency (DESIGN.md מזכיר), ובדיקות `test_api_contract.py`, `test_migration_guard.py`.
מתאים לנושא הפתוח "מגבלות סלחנות" ב-STATUS של V2.

### ג. PR 15 ב-V2 (`fix/move-source-identity`)
הוכחת זהות מחמירה (לפי גרסה) לדף שהועבר. מתנגש ב-PR 20 שמוזג, ומספר המיגרציה 0036 תפוס. ה-PR סגור (החלטת חיים 13.10). המלצה: למחוק את הענף.

### ד. קטנים / ישנים
- `claude/ecstatic-allen-bfoouf` (database): `gadget-sortTemplateFix.js` - אזור זמן לפי העדפת המשתמש במקום ירושלים קבוע, והגרסה הראשונה בוויקיפדיה בשגיאת "הערך עוד לא היה". רלוונטי רק אם הסקריפט החי בוויקי מתעדכן.
- `claude/friendly-johnson-vtxsbw` (database): בדשבורד, קבוצות הנושא בפאנל המסננים סגורות כברירת מחדל (שורה אחת).
- `claude/new-session-vnu2rv` (database): טאב "עדכון" - פאנל פתרון התנגשויות. מחוץ להיקף עד החלטה (V2 DESIGN, N10).
- `claude/kind-davinci-w9h07q` (database): הסבר תזמון לממצאי ההשוואה ב-V1 (מושהה).
- `claude/nifty-bohr-ekvy9x` (database): דוח ניתוח `locked-dictionary.md` (30.9).
- `claude/supabase-rls-vulnerability-lbrg7z` (database): RLS על `word_filter_label_sample` - פועל כבר במסד V1 (נבדק 14.10); חסר רק REVOKE על טבלאות ניתוח.
- `perf/migration-0031-comparison` (V2): מסמכי בדיקת הספירות של 0031 (הוחלט ונסגר).

## בטוחים למחיקה (התוכן ב-main, הוחלף, או 0 commits מעבר ל-main)

### database

| ענף | commit אחרון | תאריך |
|---|---|---|
| `claude/busy-einstein-wf5k3m` | `9cfc409` | 2026-10-05 |
| `claude/compassionate-darwin-adx76l` | `228bfc2` | 2026-10-05 |
| `claude/drop-wikipedia-norm-idx` | `b6931ef` | 2026-09-30 |
| `claude/eager-albattani-ph0x6u` | `f972e76` | 2026-10-02 |
| `claude/laughing-lamport-szzplr` | `5f9b0c2` | 2026-10-01 |
| `claude/optimistic-bell-woy53q` | `081ef86` | 2026-10-01 |
| `claude/pause-v1-workflow` | `657739f` | 2026-10-05 |
| `claude/relaxed-clarke-nent4s` | `3b4aa05` | 2026-09-29 |
| `claude/upbeat-planck-ookmqj` | `c7ae9bf` | 2026-09-29 |
| `claude/what-wyqbh2` | `920d47f` | 2026-09-24 |
| `feat/shared-dashboard` | `ecb5665` | 2026-10-09 |
| `feature/advanced-normalization` | `8fed51e` | 2026-08-11 |
| `fix/align-production-20261008` | `5bdc078` | 2026-10-08 |
| `fix/delta-replay-classification` | `15995c8` | 2026-10-11 |
| `fix/draft-move-report` | `7c422bf` | 2026-10-07 |
| `fix/hourly-auth-required` | `9c757a9` | 2026-10-10 |
| `fix/old-dashboard-maintenance` | `8cb4388` | 2026-10-07 |
| `fix/revision-response-completeness` | `0328039` | 2026-10-12 |
| `test-dry` | `5a8e500` | 2026-08-29 |

### database_v2

| ענף | commit אחרון | תאריך |
|---|---|---|
| `docs/archive-migration-0031` | `7c37d5b` | 2026-10-06 |
| `docs/deployed-0033-0034-20261006` | `1eb0efe` | 2026-10-06 |
| `docs/v1-v2-decision-audit-20261012` | `da9d716` | 2026-10-11 |
| `feat/shared-dashboard-api` | `abe8599` | 2026-10-09 |
| `feat/shared-dashboard-integrated` | `9a11a6b` | 2026-10-09 |
| `feat/shared-reliability-audit` | `58939f5` | 2026-10-08 |
| `fix/align-production-20261008` | `71ea166` | 2026-10-08 |
| `fix/audit-confirmed-gaps` | `fd081e1` | 2026-10-08 |
| `fix/audit-safe-diagnostics` | `e315da7` | 2026-10-08 |
| `fix/content-scan-after-sync` | `26ee0af` | 2026-10-13 |
| `fix/moves-draft-tasks` | `67099d9` | 2026-10-06 |
| `fix/reconcile-read-recovery` | `6943c9b` | 2026-10-06 |
| `fix/rev-task-freshness` | `6717259` | 2026-10-07 |
| `fix/revision-response-completeness` | `cd58f4c` | 2026-10-12 |
| `fix/runtime-race-and-reconcile` | `b803f68` | 2026-10-06 |
| `fix/sync-every-twelve-hours` | `ebe9a5d` | 2026-10-06 |
| `fix/verify-findings` | `816f299` | 2026-10-08 |
| `fix/wiki-sync-timeout` | `a736637` | 2026-10-11 |

## נשמרים (ממתינים להחלטה או בשימוש)

### database

| ענף | commit אחרון | תאריך |
|---|---|---|
| `claude/clever-brahmagupta-ky5v1y` | `3338624` | 2026-10-14 |
| `claude/ecstatic-allen-bfoouf` | `0aa4ac1` | 2026-10-04 |
| `claude/friendly-johnson-vtxsbw` | `7360daf` | 2026-09-30 |
| `claude/kind-davinci-w9h07q` | `5c91fbf` | 2026-10-04 |
| `claude/new-session-vnu2rv` | `2a8b59e` | 2026-10-01 |
| `claude/nifty-bohr-ekvy9x` | `0949622` | 2026-09-30 |
| `claude/supabase-rls-vulnerability-lbrg7z` | `19702ed` | 2026-10-02 |
| `claude/wizardly-darwin-01dkju` | `9c43a31` | 2026-09-29 |
| `word-filter-corpus` | `8302235` | 2026-09-28 |

### database_v2

| ענף | commit אחרון | תאריך |
|---|---|---|
| `claude/clever-brahmagupta-ky5v1y` | `e52fa47` | 2026-10-14 |
| `fix/audit-repair-plan-20261006` | `23cf075` | 2026-10-06 |
| `fix/move-source-identity` | `f0e88c2` | 2026-10-07 |
| `fix/review-reliability` | `42a1408` | 2026-10-06 |
| `perf/migration-0031-comparison` | `f9d36a3` | 2026-10-06 |
