// ============================================================
// DATA — exercise/programme data loaded from exercises.json.
// ExCache wraps IDB for stale-while-revalidate.
// exData container is exported so other modules observe mutations.
// ============================================================
import { prog } from './programme.js';
import { parseLocalDate } from './programme.js';

// ── Mutable data container — exported as const so property mutations are visible ──
export const exData = {
  W:              {},    // workout plan by phase/day
  EQ:             {},    // equipment HTML tag strings
  gifs:           {},    // exercise GIF URLs
  warmup:         [],    // universal warmup items
  travelWorkouts: {},    // bodyweight workouts loaded from exercises.json
};
// Also set on window so legacy code in other modules can access without import
Object.defineProperty(window, 'exData', { get(){ return exData; }, configurable: true });
// Backward-compat globals referenced throughout the codebase
Object.defineProperty(window, 'W',            { get(){ return exData.W;     }, set(v){ exData.W = v;     }, configurable: true });
Object.defineProperty(window, 'EQ',           { get(){ return exData.EQ;    }, set(v){ exData.EQ = v;    }, configurable: true });
Object.defineProperty(window, 'EXERCISE_GIFS',{ get(){ return exData.gifs;  }, set(v){ exData.gifs = v;  }, configurable: true });
Object.defineProperty(window, 'WARMUP_ITEMS', { get(){ return exData.warmup;}, set(v){ exData.warmup = v;}, configurable: true });

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
  exData.gifs           = data.EXERCISE_GIFS;
  exData.warmup         = data.WARMUP_ITEMS;
  exData.travelWorkouts = data.TRAVEL_WORKOUTS || {};

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
