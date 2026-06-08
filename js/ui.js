// ============================================================
// UI — toast, haptic, skeleton screens, notifications, PWA.
// ============================================================
import { isMeasurementDue, daysSinceMeasurement, localDateStr } from './programme.js';
import { flushOfflineQueue } from './sync.js';

// ── Toast ──
export function showToast(msg, type = 'success', duration = 2500, onClick = null) {
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + type;
  t.style.cursor = onClick ? 'pointer' : '';
  t.onclick = onClick || null;
  t.style.pointerEvents = onClick ? 'auto' : 'none';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    t.className = 'toast';
    t.onclick = null;
    t.style.pointerEvents = 'none';
  }, duration);
}

// ── Haptic feedback + AudioContext warm-up ──
export function haptic(pattern = [10]) {
  try { if(navigator.vibrate) navigator.vibrate(pattern); } catch(e) {}
  window._initAudioCtx?.();
  if(window._audioCtx && window._audioCtx.state === 'suspended')
    window._audioCtx.resume().catch(() => {});
}

// ── Skeleton placeholders ──
export function renderSkeletonWeekStrip() {
  const container = document.getElementById('week-strip');
  if(!container) return;
  container.innerHTML = `<div class="sk-pill-row">
    ${Array(7).fill('<div class="sk sk-pill"></div>').join('')}
  </div>`;
}

export function renderSkeletonWorkout() {
  const c = document.getElementById('workout-content');
  if(!c) return;
  let h = '<div class="sk sk-banner"></div>';
  h += `<div class="sk-block">
    <div class="sk-block-inner">
      <div class="sk sk-line-lg" style="width:55%"></div>
      <div class="sk sk-line" style="width:35%"></div>
    </div>
    <div style="padding:0 16px 14px">
      <div class="sk sk-line" style="width:25%;margin-bottom:12px"></div>
      ${Array(4).fill('<div class="sk sk-line" style="width:90%"></div>').join('')}
    </div>
  </div>`;
  h += '<div class="sk-block"><div class="sk-block-inner">';
  h += '<div class="sk sk-line" style="width:25%;margin-bottom:14px"></div>';
  for(let i = 0; i < 3; i++) {
    h += `<div class="sk-ex-row">
      <div class="sk sk-ex-icon"></div>
      <div class="sk-ex-info">
        <div class="sk sk-line" style="width:60%;margin-bottom:6px"></div>
        <div class="sk sk-line" style="width:40%"></div>
      </div>
    </div>
    <div class="sk-chips">
      <div class="sk sk-chip"></div><div class="sk sk-chip"></div>
      <div class="sk sk-chip"></div><div class="sk sk-chip"></div>
    </div>`;
  }
  h += '</div></div>';
  c.innerHTML = h;
}

// ── Notification helpers ──
export async function requestNotificationPermission() {
  if(!('Notification' in window)) return false;
  if(Notification.permission === 'granted') return true;
  if(Notification.permission === 'denied')  return false;
  return (await Notification.requestPermission()) === 'granted';
}

export async function swNotify(title, opts) {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { icon: '/icon-192.png', badge: '/icon-192.png', ...opts });
    return true;
  } catch(e) { console.warn('swNotify failed', e); return false; }
}

export function isInBodyDue() {
  const last = localStorage.getItem('lastInBodyDate');
  if(!last) return true;
  return Math.floor((new Date() - new Date(last)) / 86400000) >= 14;
}

export function daysSinceInBody() {
  const last = localStorage.getItem('lastInBodyDate');
  if(!last) return null;
  return Math.floor((new Date() - new Date(last)) / 86400000);
}

