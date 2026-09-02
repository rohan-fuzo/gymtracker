// ============================================================
// WORKOUT — warmup, travel mode, set modal, workout render, cardio.
// This is the core training screen module.
// ============================================================
import { db, TABLES, CONFLICTS, SET_COACH_DEFAULT_REST } from './config.js';
import { store, Schema, validated, Perf } from './store.js';
import { prog, DAYS, MONTH_NAMES, localDateStr, getTodayDateStr, parseLocalDate,
         loadWeekActivity, getCalendarWeek, formatDate, getWeekDates, getDateForDay,
         getTodayDowIndex, getProgrammeState, getThisWeekProgress, getLastWeekStatus,
         isMeasurementDue, daysSinceMeasurement,
         viewingWeekOffset, setViewingWeekOffset, invalidateWeekMemo } from './programme.js';
import { queueOfflineSave, withRetry, dedupedUpsert, setSyncStatus, flushOfflineQueue } from './sync.js';
import { exData, getTravelMode, setTravelMode, getTravelDayType, getExerciseGif } from './data.js';
import { showToast, haptic, renderSkeletonWorkout } from './ui.js';
import { startRestTimer, parseRestSecs, _stopExTimer, parseExTargetSecs, getExUnit,
         _runRestTimerTick, RT_KEY } from './timer.js';

// ── Module-level state ──
export const _prevBestCache    = {};
export let _workoutRenderKey   = null;
export let _sessionPromise     = null;
let _stripCache = {};
export let cSession = 'morning'; // 'morning' | 'evening'

Object.defineProperty(window, '_prevBestCache',    { get(){ return _prevBestCache;    }, configurable: true });
Object.defineProperty(window, '_workoutRenderKey', {
  get(){ return _workoutRenderKey; },
  set(v){ _workoutRenderKey = v; },
  configurable: true,
});
Object.defineProperty(window, '_stripCache', {
  get(){ return _stripCache; },
  set(v){ _stripCache = v; },
  configurable: true,
});

// ── Session toggle ──
export function setSession(s) {
  cSession = s;
  _workoutRenderKey = null;
  _stripCache = {};
  renderWorkout();
}
window.setSession = setSession;


function renderUniversalWarmup(dk, isPowerDay){
  const wuDone = exData.warmup.filter(j=>checkCache[`wu_${dk}_${j.k}`]).length;
  const pct = Math.round(wuDone/exData.warmup.length*100);
  let h = `<div class="wu-block">
    <div class="block-title">WARMUP PROTOCOL${isPowerDay?' + CNS RAMP':''}</div>
    <div class="wu-progress"><div class="wu-progress-fill" style="width:${pct}%"></div></div>
    <div style="font-size:10px;color:${pct===100?'var(--yellow)':'var(--dim)'};margin-bottom:8px">${wuDone}/${exData.warmup.length} complete</div>
    <ul class="checklist">`;
  exData.warmup.forEach(j=>{
    const itemKey = `wu_${dk}_${j.k}`;
    const done = checkCache[itemKey] ? 'done' : '';
    h += `<li class="${done}" data-wu="${itemKey}" onclick="toggleWarmup('${itemKey}','${j.label}',this)">
      <div class="cb">${checkCache[itemKey]?'✓':''}</div>
      <span><strong style="color:var(--text)">${j.label}</strong> — <span style="color:var(--muted)">${j.detail}</span></span>
    </li>`;
  });
  h += `</ul>`;
  if(isPowerDay){
    h += `<div style="margin-top:10px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--gold);margin-bottom:5px">+ CNS RAMP</div>
    <div style="font-size:12px;color:#888;line-height:1.8">
      Squat: bar ×10 → 40% ×6 → 60% ×4 → 75% ×2 → 85%<br>
      Deadlift: 50% ×5 → 70% ×3 → ready<br>
      Bench + Row: 50% ×5 each
    </div>`;
  }
  h += `</div>`;
  return h;
}

// ============================================================
// TOGGLE WARMUP (saves to Supabase)
// ============================================================
async function toggleWarmup(itemKey, label, el){
  const newVal = !checkCache[itemKey];
  checkCache[itemKey] = newVal;
  el.classList.toggle('done', newVal);
  el.querySelector('.cb').textContent = newVal ? '✓' : '';
  haptic(newVal ? [6] : [4]);
  // Surgically update warmup progress bar
  const dk = DAYS[cDay];
  const wuDone = exData.warmup.filter(j=>checkCache[`wu_${dk}_${j.k}`]).length;
  const pct = Math.round(wuDone/exData.warmup.length*100);
  const fill = document.querySelector('.wu-progress-fill');
  if(fill) fill.style.width = pct+'%';
  // Find the count label by content pattern
  document.querySelectorAll('.wu-block div').forEach(d=>{
    if(d.textContent.match(/^\d+\/\d+ complete$/)){
      d.textContent = `${wuDone}/${exData.warmup.length} complete`;
      d.style.color = pct===100 ? 'var(--yellow)' : 'var(--dim)';
    }
  });
  setSyncStatus('syncing');
  try {
    await withRetry(() =>
      db.from('warmup_logs')
        .upsert(validated(Schema.warmup_log, {
          date: selectedDateStr, phase: cPhase||1,
          item_key: itemKey, item_label: label, completed: newVal
        }), {onConflict:'date,item_key'})
        .then(r => { if(r.error) throw r.error; })
    );
    setSyncStatus('synced');
    renderWeekStrip();
  } catch(e){
    setSyncStatus('error');
    queueOfflineSave({
      table: 'warmup_logs', onConflict: 'date,item_key',
      conflictKey: `${selectedDateStr}|${itemKey}`,
      data: { date: selectedDateStr, phase: cPhase||1, item_key: itemKey, item_label: label, completed: newVal },
    });
  }
}

// ============================================================
// TOGGLE CHECKLIST (cooldown, sleep, creatine)
// ============================================================
async function toggleCheck(itemKey, itemType, el){
  const newVal = !checkCache[itemKey];
  checkCache[itemKey] = newVal;
  el.classList.toggle('done', newVal);
  const cb = el.querySelector('.cb,.s-cb');
  if(cb) cb.textContent = newVal ? '✓' : '';
  haptic(newVal ? [6] : [4]);
  setSyncStatus('syncing');
  try {
    await withRetry(() =>
      db.from('checklist_logs')
        .upsert(validated(Schema.checklist_log, {
          date: selectedDateStr, item_type: itemType,
          item_key: itemKey, completed: newVal
        }), {onConflict:'date,item_key'})
        .then(r => { if(r.error) throw r.error; })
    );
    setSyncStatus('synced');
  } catch(e){
    setSyncStatus('error');
    queueOfflineSave({
      table: 'checklist_logs', onConflict: 'date,item_key',
      conflictKey: `${selectedDateStr}|${itemKey}`,
      data: { date: selectedDateStr, item_type: itemType, item_key: itemKey, completed: newVal },
    });
  }
}

