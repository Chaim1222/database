# מילון מונחים - השוואת ערכים ויקיפדיה↔מכלול

מסמך אינדקס יחיד: לכל שם קובץ/טבלה/פונקציה/משתנה מרכזי בפרויקט - מה
הוא, ולמה קוראים לו ככה. המטרה: לפתוח את הקובץ הזה כשנתקלים בשם לא
מוכר בקוד, ולמצוא הסבר בעברית בלי לחפש בקוד עצמו.

---

## 1. קבצי סקריפט (Python)

### ליבה - מילוי מלא והתאמה
| קובץ | תפקיד |
|---|---|
| `fetch_wikipedia.py` | שולף את **כל** כותרות ויקיפדיה מחדש (`allpages`) ומכניס ל-`wikipedia_pages`. חייב לרוץ **לפני** `fetch_mechalol.py` (ריקון עם CASCADE). |
| `fetch_mechalol.py` | שולף את **כל** נתוני המכלול מחדש (סטטוס, קטגוריות) ומכניס ל-`mechalol_pages`. |
| `match.py` | "מנוע ההתאמה" - מקשר כל שורת מכלול לשורת ויקיפדיה מתאימה (אם יש), בארבעה שלבים (ראו §5 "קסקדת ההתאמה"), ובסוף מחשב מחדש את `is_missing`. |

### דלתא (עדכון יומי הפרשי, בלי ריקון)
| קובץ | תפקיד |
|---|---|
| `delta_api.py` | מודול משותף: שליפת `recentchanges`/`logevents` ממדיה-ויקי (יצירות, מחיקות, שינויי-שם, עריכות, סטטוס הפניה). |
| `fetch_wikipedia_delta.py` | מיישם את השינויים שנמצאו ע"י `delta_api.py` על `wikipedia_pages` (בלי TRUNCATE). |
| `fetch_mechalol_delta.py` | אותו דבר, לצד המכלול - כולל גם זיהוי "הפך להפניה"/עדכון-סיווג מעריכה רגילה (`detect_edited_tracked_changes`), ותיעוד קבוע של זה ב-`mechalol_status_update_log`. |

### העשרה (מריצות אחרי הפיוס, לא בכל ריצה)
| קובץ | תפקיד |
|---|---|
| `fetch_wikidata_descriptions.py` | שולף תיאור קצר מוויקינתונים לשורות `report_missing_from_mechalol`. |
| `fetch_wikipedia_created_at.py` | שולף תאריך יצירת הערך בוויקיפדיה (דורש בקשת API נפרדת - לא ניתן לשלב עם `allpages`). |
| `fetch_easy_import_candidates.py` | בודק "קלות ייבוא" (אורך, תמונות, ניקיון מילים) דרך `problematic_words.py`. |
| `check_missing_redirects.py` | בודק אם יש הפניה (redirect) במכלול תחת אותה כותרת. |
| `problematic_words.py` | ~200 תבניות regex לזיהוי ניסוח בעייתי בטקסט ערך, לשימוש ב-`fetch_easy_import_candidates.py`. |

### ארכיטקטורת ההחלפה האטומית (2026-09, שינוי מינוח shadow/previous→temp)
| קובץ | תפקיד |
|---|---|
| `table_names.py` | המודול המרכזי שמתרגם שם טבלה/RPC בסיסי לשם בפועל, לפי `TARGET_TABLE_SUFFIX` (`table_name`, `rpc_name`, `is_temp_mode`, `current_suffix`). כל שינוי עתידי בשם טבלה עובר דרכו. |
| `forward_fill_enrichment.py` | קורא ל-RPC שמעתיק עמודות העשרה מהטבלה הפעילה לזמנית (כדי לא לאבד מידע שכבר נבדק). |
| `validate_before_swap.py` | "שער האימות" - משווה מספר שורות פעיל מול זמנית, מחליט אם בטוח להחליף. |
| `swap_temp_to_active.py` | מבצע את ההחלפה עצמה (קורא ל-RPC `perform_atomic_swap`), עם ניסיון-חוזר על נעילות זמניות. |
| `log_reconciliation_diff.py` | תיעוד מדיד: מיד אחרי ההחלפה (לפני שהטבלה הזמנית מתרוקנת), משווה את הפעילה מולה ומוציא כל `id` שהדלתא כבר ידעה עליו - מה שנשאר הוא "מה שהעדכון היומי לא היה יכול לתפוס". שורה חדשה ב-`reconciliation_audit` בכל ריצה. |
| `truncate_temp_pages.py` | שלב אחרון בסבב - מריק את הטבלה הזמנית, אחרי שהלוג כבר ניצל אותה. אין יותר חלון rollback (הוסר בכוונה, ראו README.md) - אין עוד שימוש ל-`revert_to_previous.py`/`revert_atomic_swap` שהוסרו. |

