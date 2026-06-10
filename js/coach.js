// ============================================================
// COACH — RPE sheet, GymBuddy AI, between-set coach card, AI progression.
// All AI interactions are in this module.
// ============================================================
import { GYMBUDDY_PROMPT, EQ_SCALES, db } from './config.js';
import { store } from './store.js';
import { DAYS, prog, getProgrammeState } from './programme.js';
import { withRetry } from './sync.js';
import { _playRestChime, getExUnit } from './timer.js';
import { showToast } from './ui.js';
import { SET_COACH_DEFAULT_REST } from './config.js';
import { exData } from './data.js';

// ── Module-level state ──
let _pendingRPE    = null;
let _setCoach      = null;
const _aiSuggestions = {};

// Expose on window for timer.js _resumeRestTimerIfActive
Object.defineProperty(window, '_setCoach', {
  get(){ return _setCoach; }, set(v){ _setCoach = v; }, configurable: true,
});
Object.defineProperty(window, '_dismissSetCoachFade', {
  get(){ return _dismissSetCoachFade; }, configurable: true,
});
Object.defineProperty(window, '_pendingRPE', {
  get(){ return _pendingRPE; }, set(v){ _pendingRPE = v; }, configurable: true,
});

// ── inbodyForBody getter — injected by progress.js ──
function _getLatestInBody() { return window._latestInBody || null; }

// ============================================================
// RPE SHEET
// ============================================================
function openRPESheet(){
  document.getElementById('rpe-modal')?.classList.add('open');
}
function closeRPESheet(){
  document.getElementById('rpe-modal')?.classList.remove('open');
}
function handleRPEClick(e){
  if(e.target === document.getElementById('rpe-modal')) skipRPE();
}
function skipRPE(){
  _pendingRPE = null;
  closeRPESheet();
  _startSetCoachAI(null); // RPE skipped — fire AI with rpe=null
}
async function selectRPE(rpeValue){
  closeRPESheet();
  if(!_pendingRPE) return;
  const {date, exName, setNum, isMM, key, chipEl} = _pendingRPE;
  _pendingRPE = null;

  // Optimistic local update
  if(loggedSets[key]) {
    const updated = {...loggedSets[key], rpe: rpeValue};
    loggedSets = {...loggedSets, [key]: updated};
  }
  // Update badge on chip
  setRPEBadge(chipEl, rpeValue);
  // Fire AI with the confirmed RPE value (also refreshes if user re-rates)
  _startSetCoachAI(rpeValue);

  // Persist — update the row that commitSet already wrote
  try {
    await withRetry(() =>
      db.from('exercise_logs')
        .update({rpe: rpeValue})
        .eq('date', date)
        .eq('exercise_name', exName)
        .eq('set_number', setNum)
        .eq('is_mm_set', isMM)
        .then(r => { if(r.error) throw r.error; })
    );
  } catch(e) {
    console.error('RPE save failed:', e?.message);
    showToast('RPE not saved — will retry', 'error');
  }
}
function setRPEBadge(chipEl, rpe){
  if(!chipEl || rpe == null) return;
  let badge = chipEl.querySelector('.sc-rpe');
  if(!badge){ badge = document.createElement('div'); badge.className='sc-rpe'; chipEl.appendChild(badge); }
  badge.textContent = `RPE ${rpe}`;
}

// ============================================================
// BETWEEN-SET COACH CARD
// ============================================================


