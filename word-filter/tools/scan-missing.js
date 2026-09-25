#!/usr/bin/env node
/*
 * סינון רשימת "חסר במכלול" לפי תוכן: כל ערך ויקיפדיה שבדוח
 * report_missing_from_mechalol נסרק במנוע (Gadget-wikitextWordCheck.js),
 * והתוצאה נשמרת בטבלה word_filter_results בסופבייס. הדשבורד (הגאדג'ט
 * gadget/gadget-searchHelperDashboard.js) מסנן לפיה.
 *
 * לכל ערך נשמרות שתי פסיקות, כי רוב השיפורים ברשימות עדיין בגדר הצעה:
 *   verdict            - לפי הרשימות המאושרות בלבד (status: active).
 *   verdict_suggested  - כולל ההצעות (status: suggested).
 * רמות: problem / review / wording / clean (ראו המנוע).
 * בנוסף: תמונות (ראו imagesOf), וכל התאמה עם המשפט שבו נמצאה (contextOf) -
 * כדי שהעורך יראה את ההקשר בדשבורד, בלי הטקסט המלא מול העיניים.
 *
 * ערך נסרק מחדש רק אם הגרסה שלו בוויקיפדיה השתנתה (rev_id), או שהרשימות
 * או המנוע השתנו (lists_version) - כך ריצה שבועית זולה.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node word-filter/tools/scan-missing.js
 *   node word-filter/tools/scan-missing.js --ids-file ids.txt --out results.jsonl   # בלי סופבייס
 *
 * אפשרויות:
 *   --ids-file F   מזהי דפים (page_id בוויקיפדיה) מקובץ, במקום הדוח בסופבייס.
 *   --out F        לכתוב גם לקובץ JSON Lines (שורה לכל ערך).
 *   --dry-run      לא לכתוב לסופבייס.
 *   --force        לסרוק הכל, גם מה שלא השתנה.
 *   --limit N      רק N הערכים הראשונים (לבדיקה).
 *   --prune        למחוק מהטבלה ערכים שכבר לא בדוח (נוצרו במכלול/נחסמו).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { engine, readJson, apiGet, LISTS_DIR } = require('./lib');

const TABLE = 'word_filter_results';
const REPORT = 'report_missing_from_mechalol';
const API_BATCH = 50;          // מזהים לבקשה אחת לוויקיפדיה (מגבלה לחשבון רגיל)
const DB_BATCH = 200;          // שורות ל-upsert אחד
const MAX_MATCHES = 300;       // התאמות שנשמרות לערך (הספירות - על כולן)
const MAX_IMAGES = 12;         // שמות תמונות שנשמרים לערך
const CONTEXT_SIDE = 90;       // תווים לכל צד במשפט ההקשר

// ===== ארגומנטים =====

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--ids-file' || a === '--out' || a === '--limit') args[a.slice(2).replace('-f', 'F')] = argv[++i];
		else if (a === '--dry-run') args.dryRun = true;
		else if (a === '--force') args.force = true;
		else if (a === '--prune') args.prune = true;
		else throw new Error('ארגומנט לא מוכר: ' + a);
	}
	if (args.limit) args.limit = Number(args.limit);
	return args;
}

const log = (msg) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' | ' + msg);

// ===== רשימות =====

// גרסת הרשימות והמנוע: שינוי באחד מהם מחייב סריקה מחדש של הכל.
function listsVersion() {
	const hash = crypto.createHash('sha1');
	for (const file of [path.join(LISTS_DIR, 'words.json'), path.join(LISTS_DIR, 'allow.json'),
		path.join(__dirname, '..', 'Gadget-wikitextWordCheck.js')]) hash.update(fs.readFileSync(file));
	return hash.digest('hex').slice(0, 12);
}

function compileBoth() {
	const words = readJson('words.json'), allow = readJson('allow.json');
	return {
		approved: engine.compileLists(words, allow),
		suggested: engine.compileLists(words, allow, { suggested: true }),
	};
}

// ===== סופבייס (PostgREST) =====

function supabase() {
	const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
	if (!url || !key) throw new Error('חסרים SUPABASE_URL / SUPABASE_SERVICE_KEY (או --ids-file עם --dry-run)');
	const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
	async function request(method, pathAndQuery, body, extraHeaders) {
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await fetch(url + '/rest/v1/' + pathAndQuery, {
					method, headers: { ...headers, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined,
				});
				if (res.ok) return method === 'GET' ? res.json() : null;
				const text = await res.text();
				if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status}: ${text}`), { fatal: true });
				throw new Error(`HTTP ${res.status}: ${text}`);
			} catch (e) {
				if (e.fatal || attempt >= 6) throw e;
				log(`סופבייס: ניסיון ${attempt} נכשל (${e.message}) - מנסה שוב`);
				await new Promise((r) => setTimeout(r, Math.min(2 ** attempt, 30) * 1000));
			}
		}
	}
	// כל השורות, בעימוד לפי מפתח (כמו בסקריפטי ההעשרה בפייתון).
	async function selectAll(table, select, keyColumn) {
		const rows = [];
		let last = -1;
		for (;;) {
			const batch = await request('GET', `${table}?select=${select}&order=${keyColumn}.asc&${keyColumn}=gt.${last}&limit=1000`);
			rows.push(...batch);
			if (batch.length < 1000) return rows;
			last = batch[batch.length - 1][keyColumn];
		}
	}
	return {
		missing: () => selectAll(REPORT, 'id,title', 'id'),
		existing: () => selectAll(TABLE, 'wikipedia_id,rev_id,lists_version', 'wikipedia_id'),
		upsert: (rows) => request('POST', `${TABLE}?on_conflict=wikipedia_id`, rows,
			{ Prefer: 'resolution=merge-duplicates,return=minimal' }),
		remove: (ids) => request('DELETE', `${TABLE}?wikipedia_id=in.(${ids.join(',')})`, null, { Prefer: 'return=minimal' }),
	};
}

// ===== ויקיפדיה =====

// שאילתה אחת עם המשך (continue) עד הסוף, ומיזוג לפי דף: תמונות מצטברות,
// ושאר השדות נשמרים מהתשובה הראשונה שבה הופיעו.
async function queryPages(params) {
	const pages = new Map();
	let cont = {};
	for (;;) {
		const data = await apiGet('wikipedia', { action: 'query', ...params, ...cont });
		for (const p of (data.query && data.query.pages) || []) {
			const cur = pages.get(p.pageid || p.title) || { images: [] };
			for (const [k, v] of Object.entries(p)) {
				if (k === 'images') cur.images.push(...v);
				else if (cur[k] === undefined) cur[k] = v;
			}
			pages.set(p.pageid || p.title, cur);
		}
		if (!data.continue) return [...pages.values()];
		cont = data.continue;
	}
}

// תמונות: prop=images מחזיר כל קובץ שמוצג בדף - כולל דגלים, סמלים ואייקונים
// שמגיעים מתבניות (Allmusic, כוכבי דירוג, "קצרמר"), שמופיעים באלפי ערכים.
// "תמונה של הערך" = קובץ שמופיע בקוד הערך עצמו (קישור, גלריה, פרמטר בתבנית
// מידע), או התמונה הראשית שבוחר PageImages (כולל תמונה שתבנית המידע שולפת
// מוויקינתונים, שלא מופיעה בקוד). "צילום" = תמונה כזו שאינה SVG (SVG הוא
// כמעט תמיד מפה, תרשים, סמל או דגל).
const PHOTO_RE = /\.(?:jpe?g|png|gif|webp|tiff?|bmp)$/i;
const norm = (s) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
function imagesOf(page, text) {
	const all = [...new Set((page.images || []).map((i) => i.title.replace(/^[^:]+:/, '')))];
	const code = norm(text || '');
	let decoded = code;
	try { decoded = norm(decodeURIComponent(text || '')); } catch (e) { /* קידוד שבור - מסתפקים בטקסט */ }
	const lead = page.pageimage ? page.pageimage.replace(/_/g, ' ') : null;
	const own = all.filter((name) => name === lead || code.includes(norm(name)) || decoded.includes(norm(name)));
	if (lead && !own.includes(lead)) own.unshift(lead);
	return { all, own, photos: own.filter((t) => PHOTO_RE.test(t)) };
}

