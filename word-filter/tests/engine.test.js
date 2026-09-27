// הרצה: node --test word-filter/tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../Gadget-wikitextWordCheck.js');
const words = require('../lists/words.json');
const allow = require('../lists/allow.json');

const ACTIVE = engine.compileLists(words, { entries: [] });        // רשומות פעילות בלבד, בלי מותרות
const FULL = engine.compileLists(words, allow, { suggested: true }); // כולל הצעות
const texts = (t, lists = ACTIVE, options) => engine.scan(t, lists, options).map((m) => m.text);
const verdict = (t, lists = FULL) => engine.verdict(engine.scan(t, lists));

test('lists: every entry compiles and has the required fields', () => {
	assert.strictEqual(FULL.problems.length, 0, JSON.stringify(FULL.problems));
	const ids = new Set();
	for (const e of words.entries.concat(allow.entries)) {
		assert.ok(!ids.has(e.id), 'duplicate id ' + e.id);
		ids.add(e.id);
		assert.ok(['active', 'suggested', 'rejected', 'merged'].includes(e.status), e.id);
		if (e.status === 'merged') assert.ok(words.entries.some((m) => m.id === e.mergedInto && m.status !== 'merged'), e.id);
		assert.ok(e.sources && e.sources.length, e.id);
	}
	for (const e of words.entries) {
		assert.ok(['problem', 'review'].includes(e.level), e.id);
		assert.ok(engine.TOPIC_LABELS[e.topic], e.id);
	}
});

test('suggested entries are off unless asked for', () => {
	const age = 'בני אדם חיו כאן לפני 30,000 שנה.'; // w0429 - עדיין הצעה
	assert.ok(!engine.scan(age, ACTIVE).some((m) => m.topic === 'age'));
	assert.ok(engine.scan(age, FULL).some((m) => m.topic === 'age'));
	assert.deepStrictEqual(texts('she wore panties', FULL), []); // w0424 נדחה - לא נבדק גם עם ההצעות
});

test('fixed patterns from the source pages now match', () => {
	assert.ok(texts('הוא אנס אותה').includes('אנס'));
	assert.ok(texts('זוג לסביות').includes('לסביות'));
	assert.deepStrictEqual(texts('מדינת אריזונה'), []);
	assert.deepStrictEqual(texts('כלי זין רבים'), []);
	assert.deepStrictEqual(texts('רומני'), []);
});

test('masking keeps only visible text, same length and lines', () => {
	const t = '<!-- הערה -->{{תבנית|שם=ערך|חופשי}} [[יעד|כינוי]] [[ערך]] [[קובץ:ש.jpg|ממוזער|250px|כיתוב]] ' +
		'<ref name="n">מקור</ref> https://a.b/c [[קטגוריה:שם|מיון]] {{{1|פרמטר}}} <math>x</math> [[en:Foo]]\nשורה';
	const masked = engine.maskWikitext(t);
	assert.strictEqual(masked.length, t.length);
	assert.strictEqual(masked.split('\n').length, t.split('\n').length);
	assert.deepStrictEqual(masked.split(/\s+/).filter(Boolean), ['ערך', 'חופשי', 'כינוי', 'ערך', 'כיתוב', 'מקור', 'שם', 'שורה']);
	assert.deepStrictEqual(engine.maskWikitext('{{ת|א=[[יעד|כינוי]]|ב}}').split(/\s+/).filter(Boolean), ['כינוי', 'ב']);
});

test('hidden markup is ignored; raw mode sees it', () => {
	const t = '<!-- סקס -->{{סקס}} [[סקס|ערך]] [[קובץ:sex.jpg|ממוזער]]';
	assert.deepStrictEqual(texts(t), []);
	assert.ok(texts(t, ACTIVE, { raw: true }).length);
	assert.deepStrictEqual(texts('ראו [[פורנוגרפיה]]'), ['פורנו']);
});