function openSetCoachCard(exName, setNum, weight, reps, exIndex, restSecs){
  cancelSetCoachCard(); // one card at a time

  const ek = `ex_${cPhase}_${DAYS[cDay]}_${exIndex}`;
  const rowEl = document.getElementById(ek);
  if(!rowEl) return;

  const endAt = Date.now() + restSecs * 1000;

  // Store all params — AI card fires after RPE is resolved
  _setCoach = {
    ek, endAt, restSecs, timerId: null, dismissed: false,
    exName, setNum, weight, reps, exIndex, aiAbortCtrl: null,
  };

  // Build pure timer card (no AI content)
  const card = document.createElement('div');
  card.id = 'set-coach-card';
  card.className = 'set-coach-card';
  card.innerHTML = _sccHTML(restSecs);
  rowEl.insertAdjacentElement('afterend', card);

  // Animate bar: 100% → 0% over restSecs
  const bar = card.querySelector('.scc-bar');
  if(bar){
    bar.style.transition = 'none';
    bar.style.width = '100%';
    bar.offsetHeight;
    bar.style.transition = `width ${restSecs}s linear`;
    bar.style.width = '0%';
  }

  // Tick every 250ms — timestamp-based so background time is accounted for
  _setCoach.timerId = setInterval(() => {
    if(!_setCoach || _setCoach.dismissed) return;
    const left = Math.max(0, Math.ceil((_setCoach.endAt - Date.now()) / 1000));
    const numEl = document.getElementById('scc-num');
    if(numEl){
      numEl.textContent = left + 's';
      numEl.className = `scc-timer-num${left <= 10 ? ' scc-urgent' : ''}`;
    }
    if(left <= 0){
      clearInterval(_setCoach.timerId);
      _setCoach.timerId = null;
      _playRestChime();
      try { if(navigator.vibrate) navigator.vibrate([300, 100, 300]); } catch(_){}
      _dismissSetCoachFade();
    }
  }, 250);
  // NOTE: AI call fires only after RPE sheet resolves — see _startSetCoachAI()
}

function _sccHTML(timeLeft){
  return `
    <div class="scc-hdr">
      <span class="scc-hdr-label">REST &amp; NEXT SET</span>
      <button class="scc-x" onclick="dismissSetCoachCard()" aria-label="Dismiss">✕</button>
    </div>
    <div id="scc-num" class="scc-timer-num${timeLeft<=10?' scc-urgent':''}">${timeLeft}s</div>
    <div class="scc-bar-wrap"><div class="scc-bar"></div></div>`;
}

// Fire AI coaching card after RPE resolves — called by selectRPE and skipRPE
function _startSetCoachAI(rpeValue){
  if(!_setCoach || _setCoach.dismissed) return;

  // Abort any in-flight request (handles RPE re-submission refresh)
  if(_setCoach.aiAbortCtrl){ _setCoach.aiAbortCtrl.abort(); _setCoach.aiAbortCtrl = null; }

  // Find anchor: AI card sits after the timer card (or after exercise row as fallback)
  const anchor = document.getElementById('set-coach-card') || document.getElementById(_setCoach.ek);
  if(!anchor) return;

  // Get or create standalone AI card
  let aiCard = document.getElementById('set-coach-ai-card');
  if(!aiCard){
    aiCard = document.createElement('div');
    aiCard.id = 'set-coach-ai-card';
    aiCard.className = 'set-coach-card';
    anchor.insertAdjacentElement('afterend', aiCard);
  }

  // Reset to loading state (works for first-time and refresh after RPE change)
  aiCard.innerHTML = `
    <div class="scc-hdr" style="margin-bottom:0">
      <div class="scc-thinking">
        <span class="scc-think-lbl">✦ AI COACH</span>
        <div class="scc-wave">
          <div class="scc-wb"></div><div class="scc-wb"></div><div class="scc-wb"></div>
          <div class="scc-wb"></div><div class="scc-wb"></div>
        </div>
        <span style="font-size:11px;color:var(--dim)">thinking…</span>
      </div>
    </div>`;

  const {exName, setNum, weight, reps, exIndex} = _setCoach;
  _fetchSetCoachAI(exName, setNum, weight, reps, exIndex, rpeValue);
}

function _dismissSetCoachFade(){
  if(!_setCoach) return;
  _setCoach.dismissed = true;
  clearInterval(_setCoach.timerId);
  _setCoach.aiAbortCtrl?.abort();
  [document.getElementById('set-coach-card'), document.getElementById('set-coach-ai-card')]
    .filter(Boolean).forEach(c=>{ c.classList.add('scc-fading'); setTimeout(()=>c.remove(),460); });
  _setCoach = null;
}