// ===== סריקה =====

function scanPage(text, lists) {
	const both = {};
	for (const mode of ['approved', 'suggested']) {
		const matches = engine.scan(text, lists[mode]);
		both[mode] = { matches, verdict: engine.verdict(matches) };
	}
	// איחוד ההתאמות של שני המצבים לפי מיקום: a = הרמה לפי המאושרות,
	// s = לפי ההצעות (null = לא נמצא במצב הזה). הדשבורד מציג לכל מצב את שלו.
	const counted = (m) => engine.VERDICT_TOPICS.includes(m.topic);
	const levelOf = (m) => (counted(m) ? m.level : 'wording');
	const bySpan = new Map();
	for (const mode of ['approved', 'suggested']) {
		for (const m of both[mode].matches) {
			const key = m.start + ':' + m.end;
			let row = bySpan.get(key);
			if (!row) {
				const c = engine.contextOf(text, m, CONTEXT_SIDE);
				row = { pos: m.start, w: m.text, line: m.line, t: m.topic, a: null, s: null, e: [], d: [],
					b: c.before, x: c.text, f: c.after };
				bySpan.set(key, row);
			}
			row[mode === 'approved' ? 'a' : 's'] = levelOf(m);
			for (const e of m.entries) if (!row.e.includes(e.id)) row.e.push(e.id);
			for (const e of m.demotedBy || []) if (!row.d.includes(e.id)) row.d.push(e.id);
		}
	}
	const rank = { problem: 0, review: 1, wording: 2 };
	const all = [...bySpan.values()].sort((x, y) => (rank[x.s || x.a] - rank[y.s || y.a]) || x.pos - y.pos);
	const counts = {};
	for (const mode of ['approved', 'suggested']) {
		const c = { problem: 0, review: 0, wording: 0 };
		for (const m of both[mode].matches) c[levelOf(m)]++;
		counts[mode === 'approved' ? 'a' : 's'] = c;
	}
	return {
		verdict: both.approved.verdict,
		verdict_suggested: both.suggested.verdict,
		counts,
		matches: all.slice(0, MAX_MATCHES).map(({ pos, ...rest }) => rest),
		matches_total: all.length,
	};
}

