/*
 * בדיקת מילים חשודות בוויקיטקסט
 *
 * רץ על קוד הוויקיטקסט שבתיבת העריכה (לא על הדף המוצג), לפי שתי
 * רשימות המילים הקיימות:
 *   - המכלול:בדיקת מילים חשודות (מכ:במח) - שש רשימות צבע.
 *   - המכלול:בודק מילים חשודות (מכ:בומח) - תבנית בכל שורה.
 * הרשימות נקראות חי מהדפים, כך שעריכה בהן משפיעה מיד.
 *
 * מה שונה מהגאדג'טים הקיימים:
 *   - בודק רק מה שהקורא רואה: הערות, שמות תבניות ופרמטרים, יעדי
 *     קישורים עם כינוי, שמות קבצים, כתובות ותגיות לא נבדקים. ערכי
 *     פרמטרים, כיתובים, הערות שוליים וכינויי קישורים כן. (הרשימה
 *     הסגולה נבדקת תמיד על כל הקוד - היא מחפשת סימני ויקי.)
 *   - מתקן בזמן הטעינה תבניות שבורות ברשימות (ראו FIXES), ומציג
 *     אותן בסוף הדוח כדי שיתוקנו גם בדף המקור.
 *   - מציג כל התאמה (לא רק הראשונה), עם שורה והקשר; לחיצה מסמנת
 *     אותה בתיבת העריכה.
 *   - בונה את הדוח מצמתי טקסט בלבד - תוכן הדף לא מוזרק כ-HTML.
 *
 * הגדרה אישית (common.js), אופציונלי:
 *   window.wikitextWordCheckAllow = ['מין חדש', 'כלי זין'];
 *   התאמה שכולה בתוך אחד מהביטויים האלה לא תוצג.
 */
