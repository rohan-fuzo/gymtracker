// ============================================================
// TIMER — rest timer (timestamp-based, background-safe),
//         exercise countdown timer, Web Audio chime.
// ============================================================
import { haptic } from './ui.js';

export const RT_KEY = 'gymtracker_restTimer';

let _audioCtx          = null;
let _restTimerInterval = null;
let _restTimerDismiss  = null;
export let _exTimer    = null; // {targetSecs, startedAt, timerId}

// Expose _audioCtx for ui.js haptic warm-up
Object.defineProperty(window, '_audioCtx', {
  get(){ return _audioCtx; }, configurable: true,
});

// ── Audio context ──
export function _initAudioCtx() {
  if(_audioCtx) return;
  try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch(_) { _audioCtx = null; }
}
window._initAudioCtx = _initAudioCtx; // exposed for ui.js haptic

// ── Two-tone chime — G5 then E5 (no audio assets, works offline) ──
export function _playRestChime() {
  _initAudioCtx();
  if(!_audioCtx) return;
  try {
    [[784, 0], [659, 0.18]].forEach(([freq, delay]) => {
      const osc  = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.connect(gain); gain.connect(_audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = _audioCtx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.start(t); osc.stop(t + 0.65);
    });
  } catch(_) {}
}

// ── Rest timer — timestamp-based so it survives backgrounding ──
export function parseRestSecs(restStr) {
  if(!restStr) return 60;
  const m = restStr.match(/(\d+)\s*(s|min|m)/i);
  if(!m) return 60;
  return m[2].toLowerCase().startsWith('m') ? parseInt(m[1]) * 60 : parseInt(m[1]);
}

export function startRestTimer(secs) {
  _stopRestTimerTick();
  if(_restTimerDismiss) { clearTimeout(_restTimerDismiss); _restTimerDismiss = null; }
  const endAt = Date.now() + secs * 1000;
  try { localStorage.setItem(RT_KEY, JSON.stringify({ endAt, total: secs })); } catch(_) {}
  _runRestTimerTick(endAt, secs);
}

export function _runRestTimerTick(endAt, total) {
  const el    = document.getElementById('rest-timer');
  const count = document.getElementById('rest-timer-count');
  const bar   = document.getElementById('rest-timer-bar');
  if(!el) return;

  const secsLeft = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  el.classList.add('show');
  if(count) {
    count.style.color = secsLeft <= 10 ? 'var(--p1)' : 'var(--text)';
    count.textContent = secsLeft + 's';
  }
  if(bar) {
    bar.style.transition = 'none';
    bar.style.width = (secsLeft / total * 100) + '%';
    bar.offsetHeight;
    bar.style.transition = 'width ' + secsLeft + 's linear';
    bar.style.width = '0%';
  }

  if(secsLeft <= 0) { _onRestTimerEnd(); return; }

  _restTimerInterval = setInterval(() => {
    const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    if(count) {
      count.textContent = left + 's';
      count.style.color = left <= 10 ? 'var(--p1)' : 'var(--text)';
    }
    if(left <= 0) { _stopRestTimerTick(); _onRestTimerEnd(); }
  }, 250);
}

function _stopRestTimerTick() {
  if(_restTimerInterval) { clearInterval(_restTimerInterval); _restTimerInterval = null; }
}

function _onRestTimerEnd() {
  try { localStorage.removeItem(RT_KEY); } catch(_) {}
  const el    = document.getElementById('rest-timer');
  const count = document.getElementById('rest-timer-count');
  if(count) { count.textContent = 'GO!'; count.style.color = 'var(--p3)'; }
  _playRestChime();
  try { if(navigator.vibrate) navigator.vibrate([300, 100, 300]); } catch(_) {}
  _restTimerDismiss = setTimeout(() => {
    el?.classList.remove('show');
    if(count) count.style.color = 'var(--text)';
    _restTimerDismiss = null;
  }, 1800);
}

export function skipRestTimer() {
  _stopRestTimerTick();
  if(_restTimerDismiss) { clearTimeout(_restTimerDismiss); _restTimerDismiss = null; }
  try { localStorage.removeItem(RT_KEY); } catch(_) {}
  document.getElementById('rest-timer')?.classList.remove('show');
  const count = document.getElementById('rest-timer-count');
  if(count) count.style.color = 'var(--text)';
  haptic([8]);
}

// ── Resume timer after backgrounding or page visibility change ──
export function _resumeRestTimerIfActive() {
  // In-card set-coach timer (coach.js manages _setCoach)
  const sc = window._setCoach;
  if(sc && !sc.dismissed) {
    const left = Math.ceil((sc.endAt - Date.now()) / 1000);
    const numEl = document.getElementById('scc-num');
    if(numEl) {
      if(left <= 0) {
        clearInterval(sc.timerId); sc.timerId = null;
        _playRestChime();
        try { if(navigator.vibrate) navigator.vibrate([300, 100, 300]); } catch(_) {}
        window._dismissSetCoachFade?.();
      } else {
        numEl.textContent = left + 's';
        numEl.className = `scc-timer-num${left <= 10 ? ' scc-urgent' : ''}`;
      }
    }
  }

  // Floating HUD timer via localStorage
  try {
    const stored = localStorage.getItem(RT_KEY);
    if(!stored) return;
    const { endAt, total } = JSON.parse(stored);
    if(!endAt) return;
    _stopRestTimerTick();
    if(_restTimerDismiss) { clearTimeout(_restTimerDismiss); _restTimerDismiss = null; }
    _runRestTimerTick(endAt, total);
  } catch(_) {}
}
window._resumeRestTimerIfActive = _resumeRestTimerIfActive;

// ── Exercise countdown timer (inside set modal, for timed exercises like Plank) ──
export function getExUnit(ex) {
  return /×\d+(?:-\d+)?s/.test(ex?.s || '') ? 'seconds' : 'reps';
}
export function parseExTargetSecs(ex) {
  const m = (ex?.s || '').match(/×(\d+)(?:-(\d+))?s/);
  return m ? parseInt(m[1]) : 0;
}

export function startExTimer() {
  if(!window.pendingSet) return;
  const dk      = window.DAYS?.[window.cDay];
  const ex      = window.exData?.W?.[window.cPhase]?.[dk]?.ex?.[window.pendingSet.exIndex];
  const target  = parseExTargetSecs(ex) || 45;
  _stopExTimer();
  _exTimer = { targetSecs: target, startedAt: Date.now(), timerId: null };
  const bar = document.getElementById('tex-bar');
  if(bar) {
    bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetHeight;
    bar.style.transition = `width ${target}s linear`; bar.style.width = '0%';
  }
  const btn = document.getElementById('tex-start-btn');
  if(btn) { btn.textContent = 'RUNNING…'; btn.onclick = null; }
  const stateEl = document.getElementById('tex-state');
  if(stateEl) stateEl.textContent = 'HOLD IT';

  _exTimer.timerId = setInterval(() => {
    if(!_exTimer) return;
    const elapsed = Math.floor((Date.now() - _exTimer.startedAt) / 1000);
    const left    = Math.max(0, _exTimer.targetSecs - elapsed);
    const countEl = document.getElementById('tex-count');
    if(countEl) {
      countEl.textContent = left + 's';
      countEl.className = `tex-count${left <= 10 ? ' tex-urgent' : ''}${left <= 0 ? ' tex-done' : ''}`;
    }
    if(left <= 0) {
      _stopExTimer();
      haptic([30, 50, 30, 50, 80]);
      _playRestChime();
      const s = document.getElementById('tex-state');
      if(s) s.textContent = 'COMPLETE!';
      setTimeout(() => logTimedSetNow(), 800);
    }
  }, 250);
}

export function _stopExTimer() {
  if(_exTimer?.timerId) clearInterval(_exTimer.timerId);
  _exTimer = null;
}

export function logTimedSetNow() {
  if(!window.pendingSet) return;
  const elapsed = _exTimer
    ? Math.floor((Date.now() - _exTimer.startedAt) / 1000)
    : (() => {
        const dk = window.DAYS?.[window.cDay];
        const ex = window.exData?.W?.[window.cPhase]?.[dk]?.ex?.[window.pendingSet.exIndex];
        return parseExTargetSecs(ex) || 45;
      })();
  _stopExTimer();
  window.commitSet?.(0, Math.max(1, elapsed), true);
}
