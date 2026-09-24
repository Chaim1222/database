/*
 * בדיקת מילים חשודות בוויקיטקסט
 *
 * סורק את קוד הוויקיטקסט שבתיבת העריכה ומסווג את הדף, מבחינת צניעות, לאחת
 * משלוש רמות:
 *   בעיה ודאית  - נמצאה מילה שהיא בעיה במובהק.
 *   לבדיקה      - נמצאה רק מילה דו-משמעית (למשל "מין", "רומן", "אונס" ההלכתי).
 *   נקי         - לא נמצא דבר.
 * נושאים אחרים (אמונה ונצרות, תיארוך ומדע, שאריות מוויקיפדיה) דורשים ניסוח
 * ולא פסילה, ולכן מוצגים בנפרד כ"הערות ניסוח" ולא משפיעים על הרמה. במדגם של
 * 2,020 ערכי מכלול הם מופיעים ב-20% מהערכים - כחלק מהרמה, רוב המכלול היה "לבדיקה".
 * יוצא מן הכלל: גיל העולם והיווצרות היקום (נושא age) - חמור ודורש הסרה (הכרעת
 * חיים, 2026-09-24), ולכן נספר ברמה כמו צניעות.
 *
 * רשימות המילים הן שני דפי JSON (ראו WORDS_PAGE, ALLOW_PAGE):
 *   words.json - לכל רשומה: תבנית, רמה (problem/review), נושא (צניעות,
 *                אמונה, תיארוך, שאריות ויקי), סטטוס (active/suggested) והסבר.
 *   allow.json - ביטויים מותרים ("המין האנושי", "בואנוס איירס"): התאמה
 *                שנופלת כולה בתוכם לא מוצגת.
 * רשומות בסטטוס "suggested" הן הצעות שעדיין לא אושרו, ולא נבדקות אלא אם
 * מגדירים ב-common.js:  window.wikitextWordCheckSuggested = true;
 *
 * איך הבדיקה עובדת:
 *   - רק מה שהקורא רואה: הערות, שמות תבניות ופרמטרים, יעדי קישורים עם
 *     כינוי, שמות קבצים, כתובות ותגיות לא נבדקים. רשומה עם scope: "raw"
 *     (שאריות ויקי) נבדקת על כל הקוד.
 *   - "תחילת מילה": התאמה נספרת רק אם יש בה תחילת מילה (אולי אחרי אותיות
 *     שימוש) - "דול|פין", "ח|זונות", "אשדוד|אנס" לא נתפסים.
 *   - הדוח נבנה מצמתי טקסט בלבד - תוכן הדף לא מוזרק כ-HTML.
 *
 * אותו קובץ משמש גם את הכלים שבריפו (Node): כשאין mw, הוא מייצא את המנוע.
 * מקור: https://github.com/Chaim1222/database (word-filter/)
 */
