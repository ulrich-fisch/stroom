// Toets die toegangsslot teen 'n plaaslike databasis. Gebruik: node --experimental-sqlite tools/test-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
const sql = new DatabaseSync(':memory:');
const stmt = (q) => { let args = []; const o = {
  bind: (...a) => { args = a; return o; },
  run: async () => { const r = sql.prepare(q).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
  first: async () => sql.prepare(q).get(...args) ?? null,
  _exec: () => sql.exec(q) }; return o; };
const DB = { prepare: stmt, batch: async (list) => { list.forEach((s) => s._exec()); } };
const ASSETS = { fetch: async (req) => new Response('PAGE ' + new URL(req.url).pathname, { status: 200 }) };
const env = { DB, ASSETS };
const call = (path, opts = {}, cookie) => worker.fetch(new Request('https://x.test' + path, { redirect: 'manual',
  ...opts, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } }), env);
const post = (path, body, cookie) => call(path, { method: 'POST', body: JSON.stringify(body) }, cookie);
const ck = (r) => (r.headers.get('Set-Cookie') || '').split(';')[0];
let fails = 0; const t = (name, ok) => { console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) fails++; };

// 1. Anonymous
for (const p of ['/katalogus.html','/katalogus','/joernaal','/oor-ons','/profiel','/rekening','/kies-plan','/skep'])
  { const r = await call(p); t('anon blocked ' + p, r.status === 302 && r.headers.get('Location').includes('teken-in')); }
for (const p of ['/','/index.html','/teken-in.html','/privaatheid','/waglys.html']) { const r = await call(p); t('public ' + p, r.status === 200); }
t('anon /api/me 401', (await call('/api/me')).status === 401);
t('fake localStorage-style cookie rejected', (await call('/katalogus', {}, 'stroom_sessie=abc')).status === 302);

// 2. Register
t('weak password rejected', (await post('/api/register', { email: 'a@b.co', password: '123' })).status === 400);
t('bad email rejected', (await post('/api/register', { email: 'nope', password: '12345678' })).status === 400);
let r = await post('/api/register', { email: 'Test@Stroom.co.za', name: 'Test', password: 'correct-horse' });
t('register ok', r.status === 200); const cookie = ck(r);
t('cookie is HttpOnly+Secure', /HttpOnly/.test(r.headers.get('Set-Cookie')) && /Secure/.test(r.headers.get('Set-Cookie')));
t('duplicate email 409', (await post('/api/register', { email: 'test@stroom.co.za', password: 'whatever12' })).status === 409);

// 3. Logged in but no plan yet
r = await call('/kies-plan', {}, cookie); t('plan page open after signup', r.status === 200);
r = await call('/katalogus', {}, cookie); t('catalogue blocked until a plan is chosen', r.status === 302 && r.headers.get('Location').includes('kies-plan'));
r = await call('/profiel', {}, cookie); t('profile blocked until a plan is chosen', r.status === 302);
t('cannot self-grant paid plan', (await post('/api/plan', { plan: 'svod' }, cookie)).status === 403);
t('cannot self-grant premium alt', (await post('/api/plan', { plan: 'svod_active' }, cookie)).status === 403);
r = await call('/katalogus', {}, cookie); t('still blocked after failed premium grab', r.status === 302);

// 4. Choose free plan
t('free plan ok', (await post('/api/plan', { plan: 'avod' }, cookie)).status === 200);
for (const p of ['/katalogus','/joernaal','/oor-ons','/profiel','/rekening','/skep']) { r = await call(p, {}, cookie); t('access ' + p, r.status === 200 && /no-store/.test(r.headers.get('Cache-Control'))); }
t('/api/me plan avod', (await (await call('/api/me', {}, cookie)).json()).plan === 'avod');

// 5. Login / brute force
t('wrong password 401', (await post('/api/login', { email: 'test@stroom.co.za', password: 'nope' })).status === 401);
t('unknown user 401', (await post('/api/login', { email: 'who@x.co', password: 'nope' })).status === 401);
r = await post('/api/login', { email: 'test@stroom.co.za', password: 'correct-horse' }); t('login ok', r.status === 200);
const cookie2 = ck(r);
for (let i = 0; i < 10; i++) await post('/api/login', { email: 'brute@x.co', password: 'bad' + i });
t('brute force locked (429)', (await post('/api/login', { email: 'brute@x.co', password: 'x' })).status === 429);

// 6. Cross-site POST and logout
t('cross-site POST rejected', (await call('/api/plan', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.test' } }, cookie)).status === 403);
await post('/api/logout', {}, cookie2);
t('session dead after logout', (await call('/katalogus', {}, cookie2)).status === 302);
t('other session unaffected', (await call('/katalogus', {}, cookie)).status === 200);

// 7. No database -> fail closed
const bare = await worker.fetch(new Request('https://x.test/katalogus', { redirect: 'manual' }), { ASSETS });
t('no DB: protected page closed', bare.status === 302);
t('no DB: public page still up', (await worker.fetch(new Request('https://x.test/'), { ASSETS })).status === 200);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
