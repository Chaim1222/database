'use strict';
/*
 * משותף לכלי שורת הפקודה: טעינת הרשימות, קריאה ל-API של ויקי, ומאגרי
 * הבדיקה (corpora) המקומיים.
 */
const fs = require('fs');
const path = require('path');
const engine = require('../Gadget-wikitextWordCheck.js');

const ROOT = path.join(__dirname, '..');
const LISTS_DIR = path.join(ROOT, 'lists');
const CORPUS_DIR = path.join(ROOT, '..', '.word-filter-corpus');

const APIS = {
	wikipedia: 'https://he.wikipedia.org/w/api.php',
	mechalol: 'https://www.hamichlol.org.il/w/api.php',
};
const USER_AGENT = 'MechalolWikipediaCompareBot/1.0 (https://www.hamichlol.org.il/; bot@hamichlol.org.il)';

function readJson(name) {
	return JSON.parse(fs.readFileSync(path.join(LISTS_DIR, name), 'utf8'));
}

// options.suggested - לכלול הצעות שלא אושרו; options.words/allow - רשימות חלופיות.
function loadLists(options = {}) {
	return engine.compileLists(options.words || readJson('words.json'), options.allow || readJson('allow.json'), options);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(wiki, params) {
	const url = APIS[wiki] + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
	for (let attempt = 0; attempt < 8; attempt++) {
		const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (response.ok) return response.json();
		const wait = Math.min(Number(response.headers.get('retry-after')) || 10 * (attempt + 1), 90);
		console.error(`HTTP ${response.status} - ממתין ${wait} שניות`);
		await sleep(wait * 1000);
	}
	throw new Error('יותר מדי כישלונות ברצף');
}

const contentOf = (page) => (page.revisions ? page.revisions[0].slots.main.content : null);
const isRedirect = (text) => /^\s*#(הפניה|redirect)/i.test(text);

async function fetchPage(wiki, title) {
	const data = await apiGet(wiki, { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title });
	const page = data.query.pages[0];
	if (page.missing) throw new Error(`הדף "${title}" לא קיים`);
	return contentOf(page);
}

// {name: {id: {title, text}}} - כל קובצי ה-JSON שבתיקיית המאגרים, בלי הפניות.
function loadCorpora() {
	if (!fs.existsSync(CORPUS_DIR)) return {};
	const corpora = {};
	for (const file of fs.readdirSync(CORPUS_DIR).sort()) {
		if (!file.endsWith('.json')) continue;
		const data = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8'));
		corpora[file.slice(0, -5)] = Object.fromEntries(
			Object.entries(data).filter(([, v]) => v.text && !isRedirect(v.text)));
	}
	return corpora;
}

module.exports = { engine, ROOT, LISTS_DIR, CORPUS_DIR, readJson, loadLists, apiGet, contentOf, isRedirect, fetchPage,
	loadCorpora, sleep };
