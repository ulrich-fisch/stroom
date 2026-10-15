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
