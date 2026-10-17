import time, requests, sys, json
UA = "MechalolWikipediaCompareBot/1.0 (https://www.hamichlol.org.il/; bot@hamichlol.org.il)"
S = requests.Session(); S.headers["User-Agent"] = UA
API = {"wiki": "https://he.wikipedia.org/w/api.php", "mech": "https://www.hamichlol.org.il/w/api.php"}
def q(site, **params):
    params = {"action": "query", "format": "json", "formatversion": "2", **params}
    for attempt in range(8):
        r = S.post(API[site], data=params, timeout=60)
        if r.status_code == 429 or not r.text.startswith("{"):
            time.sleep(int(r.headers.get("Retry-After", 10) or 10) + 2 * attempt); continue
        d = r.json()
        if "error" in d: raise RuntimeError(d["error"])
        return d
    raise RuntimeError("rate limited")
