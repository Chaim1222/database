// בדיקות לפונקציות הטהורות של gadget-sortTemplateFix.js (בין <fix-pure> ל-</fix-pure>).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gadget-sortTemplateFix.js'), 'utf8');
const pure = src.slice(src.indexOf('// <fix-pure>'), src.indexOf('// </fix-pure>'));
const { planSortTemplate, insertSortTemplate, sortDateFromTimestamp, sortTemplatePage, findSortTemplate, buildSortTemplate, previewContext, removeMaintenanceCategory, formatTime, zoneFromOption } =
  new Function(pure + '\nreturn { planSortTemplate, insertSortTemplate, sortDateFromTimestamp, sortTemplatePage, findSortTemplate, buildSortTemplate, previewContext, removeMaintenanceCategory, formatTime, zoneFromOption };')();

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

test('תצוגה מקדימה: השורות סביב התבנית וסימון השורה', () => {
  const plan = planSortTemplate('א\nב\nג\n{{קרד}}\n[[קטגוריה:ד]]\nה\nו\nז', V);
  const ctx = previewContext(plan.text, 1);
  assert.deepStrictEqual(ctx.lines.map(l => l.text), ['{{קרד}}', buildSortTemplate(V), '[[קטגוריה:ד]]']);
  assert.deepStrictEqual(ctx.lines.map(l => l.hit), [false, true, false]);
  assert.ok(ctx.before && ctx.after);
  assert.strictEqual(previewContext('בלי תבנית', 2), null);
});

const CAT = '[[קטגוריה:המכלול: ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה]]';
test('קטגוריית התחזוקה נמחקת עם שורתה, והתבנית נכנסת במקומה בלי שורה ריקה', () => {
  assert.strictEqual(planSortTemplate('א\n[[קטגוריה:ב]]\n{{קרד}}\n' + CAT, V).text, 'א\n[[קטגוריה:ב]]\n{{קרד}}\n' + buildSortTemplate(V));
  assert.strictEqual(planSortTemplate('א\n' + CAT + '\n[[קטגוריה:ב]]', V).text, 'א\n[[קטגוריה:ב]]\n' + buildSortTemplate(V));
  assert.strictEqual(planSortTemplate('א\n{{קרד}}\n' + CAT + '\n[[קטגוריה:ב]]', V).text, 'א\n{{קרד}}\n' + buildSortTemplate(V) + '\n[[קטגוריה:ב]]');
  assert.ok(planSortTemplate('א\n' + CAT, V).removedCategory);
});

test('קטגוריית התחזוקה בתוך הערה לא נמחקת; קטגוריה באמצע שורה נמחקת לבדה', () => {
  assert.strictEqual(removeMaintenanceCategory('א <!-- ' + CAT + ' -->'), 'א <!-- ' + CAT + ' -->');
  assert.strictEqual(removeMaintenanceCategory('א ' + CAT + ' ב'), 'א  ב');
  assert.strictEqual(removeMaintenanceCategory('א\n' + CAT), 'א');
});

test('תבנית קיימת וקטגוריית תחזוקה: הקטגוריה מוסרת גם כשאין שינוי בתבנית', () => {
  const t = '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}\n' + CAT;
  const r = planSortTemplate(t, V);
  assert.strictEqual(r.changes.length, 0);
  assert.ok(r.removedCategory);
  assert.strictEqual(r.text, '{{מיון ויקיפדיה|דף=ערך|גרסה=200|פריט=Q5|תאריך=ספטמבר 2025}}');
});

test('זמן קריא לפי שעון ירושלים (חורף וקיץ, חצות)', () => {
  assert.strictEqual(formatTime('2017-12-10T17:40:22Z'), '10.12.2017 19:40');
  assert.strictEqual(formatTime('2025-07-01T09:05:00Z'), '01.07.2025 12:05');
  assert.strictEqual(formatTime('2025-12-31T22:30:00Z'), '01.01.2026 00:30');
});

test('אזור הזמן של התצוגה: System|180 קבוע גם בחורף (גרסת היצירה של 1.3.2017 מוצגת כמרץ)', () => {
  const zone = zoneFromOption('System|180');
  assert.deepStrictEqual(zone, { offset: 180 });
  assert.strictEqual(sortDateFromTimestamp('2017-02-28T21:03:42Z', zone), 'מרץ 2017');
  assert.strictEqual(formatTime('2017-02-28T21:03:42Z', zone), '01.03.2017 00:03');
  // ירושלים האמיתית באותו זמן עדיין פברואר
  assert.strictEqual(sortDateFromTimestamp('2017-02-28T21:03:42Z'), 'פברואר 2017');
});

test('zoneFromOption: ZoneInfo, Offset, ריק', () => {
  assert.deepStrictEqual(zoneFromOption('ZoneInfo|120|Asia/Jerusalem'), { tz: 'Asia/Jerusalem' });
  assert.deepStrictEqual(zoneFromOption('Offset|-300'), { offset: -300 });
  assert.deepStrictEqual(zoneFromOption(''), { tz: 'Asia/Jerusalem' });
  assert.strictEqual(sortDateFromTimestamp('2025-08-31T22:30:00Z', zoneFromOption('ZoneInfo|180|Asia/Jerusalem')), 'ספטמבר 2025');
});
