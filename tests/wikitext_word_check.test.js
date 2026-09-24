// הרצה: node --test tests/wikitext_word_check.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../gadget/Gadget-wikitextWordCheck.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'suspicious_words_lists', f), 'utf8');
const LISTS = core.compileLists(read('bmh.txt'), read('bomah.txt'));
const found = (text, cat, raw) => core.scan(text, LISTS, { categories: cat ? [cat] : null, raw }).map((m) => m.text);

test('all patterns compile, broken ones reported', () => {
	assert.ok(LISTS.patterns.length > 400);
	const msgs = LISTS.problems.map((p) => p.category.key + ' ' + p.source);
	assert.ok(msgs.includes('bmh_blue '));
	assert.ok(msgs.includes('bomah_general אהב[תוה]//'));
	assert.strictEqual(LISTS.problems.filter((p) => p.message.startsWith('תוקנה')).length, 11);
});

test('fixed patterns', () => {
	assert.ok(found('הוא אנס אותה', 'bomah_modesty').includes('אנס'));
	assert.ok(found('זוג לסביות', 'bomah_modesty').includes('לסביות'));
	assert.deepStrictEqual(found('מדינת אריזונה', 'bmh_dark_red'), []);
	assert.deepStrictEqual(found('כלי זין רבים', 'bmh_dark_red'), []);
	assert.deepStrictEqual(found('דולפין', 'bmh_green'), []);
});

test('masking keeps only visible text, same length', () => {
	const t = '<!-- הערה -->{{תבנית|שם=ערך|חופשי}} [[יעד|כינוי]] [[ערך]] [[קובץ:ש.jpg|ממוזער|250px|כיתוב]] ' +
		'<ref name="n">מקור</ref> https://a.b/c [[קטגוריה:שם|מיון]] {{{1|פרמטר}}} <math>x</math> [[en:Foo]]';
	const masked = core.maskWikitext(t);
	assert.strictEqual(masked.length, t.length);
	assert.deepStrictEqual(masked.split(/\s+/).filter(Boolean), ['ערך', 'חופשי', 'כינוי', 'ערך', 'כיתוב', 'מקור', 'שם']);
});

test('hidden markup ignored, raw mode sees it', () => {
	const t = '<!-- סקס -->{{סקס}} [[סקס|ערך]] [[קובץ:sex.jpg|ממוזער]]';
	assert.deepStrictEqual(found(t, 'bmh_dark_red'), []);
	assert.ok(found(t, 'bmh_dark_red', true).length);
});

test('allow list and line numbers', () => {
	const t = 'שורה\nנמצא מין חדש של ציפור';
	const [m] = core.scan(t, LISTS, { categories: ['bmh_dark_red'] });
	assert.strictEqual(m.line, 2);
	assert.deepStrictEqual(core.scan(t, LISTS, { categories: ['bmh_dark_red'], allow: ['מין חדש'] }), []);
});