function resultRow(page, lists, version) {
	const rev = page.revisions && page.revisions[0];
	const text = rev ? rev.slots.main.content : '';
	const images = imagesOf(page, text);
	return {
		wikipedia_id: page.pageid,
		title: page.title,
		rev_id: page.lastrevid || (rev && rev.revid) || null,
		length: page.length != null ? page.length : null,
		...scanPage(text, lists),
		image_count: images.all.length,
		photo_count: images.photos.length,
		has_images: images.photos.length > 0,
		own_image_count: images.own.length,
		images: images.photos.slice(0, MAX_IMAGES),
		lists_version: version,
		scanned_at: new Date().toISOString(),
	};
}

// ===== ריצה =====

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const version = listsVersion();
	const lists = compileBoth();
	if (lists.suggested.problems.length) throw new Error('תבניות לא תקינות: ' + JSON.stringify(lists.suggested.problems));
	const db = args.dryRun ? null : supabase();

	let targets;
	if (args.idsFile) {
		targets = fs.readFileSync(args.idsFile, 'utf8').split(/\s+/).filter(Boolean).map((id) => ({ id: Number(id) }));
	} else {
		targets = await (db || supabase()).missing();
	}
	log(`רשימת החסרים: ${targets.length} ערכים. גרסת רשימות ${version}.`);

	let existing = new Map();
	if (db) {
		existing = new Map((await db.existing()).map((r) => [r.wikipedia_id, r]));
		log(`תוצאות קודמות בטבלה: ${existing.size}`);
		// הגנה: רשימה שהתכווצה פתאום (שגיאה, או הדוח באמצע חישוב מחדש) לא תמחק תוצאות.
		if (args.prune && !args.idsFile && targets.length < existing.size * 0.5) {
			log(`אזהרה: הרשימה (${targets.length}) קטנה בהרבה מהתוצאות הקיימות (${existing.size}) - לא מוחקים`);
		} else if (args.prune && !args.idsFile) {
			const keep = new Set(targets.map((t) => t.id));
			const stale = [...existing.keys()].filter((id) => !keep.has(id));
			for (let i = 0; i < stale.length; i += 200) await db.remove(stale.slice(i, i + 200));
			log(`נמחקו ${stale.length} ערכים שכבר לא בדוח`);
		}
	}
	if (args.limit) targets = targets.slice(0, args.limit);

	const out = args.out ? fs.createWriteStream(args.out) : null;
	const stats = { scanned: 0, skipped: 0, gone: 0, problem: 0, review: 0, wording: 0, clean: 0, images: 0 };
	let pending = [];
	const flush = async () => {
		if (db && pending.length) await db.upsert(pending);
		pending = [];
	};

	for (let i = 0; i < targets.length; i += API_BATCH) {
		const ids = targets.slice(i, i + API_BATCH).map((t) => t.id);
		// שלב זול: רק מספר הגרסה, כדי לדלג על מה שלא השתנה.
		let todo = ids;
		if (!args.force && existing.size) {
			const info = await queryPages({ pageids: ids.join('|'), prop: 'info', formatversion: '2' });
			todo = info.filter((p) => !p.missing).filter((p) => {
				const old = existing.get(p.pageid);
				return !old || old.rev_id !== p.lastrevid || old.lists_version !== version;
			}).map((p) => p.pageid);
			stats.skipped += ids.length - todo.length;
		}
		if (!todo.length) continue;
		const pages = await queryPages({
			pageids: todo.join('|'), prop: 'info|revisions|images|pageimages', rvprop: 'ids|content', rvslots: 'main',
			imlimit: 'max', piprop: 'name', pilicense: 'any', pilimit: 'max', formatversion: '2',
		});
		for (const page of pages) {
			if (page.missing || !page.revisions) { stats.gone++; continue; }
			const row = resultRow(page, lists, version);
			stats.scanned++;
			stats[row.verdict_suggested]++;
			if (row.has_images) stats.images++;
			if (out) out.write(JSON.stringify(row) + '\n');
			pending.push(row);
			if (pending.length >= DB_BATCH) await flush();
		}
		if ((i / API_BATCH) % 20 === 0) {
			log(`${Math.min(i + API_BATCH, targets.length)}/${targets.length} - נסרקו ${stats.scanned}, דולגו ${stats.skipped}`);
		}
	}
	await flush();
	if (out) out.end();
	log('סיום: ' + JSON.stringify(stats));
	log('(הספירה לפי רמות - לפי הרשימות כולל ההצעות, על הערכים שנסרקו בריצה הזו בלבד)');
}

if (require.main === module) {
	main().catch((e) => {
		console.error('שגיאה: ' + (e.stack || e.message));
		process.exitCode = 1;
	});
}

module.exports = { scanPage, imagesOf, listsVersion, compileBoth, resultRow };
