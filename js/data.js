// ============================================================
// DATA — exercise/programme data loaded from exercises.json.
// ExCache wraps IDB for stale-while-revalidate.
// exData container is exported so other modules observe mutations.
// ============================================================
import { prog } from './programme.js';
import { parseLocalDate } from './programme.js';

// ── Mutable data container — exported as const so property mutations are visible ──
export const exData = {
  W:       {},    // workout plan by phase/day
  EQ:      {},    // equipment HTML tag strings
  gifs:    {},    // exercise GIF URLs
  warmup:  [],    // universal warmup items
};
// Also set on window so legacy code in other modules can access without import
Object.defineProperty(window, 'exData', { get(){ return exData; }, configurable: true });
// Backward-compat globals referenced throughout the codebase
Object.defineProperty(window, 'W',            { get(){ return exData.W;     }, set(v){ exData.W = v;     }, configurable: true });
Object.defineProperty(window, 'EQ',           { get(){ return exData.EQ;    }, set(v){ exData.EQ = v;    }, configurable: true });
Object.defineProperty(window, 'EXERCISE_GIFS',{ get(){ return exData.gifs;  }, set(v){ exData.gifs = v;  }, configurable: true });
Object.defineProperty(window, 'WARMUP_ITEMS', { get(){ return exData.warmup;}, set(v){ exData.warmup = v;}, configurable: true });

