// ============================================================
// APP — bootstrapper, init, navigation, store subscriptions,
//       swipe gestures, midnight refresh, window.* exports.
// This is the entry point. Import everything; wire it up.
// ============================================================
import { store, Perf } from './store.js';
import { prog, DAYS, getTodayDowIndex, getTodayDateStr, parseLocalDate,
         localDateStr, getCalendarWeek, loadWeekActivity,
         getProgrammeState, applyNewStartDate, loadProgrammeConfig } from './programme.js';
import { setSyncStatus, flushOfflineQueue, updatePendingBadge } from './sync.js';
import { db } from './config.js';
import { exData, loadExerciseData, getTravelMode } from './data.js';
import { showToast, haptic, renderSkeletonWeekStrip, renderSkeletonWorkout,
         registerPWA, updateNotifBell, checkPendingNotifications, handleNotifBellTap,
         initNotifications } from './ui.js';
import { _resumeRestTimerIfActive, skipRestTimer } from './timer.js';
import { openRPESheet, closeRPESheet, handleRPEClick, skipRPE, selectRPE,
         openSetCoachCard, cancelSetCoachCard, dismissSetCoachCard,
         fetchAIProgression, reinjectAICards } from './coach.js';
import { renderWeekStrip, renderWorkout, renderPhaseBanner,
         openSetModal, handleModalClick, closeModal, saveSet, skipSet,
         saveCardioLog, toggleWarmup, toggleCheck, toggleCreatine, toggleGlass,
         toggleTravelMode, prefetchPreviousBests, selectPhase, selectDay, navWeek,
         patchWorkoutSets, patchCheckCache, renderHydrationRow, tEx, toggleDemo,
         parseSets, isExerciseDone, isDayDone } from './workout.js';
import { renderProgress, switchProgressTab, renderBodyTab, renderDiet, renderMobility,
         renderSettings, openResetModal, closeResetModal, confirmReset,
         openInBodyModal, closeInBodyModal, handleInBodyModalClick, handleInBodyPDF,
         saveInBody, openWeighModal, closeWeighModal, handleWeighModalClick, saveWeighIn,
         openMeasModal, closeMeasModal, handleMeasModalClick, saveMeasurement,
         toggleMeasAccordion, setMeasUnit, updateMeasChart, updateComparison,
         openHeightModal, closeHeightModal, handleHeightModalClick, saveHeight, skipHeight,
         switchDietPhase, toggleMob } from './progress.js';
import { startExTimer, logTimedSetNow } from './timer.js';
import { manualSync } from './sync.js';

async function init(){
  setSyncStatus('syncing');
  // Show skeletons immediately — before any DB calls
  renderSkeletonWeekStrip();
  renderSkeletonWorkout();
  try {
    // Load programme config FIRST — may override PROGRAMME_START from CFG
    // Must run before any date/week/phase calculations
    await loadProgrammeConfig();
    todayStr = getTodayDateStr();
    selectedDateStr = todayStr;
    cDay = getTodayDowIndex();
    // Load week activity — phase is derived from this
    await loadWeekActivity();
    const todayState = getProgrammeState(new Date());
    cPhase = todayState.phase;
    // Update phase strip UI
    document.querySelectorAll('#phase-strip .ph-btn').forEach(b=>{
      b.classList.toggle('active', parseInt(b.dataset.ph)===cPhase);
    });
    const dk = DAYS[cDay];
    // Fire all 4 queries in parallel
    const [sessionRes] = await Promise.all([
      db.from('workout_sessions').select('*').eq('date',todayStr).eq('day_of_week',dk).limit(1),
      loadSetsForDate(todayStr, /*silent=*/true),
      loadCheckCache(todayStr),
      loadHydration(todayStr),
    ]);
    if(sessionRes.data && sessionRes.data.length>0) sessionId = sessionRes.data[0].id;
    setSyncStatus('synced');
    // Flush any queued offline saves
    flushOfflineQueue();
  } catch(e){
    console.error(e);
    setSyncStatus('error');
  }
  renderWeekStrip();
  renderWorkout();
  // Dismiss splash — fade out after content is painted
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const splash = document.getElementById('splash');
      if(splash) splash.classList.add('hidden');
    });
  });
  // Resume floating rest timer if it was running when app was backgrounded / refreshed
  _resumeRestTimerIfActive();
}

