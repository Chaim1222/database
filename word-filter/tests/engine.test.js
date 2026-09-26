// הרצה: node --test word-filter/tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../Gadget-wikitextWordCheck.js');
const words = require('../lists/words.json');
const allow = require('../lists/allow.json');

const ACTIVE = engine.compileLists(words, { entries: [] });        // רשומות פעילות בלבד, בלי מותרות
const FULL = engine.compileLists(words, allow, { suggested: true }); // כולל הצעות
const texts = (t, lists = ACTIVE, options) => engine.scan(t, lists, options).map((m) => m.text);
const verdict = (t, lists = FULL) => engine.verdict(engine.scan(t, lists));

test('lists: every entry compiles and has the required fields', () => {
	assert.strictEqual(FULL.problems.length, 0, JSON.stringify(FULL.problems));
	const ids = new Set();
	for (const e of words.entries.concat(allow.entries)) {
		assert.ok(!ids.has(e.id), 'duplicate id ' + e.id);
		ids.add(e.id);
		assert.ok(['active', 'suggested', 'rejected'].includes(e.status), e.id);
		assert.ok(e.sources && e.sources.length, e.id);
	}
	for (const e of words.entries) {
		assert.ok(['problem', 'review'].includes(e.level), e.id);
		assert.ok(engine.TOPIC_LABELS[e.topic], e.id);
	}
});

test('suggested entries are off unless asked for', () => {
	assert.deepStrictEqual(texts('אלוף בפיתוח גוף'), []);
	assert.ok(texts('אלוף בפיתוח גוף', FULL).length);
});

test('fixed patterns from the source pages now match', () => {
	assert.ok(texts('הוא אנס אותה').includes('אנס'));
	assert.ok(texts('זוג לסביות').includes('לסביות'));
	assert.deepStrictEqual(texts('מדינת אריזונה'), []);
	assert.deepStrictEqual(texts('כלי זין רבים'), []);
	assert.deepStrictEqual(texts('רומני'), []);
});

test('masking keeps only visible text, same length and lines', () => {
	const t = '<!-- הערה -->{{תבנית|שם=ערך|חופשי}} [[יעד|כינוי]] [[ערך]] [[קובץ:ש.jpg|ממוזער|250px|כיתוב]] ' +
		'<ref name="n">מקור</ref> https://a.b/c [[קטגוריה:שם|מיון]] {{{1|פרמטר}}} <math>x</math> [[en:Foo]]\nשורה';
	const masked = engine.maskWikitext(t);
	assert.strictEqual(masked.length, t.length);
	assert.strictEqual(masked.split('\n').length, t.split('\n').length);
	assert.deepStrictEqual(masked.split(/\s+/).filter(Boolean), ['ערך', 'חופשי', 'כינוי', 'ערך', 'כיתוב', 'מקור', 'שם', 'שורה']);
	assert.deepStrictEqual(engine.maskWikitext('{{ת|א=[[יעד|כינוי]]|ב}}').split(/\s+/).filter(Boolean), ['כינוי', 'ב']);
});

test('hidden markup is ignored; raw mode sees it', () => {
	const t = '<!-- סקס -->{{סקס}} [[סקס|ערך]] [[קובץ:sex.jpg|ממוזער]]';
	assert.deepStrictEqual(texts(t), []);
	assert.ok(texts(t, ACTIVE, { raw: true }).length);
	assert.deepStrictEqual(texts('ראו [[פורנוגרפיה]]'), ['פורנו']);
});

test('word start: no matches inside words', () => {
	for (const t of ['פסטיבל אשדודאנס', 'חזונות הנביאים', "ג'וזפין בייקר", 'מדינת אבחזיה', 'האמינית']) {
		assert.deepStrictEqual(texts(t), [], t);
		assert.ok(texts(t, ACTIVE, { wordStart: false }).length, t);
	}
	assert.ok(texts('ולסביות').length);
	assert.ok(texts('מסיבה עם אורגיה גדולה').length);
});

test('three-level verdict', () => {
	assert.strictEqual(verdict('תעשיית הפורנו'), 'problem');
	assert.strictEqual(verdict('סיפור אהבה'), 'review');
	// נושאים שאינם צניעות הם הערות ניסוח: נמצאים, אבל לא משנים את רמת הדף.
	assert.strictEqual(verdict('נפטר בשנת 419 לפנה"ס'), 'wording'); // הערת ניסוח בלבד
	assert.strictEqual(engine.scan('נפטר בשנת 419 לפנה"ס', FULL)[0].topic, 'dating');
	assert.strictEqual(engine.verdict(engine.scan('נפטר בשנת 419 לפנה"ס', FULL), ['dating']), 'review');
	assert.strictEqual(verdict('שלום עולם'), 'clean');
	const [m] = engine.scan('שורה\nמשהו פורנו כאן', FULL);
	assert.strictEqual(m.line, 2);
	assert.strictEqual(m.level, 'problem');
});