async function toggleCreatine(el){
  await toggleCheck('creatine_today','creatine',el);
  el.classList.toggle('done', checkCache['creatine_today']);
  el.textContent = checkCache['creatine_today'] ? '✓' : '';
}

async function toggleGlass(num){
  const newVal = hydrationGlasses === num ? num-1 : num;
  hydrationGlasses = newVal;
  haptic([5]);
  // Re-render hydration row
  renderHydrationRow();
  setSyncStatus('syncing');
  try {
    await withRetry(() =>
      db.from('hydration_logs')
        .upsert(validated(Schema.hydration_log, {
          date: selectedDateStr, glasses: newVal
        }), {onConflict:'date'})
        .then(r => { if(r.error) throw r.error; })
    );
    setSyncStatus('synced');
  } catch(e){
    setSyncStatus('error');
    queueOfflineSave({
      table: 'hydration_logs', onConflict: 'date',
      conflictKey: `${selectedDateStr}|hydration`,
      data: { date: selectedDateStr, glasses: newVal },
    });
  }
}

function renderHydrationRow(){
  const el = document.getElementById('hyd-row');
  if(!el) return;
  const btns = el.querySelectorAll('.glass-btn');
  if(btns.length === 0){
    // First render — build DOM once
    const wrap = el.querySelector('.hyd-glasses');
    wrap.innerHTML = Array(8).fill(0).map((_,i)=>`<div class="glass-btn ${i<hydrationGlasses?'filled':''}" onclick="toggleGlass(${i+1})">💧</div>`).join('');
  } else {
    // Subsequent renders — toggle class only, no DOM rebuild
    btns.forEach((btn, i) => btn.classList.toggle('filled', i < hydrationGlasses));
  }
  el.querySelector('.hyd-total span').textContent = (hydrationGlasses*.5).toFixed(1)+'L';
}

// ============================================================
// SET MODAL
// ============================================================

function toggleTravelMode() {
  const dk = DAYS[cDay];
  const dayData = exData.W[cPhase]?.[dk] || {};
  const w = dayData[cSession];
  if(!w || w.isRest) return;
  const newVal = !getTravelMode(selectedDateStr);
  setTravelMode(selectedDateStr, newVal);
  _workoutRenderKey = null;  // force full rebuild
  _stripCache = {};
  renderWeekStrip();
  renderWorkout();
  haptic(newVal ? [6, 30, 6] : [4]);
  showToast(newVal ? '✈️ Travel mode on — bodyweight workout loaded' : '🏋️ Switched back to regular workout');
}

// Render the travel toggle banner
function renderTravelToggle(isActive, travelType) {
  const typeLabels = {
    push:'Push Bodyweight', pull:'Pull Bodyweight',
    legs:'Legs Bodyweight', fullbody:'Full Body Bodyweight',
    liss:'Walk / Jog / Stairs'
  };
  const label = typeLabels[travelType] || 'Bodyweight Workout';
  return `<div class="travel-toggle-wrap${isActive?' active':''}" onclick="toggleTravelMode()">
    <div class="travel-toggle-icon">✈️</div>
    <div class="travel-toggle-body">
      <div class="travel-toggle-title">Travelling today?</div>
      <div class="travel-toggle-sub">${isActive ? '🟢 ' + label + ' active' : 'Swap to no-equipment bodyweight workout'}</div>
    </div>
    <div class="travel-toggle-switch${isActive?' on':''}"></div>
  </div>`;
}


function openSetModal(exName, setNum, isMM, chipEl, exIndex){
  pendingSet = {exName, setNum, isMM, chipEl, exIndex};
  document.getElementById('modal-title').textContent = exName.toUpperCase();
  // Determine unit type for this exercise
  const dk = DAYS[cDay];
  const ex = exData.W[cPhase]?.[dk]?.[cSession]?.ex?.[exIndex];
  const unit = isMM ? 'reps' : getExUnit(ex);
  const isTimed = unit === 'seconds';

  document.getElementById('modal-sub').textContent = isMM ? 'Mind-Muscle Set — No Weight' : `Set ${setNum}`;

  // Toggle sections
  document.getElementById('modal-reps-section').style.display = isTimed ? 'none' : '';
  document.getElementById('modal-timer-section').style.display = isTimed ? '' : 'none';

  if(isTimed){
    _stopExTimer();
    const targetSecs = parseExTargetSecs(ex);
    document.getElementById('tex-target').textContent = `Target: ${targetSecs}s`;
    document.getElementById('tex-count').textContent  = targetSecs + 's';
    document.getElementById('tex-count').className    = 'tex-count';
    document.getElementById('tex-bar').style.transition = 'none';
    document.getElementById('tex-bar').style.width   = '100%';
    document.getElementById('tex-state').textContent  = 'TAP START';
    document.getElementById('tex-start-btn').textContent = 'START ▶';
    document.getElementById('tex-start-btn').onclick = startExTimer;
    document.getElementById('modal-prev').innerHTML = '';
  } else {
    // Show previous best
    const prev = getPreviousBest(exName, setNum, isMM);
    const prevEl = document.getElementById('modal-prev');
    if(prev && prev.weight>0){
      prevEl.innerHTML = `Last: <span>${prev.weight}kg × ${prev.reps} reps</span> <span style="color:var(--dim);font-size:10px">${prev.date?.slice(5)||''}</span>`;
    } else {
      prevEl.innerHTML = '<span style="color:var(--dim)">No previous record</span>';
    }
    const key = `${exName}|${setNum}|0`;
    const existing = loggedSets[key];
    const prev2 = getPreviousBest(exName, setNum, isMM);
    const prefillWeight = existing ? existing.weight||'' : (prev2 && !isMM ? prev2.weight : '');
    const prefillReps   = existing ? existing.reps||''   : (prev2 && !isMM ? prev2.reps   : '');
    document.getElementById('modal-weight').value = isMM ? 0 : prefillWeight;
    document.getElementById('modal-reps').value   = prefillReps;
  }

  document.getElementById('set-modal').classList.add('open');
  haptic([8]);
  if(!isTimed) setTimeout(()=>{ isMM ? document.getElementById('modal-reps').focus() : document.getElementById('modal-weight').focus(); }, 300);
}

function handleModalClick(e){
  if(e.target === document.getElementById('set-modal')) closeModal();
}
function closeModal(){
  _stopExTimer();
  document.getElementById('set-modal').classList.remove('open');
  pendingSet = null;
}

