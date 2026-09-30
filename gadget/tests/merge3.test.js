// בדיקות למיזוג התלת-כיווני של טאב "עדכון". הקוד נשלף מהגאדג'ט בין הסימנים <merge3>.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gadget-searchHelperDashboard.js'), 'utf8');
const merge = src.slice(src.indexOf('// <merge3>'), src.indexOf('// </merge3>'));
const tpl = src.slice(src.indexOf('var HE_MONTH_NAMES'), src.indexOf('function fetchWikipediaContent'));
const { merge3, lcsPairs, updateSortTemplate, applyImportReplacements, splitImportTail } = new Function(merge + '\n' + tpl + '\nreturn { merge3, lcsPairs, updateSortTemplate, applyImportReplacements, splitImportTail };')();

const L = (...lines) => lines.join('\n');

test('שינויים שלא חופפים ממוזגים אוטומטית משני הצדדים', () => {
  const base = L('א', 'ב', 'ג', 'ד', 'ה', 'ו');
  const ours = L('א', 'ב מכלול', 'ג', 'ד', 'ה', 'ו');
  const theirs = L('א', 'ב', 'ג', 'ד', 'ה חדש', 'ו');
  const r = merge3(base, ours, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, L('א', 'ב מכלול', 'ג', 'ד', 'ה חדש', 'ו'));
});

test('שינוי זהה בשני הצדדים אינו התנגשות', () => {
  const base = L('א', 'ב', 'ג');
  const both = L('א', 'ב2', 'ג');
  const r = merge3(base, both, both);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, both);
});

test('שינוי שונה באותה שורה הוא התנגשות עם סימנים', () => {
  const r = merge3(L('א', 'ב', 'ג'), L('א', 'ב-מכלול', 'ג'), L('א', 'ב-ויקי', 'ג'));
  assert.strictEqual(r.conflicts, 1);
  assert.strictEqual(r.text, L('א', '<<<<<<< המכלול', 'ב-מכלול', '=======', 'ב-ויקי', '>>>>>>> ויקיפדיה', 'ג'));
});

test('טקסט שהמכלול הסיר לא חוזר כשוויקיפדיה לא נגעה בו', () => {
  const base = L('א', 'פסקה בעייתית', 'ב', 'ג', 'ד', 'ה');
  const ours = L('א', 'ב', 'ג', 'ד', 'ה');
  const theirs = L('א', 'פסקה בעייתית', 'ב', 'ג', 'ד', 'ה חדש');
  const r = merge3(base, ours, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, L('א', 'ב', 'ג', 'ד', 'ה חדש'));
});

test('תוספת חדשה בוויקיפדיה נכנסת, ותוספת מכלול בסוף (תבנית) נשמרת', () => {
  const base = L('א', 'ב', 'ג');
  const ours = L('א', 'ב', 'ג', '{{מיון ויקיפדיה|דף=x|גרסה=5}}');
  const theirs = L('א', 'ב', 'פסקה חדשה', 'ג');
  const r = merge3(base, ours, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, L('א', 'ב', 'פסקה חדשה', 'ג', '{{מיון ויקיפדיה|דף=x|גרסה=5}}'));
});

test('אין שינוי בוויקיפדיה: התוצאה היא הגרסה של המכלול', () => {
  const base = L('א', 'ב'), ours = L('א', 'ב', 'ג מכלול');
  const r = merge3(base, ours, base);
  assert.strictEqual(r.text, ours);
  assert.strictEqual(r.conflicts, 0);
});

test('lcs: קבצים ארוכים עם שינוי קטן נפתרים מהר', () => {
  const a = Array.from({ length: 20000 }, (_, i) => 'שורה ' + i);
  const b = a.slice(); b[10000] = 'שונה'; b.splice(15000, 0, 'תוספת');
  const t = Date.now();
  const r = merge3(a.join('\n'), b.join('\n'), a.join('\n'));
  assert.strictEqual(r.text, b.join('\n'));
  assert.ok(Date.now() - t < 2000);
});

