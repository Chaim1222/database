#!/usr/bin/env node
'use strict';
/*
 * מדידת סיווג הנושאים (topics.js) מול סט הבדיקה המתויג ידנית: analysis/topics-gold.json.
 * בלי רשת: לכל ערך שמורים הכותרת, התבנית, הקטגוריות, התיאור ונתוני ויקינתונים.
 *
 *   node word-filter/tools/topics-eval.js          # אחוז נכון לכל סט, ורשימת הטעויות
 *   node word-filter/tools/topics-eval.js --quiet  # רק האחוזים
 *
 * לפני שינוי ב-topics.js או ב-wikidata.json - להריץ לפני ואחרי. שינוי שמשפר מקרה אחד ומקלקל אחרים ייראה כאן.
 */
const { classify, topicWithDescription } = require('../topics.js');
const { rows } = require('../analysis/topics-gold.json');

const quiet = process.argv.includes('--quiet');
const bySet = new Map();
for (const r of rows) {
	const got = topicWithDescription(classify(r), r.desc);
	const s = bySet.get(r.set) || bySet.set(r.set, { ok: 0, n: 0, bad: [] }).get(r.set);
	s.n++;
	if (r.gold.split('|').includes(got)) s.ok++;
	else s.bad.push(`${r.t} | ${got} | נכון: ${r.gold}`);
}
let ok = 0, n = 0;
for (const [set, s] of bySet) {
	ok += s.ok; n += s.n;
	console.log(`${set}: ${s.ok}/${s.n} = ${(s.ok / s.n * 100).toFixed(1)}%`);
	if (!quiet) s.bad.forEach((b) => console.log('  ' + b));
}
console.log(`סה"כ: ${ok}/${n} = ${(ok / n * 100).toFixed(1)}%`);
