// מדידת חלוקת הנושאים (word-filter/topics.js) על מדגם "חסר במכלול" - ראו analysis/missing-groups.md.
// בלי רשת. הרצה: node word-filter/analysis/missing-groups.js [--other]
'use strict';
const path = require('path');
const { classify, TOPICS } = require(path.join(__dirname, '..', 'topics'));
const { rows } = require('./missing-groups-sample.json');

const pc = (a, b) => Math.round(100 * a / b) + '%';
const table = {};
for (const r of rows) {
	const t = table[classify(r)] || (table[classify(r)] = { n: 0, clean: 0, wording: 0, review: 0, problem: 0 });
	t.n++;
	t[r.v]++;
}
console.log(`מדגם: ${rows.length} ערכים מ"חסר במכלול" (הערכה לכל הרשימה: פי ${(25110 / rows.length).toFixed(1)}).\n`);
console.log('נושא | ערכים | נקי | דורש ניסוח | לבדיקה | בעיה ודאית');
for (const [code, t] of Object.entries(table).sort((a, b) => b[1].n - a[1].n)) {
	console.log(`${TOPICS[code]} | ${t.n} | ${pc(t.clean, t.n)} | ${pc(t.wording, t.n)} | ${pc(t.review, t.n)} | ${pc(t.problem, t.n)}`);
}
if (process.argv.includes('--other')) {
	rows.filter((r) => classify(r) === 'other').forEach((r) => console.log('  אחר:', r.t, '|', r.ib, '|', r.cats.slice(0, 3).join(', ')));
}
