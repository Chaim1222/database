#!/usr/bin/env node
/*
 * בונה את lists/usage.json: לכל "משפחה" (קבוצת הרשומות שתופסות יחד אותה מילה,
 * למשל "w0032,w0314" = רומן) - כמה מהמופעים המסווגים היו בעייתיים, ולאיזו קבוצה
 * המילה שייכת. המנוע משתמש בזה לרמות החשד (contextLevels).
 *
 *   A - בעייתית ב-75% ומעלה מהמופעים (הצעת חיים: "הופכת לעוגן").
 *   B - 40% עד 75%.
 *   C - פחות מ-40%.
 * משפחה עם פחות מ-MIN_LABELED מופעים מסווגים (בעייתי + תמים) לא נכנסת - המנוע
 * משתמש אז ברמה שברשימה.
 *
 * מקורות הסיווג (שניהם הצעה של Claude, לתיקון של חיים):
 *   analysis/missing-labels.json       - 1,800 מופעים מ"חסר במכלול" (60 מילים × 30).
 *   analysis/wiki-random-occurrences.json - 1,196 מופעים מוויקיפדיה אקראית.
 * שדה "override" במשפחה (A/B/C) גובר על החישוב - שם חיים קובע.
 *
 * המשפחה של כל מופע נקבעת בסריקה מחדש של המשפט שלו (analysis/missing-labels-contexts.json,
 * וההקשר ב-wiki-random-occurrences.json) עם הרשימות הנוכחיות, כולל ההצעות - כך המשפחות
 * מתאימות לרשומות גם אחרי איחוד כפילויות ותיקוני תבניות. מופע שכבר לא נתפס (היתר, תיקון) לא נספר.
 *
 *   node word-filter/tools/build-usage.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'lists', 'usage.json');
const THRESHOLDS = { A: 0.75, B: 0.4 };
const MIN_LABELED = 10;

const key = (entries) => [...new Set(entries)].sort().join(',');
const lib = require('./lib');
const LISTS = lib.loadLists({ suggested: true });
const MERGED = Object.fromEntries(lib.readJson('words.json').entries.filter((e) => e.mergedInto).map((e) => [e.id, e.mergedInto]));
const dropped = {};

// הרשומות שתופסות היום את המילה שבמרכז המשפט (before + x + after), או null.
function entriesNow(before, x, after, why) {
	before = (before || '').replace(/^…/, '');
	const text = before + x + (after || '').replace(/…$/, '');
	const from = before.length, to = from + x.length;
	const m = lib.engine.scan(text, LISTS).find((m) => m.topic === 'modesty' && m.start < to && m.end > from);
	if (!m) { dropped[why] = (dropped[why] || 0) + 1; return null; }
	return m.entries.map((e) => e.id);
}

function main() {
	const families = {};
	const occurrences = []; // [ids, label] - לחישוב העוגנים
	const add = (fam, label, source, word) => {
		occurrences.push([fam.split(','), label]);
		const f = (families[fam] = families[fam] || { word: '', words: {}, p: 0, i: 0, u: 0, sources: {} });
		// השם של המשפחה - המילה הנפוצה ביותר בין המופעים שלה.
		if (word) {
			f.words[word] = (f.words[word] || 0) + 1;
			f.word = Object.entries(f.words).sort((x, y) => y[1] - x[1])[0][0];
		}
		f[label]++;
		f.sources[source] = (f.sources[source] || 0) + 1;
	};

	const missing = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'missing-labels.json'), 'utf8'));
	const contexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'missing-labels-contexts.json'), 'utf8')).contexts;
	for (const [frank, l] of Object.entries(missing.labels)) {
		const fam = missing.families[frank];
		for (let rn = 1; rn <= l.n; rn++) {
			const c = contexts[frank][rn];
			const ids = entriesNow(c.b, c.x, c.f, 'missing');
			if (ids) add(key(ids), l.p.includes(rn) ? 'p' : l.u.includes(rn) ? 'u' : 'i', 'missing', fam.word);
		}
	}
	const random = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'wiki-random-occurrences.json'), 'utf8'));
	for (const o of random.occurrences) {
		const a = o.context.indexOf('【'), z = o.context.indexOf('】');
		const ids = a < 0 ? null : entriesNow(o.context.slice(0, a), o.context.slice(a + 1, z), o.context.slice(z + 1), 'wiki-random');
		if (ids) add(key(ids), o.label === 'problem' ? 'p' : o.label === 'innocent' ? 'i' : 'u', 'wiki-random');
	}

	// שומרים החלטות קודמות של חיים (override) אם הקובץ כבר קיים.
	let previous = {};
	if (fs.existsSync(OUT)) previous = JSON.parse(fs.readFileSync(OUT, 'utf8')).families || {};

	const out = {};
	for (const [fam, f] of Object.entries(families).sort()) {
		const n = f.p + f.i;
		const rate = n ? f.p / n : null;
		const computed = n < MIN_LABELED ? null : rate >= THRESHOLDS.A ? 'A' : rate >= THRESHOLDS.B ? 'B' : 'C';
		const override = previous[fam] && previous[fam].override;
		const group = override || computed;
		if (!group) continue;
		out[fam] = { word: f.word, group, rate: Math.round(rate * 100) / 100, problematic: f.p, innocent: f.i, unclear: f.u, sources: f.sources };
		if (override) out[fam].override = override;
	}

	const anchors = buildAnchors(occurrences, families);

	const doc = {
		version: 1,
		description: 'קבוצת השימוש של כל מילה (משפחת רשומות), לרמות החשד במנוע. נבנה ב-tools/build-usage.js מהסיווג הידני - אל תערכו ידנית, מלבד השדה override.',
		thresholds: { A: THRESHOLDS.A, B: THRESHOLDS.B, minLabeled: MIN_LABELED },
		status: 'suggested',
		// עוגנים מוחלטים: "בעיה ודאית" גם לבד (analysis/anchors.json).
		anchors,
		families: out,
	};
	fs.writeFileSync(OUT, JSON.stringify(doc, null, '\t') + '\n');
	const count = (g) => Object.values(out).filter((f) => f.group === g).length;
	console.log('מופעים שכבר לא נתפסים (לא נספרו):', JSON.stringify(dropped));
	console.log(`${Object.keys(out).length} משפחות: A ${count('A')}, B ${count('B')}, C ${count('C')} -> ${OUT}`);
}

// ===== עוגנים (analysis/anchors.json) =====
// עוגן = רשומה שבעייתית כמעט תמיד: "בעיה ודאית" גם לבד, ומעלה את רמת החשד של מילים לידה.
// מחושב מכל המופעים המסווגים (שני המקורות), אחרי סריקה מחדש עם הרשימות הנוכחיות:
//   - לפחות ANCHOR_MIN_P מופעים בעייתיים, ו-ANCHOR_RATE ומעלה מהמסווגים (בעייתי + תמים);
//   - וגם בכל משפחה שהרשומה בה (עם 3 מסווגים ומעלה) - כדי ש"טרנס" לא יהיה עוגן רק בזכות
//     "טרנסג'נדר" שבתוכו.
// רשומות עם manual: true (הכרעת חיים) נשמרות תמיד, גם בלי נתונים.
const ANCHOR_RATE = 0.85, ANCHOR_MIN_P = 4;
function buildAnchors(occurrences, families) {
	const file = path.join(ROOT, 'analysis', 'anchors.json');
	const old = JSON.parse(fs.readFileSync(file, 'utf8'));
	const words = Object.fromEntries(lib.readJson('words.json').entries.map((e) => [e.id, e]));
	const stats = {};
	for (const [ids, label] of occurrences) {
		for (const id of ids) {
			const s = (stats[id] = stats[id] || { p: 0, i: 0, u: 0 });
			s[label]++;
		}
	}
	const familyOk = (id) => Object.entries(families).every(([fam, f]) =>
		!fam.split(',').includes(id) || f.p + f.i < 3 || f.p / (f.p + f.i) >= ANCHOR_RATE);
	const entries = [];
	for (const [id, s] of Object.entries(stats).sort()) {
		const n = s.p + s.i, w = words[id];
		// רק רשומות ברמת "בעיה": עוגן הופך ל"בעיה ודאית", ולא דורס רמת "לבדיקה" שחיים קבע.
		if (!w || w.topic !== 'modesty' || w.status !== 'active' || w.level !== 'problem') continue;
		if (s.p >= ANCHOR_MIN_P && s.p / n >= ANCHOR_RATE && familyOk(id)) {
			entries.push({ id, pattern: w.pattern, problematic: s.p, labeled: n });
		}
	}
	for (const m of old.entries.filter((a) => a.manual)) {
		const id = MERGED[m.id] || m.id;
		if (!entries.some((a) => a.id === id)) entries.push({ ...m, id, pattern: words[id].pattern });
		else Object.assign(entries.find((a) => a.id === id), { manual: true, note: m.note });
	}
	entries.sort((a, b) => (a.id < b.id ? -1 : 1));
	const prev = new Set(old.entries.map((a) => MERGED[a.id] || a.id)), now = new Set(entries.map((a) => a.id));
	fs.writeFileSync(file, JSON.stringify({
		description: 'מילות עוגן לרמות החשד: רשומות צניעות שבעייתיות ב-85% ומעלה מהמופעים המסווגים (שני המקורות: חסר במכלול + ויקיפדיה אקראית; לפחות 4 בעייתיים, ובכל משפחה שהרשומה בה). נבנה ב-tools/build-usage.js. manual: true - הכרעת חיים, נשמר תמיד. עותק ישן בסופבייס: word_filter_anchors.',
		status: 'suggested',
		entries,
	}, null, '\t') + '\n');
	console.log('עוגנים:', entries.length, '| נוספו:', [...now].filter((x) => !prev.has(x)).join(', ') || '-',
		'| יצאו:', [...prev].filter((x) => !now.has(x)).join(', ') || '-');
	return entries.map((a) => a.id);
}

main();
