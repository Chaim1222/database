#!/usr/bin/env node
'use strict';
/*
 * בונה את word-filter/wikidata.json: מחלקה בוויקינתונים (QID) -> נושא, לסיווג הנושא ב-topics.js.
 *
 * הזרימה:
 *   1. OCCUPATION_ROOTS ו-CLASS_ROOTS (למטה) - טבלה קצרה של מחלקות-שורש ונושא לכל אחת. זו ההחלטה; כל השאר נגזר ממנה.
 *   2. הזרעים: ערכי "מופע של" (P31), "תת-מחלקה של" (P279, לערך שהוא עצמו סוג: כלי נגינה, מושג) ו"עיסוק" (P106)
 *      של הערכים שנסרקו (--seeds), ועוד מה שכבר במפה.
 *   3. לכל זרע עולים ב"תת-מחלקה של" (P279), לרוחב, עד עומק MAX_DEPTH. השורש הקרוב ביותר קובע; באותו מרחק -
 *      הראשון בטבלה. עיסוקים מגיעים רק לשורשי אנשים, ומחלקות רק לשורשי דברים: שרשרת ארוכה מ"מושל" מגיעה ל"ארגון".
 *      זרע שלא הגיע לשורש - לא נכנס (הסיווג נופל לקטגוריות, כמו קודם).
 *   4. נכתב: { built, max_depth, classes: {QID: [נושא, עומק]}, occupations: {QID: [נושא, עומק]} }.
 *      העומק קובע מתי ההכרעה נכנסת ב-topics.js: קרוב (0-1) - לפני הקטגוריות; רחוק - רק כשהקטגוריות לא הכריעו.
 *
 * הפעלה: node word-filter/tools/build-wikidata-map.js --seeds seeds.json [--cache cache.json] [--max-depth N]
 * הקריאה לוויקינתונים דרך apiGet (מכבד retry-after). --cache שומר את P279 שכבר נקראו, להרצה חוזרת.
 */
const fs = require('fs');
const path = require('path');
const { apiGet } = require('./lib');

const OUT = path.join(__dirname, '..', 'wikidata.json');
const MAX_DEPTH = 3;

