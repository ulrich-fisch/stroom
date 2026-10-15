// Gedeelde kode vir alle ingetekende bladsye: profielnaam, profielwissel, afteken.
var activeProfile = '';
var selfProfile = '';
try { activeProfile = localStorage.getItem('stroom_active_profile') || ''; } catch (e) {}

function selfName() { return selfProfile || 'Profiel'; }

function applyNames() {
  var el = document.getElementById('headerProfileName');
  if (el) el.textContent = activeProfile || selfName();
  document.querySelectorAll('[data-self]').forEach(function (n) { n.textContent = selfName(); });
  document.querySelectorAll('[data-self-initial]').forEach(function (n) { n.textContent = selfName().charAt(0).toUpperCase(); });
}
applyNames();

// Die rekening se eie naam kom van die bediener (nie van die blaaier nie).
fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
  if (!me) return;
  selfProfile = me.name || me.email;
  var em = document.getElementById('accountEmail');
  if (em) em.textContent = me.email;
  if (!activeProfile) {
    activeProfile = selfProfile;
    try { localStorage.setItem('stroom_active_profile', activeProfile); } catch (e) {}
  }
  applyNames();
}).catch(function () {});

function switchProfile(name) {
  try { localStorage.setItem('stroom_active_profile', name); } catch (e) {}
  window.location.reload();
}

function logoutSession() {
  fetch('/api/logout', { method: 'POST' }).finally(function () {
    try {
      localStorage.removeItem('stroom_logged_in');
      localStorage.removeItem('stroom_active_profile');
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
