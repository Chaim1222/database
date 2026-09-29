#!/usr/bin/env node
/*
 * צירופים של "מין"/"סקס" שחסרו (חיים בצ'אט, 2026-09-29: "כן תוסיף את הטבלה").
 * נמצאו בסריקת המדגמים: מופעים של "מין"/"סקס" שלא נתפסו ברשומה ברמת "בעיה" (רק "לבדיקה"),
 * לפי המילה שלפני ואחרי. כמעט כולם בחסומים, כמעט אף אחד בוויקיפדיה האקראית.
 *
 *   node word-filter/tools/apply-min-phrases.js   (ואחריו build-usage.js)
 *
 * אידמפוטנטי. תיקוני w0091 ו-w0098 גם ב-EXTRA של apply-roots.js (שלא ידרוס אותם).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LISTS = path.join(ROOT, 'lists');
const anchorsFile = path.join(ROOT, 'analysis', 'anchors.json');
const words = JSON.parse(fs.readFileSync(path.join(LISTS, 'words.json'), 'utf8'));
const anchors = JSON.parse(fs.readFileSync(anchorsFile, 'utf8'));
const byId = Object.fromEntries(words.entries.map((e) => [e.id, e]));
const SRC = "הכרעת חיים בצ'אט (2026-09-29)";
const note = (e, t) => { if (!(e.note || '').includes(t)) e.note = (e.note ? e.note + ' ' : '') + t; };
const setPattern = (e, p, why) => { if (e.pattern !== p) { if (!e.original) e.original = e.pattern; e.pattern = p; } note(e, `${SRC}: ${why}`); };

// מין/סקס האוראלי, האנאלי - גם עם ה' (היה רק "מין אוראלי").
setPattern(byId.w0091, '(?:ה?מין|ה?סקס) ה?(?:אנאלי|אוראלי|אנלי|אורלי)', 'גם "הסקס האוראלי", "המין האנאלי".');
// עברות מין - כתיב חסר.
setPattern(byId.w0098, '(?:עבריי?(?:ן|ני|נים|נית|נות)|עבירו?ת|עברות|שפחות) ה?מין', 'גם "עברות מין" (כתיב חסר).');

const B = '(?<![א-ת])[ובלכמשה]{0,3}', E = '(?![א-ת])';
const pattern = [
	// מילה לפני
	B + '(?:פושעי|עבדות|עבדי|עבד|סחר|לצורכי|לצרכי|תיירות|תיירי|סצנת|סצנות|תנוחת|בובת|בובות|מכונת|מכונות|מועדון|מועדוני|חנות|חנויות|מסיבת|מסיבות|קלטת|קלטות|שערוריית|שערוריות)[\\s:־-]+ה?(?:מין|סקס)' + E,
	// מילה אחרי
	B + 'ה?(?:מין|סקס)[\\s:־-]+(?:כפוי|בכפייה|בכפיה|בהסכמה|ה?וגינאלי|ה?וגינלי|ה?חודרני|ה?אנונימי|בטלפון)' + E,
	// מילים (לא "אנגלו-סקסי")
	'(?<!אנגלו[-־ ]?)' + B + 'ה?(?:סקסטינג|סקס[-־ ]?פוזיטיב(?:י|ית|יות|יים)?|סקסי(?:ת|ים|ות)?)' + E,
].join('|');

let e = words.entries.find((x) => x.root === 'min' && x.kind === 'missing');
if (!e) {
	e = { id: 'w' + String(Math.max(...words.entries.map((x) => +x.id.slice(1))) + 1).padStart(4, '0'), kind: 'missing', root: 'min' };
	words.entries.push(e);
}
Object.assign(e, { pattern, level: 'problem', topic: 'modesty', status: 'active', reviewed: true, sources: [SRC],
	note: 'צירופים של "מין"/"סקס" שחסרו (נמצאו במדגמים, חיים: "כן תוסיף את הטבלה"): פושעי מין, עבדות/עבד מין, סחר מין, לצורכי מין, תיירות/תיירי מין, סצנת/סצנות מין, תנוחת מין, בובת/מכונת מין, מועדון/חנות/חנויות מין, מסיבת/מסיבות מין, קלטת סקס/מין, שערוריית/שערוריות מין; מין כפוי/בכפייה/בהסכמה/וגינאלי/חודרני/אנונימי/בטלפון; סקסטינג, סקס-פוזיטיב, סקסי/סקסית/סקסיות. גבוליים שלא נכנסו: מלחמות המין, הרגלי המין, לחקר המין, הורמון/סימני/מאפייני מין, המין השלישי, "סקס והעיר הגדולה", "סקס פיסטולס".' });

const a = anchors.entries.find((x) => x.id === e.id);
if (a) Object.assign(a, { pattern, manual: true });
else anchors.entries.push({ id: e.id, pattern, manual: true, note: `${SRC}: בעיה תמיד.` });
for (const id of ['w0091', 'w0098']) { const x = anchors.entries.find((y) => y.id === id); if (x) x.pattern = byId[id].pattern; }
anchors.entries.sort((x, y) => (x.id < y.id ? -1 : 1));

fs.writeFileSync(path.join(LISTS, 'words.json'), JSON.stringify(words, null, '\t') + '\n');
fs.writeFileSync(anchorsFile, JSON.stringify(anchors, null, '\t') + '\n');
console.log('הוחל:', e.id);
