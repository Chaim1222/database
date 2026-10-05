# ביקורת: טבלאות, עמודות, אינדקסים, views, טאבים ופונקציות (5.10.2026)

**סטטוס: ממצאים והמלצות בלבד. שום שינוי בייצור.** הנתונים נמדדו ב-5.10 מול סופרבייס (קריאה בלבד: `pg_class`, `pg_stat_user_indexes`, `pg_stat_statements`, ספירות עמודות, `get_advisors`). שימוש בעמודות ובטבלאות בקוד נבדק ב-`grep` על `scripts/`, `gadget/`, `.github/workflows` ו-`schema/`/`migrations/`.

**מה לא נבדק:** קוד ה-UI של הגאדג'ט (3,519 שורות) נקרא רק בהגדרות הטאבים וב-`VIEWS`; לא ידוע אילו עמודות כל טאב שולף בפועל מעבר לרשימות `columns`/`displayColumns`. `pg_stat_*` מצטבר מאיפוס אחרון שאינו ידוע, ולכן "0 סריקות" פירושו "לא נסרק מאז האיפוס". שימוש ב-`grep` מראה אזכור ולא שימוש בפועל.

## 1. תמונת נפח

סך הכול כ-400 MB (גבול התוכנית: 500 MB לפי היומן).

| טבלה | שורות | נתונים | אינדקסים | הערה |
|---|---|---|---|---|
| `mechalol_pages` | 382 אלף | 79 MB | **108 MB** | האינדקסים גדולים מהנתונים |
| `wikipedia_pages` | 406 אלף | 66 MB | 48 MB | |
| `word_filter_results` | 25.5 אלף | **51 MB** | 2 MB | `counts` 16 MB, `matches` 14 MB, `images` 1.8 MB (JSONB) |
| `word_filter_occurrences` | 68 אלף | 20 MB | 5 MB | ניתוח בלבד |
| כל השאר (23 טבלאות) | קטנות | פחות מ-1 MB כל אחת | | |

## 2. טבלאות

| טבלה | למה נחוצה | ערך מוסף | המלצה |
|---|---|---|---|
| `wikipedia_pages` | מראה של ויקיפדיה + העשרה + `is_missing` | מקור כל הדוחות | נשארת. ערבוב ארבעה מחזורי חיים (ראו `DB_REDESIGN_PROPOSAL.md`) |
| `mechalol_pages` | מראה של המכלול + מצב טעינה + נגזרים | כנ"ל | נשארת |
| `*_temp` (2) | תאומות להחלפה השבועית | חלק מהמנגנון | נשארות (החלטת חיים); ריקות, 130 KB |
| `manual_matches` (52) | שיוך ידני | חיונית; מוסתרת בדוחות | נשארת. עמודת `reason` משמשת גם כסוג נעילה (`like 'נעול לקריאה%'`): ראו סעיף 7 |
| `blacklist_titles` (2,127) | כותרות שלא ייובאו + נעולים ליצירה | מסננת "חסר במכלול" | נשארת; הוספת עמודת סוג מובנית |
| `page_lock_levels` (1,268) | רמת נעילה | משמשת `verify_locked_pages.py` | **כפילות רעיונית**: נעילה מפוזרת ב-5 מקומות (סעיף 7) |
| `rev_link_check` (316) | משימות גרסה (ארבעה טאבים) | חיונית לטאבי הגרסה | נשארת |
| `wikipedia_creations/deletions/renames`, `mechalol_creations/deletions/renames`, `mechalol_status_update_log` | יומני הדלתא | הפעלת `apply_*`; `wikipedia_renames` מזין את `report_wikipedia_moves` | נשארות. שש טבלאות אירוע זהות במבנה יכלו להיות אחת, אבל הנפח זניח (כולן פחות מ-1 MB): לא שווה מאמץ |
| `sync_watermarks`, `sort_template_sync_state` | נקודות התקדמות | חיוניות | אפשר לאחד, ערך זניח |
| `reconciliation_audit`, `_details`, `reconciliation_diff_summary`, `reconciliation_diff_examples`, `weekly_build_state`, `maintenance_refresh_state` | ביקורת ומצב ריצה | מדידה והתאוששות | נשארות. **`reconciliation_diff_*` כבר קיימות בייצור (6 ו-31 שורות)**: מיגרציית שלב 0 הורצה כנראה ב-4.10. הנתונים טרם נותחו |
| `word_filter_results` | תוצאות הסינון לכל ערך חסר | חיונית לטאב הראשי | נשארת; 51 MB לכ-25 אלף שורות (2 KB לשורה) |
| `word_filter_feedback` (146) | סימוני ✗/✓ | משמשת תיקון הרשימות | נשארת |
| `word_filter_occurrences`, `word_filter_label_sample`, `word_filter_labels`, `word_filter_anchors` | **מסד ניתוח** (26 MB) | **לא נדרש לדשבורד** (כך מצוין ב-`schema.sql`) | **מועמדת להוצאה מהייצור** (החלטה של חיים). עותק של התוויות ב-`word-filter/analysis/missing-labels.json` |