function dismissSetCoachCard(){ _dismissSetCoachFade(); }

function cancelSetCoachCard(){
  if(!_setCoach) return;
  clearInterval(_setCoach.timerId);
  _setCoach.aiAbortCtrl?.abort();
  _setCoach = null;
  document.getElementById('set-coach-card')?.remove();
  document.getElementById('set-coach-ai-card')?.remove();
}

function _updateSetCoachSuggestion(text){
  if(!_setCoach || _setCoach.dismissed) return;
  const aiCard = document.getElementById('set-coach-ai-card');
  if(!aiCard) return;

  const [main, trans] = text.split('\n');
  aiCard.innerHTML = `
    <div class="scc-hdr" style="margin-bottom:0">
      <span class="scc-think-lbl">✦ AI COACH</span>
      <span class="scc-tag" style="margin-left:auto">gpt-4o-mini</span>
    </div>
    <div class="scc-text" id="scc-tw-wrap" style="margin-top:8px"></div>
    ${trans ? `<div id="scc-trans" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:13px;color:var(--muted);opacity:0;transition:opacity .5s .8s"></div>` : ''}`;

  const wrap = aiCard.querySelector('#scc-tw-wrap');
  _typewriter(wrap, main||text, 18, ()=>{
    // After typing completes, fade in the transition line
    const transEl = aiCard.querySelector('#scc-trans');
    if(transEl && trans){ transEl.textContent = trans; transEl.style.opacity = '1'; }
  });
}

