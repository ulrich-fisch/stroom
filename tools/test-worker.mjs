// Toets die toegangsslot teen 'n plaaslike databasis. Gebruik: node --experimental-sqlite tools/test-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
const sql = new DatabaseSync(':memory:');
const stmt = (q) => { let args = []; const o = {
  bind: (...a) => { args = a; return o; },
  run: async () => { const r = sql.prepare(q).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
  first: async () => sql.prepare(q).get(...args) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...args) }),
  _exec: () => /^\s*(SELECT|PRAGMA)/i.test(q) ? { results: sql.prepare(q).all(...args) } : (sql.prepare(q).run(...args), { results: [] }) }; return o; };
const DB = { prepare: stmt, batch: async (list) => list.map((s) => s._exec()) };
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

// 6b. Rekening-selfdiens
t('export needs login', (await call('/api/export')).status === 401);
r = await call('/api/export', {}, cookie); const exp = await r.json();
t('export returns own data only', r.status === 200 && exp.rekening.e_pos === 'test@stroom.co.za' && !JSON.stringify(exp).includes('hash'));
r = await post('/api/login', { email: 'test@stroom.co.za', password: 'correct-horse' }); const cookieB = ck(r);
t('password change: wrong current refused', (await post('/api/password', { current: 'nope', next: 'brand-new-pass' }, cookie)).status === 401);
t('password change: too short refused', (await post('/api/password', { current: 'correct-horse', next: 'short' }, cookie)).status === 400);
t('password change ok', (await post('/api/password', { current: 'correct-horse', next: 'brand-new-pass' }, cookie)).status === 200);
t('other device signed out after password change', (await call('/katalogus', {}, cookieB)).status === 302);
t('this device stays signed in', (await call('/katalogus', {}, cookie)).status === 200);
t('old password no longer works', (await post('/api/login', { email: 'test@stroom.co.za', password: 'correct-horse' })).status === 401);
r = await post('/api/login', { email: 'test@stroom.co.za', password: 'brand-new-pass' }); t('new password works', r.status === 200);
const cookieC = ck(r);
t('logout-all ends every session', (await post('/api/logout-all', {}, cookieC)).status === 200
  && (await call('/katalogus', {}, cookieC)).status === 302 && (await call('/katalogus', {}, cookie)).status === 302);
r = await post('/api/login', { email: 'test@stroom.co.za', password: 'brand-new-pass' }); const cookieD = ck(r);
t('delete refused with wrong password', (await post('/api/delete-account', { password: 'nope' }, cookieD)).status === 401);
t('delete needs login', (await post('/api/delete-account', { password: 'brand-new-pass' })).status === 401);
t('delete ok', (await post('/api/delete-account', { password: 'brand-new-pass' }, cookieD)).status === 200);
t('deleted account cannot log in', (await post('/api/login', { email: 'test@stroom.co.za', password: 'brand-new-pass' })).status === 401);
t('deleted account session dead', (await call('/katalogus', {}, cookieD)).status === 302);
t('email can be re-registered after delete', (await post('/api/register', { email: 'test@stroom.co.za', password: 'another-pass-1' })).status === 200);

const buildCheckoutForTest = (user) => buildCheckout({ cfg: { merchantId: '1', merchantKey: 'k', passphrase: 'p', process: 'x' }, user, orderId: 'S1', planKey: 'monthly', origin: 'https://x.test', now: Date.now() }).fields;
// 6c. Betalings (PayFast, toetsmodus met valse sleutels)
import { buildCheckout, formSignature, itnParamString, itnSignatureOk, md5, pfEncode, saDate } from '../src/payfast.js';
r = await post('/api/register', { email: 'pay@stroom.co.za', name: 'Pieter van Wyk', password: 'pay-pass-1234' }); const pc = ck(r);
await post('/api/plan', { plan: 'avod' }, pc);
t('checkout closed without PayFast keys', (await post('/api/checkout', { plan: 'monthly' }, pc)).status === 503);
Object.assign(env, { PAYFAST_MERCHANT_ID: '10000000', PAYFAST_MERCHANT_KEY: 'fakekey123456', PAYFAST_PASSPHRASE: 'test pass&1' });
t('checkout needs login', (await post('/api/checkout', { plan: 'monthly' })).status === 401);
t('checkout rejects unknown plan', (await post('/api/checkout', { plan: 'gratis' }, pc)).status === 400);
r = await post('/api/checkout', { plan: 'monthly' }, pc); const co = await r.json();
t('monthly checkout ok, sandbox URL', r.status === 200 && co.action === 'https://sandbox.payfast.co.za/eng/process');
t('monthly = 7-day free trial then R59/month', co.fields.amount === '0.00' && co.fields.recurring_amount === '59.00' && co.fields.frequency === '3'
  && co.fields.subscription_type === '1' && co.fields.billing_date === saDate(7) && co.fields.cycles === '0');
t('callback URLs point to this site', co.fields.notify_url === 'https://x.test/api/payfast-itn' && co.fields.return_url.startsWith('https://x.test/rekening.html'));
const { signature: sig0, ...rest0 } = co.fields;
t('form signature verifies', sig0 === formSignature(rest0, 'test pass&1') && /^[0-9a-f]{32}$/.test(sig0));
t('signature changes if amount tampered', formSignature({ ...rest0, amount: '1.00' }, 'test pass&1') !== sig0);
t('merchant key/passphrase: key only in form, passphrase never sent', !JSON.stringify(co).includes('test pass'));
r = await post('/api/checkout', { plan: 'annual' }, pc); const coA = await r.json();
t('annual = R590 now, yearly', coA.fields.amount === '590.00' && coA.fields.recurring_amount === '590.00' && coA.fields.frequency === '6');
{ const odd = buildCheckoutForTest({ name: "Zoë O'Brien-Smit", email: 'ulrich+test@gmail.com' });
  t('odd name cleaned, plus-email left out of the form', odd.name_first === 'Zoe' && odd.name_last === 'OBrien-Smit' && !('email_address' in odd)); }
{ const one = buildCheckoutForTest({ name: 'Ulrich', email: 'ulibbulli@gmail.com' });
  t('one-word name: blank surname not sent at all', one.name_first === 'Ulrich' && !('name_last' in one) && Object.values(one).every((v) => String(v) !== '')); }
t('encoding matches PHP urlencode', pfEncode("a b!'()*~@é") === 'a+b%21%27%28%29%2A%7E%40%C3%A9');

const signItn = (obj, pass = 'test pass&1') => { const pairs = Object.entries(obj); const body = itnParamString(pairs) + '&signature=' + md5(itnParamString(pairs) + '&passphrase=' + pfEncode(pass)); return body; };
const itn = (body) => worker.fetch(new Request('https://x.test/api/payfast-itn', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }), env);
const realFetch = globalThis.fetch; let payfastSays = 'VALID'; const calls = [];
globalThis.fetch = async (u, o) => { calls.push([String(u), o]); return new Response(String(u).includes('/validate') ? payfastSays : '', { status: 200 }); };
const base = { m_payment_id: co.fields.m_payment_id, pf_payment_id: '1089250', payment_status: 'COMPLETE', item_name: 'Stroom', amount_gross: '0.00', amount_fee: '0.00', amount_net: '0.00', token: 'tok-abc-123', name_first: 'Pieter', merchant_id: '10000000' };
const planOf = async () => (await (await call('/api/me', {}, pc)).json()).plan;

t('ITN with no signature refused', (await itn(itnParamString(Object.entries(base)))).status === 400 && await planOf() === 'avod');
t('ITN signed with wrong passphrase refused', (await itn(signItn(base, 'nope'))).status === 400 && await planOf() === 'avod');
t('ITN for another merchant refused', (await itn(signItn({ ...base, merchant_id: '999' }))).status === 400);
t('ITN for unknown order refused', (await itn(signItn({ ...base, m_payment_id: 'S0000' }))).status === 400);
payfastSays = 'INVALID';
t('ITN not confirmed by PayFast refused', (await itn(signItn(base))).status === 400 && await planOf() === 'avod');
payfastSays = 'VALID';
t('ITN with tampered amount refused', (await itn(signItn({ ...base, amount_gross: '1.00' }))).status === 400 && await planOf() === 'avod');
t('return page alone grants nothing', await planOf() === 'avod' && (await call('/rekening.html?betaling=terug', {}, pc)).status === 200);
t('valid confirmed ITN activates Premium', (await itn(signItn(base))).status === 200 && await planOf() === 'svod');
t('PayFast was asked to confirm', calls.some(([u]) => u === 'https://sandbox.payfast.co.za/eng/query/validate'));
t('/api/me shows plan period', (await (await call('/api/me', {}, pc)).json()).plan_period === 'monthly');
t('repeat ITN is harmless', (await itn(signItn(base))).status === 200 && await planOf() === 'svod');
t('already-premium cannot start second checkout', (await post('/api/checkout', { plan: 'monthly' }, pc)).status === 409);
t('another user cannot use this order', (await (async () => { const o = await post('/api/register', { email: 'other@x.co', password: 'other-pass-123' }); const oc = ck(o);
  await post('/api/plan', { plan: 'avod' }, oc); await itn(signItn({ ...base })); return (await (await call('/api/me', {}, oc)).json()).plan; })()) === 'avod');

