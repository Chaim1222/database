// תיקון גרסת המקור ב-{{מיון ויקיפדיה}} מדף ההיסטוריה של ערך במכלול (action=history).
// העורך בוחר בעצמו, לפי התקצירים, את שורת הייבוא/העדכון ולוחץ "קבע גרסת מקור" בשורה. הכלי שולף את זמן השורה,
// מוצא בוויקיפדיה את גרסת הערך שהייתה אז, ומעדכן בתבנית את גרסה= ואת תאריך= (רק אם חסרים או שונים);
// אם אין תבנית בכלל - מוסיף תבנית מלאה אחרי {{וח}} או {{קרד}} (הראשון שבהם), ובלעדיהם בשורה חדשה בסוף הערך.
// שום דבר לא נשמר בלי אישור בפאנל התצוגה. הפונקציות הטהורות (בין <fix-pure> ל-</fix-pure>) נבדקות ב-tests/sortTemplateFix.test.js
// ולכן חייבות להישאר בלי תלות ב-DOM או ב-mw.
(function () {
	'use strict';
	if (typeof mw === 'undefined' || mw.config.get('wgAction') !== 'history') return;

	// <fix-pure>
	var HE_MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
	// הערות HTML, nowiki ו-pre מוחלפים ברווחים (באותו אורך): תבנית שבתוכם אינה פעילה.
	function maskWikitext(text) {
		return text.replace(/<!--[\s\S]*?(?:-->|$)|<nowiki>[\s\S]*?(?:<\/nowiki>|$)|<pre[\s\S]*?(?:<\/pre>|$)/gi, function (m) { return m.replace(/[^\n]/g, ' '); });
	}
	// אינדקס מיד אחרי ה-}} שסוגר תבנית שגוף ה"{{" שלה נגמר ב-from; -1 אם לא נסגרה.
	function templateEnd(masked, from) {
		var depth = 1, i = from;
		while (i < masked.length - 1) {
			var pair = masked.substr(i, 2);
			if (pair === '{{') { depth++; i += 2; }
			else if (pair === '}}') { depth--; i += 2; if (depth === 0) return i; }
			else i++;
		}
		return -1;
	}
	// התבנית {{מיון ויקיפדיה}} הפעילה האחרונה: אינדקסים של הגוף ושל הפרמטרים ברמה העליונה בלבד (לא בתוך {{…}} או [[…]]).
	function findSortTemplate(text) {
		var masked = maskWikitext(text), re = /\{\{\s*מיון[\s_]+ויקיפדיה\s*(?=\||\}\})/g, m, starts = [];
		while ((m = re.exec(masked))) starts.push(m.index + m[0].length);
		for (var k = starts.length - 1; k >= 0; k--) {
			var after = templateEnd(masked, starts[k]);
			if (after < 0) continue;
			var end = after - 2, ranges = [], ps = starts[k] + (masked[starts[k]] === '|' ? 1 : 0), curly = 0, square = 0, i;
			for (i = ps; i < end; i++) {
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
					return eq < 0 ? { name: '', start: r[0], valueStart: r[0], valueEnd: r[1] } : { name: text.slice(r[0], eq).trim(), start: r[0], valueStart: eq + 1, valueEnd: r[1] };
				})
			};
		}
		return null;
	}
	// "חודש שנה" (בפורמט הקבוע של התבנית) מחותמת זמן ISO, לפי אזור הזמן של ירושלים.
	function sortDateFromTimestamp(ts) {
		var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: 'numeric' }).formatToParts(new Date(ts));
		var get = function (type) { return Number(parts.filter(function (p) { return p.type === type; })[0].value); };
		return HE_MONTH_NAMES[get('month') - 1] + ' ' + get('year');
	}
	function normTitle(t) { return String(t || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }
	function buildSortTemplate(v) {
		return '{{מיון ויקיפדיה|דף=' + v.page + '|גרסה=' + v.rev + (v.item ? '|פריט=' + v.item : '') + '|תאריך=' + v.date + '}}';
	}
	// מוסיף תבנית אחרי {{וח}} או {{קרד}} (הראשון שמופיע בטקסט, לא בתוך הערה או nowiki), ובלעדיהם בשורה חדשה בסוף הערך.
	function insertSortTemplate(text, tpl) {
		var masked = maskWikitext(text), m = /\{\{\s*(?:וח|קרד)\s*(?=\||\}\})/.exec(masked);
		if (m) {
			var end = templateEnd(masked, m.index + m[0].length);
			if (end >= 0) {
				var rest = text.slice(end);
				return text.slice(0, end) + '\n' + tpl + (rest === '' || rest[0] === '\n' ? '' : '\n') + rest;
			}
		}
		return text.replace(/\s+$/, '') + '\n' + tpl;
	}
	// קטגוריית התחזוקה "ללא תבנית מיון" (לא בתוך הערה או nowiki) מוסרת כשיש תבנית. שורה שהיא רק הקטגוריה נמחקת כולה, בלי להשאיר שורה ריקה.
	function removeMaintenanceCategory(text) {
		var masked = maskWikitext(text);
		var m = /\[\[\s*קטגוריה\s*:\s*המכלול\s*:\s*ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה\s*(?:\|[^\]\n]*)?\]\]/.exec(masked);
		if (!m) return text;
		var s = m.index, e = m.index + m[0].length;
		var ls = masked.lastIndexOf('\n', s - 1) + 1, le = masked.indexOf('\n', e);
		if (le < 0) le = masked.length;
		if (/^[ \t]*$/.test(masked.slice(ls, s)) && /^[ \t]*$/.test(masked.slice(e, le))) {
			if (le < masked.length) return text.slice(0, ls) + text.slice(le + 1);
			return ls > 0 ? text.slice(0, ls - 1) : '';
		}
		return text.slice(0, s) + text.slice(e);
	}
	// תכנית השינוי. v = {page, rev, item, date, updatePage}. בתבנית קיימת: מעדכן גרסה= ו-תאריך= רק אם חסרים או שונים,
	// פריט= רק אם חסר, ו-דף= רק כש-updatePage. בלי תבנית: מוסיף תבנית מלאה. מחזיר {text, changes:[{name,from,to}], created}.
	function planSortTemplate(text, v) {
		var t = findSortTemplate(text);
		if (!t) {
			var tpl = buildSortTemplate(v), base = removeMaintenanceCategory(text);
			return { text: insertSortTemplate(base, tpl), changes: [], created: true, template: tpl, removedCategory: base !== text };
		}
		// always: מעדכן אם חסר או שונה; ifMissing: רק אם חסר או ריק; onRequest: קיים ושונה רק לפי updatePage, חסר או ריק תמיד נוסף.
		var wanted = [['גרסה', String(v.rev), 'always'], ['פריט', v.item || '', 'ifMissing'], ['תאריך', v.date, 'always'], ['דף', v.page, v.updatePage ? 'always' : 'ifMissing']];
		var edits = [], missing = '', changes = [];
		wanted.forEach(function (w) {
			var name = w[0], value = w[1];
			if (!value) return;
			var p = t.params.filter(function (x) { return x.name === name; })[0];
			var old = p ? text.slice(p.valueStart, p.valueEnd) : '';
			if (old.trim() === value) return;
			if (w[2] === 'ifMissing' && old.trim() !== '') return;
			changes.push({ name: name, from: old.trim(), to: value });
			var dateParam = t.params.filter(function (x) { return x.name === 'תאריך'; })[0];
			if (!p && name === 'פריט' && dateParam) edits.push([dateParam.start - 1, dateParam.start - 1, '|פריט=' + value, 1]); // הסדר: דף, גרסה, פריט, תאריך
			else if (!p) missing += '|' + name + '=' + value;
			else edits.push([p.valueStart, p.valueEnd, /^\s*/.exec(old)[0] + value + /\s*$/.exec(old)[0]]);
		});
		if (missing) edits.push([t.end, t.end, missing, 1]); // נוסף אחרון בטקסט גם כשפרמטר ריק נגמר באותו אינדקס
		edits.sort(function (a, b) { return b[0] - a[0] || (b[3] || 0) - (a[3] || 0); });
		edits.forEach(function (e) { text = text.slice(0, e[0]) + e[2] + text.slice(e[1]); });
		var cleaned = removeMaintenanceCategory(text);
		return { text: cleaned, changes: changes, created: false, removedCategory: cleaned !== text };
	}
	// שם דף ויקיפדיה מהתבנית (דף=), או '' אם אין תבנית או שהפרמטר ריק.
	function sortTemplatePage(text) {
		var t = findSortTemplate(text);
		var p = t && t.params.filter(function (x) { return x.name === 'דף'; })[0];
		return p ? normTitle(text.slice(p.valueStart, p.valueEnd)) : '';
	}
	// השורות סביב התבנית בטקסט החדש (radius לפני ואחרי), לתצוגה מקדימה: {lines:[{text, hit}], before, after}. null אם אין תבנית.
	function previewContext(text, radius) {
		var t = findSortTemplate(text);
		if (!t) return null;
		var lines = text.split('\n'), pos = 0, hitLine = 0;
		for (var i = 0; i < lines.length; i++) {
			if (t.start >= pos && t.start <= pos + lines[i].length) { hitLine = i; break; }
			pos += lines[i].length + 1;
		}
		var from = Math.max(0, hitLine - radius), to = Math.min(lines.length, hitLine + radius + 1);
		return {
			lines: lines.slice(from, to).map(function (l, k) { return { text: l.length > 160 ? l.slice(0, 160) + '…' : l, hit: from + k === hitLine }; }),
			before: from > 0, after: to < lines.length
		};
	}
	// </fix-pure>

	var BUTTON_CLASS = 'sort-fix-button';

	function errText(e) { return e && e.message ? e.message : String(e); }
	// mw.Api דוחה עם (code, data); await מקבל רק את code, לכן עוטפים ושומרים גם את המידע.
	function mwCall(promise) {
		return new Promise(function (resolve, reject) {
			promise.then(resolve, function (code, data) {
				reject(new Error(code + (data && data.error && data.error.info ? ': ' + data.error.info : '')));
			});
		});
	}
	function wikipediaApi(params) {
		var qs = new URLSearchParams(Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params));
		return fetch('https://he.wikipedia.org/w/api.php?' + qs.toString()).then(function (res) {
			if (!res.ok) throw new Error('ויקיפדיה: HTTP ' + res.status);
			return res.json();
		}).then(function (data) {
			if (data.error) throw new Error('ויקיפדיה: ' + (data.error.info || data.error.code));
			return data;
		});
	}
	function el(tag, props, children) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (k) {
			if (k === 'style') node.style.cssText = props[k]; else if (k === 'text') node.textContent = props[k]; else node.setAttribute(k, props[k]);
		});
		(children || []).forEach(function (c) { node.appendChild(c); });
		return node;
	}
	function setBusy(busy) {
		document.querySelectorAll('.' + BUTTON_CLASS).forEach(function (b) {
			if (busy) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; }
			else b.disabled = b.dataset.wasDisabled === '1';
		});
	}

	// גרסת ויקיפדיה האחרונה שזמנה לא מאוחר מ-ts. redirects: אחרי העברה השם הישן הוא הפניה והיסטוריית הערך נמצאת בשם החדש.
	async function lookupWikipediaRevision(title, ts) {
		var d = await wikipediaApi({
			action: 'query', titles: title, redirects: '1', prop: 'revisions|pageprops', ppprop: 'wikibase_item',
			rvlimit: '1', rvstart: ts, rvdir: 'older', rvprop: 'ids|timestamp'
		});
		var page = d.query && d.query.pages && d.query.pages[0];
		if (!page || page.missing || page.invalid) throw new Error('הדף "' + title + '" לא נמצא בוויקיפדיה');
		var rev = page.revisions && page.revisions[0];
		if (!rev) throw new Error('הערך "' + page.title + '" עוד לא היה קיים בוויקיפדיה בזמן הזה');
		return { title: page.title, revid: rev.revid, ts: rev.timestamp, item: (page.pageprops && page.pageprops.wikibase_item) || '' };
	}

	// שדה לשם דף ויקיפדיה (כשאין תבנית או שאין בה דף=), עם השלמה אוטומטית. מחזיר את השם או null אם בוטל.
	function askTitle(panel, defaultTitle) {
		return new Promise(function (resolve) {
			var input = el('input', { type: 'text', list: 'sort-fix-titles', style: 'width:22em;direction:rtl;' });
			input.value = defaultTitle;
			var list = el('datalist', { id: 'sort-fix-titles' });
			var timer;
			input.addEventListener('input', function () {
				clearTimeout(timer);
				timer = setTimeout(function () {
					if (!input.value.trim()) return;
					wikipediaApi({ action: 'opensearch', search: input.value, limit: '8', namespace: '0' }).then(function (d) {
						list.textContent = '';
						(d[1] || []).forEach(function (t) { list.appendChild(el('option', { value: t })); });
					}).catch(function () { /* ההשלמה אופציונלית */ });
				}, 250);
			});
			var ok = el('button', { text: 'המשך', type: 'button' });
			var cancel = el('button', { text: 'ביטול', type: 'button', style: 'margin-right:6px;' });
			var box = el('div', {}, [el('div', { text: 'שם הערך בוויקיפדיה:' }), input, list, ok, cancel]);
			panel.textContent = '';
			panel.appendChild(box);
			ok.addEventListener('click', function () { var v = normTitle(input.value); if (v) resolve(v); });
			cancel.addEventListener('click', function () { resolve(null); });
			input.focus();
		});
	}

	function describePlan(plan, wp, tsHamichlol) {
		var box = el('div', {});
		box.appendChild(el('div', { text: 'גרסת ויקיפדיה שנמצאה: ' + wp.revid + ' (' + wp.ts + ') בערך "' + wp.title + '", לפי זמן השורה ' + tsHamichlol }));
		if (plan.created) {
			box.appendChild(el('div', { text: 'אין תבנית מיון בערך, תתווסף שורה חדשה:' }));
		} else {
			plan.changes.forEach(function (c) {
				box.appendChild(el('div', { text: c.name + ': ' + (c.from || '(חסר)') + ' ← ' + c.to }));
			});
		}
		if (plan.removedCategory) box.appendChild(el('div', { text: 'תוסר קטגוריית התחזוקה "ללא תבנית מיון ויקיפדיה".' }));
		// איך זה ייראה בטקסט הדף: השורות סביב התבנית, השורה המעודכנת מודגשת
		var ctx = previewContext(plan.text, 2);
		if (ctx) {
			var view = el('div', { dir: 'rtl', style: 'margin:4px 0;border:1px solid #c8ccd1;background:#fff;font-family:monospace;font-size:0.9em;text-align:right;' });
			var addLine = function (text, hit) {
				view.appendChild(el('div', { text: text === '' ? ' ' : text, dir: 'rtl', style: 'white-space:pre-wrap;padding:1px 6px;unicode-bidi:plaintext;' + (hit ? 'background:#d8f0d8;' : '') }));
			};
			if (ctx.before) addLine('…', false);
			ctx.lines.forEach(function (l) { addLine(l.text, l.hit); });
			if (ctx.after) addLine('…', false);
			box.appendChild(view);
		}
		return box;
	}

	async function fixSource(event) {
		var button = event.currentTarget;
		var row = button.closest('li');
		var panel = row.querySelector('.sort-fix-panel');
		if (!panel) { panel = el('div', { class: 'sort-fix-panel', style: 'margin:4px 0;padding:4px 8px;border:1px solid #c8ccd1;background:#f8f9fa;' }); row.appendChild(panel); }
		panel.textContent = 'מעבד...';
		panel.style.display = '';
		setBusy(true);
		button.textContent = 'מעבד...';
		var done = function (msg, ok) {
			panel.textContent = '';
			panel.appendChild(el('span', { text: msg, style: 'color:' + (ok ? '#3c763d' : '#a94442') }));
			button.textContent = ok ? 'בוצע!' : 'שגיאה';
			setBusy(false);
			if (ok) button.disabled = true;
		};
		try {
			var revId = row.getAttribute('data-mw-revid');
			if (!revId) throw new Error('לא נמצא מזהה גרסה בשורה.');
			var api = new mw.Api();
			var pageName = mw.config.get('wgPageName');

			// זמן השורה
			var tsRes = await mwCall(api.get({ action: 'query', prop: 'revisions', revids: revId, rvprop: 'timestamp', formatversion: 2 }));
			var rowTs = tsRes.query.pages[0].revisions[0].timestamp;

			// התוכן הנוכחי של הערך
			var cur = await mwCall(api.get({ action: 'query', prop: 'revisions', titles: pageName, rvprop: 'content|timestamp', rvslots: 'main', formatversion: 2 }));
			var page = cur.query.pages[0];
			if (page.missing) throw new Error('הערך חסר או שלא ניתן לקרוא אותו.');
			var rv = page.revisions[0];
			var slot = rv.slots && rv.slots.main;
			if (!slot || typeof slot.content !== 'string') throw new Error('תוכן הערך חסר או מוסתר.');
			var content = slot.content;

			// שם הדף בוויקיפדיה: דף= בתבנית, ואם אין - לפי כותרת הערך ובאישור העורך
			var tplPage = sortTemplatePage(content);
			var wpTitle = tplPage;
			if (!wpTitle) {
				wpTitle = await askTitle(panel, normTitle(mw.config.get('wgTitle')));
				if (!wpTitle) { panel.style.display = 'none'; button.textContent = 'קבע גרסת מקור'; setBusy(false); return; }
				panel.textContent = 'מעבד...';
			}

			var wp = await lookupWikipediaRevision(wpTitle, rowTs);
			var date = sortDateFromTimestamp(rowTs);
			var titleDiffers = !!tplPage && normTitle(wp.title) !== tplPage;
			var values = { page: normTitle(wp.title), rev: wp.revid, item: wp.item, date: date };

			var plan = planSortTemplate(content, Object.assign({ updatePage: titleDiffers }, values));
			if (!plan.created && plan.changes.length === 0 && !plan.removedCategory) { done('אין מה לתקן: הגרסה והתאריך כבר תואמים (גרסה ' + wp.revid + ').', true); return; }

			// תצוגה ואישור
			panel.textContent = '';
			panel.appendChild(describePlan(plan, wp, rowTs));
			var pageBox = null;
			if (titleDiffers) {
				pageBox = el('input', { type: 'checkbox', checked: 'checked' });
				panel.appendChild(el('label', {}, [pageBox, document.createTextNode(' הערך הועבר בוויקיפדיה ל"' + wp.title + '" - לעדכן גם דף=')]));
			}
			var confirm = el('button', { text: 'שמור', type: 'button', style: 'margin-top:4px;' });
			var cancel = el('button', { text: 'ביטול', type: 'button', style: 'margin-right:6px;' });
			panel.appendChild(el('div', {}, [confirm, cancel]));
			setBusy(false);
			button.textContent = 'קבע גרסת מקור';
			cancel.addEventListener('click', function () { panel.style.display = 'none'; });
			confirm.addEventListener('click', async function () {
				setBusy(true);
				confirm.disabled = true;
				try {
					var final = planSortTemplate(content, Object.assign({ updatePage: !!(pageBox && pageBox.checked) }, values));
					var summary = 'תיקון גרסת מקור: ויקיפדיה גרסה ' + wp.revid + (final.created ? ' (הוספת תבנית מיון)' : '');
					var res = await mwCall(api.postWithToken('csrf', {
						action: 'edit', title: pageName, text: final.text, summary: summary, bot: true,
						basetimestamp: rv.timestamp, nocreate: true, formatversion: 2
					}));
					if (!res.edit || res.edit.result !== 'Success') throw new Error('השמירה לא הצליחה: ' + JSON.stringify(res.edit || res));
					done(res.edit.nochange ? 'אין שינוי בדף.' : 'נשמר: גרסה ' + wp.revid + ', ' + date + '.', true);
				} catch (e) {
					console.error('שגיאה בשמירת גרסת מקור:', e);
					done('שגיאה בשמירה: ' + errText(e), false);
				}
			});
		} catch (e) {
			console.error('שגיאה בקביעת גרסת מקור:', e);
			done(errText(e), false);
		}
	}

	function prepareHistoryButtons() {
		var rows = document.querySelectorAll('#pagehistory > ul > li');
		var count = 0;
		rows.forEach(function (row) {
			if (row.querySelector('.' + BUTTON_CLASS)) return;
			var histLinks = row.querySelector('.mw-history-histlinks');
			if (!histLinks) return;
			var button = el('button', { type: 'button', class: 'mw-ui-button mw-ui-quiet ' + BUTTON_CLASS, text: 'קבע גרסת מקור', style: 'font-size:0.8em;padding:0 3px;margin-right:5px;' });
			button.addEventListener('click', fixSource);
			histLinks.after(button);
			count++;
		});
		console.log('נוספו ' + count + ' כפתורי גרסת מקור.');
	}

	function createMainButton() {
		var id = 'prepare-sort-fix-buttons-main';
		var container = document.getElementById('pagehistory');
		if (document.getElementById(id) || !container) return;
		var main = el('button', { id: id, type: 'button', class: 'mw-ui-button mw-ui-progressive', text: 'הכן לחצני גרסת מקור', style: 'margin:10px 0;' });
		main.addEventListener('click', function () {
			main.disabled = true;
			main.textContent = 'לחצני גרסת המקור הוכנו';
			main.classList.remove('mw-ui-progressive');
			prepareHistoryButtons();
		});
		container.prepend(main);
		// קישור ישיר (למשל מהדשבורד) מכין את הלחצנים מיד
		if (mw.util.getParamValue('fixsrc')) main.click();
	}

	mw.loader.using(['mediawiki.api', 'mediawiki.util']).then(createMainButton);
})();
