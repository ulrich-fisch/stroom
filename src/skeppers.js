// Stroom: Cinema Club-skeppers (creators). Admin koppel 'n titel aan 'n lid (skepper); die skepper sien sy eie syfers.
// Admin sien 'n maandelikse staat om uitbetalings van te maak. Alles hier is BERAMINGS, nie 'n bindende staat nie.

import { lesTariewe, vandag } from './verslae.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const adminOk = (u, env) => !!(u && env.ADMIN_EMAIL && u.email === String(env.ADMIN_EMAIL).trim().toLowerCase());
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (cols, rows) => '\uFEFF' + [cols.map((c) => csvCell(c[1])).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c[0]])).join(','))].join('\n');
const rond = (x) => Math.round(x * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export const SKEPPER_COLUMNS = [['titels', 'skepper_id', 'INTEGER']];

export const isSkepper = async (db, userId) => !!(await db.prepare('SELECT 1 AS x FROM titels WHERE skepper_id = ? LIMIT 1').bind(userId).first());

// Tydvenster. maand = "2026-10" (Suid-Afrikaanse tyd), anders die laaste `dae` dae.
export function venster(q) {
  const maand = String(q.get('maand') || '');
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(maand);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    const from = Date.UTC(y, mo - 1, 1) - 7200000, to = Date.UTC(y, mo, 1) - 7200000;
    return { maand, from, to, fromDag: vandag(from), toDag: vandag(to - 1) };
  }
  const dae = [7, 30, 90, 365].includes(Number(q.get('dae'))) ? Number(q.get('dae')) : 30;
  const to = Date.now() + 1, from = to - dae * 86400000;
  return { dae, from, to, fromDag: vandag(from), toDag: vandag(to) };
}

// Syfers per titel vir 'n lys slugs binne die venster
export async function titelSyfers(db, titels, w, rates) {
  if (!titels.length) return [];
  const slugs = titels.map((t) => t.slug), ph = slugs.map(() => '?').join(',');
  const by = async (sql, ...args) => new Map((await db.prepare(sql).bind(...args).all()).results.map((r) => [r.slug, r]));
  const kyke = await by(`SELECT slug, COUNT(*) AS kyke, COUNT(DISTINCT user_id) AS unieke FROM kykgebeure WHERE slug IN (${ph}) AND ts >= ? AND ts < ? GROUP BY slug`, ...slugs, w.from, w.to);
  const tyd = await by(`SELECT slug, COALESCE(SUM(sek), 0) AS sek FROM kyktyd WHERE slug IN (${ph}) AND dag >= ? AND dag <= ? GROUP BY slug`, ...slugs, w.fromDag, w.toDag);
  const ads = await by(`SELECT slug, SUM(CASE WHEN tipe = 'begin' THEN 1 ELSE 0 END) AS b, SUM(CASE WHEN tipe = 'klik' THEN 1 ELSE 0 END) AS k FROM meting WHERE slug IN (${ph}) AND ts >= ? AND ts < ? GROUP BY slug`, ...slugs, w.from, w.to);
  const gr = await by(`SELECT slug, AVG(sterre) AS gem, COUNT(*) AS aantal FROM gradering WHERE slug IN (${ph}) GROUP BY slug`, ...slugs);
  const vo = await by(`SELECT slug, COUNT(*) AS n, SUM(voltooi) AS v FROM vordering WHERE slug IN (${ph}) GROUP BY slug`, ...slugs);
  const rk = await by(`SELECT slug, SUM(waarde = 1) AS op, SUM(waarde = -1) AS af FROM reaksie WHERE slug IN (${ph}) GROUP BY slug`, ...slugs);
  const hn = await by(`SELECT slug, COUNT(*) AS n FROM herinner WHERE slug IN (${ph}) GROUP BY slug`, ...slugs);
  const deel = Number(rates.skepper_deel) || 0;
  return titels.map((t) => {
    const k = kyke.get(t.slug) || {}, a = ads.get(t.slug) || {}, g = gr.get(t.slug), v = vo.get(t.slug) || {};
    const waarde = rond(((a.b || 0) / 1000) * rates.cpm_voorrol + (a.k || 0) * rates.cpc);
    return { slug: t.slug, titel: t.titel, status: t.status, kyke: k.kyke || 0, unieke: k.unieke || 0, ure: rond(((tyd.get(t.slug) || {}).sek || 0) / 3600),
      advertensie_kyke: a.b || 0, klikke: a.k || 0, waarde, deel: rond(waarde * deel / 100),
      gem: g ? Math.round(g.gem * 10) / 10 : null, aantal: g ? g.aantal : 0, voltooi_pct: pct(v.v || 0, v.n || 0), herinnerings: (hn.get(t.slug) || {}).n || 0, duim_op: (rk.get(t.slug) || {}).op || 0, duim_af: (rk.get(t.slug) || {}).af || 0 };
  });
}

const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

