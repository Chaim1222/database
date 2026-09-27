// מדידת כללי הערך המילוני (word-filter/dictionary.js) על המדגמים המתויגים - ראו
// analysis/dictionary-rules.md. בלי רשת. הרצה: node word-filter/analysis/dictionary-rules.js [--errors]
'use strict';
const path = require('path');
const { classify } = require(path.join(__dirname, '..', 'dictionary'));
const { rows } = require('./dictionary-samples.json');

const showErrors = process.argv.includes('--errors');
for (const set of ['train', 'test']) {
	const sample = rows.filter((r) => r.set === set);
	const real = sample.filter((r) => r.y === 'dict').length;
	const flagged = sample.filter((r) => classify(r));
	const ok = flagged.filter((r) => r.y === 'dict').length;
	console.log(`${set === 'train' ? 'מדגם הכתיבה' : 'מדגם הבדיקה'} (${sample.length} ערכי מכלול אקראיים; ${real} מילוניים, ` +
		`${sample.filter((r) => r.y === 'plain').length} רגילים): סומנו ${flagged.length}, נכונים ${ok} - ` +
		`דיוק ${(100 * ok / flagged.length).toFixed(1)}%, כיסוי ${(100 * ok / real).toFixed(1)}%`);
	if (!showErrors) continue;
	for (const r of flagged.filter((x) => x.y !== 'dict')) console.log('    סומן, לא מילוני:', r.t, '|', r.y, '|', classify(r).why);
	for (const r of sample.filter((x) => !classify(x) && x.y === 'dict')) console.log('    פוספס:', r.t, '|', r.cls, '|', r.ib);
}
const byType = {};
for (const r of rows.filter((x) => x.set === 'class')) {
	const s = byType[r.cls] || (byType[r.cls] = [0, 0]);
	s[1]++;
	if (classify(r)) s[0]++;
}
console.log('כיסוי לפי סוג (מדגם לכל תבנית בוט): ' + Object.entries(byType).map(([c, [a, b]]) => `${c} ${Math.round(100 * a / b)}%`).join(' · '));
