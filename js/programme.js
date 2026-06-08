// ============================================================
// PROGRAMME — date arithmetic, phase/week logic, programme DB ops.
// All functions are pure calculation or lightweight DB reads — no rendering.
// ============================================================
import { db } from './config.js';
import { store } from './store.js';

// ── Mutable programme state (set by data.js → applyExerciseData) ──
// Use the prog container so other modules can import and observe mutations.
export const prog = {
  CFG:           {},
  start:         null,   // replaces PROGRAMME_START
  phaseWeeks:    {},     // replaces PHASE_WEEKS
  minActiveDays: 5,      // replaces MIN_ACTIVE_DAYS
  weekTargets:   {},     // replaces WEEK_TARGETS
};

// ── Calendar constants ──
export const DAYS       = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
export const DAY_LABELS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
export const MONTH_NAMES= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Week navigation state ──
export let viewingWeekOffset = 0;
export function setViewingWeekOffset(v) { viewingWeekOffset = v; }

// ── Memoized week dates ──
let _weekDatesMemo    = null;
let _weekDatesMemoKey = null;
export function invalidateWeekMemo() { _weekDatesMemo = null; _weekDatesMemoKey = null; }

// ── Programme config DB row ID (held here to avoid re-inserting) ──
let _programmeConfigId = null;

// ── Date helpers ──
export function getTodayDowIndex() {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}

export function getWeekDates() {
  const todayKey = localDateStr() + '_' + viewingWeekOffset;
  if (_weekDatesMemoKey === todayKey && _weekDatesMemo) return _weekDatesMemo;
  const today = new Date(); today.setHours(0,0,0,0);
  const dayOfWeek = today.getDay();
  const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mon = new Date(today);
  mon.setDate(today.getDate() + daysToMon + viewingWeekOffset * 7);
  mon.setHours(0,0,0,0);
  _weekDatesMemo = Array.from({length:7}, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    d.setHours(0,0,0,0);
    return d;
  });
  _weekDatesMemoKey = todayKey;
  return _weekDatesMemo;
}

export function getDateForDay(dowIndex) { return getWeekDates()[dowIndex]; }

export function getCalendarWeek(date) {
  const d = (typeof date === 'string') ? parseLocalDate(date) : new Date(date);
  d.setHours(0,0,0,0);
  const start = new Date(prog.start.getTime()); start.setHours(0,0,0,0);
  const startDay = start.getDay();
  const startMonday = new Date(start);
  startMonday.setDate(start.getDate() - (startDay === 0 ? 6 : startDay - 1));
  startMonday.setHours(0,0,0,0);
  if(d < startMonday) return 0;
  const dDay = d.getDay();
  const dMonday = new Date(d);
  dMonday.setDate(d.getDate() - (dDay === 0 ? 6 : dDay - 1));
  dMonday.setHours(0,0,0,0);
  return Math.max(Math.round((dMonday - startMonday) / (7 * 86400000)) + 1, 1);
}

export function computePhaseFromHistory(history, currentCalendarWeek) {
  let phase = 1, qualifyingInPhase = 0;
  const needed = () => prog.phaseWeeks[phase] || 999;
  for(let w = 1; w < currentCalendarWeek; w++) {
    const days = history[w] || 0;
    if(days >= prog.minActiveDays) {
      qualifyingInPhase++;
      if(qualifyingInPhase >= needed() && phase < 5) { phase++; qualifyingInPhase = 0; }
    }
  }
  return { phase, qualifyingInPhase, remaining: needed() - qualifyingInPhase, neededTotal: needed() };
}

export function getProgrammeState(date, overrideStart) {
  const d = (typeof date === 'string') ? parseLocalDate(date) : new Date(date);
  d.setHours(0,0,0,0);
  const startSrc = overrideStart || prog.start;
  const start = new Date(startSrc.getTime()); start.setHours(0,0,0,0);
  const dayNum  = Math.floor((d - start) / 86400000);
  const js      = d.getDay();
  const dowIndex = js === 0 ? 6 : js - 1;
  if(dayNum < 0) return { phase:1, week:1, dowIndex, dayNum, beforeStart:true, daysUntil:-dayNum };
  const calWeek  = getCalendarWeek(d);
  const phaseData = computePhaseFromHistory(weekActivityCache, calWeek);
  return {
    phase: phaseData.phase, week: calWeek, dowIndex, dayNum, beforeStart: false, daysUntil: 0,
    qualifyingInPhase: phaseData.qualifyingInPhase,
    remaining: phaseData.remaining, neededTotal: phaseData.neededTotal,
  };
}

export function getLastWeekStatus() {
  const curWeek = getCalendarWeek(new Date());
  if(curWeek <= 1) return null;
  const lastWeek = curWeek - 1;
  const days = weekActivityCache[lastWeek] || 0;
  const qualified = days >= prog.minActiveDays;
  const phaseAtLastWeek = computePhaseFromHistory(weekActivityCache, lastWeek);
  return { week: lastWeek, days, qualified, phase: phaseAtLastWeek.phase };
}

export function getThisWeekProgress(calWeek) {
  const weekDates = getWeekDates();
  const todayLocal = new Date(); todayLocal.setHours(0,0,0,0);
  const days = [];
  for(let i = 0; i < 6; i++) {
    const d = weekDates[i];
    const dateStr  = localDateStr(d);
    const isFuture = d > todayLocal;
    const isSelectedDay = (i === cDay);
    const inCache  = doneDatesCache.has(dateStr);
    // isDayDone is imported lazily to avoid circular dep — accessed via window
    // exData is set on window by data.js; safe access avoids circular import
    const liveCheck = isSelectedDay && !isFuture &&
                      typeof isDayDone === 'function' &&
                      isDayDone(window.exData?.W?.[cPhase]?.[DAYS[i]], DAYS[i]);
    const isDone = inCache || (!isFuture && liveCheck);
    days.push({ dateStr, isDone, isFuture, label: DAYS[i] });
  }
  const logged = weekActivityCache[calWeek] || 0;
  const todayDowIndex = getTodayDowIndex();
  const weekLocked = todayDowIndex === 6 && logged >= prog.minActiveDays;
  return { logged, target: prog.minActiveDays, days, weekLocked, calWeek };
}

