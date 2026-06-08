// ============================================================
// PROGRESS — all tabbed screens: weight, body measurements, strength,
//            diet plan, mobility, and settings/InBody.
// ============================================================
import { db, TABLES, MEASURE_SITES, MEAS_GROUPS, MEASURE_SITES_MAP } from './config.js';
import { store } from './store.js';
import { prog, DAYS, localDateStr, parseLocalDate, formatDate,
         isMeasurementDue, daysSinceMeasurement } from './programme.js';
import { setSyncStatus, withRetry } from './sync.js';
import { showToast, haptic, isInBodyDue, daysSinceInBody } from './ui.js';

// ── Module-level state ──
let _progressTab    = 'weight';
let _bodyLastFetch  = 0;
let _bodyData       = null;
let _inbodyForBody  = null;
let _measChart      = null;
let _exLogs         = null;

// Expose latest InBody for coach.js _getAIProfile
Object.defineProperty(window, '_latestInBody', {
  get(){ return _inbodyForBody?.length ? _inbodyForBody[_inbodyForBody.length-1] : null; },
  configurable: true,
});

// ── Measurement unit helpers ──
export function getMeasureUnit(){ return localStorage.getItem('measureUnit')||'cm'; }
export function cmToIn(cm){ return (parseFloat(cm)/2.54).toFixed(1); }
export function inToCm(inches){ return (parseFloat(inches)*2.54).toFixed(1); }
export function fmtM(cmVal){
  if(cmVal==null) return '—';
  const u=getMeasureUnit();
  return u==='in' ? cmToIn(cmVal)+'"' : parseFloat(cmVal).toFixed(1)+' cm';
}
export function fmtMDelta(cmDelta){
  if(cmDelta==null) return null;
  const u=getMeasureUnit();
  const v=u==='in' ? (cmDelta/2.54) : cmDelta;
  const sign=v>0?'+':'';
  return sign+Math.abs(v).toFixed(1)+(u==='in'?'"':' cm');
}

function switchProgressTab(tab){
  _progressTab = tab;
  _progressLastFetch = 0; // force weight tab re-render when re-entering
  _bodyLastFetch = 0;     // force body tab re-render when re-entering
  renderProgress();
}

async function renderProgress(){
  const el = document.getElementById('progress-content');
  // Inject tab bar + container once
  if(!document.getElementById('progress-tab-content')){
    el.innerHTML = `
      <div class="progress-tab-bar">
        <button class="progress-tab-btn" id="ptab-weight" onclick="switchProgressTab('weight')">⚖️ WEIGHT</button>
        <button class="progress-tab-btn" id="ptab-body" onclick="switchProgressTab('body')">📏 BODY</button>
      </div>
      <div id="progress-tab-content"></div>`;
  }
  document.getElementById('ptab-weight')?.classList.toggle('active', _progressTab==='weight');
  document.getElementById('ptab-body')?.classList.toggle('active', _progressTab==='body');
  if(_progressTab==='weight') await renderWeightTab();
  else await renderBodyTab();
}

