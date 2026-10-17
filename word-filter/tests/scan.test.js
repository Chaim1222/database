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
	// "מילוני" אינו נושא (צורת ייבוא, בעמודה dictionary): הנושא לפי סוג הייבוא, ואדם - לפי העיסוק.
	assert.strictEqual(row('Falling Down', '{{סינגל\n|שם=א}}'), 'music');
	assert.strictEqual(row('א', '{{סרט\n|שם=א}}'), 'film_tv');
	assert.strictEqual(row('א', '{{מוזיקאי\n|שם=א}}\n[[קטגוריה:זמרות פופ אמריקאיות]]\n[[קטגוריה:אמריקאיות שנולדו ב-1990]]'), 'people_music');
	assert.strictEqual(row('א', '{{מידע}}\n[[קטגוריה:כדורגלנים ישראלים]]\n[[קטגוריה:ישראלים שנולדו ב-1990]]'), 'people_sport');
	assert.strictEqual(row('א', '{{מידע}}\n[[קטגוריה:קבוצות כדורגל בישראל]]'), 'sport');
	assert.strictEqual(row('סול גודמן', '{{דמות בדיונית\n|שם=א}}\n[[קטגוריה:עורכי דין בדיוניים]]\n[[קטגוריה:שובר שורות - דמויות]]'), 'film_tv');
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
	// עיסוק בהצבעה: שירות צבאי (חצי קול) לא גובר על תבנית המידע ועל קטגוריית העיסוק (חיים, 2026-10-15)
	assert.strictEqual(R('טלי וייס', ['משוררות ישראליות', 'עורכות ספרותיות ישראליות', 'חיילי חיל החינוך והנוער', 'ישראליות שנולדו ב-1977'], 'סופר'), 'people_literature');
	assert.strictEqual(R('דן נמט', ['רופאי ילדים ישראלים', 'סגני-אלופים בצה"ל', 'בעלי תואר דוקטור לרפואה מאוניברסיטת בן-גוריון בנגב', 'ישראלים שנולדו ב-1964'], 'רופא'), 'people_science');
	assert.strictEqual(R('אסתר רמון', ['גנאלוגים יהודים', 'לוחמות הפלמ"ח', 'לוחמי הפלמ"ח', 'מורות בישראל', 'ישראליות שנולדו ב-1924'], 'מדען'), 'people_science');
	assert.strictEqual(R('יארמו לינדברג', ['גנרלים פינים', 'טייסים צבאיים', 'פינים שנולדו ב-1959'], 'נושא משרה'), 'people_military');
	// "זנות" ו"לידה" רק כמילה (עם תחילית): לא בתוך "רוזנות", "חזנות", "ילידה" (חיים, 2026-10-16: מוד הולנד)
	assert.strictEqual(R('מוד הולנד', ['רוזנות (נשים)', 'נשות אצולה במאה ה-14', 'ילידי 1378']), 'people_politics');
	assert.notStrictEqual(R('ח', ['מלחיני קטעי חזנות', 'אמריקאים שנולדו ב-1900']), 'sensitive');
	assert.strictEqual(R('ז', ['היסטוריה של הזנות']), 'sensitive');
	assert.strictEqual(R('ה', ['היריון ולידה']), 'sensitive');
	// "איים" רק כמילה: לא בתוך "אירופאיים"; "פרסים" הוא תרבות; קטגוריות של פיזיקת חלקיקים (חיים, 2026-10-16)
	assert.strictEqual(R('דרך האמנות - לשלום והבנה הדדית', ['סלביאנסקי באזאר', 'פרסים אירופאיים']), 'culture');
	assert.strictEqual(R('א', ['איים בים התיכון']), 'geo');
	assert.strictEqual(R('באריון אומגה', ['באריונים']), 'nature');
	assert.strictEqual(require('../topics.js').topicFromDescription('משפחה של הדרונים תת-אטומים (בריונים) המיוצגים על ידי הסמל Ω'), 'nature');
	assert.strictEqual(R('אליזבת לופקה', ['נשות סגל מחנות ריכוז והשמדה', 'פושעות מלחמה נאציות שהוצאו להורג', 'גרמניות שנולדו ב-1921']), 'people_crime');
});

