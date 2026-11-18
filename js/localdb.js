// ============================================================
// LOCALDB — IndexedDB local-first store for all gym data.
// All reads come from here. Writes go here first, then sync
// to Supabase via SyncDB queue in sync.js.
// ============================================================
import { db, TABLES } from './config.js';

const DB_NAME = 'gymtracker_local';
const DB_VER  = 1;

// ── Stores that need composite key; others use 'date' directly ──
const COMPOSITE = {
  workout_sessions: r => `${r.date}|${r.day_of_week}`,
  exercise_logs:    r => `${r.date}|${r.exercise_name}|${r.set_number}|${r.is_mm_set?1:0}`,
  warmup_logs:      r => `${r.date}|${r.item_key}`,
  checklist_logs:   r => `${r.date}|${r.item_key}`,
  body_measurements:r => `${r.date}|meas`,
};
function lk(table, record) {
  return COMPOSITE[table] ? COMPOSITE[table](record) : record.date;
}

// ── IndexedDB open ──
let _db = null;
function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      const stores = [
        'workout_sessions','exercise_logs','warmup_logs','checklist_logs',
        'hydration_logs','body_metrics','inbody_logs','body_measurements',
        'apple_health_logs',
      ];
      for (const name of stores) {
        if (!d.objectStoreNames.contains(name)) {
          const s = d.createObjectStore(name, { keyPath: '_lk' });
          s.createIndex('date', 'date', { unique: false });
        }
      }
      if (!d.objectStoreNames.contains('_meta'))
        d.createObjectStore('_meta', { keyPath: 'key' });
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Low-level helpers ──
async function tx(stores, mode, fn) {
  const d  = await open();
  const tr = d.transaction(stores, mode);
  return new Promise((res, rej) => {
    tr.onerror = e => rej(e.target.error);
    fn(tr, res, rej);
  });
}

function req2p(idbReq) {
  return new Promise((res, rej) => {
    idbReq.onsuccess = e => res(e.target.result);
    idbReq.onerror   = e => rej(e.target.error);
  });
}

// ── Public API ──

export async function put(table, record) {
  const row = { ...record, _lk: lk(table, record) };
  return tx(table, 'readwrite', (tr, res, rej) => {
    const r = tr.objectStore(table).put(row);
    tr.oncomplete = () => res();
    r.onerror = e => rej(e.target.error);
  });
}

export async function putMany(table, records) {
  if (!records.length) return;
  return tx(table, 'readwrite', (tr, res, rej) => {
    const store = tr.objectStore(table);
    for (const r of records) store.put({ ...r, _lk: lk(table, r) });
    tr.oncomplete = () => res();
    tr.onerror    = e => rej(e.target.error);
  });
}