### תשתית משותפת
| קובץ | תפקיד |
|---|---|
| `config.py` | קבועים: כתובות API, קטגוריות מכלול. |
| `supabase_client.py` | יצירת חיבור לסופרבייס (`get_client`) + `execute_with_retry` (עטיפת ניסיון-חוזר גנרית לכל קריאת DB). |
| `normalize.py` | כללי נרמול כותרות חד-כיווניים (מכלול→ויקיפדיה) - `hygiene`, `normalize_title`. |
| `mechalol_api.py` | פונקציות תקשורת עם ה-API של מכלול: `log()` (לוג עם חותמת זמן), `login()`, `api_get_with_retry`. |
| `check_missing_locked.py` | בודק כותרות חסומות-ליצירה במכלול (מריץ פעם בחודש). |
| `quarterly_summary.py` | סיכום רבעוני אוטומטי של רשימות ייבוא. |
| `dashboard.html` | **לא בשימוש בפועל** - הגאדג'ט האמיתי הוא קובץ JS נפרד במדיה-ויקי (ראו §7). |

---

## 2. קבצי Workflow (GitHub Actions, `.github/workflows/`)

| קובץ | מתי רץ | תפקיד |
|---|---|---|
| `initial_run.yml` | ידני, חד-פעמי | מילוי בסיס ראשוני מלא. תומך ב-`mode=mechalol_only` למילוי חוזר של טבלה אחת. |
| `nightly_delta.yml` | אוטומטי, כל לילה | דלתא: `fetch_mechalol_delta` → `fetch_wikipedia_delta` → `match.py --scoped`. |
| `biweekly_full_reconciliation.yml` | אוטומטי, 1+15 לחודש | רשת הביטחון המלאה - **מ-2026-09 בארכיטקטורת מראה** (ראו §6). |
| `enrichment_after_reconciliation.yml` | אוטומטי, אחרי הצלחת הדו-שבועי | ארבעת סקריפטי ההעשרה, מקביל. |
| `check_missing_locked.yml` | אוטומטי, 1 לחודש | מריץ את `check_missing_locked.py`. |
| `weekly_update.yml` | **מושבת** | הישן, הוחלף במלואו על ידי הדו-שבועי. נשאר כרפרנס. |

---

## 3. טבלאות (Supabase/Postgres)

### ליבה
| טבלה | תפקיד | הערה |
|---|---|---|
| `wikipedia_pages` | כל דף בוויקיפדיה העברית (מרחב שם ראשי). `id` = ה-`page_id` האמיתי, לא מספר סידורי. |
| `mechalol_pages` | כל דף במכלול. גם כאן `id` הוא `page_id` אמיתי. |

### עמודות לא-מובנות ב-`wikipedia_pages`
| עמודה | תפקיד |
|---|---|
| `is_missing` | true = יש בוויקיפדיה, אין במכלול. **לא מחושב חי** - מתעדכן רק בסוף `match.py` (`recompute_missing_flag`). |
| `missing_override_reason` | למה `is_missing=false` כשההתאמה לא "אמיתית" ממש - כרגע רק `'rav_prefix_normalization'` (הוסרה קידומת "הרב/רבי"). |
| `created_at_checked` / `easy_import_checked` | "נבדק" (true/false) - נפרד מ"יש ערך" (null/לא-null), כי כישלון API לא אמור לספור כ"עדיין לא נבדק" לנצח. |
| `mechalol_redirect_exists` | יש הפניה במכלול תחת אותה כותרת (גם אם אין ערך מלא). |