// [QID, נושא, תווית - לקריאה בלבד]. סדר = עדיפות בשוויון מרחק. מחלקות כלליות מדי ("מושג", "ישות", "יצירה") לא נכנסות.
// עיסוקים (P106 של אדם) - רק לשורשי אנשים. הסדר: עיסוקים ספציפיים קודם, "אמן" הכללי בסוף.
const OCCUPATION_ROOTS = [
	['Q82955', 'people_politics', 'politician'], ['Q193391', 'people_politics', 'diplomat'], ['Q116', 'people_politics', 'monarch'],
	['Q2478141', 'people_politics', 'aristocrat'], ['Q372436', 'people_politics', 'statesperson'],
	['Q16533', 'people_law', 'judge'], ['Q185351', 'people_law', 'jurist'], ['Q40348', 'people_law', 'lawyer'],
	['Q189290', 'people_military', 'military officer'], ['Q47064', 'people_military', 'military personnel'],
	['Q1397808', 'people_military', 'resistance fighter'], ['Q384593', 'people_military', 'police officer'],
	['Q133485', 'people_rabbis', 'rabbi'], ['Q12350380', 'people_rabbis', 'kabbalist'], ['Q1067977', 'people_rabbis', 'hazzan'],
	['Q250867', 'people_clergy', 'Catholic priest'], ['Q42603', 'people_clergy', 'priest'], ['Q611644', 'people_clergy', 'Catholic bishop'],
	['Q29182', 'people_clergy', 'bishop'], ['Q219477', 'people_clergy', 'missionary'], ['Q1234713', 'people_clergy', 'theologian'],
	['Q733786', 'people_clergy', 'monk'], ['Q1423891', 'people_clergy', 'Christian minister'],
	['Q2066131', 'people_sport', 'athlete'], ['Q13474373', 'people_sport', 'professional wrestler'], ['Q9149093', 'people_sport', 'mountaineer'],
	['Q41583', 'people_sport', 'coach'], ['Q10833314', 'people_sport', 'tennis player'], ['Q10873124', 'people_sport', 'chess player'],
	['Q639669', 'people_music', 'musician'], ['Q177220', 'people_music', 'singer'], ['Q36834', 'people_music', 'composer'],
	['Q753110', 'people_music', 'songwriter'], ['Q158852', 'people_music', 'conductor'], ['Q183945', 'people_music', 'record producer'],
	['Q822146', 'people_music', 'lyricist'],
	['Q33999', 'people_stage', 'actor'], ['Q2526255', 'people_stage', 'film director'], ['Q28389', 'people_stage', 'screenwriter'],
	['Q3282637', 'people_stage', 'film producer'], ['Q4610556', 'people_stage', 'model'], ['Q5716684', 'people_stage', 'dancer'],
	['Q947873', 'people_stage', 'television presenter'], ['Q245068', 'people_stage', 'comedian'], ['Q222344', 'people_stage', 'cinematographer'],
	['Q3387717', 'people_stage', 'theatre director'], ['Q578109', 'people_stage', 'television producer'], ['Q2059704', 'people_stage', 'television director'],
	['Q17125263', 'people_stage', 'YouTuber'], ['Q2906862', 'people_stage', 'influencer'], ['Q211236', 'people_stage', 'celebrity'],
	['Q337084', 'people_stage', 'drag queen'], ['Q7042855', 'people_stage', 'film editor'],
	['Q36180', 'people_literature', 'writer'], ['Q1930187', 'people_literature', 'journalist'], ['Q333634', 'people_literature', 'translator'],
	['Q1607826', 'people_literature', 'editor'], ['Q2516866', 'people_literature', 'publisher'], ['Q4263842', 'people_literature', 'literary critic'],
	['Q6625963', 'people_literature', 'novelist'], ['Q49757', 'people_literature', 'poet'], ['Q482980', 'people_literature', 'author'],
	['Q1028181', 'people_art', 'painter'], ['Q1281618', 'people_art', 'sculptor'], ['Q42973', 'people_art', 'architect'],
	['Q33231', 'people_art', 'photographer'], ['Q644687', 'people_art', 'illustrator'], ['Q1925963', 'people_art', 'graphic artist'],
	['Q3391743', 'people_art', 'visual artist'], ['Q5322166', 'people_art', 'designer'], ['Q674426', 'people_art', 'curator'],
	['Q10732476', 'people_art', 'art collector'], ['Q715301', 'people_art', 'comics artist'], ['Q483501', 'people_art', 'artist'],
	['Q901', 'people_science', 'scientist'], ['Q1622272', 'people_science', 'university teacher'], ['Q121594', 'people_science', 'professor'],
	['Q1650915', 'people_science', 'researcher'], ['Q201788', 'people_science', 'historian'], ['Q81096', 'people_science', 'engineer'],
	['Q39631', 'people_science', 'physician'], ['Q4964182', 'people_science', 'philosopher'], ['Q3400985', 'people_science', 'academic'],
	['Q205375', 'people_science', 'inventor'], ['Q11631', 'people_science', 'astronaut'], ['Q1569495', 'people_science', 'lecturer'],
	['Q11900058', 'people_science', 'explorer'], ['Q14972848', 'people_science', 'lexicographer'], ['Q2468727', 'people_science', 'classical scholar'],
	['Q43845', 'people_business', 'businessperson'], ['Q131524', 'people_business', 'entrepreneur'], ['Q2961975', 'people_business', 'business executive'],
	['Q1979607', 'people_business', 'financier'], ['Q215536', 'people_business', 'merchant'], ['Q13235160', 'people_business', 'manufacturer'],
	['Q806798', 'people_business', 'banker'],
	['Q15253558', 'people_public', 'activist'], ['Q37226', 'people_public', 'teacher'], ['Q1231865', 'people_public', 'pedagogue'],
	['Q212238', 'people_public', 'civil servant'],
	['Q2159907', 'people_crime', 'criminal'], ['Q484188', 'people_crime', 'serial killer'], ['Q931260', 'people_crime', 'murderer'],
];
// "מופע של" (P31) של ערך שאינו אדם. להקה - כמו קודם, "אישים: מוזיקה".
const CLASS_ROOTS = [
	['Q215380', 'people_music', 'musical group'],
	['Q13406463', 'lists', 'Wikimedia list article'], ['Q18340514', 'years', 'events in a specific year or time period'],
	['Q4167410', 'disambig', 'Wikimedia disambiguation page'],
	['Q105543609', 'music', 'musical work/composition'], ['Q482994', 'music', 'album'], ['Q134556', 'music', 'single'], ['Q7366', 'music', 'song'],
	['Q188451', 'music', 'music genre'], ['Q1573906', 'music', 'concert tour'], ['Q182832', 'music', 'concert'], ['Q373899', 'music', 'record chart'],
	['Q34379', 'music', 'musical instrument'], ['Q1344', 'music', 'opera'], ['Q2088357', 'music', 'musical ensemble'], ['Q42998', 'music', 'orchestra'],
	['Q11424', 'film_tv', 'film'], ['Q5398426', 'film_tv', 'television series'], ['Q15416', 'film_tv', 'television program'],
	['Q21191270', 'film_tv', 'television series episode'], ['Q15773347', 'film_tv', 'film character'], ['Q15773317', 'film_tv', 'television character'],
	['Q1107', 'film_tv', 'anime'], ['Q21198342', 'film_tv', 'manga series'], ['Q196600', 'film_tv', 'media franchise'], ['Q1616075', 'film_tv', 'television station'],
	['Q7889', 'games', 'video game'], ['Q1569167', 'games', 'video game character'], ['Q131436', 'games', 'board game'], ['Q11410', 'games', 'game'],
	['Q47883', 'games', 'playing card'], ['Q1643932', 'games', 'tabletop role-playing game'],
	['Q7725634', 'literature', 'literary work'], ['Q47461344', 'literature', 'written work'], ['Q571', 'literature', 'book'],
	['Q3658341', 'literature', 'literary character'], ['Q1631107', 'literature', 'bibliography'], ['Q5185279', 'literature', 'poem'],
	['Q1004', 'literature', 'comic'], ['Q13442814', 'literature', 'scholarly article'],
	['Q3305213', 'art', 'painting'], ['Q860861', 'art', 'sculpture'], ['Q179700', 'art', 'statue'], ['Q838948', 'art', 'work of art'],
	['Q125191', 'art', 'photograph'], ['Q15727816', 'art', 'painting series'], ['Q968159', 'art', 'art movement'], ['Q4989906', 'buildings', 'monument'],
	['Q4504495', 'culture', 'award ceremony'], ['Q618779', 'culture', 'award'], ['Q38033430', 'culture', 'class of award'],
	['Q2198855', 'culture', 'cultural movement'], ['Q25379', 'culture', 'play'], ['Q2743', 'culture', 'musical play'], ['Q132241', 'culture', 'festival'],
	['Q58483083', 'culture', 'dramatico-musical work'], ['Q43099500', 'culture', 'performing arts production'], ['Q2927074', 'culture', 'internet meme'],
	['Q464980', 'culture', 'exhibition'],
	['Q15229207', 'sport', 'sports award'], ['Q27020041', 'sport', 'sports season'], ['Q114609228', 'sport', 'recurring sporting event edition'],
	['Q13406554', 'sport', 'sports competition'], ['Q18608583', 'sport', 'recurring sporting event'], ['Q16510064', 'sport', 'sporting event'],
	['Q476028', 'sport', 'association football club'], ['Q15991303', 'sport', 'association football league'], ['Q847017', 'sport', 'sports club'],
	['Q12973014', 'sport', 'sports team'], ['Q349', 'sport', 'sport'], ['Q31629', 'sport', 'type of sport'], ['Q26132862', 'sport', 'Olympic sports discipline event'],
	['Q623109', 'sport', 'sports league'], ['Q1079023', 'sport', 'championship'],
	['Q486972', 'geo', 'human settlement'], ['Q56061', 'geo', 'administrative territorial entity'], ['Q8502', 'geo', 'mountain'],
	['Q4022', 'geo', 'river'], ['Q23442', 'geo', 'island'], ['Q82794', 'geo', 'region'], ['Q35509', 'geo', 'cave'], ['Q34763', 'geo', 'peninsula'],
	['Q271669', 'geo', 'landform'], ['Q15324', 'geo', 'body of water'], ['Q79007', 'geo', 'street'], ['Q6256', 'geo', 'country'],
	['Q46831', 'geo', 'mountain range'], ['Q207326', 'geo', 'summit'], ['Q22698', 'geo', 'park'], ['Q473972', 'geo', 'protected area'],
	['Q839954', 'buildings', 'archaeological site'], ['Q41176', 'buildings', 'building'], ['Q811979', 'buildings', 'built structure'],
	['Q33506', 'buildings', 'museum'], ['Q12280', 'buildings', 'bridge'], ['Q16970', 'buildings', 'church building'], ['Q34627', 'buildings', 'synagogue'],
	['Q32815', 'buildings', 'mosque'], ['Q39614', 'buildings', 'cemetery'], ['Q11707', 'buildings', 'restaurant'], ['Q57821', 'buildings', 'fortification'],
	['Q2319498', 'buildings', 'architectural landmark'], ['Q13226383', 'buildings', 'facility'], ['Q19860854', 'buildings', 'destroyed building or structure'],
	['Q44539', 'buildings', 'temple'], ['Q44613', 'buildings', 'monastery'], ['Q7075', 'buildings', 'library'],
	['Q43229', 'orgs', 'organization'], ['Q4830453', 'orgs', 'business'], ['Q783794', 'orgs', 'company'], ['Q163740', 'orgs', 'nonprofit organization'],
	['Q327333', 'orgs', 'government agency'], ['Q3918', 'orgs', 'university'], ['Q11032', 'orgs', 'newspaper'], ['Q17232649', 'orgs', 'news website'],
	['Q1002697', 'orgs', 'periodical'], ['Q41298', 'orgs', 'magazine'], ['Q431289', 'orgs', 'brand'], ['Q3914', 'orgs', 'school'],
	['Q178561', 'history', 'battle'], ['Q198', 'history', 'war'], ['Q17524420', 'history', 'aspect of history'], ['Q176799', 'history', 'military unit'],
	['Q2583015', 'history', 'ghetto in Nazi-occupied Europe'], ['Q15661340', 'history', 'ancient city'], ['Q148837', 'history', 'polis'], ['Q220659', 'history', 'archaeological artefact'],
	['Q132821', 'history', 'murder'], ['Q645883', 'history', 'military operation'], ['Q3024240', 'history', 'historical country'],
	['Q8473', 'history', 'military'], ['Q1261499', 'history', 'naval battle'], ['Q124734', 'history', 'rebellion'], ['Q2223653', 'history', 'terrorist attack'],
	['Q16521', 'nature', 'taxon'], ['Q23038290', 'nature', 'fossil taxon'], ['Q113145171', 'nature', 'type of chemical entity'], ['Q11173', 'nature', 'chemical compound'],
	['Q24034552', 'nature', 'mathematical concept'], ['Q1049494', 'nature', 'eponymous chemical reaction'], ['Q11344', 'nature', 'chemical element'],
	['Q6999', 'nature', 'astronomical object'], ['Q17444909', 'nature', 'astronomical object type'], ['Q7187', 'nature', 'gene'], ['Q8054', 'nature', 'protein'],
	['Q38829', 'nature', 'breed'], ['Q2995644', 'nature', 'result'], ['Q65943', 'nature', 'theorem'], ['Q12136', 'medicine', 'disease'],
	['Q112193867', 'medicine', 'type of disease'], ['Q12140', 'medicine', 'medication'], ['Q169872', 'medicine', 'symptom'],
	['Q796194', 'medicine', 'medical procedure'], ['Q112826905', 'medicine', 'class of anatomical entity'], ['Q4936952', 'medicine', 'anatomical structure'],
	['Q18487055', 'tech', 'missile model'], ['Q15056995', 'tech', 'aircraft model'], ['Q7397', 'tech', 'software'], ['Q11019', 'tech', 'machine'],
	['Q1183543', 'tech', 'device'], ['Q29048322', 'tech', 'vehicle model'], ['Q11446', 'tech', 'ship'], ['Q728', 'tech', 'weapon'],
	['Q39546', 'tech', 'physical tool'], ['Q11016', 'tech', 'technology'], ['Q15142889', 'tech', 'weapon family'], ['Q42889', 'tech', 'vehicle'],
	['Q22988604', 'religion', 'mythological Greek character'], ['Q9174', 'religion', 'religion'], ['Q1777205', 'religion', 'Jewish prayer'],
	['Q178885', 'religion', 'deity'], ['Q24334685', 'religion', 'mythical entity'], ['Q28061975', 'religion', 'group of Greek mythical characters'],
	['Q1530022', 'religion', 'religious organization'], ['Q375011', 'religion', 'religious holiday'], ['Q4271324', 'religion', 'mythical character'], ['Q2239243', 'religion', 'mythical creature'],
	['Q12909644', 'politics', 'political ideology'], ['Q9357091', 'politics', 'political theory'], ['Q820655', 'politics', 'statute'],
	['Q131569', 'politics', 'treaty'], ['Q7748', 'politics', 'law'], ['Q7210356', 'orgs', 'political organization'], ['Q7278', 'orgs', 'political party'],
	['Q2061202', 'politics', 'international sanction'], ['Q175331', 'politics', 'demonstration'], ['Q49773', 'politics', 'social movement'],
	['Q41710', 'society', 'ethnic group'], ['Q101352', 'society', 'family name'], ['Q42298422', 'society', 'slang term'], ['Q746549', 'society', 'dish'],
	['Q2095', 'society', 'food'], ['Q1445650', 'society', 'holiday'], ['Q11862829', 'society', 'academic discipline'], ['Q12737077', 'society', 'occupation'],
];