## 3. עמודות

### `wikipedia_pages`
| עמודה | שימוש | הערכה |
|---|---|---|
| `id`, `title` | מפתח וזהות | חיוניות |
| `checked_at` | `default now()`, ערך אחד לכל טעינה (**2 ימים שונים בכל הטבלה**) | **ערך מוסף נמוך**: זמן הטעינה, לא זמן בדיקה אמיתי. מופיעה בייצוא ובתצוגה. מועמדת להסרה (~3 MB) |
| `latest_rev_id`, `latest_rev_ts` | מעקב גרסת מקור | חיוניות |
| `is_missing`, `missing_override_reason` | "חסר במכלול" וטאב הרב | חיוניות. `override_reason` מכילה ערך אחד (191 שורות) |
| `wikidata_desc`, `created_at`, `easy_import_length/_has_images`, `problematic_words_clean`, `mechalol_redirect_exists` | העשרה ל-27 אלף ערכי "חסר" בלבד (6.6%) | נשארות; יושבות על 406 אלף שורות מתוכן 93% ריקות (המלצה קיימת: טבלה צדדית, מושהית) |
| `created_at_checked`, `easy_import_checked` | "ניסינו כבר" | **כרגע זהות בדיוק לספירת הערכים הלא-ריקים** (27,047 ו-27,051): אין כשלים מתועדים. מיותרות בפועל; זולות (בוליאן), עדיפות נמוכה |
| `easy_import_has_images` | | **חפיפה** עם `word_filter_results.has_images`/`photo_count`. שני מקורות לאותו מושג |
| `problematic_words_clean` | `problematic_words.py` | **חפיפה** עם `word_filter_results.verdict`, שהוא המנגנון החדש. לבדוק אם עדיין מוצג |

### `mechalol_pages`
| עמודה | שימוש | הערכה |
|---|---|---|
| `id`, `title`, `status`, `source_type`, `needs_attention`, `is_dictionary_entry` | מראה וסיווג | חיוניות |
| `wikipedia_id`, `match_type` | קישור | חיוניות (`match_type`: 99% בערך אחד, ובכל זאת מוצג) |
| `maybe_deleted_from_wikipedia` (204), `template_referenced_title` (152) | מזינות `report_possibly_deleted_source` ו-`report_tasks_to_handle`, ש**הגאדג'ט הנוכחי לא מציג** (הוסרו במכוון) | **מועמדות להסרה** יחד עם ה-views, אם אין צרכן אחר (ראו סעיף 5) |
| `template_check_access_denied_at` (5 שורות; **2 בלבד** לא מכוסות ב-`sort_template_denied_at`) | נעילה לקריאה (`match.py`) | **כפילות** עם `sort_template_denied_at` (1,266). לאחד לעמודה אחת |
| `rev_id`, `rev_ts`, `sort_template_rev/date/parsed_rev/denied_at`, `source_state` | מעקב גרסה | חיוניות |

