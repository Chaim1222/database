#!/usr/bin/env node
/*
 * הסבה חד-פעמית: שני דפי הרשימות הקיימים במכלול (במח, בומח) + התוספות
 * שהצעתי + מילים חדשות שאני מציע  ->  lists/words.json, lists/allow.json.
 *
 * אחרי ההסבה, קובצי ה-JSON הם מקור האמת ועורכים אותם ישירות (או דרך דף
 * הסקירה). הסקריפט נשאר בריפו לתיעוד - כדי שאפשר יהיה לראות בדיוק איך כל
 * רשומה נוצרה. הרצה חוזרת דורסת את קובצי ה-JSON.
 *
 * שדות של רשומה ב-words.json:
 *   id           - מזהה יציב (w0001...).
 *   pattern      - ביטוי רגולרי (JS).
 *   level        - "problem" (בעיה ודאית) / "review" (דו-משמעי, לבדיקה).
 *   topic        - modesty / faith / dating / wiki.
 *   status       - "active" (פעיל) / "suggested" (הצעה - לא פעיל עד אישור).
 *   reviewed     - האם אדם אישר את הרמה והנושא. בהסבה: false לכולם.
 *   caseSensitive- true לרשומות מבמח (שם אין דגל i).
 *   scope        - "raw" = לבדוק גם בקוד שהקורא לא רואה (כרגע אין רשומות כאלה).
 *   sources      - מאיפה הגיעה (במח/אדום כהה, בומח/צניעות, הצעת Claude).
 *   original     - התבנית כפי שהייתה בדף, אם תוקנה.
 *   note         - מה התבנית נועדה לתפוס / למה תוקנה.
 *
 * הרצה: node word-filter/tools/build-lists.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'sources', name), 'utf8');
const BS = String.fromCharCode(92);
const HEB = BS + 'u0590-' + BS + 'u05FF';

// ===== תיקוני תבניות שבורות (ראו את ההסבר בכל אחת) =====
const FIXES = {
	'(?<!יו)א[ו]*נ[ו]*ס^ק': ['(?<!יו)א[ו]*נ[ו]*ס(?!ק)',
		'במקור ^ק - באמצע תבנית ^ הוא "תחילת טקסט", ולכן לא התאימה אף פעם. הכוונה: לא ואחריו ק (אונסק"ו).'],
	'רומ+[נן]+^יה': ['רומ+[נן]+(?![יה])',
		'במקור ^יה - לא התאימה אף פעם. הכוונה: [^יה], לא ואחריו י או ה (רומני, רומניה).'],
	'(?<!ל)לסביםוזית': ['לסבי(?:ם|ות|ית)', 'במקור טקסט משובש (לסביםוזית) - לא התאים אף פעם.'],
	['{{כ}}(?<=' + BS + 's)זין']: ['(?<!כלי )(?<![' + HEB + '])זין(?![' + HEB + '])',
		'במקור {{כ}}(?<=\\s)זין - אחרי }} לא יכול לבוא רווח, לא התאימה אף פעם. הכוונה: "זין" כמילה בודדת, לא "כלי זין".'],
	'^שדי$': ['(?<![' + HEB + '])שדי(?![' + HEB + '])', 'במקור ^...$ - מתאים רק אם כל הדף הוא המילה. הכוונה: מילה בודדת.'],
	'^(אלים)$': ['(?<![' + HEB + '])אלים(?![' + HEB + '])', 'במקור ^...$ - מתאים רק אם כל הדף הוא המילה. הכוונה: מילה בודדת.'],
	'שדי$': ['(?<![' + HEB + '])שדי(?![' + HEB + '])', 'במקור $ - מתאים רק בסוף הדף. הכוונה: מילה בודדת.'],
	'[^(ת|מ|ארי)]זונ(ה|ות)': ['(?<!ארי|ת|מ)זונ(?:ה|ות)',
		'במקור [^(ת|מ|ארי)] - רשימת אותיות אסורות, לא "לא אחרי המילה". הכוונה: לא תזונה, מזונות, אריזונה.'],
	'[^(ת|ארי)]זונה': ['(?<!ארי|ת)זונה', 'במקור [^(ת|ארי)] - רשימת אותיות במקום "לא אחרי המילה".'],
	'[^(דו)]לפין': ['(?<!דו)לפין', 'במקור [^(דו)] - חוסם כל ד או ו, לא את "דו" (דולפין).'],
	'האל[^ימות(קט)]': ['האל(?![ימות]|קט)', 'במקור (קט) בתוך [] - חוסם ק או ט בודדים, לא את הרצף "קט".'],
};

// ===== נושא לכל רשימה =====
const BMH_LISTS = {
	'אדום כהה': { topic: 'modesty', level: 'problem' },
	'אדום בהיר': { topic: 'dating', level: 'review' },
	'ירוק': { topic: 'modesty', level: 'review' },
	'כחול': { topic: 'faith', level: 'review' },
	'צהוב': { topic: 'faith', level: 'review' },
	// בגאדג'ט המקורי הרשימה הסגולה רצה על הדף המוצג. על כל הקוד היא תופסת 95% מערכי המכלול
	// ("ויקיפדיה" בתבניות ובקטגוריות), ועל הטקסט המוצג בלבד - 1.6%.
	'סגול': { topic: 'wiki', level: 'review' },
};
// בבלוק ה"כללי" של בומח מעורבבים שלושה נושאים. החלוקה לקוחה מ-problematic_words.py,
// שכבר מיין את בומח לפי נושא.
const BOMAH_GENERAL_MODESTY = ['סירוס', 'בת לוויה', 'הצעת [ה]נישואי[םן]', 'אקרנים', 'שחיינית', 'אישות',
	'אש[כך][יהום](\\s|$)', 'כ[ו]*ח גברא', 'הזד[ו]*וגות', 'חיזור[הים]', 'נרתיק'];
const BOMAH_GENERAL_DATING_FIRST = 'אבולוצי[הונרית]';
const BOMAH_GENERAL_FAITH_FIRST = '(?<!או)ישו(\\s|$)';

// ===== מילים חדשות שאני מציע (status: suggested) - נעבור עליהן יחד =====
// [תבנית, רמה משוערת, הסבר]
const CLAUDE_NEW_WORDS = [
	['אוננות', 'problem', 'שם העצם (ברשימות יש רק את הפעלים לאונן/מאונן).'],
	['נואפ(?:ת|ים|ות)(?![א-ת])', 'problem', 'נואפת, נואפים (ברשימות יש רק "נואף").'],
	['שרמוט(?:ה|ות)', 'problem', 'כינוי גס לזונה.'],
	['קוקסינל', 'problem', 'כינוי גנאי.'],
	['סט(?:ר|רי)פטיז', 'problem', 'חשפנות (סטריפטיז/סטרפטיז).'],
	['ויברטור|דילדו', 'problem', 'אביזרי מין.'],
	['פוליאמורי', 'problem', 'פוליאמוריה.'],
	['(?:מין|סקס) אוראלי', 'problem', 'ברשימות יש "מין אנאלי" אבל לא אוראלי.'],
	['סטוץ', 'problem', 'סלנג - קשר מיני חד-פעמי.'],
	['אונליפאנס|OnlyFans', 'problem', 'אתר תוכן מיני.'],
	['הנטאי|' + BS + 'bhentai' + BS + 'b', 'problem', 'אנימה פורנוגרפית.'],
	['מילף|' + BS + 'bMILF' + BS + 'b', 'problem', 'סלנג מיני.'],
	['(?<![א-ת])כוסי(?:ת|יות)(?![א-ת])', 'review', 'סלנג גס, אבל גם "כוסית" = כוס קטנה - לכן לבדיקה.'],
	['מניאק', 'review', 'קללה (לא מינית).'],
	['(?<![א-ת])[ובלה]?פרוצ(?:ה|ות)(?![א-ת])', 'review', 'זונה - אבל גם "פרוצה" = פרוצה/פתוחה (עיר פרוצה).'],
	['פטמ(?:ה|ות)(?![א-ת])', 'review', 'פטמה - אבל גם פטמת האתרוג.'],
	['משכב זכר', 'review', 'מונח הלכתי - מופיע גם בערכי הלכה.'],
	['גילוי עריות|(?<![א-ת])[ובלה]?עריות(?![א-ת])', 'review', 'מונח הלכתי.'],
	['מחשוף', 'review', 'מחשוף בבגד - אבל גם מחשוף פיננסי/בנקאי.'],
	['חצאית מיני|מיני[- ]?חצאית|מיניז?סקירט', 'review', 'חצאית קצרה.'],
	['שפיכה', 'review', 'שפיכת זרע - אבל גם שפיכה/שפיכת דמים.'],
	['(?<![א-ת])[וה]?זקפה(?![א-ת])', 'review', 'זקפה - אבל גם זקיפה (חשבונאות).'],
	[BS + 'bLGBT' + BS + 'w*', 'problem', 'באנגלית, כמו להט"ב ברשימה האדומה.'],
	[BS + 'b(?:lesbian|homosexual|bisexual|transgender)' + BS + 'w*', 'problem', 'באנגלית, כמו המקבילות העבריות ברשימה האדומה.'],
	[BS + 'bqueer' + BS + 'w*', 'problem', 'באנגלית, כמו "קוויר" ברשימה האדומה.'],
	[BS + 'b(?:blow|hand)job' + BS + 'w*', 'problem', 'מין - באנגלית.'],
	[BS + 'borgasm' + BS + 'w*', 'problem', 'באנגלית (אורגזמה ברשימה האדומה).'],
	[BS + 'bmasturbat' + BS + 'w*', 'problem', 'אוננות - באנגלית.'],
	[BS + 'berotic' + BS + 'w*', 'problem', 'ארוטי - באנגלית.'],
	[BS + 'bfetish' + BS + 'w*', 'problem', 'פטיש מיני - באנגלית.'],
	[BS + 'bthreesome' + BS + 'w*|' + BS + 'borg(?:y|ies)' + BS + 'b', 'problem', 'באנגלית.'],
	[BS + 'bprostitut' + BS + 'w*|' + BS + 'bbrothel' + BS + 'w*', 'problem', 'זנות, בית בושת - באנגלית.'],
	[BS + 'b(?:cunt|twat|wank)' + BS + 'w*', 'problem', 'קללות גסות - באנגלית.'],
	[BS + 'bboobs?' + BS + 'b|' + BS + 'btits' + BS + 'b', 'problem', 'סלנג לחזה ("tit" לבד לא - שם של ציפור).'],
	[BS + 'b(?:penis|vagina|clitor|testicl)' + BS + 'w*', 'problem', 'איברי מין - באנגלית.'],
	[BS + 'bnipples?' + BS + 'b', 'problem', 'באנגלית.'],
	[BS + 'bpant(?:y|ies)' + BS + 'b', 'problem', 'תחתונים - באנגלית.'],
	[BS + 'bplayboy' + BS + 'b', 'problem', 'ברשימה האדומה יש רק "פלייבוי" בעברית.'],
	[BS + 'bhooker' + BS + 'w*', 'review', 'זונה - אבל גם עמדה ברוגבי.'],
	[BS + 'b(?:rape[ds]?|raping|rapist' + BS + 'w*)' + BS + 'b', 'review', 'אונס - אבל גם שם של יצירות ("The Rape of the Sabine Women").'],
	[BS + 'bXXX' + BS + 'b', 'review', 'תוכן למבוגרים - אבל גם הספרה הרומית 30 (Super Bowl XXX).'],
];

// ===== פירוק דפי הרשימות =====
function splitAlternatives(source) {
	const parts = [];
	let current = '', depth = 0, inClass = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === BS && i + 1 < source.length) {
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
	const result = {};
	const sections = text.split(/^==\s*([^=\n]+?)\s*==\s*$/m);
	for (let i = 1; i + 1 < sections.length; i += 2) {
		const blocks = sections[i + 1].split(/<!--\s*-->/);
		if (BMH_LISTS[sections[i]] && blocks.length >= 3) result[sections[i]] = splitAlternatives(blocks[1].trim());
	}
	return result;
}

// פורמט בומח: אחרי -----, בלוקים מופרדים ב-<!-- -->, שורות *תבנית// הסבר.
function parseAnnotated(text) {
	const body = text.includes('-----') ? text.slice(text.indexOf('-----') + 5) : text;
	return body.split(/<!--\s*-->/).map((block) => block.split('\n').map((l) => l.trim())
		.filter((l) => l.includes('//'))
		.map((l) => ({ star: l[0] === '*', pattern: l.replace(/^\*/, '').split('//')[0].trim(),
			note: l.slice(l.indexOf('//') + 2).trim(), line: l })));
}

