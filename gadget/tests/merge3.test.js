// בדיקות למיזוג התלת-כיווני של טאב "עדכון". הקוד נשלף מהגאדג'ט בין הסימנים <merge3>.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gadget-searchHelperDashboard.js'), 'utf8');
const merge = src.slice(src.indexOf('// <merge3>'), src.indexOf('// </merge3>'));
const tpl = src.slice(src.indexOf('var HE_MONTH_NAMES'), src.indexOf('function fetchWikipediaContent'));
const { merge3, lcsPairs, updateSortTemplate } = new Function(merge + '\n' + tpl + '\nreturn { merge3, lcsPairs, updateSortTemplate };')();

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