test('word start: no matches inside words', () => {
	for (const t of ['פסטיבל אשדודאנס', 'חזונות הנביאים', "ג'וזפין בייקר", 'מדינת אבחזיה', 'האמינית']) {
		assert.deepStrictEqual(texts(t), [], t);
	}
	// "תחילת מילה" עדיין נחוץ לתבניות שאינן מילה שלמה (אחרי האיחוד רוב התבניות כבר מילה שלמה).
	assert.ok(texts('מדינת אבחזיה', ACTIVE, { wordStart: false }).length);
	assert.ok(texts('ולסביות').length);
	assert.ok(texts('מסיבה עם אורגיה גדולה').length);
});

test('three-level verdict', () => {
	assert.strictEqual(verdict('תעשיית הפורנו'), 'problem');
	assert.strictEqual(verdict('סיפור אהבה'), 'review');
	// נושאים שאינם צניעות הם הערות ניסוח: נמצאים, אבל לא משנים את רמת הדף.
	assert.strictEqual(verdict('לפי תורת האבולוציה'), 'wording'); // הערת ניסוח בלבד
	assert.strictEqual(engine.scan('לפי תורת האבולוציה', FULL)[0].topic, 'dating');
	assert.strictEqual(engine.verdict(engine.scan('לפי תורת האבולוציה', FULL), ['dating']), 'review');
	// חיים 2026-09-27: "לפנה"ס לבד זה סתם רעש" (w0162 נדחה). שנים שקודמות לבריאה - גיל העולם.
	assert.strictEqual(verdict('נפטר בשנת 419 לפנה"ס'), 'clean');
	assert.strictEqual(verdict('נבנה ב-1900 לפנה"ס'), 'clean');
	assert.strictEqual(verdict('מסביבות 4000 לפנה"ס'), 'problem');
	assert.strictEqual(verdict('שלום עולם'), 'clean');
	const [m] = engine.scan('שורה\nמשהו פורנו כאן', FULL);
	assert.strictEqual(m.line, 2);
	assert.strictEqual(m.level, 'problem');
});

test('allow list: hide = not the word at all; demote = innocent use, shown as review', () => {
	for (const t of ['אתר מורשת של אונסק"ו', 'בואנוס איירס', 'הקיסר אדריאנוס', 'דוכס סקסוניה', 'טרנסילבניה',
		'כל מיני כלים', 'כנסייה רומנסקית']) {
		assert.strictEqual(verdict(t), 'clean', t);
	}
	// הכרעת חיים: שימוש תמים במילה אמיתית לא נעלם - יורד ל"לבדיקה".
	for (const t of ['המין האנושי', 'הממצאים חשפו', '[[מין (טקסונומיה)|מין]] של ציפור',
		'רבייה מינית אפשרית מהשנה השנייה', 'הפרחים דו-מיניים', 'מתבגרים מינית לאט']) {
		assert.strictEqual(verdict(t), 'review', t);
	}
	assert.strictEqual(verdict('בשוגג או באונס'), 'problem'); // a015 נדחה (חיים, 2026-09-27)
	assert.strictEqual(engine.verdict(engine.scan('רבייה מינית', ACTIVE)), 'problem'); // בלי ההיתר
	assert.strictEqual(engine.verdict(engine.scan('רבייה מינית', engine.compileLists(words, allow))), 'review'); // a028 פעיל
	for (const t of ['היא הייתה אנוסה', 'הוא אנס אותה', 'זוג מאותו המין', 'תעשיית הפורנו', 'אלבום Fuck You']) {
		assert.strictEqual(verdict(t), 'problem', t);
	}
});

test('case sensitivity follows the source list', () => {
	// ברשימת במח אין דגל i: (\s|^)ass לא תופס את General Assembly.
	assert.deepStrictEqual(texts('the General Assembly'), []);
});

test('wiki leftovers are checked on visible text only', () => {
	assert.deepStrictEqual(texts('{{ויקיפדיה}} [[ויקיפדיה:מדיניות|מדיניות]] <!-- ויקיפדיה -->'), []);
	assert.ok(texts('הערך הועתק מוויקיפדיה').length);
});

