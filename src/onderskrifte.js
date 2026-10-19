// Stroom: onderskrifte (subtitles). Admin laai .vtt of .srt op per titel (en per episode) en taal;
// lede kry dit as WebVTT via /api/onderskrif. Die teks word in die databasis bewaar (klein lêers).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const adminOk = (u, env) => !!(u && env.ADMIN_EMAIL && u.email === String(env.ADMIN_EMAIL).trim().toLowerCase());

export const TALE = {
  af: 'Afrikaans', en: 'English', zu: 'isiZulu', xh: 'isiXhosa', st: 'Sesotho', tn: 'Setswana',
  nl: 'Nederlands', de: 'Deutsch', fr: 'Français', pt: 'Português',
};
const TS = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
const fmt = (m) => `${String(m[1] || 0).padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3]}.${m[4].padEnd(3, '0')}`;
const MAX_BYTES = 400 * 1024;
const CUE_RE = /(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

export const subtitleStatements = (db) => [
  db.prepare(`CREATE TABLE IF NOT EXISTS onderskrifte (
    slug TEXT NOT NULL, ep INTEGER NOT NULL DEFAULT -1, taal TEXT NOT NULL, vtt TEXT NOT NULL, cues INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, PRIMARY KEY (slug, ep, taal))`),
];

// SRT of VTT -> skoon WebVTT. Gee { vtt, cues } of { fout }.
export function toVtt(raw) {
  let t = String(raw == null ? '' : raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!t) return { fout: 'Die lêer is leeg.' };
  if (new TextEncoder().encode(t).length > MAX_BYTES) return { fout: 'Die lêer is te groot (maks 400 KB).' };
  if (/^WEBVTT/.test(t)) t = t.replace(/^WEBVTT[^\n]*\n?/, '');                      // kop word hieronder weer gesit
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out = []; let cues = 0;
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => CUE_RE.test(l));
    if (i < 0) continue;                                                              // NOTE/STYLE/REGION of rommel: weglaat
    const m = [...lines[i].matchAll(TS)];
    if (m.length < 2) continue;
    const norm = `${fmt(m[0])} --> ${fmt(m[1])}`;
    const tekst = lines.slice(i + 1).join('\n').trim();
    if (!tekst) continue;
    out.push(`${norm}\n${tekst}`); cues++;
  }
  if (!cues) return { fout: 'Geen onderskrif-reëls gevind nie. Gebruik \'n .srt- of .vtt-lêer.' };
  return { vtt: 'WEBVTT\n\n' + out.join('\n\n') + '\n', cues };
}

// Beskikbare tale vir 'n titel/episode (vir /api/speel)
export async function onderskrifLys(db, slug, ep) {
  const rows = (await db.prepare('SELECT taal FROM onderskrifte WHERE slug = ? AND ep = ? ORDER BY taal').bind(slug, ep).all()).results;
  return rows.map((r) => ({ taal: r.taal, label: TALE[r.taal] || r.taal }));
}

const PATHS = new Set(['/api/onderskrif', '/api/admin/onderskrifte', '/api/admin/onderskrif', '/api/admin/onderskrif-skrap']);
export const isSubtitlePath = (p) => PATHS.has(p);

const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
const epOk = (v) => (v == null || v === '' ? -1 : Number(v));

export async function handleSubtitles({ request, env, path, post, u }) {
  if (!PATHS.has(path)) return null;
  const db = env.DB;
  const q = new URL(request.url).searchParams;

  // Lede: die onderskrif self (VTT)
  if (path === '/api/onderskrif' && !post) {
    if (!u || u.plan === 'none') return json({ fout: 'Nie ingeteken nie.' }, 401);
    const slug = String(q.get('slug') || ''), taal = String(q.get('taal') || ''), ep = epOk(q.get('ep'));
    if (!slugOk(slug) || !TALE[taal] || !Number.isInteger(ep) || ep < -1) return json({ fout: 'Nie gevind nie.' }, 404);
    const r = await db.prepare('SELECT vtt FROM onderskrifte WHERE slug = ? AND ep = ? AND taal = ?').bind(slug, ep, taal).first();
    if (!r) return json({ fout: 'Nie gevind nie.' }, 404);
    return new Response(r.vtt, { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  }

  // Admin
  if (!adminOk(u, env)) return json({ fout: 'Nie gevind nie.' }, 404);
  if (path === '/api/admin/onderskrifte' && !post) {
    const slug = String(q.get('slug') || '');
    if (!slugOk(slug)) return json({ fout: 'Ongeldig.' }, 400);
    const rows = (await db.prepare('SELECT ep, taal, cues, LENGTH(vtt) AS grootte, created_at FROM onderskrifte WHERE slug = ? ORDER BY ep, taal').bind(slug).all()).results;
    return json({ onderskrifte: rows.map((r) => ({ ...r, label: TALE[r.taal] || r.taal })), tale: TALE });
  }
  const body = post ? await request.json().catch(() => ({})) : {};
  if (path === '/api/admin/onderskrif' && post) {
    const slug = String(body.slug || ''), taal = String(body.taal || ''), ep = epOk(body.ep);
    if (!slugOk(slug) || !TALE[taal] || !Number.isInteger(ep) || ep < -1 || ep > 500) return json({ fout: 'Kies \'n titel, episode en taal.' }, 400);
    const t = await db.prepare('SELECT episodes FROM titels WHERE slug = ?').bind(slug).first();
    if (!t) return json({ fout: 'Titel nie gevind nie. Stoor die titel eers.' }, 404);
    if (ep >= 0 && ep >= JSON.parse(t.episodes || '[]').length) return json({ fout: 'Daardie episode bestaan nie.' }, 400);
    const r = toVtt(body.teks);
    if (r.fout) return json({ fout: r.fout }, 400);
    await db.prepare('INSERT OR REPLACE INTO onderskrifte (slug, ep, taal, vtt, cues, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(slug, ep, taal, r.vtt, r.cues, Date.now()).run();
    return json({ ok: true, cues: r.cues });
  }
  if (path === '/api/admin/onderskrif-skrap' && post) {
    const slug = String(body.slug || ''), taal = String(body.taal || ''), ep = epOk(body.ep);
    if (!slugOk(slug) || !TALE[taal] || !Number.isInteger(ep)) return json({ fout: 'Ongeldig.' }, 400);
    await db.prepare('DELETE FROM onderskrifte WHERE slug = ? AND ep = ? AND taal = ?').bind(slug, ep, taal).run();
    return json({ ok: true });
  }
  return json({ fout: 'Nie gevind nie.' }, 404);
}
