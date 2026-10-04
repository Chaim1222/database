// הלוגיקה הטהורה של "קביעת גרסת מקור" מועתקת מ-gadget-sortTemplateFix.js לדשבורד (כדי שלא יידרש דף נוסף באתר).
// הבדיקה נכשלת אם שני העותקים מתפצלים: שינוי בלוגיקה חייב להיעשות בשניהם.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function pureBlock(file) {
	const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
	const a = src.indexOf('// <fix-pure>'), b = src.indexOf('// </fix-pure>');
	assert.ok(a >= 0 && b > a, file + ': לא נמצא בלוק fix-pure');
	return src.slice(a, b);
}

test('הבלוק הטהור בדשבורד זהה לבלוק בסקריפט קביעת הגרסה', () => {
	assert.strictEqual(pureBlock('gadget-searchHelperDashboard.js'), pureBlock('gadget-sortTemplateFix.js'));
});

test('הבלוק בדשבורד פועל: הוספת תבנית מלאה אחרי {{וח}} והסרת קטגוריית התחזוקה', () => {
	const pure = pureBlock('gadget-searchHelperDashboard.js');
	const { planSortTemplate } = new Function(pure + '\nreturn { planSortTemplate };')();
	const plan = planSortTemplate('{{וח}}\nטקסט\n[[קטגוריה:המכלול:ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה]]\n', { page: 'ערך', rev: 5, item: 'Q1', date: 'ינואר 2020' });
	assert.ok(plan.created && plan.removedCategory);
	assert.ok(plan.text.includes('{{מיון ויקיפדיה|דף=ערך|גרסה=5|פריט=Q1|תאריך=ינואר 2020}}'));
	assert.ok(!plan.text.includes('ללא תבנית מיון'));
});
