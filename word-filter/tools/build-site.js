#!/usr/bin/env node
// בונה את דפי הרשימות של הגאדג'ט באתר (word-filter/site/) מתוך lists/.
// המקור הוא lists/ (גם הסריקה של הדשבורד קוראת ממנו); הדפים באתר הם עותק מצומצם:
// רק רשומות פעילות והצעות, ורק השדות שהמנוע משתמש בהם. אחרי כל שינוי ברשימות:
//   node word-filter/tools/build-site.js   ואז להעתיק את הקבצים ב-site/ לדפי מדיה ויקי (README).
// --check - רק בודק שהקבצים ב-site/ מעודכנים (קוד יציאה 1 אם לא).
'use strict';
const fs = require('fs');
const path = require('path');

const LISTS = path.join(__dirname, '..', 'lists');
const SITE = path.join(__dirname, '..', 'site');
const NOTE = 'נוצר אוטומטית מ-word-filter/lists בריפו Chaim1222/database (tools/build-site.js). לא לערוך כאן - שינוי נעשה בריפו, כי גם הסריקה של הדשבורד קוראת משם.';
const USABLE = ['active', 'suggested'];

const read = (name) => JSON.parse(fs.readFileSync(path.join(LISTS, name), 'utf8'));
const pick = (obj, keys) => {
	const out = {};
	for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
	return out;
};

function build() {
	const words = read('words.json'), allow = read('allow.json'), usage = read('usage.json'), context = read('context.json');
	const slim = (list, keys) => ({ description: NOTE, version: list.version,
		entries: list.entries.filter((e) => USABLE.includes(e.status)).map((e) => pick(e, keys)) });
	return {
		'Gadget-wikitextWordCheck-words.json': slim(words, ['id', 'pattern', 'level', 'topic', 'status', 'caseSensitive', 'scope', 'fixed']),
		'Gadget-wikitextWordCheck-allow.json': slim(allow, ['id', 'pattern', 'kind', 'status', 'note']),
		'Gadget-wikitextWordCheck-usage.json': Object.assign({ description: NOTE }, pick(usage, ['version', 'status', 'anchors', 'families'])),
		'Gadget-wikitextWordCheck-context.json': Object.assign({ description: NOTE }, pick(context, ['version', 'targets']),
			{ entries: context.entries.filter((e) => USABLE.includes(e.status))
				.map((e) => pick(e, ['id', 'direction', 'targets', 'near', 'status', 'words', 'withWords', 'pattern', 'forms'])) })
	};
}

const text = (obj) => JSON.stringify(obj, null, '\t') + '\n';

if (require.main === module) {
	const files = build();
	let stale = [];
	for (const [name, obj] of Object.entries(files)) {
		const file = path.join(SITE, name);
		const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
		if (current === text(obj)) continue;
		if (process.argv.includes('--check')) stale.push(name);
		else { fs.writeFileSync(file, text(obj)); console.log('נכתב', name, Buffer.byteLength(text(obj)), 'בתים'); }
	}
	if (stale.length) { console.error('לא מעודכנים (להריץ build-site.js):', stale.join(', ')); process.exit(1); }
}

module.exports = { build, text, SITE };
