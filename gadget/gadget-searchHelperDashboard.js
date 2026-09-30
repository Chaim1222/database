(function () {
	'use strict';

	// ===== זיהוי העמוד - רק מיוחד:דף ריק/ניהול ייבוא, לא בשום עמוד אחר =====
	if (mw.config.get('wgCanonicalSpecialPageName') !== 'Blankpage') return;
	var wgPageName = mw.config.get('wgPageName') || '';
	if (!/\/ניהול_ייבוא$/.test(wgPageName)) return;

	// ===== הגדרות חיבור - לערוך כאן אם צריך =====
	var SUPABASE_URL = 'https://hgsyzaghedqsypisbvev.supabase.co';
	var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhnc3l6YWdoZWRxc3lwaXNidmV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNTY2ODgsImV4cCI6MjEwMTkzMjY4OH0.eDPO3n3OHvmndWDvgF-istBP2NhY5W20erG3zztm7vs';

	var NEW_ARTICLE_CUTOFF_DAYS = 14;
	function newArticleCutoffIso() {
		return new Date(Date.now() - NEW_ARTICLE_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
	}

	var SOURCE_TYPE_LABELS = {
		created: 'נוצר במכלול', translated: 'תורגם במכלול', pirushon: 'פירושון',
		chabadpedia: 'ייבוא מחב"דפדיה', wikishiva: 'ייבוא מוויקישיבה',
		wikipedia_documented: 'מתועד מוויקיפדיה', missing_sort: 'חסר תבנית מיון', unknown: 'לא ידוע'
	};
	var COLUMN_LABELS = {
		title: 'כותרת', status: 'סטטוס', source_type: 'מקור',
		match_type: 'סוג התאמה', wikipedia_id: 'קישור לוויקיפדיה', checked_at: 'נבדק בתאריך',
		wikidata_desc: 'תיאור (ויקינתונים)', created_at: 'תאריך יצירה בוויקיפדיה',
		mechalol_redirect_exists: 'קיים במכלול כהפניה', task_type: 'סוג משימה',
		manual_match_action: 'שיוך ידני', deletion_hint: 'רמז',
		wikipedia_title: 'ערך בוויקיפדיה', mechalol_title: 'דף מקביל במכלול',
		mechalol_status: 'סטטוס במכלול', candidate_count: 'מספר מועמדים',
		mechalol_id: 'מזהה מכלול',
		update_date: 'עודכן לאחרונה', update_bucket: 'טווח עדכון',
		update_change: 'שינוי בוויקיפדיה', update_action: '',
		sort_template_date: 'עודכן לאחרונה (חודש)', sort_template_rev: 'גרסת הבסיס',
		verdict: 'רמת תוכן', has_images: 'תמונות', topic: 'נושא', wf_matches: 'מילים', import_action: '', expand: ''
	};

	// ===== סינון תוכן (word-filter) - טאבי "חסר במכלול" =====
	// התוצאות מחושבות מראש ב-word-filter/tools/scan-missing.js (GitHub Actions)
	// ונשמרות ב-word_filter_results; ה-view report_missing_word_filter מצרף אותן
	// לדוח. לכל ערך שתי פסיקות: לפי הרשימות המאושרות (verdict) ולפי הרשימות
	// כולל ההצעות שעוד לא אושרו (verdict_suggested) - בורר "רשימות" בסרגל.
	// פרטי ההתאמות (המילה והמשפט שלה) נשלפים רק כשפותחים שורה.
	var WF_LEVELS = {
		problem: { label: 'בעיה ודאית', cls: 'mchl-alert' },
		review: { label: 'לבדיקה', cls: 'mchl-review' },
		wording: { label: 'דורש ניסוח', cls: 'mchl-neutral' },
		clean: { label: 'נקי', cls: 'mchl-wiki' },
		names: { label: 'שמות הקודש', cls: 'mchl-neutral' }
	};
	var WF_TOPICS = { modesty: 'צניעות', age: 'גיל העולם', names: 'שמות הקודש', faith: 'אמונה ונצרות', dating: 'תיארוך ומדע', wiki: 'שאריות מוויקיפדיה' };
	var wfMode = 'a'; // a = רשימות מאושרות, s = כולל הצעות
	// שיטה: ctx = לפי הקשר (רמות חשד בתוך "לבדיקה" - המילה והמשפט שלה, ראו
	// word-filter/analysis/word-rates.md); list = לפי הרמה שברשימה בלבד.
	var wfMethod = 'ctx';
	var wfLevelChoice = 'clean';
	var wfDetailsCache = new Map();
	var wfSummary = null; // שורות report_missing_word_filter_summary (למחוון)
	// רשת ביטחון: התאמות בקוד שהקורא לא רואה (יעד קישור, הערה מוסתרת, קובץ...).
	// לא נספרות ברמה; מסנן נפרד (hidden_count) ורשימה נפרדת בשורת ההקשר.
	var wfHiddenChoice = ''; // '' / 'with' / 'without'
	var WF_HIDDEN_KINDS = { l: 'יעד קישור', c: 'הערה מוסתרת', f: 'קובץ', m: 'תבנית', p: 'שם פרמטר', k: 'קטגוריה / מיון', u: 'כתובת', h: 'תגית', x: 'קוד' };
	function wfHiddenColumn() { return wfMode === 's' ? 'hidden_count_suggested' : 'hidden_count'; }
	// שמות הקודש (נושא names) - קטגוריה נפרדת, לא בעיה, לא חשד ולא ניסוח (הכרעת חיים 2026-09-27):
	// לא משפיעים על הרמה; מסנן נפרד (names_count) וקבוצה נפרדת בשורת ההקשר.
	var wfNamesChoice = ''; // '' / 'with' / 'without'
	function wfNamesColumn() { return wfMode === 's' ? 'names_count_suggested' : 'names_count'; }
	// מועמד לייבוא מילוני (עמודת dictionary - word-filter/dictionary.js): ערכי ספורט,
	// מוזיקה, סרטים, שחקנים, טלוויזיה וספרות, לפי תבנית המידע והקטגוריות. לא משפיע על הרמה.
	var wfDictChoice = ''; // '' / 'without' / 'only'
	// נושא הערך (עמודת topic - word-filter/topics.js). בחירה של כמה נושאים; ריק = הכול.
	// הקודים והשמות - אותו סדר כמו TOPICS ב-topics.js.
	var WF_TOPIC_GROUPS = [
		{ label: 'מיוחדים', items: [['disambig', 'פירושונים'], ['years', 'ערכי שנים ותאריכים'], ['lists', 'רשימות'],
			['dictionary', 'ערך מילוני'], ['sensitive', 'נושאים בעייתיים']] },
		{ label: 'אישים', items: [['people_congress', 'חברי קונגרס אמריקאים'], ['people_politics', 'פוליטיקה, ממשל ואצולה'],
			['people_military', 'צבא וביטחון'], ['people_rabbis', 'רבנים ואישי יהדות'], ['people_clergy', 'אנשי דת אחרים'],
			['people_science', 'מדע, רפואה ואקדמיה'], ['people_art', 'אמנות חזותית ואדריכלות'], ['people_literature', 'ספרות ועיתונות'],
			['people_law', 'משפט'], ['people_crime', 'פשע'], ['people_stage', 'קולנוע, במה ובידור'], ['people_business', 'עסקים'],
			['people_public', 'חינוך ופעילות ציבורית'], ['people_other', 'אחר']] },
		{ label: 'נושאים', items: [['art', 'יצירות אמנות'], ['geo', 'גאוגרפיה ומקומות'], ['buildings', 'מבנים ואתרים'],
			['history', 'היסטוריה וצבא'], ['nature', 'טבע ומדע'], ['religion', 'דת ואמונה'], ['orgs', 'ארגונים, מוסדות וחברות'],
			['tech', 'טכנולוגיה'], ['culture', 'תרבות ובידור (לא מילוני)'], ['society', 'חברה ותרבות'], ['other', 'אחר']] }
	];
	var WF_TOPIC_LABELS = {};
	WF_TOPIC_GROUPS.forEach(function (g) {
		g.items.forEach(function (it) { WF_TOPIC_LABELS[it[0]] = g.label === 'אישים' ? 'אישים: ' + it[1] : it[1]; });
	});
	var wfTopicChoice = []; // קודים שנבחרו
	var WF_SUSPICION = {
		high: { label: 'לבדיקה – חשד גבוה', cls: 'mchl-review-high' },
		medium: { label: 'לבדיקה – חשד בינוני', cls: 'mchl-review' },
		low: { label: 'לבדיקה – חשד נמוך', cls: 'mchl-review-low' }
	};
	function wfColumn() {
		var base = wfMethod === 'ctx' ? 'ctx_verdict' : 'verdict';
		return wfMode === 's' ? base + '_suggested' : base;
	}
	function wfSuspicionColumn() { return wfMode === 's' ? 'ctx_suspicion_suggested' : 'ctx_suspicion'; }
	// הרמה של שורה (בעמודות ה-view) לפי השיטה והרשימות שנבחרו:
	// problem / high / medium / low / review (בשיטת הרשימה) / wording / clean / null.
	function wfRowLevel(row) {
		var level = row[wfColumn()];
		if (level === 'review' && wfMethod === 'ctx') return row[wfSuspicionColumn()] || 'review';
		return level || null;
	}
	// מפתח ייחודי לשורה. ברוב ה-views זה id; ב-report_rav_prefix_normalization
	// אין id - כל שורה היא זוג (ערך ויקיפדיה, מועמד במכלול).
	function rowIdOf(row) {
		var cfg = VIEWS[activeTab];
		return String(cfg && cfg.rowId ? cfg.rowId(row) : row.id);
	}
	var VIEWS = {
		deleted: { view: 'report_possibly_deleted_source', label: 'חשוד כמחיקה', columns: ['title', 'status', 'source_type', 'match_type', 'deletion_hint'], filters: [] },
		undoc: { view: 'report_undocumented_import', label: 'מיובא ללא תיעוד', columns: ['title', 'source_type', 'match_type', 'wikipedia_id'], filters: [] },
		// מאחד את שתי הקטגוריות למעלה (חשוד-כמחיקה, ללא-תיעוד) עם שתי
		// קטגוריות חדשות (2026-09): "בעיה בשם" (template_referenced_
		// title - יש תבנית מיון עם שם שלא נמצא בוויקיפדיה) ו"דף נעול"
		// (template_check_access_denied_at - בדיקת התבנית נדחתה, לרוב
		// כי הדף נעול-לקריאה). עמודת task_type מבחינה ביניהן.
		// סוגי המשימות הופרדו ב-2026-09 (migration_review_fixes_2026_09.sql):
		// "לבדוק מחיקה" פוצל לתבנית שמצביעה על שם שכבר לא קיים (בדרך כלל
		// שינוי שם בוויקיפדיה) מול דף בלי שום מקביל, ו"סטטוס לא ברור" פוצל
		// לחסרי תבנית מיון (לפי סימון המכלול עצמו) מול מקור לא ידוע.
		tasks: {
			view: 'report_tasks_to_handle', label: 'משימות לטיפול',
			columns: ['title', 'task_type', 'status', 'source_type', 'match_type'],
			filters: [{
				key: 'task_type', label: 'סוג משימה',
				options: ['שם בתבנית המיון לא קיים בוויקיפדיה', 'לא נמצא מקביל בוויקיפדיה', 'חסרה תבנית מיון', 'מקור לא ידוע', 'דף נעול - לא ניתן לאמת']
			}]
		},
		// "חסר במכלול" מופרד לשני טאבים: כותרות שבאמת אין להן כלום במכלול,
		// מול כותרות שקיימות במכלול כהפניה (הערך כנראה קיים שם בשם אחר -
		// פעולה שונה לגמרי: לבדוק את יעד ההפניה, לא לייבא).
		missing: {
			view: 'report_missing_word_filter', label: 'חסר במכלול',
			// columns - לייצוא; displayColumns - מה שמוצג בטבלה (התיאור מוויקינתונים מתחת לכותרת).
			columns: ['title', 'verdict', 'topic', 'has_images', 'created_at', 'mechalol_redirect_exists', 'checked_at', 'wikidata_desc'], filters: [],
			displayColumns: ['title', 'topic', 'verdict', 'wf_matches', 'has_images', 'created_at', 'import_action', 'expand'],
			baseFilters: [['mechalol_redirect_exists', 'not.is.true']],
			titleLink: 'edit', wikidata: true, easyImport: true, redirectFilter: true, lockable: true, manualMatch: true
		},
		missing_redirect: {
			view: 'report_missing_word_filter', label: 'קיים במכלול כהפניה',
			columns: ['title', 'verdict', 'topic', 'has_images', 'created_at', 'checked_at', 'wikidata_desc'], filters: [],
			displayColumns: ['title', 'topic', 'verdict', 'wf_matches', 'has_images', 'created_at', 'import_action', 'expand'],
			baseFilters: [['mechalol_redirect_exists', 'is.true']],
			titleLink: 'edit', wikidata: true, easyImport: true, manualMatch: true
		},
		// ערכים שוויקיפדיה התקדמה בהם מאז העדכון האחרון (source_state = 'ahead', ראו
		// SOURCE_TRACKING_NOTES.md). זה גבול עליון: גם שחזור או עריכה קטנה נספרים, ולכן
		// כל שורה מקושרת להשוואת גרסאות בוויקיפדיה. הממוין לפי חודש העדכון המתועד
		// (`תאריך=`), הישנים קודם. שובר שוויון לפי id, כי החודש לא ייחודי והעימוד יקפוץ בלעדיו.
		update: {
			view: 'report_source_update', label: 'עדכון',
			columns: ['title', 'sort_template_date', 'update_bucket', 'sort_template_rev', 'wikipedia_id'],
			displayColumns: ['title', 'update_date', 'update_change', 'update_action'],
			filters: [{
				key: 'update_bucket', label: 'עודכן',
				options: ['בשנה האחרונה', 'לפני שנה עד שנתיים', '2020 עד לפני שנתיים', 'לפני 2020', 'ללא תאריך']
			}],
			order: 'sort_template_date.asc.nullslast,id.asc', titleLink: 'edit', freshness: true, liveChange: true,
			group: 'wikiupdate',
			// זמני: מוצג רק למי שמחובר עם משתמש וסיסמה (פאנל הניהול), כמו שיוך כותרות. להסרה: למחוק את השורה.
			requiresLogin: true
		},
		// ערכי ויקיפדיה שהוצאו מ"חסר במכלול" רק בגלל כותרת זהה אחרי הסרת
		// "הרב"/"רבי" - לא התאמה ודאית, דורש אישור אנושי. ה-view היה קיים
		// אבל לא הוצג בגאדג'ט.
		rav: {
			view: 'report_rav_prefix_normalization', label: 'התאמות "הרב/רבי" לבדיקה',
			columns: ['wikipedia_title', 'mechalol_title', 'mechalol_status', 'candidate_count'], filters: [],
			rowId: function (r) { return r.wikipedia_id + '-' + r.mechalol_id; },
			countColumn: 'wikipedia_id', searchColumn: 'wikipedia_title', titleColumn: 'wikipedia_title',
			order: 'wikipedia_title.asc', exportIdColumns: ['wikipedia_id', 'mechalol_id']
		}
	};
	// טאב "דפים לטיפול - תרבות" - לא מבוסס Supabase כמו VIEWS למעלה,
	// אלא שליפה חיה מה-API של המכלול עצמו (רשימת חברי קטגוריה בלבד -
	// אין תוכן בדפים האלה מלבד תבנית הסיווג, אז אין טעם/צורך לשלוף
	// אותם דרך מסד הנתונים בכלל). ראו EXTRA_TABS, cultureState,
	// loadCultureSubcats/loadCultureMembers למטה.
	var EXTRA_TABS = { requests: { label: 'בקשות ייבוא' }, culture: { label: 'דפים לטיפול - תרבות' }, stats: { label: 'נתונים סטטיסטיים' } };
	// הטאבים בשתי שורות: קבוצה, ומתחתיה הטאבים שלה.
	var TAB_GROUPS = [
		{ key: 'import', label: 'ייבוא', tabs: ['missing', 'requests', 'missing_redirect', 'rav', 'culture'] },
		{ key: 'update', label: 'עדכון', tabs: ['update'] },
		{ key: 'maint', label: 'תחזוקה', tabs: ['tasks', 'deleted', 'undoc'] },
		{ key: 'stats', label: 'נתונים סטטיסטיים', tabs: ['stats'] }
	];
	// טאב עם group (ב-VIEWS) מוצג רק למי שדרגתו לפחות כדרגת הקבוצה. זו בדיקת נראות בצד
	// הלקוח בלבד, לא הגנה: הנתונים עצמם קריאים ל-anon.
	function tabAllowed(key) {
		var v = VIEWS[key];
		if (v && v.requiresLogin && !serviceKeyConnected) return false;
		return !(v && v.group && userLevel < (GROUP_LEVELS[v.group] || Infinity));
	}
	function groupOfTab(key) { return TAB_GROUPS.filter(function (g) { return g.tabs.indexOf(key) >= 0; })[0] || TAB_GROUPS[0]; }
	var CATEGORY_MAINTENANCE_CULTURE = 'קטגוריה:דפים לטיפול תרבות';
	// יחסי בכוונה, לא כתובת מלאה - הגאדג'ט רץ כבר בתוך הדומיין של
	// המכלול (בניגוד לקובץ dashboard.html העצמאי, שצריך כתובת מלאה +
	// origin=* ל-CORS). wgScriptPath מתאים את עצמו אוטומטית לכל
	// התקנת מדיה-ויקי, לא קבוע-קשיח.
	var MECHALOL_API = mw.config.get('wgScriptPath') + '/api.php';
	var STAT_DEFS = [
		{ key: 'wiki', table: 'wikipedia_pages', estimated: true, statId: 'mchl-stat-wiki-total', spinId: 'mchl-spin-wiki', warnId: 'mchl-warn-wiki', warnMsg: 'לא ניתן לקרוא את wikipedia_pages — יש לבדוק RLS/הרשאות.' },
		{ key: 'mechalol', table: 'mechalol_pages', estimated: true, statId: 'mchl-stat-mechalol-total', spinId: 'mchl-spin-mechalol', warnId: 'mchl-warn-mechalol', warnMsg: 'לא ניתן לקרוא את mechalol_pages — יש לבדוק RLS/הרשאות.' },
		{ key: 'tasks', table: 'report_tasks_to_handle', statId: 'mchl-stat-tasks', spinId: 'mchl-spin-tasks', warnId: 'mchl-warn-tasks', warnMsg: 'לא ניתן לקרוא את report_tasks_to_handle.', tabCount: 'mchl-tab-count-tasks' },
		{ key: 'deleted', table: 'report_possibly_deleted_source', statId: 'mchl-stat-deleted', spinId: 'mchl-spin-deleted', warnId: 'mchl-warn-deleted', warnMsg: 'לא ניתן לקרוא את report_possibly_deleted_source.', tabCount: 'mchl-tab-count-deleted' },
		{ key: 'undoc', table: 'report_undocumented_import', statId: 'mchl-stat-undoc', spinId: 'mchl-spin-undoc', warnId: 'mchl-warn-undoc', warnMsg: 'לא ניתן לקרוא את report_undocumented_import.', tabCount: 'mchl-tab-count-undoc' },
		{ key: 'missing', table: 'report_missing_from_mechalol', viewKey: 'missing', statId: 'mchl-stat-missing', spinId: 'mchl-spin-missing', warnId: 'mchl-warn-missing', warnMsg: 'לא ניתן לקרוא את report_missing_from_mechalol.', tabCount: 'mchl-tab-count-missing' }
	];

	// ===== מצב האפליקציה =====
	var wikidataCache = new Map();
	var wikidataInFlight = new Set();
	// הצעה אוטומטית לכלי השיוך הידני, מבוססת הפניה קיימת במכלול (ראו
	// mechalol_redirect_exists) - title -> {targetTitle, mechalolId} |
	// null (אין הפניה בפועל/כשלון פתרון) | (לא ב-Map בכלל = טרם נבדק).
	var mechalolRedirectTargetCache = new Map();
	var mechalolRedirectTargetInFlight = new Set();
	// רמז לטאב "חשוד כמחיקה" (ראו loadDeletionHintsForCurrentPage) -
	// title (של שורת מכלול) -> {type: 'rename'|'deletion', ...} | null
	// (אין רמז בטבלאות הדלתא שלנו) | (לא ב-Map בכלל = טרם נבדק).
	var deletionHintCache = new Map();
	var deletionHintInFlight = new Set();
	var activeTab = 'missing';
	// סולם ההרשאות: קבוצה גבוהה יותר רואה גם את מה שנועד לקבוצות נמוכות ממנה.
	var GROUP_LEVELS = {
		sysop: 20, bot: 18, aspaklarya2: 16, aspaklaryaEditor: 14,
		patroller: 12, wikiupdate: 10, wikimport: 8
	};
	var userLevel = 0;
	var currentPage = 0;
	var pageSize = 50;
	var totalRows = 0;
	var countUnknown = false;
	var totalPages = 1;
	var currentPageRows = [];
	var activeFilters = {};
	var searchDebounce = null;
	var loadRequestId = 0;
	var selectedRows = new Map();
	var cultureState = { subcats: null, selected: null, members: [], continueToken: null, loading: false };
	// שמור ב-sessionStorage (לא localStorage) - נשאר בין רענוני דף כל
	// עוד הטאב פתוח, נעלם כשסוגרים אותו. לא עוגייה בכוונה: העוגייה
	// הייתה נשמרת על דומיין המכלול, לא של סופרבייס - היינו צריכים בכל
	// מקרה לקרוא אותה ולצרף ידנית לכותרת Authorization, בדיוק כמו
	// sessionStorage - בלי שום יתרון, ועם המגבלות של עוגייה (גודל,
	// שליחה אוטומטית ללא-קשר לבקשות אחרות) בלי סיבה.
	var SESSION_STORAGE_KEY = 'mchl-auth-session';
	var serviceKeyConnected = false;

	function $id(id) { return document.getElementById(id); }
	// העדפות תצוגה של המשתמש (תפריט האתר, פאנל המסננים, מקטעים מקופלים) - localStorage, עם fallback.
	var UI_PREFS_KEY = 'mchl-ui-prefs';
	var uiPrefs = (function () { try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}') || {}; } catch (e) { return {}; } }());
	function saveUiPrefs() { try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiPrefs)); } catch (e) { /* לא נשמר - לא נורא */ } }
	function mechalolUrl(id) { return 'https://www.hamichlol.org.il/w/index.php?curid=' + id; }
	function wikipediaUrl(id) { return 'https://he.wikipedia.org/w/index.php?curid=' + id; }
	function mechalolEditUrl(title) { return 'https://www.hamichlol.org.il/w/index.php?title=' + encodeURIComponent(title.replace(/ /g, '_')) + '&action=edit'; }
	function rowKey(row) { return activeTab + ':' + rowIdOf(row); }
	function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	var RETRY_ATTEMPTS = 3, RETRY_DELAY_MS = 900;
	function withRetry(fn, attempts) {
		attempts = attempts || RETRY_ATTEMPTS;
		var i = 0;
		function attempt() {
			i++;
			return fn().catch(function (e) {
				// timeout של השרת (57014): ניסיון חוזר רק מכפיל את העומס על אותו מסד איטי, ולכן לא מנסים שוב.
				if (i < attempts && !(e && e.code === '57014')) return sleep(RETRY_DELAY_MS * i).then(attempt);
				throw e;
			});
		}
		return attempt();
	}

	/*
	 * מזהה שגיאה "זמנית" (המסד באמצע עדכון תקופתי שבועי - ראו
	 * mirror_architecture_design.md, שלב 5: ALTER TABLE RENAME תחת
	 * lock_timeout קצר, ורענון מטמון PostgREST מיד אחרי ה-commit)
	 * לעומת שגיאה "קבועה" (כתובת/מפתח/הרשאות שגויים - לא ייפתר לבד).
	 *
	 * חתימות ידועות לשגיאה זמנית:
	 * - HTTP 503 - PostgREST באמצע בניית מטמון סכימה מחדש
	 * - קוד PGRST002 - "Could not query the database for the schema cache"
	 * - SQLSTATE 55P03 (lock_not_available) / 57014 (query_canceled) -
	 *   בדיוק התרחיש של lock_timeout על ALTER TABLE RENAME תוך כדי swap
	 * שים לב: זיהוי משוער לפי מיטב הידיעה על צורת השגיאות של Supabase/
	 * PostgREST - אם מתגלה בעתיד תבנית נוספת שמעידה על אותה תופעה, יש
	 * להוסיף אותה כאן.
	 */
	function isTransientMaintenanceError(e) {
		var status = e && e.status;
		var code = (e && e.code) ? String(e.code) : '';
		var msg = ((e && e.message) ? e.message : '').toLowerCase();
		return status === 503
			|| code === 'PGRST002'
			|| code === '55P03'
			|| code === '57014'
			|| msg.indexOf('schema cache') !== -1
			|| msg.indexOf('lock') !== -1;
	}

	// ===== שכבת גישה ל-PostgREST של סופרבייס - במקום ספריית supabase-js =====
	// משכפלת בכוונה את אותה תחביר בדיוק שה-URL שסופרבייס-js היה שולח,
	// כדי לשמור על התנהגות זהה (כולל '%' כתו-כללי בתוך ilike/or - זה
	// עובד תקין אחרי קידוד URL רגיל על ידי URLSearchParams, בדיוק כמו
	// שסופרבייס-js עצמו עושה).
	function pgHeaders(extra) {
		var h = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY };
		if (extra) for (var k in extra) h[k] = extra[k];
		return h;
	}

	// כמו pgHeaders, אבל עם הטוקן של המשתמש המחובר (authenticated) -
	// לא מפתח ה-anon - לפעולות שדורשות RLS ברמת authenticated (כרגע:
	// שיוך התאמה ידנית ל-manual_matches בלבד). נופל בחזרה למפתח ה-anon
	// אם אין סשן שמור (לא אמור לקרות בפועל - הכפתורים שמשתמשים בזה
	// מוסתרים כש-serviceKeyConnected=false, אבל הגנה נוספת לא מזיקה).
	function authHeaders(extra) {
		var token = SUPABASE_ANON_KEY;
		try {
			var raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
			if (raw) {
				var parsed = JSON.parse(raw);
				if (parsed && parsed.access_token) token = parsed.access_token;
			}
		} catch (e) { /* מתעלמים - נופל בחזרה למפתח ה-anon */ }
		var h = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
		if (extra) for (var k in extra) h[k] = extra[k];
		return h;
	}

	// בונה שגיאה עם status וקוד PostgREST (אם קיים בגוף התשובה) מצורפים
	// כמאפיינים אמיתיים - לא רק מחרוזת - כדי ש-isTransientMaintenanceError
	// יוכל לסווג אותה בלי להסתמך רק על ניחוש טקסט.
	function makePgError(status, bodyText) {
		var code = null, message = 'HTTP ' + status;
		if (bodyText) {
			try {
				var parsed = JSON.parse(bodyText);
				if (parsed && parsed.code) code = parsed.code;
				if (parsed && parsed.message) message = parsed.message;
			} catch (parseErr) {
				message = 'HTTP ' + status + ': ' + bodyText;
			}
		}
		var err = new Error(message);
		err.status = status;
		if (code) err.code = code;
		return err;
	}

	// ספירה בלבד (ל-STAT_DEFS ולמונה ה"תואמים") - שולף שורה אחת בלבד
	// ומסתמך על כותרת Content-Range לספירה, כדי לא למשוך נתונים מיותרים.
	// estimated: הערכה מהמתכנן (Prefer: count=estimated) במקום ספירה מדויקת - לטבלאות הגדולות, שם ספירה מדויקת לוקחת שניות.
	function pgCount(table, rawFilterParams, countColumn, estimated) {
		return withRetry(function () {
			var params = new URLSearchParams();
			params.set('select', countColumn || 'id');
			if (rawFilterParams) rawFilterParams.forEach(function (pair) { params.append(pair[0], pair[1]); });
			var url = SUPABASE_URL + '/rest/v1/' + table + '?' + params.toString();
			return fetch(url, { headers: pgHeaders({ Range: '0-0', Prefer: estimated ? 'count=estimated' : 'count=exact' }) }).then(function (res) {
				if (!res.ok) return res.text().then(function (t) { throw makePgError(res.status, t); });
				var cr = res.headers.get('Content-Range') || '';
				var total = parseInt(cr.split('/')[1], 10);
				// ספירה חסרה היא "לא ידוע", לא אפס.
				if (isNaN(total)) throw new Error('הספירה לא התקבלה מהמסד');
				return total;
			});
		});
	}

	// שליפת דף עם נתונים + ספירה מדויקת מקבילה - למסכי הטבלה, לייצוא,
	// ול"בחר את כל התוצאות התואמות".
	// כל השורות שעונות לסינון, בדפים של 1,000 (סופבייס מחזיר עד 1,000 שורות לבקשה).
	// סדר יציב (עם שובר שוויון), כדי שדפים לא יחפפו או ידלגו. onProgress(שנטענו, סך הכול).
	var PG_CHUNK = 1000;
	function pgSelectAll(view, opts, onProgress) {
		var rows = [], expected = null;
		function next() {
			return pgSelect(view, { filterParams: opts.filterParams, order: opts.order, from: rows.length, to: rows.length + PG_CHUNK - 1 }).then(function (res) {
				var data = res.data || [];
				if (res.count != null) expected = res.count;
				rows = rows.concat(data);
				if (onProgress) onProgress(rows.length, expected);
				var more = expected != null ? rows.length < expected : data.length === PG_CHUNK;
				if (data.length && more) return next();
				return { data: rows, expected: expected, complete: expected == null || rows.length >= expected };
			});
		}
		return next();
	}
	function stableOrder(cfg) {
		var order = cfg.order || 'title.asc';
		var tie = cfg.rowId ? 'mechalol_id.asc' : 'id.asc';
		return order.indexOf(tie.split('.')[0] + '.') >= 0 ? order : order + ',' + tie;
	}

	function pgSelect(view, opts) {
		return withRetry(function () {
			var params = new URLSearchParams();
			params.set('select', '*');
			(opts.filterParams || []).forEach(function (pair) { params.append(pair[0], pair[1]); });
			if (opts.order) params.set('order', opts.order);
			var url = SUPABASE_URL + '/rest/v1/' + view + '?' + params.toString();
			var headers = pgHeaders({ Range: opts.from + '-' + opts.to, 'Range-Unit': 'items', Prefer: 'count=exact' });
			return fetch(url, { headers: headers }).then(function (res) {
				if (!res.ok) return res.text().then(function (t) { throw makePgError(res.status, t); });
				var cr = res.headers.get('Content-Range') || '';
				var total = parseInt(cr.split('/')[1], 10);
				return res.json().then(function (data) { return { data: data, count: isNaN(total) ? null : total }; });
			});
		});
	}

	// בונה את רשימת פרמטרי הסינון (כזוגות [שם, ערך], כדי לתמוך במפתחות
	// חוזרים כמו 'or') מתוך activeFilters + חיפוש חופשי, בדיוק כמו
	// buildQuery() בגרסת ה-HTML המקורית.
	function buildFilterParams() {
		var cfg = VIEWS[activeTab];
		var out = (cfg.baseFilters || []).slice();
		var search = ($id('mchl-search-input').value || '').trim();
		if (search) {
			var searchColumn = cfg.searchColumn || 'title';
			if (cfg.wikidata) {
				// בתוך or=(...) ערך עם סוגריים/פסיקים/מירכאות (נפוצים בכותרות:
				// "X (סרט)", "ג'יטו, קיסרית יפן", זק"א) שובר את התחביר של PostgREST -
				// חייבים לעטוף במירכאות כפולות ולבצע escape ל-" ול-\.
				var quoted = '"%' + search.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '%"';
				out.push(['or', '(' + searchColumn + '.ilike.' + quoted + ',wikidata_desc.ilike.' + quoted + ')']);
			} else {
				out.push([searchColumn, 'ilike.%' + search + '%']);
			}
		}
		Object.keys(activeFilters).forEach(function (k) {
			var v = activeFilters[k];
			if (v && typeof v === 'object') {
				out.push([k, v.op + '.' + v.value]);
			} else {
				out.push([k, 'eq.' + v]);
			}
		});
		return out;
	}

	// ===== תיאורים מוויקינתונים (לטבלת "חסר במכלול" בלבד) =====
	function fetchWikidataDescriptions(titles) {
		titles.forEach(function (t) { wikidataInFlight.add(t); });
		var chunks = [];
		for (var i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));
		var chain = Promise.resolve();
		chunks.forEach(function (chunk) {
			chain = chain.then(function () {
				var url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&sites=hewiki&titles=' +
					chunk.map(encodeURIComponent).join('|') +
					'&props=descriptions%7Csitelinks&languages=he&format=json&origin=*';
				return withRetry(function () {
					return fetch(url).then(function (res) {
						if (!res.ok) throw new Error('HTTP ' + res.status);
						return res.json();
					});
				}, 2).then(function (data) {
					chunk.forEach(function (t) { if (!wikidataCache.has(t)) wikidataCache.set(t, ''); });
					if (data.entities) {
						Object.keys(data.entities).forEach(function (k) {
							var ent = data.entities[k];
							if (ent.missing !== undefined) return;
							var linkedTitle = ent.sitelinks && ent.sitelinks.hewiki ? ent.sitelinks.hewiki.title : null;
							var desc = ent.descriptions && ent.descriptions.he ? ent.descriptions.he.value : '';
							if (linkedTitle) wikidataCache.set(linkedTitle, desc);
						});
					}
				}).catch(function () {
					chunk.forEach(function (t) { wikidataCache.set(t, null); });
				});
			});
		});
		chain.then(function () {
			titles.forEach(function (t) { wikidataInFlight.delete(t); });
			paintWikidataDescriptions();
		});
	}

	function paintWikidataDescriptions() {
		document.querySelectorAll('#mchl-dash [data-desc-title]').forEach(function (el) {
			var t = el.getAttribute('data-desc-title');
			if (!wikidataCache.has(t)) return;
			var val = wikidataCache.get(t);
			el.classList.remove('mchl-skeleton', 'mchl-muted');
			if (val === null) { el.textContent = 'שגיאה בשליפה'; el.classList.add('mchl-muted'); }
			else if (val === '') { el.textContent = '—'; el.classList.add('mchl-muted'); }
			else { el.textContent = val; }
		});
	}

	function loadWikidataDescriptionsForCurrentPage() {
		if (!VIEWS[activeTab] || !VIEWS[activeTab].wikidata) return;
		currentPageRows.forEach(function (r) {
			if (r.wikidata_desc !== null && r.wikidata_desc !== undefined && !wikidataCache.has(r.title)) {
				wikidataCache.set(r.title, r.wikidata_desc);
			}
		});
		var need = currentPageRows.map(function (r) { return r.title; }).filter(function (t) { return !wikidataCache.has(t) && !wikidataInFlight.has(t); });
		if (need.length === 0) { paintWikidataDescriptions(); return; }
		fetchWikidataDescriptions(need);
	}

	// ===== הצעה אוטומטית לשיוך ידני, מהפניה קיימת במכלול (לטבלת "חסר
	// במכלול" בלבד, ורק כש-serviceKeyConnected - אין טעם לבדוק בכלל אם
	// עמודת השיוך הידני עצמה לא מוצגת) =====
	function loadRedirectTargetsForCurrentPage() {
		if (!VIEWS[activeTab] || !VIEWS[activeTab].manualMatch || !serviceKeyConnected) return;
		var need = currentPageRows
			.filter(function (r) { return r.mechalol_redirect_exists === true; })
			.map(function (r) { return r.title; })
			.filter(function (t) { return !mechalolRedirectTargetCache.has(t) && !mechalolRedirectTargetInFlight.has(t); });
		if (need.length === 0) { paintRedirectTargetSuggestions(); return; }
		resolveMechalolRedirectTargets(need);
	}

	// שלב 1: לאן ההפניה במכלול מצביעה בפועל - action=query&redirects=1
	// באותו api.php יחסי כמו lockSelectedTitles (אותו דומיין, אין צורך
	// ב-origin=*). אצוות של 50 (כמו fetchWikidataDescriptions).
	function resolveMechalolRedirectTargets(titles) {
		titles.forEach(function (t) { mechalolRedirectTargetInFlight.add(t); });
		var chunks = [];
		for (var i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));
		var chain = Promise.resolve();
		chunks.forEach(function (chunk) {
			chain = chain.then(function () {
				var url = MECHALOL_API + '?action=query&titles=' + chunk.map(encodeURIComponent).join('|') +
					'&redirects=1&formatversion=2&format=json';
				return withRetry(function () {
					return fetch(url).then(function (res) {
						if (!res.ok) throw new Error('HTTP ' + res.status);
						return res.json();
					});
				}, 2).then(function (data) {
					chunk.forEach(function (t) { if (!mechalolRedirectTargetCache.has(t)) mechalolRedirectTargetCache.set(t, null); });
					var redirectMap = {};
					((data.query && data.query.redirects) || []).forEach(function (r) { redirectMap[r.from] = r.to; });
					chunk.forEach(function (t) {
						var target = redirectMap[t];
						if (target) mechalolRedirectTargetCache.set(t, { targetTitle: target, mechalolId: null });
					});
				}).catch(function () {
					chunk.forEach(function (t) { mechalolRedirectTargetCache.set(t, null); });
				});
			});
		});
		chain.then(function () {
			titles.forEach(function (t) { mechalolRedirectTargetInFlight.delete(t); });
			return resolveMechalolIdsForRedirectTargets();
		}).then(function () {
			paintRedirectTargetSuggestions();
		});
	}

	// שלב 2: id בפועל ב-mechalol_pages עבור כותרות היעד שנפתרו בשלב 1 -
	// PostgREST רגיל (anon), title=in.(...) - באצוות של PG_IN_BATCH בגלל אורך הכתובת (ראו PG_IN_BATCH).
	function resolveMechalolIdsForRedirectTargets() {
		var targets = [];
		mechalolRedirectTargetCache.forEach(function (v) {
			if (v && v.targetTitle && v.mechalolId === null) targets.push(v.targetTitle);
		});
		targets = Array.from(new Set(targets));
		if (targets.length === 0) return Promise.resolve();
		return Promise.all(batches(targets, PG_IN_BATCH).map(function (batch) {
			var params = new URLSearchParams();
			params.set('select', 'id,title');
			params.set('title', 'in.(' + batch.map(function (t) { return '"' + t.replace(/"/g, '\\"') + '"'; }).join(',') + ')');
			return fetch(SUPABASE_URL + '/rest/v1/mechalol_pages?' + params.toString(), { headers: pgHeaders() })
				.then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
				.then(function (rows) {
					var byTitle = {};
					(rows || []).forEach(function (r) { byTitle[r.title] = r.id; });
					mechalolRedirectTargetCache.forEach(function (v) {
						if (v && v.targetTitle && byTitle[v.targetTitle] !== undefined) v.mechalolId = byTitle[v.targetTitle];
					});
				}).catch(function () { /* אצווה שנכשלה: משאירים mechalolId=null - עדיין יש הצעת-טקסט בלי id */ });
		}));
	}

	// מעדכן ישירות תאים שכבר מצוירים (כמו paintWikidataDescriptions) -
	// לא renderTable מלא, כדי לא לאבד טקסט שהמשתמש כבר הקליד בינתיים
	// בתאים אחרים באותו עמוד.
	function paintRedirectTargetSuggestions() {
		document.querySelectorAll('#mchl-dash .mchl-manual-match-cell[data-redirect-check-title]').forEach(function (cell) {
			var title = cell.getAttribute('data-redirect-check-title');
			var cached = mechalolRedirectTargetCache.get(title);
			if (cached === undefined) return;
			applyRedirectSuggestion(cell, cached);
		});
	}

	function applyRedirectSuggestion(cell, cached) {
		var input = cell.querySelector('.mchl-manual-match-input');
		var btn = cell.querySelector('button[data-action="assign-manual-match"]');
		var hint = cell.querySelector('.mchl-manual-match-hint');
		if (input.value) {
			// המשתמש כבר הקליד/בחר בעצמו לפני שהבדיקה החיה הספיקה
			// לחזור - לא דורסים תוך כדי.
			if (hint) hint.remove();
			return;
		}
		if (!cached || !cached.targetTitle) {
			if (hint) hint.remove();
			return;
		}
		input.value = cached.targetTitle;
		if (cached.mechalolId) {
			cell.dataset.selectedMechalolId = cached.mechalolId;
			btn.disabled = false;
		}
		if (hint) hint.textContent = 'הצעה אוטומטית מהפניה קיימת - אפשר לשנות';
	}

	// ===== רמז אוטומטי בטאב "חשוד כמחיקה" - מנצל מידע שכבר קיים אצלנו
	// ב-wikipedia_renames/wikipedia_deletions (לא קריאת API חיה - הטבלאות
	// האלה כבר נמצאות ב-Supabase שלנו) כדי לחסוך מהמשתמש בדיקה ידנית
	// אם השורה קשורה לשינוי-שם/מחיקה ידועים בוויקיפדיה. הכותרת שמחפשים
	// לפיה היא כותרת המכלול עצמה (row.title) - התאמה טקסטואלית מול
	// old_title/title של הטבלאות, לא לפי page_id (עמיד לבאג ה-page_id
	// שתוקן היום ב-fetch_move_log - הכותרות עצמן היו תמיד נכונות שם) =====
	function loadDeletionHintsForCurrentPage() {
		if (activeTab !== 'deleted') return;
		var need = currentPageRows
			.map(function (r) { return r.title; })
			.filter(function (t) { return !deletionHintCache.has(t) && !deletionHintInFlight.has(t); });
		if (need.length === 0) { paintDeletionHints(); return; }
		resolveDeletionHints(need);
	}

	function resolveDeletionHints(titles) {
		titles.forEach(function (t) { deletionHintInFlight.add(t); });
		// כל אצווה נכשלת ומסומנת לחוד, כך שכשל באחת לא מסמן "לא נטען" את כל העמוד.
		return Promise.all(batches(titles, PG_IN_BATCH).map(resolveDeletionHintsBatch));
	}
	function resolveDeletionHintsBatch(titles) {
		var inList = 'in.(' + titles.map(function (t) { return '"' + t.replace(/"/g, '\\"') + '"'; }).join(',') + ')';

		var renamesParams = new URLSearchParams();
		renamesParams.set('select', 'old_title,new_title,renamed_at');
		renamesParams.set('old_title', inList);
		renamesParams.set('order', 'renamed_at.desc');

		var deletionsParams = new URLSearchParams();
		deletionsParams.set('select', 'title,deleted_at,reason');
		deletionsParams.set('title', inList);
		deletionsParams.set('order', 'deleted_at.desc');

		return Promise.all([
			fetch(SUPABASE_URL + '/rest/v1/wikipedia_renames?' + renamesParams.toString(), { headers: pgHeaders() })
				.then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); }),
			fetch(SUPABASE_URL + '/rest/v1/wikipedia_deletions?' + deletionsParams.toString(), { headers: pgHeaders() })
				.then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
		]).then(function (results) {
			var renames = results[0] || [], deletions = results[1] || [];
			titles.forEach(function (t) { if (!deletionHintCache.has(t)) deletionHintCache.set(t, null); });
			// האירוע האחרון (שינוי שם או מחיקה) קובע.
			var consider = function (title, hint) {
				var cur = deletionHintCache.get(title);
				if (!cur || new Date(hint.at) > new Date(cur.at)) deletionHintCache.set(title, hint);
			};
			renames.forEach(function (r) { consider(r.old_title, { type: 'rename', newTitle: r.new_title, at: r.renamed_at }); });
			deletions.forEach(function (d) { consider(d.title, { type: 'deletion', reason: d.reason, at: d.deleted_at }); });
		}).catch(function () {
			// כשל - לא נשמר במטמון כ"אין רמז"; מסומן כשגיאה, וינוסה שוב ברענון.
			titles.forEach(function (t) { if (!deletionHintCache.has(t)) deletionHintCache.set(t, 'error'); });
		}).then(function () {
			titles.forEach(function (t) { deletionHintInFlight.delete(t); });
			paintDeletionHints();
		});
	}

	function paintDeletionHints() {
		document.querySelectorAll('#mchl-dash [data-hint-title]').forEach(function (el) {
			var title = el.getAttribute('data-hint-title');
			var cached = deletionHintCache.get(title);
			if (cached === undefined) return;
			el.classList.remove('mchl-skeleton', 'mchl-muted');
			if (!cached) { el.textContent = '—'; el.classList.add('mchl-muted'); return; }
			if (cached === 'error') { el.textContent = '⚠ לא נטען'; el.title = 'שגיאה בטעינת יומני המחיקה ושינוי השם - נסה לרענן'; el.classList.add('mchl-muted'); return; }
			var dateStr = new Date(cached.at).toLocaleDateString('he-IL');
			if (cached.type === 'rename') {
				el.innerHTML = '<span class="mchl-badge mchl-alert">שינוי שם ← "' + escapeHtml(cached.newTitle) + '" (' + dateStr + ')</span>';
			} else {
				el.innerHTML = '<span class="mchl-badge mchl-alert" title="לפי יומן המחיקות בוויקיפדיה; ייתכן שהערך שוחזר מאז">נמחק ביומן (' + dateStr + ')</span>';
			}
		});
	}

	// ===== בניית הממשק =====
	// מצב ההתחברות קובע אילו לשוניות מוצגות (requiresLogin): בונים את הלשוניות מחדש, ואם הפעילה הוסתרה חוזרים ל"חסר במכלול".
	function syncAuthTabs() {
		if (!$id('mchl-tabs')) return;
		buildTabs();
		if (!tabAllowed(activeTab)) switchTab('missing');
		loadStats(); // ממלא מחדש את מוני הלשוניות שנבנו מחדש
	}
	function buildTabs() {
		var nav = $id('mchl-tabs');
		nav.innerHTML = '';
		var groupsRow = document.createElement('div');
		groupsRow.className = 'mchl-tab-groups';
		nav.appendChild(groupsRow);
		TAB_GROUPS.forEach(function (g) {
			if (!g.tabs.some(tabAllowed)) return; // קבוצה בלי לשוניות מותרות (למשל "עדכון" למי שלא מחובר) לא מוצגת
			var gb = document.createElement('button');
			gb.type = 'button';
			gb.className = 'mchl-tab-group';
			gb.id = 'mchl-tabgroup-' + g.key;
			gb.textContent = g.label;
			gb.addEventListener('click', function () {
				var last = uiPrefs['lastTab:' + g.key];
				switchTab(g.tabs.indexOf(last) >= 0 && tabAllowed(last) ? last : g.tabs[0]);
			});
			groupsRow.appendChild(gb);
			// הטאבים של הקבוצה - תמיד ב-DOM (המונים שלהם מתעדכנים גם כשהקבוצה סגורה).
			var sub = document.createElement('div');
			sub.className = 'mchl-subtabs';
			sub.id = 'mchl-subtabs-' + g.key;
			if (g.tabs.length < 2) sub.classList.add('mchl-single');
			g.tabs.forEach(function (key) {
				if (!tabAllowed(key)) return;
				var v = VIEWS[key] || EXTRA_TABS[key];
				var btn = document.createElement('button');
				btn.className = 'mchl-tab';
				btn.id = 'mchl-tab-' + key;
				btn.type = 'button';
				var countHtml = VIEWS[key] ? '<span class="mchl-count" id="mchl-tab-count-' + key + '">–</span>' : '';
				btn.innerHTML = escapeHtml(v.label) + countHtml;
				btn.addEventListener('click', function () { switchTab(key); });
				sub.appendChild(btn);
			});
			nav.appendChild(sub);
		});
		markActiveTab();
	}

	function markActiveTab() {
		var g = groupOfTab(activeTab);
		TAB_GROUPS.forEach(function (x) {
			var gb = $id('mchl-tabgroup-' + x.key), sub = $id('mchl-subtabs-' + x.key);
			if (!gb || !sub) return; // קבוצה מוסתרת
			gb.classList.toggle('mchl-active', x === g);
			sub.classList.toggle('mchl-open', x === g);
		});
		document.querySelectorAll('#mchl-dash .mchl-tab').forEach(function (t) { t.classList.toggle('mchl-active', t.id === 'mchl-tab-' + activeTab); });
		uiPrefs['lastTab:' + g.key] = activeTab;
		saveUiPrefs();
	}

	function switchTab(key) {
		activeTab = key;
		loadRequestId++; // תשובות שעוד באוויר מהטאב הקודם - לא יצוירו
		currentPage = 0;
		activeFilters = {};
		selectedRows.clear();
		markActiveTab();
		updateSelectionBar();
		var isStats = key === 'stats';
		$id('mchl-stats-area').style.display = isStats ? 'block' : 'none';
		$id('mchl-body').style.display = isStats ? 'none' : '';
		if (EXTRA_TABS[key]) {
			$id('mchl-filter-bar').style.display = 'none';
			$id('mchl-pager').style.display = 'none';
			$id('mchl-body').classList.remove('mchl-with-side');
			$id('mchl-side').style.display = 'none';
			$id('mchl-wf-meter').style.display = 'none';
			renderChips();
			if (key === 'requests') loadRequestsTab();
			else if (!isStats) loadCultureTab();
			return;
		}
		$id('mchl-filter-bar').style.display = 'flex';
		var searchInput = $id('mchl-search-input');
		searchInput.value = '';
		searchInput.placeholder = VIEWS[key].columns.indexOf('wikidata_desc') !== -1 ? 'חיפוש בכותרת או בתיאור ויקינתונים…' : 'חיפוש בכותרת…';
		buildDynamicFilters();
		loadActiveView();
	}

	// ===== טאב "דפים לטיפול - תרבות" - שליפה חיה מה-API של המכלול =====
	function mwApiFetch(params) {
		var p = new URLSearchParams(params);
		p.set('format', 'json');
		p.set('formatversion', '2');
		return withRetry(function () {
			return fetch(MECHALOL_API + '?' + p.toString()).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			}).then(function (data) {
				// MediaWiki מחזירה שגיאות API גם בתשובת 200.
				if (data && data.error) throw new Error('API: ' + (data.error.code || '') + ' ' + (data.error.info || ''));
				return data;
			});
		});
	}


	// ===== טאב "בקשות ייבוא" - הדף המכלול:בקשת ייבוא ערך, עם מה שכבר ידוע לנו על כל ערך =====
	// כל בקשה = מקטע ברמה 2 שהכותרת שלו קישור לערך. לכל בקשה: מי ביקש ומתי, התגובות (בוצע / תגובה אחרת),
	// האם הערך כבר קיים במכלול, והנתונים שלנו על הגרסה בוויקיפדיה (רמת תוכן, מילים, תמונות, מילוני) - ומכאן ייבוא.
	var REQUESTS_PAGE = 'המכלול:בקשת ייבוא ערך';
	var requestsState = { rows: null, filter: 'open', openTitle: null };
	var HE_MONTHS = { 'בינואר': 0, 'בפברואר': 1, 'במרץ': 2, 'באפריל': 3, 'במאי': 4, 'ביוני': 5, 'ביולי': 6, 'באוגוסט': 7, 'בספטמבר': 8, 'באוקטובר': 9, 'בנובמבר': 10, 'בדצמבר': 11 };
	var NON_MAIN_NS = /^\s*:?\s*(המכלול|ויקיפדיה|תבנית|קטגוריה|משתמש|קובץ|תמונה|עזרה|פורטל|מדיה ויקי|מודול|שיחה|שיחת [^:]+|מיוחד|מש|שמש|וק)\s*:/;

	function wikiPlain(t) {
		return String(t || '')
			.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
			.replace(/\{\{[^{}]*\}\}/g, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/'{2,}/g, '')
			.replace(/\s+/g, ' ').trim();
	}
	function sigDate(t) {
		var all = String(t).match(/(\d{1,2}):(\d{2}), (\d{1,2}) (ב[א-ת]+) (\d{4})/g);
		if (!all) return null;
		var m = /(\d{1,2}):(\d{2}), (\d{1,2}) (ב[א-ת]+) (\d{4})/.exec(all[0]);
		if (!(m[4] in HE_MONTHS)) return null;
		return new Date(+m[5], HE_MONTHS[m[4]], +m[3], +m[1], +m[2]);
	}
	function parseRequests(text) {
		var lines = text.split('\n'), reqs = [], cur = null, section = 0;
		lines.forEach(function (line) {
			var h = /^(={1,6})\s*(.*?)\s*\1\s*$/.exec(line);
			if (h) {
				section++;
				if (h[1].length !== 2) { if (cur) cur.body.push(line); return; }
				var link = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(h[2]);
				var title = (link ? link[1] : wikiPlain(h[2])).replace(/_/g, ' ').trim();
				cur = { title: title, section: section, body: [], main: !!title && !NON_MAIN_NS.test(title) };
				reqs.push(cur);
				return;
			}
			if (cur) cur.body.push(line);
		});
		return reqs.filter(function (r) { return r.main; }).map(function (r) {
			var ask = r.body.filter(function (l) { return l.trim() && !/^:/.test(l); }).join(' ');
			var replies = r.body.filter(function (l) { return /^:/.test(l); });
			var who = /\[\[(?:משתמש|מש|User)\s*:\s*([^\]|]+)/.exec(ask) || /\[\[מיוחד:תרומות\/([^\]|]+)/.exec(ask);
			var note = wikiPlain(ask.split(/--|\[\[(?:משתמש|מש|מיוחד:תרומות)/)[0]).replace(/^תודה( רבה)?!?\s*$/, '');
			var rtext = replies.join('\n');
			var status = /\{\{\s*בוצע/.test(rtext) ? 'done' : replies.length ? 'replied' : 'open';
			var lastReply = replies.length ? wikiPlain(replies[replies.length - 1].replace(/^:+/, '').split(/\[\[(?:משתמש|מש)\s*:/)[0]) : '';
			return { title: r.title, section: r.section, requester: who ? who[1].trim() : '', date: sigDate(ask), note: note, status: status,
				replyTemplates: (rtext.match(/\{\{\s*([^|}]+)/g) || []).map(function (x) { return x.replace(/^\{\{\s*/, '').trim(); }).filter(function (x) { return x !== 'א'; }),
				lastReply: lastReply };
		});
	}

	// כתובות PostgREST עם כותרות בעברית ארוכות מאוד אחרי קידוד (~130 תווים לכותרת), ושרתים ופרוקסי מגבילים אורך כתובת
	// (לרוב 8-16KB), ולכן in.(...) של כותרות מפוצל לאצוות קטנות. (ב-API של מדיה-ויקי המגבלה היא 50 בבקשה.)
	var PG_IN_BATCH = 20;
	function batches(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
	// קיום במכלול: missing / exists / redirect. וקיום בוויקיפדיה: מזהה וכותרת (אחרי הפניה).
	function lookupTitles(titles) {
		var mech = {}, wiki = {};
		var mechJobs = batches(titles, 50).map(function (b) {
			return mwApiFetch({ action: 'query', titles: b.join('|'), prop: 'info' }).then(function (d) {
				var q = d.query || {}, norm = {};
				(q.normalized || []).forEach(function (n) { norm[n.to] = n.from; });
				(q.pages || []).forEach(function (pg) {
					var t = norm[pg.title] || pg.title;
					mech[t] = pg.missing ? 'missing' : pg.redirect ? 'redirect' : 'exists';
				});
			});
		});
		var wikiJobs = batches(titles, 50).map(function (b) {
			var p = new URLSearchParams({ action: 'query', titles: b.join('|'), redirects: '1', format: 'json', formatversion: '2', origin: '*' });
			return withRetry(function () {
				return fetch('https://he.wikipedia.org/w/api.php?' + p.toString()).then(function (res) {
					if (!res.ok) throw new Error('HTTP ' + res.status);
					return res.json();
				});
			}).then(function (d) {
				var q = d.query || {}, back = {};
				(q.normalized || []).forEach(function (n) { back[n.to] = n.from; });
				(q.redirects || []).forEach(function (r) { back[r.to] = back[r.from] || r.from; });
				(q.pages || []).forEach(function (pg) {
					var t = back[pg.title] || pg.title;
					wiki[t] = pg.missing ? null : { id: pg.pageid, title: pg.title };
				});
			});
		});
		return Promise.all(mechJobs.concat(wikiJobs)).then(function () { return { mech: mech, wiki: wiki }; });
	}

	function loadRequestsTab() {
		var target = $id('mchl-table-target');
		target.innerHTML = skeletonRows();
		var myId = ++loadRequestId;
		var reqs;
		mwApiFetch({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: REQUESTS_PAGE }).then(function (d) {
			var pg = d.query && d.query.pages && d.query.pages[0];
			if (!pg || !pg.revisions) throw new Error('הדף "' + REQUESTS_PAGE + '" לא נמצא');
			reqs = parseRequests(pg.revisions[0].slots.main.content);
			return lookupTitles(reqs.map(function (r) { return r.title; }));
		}).then(function (found) {
			reqs.forEach(function (r) {
				r.mech = found.mech[r.title] || 'missing';
				r.wiki = found.wiki[r.title] || null;
				// ערך שכבר קיים במכלול - הבקשה נחשבת בוצעה, גם בלי {{בוצע}} (חיים, 2026-09-29).
				if (r.mech === 'exists' && r.status !== 'done') { r.status = 'done'; r.doneBy = 'exists'; }
			});
			var ids = reqs.filter(function (r) { return r.wiki; }).map(function (r) { return r.wiki.id; });
			if (!ids.length) return [];
			// בדוח יש רק ערכים שחסרים במכלול - ממילא אין טעם לשאול על השאר.
			return Promise.all(batches(ids, 150).map(function (b) {
				return pgSelect('report_missing_word_filter', { filterParams: [['id', 'in.(' + b.join(',') + ')']], from: 0, to: b.length - 1 }).then(function (res) { return res.data || []; });
			})).then(function (parts) { return [].concat.apply([], parts); });
		}).then(function (dbRows) {
			if (myId !== loadRequestId || activeTab !== 'requests') return;
			var byId = {};
			dbRows.forEach(function (r) { byId[r.id] = r; });
			requestsState.rows = reqs.map(function (r) {
				var db = r.wiki ? byId[r.wiki.id] : null;
				var row = db ? Object.assign({}, db) : { id: r.wiki ? r.wiki.id : null, title: r.wiki ? r.wiki.title : r.title };
				row.req = r;
				row.inDb = !!db;
				return row;
			}).sort(function (a, b) { return (b.req.date || 0) - (a.req.date || 0); });
			renderRequests();
		}).catch(function (e) {
			if (myId === loadRequestId && activeTab === 'requests') showError(e);
		});
	}

	var REQ_STATUS = { open: 'ממתינה', replied: 'יש תגובה', done: 'בוצע' };
	function requestsVisible() {
		var f = requestsState.filter;
		return (requestsState.rows || []).filter(function (r) {
			if (f === 'open') return r.req.status !== 'done';
			if (f === 'importable') return r.req.status !== 'done' && r.req.mech === 'missing' && r.req.wiki && r.inDb;
			if (f === 'done') return r.req.status === 'done';
			return true;
		});
	}
	function renderRequests() {
		var rows = requestsVisible();
		currentPageRows = rows.filter(function (r) { return r.id; });
		var all = requestsState.rows || [];
		var count = function (f) { var keep = requestsState.filter; requestsState.filter = f; var n = requestsVisible().length; requestsState.filter = keep; return n; };
		var seg = [['open', 'פתוחות'], ['importable', 'אפשר לייבא'], ['done', 'בוצעו'], ['all', 'הכול']].map(function (o) {
			return '<button type="button" data-action="req-filter" data-v="' + o[0] + '"' + (requestsState.filter === o[0] ? ' class="mchl-on"' : '') + '>' +
				escapeHtml(o[1]) + ' <span class="mchl-muted">' + count(o[0]).toLocaleString('he-IL') + '</span></button>';
		}).join('');
		var pageUrl = mw.util.getUrl(REQUESTS_PAGE);
		var head = '<div class="mchl-req-head"><div class="mchl-seg">' + seg + '</div>' +
			'<a href="' + pageUrl + '" target="_blank" rel="noopener" class="mchl-muted">לדף הבקשות ↗</a></div>';
		if (!rows.length) {
			$id('mchl-table-target').innerHTML = head + '<div class="mchl-state"><div class="mchl-big">אין בקשות</div>' + (all.length ? 'אין בקשות שעונות לסינון.' : '') + '</div>';
			return;
		}
		var th = ['הבקשה', 'נוצר בוויקיפדיה', 'במכלול', 'נושא', 'רמת תוכן', 'מילים', 'תמונות', '', ''];
		var body = rows.map(function (row) {
			var r = row.req;
			var editUrl = mw.util.getUrl(REQUESTS_PAGE, { action: 'edit', section: r.section });
			var titleHtml = '<span class="mchl-title"><a href="' + mw.util.getUrl(r.title) + '" target="_blank" rel="noopener">' + escapeHtml(r.title) + '</a></span>' +
				(r.wiki ? ' <a class="mchl-muted" href="' + wikipediaUrl(r.wiki.id) + '" target="_blank" rel="noopener" title="הערך בוויקיפדיה">ויקיפדיה ↗</a>' : '');
			var meta = [r.date ? r.date.toLocaleDateString('he-IL') : '', r.requester].filter(Boolean).join(' · ');
			var reqHtml = titleHtml + '<div class="mchl-row-desc">' + escapeHtml(meta) +
				(r.note ? ' · <span title="' + escapeHtml(r.note) + '">' + escapeHtml(r.note.length > 90 ? r.note.slice(0, 90) + '…' : r.note) + '</span>' : '') + '</div>' +
				'<div class="mchl-row-desc"><span class="mchl-badge ' + (r.status === 'done' ? 'mchl-wiki' : r.status === 'replied' ? 'mchl-review' : 'mchl-neutral') + '"' +
				(r.lastReply ? ' title="' + escapeHtml(r.lastReply) + '"' : '') + '>' + REQ_STATUS[r.status] + (r.doneBy === 'exists' ? ' (קיים במכלול)' : '') +
				(r.status === 'replied' && r.replyTemplates.length ? ': ' + escapeHtml(r.replyTemplates.join(', ')) : '') + '</span> ' +
				'<button type="button" class="mchl-link mchl-req-open" data-action="req-open">💬 בקשה ותגובות</button> ' +
				'<a href="' + editUrl + '" target="_blank" rel="noopener" class="mchl-muted">עריכה בדף ↗</a></div>';
			var mechHtml = r.mech === 'exists' ? '<span class="mchl-badge mchl-wiki">קיים</span>' :
				r.mech === 'redirect' ? '<span class="mchl-badge mchl-neutral">הפניה</span>' : '<span class="mchl-muted">אין</span>';
			var known = row.inDb;
			var noData = !r.wiki ? '<span class="mchl-muted" title="לא נמצא ערך בשם הזה בוויקיפדיה">לא בוויקיפדיה</span>' :
				r.mech !== 'missing' ? '<span class="mchl-muted">—</span>' : '<span class="mchl-muted" title="הערך עוד לא נסרק (נוסף לאחרונה או שהכותרת במכלול שונה)">טרם נסרק</span>';
			var cells = [
				reqHtml, '<span data-created-for="' + escapeHtml(r.title) + '">' + createdHtml(row.created_at) + '</span>', mechHtml,
				known ? renderCell('topic', row) : '<span class="mchl-muted">—</span>',
				known ? renderCell('verdict', row) : noData,
				known ? renderCell('wf_matches', row) : '',
				known ? renderCell('has_images', row) : '',
				r.wiki && r.mech === 'missing' ? renderCell('import_action', row) : '',
				known ? renderCell('expand', row) : ''
			];
			return '<tr class="mchl-req-row' + (known && wfHasDetails(row) ? ' mchl-expandable' : '') + '" data-req-title="' + escapeHtml(r.title) + '">' + cells.map(function (c, i) { return '<td data-label="' + th[i] + '">' + c + '</td>'; }).join('') + '</tr>';
		}).join('');
		$id('mchl-table-target').innerHTML = head + '<div class="mchl-table-wrap"><table><thead><tr>' +
			th.map(function (h, i) { return '<th' + (i >= 7 ? ' class="mchl-narrow-col"' : '') + '>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
		loadMissingCreationDates(rows);
		if (requestsState.openTitle) {
			var tr = $id('mchl-table-target').querySelector('tr[data-req-title="' + window.CSS.escape(requestsState.openTitle) + '"]');
			if (tr) openRequestPanel(tr);
		}
	}

	// תאריך היצירה בוויקיפדיה, ותג "טרי" לערך שנוצר בפחות מ-NEW_ARTICLE_CUTOFF_DAYS ימים.
	function createdHtml(iso) {
		if (!iso) return '<span class="mchl-muted">—</span>';
		var d = new Date(iso);
		var fresh = Date.now() - d.getTime() < NEW_ARTICLE_CUTOFF_DAYS * 864e5;
		return '<span class="mchl-num-cell">' + d.toLocaleDateString('he-IL') + '</span>' + (fresh ? ' <span class="mchl-badge mchl-review" title="נוצר בוויקיפדיה לפני פחות מ-' + NEW_ARTICLE_CUTOFF_DAYS + ' יום">טרי</span>' : '');
	}
	// ערכים שאין לנו במסד (בדרך כלל החדשים ביותר) - תאריך הגרסה הראשונה מוויקיפדיה, אחד-אחד, 4 במקביל.
	function loadMissingCreationDates(rows) {
		var todo = rows.filter(function (r) { return r.req.wiki && !r.created_at && !r.createdLoading; });
		var run = function () {
			var r = todo.shift();
			if (!r) return;
			r.createdLoading = true;
			var p = new URLSearchParams({ action: 'query', pageids: String(r.req.wiki.id), prop: 'revisions', rvprop: 'timestamp', rvdir: 'newer', rvlimit: '1', format: 'json', formatversion: '2', origin: '*' });
			fetch('https://he.wikipedia.org/w/api.php?' + p.toString()).then(function (res) { return res.json(); }).then(function (d) {
				var pg = d.query && d.query.pages && d.query.pages[0];
				r.created_at = pg && pg.revisions && pg.revisions[0] ? pg.revisions[0].timestamp : null;
				var el = $id('mchl-table-target').querySelector('[data-created-for="' + window.CSS.escape(r.req.title) + '"]');
				if (el) el.innerHTML = createdHtml(r.created_at);
			}).catch(function () { /* נשאר "—" */ }).then(run);
		};
		for (var i = 0; i < 4; i++) run();
	}

	// ===== פסקת הבקשה ותגובה - לחיצה על שורה =====
	function requestRowOf(title) { return (requestsState.rows || []).filter(function (x) { return x.req.title === title; })[0]; }
	function panelRowOf(tr) {
		for (var n = tr.nextElementSibling; n && !n.classList.contains('mchl-req-row'); n = n.nextElementSibling) if (n.classList.contains('mchl-req-panel-row')) return n;
		return null;
	}
	function toggleRequestPanel(tr) {
		var panel = panelRowOf(tr);
		if (panel) { panel.remove(); requestsState.openTitle = null; return; }
		openRequestPanel(tr);
	}
	// הפסקה נשלפת לפי מספרה, ונבדק שהכותרת שלה היא עדיין של אותו ערך (הדף משתנה - מספרי הפסקאות זזים).
	function fetchRequestSection(r) {
		return mwApiFetch({ action: 'parse', page: REQUESTS_PAGE, section: String(r.section), prop: 'wikitext' }).then(function (d) {
			var wikitext = (d.parse && d.parse.wikitext) || '';
			var first = parseRequests(wikitext)[0];
			if (!first || first.title !== r.title) throw new Error('moved');
			return { html: threadHtml(wikitext), req: first };
		});
	}
	// הבקשה והתגובות כשרשור פשוט: כל הודעה בשורה, עם הזחה לפי מספר הנקודתיים, הכותב והתאריך.
	function threadHtml(wikitext) {
		var msgs = [];
		wikitext.split('\n').slice(1).forEach(function (line) {
			if (!line.trim()) return;
			var m = /^(:*)(.*)$/.exec(line), depth = m[1].length, body = m[2];
			var who = /\[\[(?:משתמש|מש|User)\s*:\s*([^\]|]+)/.exec(body) || /\[\[מיוחד:תרומות\/([^\]|]+)/.exec(body);
			var date = sigDate(body);
			var text = wikiPlain(body.replace(/\{\{\s*(בוצע[^}]*)\}\}/g, '✔ $1').replace(/\{\{\s*א\|[^}]*\}\}/g, '').split(/--\s*\[\[|\[\[(?:משתמש|מש|User)\s*:|\[\[מיוחד:תרומות/)[0]);
			if (depth === 0 && msgs.length && !who && !date) { msgs[msgs.length - 1].text += ' ' + text; return; }
			msgs.push({ depth: depth, text: text, who: who ? who[1].trim() : '', date: date });
		});
		if (!msgs.length) return '<div class="mchl-muted">אין תוכן בבקשה.</div>';
		return msgs.map(function (x) {
			return '<div class="mchl-msg" style="margin-inline-start:' + Math.min(x.depth, 6) * 18 + 'px">' +
				'<div class="mchl-msg-text">' + (escapeHtml(x.text) || '<span class="mchl-muted">(בלי טקסט)</span>') + '</div>' +
				'<div class="mchl-msg-meta">' + escapeHtml([x.who, x.date ? x.date.toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')) + '</div></div>';
		}).join('');
	}
	function openRequestPanel(tr) {
		var title = tr.getAttribute('data-req-title');
		var row = requestRowOf(title);
		if (!row) return;
		requestsState.openTitle = title;
		var old = panelRowOf(tr);
		if (old) old.remove();
		var panelTr = document.createElement('tr');
		panelTr.className = 'mchl-req-panel-row';
		panelTr.innerHTML = '<td colspan="' + tr.children.length + '"><div class="mchl-req-panel"><div class="mchl-req-section mchl-muted">טוען את הבקשה…</div>' +
			'<div class="mchl-req-reply">' +
			'<textarea class="mchl-search" rows="2" placeholder="תגובה (החתימה תתווסף אוטומטית)"></textarea>' +
			'<div class="mchl-req-reply-btns">' +
			'<button type="button" class="mchl-export-btn" data-action="req-reply" data-kind="text">הגב</button>' +
			'<button type="button" class="mchl-export-btn" data-action="req-reply" data-kind="done">{{בוצע}}</button>' +
			'<button type="button" class="mchl-export-btn" data-action="req-reply" data-kind="fresh">טרי</button>' +
			'<span class="mchl-req-reply-msg mchl-muted"></span></div></div></div></td>';
		tr.parentNode.insertBefore(panelTr, tr.nextSibling);
		if (requestsState.flash) { panelTr.querySelector('.mchl-req-reply-msg').textContent = requestsState.flash; requestsState.flash = null; }
		var box = panelTr.querySelector('.mchl-req-section');
		fetchRequestSection(row.req).then(function (sec) {
			box.classList.remove('mchl-muted');
			box.innerHTML = sec.html;
		}).catch(function (e) {
			box.innerHTML = e.message === 'moved'
				? '<span class="mchl-alert">הדף השתנה מאז הטעינה - לחץ "רענון" וחזור לבקשה.</span>'
				: '<span class="mchl-alert">שגיאה בטעינת הבקשה: ' + escapeHtml(e.message || e) + '</span>';
		});
	}
	function replyToRequest(btn) {
		var panelTr = btn.closest('tr.mchl-req-panel-row');
		var tr = panelTr && panelTr.previousElementSibling;
		while (tr && !tr.classList.contains('mchl-req-row')) tr = tr.previousElementSibling;
		var row = tr && requestRowOf(tr.getAttribute('data-req-title'));
		if (!row) return;
		var kind = btn.getAttribute('data-kind');
		var textarea = panelTr.querySelector('textarea');
		var msg = panelTr.querySelector('.mchl-req-reply-msg');
		var text = kind === 'done' ? '{{בוצע}}' : kind === 'fresh' ? 'טרי' : textarea.value.trim();
		if (!text) { msg.textContent = 'כתוב תגובה.'; return; }
		var buttons = panelTr.querySelectorAll('button[data-action="req-reply"]');
		buttons.forEach(function (b) { b.disabled = true; });
		msg.textContent = 'שומר…';
		var done = function (m, bad) { buttons.forEach(function (b) { b.disabled = false; }); msg.textContent = m; msg.classList.toggle('mchl-alert', !!bad); };
		// בדיקה מחדש מיד לפני הכתיבה: הפסקה עדיין של אותו ערך?
		fetchRequestSection(row.req).then(function () {
			return mw.loader.using('mediawiki.api');
		}).then(function () {
			return new mw.Api().postWithToken('csrf', {
				action: 'edit', title: REQUESTS_PAGE, section: String(row.req.section),
				// חתימה: ארבע טילדות ברצף בקוד הגאדג'ט (בדף JS במכלול) מומרות לחתימה בשמירה, ולכן מפוצלות בכוונה.
				appendtext: '\n:' + text + ' ~~' + '~~', summary: '/* ' + row.req.title + ' */ תגובה', nocreate: 1
			});
		}).then(function () {
			textarea.value = '';
			done('נשמר.');
			return fetchRequestSection(row.req).then(function (sec) {
				row.req.status = sec.req.status === 'done' || row.req.mech === 'exists' ? 'done' : sec.req.status;
				row.req.lastReply = sec.req.lastReply;
				row.req.replyTemplates = sec.req.replyTemplates;
				requestsState.flash = 'התגובה נשמרה ✓';
				renderRequests(); // מצייר מחדש ופותח שוב את הפסקה (openTitle)
			});
		}).catch(function (e) {
			done(e && e.message === 'moved' ? 'הדף השתנה מאז הטעינה - לא נשמר. לחץ "רענון".' : 'שגיאה - לא נשמר: ' + (e && (e.message || e.code) || e), true);
		});
	}

	function loadCultureTab() {
		cultureState.selected = null;
		var target = $id('mchl-table-target');
		if (cultureState.subcats) { renderCulturePicker(); return; }
		target.innerHTML = skeletonRows();
		var myId = ++loadRequestId;
		mwApiFetch({
			action: 'query', generator: 'categorymembers',
			gcmtitle: CATEGORY_MAINTENANCE_CULTURE, gcmtype: 'subcat', gcmlimit: '50',
			prop: 'categoryinfo'
		}).then(function (data) {
			var pages = (data.query && data.query.pages) || [];
			cultureState.subcats = pages.map(function (p) {
				return { title: p.title, count: (p.categoryinfo && p.categoryinfo.pages) || 0 };
			}).sort(function (a, b) { return a.title.localeCompare(b.title, 'he'); });
			if (myId !== loadRequestId || activeTab !== 'culture') return;
			renderCulturePicker();
		}).catch(function (e) { if (activeTab === 'culture') showError(e); });
	}

	function renderCulturePicker() {
		var target = $id('mchl-table-target');
		if (!cultureState.subcats || cultureState.subcats.length === 0) {
			target.innerHTML = '<div class="mchl-state"><div class="mchl-big">לא נמצאו תתי-קטגוריות</div>ייתכן ששם קטגוריית האם השתנה במכלול.</div>';
			return;
		}
		var html = '<div class="mchl-culture-picker">' + cultureState.subcats.map(function (s) {
			var shortLabel = s.title.replace(CATEGORY_MAINTENANCE_CULTURE + '/', '');
			return '<button type="button" class="mchl-culture-pill" data-action="select-culture-subcat" data-subcat="' + escapeHtml(s.title) + '">' +
				escapeHtml(shortLabel) + ' <span class="mchl-count">' + s.count.toLocaleString('he-IL') + '</span></button>';
		}).join('') + '</div>';
		target.innerHTML = html;
	}

	function selectCultureSubcat(subcat) {
		cultureState.selected = subcat;
		cultureState.members = [];
		cultureState.continueToken = null;
		loadCultureMembers();
	}

	function loadCultureMembers() {
		cultureState.loading = true;
		renderCultureList();
		var params = {
			action: 'query', list: 'categorymembers',
			cmtitle: cultureState.selected, cmtype: 'page', cmnamespace: '0', cmlimit: '50'
		};
		if (cultureState.continueToken) params.cmcontinue = cultureState.continueToken;
		var myId = ++loadRequestId, mySubcat = cultureState.selected;
		mwApiFetch(params).then(function (data) {
			if (myId !== loadRequestId || activeTab !== 'culture' || cultureState.selected !== mySubcat) { cultureState.loading = false; return; }
			var members = (data.query && data.query.categorymembers) || [];
			cultureState.members = cultureState.members.concat(members);
			cultureState.continueToken = (data.continue && data.continue.cmcontinue) || null;
			cultureState.loading = false;
			renderCultureList();
		}).catch(function (e) {
			cultureState.loading = false;
			if (activeTab === 'culture') showError(e);
		});
	}

	function renderCultureList() {
		if (!cultureState.selected) return;
		var target = $id('mchl-table-target');
		var shortLabel = cultureState.selected.replace(CATEGORY_MAINTENANCE_CULTURE + '/', '');
		var backBtn = '<button type="button" class="mchl-clear-filters" data-action="culture-back" style="display:block;margin-bottom:10px;">‹ חזרה לרשימת תתי-הקטגוריות</button>';
		var header = '<div class="mchl-eyebrow" style="margin-bottom:10px;">' + escapeHtml(shortLabel) + '</div>';
		if (cultureState.members.length === 0 && !cultureState.loading) {
			target.innerHTML = backBtn + header + '<div class="mchl-state"><div class="mchl-big">אין דפים</div></div>';
			return;
		}
		var list = '<table><tbody>' + cultureState.members.map(function (m) {
			return '<tr><td class="mchl-title"><a href="' + mechalolEditUrl(m.title) + '" target="_blank" rel="noopener">' + escapeHtml(m.title) + '</a></td></tr>';
		}).join('') + '</tbody></table>';
		var loadMore = cultureState.continueToken ?
			'<div style="padding:14px;text-align:center;"><button type="button" class="mchl-export-btn" data-action="culture-load-more" ' + (cultureState.loading ? 'disabled' : '') + '>' +
			(cultureState.loading ? 'טוען…' : 'טען עוד') + '</button></div>' :
			(cultureState.loading ? '<div style="padding:14px;text-align:center;" class="mchl-muted">טוען…</div>' : '');
		target.innerHTML = backBtn + header + list + loadMore;
	}

	function buildDynamicFilters() {
		var host = $id('mchl-dynamic-filters');
		host.innerHTML = '';
		var cfg = VIEWS[activeTab];
		cfg.filters.forEach(function (f) {
			var sel = document.createElement('select');
			sel.className = 'mchl-filter-select';
			sel.id = 'mchl-filter-' + f.key;
			var opts = '<option value="">' + escapeHtml(f.label) + ' — הכול</option>';
			f.options.forEach(function (o) {
				var label = f.display ? f.display[o] : o;
				opts += '<option value="' + escapeHtml(o) + '">' + escapeHtml(label) + '</option>';
			});
			sel.innerHTML = opts;
			sel.addEventListener('change', function () {
				if (sel.value) activeFilters[f.key] = sel.value; else delete activeFilters[f.key];
				currentPage = 0;
				loadActiveView();
				toggleClearFiltersBtn();
			});
			host.appendChild(sel);
		});
		var side = $id('mchl-side');
		$id('mchl-body').classList.toggle('mchl-with-side', !!cfg.easyImport);
		side.style.display = cfg.easyImport ? 'block' : 'none';
		if (cfg.easyImport) buildEasyImportFilters(side, cfg);
		else { side.innerHTML = ''; $id('mchl-wf-meter').style.display = 'none'; renderChips(); }
		toggleClearFiltersBtn();
	}

	// ===== פאנל המסננים בצד - טאבי "חסר במכלול" =====
	// כל מסנן הוא משתנה מצב (wf...), ו-applyContentLevelFilter מתרגם את כולם ל-activeFilters.
	// ליד כל אפשרות - מספר הערכים (מתוך report_missing_word_filter_summary, בהתחשב בשאר
	// המסננים שבסיכום: רמה, מילוני, תמונות, נושא). חיפוש, ערכים חדשים, קוד מוסתר ואורך
	// לא נכללים בסיכום, ולכן המספרים לא מושפעים מהם.
	var wfImagesChoice = ''; // '' / 'with' / 'without'
	var wfExcludeNew = true; // בלי ערכים שנוצרו בשבועיים האחרונים
	var wfRedirectChoice = ''; // '' / 'absent' / 'unchecked' (רק בטאב "חסר במכלול")
	var wfMaxLen = '';
	var wfSettingsOpen = false;
	var wfTopicOpen = { 0: true, 1: false, 2: true }; // אילו קבוצות נושא פתוחות
	var WF_LEVEL_OPTIONS = {
		ctx: [['clean', 'נקי', '#5C9686'], ['clean_wording', 'נקי או דורש ניסוח', null], ['wording', 'דורש ניסוח', '#7C8C99'],
			['review_low', 'חשד נמוך', '#A8A860'], ['review_medium', 'חשד בינוני', '#D9B44A'], ['review_high', 'חשד גבוה', '#D98B3A'],
			['problem', 'בעיה ודאית', '#C1634A'], ['unscanned', 'טרם נסרק', '#3A4A52']],
		list: [['clean', 'נקי', '#5C9686'], ['clean_wording', 'נקי או דורש ניסוח', null], ['wording', 'דורש ניסוח', '#7C8C99'],
			['review', 'לבדיקה', '#D9B44A'], ['problem', 'בעיה ודאית', '#C1634A'], ['unscanned', 'טרם נסרק', '#3A4A52']]
	};
	var WF_LEVEL_LABELS = { review_medium_up: 'חשד בינוני וגבוה' };
	WF_LEVEL_OPTIONS.ctx.concat(WF_LEVEL_OPTIONS.list).forEach(function (o) { WF_LEVEL_LABELS[o[0]] = o[1]; });

	function buildEasyImportFilters(side, cfg) {
		if (!cfg.redirectFilter) wfRedirectChoice = '';
		applyContentLevelFilter();
		renderSide();
		side.onclick = onSideClick;
		side.onchange = onSideChange;
		side.oninput = onSideInput;
		renderWfMeter();
		renderChips();
	}

	function segHtml(kind, current, options) {
		return '<div class="mchl-seg">' + options.map(function (o) {
			return '<button type="button" data-side="' + kind + '" data-v="' + o[0] + '"' + (current === o[0] ? ' class="mchl-on"' : '') + '>' +
				escapeHtml(o[1]) + (o[2] ? ' <span class="mchl-n" data-count="' + kind + ':' + o[0] + '"></span>' : '') + '</button>';
		}).join('') + '</div>';
	}

	function renderSide() {
		var side = $id('mchl-side');
		var cfg = VIEWS[activeTab];
		if (!side || !cfg || !cfg.easyImport) return;
		var html = '<div class="mchl-side-top"><span>מסננים</span><button type="button" data-action="toggle-side" title="הסתרת המסננים">‹ הסתרה</button></div>';
		// הגדרות החישוב - נקבעות פעם אחת, ולכן מקופלות.
		html += '<div class="mchl-side-sec"><div class="mchl-settings-line"><span>רמה ' +
			(wfMethod === 'ctx' ? '<b>לפי המילה והמשפט</b>' : '<b>לפי המילה בלבד</b>') + ' · ' +
			(wfMode === 's' ? '<b>כולל מילים מוצעות</b>' : '<b>מילים שאושרו</b>') + '</span>' +
			'<button type="button" data-side="settings">⚙ ' + (wfSettingsOpen ? 'סגירה' : 'שינוי') + '</button></div>';
		if (wfSettingsOpen) {
			html += '<div class="mchl-settings-box">' +
				'<div class="mchl-side-h">איך נקבעת רמת התוכן</div>' +
				'<label class="mchl-radio"><input type="radio" name="wf-method" value="ctx"' + (wfMethod === 'ctx' ? ' checked' : '') + '> לפי המילה והמשפט שלה <span class="mchl-hint">(מומלץ) - מילה בעייתית, או מילה דו-משמעית במשפט חשוד, קובעת "בעיה ודאית"; אחרת חשד גבוה, בינוני או נמוך</span></label>' +
				'<label class="mchl-radio"><input type="radio" name="wf-method" value="list"' + (wfMethod === 'list' ? ' checked' : '') + '> לפי המילה בלבד <span class="mchl-hint">- הרמה שכתובה ליד המילה ברשימה: "בעיה ודאית" או "לבדיקה"</span></label>' +
				'<div class="mchl-side-h">אילו מילים נבדקות</div>' +
				'<label class="mchl-radio"><input type="radio" name="wf-mode" value="a"' + (wfMode === 'a' ? ' checked' : '') + '> רק מילים שאושרו</label>' +
				'<label class="mchl-radio"><input type="radio" name="wf-mode" value="s"' + (wfMode === 's' ? ' checked' : '') + '> גם מילים שהוצעו וטרם אושרו</label>' +
				'</div>';
		}
		html += '</div>';
		// רמת תוכן
		html += '<div class="mchl-side-sec"><div class="mchl-side-h">רמת תוכן' +
			(wfLevelChoice ? ' <button type="button" class="mchl-link" data-side="level" data-v="">הכול</button>' : '') + '</div>';
		WF_LEVEL_OPTIONS[wfMethod].forEach(function (o) {
			html += '<button type="button" class="mchl-opt' + (wfLevelChoice === o[0] ? ' mchl-on' : '') + (o[2] ? '' : ' mchl-opt-sub') + '" data-side="level" data-v="' + o[0] + '">' +
				(o[2] ? '<span class="mchl-dot-c" style="background:' + o[2] + '"></span>' : '') + escapeHtml(o[1]) +
				'<span class="mchl-n" data-count="level:' + o[0] + '"></span></button>';
		});
		html += '</div>';
		// ייבוא מילוני ותמונות - שורות כפתורים, זו מעל זו
		html += '<div class="mchl-side-sec"><div class="mchl-side-h">ייבוא מילוני</div>' +
			segHtml('dict', wfDictChoice, [['', 'הכול'], ['without', 'ללא מילוני', 1], ['only', 'מילוני בלבד', 1]]) +
			'<div class="mchl-side-h" style="margin-top:10px;">תמונות</div>' +
			segHtml('img', wfImagesChoice, [['', 'הכול'], ['with', 'עם תמונות', 1], ['without', 'בלי תמונות', 1]]) + '</div>';
		// נושא
		html += '<div class="mchl-side-sec"><div class="mchl-side-h">נושא' +
			(wfTopicChoice.length ? ' <button type="button" class="mchl-link" data-side="topic-none">ניקוי</button>' : '') + '</div>';
		WF_TOPIC_GROUPS.forEach(function (g, gi) {
			var all = g.items.every(function (it) { return wfTopicChoice.indexOf(it[0]) >= 0; });
			var some = !all && g.items.some(function (it) { return wfTopicChoice.indexOf(it[0]) >= 0; });
			html += '<div class="mchl-tgroup"><div class="mchl-thead"><label><input type="checkbox" data-tgroup="' + gi + '"' + (all ? ' checked' : '') +
				(some ? ' data-some="1"' : '') + '> ' + escapeHtml(g.label) + '</label><span class="mchl-n" data-count="tgroup:' + gi + '"></span>' +
				'<button type="button" class="mchl-tg-toggle" data-side="tg-toggle" data-g="' + gi + '">' + (wfTopicOpen[gi] ? '▾' : '▸') + '</button></div>';
			if (wfTopicOpen[gi]) {
				html += '<div class="mchl-titems">' + g.items.map(function (it) {
					return '<label class="mchl-titem"><input type="checkbox" value="' + it[0] + '"' + (wfTopicChoice.indexOf(it[0]) >= 0 ? ' checked' : '') + '> ' +
						escapeHtml(it[1]) + '<span class="mchl-n" data-count="topic:' + it[0] + '"></span></label>';
				}).join('') + '</div>';
			}
			html += '</div>';
		});
		html += '</div>';
		// עוד
		html += '<div class="mchl-side-sec"><div class="mchl-side-h">מילים בקוד המוסתר</div>' +
			segHtml('hidden', wfHiddenChoice, [['', 'הכול'], ['with', 'יש'], ['without', 'אין']]) +
			'<div class="mchl-side-h" style="margin-top:10px;">שמות הקודש</div>' +
			segHtml('names', wfNamesChoice, [['', 'הכול'], ['with', 'יש'], ['without', 'אין']]);
		if (cfg.redirectFilter) {
			html += '<div class="mchl-side-h" style="margin-top:10px;">הפניה במכלול</div>' +
				segHtml('redirect', wfRedirectChoice, [['', 'הכול'], ['absent', 'נבדק - אין'], ['unchecked', 'טרם נבדק']]);
		}
		html += '<label class="mchl-check"><input type="checkbox" data-side-check="new"' + (wfExcludeNew ? ' checked' : '') + '> בלי ערכים חדשים (' + NEW_ARTICLE_CUTOFF_DAYS + ' יום)</label>' +
			'<label class="mchl-check">אורך מקסימלי <input type="number" min="0" class="mchl-filter-number" data-side-input="maxlen" placeholder="בתים" value="' + escapeHtml(wfMaxLen) + '"></label>' +
			'<div class="mchl-hint" style="margin-top:8px;">המספרים ליד האפשרויות לא מושפעים מחיפוש, מערכים חדשים, מהקוד המוסתר ומאורך.</div></div>';
		$id('mchl-side').innerHTML = html;
		applySideCollapse();
		$id('mchl-side').querySelectorAll('input[data-some]').forEach(function (cb) { cb.indeterminate = true; });
		renderSideCounts();
	}

	function onEasyChange(keepSide) {
		applyContentLevelFilter();
		currentPage = 0; loadActiveView();
		if (!keepSide) renderSide();
		renderWfMeter();
		renderChips();
	}

	function onSideClick(e) {
		var head = e.target.closest('.mchl-side-h.mchl-collapsible');
		if (head && !e.target.closest('button, input, label')) { toggleSideSection(head); return; }
		var b = e.target.closest('[data-side]');
		if (!b) return;
		var kind = b.getAttribute('data-side'), v = b.getAttribute('data-v');
		if (kind === 'settings') { wfSettingsOpen = !wfSettingsOpen; renderSide(); return; }
		if (kind === 'tg-toggle') { var g = b.getAttribute('data-g'); wfTopicOpen[g] = !wfTopicOpen[g]; renderSide(); return; }
		if (kind === 'level') wfLevelChoice = (wfLevelChoice === v ? '' : v);
		else if (kind === 'dict') wfDictChoice = v;
		else if (kind === 'img') wfImagesChoice = v;
		else if (kind === 'hidden') wfHiddenChoice = v;
		else if (kind === 'names') wfNamesChoice = v;
		else if (kind === 'redirect') wfRedirectChoice = v;
		else if (kind === 'topic-none') wfTopicChoice = [];
		else return;
		onEasyChange();
	}

	function onSideChange(e) {
		var t = e.target;
		if (t.name === 'wf-method') {
			wfMethod = t.value;
			// "לבדיקה" ורמות החשד לא קיימים בשתי השיטות
			if (!WF_LEVEL_OPTIONS[wfMethod].some(function (o) { return o[0] === wfLevelChoice; })) wfLevelChoice = /^review/.test(wfLevelChoice) ? (wfMethod === 'list' ? 'review' : '') : wfLevelChoice;
		} else if (t.name === 'wf-mode') wfMode = t.value;
		else if (t.hasAttribute('data-tgroup')) {
			var codes = WF_TOPIC_GROUPS[+t.getAttribute('data-tgroup')].items.map(function (it) { return it[0]; });
			wfTopicChoice = wfTopicChoice.filter(function (c) { return codes.indexOf(c) < 0; });
			if (t.checked) wfTopicChoice = wfTopicChoice.concat(codes);
		} else if (t.getAttribute('data-side-check') === 'new') wfExcludeNew = t.checked;
		else if (t.type === 'checkbox' && t.value && WF_TOPIC_LABELS[t.value]) {
			wfTopicChoice = wfTopicChoice.filter(function (c) { return c !== t.value; });
			if (t.checked) wfTopicChoice.push(t.value);
		} else return;
		onEasyChange();
	}

	var wfLenDebounce = null;
	function onSideInput(e) {
		if (e.target.getAttribute('data-side-input') !== 'maxlen') return;
		wfMaxLen = e.target.value.trim();
		clearTimeout(wfLenDebounce);
		wfLenDebounce = setTimeout(function () { onEasyChange(true); }, 450);
	}

	// האם שורה (בעמודות ה-view או הסיכום) מתאימה לבחירת הרמה.
	function wfLevelMatches(row, choice) {
		var level = wfRowLevel(row);
		switch (choice) {
			case '': return true;
			case 'unscanned': return !level;
			case 'clean_wording': return level === 'clean' || level === 'wording';
			case 'review': return level === 'review' || level === 'high' || level === 'medium' || level === 'low';
			case 'review_low': return level === 'low';
			case 'review_medium': return level === 'medium';
			case 'review_high': return level === 'high';
			case 'review_medium_up': return level === 'high' || level === 'medium';
			default: return level === choice;
		}
	}

	// שורת סיכום עוברת את המסננים הנוכחיים, חוץ מ-skip (כדי לספור את האפשרויות שלו).
	function wfSummaryPasses(r, skip) {
		if (r.redirect !== (activeTab === 'missing_redirect')) return false;
		if (skip !== 'img' && wfImagesChoice && r.has_images !== (wfImagesChoice === 'with')) return false;
		if (skip !== 'dict' && wfDictChoice && r.dictionary !== (wfDictChoice === 'only')) return false;
		if (skip !== 'topic' && wfTopicChoice.length && wfTopicChoice.indexOf(r.topic) < 0) return false;
		if (skip !== 'level' && !wfLevelMatches(r, wfLevelChoice)) return false;
		return true;
	}

	// מקטעים בפאנל המסננים - לחיצה על הכותרת מקפלת/פותחת (נזכר בין כניסות).
	function applySideCollapse() {
		var collapsed = uiPrefs.sideCollapsed || {};
		document.querySelectorAll('#mchl-side .mchl-side-sec').forEach(function (sec) {
			var h = sec.querySelector(':scope > .mchl-side-h');
			if (!h) return;
			var key = (h.firstChild && h.firstChild.nodeType === 3 ? h.firstChild.nodeValue : h.textContent).trim();
			sec.setAttribute('data-sec', key);
			h.classList.add('mchl-collapsible');
			sec.classList.toggle('mchl-collapsed', !!collapsed[key]);
		});
	}
	function toggleSideSection(h) {
		var sec = h.closest('.mchl-side-sec');
		var key = sec && sec.getAttribute('data-sec');
		if (!key) return;
		uiPrefs.sideCollapsed = uiPrefs.sideCollapsed || {};
		uiPrefs.sideCollapsed[key] = !uiPrefs.sideCollapsed[key];
		if (!uiPrefs.sideCollapsed[key]) delete uiPrefs.sideCollapsed[key];
		saveUiPrefs();
		sec.classList.toggle('mchl-collapsed', !!uiPrefs.sideCollapsed[key]);
	}
	function applySidePanel() {
		var hidden = !!uiPrefs.sideHidden;
		$id('mchl-body').classList.toggle('mchl-side-hidden', hidden);
	}
	// תפריט הצד של האתר (Vector) - מוסתר כברירת מחדל בדשבורד, כדי שיהיה מקום לטבלה.
	// לשונית קטנה בקצה המסך, צמודה לתפריט האתר: "תפריט ›" כשהוא מוסתר, "‹ הסתרה" לידו כשהוא מוצג.
	function applySiteNav() {
		var hidden = uiPrefs.siteNavHidden !== false;
		document.body.classList.toggle('mchl-no-site-nav', hidden);
		var b = $id('mchl-sitenav-btn');
		if (!b) {
			b = document.createElement('button');
			b.type = 'button';
			b.id = 'mchl-sitenav-btn';
			b.className = 'mchl-sitenav-tab';
			b.addEventListener('click', function () { uiPrefs.siteNavHidden = !(uiPrefs.siteNavHidden !== false); saveUiPrefs(); applySiteNav(); });
			document.body.appendChild(b);
		}
		b.textContent = hidden ? '☰ תפריט האתר' : '✕ הסתרת התפריט';
		b.title = hidden ? 'הצגת תפריט הצד של האתר' : 'הסתרת תפריט הצד של האתר';
	}

	function renderSideCounts() {
		var side = $id('mchl-side');
		if (!side || !wfSummary) return;
		var counts = {};
		var add = function (k, n) { counts[k] = (counts[k] || 0) + n; };
		wfSummary.forEach(function (r) {
			if (wfSummaryPasses(r, 'level')) WF_LEVEL_OPTIONS[wfMethod].forEach(function (o) { if (wfLevelMatches(r, o[0])) add('level:' + o[0], r.n); });
			if (wfSummaryPasses(r, 'dict')) add('dict:' + (r.dictionary ? 'only' : 'without'), r.n);
			if (wfSummaryPasses(r, 'img')) add('img:' + (r.has_images ? 'with' : 'without'), r.n);
			if (wfSummaryPasses(r, 'topic') && r.topic) {
				add('topic:' + r.topic, r.n);
				WF_TOPIC_GROUPS.forEach(function (g, gi) { if (g.items.some(function (it) { return it[0] === r.topic; })) add('tgroup:' + gi, r.n); });
			}
		});
		side.querySelectorAll('[data-count]').forEach(function (el) {
			var n = counts[el.getAttribute('data-count')] || 0;
			el.textContent = n.toLocaleString('he-IL');
			var opt = el.closest('.mchl-opt');
			if (opt && el.getAttribute('data-count') === 'level:unscanned') opt.style.display = n ? '' : 'none';
		});
	}

	// שורת התגיות: כל מסנן פעיל, עם ✕ להסרה, ומספר התוצאות.
	function renderChips() {
		var host = $id('mchl-chips');
		var cfg = VIEWS[activeTab];
		if (!host) return;
		if (!cfg || !cfg.easyImport) { host.style.display = 'none'; return; }
		var chips = [];
		if (wfLevelChoice) chips.push(['level', 'רמה: ' + (WF_LEVEL_LABELS[wfLevelChoice] || wfLevelChoice)]);
		if (wfDictChoice) chips.push(['dict', wfDictChoice === 'only' ? 'מילוני בלבד' : 'ללא מילוני']);
		if (wfImagesChoice) chips.push(['img', wfImagesChoice === 'with' ? 'עם תמונות' : 'בלי תמונות']);
		if (wfTopicChoice.length) chips.push(['topic', wfTopicChoice.length === 1 ? 'נושא: ' + WF_TOPIC_LABELS[wfTopicChoice[0]] : wfTopicChoice.length + ' נושאים']);
		if (wfHiddenChoice) chips.push(['hidden', wfHiddenChoice === 'with' ? 'יש מילים בקוד המוסתר' : 'אין מילים בקוד המוסתר']);
		if (wfNamesChoice) chips.push(['names', wfNamesChoice === 'with' ? 'יש שמות הקודש' : 'אין שמות הקודש']);
		if (wfRedirectChoice) chips.push(['redirect', wfRedirectChoice === 'absent' ? 'נבדק - אין הפניה' : 'הפניה - טרם נבדק']);
		if (wfMaxLen) chips.push(['maxlen', 'עד ' + Number(wfMaxLen).toLocaleString('he-IL') + ' בתים']);
		if (wfExcludeNew) chips.push(['new', 'בלי ערכים חדשים']);
		var search = ($id('mchl-search-input').value || '').trim();
		if (search) chips.push(['search', 'חיפוש: ' + search]);
		host.style.display = 'flex';
		host.innerHTML = chips.map(function (c) {
			return '<button type="button" class="mchl-chip" data-action="chip-remove" data-chip="' + c[0] + '" title="הסרת המסנן">' + escapeHtml(c[1]) + ' ✕</button>';
		}).join('') + (chips.length > 1 ? '<button type="button" class="mchl-link" data-action="clear-filters">ניקוי הכול</button>' : '') +
			'<span class="mchl-chips-total" id="mchl-chips-total">' + (totalRows ? totalRows.toLocaleString('he-IL') + ' ערכים' : '') + '</span>';
	}

	function removeChip(kind) {
		if (kind === 'level') wfLevelChoice = '';
		else if (kind === 'dict') wfDictChoice = '';
		else if (kind === 'img') wfImagesChoice = '';
		else if (kind === 'topic') wfTopicChoice = [];
		else if (kind === 'hidden') wfHiddenChoice = '';
		else if (kind === 'names') wfNamesChoice = '';
		else if (kind === 'redirect') wfRedirectChoice = '';
		else if (kind === 'maxlen') wfMaxLen = '';
		else if (kind === 'new') wfExcludeNew = false;
		else if (kind === 'search') $id('mchl-search-input').value = '';
		onEasyChange();
	}

	function applyContentLevelFilter() {
		['verdict', 'verdict_suggested', 'ctx_verdict', 'ctx_verdict_suggested', 'ctx_suspicion', 'ctx_suspicion_suggested',
			'hidden_count', 'hidden_count_suggested', 'names_count', 'names_count_suggested', 'dictionary', 'topic', 'has_images', 'created_at', 'mechalol_redirect_exists', 'easy_import_length']
			.forEach(function (c) { delete activeFilters[c]; });
		if (wfTopicChoice.length) activeFilters.topic = { op: 'in', value: '(' + wfTopicChoice.join(',') + ')' };
		if (wfDictChoice) activeFilters.dictionary = { op: wfDictChoice === 'only' ? 'not.is' : 'is', value: 'null' };
		if (wfImagesChoice) activeFilters.has_images = { op: 'eq', value: wfImagesChoice === 'with' };
		if (wfExcludeNew) activeFilters.created_at = { op: 'lt', value: newArticleCutoffIso() };
		if (wfRedirectChoice === 'absent') activeFilters.mechalol_redirect_exists = { op: 'eq', value: false };
		else if (wfRedirectChoice === 'unchecked') activeFilters.mechalol_redirect_exists = { op: 'is', value: 'null' };
		if (wfMaxLen && !isNaN(Number(wfMaxLen))) activeFilters.easy_import_length = { op: 'lte', value: Number(wfMaxLen) };
		if (wfHiddenChoice) activeFilters[wfHiddenColumn()] = wfHiddenChoice === 'with' ? { op: 'gt', value: 0 } : { op: 'eq', value: 0 };
		if (wfNamesChoice) activeFilters[wfNamesColumn()] = wfNamesChoice === 'with' ? { op: 'gt', value: 0 } : { op: 'eq', value: 0 };
		var col = wfColumn(), v = wfLevelChoice;
		if (!v) return;
		var sub = /^review_(high|medium|low|medium_up)$/.exec(v);
		if (v === 'unscanned') activeFilters[col] = { op: 'is', value: 'null' };
		else if (v === 'clean_wording') activeFilters[col] = { op: 'in', value: '(clean,wording)' };
		else if (sub) {
			activeFilters[col] = { op: 'eq', value: 'review' };
			// בשיטת הרשימה אין רמות חשד - "לבדיקה" כולו.
			if (wfMethod === 'ctx') {
				activeFilters[wfSuspicionColumn()] = sub[1] === 'medium_up' ? { op: 'in', value: '(high,medium)' } : { op: 'eq', value: sub[1] };
			}
		} else activeFilters[col] = { op: 'eq', value: v };
	}

	// ===== מחוון הפילוח - כמה ערכים בכל רמה (לפי הטאב ושאר המסננים שבסיכום) =====
	var WF_METER_SEGMENTS = [
		{ key: 'problem', label: 'בעיה ודאית', color: '#C1634A', filter: 'problem' },
		{ key: 'high', label: 'חשד גבוה', color: '#D98B3A', filter: 'review_high' },
		{ key: 'medium', label: 'חשד בינוני', color: '#D9B44A', filter: 'review_medium' },
		{ key: 'low', label: 'חשד נמוך', color: '#A8A860', filter: 'review_low' },
		{ key: 'review', label: 'לבדיקה', color: '#D9B44A', filter: 'review' },
		{ key: 'wording', label: 'דורש ניסוח', color: '#7C8C99', filter: 'wording' },
		{ key: 'clean', label: 'נקי', color: '#5C9686', filter: 'clean' },
		{ key: null, label: 'טרם נסרק', color: '#3A4A52', filter: 'unscanned' }
	];

	function loadWfSummary(force) {
		if (wfSummary && !force) return Promise.resolve(wfSummary);
		// בדפים של 1,000 שורות - סופבייס מגביל תשובה אחת (max rows).
		var rows = [];
		function page(from) {
			return pgSelect('report_missing_word_filter_summary', { filterParams: [], order: 'n.desc,redirect.asc,has_images.asc,verdict.asc,verdict_suggested.asc,ctx_verdict.asc,ctx_suspicion.asc,ctx_verdict_suggested.asc,ctx_suspicion_suggested.asc,dictionary.asc,topic.asc', from: from, to: from + 999 })
				.then(function (res) {
					var data = res.data || [];
					rows = rows.concat(data);
					if (data.length && (res.count != null ? rows.length < res.count : data.length === 1000)) return page(rows.length);
					wfSummary = rows;
					return wfSummary;
				});
		}
		return page(0);
	}

	function renderWfMeter() {
		var host = $id('mchl-wf-meter');
		var cfg = VIEWS[activeTab];
		if (!cfg || !cfg.easyImport) { host.style.display = 'none'; return; }
		host.style.display = 'block';
		loadWfSummary().then(function (rows) {
			if (!VIEWS[activeTab] || !VIEWS[activeTab].easyImport) return;
			var counts = {}, total = 0;
			rows.forEach(function (r) {
				if (!wfSummaryPasses(r, 'level')) return;
				var level = wfRowLevel(r);
				counts[level] = (counts[level] || 0) + r.n;
				total += r.n;
			});
			var segs = WF_METER_SEGMENTS.filter(function (g) {
				if (wfMethod === 'ctx' && g.key === 'review') return (counts.review || 0) > 0;
				if (wfMethod === 'list' && (g.key === 'high' || g.key === 'medium' || g.key === 'low')) return false;
				return true;
			});
			var bar = '', legend = '';
			segs.forEach(function (g) {
				var n = counts[g.key] || 0;
				if (!n && g.key === null) return;
				var pct = total ? (100 * n / total) : 0;
				var active = wfLevelChoice === g.filter ? ' mchl-wf-active' : '';
				bar += '<div class="mchl-wf-seg" data-action="wf-meter-filter" data-filter="' + g.filter + '" style="width:' + pct.toFixed(2) +
					'%;background:' + g.color + ';" title="' + escapeHtml(g.label) + ': ' + n.toLocaleString('he-IL') + '"></div>';
				legend += '<button type="button" class="mchl-wf-legend' + active + '" data-action="wf-meter-filter" data-filter="' + g.filter + '">' +
					'<span class="mchl-wf-dot" style="background:' + g.color + ';"></span>' + escapeHtml(g.label) + ' <b>' +
					n.toLocaleString('he-IL') + '</b> <span class="mchl-muted">' + pct.toFixed(1) + '%</span></button>';
			});
			host.innerHTML = '<div class="mchl-wf-meter-head">פילוח לפי רמת תוכן · ' + total.toLocaleString('he-IL') +
				' ערכים <span class="mchl-muted">(לפי שאר המסננים; לחיצה מסננת)</span></div>' +
				'<div class="mchl-wf-bar">' + bar + '</div><div class="mchl-wf-legends">' + legend + '</div>';
			renderSideCounts();
		}).catch(function () {
			host.innerHTML = '<div class="mchl-muted">לא ניתן לטעון את פילוח התוכן (report_missing_word_filter_summary).</div>';
		});
	}

	function setWfLevel(value) {
		wfLevelChoice = value;
		onEasyChange();
	}

	function toggleClearFiltersBtn() {
		var hasFilters = Object.keys(activeFilters).length > 0 || $id('mchl-search-input').value.trim().length > 0;
		// בטאבי "חסר במכלול" - שורת התגיות מחליפה את הכפתור.
		var easy = VIEWS[activeTab] && VIEWS[activeTab].easyImport;
		$id('mchl-clear-filters-btn').style.display = hasFilters && !easy ? 'inline' : 'none';
	}

	function clearFilters() {
		activeFilters = {};
		wfLevelChoice = '';
		wfHiddenChoice = '';
		wfNamesChoice = '';
		wfDictChoice = '';
		wfTopicChoice = [];
		wfImagesChoice = '';
		wfRedirectChoice = '';
		wfMaxLen = '';
		wfExcludeNew = true;
		$id('mchl-search-input').value = '';
		currentPage = 0;
		buildDynamicFilters();
		loadActiveView();
	}

	function onPageSizeChange() {
		pageSize = parseInt($id('mchl-page-size').value, 10);
		currentPage = 0;
		loadActiveView();
	}

	function loadCurrentTab() {
		if (activeTab === 'stats') return loadStats();
		if (activeTab === 'requests') return Promise.resolve(loadRequestsTab());
		if (EXTRA_TABS[activeTab]) {
			cultureState.subcats = null; // כפתור רענון אמור לשלוף מחדש, לא להסתפק במטמון
			return Promise.resolve(loadCultureTab());
		}
		return loadActiveView();
	}

	function refreshAll() {
		var btn = $id('mchl-refresh-btn');
		// רענון מלא: גם הפרטים שנטענו (הקשר, הפניות, רמזי מחיקה) נשלפים מחדש.
		wfDetailsCache.clear();
		updateInfo.clear(); updateDiffCache.clear(); updateMergeCache.clear();
		mechalolRedirectTargetCache.clear();
		deletionHintCache.clear();
		btn.classList.add('mchl-spinning');
		wfSummary = null;
		if (VIEWS[activeTab] && VIEWS[activeTab].easyImport) renderWfMeter();
		return Promise.all([loadStats(), loadCurrentTab(), fetchLastSyncTime().catch(function () { return undefined; })]).then(function (results) {
			btn.classList.remove('mchl-spinning');
			var lastSync = results[2];
			var note = $id('mchl-sync-note');
			if (lastSync) {
				note.textContent = 'עדכון אחרון מהתהליך — ' + new Date(lastSync).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
			} else {
				note.textContent = 'נבדק בדפדפן — ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) + ' (לא ניתן לשלוף את זמן העדכון האמיתי)';
			}
		});
	}

	function fetchLastSyncTime() {
		return withRetry(function () {
			// זמן הריצה האחרונה של העדכון הלילי (sync_watermarks, שתי שורות).
			// קודם: מיון כל wikipedia_pages לפי checked_at - סריקה מלאה של
			// 405 אלף שורות בכל רענון, שחרגה מזמן הריצה המותר כשהמטמון קר.
			var params = new URLSearchParams();
			params.set('select', 'last_synced_ts');
			params.set('order', 'last_synced_ts.desc');
			var url = SUPABASE_URL + '/rest/v1/sync_watermarks?' + params.toString();
			return fetch(url, { headers: pgHeaders({ Range: '0-0' }) }).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			}).then(function (data) {
				return (data && data.length) ? data[0].last_synced_ts : null;
			});
		});
	}

	// מריץ פונקציות שמחזירות הבטחות, לכל היותר limit במקביל (המסד קטן, וכ-13 ספירות בבת אחת חורגות מ-15 השניות של anon).
	// מחזיר תוצאות לפי הסדר; פונקציה שנכשלה נותנת null.
	var STATS_CONCURRENCY = 3;
	function runLimited(fns, limit) {
		var results = new Array(fns.length), next = 0;
		function worker() {
			if (next >= fns.length) return Promise.resolve();
			var idx = next++;
			return Promise.resolve().then(fns[idx]).then(function (r) { results[idx] = r; }, function () { results[idx] = null; }).then(worker);
		}
		var workers = [];
		for (var w = 0; w < Math.min(limit, fns.length); w++) workers.push(worker());
		return Promise.all(workers).then(function () { return results; });
	}

	function loadStats() {
		STAT_DEFS.forEach(function (d) {
			$id(d.spinId).style.display = 'inline-block';
			$id(d.warnId).style.display = 'none';
		});
		var statValues = {};
		var jobs = STAT_DEFS.map(function (d) { return function () {
			var viewCfg = d.viewKey ? VIEWS[d.viewKey] : null;
			return pgCount(d.table, viewCfg ? viewCfg.baseFilters : null, undefined, d.estimated).then(function (val) {
				statValues[d.key] = val;
				$id(d.statId).textContent = val.toLocaleString('he-IL');
				if (d.tabCount) $id(d.tabCount).textContent = val.toLocaleString('he-IL');
			}).catch(function (e) {
				statValues[d.key] = null;
				var w = $id(d.warnId);
				w.style.display = 'inline';
				w.title = isTransientMaintenanceError(e)
					? 'המסד באמצע עדכון תקופתי - ינסה שוב אוטומטית ברענון הבא'
					: d.warnMsg + ' (' + (e.message || e) + ')';
			}).finally(function () {
				$id(d.spinId).style.display = 'none';
			});
		}; });
		// מוני טאבים ל-views שאין להם כרטיס סטטיסטיקה משלהם.
		var coveredTabs = {};
		STAT_DEFS.forEach(function (d) { if (d.tabCount) coveredTabs[d.tabCount] = true; });
		Object.keys(VIEWS).forEach(function (key) {
			var tabCountId = 'mchl-tab-count-' + key;
			if (coveredTabs[tabCountId] || !tabAllowed(key)) return;
			var cfg = VIEWS[key];
			jobs.push(function () {
				return pgCount(cfg.view, cfg.baseFilters, cfg.countColumn).then(function (val) {
					var el = $id(tabCountId);
					if (el) el.textContent = val.toLocaleString('he-IL');
				}).catch(function () { /* המונה נשאר "–" */ });
			});
		});
		// "תואמים" = דפי מכלול עם קישור לוויקיפדיה, *פחות* אלה שגם מופיעים
		// במשימות לטיפול (למשל "חסרה תבנית מיון" - מקושרים אבל עדיין משימה),
		// אחרת הם נספרים פעמיים בפס.
		var matchedJob = function () { return pgCount('mechalol_pages', [['wikipedia_id', 'not.is.null']], undefined, true).catch(function () { return null; }); };
		var tasksLinkedJob = function () { return pgCount('report_tasks_to_handle', [['wikipedia_id', 'not.is.null']]).catch(function () { return null; }); };
		return runLimited([matchedJob, tasksLinkedJob].concat(jobs), STATS_CONCURRENCY).then(function (results) {
			var matched = (results[0] != null && results[1] != null) ? results[0] - results[1] : null;
			var tasks = statValues.tasks, missing = statValues.missing;
			if (matched != null && tasks != null && missing != null) {
				var total = matched + tasks + missing;
				var pct = function (n) { return total ? (100 * n / total).toFixed(1) : 0; };
				var bar = $id('mchl-ledger-bar');
				bar.children[0].style.width = pct(matched) + '%';
				bar.children[1].style.width = pct(tasks) + '%';
				bar.children[2].style.width = pct(missing) + '%';
			}
		});
	}

	function loadActiveView(isAutoRetry) {
		var myRequestId = ++loadRequestId;
		var target = $id('mchl-table-target');
		target.innerHTML = skeletonRows();
		$id('mchl-pager').style.display = 'none';
		var cfg = VIEWS[activeTab];
		var from = currentPage * pageSize, to = from + pageSize - 1;
		return pgSelect(cfg.view, { filterParams: buildFilterParams(), order: cfg.order || 'title.asc', from: from, to: to }).then(function (res) {
			if (myRequestId !== loadRequestId) return;
			currentPageRows = res.data || [];
			countUnknown = res.count == null;
			// ספירה לא ידועה: מאפשרים "הבא" רק אם הדף מלא.
			totalRows = countUnknown ? from + currentPageRows.length + (currentPageRows.length === pageSize ? 1 : 0) : res.count;
			totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
			renderTable();
			renderPager();
			var chipsTotal = $id('mchl-chips-total');
			if (chipsTotal) chipsTotal.textContent = countUnknown ? 'מספר הערכים לא ידוע' : totalRows.toLocaleString('he-IL') + ' ערכים';
			loadWikidataDescriptionsForCurrentPage();
			loadRedirectTargetsForCurrentPage();
			markExistingInMechalol();
			loadDeletionHintsForCurrentPage();
			if (cfg.freshness) loadUpdateFreshness();
			loadUpdateInfoForCurrentPage();
		}).catch(function (e) {
			if (myRequestId !== loadRequestId) return;
			// אם זו שגיאה שנראית כמו חלון העדכון השבועי ועוד לא ניסינו
			// ניסיון-נוסף מושהה - מחכים עוד קצת (מעבר לשלוש הניסיונות
			// המהירות של withRetry) לפני שמציגים למשתמש הודעת שגיאה בכלל.
			// חלון ה-swap עצמו קצר מאוד (lock_timeout של כמה שניות לכל
			// היותר) - סביר שהניסיון הזה יצליח בשקט, בלי שהמשתמש בכלל
			// יבחין שהיה עיכוב.
			if (!isAutoRetry && isTransientMaintenanceError(e) && e.code !== '57014') {
				sleep(4000).then(function () {
					if (myRequestId === loadRequestId) loadActiveView(true);
				});
				return;
			}
			showError(e, isAutoRetry && isTransientMaintenanceError(e));
		});
	}

	function skeletonRows() {
		var html = '<table><tbody>';
		for (var i = 0; i < 8; i++) html += '<tr><td style="padding:14px 16px;"><div class="mchl-skeleton" style="height:14px;width:' + (60 + Math.random() * 30) + '%;"></div></td></tr>';
		return html + '</tbody></table>';
	}

	function showError(e, isMaintenance) {
		if (isMaintenance) {
			// חלון העדכון השבועי - לא באג, לא תקלה. אין ערך למשתמש
			// בפרטים הטכניים (SQLSTATE/PGRST וכו') - רק הודעה ברורה ודרך
			// להמשיך הלאה.
			$id('mchl-table-target').innerHTML =
				'<div class="mchl-state"><div class="mchl-big">המסד באמצע עדכון תקופתי</div>' +
				'<div>זה קורה כל מוצאי שבת ונמשך בדרך כלל שניות בודדות. הנתונים יחזרו להיות זמינים מיד עם סיום העדכון.</div>' +
				'<button type="button" class="mchl-refresh" data-action="retry" style="margin:16px auto 0;"><span class="mchl-dot"></span> ניסיון נוסף</button></div>';
			return;
		}
		$id('mchl-table-target').innerHTML =
			'<div class="mchl-state mchl-error"><div class="mchl-big">שגיאה בטעינת הנתונים</div>' +
			'<div>נכשלו כמה ניסיונות חיבור ברצף. יש לבדוק חסימת CSP, ואת ה-RLS/הרשאות הקריאה על הטבלאות והתצוגות.</div>' +
			'<pre>' + escapeHtml(e && e.message ? e.message : JSON.stringify(e)) + '</pre>' +
			'<button type="button" class="mchl-refresh" data-action="retry" style="margin:16px auto 0;"><span class="mchl-dot"></span> ניסיון נוסף</button></div>';
	}

	// ===== ייבוא - כמו הכפתורים של הקישורים האדומים (Gadget-redLinksForImport) =====
	// דרך mw.import של Gadget-mw-import: הקוד מוויקיפדיה עם ההחלפות האוטומטיות, {{וח}} ו-{{מיון ויקיפדיה}},
	// ונפתח בלשונית חדשה בתצוגה מקדימה - שום דבר לא נשמר בלי לחיצה על "שמירה".
	// ערך מילוני (עמודת dictionary) - במצב "בוט ייבוא" (mw-import-tionary.js): פתיח, בלי תמונות, {{בוט <סוג>}}.
	// הסוג לפי תבניות הבוט במכלול (word-filter/analysis/dictionary-rules.md); כשאין התאמה ברורה - ייבוא רגיל.
	// הסיווג (חיים, 2026-09-29), לפי הסוג (dictionary) והסיבה (dictionary_why: "תבנית X" / "קטגוריה X"):
	//   ספורט - ספורט. מוזיקה - מוזיקה (שירים, אלבומים, אירוויזיון...); מוזיקאים וזמרים, וגם להקות - מוזיקאים.
	//   שחקנים - רק שחקנים; דוגמנים, מנחים, קומיקאים, במאים וכו' - תרבות ובידור. סרטים - סרטים;
	//   תוכניות וסדרות טלוויזיה - טלוויזיה; דמות בדיונית, טקס פרסים, רקדנים - תרבות ובידור.
	//   ספרות ומשחקי מחשב - כמו שהם.
	var MUSICIANS_CAT = /(מוזיקאים|מוזיקאיות|נגני|מנצחים|מלחינים|פסנתרנים|כנרים|צ'לנים|זמרי|זמרים|זמרות|להקות|ראפרים|תקליטנים|אמני |אמניות |משתתפי אירוויזיון)/;
	var DANCERS_CAT = /(רקדני|רקדנים|רקדניות|כוריאוגרפים|כוריאוגרפיות)/;
	function importBotClass(row) {
		if (!row.dictionary) return null;
		var m = /^(תבנית|קטגוריה) (.*)$/.exec(row.dictionary_why || '') || [];
		var byTemplate = m[1] === 'תבנית', name = m[2] || '';
		switch (row.dictionary) {
			case 'ספורט': return 'ספורט';
			case 'מוזיקאים': return 'מוזיקאים';
			case 'מוזיקה':
				if (byTemplate) return name === 'להקה' ? 'מוזיקאים' : 'מוזיקה';
				if (MUSICIANS_CAT.test(name)) return 'מוזיקאים';
				if (DANCERS_CAT.test(name)) return 'תרבות ובידור';
				return 'מוזיקה';
			case 'שחקנים':
				if (byTemplate) return name === 'אישיות משחק' ? 'שחקנים' : 'תרבות ובידור';
				return /(שחקני|שחקניות)/.test(name) ? 'שחקנים' : 'תרבות ובידור';
			case 'סרטים':
				return /^(דמות בדיונית|טקס פרסי קולנוע)$/.test(name) ? 'תרבות ובידור' : 'סרטים';
			case 'טלוויזיה': return 'טלוויזיה';
			case 'סרטים וטלוויזיה':
				if (/^דמויות ב|זיכיונות מדיה/.test(name)) return 'תרבות ובידור';
				if (/טלוויזיה|סדרות|תוכניות/.test(name)) return 'טלוויזיה';
				if (/^סרטי/.test(name)) return 'סרטים';
				return 'תרבות ובידור';
			case 'ספרות': return 'ספרות';
			case 'משחקי מחשב': return 'משחקי מחשב';
		}
		return null;
	}

	// mw.import יכול להיות דרוס: הקובץ הישן מדיה ויקי:Gadget-mw-import.js (לא רשום כגאדג'ט) מגדיר
	// mw.import = {openForm, getProperties}, ואם הוא נטען בדף אחרי הגאדג'ט - המחלקה אובדת ("mw.import is
	// not a constructor"). לכן הקוד של ext.gadget.mw-import נטען כאן לעותק פרטי, בלי לגעת ב-mw.import הגלובלי.
	function loadImportPackage() {
		return $.ajax({
			url: mw.util.wikiScript('load'), dataType: 'text', cache: true,
			data: { modules: 'ext.gadget.mw-import', only: 'scripts', lang: mw.config.get('wgUserLanguage'), skin: mw.config.get('skin') }
		}).then(function (code) {
			var pkg = null;
			var local = Object.create(mw);
			local.loader = Object.create(mw.loader);
			local.loader.impl = function (fn) { var a = fn(); pkg = a[1]; };
			local.loader.implement = function (name, script) { pkg = script; };
			local.loader.state = function () {};
			new Function('mw', code)(local);
			if (!pkg || !pkg.files || !pkg.main) throw new Error('הקוד של mw-import לא נמצא');
			return { pkg: pkg, local: local };
		});
	}
	// רשימת ההחלפות הקבועות של הייבוא ("גיורים"), מתוך חבילת הגאדג'ט. נטענת פעם אחת.
	var importReplacementsPromise = null;
	function getImportReplacements() {
		if (!importReplacementsPromise) {
			importReplacementsPromise = loadImportPackage().then(function (r) {
				var files = r.pkg.files;
				var list = files['mw-import-replacements.json'] || files['./mw-import-replacements.json'];
				if (typeof list === 'string') list = JSON.parse(list);
				if (!Array.isArray(list)) throw new Error('רשימת ההחלפות לא נמצאה בחבילה');
				return list;
			});
			importReplacementsPromise.catch(function () { importReplacementsPromise = null; });
		}
		return importReplacementsPromise;
	}
	function loadImportClass() {
		return loadImportPackage().then(function (r) {
			var pkg = r.pkg, local = r.local;
			var cache = {};
			var req = function (name) {
				var key = name.replace(/^\.\//, '');
				if (cache[key]) return cache[key].exports;
				var file = pkg.files[key];
				if (typeof file !== 'function') return file;
				var module = cache[key] = { exports: {} };
				file(req, module, module.exports);
				return module.exports;
			};
			req(pkg.main);
			if (typeof local.import !== 'function') throw new Error('mw.import לא נוצר');
			return local.import;
		});
	}

	// ערכים מ"חסר במכלול" שכבר נוצרו במכלול מאז העדכון הלילי (ייבוא שלי או של מישהו אחר) -
	// נבדק בזמן אמת מול המכלול לכל עמוד, ושוב כשחוזרים ללשונית. וי ירוק וכפתור ייבוא מנוטרל.
	var existsNow = new Set();
	function markExistingInMechalol() {
		if (activeTab !== 'missing' || !currentPageRows.length) return;
		var titles = currentPageRows.map(function (r) { return r.title; }).filter(Boolean);
		batches(titles, 50).forEach(function (b) {
			mwApiFetch({ action: 'query', titles: b.join('|'), prop: 'info' }).then(function (d) {
				var q = d.query || {}, back = {};
				(q.normalized || []).forEach(function (n) { back[n.to] = n.from; });
				(q.pages || []).forEach(function (pg) { if (!pg.missing) existsNow.add(back[pg.title] || pg.title); });
				paintExisting();
			}).catch(function () { /* לא נבדק - נשאר כמו שהוא */ });
		});
	}
	function paintExisting() {
		document.querySelectorAll('#mchl-table-target button.mchl-import-btn[data-title]').forEach(function (btn) {
			var t = btn.getAttribute('data-title');
			if (!existsNow.has(t) || btn.hasAttribute('data-exists')) return;
			btn.setAttribute('data-exists', '1');
			btn.disabled = true;
			btn.title = 'כבר קיים במכלול';
			var link = btn.closest('tr') && btn.closest('tr').querySelector('.mchl-title');
			if (link) link.insertAdjacentHTML('beforeend', ' <span class="mchl-exists-now" title="כבר קיים במכלול (נוצר מאז העדכון האחרון)">✓</span>');
		});
	}
	document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') markExistingInMechalol(); });

	var importerPromise = null;
	function getImporter() {
		if (!importerPromise) {
			importerPromise = mw.loader.using(['mediawiki.api', 'mediawiki.Title', 'mediawiki.ForeignApi', 'mediawiki.util']).then(function () {
				return typeof mw.import === 'function' ? mw.import : loadImportClass();
			}).then(function (Import) { return new Import(); });
			importerPromise.catch(function () { importerPromise = null; });
		}
		return importerPromise;
	}

	function importFromDashboard(btn) {
		var title = btn.getAttribute('data-title');
		var bot = btn.getAttribute('data-bot') || false;
		if (!title || btn.disabled) return;
		btn.disabled = true;
		var label = btn.textContent;
		btn.textContent = 'טוען...';
		var done = function () { btn.disabled = false; btn.textContent = label; };
		getImporter().then(function (importer) {
			// form: true - importWikitext פותח את טופס העריכה בעצמו ולא מחזיר תוצאה.
			var p = importer.importWikitext({ page: title, exist: false, currentPage: title, form: true, bot: bot });
			if (p && p.catch) p.catch(function (err) { mw.notify(String(err), { type: 'warn' }); done(); });
			setTimeout(done, 1500);
		}).catch(function (err) {
			console.error('ייבוא מהדשבורד:', err);
			mw.notify('לא ניתן לטעון את גאדג\'ט הייבוא: ' + (err && err.message ? err.message : err), { type: 'error' });
			done();
		});
	}

	function effectiveColumns(cfg) {
		// עמודת השיוך הידני מתווספת רק בטאב "חסר במכלול", ורק כש-
		// יש חיבור פעיל - לא כל מבקר בטאב הזה אמור לראות אותה בכלל.
		var cols = cfg.displayColumns || cfg.columns;
		if (VIEWS[activeTab] && VIEWS[activeTab].manualMatch && serviceKeyConnected) {
			var at = cols.indexOf('import_action');
			return at < 0 ? cols.concat(['manual_match_action']) : cols.slice(0, at).concat(['manual_match_action'], cols.slice(at));
		}
		return cols;
	}

	// ===== טאב "עדכון" - מידע חי מוויקיפדיה לשורות בעמוד =====
	// לכל שורה: גודל הגרסה ששולבה (sort_template_rev) מול העדכנית, והשוואת sha1. sha1 זהה =
	// התוכן זהה (שחזור), כלומר ה-`ahead` היה מספרי בלבד. נשלף חי ל-50 השורות שבעמוד, שתי
	// בקשות, ולא נשמר במסד (המסד קרוב לגבול האחסון).
	var updateInfo = new Map(); // row.id -> {base:{size,sha1}, latest:{revid,size,sha1,ts,user,comment}} | {error}
	var updateDiffCache = new Map(); // row.id -> html
	function wikipediaApi(params) {
		var qs = new URLSearchParams(Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params));
		return withRetry(function () {
			return fetch('https://he.wikipedia.org/w/api.php?' + qs.toString()).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			}).then(function (data) {
				if (data.error) throw new Error(data.error.code || 'שגיאת API');
				return data;
			});
		}, 2);
	}
	function updateRowIsSame(row) {
		var i = updateInfo.get(row.id);
		return !!(i && i.base && i.latest && i.base.sha1 && i.base.sha1 === i.latest.sha1);
	}
	function renderUpdateChange(row) {
		var i = updateInfo.get(row.id);
		var ph = 'data-upd-id="' + row.id + '"';
		if (!i) return '<span class="mchl-skeleton" ' + ph + ' style="display:inline-block;height:12px;width:70%;">&nbsp;</span>';
		if (i.error || !i.base || !i.latest) return '<span class="mchl-muted" ' + ph + ' title="' + escapeHtml(i.error || 'הגרסה לא נמצאה') + '">—</span>';
		if (updateRowIsSame(row)) return '<span ' + ph + '><span class="mchl-badge mchl-wiki" title="הגרסה העדכנית זהה בתוכן לגרסה ששולבה (שחזור) - אין מה לשלב">תוכן זהה</span></span>';
		var delta = i.latest.size - i.base.size;
		var sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
		var text = sign + Math.abs(delta).toLocaleString('he-IL') + ' בתים';
		var when = i.latest.ts ? new Date(i.latest.ts).toLocaleDateString('he-IL') : '';
		var note = (when ? when : '') + (i.latest.comment ? ' · ' + i.latest.comment.slice(0, 70) : '');
		return '<span ' + ph + '><span class="mchl-num-cell' + (Math.abs(delta) < 100 ? ' mchl-muted' : '') + '" title="גודל הגרסה העדכנית פחות גודל הגרסה ששולבה">' + text + '</span>' +
			(note ? '<div class="mchl-row-desc" title="' + escapeHtml(i.latest.comment || '') + '">' + escapeHtml(note) + '</div>' : '') + '</span>';
	}
	function paintUpdateInfo() {
		if (!VIEWS[activeTab] || !VIEWS[activeTab].liveChange) return;
		document.querySelectorAll('#mchl-dash [data-upd-id]').forEach(function (el) {
			var row = currentPageRows.find(function (r) { return String(r.id) === el.getAttribute('data-upd-id'); });
			if (!row || !updateInfo.has(row.id)) return;
			var holder = document.createElement('span');
			holder.innerHTML = renderUpdateChange(row);
			el.replaceWith(holder.firstChild);
			var tr = document.querySelector('#mchl-dash [data-upd-id="' + row.id + '"]');
			if (tr && (tr = tr.closest('tr'))) tr.classList.toggle('mchl-upd-same', updateRowIsSame(row));
		});
	}
	function loadUpdateInfoForCurrentPage() {
		if (!VIEWS[activeTab] || !VIEWS[activeTab].liveChange) return;
		var myTab = activeTab;
		var rows = currentPageRows.filter(function (r) { var i = updateInfo.get(r.id); return !i || i.error; }); // שגיאות לא נשמרות: מנסים שוב
		if (!rows.length) return paintUpdateInfo();
		var baseIds = rows.map(function (r) { return r.sort_template_rev; }).filter(Boolean);
		var pageIds = rows.map(function (r) { return r.wikipedia_id; }).filter(Boolean);
		// מגבלת ה-API היא 50 מזהים בבקשה, בלי קשר לגודל העמוד (50/100/250 שורות).
		var baseReqs = batches(baseIds, 50).map(function (b) { return wikipediaApi({ action: 'query', prop: 'revisions', revids: b.join('|'), rvprop: 'ids|size|sha1' }); });
		var latestReqs = batches(pageIds, 50).map(function (b) { return wikipediaApi({ action: 'query', prop: 'revisions', pageids: b.join('|'), rvprop: 'ids|size|sha1|timestamp|user|comment' }); });
		return Promise.all([Promise.all(baseReqs), Promise.all(latestReqs)]).then(function (res) {
			var baseByRev = {}, latestByPage = {};
			res[0].forEach(function (d) {
				((d.query && d.query.pages) || []).forEach(function (p) {
					(p.revisions || []).forEach(function (rv) { baseByRev[rv.revid] = { size: rv.size, sha1: rv.sha1 }; });
				});
			});
			res[1].forEach(function (d) {
				((d.query && d.query.pages) || []).forEach(function (p) {
					var rv = (p.revisions || [])[0];
					if (rv) latestByPage[p.pageid] = { revid: rv.revid, size: rv.size, sha1: rv.sha1, ts: rv.timestamp, user: rv.user, comment: rv.comment };
				});
			});
			rows.forEach(function (r) {
				updateInfo.set(r.id, { base: baseByRev[r.sort_template_rev] || null, latest: latestByPage[r.wikipedia_id] || null });
			});
		}).catch(function (e) {
			rows.forEach(function (r) { updateInfo.set(r.id, { error: 'שגיאה בשליפה: ' + (e.message || e) }); });
		}).then(function () {
			if (activeTab === myTab) paintUpdateInfo();
		});
	}
	// ניקוי בסיסי של ה-HTML שמחזיר compare (מגיע מוויקיפדיה, אבל לא מזריקים סקריפטים בכל מקרה).
	function sanitizeDiffHtml(html) {
		// שורות <tr> חייבות להיות בתוך טבלה, אחרת מפענח ה-HTML זורק אותן.
		var doc = new DOMParser().parseFromString('<table><tbody>' + html + '</tbody></table>', 'text/html');
		doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(function (n) { n.remove(); });
		doc.querySelectorAll('*').forEach(function (n) {
			Array.prototype.slice.call(n.attributes).forEach(function (a) {
				if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
			});
			if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); }
		});
		return doc.querySelector('tbody').innerHTML;
	}
	// <merge3>
	// מיזוג תלת-כיווני ברמת שורות (base = הגרסה ששולבה, ours = המכלול היום, theirs = ויקיפדיה עכשיו).
	// שינויים חופפים שאינם זהים הופכים להתנגשות עם סימנים בסגנון git.
	var MERGE_MAX_CELLS = 6000000;
	function lcsPairs(a, b) {
		var pre = 0, n = a.length, m = b.length;
		while (pre < n && pre < m && a[pre] === b[pre]) pre++;
		var suf = 0;
		while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
		var pairs = [], i;
		for (i = 0; i < pre; i++) pairs.push([i, i]);
		var an = n - pre - suf, bn = m - pre - suf;
		if (an > 0 && bn > 0 && an * bn <= MERGE_MAX_CELLS) {
			var w = bn + 1, t = new Uint32Array((an + 1) * w), x, y;
			for (x = an - 1; x >= 0; x--) {
				for (y = bn - 1; y >= 0; y--) {
					t[x * w + y] = a[pre + x] === b[pre + y] ? t[(x + 1) * w + y + 1] + 1 : Math.max(t[(x + 1) * w + y], t[x * w + y + 1]);
				}
			}
			x = 0; y = 0;
			while (x < an && y < bn) {
				if (a[pre + x] === b[pre + y]) { pairs.push([pre + x, pre + y]); x++; y++; }
				else if (t[(x + 1) * w + y] >= t[x * w + y + 1]) x++;
				else y++;
			}
		}
		for (i = suf; i > 0; i--) pairs.push([n - i, m - i]);
		return pairs;
	}
	function diffHunks(base, side) {
		var pairs = lcsPairs(base, side), hunks = [], bi = 0, si = 0;
		pairs.concat([[base.length, side.length]]).forEach(function (p) {
			if (p[0] > bi || p[1] > si) hunks.push({ bs: bi, be: p[0], ss: si, se: p[1] });
			bi = p[0] + 1; si = p[1] + 1;
		});
		return hunks;
	}
	function tokenize(str) { return str ? str.split(/(\s+)/).filter(function (x) { return x !== ''; }) : []; }
	// מיזוג רצפים כלליים (שורות או מילים). מחזיר parts: {t:'text', v:[...]} ו-{t:'conflict', base, ours, theirs}.
	// onConflict(base, ours, theirs) יכול להחזיר פתרון (מערך) להתנגשות, או null.
	// strict: כל נגיעה נחשבת חפיפה (מיזוג מילים); אחרת (מיזוג שורות) שינויים צמודים שאינם חופפים ממוזגים בנפרד.
	function mergeSeq(base, ours, theirs, onConflict, strict) {
		var ho = diffHunks(base, ours), ht = diffHunks(base, theirs);
		var i = 0, j = 0, pos = 0, parts = [], cur = [], conflicts = 0, auto = 0, kept = 0, word = 0;
		var flush = function () { if (cur.length) { parts.push({ t: 'text', v: cur }); cur = []; } };
		var range = function (hunks, side, cs, ce) {
			var f = hunks[0], l = hunks[hunks.length - 1];
			return side.slice(f.ss - (f.bs - cs), l.se + (ce - l.be));
		};
		while (i < ho.length || j < ht.length) {
			// זורעים את האשכול בשינוי שמתחיל ראשון; בשוויון, הוספה (טווח ריק) לפני שינוי של טווח.
			var fromO = i >= ho.length ? false : j >= ht.length ? true
				: ho[i].bs !== ht[j].bs ? ho[i].bs < ht[j].bs
				: (ho[i].be === ho[i].bs) || (ht[j].be !== ht[j].bs);
			var seed = fromO ? ho[i++] : ht[j++];
			var co = [], ct = [], cs = seed.bs, ce = seed.be, emptyAt = {};
			var add = function (h, mine) { (mine ? co : ct).push(h); ce = Math.max(ce, h.be); if (h.be === h.bs) emptyAt[h.bs] = true; };
			add(seed, fromO);
			// חפיפה אמיתית: טווחים שחותכים זה את זה, הוספה בתוך טווח ששונה, או שתי הוספות באותה נקודה.
			// הוספה או שינוי שצמודים לקצה של שינוי אחר (בשורה הבאה או הקודמת) הם בלתי תלויים.
			var overlaps = function (h) {
				if (strict) return h.bs < ce || (h.bs === ce && (h.be === h.bs || ce === cs));
				if (h.be > h.bs) return h.bs < ce && h.be > cs;
				return (h.bs > cs && h.bs < ce) || emptyAt[h.bs] === true;
			};
			for (var grew = true; grew; ) {
				grew = false;
				while (i < ho.length && overlaps(ho[i])) { add(ho[i], true); i++; grew = true; }
				while (j < ht.length && overlaps(ht[j])) { add(ht[j], false); j++; grew = true; }
			}
			for (; pos < cs; pos++) cur.push(base[pos]);
			if (!ct.length) { cur.push.apply(cur, range(co, ours, cs, ce)); kept++; }
			else if (!co.length) { cur.push.apply(cur, range(ct, theirs, cs, ce)); auto++; }
			else {
				var o = range(co, ours, cs, ce), t = range(ct, theirs, cs, ce);
				if (o.join('\n') === t.join('\n')) { cur.push.apply(cur, o); auto++; }
				else {
					var resolved = onConflict ? onConflict(base.slice(cs, ce), o, t) : null;
					if (resolved) { cur.push.apply(cur, resolved); auto++; word++; }
					else { flush(); parts.push({ t: 'conflict', base: base.slice(cs, ce), ours: o, theirs: t }); conflicts++; }
				}
			}
			pos = Math.max(pos, ce);
		}
		for (; pos < base.length; pos++) cur.push(base[pos]);
		flush();
		return { parts: parts, conflicts: conflicts, auto: auto, kept: kept, word: word };
	}
	// התנגשות ברמת שורות נבדקת שוב ברמת מילים: אם שני הצדדים שינו מילים שונות באותה פסקה, זה ממוזג אוטומטית.
	function mergeWords(baseLines, oursLines, theirsLines) {
		var r = mergeSeq(tokenize(baseLines.join('\n')), tokenize(oursLines.join('\n')), tokenize(theirsLines.join('\n')), null, true);
		if (r.conflicts) return null;
		var text = r.parts.map(function (p) { return p.v.join(''); }).join('');
		return text === '' ? [] : text.split('\n');
	}
	// הטקסט הסופי מ-parts. choices[i] לכל התנגשות: 'ours' | 'theirs' | 'both' | {text} (עריכה ידנית).
	// התנגשות בלי בחירה מסומנת בסימנים בסגנון git (לבדיקות בלבד; ה-UI דורש בחירה לפני פתיחת טופס העריכה).
	function renderParts(parts, choices) {
		var out = [], ci = 0;
		parts.forEach(function (p) {
			if (p.t === 'text') { out.push.apply(out, p.v); return; }
			var c = choices && choices[ci++];
			if (c === 'ours') out.push.apply(out, p.ours);
			else if (c === 'theirs') out.push.apply(out, p.theirs);
			else if (c === 'both') { out.push.apply(out, p.ours); out.push.apply(out, p.theirs); }
			else if (c && typeof c === 'object') { if (c.text !== '') out.push.apply(out, c.text.split('\n')); }
			else { out.push('<<<<<<< המכלול'); out.push.apply(out, p.ours); out.push('======='); out.push.apply(out, p.theirs); out.push('>>>>>>> ויקיפדיה'); }
		});
		return out.join('\n');
	}
	function merge3(baseText, oursText, theirsText) {
		var r = mergeSeq(baseText.split('\n'), oursText.split('\n'), theirsText.split('\n'), mergeWords);
		r.text = renderParts(r.parts, null);
		return r;
	}

	// אותן החלפות אוטומטיות כמו applyReplacements בייבוא (mw-import): regex עם gi, רק אם יש התאמה.
	function applyImportReplacements(text, replacements) {
		(replacements || []).forEach(function (r) {
			var regex = new RegExp(r.from, 'gi');
			if (regex.test(text)) text = text.replace(regex, r.to);
		});
		return text;
	}
	// הייבוא מצרף בסוף הערך {{וח}} (או {{וח|דף}}) ואחריה {{מיון ויקיפדיה}}. מפרידים אותם לפני המיזוג
	// (הבסיס וגרסת ויקיפדיה לא מכילים אותם) ומצרפים בחזרה אחרי, כדי שלא יהפכו להתנגשות עם שינוי בסוף הערך.
	var IMPORT_TAIL_RE = /(\n[ \t]*\{\{וח(?:\|[^{}]*)?\}\}[ \t]*\n[ \t]*\{\{מיון ויקיפדיה[\s\S]*\}\}\s*)$/;
	function splitImportTail(text) {
		var m = IMPORT_TAIL_RE.exec(text);
		return m ? { body: text.slice(0, m.index), tail: m[1] } : { body: text, tail: '' };
	}
	var HE_MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
	// הערות HTML, nowiki ו-pre מוחלפים ברווחים (באותו אורך): תבנית שבתוכם אינה פעילה.
	function maskWikitext(text) {
		return text.replace(/<!--[\s\S]*?(?:-->|$)|<nowiki>[\s\S]*?(?:<\/nowiki>|$)|<pre[\s\S]*?(?:<\/pre>|$)/gi, function (m) { return m.replace(/[^\n]/g, ' '); });
	}
	// התבנית {{מיון ויקיפדיה}} הפעילה האחרונה: אינדקסים של הגוף ושל הפרמטרים ברמה העליונה בלבד (לא בתוך {{…}} או [[…]]).
	function findSortTemplate(text) {
		var masked = maskWikitext(text), re = /\{\{\s*מיון\s+ויקיפדיה\s*\|/g, m, starts = [];
		while ((m = re.exec(masked))) starts.push(m.index + m[0].length);
		for (var k = starts.length - 1; k >= 0; k--) {
			var depth = 1, i = starts[k], end = -1;
			while (i < masked.length - 1) {
				var pair = masked.substr(i, 2);
				if (pair === '{{') { depth++; i += 2; }
				else if (pair === '}}') { depth--; if (depth === 0) { end = i; break; } i += 2; }
				else i++;
			}
			if (end < 0) continue;
			var ranges = [], ps = starts[k], curly = 0, square = 0;
			for (i = starts[k]; i < end; i++) {
				var two = masked.substr(i, 2);
				if (two === '{{') { curly++; i++; }
				else if (two === '}}') { curly--; i++; }
				else if (two === '[[') { square++; i++; }
				else if (two === ']]') { square--; i++; }
				else if (masked[i] === '|' && curly === 0 && square === 0) { ranges.push([ps, i]); ps = i + 1; }
			}
			ranges.push([ps, end]);
			return {
				start: starts[k], end: end,
				params: ranges.map(function (r) {
					var eq = -1, c = 0, sq = 0;
					for (var x = r[0]; x < r[1]; x++) {
						var t2 = masked.substr(x, 2);
						if (t2 === '{{') { c++; x++; } else if (t2 === '}}') { c--; x++; } else if (t2 === '[[') { sq++; x++; } else if (t2 === ']]') { sq--; x++; }
						else if (masked[x] === '=' && c === 0 && sq === 0) { eq = x; break; }
					}
					return eq < 0 ? { name: '', valueStart: r[0], valueEnd: r[1] } : { name: text.slice(r[0], eq).trim(), valueStart: eq + 1, valueEnd: r[1] };
				})
			};
		}
		return null;
	}
	// גרסת הבסיס (גרסה=) מהתבנית הפעילה בתוכן הנוכחי של הערך; null אם אין או שאינה מספר חיובי.
	function parseSortTemplateRev(text) {
		var t = findSortTemplate(text);
		var p = t && t.params.filter(function (x) { return x.name === 'גרסה'; })[0];
		var v = p ? text.slice(p.valueStart, p.valueEnd).trim() : '';
		return /^[1-9]\d*$/.test(v) ? Number(v) : null;
	}
	// מעדכן בתבנית הפעילה את גרסה= ואת תאריך= (חודש ושנה), ורק פרמטרים ברמה העליונה שלה; מוסיף פרמטר שחסר.
	function updateSortTemplate(text, revId, now) {
		var t = findSortTemplate(text);
		if (!t) return text;
		var values = { 'גרסה': String(revId), 'תאריך': HE_MONTH_NAMES[now.getMonth()] + ' ' + now.getFullYear() };
		var edits = [], missing = '';
		Object.keys(values).forEach(function (name) {
			var p = t.params.filter(function (x) { return x.name === name; })[0];
			if (!p) { missing += '|' + name + '=' + values[name]; return; }
			var old = text.slice(p.valueStart, p.valueEnd);
			edits.push([p.valueStart, p.valueEnd, /^\s*/.exec(old)[0] + values[name] + /\s*$/.exec(old)[0]]);
		});
		if (missing) edits.push([t.end, t.end, missing]);
		edits.sort(function (a, b) { return b[0] - a[0]; });
		edits.forEach(function (e) { text = text.slice(0, e[0]) + e[2] + text.slice(e[1]); });
		return text;
	}
	// טקסט גרסה מתשובת API. תוכן חסר או מוסתר הוא כשל קריאה ועוצר את הפעולה; תוכן ריק אמיתי ('') תקין.
	function revisionText(rv) {
		var slot = rv && rv.slots && rv.slots.main;
		if (!slot || slot.texthidden || rv.texthidden || rv.suppressed || typeof slot.content !== 'string') throw new Error('תוכן הגרסה חסר או מוסתר (לא נקרא)');
		return slot.content;
	}
	// </merge3>

	// <content-check>
	// התאמות חדשות שהעדכון מכניס: בטקסט המועמד ולא בערך הנוכחי (לפי המילה והסביבה הקרובה שלה, כדי שמה שכבר
	// קיים ואושר בערך לא יוצג שוב). core = המנוע של word-filter (mw.wikitextWordCheck.core), lists = רשימות מקומפלות.
	function newContentMatches(core, lists, candidateText, oursText, options) {
		var key = function (text, m) { var c = core.contextOf(text, m, 25); return m.text + '|' + c.before + '|' + c.after; };
		var seen = {};
		core.scan(oursText, lists, options).forEach(function (m) { var k = key(oursText, m); seen[k] = (seen[k] || 0) + 1; });
		return core.scan(candidateText, lists, options).filter(function (m) {
			var k = key(candidateText, m);
			if (seen[k]) { seen[k]--; return false; }
			return true;
		});
	}
	// </content-check>

	function fetchWikipediaContent(params) {
		return wikipediaApi(Object.assign({ action: 'query', prop: 'revisions', rvprop: 'ids|content', rvslots: 'main' }, params)).then(function (d) {
			var pg = (d.query && d.query.pages || [])[0], rv = pg && (pg.revisions || [])[0];
			if (!rv) throw new Error('הגרסה לא נמצאה בוויקיפדיה');
			return { revid: rv.revid, pageid: pg.pageid, text: revisionText(rv) };
		});
	}
	// שלוש הגרסאות, חי ולא נשמר. גרסת הבסיס נקראת מהתבנית בתוכן הנוכחי של הערך במכלול (לא מהמסד, שעלול להיות ישן),
	// ומאומת שהיא שייכת לדף הוויקיפדיה המקושר.
	function loadUpdateVersions(row) {
		return mwApiFetch({ action: 'query', prop: 'revisions', pageids: row.id, rvprop: 'ids|content|timestamp', rvslots: 'main' }).then(function (d) {
			var pg = (d.query && d.query.pages || [])[0], rv = pg && (pg.revisions || [])[0];
			if (!rv) throw new Error('הערך לא נמצא במכלול');
			var oursText = revisionText(rv);
			var baseRev = parseSortTemplateRev(oursText);
			if (!baseRev) throw new Error('בתבנית {{מיון ויקיפדיה}} של הערך אין גרסת בסיס (גרסה=)');
			return Promise.all([fetchWikipediaContent({ revids: baseRev }), fetchWikipediaContent({ pageids: row.wikipedia_id })]).then(function (r) {
				if (Number(r[0].pageid) !== Number(row.wikipedia_id)) throw new Error('גרסת הבסיס בתבנית (' + baseRev + ') שייכת לדף אחר בוויקיפדיה, לא לערך המקושר');
				return { base: r[0], theirs: r[1], ours: { text: oursText, ts: rv.timestamp, title: pg.title }, baseRev: baseRev };
			});
		});
	}
	// ===== בדיקת תוכן (מנוע סינון המילים) לתוספות של העדכון =====
	// המנוע נחשף על ידי הגאדג'ט "בדיקת מילים חשודות" כ-mw.wikitextWordCheck (word-filter/Gadget-wikitextWordCheck.js).
	// נבדק הטקסט האפשרי הרחב ביותר (בהתנגשות: שלנו ואחריו ויקיפדיה) מול הערך הנוכחי, ומוצגות רק התאמות חדשות.
	// מיקום המנוע, בלי צורך בגאדג'ט: דף סקריפט + שני דפי JSON (כמו "כסקריפט אישי" ב-word-filter/README.md). מגדירים ב-common.js
	// או כאן: window.mchlWordCheck = { script: 'משתמש:X/wordcheck.js', words: 'משתמש:X/words.json', allow: 'משתמש:X/allow.json' };
	// (script = תוכן הקובץ word-filter/Gadget-wikitextWordCheck.js; words/allow = lists/words.json ו-lists/allow.json).
	// אם קיים גאדג'ט בשם wikitextWordCheck, הוא משמש כברירת מחדל.
	var wordCheckPromise = null;
	function getWordCheck() {
		if (!wordCheckPromise) {
			var cfg = window.mchlWordCheck || {};
			var ready = function () {
				if (!mw.wikitextWordCheck) throw new Error('המנוע נטען אבל לא נחשף - צריך את הגרסה העדכנית של Gadget-wikitextWordCheck.js');
				return mw.wikitextWordCheck;
			};
			wordCheckPromise = Promise.resolve(mw.loader.using(['mediawiki.api', 'mediawiki.util'])).then(function () {
				if (mw.wikitextWordCheck) return mw.wikitextWordCheck;
				if (cfg.script) {
					// המנוע קורא את מיקום הרשימות בזמן הטעינה, ולכן מגדירים לפני.
					if (cfg.words) window.wikitextWordCheckPages = { words: cfg.words, allow: cfg.allow };
					var url = mw.util.wikiScript('index') + '?title=' + encodeURIComponent(cfg.script) + '&action=raw&ctype=text/javascript';
					return Promise.resolve(mw.loader.getScript(url)).then(ready);
				}
				if (mw.loader.getState('ext.gadget.wikitextWordCheck')) return Promise.resolve(mw.loader.using('ext.gadget.wikitextWordCheck')).then(ready);
				throw new Error('מנוע הסינון לא מוגדר: אין גאדג\'ט wikitextWordCheck, ולא הוגדר window.mchlWordCheck (דף סקריפט ודפי רשימות)');
			}).then(function (wc) {
				return Promise.resolve(wc.loadLists()).then(function (lists) { return { core: wc.core, lists: lists }; });
			});
			wordCheckPromise.catch(function () { wordCheckPromise = null; });
		}
		return wordCheckPromise;
	}
	function updateCandidateText(res) {
		var choices = res.parts.filter(function (p) { return p.t === 'conflict'; }).map(function () { return 'both'; });
		return renderParts(res.parts, choices) + res.tail;
	}
	function contentCheckHtml(core, candidate, matches) {
		var level = core.verdict(matches);
		var counted = function (m) { return core.VERDICT_TOPICS.indexOf(m.topic) >= 0; };
		var cls = { problem: 'mchl-alert', review: 'mchl-review', wording: 'mchl-neutral', clean: 'mchl-wiki' }[level];
		var n = function (lv) { return matches.filter(function (m) { return counted(m) && m.level === lv; }).length; };
		var head = '<span class="mchl-badge ' + cls + '">בדיקת תוכן חדש: ' + escapeHtml(core.LEVEL_LABELS[level]) + '</span>';
		if (level === 'clean') return head + ' <span class="mchl-muted">לא נמצאו התאמות חדשות</span>';
		var counts = (n('problem') ? n('problem') + ' בעיה ודאית' : '') + (n('problem') && n('review') ? ' · ' : '') + (n('review') ? n('review') + ' לבדיקה' : '');
		var order = { problem: 0, review: 1 };
		var sorted = matches.slice().sort(function (a, b) {
			return (counted(b) - counted(a)) || ((order[a.level] === undefined ? 2 : order[a.level]) - (order[b.level] === undefined ? 2 : order[b.level])) || a.start - b.start;
		});
		var item = function (m) {
			var c = core.contextOf(candidate, m, 60);
			return '<li>[' + escapeHtml(core.TOPIC_LABELS[m.topic] || m.topic) + (counted(m) ? ', ' + escapeHtml(core.LEVEL_LABELS[m.level]) : '') + ']: ' +
				escapeHtml(c.before) + '<mark>' + escapeHtml(c.text) + '</mark>' + escapeHtml(c.after) + '</li>';
		};
		return head + (counts ? ' <span class="mchl-muted">' + counts + '</span>' : '') +
			'<ul class="mchl-upd-content-list">' + sorted.slice(0, 8).map(item).join('') + '</ul>' +
			(sorted.length > 8 ? '<details><summary class="mchl-muted">עוד ' + (sorted.length - 8) + ' התאמות</summary><ul class="mchl-upd-content-list">' + sorted.slice(8).map(item).join('') + '</ul></details>' : '');
	}
	function runUpdateContentCheck(box, res) {
		var el = box.querySelector('.mchl-upd-content');
		if (!el) return;
		el.innerHTML = '<span class="mchl-muted">בודק את התוכן החדש…</span>';
		getWordCheck().then(function (wc) {
			var candidate = updateCandidateText(res);
			var matches = newContentMatches(wc.core, wc.lists, candidate, res.oursFull, { allow: window.wikitextWordCheckAllow || [] });
			el.innerHTML = contentCheckHtml(wc.core, candidate, matches);
		}).catch(function (e) {
			el.innerHTML = '<span class="mchl-badge mchl-review">בדיקת התוכן לא זמינה</span> <span class="mchl-muted">' + escapeHtml(e && e.message ? e.message : e) +
				' · אפשר להריץ "בדיקת מילים חשודות בקוד" בטופס העריכה</span>';
		});
	}

	// תוצאת המיזוג האחרונה לכל ערך: parts, בחירות לכל התנגשות, וזנב הייבוא. תמיד מחושבת מחדש בפתיחת הפאנל.
	var updateMergeCache = new Map(); // row.id -> {parts, choices, tail, oursBody, baseRev, latestRev, title, oursTs, ...}
	// wordDiffHtml: מדגיש מילים ששונות בין שתי גרסאות של אותו קטע (רק להצגה בטופס ההתנגשויות).
	function wordDiffHtml(aText, bText) {
		var a = tokenize(aText), b = tokenize(bText), inA = {}, inB = {};
		lcsPairs(a, b).forEach(function (pr) { inA[pr[0]] = true; inB[pr[1]] = true; });
		var render = function (t, keep) { return t.map(function (w, k) { return keep[k] || /^\s+$/.test(w) ? escapeHtml(w) : '<mark>' + escapeHtml(w) + '</mark>'; }).join(''); };
		return [render(a, inA), render(b, inB)];
	}
	function unresolvedConflicts(res) {
		var n = 0, k = 0;
		res.parts.forEach(function (p) {
			if (p.t !== 'conflict') return;
			var c = res.choices[k++];
			if (!c || (typeof c === 'object' && c.pending)) n++;
		});
		return n;
	}
	// הטקסט הסופי לעריכה: בחירות העורך, זנב הייבוא ועדכון גרסה ותאריך. לא כולל סימני התנגשות.
	function finalUpdateText(res) {
		var choices = res.choices.map(function (c) { return c && typeof c === 'object' ? { text: c.text } : c; });
		return updateSortTemplate(renderParts(res.parts, choices) + res.tail, res.latestRev, new Date());
	}
	function updateStatusHtml(res) {
		var left = unresolvedConflicts(res);
		if (left) return '<span class="mchl-badge mchl-alert">נותרו ' + left + ' התנגשויות לפתרון</span>';
		var noChange = res.conflicts === 0 && renderParts(res.parts, null) === res.oursBody;
		if (res.conflicts) return '<span class="mchl-badge mchl-wiki">כל ההתנגשויות נפתרו</span>';
		return noChange ? '<span class="mchl-badge mchl-neutral">אין שינוי בטקסט</span>' : '<span class="mchl-badge mchl-wiki">מיזוג נקי</span>';
	}
	function updateConflictsHtml(res) {
		var k = 0, total = res.conflicts;
		return '<div class="mchl-upd-conflicts">' + res.parts.filter(function (p) { return p.t === 'conflict'; }).map(function (p) {
			var idx = k++;
			var d = wordDiffHtml(p.ours.join('\n'), p.theirs.join('\n'));
			var radio = function (val, label) { return '<label><input type="radio" name="mchl-cf-' + idx + '" value="' + val + '" data-cf="' + idx + '"> ' + label + '</label>'; };
			return '<div class="mchl-upd-conflict" data-cf-card="' + idx + '"><div class="mchl-upd-cf-head">התנגשות ' + (idx + 1) + ' מתוך ' + total + '</div>' +
				'<div class="mchl-upd-cf-cols"><div><div class="mchl-upd-cf-title">המכלול (הנוכחי)</div><pre>' + (d[0] || '<span class="mchl-muted">(ריק)</span>') + '</pre></div>' +
				'<div><div class="mchl-upd-cf-title">ויקיפדיה (עכשיו)</div><pre>' + (d[1] || '<span class="mchl-muted">(ריק)</span>') + '</pre></div></div>' +
				'<details><summary class="mchl-muted">הגרסה שממנה עודכן הערך (בסיס)</summary><pre>' + (escapeHtml(p.base.join('\n')) || '<span class="mchl-muted">(ריק)</span>') + '</pre></details>' +
				'<div class="mchl-upd-cf-choice">' + radio('ours', 'להשאיר את שלנו') + radio('theirs', 'לקחת את ויקיפדיה') + radio('both', 'שניהם (שלנו, ואחריו ויקיפדיה)') + radio('manual', 'עריכה ידנית') + '</div>' +
				'<textarea class="mchl-upd-cf-text" data-cf-text="' + idx + '" style="display:none" dir="rtl">' + escapeHtml(p.ours.join('\n')) + '</textarea></div>';
		}).join('') + '</div>';
	}
	function updateMergeHtml(row, res) {
		var convNote = res.converted ? '' : ' <span class="mchl-badge mchl-review" title="רשימת ההחלפות של הייבוא לא נטענה, ולכן המיזוג נעשה על טקסט גולמי מוויקיפדיה; צפויות יותר התנגשויות">בלי החלפות הייבוא</span>';
		var baseNote = res.baseChanged ? ' <span class="mchl-badge mchl-review" title="הערך עודכן מאז הסריקה האחרונה; המיזוג משתמש בגרסה שבתבנית הנוכחית">גרסת הבסיס בתבנית ' + res.baseRev + '</span>' : '';
		var detail = res.conflicts === 0 && renderParts(res.parts, null) === res.oursBody
			? 'יעודכנו רק גרסה ותאריך בתבנית {{מיון ויקיפדיה}}'
			: res.auto + ' שינויים מוויקיפדיה שולבו' + (res.word ? ' (מהם ' + res.word + ' ברמת מילים)' : '') + ' · ' + res.kept + ' שינויים מקומיים נשמרו' +
				(res.conflicts ? '' : ' · כדאי לעבור על מה שנוסף לפני השמירה (מיזוג נקי אינו מבטיח שהתוכן החדש עומד בסינון)');
		return '<div class="mchl-upd-merge"><span class="mchl-upd-status">' + updateStatusHtml(res) + '</span>' + convNote + baseNote + ' <span class="mchl-muted">' + detail + '</span> ' +
			'<button type="button" class="mchl-import-btn" data-action="update-merge-open" data-id="' + row.id + '"' + (unresolvedConflicts(res) ? ' disabled' : '') + '>פתח בעריכה במכלול</button></div>' +
			'<div class="mchl-upd-content"></div>' +
			(res.conflicts ? updateConflictsHtml(res) : '');
	}
	// מחבר את בחירות ההתנגשויות: בחירה מעדכנת את res.choices, את הסטטוס ואת הכפתור.
	function wireUpdateConflicts(box, row, res) {
		var refresh = function () {
			box.querySelector('.mchl-upd-status').innerHTML = updateStatusHtml(res);
			box.querySelector('[data-action="update-merge-open"]').disabled = unresolvedConflicts(res) > 0;
		};
		box.querySelectorAll('input[data-cf]').forEach(function (r) {
			r.addEventListener('change', function () {
				var idx = Number(r.getAttribute('data-cf'));
				var ta = box.querySelector('[data-cf-text="' + idx + '"]');
				if (r.value === 'manual') { ta.style.display = 'block'; res.choices[idx] = { text: ta.value }; }
				else { ta.style.display = 'none'; res.choices[idx] = r.value; }
				refresh();
			});
		});
		box.querySelectorAll('textarea[data-cf-text]').forEach(function (ta) {
			ta.addEventListener('input', function () { res.choices[Number(ta.getAttribute('data-cf-text'))] = { text: ta.value }; refresh(); });
		});
	}
	function updateDiffHtml(res) {
		var key = res.baseRev + ':' + res.latestRev; // הגרסאות אינן משתנות, ולכן בטוח לשמור
		if (updateDiffCache.has(key)) return Promise.resolve(updateDiffCache.get(key));
		return wikipediaApi({ action: 'compare', fromrev: res.baseRev, torev: res.latestRev, prop: 'diff|diffsize' }).then(function (data) {
			var body = data.compare && data.compare.body;
			var html = body ? '<table class="diff">' + sanitizeDiffHtml(body) + '</table>' : '<div class="mchl-muted">אין הבדלי טקסט בין הגרסאות.</div>';
			updateDiffCache.set(key, html);
			return html;
		}).catch(function () { return '<div class="mchl-muted">לא ניתן לשלוף את ההשוואה.</div>'; });
	}
	function toggleUpdatePanel(btn) {
		var id = btn.getAttribute('data-id');
		var tr = btn.closest('tr');
		var next = tr.nextElementSibling;
		if (next && next.classList.contains('mchl-upd-details-row')) { next.remove(); tr.classList.remove('mchl-open'); return; }
		tr.classList.add('mchl-open');
		var row = currentPageRows.find(function (r) { return String(r.id) === id; });
		var detailsTr = document.createElement('tr');
		detailsTr.className = 'mchl-upd-details-row';
		detailsTr.innerHTML = '<td colspan="' + tr.children.length + '"><div class="mchl-upd-box mchl-muted">טוען את שלוש הגרסאות ומבצע מיזוג…</div></td>';
		tr.parentNode.insertBefore(detailsTr, tr.nextSibling);
		var box = detailsTr.querySelector('.mchl-upd-box');
		Promise.all([
			loadUpdateVersions(row),
			getImportReplacements().then(function (list) { return list; }, function () { return null; })
		]).then(function (all) {
			var v = all[0], list = all[1];
			// הבסיס וגרסת ויקיפדיה עוברים את אותן החלפות של הייבוא, כדי ששינויי "גיור" לא יהפכו להתנגשויות מדומות.
			var base = list ? applyImportReplacements(v.base.text, list) : v.base.text;
			var theirs = list ? applyImportReplacements(v.theirs.text, list) : v.theirs.text;
			var ours = splitImportTail(v.ours.text);
			var m = mergeSeq(base.split('\n'), ours.body.split('\n'), theirs.split('\n'), mergeWords);
			var res = {
				parts: m.parts, choices: [], tail: ours.tail, oursBody: ours.body, oursFull: v.ours.text,
				conflicts: m.conflicts, auto: m.auto, kept: m.kept, word: m.word,
				baseRev: v.baseRev, baseChanged: v.baseRev !== Number(row.sort_template_rev), latestRev: v.theirs.revid,
				title: v.ours.title, oursTs: v.ours.ts, converted: !!list
			};
			updateMergeCache.set(row.id, res);
			return updateDiffHtml(res).then(function (diff) { return [res, diff]; });
		}).then(function (r) {
			box.classList.remove('mchl-muted');
			box.innerHTML = updateMergeHtml(row, r[0]) +
				'<details class="mchl-upd-diffbox"><summary>מה השתנה בוויקיפדיה: גרסה ' + r[0].baseRev + ' → ' + r[0].latestRev + '</summary><div class="mchl-upd-diff">' + r[1] + '</div></details>';
			if (r[0].conflicts) wireUpdateConflicts(box, row, r[0]);
			runUpdateContentCheck(box, r[0]);
		}).catch(function (e) {
			updateMergeCache.delete(row.id);
			box.innerHTML = '<span class="mchl-alert">שגיאה בטעינה או במיזוג: ' + escapeHtml(e.message || e) + '</span>';
		});
	}

	// פותח את טופס העריכה של הערך במכלול עם הטקסט הממוזג, מוכן לבדיקה ולשמירה (לא נשמר בלי לחיצה על "שמירה").
	function openUpdateMerge(btn) {
		var row = currentPageRows.find(function (r) { return String(r.id) === btn.getAttribute('data-id'); });
		var res = row && updateMergeCache.get(row.id);
		if (!res || unresolvedConflicts(res)) return;
		btn.disabled = true;
		mwApiFetch({ action: 'query', meta: 'tokens', type: 'csrf' }).then(function (d) {
			var token = (d.query && d.query.tokens && d.query.tokens.csrftoken) || '+\\';
			var fields = {
				wpTextbox1: finalUpdateText(res),
				wpSummary: 'עדכון מוויקיפדיה, גרסה ' + res.latestRev,
				wpEditToken: token, wpUnicodeCheck: 'ℳ𝒲♥𝓊𝓃𝒾𝒸ℴ𝒹ℯ', wpUltimateParam: '1',
				wpStarttime: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
				wpEdittime: (res.oursTs || '').replace(/\D/g, '').slice(0, 14),
				wpDiff: '1', wpSection: '', wpAutoSummary: 'd41d8cd98f00b204e9800998ecf8427e', model: 'wikitext', format: 'text/x-wiki'
			};
			var form = document.createElement('form');
			form.method = 'post'; form.target = '_blank'; form.acceptCharset = 'UTF-8';
			form.action = mw.config.get('wgScript') ? mw.config.get('wgScript') + '?title=' + encodeURIComponent(res.title.replace(/ /g, '_')) + '&action=submit' : mechalolEditUrl(res.title).replace('action=edit', 'action=submit');
			Object.keys(fields).forEach(function (k) {
				var input = document.createElement('input');
				input.type = 'hidden'; input.name = k; input.value = fields[k];
				form.appendChild(input);
			});
			document.body.appendChild(form);
			form.submit();
			form.remove();
		}).catch(function (e) {
			mw.notify('לא ניתן לפתוח את טופס העריכה: ' + (e.message || e), { type: 'error' });
		}).then(function () { btn.disabled = false; });
	}

	// ===== טאב "עדכון" - הודעת הסבר וטריות הנתונים =====
	// הטריות: ההצלחה האחרונה הישנה ביותר מבין שני זרמי העדכון השעתי (מכלול וויקיפדיה),
	// כי הצלחה של זרם אחד לא מעידה שהרשימה עדכנית. מתוך report_source_update_freshness.
	var updateFresh = null; // null = טרם נטען, 'error' = נכשל, אחרת שורת ה-view
	var UPDATE_STALE_MINUTES = 180;
	function freshnessInnerHtml() {
		if (!updateFresh) return '<span class="mchl-muted">בודק טריות…</span>';
		if (updateFresh === 'error') return '<span class="mchl-badge mchl-review">לא ניתן לבדוק את טריות הנתונים</span>';
		if (!updateFresh.last_success_at || updateFresh.streams < 2) return '<span class="mchl-badge mchl-alert">אין נתוני עדכון שעתי לשני האתרים</span>';
		var minutes = Math.max(0, Math.round((Date.now() - new Date(updateFresh.last_success_at).getTime()) / 60000));
		var ago = minutes < 60 ? 'לפני ' + minutes + ' דקות' : 'לפני ' + Math.round(minutes / 60) + ' שעות';
		if (updateFresh.max_failures > 0) return '<span class="mchl-badge mchl-alert">כשל בעדכון השעתי (' + updateFresh.max_failures + ' כשלונות רצופים) · הצלחה אחרונה ' + ago + '</span>';
		if (minutes > UPDATE_STALE_MINUTES) return '<span class="mchl-badge mchl-alert">העדכון השעתי לא רץ ' + ago + '</span>';
		return '<span class="mchl-badge mchl-wiki">הנתונים מעודכנים · ' + ago + '</span>';
	}
	function updateBannerHtml(cfg) {
		if (!cfg.freshness) return '';
		return '<div class="mchl-update-note"><span id="mchl-update-fresh">' + freshnessInnerHtml() + '</span>' +
			'<div class="mchl-row-desc">ערכים שוויקיפדיה התקדמה בהם מאז העדכון האחרון. זה גבול עליון: גם שחזור או עריכה קטנה נספרים (שחזור מסומן "תוכן זהה"). "עדכן" מבצע מיזוג עם הערך במכלול ופותח את טופס העריכה, בלי לשמור.</div></div>';
	}
	function loadUpdateFreshness() {
		var myTab = activeTab;
		return withRetry(function () {
			var url = SUPABASE_URL + '/rest/v1/report_source_update_freshness?select=*';
			return fetch(url, { headers: pgHeaders({ Range: '0-0' }) }).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			});
		}).then(function (data) {
			updateFresh = (data && data[0]) || 'error';
		}).catch(function () {
			updateFresh = 'error';
		}).then(function () {
			var el = $id('mchl-update-fresh');
			if (el && activeTab === myTab) el.innerHTML = freshnessInnerHtml();
		});
	}

	function renderTable() {
		var cfg = VIEWS[activeTab];
		var columns = effectiveColumns(cfg);
		var banner = updateBannerHtml(cfg);
		if (currentPageRows.length === 0) {
			$id('mchl-table-target').innerHTML = banner + '<div class="mchl-state"><div class="mchl-big">אין תוצאות</div>אין שורות התואמות לסינון הנוכחי.</div>';
			return;
		}
		var allOnPageSelected = currentPageRows.every(function (r) { return selectedRows.has(rowKey(r)); });
		var thead = '<tr><th class="mchl-chk-col"><input type="checkbox" data-action="toggle-page-selection" ' + (allOnPageSelected ? 'checked' : '') + '></th>' +
			columns.map(function (c) { return '<th' + (c === 'import_action' || c === 'expand' || c === 'update_action' ? ' class="mchl-narrow-col"' : '') + '>' + escapeHtml(c in COLUMN_LABELS ? COLUMN_LABELS[c] : c) + '</th>'; }).join('') + '</tr>';
		var tbody = currentPageRows.map(function (r) {
			var selected = selectedRows.has(rowKey(r));
			var expandable = columns.indexOf('expand') >= 0 && wfHasDetails(r);
			return '<tr class="' + (selected ? 'mchl-selected' : '') + (expandable ? ' mchl-expandable' : '') + (updateRowIsSame(r) ? ' mchl-upd-same' : '') + '">' +
				'<td class="mchl-chk-col" data-label=""><input type="checkbox" data-action="toggle-row-selection" data-row-id="' + escapeHtml(rowIdOf(r)) + '" ' + (selected ? 'checked' : '') + '></td>' +
				columns.map(function (c) { return '<td data-label="' + escapeHtml(COLUMN_LABELS[c] || c) + '">' + renderCell(c, r) + '</td>'; }).join('') + '</tr>';
		}).join('');
		$id('mchl-table-target').innerHTML = banner + '<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
		paintExisting();
	}

	function renderCell(col, row) {
		var val = row[col];
		if (col === 'title') {
			var url = VIEWS[activeTab].titleLink === 'edit' ? mechalolEditUrl(val) : mechalolUrl(row.id);
			var link = '<span class="mchl-title"><a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(val) + '</a></span>';
			// בטאבים עם displayColumns התיאור מוויקינתונים מוצג מתחת לכותרת, במקום עמודה משלו.
			if (VIEWS[activeTab].displayColumns && VIEWS[activeTab].wikidata) link += '<div class="mchl-row-desc">' + renderCell('wikidata_desc', row) + '</div>';
			return link;
		}
		if (col === 'topic') {
			if (row.dictionary) return '<span class="mchl-badge mchl-neutral" title="' + escapeHtml('מועמד לייבוא מילוני: ' + (row.dictionary_why || '')) + '">מילוני: ' + escapeHtml(row.dictionary) + '</span>';
			return row.topic && WF_TOPIC_LABELS[row.topic] ? '<span class="mchl-topic-cell">' + escapeHtml(WF_TOPIC_LABELS[row.topic]) + '</span>' : '<span class="mchl-muted">—</span>';
		}
		if (col === 'wf_matches') return renderWfMatches(row);
		if (col === 'import_action') {
			// "קיים במכלול כהפניה" - הפעולה היא לבדוק את יעד ההפניה, לא לייבא על ההפניה.
			if (activeTab === 'missing_redirect') return '<button type="button" class="mchl-import-btn" disabled title="קיים במכלול כהפניה - לבדוק את יעד ההפניה">ייבוא</button>';
			var bot = importBotClass(row);
			return '<button type="button" class="mchl-import-btn" data-action="import" data-title="' + escapeHtml(row.title) + '"' +
				(bot ? ' data-bot="' + escapeHtml(bot) + '"' : '') + ' title="' +
				escapeHtml(bot ? 'ייבוא מילוני (בוט ' + bot + '): פתיח, בלי תמונות - נפתח בלשונית חדשה לתצוגה מקדימה' : 'ייבוא - נפתח בלשונית חדשה לתצוגה מקדימה') + '">' +
				(bot ? 'ייבוא מילוני' : 'ייבוא') + '</button>';
		}
		if (col === 'expand') {
			return wfHasDetails(row) ? '<button type="button" class="mchl-expand-btn" data-action="wf-details" data-id="' + row.id + '" title="פרטים: המילים במשפט שלהן, הקוד המוסתר והתמונות" aria-expanded="false">▾</button>' : '';
		}
		if (col === 'update_date') {
			if (!row.sort_template_date) return '<span class="mchl-muted">ללא תאריך</span>';
			var updDate = new Date(row.sort_template_date + 'T00:00:00');
			return '<span class="mchl-num-cell" title="חודש העדכון המתועד בתבנית {{מיון ויקיפדיה}} (תאריך=)">' +
				escapeHtml(updDate.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })) + '</span>';
		}
		if (col === 'update_change') return renderUpdateChange(row);
		if (col === 'update_action') return '<button type="button" class="mchl-import-btn" data-action="update-open" data-id="' + row.id + '" title="השוואה ומיזוג של מה שהתחדש בוויקיפדיה, ופתיחת טופס העריכה במכלול">עדכן</button>';
		if (col === 'wikipedia_title') return '<span class="mchl-title"><a href="' + wikipediaUrl(row.wikipedia_id) + '" target="_blank" rel="noopener">' + escapeHtml(val) + '</a></span>';
		if (col === 'mechalol_title') return '<a href="' + mechalolUrl(row.mechalol_id) + '" target="_blank" rel="noopener">' + escapeHtml(val) + '</a>';
		if (col === 'mechalol_status') return '<span class="mchl-badge mchl-neutral">' + escapeHtml(val) + '</span>';
		if (col === 'wikipedia_id') return val ? '<a href="' + wikipediaUrl(val) + '" target="_blank" rel="noopener" class="mchl-num-cell">' + val + '</a>' : '<span class="mchl-muted">—</span>';
		if (col === 'source_type') return '<span class="mchl-badge mchl-neutral">' + escapeHtml(SOURCE_TYPE_LABELS[val] || val) + '</span>';
		if (col === 'match_type') return '<span class="mchl-badge ' + (val === 'ללא התאמה' ? 'mchl-alert' : 'mchl-wiki') + '">' + escapeHtml(val) + '</span>';
		if (col === 'status') return '<span class="mchl-badge mchl-neutral">' + escapeHtml(val) + '</span>';
		if (col === 'task_type') return '<span class="mchl-badge mchl-alert">' + escapeHtml(val) + '</span>';
		if (col === 'manual_match_action') {
			// כיוון הפוך מהעמודה הישנה (שהייתה ב"משימות לטיפול"): כאן row
			// היא שורת ויקיפדיה (מ-report_missing_from_mechalol) - ה-
			// wikipedia_id כבר ידוע (row.id), ומחפשים כותרת מכלולאית -
			// חיפוש חי (ilike התחלה, עד 5 תוצאות) במקום הקלדה עיוורת של
			// כותרת מדויקת. הכפתור מנוטרל עד שנבחרת הצעה בפועל (ראו
			// pickManualMatchSuggestion) - מונע ניסיון שיוך לפי טקסט חופשי
			// שלא נפתר לשורת מכלול אמיתית.
			//
			// כשיש הפניה קיימת במכלול (mechalol_redirect_exists) - ממלאים
			// מראש עם היעד האמיתי של ההפניה (מטמון mechalolRedirectTargetCache,
			// נבדק חי מול מדיה-ויקי) - המשתמש כבר לא צריך לדעת/להקליד את
			// הכותרת בעצמו ברוב המקרים, רק לאשר בלחיצה על "שייך". עדיין
			// אפשר לערוך את הטקסט ולחפש משהו אחר אם ההצעה לא נכונה.
			var redirectCached = row.mechalol_redirect_exists === true ? mechalolRedirectTargetCache.get(row.title) : undefined;
			var prefillTitle = (redirectCached && redirectCached.targetTitle) ? redirectCached.targetTitle : '';
			var prefillId = (redirectCached && redirectCached.mechalolId) ? redirectCached.mechalolId : '';
			var hintText = '';
			if (row.mechalol_redirect_exists === true) {
				hintText = redirectCached === undefined
					? 'בודק הפניה קיימת…'
					: (prefillTitle ? 'הצעה אוטומטית מהפניה קיימת - אפשר לשנות' : '');
			}
			return '<span class="mchl-manual-match-cell"' +
				(row.mechalol_redirect_exists === true ? ' data-redirect-check-title="' + escapeHtml(row.title) + '"' : '') +
				' data-wikipedia-id="' + row.id + '"' +
				(prefillId ? ' data-selected-mechalol-id="' + prefillId + '"' : '') + '>' +
				'<span class="mchl-manual-match-input-wrap">' +
				'<input type="text" class="mchl-search mchl-manual-match-input" placeholder="כותרת מכלולאית" autocomplete="off" value="' + escapeHtml(prefillTitle) + '">' +
				(hintText ? '<div class="mchl-manual-match-hint">' + escapeHtml(hintText) + '</div>' : '') +
				'</span>' +
				'<div class="mchl-manual-match-suggestions" style="display:none;"></div>' +
				'<button type="button" class="mchl-export-btn" data-action="assign-manual-match" data-wikipedia-id="' + row.id + '"' + (prefillId ? '' : ' disabled') + '>שייך</button>' +
				'</span>';
		}
		if (col === 'verdict') return renderContentLevel(row);
		if (col === 'has_images') {
			if (row.has_images === true) return '<span class="mchl-num-cell" title="תמונות של הערך">' + row.photo_count + '</span>';
			if (row.has_images === false) return '<span class="mchl-muted">אין</span>';
			return '<span class="mchl-muted">—</span>';
		}
		if (col === 'checked_at' || col === 'created_at') return val ? '<span class="mchl-num-cell">' + new Date(val).toLocaleDateString('he-IL') + '</span>' : '<span class="mchl-muted">—</span>';
		if (col === 'mechalol_redirect_exists') {
			if (val === true) return '<span class="mchl-badge mchl-neutral">קיים כהפניה</span>';
			if (val === false) return '<span class="mchl-muted">אין בכלל</span>';
			return '<span class="mchl-muted">טרם נבדק</span>';
		}
		if (col === 'wikidata_desc') {
			var title = row.title;
			if (wikidataCache.has(title)) {
				var v = wikidataCache.get(title);
				if (v === null) return '<span class="mchl-muted" data-desc-title="' + escapeHtml(title) + '">שגיאה בשליפה</span>';
				if (v === '') return '<span class="mchl-muted" data-desc-title="' + escapeHtml(title) + '">—</span>';
				return '<span data-desc-title="' + escapeHtml(title) + '">' + escapeHtml(v) + '</span>';
			}
			return '<span class="mchl-skeleton" data-desc-title="' + escapeHtml(title) + '" style="display:inline-block;height:12px;width:70%;">&nbsp;</span>';
		}
		if (col === 'deletion_hint') {
			var hintTitle = row.title;
			if (deletionHintCache.has(hintTitle)) {
				var cached = deletionHintCache.get(hintTitle);
				if (!cached) return '<span class="mchl-muted" data-hint-title="' + escapeHtml(hintTitle) + '">—</span>';
				var dateStr = new Date(cached.at).toLocaleDateString('he-IL');
				if (cached.type === 'rename') {
					return '<span class="mchl-badge mchl-alert" data-hint-title="' + escapeHtml(hintTitle) + '">שינוי שם ← "' + escapeHtml(cached.newTitle) + '" (' + dateStr + ')</span>';
				}
				return '<span class="mchl-badge mchl-alert" data-hint-title="' + escapeHtml(hintTitle) + '">מחיקה בפועל (' + dateStr + ')</span>';
			}
			return '<span class="mchl-skeleton" data-hint-title="' + escapeHtml(hintTitle) + '" style="display:inline-block;height:12px;width:70%;">&nbsp;</span>';
		}
		return escapeHtml(val == null ? '—' : val);
	}

	// רמת התוכן - התג בלבד. הספירות בעמודת "מילים", והפרטים בשורה הנפתחת.
	function renderContentLevel(row) {
		var level = wfRowLevel(row);
		if (!level) return '<span class="mchl-muted">טרם נסרק</span>';
		var info = WF_SUSPICION[level] || WF_LEVELS[level];
		return '<span class="mchl-badge ' + info.cls + '">' + escapeHtml(info.label) + '</span>';
	}

	function wfHasDetails(row) { return !!(row.matches_total || row.has_images || row[wfHiddenColumn()] || row[wfNamesColumn()]); }

	// ספירה קצרה של המילים שנמצאו, לפי השיטה והרשימות שנבחרו; ומילים בקוד המוסתר.
	function renderWfMatches(row) {
		var counts = row.counts && row.counts[(wfMethod === 'ctx' ? 'c' : '') + wfMode];
		var parts = [];
		if (counts) {
			if (counts.problem) parts.push(counts.problem + ' בעיה');
			if (wfMethod === 'ctx') {
				if (counts.high) parts.push(counts.high + ' גבוה');
				if (counts.medium) parts.push(counts.medium + ' בינוני');
				if (counts.low) parts.push(counts.low + ' נמוך');
			} else if (counts.review) parts.push(counts.review + ' לבדיקה');
			if (counts.wording) parts.push(counts.wording + ' ניסוח');
			if (counts.names) parts.push(counts.names + ' שמות הקודש');
		}
		var html = parts.length ? '<span class="mchl-num-cell mchl-nowrap">' + escapeHtml(parts.join(' · ')) + '</span>' : '<span class="mchl-muted">—</span>';
		var hidden = row[wfHiddenColumn()];
		if (hidden) html += ' <span class="mchl-tag" title="מילים בקוד שהקורא לא רואה - לא נספרות ברמה">' + hidden + ' בקוד</span>';
		return html;
	}

	// פרטי הסינון לערך אחד - שורה נפתחת מתחת לשורה בטבלה: כל מילה עם המשפט
	// שלה (העורך לא רואה כאן את הטקסט המלא), לפי הרשימות שנבחרו, ותמונות
	// הערך כתמונות ממוזערות - לחיצה פותחת מציג במסך מלא (openWfViewer).
	function toggleContentDetails(btn) {
		var id = btn.getAttribute('data-id');
		var tr = btn.closest('tr');
		var next = tr.nextElementSibling;
		if (next && next.classList.contains('mchl-wf-details-row')) {
			next.remove(); btn.textContent = '▾'; btn.setAttribute('aria-expanded', 'false'); tr.classList.remove('mchl-open'); return;
		}
		btn.textContent = '▴'; btn.setAttribute('aria-expanded', 'true'); tr.classList.add('mchl-open');
		var detailsTr = document.createElement('tr');
		detailsTr.className = 'mchl-wf-details-row';
		detailsTr.innerHTML = '<td colspan="' + tr.children.length + '"><div class="mchl-wf-box mchl-muted">טוען…</div></td>';
		tr.parentNode.insertBefore(detailsTr, tr.nextSibling);
		var box = detailsTr.querySelector('.mchl-wf-box');
		var row = currentPageRows.find(function (r) { return String(r.id) === id; });
		loadContentDetails(id).then(function (d) {
			// מנהל מחובר - גם הסימונים שלו (✗/✓), כדי להציג אותם ליד כל מילה.
			return (serviceKeyConnected ? loadWfFeedback(id).catch(function () { return null; }) : Promise.resolve(null))
				.then(function () { return d; });
		}).then(function (d) {
			box.classList.remove('mchl-muted');
			box.innerHTML = renderContentDetails(d, row);
		}).catch(function (e) {
			box.innerHTML = '<span class="mchl-alert">שגיאה בשליפת הפרטים: ' + escapeHtml(e.message || e) + '</span>';
		});
	}

	function loadContentDetails(id) {
		if (wfDetailsCache.has(id)) return Promise.resolve(wfDetailsCache.get(id));
		return withRetry(function () {
			var params = new URLSearchParams();
			params.set('select', 'matches,matches_total,images,photo_count,scanned_at,rev_id,lists_version');
			params.set('wikipedia_id', 'eq.' + id);
			return fetch(SUPABASE_URL + '/rest/v1/word_filter_results?' + params.toString(), { headers: pgHeaders() })
				.then(function (res) {
					if (!res.ok) return res.text().then(function (t) { throw makePgError(res.status, t); });
					return res.json();
				});
		}).then(function (rows) {
			var d = rows && rows[0];
			if (!d) throw new Error('אין תוצאות סריקה לערך הזה');
			wfDetailsCache.set(id, d);
			return d;
		});
	}

	// ===== סימון התראות: ✗ התראת שווא / ✓ בעייתי באמת (word_filter_feedback) =====
	// רק למנהל מחובר (אותה רשימה כמו שיוך ידני - is_manual_match_admin). הסימונים
	// מצטברים לכל רשומה ברשימות (word_filter_feedback_summary): תבנית שנצברו עליה
	// 10 סימוני ✗ ומעלה, או 20% מהמופעים, עולה לתיקון; מופע בודד נשאר בבדיקה.
	// ההתאמה מזוהה בערך לפי שורה + מילה + רשומות (wfMatchKey).
	var wfFeedbackCache = new Map(); // wikipedia_id -> { match_key: 'false' | 'true' }
	function wfMatchKey(m) { return m.line + ':' + m.x + ':' + (m.e || []).slice().sort().join(','); }
	function loadWfFeedback(id) {
		var params = new URLSearchParams();
		params.set('select', 'match_key,label');
		params.set('wikipedia_id', 'eq.' + id);
		return fetch(SUPABASE_URL + '/rest/v1/word_filter_feedback?' + params.toString(), { headers: authHeaders() })
			.then(function (res) {
				if (!res.ok) return res.text().then(function (t) { throw makePgError(res.status, t); });
				return res.json();
			}).then(function (rows) {
				var marks = {};
				rows.forEach(function (r) { marks[r.match_key] = r.label; });
				wfFeedbackCache.set(String(id), marks);
				return marks;
			});
	}
	function wfFeedbackButtons(id, d, m) {
		if (!serviceKeyConnected) return '';
		var mark = (wfFeedbackCache.get(String(id)) || {})[wfMatchKey(m)];
		var i = d.matches.indexOf(m);
		return ' <span class="mchl-wf-fb">' +
			'<button type="button" class="mchl-wf-fb-btn' + (mark === 'false' ? ' mchl-on-false' : '') + '" data-action="wf-feedback" data-label="false" data-mi="' + i +
			'" title="התראת שווא: זו לא המילה, או שימוש תמים">✗</button>' +
			'<button type="button" class="mchl-wf-fb-btn' + (mark === 'true' ? ' mchl-on-true' : '') + '" data-action="wf-feedback" data-label="true" data-mi="' + i +
			'" title="בעייתי באמת">✓</button></span>';
	}
	function wfFeedback(btn) {
		var detailsRow = btn.closest('tr.mchl-wf-details-row');
		var id = detailsRow && detailsRow.previousElementSibling.querySelector('[data-action="wf-details"]').getAttribute('data-id');
		var d = id && wfDetailsCache.get(id);
		var m = d && d.matches[parseInt(btn.getAttribute('data-mi'), 10)];
		if (!m) return;
		var label = btn.getAttribute('data-label');
		var key = wfMatchKey(m);
		var marks = wfFeedbackCache.get(String(id)) || {};
		var unmark = marks[key] === label; // לחיצה שנייה על אותו סימון מבטלת אותו
		var row = currentPageRows.find(function (r) { return String(r.id) === id; });
		var mode = wfMode;
		var level = m.h ? m[mode] : (wfMethod === 'ctx' && m['c' + mode] != null ? m['c' + mode] : m[mode]);
		var send = function () {
			if (unmark) {
				var q = new URLSearchParams();
				q.set('wikipedia_id', 'eq.' + id);
				q.set('match_key', 'eq.' + key);
				return fetch(SUPABASE_URL + '/rest/v1/word_filter_feedback?' + q.toString(), {
					method: 'DELETE', headers: authHeaders({ Prefer: 'return=minimal' })
				});
			}
			return fetch(SUPABASE_URL + '/rest/v1/word_filter_feedback?on_conflict=wikipedia_id,match_key,user_id', {
				method: 'POST',
				headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
				body: JSON.stringify({
					wikipedia_id: Number(id), title: row ? row.title : null, match_key: key, word: m.x, entries: m.e || [],
					topic: m.t || null, hidden: m.h || null, label: label, level: level || null,
					before: m.b || null, after: m.f || null, lists_version: d.lists_version || null
				})
			});
		};
		var group = btn.parentNode;
		Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) { b.disabled = true; });
		send().then(function (res) {
			if (res.status !== 401) return res;
			return refreshAuthSession().then(send);
		}).then(function (res) {
			if (res.status === 403) throw new Error('החשבון המחובר אינו ברשימת המורשים (manual_match_admins).');
			if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t); });
			if (unmark) delete marks[key]; else marks[key] = label;
			wfFeedbackCache.set(String(id), marks);
			Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) {
				var l = b.getAttribute('data-label');
				b.classList.toggle('mchl-on-false', l === 'false' && marks[key] === 'false');
				b.classList.toggle('mchl-on-true', l === 'true' && marks[key] === 'true');
			});
		}).catch(function (e) {
			alert('הסימון נכשל: ' + (e.message || e));
		}).then(function () {
			Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) { b.disabled = false; });
		});
	}

	function renderContentDetails(d, row) {
		var mode = wfMode;
		// בשיטת ההקשר - הרמה של כל התאמה לפי המילה והמשפט (ca/cs); סריקה ישנה בלי
		// השדות האלה נופלת חזרה לרמת הרשימה (a/s).
		var levelOf = function (m) {
			if (wfMethod === 'ctx' && m['c' + mode] != null) return m['c' + mode];
			return m[mode];
		};
		var all = (d.matches || []).filter(function (m) { return m[mode] != null; });
		var matches = all.filter(function (m) { return !m.h; });
		var hiddenMatches = all.filter(function (m) { return m.h; });
		var html = '';
		['problem', 'high', 'medium', 'low', 'review', 'wording', 'names'].forEach(function (level) {
			var items = matches.filter(function (m) { return levelOf(m) === level; });
			if (!items.length) return;
			var info = WF_SUSPICION[level] || WF_LEVELS[level];
			var markLevel = level === 'high' || level === 'medium' || level === 'low' ? 'review' : level;
			html += '<div class="mchl-wf-group"><span class="mchl-badge ' + info.cls + '">' +
				escapeHtml(info.label) + ' (' + items.length + ')</span><ul>';
			items.forEach(function (m) {
				var notes = [];
				if (mode === 's' && m.a == null) notes.push('רק לפי ההצעות');
				if (m.d && m.d.length && markLevel === 'review') notes.push('ירד לבדיקה - שימוש תמים אפשרי');
				if (wfMethod === 'ctx' && m['k' + mode] && m.kw) notes.push('מילת הקשר: ' + m.kw.join(', '));
				if (wfMethod === 'ctx' && m.g) notes.push({ anchor: 'עוגן', A: 'מילה בעייתית ברוב המקרים', B: 'מילה דו-משמעית', C: 'מילה תמימה ברוב המקרים', X: 'בעיה לפי הרשימה' }[m.g] || m.g);
				html += '<li><span class="mchl-num-cell">שורה ' + m.line + ' · ' + escapeHtml(WF_TOPICS[m.t] || m.t) + '</span> ' +
					escapeHtml(m.b) + '<mark class="mchl-wf-' + markLevel + '">' + escapeHtml(m.x) + '</mark>' + escapeHtml(m.f) +
					(notes.length ? ' <span class="mchl-muted">(' + escapeHtml(notes.join('; ')) + ')</span>' : '') +
					' <span class="mchl-muted mchl-wf-ids" title="רשומות ברשימת המילים">' + escapeHtml((m.e || []).join(',')) + '</span>' +
					wfFeedbackButtons(row ? row.id : '', d, m) + '</li>';
			});
			html += '</ul></div>';
		});
		if (!html) html = '<div class="mchl-muted">אין התאמות לפי הרשימות שנבחרו.</div>';
		var shown = (d.matches || []).filter(function (m) { return !m.h; }).length;
		if (d.matches_total > shown) {
			html += '<div class="mchl-muted">מוצגות ' + shown + ' התאמות מתוך ' + d.matches_total + '.</div>';
		}
		if (hiddenMatches.length) {
			html += '<div class="mchl-wf-group"><span class="mchl-badge mchl-neutral" title="הקוד כולו עובר למכלול, אבל הקורא לא רואה את החלקים האלה. לא נספר ברמת הערך - להחלטת העורך.">בקוד המוסתר בלבד (' +
				hiddenMatches.length + ')</span><ul>';
			hiddenMatches.forEach(function (m) {
				var level = m[mode];
				html += '<li><span class="mchl-num-cell">שורה ' + m.line + ' · ' + escapeHtml(WF_HIDDEN_KINDS[m.h] || m.h) + ' · ' +
					escapeHtml((WF_LEVELS[level] || {}).label || level) + '</span> <code class="mchl-wf-code">' +
					escapeHtml(m.b) + '<mark class="mchl-wf-hidden">' + escapeHtml(m.x) + '</mark>' + escapeHtml(m.f) + '</code>' +
					' <span class="mchl-muted mchl-wf-ids" title="רשומות ברשימת המילים">' + escapeHtml((m.e || []).join(',')) + '</span>' +
					wfFeedbackButtons(row ? row.id : '', d, m) + '</li>';
			});
			html += '</ul></div>';
		}
		if (d.images && d.images.length) {
			html += '<div class="mchl-wf-group"><span class="mchl-badge mchl-neutral">תמונות הערך (' + d.photo_count + ')</span>' +
				(d.photo_count > d.images.length ? ' <span class="mchl-muted">מוצגות ' + d.images.length + '</span>' : '') +
				'<div class="mchl-wf-thumbs">' +
				d.images.map(function (name, i) {
					return '<button type="button" class="mchl-wf-thumb" data-action="wf-image" data-index="' + i + '" title="' + escapeHtml(name) + '">' +
						'<img loading="lazy" alt="' + escapeHtml(name) + '" src="' + escapeHtml(wfImageUrl(name, 240)) + '"></button>';
				}).join('') + '</div></div>';
		}
		var when = d.scanned_at ? new Date(d.scanned_at).toLocaleDateString('he-IL') : '';
		html += '<div class="mchl-muted mchl-wf-foot">נסרק ' + escapeHtml(when) + ' · <a href="' + wikipediaUrl(row ? row.id : '') +
			'" target="_blank" rel="noopener">הערך בוויקיפדיה</a></div>';
		return html;
	}

	// ===== תמונות הערך: ממוזערות, ומציג במסך מלא =====
	// מציג משלנו ולא MultimediaViewer (מותקן במכלול): הוא נפתח רק מתמונות בתוך
	// תוכן הדף, ואין לו ממשק ציבורי יציב לפתיחת רשימת קבצים שרירותית.
	// דרך Special:FilePath של המכלול עצמו, כדי לראות בדיוק מה שיוצג בערך אחרי
	// הייבוא: המכלול מחפש קובץ בשם הזה קודם אצלו, אחר כך בוויקיפדיה, ואחר כך
	// בוויקישיתוף (דרך ויקיפדיה) - meta=filerepoinfo: local, hewiki. כך קובץ
	// שהוחלף במכלול בגרסה מתוקנת מוצג בגרסה של המכלול. width בפיקסלים.
	var MICHLOL_BASE = 'https://www.hamichlol.org.il';
	function wfImageUrl(name, width) {
		return MICHLOL_BASE + '/Special:FilePath/' + encodeURIComponent(name) + (width ? '?width=' + width : '');
	}
	function wfFilePageUrl(name) {
		return MICHLOL_BASE + '/' + encodeURIComponent('קובץ:' + name);
	}

	var wfViewer = { images: [], index: 0, el: null };
	function openWfViewer(images, index) {
		wfViewer.images = images;
		if (!wfViewer.el) {
			var el = document.createElement('div');
			el.className = 'mchl-viewer';
			el.setAttribute('role', 'dialog');
			el.setAttribute('aria-modal', 'true');
			el.innerHTML = '<button type="button" class="mchl-viewer-btn mchl-viewer-close" data-viewer="close" title="סגירה (Esc)">✕</button>' +
				'<button type="button" class="mchl-viewer-btn mchl-viewer-prev" data-viewer="prev" title="הקודמת">›</button>' +
				'<button type="button" class="mchl-viewer-btn mchl-viewer-next" data-viewer="next" title="הבאה">‹</button>' +
				'<div class="mchl-viewer-stage" data-viewer="close"><img class="mchl-viewer-img" alt=""><div class="mchl-viewer-loading">טוען…</div></div>' +
				'<div class="mchl-viewer-caption"></div>';
			el.addEventListener('click', function (e) {
				var t = e.target.closest('[data-viewer]');
				if (!t || e.target.classList.contains('mchl-viewer-img')) return;
				var what = t.getAttribute('data-viewer');
				if (what === 'close') closeWfViewer();
				else stepWfViewer(what === 'next' ? 1 : -1);
			});
			var img = el.querySelector('.mchl-viewer-img');
			img.addEventListener('load', function () { el.classList.remove('mchl-viewer-busy'); });
			img.addEventListener('error', function () {
				el.classList.remove('mchl-viewer-busy');
				el.querySelector('.mchl-viewer-caption').insertAdjacentHTML('beforeend', ' <span class="mchl-alert">לא ניתן לטעון את התמונה.</span>');
			});
			document.body.appendChild(el);
			wfViewer.el = el;
		}
		wfViewer.el.style.display = 'flex';
		document.addEventListener('keydown', onWfViewerKey);
		showWfViewerImage(index);
	}
	function showWfViewerImage(index) {
		var n = wfViewer.images.length;
		wfViewer.index = (index + n) % n;
		var name = wfViewer.images[wfViewer.index];
		var el = wfViewer.el;
		// ברזולוציה של המסך (כולל צפיפות פיקסלים), מעוגל למדרגות כדי שהמטמון של ויקיפדיה יעבוד.
		var want = Math.ceil(Math.min(window.innerWidth * (window.devicePixelRatio || 1), 2560) / 320) * 320;
		el.classList.add('mchl-viewer-busy');
		el.querySelector('.mchl-viewer-img').src = wfImageUrl(name, want);
		el.querySelector('.mchl-viewer-img').alt = name;
		el.querySelector('.mchl-viewer-caption').innerHTML = (n > 1 ? '<b>' + (wfViewer.index + 1) + ' / ' + n + '</b> · ' : '') +
			escapeHtml(name) + ' · <a href="' + wfFilePageUrl(name) + '" target="_blank" rel="noopener">דף הקובץ</a>' +
			' · <a href="' + wfImageUrl(name) + '" target="_blank" rel="noopener">גודל מקורי</a>';
		el.querySelector('.mchl-viewer-prev').style.visibility = n > 1 ? 'visible' : 'hidden';
		el.querySelector('.mchl-viewer-next').style.visibility = n > 1 ? 'visible' : 'hidden';
		// טעינה מוקדמת של השכנות, כדי שהמעבר יהיה מיידי.
		[1, -1].forEach(function (d) { if (n > 1) new Image().src = wfImageUrl(wfViewer.images[(wfViewer.index + d + n) % n], want); });
	}
	function stepWfViewer(delta) { if (wfViewer.images.length > 1) showWfViewerImage(wfViewer.index + delta); }
	function closeWfViewer() {
		if (!wfViewer.el) return;
		wfViewer.el.style.display = 'none';
		wfViewer.el.querySelector('.mchl-viewer-img').removeAttribute('src');
		document.removeEventListener('keydown', onWfViewerKey);
	}
	// מקשים: Esc סוגר; החיצים לפי כיוון הקריאה מימין לשמאל - שמאלה = הבאה.
	function onWfViewerKey(e) {
		if (e.key === 'Escape') closeWfViewer();
		else if (e.key === 'ArrowLeft') stepWfViewer(1);
		else if (e.key === 'ArrowRight') stepWfViewer(-1);
		else return;
		e.preventDefault();
	}

	function renderPager() {
		var pager = $id('mchl-pager');
		pager.style.display = 'flex';
		var from = totalRows === 0 ? 0 : currentPage * pageSize + 1;
		var to = Math.min(totalRows, (currentPage + 1) * pageSize);
		if (countUnknown) to = currentPage * pageSize + currentPageRows.length;
		$id('mchl-pager-summary').textContent = 'מציג ' + from.toLocaleString('he-IL') + '–' + to.toLocaleString('he-IL') + ' מתוך ' + (countUnknown ? '? (הספירה לא התקבלה)' : totalRows.toLocaleString('he-IL'));
		$id('mchl-pg-label').textContent = 'עמוד ' + (currentPage + 1).toLocaleString('he-IL') + (countUnknown ? '' : ' מתוך ' + totalPages.toLocaleString('he-IL'));
		$id('mchl-pg-first').disabled = currentPage === 0;
		$id('mchl-pg-prev').disabled = currentPage === 0;
		$id('mchl-pg-next').disabled = currentPage >= totalPages - 1;
		$id('mchl-pg-last').disabled = countUnknown || currentPage >= totalPages - 1;
	}

	function goPage(p) {
		if (p < 0 || p > totalPages - 1) return;
		currentPage = p;
		loadActiveView();
	}

	function toggleRowSelection(id, checked) {
		var row = currentPageRows.find(function (r) { return rowIdOf(r) === id; });
		if (!row) return;
		var key = rowKey(row);
		if (checked) selectedRows.set(key, row); else selectedRows.delete(key);
		updateSelectionBar();
		syncSelectionMarks();
	}
	function togglePageSelection(checked) {
		currentPageRows.forEach(function (r) {
			var key = rowKey(r);
			if (checked) selectedRows.set(key, r); else selectedRows.delete(key);
		});
		updateSelectionBar();
		syncSelectionMarks();
	}
	function clearSelection() { selectedRows.clear(); updateSelectionBar(); syncSelectionMarks(); }
	// מעדכן רק את תיבות הסימון וצבע השורות - בלי לצייר את הטבלה מחדש (שהייתה מוחקת טקסט
	// שהוקלד בשיוך הידני, שורות פרטים פתוחות והודעות).
	function syncSelectionMarks() {
		var byId = {};
		currentPageRows.forEach(function (r) { byId[rowIdOf(r)] = selectedRows.has(rowKey(r)); });
		document.querySelectorAll('#mchl-table-target input[data-action="toggle-row-selection"]').forEach(function (cb) {
			var on = !!byId[cb.getAttribute('data-row-id')];
			cb.checked = on;
			var tr = cb.closest('tr');
			if (tr) tr.classList.toggle('mchl-selected', on);
		});
		var all = $id('mchl-table-target').querySelector('input[data-action="toggle-page-selection"]');
		if (all) all.checked = currentPageRows.length > 0 && currentPageRows.every(function (r) { return selectedRows.has(rowKey(r)); });
	}

	function updateSelectionBar() {
		var bar = $id('mchl-selection-bar');
		var n = selectedRows.size;
		$id('mchl-selected-count').textContent = n.toLocaleString('he-IL');
		bar.style.display = n > 0 ? 'flex' : 'none';
		var linkBtn = $id('mchl-select-all-matching-btn');
		if (n > 0 && n < totalRows && currentPageRows.every(function (r) { return selectedRows.has(rowKey(r)); })) {
			linkBtn.style.display = 'inline';
			linkBtn.textContent = 'בחר את כל ' + totalRows.toLocaleString('he-IL') + ' התוצאות התואמות';
		} else {
			linkBtn.style.display = 'none';
		}
		// כפתור הנעילה רלוונטי רק בטאב "חסר במכלול", וגם רק כשיש "חיבור"
		// (ראו saveServiceKey - עדיין לא אימות אמיתי, רק שער נראות)
		// - בלי מפתח שמור, הכפתור לא מוצג בכלל, גם אם יש שורות נבחרות.
		var lockBtn = $id('mchl-lock-titles-btn');
		lockBtn.style.display = (n > 0 && VIEWS[activeTab] && VIEWS[activeTab].lockable && serviceKeyConnected) ? 'inline' : 'none';
	}

	function selectAllMatching() {
		var btn = $id('mchl-select-all-matching-btn');
		var originalText = btn.textContent;
		var cfg = VIEWS[activeTab];
		if (!countUnknown && totalRows > 20000 && !confirm('לבחור ' + totalRows.toLocaleString('he-IL') + ' ערכים? הטעינה תיקח כדקה.')) return Promise.resolve();
		btn.disabled = true;
		btn.textContent = 'טוען…';
		return pgSelectAll(cfg.view, { filterParams: buildFilterParams(), order: stableOrder(cfg) }, function (got, expected) {
			btn.textContent = 'טוען… ' + got.toLocaleString('he-IL') + (expected != null ? ' מתוך ' + expected.toLocaleString('he-IL') : '');
		}).then(function (res) {
			res.data.forEach(function (r) { selectedRows.set(rowKey(r), r); });
			btn.disabled = false;
			btn.textContent = originalText;
			updateSelectionBar();
			syncSelectionMarks();
			if (!res.complete) alert('נבחרו ' + res.data.length.toLocaleString('he-IL') + ' מתוך ' + res.expected.toLocaleString('he-IL') + ' - חלק מהתוצאות לא נטענו. אפשר לנסות שוב.');
		}).catch(function (e) {
			btn.disabled = false;
			btn.textContent = originalText;
			alert(isTransientMaintenanceError(e)
				? 'המסד באמצע עדכון תקופתי כרגע - נסה שוב בעוד רגע.'
				: 'שגיאה בטעינת כל התוצאות, גם אחרי כמה ניסיונות:\n' + (e.message || e) + '\n\nניתן לנסות שוב.');
		});
	}

	// ייצוא: "סינון תוכן" לפי הרשימות שנבחרו בסרגל, כתווית בעברית.
	function exportValue(col, row) {
		if (col === 'verdict') {
			var level = wfRowLevel(row);
			return level ? (WF_SUSPICION[level] || WF_LEVELS[level]).label : 'טרם נסרק';
		}
		if (col === 'topic') return row.dictionary ? 'מילוני: ' + row.dictionary : (WF_TOPIC_LABELS[row.topic] || row.topic || '');
		return row[col];
	}

	function download(filename, content, mime) {
		var blob = new Blob([content], { type: mime + ';charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url; a.download = filename;
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	function getExportRows() {
		if (selectedRows.size > 0) return Promise.resolve(Array.from(selectedRows.values()));
		var cfg = VIEWS[activeTab];
		return pgSelectAll(cfg.view, { filterParams: buildFilterParams(), order: stableOrder(cfg) }).then(function (res) {
			if (!res.complete && !confirm('נטענו ' + res.data.length.toLocaleString('he-IL') + ' מתוך ' + res.expected.toLocaleString('he-IL') + ' ערכים. לייצא בכל זאת?')) return null;
			return res.data;
		}).catch(function (e) {
			alert(isTransientMaintenanceError(e)
				? 'המסד באמצע עדכון תקופתי כרגע - נסה שוב בעוד רגע.'
				: 'שגיאה בהבאת הנתונים לייצוא, גם אחרי כמה ניסיונות:\n' + (e.message || e));
			return null;
		});
	}

	function exportData(kind, btn) {
		var originalText;
		if (btn) { originalText = btn.textContent; btn.disabled = true; btn.textContent = 'מכין…'; }
		return getExportRows().then(function (rows) {
			if (btn) { btn.disabled = false; btn.textContent = originalText; }
			if (rows === null) return;
			if (rows.length === 0) { alert('אין שורות לייצוא.'); return; }
			var cfg = VIEWS[activeTab];
			if (cfg.wikidata) {
				// התיאור מהמסד הוא המקור; המטמון בדפדפן רק משלים שורות שאין
				// להן תיאור שמור. (קודם המטמון דרס את ערך המסד - ולכל שורה
				// שלא הוצגה על המסך הייצוא קיבל תיאור ריק.)
				rows.forEach(function (r) {
					if (r.wikidata_desc !== null && r.wikidata_desc !== undefined) return;
					var v = wikidataCache.get(r.title);
					r.wikidata_desc = (typeof v === 'string') ? v : '';
				});
			}
			var titleColumn = cfg.titleColumn || 'title';
			var idColumns = cfg.exportIdColumns || ['id'];
			var stamp = new Date().toISOString().slice(0, 10);
			var base = cfg.label + '_' + stamp;
			if (kind === 'txt') { download(base + '.txt', rows.map(function (r) { return r[titleColumn]; }).join('\n'), 'text/plain'); return; }
			if (kind === 'json') {
				var clean = rows.map(function (r) { var o = {}; idColumns.concat(cfg.columns).forEach(function (c) { o[c] = exportValue(c, r); }); return o; });
				download(base + '.json', JSON.stringify(clean, null, 2), 'application/json');
				return;
			}
			if (kind === 'csv') {
				var headers = idColumns.concat(cfg.columns);
				var escapeCsv = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
				var lines = [headers.map(function (h) { return escapeCsv(COLUMN_LABELS[h] || h); }).join(',')];
				rows.forEach(function (r) { lines.push(headers.map(function (h) { return escapeCsv(exportValue(h, r)); }).join(',')); });
				download(base + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv');
			}
		});
	}

	// ===== נעילת כותרות (aspaklaryalockdown) - רק בטאב "חסר במכלול" =====
	// משתמש ב-mw.Api הרגיל של המשתמש המחובר עצמו (טוקן CSRF שכבר יש לו
	// דרך ה-session) - *לא* דורש שום מפתח/סוד נפרד, כי הגאדג'ט רץ בתוך
	// המכלול. השרת אוכף הרשאות בעצמו (בדיוק כמו כל עריכה/פעולה רגילה
	// במדיה-ויקי) - זה מה שהופך את הפעולה הזו לבטוחה לבנות ישירות,
	// בניגוד לעריכת manual_matches שדורשת מפתח סופרבייס נפרד.
	function lockSelectedTitles(btn) {
		var titles = Array.from(selectedRows.values()).map(function (r) { return r.title; });
		if (titles.length === 0) return;
		if (!confirm('לנעול ' + titles.length.toLocaleString('he-IL') + ' כותרות ליצירה במכלול?')) return;

		var api = new mw.Api();
		var originalText = btn.textContent;
		btn.disabled = true;
		var failed = [];

		function lockNext(i) {
			if (i >= titles.length) {
				btn.disabled = false;
				btn.textContent = originalText;
				if (failed.length) {
					alert('הסתיים עם ' + failed.length.toLocaleString('he-IL') + ' כשלונות מתוך ' +
						titles.length.toLocaleString('he-IL') + ':\n' + failed.join('\n'));
				} else {
					alert('כל ' + titles.length.toLocaleString('he-IL') + ' הכותרות ננעלו בהצלחה.');
				}
				return;
			}
			btn.textContent = 'נועל… (' + (i + 1) + '/' + titles.length + ')';
			// action=aspaklaryalockdown, level='create' - זהה בדיוק
			// לפעולה ב-create.py שהועלה, רק דרך mw.Api (טוקן אוטומטי)
			// במקום התחברות ידנית נפרדת.
			api.postWithToken('csrf', {
				action: 'aspaklaryalockdown',
				title: titles[i],
				level: 'create',
				formatversion: '2'
			}).done(function (data) {
				if (!(data && data.aspaklaryalockdown && data.aspaklaryalockdown.status === 'Succes')) {
					failed.push(titles[i]);
				}
			}).fail(function () {
				failed.push(titles[i]);
			}).always(function () {
				// אותה השהיה של שנייה כמו ב-create.py, בין נעילה לנעילה.
				sleep(1000).then(function () { lockNext(i + 1); });
			});
		}

		lockNext(0);
	}

	// ===== שיוך התאמה ידנית (manual_matches) - רק כש-serviceKeyConnected,
	// ורק בטאב "חסר במכלול" (ראו effectiveColumns). כיוון: משורת
	// ויקיפדיה (wikipedia_id כבר ידוע) לכותרת מכלולאית, נבחרת מתוך חיפוש
	// חי (לא הקלדה עיוורת של כותרת מדויקת) =====

	var manualMatchDebounce = new WeakMap(); // input element -> timer id
	var MANUAL_MATCH_SEARCH_DELAY_MS = 300;
	var MANUAL_MATCH_SUGGESTION_LIMIT = 5;

	// נקרא מ-wireEvents (event delegation, כמו כל שאר הפעולות) בכל
	// input בתוך תא שיוך ידני - מבטל את הטיימר הקודם לאותו input בלבד
	// (WeakMap, לא טיימר גלובלי יחיד) כדי ששורות שונות לא יפריעו זו לזו.
	function onManualMatchInput(input) {
		var cell = input.closest('.mchl-manual-match-cell');
		var btn = cell.querySelector('button[data-action="assign-manual-match"]');
		// עריכה אחרי שכבר נבחרה הצעה - מבטלים את הבחירה הקודמת, לא
		// משאירים כפתור פעיל שמצביע על טקסט שכבר לא תואם את מה שנבחר.
		delete cell.dataset.selectedMechalolId;
		btn.disabled = true;

		clearTimeout(manualMatchDebounce.get(input));
		var query = (input.value || '').trim();
		var suggestionsBox = cell.querySelector('.mchl-manual-match-suggestions');
		if (!query) {
			suggestionsBox.style.display = 'none';
			suggestionsBox.innerHTML = '';
			return;
		}
		manualMatchDebounce.set(input, setTimeout(function () {
			searchManualMatchSuggestions(query, cell, suggestionsBox);
		}, MANUAL_MATCH_SEARCH_DELAY_MS));
	}

	// ilike עם * בסוף בלבד (התחלת-כותרת) - לא *טקסט* - לפי מה שסוכם:
	// מהיר יותר ומשתמש באינדקס title הקיים, בניגוד לחיפוש-הכל-בכל-מקום.
	function searchManualMatchSuggestions(query, cell, suggestionsBox) {
		var mySeq = String((Number(cell.dataset.searchSeq) || 0) + 1);
		cell.dataset.searchSeq = mySeq;
		suggestionsBox.style.display = 'block';
		suggestionsBox.innerHTML = '<div class="mchl-manual-match-suggestion-loading">מחפש…</div>';
		var params = new URLSearchParams();
		params.set('select', 'id,title');
		params.set('title', 'ilike.' + query.replace(/[%*]/g, '') + '*');
		params.set('order', 'title.asc');
		params.set('limit', String(MANUAL_MATCH_SUGGESTION_LIMIT));
		fetch(SUPABASE_URL + '/rest/v1/mechalol_pages?' + params.toString(), {
			headers: pgHeaders()
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		}).then(function (rows) {
			// המשתמש כבר המשיך להקליד/ניקה בזמן שהבקשה הזו הייתה באוויר -
			// לא מציירים תוצאות מיושנות מעל מה שהוא רואה עכשיו.
			if (suggestionsBox.style.display === 'none' || cell.dataset.searchSeq !== mySeq) return;
			renderManualMatchSuggestions(rows, cell, suggestionsBox);
		}).catch(function () {
			if (cell.dataset.searchSeq !== mySeq) return;
			suggestionsBox.innerHTML = '<div class="mchl-manual-match-suggestion-loading">שגיאה בחיפוש</div>';
		});
	}

	function renderManualMatchSuggestions(rows, cell, suggestionsBox) {
		if (!rows || rows.length === 0) {
			suggestionsBox.innerHTML = '<div class="mchl-manual-match-suggestion-loading">אין תוצאות</div>';
			return;
		}
		suggestionsBox.innerHTML = rows.map(function (r) {
			return '<div class="mchl-manual-match-suggestion-item" data-action="pick-manual-match-suggestion" ' +
				'data-mechalol-id="' + r.id + '" data-mechalol-title="' + escapeHtml(r.title) + '">' +
				escapeHtml(r.title) + '</div>';
		}).join('');
	}

	function pickManualMatchSuggestion(el) {
		var cell = el.closest('.mchl-manual-match-cell');
		var input = cell.querySelector('.mchl-manual-match-input');
		var btn = cell.querySelector('button[data-action="assign-manual-match"]');
		var suggestionsBox = cell.querySelector('.mchl-manual-match-suggestions');

		input.value = el.getAttribute('data-mechalol-title');
		cell.dataset.selectedMechalolId = el.getAttribute('data-mechalol-id');
		suggestionsBox.style.display = 'none';
		suggestionsBox.innerHTML = '';
		btn.disabled = false;
	}

	function assignManualMatch(btn) {
		var wikipediaId = parseInt(btn.getAttribute('data-wikipedia-id'), 10);
		var cell = btn.closest('.mchl-manual-match-cell');
		var input = cell.querySelector('.mchl-manual-match-input');
		var mechalolId = parseInt(cell.dataset.selectedMechalolId, 10);
		var mechalolTitle = input.value;

		// לא אמור לקרות (הכפתור מנוטרל עד שנבחרת הצעה - ראו
		// onManualMatchInput/pickManualMatchSuggestion) - הגנה נוספת בלבד.
		if (!mechalolId) {
			alert('יש לבחור כותרת מתוך רשימת ההצעות לפני שיוך.');
			return;
		}

		btn.disabled = true;
		input.disabled = true;
		var originalText = btn.textContent;
		btn.textContent = 'משייך…';

		// הכתיבה ל-manual_matches - דורשת את הטוקן של המשתמש המחובר
		// (authHeaders), לא מפתח ה-anon. שני ה-id-ים כבר ידועים (מהשורה
		// עצמה + מההצעה שנבחרה) - בניגוד לגרסה הישנה, אין כאן שלב חיפוש
		// נפרד לפני הכתיבה.
		var postMatch = function () {
			return fetch(SUPABASE_URL + '/rest/v1/manual_matches', {
				method: 'POST',
				headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
				body: JSON.stringify({ mechalol_page_id: mechalolId, wikipedia_page_id: wikipediaId })
			});
		};
		// טוקן הגישה של Supabase Auth פג אחרי שעה - על 401 מחדשים פעם
		// אחת עם ה-refresh_token השמור ומנסים שוב.
		postMatch().then(function (res) {
			if (res.status !== 401) return res;
			return refreshAuthSession().then(postMatch);
		}).then(function (res) {
			if (res.status === 403) {
				throw new Error('החשבון המחובר אינו ברשימת המורשים לשיוך ידני (manual_match_admins).');
			}
			if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t); });
			cell.innerHTML = '<span class="mchl-badge mchl-wiki">✓ שויך ל-"' + escapeHtml(mechalolTitle) + '"</span>' +
				'<span class="mchl-muted" style="font-size:11px;">(יתעדכן בדוח בריצה הבאה)</span>';
		}).catch(function (e) {
			btn.disabled = false;
			input.disabled = false;
			btn.textContent = originalText;
			alert('שיוך נכשל: ' + (e.message || e));
		});
	}


	function toggleAdminPanel() {
		var panel = $id('mchl-admin-panel');
		panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
	}

	// ===== התחברות אמיתית (Supabase Auth) - רק לפתיחת פאנל ניהול =====
	// לא ספריית supabase-js (הגאדג'ט לא משתמש בה בכלל, ראו pgHeaders
	// למעלה) - קריאה ישירה לנקודת הקצה של Auth, באותה שיטה שכל שאר
	// הגאדג'ט פונה ל-PostgREST.
	function authLogin() {
		var email = ($id('mchl-auth-email-input').value || '').trim();
		var password = $id('mchl-auth-password-input').value || '';
		var statusEl = $id('mchl-admin-status');
		var btn = $id('mchl-auth-login-btn');

		if (!email || !password) {
			statusEl.textContent = 'יש למלא אימייל וסיסמה.';
			statusEl.className = 'mchl-muted mchl-alert';
			return;
		}

		btn.disabled = true;
		statusEl.textContent = 'מתחבר…';
		statusEl.className = 'mchl-muted';

		fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
			method: 'POST',
			headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: email, password: password })
		}).then(function (res) {
			return res.json().then(function (data) { return { ok: res.ok, data: data }; });
		}).then(function (result) {
			btn.disabled = false;
			if (!result.ok || !result.data.access_token) {
				serviceKeyConnected = false;
				statusEl.textContent = 'התחברות נכשלה: ' + (result.data.error_description || result.data.msg || 'פרטים שגויים');
				statusEl.className = 'mchl-muted mchl-alert';
				updateSelectionBar();
				return;
			}
			sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
				access_token: result.data.access_token,
				refresh_token: result.data.refresh_token,
				email: email
			}));
			serviceKeyConnected = true;
			statusEl.textContent = 'התחברות בוצעה בהצלחה.';
			statusEl.className = 'mchl-muted mchl-success';
			updateSelectionBar();
			syncAuthTabs();
			// אם כבר נמצאים בטאב עם עמודת שיוך ידני ("חסר במכלול"/"קיים כהפניה") - מרעננים
			// כדי שעמודת השיוך הידני תופיע בלי לחכות למעבר טאב.
			if (VIEWS[activeTab] && VIEWS[activeTab].manualMatch) renderTable();
			// נסגר לבד אחרי שהמחוון הראה הצלחה לרגע - לא נשאר פתוח סתם.
			sleep(1200).then(function () { $id('mchl-admin-panel').style.display = 'none'; });
		}).catch(function () {
			btn.disabled = false;
			serviceKeyConnected = false;
			statusEl.textContent = 'שגיאת רשת בהתחברות - נסה שוב.';
			statusEl.className = 'mchl-muted mchl-alert';
			updateSelectionBar();
			syncAuthTabs();
		});
	}

	// מחדש את הסשן עם ה-refresh_token השמור. נכשל -> מנתק (הכפתורים
	// נעלמים) וזורק שגיאה עם הסבר.
	function refreshAuthSession() {
		var stored = null;
		try { stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null'); } catch (e) { stored = null; }
		if (!stored || !stored.refresh_token) {
			return Promise.reject(new Error('פג תוקף ההתחברות - יש להתחבר מחדש בפאנל הניהול.'));
		}
		return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
			method: 'POST',
			headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
			body: JSON.stringify({ refresh_token: stored.refresh_token })
		}).then(function (res) {
			return res.json().then(function (data) { return { ok: res.ok, data: data }; });
		}).then(function (result) {
			if (!result.ok || !result.data.access_token) {
				try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* מתעלמים */ }
				serviceKeyConnected = false;
				updateSelectionBar();
				syncAuthTabs();
				throw new Error('פג תוקף ההתחברות - יש להתחבר מחדש בפאנל הניהול.');
			}
			sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
				access_token: result.data.access_token,
				refresh_token: result.data.refresh_token,
				email: stored.email
			}));
		});
	}

	// בדיקה בטעינת הדף אם כבר יש סשן שמור מקודם באותו טאב (sessionStorage
	// לא מאומת מחדש מול השרת כאן - רק "יש טוקן שמור"; אם פג תוקפו, הקריאה
	// הראשונה שתשתמש בו תחדש אותו דרך refreshAuthSession).
	function restoreAuthSession() {
		try {
			var raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
			if (!raw) return;
			var parsed = JSON.parse(raw);
			if (parsed && parsed.access_token) serviceKeyConnected = true;
		} catch (e) {
			// שריד פגום ב-sessionStorage - מתעלמים, לא מחוברים.
		}
	}


	function wireEvents(root) {
		root.addEventListener('click', function (e) {
			var el = e.target.closest('[data-action]');
			if (!el) {
				// לחיצה על השורה עצמה (לא על קישור, כפתור או תיבת סימון) פותחת וסוגרת את הפרטים.
				var tr = e.target.closest('#mchl-table-target tr.mchl-expandable');
				if (tr && !e.target.closest('a, button, input, label, select, textarea')) {
					var b = tr.querySelector('[data-action="wf-details"]');
					if (b) toggleContentDetails(b);
				}
				return;
			}
			var action = el.getAttribute('data-action');
			if (action === 'refresh') refreshAll();
			else if (action === 'clear-filters') clearFilters();
			else if (action === 'select-all-matching') selectAllMatching();
			else if (action === 'clear-selection') clearSelection();
			else if (action === 'retry') loadCurrentTab();
			else if (action === 'export') exportData(el.getAttribute('data-kind'), el);
			else if (action === 'select-culture-subcat') selectCultureSubcat(el.getAttribute('data-subcat'));
			else if (action === 'culture-back') { cultureState.selected = null; renderCulturePicker(); }
			else if (action === 'culture-load-more') { if (!cultureState.loading) loadCultureMembers(); }
			else if (action === 'lock-titles') lockSelectedTitles(el);
			else if (action === 'assign-manual-match') assignManualMatch(el);
			else if (action === 'pick-manual-match-suggestion') pickManualMatchSuggestion(el);
			else if (action === 'toggle-admin-panel') toggleAdminPanel();
			else if (action === 'auth-login') authLogin();
			else if (action === 'wf-details') toggleContentDetails(el);
			else if (action === 'update-open') toggleUpdatePanel(el);
			else if (action === 'update-merge-open') openUpdateMerge(el);
			else if (action === 'import') importFromDashboard(el);
			else if (action === 'req-filter') { requestsState.filter = el.getAttribute('data-v'); renderRequests(); }
			else if (action === 'req-reply') replyToRequest(el);
			else if (action === 'req-open') toggleRequestPanel(el.closest('tr'));
			else if (action === 'toggle-side') { uiPrefs.sideHidden = !uiPrefs.sideHidden; saveUiPrefs(); applySidePanel(); }
			else if (action === 'chip-remove') removeChip(el.getAttribute('data-chip'));
			else if (action === 'wf-feedback') wfFeedback(el);
			else if (action === 'wf-image') {
				var detailsRow = el.closest('tr.mchl-wf-details-row');
				var cached = detailsRow && wfDetailsCache.get(detailsRow.previousElementSibling.querySelector('[data-action="wf-details"]').getAttribute('data-id'));
				if (cached && cached.images) openWfViewer(cached.images, parseInt(el.getAttribute('data-index'), 10));
			}
			else if (action === 'wf-meter-filter') setWfLevel(wfLevelChoice === el.getAttribute('data-filter') ? '' : el.getAttribute('data-filter'));
			else if (action === 'goto') {
				var target = el.getAttribute('data-target');
				if (target === 'first') goPage(0);
				else if (target === 'prev') goPage(currentPage - 1);
				else if (target === 'next') goPage(currentPage + 1);
				else if (target === 'last') goPage(totalPages - 1);
			}
		});
		// חיפוש חי בתא שיוך ידני (ראו onManualMatchInput) - delegation
		// כמו כל שאר האירועים, לא listener נפרד לכל שורה בנפרד (השורות
		// מצוירות מחדש בכל renderTable, listener ישיר היה נדרש להתחבר
		// מחדש בכל פעם).
		root.addEventListener('input', function (e) {
			if (e.target.matches('.mchl-manual-match-input')) onManualMatchInput(e.target);
		});
		root.addEventListener('change', function (e) {
			var el = e.target;
			if (el.matches('[data-action="toggle-page-selection"]')) togglePageSelection(el.checked);
			else if (el.matches('[data-action="toggle-row-selection"]')) toggleRowSelection(el.getAttribute('data-row-id'), el.checked);
		});
	}
	
	   function getLevel(groups) {
        return Math.max(...groups.map(g => GROUP_LEVELS[g] || 0), 0);
      }

	// דרגת ההרשאה הנדרשת כדי לראות את פאנל הניהול בכלל (מפתח סרוויס +
	// עריכת התאמות ידניות בעתיד) - מעל sysop(20) ו-bot(18) בלבד. זו רק
	// בדיקת-נראות בצד הלקוח (UX, "מי בכלל אמור לראות את זה") - היא
	// *לא* שכבת אבטחה: כל מי שפותח כלי מפתחים יכול לעקוף אותה. ההגנה
	// האמיתית (אם/כשתיבנה) חייבת לבוא מהמסד עצמו, לא מכאן.
	var ADMIN_LEVEL_THRESHOLD = 17;
	// ===== CSS מוגבל תחת #mchl-dash בלבד =====
	var CSS = '' +
		'body.mchl-no-site-nav #mw-panel,body.mchl-no-site-nav .vector-main-menu-container,body.mchl-no-site-nav #mw-navigation #mw-panel{display:none !important;}' +
		'body.mchl-no-site-nav #content,body.mchl-no-site-nav #footer,body.mchl-no-site-nav #mw-head-base{margin-right:0 !important;margin-left:0 !important;}' +
		'body.mchl-no-site-nav #left-navigation{margin-right:1em !important;}' +
		'#mchl-dash{--mchl-ink-900:#0F1B22;--mchl-ink-800:#16262F;--mchl-ink-700:#1E323C;' +
		'--mchl-wiki:#5C9686;--mchl-wiki-dim:#5C968633;--mchl-mechalol:#C79449;--mchl-mechalol-dim:#C7944933;' +
		'--mchl-alert:#C1634A;--mchl-alert-dim:#C1634A26;--mchl-text-1:#EDEAE1;--mchl-text-2:#9FADAF;' +
		'--mchl-text-3:#657679;--mchl-line:rgba(237,234,225,0.10);' +
		'background:var(--mchl-ink-900);color:var(--mchl-text-1);font-family:Assistant,Arial,sans-serif;' +
		'font-feature-settings:"tnum" 1;direction:rtl;max-width:1440px;margin:0 auto;padding:32px 24px 80px;}' +
		'#mchl-dash *{box-sizing:border-box;}' +
		'#mchl-dash a{color:inherit;}' +
		'#mchl-dash header.mchl-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px 16px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--mchl-line);}' +
		'#mchl-dash .mchl-top-title{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 16px;}' +
		'#mchl-dash .mchl-h1{font-family:"Frank Ruhl Libre",Georgia,serif;font-weight:700;font-size:26px;line-height:1.2;color:var(--mchl-text-1);margin:0;border:0;padding:0;}' +
		'#mchl-dash .mchl-h1 .mchl-arrow{color:var(--mchl-text-3);font-size:.8em;}' +
		'#mchl-dash .mchl-h1 .mchl-mch{color:var(--mchl-mechalol);}' +
		'.mchl-sitenav-tab{position:fixed;top:140px;right:0;z-index:100;background:#16262F;color:#EDEAE1;border:1px solid rgba(237,234,225,.18);border-right:0;border-radius:8px 0 0 8px;font:600 13px Assistant,Arial,sans-serif;padding:10px 7px;cursor:pointer;writing-mode:vertical-rl;box-shadow:0 2px 8px rgba(0,0,0,.25);}' +
		'.mchl-sitenav-tab:hover{background:#1E323C;}' +
		'body:not(.mchl-no-site-nav) .mchl-sitenav-tab{right:11em;}' +
		'#mchl-dash .mchl-eyebrow{font-size:13px;letter-spacing:.04em;color:var(--mchl-text-2);margin:0 0 6px;}' +
		'#mchl-dash .mchl-top-actions{display:flex;align-items:center;gap:12px;}' +
		'#mchl-dash .mchl-sync-note{font-size:13px;color:var(--mchl-text-2);}' +
		'#mchl-dash button.mchl-refresh{background:var(--mchl-ink-700);border:1px solid var(--mchl-line);color:var(--mchl-text-1);padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;}' +
		'#mchl-dash button.mchl-refresh .mchl-dot{width:6px;height:6px;border-radius:50%;background:var(--mchl-wiki);}' +
		'#mchl-dash button.mchl-refresh.mchl-spinning .mchl-dot{animation:mchlPulse 1s infinite;}' +
		'@keyframes mchlPulse{0%,100%{opacity:1;}50%{opacity:.2;}}' +
		'#mchl-dash .mchl-ledger{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:14px;padding:22px 24px 18px;margin-bottom:24px;}' +
		'#mchl-dash .mchl-admin-panel{background:var(--mchl-ink-800);border:1px solid var(--mchl-mechalol);border-radius:14px;padding:18px 22px;margin-bottom:24px;}' +
		'#mchl-dash .mchl-admin-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;}' +
		'#mchl-dash .mchl-admin-row label{font-size:13px;color:var(--mchl-text-2);white-space:nowrap;}' +
		'#mchl-dash .mchl-admin-row input{flex:1;min-width:220px;}' +
		'#mchl-dash .mchl-manual-match-cell{position:relative;display:flex;gap:6px;align-items:center;white-space:nowrap;}' +
		'#mchl-dash .mchl-manual-match-input-wrap{display:flex;flex-direction:column;gap:2px;}' +
		'#mchl-dash .mchl-manual-match-cell input{width:150px;padding:6px 8px;font-size:12.5px;}' +
		'#mchl-dash .mchl-manual-match-hint{font-size:10.5px;color:var(--mchl-text-2);white-space:normal;max-width:150px;}' +
		'#mchl-dash .mchl-manual-match-cell button{padding:6px 10px;font-size:12px;white-space:nowrap;}' +
		'#mchl-dash .mchl-manual-match-cell button:disabled{opacity:.5;cursor:not-allowed;}' +
		'#mchl-dash .mchl-manual-match-suggestions{position:absolute;top:100%;right:0;z-index:20;margin-top:2px;min-width:180px;max-width:280px;background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:8px;box-shadow:0 6px 16px rgba(0,0,0,.35);overflow:hidden;}' +
		'#mchl-dash .mchl-manual-match-suggestion-item{padding:7px 10px;font-size:12.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
		'#mchl-dash .mchl-manual-match-suggestion-item:hover{background:var(--mchl-ink-700);}' +
		'#mchl-dash .mchl-manual-match-suggestion-loading{padding:7px 10px;font-size:12.5px;color:var(--mchl-text-2);}' +
		'#mchl-dash #mchl-admin-status.mchl-alert{color:var(--mchl-alert);}' +
		'#mchl-dash #mchl-admin-status.mchl-success{color:var(--mchl-wiki);}' +
		'#mchl-dash .mchl-ledger-heads{display:flex;justify-content:space-between;margin-bottom:14px;}' +
		'#mchl-dash .mchl-ledger-head{display:flex;flex-direction:column;gap:2px;}' +
		'#mchl-dash .mchl-ledger-head .mchl-label{font-size:12px;color:var(--mchl-text-2);}' +
		'#mchl-dash .mchl-ledger-head .mchl-num{font-family:"Frank Ruhl Libre",Georgia,serif;font-size:26px;font-weight:700;}' +
		'#mchl-dash .mchl-ledger-head.mchl-wikih .mchl-num{color:var(--mchl-wiki);}' +
		'#mchl-dash .mchl-ledger-head.mchl-mechaloh .mchl-num{color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-bar{height:14px;border-radius:7px;overflow:hidden;display:flex;background:var(--mchl-ink-700);border:1px solid var(--mchl-line);}' +
		'#mchl-dash .mchl-bar .mchl-seg{height:100%;transition:width .6s ease;}' +
		'#mchl-dash .mchl-bar .mchl-seg.mchl-matched{background:linear-gradient(90deg,var(--mchl-wiki),var(--mchl-mechalol));}' +
		'#mchl-dash .mchl-bar .mchl-seg.mchl-tasks{background:var(--mchl-alert);}' +
		'#mchl-dash .mchl-bar .mchl-seg.mchl-missing{background:var(--mchl-text-3);}' +
		'#mchl-dash .mchl-ledger-legend{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:12.5px;color:var(--mchl-text-2);}' +
		'#mchl-dash .mchl-ledger-legend .mchl-item{display:flex;align-items:center;gap:6px;}' +
		'#mchl-dash .mchl-swatch{width:9px;height:9px;border-radius:2px;display:inline-block;}' +
		'#mchl-dash .mchl-swatch.mchl-matched{background:linear-gradient(90deg,var(--mchl-wiki),var(--mchl-mechalol));}' +
		'#mchl-dash .mchl-swatch.mchl-tasks{background:var(--mchl-alert);}' +
		'#mchl-dash .mchl-swatch.mchl-missing{background:var(--mchl-text-3);}' +
		'#mchl-dash .mchl-warn-inline{color:var(--mchl-alert);font-size:12px;margin-right:6px;cursor:help;}' +
		'#mchl-dash .mchl-stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px;}' +
		'#mchl-dash .mchl-stat-card{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:12px;padding:16px 18px;}' +
		'#mchl-dash .mchl-stat-card .mchl-n{font-family:"Frank Ruhl Libre",Georgia,serif;font-size:28px;font-weight:700;}' +
		'#mchl-dash .mchl-stat-card .mchl-l{font-size:12.5px;color:var(--mchl-text-2);margin-top:4px;display:flex;align-items:center;gap:6px;}' +
		'#mchl-dash .mchl-mini-spinner{width:11px;height:11px;border-radius:50%;border:2px solid var(--mchl-line);border-top-color:var(--mchl-mechalol);animation:mchlSpin .7s linear infinite;display:inline-block;}' +
		'@keyframes mchlSpin{to{transform:rotate(360deg);}}' +
		'#mchl-dash .mchl-tabs{margin-bottom:18px;}' +
		'#mchl-dash .mchl-tab-groups{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;}' +
		'#mchl-dash .mchl-tab-group{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:10px;color:var(--mchl-text-2);font:inherit;font-size:15px;font-weight:700;padding:8px 18px;cursor:pointer;}' +
		'#mchl-dash .mchl-tab-group:hover{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-tab-group.mchl-active{background:var(--mchl-mechalol-dim);border-color:var(--mchl-mechalol);color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-subtabs{display:none;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--mchl-line);}' +
		'#mchl-dash .mchl-subtabs.mchl-open{display:flex;}' +
		'#mchl-dash .mchl-subtabs.mchl-single{display:none;}' +
		'#mchl-dash .mchl-tab{background:none;border:none;color:var(--mchl-text-2);font-size:14px;font-weight:600;padding:9px 4px;cursor:pointer;position:relative;white-space:nowrap;margin-left:20px;}' +
		'#mchl-dash .mchl-tab .mchl-count{display:inline-block;margin-right:6px;margin-left:0;font-size:11.5px;background:var(--mchl-ink-700);color:var(--mchl-text-2);padding:1px 7px;border-radius:20px;}' +
		'#mchl-dash .mchl-tab.mchl-active{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-tab.mchl-active .mchl-count{background:var(--mchl-mechalol-dim);color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-tab.mchl-active::after{content:"";position:absolute;bottom:-1px;right:0;left:0;height:2px;background:var(--mchl-mechalol);border-radius:2px;}' +
		'#mchl-dash .mchl-filter-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px;}' +
		'#mchl-dash .mchl-search-wrap{position:relative;flex:1;min-width:200px;max-width:320px;}' +
		'#mchl-dash input.mchl-search,#mchl-dash select.mchl-filter-select,#mchl-dash select.mchl-page-size,#mchl-dash input.mchl-filter-number{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:8px;color:var(--mchl-text-1);padding:9px 12px;font-size:13.5px;}' +
		'#mchl-dash input.mchl-search{width:100%;}' +
		'#mchl-dash select.mchl-filter-select{cursor:pointer;}' +
		// פריסה: פאנל מסננים בצד + אזור ראשי (טאבי "חסר במכלול")
		'#mchl-dash .mchl-body.mchl-with-side{display:grid;grid-template-columns:272px minmax(0,1fr);gap:18px;align-items:start;}' +
		'#mchl-dash .mchl-body.mchl-with-side.mchl-side-hidden{grid-template-columns:34px minmax(0,1fr);}' +
		'#mchl-dash .mchl-body.mchl-side-hidden .mchl-side{display:none !important;}' +
		'#mchl-dash .mchl-side-rail{display:none;}' +
		'#mchl-dash .mchl-with-side.mchl-side-hidden .mchl-side-rail{display:block;position:sticky;top:12px;background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:10px;color:var(--mchl-text-2);font:inherit;font-size:13px;font-weight:600;padding:12px 6px;cursor:pointer;writing-mode:vertical-rl;}' +
		'#mchl-dash .mchl-side-rail:hover{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-side-top{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;padding:2px 0 8px;}' +
		'#mchl-dash .mchl-side-top button{background:none;border:0;color:var(--mchl-text-2);font:inherit;font-size:12.5px;font-weight:400;cursor:pointer;}' +
		'#mchl-dash .mchl-side-top button:hover{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-side-h.mchl-collapsible{cursor:pointer;user-select:none;justify-content:flex-start;gap:0;}' +
		'#mchl-dash .mchl-side-h.mchl-collapsible > .mchl-link{margin-right:auto;}' +
		'#mchl-dash .mchl-side-h.mchl-collapsible:hover{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-side-h.mchl-collapsible::before{content:"▾";margin-left:6px;color:var(--mchl-text-3);font-size:11px;}' +
		'#mchl-dash .mchl-side-sec.mchl-collapsed > .mchl-side-h.mchl-collapsible::before{content:"▸";}' +
		'#mchl-dash .mchl-side-sec.mchl-collapsed > :not(.mchl-side-h:first-child){display:none;}' +
		'#mchl-dash .mchl-refresh.mchl-quiet{opacity:.8;font-size:13px;}' +
		'#mchl-dash .mchl-main{min-width:0;}' +
		'#mchl-dash .mchl-side{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:12px;padding:10px 14px;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;font-size:13.5px;}' +
		'#mchl-dash .mchl-side-sec{border-top:1px solid var(--mchl-line);padding:10px 0;}' +
		'#mchl-dash .mchl-side-sec:first-child{border-top:0;padding-top:2px;}' +
		'#mchl-dash .mchl-side-h{font-size:12px;color:var(--mchl-text-2);font-weight:700;margin:0 0 6px;display:flex;justify-content:space-between;align-items:center;}' +
		'#mchl-dash .mchl-link{background:none;border:0;color:var(--mchl-mechalol);cursor:pointer;font:inherit;font-size:12px;padding:0;}' +
		'#mchl-dash .mchl-settings-line{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px;color:var(--mchl-text-2);background:var(--mchl-ink-700);border-radius:8px;padding:6px 8px;}' +
		'#mchl-dash .mchl-settings-line b{color:var(--mchl-text-1);font-weight:600;}' +
		'#mchl-dash .mchl-settings-line button{background:none;border:0;color:var(--mchl-mechalol);cursor:pointer;font:inherit;white-space:nowrap;padding:0;}' +
		'#mchl-dash .mchl-settings-box{margin-top:8px;padding:8px;border:1px solid var(--mchl-line);border-radius:8px;}' +
		'#mchl-dash .mchl-settings-box .mchl-side-h{margin-top:6px;}' +
		'#mchl-dash .mchl-radio{display:block;margin:4px 0;cursor:pointer;line-height:1.35;}' +
		'#mchl-dash .mchl-hint{color:var(--mchl-text-3);font-size:11.5px;}' +
		'#mchl-dash .mchl-opt{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;color:var(--mchl-text-1);font:inherit;text-align:right;padding:4px 6px;border-radius:6px;cursor:pointer;}' +
		'#mchl-dash .mchl-opt:hover{background:var(--mchl-ink-700);}' +
		'#mchl-dash .mchl-opt.mchl-on{background:var(--mchl-ink-700);font-weight:700;box-shadow:inset -3px 0 0 var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-opt-sub{padding-inline-start:23px;color:var(--mchl-text-2);font-size:12.5px;}' +
		'#mchl-dash .mchl-dot-c{width:9px;height:9px;border-radius:50%;flex:none;}' +
		'#mchl-dash .mchl-n{margin-inline-start:auto;color:var(--mchl-text-3);font-size:12px;font-variant-numeric:tabular-nums;font-weight:400;}' +
		'#mchl-dash .mchl-seg{display:flex;border:1px solid var(--mchl-line);border-radius:8px;overflow:hidden;}' +
		'#mchl-dash .mchl-seg button{flex:1;background:none;border:0;border-inline-start:1px solid var(--mchl-line);color:var(--mchl-text-2);font:inherit;font-size:12.5px;padding:6px 4px;cursor:pointer;line-height:1.25;}' +
		'#mchl-dash .mchl-seg button:first-child{border-inline-start:0;}' +
		'#mchl-dash .mchl-seg button.mchl-on{background:var(--mchl-ink-700);color:var(--mchl-text-1);font-weight:700;}' +
		'#mchl-dash .mchl-seg .mchl-n{display:block;margin:1px 0 0;font-size:11px;}' +
		'#mchl-dash .mchl-tgroup{margin:2px 0;}' +
		'#mchl-dash .mchl-thead{display:flex;align-items:center;gap:6px;padding:3px 4px;}' +
		'#mchl-dash .mchl-thead label{font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;}' +
		'#mchl-dash .mchl-tg-toggle{background:none;border:0;color:var(--mchl-text-2);cursor:pointer;font-size:12px;padding:0 2px;}' +
		'#mchl-dash .mchl-titem{display:flex;align-items:center;gap:6px;padding:2px 4px 2px 4px;padding-inline-start:24px;cursor:pointer;font-size:13px;}' +
		'#mchl-dash .mchl-titem:hover,#mchl-dash .mchl-thead:hover{background:var(--mchl-ink-700);border-radius:6px;}' +
		'#mchl-dash .mchl-side input[type=checkbox],#mchl-dash .mchl-side input[type=radio]{accent-color:var(--mchl-mechalol);margin:0;}' +
		'#mchl-dash .mchl-check{display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;}' +
		'#mchl-dash .mchl-check .mchl-filter-number{width:90px;margin-inline-start:auto;}' +
		// תגיות המסננים הפעילים
		'#mchl-dash .mchl-chips{flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px;font-size:12.5px;}' +
		'#mchl-dash .mchl-chip{background:var(--mchl-ink-700);border:1px solid var(--mchl-line);border-radius:14px;padding:3px 10px;color:var(--mchl-text-1);font:inherit;font-size:12.5px;cursor:pointer;}' +
		'#mchl-dash .mchl-chip:hover{border-color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-chips-total{margin-inline-start:auto;color:var(--mchl-text-2);}' +
		// הטבלה
		'#mchl-dash .mchl-nowrap{white-space:nowrap;}' +
		'#mchl-dash .mchl-with-side .mchl-title{display:inline-block;min-width:11em;}' +
		'#mchl-dash .mchl-row-desc{color:var(--mchl-text-3);font-size:12px;margin-top:2px;}' +
		'#mchl-dash .mchl-update-note{padding:10px 16px;border-bottom:1px solid var(--mchl-line);}' +
		'#mchl-dash tr.mchl-upd-same{opacity:.55;}' +
		'#mchl-dash tr.mchl-upd-details-row td{background:var(--mchl-ink-900);}' +
		'#mchl-dash .mchl-upd-box{padding:10px 8px;}' +
		'#mchl-dash .mchl-upd-content{margin:6px 0 10px;}' +
		'#mchl-dash .mchl-upd-content-list{margin:6px 0;padding-right:20px;font-size:12.5px;}' +
		'#mchl-dash .mchl-upd-content-list mark{background:#D9B44A66;color:inherit;border-radius:2px;}' +
		'#mchl-dash .mchl-upd-conflict{border:1px solid var(--mchl-line);border-radius:8px;padding:10px;margin:10px 0;}' +
		'#mchl-dash .mchl-upd-cf-head{font-weight:600;margin-bottom:8px;}' +
		'#mchl-dash .mchl-upd-cf-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;}' +
		'#mchl-dash .mchl-upd-cf-title{color:var(--mchl-text-2);font-size:12px;margin-bottom:4px;}' +
		'#mchl-dash .mchl-upd-conflict pre{white-space:pre-wrap;word-break:break-word;background:var(--mchl-ink-900);color:var(--mchl-text-1);padding:8px;border-radius:6px;max-height:260px;overflow:auto;margin:0;font-family:inherit;font-size:12.5px;}' +
		'#mchl-dash .mchl-upd-conflict mark{background:#D9B44A66;color:inherit;border-radius:2px;}' +
		'#mchl-dash .mchl-upd-cf-choice{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;}' +
		'#mchl-dash .mchl-upd-cf-text{width:100%;min-height:130px;margin-top:8px;box-sizing:border-box;}' +
		'#mchl-dash .mchl-upd-merge{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px;}' +
		'#mchl-dash .mchl-upd-diffbox summary{cursor:pointer;color:var(--mchl-text-2);font-size:12.5px;}' +
		'#mchl-dash .mchl-upd-diff{max-height:420px;overflow:auto;padding:8px 4px;font-size:12.5px;}' +
		'#mchl-dash .mchl-upd-diff table.diff{width:100%;table-layout:fixed;border-collapse:collapse;}' +
		'#mchl-dash .mchl-upd-diff td{padding:2px 6px;vertical-align:top;white-space:pre-wrap;word-break:break-word;}' +
		'#mchl-dash .mchl-upd-diff td.diff-marker{width:1.6em;text-align:center;color:var(--mchl-text-3);}' +
		'#mchl-dash .mchl-upd-diff td.diff-lineno{color:var(--mchl-text-3);font-weight:600;padding-top:8px;}' +
		'#mchl-dash .mchl-upd-diff td.diff-context{color:var(--mchl-text-2);}' +
		'#mchl-dash .mchl-upd-diff td.diff-addedline{background:#5C968622;color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-upd-diff td.diff-deletedline{background:#C1634A22;color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-upd-diff ins.diffchange{background:#5C968666;text-decoration:none;}' +
		'#mchl-dash .mchl-upd-diff del.diffchange{background:#C1634A66;text-decoration:none;}' +
		'#mchl-dash .mchl-exists-now{color:#6FBF73;font-weight:700;cursor:help;}' +
		'#mchl-dash .mchl-req-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;}' +
		'#mchl-dash .mchl-req-head a{font-size:13px;text-decoration:none;}' +
		'#mchl-dash .mchl-req-panel{padding:12px 14px;background:var(--mchl-ink-800);border-radius:8px;}' +
		'#mchl-dash .mchl-req-section{max-height:360px;overflow:auto;display:flex;flex-direction:column;gap:6px;}' +
		'#mchl-dash .mchl-msg{background:var(--mchl-ink-700);border-radius:8px;padding:7px 11px;border-inline-start:3px solid var(--mchl-line);}' +
		'#mchl-dash .mchl-msg-text{font-size:14px;line-height:1.5;}' +
		'#mchl-dash .mchl-msg-meta{font-size:11.5px;color:var(--mchl-text-3);margin-top:2px;}' +
		'#mchl-dash .mchl-req-open{font-size:12.5px;}' +
		'#mchl-dash .mchl-req-reply{margin-top:10px;display:flex;flex-direction:column;gap:8px;}' +
		'#mchl-dash .mchl-req-reply textarea{width:100%;resize:vertical;font:inherit;}' +
		'#mchl-dash .mchl-req-reply-btns{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}' +
		'#mchl-dash .mchl-topic-cell{color:var(--mchl-text-2);font-size:12.5px;}' +
		'#mchl-dash .mchl-tag{font-size:11px;border:1px solid var(--mchl-line);border-radius:6px;padding:0 5px;color:var(--mchl-mechalol);white-space:nowrap;}' +
		'#mchl-dash tr.mchl-expandable{cursor:pointer;}' +
		'#mchl-dash tr.mchl-open > td{background:var(--mchl-ink-700);}' +
		'#mchl-dash .mchl-narrow-col{width:1%;}' +
		'#mchl-dash .mchl-expand-btn{background:none;border:1px solid var(--mchl-line);border-radius:6px;color:var(--mchl-text-2);cursor:pointer;width:26px;height:24px;line-height:1;}' +
		'#mchl-dash .mchl-import-btn{background:none;border:1px solid var(--mchl-line);border-radius:6px;color:var(--mchl-text-3);padding:3px 10px;font:inherit;font-size:12.5px;white-space:nowrap;}' +
		'#mchl-dash .mchl-import-btn:disabled{cursor:not-allowed;opacity:.6;}' +
		'#mchl-dash .mchl-import-btn:not(:disabled){cursor:pointer;color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-import-btn:not(:disabled):hover{border-color:var(--mchl-wiki);}' +
		'#mchl-dash input.mchl-filter-number{width:150px;}' +
		'#mchl-dash .mchl-clear-filters{background:none;border:none;color:var(--mchl-text-2);font-size:13px;cursor:pointer;text-decoration:underline;padding:0;}' +
		'#mchl-dash .mchl-spacer{flex:1;}' +
		'#mchl-dash .mchl-selection-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--mchl-mechalol-dim);border:1px solid var(--mchl-mechalol);border-radius:10px;padding:10px 16px;margin-bottom:12px;font-size:13.5px;}' +
		'#mchl-dash .mchl-selection-bar b{color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-selection-bar .mchl-grow{flex:1;}' +
		'#mchl-dash .mchl-selection-bar button,#mchl-dash .mchl-export-btn{background:var(--mchl-ink-700);border:1px solid var(--mchl-line);color:var(--mchl-text-1);padding:7px 14px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;}' +
		'#mchl-dash .mchl-select-all-matching{background:none;border:none;color:var(--mchl-mechalol);text-decoration:underline;cursor:pointer;font-size:13px;padding:0;}' +
		'#mchl-dash .mchl-table-wrap{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:12px;overflow:hidden;}' +
		'#mchl-dash table{width:100%;border-collapse:collapse;font-size:14px;}' +
		'#mchl-dash thead th{text-align:right;font-weight:600;color:var(--mchl-text-2);font-size:12.5px;padding:12px 14px;border-bottom:1px solid var(--mchl-line);background:var(--mchl-ink-700);}' +
		'#mchl-dash th.mchl-chk-col,#mchl-dash td.mchl-chk-col{width:36px;padding-left:4px;padding-right:14px;}' +
		'#mchl-dash tbody td{padding:11px 14px;border-bottom:1px solid var(--mchl-line);vertical-align:middle;}' +
		'#mchl-dash tbody tr:last-child td{border-bottom:none;}' +
		'#mchl-dash tbody tr:hover{background:#ffffff05;}' +
		'#mchl-dash tbody tr.mchl-selected{background:var(--mchl-mechalol-dim);}' +
		'#mchl-dash td.mchl-title a{text-decoration:none;font-weight:500;}' +
		'#mchl-dash td.mchl-title a:hover{text-decoration:underline;color:var(--mchl-mechalol);}' +
		'#mchl-dash input[type=checkbox]{width:16px;height:16px;accent-color:var(--mchl-mechalol);cursor:pointer;}' +
		'#mchl-dash .mchl-badge{display:inline-block;font-size:11.5px;padding:2px 9px;border-radius:20px;white-space:nowrap;}' +
		'#mchl-dash .mchl-badge.mchl-wiki{background:var(--mchl-wiki-dim);color:var(--mchl-wiki);}' +
		'#mchl-dash .mchl-badge.mchl-mechalol{background:var(--mchl-mechalol-dim);color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-badge.mchl-alert{background:var(--mchl-alert-dim);color:var(--mchl-alert);}' +
		'#mchl-dash .mchl-badge.mchl-neutral{background:var(--mchl-ink-700);color:var(--mchl-text-2);}' +
		'#mchl-dash .mchl-badge.mchl-review{background:#D9B44A26;color:#E3C15E;}' +
		'#mchl-dash .mchl-badge.mchl-review-high{background:#D98B3A2E;color:#EBA25A;}' +
		'#mchl-dash .mchl-badge.mchl-review-low{background:#A8A86026;color:#C2C27A;}' +
		'#mchl-dash .mchl-wf-meter{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:12px;padding:12px 16px;margin-bottom:12px;}' +
		'#mchl-dash .mchl-wf-meter-head{font-size:13px;color:var(--mchl-text-2);margin-bottom:8px;}' +
		'#mchl-dash .mchl-wf-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--mchl-ink-700);gap:2px;}' +
		'#mchl-dash .mchl-wf-seg{height:100%;cursor:pointer;min-width:0;}' +
		'#mchl-dash .mchl-wf-seg:hover{filter:brightness(1.2);}' +
		'#mchl-dash .mchl-wf-legends{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;}' +
		'#mchl-dash .mchl-wf-legend{background:none;border:1px solid transparent;border-radius:14px;color:var(--mchl-text-1);font-size:12.5px;padding:3px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}' +
		'#mchl-dash .mchl-wf-legend:hover,#mchl-dash .mchl-wf-legend.mchl-wf-active{border-color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-wf-dot{width:9px;height:9px;border-radius:50%;display:inline-block;}' +
		'#mchl-dash .mchl-wf-toggle{background:none;border:1px solid var(--mchl-line);color:var(--mchl-text-2);border-radius:6px;font-size:12px;padding:2px 8px;cursor:pointer;}' +
		'#mchl-dash tr.mchl-wf-details-row td{background:var(--mchl-ink-900);}' +
		'#mchl-dash .mchl-wf-box{font-size:13.5px;line-height:1.8;}' +
		'#mchl-dash .mchl-wf-group{margin:6px 0 10px;}' +
		'#mchl-dash .mchl-wf-group ul{margin:6px 18px 0 0;padding:0;}' +
		'#mchl-dash .mchl-wf-group li{margin-bottom:4px;}' +
		'#mchl-dash .mchl-wf-box mark{padding:0 3px;border-radius:3px;color:var(--mchl-ink-900);}' +
		'#mchl-dash .mchl-wf-box mark.mchl-wf-problem{background:#E07A62;}' +
		'#mchl-dash .mchl-wf-box mark.mchl-wf-review{background:#E3C15E;}' +
		'#mchl-dash .mchl-wf-box mark.mchl-wf-wording{background:#9FADAF;}' +
		'#mchl-dash .mchl-wf-box mark.mchl-wf-names{background:#C9B8E0;}' +
		'#mchl-dash .mchl-wf-ids{font-size:11px;}' +
		'#mchl-dash .mchl-wf-box mark.mchl-wf-hidden{background:none;color:inherit;outline:1px dashed #E3C15E;}' +
		'#mchl-dash .mchl-wf-code{font-size:12.5px;direction:rtl;unicode-bidi:plaintext;white-space:pre-wrap;}' +
		'#mchl-dash .mchl-wf-box a{color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-wf-fb{display:inline-flex;gap:3px;margin-right:6px;vertical-align:middle;}' +
		'#mchl-dash .mchl-wf-fb-btn{background:none;border:1px solid var(--mchl-line);color:var(--mchl-text-2);border-radius:5px;font-size:11px;line-height:1;padding:2px 5px;cursor:pointer;opacity:.55;}' +
		'#mchl-dash .mchl-wf-fb-btn:hover{opacity:1;}' +
		'#mchl-dash .mchl-wf-fb-btn.mchl-on-false{opacity:1;background:#5b2b22;border-color:#E07A62;color:#ffd2c7;}' +
		'#mchl-dash .mchl-wf-fb-btn.mchl-on-true{opacity:1;background:#27433a;border-color:#6fbf9f;color:#d4f3e6;}' +
		'#mchl-dash .mchl-wf-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}' +
		'#mchl-dash .mchl-wf-thumb{padding:0;border:1px solid var(--mchl-line);border-radius:6px;background:var(--mchl-ink-800);cursor:zoom-in;width:120px;height:90px;overflow:hidden;}' +
		'#mchl-dash .mchl-wf-thumb:hover{border-color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-wf-thumb img{width:100%;height:100%;object-fit:cover;display:block;}' +
		// המציג יושב ב-body (מחוץ ל-#mchl-dash), כדי ש-position:fixed יכסה את כל המסך.
		'.mchl-viewer{position:fixed;inset:0;z-index:10000;background:rgba(10,14,16,.94);display:none;align-items:center;justify-content:center;direction:rtl;font-family:inherit;}' +
		'.mchl-viewer-stage{position:absolute;inset:48px 64px 56px;display:flex;align-items:center;justify-content:center;}' +
		'.mchl-viewer-img{max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 4px 30px rgba(0,0,0,.5);background:#fff;}' +
		'.mchl-viewer-loading{position:absolute;color:#ccc;font-size:14px;display:none;}' +
		'.mchl-viewer.mchl-viewer-busy .mchl-viewer-loading{display:block;}' +
		'.mchl-viewer.mchl-viewer-busy .mchl-viewer-img{opacity:.35;}' +
		'.mchl-viewer-btn{position:absolute;z-index:1;background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:26px;line-height:44px;cursor:pointer;padding:0;}' +
		'.mchl-viewer-btn:hover{background:rgba(255,255,255,.25);}' +
		'.mchl-viewer-close{top:10px;left:12px;font-size:20px;}' +
		'.mchl-viewer-prev{right:12px;top:50%;margin-top:-22px;}' +
		'.mchl-viewer-next{left:12px;top:50%;margin-top:-22px;}' +
		'.mchl-viewer-caption{position:absolute;bottom:14px;left:60px;right:60px;text-align:center;color:#ddd;font-size:13.5px;}' +
		'.mchl-viewer-caption a{color:#9fd3c7;}' +
		'#mchl-dash .mchl-muted{color:var(--mchl-text-3);}' +
		'#mchl-dash .mchl-num-cell{font-variant-numeric:tabular-nums;color:var(--mchl-text-2);font-size:13px;}' +
		'#mchl-dash .mchl-pager{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;font-size:13px;color:var(--mchl-text-2);flex-wrap:wrap;gap:10px;}' +
		'#mchl-dash .mchl-pager .mchl-controls{display:flex;align-items:center;gap:8px;}' +
		'#mchl-dash .mchl-pager button{background:var(--mchl-ink-700);border:1px solid var(--mchl-line);color:var(--mchl-text-1);width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:14px;}' +
		'#mchl-dash .mchl-pager button:disabled{opacity:.35;cursor:default;}' +
		'#mchl-dash .mchl-state{padding:60px 20px;text-align:center;color:var(--mchl-text-2);}' +
		'#mchl-dash .mchl-state .mchl-big{font-family:"Frank Ruhl Libre",Georgia,serif;font-size:20px;color:var(--mchl-text-1);margin-bottom:6px;}' +
		'#mchl-dash .mchl-state.mchl-error{color:var(--mchl-alert);}' +
		'#mchl-dash .mchl-state pre{white-space:pre-wrap;text-align:right;background:var(--mchl-ink-700);padding:12px 14px;border-radius:8px;font-size:12.5px;color:var(--mchl-text-2);margin-top:14px;direction:ltr;}' +
		'#mchl-dash .mchl-skeleton{background:linear-gradient(90deg,var(--mchl-ink-700) 25%,#22394480 37%,var(--mchl-ink-700) 63%);background-size:400% 100%;animation:mchlShine 1.4s ease infinite;border-radius:6px;}' +
		'@keyframes mchlShine{0%{background-position:100% 0;}100%{background-position:0 0;}}' +
		'#mchl-dash footer.mchl-footer{margin-top:40px;text-align:center;font-size:12px;color:var(--mchl-text-3);}' +
		'#mchl-dash .mchl-culture-picker{display:flex;flex-wrap:wrap;gap:8px;padding:20px;}' +
		'#mchl-dash .mchl-culture-pill{background:var(--mchl-ink-700);border:1px solid var(--mchl-line);color:var(--mchl-text-1);padding:9px 14px;border-radius:20px;font-size:13.5px;cursor:pointer;display:flex;align-items:center;gap:8px;}' +
		'#mchl-dash .mchl-culture-pill:hover{border-color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-culture-pill .mchl-count{background:var(--mchl-ink-800);color:var(--mchl-text-2);padding:1px 8px;border-radius:20px;font-size:11.5px;}' +
		'@media (max-width:900px){#mchl-dash .mchl-body.mchl-with-side{grid-template-columns:1fr;}#mchl-dash .mchl-side{position:static;max-height:none;}}' +
		'@media (max-width:640px){' +
		'#mchl-dash .mchl-ledger-heads{flex-direction:column;gap:10px;}' +
		'#mchl-dash thead{display:none;}' +
		'#mchl-dash table,#mchl-dash tbody,#mchl-dash tr,#mchl-dash td{display:block;width:100%;}' +
		'#mchl-dash tbody tr{border-bottom:1px solid var(--mchl-line);padding:10px 4px;}' +
		'#mchl-dash tbody td{border:none;padding:4px 12px;display:flex;justify-content:space-between;gap:10px;}' +
		'#mchl-dash tbody td.mchl-chk-col{justify-content:flex-start;}' +
		'#mchl-dash tbody td::before{content:attr(data-label);color:var(--mchl-text-3);font-size:12px;}' +
		'}';

	var HTML = '' +
		'<header class="mchl-top">' +
		'<div class="mchl-top-title"><div class="mchl-h1">ויקיפדיה העברית <span class="mchl-arrow">↔</span> <span class="mchl-mch">המכלול</span></div>' +
		'<div class="mchl-sync-note" id="mchl-sync-note">נבדק לאחרונה —</div></div>' +
		'<div class="mchl-top-actions">' +
		'<button type="button" class="mchl-refresh" id="mchl-admin-toggle-btn" data-action="toggle-admin-panel" style="display:none;">⚙ ניהול</button>' +
		'<button type="button" class="mchl-refresh" id="mchl-refresh-btn" data-action="refresh"><span class="mchl-dot"></span> רענון</button></div>' +
		'</header>' +
		'<section class="mchl-admin-panel" id="mchl-admin-panel" style="display:none;">' +
		'<div class="mchl-eyebrow">פאנל ניהול - התחברות</div>' +
		'<div class="mchl-admin-row">' +
		'<input type="email" id="mchl-auth-email-input" class="mchl-search" placeholder="אימייל" autocomplete="off">' +
		'<input type="password" id="mchl-auth-password-input" class="mchl-search" placeholder="סיסמה" autocomplete="off">' +
		'<button type="button" class="mchl-export-btn" id="mchl-auth-login-btn" data-action="auth-login">התחברות</button>' +
		'</div>' +
		'<div class="mchl-muted" id="mchl-admin-status" style="font-size:12.5px;margin-top:8px;">טרם התחברת - כפתור נעילת הכותרות בטאב "חסר במכלול" יופיע רק אחרי התחברות מוצלחת.</div>' +
		'</section>' +
		'<nav class="mchl-tabs" id="mchl-tabs"></nav>' +
		'<div id="mchl-stats-area" style="display:none;">' +
		'<section class="mchl-ledger">' +
		'<div class="mchl-ledger-heads">' +
		'<div class="mchl-ledger-head mchl-wikih"><span class="mchl-label">ערכים בוויקיפדיה <span class="mchl-mini-spinner" id="mchl-spin-wiki"></span><span class="mchl-warn-inline" id="mchl-warn-wiki" style="display:none;">⚠</span></span><span class="mchl-num" id="mchl-stat-wiki-total">—</span></div>' +
		'<div class="mchl-ledger-head mchl-mechaloh" style="text-align:left;"><span class="mchl-label">ערכים במכלול <span class="mchl-mini-spinner" id="mchl-spin-mechalol"></span><span class="mchl-warn-inline" id="mchl-warn-mechalol" style="display:none;">⚠</span></span><span class="mchl-num" id="mchl-stat-mechalol-total">—</span></div>' +
		'</div>' +
		'<div class="mchl-bar" id="mchl-ledger-bar"><div class="mchl-seg mchl-matched" style="width:0%"></div><div class="mchl-seg mchl-tasks" style="width:0%"></div><div class="mchl-seg mchl-missing" style="width:0%"></div></div>' +
		'<div class="mchl-ledger-legend"><span class="mchl-item"><span class="mchl-swatch mchl-matched"></span> תואמים בין שני האתרים</span><span class="mchl-item"><span class="mchl-swatch mchl-tasks"></span> ממתינים לטיפול</span><span class="mchl-item"><span class="mchl-swatch mchl-missing"></span> חסרים במכלול לגמרי</span></div>' +
		'</section>' +
		'<section class="mchl-stat-cards">' +
		'<div class="mchl-stat-card"><div class="mchl-n" id="mchl-stat-tasks">—</div><div class="mchl-l"><span class="mchl-mini-spinner" id="mchl-spin-tasks"></span><span class="mchl-warn-inline" id="mchl-warn-tasks" style="display:none;">⚠</span>משימות לטיפול</div></div>' +
		'<div class="mchl-stat-card"><div class="mchl-n" id="mchl-stat-deleted">—</div><div class="mchl-l"><span class="mchl-mini-spinner" id="mchl-spin-deleted"></span><span class="mchl-warn-inline" id="mchl-warn-deleted" style="display:none;">⚠</span>חשוד כמחיקה מוויקיפדיה</div></div>' +
		'<div class="mchl-stat-card"><div class="mchl-n" id="mchl-stat-undoc">—</div><div class="mchl-l"><span class="mchl-mini-spinner" id="mchl-spin-undoc"></span><span class="mchl-warn-inline" id="mchl-warn-undoc" style="display:none;">⚠</span>מיובא ללא תיעוד</div></div>' +
		'<div class="mchl-stat-card"><div class="mchl-n" id="mchl-stat-missing">—</div><div class="mchl-l"><span class="mchl-mini-spinner" id="mchl-spin-missing"></span><span class="mchl-warn-inline" id="mchl-warn-missing" style="display:none;">⚠</span>חסרים במכלול</div></div>' +
		'</section>' +
		'</div>' +
		'<div class="mchl-body" id="mchl-body">' +
		'<aside class="mchl-side" id="mchl-side" style="display:none;"></aside>' +
		'<button type="button" class="mchl-side-rail" id="mchl-side-rail" data-action="toggle-side" title="הצגת המסננים">☰ מסננים</button>' +
		'<div class="mchl-main">' +
		'<div class="mchl-filter-bar" id="mchl-filter-bar">' +
		'<div class="mchl-search-wrap"><input class="mchl-search" id="mchl-search-input" placeholder="חיפוש בכותרת…"></div>' +
		'<div id="mchl-dynamic-filters" style="display:flex;gap:10px;flex-wrap:wrap;"></div>' +
		'<button type="button" class="mchl-clear-filters" id="mchl-clear-filters-btn" data-action="clear-filters" style="display:none;">נקה סינון</button>' +
		'<span class="mchl-spacer"></span>' +
		'<select class="mchl-page-size" id="mchl-page-size"><option value="25">25 בעמוד</option><option value="50" selected>50 בעמוד</option><option value="100">100 בעמוד</option><option value="250">250 בעמוד</option></select>' +
		'</div>' +
		'<div class="mchl-chips" id="mchl-chips" style="display:none;"></div>' +
		'<div class="mchl-selection-bar" id="mchl-selection-bar" style="display:none;">' +
		'<span><b id="mchl-selected-count">0</b> נבחרו</span>' +
		'<button type="button" class="mchl-select-all-matching" id="mchl-select-all-matching-btn" style="display:none;" data-action="select-all-matching"></button>' +
		'<span class="mchl-grow"></span>' +
		'<button type="button" class="mchl-export-btn" id="mchl-lock-titles-btn" style="display:none;" data-action="lock-titles">🔒 נעילת כותרות נבחרות</button>' +
		'<button type="button" class="mchl-export-btn" data-action="export" data-kind="csv">ייצוא CSV</button>' +
		'<button type="button" class="mchl-export-btn" data-action="export" data-kind="json">ייצוא JSON</button>' +
		'<button type="button" class="mchl-export-btn" data-action="export" data-kind="txt">ייצוא כותרות (טקסט)</button>' +
		'<button type="button" data-action="clear-selection">נקה בחירה</button>' +
		'</div>' +
		'<div class="mchl-wf-meter" id="mchl-wf-meter" style="display:none;"></div>' +
		'<div class="mchl-table-wrap"><div id="mchl-table-target"></div>' +
		'<div class="mchl-pager" id="mchl-pager" style="display:none;">' +
		'<span id="mchl-pager-summary"></span>' +
		'<div class="mchl-controls">' +
		'<button type="button" id="mchl-pg-first" data-action="goto" data-target="first">«</button>' +
		'<button type="button" id="mchl-pg-prev" data-action="goto" data-target="prev">‹</button>' +
		'<span id="mchl-pg-label"></span>' +
		'<button type="button" id="mchl-pg-next" data-action="goto" data-target="next">›</button>' +
		'<button type="button" id="mchl-pg-last" data-action="goto" data-target="last">»</button>' +
		'</div></div></div>' +
		'</div></div>' +
		'<footer class="mchl-footer">הנתונים מתעדכנים אוטומטית כל לילה (עדכון מצטבר) ובכל מוצאי שבת (סנכרון מלא)</footer>';

	function init() {
    	var groups = mw.config.get('wgUserGroups') || [];
    	var level = getLevel(groups);
    	userLevel = level;

    	if (level < 8) {
        $('#bodyContent').html('<div style="color: red; font-size: 18px; text-align: center; margin-top: 50px;">אין לך הרשאות לגשת לכלי זה.</div>');
        return;
    }
		mw.util.addCSS(CSS);
		var container = document.createElement('div');
		container.id = 'mchl-dash';
		container.innerHTML = HTML;
		var contentEl = document.getElementById('mw-content-text') || document.getElementById('bodyContent');
		if (!contentEl) return;
		contentEl.innerHTML = '';
		contentEl.appendChild(container);

		// פאנל הניהול (מפתח סרוויס + בעתיד עריכת התאמות ידניות) - הכפתור
		// שפותח אותו קיים ב-HTML הסטטי עם display:none, ורק כאן, לפי
		// level בפועל, הופך גלוי. זו עדיין רק בדיקת-נראות בצד הלקוח
		// (מי שבודק את קוד המקור/ה-DOM עם כלי מפתחים יראה את זה בכל
		// מקרה) - לא שכבת הגנה.
		if (level > ADMIN_LEVEL_THRESHOLD) {
			$id('mchl-admin-toggle-btn').style.display = 'inline-flex';
			restoreAuthSession();
		}

		wireEvents(container);
		buildTabs();
		applySiteNav();
		applySidePanel();
		if (VIEWS[activeTab] && VIEWS[activeTab].columns.indexOf('wikidata_desc') !== -1) $id('mchl-search-input').placeholder = 'חיפוש בכותרת או בתיאור ויקינתונים…';
		buildDynamicFilters();
		$id('mchl-search-input').addEventListener('input', function () {
			clearTimeout(searchDebounce);
			searchDebounce = setTimeout(function () { currentPage = 0; loadActiveView(); renderChips(); }, 550);
		});
		$id('mchl-page-size').addEventListener('change', onPageSizeChange);
		refreshAll();
	}

	mw.hook('wikipage.content').add(function () { init(); });
}());
