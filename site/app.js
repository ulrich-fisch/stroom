// Gedeelde kode vir alle ingetekende bladsye: profiele (op die bediener), profielwissel, afteken.
var AVATARS = ['#38bdf8,#0369a1', '#a78bfa,#6d28d9', '#fbbf24,#b45309', '#34d399,#047857', '#fb7185,#be123c', '#f472b6,#9d174d', '#22d3ee,#0e7490', '#94a3b8,#334155'];
function avatarBg(i) { return 'linear-gradient(135deg,' + AVATARS[(i >= 0 && i < AVATARS.length) ? i : 0] + ')'; }
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var selfProfile = '';
var profiles = [], maxProfiles = 5;
var activeProfileId = 0, activeKids = false, activeProfile = '';
try {
  activeProfileId = parseInt(localStorage.getItem('stroom_profiel_id') || '0', 10) || 0;
  activeKids = localStorage.getItem('stroom_profiel_kinders') === '1';
  activeProfile = localStorage.getItem('stroom_active_profile') || '';
} catch (e) {}

function selfName() { return selfProfile || 'Profiel'; }

function applyNames() {
  var el = document.getElementById('headerProfileName');
  if (el) el.textContent = activeProfile || selfName();
  document.querySelectorAll('[data-self]').forEach(function (n) { n.textContent = selfName(); });
  document.querySelectorAll('[data-self-initial]').forEach(function (n) { n.textContent = selfName().charAt(0).toUpperCase(); });
}
applyNames();

function setActiveProfile(p) {
  activeProfileId = p.id; activeKids = !!p.kinders; activeProfile = p.naam;
  try {
    localStorage.setItem('stroom_profiel_id', String(p.id));
    localStorage.setItem('stroom_profiel_kinders', p.kinders ? '1' : '0');
    localStorage.setItem('stroom_active_profile', p.naam);
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
      localStorage.removeItem('stroom_profiel_kinders');
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
