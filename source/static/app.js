// Gedeelde kode vir alle ingetekende bladsye: profiele (op die bediener), profielwissel, afteken.
var AVATARS = ['#38bdf8,#0369a1', '#a78bfa,#6d28d9', '#fbbf24,#b45309', '#34d399,#047857', '#fb7185,#be123c', '#f472b6,#9d174d', '#22d3ee,#0e7490', '#94a3b8,#334155'];
function avatarBg(i) { return 'linear-gradient(135deg,' + AVATARS[(i >= 0 && i < AVATARS.length) ? i : 0] + ')'; }
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var selfProfile = '';
var profiles = [], maxProfiles = 5;
var activeProfileId = 0, activeKids = false, activeProfile = '', activeAvatar = 0;
try {
  activeProfileId = parseInt(localStorage.getItem('stroom_profiel_id') || '0', 10) || 0;
  activeKids = localStorage.getItem('stroom_profiel_kinders') === '1';
  activeProfile = localStorage.getItem('stroom_active_profile') || '';
  activeAvatar = parseInt(localStorage.getItem('stroom_profiel_avatar') || '0', 10) || 0;
} catch (e) {}

function selfName() { return selfProfile || 'Profiel'; }

function applyNames() {
  var el = document.getElementById('headerProfileName');
  if (el) el.textContent = activeProfile || selfName();
  var av = document.getElementById('headerAvatar');
  if (av) { av.textContent = (activeProfile || selfName()).charAt(0).toUpperCase(); av.style.background = avatarBg(activeAvatar); }
  document.querySelectorAll('[data-self]').forEach(function (n) { n.textContent = selfName(); });
  document.querySelectorAll('[data-self-initial]').forEach(function (n) { n.textContent = selfName().charAt(0).toUpperCase(); });
}
applyNames();

function setActiveProfile(p) {
  activeProfileId = p.id; activeKids = !!p.kinders; activeProfile = p.naam; activeAvatar = p.avatar || 0;
  try {
    localStorage.setItem('stroom_profiel_id', String(p.id));
    localStorage.setItem('stroom_profiel_kinders', p.kinders ? '1' : '0');
    localStorage.setItem('stroom_active_profile', p.naam);
    localStorage.setItem('stroom_profiel_avatar', String(p.avatar || 0));
  } catch (e) {}
}

function renderHeaderProfiles() {
  var box = document.getElementById('headerProfiles'); if (!box) return;
  box.innerHTML = profiles.map(function (p) {
    return '<div onclick="switchProfile(' + p.id + ')" class="flex items-center space-x-3 p-1.5 rounded-xl hover:bg-slate-800/80 cursor-pointer transition ' + (p.id === activeProfileId ? 'bg-slate-800/60' : '') + '">' +
      '<div class="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold text-white" style="background:' + avatarBg(p.avatar) + '">' + escHtml(p.naam.charAt(0).toUpperCase()) + '</div>' +
      '<span class="text-xs text-slate-200 font-semibold">' + escHtml(p.naam) + '</span>' + (p.kinders ? '<span class="text-[9px] text-amber-300 border border-amber-400/40 rounded px-1">KINDERS</span>' : '') + '</div>';
  }).join('');
}

// Profiele kom van die bediener. Op die profielbladsy kies die gebruiker self; elders word die
// onthou profiel gebruik (of die eerste een as hierdie blaaier nog niks gekies het nie).
window.profielReady = (async function () {
  try {
    var r = await fetch('/api/profiele');
    if (!r.ok) return null;
    var d = await r.json();
    profiles = d.profiele || []; maxProfiles = d.maks || 5;
    var cur = profiles.find(function (p) { return p.id === activeProfileId; });
    if (!cur && profiles.length && !document.getElementById('profileGrid')) cur = profiles[0];
    if (cur) setActiveProfile(cur);
    else if (!profiles.some(function (p) { return p.id === activeProfileId; })) { activeProfileId = 0; activeKids = false; }
    applyNames(); renderHeaderProfiles();
    return cur || null;
  } catch (e) { return null; }
})();

// Die rekening se eie naam kom van die bediener (nie van die blaaier nie).
fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
  if (!me) return;
  selfProfile = me.name || me.email;
  var em = document.getElementById('accountEmail');
  if (em) em.textContent = me.email;
  if (!activeProfile) { activeProfile = selfProfile; try { localStorage.setItem('stroom_active_profile', activeProfile); } catch (e) {} }
  applyNames();
  if (me.skepper) { var sl = document.getElementById('skepperLink'); if (sl) { sl.classList.remove('hidden'); sl.classList.add('block'); } }
  if (me.admin) { var al = document.getElementById('adminLink'); if (al) { al.classList.remove('hidden'); al.classList.add('block'); } }
}).catch(function () {});

function switchProfile(id) {
  var p = profiles.find(function (x) { return x.id === id; });
  if (p) setActiveProfile(p);
  window.location.href = 'katalogus.html';
}

function logoutSession() {
  fetch('/api/logout', { method: 'POST' }).finally(function () {
    try {
      localStorage.removeItem('stroom_logged_in');
      localStorage.removeItem('stroom_active_profile');
      localStorage.removeItem('stroom_profiel_id');
      localStorage.removeItem('stroom_profiel_kinders'); localStorage.removeItem('stroom_profiel_avatar');
    } catch (e) {}
    window.location.href = 'index.html';
  });
}

