#!/usr/bin/env node
/*
 * רמות חשד בתוך "לבדיקה" (הצעה של חיים, 2026-09-25): האם מה שיש ליד מילה
 * דו-משמעית מבדיל בין מופע בעייתי למופע תמים?
 *
 *   עוגן   - המילה עצמה בעייתית כמעט תמיד (analysis/anchors.json).
 *   גבוה   - עוגן אחר באותו משפט, או מילה חשודה אחרת באותו משפט + עוגן בערך.
 *   בינוני - רק אחד מהשניים: מילה חשודה אחרת במשפט, או עוגן במקום אחר בערך.
 *   נמוך   - לבד במשפט, ואין עוגן בערך.
 *
 * הבדיקה: 1,196 המופעים שסווגו ידנית במדגם האקראי מוויקיפדיה
 * (analysis/wiki-random-occurrences.json) - כמה מכל רמה בעייתיים באמת.
 *
 *   node word-filter/analysis/suspicion.js [--variant NAME]
 * דורש את המדגם wiki-random (ראו NOTES סעיף 8).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { engine, loadLists, loadCorpora } = require('../tools/lib');

const anchors = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'anchors.json'), 'utf8')).entries.map((a) => a.id));
const labeled = JSON.parse(fs.readFileSync(path.join(__dirname, 'wiki-random-occurrences.json'), 'utf8')).occurrences;

// רמת החשד של כל התאמת צניעות בדף.
function tiers(text, matches) {
	const flagged = matches.filter((m) => m.topic === 'modesty' && (m.level === 'problem' || m.level === 'review'));
	const isAnchor = (m) => m.entries.some((e) => anchors.has(e.id));
	const spans = flagged.map((m) => engine.sentenceSpan(text, m.start, m.end));
	return flagged.map((m, i) => {
		if (isAnchor(m)) return { m, tier: 'anchor' };
		const [from, to] = spans[i];
		const mates = flagged.filter((o, j) => j !== i && o.text !== m.text && o.start >= from && o.end <= to);
		const pageAnchor = flagged.some((o) => o !== m && o.text !== m.text && isAnchor(o));
		const tier = mates.some(isAnchor) || (mates.length && pageAnchor) ? 'high' : mates.length || pageAnchor ? 'medium' : 'low';
		return { m, tier, mates: mates.length, pageAnchor };
	});
}

function main() {
	const corpus = loadCorpora()['wiki-random'];
	if (!corpus) throw new Error('חסר המדגם wiki-random - ראו NOTES סעיף 8');
	const lists = loadLists({ suggested: true });
	const byPage = new Map();
	for (const o of labeled) {
		const [id, pos] = o.ref.split(':');
		if (!byPage.has(id)) byPage.set(id, []);
		byPage.get(id).push({ pos: Number(pos), label: o.label, entries: o.entries });
	}
	const table = {};
	const perFamily = {};
	let joined = 0;
	for (const [id, labels] of byPage) {
		const page = corpus[id];
		if (!page) continue;
		const result = tiers(page.text, engine.scan(page.text, lists));
		for (const l of labels) {
			const hit = result.find((r) => r.m.start <= l.pos && l.pos < r.m.end);
			if (!hit) continue; // ההתאמה כבר לא נתפסת (היתר, או שינוי ברשימה)
			joined++;
			const row = (table[hit.tier] = table[hit.tier] || { problem: 0, innocent: 0, unclear: 0 });
			row[l.label]++;
			if (hit.tier === 'medium') {
				const sub = hit.mates ? 'medium: שכנה במשפט בלבד' : 'medium: עוגן בערך בלבד';
				const r2 = (table[sub] = table[sub] || { problem: 0, innocent: 0, unclear: 0 });
				r2[l.label]++;
			}
			const fam = l.entries.slice().sort().join(',');
			const f = (perFamily[fam] = perFamily[fam] || {});
			const c = (f[hit.tier] = f[hit.tier] || { problem: 0, innocent: 0, unclear: 0 });
			c[l.label]++;
		}
	}
	console.log(`מופעים מסווגים שנמצאו בסריקה הנוכחית: ${joined} מתוך ${labeled.length}\n`);
	console.log('רמה     בעייתי  תמים  לא ברור  אחוז בעייתי (מתוך המסווגים)');
	for (const tier of ['anchor', 'high', 'medium', 'medium: שכנה במשפט בלבד', 'medium: עוגן בערך בלבד', 'low']) {
		const r = table[tier] || { problem: 0, innocent: 0, unclear: 0 };
		const pct = r.problem + r.innocent ? Math.round((100 * r.problem) / (r.problem + r.innocent)) : '-';
		console.log(`${tier.padEnd(26)} ${String(r.problem).padStart(6)} ${String(r.innocent).padStart(5)} ${String(r.unclear).padStart(8)}  ${pct}%`);
	}
	console.log('\nלפי מילה (רק משפחות עם 8 מופעים מסווגים לפחות, בלי עוגנים): בעייתי/סה"כ בכל רמה');
	for (const [fam, f] of Object.entries(perFamily)) {
		const total = Object.values(f).reduce((s, c) => s + c.problem + c.innocent, 0);
		if (total < 8 || f.anchor) continue;
		const cell = (t) => (f[t] ? `${f[t].problem}/${f[t].problem + f[t].innocent}` : '-');
		console.log(`${fam.padEnd(24)} high ${cell('high').padEnd(6)} medium ${cell('medium').padEnd(7)} low ${cell('low')}`);
	}
}

main();