function arg(name) {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : null;
}

// גרף "תת-מחלקה של" (P279) מהזרעים ומעלה עד maxDepth, רמה אחרי רמה, 50 בכל קריאה. cache: QID -> [הורים] (null = ישות חסרה).
async function fetchGraph(seeds, cache, maxDepth) {
	let level = [...new Set(seeds)];
	for (let depth = 0; depth < maxDepth && level.length; depth++) {
		const todo = level.filter((q) => !(q in cache));
		for (let i = 0; i < todo.length; i += 50) {
			const chunk = todo.slice(i, i + 50);
			const data = await apiGet('wikidata', { action: 'wbgetentities', ids: chunk.join('|'), props: 'claims' });
			for (const q of chunk) {
				const e = data.entities && data.entities[q];
				cache[q] = e && e.claims ? (e.claims.P279 || []).map((st) => st.mainsnak.datavalue && st.mainsnak.datavalue.value.id).filter(Boolean) : null;
			}
		}
		level = [...new Set(level.flatMap((q) => cache[q] || []))];
		console.error(`עומק ${depth + 1}: ${Object.keys(cache).length} מחלקות בגרף`);
	}
}

// השורש הקרוב ביותר לכל זרע (חיפוש לרוחב בגרף שבזיכרון). בשוויון מרחק - הראשון ברשימת השורשים. -> {QID: [נושא, עומק]}
function resolve(seeds, roots, cache, maxDepth) {
	const rank = new Map(roots.map(([q], i) => [q, i]));
	const out = {};
	for (const seed of seeds) {
		let level = [seed]; const seen = new Set(level);
		for (let depth = 0; depth <= maxDepth && level.length; depth++) {
			const hit = level.filter((q) => rank.has(q)).sort((a, b) => rank.get(a) - rank.get(b))[0];
			if (hit) { out[seed] = [roots[rank.get(hit)][1], depth]; break; }
			level = level.flatMap((q) => cache[q] || []).filter((q) => !seen.has(q) && seen.add(q));
		}
	}
	return out;
}

