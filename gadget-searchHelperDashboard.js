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
		manual_match_action: 'שיוך ידני'
	};
	var VIEWS = {
		deleted: { view: 'report_possibly_deleted_source', label: 'חשוד כמחיקה', columns: ['title', 'status', 'source_type', 'match_type'], filters: [] },
		undoc: { view: 'report_undocumented_import', label: 'מיובא ללא תיעוד', columns: ['title', 'source_type', 'match_type', 'wikipedia_id'], filters: [] },
		// מאחד את שתי הקטגוריות למעלה (חשוד-כמחיקה, ללא-תיעוד) עם שתי
		// קטגוריות חדשות (2026-09): "בעיה בשם" (template_referenced_
		// title - יש תבנית מיון עם שם שלא נמצא בוויקיפדיה) ו"דף נעול"
		// (template_check_access_denied_at - בדיקת התבנית נדחתה, לרוב
		// כי הדף נעול-לקריאה). עמודת task_type מבחינה ביניהן.
		tasks: {
			view: 'report_tasks_to_handle', label: 'משימות לטיפול',
			columns: ['title', 'task_type', 'status', 'source_type', 'match_type'],
			filters: [{
				key: 'task_type', label: 'סוג משימה',
				options: ['לבדוק מחיקה/השוואה לוויקיפדיה', 'סטטוס לא ברור', 'שם בתבנית לא אומת מול ויקיפדיה', 'דף נעול - לא ניתן לאמת']
			}]
		},
		missing: { view: 'report_missing_from_mechalol', label: 'חסר במכלול', columns: ['title', 'created_at', 'mechalol_redirect_exists', 'checked_at', 'wikidata_desc'], filters: [] }
	};
	// טאב "דפים לטיפול - תרבות" - לא מבוסס Supabase כמו VIEWS למעלה,
	// אלא שליפה חיה מה-API של המכלול עצמו (רשימת חברי קטגוריה בלבד -
	// אין תוכן בדפים האלה מלבד תבנית הסיווג, אז אין טעם/צורך לשלוף
	// אותם דרך מסד הנתונים בכלל). ראו EXTRA_TABS, cultureState,
	// loadCultureSubcats/loadCultureMembers למטה.
	var EXTRA_TABS = { culture: { label: 'דפים לטיפול - תרבות' } };
	var CATEGORY_MAINTENANCE_CULTURE = 'קטגוריה:דפים לטיפול תרבות';
	// יחסי בכוונה, לא כתובת מלאה - הגאדג'ט רץ כבר בתוך הדומיין של
	// המכלול (בניגוד לקובץ dashboard.html העצמאי, שצריך כתובת מלאה +
	// origin=* ל-CORS). wgScriptPath מתאים את עצמו אוטומטית לכל
	// התקנת מדיה-ויקי, לא קבוע-קשיח.
	var MECHALOL_API = mw.config.get('wgScriptPath') + '/api.php';
	var STAT_DEFS = [
		{ key: 'wiki', table: 'wikipedia_pages', statId: 'mchl-stat-wiki-total', spinId: 'mchl-spin-wiki', warnId: 'mchl-warn-wiki', warnMsg: 'לא ניתן לקרוא את wikipedia_pages — יש לבדוק RLS/הרשאות.' },
		{ key: 'mechalol', table: 'mechalol_pages', statId: 'mchl-stat-mechalol-total', spinId: 'mchl-spin-mechalol', warnId: 'mchl-warn-mechalol', warnMsg: 'לא ניתן לקרוא את mechalol_pages — יש לבדוק RLS/הרשאות.' },
		{ key: 'tasks', table: 'report_tasks_to_handle', statId: 'mchl-stat-tasks', spinId: 'mchl-spin-tasks', warnId: 'mchl-warn-tasks', warnMsg: 'לא ניתן לקרוא את report_tasks_to_handle.', tabCount: 'mchl-tab-count-tasks' },
		{ key: 'deleted', table: 'report_possibly_deleted_source', statId: 'mchl-stat-deleted', spinId: 'mchl-spin-deleted', warnId: 'mchl-warn-deleted', warnMsg: 'לא ניתן לקרוא את report_possibly_deleted_source.', tabCount: 'mchl-tab-count-deleted' },
		{ key: 'undoc', table: 'report_undocumented_import', statId: 'mchl-stat-undoc', spinId: 'mchl-spin-undoc', warnId: 'mchl-warn-undoc', warnMsg: 'לא ניתן לקרוא את report_undocumented_import.', tabCount: 'mchl-tab-count-undoc' },
		{ key: 'missing', table: 'report_missing_from_mechalol', statId: 'mchl-stat-missing', spinId: 'mchl-spin-missing', warnId: 'mchl-warn-missing', warnMsg: 'לא ניתן לקרוא את report_missing_from_mechalol.', tabCount: 'mchl-tab-count-missing' }
	];

	// ===== מצב האפליקציה =====
	var wikidataCache = new Map();
	var wikidataInFlight = new Set();
	var activeTab = 'deleted';
	var currentPage = 0;
	var pageSize = 50;
	var totalRows = 0;
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
	function mechalolUrl(id) { return 'https://www.hamichlol.org.il/w/index.php?curid=' + id; }
	function wikipediaUrl(id) { return 'https://he.wikipedia.org/w/index.php?curid=' + id; }
	function mechalolEditUrl(title) { return 'https://www.hamichlol.org.il/w/index.php?title=' + encodeURIComponent(title.replace(/ /g, '_')) + '&action=edit'; }
	function rowKey(row) { return activeTab + ':' + row.id; }
	function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	var RETRY_ATTEMPTS = 3, RETRY_DELAY_MS = 900;
	function withRetry(fn, attempts) {
		attempts = attempts || RETRY_ATTEMPTS;
		var i = 0;
		function attempt() {
			i++;
			return fn().catch(function (e) {
				if (i < attempts) return sleep(RETRY_DELAY_MS * i).then(attempt);
				throw e;
			});
		}
		return attempt();
	}

	/*
	 * מזהה שגיאה "זמנית" (המסד באמצע עדכון תקופתי דו-שבועי - ראו
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
	function pgCount(table, rawFilterParams) {
		return withRetry(function () {
			var params = new URLSearchParams();
			params.set('select', 'id');
			if (rawFilterParams) rawFilterParams.forEach(function (pair) { params.append(pair[0], pair[1]); });
			var url = SUPABASE_URL + '/rest/v1/' + table + '?' + params.toString();
			return fetch(url, { headers: pgHeaders({ Range: '0-0', Prefer: 'count=exact' }) }).then(function (res) {
				if (!res.ok) return res.text().then(function (t) { throw makePgError(res.status, t); });
				var cr = res.headers.get('Content-Range') || '';
				var total = parseInt(cr.split('/')[1], 10);
				return isNaN(total) ? 0 : total;
			});
		});
	}

	// שליפת דף עם נתונים + ספירה מדויקת מקבילה - למסכי הטבלה, לייצוא,
	// ול"בחר את כל התוצאות התואמות".
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
				return res.json().then(function (data) { return { data: data, count: isNaN(total) ? data.length : total }; });
			});
		});
	}

	// בונה את רשימת פרמטרי הסינון (כזוגות [שם, ערך], כדי לתמוך במפתחות
	// חוזרים כמו 'or') מתוך activeFilters + חיפוש חופשי, בדיוק כמו
	// buildQuery() בגרסת ה-HTML המקורית.
	function buildFilterParams() {
		var cfg = VIEWS[activeTab];
		var out = [];
		var search = ($id('mchl-search-input').value || '').trim();
		if (search) {
			var safe = search.replace(/,/g, '');
			if (cfg.columns.indexOf('wikidata_desc') !== -1) {
				out.push(['or', '(title.ilike.%' + safe + '%,wikidata_desc.ilike.%' + safe + '%)']);
			} else {
				out.push(['title', 'ilike.%' + safe + '%']);
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
		if (activeTab !== 'missing') return;
		currentPageRows.forEach(function (r) {
			if (r.wikidata_desc !== null && r.wikidata_desc !== undefined && !wikidataCache.has(r.title)) {
				wikidataCache.set(r.title, r.wikidata_desc);
			}
		});
		var need = currentPageRows.map(function (r) { return r.title; }).filter(function (t) { return !wikidataCache.has(t) && !wikidataInFlight.has(t); });
		if (need.length === 0) { paintWikidataDescriptions(); return; }
		fetchWikidataDescriptions(need);
	}

	// ===== בניית הממשק =====
	function buildTabs() {
		var nav = $id('mchl-tabs');
		nav.innerHTML = '';
		var allKeys = Object.keys(VIEWS).concat(Object.keys(EXTRA_TABS));
		allKeys.forEach(function (key) {
			var v = VIEWS[key] || EXTRA_TABS[key];
			var btn = document.createElement('button');
			btn.className = 'mchl-tab' + (key === activeTab ? ' mchl-active' : '');
			btn.id = 'mchl-tab-' + key;
			btn.type = 'button';
			var countHtml = VIEWS[key] ? '<span class="mchl-count" id="mchl-tab-count-' + key + '">–</span>' : '';
			btn.innerHTML = countHtml + escapeHtml(v.label);
			btn.addEventListener('click', function () { switchTab(key); });
			nav.appendChild(btn);
		});
	}

	function switchTab(key) {
		activeTab = key;
		currentPage = 0;
		activeFilters = {};
		selectedRows.clear();
		document.querySelectorAll('#mchl-dash .mchl-tab').forEach(function (t) { t.classList.remove('mchl-active'); });
		$id('mchl-tab-' + key).classList.add('mchl-active');
		updateSelectionBar();
		if (EXTRA_TABS[key]) {
			$id('mchl-filter-bar').style.display = 'none';
			$id('mchl-pager').style.display = 'none';
			loadCultureTab();
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
			});
		});
	}

	function loadCultureTab() {
		cultureState.selected = null;
		var target = $id('mchl-table-target');
		if (cultureState.subcats) { renderCulturePicker(); return; }
		target.innerHTML = skeletonRows();
		mwApiFetch({
			action: 'query', generator: 'categorymembers',
			gcmtitle: CATEGORY_MAINTENANCE_CULTURE, gcmtype: 'subcat', gcmlimit: '50',
			prop: 'categoryinfo'
		}).then(function (data) {
			var pages = (data.query && data.query.pages) || [];
			cultureState.subcats = pages.map(function (p) {
				return { title: p.title, count: (p.categoryinfo && p.categoryinfo.pages) || 0 };
			}).sort(function (a, b) { return a.title.localeCompare(b.title, 'he'); });
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
		mwApiFetch(params).then(function (data) {
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
		if (activeTab === 'missing') buildEasyImportFilters(host);
		toggleClearFiltersBtn();
	}

	function buildEasyImportFilters(host) {
		var lenInput = document.createElement('input');
		lenInput.type = 'number'; lenInput.min = '0';
		lenInput.className = 'mchl-filter-number'; lenInput.id = 'mchl-filter-easy-length';
		lenInput.placeholder = "אורך מקס' (בתים)";
		lenInput.addEventListener('input', function () {
			var raw = lenInput.value.trim();
			if (raw === '' || isNaN(Number(raw))) delete activeFilters.easy_import_length;
			else activeFilters.easy_import_length = { op: 'lte', value: Number(raw) };
			currentPage = 0; loadActiveView(); toggleClearFiltersBtn();
		});
		host.appendChild(lenInput);

		var imgSel = document.createElement('select');
		imgSel.className = 'mchl-filter-select'; imgSel.id = 'mchl-filter-easy-images';
		imgSel.innerHTML = '<option value="">תמונות — הכול</option><option value="no_images">בלי תמונות</option>';
		imgSel.addEventListener('change', function () {
			if (imgSel.value === 'no_images') activeFilters.easy_import_has_images = { op: 'eq', value: false };
			else delete activeFilters.easy_import_has_images;
			currentPage = 0; loadActiveView(); toggleClearFiltersBtn();
		});
		host.appendChild(imgSel);

		var cleanSel = document.createElement('select');
		cleanSel.className = 'mchl-filter-select'; cleanSel.id = 'mchl-filter-clean';
		cleanSel.innerHTML = '<option value="yes">ללא בעיות צניעות</option><option value="no">כולל בעיות צניעות אפשריות</option>';
		cleanSel.value = 'yes';
		activeFilters.problematic_words_clean = { op: 'eq', value: true };
		cleanSel.addEventListener('change', function () {
			if (cleanSel.value === 'yes') activeFilters.problematic_words_clean = { op: 'eq', value: true };
			else delete activeFilters.problematic_words_clean;
			currentPage = 0; loadActiveView(); toggleClearFiltersBtn();
		});
		host.appendChild(cleanSel);

		var ageSel = document.createElement('select');
		ageSel.className = 'mchl-filter-select'; ageSel.id = 'mchl-filter-age';
		ageSel.innerHTML = '<option value="exclude">ללא ערכים חדשים (שבועיים אחרונים)</option><option value="include">כולל ערכים חדשים</option>';
		ageSel.value = 'exclude';
		activeFilters.created_at = { op: 'lt', value: newArticleCutoffIso() };
		ageSel.addEventListener('change', function () {
			if (ageSel.value === 'exclude') activeFilters.created_at = { op: 'lt', value: newArticleCutoffIso() };
			else delete activeFilters.created_at;
			currentPage = 0; loadActiveView(); toggleClearFiltersBtn();
		});
		host.appendChild(ageSel);

		var redirectSel = document.createElement('select');
		redirectSel.className = 'mchl-filter-select'; redirectSel.id = 'mchl-filter-redirect-status';
		redirectSel.innerHTML = '<option value="all">כל הסטטוסים (הפניה/לא קיים/טרם נבדק)</option>' +
			'<option value="redirect">רק קיימות כהפניה במכלול</option>' +
			'<option value="absent">רק נבדקו ואין בכלל</option>' +
			'<option value="unchecked">רק טרם נבדקו</option>';
		redirectSel.value = 'all';
		redirectSel.addEventListener('change', function () {
			if (redirectSel.value === 'redirect') activeFilters.mechalol_redirect_exists = { op: 'eq', value: true };
			else if (redirectSel.value === 'absent') activeFilters.mechalol_redirect_exists = { op: 'eq', value: false };
			else if (redirectSel.value === 'unchecked') activeFilters.mechalol_redirect_exists = { op: 'is', value: 'null' };
			else delete activeFilters.mechalol_redirect_exists;
			currentPage = 0; loadActiveView(); toggleClearFiltersBtn();
		});
		host.appendChild(redirectSel);
	}

	function toggleClearFiltersBtn() {
		var hasFilters = Object.keys(activeFilters).length > 0 || $id('mchl-search-input').value.trim().length > 0;
		$id('mchl-clear-filters-btn').style.display = hasFilters ? 'inline' : 'none';
	}

	function clearFilters() {
		activeFilters = {};
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
		if (EXTRA_TABS[activeTab]) {
			cultureState.subcats = null; // כפתור רענון אמור לשלוף מחדש, לא להסתפק במטמון
			return Promise.resolve(loadCultureTab());
		}
		return loadActiveView();
	}

	function refreshAll() {
		var btn = $id('mchl-refresh-btn');
		btn.classList.add('mchl-spinning');
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
			var params = new URLSearchParams();
			params.set('select', 'checked_at');
			params.set('order', 'checked_at.desc');
			var url = SUPABASE_URL + '/rest/v1/wikipedia_pages?' + params.toString();
			return fetch(url, { headers: pgHeaders({ Range: '0-0' }) }).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			}).then(function (data) {
				return (data && data.length) ? data[0].checked_at : null;
			});
		});
	}

	function loadStats() {
		STAT_DEFS.forEach(function (d) {
			$id(d.spinId).style.display = 'inline-block';
			$id(d.warnId).style.display = 'none';
		});
		var statValues = {};
		var jobs = STAT_DEFS.map(function (d) {
			return pgCount(d.table).then(function (val) {
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
		});
		var matchedJob = pgCount('mechalol_pages', [['wikipedia_id', 'not.is.null']]).catch(function () { return null; });
		return Promise.all([matchedJob].concat(jobs)).then(function (results) {
			var matched = results[0];
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
		return pgSelect(cfg.view, { filterParams: buildFilterParams(), order: 'title.asc', from: from, to: to }).then(function (res) {
			if (myRequestId !== loadRequestId) return;
			currentPageRows = res.data || [];
			totalRows = res.count || 0;
			totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
			renderTable();
			renderPager();
			loadWikidataDescriptionsForCurrentPage();
		}).catch(function (e) {
			if (myRequestId !== loadRequestId) return;
			// אם זו שגיאה שנראית כמו חלון העדכון הדו-שבועי ועוד לא ניסינו
			// ניסיון-נוסף מושהה - מחכים עוד קצת (מעבר לשלוש הניסיונות
			// המהירות של withRetry) לפני שמציגים למשתמש הודעת שגיאה בכלל.
			// חלון ה-swap עצמו קצר מאוד (lock_timeout של כמה שניות לכל
			// היותר) - סביר שהניסיון הזה יצליח בשקט, בלי שהמשתמש בכלל
			// יבחין שהיה עיכוב.
			if (!isAutoRetry && isTransientMaintenanceError(e)) {
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
			// חלון העדכון הדו-שבועי - לא באג, לא תקלה. אין ערך למשתמש
			// בפרטים הטכניים (SQLSTATE/PGRST וכו') - רק הודעה ברורה ודרך
			// להמשיך הלאה.
			$id('mchl-table-target').innerHTML =
				'<div class="mchl-state"><div class="mchl-big">המסד באמצע עדכון תקופתי</div>' +
				'<div>זה קורה פעם בשבועיים ונמשך בדרך כלל שניות בודדות. הנתונים יחזרו להיות זמינים מיד עם סיום העדכון.</div>' +
				'<button type="button" class="mchl-refresh" data-action="retry" style="margin:16px auto 0;"><span class="mchl-dot"></span> ניסיון נוסף</button></div>';
			return;
		}
		$id('mchl-table-target').innerHTML =
			'<div class="mchl-state mchl-error"><div class="mchl-big">שגיאה בטעינת הנתונים</div>' +
			'<div>נכשלו כמה ניסיונות חיבור ברצף. יש לבדוק חסימת CSP, ואת ה-RLS/הרשאות הקריאה על הטבלאות והתצוגות.</div>' +
			'<pre>' + escapeHtml(e && e.message ? e.message : JSON.stringify(e)) + '</pre>' +
			'<button type="button" class="mchl-refresh" data-action="retry" style="margin:16px auto 0;"><span class="mchl-dot"></span> ניסיון נוסף</button></div>';
	}

	function effectiveColumns(cfg) {
		// עמודת השיוך הידני מתווספת רק בטאב "משימות לטיפול", ורק כש-
		// יש חיבור פעיל - לא כל מבקר בטאב הזה אמור לראות אותה בכלל.
		if (activeTab === 'tasks' && serviceKeyConnected) {
			return cfg.columns.concat(['manual_match_action']);
		}
		return cfg.columns;
	}

	function renderTable() {
		var cfg = VIEWS[activeTab];
		var columns = effectiveColumns(cfg);
		if (currentPageRows.length === 0) {
			$id('mchl-table-target').innerHTML = '<div class="mchl-state"><div class="mchl-big">אין תוצאות</div>אין שורות התואמות לסינון הנוכחי.</div>';
			return;
		}
		var allOnPageSelected = currentPageRows.every(function (r) { return selectedRows.has(rowKey(r)); });
		var thead = '<tr><th class="mchl-chk-col"><input type="checkbox" data-action="toggle-page-selection" ' + (allOnPageSelected ? 'checked' : '') + '></th>' +
			columns.map(function (c) { return '<th>' + escapeHtml(COLUMN_LABELS[c] || c) + '</th>'; }).join('') + '</tr>';
		var tbody = currentPageRows.map(function (r) {
			var selected = selectedRows.has(rowKey(r));
			return '<tr class="' + (selected ? 'mchl-selected' : '') + '">' +
				'<td class="mchl-chk-col" data-label=""><input type="checkbox" data-action="toggle-row-selection" data-row-id="' + r.id + '" ' + (selected ? 'checked' : '') + '></td>' +
				columns.map(function (c) { return '<td data-label="' + escapeHtml(COLUMN_LABELS[c] || c) + '">' + renderCell(c, r) + '</td>'; }).join('') + '</tr>';
		}).join('');
		$id('mchl-table-target').innerHTML = '<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
	}

	function renderCell(col, row) {
		var val = row[col];
		if (col === 'title') {
			var url = VIEWS[activeTab].view === 'report_missing_from_mechalol' ? mechalolEditUrl(val) : mechalolUrl(row.id);
			return '<span class="mchl-title"><a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(val) + '</a></span>';
		}
		if (col === 'wikipedia_id') return val ? '<a href="' + wikipediaUrl(val) + '" target="_blank" rel="noopener" class="mchl-num-cell">' + val + '</a>' : '<span class="mchl-muted">—</span>';
		if (col === 'source_type') return '<span class="mchl-badge mchl-neutral">' + escapeHtml(SOURCE_TYPE_LABELS[val] || val) + '</span>';
		if (col === 'match_type') return '<span class="mchl-badge ' + (val === 'ללא התאמה' ? 'mchl-alert' : 'mchl-wiki') + '">' + escapeHtml(val) + '</span>';
		if (col === 'status') return '<span class="mchl-badge mchl-neutral">' + escapeHtml(val) + '</span>';
		if (col === 'task_type') return '<span class="mchl-badge mchl-alert">' + escapeHtml(val) + '</span>';
		if (col === 'manual_match_action') {
			return '<span class="mchl-manual-match-cell" data-mechalol-id="' + row.id + '">' +
				'<input type="text" class="mchl-search mchl-manual-match-input" placeholder="כותרת ויקיפדית מדויקת">' +
				'<button type="button" class="mchl-export-btn" data-action="assign-manual-match" data-mechalol-id="' + row.id + '">שייך</button>' +
				'</span>';
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
		return escapeHtml(val == null ? '—' : val);
	}

	function renderPager() {
		var pager = $id('mchl-pager');
		pager.style.display = 'flex';
		var from = totalRows === 0 ? 0 : currentPage * pageSize + 1;
		var to = Math.min(totalRows, (currentPage + 1) * pageSize);
		$id('mchl-pager-summary').textContent = 'מציג ' + from.toLocaleString('he-IL') + '–' + to.toLocaleString('he-IL') + ' מתוך ' + totalRows.toLocaleString('he-IL');
		$id('mchl-pg-label').textContent = 'עמוד ' + (currentPage + 1).toLocaleString('he-IL') + ' מתוך ' + totalPages.toLocaleString('he-IL');
		$id('mchl-pg-first').disabled = currentPage === 0;
		$id('mchl-pg-prev').disabled = currentPage === 0;
		$id('mchl-pg-next').disabled = currentPage >= totalPages - 1;
		$id('mchl-pg-last').disabled = currentPage >= totalPages - 1;
	}

	function goPage(p) {
		if (p < 0 || p > totalPages - 1) return;
		currentPage = p;
		loadActiveView();
	}

	function toggleRowSelection(id, checked) {
		var row = currentPageRows.find(function (r) { return r.id === id; });
		if (!row) return;
		var key = rowKey(row);
		if (checked) selectedRows.set(key, row); else selectedRows.delete(key);
		updateSelectionBar();
		renderTable();
	}
	function togglePageSelection(checked) {
		currentPageRows.forEach(function (r) {
			var key = rowKey(r);
			if (checked) selectedRows.set(key, r); else selectedRows.delete(key);
		});
		updateSelectionBar();
		renderTable();
	}
	function clearSelection() { selectedRows.clear(); updateSelectionBar(); renderTable(); }

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
		lockBtn.style.display = (n > 0 && activeTab === 'missing' && serviceKeyConnected) ? 'inline' : 'none';
	}

	function selectAllMatching() {
		var btn = $id('mchl-select-all-matching-btn');
		var originalText = btn.textContent;
		btn.disabled = true;
		btn.textContent = 'טוען…';
		var cfg = VIEWS[activeTab];
		return pgSelect(cfg.view, { filterParams: buildFilterParams(), order: 'title.asc', from: 0, to: Math.min(totalRows, 20000) - 1 }).then(function (res) {
			(res.data || []).forEach(function (r) { selectedRows.set(rowKey(r), r); });
			updateSelectionBar();
			renderTable();
		}).catch(function (e) {
			btn.disabled = false;
			btn.textContent = originalText;
			alert(isTransientMaintenanceError(e)
				? 'המסד באמצע עדכון תקופתי כרגע - נסה שוב בעוד רגע.'
				: 'שגיאה בטעינת כל התוצאות, גם אחרי כמה ניסיונות:\n' + (e.message || e) + '\n\nניתן לנסות שוב.');
		});
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
		return pgSelect(cfg.view, { filterParams: buildFilterParams(), order: 'title.asc', from: 0, to: Math.min(totalRows, 20000) - 1 }).then(function (res) {
			return res.data || [];
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
			if (cfg.columns.indexOf('wikidata_desc') !== -1) {
				rows.forEach(function (r) {
					var v = wikidataCache.get(r.title);
					r.wikidata_desc = (v === null || v === undefined) ? '' : v;
				});
			}
			var stamp = new Date().toISOString().slice(0, 10);
			var base = cfg.label + '_' + stamp;
			if (kind === 'txt') { download(base + '.txt', rows.map(function (r) { return r.title; }).join('\n'), 'text/plain'); return; }
			if (kind === 'json') {
				var clean = rows.map(function (r) { var o = {}; cfg.columns.forEach(function (c) { o[c] = r[c]; }); o.id = r.id; return o; });
				download(base + '.json', JSON.stringify(clean, null, 2), 'application/json');
				return;
			}
			if (kind === 'csv') {
				var headers = ['id'].concat(cfg.columns);
				var escapeCsv = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
				var lines = [headers.map(function (h) { return escapeCsv(COLUMN_LABELS[h] || h); }).join(',')];
				rows.forEach(function (r) { lines.push(headers.map(function (h) { return escapeCsv(r[h]); }).join(',')); });
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
	// ורק בטאב "משימות לטיפול" (ראו effectiveColumns) =====
	function assignManualMatch(btn) {
		var mechalolId = parseInt(btn.getAttribute('data-mechalol-id'), 10);
		var cell = btn.closest('.mchl-manual-match-cell');
		var input = cell.querySelector('.mchl-manual-match-input');
		var wikiTitle = (input.value || '').trim();

		if (!wikiTitle) {
			input.placeholder = 'יש להזין כותרת';
			return;
		}

		btn.disabled = true;
		input.disabled = true;
		var originalText = btn.textContent;
		btn.textContent = 'מחפש…';

		// שלב 1: איתור ה-id של הכותרת הוויקיפדית - קריאה ציבורית רגילה
		// (anon), לא דורשת התחברות - wikipedia_pages כבר קריא לכולם.
		var params = new URLSearchParams();
		params.set('select', 'id');
		params.set('title', 'eq.' + wikiTitle);
		fetch(SUPABASE_URL + '/rest/v1/wikipedia_pages?' + params.toString(), {
			headers: pgHeaders({ Range: '0-0' })
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		}).then(function (rows) {
			if (!rows || rows.length === 0) {
				throw new Error('לא נמצאה כותרת "' + wikiTitle + '" בדיוק ב-wikipedia_pages');
			}
			var wikipediaId = rows[0].id;
			btn.textContent = 'משייך…';

			// שלב 2: הכתיבה עצמה ל-manual_matches - כאן כן דורש את הטוקן
			// של המשתמש המחובר (authHeaders), לא מפתח ה-anon.
			return fetch(SUPABASE_URL + '/rest/v1/manual_matches', {
				method: 'POST',
				headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
				body: JSON.stringify({ mechalol_page_id: mechalolId, wikipedia_page_id: wikipediaId })
			});
		}).then(function (res) {
			if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t); });
			cell.innerHTML = '<span class="mchl-badge mchl-wiki">✓ שויך ל-"' + escapeHtml(wikiTitle) + '"</span>' +
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
			// אם כבר נמצאים בטאב "משימות לטיפול" - מרעננים את הטבלה מיד
			// כדי שעמודת השיוך הידני תופיע בלי לחכות למעבר טאב.
			if (activeTab === 'tasks') renderTable();
			// נסגר לבד אחרי שהמחוון הראה הצלחה לרגע - לא נשאר פתוח סתם.
			sleep(1200).then(function () { $id('mchl-admin-panel').style.display = 'none'; });
		}).catch(function () {
			btn.disabled = false;
			serviceKeyConnected = false;
			statusEl.textContent = 'שגיאת רשת בהתחברות - נסה שוב.';
			statusEl.className = 'mchl-muted mchl-alert';
			updateSelectionBar();
		});
	}

	// בדיקה בטעינת הדף אם כבר יש סשן שמור מקודם באותו טאב (sessionStorage
	// לא מאומת מחדש מול השרת כאן - רק "יש טוקן שמור, נניח שהוא תקף";
	// אם הוא פג-תוקף, הקריאה הראשונה שתשתמש בו פשוט תיכשל, בלי מנגנון
	// ריענון (refresh_token) בשלב הזה).
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
			if (!el) return;
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
			else if (action === 'toggle-admin-panel') toggleAdminPanel();
			else if (action === 'auth-login') authLogin();
			else if (action === 'goto') {
				var target = el.getAttribute('data-target');
				if (target === 'first') goPage(0);
				else if (target === 'prev') goPage(currentPage - 1);
				else if (target === 'next') goPage(currentPage + 1);
				else if (target === 'last') goPage(totalPages - 1);
			}
		});
		root.addEventListener('change', function (e) {
			var el = e.target;
			if (el.matches('[data-action="toggle-page-selection"]')) togglePageSelection(el.checked);
			else if (el.matches('[data-action="toggle-row-selection"]')) toggleRowSelection(parseInt(el.getAttribute('data-row-id'), 10), el.checked);
		});
	}
	
	   function getLevel(groups) {
        const levels = {
          sysop: 20, bot: 18, aspaklarya2: 16, aspaklaryaEditor: 14,
          patroller: 12, wikiupdate: 10, wikimport: 8
        };
        return Math.max(...groups.map(g => levels[g] || 0), 0);
      }

	// דרגת ההרשאה הנדרשת כדי לראות את פאנל הניהול בכלל (מפתח סרוויס +
	// עריכת התאמות ידניות בעתיד) - מעל sysop(20) ו-bot(18) בלבד. זו רק
	// בדיקת-נראות בצד הלקוח (UX, "מי בכלל אמור לראות את זה") - היא
	// *לא* שכבת אבטחה: כל מי שפותח כלי מפתחים יכול לעקוף אותה. ההגנה
	// האמיתית (אם/כשתיבנה) חייבת לבוא מהמסד עצמו, לא מכאן.
	var ADMIN_LEVEL_THRESHOLD = 17;
	// ===== CSS מוגבל תחת #mchl-dash בלבד =====
	var CSS = '' +
		'#mchl-dash{--mchl-ink-900:#0F1B22;--mchl-ink-800:#16262F;--mchl-ink-700:#1E323C;' +
		'--mchl-wiki:#5C9686;--mchl-wiki-dim:#5C968633;--mchl-mechalol:#C79449;--mchl-mechalol-dim:#C7944933;' +
		'--mchl-alert:#C1634A;--mchl-alert-dim:#C1634A26;--mchl-text-1:#EDEAE1;--mchl-text-2:#9FADAF;' +
		'--mchl-text-3:#657679;--mchl-line:rgba(237,234,225,0.10);' +
		'background:var(--mchl-ink-900);color:var(--mchl-text-1);font-family:Assistant,Arial,sans-serif;' +
		'font-feature-settings:"tnum" 1;direction:rtl;max-width:1220px;margin:0 auto;padding:32px 24px 80px;}' +
		'#mchl-dash *{box-sizing:border-box;}' +
		'#mchl-dash a{color:inherit;}' +
		'#mchl-dash header.mchl-top{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:16px;margin-bottom:28px;}' +
		'#mchl-dash .mchl-eyebrow{font-size:13px;letter-spacing:.04em;color:var(--mchl-text-2);margin:0 0 6px;}' +
		'#mchl-dash h1.mchl-h1{font-family:"Frank Ruhl Libre",Georgia,serif;font-weight:700;font-size:clamp(26px,4vw,38px);margin:0;line-height:1.15;}' +
		'#mchl-dash h1.mchl-h1 span{color:var(--mchl-mechalol);}' +
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
		'#mchl-dash .mchl-manual-match-cell{display:flex;gap:6px;align-items:center;white-space:nowrap;}' +
		'#mchl-dash .mchl-manual-match-cell input{width:150px;padding:6px 8px;font-size:12.5px;}' +
		'#mchl-dash .mchl-manual-match-cell button{padding:6px 10px;font-size:12px;white-space:nowrap;}' +
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
		'#mchl-dash .mchl-tabs{display:flex;gap:6px;border-bottom:1px solid var(--mchl-line);margin-bottom:18px;overflow-x:auto;}' +
		'#mchl-dash .mchl-tab{background:none;border:none;color:var(--mchl-text-2);font-size:14.5px;font-weight:600;padding:10px 4px;cursor:pointer;position:relative;white-space:nowrap;margin-left:22px;}' +
		'#mchl-dash .mchl-tab .mchl-count{display:inline-block;margin-right:6px;font-size:11.5px;background:var(--mchl-ink-700);color:var(--mchl-text-2);padding:1px 7px;border-radius:20px;}' +
		'#mchl-dash .mchl-tab.mchl-active{color:var(--mchl-text-1);}' +
		'#mchl-dash .mchl-tab.mchl-active .mchl-count{background:var(--mchl-mechalol-dim);color:var(--mchl-mechalol);}' +
		'#mchl-dash .mchl-tab.mchl-active::after{content:"";position:absolute;bottom:-1px;right:0;left:0;height:2px;background:var(--mchl-mechalol);border-radius:2px;}' +
		'#mchl-dash .mchl-filter-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px;}' +
		'#mchl-dash .mchl-search-wrap{position:relative;flex:1;min-width:200px;max-width:320px;}' +
		'#mchl-dash input.mchl-search,#mchl-dash select.mchl-filter-select,#mchl-dash select.mchl-page-size,#mchl-dash input.mchl-filter-number{background:var(--mchl-ink-800);border:1px solid var(--mchl-line);border-radius:8px;color:var(--mchl-text-1);padding:9px 12px;font-size:13.5px;}' +
		'#mchl-dash input.mchl-search{width:100%;}' +
		'#mchl-dash select.mchl-filter-select{cursor:pointer;}' +
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
		'<div><p class="mchl-eyebrow">מסד הנתונים · השוואת ערכים</p><h1 class="mchl-h1">ויקיפדיה העברית <span>↔</span> <span>המכלול</span></h1></div>' +
		'<div class="mchl-top-actions"><span class="mchl-sync-note" id="mchl-sync-note">נבדק לאחרונה —</span>' +
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
		'<nav class="mchl-tabs" id="mchl-tabs"></nav>' +
		'<div class="mchl-filter-bar" id="mchl-filter-bar">' +
		'<div class="mchl-search-wrap"><input class="mchl-search" id="mchl-search-input" placeholder="חיפוש בכותרת…"></div>' +
		'<div id="mchl-dynamic-filters" style="display:flex;gap:10px;flex-wrap:wrap;"></div>' +
		'<button type="button" class="mchl-clear-filters" id="mchl-clear-filters-btn" data-action="clear-filters" style="display:none;">נקה סינון</button>' +
		'<span class="mchl-spacer"></span>' +
		'<select class="mchl-page-size" id="mchl-page-size"><option value="25">25 בעמוד</option><option value="50" selected>50 בעמוד</option><option value="100">100 בעמוד</option><option value="250">250 בעמוד</option></select>' +
		'</div>' +
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
		'<footer class="mchl-footer">הנתונים מתעדכנים אוטומטית כל לילה (עדכון מצטבר) ובכל מוצאי שבת (סנכרון מלא)</footer>';

	function init() {
    	var groups = mw.config.get('wgUserGroups') || [];
    	var level = getLevel(groups);

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
		buildDynamicFilters();
		$id('mchl-search-input').addEventListener('input', function () {
			clearTimeout(searchDebounce);
			searchDebounce = setTimeout(function () { currentPage = 0; loadActiveView(); }, 550);
		});
		$id('mchl-page-size').addEventListener('change', onPageSizeChange);
		refreshAll();
	}

	mw.hook('wikipage.content').add(function () { init(); });
}());
