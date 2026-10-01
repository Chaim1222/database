// הרצה: node --test word-filter/tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanPage, imagesOf, compileBoth, resultRow } = require('../tools/scan-missing.js');

const lists = compileBoth();

test('scanPage: two verdicts, counts, and sentence context per match', () => {
	const text = 'פתיחה. הסרט עוסק בתעשיית הפורנו בשנות ה-70. לפי תורת האבולוציה.';
	const r = scanPage(text, lists);
	assert.strictEqual(r.verdict, 'problem');
	assert.strictEqual(r.verdict_suggested, 'problem');
	assert.strictEqual(r.counts.a.problem, 1);
	assert.strictEqual(r.counts.a.wording, 1);
	const m = r.matches[0];
	assert.strictEqual(m.a, 'problem');
	assert.strictEqual(m.x, 'פורנו');
	assert.strictEqual(m.b + m.x + m.f, 'הסרט עוסק בתעשיית הפורנו בשנות ה-70.');
	assert.strictEqual(r.matches[1].a, 'wording');
});

test('scanPage: a suggested entry changes only verdict_suggested', () => {
	const r = scanPage('על פי ישוע.', lists); // w0379 - הצעה (אמונה - הערת ניסוח)
	assert.strictEqual(r.verdict, 'clean');
	assert.strictEqual(r.verdict_suggested, 'wording');
	assert.ok(r.matches.some((m) => m.s === 'wording' && m.a === null));
});

test('scanPage: clean page', () => {
	const r = scanPage('ירושלים היא עיר עתיקה.', lists);
	assert.deepStrictEqual([r.verdict, r.verdict_suggested, r.matches.length], ['clean', 'clean', 0]);
});

test('imagesOf: template icons are not the article\'s images; lead and in-code files are', () => {
	const page = {
		images: [{ title: 'קובץ:Allmusic Favicon.png' }, { title: 'קובץ:Flag of Israel.svg' },
			{ title: 'קובץ:Tel_Aviv beach.jpg' }, { title: 'קובץ:Portrait.jpg' }],
		pageimage: 'Portrait.jpg',
	};
	const text = '{{מידע}}\n[[קובץ:Tel Aviv beach.jpg|ממוזער|החוף]]';
	const r = imagesOf(page, text);
	assert.deepStrictEqual(r.photos.sort(), ['Portrait.jpg', 'Tel_Aviv beach.jpg'].sort());
	assert.strictEqual(r.all.length, 4);
});

test('resultRow: shape of the row saved to Supabase', () => {
	const page = { pageid: 7, title: 'דף', lastrevid: 99, length: 10, images: [],
		revisions: [{ revid: 99, slots: { main: { content: 'טקסט נקי.' } } }] };
	const row = resultRow(page, lists, 'v1');
	assert.strictEqual(row.wikipedia_id, 7);
	assert.strictEqual(row.rev_id, 99);
	assert.strictEqual(row.has_images, false);
	assert.strictEqual(row.verdict, 'clean');
	assert.strictEqual(row.lists_version, 'v1');
	assert.strictEqual(row.dictionary, null);
	assert.strictEqual(row.dictionary_why, null);
	assert.strictEqual(row.topic, 'other');
});

test('resultRow: topic from the title, the infobox and the categories', () => {
	const row = (title, content) => resultRow({ pageid: 1, title, lastrevid: 1, images: [],
		revisions: [{ revid: 1, slots: { main: { content } } }] }, lists, 'v1').topic;
	assert.strictEqual(row('1999 בספורט', 'שנה.'), 'years');
	assert.strictEqual(row('מרקורי', '{{פירושונים}}\n* מרקורי (אל)'), 'disambig');
	assert.strictEqual(row('Falling Down', '{{סינגל\n|שם=א}}'), 'dictionary');
	assert.strictEqual(row('ג', 'מדינאי.\n[[קטגוריה:חברי בית הנבחרים של ארצות הברית]]\n[[קטגוריה:אמריקאים שנולדו ב-1900]]'), 'people_congress');
	const R = (t, cats, ib) => row(t, (ib ? '{{' + ib + '}}\n' : '') + cats.map((c) => '[[קטגוריה:' + c + ']]').join('\n'));
	assert.strictEqual(R('הבמה', ['אתרי אינטרנט בישראל', 'תרבות בישראל']), 'orgs'); // לא טכנולוגיה
	assert.strictEqual(R('החלפת ברך', ['טכנולוגיה רפואית', 'ניתוחי אורתופדיה']), 'medicine');
	assert.strictEqual(R('קייזשפצלה', ['המטבח הגרמני', 'מאכלי גבינה']), 'society'); // "מטבח" אינו "טבח"
	assert.strictEqual(R('טקס פרסי אוליבייה 2012', ['טקסי פרס אוליבייה', '2012 בממלכה המאוחדת']), 'culture'); // "המאוחדת" אינה "דת"
	assert.strictEqual(R('אבהיי אשטקר', ['פיזיקאים הודים']), 'people_science'); // עיסוק בלי קטגוריית לידה
	assert.strictEqual(R('דייוויד יאנג (פוליטיקאי)', ['חברי בית הנבחרים של ארצות הברית מאיווה', 'אמריקאים ילידי איווה']), 'people_congress');
	assert.strictEqual(row('ד', 'ציור.\n[[קטגוריה:ציורי עירום]]'), 'sensitive');
	assert.strictEqual(row('ה', '{{עיר\n|שם=ה}}'), 'geo');
});

