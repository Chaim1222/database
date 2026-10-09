// Integration and visual checks. No live requests: all network access is intercepted.
// Requires playwright; CHROMIUM_EXECUTABLE can select an installed Chromium binary.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../gadget-searchHelperDashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../gadget-searchHelperDashboard.css'), 'utf8');

function fixture({ backend, admin = true, failure = '', expired = false }) {
 backend = new URL(location.href).searchParams.get('mchlDb') || backend;
 window.testState = { requests: [], imports: [], alerts: [], failures: [], feedback: {}, admin, failure, expired };
 window.mw = {
  config: { get: key => ({ wgCanonicalSpecialPageName: 'Blankpage', wgPageName: 'מיוחד:דף_ריק/database', wgUserGroups: ['sysop'], wgScriptPath: '/w', wgUserLanguage: 'he', skin: 'vector' })[key] },
  util: { wikiScript: name => '/w/' + name + '.php', getUrl: title => '/wiki/' + title }, hook: () => ({ add: fn => window.startDashboard = fn }),
  loader: { using: () => Promise.resolve() }, notify: text => testState.alerts.push(text),
  import: class { importWikitext(opts) { testState.imports.push(opts); return Promise.resolve(); } }
 };
 window.$ = () => ({ html: () => {} }); window.alert = text => testState.alerts.push(text); window.confirm = () => true;
 const now = '2026-10-08T12:00:00Z';
 const rows = [
  { id: 1, title: 'ערך לבדיקה', verdict: 'clean', ctx_verdict: 'clean', scan_state: 'scanned', has_images: true, photo_count: 1, matches_total: 1, counts: { a: { problem: 1 } }, created_at: '2020-01-01', mechalol_redirect_exists: false, wikidata_desc: 'תיאור לדוגמה' },
  { id: 2, title: 'ערך ישן', verdict: 'clean', ctx_verdict: 'clean', scan_state: 'stale', has_images: null, mechalol_redirect_exists: null },
  { id: 3, title: 'ערך ללא סריקה', scan_state: 'not_scanned', has_images: null, mechalol_redirect_exists: null }
 ];
 const tables = {
  report_missing_word_filter: rows, report_missing_from_mechalol: rows,
  mechalol_pages: [{ id: 10, title: 'ערך במכלול', wikipedia_id: 1 }], wikipedia_pages: [{ id: 1, title: 'ערך לבדיקה' }],
  report_rev_tasks: [{ id: 10, title: 'משימת גרסה', status: 'מתועד', rev_task: 'bad_rev', wikipedia_id: 1, sort_template_rev: 101, linked_title: 'ערך לבדיקה' }],
  report_wikipedia_moves: [{ id: 10, title: 'כותרת במכלול', old_title: 'שם קודם', wikipedia_title: 'שם חדש', renamed_at: now, via: 'title' }],
  report_undocumented_import: [{ id: 11, title: 'ללא תבנית', source_type: 'missing_sort' }],
  report_rav_prefix_normalization: [{ wikipedia_id: 1, mechalol_id: 10, wikipedia_title: 'הרב לדוגמה', mechalol_title: 'לדוגמה', candidate_count: 1 }],
  report_locked_pages: backend === 'v2' ? [
   { id: 1, site: 'wikipedia', title: 'ערך לבדיקה', wikipedia_id: 1, mechalol_id: null, lock_level: 'נעול לקריאה', lock_source: 'test', detected_at: now },
   { id: 1, site: 'mechalol', title: 'ערך במכלול', wikipedia_id: null, mechalol_id: 1, lock_level: 'נעול לקריאה', lock_source: 'test', detected_at: now },
   { id: 0, site: 'mechalol', title: 'כותרת נעולה', lock_level: 'נעול ליצירה', lock_source: 'exclusion', detected_at: now }
  ] : [{ id: 10, title: 'ערך במכלול', mechalol_id: 10, lock_level: 'נעול לקריאה', lock_source: 'test', detected_at: now }],
  v_template_issues: [{ id: 10, title: 'בעיית תבנית', outcome: 'unresolved', checked_at: now }],
  v_sync_status: [{ kind: 'sync', health: 'ok', status: 'success', last_success_at: now, error: null }],
  sync_watermarks: [{ last_synced_ts: now }], v_counts: [{ key: 'wiki_pages', n: 100 }, { key: 'mech_pages', n: 90 }]
 };
 const columns = {
  report_missing_word_filter: ['id','title','checked_at','wikidata_desc','easy_import_length','created_at','mechalol_redirect_exists','verdict','verdict_suggested','ctx_verdict','ctx_verdict_suggested','ctx_suspicion','ctx_suspicion_suggested','scan_state','has_images','photo_count','matches_total','counts','dictionary','topic','hidden_count','names_count'],
  report_missing_from_mechalol: ['id','title','mechalol_redirect_exists'],
  report_missing_word_filter_summary: ['n','redirect','has_images','verdict','verdict_suggested','ctx_verdict','ctx_verdict_suggested','ctx_suspicion','ctx_suspicion_suggested','dictionary','topic','scan_state'],
  report_rev_tasks: ['id','title','rev_task','wikipedia_id'], report_locked_pages: ['id','title','lock_level','wikipedia_id','mechalol_id','site'],
  v_template_issues: ['id','title','outcome'], v_sync_status: ['kind','last_success_at']
 };
 function response(data, status = 200, count) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...(count == null ? {} : { 'Content-Range': '0-' + Math.max(0,count-1) + '/' + count }) } }); }
 function passes(row, key, value) {
  if(value.startsWith('eq.')) return String(row[key]) === value.slice(3);
  if(value==='is.true') return row[key]===true;
  if(value==='not.is.true') return row[key]!==true;
  if(value==='is.null') return row[key]==null;
  if(value==='not.is.null') return row[key]!=null;
  if(value.startsWith('ilike.')) return String(row[key]||'').includes(value.slice(6).replace(/[%*]/g,''));
  if(value.startsWith('not.in.')) return !value.includes('"'+row[key]+'"');
  return true;
 }
 window.fetch = async (url, opts = {}) => {
  const u = new URL(url, location.href), table = u.pathname.split('/').pop(), t = testState;
  t.requests.push({ url: u.href, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
  if (!u.pathname.includes('/rest/v1/')) {
   if (u.pathname.includes('/auth/v1/')) return response({ access_token: 'fresh-'+backend, refresh_token: 'refresh-'+backend });
   if (u.hostname.includes('wikidata')) return response({entities:{}});
   if(u.searchParams.get('prop')==='revisions')return response({query:{pages:[{revisions:[{slots:{main:{content:'== [[ערך לבדיקה]] ==\nבקשת ייבוא [[משתמש:בודק]] 12:00, 8 באוקטובר 2026'}}}]}]}});
   if(u.searchParams.get('generator')==='categorymembers')return response({query:{pages:[{title:'קטגוריה:דפים לטיפול תרבות/דוגמה',categoryinfo:{pages:1}}]}});
   if(u.searchParams.get('list')==='categorymembers')return response({query:{categorymembers:[{pageid:20,title:'ערך תרבות'}]}});
   if(u.searchParams.get('formatversion')==='2')return response({query:{pages:[{pageid:1,title:'ערך לבדיקה',...(u.hostname==='dashboard.test'?{missing:true}:{})}]}});
   return response({query:{pages:{}}});
  }
  if (t.expired && u.pathname.includes('/rpc/')) { t.expired=false; return response({message:'expired'},401); }
  if (table==='is_admin'||table==='is_manual_match_admin') return response(t.admin);
  if (table==='word_filter_feedback' && opts.method!=='POST' && opts.method!=='DELETE') {
   if(backend==='v1' && u.searchParams.get('user_id')!=='eq.user-v1') t.failures.push('feedback not scoped to user');
   if(t.failure==='feedback')return response({message:'feedback unavailable'},403);
   return response(Object.entries(t.feedback).map(([match_key,label])=>({match_key,label})),200);
  }
  if(table==='word_filter_results') {
   if(t.failure==='details')return response({message:'detail unavailable'},403);
   return response([{wikipedia_id:1,lists_version:'v',images:[],matches_total:1,matches:[{x:'מילה',e:['entry'],line:1,b:'לפני ',f:' אחרי',a:'problem',s:'problem',ca:'problem'}]}]);
  }
  if(opts.method==='POST'||opts.method==='DELETE') {
   if(t.failure==='write')return response({message:'denied'},403);
   const d=JSON.parse(opts.body||'{}');
   if(table==='mark_feedback'||(table==='word_filter_feedback'&&opts.method==='POST'))t.feedback[d.p_match_key||d.match_key]=d.p_label||d.label;
   if(table==='unmark_feedback')delete t.feedback[d.p_match_key];
   if(table==='word_filter_feedback'&&opts.method==='DELETE')delete t.feedback[u.searchParams.get('match_key').slice(3)];
   return response(null);
  }
  if(backend==='v1' && /^v_/.test(table)){t.failures.push('V2 view on V1: '+table);return response({message:'wrong backend'},404);}
  let data = table==='report_missing_word_filter_summary' ? rows.map(r=>({...r,n:1,redirect:false,dictionary:false})) : tables[table];
  if(!data){t.failures.push('Unknown view: '+table);return response({message:'unknown view'},404);}
  const known=columns[table]||Object.keys(data[0]||{});
  for(const col of (u.searchParams.get('order')||'').split(',').filter(Boolean).map(p=>p.split('.')[0])){
   if(!known.includes(col)){t.failures.push(table+': unknown order '+col);return response({message:'invalid column'},400);}
  }
  for(const [key,value] of u.searchParams)if(!['select','order','limit','or'].includes(key))data=data.filter(r=>passes(r,key,value));
  return response(data,200,data.length);
 };
 sessionStorage.setItem('mchl-auth-session',JSON.stringify({access_token:'token-v1',refresh_token:'refresh-v1',user_id:'user-v1'}));
 sessionStorage.setItem('mchl-auth-session:ukzijtrpchvmoxlslxpz',JSON.stringify({access_token:'token-v2',refresh_token:'refresh-v2',user_id:'user-v2'}));
}

(async () => {
 const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
 async function open(backend, options = {}) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/dashboard.js')return route.fulfill({contentType:'application/javascript',body:source});
   if(u.searchParams.get('ctype')==='text/css')return route.fulfill({contentType:'text/css',body:css});
   return route.fulfill({contentType:'text/html',body:'<!doctype html><html dir="rtl"><meta charset="utf-8"><body><div id="mw-content-text"></div><script src="/dashboard.js"></script><script>startDashboard();</script></body></html>'});
  });
  await page.addInitScript(fixture,{backend,...options});await page.goto('https://dashboard.test/?mchlDb='+backend);
  await page.waitForSelector('#mchl-table-target tbody');return page;
 }
 async function clickTab(page,key){await page.locator('#mchl-tab-'+key).evaluate(el=>el.click());await page.waitForFunction(()=>!document.querySelector('#mchl-table-target .mchl-skeleton'));}
 for(const backend of ['v1','v2']){
  const page=await open(backend);assert.equal(await page.locator('#mchl-db-select').inputValue(),backend);
  await page.locator('[data-action="import"]').first().click();await page.waitForFunction(()=>testState.imports.length===1);
  assert.equal(await page.evaluate(()=>testState.imports[0].form),true);
  await page.locator('[data-action="wf-details"]').first().click();await page.waitForSelector('[data-action="wf-feedback"]');
  const feedback=page.locator('[data-action="wf-feedback"][data-label="false"]');await feedback.click();await page.waitForFunction(()=>Object.keys(testState.feedback).length===1);await feedback.click();await page.waitForFunction(()=>Object.keys(testState.feedback).length===0);
  await clickTab(page,'requests');await page.waitForSelector('.mchl-req-row');assert((await page.locator('#mchl-table-target').innerText()).includes('ערך לבדיקה'));
  await page.locator('[data-action="import"]').first().click();await page.waitForFunction(()=>testState.imports.length===2);
  await clickTab(page,'culture');await page.waitForSelector('[data-action="select-culture-subcat"]');await page.locator('[data-action="select-culture-subcat"]').click();await page.waitForFunction(()=>document.querySelector('#mchl-table-target').textContent.includes('ערך תרבות'));
  await page.locator('#mchl-tabgroup-maint').click();await page.waitForTimeout(30);
  assert(await page.locator('#mchl-tab-'+(backend==='v1'?'moved':'system')).evaluate(el=>el.classList.contains('mchl-active')));
  for(const key of ['moved','redirect','badrev','deletedrev','undoc','locked','rav',...(backend==='v2'?['system','template']:[])]){
   await clickTab(page,key);await page.waitForTimeout(30);
   const exported=page.waitForEvent('download',{timeout:3000});await page.locator('[data-action="export"][data-kind="json"]').evaluate(el=>el.click());
   if(key==='redirect'||key==='deletedrev') { await exported.catch(()=>null); }
   else { const d=await exported;assert(d.suggestedFilename().endsWith('.json'));
    const content=JSON.parse(fs.readFileSync(await d.path(),'utf8'));
    if(key==='system')assert.equal(content[0].kind,'sync');
    if(key==='locked'&&backend==='v2'){assert.equal(content.length,3);assert.deepEqual(content.slice(0,2).map(r=>r.site),['wikipedia','mechalol']);}
   }
  }
  await page.locator('#mchl-tabgroup-maint').click();await page.waitForTimeout(30);
  await clickTab(page,'stats');await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(()=>testState.failures),[]);assert.deepEqual(page.errors,[]);
  const requests=await page.evaluate(()=>testState.requests.filter(r=>r.url.includes('/rest/v1/')));
  requests.forEach(r=>{assert(r.url.includes(backend==='v2'?'ukzijtrpchvmoxlslxpz':'hgsyzaghedqsypisbvev'));assert.equal(r.headers['Accept-Profile'],backend==='v2'?'api':'public');assert(!r.headers.Authorization.includes('token-'+(backend==='v2'?'v1':'v2')));});
  await clickTab(page,'missing');await page.waitForTimeout(30);
  const input=page.locator('.mchl-manual-match-input').first();await input.fill('ערך');await page.waitForSelector('[data-action="pick-manual-match-suggestion"]');
  await page.locator('[data-action="pick-manual-match-suggestion"]').first().click();await page.locator('[data-action="assign-manual-match"]').first().click();
  await page.waitForFunction(b=>testState.requests.some(r=>r.method==='POST'&&r.url.endsWith(b==='v2'?'/rpc/set_manual_link':'/manual_matches')),backend);
  if(backend==='v2'){
   await page.locator('[data-action="exclude"]').first().click();await page.waitForFunction(()=>testState.requests.some(r=>r.url.endsWith('/rpc/add_exclusion')));
   for(const [choice,state] of [['clean','scanned'],['stale','stale'],['unscanned','not_scanned']]){
    await page.locator('[data-side="level"][data-v="'+choice+'"]').click();await page.waitForTimeout(30);
    const req=await page.evaluate(()=>testState.requests.filter(r=>r.url.includes('/report_missing_word_filter?')).at(-1));assert.equal(new URL(req.url).searchParams.get('scan_state'),'eq.'+state);assert.equal(await page.locator('#mchl-table-target tbody tr').count(),1);
   }
  }
  if(process.env.DASHBOARD_SCREENSHOTS){await page.screenshot({path:path.join(process.env.DASHBOARD_SCREENSHOTS,backend+'-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(process.env.DASHBOARD_SCREENSHOTS,backend+'-mobile.png'),fullPage:true});}
  assert.deepEqual(await page.evaluate(()=>testState.failures),[]);assert.deepEqual(page.errors,[]);
  const other=backend==='v1'?'v2':'v1';
  await page.locator('#mchl-db-select').selectOption(other);await page.waitForURL('**mchlDb='+other);await page.waitForSelector('#mchl-table-target tbody');
  assert.equal(await page.locator('#mchl-db-select').inputValue(),other);
  const afterSwitch=await page.evaluate(()=>testState.requests.filter(r=>r.url.includes('/rest/v1/')));
  assert(afterSwitch.length);afterSwitch.forEach(r=>{assert(r.url.includes(other==='v2'?'ukzijtrpchvmoxlslxpz':'hgsyzaghedqsypisbvev'));assert(!r.headers.Authorization.includes('token-'+backend));});
  await page.close();console.log('PASS browser workflows and backend switch '+backend);
  const denied=await open(backend,{admin:false});assert.equal(await denied.locator('[data-action="assign-manual-match"]').count(),0);assert.equal(await denied.locator('[data-action="exclude"]').count(),0);await denied.close();console.log('PASS denied admin '+backend);
  const expired=await open(backend,{expired:true});await expired.waitForSelector('[data-action="assign-manual-match"]');assert(await expired.evaluate(()=>testState.requests.some(r=>r.url.includes('grant_type=refresh_token'))));await expired.close();console.log('PASS expired session '+backend);
  const failed=await open(backend,{failure:'feedback'});await failed.locator('[data-action="wf-details"]').first().click();await failed.waitForSelector('.mchl-wf-box .mchl-alert');assert.equal(await failed.locator('[data-action="wf-feedback"]').count(),0);await failed.close();console.log('PASS failed feedback read '+backend);
  const writeFailed=await open(backend,{failure:'write'});await writeFailed.locator('[data-action="wf-details"]').first().click();await writeFailed.waitForSelector('[data-action="wf-feedback"]');await writeFailed.locator('[data-action="wf-feedback"]').first().click();
  await writeFailed.waitForFunction(()=>testState.alerts.length>0);assert.equal(await writeFailed.locator('.mchl-on-false,.mchl-on-true').count(),0);await writeFailed.close();console.log('PASS rejected write '+backend);
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