async function loadSetsForDate(dateStr, silent=false){
  const {data} = await db.from('exercise_logs')
    .select('*').eq('date',dateStr).eq('phase',cPhase);
  loggedSets = {};
  if(data) data.forEach(row=>{
    const key = `${row.exercise_name}|${row.set_number}|${row.is_mm_set?1:0}`;
    loggedSets[key] = {weight:row.weight_kg, reps:row.reps, completed:row.completed, rpe:row.rpe??null, id:row.id};
  });
  if(!silent) renderWorkout();
}

async function loadCheckCache(dateStr){
  dateStr = dateStr || selectedDateStr;
  const [checkRes, warmupRes] = await Promise.all([
    db.from('checklist_logs').select('*').eq('date',dateStr),
    db.from('warmup_logs').select('*').eq('date',dateStr),
  ]);
  // Build the full cache locally before a single store assignment.
  // Previously, checkCache = {} fired a store notification immediately,
  // triggering renderWorkout() with an empty cache (blank LISS inputs) and
  // setting _workoutRenderKey. Subsequent per-key mutations (checkCache[k]=v)
  // bypass the store, so the final .then(renderWorkout) hit the patch path
  // which does not update cardio input values. One assignment = one render.
  const newCache = {};
  if(checkRes.data) checkRes.data.forEach(r=>{
    // Cardio logs store JSON in notes — restore as object with values
    if(r.item_type==='cardio' && r.notes){
      try { newCache[r.item_key] = {...JSON.parse(r.notes), saved:true}; }
      catch(e){ newCache[r.item_key] = r.completed; }
    } else {
      newCache[r.item_key] = r.completed;
    }
  });
  if(warmupRes.data) warmupRes.data.forEach(r=>{ newCache[r.item_key] = r.completed; });
  checkCache = newCache;
}

async function loadHydration(dateStr){
  dateStr = dateStr || selectedDateStr;
  const {data} = await db.from('hydration_logs').select('*').eq('date',dateStr).limit(1);
  hydrationGlasses = data && data.length>0 ? data[0].glasses : 0;
}

let _sessionPromise = null;
async function ensureSession(){
  if(sessionId) return sessionId;
  // Guard: if already in-flight, wait for same promise (prevents duplicate inserts)
  if(_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    const dk = DAYS[cDay];
    const w = exData.W[cPhase][dk];
    const isTravel = getTravelMode(selectedDateStr);
    const sessionTitle = isTravel ? 'TRAVEL · ' + (w.title || 'Travel Day') : w.title;
    // Try to get existing session first
    const {data:existing} = await db.from('workout_sessions')
      .select('id').eq('date', selectedDateStr).eq('day_of_week', dk).limit(1).single();
    if(existing?.id){
      sessionId = existing.id;
      // Update title + travel flag if now in travel mode (fire-and-forget)
      if(isTravel){
        db.from('workout_sessions').update({ workout_title: sessionTitle, is_travel: true })
          .eq('id', sessionId)
          .then(() => {}).catch(() => {
            // is_travel column may not exist yet — retry with title only
            db.from('workout_sessions').update({ workout_title: sessionTitle })
              .eq('id', sessionId).catch(() => {});
          });
      }
      return sessionId;
    }
    // Create new — try with is_travel first, fallback without if column missing
    const insertBase = { date: selectedDateStr, phase: cPhase, day_of_week: dk, workout_title: sessionTitle };
    let result = await db.from('workout_sessions')
      .insert(isTravel ? {...insertBase, is_travel: true} : insertBase)
      .select().single();
    if(result.error && isTravel){
      // Column likely doesn't exist yet — retry without is_travel
      result = await db.from('workout_sessions').insert(insertBase).select().single();
    }
    if(result.data) sessionId = result.data.id;
    return sessionId;
  })();
  try { return await _sessionPromise; } finally { _sessionPromise = null; }
}

// ============================================================
// WORKOUT DATA — loaded from exercises.json via loadExerciseData()
// ============================================================

