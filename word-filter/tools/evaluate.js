#!/usr/bin/env node
/*
 * מדידת רשימות המילים מול תוכן אמיתי - לפני כל שינוי ברשימות.
 *
 * מאגרים (נשמרים ב-.word-filter-corpus/, מחוץ ל-git):
 *   blacklist - הערכים שב-blacklist_titles (נעולים ליצירה במכלול), כפי שהם
 *               בוויקיפדיה. מלאים בתוכן בעייתי - אמורים להיתפס.
 *   כל מאגר אחר - מדגם אקראי מהמכלול: תוכן שכבר אושר באתר (ברובו נקי, לא
 *               במאה אחוז). כדאי שניים: dev לבניית רשימות, holdout לבדיקה עיוורת.
 *
 *   node word-filter/tools/evaluate.js fetch-blacklist [--ids-file ids.txt]
 *        בלי --ids-file: מזהים מסופרבייס (SUPABASE_URL + SUPABASE_SERVICE_KEY).
 *   node word-filter/tools/evaluate.js fetch-mechalol dev 500
 *   node word-filter/tools/evaluate.js report [--lost]      טבלת תצורות, ומה אבד בכל שלב
 *   node word-filter/tools/evaluate.js noisy [N]            הרשומות שתופסות הכי הרבה במכלול
 *   node word-filter/tools/evaluate.js candidates file.txt  מדידת תבניות מועמדות (שורה לכל תבנית)
 *   node word-filter/tools/evaluate.js evidence out.json    נתונים לכל רשומה - לדף הסקירה
 *
 * ויקיפדיה מגבילה קצב (HTTP 429) - ההורדה ממתינה, וממשיכה מאיפה שעצרה.
 *
 * הכלי לא קובע רמות (problem/review) אוטומטית לפי המדגם: המכלול לא נקי במאה
 * אחוז, ומילה שמופיעה בו יכולה להיות בדיוק תוכן שצריך לנקות. הכלי מציג את
 * הנתונים, וההחלטה היא של העורכים.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { engine, CORPUS_DIR, LISTS_DIR, readJson, loadLists, apiGet, contentOf, isRedirect, loadCorpora, sleep } = require('./lib');

const OTHER = (name) => name !== 'blacklist';

function corpusPath(name) {
	fs.mkdirSync(CORPUS_DIR, { recursive: true });
	return path.join(CORPUS_DIR, name + '.json');
}
const loadFile = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

async function fetchBlacklist(idsFile) {
	let ids;
	if (idsFile) {
		ids = fs.readFileSync(idsFile, 'utf8').split(/[,\s]+/);
	} else {
		const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
		if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('צריך SUPABASE_URL ו-SUPABASE_SERVICE_KEY, או --ids-file');
		const res = await fetch(SUPABASE_URL + '/rest/v1/blacklist_titles?select=wikipedia_id&limit=100000',
			{ headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY } });
		ids = (await res.json()).map((r) => String(r.wikipedia_id || ''));
	}
	const file = corpusPath('blacklist');
	const pages = loadFile(file);
	const todo = [...new Set(ids.filter(Boolean))].filter((id) => !pages[id]);
	for (let i = 0; i < todo.length; i += 50) {
		const chunk = todo.slice(i, i + 50);
		const data = await apiGet('wikipedia', { action: 'query', pageids: chunk.join('|'), prop: 'revisions',
			rvprop: 'content', rvslots: 'main' });
		for (const page of (data.query || {}).pages || []) pages[page.pageid] = { title: page.title, text: contentOf(page) };
		for (const id of chunk) pages[id] = pages[id] || { title: null, text: null };
		fs.writeFileSync(file, JSON.stringify(pages));
		console.log(`blacklist: ${Object.keys(pages).length}`);
		await sleep(2000);
	}
}

async function fetchMechalol(name, count) {
	const file = corpusPath(name);
	const pages = loadFile(file);
	while (Object.keys(pages).length < count) {
		// אצווה עם דף נעול-לקריאה נדחית כולה (ראו match.py) - מדלגים עליה.
		const data = await apiGet('mechalol', { action: 'query', generator: 'random', grnnamespace: 0, grnlimit: 50,
			prop: 'revisions', rvprop: 'content', rvslots: 'main' });
		for (const page of (data.query || {}).pages || []) {
			const text = contentOf(page);
			if (text && !isRedirect(text)) pages[page.pageid] = { title: page.title, text };
		}
		fs.writeFileSync(file, JSON.stringify(pages));
		console.log(`${name}: ${Object.keys(pages).length}`);
		await sleep(1000);
	}
}

function requireCorpora() {
	const corpora = loadCorpora();
	if (!corpora.blacklist) throw new Error('אין מאגר blacklist - הריצו קודם fetch-blacklist');
	return corpora;
}

const pct = (n, total) => (100 * n / total).toFixed(1).padStart(5) + '%';

function report(showLost) {
	const corpora = requireCorpora();
	const words = readJson('words.json'), allow = readJson('allow.json');
	const noAllow = { entries: [] };
	const configs = [
		['רשימות המקור', loadLists({ words, allow: noAllow }), { wordStart: false }],
		['+תחילת מילה', loadLists({ words, allow: noAllow }), {}],
		['+מותרות (הצעה)', loadLists({ words: { entries: words.entries.filter((e) => e.status === 'active') }, allow,
			suggested: true }), {}],
		['+מילים (הצעה)', loadLists({ words, allow, suggested: true }), {}],
	];
	const verdicts = {};
	console.log('בעיה ודאית / לבדיקה / נקי, לכל מאגר:');
	for (const [name, lists, options] of configs) {
		const cells = [];
		for (const [corpus, pages] of Object.entries(corpora)) {
			const v = {};
			for (const [id, page] of Object.entries(pages)) v[id] = engine.verdict(engine.scan(page.text, lists, options));
			verdicts[name + '|' + corpus] = v;
			const n = Object.values(v), total = n.length;
			const count = (l) => n.filter((x) => x === l).length;
			cells.push(`${corpus} (${total}): ${pct(count('problem'), total)} ${pct(count('review'), total)} ${pct(count('clean'), total)}`);
		}
		console.log(name.padEnd(16) + cells.join('   |   '));
	}
	if (!showLost) return;
	for (let i = 1; i < configs.length; i++) {
		const before = verdicts[configs[i - 1][0] + '|blacklist'], after = verdicts[configs[i][0] + '|blacklist'];
		const lost = Object.keys(before).filter((id) => before[id] !== 'clean' && after[id] === 'clean');
		console.log(`\nחסומים שהפכו ל"נקי" במעבר ${configs[i - 1][0]} -> ${configs[i][0]}: ${lost.length}`);
		lost.forEach((id) => console.log('  - ' + corpora.blacklist[id].title));
	}
}

function context(text, start, end, width = 30) {
	return (text.slice(Math.max(start - width, 0), start) + '【' + text.slice(start, end) + '】' + text.slice(end, end + width))
		.replace(/\n/g, ' ⏎ ');
}

/*
 * לכל רשומה (כולל הצעות): בכמה ערכים חסומים ובכמה ערכי מכלול היא תופסת
 * (אחרי תחילת מילה ומותרות), עם דוגמאות. לכל ביטוי מותר: כמה התאמות הוא
 * מבטל בכל מאגר, עם דוגמאות. בנוסף - ערכי מכלול עם בעיה ודאית.
 */