async function saveSet(){
  if(!pendingSet) return;
  // Timed exercises save via logTimedSetNow — never via the normal save button
  const dk = DAYS[cDay];
  const exForUnit = exData.W[cPhase]?.[dk]?.[cSession]?.ex?.[pendingSet.exIndex];
  if(getExUnit(exForUnit) === 'seconds'){ logTimedSetNow(); return; }
  const weight = parseFloat(document.getElementById('modal-weight').value)||0;
  const reps = parseInt(document.getElementById('modal-reps').value)||0;
  // Validate: reps required, weight must be non-negative
  if(reps <= 0 && !pendingSet.isMM){
    showToast('Enter reps to save', 'error');
    const repsEl = document.getElementById('modal-reps');
    repsEl.focus();
    repsEl.classList.remove('shake');
    repsEl.offsetHeight; // force reflow
    repsEl.classList.add('shake');
    repsEl.addEventListener('animationend', () => repsEl.classList.remove('shake'), {once:true});
    haptic([10,30,10,30,10]);
    return;
  }
  if(weight < 0 || weight > 500){
    showToast('Check weight value', 'error');
    const wtEl = document.getElementById('modal-weight');
    wtEl.focus();
    wtEl.classList.remove('shake');
    wtEl.offsetHeight;
    wtEl.classList.add('shake');
    wtEl.addEventListener('animationend', () => wtEl.classList.remove('shake'), {once:true});
    haptic([10,30,10,30,10]);
    return;
  }
  await commitSet(weight, reps, true);
}

async function skipSet(){
  if(!pendingSet) return;
  await commitSet(0, 0, true);
}

async function commitSet(weight, reps, completed){
  const {exName, setNum, isMM, chipEl, exIndex} = pendingSet;
  const key = `${exName}|${setNum}|${isMM?1:0}`;

  // ── OPTIMISTIC UPDATE — UI responds instantly ──
  const prevLoggedSets = {...loggedSets};  // snapshot for rollback
  const newLoggedSets = {...loggedSets, [key]: {weight, reps, completed}};

  // Update store immediately — triggers re-render via subscription
  store.batch(() => {
    store.setState({loggedSets: newLoggedSets});
  });

  // Update chip directly (faster than waiting for full re-render)
  if(chipEl){
    chipEl.classList.add('done');
    const logged = chipEl.querySelector('.sc-logged');
    if(logged) logged.textContent = weight>0 ? `${weight}kg×${reps}` : 'done';
    chipEl.querySelector('.sc-num').style.color = isMM ? 'var(--gold)' : 'var(--p3)';
  }

  // Update exercise done state immediately
  const ek = `ex_${cPhase}_${DAYS[cDay]}_${cSession}_${exIndex}`;
  const rowEl = document.getElementById(ek);
  if(rowEl){
    const w = exData.W[cPhase]?.[DAYS[cDay]]?.[cSession];
    const ex = w?.ex?.[exIndex];
    if(ex) rowEl.classList.toggle('ex-done', isExerciseDone(ex.n, parseSets(ex.s), exIndex===0));
  }

  closeModal();
  haptic([10, 50, 10]);
  showToast(weight>0 ? `${weight}kg × ${reps} saved ✓` : 'Set logged ✓');

  setSyncStatus('syncing');

  // ── PERSIST to DB in background with retry + dedup ──
  const conflictKey = `${selectedDateStr}|${exName}|${setNum}|${isMM?1:0}`;
  const payload = validated(Schema.exercise_log, {
    date: selectedDateStr, phase: cPhase,
    exercise_name: exName, exercise_index: exIndex,
    set_number: setNum, is_mm_set: isMM,
    weight_kg: weight||null, reps: reps||null,
    completed,
  });

  try {
    await dedupedUpsert(conflictKey, async () => {
      // ensureSession may return null if session creation fails — that's OK,
      // the exercise_log row still saves; session_id is nullable.
      const sid = await ensureSession().catch(err => {
        console.warn('[commitSet] ensureSession failed, proceeding without session_id:', err?.message);
        return null;
      });
      await withRetry(() =>
        db.from('exercise_logs')
          .upsert({...payload, session_id: sid},
                  {onConflict:'date,exercise_name,set_number,is_mm_set'})
          .then(r => { if(r.error) throw r.error; return r; })
      );
    });
    setSyncStatus('synced');
    const _w = exData.W?.[cPhase]?.[DAYS[cDay]]?.[cSession];
    const _ex = _w?.ex?.[exIndex];
    if(_ex?.r && !isMM) startRestTimer(parseRestSecs(_ex.r));
    // Refresh week activity — debounced for today, immediate for past dates
    clearTimeout(window._weekRefreshTimer);
    const isPastDate = selectedDateStr !== todayStr;
    window._weekRefreshTimer = setTimeout(() => {
      loadWeekActivity().then(() => {
        renderWeekStrip();
        renderPhaseBanner();
      });
    }, isPastDate ? 300 : 1500); // faster refresh for past date logging
  } catch(e){
    const errMsg = e?.message || e?.code || String(e);
    console.error('commitSet failed:', errMsg, e?.code, e?.details, e?.hint, e);
    // ── Queue offline — keep optimistic UI; data will sync within 30s ──
    queueOfflineSave({
      table: 'exercise_logs',
      onConflict: 'date,exercise_name,set_number,is_mm_set',
      conflictKey: selectedDateStr+'|'+exName+'|'+setNum+'|'+(isMM?1:0),
      data: {...payload, session_id: sessionId||null}
    });
    setSyncStatus('error');
    if(e?.code === 'PGRST119' || errMsg?.includes('unique or exclusion constraint'))
      showToast('DB missing unique index — run supabase-setup.sql', 'error');
  }
}



async function prefetchPreviousBests(exercises){
  const names = exercises.map(ex=>ex.n);
  if(!names.length) return;
  const {data} = await db.from('exercise_logs')
    .select('exercise_name,set_number,weight_kg,reps,date')
    .in('exercise_name', names)
    .eq('completed', true)
    .neq('date', selectedDateStr)
    .eq('is_mm_set', false)
    .order('date', {ascending:false})
    .limit(300);
  if(!data) return;
  data.forEach(row=>{
    const key=`${row.exercise_name}|${row.set_number}|0`;
    if(!_prevBestCache[key]) _prevBestCache[key]={weight:row.weight_kg,reps:row.reps,date:row.date};
  });
}

function getPreviousBest(exName, setNum, isMM){
  if(isMM) return null;
  const key=`${exName}|${setNum}|0`;
  return _prevBestCache[key]||null;
}


function phRgb(ph){return['','255,69,32','255,140,0','34,197,94','59,130,246','168,85,247'][ph]}

