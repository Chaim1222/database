// הדשבורד לא מעתיק את הלוגיקה של קביעת הגרסה: הוא טוען את הסקריפט של חיים מהאתר וקורא ל-mw.sortTemplateFix.
// הבדיקות מוודאות שהסקריפט חושף את הממשק (גם מחוץ לדף היסטוריה), ושכל מה שהדשבורד קורא לו קיים בו.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gadgetSrc = fs.readFileSync(path.join(__dirname, '..', 'gadget-sortTemplateFix.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'gadget-searchHelperDashboard.js'), 'utf8');

function loadGadgetOutsideHistory() {
	const mw = {
		config: { get: (k) => (k === 'wgAction' ? 'view' : null) },
		loader: { using: () => { throw new Error('ממשק דף ההיסטוריה לא אמור לרוץ מחוץ ל-action=history'); } }
	};
	new Function('mw', 'document', 'fetch', gadgetSrc)(mw, undefined, undefined);
	return mw.sortTemplateFix;
}

test('הסקריפט חושף mw.sortTemplateFix מחוץ לדף היסטוריה', () => {
	const api = loadGadgetOutsideHistory();
	assert.ok(api, 'mw.sortTemplateFix לא נחשף');
	['planSortTemplate', 'sortTemplatePage', 'sortDateFromTimestamp', 'formatJerusalemTime', 'previewContext', 'normTitle', 'wikipediaApi', 'lookupWikipediaRevision']
		.forEach((name) => assert.strictEqual(typeof api[name], 'function', name));
	const plan = api.planSortTemplate('{{וח}}\nטקסט\n[[קטגוריה:המכלול:ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה]]\n', { page: 'ערך', rev: 5, item: 'Q1', date: 'ינואר 2020' });
	assert.ok(plan.created && plan.removedCategory);
	assert.ok(plan.text.includes('{{מיון ויקיפדיה|דף=ערך|גרסה=5|פריט=Q1|תאריך=ינואר 2020}}'));
});

test('הדשבורד טוען את הסקריפט מהאתר ולא מעתיק את הלוגיקה', () => {
	assert.ok(dashSrc.includes("SORT_FIX_SCRIPT_PAGE = 'משתמש:גאון הירדן/הוספת תאריך למיון ויקיפדיה.js'"));
	assert.ok(!dashSrc.includes('function planSortTemplate'), 'לוגיקת התבנית הועתקה לדשבורד');
	assert.ok(!dashSrc.includes('fix-pure'));
});

test('כל פונקציה ש-fixSrc בדשבורד קורא לה קיימת בממשק של הסקריפט', () => {
	const api = loadGadgetOutsideHistory();
	const block = dashSrc.slice(dashSrc.indexOf('var fixSrc = (function () {'), dashSrc.indexOf('function effectiveColumns(cfg) {'));
	const used = new Set();
	let m; const re = /\bfix\.(\w+)/g;
	while ((m = re.exec(block))) used.add(m[1]);
	assert.ok(used.size >= 6, 'לא נמצאו שימושים ב-fix.*');
	used.forEach((name) => assert.ok(name in api, 'הדשבורד קורא ל-fix.' + name + ' שלא קיים בממשק'));
});
