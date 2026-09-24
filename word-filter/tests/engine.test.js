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
	assert.strictEqual(verdict('נפטר בשנת 419 לפנה"ס'), 'clean');
	assert.strictEqual(engine.scan('נפטר בשנת 419 לפנה"ס', FULL)[0].topic, 'dating');
	assert.strictEqual(engine.verdict(engine.scan('נפטר בשנת 419 לפנה"ס', FULL), ['dating']), 'review');
	assert.strictEqual(verdict('שלום עולם'), 'clean');
	const [m] = engine.scan('שורה\nמשהו פורנו כאן', FULL);
	assert.strictEqual(m.line, 2);
	assert.strictEqual(m.level, 'problem');
});

test('allow list (suggested) clears ambiguous uses but not the real word', () => {
	for (const t of ['המין האנושי', 'מינים בסכנת הכחדה', 'אתר מורשת של אונסק"ו', 'בואנוס איירס', 'הקיסר אדריאנוס',
		'הממצאים חשפו', 'דוכס סקסוניה', 'טרנסילבניה', 'כל מיני כלים', 'בשוגג או באונס', '[[מין (טקסונומיה)|מין]] של ציפור']) {
		assert.strictEqual(verdict(t), 'clean', t);
	}
	for (const t of ['היא הייתה אנוסה', 'הוא אנס אותה', 'זוג מאותו המין', 'תעשיית הפורנו', 'אלבום Fuck You']) {
		assert.notStrictEqual(verdict(t), 'clean', t);
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
	assert.strictEqual(engine.verdict(engine.scan('לפני מיליון שנה', ACTIVE)), 'clean'); // לא פעיל עד אישור
});