function evidence() {
	const corpora = requireCorpora();
	const words = readJson('words.json'), allow = readJson('allow.json');
	const lists = loadLists({ words, allow, suggested: true });
	const bare = loadLists({ words, allow: { entries: [] }, suggested: true });
	const stat = () => ({ blacklist: new Set(), mechalol: new Set(), examples: { blacklist: [], mechalol: [] } });
	const entryStats = Object.fromEntries(words.entries.map((e) => [e.id, stat()]));
	const allowStats = Object.fromEntries(allow.entries.map((e) => [e.id, stat()]));
	const findings = [];
	const totals = {};

	for (const [corpus, pages] of Object.entries(corpora)) {
		const side = OTHER(corpus) ? 'mechalol' : 'blacklist';
		totals[side] = (totals[side] || 0) + Object.keys(pages).length;
		for (const [id, page] of Object.entries(pages)) {
			const key = corpus + ':' + id;
			const matches = engine.scan(page.text, lists);
			for (const m of matches) {
				for (const e of m.entries) {
					const st = entryStats[e.id];
					if (!st[side].has(key) && st.examples[side].length < 4) {
						st.examples[side].push({ title: page.title, context: context(page.text, m.start, m.end) });
					}
					st[side].add(key);
				}
			}
			if (side === 'mechalol' && engine.verdict(matches) === 'problem') {
				findings.push({ title: page.title, matches: matches.filter((m) => m.level === 'problem').slice(0, 5)
					.map((m) => ({ context: context(page.text, m.start, m.end), entries: m.entries.map((e) => e.id) })) });
			}
			// מה כל ביטוי מותר מבטל: התאמות מהסריקה בלי מותרות שנופלות בתוך הביטוי.
			const unallowed = engine.scan(page.text, bare);
			if (!unallowed.length) continue;
			const masked = engine.maskWikitext(page.text);
			for (const a of lists.allow) {
				const spans = [];
				for (const text of [page.text, masked]) {
					a.regex.lastIndex = 0;
					let m;
					while ((m = a.regex.exec(text)) !== null) {
						if (m[0].length) spans.push([m.index, m.index + m[0].length]);
						else a.regex.lastIndex++;
					}
				}
				const hit = unallowed.find((m) => spans.some(([s, e]) => s <= m.start && m.end <= e));
				if (!hit) continue;
				const st = allowStats[a.entry.id];
				if (!st[side].has(key) && st.examples[side].length < 4) {
					st.examples[side].push({ title: page.title, context: context(page.text, hit.start, hit.end) });
				}
				st[side].add(key);
			}
		}
	}
	const flatten = (stats) => Object.fromEntries(Object.entries(stats).map(([id, st]) => [id,
		{ blacklist: st.blacklist.size, mechalol: st.mechalol.size, examples: st.examples }]));
	return { generated: new Date().toISOString(), totals, entries: flatten(entryStats), allow: flatten(allowStats), findings };
}

