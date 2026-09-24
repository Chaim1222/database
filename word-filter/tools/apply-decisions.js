#!/usr/bin/env node
/*
 * מחיל את ההחלטות מדף הסקירה על lists/words.json ו-lists/allow.json.
 *
 * קלט: תיקייה עם קובץ JSON לכל החלטה (<id>.json), כפי שהיא נשמרת בדף:
 *   { kind: "word"|"allow"|"finding", decision: "approve"|"reject"|..., level, note }
 *
 * לכל רשומה (words/allow):
 *   approve -> status: "active", reviewed: true, ו-level אם שונה בדף.
 *   reject  -> status: "rejected", reviewed: true (נשאר בקובץ לתיעוד, לא נבדק).
 *   note    -> נשמר בשדה reviewNote.
 * החלטות על ממצאים (finding) לא משנות את הרשימות - הן מודפסות לסיכום.
 *
 *   node word-filter/tools/apply-decisions.js <תיקיית ההחלטות>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { LISTS_DIR } = require('./lib');

const dir = process.argv[2];
if (!dir) {
	console.error('שימוש: node word-filter/tools/apply-decisions.js <תיקיית ההחלטות>');
	process.exit(1);
}

const decisions = {};
for (const file of fs.readdirSync(dir)) {
	if (file.endsWith('.json')) decisions[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

const summary = { approve: 0, reject: 0, level: 0, findings: {} };
for (const name of ['words.json', 'allow.json']) {
	const file = path.join(LISTS_DIR, name);
	const list = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const entry of list.entries) {
		const d = decisions[entry.id];
		if (!d) continue;
		if (d.note) entry.reviewNote = d.note;
		if (d.decision === 'approve') {
			entry.status = 'active';
			entry.reviewed = true;
			summary.approve++;
			if (d.level && d.level !== entry.level) {
				entry.level = d.level;
				summary.level++;
			}
		} else if (d.decision === 'reject') {
			entry.status = 'rejected';
			entry.reviewed = true;
			summary.reject++;
		}
	}
	fs.writeFileSync(file, JSON.stringify(list, null, '\t') + '\n');
}
for (const d of Object.values(decisions)) {
	if (d.kind === 'finding' && d.decision) summary.findings[d.decision] = (summary.findings[d.decision] || 0) + 1;
}
console.log(`אושרו ${summary.approve} (מהן ${summary.level} ברמה ששונתה), נדחו ${summary.reject}. ` +
	`ממצאים במכלול: ${JSON.stringify(summary.findings)}`);