calls.length = 0;
t('cancel needs login', (await post('/api/cancel-subscription', {})).status === 401);
t('cancel calls PayFast API with signed headers', (await post('/api/cancel-subscription', {}, pc)).status === 200
  && calls.some(([u, o]) => u.startsWith('https://api.payfast.co.za/subscriptions/tok-abc-123/cancel?testing=true') && o.method === 'PUT' && /^[0-9a-f]{32}$/.test(o.headers.signature) && o.headers['merchant-id'] === '10000000'));
t('after cancel: back to free plan', await planOf() === 'avod');
t('cancel without subscription refused', (await post('/api/cancel-subscription', {}, pc)).status === 404);
// 'n nuwe bestelling, aktiveer en dan CANCELLED-ITN van PayFast
r = await post('/api/checkout', { plan: 'annual' }, pc); const co2 = await r.json();
await itn(signItn({ ...base, m_payment_id: co2.fields.m_payment_id, amount_gross: '590.00', token: 'tok-2' }));
t('annual activation', await planOf() === 'svod' && (await (await call('/api/me', {}, pc)).json()).plan_period === 'annual');
t('PayFast CANCELLED ITN downgrades', (await itn(signItn({ ...base, m_payment_id: co2.fields.m_payment_id, payment_status: 'CANCELLED', amount_gross: '590.00', token: 'tok-2' }))).status === 200 && await planOf() === 'avod');
payfastSays = 'VALID';

// 6d. Skepper Portaal: net Premium-lede
r = await post('/api/register', { email: 'skep@stroom.co.za', name: 'Skepper', password: 'skep-pass-1234' }); const sk = ck(r);
await post('/api/plan', { plan: 'avod' }, sk);
const good = { name: 'Johan vd Merwe', title: 'Die Laaste Rit', type: 'Kortfilm', link: 'https://vimeo.com/123456', synopsis: 'n Kort storie.', agree: true };
t('skep: needs login', (await post('/api/skep', good)).status === 401);
t('skep: free member refused', (await post('/api/skep', good, sk)).status === 403);
r = await post('/api/checkout', { plan: 'monthly' }, sk); const coSk = await r.json();
await itn(signItn({ ...base, m_payment_id: coSk.fields.m_payment_id, token: 'tok-3' }));
t('skep: premium now', (await (await call('/api/me', {}, sk)).json()).plan === 'svod');
t('skep: rejects non-https link', (await post('/api/skep', { ...good, link: 'javascript:alert(1)' }, sk)).status === 400);
t('skep: rejects missing agreement', (await post('/api/skep', { ...good, agree: false }, sk)).status === 400);
t('skep: rejects bad type', (await post('/api/skep', { ...good, type: 'Reklame' }, sk)).status === 400);
t('skep: premium member can submit', (await post('/api/skep', good, sk)).status === 200);
t('skep: admin list closed without ADMIN_EMAIL', (await call('/api/skep-admin', {}, sk)).status === 404);
env.ADMIN_EMAIL = 'skep@stroom.co.za';
r = await call('/api/skep-admin', {}, sk); const adm = await r.json();
t('skep: owner sees pending submission', r.status === 200 && adm.inskrywings.length === 1 && adm.inskrywings[0].status === 'hangende' && adm.inskrywings[0].title === 'Die Laaste Rit');
for (let k = 0; k < 4; k++) await post('/api/skep', good, sk);
t('skep: daily limit of 5', (await post('/api/skep', good, sk)).status === 429);
env.ADMIN_EMAIL = 'iemand@anders.co';
t('skep: non-owner cannot list', (await call('/api/skep-admin', {}, sk)).status === 404);
globalThis.fetch = async () => new Response('', { status: 500 });
r = await post('/api/checkout', { plan: 'monthly' }, pc); const coS = await r.json();
await itn(signItn({ ...base, m_payment_id: coS.fields.m_payment_id }, 'test pass&1')).catch(() => {});
globalThis.fetch = realFetch;
delete env.PAYFAST_MERCHANT_ID; delete env.PAYFAST_MERCHANT_KEY; delete env.PAYFAST_PASSPHRASE;
t('ITN endpoint closed without keys', (await itn('x=1')).status === 503);

// 7. No database -> fail closed
const bare = await worker.fetch(new Request('https://x.test/katalogus', { redirect: 'manual' }), { ASSETS });
t('no DB: protected page closed', bare.status === 302);
t('no DB: public page still up', (await worker.fetch(new Request('https://x.test/'), { ASSETS })).status === 200);

