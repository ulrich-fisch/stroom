// Stroom: inhoud (titels), advertensies en die admin-roetes.
// Net die eienaar (ADMIN_EMAIL) mag admin-roetes gebruik. Advertensies word slegs aan gratis lede gewys.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const TIPES = ['Dokumentêr', 'Kortfilm', 'Speelfilm', 'Reeks'];
export const GENRES = { aksie: 'Aksie & Spanning', komedie: 'Komedie', dokumenter: 'Dokumentêre', drama: 'Drama', kuns: 'Kuns & Musiek' };
const STATUSSE = ['gepubliseer', 'konsep'];
const INSKRYWING_STATUSSE = ['hangende', 'goedgekeur', 'afgekeur'];

export const adminOk = (u, env) => !!(u && env.ADMIN_EMAIL && u.email === String(env.ADMIN_EMAIL).trim().toLowerCase());
const isHttps = (s) => /^https:\/\/[^\s"'<>]+$/i.test(s);
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
    if (!titel || !isHttps(url || '')) return null;
    out.push({ ep: clip(ep, 12) || `Ep ${out.length + 1}`, titel: clip(titel, 120), duur: clip(duur, 20), beskrywing: clip(beskrywing, 300), url });
  }
  return out;
}
const episodesToText = (json_) => { try { return JSON.parse(json_).map((e) => [e.ep, e.titel, e.duur, e.beskrywing, e.url].join(' | ')).join('\n'); } catch { return ''; } };
const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'titel';

// Wat 'n lid sien: nooit die video-adres nie (dit kom eers by /api/speel)
const publiek = (r) => ({ slug: r.slug, titel: r.titel, tipe: r.tipe, jaar: r.jaar, ouderdom: r.ouderdom, speeltyd: r.speeltyd,
  regisseur: r.regisseur, genre_sleutel: r.genre_sleutel, genre_etiket: r.genre_etiket, banner: r.banner, sinopsis: r.sinopsis,
  pas: r.pas, uitgelig: !!r.uitgelig, episodes: JSON.parse(r.episodes || '[]').map((e) => ({ ep: e.ep, titel: e.titel, duur: e.duur, beskrywing: e.beskrywing })) });

// Hoofhanteerder. Gee null terug as die pad nie hier hoort nie.
export async function handleContent({ request, env, path, post, u }) {
  if (!(path === '/api/katalogus' || path === '/api/speel' || path.startsWith('/api/admin/'))) return null;
  const db = env.DB;
  const isAdmin = adminOk(u, env);
  const body = post ? await request.json().catch(() => ({})) : {};

  // ----- Lede -----
  if (path === '/api/katalogus' && !post) {
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
    const rows = await db.prepare("SELECT * FROM titels WHERE status = 'gepubliseer' ORDER BY uitgelig DESC, id ASC").all();
    return json({ plan: u.plan, titels: rows.results.map(publiek) });
  }

  if (path === '/api/speel' && post) {
    if (!u) return json({ fout: 'Nie ingeteken nie.' }, 401);
    if (u.plan === 'none') return json({ fout: 'Kies eers jou plan.' }, 403);
    const t = await db.prepare("SELECT * FROM titels WHERE slug = ? AND status = 'gepubliseer'").bind(clip(body.slug, 80)).first();
    if (!t) return json({ fout: 'Nie gevind nie.' }, 404);
    let url = t.video_url, krediet = t.regisseur, titel = t.titel;
    if (body.ep != null) {
      const eps = JSON.parse(t.episodes || '[]'); const e = eps[Number(body.ep)];
      if (!e) return json({ fout: 'Nie gevind nie.' }, 404);
      url = e.url; titel = `${t.titel} - ${e.titel}`; krediet = e.duur || t.regisseur;
    }
    if (!url) return json({ fout: 'Hierdie titel is nog nie gereed om te speel nie.' }, 404);
    let advertensies = [];
    if (u.plan === 'avod') {          // Premium (svod) kry nooit advertensies nie
      const ads = await db.prepare('SELECT id, naam, video_url, klik_url FROM advertensies WHERE aktief = 1').all();
      if (ads.results.length) {
        const ad = ads.results[Math.floor(Math.random() * ads.results.length)];
        await db.prepare('UPDATE advertensies SET vertonings = vertonings + 1 WHERE id = ?').bind(ad.id).run();
        advertensies = [{ naam: ad.naam, url: ad.video_url, klik: ad.klik_url || null }];
      }
    }
    return json({ url, titel, krediet, plan: u.plan, advertensies });
  }

  // ----- Admin (slegs eienaar; almal anders kry "nie gevind") -----
  if (!path.startsWith('/api/admin/')) return null;
  if (!isAdmin) return json({ fout: 'Nie gevind nie.' }, 404);

  if (path === '/api/admin/titels' && !post) {
    const rows = await db.prepare('SELECT * FROM titels ORDER BY id DESC').all();
    return json({ titels: rows.results.map((r) => ({ ...r, uitgelig: !!r.uitgelig, episodes_teks: episodesToText(r.episodes) })), tipes: TIPES, genres: GENRES });
  }

  if (path === '/api/admin/titel' && post) {
    const titel = clip(body.titel, 120);
    const tipe = TIPES.includes(body.tipe) ? body.tipe : null;
    const status = STATUSSE.includes(body.status) ? body.status : 'konsep';
    const genre = GENRES[body.genre_sleutel] ? body.genre_sleutel : null;
    const banner = clip(body.banner, 400), video = clip(body.video_url, 400);
    if (!titel || !tipe || !genre) return json({ fout: 'Titel, tipe en genre is verpligtend.' }, 400);
    if (banner && !isHttps(banner)) return json({ fout: 'Die beeld-skakel moet met https:// begin.' }, 400);
    if (video && !isHttps(video)) return json({ fout: 'Die video-skakel moet met https:// begin.' }, 400);
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
    if (!naam || !isHttps(video)) return json({ fout: 'Naam en \'n https:// video-skakel is verpligtend.' }, 400);
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
