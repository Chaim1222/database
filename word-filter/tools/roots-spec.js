// חלוקת כל הרשומות לשורשים - הצעה של Claude (2026-09-28), לסידור מחדש של הרשימות עם חיים.
// לכל רשומה: תפקיד מוצע.
//   anchor  - בעיה תמיד (עוגן): בעייתי בכל מופע, בלי חישוב.
//   general - לבדיקה לפי ההקשר: רמת החשד לפי הנתונים ולפי מילים אחרות בדף.
//   fixed   - לבדיקה קבוע: רמת החשד לפי הנתונים בלבד, בלי השפעה של מילים אחרות.
//   wording - הערת ניסוח (לא נספר ברמת הדף).
//   names   - שמות הקודש (קטגוריה נפרדת).
//   drop    - להוריד מהרשימה.
//   merge:<id> - לאחד עם רשומה אחרת (כפילות).
// הטקסט אחרי | - הנימוק (מוצג בדף).
'use strict';
module.exports = [
	{ id: 'min', label: 'מין', topic: 'modesty', note: 'המילה הכללית "מין" היא לרוב species או מגדר (C). הצירופים המפורשים - עוגנים. מילות הקשר (k011-k023) מכריעות את "מין" לבד.', entries: {
		w0296: 'general|"מין" לבד: ברוב המופעים זן או מגדר',
		w0013: 'anchor', w0026: 'anchor', w0098: 'anchor', w0089: 'anchor',
		w0091: 'anchor|"מין אוראלי/אנאלי" - צירוף מפורש',
		w0088: 'anchor|"פרשת המין" - צירוף מפורש',
		w0099: 'drop|"ינות המין" - שבר של מילה ("זנות המין"?) - כלול ב-"זנות" וב"מין"; לבדוק',
		w0123: 'general|"אותו המין": ביולוגיה או זוגיות - מילות ההקשר k014-k017 מכריעות',
	} },
	{ id: 'mini', label: 'מיני / מינית / מיניות', topic: 'modesty', note: '"מיני" לבד הוא כמעט תמיד "מיני צמחים", mini. "מינית", "מיניות" והצירופים - עוגנים.', entries: {
		w0020: 'general|"מיני" לבד: 7% בעייתי (מיני צמחים, מיני סדרה)',
		w0022: 'general|"מיניים": גם "דו-מיניים" בפרחים',
		w0019: 'anchor', w0021: 'anchor',
	} },
	{ id: 'sex', label: 'סקס / sex', topic: 'modesty', note: '', entries: {
		w0001: 'general|"סקס" נתפס גם ב"סקסופון", "וסקס", "אנגלו-סקסי"',
		w0017: 'anchor', w0365: 'anchor',
		w0076: 'general|"sex" גם ב-"sex differences", Essex, Sussex',
	} },
	{ id: 'rape', label: 'אונס', topic: 'modesty', note: '"אונס" הוא גם שם (האנס, לאנס, ואנס) וגם כפייה בהלכה ("מאונס"). מילות ההקשר k001-k006 מכריעות.', entries: {
		w0027: 'general|53% בעייתי בערכים החדשים - השאר שמות וכפייה בהלכה',
		w0086: 'anchor|"אינוס" - תמיד במובן אונס (בלי "אינוסבך")',
		w0427: 'anchor',
	} },
	{ id: 'zenut', label: 'זנות', topic: 'modesty', note: '', entries: {
		w0003: 'anchor', w0004: 'anchor', w0009: 'anchor',
		w0010: 'anchor|"נערת ליווי"', w0011: 'anchor|"יצאנית"', w0136: 'anchor|"בית בושת"',
		w0402: 'anchor|"פרוצות" (לבדיקה היום)', w0390: 'anchor', w0361: 'anchor', w0419: 'anchor',
		w0426: 'general|"hooker" - גם שם (John Lee Hooker)',
	} },
	{ id: 'lgbt', label: 'להט"ב', topic: 'modesty', note: '', entries: {
		w0014: 'general|"הומו" גם ב"הומו סאפיינס", "הומודימר"', w0294: 'drop|"הומואספ" - כלול ב"הומו"',
		w0323: 'anchor', w0018: 'anchor', w0052: 'anchor', w0131: 'anchor', w0069: 'anchor', w0097: 'anchor', w0120: 'anchor', w0410: 'anchor', w0015: 'anchor', w0325: 'anchor',
		w0063: 'general|"גאים/הגאה" - גם "גאים בכך", "התל הגאה"',
		w0206: 'anchor|"נישואים פתוחים/גאים"',
		w0111: 'general|"קוויר" - גם "קווירינל", "קוויר" כשם',
		w0121: 'general|"טרנס" - לרוב שם (טרנס טאו) או "טרנס-פסיפי"',
		w0300: 'general|"דראג" - גם מרוצי דראג, שם משפחה',
		w0391: 'anchor|"קוקסינל"', w0066: 'general|"סטרייט" - לרוב שם (ג\'ורג\' סטרייט)',
		w0404: 'anchor|"משכב זכר"', w0134: 'anchor|"מעשי סדום"',
	} },
	{ id: 'love', label: 'אהבה, רומן וזוגיות', topic: 'modesty', note: 'אהבה רומנטית - בעייתי; אהבה לתורה, לטבע, להורים - תמים.', entries: {
		w0210: 'general|"אהבה": 61% בעייתי', w0071: 'anchor', w0043: 'anchor', w0044: 'anchor', w0223: 'anchor',
		w0070: 'anchor|"נאהבים"', w0031: 'anchor|"יחסי אהבה"',
		w0032: 'general|"רומן": לרוב ספר (36% בעייתי)',
		w0107: 'general|"מערכת יחסים": 82% בעייתי, אבל גם "מערכת יחסים בין מדינות"',
		w0082: 'general|"בן/בת זוגו": 64%', w0110: 'anchor|"החל לצאת עם"',
		w0215: 'general|"חיזור": גם חיזור בבעלי חיים וחמצון-חיזור', w0231: 'general|"לחזר"', w0232: 'general|"מחזר": גם "למחזר" (recycle)',
		w0074: 'anchor', w0211: 'anchor|"הצעת נישואין"',
		w0008: 'general|"תשוקה": גם תשוקה לידע', w0234: 'general|"תאוה"', w0224: 'general|"הוא נמשך" - גם "נמשך זמן רב"',
		w0034: 'general|"אינטימי": גם "אלבום אינטימי"', w0396: 'anchor|"סטוץ"', w0394: 'anchor|"פוליאמוריה"', w0133: 'anchor|"חילופי זוגות"',
		w0208: 'general|"בת לוויה" - גם במובן מלווה',
	} },
	{ id: 'kiss', label: 'נשיקה', topic: 'modesty', note: '', entries: {
		w0377: 'general|"נשיקה": 76%', w0378: 'anchor', w0226: 'general|"נשקה" - גם "מנשקה" (מנשקם)',
	} },
	{ id: 'adultery', label: 'ניאוף, נישואים ויחסים אסורים', topic: 'modesty', note: '', entries: {
		w0057: 'anchor', w0389: 'anchor', w0205: 'anchor|"מחוץ לנישואין"',
		w0048: 'anchor|"ילד לא חוקי"', w0049: 'anchor|"בן לא חוקי"',
		w0037: 'general|"הרמון" - גם שם (גרובר הרמון) וסדרה', w0038: 'anchor',
		w0216: 'general|"אישות" - הלכות אישות', w0227: 'anchor|"בעילה אסורה"', w0405: 'anchor|"עריות"',
		w0386: 'anchor|"שכב עם"',
	} },
	{ id: 'body', label: 'גוף ואיברים', topic: 'modesty', note: '', entries: {
		w0040: 'general|"שדיים": גם ברפואה ובארכאולוגיה', w0042: 'anchor|"דגדגן"', w0124: 'general|"חזיה" - גם "על חזיהם"',
		w0118: 'anchor|"ציצי"', w0217: 'general|"נרתיק": גם נרתיק לעדשה', w0219: 'general|"פין": כמעט תמיד שם',
		w0218: 'general|"אשכים/אשך" - גם "אשכול"?', w0403: 'general|"פטמות" - גם ביונקים', w0409: 'anchor|"זקפה"', w0408: 'general|"שפיכה" - גם שפיכת נפט',
		w0422: 'general|penis/vagina - גם שמות (Peniston)', w0423: 'anchor', w0421: 'general|"tits" - גם ציפורים',
		w0221: 'anchor|"כח גברא"', w0047: 'general|"וסת": כמעט תמיד "מווסת"', w0387: 'general|"להשתין"',
	} },
	{ id: 'nude', label: 'עירום, חשיפה ולבוש', topic: 'modesty', note: '', entries: {
		w0033: 'anchor', w0085: 'anchor|"נודיסט"', w0364: 'general|"nude" - גם שם בושם',
		w0310: 'general|"חשופה": כמעט תמיד "חשפה (גילתה)"', w0024: 'anchor',
		w0392: 'anchor', w0367: 'anchor', w0375: 'general|"ביקיני" - גם אטול ביקיני', w0376: 'anchor|"חוטיני"',
		w0380: 'general|"בגדי ים"', w0381: 'general|"הלבשה תחתונה"', w0368: 'anchor', w0382: 'general|"גרבונים"',
		w0406: 'general|"מחשוף"', w0407: 'general|"חצאית מיני"',
	} },
	{ id: 'porn', label: 'פורנוגרפיה, אירוטיקה ומעשים מיניים', topic: 'modesty', note: '', entries: {
		w0023: 'anchor', w0363: 'anchor', w0051: 'anchor', w0416: 'anchor', w0012: 'anchor|"זימה" (אלבום "זימה" - שם)',
		w0105: 'general|"פלייבוי" - גם שם אמן', w0425: 'general|"Playboy"', w0397: 'anchor', w0398: 'anchor', w0399: 'anchor',
		w0428: 'general|"XXX" - גם ספרור רומי', w0418: 'anchor', w0075: 'anchor', w0417: 'general|"fetish" - גם commodity fetishism',
		w0067: 'anchor', w0068: 'anchor', w0393: 'general|"ויברטור" - גם כלי עבודה', w0132: 'anchor', w0056: 'anchor', w0414: 'anchor',
		w0028: 'anchor', w0415: 'anchor', w0050: 'anchor|"משגל"', w0413: 'anchor', w0102: 'anchor|"מעשה מגונה"', w0036: 'anchor',
	} },
	{ id: 'animals', label: 'רבייה בבעלי חיים', topic: 'modesty', note: '', entries: {
		w0222: 'general|"הזדווגות": כמעט תמיד בעלי חיים', w0233: 'general|"ייחום"', w0204: 'general|"סירוס" - גם האי סירוס',
	} },
	{ id: 'health', label: 'מניעה ובריאות', topic: 'modesty', note: '', entries: {
		w0045: 'anchor|"קונדום"', w0046: 'anchor', w0025: 'general|"איידס" - שאלת מדיניות',
	} },
	{ id: 'vulgar', label: 'ניבולי פה', topic: 'modesty', note: '', entries: {
		w0104: 'general|"זיין" - לרוב "כלי זיין" או שם', w0101: 'anchor', w0114: 'general|"זין" - לרוב שם (זין אל-עאבדין)',
		w0115: 'general|"הזין" - לרוב להזין (להאכיל)', w0119: 'general|"מזוין" - בטון מזוין, שוד מזוין',
		w0096: 'anchor|"שמוק"', w0369: 'anchor', w0357: 'anchor', w0358: 'anchor', w0359: 'anchor', w0360: 'general|"sluta" בשוודית',
		w0362: 'anchor', w0370: 'general|"פוסי" - גם שם (כפוסי)', w0420: 'anchor', w0077: 'anchor',
		w0400: 'general|"כוסית" - הרמת כוסית', w0401: 'anchor|"מניאק"', w0366: 'general|"horny" - גם שם',
	} },
	{ id: 'beauty', label: 'יופי, מקצועות ובידור', topic: 'modesty', note: '', entries: {
		w0039: 'fixed|הכרעת חיים: לבדיקה, לא מושפע ממילים אחרות', w0078: 'general|"מלכת היופי"', w0079: 'anchor',
		w0080: 'general|"מיס": גם "מיס מארפל", "מיס ון דר רוהה"', w0214: 'general|"יפהפייה"',
		w0384: 'general|"רקדנית"', w0213: 'general|"שחיינית"', w0383: 'general|"קברט"', w0385: 'general|"מועדוני לילה"',
		w0212: 'drop|"אקרנים" - 0 מ-40 בעייתיים ("יצא לאקרנים")',
		w0372: 'general|"פיתוח גוף"', w0373: 'general|"מפתח גוף"', w0374: 'general|"מר אולימפיה"', w0371: 'general|"IFBB"',
	} },
	{ id: 'virgin', label: 'בתולה', topic: 'modesty', note: '"הבתולה" (מריה), קבוצת כוכבים, יער בתולי - תמים.', entries: {
		w0055: 'general|"בתולה/בתולים": 15 מ-38 בעייתיים', w0324: 'merge:w0055|"בתולה" - כלולה ב-w0055',
	} },
	{ id: 'faith', label: 'אמונה ונצרות', topic: 'faith', note: 'הערות ניסוח.', entries: {
		w0235: 'wording', w0379: 'wording', w0237: 'wording', w0238: 'wording',
		w0263: 'wording|"אלים" - גם במובן אלימות ("ונהייה אלים")', w0346: 'merge:w0263|"האל/האלים" - חופף ל-w0263',
		w0264: 'wording', w0265: 'wording', w0266: 'wording', w0267: 'wording', w0273: 'wording',
		w0274: 'wording', w0276: 'wording', w0278: 'wording', w0249: 'names|שם קודש בניקוד',
	} },
	{ id: 'names', label: 'שמות הקודש', topic: 'names', note: 'קטגוריה נפרדת - לא נספרת ברמת הדף.', entries: {
		w0239: 'names', w0241: 'names', w0246: 'names', w0250: 'names', w0251: 'names', w0260: 'names', w0261: 'names', w0279: 'names', w0280: 'names',
	} },
	{ id: 'age', label: 'גיל העולם', topic: 'age', note: 'חמור (חיים, 2026-09-24). כפילויות בין הרשומות הישנות להצעות - לאחד.', entries: {
		w0148: 'anchor|מיליוני שנים', w0431: 'merge:w0148|זהה ל-w0148 (+"למ\\"ש")',
		w0429: 'anchor|מספר שנים ≥ 6,000', w0430: 'anchor|"8 אלף שנה", "עשרות אלפי שנים"',
		w0154: 'anchor|גיל היקום', w0434: 'merge:w0154|כולל את w0154 + "המפץ הגדול"',
		w0167: 'anchor|תקופות גאולוגיות', w0435: 'merge:w0167|כל התקופות בתבנית אחת', w0179: 'merge:w0167', w0188: 'merge:w0167',
		w0180: 'general|"קרבון" - גם פחמן', w0187: 'general|"האדן" - גם שם',
		w0197: 'anchor|4000-9000 לפנה"ס', w0432: 'merge:w0197|שנה לפנה"ס ≥ 3761', w0433: 'merge:w0197|האלף הרביעי לפנה"ס ואילך', w0194: 'merge:w0197',
		w0153: 'general|"לפני זמננו"',
	} },
	{ id: 'dating', label: 'תיארוך, אבולוציה ומחקר המקרא', topic: 'dating', note: 'הערות ניסוח.', entries: {
		w0141: 'wording', w0142: 'wording', w0143: 'wording', w0145: 'wording', w0152: 'wording', w0155: 'wording',
		w0149: 'wording|"000 שנה" - חופף ל-w0429 (גיל העולם)', w0151: 'wording', w0160: 'wording', w0161: 'wording', w0163: 'wording',
		w0190: 'wording', w0192: 'wording', w0195: 'wording', w0196: 'wording', w0203: 'wording',
	} },
	{ id: 'wiki', label: 'ויקיפדיה', topic: 'wiki', note: '', entries: {
		w0283: 'wording', w0285: 'wording', w0287: 'wording',
	} },
];