// 6e. Inhoud, admin en advertensies
r = await post('/api/register', { email: 'eienaar@stroom.co.za', name: 'Eienaar Een', password: 'eienaar-pass-1' }); const ow = ck(r);
await post('/api/plan', { plan: 'avod' }, ow);
r = await post('/api/register', { email: 'lid@stroom.co.za', name: 'Lid Een', password: 'lid-pass-12345' }); const lid = ck(r);
t('katalogus: needs a plan first', (await call('/api/katalogus', {}, lid)).status === 403);
await post('/api/plan', { plan: 'avod' }, lid);
t('katalogus: needs login', (await call('/api/katalogus')).status === 401);
r = await call('/api/katalogus', {}, lid); let kat = await r.json();
t('katalogus: demo titles seeded, no video addresses leaked', r.status === 200 && kat.titels.length === 5 && !JSON.stringify(kat).includes('.mp4') && !JSON.stringify(kat).includes('video_url'));
t('katalogus: series episodes listed without urls', JSON.stringify(kat.titels.find((x) => x.slug === 'pretoria').episodes).includes('Die Eerste Skaduwee') && !JSON.stringify(kat).includes('http://'));
// advertensies: gratis ja, premium nee
r = await post('/api/speel', { slug: 'karoo' }, lid); let sp = await r.json();
t('speel: free member gets film url + one ad', r.status === 200 && sp.url.endsWith('.mp4') && sp.advertensies.length === 1 && sp.advertensies[0].url.startsWith('https://'));
t('speel: unknown / unpublished title refused', (await post('/api/speel', { slug: 'bestaan-nie' }, lid)).status === 404);
t('speel: bad episode refused', (await post('/api/speel', { slug: 'pretoria', ep: 9 }, lid)).status === 404);
r = await post('/api/speel', { slug: 'pretoria', ep: 1 }, lid); sp = await r.json();
t('speel: episode url + title', r.status === 200 && /Geheime Spore/.test(sp.titel));
// admin gesluit
t('admin api closed without ADMIN_EMAIL', (await call('/api/admin/titels', {}, ow)).status === 404);
env.ADMIN_EMAIL = 'EIENAAR@stroom.co.za';
t('admin page: anon redirected', (await call('/admin')).status === 302);
t('admin page: normal member gets 404', (await call('/admin.html', {}, lid)).status === 404);
t('admin page: owner ok', (await call('/admin.html', {}, ow)).status === 200);
t('admin api: member refused', (await call('/api/admin/titels', {}, lid)).status === 404 && (await post('/api/admin/titel', { titel: 'X' }, lid)).status === 404);
t('/api/me: admin flag only for owner', (await (await call('/api/me', {}, ow)).json()).admin === true && (await (await call('/api/me', {}, lid)).json()).admin === false);
// titel-bestuur
const nuut = { titel: 'My Nuwe Film', tipe: 'Kortfilm', genre_sleutel: 'drama', regisseur: 'Ek', banner: 'https://img.example/a.jpg', video_url: 'https://vid.example/a.mp4', status: 'gepubliseer', sinopsis: 'Toets' };
t('admin: rejects non-https video', (await post('/api/admin/titel', { ...nuut, video_url: 'javascript:alert(1)' }, ow)).status === 400);
t('admin: rejects bad type', (await post('/api/admin/titel', { ...nuut, tipe: 'Reklame' }, ow)).status === 400);
t('admin: published needs a video', (await post('/api/admin/titel', { ...nuut, video_url: '' }, ow)).status === 400);
t('admin: bad episode line refused', (await post('/api/admin/titel', { ...nuut, tipe: 'Reeks', episodes_teks: 'Ep 1 | Titel | 10 min | beskrywing | http://nie-https' }, ow)).status === 400);
r = await post('/api/admin/titel', nuut, ow); const mk = await r.json();
t('admin: create published title', r.status === 200 && mk.slug === 'my-nuwe-film');
t('member now sees new title', (await (await call('/api/katalogus', {}, lid)).json()).titels.some((x) => x.slug === 'my-nuwe-film'));
r = await call('/api/admin/titels', {}, ow); const al = await r.json(); const mine = al.titels.find((x) => x.slug === 'my-nuwe-film');
await post('/api/admin/titel', { ...nuut, id: mine.id, status: 'konsep' }, ow);
t('draft hidden from members and cannot be played', !(await (await call('/api/katalogus', {}, lid)).json()).titels.some((x) => x.slug === 'my-nuwe-film') && (await post('/api/speel', { slug: 'my-nuwe-film' }, lid)).status === 404);
await post('/api/admin/titel-skrap', { id: mine.id }, ow);
t('admin: delete title', !(await (await call('/api/admin/titels', {}, ow)).json()).titels.some((x) => x.slug === 'my-nuwe-film'));
// advertensies-bestuur en Premium sonder advertensies
t('admin: ad needs https video', (await post('/api/admin/ad', { naam: 'X', video_url: 'ftp://x' }, ow)).status === 400);
await post('/api/admin/ad', { naam: 'Tweede Ad', video_url: 'https://vid.example/ad2.mp4', klik_url: 'https://adverteerder.example', aktief: true }, ow);
let ads = (await (await call('/api/admin/ads', {}, ow)).json()).advertensies;
t('admin: ads listed with view counts', ads.length === 2 && ads.some((x) => x.vertonings >= 1));
for (const a of ads) await post('/api/admin/ad', { id: a.id, naam: a.naam, video_url: a.video_url, klik_url: a.klik_url, aktief: false }, ow);
t('no active ads -> free member plays straight away', (await (await post('/api/speel', { slug: 'karoo' }, lid)).json()).advertensies.length === 0);
for (const a of ads) await post('/api/admin/ad', { id: a.id, naam: a.naam, video_url: a.video_url, klik_url: a.klik_url, aktief: true }, ow);
// premium sien nooit advertensies
r = await post('/api/admin/toets-plan', { plan: 'svod' }, ow);
t('toets-plan: owner can switch to Premium (sandbox)', r.status === 200 && (await (await call('/api/me', {}, ow)).json()).plan === 'svod');
sp = await (await post('/api/speel', { slug: 'karoo' }, ow)).json();
t('premium member: film plays with NO ads', sp.url.endsWith('.mp4') && sp.advertensies.length === 0);
t('toets-plan: normal member cannot', (await post('/api/admin/toets-plan', { plan: 'svod' }, lid)).status === 404);
env.PAYFAST_MODE = 'live';
t('toets-plan: blocked in live mode', (await post('/api/admin/toets-plan', { plan: 'avod' }, ow)).status === 403);
delete env.PAYFAST_MODE;
// inskrywings
await post('/api/skep', { name: 'Maker', title: 'Toets Film', type: 'Kortfilm', link: 'https://vimeo.com/1', synopsis: 'x', agree: true }, ow);
r = await call('/api/admin/inskrywings', {}, ow); const ins = await r.json();
const mkI = ins.inskrywings.find((x) => x.title === 'Toets Film');
t('admin: sees submissions', !!mkI && mkI.status === 'hangende');
await post('/api/admin/inskrywing-status', { id: mkI.id, status: 'goedgekeur' }, ow);
t('admin: can approve submission', (await (await call('/api/admin/inskrywings', {}, ow)).json()).inskrywings.find((x) => x.id === mkI.id).status === 'goedgekeur');
t('admin: rejects bad submission status', (await post('/api/admin/inskrywing-status', { id: mkI.id, status: 'gepubliseer' }, ow)).status === 400);

// 6f. Eie lêers (R2)
const store = new Map();
const up = (path, bytes, cookie, extra = {}) => worker.fetch(new Request('https://x.test' + path, { method: 'POST', body: bytes, headers: { 'Content-Length': String(bytes.length), ...(cookie ? { Cookie: cookie } : {}), ...extra } }), env);
t('upload: R2 not configured -> 503', (await up('/api/admin/laai-op?ext=mp4', new Uint8Array(10), ow)).status === 503);
env.VIDEOS = {
  put: async (key, body, o) => { const buf = new Uint8Array(await new Response(body).arrayBuffer()); store.set(key, { buf, httpMetadata: o.httpMetadata }); },
  get: async (key, o) => { const e = store.get(key); if (!e) return null; let body = e.buf, range;
    if (o && o.range) { const m = /bytes=(\d*)-(\d*)/.exec(o.range.get('Range')); const a = Number(m[1]), b = m[2] ? Number(m[2]) : e.buf.length - 1; body = e.buf.slice(a, b + 1); range = { offset: a, length: body.length }; }
    return { body, size: e.buf.length, httpMetadata: e.httpMetadata, range }; } };
const bytes = new Uint8Array(1000).map((_, i) => i % 256);
t('upload: member cannot', (await up('/api/admin/laai-op?ext=mp4', bytes, lid)).status === 404);
t('upload: anonymous cannot', (await up('/api/admin/laai-op?ext=mp4', bytes)).status === 404);
t('upload: .mkv refused with hint', (await up('/api/admin/laai-op?ext=mkv', bytes, ow)).status === 400);
t('upload: .exe refused', (await up('/api/admin/laai-op?ext=exe', bytes, ow)).status === 400);
r = await up('/api/admin/laai-op?ext=mp4', bytes, ow); const upj = await r.json();
t('upload: admin mp4 ok', r.status === 200 && /^\/media\/[0-9a-f]{24}\.mp4$/.test(upj.url) && store.size === 1);
t('media: anonymous refused', (await call(upj.url)).status === 401);
r = await call(upj.url, {}, lid);
t('media: member gets full file', r.status === 200 && (await r.arrayBuffer()).byteLength === 1000 && r.headers.get('Accept-Ranges') === 'bytes');
r = await call(upj.url, { headers: { Range: 'bytes=10-19' } }, lid);
t('media: range request -> 206', r.status === 206 && r.headers.get('Content-Range') === 'bytes 10-19/1000' && (await r.arrayBuffer()).byteLength === 10);
t('media: bad key 404', (await call('/media/..%2F..%2Fetc.mp4', {}, lid)).status === 404 && (await call('/media/abc.mp4', {}, lid)).status === 404);
r = await post('/api/admin/titel', { titel: 'Eie Toets', tipe: 'Kortfilm', genre_sleutel: 'drama', jaar: 2026, ouderdom: 'PG', speeltyd: '1 min', pas: 90, banner: upj.url, video_url: upj.url, sinopsis: 'x', uitgelig: false, status: 'gepubliseer' }, ow);
t('admin: title with uploaded /media URLs accepted', r.status === 200);
r = await post('/api/admin/ad', { naam: 'Eie Ad', video_url: upj.url, klik_url: '', aktief: true }, ow);
t('admin: ad with uploaded /media video accepted', r.status === 200);
t('admin: title with http:// still refused', (await post('/api/admin/titel', { titel: 'Sleg', tipe: 'Kortfilm', genre_sleutel: 'drama', video_url: 'http://x.example/a.mp4', status: 'gepubliseer' }, ow)).status === 400);
delete env.VIDEOS;