async function main() {
	const seedsFile = arg('--seeds'), cacheFile = arg('--cache');
	const maxDepth = Number(arg('--max-depth') || MAX_DEPTH);
	if (!seedsFile) throw new Error('צריך --seeds <קובץ JSON: {"P31": [QID...], "P279": [QID...], "P106": [QID...]}>');
	const seeds = JSON.parse(fs.readFileSync(seedsFile, 'utf8'));
	const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
	// "אדם" (Q5) לא נכנס למפת המחלקות: אדם מסווג לפי עיסוק (וב"תת-מחלקה של" הוא מגיע לאנטומיה)
	const classSeeds = [...new Set([...seeds.P31, ...(seeds.P279 || []), ...Object.keys(old.classes || {}), ...CLASS_ROOTS.map(([q]) => q)])].filter((q) => q !== 'Q5');
	const occSeeds = [...new Set([...seeds.P106, ...Object.keys(old.occupations || {}), ...OCCUPATION_ROOTS.map(([q]) => q)])];
	const cache = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
	try {
		await fetchGraph([...classSeeds, ...occSeeds], cache, maxDepth);
	} finally {
		if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache));
	}
	const sorted = (m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))));
	const classes = resolve(classSeeds, CLASS_ROOTS, cache, maxDepth), occupations = resolve(occSeeds, OCCUPATION_ROOTS, cache, maxDepth);
	fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10), max_depth: maxDepth,
		classes: sorted(classes), occupations: sorted(occupations) }) + '\n');
	console.error(`נכתב ${OUT}: ${Object.keys(classes).length}/${classSeeds.length} מחלקות, ${Object.keys(occupations).length}/${occSeeds.length} עיסוקים`);
}

if (require.main === module) main().catch((e) => { console.error('שגיאה: ' + (e.stack || e.message)); process.exitCode = 1; });

module.exports = { OCCUPATION_ROOTS, CLASS_ROOTS, resolve };