// גיל העולם (הכרעת חיים 2026-09-24): חמור, נספר ברמה. הרשומות עדיין בגדר הצעה.
test('age of the world counts in the verdict; recent dates do not', () => {
	for (const t of ['לפני כ-30 מיליון שנה', 'חיו כאן לפני 30,000 שנה', 'כמעט 14 אלף שנה', 'מסביבות 4000 לפנה"ס',
		'באלף הרביעי לפני הספירה', 'היווצרות כדור הארץ', 'המפץ הגדול', 'חיו בקרטיקון', 'בתקופת הפלייסטוקן'])
		assert.strictEqual(verdict(t), 'problem', t);
	for (const t of ['לפני 5,000 שנה', 'בן 4000 שנים', 'אלף שנים', 'המתוארכות ל-2250 לפנה"ס', 'באלף השלישי לפנה"ס',
		'נסע לטריאסטה', 'לפני 1,000 שנה'])
		assert.notStrictEqual(verdict(t), 'problem', t);
	// רשומות התיארוך הישנות שחיים העביר לגיל העולם - פעילות.
	assert.strictEqual(engine.verdict(engine.scan('לפני מיליון שנה', ACTIVE)), 'problem');
	// w0188 אחרי תיקון הדיוק (2026-09-26): טריאסטה (העיר) לא נתפסת, התקופה הטריאסית כן.
	assert.strictEqual(engine.verdict(engine.scan('נסע לטריאסטה', ACTIVE)), 'clean');
	assert.strictEqual(engine.verdict(engine.scan('בתקופה הטריאסית', ACTIVE)), 'review');
	assert.strictEqual(engine.verdict(engine.scan('חיו לפני 30,000 שנה', ACTIVE)), 'wording'); // w0429 - עדיין הצעה; נתפס רק כתיארוך
});

test('contained matches merge; sentence context is readable text', () => {
	const t = 'משפט קודם. [[קטגוריה:שירים על מיניות]]';
	const ms = engine.scan(t, FULL).filter((m) => m.topic === 'modesty');
	assert.strictEqual(ms.length, 1);
	assert.strictEqual(ms[0].text, 'מיניות');
	const src = 'פתיחה. היא דיברה על [[אלימות מינית בטבח|האלימות המינית]] שבוצעה<ref>{{צ-מאמר|שם=x}}</ref> בטבח. סוף.';
	const [m] = engine.scan(src, FULL).filter((x) => x.topic === 'modesty');
	const c = engine.contextOf(src, m);
	assert.deepStrictEqual([c.before, c.text, c.after], ['היא דיברה על האלימות ', 'המינית', ' שבוצעה בטבח.']);
});

test('context inside a template shows only the parameter text', () => {
	const src = 'בפסטיבל {{קישור שפה|אנגלית|Rape Film|סרט על אונס}} הוכרז השם.';
	const lists = engine.compileLists(words, { entries: [] });
	const m = engine.scan(src, lists).find((x) => x.text === 'אונס');
	assert.ok(m);
	const c = engine.contextOf(src, m);
	assert.strictEqual(c.before + '[' + c.text + ']' + c.after, 'בפסטיבל סרט על [אונס] הוכרז השם.');
});

// רמות חשד לפי הקשר (usage.json, analysis/word-rates.md).
test('context levels: the word and its sentence decide the suspicion', () => {
	const usage = require('../lists/usage.json');
	const ctx = (t) => engine.contextVerdict(engine.contextLevels(t, engine.scan(t, FULL), usage));
	assert.deepStrictEqual(ctx('הרומן "נפשות מתות" מאת גוגול.'), { level: 'review', suspicion: 'low' });      // C לבד
	assert.deepStrictEqual(ctx('הוא הורשע באונס.'), { level: 'review', suspicion: 'medium' });                // B לבד
	assert.deepStrictEqual(ctx('הסרט עוסק במערכת יחסים.'), { level: 'review', suspicion: 'high' });         // A לבד
	assert.deepStrictEqual(ctx('תעשיית הפורנו.'), { level: 'problem', suspicion: null });                     // עוגן
	const t = 'הוא ניהל רומן עם אשתו של חברו, והזונה צחקה.';
	const ms = engine.contextLevels(t, engine.scan(t, FULL), usage);
	assert.strictEqual(ms.find((m) => m.text === 'רומן').context.suspicion, 'high');                        // C + עוגן במשפט
	assert.deepStrictEqual(ctx('ירושלים עיר עתיקה.'), { level: 'clean', suspicion: null });
	assert.deepStrictEqual(ctx('לפי תורת האבולוציה.'), { level: 'wording', suspicion: null });
});