function showScreen(id,btn){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.botnav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('screen-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='progress') renderProgress();  // has internal 60s cache
  if(id==='diet' && !_screenRendered.diet){ renderDiet(); _screenRendered.diet=true; }
  if(id==='mob' && !_screenRendered.mob){ renderMobility(); _screenRendered.mob=true; }
  if(id==='settings') renderSettings(); // always re-render — reflects latest state
}

// ============================================================
// STORE SUBSCRIPTIONS — renders fire only on relevant state change
// ============================================================

// Week strip — patch in-place when only selection/done state changes
store.subscribe(['cDay','cPhase','doneDatesCache','weekActivityCache'], () => {
  renderWeekStrip();
});

// Workout — smart render: patch chips when only sets change, full rebuild on day/phase change
store.subscribe(['selectedDateStr','cDay','cPhase'], () => {
  // Day or phase changed — force full rebuild by resetting render key
  _workoutRenderKey = null;
  renderWorkout();
});

store.subscribe(['loggedSets'], () => {
  // Only sets changed — patch chips surgically
  if(_workoutRenderKey) patchWorkoutSets();
  else renderWorkout();
});

store.subscribe(['checkCache'], () => {
  // Only checks changed — patch checkboxes surgically
  if(_workoutRenderKey) patchCheckCache();
  else renderWorkout();
});

store.subscribe(['hydrationGlasses'], () => {
  // Only hydration changed — patch just the hydration row
  renderHydrationRow();
});

// Sync dot — direct DOM patch, no re-render needed
store.subscribe(['syncStatus'], ({syncStatus}) => {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if(!dot) return;
  dot.className = 'sync-dot ' + syncStatus;
  if(lbl) lbl.textContent =
    syncStatus==='synced'  ? 'synced'    :
    syncStatus==='syncing' ? 'saving...' :
    syncStatus==='error'   ? 'offline'   : 'connecting...';
  // Only read IDB when the operation settles — not on every 'syncing' transition
  if(syncStatus === 'synced' || syncStatus === 'error') updatePendingBadge();
});


function runTests() {
  const results = [];
  let passed = 0, failed = 0;

  function test(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
      passed++;
    } catch(e) {
      results.push({ name, ok: false, error: e.message });
      failed++;
    }
  }

  function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
  }

  function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }

  // ── localDateStr ──
  test('localDateStr: returns YYYY-MM-DD format', () => {
    const d = localDateStr(new Date(2026, 2, 26)); // March 26
    assert(/^\d{4}-\d{2}-\d{2}$/.test(d), `Bad format: ${d}`);
    assertEqual(d, '2026-03-26');
  });

  test('localDateStr: no UTC shift for IST midnight', () => {
    // 1am local time should return same local date, not UTC-1 date
    const d = new Date(2026, 2, 27, 1, 0, 0); // 1am local Mar 27
    assertEqual(localDateStr(d), '2026-03-27', 'IST midnight bug');
  });

  // ── getCalendarWeek ──
  test('getCalendarWeek: programme start = week 1', () => {
    assertEqual(getCalendarWeek(new Date('2026-03-13')), 1);
  });

  test('getCalendarWeek: Mon 23 Mar = week 3', () => {
    assertEqual(getCalendarWeek(new Date('2026-03-23')), 3);
  });

  test('getCalendarWeek: same week as programme start Monday', () => {
    // All days in week of 13 Mar (Thu) should be week 1
    assertEqual(getCalendarWeek(new Date('2026-03-09')), 1); // Mon
    assertEqual(getCalendarWeek(new Date('2026-03-15')), 1); // Sun
  });

  test('getCalendarWeek: before start returns 0', () => {
    assertEqual(getCalendarWeek(new Date('2026-03-01')), 0);
  });

  // ── parseSets ──
  test('parseSets: 4×10 returns 4 items', () => {
    const result = parseSets('4×10');
    assertEqual(result.length, 4);
    assertEqual(result[0], '10');
  });

  test('parseSets: 3×12 reps', () => {
    const result = parseSets('3×12');
    assertEqual(result.length, 3);
  });

  test('parseSets: fallback for non-standard format', () => {
    const result = parseSets('3×30 steps');
    assertEqual(result.length, 3);
  });

  test('parseSets: 5×5 power', () => {
    const result = parseSets('5×5');
    assertEqual(result.length, 5);
  });

  // ── isExerciseDone ──
  test('isExerciseDone: false when no sets logged', () => {
    const origSets = loggedSets;
    loggedSets = {};
    const result = isExerciseDone('DB Chest Press', ['10','10','10','10'], false);
    loggedSets = origSets;
    assert(!result, 'Should be false with no sets');
  });

  test('isExerciseDone: true when all sets logged', () => {
    const origSets = loggedSets;
    loggedSets = {
      'TestEx|1|0': {completed:true}, 'TestEx|2|0': {completed:true},
      'TestEx|3|0': {completed:true}
    };
    const result = isExerciseDone('TestEx', ['10','10','10'], false);
    loggedSets = origSets;
    assert(result, 'Should be true with all sets logged');
  });

  test('isExerciseDone: false when MM set missing for first exercise', () => {
    const origSets = loggedSets;
    loggedSets = {
      'TestEx|1|0': {completed:true}, 'TestEx|2|0': {completed:true}
    };
    const result = isExerciseDone('TestEx', ['10','10'], true); // isFirst=true, no MM set
    loggedSets = origSets;
    assert(!result, 'Should be false when MM set missing');
  });

  // ── Schema validation ──
  test('Schema.exercise_log: rejects bad date format', () => {
    let threw = false;
    try { validated(Schema.exercise_log, {date:'26/03/2026', phase:1, exercise_name:'X', exercise_index:0, set_number:1, is_mm_set:false, completed:true}); }
    catch(e) { threw = true; }
    assert(threw, 'Should throw on bad date format');
  });

  test('Schema.exercise_log: rejects unrealistic weight', () => {
    let threw = false;
    try { validated(Schema.exercise_log, {date:'2026-03-26', phase:1, exercise_name:'X', exercise_index:0, set_number:1, is_mm_set:false, completed:true, weight_kg:999}); }
    catch(e) { threw = true; }
    assert(threw, 'Should throw on weight > 500kg');
  });

  test('Schema.hydration_log: clamps glasses to 0-8', () => {
    const row = validated(Schema.hydration_log, {date:'2026-03-26', glasses:15});
    assertEqual(row.glasses, 8, 'Should clamp to 8');
  });

  // ── withRetry ──
  test('withRetry: resolves on first success', async () => {
    const result = await withRetry(() => Promise.resolve(42));
    assertEqual(result, 42);
  });

  test('withRetry: retries on failure then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if(attempts < 3) throw new Error('fail');
      return Promise.resolve('ok');
    }, 4);
    assertEqual(result, 'ok');
    assert(attempts === 3, `Expected 3 attempts, got ${attempts}`);
  });

  // Print results
  const color = failed === 0 ? 'color:limegreen' : 'color:tomato';
  console.groupCollapsed(`%c✓ ${passed} passed  ✗ ${failed} failed  — GymTracker test suite`, color);
  results.forEach(r => {
    if(r.ok) console.log(`  ✓ ${r.name}`);
    else console.error(`  ✗ ${r.name}: ${r.error}`);
  });
  console.groupEnd();

  if(failed > 0) {
    showToast(`${failed} test${failed>1?'s':''} failed — check console`, 'error', 5000);
  }
}

