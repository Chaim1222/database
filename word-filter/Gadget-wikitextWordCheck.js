/*
 * בדיקת מילים חשודות בוויקיטקסט
 *
 * סורק את קוד הוויקיטקסט שבתיבת העריכה ומסווג את הדף לאחת מארבע רמות:
 *   בעיה ודאית  - נמצאה מילה שהיא בעיה במובהק.
 *   לבדיקה      - נמצאה רק מילה דו-משמעית (למשל "מין", "רומן", "אונס" ההלכתי).
 *   דורש ניסוח  - נמצאו רק הערות ניסוח (אמונה ונצרות, תיארוך, שאריות מוויקיפדיה).
 *   נקי         - לא נמצא דבר.
 * הנושאים שקובעים בעיה/לבדיקה: צניעות, וגיל העולם והיווצרות היקום (age) - חמור
 * ודורש הסרה. שאר הנושאים דורשים ניסוח ולא פסילה (הכרעות חיים, 2026-09-24).
 *
 * רשימות המילים הן שני דפי JSON (ראו WORDS_PAGE, ALLOW_PAGE):
 *   words.json - לכל רשומה: תבנית, רמה (problem/review), נושא (צניעות,
 *                אמונה, תיארוך, שאריות ויקי), סטטוס (active/suggested) והסבר.
 *   allow.json - ביטויים מותרים. שני סוגים (שדה kind, הכרעת חיים 2026-09-24):
 *                hide   - זו בכלל לא המילה ("בואנוס איירס", Assembly): התאמה
 *                         שנופלת כולה בתוכם לא מוצגת.
 *                demote - שימוש תמים במילה אמיתית ("המין האנושי", "רומן היסטורי"):
 *                         ההתאמה מוצגת, אבל "בעיה" יורדת ל"לבדיקה".
 * רשומות בסטטוס "suggested" הן הצעות שעדיין לא אושרו, ולא נבדקות אלא אם
 * מגדירים ב-common.js:  window.wikitextWordCheckSuggested = true;
 *
 * איך הבדיקה עובדת:
 *   - הרמה נקבעת רק לפי מה שהקורא רואה: הערות, שמות תבניות ופרמטרים, יעדי
 *     קישורים עם כינוי, שמות קבצים, כתובות ותגיות לא נספרים. רשומה עם
 *     scope: "raw" (שאריות ויקי) נבדקת על כל הקוד. אות שצמודה לקישור מבחוץ
 *     ("[[רומן]]ים") מתחברת למילה, כמו בתצוגה (displayOf).
 *   - רשת ביטחון (scanHidden): מילים שנמצאו רק בקוד המוסתר - הקוד כולו עובר
 *     למכלול - מוצגות ברשימה נפרדת, בלי להשפיע על הרמה.
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
	var LEVEL_LABELS = { problem: 'בעיה ודאית', review: 'לבדיקה', wording: 'דורש ניסוח', clean: 'נקי' };
	var LEVEL_COLORS = { problem: '#ff5555', review: '#ffd966', wording: '#c9d3e8', clean: '#b6e3b6' };
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
			if (regex) allowed.push({ entry: entry, regex: regex, kind: entry.kind === 'demote' ? 'demote' : 'hide' });
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
		return maskInfo(text).masked;
	}

	// סוגי הקוד המוסתר, לכל תו: '' = מוצג לקורא. HIDDEN_KINDS - השמות לתצוגה.
	//   j - סוגריים של קישור רגיל ([[, ]]), l - יעד של קישור עם כינוי (עד ה-|),
	//   c - הערה מוסתרת, f - קובץ (שם ואפשרויות), m - תבנית (שם, סוגריים, |),
	//   k - קטגוריה (קידומת ומפתח מיון, גם {{מיון רגיל:...}}), u - כתובת אינטרנט, h - תגית HTML או
	//   תוכן לא טקסטואלי (math וכו'), x - אחר (ישויות, מילות קסם, מאפיינים).
	//   p - שם של פרמטר בתבנית ("| מין = זכר") - שדה קבוע של התבנית, לא תוכן.
	var HIDDEN_KINDS = { l: 'יעד קישור', c: 'הערה מוסתרת', f: 'קובץ', m: 'תבנית', p: 'שם פרמטר', k: 'קטגוריה / מיון', u: 'כתובת', h: 'תגית', x: 'קוד', j: 'קישור' };
	var SORT_KEY_RE = /^\s*(?:מיון רגיל|DEFAULTSORT|DEFAULTSORTKEY|DEFAULTCATEGORYSORT)\s*:/i;

	function maskInfo(text) {
		var buf = text.split('');
		var kinds = new Array(buf.length);
		function blank(start, end, kind) {
			for (var i = Math.max(start, 0); i < Math.min(end, buf.length); i++) {
				if (buf[i] !== '\n') buf[i] = ' ';
				if (!kinds[i]) kinds[i] = kind || 'x';
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
		function blankAll(re, s, kind) {
			each(re, s, function (m) { blank(m.index, m.index + m[0].length, kind); });
		}

		blankAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))/g, text, 'c');
		var s = buf.join('');
		NON_TEXT_TAGS.forEach(function (tag) {
			blankAll(new RegExp('<' + tag + '\\b[^>]*?(?:/>|>[\\s\\S]*?(?:</' + tag + '\\s*>|$(?![\\s\\S])))', 'gi'), s, 'h');
		});
		s = buf.join('');
		each(/(<gallery\b[^>]*>)([\s\S]*?)(?:<\/gallery\s*>|$(?![\s\S]))/gi, s, function (m) {
			var pos = m.index + m[1].length;
			m[2].split('\n').forEach(function (line) {
				var bar = line.indexOf('|');
				blank(pos, pos + (bar >= 0 ? bar + 1 : line.length), 'f');
				pos += line.length + 1;
			});
		});
		s = buf.join('');
		blankAll(/<\/?[A-Za-z][^<>\n]*>/g, s, 'h');
		blankAll(/\[(?:https?:|ftp:)?\/\/[^\s\]]+|\bhttps?:\/\/[^\s\]|}<>]+/g, s, 'u');
		blankAll(/__[A-Zא-ת_]+__|&[A-Za-z]+;|&#x?[0-9A-Fa-f]+;/g, s);
		blankAll(/\b[A-Za-z-]+\s*=\s*("[^"\n]*"|'[^'\n]*')/g, s);

		maskLinksAndTemplates(buf.join(''), blank);
		return { masked: buf.join(''), kinds: kinds, source: text };
	}

	// הטקסט שהקורא רואה, לחיפוש. הסימון של קישור רגיל ([[, ]], והיעד של קישור עם
	// כינוי) הופך לרווח אחד, חוץ מ-"]]" שאחריו אות - שם הוא מושמט, כמו בתצוגה:
	// "[[רומן]]ים" -> "רומנים", "[[מין (טקסונומיה)|מין]]ים" -> "מינים", "[[אינטרסקס]]ואלים".
	// לפני קישור נשאר רווח גם אחרי אות ("ה[[מין]]" -> "ה מין"): התבניות ברשימות
	// (\sמין, " מיני") לא מכירות אותיות שימוש, וההפרדה שומרת עליהן; וגם "מילה[[קישור]]"
	// בלי רווח (טעות הקלדה נפוצה) לא מסתיר את הקישור. שאר הקוד המוסתר - רווח.
	// בהתחלה - ירידת שורה (ממופה למיקום 0), כדי שתבנית כמו \sמין תתפוס גם מילה
	// בתחילת הטקסט, כמו בתחילת כל שורה אחרת. map[i] = המיקום במקור של התו ה-i.
	function displayOf(info) {
		var out = ['\n'], map = [0], masked = info.masked, kinds = info.kinds;
		var isLink = function (k) { return k === 'j' || k === 'l'; };
		for (var i = 0; i < masked.length; i++) {
			if (!isLink(kinds[i])) {
				out.push(masked[i]);
				map.push(i);
				continue;
			}
			var runStart = i;
			while (i + 1 < masked.length && isLink(kinds[i + 1])) i++;
			var closesOnly = info.source.slice(runStart, i + 1).indexOf('[[') < 0;
			if (!(closesOnly && LETTER_RE.test(masked[i + 1] || ''))) {
				out.push(' ');
				map.push(runStart);
			}
		}
		return { text: out.join(''), map: map };
	}

	// מעבר יחיד עם מחסנית, כדי ש-| בתוך קישור שבתוך תבנית ישויך לקישור.
	function maskLinksAndTemplates(s, blank) {
		var stack = [], n = s.length, i = 0;
		function starts(str, at) { return s.substr(at, str.length) === str; }
		function fileOption(at) {
			var end = at;
			while (end < n && '|[]{\n'.indexOf(s[end]) < 0) end++;
			if (FILE_OPTION_RE.test(s.slice(at, end))) blank(at, end, 'f');
			return at;
		}
		while (i < n) {
			var top = stack.length ? stack[stack.length - 1].kind : null;
			var end;
			if (starts('{{{', i)) {
				stack.push({ kind: 'param', start: i });
				i += 3;
			} else if (top === 'param' && starts('}}}', i)) {
				blank(stack.pop().start, i + 3, 'm');
				i += 3;
			} else if (starts('{{', i)) {
				stack.push({ kind: 'tpl', start: i });
				end = i + 2;
				while (end < n && '|{}[\n'.indexOf(s[end]) < 0 && !starts('}}', end)) end++;
				blank(i, end, SORT_KEY_RE.test(s.slice(i + 2, end)) ? 'k' : 'm');
				i = end;
			} else if (top === 'tpl' && starts('}}', i)) {
				stack.pop();
				blank(i, i + 2, 'm');
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
					blank(i, i + 2 + colon + 1, 'k');
					var close = s.indexOf(']]', end);
					close = close < 0 ? n : close;
					blank(end, close + 2, 'k');
					i = close + 2;
					continue;
				}
				var kind = FILE_NS.indexOf(ns) >= 0 && target[0] !== ':' ? 'file' : 'link';
				if (kind === 'file') {
					blank(i, end + (hasPipe ? 1 : 0), 'f');
				} else if (hasPipe || (ns && INTERWIKI_RE.test(ns))) {
					blank(i, i + 2, 'j');
					blank(i + 2, end + (hasPipe ? 1 : 0), 'l');
				} else {
					blank(i, i + 2, 'j'); // [[ערך]] - שם הערך הוא הטקסט המוצג
				}
				stack.push({ kind: kind, start: i });
				i = end + (hasPipe ? 1 : 0);
				if (kind === 'file') fileOption(i);
			} else if ((top === 'link' || top === 'file') && starts(']]', i)) {
				blank(i, i + 2, stack.pop().kind === 'file' ? 'f' : 'j');
				i += 2;
			} else if (s[i] === '|' && top === 'tpl') {
				blank(i, i + 1, 'm');
				var m = /^[^=|{}\[\]\n]*=/.exec(s.slice(i + 1, i + 200));
				if (m) {
					blank(i + 1, i + 1 + m[0].length, 'p');
					i += m[0].length;
				}
				i++;
			} else if (s[i] === '|' && top === 'file') {
				blank(i, i + 1, 'f');
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

	// תבניות שתופסות תווים מסביב למילה (".?.?.?סקסואל.?.?", "[^ט]רומ", "ס[^קח]") -
	// ההתאמה מקוצרת למילה עצמה, בשביל הטקסט שמוצג ומיקום הסימון:
	//   בהתחלה - אחרי רווח בשבעת התווים הראשונים ("ת הומוסקסואלית"), רק בתבנית
	//            שמתחילה בתו כלשהו (., [^, (?:^|[^);
	//   בסוף   - לפני רווח בשלושת התווים האחרונים ("הומוסקסואל ב"), רק אם התבנית
	//            תופסת גם בלעדיהם ("בגד ים" נשאר שלם);
	//   סימני פיסוק בקצוות ("אונס.", "(אנס").
	var LETTER_OR_DIGIT = /[A-Za-z0-9א-ת]/;
	function trimMatch(regex, pattern, hay, from, start, end) {
		if (/^(?:\.|\[\^|\(\?:\^\|\[\^)/.test(pattern)) {
			var lead = hay.slice(start, Math.min(start + 7, end)).search(/\s[^\s]*$/);
			if (lead >= 0 && start + lead + 1 < end) start += lead + 1;
		}
		var tail = hay.slice(Math.max(start, end - 3), end).search(/\s/);
		if (tail >= 0) {
			var cut = Math.max(start, end - 3) + tail;
			var sticky = new RegExp(regex.source, regex.flags.replace('g', '') + 'y');
			sticky.lastIndex = from;
			if (cut > start && sticky.test(hay.slice(0, cut))) end = cut;
		}
		while (end > start + 1 && !LETTER_OR_DIGIT.test(hay[end - 1]) && !/["'״׳]/.test(hay[end - 1])) end--;
		while (start < end - 1 && !LETTER_OR_DIGIT.test(hay[start])) start++;
		while (end > start + 1 && /\s/.test(hay[end - 1])) end--;
		return [start, end];
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
		// החיפוש רץ על הטקסט המוצג (displayOf), והמיקומים מתורגמים חזרה למקור.
		var shown = options.raw ? { text: wikitext, map: null } : displayOf(maskInfo(wikitext));
		var texts = [{ text: wikitext, map: null }];
		if (!options.raw) texts.push(shown);
		var toSource = function (t, start, end) {
			return t.map ? [t.map[start], t.map[end - 1] + 1] : [start, end];
		};

		// ביטויים מותרים נבדקים גם על הגולמי (קישור שלם לפי היעד שלו) וגם על
		// המוצג (ביטוי מוצג שמפוצל בסימון).
		var allowed = [];
		var allowRules = lists.allow
			.concat((options.allow || []).map(function (p) { return { regex: new RegExp(p, 'gi'), kind: 'hide', entry: null }; }));
		allowRules.forEach(function (rule) {
			texts.forEach(function (t) {
				allMatches(rule.regex, t.text, function (m) {
					var span = toSource(t, m.index, m.index + m[0].length);
					allowed.push([span[0], span[1], rule]);
				});
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
			var t = entry.scope === 'raw' ? texts[0] : shown;
			var hay = t.text;
			allMatches(p.regex, hay, function (m) {
				var start = m.index, end = m.index + m[0].length;
				// תבניות כמו (\s|^)זונה כוללות את הרווח שלפני - הוא לא חלק מהמילה.
				while (start < end && /\s/.test(hay[start])) start++;
				while (end > start && /\s/.test(hay[end - 1])) end--;
				if (start === end) return;
				if (options.wordStart !== false && !containsWordStart(hay, m.index, end, entry.pattern)) return;
				var trimmed = trimMatch(p.regex, entry.pattern, hay, m.index, start, end);
				start = trimmed[0];
				end = trimmed[1];
				var shownText = hay.slice(start, end);
				var span = toSource(t, start, end);
				start = span[0];
				end = span[1];
				var covering = allowed.filter(function (a) { return a[0] <= start && end <= a[1]; });
				if (covering.some(function (a) { return a[2].kind === 'hide'; })) return;
				var level = entry.level;
				if (covering.length && level === 'problem') level = 'review';
				var key = start + ':' + end;
				var match = bySpan[key];
				if (!match) {
					match = bySpan[key] = { start: start, end: end, text: shownText, line: lineOf(start),
						level: level, topic: entry.topic, entries: [], demotedBy: [] };
					result.push(match);
				}
				if (match.entries.indexOf(entry) < 0) match.entries.push(entry);
				covering.forEach(function (a) { if (a[2].entry && match.demotedBy.indexOf(a[2].entry) < 0) match.demotedBy.push(a[2].entry); });
				if (LEVELS[level] > LEVELS[match.level]) {
					match.level = level;
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
			m.demotedBy.forEach(function (e) { if (outer.demotedBy.indexOf(e) < 0) outer.demotedBy.push(e); });
			var counts = function (x) { return VERDICT_TOPICS.indexOf(x.topic) >= 0; };
			if (LEVELS[m.level] > LEVELS[outer.level] || (m.level === outer.level && counts(m) && !counts(outer))) {
				outer.level = m.level;
				outer.topic = m.topic;
			}
		});
		return merged;
	}

	// ===== רשת ביטחון: התאמות בקוד שהקורא לא רואה =====
	// הקוד כולו עובר למכלול, כולל מה שמוסתר מהקורא: יעד של קישור
	// ("[[אונס נערה (הלכה)|עינוי]]" יוצר קישור לערך הזה), הערה מוסתרת, שם קובץ,
	// שם תבנית או פרמטר, כתובת. scanHidden מחפש בקוד הגולמי ומחזיר רק התאמות
	// שכל האותיות שלהן מוסתרות, עם match.hidden = סוג הקוד (HIDDEN_KINDS).
	// הן לא נספרות ברמת הדף (verdict) - הרבה מהן רעש ("[[ממלכת וסקס|וסקס]]",
	// "{{הערה|שם=רומנו}}") - אלא מוצגות בנפרד, להחלטת העורך.
	// יעד קישור שהטקסט המוצג של אותו קישור כבר נתפס - לא מוצג שוב.
	function scanHidden(wikitext, lists, visible) {
		var info = maskInfo(wikitext);
		visible = visible || scan(wikitext, lists);
		var rawLists = { patterns: lists.patterns.filter(function (p) { return p.entry.scope !== 'raw'; }),
			allow: lists.allow, problems: lists.problems };
		var LETTER = /[A-Za-zא-ת]/;
		return scan(wikitext, rawLists, { raw: true }).filter(function (m) {
			var kind = null;
			for (var i = m.start; i < m.end; i++) {
				if (!LETTER.test(wikitext[i])) continue;
				if (!info.kinds[i]) return false; // אות מוצגת - זו התאמה רגילה
				kind = kind || info.kinds[i];
			}
			if (!kind) return false;
			if (kind === 'l') {
				var open = wikitext.lastIndexOf('[[', m.start), close = wikitext.indexOf(']]', m.end);
				if (close < 0) close = wikitext.length;
				if (visible.some(function (v) { return v.start >= open && v.end <= close + 2; })) return false;
			}
			m.hidden = kind;
			return true;
		});
	}

	// נושאים שקובעים את רמת הדף. השאר - הערות ניסוח (ראו בראש הקובץ).
	var VERDICT_TOPICS = ['modesty', 'age'];

	// הרמה של הדף כולו: problem / review / wording / clean. topics - אילו נושאים נספרים;
	// התאמה בנושא אחר הופכת דף נקי ל"דורש ניסוח".
	function verdict(matches, topics) {
		topics = topics || VERDICT_TOPICS;
		var level = 'clean';
		matches.forEach(function (m) {
			if (topics.indexOf(m.topic) < 0) {
				if (level === 'clean') level = 'wording';
				return;
			}
			if (!LEVELS[level] || LEVELS[m.level] > LEVELS[level]) level = m.level;
		});
		return level;
	}

	// גבולות המשפט סביב [start, end): עד סוף שורה, או נקודה/סימן שאלה/קריאה ואחריהם
	// רווח, ולכל היותר maxSide תווים לכל צד. משמש את contextOf, ולשאלה "האם שתי
	// התאמות באותו משפט" (רמות החשד).
	function sentenceSpan(wikitext, start, end, maxSide) {
		maxSide = maxSide || Infinity;
		var from = start, to = end;
		while (from > 0 && start - from < maxSide && wikitext[from - 1] !== '\n' &&
			!(/[.!?]/.test(wikitext[from - 1]) && /\s/.test(wikitext[from] || ''))) from--;
		while (to < wikitext.length && to - end < maxSide && wikitext[to] !== '\n' &&
			!(/[.!?]/.test(wikitext[to]) && /\s|$/.test(wikitext[to + 1] || ''))) to++;
		if (to < wikitext.length && /[.!?]/.test(wikitext[to])) to++;
		return [from, to];
	}

	// ===== רמות חשד לפי הקשר (usage.json) =====
	// שני ממדים (analysis/word-rates.md): המילה עצמה - קבוצת השימוש שלה (A: בעייתית
	// ב-75% ומעלה מהמופעים, B: 40%-75%, C: פחות מ-40%) - וההקשר: עוגן (מילה מקבוצה A
	// או בעיה ודאית) באותו משפט, מילה חשודה אחרת באותו משפט, עוגן במקום אחר בערך.
	//   עוגן מוחלט, או רשומת "בעיה" בלי נתונים  -> בעיה ודאית
	//   A: לבד -> לבדיקה, חשד גבוה;   עם הקשר כלשהו -> בעיה ודאית
	//   B: לבד -> חשד בינוני;   הקשר חלש -> חשד גבוה;   הקשר חזק -> בעיה ודאית
	//   C: לבד -> חשד נמוך;    הקשר חלש -> חשד בינוני;  הקשר חזק -> חשד גבוה
	// הקשר חזק = עוגן באותו משפט, או מילה חשודה במשפט + עוגן בערך. חלש = אחד מהשניים.
	// ההתאמה מקבלת match.context = {group, level, suspicion}. ההתאמה עצמה (match.level) לא משתנה.
	var SUSPICION_RANK = { low: 1, medium: 2, high: 3 };
	var SUSPICION_LABELS = { high: 'חשד גבוה', medium: 'חשד בינוני', low: 'חשד נמוך' };
	var GROUP_RANK = { C: 1, B: 2, A: 3 };

	function groupOf(match, usage) {
		var anchors = (usage && usage.anchors) || [];
		if (match.entries.some(function (e) { return anchors.indexOf(e.id) >= 0; })) return 'anchor';
		var families = (usage && usage.families) || {};
		var key = match.entries.map(function (e) { return e.id; }).sort().join(',');
		if (families[key]) return families[key].group;
		var best = null;
		match.entries.forEach(function (e) {
			var f = families[e.id];
			if (f && (!best || GROUP_RANK[f.group] > GROUP_RANK[best])) best = f.group;
		});
		if (best) return best;
		return match.level === 'problem' ? 'X' : 'B'; // אין נתונים - לפי הרשימה
	}

	function contextLevels(wikitext, matches, usage) {
		var flagged = matches.filter(function (m) { return m.topic === 'modesty' && LEVELS[m.level]; });
		flagged.forEach(function (m) { m._group = groupOf(m, usage); });
		var isAnchor = function (m) { return m._group === 'anchor' || m._group === 'A' || m._group === 'X'; };
		flagged.forEach(function (m) {
			var span = sentenceSpan(wikitext, m.start, m.end);
			var mates = flagged.filter(function (o) {
				return o !== m && o.text !== m.text && o.start >= span[0] && o.end <= span[1];
			});
			var anchorInSentence = mates.some(isAnchor);
			var pageAnchor = flagged.some(function (o) { return o !== m && o.text !== m.text && isAnchor(o); });
			var strong = anchorInSentence || (mates.length > 0 && pageAnchor);
			var weak = mates.length > 0 || pageAnchor;
			var g = m._group, eff;
			if (g === 'anchor' || g === 'X') eff = 'problem';
			else if (g === 'A') eff = strong || weak ? 'problem' : 'high';
			else if (g === 'B') eff = strong ? 'problem' : weak ? 'high' : 'medium';
			else eff = strong ? 'high' : weak ? 'medium' : 'low';
			if (eff === 'problem' && m.demotedBy && m.demotedBy.length) eff = 'high'; // שימוש תמים אפשרי - לא "ודאי"
			m.context = { group: g, level: eff === 'problem' ? 'problem' : 'review', suspicion: eff === 'problem' ? null : eff,
				anchorInSentence: anchorInSentence, neighbors: mates.length, pageAnchor: pageAnchor };
			delete m._group;
		});
		// נושאים אחרים שנספרים (גיל העולם): בלי נתוני שימוש - "לבדיקה" = חשד בינוני.
		matches.forEach(function (m) {
			if (m.context || !LEVELS[m.level]) return;
			m.context = { group: null, level: m.level, suspicion: m.level === 'review' ? 'medium' : null };
		});
		return matches;
	}

	// רמת הדף לפי ההקשר: {level: problem/review/wording/clean, suspicion: high/medium/low/null}.
	function contextVerdict(matches, topics) {
		topics = topics || VERDICT_TOPICS;
		var level = verdict(matches, topics) === 'clean' ? 'clean' : 'wording', suspicion = null;
		matches.forEach(function (m) {
			if (topics.indexOf(m.topic) < 0 || !m.context) return;
			if (m.context.level === 'problem') level = 'problem';
			else if (level !== 'problem') {
				level = 'review';
				if (!suspicion || SUSPICION_RANK[m.context.suspicion] > SUSPICION_RANK[suspicion]) suspicion = m.context.suspicion;
			}
		});
		if (level === 'wording' && !matches.some(function (m) { return topics.indexOf(m.topic) < 0; })) level = 'clean';
		return { level: level, suspicion: level === 'review' ? suspicion : null };
	}

	// המשפט שבו נמצאה ההתאמה, כטקסט קריא (בלי קישורים, תבניות והערות שוליים), לתצוגה
	// מחוץ לעורך - למשל בדשבורד, שבו הטקסט המלא לא מול העיניים. מחזיר {before, text, after}.
	var MARK_OPEN = '\u0001', MARK_CLOSE = '\u0002';
	function contextOf(wikitext, match, maxSide) {
		maxSide = maxSide || 160;
		var start = match.start, end = match.end;
		var span = sentenceSpan(wikitext, start, end, maxSide);
		var from = span[0], to = span[1];
		var raw = wikitext.slice(from, start) + MARK_OPEN + wikitext.slice(start, end) + MARK_CLOSE + wikitext.slice(end, to);
		var marked = function (t) { return t.indexOf(MARK_OPEN) >= 0 || t.indexOf(MARK_CLOSE) >= 0; };
		var links = function (t) {
			return t.replace(/\[\[([^\[\]|]*)\|([^\[\]]*)\]\]/g, function (m, target, label) { return marked(target) ? target : label; })
				.replace(/\[\[([^\[\]]*)\]\]/g, '$1');
		};
		// התאמה בתוך תבנית: רק הפרמטר שבו היא נמצאת, בלי שם התבנית ושם הפרמטר
		// ("{{קישור שפה|אנגלית|X|פסטיבל ... אנסי}}" -> "פסטיבל ... אנסי").
		var segment = function (t) {
			var parts = links(t).replace(/^\{\{/, '').replace(/\}\}$/, '').split('|');
			var part = parts.filter(marked)[0] || '';
			var eq = part.indexOf('=');
			return eq >= 0 && eq < part.indexOf(MARK_OPEN) ? part.slice(eq + 1) : part;
		};
		var clean = raw
			// תבנית או הערת שוליים שנחתכו בגבול החלון
			.replace(/^\{?[^{}]*\}\}/, function (t) { return marked(t) ? segment(t.replace(/^\{/, '')) : ''; })
			.replace(/<ref[^>\/]*>(?![\s\S]*<\/ref>)[\s\S]*$/, function (t) { return marked(t) ? t : ''; })
			.replace(/\{\{[^{}]*$/, function (t) { return marked(t) ? segment(t) : ''; })
			.replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>|<!--[\s\S]*?-->/g, function (t) { return marked(t) ? t : ''; })
			.replace(/\{\{[^{}]*\}\}/g, function (t) { return marked(t) ? segment(t) : ''; });
		clean = links(clean)
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
		compileLists: compileLists, maskWikitext: maskWikitext, scan: scan, scanHidden: scanHidden, HIDDEN_KINDS: HIDDEN_KINDS, verdict: verdict, contextOf: contextOf, sentenceSpan: sentenceSpan,
		contextLevels: contextLevels, contextVerdict: contextVerdict, SUSPICION_LABELS: SUSPICION_LABELS,
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

	function render($box, $panel, matches, lists, hidden) {
		var text = $box.textSelection('getContents');
		var level = verdict(matches);
		var $head = el('div', null, { fontWeight: 'bold', marginBottom: '0.5em' })
			.append(swatch(LEVEL_COLORS[level]), 'בדיקת מילים חשודות: ' + LEVEL_LABELS[level]);
		$panel.empty().append($head);

		var counted = function (m) { return VERDICT_TOPICS.indexOf(m.topic) >= 0; };
		var groups = [
			{ label: LEVEL_LABELS.problem, color: LEVEL_COLORS.problem, items: matches.filter(function (m) { return counted(m) && m.level === 'problem'; }) },
			{ label: LEVEL_LABELS.review, color: LEVEL_COLORS.review, items: matches.filter(function (m) { return counted(m) && m.level === 'review'; }) },
			{ label: 'הערות ניסוח (אמונה, תיארוך, ויקיפדיה)', color: '#c9d3e8', items: matches.filter(function (m) { return !counted(m); }) },
			{ label: 'בקוד שהקורא לא רואה - לא נספר ברמה (יעד קישור, הערה, קובץ, תבנית, כתובת)', color: '#ffffff',
				items: (hidden || []).filter(counted), hidden: true }
		];
		groups.forEach(function (g) {
			var items = g.items;
			if (!items.length) return;
			$panel.append(el('div', g.label + ' (' + items.length + ')', { fontWeight: 'bold', marginTop: '0.5em' })
				.prepend(swatch(g.color)));
			var $ul = el('ul');
			items.forEach(function (m) {
				var ctx = g.hidden ? { before: text.slice(Math.max(0, m.start - 40), m.start), text: m.text, after: text.slice(m.end, m.end + 40) }
					: contextOf(text, m, 80);
				var tip = m.entries.map(function (e) {
					return e.pattern + (e.note ? ' - ' + e.note : '') + (e.status === 'suggested' ? ' (הצעה)' : '');
				}).concat(m.demotedBy.map(function (e) {
					return 'ירד לבדיקה - שימוש תמים אפשרי: ' + (e.note || e.pattern);
				})).join('\n');
				var $link = el('a', 'שורה ' + m.line, { cursor: 'pointer' }).attr('title', tip);
				$link.on('click', function (e) {
					e.preventDefault();
					$box.trigger('focus')
						.textSelection('setSelection', { start: m.start, end: m.end })
						.textSelection('scrollToCaretPosition');
				});
				$ul.append(el('li').append($link, ' [' + (g.hidden ? HIDDEN_KINDS[m.hidden] + ', ' : '') + (TOPIC_LABELS[m.topic] || m.topic) + ']: ',
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
			var text = $box.textSelection('getContents');
			var options = { allow: window.wikitextWordCheckAllow || [] };
			var matches = scan(text, lists, options);
			var withAllow = { patterns: lists.patterns, allow: lists.allow.concat(options.allow.map(function (p) {
				return { regex: new RegExp(p, 'gi'), kind: 'hide', entry: null };
			})), problems: lists.problems };
			render($box, $panel, matches, lists, scanHidden(text, withAllow, matches));
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