// מילות הקשר (lists/context.json): מכריעות את המובן של "אונס" / "מין" באותו משפט.
test('context clues: a neighbour word decides the sense', () => {
	const usage = require('../lists/usage.json');
	const context = require('../lists/context.json');
	const clues = engine.compileClues(context, { suggested: true });
	assert.deepStrictEqual(clues.problems, []);
	assert.strictEqual(engine.compileClues(context).clues.length,
		context.entries.filter((e) => e.status === 'active').length); // הצעות רק עם suggested
	const one = (t, c) => engine.contextLevels(t, engine.scan(t, FULL), usage, c === undefined ? clues : c)
		.find((m) => m.topic === 'modesty').context;
	// up: הקשר פלילי / פועל עם מושא / צירוף מיני -> בעיה ודאית, עם המילה שהכריעה.
	const convicted = one('הוא הורשע באונס.');
	assert.strictEqual(convicted.level, 'problem');
	assert.deepStrictEqual(convicted.clueWords, ['הורשע']);
	assert.strictEqual(one('הוא הורשע באונס.', null).suspicion, 'medium'); // בלי מילות הקשר - כמו קודם
	assert.strictEqual(one('לאחר מכן הוא אנס אותה.').level, 'problem');
	assert.strictEqual(one('היא נאנסה על ידי שכנה.').level, 'problem');
	assert.strictEqual(one('לה היו חיי מין סוערים.').level, 'problem');
	assert.strictEqual(one('פגישה של עובדות מין.').level, 'problem');
	// up גובר על היתר demote ("באונס" ההלכתי, a015).
	assert.strictEqual(one('הוא נאשם באונס של שכנתו.').level, 'problem');
	// down: שם, הלכה, טקסונומיה, מגדר ברשימה -> חשד נמוך.
	assert.strictEqual(one('הברון האנס פון ונגנהיים (Hans von Wangenheim) היה שגריר.').suspicion, 'low');
	assert.strictEqual(one('מי שנאנס באיומי מוות להזיק ממון של אחר.').suspicion, 'low');
	assert.strictEqual(one('הקמטן הוא מין של לטאה ממשפחת הקמטניים, והמשגל אצלו נדיר.').suspicion, 'low');
	// wording (הכרעת חיים): "מין" כמגדר ברשימה - הערת ניסוח, לא נספרת ברמה.
	assert.strictEqual(one('ללא הבדל גזע, דת, מין או לאום.').level, 'wording');
	const page = (t) => engine.contextVerdict(engine.contextLevels(t, engine.scan(t, FULL), usage, clues));
	assert.deepStrictEqual(page('ללא הבדל גזע, דת, מין או לאום.'), { level: 'wording', suspicion: null });
	assert.strictEqual(page('ללא הבדל גזע, דת, מין או לאום. הם קיימו יחסי מין.').level, 'problem');
	// "שינוי מין" - בעיה; "בני אותו המין" - לא (חיים, 2026-09-27).
	assert.strictEqual(one('הוא עבר ניתוח לשינוי מין.').level, 'problem');
	assert.strictEqual(one('ההורה מאותו המין.').suspicion, 'low');
	assert.strictEqual(one('תהליך שבו הציפור שומעת מבוגר מאותו מין.').suspicion, 'low');
	// אבל זוגיות / נישואים / יחסים בין בני אותו המין - בעיה (k015, withWords).
	const marriage = one('האיסור על נישואים של זוגות מאותו המין בוטל.');
	assert.strictEqual(marriage.level, 'problem');
	assert.deepStrictEqual(marriage.clues, ['k017']); // ההתאמה היא "אותו המין" (w0123)
	assert.strictEqual(one('יחסים בין בני אותו המין.').level, 'problem');
	assert.strictEqual(one('רצונן בבת-זוג מאותו מין.').level, 'problem');                   // k015 - ההתאמה "מין"
	assert.strictEqual(one('ההורה מאותו מין.').suspicion, 'low');
	assert.strictEqual(one('הוא הכיר בזכויות של בני זוג מאותו המין.').level, 'problem');     // k018 - w0089
	assert.strictEqual(one('בתום תקופה זו הוחלפה בחיה חדשה מאותו המין.').suspicion, 'low'); // k016
	// "אנסה את" הוא עתיד של ניסה - לא פועל האונס; "באותו מין" בביולוגיה - לא להט"ב.
	assert.ok(!engine.scan('אני אנסה את מזלי.', FULL).some((m) => m.topic === 'modesty')); // w0027 - מילה שלמה, בלי "אנסה"
	assert.ok(!(one('בין הזכרים והנקבות באותו מין.').clues || []).includes('k013'));
});

