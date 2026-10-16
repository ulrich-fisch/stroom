// Toets die toegangsslot teen 'n plaaslike databasis. Gebruik: node --experimental-sqlite tools/test-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
const sql = new DatabaseSync(':memory:');
const stmt = (q) => { let args = []; const o = {
  bind: (...a) => { args = a; return o; },
  run: async () => { const r = sql.prepare(q).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
  first: async () => sql.prepare(q).get(...args) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...args) }),
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

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