async function renderWeightTab(){
  const now = Date.now();
  const tabEl = document.getElementById('progress-tab-content');
  if(now - _progressLastFetch < 60000 && tabEl?.dataset.tab === 'weight') return;
  _progressLastFetch = now;
  if(tabEl) { tabEl.dataset.tab='weight'; tabEl.innerHTML=`<div class="empty-state"><div class="es-icon">⏳</div><p>Loading your data...</p></div>`; }
  try {
    // All 4 queries in parallel — select only columns we actually use
    const [metricsRes, inbodyRes, exLogsRes, healthRes] = await Promise.all([
      db.from('body_metrics').select('*').order('date',{ascending:true}),
      db.from('inbody_logs').select('*').order('date',{ascending:true}),
      db.from('exercise_logs').select('date,exercise_name,weight_kg,reps,is_mm_set').eq('completed',true).order('date',{ascending:true}),
      db.from('apple_health_logs').select('*').order('date',{ascending:true}),
    ]);
    const metrics = metricsRes.data;
    const inbodyLogs = inbodyRes.data;
    _inbodyForBody = inbodyLogs; // share with body tab — avoids duplicate fetch on tab switch
    const exLogs = exLogsRes.data;
    _exLogs = exLogs;
    const healthLogs = healthRes.data || [];
    // Stats
    const latestWeight = metrics && metrics.length>0 ? metrics[metrics.length-1].weight_kg : null;
    const latestInBody = inbodyLogs && inbodyLogs.length>0 ? inbodyLogs[inbodyLogs.length-1] : null;
    const startWeight = 105;
    const targetWeight = 87;
    const lost = latestWeight ? (startWeight - latestWeight).toFixed(1) : '—';
    const toGo = latestWeight ? (latestWeight - targetWeight).toFixed(1) : '—';
    const totalSessions = new Set(exLogs?.map(r=>r.date)||[]).size;
    // PRs per exercise
    const prs = {};
    if(exLogs) exLogs.forEach(row=>{
      if(!row.weight_kg||row.is_mm_set) return;
      if(!prs[row.exercise_name]||row.weight_kg>prs[row.exercise_name].weight){
        prs[row.exercise_name]={weight:row.weight_kg,reps:row.reps,date:row.date};
      }
    });
    // Unique exercises logged
    const uniqueEx = Object.keys(prs);

    // InBody due banner
    const inbodyDue = isInBodyDue();
    const daysSince = daysSinceInBody();
    const inbodyBanner = inbodyDue
      ? `<div class="notif-banner inbody">
          <div class="notif-banner-icon">📊</div>
          <div class="notif-banner-text">
            <div class="notif-banner-title">INBODY DUE${daysSince?` — ${daysSince} DAYS AGO`:' — FIRST SCAN'}</div>
            <div class="notif-banner-sub">Bi-weekly check-in · InBody 770 · gym front desk</div>
          </div>
          <button class="notif-banner-btn" onclick="openInBodyModal()">LOG</button>
        </div>`
      : `<div class="notif-banner inbody" style="opacity:.6">
          <div class="notif-banner-icon">📊</div>
          <div class="notif-banner-text">
            <div class="notif-banner-title">INBODY UP TO DATE</div>
            <div class="notif-banner-sub">Next scan in ${14-(daysSince||0)} days</div>
          </div>
          <button class="notif-banner-btn" onclick="openInBodyModal()">UPDATE</button>
        </div>`;

    // Programme week + target weight
    const curState = getProgrammeState(new Date());
    const curWeek = curState.beforeStart ? 0 : curState.week;
    const thisWeekTarget = prog.weekTargets[curWeek] || 87;
    const nextWeekTarget = prog.weekTargets[curWeek+1] || 87;
    const onTrack = latestWeight ? latestWeight <= thisWeekTarget + 0.5 : null;
    const isMonday = new Date().getDay() === 1;
    const weightGap = latestWeight ? (latestWeight - thisWeekTarget).toFixed(1) : null;

    // Build weekly schedule rows
    const scheduleRows = Object.entries(prog.weekTargets).map(([w,t])=>{
      const isCur = parseInt(w)===curWeek;
      const hasMet = latestWeight && latestWeight <= t;
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);${isCur?'':'opacity:.5'}">
        <div style="font-size:12px;${isCur?'font-weight:700;color:var(--text)':'color:var(--muted)'}">Week ${w}${isCur?' ← NOW':''}</div>
        <div style="font-size:12px;color:${hasMet?'var(--p3)':'var(--muted)'}">Target: ${t}kg ${hasMet?'✓':''}</div>
      </div>`;
    }).join('');

    let h=`
    ${inbodyBanner}
    <div class="weigh-in-card">
      <div class="weigh-in-title">⚖️ ${isMonday?'TODAY IS WEIGH-IN DAY':'LOG WEIGHT'}</div>
      ${isMonday?`<div style="font-size:12px;color:var(--p3);margin-bottom:10px">Monday morning · weigh fasted before eating</div>`:''}
      <div class="weigh-in-row">
        <input class="weigh-in-input" id="weigh-quick" type="number" placeholder="${latestWeight||'105.0'}" step="0.1" inputmode="decimal">
        <button class="weigh-in-btn" onclick="openWeighModal()">LOG</button>
      </div>
      ${latestWeight?`<div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <div style="flex:1">
          <div style="font-size:11px;color:var(--muted)">Last recorded</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--text)">${latestWeight}kg</div>
        </div>
        <div style="flex:1;text-align:right">
          <div style="font-size:11px;color:var(--muted)">Week ${curWeek} target</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:${onTrack?'var(--p3)':'var(--p1)'}">${thisWeekTarget}kg</div>
        </div>
      </div>
      <div style="margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:600;background:${onTrack?'rgba(34,197,94,.1)':'rgba(255,69,32,.1)'};color:${onTrack?'var(--p3)':'var(--p1)'}">
        ${onTrack?'✓ ON TRACK':'⚠️ '+weightGap+'kg above target — review diet this week'}
      </div>`:''}
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val" style="color:var(--p3)">${latestWeight||startWeight}kg</div><div class="stat-key">Current Weight</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--p1)">${lost}kg</div><div class="stat-key">Total Lost</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--p2)">${toGo}kg</div><div class="stat-key">To Goal (87kg)</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--cyan)">${totalSessions}</div><div class="stat-key">Sessions</div></div>
    </div>
    ${latestInBody ? `<div class="stat-grid" style="margin-bottom:12px">
      <div class="stat-card"><div class="stat-val" style="color:var(--p5);font-size:20px">${latestInBody.body_fat_pct||'—'}%</div><div class="stat-key">Body Fat</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--p3);font-size:20px">${latestInBody.skeletal_muscle_mass||'—'}kg</div><div class="stat-key">Muscle Mass</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--p2);font-size:20px">${latestInBody.visceral_fat_level||'—'}</div><div class="stat-key">Visceral Fat</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--yellow);font-size:20px">${latestInBody.inbody_score||'—'}</div><div class="stat-key">InBody Score</div></div>
    </div>` : ''}
    ${healthLogs.length > 0 ? (()=>{
      const latest = healthLogs[healthLogs.length-1];
      const last7 = healthLogs.slice(-7);
      const avgCal = last7.filter(h=>h.active_calories).length ? Math.round(last7.reduce((s,h)=>s+(h.active_calories||0),0)/last7.filter(h=>h.active_calories).length) : null;
      const avgSteps = last7.filter(h=>h.steps).length ? Math.round(last7.reduce((s,h)=>s+(h.steps||0),0)/last7.filter(h=>h.steps).length) : null;
      const avgSleep = last7.filter(h=>h.sleep_hours).length ? (last7.reduce((s,h)=>s+(h.sleep_hours||0),0)/last7.filter(h=>h.sleep_hours).length).toFixed(1) : null;
      const avgHR = last7.filter(h=>h.resting_hr).length ? Math.round(last7.reduce((s,h)=>s+(h.resting_hr||0),0)/last7.filter(h=>h.resting_hr).length) : null;
      return `<div class="chart-card" style="margin-bottom:12px">
        <div class="chart-title">DAILY VITALS <span style="font-size:11px;color:var(--muted);font-family:'DM Sans',sans-serif;font-weight:400">via Apple Health</span></div>
        <div style="font-size:11px;color:var(--dim);margin-bottom:10px">Last synced: ${latest.date}</div>
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-val" style="color:#ff4520;font-size:18px">${latest.active_calories||'—'}</div><div class="stat-key">Active Cal</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--p3);font-size:18px">${latest.steps ? latest.steps.toLocaleString() : '—'}</div><div class="stat-key">Steps</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--cyan);font-size:18px">${latest.sleep_hours||'—'}h</div><div class="stat-key">Sleep</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--p5);font-size:18px">${latest.resting_hr||'—'}</div><div class="stat-key">Rest HR</div></div>
        </div>
        <div style="margin-top:10px;padding:8px;border-radius:8px;background:var(--surface)">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:600">7-DAY AVERAGES</div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text)">
            <span>🔥 ${avgCal||'—'} cal</span>
            <span>🚶 ${avgSteps ? avgSteps.toLocaleString() : '—'}</span>
            <span>😴 ${avgSleep||'—'}h</span>
            <span>❤️ ${avgHR||'—'} bpm</span>
          </div>
        </div>
        ${last7.length >= 2 ? `<div class="chart-wrap" style="margin-top:12px"><canvas id="vitals-chart"></canvas></div>` : ''}
      </div>`;
    })() : `<div class="chart-card" style="margin-bottom:12px">
      <div class="chart-title">DAILY VITALS</div>
      <div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">
        Set up the Apple Health Shortcut to sync your daily vitals here
      </div>
    </div>`}
    <div class="chart-card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="chart-title" style="margin-bottom:0">WEEKLY TARGETS</div>
        <div style="font-size:11px;color:var(--muted)">Wk ${curWeek} of 19</div>
      </div>
      <div style="max-height:200px;overflow-y:auto">${scheduleRows}</div>
    </div>`;

    // Weight chart
    if(metrics && metrics.length > 1){
      h+=`<div class="chart-card">
        <div class="chart-title">WEIGHT TREND</div>
        <div class="chart-wrap"><canvas id="weight-chart"></canvas></div>
      </div>`;
    } else {
      h+=`<div class="chart-card"><div class="chart-title">WEIGHT TREND</div>
        <div style="text-align:center;padding:30px;color:var(--muted);font-size:13px">Log your weight on Mondays to see the trend here</div>
      </div>`;
    }

    // InBody recomposition chart (muscle vs fat over time)
    if(inbodyLogs && inbodyLogs.length > 1){
      h+=`<div class="chart-card">
        <div class="chart-title">RECOMPOSITION</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Muscle mass vs Fat mass — bi-weekly InBody</div>
        <div class="chart-wrap"><canvas id="recomp-chart"></canvas></div>
      </div>`;
    } else if(inbodyLogs && inbodyLogs.length === 1){
      h+=`<div class="chart-card"><div class="chart-title">RECOMPOSITION</div>
        <div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">Log your next InBody in 14 days to see the recomposition trend</div>
      </div>`;
    }

    // Strength chart
    if(uniqueEx.length > 0){
      h+=`<div class="chart-card">
        <div class="chart-title">STRENGTH PROGRESS</div>
        <select class="ex-select" id="ex-select" onchange="updateStrengthChart(this.value)">
          ${uniqueEx.map(n=>`<option value="${n}">${n}</option>`).join('')}
        </select>
        <div class="chart-wrap"><canvas id="strength-chart"></canvas></div>
      </div>`;
    }

    // PRs
    if(uniqueEx.length > 0){
      h+=`<div class="chart-card">
        <div class="chart-title">PERSONAL RECORDS</div>
        <div class="pr-list">
          ${uniqueEx.slice(0,8).map(n=>`
            <div class="pr-item">
              <div><div class="pr-name">${n}</div><div class="pr-date">${prs[n].date}</div></div>
              <div class="pr-val">${prs[n].weight}kg × ${prs[n].reps}</div>
            </div>`).join('')}
        </div>
      </div>`;
    }

    h+=`<div class="spacer"></div>`;
    if(tabEl) tabEl.innerHTML = h;

    // Render weight chart
    if(metrics && metrics.length > 1){
      const wCtx = document.getElementById('weight-chart')?.getContext('2d');
      if(wCtx){
        if(weightChart) weightChart.destroy();
        weightChart = new Chart(wCtx,{
          type:'line',
          data:{
            labels: metrics.map(m=>m.date.slice(5)),
            datasets:[
              {label:'Weight',data:metrics.map(m=>m.weight_kg),borderColor:'#ff4520',backgroundColor:'rgba(255,69,32,.1)',tension:.3,pointRadius:4,pointBackgroundColor:'#ff4520'},
              {label:'Weekly target',data:metrics.map(m=>{
                const s = getProgrammeState(new Date(m.date));
                return prog.weekTargets[s.week]||87;
              }),borderColor:'rgba(34,197,94,.5)',borderDash:[4,4],pointRadius:0,tension:0}
            ]
          },
          options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#666',font:{size:11}}}},scales:{x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},y:{ticks:{color:'#555',font:{size:10}},grid:{color:'#222'},min:85,max:110}}}
        });
      }
    }

    // Render vitals chart (steps + calories over last 7 days)
    if(healthLogs.length >= 2){
      const vCtx = document.getElementById('vitals-chart')?.getContext('2d');
      if(vCtx){
        const last7 = healthLogs.slice(-7);
        if(window.vitalsChart) window.vitalsChart.destroy();
        window.vitalsChart = new Chart(vCtx,{
          type:'bar',
          data:{
            labels: last7.map(h=>h.date.slice(5)),
            datasets:[
              {label:'Active Cal',data:last7.map(h=>h.active_calories||0),backgroundColor:'rgba(255,69,32,.6)',borderRadius:4,yAxisID:'y'},
              {label:'Steps',data:last7.map(h=>h.steps||0),type:'line',borderColor:'#22c55e',pointRadius:3,pointBackgroundColor:'#22c55e',tension:.3,yAxisID:'y2'},
            ]
          },
          options:{
            responsive:true,maintainAspectRatio:false,
            plugins:{legend:{labels:{color:'#666',font:{size:10}}}},
            scales:{
              x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},
              y:{ticks:{color:'#ff4520',font:{size:9}},grid:{color:'#222'},position:'left',title:{display:true,text:'Calories',color:'#555',font:{size:9}}},
              y2:{ticks:{color:'#22c55e',font:{size:9}},grid:{display:false},position:'right',title:{display:true,text:'Steps',color:'#555',font:{size:9}}}
            }
          }
        });
      }
    }

    // Render strength chart for first exercise
    if(uniqueEx.length > 0 && exLogs){
      renderStrengthChartData(uniqueEx[0], exLogs);
      _exLogs = exLogs;
    }

    // Render recomposition chart
    if(inbodyLogs && inbodyLogs.length > 1){
      const rCtx = document.getElementById('recomp-chart')?.getContext('2d');
      if(rCtx){
        if(window.recompChart) window.recompChart.destroy();
        window.recompChart = new Chart(rCtx,{
          type:'line',
          data:{
            labels: inbodyLogs.map(r=>r.date.slice(5)),
            datasets:[
              {label:'Muscle (kg)',data:inbodyLogs.map(r=>r.skeletal_muscle_mass),borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,.1)',tension:.3,pointRadius:4,pointBackgroundColor:'#22c55e',yAxisID:'y'},
              {label:'Fat (kg)',data:inbodyLogs.map(r=>r.body_fat_mass),borderColor:'#ff4520',backgroundColor:'rgba(255,69,32,.08)',tension:.3,pointRadius:4,pointBackgroundColor:'#ff4520',yAxisID:'y'},
              {label:'Visceral Fat',data:inbodyLogs.map(r=>r.visceral_fat_level),borderColor:'#f59e0b',borderDash:[4,4],tension:.3,pointRadius:3,yAxisID:'y2'},
            ]
          },
          options:{
            responsive:true,maintainAspectRatio:false,
            plugins:{legend:{labels:{color:'#666',font:{size:11}}}},
            scales:{
              x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},
              y:{ticks:{color:'#555',font:{size:10}},grid:{color:'#222'},position:'left'},
              y2:{ticks:{color:'#f59e0b',font:{size:9}},grid:{display:false},position:'right'}
            }
          }
        });
      }
    }

  } catch(e){
    console.error(e);
    if(tabEl) tabEl.innerHTML=`<div class="empty-state"><div class="es-icon">⚠️</div><p>Could not load data. Check connection.</p></div>`;
  }
}

// ============================================================
// BODY MEASUREMENTS TAB
// ============================================================


async function renderBodyTab(){
  const now = Date.now();
  const tabEl = document.getElementById('progress-tab-content');
  if(now - _bodyLastFetch < 60000 && tabEl?.dataset.tab === 'body') return;
  _bodyLastFetch = now;
  if(tabEl){ tabEl.dataset.tab='body'; tabEl.innerHTML=`<div class="empty-state"><div class="es-icon">⏳</div><p>Loading measurements...</p></div>`; }
  try {
    // Fetch measurements; reuse cached inbody data from weight tab if available
    const measRes = await db.from(TABLES.MEASUREMENTS).select('*').order('date',{ascending:true});
    if(_inbodyForBody === null) {
      const ibRes = await db.from(TABLES.INBODY).select('*').order('date',{ascending:true});
      _inbodyForBody = ibRes.data || [];
    }
    _bodyData = measRes.data || [];
    const latest  = _bodyData.length > 0 ? _bodyData[_bodyData.length-1] : null;
    const prev    = _bodyData.length > 1 ? _bodyData[_bodyData.length-2] : null;
    const first   = _bodyData.length > 0 ? _bodyData[0] : null;
    const latestIB = _inbodyForBody.length > 0 ? _inbodyForBody[_inbodyForBody.length-1] : null;
    const u = getMeasureUnit();
    let h = '';

    // Measurement due banner
    const measDue = isMeasurementDue();
    const dSince  = daysSinceMeasurement();
    if(measDue){
      h += `<div class="notif-banner" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.06);margin-bottom:0">
        <div class="notif-banner-icon">📏</div>
        <div class="notif-banner-text">
          <div class="notif-banner-title">MEASUREMENTS DUE${dSince?` — ${dSince} DAYS AGO`:' — FIRST LOG'}</div>
          <div class="notif-banner-sub">Bi-weekly tape measure · same time of day</div>
        </div>
        <button class="notif-banner-btn" style="background:var(--p3);color:#000" onclick="openMeasModal()">LOG</button>
      </div>`;
    }

    // Log CTA + unit toggle bar
    h += `<div class="meas-log-cta">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:12px;font-weight:700;letter-spacing:.5px;color:var(--text)">${latest?`LAST: ${latest.date}`:'NO MEASUREMENTS YET'}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${_bodyData.length} entr${_bodyData.length===1?'y':'ies'} logged</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="unit-toggle">
            <button class="unit-btn${u==='cm'?' active':''}" onclick="setMeasUnit('cm')">CM</button>
            <button class="unit-btn${u==='in'?' active':''}" onclick="setMeasUnit('in')">IN</button>
          </div>
          <button class="meas-log-btn" onclick="openMeasModal()">+ LOG</button>
        </div>
      </div>
    </div>`;

    // Derived metrics (waist:hip, waist:height)
    if(latest){
      const heightCm = parseFloat(localStorage.getItem('userHeightCm')||'0');
      const waist = parseFloat(latest.waist||0);
      const hips  = parseFloat(latest.hips||0);
      const whr   = (waist && hips)     ? (waist/hips).toFixed(2)   : null;
      const whtr  = (waist && heightCm) ? (waist/heightCm).toFixed(2): null;
      if(whr || whtr || !heightCm){
        const whrRisk  = whr  ? (whr>0.9?'HIGH':whr>0.8?'MODERATE':'LOW') : null;
        const whtrRisk = whtr ? (whtr>0.5?'HIGH':whtr>0.43?'MODERATE':'LOW') : null;
        const riskCol  = r => r==='LOW'?'var(--p3)':r==='MODERATE'?'var(--yellow)':'var(--p1)';
        h += `<div class="chart-card" style="margin-bottom:12px">
          <div class="chart-title">DERIVED METRICS</div>
          <div class="derived-grid">
            ${whr?`<div class="derived-card">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Waist : Hip</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:${riskCol(whrRisk)}">${whr}</div>
              <div style="font-size:10px;color:${riskCol(whrRisk)};font-weight:700">${whrRisk} RISK</div>
            </div>`:''}
            ${whtr?`<div class="derived-card">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Waist : Height</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:${riskCol(whtrRisk)}">${whtr}</div>
              <div style="font-size:10px;color:${riskCol(whtrRisk)};font-weight:700">${whtrRisk} RISK</div>
            </div>`:''}
            ${!heightCm?`<div class="derived-card" onclick="openHeightModal()" style="cursor:pointer;border:1.5px dashed var(--border)">
              <div style="font-size:11px;color:var(--muted)">Waist:Height</div>
              <div style="font-size:12px;color:var(--cyan);margin-top:6px">+ Add height</div>
            </div>`:''}
          </div>
        </div>`;
      }
    }

    // InBody composition mini-card
    if(latestIB){
      h += `<div class="chart-card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="chart-title" style="margin-bottom:0">INBODY COMPOSITION</div>
          <div style="font-size:11px;color:var(--muted)">${latestIB.date}</div>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-val" style="color:var(--p5);font-size:18px">${latestIB.body_fat_pct||'—'}%</div><div class="stat-key">Body Fat</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--p3);font-size:18px">${latestIB.skeletal_muscle_mass||'—'}kg</div><div class="stat-key">Muscle</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--p2);font-size:18px">${latestIB.bmr||'—'}</div><div class="stat-key">BMR</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--yellow);font-size:18px">${latestIB.inbody_score||'—'}</div><div class="stat-key">Score</div></div>
        </div>
      </div>`;
    }

    // Per-group site rows with deltas
    if(latest){
      MEAS_GROUPS.forEach(group=>{
        const rows = group.sites.map(siteKey=>{
          const site = MEASURE_SITES_MAP.get(siteKey);
          const val  = latest[siteKey];
          if(val==null) return '';
          const d = deltaForSite(siteKey, latest, prev, first);
          return `<div class="meas-site-row">
            <div style="font-size:13px;color:var(--text);min-width:80px">${site.label}</div>
            <div class="meas-site-val">${fmtM(val)}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
              ${renderDeltaBadge(d.fromLast,site,'Last')}
              ${renderDeltaBadge(d.fromFirst,site,'Start')}
            </div>
          </div>`;
        }).join('');
        if(rows.trim()){
          h += `<div class="chart-card" style="margin-bottom:12px">
            <div class="meas-group-title">${group.label}</div>${rows}</div>`;
        }
      });
    } else {
      h += `<div class="chart-card" style="margin-bottom:12px">
        <div style="text-align:center;padding:28px 16px;color:var(--muted)">
          <div style="font-size:32px;margin-bottom:8px">📏</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--text)">No measurements yet</div>
          <div style="font-size:12px">Tap <strong style="color:var(--p3)">+ LOG</strong> above to start tracking your body measurements</div>
        </div>
      </div>`;
    }

    // Site trend chart
    if(_bodyData.length > 1){
      const sitesWithData = MEASURE_SITES.filter(s=>_bodyData.some(d=>d[s.key]!=null));
      if(sitesWithData.length){
        const opts = sitesWithData.map(s=>`<option value="${s.key}">${s.label}</option>`).join('');
        h += `<div class="chart-card" style="margin-bottom:12px">
          <div class="chart-title">MEASUREMENT TREND</div>
          <select class="ex-select" id="meas-site-select" onchange="updateMeasChart(this.value)" style="margin-bottom:10px">${opts}</select>
          <div class="chart-wrap"><canvas id="meas-trend-chart"></canvas></div>
        </div>`;
      }
    }

    // Side-by-side comparison
    if(_bodyData.length > 1){
      const dOpts = _bodyData.map(d=>`<option value="${d.date}">${d.date}</option>`).join('');
      h += `<div class="chart-card" style="margin-bottom:12px">
        <div class="chart-title">COMPARE DATES</div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div style="flex:1">
            <label style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">DATE A</label>
            <select id="comp-date-a" class="ex-select" onchange="updateComparison()" style="width:100%">${dOpts}</select>
          </div>
          <div style="flex:1">
            <label style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">DATE B</label>
            <select id="comp-date-b" class="ex-select" onchange="updateComparison()" style="width:100%">${dOpts}</select>
          </div>
        </div>
        <div id="comparison-table"></div>
      </div>`;
    }

    // Monthly summary
    if(_bodyData.length > 0){
      const ms = buildMonthlySummary(_bodyData);
      if(ms.length){
        h += `<div class="chart-card" style="margin-bottom:12px">
          <div class="chart-title">MONTHLY SUMMARY</div>
          ${ms.map(m=>`<div class="month-summary-row">
            <div class="month-summary-label">${m.label}</div>
            <div style="font-size:12px;color:var(--muted);line-height:1.6">${m.text}</div>
          </div>`).join('')}
        </div>`;
      }
    }

    // History list (most recent 10)
    if(_bodyData.length > 0){
      const recent = [..._bodyData].reverse().slice(0,10);
      h += `<div class="chart-card" style="margin-bottom:12px">
        <div class="chart-title">HISTORY</div>
        ${recent.map(entry=>{
          const logged = MEASURE_SITES.filter(s=>entry[s.key]!=null);
          return `<div class="meas-history-row" onclick="openMeasModal('${entry.date}')">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${entry.date}</div>
              <div style="font-size:11px;color:var(--cyan)">${logged.length} sites</div>
            </div>
            <div class="meas-history-pills">
              ${logged.slice(0,6).map(s=>`<span class="meas-history-pill">${s.label}: ${fmtM(entry[s.key])}</span>`).join('')}
              ${logged.length>6?`<span class="meas-history-pill" style="color:var(--muted)">+${logged.length-6} more</span>`:''}
            </div>
            ${entry.notes?`<div style="font-size:11px;color:var(--muted);margin-top:4px;font-style:italic">${entry.notes}</div>`:''}
          </div>`;
        }).join('')}
      </div>`;
    }

    h += `<div class="spacer"></div>`;
    if(tabEl){ tabEl.dataset.tab='body'; tabEl.innerHTML=h; }

    // Trend chart: first available site
    if(_bodyData.length > 1){
      const firstSite = MEASURE_SITES.find(s=>_bodyData.some(d=>d[s.key]!=null));
      if(firstSite) updateMeasChart(firstSite.key);
    }

    // Comparison: default to last two entries
    if(_bodyData.length > 1){
      const selA = document.getElementById('comp-date-a');
      const selB = document.getElementById('comp-date-b');
      if(selA && selB){
        selA.value = _bodyData[_bodyData.length-2].date;
        selB.value = _bodyData[_bodyData.length-1].date;
        updateComparison();
      }
    }

  } catch(e){
    console.error(e);
    if(tabEl) tabEl.innerHTML=`<div class="empty-state"><div class="es-icon">⚠️</div><p>Could not load measurements.</p></div>`;
  }
}

// ── Delta helpers ──

function deltaForSite(siteKey, latest, prev, first){
  const val      = parseFloat(latest?.[siteKey]);
  const prevVal  = parseFloat(prev?.[siteKey]);
  const firstVal = parseFloat(first?.[siteKey]);
  if(!val || isNaN(val)) return {fromLast:null,fromFirst:null};
  return {
    fromLast:  (!isNaN(prevVal)  && prev  !== latest) ? val - prevVal  : null,
    fromFirst: (!isNaN(firstVal) && first !== latest) ? val - firstVal : null,
  };
}

function renderDeltaBadge(delta, site, label){
  if(delta==null || Math.abs(delta)<0.05) return '';
  const u = getMeasureUnit();
  const dv = u==='in' ? delta/2.54 : delta;
  const sign = dv>0?'+':'';
  const str = sign+Math.abs(dv).toFixed(1)+(u==='in'?'"':'cm');
  let cls = 'meas-delta-neutral';
  if(site.goal==='increase') cls = delta>0?'meas-delta-good':'meas-delta-bad';
  if(site.goal==='decrease') cls = delta<0?'meas-delta-good':'meas-delta-bad';
  return `<span class="meas-delta ${cls}" title="vs ${label}">${str}</span>`;
}

function updateMeasChart(siteKey){
  const site = MEASURE_SITES_MAP.get(siteKey);
  if(!site || !_bodyData) return;
  const rows = _bodyData.filter(d=>d[siteKey]!=null);
  if(rows.length<2) return;
  const ctx = document.getElementById('meas-trend-chart')?.getContext('2d');
  if(!ctx) return;
  if(_measChart) _measChart.destroy();
  const u = getMeasureUnit();
  const data = rows.map(d=>u==='in'?parseFloat(cmToIn(d[siteKey])):parseFloat(d[siteKey]));
  const color = site.goal==='decrease'?'#ff4520':site.goal==='increase'?'#22c55e':'#06b6d4';
  _measChart = new Chart(ctx,{
    type:'line',
    data:{
      labels: rows.map(d=>d.date.slice(5)),
      datasets:[{
        label:`${site.label} (${u})`,
        data,
        borderColor:color,
        backgroundColor:color+'22',
        tension:.3,
        pointRadius:4,
        pointBackgroundColor:color,
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#666',font:{size:11}}}},
      scales:{
        x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},
        y:{ticks:{color:'#555',font:{size:10}},grid:{color:'#222'}}
      }
    }
  });
}

function updateComparison(){
  const aDate = document.getElementById('comp-date-a')?.value;
  const bDate = document.getElementById('comp-date-b')?.value;
  const tableEl = document.getElementById('comparison-table');
  if(!tableEl||!aDate||!bDate||!_bodyData) return;
  const aEntry = _bodyData.find(d=>d.date===aDate);
  const bEntry = _bodyData.find(d=>d.date===bDate);
  if(!aEntry||!bEntry) return;
  const u = getMeasureUnit();
  let rows = `<div class="compare-row hdr">
    <div>Site</div><div>${aDate.slice(5)}</div><div>${bDate.slice(5)}</div><div>Δ</div>
  </div>`;
  MEASURE_SITES.forEach(site=>{
    const av = aEntry[site.key], bv = bEntry[site.key];
    if(av==null && bv==null) return;
    let deltaHTML = '—';
    if(av!=null && bv!=null){
      const delta = parseFloat(bv)-parseFloat(av);
      const dv = u==='in'?delta/2.54:delta;
      const sign = dv>0?'+':'';
      const cls = site.goal==='decrease'?(delta<0?'meas-delta-good':'meas-delta-bad')
                : site.goal==='increase'?(delta>0?'meas-delta-good':'meas-delta-bad')
                : 'meas-delta-neutral';
      deltaHTML=`<span class="meas-delta ${cls}">${sign}${Math.abs(dv).toFixed(1)}${u==='in'?'"':'cm'}</span>`;
    }
    rows+=`<div class="compare-row">
      <div style="font-size:12px;color:var(--text)">${site.label}</div>
      <div style="font-size:12px;color:var(--muted)">${fmtM(av)}</div>
      <div style="font-size:12px;color:var(--muted)">${fmtM(bv)}</div>
      <div>${deltaHTML}</div>
    </div>`;
  });
  tableEl.innerHTML = rows;
}

function buildMonthlySummary(data){
  if(data.length<2) return [];
  const u = getMeasureUnit(); // hoist — unit doesn't change during iteration
  // Build month→{entries, dataIndex} in one pass — avoids O(n²) data.indexOf later
  const byMonth={};
  data.forEach((entry, idx)=>{
    const m=entry.date.slice(0,7);
    if(!byMonth[m]) byMonth[m]={entries:[], firstIdx: idx};
    byMonth[m].entries.push(entry);
  });
  return Object.entries(byMonth).map(([month,{entries, firstIdx}])=>{
    const last  = entries[entries.length-1];
    const prevE = firstIdx>0 ? data[firstIdx-1] : null;
    const changes=[];
    if(prevE){
      MEASURE_SITES.forEach(site=>{
        const f=parseFloat(prevE[site.key]);
        const l=parseFloat(last[site.key]);
        if(!f||!l||isNaN(f)||isNaN(l)) return;
        const delta=l-f;
        if(Math.abs(delta)<0.1) return;
        const dv=u==='in'?delta/2.54:delta;
        const sign=dv>0?'+':'';
        changes.push(`${site.label} ${sign}${Math.abs(dv).toFixed(1)}${u==='in'?'"':'cm'}`);
      });
    }
    const [y,m2]=month.split('-');
    const label=new Date(parseInt(y),parseInt(m2)-1,1).toLocaleString('default',{month:'long',year:'numeric'});
    return {
      label,
      text:changes.length>0?changes.join(' · '):entries.length===1?'1 entry — log next measurement for deltas':'No notable changes',
    };
  }).reverse();
}

// ── Measurement unit toggle ──
function setMeasUnit(u){
  localStorage.setItem('measureUnit',u);
  document.querySelectorAll('.unit-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.textContent.toLowerCase()===u.toLowerCase());
  });
  _bodyLastFetch=0;
  if(_progressTab==='body') renderBodyTab();
}

// ── Measurement modal ──
function openMeasModal(dateStr){
  const modal=document.getElementById('meas-modal');
  if(!modal) return;
  const d=dateStr||localDateStr();
  const dateInput=document.getElementById('meas-date');
  if(dateInput) dateInput.value=d;
  const existing=_bodyData?.find(e=>e.date===d)||null;
  renderMeasFields(existing, d);
  const u=getMeasureUnit();
  document.getElementById('meas-unit-cm')?.classList.toggle('active',u==='cm');
  document.getElementById('meas-unit-in')?.classList.toggle('active',u==='in');
  const notesEl=document.getElementById('meas-notes');
  if(notesEl) notesEl.value=existing?.notes||'';
  modal.classList.add('open');
  if(!localStorage.getItem('userHeightCm')&&!localStorage.getItem('heightPromptSkipped')){
    setTimeout(()=>openHeightModal(),300);
  }
}
function closeMeasModal(){ document.getElementById('meas-modal')?.classList.remove('open'); }
function handleMeasModalClick(e){ if(e.target===document.getElementById('meas-modal')) closeMeasModal(); }

function toggleMeasAccordion(label){
  const sec=document.querySelector(`.meas-acc-section[data-group="${label}"]`);
  if(sec) sec.classList.toggle('open');
}

function renderMeasFields(existing, curDate){
  const wrap=document.getElementById('meas-fields-wrap');
  if(!wrap) return;
  const u=getMeasureUnit();
  // Most recent entry before curDate — _bodyData is already sorted ascending by date (from Supabase)
  let prevEntry=null;
  if(_bodyData&&_bodyData.length){
    // Walk backwards to find last entry before curDate in O(n) without copying the array
    for(let i=_bodyData.length-1;i>=0;i--){
      if(!curDate||_bodyData[i].date<curDate){ prevEntry=_bodyData[i]; break; }
    }
  }
  let html='';
  MEAS_GROUPS.forEach((group,gi)=>{
    const filledCount=group.sites.filter(k=>existing?.[k]!=null).length;
    // Open first group by default; also open any group that already has data
    const isOpen = gi===0 || filledCount>0;
    let fieldsHtml='';
    group.sites.forEach(siteKey=>{
      const site=MEASURE_SITES_MAP.get(siteKey);
      const val=existing?.[siteKey];
      const prevVal=prevEntry?.[siteKey];
      const displayVal=val!=null?(u==='in'?cmToIn(val):parseFloat(val).toFixed(1)):'';
      const pholder=prevVal!=null?(u==='in'?cmToIn(prevVal):parseFloat(prevVal).toFixed(1)):'';
      fieldsHtml+=`<div class="meas-field">
        <label style="font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px">${site.label}</label>
        <input type="number" id="mf-${siteKey}" step="0.1" inputmode="decimal"
          value="${displayVal}" placeholder="${pholder||'—'}"
          style="width:100%;background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:14px;font-family:'DM Sans',sans-serif;outline:none"
          onfocus="this.style.borderColor='var(--p3)'" onblur="this.style.borderColor='var(--border)'">
        ${pholder?`<div style="font-size:10px;color:var(--dim);margin-top:2px">Last: ${pholder}${u==='in'?'"':' cm'}</div>`:''}
      </div>`;
    });
    const countLabel = filledCount>0 ? `${filledCount}/${group.sites.length} filled` : `${group.sites.length} sites`;
    html+=`<div class="meas-acc-section${isOpen?' open':''}" data-group="${group.label}">
      <div class="meas-acc-hdr" onclick="toggleMeasAccordion('${group.label}')">
        <div>
          <div class="meas-acc-label">${group.label}</div>
          <div class="meas-acc-count">${countLabel}</div>
        </div>
        <div class="meas-acc-chevron">⌄</div>
      </div>
      <div class="meas-acc-body">
        <div class="meas-grid">${fieldsHtml}</div>
      </div>
    </div>`;
  });
  wrap.innerHTML=html;
}

async function saveMeasurement(){
  const dateInput=document.getElementById('meas-date');
  const date=dateInput?.value||localDateStr();
  const u=getMeasureUnit();
  const payload={date,phase:cPhase};
  let hasAny=false;
  MEASURE_SITES.forEach(site=>{
    const inp=document.getElementById(`mf-${site.key}`);
    if(!inp||inp.value==='') return;
    let val=parseFloat(inp.value);
    if(isNaN(val)) return;
    if(u==='in') val=parseFloat(inToCm(val));
    payload[site.key]=val;
    hasAny=true;
  });
  const notes=document.getElementById('meas-notes')?.value;
  if(notes) payload.notes=notes;
  if(!hasAny){ showToast('Enter at least one measurement','error'); return; }
  setSyncStatus('syncing');
  try {
    const {error}=await db.from(TABLES.MEASUREMENTS).upsert(payload,{onConflict:'date'});
    if(error) throw error;
    setSyncStatus('synced');
    localStorage.setItem('lastMeasurementDate',date);
    closeMeasModal();
    showToast('Measurements saved ✓');
    _bodyLastFetch=0;
    if(_progressTab==='body') renderBodyTab();
  } catch(e){
    setSyncStatus('error');
    showToast('Save failed','error');
    console.error(e);
  }
}

// ── Height modal ──
function openHeightModal(){ document.getElementById('height-modal')?.classList.add('open'); setTimeout(()=>document.getElementById('height-cm-input')?.focus(),300); }
function closeHeightModal(){ document.getElementById('height-modal')?.classList.remove('open'); }
function handleHeightModalClick(e){ if(e.target===document.getElementById('height-modal')) closeHeightModal(); }
function saveHeight(){
  const val=parseFloat(document.getElementById('height-cm-input')?.value);
  if(!val||val<140||val>220){ showToast('Enter a valid height (140–220 cm)','error'); return; }
  localStorage.setItem('userHeightCm',String(val));
  closeHeightModal();
  showToast(`Height saved: ${val}cm ✓`);
  _bodyLastFetch=0;
  if(_progressTab==='body') renderBodyTab();
}
function skipHeight(){
  localStorage.setItem('heightPromptSkipped','1');
  closeHeightModal();
}

function renderStrengthChartData(exName, exLogs){
  const rows = exLogs.filter(r=>r.exercise_name===exName && r.weight_kg>0 && !r.is_mm_set);
  if(!rows.length) return;
  // Max weight per date
  const byDate = {};
  rows.forEach(r=>{ if(!byDate[r.date]||r.weight_kg>byDate[r.date]) byDate[r.date]=r.weight_kg; });
  const dates = Object.keys(byDate).sort();
  const ctx = document.getElementById('strength-chart')?.getContext('2d');
  if(!ctx) return;
  if(strengthChart) strengthChart.destroy();
  strengthChart = new Chart(ctx,{
    type:'line',
    data:{
      labels: dates.map(d=>d.slice(5)),
      datasets:[{label:'Max weight (kg)',data:dates.map(d=>byDate[d]),borderColor:'#fbbf24',backgroundColor:'rgba(251,191,36,.1)',tension:.3,pointRadius:5,pointBackgroundColor:'#fbbf24'}]
    },
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#666',font:{size:11}}}},scales:{x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},y:{ticks:{color:'#555',font:{size:10}},grid:{color:'#222'}}}}
  });
}

function updateStrengthChart(exName){
  if(_exLogs) renderStrengthChartData(exName, _exLogs);
}

// Weigh-in modal
function openWeighModal(){ document.getElementById('weigh-modal').classList.add('open'); setTimeout(()=>document.getElementById('weigh-input').focus(),300); }
function closeWeighModal(){ document.getElementById('weigh-modal').classList.remove('open'); }
function handleWeighModalClick(e){ if(e.target===document.getElementById('weigh-modal')) closeWeighModal(); }

async function saveWeighIn(){
  const w = parseFloat(document.getElementById('weigh-input').value);
  const notes = document.getElementById('weigh-notes').value;
  if(!w||w<40||w>200){ showToast('Enter a valid weight','error'); return; }
  setSyncStatus('syncing');
  try {
    await db.from('body_metrics').upsert({date:todayStr,weight_kg:w,phase:cPhase,notes:notes||null},{onConflict:'date'});
    setSyncStatus('synced');
    closeWeighModal();
    showToast(`${w}kg logged ✓`);
    _progressLastFetch = 0; // invalidate cache — force re-fetch next time Progress tab opens
  } catch(e){ setSyncStatus('error'); showToast('Save failed','error'); }
}

// ============================================================
// DIET SCREEN

function renderStrengthChartData(exName, exLogs){
  const rows = exLogs.filter(r=>r.exercise_name===exName && r.weight_kg>0 && !r.is_mm_set);
  if(!rows.length) return;
  // Max weight per date
  const byDate = {};
  rows.forEach(r=>{ if(!byDate[r.date]||r.weight_kg>byDate[r.date]) byDate[r.date]=r.weight_kg; });
  const dates = Object.keys(byDate).sort();
  const ctx = document.getElementById('strength-chart')?.getContext('2d');
  if(!ctx) return;
  if(strengthChart) strengthChart.destroy();
  strengthChart = new Chart(ctx,{
    type:'line',
    data:{
      labels: dates.map(d=>d.slice(5)),
      datasets:[{label:'Max weight (kg)',data:dates.map(d=>byDate[d]),borderColor:'#fbbf24',backgroundColor:'rgba(251,191,36,.1)',tension:.3,pointRadius:5,pointBackgroundColor:'#fbbf24'}]
    },
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#666',font:{size:11}}}},scales:{x:{ticks:{color:'#555',font:{size:10}},grid:{color:'#1a1a1a'}},y:{ticks:{color:'#555',font:{size:10}},grid:{color:'#222'}}}}
  });
}

function updateStrengthChart(exName){
  if(_exLogs) renderStrengthChartData(exName, _exLogs);
}

// Weigh-in modal
function openWeighModal(){ document.getElementById('weigh-modal').classList.add('open'); setTimeout(()=>document.getElementById('weigh-input').focus(),300); }
function closeWeighModal(){ document.getElementById('weigh-modal').classList.remove('open'); }
function handleWeighModalClick(e){ if(e.target===document.getElementById('weigh-modal')) closeWeighModal(); }

async function saveWeighIn(){
  const w = parseFloat(document.getElementById('weigh-input').value);
  const notes = document.getElementById('weigh-notes').value;
  if(!w||w<40||w>200){ showToast('Enter a valid weight','error'); return; }
  setSyncStatus('syncing');
  try {
    await db.from('body_metrics').upsert({date:todayStr,weight_kg:w,phase:cPhase,notes:notes||null},{onConflict:'date'});
    setSyncStatus('synced');
    closeWeighModal();
    showToast(`${w}kg logged ✓`);
    _progressLastFetch = 0; // invalidate cache — force re-fetch next time Progress tab opens
  } catch(e){ setSyncStatus('error'); showToast('Save failed','error'); }
}

// ============================================================
// DIET SCREEN
// ============================================================
const DP={
  1:{label:'Phase 1',weeks:'Wk 1–4',kcal:'~1,850',pro:'~125g',carb:'~165g',fat:'~53g',def:'~900 kcal',rotis:2,rNote:'2 rotis every night',col:'var(--p1)'},
  2:{label:'Phase 2',weeks:'Wk 5–8',kcal:'~1,920',pro:'~125g',carb:'~185g',fat:'~53g',def:'~830 kcal',rotis:2,rNote:'2 rotis · 3 on Friday',col:'var(--p2)'},
  3:{label:'Phase 3',weeks:'Wk 9–13',kcal:'~2,050',pro:'~125g',carb:'~205g',fat:'~53g',def:'~700 kcal',rotis:2,rNote:'1–3 rotis by day',col:'var(--p3)'},
  4:{label:'Phase 4',weeks:'Wk 14–17',kcal:'~1,950',pro:'~125g',carb:'~180g',fat:'~53g',def:'~800 kcal',rotis:1,rNote:'1–2 rotis nightly',col:'var(--p4)'},
  5:{label:'Phase 5',weeks:'Wk 18+',kcal:'~2,150',pro:'~125g',carb:'~235g',fat:'~53g',def:'+200 surplus',rotis:3,rNote:'3 rotis every night',col:'var(--p5)'},
};
const P3R={MON:2,TUE:3,WED:1,THU:2,FRI:3,SAT:2,SUN:1};
// dPhase now in store
const MEALS=[
  {t:'6:00',ap:'AM',n:'Warm Water',b:'Honey only — no lemon',kcal:20,items:['1 glass warm water','1 tsp honey','NO lemon — rash trigger'],note:'First thing every morning.'},
  {t:'7:30',ap:'AM',n:'Breakfast',b:'Omelette + Oats + 2 scoops whey',kcal:540,items:['Omelette: 1 whole egg + 1 egg white + veggies','Oats: 40g slow roasted + water + 50ml milk','1 scoop whey blended into oats','Sweeten: dates or honey','2 boiled egg whites'],note:'2nd whey scoop in oats — protein to ~125g/day.',isNew:true},
  {t:'10:30',ap:'AM',n:'Mid-Morning',b:'Apple + water',kcal:80,items:['1 medium apple','500ml water alongside'],note:'Water first. Wait 5 min. Then eat.'},
  {t:'1:00',ap:'PM',n:'Power Salad',b:'Legumes + 300g veg + seeds',kcal:380,items:['100g boiled legumes — rotate daily: rajma/chana/chole/moong','300g veg: red+yellow pepper + capsicum + cucumber + carrot + beetroot','EVOO + salt + oregano','1 tsp each: sunflower · flax · pumpkin seeds'],note:'500ml water before eating.'},
  {t:'4:30',ap:'PM',n:'Evening',b:'Water · apple if hungry',kcal:80,items:['500ml water — always first','Wait 15 min','If hungry: apple or cucumber + salt'],warn:'Zero namkeen. Not ever.'},
  {t:'7:00',ap:'PM',n:'Post-Workout Shake',b:'Whey + Creatine 5g',kcal:120,items:['1 scoop whey','5g creatine monohydrate — same shake','250ml water','Within 30–40 min post-workout'],note:'Creatine every day including rest days.',isNew:true},
  {t:'8:30',ap:'PM',n:'Dinner',b:'Bhurji + egg whites + rotis',kcal:450,items:['Egg bhurji: 1 whole egg + 1 egg white + onion + tomato','2 boiled egg whites','ROTIS: count varies by phase'],note:'Only roti count changes across phases.'},
];


function renderDiet(){
  const dp=DP[dPhase];
  const dk=DAYS[cDay];
  const rotisToday=dPhase===3?P3R[dk]:dp.rotis;
  const phNav=[1,2,3,4,5].map(n=>`<button class="ph-btn ${n===dPhase?'active':''}" data-ph="${n}" onclick="switchDietPhase(${n},this)">${DP[n].label}</button>`).join('');
  const rotiIcons=[1,2,3].map(i=>`<span style="font-size:22px;opacity:${i<=rotisToday?1:.15}">🫓</span>`).join('');
  const macros=[
    {v:dp.kcal,k:'KCAL',c:dp.col},{v:dp.pro,k:'PROTEIN',c:'var(--p3)'},{v:dp.carb,k:'CARBS',c:'var(--p2)'},
    {v:dp.fat,k:'FAT',c:'var(--text)'},{v:dp.def,k:'DEFICIT',c:dp.col},{v:'4L',k:'WATER',c:'var(--cyan)'}
  ].map(m=>`<div class="stat-card"><div class="stat-val" style="color:${m.c};font-size:18px">${m.v}</div><div class="stat-key">${m.k}</div></div>`).join('');
  const mealsH=MEALS.map((m,i)=>`
    <div class="workout-card" style="cursor:pointer" onclick="this.classList.toggle('open')">
      <div style="display:flex;align-items:center;gap:10px;padding:12px 14px">
        <div style="min-width:48px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;line-height:1;color:var(--muted)">${m.t}</div>
          <div style="font-size:9px;color:var(--dim)">${m.ap}</div>
        </div>
        <div style="flex:1"><div style="font-weight:600">${m.n}${m.isNew?'<span class="new-badge">UPDATED</span>':''}</div><div style="font-size:12px;color:var(--muted)">${m.b}</div></div>
        <div><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:var(--p1)">${m.kcal}</div><div style="font-size:9px;color:var(--muted);text-align:right">kcal</div></div>
      </div>
      <div class="ex-detail"><div class="ex-detail-inner">
        ${m.items.map(it=>`<div style="font-size:13px;color:#bbb;padding:4px 0;border-bottom:1px solid var(--border)">${it}</div>`).join('')}
        ${i===6?`<div style="font-size:13px;color:#bbb;padding:4px 0;border-bottom:1px solid var(--border)"><strong>Rotis tonight: ${rotisToday}</strong></div>`:''}
        ${m.isNew?`<div style="font-size:11px;color:var(--gold);margin-top:6px;background:rgba(245,158,11,.08);border-left:3px solid var(--gold);padding:5px 9px">✦ UPDATED</div>`:''}
        ${m.note?`<div style="font-size:12px;color:var(--p3);margin-top:6px">✓ ${m.note}</div>`:''}
        ${m.warn?`<div style="font-size:12px;color:var(--p2);margin-top:6px">⚠️ ${m.warn}</div>`:''}
      </div></div>
    </div>`).join('');
  const glassH=Array(8).fill(0).map((_,i)=>`<div class="glass-btn ${i<hydrationGlasses?'filled':''}" onclick="toggleGlass(${i+1})">💧</div>`).join('');
  document.getElementById('diet-content').innerHTML=`
    <div style="padding:16px 16px 12px;background:linear-gradient(180deg,#1a1a1a,var(--bg))">
      <div style="display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;scrollbar-width:none">${phNav}</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px">${dp.label}</div>
      <div style="font-size:13px;color:var(--muted)">${dp.weeks} · ${dp.rNote}</div>
    </div>
    <div style="padding:0 16px 10px"><div class="stat-grid" style="margin-bottom:0">${macros}</div></div>
    <div style="margin:0 16px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between">
      <div><div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted)">ROTIS TONIGHT</div><div style="font-size:11px;color:var(--dim);margin-top:2px">${dp.rNote}</div></div>
      <div style="display:flex;gap:4px">${rotiIcons}</div>
    </div>
    ${mealsH}
    <div class="hydration-row" id="hyd-row">
      <div class="hyd-title">💧 WATER — 4L TARGET</div>
      <div class="hyd-glasses">${glassH}</div>
      <div class="hyd-total"><span>${(hydrationGlasses*.5).toFixed(1)}L</span> of 4L</div>
    </div>
    <div style="padding:0 16px 8px;font-size:12px;color:#666;line-height:2.1">
      🍯 Warm water + honey first — no lemon ever<br>
      💧 500ml water before every main meal<br>
      🚫 Zero namkeen · ⚗️ Creatine daily · ⚖️ Weigh Monday AM only
    </div>
    <div class="spacer"></div>`;
}
function switchDietPhase(n,btn){ dPhase=n; _screenRendered.diet=false; renderDiet(); _screenRendered.diet=true; }

// ============================================================
// MOBILITY SCREEN
// ============================================================
const MOB_ROUTINE=[
  {cat:'HIP MOBILITY',color:'var(--p3)',items:[
    {ic:'🦵',n:'Hip 90/90 Stretch',d:'90s each side',k:'m_h1'},
    {ic:'🦵',n:'Hip Flexor Lunge',d:'45s each side',k:'m_h2'},
    {ic:'🔄',n:'Hip Circles',d:'10× each direction',k:'m_h3'},
    {ic:'🦢',n:'Pigeon Pose',d:'60s each hip',k:'m_h4'},
  ]},
  {cat:'THORACIC SPINE',color:'var(--cyan)',items:[
    {ic:'🔄',n:'Thoracic Rotation',d:'10× each side',k:'m_t1'},
    {ic:'🧱',n:'Cat-Cow',d:'10 reps slow',k:'m_t2'},
    {ic:'🔄',n:'Thread the Needle',d:'10× each side',k:'m_t3'},
  ]},
  {cat:'SHOULDER + WRIST',color:'var(--yellow)',items:[
    {ic:'🔄',n:'Shoulder CARs',d:'5× each direction',k:'m_s1'},
    {ic:'🤲',n:'Wrist Flexor Stretch',d:'30s each',k:'m_s2'},
    {ic:'🤲',n:'Wrist Extensor Stretch',d:'30s each',k:'m_s3'},
    {ic:'🤲',n:'Wrist Circles',d:'10× each direction',k:'m_s4'},
  ]},
  {cat:'ANKLE + CALF',color:'var(--p2)',items:[
    {ic:'🦶',n:'Ankle Circles',d:'10× each direction',k:'m_a1'},
    {ic:'🦶',n:'Calf Stretch (wall)',d:'30s each',k:'m_a2'},
    {ic:'🦶',n:'Ankle Knee-to-Wall',d:'10 reps each',k:'m_a3'},
  ]},
];


function renderMobility(){
  const total=MOB_ROUTINE.reduce((a,c)=>a+c.items.length,0);
  const done=MOB_ROUTINE.reduce((a,c)=>a+c.items.filter(it=>checkCache[it.k]).length,0);
  const pct=Math.round(done/total*100);
  let h=`<div style="padding:4px 0 16px">
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px">DAILY ROUTINE</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:2px;color:var(--cyan)">MORNING MOBILITY</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:12px">10 min · every day · before breakfast</div>
    <div style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;height:4px;background:var(--border);border-radius:4px"><div style="width:${pct}%;height:100%;background:var(--p3);border-radius:4px;transition:width .3s"></div></div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;color:${pct===100?'var(--p3)':'var(--muted)'}">${done}/${total}</div>
    </div>
  </div>`;
  MOB_ROUTINE.forEach(cat=>{
    const catDone=cat.items.filter(it=>checkCache[it.k]).length;
    h+=`<div class="workout-card" style="margin-bottom:10px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:${cat.color}">${cat.cat}</div>
        <div style="font-size:11px;color:var(--muted)">${catDone}/${cat.items.length} done</div></div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:${catDone===cat.items.length?'var(--p3)':'var(--dim)'}">${catDone===cat.items.length?'✓':catDone+'/'+cat.items.length}</div>
      </div>`;
    cat.items.forEach(it=>{
      const done=checkCache[it.k]?'done':'';
      h+=`<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--border);cursor:pointer${done?' opacity:.6':''}" onclick="toggleMob('${it.k}',this)">
        <div style="width:34px;height:34px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">${it.ic}</div>
        <div style="flex:1"><div style="font-weight:600;${done?'text-decoration:line-through;opacity:.5':''}">${it.n}</div><div style="font-size:12px;color:var(--muted)">${it.d}</div></div>
        <div style="width:28px;height:28px;border-radius:8px;border:1.5px solid ${done?'var(--p3)':'var(--dim)'};display:flex;align-items:center;justify-content:center;font-size:14px;background:${done?'var(--p3)':'transparent'};color:${done?'#000':'transparent'};flex-shrink:0">✓</div>
      </div>`;
    });
    h+=`</div>`;
  });
  h+=`<div class="spacer"></div>`;
  document.getElementById('mob-content').innerHTML=h;
}

async function toggleMob(k, el){
  const newVal = !checkCache[k];
  checkCache[k] = newVal;
  // Surgical DOM update — no full re-render
  const cb = el.querySelector('[style*="border-radius:8px"]');
  if(newVal){
    el.style.opacity='.6';
    el.querySelector('[style*="font-weight:600"]').style.cssText='font-weight:600;text-decoration:line-through;opacity:.5';
    if(cb){ cb.style.background='var(--p3)'; cb.style.borderColor='var(--p3)'; cb.style.color='#000'; }
  } else {
    el.style.opacity='1';
    el.querySelector('[style*="text-decoration"]')?.removeAttribute('style');
    el.querySelector('[style*="font-weight:600"]').style.cssText='font-weight:600';
    if(cb){ cb.style.background='transparent'; cb.style.borderColor='var(--dim)'; cb.style.color='transparent'; }
  }
  // Update section progress counter
  const sectionEl = el.closest('.workout-card');
  if(sectionEl){
    const cat = MOB_ROUTINE.find(c=>c.items.some(it=>it.k===k));
    if(cat){
      const catDone = cat.items.filter(it=>checkCache[it.k]).length;
      const total = cat.items.length;
      const countEl = sectionEl.querySelector('[style*="font-size:11px"]');
      if(countEl) countEl.textContent = `${catDone}/${total} done`;
      const scoreEl = sectionEl.querySelector('[style*="font-size:20px"]');
      if(scoreEl){ scoreEl.textContent = catDone===total?'✓':`${catDone}/${total}`; scoreEl.style.color=catDone===total?'var(--p3)':'var(--dim)'; }
    }
  }
  // Update global progress bar
  const total = MOB_ROUTINE.reduce((a,c)=>a+c.items.length,0);
  const done  = MOB_ROUTINE.reduce((a,c)=>a+c.items.filter(it=>checkCache[it.k]).length,0);
  const pct   = Math.round(done/total*100);
  const bar   = document.querySelector('#mob-content [style*="background:var(--p3)"]');
  if(bar) bar.style.width=pct+'%';
  const counter = document.querySelector('#mob-content [style*="font-size:16px"]');
  if(counter){ counter.textContent=`${done}/${total}`; counter.style.color=pct===100?'var(--p3)':'var(--muted)'; }
  setSyncStatus('syncing');
  try {
    await db.from('checklist_logs').upsert({date:todayStr,item_type:'mobility',item_key:k,completed:newVal},{onConflict:'date,item_key'});
    setSyncStatus('synced');
  } catch(e){ setSyncStatus('error'); }
}

// ============================================================
// SCREEN NAV
// ============================================================
// Track which screens have been rendered
// _screenRendered now in store


function renderSettings() {
  const el = document.getElementById('settings-content');
  if (!el) return;

  const state   = getProgrammeState(new Date());
  const startStr = localDateStr(prog.start);
  const curWeek  = state.beforeStart ? '—' : state.week;
  const curPhase = state.beforeStart ? '—' : state.phase;
  const qualWks  = state.qualifyingInPhase || 0;
  const needed   = prog.phaseWeeks[cPhase] || 4;
  const dayName  = state.beforeStart ? '—' : DAYS[state.dowIndex];

  el.innerHTML = `
    <!-- Current programme status -->
    <div class="settings-card">
      <div class="settings-card-title">Current Programme</div>
      <div class="settings-row">
        <div class="settings-row-label">Start Date</div>
        <div class="settings-row-val">${formatDate(prog.start)}</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Today</div>
        <div class="settings-row-val">Week ${curWeek} · ${dayName}</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Phase</div>
        <div class="settings-row-val">Phase ${curPhase} of 5</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Phase Progress</div>
        <div class="settings-row-val">${qualWks} / ${needed} qualifying weeks</div>
      </div>
    </div>

    <!-- Change start date -->
    <div class="settings-card">
      <div class="settings-card-title">Change Start Date</div>
      <div style="padding:0 16px">
        <input
          class="settings-date-input"
          type="date"
          id="settings-date-picker"
          value="${startStr}"
          max="${localDateStr()}"
        >
      </div>
      <div class="settings-hint">
        Moving the start date recalculates your current week, phase, and all
        progress milestones. Your logged workouts and sets are <strong style="color:var(--text)">not deleted</strong>.
      </div>
      <button class="settings-apply-btn" id="settings-apply-btn" onclick="openResetModal()">
        Apply New Start Date
      </button>
    </div>

    <!-- Danger zone -->
    <div style="padding:4px 4px 0;font-size:11px;color:var(--muted);text-align:center;line-height:1.6">
      Programme config is saved to Supabase and persists across devices and sessions.
    </div>
  `;
}

let _pendingResetDate = null;

function openResetModal() {
  const picker = document.getElementById('settings-date-picker');
  if (!picker || !picker.value) { showToast('Pick a date first', 'error'); return; }
  const newDate   = picker.value; // YYYY-MM-DD
  const newParsed = parseLocalDate(newDate);
  const newState = getProgrammeState(new Date(), newParsed); // pass override — no global mutation

  _pendingResetDate = newDate;

  const detail = document.getElementById('reset-modal-detail');
  if (detail) {
    detail.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px">
        <div><strong>New start date</strong> &nbsp;${formatDate(newParsed)}</div>
        <div><strong>Becomes</strong> &nbsp;Week ${newState.beforeStart ? 0 : newState.week}, Phase ${newState.beforeStart ? 1 : newState.phase}</div>
        <div style="margin-top:4px;color:var(--muted)">Logged workouts &amp; sets are untouched.</div>
      </div>
    `;
  }

  document.getElementById('reset-modal').classList.add('open');
}

