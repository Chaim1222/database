// ניתוח צירופים (co-occurrence) - ראו analysis/cooccurrence.md. הרצה: node word-filter/analysis/cooccurrence.js
// דורש את המדגמים ב-.word-filter-corpus/ (שחזור מהענף word-filter-corpus).
'use strict';
const path = require('path');
const { engine, loadLists, loadCorpora } = require(path.join(__dirname, '..', 'tools', 'lib'));
const occ = require(path.join(__dirname, 'wiki-random-occurrences.json')).occurrences;
const pages = loadCorpora()['wiki-random'];
const lists = loadLists({ suggested: true });
// 1. לכל ערך: כמה "משפחות" שונות של מילות צניעות (לפי הטקסט שנתפס, מנורמל) מופיעות בו
const famCache = {};
function families(id) {
  if (famCache[id]) return famCache[id];
  const ms = engine.scan(pages[id].text, lists).filter((m) => m.topic === 'modesty');
  const fam = new Set(ms.map((m) => m.text.replace(/^[ובכלמשה]{1,2}(?=[א-ת]{3})/, '').slice(0, 4)));
  return (famCache[id] = { n: fam.size, hits: ms.length });
}
const buckets = {};
for (const o of occ) {
  if (o.label === 'unclear') continue;
  const { n } = families(o.ref.split(':')[0]);
  const b = n >= 6 ? '6+' : n >= 4 ? '4-5' : n >= 2 ? '2-3' : '1';
  buckets[b] = buckets[b] || { problem: 0, innocent: 0 };
  buckets[b][o.label]++;
}
console.log('משפחות מילים שונות בערך -> סיווג המופע');
for (const b of ['1', '2-3', '4-5', '6+']) { const x = buckets[b] || { problem: 0, innocent: 0 }; const t = x.problem + x.innocent; console.log(b.padEnd(4), 'בעייתי', x.problem, 'תמים', x.innocent, t ? Math.round(100 * x.problem / t) + '%' : ''); }
// 2. מילים בחלון ההקשר: log-odds בעייתי מול תמים
const tok = (s) => (s.replace(/【[^】]*】/g, ' ').match(/[א-ת][א-ת"']+[א-ת]|[a-z]{3,}/gi) || []).map((t) => t.replace(/^[ובכלמשה]{1,2}(?=[א-ת]{3})/, ''));
const cnt = { problem: {}, innocent: {} }, tot = { problem: 0, innocent: 0 };
for (const o of occ) { if (o.label === 'unclear') continue; for (const t of new Set(tok(o.context))) { cnt[o.label][t] = (cnt[o.label][t] || 0) + 1; } tot[o.label]++; }
const all = new Set([...Object.keys(cnt.problem), ...Object.keys(cnt.innocent)]);
const rows = [...all].map((t) => { const p = cnt.problem[t] || 0, i = cnt.innocent[t] || 0; return { t, p, i, lo: Math.log((p + 0.5) / (tot.problem + 1)) - Math.log((i + 0.5) / (tot.innocent + 1)) }; }).filter((r) => r.p + r.i >= 6);
rows.sort((a, b) => b.lo - a.lo);
console.log('\nמילים בהקשר שמעידות על הקשר בעייתי (בעייתי/תמים):');
console.log(rows.filter((r) => r.i <= 1).slice(0, 40).map((r) => `${r.t}(${r.p}/${r.i})`).join('  '));
console.log('\nמילים בהקשר שמעידות על הקשר תמים:');
console.log(rows.filter((r) => r.p <= 1).reverse().slice(0, 40).map((r) => `${r.t}(${r.p}/${r.i})`).join('  '));
