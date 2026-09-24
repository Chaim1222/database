// הרצה: node --test word-filter/tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanPage, imagesOf, compileBoth, resultRow } = require('../tools/scan-missing.js');

const lists = compileBoth();

test('scanPage: two verdicts, counts, and sentence context per match', () => {
	const text = 'פתיחה. הסרט עוסק בתעשיית הפורנו בשנות ה-70. נפטר בשנת 419 לפנה"ס.';
	const r = scanPage(text, lists);
	assert.strictEqual(r.verdict, 'problem');
	assert.strictEqual(r.verdict_suggested, 'problem');
	assert.strictEqual(r.counts.a.problem, 1);
	assert.strictEqual(r.counts.a.wording, 1);
	const m = r.matches[0];
	assert.strictEqual(m.a, 'problem');
	assert.strictEqual(m.x, 'פורנו');
	assert.strictEqual(m.b + m.x + m.f, 'הסרט עוסק בתעשיית הפורנו בשנות ה-70.');
	assert.strictEqual(r.matches[1].a, 'wording');
});

test('scanPage: a suggested entry changes only verdict_suggested', () => {
	const r = scanPage('בני אדם חיו כאן לפני 30,000 שנה.', lists); // w0429 - הצעה
	assert.strictEqual(r.verdict, 'wording');        // מאושרות: רק "000 שנה" (תיארוך)
	assert.strictEqual(r.verdict_suggested, 'problem');
	assert.ok(r.matches.some((m) => m.s === 'problem' && m.a === null));
});

test('scanPage: clean page', () => {
	const r = scanPage('ירושלים היא עיר עתיקה.', lists);
	assert.deepStrictEqual([r.verdict, r.verdict_suggested, r.matches.length], ['clean', 'clean', 0]);
});

test('imagesOf: template icons are not the article\'s images; lead and in-code files are', () => {
	const page = {
		images: [{ title: 'קובץ:Allmusic Favicon.png' }, { title: 'קובץ:Flag of Israel.svg' },
			{ title: 'קובץ:Tel_Aviv beach.jpg' }, { title: 'קובץ:Portrait.jpg' }],
		pageimage: 'Portrait.jpg',
	};
	const text = '{{מידע}}\n[[קובץ:Tel Aviv beach.jpg|ממוזער|החוף]]';
	const r = imagesOf(page, text);
	assert.deepStrictEqual(r.photos.sort(), ['Portrait.jpg', 'Tel_Aviv beach.jpg'].sort());
	assert.strictEqual(r.all.length, 4);
});

test('resultRow: shape of the row saved to Supabase', () => {
	const page = { pageid: 7, title: 'דף', lastrevid: 99, length: 10, images: [],
		revisions: [{ revid: 99, slots: { main: { content: 'טקסט נקי.' } } }] };
	const row = resultRow(page, lists, 'v1');
	assert.strictEqual(row.wikipedia_id, 7);
	assert.strictEqual(row.rev_id, 99);
	assert.strictEqual(row.has_images, false);
	assert.strictEqual(row.verdict, 'clean');
	assert.strictEqual(row.lists_version, 'v1');
});
