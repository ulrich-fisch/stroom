// Stroom: "Binnekort"-titels met herinnerings, geskeduleerde vrystelling, rolverdeling, en deel-bladsye (WhatsApp-voorskou).

import { vandag } from './verslae.js';
import { kinderVeilig } from './lede.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const herinnerStatements = (db) => [
  db.prepare(`CREATE TABLE IF NOT EXISTS herinner (
    user_id INTEGER NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, gemeld INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, slug))`),
];
// Kolomme wat later by titels bygevoeg is (die worker voeg dit by as dit ontbreek)
export const TITEL_COLUMNS = [['titels', 'vrystelling', 'TEXT'], ['titels', 'trailer', 'TEXT'], ['titels', 'rolverdeling', 'TEXT'], ['titels', 'snit', 'TEXT']];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
export const datumOk = (s) => s === '' || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')));

// "Naam | Rol" per lyn -> [{ naam, rol }]
export function parseRolverdeling(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [naam, rol] = line.split('|').map((x) => x.trim());
    if (naam) out.push({ naam: clip(naam, 60), rol: clip(rol, 60) });
    if (out.length >= 30) break;
  }
  return out;
}

// Titels met 'n vrystellingsdatum wat aangebreek het (en 'n video het) gaan vanself live
export async function bevorderGeskeduleerd(db) {
  await db.prepare(`UPDATE titels SET status = 'gepubliseer' WHERE status = 'binnekort' AND vrystelling IS NOT NULL AND vrystelling <> '' AND vrystelling <= ?
    AND (COALESCE(video_url, '') <> '' OR episodes <> '[]')`).bind(vandag()).run();
}

// Wat 'n lid van die komende titels sien (nooit die video-adres nie)
export async function binnekortLys(db, u, prof) {
  const rows = (await db.prepare("SELECT * FROM titels WHERE status = 'binnekort' ORDER BY CASE WHEN vrystelling IS NULL OR vrystelling = '' THEN 1 ELSE 0 END, vrystelling, id").all()).results;
  const mine = new Set((await db.prepare('SELECT slug FROM herinner WHERE user_id = ?').bind(u.id).all()).results.map((x) => x.slug));
  return rows.filter((r) => !(prof && prof.kinders) || kinderVeilig(r.ouderdom)).map((r) => ({
    slug: r.slug, titel: r.titel, tipe: r.tipe, jaar: r.jaar, ouderdom: r.ouderdom, speeltyd: r.speeltyd, regisseur: r.regisseur,
    genre_sleutel: r.genre_sleutel, genre_etiket: r.genre_etiket, banner: r.banner, sinopsis: r.sinopsis, vrystelling: r.vrystelling || '',
    trailer: r.trailer || '', rolverdeling: parseRolverdeling(r.rolverdeling), episodes: [], binnekort: true, herinner: mine.has(r.slug), gem: null, aantal: 0, myne: 0 }));
}

// Titels waarvoor die lid 'n herinnering gestel het en wat nou beskikbaar is (nog nie aan hom gewys nie)
export async function herinnerNuut(db, u) {
  const rows = (await db.prepare(`SELECT t.slug, t.titel FROM herinner h JOIN titels t ON t.slug = h.slug
    WHERE h.user_id = ? AND h.gemeld = 0 AND t.status = 'gepubliseer' ORDER BY h.created_at`).bind(u.id).all()).results;
  return rows;
}

const PATHS = new Set(['/api/herinner', '/api/herinner-gesien']);
export const isBinnekortPath = (p) => PATHS.has(p);

export async function handleBinnekort({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  if (!post) return json({ fout: 'Nie gevind nie.' }, 404);
  if (!u || u.plan === 'none') return json({ fout: 'Nie ingeteken nie.' }, 401);
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  if (path === '/api/herinner-gesien') {
    await db.prepare('UPDATE herinner SET gemeld = 1 WHERE user_id = ?').bind(u.id).run();
    return json({ ok: true });
  }
  const slug = clip(body.slug, 80);
  if (!slugOk(slug)) return json({ fout: 'Ongeldig.' }, 400);
  const t = await db.prepare("SELECT 1 AS x FROM titels WHERE slug = ? AND status = 'binnekort'").bind(slug).first();
  if (!t) return json({ fout: 'Hierdie titel is nie meer \'n binnekort-titel nie.' }, 404);
  if (body.aan) await db.prepare('INSERT OR IGNORE INTO herinner (user_id, slug, created_at, gemeld) VALUES (?, ?, ?, 0)').bind(u.id, slug, Date.now()).run();
  else await db.prepare('DELETE FROM herinner WHERE user_id = ? AND slug = ?').bind(u.id, slug).run();
  return json({ ok: true });
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAANDE = ['Jan', 'Feb', 'Mrt', 'Apr', 'Mei', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Des'];
export const datumTekst = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${Number(m[3])} ${MAANDE[Number(m[2]) - 1]} ${m[1]}` : ''; };

// Publieke deel-bladsy /t/<slug>: gee WhatsApp, Facebook ens. 'n voorskou (titel, beskrywing, poster) en stuur mense na Stroom.
export async function sharePage(request, env) {
  const url = new URL(request.url);
  const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/+$/, '');
  const t = slugOk(slug) ? await env.DB.prepare("SELECT slug, titel, tipe, jaar, sinopsis, banner, status, vrystelling FROM titels WHERE slug = ? AND status IN ('gepubliseer', 'binnekort')").bind(slug).first() : null;
  if (!t) return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } });
  const abs = (p) => (/^https:\/\//.test(p) ? p : p && p.startsWith('/') ? url.origin + p : '');
  const img = abs(t.banner);
  const voor = t.status === 'binnekort' ? `Binnekort${t.vrystelling ? ' (' + datumTekst(t.vrystelling) + ')' : ''} op Stroom. ` : '';
  const desc = (voor + String(t.sinopsis || 'Afrikaanse flieks en reekse op Stroom.')).slice(0, 220);
  const titel = `${t.titel} | Stroom`;
  const mikpunt = `/katalogus.html?titel=${encodeURIComponent(t.slug)}`;
  const html = `<!doctype html>
<html lang="af"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titel)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Stroom">
<meta property="og:title" content="${esc(t.titel)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url.origin + '/t/' + t.slug)}">${img ? `\n<meta property="og:image" content="${esc(img)}">\n<meta name="twitter:image" content="${esc(img)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(t.titel)}"><meta name="twitter:description" content="${esc(desc)}">
<noscript><meta http-equiv="refresh" content="0;url=${esc(mikpunt)}"></noscript>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070c18;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
.k{max-width:420px}img{width:100%;border-radius:16px;margin-bottom:18px}h1{font-size:28px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5}
a{display:inline-block;margin-top:14px;background:#38bdf8;color:#020617;font-weight:800;text-decoration:none;padding:12px 26px;border-radius:999px;letter-spacing:.06em;text-transform:uppercase;font-size:13px}</style></head>
<body><div class="k">${img ? `<img src="${esc(img)}" alt="">` : ''}<h1>${esc(t.titel)}</h1><p>${esc(desc)}</p><a href="${esc(mikpunt)}">Kyk op Stroom</a></div>
<script>try{localStorage.setItem('stroom_terug',${JSON.stringify(t.slug)})}catch(e){}location.replace(${JSON.stringify(mikpunt)});</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