test('links: a letter right after ]] joins the word, as the reader sees it', () => {
	// "[[מין (טקסונומיה)|מין]]ים" = "מינים" (species) - לא "מין" לבד.
	assert.deepStrictEqual(texts('[[לסבי]]ת', FULL), ['לסבית']);
	assert.ok(!texts('בסביבה חיים [[דולפין|דולפינ]]ים', ACTIVE).includes('פין'));
	// לפני קישור נשאר רווח: אותיות שימוש מחוץ לקישור לא מסתירות את המילה.
	assert.ok(texts('הוא נאשם ב[[אונס]].').includes('אונס'));
	assert.ok(texts('בעקבות ה[[מין]] הזה').length);
	// הטקסט של ההתאמה הוא מה שהקורא רואה, והמיקום - במקור (לסימון בעורך).
	const t = 'שחקן [[רומן היסטורי|ברומן]] ידוע';
	const m = engine.scan(t, ACTIVE).find((x) => /רומן/.test(x.text));
	assert.ok(m && t.slice(m.start, m.end).includes(m.text));
});

test('match text is trimmed to the word itself', () => {
	// .?.?.?.?.?.?סקסואל.?.? תופסת גם את סוף המילה הקודמת ותחילת הבאה.
	assert.deepStrictEqual(texts('עם גברים הומוסקסואלים בעיקר'), ['הומוסקסואלים']);
	assert.deepStrictEqual(texts('גבר [[הומוסקסואל]] בגרמניה'), ['הומוסקסואל']);
	assert.ok(texts('לבשה בגד ים', FULL).includes('בגד ים'));
});

test('scanHidden: words only in hidden code, with where they were found', () => {
	const hidden = (t) => engine.scanHidden(t, FULL).map((m) => m.text + ':' + m.hidden);
	assert.deepStrictEqual(hidden('התורה מתארת את [[אונס נערה (הלכה)|עינוי]] הנערה'), ['אונס:l']);
	assert.deepStrictEqual(hidden('טקסט <!-- סקס --> נוסף'), ['סקס:c']);
	assert.deepStrictEqual(hidden('[[קובץ:Sex.jpg|ממוזער|כיתוב]]'), ['Sex:f']);
	assert.deepStrictEqual(hidden('{{מיון רגיל:הרצוג, רומן}}'), ['רומן:k']);
	// מה שמוצג לקורא - לא כאן (נספר בסריקה הרגילה), וגם לא יעד של קישור שהכינוי שלו כבר נתפס.
	assert.deepStrictEqual(hidden('תעשיית הפורנו'), []);
	assert.deepStrictEqual(hidden('[[פורנוגרפיה|פורנו]]'), []);
	// לא משפיע על הרמה.
	assert.strictEqual(verdict('טקסט <!-- סקס --> נוסף'), 'clean');
});

test('scanHidden: a word glued to letters or digits inside a URL is not a word', () => {
	const hidden = (t) => engine.scanHidden(t, FULL).map((m) => m.text + ':' + m.hidden);
	assert.deepStrictEqual(hidden('<ref>https://example.com/brightline-2021-niq6ezxik5hiplowbz2e7sexz4-story.html</ref>'), []);
	assert.deepStrictEqual(hidden('<ref>https://example.com/anthony-weiner-sex-scandal</ref>'), ['sex:u']);
});

