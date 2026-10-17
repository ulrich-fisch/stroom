// Stroom: inhoud (titels), advertensies en die admin-roetes.
// Net die eienaar (ADMIN_EMAIL) mag admin-roetes gebruik. Advertensies word slegs aan gratis lede gewys.

import { eiProfiel, kinderVeilig } from './lede.js';
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const TIPES = ['Dokumentêr', 'Kortfilm', 'Speelfilm', 'Reeks'];
export const GENRES = {
  aksie: 'Aksie & Spanning', avontuur: 'Avontuur', animasie: 'Animasie', biografie: 'Biografie', dokumenter: 'Dokumentêre', drama: 'Drama',
  familie: 'Familie & Kinders', fantasie: 'Fantasie', geloof: 'Geloof & Inspirasie', geskiedenis: 'Geskiedenis', gruwel: 'Gruwel',
  komedie: 'Komedie', kultuur: 'Kultuur & Erfenis', kuns: 'Kuns & Musiek', liefde: 'Romanse', misdaad: 'Misdaad & Riller',
  natuur: 'Natuur & Wild', oorlog: 'Oorlog & Militêr', platteland: 'Platteland & Boerdery', reis: 'Reis & Kos', sport: 'Sport',
  wetenskap: 'Wetenskap & Tegnologie', wetenskapfiksie: 'Wetenskapfiksie',
};
const STATUSSE = ['gepubliseer', 'konsep'];
const INSKRYWING_STATUSSE = ['hangende', 'goedgekeur', 'afgekeur'];

export const adminOk = (u, env) => !!(u && env.ADMIN_EMAIL && u.email === String(env.ADMIN_EMAIL).trim().toLowerCase());
const isHttps = (s) => /^https:\/\/[^\s"'<>]+$/i.test(s);
// Media-adres: 'n https-skakel of 'n eie opgelaaide lêer (/media/<sleutel>)
const MEDIA_RE = /^\/media\/[a-f0-9]{24}\.(mp4|webm|m4v|jpg|jpeg|png|webp)$/;
const isMedia = (s) => isHttps(s) || MEDIA_RE.test(s);
// Groot films lê by Cloudflare Stream; ons bewaar net die verwysing "stream:<32 hex>"
const STREAM_RE = /^stream:[a-f0-9]{32}$/;
const isVideo = (s) => isMedia(s) || STREAM_RE.test(s);
const streamOk = (env) => !!(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN && /^[a-z0-9]+$/i.test(String(env.STREAM_CODE || '')));
const streamBase = (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;
const b64 = (t) => btoa(unescape(encodeURIComponent(t)));
export const MEDIA_KEY = /^[a-f0-9]{24}\.(mp4|webm|m4v|jpg|jpeg|png|webp)$/;
const MEDIA_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_UPLOAD = 90 * 1024 * 1024;   // Workers aanvaar tot ~100 MB per versoek
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export async function createContentTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS titels (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, titel TEXT NOT NULL, tipe TEXT NOT NULL,
      jaar TEXT, ouderdom TEXT, speeltyd TEXT, regisseur TEXT, genre_sleutel TEXT, genre_etiket TEXT,
      banner TEXT, video_url TEXT, sinopsis TEXT, episodes TEXT NOT NULL DEFAULT '[]', pas INTEGER NOT NULL DEFAULT 90,
      uitgelig INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'konsep', created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS advertensies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, video_url TEXT NOT NULL, klik_url TEXT,
      aktief INTEGER NOT NULL DEFAULT 1, vertonings INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
  ]);
}

