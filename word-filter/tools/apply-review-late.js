#!/usr/bin/env node
/*
 * החלטות מדף הסקירה הישן (https://claude.ai/artifact/5VmQ2qfduxyJjiPnbkaUpz) שנשמרו במסד שלו
 * אחרי הגיבוי decisions/2026-09-27.json ולא הוחלו (נמצא ב-2026-09-28, כשחיים שאל "היה משהו
 * באנוסי שלא הסכמתי איתו"). הגיבוי המלא: decisions/2026-09-27-review-db.json.
 *
 *   node word-filter/tools/apply-review-late.js
 *
 * אידמפוטנטי.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LISTS = path.join(__dirname, '..', 'lists');
const read = (f) => JSON.parse(fs.readFileSync(path.join(LISTS, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(LISTS, f), JSON.stringify(d, null, '\t') + '\n');
const words = read('words.json'), allow = read('allow.json');
const W = Object.fromEntries(words.entries.map((e) => [e.id, e]));
const A = Object.fromEntries(allow.entries.map((e) => [e.id, e]));
const SRC = 'הכרעת חיים בדף הסקירה (2026-09-27), הוחלה ב-2026-09-28';
const note = (e, t) => { if (!(e.note || '').includes(t)) e.note = (e.note ? e.note + ' ' : '') + t; };
const setPattern = (e, p) => { if (e.pattern !== p) { if (!e.original) e.original = e.pattern; e.pattern = p; } };

// ביטויים מותרים שחיים אישר ("approve") ונשארו הצעה.
for (const id of ['a017', 'a023', 'a024', 'a026']) { A[id].status = 'active'; A[id].reviewed = true; note(A[id], SRC + ': אושר.'); }
// a025 (assistant, association...) - אושר, אבל כבר לא נחוץ: w0077 תופס רק את המילה ass עצמה.
A.a025.status = 'rejected';
note(A.a025, SRC + ': אושר, אבל מיותר מאז ש-w0077 הוא מילה שלמה (2026-09-27).');
// a013 - שמות רומיים (אדריאנוס...): '"ולא יאנוס אותה ויבעול בעל" - בעיה. השאר לא'.
// "יאנוס" (פועל, עם אותיות שימוש בלבד) לא מוסתר; שמות שנגמרים ב-יאנוס/קאנוס - כן.
setPattern(A.a013, '(?<![א-ת])(?![ובלכמשה]{0,3}יאנוס(?![א-ת]))[א-ת]*[יקתר]אנוס(?![א-ת])');
A.a013.status = 'active';
A.a013.reviewed = true;
note(A.a013, SRC + ': "ולא יאנוס אותה ויבעול בעל" - בעיה, השאר לא. "יאנוס" לבד (פועל) לא מוסתר.');
// a020 - "טרנסג'דריות וטרנספוביה נתפס כאן" (הוסתרו בטעות): גם כתיב בלי נ', וטרנספוביה.
setPattern(A.a020, '[ובכלמשה]{0,3}["״]?טרא?נס[-־]?(?!ג[\'׳]?נ?דר|ס?קסואל|וסט|ווסט|פוב|ים(?![א-ת])|ית(?![א-ת])|יות(?![א-ת]))[א-ת]+');
note(A.a020, SRC + ': "טרנסג\'דריות וטרנספוביה נתפס כאן" - תוקן, לא מוסתרים.');

// מילים: חיים כתב שהן מיותרות / לא בעיה.
const drop = {
	w0149: '"אם אתה תופס במפורש כל מספר גבוה מבריאת העולם, זה מיותר" (w0429).',
	w0151: '"אם אתה תופס את בריאת העולם בתבניות אחרות זה מיותר".',
	w0203: '"גיאולג לבד זה לא בעיה".',
	// אוחד ב-w0263 ב-2026-09-28, אבל חיים כתב עליו: "לא תפסת כאן שום מקרה של נצרות".
	w0346: '"לא תפסת כאן שום מקרה של נצרות".',
};
for (const [id, why] of Object.entries(drop)) {
	const e = W[id];
	e.status = 'rejected';
	delete e.mergedInto;
	e.reviewed = true;
	note(e, SRC + ': ' + why);
}
// w0263 בלי החלופה של w0346 ("ה אל", "ה אלים").
setPattern(W.w0263, 'האלים|(?<![א-ת])אלים(?![א-ת])');

write('words.json', words);
write('allow.json', allow);
console.log('הוחל.');