// ── Travel workouts (bodyweight fallback, no DB needed) ──
export const TRAVEL_WORKOUTS = {
  push: {
    type:'push', title:'PUSH — TRAVEL MODE',
    sub:'Bodyweight only · No equipment needed',
    dur:'45', kcal:'280', tags:['push'],
    cd:['Chest & shoulder cross-body stretch 30s each','Tricep overhead stretch 30s each','Wrist circles 10× each direction'],
    ex:[
      {n:'Pike Push-Ups',        ic:'🏔️', s:'3×8-10',        r:'60s',  eq:[], note:'Hips high in downward-dog position. Lower forehead toward floor. Targets shoulders heavily. Full ROM.', warn:null},
      {n:'Incline Push-Ups',     ic:'🔼', s:'3×12-15',       r:'60s',  eq:[], note:'Hands elevated on bed or desk edge. Upper chest focus. 2s descent, pause at chest.', warn:'Wrist mod: use fists if flat-palm position loads wrists.'},
      {n:'Decline Push-Ups',     ic:'🔽', s:'3×10-12',       r:'60s',  eq:[], note:'Feet elevated on chair or bed. Lower chest + anterior delt. Keep core braced throughout.', warn:null},
      {n:'Tricep Dips (Chair)',   ic:'💺', s:'3×12',          r:'60s',  eq:[], note:'Hands on chair edge behind you, feet extended forward. Elbows track straight back — not flared.', warn:'Wrist mod: keep hands parallel with fingers pointing forward. Skip if wrists load painfully.'},
      {n:'Shoulder Taps',        ic:'✋', s:'3×20 taps',     r:'45s',  eq:[], note:'Plank position. Lift one hand, tap opposite shoulder. Minimise hip rotation. Core stays locked.', warn:null},
    ]
  },
  pull: {
    type:'pull', title:'PULL — TRAVEL MODE',
    sub:'Bodyweight only · No equipment needed',
    dur:'45', kcal:'250', tags:['pull'],
    cd:["Lat stretch 30s each side (arm overhead, lean away)","Child's pose 60s","Thoracic extension on floor 10 reps"],
    ex:[
      {n:'Superman Holds',           ic:'🦸', s:'3×10 (3s hold)',       r:'60s',  eq:[], note:'Lie face down. Raise chest + legs simultaneously. Squeeze glutes hard. Hold 3s at top.', warn:null},
      {n:'Reverse Snow Angels',      ic:'🌨️', s:'3×12',                  r:'60s',  eq:[], note:'Face down, arms by sides. Sweep arms out and overhead in a full arc. Keep chest elevated.', warn:null},
      {n:'Bodyweight Rows (Table)',   ic:'🪑', s:'3×10-12',              r:'90s',  eq:[], note:'Lie under a sturdy table. Grip edge, pull chest to it. Keep body in a rigid plank — no sagging hips.', warn:'Wrist mod: wrap a towel around table edge for a neutral-grip handle.'},
      {n:'Prone Y-T-W Holds',        ic:'💪', s:'3×8 each position',    r:'60s',  eq:[], note:'Face down. Arms in Y (overhead), T (90° out), W (bent elbows pulled back). 2s pause per position. Posterior delt gold.', warn:null},
      {n:'Dead Hangs (If Available)',ic:'🏋️', s:'3×20-30s',              r:'60s',  eq:[], note:'Any overhead bar — door-frame pullup bar, jungle gym, or sturdy beam. Passive hang, shoulders packed.', warn:'Skip if no suitable bar is available — not mandatory.'},
    ]
  },
  legs: {
    type:'legs', title:'LEGS — TRAVEL MODE',
    sub:'Bodyweight only · No equipment needed',
    dur:'50', kcal:'320', tags:['legs'],
    cd:['Quad stretch 30s each leg','Hip flexor lunge 45s each side','Calf stretch on step or wall 30s each'],
    ex:[
      {n:'Bodyweight Squats',        ic:'🦵', s:'4×15-20',      r:'60s',  eq:[], note:'Full depth, heels flat. 1s pause at bottom. Drive through whole foot on the way up.', warn:null},
      {n:'Reverse Lunges',           ic:'🚶', s:'3×12 each leg', r:'60s',  eq:[], note:'Step back — easier on knees than forward lunge. Front knee stays over ankle. Hip drops close to floor.', warn:null},
      {n:'Glute Bridges',            ic:'🌉', s:'3×15 (3s hold)', r:'60s', eq:[], note:'Back flat on floor, heels close to glutes. Drive hips up and squeeze hard at top for 3s.', warn:null},
      {n:'Wall Sit',                 ic:'🧱', s:'3×45-60s',      r:'60s',  eq:[], note:'Thighs parallel to floor, back flat on wall. Hands on quads — not pushing off the wall.', warn:null},
      {n:'Step-Ups',                 ic:'🪜', s:'3×15 each leg', r:'60s',  eq:[], note:'Use bed, sturdy chair, or stairs. Full hip extension at top. Control the descent.', warn:null},
      {n:'Single-Leg Calf Raises',   ic:'🦶', s:'3×15 each',    r:'45s',  eq:[], note:'Hold wall lightly for balance only. Full ROM — all the way down, all the way up.', warn:null},
    ]
  },
  fullbody: {
    type:'fullbody', title:'FULL BODY — TRAVEL MODE',
    sub:'Bodyweight circuit · No equipment needed',
    dur:'45', kcal:'350', tags:['push','legs'],
    cd:['Full body stretch 5 min','Child pose 60s','Pigeon pose 30s each hip'],
    ex:[
      {n:'Modified Burpees',     ic:'💥', s:'3×8-10',    r:'90s',  eq:[], note:'Step back instead of jumping — knees thank you. Add push-up optional. Step forward, stand tall.', warn:'Wrist mod: skip the push-up portion or do it on fists to keep wrist neutral.'},
      {n:'Push-Ups',             ic:'🤸', s:'3×12-15',   r:'60s',  eq:[], note:'Standard or incline. Full range — chest near floor. 1s pause at the bottom.', warn:'Wrist mod: incline push-ups on a raised surface reduce wrist angle significantly.'},
      {n:'Bodyweight Squats',    ic:'🦵', s:'3×15',      r:'60s',  eq:[], note:'Full depth. 1s pause at bottom. Drive from the whole foot.', warn:null},
      {n:'Glute Bridges',        ic:'🌉', s:'3×15 (2s hold)', r:'45s', eq:[], note:'On floor, heels close to glutes. Squeeze hard at top for 2s each rep.', warn:null},
      {n:'Plank Hold',           ic:'🏗️', s:'3×30-45s',  r:'45s',  eq:[], note:'Elbows or straight arms. Hips level. Breathe steadily. Core contracted throughout.', warn:'Wrist mod: forearm plank on elbows avoids wrist load entirely.'},
      {n:'Mountain Climbers',    ic:'⛰️', s:'3×20 reps', r:'60s',  eq:[], note:'Plank position. Drive alternating knees to chest. Control the pace — this is not a sprint.', warn:'Wrist mod: perform on fists to maintain a neutral wrist angle.'},
    ]
  },
};