// ===== בנייה =====
const entries = [];
const byPattern = new Map();
const problems = [];

function add(pattern, fields, source) {
	if (!pattern.trim()) {
		problems.push(`${source}: חלופה ריקה (| מיותר) - הושמטה`);
		return;
	}
	const fix = FIXES[pattern];
	const effective = fix ? fix[0] : pattern;
	const existing = byPattern.get(effective);
	if (existing) {
		if (!existing.sources.includes(source)) existing.sources.push(source);
		// במח תלוי רישיות, בומח לא. תבנית שמופיעה בשניהם - בלי תלות ברישיות.
		if (!fields.caseSensitive) delete existing.caseSensitive;
		return;
	}
	const entry = { id: '', pattern: effective, level: fields.level, topic: fields.topic, status: fields.status || 'active',
		reviewed: false };
	if (fields.caseSensitive) entry.caseSensitive = true;
	if (fields.scope) entry.scope = fields.scope;
	entry.sources = [source];
	if (fix) entry.original = pattern;
	const note = fix ? fix[1] : fields.note;
	if (note) entry.note = note;
	try {
		new RegExp(effective); // בדיקת תקינות
	} catch (e) {
		problems.push(`${source}: תבנית לא תקינה ${pattern}: ${e.message}`);
		return;
	}
	byPattern.set(effective, entry);
	entries.push(entry);
}

