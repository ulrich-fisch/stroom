// Verslae en meting: kyk-gebeure, advertensie-gebeure, kyktyd, tariewe en die admin-verslag.
// Slegs getalle en groepe word gestoor (land = 2-letter kode, toestel-soort). Geen IP-adresse nie.
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const DAY = 86400000, TZ = 7200;                                   // Suid-Afrika = UTC+2 (geen somertyd)
const dayExpr = (col) => `strftime('%Y-%m-%d', ${col} / 1000 + ${TZ}, 'unixepoch')`;
import { adminOk } from './admin.js';

export const DEFAULT_RATES = { cpm_voorrol: 120, cpc: 4, premium_maand: 59, premium_jaar: 590, skepper_deel: 0 };
const RATE_KEYS = Object.keys(DEFAULT_RATES);

export function toestelSoort(request) {
  const ua = request.headers.get('User-Agent') || '';
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'foon';
  return 'rekenaar';
}
export const landKode = (request) => { const c = request.cf && request.cf.country; return /^[A-Z]{2}$/.test(c || '') ? c : null; };
export const vandag = (ts = Date.now()) => new Date(ts + TZ * 1000).toISOString().slice(0, 10);

export const reportStatements = (db) => [
  db.prepare('CREATE TABLE IF NOT EXISTS instellings (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL)'),
  db.prepare(`CREATE TABLE IF NOT EXISTS meting (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ad_id INTEGER NOT NULL, tipe TEXT NOT NULL, user_id INTEGER, slug TEXT,
    sek INTEGER NOT NULL DEFAULT 0, land TEXT, toestel TEXT, ts INTEGER NOT NULL)`),
  db.prepare('CREATE INDEX IF NOT EXISTS meting_ad_ts ON meting (ad_id, ts)'),
  db.prepare(`CREATE TABLE IF NOT EXISTS kyktyd (
    dag TEXT NOT NULL, user_id INTEGER NOT NULL, slug TEXT NOT NULL, sek INTEGER NOT NULL DEFAULT 0, plan TEXT,
    PRIMARY KEY (dag, user_id, slug))`),
  db.prepare('CREATE INDEX IF NOT EXISTS kykgebeure_ts ON kykgebeure (ts)'),
];
// Kolomme wat later by kykgebeure bygevoeg is (die worker voeg dit by as dit ontbreek)
export const REPORT_COLUMNS = [['kykgebeure', 'user_id', 'INTEGER'], ['kykgebeure', 'plan', 'TEXT'], ['kykgebeure', 'land', 'TEXT'], ['kykgebeure', 'toestel', 'TEXT']];

export async function lesTariewe(db) {
  const rows = (await db.prepare('SELECT sleutel, waarde FROM instellings').all()).results;
  const out = { ...DEFAULT_RATES };
  for (const r of rows) if (RATE_KEYS.includes(r.sleutel) && Number.isFinite(Number(r.waarde))) out[r.sleutel] = Number(r.waarde);
  return out;
}

// Kyktyd: tel sekondes per dag / gebruiker / titel op (gebel vanaf die vordering-stoor)
export async function boekKyktyd(db, u, slug, sek) {
  const s = Math.max(0, Math.min(120, Math.round(Number(sek) || 0)));
  if (!s) return;
  await db.prepare(`INSERT INTO kyktyd (dag, user_id, slug, sek, plan) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dag, user_id, slug) DO UPDATE SET sek = sek + excluded.sek, plan = excluded.plan`).bind(vandag(), u.id, slug, s, u.plan).run();
}

const PATHS = new Set(['/api/meet', '/api/admin/verslag', '/api/admin/verslag-csv', '/api/admin/tariewe']);
export const isReportPath = (p) => PATHS.has(p);

const n = (v) => Number(v) || 0;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (cols, rows) => '﻿' + [cols.map((c) => csvCell(c[1])).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c[0]])).join(','))].join('\n');

function daysList(dae) {
  const out = [];
  for (let i = dae - 1; i >= 0; i--) out.push(vandag(Date.now() - i * DAY));
  return out;
}
const series = (days, rows, key = 'n') => { const m = new Map(rows.map((r) => [r.d, n(r[key])])); return days.map((d) => m.get(d) || 0); };