test('allow list: hide = not the word at all; demote = innocent use, shown as review', () => {
	for (const t of ['אתר מורשת של אונסק"ו', 'בואנוס איירס', 'הקיסר אדריאנוס', 'דוכס סקסוניה', 'טרנסילבניה',
		'כל מיני כלים', 'כנסייה רומנסקית']) {
		assert.strictEqual(verdict(t), 'clean', t);
	}
	// הכרעת חיים: שימוש תמים במילה אמיתית לא נעלם - יורד ל"לבדיקה".
	for (const t of ['המין האנושי', 'הממצאים חשפו', 'בשוגג או באונס', '[[מין (טקסונומיה)|מין]] של ציפור',
		'רבייה מינית אפשרית מהשנה השנייה', 'הפרחים דו-מיניים', 'מתבגרים מינית לאט']) {
		assert.strictEqual(verdict(t), 'review', t);
	}
	assert.strictEqual(engine.verdict(engine.scan('רבייה מינית', ACTIVE)), 'problem'); // בלי ההיתר
	assert.strictEqual(engine.verdict(engine.scan('רבייה מינית', engine.compileLists(words, allow))), 'review'); // a028 פעיל
	for (const t of ['היא הייתה אנוסה', 'הוא אנס אותה', 'זוג מאותו המין', 'תעשיית הפורנו', 'אלבום Fuck You']) {
		assert.strictEqual(verdict(t), 'problem', t);
	}
});

test('case sensitivity follows the source list', () => {
	// ברשימת במח אין דגל i: (\s|^)ass לא תופס את General Assembly.
	assert.deepStrictEqual(texts('the General Assembly'), []);
});

test('wiki leftovers are checked on visible text only', () => {
	assert.deepStrictEqual(texts('{{ויקיפדיה}} [[ויקיפדיה:מדיניות|מדיניות]] <!-- ויקיפדיה -->'), []);
	assert.ok(texts('הערך הועתק מוויקיפדיה').length);
});

// גיל העולם (הכרעת חיים 2026-09-24): חמור, נספר ברמה. הרשומות עדיין בגדר הצעה.
test('age of the world counts in the verdict; recent dates do not', () => {
	for (const t of ['לפני כ-30 מיליון שנה', 'חיו כאן לפני 30,000 שנה', 'כמעט 14 אלף שנה', 'מסביבות 4000 לפנה"ס',
		'באלף הרביעי לפני הספירה', 'היווצרות כדור הארץ', 'המפץ הגדול', 'חיו בקרטיקון', 'בתקופת הפלייסטוקן'])
		assert.strictEqual(verdict(t), 'problem', t);
	for (const t of ['לפני 5,000 שנה', 'בן 4000 שנים', 'אלף שנים', 'המתוארכות ל-2250 לפנה"ס', 'באלף השלישי לפנה"ס',
		'נסע לטריאסטה', 'לפני 1,000 שנה'])
		assert.notStrictEqual(verdict(t), 'problem', t);
	// רשומות התיארוך הישנות שחיים העביר לגיל העולם - פעילות.
	assert.strictEqual(engine.verdict(engine.scan('לפני מיליון שנה', ACTIVE)), 'problem');
	assert.strictEqual(engine.verdict(engine.scan('נסע לטריאסטה', ACTIVE)), 'review');
	assert.strictEqual(engine.verdict(engine.scan('חיו לפני 30,000 שנה', ACTIVE)), 'wording'); // w0429 - עדיין הצעה; נתפס רק כתיארוך
});

test('contained matches merge; sentence context is readable text', () => {
	const t = 'משפט קודם. [[קטגוריה:שירים על מיניות]]';
	const ms = engine.scan(t, FULL).filter((m) => m.topic === 'modesty');
	assert.strictEqual(ms.length, 1);
	assert.strictEqual(ms[0].text, 'מיניות');
	const src = 'פתיחה. היא דיברה על [[אלימות מינית בטבח|האלימות המינית]] שבוצעה<ref>{{צ-מאמר|שם=x}}</ref> בטבח. סוף.';
	const [m] = engine.scan(src, FULL).filter((x) => x.topic === 'modesty');
	const c = engine.contextOf(src, m);
	assert.deepStrictEqual([c.before, c.text, c.after], ['היא דיברה על האלימות ', 'המינית', ' שבוצעה בטבח.']);
});

test('context inside a template shows only the parameter text', () => {
	const src = 'בפסטיבל {{קישור שפה|אנגלית|Annecy Festival|פסטיבל האנימציה של אנסי}} הוכרז השם.';
	const lists = engine.compileLists(words, { entries: [] });
	const m = engine.scan(src, lists).find((x) => x.text === 'אנסי');
	assert.ok(m);
	const c = engine.contextOf(src, m);
	assert.strictEqual(c.before + '[' + c.text + ']' + c.after, 'בפסטיבל פסטיבל האנימציה של [אנסי] הוכרז השם.');
});