function candidates(file) {
	const corpora = requireCorpora();
	const lists = loadLists({ suggested: true });
	const masked = {}, missed = new Set();
	for (const [corpus, pages] of Object.entries(corpora)) {
		for (const [id, page] of Object.entries(pages)) {
			masked[corpus + ':' + id] = { corpus, text: engine.maskWikitext(page.text) };
			if (!OTHER(corpus) && engine.verdict(engine.scan(page.text, lists)) === 'clean') missed.add(corpus + ':' + id);
		}
	}
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const pattern = line.trim();
		if (!pattern || pattern.startsWith('#')) continue;
		const probe = engine.compileLists({ entries: [{ id: 'c', pattern, level: 'problem', topic: 'modesty', status: 'active' }] },
			{ entries: [] });
		const hits = { blacklist: new Set(), mechalol: new Set() };
		let example = '';
		for (const [key, { corpus, text }] of Object.entries(masked)) {
			const found = engine.scan(text, probe, { raw: true });
			if (!found.length) continue;
			hits[OTHER(corpus) ? 'mechalol' : 'blacklist'].add(key);
			if (OTHER(corpus) && !example) example = context(text, found[0].start, found[0].end, 25);
		}
		const newly = [...hits.blacklist].filter((k) => missed.has(k)).length;
		console.log(`+${String(newly).padStart(3)} חסרים | חסומים ${String(hits.blacklist.size).padStart(4)} | ` +
			`מכלול ${String(hits.mechalol.size).padStart(3)} | ${pattern}${example ? '  | ' + example : ''}`);
	}
}

function noisy(limit) {
	const ev = evidence();
	const words = Object.fromEntries(readJson('words.json').entries.map((e) => [e.id, e]));
	Object.entries(ev.entries).sort((a, b) => b[1].mechalol - a[1].mechalol).slice(0, limit).forEach(([id, st]) => {
		const e = words[id];
		console.log(`${String(st.blacklist).padStart(5)}/${String(st.mechalol).padEnd(4)} ${id} [${e.level}/${e.status}] ${e.pattern}` +
			(st.examples.mechalol[0] ? `  | ${st.examples.mechalol[0].context}` : ''));
	});
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === 'fetch-blacklist') await fetchBlacklist(rest[0] === '--ids-file' ? rest[1] : null);
	else if (cmd === 'fetch-mechalol') await fetchMechalol(rest[0], Number(rest[1]));
	else if (cmd === 'report') report(rest.includes('--lost'));
	else if (cmd === 'noisy') noisy(Number(rest[0]) || 40);
	else if (cmd === 'candidates') candidates(rest[0]);
	else if (cmd === 'evidence') fs.writeFileSync(rest[0], JSON.stringify(evidence(), null, 1));
	else {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
		process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error('שגיאה: ' + e.message);
	process.exitCode = 3;
});