// ── Custom modal to replace browser prompt() — works in all contexts ──
function _showInputModal(title, placeholder, inputType = 'text'){
  return new Promise(resolve => {
    document.getElementById('_gym-input-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = '_gym-input-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;align-items:flex-end;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--card,#1c1c1e);border-radius:18px 18px 0 0;padding:24px 20px 32px;width:100%;max-width:480px;box-sizing:border-box">
        <div style="font-size:14px;font-weight:700;color:var(--text,#fff);margin-bottom:14px;line-height:1.4">${title}</div>
        <input id="_gym-input-val" type="${inputType}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"
          style="width:100%;box-sizing:border-box;background:var(--input,#2c2c2e);border:1px solid var(--border,#3a3a3c);border-radius:10px;padding:13px 14px;font-size:15px;color:var(--text,#fff);outline:none" />
        <div style="display:flex;gap:10px;margin-top:16px">
          <button id="_gym-input-cancel"
            style="flex:1;padding:13px;border-radius:10px;background:var(--border,#3a3a3c);color:var(--text,#fff);border:none;font-size:15px;cursor:pointer">Skip</button>
          <button id="_gym-input-save"
            style="flex:2;padding:13px;border-radius:10px;background:#e03131;color:#fff;border:none;font-size:15px;font-weight:700;cursor:pointer">Save</button>
        </div>
      </div>`;
    const finish = val => { overlay.remove(); resolve(val || null); };
    overlay.querySelector('#_gym-input-cancel').onclick = () => finish(null);
    overlay.querySelector('#_gym-input-save').onclick   = () => finish(overlay.querySelector('#_gym-input-val').value?.trim());
    overlay.querySelector('#_gym-input-val').addEventListener('keydown', e => { if(e.key==='Enter') finish(overlay.querySelector('#_gym-input-val').value?.trim()); });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.querySelector('#_gym-input-val')?.focus());
  });
}

// ── GymBuddy system prompt — single source of truth for both AI call sites ──

async function _getAIProfile(){
  let apiKey = localStorage.getItem('openai_api_key');
  if(!apiKey){
    apiKey = await _showInputModal('Enter your OpenAI API key to enable AI coaching (stored on this device only):', 'sk-...', 'password');
    if(!apiKey) return null;
    localStorage.setItem('openai_api_key', apiKey);
  }
  let age = parseInt(localStorage.getItem('userAge')||'0')||null;
  if(!age){
    const raw = await _showInputModal('Your age — helps personalise AI coaching (stored locally, enter once):', 'e.g. 28', 'number');
    const n = parseInt(raw||'');
    if(n > 10 && n < 100){ age = n; localStorage.setItem('userAge', String(n)); }
  }
  const heightCm   = parseFloat(localStorage.getItem('userHeightCm')||'0')||null;
  const latestInBody = _getLatestInBody();
  return { apiKey, age, heightCm, latestInBody };
}

// ── Typewriter renderer — "AI Coach: <text types out>" ──
function _typewriter(containerEl, text, speed=18, onComplete){
  containerEl.innerHTML =
    `<span class="ai-coach-prefix">AI Coach:</span><span id="_tw"></span><span class="ai-cursor">▌</span>`;
  const tw  = containerEl.querySelector('#_tw');
  const cur = containerEl.querySelector('.ai-cursor');
  let i = 0;
  const iv = setInterval(()=>{
    tw.textContent += text[i++];
    if(i >= text.length){ clearInterval(iv); cur.remove(); if(onComplete) onComplete(); }
  }, speed);
}

function _setCoachAIError(msg, showReset=false){
  const aiCard = document.getElementById('set-coach-ai-card');
  if(!aiCard) return;
  const resetBtn = showReset ? `<button onclick="localStorage.removeItem('openai_api_key');this.closest('.set-coach-card').remove()" style="margin-top:10px;padding:8px 14px;border-radius:8px;background:#e03131;color:#fff;border:none;font-size:12px;font-weight:700;cursor:pointer;width:100%">🔑 Reset API Key</button>` : '';
  aiCard.innerHTML = `
    <div class="scc-hdr" style="margin-bottom:0">
      <span class="scc-think-lbl">✦ AI COACH</span>
      <span style="margin-left:auto;font-size:11px;color:var(--dim)">${msg}</span>
    </div>${resetBtn}`;
}

async function _fetchSetCoachAI(exName, setNum, weight, reps, exIndex, rpeValue=null){
  const profile = await _getAIProfile();
  if(!profile){ _setCoachAIError('no API key'); return; }
  const { apiKey } = profile;
  const ctx = _buildSetCoachContext(exName, setNum, weight, reps, exIndex, rpeValue, profile);

  const ctrl = new AbortController();
  if(_setCoach) _setCoach.aiAbortCtrl = ctrl;
  const timeout = setTimeout(() => ctrl.abort(), 20000);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}`},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        temperature: 0.7,
        response_format: {type:'json_object'},
        messages: [
          {role:'system', content:GYMBUDDY_PROMPT},
          {role:'user', content: JSON.stringify(ctx)}
        ]
      })
    });
    clearTimeout(timeout);

    if(!resp.ok){
      const err = await resp.json().catch(()=>({}));
      const is401 = resp.status === 401;
      if(is401) localStorage.removeItem('openai_api_key');
      _setCoachAIError(is401 ? 'invalid API key' : `error ${resp.status}`, is401);
      return;
    }
    const data = await resp.json();
    const raw   = data.choices?.[0]?.message?.content?.trim() || '';
    const nudge = _parseGymBuddyResponse(raw, ctx);
    if(nudge) _updateSetCoachSuggestion(nudge);
    else _setCoachAIError('unavailable');
  } catch(e){
    clearTimeout(timeout);
    if(e.name === 'AbortError'){
      _setCoachAIError('timed out');
    } else {
      const likelyBadKey = e?.message?.toLowerCase().includes('fetch');
      if(likelyBadKey) localStorage.removeItem('openai_api_key');
      _setCoachAIError('unavailable', likelyBadKey);
    }
  }
}

// Detects if a nudge contains a weight/load suggestion (kg number, add/bump/increase/deload)

// Snap a weight to the valid increment for the equipment type.
// Model suggestions like 16kg (invalid) become 17.5kg (next valid DB step).
// ── Equipment weight scales — exact valid values ──────────────────────────
// These are the laws. AI suggestions are snapped to these before display.


