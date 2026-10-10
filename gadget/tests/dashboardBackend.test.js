const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../gadget-searchHelperDashboard.js'), 'utf8');
const block = source.slice(source.indexOf('// ===== backend-start'), source.indexOf('// ===== backend-end'));
const { DATABASES, databaseId, databaseHeaders, databaseWrite, sessionUserId } = new Function(block + '\nreturn {DATABASES,databaseId,databaseHeaders,databaseWrite,sessionUserId};')();

test('page default and explicit backend selection', () => {
 assert.equal(databaseId('', 'מיוחד:דף_ריק/database'), 'v1');
 assert.equal(databaseId('', 'מיוחד:דף_ריק/database-v2'), 'v2');
 assert.equal(databaseId('?mchlDb=v1', 'מיוחד:דף_ריק/database-v2'), 'v1');
 assert.equal(databaseId('?mchlDb=invalid', 'מיוחד:דף_ריק/database'), 'v1');
});
for (const id of ['v1','v2']) test(id + ' scopes REST reads/writes to its project schema', () => {
 const cfg = DATABASES[id], h = databaseHeaders(cfg, 'session-' + id, {'Content-Type':'application/json'});
 assert.equal(h.apikey, cfg.anonKey); assert.equal(h.Authorization, 'Bearer session-' + id);
 assert.equal(h['Accept-Profile'], id === 'v1' ? 'public' : 'api'); assert.equal(h['Content-Profile'],h['Accept-Profile']);
 assert.equal(databaseHeaders(cfg).Authorization, 'Bearer ' + cfg.anonKey);
});
test('manual association uses the existing endpoint of each backend', () => {
 assert.deepEqual(databaseWrite(DATABASES.v1,'manual',{mechId:10,wikiId:1}).body,{mechalol_page_id:10,wikipedia_page_id:1});
 const req=databaseWrite(DATABASES.v2,'manual',{mechId:10,wikiId:1});assert.equal(req.path,'rpc/set_manual_link');assert.deepEqual(req.body,{p_mech_id:10,p_wiki_id:1,p_reason:null});
});
test('feedback retains context and composite identity on both backends', () => {
 const data={wikipedia_id:1,match_key:'a&b',word:'word',entries:['entry'],label:'false',before:'before',after:'after'};
 assert.deepEqual(databaseWrite(DATABASES.v1,'feedback',data).body,data);
 const req=databaseWrite(DATABASES.v2,'feedback',data);assert.equal(req.path,'rpc/mark_feedback');assert.equal(req.body.p_before,'before');assert.equal(req.body.p_after,'after');
 const unmark=databaseWrite(DATABASES.v1,'unmark',data);assert.equal(unmark.method,'DELETE');assert.equal(new URLSearchParams(unmark.path.split('?')[1]).get('match_key'),'eq.a&b');
 assert.deepEqual(databaseWrite(DATABASES.v2,'unmark',data).body,{p_wiki_id:1,p_match_key:'a&b'});
});
test('V2 exclusion retains the established exclusion kind',()=>{
 const req=databaseWrite(DATABASES.v2,'exclude',{wikiId:1,title:'title'});assert.equal(req.path,'rpc/add_exclusion');assert.equal(req.body.p_kind,'import_excluded');
 assert.throws(()=>databaseWrite(DATABASES.v1,'exclude',{wikiId:1,title:'title'}));
});

test('feedback identity supports existing JWT sessions and rejects missing identity', () => {
 const token = 'header.' + Buffer.from(JSON.stringify({sub:'user-1'})).toString('base64url') + '.signature';
 assert.equal(sessionUserId({access_token:token}),'user-1');
 assert.equal(sessionUserId({user_id:'user-2'}),'user-2');
 assert.equal(sessionUserId({access_token:'invalid'}),null);
});