(function () {
	'use strict';

	var BMH_PAGE = 'המכלול:בדיקת מילים חשודות';
	var BOMAH_PAGE = 'המכלול:בודק מילים חשודות';
	var HEB = String.fromCharCode(0x590) + '-' + String.fromCharCode(0x5FF);

	// לפי שם הכותרת בדף ולא לפי מיקום, כך ששינוי סדר בדף לא יזיז צבעים.
	var BMH_CATEGORIES = [
		{ heading: 'אדום כהה', key: 'bmh_dark_red', label: 'אדום כהה', color: '#ff5555', blocking: true },
		{ heading: 'אדום בהיר', key: 'bmh_light_red', label: 'אדום בהיר', color: '#ffcccc', blocking: false },
		{ heading: 'ירוק', key: 'bmh_green', label: 'ירוק', color: '#99ff99', blocking: false },
		{ heading: 'כחול', key: 'bmh_blue', label: 'כחול', color: '#ccccff', blocking: false },
		{ heading: 'צהוב', key: 'bmh_yellow', label: 'צהוב', color: '#eeee99', blocking: false },
		{ heading: 'סגול', key: 'bmh_purple', label: 'סגול', color: '#9370db', blocking: false, raw: true }
	];
	var BOMAH_CATEGORIES = [
		{ key: 'bomah_modesty', label: 'בומח - צניעות', color: '#ff5555', blocking: true },
		{ key: 'bomah_general', label: 'בומח - כללי', color: '#eeee99', blocking: false }
	];

	var FIXES = {
		'(?<!יו)א[ו]*נ[ו]*ס^ק': {
			to: '(?<!יו)א[ו]*נ[ו]*ס(?!ק)',
			why: '^ באמצע תבנית הוא "תחילת הטקסט" - התבנית לא התאימה אף פעם. הכוונה: לא ואחריו ק.'
		},
		'רומ+[נן]+^יה': {
			to: 'רומ+[נן]+(?!יה)',
			why: '^ באמצע תבנית - לא התאימה אף פעם. הכוונה: לא ואחריו יה.'
		},
		'(?<!ל)לסביםוזית': {
			to: 'לסבי(?:ם|ות|ית)',
			why: 'טקסט משובש - לא התאים אף פעם.'
		},
		'{{כ}}(?<=\\s)זין': {
			to: '(?<!כלי )(?<![' + HEB + '])זין(?![' + HEB + '])',
			why: 'אחרי }} לא יכול לבוא רווח - לא התאימה אף פעם. הכוונה: "זין" כמילה בודדת (לא "כלי זין").'
		},
		'^שדי$': {
			to: '(?<![' + HEB + '])שדי(?![' + HEB + '])',
			why: '^...$ מתאים רק אם כל הדף הוא המילה הזו. הכוונה: מילה בודדת.'
		},
		'^(אלים)$': {
			to: '(?<![' + HEB + '])אלים(?![' + HEB + '])',
			why: '^...$ מתאים רק אם כל הדף הוא המילה הזו. הכוונה: מילה בודדת.'
		},
		'שדי$': {
			to: '(?<![' + HEB + '])שדי(?![' + HEB + '])',
			why: '$ מתאים רק בסוף הדף. הכוונה: מילה בודדת.'
		},
		'[^(ת|מ|ארי)]זונ(ה|ות)': {
			to: '(?<!ארי|ת|מ)זונ(?:ה|ות)',
			why: '[^(ת|מ|ארי)] היא רשימת אותיות אסורות (ת,מ,א,ר,י), לא "לא אחרי המילה ארי".'
		},
		'[^(ת|ארי)]זונה': {
			to: '(?<!ארי|ת)זונה',
			why: 'רשימת אותיות במקום "לא אחרי המילה".'
		},
		'[^(דו)]לפין': {
			to: '(?<!דו)לפין',
			why: '[^(דו)] חוסמת כל ד או ו, לא את "דו" (דולפין).'
		},
		'האל[^ימות(קט)]': {
			to: 'האל(?![ימות]|קט)',
			why: '(קט) בתוך [] חוסם ק או ט בודדים, לא את הרצף "קט".'
		}
	};

	// ===== פירוק דפי הרשימות =====

	// מפצל לפי | רק ברמה העליונה - לא בתוך () או [] או אחרי \.
	function splitAlternatives(source) {
		var parts = [], current = '', depth = 0, inClass = false, i, ch;
		for (i = 0; i < source.length; i++) {
			ch = source[i];
			if (ch === '\\' && i + 1 < source.length) {
				current += source.substr(i, 2);
				i++;
				continue;
			}
			if (inClass) {
				if (ch === ']') inClass = false;
			} else if (ch === '[') {
				inClass = true;
			} else if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth = Math.max(depth - 1, 0);
			} else if (ch === '|' && depth === 0) {
				parts.push(current);
				current = '';
				continue;
			}
			current += ch;
		}
		parts.push(current);
		return parts;
	}

	function parseBmh(text) {
		var result = [];
		var sections = text.split(/^==\s*([^=\n]+?)\s*==\s*$/m);
		for (var i = 1; i + 1 < sections.length; i += 2) {
			var heading = sections[i];
			var category = BMH_CATEGORIES.filter(function (c) { return c.heading === heading; })[0];
			var blocks = sections[i + 1].split(/<!--\s*-->/);
			if (category && blocks.length >= 3) {
				result.push({ category: category, sources: splitAlternatives(blocks[1].trim()) });
			}
		}
		return result;
	}

	// כמו בבומח: רק אחרי -----, רק שורות שמתחילות ב-* ומכילות //.
	function parseBomah(text) {
		var body = text.indexOf('-----') >= 0 ? text.slice(text.indexOf('-----') + 5) : text;
		var blocks = body.split(/<!--\s*-->/);
		var result = [], ignored = [];
		BOMAH_CATEGORIES.forEach(function (category, idx) {
			var sources = [];
			(blocks[idx] || '').split('\n').forEach(function (line) {
				line = line.trim();
				if (line.indexOf('//') < 0) return;
				if (line[0] !== '*') {
					ignored.push({ category: category, line: line });
					return;
				}
				sources.push(line.slice(1).split('//')[0].trim());
			});
			result.push({ category: category, sources: sources });
		});
		return { lists: result, ignored: ignored };
	}

	function compileLists(bmhText, bomahText) {
		var parsed = [], problems = [], patterns = [];
		if (bmhText != null) parsed = parsed.concat(parseBmh(bmhText));
		if (bomahText != null) {
			var bomah = parseBomah(bomahText);
			parsed = parsed.concat(bomah.lists);
			bomah.ignored.forEach(function (x) {
				problems.push({ category: x.category, source: x.line,
					message: 'השורה לא מתחילה ב-* ולכן בומח מתעלם ממנה.' });
			});
		}
		parsed.forEach(function (list) {
			var seen = {};
			list.sources.forEach(function (source) {
				if (!source.trim()) {
					problems.push({ category: list.category, source: source,
						message: 'חלופה ריקה (| מיותר) - מתאימה לכל מקום בדף; הושמטה.' });
					return;
				}
				if (seen[source]) return;
				seen[source] = true;
				var fix = Object.prototype.hasOwnProperty.call(FIXES, source) ? FIXES[source] : null;
				var effective = fix ? fix.to : source;
				var regex;
				try {
					// רישיות כמו במקור: בומח עם דגל i, במח בלי (לכן יש בו sex|Sex|SEX).
					regex = new RegExp(effective, list.category.key.indexOf('bomah') === 0 ? 'gi' : 'g');
				} catch (e) {
					problems.push({ category: list.category, source: source, message: 'תבנית לא תקינה: ' + e.message });
					return;
				}
				if (fix) problems.push({ category: list.category, source: source, message: 'תוקנה ל-' + fix.to + ' - ' + fix.why });
				patterns.push({ category: list.category, source: source, regex: regex });
			});
		});
		return { patterns: patterns, problems: problems };
	}

	// ===== מיסוך ויקיטקסט =====

	var FILE_NS = ['קובץ', 'תמונה', 'file', 'image', 'מדיה', 'media'];
	var CATEGORY_NS = ['קטגוריה', 'category'];
	var INTERWIKI_RE = /^[a-z]{2,3}(?:-[a-z]+)*$/;
	var FILE_OPTION_RE = new RegExp(
		'^\\s*(?:ממוזער|ממוסגר|מסגרת|ללא מסגרת|שמאל|ימין|מרכז|ללא|thumb|thumbnail|frame|framed|frameless|' +
		'border|left|right|center|centre|none|upright(?:\\s*=\\s*[\\d.]+)?|\\d*x?\\d+\\s*px|' +
		'(?:link|קישור|page|דף|class|lang|alt)\\s*=.*)\\s*$', 'i');
	var NON_TEXT_TAGS = ['math', 'chem', 'syntaxhighlight', 'source', 'pre', 'score', 'timeline',
		'templatedata', 'graph', 'mapframe', 'maplink', 'templatestyles'];

	// מחזיר מחרוזת באורך זהה שבה כל מה שלא מוצג לקורא הוחלף ברווח
	// (ירידות שורה נשמרות) - כך כל מיקום בה הוא אותו מיקום במקור.
	function maskWikitext(text) {
		var buf = text.split('');
		function blank(start, end) {
			for (var i = Math.max(start, 0); i < Math.min(end, buf.length); i++) {
				if (buf[i] !== '\n') buf[i] = ' ';
			}
		}
		function each(re, s, fn) {
			var m;
			re.lastIndex = 0;
			while ((m = re.exec(s)) !== null) {
				fn(m);
				if (m[0].length === 0) re.lastIndex++;
			}
		}
		function blankAll(re, s) {
			each(re, s, function (m) { blank(m.index, m.index + m[0].length); });
		}

		blankAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))/g, text);
		var s = buf.join('');
		NON_TEXT_TAGS.forEach(function (tag) {
			blankAll(new RegExp('<' + tag + '\\b[^>]*?(?:/>|>[\\s\\S]*?(?:</' + tag + '\\s*>|$(?![\\s\\S])))', 'gi'), s);
		});
		s = buf.join('');
		each(/(<gallery\b[^>]*>)([\s\S]*?)(?:<\/gallery\s*>|$(?![\s\S]))/gi, s, function (m) {
			var pos = m.index + m[1].length;
			m[2].split('\n').forEach(function (line) {
				var bar = line.indexOf('|');
				blank(pos, pos + (bar >= 0 ? bar + 1 : line.length));
				pos += line.length + 1;
			});
		});
		s = buf.join('');
		blankAll(/<\/?[A-Za-z][^<>\n]*>/g, s);
		blankAll(/\[(?:https?:|ftp:)?\/\/[^\s\]]+|\bhttps?:\/\/[^\s\]|}<>]+/g, s);
		blankAll(/__[A-Zא-ת_]+__|&[A-Za-z]+;|&#x?[0-9A-Fa-f]+;/g, s);
		blankAll(/\b[A-Za-z-]+\s*=\s*("[^"\n]*"|'[^'\n]*')/g, s);

		maskLinksAndTemplates(buf.join(''), blank);
		return buf.join('');
	}

	// מעבר יחיד עם מחסנית, כדי ש-| בתוך קישור שבתוך תבנית ישויך לקישור.
	function maskLinksAndTemplates(s, blank) {
		var stack = [], n = s.length, i = 0;
		function starts(str, at) { return s.substr(at, str.length) === str; }
		function fileOption(at) {
			var end = at;
			while (end < n && '|[]{\n'.indexOf(s[end]) < 0) end++;
			if (FILE_OPTION_RE.test(s.slice(at, end))) blank(at, end);
			return at;
		}
		while (i < n) {
			var top = stack.length ? stack[stack.length - 1].kind : null;
			var end;
			if (starts('{{{', i)) {
				stack.push({ kind: 'param', start: i });
				i += 3;
			} else if (top === 'param' && starts('}}}', i)) {
				blank(stack.pop().start, i + 3);
				i += 3;
			} else if (starts('{{', i)) {
				stack.push({ kind: 'tpl', start: i });
				end = i + 2;
				while (end < n && '|{}[\n'.indexOf(s[end]) < 0 && !starts('}}', end)) end++;
				blank(i, end);
				i = end;
			} else if (top === 'tpl' && starts('}}', i)) {
				stack.pop();
				blank(i, i + 2);
				i += 2;
			} else if (starts('[[', i)) {
				end = i + 2;
				while (end < n && '|[]{\n'.indexOf(s[end]) < 0) end++;
				var target = s.slice(i + 2, end);
				var colon = target.indexOf(':');
				var ns = colon >= 0 ? target.replace(/^:/, '').split(':')[0].trim().toLowerCase() : '';
				var hasPipe = s[end] === '|';
				if (CATEGORY_NS.indexOf(ns) >= 0 && target[0] !== ':') {
					// שם הקטגוריה מוצג לקורא - רק הקידומת ומפתח המיון מוסתרים.
					blank(i, i + 2 + colon + 1);
					var close = s.indexOf(']]', end);
					close = close < 0 ? n : close;
					blank(end, close + 2);
					i = close + 2;
					continue;
				}
				var kind = FILE_NS.indexOf(ns) >= 0 && target[0] !== ':' ? 'file' : 'link';
				if (kind === 'file' || hasPipe || (ns && INTERWIKI_RE.test(ns))) {
					blank(i, end + (hasPipe ? 1 : 0));
				} else {
					blank(i, i + 2); // [[ערך]] - שם הערך הוא הטקסט המוצג
				}
				stack.push({ kind: kind, start: i });
				i = end + (hasPipe ? 1 : 0);
				if (kind === 'file') fileOption(i);
			} else if ((top === 'link' || top === 'file') && starts(']]', i)) {
				stack.pop();
				blank(i, i + 2);
				i += 2;
			} else if (s[i] === '|' && top === 'tpl') {
				blank(i, i + 1);
				var m = /^[^=|{}\[\]\n]*=/.exec(s.slice(i + 1, i + 200));
				if (m) {
					blank(i + 1, i + 1 + m[0].length);
					i += m[0].length;
				}
				i++;
			} else if (s[i] === '|' && top === 'file') {
				blank(i, i + 1);
				fileOption(i + 1);
				i++;
			} else {
				i++;
			}
		}
	}

	// ===== סריקה =====

	function scan(wikitext, lists, options) {
		options = options || {};
		var masked = options.raw ? wikitext : maskWikitext(wikitext);
		var allowed = [];
		(options.allow || []).forEach(function (pattern) {
			var re = new RegExp(pattern, 'gi'), m;
			while ((m = re.exec(wikitext)) !== null) {
				allowed.push([m.index, m.index + m[0].length]);
				if (!m[0].length) re.lastIndex++;
			}
		});
		var bySpan = {}, result = [];
		lists.patterns.forEach(function (p) {
			if (options.categories && options.categories.indexOf(p.category.key) < 0) return;
			var hay = p.category.raw ? wikitext : masked, m;
			p.regex.lastIndex = 0;
			while ((m = p.regex.exec(hay)) !== null) {
				if (!m[0].length) {
					p.regex.lastIndex++;
					continue;
				}
				var start = m.index, end = m.index + m[0].length;
				while (start < end && /\s/.test(hay[start])) start++;
				while (end > start && /\s/.test(hay[end - 1])) end--;
				if (start === end) continue;
				if (allowed.some(function (a) { return a[0] <= start && end <= a[1]; })) continue;
				var key = p.category.key + ':' + start + ':' + end;
				if (bySpan[key]) {
					if (bySpan[key].patterns.indexOf(p.source) < 0) bySpan[key].patterns.push(p.source);
					continue;
				}
				bySpan[key] = {
					category: p.category, patterns: [p.source], start: start, end: end,
					text: wikitext.slice(start, end),
					line: wikitext.slice(0, start).split('\n').length
				};
				result.push(bySpan[key]);
			}
		});
		return result.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
	}

	var core = {
		splitAlternatives: splitAlternatives, parseBmh: parseBmh, parseBomah: parseBomah,
		compileLists: compileLists, maskWikitext: maskWikitext, scan: scan
	};

	// ===== ממשק - רק בתוך מדיה ויקי, בדף עריכה =====

	if (typeof mw === 'undefined') {
		if (typeof module !== 'undefined') module.exports = core;
		return;
	}
	if (['edit', 'submit'].indexOf(mw.config.get('wgAction')) < 0) return;

	var listsPromise = null;
	function loadLists() {
		if (!listsPromise) {
			listsPromise = new mw.Api().get({
				action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
				titles: [BMH_PAGE, BOMAH_PAGE].join('|'), formatversion: 2
			}).then(function (data) {
				var texts = {};
				data.query.pages.forEach(function (page) {
					texts[page.title] = page.revisions ? page.revisions[0].slots.main.content : null;
				});
				return compileLists(texts[BMH_PAGE], texts[BOMAH_PAGE]);
			});
			listsPromise.fail(function () { listsPromise = null; });
		}
		return listsPromise;
	}

	function el(tag, text, css) {
		var $e = $('<' + tag + '>');
		if (text != null) $e.text(text);
		if (css) $e.css(css);
		return $e;
	}

	function render($box, $panel, matches, lists) {
		$panel.empty().append(el('div', 'מילים חשודות בקוד: ' + matches.length + ' התאמות',
			{ fontWeight: 'bold', marginBottom: '0.5em' }));
		var groups = [];
		matches.forEach(function (m) {
			var g = groups.filter(function (x) { return x.category === m.category; })[0];
			if (!g) groups.push(g = { category: m.category, items: [] });
			g.items.push(m);
		});
		groups.sort(function (a, b) { return b.category.blocking - a.category.blocking; });
		var text = $box.textSelection('getContents');
		groups.forEach(function (g) {
			var $head = el('div', g.category.label + (g.category.blocking ? ' (חמור)' : '') + ' - ' + g.items.length,
				{ marginTop: '0.5em', fontWeight: 'bold' });
			$head.prepend(el('span', null, { display: 'inline-block', width: '1em', height: '1em',
				background: g.category.color, marginLeft: '0.4em', verticalAlign: 'middle' }));
			var $ul = el('ul');
			g.items.forEach(function (m) {
				var before = text.slice(Math.max(m.start - 35, 0), m.start).replace(/\n/g, ' ');
				var after = text.slice(m.end, m.end + 35).replace(/\n/g, ' ');
				var $link = el('a', 'שורה ' + m.line, { cursor: 'pointer' }).attr('title', m.patterns.join('  |  '));
				$link.on('click', function (e) {
					e.preventDefault();
					$box.trigger('focus')
						.textSelection('setSelection', { start: m.start, end: m.end })
						.textSelection('scrollToCaretPosition');
				});
				$ul.append(el('li').append($link, ': …', document.createTextNode(before),
					el('mark', m.text, { background: g.category.color }), document.createTextNode(after), '…'));
			});
			$panel.append($head, $ul);
		});
		var fixes = lists.problems;
		if (fixes.length) {
			var $details = el('details', null, { marginTop: '0.7em', fontSize: '90%' });
			$details.append(el('summary', 'בעיות ברשימות המקור (' + fixes.length + ') - כדאי לתקן בדף הרשימה'));
			var $ul = el('ul');
			fixes.forEach(function (p) {
				$ul.append(el('li').append(el('code', p.source), ' [' + p.category.label + ']: ' + p.message));
			});
			$panel.append($details.append($ul));
		}
	}

	function run() {
		var $box = $('#wpTextbox1');
		var $panel = $('#wikitextWordCheck');
		if (!$panel.length) {
			$panel = el('div', null, { border: '1px solid #a2a9b1', padding: '0.5em 1em', margin: '0.5em 0' })
				.attr('id', 'wikitextWordCheck');
			$('.editOptions').before($panel);
		}
		$panel.text('טוען את רשימות המילים…');
		loadLists().then(function (lists) {
			var matches = scan($box.textSelection('getContents'), lists, { allow: window.wikitextWordCheckAllow || [] });
			render($box, $panel, matches, lists);
		}, function () {
			$panel.text('שגיאה בטעינת רשימות המילים.');
		});
	}

	$.when(mw.loader.using(['mediawiki.api', 'mediawiki.util', 'jquery.textSelection']), $.ready).then(function () {
		var link = mw.util.addPortletLink('p-cactions', '#', 'בדיקת מילים חשודות בקוד', 'ca-wikitextWordCheck',
			'סריקת הוויקיטקסט לפי רשימות המילים החשודות');
		$(link).on('click', function (e) {
			e.preventDefault();
			run();
		});
	});
}());
