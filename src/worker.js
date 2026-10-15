// Stroom: bediener-kant toegangsbeheer.
// Beskermde bladsye word slegs bedien as die besoeker 'n geldige sessie het.
// Rekeninge en sessies leef in D1 (env.DB). Sonder DB word beskermde bladsye geweier.

import { config, buildCheckout, processItn, cancelSubscription, PLANS } from './payfast.js';

const PUBLIC_PAGES = new Set(['index', 'teken-in', 'privaatheid', 'waglys']);
const NEEDS_SESSION = new Set(['kies-plan', 'rekening', 'skep']);
const NEEDS_PLAN = new Set(['profiel', 'katalogus', 'joernaal', 'oor-ons']);
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

let ready;
function init(db) {
  ready ||= (async () => {
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
    ]);
    // Nuwe kolomme vir bestaande databasisse (fout as dit reeds bestaan word geïgnoreer)
    for (const q of ['ALTER TABLE users ADD COLUMN plan_period TEXT', 'ALTER TABLE users ADD COLUMN pf_token TEXT']) {
      try { await db.prepare(q).run(); } catch { /* bestaan reeds */ }
    }
  })();
  return ready;
}

function cookieValue(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function getUser(request, db) {
  const token = cookieValue(request, 'stroom_sessie');
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.email, u.name, u.plan, u.plan_period, u.pf_token FROM sessions s JOIN users u ON u.id = s.user_id
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

async function tooManyAttempts(db, key) {
  const since = Date.now() - 15 * 60 * 1000;
  await db.prepare('DELETE FROM attempts WHERE at < ?').bind(since).run();
  const r = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ?').bind(key).first();
  return r.n >= 10;
}
const noteAttempt = (db, key) => db.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').bind(key, Date.now()).run();

async function api(request, env, url) {
  if (!env.DB) return json({ fout: 'Dienste is tydelik nie beskikbaar nie.' }, 503);
  await init(env.DB);
  const path = url.pathname;
  const post = request.method === 'POST';
  // Slegs eie webwerf mag POST (beskerm teen kruis-werf-versoeke)
  if (post && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
    return json({ fout: 'Ongeldige versoek.' }, 403);

  if (path === '/api/me') {
    const u = await getUser(request, env.DB);
    return u ? json({ email: u.email, name: u.name, plan: u.plan, plan_period: u.plan_period || null }) : json({ fout: 'Nie ingeteken nie.' }, 401);
  }
  if (path === '/api/export') {
    const u = await getUser(request, env.DB);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const full = await env.DB.prepare('SELECT email, name, plan, created_at FROM users WHERE id = ?').bind(u.id).first();
    return json({ rekening: { e_pos: full.email, naam: full.name, plan: full.plan, aangesluit: new Date(full.created_at).toISOString() },
                  uitgevoer_op: new Date().toISOString() }, 200,
      { 'Content-Disposition': 'attachment; filename="my-stroom-data.json"' });
  }
  if (path === '/api/status') return json({ bou: 'betalings-1', betalings_gereed: !!config(env), db: true });
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
    if (await tooManyAttempts(env.DB, key)) return json({ fout: 'Te veel pogings. Probeer oor 15 minute weer.' }, 429);
    const u = await env.DB.prepare('SELECT id, name, salt, hash FROM users WHERE email = ?').bind(email).first();
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
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'stroom_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  return json({ fout: 'Nie gevind nie.' }, 404);
}

async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);

    // Bladsy-naam: /katalogus.html en /katalogus -> "katalogus"; / -> "index"
    let page = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.html$/, '');
    if (page === '') page = 'index';

    const protectedPage = NEEDS_SESSION.has(page) || NEEDS_PLAN.has(page);
    const isHtml = !page.includes('.') ;
    if (isHtml && !PUBLIC_PAGES.has(page) && !protectedPage) return env.ASSETS.fetch(request); // 404 deur Cloudflare

    if (!protectedPage) return env.ASSETS.fetch(request);

    const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
    if (!env.DB) return redirect('/teken-in.html?mode=login');
    await init(env.DB);
    const user = await getUser(request, env.DB);
    if (!user) return redirect('/teken-in.html?mode=login');
    if (NEEDS_PLAN.has(page) && user.plan === 'none') return redirect('/kies-plan.html');

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'private, no-store');
    return out;
}

// Veiligheidskoppe op elke antwoord
export default {
  async fetch(request, env) {
    const res = await handle(request, env);
    const out = new Response(res.body, res);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('X-Frame-Options', 'DENY');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return out;
  },
};