export async function checkPendingNotifications() {
  if(Notification.permission !== 'granted') return;
  if(!('serviceWorker' in navigator)) return;
  const prefs = JSON.parse(localStorage.getItem('notifPrefs') || '[]');
  if(!prefs.length) return;
  const now = Date.now();

  if(prefs.includes('inbody') && isInBodyDue()) {
    const lastShown = parseInt(localStorage.getItem('lastInBodyNotif') || '0');
    if(now - lastShown > 20 * 3600000) {
      const ok = await swNotify('InBody Due 📊', {
        body: daysSinceInBody()
          ? `${daysSinceInBody()} days since your last scan — head to the gym for your bi-weekly InBody check-in.`
          : 'First InBody scan due — head to the gym front desk.',
        tag: 'inbody-reminder', renotify: true,
      });
      if(ok) localStorage.setItem('lastInBodyNotif', String(now));
    }
  }

  if(prefs.includes('weighin') && new Date().getDay() === 1) {
    const lastShown = localStorage.getItem('lastWeighInNotif');
    const todayKey  = localDateStr();
    if(lastShown !== todayKey) {
      const ok = await swNotify('Monday Weigh-In ⚖️', {
        body: "Fasted weight check — open the app to log and see if you're on track.",
        tag: 'weighin-reminder',
      });
      if(ok) localStorage.setItem('lastWeighInNotif', todayKey);
    }
  }

  if(prefs.includes('measurements') && isMeasurementDue()) {
    const lastShown = parseInt(localStorage.getItem('lastMeasNotif') || '0');
    if(now - lastShown > 20 * 3600000) {
      const dSince = daysSinceMeasurement();
      const ok = await swNotify('Measurements Due 📏', {
        body: dSince
          ? `${dSince} days since your last tape measurement — time for your bi-weekly check-in.`
          : 'Start tracking your body measurements in the Progress tab.',
        tag: 'meas-reminder', renotify: true,
      });
      if(ok) localStorage.setItem('lastMeasNotif', String(now));
    }
  }
}

export function scheduleCreatineReminder() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(19, 0, 0, 0);
  if(next <= now) next.setDate(next.getDate() + 1);
  if(window._creatineTimer) clearTimeout(window._creatineTimer);
  window._creatineTimer = setTimeout(() => {
    if(Notification.permission === 'granted')
      new Notification('Creatine Time ⚗️', {
        body: '5g creatine with your post-workout shake. Every day — including rest days.',
        tag: 'creatine-reminder',
      });
    scheduleCreatineReminder();
  }, next - now);
}

export async function initNotifications(prefs = ['inbody','weighin']) {
  const granted = await requestNotificationPermission();
  if(!granted) return false;
  localStorage.setItem('notifPrefs', JSON.stringify(prefs));
  updateNotifBell();
  await checkPendingNotifications();
  return true;
}

export async function handleNotifBellTap() {
  const isIOS        = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if(isIOS && !isStandalone) { showToast('Add to Home Screen first, then enable notifications','error'); return; }
  if(!('Notification' in window)) { showToast('Notifications not supported on this browser','error'); return; }
  if(Notification.permission === 'denied') { showToast('Notifications blocked — go to Settings › Safari › Notifications to enable','error'); return; }
  if(Notification.permission === 'granted') {
    localStorage.setItem('notifPrefs', '[]');
    updateNotifBell();
    if(window._creatineTimer) { clearTimeout(window._creatineTimer); window._creatineTimer = null; }
    showToast('Notifications turned off');
    return;
  }
  const granted = await initNotifications(['inbody','weighin','measurements']);
  if(granted) showToast('Notifications enabled ✓'); else showToast('Permission denied','error');
}

export function updateNotifBell() {
  const bell  = document.getElementById('notif-bell');
  if(!bell) return;
  const prefs  = JSON.parse(localStorage.getItem('notifPrefs') || '[]');
  const active = Notification.permission === 'granted' && prefs.length > 0;
  bell.classList.toggle('on', active);
  bell.title = active ? 'Notifications on — tap to turn off' : 'Tap to enable notifications';
}

// ── PWA service worker registration ──
export async function registerPWA() {
  if(!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    reg.update().catch(() => {});

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if(refreshing) return;
      refreshing = true;
      showUpdateOverlay();
      setTimeout(() => window.location.reload(), 800);
    });

    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        if(newSW.state === 'installed' && navigator.serviceWorker.controller)
          showToast('Updating to latest version…', 'info');
      });
    });

    const prefs = JSON.parse(localStorage.getItem('notifPrefs') || '[]');
    if(prefs.length) checkPendingNotifications();
    flushOfflineQueue();
  } catch(e) { console.log('SW reg failed:', e.message); }
}

export function showUpdateOverlay() {
  let el = document.getElementById('update-overlay');
  if(!el) {
    el = Object.assign(document.createElement('div'), { id: 'update-overlay' });
    el.style.cssText = `position:fixed;inset:0;z-index:99999;background:#0a0a0a;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;`;
    el.innerHTML = `
      <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:3px;color:#f0ede8">GYM<span style="color:#ff4520">X</span></div>
      <div style="font-size:11px;letter-spacing:2px;color:#444;text-transform:uppercase">Updating…</div>
      <div style="width:32px;height:32px;border:2.5px solid #1c1c1c;border-top-color:#ff4520;border-radius:50%;animation:splash-spin .7s linear infinite"></div>`;
    document.body.appendChild(el);
  }
}