function getNearestValidWeight(weight, eq=[], currentWeight=null){
  if(weight == null) return null;
  if(!eq.length || (eq.length===1 && eq[0]==='bw')) return weight; // bodyweight

  // Find the primary equipment type in priority order
  const key = ['kb','barbell','smith','cable','mach','db'].find(k => eq.includes(k)) || 'db';
  const scale = EQ_SCALES[key];
  if(!scale) return Math.round(weight * 10) / 10;

  if(scale.type === 'discrete'){
    const vals = scale.values;
    if(currentWeight != null && weight > currentWeight){
      // Model wants an increase — find nearest valid value ABOVE current
      const above = vals.filter(v => v > currentWeight);
      if(!above.length) return vals[vals.length - 1]; // already at max
      return above.reduce((a,b) => Math.abs(b-weight) < Math.abs(a-weight) ? b : a);
    }
    // Nearest value on the scale
    return vals.reduce((a,b) => Math.abs(b-weight) < Math.abs(a-weight) ? b : a);
  }

  // Step-based
  const {step, min} = scale;
  let snapped = Math.round(weight / step) * step;
  snapped = Math.max(min, snapped);

  // Model suggested increase but snapping collapsed to current → force next step up
  if(currentWeight != null && weight > currentWeight && snapped <= currentWeight){
    snapped = Math.ceil(currentWeight / step) * step;
    if(snapped <= currentWeight) snapped += step;
  }

  return Math.round(snapped * 10) / 10;
}

// Parses structured GymBuddy response { next_weight_kg, next_reps, cue, transition }
// Format differs by is_final_set:
//   non-final: "Xkg. N reps. Cue."   (instruction for the next set right now)
//   final:     "Xkg next session."    (forward-looking; no form cue for a done exercise)
function _parseGymBuddyResponse(raw, ctx){
  try {
    const j       = JSON.parse(raw);
    const eq      = ctx?.equipment || [];
    const curW    = ctx?.set_just_logged?.weight_kg ?? null;
    const isFinal = ctx?.is_final_set ?? false;
    const isTimed = ctx?.unit_type === 'seconds';

    const wkg   = getNearestValidWeight(j.next_weight_kg, eq, curW);
    const dur   = j.next_duration_s;
    const cue   = (j.cue||'').trim();
    const trans = (j.transition||'').trim();

    let mainNudge;
    if(isFinal){
      // Final set: just the next-session weight. No reps. No form cue.
      if(isTimed) mainNudge = dur ? `${dur}s next session.` : null;
      else        mainNudge = wkg != null ? `${wkg}kg next session.` : null;
    } else {
      // Non-final: full coaching instruction for the next set
      const parts = [];
      if(isTimed){ if(dur) parts.push(dur + 's'); }
      else        { if(wkg != null) parts.push(wkg + 'kg'); }
      if(j.next_reps) parts.push(j.next_reps + ' reps');
      if(cue)         parts.push(cue);
      mainNudge = parts.length ? parts.join('. ') + '.' : null;
    }

    // Snap transition weight to the next exercise's equipment scale
    let transLine = trans;
    if(trans && ctx?.next_exercise){
      const nEq = ctx.next_exercise.equipment || [];
      transLine = trans.replace(/(\d+(?:\.\d+)?)\s*kg/g, (_, w) => {
        const snapped = getNearestValidWeight(parseFloat(w), nEq, null);
        return snapped + 'kg';
      });
    }

    if(mainNudge && transLine) return mainNudge + '\n' + transLine;
    return mainNudge || transLine || null;
  } catch(_){
    return raw || null;
  }
}

function _equipWeightScale(eq=[]){
  if(eq.includes('kb'))      return 'KB: ONLY these weights exist: 8,10,12,16,20,24,28,32kg. No other values.';
  if(eq.includes('barbell')) return 'Barbell: 20kg bar + 2.5kg total increments (20,22.5,25,27.5,30,35,40,42.5...).';
  if(eq.includes('smith'))   return 'Smith machine: 15kg bar + 2.5kg total increments (15,17.5,20,22.5,25...).';
  if(eq.includes('cable'))   return 'Cable (Precor + add-on pin): 2.5kg steps (5,7.5,10,12.5,15,17.5,20,22.5,25...).';
  if(eq.includes('mach'))    return 'Machine stack (+ add-on pin): 2.5kg steps (5,7.5,10,12.5,15,17.5,20...).';
  if(eq.includes('db'))      return 'DB: 2.5kg steps (2.5,5,7.5,10,12.5,15,17.5,20,22.5,25,27.5,30...).';
  return 'Bodyweight — no external load.';
}