### `word_filter_results`
שמונה עמודות רמה: `verdict`, `verdict_suggested`, `ctx_verdict`, `ctx_suspicion`, `ctx_verdict_suggested`, `ctx_suspicion_suggested` (+ `hidden_count`, `names_count` ב-2 גרסאות). הכפל נובע מ"שתי שיטות" (רשימה/הקשר) × "שתי רשימות" (מאושרות/הצעות) בדשבורד. **החלטה של חיים:** האם שתיהן עדיין נחוצות. אם שיטה אחת מספיקה, חצי מהעמודות, מהאינדקסים ומקוד ה-UI יורדים.

## 4. אינדקסים

| אינדקס | גודל | סריקות | הערכה |
|---|---|---|---|
| `mechalol_pages_normalize_person_title_idx` | 31 MB | 3.96M | בשימוש כבד (`recompute_missing_flag`). מועמד להחלפה בעמודת `title_key` (נבדק רק בהצעה, לא במדידה) |
| `wikipedia_pages_title_key` | 31 MB | 97 אלף | חיוני (unique) |
| `mechalol_pages_title_key` / `_pkey` / `_wikipedia_id_idx` | 21 / 20 / 19 MB | 7.5M / 19.8M / 4.4M | חיוניים |
| **`mechalol_pages_sort_template_pending_idx`** | **14 MB** | 343 | **מנופח**: אינדקס חלקי על שורות "ממתינות" שכמעט אין. נכתב בכל עדכון שעתי. `REINDEX CONCURRENTLY` ≈ −13 MB, בלי שינוי סכמה |
| `mechalol_pages_status_idx` | 6.4 MB | 1,201 | ערך נמוך: 7 ערכים בלבד, והדוחות הכבדים משתמשים באינדקסים חלקיים. מועמד להסרה אחרי בדיקת `EXPLAIN` (שאילתה אחת: `status = 'מיובא ומתועד'` מהעדכון השעתי) |
| `mechalol_pages_source_state_idx` | 2 MB | 86 | חלקי על `ahead`; נשאר |
| `word_filter_results_verdict_idx`, `_verdict_suggested_idx` | 0.5 + 0.5 MB | 0 / 1 | **לא בשימוש** (25 אלף שורות; סריקה רגילה מהירה) |
| `word_filter_occurrences_entries_idx` (gin) | 1.7 MB | 0 | לא בשימוש (מסד ניתוח) |
| `word_filter_feedback_entries_idx` | 24 KB | 0 | לא בשימוש (זניח) |
| `mechalol_pages_tasks_idx`, `_maybe_deleted_idx`, `_template_ref_idx`, `_undocumented_idx` | 16-40 KB | 9-255 | זניחים בגודל; שלושה מהם מזינים views שהגאדג'ט לא מציג. הסרה רק לצורך ניקיון |
| `mechalol_pages_temp_template_ref_idx`, `reconciliation_diff_examples_audit_idx` | זניחים | 0 | מדווחים כ"לא בשימוש" ע"י ה-linter |

**סה"כ חיסכון בטוח יחסית:** ~13 MB (REINDEX) + ~2.7 MB (שלושת האינדקסים ללא סריקות) ≈ 16 MB, ועוד ~6 MB אם `status_idx` יורד.

## 5. Views

| view | בשימוש בגאדג'ט הנוכחי | הערכה |
|---|---|---|
| `report_missing_from_mechalol` | כן (ספירה ובסיס) | **הצרכן הגדול ביותר של זמן DB**: 5,532 קריאות × 1.3 שניות (7,344 שניות מצטבר), ועוד 1,106 × 1.9 שניות. הסיבה: `NOT EXISTS` מול `blacklist_titles` על 27.8 אלף שורות בכל קריאה |
| `report_missing_word_filter` (+`_summary`) | כן | מעל הקודם + `LEFT JOIN`; ה-summary כ-4.6-5.5 שניות (מתועד ביומן) |
| `report_undocumented_import`, `report_rev_tasks`, `report_rav_prefix_normalization`, `report_locked_pages`, `report_wikipedia_moves`, `report_source_update`, `report_source_update_freshness`, `word_filter_feedback_summary` | כן | נשארים |
| `report_possibly_deleted_source`, `report_tasks_to_handle` | **לא** (`grep` על `gadget/`) | **אבל** `pg_stat_statements` מראה 549 ו-228 קריאות מצטברות (4.1 ו-4.9 שניות בממוצע). או גרסת גאדג'ט ישנה במטמון אצל משתמשים, או צרכן אחר, או נתון מצטבר ישן. **אי אפשר להסיר לפני שמאפסים את `pg_stat_statements` ובודקים שבוע** |
| `report_source_ahead` | לא | 163 תווים; כנראה מיותר |

