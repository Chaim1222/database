// רשימות המילים של הגאדג'ט wikitextWordCheck - גאדג'ט מוסתר מסוג package, שנטען רק בלחיצה על "בדיקת מילים".
// ResourceLoader מצרף את דפי ה-JSON בצד השרת, ולכן הם זמינים לכל עורך גם אם הדפים נעולים לקריאה.
// מקור: https://github.com/Chaim1222/database (word-filter/site/)
module.exports = {
	words: require('./wikitextWordCheck-words.json'),
	allow: require('./wikitextWordCheck-allow.json'),
	usage: require('./wikitextWordCheck-usage.json'),
	context: require('./wikitextWordCheck-context.json')
};