// רמות חשד לפי הקשר (usage.json, analysis/word-rates.md).
test('context levels: the word and its sentence decide the suspicion', () => {
	const usage = require('../lists/usage.json');
	const ctx = (t) => engine.contextVerdict(engine.contextLevels(t, engine.scan(t, FULL), usage));
	assert.deepStrictEqual(ctx('הרומן "נפשות מתות" מאת גוגול.'), { level: 'review', suspicion: 'low' });      // C לבד
	assert.deepStrictEqual(ctx('הוא הורשע באונס.'), { level: 'review', suspicion: 'medium' });                // B לבד
	assert.deepStrictEqual(ctx('הסרט עוסק במערכת יחסים.'), { level: 'review', suspicion: 'high' });         // A לבד
	assert.deepStrictEqual(ctx('תעשיית הפורנו.'), { level: 'problem', suspicion: null });                     // עוגן
	const t = 'הוא ניהל רומן עם אשתו של חברו, והזונה צחקה.';
	const ms = engine.contextLevels(t, engine.scan(t, FULL), usage);
	assert.strictEqual(ms.find((m) => m.text === 'רומן').context.suspicion, 'high');                        // C + עוגן במשפט
	assert.deepStrictEqual(ctx('ירושלים עיר עתיקה.'), { level: 'clean', suspicion: null });
	assert.deepStrictEqual(ctx('נפטר בשנת 419 לפנה"ס.'), { level: 'wording', suspicion: null });
});

test('links: a letter right after ]] joins the word, as the reader sees it', () => {
	// "[[מין (טקסונומיה)|מין]]ים" = "מינים" (species) - לא "מין" לבד.
	assert.deepStrictEqual(texts('[[לסבי]]ת', FULL), ['לסבית']);
	assert.ok(!texts('בסביבה חיים [[דולפין|דולפינ]]ים', ACTIVE).includes('פין'));
	// לפני קישור נשאר רווח: אותיות שימוש מחוץ לקישור לא מסתירות את המילה.
	assert.ok(texts('הוא נאשם ב[[אונס]].').includes('אונס'));
	assert.ok(texts('בעקבות ה[[מין]] הזה').length);
	// הטקסט של ההתאמה הוא מה שהקורא רואה, והמיקום - במקור (לסימון בעורך).
	const t = 'שחקן [[רומן היסטורי|ברומן]] ידוע';
	const m = engine.scan(t, ACTIVE).find((x) => /רומן/.test(x.text));
	assert.ok(m && t.slice(m.start, m.end).includes(m.text));
});

test('match text is trimmed to the word itself', () => {
	// .?.?.?.?.?.?סקסואל.?.? תופסת גם את סוף המילה הקודמת ותחילת הבאה.
	assert.deepStrictEqual(texts('עם גברים הומוסקסואלים בעיקר'), ['הומוסקסואלים']);
	assert.deepStrictEqual(texts('גבר [[הומוסקסואל]] בגרמניה'), ['הומוסקסואל']);
	assert.ok(texts('לבשה בגד ים', FULL).includes('בגד ים'));
});

test('scanHidden: words only in hidden code, with where they were found', () => {
	const hidden = (t) => engine.scanHidden(t, FULL).map((m) => m.text + ':' + m.hidden);
	assert.deepStrictEqual(hidden('התורה מתארת את [[אונס נערה (הלכה)|עינוי]] הנערה'), ['אונס:l']);
	assert.deepStrictEqual(hidden('טקסט <!-- סקס --> נוסף'), ['סקס:c']);
	assert.deepStrictEqual(hidden('[[קובץ:Sex.jpg|ממוזער|כיתוב]]'), ['Sex:f']);
	assert.deepStrictEqual(hidden('{{מיון רגיל:הרצוג, רומן}}'), ['רומן:k']);
	// מה שמוצג לקורא - לא כאן (נספר בסריקה הרגילה), וגם לא יעד של קישור שהכינוי שלו כבר נתפס.
	assert.deepStrictEqual(hidden('תעשיית הפורנו'), []);
	assert.deepStrictEqual(hidden('[[פורנוגרפיה|פורנו]]'), []);
	// לא משפיע על הרמה.
	assert.strictEqual(verdict('טקסט <!-- סקס --> נוסף'), 'clean');
});

test('scanHidden: a word glued to letters or digits inside a URL is not a word', () => {
	const hidden = (t) => engine.scanHidden(t, FULL).map((m) => m.text + ':' + m.hidden);
	assert.deepStrictEqual(hidden('<ref>https://example.com/brightline-2021-niq6ezxik5hiplowbz2e7sexz4-story.html</ref>'), []);
	assert.deepStrictEqual(hidden('<ref>https://example.com/anthony-weiner-sex-scandal</ref>'), ['sex:u']);
});
