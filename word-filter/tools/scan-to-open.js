#!/usr/bin/env node
/*
 * בדיקת נקיות ל"ערכים לפתיחה" - דפי {{דף לטיפול}} במכלול (בקשת חיים, 2026-09-28).
 * הדפים האלה ריקים במכלול (רק התבנית), ולכן נבדקת הגרסה שלהם בוויקיפדיה - באותו מנוע
 * ובאותן רשימות של "חסר במכלול". ריצה חד-פעמית לקבצים, בלי סופבייס ובלי דשבורד.
 *
 *   node word-filter/tools/scan-to-open.js [--out DIR] [--ids-file F] [--limit N]
 *
 * שלבים:
 *   1. הסיווג של המכלול: כל הדפים בעץ "קטגוריה:דפים לטיפול <סיווג>/<סיווג משנה>" (API המכלול).
 *   2. מזהי הדפים בוויקיפדיה לפי השם (API ויקיפדיה, 50 בבקשה). או --ids-file: מזהים מוכנים
 *      (למשל מסופבייס: mechalol_pages where needs_attention - ראו NOTES).
 *   3. סריקה: scan-missing.js --ids-file --out --dry-run (כ-40 דקות ל-42 אלף ערכים).
 *   4. סיכום: DIR/summary.md (לפי הסיווג) ו-DIR/to-open.csv (לכל ערך: סיווג, רמה, תמונות, מילים).
 * ברירת המחדל ל-DIR: word-filter/analysis/to-open. התוצאות המלאות (results.jsonl) גדולות -
 * לא נשמרות בענף הראשי.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { apiGet } = require('./lib');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'analysis', 'to-open')));
const IDS_FILE = opt('--ids-file', null);
const LIMIT = opt('--limit', null);
const TOPS = ['דתות', 'כפירה', 'ללא סיווג', 'צניעות', 'קדושת התורה', 'תיארוך', 'תרבות'];
const PREFIX = 'קטגוריה:דפים לטיפול ';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function members(cat, type) {
	let res = [], cont = {};
	do {
		const r = await apiGet('mechalol', { action: 'query', list: 'categorymembers', cmtitle: cat, cmtype: type, cmlimit: 500, ...cont });
		res = res.concat((r.query || {}).categorymembers || []);
		cont = r.continue || null;
	} while (cont);
	return res;
}

// 1. שם -> [סיווגים]
async function classification() {
	const out = {}, queue = TOPS.map((t) => PREFIX + t), seen = new Set();
	while (queue.length) {
		const c = queue.shift();
		if (seen.has(c)) continue;
		seen.add(c);
		for (const s of await members(c, 'subcat')) queue.push(s.title);
		for (const p of await members(c, 'page')) if (p.ns === 0) (out[p.title] = out[p.title] || []).push(c.slice(PREFIX.length));
	}
	log('סיווג:', Object.keys(out).length, 'ערכים');
	return out;
}

// 2. שם -> מזהה בוויקיפדיה (כולל הפניות)
async function wikipediaIds(titles) {
	const ids = new Set();
	for (let i = 0; i < titles.length; i += 50) {
		const r = await apiGet('wikipedia', { action: 'query', titles: titles.slice(i, i + 50).join('|'), redirects: 1 });
		for (const p of Object.values(((r.query || {}).pages) || {})) if (p.pageid) ids.add(p.pageid);
		if (i % 5000 === 0) log('מזהים:', i, '/', titles.length);
	}
	return [...ids];
}

// 4. סיכום
const ORDER = ['clean', 'wording', 'review:low', 'review:medium', 'review:high', 'problem'];
const LABEL = { clean: 'נקי', wording: 'ניסוח', 'review:low': 'חשד נמוך', 'review:medium': 'חשד בינוני', 'review:high': 'חשד גבוה', problem: 'בעיה' };
function summarize(rows, cats) {
	const lvl = (r) => (r.ctx_verdict === 'review' ? 'review:' + r.ctx_suspicion : r.ctx_verdict);
	const byCat = {}, total = { n: 0 }, list = [];
	for (const r of rows) {
		const cs = cats[r.title] || ['(בלי סיווג במכלול)'];
		const l = lvl(r);
		total.n++; total[l] = (total[l] || 0) + 1;
		for (const c of cs) for (const k of new Set([c.split('/')[0], c])) { const b = (byCat[k] = byCat[k] || { n: 0 }); b.n++; b[l] = (b[l] || 0) + 1; }
		const words = [...new Set((r.matches || []).filter((m) => !m.h && (m.ca === 'problem' || /high|medium/.test(m.ca || ''))).map((m) => m.w))].slice(0, 6);
		list.push([r.title, cs.join(' | '), LABEL[l] || l, (r.images || []).length, words.join(', ')]);
	}
	const pct = (b, k) => (b[k] ? Math.round((100 * b[k]) / b.n) + '%' : '-');
	const row = (name, b) => `| ${name} | ${b.n} | ${ORDER.map((k) => pct(b, k)).join(' | ')} |`;
	const md = [
		'# בדיקת נקיות - ערכים לפתיחה',
		'',
		`נוצר ב-\`tools/scan-to-open.js\` (${new Date().toISOString().slice(0, 10)}). דפי {{דף לטיפול}} במכלול, נבדקו בגרסה שלהם בוויקיפדיה, ברשימות המאושרות, לפי ההקשר. הסיווג - הקטגוריות "דפים לטיפול" במכלול. ערך בכמה סיווגים נספר בכל אחד.`,
		'',
		`| סיווג | ערכים | ${ORDER.map((k) => LABEL[k]).join(' | ')} |`,
		`|---|---|${ORDER.map(() => '---').join('|')}|`,
		row('**הכל**', total),
		...Object.entries(byCat).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, b]) => row(k.includes('/') ? '  ' + k : '**' + k + '**', b)),
		'',
		'הרשימה המלאה: `to-open.csv` (נפתח באקסל).',
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'summary.md'), md + '\n');
	const esc = (x) => '"' + String(x).replace(/"/g, '""') + '"';
	const csv = [['שם הערך', 'סיווג במכלול', 'רמה', 'תמונות', 'מילים שקבעו'].map(esc).join(',')].concat(list.map((l) => l.map(esc).join(',')));
	fs.writeFileSync(path.join(OUT, 'to-open.csv'), '﻿' + csv.join('\n') + '\n');
	log('נכתב:', path.join(OUT, 'summary.md'), path.join(OUT, 'to-open.csv'));
}

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const catsFile = path.join(OUT, 'classification.json');
	const cats = await classification();
	fs.writeFileSync(catsFile, JSON.stringify(cats));
	let idsFile = IDS_FILE;
	if (!idsFile) {
		idsFile = path.join(OUT, 'ids.txt');
		fs.writeFileSync(idsFile, (await wikipediaIds(Object.keys(cats))).join('\n') + '\n');
	}
	const results = path.join(OUT, 'results.jsonl');
	const scanArgs = [path.join(__dirname, 'scan-missing.js'), '--ids-file', idsFile, '--out', results, '--dry-run', '--force'];
	if (LIMIT) scanArgs.push('--limit', LIMIT);
	if (fs.existsSync(results)) fs.unlinkSync(results);
	execFileSync(process.execPath, scanArgs, { stdio: 'inherit' });
	summarize(fs.readFileSync(results, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), cats);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { summarize };