function selectPhase(ph,btn){
  cPhase=ph;
  _workoutRenderKey = null;
  document.querySelectorAll('#phase-strip .ph-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderSkeletonWorkout();
  // Brief timeout so skeleton paints before synchronous renderWorkout blocks
  setTimeout(() => { renderWeekStrip(); renderWorkout(); }, 16);
}
function selectDay(d){
  cDay=d;
  sessionId=null;
  _sessionPromise=null;
  // Clear prev best cache — stale for new day
  Object.keys(_prevBestCache).forEach(k => delete _prevBestCache[k]);
  const date = getDateForDay(d);
  selectedDateStr = localDateStr(date);
  // Reset render key so next renderWorkout does full rebuild
  _workoutRenderKey = null;
  renderWeekStrip();
  // Show skeleton while new day's data loads
  renderSkeletonWorkout();
  Promise.all([
    loadSetsForDate(selectedDateStr, true),
    loadCheckCache(selectedDateStr),
    loadHydration(selectedDateStr),
  ]).then(() => renderWorkout());
}

function getSessionDots(i, d, dateStr, isPast, isLiveDay){
  const dayData = exData.W[cPhase]?.[d] || {};
  const hasMorn = dayData.morning && !dayData.morning.isRest;
  const hasEven = dayData.evening && !dayData.evening.isRest;
  const pastDone = !isPast && doneDatesCache.has(dateStr);
  // Live check only for the selected day (loggedSets is loaded for it)
  const mDone = isPast ? false : isLiveDay ? isSessionDone('morning', dayData, d) : (pastDone && hasMorn);
  const eDone = isPast ? false : isLiveDay ? isSessionDone('evening', dayData, d) : (pastDone && hasEven);
  const col = done => done ? 'var(--p3)' : 'var(--border)';
  if(!hasMorn && !hasEven) return '';
  if(hasMorn && hasEven)
    return `<div class="dp-dots"><div class="dp-dot" style="background:${col(mDone)}"></div><div class="dp-dot" style="background:${col(eDone)}"></div></div>`;
  return `<div class="dp-dots"><div class="dp-dot" style="background:${col(hasMorn ? mDone : eDone)}"></div></div>`;
}

function renderWeekStrip(){
  const todayDow = getTodayDowIndex();
  const weekDates = getWeekDates();
  // Update week nav label + Today button
  const mon = weekDates[0], sat = weekDates[5];
  const navLabel = document.getElementById('week-nav-label');
  const navToday = document.getElementById('week-nav-today');
  if(navLabel) {
    const fmt = d => `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
    const wk = getCalendarWeek(mon);
    navLabel.textContent = `Wk ${wk} · ${fmt(mon)} – ${fmt(sat)}`;
  }
  if(navToday) navToday.classList.toggle('visible', viewingWeekOffset !== 0);
  const container = document.getElementById('week-strip');
  const pills = container.querySelectorAll('.day-pill');
  const needsFullRebuild = pills.length !== 7 || container.dataset.weekOffset !== String(viewingWeekOffset);

  if(needsFullRebuild){
    // First render — build full HTML
    container.innerHTML = DAYS.map((d,i) => {
      const date = weekDates[i];
      const dateState = getProgrammeState(date);
      const isPast = dateState.beforeStart;
      const dateStr = localDateStr(date);
      const isSelected = (i === cDay);
      const isLiveDay = (viewingWeekOffset === 0) && (i === cDay);
      const dayIsDone = !isPast && (doneDatesCache.has(dateStr) || (isLiveDay && isDayDone(exData.W[cPhase]?.[d],d)));
      const isTravelDay = !isPast && getTravelMode(dateStr);
      const dotsHTML = getSessionDots(i, d, dateStr, isPast, isLiveDay);
      _stripCache[i] = {isSelected, isPast, dayIsDone, isTravelDay, dotsHTML};
      return `<div class="day-pill ${isSelected?'active':''} ${isPast?'pre-start':''} ${dayIsDone?'done-day':''}"
        onclick="selectDay(${i})" style="${isPast?'opacity:.35':''}">
        <div class="dp-day">${d}</div>
        <div class="dp-num" style="font-size:12px;font-family:'DM Sans',sans-serif;font-weight:600;line-height:1.2">${formatDate(date)}</div>
        ${dotsHTML}
        ${isTravelDay ? '<div class="dp-travel">✈️</div>' : ''}
      </div>`;
    }).join('');
    container.dataset.weekOffset = String(viewingWeekOffset);
    return;
  }

  // Subsequent renders — patch only changed pills (no innerHTML on container)
  DAYS.forEach((d, i) => {
    const date = weekDates[i];
    const dateState = getProgrammeState(date);
    const isPast = dateState.beforeStart;
    const dateStr = localDateStr(date);
    const isSelected = (i === cDay);
    const isLiveDay = (viewingWeekOffset === 0) && (i === cDay);
    const dayIsDone = !isPast && (doneDatesCache.has(dateStr) || (isLiveDay && isDayDone(exData.W[cPhase]?.[d],d)));
    const isTravelDay = !isPast && getTravelMode(dateStr);
    const dotsHTML = getSessionDots(i, d, dateStr, isPast, isLiveDay);

    const prev = _stripCache[i] || {};
    if(prev.isSelected === isSelected && prev.dayIsDone === dayIsDone && prev.dotsHTML === dotsHTML && prev.isTravelDay === isTravelDay) return;
    _stripCache[i] = {isSelected, isPast, dayIsDone, isTravelDay, dotsHTML};

    const pill = pills[i];
    if(!pill) return;
    pill.classList.toggle('active', isSelected);
    pill.classList.toggle('done-day', dayIsDone);
    // Replace dots block
    const existingDots = pill.querySelector('.dp-dots');
    if(existingDots) existingDots.outerHTML = dotsHTML;
    // Patch travel indicator
    const existingTravel = pill.querySelector('.dp-travel');
    if(isTravelDay && !existingTravel){
      const te = document.createElement('div');
      te.className = 'dp-travel'; te.textContent = '✈️';
      pill.appendChild(te);
    } else if(!isTravelDay && existingTravel) {
      existingTravel.remove();
    }
  });
}

function patchWorkoutSets(){
  // Surgical update: only re-paint set chips and exercise done state
  // Called when loggedSets changes but day/phase hasn't changed
  const dk = DAYS[cDay];
  const w = exData.W[cPhase]?.[dk]?.[cSession];
  if(!w) return;
  // Use travel exercises if travel mode is active
  const isTravel = getTravelMode(selectedDateStr);
  const travelType = isTravel ? getTravelDayType(w) : null;
  const travelW = (travelType && travelType !== 'liss') ? exData.travelWorkouts[travelType] : null;
  const exList = (isTravel && travelW?.ex) ? travelW.ex : w.ex;
  if(!exList) return;
  exList.forEach((ex, ei) => {
    const sp = parseSets(ex.s);
    // Travel exercises never have MM sets
    const isFirst = isTravel ? false : (ei === 0);
    const exDone = isExerciseDone(ex.n, sp, isFirst);
    const ek = `ex_${cPhase}_${dk}_${cSession}_${ei}`;
    const rowEl = document.getElementById(ek);
    if(!rowEl) return;
    // Update ex-done class
    rowEl.classList.toggle('ex-done', exDone);
    // Update each set chip
    const grid = rowEl.querySelector('.sets-grid');
    if(!grid) return;
    const chips = grid.querySelectorAll('.set-chip:not(.mm-chip)');
    sp.forEach((s, si) => {
      const setNum = si + 1;
      const logKey = `${ex.n}|${setNum}|0`;
      const logged = loggedSets[logKey];
      const done = logged?.completed;
      const chip = chips[si];
      if(!chip) return;
      chip.classList.toggle('done', !!done);
      const loggedEl = chip.querySelector('.sc-logged');
      if(loggedEl) loggedEl.textContent = done && logged.weight>0 ? `${logged.weight}kg×${logged.reps}` : done ? '✓' : '';
    });
    // MM chip
    if(isFirst){
      const mmChip = grid.querySelector('.mm-chip');
      if(mmChip){
        const mmLogged = loggedSets[`${ex.n}|0|1`];
        const mmDone = mmLogged?.completed;
        mmChip.classList.toggle('done', !!mmDone);
        const mmLoggedEl = mmChip.querySelector('.sc-logged');
        if(mmLoggedEl) mmLoggedEl.textContent = mmDone ? 'done' : '';
      }
    }
  });

}

function patchCheckCache(){
  // Surgical update: re-paint warmup + cooldown checkboxes
  const dk = DAYS[cDay];
  // Warmup items
  exData.warmup.forEach(j => {
    const key = `wu_${dk}_${j.k}`;
    const li = document.querySelector(`li[data-wu="${key}"]`);
    if(!li) return;
    const done = !!checkCache[key];
    li.classList.toggle('done', done);
    const cb = li.querySelector('.cb');
    if(cb) cb.textContent = done ? '✓' : '';
  });
  // Cooldown items
  const w = exData.W[cPhase]?.[dk]?.[cSession];
  if(w?.cd) w.cd.forEach((_, i) => {
    const key = `cd_${cPhase}_${dk}_${cSession}_${i}`;
    const li = document.querySelector(`li[data-cd="${key}"]`);
    if(!li) return;
    const done = !!checkCache[key];
    li.classList.toggle('done', done);
    const cb = li.querySelector('.cb');
    if(cb) cb.textContent = done ? '✓' : '';
  });
  // Warmup progress bar
  const wuDone = exData.warmup.filter(j => checkCache[`wu_${dk}_${j.k}`]).length;
  const pct = Math.round(wuDone / exData.warmup.length * 100);
  const fill = document.querySelector('.wu-progress-fill');
  if(fill) fill.style.width = pct + '%';
  document.querySelectorAll('.wu-block div').forEach(d => {
    if(d.textContent.match(/^\d+\/\d+ complete$/)){
      d.textContent = `${wuDone}/${exData.warmup.length} complete`;
      d.style.color = pct===100 ? 'var(--yellow)' : 'var(--dim)';
    }
  });
  // Cardio log inputs (LISS + cardio finishers) — patch saved values into DOM.
  // Handles the timing edge case where loadSetsForDate resolves before
  // loadCheckCache, causing this function to run instead of a full renderWorkout.
  Object.keys(checkCache).forEach(key => {
    const cardio = checkCache[key];
    if (!cardio || typeof cardio !== 'object' || !cardio.saved) return;
    const incEl = document.getElementById(key+'-inc');
    const spdEl = document.getElementById(key+'-spd');
    const minEl = document.getElementById(key+'-min');
    if (!incEl && !spdEl && !minEl) return; // not a cardio log block on screen
    if (incEl) { incEl.value = cardio.incline != null ? cardio.incline : ''; incEl.readOnly = true; }
    if (spdEl) { spdEl.value = cardio.speed   != null ? cardio.speed   : ''; spdEl.readOnly = true; }
    if (minEl) { minEl.value = cardio.mins     != null ? cardio.mins    : ''; minEl.readOnly = true; }
    const wrap = (incEl || spdEl || minEl).closest('.cardio-log');
    const btn  = wrap?.querySelector('.cardio-save-btn');
    if (btn && !btn.disabled) { btn.textContent = '✓ LOGGED'; btn.classList.add('saved'); btn.disabled = true; }
  });
}

function renderPhaseBanner() {
  const bannerWrap = document.getElementById('phase-banner-wrap');
  if(bannerWrap) bannerWrap.innerHTML = '';
}

function renderWorkout(){
  Perf.start('renderWorkout');
  const dk=DAYS[cDay];
  const dayData = exData.W[cPhase]?.[dk] || {};
  const w = dayData[cSession];
  const viewDate = getDateForDay(cDay);
  const newRenderKey = `${cPhase}_${cDay}_${selectedDateStr}_${cSession}`;

  // If same day/phase — patch in-place instead of full rebuild
  if(_workoutRenderKey === newRenderKey && document.getElementById('workout-content').children.length > 0){
    patchWorkoutSets();
    patchCheckCache();
    return;
  }
  _workoutRenderKey = newRenderKey;
  // Reset strip cache so week strip also fully rebuilds on day change
  _stripCache = {};

  const viewState = getProgrammeState(viewDate);
  const isBeforeStart = viewState.beforeStart;
  // Use getCalendarWeek for the label — pure date math, no DB dependency
  const calWeekNum = isBeforeStart ? 1 : getCalendarWeek(viewDate);
  const weekLabel = isBeforeStart ? 'Before start' : `Week ${calWeekNum}`;
  document.getElementById('today-date-label').textContent=`${formatDate(viewDate).toUpperCase()} · ${weekLabel.toUpperCase()} · PHASE ${cPhase}`;
  document.getElementById('today-workout-title').textContent = isBeforeStart ? 'NOT STARTED' : (w?.title || '');
  document.getElementById('today-workout-sub').textContent = isBeforeStart ? 'Programme starts ' + formatDate(prog.start) : (w?.sub || w?.note || '');
  const c=document.getElementById('workout-content');

  // ── PHASE PROGRESS BANNER — rendered via renderPhaseBanner() ──
  const isViewingToday = (localDateStr(viewDate) === todayStr);
  renderPhaseBanner();

  if(isBeforeStart){
    c.innerHTML=`<div class="rest-card">
      <div class="rest-icon">🗓️</div>
      <h2>BEFORE START</h2>
      <p>This day is before ${formatDate(prog.start)}.<br>No workout to show.</p>
    </div>`;
    return;
  }

  // Session toggle — show when at least one session has exercises
  const morningSess = dayData.morning;
  const eveningSess = dayData.evening;
  const hasMorning = morningSess && !morningSess.isRest;
  const hasEvening = eveningSess && !eveningSess.isRest;
  let sessionToggleH = '';
  if(hasMorning || hasEvening){
    sessionToggleH = `<div class="session-toggle" style="display:flex;gap:8px;margin-bottom:12px;padding:0 16px">
      ${hasMorning ? `<button class="sess-btn${cSession==='morning'?' active':''}" onclick="setSession('morning')" style="flex:1;padding:10px;border-radius:10px;border:2px solid ${cSession==='morning'?'var(--p1)':'var(--border)'};background:${cSession==='morning'?'rgba(99,102,241,.15)':'transparent'};color:${cSession==='morning'?'var(--p1)':'var(--dim)'};font-weight:700;font-size:12px;cursor:pointer;letter-spacing:.5px">🌅 MORNING${morningSess?.location==='home'?' · HOME':''}</button>` : ''}
      ${hasEvening ? `<button class="sess-btn${cSession==='evening'?' active':''}" onclick="setSession('evening')" style="flex:1;padding:10px;border-radius:10px;border:2px solid ${cSession==='evening'?'var(--p1)':'var(--border)'};background:${cSession==='evening'?'rgba(99,102,241,.15)':'transparent'};color:${cSession==='evening'?'var(--p1)':'var(--dim)'};font-weight:700;font-size:12px;cursor:pointer;letter-spacing:.5px">🌆 EVENING${eveningSess?.location==='gym'?' · GYM':''}</button>` : ''}
    </div>`;
  }

  if(!w || w.isRest){
    const restLabel = cSession === 'morning' ? 'REST MORNING' : cSession === 'evening' ? 'REST EVENING' : 'REST';
    c.innerHTML=sessionToggleH+`<div class="rest-card"><div class="rest-icon">😴</div><h2>${restLabel}</h2><p>${w?.note||'Recovery is training. Sleep by 10:30pm. Prep meals. Muscles grow while you rest.'}</p></div>${renderSleepCardHTML()}`;
    return;
  }

  // ── TRAVEL MODE ── detect before LISS check so LISS can carry the travel flag too
  const isTravelDay = getTravelMode(selectedDateStr);
  const travelType = getTravelDayType(w);

  if(w.isLiss){ renderLiss(w, c, isTravelDay); return; }

  // Choose exercise list: travel bodyweight or regular programme
  const travelW = (isTravelDay && travelType && exData.travelWorkouts[travelType]) ? exData.travelWorkouts[travelType] : null;
  const exList = travelW ? travelW.ex : w.ex;

  // Pre-fetch previous bests for displayed exercises (non-blocking)
  if(exList) prefetchPreviousBests(exList);

  // Display properties — overridden when in travel mode
  const displayTitle = travelW ? travelW.title : w.title;
  const displaySub   = travelW ? travelW.sub   : w.sub;
  const displayDur   = travelW ? travelW.dur   : w.dur;
  const displayKcal  = travelW ? travelW.kcal  : w.kcal;
  const displayTags  = (travelW || w).tags;
  const tagH = displayTags.map(t=>`<span class="tag tag-${t}">${t.toUpperCase()}</span>`).join('');
  const isPowerDay = travelW ? false : !!w.isPower; // travel days never render as power

  let h = sessionToggleH;


  h+=`<div class="workout-card">`;
  if(isPowerDay){
    h+=`<div class="power-header"><div class="power-title">⚡ ${w.title}</div><div class="power-sub">${w.sub}</div>
    <div class="intensity-bar"><div class="intensity-label">INTENSITY</div>
    <div class="intensity-dots">${[1,2,3,4,5].map(i=>`<div class="dot ${i<=4?'lit':'half'}"></div>`).join('')}</div>
    <div style="font-size:11px;color:var(--gold);margin-left:4px">85% 1RM · 5×3</div></div></div>`;
  } else {
    h+=`<div class="wc-header"><div><div class="wc-day">${displayTitle}</div><div style="margin-top:4px">${tagH}</div></div>
    <div class="wc-meta"><div class="wc-duration">${displayDur}'</div><div class="wc-kcal">${displayKcal} kcal</div></div></div>`;
  }
  if(w.wu){
    h+=`<div class="sec-label" style="border-top:none;padding-top:8px">WARMUP</div>`;
    h+=renderUniversalWarmup(dk, isPowerDay);
  } else if(w.wuNote){
    h+=`<div class="sec-label" style="border-top:none;padding-top:8px">WARMUP</div>`;
    h+=`<div style="margin:0 16px 12px;padding:10px 14px;border-radius:10px;background:var(--surface2);border:1px solid var(--border);font-size:12px;color:var(--muted);line-height:1.7">${w.wuNote}</div>`;
  }
  h+=`</div>`;
  h+=`<div class="workout-card" style="border-radius:0 0 16px 16px;margin-top:0">`;
  h+=`<div class="sec-label" style="border-top:none;padding-top:8px">EXERCISES${travelW?'<span style="margin-left:8px;font-size:9px;font-weight:700;letter-spacing:.5px;padding:2px 6px;border-radius:4px;background:rgba(6,182,212,.15);color:var(--cyan);vertical-align:middle">BODYWEIGHT</span>':''}</div>`;
  exList.forEach((ex,ei)=>{
    const ek=`ex_${cPhase}_${dk}_${cSession}_${ei}`;
    const sp=parseSets(ex.s);
    // MM set only on first weighted non-circuit exercise.
    const isFirst = !travelW && ei===0 && !ex.circuit && ex.eq?.some(e=>['db','mach','cable','bb','kb'].includes(e));
    const mmKey=`${ex.n}|0|1`;
    const mmDone=loggedSets[mmKey]?.completed;
    const mmChip = isFirst ? `<div class="set-chip mm-chip ${mmDone?'done':''}" onclick="openSetModal('${esc(ex.n)}',0,true,this,${ei})">
      <div class="sc-num" style="color:var(--gold)">MM</div>
      <div class="sc-reps" style="color:var(--gold);opacity:.8">no wt</div>
      <div class="sc-logged">${mmDone?'done':''}</div>
    </div>` : '';
    const setsH = mmChip + sp.map((s,si)=>{
      const setNum=si+1;
      const logKey=`${ex.n}|${setNum}|0`;
      const logged=loggedSets[logKey];
      const done=logged?.completed;
      return `<div class="set-chip ${done?'done':''}" onclick="openSetModal('${esc(ex.n)}',${setNum},false,this,${ei})">
        <div class="sc-num">${ex.circuit?'R':'S'}${setNum}</div>
        <div class="sc-reps">${s}</div>
        <div class="sc-logged">${done&&logged.weight>0?logged.weight+'kg×'+logged.reps:done?'✓':''}</div>
      </div>`;
    }).join('');
    if(ex.circuitGroup && ex.circuitGroup !== exList[ei-1]?.circuitGroup) {
      const rounds = parseSets(ex.s).length;
      const grpLabel = ex.circuitGroup === 'CORE' ? `CORE — ${rounds} ROUNDS` : `CIRCUIT ${ex.circuitGroup} — ${rounds} ROUNDS`;
      h += `<div class="circuit-group-hdr">${grpLabel}</div>`;
    }
    const exDone = isExerciseDone(ex.n, sp, isFirst);
    h+=`<div class="ex-row${exDone?' ex-done':''}" id="${ek}">
      <div class="ex-main" onclick="tEx('${ek}')">`
        <div class="ex-info">
          <div class="ex-name">${ex.n}${travelW?'<span style="margin-left:6px;font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(6,182,212,.12);color:var(--cyan);font-weight:700;letter-spacing:.3px">BW</span>':''}</div>
          <div class="ex-sets">${isFirst?'<span style="color:var(--gold);font-size:10px">MM → </span>':''}${ex.s}${ex.r ? ' · '+ex.r+' rest' : ex.circuit ? ' · ↗ next' : ''}</div>
          <div class="ex-equip">${ex.eq.join('')}</div>
        </div>
        <div class="ex-chevron">▾</div>
      </div>
      <div class="ex-detail"><div class="ex-detail-inner">
        ${isFirst?`<div class="ex-new" style="border-color:var(--gold);color:var(--gold)">🧠 MM SET FIRST — No weight. Full ROM. Feel the muscle. Then load up.</div>`:''}
        ${ex.warn?`<div class="ex-warn">${ex.warn}</div>`:''}
        ${exData.gifs[ex.n]?`<button class="demo-btn" id="demo-btn-${ei}" onclick="toggleDemo(${ei},'${esc(ex.n)}')">▶ View Demo</button>
        <div class="demo-gif" id="demo-gif-${ei}" style="display:none">
          <div class="demo-loading" id="demo-loading-${ei}">Loading...</div>
          <img id="demo-img-${ei}" alt="${ex.n} form" class="demo-img"
            onload="this.style.opacity=1;document.getElementById('demo-loading-${ei}').style.display='none'"
            onerror="document.getElementById('demo-gif-${ei}').style.display='none'">
        </div>`:''}
        <div class="ex-note">${ex.note}</div>
        <div class="sets-grid">${setsH}</div>
      </div></div>
    </div>`;
  });
  h+=`</div>`;
  // Finisher: skip on travel days (no equipment)
  if(w.fin && !travelW) h+=renderFinHTML(w.fin,cPhase,dk,cSession);
  if(w.cd?.length){
    h+=`<div class="cd-block"><div class="block-title">COOLDOWN</div><ul class="checklist">`;
    w.cd.forEach((it,i)=>{
      const k=`cd_${cPhase}_${dk}_${cSession}_${i}`;
      const done=checkCache[k]?'done':'';
      h+=`<li class="${done}" data-cd="${k}" onclick="toggleCheck('${k}','cooldown',this)"><div class="cb">${checkCache[k]?'✓':''}</div><span>${it}</span></li>`;
    });
    h+=`</ul></div>`;
  }
  h+=renderCreatineBannerHTML();
  h+=renderHydrationHTML();
  c.innerHTML=h;
  Perf.end('renderWorkout');
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

// Returns true if every set (including MM if isFirst) for an exercise is logged complete
function isExerciseDone(exName, sp, isFirst){
  if(isFirst){
    const mmKey = exName+'|0|1';
    if(!loggedSets[mmKey]?.completed) return false;
  }
  return sp.every((_,si) => loggedSets[exName+'|'+(si+1)+'|0']?.completed);
}

function isSessionDone(sess, dayData, dk){
  const w = dayData?.[sess];
  if(!w || w.isRest) return false;
  if(w.isLiss){
    const lissKey = `liss_${cPhase}_${dk}_${sess}`;
    return !!(checkCache[lissKey]?.saved || (typeof checkCache[lissKey]==='boolean' && checkCache[lissKey]));
  }
  if(!w.ex) return false;
  return w.ex.every((ex, ei) => isExerciseDone(ex.n, parseSets(ex.s), ei===0));
}

// Returns true if the morning session is done (morning is the anchor session for doneDatesCache)
function isDayDone(dayData, dk){
  return isSessionDone('morning', dayData, dk);
}

function parseSets(s){ const m=s.match(/^(\d+)\s*[×x]\s*(.+?)(?:\s*[@(]|$)/); if(!m)return[s]; return Array(parseInt(m[1])).fill(m[2].trim()); }
function tEx(id){
  const r = document.getElementById(id);
  if(!r) return;
  r.classList.toggle('open');
}

function toggleDemo(idx, exName){
  const gifEl  = document.getElementById('demo-gif-' + idx);
  const btnEl  = document.getElementById('demo-btn-' + idx);
  if(!gifEl || !btnEl) return;
  const opening = gifEl.style.display === 'none';
  // Close all other open demos
  document.querySelectorAll('.demo-gif').forEach(function(el){
    if(el !== gifEl && el.style.display !== 'none'){
      el.style.display = 'none';
      const b = document.getElementById(el.id.replace('demo-gif-','demo-btn-'));
      if(b) b.textContent = '▶ View Demo';
    }
  });
  if(opening){
    gifEl.style.display = 'block';
    btnEl.textContent = '✕ Hide Demo';
    // Lazy load — fetch URL only on first tap
    const imgEl = document.getElementById('demo-img-' + idx);
    if(imgEl && !imgEl.dataset.loaded){
      imgEl.dataset.loaded = '1';
      getExerciseGif(exName).then(function(url){
        if(url){ imgEl.src = url; }
        else { gifEl.style.display = 'none'; }
      });
    }
  } else {
    gifEl.style.display = 'none';
    btnEl.textContent = '▶ View Demo';
  }
}

// ============================================================
// CARDIO LOG (LISS day + cardio finishers)
// ============================================================

async function saveCardioLog(logKey, btnEl){
  const incline = parseFloat(document.getElementById(logKey+'-inc').value)||0;
  const speed   = parseFloat(document.getElementById(logKey+'-spd').value)||0;
  const mins    = parseFloat(document.getElementById(logKey+'-min').value)||0;
  if(!mins){ showToast('Enter duration at minimum','error'); return; }
  checkCache[logKey] = {incline, speed, mins, saved:true};
  btnEl.textContent = '✓ LOGGED';
  btnEl.classList.add('saved');
  setSyncStatus('syncing');
  try {
    await withRetry(() =>
      db.from('checklist_logs').upsert({
        date: selectedDateStr,
        item_type: 'cardio',
        item_key: logKey,
        completed: true,
        notes: JSON.stringify({incline, speed, mins})
      }, {onConflict:'date,item_key'})
        .then(r => { if(r.error) throw r.error; })
    );
    setSyncStatus('synced');
    showToast(`${mins} min logged ✓`);
    loadWeekActivity().then(() => renderWeekStrip());
  } catch(e){
    setSyncStatus('error');
    queueOfflineSave({
      table: 'checklist_logs', onConflict: 'date,item_key',
      conflictKey: `${selectedDateStr}|${logKey}`,
      data: { date: selectedDateStr, item_type: 'cardio', item_key: logKey, completed: true, notes: JSON.stringify({incline, speed, mins}) },
    });
  }
}

function renderCardioLogHTML(logKey, title, targetMins){
  const saved = checkCache[logKey];
  const isSaved = saved?.saved || (typeof saved === 'boolean' && saved);
  const inc = saved?.incline||'';
  const spd = saved?.speed||'';
  const mins = saved?.mins||'';
  return `<div class="cardio-log">
    <div class="cardio-log-title">🏃 ${title} <span style="color:var(--dim);font-weight:400">· Target: ${targetMins} min</span></div>
    <div class="cardio-fields">
      <div class="cardio-field"><label>Incline %</label><input id="${logKey}-inc" type="number" inputmode="decimal" placeholder="5" value="${inc}" ${isSaved?'readonly':''}></div>
      <div class="cardio-field"><label>Speed km/h</label><input id="${logKey}-spd" type="number" inputmode="decimal" placeholder="6" value="${spd}" ${isSaved?'readonly':''}></div>
      <div class="cardio-field"><label>Duration min</label><input id="${logKey}-min" type="number" inputmode="decimal" placeholder="${targetMins}" value="${mins}" ${isSaved?'readonly':''}></div>
    </div>
    <button class="cardio-save-btn ${isSaved?'saved':''}" onclick="saveCardioLog('${logKey}',this)" ${isSaved?'disabled':''}>
      ${isSaved?'✓ LOGGED':'LOG CARDIO'}
    </button>
  </div>`;
}

function renderFinHTML(f,ph,dk,sess='morning'){
  // Cardio finisher — log incline/speed/duration
  if(f.type==='cardio'){
    const targetMins = parseInt(f.dur)||20;
    const logKey = `fin_cardio_${ph}_${dk}_${sess}`;
    return `<div class="hiit-block"><div class="hiit-title">🔥 ${f.title}</div>
      <div class="hiit-desc" style="margin-bottom:8px">${f.desc} · ${f.kcal}</div>
      ${renderCardioLogHTML(logKey, 'Treadmill', targetMins)}
    </div>`;
  }
  // HIIT / Ropes / Tyre — round checkboxes
  const ic=f.type==='ropes'?'💥':f.type==='tyre'?'🔥':'⚡';
  const rH=f.rounds.map((r,i)=>{
    const k=`fin_${ph}_${dk}_${sess}_${i}`;
    const done=checkCache[k]?'done':'';
    return `<div class="hiit-round ${done}" onclick="toggleCheck('${k}','finisher',this)">${r}</div>`;
  }).join('');
  return `<div class="hiit-block"><div class="hiit-title">${ic} ${f.title}</div><div class="hiit-desc">${f.desc} ${f.dur} · ${f.kcal}</div><div class="hiit-rounds">${rH}</div></div>`;
}

function renderCreatineBannerHTML(){
  const done=checkCache['creatine_today'];
  return `<div class="creatine-banner"><div class="creatine-icon">⚗️</div>
  <div class="creatine-text"><strong>Creatine 5g</strong> — add to post-workout shake. Every day.</div>
  <div class="creatine-cb ${done?'done':''}" onclick="toggleCreatine(this)">${done?'✓':''}</div></div>`;
}

function renderSleepCardHTML(){
  const items=['In bed by 10:30pm','No screens 30 min before bed','Room dark and cool (18–20°C)','7+ hours sleep'];
  let h=`<div class="sleep-card"><div class="sleep-title">🌙 SLEEP PROTOCOL</div><div class="sleep-items">`;
  items.forEach((it,i)=>{
    const k=`sleep_${i}`;const done=checkCache[k]?'done':'';
    h+=`<div class="sleep-item ${done}" onclick="toggleCheck('${k}','sleep',this)"><div class="s-cb">${checkCache[k]?'✓':''}</div><span>${it}</span></div>`;
  });
  return h+`</div></div>`;
}

function renderHydrationHTML(){
  const glassH=Array(8).fill(0).map((_,i)=>`<div class="glass-btn ${i<hydrationGlasses?'filled':''}" onclick="toggleGlass(${i+1})">💧</div>`).join('');
  return `<div class="hydration-row" id="hyd-row">
    <div class="hyd-title">💧 WATER — 4L TARGET</div>
    <div class="hyd-glasses">${glassH}</div>
    <div class="hyd-total"><span>${(hydrationGlasses*.5).toFixed(1)}L</span> of 4L · each = 500ml</div>
  </div>`;
}

function renderLiss(w,c,isTravelDay=false){
  const dk=DAYS[cDay];
  const lissKey = `liss_${cPhase}_${dk}_${cSession}`;
  const targetMins = parseInt(w.dur)||45;
  // Travel LISS note
  const travelNote = isTravelDay
    ? `<div class="travel-active-banner" style="margin:0 0 10px">✈️ <strong>Travel LISS:</strong> Brisk walk, jog, or stair climbing — 30–45 min. No treadmill needed.</div>`
    : '';
  // Load saved cardio data into checkCache if stored as JSON in notes
  let h='';
  // Travel toggle (LISS days too)
  h += renderTravelToggle(isTravelDay, 'liss');
  h+=`<div class="workout-card"><div class="wc-header">
    <div><div class="wc-day">${w.title}${isTravelDay?' <span style="font-size:13px">✈️</span>':''}</div><div style="margin-top:4px"><span class="tag tag-liss">LISS</span></div></div>
    <div class="wc-meta"><div class="wc-duration">${w.dur}'</div></div></div>
    ${travelNote}
    <div class="liss-main">${isTravelDay ? '✈️ Travel LISS — choose any of:\n• 30–45 min brisk walk (outdoors or hotel corridor laps)\n• Jog at easy pace — talk test: can still hold a conversation\n• Stair climbing — hotel stairs, any multi-floor building\n• Skipping rope if you have one\n\nLog your time below.' : w.liss.main}</div>
    <div class="liss-log-wrap">${renderCardioLogHTML(lissKey, isTravelDay ? 'Walk / Jog / Stairs' : 'Incline Treadmill', targetMins)}</div>
    </div>`;
  h+=`<div class="cd-block"><div class="block-title">COOLDOWN</div><ul class="checklist">`;
  w.cd.forEach((it,i)=>{
    const k=`cd_${cPhase}_${dk}_${i}`;const done=checkCache[k]?'done':'';
    h+=`<li class="${done}" data-cd="${k}" onclick="toggleCheck('${k}','cooldown',this)"><div class="cb">${checkCache[k]?'✓':''}</div><span>${it}</span></li>`;
  });
  h+=`</ul></div>${renderCreatineBannerHTML()}${renderSleepCardHTML()}${renderHydrationHTML()}`;
  c.innerHTML=h;
}

// ============================================================
// PROGRESS SCREEN
// ============================================================
// _progressLastFetch now in store

// ── Week navigation ──
export function navWeek(dir){
  setViewingWeekOffset(viewingWeekOffset + dir);
  invalidateWeekMemo();
  const navToday = document.getElementById('week-nav-today');
  if(navToday) navToday.classList.toggle('visible', viewingWeekOffset !== 0);
  renderWeekStrip();
}

// ── Expose helpers used by programme.js and timer.js via global scope ──
window.parseSets      = parseSets;
window.isExerciseDone = isExerciseDone;
window.isDayDone      = isDayDone;
window.commitSet      = commitSet;  // used by timer.js logTimedSetNow

// ── Exports — all functions imported by app.js ──
export {
  renderWeekStrip, renderWorkout, renderPhaseBanner,
  openSetModal, handleModalClick, closeModal, saveSet, skipSet,
  saveCardioLog, toggleWarmup, toggleCheck, toggleCreatine, toggleGlass,
  toggleTravelMode, prefetchPreviousBests, selectPhase, selectDay,
  patchWorkoutSets, patchCheckCache, renderHydrationRow, tEx, toggleDemo,
  parseSets, isExerciseDone, isDayDone,
};