function _buildSetCoachContext(exName, setNum, weight, reps, exIndex, rpeValue=null, profile={}){
  const dk = DAYS[cDay];
  const w  = exData.W[cPhase]?.[dk];
  const ex = w?.ex?.[exIndex];
  const unit = getExUnit(ex);

  // All sets logged today for this exercise (already in memory)
  const todaySets = Object.entries(loggedSets)
    .filter(([k]) => k.startsWith(exName+'|') && k.endsWith('|0'))
    .map(([k,v]) => ({set:parseInt(k.split('|')[1]), weight_kg:v.weight, reps:v.reps, rpe:v.rpe??null}))
    .sort((a,b) => a.set - b.set);

  const setSeries   = parseSets(ex?.s||'');
  const totalSets   = setSeries.length || 1;
  const setsLeft    = Math.max(0, totalSets - setNum);
  const isFinalSet  = setsLeft === 0;
  // Planned rep target for this set (e.g. "8" or "8-12") — AI must know vs actual reps done
  const plannedReps = setSeries[setNum - 1] || setSeries[0] || '';
  const plannedMin  = parseInt(plannedReps) || null; // lower bound (e.g. 8 from "8-12")
  const hitTarget   = plannedMin ? reps >= plannedMin : null;
  const exercisesLeft = (w?.ex||[]).slice(exIndex + 1).length;
  const prevBest    = _prevBestCache[`${exName}|1|0`] || null;

  // On the final set, include the next exercise so AI can bridge to it
  let nextExercise = null;
  if(isFinalSet && w?.ex?.[exIndex + 1]){
    const nex = w.ex[exIndex + 1];
    const nPrev = _prevBestCache[`${nex.n}|1|0`] || null;
    const nSets = parseSets(nex.s||'');
    nextExercise = {
      name:           nex.n,
      plan:           nex.s,              // e.g. "3×10"
      equipment:      nex.eq || [],
      weight_scale:   _equipWeightScale(nex.eq),
      previous_best:  nPrev               // {weight_kg, reps, date} or null
    };
  }


  // ── Session history — last 3 sessions from prefetch cache ─────────────
  const sessionHistory = (_prevHistoryCache[exName] || []).slice(0, 3);

  // ── Progression readiness — pre-computed so AI gets the conclusion ─────
  // Earned when: 2+ consecutive sessions where all planned reps were hit AND avg RPE ≤ 8.
  // If RPE wasn't logged that session, reps-only criterion applies.
  const progressionReadiness = (() => {
    if(!sessionHistory.length) return {earned: false, consecutive: 0};
    let consecutive = 0;
    for(const session of sessionHistory){              // most recent first
      const sets = session.sets || [];
      if(!sets.length) break;
      const allRepsHit  = sets.every(s => plannedMin ? s.reps >= plannedMin : true);
      const rpeValues   = sets.map(s => s.rpe).filter(r => r != null);
      const avgRpe      = rpeValues.length ? rpeValues.reduce((a,b)=>a+b,0)/rpeValues.length : null;
      const rpeOk       = avgRpe == null || avgRpe <= 8;
      if(allRepsHit && rpeOk) consecutive++;
      else break;                                      // streak broken
    }
    return {
      earned:      consecutive >= 2,
      consecutive,
      basis: consecutive >= 2
        ? `${consecutive} consecutive sessions hitting target reps at RPE ≤8`
        : consecutive === 1
          ? '1 qualifying session — one more needed'
          : 'No qualifying sessions yet',
    };
  })();

  // ── Session fatigue — from loggedSets across all exercises today ────────
  const sessionFatigue = (() => {
    const allExercises  = w?.ex || [];
    const total         = allExercises.length;
    const done          = allExercises.filter((ex, ei) =>
      isExerciseDone(ex.n, parseSets(ex.s||''), ei === 0)
    ).length;
    // Collect all non-null RPE values logged today
    const rpeAll = Object.values(loggedSets)
      .map(v => v.rpe).filter(r => r != null);
    const avgRpe = rpeAll.length
      ? Math.round((rpeAll.reduce((a,b)=>a+b,0) / rpeAll.length) * 10) / 10
      : null;
    return {
      exercises_done:  done,
      exercises_total: total,
      avg_rpe_today:   avgRpe,
      high_fatigue:    avgRpe != null && avgRpe >= 8.5,
    };
  })();

  // ── Personal profile ────────────────────────────────────────────────────
  const ib = profile.latestInBody;
  const athlete = {
    age:            profile.age        || null,
    height_cm:      profile.heightCm   || null,
    weight_kg:      ib?.weight_kg      || null,
    body_fat_pct:   ib?.body_fat_pct   || null,
    muscle_mass_kg: ib?.skeletal_muscle_mass || null,
    bmr:            ib?.bmr            || null,
  };

  return {
    athlete,
    exercise:             exName,
    unit_type:            unit,
    equipment:            ex?.eq || [],
    weight_scale:         _equipWeightScale(ex?.eq),
    set_just_logged:      {set:setNum, of_total:totalSets, label:`Set ${setNum} of ${totalSets}`, is_final_set:isFinalSet, weight_kg:weight, reps_done:reps, planned_reps:plannedReps, hit_target:hitTarget, unit, rpe:rpeValue},
    sets_remaining:       setsLeft,
    is_final_set:         isFinalSet,
    session_history:      sessionHistory,
    progression_readiness:progressionReadiness,
    session_fatigue:      sessionFatigue,
    exercises_remaining_today: exercisesLeft,
    sets_today:           todaySets,
    personal_record:      prevBest,
    next_exercise:        nextExercise,
    phase:                `Phase ${cPhase}`,
    week:                 getProgrammeState(new Date()).week,
  };
}