test('resultRow: dictionary-import candidate from the infobox or the categories', () => {
	const row = (content) => resultRow({ pageid: 1, title: 'דף', lastrevid: 1, images: [],
		revisions: [{ revid: 1, slots: { main: { content } } }] }, lists, 'v1');
	const single = row('{{סינגל\n|שם=Falling Down\n}}\n\'\'\'Falling Down\'\'\' הוא סינגל.');
	assert.strictEqual(single.dictionary, 'מוזיקה');
	assert.strictEqual(single.dictionary_why, 'תבנית סינגל');
	assert.strictEqual(row('{{מידע}}\nכדורגלן.\n[[קטגוריה:כדורגלנים ישראלים]]').dictionary, 'ספורט');
	// תבנית מידע שאינה בידור גוברת על קטגוריה; תרבות חרדית מוחרגת.
	assert.strictEqual(row('{{מדען\n|שם=א}}\n[[קטגוריה:פסנתרנים ישראלים]]').dictionary, null);
	assert.strictEqual(row('{{מוזיקאי\n|שם=א}}\n[[קטגוריה:זמרי מוזיקה חסידית]]').dictionary, null);
});

test('scanPage: context verdict and per-match suspicion', () => {
	const r = scanPage('הרומן "נפשות מתות" מאת גוגול. היא ספרה על האונס.', lists);
	assert.strictEqual(r.ctx_verdict_suggested, 'review');
	assert.strictEqual(r.ctx_suspicion_suggested, 'medium');
	assert.strictEqual(r.matches.find((m) => m.x === 'רומן').cs, 'low');
	assert.strictEqual(r.counts.cs.medium, 1);
});

test('scanPage: a context clue is stored with the match (ks/kw), per mode', () => {
	const r = scanPage('הוא הורשע באונס.', lists);
	const m = r.matches.find((x) => /אונס/.test(x.x));
	assert.strictEqual(m.ca, 'problem');  // k001 הופעל (חיים, 2026-09-28)
	assert.strictEqual(m.cs, 'problem');
	assert.deepStrictEqual(m.ks, ['k001']);
	assert.deepStrictEqual(m.kw, ['הורשע']);
	assert.deepStrictEqual(m.ka, ['k001']);
	assert.strictEqual(r.ctx_verdict, 'problem');
	assert.strictEqual(r.ctx_verdict_suggested, 'problem');
});


test('scanPage: hidden-code matches are stored apart and not counted in the level', () => {
	const r = scanPage('התורה מתארת את [[אונס נערה (הלכה)|עינוי]] הנערה. {{מיון רגיל:הרצוג, רומן}}', lists);
	assert.strictEqual(r.verdict_suggested, 'clean');
	assert.strictEqual(r.hidden_count_suggested, 1); // מפתח המיון נשמר, אבל לא נספר
	const h = r.matches.filter((m) => m.h);
	assert.deepStrictEqual(h.map((m) => m.x + ':' + m.h), ['אונס נערה:l', 'רומן:k']);
	assert.strictEqual(h[0].cs, null);
});

test('resultRow: a surrogate pair cut at the context edge does not break the JSON', () => {
	// אשמונעזר הראשון: אות פיניקית (זוג surrogate) נחתכה בגבול חלון ההקשר של התאמה בקוד.
	const { wellFormed } = require('../tools/scan-missing.js');
	const phoenician = String.fromCodePoint(0x1090C);
	const cut = phoenician.slice(1) + 'טקסט' + phoenician.slice(0, 1);
	assert.strictEqual(wellFormed({ b: cut, x: [phoenician] }).b, 'טקסט');
	assert.strictEqual(wellFormed({ x: [phoenician] }).x[0], phoenician);
});