// ============================================================

// ── Global error boundary — catch unhandled errors, never show blank screen ──
window.addEventListener('error', e => {
  console.error('Unhandled error:', e.error);
  setSyncStatus('error');
  showToast('Something went wrong — tap to reload', 'error', 8000, () => window.location.reload());
});

window.addEventListener('unhandledrejection', e => {
  // Ignore Supabase auth noise
  if(e.reason?.message?.includes('JWT')) return;
  console.error('Unhandled promise rejection:', e.reason);
  setSyncStatus('error');
});


// ============================================================
// SWIPE DOWN TO DISMISS MODAL
// ============================================================
(function initModalSwipe(){
  let startY = 0;
  const sheet = document.querySelector('.modal-sheet');
  if(!sheet) return;
  sheet.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, {passive:true});
  sheet.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY;
    // Swipe down > 80px = dismiss
    if(dy > 80){ closeModal(); haptic([8]); }
  }, {passive:true});
})();

// ============================================================
// SWIPE BETWEEN DAYS
// ============================================================
(function initSwipe(){
  let startX = 0, startY = 0, startTime = 0;
  const el = document.getElementById('screen-today');
  if(!el) return;

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
  }, {passive: true});

  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dt = Date.now() - startTime;
    // Must be fast (<350ms), horizontal (dx > dy*2), and far enough (>50px)
    if(dt > 350 || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if(dx < 0) {
      // Swipe left — next day
      if(cDay < 6) { selectDay(cDay + 1); haptic([6]); }
    } else {
      // Swipe right — previous day
      if(cDay > 0) { selectDay(cDay - 1); haptic([6]); }
    }
  }, {passive: true});
})();


// ── Dev helper ──
if(window.location.hostname === 'localhost' || window.location.hostname.includes('127.0.0.1')) {
  window.__store = store;
  console.log('Dev mode: window.__store available');
}