// ============================================================
// AI PROGRESSION SUGGESTION
// ============================================================

async function fetchAIProgression(exName, exIndex, phase, dk){
  const cacheKey = `${exName}||${selectedDateStr}`;
  if(_aiSuggestions[cacheKey]) return;               // already triggered this session

  const profile = await _getAIProfile();
  if(!profile){ removeAICard(ek); delete _aiSuggestions[cacheKey]; return; }
  const apiKey = profile.apiKey;

  const ek = `ex_${phase}_${dk}_${exIndex}`;
  _aiSuggestions[cacheKey] = {ek, text: null, loading: true};
  showAILoadingCard(ek);

  try {
    const context = assembleProgressionContext(exName, phase, profile); // sync — no DB calls
    const suggestion = await callProgressionAI(exName, context, apiKey);
    if(suggestion){
      _aiSuggestions[cacheKey].text = suggestion;
      _aiSuggestions[cacheKey].loading = false;
      showAISuggestionCard(ek, suggestion);
    } else {
      delete _aiSuggestions[cacheKey];
      removeAICard(ek);
    }
  } catch(e){
    console.error('[AI Progression]', e?.message);
    delete _aiSuggestions[cacheKey];
    removeAICard(ek);
  }
}

function assembleProgressionContext(exName, phase, profile={}){
  // Entirely in-memory — no Supabase calls.
  const dk = DAYS[cDay];
  const ex = (() => { for(const d of Object.keys(exData.W[cPhase]||{})) for(const e of (exData.W[cPhase][d]?.ex||[])) if(e.n===exName) return e; return null; })();
  const unit = getExUnit(ex);

  const todaySets = Object.entries(loggedSets)
    .filter(([k]) => k.startsWith(exName+'|') && k.endsWith('|0'))
    .map(([k,v]) => ({set:parseInt(k.split('|')[1]), weight_kg:v.weight, value:v.reps, unit, rpe:v.rpe??null}))
    .sort((a,b) => a.set - b.set);

  const sessions = _prevHistoryCache[exName] || [];

  const lissRaw = checkCache[`liss_${cPhase}_${dk}`];
  const todayLiss = (lissRaw && typeof lissRaw === 'object' && lissRaw.saved)
    ? {incline:lissRaw.incline, speed:lissRaw.speed, mins:lissRaw.mins}
    : null;

  const ib = profile.latestInBody || _getLatestInBody();
  const athlete = {
    age:            profile.age              || parseInt(localStorage.getItem('userAge')||'0')||null,
    height_cm:      profile.heightCm         || parseFloat(localStorage.getItem('userHeightCm')||'0')||null,
    weight_kg:      ib?.weight_kg            || null,
    body_fat_pct:   ib?.body_fat_pct         || null,
    muscle_mass_kg: ib?.skeletal_muscle_mass || null,
    bmr:            ib?.bmr                  || null,
  };

  const ps = getProgrammeState(new Date());
  return {
    athlete,
    exercise:          exName,
    unit_type:         unit,
    equipment:         ex?.eq || [],
    weight_scale:      _equipWeightScale(ex?.eq),
    training_phase:    `Phase ${phase}`,
    programme_week:    ps.week,
    today_sets:        todaySets,
    previous_sessions: sessions,
    liss_today:        todayLiss,
  };
}

