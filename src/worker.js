// Stroom: bediener-kant toegangsbeheer.
// Beskermde bladsye word slegs bedien as die besoeker 'n geldige sessie het.
// Rekeninge en sessies leef in D1 (env.DB). Sonder DB word beskermde bladsye geweier.

import { handleContent, contentStatements, seedContent, adminOk, serveMedia, SERIE_COLUMNS } from './inhoud.js';
import { handleMember, memberStatements, isMemberPath } from './lede.js';
import { handleReports, reportStatements, REPORT_COLUMNS, isReportPath } from './verslae.js';
import { handleSubtitles, subtitleStatements, isSubtitlePath } from './onderskrifte.js';
import { handleBinnekort, herinnerStatements, TITEL_COLUMNS, isBinnekortPath, sharePage } from './binnekort.js';
import { handleVlakke, AD_COLUMNS } from './vlakke.js';
import { handleAdmins, ADMIN_COLUMNS, eienaar } from './admin.js';
import { handleDokumente, isDokumentPath, LISENSIE_COLUMNS, dokumenteStatements } from './lisensie.js';
import { handleSkeppers, isSkepperPath, SKEPPER_COLUMNS, isSkepper } from './skeppers.js';
import { md5, config, buildCheckout, processItn, cancelSubscription, PLANS } from './payfast.js';

const PUBLIC_PAGES = new Set(['index', 'teken-in', 'privaatheid', 'waglys', 'offline']);
const NEEDS_SESSION = new Set(['kies-plan', 'rekening', 'skep', 'skepper']);
const NEEDS_PLAN = new Set(['profiel', 'katalogus', 'joernaal', 'oor-ons']);
const NEEDS_ADMIN = new Set(['admin', 'verslae']);
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: hex(salt), hash: hex(bits) };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Skemaweergawe: verhoog hierdie waarde elke keer as enige CREATE/ALTER in die kode verander.
// Die bediener onthou in die databasis watter weergawe reeds gedoen is, sodat 'n koue begin
// net EEN vinnige navraag kos. Die volle opstelling is ook vinnig (4-5 ritte) en kan veilig herhaal word.
const SCHEMA = '2026-10-20g';

const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tydsverloop')), ms); })]).finally(() => clearTimeout(t)); };

let ready;
function init(db, ctx) {
  if (!ready) {
    const p = (async () => {
      try {
        const v = await db.prepare("SELECT waarde FROM instellings WHERE sleutel = 'skema'").first();
        if (v && v.waarde === SCHEMA) return;
      } catch { /* tabel bestaan nog nie: doen die volle opstelling */ }
      await migrate(db);
      await db.prepare("INSERT OR REPLACE INTO instellings (sleutel, waarde) VALUES ('skema', ?)").bind(SCHEMA).run();
    })();
    ready = p.catch((e) => { ready = null; throw e; });
    // Laat die opstelling klaarmaak, selfs al verbreek die blaaier die verbinding (anders hang volgende versoeke)
    if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
  }
  return withTimeout(ready, 25000).catch((e) => { if (e && e.message === 'tydsverloop') ready = null; throw e; });
}

// Voeg kolomme by wat ontbreek: een navraag om te kyk, een om by te voeg
async function addColumns(db, cols) {
  const tables = [...new Set(cols.map((c) => c[0]))];
  let have = null;
  try {
    const res = await db.batch(tables.map((t) => db.prepare(`PRAGMA table_info(${t})`)));
    have = new Set(); res.forEach((r, i) => (r.results || []).forEach((row) => have.add(tables[i] + '.' + row.name)));
  } catch { have = null; }
  const todo = have ? cols.filter(([t, c]) => !have.has(t + '.' + c)) : cols;
  if (!todo.length) return;
  const alter = ([t, c, ty]) => db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`);
  if (have) { try { await db.batch(todo.map(alter)); return; } catch { /* een-een hieronder */ } }
  for (const col of todo) { try { await alter(col).run(); } catch { /* bestaan reeds */ } }
}

async function migrate(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT,
      salt TEXT NOT NULL, hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'none',
      created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS attempts (
      key TEXT NOT NULL, at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      m_payment_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS indienings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
      title TEXT NOT NULL, type TEXT NOT NULL, link TEXT NOT NULL, synopsis TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'hangende', created_at INTEGER NOT NULL)`),
    ...contentStatements(db), ...memberStatements(db), ...reportStatements(db), ...subtitleStatements(db), ...herinnerStatements(db), ...dokumenteStatements(db),
  ]);
  await addColumns(db, [['users', 'plan_period', 'TEXT'], ['users', 'pf_token', 'TEXT'], ...REPORT_COLUMNS, ...TITEL_COLUMNS, ...SKEPPER_COLUMNS, ...SERIE_COLUMNS, ...LISENSIE_COLUMNS, ...ADMIN_COLUMNS, ...AD_COLUMNS]);
  await seedContent(db);
}