export async function getByDate(table, date) {
  const d  = await open();
  return new Promise((res, rej) => {
    const tr    = d.transaction(table, 'readonly');
    const range = IDBKeyRange.only(date);
    const req   = tr.objectStore(table).index('date').getAll(range);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

export async function getAll(table) {
  const d = await open();
  return new Promise((res, rej) => {
    const req = d.transaction(table, 'readonly').objectStore(table).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

export async function getByKey(table, key) {
  const d = await open();
  return new Promise((res, rej) => {
    const req = d.transaction(table, 'readonly').objectStore(table).get(key);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Meta (bootstrap flag, last_sync timestamp) ──
export async function getMeta(key) {
  const d = await open();
  return new Promise((res, rej) => {
    const req = d.transaction('_meta', 'readonly').objectStore('_meta').get(key);
    req.onsuccess = e => res(e.target.result?.value ?? null);
    req.onerror   = e => rej(e.target.error);
  });
}

export async function setMeta(key, value) {
  return tx('_meta', 'readwrite', (tr, res, rej) => {
    tr.objectStore('_meta').put({ key, value });
    tr.oncomplete = () => res();
    tr.onerror    = e => rej(e.target.error);
  });
}

// ── App-level read helpers ──

export async function getSession(date, dayOfWeek) {
  return getByKey('workout_sessions', `${date}|${dayOfWeek}`);
}

export async function getSetsForDate(date) {
  return getByDate('exercise_logs', date);
}

export async function getChecklistForDate(date) {
  return getByDate('checklist_logs', date);
}

export async function getWarmupForDate(date) {
  return getByDate('warmup_logs', date);
}

export async function getHydrationForDate(date) {
  const rows = await getByDate('hydration_logs', date);
  return rows[0] || null;
}

export async function getWeekActivity(monStr, sunStr) {
  // Returns Set of dates that have completed exercise_logs between mon–sun
  const d = await open();
  return new Promise((res, rej) => {
    const range = IDBKeyRange.bound(monStr, sunStr);
    const req   = d.transaction('exercise_logs', 'readonly')
                   .objectStore('exercise_logs').index('date').getAll(range);
    req.onsuccess = e => {
      const dates = new Set(
        e.target.result.filter(r => r.completed).map(r => r.date)
      );
      res(dates);
    };
    req.onerror = e => rej(e.target.error);
  });
}

export async function getPreviousBests(exerciseNames, excludeDate) {
  // Returns map: `${name}|${setNum}|0` → {weight, reps, date}
  const all  = await getAll('exercise_logs');
  const best = {};
  // Sort descending by date so first hit per key is most recent
  all.sort((a, b) => b.date.localeCompare(a.date));
  for (const r of all) {
    if (!r.completed || r.is_mm_set || r.date === excludeDate) continue;
    if (!exerciseNames.includes(r.exercise_name)) continue;
    const key = `${r.exercise_name}|${r.set_number}|0`;
    if (!best[key]) best[key] = { weight: r.weight_kg, reps: r.reps, date: r.date };
  }
  return best;
}

// ── Bootstrap: pull all Supabase tables into LocalDB ──
// Called once on first install; sets _meta.bootstrapped.
export async function bootstrapFromSupabase() {
  const done = await getMeta('bootstrapped');
  if (done) return false; // already done

  const pulls = [
    { table: TABLES.SESSIONS,     store: 'workout_sessions'  },
    { table: TABLES.EXERCISES,    store: 'exercise_logs'      },
    { table: TABLES.WARMUP,       store: 'warmup_logs'        },
    { table: TABLES.CHECKLIST,    store: 'checklist_logs'     },
    { table: TABLES.HYDRATION,    store: 'hydration_logs'     },
    { table: TABLES.BODY,         store: 'body_metrics'       },
    { table: TABLES.INBODY,       store: 'inbody_logs'        },
    { table: TABLES.MEASUREMENTS, store: 'body_measurements'  },
    { table: 'apple_health_logs', store: 'apple_health_logs'  },
  ];

  await Promise.all(pulls.map(async ({ table, store }) => {
    try {
      const { data } = await db.from(table).select('*');
      if (data?.length) await putMany(store, data);
    } catch(e) {
      console.warn(`[localdb] bootstrap failed for ${table}:`, e?.message);
    }
  }));

  await setMeta('bootstrapped', true);
  await setMeta('last_sync', new Date().toISOString());
  return true;
}

// ── Pull sync: merge fresh Supabase rows into LocalDB ──
// Called on 'online' event and app open (when already bootstrapped).
// ponytail: simple full re-pull — no updated_at tracking needed for single user.
export async function pullFromSupabase() {
  if (!navigator.onLine) return;
  const pulls = [
    { table: TABLES.SESSIONS,     store: 'workout_sessions'  },
    { table: TABLES.EXERCISES,    store: 'exercise_logs'      },
    { table: TABLES.WARMUP,       store: 'warmup_logs'        },
    { table: TABLES.CHECKLIST,    store: 'checklist_logs'     },
    { table: TABLES.HYDRATION,    store: 'hydration_logs'     },
    { table: TABLES.BODY,         store: 'body_metrics'       },
    { table: TABLES.INBODY,       store: 'inbody_logs'        },
    { table: TABLES.MEASUREMENTS, store: 'body_measurements'  },
    { table: 'apple_health_logs', store: 'apple_health_logs'  },
  ];
  await Promise.all(pulls.map(async ({ table, store }) => {
    try {
      const { data } = await db.from(table).select('*');
      if (data?.length) await putMany(store, data);
    } catch(e) {
      console.warn(`[localdb] pull failed for ${table}:`, e?.message);
    }
  }));
  await setMeta('last_sync', new Date().toISOString());
}