**שיפור פשוט ל-`report_missing_from_mechalol`:** להוסיף עמודה `is_blacklisted` (או לקפל את הרשימה השחורה לתוך `is_missing`, כמו שכבר נעשה לנרמול הרבנים) ואינדקס חלקי `where is_missing and not is_blacklisted`. כך ה-view הופך לסינון על ~27 אלף שורות בלי `JOIN`. עלות: עדכון העמודה כשמתווספת כותרת לרשימה השחורה (אחרי `check_missing_locked.py`).

## 6. פונקציות (31)

- **לא נקראו מאז האיפוס** (`track_functions` כבוי, ולכן `calls=0` בכולן: **אין נתון שימוש**).
- **גרסאות כפולות של אותה פעולה:** `recompute_missing_flag` / `_temp` / `_scoped` / `_by_titles` (ארבע); `forward_fill_enrichment_temp` / `_range` (שתיים; הראשונה כנראה מיותרת אחרי מעבר לטווחים); `truncate_mechalol_pages` / `truncate_wikipedia_pages` / `truncate_temp_pages` (שלוש). הפחתה אפשרית רק בעבודת השבועית החדשה (שלב 4 בתוכנית), ולא כעת.
- `analyze_pages_tables`, `db_size_report`: משמשות סקריפטים (`log_db_size.py`).

## 7. נעילות: חמישה מקורות לאותו מושג

"דף נעול" מפוזר בין: `sort_template_denied_at`, `template_check_access_denied_at`, `page_lock_levels`, `manual_matches.reason like 'נעול לקריאה%'` ו-`blacklist_titles` (נעול ליצירה). `report_locked_pages` מאחד אותם ב-`UNION ALL` עם היסט מזהים (`2000000000000 + id`).

**הצעה:** טבלה אחת `page_locks(site, page_id, level, source, detected_at)`. מפשטת את ה-view ואת `verify_locked_pages.py`, ומבטלת את ניתוח הטקסט החופשי של `reason`. **עבודה בינונית**, ולכן לא ראשונה.

## 8. הדשבורד

| קבוצה | טאב | מקור | הערה |
|---|---|---|---|
| ייבוא | חסר במכלול | `report_missing_word_filter` (`mechalol_redirect_exists` לא true) | המרכזי. עמודות: כותרת, נושא, רמה, התאמות, תמונות, תאריך יצירה, פעולה |
| ייבוא | קיים כהפניה | אותו view, `mechalol_redirect_exists` true | פעולה שונה (בדיקת יעד) |
| ייבוא | בקשות ייבוא | API של המכלול | לא מבוסס מסד |
| ייבוא | התאמות הרב/רבי | `report_rav_prefix_normalization` | 191 שורות |
| ייבוא | תרבות | API של המכלול | לא מבוסס מסד |
| עדכון | עדכון | `report_source_update` | דורש התחברות (זמני) |
| תחזוקה | הועברו, הפכו להפניה, גרסה שגויה, נמחקו לפי גרסה | `report_wikipedia_moves`, `report_rev_tasks` | 316 משימות גרסה בסך הכול |
| תחזוקה | ללא תבנית מיון, נעולים | `report_undocumented_import`, `report_locked_pages` | |
| סטטיסטיקה | נתונים סטטיסטיים | ספירות | 3 ספירות בפתיחה (מ-11) אחרי התיקון של 30.9 |

**עמודות בדשבורד שערכן נמוך:**
- `checked_at` (בייצוא של "חסר במכלול"): זמן הטעינה, לא מידע.
- `match_type` בטאב "ללא תבנית מיון": 99% בערך אחד.
- ארבעת טאבי הגרסה מציגים 316 שורות בסך הכול; אפשר לאחד לטאב אחד עם מסנן `rev_task` (חסכון בקוד UI, בבקשות ובמונים).

