// בדיקות לפונקציות הטהורות של gadget-sortTemplateFix.js (בין <fix-pure> ל-</fix-pure>).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gadget-sortTemplateFix.js'), 'utf8');
const pure = src.slice(src.indexOf('// <fix-pure>'), src.indexOf('// </fix-pure>'));
const { planSortTemplate, insertSortTemplate, sortDateFromTimestamp, sortTemplatePage, findSortTemplate, buildSortTemplate } =
  new Function(pure + '\nreturn { planSortTemplate, insertSortTemplate, sortDateFromTimestamp, sortTemplatePage, findSortTemplate, buildSortTemplate };')();

const V = { page: 'ערך', rev: 200, item: 'Q5', date: 'ספטמבר 2025' };

test('תאריך לפי אזור הזמן של ירושלים, כולל גבול חודש', () => {
  assert.strictEqual(sortDateFromTimestamp('2025-09-15T10:00:00Z'), 'ספטמבר 2025');
  assert.strictEqual(sortDateFromTimestamp('2025-08-31T22:30:00Z'), 'ספטמבר 2025'); // 01:30 בירושלים
  assert.strictEqual(sortDateFromTimestamp('2025-01-01T00:00:00Z'), 'ינואר 2025');
});

test('תבנית קיימת: מעדכן גרסה ותאריך שונים ומשאיר את השאר', () => {
  const t = 'טקסט\n{{מיון ויקיפדיה|דף=ערך|גרסה=100|פריט=Q5|תאריך=יולי 2024}}';
  const r = planSortTemplate(t, V);
  assert.strictEqual(r.text, 'טקסט\n{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
  assert.deepStrictEqual(r.changes.map(c => c.name), ['גרסה', 'תאריך']);
});

test('גרסה ותאריך תואמים: אין שינוי', () => {
  const t = '{{מיון ויקיפדיה|דף=ערך|גרסה=200|תאריך=ספטמבר 2025|פריט=Q5}}';
  const r = planSortTemplate(t, V);
  assert.strictEqual(r.changes.length, 0);
  assert.strictEqual(r.text, t);
});

test('גרסה 0 או ריקה וחסרים: מעדכן ומוסיף פרמטרים חסרים', () => {
  const r = planSortTemplate('{{מיון ויקיפדיה|דף=ערך|גרסה=0}}', V);
  assert.strictEqual(r.text, '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
  const r2 = planSortTemplate('{{מיון ויקיפדיה|דף=ערך|גרסה=|תאריך=}}', V);
  assert.strictEqual(r2.text, '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
});

test('פריט חסר נכנס לפני תאריך, ובסוף כשאין תאריך', () => {
  assert.strictEqual(planSortTemplate('{{מיון ויקיפדיה|דף=ערך|גרסה=0|תאריך=דצמבר 2016}}', V).text,
    '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
  assert.strictEqual(planSortTemplate('{{מיון ויקיפדיה|דף=ערך|גרסה=0}}', V).text,
    '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
});

test('דף= משתנה רק לפי updatePage; פריט קיים לא נדרס', () => {
  const t = '{{מיון ויקיפדיה|דף=ישן|גרסה=1|פריט=Q9|תאריך=ספטמבר 2025}}';
  assert.ok(planSortTemplate(t, V).text.includes('דף=ישן'));
  assert.ok(planSortTemplate(t, V).text.includes('פריט=Q9'));
  assert.ok(planSortTemplate(t, Object.assign({ updatePage: true }, V)).text.includes('דף=ערך'));
});

test('תבנית בתוך הערה או nowiki נחשבת כלא קיימת', () => {
  const t = 'טקסט <!-- {{מיון ויקיפדיה|דף=א|גרסה=5}} --> <nowiki>{{מיון ויקיפדיה|דף=ב}}</nowiki>';
  assert.strictEqual(findSortTemplate(t), null);
  const r = planSortTemplate(t, V);
  assert.ok(r.created);
  assert.ok(r.text.endsWith('\n' + buildSortTemplate(V)));
});

test('תבנית מקוננת בפרמטר לא שוברת את הזיהוי', () => {
  const t = '{{מיון ויקיפדיה|דף={{x|y}}|גרסה=1|תאריך=ינואר 2020}}';
  const r = planSortTemplate(t, V);
  assert.ok(r.text.startsWith('{{מיון ויקיפדיה|דף={{x|y}}|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025'));
  assert.strictEqual(sortTemplatePage(t), '{{x|y}}');
});

test('הוספה: אחרי {{וח}} או {{קרד}} - הראשון שבטקסט', () => {
  const tpl = buildSortTemplate(V);
  assert.strictEqual(insertSortTemplate('א\n{{וח}}\n[[קטגוריה:ב]]', tpl), 'א\n{{וח}}\n' + tpl + '\n[[קטגוריה:ב]]');
  assert.strictEqual(insertSortTemplate('{{קרד|x=1}}\nא\n{{וח}}', tpl), '{{קרד|x=1}}\n' + tpl + '\nא\n{{וח}}');
  assert.strictEqual(insertSortTemplate('א\n{{וח}}', tpl), 'א\n{{וח}}\n' + tpl);
  assert.strictEqual(insertSortTemplate('{{וח}}טקסט', tpl), '{{וח}}\n' + tpl + '\nטקסט');
});

test('הוספה: בלי וח/קרד - שורה חדשה בסוף; וח בתוך הערה לא נחשב', () => {
  const tpl = buildSortTemplate(V);
  assert.strictEqual(insertSortTemplate('א\nב\n\n', tpl), 'א\nב\n' + tpl);
  assert.strictEqual(insertSortTemplate('א <!-- {{וח}} -->', tpl), 'א <!-- {{וח}} -->\n' + tpl);
  assert.ok(!/\{\{וחש/.test(insertSortTemplate('{{וחשוב}}', tpl).split('\n')[1] || ''));
  assert.strictEqual(insertSortTemplate('{{וחשוב}}', tpl), '{{וחשוב}}\n' + tpl);
});

test('בלי פריט: התבנית החדשה בלי פריט=', () => {
  assert.strictEqual(buildSortTemplate({ page: 'ערך', rev: 5, item: '', date: 'מאי 2020' }), '{{מיון ויקיפדיה|דף=ערך|גרסה=5|תאריך=מאי 2020}}');
});
