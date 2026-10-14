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
		util: { addCSS: (css) => { const st = document.createElement('style'); st.textContent = css; document.head.append(st); }, addPortletLink: () => { const a = document.createElement('a'); a.id = 'portlet'; document.body.append(a); return a; } },
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
	assert.equal(await page.textContent('.wwc-verdict'), 'נמצאו מילים שיש לתקן');
	// בשפה פשוטה: בלי רמות חשד, מילות הקשר, הצעות וסוגי קוד
	assert.doesNotMatch(panel, /חשד|מילת הקשר|הצעה|ודאית|הערה מוסתרת|תבניות/);
	const groups = await page.evaluate(() => $('.wwc-group').map((i, d) => [[$(d).children('summary').text(), d.open, $(d).find('.wwc-text').text()]]).get());
	assert.deepEqual(groups.map((g) => g[0]), ['יש לתקן (2)', 'כדאי לבדוק (1)', 'לשים לב לניסוח (1)', 'בקוד שלא מוצג בערך (1)']);
	assert.deepEqual(groups.map((g) => g[1]), [true, true, false, false]);
	assert.match(groups[0][2], /הורשע באונס/);        // מילת ההקשר (context.json) העלתה ל"יש לתקן"
	assert.match(groups[1][2], /מין של חרק/);          // רמות החשד (usage.json): נשאר "כדאי לבדוק"
	assert.equal(groups[3][2], '<!-- סקס -->');         // הקוד המוסתר: רק השורה עצמה
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
	assert.equal(marks.find((m) => m[1] === 'לשינוי מין')[2], 'rgb(255, 154, 154)'); // הצבע של המילה בבדיקת הקוד (שינוי מין - בעיה ודאית)

	if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });

	// שורת הסיכום פותחת קבוצה סגורה; הערת הצביעה
	await page.click('.wwc-summary .wwc-chip:nth-child(3)');
	assert.equal(await page.evaluate(() => $('.wwc-group')[2].open), true);
	assert.equal(await page.textContent('.wwc-foot'), 'המילים סומנו גם בתצוגה המקדימה.');

	// בדיקה חוזרת (גם מהכפתור שבכרטיס): לא כפילות בצביעה ובפאנל
	await page.click('.wwc-actions .wwc-btn');
	await page.waitForSelector('#wikitextWordCheck li');
	await page.click('#wikitextWordCheckButton');
	await page.waitForSelector('#wikitextWordCheck li');
	assert.equal(await page.evaluate(() => $('.wikitextWordCheck-mark .wikitextWordCheck-mark').length), 0);
	assert.equal(await page.evaluate(() => $('#wikitextWordCheck').length), 1);
	assert.equal(await page.evaluate(() => testState.usings.flat().filter((m) => m === 'ext.gadget.wikitextWordCheck-data').length), 1, 'lists loaded once');

	// סגירה
	await page.click('.wwc-actions .wwc-btn:nth-child(2)');
	assert.equal(await page.evaluate(() => $('#wikitextWordCheck').length), 0);

	// ערך נקי; ערך עם הרבה מופעים - 25 ראשונים ו"הצגת עוד"
	await page.evaluate(() => { document.getElementById('wpTextbox1').value = 'ערך על גאומטריה ומספרים.'; });
	await page.click('#wikitextWordCheckButton');
	await page.waitForSelector('.wwc-verdict');
	assert.equal(await page.textContent('.wwc-verdict'), 'לא נמצאו מילים בעייתיות');
	assert.equal(await page.evaluate(() => $('.wwc-group').length), 0);
	await page.evaluate(() => { document.getElementById('wpTextbox1').value = Array(30).fill('שחקנית פורנו.').join('\n'); });
	await page.click('#wikitextWordCheckButton');
	await page.waitForSelector('.wwc-more');
	assert.equal(await page.evaluate(() => $('.wwc-group').eq(0).find('li').length), 25);
	await page.click('.wwc-more');
	assert.equal(await page.evaluate(() => $('.wwc-group').eq(0).find('li').length), 30);
	assert.equal(await page.evaluate(() => $('.wwc-more').length), 0);

	// סקריפט אישי (ניסיון): הרשימות מדפי משתמש דרך ה-API, ושם כפתור שונה
	const personal = await browser.newPage();
	await personal.setContent(PAGE);
	await personal.addScriptTag({ content: jquery });
	await personal.evaluate(stubs, { action: 'edit', data });
	await personal.evaluate((data) => {
		const names = { words: 'משתמש:X/words.json', allow: 'משתמש:X/allow.json', usage: 'משתמש:X/usage.json', context: 'משתמש:X/context.json' };
		window.wikitextWordCheckPages = names;
		mw.Api = function () { this.get = (q) => { testState.apiTitles = q.titles; return $.Deferred().resolve({ query: { pages: Object.keys(names).map((k) => ({
			title: names[k], revisions: [{ slots: { main: { content: JSON.stringify(data[k]) } } }] })) } }).promise(); }; };
		document.getElementById('wpTextbox1').value = 'הוא הורשע באונס ונידון למאסר.';
	}, data);
	await personal.addScriptTag({ content: gadget });
	await personal.waitForSelector('#wikitextWordCheckButton');
	assert.equal(await personal.textContent('#wikitextWordCheckButton'), 'בדיקת מילים (ניסיון)');
	await personal.click('#wikitextWordCheckButton');
	await personal.waitForSelector('#wikitextWordCheck li');
	assert.equal(await personal.textContent('.wwc-verdict'), 'נמצאו מילים שיש לתקן'); // usage + context נטענו מהדפים
	assert.equal(await personal.evaluate(() => testState.usings.flat().filter((m) => m === 'ext.gadget.wikitextWordCheck-data').length), 0);
	assert.equal((await personal.evaluate(() => testState.apiTitles)).split('|').length, 4);

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