export async function skepperVerslag(db, userId, w, rates) {
  const titels = (await db.prepare('SELECT slug, titel, status FROM titels WHERE skepper_id = ? ORDER BY id DESC LIMIT 100').bind(userId).all()).results;
  const rows = await titelSyfers(db, titels, w, rates);
  let reeks = [];
  if (titels.length) {
    const ph = titels.map(() => '?').join(',');
    reeks = (await db.prepare(`SELECT date(ts / 1000 + 7200, 'unixepoch') AS d, COUNT(*) AS n FROM kykgebeure WHERE slug IN (${ph}) AND ts >= ? AND ts < ? GROUP BY d ORDER BY d`).bind(...titels.map((t) => t.slug), w.from, w.to).all()).results;
  }
  const tot = { kyke: sum(rows, 'kyke'), ure: rond(sum(rows, 'ure')), advertensie_kyke: sum(rows, 'advertensie_kyke'), klikke: sum(rows, 'klikke'), waarde: rond(sum(rows, 'waarde')), deel: rond(sum(rows, 'deel')) };
  return { venster: { maand: w.maand || null, dae: w.dae || null, van: w.fromDag, tot: w.toDag }, deel_pct: Number(rates.skepper_deel) || 0, titels: rows, totaal: tot, reeks };
}

// Admin: een reël per skepper vir die tydvenster
export async function skepperStaat(db, w, rates) {
  const skeppers = (await db.prepare(`SELECT u.id, u.email, u.name FROM users u WHERE u.id IN (SELECT DISTINCT skepper_id FROM titels WHERE skepper_id IS NOT NULL) ORDER BY u.email LIMIT 200`).all()).results;
  const out = [];
  for (const s of skeppers) {
    const titels = (await db.prepare('SELECT slug, titel, status FROM titels WHERE skepper_id = ?').bind(s.id).all()).results;
    const rows = await titelSyfers(db, titels, w, rates);
    out.push({ id: s.id, e_pos: s.email, naam: s.name || '', titels: titels.length, kyke: sum(rows, 'kyke'), ure: rond(sum(rows, 'ure')), advertensie_kyke: sum(rows, 'advertensie_kyke'),
      klikke: sum(rows, 'klikke'), waarde: rond(sum(rows, 'waarde')), deel: rond(sum(rows, 'deel')) });
  }
  return out;
}

const PATHS = new Set(['/api/skepper/verslag', '/api/skepper/csv', '/api/admin/skepper-staat', '/api/admin/skepper-staat-csv', '/api/admin/rugsteun']);
export const isSkepperPath = (p) => PATHS.has(p);

export async function handleSkeppers({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  if (post) return json({ fout: 'Nie gevind nie.' }, 404);
  const db = env.DB, q = new URL(request.url).searchParams;

  if (path.startsWith('/api/skepper/')) {
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    const rates = await lesTariewe(db), w = venster(q);
    const v = await skepperVerslag(db, u.id, w, rates);
    if (path === '/api/skepper/verslag') return json(v);
    const cols = [['titel', 'Titel'], ['status', 'Status'], ['kyke', 'Kyke'], ['unieke', 'Unieke kykers'], ['ure', 'Kykure'], ['advertensie_kyke', 'Advertensie-vertonings'], ['klikke', 'Klikke'],
      ['waarde', 'Beraamde advertensiewaarde (R)'], ['deel', 'Jou beraamde deel (R)'], ['gem', 'Gem. gradering'], ['duim_op', 'Duim op'], ['duim_af', 'Duim af'], ['voltooi_pct', 'Voltooiing %'], ['herinnerings', 'Herinnerings']];
    return new Response(toCsv(cols, v.titels), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="stroom-skepper-${vandag()}.csv"`, 'Cache-Control': 'no-store' } });
  }

  // Admin
  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
  if (path === '/api/admin/rugsteun') {
    const all = async (sql) => (await db.prepare(sql).all()).results;
    const data = { stroom_rugsteun: 1, gemaak: new Date().toISOString(),
      titels: await all('SELECT * FROM titels ORDER BY id'), advertensies: await all('SELECT * FROM advertensies ORDER BY id'),
      onderskrifte: await all('SELECT * FROM onderskrifte ORDER BY slug, ep, taal'), instellings: await all("SELECT * FROM instellings WHERE sleutel <> 'skema'"),
      indienings: await all('SELECT * FROM indienings ORDER BY id'), dokumente_lys: await all('SELECT id, slug, naam, soort, ext, grootte, created_at FROM dokumente ORDER BY id') };
    return json(data, 200, { 'Content-Disposition': `attachment; filename="stroom-rugsteun-${vandag()}.json"` });
  }
  const rates = await lesTariewe(db), w = venster(q);
  const rows = await skepperStaat(db, w, rates);
  if (path === '/api/admin/skepper-staat') return json({ venster: { maand: w.maand || null, dae: w.dae || null, van: w.fromDag, tot: w.toDag }, deel_pct: Number(rates.skepper_deel) || 0, skeppers: rows,
    totaal: { waarde: rond(sum(rows, 'waarde')), deel: rond(sum(rows, 'deel')) } });
  const cols = [['e_pos', 'E-pos'], ['naam', 'Naam'], ['titels', 'Titels'], ['kyke', 'Kyke'], ['ure', 'Kykure'], ['advertensie_kyke', 'Advertensie-vertonings'], ['klikke', 'Klikke'], ['waarde', 'Beraamde advertensiewaarde (R)'], ['deel', 'Beraamde deel om te betaal (R)']];
  return new Response(toCsv(cols, rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="stroom-skepper-staat-${w.maand || vandag()}.csv"`, 'Cache-Control': 'no-store' } });
}