function cookieValue(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function getUser(request, db) {
  const token = cookieValue(request, 'stroom_sessie');
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.email, u.name, u.plan, u.plan_period, u.pf_token, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(token), Date.now()).first();
  return row || null;
}

async function startSession(db, userId, remember) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const maxAge = SESSION_DAYS * 86400;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + maxAge * 1000).run();
  return `stroom_sessie=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` + (remember ? `; Max-Age=${maxAge}` : '');
}

async function tooManyAttemptsN(db, key, max, windowMs) {
  await db.prepare('DELETE FROM attempts WHERE at < ?').bind(Date.now() - 24 * 3600 * 1000).run();
  const r = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at >= ?').bind(key, Date.now() - windowMs).first();
  return r.n >= max;
}
const tooManyAttempts = (db, key) => tooManyAttemptsN(db, key, 10, 15 * 60 * 1000);
const noteAttempt = (db, key) => db.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').bind(key, Date.now()).run();

async function api(request, env, url, ctx) {
  if (!env.DB) return json({ fout: 'Dienste is tydelik nie beskikbaar nie.' }, 503);
  try { await init(env.DB, ctx); } catch {
    return json({ fout: "Die bediener word besig opgestel. Probeer oor 'n oomblik weer." }, 503, { 'Retry-After': '3' });
  }
  const path = url.pathname;
  const post = request.method === 'POST';
  // Slegs eie webwerf mag POST (beskerm teen kruis-werf-versoeke)
  if (post && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
    return json({ fout: 'Ongeldige versoek.' }, 403);

  if (path === '/api/warm') return json({ ok: true });

  if (path === '/api/me') {
    const u = await getUser(request, env.DB);
    return u ? json({ email: u.email, name: u.name, plan: u.plan, plan_period: u.plan_period || null, admin: adminOk(u, env), eienaar: eienaar(u, env), skepper: await isSkepper(env.DB, u.id) }) : json({ fout: 'Nie ingeteken nie.' }, 401);
  }
  if (path === '/api/export') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const db = env.DB, id = u.id;
    const full = await db.prepare('SELECT email, name, plan, plan_period, created_at FROM users WHERE id = ?').bind(id).first();
    const all = async (sql) => (await db.prepare(sql).bind(id).all()).results;
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const profiele = await all('SELECT id, naam, avatar, kinders, created_at FROM profiele WHERE user_id = ? ORDER BY id');
    const pids = 'SELECT id FROM profiele WHERE user_id = ?';
    return json({
      rekening: { e_pos: full.email, naam: full.name, plan: full.plan, tydperk: full.plan_period || null, aangesluit: iso(full.created_at) },
      profiele: profiele.map((p) => ({ naam: p.naam, avatar: p.avatar, kinderprofiel: !!p.kinders, geskep: iso(p.created_at) })),
      my_lys: (await all(`SELECT p.naam AS profiel, l.slug, l.created_at FROM lys l JOIN profiele p ON p.id = l.profiel_id WHERE l.profiel_id IN (${pids}) ORDER BY l.created_at`)).map((r) => ({ profiel: r.profiel, titel: r.slug, bygevoeg: iso(r.created_at) })),
      kykvordering: (await all(`SELECT p.naam AS profiel, v.slug, v.ep, v.posisie, v.duur, v.voltooi, v.bygewerk FROM vordering v JOIN profiele p ON p.id = v.profiel_id WHERE v.profiel_id IN (${pids})`)).map((r) => ({ profiel: r.profiel, titel: r.slug, episode: r.ep, sekondes: Math.round(r.posisie), voltooi: !!r.voltooi, bygewerk: iso(r.bygewerk) })),
      graderings: (await all(`SELECT p.naam AS profiel, g.slug, g.sterre, g.bygewerk FROM gradering g JOIN profiele p ON p.id = g.profiel_id WHERE g.profiel_id IN (${pids})`)).map((r) => ({ profiel: r.profiel, titel: r.slug, sterre: r.sterre, bygewerk: iso(r.bygewerk) })),
      reaksies: (await all(`SELECT p.naam AS profiel, x.slug, x.waarde FROM reaksie x JOIN profiele p ON p.id = x.profiel_id WHERE x.profiel_id IN (${pids})`)).map((r) => ({ profiel: r.profiel, titel: r.slug, duim: r.waarde === 1 ? 'op' : 'af' })),
      herinnerings: (await all('SELECT slug, created_at FROM herinner WHERE user_id = ?')).map((r) => ({ titel: r.slug, gestel: iso(r.created_at) })),
      kykgeskiedenis: (await all('SELECT slug, ep, ts FROM kykgebeure WHERE user_id = ? ORDER BY ts DESC LIMIT 5000')).map((r) => ({ titel: r.slug, episode: r.ep, tyd: iso(r.ts) })),
      kykure_per_dag: (await all('SELECT dag, slug, sek FROM kyktyd WHERE user_id = ? ORDER BY dag DESC LIMIT 5000')).map((r) => ({ dag: r.dag, titel: r.slug, sekondes: r.sek })),
      indienings: (await all('SELECT title, type, link, synopsis, status, created_at FROM indienings WHERE user_id = ? ORDER BY id')).map((r) => ({ titel: r.title, tipe: r.type, skakel: r.link, sinopsis: r.synopsis, status: r.status, ingestuur: iso(r.created_at) })),
      bestellings: (await all('SELECT m_payment_id, plan, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at')).map((r) => ({ verwysing: r.m_payment_id, plan: r.plan, status: r.status, datum: iso(r.created_at) })),
      uitgevoer_op: new Date().toISOString() }, 200,
      { 'Content-Disposition': 'attachment; filename="my-stroom-data.json"' });
  }
  if (path === '/api/skep-admin') {
    // Net die eienaar (ADMIN_EMAIL) sien die inskrywings
    const u = await getUser(request, env.DB);
    if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
    const rows = await env.DB.prepare('SELECT id, name, email, title, type, link, synopsis, status, created_at FROM indienings ORDER BY id DESC LIMIT 200').all();
    return json({ inskrywings: rows.results.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) });
  }
  if (path === '/api/status') {
    const c = config(env);
    // Geen geheime waardes nie: slegs lengtes en 'n kort vingerafdruk om te vergelyk
    const fp = (v) => md5(String(v || '')).slice(0, 6);
    return json({ bou: 'betalings-2', betalings_gereed: !!c, modus: env.PAYFAST_MODE || null, handelaar: c ? c.merchantId : null,
      sleutel_lengte: String(env.PAYFAST_MERCHANT_KEY || '').length, wagfrase_lengte: String(env.PAYFAST_PASSPHRASE || '').length,
      wagfrase_vingerafdruk: fp(env.PAYFAST_PASSPHRASE), sleutel_vingerafdruk: fp(env.PAYFAST_MERCHANT_KEY) });
  }
  {
    const cu = (path === '/api/katalogus' || path === '/api/speel' || path.startsWith('/api/admin/') || isMemberPath(path) || isReportPath(path) || isSubtitlePath(path) || isBinnekortPath(path) || isSkepperPath(path)) ? await getUser(request, env.DB) : null;
    const m = await handleMember({ request, env, path, post, u: cu });
    if (m) return m;
    const r = await handleReports({ request, env, path, post, u: cu });
    if (r) return r;
    const sb = await handleSubtitles({ request, env, path, post, u: cu });
    if (sb) return sb;
    const bk = await handleBinnekort({ request, env, path, post, u: cu });
    if (bk) return bk;
    const sk = await handleSkeppers({ request, env, path, post, u: cu });
    if (sk) return sk;
    const dk = await handleDokumente({ request, env, path, post, u: cu });
    if (dk) return dk;
    const vl = await handleVlakke({ request, env, path, post, u: cu });
    if (vl) return vl;
    const am = await handleAdmins({ request, env, path, post, u: cu });
    if (am) return am;
    const c = await handleContent({ request, env, path, post, u: cu });
    if (c) return c;
  }
  if (!post) return json({ fout: 'Nie gevind nie.' }, 404);

  if (path === '/api/payfast-itn') {
    const cfg = config(env);
    if (!cfg) return new Response('nie opgestel', { status: 503 });
    const r = await processItn({ db: env.DB, cfg, bodyText: await request.text() });
    return new Response(r.note, { status: r.status });
  }

  let body = {};
  try { body = await request.json(); } catch { /* leeg */ }

  if (path === '/api/register') {
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    const password = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ fout: 'Ongeldige e-posadres.' }, 400);
    if (password.length < 8) return json({ fout: 'Wagwoord moet minstens 8 karakters wees.' }, 400);
    const ip = request.headers.get('CF-Connecting-IP') || 'onbekend';
    if (await tooManyAttempts(env.DB, 'reg:' + ip)) return json({ fout: 'Te veel pogings. Probeer later weer.' }, 429);
    await noteAttempt(env.DB, 'reg:' + ip);
    const { salt, hash } = await hashPassword(password);
    try {
      const r = await env.DB.prepare('INSERT INTO users (email, name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(email, name || email.split('@')[0], salt, hash, Date.now()).run();
      const cookie = await startSession(env.DB, r.meta.last_row_id, body.remember !== false);
      return json({ ok: true, name: name || email.split('@')[0] }, 200, { 'Set-Cookie': cookie });
    } catch {
      return json({ fout: 'Hierdie e-posadres is reeds geregistreer. Teken eerder in.' }, 409);
    }
  }

  if (path === '/api/login') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const key = 'login:' + email;
    // Een enkele rit na die databasis: ou pogings opruim, pogings tel, gebruiker soek
    const [, tel, gebr] = await env.DB.batch([
      env.DB.prepare('DELETE FROM attempts WHERE at < ?').bind(Date.now() - 24 * 3600 * 1000),
      env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at >= ?').bind(key, Date.now() - 15 * 60 * 1000),
      env.DB.prepare('SELECT id, name, salt, hash FROM users WHERE email = ?').bind(email),
    ]);
    if ((tel.results[0] || { n: 0 }).n >= 10) return json({ fout: 'Te veel pogings. Probeer oor 15 minute weer.' }, 429);
    const u = gebr.results[0] || null;
    // Selfde werk of die gebruiker bestaan of nie (teen uitvind van rekeninge)
    const { hash } = await hashPassword(password, u ? u.salt : '00'.repeat(16));
    if (!u || !safeEqual(hash, u.hash)) {
      await noteAttempt(env.DB, key);
      return json({ fout: 'E-pos of wagwoord is verkeerd.' }, 401);
    }
    const cookie = await startSession(env.DB, u.id, body.remember !== false);
    return json({ ok: true, name: u.name }, 200, { 'Set-Cookie': cookie });
  }

  if (path === '/api/logout') {
    const token = cookieValue(request, 'stroom_sessie');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'stroom_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  if (path === '/api/plan') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    // Slegs die gratis plan kan self gekies word. Betaalde plan word slegs deur 'n
    // bevestigde betaling (PayFast ITN) gestel; dit is nog nie oop nie.
    if (body.plan !== 'avod') return json({ fout: 'Betalings is nog nie oop nie.' }, 403);
    if (u.plan === 'none') await env.DB.prepare("UPDATE users SET plan = 'avod' WHERE id = ?").bind(u.id).run();
    return json({ ok: true });
  }

  if (path === '/api/skep') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan !== 'svod') return json({ fout: 'Net Premium-lede kan films indien.' }, 403);
    const f = (v, n) => String(v || '').trim().slice(0, n);
    const name = f(body.name, 80), title = f(body.title, 120), link = f(body.link, 300), synopsis = f(body.synopsis, 2000);
    const type = ['Kortfilm', 'Speelfilm', 'Dokumentêr'].includes(body.type) ? body.type : null;
    if (!name || !title || !synopsis || !type) return json({ fout: 'Vul asseblief al die velde in.' }, 400);
    if (!/^https:\/\/[^\s]+$/i.test(link)) return json({ fout: 'Die kykskakel moet met https:// begin.' }, 400);
    if (body.agree !== true) return json({ fout: 'Bevestig asseblief die ooreenkoms.' }, 400);
    const key = 'skep:' + u.id;
    if (await tooManyAttemptsN(env.DB, key, 5, 24 * 3600 * 1000)) return json({ fout: 'Jy het vandag reeds genoeg ingedien. Probeer more weer.' }, 429);
    await noteAttempt(env.DB, key);
    await env.DB.prepare('INSERT INTO indienings (user_id, email, name, title, type, link, synopsis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(u.id, u.email, name, title, type, link, synopsis, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/checkout') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const cfg = config(env);
    if (!cfg) return json({ fout: 'Betalings is nog nie oop nie.' }, 503);
    if (!PLANS[body.plan]) return json({ fout: 'Ongeldige plan.' }, 400);
    if (u.plan === 'svod') return json({ fout: 'Jy het reeds Premium.' }, 409);
    const orderId = 'S' + hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare('INSERT INTO orders (m_payment_id, user_id, plan, created_at) VALUES (?, ?, ?, ?)')
      .bind(orderId, u.id, body.plan, Date.now()).run();
    return json(buildCheckout({ cfg, user: u, orderId, planKey: body.plan, origin: url.origin }));
  }

  if (path === '/api/cancel-subscription') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan !== 'svod' || !u.pf_token) return json({ fout: 'Geen aktiewe intekening gevind nie.' }, 404);
    const cfg = config(env);
    if (!cfg) return json({ fout: 'Betalings is nog nie oop nie.' }, 503);
    if (!(await cancelSubscription(cfg, u.pf_token))) return json({ fout: 'Kon nie nou kanselleer nie. Kontak ons asseblief.' }, 502);
    await env.DB.prepare("UPDATE users SET plan = 'avod', plan_period = NULL, pf_token = NULL WHERE id = ?").bind(u.id).run();
    return json({ ok: true });
  }

  if (path === '/api/password') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const key = 'pw:' + u.id;
    if (await tooManyAttempts(env.DB, key)) return json({ fout: 'Te veel pogings. Probeer oor 15 minute weer.' }, 429);
    const next = String(body.next || '');
    if (next.length < 8) return json({ fout: 'Nuwe wagwoord moet minstens 8 karakters wees.' }, 400);
    const row = await env.DB.prepare('SELECT salt, hash FROM users WHERE id = ?').bind(u.id).first();
    const cur = await hashPassword(String(body.current || ''), row.salt);
    if (!safeEqual(cur.hash, row.hash)) { await noteAttempt(env.DB, key); return json({ fout: 'Huidige wagwoord is verkeerd.' }, 401); }
    const { salt, hash } = await hashPassword(next);
    await env.DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').bind(salt, hash, u.id).run();
    // Alle ander toestelle word afgeteken; hierdie sessie bly.
    const token = cookieValue(request, 'stroom_sessie');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(u.id, await sha256(token)).run();
    return json({ ok: true });
  }

  if (path === '/api/logout-all') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'stroom_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  if (path === '/api/delete-account') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const key = 'del:' + u.id;
    if (await tooManyAttempts(env.DB, key)) return json({ fout: 'Te veel pogings. Probeer oor 15 minute weer.' }, 429);
    const row = await env.DB.prepare('SELECT salt, hash FROM users WHERE id = ?').bind(u.id).first();
    const cur = await hashPassword(String(body.password || ''), row.salt);
    if (!safeEqual(cur.hash, row.hash)) { await noteAttempt(env.DB, key); return json({ fout: 'Wagwoord is verkeerd.' }, 401); }
    // Eers die PayFast-intekening stop, anders bly dit aanhou om geld af te trek
    const sub = await env.DB.prepare('SELECT pf_token FROM users WHERE id = ?').bind(u.id).first();
    if (sub && sub.pf_token) {
      const cfg = config(env);
      if (!cfg || !(await cancelSubscription(cfg, sub.pf_token)))
        return json({ fout: 'Ons kon nie jou betaalde intekening stop nie, so jou rekening is nog nie uitgevee nie. Probeer asseblief weer, of kontak ons.' }, 502);
    }
    const db = env.DB, id = u.id, pids = '(SELECT id FROM profiele WHERE user_id = ?)';
    await db.batch([
      db.prepare(`DELETE FROM lys WHERE profiel_id IN ${pids}`).bind(id),
      db.prepare(`DELETE FROM vordering WHERE profiel_id IN ${pids}`).bind(id),
      db.prepare(`DELETE FROM gradering WHERE profiel_id IN ${pids}`).bind(id),
      db.prepare(`DELETE FROM reaksie WHERE profiel_id IN ${pids}`).bind(id),
      db.prepare('DELETE FROM profiele WHERE user_id = ?').bind(id),
      db.prepare('DELETE FROM herinner WHERE user_id = ?').bind(id),
      // Anonieme totale bly vir verslae: kykure word na 'n anonieme rekord (0) verskuif, kyke en advertensiemetings verloor hul skakel na die lid
      db.prepare(`INSERT INTO kyktyd (dag, user_id, slug, sek, plan) SELECT dag, 0, slug, SUM(sek), MAX(plan) FROM kyktyd WHERE user_id = ? GROUP BY dag, slug
        ON CONFLICT (dag, user_id, slug) DO UPDATE SET sek = sek + excluded.sek`).bind(id),
      db.prepare('DELETE FROM kyktyd WHERE user_id = ?').bind(id),
      db.prepare('UPDATE kykgebeure SET user_id = NULL, profiel_id = NULL WHERE user_id = ?').bind(id),
      db.prepare('UPDATE meting SET user_id = NULL WHERE user_id = ?').bind(id),
      db.prepare('UPDATE titels SET skepper_id = NULL WHERE skepper_id = ?').bind(id),
      db.prepare('DELETE FROM indienings WHERE user_id = ?').bind(id),
      db.prepare('DELETE FROM attempts WHERE key IN (?, ?)').bind('pw:' + id, 'del:' + id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      db.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': 'stroom_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  return json({ fout: 'Nie gevind nie.' }, 404);
}

async function handle(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url, ctx);
    if (url.pathname.startsWith('/media/')) {
      if (!env.DB) return new Response('Dienste is tydelik nie beskikbaar nie.', { status: 503 });
      await init(env.DB, ctx);
      return serveMedia(request, env, await getUser(request, env.DB), url.pathname.slice(7));
    }

    // Openbare deel-bladsy met voorskou (vir WhatsApp ens.)
    if (url.pathname.startsWith('/t/') && request.method === 'GET') {
      if (!env.DB) return new Response('Dienste is tydelik nie beskikbaar nie.', { status: 503 });
      try { await init(env.DB, ctx); } catch { return new Response(null, { status: 302, headers: { Location: '/' } }); }
      return sharePage(request, env);
    }

    // Bladsy-naam: /katalogus.html en /katalogus -> "katalogus"; / -> "index"
    let page = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.html$/, '');
    if (page === '') page = 'index';

    const protectedPage = NEEDS_SESSION.has(page) || NEEDS_PLAN.has(page) || NEEDS_ADMIN.has(page);
    const isHtml = !page.includes('.') ;
    if (isHtml && !PUBLIC_PAGES.has(page) && !protectedPage) return env.ASSETS.fetch(request); // 404 deur Cloudflare

    if (!protectedPage) return env.ASSETS.fetch(request);

    const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
    if (!env.DB) return redirect('/teken-in.html?mode=login');
    await init(env.DB, ctx);
    const user = await getUser(request, env.DB);
    if (!user) return redirect('/teken-in.html?mode=login');
    if (NEEDS_PLAN.has(page) && user.plan === 'none') return redirect('/kies-plan.html');
    if (NEEDS_ADMIN.has(page) && !adminOk(user, env)) return new Response('Nie gevind nie.', { status: 404 });

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'private, no-store');
    return out;
}

// Veiligheidskoppe op elke antwoord
export default {
  async fetch(request, env, ctx) {
    const res = await handle(request, env, ctx);
    const out = new Response(res.body, res);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('X-Frame-Options', 'DENY');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return out;
  },
};