test('precision fixes approved 2026-09-26 (analysis/pattern-precision.md)', () => {
	const FULL_ACTIVE = engine.compileLists(words, allow); // רשימות מאושרות, כולל ההיתרים הפעילים
	const v = (t) => engine.verdict(engine.scan(t, FULL_ACTIVE));
	// לא נתפסים עוד
	for (const t of ['האלבום השני של הלהקה', 'המועדון האלפיני', 'בית ספר שמוקם בעיר', 'מזימה נגד המלך', 'החליט לחזרה',
		'כתב העת החל לצאת לאור', 'הגייזר המפורסם', 'להקת שוגייז', 'המתאבק סמי זיין', 'מיני-אלבום ראשון', 'אנסמבל כלי נשיפה',
		'הומו ארקטוס', 'נגן סקסטון'])
		assert.ok(['clean', 'wording'].includes(v(t)) && !engine.scan(t, FULL_ACTIVE).some((m) => m.topic === 'modesty' && m.level === 'problem'), t);
	// עדיין נתפסים
	assert.strictEqual(v('הוא שמוק'), 'review'); // w0096 -> לבדיקה (חיים, 2026-09-27)
	assert.strictEqual(v('החל לצאת עם שחקנית'), 'problem');
	for (const t of ['ברוך האל', 'והאל אמר', 'בעזרת האל.']) assert.ok(engine.scan(t, FULL_ACTIVE).some((m) => /האל/.test(m.text)), t);
	assert.strictEqual(v('שוד מזוין'), 'review'); // w0119 הורד ל"לבדיקה"
});

test('names of God: a separate category - found, but not in the level; whole words only', () => {
	// הכרעת חיים 2026-09-27: "זה לא בעיה ולא חשד ולא ניסוח. זה קטגוריה שמות הקודש."
	const names = (t) => engine.scan(t, FULL).filter((m) => m.topic === 'names').map((m) => m.text);
	for (const t of ['שאלוהים יעזור לך', 'הסימטריה האלוהית', 'ברוך האל', 'יהוה צבאות', 'אלוהינו שבשמים']) {
		assert.ok(names(t).length, t);
		assert.strictEqual(verdict(t), 'clean', t); // לא בעיה, לא לבדיקה ולא דורש ניסוח
	}
	assert.strictEqual(verdict('ברוך האל. היא הייתה זונה.'), 'problem');
	assert.deepStrictEqual(names('האלבום החדש'), []);
	assert.deepStrictEqual(names('שדי אברהם הוא יישוב. כך שדי ב-2 מיקרוגרם.'), []);
	assert.deepStrictEqual(names('אבן אלהיתי כתב פירוש'), []);
	assert.deepStrictEqual(names('מדינת יִשְׂרָאֵל'), []); // אֵל - מילה שלמה
});

test('review decisions 2026-09-27: pattern fixes from Chaim\'s notes', () => {
	const L = engine.compileLists(words, allow);
	const hit = (t, id) => engine.scan(t, L).some((m) => m.entries.some((e) => e.id === id));
	// w0298/w0299 (אוחדו ל-w0004): רק זונה/זונות - לא מזונות (המקור [מ]זונ תפס רק אותן)
	assert.ok(!hit('חייב במזונותיה', 'w0004') && !hit('מזונות הילדים', 'w0004'));
	assert.ok(hit('היא הייתה זונה', 'w0004') && hit('בית של זונות', 'w0004'));
	// w0047: וסת כמילה בודדת - לא וסתם, וסתיו
	assert.ok(hit('בזמן הווסת', 'w0047') && hit('מחזור וסת', 'w0047'));
	assert.ok(!hit('וסתם כך הלך', 'w0047') && !hit('בקיץ וסתיו', 'w0047'));
	// a003: תת-מין בלבד - לא "שביתת מין", "לתת מין"
	const FULLL = engine.compileLists(words, allow, { suggested: true });
	const demoted = (t) => engine.scan(t, FULLL).some((m) => (m.demotedBy || []).some((e) => e.id === 'a003'));
	assert.ok(demoted('תת-המין הצפוני'));
	assert.ok(!demoted('שביתת מין') && !demoted('סירבה לתת מין'));
});