// ── Midnight refresh — silently update "today" at midnight IST ──
(function scheduleMidnightRefresh() {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 5) - now;
  setTimeout(() => {
    const newToday = localDateStr();
    if(newToday !== todayStr) {
      todayStr = newToday;
      cDay = getTodayDowIndex();
      selectedDateStr = todayStr;
      sessionId = null;
      window._weekDatesMemo = null;
      window._stripCache = {};
      window._workoutRenderKey = null;
      renderWeekStrip();
      renderWorkout();
    }
    scheduleMidnightRefresh();
  }, msUntilMidnight);
})();

// ── Window exports — functions called from HTML inline handlers ──
// Navigation
window.showScreen       = showScreen;
window.navWeek          = navWeek;
window.selectPhase      = selectPhase;
window.selectDay        = selectDay;
window.manualSync       = manualSync;
window.handleNotifBellTap = handleNotifBellTap;
// Set modal
window.openSetModal     = openSetModal;
window.handleModalClick = handleModalClick;
window.closeModal       = closeModal;
window.saveSet          = saveSet;
window.skipSet          = skipSet;
window.startExTimer     = startExTimer;
window.logTimedSetNow   = logTimedSetNow;
// RPE
window.openRPESheet     = openRPESheet;
window.closeRPESheet    = closeRPESheet;
window.handleRPEClick   = handleRPEClick;
window.skipRPE          = skipRPE;
window.selectRPE        = selectRPE;
// Coach card
window.dismissSetCoachCard = dismissSetCoachCard;
window.cancelSetCoachCard  = cancelSetCoachCard;
window.skipRestTimer       = skipRestTimer;
window.openSetCoachCard    = openSetCoachCard;
window.fetchAIProgression  = fetchAIProgression;
window.reinjectAICards     = reinjectAICards;
// App-level functions used by workout.js
window.ensureSession    = ensureSession;
window.loadSetsForDate  = loadSetsForDate;
window.loadCheckCache   = loadCheckCache;
window.loadHydration    = loadHydration;
// Helper functions used by coach.js and programme.js via global scope
window.parseSets        = parseSets;
window.isExerciseDone   = isExerciseDone;
window.isDayDone        = isDayDone;
// Workout helpers
window.saveCardioLog    = saveCardioLog;
window.toggleWarmup     = toggleWarmup;
window.toggleCheck      = toggleCheck;
window.toggleCreatine   = toggleCreatine;
window.toggleGlass      = toggleGlass;
window.toggleTravelMode = toggleTravelMode;
window.tEx              = tEx;
window.toggleDemo       = toggleDemo;
// Progress / measurements
window.switchProgressTab  = switchProgressTab;
window.updateMeasChart    = updateMeasChart;
window.updateComparison   = updateComparison;
window.openMeasModal      = openMeasModal;
window.closeMeasModal     = closeMeasModal;
window.handleMeasModalClick = handleMeasModalClick;
window.saveMeasurement    = saveMeasurement;
window.toggleMeasAccordion = toggleMeasAccordion;
window.setMeasUnit        = setMeasUnit;
window.openHeightModal    = openHeightModal;
window.closeHeightModal   = closeHeightModal;
window.handleHeightModalClick = handleHeightModalClick;
window.saveHeight         = saveHeight;
window.skipHeight         = skipHeight;
// Weigh-in
window.openWeighModal     = openWeighModal;
window.closeWeighModal    = closeWeighModal;
window.handleWeighModalClick = handleWeighModalClick;
window.saveWeighIn        = saveWeighIn;
// InBody
window.openInBodyModal    = openInBodyModal;
window.closeInBodyModal   = closeInBodyModal;
window.handleInBodyModalClick = handleInBodyModalClick;
window.handleInBodyPDF    = handleInBodyPDF;
window.saveInBody         = saveInBody;
// Settings
window.renderSettings     = renderSettings;
window.openResetModal     = openResetModal;
window.closeResetModal    = closeResetModal;
window.confirmReset       = confirmReset;
window.applyNewStartDate  = applyNewStartDate;
// Diet
window.switchDietPhase    = switchDietPhase;
// Mobility
window.toggleMob          = toggleMob;
// PWA
window.registerPWA        = registerPWA;

// ── Boot sequence ──
registerPWA();
if(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  setTimeout(runTests, 1500);
}

loadExerciseData().then(init);

window.addEventListener('load', () => {
  updateNotifBell();
  if(Notification.permission === 'granted') {
    const prefs = JSON.parse(localStorage.getItem('notifPrefs') || '[]');
    if(prefs.length) checkPendingNotifications();
  }
});
