// בדיקת הגאדג'ט בדפדפן, על דף עריכה מדומה (mw, OO ו-textSelection מדומים; בלי רשת).
// דורש playwright ו-jquery (npm install --no-save playwright jquery). הרצה: node word-filter/tests/gadgetBrowser.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../tools/build-site.js');

const gadget = fs.readFileSync(path.join(__dirname, '../Gadget-wikitextWordCheck.js'), 'utf8');
const jquery = fs.readFileSync(require.resolve('jquery/dist/jquery.min.js'), 'utf8');
const site = build();
const data = { words: site['Gadget-wikitextWordCheck-words.json'], allow: site['Gadget-wikitextWordCheck-allow.json'],
	usage: site['Gadget-wikitextWordCheck-usage.json'], context: site['Gadget-wikitextWordCheck-context.json'] };

const WIKITEXT = 'הוא עבר ניתוח לשינוי מין בגיל 30.\nהוא הורשע באונס ונידון למאסר.\nמין של חרק ממשפחת החיפושיתיים.\nהאלבום השני של הלהקה.\n<!-- סקס -->\nישו הנוצרי.';
const PAGE = `<!doctype html><html dir="rtl"><body>
<form id="editform"><textarea id="wpTextbox1"></textarea>
<div class="editOptions"><span id="wpDiffWidget"><button type="button">הצגת שינויים</button></span></div></form>
<div id="wikiPreview"><div class="mw-parser-output"><p>ניתוח לשינוי מין. הוא הורשע <b>באונס</b> ונידון. מין של חרק. האלבום השני.</p></div></div>
<table class="diff"><tr><td class="diff-deletedline">פורנו ישן</td><td class="diff-addedline">נוסף רומן היסטורי</td></tr></table>
</body></html>`;

function stubs({ action, data }) {
	window.testState = { usings: [], selection: null };
	window.mw = {
		config: { get: (k) => ({ wgAction: action })[k] },
		util: { addPortletLink: () => { const a = document.createElement('a'); a.id = 'portlet'; document.body.append(a); return a; } },
		hook: () => ({ add: () => {} }),
		Title: { newFromText: (t) => ({ getPrefixedText: () => t }) },
		Api: function () { this.get = () => $.Deferred().reject('no api in test'); },
		loader: { using: (m) => { testState.usings.push(m); return $.Deferred().resolve((name) => name === 'ext.gadget.wikitextWordCheck-data' ? data : null).promise(); } }
	};
	window.OO = { ui: { ButtonInputWidget: function (o) {
		this.$element = $('<span>').append($('<button type="button">').attr('id', o.id).text(o.label));
		this.on = (ev, fn) => this.$element.find('button').on(ev, fn);
	} } };
	$.fn.textSelection = function (cmd, opts) {
		if (cmd === 'getContents') return this.val();
		if (cmd === 'setSelection') testState.selection = opts;
		return this;
	};
}

(async () => {
	const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.setContent(PAGE);
	await page.addScriptTag({ content: jquery });
	await page.evaluate(stubs, { action: 'edit', data });
	await page.evaluate((t) => { document.getElementById('wpTextbox1').value = t; }, WIKITEXT);
	await page.addScriptTag({ content: gadget });

	// הכפתור ליד "הצגת שינויים", והרשימות לא נטענות לפני לחיצה
	await page.waitForSelector('#wpDiffWidget + span #wikitextWordCheckButton');
	assert.equal(await page.textContent('#wikitextWordCheckButton'), 'בדיקת מילים');
	assert.deepEqual(await page.evaluate(() => testState.usings.flat().filter((m) => /data/.test(m))), []);

	await page.click('#wikitextWordCheckButton');
	await page.waitForSelector('#wikitextWordCheck li');
	const panel = await page.textContent('#wikitextWordCheck');
	assert.match(panel, /בדיקת מילים חשודות: בעיה ודאית/);
	assert.match(panel, /מילת הקשר: הורשע/);          // מילות ההקשר (context.json) נטענו
	assert.doesNotMatch(panel, /אמונה ונצרות, חשד/);  // הערת ניסוח בלי רמת חשד
	assert.match(panel, /חשד נמוך/);                  // "מין של חרק" - רמות החשד (usage.json)
	assert.match(panel, /שמות הקודש|הערות ניסוח/);
	assert.match(panel, /בקוד שהקורא לא רואה/);       // "סקס" בהערה
	assert.ok(!(await page.evaluate(() => $('#wikitextWordCheck mark').map((i, e) => e.textContent).get())).some((t) => /^האל/.test(t))); // "האל" במילה שלמה בלבד
	assert.equal(await page.evaluate(() => testState.usings.flat().filter((m) => m === 'ext.gadget.wikitextWordCheck-data').length), 1);
	assert.ok(await page.evaluate(() => $('#wikitextWordCheck').next().is('.editOptions')), 'panel above the edit options');

	// קישור "שורה" מסמן את המילה בתיבת העריכה
	await page.click('#wikitextWordCheck li a');
	const sel = await page.evaluate(() => testState.selection);
	assert.equal(WIKITEXT.slice(sel.start, sel.end), 'לשינוי מין');

	// צביעה: בתצוגה המקדימה ובשורה שנוספה; לא בשורה שנמחקה; "האלבום" לא נצבע
	const marks = await page.evaluate(() => $('.wikitextWordCheck-mark').map((i, e) => [[$(e).closest('td,div').attr('class'), e.textContent, e.style.backgroundColor]]).get());
	const texts = marks.map((m) => m[1]);
	assert.ok(texts.includes('באונס') && texts.includes('מין') && texts.includes('רומן'), JSON.stringify(marks));
	assert.ok(!texts.some((t) => /פורנו|האל/.test(t)), JSON.stringify(marks));
	assert.equal(marks.find((m) => m[1] === 'לשינוי מין')[2], 'rgb(255, 85, 85)'); // הצבע של המילה בבדיקת הקוד (שינוי מין - בעיה ודאית)

	if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });

	// בדיקה חוזרת: לא כפילות בצביעה ובפאנל
	await page.click('#wikitextWordCheckButton');
	await page.waitForSelector('#wikitextWordCheck li');
	assert.equal(await page.evaluate(() => $('.wikitextWordCheck-mark .wikitextWordCheck-mark').length), 0);
	assert.equal(await page.evaluate(() => $('#wikitextWordCheck').length), 1);
	assert.equal(await page.evaluate(() => testState.usings.flat().filter((m) => m === 'ext.gadget.wikitextWordCheck-data').length), 1, 'lists loaded once');

	// דף שאינו עריכה: אין כפתור, אבל המנוע חשוף לכלים אחרים
	const view = await browser.newPage();
	await view.setContent(PAGE);
	await view.addScriptTag({ content: jquery });
	await view.evaluate(stubs, { action: 'view', data });
	await view.addScriptTag({ content: gadget });
	assert.equal(await view.evaluate(() => !!document.getElementById('wikitextWordCheckButton')), false);
	assert.equal(await view.evaluate(() => typeof mw.wikitextWordCheck.core.scan), 'function');

	assert.deepEqual(errors, []);
	await browser.close();
	console.log('ok gadgetBrowser');
})().catch((e) => { console.error(e); process.exit(1); });