// ── Exercise GIF lookup ──
export function getExerciseGif(exName) {
  return Promise.resolve(exData.gifs[exName] || null);
}

// ── Travel mode helpers ──
export function getTravelMode(dateStr) {
  try { const d = JSON.parse(localStorage.getItem('travelDays') || '{}'); return !!d[dateStr]; }
  catch(e) { return false; }
}
export function setTravelMode(dateStr, active) {
  try {
    const d = JSON.parse(localStorage.getItem('travelDays') || '{}');
    if(active) d[dateStr] = 1; else delete d[dateStr];
    localStorage.setItem('travelDays', JSON.stringify(d));
  } catch(e) {}
}
export function getTravelDayType(w) {
  if(!w || w.isRest) return null;
  if(w.isLiss) return 'liss';
  const tags = w.tags || [];
  const t    = (w.title || '').toUpperCase();
  const hasPush = tags.includes('push') || t.includes('PUSH');
  const hasPull = tags.includes('pull') || t.includes('PULL');
  const hasLegs = tags.includes('legs') || t.includes('LEG');
  const hitCount = [hasPush, hasPull, hasLegs].filter(Boolean).length;
  if(hitCount >= 2) return 'fullbody';
  if(hasPush) return 'push'; if(hasPull) return 'pull'; if(hasLegs) return 'legs';
  return 'fullbody';
}

// ── IndexedDB cache for exercises.json (stale-while-revalidate) ──
const ExCache = (() => {
  const DB_NAME = 'gymtracker-exercises';
  const DB_VER  = 1;
  const STORE   = 'data';
  let _db = null;

  async function open() {
    if(_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }
  async function get(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = e => res(e.target.result ? e.target.result.data : null);
      req.onerror   = e => rej(e.target.error);
    });
  }
  async function put(key, data) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, data });
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }
  return { get, put };
})();

// ── Apply loaded data to runtime state ──
export function applyExerciseData(data) {
  // Build EQ tag HTML map
  exData.EQ = {};
  for(const k of Object.keys(data.EQ_NAMES)) {
    exData.EQ[k] = '<span class="eq-tag eq-' + k + '">' + data.EQ_NAMES[k] + '</span>';
  }
  // Resolve eq key arrays → HTML in W
  exData.W = data.W;
  for(const phase of Object.values(exData.W)) {
    for(const day of Object.values(phase)) {
      if(!day.ex) continue;
      for(const ex of day.ex) {
        if(ex.eq) ex.eq = ex.eq.map(k => exData.EQ[k]);
      }
    }
  }
  exData.gifs   = data.EXERCISE_GIFS;
  exData.warmup = data.WARMUP_ITEMS;

  // Populate programme state (prog container from programme.js)
  prog.weekTargets   = data.WEEK_TARGETS;
  prog.CFG           = data.CFG;
  prog.start         = parseLocalDate(data.CFG.startDate);
  prog.phaseWeeks    = Object.fromEntries(data.CFG.phaseWeeks.map((w, i) => [i+1, w]));
  prog.minActiveDays = data.CFG.minActiveDays;
}

// ── Fetch exercises.json with IDB stale-while-revalidate ──
export async function loadExerciseData() {
  const KEY    = 'exercises';
  let cached   = null;
  try { cached = await ExCache.get(KEY); } catch(e) { /* IDB unavailable */ }

  if(cached) {
    applyExerciseData(cached);
    // Background refresh — no render blocking
    fetch('exercises.json')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d) ExCache.put(KEY, d).catch(() => {}); })
      .catch(() => {});
    return;
  }

  try {
    const r    = await fetch('exercises.json');
    if(!r.ok) throw new Error('exercises.json ' + r.status);
    const data = await r.json();
    applyExerciseData(data);
    ExCache.put(KEY, data).catch(() => {});
  } catch(e) {
    console.error('[ExLoader] Failed to load exercises.json:', e);
  }
}