### עמודות לא-מובנות ב-`mechalol_pages`
| עמודה | תפקיד |
|---|---|
| `match_type` | תוצאת שלב ההתאמה: `'יובא מוויקיפדיה'` / `'כותרת זהה ללא קשר'` / `'ללא התאמה'`. |
| `needs_attention` | הכותרת קיימת אבל בלי תוכן ("ערכים לפתיחה"). |
| `is_dictionary_entry` | תקציר מילוני, לא ערך מלא. |
| `maybe_deleted_from_wikipedia` | חשוד כמחיקה - מקור ודאי-ויקיפדי, בלי התאמה בריצה הנוכחית. |
| `normalization_match` / `normalization_method` | ההתאמה נמצאה דרך נרמול/תבנית, לא כותרת זהה - ואיזה כלל בדיוק. |
| `title_normalized` | הכותרת המנורמלת שנמצאה לה התאמה. |
| `source_type` | מקור השורה: `created`/`translated`/`pirushon`/`chabadpedia`/`wikishiva`/`wikipedia_documented`/`missing_sort`/`unknown`. |
| `template_referenced_title` (2026-09) | השם שתבנית המיון בגוף הערך מצהירה עליו, כשהשם הזה לא נמצא בפועל ב-`wikipedia_pages` - "בעיה בשם" קונקרטית, לא סתם "אין תבנית". `NULL` באין-תבנית או בהתאמה מוצלחת. |
| `template_check_access_denied_at` (2026-09) | חותמת הזמן האחרונה שבדיקת התבנית נדחתה ע"י ה-API (לרוב דף נעול-לקריאה) ולא בוצעה בכלל. `NULL` אם השורה נבדקה בהצלחה לאחרונה - קשור ישירות לנעילת כותרות (`aspaklaryalockdown`). |

### תחזוקה ידנית (לא מתרוקנות)
| טבלה | תפקיד |
|---|---|
| `manual_matches` | התאמות שהאוטומציה לא פתרה לבד. מפתח: `mechalol_page_id`/`wikipedia_page_id`. |
| `blacklist_titles` | כותרות שבכוונה לא יובאו - לא יופיעו כ"חסרות". |

### דלתא (עדכון יומי)
| טבלה | תפקיד |
|---|---|
| `wikipedia_creations` / `mechalol_creations` | דפים חדשים מאז ה-watermark האחרון. |
| `wikipedia_deletions` / `mechalol_deletions` | דפים שנמחקו. |
| `wikipedia_renames` / `mechalol_renames` | שינויי כותרת (לפי `page_id` יציב). |
| `sync_watermarks` | חותמת הזמן האחרונה שנקראה בהצלחה מכל אתר - "עד איפה כבר בדקנו". |

### תיעוד עריכות (2026-09) - לתמיכה בביקורת המדויקת
| טבלה | תפקיד |
|---|---|
| `mechalol_status_update_log` | אילו `page_id`-ים במכלול קיבלו הזדמנות להיבדק מחדש דרך `match.py --scoped` (כולל TEMPLATE API) בעקבות עריכה רגילה (לא יצירה/מחיקה/שינוי-שם) - נכתבת ע"י `fetch_mechalol_delta.py`. בלעדיה, `log_reconciliation_diff` לא היה יכול לדעת שהדלתא כבר ניסתה לטפל בשורה. |

