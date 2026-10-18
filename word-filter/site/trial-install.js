// התקנת ניסיון של גאדג'ט בדיקת המילים כסקריפט אישי (README, "הגאדג'ט באתר" - "ניסיון לפני העלאה").
// הכל בחשבון "בוט גאון הירדן" (החלטת חיים, 2026-10-18), כמו הדשבורד. להדביק פעם אחת בקונסולת הדפדפן (F12)
// בכל דף במכלול, כשמחוברים כבוט. יוצר או מעדכן את "בדיקת מילים.js" ואת 4 קובצי ה-JSON שתחתיו
// מהגרסה ב-main, ומוסיף ל-common.js של הבוט את שתי השורות של הניסיון.
// הרצה חוזרת = עדכון לגרסה האחרונה. להפסקה: למחוק מ-common.js את השורות שבין סימוני wikitextWordCheck.
(function () {
	var RAW = 'https://raw.githubusercontent.com/Chaim1222/database/main/word-filter/';
	var USER = 'בוט גאון הירדן';
	if (mw.config.get('wgUserName') !== USER) { console.error('יש להתחבר כ"' + USER + '" לפני ההתקנה'); return; }
	var base = 'משתמש:' + USER + '/';
	var script = 'בדיקת מילים.js';
	var files = {
		'': 'Gadget-wikitextWordCheck.js',
		'/words.json': 'site/Gadget-wikitextWordCheck-words.json',
		'/allow.json': 'site/Gadget-wikitextWordCheck-allow.json',
		'/usage.json': 'site/Gadget-wikitextWordCheck-usage.json',
		'/context.json': 'site/Gadget-wikitextWordCheck-context.json'
	};
	var list = base + script;
	var START = '// wikitextWordCheck - ניסיון (start)', END = '// wikitextWordCheck - ניסיון (end)';
	var block = [START,
		"window.wikitextWordCheckPages = { words: '" + list + "/words.json', allow: '" + list + "/allow.json', usage: '" + list + "/usage.json', context: '" + list + "/context.json' };",
		"mw.loader.load('/w/index.php?title=' + encodeURIComponent('" + list + "') + '&action=raw&ctype=text/javascript');",
		END].join('\n');
	var api;
	var summary = 'גאדג\'ט בדיקת המילים - ניסיון כסקריפט אישי';

	mw.loader.using('mediawiki.api').then(function () {
		api = new mw.Api();
		return Object.keys(files).reduce(function (p, page) {
			return p.then(function () {
				return fetch(RAW + files[page]).then(function (r) {
					if (!r.ok) throw new Error(files[page] + ': ' + r.status);
					return r.text();
				}).then(function (text) {
					return api.postWithEditToken({ action: 'edit', title: list + page, text: text, summary: summary });
				}).then(function () { console.log('נשמר: ' + list + page); });
			});
		}, $.Deferred().resolve().promise());
	}).then(function () {
		var common = base + 'common.js';
		return api.get({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: common, formatversion: 2 })
			.then(function (d) {
				var page = d.query.pages[0];
				var text = page.revisions ? page.revisions[0].slots.main.content : '';
				var i = text.indexOf(START), j = text.indexOf(END);
				text = i >= 0 && j > i ? text.slice(0, i) + block + text.slice(j + END.length) : (text ? text.replace(/\s*$/, '\n\n') : '') + block + '\n';
				return api.postWithEditToken({ action: 'edit', title: common, text: text, summary: summary });
			}).then(function () { console.log('נשמר: ' + common); });
	}).then(function () {
		console.log('ההתקנה הסתיימה. בדף עריכה (אחרי רענון) יופיע הכפתור "בדיקת מילים (ניסיון)".');
	}, function (err) {
		console.error('ההתקנה נכשלה:', err);
	});
}());
