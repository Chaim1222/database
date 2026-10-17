# P31/P279/P106 לכל דף חסר, ישר מוויקינתונים לפי הכותרת בוויקיפדיה העברית (50 לבקשה). שמירה תוך כדי; ממשיך מאיפה שעצר.
import json, os, sys, time
sys.path.insert(0, '.')
from wapi import S
t0 = time.time()
titles = json.load(open('all_titles.json'))
done_f = 'titles_done.json'
done = set(json.load(open(done_f))) if os.path.exists(done_f) else set()
ents = json.load(open('wd.json'))
todo = [t for t in titles if t not in done]
for n, i in enumerate(range(0, len(todo), 50)):
    chunk = todo[i:i + 50]
    for a in range(15):
        r = S.post('https://www.wikidata.org/w/api.php', data={'action': 'wbgetentities', 'sites': 'hewiki', 'titles': '|'.join(chunk),
                                                              'props': 'claims', 'format': 'json'}, timeout=120)
        if r.status_code == 200 and r.text.startswith('{'): break
        time.sleep(int(r.headers.get('Retry-After', 5) or 5) + a)
    else:
        raise RuntimeError('wikidata failed at %d' % i)
    for k, e in r.json().get('entities', {}).items():
        c = e.get('claims')
        if c is None or not k.startswith('Q'): continue
        g = lambda p: [s['mainsnak']['datavalue']['value'].get('id') for s in c.get(p, []) if 'datavalue' in s['mainsnak']]
        ents[k] = {'P31': g('P31'), 'P106': g('P106'), 'P279': g('P279')}
    done.update(chunk)
    if n % 20 == 0:
        json.dump(ents, open('wd.json', 'w'), ensure_ascii=False); json.dump(sorted(done), open(done_f, 'w'), ensure_ascii=False)
        print(len(done), '/', len(titles), 'entities', len(ents), round(time.time() - t0), 's', flush=True)
json.dump(ents, open('wd.json', 'w'), ensure_ascii=False); json.dump(sorted(done), open(done_f, 'w'), ensure_ascii=False)
print('done', len(done), 'entities', len(ents), round(time.time() - t0), 's', flush=True)