for (const [list, patterns] of Object.entries(parseBmh(read('bmh.txt')))) {
	for (const p of patterns) add(p, { ...BMH_LISTS[list], caseSensitive: true }, 'במח/' + list);
}

const [bomahModesty, bomahGeneral] = parseAnnotated(read('bomah.txt'));
for (const item of bomahModesty) {
	if (!item.star) continue;
	add(item.pattern, { topic: 'modesty', level: 'problem' }, 'בומח/צניעות');
}
let generalTopic = 'dating';
for (const item of bomahGeneral) {
	if (!item.star) {
		problems.push(`בומח/כללי: השורה "${item.line}" לא מתחילה ב-* - הגאדג'ט מתעלם ממנה; הושמטה`);
		continue;
	}
	if (item.pattern === BOMAH_GENERAL_DATING_FIRST) generalTopic = 'dating';
	if (item.pattern === BOMAH_GENERAL_FAITH_FIRST) generalTopic = 'faith';
	const topic = BOMAH_GENERAL_MODESTY.includes(item.pattern) ? 'modesty' : generalTopic;
	add(item.pattern, { topic, level: 'review' }, 'בומח/כללי');
}

const [extraModesty, extraGeneral] = parseAnnotated(read('claude-extra.txt'));
for (const item of extraModesty) add(item.pattern, { topic: 'modesty', level: 'problem', status: 'suggested', note: item.note }, 'הצעת Claude');
for (const item of extraGeneral) {
	const topic = /ישוע/.test(item.pattern) ? 'faith' : 'modesty';
	add(item.pattern, { topic, level: 'review', status: 'suggested', note: item.note }, 'הצעת Claude');
}
for (const [pattern, level, note] of CLAUDE_NEW_WORDS) {
	add(pattern, { topic: 'modesty', level, status: 'suggested', note }, 'הצעת Claude (מילה חדשה)');
}

