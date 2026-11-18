// ============================================================
// CHECKIN — daily check-in gate: show once per day before Today
// ============================================================
import { db, TABLES } from './config.js';
import * as localdb from './localdb.js';
import { getTodayDateStr } from './programme.js';

export async function todayCheckinDone() {
  const today = getTodayDateStr();
  try {
    const rows = await localdb.getByDate('daily_checkins', today);
    if (rows.length) return true;
  } catch {}
  try {
    const { data } = await db.from(TABLES.CHECKINS).select('date').eq('date', today).maybeSingle();
    if (data) return true;
  } catch {}
  return false;
}

async function _save({ energy, sleep, mood, stress, soreness }) {
  const today = getTodayDateStr();
  const row = { date: today, energy, sleep, mood, stress, soreness };
  await localdb.put('daily_checkins', row).catch(() => {});
  db.from(TABLES.CHECKINS)
    .upsert({ ...row, created_at: new Date().toISOString() })
    .then(() => {}).catch(() => {});
}

export function initCheckinGate(onDone) {
  const gate = document.getElementById('checkin-gate');
  if (!gate) return;

  // Populate today's date label
  const now = new Date();
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  document.getElementById('cg-date').textContent =
    `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]}`;

  const selections = { energy: null, sleep: null, mood: null, stress: null, soreness: null };
  const submit = document.getElementById('cg-submit');

  gate.querySelectorAll('.cg-pills').forEach(group => {
    group.addEventListener('click', e => {
      const pill = e.target.closest('.cg-pill');
      if (!pill) return;
      const field = group.dataset.field;
      const val = pill.dataset.val;
      group.querySelectorAll('.cg-pill').forEach(p => p.classList.remove('sel'));
      pill.classList.add('sel');
      selections[field] = field === 'energy' || field === 'stress' || field === 'soreness'
        ? parseInt(val, 10) : val;
      submit.disabled = Object.values(selections).some(v => v === null);
    });
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    submit.textContent = 'Saving...';
    await _save(selections);
    gate.classList.add('hidden');
    onDone();
  });
}