const V = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/';
const DEMO = [
  ['karoo', 'Die Erfenis van die Karoo', 'Dokumentêr', '2026', '13+', '54 min', 'Fischbowl Media', 'dokumenter', 'Kultuur & Erfenis', 'photo-1509316975850-ff9c5deb0cd9', 'ForBiggerBlazes.mp4', "'n Visuele meesterstuk wat die stilte, die argitektuur en die menslikheid van die Karoo vasvang. Eksklusief op Stroom.", 98, 1],
  ['spoorloos', 'Spoorloos in die Nag', 'Kortfilm', '2025', '16+', '14 min', 'Piet Joubert', 'drama', 'Drama & Spanning', 'photo-1485846234645-a62644f84728', 'ElephantsDream.mp4', "Wanneer 'n geheimsinnige vreemdeling op 'n stil plattelandse dorp aankom, ontrafel 'n ou familiegeheim.", 95, 0],
  ['laaste', 'Die Laaste Opvoer', 'Kortfilm', '2024', '13+', '22 min', 'Annelize Marais', 'kuns', 'Kuns & Musiek', 'photo-1514525253161-7a46d19cd819', 'TearsOfSteel.mp4', "'n Begaagde klavierspeler veg teen tyd en verlies om haar finale optrede in die Historiese Teater van Stellenbosch te lewer.", 92, 0],
  ['pretoria', 'Nagval oor Pretoria', 'Reeks', '2025', '16+', 'Seisoen 1', 'Jaco Botes', 'aksie', 'Aksie & Spanning', 'photo-1519501025264-65ba15a82390', 'SubaruOutbackOnStreetAndDirt.mp4', "'n Hoë-spanning polisiereeks wat afspeel in die nagtelike strate van Pretoria.", 96, 0],
  ['sout', 'Sout van die Aarde', 'Dokumentêr', '2025', 'AL', '52 min', 'Fischbowl Media', 'dokumenter', 'Dokumentêr', 'photo-1500382017468-9049fed747ef', 'ForBiggerEscapes.mp4', "'n Hartroerende blik op die boerderygemeenskappe van Suid-Afrika.", 94, 0],
];
const DEMO_EPISODES = JSON.stringify([
  { ep: 'Ep 1', titel: 'Die Eerste Skaduwee', duur: '28 min', beskrywing: "Speurder Nel ondersoek 'n inbraak in die hoofstad.", url: V + 'SubaruOutbackOnStreetAndDirt.mp4' },
  { ep: 'Ep 2', titel: 'Geheime Spore', duur: '31 min', beskrywing: "'n Belangrike getuie weier om met die polisie te praat.", url: V + 'ForBiggerEscapes.mp4' },
]);

// Eerste keer: sit die demo-inhoud en een toets-advertensie in (slegs as die tabelle leeg is)
export async function seedContent(db) {
  const t = await db.prepare('SELECT COUNT(*) AS n FROM titels').first();
  if (!t.n) {
    for (const d of DEMO) {
      await db.prepare(`INSERT INTO titels (slug, titel, tipe, jaar, ouderdom, speeltyd, regisseur, genre_sleutel, genre_etiket, banner, video_url, sinopsis, pas, uitgelig, episodes, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gepubliseer', ?)`)
        .bind(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], `https://images.unsplash.com/${d[9]}?auto=format&fit=crop&w=1600&q=80`, V + d[10], d[11], d[12], d[13], d[0] === 'pretoria' ? DEMO_EPISODES : '[]', Date.now()).run();
    }
  }
  const a = await db.prepare('SELECT COUNT(*) AS n FROM advertensies').first();
  if (!a.n) {
    await db.prepare('INSERT INTO advertensies (naam, video_url, klik_url, created_at) VALUES (?, ?, ?, ?)')
      .bind('Toets-advertensie', V + 'ForBiggerFun.mp4', 'https://stroom.example', Date.now()).run();
  }
}

// Episodes: een per lyn, "Ep 1 | Titel | 28 min | Beskrywing | https://..."
function parseEpisodes(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [ep, titel, duur, beskrywing, url] = line.split('|').map((x) => x.trim());
    if (!titel || !isVideo(url || '')) return null;
    out.push({ ep: clip(ep, 12) || `Ep ${out.length + 1}`, titel: clip(titel, 120), duur: clip(duur, 20), beskrywing: clip(beskrywing, 300), url });
  }
  return out;
}
const episodesToText = (json_) => { try { return JSON.parse(json_).map((e) => [e.ep, e.titel, e.duur, e.beskrywing, e.url].join(' | ')).join('\n'); } catch { return ''; } };
const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'titel';

