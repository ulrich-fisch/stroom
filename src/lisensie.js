// Stroom: lisensie-ooreenkomste en dokumente per titel (slegs vir die admin).
// Die titel se lisensie-einddatum wys hoe lank dit nog op Stroom mag bly; ooreenkomste en papierwerk word per titel bewaar.

import { vandag } from './verslae.js';
import { datumOk } from './binnekort.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
import { adminOk } from './admin.js';
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export const LISENSIE_COLUMNS = [['titels', 'lisensie_begin', 'TEXT'], ['titels', 'lisensie_einde', 'TEXT'], ['titels', 'lisensie_besluit', 'TEXT'],
  ['titels', 'regshebber', 'TEXT'], ['titels', 'regshebber_kontak', 'TEXT'], ['titels', 'admin_notas', 'TEXT']];
export const dokumenteStatements = (db) => [
  db.prepare(`CREATE TABLE IF NOT EXISTS dokumente (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, naam TEXT NOT NULL, soort TEXT NOT NULL, sleutel TEXT NOT NULL, ext TEXT NOT NULL,
    grootte INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
  db.prepare('CREATE INDEX IF NOT EXISTS dokumente_slug ON dokumente (slug)'),
];

export const BESLUITE = { '': 'Nog nie besluit nie', hernu: 'Hernu die ooreenkoms', nuut: 'Nuwe ooreenkoms nodig', geen: 'Geen verdere ooreenkoms nie' };
export const SOORTE = { ooreenkoms: 'Lisensie-ooreenkoms', kontrak: 'Kontrak', faktuur: 'Faktuur / betaling', toestemming: 'Toestemming / klaring', ander: 'Ander' };
export const WAARSKU_DAE = 90;   // 3 maande

// Hoeveel dae oor (Suid-Afrikaanse datum). Vlak: geen (geen datum), ok, waarsku (<= 90 dae), verval (verby)
export function lisensieInfo(einde, now = Date.now()) {
  if (!einde) return { dae: null, vlak: 'geen' };
  const dae = Math.round((Date.parse(einde + 'T00:00:00Z') - Date.parse(vandag(now) + 'T00:00:00Z')) / 86400000);
  return { dae, vlak: dae < 0 ? 'verval' : dae <= WAARSKU_DAE ? 'waarsku' : 'ok' };
}

// Lees en bekragtig die lisensie-velde van 'n titel-vorm. Gee { fout } of { waardes }.
export function lisensieVelde(body) {
  const begin = clip(body.lisensie_begin, 10), einde = clip(body.lisensie_einde, 10), besluit = clip(body.lisensie_besluit, 10);
  if (!datumOk(begin) || !datumOk(einde)) return { fout: 'Lisensie-datums moet soos 2027-03-31 wees.' };
  if (begin && einde && einde < begin) return { fout: 'Die lisensie moet eindig ná dit begin.' };
  if (!(besluit in BESLUITE)) return { fout: 'Ongeldige besluit oor die ooreenkoms.' };
  return { waardes: [begin, einde, besluit, clip(body.regshebber, 120), clip(body.regshebber_kontak, 200), clip(body.admin_notas, 4000)] };
}
export const LISENSIE_SET = 'lisensie_begin = ?, lisensie_einde = ?, lisensie_besluit = ?, regshebber = ?, regshebber_kontak = ?, admin_notas = ?';

const TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const MAX_DOK = 20 * 1024 * 1024;
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
const veiligeNaam = (s) => String(s).replace(/[^\p{L}\p{N} ._()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);

// Verwyder alle dokumente van 'n titel (lêers en rye)
export async function skrapDokumente(env, slug) {
  const rows = (await env.DB.prepare('SELECT sleutel FROM dokumente WHERE slug = ?').bind(slug).all()).results;
  for (const r of rows) { try { if (env.VIDEOS) await env.VIDEOS.delete(r.sleutel); } catch { /* lêer was reeds weg */ } }
  await env.DB.prepare('DELETE FROM dokumente WHERE slug = ?').bind(slug).run();
}

const PATHS = new Set(['/api/admin/dokumente', '/api/admin/dokument', '/api/admin/dokument-laai-op', '/api/admin/dokument-skrap']);
export const isDokumentPath = (p) => PATHS.has(p);

export async function handleDokumente({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
  const db = env.DB, q = new URL(request.url).searchParams;
  const kyk = (r) => ({ id: r.id, naam: r.naam, soort: r.soort, soort_etiket: SOORTE[r.soort] || r.soort, ext: r.ext, grootte: r.grootte, op: r.created_at });

  if (path === '/api/admin/dokumente' && !post) {
    const slug = clip(q.get('slug'), 80); if (!slugOk(slug)) return json({ fout: 'Ongeldig.' }, 400);
    const rows = (await db.prepare('SELECT * FROM dokumente WHERE slug = ? ORDER BY created_at DESC, id DESC').bind(slug).all()).results;
    return json({ dokumente: rows.map(kyk), soorte: SOORTE });
  }
  if (path === '/api/admin/dokument' && !post) {
    const r = await db.prepare('SELECT * FROM dokumente WHERE id = ?').bind(Number(q.get('id'))).first();
    if (!r || !env.VIDEOS) return json({ fout: 'Nie gevind nie.' }, 404);
    const obj = await env.VIDEOS.get(r.sleutel);
    if (!obj) return json({ fout: 'Die lêer is nie meer in die bewaring nie.' }, 404);
    const lêer = (veiligeNaam(r.naam).replace(/\.[a-z0-9]{2,5}$/i, '') || 'dokument') + '.' + r.ext;
    return new Response(obj.body, { headers: { 'Content-Type': TYPES[r.ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${lêer.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(lêer)}`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(obj.size) } });
  }
  if (path === '/api/admin/dokument-laai-op' && post) {
    if (!env.VIDEOS) return json({ fout: 'Lêer-bewaring is nog nie opgestel nie (R2).' }, 503);
    const slug = clip(q.get('slug'), 80), ext = clip(q.get('ext'), 6).toLowerCase().replace(/[^a-z0-9]/g, ''), soort = clip(q.get('soort'), 20);
    if (!slugOk(slug) || !(await db.prepare('SELECT 1 AS x FROM titels WHERE slug = ?').bind(slug).first())) return json({ fout: 'Stoor die titel eers, dan kan jy dokumente byvoeg.' }, 404);
    if (!TYPES[ext]) return json({ fout: 'Kies \'n PDF, Word, Excel, teks- of beeldlêer (PDF, DOCX, XLSX, JPG, PNG...).' }, 400);
    if (!(soort in SOORTE)) return json({ fout: 'Kies die soort dokument.' }, 400);
    const len = Number(request.headers.get('Content-Length') || 0);
    if (!len) return json({ fout: 'Leë lêer.' }, 400);
    if (len > MAX_DOK) return json({ fout: 'Die dokument is te groot (maks 20 MB).' }, 413);
    const naam = veiligeNaam(q.get('naam') || '') || 'Dokument';
    const sleutel = 'dok/' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('') + '.' + ext;
    await env.VIDEOS.put(sleutel, request.body, { httpMetadata: { contentType: TYPES[ext] } });
    const res = await db.prepare('INSERT INTO dokumente (slug, naam, soort, sleutel, ext, grootte, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(slug, naam, soort, sleutel, ext, len, Date.now()).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (path === '/api/admin/dokument-skrap' && post) {
    const body = await request.json().catch(() => ({}));
    const r = await db.prepare('SELECT * FROM dokumente WHERE id = ?').bind(Number(body.id)).first();
    if (!r) return json({ fout: 'Nie gevind nie.' }, 404);
    try { if (env.VIDEOS) await env.VIDEOS.delete(r.sleutel); } catch { /* reeds weg */ }
    await db.prepare('DELETE FROM dokumente WHERE id = ?').bind(r.id).run();
    return json({ ok: true });
  }
  return json({ fout: 'Nie gevind nie.' }, 404);
}