**שיפורים קלים לדשבורד:**
1. **טבלת ספירות מחושבת מראש** (`dashboard_counts`) שמתעדכנת בסוף ריצות השעתי/הלילית. מחליפה ספירות חיות של views כבדים (שני ה-views הגדולים: 1.3-5 שניות).
2. **ה-view של "חסר" ללא `JOIN` לרשימה שחורה** (סעיף 5).
3. **לא לשלוף `counts`/`matches`/`images` ברשימה:** 16+14+1.8 MB ב-`word_filter_results`. אם הרשימה שולפת אותם לכל שורה, זה הכבד שבעמודות. לשלוף רק בהרחבת שורה (`expand` כבר קיים). **צריך לוודא מה הגאדג'ט שולף בפועל.**
4. **איפוס `pg_stat_statements`** (דורש אישור) כדי שנדע מה באמת נקרא היום ולא מצטבר ישן. מאפשר להחליט על `report_possibly_deleted_source`/`report_tasks_to_handle`.

## 9. ממצאי ה-advisor (סופרבייס, 5.10)

- `auth_rls_initplan` + `multiple_permissive_policies` על `word_filter_feedback`: להחליף `auth.uid()` ב-`(select auth.uid())` ולאחד שני policy ל-SELECT. טבלה של 146 שורות, זניח בביצועים אבל תיקון של שורה אחת.
- `no_primary_key` על `word_filter_label_sample`: מסד ניתוח (מועמד להסרה ממילא).
- `unindexed_foreign_keys` על `weekly_build_state.audit_id`: טבלה זעירה, זניח.

## 10. סדר פעולות מומלץ (מהזול והבטוח)

| # | פעולה | חיסכון / תועלת | מאמץ | סיכון | אישור |
|---|---|---|---|---|---|
| 1 | `REINDEX INDEX CONCURRENTLY mechalol_pages_sort_template_pending_idx` | ~13 MB | דקות | נמוך | כן |
| 2 | הסרת `word_filter_results_verdict_idx`, `_verdict_suggested_idx`, `word_filter_occurrences_entries_idx` | ~2.7 MB | דקות | נמוך | כן |
| 3 | `report_missing_from_mechalol` ללא `JOIN` (עמודה + אינדקס חלקי) | הצרכן הגדול ביותר של זמן DB | שעות | בינוני: נוגע בלוגיקת הרשימה השחורה | כן |
| 4 | איפוס `pg_stat_statements` ומעקב שבוע | נתון אמיתי להחלטות 5-7 | דקות | נמוך | כן |
| 5 | הוצאת מסד הניתוח (26 MB) | ~26 MB | שעות | נמוך (גיבוי בענף `word-filter-corpus`) | **החלטת חיים** |
| 6 | הסרת `mechalol_pages_status_idx` אחרי `EXPLAIN` של השעתי | ~6 MB | שעה | נמוך-בינוני | כן |
| 7 | איחוד `template_check_access_denied_at` ל-`sort_template_denied_at` | פשטות | שעות | בינוני | כן |
| 8 | הסרת `wikipedia_pages.checked_at` | ~3 MB, ופחות רעש | שעה | נמוך; לבדוק ייצוא בגאדג'ט | כן |
| 9 | `dashboard_counts` מחושבת מראש | זמני טעינה | יום | בינוני | כן |
| 10 | טבלת `page_locks` אחת | פשטות | יום+ | בינוני | כן |
| 11 | הסרת `report_possibly_deleted_source`/`report_tasks_to_handle` ועמודותיהן | פשטות | שעות | **רק אחרי #4** | **החלטת חיים** (החלטה מ-4.10: לא מוחקים) |

חיסכון מצטבר של #1, #2, #5, #6, #8 הוא ~50 MB (כ-12% מהנפח), **בלי** נגיעה בלוגיקה.

**החלטות שדרושות מחיים:** (א) האם שתי שיטות הסינון (רשימה/הקשר) והמצב (מאושרות/הצעות) נחוצות; (ב) הוצאת מסד הניתוח; (ג) האם `problematic_words_clean` ו-`easy_import_has_images` עדיין מוצגות או שה-word-filter החליף אותן.