test('עדכון התבנית: גרסה ותאריך מתחלפים, פרמטר חסר מתווסף, תבנית קודמת בטקסט לא נוגעת', () => {
  const now = new Date(2026, 8, 30);
  const text = 'גוף\n{{מיון ויקיפדיה|דף=אבג|גרסה=100|פריט=Q1|תאריך=מרץ 2015}}';
  assert.strictEqual(updateSortTemplate(text, 999, now), 'גוף\n{{מיון ויקיפדיה|דף=אבג|גרסה=999|פריט=Q1|תאריך=ספטמבר 2026}}');
  assert.strictEqual(updateSortTemplate('{{מיון ויקיפדיה|דף=אבג}}', 7, now), '{{מיון ויקיפדיה|דף=אבג|גרסה=7|תאריך=ספטמבר 2026}}');
  assert.strictEqual(updateSortTemplate('אין תבנית', 7, now), 'אין תבנית');
});

test('החלפות הייבוא על הבסיס ועל ויקיפדיה מונעות התנגשות מדומה ב"גיור"', () => {
  const rules = [{ from: 'ויקיפדיה', to: 'המכלול' }];
  const base = L('א', 'ראו ויקיפדיה', 'ג');
  const ours = L('א', 'ראו המכלול', 'ג');          // כך הערך נראה אחרי הייבוא
  const theirs = L('א', 'ראו ויקיפדיה העברית', 'ג'); // ויקיפדיה שינתה את אותה שורה
  assert.strictEqual(merge3(base, ours, theirs).conflicts, 1);
  const r = merge3(applyImportReplacements(base, rules), ours, applyImportReplacements(theirs, rules));
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, L('א', 'ראו המכלול העברית', 'ג'));
});

test('החלפות: גם regex עם דגלים gi, ורק כשיש התאמה', () => {
  assert.strictEqual(applyImportReplacements('Foo foo FOO', [{ from: 'foo', to: 'x' }]), 'x x x');
  assert.strictEqual(applyImportReplacements('abc', [{ from: 'zzz', to: 'x' }]), 'abc');
  assert.strictEqual(applyImportReplacements('abc', null), 'abc');
});

test('זנב הייבוא ({{וח}} + מיון) מופרד ומצורף בחזרה', () => {
  const body = L('גוף', 'עוד');
  const tail = '\n{{וח}}\n{{מיון ויקיפדיה|דף=x|גרסה=5|פריט=Q1|תאריך=מרץ 2015}}';
  const s = splitImportTail(body + tail);
  assert.strictEqual(s.body, body);
  assert.strictEqual(s.tail, tail);
  const s2 = splitImportTail(body + '\n{{וח|דף אחר}}\n{{מיון ויקיפדיה|דף=x|גרסה=5}}\n');
  assert.strictEqual(s2.body, body);
  assert.strictEqual(splitImportTail('גוף בלי תבניות').tail, '');
});

test('שינוי בסוף הערך בוויקיפדיה לא מתנגש עם זנב הייבוא', () => {
  const tail = '\n{{וח}}\n{{מיון ויקיפדיה|דף=x|גרסה=5}}';
  const base = L('א', 'ב', '[[קטגוריה:ישן]]');
  const ours = splitImportTail(L('א', 'ב', '[[קטגוריה:ישן]]') + tail);
  const theirs = L('א', 'ב', '[[קטגוריה:חדש]]');
  const r = merge3(base, ours.body, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text + ours.tail, L('א', 'ב', '[[קטגוריה:חדש]]') + tail);
});

test('שינויים בשורות סמוכות שאינם חופפים ממוזגים אוטומטית', () => {
  const base = L('א', 'ב', 'ג', 'ד');
  const r = merge3(base, L('א', 'ב מכלול', 'ג', 'ד'), L('א', 'ב', 'ג ויקי', 'ד'));
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.text, L('א', 'ב מכלול', 'ג ויקי', 'ד'));
});

test('הוספה צמודה לשינוי של הצד השני נשארת התנגשות (זהירות)', () => {
  const base = L('א', 'ב', 'ג');
  const r = merge3(base, L('א', 'ב מכלול', 'ג'), L('א', 'ב', 'חדש', 'ג'));
  assert.strictEqual(r.conflicts, 1);
});

test('הוספות שונות באותה נקודה הן התנגשות, זהות אינן', () => {
  const base = L('א', 'ג');
  assert.strictEqual(merge3(base, L('א', 'ב1', 'ג'), L('א', 'ב2', 'ג')).conflicts, 1);
  assert.strictEqual(merge3(base, L('א', 'ב', 'ג'), L('א', 'ב', 'ג')).conflicts, 0);
});