// Begin 'n betaling: vra die bediener vir 'n getekende PayFast-vorm en stuur die gebruiker daarheen.
async function startCheckout(plan) {
  let r, d = {};
  try {
    r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: plan }) });
    d = await r.json().catch(function () { return {}; });
  } catch (e) { return { ok: false, fout: 'Kon nie koppel nie. Probeer weer.' }; }
  if (!r.ok) return { ok: false, fout: d.fout || 'Iets het skeefgeloop.' };
  var f = document.createElement('form');
  f.method = 'POST'; f.action = d.action;
  Object.keys(d.fields).forEach(function (k) {
    var i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = d.fields[k]; f.appendChild(i);
  });
  document.body.appendChild(f); f.submit();
  return { ok: true };
}


// Kieslyste (filters en profiel): tik om oop/toe te maak; 'n tik elders of op 'n keuse maak dit toe
function toggleDd(btn, e) {
  if (e) e.stopPropagation();
  var g = btn.closest('.group'), was = g.classList.contains('open');
  document.querySelectorAll('.group.open').forEach(function (x) { x.classList.remove('open'); });
  if (!was) g.classList.add('open');
}
document.addEventListener('click', function (e) {
  document.querySelectorAll('.group.open').forEach(function (g) {
    var m = g.querySelector('.dd');
    if (!m || !m.contains(e.target) || e.target.closest('button,a')) g.classList.remove('open');
  });
});


// Installeer as toep: Android/Chrome/Edge gebruik die blaaier se installeer-venster; iPhone het 'n handmatige stap
var installEvt = null;
var isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault(); installEvt = e;
  var b = document.getElementById('installBtn'); if (b) b.classList.remove('hidden');
});
window.addEventListener('appinstalled', function () { var b = document.getElementById('installBtn'); if (b) b.classList.add('hidden'); installEvt = null; });
if (isIos && !isStandalone) { var ib = document.getElementById('installBtn'); if (ib) ib.classList.remove('hidden'); }
function installApp() {
  if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(function () { installEvt = null; var b = document.getElementById('installBtn'); if (b) b.classList.add('hidden'); }); return; }
  var t = document.createElement('div');
  t.className = 'fixed bottom-6 left-4 right-4 z-[100] bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-2xl p-4 shadow-2xl';
  t.textContent = isIos ? "Tik die Deel-knoppie in Safari en kies 'Voeg by Tuisskerm'." : "Gebruik jou blaaier se kieslys en kies 'Installeer' of 'Voeg by Tuisskerm'.";
  document.body.appendChild(t); setTimeout(function () { t.remove(); }, 6000);
}

// Vriendelike fout: die vis spartel op droë grond. fishError(element, { titel, tekst, knoppie, retry })
function fishError(el, o) {
  o = o || {};
  el.innerHTML = '<div class="fx" role="alert">' +
    '<div class="fx-stage"><span class="fx-blub">blub… blub…</span>' +
    '<div class="fx-fish"><svg width="160" height="95" viewBox="-32 -16 54 32" aria-hidden="true"><g transform="scale(1.15)">' +
    '<path d="M-13 0 C-7 -9 8 -9 15 0 C8 9 -7 9 -13 0 Z" fill="#38bdf8"/><path d="M-12 0 L-24 -8 L-20 0 L-24 8 Z" fill="#0ea5e9"/>' +
    '<path d="M-2 -6 L2 -12 L6 -6 Z" fill="#0ea5e9"/><path d="M-8 1 C-2 5 6 5 12 1 C6 7 -2 7 -8 1 Z" fill="#e0f2fe" opacity=".85"/>' +
    '<circle cx="9" cy="-1.6" r="1.8" fill="#02030b"/><path d="M14 1.5 Q15.5 2.5 14 3.5" stroke="#02030b" stroke-width=".8" fill="none" stroke-linecap="round"/></g></svg></div>' +
    '<svg class="fx-shadow" width="200" height="14" viewBox="0 0 200 14" aria-hidden="true"><ellipse cx="100" cy="7" rx="62" ry="5" fill="#02030b"/></svg>' +
    '<svg class="fx-ground" width="200" height="6" viewBox="0 0 200 6" fill="none" aria-hidden="true"><path d="M0 3 H200" stroke="#2a3d66" stroke-width="2" stroke-dasharray="10 6" stroke-linecap="round"/></svg></div>' +
    '<h2 class="text-xl font-bold text-white tracking-tight" style="font-family:Sora,Inter,sans-serif">' + escHtml(o.titel || 'Die stroom het gaan lê') + '</h2>' +
    '<p class="text-sm text-slate-400 max-w-xs leading-relaxed">' + escHtml(o.tekst || 'Ons vis spartel hier op die droë grond. Kyk of jou internet werk en probeer weer.') + '</p>' +
    (o.retry ? '<button type="button" class="fx-retry bg-sky-400 hover:bg-sky-300 text-slate-950 font-bold text-sm px-6 py-3 rounded-xl transition">' + escHtml(o.knoppie || 'Probeer weer') + '</button><span class="text-xs text-slate-500">Hy kan nie lank sonder water nie.</span>' : '') +
    '</div>';
  var b = el.querySelector('.fx-retry'); if (b) b.onclick = o.retry;
}
