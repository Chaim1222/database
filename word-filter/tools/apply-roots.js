#!/usr/bin/env node
/*
 * מחיל את ההחלטות מדף "סידור המילים" (decisions/2026-09-28-roots.json) על הרשימות.
 *
 *   node word-filter/tools/apply-roots.js decisions/2026-09-28-roots.json
 *
 * תפקיד לרשומה (choices):
 *   anchor  - level problem, פעילה, ועוגן ידני (analysis/anchors.json, manual: true).
 *   general - level review (רמת החשד לפי קבוצת השימוש והמילים שלידה).
 *   fixed   - level review + fixed: true.
 *   drop    - status rejected.
 *   merge   - status merged, mergedInto; התבנית מתווספת לרשומה הראשית.
 *   names   - topic names (שמות הקודש), level review.
 * צירופים (phrases): לכל שורש רשומה אחת של "בעיה תמיד" (עוגן) מכל הצירופים שסומנו bad,
 * וביטוי מותר (hide) אחד מכל הצירופים שסומנו ok.
 * בנוסף - התיקונים שחיים ביקש בהערות (EXTRA למטה).
 *
 * אידמפוטנטי: הרצה שנייה לא משנה כלום (הרשומות החדשות מזוהות לפי השדה root).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LISTS = path.join(ROOT, 'lists');
const SPEC = require('./roots-spec');
const file = process.argv[2];
if (!file) { console.error('שימוש: node word-filter/tools/apply-roots.js <decisions.json>'); process.exit(1); }
const dec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const DATE = '2026-09-28';
const SRC = `הכרעת חיים, דף "סידור המילים" (${DATE})`;

const read = (f) => JSON.parse(fs.readFileSync(path.join(LISTS, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(LISTS, f), JSON.stringify(d, null, '\t') + '\n');
const words = read('words.json'), allow = read('allow.json');
const byId = Object.fromEntries(words.entries.map((e) => [e.id, e]));
const anchorsFile = path.join(ROOT, 'analysis', 'anchors.json');
const anchors = JSON.parse(fs.readFileSync(anchorsFile, 'utf8'));
const suggestedMerge = {};
for (const r of SPEC) for (const [id, s] of Object.entries(r.entries)) { const role = s.split('|')[0]; if (role.startsWith('merge:')) suggestedMerge[id] = role.slice(6); }
const log = [];
const note = (e, text) => { if (!(e.note || '').includes(text)) e.note = (e.note ? e.note + ' ' : '') + text; };

// ===== תיקוני תבנית שחיים ביקש בהערות =====
const EXTRA = {
	// "אולי לחפש גם מין אורלי מין אנלי בלי א' לפני הל'"
	w0091: '(?:מין|סקס) (?:אנאלי|אוראלי|אנלי|אורלי)',
	// w0099 ("ינות המין") - "שבר של עבריינות המין, לאחד עם עבירות מין ולכלול גם עבריינות מין או המין"
	w0098: '(?:עבריי?(?:ן|ני|נים|נית|נות)|עבירו?ת|שפחות) ה?מין',
	// w0022 "זה חופף למיניים בהרבה דוגמאות, זה בכוונה?" - לא. "מיני"/"מיניים" רשומה אחת, כמילה שלמה
	// (" מיני" תפס גם את תחילת "מינים", "מינימום").
	w0020: '(?<![א-ת])ו?ה?מיני(?:ים)?(?![א-ת])',
	// תקופות גאולוגיות: אחרי איחוד w0435/w0179/w0188 - תבנית אחת עם גבולות מילה (האיחוד כחלופות
	// החזיר את "טריאס" בלי גבול, ונתפס "בטריאסט"). תואר ("הטריאסית") - כן.
	w0167: '(?<![א-ת])[ובלהמ]{0,2}(?:מיוקן|פליוקן|פלייסטוקן|פליסטוקן|הולוקן|אאוקן|אוליגוקן|פלאוקן|פלאוגן|נאוגן|רביעון|שלישון|קרטיקון|קמבריון|אורדוביק|סילור|טריאס|פלאוזואיקון|מזוזואיקון|קנוזואיקון|פנרוזואיקון|ארכאיקון|פרוטרוזואיקון|האדאיקון|פרקמבריון)(?:י|ית|יים|יות)?(?![א-ת])',
	// קוויר - בעיה תמיד (חיים, 2026-09-28: "כן"): רק המילה ונטיותיה, לא קווירינל, קוויריקו, קווירוז, קווירל.
	w0111: '(?<![א-ת])[ובלכמשה]{0,3}קוויר(?:י|ית|ים|יות|יים|בייטינג|קור)?(?![א-ת])',
};
const EXTRA_MERGE = { w0022: 'w0020', w0099: 'w0098' };
// ביטויים מותרים שחיים אישר בצ'אט.
const EXTRA_ALLOW = [
	{ key: 'playboy-names', pattern: 'פלייבוי קרטי|Playboi Carti|Texas Playboys?', note: 'שמות: הראפר פלייבוי קרטי, להקת Texas Playboys. פלייבוי - בעיה תמיד (חיים, 2026-09-28: "כן").' },
];

// ===== 1. תפקידים =====
function mergeInto(e, targetId) {
	const t = byId[targetId];
	if (!t) throw new Error('אין רשומה ' + targetId);
	e.status = 'merged';
	e.mergedInto = targetId;
	e.mergeNote = `${SRC}: אוחד עם ${targetId}.`;
	if (!t.pattern.includes(e.pattern) && !EXTRA[targetId]) {
		// איחוד תבניות: אם התבנית של המאוחדת לא כלולה - מוסיפים אותה כחלופה.
		if (!t.original) t.original = t.pattern;
		t.pattern = '(?:' + t.pattern + ')|(?:' + e.pattern + ')';
	}
	if (t.status === 'suggested') t.status = 'active';
}
for (const c of dec.choices) {
	const e = byId[c.id];
	if (!e) throw new Error('אין רשומה ' + c.id);
	if (e.status === 'merged' && c.role === 'merge') continue;
	const tag = `${SRC}: ${({ anchor: 'בעיה תמיד', general: 'לבדיקה לפי ההקשר', fixed: 'לבדיקה קבוע', drop: 'להוריד', merge: 'לאחד', names: 'שמות הקודש' })[c.role]}` + (c.note ? ` ("${c.note.trim()}")` : '') + '.';
	if (c.role === 'merge' || (c.role === 'anchor' && /לאחד/.test(c.note || '') && suggestedMerge[c.id])) {
		mergeInto(e, c.into || suggestedMerge[c.id]);
		note(e, tag);
		continue;
	}
	if (c.role === 'drop') {
		e.status = 'rejected';
	} else {
		if (e.status === 'suggested') e.status = 'active';
		if (c.role === 'anchor') e.level = 'problem';
		if (c.role === 'general' || c.role === 'fixed' || c.role === 'names') e.level = 'review';
		if (c.role === 'fixed') e.fixed = true; else delete e.fixed;
		if (c.role === 'names') e.topic = 'names';
	}
	e.reviewed = true;
	note(e, tag);
}
// עוגן בשורש שחיים עבד עליו ולא שינה - אושר (בדף: "אם זה נכון - לא צריך לעשות כלום").
const touched = new Set([...dec.choices.map((c) => c.root), ...dec.phrases.map((p) => p.root), ...(dec.rootnotes || []).map((n) => n.id)]);
const chosen = new Set(dec.choices.map((c) => c.id));
const confirmed = [];
for (const r of SPEC) {
	if (!touched.has(r.id)) continue;
	for (const [id, s] of Object.entries(r.entries)) {
		const e = byId[id];
		// רק מה שכבר פעיל ב"בעיה": לא דורסים "לבדיקה" שחיים קבע קודם (שמוק, פרוצות), ולא מפעילים הצעות.
		if (s.split('|')[0] !== 'anchor' || chosen.has(id) || e.status !== 'active' || e.level !== 'problem') continue;
		e.reviewed = true;
		note(e, `${SRC}: בעיה תמיד (עוגן שלא שונה בדף - אושר).`);
		confirmed.push(id);
	}
}
for (const [id, pattern] of Object.entries(EXTRA)) {
	const e = byId[id];
	if (e.pattern !== pattern) { if (!e.original) e.original = e.pattern; e.pattern = pattern; note(e, `${SRC}: תבנית לפי הערת חיים.`); }
}
for (const [id, into] of Object.entries(EXTRA_MERGE)) if (byId[id].status !== 'merged' || byId[id].mergedInto !== into) mergeInto(byId[id], into);

// ===== 2. צירופים =====
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// התבנית נבנית מהטקסט המוצג של הצירוף (text), לא מהמפתח (key): במפתח הורדו אותיות שימוש
// גם כשהן חלק מהמילה ("מיני" -> "יני", "מסרים" -> "סרים").
function phraseRe(text) {
	const tokens = text.split(/\s+/).filter((t) => t.length >= 2);
	if (tokens.length < 2) return null;
	const tok = (t, i) => {
		// מהמילה הראשונה יורדים רק ו/ה בתחילתה (אותיות שימוש אחרות נשארות, והתבנית מרשה עוד לפניהן);
		// מהשנייה - רק ה' הידיעה, שמותרת בתבנית בכל מקרה.
		const core = i ? t.replace(/^ה(?=[א-ת]{3})/, '') : t.replace(/^ו?ה?(?=[א-ת]{3})/, '');
		return (i ? 'ה?' : '') + esc(core).replace(/-/g, '[-־ ]?');
	};
	return '(?<![א-ת])[ובלכמשה]{0,3}' + tokens.map(tok).join('[\\s:־-]+') + '(?![א-ת])';
}
const rootLabel = Object.fromEntries(SPEC.map((r) => [r.id, r.label]));
const rootTopic = Object.fromEntries(SPEC.map((r) => [r.id, r.topic]));
let nextW = Math.max(...words.entries.map((e) => +e.id.slice(1))) + 1;
let nextA = Math.max(...allow.entries.map((e) => +e.id.slice(1))) + 1;
const newAnchors = [];
const byRoot = {};
for (const p of dec.phrases) (byRoot[p.root] = byRoot[p.root] || { bad: [], ok: [] })[p.choice].push(p);
for (const [root, { bad, ok }] of Object.entries(byRoot)) {
	const alt = (list) => [...new Set(list.map((p) => phraseRe(p.text)).filter(Boolean))].sort();
	if (bad.length) {
		const pattern = alt(bad).join('|');
		let e = words.entries.find((x) => x.root === root && x.kind === 'phrases');
		if (!e) {
			e = { id: 'w' + String(nextW++).padStart(4, '0'), kind: 'phrases', root };
			words.entries.push(e);
			byId[e.id] = e;
		}
		Object.assign(e, { pattern, level: 'problem', topic: rootTopic[root], status: 'active', reviewed: true, sources: [SRC],
			note: `צירופים של "${rootLabel[root]}" שחיים סימן "בעיה תמיד" (${bad.length}): ${bad.map((p) => p.text).join(', ')}.` });
		newAnchors.push(e.id);
	}
	if (ok.length) {
		const pattern = alt(ok).join('|');
		let a = allow.entries.find((x) => x.root === root && x.kind === 'hide' && x.phrases);
		if (!a) {
			a = { id: 'a' + String(nextA++).padStart(3, '0'), root, phrases: true };
			allow.entries.push(a);
		}
		Object.assign(a, { pattern, status: 'active', reviewed: true, sources: [SRC], kind: 'hide',
			note: `צירופים של "${rootLabel[root]}" שחיים סימן "תמים" (${ok.length}): ${ok.map((p) => p.text).join(', ')}.` });
	}
}

for (const x of EXTRA_ALLOW) {
	let a = allow.entries.find((y) => y.extra === x.key);
	if (!a) { a = { id: 'a' + String(nextA++).padStart(3, '0'), extra: x.key }; allow.entries.push(a); }
	Object.assign(a, { pattern: x.pattern, status: 'active', reviewed: true, sources: [SRC], kind: 'hide', note: x.note });
}

// ===== 3. מילים חסרות (הערות לשורש) =====
const MISSING = [
	{ root: 'porn', pattern: '(?<![א-ת])[ובלכמשה]{0,3}(?:נקרופילי?(?:ה|ות|ים|ית|יות)?|נקרופיל|פאראפילי(?:ה|ות)|פרפילי(?:ה|ות)|קינק(?:י|ים|יות)?)(?![א-ת])',
		note: 'חיים, הערה לשורש "פורנוגרפיה": "נקרופיל ונקרופיליה פאראפיליה קינק חסרים כאן".' },
];
for (const m of MISSING) {
	let e = words.entries.find((x) => x.root === m.root && x.kind === 'missing');
	if (!e) { e = { id: 'w' + String(nextW++).padStart(4, '0'), kind: 'missing', root: m.root }; words.entries.push(e); byId[e.id] = e; }
	Object.assign(e, { pattern: m.pattern, level: 'problem', topic: 'modesty', status: 'active', reviewed: true, sources: [SRC], note: m.note });
	newAnchors.push(e.id);
}

// ===== 4. עוגנים ידניים =====
const anchorIds = new Set(newAnchors.concat(confirmed).concat(dec.choices.filter((c) => c.role === 'anchor' && byId[c.id].status === 'active').map((c) => c.id)));
anchors.entries = anchors.entries.filter((a) => !(a.manual && byId[a.id] && byId[a.id].level !== 'problem'));
for (const id of anchorIds) {
	const e = byId[id];
	if (e.topic !== 'modesty') continue;
	const a = anchors.entries.find((x) => x.id === id);
	const n = `${SRC}: בעיה תמיד.`;
	if (a) Object.assign(a, { manual: true, note: a.note && a.note !== n ? a.note : n, pattern: e.pattern });
	else anchors.entries.push({ id, pattern: e.pattern, manual: true, note: n });
}
anchors.entries.sort((a, b) => (a.id < b.id ? -1 : 1));

write('words.json', words);
write('allow.json', allow);
fs.writeFileSync(anchorsFile, JSON.stringify(anchors, null, '\t') + '\n');
const count = (s) => words.entries.filter((e) => e.status === s).length;
console.log(`words: ${count('active')} פעילות, ${count('suggested')} הצעות, ${count('merged')} אוחדו, ${count('rejected')} נדחו`);
console.log('רשומות צירופים:', words.entries.filter((e) => e.kind === 'phrases').map((e) => e.id + ' ' + e.root).join(', '));
console.log('ביטויים מותרים:', allow.entries.filter((a) => a.phrases).map((a) => a.id + ' ' + a.root).join(', '));
console.log('עוגנים שאושרו בלי שינוי:', confirmed.join(' '));
console.log('עוגנים ידניים:', anchors.entries.filter((a) => a.manual).length);
