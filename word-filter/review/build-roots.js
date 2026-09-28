#!/usr/bin/env node
/*
 * מרכיב את roots-data.json לדף "סידור המילים" (roots.html): כל הרשומות, מחולקות
 * לשורשים (tools/roots-spec.js), ולכל רשומה - התפקיד המוצע, הנתונים והדוגמאות.
 *
 *   node word-filter/review/build-roots.js
 *
 * הנתונים:
 *   - סיווג: המופעים המסווגים (analysis/wiki-random-occurrences.json + missing-labels),
 *     אחרי סריקה מחדש עם הרשימות הנוכחיות - כמו ב-build-usage.js. מופע שעוגן אחר
 *     תופס לא נספר לרשומה.
 *   - מדגמים: בכמה ערכים הרשומה נתפסת (חסומים / ויקיפדיה אקראית / המכלול), ובכמה
 *     ערכים חסומים היא המילה הנספרת היחידה.
 *   - נתפס יחד עם: רשומות אחרות שנתפסות על אותה מילה (כפילות, צירוף שמכיל מילה).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('../tools/lib');
const ROOTS = require('../tools/roots-spec');

const E = lib.engine;
const ROOT = path.join(__dirname, '..');
const words = lib.readJson('words.json');
const usage = lib.readJson('usage.json');
const context = lib.readJson('context.json');
const LISTS = lib.loadLists({ suggested: true });
const byId = Object.fromEntries(words.entries.map((e) => [e.id, e]));

// ===== סיווג =====
const labels = {}; // id -> {p,i,u, ex: {p:[],i:[],u:[]}}
const lab = (id) => (labels[id] = labels[id] || { p: 0, i: 0, u: 0, ex: { p: [], i: [], u: [] } });
function entriesNow(before, x, after) {
	before = (before || '').replace(/^…/, '');
	const text = before + x + (after || '').replace(/…$/, '');
	const from = before.length, to = from + x.length;
	const m = E.scan(text, LISTS).find((m) => m.start < to && m.end > from);
	return m ? m.entries.map((e) => e.id) : null;
}
const flat = (s) => (s || '').replace(/⏎/g, ' ').replace(/\s+/g, ' ');
// מופע שעוגן אחר תופס ("מין" בתוך "יחסי מין") לא נספר למילה הכללית - כך רואים איך היא מתנהגת לבד.
function addLabel(ids, l, b, x, f, title) {
	for (const id of new Set(ids)) {
		if (ids.some((o) => o !== id && usage.anchors.includes(o))) continue;
		const s = lab(id);
		s[l]++;
		if (s.ex[l].length < 4) s.ex[l].push({ t: title || '', b: flat(b).slice(-90), x, f: flat(f).slice(0, 70) });
	}
}
const random = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'wiki-random-occurrences.json'), 'utf8'));
for (const o of random.occurrences) {
	const a = o.context.indexOf('【'), z = o.context.indexOf('】');
	if (a < 0) continue;
	const b = o.context.slice(0, a), x = o.context.slice(a + 1, z), f = o.context.slice(z + 1);
	const ids = entriesNow(b, x, f);
	if (ids) addLabel(ids, o.label[0], b, x, f, o.title);
}
const missing = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'missing-labels.json'), 'utf8'));
const contexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'missing-labels-contexts.json'), 'utf8')).contexts;
for (const [frank, l] of Object.entries(missing.labels)) {
	for (let rn = 1; rn <= l.n; rn++) {
		const c = contexts[frank][rn];
		const ids = entriesNow(c.b, c.x, c.f);
		if (ids) addLabel(ids, l.p.includes(rn) ? 'p' : l.u.includes(rn) ? 'u' : 'i', c.b, c.x, c.f, '');
	}
}

// ===== מדגמים =====
const corpora = lib.loadCorpora();
const sideOf = (name) => (name === 'blacklist' ? 'b' : name.startsWith('wiki') ? 'w' : 'm');
const totals = { b: 0, w: 0, m: 0 };
const hits = {}; // id -> {b,w,m, solo, ex:{b:[],w:[],m:[]}}
const hit = (id) => (hits[id] = hits[id] || { b: 0, w: 0, m: 0, solo: 0, ex: { b: [], w: [], m: [] } });
const together = {}; // "a|b" -> count
const counted = (m) => E.VERDICT_TOPICS.includes(m.topic);
for (const [name, pages] of Object.entries(corpora)) {
	const side = sideOf(name);
	for (const page of Object.values(pages)) {
		totals[side]++;
		const ms = E.scan(page.text, LISTS);
		const seen = new Set();
		for (const m of ms) {
			const ids = m.entries.map((e) => e.id);
			for (const id of ids) {
				const h = hit(id);
				if (!seen.has(id)) {
					h[side]++;
					seen.add(id);
					if (h.ex[side].length < 3) {
						const c = E.contextOf(page.text, m, 90);
						h.ex[side].push({ t: page.title, b: flat(c.before), x: c.text, f: flat(c.after) });
					}
				}
			}
			for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) if (i !== j) together[ids[i] + '|' + ids[j]] = (together[ids[i] + '|' + ids[j]] || 0) + 1;
		}
		if (side === 'b') {
			const ids = new Set(ms.filter(counted).flatMap((m) => m.entries.map((e) => e.id)));
			if (ids.size === 1) hit([...ids][0]).solo++;
		}
	}
	console.error('נסרק', name);
}

// ===== מילות הקשר לפי רשומה =====
const cluesFor = {};
for (const k of context.entries || []) {
	for (const t of k.targets || []) {
		for (const id of ((context.targets || {})[t] || {}).entries || []) {
			(cluesFor[id] = cluesFor[id] || []).push({ id: k.id, dir: k.direction, status: k.status, label: k.label || '' });
		}
	}
}

// ===== הרכבה =====
const ROLE = (s) => { const [role, why] = s.split('|'); return { role, why: why || '' }; };
const groupOf = (id) => (usage.anchors.includes(id) ? 'anchor' : usage.families[id] ? usage.families[id].group : null);
const out = ROOTS.map((r) => ({
	id: r.id, label: r.label, topic: r.topic, note: r.note,
	entries: Object.entries(r.entries).map(([id, spec]) => {
		const e = byId[id], s = labels[id], h = hits[id] || { b: 0, w: 0, m: 0, solo: 0, ex: { b: [], w: [], m: [] } };
		const with_ = Object.entries(together).filter(([k]) => k.startsWith(id + '|')).map(([k, n]) => [k.split('|')[1], n])
			.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([o, n]) => ({ id: o, n, pattern: byId[o] ? byId[o].pattern : '' }));
		return {
			id, pattern: e.pattern, level: e.level, status: e.status, topic: e.topic, fixed: !!e.fixed, note: e.note || e.reviewNote || '',
			group: groupOf(id), ...ROLE(spec),
			lab: s ? { p: s.p, i: s.i, u: s.u, ex: s.ex } : null,
			hits: { b: h.b, w: h.w, m: h.m, solo: h.solo, ex: h.ex },
			with: with_, clues: cluesFor[id] || [],
		};
	}),
}));
const file = path.join(__dirname, 'roots-data.json');
fs.writeFileSync(file, JSON.stringify({ built: new Date().toISOString().slice(0, 10), totals, roots: out }));
console.error('נכתב', file, (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
