// טאב "עדכון" של דשבורד ניהול הייבוא: מידע חי מוויקיפדיה, מיזוג תלת-כיווני עם הערך במכלול, טופס פתרון התנגשויות
// ובדיקת תוכן. נטען מ-gadget-searchHelperDashboard.js כשנפתח הטאב (משתמש:בוט גאון הירדן/dashboard.js/update.js),
// וקורא את הפונקציות והמצב של הדשבורד מ-window.mchlDash. הבדיקות (tests/merge3.test.js) שולפות מכאן את האזורים המסומנים merge3 ו-content-check,
// ולכן הם חייבים להישאר פונקציות טהורות.
(function () {
	'use strict';
	var D = window.mchlDash;
	var escapeHtml = D.escapeHtml, withRetry = D.withRetry, batches = D.batches, mwApiFetch = D.mwApiFetch;
	var mechalolEditUrl = D.mechalolEditUrl, pgHeaders = D.pgHeaders, $id = D.$id, SUPABASE_URL = D.SUPABASE_URL;
	var getImportReplacements = D.getImportReplacements;

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
		if (!D.cfg() || !D.cfg().liveChange) return;
		document.querySelectorAll('#mchl-dash [data-upd-id]').forEach(function (el) {
			var row = D.rows().find(function (r) { return String(r.id) === el.getAttribute('data-upd-id'); });
			if (!row || !updateInfo.has(row.id)) return;
			var holder = document.createElement('span');
			holder.innerHTML = renderUpdateChange(row);
			el.replaceWith(holder.firstChild);
			var tr = document.querySelector('#mchl-dash [data-upd-id="' + row.id + '"]');
			if (tr && (tr = tr.closest('tr'))) tr.classList.toggle('mchl-upd-same', updateRowIsSame(row));
		});
	}
	function loadUpdateInfoForCurrentPage() {
		if (!D.cfg() || !D.cfg().liveChange) return;
		var myTab = D.activeTab();
		var rows = D.rows().filter(function (r) { var i = updateInfo.get(r.id); return !i || i.error; }); // שגיאות לא נשמרות: מנסים שוב
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
			if (D.activeTab() === myTab) paintUpdateInfo();
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
		var row = D.rows().find(function (r) { return String(r.id) === id; });
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
		var row = D.rows().find(function (r) { return String(r.id) === btn.getAttribute('data-id'); });
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
		var myTab = D.activeTab();
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
			if (el && D.activeTab() === myTab) el.innerHTML = freshnessInnerHtml();
		});
	}

	D.update = {
		renderChange: renderUpdateChange, isSame: updateRowIsSame, bannerHtml: updateBannerHtml,
		loadFreshness: loadUpdateFreshness, loadInfo: loadUpdateInfoForCurrentPage,
		togglePanel: toggleUpdatePanel, openMerge: openUpdateMerge,
		clear: function () { updateInfo.clear(); updateDiffCache.clear(); updateMergeCache.clear(); }
	};
}());
