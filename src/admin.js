// Stroom: wie 'n admin is. Die eienaar (ADMIN_EMAIL) is altyd admin en is die enigste wat ander admins kan byvoeg of verwyder.
// Ander admins is ledere van Stroom met die vlag users.is_admin.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const ADMIN_COLUMNS = [['users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0']];
export const eienaar = (u, env) => !!(u && env.ADMIN_EMAIL && u.email === String(env.ADMIN_EMAIL).trim().toLowerCase());
export const adminOk = (u, env) => eienaar(u, env) || !!(u && u.is_admin === 1);

const PATHS = new Set(['/api/admin/admins', '/api/admin/admin-byvoeg', '/api/admin/admin-verwyder']);
export const isAdminPath = (p) => PATHS.has(p);

export async function handleAdmins({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
  const db = env.DB;
  const owner = String(env.ADMIN_EMAIL || '').trim().toLowerCase();

  if (path === '/api/admin/admins' && !post) {
    const rows = (await db.prepare('SELECT id, email, name FROM users WHERE is_admin = 1 ORDER BY email').all()).results;
    const lys = [{ id: 0, email: owner, name: '', eienaar: true }, ...rows.filter((r) => r.email !== owner).map((r) => ({ ...r, eienaar: false }))];
    return json({ admins: lys, kan_bestuur: eienaar(u, env) });
  }
  if (!post) return json({ fout: 'Nie gevind nie.' }, 404);
  if (!eienaar(u, env)) return json({ fout: 'Net die eienaar kan admins byvoeg of verwyder.' }, 403);
  const body = await request.json().catch(() => ({}));

  if (path === '/api/admin/admin-byvoeg') {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    if (!email) return json({ fout: 'Tik die e-pos van die persoon.' }, 400);
    const m = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
    if (!m) return json({ fout: 'Daar is geen Stroom-rekening met "' + email + '" nie. Die persoon moet eers by Stroom registreer.' }, 404);
    if (m.email === owner) return json({ fout: 'Dit is reeds die eienaar.' }, 400);
    await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(m.id).run();
    return json({ ok: true });
  }
  if (path === '/api/admin/admin-verwyder') {
    const r = await db.prepare('SELECT id, email FROM users WHERE id = ? AND is_admin = 1').bind(Number(body.id)).first();
    if (!r) return json({ fout: 'Nie gevind nie.' }, 404);
    await db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').bind(r.id).run();
    return json({ ok: true });
  }
  return json({ fout: 'Nie gevind nie.' }, 404);
}
