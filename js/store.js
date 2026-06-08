// ============================================================
// STORE — single source of truth, controlled mutations.
// Also owns: Schema validators, Perf monitor, chart DOM refs.
// ============================================================

// ── Pre-store date helpers (needed before the store is constructed) ──
function _todayStr() {
  const d = new Date(), pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}
function _todayDow() {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}

// ── Store ──
class Store {
  constructor(initial) {
    this._state = Object.freeze({...initial});
    this._subs  = [];
    this._batch = false;
    this._dirty = new Set();
  }

  getState() { return this._state; }

  setState(patch) {
    const changed = {};
    let hasChange = false;
    for(const k in patch) {
      if(this._state[k] !== patch[k]) {
        changed[k] = patch[k];
        hasChange = true;
        if(this._batch) this._dirty.add(k);
      }
    }
    if(!hasChange) return;
    this._state = Object.freeze({...this._state, ...changed});
    if(!this._batch) this._notify(Object.keys(changed));
  }

  batch(fn) {
    this._batch = true;
    this._dirty = new Set();
    try { fn(); } finally {
      this._batch = false;
      if(this._dirty.size) this._notify([...this._dirty]);
      this._dirty = new Set();
    }
  }

  subscribe(keys, fn) {
    const sub = {keys, fn};
    this._subs.push(sub);
    return () => { this._subs = this._subs.filter(s => s !== sub); };
  }

  _notify(changedKeys) {
    const changed = new Set(changedKeys);
    this._subs.forEach(sub => {
      if(sub.keys.some(k => changed.has(k))) {
        try { sub.fn(this._state); } catch(e) { console.error('Store subscriber error:', e); }
      }
    });
  }
}

// ── Singleton ──
export const store = new Store({
  todayStr:          _todayStr(),
  selectedDateStr:   _todayStr(),
  cDay:              _todayDow(),
  cPhase:            1,
  sessionId:         null,
  loggedSets:        {},
  checkCache:        {},
  hydrationGlasses:  0,
  weekActivityCache: {},
  doneDatesCache:    new Set(),
  pendingSet:        null,
  syncStatus:        'syncing',
  activeScreen:      'today',
  progressLastFetch: 0,
  screenRendered:    {},
  dPhase:            1,
});

export function S() { return store.getState(); }

// ── Store-backed window globals — keeps all existing code working unchanged ──
// Reading/writing these go through the store for reactivity.
['cPhase','cDay','todayStr','selectedDateStr','sessionId',
 'loggedSets','checkCache','hydrationGlasses','pendingSet',
 'dPhase','_progressLastFetch','_screenRendered'].forEach(key => {
  const storeKey = key === '_progressLastFetch' ? 'progressLastFetch'
                 : key === '_screenRendered'     ? 'screenRendered'
                 : key;
  Object.defineProperty(window, key, {
    get(){ return store.getState()[storeKey]; },
    set(v){ store.setState({[storeKey]: v}); },
    configurable: true,
  });
});

['weekActivityCache','doneDatesCache'].forEach(key => {
  Object.defineProperty(window, key, {
    get(){ return store.getState()[key]; },
    set(v){ store.setState({[key]: v}); },
    configurable: true,
  });
});

// ── Chart DOM refs — not in store (non-serialisable) ──
export const charts = { strength: null, weight: null };
// Backward-compat globals (renderWorkout and progress read these directly)
Object.defineProperty(window, 'strengthChart', {
  get(){ return charts.strength; },
  set(v){ charts.strength = v; },
  configurable: true,
});
Object.defineProperty(window, 'weightChart', {
  get(){ return charts.weight; },
  set(v){ charts.weight = v; },
  configurable: true,
});

// ── Schema validators — catch column-name typos and type errors at write time ──
export const Schema = {
  exercise_log: (d) => ({
    session_id:     d.session_id    ?? null,
    date:           String(d.date),
    phase:          Number(d.phase),
    exercise_name:  String(d.exercise_name),
    exercise_index: Number(d.exercise_index),
    set_number:     Number(d.set_number),
    is_mm_set:      Boolean(d.is_mm_set),
    weight_kg:      d.weight_kg != null ? Number(d.weight_kg) : null,
    reps:           d.reps    != null ? Number(d.reps)    : null,
    completed:      Boolean(d.completed),
    rpe:            d.rpe     != null ? Number(d.rpe)     : null,
    updated_at:     new Date().toISOString(),
  }),
  warmup_log: (d) => ({
    date:       String(d.date),
    phase:      Number(d.phase ?? 1),
    item_key:   String(d.item_key),
    item_label: String(d.item_label ?? ''),
    completed:  Boolean(d.completed),
  }),
  checklist_log: (d) => ({
    date:       String(d.date),
    item_type:  String(d.item_type),
    item_key:   String(d.item_key),
    completed:  Boolean(d.completed),
    notes:      d.notes ?? null,
  }),
  hydration_log: (d) => ({
    date:       String(d.date),
    glasses:    Math.max(0, Math.min(8, Number(d.glasses))),
    updated_at: new Date().toISOString(),
  }),
  body_metric: (d) => ({
    date:      String(d.date),
    weight_kg: Number(d.weight_kg),
    phase:     Number(d.phase),
    notes:     d.notes ?? null,
  }),
};

export function validated(schemaFn, data) {
  const row = schemaFn(data);
  if(row.date && !/^\d{4}-\d{2}-\d{2}$/.test(row.date))
    throw new Error(`Invalid date format: ${row.date}`);
  if('weight_kg' in row && row.weight_kg !== null && (row.weight_kg < 0 || row.weight_kg > 500))
    throw new Error(`Unrealistic weight: ${row.weight_kg}`);
  if('reps' in row && row.reps !== null && (row.reps < 0 || row.reps > 200))
    throw new Error(`Unrealistic reps: ${row.reps}`);
  return row;
}

// ── Performance monitor — warns on renders taking > 1 frame ──
export const Perf = {
  _marks: {},
  start(label)  { this._marks[label] = performance.now(); },
  end(label)    {
    const ms = performance.now() - (this._marks[label] || 0);
    if(ms > 16) console.warn(`[Perf] ${label} took ${ms.toFixed(1)}ms — over 1 frame`);
    delete this._marks[label];
    return ms;
  },
  measure(label, fn) { this.start(label); const r = fn(); this.end(label); return r; },
};
