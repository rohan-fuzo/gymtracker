// ============================================================
// SYNC — IndexedDB offline queue, exponential backoff, sync status.
// ============================================================
import { db, SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { store } from './store.js';

// ── IndexedDB offline queue ──
export const SyncDB = (() => {
  const DB_NAME = 'gymtracker_sync';
  const DB_VER  = 1;
  const STORE   = 'queue';
  let _db = null;

  async function open() {
    if(_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if(!d.objectStoreNames.contains(STORE))
          d.createObjectStore(STORE, { keyPath: 'conflictKey' });
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function put(item) {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({...item, queuedAt: Date.now(), retries: 0});
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }

  async function getAll() {
    const d = await open();
    return new Promise((res, rej) => {
      const tx  = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function remove(conflictKey) {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(conflictKey);
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }

  async function update(item) {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }

  return { put, getAll, remove, update };
})();

// ── Exponential backoff (500ms → 1s → 2s → 4s) ──
export async function withRetry(fn, maxAttempts = 4) {
  let delay = 500;
  for(let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch(e) {
      if(attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ── In-flight request deduplication ──
const _inFlight = new Map();
export async function dedupedUpsert(conflictKey, upsertFn) {
  if(_inFlight.has(conflictKey)) return _inFlight.get(conflictKey);
  const promise = upsertFn().finally(() => _inFlight.delete(conflictKey));
  _inFlight.set(conflictKey, promise);
  return promise;
}

// ── Queue a failed save for later retry ──
export async function queueOfflineSave(payload) {
  try {
    await SyncDB.put(payload);
  } catch(e) {
    try {
      const q   = JSON.parse(localStorage.getItem('gymtracker_q') || '[]');
      const idx = q.findIndex(p => p.conflictKey === payload.conflictKey);
      if(idx >= 0) q[idx] = payload; else q.push(payload);
      localStorage.setItem('gymtracker_q', JSON.stringify(q));
    } catch(_) {}
  }
}

let _flushing = false;
export async function flushOfflineQueue() {
  if(_flushing) return;
  _flushing = true;
  try {
    const items  = await SyncDB.getAll().catch(() => []);
    const lsRaw  = JSON.parse(localStorage.getItem('gymtracker_q') || '[]');
    const all    = [...items, ...lsRaw];
    if(!all.length) return;

    let synced = 0;
    for(const item of all) {
      try {
        await withRetry(async () => {
          const { error } = await db.from(item.table)
            .upsert(item.data, { onConflict: item.onConflict });
          if(error) throw error;
        });
        await SyncDB.remove(item.conflictKey).catch(() => {});
        synced++;
      } catch(e) {
        const updated = {...item, retries: (item.retries || 0) + 1};
        await SyncDB.update(updated).catch(() => {});
      }
    }
    if(lsRaw.length && synced >= lsRaw.length)
      localStorage.removeItem('gymtracker_q');

    if(synced > 0) {
      window.showToast?.(`${synced} offline save${synced > 1 ? 's' : ''} synced ✓`);
      await window.loadSetsForDate?.(selectedDateStr, true);
      await window.loadWeekActivity?.();
      window.renderWeekStrip?.();
      window.renderPhaseBanner?.();
    }
    updatePendingBadge();
  } finally {
    _flushing = false;
  }
}

// ── Sync status indicator ──
export function setSyncStatus(status) {
  store.setState({ syncStatus: status });
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if(!dot) return;
  dot.className = 'sync-dot' + (status === 'syncing' ? ' syncing' : status === 'synced' ? ' synced' : ' error');
  if(lbl) lbl.textContent = status === 'syncing' ? 'syncing…' : status === 'synced' ? 'synced' : 'error';
}

// ── Manual sync (triggered by tapping sync dot) ──
export async function manualSync() {
  const items   = await SyncDB.getAll().catch(() => []);
  const lsItems = JSON.parse(localStorage.getItem('gymtracker_q') || '[]');
  const total   = items.length + lsItems.length;
  if(total === 0) { window.showToast?.('All synced ✓'); return; }
  window.showToast?.(`Syncing ${total} item${total > 1 ? 's' : ''}...`);
  await flushOfflineQueue();
}

export async function updatePendingBadge() {
  try {
    const items   = await SyncDB.getAll();
    const lsItems = JSON.parse(localStorage.getItem('gymtracker_q') || '[]');
    const total   = items.length + lsItems.length;
    const lbl     = document.getElementById('sync-label');
    if(!lbl) return;
    if(total > 0 && store.getState().syncStatus !== 'syncing') {
      lbl.textContent = `${total} pending`;
      lbl.style.color = 'var(--p2)';
    } else {
      lbl.style.color = '';
    }
  } catch(e) {}
}

// ── Auto-flush triggers ──
window.addEventListener('online', flushOfflineQueue);

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible') return;
  if(navigator.onLine) flushOfflineQueue();
  window._resumeRestTimerIfActive?.();
});

// Periodic retry — every 30s while online
setInterval(async () => {
  if(!navigator.onLine || _flushing) return;
  const items   = await SyncDB.getAll().catch(() => []);
  const lsItems = JSON.parse(localStorage.getItem('gymtracker_q') || '[]');
  if(items.length + lsItems.length === 0) return;
  await flushOfflineQueue();
}, 30 * 1000);

// Best-effort flush on page unload (keepalive fetch)
window.addEventListener('beforeunload', () => {
  SyncDB.getAll().then(items => {
    items.forEach(item => {
      try {
        fetch(`${SUPABASE_URL}/rest/v1/${item.table}`, {
          method: 'POST', keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(item.data),
        });
      } catch(e) {}
    });
  }).catch(() => {});
});