async function callProgressionAI(exName, context, apiKey){
  const resp = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      temperature: 0.7,
      response_format: {type:'json_object'},
      messages:[
        {role:'system', content:GYMBUDDY_PROMPT},
        {role:'user', content:`Exercise: ${exName}\n\n${JSON.stringify(context)}`}
      ]
    })
  });
  if(!resp.ok){
    const err = await resp.json().catch(()=>({}));
    if(resp.status===401) localStorage.removeItem('openai_api_key');
    throw new Error(err.error?.message||`OpenAI ${resp.status}`);
  }
  const data = await resp.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() || '';
  return _parseGymBuddyResponse(raw, context);
}

// ── AI card DOM helpers ──
function _aiCardHTML(content){
  return `<div class="ai-card-hdr">
    <span class="ai-sparkle">✦</span>
    <span class="ai-label">AI COACH</span>
    <span class="ai-model-tag">gpt-4o-mini</span>
  </div>
  <div class="ai-body">${content}</div>`;
}
function showAILoadingCard(ek){
  const dots = `<div class="ai-dots"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>`;
  let card = document.getElementById('ai-'+ek);
  if(!card){
    const row = document.getElementById(ek); if(!row) return;
    card = document.createElement('div'); card.id = 'ai-'+ek;
    row.insertAdjacentElement('afterend', card);
  }
  card.className = 'ai-suggestion-card ai-loading';
  card.innerHTML = _aiCardHTML(dots);
}
function showAISuggestionCard(ek, text){
  let card = document.getElementById('ai-'+ek);
  if(!card){
    const row = document.getElementById(ek); if(!row) return;
    card = document.createElement('div'); card.id = 'ai-'+ek;
    row.insertAdjacentElement('afterend', card);
  }
  card.className = 'ai-suggestion-card';
  // Shell with empty body — typewriter fills it in
  card.innerHTML = _aiCardHTML(`<span id="aitw-${ek}"></span>`);
  _typewriter(card.querySelector(`#aitw-${ek}`), text);
}
function removeAICard(ek){
  document.getElementById('ai-'+ek)?.remove();
}
function reinjectAICards(dk){
  Object.values(_aiSuggestions).forEach(({ek, text})=>{
    if(!text) return; // still loading — will insert itself when done
    if(!document.getElementById('ai-'+ek)) showAISuggestionCard(ek, text);
  });
}

// ── Exports ──
export {
  openRPESheet, closeRPESheet, handleRPEClick, skipRPE, selectRPE,
  openSetCoachCard, cancelSetCoachCard, dismissSetCoachCard,
  fetchAIProgression, reinjectAICards,
};
