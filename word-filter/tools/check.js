#!/usr/bin/env node
/*
 * בדיקת דף אחד משורת הפקודה.
 *
 *   node word-filter/tools/check.js --title "שם ערך"               # ויקיפדיה
 *   node word-filter/tools/check.js --wiki mechalol --title "שם ערך"
 *   node word-filter/tools/check.js --file page.wikitext [--json]
 *   node word-filter/tools/check.js --title "..." --suggested      # כולל הצעות שלא אושרו
 *
 * קוד יציאה: 3 = בעיה ודאית, 2 = לבדיקה, 1 = דורש ניסוח, 0 = נקי, 9 = שגיאה.
 */
'use strict';
const fs = require('fs');
const { engine, loadLists, fetchPage } = require('./lib');

function parseArgs(argv) {
	const args = { wiki: 'wikipedia' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--title' || a === '--file' || a === '--wiki') args[a.slice(2)] = argv[++i];
		else if (a === '--json') args.json = true;
		else if (a === '--suggested') args.suggested = true;
		else if (a === '--raw') args.raw = true;
		else if (a === '--no-word-start') args.wordStart = false;
		else throw new Error('ארגומנט לא מוכר: ' + a);
	}
	if (!args.title && !args.file) throw new Error('צריך --title או --file');
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const text = args.file ? fs.readFileSync(args.file === '-' ? 0 : args.file, 'utf8') : await fetchPage(args.wiki, args.title);
	const lists = loadLists({ suggested: args.suggested });
	const matches = engine.scan(text, lists, { raw: args.raw, wordStart: args.wordStart });
	const level = engine.verdict(matches);

	if (args.json) {
		console.log(JSON.stringify({ verdict: level, matches: matches.map((m) => ({
			start: m.start, end: m.end, text: m.text, line: m.line, level: m.level, topic: m.topic,
			entries: m.entries.map((e) => e.id), demotedBy: m.demotedBy.map((e) => e.id), context: engine.contextOf(text, m),
		})) }, null, 2));
	} else {
		console.log(`== ${args.title || args.file}: ${engine.LEVEL_LABELS[level]} (${matches.length} התאמות) ==`);
		const counted = (m) => engine.VERDICT_TOPICS.includes(m.topic);
		const groups = [
			[engine.LEVEL_LABELS.problem, matches.filter((m) => counted(m) && m.level === 'problem')],
			[engine.LEVEL_LABELS.review, matches.filter((m) => counted(m) && m.level === 'review')],
			['הערות ניסוח (אמונה, תיארוך, ויקיפדיה)', matches.filter((m) => !counted(m))],
		];
		for (const [label, items] of groups) {
			if (!items.length) continue;
			console.log(`\n--- ${label}: ${items.length} ---`);
			for (const m of items) {
				const c = engine.contextOf(text, m);
				const ctx = c.before + '【' + c.text + '】' + c.after;
				const demoted = m.demotedBy.length ? ` (ירד לבדיקה: ${m.demotedBy.map((e) => e.id).join(',')})` : '';
				console.log(`  שורה ${m.line} [${engine.TOPIC_LABELS[m.topic]}] ${m.entries.map((e) => e.id).join(',')}${demoted}: ${ctx}`);
			}
		}
	}
	process.exitCode = { problem: 3, review: 2, wording: 1, clean: 0 }[level];
}

main().catch((e) => {
	console.error('שגיאה: ' + e.message);
	process.exitCode = 9;
});