entries.forEach((e, i) => { e.id = 'w' + String(i + 1).padStart(4, '0'); });

const allow = parseAnnotated(read('claude-allow.txt'))[0].map((item, i) => ({
	id: 'a' + String(i + 1).padStart(3, '0'), pattern: item.pattern, status: 'suggested', reviewed: false,
	sources: ['הצעת Claude'], note: item.note,
}));

const meta = {
	levels: { problem: 'בעיה ודאית', review: 'לבדיקה (דו-משמעי)' },
	topics: { modesty: 'צניעות', faith: 'אמונה ונצרות', dating: 'תיארוך ומדע', wiki: 'שאריות מוויקיפדיה' },
	statuses: { active: 'פעיל', suggested: 'הצעה - לא פעיל עד אישור' },
};
const out = path.join(ROOT, 'lists');
fs.writeFileSync(path.join(out, 'words.json'), JSON.stringify({ version: 1, ...meta, entries }, null, '\t') + '\n');
fs.writeFileSync(path.join(out, 'allow.json'), JSON.stringify({ version: 1, entries: allow }, null, '\t') + '\n');

const count = (f) => entries.filter(f).length;
console.log(`words.json: ${entries.length} רשומות (${count((e) => e.status === 'active')} פעילות, ` +
	`${count((e) => e.status === 'suggested')} הצעות), ${count((e) => e.original)} תוקנו`);
console.log(`allow.json: ${allow.length} רשומות (כולן הצעות)`);
problems.forEach((p) => console.log('  ! ' + p));
