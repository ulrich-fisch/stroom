// Lid-funksies: profiele (met kinderprofiel), My Lys, kyk-vordering ("Gaan voort") en gradering.
// Alles hang aan 'n profiel; die bediener kyk altyd dat die profiel aan die ingetekende rekening behoort.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
export const MAX_PROFIELE = 5;
export const AVATARE = 8;

// Kinderprofiel: slegs titels met 'n ouderdomsgradering van 10 of laer (of "Almal") word gewys
export function kinderVeilig(ouderdom) {
  const o = String(ouderdom || '').trim();
  if (!o) return false;
  if (/^(al|alle|all|a)$/i.test(o)) return true;
  const n = parseInt(o.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n <= 10;
}

export async function createMemberTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS profiele (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, naam TEXT NOT NULL, avatar INTEGER NOT NULL DEFAULT 0,
      kinders INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS lys (
      profiel_id INTEGER NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (profiel_id, slug))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS vordering (
      profiel_id INTEGER NOT NULL, slug TEXT NOT NULL, ep INTEGER NOT NULL DEFAULT -1, posisie REAL NOT NULL DEFAULT 0,
      duur REAL NOT NULL DEFAULT 0, voltooi INTEGER NOT NULL DEFAULT 0, bygewerk INTEGER NOT NULL, PRIMARY KEY (profiel_id, slug))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gradering (
      profiel_id INTEGER NOT NULL, slug TEXT NOT NULL, sterre INTEGER NOT NULL, bygewerk INTEGER NOT NULL, PRIMARY KEY (profiel_id, slug))`),
  ]);
}

const naam0 = (u) => clip(u.name || String(u.email || '').split('@')[0], 20) || 'Profiel';

export async function lysProfiele(db, u) {
  let rows = (await db.prepare('SELECT id, naam, avatar, kinders FROM profiele WHERE user_id = ? ORDER BY id').bind(u.id).all()).results;
  if (!rows.length) {
    await db.prepare('INSERT INTO profiele (user_id, naam, avatar, kinders, created_at) VALUES (?, ?, 0, 0, ?)').bind(u.id, naam0(u), Date.now()).run();
    rows = (await db.prepare('SELECT id, naam, avatar, kinders FROM profiele WHERE user_id = ? ORDER BY id').bind(u.id).all()).results;
  }
  return rows.map((r) => ({ id: r.id, naam: r.naam, avatar: r.avatar, kinders: !!r.kinders }));
}

// Gee die profiel terug as dit aan hierdie gebruiker behoort, anders null
export async function eiProfiel(db, u, id) {
  const pid = Number(id);
  if (!u || !Number.isInteger(pid) || pid < 1) return null;
  return (await db.prepare('SELECT id, naam, avatar, kinders FROM profiele WHERE id = ? AND user_id = ?').bind(pid, u.id).first()) || null;
}

const PATHS = new Set(['/api/profiele', '/api/profiel-nuut', '/api/profiel-wysig', '/api/profiel-skrap', '/api/lys', '/api/vordering', '/api/gradering']);

export const isMemberPath = (p) => PATHS.has(p);

export async function handleMember({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  const db = env.DB;
  if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
  if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
  const url = new URL(request.url);
  const body = post ? await request.json().catch(() => ({})) : {};

  if (path === '/api/profiele' && !post) return json({ profiele: await lysProfiele(db, u), maks: MAX_PROFIELE });

  const cleanName = (v) => clip(v, 20);
  const cleanAvatar = (v) => { const a = parseInt(v, 10); return Number.isInteger(a) && a >= 0 && a < AVATARE ? a : 0; };

  if (path === '/api/profiel-nuut' && post) {
    const list = await lysProfiele(db, u);
    if (list.length >= MAX_PROFIELE) return json({ fout: `Jy kan tot ${MAX_PROFIELE} profiele hê.` }, 400);
    const naam = cleanName(body.naam);
    if (!naam) return json({ fout: 'Gee die profiel \'n naam.' }, 400);
    const r = await db.prepare('INSERT INTO profiele (user_id, naam, avatar, kinders, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(u.id, naam, cleanAvatar(body.avatar), body.kinders ? 1 : 0, Date.now()).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (path === '/api/profiel-wysig' && post) {
    const p = await eiProfiel(db, u, body.id); if (!p) return json({ fout: 'Nie gevind nie.' }, 404);
    const naam = cleanName(body.naam) || p.naam;
    await db.prepare('UPDATE profiele SET naam = ?, avatar = ?, kinders = ? WHERE id = ?').bind(naam, cleanAvatar(body.avatar), body.kinders ? 1 : 0, p.id).run();
    return json({ ok: true });
  }
  if (path === '/api/profiel-skrap' && post) {
    const p = await eiProfiel(db, u, body.id); if (!p) return json({ fout: 'Nie gevind nie.' }, 404);
    const list = await lysProfiele(db, u);
    if (list.length <= 1) return json({ fout: 'Jy moet ten minste een profiel hê.' }, 400);
    await db.batch([
      db.prepare('DELETE FROM lys WHERE profiel_id = ?').bind(p.id), db.prepare('DELETE FROM vordering WHERE profiel_id = ?').bind(p.id),
      db.prepare('DELETE FROM gradering WHERE profiel_id = ?').bind(p.id), db.prepare('DELETE FROM profiele WHERE id = ?').bind(p.id)]);
    return json({ ok: true });
  }

  // Alles hieronder werk binne 'n profiel
  const p = await eiProfiel(db, u, post ? body.profiel : url.searchParams.get('profiel'));
  if (!p) return json({ fout: 'Kies eers \'n profiel.' }, 400);
  const slug = clip(post ? body.slug : '', 80);

  if (path === '/api/lys') {
    if (!post) return json({ slugs: (await db.prepare('SELECT slug FROM lys WHERE profiel_id = ? ORDER BY created_at').bind(p.id).all()).results.map((r) => r.slug) });
    if (!slug) return json({ fout: 'Ongeldig.' }, 400);
    if (body.aan) await db.prepare('INSERT OR IGNORE INTO lys (profiel_id, slug, created_at) VALUES (?, ?, ?)').bind(p.id, slug, Date.now()).run();
    else await db.prepare('DELETE FROM lys WHERE profiel_id = ? AND slug = ?').bind(p.id, slug).run();
    return json({ ok: true });
  }

  if (path === '/api/vordering') {
    if (!post) {
      const rows = (await db.prepare('SELECT slug, ep, posisie, duur, bygewerk FROM vordering WHERE profiel_id = ? AND voltooi = 0 AND posisie > 5 ORDER BY bygewerk DESC LIMIT 20').bind(p.id).all()).results;
      return json({ items: rows });
    }
    const posisie = Number(body.posisie), duur = Number(body.duur);
    const ep = body.ep == null ? -1 : parseInt(body.ep, 10);
    if (!slug || !Number.isFinite(posisie) || !Number.isFinite(duur) || posisie < 0 || duur <= 0 || duur > 86400 || !Number.isInteger(ep) || ep < -1 || ep > 500) return json({ fout: 'Ongeldig.' }, 400);
    const klaar = posisie >= duur * 0.95 ? 1 : 0;
    await db.prepare(`INSERT INTO vordering (profiel_id, slug, ep, posisie, duur, voltooi, bygewerk) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profiel_id, slug) DO UPDATE SET ep = excluded.ep, posisie = excluded.posisie, duur = excluded.duur, voltooi = excluded.voltooi, bygewerk = excluded.bygewerk`)
      .bind(p.id, slug, ep, Math.min(posisie, duur), duur, klaar, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/gradering' && post) {
    const sterre = parseInt(body.sterre, 10);
    if (!slug || !Number.isInteger(sterre) || sterre < 0 || sterre > 5) return json({ fout: 'Ongeldig.' }, 400);
    const t = await db.prepare("SELECT 1 AS x FROM titels WHERE slug = ? AND status = 'gepubliseer'").bind(slug).first();
    if (!t) return json({ fout: 'Nie gevind nie.' }, 404);
    if (sterre === 0) await db.prepare('DELETE FROM gradering WHERE profiel_id = ? AND slug = ?').bind(p.id, slug).run();
    else await db.prepare(`INSERT INTO gradering (profiel_id, slug, sterre, bygewerk) VALUES (?, ?, ?, ?)
      ON CONFLICT(profiel_id, slug) DO UPDATE SET sterre = excluded.sterre, bygewerk = excluded.bygewerk`).bind(p.id, slug, sterre, Date.now()).run();
    const g = await db.prepare('SELECT AVG(sterre) AS gem, COUNT(*) AS n FROM gradering WHERE slug = ?').bind(slug).first();
    return json({ ok: true, gem: g.n ? Math.round(g.gem * 10) / 10 : null, aantal: g.n, myne: sterre });
  }
  return null;
}