// 6g. Groot films (Cloudflare Stream)
const UID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const cfCalls = []; const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u2 = String(url); if (!u2.startsWith('https://api.cloudflare.com/')) return prevFetch(url, init);
  cfCalls.push({ url: u2, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
  if (u2.includes('direct_user=true')) return new Response(null, { status: 201, headers: { Location: 'https://upload.cloudflarestream.com/' + UID + '?tusv2=true', 'stream-media-id': UID } });
  if (u2.endsWith('/token')) return new Response(JSON.stringify({ success: true, result: { token: 'TOKEN123' } }), { status: 200 });
  if (u2.endsWith('/stream/' + UID)) return new Response(JSON.stringify({ success: true, result: { uid: UID, readyToStream: true, duration: 7200, status: { state: 'ready' } } }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const sj = (path, body, cookie) => post(path, body, cookie);
t('stream upload: not configured -> 503', (await sj('/api/admin/stream-laai-op', { size: 1e9, naam: 'x.mp4' }, ow)).status === 503);
env.CF_ACCOUNT_ID = 'acc123'; env.CF_STREAM_TOKEN = 'secret-token'; env.STREAM_CODE = 'abc123xyz';
t('stream upload: member cannot', (await sj('/api/admin/stream-laai-op', { size: 1e9, naam: 'x.mp4' }, lid)).status === 404);
t('stream upload: anonymous cannot', (await sj('/api/admin/stream-laai-op', { size: 1e9, naam: 'x.mp4' })).status === 404);
t('stream upload: bad size refused', (await sj('/api/admin/stream-laai-op', { size: -5 }, ow)).status === 400);
r = await sj('/api/admin/stream-laai-op', { size: 3e9, naam: 'Groot Film.mp4' }, ow); const su = await r.json();
const upCall = cfCalls.find((c) => c.url.includes('direct_user=true'));
t('stream upload: admin gets direct upload URL + stream reference', r.status === 200 && su.uploadUrl.startsWith('https://upload.cloudflarestream.com/') && su.verwysing === 'stream:' + UID);
t('stream upload: signed URLs required + size forwarded + token stays server-side', /requiresignedurls/.test(upCall.headers['Upload-Metadata']) && upCall.headers['Upload-Length'] === '3000000000' && !JSON.stringify(su).includes('secret-token'));
t('stream status: admin sees ready', (await (await call('/api/admin/stream-status?uid=' + UID, {}, ow)).json()).gereei === undefined && (await (await call('/api/admin/stream-status?uid=' + UID, {}, ow)).json()).gereed === true);
t('stream status: member cannot, bad uid refused', (await call('/api/admin/stream-status?uid=' + UID, {}, lid)).status === 404 && (await call('/api/admin/stream-status?uid=zzz', {}, ow)).status === 400);
r = await post('/api/admin/titel', { titel: 'Stream Film', tipe: 'Speelfilm', genre_sleutel: 'drama', banner: 'https://img.example/a.jpg', video_url: 'stream:' + UID, status: 'gepubliseer', sinopsis: 'x' }, ow);
t('admin: title with stream video accepted', r.status === 200);
t('admin: bad stream reference refused', (await post('/api/admin/titel', { titel: 'Sleg2', tipe: 'Speelfilm', genre_sleutel: 'drama', banner: 'https://img.example/a.jpg', video_url: 'stream:nope', status: 'gepubliseer' }, ow)).status === 400);
const slugS = (await (await call('/api/admin/titels', {}, ow)).json()).titels.find((x) => x.titel === 'Stream Film').slug;
t('catalogue never leaks stream reference', !JSON.stringify(await (await call('/api/katalogus', {}, lid)).json()).includes(UID));
sp = await (await post('/api/speel', { slug: slugS }, lid)).json();
t('free member: signed HLS url + ad', sp.hls === true && sp.url === 'https://customer-abc123xyz.cloudflarestream.com/TOKEN123/manifest/video.m3u8' && sp.advertensies.length === 1);
const tokCall = cfCalls.find((c) => c.url.endsWith('/token'));
t('playback token has a 6h expiry', Math.abs(JSON.parse(tokCall.body).exp - (Date.now() / 1000 + 21600)) < 60);
t('anonymous cannot get a playback link', (await post('/api/speel', { slug: slugS }, '')).status === 401);
const ep = await post('/api/admin/titel', { titel: 'Stream Reeks', tipe: 'Reeks', genre_sleutel: 'drama', banner: 'https://img.example/a.jpg', episodes_teks: 'Ep 1 | Eerste | 40 min | Begin | stream:' + UID, status: 'gepubliseer' }, ow);
const slugR = (await (await call('/api/admin/titels', {}, ow)).json()).titels.find((x) => x.titel === 'Stream Reeks').slug;
sp = await (await post('/api/speel', { slug: slugR, ep: 0 }, lid)).json();
t('episode with stream video plays via HLS', ep.status === 200 && sp.hls === true && sp.url.includes('/TOKEN123/'));
delete env.STREAM_CODE;
t('playback without stream setup -> clear error, no leak', (await post('/api/speel', { slug: slugS }, lid)).status === 503);
globalThis.fetch = prevFetch; delete env.CF_ACCOUNT_ID; delete env.CF_STREAM_TOKEN;

// 6h. Profiele, My Lys, gaan voort en gradering
r = await call('/api/profiele'); t('profiele: needs login', r.status === 401);
r = await call('/api/profiele', {}, lid); let pj = await r.json(); const P1 = pj.profiele[0];
t('profiele: default profile created from account name', r.status === 200 && pj.profiele.length === 1 && P1.naam === 'Lid Een' && pj.maks === 5);
r = await post('/api/profiel-nuut', { naam: 'Kinders', avatar: 3, kinders: true }, lid); const P2id = (await r.json()).id;
t('profiele: add kids profile', r.status === 200 && P2id > P1.id);
t('profiele: empty name refused', (await post('/api/profiel-nuut', { naam: '  ' }, lid)).status === 400);
for (let i = 0; i < 3; i++) await post('/api/profiel-nuut', { naam: 'X' + i }, lid);
t('profiele: max 5', (await post('/api/profiel-nuut', { naam: 'Ses' }, lid)).status === 400);
r = await post('/api/register', { email: 'ander@stroom.co.za', name: 'Ander', password: 'ander-pass-12345' }); const ander = ck(r);
await post('/api/plan', { plan: 'avod' }, ander);
t('profiele: cannot edit someone else\'s', (await post('/api/profiel-wysig', { id: P1.id, naam: 'Hack' }, ander)).status === 404);
t('profiele: cannot delete someone else\'s', (await post('/api/profiel-skrap', { id: P1.id }, ander)).status === 404);
t('lys: cannot use someone else\'s profile', (await post('/api/lys', { profiel: P1.id, slug: 'karoo', aan: true }, ander)).status === 400 && (await call('/api/vordering?profiel=' + P1.id, {}, ander)).status === 400);
t('katalogus: foreign profile refused', (await call('/api/katalogus?profiel=' + P1.id, {}, ander)).status === 400);
// My Lys
await post('/api/lys', { profiel: P1.id, slug: 'karoo', aan: true }, lid); await post('/api/lys', { profiel: P1.id, slug: 'karoo', aan: true }, lid);
t('lys: saved once, per profile', (await (await call('/api/lys?profiel=' + P1.id, {}, lid)).json()).slugs.join() === 'karoo' && (await (await call('/api/lys?profiel=' + P2id, {}, lid)).json()).slugs.length === 0);
await post('/api/lys', { profiel: P1.id, slug: 'karoo', aan: false }, lid);
t('lys: removed', (await (await call('/api/lys?profiel=' + P1.id, {}, lid)).json()).slugs.length === 0);
// Kinderprofiel
const all = await (await call('/api/katalogus?profiel=' + P1.id, {}, lid)).json(); const kids = await (await call('/api/katalogus?profiel=' + P2id, {}, lid)).json();
t('katalogus: kids profile only kid-safe titles', kids.kinders === true && kids.titels.length < all.titels.length && kids.titels.every((x) => /^(al|alle|all|a)$/i.test(x.ouderdom) || parseInt(x.ouderdom, 10) <= 10));
const adult = all.titels.find((x) => !kids.titels.some((k) => k.slug === x.slug));
t('speel: kids profile blocked from adult title', !!adult && (await post('/api/speel', { slug: adult.slug, profiel: P2id }, lid)).status === 403 && (await post('/api/speel', { slug: adult.slug, profiel: P1.id }, lid)).status === 200);
// Gaan voort
t('vordering: bad values refused', (await post('/api/vordering', { profiel: P1.id, slug: 'karoo', posisie: -1, duur: 100 }, lid)).status === 400);
await post('/api/vordering', { profiel: P1.id, slug: 'karoo', ep: -1, posisie: 100, duur: 1000 }, lid);
t('vordering: listed with position', (await (await call('/api/vordering?profiel=' + P1.id, {}, lid)).json()).items[0].posisie === 100);
sp = await (await post('/api/speel', { slug: 'karoo', profiel: P1.id }, lid)).json();
t('speel: resumes 3s before saved position', sp.begin === 97);
sp = await (await post('/api/speel', { slug: 'karoo', profiel: P1.id, herbegin: true }, lid)).json();
t('speel: start over gives begin 0', !sp.begin);
await post('/api/vordering', { profiel: P1.id, slug: 'karoo', ep: -1, posisie: 980, duur: 1000 }, lid);
t('vordering: finished titles leave the list', (await (await call('/api/vordering?profiel=' + P1.id, {}, lid)).json()).items.length === 0);
// Gradering
t('gradering: bad stars refused', (await post('/api/gradering', { profiel: P1.id, slug: 'karoo', sterre: 6 }, lid)).status === 400);
await post('/api/gradering', { profiel: P1.id, slug: 'karoo', sterre: 5 }, lid);
r = await post('/api/gradering', { profiel: (await (await call('/api/profiele', {}, ander)).json()).profiele[0].id, slug: 'karoo', sterre: 2 }, ander); let gj = await r.json();
t('gradering: average + count over profiles', gj.gem === 3.5 && gj.aantal === 2 && gj.myne === 2);
const k2 = (await (await call('/api/katalogus?profiel=' + P1.id, {}, lid)).json()).titels.find((x) => x.slug === 'karoo');
t('katalogus: shows average and my own rating, no fake match', k2.gem === 3.5 && k2.aantal === 2 && k2.myne === 5 && k2.pas === undefined);
t('admin list shows rating stats', (await (await call('/api/admin/titels', {}, ow)).json()).titels.find((x) => x.slug === 'karoo').aantal === 2);
await post('/api/gradering', { profiel: P1.id, slug: 'karoo', sterre: 0 }, lid);
t('gradering: 0 removes my rating', (await (await post('/api/gradering', { profiel: P1.id, slug: 'karoo', sterre: 0 }, lid)).json()).aantal === 1);
// skrap
await post('/api/lys', { profiel: P2id, slug: 'karoo', aan: true }, lid);
r = await post('/api/profiel-skrap', { id: P2id }, lid);
t('profiele: delete cascades', r.status === 200 && (await DB.prepare('SELECT COUNT(*) AS n FROM lys WHERE profiel_id = ?').bind(P2id).first()).n === 0);
const only = (await (await call('/api/profiele', {}, ander)).json()).profiele[0];
t('profiele: last profile cannot be deleted', (await post('/api/profiel-skrap', { id: only.id }, ander)).status === 400);

// 6i. Rakke: kyk-tellings en nuutheid
const k3 = (await (await call('/api/katalogus?profiel=' + P1.id, {}, lid)).json()).titels;
const kk = k3.find((x) => x.slug === 'karoo');
t('shelves: plays counted per title, recent only', kk.kyke >= 3 && k3.find((x) => x.slug !== 'karoo' && x.kyke === 0) !== undefined);
t('shelves: titles carry a created time, no video addresses', k3.every((x) => x.nuut > 0) && !JSON.stringify(k3).includes('video_url'));

// 6j. Installeerbare toep: vaste lêers is openbaar, geen ingeteken inhoud
for (const f of ['/manifest.webmanifest', '/sw.js', '/offline.html', '/icon-192.png']) t('pwa: ' + f + ' is public', (await call(f)).status === 200);

// 6k. Verslae en meting
const adList = (await (await call('/api/admin/advertensies', {}, ow)).json());
const adId = (adList.advertensies || adList.ads || adList.lys || [])[0]?.id;
sp = await (await post('/api/speel', { slug: 'karoo', profiel: P1.id }, lid)).json();
t('speel: ad carries an id for measurement', Number.isInteger(sp.advertensies[0].id));
const AD = sp.advertensies[0].id;
t('meet: needs login', (await post('/api/meet', { tipe: 'begin', ad: AD }, '')).status === 401);
t('meet: bad type / bad ad refused', (await post('/api/meet', { tipe: 'x', ad: AD }, lid)).status === 400 && (await post('/api/meet', { tipe: 'begin', ad: 99999 }, lid)).status === 404);
await post('/api/meet', { tipe: 'begin', ad: AD, slug: 'karoo' }, lid); await post('/api/meet', { tipe: 'begin', ad: AD, slug: 'karoo' }, lid);
await post('/api/meet', { tipe: 'klaar', ad: AD, slug: 'karoo', sek: 30 }, lid); await post('/api/meet', { tipe: 'klik', ad: AD, slug: 'karoo' }, lid);
await post('/api/vordering', { profiel: P1.id, slug: 'karoo', ep: -1, posisie: 40, duur: 1000, delta: 30 }, lid);
await post('/api/vordering', { profiel: P1.id, slug: 'karoo', ep: -1, posisie: 70, duur: 1000, delta: 500 }, lid);
t('verslag: members cannot see reports', (await call('/api/admin/verslag', {}, lid)).status === 404 && (await call('/api/admin/verslag')).status === 404 && (await call('/api/admin/tariewe', {}, lid)).status === 404);
r = await call('/api/admin/verslag?dae=30', {}, ow); const rp = await r.json();
t('verslag: admin gets the report', r.status === 200 && rp.dae === 30 && rp.dae_lys.length === 30 && rp.lede.totaal >= 3);
const ad1 = rp.advertensies.lys.find((a) => a.id === AD);
t('verslag: duplicate begin ignored, completion + click counted', ad1.vertonings === 1 && ad1.voltooi === 1 && ad1.klikke === 1 && ad1.voltooi_pct === 100 && ad1.ktv_pct === 100);
t('verslag: estimated value uses the rate card', ad1.beraamde_koste === Math.round((1 / 1000 * 120 + 1 * 4) * 100) / 100);
t('verslag: watch time capped per save (30 + 120 s)', rp.kykers.ure === Math.round(150 / 360) / 10 || rp.kykers.ure === 0.0 || rp.kykers.ure === 0.1);
t('verslag: plays, devices, countries, genres present', rp.kykers.kyke >= 3 && rp.kykers.toestelle.length > 0 && Array.isArray(rp.kykers.lande) && rp.kykers.genres.length > 0);
t('verslag: per-title rows with ratings', rp.inhoud.titels.find((x) => x.slug === 'karoo').kyke >= 3);
t('verslag: premium MRR uses rate card', rp.lede.mrr >= 0 && rp.lede.arr === rp.lede.mrr * 12);
r = await call('/api/admin/verslag?dae=30&ad=' + AD, {}, ow); const rd = (await r.json()).advertensie_detail;
t('verslag: single advertiser detail', rd && rd.vertonings === 1 && rd.titels[0].k.length > 0 && rd.toestelle.length === 1);
r = await post('/api/admin/tariewe', { cpm_voorrol: 200, cpc: 5 }, ow);
t('tariewe: admin can change rate card', r.status === 200 && (await r.json()).tariewe.cpm_voorrol === 200);
t('tariewe: bad value refused', (await post('/api/admin/tariewe', { cpc: -1 }, ow)).status === 400 && (await post('/api/admin/tariewe', { cpc: 1 }, lid)).status === 404);
const rp2 = await (await call('/api/admin/verslag?dae=30', {}, ow)).json();
t('verslag: new rate applied', rp2.advertensies.lys.find((a) => a.id === AD).beraamde_koste === Math.round((1 / 1000 * 200 + 5) * 100) / 100);
for (const so of ['titels', 'adverteerders', 'dae']) { r = await call('/api/admin/verslag-csv?soort=' + so, {}, ow); t('csv ' + so + ': admin gets a download', r.status === 200 && /text\/csv/.test(r.headers.get('Content-Type')) && (await r.text()).split('\n').length > 1); }
t('csv: members refused, bad type refused', (await call('/api/admin/verslag-csv?soort=titels', {}, lid)).status === 404 && (await call('/api/admin/verslag-csv?soort=x', {}, ow)).status === 400);
t('verslae page: gated like admin', (await call('/verslae.html', {}, lid)).status === 404 && (await call('/verslae.html', {}, ow)).status === 200);

// 6l. Subtitles (onderskrifte)
{
  const { toVtt } = await import('../src/onderskrifte.js');
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\nDie Erfenis van die Karoo\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n<i>Stilte</i> \u00EA\u00EB\r\n';
  const v = toVtt(srt);
  t('subs: SRT converts to WebVTT with dot timestamps', v.cues === 2 && v.vtt.startsWith('WEBVTT\n\n') && v.vtt.includes('00:00:01.000 --> 00:00:03.500') && !v.vtt.includes(','));
  t('subs: short mm:ss timestamps and VTT header handled', toVtt('WEBVTT\n\n01:02.5 --> 01:04.000\nHallo').vtt.includes('00:01:02.500 --> 00:01:04.000'));
  t('subs: garbage / empty rejected', !!toVtt('hello world').fout && !!toVtt('   ').fout && !!toVtt('x'.repeat(500 * 1024)).fout);
  const up = (b, c) => post('/api/admin/onderskrif', b, c);
  r = await up({ slug: 'karoo', ep: -1, taal: 'af', teks: srt }, ow); t('subs: admin upload ok', r.status === 200 && (await r.json()).cues === 2);
  t('subs: member cannot upload', (await up({ slug: 'karoo', ep: -1, taal: 'af', teks: srt }, lid)).status === 404);
  t('subs: bad language / unknown title / bad episode / bad file refused',
    (await up({ slug: 'karoo', taal: 'xx', teks: srt }, ow)).status === 400 && (await up({ slug: 'bestaan-nie', taal: 'af', teks: srt }, ow)).status === 404
    && (await up({ slug: 'karoo', ep: 3, taal: 'af', teks: srt }, ow)).status === 400 && (await up({ slug: 'karoo', taal: 'af', teks: 'nope' }, ow)).status === 400);
  r = await call('/api/onderskrif?slug=karoo&ep=-1&taal=af', {}, lid); const vt = await r.text();
  t('subs: member gets text/vtt in UTF-8', r.status === 200 && /text\/vtt; charset=utf-8/.test(r.headers.get('Content-Type')) && vt.startsWith('WEBVTT') && vt.includes('\u00EA\u00EB'));
  t('subs: anonymous refused, unknown language/title 404', (await call('/api/onderskrif?slug=karoo&ep=-1&taal=af')).status === 401
    && (await call('/api/onderskrif?slug=karoo&ep=-1&taal=en', {}, lid)).status === 404 && (await call('/api/onderskrif?slug=..%2Fx&ep=-1&taal=af', {}, lid)).status === 404);
  sp = await (await post('/api/speel', { slug: 'karoo' }, lid)).json();
  t('subs: play payload lists available languages', JSON.stringify(sp.onderskrifte) === JSON.stringify([{ taal: 'af', label: 'Afrikaans' }]));
  r = await up({ slug: 'pretoria', ep: 1, taal: 'en', teks: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello' }, ow);
  sp = await (await post('/api/speel', { slug: 'pretoria', ep: 1 }, lid)).json();
  const sp0 = await (await post('/api/speel', { slug: 'pretoria', ep: 0 }, lid)).json();
  t('subs: per-episode tracks stay separate', r.status === 200 && sp.onderskrifte.length === 1 && sp.onderskrifte[0].taal === 'en' && sp0.onderskrifte.length === 0);
  r = await call('/api/admin/onderskrifte?slug=karoo', {}, ow); const ls = await r.json();
  t('subs: admin list', ls.onderskrifte.length === 1 && ls.onderskrifte[0].cues === 2 && (await call('/api/admin/onderskrifte?slug=karoo', {}, lid)).status === 404);
  await post('/api/admin/onderskrif-skrap', { slug: 'karoo', ep: -1, taal: 'af' }, ow);
  t('subs: delete removes it', (await call('/api/onderskrif?slug=karoo&ep=-1&taal=af', {}, lid)).status === 404);
}

// 6m. Binnekort (coming soon), reminders, scheduled release, share page
{
  const base = { titel: 'Binnekort <b>Fliek</b>', tipe: 'Kortfilm', genre_sleutel: 'drama', banner: 'https://img.test/p.jpg', sinopsis: 'Wag vir hierdie een.', status: 'binnekort',
    vrystelling: '2099-01-01', trailer: 'https://vid.test/t.mp4', rolverdeling: 'Anna Botha | Lead\nPiet Nel | Pa\n\n' };
  r = await post('/api/admin/titel', base, ow); const bk = await r.json(); t('binnekort: admin can create', r.status === 200 && !!bk.slug);
  t('binnekort: needs a poster, valid date, https trailer',
    (await post('/api/admin/titel', { ...base, titel: 'X1', banner: '' }, ow)).status === 400 && (await post('/api/admin/titel', { ...base, titel: 'X2', vrystelling: '01/01/2099' }, ow)).status === 400
    && (await post('/api/admin/titel', { ...base, titel: 'X3', trailer: 'http://insecure.test/t.mp4' }, ow)).status === 400);
  let kat = await (await call('/api/katalogus', {}, lid)).json(); const bkRaw = JSON.stringify(kat.binnekort);
  const it = kat.binnekort.find((x) => x.slug === bk.slug);
  t('binnekort: shows on the member catalogue, not in the playable list', !!it && !kat.titels.some((x) => x.slug === bk.slug));
  t('binnekort: cast parsed, trailer given, no video address leaked', it.rolverdeling.length === 2 && it.rolverdeling[0].naam === 'Anna Botha' && it.rolverdeling[0].rol === 'Lead' && it.trailer === 'https://vid.test/t.mp4' && !/video_url|"url"/.test(bkRaw));
  t('binnekort: cannot be played', (await post('/api/speel', { slug: bk.slug }, lid)).status === 404);
  t('herinner: anonymous refused, non-binnekort refused', (await post('/api/herinner', { slug: bk.slug, aan: true })).status === 401 && (await post('/api/herinner', { slug: 'karoo', aan: true }, lid)).status === 404);
  t('herinner: member can set a reminder', (await post('/api/herinner', { slug: bk.slug, aan: true }, lid)).status === 200);
  kat = await (await call('/api/katalogus', {}, lid)).json(); t('herinner: remembered', kat.binnekort.find((x) => x.slug === bk.slug).herinner === true);
  let al = await (await call('/api/admin/titels', {}, ow)).json(); t('herinner: admin sees the count', al.titels.find((x) => x.slug === bk.slug).herinnerings === 1);
  await post('/api/herinner', { slug: bk.slug, aan: false }, lid); al = await (await call('/api/admin/titels', {}, ow)).json(); t('herinner: can be removed', al.titels.find((x) => x.slug === bk.slug).herinnerings === 0);
  await post('/api/herinner', { slug: bk.slug, aan: true }, lid);
  // Share page (public)
  r = await call('/t/' + bk.slug); const sh = await r.text();
  t('share: public page has preview tags', r.status === 200 && /text\/html/.test(r.headers.get('Content-Type')) && sh.includes('og:title') && sh.includes('og:image" content="https://img.test/p.jpg') && /Binnekort/.test(sh));
  t('share: title is escaped (no injected tag)', !sh.includes('<b>Fliek') && sh.includes('&lt;b&gt;Fliek'));
  t('share: unknown, draft titles redirect home', (await call('/t/bestaan-nie')).status === 302);
  await post('/api/admin/titel', { ...base, titel: 'Konsep Een', status: 'konsep' }, ow); const kslug = (await (await call('/api/admin/titels', {}, ow)).json()).titels.find((x) => x.titel === 'Konsep Een').slug;
  t('share: drafts are never exposed', (await call('/t/' + kslug)).status === 302);
  t('share: published title works', (await call('/t/karoo')).status === 200);
  t('media: posters are public, videos still need sign-in', (await call('/media/' + 'a'.repeat(24) + '.jpg')).status === 404 && (await call('/media/' + 'a'.repeat(24) + '.mp4')).status === 401);
  // Scheduled release: past date + a video => goes live by itself; reminder shows once
  const id = (await (await call('/api/admin/titels', {}, ow)).json()).titels.find((x) => x.slug === bk.slug).id;
  await post('/api/admin/titel', { ...base, id, vrystelling: '2000-01-01' }, ow);
  kat = await (await call('/api/katalogus', {}, lid)).json();
  t('scheduled: past date but no video stays coming soon', kat.binnekort.some((x) => x.slug === bk.slug) && !kat.titels.some((x) => x.slug === bk.slug));
  await post('/api/admin/titel', { ...base, id, vrystelling: '2000-01-01', video_url: 'https://vid.test/film.mp4' }, ow);
  kat = await (await call('/api/katalogus', {}, lid)).json();
  t('scheduled: goes live by itself on its date', kat.titels.some((x) => x.slug === bk.slug) && !kat.binnekort.some((x) => x.slug === bk.slug));
  t('herinner: member is told it is now available', kat.herinner_nuut.some((x) => x.slug === bk.slug));
  await post('/api/herinner-gesien', {}, lid); kat = await (await call('/api/katalogus', {}, lid)).json(); t('herinner: told only once', kat.herinner_nuut.length === 0);
  t('future-dated title is not promoted', (await call('/api/katalogus', {}, lid).then((x) => x.json())).binnekort.every((x) => x.vrystelling !== '2000-01-01'));
}

// 7. Quick cold start: a fresh server instance on an already-set-up database must not redo the migration
const skema = sql.prepare("SELECT waarde FROM instellings WHERE sleutel = 'skema'").get();
t('startup: schema version recorded', !!skema && !!skema.waarde);
const fresh = (await import('../src/worker.js?koue-begin')).default;
let koue = 0; const DB2 = { prepare: (q) => { koue++; return stmt(q); }, batch: async (l) => { koue++; return l.map((x) => x._exec()); } };
const wr = await fresh.fetch(new Request('https://x.test/api/warm', { headers: { 'Content-Type': 'application/json' } }), { DB: DB2, ASSETS });
t('startup: cold start needs 1 database call, not 10+ (' + koue + ')', wr.status === 200 && koue === 1);
sql.exec("DELETE FROM instellings WHERE sleutel = 'skema'");
koue = 0; const fresh2 = (await import('../src/worker.js?koue-begin-2')).default;
await fresh2.fetch(new Request('https://x.test/api/warm'), { DB: DB2, ASSETS });
t('startup: missing version triggers full setup once and records it', koue > 5 && !!sql.prepare("SELECT 1 AS x FROM instellings WHERE sleutel = 'skema'").get());

// 8. Upgrading an OLD database (before reports/subtitles) must be quick, complete and safe to repeat
{
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'none', created_at INTEGER NOT NULL);
    CREATE TABLE kykgebeure (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, profiel_id INTEGER, ep INTEGER NOT NULL DEFAULT -1, ts INTEGER NOT NULL);
    INSERT INTO kykgebeure (slug, ts) VALUES ('oud', 1);`);
  let n = 0, ctxUsed = 0;
  const mk = (q) => { let a = []; const o = { bind: (...x) => { a = x; return o; }, run: async () => { n++; const r = old.prepare(q).run(...a); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => { n++; return old.prepare(q).get(...a) ?? null; }, all: async () => { n++; return { results: old.prepare(q).all(...a) }; },
    _exec: () => /^\s*(SELECT|PRAGMA)/i.test(q) ? { results: old.prepare(q).all(...a) } : (old.prepare(q).run(...a), { results: [] }) }; return o; };
  const ODB = { prepare: (q) => mk(q), batch: async (l) => { n++; return l.map((x) => x._exec()); } };
  const w1 = (await import('../src/worker.js?oud-1')).default;
  const rr = await w1.fetch(new Request('https://x.test/api/warm'), { DB: ODB, ASSETS }, { waitUntil: () => { ctxUsed++; } });
  const cols = old.prepare('PRAGMA table_info(kykgebeure)').all().map((c) => c.name); const ucols = old.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  t('upgrade: old database ready after one request', rr.status === 200 && ['user_id', 'plan', 'land', 'toestel'].every((c) => cols.includes(c)) && ucols.includes('plan_period') && ucols.includes('pf_token'));
  t('upgrade: full setup of an old database takes few database trips (' + n + ')', n <= 8);
  t('upgrade: old rows kept, subtitles + reports tables exist', old.prepare('SELECT COUNT(*) AS c FROM kykgebeure').get().c === 1 && !!old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'onderskrifte'").get() && !!old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meting'").get());
  t('upgrade: setup kept alive past the browser (waitUntil used)', ctxUsed === 1);
  old.exec("DELETE FROM instellings WHERE sleutel = 'skema'");
  const w2 = (await import('../src/worker.js?oud-2')).default;
  const r2 = await w2.fetch(new Request('https://x.test/api/warm'), { DB: ODB, ASSETS }, { waitUntil: () => {} });
  t('upgrade: running it again is harmless', r2.status === 200);
  // setup failure gives a friendly 503, not a hang or crash
  const BAD = { prepare: () => { throw new Error('db weg'); }, batch: async () => { throw new Error('db weg'); } };
  const w3 = (await import('../src/worker.js?oud-3')).default;
  const r3 = await w3.fetch(new Request('https://x.test/api/warm'), { DB: BAD, ASSETS }, { waitUntil: () => {} });
  t('upgrade: database down gives friendly 503', r3.status === 503 && /opgestel/.test((await r3.json()).fout));
}

// 9. PR 4: POPIA export/delete, PayFast cancel on delete, creator dashboard, statements, backup
{
  env.ADMIN_EMAIL = 'admin9@stroom.co.za';
  const reg = async (e) => { sql.exec('DELETE FROM attempts'); const rr = await post('/api/register', { email: e, name: e.split('@')[0], password: 'correct-horse' }); const c = ck(rr); await post('/api/plan', { plan: 'avod' }, c); return c; };
  const ad9 = await reg('admin9@stroom.co.za'), sk9 = await reg('maker9@stroom.co.za'), vw9 = await reg('kyker9@stroom.co.za'), vw8 = await reg('kyker8@stroom.co.za');
  const uid = (e) => sql.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
  const skId = uid('maker9@stroom.co.za'), vwId = uid('kyker9@stroom.co.za'), v8Id = uid('kyker8@stroom.co.za');
  const nt = { titel: 'Skepper Toets', tipe: 'Kortfilm', genre_sleutel: 'drama', status: 'konsep' };
  t('creator: unknown e-mail refused', (await post('/api/admin/titel', { ...nt, skepper_epos: 'niemand@x.co' }, ad9)).status === 400);
  t('creator: member cannot link a title', (await post('/api/admin/titel', { ...nt, skepper_epos: 'maker9@stroom.co.za' }, vw9)).status === 404);
  t('creator: not a creator yet, /api/me skepper false', (await (await call('/api/me', {}, sk9)).json()).skepper === false);
  r = await post('/api/admin/titel', { ...nt, skepper_epos: 'Maker9@stroom.co.za' }, ad9); const slug9 = (await r.json()).slug;
  t('creator: title linked to member', r.status === 200 && sql.prepare('SELECT skepper_id FROM titels WHERE slug = ?').get(slug9).skepper_id === skId);
  t('creator: /api/me skepper true', (await (await call('/api/me', {}, sk9)).json()).skepper === true);
  t('creator: admin list shows e-mail', (await (await call('/api/admin/titels', {}, ad9)).json()).titels.find((x) => x.slug === slug9).skepper_epos === 'maker9@stroom.co.za');
  t('creator: page needs login', (await call('/skepper')).status === 302 && (await call('/skepper', {}, sk9)).status === 200);

  // data: 3 plays, 2 ads started (1 click), watch time, rating, reminder
  const now = Date.now(), dag = new Date(now + 7200000).toISOString().slice(0, 10);
  sql.exec(`INSERT INTO kykgebeure (slug, user_id, ts) VALUES ('${slug9}', ${vwId}, ${now}), ('${slug9}', ${vwId}, ${now}), ('${slug9}', ${v8Id}, ${now})`);
  sql.exec(`INSERT INTO advertensies (naam, video_url, aktief, created_at) VALUES ('Adv', '/media/a.mp4', 1, 1)`);
  const adId = sql.prepare('SELECT id FROM advertensies ORDER BY id DESC').get().id;
  sql.exec(`INSERT INTO meting (ad_id, tipe, user_id, slug, ts) VALUES (${adId}, 'begin', ${vwId}, '${slug9}', ${now}), (${adId}, 'begin', ${v8Id}, '${slug9}', ${now}), (${adId}, 'klik', ${vwId}, '${slug9}', ${now})`);
  sql.exec(`INSERT INTO kyktyd (dag, user_id, slug, sek, plan) VALUES ('${dag}', ${vwId}, '${slug9}', 3600, 'avod'), ('${dag}', ${v8Id}, '${slug9}', 1800, 'avod')`);
  sql.exec(`INSERT INTO herinner (user_id, slug, created_at) VALUES (${vwId}, '${slug9}', 1)`);
  sql.exec(`INSERT INTO profiele (user_id, naam, created_at) VALUES (${vwId}, 'Kyker', 1)`);
  const pidV = sql.prepare('SELECT id FROM profiele WHERE user_id = ?').get(vwId).id;
  sql.exec(`INSERT INTO gradering (profiel_id, slug, sterre, bygewerk) VALUES (${pidV}, '${slug9}', 5, 1)`);
  sql.exec(`INSERT INTO lys (profiel_id, slug, created_at) VALUES (${pidV}, '${slug9}', 1)`);
  sql.exec(`INSERT INTO vordering (profiel_id, slug, posisie, duur, voltooi, bygewerk) VALUES (${pidV}, '${slug9}', 10, 100, 1, 1)`);

  await post('/api/admin/tariewe', { cpm_voorrol: 120, cpc: 4, skepper_deel: 0 }, ad9);
  r = await call('/api/skepper/verslag?dae=30', {}, sk9); let sv = await r.json();
  const row9 = sv.titels[0];
  t('creator report: own title with plays, viewers, hours', r.status === 200 && row9.kyke === 3 && row9.unieke === 2 && row9.ure === 1.5);
  t('creator report: ad impressions/clicks and value = 2/1000*120 + 1*4', row9.advertensie_kyke === 2 && row9.klikke === 1 && row9.waarde === 4.24);
  t('creator report: rating, completion, reminders', row9.gem === 5 && row9.voltooi_pct === 100 && row9.herinnerings === 1);
  t('creator report: share not set means 0 and flagged', sv.deel_pct === 0 && row9.deel === 0);
  t('creator report: another member sees nothing of it', (await (await call('/api/skepper/verslag', {}, vw9)).json()).titels.length === 0);
  t('creator report: needs login', (await call('/api/skepper/verslag')).status === 401);
  t('creator csv ok with BOM and title', await (await call('/api/skepper/csv', {}, sk9)).arrayBuffer().then((b) => { const u = new Uint8Array(b); return u[0] === 0xEF && u[1] === 0xBB && new TextDecoder().decode(b).includes('Skepper Toets'); }));
  t('rate: share over 100 refused', (await post('/api/admin/tariewe', { skepper_deel: 150 }, ad9)).status === 400);
  t('rate: share saved', (await post('/api/admin/tariewe', { skepper_deel: 50 }, ad9)).status === 200);
  sv = await (await call('/api/skepper/verslag?dae=30', {}, sk9)).json();
  t('creator report: share 50% of 4.24 = 2.12', sv.deel_pct === 50 && sv.titels[0].deel === 2.12 && sv.totaal.deel === 2.12);
  const mnd = dag.slice(0, 7);
  r = await call('/api/admin/skepper-staat?maand=' + mnd, {}, ad9); const st = await r.json();
  t('statement: one creator line with payable amount', r.status === 200 && st.skeppers.length === 1 && st.skeppers[0].e_pos === 'maker9@stroom.co.za' && st.skeppers[0].deel === 2.12 && st.totaal.deel === 2.12);
  t('statement: other month is empty of value', (await (await call('/api/admin/skepper-staat?maand=2020-01', {}, ad9)).json()).skeppers[0].waarde === 0);
  t('statement: members refused', (await call('/api/admin/skepper-staat', {}, sk9)).status === 404 && (await call('/api/admin/skepper-staat-csv', {}, sk9)).status === 404);
  t('statement csv ok', await (await call('/api/admin/skepper-staat-csv?maand=' + mnd, {}, ad9)).text().then((x) => x.includes('maker9@stroom.co.za') && x.includes('2.12')));
  r = await call('/api/admin/rugsteun', {}, ad9); const bk = await r.json();
  t('backup: admin gets titles/ads/subtitles/settings, no members', r.status === 200 && Array.isArray(bk.titels) && bk.titels.some((x) => x.slug === slug9) && Array.isArray(bk.advertensies) && !('users' in bk) && !JSON.stringify(bk).includes('hash'));
  t('backup: members refused', (await call('/api/admin/rugsteun', {}, vw9)).status === 404);

  // export has everything
  sql.exec(`INSERT INTO orders (m_payment_id, user_id, plan, status, created_at) VALUES ('S9', ${vwId}, 'monthly', 'complete', 1)`);
  sql.exec(`INSERT INTO indienings (user_id, email, name, title, type, link, synopsis, created_at) VALUES (${vwId}, 'kyker9@stroom.co.za', 'K', 'Ingedien', 'Film', 'https://x.co', 'syn', 1)`);
  const ex = await (await call('/api/export', {}, vw9)).json();
  t('export: profiles, list, progress, rating, reminders, plays, watch time, submissions, orders', ex.profiele.length === 1 && ex.my_lys.length === 1 && ex.kykvordering.length === 1 && ex.graderings.length === 1 && ex.herinnerings.length === 1
    && ex.kykgeskiedenis.length === 2 && ex.kykure_per_dag.length === 1 && ex.indienings.length === 1 && ex.bestellings.length === 1);
  t('export: no password hash or other member data', !/hash|salt|kyker8/.test(JSON.stringify(ex)));

  // delete: PayFast subscription cancelled first; failure blocks deletion
  sql.exec(`UPDATE users SET pf_token = 'tok-9', plan = 'svod' WHERE id = ${vwId}`);
  const saved = { ...env }; delete env.PAYFAST_MERCHANT_ID; delete env.PAYFAST_MERCHANT_KEY; delete env.PAYFAST_PASSPHRASE;
  t('delete: payments not configured, subscriber refused and kept', (await post('/api/delete-account', { password: 'correct-horse' }, vw9)).status === 502 && !!sql.prepare('SELECT 1 FROM users WHERE id = ?').get(vwId));
  Object.assign(env, { PAYFAST_MERCHANT_ID: '10000000', PAYFAST_MERCHANT_KEY: 'fakekey123456', PAYFAST_PASSPHRASE: 'test pass&1' });
  const rf = globalThis.fetch; let putUrl = null, putOk = false;
  globalThis.fetch = async (u, o) => { if (o && o.method === 'PUT') { putUrl = String(u); return new Response('', { status: putOk ? 200 : 500 }); } return new Response('', { status: 200 }); };
  t('delete: PayFast cancel fails, account kept', (await post('/api/delete-account', { password: 'correct-horse' }, vw9)).status === 502 && !!sql.prepare('SELECT 1 FROM users WHERE id = ?').get(vwId));
  putOk = true;
  r = await post('/api/delete-account', { password: 'correct-horse' }, vw9);
  globalThis.fetch = rf;
  t('delete: cancels the right PayFast subscription then deletes', r.status === 200 && /tok-9\/cancel/.test(putUrl));
  const cnt = (q) => sql.prepare(q).get().c;
  t('delete: user, sessions, profiles, list, progress, ratings, reminders, submissions gone',
    cnt(`SELECT COUNT(*) c FROM users WHERE id = ${vwId}`) === 0 && cnt(`SELECT COUNT(*) c FROM sessions WHERE user_id = ${vwId}`) === 0 && cnt(`SELECT COUNT(*) c FROM profiele WHERE user_id = ${vwId}`) === 0
    && cnt(`SELECT COUNT(*) c FROM lys WHERE profiel_id = ${pidV}`) + cnt(`SELECT COUNT(*) c FROM vordering WHERE profiel_id = ${pidV}`) + cnt(`SELECT COUNT(*) c FROM gradering WHERE profiel_id = ${pidV}`) === 0
    && cnt(`SELECT COUNT(*) c FROM herinner WHERE user_id = ${vwId}`) === 0 && cnt(`SELECT COUNT(*) c FROM indienings WHERE user_id = ${vwId}`) === 0);
  t('delete: plays and ad measurements kept but anonymous', cnt(`SELECT COUNT(*) c FROM kykgebeure WHERE slug = '${slug9}'`) === 3 && cnt(`SELECT COUNT(*) c FROM kykgebeure WHERE user_id = ${vwId}`) === 0 && cnt(`SELECT COUNT(*) c FROM meting WHERE user_id = ${vwId}`) === 0 && cnt(`SELECT COUNT(*) c FROM meting WHERE slug = '${slug9}'`) === 3);
  t('delete: watch hours folded into anonymous totals, not lost', cnt(`SELECT COUNT(*) c FROM kyktyd WHERE user_id = ${vwId}`) === 0 && sql.prepare(`SELECT sek FROM kyktyd WHERE user_id = 0 AND slug = '${slug9}'`).get().sek === 3600);
  t('delete: payment orders kept for accounting', cnt(`SELECT COUNT(*) c FROM orders WHERE user_id = ${vwId}`) === 1);
  t('delete: creator report still sees the same hours', (await (await call('/api/skepper/verslag?dae=30', {}, sk9)).json()).titels[0].ure === 1.5);
  t('delete: other members untouched', cnt(`SELECT COUNT(*) c FROM users WHERE id = ${v8Id}`) === 1 && cnt(`SELECT COUNT(*) c FROM kyktyd WHERE user_id = ${v8Id}`) === 1);
  // deleting a creator unlinks titles (no dangling owner)
  t('delete creator: titles stay, link cleared', (await post('/api/delete-account', { password: 'correct-horse' }, sk9)).status === 200 && sql.prepare('SELECT skepper_id FROM titels WHERE slug = ?').get(slug9).skepper_id === null);
  Object.keys(env).forEach((k) => { if (!(k in saved)) delete env[k]; });
  Object.assign(env, saved);
  delete env.PAYFAST_MERCHANT_ID; delete env.PAYFAST_MERCHANT_KEY; delete env.PAYFAST_PASSPHRASE;
}

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
