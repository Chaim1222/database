#!/usr/bin/env node
/*
 * שאריות ויקיפדיה - רק הקוד עצמו, לא המילה בטקסט (חיים, 2026-09-29: "הרעיון לא לתפוס כל מילה
 * 'בעבודה' אלא {{בעבודה}} או {{בעבודה מתמשכת}} וקטגוריות [[ויקיפדיה:").
 * scope: raw - החיפוש בקוד הגולמי (בטקסט המוצג תבניות וקטגוריות מוסתרות).
 *
 *   node word-filter/tools/apply-wiki-leftovers.js   (אידמפוטנטי)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, '..', 'lists', 'words.json');
const words = JSON.parse(fs.readFileSync(F, 'utf8'));
const byId = Object.fromEntries(words.entries.map((e) => [e.id, e]));
const SRC = "הכרעת חיים בצ'אט (2026-09-29)";
const note = (e, t) => { if (!(e.note || '').includes(t)) e.note = (e.note ? e.note + ' ' : '') + t; };
const set = (e, pattern, why) => {
	if (e.pattern !== pattern) { if (!e.original) e.original = e.pattern; e.pattern = pattern; }
	e.scope = 'raw';
	e.reviewed = true;
	note(e, `${SRC}: ${why}`);
};

// {{בעבודה}}, {{בעבודה מתמשכת}} (עם פרמטרים או בלי) - לא "הטרדה מינית בעבודה".
set(byId.w0287, '\\{\\{\\s*בעבודה(?:[ _]+מתמשכת)?\\s*(?:\\||\\}\\})', 'רק התבנית {{בעבודה}} / {{בעבודה מתמשכת}}, לא המילה.');
// [[קטגוריה:ויקיפדיה: ...]] וקישור למרחב ויקיפדיה [[ויקיפדיה:...]] - לא "בוויקיפדיה האנגלית".
set(byId.w0285, '\\[\\[\\s*:?\\s*(?:קטגוריה\\s*:\\s*)?ו?ויקיפדיה\\s*:', 'רק קטגוריה [[קטגוריה:ויקיפדיה:...]] וקישור [[ויקיפדיה:...]], לא המילה.');

fs.writeFileSync(F, JSON.stringify(words, null, '\t') + '\n');
console.log('הוחל: w0285, w0287');