test('duplicates merged (analysis/duplicates.md): one entry per word, fixes not undone by a copy', () => {
	const L = engine.compileLists(words, allow);
	const ids = (t) => [...new Set(engine.scan(t, L).flatMap((m) => m.entries.map((e) => e.id)))];
	assert.deepStrictEqual(ids('הוא נאשם באונס'), ['w0027']);
	assert.deepStrictEqual(ids('הסרט אינוסבך'), []);                 // w0086 לא מבטל את התיקון של w0289
	for (const t of ['אנסמבל כלי נשיפה', 'אתר אונסק"ו', 'נאן צ\'אונסי', 'האנוסים בספרד', 'לא אנסה להתחמק', 'מזימה נגד המלך', 'מזונות הילדים'])
		assert.ok(!engine.scan(t, L).some((m) => m.topic === 'modesty'), t);
	for (const t of ['היא הייתה אנוסה', 'אנסו אותה', 'שנאנסה על ידי', 'בזנות', 'ריקוד [[זנות]]י', 'דמות של חשפנית'])
		assert.strictEqual(verdict(t), 'problem', t);
	assert.strictEqual(verdict('החוקרים חשפו את הממצא'), 'review'); // w0310 - "תלוי בהקשר"
	assert.strictEqual(verdict('היא חושפת את גופה'), 'review');
	assert.strictEqual(verdict('מעשים מגונים בקטינים'), 'problem');   // w0102 (במקום "מעשיה מגונה")
	assert.ok(!engine.scan('נגיע לפינה', L).length);                  // פין - מילה שלמה
	assert.ok(engine.scan('ביקור באיי הבתולה', L).every((m) => m.topic !== 'modesty')); // היתר חדש
});

test('anchors (analysis/anchors.json, built by build-usage.js): refreshed 2026-09-27', () => {
	const usage = require('../lists/usage.json');
	const anchors = require('../analysis/anchors.json').entries;
	const W = Object.fromEntries(words.entries.map((e) => [e.id, e]));
	assert.deepStrictEqual(usage.anchors.slice().sort(), anchors.map((a) => a.id).sort());
	for (const a of anchors) {
		assert.strictEqual(W[a.id].status, 'active', a.id);       // לא רשומה שאוחדה
		assert.strictEqual(W[a.id].level, 'problem', a.id);       // לא דורס "לבדיקה" של חיים
	}
	assert.ok(usage.anchors.includes('w0131'));                  // קהילה הגאה - הכרעת חיים
	assert.ok(!usage.anchors.includes('w0063'));                 // הגאים / הגאה - 50%, לא עוגן
	assert.ok(!usage.anchors.includes('w0121'));                 // טרנס - לא בזכות טרנסג'נדר
	const ctx = (t) => engine.contextVerdict(engine.contextLevels(t, engine.scan(t, FULL), usage)).level;
	assert.strictEqual(ctx('הוא פעיל בקהילה הגאה.'), 'problem');
	assert.notStrictEqual(ctx('גבורות עשה בזרעו פיזר גאים.'), 'problem');
	assert.notStrictEqual(ctx('למטבעות שהוזנו למדחן.'), 'problem');  // זנות עוגן - אבל לא הוזנו
});

test('w0077 ass - the word itself, not assets/assessment (Chaim, dashboard 2026-09-27)', () => {
	const L = engine.compileLists(words, allow);
	const hit = (t) => engine.scan(t, L).some((m) => m.entries.some((e) => e.id === 'w0077'));
	for (const t of ['intangible assets', 'risk assessment', 'sexual assault', 'General Assembly', 'associated with']) assert.ok(!hit(t), t);
	for (const t of ['kick his ass', 'What an asshole', 'Ass Kickin', 'Jackass (TV series)']) assert.ok(hit(t), t);
});