// Wat 'n lid sien: nooit die video-adres nie (dit kom eers by /api/speel)
const publiek = (r) => ({ slug: r.slug, titel: r.titel, tipe: r.tipe, jaar: r.jaar, ouderdom: r.ouderdom, speeltyd: r.speeltyd,
  regisseur: r.regisseur, genre_sleutel: r.genre_sleutel, genre_etiket: r.genre_etiket, banner: r.banner, sinopsis: r.sinopsis,
  gem: r.gem == null ? null : Math.round(r.gem * 10) / 10, aantal: r.aantal || 0, myne: r.myne || 0, uitgelig: !!r.uitgelig, episodes: JSON.parse(r.episodes || '[]').map((e) => ({ ep: e.ep, titel: e.titel, duur: e.duur, beskrywing: e.beskrywing })) });

// Hoofhanteerder. Gee null terug as die pad nie hier hoort nie.
export async function handleContent({ request, env, path, post, u }) {
  if (!(path === '/api/katalogus' || path === '/api/speel' || path.startsWith('/api/admin/'))) return null;
  const db = env.DB;
  const isAdmin = adminOk(u, env);
  // Lêer-oplaai (rou lêer, nie JSON nie) - slegs die eienaar
  if (path === '/api/admin/laai-op' && post) {
    if (!isAdmin) return json({ fout: 'Nie gevind nie.' }, 404);
    if (!env.VIDEOS) return json({ fout: 'Lêer-bewaring is nog nie opgestel nie (R2).' }, 503);
    const ext = String(new URL(request.url).searchParams.get('ext') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!MEDIA_TYPES[ext]) return json({ fout: 'Kies \'n MP4- of WebM-video, of \'n JPG/PNG/WEBP-beeld. (MKV/AVI moet eers na MP4 omgesit word, bv. met HandBrake.)' }, 400);
    const len = Number(request.headers.get('Content-Length') || 0);
    if (!len) return json({ fout: 'Leë lêer.' }, 400);
    if (len > MAX_UPLOAD) return json({ fout: 'Die lêer is te groot (maks 90 MB). Druk dit eers kleiner met HandBrake.' }, 413);
    const key = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('') + '.' + ext;
    await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: MEDIA_TYPES[ext] } });
    return json({ ok: true, url: '/media/' + key });
  }
  // Groot films: Cloudflare Stream (die blaaier laai direk op, die geheime sleutel bly op die bediener)
  if (path === '/api/admin/stream-laai-op' && post) {
    if (!isAdmin) return json({ fout: 'Nie gevind nie.' }, 404);
    if (!streamOk(env)) return json({ fout: 'Cloudflare Stream is nog nie opgestel nie.' }, 503);
    const b = await request.json().catch(() => ({}));
    const size = Number(b.size);
    if (!Number.isFinite(size) || size < 1 || size > 30 * 1024 ** 3) return json({ fout: 'Ongeldige lêergrootte.' }, 400);
    const r = await fetch(`${streamBase(env)}/stream?direct_user=true`, { method: 'POST', headers: {
      Authorization: `Bearer ${env.CF_STREAM_TOKEN}`, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(Math.floor(size)),
      'Upload-Metadata': `maxDurationSeconds ${b64('14400')},requiresignedurls ,name ${b64(clip(b.naam, 100) || 'video')}` } });
    const loc = r.headers.get('Location');
    if (!r.ok || !loc) return json({ fout: 'Cloudflare het die oplaai geweier. Kyk of Stream geaktiveer is en of daar genoeg opberging is.' }, 502);
    const uid = r.headers.get('stream-media-id') || (loc.match(/\/([a-f0-9]{32})(?:[/?]|$)/) || [])[1];
    if (!uid || !/^[a-f0-9]{32}$/.test(uid)) return json({ fout: 'Kon nie die video-ID kry nie.' }, 502);
    return json({ ok: true, uploadUrl: loc, uid, verwysing: 'stream:' + uid });
  }
  if (path === '/api/admin/stream-status' && !post) {
    if (!isAdmin) return json({ fout: 'Nie gevind nie.' }, 404);
    if (!streamOk(env)) return json({ fout: 'Cloudflare Stream is nog nie opgestel nie.' }, 503);
    const uid = String(new URL(request.url).searchParams.get('uid') || '');
    if (!/^[a-f0-9]{32}$/.test(uid)) return json({ fout: 'Ongeldig.' }, 400);
    const r = await fetch(`${streamBase(env)}/stream/${uid}`, { headers: { Authorization: `Bearer ${env.CF_STREAM_TOKEN}` } });
    const d = await r.json().catch(() => ({}));
    const v = d.result || {};
    if (!r.ok || !v.uid) return json({ fout: 'Nie gevind nie.' }, 404);
    return json({ ok: true, toestand: (v.status && v.status.state) || 'onbekend', gereed: !!v.readyToStream, duur: v.duration || 0, fout_kode: (v.status && v.status.errorReasonCode) || '' });
  }
  const body = post ? await request.json().catch(() => ({})) : {};

  // ----- Lede -----
  if (path === '/api/katalogus' && !post) {
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
    const pidRaw = new URL(request.url).searchParams.get('profiel');
    const prof = pidRaw ? await eiProfiel(db, u, pidRaw) : null;
    if (pidRaw && !prof) return json({ fout: 'Kies eers \'n profiel.' }, 400);
    const rows = await db.prepare("SELECT * FROM titels WHERE status = 'gepubliseer' ORDER BY uitgelig DESC, id ASC").all();
    const agg = new Map((await db.prepare('SELECT slug, AVG(sterre) AS gem, COUNT(*) AS aantal FROM gradering GROUP BY slug').all()).results.map((x) => [x.slug, x]));
    const mine = new Map(prof ? (await db.prepare('SELECT slug, sterre FROM gradering WHERE profiel_id = ?').bind(prof.id).all()).results.map((x) => [x.slug, x.sterre]) : []);
    let list = rows.results;
    if (prof && prof.kinders) list = list.filter((r) => kinderVeilig(r.ouderdom));
    return json({ plan: u.plan, kinders: !!(prof && prof.kinders), genres: GENRES,
      titels: list.map((r) => publiek({ ...r, gem: (agg.get(r.slug) || {}).gem, aantal: (agg.get(r.slug) || {}).aantal, myne: mine.get(r.slug) })) });
  }

  if (path === '/api/speel' && post) {
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
    const t = await db.prepare("SELECT * FROM titels WHERE slug = ? AND status = 'gepubliseer'").bind(clip(body.slug, 80)).first();
    if (!t) return json({ fout: 'Nie gevind nie.' }, 404);
    const prof = body.profiel ? await eiProfiel(db, u, body.profiel) : null;
    if (body.profiel && !prof) return json({ fout: 'Kies eers \'n profiel.' }, 400);
    if (prof && prof.kinders && !kinderVeilig(t.ouderdom)) return json({ fout: 'Hierdie titel is nie vir \'n kinderprofiel nie.' }, 403);
    let url = t.video_url, krediet = t.regisseur, titel = t.titel;
    if (body.ep != null) {
      const eps = JSON.parse(t.episodes || '[]'); const e = eps[Number(body.ep)];
      if (!e) return json({ fout: 'Nie gevind nie.' }, 404);
      url = e.url; titel = `${t.titel} - ${e.titel}`; krediet = e.duur || t.regisseur;
    }
    if (!url) return json({ fout: 'Hierdie titel is nog nie gereed om te speel nie.' }, 404);
    let hls = false;
    if (STREAM_RE.test(url)) {
      if (!streamOk(env)) return json({ fout: 'Die video-diens is nog nie opgestel nie.' }, 503);
      const uid = url.slice(7);
      const tr = await fetch(`${streamBase(env)}/stream/${uid}/token`, { method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_STREAM_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 6 * 3600 }) });
      const td = await tr.json().catch(() => ({}));
      if (!tr.ok || !td.result || !td.result.token) return json({ fout: 'Kon nie nou speel nie. Probeer asseblief weer.' }, 502);
      url = `https://customer-${env.STREAM_CODE}.cloudflarestream.com/${td.result.token}/manifest/video.m3u8`; hls = true;
    }
    let advertensies = [];
    if (u.plan === 'avod') {          // Premium (svod) kry nooit advertensies nie
      const ads = await db.prepare('SELECT id, naam, video_url, klik_url FROM advertensies WHERE aktief = 1').all();
      if (ads.results.length) {
        const ad = ads.results[Math.floor(Math.random() * ads.results.length)];
        await db.prepare('UPDATE advertensies SET vertonings = vertonings + 1 WHERE id = ?').bind(ad.id).run();
        advertensies = [{ naam: ad.naam, url: ad.video_url, klik: ad.klik_url || null }];
      }
    }
    let begin = 0;
    if (prof && !body.herbegin) {
      const v = await db.prepare('SELECT ep, posisie, voltooi FROM vordering WHERE profiel_id = ? AND slug = ?').bind(prof.id, t.slug).first();
      const wantEp = body.ep == null ? -1 : Number(body.ep);
      if (v && !v.voltooi && v.ep === wantEp && v.posisie > 5) begin = Math.max(0, v.posisie - 3);   // 'n paar sekondes terug
    }
    return json({ url, hls, begin, slug: t.slug, ep: body.ep == null ? null : Number(body.ep), titel, krediet, plan: u.plan, advertensies });
  }

  // ----- Admin (slegs eienaar; almal anders kry "nie gevind") -----
  if (!path.startsWith('/api/admin/')) return null;
  if (!isAdmin) return json({ fout: 'Nie gevind nie.' }, 404);

  if (path === '/api/admin/titels' && !post) {
    const rows = await db.prepare('SELECT * FROM titels ORDER BY id DESC').all();
    const agg = new Map((await db.prepare('SELECT slug, AVG(sterre) AS gem, COUNT(*) AS aantal FROM gradering GROUP BY slug').all()).results.map((x) => [x.slug, x]));
    return json({ titels: rows.results.map((r) => ({ ...r, uitgelig: !!r.uitgelig, episodes_teks: episodesToText(r.episodes),
      gem: agg.get(r.slug) ? Math.round(agg.get(r.slug).gem * 10) / 10 : null, aantal: agg.get(r.slug) ? agg.get(r.slug).aantal : 0 })), tipes: TIPES, genres: GENRES });
  }

  if (path === '/api/admin/titel' && post) {
    const titel = clip(body.titel, 120);
    const tipe = TIPES.includes(body.tipe) ? body.tipe : null;
    const status = STATUSSE.includes(body.status) ? body.status : 'konsep';
    const genre = GENRES[body.genre_sleutel] ? body.genre_sleutel : null;
    const banner = clip(body.banner, 400), video = clip(body.video_url, 400);
    if (!titel || !tipe || !genre) return json({ fout: 'Titel, tipe en genre is verpligtend.' }, 400);
    if (banner && !isMedia(banner)) return json({ fout: 'Die beeld moet \'n https://-skakel of \'n opgelaaide lêer wees.' }, 400);
    if (video && !isVideo(video)) return json({ fout: 'Die video moet \'n https://-skakel, \'n opgelaaide lêer of \'n Stream-video wees.' }, 400);
    const eps = parseEpisodes(body.episodes_teks);
    if (eps === null) return json({ fout: 'Episodes: een per lyn as  Ep 1 | Titel | 28 min | Beskrywing | https://...' }, 400);
    if (status === 'gepubliseer' && !banner) return json({ fout: 'Gepubliseerde titels het \'n beeld nodig.' }, 400);
    if (status === 'gepubliseer' && !video && !eps.length) return json({ fout: 'Gepubliseerde titels het \'n video-skakel (of episodes) nodig.' }, 400);
    const pas = Math.max(0, Math.min(100, parseInt(body.pas, 10) || 90));
    const vals = [titel, tipe, clip(body.jaar, 4), clip(body.ouderdom, 6), clip(body.speeltyd, 20), clip(body.regisseur, 80), genre, GENRES[genre],
      banner, video, clip(body.sinopsis, 2000), JSON.stringify(eps), pas, body.uitgelig ? 1 : 0, status];
    if (body.uitgelig) await db.prepare('UPDATE titels SET uitgelig = 0').run();
    if (body.id) {
      await db.prepare(`UPDATE titels SET titel=?, tipe=?, jaar=?, ouderdom=?, speeltyd=?, regisseur=?, genre_sleutel=?, genre_etiket=?, banner=?, video_url=?,
        sinopsis=?, episodes=?, pas=?, uitgelig=?, status=? WHERE id = ?`).bind(...vals, Number(body.id)).run();
      return json({ ok: true });
    }
    let slug = slugify(titel);
    const exists = await db.prepare('SELECT 1 AS x FROM titels WHERE slug = ?').bind(slug).first();
    if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    await db.prepare(`INSERT INTO titels (titel, tipe, jaar, ouderdom, speeltyd, regisseur, genre_sleutel, genre_etiket, banner, video_url,
      sinopsis, episodes, pas, uitgelig, status, slug, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...vals, slug, Date.now()).run();
    return json({ ok: true, slug });
  }

  if (path === '/api/admin/titel-skrap' && post) {
    await db.prepare('DELETE FROM titels WHERE id = ?').bind(Number(body.id)).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/ads' && !post) {
    const rows = await db.prepare('SELECT * FROM advertensies ORDER BY id DESC').all();
    return json({ advertensies: rows.results.map((r) => ({ ...r, aktief: !!r.aktief })) });
  }

  if (path === '/api/admin/ad' && post) {
    const naam = clip(body.naam, 80), video = clip(body.video_url, 400), klik = clip(body.klik_url, 400);
    if (!naam || !isMedia(video)) return json({ fout: 'Naam en \'n video (https://-skakel of opgelaaide lêer) is verpligtend.' }, 400);
    if (klik && !isHttps(klik)) return json({ fout: 'Die klik-skakel moet met https:// begin.' }, 400);
    if (body.id) await db.prepare('UPDATE advertensies SET naam=?, video_url=?, klik_url=?, aktief=? WHERE id = ?').bind(naam, video, klik || null, body.aktief ? 1 : 0, Number(body.id)).run();
    else await db.prepare('INSERT INTO advertensies (naam, video_url, klik_url, aktief, created_at) VALUES (?,?,?,?,?)').bind(naam, video, klik || null, body.aktief === false ? 0 : 1, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/ad-skrap' && post) {
    await db.prepare('DELETE FROM advertensies WHERE id = ?').bind(Number(body.id)).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/inskrywings' && !post) {
    const rows = await db.prepare('SELECT id, name, email, title, type, link, synopsis, status, created_at FROM indienings ORDER BY id DESC LIMIT 200').all();
    return json({ inskrywings: rows.results.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) });
  }

  if (path === '/api/admin/inskrywing-status' && post) {
    if (!INSKRYWING_STATUSSE.includes(body.status)) return json({ fout: 'Ongeldige status.' }, 400);
    await db.prepare('UPDATE indienings SET status = ? WHERE id = ?').bind(body.status, Number(body.id)).run();
    return json({ ok: true });
  }

  // Toetshulp: wissel jou eie plan sonder betaling (slegs buite lewendige modus)
  if (path === '/api/admin/toets-plan' && post) {
    if (env.PAYFAST_MODE === 'live') return json({ fout: 'Nie beskikbaar in lewendige modus nie.' }, 403);
    if (!['avod', 'svod'].includes(body.plan)) return json({ fout: 'Ongeldige plan.' }, 400);
    await db.prepare('UPDATE users SET plan = ?, plan_period = NULL WHERE id = ?').bind(body.plan, u.id).run();
    return json({ ok: true, plan: body.plan });
  }

  return json({ fout: 'Nie gevind nie.' }, 404);
}

// Bedien opgelaaide media (slegs vir ingetekende lede met 'n plan), met Range-ondersteuning vir video
export async function serveMedia(request, env, u, key) {
  if (!u) return new Response('Nie ingeteken nie.', { status: 401 });
  if (u.plan === 'none') return new Response('Kies eers jou plan.', { status: 403 });
  if (!env.VIDEOS || !MEDIA_KEY.test(key)) return new Response('Nie gevind nie.', { status: 404 });
  const ranged = request.headers.has('Range');
  const obj = await env.VIDEOS.get(key, ranged ? { range: request.headers } : undefined);
  if (!obj) return new Response('Nie gevind nie.', { status: 404 });
  const headers = { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  let status = 200;
  if (ranged && obj.range) {
    let { offset, length, suffix } = obj.range;
    if (suffix != null) { offset = obj.size - suffix; length = suffix; }
    offset = offset || 0; length = length == null ? obj.size - offset : length;
    headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${obj.size}`; headers['Content-Length'] = String(length); status = 206;
  } else headers['Content-Length'] = String(obj.size);
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}