test('topics: Wikidata (instance of / subclass of / occupation) beside the categories', () => {
	const { classify } = require('../topics.js');
	const WD = require('../wikidata.json');
	const C = (t, cats, wd, ib) => classify({ t, ib: ib || '', cats, wd });
	// "אדם" לא במפת המחלקות (ב"תת-מחלקה של" הוא מגיע לאנטומיה); אדם - לפי עיסוק
	assert.ok(!('Q5' in WD.classes));
	assert.strictEqual(C('ש', [], { P31: ['Q5'], P106: ['Q82955'] }), 'people_politics');
	// עיסוק מוויקינתונים בהצבעה: כומר (רובר סארה) מול קטגוריית עיטור צבאי
	assert.strictEqual(C('רובר סארה', ['מפקדים בלגיון הכבוד', 'חשמנים'], { P31: ['Q5'], P106: ['Q250867'] }), 'people_clergy');
	// עורך דין - חצי קול: חבר קונגרס נשאר חבר קונגרס, גם חברת קונגרס (קטגוריה בלשון נקבה)
	assert.strictEqual(C('ס', ['חברות בית הנבחרים של ארצות הברית מפלורידה'], { P31: ['Q5'], P106: ['Q40348'] }), 'people_congress');
	// ערך שהוא עצמו סוג (כלי נגינה): בלי קטגוריה מוכרת, לפי "תת-מחלקה של" -> כלי נגינה
	assert.strictEqual(C('מ', ['כלי מקלדת'], { P31: [], P279: ['Q34379'] }), 'music');
	// קול אחד בין הקטגוריות, לא הכרעה: פיוט ("שיר" בוויקינתונים) עם קטגוריות פיוט נשאר דת
	assert.strictEqual(C('י', ['פיוטים לסוכות', 'פיוטי יום הכיפורים'], { P31: ['Q5185279'] }), 'religion');
	// כמה "מופע של": הרוב קובע (גשר כביש + גשר קשת מול רחוב)
	assert.strictEqual(C('גשר', [], { P31: ['Q537127', 'Q158438', 'Q79007'] }), 'buildings');
	// אמורא לפי קטגוריית הדור ("לאמוראי"), גם כשוויקינתונים אומר רק "אדם"
	assert.strictEqual(C('א', ['הדור הרביעי לאמוראי ארץ ישראל'], { P31: ['Q5'] }), 'people_rabbis');
	// בלי ויקינתונים - כמו קודם
	assert.strictEqual(C('ע', ['איראן: ערים']), 'geo');
	// תבנית "סופר" - כללית (חצי קול): דיפלומט עם קטגוריית היסטוריונים
	assert.strictEqual(C('אריה עודד', ['היסטוריונים ישראלים'], null, 'סופר'), 'people_science');
});

test('build-wikidata-map: nearest root, ties by table order, occupations apart from classes', () => {
	const { resolve } = require('../tools/build-wikidata-map.js');
	const roots = [['R1', 'music'], ['R2', 'art']];
	const cache = { A: ['R1'], B: ['X'], X: ['R2'], C: ['R2', 'R1'], D: ['Y'], Y: ['Z'], Z: ['R1'], E: null };
	assert.deepStrictEqual(resolve(['A', 'B', 'C', 'D', 'E', 'R2'], roots, cache, 2),
		{ A: ['music', 1], B: ['art', 2], C: ['music', 1], R2: ['art', 0] });   // D - עומק 3, מעבר לגבול; E - חסר
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
	// כשהכללים לא תפסו - לפי הנושא (חיים, 2026-10-17): פרס, דף דמויות, תחרות ספורט; הסיבה "נושא <שם>"
	const prize = row('פרס.\n[[קטגוריה:פרסים אירופאיים]]');
	assert.strictEqual(prize.topic, 'culture');
	assert.strictEqual(prize.dictionary, 'תרבות ובידור');
	assert.strictEqual(prize.dictionary_why, 'נושא תרבות, פרסים ובידור');
	assert.strictEqual(row('דמויות.\n[[קטגוריה:דמויות טלוויזיוניות]]\n[[קטגוריה:סדרות טלוויזיה אמריקאיות]]').dictionary, 'סרטים וטלוויזיה');
	// ההחרגות חלות גם כאן; נושא שאינו בידור - לא מילוני
	assert.strictEqual(row('פיוט.\n[[קטגוריה:פיוטים לסוכות]]\n[[קטגוריה:שירים בעברית]]').dictionary, null);
	assert.strictEqual(row('עיר.\n[[קטגוריה:איראן: ערים]]').dictionary, null);
	assert.strictEqual(row('{{מנהיג\n|שם=א}}\n[[קטגוריה:זמרים אמריקאים]]').dictionary, null);
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