export async function loadWeekActivity() {
  try {
    const [exRes, cardioRes] = await Promise.all([
      db.from('exercise_logs').select('date, exercise_name, set_number')
        .eq('completed', true).neq('is_mm_set', true),
      db.from('checklist_logs').select('date, item_key, item_type')
        .eq('completed', true).eq('item_type', 'cardio'),
    ]);

    const byDate = {};
    if(exRes.data) exRes.data.forEach(row => {
      if(!byDate[row.date]) byDate[row.date] = new Set();
      byDate[row.date].add(row.exercise_name + '|' + row.set_number);
    });

    const cardioDates = new Set();
    if(cardioRes.data) cardioRes.data.forEach(row => cardioDates.add(row.date));

    const countingDates = new Set([
      ...Object.keys(byDate).filter(d => {
        const regularSets = [...byDate[d]].filter(k => !k.endsWith('|0')).length;
        if(regularSets < 5) return false;
        return parseLocalDate(d).getDay() !== 0;
      }),
      ...Array.from(cardioDates).filter(d => parseLocalDate(d).getDay() !== 0),
    ]);

    const allLoggedDates = new Set([
      ...Object.keys(byDate).filter(d => [...byDate[d]].filter(k => !k.endsWith('|0')).length >= 5),
      ...cardioDates,
    ]);
    doneDatesCache = new Set(allLoggedDates);
    setTimeout(() => window.renderPhaseBanner?.(), 0);

    const weekDays = {};
    countingDates.forEach(dateStr => {
      const wk = getCalendarWeek(parseLocalDate(dateStr));
      if(wk <= 0) return;
      if(!weekDays[wk]) weekDays[wk] = new Set();
      weekDays[wk].add(dateStr);
    });
    weekActivityCache = {};
    Object.entries(weekDays).forEach(([wk, dates]) => {
      weekActivityCache[parseInt(wk)] = dates.size;
    });
  } catch(e) { console.error('loadWeekActivity', e); }
}

export function formatDate(date)   { return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`; }
export function localDateStr(date) {
  const d = date || new Date(), pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}
export function getTodayDateStr()  { return localDateStr(); }
export function parseLocalDate(dateStr) {
  if(!dateStr) return new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m-1, d, 0, 0, 0, 0);
}

// ── Measurement due helpers ──
export function isMeasurementDue() {
  const last = localStorage.getItem('lastMeasurementDate');
  if(!last) return true;
  return daysSinceMeasurement() >= 28;
}
export function daysSinceMeasurement() {
  const last = localStorage.getItem('lastMeasurementDate');
  if(!last) return 999;
  return Math.floor((new Date() - parseLocalDate(last)) / (1000*60*60*24));
}

// ── Programme config DB ops ──
export async function loadProgrammeConfig() {
  try {
    const { data, error } = await db.from('programme_config').select('*').limit(1).maybeSingle();
    if(error) { console.warn('loadProgrammeConfig:', error.message); return; }
    if(data?.start_date) {
      _programmeConfigId = data.id;
      prog.start = parseLocalDate(data.start_date);
    }
  } catch(e) { console.warn('loadProgrammeConfig exception:', e); }
}

export async function saveProgrammeConfig(dateStr) {
  const payload = { start_date: dateStr, updated_at: new Date().toISOString() };
  if(_programmeConfigId) {
    const { error } = await db.from('programme_config').update(payload).eq('id', _programmeConfigId);
    if(error) throw error;
  } else {
    const { data, error } = await db.from('programme_config').insert(payload).select('id').single();
    if(error) throw error;
    _programmeConfigId = data.id;
  }
}

export async function applyNewStartDate(dateStr) {
  const confirmBtn = document.getElementById('reset-modal-confirm');
  if(confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Applying…'; }
  try {
    await saveProgrammeConfig(dateStr);
    prog.start          = parseLocalDate(dateStr);
    _weekDatesMemo      = null;
    _weekDatesMemoKey   = null;
    window._stripCache        = {};
    window._workoutRenderKey  = null;
    weekActivityCache   = {};
    doneDatesCache      = new Set();
    viewingWeekOffset   = 0;
    todayStr            = getTodayDateStr();
    selectedDateStr     = todayStr;
    cDay                = getTodayDowIndex();
    await loadWeekActivity();
    const state = getProgrammeState(new Date());
    cPhase = state.phase;
    document.querySelectorAll('#phase-strip .ph-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.ph) === cPhase);
    });
    const [sessionRes] = await Promise.all([
      db.from('workout_sessions').select('*').eq('date', todayStr).eq('day_of_week', DAYS[cDay]).limit(1),
      window.loadSetsForDate?.(todayStr, true),
      window.loadCheckCache?.(todayStr),
      window.loadHydration?.(todayStr),
    ]);
    if(sessionRes.data?.length) sessionId = sessionRes.data[0].id;
    window.closeResetModal?.();
    window.renderWeekStrip?.();
    window.renderWorkout?.();
    window.renderSettings?.();
    window.showToast?.(`Programme starts ${formatDate(prog.start)} ✓`);
  } catch(e) {
    console.error('applyNewStartDate:', e);
    window.showToast?.('Failed to save — check connection', 'error');
  } finally {
    if(confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Apply'; }
  }
}
