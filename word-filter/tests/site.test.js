// דפי הרשימות לאתר (site/, tools/build-site.js): מעודכנים, ונותנים בדיוק את אותה סריקה כמו lists/.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const engine = require('../Gadget-wikitextWordCheck.js');
const { build, text, SITE } = require('../tools/build-site.js');

const lists = (name) => require('../lists/' + name);
const site = build();
const pageOf = (name) => site['Gadget-wikitextWordCheck-' + name + '.json'];

test('site files are up to date with lists/', () => {
	for (const [name, obj] of Object.entries(site)) {
		assert.strictEqual(fs.readFileSync(path.join(SITE, name), 'utf8'), text(obj), name + ' - להריץ node word-filter/tools/build-site.js');
	}
});

test('the data module requires every list page', () => {
	const data = fs.readFileSync(path.join(SITE, 'Gadget-wikitextWordCheck-data.js'), 'utf8');
	const def = fs.readFileSync(path.join(SITE, 'Gadgets-definition.txt'), 'utf8');
	for (const name of ['words', 'allow', 'usage', 'context']) {
		assert.ok(data.includes("require('./wikitextWordCheck-" + name + ".json')"), name);
		assert.ok(def.includes('|wikitextWordCheck-' + name + '.json'), name);
	}
});

// הסריקה המלאה (רשימות, הקשר, מילות הקשר, קוד מוסתר) על lists/ ועל העותק לאתר
function full(words, allow, usage, context, suggested, wikitext) {
	const compiled = engine.compileLists(words, allow, { suggested });
	const clues = engine.compileClues(context, { suggested });
	const matches = engine.contextLevels(wikitext, engine.scan(wikitext, compiled), usage, clues);
	const strip = (m) => ({ text: m.text, start: m.start, level: m.level, topic: m.topic, ids: m.entries.map((e) => e.id),
		demoted: m.demotedBy.map((e) => e.id), context: m.context, hidden: m.hidden });
	return { matches: matches.map(strip), hidden: engine.scanHidden(wikitext, compiled, matches).map(strip),
		verdict: engine.contextVerdict(matches), problems: compiled.problems.length + clues.problems.length };
}

const SAMPLES = [
	'הוא הורשע באונס ונידון למאסר. היא שחקנית פורנו לשעבר.',
	'המין האנושי. מין של חרק ממשפחת החיפושיתיים. רומן היסטורי שיצא ב-1990.',
	'[[מין (ביולוגיה)|מין]]ים רבים. האלבום השני של הלהקה. לפני 4 מיליארד שנים נוצר כדור הארץ.',
	'<!-- הערה עם סקס --> {{תבנית|שם=רומנו}} [[אונס נערה (הלכה)|עינוי]] ישו הנוצרי. על פי ישוע.',
	'היא דוגמנית וזמרת. נישואים בין בני אותו המין. גזע, דת, מין. בואנוס איירס. אלוהים.'
];

for (const suggested of [false, true]) {
	test('site lists scan exactly like lists/ (suggested=' + suggested + ')', () => {
		for (const t of SAMPLES) {
			const a = full(lists('words.json'), lists('allow.json'), lists('usage.json'), lists('context.json'), suggested, t);
			const b = full(pageOf('words'), pageOf('allow'), pageOf('usage'), pageOf('context'), suggested, t);
			assert.deepStrictEqual(b, a, t);
			assert.ok(a.matches.length > 0, t);
			if (t.startsWith('הוא הורשע')) assert.ok(a.matches.some((m) => m.context && m.context.clues), 'clues applied');
		}
	});
}

test('site lists keep every usable entry and nothing else', () => {
	for (const name of ['words', 'allow']) {
		const usable = lists(name + '.json').entries.filter((e) => ['active', 'suggested'].includes(e.status)).map((e) => e.id);
		assert.deepStrictEqual(pageOf(name).entries.map((e) => e.id), usable, name);
	}
	assert.ok(!JSON.stringify(pageOf('words')).includes('"merged"'));
});

// השדות שהעותק לאתר משמיט: המנוע לא קורא אותם. חריגים: note של רשומת מילה - הערות החלטה ארוכות,
// לעורכים לא נחוצות (בהיתרים note נשאר, הוא מוצג בחלון הריחוף); kind של רשומת מילה - תיעוד
// (phrases/missing), המנוע קורא kind רק בהיתרים.
const DROPPED = {
	words: ['sources', 'original', 'mergeNote', 'reviewed', 'reviewNote', 'mergedInto', 'root', 'note', 'kind'],
	allow: ['sources', 'reviewed', 'reviewNote', 'original', 'root', 'phrases', 'extra'],
	context: ['label', 'note']
};

test('site entries equal lists/ entries minus the dropped fields, which the engine never reads', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'Gadget-wikitextWordCheck.js'), 'utf8');
	for (const name of ['words', 'allow', 'context']) {
		const byId = Object.fromEntries(pageOf(name).entries.map((e) => [e.id, e]));
		for (const e of lists(name + '.json').entries.filter((x) => ['active', 'suggested'].includes(x.status))) {
			const expected = Object.fromEntries(Object.entries(e).filter(([k]) => !DROPPED[name].includes(k)));
			assert.deepStrictEqual(byId[e.id], expected, name + ' ' + e.id);
		}
		for (const k of DROPPED[name]) if (k !== 'note' && k !== 'kind') assert.ok(!new RegExp('\\b(?:entry|e)\\.' + k + '\\b').test(src), k + ' is read by the engine');
	}
});

// גרסת הסריקה (scan-missing.js, listsVersion) סופרת את קובץ הגאדג'ט רק עד הממשק: שינוי בממשק לא גורם לסריקה מחדש.
// לכן הסימון חייב להופיע פעם אחת, אחרי כל המנוע (core) ולפני הממשק.
test('scan version covers the engine and stops at the UI marker', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'Gadget-wikitextWordCheck.js'), 'utf8');
	const marker = '// ===== ממשק - רק בתוך מדיה ויקי';
	assert.strictEqual(src.split(marker).length, 2);
	assert.ok(src.indexOf('var core = {') < src.indexOf(marker));
	assert.ok(src.indexOf(marker) < src.indexOf("if (typeof mw === 'undefined')"));
	assert.match(require('../tools/scan-missing.js').listsVersion(), /^[0-9a-f]{12}$/);
});

// הממשק והמנוע באותה פונקציה: הצהרה בממשק בשם של פונקציה במנוע דורסת אותה גם בסריקה (כך קרה ל-groupOf).
test('the UI does not redeclare engine names', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'Gadget-wikitextWordCheck.js'), 'utf8');
	const cut = src.indexOf('// ===== ממשק - רק בתוך מדיה ויקי');
	// שמות ברמה העליונה של הקובץ (טאב אחד) - משתנים מקומיים בתוך פונקציות לא דורסים זה את זה
	const names = (t) => new Set([...t.matchAll(/^\t(?:function|var|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
	const engineNames = names(src.slice(0, cut));
	const clash = [...names(src.slice(cut))].filter((n) => engineNames.has(n));
	assert.deepStrictEqual(clash, []);
});