(function () {
	'use strict';

	var WORDS_PAGE = 'מדיה ויקי:Gadget-wikitextWordCheck-words.json';
	var ALLOW_PAGE = 'מדיה ויקי:Gadget-wikitextWordCheck-allow.json';

	var LEVELS = { problem: 2, review: 1 };
	var LEVEL_LABELS = { problem: 'בעיה ודאית', review: 'לבדיקה', clean: 'נקי' };
	var LEVEL_COLORS = { problem: '#ff5555', review: '#ffd966', clean: '#b6e3b6' };
	var TOPIC_LABELS = { modesty: 'צניעות', faith: 'אמונה ונצרות', dating: 'תיארוך ומדע', wiki: 'שאריות מוויקיפדיה', age: 'גיל העולם' };

	// ===== טעינת הרשימות =====

	// options.suggested - לכלול גם רשומות בסטטוס "suggested" (הצעות שלא אושרו).
	function compileLists(words, allow, options) {
		options = options || {};
		var problems = [];
		function usable(entry) {
			return entry.status === 'active' || (options.suggested && entry.status === 'suggested');
		}
		function compile(entry, flags) {
			try {
				return new RegExp(entry.pattern, flags);
			} catch (e) {
				problems.push({ id: entry.id, pattern: entry.pattern, message: 'תבנית לא תקינה: ' + e.message });
				return null;
			}
		}
		var patterns = [], allowed = [];
		((words && words.entries) || []).filter(usable).forEach(function (entry) {
			var regex = compile(entry, entry.caseSensitive ? 'g' : 'gi');
			if (regex) patterns.push({ entry: entry, regex: regex });
		});
		((allow && allow.entries) || []).filter(usable).forEach(function (entry) {
			var regex = compile(entry, 'gi');
			if (regex) allowed.push({ entry: entry, regex: regex });
		});
		return { patterns: patterns, allow: allowed, problems: problems };
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

	// אותיות השימוש שיכולות להיות צמודות לפני מילה.
	var PREFIX_LETTERS = 'ובכלמשה';
	var LETTER_RE = /[A-Za-zא-ת]/;

	// האם start הוא תחילת מילה, או שלפניו רק עד 3 אותיות שימוש ואז תחילת
	// מילה. "הפורנו"/"ולסבית" - כן; "דול|פין"/"ני|זונה" - לא.
	function startsWord(text, start) {
		var j = start, prefixes = 0;
		while (j > 0 && LETTER_RE.test(text[j - 1])) {
			if (PREFIX_LETTERS.indexOf(text[j - 1]) < 0 || prefixes === 3) return false;
			j--;
			prefixes++;
		}
		return true;
	}

	// האם יש בתוך ההתאמה אות שהיא תחילת מילה - לא רק הראשונה, כי תבניות
	// כמו .?.?סקסואל תופסות גם תווים מהמילה הקודמת. תבנית שמתחילה ב-[^...]
	// צורכת את התו שלפני המילה, ולכן הוא לא נספר.
	function containsWordStart(text, start, end, pattern) {
		if (pattern.indexOf('[^') === 0) start++;
		for (var i = start; i < end; i++) {
			if (LETTER_RE.test(text[i]) && startsWord(text, i)) return true;
		}
		return false;
	}

	function allMatches(re, text, fn) {
		var m;
		re.lastIndex = 0;
		while ((m = re.exec(text)) !== null) {
			if (m[0].length) fn(m);
			else re.lastIndex++;
		}
	}

	/*
	 * מחזיר את ההתאמות, ממוינות לפי מיקום. כל התאמה: start, end, text,
	 * line, level (הגבוהה מבין הרשומות שתפסו את הקטע), topic, entries.
	 * options.raw - בלי מיסוך; options.wordStart: false - גם באמצע מילה;
	 * options.allow - ביטויים מותרים נוספים.
	 */
	function scan(wikitext, lists, options) {
		options = options || {};
		var masked = options.raw ? wikitext : maskWikitext(wikitext);

		// ביטויים מותרים נבדקים גם על הגולמי (קישור שלם לפי היעד שלו) וגם על
		// הממוסך (ביטוי מוצג שמפוצל בסימון).
		var allowed = [];
		var allowRegexes = lists.allow.map(function (a) { return a.regex; })
			.concat((options.allow || []).map(function (p) { return new RegExp(p, 'gi'); }));
		allowRegexes.forEach(function (re) {
			(masked === wikitext ? [wikitext] : [wikitext, masked]).forEach(function (text) {
				allMatches(re, text, function (m) { allowed.push([m.index, m.index + m[0].length]); });
			});
		});

		// מיקומי ירידות השורה, לחישוב מספר שורה בחיפוש בינארי.
		var newlines = [];
		for (var n = wikitext.indexOf('\n'); n >= 0; n = wikitext.indexOf('\n', n + 1)) newlines.push(n);
		function lineOf(pos) {
			var lo = 0, hi = newlines.length;
			while (lo < hi) {
				var mid = (lo + hi) >> 1;
				if (newlines[mid] < pos) lo = mid + 1; else hi = mid;
			}
			return lo + 1;
		}

		var bySpan = {}, result = [];
		lists.patterns.forEach(function (p) {
			var entry = p.entry;
			var hay = entry.scope === 'raw' ? wikitext : masked;
			allMatches(p.regex, hay, function (m) {
				var start = m.index, end = m.index + m[0].length;
				// תבניות כמו (\s|^)זונה כוללות את הרווח שלפני - הוא לא חלק מהמילה.
				while (start < end && /\s/.test(hay[start])) start++;
				while (end > start && /\s/.test(hay[end - 1])) end--;
				if (start === end) return;
				if (options.wordStart !== false && !containsWordStart(hay, m.index, end, entry.pattern)) return;
				if (allowed.some(function (a) { return a[0] <= start && end <= a[1]; })) return;
				var key = start + ':' + end;
				var match = bySpan[key];
				if (!match) {
					match = bySpan[key] = { start: start, end: end, text: wikitext.slice(start, end), line: lineOf(start),
						level: entry.level, topic: entry.topic, entries: [] };
					result.push(match);
				}
				if (match.entries.indexOf(entry) < 0) match.entries.push(entry);
				if (LEVELS[entry.level] > LEVELS[match.level]) {
					match.level = entry.level;
					match.topic = entry.topic;
				}
			});
		});
		// התאמה שכלולה בהתאמה אחרת ("מיני" בתוך "מיניות", "לפנה"ס" בתוך "4000 לפנה"ס") מתמזגת
		// בה, כדי שכל מילה תופיע פעם אחת. הרמה - הגבוהה; הנושא - של הרמה הגבוהה, ועדיפות לנושא שנספר.
		result.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
		var merged = [];
		result.forEach(function (m) {
			var outer = merged[merged.length - 1];
			if (!outer || m.start >= outer.end || m.end > outer.end) { merged.push(m); return; }
			m.entries.forEach(function (e) { if (outer.entries.indexOf(e) < 0) outer.entries.push(e); });
			var counts = function (x) { return VERDICT_TOPICS.indexOf(x.topic) >= 0; };
			if (LEVELS[m.level] > LEVELS[outer.level] || (m.level === outer.level && counts(m) && !counts(outer))) {
				outer.level = m.level;
				outer.topic = m.topic;
			}
		});
		return merged;
	}

	// נושאים שקובעים את רמת הדף. השאר - הערות ניסוח (ראו בראש הקובץ).
	var VERDICT_TOPICS = ['modesty', 'age'];

	// הרמה של הדף כולו: problem / review / clean. topics - אילו נושאים נספרים.
	function verdict(matches, topics) {
		topics = topics || VERDICT_TOPICS;
		var level = 'clean';
		matches.forEach(function (m) {
			if (topics.indexOf(m.topic) < 0) return;
			if (level === 'clean' || LEVELS[m.level] > LEVELS[level]) level = m.level;
		});
		return level;
	}

	// המשפט שבו נמצאה ההתאמה, כטקסט קריא (בלי קישורים, תבניות והערות שוליים), לתצוגה
	// מחוץ לעורך - למשל בדשבורד, שבו הטקסט המלא לא מול העיניים. מחזיר {before, text, after}.
	var MARK_OPEN = '\u0001', MARK_CLOSE = '\u0002';
	function contextOf(wikitext, match, maxSide) {
		maxSide = maxSide || 160;
		var start = match.start, end = match.end;
		var from = start, to = end;
		while (from > 0 && start - from < maxSide && wikitext[from - 1] !== '\n' &&
			!(/[.!?]/.test(wikitext[from - 1]) && /\s/.test(wikitext[from] || ''))) from--;
		while (to < wikitext.length && to - end < maxSide && wikitext[to] !== '\n' &&
			!(/[.!?]/.test(wikitext[to]) && /\s|$/.test(wikitext[to + 1] || ''))) to++;
		if (to < wikitext.length && /[.!?]/.test(wikitext[to])) to++;
		var raw = wikitext.slice(from, start) + MARK_OPEN + wikitext.slice(start, end) + MARK_CLOSE + wikitext.slice(end, to);
		var marked = function (t) { return t.indexOf(MARK_OPEN) >= 0 || t.indexOf(MARK_CLOSE) >= 0; };
		var clean = raw
			// תבנית או הערת שוליים שנחתכו בגבול החלון
			.replace(/^[^{}]*\}\}/, function (t) { return marked(t) ? t : ''; })
			.replace(/<ref[^>\/]*>(?![\s\S]*<\/ref>)[\s\S]*$|\{\{[^{}]*$/, function (t) { return marked(t) ? t : ''; })
			.replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>|<!--[\s\S]*?-->/g, function (t) { return marked(t) ? t : ''; })
			.replace(/\{\{[^{}]*\}\}/g, function (t) { return marked(t) ? t.slice(2, -2) : ''; })
			.replace(/\[\[([^\[\]|]*)\|([^\[\]]*)\]\]/g, function (t, target, label) { return marked(target) ? target : label; })
			.replace(/\[\[([^\[\]]*)\]\]/g, '$1')
			.replace(/\[https?:[^\s\]]+ ?([^\]]*)\]/g, '$1')
			.replace(/<[^>]+>|'{2,}/g, '')
			.replace(/\s+/g, ' ');
		var a = clean.indexOf(MARK_OPEN), b = clean.indexOf(MARK_CLOSE);
		if (a < 0 || b < a) { clean = raw.replace(/\s+/g, ' '); a = clean.indexOf(MARK_OPEN); b = clean.indexOf(MARK_CLOSE); }
		return {
			before: (from > 0 && start - from >= maxSide ? '…' : '') + clean.slice(0, a).replace(/^\s+/, ''),
			text: clean.slice(a + 1, b),
			after: clean.slice(b + 1).replace(/\s+$/, '') + (to < wikitext.length && to - end >= maxSide ? '…' : '')
		};
	}

	var core = {
		compileLists: compileLists, maskWikitext: maskWikitext, scan: scan, verdict: verdict, contextOf: contextOf,
		VERDICT_TOPICS: VERDICT_TOPICS, LEVEL_LABELS: LEVEL_LABELS, TOPIC_LABELS: TOPIC_LABELS
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
				titles: [WORDS_PAGE, ALLOW_PAGE].join('|'), formatversion: 2
			}).then(function (data) {
				var json = {};
				data.query.pages.forEach(function (page) {
					if (page.revisions) json[page.title] = JSON.parse(page.revisions[0].slots.main.content);
				});
				if (!json[WORDS_PAGE]) throw new Error('הדף ' + WORDS_PAGE + ' לא נמצא');
				return compileLists(json[WORDS_PAGE], json[ALLOW_PAGE], { suggested: !!window.wikitextWordCheckSuggested });
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

	function swatch(color) {
		return el('span', null, { display: 'inline-block', width: '0.9em', height: '0.9em', background: color,
			marginLeft: '0.4em', verticalAlign: 'middle', border: '1px solid #a2a9b1' });
	}

	function render($box, $panel, matches, lists) {
		var text = $box.textSelection('getContents');
		var level = verdict(matches);
		var $head = el('div', null, { fontWeight: 'bold', marginBottom: '0.5em' })
			.append(swatch(LEVEL_COLORS[level]), 'בדיקת מילים חשודות: ' + LEVEL_LABELS[level]);
		$panel.empty().append($head);

		var counted = function (m) { return VERDICT_TOPICS.indexOf(m.topic) >= 0; };
		var groups = [
			{ label: LEVEL_LABELS.problem, color: LEVEL_COLORS.problem, items: matches.filter(function (m) { return counted(m) && m.level === 'problem'; }) },
			{ label: LEVEL_LABELS.review, color: LEVEL_COLORS.review, items: matches.filter(function (m) { return counted(m) && m.level === 'review'; }) },
			{ label: 'הערות ניסוח (אמונה, תיארוך, ויקיפדיה)', color: '#c9d3e8', items: matches.filter(function (m) { return !counted(m); }) }
		];
		groups.forEach(function (g) {
			var items = g.items;
			if (!items.length) return;
			$panel.append(el('div', g.label + ' (' + items.length + ')', { fontWeight: 'bold', marginTop: '0.5em' })
				.prepend(swatch(g.color)));
			var $ul = el('ul');
			items.forEach(function (m) {
				var ctx = contextOf(text, m, 80);
				var tip = m.entries.map(function (e) {
					return e.pattern + (e.note ? ' - ' + e.note : '') + (e.status === 'suggested' ? ' (הצעה)' : '');
				}).join('\n');
				var $link = el('a', 'שורה ' + m.line, { cursor: 'pointer' }).attr('title', tip);
				$link.on('click', function (e) {
					e.preventDefault();
					$box.trigger('focus')
						.textSelection('setSelection', { start: m.start, end: m.end })
						.textSelection('scrollToCaretPosition');
				});
				$ul.append(el('li').append($link, ' [' + (TOPIC_LABELS[m.topic] || m.topic) + ']: ',
					document.createTextNode(ctx.before), el('mark', ctx.text, { background: counted(m) ? LEVEL_COLORS[m.level] : g.color }),
					document.createTextNode(ctx.after)));
			});
			$panel.append($ul);
		});

		if (lists.problems.length) {
			var $details = el('details', null, { marginTop: '0.7em', fontSize: '90%' });
			$details.append(el('summary', 'תבניות לא תקינות ברשימות (' + lists.problems.length + ')'));
			var $ul = el('ul');
			lists.problems.forEach(function (p) {
				$ul.append(el('li').append(el('code', p.pattern), ' (' + p.id + '): ' + p.message));
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
		}, function (err) {
			$panel.text('שגיאה בטעינת רשימות המילים' + (err && err.message ? ': ' + err.message : '.'));
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