### תיעוד מדיד (2026-09) - האם הריצה המלאה עוד נחוצה
| טבלה | תפקיד |
|---|---|
| `reconciliation_audit` | שורה אחת לכל ריצה דו-שבועית שהחליפה בפועל - כמה שורות הושוו, וכמה מהן קיבלו **קישור** שונה (`match_type`/`wikipedia_id`/`is_missing`) למרות שהדלתא לא ידעה עליהן בכלל. בכוונה לא כולל עמודות תוכן (`needs_attention` וכו') - אלה משתנות כל הזמן מעריכה רגילה, לא קשור לפספוס. המטרה: לצבור עדות לאורך זמן אם עדיין יש טעם בריצה המלאה. |
| `reconciliation_audit_details` | פירוט ברמת שורה לכל "פער לא-מתועד" שנמצא - `page_id`, איזה עמודות השתנו. |

### ארכיטקטורת ההחלפה האטומית (2026-09)
| טבלה | תפקיד |
|---|---|
| `wikipedia_pages_temp` / `mechalol_pages_temp` | טבלה זמנית קבועה אחת (לא נבנית מחדש בכל סבב) עם שני תפקידים לפי שלב: (1) בזמן הריצה - כאן קורים הריקון/מילוי/התאמה של הריצה השבועית, בלי לפגוע בטבלה הפעילה; (2) מיד אחרי ה-swap ועד לריקון בסוף הסבב - מחזיקה את מה שהיה פעיל רגע לפני כן, ל-`log_reconciliation_diff.py`. |

---

## 4. Views (דוחות, `views.sql`)

| View | תפקיד |
|---|---|
| `report_missing_from_mechalol` | דפי ויקיפדיה בלי שום התאמה במכלול (`is_missing=true`), מסונן נגד `blacklist_titles`. כולל גם `easy_import_checked`/`created_at_checked` (נוספו ל-view רק ב-2026-09 - `fetch_easy_import_candidates.py`/`fetch_wikipedia_created_at.py` שואלים ומסננים לפיהן, אבל ה-view לא כלל אותן קודם - כל הרצה נכשלה מיד). |
| `report_possibly_deleted_source` | שורות מכלול שחשודות כ"נמחקו בוויקיפדיה" (`maybe_deleted_from_wikipedia`) - כולל ערכים מילוניים/ערכים-לפתיחה (מ-2026-09; קודם היו מוסתרים משם בטעות). |
| `report_undocumented_import` | שורות עם `status='מיובא ללא תיעוד'` (חסרות תבנית מיון תקינה). |
| `report_tasks_to_handle` | איחוד של ארבעה סוגי משימה, עם עמודת `task_type` להבחנה: חשוד-כמחיקה, סטטוס לא-ברור, שם בתבנית שלא אומת מול ויקיפדיה, ודף נעול שלא ניתן לאמת (מ-2026-09). |

---

## 5. פונקציות SQL (RPC, נקראות מפייתון דרך `client.rpc(...)`)

| פונקציה | תפקיד |
|---|---|
| `normalize_person_title(t)` | מסירה קידומת "הרב "/"רבי " מתחילת כותרת - לשימוש בחישוב `is_missing` בלבד, לא בקישור `wikipedia_id`. |
| `truncate_wikipedia_pages()` | מרוקנת את `wikipedia_pages` (עם `CASCADE` - מרוקנת גם `mechalol_pages` ברמת-טבלה!). |
| `truncate_mechalol_pages()` | מרוקנת את `mechalol_pages` בלבד (בלי CASCADE - אין ממה). |
| `recompute_missing_flag()` | מחשבת מחדש `is_missing`/`missing_override_reason` על **כל** `wikipedia_pages` - נקראת בסוף ריצת `match.py` מלאה. |
| `recompute_missing_flag_scoped(ids)` | אותו חישוב, מוגבל ל-`ids` נתונים - לשימוש ב-`match.py --scoped` (הדלתא הלילית), כדי לא לסרוק את כל הטבלה כל לילה. |
| `recompute_missing_flag_temp()` | גרסה-זמנית של `recompute_missing_flag()`, רצה על `wikipedia_pages_temp`/`mechalol_pages_temp`. |
| `truncate_temp_pages()` | מריקה את שתי הטבלאות הזמניות יחד. נקראת פעמיים בכל סבב: בתחילתו (רשת ביטחון, דרך `truncate_wikipedia_pages` הממופה) ובסופו, אחרי שהלוג רץ (`truncate_temp_pages.py`). מחליפה את `promote_previous_to_shadow_and_truncate()` הישנה - אין יותר "קידום" בכלל, הטבלאות הזמניות קבועות. |
| `forward_fill_enrichment_temp()` | מעתיקה עמודות העשרה (`wikidata_desc`, `created_at`, `easy_import_*` וכו') מהפעילה לזמנית, לפי `id`. |
| `perform_atomic_swap()` | **ההחלפה עצמה**: שלוש החלפות שם אטומיות לכל טבלה (לא שתיים - הפעילה הקודמת חוזרת מיד להיות "_temp" הקבועה, אין יותר "_previous" נפרד), שינוי שם אוטומטי לכל אינדקס/אילוץ בשתי הטבלאות (כך שהשם תמיד ישקף את התפקיד הנוכחי - לא נשאר שריד מדור swap קודם), ובנייה מחדש של ה-views שתלויים בהן. `revert_atomic_swap()` הוסרה - אין יותר חלון rollback. |
| `log_reconciliation_diff()` | משווה פעילה מול הטבלה הזמנית (מיד אחרי swap, לפני שהיא מתרוקנת) - בניכוי מה שהדלתא כבר ידעה, כותבת שורה ל-`reconciliation_audit`. |
| `analyze_pages_tables(table_suffix)` | מרעננת סטטיסטיקות תכנון (`ANALYZE`) על שתי הטבלאות - פעילות או זמניות, לפי הסיומת (`''`/`'_temp'`). נוספה אחרי תקלה אמיתית: טבלה זמנית טרייה בלי סטטיסטיקות גרמה לתוכנית שאילתה גרועה (דקות במקום שניות) ב-`forward_fill_enrichment_temp()`. נקראת מ-`fetch_mechalol.py` בסוף המילוי. |

---

## 6. ארכיטקטורת ההחלפה האטומית - סדר הזרימה המלא

```
fetch_wikipedia.py (TARGET_TABLE_SUFFIX=_temp)
   -> truncate_temp_pages()   # רשת ביטחון - מרוקן את שתי הזמניות (כבר אמורות היו ריקות)
   -> ממלא wikipedia_pages_temp מחדש
        |
        v
fetch_mechalol.py (אותה סיומת)
   -> מדלג על ריקון (כבר קרה למעלה)
   -> ממלא mechalol_pages_temp מחדש
        |
        v
match.py (אותה סיומת)
   -> מתאים כותרות על שתי הטבלאות הזמניות
   -> recompute_missing_flag_temp()
        |
        v
forward_fill_enrichment.py
   -> מעתיק עמודות העשרה מהפעילה לזמנית (forward_fill_enrichment_temp)
        |
        v
validate_before_swap.py           # שער אימות: ספירת שורות פעיל מול זמנית
   -> should_swap=true/false (ל-GITHUB_OUTPUT)
        |
        v  (רק אם should_swap=true)
swap_temp_to_active.py
   -> perform_atomic_swap()       # ההחלפה עצמה, שניות בודדות
        |
        v  (רק אם should_swap=true)
log_reconciliation_diff.py
   -> log_reconciliation_diff()   # תיעוד מדיד: פעילה מול הטבלה הזמנית, בניכוי מה שהדלתא כבר ידעה
        |
        v  (רק אם should_swap=true)
truncate_temp_pages.py
   -> truncate_temp_pages()       # מריק את הטבלה הזמנית - אין חלון rollback
```

`TARGET_TABLE_SUFFIX` (משתנה סביבה, `_temp` או ריק) הוא המתג היחיד שקובע אם סקריפט
עובד על הטבלאות הפעילות או על הזמניות - מתורגם בפועל דרך `table_names.py`.

---

## 7. מונחים/משתנים חוזרים ששווה להכיר

| מונח | פירוש |
|---|---|
| `page_id` | המזהה הקבוע של דף באתר המקור (ויקיפדיה/מכלול) - לא נוצר על ידינו, זה מה שממלא את `id` בטבלאות שלנו. יציב גם אם שם הדף משתנה. |
| `TARGET_TABLE_SUFFIX` | משתנה סביבה (`_temp`/ריק) - קובע אם `fetch_wikipedia.py`/`fetch_mechalol.py`/`match.py` עובדים על הטבלאות הפעילות או על הזמניות. |
| `--scoped` (דגל ב-`match.py`) | מריץ התאמה רק על שורות שהושפעו מהדלתא האחרונה (לא כל הטבלה) - לשימוש ב-`nightly_delta.yml` בלבד, לא בפיוס המלא. |
| `watermark` (ב-`sync_watermarks`) | "עד איפה כבר בדקנו" - חותמת הזמן האחרונה שממנה ממשיכה שאילתת הדלתא הבאה. |
| `service_role` מול `anon` | תפקידי הרשאה בסופרבייס: `service_role` = מפתח שרת (גישה מלאה, עוקף RLS) - בשימוש בסקריפטים. `anon` = ציבור/גאדג'ט (SELECT בלבד). |
| RLS (Row Level Security) | מנגנון הגנה ברמת-שורה בפוסטגרס - כאן פשוט: מדיניות אחת בשם "קריאה ציבורית", SELECT בלבד ל-`anon`. |
| הגאדג'ט | קובץ JS במדיה-ויקי (עמוד מיוחד:דף_ריק/ניהול_ייבוא, פונקציה `mchl-dash`) שפונה ישירות ל-PostgREST - **לא** `dashboard.html` שבריפו. |

---

*מסמך זה מתעד את המצב נכון ל-2026-09. עדכן אותו כשמתווספים קבצים/טבלאות/פונקציות חדשים.*
