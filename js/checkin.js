// ============================================================
// CHECKIN — daily check-in gate: show once per day before Today
// ============================================================
import { db, TABLES } from './config.js';
import * as localdb from './localdb.js';
import { getTodayDateStr } from './programme.js';

export async function todayCheckinDone() {
  const today = getTodayDateStr();
  if (localStorage.getItem('checkin_skip_' + today)) return true;
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

  // Date header
  const now = new Date();
  const days    = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months  = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  document.getElementById('cg-date').textContent =
    `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]}`;

  const sel  = { energy: null, sleep: null, mood: null, stress: null, soreness: null };
  const submit = document.getElementById('cg-submit');
  const dots   = gate.querySelectorAll('.cg-dot');
  const fields  = ['energy','sleep','mood','stress','soreness'];

  function updateDots() {
    fields.forEach((f, i) => dots[i]?.classList.toggle('filled', sel[f] !== null));
    const allDone = fields.every(f => sel[f] !== null);
    submit.disabled = !allDone;
    submit.classList.toggle('ready', allDone);
  }

  // ── Sleep + Mood: emoji cards ──
  gate.querySelectorAll('.cg-ecards').forEach(group => {
    group.addEventListener('click', e => {
      const card = e.target.closest('.cg-ecard');
      if (!card) return;
      group.querySelectorAll('.cg-ecard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      sel[group.dataset.field] = card.dataset.val;
      updateDots();
    });
  });

  // ── Energy + Stress + Soreness: emoji circles ──
  gate.querySelectorAll('.cg-ecircles').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.cg-ecircle');
      if (!btn) return;
      group.querySelectorAll('.cg-ecircle').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      sel[group.dataset.field] = parseInt(btn.dataset.val);
      updateDots();
    });
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    submit.classList.remove('ready');
    submit.textContent = 'Saving...';
    await _save(sel);
    gate.classList.add('hidden');
    onDone();
  });

  document.getElementById('cg-skip')?.addEventListener('click', () => {
    localStorage.setItem('checkin_skip_' + getTodayDateStr(), '1');
    gate.classList.add('hidden');
    onDone();
  });
}