function closeResetModal() {
  document.getElementById('reset-modal').classList.remove('open');
  _pendingResetDate = null;
}

function confirmReset() {
  if (!_pendingResetDate) return;
  applyNewStartDate(_pendingResetDate);
}

function openInBodyModal() {
  const today = new Date();
  document.getElementById('inbody-modal-date').textContent =
    `${today.getDate()} ${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()} · InBody 770`;
  document.getElementById('inbody-modal').classList.add('open');
}
function closeInBodyModal() {
  document.getElementById('inbody-modal').classList.remove('open');
}
function handleInBodyModalClick(e) {
  if(e.target === document.getElementById('inbody-modal')) closeInBodyModal();
}

// PDF upload → render to image → GPT-4o Vision parse
async function handleInBodyPDF(input) {
  const file = input.files[0];
  if(!file) return;

  // Check for OpenAI API key
  let apiKey = localStorage.getItem('openai_api_key');
  if(!apiKey) {
    apiKey = prompt('Enter your OpenAI API key (stored locally, never sent to our servers):');
    if(!apiKey) return;
    localStorage.setItem('openai_api_key', apiKey.trim());
    apiKey = apiKey.trim();
  }

  const overlay = document.getElementById('parsing-overlay');
  overlay.classList.add('show');
  try {
    // Lazy-load pdf.js if not already loaded
    if(typeof pdfjsLib === 'undefined') {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
        s.onload = res;
        s.onerror = () => rej(new Error('Failed to load PDF library'));
        document.head.appendChild(s);
      });
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    // Read PDF as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Render each page to a canvas → base64 image
    const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
    const images = [];
    for(let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({scale: 2.0}); // high-res for OCR
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({canvasContext: ctx, viewport}).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      images.push(dataUrl.split(',')[1]); // base64 only
    }

    // Send images to OpenAI GPT-4o Vision
    const content = [];
    images.forEach((b64, i) => {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });
    });
    content.push({ type: 'text', text: `This is an InBody 770 body composition report. Extract ALL numeric values and return ONLY a valid JSON object with these exact keys (use null if not found):
weight_kg, body_fat_pct, skeletal_muscle_mass, body_fat_mass, bmi,
total_body_water, intracellular_water, extracellular_water, ecw_ratio,
bmr, visceral_fat_level, inbody_score,
lean_right_arm, lean_left_arm, lean_trunk, lean_right_leg, lean_left_leg
Return ONLY the JSON object, no other text or markdown.` });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1000,
        messages: [{ role: 'user', content }]
      })
    });

    if(!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if(resp.status === 401) {
        localStorage.removeItem('openai_api_key');
        throw new Error('Invalid API key — removed. Try again.');
      }
      throw new Error(err.error?.message || `OpenAI API error ${resp.status}`);
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());

    // Fill form fields
    const fieldMap = {
      'ib-weight':'weight_kg','ib-bf-pct':'body_fat_pct','ib-smm':'skeletal_muscle_mass',
      'ib-fat-mass':'body_fat_mass','ib-bmi':'bmi','ib-tbw':'total_body_water',
      'ib-icw':'intracellular_water','ib-ecw-l':'extracellular_water','ib-ecw':'ecw_ratio',
      'ib-bmr':'bmr','ib-vfl':'visceral_fat_level','ib-score':'inbody_score',
      'ib-ra':'lean_right_arm','ib-la':'lean_left_arm','ib-trunk':'lean_trunk',
      'ib-rl':'lean_right_leg','ib-ll':'lean_left_leg'
    };
    let filled = 0;
    Object.entries(fieldMap).forEach(([id, key]) => {
      if(parsed[key] != null) { document.getElementById(id).value = parsed[key]; filled++; }
    });
    if(filled > 0) {
      showToast(`Extracted ${filled} fields ✓ — please verify`);
    } else {
      showToast('No values found — enter manually', 'error');
    }
  } catch(e) {
    console.error('PDF parse error:', e);
    showToast(e.message || 'Could not read PDF — enter manually', 'error');
  }
  overlay.classList.remove('show');
  input.value = ''; // reset so same file can be re-uploaded
}

