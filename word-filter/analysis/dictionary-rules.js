// כללים לזיהוי ערך שאמור להיות מיובא כ"ערך מילוני" (המכלול:מדיניות ערכים מילוניים).
// ראו analysis/dictionary-rules.md. הצעה - לא מחובר למנוע, לסריקה או לדשבורד.
//
//   const { classifyText } = require('./dictionary-rules');
//   classifyText(wikitext) -> { tier: 'strong' | 'weak', cls, why } או null
//
// הרצה (מדידה על המדגמים המתויגים, בלי רשת): node word-filter/analysis/dictionary-rules.js [--errors]
'use strict';

// תבנית מידע -> ודאי. הסוג לפי תבניות הבוט במכלול ({{בוט ספורט}}, {{בוט מוזיקאים}}...).
const INFOBOX_STRONG = [
	['ספורט', /^(אישיות (כדורגל|כדורסל|כדורעף|כדוריד|הוקי|בייסבול|פוטבול|טניס|ספורט|אתלטיקה|קריקט|רוגבי)|ספורטאי|טניסאי|מתאבק|מתאגרף|לוחם|רוכב אופניים|שחיין|מתעמל|גולפאי|נהג מרוצים|קבוצת |מועדון ספורט|תחרות |נבחרת|משחק ספורט|עונת |ליגת|מדינה במשחקים|משחקים אולימפיים|אליפות|מרוץ|גביע|דרבי|טורניר|פדרציית ספורט)/],
	['מוזיקה', /^(סינגל|אלבום|תצוגת שם|פירוט דיסקוגרפיה|להקה|מדינה באירוויזיון|סיבוב הופעות|חברת תקליטים)$/],
	['מוזיקאים', /^(מוזיקאי)$/],
	['שחקנים', /^(אישיות משחק|דוגמן|דוגמנית)$/],
	['סרטים', /^(סרט|טקס פרסי קולנוע|דמות בדיונית|מוצר עתידי)$/],
	['טלוויזיה', /^(תוכנית טלוויזיה|סדרת טלוויזיה|פרק טלוויזיה|אנימהמאנגה|ערוץ טלוויזיה)$/],
];
// קטגוריה -> ודאי (כשאין תבנית מידע מכריעה).
const CATEGORY_STRONG = [
	['ספורט', /(כדורגלני|כדורסלני|כדורעפני|כדורידני|שחקני (כדור|טניס|הוקי|בייסבול|פוטבול|גולף|קריקט|רוגבי)|אתלטים|אתלטיות|ספורטאים|ספורטאיות|טניסאי|שחייני|מתעמלי|מתאגרפי|מתאבקי|רוכבי אופניים|נהגי מרוצים|מאמני כדור|קבוצות כדור|באולימפיאדת|שופטי כדור|אליפויות |ליגות |עונות ב|: כדורגל|: כדורסל|תחרויות (ספורט|אתלטיקה|שחייה))/],
	['מוזיקה', /((?<![א-ת])(מוזיקאים|מוזיקאיות|נגני|מנצחים|מלחינים|פסנתרנים|כנרים|צ'לנים|רקדני|רקדנים|רקדניות|כוריאוגרפים|כוריאוגרפיות|זמרי|זמרים|זמרות|להקות|פסטיבלי (קולנוע|מוזיקה)|מצעדי|יצירות בלט|מחזות זמר|אופרות|אופרטות)|סינגלים|אלבומי |דיסקוגרפיות|ראפרים|תקליטנים|משתתפי אירוויזיון|באירוויזיון|אמני [^ ]+ ?רקורדס|אמניות [^ ]+ ?רקורדס|חברות תקליטים|סבבי הופעות)/],
	['שחקנים', /(שחקני קולנוע|שחקני טלוויזיה|שחקניות|שחקני תיאטרון|דוגמנים|דוגמניות|מנחי טלוויזיה|יוטיוברים|סטנדאפיסטים|קומיקאים|מדבבים|במאי קולנוע|במאי טלוויזיה|תסריטאי (קולנוע|טלוויזיה))/],
	['סרטים וטלוויזיה', /(^סרטי |^סרטים |סדרות טלוויזיה|סדרות אנימציה|תוכניות טלוויזיה|תוכניות מציאות|: תוכניות וסדרות|זיכיונות מדיה|דמויות ב)/],
];
// תבנית מידע -> אפשרי: המדיניות מעורבת (ספרי עיון, ספרות עברית, משחקי קופסה).
const INFOBOX_WEAK = [
	['משחקי מחשב', /^(משחק|משחק מחשב|משחק וידאו|סדרת משחקים)$/],
	['ספרות', /^(ספר|סדרת ספרים|קומיקס|מחזה|מאנגה)$/],
	['סופרים', /^(סופר)$/],
	['תרבות ובידור', /^(אמן|אצטדיון|פרס|פסטיבל)$/],
];
// מיובא כרגיל: תרבות חרדית ויהודית, שחמט. (מוזיקה קלאסית וחזנות - כן מילוניים במכלול.)
const EXCLUDE = /(רבנים|רבני |אדמו"רי|חסידות|חרדים|חרדיות|ישיבת|ישיבות|פייטנים|פיוטי|מוזיקה חסידית|זמרי מוזיקה יהודית|שחמט)/;
// שיר או אלבום בעברית: חלק מיובאים כרגיל (זמר עברי, מוזיקה יהודית) -> אפשרי.
const HEBREW_SONG = /(שירים בעברית|שירי ארץ ישראל|זמר עברי)/;
// תבנית מידע שאומרת "לא בידור" - לא בודקים קטגוריות.
const INFOBOX_NOT = /^(מנהיג|נושא משרה|מדען|אישיות רבנית|אישיות תקשורת|עיר|יישוב|מדינה|אישיות צבאית|מחשב|תוכנה|כלי רכב|מיון|משוואה|חלונית)$/;

// תבניות שאינן תבנית מידע (תחזוקה, הפניות) - מדלגים עליהן בחיפוש תבנית המידע.
const NOT_INFOBOX = /^(פירוש נוסף|לשכתב|עריכה|שכתוב|מקורות|אין מקורות|ערך מחפש מקורות|הבהרה|דגל|DISPLAYTITLE|לא לבלבל|בעבודה|קצרמר|שם|סימן|מיזוג|ערך מחקרי|מקור|להשלים|רשימה|ללא|לפצל|עדכון|חסר)/;

function infoboxOf(text) {
	const found = text.replace(/<!--[\s\S]*?-->/g, '').match(/\{\{\s*([^|}\n]+?)\s*(?:\n|\|)/g) || [];
	for (const raw of found) {
		const name = raw.replace(/^\{\{\s*/, '').replace(/\s*[\n|]$/, '').trim();
		if (!NOT_INFOBOX.test(name) && !name.includes(':')) return name;
	}
	return null;
}
const categoriesOf = (text) => (text.match(/\[\[\s*(?:קטגוריה|Category)\s*:([^\]|]+)/gi) || [])
	.map((c) => c.replace(/^\[\[\s*[^:]+:/, '').trim());

// page = {ib: שם תבנית המידע או null, cats: [קטגוריות]}
function classify(page) {
	const cats = page.cats || [];
	if (cats.some((c) => EXCLUDE.test(c))) return null;
	if (page.ib) {
		for (const [cls, re] of INFOBOX_STRONG) {
			if (!re.test(page.ib)) continue;
			if (cls === 'מוזיקה' && cats.some((c) => HEBREW_SONG.test(c))) return { tier: 'weak', cls, why: 'תבנית ' + page.ib + ' + שיר בעברית' };
			return { tier: 'strong', cls, why: 'תבנית ' + page.ib };
		}
		if (INFOBOX_NOT.test(page.ib)) return null;
	}
	for (const [cls, re] of CATEGORY_STRONG) {
		const hit = cats.find((c) => re.test(c));
		if (hit) return { tier: 'strong', cls, why: 'קטגוריה ' + hit };
	}
	if (page.ib) for (const [cls, re] of INFOBOX_WEAK) if (re.test(page.ib)) return { tier: 'weak', cls, why: 'תבנית ' + page.ib };
	return null;
}
const classifyText = (text) => classify({ ib: infoboxOf(text), cats: categoriesOf(text) });

module.exports = { classify, classifyText, infoboxOf, categoriesOf };

if (require.main === module) {
	const { rows } = require('./dictionary-samples.json');
	const showErrors = process.argv.includes('--errors');
	for (const set of ['train', 'test']) {
		const sample = rows.filter((r) => r.set === set);
		const real = sample.filter((r) => r.y === 'dict').length;
		console.log(`\n${set === 'train' ? 'מדגם הכתיבה' : 'מדגם הבדיקה'} (${sample.length} ערכי מכלול אקראיים; ${real} מילוניים, ` +
			`${sample.filter((r) => r.y === 'plain').length} רגילים, ${sample.filter((r) => r.y === 'other').length} אחר)`);
		let found = 0;
		for (const tier of ['strong', 'weak']) {
			const flagged = sample.filter((r) => (classify(r) || {}).tier === tier);
			const ok = flagged.filter((r) => r.y === 'dict').length;
			found += ok;
			console.log(`  ${tier === 'strong' ? 'ודאי ' : 'אפשרי'}: סומנו ${flagged.length}, נכונים ${ok} (דיוק ${(100 * ok / flagged.length).toFixed(1)}%), ` +
				`כיסוי מצטבר ${(100 * found / real).toFixed(1)}%`);
		}
		if (!showErrors) continue;
		for (const r of sample.filter((x) => classify(x) && classify(x).tier === 'strong' && x.y !== 'dict')) console.log('    סומן, רגיל:', r.t, '|', classify(r).why);
		for (const r of sample.filter((x) => !classify(x) && x.y === 'dict')) console.log('    פוספס:', r.t, '|', r.cls, '|', r.ib);
	}
	const bySort = {};
	for (const r of rows.filter((x) => x.set === 'class')) {
		const s = bySort[r.cls] || (bySort[r.cls] = [0, 0]);
		s[1]++;
		if (classify(r)) s[0]++;
	}
	console.log('\nכיסוי לפי סוג (מדגם לכל תבנית בוט): ' + Object.entries(bySort).map(([c, [a, b]]) => `${c} ${Math.round(100 * a / b)}%`).join(' · '));
}