export async function bouVerslag(db, dae, adId) {
  const now = Date.now(), since = now - dae * DAY, days = daysList(dae);
  const rates = await lesTariewe(db);
  const one = async (q, ...a) => (await db.prepare(q).bind(...a).first()) || {};
  const all = async (q, ...a) => (await db.prepare(q).bind(...a).all()).results;

  // ----- Lede en inkomste -----
  const lede = await one(`SELECT COUNT(*) AS totaal, SUM(plan = 'svod') AS premium, SUM(plan = 'avod') AS gratis, SUM(plan = 'none') AS geen,
    SUM(plan = 'svod' AND plan_period = 'monthly') AS maand, SUM(plan = 'svod' AND plan_period = 'annual') AS jaar,
    SUM(created_at > ?) AS nuut FROM users`, since);
  const premium = n(lede.premium);
  const mrr = Math.round(n(lede.maand) * rates.premium_maand + n(lede.jaar) * rates.premium_jaar / 12 + Math.max(0, premium - n(lede.maand) - n(lede.jaar)) * rates.premium_maand);
  const signups = await all(`SELECT ${dayExpr('created_at')} AS d, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY d`, since);

  // ----- Kykers -----
  const spelers = await one('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM kykgebeure WHERE ts > ?', since);
  const dau = n((await one('SELECT COUNT(DISTINCT user_id) AS n FROM kykgebeure WHERE ts > ?', now - DAY)).n);
  const wau = n((await one('SELECT COUNT(DISTINCT user_id) AS n FROM kykgebeure WHERE ts > ?', now - 7 * DAY)).n);
  const mau = n((await one('SELECT COUNT(DISTINCT user_id) AS n FROM kykgebeure WHERE ts > ?', now - 30 * DAY)).n);
  const playsDay = await all(`SELECT ${dayExpr('ts')} AS d, COUNT(*) AS n FROM kykgebeure WHERE ts > ? GROUP BY d`, since);
  const activeDay = await all(`SELECT ${dayExpr('ts')} AS d, COUNT(DISTINCT user_id) AS n FROM kykgebeure WHERE ts > ? GROUP BY d`, since);
  const sinceDag = vandag(since);
  const tyd = await one('SELECT COALESCE(SUM(sek), 0) AS s FROM kyktyd WHERE dag >= ?', sinceDag);
  const tydDay = await all('SELECT dag AS d, SUM(sek) AS n FROM kyktyd WHERE dag >= ? GROUP BY dag', sinceDag);
  const perToestel = await all('SELECT COALESCE(toestel, \'onbekend\') AS k, COUNT(*) AS n FROM kykgebeure WHERE ts > ? GROUP BY k ORDER BY n DESC', since);
  const perLand = await all('SELECT COALESCE(land, \'??\') AS k, COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM kykgebeure WHERE ts > ? GROUP BY k ORDER BY n DESC LIMIT 10', since);
  const perPlan = await all('SELECT COALESCE(plan, \'onbekend\') AS k, COUNT(*) AS n FROM kykgebeure WHERE ts > ? GROUP BY k', since);
  const perGenre = await all(`SELECT COALESCE(t.genre_etiket, 'Ander') AS k, COUNT(*) AS n FROM kykgebeure k LEFT JOIN titels t ON t.slug = k.slug WHERE k.ts > ? GROUP BY k ORDER BY n DESC`, since);
  const perTipe = await all(`SELECT COALESCE(t.tipe, 'Ander') AS k, COUNT(*) AS n FROM kykgebeure k LEFT JOIN titels t ON t.slug = k.slug WHERE k.ts > ? GROUP BY k ORDER BY n DESC`, since);
  // Terugkeer ná 7 dae: van lede wat 7-60 dae gelede aangesluit het, hoeveel het ná dag 7 weer gekyk?
  const ret = await one(`SELECT COUNT(*) AS kohort, SUM(EXISTS(SELECT 1 FROM kykgebeure k WHERE k.user_id = u.id AND k.ts >= u.created_at + 7 * 86400000)) AS terug
    FROM users u WHERE u.created_at BETWEEN ? AND ?`, now - 60 * DAY, now - 7 * DAY);
  const gekyk = await one('SELECT COUNT(DISTINCT user_id) AS n FROM kykgebeure');
  const ooit = n(lede.totaal) - n(lede.geen);

  // ----- Inhoud -----
  const titels = await all(`SELECT t.slug, t.titel, t.tipe, t.genre_etiket,
      (SELECT COUNT(*) FROM kykgebeure k WHERE k.slug = t.slug AND k.ts > ?) AS kyke,
      (SELECT COUNT(DISTINCT k.user_id) FROM kykgebeure k WHERE k.slug = t.slug AND k.ts > ?) AS kykers,
      (SELECT COALESCE(SUM(sek), 0) FROM kyktyd y WHERE y.slug = t.slug AND y.dag >= ?) AS sek,
      (SELECT COUNT(*) FROM vordering v WHERE v.slug = t.slug) AS begin_kyk,
      (SELECT COUNT(*) FROM vordering v WHERE v.slug = t.slug AND v.voltooi = 1) AS klaar_kyk,
      (SELECT AVG(sterre) FROM gradering g WHERE g.slug = t.slug) AS gem,
      (SELECT COUNT(*) FROM gradering g WHERE g.slug = t.slug) AS aantal,
      (SELECT COUNT(*) FROM meting m WHERE m.slug = t.slug AND m.tipe = 'begin' AND m.ts > ?) AS adv
    FROM titels t WHERE t.status = 'gepubliseer' ORDER BY kyke DESC, t.id`, since, since, sinceDag, since);
  const titelRows = titels.map((t) => ({ slug: t.slug, titel: t.titel, tipe: t.tipe, genre: t.genre_etiket, kyke: n(t.kyke), kykers: n(t.kykers),
    ure: Math.round(n(t.sek) / 360) / 10, voltooi_pct: pct(n(t.klaar_kyk), n(t.begin_kyk)), gem: t.gem == null ? null : Math.round(t.gem * 10) / 10, aantal: n(t.aantal), advertensie_vertonings: n(t.adv) }));
  const gradering = await one('SELECT AVG(sterre) AS gem, COUNT(*) AS n FROM gradering');
  const biblioteek = n((await one("SELECT COUNT(*) AS n FROM titels WHERE status = 'gepubliseer'")).n);

  // ----- Advertensies -----
  const ads = await all(`SELECT a.id, a.naam, a.aktief,
      SUM(CASE WHEN m.tipe = 'begin' THEN 1 ELSE 0 END) AS begin, SUM(CASE WHEN m.tipe = 'klaar' THEN 1 ELSE 0 END) AS klaar,
      SUM(CASE WHEN m.tipe = 'oor' THEN 1 ELSE 0 END) AS oor, SUM(CASE WHEN m.tipe = 'klik' THEN 1 ELSE 0 END) AS klik,
      COUNT(DISTINCT CASE WHEN m.tipe = 'begin' THEN m.user_id END) AS unieke,
      AVG(CASE WHEN m.tipe = 'oor' THEN m.sek END) AS gem_oor_sek
    FROM advertensies a LEFT JOIN meting m ON m.ad_id = a.id AND m.ts > ? GROUP BY a.id ORDER BY begin DESC`, since);
  const adRows = ads.map((a) => { const b = n(a.begin), k = n(a.klik);
    return { id: a.id, naam: a.naam, aktief: !!a.aktief, vertonings: b, voltooi: n(a.klaar), oorgeslaan: n(a.oor), klikke: k, unieke_kykers: n(a.unieke),
      voltooi_pct: pct(n(a.klaar), b), oorslaan_pct: pct(n(a.oor), b), ktv_pct: pct(k, b), frekwensie: n(a.unieke) ? Math.round((b / n(a.unieke)) * 10) / 10 : null,
      gem_oorslaan_sek: a.gem_oor_sek == null ? null : Math.round(a.gem_oor_sek * 10) / 10,
      beraamde_koste: Math.round((b / 1000 * rates.cpm_voorrol + k * rates.cpc) * 100) / 100 }; });
  const adTot = adRows.reduce((t, a) => ({ vertonings: t.vertonings + a.vertonings, voltooi: t.voltooi + a.voltooi, oorgeslaan: t.oorgeslaan + a.oorgeslaan, klikke: t.klikke + a.klikke, koste: t.koste + a.beraamde_koste }),
    { vertonings: 0, voltooi: 0, oorgeslaan: 0, klikke: 0, koste: 0 });
  const metingDay = await all(`SELECT ${dayExpr('ts')} AS d, COUNT(*) AS n FROM meting WHERE tipe = 'begin' AND ts > ? GROUP BY d`, since);
  const gratisKyke = n((perPlan.find((p) => p.k === 'avod') || {}).n);

  const out = {
    dae, tariewe: rates, dae_lys: days, gegenereer: new Date().toISOString(),
    lede: { totaal: n(lede.totaal), gratis: n(lede.gratis), premium, nuut: n(lede.nuut), maandeliks: n(lede.maand), jaarliks: n(lede.jaar),
      omskakeling_pct: pct(premium, n(lede.gratis) + premium), mrr, arr: mrr * 12, signups: series(days, signups) },
    kykers: { kyke: n(spelers.n), unieke: n(spelers.u), dau, wau, mau, kleef_pct: pct(dau, mau), kyke_per_dag: series(days, playsDay), aktief_per_dag: series(days, activeDay),
      ure: Math.round(n(tyd.s) / 360) / 10, ure_per_dag: series(days, tydDay).map((s) => Math.round(s / 360) / 10),
      gem_minute_per_kyk: n(spelers.n) ? Math.round(n(tyd.s) / 60 / n(spelers.n) * 10) / 10 : null,
      terugkeer_7d_pct: pct(n(ret.terug), n(ret.kohort)), terugkeer_kohort: n(ret.kohort), geaktiveer_pct: pct(n(gekyk.n), ooit),
      toestelle: perToestel, lande: perLand, planne: perPlan, genres: perGenre, tipes: perTipe },
    inhoud: { biblioteek, gem_gradering: gradering.gem == null ? null : Math.round(gradering.gem * 10) / 10, graderings: n(gradering.n), titels: titelRows },
    advertensies: { totaal: { ...adTot, voltooi_pct: pct(adTot.voltooi, adTot.vertonings), ktv_pct: pct(adTot.klikke, adTot.vertonings), koste: Math.round(adTot.koste * 100) / 100 },
      vul_pct: pct(adTot.vertonings, gratisKyke), per_dag: series(days, metingDay), lys: adRows },
  };

  if (adId) {
    const ad = adRows.find((a) => a.id === adId);
    if (ad) {
      const byDay = await all(`SELECT ${dayExpr('ts')} AS d, COUNT(*) AS n FROM meting WHERE ad_id = ? AND tipe = 'begin' AND ts > ? GROUP BY d`, adId, since);
      const byTitel = await all(`SELECT COALESCE(t.titel, m.slug, '?') AS k, COUNT(*) AS n FROM meting m LEFT JOIN titels t ON t.slug = m.slug WHERE m.ad_id = ? AND m.tipe = 'begin' AND m.ts > ? GROUP BY k ORDER BY n DESC LIMIT 10`, adId, since);
      const byLand = await all(`SELECT COALESCE(land, '??') AS k, COUNT(*) AS n FROM meting WHERE ad_id = ? AND tipe = 'begin' AND ts > ? GROUP BY k ORDER BY n DESC LIMIT 10`, adId, since);
      const byToestel = await all(`SELECT COALESCE(toestel, 'onbekend') AS k, COUNT(*) AS n FROM meting WHERE ad_id = ? AND tipe = 'begin' AND ts > ? GROUP BY k ORDER BY n DESC`, adId, since);
      out.advertensie_detail = { ...ad, per_dag: series(days, byDay), titels: byTitel, lande: byLand, toestelle: byToestel };
    }
  }
  return out;
}

