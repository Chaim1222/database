// למה ערכים חסומים יוצאים "נקי" - האותות המועמדים. ראו analysis/blocked-clean.md.
// הרצה: node word-filter/analysis/blocked-clean.js
// דורש את המדגמים ב-.word-filter-corpus/ (שחזור מהענף word-filter-corpus). בלי רשת:
// כל האותות כאן מחושבים מהוויקיטקסט ומהכותרת בלבד, כך שאפשר להכניס אותם למנוע כמו שהם.
'use strict';
const path = require('path');
const { engine, loadLists, loadCorpora } = require(path.join(__dirname, '..', 'tools', 'lib'));

const corpora = loadCorpora();
const lists = loadLists({ suggested: true });

// טקסט קריא בערך, לפתיח בלבד: בלי הערות, הערות שוליים, תבניות, קבצים וקטגוריות.
const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[\s\S]*?<\/ref>|<ref[^>]*\/>/g, ' ')
	.replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\{\{[^{}]*\}\}/g, ' ')
	.replace(/\[\[(?:קובץ|File|תמונה|Image|קטגוריה|Category):[^\]]*(\[\[[^\]]*\]\][^\]]*)*\]\]/gi, ' ')
	.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '');
const lead = (t) => { const s = strip(t); const i = s.search(/[א-ת]/); return s.slice(i, i + 400); };
const categories = (t) => (t.match(/\[\[\s*(?:קטגוריה|Category)\s*:([^\]|]+)/gi) || []).map((c) => c.replace(/^\[\[\s*[^:]+:/, '').trim());

const ENT_F = 'זמרת|שחקנית|דוגמנית|רקדנית|בלרינה|מנחת|מגישת|שדרנית|מלכת יופי|ראפרית|קומיקאית|יוטיוברית|מוזיקאית|בדרנית';
const SPORT_F = 'אתלטית|ספורטאית|אלופת|טניסאית|כדורסלנית|כדורגלנית|כדורעפנית|שחיינית|מתעמלת|אצנית|רוכבת|גולפאית|מחליקת|קופצת|מתאבקת|מתאגרפת';
const LEAD_F = new RegExp('(היא|הייתה)[^.]{0,40}(?:' + ENT_F + '|' + SPORT_F + ')');
const CAT_F = /(זמרות|שחקניות|דוגמניות|רקדניות|בלרינות|מגישות|שדרניות|מלכות יופי|ראפריות|אתלטיות|אלופות|ספורטאיות|שחייניות|מתעמלות|טניסאיות|כדורסלניות|כדורגלניות|כדורעפניות|אצניות|קופצות|גולפאיות|מחליקות|מתאגרפות|מתאבקות)/;
const TITLE = /\b(hot|fu[c]?k\w*|shit\w*|missionary|smack|booty|bottomed|sexy?)\b|(?<![א-ת])זיון(?![א-ת])/i;
const CLUB = /מועדוני (ג'אז|לילה|חשפנות)/;

const SIGNALS = {
	'א. אישה בבידור/ספורט (פתיח או קטגוריה)': (p) => LEAD_F.test(lead(p.text)) || categories(p.text).some((c) => CAT_F.test(c)),
	'   רק הפתיח ("היא זמרת")': (p) => LEAD_F.test(lead(p.text)),
	'   רק הקטגוריה ("זמרות...")': (p) => categories(p.text).some((c) => CAT_F.test(c)),
	'ב. כותרת בוטה': (p) => TITLE.test(p.title),
	'ג. קטגוריית מועדון לילה/ג\'אז': (p) => categories(p.text).some((c) => CLUB.test(c)),
};
SIGNALS['א+ב+ג'] = (p) => ['א.', 'ב.', 'ג.'].some((k) => SIGNALS[Object.keys(SIGNALS).find((x) => x.startsWith(k))](p));

const verdict = (p) => engine.verdict(engine.scan(p.text, lists));
const loose = (p) => ['clean', 'wording'].includes(verdict(p));
const groups = {
	'חסומים נקי/ניסוח': Object.values(corpora.blacklist).filter(loose),
	'מכלול נקי/ניסוח': [...Object.values(corpora.dev), ...Object.values(corpora.holdout)].filter(loose),
	'ויקיפדיה אקראית נקי/ניסוח': Object.values(corpora['wiki-random']).filter(loose),
};
console.log('אות | ' + Object.entries(groups).map(([g, a]) => `${g} (${a.length})`).join(' | '));
for (const [name, f] of Object.entries(SIGNALS)) {
	console.log(name + ' | ' + Object.values(groups).map((a) => {
		const n = a.filter(f).length;
		return `${n} (${(100 * n / a.length).toFixed(1)}%)`;
	}).join(' | '));
}
const union = SIGNALS['א+ב+ג'];
for (const g of ['מכלול נקי/ניסוח', 'ויקיפדיה אקראית נקי/ניסוח']) {
	console.log(`\n${g} שמסומנים (א+ב+ג): ` + groups[g].filter(union).map((p) => p.title).join(', '));
}