async function saveInBody() {
  const get = id => parseFloat(document.getElementById(id).value) || null;
  const getInt = id => parseInt(document.getElementById(id).value) || null;
  const record = {
    date: todayStr,
    weight_kg: get('ib-weight'),
    body_fat_pct: get('ib-bf-pct'),
    skeletal_muscle_mass: get('ib-smm'),
    body_fat_mass: get('ib-fat-mass'),
    bmi: get('ib-bmi'),
    total_body_water: get('ib-tbw'),
    intracellular_water: get('ib-icw'),
    extracellular_water: get('ib-ecw-l'),
    ecw_ratio: get('ib-ecw'),
    bmr: getInt('ib-bmr'),
    visceral_fat_level: getInt('ib-vfl'),
    inbody_score: getInt('ib-score'),
    lean_right_arm: get('ib-ra'),
    lean_left_arm: get('ib-la'),
    lean_trunk: get('ib-trunk'),
    lean_right_leg: get('ib-rl'),
    lean_left_leg: get('ib-ll'),
  };
  if(!record.weight_kg) { showToast('Enter at least weight', 'error'); return; }
  setSyncStatus('syncing');
  try {
    await db.from('inbody_logs').upsert(record, {onConflict:'date'});
    // Also update body_metrics weight
    await db.from('body_metrics').upsert({date:todayStr, weight_kg:record.weight_kg, phase:cPhase}, {onConflict:'date'});
    // Store last InBody date for notification scheduling
    localStorage.setItem('lastInBodyDate', todayStr);
    _progressLastFetch = 0; // invalidate progress cache
    setSyncStatus('synced');
    showToast('InBody saved ✓');
    closeInBodyModal();
  } catch(e) {
    setSyncStatus('error');
    showToast('Save failed', 'error');
    console.error(e);
  }
}

// ============================================================
// NOTIFICATION SYSTEM
// ============================================================