export async function handleReports({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  const db = env.DB;
  const url = new URL(request.url);

  // Meting vanaf die speler (lede)
  if (path === '/api/meet') {
    if (!post) return json({ fout: 'Nie gevind nie.' }, 404);
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
    const b = await request.json().catch(() => ({}));
    const tipe = String(b.tipe || ''), adId = parseInt(b.ad, 10);
    if (!['begin', 'klaar', 'oor', 'klik'].includes(tipe) || !Number.isInteger(adId) || adId < 1) return json({ fout: 'Ongeldig.' }, 400);
    if (!(await db.prepare('SELECT 1 AS x FROM advertensies WHERE id = ?').bind(adId).first())) return json({ fout: 'Nie gevind nie.' }, 404);
    const slug = String(b.slug || '').slice(0, 80) || null;
    const recent = await db.prepare('SELECT 1 AS x FROM meting WHERE ad_id = ? AND user_id = ? AND tipe = ? AND ts > ? AND COALESCE(slug, \'\') = ?').bind(adId, u.id, tipe, Date.now() - 20000, slug || '').first();
    if (!recent) {
      await db.prepare('INSERT INTO meting (ad_id, tipe, user_id, slug, sek, land, toestel, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(adId, tipe, u.id, slug, Math.max(0, Math.min(600, Math.round(Number(b.sek) || 0))), landKode(request), toestelSoort(request), Date.now()).run();
    }
    return json({ ok: true });
  }

  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);

  if (path === '/api/admin/tariewe') {
    if (!post) return json({ tariewe: await lesTariewe(db), verstek: DEFAULT_RATES });
    const b = await request.json().catch(() => ({}));
    for (const k of RATE_KEYS) {
      if (b[k] == null) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100000 || (k === 'skepper_deel' && v > 100)) return json({ fout: 'Ongeldige bedrag vir ' + k + '.' }, 400);
      await db.prepare('INSERT INTO instellings (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').bind(k, String(v)).run();
    }
    return json({ ok: true, tariewe: await lesTariewe(db) });
  }

  const dae = [7, 30, 90, 365].includes(parseInt(url.searchParams.get('dae'), 10)) ? parseInt(url.searchParams.get('dae'), 10) : 30;
  if (path === '/api/admin/verslag') {
    const ad = parseInt(url.searchParams.get('ad'), 10);
    return json(await bouVerslag(db, dae, Number.isInteger(ad) ? ad : null));
  }
  if (path === '/api/admin/verslag-csv') {
    const v = await bouVerslag(db, dae, null);
    const soort = url.searchParams.get('soort');
    let cols, rows;
    if (soort === 'titels') {
      cols = [['titel', 'Titel'], ['tipe', 'Tipe'], ['genre', 'Genre'], ['kyke', 'Kyke'], ['kykers', 'Unieke kykers'], ['ure', 'Kykure'], ['voltooi_pct', 'Voltooiing %'], ['gem', 'Gem. gradering'], ['aantal', 'Graderings'], ['advertensie_vertonings', 'Advertensie-vertonings']];
      rows = v.inhoud.titels;
    } else if (soort === 'adverteerders') {
      cols = [['naam', 'Advertensie'], ['vertonings', 'Vertonings'], ['unieke_kykers', 'Unieke kykers'], ['frekwensie', 'Gem. frekwensie'], ['voltooi', 'Voltooi'], ['voltooi_pct', 'Voltooiing %'], ['oorgeslaan', 'Oorgeslaan'], ['oorslaan_pct', 'Oorslaan %'], ['klikke', 'Klikke'], ['ktv_pct', 'Klik-koers %'], ['beraamde_koste', 'Beraamde waarde (R)']];
      rows = v.advertensies.lys;
    } else if (soort === 'dae') {
      cols = [['dag', 'Dag'], ['kyke', 'Kyke'], ['aktiewe_kykers', 'Aktiewe kykers'], ['kykure', 'Kykure'], ['nuwe_lede', 'Nuwe lede'], ['advertensie_vertonings', 'Advertensie-vertonings']];
      rows = v.dae_lys.map((d, i) => ({ dag: d, kyke: v.kykers.kyke_per_dag[i], aktiewe_kykers: v.kykers.aktief_per_dag[i], kykure: v.kykers.ure_per_dag[i], nuwe_lede: v.lede.signups[i], advertensie_vertonings: v.advertensies.per_dag[i] }));
    } else return json({ fout: 'Ongeldige soort.' }, 400);
    return new Response(toCsv(cols, rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="stroom-${soort}-${vandag()}.csv"`, 'Cache-Control': 'no-store' } });
  }
  return null;
}
