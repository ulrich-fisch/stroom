// Stroom: advertensie-vlakke (tiers). Elke advertensie het 'n vlak (1 = hoogste). Die skedule bepaal watter vlak waar speel:
// voorrol (voor die titel), breuk 1, breuk 2 ... en aan die einde. Binne 'n vlak wissel die advertensies af.

import { adminOk } from './admin.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const AD_COLUMNS = [['advertensies', 'vlak', 'INTEGER NOT NULL DEFAULT 1']];
export const MAX_VLAK = 5;
export const STANDAARD_SKEDULE = { voorrol: 1, breuke: [2, 3], naroll: 2 };
const SLEUTEL = 'ad_skedule';
const vlakOk = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_VLAK;
export const vlakVan = (v) => { const n = parseInt(v, 10); return vlakOk(n) ? n : 1; };

export function valideerSkedule(b) {
  const voorrol = parseInt(b && b.voorrol, 10), naroll = parseInt(b && b.naroll, 10);
  const breuke = Array.isArray(b && b.breuke) ? b.breuke.map((x) => parseInt(x, 10)) : null;
  if (!vlakOk(voorrol) || !vlakOk(naroll) || !breuke || !breuke.length || breuke.length > 6 || !breuke.every(vlakOk)) return null;
  return { voorrol, breuke, naroll };
}
export async function lesSkedule(db) {
  try {
    const r = await db.prepare('SELECT waarde FROM instellings WHERE sleutel = ?').bind(SLEUTEL).first();
    const v = r && valideerSkedule(JSON.parse(r.waarde));
    return v || STANDAARD_SKEDULE;
  } catch { return STANDAARD_SKEDULE; }
}
// Watter vlak vir breuk nommer i (0 = eerste breuk); die laaste waarde geld vir alle verdere breuke
export const breukVlak = (sk, i) => sk.breuke[Math.min(i, sk.breuke.length - 1)];

// Kies 'n advertensie: die gewenste vlak; is daar geen, die naaste laer vlak (hoër getal), dan die naaste hoër vlak. Nooit dieselfde een twee keer agtermekaar as daar 'n keuse is nie.
export function kiesAd(ads, vlak, nie) {
  if (!ads.length) return null;
  for (let d = 0; d < MAX_VLAK; d++) {
    for (const v of d === 0 ? [vlak] : [vlak + d, vlak - d]) {
      const pool = ads.filter((a) => vlakVan(a.vlak) === v);
      if (!pool.length) continue;
      const keuse = pool.length > 1 ? pool.filter((a) => a.id !== nie) : pool;
      return keuse[Math.floor(Math.random() * keuse.length)];
    }
  }
  return null;
}

const PATHS = new Set(['/api/admin/ad-skedule']);
export const isVlakPath = (p) => PATHS.has(p);
export async function handleVlakke({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
  const db = env.DB;
  if (!post) {
    const rows = (await db.prepare('SELECT vlak, COUNT(*) AS n FROM advertensies WHERE aktief = 1 GROUP BY vlak').all()).results;
    const telling = {}; for (const r of rows) telling[vlakVan(r.vlak)] = (telling[vlakVan(r.vlak)] || 0) + r.n;
    return json({ skedule: await lesSkedule(db), standaard: STANDAARD_SKEDULE, max: MAX_VLAK, aktief_per_vlak: telling });
  }
  const b = await request.json().catch(() => ({}));
  const v = valideerSkedule(b);
  if (!v) return json({ fout: 'Elke slot moet \'n vlak van 1 tot ' + MAX_VLAK + ' hê, met 1 tot 6 breuke.' }, 400);
  await db.prepare('INSERT INTO instellings (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').bind(SLEUTEL, JSON.stringify(v)).run();
  return json({ ok: true, skedule: v });
}
