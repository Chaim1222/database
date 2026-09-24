#!/usr/bin/env node
/*
 * מרכיב את review-data.json לדף הסקירה (index.html): הרשומות, הביטויים
 * המותרים, הנתונים לכל רשומה והממצאים במכלול.
 *
 *   node word-filter/tools/evaluate.js evidence /tmp/evidence.json
 *   node word-filter/review/build-data.js /tmp/evidence.json
 *
 * אחר כך מפרסמים מחדש את index.html יחד עם review-data.json לאותה כתובת
 * (ראו NOTES.md). ההחלטות שכבר סומנו נשמרות במסד של הדף ולא נמחקות.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const evidenceFile = process.argv[2];
if (!evidenceFile) {
	console.error('שימוש: node word-filter/review/build-data.js <evidence.json>');
	process.exit(1);
}
const lists = path.join(__dirname, '..', 'lists');
const words = JSON.parse(fs.readFileSync(path.join(lists, 'words.json'), 'utf8'));
const allow = JSON.parse(fs.readFileSync(path.join(lists, 'allow.json'), 'utf8'));
const ev = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));

// מזהה יציב לממצא (מסמך ההחלטה במסד נקרא בשמו): גיבוב של שם הערך.
const hash = (s) => {
	let h = 5381;
	for (const c of s) h = ((h << 5) + h + c.codePointAt(0)) >>> 0;
	return h.toString(36);
};
const pick = (e, x) => ({
	id: e.id, pattern: e.pattern, level: e.level, topic: e.topic, status: e.status, sources: e.sources,
	note: e.note || '', original: e.original || '',
	ev: x ? { b: x.blacklist, m: x.mechalol, xb: x.examples.blacklist, xm: x.examples.mechalol } : null,
});
const data = {
	generated: ev.generated, totals: ev.totals, topics: words.topics, levels: words.levels,
	words: words.entries.filter((e) => e.status !== 'rejected').map((e) => pick(e, ev.entries[e.id])),
	allow: allow.entries.filter((e) => e.status !== 'rejected').map((e) => pick(e, ev.allow[e.id])),
	findings: ev.findings.map((f) => ({ id: 'f-' + hash(f.title), title: f.title, matches: f.matches })),
};
const out = path.join(__dirname, 'review-data.json');
fs.writeFileSync(out, JSON.stringify(data));
console.log(`words ${data.words.length}, allow ${data.allow.length}, findings ${data.findings.length}, ` +
	`${Math.round(fs.statSync(out).size / 1024)} KB -> ${out}`);
